import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  executionCallbackSchema,
  taskSpecificationSchema,
} from "../packages/contracts/src/index.js";

describe("OMP schemas", () => {
  it("accepts a versioned and approved task specification", () => {
    const result = taskSpecificationSchema.safeParse({
      task_id: "task-1",
      task_revision: 1,
      execution_attempt_id: "attempt-1",
      repository: "owner/repo",
      base_revision: "abc123",
      workspace_ref: "worktree-1",
      goal: "Implement the requested change",
      non_goals: [],
      requirements: ["Keep the adapter boundary"],
      acceptance_criteria: ["Tests pass"],
      permissions: ["repo:read"],
      forbidden_actions: ["deploy"],
      approval_id: "approval-1",
      approval_expires_at: "2026-09-08T12:00:00Z",
      timeout_seconds: 900,
      result_report_ref: "reports/task-1.md",
      required_evidence: ["test-results"],
    });
    assert.equal(result.success, true);
    assert.equal(result.data.model, "gpt-5.3-codex-spark");
  });
  it("rejects callbacks without a signature", () => {
    const result = executionCallbackSchema.safeParse({
      callback_event_id: "callback-1",
      receipt_id: "receipt-1",
      execution_attempt_id: "attempt-1",
      state_version: 1,
      state: "running",
      occurred_at: "2026-09-08T12:00:00Z",
      key_id: "key-1",
      evidence_refs: [],
    });
    assert.equal(result.success, false);
  });
});
