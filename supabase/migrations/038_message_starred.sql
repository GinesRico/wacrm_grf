-- 038_message_starred.sql
-- Lets agents mark individual chat messages as starred from the inbox.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS is_starred BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_messages_starred
  ON messages(conversation_id, is_starred)
  WHERE is_starred = true;
