import { NextResponse } from 'next/server'
import { desc, eq } from 'drizzle-orm'

import { db } from '@/db/client'
import { automations } from '@/db/schema'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { getTemplate } from '@/lib/automations/templates'
import { insertSteps, type BuilderStepInput } from '@/lib/automations/steps-tree'
import { serializeAutomation } from '@/lib/automations/serialize'
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from '@/lib/automations/validate'
import { assertCanCreateAutomation } from '@/lib/platform/entitlements'
import { publishRealtimeEvent } from '@/lib/realtime/soketi-server'

export async function GET() {
  try {
    const { accountId } = await getCurrentAccount()
    const rows = await db
      .select()
      .from(automations)
      .where(eq(automations.accountId, accountId))
      .orderBy(desc(automations.createdAt))

    return NextResponse.json({ automations: rows.map(serializeAutomation) })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
    await assertCanCreateAutomation(null, ctx.accountId)
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const { name, description, trigger_type, trigger_config, is_active, steps, template } = body

  let effectiveSteps: BuilderStepInput[] | undefined = steps
  let effectiveName = name
  let effectiveDescription = description
  let effectiveTriggerType = trigger_type
  let effectiveTriggerConfig = trigger_config

  if (template && (!steps || steps.length === 0)) {
    const t = getTemplate(template)
    if (t) {
      effectiveName = effectiveName ?? t.name
      effectiveDescription = effectiveDescription ?? t.description
      effectiveTriggerType = effectiveTriggerType ?? t.trigger_type
      effectiveTriggerConfig = effectiveTriggerConfig ?? t.trigger_config
      effectiveSteps = t.steps as unknown as BuilderStepInput[]
    }
  }

  if (!effectiveName || !effectiveTriggerType) {
    return NextResponse.json(
      { error: 'name and trigger_type are required' },
      { status: 400 },
    )
  }

  if (is_active) {
    const issues = [
      ...validateTriggerForActivation(effectiveTriggerType, effectiveTriggerConfig ?? {}),
      ...validateStepsForActivation(
        (effectiveSteps ?? []) as unknown as { step_type: string; step_config: Record<string, unknown> }[],
      ),
    ]
    if (issues.length > 0) {
      return NextResponse.json(
        { error: 'Cannot activate automation with invalid configuration', issues },
        { status: 400 },
      )
    }
  }

  const [automation] = await db
    .insert(automations)
    .values({
      userId: ctx.userId,
      accountId: ctx.accountId,
      name: effectiveName,
      description: effectiveDescription ?? null,
      triggerType: effectiveTriggerType,
      triggerConfig: effectiveTriggerConfig ?? {},
      isActive: !!is_active,
    })
    .returning()

  if (!automation) {
    return NextResponse.json({ error: 'insert failed' }, { status: 500 })
  }

  if (effectiveSteps && effectiveSteps.length > 0) {
    const err = await insertSteps(automation.id, effectiveSteps)
    if (err) return NextResponse.json({ error: err }, { status: 500 })
  }

  const serialized = serializeAutomation(automation)
  await publishRealtimeEvent('automation.created', {
    accountId: ctx.accountId,
    payload: { automation: serialized },
  }).catch((error) => {
    console.warn('[realtime] failed to publish automation.created:', error)
  })

  return NextResponse.json({ automation: serialized }, { status: 201 })
}
