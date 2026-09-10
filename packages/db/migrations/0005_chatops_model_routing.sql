BEGIN;

ALTER TABLE chatops_runs DROP CONSTRAINT IF EXISTS chatops_runs_model_check;
ALTER TABLE chatops_runs
  ADD CONSTRAINT chatops_runs_model_check
  CHECK (model ~ '^[a-z0-9][a-z0-9._-]{1,79}$');
ALTER TABLE chatops_runs
  ALTER COLUMN model SET DEFAULT 'gpt-5.3-codex-spark';

INSERT INTO schema_migrations (name) VALUES ('0005_chatops_model_routing.sql')
ON CONFLICT DO NOTHING;

COMMIT;
