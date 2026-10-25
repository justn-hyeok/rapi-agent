import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelBudgetExceededError, type ModelClient } from "@rapi/adapters";
import {
  BlogService,
  GhBlogPullRequests,
  createBlogService,
  type BlogPublisher,
} from "@rapi/agent";
import {
  canTransitionBlogPost,
  parseGuideContent,
  renderGuidePost,
  renderIssuePost,
  type DeliveryPayload,
  type DeliveryTarget,
} from "@rapi/core";
import type {
  BlogPostRecord,
  BlogPostStatus,
  BlogPostsStore,
  NewBlogPost,
} from "@rapi/db";

const owner = "123456789012345678";
const stranger = "223456789012345678";

class FakeStore {
  posts: BlogPostRecord[] = [];
  /** When each post was last approved; the reminder looks at its age. */
  approvedAt = new Map<string, Date>();
  reminded = new Set<string>();
  private seq = 0;
  async create(input: NewBlogPost) {
    if (
      this.posts.some(
        (p) =>
          p.slug === input.slug ||
          (input.sourceIssueId && p.sourceIssueId === input.sourceIssueId),
      )
    )
      return null;
    const id = `00000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`;
    const post: BlogPostRecord = {
      id,
      slug: input.slug,
      kind: input.kind,
      status: input.kind === "issue" ? "approved" : "draft",
      origin: input.origin,
      title: input.title,
      description: input.description,
      mdx: input.mdx,
      topic: input.topic ?? null,
      sourceIssueId: input.sourceIssueId ?? null,
      revision: 1,
      prUrl: null,
      prBranch: null,
      removePrUrl: null,
      removePrBranch: null,
      publishedAt: null,
    };
    this.posts.push(post);
    return { ...post };
  }
  async get(id: string) {
    const post = this.posts.find((p) => p.id === id);
    return post ? { ...post } : null;
  }
  async getBySlug(slug: string) {
    const post = this.posts.find((p) => p.slug === slug);
    return post ? { ...post } : null;
  }
  async transition(id: string, from: BlogPostStatus[], to: BlogPostStatus) {
    const post = this.posts.find((p) => p.id === id);
    if (!post || !from.includes(post.status)) return false;
    assert(canTransitionBlogPost(post.status, to));
    post.status = to;
    this.reminded.delete(id);
    if (to === "approved") this.approvedAt.set(id, new Date());
    if (to === "published") post.publishedAt = new Date();
    if (to === "draft") post.prUrl = post.prBranch = null;
    return true;
  }
  async reviseDraft(
    id: string,
    revision: number,
    next: { title: string; description: string; mdx: string },
  ) {
    const post = this.posts.find((p) => p.id === id);
    if (!post || post.status !== "draft" || post.revision !== revision)
      return false;
    Object.assign(post, next, { revision: revision + 1 });
    return true;
  }
  async discardDraft(id: string) {
    const index = this.posts.findIndex(
      (p) => p.id === id && p.status === "draft",
    );
    if (index < 0) return false;
    this.posts.splice(index, 1);
    return true;
  }
  async recordPr(
    id: string,
    kind: "add" | "remove",
    url: string,
    branch: string,
  ) {
    const post = this.posts.find((p) => p.id === id)!;
    if (kind === "add") Object.assign(post, { prUrl: url, prBranch: branch });
    else Object.assign(post, { removePrUrl: url, removePrBranch: branch });
  }
  private pick(fn: (p: BlogPostRecord) => boolean) {
    return this.posts.filter(fn).map((p) => ({ ...p }));
  }
  async awaitingPullRequest() {
    return this.pick((p) => p.status === "approved" && !p.prUrl);
  }
  async openPullRequests() {
    return this.pick((p) => p.status === "approved" && !!p.prUrl);
  }
  async stalePullRequests(cutoff: Date) {
    return this.pick(
      (p) =>
        p.status === "approved" &&
        !!p.prUrl &&
        !this.reminded.has(p.id) &&
        (this.approvedAt.get(p.id) ?? new Date(0)) < cutoff,
    );
  }
  async claimApprovalReminder(id: string) {
    if (this.reminded.has(id)) return false;
    this.reminded.add(id);
    return true;
  }
  async awaitingRemoval() {
    return this.pick(
      (p) => p.status === "withdrawn" && !p.removePrUrl && !!p.prUrl,
    );
  }
  async lastCreatedAt() {
    return null;
  }
  async topicUsed(topic: string) {
    return this.posts.some((p) => p.topic === topic);
  }
  // Mirrors the SQL: only published posts are visible to the archive.
  published() {
    return this.posts.filter((p) => p.status === "published");
  }
}

