import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { clearConfigCache } from "../config.js";
import { createOrchestrator } from "../orchestrator.js";

async function withTempProject<T>(
  writePrompts: boolean,
  run: (projectRoot: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "orchestrator-test-"));
  try {
    if (writePrompts) {
      const promptsDir = join(root, "prompts");
      await mkdir(promptsDir, { recursive: true });
      await writeFile(join(promptsDir, "root-planner.md"), "Root planner prompt");
      await writeFile(join(promptsDir, "worker.md"), "Worker prompt");
      await writeFile(join(promptsDir, "reconciler.md"), "Reconciler prompt");
      await writeFile(join(promptsDir, "subplanner.md"), "Subplanner prompt");
    }
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withEnv<T>(
  env: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  clearConfigCache();
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    clearConfigCache();
  }
}

const REQUIRED_ENV = {
  GIT_REPO_URL: "https://github.com/example/repo.git",
  LLM_BASE_URL: "https://api.example.com/v1",
};

describe("createOrchestrator", () => {
  it("throws when prompt files are missing", async () => {
    await withEnv(REQUIRED_ENV, async () => {
      await withTempProject(false, async (projectRoot) => {
        await assert.rejects(() => createOrchestrator({ projectRoot }), /ENOENT|no such file/i);
      });
    });
  });

  it("applies config overrides and finalization options", async () => {
    await withEnv(REQUIRED_ENV, async () => {
      await withTempProject(true, async (projectRoot) => {
        const orchestrator = await createOrchestrator({
          projectRoot,
          configOverrides: {
            maxWorkers: 3,
            targetRepoPath: "/tmp/custom-target",
          },
          finalizationEnabled: false,
          finalizationMaxAttempts: 1,
        });

        assert.strictEqual(orchestrator.config.maxWorkers, 3);
        assert.strictEqual(orchestrator.config.targetRepoPath, "/tmp/custom-target");
        assert.strictEqual(orchestrator.config.finalization.enabled, false);
        assert.strictEqual(orchestrator.config.finalization.maxAttempts, 1);
      });
    });
  });

  it("start/stop are idempotent when planner loop is not running", async () => {
    await withEnv(REQUIRED_ENV, async () => {
      await withTempProject(true, async (projectRoot) => {
        const orchestrator = await createOrchestrator({ projectRoot });

        assert.strictEqual(orchestrator.isRunning(), false);
        await orchestrator.start();
        await orchestrator.start();
        assert.strictEqual(orchestrator.isRunning(), false);

        await orchestrator.stop();
        await orchestrator.stop();
        assert.strictEqual(orchestrator.isRunning(), false);
      });
    });
  });
});
