import assert from "node:assert/strict";
import { test } from "node:test";
import { LearnerExperiment } from "@rapi/agent";
import {
  learnerIssueBoundary,
  learnerItemFromPost,
  learnerLinkKey,
  learnerReportBoundary,
  learnerVerdict,
  selectLearnerItems,
  signLearnerLink,
  verifyLearnerLink,
  type DeliveryPayload,
  type DeliveryTarget,
  type LearnerMetrics,
} from "@rapi/core";
import { countDirectReply } from "../apps/chat/src/direct-message.js";

const key = learnerLinkKey("k".repeat(32));
const item = "11111111-1111-4111-8111-111111111111";
const user = "123456789012345678";

test("learner links verify only for their item, recipient, key and lifetime", () => {
  const now = new Date("2026-10-26T00:00:00Z");
  const token = signLearnerLink(key, item, user, now);
  assert.deepEqual(verifyLearnerLink(key, token, now), {
    itemId: item,
    userId: user,
  });
  assert.ok(!token.includes("http"));
  const [, , expires, sig] = token.split(".");
  assert.equal(
    verifyLearnerLink(key, `${item}.223456789012345678.${expires}.${sig}`, now),
    null,
  );
  assert.equal(
    verifyLearnerLink(
      key,
      `22222222-2222-4222-8222-222222222222.${user}.${expires}.${sig}`,
      now,
    ),
    null,
  );
  assert.equal(
    verifyLearnerLink(learnerLinkKey("j".repeat(32)), token, now),
    null,
  );
  assert.equal(
    verifyLearnerLink(key, token, new Date("2027-02-01T00:00:00Z")),
    null,
  );
  assert.equal(verifyLearnerLink(key, `${token}x`, now), null);
  assert.equal(verifyLearnerLink(key, "https://evil.example", now), null);
});

test("learner items need an https link without credentials", () => {
  const post = (embed: Record<string, unknown>) => ({
    key: "k",
    feed: "setup",
    title: null,
    data: {},
    embeds: [embed],
  });
  assert.equal(
    learnerItemFromPost(post({ title: "t", url: "http://a.example" })),
    null,
  );
  assert.equal(
    learnerItemFromPost(post({ title: "t", url: "https://u:p@a.example" })),
    null,
  );
  assert.equal(
    learnerItemFromPost(post({ title: "t", url: "javascript:alert(1)" })),
    null,
  );
  assert.equal(
    learnerItemFromPost(
      post({ title: "t", description: "보기 https://a.example/x 끝" }),
    )?.url,
    "https://a.example/x",
  );
  const many = Array.from({ length: 12 }, (_, i) => ({
    postKey: `p${i}`,
    section: i % 2 ? ("tools" as const) : ("core" as const),
    title: `t${i}`,
    summary: "",
    url: "https://a.example",
  }));
  const picked = selectLearnerItems(many);
  assert.equal(picked.length, 8);
  assert.deepEqual(
    picked.map((entry) => entry.section),
    ["core", "core", "core", "core", "core", "core", "tools", "tools"],
  );
});

test("learner schedules follow Asia/Seoul 09:00, Monday 09:00 and Monday 10:00", () => {
  const daily = (iso: string) => learnerIssueBoundary("daily", new Date(iso));
  // 08:59 Seoul is still the previous day's period; 09:00 starts the new one.
  assert.equal(daily("2026-10-26T23:59:00Z").key, "2026-10-26");
  assert.equal(daily("2026-10-26T00:00:00Z").key, "2026-10-26");
  assert.equal(daily("2026-10-25T23:59:00Z").key, "2026-10-25");
  assert.equal(daily("2026-10-27T00:00:00Z").key, "2026-10-27");
  assert.equal(
    daily("2026-10-27T00:00:00Z").at.toISOString(),
    "2026-10-27T00:00:00.000Z",
  );
  // 2026-10-26 is a Monday.
  const weekly = (iso: string) => learnerIssueBoundary("weekly", new Date(iso));
  assert.equal(weekly("2026-10-26T00:00:00Z").key, "2026-10-26");
  assert.equal(weekly("2026-10-25T23:59:00Z").key, "2026-10-19");
  assert.equal(weekly("2026-10-30T10:00:00Z").key, "2026-10-26");
  assert.equal(weekly("2026-11-01T14:59:00Z").key, "2026-10-26");
  assert.equal(weekly("2026-11-01T15:00:00Z").key, "2026-10-26");
  assert.equal(weekly("2026-11-01T23:59:00Z").key, "2026-10-26");
  assert.equal(weekly("2026-11-02T00:00:00Z").key, "2026-11-02");
  const report = (iso: string) => learnerReportBoundary(new Date(iso));
  assert.equal(report("2026-10-26T00:59:00Z").key, "2026-10-19");
  assert.equal(report("2026-10-26T01:00:00Z").key, "2026-10-26");
  assert.equal(
    report("2026-10-26T01:00:00Z").at.toISOString(),
    "2026-10-26T01:00:00.000Z",
  );
});

