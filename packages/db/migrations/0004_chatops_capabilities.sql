BEGIN;
CREATE TABLE IF NOT EXISTS chatops_runs (
 id uuid PRIMARY KEY, guild_id text NOT NULL, channel_id text NOT NULL, owner_id text NOT NULL,
 message_id text NOT NULL UNIQUE, route text NOT NULL CHECK(route IN ('execute','loop')),
 phase text NOT NULL DEFAULT 'prepared' CHECK(phase IN ('prepared','accepted','running','reported_done','verified','failed','cancel_requested','cancelled','interrupted')),
 model text NOT NULL CHECK(model='gpt-6-astra'), task_digest text NOT NULL CHECK(task_digest ~ '^[a-f0-9]{64}$'),
 evidence jsonb NOT NULL DEFAULT '{}' CHECK(octet_length(evidence::text)<=20000),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chatops_runs_scope ON chatops_runs(guild_id,channel_id,owner_id,created_at DESC);
CREATE TABLE IF NOT EXISTS chatops_events (
 seq bigserial PRIMARY KEY, run_id uuid NOT NULL REFERENCES chatops_runs(id), phase text NOT NULL,
 task_digest text NOT NULL, evidence jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION chatops_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.phase <> 'prepared' OR NEW.evidence <> '{}'::jsonb THEN RAISE EXCEPTION 'run must start prepared'; END IF;
 ELSE
  IF (NEW.id,NEW.guild_id,NEW.channel_id,NEW.owner_id,NEW.message_id,NEW.route,NEW.model,NEW.task_digest,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.guild_id,OLD.channel_id,OLD.owner_id,OLD.message_id,OLD.route,OLD.model,OLD.task_digest,OLD.created_at) THEN RAISE EXCEPTION 'immutable run binding'; END IF;
  IF NOT (
    (OLD.phase='prepared' AND NEW.phase IN ('accepted','cancel_requested','interrupted','failed')) OR
    (OLD.phase='accepted' AND NEW.phase IN ('running','cancel_requested','interrupted','failed')) OR
    (OLD.phase='running' AND NEW.phase IN ('running','reported_done','failed','cancel_requested','interrupted')) OR
    (OLD.phase='cancel_requested' AND NEW.phase IN ('cancelled','failed','interrupted')) OR
    (OLD.phase='reported_done' AND NEW.phase='verified')
  ) THEN RAISE EXCEPTION 'illegal run transition: % -> %', OLD.phase, NEW.phase; END IF;
  IF NEW.evidence ? 'verification' AND NOT COALESCE(
    NEW.evidence->'verification'->>'taskDigest'=NEW.task_digest AND
    NEW.evidence->'verification'->>'revision'=NEW.evidence->'after'->>'digest' AND
        NEW.evidence->'verification'->>'command'='git diff --check',false)
    THEN RAISE EXCEPTION 'verification requires revision-bound observation'; END IF;
  IF NEW.phase='verified' AND (NEW.evidence IS DISTINCT FROM OLD.evidence OR NOT COALESCE(OLD.evidence->'verification'->>'exitCode'='0',false)) THEN RAISE EXCEPTION 'verified must retain previously observed passing evidence'; END IF;
 END IF;
 NEW.updated_at=now();
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS chatops_run_guard ON chatops_runs;
CREATE TRIGGER chatops_run_guard BEFORE INSERT OR UPDATE ON chatops_runs FOR EACH ROW EXECUTE FUNCTION chatops_run_guard();
CREATE OR REPLACE FUNCTION chatops_run_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO chatops_events(run_id,phase,task_digest,evidence) VALUES(NEW.id,NEW.phase,NEW.task_digest,NEW.evidence);
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS chatops_run_event ON chatops_runs;
CREATE TRIGGER chatops_run_event AFTER INSERT OR UPDATE ON chatops_runs FOR EACH ROW EXECUTE FUNCTION chatops_run_event();
CREATE OR REPLACE FUNCTION chatops_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'append-only record'; END $$;
DROP TRIGGER IF EXISTS chatops_events_immutable ON chatops_events;
CREATE TRIGGER chatops_events_immutable BEFORE UPDATE OR DELETE ON chatops_events FOR EACH ROW EXECUTE FUNCTION chatops_append_only();
CREATE TABLE IF NOT EXISTS chatops_memory (
 id uuid PRIMARY KEY, guild_id text NOT NULL, channel_id text NOT NULL, owner_id text NOT NULL,
 message_id text NOT NULL UNIQUE, content text NOT NULL CHECK(length(content) BETWEEN 1 AND 2000),
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'), revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 state text NOT NULL CHECK(state IN ('candidate','approved','superseded','forgotten')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS chatops_memory_events (
 seq bigserial PRIMARY KEY, memory_id uuid NOT NULL REFERENCES chatops_memory(id), revision integer NOT NULL,
 state text NOT NULL, digest text NOT NULL, message_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION chatops_memory_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'candidate' OR NEW.revision<>1 THEN RAISE EXCEPTION 'memory starts as candidate'; END IF;
 ELSE
  IF (NEW.id,NEW.guild_id,NEW.channel_id,NEW.owner_id,NEW.message_id,NEW.content,NEW.digest,NEW.created_at) IS DISTINCT FROM
     (OLD.id,OLD.guild_id,OLD.channel_id,OLD.owner_id,OLD.message_id,OLD.content,OLD.digest,OLD.created_at) OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'immutable memory binding or stale revision'; END IF;
  IF NOT ((OLD.state='candidate' AND NEW.state IN ('approved','forgotten')) OR (OLD.state='approved' AND NEW.state IN ('superseded','forgotten'))) THEN RAISE EXCEPTION 'illegal memory transition'; END IF;
 END IF;
 NEW.updated_at=now(); RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS chatops_memory_guard ON chatops_memory;
CREATE TRIGGER chatops_memory_guard BEFORE INSERT OR UPDATE ON chatops_memory FOR EACH ROW EXECUTE FUNCTION chatops_memory_guard();
CREATE OR REPLACE FUNCTION chatops_memory_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO chatops_memory_events(memory_id,revision,state,digest,message_id) VALUES(NEW.id,NEW.revision,NEW.state,NEW.digest,NEW.message_id); RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS chatops_memory_event ON chatops_memory;
CREATE TRIGGER chatops_memory_event AFTER INSERT OR UPDATE ON chatops_memory FOR EACH ROW EXECUTE FUNCTION chatops_memory_event();
DROP TRIGGER IF EXISTS chatops_memory_events_immutable ON chatops_memory_events;
CREATE TRIGGER chatops_memory_events_immutable BEFORE UPDATE OR DELETE ON chatops_memory_events FOR EACH ROW EXECUTE FUNCTION chatops_append_only();
INSERT INTO schema_migrations (name) VALUES ('0004_chatops_capabilities.sql')
ON CONFLICT DO NOTHING;
COMMIT;
