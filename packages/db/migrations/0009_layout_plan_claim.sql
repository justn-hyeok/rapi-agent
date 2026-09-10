BEGIN;

ALTER TABLE discord_layout_plans
  ADD COLUMN IF NOT EXISTS apply_started_at timestamptz;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON discord_layout_plans FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON discord_layout_plans FROM authenticated;
  END IF;
END $$;

INSERT INTO schema_migrations (name) VALUES ('0009_layout_plan_claim.sql')
ON CONFLICT DO NOTHING;

COMMIT;
