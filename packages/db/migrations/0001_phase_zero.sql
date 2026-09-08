BEGIN;

CREATE TABLE schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TYPE delivery_state AS ENUM ('draft','ready','sending','partially_failed','retrying','delivered','failed','dead_letter');
CREATE TYPE task_state AS ENUM ('draft','awaiting_approval','approved','dispatched','running','blocked','completed','failed','rejected','expired','cancelled');

CREATE TABLE sources (
  id uuid PRIMARY KEY, kind text NOT NULL, locator text NOT NULL, auth_ref text,
  collection_policy jsonb NOT NULL DEFAULT '{}'::jsonb, state text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, locator)
);
CREATE TABLE raw_events (
  id uuid PRIMARY KEY, source_id uuid NOT NULL REFERENCES sources(id), external_event_id text,
  canonical_payload_hash text NOT NULL, payload jsonb NOT NULL, collected_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX raw_events_external_id_unique ON raw_events (source_id, external_event_id) WHERE external_event_id IS NOT NULL;
CREATE UNIQUE INDEX raw_events_payload_hash_unique ON raw_events (source_id, canonical_payload_hash) WHERE external_event_id IS NULL;

CREATE TABLE task_requests (
  id uuid PRIMARY KEY, requester_id text NOT NULL, current_revision integer NOT NULL DEFAULT 1,
  state task_state NOT NULL DEFAULT 'draft', risk_level text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE task_revisions (
  task_id uuid NOT NULL REFERENCES task_requests(id), revision integer NOT NULL,
  specification jsonb NOT NULL, change_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, revision)
);
CREATE TABLE approvals (
  id uuid PRIMARY KEY, task_id uuid NOT NULL, task_revision integer NOT NULL,
  approver_id text NOT NULL, permission_scope jsonb NOT NULL, decision text NOT NULL,
  expires_at timestamptz NOT NULL, discord_message_ref text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (task_id, task_revision) REFERENCES task_revisions(task_id, revision)
);
CREATE TABLE execution_attempts (
  id uuid PRIMARY KEY, task_id uuid NOT NULL, task_revision integer NOT NULL,
  executor text NOT NULL, idempotency_key text NOT NULL UNIQUE, receipt_id text,
  state task_state NOT NULL DEFAULT 'dispatched', state_version integer NOT NULL DEFAULT 0,
  result jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (task_id, task_revision) REFERENCES task_revisions(task_id, revision),
  UNIQUE (executor, receipt_id)
);

INSERT INTO schema_migrations (name) VALUES ('0001_phase_zero.sql');

COMMIT;
