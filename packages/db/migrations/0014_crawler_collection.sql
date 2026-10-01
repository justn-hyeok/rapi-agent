BEGIN;
CREATE TABLE crawler_collection_jobs (
 id uuid PRIMARY KEY,
 source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
 crawler_job_id uuid,
 request jsonb NOT NULL,
 policy_hash text NOT NULL,
 cursor_value text,
 state text NOT NULL DEFAULT 'pending',
 failure_code text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX crawler_collection_one_active_source ON crawler_collection_jobs(source_id)
 WHERE state NOT IN ('succeeded','partial','failed','cancelled','expired','revoked');
CREATE TABLE crawler_collection_receipts (
 collection_id uuid NOT NULL REFERENCES crawler_collection_jobs(id) ON DELETE CASCADE,
 crawler_item_id uuid NOT NULL,
 source_item_id uuid,
 PRIMARY KEY(collection_id,crawler_item_id)
);
-- Preserve remote cleanup work even when privacy deletion cascades local bindings.
CREATE TABLE crawler_collection_revocations (
 crawler_job_id uuid PRIMARY KEY,
 requested_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION enqueue_crawler_source_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO crawler_collection_revocations(crawler_job_id)
 SELECT crawler_job_id FROM crawler_collection_jobs WHERE source_id=OLD.id AND crawler_job_id IS NOT NULL
 ON CONFLICT DO NOTHING;
 RETURN OLD;
END $$;
CREATE TRIGGER crawler_source_delete BEFORE DELETE ON sources
 FOR EACH ROW EXECUTE FUNCTION enqueue_crawler_source_revocation();
ALTER TABLE crawler_collection_revocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE crawler_collection_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE crawler_collection_receipts ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON crawler_collection_jobs,crawler_collection_receipts,crawler_collection_revocations FROM anon; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON crawler_collection_jobs,crawler_collection_receipts,crawler_collection_revocations FROM authenticated; END IF;
END $$;
INSERT INTO schema_migrations(name) VALUES('0014_crawler_collection.sql');
COMMIT;
