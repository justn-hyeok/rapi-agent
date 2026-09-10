BEGIN;

CREATE TABLE IF NOT EXISTS ai_usage_policies (
  guild_id text PRIMARY KEY,
  user_daily_limit integer NOT NULL DEFAULT 20 CHECK (user_daily_limit > 0),
  user_cooldown_seconds integer NOT NULL DEFAULT 30 CHECK (user_cooldown_seconds >= 0),
  global_daily_limit integer NOT NULL DEFAULT 500 CHECK (global_daily_limit > 0),
  global_concurrency integer NOT NULL DEFAULT 2 CHECK (global_concurrency > 0),
  timezone text NOT NULL DEFAULT 'Asia/Seoul',
  reset_hour integer NOT NULL DEFAULT 5 CHECK (reset_hour BETWEEN 0 AND 23),
  reset_minute integer NOT NULL DEFAULT 30 CHECK (reset_minute BETWEEN 0 AND 59),
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_usage_events (
  id uuid PRIMARY KEY,
  guild_id text NOT NULL REFERENCES ai_usage_policies(guild_id) ON DELETE CASCADE,
  user_id text NOT NULL,
  request_id text NOT NULL,
  request_digest text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT 'gpt-5.3-codex-spark',
  tier text NOT NULL CHECK (tier IN ('user','staff')),
  state text NOT NULL DEFAULT 'reserved'
    CHECK (state IN ('reserved','started','succeeded','failed','released')),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  reserved_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guild_id, request_id),
  CHECK (window_end > window_start)
);

CREATE INDEX IF NOT EXISTS ai_usage_events_user_window_idx
  ON ai_usage_events (guild_id, user_id, window_start, reserved_at DESC)
  WHERE state <> 'released';
CREATE INDEX IF NOT EXISTS ai_usage_events_active_idx
  ON ai_usage_events (guild_id, state, reserved_at)
  WHERE state IN ('reserved','started');

CREATE TABLE IF NOT EXISTS discord_managed_resources (
  guild_id text NOT NULL,
  resource_type text NOT NULL
    CHECK (resource_type IN ('role','category','channel','message','webhook')),
  resource_key text NOT NULL,
  discord_id text NOT NULL,
  last_applied_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, resource_type, resource_key),
  UNIQUE (guild_id, resource_type, discord_id)
);

CREATE TABLE IF NOT EXISTS discord_layout_plans (
  id uuid PRIMARY KEY,
  guild_id text NOT NULL,
  created_by text NOT NULL,
  layout_digest text NOT NULL,
  snapshot_digest text NOT NULL,
  actions jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  apply_started_at timestamptz,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS discord_layout_plans_pending_idx
  ON discord_layout_plans (guild_id, expires_at DESC)
  WHERE applied_at IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ai_usage_policies, ai_usage_events,
      discord_managed_resources, discord_layout_plans FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ai_usage_policies, ai_usage_events,
      discord_managed_resources, discord_layout_plans FROM authenticated;
  END IF;
END $$;

INSERT INTO schema_migrations (name) VALUES ('0008_community_operations.sql')
ON CONFLICT DO NOTHING;

COMMIT;
