import { randomUUID } from "node:crypto";
import {
  chatRunSchema,
  memorySchema,
  redactChat,
  runEvidenceSchema,
  runPhaseSchema,
  scopeSchema,
  textDigest,
  type ChatScope,
  type ChatRoute,
  type ChatRun,
  type ChatMemory,
  type RunEvidence,
  type RunPhase,
} from "@rapi/contracts";
import { PostgresStore } from "./postgres-store.js";

export class ChatOpsStore {
  constructor(readonly db: PostgresStore) {}
  async claim(
    scope: ChatScope,
    message: string,
    text: string,
    route: ChatRoute,
    model: string,
  ): Promise<{ inserted: boolean; run?: ChatRun }> {
    scopeSchema.parse(scope);
    const safe = redactChat(text).slice(0, 20000);
    return this.db.transaction(async (client) => {
      const claim = await client.query(
        `INSERT INTO chat_messages(id,guild_id,channel_id,discord_message_id,author_id,role,content) VALUES($1,$2,$3,$4,$5,'user',$6) ON CONFLICT(discord_message_id) DO NOTHING RETURNING id`,
        [randomUUID(), scope.guild, scope.channel, message, scope.owner, safe],
      );
      if (!claim.rowCount) return { inserted: false };
      if (route !== "execute" && route !== "loop") return { inserted: true };
      const result = await client.query(
        `INSERT INTO chatops_runs(id,guild_id,channel_id,owner_id,message_id,route,model,task_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [
          randomUUID(),
          scope.guild,
          scope.channel,
          scope.owner,
          message,
          route,
          model,
          textDigest(safe),
        ],
      );
      return { inserted: true, run: chatRunSchema.parse(result.rows[0]) };
    });
  }
  async prepare(
    scope: ChatScope,
    message: string,
    route: "execute" | "loop",
    task: string,
    model = "gpt-5.3-codex-spark",
  ): Promise<ChatRun | undefined> {
    scopeSchema.parse(scope);
    const result = await this.db.pool.query(
      `INSERT INTO chatops_runs(id,guild_id,channel_id,owner_id,message_id,route,model,task_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(message_id) DO NOTHING RETURNING *`,
      [
        randomUUID(),
        scope.guild,
        scope.channel,
        scope.owner,
        message,
        route,
        model,
        textDigest(redactChat(task).slice(0, 20000)),
      ],
    );
    return result.rows[0] ? chatRunSchema.parse(result.rows[0]) : undefined;
  }
  async transition(
    id: string,
    expected: RunPhase,
    next: RunPhase,
    evidence: RunEvidence = {},
  ): Promise<ChatRun> {
    runPhaseSchema.parse(next);
    runPhaseSchema.parse(expected);
    const safe = runEvidenceSchema.parse(
      JSON.parse(redactChat(JSON.stringify(runEvidenceSchema.parse(evidence)))),
    );
    const result = await this.db.pool.query(
      `UPDATE chatops_runs SET phase=$3,evidence=$4 WHERE id=$1 AND phase=$2 RETURNING *`,
      [id, expected, next, safe],
    );
    if (!result.rows[0]) throw new Error("Run state changed");
    return chatRunSchema.parse(result.rows[0]);
  }
  async get(id: string): Promise<ChatRun> {
    const result = await this.db.pool.query(
      "SELECT * FROM chatops_runs WHERE id=$1",
      [id],
    );
    return chatRunSchema.parse(result.rows[0]);
  }
  async recent(scope: ChatScope): Promise<ChatRun[]> {
    scopeSchema.parse(scope);
    const result = await this.db.pool.query(
      "SELECT * FROM chatops_runs WHERE guild_id=$1 AND channel_id=$2 AND owner_id=$3 ORDER BY CASE WHEN phase IN ('running','cancel_requested','accepted') THEN 0 ELSE 1 END,created_at DESC,id DESC LIMIT 5",
      [scope.guild, scope.channel, scope.owner],
    );
    return result.rows.map((row) => chatRunSchema.parse(row));
  }
  async recover(): Promise<number> {
    const result = await this.db.pool.query(
      "UPDATE chatops_runs SET phase='interrupted',evidence=evidence || '{\"reason\":\"restart\"}'::jsonb WHERE phase IN ('prepared','accepted','running','cancel_requested')",
    );
    return result.rowCount ?? 0;
  }
  async remember(
    scope: ChatScope,
    message: string,
    content: string,
  ): Promise<ChatMemory> {
    scopeSchema.parse(scope);
    const safe = redactChat(content).trim().slice(0, 2000);
    if (!safe) throw new Error("Empty memory");
    return this.db.transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO chatops_memory(id,guild_id,channel_id,owner_id,message_id,content,digest,state) VALUES($1,$2,$3,$4,$5,$6,$7,'candidate') ON CONFLICT(message_id) DO NOTHING RETURNING *`,
        [
          randomUUID(),
          scope.guild,
          scope.channel,
          scope.owner,
          message,
          safe,
          textDigest(safe),
        ],
      );
      if (!result.rows[0]) throw new Error("Duplicate memory message");
      const candidate = memorySchema.parse(result.rows[0]);
      const approved = await client.query(
        "UPDATE chatops_memory SET state='approved',revision=revision+1 WHERE id=$1 RETURNING *",
        [candidate.id],
      );
      return memorySchema.parse(approved.rows[0]);
    });
  }
  async memories(scope: ChatScope): Promise<ChatMemory[]> {
    scopeSchema.parse(scope);
    const result = await this.db.pool.query(
      "SELECT * FROM chatops_memory WHERE guild_id=$1 AND channel_id=$2 AND owner_id=$3 AND state='approved' ORDER BY created_at DESC,id DESC LIMIT 20",
      [scope.guild, scope.channel, scope.owner],
    );
    return result.rows.map((row) => memorySchema.parse(row));
  }
  async findMemory(
    scope: ChatScope,
    id: string,
  ): Promise<ChatMemory | undefined> {
    scopeSchema.parse(scope);
    const result = await this.db.pool.query(
      "SELECT * FROM chatops_memory WHERE id=$1 AND guild_id=$2 AND channel_id=$3 AND owner_id=$4 AND state='approved'",
      [id, scope.guild, scope.channel, scope.owner],
    );
    return result.rows[0] ? memorySchema.parse(result.rows[0]) : undefined;
  }
  async changeMemory(
    scope: ChatScope,
    id: string,
    revision: number,
    digest: string,
    state: "forgotten" | "superseded",
  ): Promise<ChatMemory> {
    scopeSchema.parse(scope);
    memorySchema.shape.state.parse(state);
    const result = await this.db.pool.query(
      "UPDATE chatops_memory SET state=$7,revision=revision+1 WHERE id=$1 AND guild_id=$2 AND channel_id=$3 AND owner_id=$4 AND revision=$5 AND digest=$6 AND state='approved' RETURNING *",
      [id, scope.guild, scope.channel, scope.owner, revision, digest, state],
    );
    return memorySchema.parse(result.rows[0]);
  }
}
