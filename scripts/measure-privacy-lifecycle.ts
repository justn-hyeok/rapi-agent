// 데이터 보관·삭제가 실제로 무엇을 바꾸는지 같은 조건으로 반복해 잰다.
// 운영 DB가 아니라 이름이 _test 로 끝나는 일회용 DB에서만 돈다(resetForTests 가 그 밖의 DB를 거부한다).
//   DATABASE_URL=postgresql://.../rapi_test npx tsx scripts/measure-privacy-lifecycle.ts --runs 100 --seed 1
// 출력: 실행마다의 전후 건수(JSON lines)와 마지막 줄의 합계.
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { PostgresStore } from "@rapi/db";
import {
  requestDeletion,
  confirmDeletion,
  processDeletion,
  sweepMetadata,
} from "./privacy-lifecycle.mjs";

const run = promisify(execFile);
const args = process.argv.slice(2);
const option = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const runs = option("runs", 100);
let state = option("seed", 1) >>> 0;
// mulberry32: 시드가 같으면 같은 데이터가 심어진다.
const random = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const between = (low: number, high: number) =>
  low + Math.floor(random() * (high - low + 1));

const key = Buffer.alloc(32, 7).toString("hex");
const guild = "20000000000000001";
const owner = "10000000000000001";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const client = new pg.Client({ connectionString: url });
await client.connect();
const store = new PostgresStore(url, { privacyHmacKey: key });
const root = await mkdtemp(join(tmpdir(), "rapi-measure-"));
const config = {
  key,
  withdrawalsFile: join(root, "withdrawals.json"),
  publicationRoots: [join(root, "publications")],
  backupDirectory: join(root, "backups"),
  backupCatalogFile: join(root, "catalog.json"),
  ledgerFile: join(root, "ledger.json"),
};
await mkdir(config.publicationRoots[0]!);
await mkdir(config.backupDirectory);
const backupFile = join(config.backupDirectory, "rapi-measure.dump");
await writeFile(backupFile, "measurement backup");
const statusFile = join(root, "backup-status.json");

const count = async (sql: string, params: unknown[] = []) =>
  Number((await client.query<{ n: string }>(sql, params)).rows[0]!.n);

async function item() {
  const source = await store.createSource(
    "rss",
    `https://measure.example/${randomUUID()}`,
    "public",
  );
  const raw = await store.insertRawEvent(
    source,
    "event-1",
    "checksum",
    { body: "body" },
    new Date(),
  );
  const saved = await store.saveItem(
    {
      id: randomUUID(),
      rawEventId: raw.id,
      sourceId: source,
      normalizerVersion: "measure-v1",
      canonicalUrl: "https://measure.example/item",
      title: "title",
      body: "body",
      author: null,
      publishedAt: null,
      collectedAt: new Date(),
      visibility: "public",
      contentFingerprint: randomUUID(),
      metadata: {},
      categories: [],
    },
    "summary",
  );
  return saved.id;
}
// 발송 묶음 하나와 그 안의 이메일 발송 기록 하나. 주소는 사람마다 다르게 심는다.
async function receipt(
  itemId: string,
  age: number,
  batchState: string,
  address: string,
) {
  const sub = randomUUID();
  const batch = randomUUID();
  await client.query(
    "INSERT INTO subscriptions(id,owner_id,name,cadence,channels) VALUES($1::uuid,$2,$1::text,'weekly','[]')",
    [sub, owner],
  );
  await client.query(
    "INSERT INTO delivery_batches(id,subscription_id,period_start,period_end,renderer_version,state,created_at) VALUES($1,$2,now()-interval '7 days',now(),'v1',$3,now()-$4*interval '1 day')",
    [batch, sub, batchState, Math.min(age, 300)],
  );
  await client.query(
    "INSERT INTO delivery_batch_items(batch_id,source_item_id,position) VALUES($1,$2,0)",
    [batch, itemId],
  );
  await client.query(
    "INSERT INTO delivery_attempts(id,batch_id,channel,recipient_id,renderer_version,idempotency_key,status,created_at) VALUES($1,$2,'email',$3,'v1',$4,'success',now()-$5*interval '1 day')",
    [randomUUID(), batch, address, `${batch}:email:${address}:v1`, age],
  );
  return { batch, address };
}
async function task(state: string, age: number) {
  const id = randomUUID();
  await client.query(
    "INSERT INTO task_requests(id,requester_id,state,risk_level,created_at,updated_at) VALUES($1,$2,$3,'low',now()-$4*interval '1 day',now()-$4*interval '1 day')",
    [id, owner, state, age],
  );
  await client.query(
    "INSERT INTO task_revisions(task_id,revision,specification,change_reason,created_at) VALUES($1,1,'{}','measure',now()-$2*interval '1 day')",
    [id, age],
  );
  return id;
}
const plain = (addresses: string[]) =>
  count(
    "SELECT count(*) AS n FROM delivery_attempts WHERE recipient_id=ANY($1::text[])",
    [addresses],
  );
