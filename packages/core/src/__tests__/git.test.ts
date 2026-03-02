import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createBranch, getDiffStat, getRecentCommits, mergeBranch } from "../git.js";

async function withFakeGit(
  scriptSource: string,
  fn: (cwd: string) => Promise<void>,
): Promise<void> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "core-git-test-"));
  const binDir = path.join(rootDir, "bin");
  await fs.mkdir(binDir, { recursive: true });

  const scriptPath = path.join(binDir, "git-script.mjs");
  await fs.writeFile(scriptPath, scriptSource, "utf8");

  const unixGitPath = path.join(binDir, "git");
  await fs.writeFile(
    unixGitPath,
    ["#!/usr/bin/env sh", "set -e", 'node "$(dirname "$0")/git-script.mjs" "$@"', ""].join("\n"),
    "utf8",
  );
  await fs.chmod(unixGitPath, 0o755);

  const winGitPath = path.join(binDir, "git.cmd");
  await fs.writeFile(
    winGitPath,
    ["@echo off", 'node "%~dp0\\git-script.mjs" %*', ""].join("\r\n"),
    "utf8",
  );

  const originalPath = process.env.PATH;
  process.env.PATH = [binDir, originalPath ?? ""].filter((p) => p.length > 0).join(path.delimiter);

  try {
    await fn(rootDir);
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
  }
}

describe("git", () => {
  it("getDiffStat returns zeros when git diff output is empty", async () => {
    await withFakeGit(
      [
        "const args = process.argv.slice(2);",
        "if (args[0] === 'diff' && args[1] === '--shortstat') {",
        "  process.stdout.write('');",
        "  process.exit(0);",
        "}",
        "process.stderr.write('unexpected args: ' + JSON.stringify(args));",
        "process.exit(2);",
        "",
      ].join("\n"),
      async (cwd) => {
        const stat = await getDiffStat(cwd);
        assert.deepStrictEqual(stat, { filesChanged: 0, linesAdded: 0, linesRemoved: 0 });
      },
    );
  });

  it("getDiffStat parses shortstat output", async () => {
    await withFakeGit(
      [
        "const args = process.argv.slice(2);",
        "if (args[0] === 'diff' && args[1] === '--shortstat') {",
        "  process.stdout.write('2 files changed, 10 insertions(+), 3 deletions(-)\\n');",
        "  process.exit(0);",
        "}",
        "process.stderr.write('unexpected args: ' + JSON.stringify(args));",
        "process.exit(2);",
        "",
      ].join("\n"),
      async (cwd) => {
        const stat = await getDiffStat(cwd);
        assert.deepStrictEqual(stat, { filesChanged: 2, linesAdded: 10, linesRemoved: 3 });
      },
    );
  });

  it("getRecentCommits parses record-separated git log output", async () => {
    const output = [
      "\u001eabc123\nfirst commit\nAlice\n1700000000",
      "\u001edef456\nsecond commit\nBob\n1700000100",
    ].join("");

    await withFakeGit(
      [
        "const args = process.argv.slice(2);",
        "if (args[0] === 'log' && args[1] === '-2') {",
        `  process.stdout.write(${JSON.stringify(output)});`,
        "  process.exit(0);",
        "}",
        "process.stderr.write('unexpected args: ' + JSON.stringify(args));",
        "process.exit(2);",
        "",
      ].join("\n"),
      async (cwd) => {
        const commits = await getRecentCommits(2, cwd);
        assert.strictEqual(commits.length, 2);

        const first = commits[0];
        const second = commits[1];
        assert.ok(first);
        assert.ok(second);

        assert.deepStrictEqual(first, {
          hash: "abc123",
          message: "first commit",
          author: "Alice",
          date: 1700000000 * 1000,
        });
        assert.deepStrictEqual(second, {
          hash: "def456",
          message: "second commit",
          author: "Bob",
          date: 1700000100 * 1000,
        });
      },
    );
  });

  it("mergeBranch (merge-commit) returns conflicted result with parsed conflicting files", async () => {
    await withFakeGit(
      [
        "const args = process.argv.slice(2);",
        "if (args[0] === 'checkout') {",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'merge' && args[1] === '--no-ff') {",
        "  process.stderr.write('CONFLICT (content): Merge conflict in a.txt\\n');",
        "  process.exit(1);",
        "}",
        "if (args[0] === 'status' && args[1] === '--porcelain') {",
        "  process.stdout.write('UU a.txt\\nAA b.txt\\n?? ignored.txt\\n');",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'merge' && args[1] === '--abort') {",
        "  process.exit(0);",
        "}",
        "process.stderr.write('unexpected args: ' + JSON.stringify(args));",
        "process.exit(2);",
        "",
      ].join("\n"),
      async (cwd) => {
        const result = await mergeBranch("feature", "main", "merge-commit", cwd);
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.conflicted, true);
        assert.deepStrictEqual(result.conflictingFiles, ["a.txt", "b.txt"]);
        assert.ok(result.message.includes("Merge conflict"));
      },
    );
  });

  it("createBranch wraps git checkout errors", async () => {
    await withFakeGit(
      [
        "const args = process.argv.slice(2);",
        "if (args[0] === 'checkout' && args[1] === '-b') {",
        "  process.stderr.write('fatal: something went wrong\\n');",
        "  process.exit(1);",
        "}",
        "process.stderr.write('unexpected args: ' + JSON.stringify(args));",
        "process.exit(2);",
        "",
      ].join("\n"),
      async (cwd) => {
        await assert.rejects(
          () => createBranch("topic/test", cwd),
          (err: unknown) =>
            err instanceof Error &&
            err.message.includes('Failed to create branch "topic/test"') &&
            err.message.includes("fatal"),
        );
      },
    );
  });
});
