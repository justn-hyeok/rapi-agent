BEGIN;
-- Phase-0 learner DM experiment: opt-in subscriptions, owner-approved issues,
-- per-recipient delivery results, tracked clicks and counted replies.
-- Replies keep only who and when, never message content.
CREATE TABLE learner_subscriptions (
 user_id text PRIMARY KEY,
 guild_id text,
 cadence text NOT NULL CHECK (cadence IN ('daily','weekly')),
 opted_in_at timestamptz NOT NULL DEFAULT now(),
 opted_out_at timestamptz,
 email_interest boolean,
 email_asked_at timestamptz
);
CREATE TABLE learner_issues (
 id uuid PRIMARY KEY,
 cadence text NOT NULL CHECK (cadence IN ('daily','weekly')),
 period_key text NOT NULL,
 state text NOT NULL CHECK (state IN ('empty','pending','sending','sent','skipped')),
 window_start timestamptz NOT NULL,
 window_end timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 preview_sent_at timestamptz,
 decided_by text,
 decided_at timestamptz,
 sent_at timestamptz,
 UNIQUE (cadence, period_key)
);
CREATE TABLE learner_issue_items (
 id uuid PRIMARY KEY,
 issue_id uuid NOT NULL REFERENCES learner_issues(id),
 position integer NOT NULL,
 section text NOT NULL CHECK (section IN ('core','tools')),
 post_key text NOT NULL,
 title text NOT NULL,
 summary text NOT NULL DEFAULT '',
 url text NOT NULL CHECK (url LIKE 'https://%')
);
CREATE INDEX learner_issue_items_issue_idx ON learner_issue_items(issue_id, position);
CREATE TABLE learner_deliveries (
 issue_id uuid NOT NULL REFERENCES learner_issues(id),
 user_id text NOT NULL,
 state text NOT NULL CHECK (state IN ('sent','failed')),
 error text,
 provider_id text,
 at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (issue_id, user_id)
);
CREATE TABLE learner_clicks (
 id bigserial PRIMARY KEY,
 item_id uuid NOT NULL REFERENCES learner_issue_items(id),
 user_id text NOT NULL,
 at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX learner_clicks_at_idx ON learner_clicks(at);
CREATE TABLE learner_replies (
 id bigserial PRIMARY KEY,
 user_id text NOT NULL,
 at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX learner_replies_at_idx ON learner_replies(at);
CREATE TABLE learner_reports (
 period_key text PRIMARY KEY,
 sent_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations(name) VALUES('0019_learner_experiment.sql');
COMMIT;