const base: LearnerMetrics = {
  activeSubscribers: 10,
  weeklyClickers: 4,
  replies: 2,
  optOuts: 1,
  emailYes: 0,
  emailNo: 0,
};

test("learner verdict follows the phase-0 table", () => {
  assert.equal(learnerVerdict(base).status, "success");
  assert.equal(learnerVerdict(base).action, "1단계 진행");
  assert.equal(
    learnerVerdict({ ...base, weeklyClickers: 3 }).status,
    "success",
  );
  assert.equal(
    learnerVerdict({ ...base, weeklyClickers: 2 }).status,
    "in_progress",
  );
  assert.equal(learnerVerdict({ ...base, replies: 1 }).status, "in_progress");
  const stoppedByClicks = learnerVerdict({ ...base, weeklyClickers: 0 });
  assert.equal(stoppedByClicks.status, "stop");
  assert.equal(stoppedByClicks.action, "학습자 트랙 재설계");
  assert.equal(
    learnerVerdict({ ...base, weeklyClickers: 1 }).status,
    "in_progress",
  );
  assert.equal(learnerVerdict({ ...base, optOuts: 2 }).status, "stop");
  assert.equal(
    learnerVerdict({ ...base, activeSubscribers: 0, weeklyClickers: 0 }).status,
    "in_progress",
  );
  assert.equal(
    learnerVerdict({ ...base, activeSubscribers: 0, optOuts: 2 }).status,
    "stop",
  );
  assert.equal(
    learnerVerdict({ ...base, emailYes: 1, emailNo: 2 }).emailBranch,
    "1단계에서 메일 제외",
  );
  assert.equal(
    learnerVerdict({ ...base, emailYes: 2, emailNo: 2 }).emailBranch,
    null,
  );
  assert.equal(learnerVerdict(base).emailBranch, null);
});

interface Issue {
  id: string;
  cadence: "daily" | "weekly";
  periodKey: string;
  state: string;
  previewed: boolean;
  previewedAt?: Date;
  reminded?: boolean;
  items: Array<{
    id: string;
    section: "core" | "tools";
    title: string;
    summary: string;
    url: string;
  }>;
}

