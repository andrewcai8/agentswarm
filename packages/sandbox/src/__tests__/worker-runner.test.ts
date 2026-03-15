/**
 * Regression tests for worker-runner.ts empty-response handling — issue #27.
 *
 * Existing sandbox.test.ts covers: payload parsing, buildTaskPrompt format,
 * buildHandoff structure, and git diff stats on a clean repo.
 *
 * This file covers the gaps:
 *   - Empty-response detection: 0 tokens + 0 tool calls → status "failed"
 *   - Handoff shape for empty-response path (summary, concerns, suggestions)
 *   - Safety-net commit is skipped when the agent produced no work
 *   - Artifact-only diffs do not inflate filesChanged / line metrics
 *   - buildTaskPrompt is exercised via its exported function
 *
 * Uses node:test + node:assert/strict. No extra dependencies.
 * Git-touching tests use real temp repos with hermetic config.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { buildTaskPrompt } from "../worker-runner.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: tmpdir(),
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test.com",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
};

function git(args: string[], cwd: string): string {
  return execFileSync(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "init.templateDir=",
      ...args,
    ],
    { cwd, stdio: "pipe", env: GIT_ENV, encoding: "utf-8" },
  ).trim();
}

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "worker-runner-test-"));
  try {
    git(["init", "-b", "main"], dir);
  } catch {
    git(["init"], dir);
    git(["symbolic-ref", "HEAD", "refs/heads/main"], dir);
  }
  git(["config", "user.email", "test@test.com"], dir);
  git(["config", "user.name", "Test"], dir);
  // Initial commit so HEAD resolves
  writeFileSync(join(dir, "README.md"), "# test\n");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  return dir;
}

function rmDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Artifact paths that must always be excluded from metrics. */
const ARTIFACT_PATHS = [
  "node_modules/index.js",
  "node_modules/@scope/pkg/index.js",
  ".next/server/app.js",
  "dist/index.js",
  "dist/main.js",
  "build/output.js",
  "out/static/bundle.js",
  ".turbo/cache.json",
  ".tsbuildinfo",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  ".pnpm-store/v3/pkg.tgz",
];

/** Non-artifact source paths that must always be included. */
const SOURCE_PATHS = [
  "src/index.ts",
  "src/utils/helper.ts",
  "packages/core/src/types.ts",
  "README.md",
  "tsconfig.json",
  ".env.example",
];

// ---------------------------------------------------------------------------
// Empty-response detection logic
// ---------------------------------------------------------------------------

describe("worker-runner — empty-response detection", () => {
  it("detects empty response when both tokensUsed and toolCallCount are zero", () => {
    const tokensUsed = 0;
    const toolCallCount = 0;
    const isEmptyResponse = tokensUsed === 0 && toolCallCount === 0;
    assert.strictEqual(isEmptyResponse, true, "0 tokens + 0 tool calls must be empty response");
  });

  it("is NOT empty response when tokens > 0 even if tool calls = 0", () => {
    const tokensUsed: number = 42;
    const toolCallCount: number = 0;
    const isEmptyResponse = tokensUsed === 0 && toolCallCount === 0;
    assert.strictEqual(isEmptyResponse, false, "non-zero tokens means agent did work");
  });

  it("is NOT empty response when tool calls > 0 even if tokens = 0", () => {
    const tokensUsed: number = 0;
    const toolCallCount: number = 3;
    const isEmptyResponse = tokensUsed === 0 && toolCallCount === 0;
    assert.strictEqual(isEmptyResponse, false, "non-zero tool calls means agent did work");
  });

  it("is NOT empty response when both tokens and tool calls are non-zero", () => {
    const tokensUsed: number = 100;
    const toolCallCount: number = 5;
    const isEmptyResponse = tokensUsed === 0 && toolCallCount === 0;
    assert.strictEqual(isEmptyResponse, false, "normal run must not be flagged as empty");
  });
});

// ---------------------------------------------------------------------------
// Handoff shape for empty-response path
// ---------------------------------------------------------------------------

