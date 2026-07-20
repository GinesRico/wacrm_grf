import { NextResponse } from 'next/server'
import { and, asc, eq, lte } from 'drizzle-orm'

import { db } from '@/db/client'
import { automationPendingExecutions } from '@/db/schema'
import { resumePendingExecution } from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'

/**
 * Drain due `automation_pending_executions` rows. Meant to be hit
 * on a schedule (Vercel Cron / external pinger) and protected by
 * `AUTOMATION_CRON_SECRET`.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret')
  if (supplied !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const due = await db
    .select()
    .from(automationPendingExecutions)
    .where(
      and(
        eq(automationPendingExecutions.status, 'pending'),
        lte(automationPendingExecutions.runAt, new Date()),
      ),
    )
    .orderBy(asc(automationPendingExecutions.runAt))
    .limit(50)

  if (due.length === 0) return NextResponse.json({ processed: 0 })

  let processed = 0
  for (const row of due) {
    const [claim] = await db
      .update(automationPendingExecutions)
      .set({ status: 'running' })
      .where(
        and(
          eq(automationPendingExecutions.id, row.id),
          eq(automationPendingExecutions.status, 'pending'),
        ),
      )
      .returning({ id: automationPendingExecutions.id })

    if (!claim) continue

    await resumePendingExecution({
      id: row.id,
      automation_id: row.automationId,
      account_id: row.accountId,
      user_id: row.userId,
      contact_id: row.contactId,
      log_id: row.logId,
      parent_step_id: row.parentStepId,
      branch: (row.branch as 'yes' | 'no' | null) ?? null,
      next_step_position: row.nextStepPosition,
      context: (row.context as AutomationContext) ?? {},
    })
    processed++
  }

  return NextResponse.json({ processed })
}
