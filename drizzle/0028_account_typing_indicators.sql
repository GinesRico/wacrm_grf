ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "send_typing_indicators" boolean DEFAULT false NOT NULL;
