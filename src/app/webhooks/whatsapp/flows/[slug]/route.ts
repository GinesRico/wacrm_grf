import { NextResponse } from 'next/server';

import {
  decryptMetaFlowRequest,
  encryptMetaFlowResponse,
  type EncryptedMetaFlowRequest,
} from '@/lib/whatsapp-flows/crypto';
import { getMetaFlowHandler } from '@/lib/whatsapp-flows/registry';
import { parseMetaFlowToken } from '@/lib/whatsapp-flows/token';
import type { MetaFlowRequestBody } from '@/lib/whatsapp-flows/types';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> }
) {
  const { slug } = await context.params;
  const handler = getMetaFlowHandler(slug);
  if (!handler) {
    return NextResponse.json(
      { error: 'Unknown WhatsApp Flow' },
      { status: 404 }
    );
  }

  try {
    const encrypted = (await request.json()) as EncryptedMetaFlowRequest;
    const decrypted = decryptMetaFlowRequest<MetaFlowRequestBody>(encrypted);
    const flowToken = decrypted.body.flow_token || '';
    const token = parseMetaFlowToken(flowToken);
    if (!token || token.slug !== slug) {
      console.warn('[whatsapp-flows] invalid flow_token for slug:', slug);
      return new Response(
        encryptMetaFlowResponse(
          {
            version: '3.0',
            screen: 'ERROR',
            data: { error: 'Invalid flow token' },
          },
          decrypted.aesKey,
          decrypted.initialVector
        ),
        { status: 200, headers: { 'Content-Type': 'text/plain' } }
      );
    }

    const response = await handler.handleRequest(decrypted.body, {
      accountId: token.accountId,
      slug,
      flowToken,
    });
    return new Response(
      encryptMetaFlowResponse(
        { ...response },
        decrypted.aesKey,
        decrypted.initialVector
      ),
      { status: 200, headers: { 'Content-Type': 'text/plain' } }
    );
  } catch (error) {
    console.error('[whatsapp-flows] request failed:', error);
    return NextResponse.json(
      { error: 'Failed to process WhatsApp Flow' },
      { status: 400 }
    );
  }
}
