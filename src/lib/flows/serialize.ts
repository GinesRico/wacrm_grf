import type { flowNodes, flowRunEvents, flowRuns, flows } from "@/db/schema";

export function serializeFlow(row: typeof flows.$inferSelect) {
  return {
    id: row.id,
    user_id: row.userId,
    account_id: row.accountId,
    name: row.name,
    description: row.description,
    status: row.status,
    trigger_type: row.triggerType,
    trigger_config: row.triggerConfig,
    entry_node_id: row.entryNodeId,
    fallback_policy: row.fallbackPolicy,
    execution_count: row.executionCount,
    last_executed_at: row.lastExecutedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export function serializeFlowNode(row: typeof flowNodes.$inferSelect) {
  return {
    id: row.id,
    flow_id: row.flowId,
    node_key: row.nodeKey,
    node_type: row.nodeType,
    config: row.config,
    position_x: row.positionX,
    position_y: row.positionY,
    created_at: row.createdAt.toISOString(),
  };
}

export function serializeFlowRun(row: typeof flowRuns.$inferSelect) {
  return {
    id: row.id,
    flow_id: row.flowId,
    user_id: row.userId,
    account_id: row.accountId,
    contact_id: row.contactId,
    conversation_id: row.conversationId,
    status: row.status,
    current_node_key: row.currentNodeKey,
    last_prompt_message_id: row.lastPromptMessageId,
    vars: row.vars,
    reprompt_count: row.repromptCount,
    started_at: row.startedAt.toISOString(),
    last_advanced_at: row.lastAdvancedAt.toISOString(),
    ended_at: row.endedAt?.toISOString() ?? null,
    end_reason: row.endReason,
  };
}

export function serializeFlowRunEvent(row: typeof flowRunEvents.$inferSelect) {
  return {
    id: row.id,
    flow_run_id: row.flowRunId,
    event_type: row.eventType,
    node_key: row.nodeKey,
    payload: row.payload,
    created_at: row.createdAt.toISOString(),
  };
}
