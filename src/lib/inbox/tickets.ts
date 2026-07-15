import type { SupabaseClient } from "@supabase/supabase-js";

import type { Conversation, ConversationStatus } from "@/types";
import {
  CONVERSATION_SELECT,
  hydrateAssignedAgents,
  normalizeConversation,
  normalizeConversations,
} from "@/lib/inbox/conversations";

export type InboxTab = "inbox" | "resolved" | "search";
export type InboxSubtab = "open" | "pending";
export type InboxScope = "mine" | "all";
export type InboxAction =
  | "accept"
  | "resolve"
  | "return_to_pending"
  | "reopen"
  | "assign";

export interface InboxCounts {
  inboxOpen: number;
  inboxPending: number;
  resolved: number;
}

export interface ListInboxParams {
  accountId: string;
  userId: string;
  tab: InboxTab;
  subtab: InboxSubtab;
  scope: InboxScope;
  search: string;
}

export class InboxWorkflowError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "InboxWorkflowError";
  }
}

interface ConversationState {
  status: ConversationStatus;
  assigned_agent_id?: string | null;
}

type ConversationMutationPatch = {
  status?: ConversationStatus;
  assigned_agent_id?: string | null;
  whatsapp_config_id?: string | null;
  department_id?: string | null;
};

function systemMessageForAction(action: InboxAction, agentName: string) {
  switch (action) {
    case "accept":
      return `Chat aceptado por ${agentName}`;
    case "resolve":
      return `Chat resuelto por ${agentName}`;
    case "return_to_pending":
      return `Chat devuelto a cola por ${agentName}`;
    case "reopen":
      return `Chat reabierto por ${agentName}`;
    case "assign":
      return null;
  }
}

