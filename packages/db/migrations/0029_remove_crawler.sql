BEGIN;
-- The crawler is removed (docs/decisions.md D-012). Aside sources stay as
-- historical, private data; nothing creates or polls them any more.
UPDATE sources SET state='disabled', updated_at=now() WHERE kind='aside' AND state<>'disabled';

DROP TRIGGER IF EXISTS crawler_source_delete ON sources;
DROP FUNCTION IF EXISTS enqueue_crawler_source_revocation();
DROP TABLE IF EXISTS crawler_collection_receipts;
DROP TABLE IF EXISTS crawler_collection_jobs;
DROP TABLE IF EXISTS crawler_collection_revocations;

-- Response snapshots that piled up before this release are removed online by
-- scripts/cleanup-response-snapshots.mjs, in small batches, after the deploy.
-- Doing it here held the release switch for minutes on a 3 GB table.

-- Anthropic news has no feed; it is read as an HTML list page.
INSERT INTO sources (id, kind, locator, collection_policy)
VALUES (gen_random_uuid(), 'html', 'https://www.anthropic.com/news',
  '{"visibility":"public","html":{"linkPattern":"^/news/[a-z0-9-]+$","exclude":["^/news/(announcements|features|events|partnerships|policy|product|safeguards|security)$"]}}'::jsonb)
ON CONFLICT (kind, locator) DO NOTHING;
INSERT INTO schema_migrations(name) VALUES('0029_remove_crawler.sql');
COMMIT;
