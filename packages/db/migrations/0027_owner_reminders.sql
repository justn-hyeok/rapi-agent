BEGIN;
-- One reminder DM per undecided learner preview / stalled blog PR (no repeats).
ALTER TABLE learner_issues ADD COLUMN preview_reminded_at timestamptz;
ALTER TABLE blog_posts ADD COLUMN approved_reminded_at timestamptz;
INSERT INTO schema_migrations(name) VALUES('0027_owner_reminders.sql');
COMMIT;
