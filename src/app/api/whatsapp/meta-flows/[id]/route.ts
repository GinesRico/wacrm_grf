import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { db } from '@/db/client';
import { whatsappMetaFlows } from '@/db/schema';
import { requireDbRole } from '@/lib/auth/current-account';
import { toErrorResponse } from '@/lib/auth/errors';
import { publishRealtimeEvent } from '@/lib/realtime/soketi-server';
import { parseMetaFlowBody } from '@/lib/whatsapp-flows/config';
import { serializeWhatsappMetaFlow } from '@/lib/whatsapp-flows/serialize';

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireDbRole('admin');
    const { id } = await context.params;
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const payload = parseMetaFlowBodyOrResponse(body);
    if (payload instanceof NextResponse) return payload;

    const [row] = await db
      .update(whatsappMetaFlows)
      .set({ ...payload, updatedAt: new Date() })
      .where(
        and(
          eq(whatsappMetaFlows.id, id),
          eq(whatsappMetaFlows.accountId, ctx.accountId)
        )
      )
      .returning();
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const flow = serializeWhatsappMetaFlow(row);
    await publishRealtimeEvent('whatsapp_meta_flow.updated', {
      accountId: ctx.accountId,
      payload: { flow },
    }).catch((error) => {
      console.warn(
        '[realtime] failed to publish whatsapp_meta_flow.updated:',
        error
      );
    });
    return NextResponse.json({ flow });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireDbRole('admin');
    const { id } = await context.params;
    await db
      .delete(whatsappMetaFlows)
      .where(
        and(
          eq(whatsappMetaFlows.id, id),
          eq(whatsappMetaFlows.accountId, ctx.accountId)
        )
      );
    await publishRealtimeEvent('whatsapp_meta_flow.deleted', {
      accountId: ctx.accountId,
      payload: { flow: { id } },
    }).catch((error) => {
      console.warn(
        '[realtime] failed to publish whatsapp_meta_flow.deleted:',
        error
      );
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

function parseMetaFlowBodyOrResponse(body: Record<string, unknown>) {
  try {
    return parseMetaFlowBody(body);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid Meta Flow' },
      { status: 400 }
    );
  }
}
