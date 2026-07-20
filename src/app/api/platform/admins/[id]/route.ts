import { NextResponse } from 'next/server'
import { count, eq } from 'drizzle-orm'

import { db } from '@/db/client'
import { platformAdmins } from '@/db/schema'
import { toErrorResponse } from '@/lib/auth/errors'
import { requirePlatformAdmin } from '@/lib/platform/admin'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requirePlatformAdmin()
    const { id } = await params

    const [total] = await db.select({ value: count() }).from(platformAdmins)

    if ((total?.value ?? 0) <= 1) {
      return NextResponse.json({ error: 'Cannot remove the last platform admin' }, { status: 400 })
    }

    const [deleted] = await db
      .delete(platformAdmins)
      .where(eq(platformAdmins.id, id))
      .returning({ id: platformAdmins.id })
    if (!deleted) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
