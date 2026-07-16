-- ============================================================
-- 043_integration_apps_arvera_payments.sql
-- Modular account-scoped integrations + Arvera payment links.
-- ============================================================

CREATE TABLE IF NOT EXISTS integration_apps (
  slug        text PRIMARY KEY,
  name        text NOT NULL,
  category    text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO integration_apps (slug, name, category, description)
VALUES (
  'arvera-payments',
  'Pagos Arvera',
  'payments',
  'Create Redsys payment links through the Arvera payments API.'
)
ON CONFLICT (slug) DO UPDATE
SET name = EXCLUDED.name,
    category = EXCLUDED.category,
    description = EXCLUDED.description;

ALTER TABLE integration_apps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS integration_apps_select ON integration_apps;
CREATE POLICY integration_apps_select ON integration_apps FOR SELECT
  USING (true);

CREATE TABLE IF NOT EXISTS integration_connections (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  app_slug              text NOT NULL REFERENCES integration_apps(slug) ON DELETE CASCADE,
  enabled               boolean NOT NULL DEFAULT false,
  encrypted_credentials jsonb NOT NULL DEFAULT '{}'::jsonb,
  config                jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                text NOT NULL DEFAULT 'not_configured'
    CHECK (status IN ('not_configured', 'active', 'disabled', 'error')),
  last_error            text,
  last_checked_at       timestamptz,
  created_by            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, app_slug)
);

CREATE INDEX IF NOT EXISTS idx_integration_connections_account
  ON integration_connections(account_id);

ALTER TABLE integration_connections ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS set_updated_at ON integration_connections;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON integration_connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP POLICY IF EXISTS integration_connections_select ON integration_connections;
CREATE POLICY integration_connections_select ON integration_connections FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS integration_connections_insert ON integration_connections;
CREATE POLICY integration_connections_insert ON integration_connections FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS integration_connections_update ON integration_connections;
CREATE POLICY integration_connections_update ON integration_connections FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS integration_connections_delete ON integration_connections;
CREATE POLICY integration_connections_delete ON integration_connections FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE TABLE IF NOT EXISTS payment_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  provider        text NOT NULL DEFAULT 'arvera-payments',
  amount_cents    integer NOT NULL CHECK (amount_cents > 0),
  currency        text NOT NULL DEFAULT 'EUR',
  concept         text NOT NULL,
  email           text,
  phone           text,
  order_id        text NOT NULL,
  payment_url     text NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'failed', 'expired', 'cancelled')),
  raw_response    jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at  timestamptz,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider, order_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_links_account_created
  ON payment_links(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_links_status
  ON payment_links(account_id, status);
CREATE INDEX IF NOT EXISTS idx_payment_links_contact
  ON payment_links(contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_links_conversation
  ON payment_links(conversation_id) WHERE conversation_id IS NOT NULL;

ALTER TABLE payment_links ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS set_updated_at ON payment_links;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON payment_links
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP POLICY IF EXISTS payment_links_select ON payment_links;
CREATE POLICY payment_links_select ON payment_links FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS payment_links_insert ON payment_links;
CREATE POLICY payment_links_insert ON payment_links FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS payment_links_update ON payment_links;
CREATE POLICY payment_links_update ON payment_links FOR UPDATE
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS payment_links_delete ON payment_links;
CREATE POLICY payment_links_delete ON payment_links FOR DELETE
  USING (is_account_member(account_id, 'admin'));
