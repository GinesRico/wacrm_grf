import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  conversations as conversationsTable,
  contactCustomValues,
  contactNotes,
  contactTags,
  customFields,
  departments,
  departmentMembers,
  messages,
  profiles,
  tags,
  whatsappConfig,
} from "@/db/schema";
import type { Conversation, ConversationStatus } from "@/types";
import {
  getInboxConversationById,
  hydrateAssignedAgents,
  normalizeConversations,
} from "@/lib/inbox/conversations";
import { createRealtimeNotification } from "@/lib/notifications/create-notification";
import {
  findNormalizedSearchIndex,
  normalizedSearchIncludes,
  normalizeSearchText,
} from "@/lib/search/normalize";

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
  quickFilters: InboxQuickFilter[];
}

export type InboxQuickFilter =
  | "unread"
  | "pending"
  | "resolved"
  | "tagged"
  | "files"
  | "templates"
  | "customers";

type SearchField =
  | "contact"
  | "message"
  | "tag"
  | "note"
  | "custom_field"
  | "agent"
  | "line"
  | "status";

interface SearchMatch {
  field: SearchField;
  label?: string;
  snippet: string;
  message_id?: string | null;
  score: number;
}

interface ParsedInboxSearch {
  text: string;
  terms: string[];
  filters: {
    from?: string;
    tag?: string;
    line?: string;
    status?: string;
    matricula?: string;
  };
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
      return { status: "closed", assigned_agent_id: null };
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

const QUICK_FILTERS = new Set<InboxQuickFilter>([
  "unread",
  "pending",
  "resolved",
  "tagged",
  "files",
  "templates",
  "customers",
]);

function normalizeQuickFilters(value: string | null): InboxQuickFilter[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is InboxQuickFilter =>
      QUICK_FILTERS.has(item as InboxQuickFilter),
    );
}

export function parseInboxSearchParams(searchParams: URLSearchParams) {
  return {
    tab: normalizeTab(searchParams.get("tab")),
    subtab: normalizeSubtab(searchParams.get("subtab")),
    scope: normalizeScope(searchParams.get("scope")),
    search: searchParams.get("search")?.trim() ?? "",
    quickFilters: normalizeQuickFilters(searchParams.get("quick")),
  };
}

function normalizeText(value: string | null | undefined) {
  return normalizeSearchText(value);
}

