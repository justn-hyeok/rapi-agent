import assert from "node:assert/strict";
import { test } from "node:test";
import {
  providerModelSchema,
  parseProviderDirective,
  parseTaskSelection,
  resolveProvider,
  redactChat,
  DEFAULT_CODEX_MODEL,
  taskSpecificationSchema,
} from "@rapi/contracts";
import {
  buildProviderCommand,
  providerEnvironment,
  providerReadiness,
  providerFailure,
} from "../apps/omp/src/providers.js";
import { specificationSchema } from "../apps/omp/src/specification.js";

test("provider directives are anchored, unquoted and current-request only", () => {
  for (const [alias, provider] of Object.entries({
    codex: "codex",
    코덱스: "codex",
    cursor: "cursor",
    커서: "cursor",
    commandcode: "commandcode",
    "command code": "commandcode",
    goat: "commandcode",
    고트: "commandcode",
    커맨드코드: "commandcode",
  })) {
    assert.equal(resolveProvider(alias), provider);
    assert.deepEqual(parseProviderDirective(`${alias}로 오류 고쳐줘`), {
      provider,
      task: "오류 고쳐줘",
      explicit: true,
    });
    assert.equal(
      parseProviderDirective(`${alias}: fix error`).provider,
      provider,
    );
  }
  for (const text of [
    '"커서로 오류 고쳐줘"를 출력',
    "`goat: fix error`",
    "커서 위치를 고쳐줘",
    "고트로직 수정",
    "이전에 커서로 작업했어",
    "cursor-agent 설치",
    "goat: ",
  ]) {
    assert.deepEqual(parseProviderDirective(text), {
      provider: "codex",
      task: text.trim(),
      explicit: false,
    });
  }
  assert.equal(
    parseTaskSelection("커서로 오류 수정", "고트").provider,
    "commandcode",
  );
  assert.equal(parseTaskSelection("커서로 오류 수정").model, undefined);
  assert.equal(parseTaskSelection("오류 수정").model, DEFAULT_CODEX_MODEL);
  assert.equal(parseTaskSelection("아스트라로 오류 수정").model, "gpt-6-astra");
  assert.equal(
    parseTaskSelection("고트로 오류 수정", undefined, "vendor/Model:1").model,
    "vendor/Model:1",
  );
  assert.throws(() => resolveProvider("unknown"));
});

test("model IDs are bounded and cannot become CLI switches or shell syntax", () => {
  for (const model of [
    "a",
    "vendor/Model:1.2_fast-preview",
    "gpt-5.3-codex-spark",
  ])
    assert.ok(providerModelSchema.safeParse(model).success);
  for (const model of [
    "",
    "-m",
    "a b",
    "$(id)",
    "a;id",
    "a\nb",
    "a".repeat(129),
  ])
    assert.equal(providerModelSchema.safeParse(model).success, false);
});

const specification = {
  task_id: "task",
  task_revision: 1,
  execution_attempt_id: "attempt",
  approval_id: "approval",
  approval_expires_at: "2099-01-01T00:00:00Z",
  workspace_ref: "workspace",
  goal: "fix",
  repository: "repo",
  base_revision: "HEAD",
  non_goals: [],
  requirements: ["fix"],
  acceptance_criteria: ["tests"],
  permissions: [],
  forbidden_actions: [],
  timeout_seconds: 60,
  result_report_ref: "report",
  required_evidence: [],
};
test("shared and runtime schemas agree on provider defaults and validation", () => {
  for (const schema of [specificationSchema, taskSpecificationSchema]) {
    assert.equal(schema.parse(specification).provider, "codex");
    assert.equal(schema.parse(specification).model, DEFAULT_CODEX_MODEL);
    for (const provider of ["cursor", "commandcode"]) {
      assert.equal(
        schema.parse({ ...specification, provider }).model,
        undefined,
      );
      assert.equal(
        schema.parse({ ...specification, provider, model: "Vendor/model:1" })
          .model,
        "Vendor/model:1",
      );
    }
    assert.equal(
      schema.safeParse({ ...specification, provider: "invalid" }).success,
      false,
    );
    assert.equal(
      schema.safeParse({ ...specification, model: "--force" }).success,
      false,
    );
  }
});

