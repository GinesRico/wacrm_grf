import { sendTextMessage, sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { eq, and } from 'drizzle-orm';

import { db } from '@/db/client';
import {
  contacts,
  conversations,
  messages,
  messageTemplates,
} from '@/db/schema';
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive';
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
} from '@/lib/flows/meta-send';
import { decrypt } from '@/lib/whatsapp/encryption';
import { getWhatsAppConfigForConversation } from '@/lib/whatsapp/config';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import { serializeMessageTemplate } from '@/lib/whatsapp/template-serializer';
import type { MessageTemplate } from '@/types';

// ------------------------------------------------------------
// Automation-side Meta sender.
//
// Mirrors the logic in src/app/api/whatsapp/send/route.ts but uses
// the service-role client (engine has no cookies) and accepts the
// user / conversation / contact identifiers the engine already has
// on hand. Kept here (rather than refactoring the user-facing send
// route) to avoid risk to the working manual-send path — they can
// converge in a later refactor.
// ------------------------------------------------------------

interface SendTextArgs {
  /** Account-level tenancy key. Drives contact + whatsapp_config
   *  lookups so an automation authored by user A still sends through
   *  the WhatsApp number user B saved on the same account. */
  accountId: string;
  /** Original author of the automation/flow — used for INSERT audit
   *  columns (messages.sender_id-ish) and for resolving the agent's
   *  identity in logs. Not consulted for tenancy. */
  userId: string;
  conversationId: string;
  contactId: string;
  text: string;
}

interface SendTemplateArgs {
  accountId: string;
  userId: string;
  conversationId: string;
  contactId: string;
  templateName: string;
  language?: string;
  params?: string[];
  messageParams?: SendTimeParams;
}

export async function engineSendText(
  args: SendTextArgs
): Promise<{ whatsapp_message_id: string }> {
  return sendViaMeta({ ...args, kind: 'text' });
}

export async function engineSendTemplate(
  args: SendTemplateArgs
): Promise<{ whatsapp_message_id: string }> {
  return sendViaMeta({ ...args, kind: 'template' });
}

interface SendInteractiveArgs {
  accountId: string;
  userId: string;
  conversationId: string;
  contactId: string;
  payload: InteractiveMessagePayload;
}

/**
 * Send an interactive (reply-buttons or list) message from the
 * automation engine.
 *
 * Delegates to the Flows interactive senders
 * (`engineSendInteractiveButtons` / `engineSendInteractiveList`), which
 * already own the account-scoped lookup, phone-variant retry, and the
 * `messages` insert with `interactive_payload` + `sender_type='bot'`.
 * Both engines want identical behaviour here, so there's one
 * implementation rather than a second hand-rolled copy that could drift.
 */
export async function engineSendInteractive(
  args: SendInteractiveArgs
): Promise<{ whatsapp_message_id: string }> {
  const { payload, accountId, userId, conversationId, contactId } = args;
  const common = { accountId, userId, conversationId, contactId };
  if (payload.kind === 'buttons') {
    return engineSendInteractiveButtons({
      ...common,
      bodyText: payload.body,
      headerText: payload.header,
      footerText: payload.footer,
      buttons: payload.buttons,
    });
  }
  if (payload.kind !== 'list') {
    throw new Error(
      'CTA URL interactive messages are not supported by automations yet.'
    );
  }
  return engineSendInteractiveList({
    ...common,
    bodyText: payload.body,
    buttonLabel: payload.button_label,
    headerText: payload.header,
    footerText: payload.footer,
    sections: payload.sections,
  });
}

type SendInput =
  (SendTextArgs & { kind: 'text' }) | (SendTemplateArgs & { kind: 'template' });

