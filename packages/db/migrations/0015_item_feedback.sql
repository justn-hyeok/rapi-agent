BEGIN;
-- The owner's reactions to briefing items: the signal for personal ranking.
CREATE TABLE item_feedback (
 item_id uuid NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
 owner_id text NOT NULL,
 kind text NOT NULL CHECK (kind IN ('up','down','save','open')),
 batch_id uuid REFERENCES delivery_batches(id) ON DELETE SET NULL,
 active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (item_id, owner_id, kind)
);
CREATE INDEX item_feedback_owner_idx ON item_feedback(owner_id, kind, updated_at DESC) WHERE active;
INSERT INTO schema_migrations(name) VALUES('0015_item_feedback.sql');
COMMIT;
