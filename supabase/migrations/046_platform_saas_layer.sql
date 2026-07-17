-- ============================================================
-- 046_platform_saas_layer.sql
-- Shared-database SaaS controls for platform-managed accounts.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'account_status_enum') THEN
    CREATE TYPE account_status_enum AS ENUM ('trial', 'active', 'suspended', 'cancelled');
  END IF;
END $$;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS status account_status_enum NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'starter',
  ADD COLUMN IF NOT EXISTS max_users INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS max_flows INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS max_automations INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS max_whatsapp_lines INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS allow_ai BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS allow_api BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS allow_broadcasts BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;

ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_plan_not_empty,
  DROP CONSTRAINT IF EXISTS accounts_limits_non_negative;

ALTER TABLE accounts
  ADD CONSTRAINT accounts_plan_not_empty CHECK (length(trim(plan)) > 0),
  ADD CONSTRAINT accounts_limits_non_negative CHECK (
    max_users >= 1
    AND max_flows >= 0
    AND max_automations >= 0
    AND max_whatsapp_lines >= 0
  );

CREATE TABLE IF NOT EXISTS platform_account_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE,
  account_name TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'starter',
  status account_status_enum NOT NULL DEFAULT 'active',
  max_users INTEGER NOT NULL DEFAULT 3,
  max_flows INTEGER NOT NULL DEFAULT 5,
  max_automations INTEGER NOT NULL DEFAULT 5,
  max_whatsapp_lines INTEGER NOT NULL DEFAULT 1,
  allow_ai BOOLEAN NOT NULL DEFAULT FALSE,
  allow_api BOOLEAN NOT NULL DEFAULT FALSE,
  allow_broadcasts BOOLEAN NOT NULL DEFAULT TRUE,
  trial_ends_at TIMESTAMPTZ,
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE platform_account_invites
  DROP CONSTRAINT IF EXISTS platform_account_invites_account_name_not_empty,
  DROP CONSTRAINT IF EXISTS platform_account_invites_owner_email_not_empty,
  DROP CONSTRAINT IF EXISTS platform_account_invites_plan_not_empty,
  DROP CONSTRAINT IF EXISTS platform_account_invites_limits_non_negative;

ALTER TABLE platform_account_invites
  ADD CONSTRAINT platform_account_invites_account_name_not_empty CHECK (length(trim(account_name)) > 0),
  ADD CONSTRAINT platform_account_invites_owner_email_not_empty CHECK (length(trim(owner_email)) > 0),
  ADD CONSTRAINT platform_account_invites_plan_not_empty CHECK (length(trim(plan)) > 0),
  ADD CONSTRAINT platform_account_invites_limits_non_negative CHECK (
    max_users >= 1
    AND max_flows >= 0
    AND max_automations >= 0
    AND max_whatsapp_lines >= 0
  );

CREATE INDEX IF NOT EXISTS idx_platform_account_invites_pending
  ON platform_account_invites(expires_at)
  WHERE accepted_at IS NULL;

ALTER TABLE platform_account_invites ENABLE ROW LEVEL SECURITY;

-- Platform routes use the service-role client after an explicit
-- PLATFORM_ADMIN_EMAILS check. No browser/session RLS policies are
-- exposed for this table.

-- Flows and automations are now settings-class surfaces: readable by
-- members, mutable only by account admins+.
DROP POLICY IF EXISTS automations_insert ON automations;
DROP POLICY IF EXISTS automations_update ON automations;
DROP POLICY IF EXISTS automations_delete ON automations;
CREATE POLICY automations_insert ON automations FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY automations_update ON automations FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY automations_delete ON automations FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS automation_steps_modify ON automation_steps;
CREATE POLICY automation_steps_modify ON automation_steps FOR ALL USING (
  EXISTS (SELECT 1 FROM automations a WHERE a.id = automation_steps.automation_id AND is_account_member(a.account_id, 'admin'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM automations a WHERE a.id = automation_steps.automation_id AND is_account_member(a.account_id, 'admin'))
);

DROP POLICY IF EXISTS flows_insert ON flows;
DROP POLICY IF EXISTS flows_update ON flows;
DROP POLICY IF EXISTS flows_delete ON flows;
CREATE POLICY flows_insert ON flows FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY flows_update ON flows FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY flows_delete ON flows FOR DELETE USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS flow_nodes_modify ON flow_nodes;
CREATE POLICY flow_nodes_modify ON flow_nodes FOR ALL USING (
  EXISTS (SELECT 1 FROM flows f WHERE f.id = flow_nodes.flow_id AND is_account_member(f.account_id, 'admin'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM flows f WHERE f.id = flow_nodes.flow_id AND is_account_member(f.account_id, 'admin'))
);
