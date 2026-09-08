BEGIN;

CREATE TABLE source_cursors (
  source_id uuid PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  cursor_value text,
  etag text,
  modified_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  failure_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE source_items (
  id uuid PRIMARY KEY,
  raw_event_id uuid NOT NULL REFERENCES raw_events(id),
  normalizer_version text NOT NULL,
  canonical_url text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  author text,
  published_at timestamptz,
  collected_at timestamptz NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('private', 'unlisted', 'public')),
  content_fingerprint text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (raw_event_id, normalizer_version)
);

CREATE INDEX source_items_url_idx ON source_items (canonical_url);
CREATE INDEX source_items_fingerprint_idx ON source_items (content_fingerprint);
CREATE INDEX source_items_search_idx ON source_items USING gin (to_tsvector('simple', title || ' ' || body));

CREATE TABLE item_relations (
  source_item_id uuid NOT NULL REFERENCES source_items(id),
  related_item_id uuid NOT NULL REFERENCES source_items(id),
  relation text NOT NULL CHECK (relation IN ('duplicate_candidate', 'related')),
  policy_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_item_id, related_item_id, relation)
);

CREATE TABLE classifications (
  id uuid PRIMARY KEY,
  source_item_id uuid NOT NULL REFERENCES source_items(id),
  taxonomy_version text NOT NULL,
  label text NOT NULL,
  score double precision NOT NULL CHECK (score >= 0 AND score <= 1),
  evidence text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_item_id, taxonomy_version, label)
);

CREATE TABLE summaries (
  id uuid PRIMARY KEY,
  purpose text NOT NULL,
  cache_key text NOT NULL UNIQUE,
  model_policy_version text NOT NULL,
  prompt_version text NOT NULL,
  content text NOT NULL,
  evidence_item_ids uuid[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  name text NOT NULL,
  source_ids uuid[] NOT NULL DEFAULT '{}',
  categories text[] NOT NULL DEFAULT '{}',
  include_keywords text[] NOT NULL DEFAULT '{}',
  exclude_keywords text[] NOT NULL DEFAULT '{}',
  cadence text NOT NULL CHECK (cadence IN ('immediate', 'daily', 'weekly')),
  timezone text NOT NULL DEFAULT 'UTC',
  channels jsonb NOT NULL,
  quiet_hours jsonb,
  max_items integer NOT NULL DEFAULT 20 CHECK (max_items > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);

CREATE TABLE delivery_batches (
  id uuid PRIMARY KEY,
  subscription_id uuid NOT NULL REFERENCES subscriptions(id),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  renderer_version text NOT NULL,
  state delivery_state NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, period_start, period_end)
);

CREATE TABLE delivery_batch_items (
  batch_id uuid NOT NULL REFERENCES delivery_batches(id) ON DELETE CASCADE,
  source_item_id uuid NOT NULL REFERENCES source_items(id),
  position integer NOT NULL,
  PRIMARY KEY (batch_id, source_item_id),
  UNIQUE (batch_id, position)
);

CREATE TABLE delivery_attempts (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES delivery_batches(id),
  channel text NOT NULL,
  recipient_id text NOT NULL,
  renderer_version text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('pending', 'success', 'temporary_failure', 'permanent_failure')),
  provider_id text,
  error_message text,
  attempt_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE queue_jobs (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('ready', 'leased', 'done', 'dead_letter')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz,
  last_error text,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE callback_events (
  callback_event_id text PRIMARY KEY,
  execution_attempt_id uuid NOT NULL REFERENCES execution_attempts(id),
  state_version integer NOT NULL,
  payload jsonb NOT NULL,
  applied boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (execution_attempt_id, state_version)
);

CREATE TABLE mdx_publications (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES delivery_batches(id),
  visibility text NOT NULL CHECK (visibility IN ('private', 'unlisted', 'public')),
  file_path text NOT NULL UNIQUE,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (name) VALUES ('0002_mvp.sql');

COMMIT;
