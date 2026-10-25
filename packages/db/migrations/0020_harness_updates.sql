BEGIN;
-- Harness version updates: a detected release is evaluated, offered to the
-- owner, and only a SUPERADMIN button press opens a pin-bump PR.
CREATE TABLE harness_updates (
 id uuid PRIMARY KEY,
 harness text NOT NULL,
 repo text NOT NULL,
 from_version text NOT NULL,
 from_sha256 text NOT NULL,
 to_version text NOT NULL,
 to_sha256 text,
 asset text NOT NULL,
 release_url text NOT NULL,
 release_body text NOT NULL DEFAULT '',
 state text NOT NULL CHECK (state IN ('pending_evaluation','notified','applying','pr_open','merged','reverting','revert_pr_open','reverted','skipped','failed')),
 evaluation jsonb,
 recommendation text CHECK (recommendation IN ('apply','hold')),
 pr_url text,
 pr_branch text,
 revert_pr_url text,
 revert_branch text,
 decided_by text,
 decided_at timestamptz,
 notified_at timestamptz,
 remind_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (harness, to_version)
);
CREATE INDEX harness_updates_state_idx ON harness_updates(state);
CREATE TABLE harness_update_events (
 id bigserial PRIMARY KEY,
 update_id uuid NOT NULL REFERENCES harness_updates(id),
 step text NOT NULL,
 actor text,
 detail jsonb,
 at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX harness_update_events_update_idx ON harness_update_events(update_id, id);
INSERT INTO schema_migrations(name) VALUES('0020_harness_updates.sql');
COMMIT;
