BEGIN;
-- Guilds the bot has been invited to. The owner approves each one; guilds in
-- DISCORD_ALLOWED_GUILD_IDS are allowed without a row.
CREATE TABLE discord_guilds (
 guild_id text PRIMARY KEY,
 name text,
 status text NOT NULL CHECK (status IN ('pending','allowed','rejected','left')),
 requested_at timestamptz NOT NULL DEFAULT now(),
 decided_at timestamptz,
 decided_by text,
 left_at timestamptz
);
-- Curation posts already sent to a guild other than the community guild.
CREATE TABLE community_guild_posts (
 guild_id text NOT NULL,
 key text NOT NULL,
 channel_id text NOT NULL,
 message_id text,
 posted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (guild_id, key)
);
INSERT INTO schema_migrations(name) VALUES('0018_discord_guilds.sql');
COMMIT;
