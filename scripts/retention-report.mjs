import pg from "pg";

// Read-only inventory: no source content, addresses, task specifications, or
// authentication material are written to the report. Applying destructive
// content expiry requires a separate reviewed executor and publication plan.
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  query_timeout: 30_000,
});
try {
  await client.connect();
  await client.query("BEGIN READ ONLY");
  const result = await client.query(`
    WITH raw AS (
      SELECT re.id, re.collected_at,
        CASE WHEN count(si.id) > 0 AND bool_and(si.visibility = 'public') THEN 90 ELSE 30 END AS days
      FROM raw_events re LEFT JOIN source_items si ON si.raw_event_id = re.id
      GROUP BY re.id
    )
    SELECT
      (SELECT count(*)::int FROM raw WHERE collected_at < now() - days * interval '1 day') AS raw_bodies,
      (SELECT count(*)::int FROM source_items WHERE collected_at < now() - CASE WHEN visibility = 'public' THEN interval '90 days' ELSE interval '30 days' END) AS item_bodies,
      (SELECT count(*)::int FROM summaries WHERE created_at < now() - interval '180 days') AS summaries,
      (SELECT count(*)::int FROM classifications WHERE created_at < now() - interval '180 days') AS classifications,
      (SELECT count(*)::int FROM delivery_attempts WHERE created_at < now() - interval '90 days') AS recipient_identifiers,
      (SELECT count(*)::int FROM delivery_batches WHERE created_at < now() - interval '1 year') AS delivery_audit,
      (SELECT count(*)::int FROM task_requests WHERE created_at < now() - interval '1 year') AS task_audit,
      (SELECT count(*)::int FROM mdx_publications mp JOIN delivery_batch_items bi ON bi.batch_id=mp.batch_id JOIN source_items si ON si.id=bi.source_item_id WHERE si.collected_at < now() - CASE WHEN si.visibility = 'public' THEN interval '90 days' ELSE interval '30 days' END) AS publication_links_requiring_withdrawal
  `);
  await client.query("COMMIT");
  process.stdout.write(
    `${JSON.stringify({ mode: "read-only", policy: "2026-09-08", checkedAt: new Date().toISOString(), candidates: result.rows[0], applied: false })}\n`,
  );
} catch {
  process.stderr.write("Retention inventory failed; no expiry applied.\n");
  process.exitCode = 1;
} finally {
  await client.end();
}