function setup(
  options: { publish?: boolean; drafts?: boolean; model?: ModelClient } = {},
) {
  const store = new FakeStore();
  const sent: Array<{ target: DeliveryTarget; payload: DeliveryPayload }> = [];
  const prs = { add: [] as string[], remove: [] as string[], failAdd: false };
  const state: { value: "open" | "merged" | "closed" } = { value: "open" };
  const withdrawn: string[] = [];
  const publisher: BlogPublisher = {
    async openAddPullRequest(input) {
      if (prs.failAdd) throw new Error("gh failed");
      prs.add.push(input.mdx);
      return { url: `https://github.com/x/y/pull/${prs.add.length}` };
    },
    async openRemovePullRequest(input) {
      prs.remove.push(input.slug);
      return { url: "https://github.com/x/y/pull/99" };
    },
    async pullRequestState() {
      return state.value;
    },
  };
  const service = new BlogService(
    {
      store: store as never,
      delivery: {
        async send(target, payload) {
          sent.push({ target, payload });
          return { providerId: String(sent.length) };
        },
      },
      publisher,
      withdrawals: { record: async (slug) => void withdrawn.push(slug) },
      ...(options.model ? { models: options.model } : {}),
    } as ConstructorParameters<typeof BlogService>[0],
    {
      superadminIds: [owner],
      publishEnabled: options.publish ?? true,
      draftsEnabled: options.drafts ?? true,
      publicBaseUrl: "https://rapi.example",
    },
  );
  return { store, sent, prs, state, withdrawn, service };
}

const guideJson = JSON.stringify({
  title: "Codex 처음 쓰기",
  description: "설치부터 첫 질문까지",
  sections: [
    {
      heading: "설치",
      body: "먼저 <script>alert(1)</script> 설치해요.\n\n다음 {단계}",
    },
    { heading: "첫 질문", body: "한 줄로 물어보세요." },
  ],
  sources: [
    { title: "공식 문서", url: "https://example.com/docs" },
    { title: "수상한 곳", url: "javascript:alert(1)" },
  ],
});
const model = (text = guideJson): ModelClient => ({
  async complete() {
    return {
      text,
      model: "fake",
      usage: { inputTokens: 1, outputTokens: 1, costMicroUsd: 0 },
    };
  },
});

const issue = {
  id: "11111111-1111-4111-8111-111111111111",
  cadence: "daily" as const,
  periodKey: "2026-10-26",
  items: [
    {
      section: "core" as const,
      title: "무료 <b>모델</b> [링크](javascript:x) {x}",
      summary: "요약입니다. ".repeat(100),
      url: "https://example.com/a?x=1",
    },
    {
      section: "tools" as const,
      title: "위험한 주소",
      summary: "버려져야 해요",
      url: "http://insecure.example/",
    },
  ],
};

test("issue MDX holds only escaped titles, clipped summaries and https links", () => {
  const post = renderIssuePost(issue, new Date("2026-10-26T00:00:00Z"));
  assert.equal(post.slug, "learner-daily-2026-10-26");
  assert.match(post.mdx, /^---\ntitle: /);
  assert.match(post.mdx, /visibility: public/);
  const body = post.mdx.split("\n---\n")[1]!;
  assert.doesNotMatch(body, /<b>|<script|\{x\}|\[링크\]|\]\(javascript:/);
  assert.doesNotMatch(body, /도구 입문/);
  assert.match(body, /\]\(https:\/\/example\.com\/a\?x=1\)/);
  assert.doesNotMatch(body, /insecure|버려져야/);
  const summary = body.split("\n").find((l) => l.startsWith("요약입니다"))!;
  assert.ok(summary.length <= 401);
  assert.throws(
    () => renderIssuePost({ ...issue, items: [issue.items[1]!] }, new Date()),
    /linked item/,
  );
});

test("guide MDX is inert text and only cites https sources", () => {
  const content = parseGuideContent(guideJson);
  assert.equal(content.sources.length, 1);
  const mdx = renderGuidePost("guide-1", content, new Date());
  assert.doesNotMatch(mdx.split("\n---\n")[1]!, /<script|\{단계\}/);
  assert.throws(() => parseGuideContent("not json"), /JSON/);
  assert.throws(() => parseGuideContent('{"title":"t"}'), /없습니다/);
});

