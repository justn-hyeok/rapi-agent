// Removes the response snapshots that polling stored before 0029: one raw event
// per poll with no external id, shaped {contentType, body}, that no source item
// references. The newest snapshot per source is kept for diagnosis. Runs online
// in small batches so services keep running; prints a dry run unless --apply.
//
//   node --env-file=.env scripts/cleanup-response-snapshots.mjs [--apply]
import { createRequire } from "node:module";

const pg = createRequire(import.meta.url)("pg");
const apply = process.argv.includes("--apply");
const BATCH = 200;
const say = (line) => process.stdout.write(`${line}\n`);

const CANDIDATES = `
  SELECT re.id
    FROM raw_events re
    JOIN sources s ON s.id = re.source_id
   WHERE s.kind IN ('rss','github','html')
     AND re.external_event_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM source_items si WHERE si.raw_event_id = re.id)
     AND re.id NOT IN (
       SELECT DISTINCT ON (r2.source_id) r2.id
         FROM raw_events r2
        WHERE r2.external_event_id IS NULL
        ORDER BY r2.source_id, r2.collected_at DESC, r2.id DESC)`;

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const { rows } = await client.query(CANDIDATES);
  const ids = rows.map((row) => row.id);
  say(`${ids.length} snapshot candidates`);
  if (!apply) {
    say("dry run; pass --apply to delete");
  } else {
    let deleted = 0;
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      await client.query("BEGIN");
      await client.query(
        "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'",
      );
      // The shape check runs only on this batch, so large bodies are read once.
      const result = await client.query(
        `DELETE FROM raw_events re
          WHERE re.id = ANY($1::uuid[])
            AND re.external_event_id IS NULL
            AND re.payload ? 'contentType' AND re.payload ? 'body'
            AND NOT EXISTS (SELECT 1 FROM source_items si WHERE si.raw_event_id = re.id)`,
        [batch],
      );
      await client.query("COMMIT");
      deleted += result.rowCount ?? 0;
      if ((i / BATCH) % 10 === 0) say(`${deleted}/${ids.length} deleted`);
    }
    say(
      `${deleted} deleted; run VACUUM (ANALYZE) raw_events to reuse the space`,
    );
  }
} finally {
  await client.end();
}
