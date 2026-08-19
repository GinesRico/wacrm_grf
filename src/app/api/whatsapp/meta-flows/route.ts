import { and, desc, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { db } from '@/db/client';
import { whatsappMetaFlows } from '@/db/schema';
import { getCurrentDbAccount, requireDbRole } from '@/lib/auth/current-account';
import { toErrorResponse } from '@/lib/auth/errors';
import { publishRealtimeEvent } from '@/lib/realtime/soketi-server';
import { parseMetaFlowBody } from '@/lib/whatsapp-flows/config';
import { serializeWhatsappMetaFlow } from '@/lib/whatsapp-flows/serialize';

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentDbAccount();
    const { searchParams } = new URL(request.url);
    const onlyActive = searchParams.get('active') === '1';
    const where = onlyActive
      ? and(
          eq(whatsappMetaFlows.accountId, ctx.accountId),
          eq(whatsappMetaFlows.active, true)
        )
      : eq(whatsappMetaFlows.accountId, ctx.accountId);
    const rows = await db
      .select()
      .from(whatsappMetaFlows)
      .where(where)
      .orderBy(desc(whatsappMetaFlows.createdAt));

    return NextResponse.json({
      flows: rows.map(serializeWhatsappMetaFlow),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireDbRole('admin');
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
      .insert(whatsappMetaFlows)
      .values({
        accountId: ctx.accountId,
        ...payload,
      })
      .returning();
    const flow = serializeWhatsappMetaFlow(row);
    await publishRealtimeEvent('whatsapp_meta_flow.created', {
      accountId: ctx.accountId,
      payload: { flow },
    }).catch((error) => {
      console.warn(
        '[realtime] failed to publish whatsapp_meta_flow.created:',
        error
      );
    });

    return NextResponse.json({ flow }, { status: 201 });
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
