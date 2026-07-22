import { and, desc, eq, lt, or, type SQL } from 'drizzle-orm';

import { db } from '@/db/client';
import { automationLogs, automations, automationSteps, contacts } from '@/db/schema';
import {
  serializeAutomation,
  serializeAutomationLog,
} from '@/lib/automations/serialize';
import type { Cursor } from '@/lib/api/v1/pagination';
import type { AutomationStep } from '@/types';

function cursorWhere(cursor: Cursor | null): SQL | undefined {
  if (!cursor) return undefined;
  const createdAt = new Date(cursor.createdAt);
  return or(
    lt(automations.createdAt, createdAt),
    and(eq(automations.createdAt, createdAt), lt(automations.id, cursor.id)),
  );
}

function logCursorWhere(cursor: Cursor | null): SQL | undefined {
  if (!cursor) return undefined;
  const createdAt = new Date(cursor.createdAt);
  return or(
    lt(automationLogs.createdAt, createdAt),
    and(eq(automationLogs.createdAt, createdAt), lt(automationLogs.id, cursor.id)),
  );
}

export function serializeAutomationStep(
  row: typeof automationSteps.$inferSelect,
): AutomationStep {
  return {
    id: row.id,
    automation_id: row.automationId,
    parent_step_id: row.parentStepId,
    branch: row.branch as AutomationStep['branch'],
    step_type: row.stepType as AutomationStep['step_type'],
    step_config: row.stepConfig as AutomationStep['step_config'],
    position: row.position,
    created_at: row.createdAt.toISOString(),
  };
}

export async function listAutomations(input: {
  accountId: string;
  limit: number;
  cursor: Cursor | null;
  triggerType?: string | null;
  isActive?: boolean | null;
}) {
  const conditions: SQL[] = [eq(automations.accountId, input.accountId)];
  if (input.triggerType) {
    conditions.push(eq(automations.triggerType, input.triggerType));
  }
  if (typeof input.isActive === 'boolean') {
    conditions.push(eq(automations.isActive, input.isActive));
  }
  const cursorCondition = cursorWhere(input.cursor);
  if (cursorCondition) conditions.push(cursorCondition);

  const rows = await db
    .select()
    .from(automations)
    .where(and(...conditions))
    .orderBy(desc(automations.createdAt), desc(automations.id))
    .limit(input.limit);

  return rows.map(serializeAutomation);
}

export async function getAutomationWithSteps(accountId: string, id: string) {
  const [automation] = await db
    .select()
    .from(automations)
    .where(and(eq(automations.id, id), eq(automations.accountId, accountId)))
    .limit(1);

  if (!automation) return null;

  const steps = await db
    .select()
    .from(automationSteps)
    .where(eq(automationSteps.automationId, id))
    .orderBy(automationSteps.position);

  return {
    automation: serializeAutomation(automation),
    steps: steps.map(serializeAutomationStep),
  };
}

export async function listAutomationLogs(input: {
  accountId: string;
  automationId: string;
  limit: number;
  cursor: Cursor | null;
}) {
  const cursorCondition = logCursorWhere(input.cursor);
  const conditions: SQL[] = [
    eq(automationLogs.accountId, input.accountId),
    eq(automationLogs.automationId, input.automationId),
  ];
  if (cursorCondition) conditions.push(cursorCondition);

  const rows = await db
    .select({
      log: automationLogs,
      contact: contacts,
    })
    .from(automationLogs)
    .leftJoin(contacts, eq(automationLogs.contactId, contacts.id))
    .where(and(...conditions))
    .orderBy(desc(automationLogs.createdAt), desc(automationLogs.id))
    .limit(input.limit);

  return rows.map((row) => serializeAutomationLog(row.log, row.contact));
}
