import { NextResponse } from 'next/server'
import { and, asc, eq } from 'drizzle-orm'

import { db } from '@/db/client'
import { automations, automationSteps } from '@/db/schema'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { serializeAutomation } from '@/lib/automations/serialize'
import { assertCanCreateAutomation } from '@/lib/platform/entitlements'
import { publishRealtimeEvent } from '@/lib/realtime/soketi-server'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const ctx = await requireRole('admin')

    const [original] = await db
      .select()
      .from(automations)
      .where(and(eq(automations.id, id), eq(automations.accountId, ctx.accountId)))
      .limit(1)

    if (!original) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    await assertCanCreateAutomation(null, original.accountId)

    const [copy] = await db
      .insert(automations)
      .values({
        accountId: original.accountId,
        userId: ctx.userId,
        name: `${original.name} (Copy)`,
        description: original.description,
        triggerType: original.triggerType,
        triggerConfig: original.triggerConfig,
        isActive: false,
      })
      .returning()

    if (!copy) {
      return NextResponse.json({ error: 'copy failed' }, { status: 500 })
    }

    const steps = await db
      .select()
      .from(automationSteps)
      .where(eq(automationSteps.automationId, id))
      .orderBy(asc(automationSteps.position))

    if (steps.length > 0) {
      const idMap = new Map<string, string>()
      for (const row of steps) idMap.set(row.id, crypto.randomUUID())

      await db.insert(automationSteps).values(
        steps.map((row) => ({
          id: idMap.get(row.id)!,
          automationId: copy.id,
          parentStepId: row.parentStepId ? idMap.get(row.parentStepId) ?? null : null,
          branch: row.branch,
          stepType: row.stepType,
          stepConfig: row.stepConfig,
          position: row.position,
        })),
      )
    }

    const automation = serializeAutomation(copy)
    await publishRealtimeEvent('automation.created', {
      accountId: ctx.accountId,
      payload: { automation },
    }).catch((error) => {
      console.warn('[realtime] failed to publish automation.created:', error)
    })

    return NextResponse.json({ automation }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
