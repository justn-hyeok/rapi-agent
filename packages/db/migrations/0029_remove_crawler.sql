BEGIN;
-- The crawler is removed (docs/decisions.md D-012). Aside sources stay as
-- historical, private data; nothing creates or polls them any more.
UPDATE sources SET state='disabled', updated_at=now() WHERE kind='aside' AND state<>'disabled';

DROP TRIGGER IF EXISTS crawler_source_delete ON sources;
DROP FUNCTION IF EXISTS enqueue_crawler_source_revocation();
DROP TABLE IF EXISTS crawler_collection_receipts;
DROP TABLE IF EXISTS crawler_collection_jobs;
DROP TABLE IF EXISTS crawler_collection_revocations;

-- Polling used to store the whole HTTP response as a raw event with no external
-- id. A feed body that carries a changing value (build time, ...) hashed
-- differently on every poll, so each 5-minute poll added a row. The unique
-- indexes on (source_id, external_event_id) and (source_id, canonical_payload_hash)
-- already prevent true duplicates, so what is removed here are those response
-- snapshots: public-source rows without an external id, shaped like a response
-- ({contentType, body}), that no source_item references. The latest snapshot per
-- source is kept for diagnosis. Aside sources and expired (tombstoned) rows are not touched.
DELETE FROM raw_events re
 USING sources s
 WHERE s.id = re.source_id
   AND s.kind IN ('rss','github')
   AND re.external_event_id IS NULL
   AND re.payload ? 'contentType' AND re.payload ? 'body'
   AND NOT EXISTS (SELECT 1 FROM source_items si WHERE si.raw_event_id = re.id)
   AND re.id <> (
     SELECT r2.id FROM raw_events r2
      WHERE r2.source_id = re.source_id AND r2.external_event_id IS NULL
        AND r2.payload ? 'contentType' AND r2.payload ? 'body'
      ORDER BY r2.collected_at DESC, r2.id DESC LIMIT 1);

-- Anthropic news has no feed; it is read as an HTML list page.
INSERT INTO sources (id, kind, locator, collection_policy)
VALUES (gen_random_uuid(), 'html', 'https://www.anthropic.com/news',
  '{"visibility":"public","html":{"linkPattern":"^/news/[a-z0-9-]+$","exclude":["^/news/(announcements|features|events|partnerships|policy|product|safeguards|security)$"]}}'::jsonb)
ON CONFLICT (kind, locator) DO NOTHING;
INSERT INTO schema_migrations(name) VALUES('0029_remove_crawler.sql');
COMMIT;