test("state machine: nothing leaves withdrawn, drafts cannot jump to published", () => {
  assert.ok(canTransitionBlogPost("draft", "approved"));
  assert.ok(canTransitionBlogPost("approved", "published"));
  assert.ok(canTransitionBlogPost("published", "withdrawn"));
  assert.ok(!canTransitionBlogPost("draft", "published"));
  assert.ok(!canTransitionBlogPost("withdrawn", "published"));
  assert.ok(!canTransitionBlogPost("published", "draft"));
});

test("issue sent → approved post, PR opened once, merge publishes and DMs", async () => {
  const { store, prs, state, service, sent } = setup();
  await service.onIssueSent(issue);
  await service.onIssueSent(issue);
  assert.equal(store.posts.length, 1);
  assert.equal(store.posts[0]!.status, "approved");
  // [발송] only records the post; the worker opens the PR.
  assert.equal(prs.add.length, 0);
  await service.runDue(new Date());
  assert.equal(prs.add.length, 1);
  assert.deepEqual(store.published(), []);
  await service.runDue(new Date());
  assert.equal(store.posts[0]!.status, "approved");
  state.value = "merged";
  await service.runDue(new Date());
  assert.equal(store.published().length, 1);
  const dm = sent.at(-1)!.payload.discord!;
  assert.match(
    JSON.stringify(dm.components),
    /blog_withdraw:00000000-0000-4000-8000-000000000001/,
  );
  assert.match(
    dm.content!,
    /rapi\.example\/blog\/learner-daily-2026-10-26\.html/,
  );
});

test("a closed PR returns the post to draft instead of publishing", async () => {
  const { store, state, service } = setup();
  await service.onIssueSent(issue);
  state.value = "closed";
  await service.runDue(new Date());
  assert.equal(store.posts[0]!.status, "draft");
  assert.deepEqual(store.published(), []);
});

test("failed PR open is retried by the worker without a second post", async () => {
  const { store, prs, service } = setup();
  prs.failAdd = true;
  await service.onIssueSent(issue);
  await assert.rejects(service.runDue(new Date()), /gh failed/);
  assert.equal(store.posts[0]!.prUrl, null);
  prs.failAdd = false;
  await service.runDue(new Date());
  assert.ok(store.posts[0]!.prUrl);
  assert.equal(store.posts.length, 1);
});

test("issue → blog does nothing unless publishEnabled", async () => {
  const { store, service } = setup({ publish: false });
  await service.onIssueSent(issue);
  assert.equal(store.posts.length, 0);
});

test("draft request: stored as draft, previewed with buttons, redelivery is a no-op", async () => {
  const { store, sent, service } = setup({ model: model() });
  const identity = { userId: owner };
  assert.match(
    await service.requestDraft(identity, "Codex 입문", "555"),
    /DM으로 보냈어요/,
  );
  assert.equal(store.posts.length, 1);
  assert.equal(store.posts[0]!.status, "draft");
  assert.equal(store.posts[0]!.kind, "guide");
  const buttons = JSON.stringify(sent.at(-1)!.payload.discord!.components);
  for (const action of ["publish", "revise", "discard"])
    assert.match(buttons, new RegExp(`blog_${action}:`));
  const before = sent.length;
  assert.match(
    await service.requestDraft(identity, "Codex 입문", "555"),
    /이미 받은 요청/,
  );
  assert.equal(sent.length, before);
  assert.equal(store.posts.length, 1);
});

test("model failures leave no post and send no preview", async () => {
  for (const failing of [
    {
      async complete(): Promise<never> {
        throw new Error("boom");
      },
    },
    {
      async complete(): Promise<never> {
        throw new ModelBudgetExceededError("blog_draft");
      },
    },
    model("{broken"),
    model('{"title":"x","description":"y","sections":[]}'),
  ] as ModelClient[]) {
    const { store, sent, service } = setup({ model: failing });
    const reply = await service.requestDraft({ userId: owner }, "주제", "1");
    assert.match(reply, /못했어요|예산/);
    assert.equal(store.posts.length, 0);
    assert.equal(sent.length, 0);
  }
});

