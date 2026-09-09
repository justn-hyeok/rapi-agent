BEGIN;

CREATE TABLE chat_channels (
  guild_id text NOT NULL,
  channel_id text PRIMARY KEY,
  enabled_by text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chat_messages (
  id uuid PRIMARY KEY,
  guild_id text NOT NULL,
  channel_id text NOT NULL,
  discord_message_id text UNIQUE,
  author_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX chat_messages_context_idx
  ON chat_messages (channel_id, created_at DESC);

COMMIT;
