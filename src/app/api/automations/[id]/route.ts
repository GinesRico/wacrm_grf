import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'

import { db } from '@/db/client'
import { automations } from '@/db/schema'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  loadStepsTree,
  replaceSteps,
  type BuilderStepInput,
} from '@/lib/automations/steps-tree'
import { serializeAutomation } from '@/lib/automations/serialize'
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from '@/lib/automations/validate'
import { publishRealtimeEvent } from '@/lib/realtime/soketi-server'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const { accountId } = await getCurrentAccount()
    const [automation] = await db
      .select()
      .from(automations)
      .where(and(eq(automations.id, id), eq(automations.accountId, accountId)))
      .limit(1)

    if (!automation) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const steps = await loadStepsTree(id)
    return NextResponse.json({ automation: serializeAutomation(automation), steps })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const { id } = await params
  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const [existing] = await db
    .select()
    .from(automations)
    .where(and(eq(automations.id, id), eq(automations.accountId, ctx.accountId)))
    .limit(1)

  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const update: Partial<typeof automations.$inferInsert> = {}
  if ('name' in body) update.name = body.name
  if ('description' in body) update.description = body.description
  if ('trigger_type' in body) update.triggerType = body.trigger_type
  if ('trigger_config' in body) update.triggerConfig = body.trigger_config
  if ('is_active' in body) update.isActive = body.is_active

  const willBeActive =
    typeof update.isActive === 'boolean' ? update.isActive : existing.isActive
  if (willBeActive) {
    const mergedTriggerType = (update.triggerType ?? existing.triggerType) as string
    const mergedTriggerConfig = update.triggerConfig ?? existing.triggerConfig
    const mergedSteps = Array.isArray(body.steps)
      ? (body.steps as { step_type: string; step_config: Record<string, unknown> }[])
      : await loadStepsTree(id)
    const issues = [
      ...validateTriggerForActivation(mergedTriggerType, mergedTriggerConfig),
      ...validateStepsForActivation(mergedSteps),
    ]
    if (issues.length > 0) {
      return NextResponse.json(
        {
          error: 'Cannot keep automation active with invalid configuration',
          issues,
        },
        { status: 400 },
      )
    }
  }

  if (Object.keys(update).length > 0) {
    await db
      .update(automations)
      .set(update)
      .where(and(eq(automations.id, id), eq(automations.accountId, ctx.accountId)))
  }

  if (Array.isArray(body.steps)) {
    const err = await replaceSteps(id, body.steps as BuilderStepInput[])
    if (err) return NextResponse.json({ error: err }, { status: 500 })
  }

  const [updated] = await db
    .select()
    .from(automations)
    .where(and(eq(automations.id, id), eq(automations.accountId, ctx.accountId)))
    .limit(1)
  if (updated) {
    await publishRealtimeEvent('automation.updated', {
      accountId: ctx.accountId,
      payload: { automation: serializeAutomation(updated) },
    }).catch((error) => {
      console.warn('[realtime] failed to publish automation.updated:', error)
    })
  }

  return NextResponse.json({ ok: true })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const { accountId } = await requireRole('admin')
    await db
      .delete(automations)
      .where(and(eq(automations.id, id), eq(automations.accountId, accountId)))
    await publishRealtimeEvent('automation.deleted', {
      accountId,
      payload: { automation: { id } },
    }).catch((error) => {
      console.warn('[realtime] failed to publish automation.deleted:', error)
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
