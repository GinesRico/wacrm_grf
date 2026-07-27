import { NextResponse } from 'next/server'
import { desc } from 'drizzle-orm'

import { db } from '@/db/client'
import { platformAccountRequests } from '@/db/schema'
import { toErrorResponse } from '@/lib/auth/errors'
import { requirePlatformAdmin } from '@/lib/platform/admin'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

const MAX_NAME_LEN = 80
const MAX_EMAIL_LEN = 160
const MAX_PHONE_LEN = 40
const MAX_NOTES_LEN = 500

function serializeRequest(request: typeof platformAccountRequests.$inferSelect) {
  return {
    id: request.id,
    account_name: request.accountName,
    owner_name: request.ownerName,
    owner_email: request.ownerEmail,
    phone: request.phone,
    notes: request.notes,
    status: request.status,
    reviewed_by_user_id: request.reviewedByUserId,
    reviewed_at: request.reviewedAt?.toISOString() ?? null,
    created_at: request.createdAt.toISOString(),
    updated_at: request.updatedAt.toISOString(),
  }
}

function getClientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  const ip = forwarded || request.headers.get('x-real-ip') || 'unknown'
  return `platformAccountRequest:${ip}`
}

function requiredString(
  value: unknown,
  maxLength: number,
): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength) return null
  return trimmed
}

function optionalString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, maxLength)
}

export async function GET() {
  try {
    await requirePlatformAdmin()

    const requests = await db
      .select()
      .from(platformAccountRequests)
      .orderBy(desc(platformAccountRequests.createdAt))

    return NextResponse.json({ requests: requests.map(serializeRequest) })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const limit = checkRateLimit(getClientKey(request), RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

    const accountName = requiredString(body.account_name, MAX_NAME_LEN)
    const ownerName = requiredString(body.owner_name, MAX_NAME_LEN)
    const ownerEmail = requiredString(body.owner_email, MAX_EMAIL_LEN)?.toLowerCase()
    const phone = optionalString(body.phone, MAX_PHONE_LEN)
    const notes = optionalString(body.notes, MAX_NOTES_LEN)

    if (!accountName) return NextResponse.json({ error: 'Invalid account_name' }, { status: 400 })
    if (!ownerName) return NextResponse.json({ error: 'Invalid owner_name' }, { status: 400 })
    if (!ownerEmail || !ownerEmail.includes('@')) {
      return NextResponse.json({ error: 'Invalid owner_email' }, { status: 400 })
    }

    const [created] = await db
      .insert(platformAccountRequests)
      .values({
        accountName,
        ownerName,
        ownerEmail,
        phone,
        notes,
      })
      .returning()

    if (!created) {
      return NextResponse.json({ error: 'Failed to create request' }, { status: 500 })
    }

    return NextResponse.json({ request: serializeRequest(created) }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
