BEGIN;
-- Knowledge graph over the public archive: entities, typed edges and mentions,
-- all derived from archive_documents. Rows cascade away with their document.
-- Traversal is a recursive CTE; a graph database can replace this behind GraphStore.
CREATE TABLE IF NOT EXISTS graph_entities (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('tool','company','model','concept','repo','person','other')),
  aliases text[] NOT NULL DEFAULT '{}',
  alias_slugs text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS graph_entities_alias_slugs ON graph_entities USING gin (alias_slugs);
CREATE TABLE IF NOT EXISTS graph_mentions (
  entity_id uuid NOT NULL REFERENCES graph_entities(id) ON DELETE CASCADE,
  document_key text NOT NULL REFERENCES archive_documents(key) ON DELETE CASCADE,
  PRIMARY KEY (entity_id, document_key)
);
CREATE INDEX IF NOT EXISTS graph_mentions_document ON graph_mentions(document_key);
CREATE TABLE IF NOT EXISTS graph_edges (
  source_id uuid NOT NULL REFERENCES graph_entities(id) ON DELETE CASCADE,
  relation text NOT NULL CHECK (char_length(relation) BETWEEN 1 AND 60),
  target_id uuid NOT NULL REFERENCES graph_entities(id) ON DELETE CASCADE,
  document_key text NOT NULL REFERENCES archive_documents(key) ON DELETE CASCADE,
  PRIMARY KEY (source_id, relation, target_id, document_key),
  CHECK (source_id <> target_id)
);
CREATE INDEX IF NOT EXISTS graph_edges_target ON graph_edges(target_id);
CREATE INDEX IF NOT EXISTS graph_edges_document ON graph_edges(document_key);
-- Which documents were extracted, from which text, so changed posts are redone.
CREATE TABLE IF NOT EXISTS graph_extractions (
  document_key text PRIMARY KEY REFERENCES archive_documents(key) ON DELETE CASCADE,
  content_hash text NOT NULL,
  model text NOT NULL,
  entity_count integer NOT NULL CHECK (entity_count >= 0),
  extracted_at timestamptz NOT NULL DEFAULT now()
);
-- Runtime access follows grant-runtime.mjs; API roles have no table privileges.
REVOKE ALL ON graph_entities, graph_mentions, graph_edges, graph_extractions FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON graph_entities, graph_mentions, graph_edges, graph_extractions FROM anon;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON graph_entities, graph_mentions, graph_edges, graph_extractions FROM authenticated;
  END IF;
END $$;
INSERT INTO schema_migrations(name) VALUES('0031_knowledge_graph.sql');
COMMIT;