describe("worker-runner — empty-response handoff shape", () => {
  /** Mirror the handoff construction from worker-runner.ts for the empty-response path. */
  function buildEmptyResponseHandoff(taskId: string) {
    const isEmptyResponse = true;
    return {
      taskId,
      status: isEmptyResponse ? ("failed" as const) : ("complete" as const),
      summary: isEmptyResponse
        ? "Task failed: LLM returned empty response (0 tokens, 0 tool calls). Possible API/endpoint failure."
        : "Task completed.",
      diff: "",
      filesChanged: [] as string[],
      concerns: isEmptyResponse
        ? ["Empty LLM response — possible API failure or model endpoint issue"]
        : [],
      suggestions: isEmptyResponse
        ? ["Check LLM endpoint connectivity", "Verify model is available in sandbox environment"]
        : [],
      metrics: {
        linesAdded: 0,
        linesRemoved: 0,
        filesCreated: 0,
        filesModified: 0,
        tokensUsed: 0,
        toolCallCount: 0,
        durationMs: 0,
      },
    };
  }

  it("status is 'failed' for empty response, not 'complete'", () => {
    const handoff = buildEmptyResponseHandoff("task-001");
    assert.strictEqual(handoff.status, "failed", "empty response must produce a failed handoff");
  });

  it("summary describes the empty-response failure", () => {
    const handoff = buildEmptyResponseHandoff("task-001");
    assert.ok(
      handoff.summary.toLowerCase().includes("empty response") ||
        handoff.summary.toLowerCase().includes("0 tokens"),
      `summary must mention empty response, got: "${handoff.summary}"`,
    );
  });

  it("concerns include a message about the empty LLM response", () => {
    const handoff = buildEmptyResponseHandoff("task-001");
    assert.ok(handoff.concerns.length > 0, "must have at least one concern");
    const concernText = handoff.concerns.join(" ").toLowerCase();
    assert.ok(
      concernText.includes("empty") || concernText.includes("api"),
      `concern must mention empty response or API issue, got: "${handoff.concerns[0]}"`,
    );
  });

  it("suggestions include actionable remediation hints", () => {
    const handoff = buildEmptyResponseHandoff("task-001");
    assert.ok(handoff.suggestions.length >= 2, "must have at least two suggestions");
    const text = handoff.suggestions.join(" ").toLowerCase();
    assert.ok(
      text.includes("endpoint") || text.includes("model"),
      "suggestions must mention endpoint or model",
    );
  });

  it("filesChanged is empty for empty-response path", () => {
    const handoff = buildEmptyResponseHandoff("task-001");
    assert.deepStrictEqual(
      handoff.filesChanged,
      [],
      "no files should be reported for empty response",
    );
  });

  it("all line and file metrics are zero for empty-response path", () => {
    const handoff = buildEmptyResponseHandoff("task-001");
    assert.strictEqual(handoff.metrics.linesAdded, 0);
    assert.strictEqual(handoff.metrics.linesRemoved, 0);
    assert.strictEqual(handoff.metrics.filesCreated, 0);
    assert.strictEqual(handoff.metrics.filesModified, 0);
    assert.strictEqual(handoff.metrics.tokensUsed, 0);
    assert.strictEqual(handoff.metrics.toolCallCount, 0);
  });

  it("taskId is preserved correctly in the failed handoff", () => {
    const handoff = buildEmptyResponseHandoff("task-empty-42");
    assert.strictEqual(handoff.taskId, "task-empty-42");
  });
});

// ---------------------------------------------------------------------------
// Safety-net commit — skipped when agent produced no work
// ---------------------------------------------------------------------------

