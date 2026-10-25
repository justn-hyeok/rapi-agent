import { randomUUID } from "node:crypto";
import type { PostgresStore } from "./postgres-store.js";

/** Reservations survive errors/restarts: a failed session may already have read posts. */
export class BrowserResearchStore {
  constructor(private readonly db: PostgresStore) {}

  async reserve(input: {
    requestId: string;
    ownerId: string;
    site: string;
    posts: number;
    dailyPosts: number;
  }): Promise<string> {
    const c = await this.db.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(731904230)");
      const previous = await c.query(
        "SELECT id FROM browser_research_runs WHERE request_id=$1",
        [input.requestId],
      );
      if (previous.rowCount) throw new Error("이미 처리한 조사 요청입니다.");
      const usage = await c.query<{ posts: number }>(
        `SELECT COALESCE(sum(reserved_posts),0)::int AS posts FROM browser_research_runs
         WHERE site=$1 AND created_at >= now() - interval '24 hours'`,
        [input.site],
      );
      if (usage.rows[0]!.posts + input.posts > input.dailyPosts)
        throw new Error("이 사이트의 24시간 조사 한도에 도달했습니다.");
      const id = randomUUID();
      await c.query(
        `INSERT INTO browser_research_runs(id,request_id,owner_id,site,reserved_posts)
         VALUES($1,$2,$3,$4,$5)`,
        [id, input.requestId, input.ownerId, input.site, input.posts],
      );
      await c.query("COMMIT");
      return id;
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    } finally {
      c.release();
    }
  }

  async record(id: string, event: Record<string, unknown>): Promise<void> {
    await this.db.pool.query(
      "UPDATE browser_research_runs SET audit=audit || $2::jsonb WHERE id=$1",
      [id, JSON.stringify([event])],
    );
  }

  async finish(id: string, status: "completed" | "failed"): Promise<void> {
    await this.db.pool.query(
      "UPDATE browser_research_runs SET status=$2,finished_at=now() WHERE id=$1",
      [id, status],
    );
  }
}