test("provider commands preserve prompts as one argument and map write permissions", () => {
  const prompt = 'Fix "quotes"; $(do-not-run)\nnext line';
  for (const provider of ["codex", "cursor", "commandcode"] as const) {
    for (const write of [false, true]) {
      const result = buildProviderCommand(
        { provider, permissions: write ? ["repo:write"] : ["repo:read"] },
        "/workspace",
        "/report",
        prompt,
      );
      const flag = {
        codex: "--approve-for-me",
        cursor: "--force",
        commandcode: "--yolo",
      }[provider];
      assert.equal(result.args.includes(flag), write);
      for (const other of ["--approve-for-me", "--force", "--yolo"].filter(
        (f) => f !== flag,
      ))
        assert.ok(!result.args.includes(other));
      assert.equal(result.args.includes("--model"), provider === "codex");
      if (provider === "codex") {
        assert.equal(result.input, prompt);
        assert.ok(result.args.includes(DEFAULT_CODEX_MODEL));
        assert.ok(result.args.includes("--output-last-message"));
        assert.equal(result.args.includes("read-only"), !write);
      } else {
        assert.ok(result.args.includes(prompt));
        assert.equal(result.stdoutReport, true);
        assert.equal(result.input, undefined);
        if (provider === "cursor") assert.ok(result.args.includes("--trust"));
      }
      const explicit = buildProviderCommand(
        { provider, model: "vendor/Model:1", permissions: [] },
        "/workspace",
        "/report",
        prompt,
      );
      assert.equal(
        explicit.args[explicit.args.indexOf("--model") + 1],
        "vendor/Model:1",
      );
      if (provider === "commandcode")
        for (const option of [
          "--no-session",
          "--skip-onboarding",
          "--no-auto-update",
        ])
          assert.ok(result.args.includes(option));
    }
  }
});

test("secrets route only to Command Code and are redacted from generic output", () => {
  const env = {
    PATH: "/bin",
    HOME: "/home/test",
    COMMAND_CODE_API_KEY: "test-command-secret",
    CURSOR_CREDENTIALS: "test-cursor-secret",
    CURSOR_AUTH: "test-cursor-auth",
    DISCORD_BOT_TOKEN: "test-discord-secret",
    DATABASE_URL: "test-db-secret",
  };
  for (const provider of [
    undefined,
    "codex",
    "cursor",
    "commandcode",
  ] as const) {
    const child = providerEnvironment(provider, env);
    assert.equal(child.HOME, env.HOME);
    assert.equal(
      child.COMMAND_CODE_API_KEY,
      provider === "commandcode" ? env.COMMAND_CODE_API_KEY : undefined,
    );
    for (const key of [
      "CURSOR_CREDENTIALS",
      "CURSOR_AUTH",
      "DISCORD_BOT_TOKEN",
      "DATABASE_URL",
    ])
      assert.equal(child[key], undefined);
  }
  assert.equal(
    providerEnvironment("commandcode", { CMD_API_KEY: "legacy-key" })
      .COMMAND_CODE_API_KEY,
    "legacy-key",
  );
  assert.equal(
    redactChat(
      '{"accessToken":"oauth-value","cursorCredentials":"credential-value"}',
    ),
    '{"accessToken":"[REDACTED]","cursorCredentials":"[REDACTED]"}',
  );
  const previous = {
    COMMAND_CODE_API_KEY: process.env.COMMAND_CODE_API_KEY,
    CURSOR_CREDENTIALS: process.env.CURSOR_CREDENTIALS,
  };
  try {
    process.env.COMMAND_CODE_API_KEY = env.COMMAND_CODE_API_KEY;
    process.env.CURSOR_CREDENTIALS = env.CURSOR_CREDENTIALS;
    assert.ok(
      !redactChat(
        `${env.COMMAND_CODE_API_KEY} ${env.CURSOR_CREDENTIALS}`,
      ).includes("test-"),
    );
    assert.ok(
      !redactChat(
        "COMMAND_CODE_API_KEY=unknown-secret CURSOR_CREDENTIALS=unknown-oauth",
      ).includes("unknown-"),
    );
  } finally {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
  }
});

test("readiness checks binary and provider authentication state", async () => {
  const exists = async () => {};
  const missing = async () => {
    throw new Error("missing");
  };
  const loggedIn = async () => ({ stdout: "Logged in as test@example.com\n" });
  const loggedOut = async () => ({ stdout: "Not logged in\n" });
  assert.deepEqual(
    await providerReadiness(
      "commandcode",
      { COMMAND_CODE_API_KEY: "fake" },
      exists,
    ),
    { binary: true, configured: true, authentication: "not_verified" },
  );
  assert.equal(
    (await providerReadiness("commandcode", {}, exists)).configured,
    false,
  );
  assert.equal((await providerReadiness("cursor", {}, missing)).binary, false);
  assert.equal(
    (await providerReadiness("cursor", { HOME: "/fake" }, exists, loggedIn))
      .configured,
    true,
  );
  assert.equal(
    (await providerReadiness("cursor", { HOME: "/fake" }, exists, loggedOut))
      .configured,
    false,
  );
  assert.match(providerFailure("cursor", 1), /cursor-agent login/);
  assert.match(
    providerFailure("commandcode", 1),
    /COMMAND_CODE_API_KEY.*restart/,
  );
});
