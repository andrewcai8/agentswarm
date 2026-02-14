/**
 * Reconciler - Timer-based sweep that keeps the target repo green.
 * Periodically runs tsc + npm test, and creates fix tasks when failures are detected.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Task } from "@agentswarm/core";
import { createLogger } from "@agentswarm/core";
import type { OrchestratorConfig } from "./config.js";
import type { TaskQueue } from "./task-queue.js";
import type { Monitor } from "./monitor.js";
import { LLMClient, type LLMMessage } from "./llm-client.js";
import { parseLLMTaskArray } from "./shared.js";

const execFileAsync = promisify(execFile);
const logger = createLogger("reconciler", "reconciler");

export interface ReconcilerConfig {
  /** How often to sweep (ms). Default 300_000 = 5 min */
  intervalMs: number;
  /** Max fix tasks created per sweep. Default 5 */
  maxFixTasks: number;
}

export const DEFAULT_RECONCILER_CONFIG: ReconcilerConfig = {
  intervalMs: 300_000,
  maxFixTasks: 5,
};

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Runs a command and captures output + exit code without throwing.
 */
async function runCommand(cmd: string, args: string[], cwd: string): Promise<ExecResult> {
  try {
    const result = await execFileAsync(cmd, args, { cwd, maxBuffer: 1024 * 1024 });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; code?: number | null };
    return {
      stdout: err.stdout || "",
      stderr: err.stderr || "",
      code: err.code ?? 1,
    };
  }
}

/**
 * Reconciler that periodically checks if the target repo builds and tests pass.
 * When failures are detected, it calls the LLM to produce fix tasks and enqueues them.
 */
export class Reconciler {
  private config: OrchestratorConfig;
  private reconcilerConfig: ReconcilerConfig;
  private llmClient: LLMClient;
  private taskQueue: TaskQueue;
  private monitor: Monitor;
  private systemPrompt: string;
  private targetRepoPath: string;

  private timer: ReturnType<typeof setInterval> | null;
  private running: boolean;
  private fixCounter: number;

  private sweepCompleteCallbacks: ((tasks: Task[]) => void)[];
  private errorCallbacks: ((error: Error) => void)[];

  constructor(
    config: OrchestratorConfig,
    reconcilerConfig: ReconcilerConfig,
    taskQueue: TaskQueue,
    monitor: Monitor,
    systemPrompt: string,
  ) {
    this.config = config;
    this.reconcilerConfig = reconcilerConfig;
    this.taskQueue = taskQueue;
    this.monitor = monitor;
    this.systemPrompt = systemPrompt;
    this.targetRepoPath = config.targetRepoPath;

    this.timer = null;
    this.running = false;
    this.fixCounter = 0;

    this.llmClient = new LLMClient({
      endpoints: config.llm.endpoints,
      model: config.llm.model,
      maxTokens: config.llm.maxTokens,
      temperature: config.llm.temperature,
    });

    this.sweepCompleteCallbacks = [];
    this.errorCallbacks = [];
  }

  /**
   * Start the periodic sweep timer
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    this.timer = setInterval(async () => {
      try {
        const tasks = await this.sweep();
        for (const cb of this.sweepCompleteCallbacks) {
          cb(tasks);
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error("Sweep failed", { error: err.message });
        for (const cb of this.errorCallbacks) {
          cb(err);
        }
      }
    }, this.reconcilerConfig.intervalMs);

    logger.info("Reconciler started", { intervalMs: this.reconcilerConfig.intervalMs });
  }

  /**
   * Stop the periodic sweep timer
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    logger.info("Reconciler stopped");
  }

  /**
   * Check if reconciler is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Run a single sweep: check build + tests, create fix tasks if needed.
   */
  async sweep(): Promise<Task[]> {
    logger.info("Starting reconciler sweep");

    const tscResult = await runCommand("npx", ["tsc", "--noEmit"], this.targetRepoPath);
    const buildOutput = tscResult.stdout + tscResult.stderr;
    const buildOk = tscResult.code === 0 && !tscResult.stderr?.includes("error TS");

    const testResult = await runCommand("npm", ["test"], this.targetRepoPath);
    const testOutput = testResult.stdout + testResult.stderr;
    const testsOk = testResult.code === 0 && !testResult.stderr?.includes("FAIL");

    logger.info("Sweep check results", { buildOk, testsOk });

    if (buildOk && testsOk) {
      logger.info("All green — no fix tasks needed");
      return [];
    }

    const gitResult = await runCommand("git", ["log", "--oneline", "-10"], this.targetRepoPath);
    const recentCommits = gitResult.stdout.trim();

    let userMessage = "";

    if (!buildOk) {
      userMessage += `## Build Output (tsc --noEmit)\n\`\`\`\n${buildOutput.slice(0, 8000)}\n\`\`\`\n\n`;
    }

    if (!testsOk) {
      userMessage += `## Test Output (npm test)\n\`\`\`\n${testOutput.slice(0, 8000)}\n\`\`\`\n\n`;
    }

    userMessage += `## Recent Commits\n${recentCommits}\n`;

    const messages: LLMMessage[] = [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: userMessage },
    ];

    logger.info("Calling LLM for fix task generation", { messageLength: userMessage.length });

    const response = await this.llmClient.complete(messages);
    this.monitor.recordTokenUsage(response.usage.totalTokens);

    const rawTasks = parseLLMTaskArray(response.content);
    const capped = rawTasks.slice(0, this.reconcilerConfig.maxFixTasks);

    const tasks: Task[] = capped.map((raw) => {
      this.fixCounter++;
      const id = raw.id || `fix-${String(this.fixCounter).padStart(3, "0")}`;
      return {
        id,
        description: raw.description,
        scope: raw.scope || [],
        acceptance: raw.acceptance || "tsc --noEmit returns 0 and npm test returns 0",
        branch: raw.branch || `${this.config.git.branchPrefix}${id}`,
        status: "pending" as const,
        createdAt: Date.now(),
        priority: 1,
      };
    });

    for (const task of tasks) {
      this.taskQueue.enqueue(task);
    }

    logger.info(`Created ${tasks.length} fix tasks`, {
      taskIds: tasks.map((t) => t.id),
    });

    return tasks;
  }

  /**
   * Register callback for sweep completion
   */
  onSweepComplete(callback: (tasks: Task[]) => void): void {
    this.sweepCompleteCallbacks.push(callback);
  }

  /**
   * Register callback for errors
   */
  onError(callback: (error: Error) => void): void {
    this.errorCallbacks.push(callback);
  }
}