async function resolveAgentName(
  db: SupabaseClient,
  accountId: string,
  userId: string,
) {
  const { data, error } = await db
    .from("profiles")
    .select("full_name, email")
    .eq("account_id", accountId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  const row = data as { full_name?: string | null; email?: string | null } | null;
  return row?.full_name?.trim() || row?.email?.trim() || "un usuario";
}

export function getConversationMutationPatch(
  action: InboxAction,
  current: ConversationState,
  userId: string,
  assignedAgentId?: string | null,
  whatsappConfigId?: string | null,
  departmentId?: string | null,
): ConversationMutationPatch {
  switch (action) {
    case "accept":
      if (current.status !== "pending") {
        throw new InboxWorkflowError("Only pending conversations can be accepted.", 409);
      }
      if (current.assigned_agent_id && current.assigned_agent_id !== userId) {
        throw new InboxWorkflowError("This chat is already assigned to another agent.", 409);
      }
      return { status: "open", assigned_agent_id: userId };
    case "resolve":
      if (current.status !== "open" && current.status !== "pending") {
        throw new InboxWorkflowError("Only open or pending conversations can be resolved.", 409);
      }
      return { status: "closed", assigned_agent_id: userId };
    case "return_to_pending":
      if (current.status !== "open") {
        throw new InboxWorkflowError("Only open conversations can be returned to pending.", 409);
      }
      return { status: "pending", assigned_agent_id: null };
    case "reopen":
      if (current.status !== "closed") {
        throw new InboxWorkflowError("Only closed conversations can be reopened.", 409);
      }
      return { status: "open", assigned_agent_id: userId };
    case "assign":
      return {
        ...(departmentId !== undefined && departmentId !== null && assignedAgentId === null
          ? { status: "pending" as const }
          : {}),
        ...(assignedAgentId !== undefined
          ? { assigned_agent_id: assignedAgentId }
          : {}),
        ...(whatsappConfigId !== undefined
          ? { whatsapp_config_id: whatsappConfigId }
          : {}),
        ...(departmentId !== undefined ? { department_id: departmentId } : {}),
      };
  }
}

function normalizeTab(value: string | null): InboxTab {
  return value === "resolved" || value === "search" ? value : "inbox";
}

function normalizeSubtab(value: string | null): InboxSubtab {
  return value === "pending" ? "pending" : "open";
}

function normalizeScope(value: string | null): InboxScope {
  return value === "all" ? "all" : "mine";
}

export function parseInboxSearchParams(searchParams: URLSearchParams) {
  return {
    tab: normalizeTab(searchParams.get("tab")),
    subtab: normalizeSubtab(searchParams.get("subtab")),
    scope: normalizeScope(searchParams.get("scope")),
    search: searchParams.get("search")?.trim() ?? "",
  };
}

function matchesScope(
  conversation: Conversation,
  scope: InboxScope,
  userId: string,
): boolean {
  if (scope === "all") return true;
  if (conversation.status === "pending") return true;
  return conversation.assigned_agent_id === userId;
}

function matchesTab(
  conversation: Conversation,
  tab: InboxTab,
  subtab: InboxSubtab,
): boolean {
  if (tab === "resolved") return conversation.status === "closed";
  if (tab === "search") return true;
  return conversation.status === subtab;
}

function matchesTextSearch(
  conversation: Conversation,
  search: string,
  matchingMessageConversationIds: Set<string>,
): boolean {
  if (!search) return true;
  if (matchingMessageConversationIds.has(conversation.id)) return true;

  const q = search.toLowerCase();
  const contact = conversation.contact;
  return (
    (contact?.name ?? "").toLowerCase().includes(q) ||
    (contact?.phone ?? "").toLowerCase().includes(q) ||
    (conversation.last_message_text ?? "").toLowerCase().includes(q)
  );
}

export async function listInboxConversations(
  db: SupabaseClient,
  params: ListInboxParams,
) {
  const [
    { data: allDepartmentRows, error: allDepartmentsError },
    { data: departmentRows, error: departmentError },
  ] = await Promise.all([
    db
      .from("departments")
      .select("id")
      .eq("account_id", params.accountId),
    db
      .from("department_members")
      .select("department_id")
      .eq("account_id", params.accountId)
      .eq("user_id", params.userId),
  ]);

  if (allDepartmentsError) throw allDepartmentsError;
  if (departmentError) throw departmentError;

  const departmentIds = ((departmentRows ?? []) as { department_id: string }[])
    .map((row) => row.department_id)
    .filter(Boolean);

  const { data, error } = await db
    .from("conversations")
    .select(CONVERSATION_SELECT)
    .eq("account_id", params.accountId)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .order("updated_at", { ascending: false });

  if (error) throw error;

  const conversations = await hydrateAssignedAgents(
    db,
    params.accountId,
    normalizeConversations((data ?? []) as never[]),
  );
  const hasDepartmentQueues = ((allDepartmentRows ?? []) as { id: string }[]).length > 0;
  const visibleByDepartment =
    !hasDepartmentQueues
      ? conversations
      : conversations.filter(
          (conversation) =>
            conversation.department_id != null &&
            departmentIds.includes(conversation.department_id),
        );

  const effectiveScope =
    params.tab === "inbox" ? params.scope : ("all" as InboxScope);
  const scoped = visibleByDepartment.filter((c) =>
    matchesScope(c, effectiveScope, params.userId),
  );

  const counts: InboxCounts = {
    inboxOpen: scoped.filter((c) => c.status === "open").length,
    inboxPending: scoped.filter((c) => c.status === "pending").length,
    resolved: scoped.filter((c) => c.status === "closed").length,
  };

  let matchingMessageConversationIds = new Set<string>();
  if (params.search) {
    const { data: messageRows, error: messageError } = await db
      .from("messages")
      .select("conversation_id")
      .ilike("content_text", `%${params.search}%`)
      .limit(500);
    if (messageError) throw messageError;
    matchingMessageConversationIds = new Set(
      (messageRows ?? [])
        .map((row) => (row as { conversation_id?: string }).conversation_id)
        .filter((id): id is string => Boolean(id)),
    );
  }

  const rows = scoped.filter(
    (conversation) =>
      matchesTab(conversation, params.tab, params.subtab) &&
      matchesTextSearch(
        conversation,
        params.search,
        matchingMessageConversationIds,
      ),
  );

  return { conversations: rows, counts };
}

async function assertAssignableAgent(
  db: SupabaseClient,
  accountId: string,
  assignedAgentId: string | null | undefined,
) {
  if (!assignedAgentId) return;
  const { data, error } = await db
    .from("profiles")
    .select("user_id")
    .eq("account_id", accountId)
    .eq("user_id", assignedAgentId)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw new InboxWorkflowError("Assigned agent is not a member of this account.", 400);
  }
}

