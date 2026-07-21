INSERT INTO "integration_apps" ("slug", "name", "category", "description")
VALUES
  (
    'arvera-payments',
    'Pagos Arvera',
    'payments',
    'Create Redsys payment links through the Arvera payments API.'
  ),
  (
    'arvera-appointments',
    'Citas Arvera',
    'appointments',
    'Send appointment availability and receive appointment events.'
  )
ON CONFLICT ("slug") DO UPDATE
SET
  "name" = EXCLUDED."name",
  "category" = EXCLUDED."category",
  "description" = EXCLUDED."description";