function fakeStore() {
  const subs = new Map<
    string,
    {
      cadence: "daily" | "weekly";
      out: boolean;
      email: boolean | null;
      asked: boolean;
    }
  >();
  const issues: Issue[] = [];
  const deliveries: Array<{ issueId: string; userId: string; state: string }> =
    [];
  const clicks: Array<{ itemId: string; userId: string }> = [];
  const posts: Array<{
    key: string;
    feed: string;
    title: string | null;
    embeds: unknown;
    data: unknown;
  }> = [];
  const store = {
    subs,
    issues,
    deliveries,
    clicks,
    posts,
    /** What `learnerMarkPreviewSent` stamps as the preview time. */
    previewClock: new Date("2100-01-01T00:00:00Z"),
    async learnerSubscribe(input: {
      userId: string;
      cadence: "daily" | "weekly";
    }) {
      subs.set(input.userId, {
        cadence: input.cadence,
        out: false,
        email: subs.get(input.userId)?.email ?? null,
        asked: subs.get(input.userId)?.asked ?? false,
      });
    },
    async learnerSetCadence(userId: string, cadence: "daily" | "weekly") {
      const sub = subs.get(userId);
      if (!sub || sub.out) return false;
      sub.cadence = cadence;
      return true;
    },
    async learnerOptOut(userId: string) {
      const sub = subs.get(userId);
      if (!sub || sub.out) return false;
      sub.out = true;
      return true;
    },
    async learnerSetEmailInterest(userId: string, value: boolean) {
      const sub = subs.get(userId);
      if (!sub || sub.out) return false;
      sub.email = value;
      return true;
    },
    async learnerActiveSubscribers(cadence: "daily" | "weekly") {
      return [...subs.entries()]
        .filter(([, sub]) => sub.cadence === cadence && !sub.out)
        .map(([userId, sub]) => ({
          userId,
          emailAsked: sub.asked || sub.email !== null,
        }));
    },
    async learnerMarkEmailAsked(userId: string) {
      subs.get(userId)!.asked = true;
    },
    async learnerCandidatePosts() {
      return posts;
    },
    async learnerLastWindowEnd() {
      return null;
    },
    async learnerCreateIssue(input: {
      cadence: "daily" | "weekly";
      periodKey: string;
      items: Array<{
        section: "core" | "tools";
        title: string;
        summary: string;
        url: string;
      }>;
    }) {
      if (
        issues.some(
          (i) => i.cadence === input.cadence && i.periodKey === input.periodKey,
        )
      )
        return null;
      const id = `00000000-0000-4000-8000-${String(issues.length).padStart(12, "0")}`;
      issues.push({
        id,
        cadence: input.cadence,
        periodKey: input.periodKey,
        state: input.items.length ? "pending" : "empty",
        previewed: false,
        items: input.items.map((entry, index) => ({
          id: `1111111${index}-1111-4111-8111-111111111111`,
          ...entry,
        })),
      });
      return input.items.length ? id : null;
    },
    async learnerIssueExists(cadence: string, periodKey: string) {
      return issues.some(
        (i) => i.cadence === cadence && i.periodKey === periodKey,
      );
    },
    async learnerIssue(id: string) {
      return issues.find((i) => i.id === id) ?? null;
    },
    async learnerIssuesAwaitingPreview() {
      return issues
        .filter((i) => i.state === "pending" && !i.previewed)
        .map((i) => i.id);
    },
    async learnerMarkPreviewSent(id: string) {
      const issue = issues.find((i) => i.id === id)!;
      issue.previewed = true;
      issue.previewedAt = store.previewClock;
    },
    async learnerIssuesNeedingReminder(from: Date, to: Date) {
      return issues
        .filter(
          (i) =>
            i.state === "pending" &&
            !i.reminded &&
            i.previewedAt &&
            i.previewedAt >= from &&
            i.previewedAt <= to,
        )
        .map((i) => i.id);
    },
    async learnerClaimPreviewReminder(id: string) {
      const issue = issues.find((i) => i.id === id)!;
      if (issue.reminded || issue.state !== "pending") return false;
      issue.reminded = true;
      return true;
    },
    async learnerDecideIssue(id: string, to: string) {
      const issue = issues.find((i) => i.id === id);
      if (!issue || issue.state !== "pending") return false;
      issue.state = to;
      return true;
    },
    async learnerFinishIssue(id: string) {
      issues.find((i) => i.id === id)!.state = "sent";
    },
    async learnerIssueState(id: string) {
      return issues.find((i) => i.id === id)?.state ?? null;
    },
    async learnerRecordDelivery(input: {
      issueId: string;
      userId: string;
      state: string;
    }) {
      deliveries.push(input);
    },
    async learnerDeliveryCounts(issueId: string) {
      const rows = deliveries.filter((d) => d.issueId === issueId);
      return {
        sent: rows.filter((d) => d.state === "sent").length,
        failed: rows.filter((d) => d.state === "failed").length,
      };
    },
    async learnerItemUrl(itemId: string) {
      for (const issue of issues)
        if (issue.state === "sent" || issue.state === "sending") {
          const found = issue.items.find((i) => i.id === itemId);
          if (found) return found.url;
        }
      return null;
    },
    async learnerRecordClick(itemId: string, userId: string) {
      clicks.push({ itemId, userId });
    },
    async learnerReportClaim() {
      return false;
    },
    async learnerReportData() {
      throw new Error("not used");
    },
  };
  return store;
}

