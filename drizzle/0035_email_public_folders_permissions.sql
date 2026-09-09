ALTER TABLE "email_folders" ALTER COLUMN "mailbox_id" DROP NOT NULL;
ALTER TABLE "email_permissions" ALTER COLUMN "mailbox_id" DROP NOT NULL;

ALTER TABLE "email_folders" DROP CONSTRAINT IF EXISTS "email_folders_kind_check";
ALTER TABLE "email_folders" ADD CONSTRAINT "email_folders_kind_check" CHECK ("email_folders"."kind" in ('inbox', 'sent', 'archive', 'trash', 'custom', 'public'));

CREATE TABLE "email_user_permissions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "mailbox_id" uuid REFERENCES "email_mailboxes"("id") ON DELETE cascade,
  "folder_id" uuid REFERENCES "email_folders"("id") ON DELETE cascade,
  "can_read" boolean DEFAULT true NOT NULL,
  "can_move" boolean DEFAULT false NOT NULL,
  "can_classify" boolean DEFAULT false NOT NULL,
  "can_send" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "idx_email_user_permissions_account_user" ON "email_user_permissions" ("account_id","user_id");
CREATE INDEX "idx_email_user_permissions_target" ON "email_user_permissions" ("mailbox_id","folder_id");

DELETE FROM "email_permissions" p
USING (
  SELECT ctid
  FROM (
    SELECT
      ctid,
      row_number() OVER (
        PARTITION BY "account_id", "department_id", "mailbox_id"
        ORDER BY "created_at" DESC, "id" DESC
      ) AS rn
    FROM "email_permissions"
    WHERE "folder_id" IS NULL AND "mailbox_id" IS NOT NULL
  ) duplicates
  WHERE rn > 1
) duplicates
WHERE p.ctid = duplicates.ctid;

DELETE FROM "email_permissions" p
USING (
  SELECT ctid
  FROM (
    SELECT
      ctid,
      row_number() OVER (
        PARTITION BY "account_id", "department_id", "folder_id"
        ORDER BY "created_at" DESC, "id" DESC
      ) AS rn
    FROM "email_permissions"
    WHERE "folder_id" IS NOT NULL
  ) duplicates
  WHERE rn > 1
) duplicates
WHERE p.ctid = duplicates.ctid;

DELETE FROM "email_folders" f
USING (
  SELECT ctid
  FROM (
    SELECT
      ctid,
      row_number() OVER (
        PARTITION BY "account_id", "slug"
        ORDER BY "created_at" DESC, "id" DESC
      ) AS rn
    FROM "email_folders"
    WHERE "mailbox_id" IS NULL
  ) duplicates
  WHERE rn > 1
) duplicates
WHERE f.ctid = duplicates.ctid;

CREATE UNIQUE INDEX "email_user_permissions_user_mailbox_key" ON "email_user_permissions" ("account_id","user_id","mailbox_id") WHERE "folder_id" IS NULL AND "mailbox_id" IS NOT NULL;
CREATE UNIQUE INDEX "email_user_permissions_user_folder_key" ON "email_user_permissions" ("account_id","user_id","folder_id") WHERE "folder_id" IS NOT NULL;
CREATE UNIQUE INDEX "email_permissions_department_mailbox_key" ON "email_permissions" ("account_id","department_id","mailbox_id") WHERE "folder_id" IS NULL AND "mailbox_id" IS NOT NULL;
CREATE UNIQUE INDEX "email_permissions_department_folder_key" ON "email_permissions" ("account_id","department_id","folder_id") WHERE "folder_id" IS NOT NULL;
CREATE UNIQUE INDEX "email_folders_account_public_slug_key" ON "email_folders" ("account_id","slug") WHERE "mailbox_id" IS NULL;