const tasksLeft = (ids: string[]) =>
  count("SELECT count(*) AS n FROM task_requests WHERE id=ANY($1::uuid[])", [
    ids,
  ]);
async function worker() {
  try {
    await run(
      process.execPath,
      ["scripts/privacy-worker.mjs", "--maintenance"],
      {
        env: {
          ...process.env,
          DATABASE_URL: url,
          PRIVACY_HMAC_KEY: key,
          BACKUP_STATUS_FILE: statusFile,
          RAPI_BLOG_WITHDRAWALS_FILE: config.withdrawalsFile,
          RAPI_PRIVACY_PUBLICATION_ROOTS: JSON.stringify(
            config.publicationRoots,
          ),
          RAPI_BACKUP_DIRECTORY: config.backupDirectory,
          RAPI_BACKUP_CATALOG_FILE: config.backupCatalogFile,
          RAPI_PRIVACY_LEDGER_FILE: config.ledgerFile,
        },
      },
    );
    return 0;
  } catch (error) {
    return (error as { code?: number }).code ?? 1;
  }
}
const backupStatus = (hoursAgo: number) =>
  writeFile(
    statusFile,
    JSON.stringify({
      state: "success",
      lastSuccessAt: new Date(Date.now() - hoursAgo * 3600000).toISOString(),
      file: backupFile,
    }),
  );

const total = {
  runs: 0,
  // M1 보관 기간이 지난 발송 주소·작업 기록
  expiredAddressesBefore: 0,
  expiredAddressesAfter: 0,
  expiredTasksBefore: 0,
  expiredTasksAfter: 0,
  keptAddresses: 0,
  keptAddressesChanged: 0,
  keptTasks: 0,
  keptTasksChanged: 0,
  duplicateSendsAfterPseudonymize: 0,
  // M2 백업이 오래됐을 때
  staleBackupRuns: 0,
  staleBackupRowsChanged: 0,
  staleBackupWorkerFailed: 0,
  freshBackupAddressesBefore: 0,
  freshBackupAddressesAfter: 0,
  // M3 본인 정보 삭제 요청
  ownerMessagesBefore: 0,
  ownerMessagesAfterPreview: 0,
  ownerMessagesAfter: 0,
  otherMessages: 0,
  otherMessagesChanged: 0,
  foreignConfirmAttempts: 0,
  foreignConfirmRejected: 0,
  expiredConfirmAttempts: 0,
  expiredConfirmRejected: 0,
};

