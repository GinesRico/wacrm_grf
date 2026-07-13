-- ============================================================
-- DEPARTMENTS / INBOX QUEUES
-- ============================================================
-- Departments are account-scoped inbox queues. Members can belong to
-- multiple departments, each WhatsApp line has one default department,
-- and conversations can later be moved to another department.

CREATE TABLE IF NOT EXISTS departments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#22c55e',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (account_id, name)
);

CREATE TABLE IF NOT EXISTS department_members (
  department_id UUID NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (department_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_departments_account
  ON departments(account_id);

CREATE INDEX IF NOT EXISTS idx_department_members_account_user
  ON department_members(account_id, user_id);

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES departments(id) ON DELETE SET NULL;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES departments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_whatsapp_config_department
  ON whatsapp_config(department_id);

CREATE INDEX IF NOT EXISTS idx_conversations_department
  ON conversations(department_id);

INSERT INTO departments (account_id, name, color)
SELECT a.id, 'General', '#22c55e'
FROM accounts a
WHERE NOT EXISTS (
  SELECT 1 FROM departments d WHERE d.account_id = a.id
);

INSERT INTO department_members (department_id, account_id, user_id)
SELECT d.id, p.account_id, p.user_id
FROM profiles p
JOIN departments d ON d.account_id = p.account_id AND d.name = 'General'
ON CONFLICT DO NOTHING;

UPDATE whatsapp_config wc
SET department_id = d.id
FROM departments d
WHERE d.account_id = wc.account_id
  AND d.name = 'General'
  AND wc.department_id IS NULL;

UPDATE conversations c
SET department_id = COALESCE(
  (
    SELECT wc.department_id
    FROM whatsapp_config wc
    WHERE wc.id = c.whatsapp_config_id
  ),
  d.id
)
FROM departments d
WHERE d.account_id = c.account_id
  AND d.name = 'General'
  AND c.department_id IS NULL;

ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE department_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS departments_select ON departments;
CREATE POLICY departments_select ON departments FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS departments_insert ON departments;
CREATE POLICY departments_insert ON departments FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS departments_update ON departments;
CREATE POLICY departments_update ON departments FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS departments_delete ON departments;
CREATE POLICY departments_delete ON departments FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS department_members_select ON department_members;
CREATE POLICY department_members_select ON department_members FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS department_members_insert ON department_members;
CREATE POLICY department_members_insert ON department_members FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS department_members_delete ON department_members;
CREATE POLICY department_members_delete ON department_members FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON departments;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON departments
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