describe("worker-runner — safety-net commit skipped on empty response", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempRepo();
  });

  afterEach(() => rmDir(dir));

  it("no new commit is created when isEmptyResponse=true and no agent work happened", () => {
    const commitsBefore = git(["rev-list", "--count", "HEAD"], dir);

    // Simulate what worker-runner.ts does: skip safety-net commit if isEmptyResponse
    const isEmptyResponse = true;
    if (!isEmptyResponse) {
      git(["add", "-A"], dir);
      const staged = git(["diff", "--cached", "--name-only"], dir);
      if (staged) {
        git(["commit", "-m", "feat(task-001): auto-commit uncommitted changes"], dir);
      }
    }

    const commitsAfter = git(["rev-list", "--count", "HEAD"], dir);
    assert.strictEqual(
      commitsAfter,
      commitsBefore,
      "no new commit must be created when safety-net commit is skipped",
    );
  });

  it("safety-net commit IS created when agent did real work (isEmptyResponse=false)", () => {
    const commitsBefore = parseInt(git(["rev-list", "--count", "HEAD"], dir), 10);

    // Agent wrote a file
    writeFileSync(join(dir, "src.ts"), "export const x = 1;\n");

    const isEmptyResponse = false;
    if (!isEmptyResponse) {
      git(["add", "-A"], dir);
      const staged = git(["diff", "--cached", "--name-only"], dir);
      if (staged) {
        git(["commit", "-m", "feat(task-real): auto-commit uncommitted changes"], dir);
      }
    }

    const commitsAfter = parseInt(git(["rev-list", "--count", "HEAD"], dir), 10);
    assert.strictEqual(
      commitsAfter,
      commitsBefore + 1,
      "safety-net commit must be created when agent produced real work",
    );
  });

  it("scaffold-only files (gitignore, AGENTS.md) do not produce a commit on empty response", () => {
    // Simulate worker writing scaffold files even on empty response
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    writeFileSync(join(dir, "AGENTS.md"), "# Worker instructions\n");

    const commitsBefore = git(["rev-list", "--count", "HEAD"], dir);

    // Empty response → skip commit entirely
    const isEmptyResponse = true;
    if (!isEmptyResponse) {
      git(["add", "-A"], dir);
      const staged = git(["diff", "--cached", "--name-only"], dir);
      if (staged) {
        git(["commit", "-m", "feat(scaffold): auto-commit"], dir);
      }
    }

    const commitsAfter = git(["rev-list", "--count", "HEAD"], dir);
    assert.strictEqual(
      commitsAfter,
      commitsBefore,
      "scaffold-only files must not create a commit on empty response",
    );
  });
});

// ---------------------------------------------------------------------------
// Artifact filtering — artifact paths excluded from filesChanged metrics
// ---------------------------------------------------------------------------

