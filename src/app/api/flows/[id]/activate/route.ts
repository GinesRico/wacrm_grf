import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'

import { db } from '@/db/client'
import { flowNodes, flows } from '@/db/schema'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { serializeFlow } from '@/lib/flows/serialize'
import { validateFlowForActivation } from '@/lib/flows/validate'
import { publishRealtimeEvent } from '@/lib/realtime/soketi-server'

export async function POST(
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
  const body = (await request.json().catch(() => null)) as
    | { status?: 'draft' | 'active' | 'archived' }
    | null
  const status = body?.status
  if (!status || !['draft', 'active', 'archived'].includes(status)) {
    return NextResponse.json(
      { error: "status must be one of 'draft' | 'active' | 'archived'" },
      { status: 400 },
    )
  }

  const [existing] = await db
    .select()
    .from(flows)
    .where(and(eq(flows.id, id), eq(flows.accountId, ctx.accountId)))
    .limit(1)
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (status === 'active') {
    const nodes = await db
      .select()
      .from(flowNodes)
      .where(eq(flowNodes.flowId, id))
    const issues = validateFlowForActivation(
      {
        name: existing.name,
        trigger_type: existing.triggerType as 'keyword' | 'first_inbound_message' | 'manual',
        trigger_config: existing.triggerConfig as Record<string, unknown>,
        entry_node_id: existing.entryNodeId,
      },
      nodes.map((node) => ({
        node_key: node.nodeKey,
        node_type: node.nodeType,
        config: node.config as Record<string, unknown>,
      })),
    )
    const blockers = issues.filter((issue) => issue.severity === 'error')
    if (blockers.length > 0) {
      return NextResponse.json(
        {
          error: 'Cannot activate flow - fix the issues below first.',
          issues,
        },
        { status: 422 },
      )
    }
  }

  const [updated] = await db
    .update(flows)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(flows.id, id), eq(flows.accountId, ctx.accountId)))
    .returning()

  const flow = updated ? serializeFlow(updated) : null
  if (flow) {
    await publishRealtimeEvent('flow.updated', {
      accountId: ctx.accountId,
      payload: { flow },
    }).catch((error) => {
      console.warn('[realtime] failed to publish flow.updated:', error)
    })
  }

  return NextResponse.json({ flow })
}