function setup(
  extra: Partial<ConstructorParameters<typeof LearnerExperiment>[2]> = {},
) {
  const store = fakeStore();
  const sent: Array<{
    target: DeliveryTarget;
    payload: DeliveryPayload;
  }> = [];
  const failing = new Set<string>();
  const experiment = new LearnerExperiment(
    store as never,
    {
      async send(target, payload) {
        if (failing.has(target.recipientId))
          throw new Error("Discord returned 403");
        sent.push({ target, payload });
        return { providerId: "m1" };
      },
    },
    {
      superadminIds: ["900000000000000001"],
      linkSecret: "s".repeat(32),
      baseUrl: "https://rapi.example",
      pauseMs: 0,
      ...extra,
    },
  );
  store.posts.push({
    key: "setup:abc",
    feed: "setup",
    title: "Claude 설치",
    embeds: [{ title: "Claude 설치", url: "https://docs.example/install" }],
    data: {},
  });
  return { store, sent, failing, experiment };
}

const owner = { userId: "900000000000000001" };

test("an issue is built once per period, previewed to the owner and sent at most once", async () => {
  const { store, sent, failing, experiment } = setup();
  await experiment.handleComponent(
    { userId: user, guildId: "5" },
    "learner_cadence:daily",
  );
  await experiment.handleComponent(
    { userId: "123456789012345679", guildId: "5" },
    "learner_cadence:daily",
  );
  failing.add("123456789012345679");
  const now = new Date("2026-10-26T01:00:00Z");
  await experiment.runDue(now);
  await experiment.runDue(now);
  assert.equal(store.issues.filter((i) => i.cadence === "daily").length, 1);
  assert.equal(store.issues.filter((i) => i.cadence === "weekly").length, 1);
  const preview = sent.filter(
    (entry) => entry.target.recipientId === owner.userId,
  );
  assert.equal(preview.length, 2);
  const issueId = store.issues[0]!.id;
  assert.ok(
    JSON.stringify(preview[0]!.payload.discord).includes(
      `learner_issue_send:${issueId}`,
    ),
  );

  const nonOwner = await experiment.handleComponent(
    { userId: user },
    `learner_issue_send:${issueId}`,
  );
  assert.match(nonOwner.content, /운영자/);
  assert.equal(store.issues[0]!.state, "pending");

  const first = await experiment.handleComponent(
    owner,
    `learner_issue_send:${issueId}`,
  );
  assert.match(first.content, /성공 1명 · 실패 1명/);
  const second = await experiment.handleComponent(
    owner,
    `learner_issue_send:${issueId}`,
  );
  assert.match(second.content, /이미 발송/);
  await experiment.handleComponent(owner, `learner_issue_skip:${issueId}`);
  assert.equal(store.deliveries.length, 2);
  assert.equal(
    sent.filter((entry) => entry.target.recipientId === user).length,
    1,
  );
  assert.equal(store.issues[0]!.state, "sent");
});

test("a skipped issue is never sent and an empty period creates nothing", async () => {
  const { store, sent, experiment } = setup();
  await experiment.handleComponent(
    { userId: user, guildId: "5" },
    "learner_cadence:daily",
  );
  await experiment.runDue(new Date("2026-10-26T01:00:00Z"));
  const issueId = store.issues[0]!.id;
  await experiment.handleComponent(owner, `learner_issue_skip:${issueId}`);
  const reply = await experiment.handleComponent(
    owner,
    `learner_issue_send:${issueId}`,
  );
  assert.match(reply.content, /건너뛴/);
  assert.ok(!sent.some((entry) => entry.target.recipientId === user));
  store.posts.length = 0;
  await experiment.runDue(new Date("2026-10-27T01:00:00Z"));
  assert.equal(store.issues.at(-1)!.state, "empty");
});

