import { createHmac, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { recordWithdrawals } from "./blog-withdrawals.mjs";
import {
  removePublication,
  backupInventory,
  backupsGone,
  updateLedger,
  readJson,
} from "./privacy-files.mjs";

export function privacyRef(key, label, value) {
  if (!/^[a-f0-9]{64}$/i.test(key ?? ""))
    throw new Error("privacy_key_missing");
  return `hmac:v1:${createHmac("sha256", Buffer.from(key, "hex")).update(`${label}\0${value}`).digest("hex")}`;
}
const ids = (rows) => rows.map((row) => row.id);
const terminalTasks = "('completed','failed','rejected','expired','cancelled')";
async function begin(client) {
  await client.query("BEGIN");
  await client.query(
    "SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='30s'",
  );
  await client.query("SELECT pg_advisory_xact_lock(731552024)");
  await client.query(
    "LOCK TABLE sources,raw_events,source_items,summaries,classifications,item_relations,subscriptions,delivery_batches,delivery_batch_items,delivery_attempts,mdx_publications,queue_jobs,task_requests,task_revisions,approvals,execution_attempts,callback_events,chat_messages,chatops_runs,chatops_events,chatops_memory,chatops_memory_events,ai_usage_events,webhook_connections,webhook_receipts,privacy_requests IN EXCLUSIVE MODE",
  );
}
export async function planDeletion(client, kind, target, now = new Date()) {
  if (!["user", "item", "source"].includes(kind))
    throw new Error("invalid_target");
  if (kind !== "user" && !/^[a-f0-9-]{36}$/i.test(target))
    throw new Error("invalid_target");
  const items =
    kind === "user"
      ? []
      : ids(
          (
            await client.query(
              kind === "item"
                ? "SELECT id FROM source_items WHERE id=$1"
                : "SELECT si.id FROM source_items si JOIN raw_events re ON re.id=si.raw_event_id WHERE re.source_id=$1",
              [target],
            )
          ).rows,
        );
  if (kind === "item" && !items.length) throw new Error("target_not_found");
  if (
    kind === "source" &&
    !(await client.query("SELECT id FROM sources WHERE id=$1", [target]))
      .rowCount
  )
    throw new Error("target_not_found");
  const subscriptions =
    kind === "user"
      ? ids(
          (
            await client.query(
              "SELECT id FROM subscriptions WHERE owner_id=$1 AND created_at<=$2",
              [target, now],
            )
          ).rows,
        )
      : [];
  const batches = ids(
    (
      await client.query(
        "SELECT DISTINCT b.id FROM delivery_batches b LEFT JOIN delivery_batch_items bi ON bi.batch_id=b.id WHERE bi.source_item_id=ANY($1::uuid[]) OR b.subscription_id=ANY($2::uuid[])",
        [items, subscriptions],
      )
    ).rows,
  );
  const tasks =
    kind === "user"
      ? ids(
          (
            await client.query(
              "SELECT id FROM task_requests WHERE requester_id=$1 AND created_at<=$2",
              [target, now],
            )
          ).rows,
        )
      : [];
  const runs =
    kind === "user"
      ? ids(
          (
            await client.query(
              "SELECT id FROM chatops_runs WHERE owner_id=$1 AND created_at<=$2",
              [target, now],
            )
          ).rows,
        )
      : [];
  const memories =
    kind === "user"
      ? ids(
          (
            await client.query(
              "SELECT id FROM chatops_memory WHERE owner_id=$1 AND created_at<=$2",
              [target, now],
            )
          ).rows,
        )
      : [];
  const chats =
    kind === "user"
      ? ids(
          (
            await client.query(
              "SELECT id FROM chat_messages WHERE (author_id=$1 OR reply_owner_id=$1) AND created_at<=$2",
              [target, now],
            )
          ).rows,
        )
      : [];
  const ambiguousIds =
    kind === "user"
      ? ids(
          (
            await client.query(
              "SELECT a.id FROM chat_messages a WHERE a.role='assistant' AND a.reply_owner_id IS NULL AND a.created_at<=$2 AND EXISTS(SELECT 1 FROM chat_messages u WHERE u.role='user' AND u.author_id=$1 AND u.guild_id=a.guild_id AND u.channel_id=a.channel_id)",
              [target, now],
            )
          ).rows,
        )
      : [];
  const usages =
    kind === "user"
      ? ids(
          (
            await client.query(
              "SELECT id FROM ai_usage_events WHERE user_id=$1 AND reserved_at<=$2",
              [target, now],
            )
          ).rows,
        )
      : [];
  const publications = (
    await client.query(
      "SELECT id,file_path AS path,content_hash AS hash FROM mdx_publications WHERE batch_id=ANY($1::uuid[])",
      [batches],
    )
  ).rows;
  return {
    items,
    subscriptions,
    batches,
    tasks,
    runs,
    memories,
    chats,
    usages,
    ambiguousIds,
    ambiguous: ambiguousIds.length,
    files: publications.map((row) => ({ path: row.path, hash: row.hash })),
    cutoff: now.toISOString(),
  };
}
export function planCounts(plan) {
  return Object.fromEntries(
    [
      "items",
      "subscriptions",
      "batches",
      "tasks",
      "runs",
      "memories",
      "chats",
      "files",
    ].map((name) => [name, plan[name].length]),
  );
}
export async function requestDeletion(
  client,
  { guildId, userId, kind, target, admin, key, now = new Date() },
) {
  if (kind === "user") target = userId;
  else if (!admin) throw new Error("owner_permission_required");
  const plan = await planDeletion(client, kind, target, now);
  const id = randomUUID();
  await client.query(
    "INSERT INTO privacy_requests(id,guild_id,requester_ref,target_kind,target_id,target_ref,plan,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      id,
      guildId,
      privacyRef(key, `actor:${guildId}`, userId),
      kind,
      target,
      privacyRef(key, `target:${kind}`, target),
      plan,
      new Date(now.getTime() + 24 * 3600000),
    ],
  );
  return {
    id,
    state: "preview",
    counts: planCounts(plan),
    ambiguous: plan.ambiguous,
  };
}
export async function deletionStatus(client, { id, guildId, userId, key }) {
  const row = (
    await client.query(
      "SELECT * FROM privacy_requests WHERE id=$1 AND guild_id=$2 AND requester_ref=$3",
      [id, guildId, privacyRef(key, `actor:${guildId}`, userId)],
    )
  ).rows[0];
  if (!row) throw new Error("request_not_found");
  return {
    id: row.id,
    state: row.state,
    counts: Array.isArray(row.plan?.items) ? planCounts(row.plan) : row.plan,
    backupDeadline: row.backup_deadline,
    error: row.error_code,
  };
}
export async function confirmDeletion(client, input) {
  await deletionStatus(client, input);
  await begin(client);
  try {
    const row = (
      await client.query(
        "SELECT * FROM privacy_requests WHERE id=$1 AND state='preview' AND expires_at>now() FOR UPDATE",
        [input.id],
      )
    ).rows[0];
    if (!row) throw new Error("confirmation_expired_or_used");
    if (row.target_kind !== "user" && !input.admin)
      throw new Error("owner_permission_required");
    if (row.target_kind === "source")
      await client.query("UPDATE sources SET state='disabled' WHERE id=$1", [
        row.target_id,
      ]);
    if (row.target_kind === "user")
      await client.query(
        "UPDATE subscriptions SET active=false WHERE owner_id=$1",
        [row.target_id],
      );
    const plan = await planDeletion(client, row.target_kind, row.target_id);
    await client.query(
      "UPDATE privacy_requests SET state='confirmed',confirmed_at=now(),plan=$2 WHERE id=$1",
      [input.id, plan],
    );
    await client.query("COMMIT");
    return { id: input.id, state: "confirmed" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
async function activeWork(client, p) {
  const result = await client.query(
    `SELECT
    EXISTS(SELECT 1 FROM delivery_batches WHERE id=ANY($1::uuid[]) AND state='sending') OR
    EXISTS(SELECT 1 FROM delivery_attempts WHERE batch_id=ANY($1::uuid[]) AND (status='uncertain' OR lease_expires_at>now())) OR
    EXISTS(SELECT 1 FROM execution_attempts WHERE task_id=ANY($2::uuid[]) AND state NOT IN ${terminalTasks}) OR
    EXISTS(SELECT 1 FROM chatops_runs WHERE id=ANY($3::uuid[]) AND phase IN ('prepared','accepted','running','cancel_requested')) OR
    EXISTS(SELECT 1 FROM queue_jobs WHERE state='leased' AND (payload->>'itemId'=ANY($4::text[]) OR idempotency_key LIKE ANY(SELECT 'rss:'||id::text||':%' FROM unnest($4::uuid[]) id))) OR
    EXISTS(SELECT 1 FROM ai_usage_events WHERE id=ANY($5::uuid[]) AND state IN('reserved','started')) AS active`,
    [p.batches, p.tasks, p.runs, p.items, p.usages],
  );
  const ambiguous = (
    await client.query(
      "SELECT count(*)::int AS n FROM chat_messages WHERE id=ANY($1::uuid[]) AND reply_owner_id IS NULL",
      [p.ambiguousIds],
    )
  ).rows[0].n;
  return result.rows[0].active || ambiguous > 0;
}
async function removeBatches(client, batches) {
  await client.query(
    "DELETE FROM mdx_publications WHERE batch_id=ANY($1::uuid[])",
    [batches],
  );
  await client.query(
    "DELETE FROM delivery_attempts WHERE batch_id=ANY($1::uuid[])",
    [batches],
  );
  await client.query("DELETE FROM delivery_batches WHERE id=ANY($1::uuid[])", [
    batches,
  ]);
}
async function removeItems(client, items, key) {
  const events = (
    await client.query(
      "SELECT DISTINCT re.* FROM raw_events re JOIN source_items si ON si.raw_event_id=re.id WHERE si.id=ANY($1::uuid[])",
      [items],
    )
  ).rows;
  for (const event of events)
    await client.query(
      "INSERT INTO privacy_event_tombstones(source_id,event_ref,raw_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [
        event.source_id,
        privacyRef(
          key,
          "event",
          event.external_event_id === null
            ? `hash:${event.canonical_payload_hash}`
            : `id:${event.external_event_id}`,
        ),
        event.id,
      ],
    );
  await client.query(
    "DELETE FROM summaries WHERE evidence_item_ids && $1::uuid[]",
    [items],
  );
  await client.query(
    "DELETE FROM classifications WHERE source_item_id=ANY($1::uuid[])",
    [items],
  );
  await client.query(
    "DELETE FROM item_relations WHERE source_item_id=ANY($1::uuid[]) OR related_item_id=ANY($1::uuid[])",
    [items],
  );
  await client.query(
    "DELETE FROM webhook_receipts WHERE source_item_id=ANY($1::uuid[])",
    [items],
  );
  await client.query(
    "DELETE FROM delivery_batch_items WHERE source_item_id=ANY($1::uuid[])",
    [items],
  );
  await client.query(
    "DELETE FROM queue_jobs WHERE payload->>'itemId'=ANY($1::text[]) OR idempotency_key LIKE ANY(SELECT 'rss:'||id::text||':%' FROM unnest($1::uuid[]) id)",
    [items],
  );
  await client.query("DELETE FROM source_items WHERE id=ANY($1::uuid[])", [
    items,
  ]);
  await client.query(
    "DELETE FROM raw_events WHERE id=ANY($1::uuid[]) AND NOT EXISTS(SELECT 1 FROM source_items WHERE raw_event_id=raw_events.id)",
    [events.map((e) => e.id)],
  );
}
async function removeTasks(client, tasks) {
  await client.query(
    "DELETE FROM callback_events WHERE execution_attempt_id IN (SELECT id FROM execution_attempts WHERE task_id=ANY($1::uuid[]))",
    [tasks],
  );
  await client.query(
    "DELETE FROM queue_jobs WHERE payload->>'taskId'=ANY($1::text[]) OR payload->>'executionAttemptId' IN (SELECT id::text FROM execution_attempts WHERE task_id=ANY($1::uuid[]))",
    [tasks],
  );
  await client.query(
    "DELETE FROM execution_attempts WHERE task_id=ANY($1::uuid[])",
    [tasks],
  );
  await client.query("DELETE FROM approvals WHERE task_id=ANY($1::uuid[])", [
    tasks,
  ]);
  await client.query(
    "DELETE FROM task_revisions WHERE task_id=ANY($1::uuid[])",
    [tasks],
  );
  await client.query("DELETE FROM task_requests WHERE id=ANY($1::uuid[])", [
    tasks,
  ]);
}
export async function processDeletion(client, id, config) {
  const {
    key,
    withdrawalsFile,
    backupDirectory,
    backupCatalogFile,
    ledgerFile,
    now = new Date(),
  } = config;
  await begin(client);
  let row;
  let committed = false;
  try {
    row = (
      await client.query(
        "SELECT * FROM privacy_requests WHERE id=$1 AND state IN ('confirmed','blocked') FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { id, state: "unchanged" };
    }
    if (!row.confirmed_at) throw new Error("request_unconfirmed");
    if (row.target_kind === "user")
      await client.query(
        "UPDATE subscriptions SET active=false WHERE owner_id=$1",
        [row.target_id],
      );
    else if (row.target_kind === "source")
      await client.query("UPDATE sources SET state='disabled' WHERE id=$1", [
        row.target_id,
      ]);
    const p = row.plan;
    if (await activeWork(client, p)) {
      await client.query(
        "UPDATE privacy_requests SET state='blocked',error_code=$2 WHERE id=$1",
        [id, p.ambiguous ? "legacy_reply_ownership_unknown" : "active_work"],
      );
      await client.query("COMMIT");
      return { id, state: "blocked" };
    }
    const slugs = p.files.map((action) => {
      const name = basename(action.path);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.mdx$/.test(name))
        throw new Error("invalid_publication");
      return name.slice(0, -4);
    });
    await recordWithdrawals(withdrawalsFile, slugs);
    const backups = await backupInventory(
      backupDirectory,
      backupCatalogFile,
      now,
    );
    // Persist the confirmed scope before DB mutation, so a database rollback or
    // restore cannot discard the existence of this request and its backup cohort.
    await updateLedger(ledgerFile, {
      id,
      requesterRef: row.requester_ref,
      guildId: row.guild_id,
      targetKind: row.target_kind,
      targetRef: row.target_ref,
      plan: p,
      backups,
      processedAt: now.toISOString(),
      state: "confirmed",
    });
    await client.query("SELECT set_config('rapi.privacy_request',$1,true)", [
      id,
    ]);
    await removeBatches(client, p.batches);
    await removeItems(client, p.items, key);
    await removeTasks(client, p.tasks);
    if (row.target_kind === "user") {
      await client.query("DELETE FROM chatops_runs WHERE id=ANY($1::uuid[])", [
        p.runs,
      ]);
      await client.query(
        "DELETE FROM chatops_memory WHERE id=ANY($1::uuid[])",
        [p.memories],
      );
      await client.query("DELETE FROM chat_messages WHERE id=ANY($1::uuid[])", [
        p.chats,
      ]);
      await client.query(
        "DELETE FROM ai_usage_events WHERE user_id=$1 AND reserved_at<=$2",
        [row.target_id, p.cutoff],
      );
      await client.query("DELETE FROM subscriptions WHERE id=ANY($1::uuid[])", [
        p.subscriptions,
      ]);
      await client.query("DELETE FROM item_feedback WHERE owner_id=$1", [
        row.target_id,
      ]);
      await client.query(
        "UPDATE approvals SET approver_id=$2,discord_message_ref=NULL WHERE approver_id=$1",
        [row.target_id, privacyRef(key, "actor", row.target_id)],
      );
    }
    if (row.target_kind === "source") {
      await client.query(
        "DELETE FROM webhook_receipts WHERE connection_id IN(SELECT id FROM webhook_connections WHERE source_id=$1)",
        [row.target_id],
      );
      await client.query("DELETE FROM webhook_connections WHERE source_id=$1", [
        row.target_id,
      ]);
      await client.query("DELETE FROM raw_events WHERE source_id=$1", [
        row.target_id,
      ]);
      await client.query("DELETE FROM sources WHERE id=$1", [row.target_id]);
      await client.query(
        "DELETE FROM privacy_event_tombstones WHERE source_id=$1",
        [row.target_id],
      );
    }
    const deadline = backups.length
      ? new Date(
          Math.max(...backups.map((b) => new Date(b.expiresAt).getTime())),
        )
      : now;
    await client.query(
      "UPDATE privacy_requests SET state='files_pending',target_id=NULL,plan=$2,file_actions=$6,backup_snapshot=$3,processed_at=$4,backup_deadline=$5,error_code=NULL WHERE id=$1",
      [
        id,
        planCounts(p),
        JSON.stringify(backups),
        now,
        deadline,
        JSON.stringify(p.files),
      ],
    );
    await client.query("COMMIT");
    committed = true;
    await updateLedger(ledgerFile, {
      id,
      requesterRef: row.requester_ref,
      guildId: row.guild_id,
      targetKind: row.target_kind,
      targetRef: row.target_ref,
      plan: p,
      backups,
      processedAt: now.toISOString(),
      state: "files_pending",
    });
    await finishDeletionFiles(client, id, config);
    return {
      id,
      state: "waiting_backups",
      backupDeadline: deadline.toISOString(),
      counts: planCounts(p),
    };
  } catch (error) {
    if (!committed) await client.query("ROLLBACK");
    if (row)
      await client.query(
        committed
          ? "UPDATE privacy_requests SET error_code=$2 WHERE id=$1"
          : "UPDATE privacy_requests SET state='blocked',error_code=$2 WHERE id=$1",
        [
          id,
          ["unowned_file", "changed_file", "unsafe_file"].includes(
            error.message,
          )
            ? error.message
            : "processing_failed",
        ],
      );
    throw error;
  }
}
export async function finishDeletionFiles(client, id, config) {
  const row = (
    await client.query(
      "SELECT * FROM privacy_requests WHERE id=$1 AND state='files_pending'",
      [id],
    )
  ).rows[0];
  if (!row) return;
  for (const action of row.file_actions)
    await removePublication(action, config.publicationRoots);
  await client.query(
    "UPDATE privacy_requests SET state='waiting_backups',file_actions='[]',error_code=NULL WHERE id=$1 AND state='files_pending'",
    [id],
  );
  await updateLedger(config.ledgerFile, {
    id,
    requesterRef: row.requester_ref,
    guildId: row.guild_id,
    targetKind: row.target_kind,
    targetRef: row.target_ref,
    backups: row.backup_snapshot,
    processedAt: row.processed_at,
    state: "waiting_backups",
  });
}
export async function finishDeletionBackups(client, config) {
  const {
    ledgerFile,
    backupDirectory,
    backupCatalogFile,
    now = new Date(),
  } = config;
  const inventory = await backupInventory(
    backupDirectory,
    backupCatalogFile,
    now,
  );
  const rows = (
    await client.query(
      "SELECT * FROM privacy_requests WHERE state='waiting_backups'",
    )
  ).rows;
  let completed = 0;
  for (const row of rows) {
    const additional = inventory.filter(
      (entry) =>
        !entry.managed &&
        !row.backup_snapshot.some((previous) => previous.path === entry.path),
    );
    if (additional.length) {
      row.backup_snapshot.push(...additional);
      const deadline = new Date(
        Math.max(
          ...row.backup_snapshot.map((entry) =>
            new Date(entry.expiresAt).getTime(),
          ),
        ),
      );
      await client.query(
        "UPDATE privacy_requests SET backup_snapshot=$2,backup_deadline=$3 WHERE id=$1",
        [row.id, JSON.stringify(row.backup_snapshot), deadline],
      );
    }
    if (await backupsGone(row.backup_snapshot)) {
      await client.query(
        "UPDATE privacy_requests SET state='completed' WHERE id=$1 AND state='waiting_backups'",
        [row.id],
      );
      await updateLedger(ledgerFile, {
        id: row.id,
        requesterRef: row.requester_ref,
        guildId: row.guild_id,
        targetKind: row.target_kind,
        targetRef: row.target_ref,
        state: "completed",
        processedAt: row.processed_at,
      });
      completed++;
    }
  }
  // A restored database that predates a persisted deletion must not silently
  // consider the request finished. Keep it visible for replay/reconciliation.
  const ledger = await readJson(ledgerFile, { version: 1, requests: [] });
  for (const request of ledger.requests) {
    if (
      request.state === "completed" &&
      new Date(request.processedAt).getTime() < now.getTime() - 365 * 86400000
    )
      continue;
    const exists = (
      await client.query("SELECT id FROM privacy_requests WHERE id=$1", [
        request.id,
      ])
    ).rowCount;
    if (!exists)
      await client.query(
        "INSERT INTO privacy_requests(id,guild_id,requester_ref,target_kind,target_ref,state,plan,expires_at,error_code) VALUES($1,$2,$3,$4,$5,'blocked',$6,$7,'restore_reconciliation_required')",
        [
          request.id,
          request.guildId,
          request.requesterRef,
          request.targetKind,
          request.targetRef,
          request.plan ?? {},
          now,
        ],
      );
  }
  return completed;
}
export async function sweepMetadata(
  client,
  { key, withdrawalsFile, now = new Date(), apply = false },
) {
  privacyRef(key, "validate", "key");
  if (apply) await begin(client);
  else await client.query("BEGIN READ ONLY");
  try {
    const receipts = (
      await client.query(
        "SELECT a.* FROM delivery_attempts a JOIN delivery_batches b ON b.id=a.batch_id WHERE a.created_at<$1::timestamptz-interval '90 days' AND a.anonymized_at IS NULL AND a.status IN('success','permanent_failure') AND b.state IN('delivered','failed','dead_letter') AND (a.lease_expires_at IS NULL OR a.lease_expires_at<=$1)",
        [now],
      )
    ).rows;
    const batches = ids(
      (
        await client.query(
          "SELECT id FROM delivery_batches b WHERE b.created_at<$1::timestamptz-interval '1 year' AND b.updated_at<$1::timestamptz-interval '1 year' AND b.state IN('delivered','failed','dead_letter') AND NOT EXISTS(SELECT 1 FROM delivery_attempts a WHERE a.batch_id=b.id AND (a.status='uncertain' OR a.lease_expires_at>$1 OR a.created_at>$1::timestamptz-interval '1 year' OR a.updated_at>$1::timestamptz-interval '1 year')) AND NOT EXISTS(SELECT 1 FROM mdx_publications mp WHERE mp.batch_id=b.id AND mp.visibility='public')",
          [now],
        )
      ).rows,
    );
    const tasks = ids(
      (
        await client.query(
          `SELECT id FROM task_requests t WHERE t.created_at<$1::timestamptz-interval '1 year' AND t.updated_at<$1::timestamptz-interval '1 year' AND t.state IN ${terminalTasks} AND NOT EXISTS(SELECT 1 FROM execution_attempts e WHERE e.task_id=t.id AND (e.state NOT IN ${terminalTasks} OR e.created_at>$1::timestamptz-interval '1 year' OR e.updated_at>$1::timestamptz-interval '1 year')) AND NOT EXISTS(SELECT 1 FROM task_revisions r WHERE r.task_id=t.id AND r.created_at>$1::timestamptz-interval '1 year') AND NOT EXISTS(SELECT 1 FROM approvals a WHERE a.task_id=t.id AND a.created_at>$1::timestamptz-interval '1 year')`,
          [now],
        )
      ).rows,
    );
    const raw = (
      await client.query(
        "SELECT re.* FROM raw_events re JOIN sources s ON s.id=re.source_id WHERE re.payload->>'retentionExpired'='true' AND re.collected_at<$1::timestamptz-CASE WHEN COALESCE(re.payload->>'metadataRetentionDays',CASE WHEN s.collection_policy->>'visibility'='public' THEN '365' ELSE '90' END)='365' THEN interval '1 year' ELSE interval '90 days' END AND NOT EXISTS(SELECT 1 FROM source_items si JOIN delivery_batch_items bi ON bi.source_item_id=si.id JOIN delivery_batches b ON b.id=bi.batch_id WHERE si.raw_event_id=re.id AND b.state NOT IN('delivered','failed','dead_letter')) AND NOT EXISTS(SELECT 1 FROM source_items si JOIN queue_jobs q ON (q.payload->>'itemId'=si.id::text OR q.idempotency_key LIKE 'rss:'||si.id::text||':%') WHERE si.raw_event_id=re.id AND q.state IN('ready','leased'))",
        [now],
      )
    ).rows;
    const items = ids(
      (
        await client.query(
          "SELECT id FROM source_items WHERE raw_event_id=ANY($1::uuid[])",
          [raw.map((r) => r.id)],
        )
      ).rows,
    );
    const runs = ids(
      (
        await client.query(
          "SELECT id FROM chatops_runs WHERE created_at<$1::timestamptz-interval '1 year' AND updated_at<$1::timestamptz-interval '1 year' AND phase IN('verified','failed','cancelled','interrupted','reported_done')",
          [now],
        )
      ).rows,
    );
    const report = {
      anonymizedReceipts: receipts.length,
      deliveryAudits: batches.length,
      taskAudits: tasks.length,
      rawMetadata: raw.length,
      chatopsAudits: runs.length,
      applied: apply,
    };
    if (apply) {
      const publicPosts = (
        await client.query(
          "SELECT mp.id,mp.file_path FROM mdx_publications mp JOIN delivery_batch_items bi ON bi.batch_id=mp.batch_id WHERE mp.visibility='public' AND bi.source_item_id=ANY($1::uuid[])",
          [items],
        )
      ).rows;
      if (publicPosts.length) {
        const slugs = publicPosts.map((post) => {
          const name = basename(post.file_path);
          if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.mdx$/.test(name))
            throw new Error("invalid_publication");
          return name.slice(0, -4);
        });
        await recordWithdrawals(withdrawalsFile, slugs);
        await client.query(
          "UPDATE mdx_publications SET visibility='private' WHERE id=ANY($1::uuid[])",
          [publicPosts.map((post) => post.id)],
        );
      }
      for (const receipt of receipts)
        await client.query(
          "UPDATE delivery_attempts SET recipient_id=$2,idempotency_key=$3,provider_id=NULL,error_message=NULL,anonymized_at=$4 WHERE id=$1",
          [
            receipt.id,
            privacyRef(
              key,
              `recipient:${receipt.channel}`,
              receipt.recipient_id,
            ),
            privacyRef(key, "delivery-key", receipt.idempotency_key),
            now,
          ],
        );
      await removeBatches(client, batches);
      await removeItems(client, items, key);
      await removeTasks(client, tasks);
      for (const event of raw)
        await client.query(
          "INSERT INTO privacy_event_tombstones(source_id,event_ref,raw_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [
            event.source_id,
            privacyRef(
              key,
              "event",
              event.external_event_id === null
                ? `hash:${event.canonical_payload_hash}`
                : `id:${event.external_event_id}`,
            ),
            event.id,
          ],
        );
      await client.query("DELETE FROM raw_events WHERE id=ANY($1::uuid[])", [
        raw.map((r) => r.id),
      ]);
      await client.query("DELETE FROM chatops_runs WHERE id=ANY($1::uuid[])", [
        runs,
      ]);
      await client.query(
        "DELETE FROM chatops_memory_events WHERE created_at<$1::timestamptz-interval '1 year'",
        [now],
      );
      await client.query(
        "DELETE FROM chat_messages WHERE created_at<$1::timestamptz-interval '30 days'",
        [now],
      );
      await client.query(
        "DELETE FROM queue_jobs WHERE state IN('done','dead_letter') AND created_at<$1::timestamptz-interval '1 year'",
        [now],
      );
      await client.query(
        "DELETE FROM ai_usage_events WHERE state NOT IN('reserved','started') AND reserved_at<$1::timestamptz-interval '1 year'",
        [now],
      );
      await client.query(
        "DELETE FROM privacy_requests WHERE state='completed' AND processed_at<$1::timestamptz-interval '1 year'",
        [now],
      );
    }
    await client.query("COMMIT");
    return report;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
