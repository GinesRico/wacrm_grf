import { NextResponse } from 'next/server';

import { requireDbRole } from '@/lib/auth/current-account';
import { toErrorResponse } from '@/lib/auth/errors';
import {
  applyEmailRuleToMessage,
  applyEmailRulesForUser,
  createEmailRule,
  deleteEmailRuleForUser,
  listEmailRulesForUser,
  serializeEmailMessage,
  updateEmailRuleForUser,
} from '@/lib/email/service';

function serializeRule(row: {
  id: string;
  mailboxId: string | null;
  targetFolderId: string | null;
  name: string;
  field: string;
  operator: string;
  value: string;
  enabled: boolean;
  action: string;
  actionValue: string | null;
}) {
  return {
    id: row.id,
    mailbox_id: row.mailboxId,
    target_folder_id: row.targetFolderId,
    name: row.name,
    field: row.field,
    operator: row.operator,
    value: row.value,
    enabled: row.enabled,
    action: row.action,
    action_value: row.actionValue,
  };
}

export async function GET(request: Request) {
  try {
    const ctx = await requireDbRole('viewer');
    const url = new URL(request.url);
    const result = await listEmailRulesForUser({
      accountId: ctx.accountId,
      userId: ctx.userId,
      role: ctx.role,
      mailboxId: url.searchParams.get('mailbox_id'),
    });
    return NextResponse.json({
      ...result,
      rules: result.rules.map(serializeRule),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireDbRole('agent');
    const body = await request.json().catch(() => ({}));
    if (body?.action === 'apply') {
      if (typeof body.message_id !== 'string' || typeof body.rule_id !== 'string') {
        return NextResponse.json(
          { error: 'message_id and rule_id are required.' },
          { status: 400 },
        );
      }
      const message = await applyEmailRuleToMessage({
        accountId: ctx.accountId,
        userId: ctx.userId,
        role: ctx.role,
        messageId: body.message_id,
        ruleId: body.rule_id,
      });
      return NextResponse.json({ message: serializeEmailMessage(message) });
    }
    if (body?.action === 'apply_all') {
      if (typeof body.mailbox_id !== 'string') {
        return NextResponse.json(
          { error: 'mailbox_id is required.' },
          { status: 400 },
        );
      }
      const result = await applyEmailRulesForUser({
        accountId: ctx.accountId,
        userId: ctx.userId,
        role: ctx.role,
        mailboxId: body.mailbox_id,
        folderId: typeof body.folder_id === 'string' ? body.folder_id : null,
      });
      return NextResponse.json(result);
    }

    if (
      typeof body?.mailbox_id !== 'string' ||
      (typeof body?.target_folder_id !== 'string' && body?.target_folder_id !== null)
    ) {
      return NextResponse.json(
        { error: 'mailbox_id and target_folder_id are required.' },
        { status: 400 },
      );
    }
    const rule = await createEmailRule({
      accountId: ctx.accountId,
      userId: ctx.userId,
      role: ctx.role,
      mailboxId: body.mailbox_id,
      targetFolderId: body.target_folder_id,
      name: String(body.name ?? ''),
      field: String(body.field ?? 'from'),
      operator: String(body.operator ?? 'contains'),
      value: String(body.value ?? ''),
      action: String(body.action ?? 'move_to'),
      actionValue: typeof body.action_value === 'string' ? body.action_value : null,
    });
    return NextResponse.json({ rule: serializeRule(rule) });
  } catch (err) {
    if (err instanceof Error) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireDbRole('agent');
    const body = await request.json().catch(() => ({}));
    if (typeof body?.rule_id !== 'string' || (typeof body?.target_folder_id !== 'string' && body?.target_folder_id !== null)) {
      return NextResponse.json(
        { error: 'rule_id and target_folder_id are required.' },
        { status: 400 },
      );
    }
    const rule = await updateEmailRuleForUser({
      accountId: ctx.accountId,
      userId: ctx.userId,
      role: ctx.role,
      ruleId: body.rule_id,
      targetFolderId: body.target_folder_id,
      name: String(body.name ?? ''),
      field: String(body.field ?? 'from'),
      operator: String(body.operator ?? 'contains'),
      value: String(body.value ?? ''),
      enabled: typeof body.enabled === 'boolean' ? body.enabled : true,
      action: String(body.action ?? 'move_to'),
      actionValue: typeof body.action_value === 'string' ? body.action_value : null,
    });
    return NextResponse.json({ rule: serializeRule(rule) });
  } catch (err) {
    if (err instanceof Error) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireDbRole('agent');
    const url = new URL(request.url);
    const ruleId = url.searchParams.get('rule_id');
    if (!ruleId) {
      return NextResponse.json({ error: 'rule_id is required.' }, { status: 400 });
    }
    const rule = await deleteEmailRuleForUser({
      accountId: ctx.accountId,
      userId: ctx.userId,
      role: ctx.role,
      ruleId,
    });
    return NextResponse.json({ rule: rule ? serializeRule(rule) : null });
  } catch (err) {
    if (err instanceof Error) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return toErrorResponse(err);
  }
}
