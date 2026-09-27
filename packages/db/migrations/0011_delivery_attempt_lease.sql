BEGIN;

ALTER TABLE delivery_attempts
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS delivery_attempts_lease_expires_at_idx
  ON delivery_attempts (lease_expires_at);

INSERT INTO schema_migrations (name) VALUES ('0011_delivery_attempt_lease.sql')
ON CONFLICT DO NOTHING;

COMMIT;
