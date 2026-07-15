import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import {
  sendMessageToConversation,
  validateSendMessageParams,
  SendMessageError,
} from '@/lib/whatsapp/send-message'

// The dashboard's outbound-send endpoint. It owns auth, per-user rate
// limiting, and the two ways the UI targets a thread — an existing
// `conversation_id` (inbox) or a `contact_id` (Contact detail →
// find-or-create the conversation). The actual Meta plumbing (validate
// → send → persist → pause flows) lives in the shared
// `sendMessageToConversation` core, which the public `/api/v1/messages`
// endpoint reuses. This route is a thin adapter: resolve the
// conversation, delegate, then map `SendMessageError` back onto the
// dashboard's internal `{ error }` shape.
export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Per-user rate limit. Bucket key is scoped to this route so
    // `/broadcast` has an independent budget.
    const limit = checkRateLimit(`send:${user.id}`, RATE_LIMITS.send)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    // Resolve the caller's account_id. Every downstream lookup
    // (conversation, whatsapp_config, message_templates) is account-
    // scoped post-multi-user, so the previous `user_id` filters
    // returned nothing for teammates who didn't author the row.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const body = await request.json()
    const {
      // `conversation_id` targets an existing thread (inbox). `contact_id`
      // lets a caller initiate from a contact that may have no conversation
      // yet (Contact detail → Send template) — we find-or-create one below.
      conversation_id: conversationIdInput,
      contact_id,
      message_type,
      content_text,
      media_url,
      filename,
      template_name,
      template_language,
      template_params,
      template_message_params,
      interactive_payload,
      reply_to_message_id,
      is_forwarded,
      forwarded_from_message_id,
      whatsapp_config_id,
    } = body

    if ((!conversationIdInput && !contact_id) || !message_type) {
      return NextResponse.json(
        {
          error:
            'Either conversation_id or contact_id, plus message_type, are required',
        },
        { status: 400 }
      )
    }

    // Validate the message shape up front — before the contact_id path
    // finds-or-creates a conversation — so an invalid payload 400s
    // without leaving an orphan empty conversation behind.
    try {
      validateSendMessageParams({
        messageType: message_type,
        contentText: content_text,
        mediaUrl: media_url,
        templateName: template_name,
        interactivePayload: interactive_payload,
      })
    } catch (err) {
      if (err instanceof SendMessageError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      throw err
    }

    // Resolve the target conversation. With `conversation_id` we load the
    // existing thread; with `contact_id` we find-or-create one for the
    // contact so a business-initiated template send (Contact detail view)
    // reuses the shared send core below.
    let conversationId: string | null = null

    if (conversationIdInput) {
      const { data, error: convError } = await supabase
        .from('conversations')
        .select('id, status')
        .eq('id', conversationIdInput)
        .eq('account_id', accountId)
        .single()

      if (convError || !data) {
        return NextResponse.json(
          { error: 'Conversation not found' },
          { status: 404 }
        )
      }
      if (data.status && data.status !== 'open') {
        return NextResponse.json(
          { error: 'Accept or reopen this conversation before sending messages.' },
          { status: 409 },
        )
      }
      conversationId = data.id
    } else {
      // contact_id path: verify the contact is in this account first so a
      // caller can't open a conversation against someone else's contact.
      const { data: contactRow, error: contactErr } = await supabase
        .from('contacts')
        .select('id')
        .eq('id', contact_id)
        .eq('account_id', accountId)
        .maybeSingle()

      if (contactErr || !contactRow) {
        return NextResponse.json(
          { error: 'Contact not found' },
          { status: 404 }
        )
      }

      const resolved = await findOrCreateConversation(
        supabase,
        accountId,
        user.id,
        contact_id,
        typeof whatsapp_config_id === 'string' ? whatsapp_config_id : null,
      )
      if (resolved === 'not_open') {
        return NextResponse.json(
          { error: 'Accept or reopen this conversation before sending messages.' },
          { status: 409 },
        )
      }
      if (!resolved) {
        return NextResponse.json(
          { error: 'Failed to open a conversation for this contact' },
          { status: 500 }
        )
      }
      conversationId = resolved
    }

    if (!conversationId) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      )
    }

    if (message_type !== 'template') {
      const sessionOpen = await isConversationWithinCustomerSession(
        supabase,
        conversationId,
      )
      if (!sessionOpen) {
        return NextResponse.json(
          { error: 'The 24-hour WhatsApp session has expired. Send an approved template to re-engage this contact.' },
          { status: 409 },
        )
      }
    }

    // Delegate to the shared send core (validates, sends to Meta with
    // phone-variant retry, persists, pauses active flow runs). Its
    // `SendMessageError` carries a machine code + HTTP status; the
    // dashboard maps it to the internal `{ error }` shape.
    try {
      const result = await sendMessageToConversation(supabase, accountId, {
        conversationId,
        messageType: message_type,
        contentText: content_text,
        mediaUrl: media_url,
        filename,
        templateName: template_name,
        templateLanguage: template_language,
        templateParams: template_params,
        templateMessageParams: template_message_params,
        interactivePayload: interactive_payload,
        replyToMessageId: reply_to_message_id,
        isForwarded: Boolean(is_forwarded),
        forwardedFromMessageId:
          typeof forwarded_from_message_id === 'string'
            ? forwarded_from_message_id
            : null,
      })

      return NextResponse.json({
        success: true,
        message_id: result.messageId,
        whatsapp_message_id: result.whatsappMessageId,
      })
    } catch (err) {
      if (err instanceof SendMessageError) {
        return NextResponse.json(
          { error: err.message },
          { status: err.status }
        )
      }
      throw err
    }
  } catch (error) {
    console.error('Error in WhatsApp send POST:', error)
    return NextResponse.json(
      { error: 'Failed to send message' },
      { status: 500 }
    )
  }
}

