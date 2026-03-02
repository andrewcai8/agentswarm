/** @module Health monitoring and metrics snapshot collection for orchestrator state reporting */

import type { MetricsSnapshot } from "@longshot/core";
import { createLogger } from "@longshot/core";
import type { TaskQueue } from "./task-queue.js";
import type { Worker, WorkerPool } from "./worker-pool.js";

const logger = createLogger("monitor", "root-planner");

export interface MonitorConfig {
  healthCheckInterval: number;
  workerTimeout: number;
}

export class Monitor {
  private config: MonitorConfig;
  private workerPool: WorkerPool;
  private taskQueue: TaskQueue;
  private pollTimer: ReturnType<typeof setInterval> | null;
  private running: boolean;

  private totalTokensUsed: number;
  private totalCostUsd: number;
  private mergeAttempts: number;
  private mergeSuccesses: number;
  private suspiciousTaskCount: number;
  private startTime: number;
  private finalizationMetrics: {
    attempts: number;
    buildPassed: boolean;
    testsPassed: boolean;
    allMerged: boolean;
    unmergedCount: number;
    durationMs: number;
  } | null = null;

  private onTimeoutCallbacks: ((workerId: string, taskId: string) => void)[];
  private onEmptyDiffCallbacks: ((workerId: string, taskId: string) => void)[];
  private onMetricsCallbacks: ((snapshot: MetricsSnapshot) => void)[];

  constructor(config: MonitorConfig, workerPool: WorkerPool, taskQueue: TaskQueue) {
    this.config = config;
    this.workerPool = workerPool;
    this.taskQueue = taskQueue;
    this.pollTimer = null;
    this.running = false;

    this.totalTokensUsed = 0;
    this.totalCostUsd = 0;
    this.mergeAttempts = 0;
    this.mergeSuccesses = 0;
    this.suspiciousTaskCount = 0;
    this.startTime = Date.now();

    this.onTimeoutCallbacks = [];
    this.onEmptyDiffCallbacks = [];
    this.onMetricsCallbacks = [];
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startTime = Date.now();

    this.pollTimer = setInterval(() => {
      this.poll();
    }, this.config.healthCheckInterval * 1000);

    logger.info("Monitor started", { interval: this.config.healthCheckInterval });
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.running = false;
    logger.info("Monitor stopped");
  }

  isRunning(): boolean {
    return this.running;
  }

  poll(): void {
    const workers = this.workerPool.getAllWorkers();
    logger.debug("Monitor poll", {
      workerCount: workers.length,
      pendingTasks: this.taskQueue.getPendingCount(),
      runningTasks: this.taskQueue.getRunningCount(),
      totalTokens: this.totalTokensUsed,
    });

    for (const worker of workers) {
      if (this.isWorkerTimedOut(worker)) {
        const taskId = worker.currentTask.id;
        const elapsedSec = Math.round((Date.now() - worker.startedAt) / 1000);
        logger.debug("Worker timeout check failed", {
          workerId: worker.id,
          taskId,
          elapsedSec,
          timeoutSec: this.config.workerTimeout,
        });
        logger.error("Worker timed out", { workerId: worker.id, taskId });
        for (const cb of this.onTimeoutCallbacks) {
          cb(worker.id, taskId);
        }
      }
    }

    const snapshot = this.getSnapshot();
    for (const cb of this.onMetricsCallbacks) {
      cb(snapshot);
    }
  }

  isWorkerTimedOut(worker: Worker): boolean {
    const elapsed = (Date.now() - worker.startedAt) / 1000;
    return elapsed > this.config.workerTimeout;
  }

  getTimedOutWorkers(): Worker[] {
    return this.workerPool.getAllWorkers().filter((w) => this.isWorkerTimedOut(w));
  }

  getSnapshot(): MetricsSnapshot {
    const elapsedHours = Math.max((Date.now() - this.startTime) / 3600000, 0.001);
    const completedCount = this.taskQueue.getCompletedCount();
    const activeToolCalls = this.workerPool.getTotalActiveToolCalls();
    const ESTIMATED_TOKENS_PER_TOOL_CALL = 3000;

    const snapshot: MetricsSnapshot = {
      timestamp: Date.now(),
      activeWorkers: this.workerPool.getActiveTaskCount(),
      pendingTasks: this.taskQueue.getPendingCount(),
      runningTasks: this.taskQueue.getRunningCount(),
      completedTasks: completedCount,
      failedTasks: this.taskQueue.getFailedCount(),
      suspiciousTaskCount: this.suspiciousTaskCount,
      commitsPerHour: completedCount / elapsedHours,
      mergeSuccessRate: this.mergeAttempts > 0 ? this.mergeSuccesses / this.mergeAttempts : 0,
      totalTokensUsed: this.totalTokensUsed,
      totalCostUsd: this.totalCostUsd,
      activeToolCalls,
      estimatedInFlightTokens: activeToolCalls * ESTIMATED_TOKENS_PER_TOOL_CALL,
    };

    if (this.finalizationMetrics) {
      snapshot.finalizationAttempts = this.finalizationMetrics.attempts;
      snapshot.finalizationBuildPassed = this.finalizationMetrics.buildPassed;
      snapshot.finalizationTestsPassed = this.finalizationMetrics.testsPassed;
      snapshot.finalizationAllMerged = this.finalizationMetrics.allMerged;
      snapshot.finalizationUnmergedCount = this.finalizationMetrics.unmergedCount;
      snapshot.finalizationDurationMs = this.finalizationMetrics.durationMs;
    }

    return snapshot;
  }

  recordTokenUsage(tokens: number): void {
    this.totalTokensUsed += tokens;
  }

  recordMergeAttempt(success: boolean): void {
    this.mergeAttempts += 1;
    if (success) {
      this.mergeSuccesses += 1;
    }
  }

  recordEmptyDiff(workerId: string, taskId: string): void {
    logger.warn("Empty diff detected", { workerId, taskId });
    for (const cb of this.onEmptyDiffCallbacks) {
      cb(workerId, taskId);
    }
  }

  recordSuspiciousTask(taskId: string, reason: string): void {
    this.suspiciousTaskCount++;
    logger.warn("Suspicious task detected", {
      taskId,
      reason,
      totalSuspicious: this.suspiciousTaskCount,
    });
  }

  setFinalizationMetrics(metrics: {
    attempts: number;
    buildPassed: boolean;
    testsPassed: boolean;
    allMerged: boolean;
    unmergedCount: number;
    durationMs: number;
  }): void {
    this.finalizationMetrics = metrics;
    logger.info("Finalization metrics recorded", metrics);
  }

  onWorkerTimeout(callback: (workerId: string, taskId: string) => void): void {
    this.onTimeoutCallbacks.push(callback);
  }

  onEmptyDiff(callback: (workerId: string, taskId: string) => void): void {
    this.onEmptyDiffCallbacks.push(callback);
  }

  onMetricsUpdate(callback: (snapshot: MetricsSnapshot) => void): void {
    this.onMetricsCallbacks.push(callback);
  }
}
