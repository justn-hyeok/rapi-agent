BEGIN;
-- Email delivery channel for learner issues (off unless EMAIL_ENABLED).
-- One address per learner. Tokens in mail links name the row id, never the address.
CREATE TABLE learner_emails (
 id uuid PRIMARY KEY,
 user_id text NOT NULL UNIQUE,
 email text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 verification_sent_at timestamptz,
 verified_at timestamptz,
 unsubscribed_at timestamptz,
 bounce_state text NOT NULL DEFAULT 'none' CHECK (bounce_state IN ('none','soft','hard','complaint')),
 soft_bounce_count integer NOT NULL DEFAULT 0,
 bounced_at timestamptz
);
CREATE INDEX learner_emails_address_idx ON learner_emails(lower(email));
CREATE TABLE learner_email_deliveries (
 issue_id uuid NOT NULL REFERENCES learner_issues(id),
 email_id uuid NOT NULL REFERENCES learner_emails(id) ON DELETE CASCADE,
 state text NOT NULL CHECK (state IN ('pending','sent','failed')),
 error text,
 provider_id text,
 at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (issue_id, email_id)
);
INSERT INTO schema_migrations(name) VALUES('0023_email_delivery.sql');
COMMIT;
