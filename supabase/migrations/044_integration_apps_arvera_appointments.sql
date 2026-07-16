-- ============================================================
-- 044_integration_apps_arvera_appointments.sql
-- Arvera appointments integration.
-- ============================================================

INSERT INTO integration_apps (slug, name, category, description)
VALUES (
  'arvera-appointments',
  'Citas Arvera',
  'appointments',
  'Send appointment availability and receive appointment events from Citas Arvera.'
)
ON CONFLICT (slug) DO UPDATE
SET name = EXCLUDED.name,
    category = EXCLUDED.category,
    description = EXCLUDED.description;

CREATE TABLE IF NOT EXISTS appointment_availability_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  provider        text NOT NULL DEFAULT 'arvera-appointments',
  date            date NOT NULL,
  end_date        date,
  send_mode       text NOT NULL DEFAULT 'booking_link'
    CHECK (send_mode IN ('booking_link', 'interactive_list')),
  service         text,
  slots           jsonb NOT NULL DEFAULT '[]'::jsonb,
  short_url       text,
  message_text    text NOT NULL,
  raw_response    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_appointment_availability_account_created
  ON appointment_availability_messages(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_appointment_availability_contact
  ON appointment_availability_messages(contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_appointment_availability_conversation
  ON appointment_availability_messages(conversation_id) WHERE conversation_id IS NOT NULL;

ALTER TABLE appointment_availability_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS appointment_availability_select ON appointment_availability_messages;
CREATE POLICY appointment_availability_select ON appointment_availability_messages FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS appointment_availability_insert ON appointment_availability_messages;
CREATE POLICY appointment_availability_insert ON appointment_availability_messages FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS appointment_availability_delete ON appointment_availability_messages;
CREATE POLICY appointment_availability_delete ON appointment_availability_messages FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE TABLE IF NOT EXISTS appointment_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id      uuid REFERENCES contacts(id) ON DELETE SET NULL,
  provider        text NOT NULL DEFAULT 'arvera-appointments',
  external_id     text NOT NULL,
  status          text,
  service         text,
  customer_name   text,
  phone           text,
  email           text,
  start_time      timestamptz,
  end_time        timestamptz,
  cancel_url      text,
  raw_payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider, external_id)
);

CREATE INDEX IF NOT EXISTS idx_appointment_records_account_start
  ON appointment_records(account_id, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_appointment_records_contact
  ON appointment_records(contact_id) WHERE contact_id IS NOT NULL;

ALTER TABLE appointment_records ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS set_updated_at ON appointment_records;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON appointment_records
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP POLICY IF EXISTS appointment_records_select ON appointment_records;
CREATE POLICY appointment_records_select ON appointment_records FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS appointment_records_insert ON appointment_records;
CREATE POLICY appointment_records_insert ON appointment_records FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS appointment_records_update ON appointment_records;
CREATE POLICY appointment_records_update ON appointment_records FOR UPDATE
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS appointment_records_delete ON appointment_records;
CREATE POLICY appointment_records_delete ON appointment_records FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE TABLE IF NOT EXISTS appointment_webhook_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider        text NOT NULL DEFAULT 'arvera-appointments',
  event_type      text NOT NULL,
  external_id     text,
  event_timestamp bigint,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider, event_type, external_id, event_timestamp)
);

CREATE INDEX IF NOT EXISTS idx_appointment_webhook_events_account_created
  ON appointment_webhook_events(account_id, created_at DESC);

ALTER TABLE appointment_webhook_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS appointment_webhook_events_select ON appointment_webhook_events;
CREATE POLICY appointment_webhook_events_select ON appointment_webhook_events FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS appointment_webhook_events_insert ON appointment_webhook_events;
CREATE POLICY appointment_webhook_events_insert ON appointment_webhook_events FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS appointment_webhook_events_delete ON appointment_webhook_events;
CREATE POLICY appointment_webhook_events_delete ON appointment_webhook_events FOR DELETE
  USING (is_account_member(account_id, 'admin'));