function parseInboxSearch(raw: string): ParsedInboxSearch {
  const filters: ParsedInboxSearch["filters"] = {};
  const terms: string[] = [];
  const tokenRe = /(?:[^\s"]+|"[^"]*")+/g;
  const tokens = raw.match(tokenRe) ?? [];

  for (const token of tokens) {
    const cleaned = token.replace(/^"|"$/g, "").trim();
    if (!cleaned) continue;
    const match = cleaned.match(/^([a-zA-Z_]+):(.*)$/);
    if (match) {
      const key = match[1].toLocaleLowerCase();
      const value = match[2].trim();
      if (!value) continue;
      if (key === "from") filters.from = value;
      else if (key === "tag") filters.tag = value;
      else if (key === "linea" || key === "line") filters.line = value;
      else if (key === "estado" || key === "status") filters.status = value;
      else if (key === "matricula") filters.matricula = value;
      else terms.push(cleaned);
      continue;
    }
    terms.push(cleaned);
  }

  return { text: terms.join(" "), terms, filters };
}

function statusMatches(status: ConversationStatus, value: string) {
  const normalized = normalizeText(value);
  if (["open", "abierta", "abierto", "atendiendo"].includes(normalized)) {
    return status === "open";
  }
  if (["pending", "pendiente", "espera", "cola"].includes(normalized)) {
    return status === "pending";
  }
  if (["closed", "cerrada", "cerrado", "resuelta", "resuelto"].includes(normalized)) {
    return status === "closed";
  }
  return normalizeText(status).includes(normalized);
}

function makeSnippet(value: string, query: string, maxLength = 96) {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!query.trim()) return compact.slice(0, maxLength);
  const index = findNormalizedSearchIndex(compact, query);
  if (index < 0) return compact.slice(0, maxLength);
  const start = Math.max(0, index - 32);
  const end = Math.min(compact.length, index + Math.max(query.length, 7) + 48);
  return `${start > 0 ? "..." : ""}${compact.slice(start, end)}${end < compact.length ? "..." : ""}`;
}

function includesAnyTerm(value: string | null | undefined, terms: string[]) {
  if (terms.length === 0) return false;
  return terms.some((term) => normalizedSearchIncludes(value, term));
}

function bestFieldMatch(
  current: SearchMatch | null,
  field: SearchField,
  label: string | undefined,
  text: string | null | undefined,
  query: string,
  score: number,
): SearchMatch | null {
  if (!text || !query || !normalizedSearchIncludes(text, query)) {
    return current;
  }
  if (current && current.score >= score) return current;
  return {
    field,
    label,
    snippet: makeSnippet(text, query),
    score,
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
            conversation.department_id == null ||
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

  const parsedSearch = parseInboxSearch(params.search);
  const primaryQuery = parsedSearch.text || parsedSearch.filters.matricula || "";
  const hasSearch =
    Boolean(primaryQuery) || Object.keys(parsedSearch.filters).length > 0;
  const scopedConversationIds = scoped.map((conversation) => conversation.id);
  const scopedContactIds = scoped
    .map((conversation) => conversation.contact_id)
    .filter(Boolean);

  const messageMatches = new Map<string, SearchMatch>();
  const fileConversationIds = new Set<string>();
  const templateConversationIds = new Set<string>();
  const customerConversationIds = new Set<string>();

  if (
    scopedConversationIds.length > 0 &&
    (primaryQuery ||
      params.quickFilters.includes("files") ||
      params.quickFilters.includes("templates") ||
      params.quickFilters.includes("customers"))
  ) {
    const messageRows = await db
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        senderType: messages.senderType,
        contentType: messages.contentType,
        contentText: messages.contentText,
        templateName: messages.templateName,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(inArray(messages.conversationId, scopedConversationIds))
      .orderBy(sql`${messages.createdAt} desc`)
      .limit(2500);

    for (const row of messageRows) {
      if (["image", "audio", "video", "document", "sticker"].includes(row.contentType)) {
        fileConversationIds.add(row.conversationId);
      }
      if (row.contentType === "template" || row.templateName) {
        templateConversationIds.add(row.conversationId);
      }
      if (row.senderType === "customer") {
        customerConversationIds.add(row.conversationId);
      }
      if (!primaryQuery) continue;
      const text = row.contentText || row.templateName || "";
      if (!normalizedSearchIncludes(text, primaryQuery)) continue;
      const existing = messageMatches.get(row.conversationId);
      if (!existing || existing.score < 80) {
        messageMatches.set(row.conversationId, {
          field: "message",
          snippet: makeSnippet(text, primaryQuery),
          message_id: row.id,
          score: 80,
        });
      }
    }
  }

  const noteMatches = new Map<string, SearchMatch>();
  const customMatches = new Map<string, SearchMatch>();
  const matchingTagContactIds = new Set<string>();

  if (primaryQuery && scopedContactIds.length > 0) {
    const [noteRows, customRows, tagRows] = await Promise.all([
      db
        .select({
          contactId: contactNotes.contactId,
          noteText: contactNotes.noteText,
        })
        .from(contactNotes)
        .where(
          and(
            eq(contactNotes.accountId, params.accountId),
            inArray(contactNotes.contactId, scopedContactIds),
          ),
        )
        .limit(500),
      db
        .select({
          contactId: contactCustomValues.contactId,
          fieldName: customFields.fieldName,
          value: contactCustomValues.value,
        })
        .from(contactCustomValues)
        .innerJoin(customFields, eq(customFields.id, contactCustomValues.customFieldId))
        .where(
          and(
            eq(customFields.accountId, params.accountId),
            inArray(contactCustomValues.contactId, scopedContactIds),
          ),
        )
        .limit(500),
      db
        .select({
          contactId: contactTags.contactId,
          name: tags.name,
        })
        .from(contactTags)
        .innerJoin(tags, eq(tags.id, contactTags.tagId))
        .where(
          and(
            eq(tags.accountId, params.accountId),
            inArray(contactTags.contactId, scopedContactIds),
          ),
        )
        .limit(500),
    ]);

    for (const row of noteRows) {
      if (!normalizedSearchIncludes(row.noteText, primaryQuery)) continue;
      const conversation = scoped.find((item) => item.contact_id === row.contactId);
      if (!conversation) continue;
      noteMatches.set(conversation.id, {
        field: "note",
        snippet: makeSnippet(row.noteText, primaryQuery),
        score: 55,
      });
    }
    for (const row of customRows) {
      if (!normalizedSearchIncludes(row.value, primaryQuery)) continue;
      const conversation = scoped.find((item) => item.contact_id === row.contactId);
      if (!conversation || !row.value) continue;
      customMatches.set(conversation.id, {
        field: "custom_field",
        label: row.fieldName,
        snippet: makeSnippet(row.value, primaryQuery),
        score: row.fieldName.toLocaleLowerCase() === "matricula" ? 95 : 60,
      });
    }
    for (const row of tagRows) {
      if (!normalizedSearchIncludes(row.name, primaryQuery)) continue;
      matchingTagContactIds.add(row.contactId);
    }
  }

  function quickFiltersMatch(conversation: Conversation) {
    return params.quickFilters.every((filter) => {
      switch (filter) {
        case "unread":
          return conversation.unread_count > 0;
        case "pending":
          return conversation.status === "pending";
        case "resolved":
          return conversation.status === "closed";
        case "tagged":
          return (conversation.contact?.tags?.length ?? 0) > 0;
        case "files":
          return fileConversationIds.has(conversation.id);
        case "templates":
          return templateConversationIds.has(conversation.id);
        case "customers":
          return customerConversationIds.has(conversation.id);
      }
    });
  }

  function passesAdvancedFilters(conversation: Conversation) {
    const { filters } = parsedSearch;
    if (filters.status && !statusMatches(conversation.status, filters.status)) {
      return false;
    }
    if (filters.tag) {
      if (
        !(conversation.contact?.tags ?? []).some((tag) =>
          normalizedSearchIncludes(tag.name, filters.tag),
        )
      ) {
        return false;
      }
    }
    if (filters.line) {
      const lineText = `${conversation.whatsapp_config?.label ?? ""} ${
        conversation.whatsapp_config?.phone_number_id ?? ""
      }`;
      if (!normalizedSearchIncludes(lineText, filters.line)) return false;
    }
    if (filters.from) {
      const agentText = `${conversation.assigned_agent?.full_name ?? ""} ${
        conversation.assigned_agent?.email ?? ""
      }`;
      const contactText = `${conversation.contact?.name ?? ""} ${
        conversation.contact?.phone ?? ""
      } ${conversation.contact?.email ?? ""}`;
      if (
        !normalizedSearchIncludes(agentText, filters.from) &&
        !normalizedSearchIncludes(contactText, filters.from)
      ) {
        return false;
      }
    }
    return true;
  }

  function searchMatchFor(conversation: Conversation): SearchMatch | null {
    let match: SearchMatch | null = null;
    if (!primaryQuery) {
      if (parsedSearch.filters.status) {
        return {
          field: "status",
          snippet: conversation.status,
          score: 30,
        };
      }
      return null;
    }

    const contact = conversation.contact;
    match = bestFieldMatch(match, "contact", undefined, contact?.name, primaryQuery, 100);
    match = bestFieldMatch(match, "contact", undefined, contact?.phone, primaryQuery, 98);
    match = bestFieldMatch(match, "contact", undefined, contact?.email, primaryQuery, 90);
    match = bestFieldMatch(match, "contact", undefined, contact?.company, primaryQuery, 85);
    match = bestFieldMatch(
      match,
      "line",
      undefined,
      `${conversation.whatsapp_config?.label ?? ""} ${
        conversation.whatsapp_config?.phone_number_id ?? ""
      }`,
      primaryQuery,
      84,
    );
    match = bestFieldMatch(
      match,
      "agent",
      undefined,
      `${conversation.assigned_agent?.full_name ?? ""} ${
        conversation.assigned_agent?.email ?? ""
      }`,
      primaryQuery,
      82,
    );
    match = bestFieldMatch(
      match,
      "message",
      undefined,
      conversation.last_message_text,
      primaryQuery,
      75,
    );

    const tagMatch = (contact?.tags ?? []).find((tag) =>
      normalizedSearchIncludes(tag.name, primaryQuery),
    );
    if (tagMatch && (!match || match.score < 70)) {
      match = {
        field: "tag",
        snippet: tagMatch.name,
        score: 70,
      };
    }

    for (const candidate of [
      messageMatches.get(conversation.id),
      customMatches.get(conversation.id),
      noteMatches.get(conversation.id),
    ]) {
      if (candidate && (!match || candidate.score > match.score)) {
        match = candidate;
      }
    }

    return match;
  }

  let rows = scoped
    .filter(
      (conversation) =>
        matchesTab(conversation, params.tab, params.subtab) &&
        quickFiltersMatch(conversation) &&
        passesAdvancedFilters(conversation),
    )
    .map((conversation) => ({
      ...conversation,
      search_match: searchMatchFor(conversation),
    }));

  if (hasSearch) {
    rows = rows.filter((conversation) => {
      if (conversation.search_match) return true;
      if (parsedSearch.filters.matricula) return false;
      if (primaryQuery) {
        return (
          matchingTagContactIds.has(conversation.contact_id) ||
          includesAnyTerm(conversation.last_message_text, parsedSearch.terms)
        );
      }
      return true;
    });
    rows.sort((a, b) => {
      const scoreDelta = (b.search_match?.score ?? 0) - (a.search_match?.score ?? 0);
      if (scoreDelta !== 0) return scoreDelta;
      return (b.last_message_at ?? b.updated_at ?? "").localeCompare(
        a.last_message_at ?? a.updated_at ?? "",
      );
    });
  }

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

  if (
    updated.assigned_agent_id &&
    updated.assigned_agent_id !== params.userId &&
    updated.assigned_agent_id !== current.assigned_agent_id
  ) {
    await createRealtimeNotification({
      accountId: params.accountId,
      userId: updated.assigned_agent_id,
      conversationId: updated.id,
      contactId: updated.contact_id,
      actorUserId: params.userId,
      title: "Conversacion asignada",
      body: updated.contact?.name
        ? `${updated.contact.name} te ha sido asignado`
        : "Se te ha asignado una conversacion",
    }).catch((error) => {
      console.warn("[notifications] failed to create assignment notification:", error);
    });
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