test("issue DMs carry signed links, opt-out and preference buttons; email is asked once", async () => {
  const { store, sent, experiment } = setup();
  await experiment.handleComponent(
    { userId: user, guildId: "5" },
    "learner_cadence:daily",
  );
  await experiment.runDue(new Date("2026-10-26T01:00:00Z"));
  const issueId = store.issues[0]!.id;
  await experiment.sendIssue(issueId, owner.userId);
  const dm = sent.find((entry) => entry.target.recipientId === user)!;
  const discord = dm.payload.discord as {
    content: string;
    components: unknown[];
  };
  const ids = JSON.stringify(discord.components);
  for (const id of [
    "learner_change",
    "learner_optout",
    "learner_email:yes",
    "learner_email:no",
  ])
    assert.ok(ids.includes(id), id);
  const token = /\/r\/([^)>]+)>/.exec(discord.content)![1]!;
  assert.ok(!discord.content.includes("docs.example"));
  assert.equal(
    verifyLearnerLink(learnerLinkKey("s".repeat(32)), token)?.userId,
    user,
  );
  assert.equal(store.subs.get(user)!.asked, true);
  const again = experiment.issueMessage(store.issues[0]!, {
    userId: user,
    emailAsked: true,
  });
  assert.ok(!JSON.stringify(again.components).includes("learner_email"));
});

test("clicks redirect only to the stored URL; invalid tokens and link-preview bots do not", async () => {
  const { store, experiment } = setup();
  await experiment.handleComponent(
    { userId: user, guildId: "5" },
    "learner_cadence:daily",
  );
  await experiment.runDue(new Date("2026-10-26T01:00:00Z"));
  const issue = store.issues[0]!;
  const itemId = issue.items[0]!.id;
  const secret = learnerLinkKey("s".repeat(32));
  const token = signLearnerLink(secret, itemId, user);
  // Not yet approved: no redirect target exists.
  assert.equal(await experiment.resolveLink(token), null);
  await experiment.sendIssue(issue.id, owner.userId);
  assert.equal(
    await experiment.resolveLink(token, new Date(), "Mozilla/5.0"),
    "https://docs.example/install",
  );
  assert.deepEqual(store.clicks, [{ itemId, userId: user }]);
  assert.equal(
    await experiment.resolveLink(
      token,
      new Date(),
      "Mozilla/5.0 (compatible; Discordbot/2.0)",
    ),
    "https://docs.example/install",
  );
  assert.equal(store.clicks.length, 1);
  assert.equal(await experiment.resolveLink("https://evil.example/"), null);
  assert.equal(
    await experiment.resolveLink(
      `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`,
    ),
    null,
  );
  const unknown = signLearnerLink(
    secret,
    "99999999-9999-4999-8999-999999999999",
    user,
  );
  assert.equal(await experiment.resolveLink(unknown), null);
  assert.equal(store.clicks.length, 1);
});

test("opt-out stops delivery; cadence change and email answers need an active subscription", async () => {
  const { store, sent, experiment } = setup();
  await experiment.handleComponent(
    { userId: user, guildId: "5" },
    "learner_cadence:daily",
  );
  assert.match(
    (await experiment.handleComponent({ userId: user }, "learner_change"))
      .content,
    /빈도/,
  );
  await experiment.handleComponent({ userId: user }, "learner_cadence:weekly");
  assert.equal(store.subs.get(user)!.cadence, "weekly");
  await experiment.handleComponent({ userId: user }, "learner_email:yes");
  assert.equal(store.subs.get(user)!.email, true);
  const out = await experiment.handleComponent(
    { userId: user },
    "learner_optout",
  );
  assert.match(out.content, /보내지 않을게요/);
  assert.match(
    (await experiment.handleComponent({ userId: user }, "learner_optout"))
      .content,
    /이미/,
  );
  assert.match(
    (
      await experiment.handleComponent(
        { userId: user },
        "learner_cadence:daily",
      )
    ).content,
    /구독 중이 아니에요/,
  );
  await experiment.runDue(new Date("2026-10-26T01:00:00Z"));
  await experiment.sendIssue(store.issues[0]!.id, owner.userId);
  assert.ok(!sent.some((entry) => entry.target.recipientId === user));
});

