import assert from "node:assert/strict";
import { test } from "node:test";
import {
  providerModelSchema,
  parseProviderDirective,
  parseTaskSelection,
  resolveProvider,
  DEFAULT_CODEX_MODEL,
  taskSpecificationSchema,
} from "@rapi/contracts";

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
  assert.equal(
    parseTaskSelection("스파크로 오류 수정").model,
    "gpt-5.3-codex-spark",
  );
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
test("the task specification schema applies provider defaults and validation", () => {
  for (const schema of [taskSpecificationSchema]) {
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
