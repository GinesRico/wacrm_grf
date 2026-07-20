import { NextResponse } from "next/server";

import { getCurrentDbAccount, requireDbRole } from "@/lib/auth/current-account";
import { toErrorResponse } from "@/lib/auth/errors";
import { getInboxConversationById } from "@/lib/inbox/conversations";
import {
  deleteInboxConversation,
  InboxWorkflowError,
  mutateInboxConversation,
  type InboxAction,
} from "@/lib/inbox/tickets";

const ACTIONS = new Set<InboxAction>([
  "accept",
  "resolve",
  "return_to_pending",
  "reopen",
  "assign",
]);

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getCurrentDbAccount();
    const { id } = await context.params;
    const conversation = await getInboxConversationById(ctx.accountId, id);
    if (!conversation) {
      return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    }
    return NextResponse.json({ conversation });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireDbRole("agent");
    const { id } = await context.params;
    const body = await request.json().catch(() => ({}));
    const action = body?.action;

    if (!ACTIONS.has(action)) {
      return NextResponse.json({ error: "Invalid action." }, { status: 400 });
    }

    const conversation = await mutateInboxConversation(null, {
      accountId: ctx.accountId,
      userId: ctx.userId,
      conversationId: id,
      action,
      assignedAgentId:
        typeof body?.assigned_agent_id === "string"
          ? body.assigned_agent_id
          : body?.assigned_agent_id === null
            ? null
            : undefined,
      whatsappConfigId:
        typeof body?.whatsapp_config_id === "string"
          ? body.whatsapp_config_id
          : body?.whatsapp_config_id === null
            ? null
            : undefined,
      departmentId:
        typeof body?.department_id === "string"
          ? body.department_id
          : body?.department_id === null
            ? null
            : undefined,
    });

    return NextResponse.json({ conversation });
  } catch (err) {
    if (err instanceof InboxWorkflowError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireDbRole("agent");
    const { id } = await context.params;

    await deleteInboxConversation(null, {
      accountId: ctx.accountId,
      conversationId: id,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    if (err instanceof InboxWorkflowError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return toErrorResponse(err);
  }
}
