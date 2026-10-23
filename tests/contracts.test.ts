import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { taskSpecificationSchema } from "../packages/contracts/src/index.js";

describe("task specification schema", () => {
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
    assert.equal(result.data.model, "gpt-5.6-sol");
  });
});
