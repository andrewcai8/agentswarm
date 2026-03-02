import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { MonitorConfig } from "../monitor.js";
import { Monitor } from "../monitor.js";
import type { TaskQueue } from "../task-queue.js";
import type { Worker, WorkerPool } from "../worker-pool.js";

function createMockWorkerPool(workers: Worker[] = [], totalActiveToolCalls = 0): WorkerPool {
  return {
    getAllWorkers: () => workers,
    getAvailableWorkers: () => [],
    getWorkerCount: () => workers.length,
    getActiveTaskCount: () => workers.length,
    getTotalActiveToolCalls: () => totalActiveToolCalls,
  } as unknown as WorkerPool;
}

function createMockTaskQueue(
  counts = { pending: 0, completed: 0, failed: 0, running: 0 },
): TaskQueue {
  return {
    getPendingCount: () => counts.pending,
    getCompletedCount: () => counts.completed,
    getFailedCount: () => counts.failed,
    getRunningCount: () => counts.running,
  } as unknown as TaskQueue;
}

function makeWorker(overrides?: Partial<Worker>): Worker {
  const now = Date.now();
  return {
    id: "ephemeral-task-1",
    currentTask: {
      id: "task-1",
      description: "test",
      scope: [],
      acceptance: "",
      branch: "worker/task-1",
      status: "running" as const,
      createdAt: now,
      priority: 5,
    },
    startedAt: now,
    ...overrides,
  };
}

function createConfig(): MonitorConfig {
  return {
    healthCheckInterval: 60,
    workerTimeout: 300,
  };
}

describe("Monitor", () => {
  let monitor: Monitor;
  let config: MonitorConfig;

  afterEach(() => {
    if (monitor && monitor.isRunning()) {
      monitor.stop();
    }
  });

  describe("start/stop", () => {
    it("start sets running to true", () => {
      config = createConfig();
      monitor = new Monitor(config, createMockWorkerPool(), createMockTaskQueue());
      monitor.start();
      assert.strictEqual(monitor.isRunning(), true);
      monitor.stop();
    });

    it("stop sets running to false", () => {
      config = createConfig();
      monitor = new Monitor(config, createMockWorkerPool(), createMockTaskQueue());
      monitor.start();
      assert.strictEqual(monitor.isRunning(), true);
      monitor.stop();
      assert.strictEqual(monitor.isRunning(), false);
    });
  });

  describe("isWorkerTimedOut", () => {
    it("returns false for recently started worker", () => {
      config = createConfig();
      const worker = makeWorker({ startedAt: Date.now() });
      monitor = new Monitor(config, createMockWorkerPool([worker]), createMockTaskQueue());
      assert.strictEqual(monitor.isWorkerTimedOut(worker), false);
    });

    it("returns true for long-running worker", () => {
      config = createConfig();
      const startedAt = Date.now() - config.workerTimeout * 1000 - 10000;
      const worker = makeWorker({ startedAt });
      monitor = new Monitor(config, createMockWorkerPool([worker]), createMockTaskQueue());
      assert.strictEqual(monitor.isWorkerTimedOut(worker), true);
    });
  });

  describe("getSnapshot", () => {
    it("returns correct metrics", () => {
      config = createConfig();
      const worker = makeWorker();
      const pool = createMockWorkerPool([worker]);
      const queue = createMockTaskQueue({ pending: 5, completed: 10, failed: 2, running: 1 });
      monitor = new Monitor(config, pool, queue);

      const snapshot = monitor.getSnapshot();

      assert.strictEqual(snapshot.activeWorkers, 1);
      assert.strictEqual(snapshot.pendingTasks, 5);
      assert.strictEqual(snapshot.runningTasks, 1);
      assert.strictEqual(snapshot.completedTasks, 10);
      assert.strictEqual(snapshot.failedTasks, 2);
      assert.ok(snapshot.timestamp > 0);
      assert.ok(snapshot.commitsPerHour >= 0);
      assert.ok(snapshot.mergeSuccessRate >= 0);
      assert.strictEqual(snapshot.totalTokensUsed, 0);
      assert.strictEqual(snapshot.totalCostUsd, 0);
      assert.strictEqual(snapshot.activeToolCalls, 0);
      assert.strictEqual(snapshot.estimatedInFlightTokens, 0);
    });

    it("includes active tool calls and estimated in-flight tokens", () => {
      config = createConfig();
      const worker = makeWorker();
      const pool = createMockWorkerPool([worker], 20);
      const queue = createMockTaskQueue({ pending: 0, completed: 0, failed: 0, running: 1 });
      monitor = new Monitor(config, pool, queue);

      const snapshot = monitor.getSnapshot();
      assert.strictEqual(snapshot.activeToolCalls, 20);
      assert.strictEqual(snapshot.estimatedInFlightTokens, 60000);
    });
  });

  describe("recordTokenUsage", () => {
    it("accumulates tokens", () => {
      config = createConfig();
      monitor = new Monitor(config, createMockWorkerPool(), createMockTaskQueue());

      monitor.recordTokenUsage(100);
      monitor.recordTokenUsage(200);

      const snapshot = monitor.getSnapshot();
      assert.strictEqual(snapshot.totalTokensUsed, 300);
    });
  });

  describe("recordMergeAttempt", () => {
    it("tracks success rate", () => {
      config = createConfig();
      monitor = new Monitor(config, createMockWorkerPool(), createMockTaskQueue());

      monitor.recordMergeAttempt(true);
      monitor.recordMergeAttempt(true);
      monitor.recordMergeAttempt(true);
      monitor.recordMergeAttempt(false);

      const snapshot = monitor.getSnapshot();
      assert.strictEqual(snapshot.mergeSuccessRate, 0.75);
    });
  });

  describe("recordEmptyDiff", () => {
    it("fires callback", () => {
      config = createConfig();
      monitor = new Monitor(config, createMockWorkerPool(), createMockTaskQueue());

      let called = false;
      let receivedWorkerId = "";
      let receivedTaskId = "";

      monitor.onEmptyDiff((workerId, taskId) => {
        called = true;
        receivedWorkerId = workerId;
        receivedTaskId = taskId;
      });

      monitor.recordEmptyDiff("ephemeral-abc", "task-xyz");

      assert.strictEqual(called, true);
      assert.strictEqual(receivedWorkerId, "ephemeral-abc");
      assert.strictEqual(receivedTaskId, "task-xyz");
    });
  });

  describe("getTimedOutWorkers", () => {
    it("filters correctly", () => {
      config = createConfig();
      const now = Date.now();
      const staleTime = now - config.workerTimeout * 1000 - 10000;

      const recentWorker = makeWorker({ id: "worker-1", startedAt: now });
      const timedOutWorker = makeWorker({ id: "worker-2", startedAt: staleTime });

      const pool = createMockWorkerPool([recentWorker, timedOutWorker]);
      monitor = new Monitor(config, pool, createMockTaskQueue());

      const timedOut = monitor.getTimedOutWorkers();

      assert.strictEqual(timedOut.length, 1);
      assert.strictEqual(timedOut[0].id, "worker-2");
    });
  });
});
