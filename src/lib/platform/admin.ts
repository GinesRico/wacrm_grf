import { createClient } from '@/lib/supabase/server'
import { ForbiddenError, UnauthorizedError } from '@/lib/auth/account'

export interface PlatformAdminContext {
  supabase: Awaited<ReturnType<typeof createClient>>
  userId: string
  email: string
}

export function platformAdminEmails(): readonly string[] {
  return (process.env.PLATFORM_ADMIN_EMAILS ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
}

export function isPlatformAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false
  return platformAdminEmails().includes(email.trim().toLowerCase())
}

export async function requirePlatformAdmin(): Promise<PlatformAdminContext> {
  const supabase = await createClient()
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()

  if (error || !user) throw new UnauthorizedError()
  if (!isPlatformAdminEmail(user.email)) {
    throw new ForbiddenError('This action requires platform admin access')
  }

  return {
    supabase,
    userId: user.id,
    email: user.email!,
  }
}
