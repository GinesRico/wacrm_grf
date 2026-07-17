-- ============================================================
-- 047_platform_admins.sql
-- Dedicated platform administrators, separate from account roles.
-- ============================================================

CREATE TABLE IF NOT EXISTS platform_admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE platform_admins
  DROP CONSTRAINT IF EXISTS platform_admins_email_not_empty,
  DROP CONSTRAINT IF EXISTS platform_admins_email_lowercase;

ALTER TABLE platform_admins
  ADD CONSTRAINT platform_admins_email_not_empty CHECK (length(trim(email)) > 0),
  ADD CONSTRAINT platform_admins_email_lowercase CHECK (email = lower(email));

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_admins_email
  ON platform_admins(email);

CREATE INDEX IF NOT EXISTS idx_platform_admins_user_id
  ON platform_admins(user_id);

ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;

-- Platform APIs use service-role after requirePlatformAdmin().
-- No direct browser RLS policies are exposed.

DROP TRIGGER IF EXISTS set_updated_at ON platform_admins;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON platform_admins
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