async function assertAssignableLine(
  db: SupabaseClient,
  accountId: string,
  whatsappConfigId: string | null | undefined,
) {
  if (whatsappConfigId === undefined || whatsappConfigId === null) return;

  const { data, error } = await db
    .from("whatsapp_config")
    .select("id")
    .eq("account_id", accountId)
    .eq("id", whatsappConfigId)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw new InboxWorkflowError("WhatsApp line is not part of this account.", 400);
  }
}

async function assertAssignableDepartment(
  db: SupabaseClient,
  accountId: string,
  departmentId: string | null | undefined,
) {
  if (departmentId === undefined || departmentId === null) return;

  const { data, error } = await db
    .from("departments")
    .select("id")
    .eq("account_id", accountId)
    .eq("id", departmentId)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw new InboxWorkflowError("Department is not part of this account.", 400);
  }
}

export async function mutateInboxConversation(
  db: SupabaseClient,
  params: {
    accountId: string;
    userId: string;
    conversationId: string;
    action: InboxAction;
    assignedAgentId?: string | null;
    whatsappConfigId?: string | null;
    departmentId?: string | null;
  },
) {
  const { data: current, error: findError } = await db
    .from("conversations")
    .select("id, status, assigned_agent_id")
    .eq("id", params.conversationId)
    .eq("account_id", params.accountId)
    .maybeSingle();

  if (findError) throw findError;
  if (!current) throw new InboxWorkflowError("Conversation not found.", 404);

  await assertAssignableAgent(db, params.accountId, params.assignedAgentId);
  await assertAssignableLine(db, params.accountId, params.whatsappConfigId);
  await assertAssignableDepartment(db, params.accountId, params.departmentId);

  const patch = getConversationMutationPatch(
    params.action,
    current as ConversationState,
    params.userId,
    params.assignedAgentId,
    params.whatsappConfigId,
    params.departmentId,
  );

  let query = db
    .from("conversations")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", params.conversationId)
    .eq("account_id", params.accountId);

  if (params.action === "accept") {
    query = query.eq("status", "pending").is("assigned_agent_id", null);
  }

  const { data: updatedRows, error: updateError } = await query
    .select(CONVERSATION_SELECT)
    .limit(1);

  if (updateError) throw updateError;
  if (!updatedRows || updatedRows.length === 0) {
    throw new InboxWorkflowError("This chat is already being handled by another agent.", 409);
  }

  const [updated] = await hydrateAssignedAgents(
    db,
    params.accountId,
    [normalizeConversation(updatedRows[0] as never)],
  );

  const agentName = await resolveAgentName(db, params.accountId, params.userId);
  const systemText = systemMessageForAction(params.action, agentName);
  if (systemText) {
    const { error: messageError } = await db.from("messages").insert({
      conversation_id: params.conversationId,
      sender_type: "bot",
      sender_id: params.userId,
      content_type: "system",
      content_text: systemText,
      status: "sent",
    });
    if (messageError) {
      console.error("Failed to create inbox system message:", messageError);
    }
  }

  return updated;
}

export async function deleteInboxConversation(
  db: SupabaseClient,
  params: {
    accountId: string;
    conversationId: string;
  },
) {
  const { data: current, error: findError } = await db
    .from("conversations")
    .select("id")
    .eq("id", params.conversationId)
    .eq("account_id", params.accountId)
    .maybeSingle();

  if (findError) throw findError;
  if (!current) throw new InboxWorkflowError("Conversation not found.", 404);

  const { error } = await db
    .from("conversations")
    .delete()
    .eq("id", params.conversationId)
    .eq("account_id", params.accountId);

  if (error) throw error;
}
