import { NextResponse } from 'next/server'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'

import { db } from '@/db/client'
import { contacts, flowRunEvents, flowRuns, flows } from '@/db/schema'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { serializeFlowRunEvent } from '@/lib/flows/serialize'

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    const { accountId } = await getCurrentAccount()

    const [flow] = await db
      .select({ id: flows.id, name: flows.name })
      .from(flows)
      .where(and(eq(flows.id, id), eq(flows.accountId, accountId)))
      .limit(1)

    if (!flow) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const rows = await db
      .select({ run: flowRuns, contact: contacts })
      .from(flowRuns)
      .leftJoin(contacts, eq(flowRuns.contactId, contacts.id))
      .where(and(eq(flowRuns.flowId, id), eq(flowRuns.accountId, accountId)))
      .orderBy(desc(flowRuns.startedAt))
      .limit(50)

    const runIds = rows.map((row) => row.run.id)
    const eventRows =
      runIds.length > 0
        ? await db
            .select()
            .from(flowRunEvents)
            .where(inArray(flowRunEvents.flowRunId, runIds))
            .orderBy(asc(flowRunEvents.createdAt))
        : []

    return NextResponse.json({
      flow,
      runs: rows.map((row) => ({
        id: row.run.id,
        status: row.run.status,
        current_node_key: row.run.currentNodeKey,
        started_at: row.run.startedAt.toISOString(),
        last_advanced_at: row.run.lastAdvancedAt.toISOString(),
        ended_at: row.run.endedAt?.toISOString() ?? null,
        end_reason: row.run.endReason,
        vars: row.run.vars,
        reprompt_count: row.run.repromptCount,
        contact: row.contact
          ? {
              id: row.contact.id,
              name: row.contact.name,
              phone: row.contact.phone,
            }
          : null,
      })),
      events: eventRows.map(serializeFlowRunEvent),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
