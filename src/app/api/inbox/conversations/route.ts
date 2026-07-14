import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import {
  deleteInboxConversation,
  InboxWorkflowError,
  listInboxConversations,
  mutateInboxConversation,
  parseInboxSearchParams,
  type InboxAction,
} from "@/lib/inbox/tickets";

const ACTIONS = new Set<InboxAction>([
  "accept",
  "resolve",
  "return_to_pending",
  "reopen",
  "assign",
]);

export async function GET(request: Request) {
  try {
    const ctx = await requireRole("viewer");
    const url = new URL(request.url);
    const parsed = parseInboxSearchParams(url.searchParams);

    const result = await listInboxConversations(supabaseAdmin(), {
      accountId: ctx.accountId,
      userId: ctx.userId,
      ...parsed,
    });

    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole("agent");
    const body = await request.json().catch(() => ({}));
    const action = body?.action;
    const conversationId = body?.conversation_id;

    if (typeof conversationId !== "string" || conversationId.length === 0) {
      return NextResponse.json(
        { error: "conversation_id is required." },
        { status: 400 },
      );
    }

    if (!ACTIONS.has(action)) {
      return NextResponse.json({ error: "Invalid action." }, { status: 400 });
    }

    const conversation = await mutateInboxConversation(supabaseAdmin(), {
      accountId: ctx.accountId,
      userId: ctx.userId,
      conversationId,
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

export async function DELETE(request: Request) {
  try {
    const ctx = await requireRole("agent");
    const url = new URL(request.url);
    const conversationId = url.searchParams.get("conversation_id");

    if (!conversationId) {
      return NextResponse.json(
        { error: "conversation_id is required." },
        { status: 400 },
      );
    }

    await deleteInboxConversation(supabaseAdmin(), {
      accountId: ctx.accountId,
      conversationId,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    if (err instanceof InboxWorkflowError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return toErrorResponse(err);
  }
}