test("direct messages are only counted for subscribers and never reach ChatOps", async () => {
  const recorded: string[] = [];
  const record = async (id: string) => {
    recorded.push(id);
    return id === user;
  };
  const dm = (author: string, extra: Record<string, unknown> = {}) => ({
    id: "1",
    channel_id: "2",
    content: "라피 서버 재시작해줘",
    author: { id: author },
    ...extra,
  });
  assert.equal(await countDirectReply(dm(user), record), "counted");
  assert.equal(await countDirectReply(dm("999"), record), "ignored");
  // Even the owner's DM is only a counted reply, nothing is executed.
  assert.equal(
    await countDirectReply(dm("900000000000000001"), record),
    "ignored",
  );
  assert.equal(
    await countDirectReply(dm(user, { guild_id: "5" }), record),
    "ignored",
  );
  assert.equal(
    await countDirectReply(
      dm(user, { author: { id: user, bot: true } }),
      record,
    ),
    "ignored",
  );
  assert.equal(await countDirectReply("garbage", record), "ignored");
  assert.deepEqual(recorded, [user, "999", "900000000000000001"]);
});

test("new free models are summarised into one core item", async () => {
  const { store, experiment } = setup();
  for (const id of ["a", "b"])
    store.posts.push({
      key: `free-model:${id}`,
      feed: "free-tokens",
      title: null,
      embeds: null,
      data: { name: id },
    });
  const items = await experiment.buildItems(new Date(0));
  assert.equal(items[0]!.title, "새 무료 모델 2개");
  assert.equal(items[0]!.section, "core");
  assert.equal(items.length, 2);
});

const emailAddressStatus = (known: Set<string>) => ({
  async statusFor(userId: string) {
    return known.has(userId) ? { state: "verified" } : null;
  },
  async sendIssue() {
    return { sent: 0, failed: 0 };
  },
});

async function sentDm(
  setupResult: ReturnType<typeof setup>,
): Promise<{ content: string; components: unknown[] }> {
  const { store, sent, experiment } = setupResult;
  await experiment.handleComponent(
    { userId: user, guildId: "5" },
    "learner_cadence:daily",
  );
  await experiment.runDue(new Date("2026-10-26T01:00:00Z"));
  await experiment.sendIssue(store.issues[0]!.id, owner.userId);
  return sent.find((entry) => entry.target.recipientId === user)!.payload
    .discord as { content: string; components: unknown[] };
}

test("issue DMs end with the web unsubscribe link only when the web is on", async () => {
  const withWeb = await sentDm(
    setup({
      webUnsubscribeUrl: (userId) => `https://rapi.example/u/token-${userId}`,
    }),
  );
  assert.match(
    withWeb.content,
    /<https:\/\/rapi\.example\/u\/token-123456789012345678>/,
  );
  assert.ok(withWeb.content.length <= 2000);
  assert.ok(JSON.stringify(withWeb.components).includes("learner_optout"));
  // The portal exists but returns no link (web off): no footer line.
  const noLink = await sentDm(setup({ webUnsubscribeUrl: () => undefined }));
  assert.ok(!noLink.content.includes("/u/"));
  const without = await sentDm(setup());
  assert.ok(!without.content.includes("/u/"));
});

