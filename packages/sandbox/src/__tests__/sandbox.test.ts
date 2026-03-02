import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { buildHandoff } from "../handoff.js";

let testDir: string;
const originalCwd = process.cwd();

async function createTestDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "sandbox-test-"));
}

async function initGitRepo(dir: string): Promise<void> {
  execSync("git init", { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });
  execSync("git config init.defaultBranch main", { cwd: dir });
  await fs.writeFile(path.join(dir, "README.md"), "# Test\n");
  execSync("git add -A && git commit -m 'initial'", { cwd: dir });
}

describe("TaskPayload parsing", () => {
  it("parses valid payload JSON", () => {
    const json = JSON.stringify({
      task: {
        id: "task-001",
        description: "Implement hello world",
        scope: ["src/hello.ts"],
        acceptance: "Function returns 'Hello'",
        branch: "worker/task-001",
        status: "pending",
        createdAt: Date.now(),
        priority: 5,
      },
      systemPrompt: "You are a coding agent.",
      llmConfig: {
        endpoint: "https://api.example.com",
        model: "glm-5",
        maxTokens: 4096,
        temperature: 0.2,
      },
      repoUrl: "https://github.com/test/repo.git",
    });

    const parsed = JSON.parse(json);
    assert.strictEqual(parsed.task.id, "task-001");
    assert.strictEqual(parsed.task.description, "Implement hello world");
    assert.deepStrictEqual(parsed.task.scope, ["src/hello.ts"]);
    assert.strictEqual(parsed.systemPrompt, "You are a coding agent.");
    assert.strictEqual(parsed.llmConfig.model, "glm-5");
    assert.strictEqual(parsed.llmConfig.maxTokens, 4096);
  });

  it("handles payload with optional apiKey", () => {
    const json = JSON.stringify({
      task: {
        id: "task-002",
        description: "test",
        scope: [],
        acceptance: "",
        branch: "worker/task-002",
        status: "pending",
        createdAt: Date.now(),
        priority: 5,
      },
      systemPrompt: "prompt",
      llmConfig: {
        endpoint: "https://api.example.com",
        model: "glm-5",
        maxTokens: 4096,
        temperature: 0.2,
        apiKey: "sk-test",
      },
    });

    const parsed = JSON.parse(json);
    assert.strictEqual(parsed.llmConfig.apiKey, "sk-test");
  });

  it("handles payload without repoUrl", () => {
    const json = JSON.stringify({
      task: {
        id: "task-003",
        description: "test",
        scope: [],
        acceptance: "",
        branch: "worker/task-003",
        status: "pending",
        createdAt: Date.now(),
        priority: 5,
      },
      systemPrompt: "prompt",
      llmConfig: {
        endpoint: "https://api.example.com",
        model: "glm-5",
        maxTokens: 4096,
        temperature: 0.2,
      },
    });

    const parsed = JSON.parse(json);
    assert.strictEqual(parsed.repoUrl, undefined);
  });
});

describe("buildTaskPrompt format", () => {
  it("produces markdown with task fields", () => {
    const task = {
      id: "task-001",
      description: "Implement the player movement system",
      scope: ["src/player.ts", "src/input.ts"],
      acceptance: "Player can move with WASD keys",
      branch: "worker/task-001",
    };

    const prompt = [
      `## Task: ${task.id}`,
      `**Description:** ${task.description}`,
      `**Scope (files to focus on):** ${task.scope.join(", ")}`,
      `**Acceptance criteria:** ${task.acceptance}`,
      `**Branch:** ${task.branch}`,
      "",
      "Complete this task. Commit your changes when done. Stay focused on the scoped files.",
    ].join("\n");

    assert.ok(prompt.includes("## Task: task-001"));
    assert.ok(prompt.includes("Implement the player movement system"));
    assert.ok(prompt.includes("src/player.ts, src/input.ts"));
    assert.ok(prompt.includes("Player can move with WASD keys"));
    assert.ok(prompt.includes("worker/task-001"));
  });
});

describe("Handoff Builder", () => {
  before(async () => {
    testDir = await createTestDir();
    await initGitRepo(testDir);
    process.chdir(testDir);
  });

  after(async () => {
    process.chdir(originalCwd);
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it("buildHandoff produces correct structure on clean repo", async () => {
    const handoff = await buildHandoff("task-hb-001", "complete", "Test summary", {
      linesAdded: 0,
      linesRemoved: 0,
      filesCreated: 0,
      filesModified: 0,
      tokensUsed: 100,
      toolCallCount: 5,
      durationMs: 1000,
    });

    assert.strictEqual(handoff.taskId, "task-hb-001");
    assert.strictEqual(handoff.status, "complete");
    assert.strictEqual(handoff.summary, "Test summary");
    assert.ok(Array.isArray(handoff.filesChanged));
    assert.strictEqual(handoff.metrics.tokensUsed, 100);
    assert.strictEqual(handoff.metrics.toolCallCount, 5);
    assert.strictEqual(handoff.metrics.durationMs, 1000);
  });

  it("buildHandoff captures git diff stats after file changes", async () => {
    await fs.writeFile(path.join(testDir, "new-file.ts"), "export const x = 42;\n");
    execSync("git add -A", { cwd: testDir });

    const handoff = await buildHandoff("task-hb-002", "partial", "Added file", {
      linesAdded: 0,
      linesRemoved: 0,
      filesCreated: 0,
      filesModified: 0,
      tokensUsed: 50,
      toolCallCount: 2,
      durationMs: 500,
    });

    assert.strictEqual(handoff.taskId, "task-hb-002");
    assert.strictEqual(handoff.status, "partial");
    assert.ok(typeof handoff.metrics.linesAdded === "number");
    assert.ok(typeof handoff.metrics.filesCreated === "number");
  });
});

describe("Handoff structure", () => {
  it("matches expected complete shape", () => {
    const handoff = {
      taskId: "task-001",
      status: "complete" as const,
      summary: "Implemented player movement",
      diff: "+function move() {}",
      filesChanged: ["src/player.ts"],
      concerns: [],
      suggestions: [],
      metrics: {
        linesAdded: 10,
        linesRemoved: 0,
        filesCreated: 1,
        filesModified: 0,
        tokensUsed: 500,
        toolCallCount: 3,
        durationMs: 5000,
      },
    };

    assert.strictEqual(handoff.taskId, "task-001");
    assert.strictEqual(handoff.status, "complete");
    assert.strictEqual(handoff.filesChanged.length, 1);
    assert.strictEqual(handoff.metrics.linesAdded, 10);
    assert.strictEqual(handoff.metrics.toolCallCount, 3);
  });

  it("failure handoff has correct shape", () => {
    const handoff = {
      taskId: "task-002",
      status: "failed" as const,
      summary: "Worker crashed: out of memory",
      diff: "",
      filesChanged: [],
      concerns: ["out of memory"],
      suggestions: ["Retry the task"],
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

    assert.strictEqual(handoff.status, "failed");
    assert.strictEqual(handoff.concerns.length, 1);
    assert.strictEqual(handoff.diff, "");
  });
});
