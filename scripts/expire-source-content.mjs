import { pathToFileURL } from "node:url";
import pg from "pg";
import { basename } from "node:path";
import { recordWithdrawals } from "./blog-withdrawals.mjs";
import { lstat, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";

async function saveStatus(file, state, result) {
  if (!file) return;
  let previous = {};
  try {
    previous = JSON.parse(await readFile(file, "utf8"));
  } catch {
    /* The first maintenance run has no previous status. */
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ ...previous, state, ...(state === "success" ? { lastSuccessAt: new Date().toISOString(), result } : { lastFailureAt: new Date().toISOString() }) })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

// Prepare/apply only the source-body policy. Published history is a separate
// product decision. Unknown history handling fails before any database write.
export async function expireSourceContent(
  client,
  { apply = false, publishedHistory, withdrawalsFile, now = new Date() } = {},
) {
  if (!Number.isFinite(now.getTime()))
    throw new Error("Invalid retention clock");
  await client.query(apply ? "BEGIN" : "BEGIN READ ONLY");
  try {
    if (apply) {
      await client.query(
        "SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'",
      );
      await client.query("SELECT pg_advisory_xact_lock(731552024)");
      await client.query(
        "LOCK TABLE raw_events,source_items,delivery_batches,delivery_batch_items,mdx_publications,summaries,classifications IN EXCLUSIVE MODE",
      );
    }
    const items = await client.query(
      `
      SELECT si.id, si.raw_event_id,
        EXISTS(SELECT 1 FROM delivery_batch_items bi JOIN mdx_publications mp ON mp.batch_id=bi.batch_id WHERE bi.source_item_id=si.id AND mp.visibility='public') AS published,
        EXISTS(SELECT 1 FROM delivery_batch_items bi JOIN delivery_batches b ON b.id=bi.batch_id WHERE bi.source_item_id=si.id AND b.state NOT IN ('delivered','failed','dead_letter')) AS pending
      FROM source_items si
      WHERE si.metadata->>'retentionExpired' IS DISTINCT FROM 'true'
        AND si.collected_at < $1::timestamptz - CASE WHEN si.visibility='public' THEN interval '90 days' ELSE interval '30 days' END
      ORDER BY si.id`,
      [now],
    );
    const eligible = items.rows.filter((item) => !item.pending);
    const published = eligible.filter((item) => item.published).length;
    const report = {
      mode: apply ? "apply" : "plan",
      checkedAt: now.toISOString(),
      expiredItems: eligible.length,
      pendingItemsDeferred: items.rows.length - eligible.length,
      publishedItems: published,
      applied: false,
    };
    if (!apply) {
      await client.query("COMMIT");
      return report;
    }
    if (published && !["preserve", "withdraw"].includes(publishedHistory))
      throw new Error(
        "Published content handling must be resolved before expiry",
      );
    const ids = eligible.map((item) => item.id);
    let withdrawn = 0;
    if (publishedHistory === "withdraw") {
      const publications = await client.query(
        `SELECT id,file_path FROM mdx_publications WHERE visibility='public' AND batch_id IN (SELECT batch_id FROM delivery_batch_items WHERE source_item_id=ANY($1::uuid[]))`,
        [ids],
      );
      const slugs = publications.rows.map((publication) => {
        const name = basename(publication.file_path);
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.mdx$/.test(name))
          throw new Error("Invalid publication filename");
        return name.slice(0, -4);
      });
      await recordWithdrawals(withdrawalsFile, slugs);
      const changed = await client.query(
        "UPDATE mdx_publications SET visibility='private' WHERE id=ANY($1::uuid[]) RETURNING id",
        [publications.rows.map((publication) => publication.id)],
      );
      withdrawn = changed.rowCount;
    }
    const raw = await client.query(
      `
      SELECT re.id FROM raw_events re
      LEFT JOIN source_items si ON si.raw_event_id=re.id
      WHERE re.payload->>'retentionExpired' IS DISTINCT FROM 'true'
      GROUP BY re.id
      HAVING re.collected_at < $1::timestamptz - CASE WHEN count(si.id)>0 AND bool_and(si.visibility='public') THEN interval '90 days' ELSE interval '30 days' END
        AND bool_and(si.id IS NULL OR si.id=ANY($2::uuid[]) OR COALESCE(si.metadata->>'retentionExpired'='true',false))
      ORDER BY re.id`,
      [now, ids],
    );
    const summaries = await client.query(
      "DELETE FROM summaries WHERE evidence_item_ids && $1::uuid[] RETURNING id",
      [ids],
    );
    const classifications = await client.query(
      "DELETE FROM classifications WHERE source_item_id=ANY($1::uuid[]) RETURNING id",
      [ids],
    );
    await client.query(
      `UPDATE source_items SET title='[expired]', body='', author=NULL, canonical_url='', metadata=jsonb_build_object('retentionExpired',true,'expiredAt',$2::text,'metadataRetentionDays',CASE WHEN visibility='public' THEN 365 ELSE 90 END),visibility='private',updated_at=$2::timestamptz WHERE id=ANY($1::uuid[])`,
      [ids, now.toISOString()],
    );
    await client.query(
      `UPDATE raw_events re SET payload=jsonb_build_object('retentionExpired',true,'expiredAt',$2::text,'metadataRetentionDays',COALESCE((SELECT min((si.metadata->>'metadataRetentionDays')::int) FROM source_items si WHERE si.raw_event_id=re.id),(SELECT CASE WHEN collection_policy->>'visibility'='public' THEN 365 ELSE 90 END FROM sources WHERE id=re.source_id))), updated_at=$2::timestamptz WHERE id=ANY($1::uuid[])`,
      [raw.rows.map((row) => row.id), now.toISOString()],
    );
    await client.query("COMMIT");
    return {
      ...report,
      applied: true,
      rawBodiesExpired: raw.rows.length,
      summariesRemoved: summaries.rowCount,
      classificationsRemoved: classifications.rowCount,
      publicationsWithdrawn: withdrawn,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const apply = process.argv.includes("--apply");
  if (apply && process.env.RAPI_RETENTION_APPLY_APPROVED !== "true")
    throw new Error("Explicit retention apply authorization required");
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
    query_timeout: 30_000,
  });
  try {
    if (apply && process.env.RAPI_RETENTION_BACKUP_STATUS_FILE) {
      const status = JSON.parse(
        await readFile(process.env.RAPI_RETENTION_BACKUP_STATUS_FILE, "utf8"),
      );
      const age = Date.now() - new Date(status.lastSuccessAt).getTime();
      if (
        status.state !== "success" ||
        !Number.isFinite(age) ||
        age < 0 ||
        age > 26 * 60 * 60_000
      )
        throw new Error("Fresh successful backup required");
      const file = await lstat(status.file);
      if (!file.isFile() || file.isSymbolicLink() || !file.size)
        throw new Error("Backup file unavailable");
    }
    await client.connect();
    const result = await expireSourceContent(client, {
      apply,
      publishedHistory: process.env.RAPI_EXPIRED_PUBLICATION_POLICY,
      withdrawalsFile: process.env.RAPI_BLOG_WITHDRAWALS_FILE,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (apply)
      await saveStatus(
        process.env.RAPI_SOURCE_EXPIRY_STATUS_FILE,
        "success",
        result,
      );
  } catch {
    if (apply)
      await saveStatus(
        process.env.RAPI_SOURCE_EXPIRY_STATUS_FILE,
        "failed",
      ).catch(() => undefined);
    process.stderr.write(
      "Source expiry failed. Check backup, publication and maintenance status before retrying.\n",
    );
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
