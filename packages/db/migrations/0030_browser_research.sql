BEGIN;
-- Small owner-only audit table; no cleanup of existing source data.
CREATE TABLE IF NOT EXISTS browser_research_runs (
  id uuid PRIMARY KEY,
  request_id text NOT NULL UNIQUE,
  owner_id text NOT NULL,
  site text NOT NULL CHECK (site IN ('threads','x','reddit')),
  reserved_posts integer NOT NULL CHECK (reserved_posts > 0),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
  audit jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS browser_research_daily ON browser_research_runs(site, created_at);
-- Runtime access follows grant-runtime.mjs; API roles have no table privileges.
-- Do not enable policy-less RLS: the separate runtime role must be able to write.
REVOKE ALL ON browser_research_runs FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON browser_research_runs FROM anon; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON browser_research_runs FROM authenticated; END IF;
END $$;
INSERT INTO schema_migrations(name) VALUES('0030_browser_research.sql');
COMMIT;
