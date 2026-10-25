BEGIN;
-- Web accounts keyed by Discord user id (Discord OAuth2, scope identify only).
-- The role is never stored; it is computed from the Discord allowlists on each request.
CREATE TABLE web_accounts (
 discord_user_id text PRIMARY KEY CHECK (discord_user_id ~ '^[0-9]{15,20}$'),
 username text NOT NULL,
 display_name text,
 created_at timestamptz NOT NULL DEFAULT now(),
 last_login_at timestamptz NOT NULL DEFAULT now()
);
-- Only the SHA-256 of the session cookie value is stored.
CREATE TABLE web_sessions (
 id_hash text PRIMARY KEY,
 discord_user_id text NOT NULL REFERENCES web_accounts(discord_user_id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL
);
CREATE INDEX web_sessions_user_idx ON web_sessions(discord_user_id);
CREATE INDEX web_sessions_expires_idx ON web_sessions(expires_at);
INSERT INTO schema_migrations(name) VALUES('0021_web_accounts.sql');
COMMIT;
