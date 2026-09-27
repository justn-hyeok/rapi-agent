BEGIN;

ALTER TABLE delivery_attempts
  DROP CONSTRAINT delivery_attempts_status_check;

ALTER TABLE delivery_attempts
  ADD CONSTRAINT delivery_attempts_status_check
  CHECK (status IN (
    'pending',
    'success',
    'temporary_failure',
    'permanent_failure',
    'uncertain'
  ));

INSERT INTO schema_migrations (name) VALUES ('0012_delivery_uncertain.sql')
ON CONFLICT DO NOTHING;

COMMIT;
