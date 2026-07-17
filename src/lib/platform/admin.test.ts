import { afterEach, describe, expect, it } from 'vitest'

import { isPlatformAdminEmail, platformAdminEmails } from './admin'

describe('platform admin email helpers', () => {
  const original = process.env.PLATFORM_ADMIN_EMAILS

  afterEach(() => {
    process.env.PLATFORM_ADMIN_EMAILS = original
  })

  it('parses comma-separated platform admin emails', () => {
    process.env.PLATFORM_ADMIN_EMAILS = ' Admin@Example.com, ops@example.com '
    expect(platformAdminEmails()).toEqual(['admin@example.com', 'ops@example.com'])
  })

  it('matches emails case-insensitively', () => {
    process.env.PLATFORM_ADMIN_EMAILS = 'admin@example.com'
    expect(isPlatformAdminEmail('ADMIN@example.com')).toBe(true)
    expect(isPlatformAdminEmail('agent@example.com')).toBe(false)
  })
})