test("drafts are off without the flag or a model client", async () => {
  assert.match(
    await setup({ drafts: false, model: model() }).service.requestDraft(
      { userId: owner },
      "주제",
      "1",
    ),
    /꺼져/,
  );
  assert.match(
    await setup().service.requestDraft({ userId: owner }, "주제", "1"),
    /꺼져/,
  );
});

test("SUPERADMIN only: strangers cannot request, press or open the modal", async () => {
  const { store, service } = setup({ model: model() });
  await service.requestDraft({ userId: owner }, "주제", "1");
  const id = store.posts[0]!.id;
  const intruder = { userId: stranger };
  await assert.rejects(service.requestDraft(intruder, "x", "2"), /소유자/);
  for (const action of [
    "publish",
    "discard",
    "discard_confirm",
    "withdraw",
    "revise",
  ])
    await assert.rejects(
      service.handleComponent(intruder, `blog_${action}:${id}`),
      /소유자/,
    );
  assert.throws(
    () => service.reviseModal(intruder, `blog_revise:${id}`),
    /소유자/,
  );
  await assert.rejects(
    service.handleNote(intruder, `blog_note:${id}`, "고쳐"),
    /소유자/,
  );
  assert.equal(store.posts[0]!.status, "draft");
});

test("[게시] is idempotent: one PR, second press reports the state", async () => {
  const { store, prs, service } = setup({ model: model() });
  await service.requestDraft({ userId: owner }, "주제", "1");
  const id = store.posts[0]!.id;
  const press = () =>
    service.handleComponent({ userId: owner }, `blog_publish:${id}`);
  const results = await Promise.all([press(), press()]);
  assert.equal(prs.add.length, 1);
  assert.ok(results.some((r) => /이미 게시를 승인/.test(r)));
  assert.match(await press(), /이미 게시를 승인/);
  assert.equal(store.posts[0]!.status, "approved");
});

test("[버리기] deletes a draft once and refuses approved posts", async () => {
  const { store, service } = setup({ model: model() });
  await service.requestDraft({ userId: owner }, "주제", "1");
  const id = store.posts[0]!.id;
  assert.match(
    await service.handleComponent(
      { userId: owner },
      `blog_discard_confirm:${id}`,
    ),
    /버렸어요/,
  );
  assert.match(
    await service.handleComponent(
      { userId: owner },
      `blog_discard_confirm:${id}`,
    ),
    /이미 버렸/,
  );
  await service.requestDraft({ userId: owner }, "주제2", "2");
  const second = store.posts[0]!.id;
  await service.handleComponent({ userId: owner }, `blog_publish:${second}`);
  assert.match(
    await service.handleComponent(
      { userId: owner },
      `blog_discard_confirm:${second}`,
    ),
    /이미 게시를 승인/,
  );
  assert.equal(store.posts.length, 1);
});

test("[수정 요청]: modal, regeneration with the note; failure keeps the draft", async () => {
  let call = 0;
  const seen: string[] = [];
  const flaky: ModelClient = {
    async complete(request) {
      seen.push(request.messages[0]!.content);
      call += 1;
      if (call === 3) throw new Error("boom");
      return {
        text:
          call === 2
            ? guideJson.replace("Codex 처음 쓰기", "고친 제목")
            : guideJson,
        model: "fake",
        usage: { inputTokens: 1, outputTokens: 1, costMicroUsd: 0 },
      };
    },
  };
  const { store, sent, service } = setup({ model: flaky });
  const identity = { userId: owner };
  await service.requestDraft(identity, "주제", "1");
  const post = store.posts[0]!;
  const modal = service.reviseModal(identity, `blog_revise:${post.id}`) as {
    custom_id: string;
  };
  assert.equal(modal.custom_id, `blog_note:${post.id}`);
  assert.ok(BlogService.handlesNote(modal.custom_id));
  const before = sent.length;
  assert.match(
    await service.handleNote(identity, modal.custom_id, "더 짧게"),
    /다시 보냈어요/,
  );
  assert.match(seen[1]!, /수정 요청: 더 짧게/);
  assert.equal(store.posts[0]!.title, "고친 제목");
  assert.equal(store.posts[0]!.revision, 2);
  assert.ok(sent.length > before);
  const after = sent.length;
  assert.match(
    await service.handleNote(identity, modal.custom_id, "또 고쳐"),
    /못했어요/,
  );
  assert.equal(store.posts[0]!.title, "고친 제목");
  assert.equal(store.posts[0]!.revision, 2);
  assert.equal(sent.length, after);
  await service.handleComponent(identity, `blog_publish:${post.id}`);
  assert.match(
    await service.handleNote(identity, modal.custom_id, "늦었어요"),
    /이미 게시를 승인/,
  );
});