try {
  for (let n = 1; n <= runs; n++) {
    await store.resetForTests();
    const result: Record<string, number> = { run: n };

    // M1: 기한이 지난 것만 바뀌고 나머지는 그대로인가
    const target = await item();
    const expired = [];
    const kept = [];
    for (let i = between(1, 20); i > 0; i--)
      expired.push(
        await receipt(
          target,
          between(91, 300),
          "delivered",
          `x${n}-${i}@measure.test`,
        ),
      );
    for (let i = between(1, 20); i > 0; i--)
      kept.push(
        await receipt(
          target,
          between(0, 89),
          "delivered",
          `f${n}-${i}@measure.test`,
        ),
      );
    for (let i = between(1, 10); i > 0; i--)
      kept.push(
        await receipt(
          target,
          between(91, 300),
          "sending",
          `a${n}-${i}@measure.test`,
        ),
      );
    const oldTasks = [];
    const liveTasks = [];
    for (let i = between(1, 10); i > 0; i--)
      oldTasks.push(await task("completed", between(366, 800)));
    for (let i = between(1, 10); i > 0; i--)
      liveTasks.push(await task("running", between(366, 800)));
    for (let i = between(1, 10); i > 0; i--)
      liveTasks.push(await task("completed", between(0, 364)));
    const expiredAddresses = expired.map((r) => r.address);
    const keptAddresses = kept.map((r) => r.address);
    result.expiredAddressesBefore = await plain(expiredAddresses);
    result.expiredTasksBefore = await tasksLeft(oldTasks);
    await sweepMetadata(client, { key, apply: true });
    result.expiredAddressesAfter = await plain(expiredAddresses);
    result.expiredTasksAfter = await tasksLeft(oldTasks);
    result.keptAddresses = keptAddresses.length;
    result.keptAddressesChanged =
      keptAddresses.length - (await plain(keptAddresses));
    result.keptTasks = liveTasks.length;
    result.keptTasksChanged = liveTasks.length - (await tasksLeft(liveTasks));
    let duplicates = 0;
    for (const r of expired)
      if (
        !(
          await store.beginDelivery(
            r.batch,
            { channel: "email", recipientId: r.address },
            "v1",
          )
        ).skip
      )
        duplicates++;
    result.duplicateSendsAfterPseudonymize = duplicates;

    // M2: 하루 넘게 백업이 없으면 정리 작업이 아무것도 바꾸지 않는가
    await store.resetForTests();
    const gated = await item();
    const waiting = [];
    for (let i = between(1, 20); i > 0; i--)
      waiting.push(
        (
          await receipt(
            gated,
            between(91, 300),
            "delivered",
            `g${n}-${i}@measure.test`,
          )
        ).address,
      );
    await backupStatus(between(27, 200));
    const failed = await worker();
    result.staleBackupRowsChanged = waiting.length - (await plain(waiting));
    result.staleBackupWorkerFailed = failed === 0 ? 0 : 1;
    await backupStatus(1);
    result.freshBackupAddressesBefore = await plain(waiting);
    await worker();
    result.freshBackupAddressesAfter = await plain(waiting);

    // M3: 본인 확정 전에는 안 지워지고, 확정하면 본인 것만 지워지는가
    await store.resetForTests();
    const others = Array.from(
      { length: between(1, 4) },
      (_, i) => `1000000000000010${i}`,
    );
    for (let i = between(1, 10); i > 0; i--)
      await store.appendChatMessage({
        guildId: guild,
        channelId: "channel",
        authorId: owner,
        role: "user",
        content: `owner ${i}`,
      });
    let otherCount = 0;
    for (const person of others)
      for (let i = between(1, 10); i > 0; i--, otherCount++)
        await store.appendChatMessage({
          guildId: guild,
          channelId: `channel-${person}`,
          authorId: person,
          role: "user",
          content: `other ${i}`,
        });
    const ownerMessages = () =>
      count(
        "SELECT count(*) AS n FROM chat_messages WHERE author_id=$1 OR reply_owner_id=$1",
        [owner],
      );
    const otherMessages = () =>
      count(
        "SELECT count(*) AS n FROM chat_messages WHERE author_id=ANY($1::text[])",
        [others],
      );
    result.ownerMessagesBefore = await ownerMessages();
    const stale = await requestDeletion(client, {
      guildId: guild,
      userId: owner,
      kind: "user",
      key,
    });
    result.ownerMessagesAfterPreview = await ownerMessages();
    result.foreignConfirmAttempts = others.length;
    result.foreignConfirmRejected = 0;
    for (const person of others)
      await confirmDeletion(client, {
        id: stale.id,
        guildId: guild,
        userId: person,
        key,
      }).then(
        () => undefined,
        () => result.foreignConfirmRejected++,
      );
    await client.query(
      "UPDATE privacy_requests SET expires_at=now()-interval '1 minute' WHERE id=$1",
      [stale.id],
    );
    result.expiredConfirmAttempts = 1;
    result.expiredConfirmRejected = await confirmDeletion(client, {
      id: stale.id,
      guildId: guild,
      userId: owner,
      key,
    }).then(
      () => 0,
      () => 1,
    );
    const request = await requestDeletion(client, {
      guildId: guild,
      userId: owner,
      kind: "user",
      key,
    });
    await confirmDeletion(client, {
      id: request.id,
      guildId: guild,
      userId: owner,
      key,
    });
    await processDeletion(client, request.id, config);
    result.ownerMessagesAfter = await ownerMessages();
    result.otherMessages = otherCount;
    result.otherMessagesChanged = otherCount - (await otherMessages());

    result.staleBackupRuns = 1;
    for (const [name, value] of Object.entries(result))
      if (name !== "run")
        (total as Record<string, number>)[name] =
          ((total as Record<string, number>)[name] ?? 0) + value;
    total.runs++;
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
  process.stdout.write(`${JSON.stringify({ total })}\n`);
} finally {
  await store.close();
  await client.end();
  await rm(root, { recursive: true, force: true });
}
