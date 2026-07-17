import { NextResponse } from 'next/server'

import { toErrorResponse } from '@/lib/auth/account'
import { requirePlatformAdmin } from '@/lib/platform/admin'
import { supabaseAdmin } from '@/lib/supabase/admin'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function GET() {
  try {
    await requirePlatformAdmin()
    const { data, error } = await supabaseAdmin()
      .from('platform_admins')
      .select('id, email, user_id, created_at')
      .order('created_at', { ascending: true })

    if (error) {
      console.error('[GET /api/platform/admins] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load platform admins' }, { status: 500 })
    }

    return NextResponse.json({ admins: data ?? [] })
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

    const admin = supabaseAdmin()
    const { data: users, error: usersError } = await admin.auth.admin.listUsers()
    if (usersError) {
      console.error('[POST /api/platform/admins] list users error:', usersError)
      return NextResponse.json({ error: 'Failed to resolve auth user' }, { status: 500 })
    }

    const user = users.users.find((item) => item.email?.toLowerCase() === email)
    const { data, error } = await admin
      .from('platform_admins')
      .upsert(
        {
          email,
          user_id: user?.id ?? null,
          created_by_user_id: ctx.userId,
        },
        { onConflict: 'email' },
      )
      .select('id, email, user_id, created_at')
      .single()

    if (error || !data) {
      console.error('[POST /api/platform/admins] upsert error:', error)
      return NextResponse.json({ error: 'Failed to save platform admin' }, { status: 500 })
    }

    return NextResponse.json({ admin: data }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
