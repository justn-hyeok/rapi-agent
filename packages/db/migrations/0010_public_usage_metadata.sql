BEGIN;

ALTER TABLE ai_usage_events
  ADD COLUMN IF NOT EXISTS request_digest text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS model text NOT NULL DEFAULT 'gpt-5.3-codex-spark';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ai_usage_events FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ai_usage_events FROM authenticated;
  END IF;
END $$;

INSERT INTO schema_migrations (name) VALUES ('0010_public_usage_metadata.sql')
ON CONFLICT DO NOTHING;

COMMIT;
