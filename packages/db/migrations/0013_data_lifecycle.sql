BEGIN;
ALTER TABLE delivery_attempts ADD COLUMN anonymized_at timestamptz;
ALTER TABLE chat_messages ADD COLUMN reply_owner_id text;
UPDATE chat_messages a SET reply_owner_id=q.owner_id
FROM (SELECT guild_id,channel_id,min(author_id) AS owner_id FROM chat_messages WHERE role='user' GROUP BY guild_id,channel_id HAVING count(DISTINCT author_id)=1) q
WHERE a.role='assistant' AND a.guild_id=q.guild_id AND a.channel_id=q.channel_id;

CREATE TABLE privacy_requests (
 id uuid PRIMARY KEY, guild_id text NOT NULL, requester_ref text NOT NULL,
 target_kind text NOT NULL CHECK(target_kind IN ('user','item','source')),
 target_id text, target_ref text NOT NULL,
 state text NOT NULL DEFAULT 'preview' CHECK(state IN ('preview','confirmed','blocked','files_pending','waiting_backups','completed')),
 plan jsonb NOT NULL DEFAULT '{}', file_actions jsonb NOT NULL DEFAULT '[]',
 backup_snapshot jsonb NOT NULL DEFAULT '[]', error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 confirmed_at timestamptz, processed_at timestamptz, backup_deadline timestamptz
);
CREATE INDEX privacy_requests_work_idx ON privacy_requests(state,created_at);
CREATE TABLE privacy_event_tombstones (
 source_id uuid NOT NULL, event_ref text NOT NULL, raw_id uuid NOT NULL,
 PRIMARY KEY(source_id,event_ref)
);

ALTER TABLE chatops_events DROP CONSTRAINT chatops_events_run_id_fkey;
ALTER TABLE chatops_events ADD CONSTRAINT chatops_events_run_id_fkey FOREIGN KEY(run_id) REFERENCES chatops_runs(id) ON DELETE CASCADE;
ALTER TABLE chatops_memory_events DROP CONSTRAINT chatops_memory_events_memory_id_fkey;
ALTER TABLE chatops_memory_events ADD CONSTRAINT chatops_memory_events_memory_id_fkey FOREIGN KEY(memory_id) REFERENCES chatops_memory(id) ON DELETE CASCADE;

CREATE FUNCTION privacy_parent_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='chatops_runs' THEN
  IF OLD.created_at < now()-interval '1 year' AND OLD.updated_at < now()-interval '1 year' AND OLD.phase IN ('verified','failed','cancelled','interrupted','reported_done') THEN RETURN OLD; END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM privacy_requests WHERE id::text=current_setting('rapi.privacy_request',true)
   AND target_kind='user' AND target_id=OLD.owner_id AND confirmed_at IS NOT NULL AND state IN ('confirmed','blocked')) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'record deletion requires retention eligibility or a confirmed owner request';
END $$;
CREATE TRIGGER privacy_run_delete BEFORE DELETE ON chatops_runs FOR EACH ROW EXECUTE FUNCTION privacy_parent_delete_guard();
CREATE TRIGGER privacy_memory_delete BEFORE DELETE ON chatops_memory FOR EACH ROW EXECUTE FUNCTION privacy_parent_delete_guard();

CREATE OR REPLACE FUNCTION chatops_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF TG_TABLE_NAME='chatops_events' THEN
   IF NOT EXISTS(SELECT 1 FROM chatops_runs WHERE id=OLD.run_id) THEN RETURN OLD; END IF;
  END IF;
  IF TG_TABLE_NAME='chatops_memory_events' THEN
   IF OLD.created_at < now()-interval '1 year' OR NOT EXISTS(SELECT 1 FROM chatops_memory WHERE id=OLD.memory_id) THEN RETURN OLD; END IF;
  END IF;
 END IF;
 RAISE EXCEPTION 'append-only record';
END $$;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON privacy_requests,privacy_event_tombstones FROM anon; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON privacy_requests,privacy_event_tombstones FROM authenticated; END IF;
END $$;
INSERT INTO schema_migrations(name) VALUES('0013_data_lifecycle.sql');
COMMIT;
