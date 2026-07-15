ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS is_forwarded BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS forwarded_from_message_id UUID REFERENCES messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_messages_forwarded_from
  ON messages(forwarded_from_message_id)
  WHERE forwarded_from_message_id IS NOT NULL;
