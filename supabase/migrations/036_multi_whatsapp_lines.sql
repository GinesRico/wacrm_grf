-- ============================================================
-- MULTI WHATSAPP LINES
-- ============================================================
-- Previously whatsapp_config was one row per account and conversations
-- implicitly used that row. Multi-line accounts need each conversation
-- to remember the line it belongs to so replies, automations, and
-- inbound webhook-created threads use the correct phone_number_id.

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS label TEXT;

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE whatsapp_config
SET label = COALESCE(NULLIF(label, ''), phone_number_id)
WHERE label IS NULL OR label = '';

-- Allow many WhatsApp numbers per account.
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;

-- Keep a single account from saving the same Meta phone twice.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_config_account_phone_number_id_key'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_account_phone_number_id_key
      UNIQUE (account_id, phone_number_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_whatsapp_config_account_default
  ON whatsapp_config(account_id, is_default);

-- Backfill exactly one default per account, preferring connected rows and
-- then oldest rows. The partial unique index below enforces this going
-- forward.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY account_id
      ORDER BY
        CASE WHEN is_default THEN 0 ELSE 1 END,
        CASE WHEN status = 'connected' THEN 0 ELSE 1 END,
        created_at ASC,
        id ASC
    ) AS rn
  FROM whatsapp_config
)
UPDATE whatsapp_config wc
SET is_default = ranked.rn = 1
FROM ranked
WHERE wc.id = ranked.id;

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_one_default_per_account
  ON whatsapp_config(account_id)
  WHERE is_default;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL;

-- Existing conversations came from the account's former single line.
WITH defaults AS (
  SELECT DISTINCT ON (account_id)
    id,
    account_id
  FROM whatsapp_config
  ORDER BY account_id, is_default DESC, created_at ASC, id ASC
)
UPDATE conversations c
SET whatsapp_config_id = defaults.id
FROM defaults
WHERE c.account_id = defaults.account_id
  AND c.whatsapp_config_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_whatsapp_config
  ON conversations(whatsapp_config_id);

CREATE UNIQUE INDEX IF NOT EXISTS conversations_account_contact_line_key
  ON conversations(account_id, contact_id, whatsapp_config_id)
  WHERE whatsapp_config_id IS NOT NULL;
