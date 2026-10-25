BEGIN;
-- GitHub App on the owner's repos. The bot verifies a webhook and queues it
-- here; the ChatOps process claims it and runs it through the same engine and
-- run records as Discord.
CREATE TABLE github_deliveries (
 delivery_id text PRIMARY KEY,
 event text NOT NULL,
 repo text NOT NULL,
 request jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','done','failed')),
 received_at timestamptz NOT NULL DEFAULT now(),
 claimed_at timestamptz
);
CREATE INDEX github_deliveries_pending_idx ON github_deliveries(received_at) WHERE state = 'pending';
CREATE TABLE github_run_targets (
 run_id uuid PRIMARY KEY REFERENCES chatops_runs(id),
 source_id text NOT NULL,
 repo text NOT NULL,
 issue_number integer NOT NULL,
 pr_url text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE github_report_claims (
 week_key text PRIMARY KEY,
 claimed_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations(name) VALUES('0024_github_app.sql');
COMMIT;
