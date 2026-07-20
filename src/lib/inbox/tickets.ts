import { and, eq, ilike, isNull, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  conversations as conversationsTable,
  departments,
  departmentMembers,
  messages,
  profiles,
  whatsappConfig,
} from "@/db/schema";
import type { Conversation, ConversationStatus } from "@/types";
import {
  getInboxConversationById,
  hydrateAssignedAgents,
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
  _unusedClient: unknown,
  accountId: string,
  userId: string,
) {
  const [row] = await db
    .select({ full_name: profiles.fullName, email: profiles.email })
    .from(profiles)
    .where(and(eq(profiles.accountId, accountId), eq(profiles.userId, userId)))
    .limit(1);
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
  _unusedClient: unknown,
  params: ListInboxParams,
) {
  const [allDepartmentRows, departmentRows] = await Promise.all([
    db
      .select({ id: departments.id })
      .from(departments)
      .where(eq(departments.accountId, params.accountId)),
    db
      .select({ department_id: departmentMembers.departmentId })
      .from(departmentMembers)
      .where(
        and(
          eq(departmentMembers.accountId, params.accountId),
          eq(departmentMembers.userId, params.userId),
        ),
      ),
  ]);

  const departmentIds = departmentRows
    .map((row) => row.department_id)
    .filter(Boolean);

  const result = await db.execute(sql`
    select
      c.*,
      case
        when ct.id is null then null
        else json_build_object(
          'id', ct.id,
          'user_id', ct.user_id,
          'account_id', ct.account_id,
          'phone', ct.phone,
          'phone_normalized', ct.phone_normalized,
          'name', ct.name,
          'email', ct.email,
          'company', ct.company,
          'avatar_url', ct.avatar_url,
          'created_at', ct.created_at,
          'updated_at', ct.updated_at,
          'tags', coalesce(tags.items, '[]'::json)
        )
      end as contact,
      case
        when wc.id is null then null
        else json_build_object('id', wc.id, 'label', wc.label, 'phone_number_id', wc.phone_number_id)
      end as whatsapp_config,
      case
        when d.id is null then null
        else json_build_object('id', d.id, 'name', d.name, 'color', d.color)
      end as department
    from conversations c
    left join contacts ct on ct.id = c.contact_id
    left join whatsapp_config wc on wc.id = c.whatsapp_config_id
    left join departments d on d.id = c.department_id
    left join lateral (
      select json_agg(
        json_build_object(
          'id', t.id,
          'user_id', t.user_id,
          'name', t.name,
          'color', t.color,
          'created_at', t.created_at
        )
        order by t.name asc
      ) as items
      from contact_tags ctag
      join tags t on t.id = ctag.tag_id
      where ctag.contact_id = ct.id
    ) tags on true
    where c.account_id = ${params.accountId}
    order by c.last_message_at desc nulls last, c.updated_at desc
  `);

  const conversations = await hydrateAssignedAgents(
    null,
    params.accountId,
    normalizeConversations((result.rows ?? []) as never[]),
  );
  const hasDepartmentQueues = allDepartmentRows.length > 0;
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
    const messageRows = await db
      .select({ conversation_id: messages.conversationId })
      .from(messages)
      .where(ilike(messages.contentText, `%${params.search}%`))
      .limit(500);
    matchingMessageConversationIds = new Set(
      messageRows
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
  _unusedClient: unknown,
  accountId: string,
  assignedAgentId: string | null | undefined,
) {
  if (!assignedAgentId) return;
  const [row] = await db
    .select({ user_id: profiles.userId })
    .from(profiles)
    .where(
      and(eq(profiles.accountId, accountId), eq(profiles.userId, assignedAgentId)),
    )
    .limit(1);

  if (!row) {
    throw new InboxWorkflowError("Assigned agent is not a member of this account.", 400);
  }
}

async function assertAssignableLine(
  _unusedClient: unknown,
  accountId: string,
  whatsappConfigId: string | null | undefined,
) {
  if (whatsappConfigId === undefined || whatsappConfigId === null) return;

  const [row] = await db
    .select({ id: whatsappConfig.id })
    .from(whatsappConfig)
    .where(
      and(
        eq(whatsappConfig.accountId, accountId),
        eq(whatsappConfig.id, whatsappConfigId),
      ),
    )
    .limit(1);

  if (!row) {
    throw new InboxWorkflowError("WhatsApp line is not part of this account.", 400);
  }
}

async function assertAssignableDepartment(
  _unusedClient: unknown,
  accountId: string,
  departmentId: string | null | undefined,
) {
  if (departmentId === undefined || departmentId === null) return;

  const [row] = await db
    .select({ id: departments.id })
    .from(departments)
    .where(and(eq(departments.accountId, accountId), eq(departments.id, departmentId)))
    .limit(1);

  if (!row) {
    throw new InboxWorkflowError("Department is not part of this account.", 400);
  }
}

export async function mutateInboxConversation(
  _unusedClient: unknown,
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
  const [current] = await db
    .select({
      id: conversationsTable.id,
      status: conversationsTable.status,
      assigned_agent_id: conversationsTable.assignedAgentId,
    })
    .from(conversationsTable)
    .where(
      and(
        eq(conversationsTable.id, params.conversationId),
        eq(conversationsTable.accountId, params.accountId),
      ),
    )
    .limit(1);

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

  const set = {
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.assigned_agent_id !== undefined
      ? { assignedAgentId: patch.assigned_agent_id }
      : {}),
    ...(patch.whatsapp_config_id !== undefined
      ? { whatsappConfigId: patch.whatsapp_config_id }
      : {}),
    ...(patch.department_id !== undefined ? { departmentId: patch.department_id } : {}),
    updatedAt: new Date(),
  };

  const where =
    params.action === "accept"
      ? and(
          eq(conversationsTable.id, params.conversationId),
          eq(conversationsTable.accountId, params.accountId),
          eq(conversationsTable.status, "pending"),
          isNull(conversationsTable.assignedAgentId),
        )
      : and(
          eq(conversationsTable.id, params.conversationId),
          eq(conversationsTable.accountId, params.accountId),
        );

  const updatedRows = await db
    .update(conversationsTable)
    .set(set)
    .where(where)
    .returning({ id: conversationsTable.id });

  if (updatedRows.length === 0) {
    throw new InboxWorkflowError("This chat is already being handled by another agent.", 409);
  }

  const updated = await getInboxConversationById(params.accountId, params.conversationId);
  if (!updated) throw new InboxWorkflowError("Conversation not found.", 404);

  const agentName = await resolveAgentName(null, params.accountId, params.userId);
  const systemText = systemMessageForAction(params.action, agentName);
  if (systemText) {
    try {
      await db.insert(messages).values({
        conversationId: params.conversationId,
        senderType: "bot",
        senderId: params.userId,
        contentType: "system",
        contentText: systemText,
        status: "sent",
      });
    } catch (messageError) {
      console.error("Failed to create inbox system message:", messageError);
    }
  }

  return updated;
}

export async function deleteInboxConversation(
  _unusedClient: unknown,
  params: {
    accountId: string;
    conversationId: string;
  },
) {
  const deleted = await db
    .delete(conversationsTable)
    .where(
      and(
        eq(conversationsTable.id, params.conversationId),
        eq(conversationsTable.accountId, params.accountId),
      ),
    )
    .returning({ id: conversationsTable.id });

  if (deleted.length === 0) throw new InboxWorkflowError("Conversation not found.", 404);
}