test("[내리기]: published → withdrawn, hidden at once, removal PR, idempotent", async () => {
  const { store, prs, state, withdrawn, service } = setup();
  await service.onIssueSent(issue);
  state.value = "merged";
  await service.runDue(new Date());
  const id = store.posts[0]!.id;
  assert.equal(store.published().length, 1);
  const press = () =>
    service.handleComponent({ userId: owner }, `blog_withdraw:${id}`);
  assert.match(await press(), /내렸어요/);
  assert.equal(store.posts[0]!.status, "withdrawn");
  assert.deepEqual(store.published(), []);
  assert.deepEqual(withdrawn, ["learner-daily-2026-10-26"]);
  assert.deepEqual(prs.remove, ["learner-daily-2026-10-26"]);
  assert.match(await press(), /이미 내린/);
  assert.equal(prs.remove.length, 1);
  await service.runDue(new Date());
  assert.equal(prs.remove.length, 1);
  assert.equal(store.posts[0]!.status, "withdrawn");
});

test("a draft or approved post cannot be withdrawn", async () => {
  const { store, service } = setup();
  await service.onIssueSent(issue);
  const reply = await service.handleComponent(
    { userId: owner },
    `blog_withdraw:${store.posts[0]!.id}`,
  );
  assert.match(reply, /이미 게시를 승인/);
  assert.equal(store.posts[0]!.status, "approved");
});

test("weekly job proposes one unused topic and only when drafts are on", async () => {
  const topics = [
    {
      key: "a",
      title: "도구 A",
      summary: "요약",
      url: "https://example.com/a",
    },
    {
      key: "b",
      title: "도구 B",
      summary: "요약",
      url: "https://example.com/b",
    },
  ];
  const { store, service } = (() => {
    const base = setup({ drafts: true, model: model() });
    const inner = new BlogService(
      {
        store: base.store as never,
        delivery: { send: async () => ({ providerId: "1" }) },
        publisher: {} as BlogPublisher,
        models: model(),
        recentTopics: async () => topics,
      },
      { superadminIds: [owner], publishEnabled: false, draftsEnabled: true },
    );
    return { store: base.store, service: inner };
  })();
  await service.runDue(new Date("2026-10-26T01:00:00Z"));
  assert.equal(store.posts.length, 1);
  assert.equal(store.posts[0]!.origin, "weekly");
  assert.equal(store.posts[0]!.topic, "weekly:a");
  assert.equal(store.posts[0]!.status, "draft");
});

test("all blog features are off by default in the factory", () => {
  const base = {
    BLOG_PUBLISH_ENABLED: false,
    BLOG_DRAFTS_ENABLED: false,
    BLOG_REPO: "a/b",
    BLOG_BASE_BRANCH: "main",
    DISCORD_SUPERADMIN_USER_IDS: [owner],
  };
  const args = [
    {} as BlogPostsStore,
    {} as never,
    { send: async () => ({ providerId: "1" }) },
  ] as const;
  assert.equal(createBlogService(base, ...args), undefined);
  assert.ok(createBlogService({ ...base, BLOG_DRAFTS_ENABLED: true }, ...args));
  assert.equal(
    createBlogService(
      { ...base, BLOG_PUBLISH_ENABLED: true, DISCORD_SUPERADMIN_USER_IDS: [] },
      ...args,
    ),
    undefined,
  );
});

