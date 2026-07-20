import { NextResponse } from 'next/server'
import { asc, eq } from 'drizzle-orm'

import { db } from '@/db/client'
import { authUser, platformAdmins } from '@/db/schema'
import { toErrorResponse } from '@/lib/auth/errors'
import { requirePlatformAdmin } from '@/lib/platform/admin'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function serializeAdmin(admin: typeof platformAdmins.$inferSelect) {
  return {
    id: admin.id,
    email: admin.email,
    user_id: admin.userId,
    created_at: admin.createdAt.toISOString(),
  }
}

export async function GET() {
  try {
    await requirePlatformAdmin()

    const admins = await db
      .select()
      .from(platformAdmins)
      .orderBy(asc(platformAdmins.createdAt))

    return NextResponse.json({ admins: admins.map(serializeAdmin) })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requirePlatformAdmin()
    const body = (await request.json().catch(() => null)) as { email?: unknown } | null
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''

    if (!EMAIL_RE.test(email)) {
      return NextResponse.json({ error: 'Invalid email' }, { status: 400 })
    }

    const [user] = await db
      .select({ id: authUser.id })
      .from(authUser)
      .where(eq(authUser.email, email))
      .limit(1)

    const [admin] = await db
      .insert(platformAdmins)
      .values({
        email,
        userId: user?.id ?? null,
        createdByUserId: ctx.userId,
      })
      .onConflictDoUpdate({
        target: platformAdmins.email,
        set: {
          userId: user?.id ?? null,
          updatedAt: new Date(),
        },
      })
      .returning()

    if (!admin) {
      return NextResponse.json({ error: 'Failed to save platform admin' }, { status: 500 })
    }

    return NextResponse.json({ admin: serializeAdmin(admin) }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
