BEGIN;
-- Curation channel posts and drafts. Drafts wait for the owner to send them;
-- markers record periodic checks. A key is used at most once in any state.
CREATE TABLE community_posts (
 key text PRIMARY KEY,
 feed text NOT NULL CHECK (feed IN ('projects','setup','stars','ai-blogs','free-tokens')),
 state text NOT NULL DEFAULT 'posted' CHECK (state IN ('draft','posted','discarded','marker')),
 title text,
 embeds jsonb,
 channel_id text,
 message_id text,
 data jsonb NOT NULL DEFAULT '{}'::jsonb,
 posted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX community_posts_feed_idx ON community_posts(feed, posted_at DESC);
CREATE INDEX community_posts_drafts_idx ON community_posts(posted_at DESC) WHERE state = 'draft';
INSERT INTO schema_migrations(name) VALUES('0017_community_posts.sql');
COMMIT;
