import { afterEach, describe, expect, it } from 'vitest'

import { bootstrapPlatformAdminEmails, isBootstrapPlatformAdminEmail } from './admin'

describe('platform admin email helpers', () => {
  const original = process.env.PLATFORM_ADMIN_EMAILS
  const originalBootstrap = process.env.PLATFORM_BOOTSTRAP_ADMIN_EMAILS

  afterEach(() => {
    process.env.PLATFORM_ADMIN_EMAILS = original
    process.env.PLATFORM_BOOTSTRAP_ADMIN_EMAILS = originalBootstrap
  })

  it('parses comma-separated platform admin emails', () => {
    delete process.env.PLATFORM_BOOTSTRAP_ADMIN_EMAILS
    process.env.PLATFORM_ADMIN_EMAILS = ' Admin@Example.com, ops@example.com '
    expect(bootstrapPlatformAdminEmails()).toEqual(['admin@example.com', 'ops@example.com'])
  })

  it('matches emails case-insensitively', () => {
    delete process.env.PLATFORM_BOOTSTRAP_ADMIN_EMAILS
    process.env.PLATFORM_ADMIN_EMAILS = 'admin@example.com'
    expect(isBootstrapPlatformAdminEmail('ADMIN@example.com')).toBe(true)
    expect(isBootstrapPlatformAdminEmail('agent@example.com')).toBe(false)
  })

  it('prefers the bootstrap env var when present', () => {
    process.env.PLATFORM_ADMIN_EMAILS = 'old@example.com'
    process.env.PLATFORM_BOOTSTRAP_ADMIN_EMAILS = 'new@example.com'
    expect(bootstrapPlatformAdminEmails()).toEqual(['new@example.com'])
  })
})
