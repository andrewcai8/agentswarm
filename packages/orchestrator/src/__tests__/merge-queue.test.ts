import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MergeQueue, type MergeQueueDeps } from "../merge-queue.js";

function createDeps(overrides: Partial<MergeQueueDeps> = {}): {
  deps: MergeQueueDeps;
  calls: Array<{ cmd: string; args: string[] }>;
} {
  let tick = 1_000;
  const calls: Array<{ cmd: string; args: string[] }> = [];

  const execFileAsync = (async (...input: unknown[]) => {
    const cmd = typeof input[0] === "string" ? input[0] : "";
    const maybeArgs = input[1];
    const args = Array.isArray(maybeArgs)
      ? maybeArgs.filter((arg): arg is string => typeof arg === "string")
      : [];

    calls.push({ cmd, args });
    if (args[0] === "branch" && args[1] === "--list") {
      return { stdout: "", stderr: "" };
    }

    return { stdout: "", stderr: "" };
  }) as MergeQueueDeps["execFileAsync"];

  const deps: MergeQueueDeps = {
    execFileAsync,
    checkoutBranch: async () => {},
    mergeBranch: async () => ({ success: true, conflicted: false, message: "merged" }),
    rebaseBranch: async () => ({ success: false, conflicted: false, message: "rebase failed" }),
    now: () => ++tick,
    setTimeout,
    clearTimeout,
    ...overrides,
  };

  return { deps, calls };
}

describe("MergeQueue", () => {
  it("orders by priority and skips duplicate branch entries", () => {
    const { deps } = createDeps();
    const queue = new MergeQueue(
      {
        mergeStrategy: "rebase",
        mainBranch: "main",
        repoPath: "/tmp/repo",
      },
      deps,
    );

    queue.enqueue("worker/low", 5);
    queue.enqueue("worker/high", 1);
    queue.enqueue("worker/high", 1);

    assert.deepStrictEqual(queue.getQueue(), ["worker/high", "worker/low"]);
  });

  it("marks branch as merged and updates merge stats on successful merge", async () => {
    const { deps, calls } = createDeps({
      mergeBranch: async () => ({ success: true, conflicted: false, message: "ok" }),
    });
    const queue = new MergeQueue(
      {
        mergeStrategy: "rebase",
        mainBranch: "main",
        repoPath: "/tmp/repo",
      },
      deps,
    );

    const result = await queue.mergeBranch("task-001");
    const stats = queue.getMergeStats();

    assert.strictEqual(result.status, "merged");
    assert.strictEqual(result.success, true);
    assert.strictEqual(queue.isBranchMerged("task-001"), true);
    assert.strictEqual(stats.totalMerged, 1);
    assert.ok(calls.some((c) => c.args[0] === "push" && c.args[1] === "origin"));
  });

  it("re-queues conflicting branches for retry when retries remain", async () => {
    const branch = "worker/conflict-001";
    const { deps } = createDeps({
      mergeBranch: async () => ({
        success: false,
        conflicted: true,
        message: "merge conflict",
        conflictingFiles: ["src/conflict.ts"],
      }),
      rebaseBranch: async () => ({ success: false, conflicted: false, message: "rebase failed" }),
    });
    const queue = new MergeQueue(
      {
        mergeStrategy: "rebase",
        mainBranch: "main",
        repoPath: "/tmp/repo",
        maxConflictRetries: 1,
      },
      deps,
    );

    const result = await queue.mergeBranch(branch);

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.status, "skipped");
    assert.strictEqual(queue.getQueueLength(), 1);
    assert.deepStrictEqual(queue.getQueue(), [branch]);
  });
});
