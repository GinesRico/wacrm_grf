import { NextResponse } from 'next/server'

import { toErrorResponse } from '@/lib/auth/account'
import { requirePlatformAdmin } from '@/lib/platform/admin'
import { supabaseAdmin } from '@/lib/supabase/admin'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requirePlatformAdmin()
    const { id } = await params
    const admin = supabaseAdmin()

    const { count, error: countError } = await admin
      .from('platform_admins')
      .select('id', { count: 'exact', head: true })

    if (countError) {
      console.error('[DELETE /api/platform/admins/[id]] count error:', countError)
      return NextResponse.json({ error: 'Failed to verify platform admins' }, { status: 500 })
    }

    if ((count ?? 0) <= 1) {
      return NextResponse.json({ error: 'Cannot remove the last platform admin' }, { status: 400 })
    }

    const { data, error } = await admin
      .from('platform_admins')
      .delete()
      .eq('id', id)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[DELETE /api/platform/admins/[id]] delete error:', error)
      return NextResponse.json({ error: 'Failed to delete platform admin' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