type SendSupabase = Awaited<ReturnType<typeof createClient>>

/**
 * Return the contact's conversation id in this account, creating one if
 * it doesn't exist yet. Mirrors the webhook's find-or-create so an
 * inbound-then-outbound (or outbound-first) sequence converges on a single
 * thread per contact. Runs under the caller's RLS — the conversations_insert
 * policy requires account agent membership, which the caller already is.
 */
async function findOrCreateConversation(
  supabase: SendSupabase,
  accountId: string,
  userId: string,
  contactId: string,
  whatsappConfigId: string | null,
): Promise<string | 'not_open' | null> {
  let resolvedConfigId = whatsappConfigId
  if (resolvedConfigId) {
    const { data: line } = await supabase
      .from('whatsapp_config')
      .select('id')
      .eq('id', resolvedConfigId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!line) return null
  } else {
    const { data: line } = await supabase
      .from('whatsapp_config')
      .select('id')
      .eq('account_id', accountId)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    resolvedConfigId = line?.id ?? null
  }

  let query = supabase
    .from('conversations')
    .select('id, status')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)

  query = resolvedConfigId
    ? query.eq('whatsapp_config_id', resolvedConfigId)
    : query.is('whatsapp_config_id', null)

  const { data: existing } = await query.maybeSingle()

  if (existing) {
    if (existing.status && existing.status !== 'open') return 'not_open'
    return existing.id
  }

  const { data: created, error } = await supabase
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: userId,
      contact_id: contactId,
      whatsapp_config_id: resolvedConfigId,
      status: 'open',
      assigned_agent_id: userId,
    })
    .select('id')
    .single()

  if (error) {
    console.error('Error creating conversation for contact send:', error.message)
    return null
  }

  return created.id
}

async function isConversationWithinCustomerSession(
  supabase: SendSupabase,
  conversationId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('messages')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error || !data?.created_at) return false

  const lastCustomerAt = new Date(data.created_at).getTime()
  if (!Number.isFinite(lastCustomerAt)) return false

  return Date.now() - lastCustomerAt < 24 * 60 * 60 * 1000
}
