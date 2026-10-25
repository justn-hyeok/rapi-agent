import { randomUUID } from "node:crypto";
import type { PostgresStore } from "./postgres-store.js";

export type BlogPostKind = "issue" | "guide";
export type BlogPostStatus = "draft" | "approved" | "published" | "withdrawn";
export type BlogPostOrigin = "issue" | "owner" | "weekly";

export interface BlogPostRecord {
  id: string;
  slug: string;
  kind: BlogPostKind;
  status: BlogPostStatus;
  origin: BlogPostOrigin;
  title: string;
  description: string;
  mdx: string;
  topic: string | null;
  sourceIssueId: string | null;
  revision: number;
  prUrl: string | null;
  prBranch: string | null;
  removePrUrl: string | null;
  removePrBranch: string | null;
  publishedAt: Date | null;
}

export interface NewBlogPost {
  slug: string;
  kind: BlogPostKind;
  origin: BlogPostOrigin;
  title: string;
  description: string;
  mdx: string;
  topic?: string;
  sourceIssueId?: string;
}

/** What the web archive needs; no draft or withdrawn post is ever listed. */
export interface PublishedBlogPost {
  slug: string;
  kind: BlogPostKind;
  title: string;
  description: string;
  mdx: string;
  publishedAt: Date;
}

const COLUMNS = `id,slug,kind,status,origin,title,description,mdx,topic,source_issue_id,revision,pr_url,pr_branch,remove_pr_url,remove_pr_branch,published_at`;

