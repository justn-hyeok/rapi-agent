BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM privacy_requests) OR EXISTS(SELECT 1 FROM privacy_event_tombstones)
 OR EXISTS(SELECT 1 FROM delivery_attempts WHERE anonymized_at IS NOT NULL) THEN
  RAISE EXCEPTION 'data lifecycle has executed; schema rollback requires a new recovery plan';
 END IF;
END $$;
DROP TRIGGER privacy_run_delete ON chatops_runs;
DROP TRIGGER privacy_memory_delete ON chatops_memory;
DROP FUNCTION privacy_parent_delete_guard();
CREATE OR REPLACE FUNCTION chatops_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'append-only record'; END $$;
ALTER TABLE chatops_events DROP CONSTRAINT chatops_events_run_id_fkey;
ALTER TABLE chatops_events ADD CONSTRAINT chatops_events_run_id_fkey FOREIGN KEY(run_id) REFERENCES chatops_runs(id);
ALTER TABLE chatops_memory_events DROP CONSTRAINT chatops_memory_events_memory_id_fkey;
ALTER TABLE chatops_memory_events ADD CONSTRAINT chatops_memory_events_memory_id_fkey FOREIGN KEY(memory_id) REFERENCES chatops_memory(id);
ALTER TABLE delivery_attempts DROP COLUMN anonymized_at;
ALTER TABLE chat_messages DROP COLUMN reply_owner_id;
DROP TABLE privacy_requests,privacy_event_tombstones;
DELETE FROM schema_migrations WHERE name='0013_data_lifecycle.sql';
COMMIT;
