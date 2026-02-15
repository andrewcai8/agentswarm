/**
 * Reconciler - Timer-based sweep that keeps the target repo green.
 * Periodically runs tsc + npm test, and creates fix tasks when failures are detected.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Task, Tracer, Span } from "@agentswarm/core";
import { createLogger } from "@agentswarm/core";
import type { OrchestratorConfig } from "./config.js";
import type { TaskQueue } from "./task-queue.js";
import type { Monitor } from "./monitor.js";
import { LLMClient, type LLMMessage } from "./llm-client.js";
import { parseLLMTaskArray, slugifyForBranch } from "./shared.js";

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

  private tracer: Tracer | null = null;
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
      timeoutMs: config.llm.timeoutMs,
    });

    this.sweepCompleteCallbacks = [];
    this.errorCallbacks = [];
  }

  setTracer(tracer: Tracer): void {
    this.tracer = tracer;
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
    const sweepSpan = this.tracer?.startSpan("reconciler.sweep", { agentId: "reconciler" });

    const buildSpan = sweepSpan?.child("reconciler.build");
    logger.debug("Running tsc --noEmit", { targetRepo: this.targetRepoPath });
    const tscResult = await runCommand("npx", ["tsc", "--noEmit"], this.targetRepoPath);
    const buildOutput = tscResult.stdout + tscResult.stderr;
    const buildNotConfigured = /no inputs were found|could not find a valid tsconfig/i.test(buildOutput);
    const buildOk = buildNotConfigured || (tscResult.code === 0 && !tscResult.stderr?.includes("error TS"));
    logger.debug("tsc result", { exitCode: tscResult.code, ok: buildOk, buildNotConfigured, stdoutSize: tscResult.stdout.length, stderrSize: tscResult.stderr.length, outputPreview: buildOutput.slice(0, 500) });
    buildSpan?.setAttributes({ exitCode: tscResult.code ?? -1, ok: buildOk, buildNotConfigured });
    buildSpan?.end();

    const testSpan = sweepSpan?.child("reconciler.test");
    logger.debug("Running npm test", { targetRepo: this.targetRepoPath });
    const testResult = await runCommand("npm", ["test"], this.targetRepoPath);
    const testOutput = testResult.stdout + testResult.stderr;
    const testNotConfigured = /Missing script|no test specified/i.test(testOutput);
    const testsOk = testNotConfigured || (testResult.code === 0 && !testResult.stderr?.includes("FAIL"));
    logger.debug("npm test result", { exitCode: testResult.code, ok: testsOk, testNotConfigured, stdoutSize: testResult.stdout.length, stderrSize: testResult.stderr.length, outputPreview: testOutput.slice(0, 500) });
    testSpan?.setAttributes({ exitCode: testResult.code ?? -1, ok: testsOk, testNotConfigured });
    testSpan?.end();

    const conflictResult = await runCommand(
      "grep", ["-rl", "<<<<<<<", "--include=*.ts", "--include=*.tsx", "--include=*.js", "--include=*.json", "."],
      this.targetRepoPath,
    );
    const conflictFiles = conflictResult.stdout.trim().split("\n").filter(Boolean);
    const hasConflictMarkers = conflictFiles.length > 0;

    logger.info("Sweep check results", { buildOk, testsOk, hasConflictMarkers, conflictFileCount: conflictFiles.length });

    if (buildOk && testsOk && !hasConflictMarkers) {
      logger.info("All green — no fix tasks needed");
      sweepSpan?.setAttributes({ buildOk, testsOk, hasConflictMarkers, fixTasksCreated: 0 });
      sweepSpan?.setStatus("ok");
      sweepSpan?.end();
      return [];
    }

    const gitResult = await runCommand("git", ["log", "--oneline", "-10"], this.targetRepoPath);
    const recentCommits = gitResult.stdout.trim();

    let userMessage = "";

    if (hasConflictMarkers) {
      userMessage += `## Merge Conflict Markers Found\nFiles with unresolved conflict markers (<<<<<<< / ======= / >>>>>>>):\n`;
      for (const f of conflictFiles.slice(0, 20)) {
        userMessage += `- ${f}\n`;
      }
      userMessage += `\n`;
    }

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
    logger.debug("Reconciler LLM prompt", { systemPromptSize: this.systemPrompt.length, userMessagePreview: userMessage.slice(0, 500) });

    let rawTasks: ReturnType<typeof parseLLMTaskArray>;

    try {
      const response = await this.llmClient.complete(messages, undefined, sweepSpan);
      this.monitor.recordTokenUsage(response.usage.totalTokens);
      logger.debug("Reconciler LLM response", { contentLength: response.content.length, preview: response.content.slice(0, 500), tokens: response.usage.totalTokens, endpoint: response.endpoint, latencyMs: response.latencyMs });
      rawTasks = parseLLMTaskArray(response.content);
    } catch (llmError) {
      const errMsg = llmError instanceof Error ? llmError.message : String(llmError);
      logger.warn("LLM unreachable for reconciler — skipping fix task generation (will retry next sweep)", {
        error: errMsg,
        buildOk,
        testsOk,
        hasConflictMarkers,
      });
      sweepSpan?.setAttributes({ buildOk, testsOk, hasConflictMarkers, llmFailed: true, fixTasksCreated: 0 });
      sweepSpan?.setStatus("error", `LLM unreachable: ${errMsg}`);
      sweepSpan?.end();
      return [];
    }

    const capped = rawTasks.slice(0, this.reconcilerConfig.maxFixTasks);

    const tasks: Task[] = capped.map((raw) => {
      this.fixCounter++;
      const id = raw.id || `fix-${String(this.fixCounter).padStart(3, "0")}`;
      return {
        id,
        description: raw.description,
        scope: raw.scope || [],
        acceptance: raw.acceptance || "tsc --noEmit returns 0 and npm test returns 0",
        branch: raw.branch || `${this.config.git.branchPrefix}${id}-${slugifyForBranch(raw.description)}`,
        status: "pending" as const,
        createdAt: Date.now(),
        priority: 1,
      };
    });

    logger.info(`Created ${tasks.length} fix tasks`, {
      taskIds: tasks.map((t) => t.id),
    });

    sweepSpan?.setAttributes({
      buildOk,
      testsOk,
      hasConflictMarkers,
      fixTasksCreated: tasks.length,
    });
    sweepSpan?.setStatus(buildOk && testsOk && !hasConflictMarkers ? "ok" : "error");
    sweepSpan?.end();

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
