BEGIN;
-- Public chatbot: a searchable copy of what Rapi already published (sent learner
-- issues, curation posts, blog posts), and short-lived thread context.
-- Turns expire after 24 hours and are never kept as long-term memory.
CREATE TABLE archive_documents (
 key text PRIMARY KEY,
 kind text NOT NULL CHECK (kind IN ('learner','community','blog')),
 title text NOT NULL,
 summary text NOT NULL DEFAULT '',
 url text NOT NULL CHECK (url LIKE 'https://%'),
 published_at timestamptz NOT NULL,
 search tsvector GENERATED ALWAYS AS (to_tsvector('simple', title || ' ' || summary)) STORED
);
CREATE INDEX archive_documents_search_idx ON archive_documents USING gin (search);
CREATE INDEX archive_documents_published_idx ON archive_documents(published_at DESC);
CREATE TABLE chatbot_turns (
 id bigserial PRIMARY KEY,
 scope_key text NOT NULL,
 user_id text NOT NULL,
 role text NOT NULL CHECK (role IN ('user','assistant')),
 content text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE INDEX chatbot_turns_scope_idx ON chatbot_turns(scope_key, user_id, id DESC);
CREATE INDEX chatbot_turns_expiry_idx ON chatbot_turns(expires_at);
CREATE INDEX chatbot_turns_user_idx ON chatbot_turns(user_id);
INSERT INTO schema_migrations(name) VALUES('0025_chatbot.sql');
COMMIT;