type Row = Record<string, unknown>;
const record = (row: Row): BlogPostRecord => ({
  id: row.id as string,
  slug: row.slug as string,
  kind: row.kind as BlogPostKind,
  status: row.status as BlogPostStatus,
  origin: row.origin as BlogPostOrigin,
  title: row.title as string,
  description: row.description as string,
  mdx: row.mdx as string,
  topic: (row.topic as string | null) ?? null,
  sourceIssueId: (row.source_issue_id as string | null) ?? null,
  revision: row.revision as number,
  prUrl: (row.pr_url as string | null) ?? null,
  prBranch: (row.pr_branch as string | null) ?? null,
  removePrUrl: (row.remove_pr_url as string | null) ?? null,
  removePrBranch: (row.remove_pr_branch as string | null) ?? null,
  publishedAt: (row.published_at as Date | null) ?? null,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class BlogPostsStore {
  constructor(private readonly db: PostgresStore) {}

  /**
   * Inserts one post. A repeated issue or slug returns null, so a retry never
   * creates a second post. Issue posts start `approved` (the owner's [발송]),
   * everything else starts as a `draft`.
   */
  async create(input: NewBlogPost): Promise<BlogPostRecord | null> {
    const result = await this.db.pool.query(
      `INSERT INTO blog_posts(id,slug,kind,status,origin,title,description,mdx,topic,source_issue_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT DO NOTHING RETURNING ${COLUMNS}`,
      [
        randomUUID(),
        input.slug,
        input.kind,
        input.kind === "issue" ? "approved" : "draft",
        input.origin,
        input.title,
        input.description,
        input.mdx,
        input.topic ?? null,
        input.sourceIssueId ?? null,
      ],
    );
    return result.rowCount ? record(result.rows[0] as Row) : null;
  }

  async get(id: string): Promise<BlogPostRecord | null> {
    if (!UUID.test(id)) return null;
    const result = await this.db.pool.query(
      `SELECT ${COLUMNS} FROM blog_posts WHERE id=$1`,
      [id],
    );
    return result.rowCount ? record(result.rows[0] as Row) : null;
  }

  async getBySlug(slug: string): Promise<BlogPostRecord | null> {
    const result = await this.db.pool.query(
      `SELECT ${COLUMNS} FROM blog_posts WHERE slug=$1`,
      [slug],
    );
    return result.rowCount ? record(result.rows[0] as Row) : null;
  }

  /** Compare-and-set; false means someone else already moved the post. */
  async transition(
    id: string,
    from: BlogPostStatus[],
    to: BlogPostStatus,
    actor?: string,
  ): Promise<boolean> {
    const result = await this.db.pool.query(
      `UPDATE blog_posts SET status=$3,updated_at=now(),
         decided_by=COALESCE($4,decided_by),
         decided_at=CASE WHEN $4::text IS NULL THEN decided_at ELSE now() END,
         published_at=CASE WHEN $3='published' THEN now() ELSE published_at END,
         withdrawn_at=CASE WHEN $3='withdrawn' THEN now() ELSE withdrawn_at END,
         pr_url=CASE WHEN $3='draft' THEN NULL ELSE pr_url END,
         pr_branch=CASE WHEN $3='draft' THEN NULL ELSE pr_branch END,
         approved_reminded_at=NULL
       WHERE id=$1 AND status=ANY($2::text[])`,
      [id, from, to, actor ?? null],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Replaces a draft's text; false when it is no longer a draft or was edited meanwhile. */
  async reviseDraft(
    id: string,
    expectedRevision: number,
    next: { title: string; description: string; mdx: string },
  ): Promise<boolean> {
    const result = await this.db.pool.query(
      `UPDATE blog_posts SET title=$3,description=$4,mdx=$5,revision=revision+1,updated_at=now()
       WHERE id=$1 AND status='draft' AND revision=$2`,
      [id, expectedRevision, next.title, next.description, next.mdx],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** [버리기]: only a draft can be dropped; a second press finds nothing. */
  async discardDraft(id: string): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const result = await this.db.pool.query(
      "DELETE FROM blog_posts WHERE id=$1 AND status='draft'",
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async recordPr(
    id: string,
    kind: "add" | "remove",
    url: string,
    branch: string,
  ): Promise<void> {
    await this.db.pool.query(
      kind === "add"
        ? "UPDATE blog_posts SET pr_url=$2,pr_branch=$3,updated_at=now() WHERE id=$1 AND status='approved'"
        : "UPDATE blog_posts SET remove_pr_url=$2,remove_pr_branch=$3,updated_at=now() WHERE id=$1 AND status='withdrawn'",
      [id, url, branch],
    );
  }

  /** Approved posts whose PR is not open yet (first attempt or a retry). */
  async awaitingPullRequest(): Promise<BlogPostRecord[]> {
    return this.list(
      "status='approved' AND pr_url IS NULL ORDER BY created_at",
    );
  }

  /** Approved posts with an open PR to watch. */
  async openPullRequests(): Promise<BlogPostRecord[]> {
    return this.list(
      "status='approved' AND pr_url IS NOT NULL ORDER BY created_at",
    );
  }

  /** Approved posts with an open PR since before `cutoff` that were not reminded about yet. */
  async stalePullRequests(cutoff: Date): Promise<BlogPostRecord[]> {
    const result = await this.db.pool.query(
      `SELECT ${COLUMNS} FROM blog_posts
       WHERE status='approved' AND pr_url IS NOT NULL AND approved_reminded_at IS NULL
         AND COALESCE(decided_at,created_at)<$1 ORDER BY created_at`,
      [cutoff],
    );
    return result.rows.map((row) => record(row as Row));
  }

  /** True for the one caller that may send the reminder. */
  async claimApprovalReminder(id: string): Promise<boolean> {
    const result = await this.db.pool.query(
      "UPDATE blog_posts SET approved_reminded_at=now() WHERE id=$1 AND status='approved' AND approved_reminded_at IS NULL",
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Withdrawn posts whose MDX file still has to leave the repository. */
  async awaitingRemoval(): Promise<BlogPostRecord[]> {
    return this.list(
      "status='withdrawn' AND remove_pr_url IS NULL AND pr_url IS NOT NULL ORDER BY withdrawn_at",
    );
  }

  /** Published posts, newest first, for the web archive and the static build. */
  async listPublishedBlogPosts(limit = 200): Promise<PublishedBlogPost[]> {
    const result = await this.db.pool.query<Row>(
      `SELECT slug,kind,title,description,mdx,published_at FROM blog_posts
       WHERE status='published' ORDER BY published_at DESC,slug LIMIT $1`,
      [Math.min(Math.max(limit, 1), 500)],
    );
    return result.rows.map((row) => ({
      slug: row.slug as string,
      kind: row.kind as BlogPostKind,
      title: row.title as string,
      description: row.description as string,
      mdx: row.mdx as string,
      publishedAt: row.published_at as Date,
    }));
  }

  /** A withdrawn or unpublished slug yields null, exactly like an unknown one. */
  async getBlogPost(slug: string): Promise<PublishedBlogPost | null> {
    const result = await this.db.pool.query(
      `SELECT slug,kind,title,description,mdx,published_at FROM blog_posts
       WHERE slug=$1 AND status='published'`,
      [slug],
    );
    const row = result.rows[0] as Row | undefined;
    return row
      ? {
          slug: row.slug as string,
          kind: row.kind as BlogPostKind,
          title: row.title as string,
          description: row.description as string,
          mdx: row.mdx as string,
          publishedAt: row.published_at as Date,
        }
      : null;
  }

  async lastCreatedAt(origin: BlogPostOrigin): Promise<Date | null> {
    const result = await this.db.pool.query<Row>(
      "SELECT max(created_at) AS at FROM blog_posts WHERE origin=$1",
      [origin],
    );
    return (result.rows[0]?.at as Date | null) ?? null;
  }

  async topicUsed(topic: string): Promise<boolean> {
    const result = await this.db.pool.query(
      "SELECT 1 FROM blog_posts WHERE topic=$1 LIMIT 1",
      [topic],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private async list(where: string): Promise<BlogPostRecord[]> {
    const result = await this.db.pool.query(
      `SELECT ${COLUMNS} FROM blog_posts WHERE ${where}`,
    );
    return result.rows.map((row) => record(row as Row));
  }
}
