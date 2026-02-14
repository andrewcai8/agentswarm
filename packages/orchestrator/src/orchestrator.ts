/**
 * Orchestrator Factory — creates and wires all components.
 *
 * Used by both main.ts (standalone CLI) and the Pi extension.
 * Keeps wiring logic in one place so the extension doesn't duplicate it.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Task, Handoff, MetricsSnapshot } from "@agentswarm/core";
import { createLogger } from "@agentswarm/core";
import { loadConfig, type OrchestratorConfig } from "./config.js";
import { TaskQueue } from "./task-queue.js";
import { WorkerPool } from "./worker-pool.js";
import { MergeQueue } from "./merge-queue.js";
import { Monitor } from "./monitor.js";
import { Planner } from "./planner.js";
import { Reconciler } from "./reconciler.js";

const logger = createLogger("orchestrator", "root-planner");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OrchestratorCallbacks {
  onTaskCreated?: (task: Task) => void;
  onTaskCompleted?: (task: Task, handoff: Handoff) => void;
  onIterationComplete?: (iteration: number, tasks: Task[], handoffs: Handoff[]) => void;
  onError?: (error: Error) => void;
  onSweepComplete?: (tasks: Task[]) => void;
  onReconcilerError?: (error: Error) => void;
  onWorkerTimeout?: (workerId: string, taskId: string) => void;
  onEmptyDiff?: (workerId: string, taskId: string) => void;
  onMetricsUpdate?: (snapshot: MetricsSnapshot) => void;
  onTaskStatusChange?: (task: Task, oldStatus: string, newStatus: string) => void;
}

export interface Orchestrator {
  /** Underlying components — exposed for advanced use cases. */
  planner: Planner;
  reconciler: Reconciler;
  monitor: Monitor;
  workerPool: WorkerPool;
  taskQueue: TaskQueue;
  mergeQueue: MergeQueue;
  config: OrchestratorConfig;

  /** Start background services (worker pool, monitor, reconciler). */
  start(): Promise<void>;

  /** Gracefully stop all services. */
  stop(): Promise<void>;

  /**
   * Full lifecycle: start → planner.runLoop(request) → stop.
   * Returns the final metrics snapshot.
   */
  run(request: string): Promise<MetricsSnapshot>;

  /** Whether the planner loop is currently running. */
  isRunning(): boolean;

  /** Current metrics snapshot. */
  getSnapshot(): MetricsSnapshot;
}

export interface CreateOrchestratorOptions {
  /**
   * Project root directory. Prompts are read from `<projectRoot>/prompts/`.
   * Defaults to `process.cwd()`.
   */
  projectRoot?: string;

  /**
   * Override individual config values loaded from env.
   * Applied on top of loadConfig().
   */
  configOverrides?: Partial<Pick<OrchestratorConfig, "maxWorkers" | "targetRepoPath">>;

  /** Max planner iterations before stopping. Default: 100. */
  maxIterations?: number;

  /** Reconciler sweep interval in ms. Default: 300_000 (5 min). */
  reconcilerIntervalMs?: number;

  /** Max fix tasks per reconciler sweep. Default: 5. */
  reconcilerMaxFixTasks?: number;

  /** Callbacks wired to planner/monitor/reconciler events. */
  callbacks?: OrchestratorCallbacks;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createOrchestrator(
  options: CreateOrchestratorOptions = {},
): Promise<Orchestrator> {
  const projectRoot = options.projectRoot ?? process.cwd();

  // --- Config ---
  const config = loadConfig();
  if (options.configOverrides?.maxWorkers !== undefined) {
    config.maxWorkers = options.configOverrides.maxWorkers;
  }
  if (options.configOverrides?.targetRepoPath !== undefined) {
    config.targetRepoPath = options.configOverrides.targetRepoPath;
  }

  logger.info("Config loaded", {
    maxWorkers: config.maxWorkers,
    targetRepo: config.targetRepoPath,
  });

  // --- Prompts ---
  const readPrompt = async (name: string): Promise<string> => {
    const promptPath = resolve(projectRoot, "prompts", `${name}.md`);
    return readFile(promptPath, "utf-8");
  };

  const [rootPrompt, workerPrompt, reconcilerPrompt] = await Promise.all([
    readPrompt("root-planner"),
    readPrompt("worker"),
    readPrompt("reconciler"),
  ]);

  // --- Components ---
  const taskQueue = new TaskQueue();

  const workerPool = new WorkerPool(
    {
      maxWorkers: config.maxWorkers,
      workerTimeout: config.workerTimeout,
      llm: config.llm,
      git: config.git,
      pythonPath: config.pythonPath,
    },
    workerPrompt,
  );

  const mergeQueue = new MergeQueue({
    mergeStrategy: config.mergeStrategy,
    mainBranch: config.git.mainBranch,
    repoPath: config.targetRepoPath,
  });

  const monitor = new Monitor(
    {
      healthCheckInterval: config.healthCheckInterval,
      workerTimeout: config.workerTimeout,
    },
    workerPool,
    taskQueue,
  );

  const planner = new Planner(
    config,
    { maxIterations: options.maxIterations ?? 100 },
    taskQueue,
    workerPool,
    mergeQueue,
    monitor,
    rootPrompt,
  );

  const reconciler = new Reconciler(
    config,
    {
      intervalMs: options.reconcilerIntervalMs ?? 300_000,
      maxFixTasks: options.reconcilerMaxFixTasks ?? 5,
    },
    taskQueue,
    monitor,
    reconcilerPrompt,
  );

  // --- Wire callbacks ---
  const cb = options.callbacks;
  if (cb?.onTaskCreated) planner.onTaskCreated(cb.onTaskCreated);
  if (cb?.onTaskCompleted) planner.onTaskCompleted(cb.onTaskCompleted);
  if (cb?.onIterationComplete) planner.onIterationComplete(cb.onIterationComplete);
  if (cb?.onError) planner.onError(cb.onError);
  if (cb?.onSweepComplete) reconciler.onSweepComplete(cb.onSweepComplete);
  if (cb?.onReconcilerError) reconciler.onError(cb.onReconcilerError);
  if (cb?.onWorkerTimeout) monitor.onWorkerTimeout(cb.onWorkerTimeout);
  if (cb?.onEmptyDiff) monitor.onEmptyDiff(cb.onEmptyDiff);
  if (cb?.onMetricsUpdate) monitor.onMetricsUpdate(cb.onMetricsUpdate);
  if (cb?.onTaskStatusChange) taskQueue.onStatusChange(cb.onTaskStatusChange);

  // --- Instance ---
  let started = false;

  const instance: Orchestrator = {
    planner,
    reconciler,
    monitor,
    workerPool,
    taskQueue,
    mergeQueue,
    config,

    async start() {
      if (started) return;
      started = true;
      await workerPool.start();
      monitor.start();
      reconciler.start();
      logger.info("Orchestrator started");
    },

    async stop() {
      planner.stop();
      reconciler.stop();
      monitor.stop();
      await workerPool.stop();
      started = false;

      const snapshot = monitor.getSnapshot();
      logger.info("Orchestrator stopped", { ...snapshot });
    },

    async run(request: string) {
      await instance.start();

      logger.info("Beginning planner loop", { request: request.slice(0, 200) });
      await planner.runLoop(request);

      const snapshot = monitor.getSnapshot();
      logger.info("Planner loop complete", { ...snapshot });

      await instance.stop();

      return snapshot;
    },

    isRunning() {
      return planner.isRunning();
    },

    getSnapshot() {
      return monitor.getSnapshot();
    },
  };

  return instance;
}
