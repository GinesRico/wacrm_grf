import { NextResponse } from 'next/server'
import { and, asc, eq } from 'drizzle-orm'

import { db } from '@/db/client'
import { flowNodes, flows } from '@/db/schema'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { serializeFlow, serializeFlowNode } from '@/lib/flows/serialize'
import { publishRealtimeEvent } from '@/lib/realtime/soketi-server'

interface PutBody {
  name?: string
  description?: string | null
  trigger_type?: 'keyword' | 'first_inbound_message' | 'manual'
  trigger_config?: Record<string, unknown>
  entry_node_id?: string | null
  fallback_policy?: Record<string, unknown>
  nodes?: Array<{
    node_key: string
    node_type: string
    config: Record<string, unknown>
    position_x?: number
    position_y?: number
  }>
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    const { accountId } = await getCurrentAccount()

    const [flow] = await db
      .select()
      .from(flows)
      .where(and(eq(flows.id, id), eq(flows.accountId, accountId)))
      .limit(1)

    if (!flow) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const nodes = await db
      .select()
      .from(flowNodes)
      .where(eq(flowNodes.flowId, id))
      .orderBy(asc(flowNodes.createdAt))

    return NextResponse.json({
      flow: serializeFlow(flow),
      nodes: nodes.map(serializeFlowNode),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const { id } = await context.params
  const body = (await request.json().catch(() => null)) as PutBody | null
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  if (body.name !== undefined && !body.name.trim()) {
    return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
  }

  const [existing] = await db
    .select({ id: flows.id })
    .from(flows)
    .where(and(eq(flows.id, id), eq(flows.accountId, ctx.accountId)))
    .limit(1)

  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const flowPatch: Partial<typeof flows.$inferInsert> = {
    updatedAt: new Date(),
  }
  if (body.name !== undefined) flowPatch.name = body.name.trim()
  if (body.description !== undefined) flowPatch.description = body.description
  if (body.trigger_type !== undefined) flowPatch.triggerType = body.trigger_type
  if (body.trigger_config !== undefined) flowPatch.triggerConfig = body.trigger_config
  if (body.entry_node_id !== undefined) flowPatch.entryNodeId = body.entry_node_id
  if (body.fallback_policy !== undefined) flowPatch.fallbackPolicy = body.fallback_policy

  await db
    .update(flows)
    .set(flowPatch)
    .where(and(eq(flows.id, id), eq(flows.accountId, ctx.accountId)))

  if (body.nodes !== undefined) {
    await db.delete(flowNodes).where(eq(flowNodes.flowId, id))
    if (body.nodes.length > 0) {
      await db.insert(flowNodes).values(
        body.nodes.map((node) => ({
          flowId: id,
          nodeKey: node.node_key,
          nodeType: node.node_type,
          config: node.config,
          positionX: node.position_x ?? 0,
          positionY: node.position_y ?? 0,
        })),
      )
    }
  }

  const [flow] = await db
    .select()
    .from(flows)
    .where(and(eq(flows.id, id), eq(flows.accountId, ctx.accountId)))
    .limit(1)
  const nodes = await db
    .select()
    .from(flowNodes)
    .where(eq(flowNodes.flowId, id))
    .orderBy(asc(flowNodes.createdAt))

  const serializedFlow = flow ? serializeFlow(flow) : null
  if (serializedFlow) {
    await publishRealtimeEvent('flow.updated', {
      accountId: ctx.accountId,
      payload: { flow: serializedFlow },
    }).catch((error) => {
      console.warn('[realtime] failed to publish flow.updated:', error)
    })
  }

  return NextResponse.json({
    flow: serializedFlow,
    nodes: nodes.map(serializeFlowNode),
  })
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    const { accountId } = await requireRole('admin')
    await db
      .delete(flows)
      .where(and(eq(flows.id, id), eq(flows.accountId, accountId)))
    await publishRealtimeEvent('flow.deleted', {
      accountId,
      payload: { flow: { id } },
    }).catch((error) => {
      console.warn('[realtime] failed to publish flow.deleted:', error)
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