test("GhBlogPullRequests adds and removes only the slug's MDX file", async () => {
  const calls: string[][] = [];
  const written: string[] = [];
  const git = new GhBlogPullRequests({
    repo: "a/b",
    baseBranch: "main",
    exec: async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "pr" && args[1] === "list")
        return { code: 0, stdout: "[]", stderr: "" };
      if (args[0] === "repo" && args[1] === "clone") {
        const { mkdir, writeFile } = await import("node:fs/promises");
        const dir = args[3]!;
        await mkdir(`${dir}/apps/blog/content`, { recursive: true });
        await writeFile(`${dir}/apps/blog/content/old.mdx`, "x");
        written.push(dir);
      }
      if (args[0] === "pr" && args[1] === "create")
        return {
          code: 0,
          stdout: "https://github.com/a/b/pull/1\n",
          stderr: "",
        };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  const url = await git.openAddPullRequest({
    slug: "new-post",
    mdx: "---\n---\n",
    branch: "rapi-blog/new-post",
    title: "t",
    body: "b",
  });
  assert.equal(url.url, "https://github.com/a/b/pull/1");
  assert.ok(
    calls.some(
      (c) => c[0] === "git" && c.at(-1) === "apps/blog/content/new-post.mdx",
    ),
  );
  await git.openRemovePullRequest({
    slug: "old",
    branch: "rapi-blog-remove/old",
    title: "t",
    body: "b",
  });
  await assert.rejects(
    git.openAddPullRequest({
      slug: "../evil",
      mdx: "",
      branch: "b",
      title: "t",
      body: "b",
    }),
    /슬러그/,
  );
});

test("withdrawal list is written before the state changes; a write failure keeps the post", async () => {
  const { store, state, service, prs } = setup();
  await service.onIssueSent(issue);
  state.value = "merged";
  await service.runDue(new Date());
  const ports = (
    service as unknown as {
      ports: { withdrawals: { record(slug: string): Promise<void> } };
    }
  ).ports;
  const record: (slug: string) => Promise<void> = async () => undefined;
  ports.withdrawals.record = async () => {
    throw new Error("EACCES");
  };
  const id = store.posts[0]!.id;
  assert.match(
    await service.handleComponent({ userId: owner }, `blog_withdraw:${id}`),
    /내리지 않았어요/,
  );
  assert.equal(store.posts[0]!.status, "published");
  assert.equal(prs.remove.length, 0);
  ports.withdrawals.record = record;
  assert.match(
    await service.handleComponent({ userId: owner }, `blog_withdraw:${id}`),
    /내렸어요/,
  );
  assert.equal(store.posts[0]!.status, "withdrawn");
});

test("[버리기] asks first; only [정말 버리기] discards, [돌아가기] restores the buttons", async () => {
  const { store, service } = setup({ model: model() });
  await service.requestDraft({ userId: owner }, "주제", "1");
  const id = store.posts[0]!.id;
  const first = await service.handleButton(
    { userId: owner },
    `blog_discard:${id}`,
  );
  assert.match(first.prompt ?? "", /정말 버릴까요/);
  assert.equal(first.result, undefined);
  const ids = JSON.stringify(first.components);
  assert.ok(ids.includes(`blog_discard_confirm:${id}`));
  assert.ok(ids.includes(`blog_discard_cancel:${id}`));
  assert.equal(store.posts.length, 1);
  const back = await service.handleButton(
    { userId: owner },
    `blog_discard_cancel:${id}`,
  );
  assert.equal(back.prompt, undefined);
  assert.ok(JSON.stringify(back.components).includes(`blog_publish:${id}`));
  assert.equal(store.posts.length, 1);
  const done = await service.handleButton(
    { userId: owner },
    `blog_discard_confirm:${id}`,
  );
  assert.match(done.result ?? "", /버렸어요/);
  assert.equal(store.posts.length, 0);
  // A stale first-step button answers the state instead of asking again.
  assert.match(
    (await service.handleButton({ userId: owner }, `blog_discard:${id}`))
      .result ?? "",
    /이미 버렸/,
  );
});

test("a post stuck in approved with an open PR gets one reminder with the PR link", async () => {
  const { store, sent, service } = setup({ model: model() });
  await service.requestDraft({ userId: owner }, "주제", "1");
  const id = store.posts[0]!.id;
  await service.handleComponent({ userId: owner }, `blog_publish:${id}`);
  const dms = () =>
    sent.filter((entry) => entry.payload.subject === "블로그").length;
  const before = dms();
  const approved = store.approvedAt.get(id)!;
  await service.runDue(new Date(approved.getTime() + 23 * 3_600_000));
  assert.equal(dms(), before);
  await service.runDue(new Date(approved.getTime() + 25 * 3_600_000));
  assert.equal(dms(), before + 1);
  const reminder = sent.at(-1)!.payload;
  assert.match(reminder.text, /https:\/\/github\.com\/x\/y\/pull\/1/);
  await service.runDue(new Date(approved.getTime() + 49 * 3_600_000));
  assert.equal(dms(), before + 1);
});
