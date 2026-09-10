BEGIN;

CREATE TABLE IF NOT EXISTS webhook_connections (
  id uuid PRIMARY KEY,
  guild_id text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('github_inbound','generic_inbound','discord_outbound')),
  source_id uuid REFERENCES sources(id),
  destination_kind text CHECK (destination_kind IN ('discord_channel','discord_webhook')),
  destination_id text,
  event_filters text[] NOT NULL DEFAULT '{}',
  secret_ciphertext text NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','disabled')),
  last_received_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guild_id, name),
  CHECK (
    (kind = 'discord_outbound' AND source_id IS NULL AND destination_kind IS NULL AND destination_id IS NULL)
    OR
    (kind <> 'discord_outbound' AND source_id IS NOT NULL AND destination_kind IS NOT NULL AND destination_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS webhook_receipts (
  id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES webhook_connections(id),
  external_event_id text NOT NULL,
  payload_hash text NOT NULL,
  event_type text NOT NULL,
  source_item_id uuid REFERENCES source_items(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, external_event_id)
);

CREATE INDEX IF NOT EXISTS webhook_connections_guild_idx
  ON webhook_connections (guild_id, created_at DESC);
CREATE INDEX IF NOT EXISTS queue_jobs_claim_idx
  ON queue_jobs (kind, state, available_at, lease_expires_at);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
    REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
    REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;
  END IF;
END $$;

INSERT INTO schema_migrations (name) VALUES ('0006_operations_webhooks.sql')
ON CONFLICT DO NOTHING;

COMMIT;
