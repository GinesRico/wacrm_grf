import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'

import { db } from '@/db/client'
import { flowRunEvents, flowRuns, flows } from '@/db/schema'
import { resolveFallbackPolicy } from '@/lib/flows/fallback'

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }

  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const now = new Date()
  const rows = await db
    .select({
      run: flowRuns,
      fallbackPolicy: flows.fallbackPolicy,
    })
    .from(flowRuns)
    .innerJoin(flows, eq(flowRuns.flowId, flows.id))
    .where(eq(flowRuns.status, 'active'))

  if (rows.length === 0) return NextResponse.json({ swept: 0 })

  let swept = 0
  for (const row of rows) {
    const policy = resolveFallbackPolicy(row.fallbackPolicy)
    const ageHours =
      (now.getTime() - row.run.lastAdvancedAt.getTime()) / (1000 * 60 * 60)
    if (ageHours < policy.on_timeout_hours) continue

    const [updated] = await db
      .update(flowRuns)
      .set({
        status: 'timed_out',
        endedAt: now,
        endReason: 'stale_sweep',
      })
      .where(and(eq(flowRuns.id, row.run.id), eq(flowRuns.status, 'active')))
      .returning({ id: flowRuns.id })

    if (updated) {
      await db.insert(flowRunEvents).values({
        flowRunId: row.run.id,
        eventType: 'timeout',
        payload: {
          age_hours: Math.round(ageHours * 10) / 10,
          policy_hours: policy.on_timeout_hours,
        },
      })
      swept += 1
    }
  }

  return NextResponse.json({ swept })
}
