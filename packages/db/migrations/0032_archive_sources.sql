BEGIN;
-- The chatbot archive may also hold titles, short summaries and links of public
-- collected items (kind 'source'); they are re-derived and pruned on every sync.
ALTER TABLE archive_documents DROP CONSTRAINT IF EXISTS archive_documents_kind_check;
ALTER TABLE archive_documents ADD CONSTRAINT archive_documents_kind_check
  CHECK (kind IN ('learner','community','blog','source'));
INSERT INTO schema_migrations(name) VALUES('0032_archive_sources.sql');
COMMIT;