async function sendViaMeta(
  input: SendInput
): Promise<{ whatsapp_message_id: string }> {
  // Scope the contact + config lookups by account_id, not user_id.
  // The engine uses the service-role client (bypassing RLS); without
  // this filter, an authenticated user could fire their own
  // automations against another tenant's contact UUID and send via
  // their own WhatsApp config to that contact's phone. The 017
  // migration moved both tables to account-scoped tenancy, so the
  // check is the same defense-in-depth as before, just keyed on the
  // new tenancy column.
  const [contact] = await db
    .select({ id: contacts.id, phone: contacts.phone })
    .from(contacts)
    .where(
      and(
        eq(contacts.id, input.contactId),
        eq(contacts.accountId, input.accountId)
      )
    )
    .limit(1);
  if (!contact?.phone) {
    throw new Error('contact not found for this account');
  }

  const sanitized = sanitizePhoneForMeta(contact.phone);
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`);
  }

  const config = await getWhatsAppConfigForConversation(
    db,
    input.accountId,
    input.conversationId
  );
  if (!config) {
    throw new Error('WhatsApp not configured for this account');
  }

  const accessToken = decrypt(config.access_token);
  let templateRow: MessageTemplate | null = null;
  if (input.kind === 'template') {
    const [data] = await db
      .select()
      .from(messageTemplates)
      .where(
        and(
          eq(messageTemplates.accountId, input.accountId),
          eq(messageTemplates.name, input.templateName),
          eq(messageTemplates.language, input.language || 'en_US')
        )
      )
      .limit(1);
    const serialized = data ? serializeMessageTemplate(data) : null;
    if (serialized && !isMessageTemplate(serialized)) {
      throw new Error(
        'Template row is malformed locally - sync templates from Meta'
      );
    }
    templateRow = serialized;
  }

  const attempt = async (phone: string): Promise<string> => {
    if (input.kind === 'template') {
      const r = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: phone,
        templateName: input.templateName,
        language: input.language,
        params: input.params,
        template: templateRow ?? undefined,
        messageParams: input.messageParams,
      });
      return r.messageId;
    }
    const r = await sendTextMessage({
      phoneNumberId: config.phone_number_id,
      accessToken,
      to: phone,
      text: input.text,
    });
    return r.messageId;
  };

  // Same phone-variant retry as /api/whatsapp/send — Meta sandbox and
  // numbers registered with/without a trunk 0 both require this to
  // reliably land a message.
  const variants = phoneVariants(sanitized);
  let workingPhone = sanitized;
  let waMessageId = '';
  let lastError: unknown = null;
  for (const v of variants) {
    try {
      waMessageId = await attempt(v);
      workingPhone = v;
      lastError = null;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isRecipientNotAllowedError(msg)) throw err;
      lastError = err;
    }
  }
  if (lastError) throw lastError;

  if (workingPhone !== sanitized) {
    await db
      .update(contacts)
      .set({ phone: workingPhone })
      .where(eq(contacts.id, contact.id));
  }

  // Persist the sent message so it appears in the inbox with a real
  // Meta message id. sender_type='bot' distinguishes automation sends
  // from manual agent sends.
  const content_type = input.kind === 'template' ? 'template' : 'text';
  const content_text = input.kind === 'text' ? input.text : null;
  const template_name = input.kind === 'template' ? input.templateName : null;

  try {
    await db.insert(messages).values({
      conversationId: input.conversationId,
      senderType: 'bot',
      contentType: content_type,
      contentText: content_text,
      templateName: template_name,
      messageId: waMessageId,
      status: 'sent',
      sentAt: new Date(),
    });
  } catch (msgErr) {
    // Meta already has the message; record the DB error but don't pretend
    // the send failed. The engine wraps this in a log line.
    throw new Error(
      `sent to Meta but DB insert failed: ${msgErr instanceof Error ? msgErr.message : String(msgErr)}`
    );
  }

  await db
    .update(conversations)
    .set({
      lastMessageText:
        input.kind === 'template'
          ? `[template:${input.templateName}]`
          : input.text,
      lastMessageAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, input.conversationId));

  return { whatsapp_message_id: waMessageId };
}
