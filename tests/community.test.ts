import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultCommunityLayout,
  parseDiscordLayout,
  planDiscordLayout,
  requiredCommandAccess,
} from "@rapi/agent";
import {
  buildPublicCodexCommand,
  publicCodexEnvironment,
  runPublicCodex,
} from "../apps/public-agent/src/executor.js";
import { usageWindow } from "@rapi/core";

describe("community usage policy", () => {
  it("resets at 05:30 Asia/Seoul", () => {
    assert.deepEqual(
      usageWindow(new Date("2026-09-10T20:29:59.000Z"), "Asia/Seoul", 5, 30),
      {
        startsAt: new Date("2026-09-09T20:30:00.000Z"),
        endsAt: new Date("2026-09-10T20:30:00.000Z"),
      },
    );
    assert.deepEqual(
      usageWindow(new Date("2026-09-10T20:30:00.000Z"), "Asia/Seoul", 5, 30),
      {
        startsAt: new Date("2026-09-10T20:30:00.000Z"),
        endsAt: new Date("2026-09-11T20:30:00.000Z"),
      },
    );
  });

  it("exposes only the public commands to USER", () => {
    assert.equal(requiredCommandAccess("search"), "user");
    assert.equal(requiredCommandAccess("brief"), "user");
    assert.equal(requiredCommandAccess("usage"), "user");
    assert.equal(requiredCommandAccess("sources"), "admin");
    assert.equal(requiredCommandAccess("deliveries"), "admin");
    assert.equal(requiredCommandAccess("usage_policy"), "admin");
    assert.equal(requiredCommandAccess("subscribe"), "admin");
    assert.equal(requiredCommandAccess("unsubscribe"), "admin");
    assert.equal(requiredCommandAccess("server_config"), "superadmin");
  });
});

describe("public Codex executor", () => {
  it("pins Spark, web search and a tool-free ephemeral session", () => {
    const command = buildPublicCodexCommand("/var/empty", "/tmp/answer.txt");
    assert.equal(command.command, "/usr/local/bin/codex");
    assert.deepEqual(command.args.slice(0, 5), [
      "--search",
      "--ask-for-approval",
      "never",
      "exec",
      "--strict-config",
    ]);
    assert.ok(command.args.includes("gpt-5.3-codex-spark"));
    assert.ok(command.args.includes("--search"));
    assert.deepEqual(
      [
        "shell_tool",
        "apps",
        "plugins",
        "browser_use",
        "computer_use",
        "multi_agent",
        "image_generation",
        "view_image",
      ].filter(
        (feature) =>
          !command.args.some(
            (value, index) =>
              value === "--disable" && command.args[index + 1] === feature,
          ),
      ),
      [],
    );
    assert.ok(command.args.includes("--ephemeral"));
    assert.ok(command.args.includes("--ignore-user-config"));
    assert.ok(command.args.includes("--skip-git-repo-check"));
  });

  it("passes no application secrets to the public process", () => {
    assert.deepEqual(
      publicCodexEnvironment({
        PATH: "/usr/bin",
        LANG: "C.UTF-8",
        DATABASE_URL: "postgresql://secret",
        DISCORD_BOT_TOKEN: "secret",
        WEBHOOK_ENCRYPTION_KEY: "secret",
        HOME: "/home/private",
        CODEX_HOME: "/var/lib/rapi-public/codex",
      }),
      {
        PATH: "/usr/bin",
        LANG: "C.UTF-8",
        HOME: "/var/lib/rapi-public",
        CODEX_HOME: "/var/lib/rapi-public/codex",
      },
    );
  });

  it("caps output and terminates timeout and cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "rapi-public-test-"));
    const outputBinary = join(root, "output.mjs");
    const waitingBinary = join(root, "waiting.mjs");
    await writeFile(
      outputBinary,
      `#!/usr/bin/env node\nimport {writeFileSync} from "node:fs"; const i=process.argv.indexOf("--output-last-message"); writeFileSync(process.argv[i+1],"x".repeat(7000));`,
    );
    await writeFile(
      waitingBinary,
      `#!/usr/bin/env node\nsetInterval(()=>{},1000);`,
    );
    await Promise.all([
      chmod(outputBinary, 0o700),
      chmod(waitingBinary, 0o700),
    ]);
    try {
      const completed = await runPublicCodex("질문", {
        workspace: root,
        runtimeDirectory: root,
        binary: outputBinary,
      });
      assert.equal(completed.ok, true);
      assert.equal(completed.output.length, 6_000);
      const timeout = await runPublicCodex("질문", {
        workspace: root,
        runtimeDirectory: root,
        binary: waitingBinary,
        timeoutMs: 20,
      });
      assert.equal(timeout.reason, "timeout");
      const controller = new AbortController();
      const cancelled = await runPublicCodex("질문", {
        workspace: root,
        runtimeDirectory: root,
        binary: waitingBinary,
        signal: controller.signal,
        onStarted: () => controller.abort(),
      });
      assert.equal(cancelled.reason, "cancel");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Discord layout", () => {
  it("parses the default YAML-compatible layout", () => {
    const layout = parseDiscordLayout(JSON.stringify(defaultCommunityLayout));
    assert.equal(layout.version, 1);
    assert.equal(layout.roles.length, 2);
    assert.equal(
      layout.categories.flatMap((category) => category.channels).length,
      19,
    );
  });

  it("adopts exact names, plans missing resources and deletes extras", () => {
    const layout = defaultCommunityLayout;
    const plan = planDiscordLayout(
      layout,
      {
        guildId: "guild",
        roles: [
          { id: "guild", name: "@everyone", permissions: "0", position: 0 },
          { id: "user-role", name: "라피 USER", permissions: "0", position: 1 },
        ],
        channels: [
          { id: "start", name: "시작하기", type: 4, position: 0 },
          {
            id: "rules",
            name: "규칙",
            type: 0,
            position: 0,
            parentId: "start",
          },
          { id: "old", name: "옛날-채널", type: 0, position: 99 },
        ],
      },
      [],
    );
    assert.ok(plan.actions.some((action) => action.kind === "create_role"));
    assert.ok(plan.actions.some((action) => action.kind === "create_channel"));
    assert.ok(
      plan.actions.some(
        (action) => action.kind === "delete_channel" && action.id === "old",
      ),
    );
    assert.ok(plan.layoutDigest.length >= 32);
    assert.ok(plan.snapshotDigest.length >= 32);
  });

  it("rejects ambiguous adoption instead of guessing", () => {
    assert.throws(
      () =>
        planDiscordLayout(
          defaultCommunityLayout,
          {
            guildId: "guild",
            roles: [
              { id: "guild", name: "@everyone", permissions: "0", position: 0 },
            ],
            channels: [
              { id: "a", name: "시작하기", type: 4, position: 0 },
              { id: "b", name: "시작하기", type: 4, position: 1 },
            ],
          },
          [],
        ),
      /ambiguous/i,
    );
  });

  it("rejects duplicate stable names in the configuration", () => {
    const duplicate = structuredClone(defaultCommunityLayout);
    duplicate.categories[1]!.channels[0]!.name =
      duplicate.categories[0]!.channels[0]!.name;
    assert.throws(
      () => parseDiscordLayout(JSON.stringify(duplicate)),
      /duplicate.*channel name/i,
    );
  });
});
