DELETE FROM archive_documents WHERE kind='source';
ALTER TABLE archive_documents DROP CONSTRAINT IF EXISTS archive_documents_kind_check;
ALTER TABLE archive_documents ADD CONSTRAINT archive_documents_kind_check
  CHECK (kind IN ('learner','community','blog'));
