import assert from "node:assert/strict";
import { it } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
import { PostgresStore } from "@rapi/db";
import {
  requestDeletion,
  confirmDeletion,
  processDeletion,
  deletionStatus,
  finishDeletionBackups,
  finishDeletionFiles,
  sweepMetadata,
} from "../../scripts/privacy-lifecycle.mjs";
import { registerBackup } from "../../scripts/privacy-files.mjs";
import { prune } from "../../scripts/prune-backups.mjs";
const key = Buffer.alloc(32, 7).toString("hex");
it("waits for backup snapshot publication before recording its deletion backup cohort", async () => {
  const s = await setup();
  const backupClient = new pg.Client({
    connectionString: process.env.DATABASE_URL,
  });
  await backupClient.connect();
  try {
    const i = await item(s);
    const r = await requestDeletion(s.client, {
      guildId: guild,
      userId: owner,
      kind: "item",
      target: i.id,
      key,
      admin: true,
    });
    await confirmDeletion(s.client, {
      id: r.id,
      guildId: guild,
      userId: owner,
      key,
      admin: true,
    });
    await backupClient.query("SELECT pg_advisory_lock(731552024)");
    const pending = processDeletion(s.client, r.id, s.config);
    const backup = join(s.config.backupDirectory, "rapi-20260928T010000Z.dump");
    await writeFile(backup, "snapshot before deletion");
    await backupClient.query("SELECT pg_advisory_unlock(731552024)");
    await pending;
    assert.equal(await finishDeletionBackups(s.client, s.config), 0);
    await rm(backup);
    assert.equal(await finishDeletionBackups(s.client, s.config), 1);
  } finally {
    await backupClient.end();
    await s.close();
  }
});
it("defers metadata of an item that still has an active webhook lease", async () => {
  const s = await setup();
  try {
    const i = await item(s, "private", 100);
    await s.client.query(
      'UPDATE raw_events SET payload=\'{"retentionExpired":true,"metadataRetentionDays":90}\' WHERE id=$1',
      [i.raw],
    );
    await s.client.query(
      "UPDATE source_items SET metadata='{\"retentionExpired\":true}' WHERE id=$1",
      [i.id],
    );
    const job = randomUUID();
    await s.client.query(
      "INSERT INTO queue_jobs(id,kind,payload,state,idempotency_key,lease_expires_at) VALUES($1,'webhook',$2,'leased',$3,now()+interval '5 minutes')",
      [job, { itemId: i.id }, `rss:${i.id}:destination`],
    );
    assert.equal(
      (await sweepMetadata(s.client, { key, apply: true })).rawMetadata,
      0,
    );
    await s.client.query(
      "UPDATE queue_jobs SET state='ready',lease_expires_at=NULL WHERE id=$1",
      [job],
    );
    assert.equal(
      (await sweepMetadata(s.client, { key, apply: true })).rawMetadata,
      0,
    );
    assert.equal(
      (await s.client.query("SELECT id FROM queue_jobs WHERE id=$1", [job]))
        .rowCount,
      1,
    );
    await s.client.query(
      "UPDATE queue_jobs SET state='done',lease_expires_at=NULL WHERE id=$1",
      [job],
    );
    assert.equal(
      (await sweepMetadata(s.client, { key, apply: true })).rawMetadata,
      1,
    );
  } finally {
    await s.close();
  }
});
it("keeps files when SQL rolls back and resumes file deletion after a committed request", async () => {
  const s = await setup();
  try {
    const i = await item(s, "public");
    const b = await batch(s, i.id);
    const path = join(s.publicationRoot, "resumable.mdx");
    const content = "original publication";
    await writeFile(path, content);
    await s.store.recordPublication(
      b,
      "public",
      path,
      createHash("sha256").update(content).digest("hex"),
    );
    const r = await requestDeletion(s.client, {
      guildId: guild,
      userId: owner,
      kind: "item",
      target: i.id,
      key,
      admin: true,
    });
    await confirmDeletion(s.client, {
      id: r.id,
      guildId: guild,
      userId: owner,
      key,
      admin: true,
    });
    await s.client.query(
      "CREATE TABLE privacy_fk_probe(item_id uuid REFERENCES source_items(id))",
    );
    await s.client.query("INSERT INTO privacy_fk_probe VALUES($1)", [i.id]);
    await assert.rejects(
      processDeletion(s.client, r.id, s.config),
      /foreign key/,
    );
    assert.equal(await readFile(path, "utf8"), content);
    assert.equal(
      (await s.client.query("SELECT id FROM source_items WHERE id=$1", [i.id]))
        .rowCount,
      1,
    );
    await s.client.query("DROP TABLE privacy_fk_probe");
    await writeFile(path, "newer replacement");
    await assert.rejects(
      processDeletion(s.client, r.id, s.config),
      /changed_file/,
    );
    assert.equal(
      (await s.client.query("SELECT id FROM source_items WHERE id=$1", [i.id]))
        .rowCount,
      0,
    );
    assert.equal(
      (
        await deletionStatus(s.client, {
          id: r.id,
          guildId: guild,
          userId: owner,
          key,
        })
      ).state,
      "files_pending",
    );
    assert.equal(await readFile(path, "utf8"), "newer replacement");
    await writeFile(path, content);
    await finishDeletionFiles(s.client, r.id, s.config);
    await assert.rejects(readFile(path), /ENOENT/);
  } finally {
    await s.client.query("DROP TABLE IF EXISTS privacy_fk_probe");
    await s.close();
  }
});
it("rolls back the new schema before it has processed data and reapplies it without touching application records", async () => {
  const s = await setup();
  try {
    await s.client.query(
      await readFile("scripts/rollback-data-lifecycle.sql", "utf8"),
    );
    assert.equal(
      (
        await s.client.query(
          "SELECT name FROM schema_migrations WHERE name='0013_data_lifecycle.sql'",
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await s.client.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='delivery_attempts' AND column_name='anonymized_at'",
        )
      ).rowCount,
      0,
    );
    await s.client.query(
      await readFile("packages/db/migrations/0013_data_lifecycle.sql", "utf8"),
    );
    assert.equal(
      (
        await s.client.query(
          "SELECT name FROM schema_migrations WHERE name='0013_data_lifecycle.sql'",
        )
      ).rowCount,
      1,
    );
  } finally {
    await s.client.query("ROLLBACK");
    if (
      !(
        await s.client.query(
          "SELECT name FROM schema_migrations WHERE name='0013_data_lifecycle.sql'",
        )
      ).rowCount
    )
      await s.client.query(
        await readFile(
          "packages/db/migrations/0013_data_lifecycle.sql",
          "utf8",
        ),
      );
    await s.close();
  }
});
const owner = "10000000000000001";
const guild = "20000000000000001";
async function setup() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const store = new PostgresStore(process.env.DATABASE_URL!, {
    privacyHmacKey: key,
  });
  await store.resetForTests();
  const root = await mkdtemp(join(tmpdir(), "rapi-privacy-e2e-"));
  const backupDirectory = join(root, "backups");
  const publicationRoot = join(root, "publications");
  await mkdir(backupDirectory);
  await mkdir(publicationRoot);
  const config = {
    key,
    withdrawalsFile: join(root, "withdrawals.json"),
    publicationRoots: [publicationRoot],
    backupDirectory,
    backupCatalogFile: join(root, "catalog.json"),
    ledgerFile: join(root, "ledger.json"),
  };
  return {
    client,
    store,
    root,
    config,
    publicationRoot,
    async close() {
      await store.close();
      await client.end();
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function item(
  s: Awaited<ReturnType<typeof setup>>,
  visibility: "private" | "public" = "private",
  age = 0,
) {
  const source = await s.store.createSource(
    "rss",
    `https://privacy.example/${randomUUID()}`,
    visibility,
  );
  const raw = await s.store.insertRawEvent(
    source,
    "event-1",
    "checksum",
    { body: "source body" },
    new Date(Date.now() - age * 86400000),
  );
  const saved = await s.store.saveItem(
    {
      id: randomUUID(),
      rawEventId: raw.id,
      sourceId: source,
      normalizerVersion: "test-v1",
      canonicalUrl: "https://privacy.example/item",
      title: "source title",
      body: "source body",
      author: null,
      publishedAt: null,
      collectedAt: new Date(Date.now() - age * 86400000),
      visibility,
      contentFingerprint: randomUUID(),
      metadata: {},
      categories: [],
    },
    "summary",
  );
  return { source, raw: raw.id, id: saved.id };
}
async function batch(
  s: Awaited<ReturnType<typeof setup>>,
  itemId: string,
  age = 0,
  state = "delivered",
) {
  const sub = randomUUID();
  const id = randomUUID();
  await s.client.query(
    "INSERT INTO subscriptions(id,owner_id,name,cadence,channels) VALUES($1::uuid,$2,$1::text,'weekly','[]')",
    [sub, owner],
  );
  await s.client.query(
    "INSERT INTO delivery_batches(id,subscription_id,period_start,period_end,renderer_version,state,created_at) VALUES($1,$2,now()-interval '7 days',now(),'v1',$3,now()-$4*interval '1 day')",
    [id, sub, state, age],
  );
  await s.client.query(
    "INSERT INTO delivery_batch_items(batch_id,source_item_id,position) VALUES($1,$2,0)",
    [id, itemId],
  );
  return id;
}
it("pseudonymizes old terminal receipts without exposing addresses or allowing duplicate delivery; preserves active data", async () => {
  const s = await setup();
  try {
    // A public item: a private one may only be delivered to its owner.
    const i = await item(s, "public");
    const b = await batch(s, i.id, 100);
    const active = await batch(s, i.id, 100, "sending");
    for (const id of [b, active])
      await s.client.query(
        "INSERT INTO delivery_attempts(id,batch_id,channel,recipient_id,renderer_version,idempotency_key,status,created_at) VALUES($1,$2,'email','person@example.test','v1',$3,'success',now()-interval '100 days')",
        [randomUUID(), id, `${id}:email:person@example.test:v1`],
      );
    assert.equal(
      (await sweepMetadata(s.client, { key })).anonymizedReceipts,
      1,
    );
    assert.equal(
      (
        await s.client.query<{ recipient_id: string }>(
          "SELECT recipient_id FROM delivery_attempts WHERE batch_id=$1",
          [b],
        )
      ).rows[0]!.recipient_id,
      "person@example.test",
    );
    await sweepMetadata(s.client, { key, apply: true });
    const row = (
      await s.client.query<{ recipient_id: string; idempotency_key: string }>(
        "SELECT recipient_id,idempotency_key FROM delivery_attempts WHERE batch_id=$1",
        [b],
      )
    ).rows[0]!;
    assert.match(row.recipient_id, /^hmac:v1:/);
    assert(!JSON.stringify(row).includes("person@example.test"));
    assert.equal(
      (
        await s.store.beginDelivery(
          b,
          { channel: "email", recipientId: "person@example.test" },
          "v1",
        )
      ).skip,
      true,
    );
    assert.equal(
      (
        await s.client.query<{ recipient_id: string }>(
          "SELECT recipient_id FROM delivery_attempts WHERE batch_id=$1",
          [active],
        )
      ).rows[0]!.recipient_id,
      "person@example.test",
    );
    assert.equal(
      (await sweepMetadata(s.client, { key, apply: true })).anonymizedReceipts,
      0,
    );
  } finally {
    await s.close();
  }
});
it("removes expired metadata and terminal audits, keeps live work, and suppresses reingestion of erased events", async () => {
  const s = await setup();
  try {
    const old = await item(s, "private", 100);
    const fresh = await item(s, "public", 100);
    await s.client.query(
      'UPDATE raw_events SET payload=\'{"retentionExpired":true,"metadataRetentionDays":90}\' WHERE id=$1',
      [old.raw],
    );
    await s.client.query(
      "UPDATE source_items SET metadata='{\"retentionExpired\":true}' WHERE id=$1",
      [old.id],
    );
    const task = randomUUID();
    await s.client.query(
      "INSERT INTO task_requests(id,requester_id,state,risk_level,created_at,updated_at) VALUES($1,$2,'completed','low',now()-interval '2 years',now()-interval '2 years')",
      [task, owner],
    );
    await s.client.query(
      "INSERT INTO task_revisions(task_id,revision,specification,change_reason,created_at) VALUES($1,1,'{}','test',now()-interval '2 years')",
      [task],
    );
    const active = randomUUID();
    await s.client.query(
      "INSERT INTO task_requests(id,requester_id,state,risk_level,created_at) VALUES($1,$2,'running','low',now()-interval '2 years')",
      [active, owner],
    );
    const report = await sweepMetadata(s.client, { key, apply: true });
    assert.equal(report.rawMetadata, 1);
    assert.equal(report.taskAudits, 1);
    assert.equal(
      (
        await s.client.query("SELECT id FROM task_requests WHERE id=$1", [
          active,
        ])
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await s.client.query("SELECT id FROM source_items WHERE id=$1", [
          fresh.id,
        ])
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await s.store.insertRawEvent(
          old.source,
          "event-1",
          "checksum",
          { body: "resurrected" },
          new Date(),
        )
      ).retired,
      true,
    );
    const withoutKey = new PostgresStore(process.env.DATABASE_URL!);
    try {
      await assert.rejects(
        withoutKey.insertRawEvent(
          old.source,
          "event-1",
          "checksum",
          { body: "resurrected" },
          new Date(),
        ),
        /Privacy key/,
      );
    } finally {
      await withoutKey.close();
    }
    const connection = randomUUID();
    await s.client.query(
      "INSERT INTO webhook_connections(id,guild_id,name,kind,source_id,destination_kind,destination_id,secret_ciphertext) VALUES($1,$2,'erasure-test','generic_inbound',$3,'discord_channel','channel','test-encrypted')",
      [connection, guild, old.source],
    );
    const input: Parameters<PostgresStore["ingestManagedWebhook"]>[0] = {
      connectionId: connection,
      deliveryId: "event-1",
      eventType: "test",
      payloadHash: "checksum",
      rawPayload: { body: "resurrected" },
      item: {
        id: randomUUID(),
        rawEventId: randomUUID(),
        sourceId: old.source,
        normalizerVersion: "test-v1",
        canonicalUrl: "https://privacy.example/erased",
        title: "erased",
        body: "erased",
        author: null,
        publishedAt: null,
        collectedAt: new Date(),
        visibility: "private",
        contentFingerprint: randomUUID(),
        metadata: {},
        categories: [],
      },
      summary: "erased",
    };
    const replay = await s.store.ingestManagedWebhook(input);
    assert.equal(replay.inserted, false);
    await s.client.query(
      "UPDATE webhook_connections SET event_filters=ARRAY['allowed'] WHERE id=$1",
      [connection],
    );
    await assert.rejects(s.store.ingestManagedWebhook(input), /not allowed/);
    await s.client.query(
      "UPDATE webhook_connections SET state='disabled' WHERE id=$1",
      [connection],
    );
    await assert.rejects(
      s.store.ingestManagedWebhook({ ...input, eventType: "allowed" }),
      /not active/,
    );
    assert.equal(
      (
        await s.client.query("SELECT id FROM raw_events WHERE source_id=$1", [
          old.source,
        ])
      ).rowCount,
      0,
    );
    assert.equal(
      (await sweepMetadata(s.client, { key, apply: true })).rawMetadata,
      0,
    );
  } finally {
    await s.close();
  }
});
it("requires authorized separate confirmation, deletes registered data/files, and waits for actual backup disappearance", async () => {
  const s = await setup();
  try {
    const i = await item(s, "public");
    const b = await batch(s, i.id);
    const path = join(s.publicationRoot, "privacy-post.mdx");
    const content = "registered publication";
    await writeFile(path, content);
    await s.store.recordPublication(
      b,
      "public",
      path,
      createHash("sha256").update(content).digest("hex"),
    );
    await assert.rejects(
      requestDeletion(s.client, {
        guildId: guild,
        userId: owner,
        kind: "item",
        target: i.id,
        key,
      }),
      /permission/,
    );
    const r = await requestDeletion(s.client, {
      guildId: guild,
      userId: owner,
      kind: "item",
      target: i.id,
      key,
      admin: true,
    });
    assert.equal(
      (await s.client.query("SELECT id FROM source_items WHERE id=$1", [i.id]))
        .rowCount,
      1,
    );
    await assert.rejects(
      confirmDeletion(s.client, {
        id: r.id,
        guildId: guild,
        userId: "10000000000000002",
        key,
      }),
      /not_found/,
    );
    const backup = join(s.config.backupDirectory, "rapi-20260928T000000Z.dump");
    await writeFile(backup, "backup contains old data");
    await confirmDeletion(s.client, {
      id: r.id,
      guildId: guild,
      userId: owner,
      key,
      admin: true,
    });
    assert.equal(
      (await processDeletion(s.client, r.id, s.config)).state,
      "waiting_backups",
    );
    assert.equal(
      (await s.client.query("SELECT id FROM source_items WHERE id=$1", [i.id]))
        .rowCount,
      0,
    );
    await assert.rejects(readFile(path), /ENOENT/);
    assert(
      (await readFile(s.config.withdrawalsFile, "utf8")).includes(
        "privacy-post",
      ),
    );
    assert.equal(
      await finishDeletionBackups(s.client, {
        ...s.config,
        now: new Date(Date.now() + 35 * 86400000),
      }),
      0,
    );
    await prune(s.config.backupDirectory, new Date("2026-11-01T00:00:00Z"));
    assert.equal(await finishDeletionBackups(s.client, s.config), 1);
    assert.equal(
      (
        await deletionStatus(s.client, {
          id: r.id,
          guildId: guild,
          userId: owner,
          key,
        })
      ).state,
      "completed",
    );
  } finally {
    await s.close();
  }
});
it("protects active deliveries and changed files, expires confirmations, and tracks registered recovery dumps", async () => {
  const s = await setup();
  try {
    const i = await item(s);
    const b = await batch(s, i.id, 0, "sending");
    const r = await requestDeletion(s.client, {
      guildId: guild,
      userId: owner,
      kind: "item",
      target: i.id,
      key,
      admin: true,
    });
    await confirmDeletion(s.client, {
      id: r.id,
      guildId: guild,
      userId: owner,
      key,
      admin: true,
    });
    assert.equal(
      (await processDeletion(s.client, r.id, s.config)).state,
      "blocked",
    );
    assert.equal(
      (await s.client.query("SELECT id FROM source_items WHERE id=$1", [i.id]))
        .rowCount,
      1,
    );
    await s.client.query(
      "UPDATE delivery_batches SET state='delivered' WHERE id=$1",
      [b],
    );
    const old = await requestDeletion(s.client, {
      guildId: guild,
      userId: owner,
      kind: "item",
      target: i.id,
      key,
      admin: true,
      now: new Date(Date.now() - 2 * 86400000),
    });
    await assert.rejects(
      confirmDeletion(s.client, {
        id: old.id,
        guildId: guild,
        userId: owner,
        key,
      }),
      /expired/,
    );
    const dump = join(s.root, "recovery.dump");
    await writeFile(dump, "private backup");
    await registerBackup(s.config.backupCatalogFile!, dump, [s.root]);
    assert.equal(
      (await processDeletion(s.client, r.id, s.config)).state,
      "waiting_backups",
    );
    assert.equal(await finishDeletionBackups(s.client, s.config), 0);
    assert.equal(
      await finishDeletionBackups(s.client, {
        ...s.config,
        now: new Date(Date.now() + 31 * 86400000),
      }),
      1,
    );
    await assert.rejects(readFile(dump), /ENOENT/);
  } finally {
    await s.close();
  }
});

it("erases only a confirmed user scope while retaining other users and enforcing immutable recent audits", async () => {
  const s = await setup();
  try {
    const run = randomUUID();
    await s.client.query(
      "INSERT INTO chatops_runs(id,guild_id,channel_id,owner_id,message_id,route,model,task_digest) VALUES($1::uuid,$2,'channel',$3,$1::text,'execute','gpt-5.6-sol',$4)",
      [run, guild, owner, "a".repeat(64)],
    );
    for (const phase of ["accepted", "running", "failed"])
      await s.client.query("UPDATE chatops_runs SET phase=$2 WHERE id=$1", [
        run,
        phase,
      ]);
    await assert.rejects(
      s.client.query("DELETE FROM chatops_events WHERE run_id=$1", [run]),
      /append-only/,
    );
    await assert.rejects(
      s.client.query("DELETE FROM chatops_runs WHERE id=$1", [run]),
      /requires/,
    );
    const memory = randomUUID();
    await s.client.query(
      "INSERT INTO chatops_memory(id,guild_id,channel_id,owner_id,message_id,content,digest,state) VALUES($1::uuid,$2,'channel',$3,$1::text,'remembered personal detail',$4,'candidate')",
      [memory, guild, owner, "b".repeat(64)],
    );
    await s.client.query(
      "UPDATE chatops_memory SET state='approved',revision=2 WHERE id=$1",
      [memory],
    );
    await s.store.appendChatMessage({
      guildId: guild,
      channelId: "channel",
      authorId: owner,
      role: "user",
      content: "my private message",
    });
    await s.store.appendChatMessage({
      guildId: guild,
      channelId: "channel",
      authorId: "rapi",
      replyOwnerId: owner,
      role: "assistant",
      content: "my private reply",
    });
    await s.store.appendChatMessage({
      guildId: guild,
      channelId: "other-channel",
      authorId: "10000000000000002",
      role: "user",
      content: "other person",
    });
    const request = await requestDeletion(s.client, {
      guildId: guild,
      userId: owner,
      kind: "user",
      key,
    });
    await confirmDeletion(s.client, {
      id: request.id,
      guildId: guild,
      userId: owner,
      key,
    });
    assert.equal(
      (await processDeletion(s.client, request.id, s.config)).state,
      "waiting_backups",
    );
    assert.equal(
      (await s.client.query("SELECT id FROM chatops_runs WHERE id=$1", [run]))
        .rowCount,
      0,
    );
    assert.equal(
      (
        await s.client.query("SELECT id FROM chatops_memory WHERE id=$1", [
          memory,
        ])
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await s.client.query("SELECT seq FROM chatops_events WHERE run_id=$1", [
          run,
        ])
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await s.client.query(
          "SELECT id FROM chat_messages WHERE author_id=$1 OR reply_owner_id=$1",
          [owner],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await s.client.query(
          "SELECT id FROM chat_messages WHERE author_id='10000000000000002'",
        )
      ).rowCount,
      1,
    );
    assert.equal(await finishDeletionBackups(s.client, s.config), 1);
  } finally {
    await s.close();
  }
});
