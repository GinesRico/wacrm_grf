import { NextResponse } from 'next/server'
import { desc, eq } from 'drizzle-orm'

import { db } from '@/db/client'
import { flowNodes, flows } from '@/db/schema'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { getFlowTemplate } from '@/lib/flows/templates'
import { serializeFlow } from '@/lib/flows/serialize'
import { assertCanCreateFlow } from '@/lib/platform/entitlements'
import { publishRealtimeEvent } from '@/lib/realtime/soketi-server'

export async function GET() {
  try {
    const { accountId } = await getCurrentAccount()
    const rows = await db
      .select()
      .from(flows)
      .where(eq(flows.accountId, accountId))
      .orderBy(desc(flows.createdAt))

    return NextResponse.json({ flows: rows.map(serializeFlow) })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
    await assertCanCreateFlow(null, ctx.accountId)
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = (await request.json().catch(() => null)) as
    | {
        name?: string
        description?: string | null
        trigger_type?: 'keyword' | 'first_inbound_message' | 'manual'
        trigger_config?: Record<string, unknown>
        template_slug?: string
      }
    | null
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  if (body.template_slug) {
    const template = getFlowTemplate(body.template_slug)
    if (!template) {
      return NextResponse.json(
        { error: `Unknown template_slug "${body.template_slug}"` },
        { status: 400 },
      )
    }

    const [flow] = await db
      .insert(flows)
      .values({
        userId: ctx.userId,
        accountId: ctx.accountId,
        name: body.name?.trim() || template.name,
        description: template.description,
        status: 'draft',
        triggerType: template.trigger_type,
        triggerConfig: template.trigger_config,
        entryNodeId: template.entry_node_id,
      })
      .returning()

    if (!flow) return NextResponse.json({ error: 'flow insert failed' }, { status: 500 })

    try {
      if (template.nodes.length > 0) {
        await db.insert(flowNodes).values(
          template.nodes.map((node) => ({
            flowId: flow.id,
            nodeKey: node.node_key,
            nodeType: node.node_type,
            config: node.config,
          })),
        )
      }
    } catch (err) {
      await db.delete(flows).where(eq(flows.id, flow.id))
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'nodes insert failed' },
        { status: 500 },
      )
    }

    const serialized = serializeFlow(flow)
    await publishRealtimeEvent('flow.created', {
      accountId: ctx.accountId,
      payload: { flow: serialized },
    }).catch((error) => {
      console.warn('[realtime] failed to publish flow.created:', error)
    })

    return NextResponse.json({ flow: serialized }, { status: 201 })
  }

  if (!body.name?.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }

  const [flow] = await db
    .insert(flows)
    .values({
      userId: ctx.userId,
      accountId: ctx.accountId,
      name: body.name.trim(),
      description: body.description ?? null,
      status: 'draft',
      triggerType: body.trigger_type ?? 'keyword',
      triggerConfig: body.trigger_config ?? {},
    })
    .returning()

  if (!flow) return NextResponse.json({ error: 'insert failed' }, { status: 500 })
  const serialized = serializeFlow(flow)
  await publishRealtimeEvent('flow.created', {
    accountId: ctx.accountId,
    payload: { flow: serialized },
  }).catch((error) => {
    console.warn('[realtime] failed to publish flow.created:', error)
  })
  return NextResponse.json({ flow: serialized }, { status: 201 })
}