test("the email button repeats on every issue until an address exists; the DM-is-enough answer is asked once", async () => {
  const known = new Set<string>();
  const experiment = setup({ email: emailAddressStatus(known) });
  const issue = (userId: string, asked: boolean, hasEmail: boolean) =>
    JSON.stringify(
      experiment.experiment.issueMessage(
        { cadence: "daily", periodKey: "2026-10-26", items: [] },
        { userId, emailAsked: asked, hasEmail },
      ).components,
    );
  // First issue: both buttons.
  let ids = issue(user, false, false);
  assert.ok(ids.includes("email_add") && ids.includes("learner_email:no"));
  // Later issues: still offered, but "DM이면 충분해요" is not repeated.
  ids = issue(user, true, false);
  assert.ok(ids.includes("email_add"));
  assert.ok(!ids.includes("learner_email:no"));
  // Once an address row exists nothing email-related is shown.
  ids = issue(user, true, true);
  assert.ok(!ids.includes("email_add"));
  // End to end: sendIssue asks the email service about the subscriber.
  const dm = await sentDm(experiment);
  assert.ok(JSON.stringify(dm.components).includes("email_add"));
  known.add(user);
  const again = setup({ email: emailAddressStatus(known) });
  assert.ok(
    !JSON.stringify((await sentDm(again)).components).includes("email_add"),
  );
});

test("decision buttons return the outcome for the original message; non-owners get a notice", async () => {
  const { store, experiment } = setup();
  await experiment.handleComponent(
    { userId: user, guildId: "5" },
    "learner_cadence:daily",
  );
  await experiment.runDue(new Date("2026-10-26T01:00:00Z"));
  const id = store.issues[0]!.id;
  assert.ok(LearnerExperiment.handlesDecision(`learner_issue_send:${id}`));
  assert.ok(!LearnerExperiment.handlesDecision("learner_optout"));
  assert.deepEqual(
    await experiment.handleDecision(
      { userId: user },
      `learner_issue_skip:${id}`,
    ),
    { notice: "운영자만 쓸 수 있는 버튼입니다." },
  );
  const skipped = await experiment.handleDecision(
    owner,
    `learner_issue_skip:${id}`,
  );
  assert.match(skipped.result ?? "", /건너뛰었/);
  const stale = await experiment.handleDecision(
    owner,
    `learner_issue_send:${id}`,
  );
  assert.match(stale.result ?? "", /이미 건너뛴/);
});

test("an undecided preview gets exactly one reminder after three hours", async () => {
  const { store, sent, experiment } = setup();
  await experiment.handleComponent(
    { userId: user, guildId: "5" },
    "learner_cadence:daily",
  );
  const start = new Date("2026-10-26T01:00:00Z");
  store.previewClock = start;
  await experiment.runDue(start);
  const reminders = () =>
    sent.filter(
      (entry) => entry.payload.subject === "학습자 소식 미리보기 알림",
    );
  await experiment.runDue(new Date(start.getTime() + 2 * 3_600_000));
  assert.equal(reminders().length, 0);
  await experiment.runDue(new Date(start.getTime() + 3 * 3_600_000 + 60_000));
  // One per pending issue (the daily and the weekly one), not per tick.
  assert.equal(reminders().length, 2);
  assert.equal(reminders()[0]!.target.recipientId, owner.userId);
  assert.match(reminders()[0]!.payload.text, /발송|건너뛰기/);
  await experiment.runDue(new Date(start.getTime() + 5 * 3_600_000));
  assert.equal(reminders().length, 2);
});

test("a decided preview and a day-old preview get no reminder", async () => {
  const decided = setup();
  const start = new Date("2026-10-26T01:00:00Z");
  await decided.experiment.handleComponent(
    { userId: user, guildId: "5" },
    "learner_cadence:daily",
  );
  decided.store.previewClock = start;
  await decided.experiment.runDue(start);
  for (const issue of decided.store.issues)
    await decided.experiment.skipIssue(issue.id, owner.userId);
  await decided.experiment.runDue(new Date(start.getTime() + 4 * 3_600_000));
  assert.ok(
    !decided.sent.some(
      (e) => e.payload.subject === "학습자 소식 미리보기 알림",
    ),
  );
  const old = setup();
  await old.experiment.handleComponent(
    { userId: user, guildId: "5" },
    "learner_cadence:daily",
  );
  old.store.previewClock = start;
  await old.experiment.runDue(start);
  await old.experiment.runDue(new Date(start.getTime() + 30 * 3_600_000));
  assert.ok(
    !old.sent.some((e) => e.payload.subject === "학습자 소식 미리보기 알림"),
  );
});
