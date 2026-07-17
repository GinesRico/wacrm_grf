import { createClient } from '@/lib/supabase/server'
import { ForbiddenError, UnauthorizedError } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/supabase/admin'

export interface PlatformAdminContext {
  supabase: Awaited<ReturnType<typeof createClient>>
  userId: string
  email: string
}

export function bootstrapPlatformAdminEmails(): readonly string[] {
  return (process.env.PLATFORM_BOOTSTRAP_ADMIN_EMAILS ?? process.env.PLATFORM_ADMIN_EMAILS ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
}

export function isBootstrapPlatformAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false
  return bootstrapPlatformAdminEmails().includes(email.trim().toLowerCase())
}

export async function getPlatformAdminUserIds(): Promise<Set<string>> {
  const admin = supabaseAdmin()
  const { data: platformAdmins, error } = await admin
    .from('platform_admins')
    .select('email, user_id')

  if (error) {
    console.error('[getPlatformAdminUserIds] platform_admins lookup error:', error)
    throw new ForbiddenError('Could not verify platform admin accounts')
  }

  const userIds = new Set<string>()
  const emails = new Set<string>()

  for (const platformAdmin of platformAdmins ?? []) {
    if (platformAdmin.user_id) userIds.add(platformAdmin.user_id)
    if (platformAdmin.email) emails.add(platformAdmin.email.toLowerCase())
  }

  if (emails.size > 0) {
    const { data: profiles, error: profilesError } = await admin
      .from('profiles')
      .select('user_id, email')
      .in('email', Array.from(emails))

    if (profilesError) {
      console.error('[getPlatformAdminUserIds] profiles lookup error:', profilesError)
      throw new ForbiddenError('Could not verify platform admin accounts')
    }

    for (const profile of profiles ?? []) {
      if (profile.user_id) userIds.add(profile.user_id)
    }
  }

  return userIds
}

export async function isPlatformAdmin(email: string, userId: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase()
  const admin = supabaseAdmin()

  const { count, error } = await admin
    .from('platform_admins')
    .select('id', { count: 'exact', head: true })

  if (error) {
    console.error('[isPlatformAdmin] platform_admins count error:', error)
    throw new ForbiddenError('Could not verify platform admin access')
  }

  if ((count ?? 0) === 0 && isBootstrapPlatformAdminEmail(normalized)) {
    return true
  }

  const { data, error: lookupError } = await admin
    .from('platform_admins')
    .select('id')
    .or(`email.eq.${normalized},user_id.eq.${userId}`)
    .maybeSingle()

  if (lookupError) {
    console.error('[isPlatformAdmin] platform_admins lookup error:', lookupError)
    throw new ForbiddenError('Could not verify platform admin access')
  }

  return !!data
}

export async function requirePlatformAdmin(): Promise<PlatformAdminContext> {
  const supabase = await createClient()
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()

  if (error || !user) throw new UnauthorizedError()
  if (!(await isPlatformAdmin(user.email!, user.id))) {
    throw new ForbiddenError('This action requires platform admin access')
  }

  return {
    supabase,
    userId: user.id,
    email: user.email!,
  }
}