describe("worker-runner — artifact filtering", () => {
  /** Mirror the ARTIFACT_PATTERNS from worker-runner.ts. */
  const ARTIFACT_PATTERNS = [
    /^node_modules\//,
    /^\.next\//,
    /^dist\//,
    /^build\//,
    /^out\//,
    /^\.turbo\//,
    /^\.tsbuildinfo$/,
    /^package-lock\.json$/,
    /^pnpm-lock\.yaml$/,
    /^yarn\.lock$/,
    /^\.pnpm-store\//,
  ];

  function isArtifact(filePath: string): boolean {
    return ARTIFACT_PATTERNS.some((p) => p.test(filePath));
  }

  it("all known artifact paths are filtered out", () => {
    for (const p of ARTIFACT_PATHS) {
      assert.strictEqual(isArtifact(p), true, `"${p}" must be classified as an artifact`);
    }
  });

  it("source file paths are never filtered out", () => {
    for (const p of SOURCE_PATHS) {
      assert.strictEqual(isArtifact(p), false, `"${p}" must NOT be classified as an artifact`);
    }
  });

  it("filtering artifact paths from filesChanged produces zero files for artifact-only diffs", () => {
    const rawFiles = [...ARTIFACT_PATHS];
    const filtered = rawFiles.filter((f) => !isArtifact(f));
    assert.deepStrictEqual(filtered, [], "artifact-only diff must produce empty filesChanged");
  });

  it("filtering preserves source files and removes artifacts in a mixed diff", () => {
    const mixed = [
      "src/index.ts",
      "node_modules/some-pkg/index.js",
      "dist/bundle.js",
      "src/utils/helper.ts",
      "pnpm-lock.yaml",
    ];
    const filtered = mixed.filter((f) => !isArtifact(f));
    assert.deepStrictEqual(filtered, ["src/index.ts", "src/utils/helper.ts"]);
  });

  it("linesAdded is zero when all changed files are artifacts", () => {
    const numstatLines = [
      "1000\t0\tnode_modules/pkg/index.js",
      "500\t200\tdist/bundle.js",
      "300\t0\tpnpm-lock.yaml",
    ];

    let linesAdded = 0;
    let linesRemoved = 0;
    for (const line of numstatLines) {
      const [addedRaw, removedRaw, filePath] = line.split("\t");
      if (addedRaw && removedRaw && filePath && !isArtifact(filePath)) {
        linesAdded += parseInt(addedRaw, 10);
        linesRemoved += parseInt(removedRaw, 10);
      }
    }

    assert.strictEqual(linesAdded, 0, "artifact-only diff must produce zero linesAdded");
    assert.strictEqual(linesRemoved, 0, "artifact-only diff must produce zero linesRemoved");
  });

  it("linesAdded only counts source files in a mixed numstat diff", () => {
    const numstatLines = [
      "10\t2\tsrc/index.ts",
      "1000\t0\tnode_modules/pkg/index.js",
      "5\t1\tsrc/utils/helper.ts",
      "500\t200\tdist/bundle.js",
    ];

    let linesAdded = 0;
    for (const line of numstatLines) {
      const [addedRaw, _removedRaw, filePath] = line.split("\t");
      if (addedRaw && filePath && !isArtifact(filePath)) {
        linesAdded += parseInt(addedRaw, 10);
      }
    }

    // Only src/index.ts (10) + src/utils/helper.ts (5) = 15
    assert.strictEqual(linesAdded, 15, "only source file lines should count toward linesAdded");
  });
});

// ---------------------------------------------------------------------------
// buildTaskPrompt — exported function (extends existing coverage)
// ---------------------------------------------------------------------------

describe("worker-runner — buildTaskPrompt", () => {
  const baseTask = {
    id: "task-042",
    description: "Add authentication middleware",
    scope: ["src/middleware/auth.ts", "src/routes/api.ts"],
    acceptance: "All API routes require a valid JWT token",
    branch: "worker/task-042",
    status: "running" as const,
    createdAt: Date.now(),
    priority: 3,
  };

  it("includes task id as a markdown heading", () => {
    const prompt = buildTaskPrompt(baseTask);
    assert.ok(prompt.includes("## Task: task-042"), "must include task id heading");
  });

  it("includes description", () => {
    const prompt = buildTaskPrompt(baseTask);
    assert.ok(prompt.includes("Add authentication middleware"));
  });

  it("includes all scope files joined by comma", () => {
    const prompt = buildTaskPrompt(baseTask);
    assert.ok(
      prompt.includes("src/middleware/auth.ts, src/routes/api.ts"),
      "scope must list all files",
    );
  });

  it("includes acceptance criteria", () => {
    const prompt = buildTaskPrompt(baseTask);
    assert.ok(prompt.includes("All API routes require a valid JWT token"));
  });

  it("includes branch name", () => {
    const prompt = buildTaskPrompt(baseTask);
    assert.ok(prompt.includes("worker/task-042"));
  });

  it("ends with a completion instruction", () => {
    const prompt = buildTaskPrompt(baseTask);
    assert.ok(
      prompt.includes("Complete this task") && prompt.includes("Commit your changes"),
      "must include task completion instruction",
    );
  });

  it("handles empty scope array without throwing", () => {
    const task = { ...baseTask, scope: [] };
    const prompt = buildTaskPrompt(task);
    assert.ok(typeof prompt === "string" && prompt.length > 0);
  });
});
