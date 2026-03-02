/** @module Serial merge queue with priority ordering, conflict retry, and rebase-based integration */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HarnessConfig, Tracer } from "@longshot/core";
import {
  checkoutBranch,
  mergeBranch as coreMergeBranch,
  createLogger,
  rebaseBranch,
} from "@longshot/core";
import type { GitMutex } from "./shared.js";

const execFileAsync = promisify(execFile);

export type MergeStrategy = HarnessConfig["mergeStrategy"];

export interface MergeQueueResult {
  success: boolean;
  status: "merged" | "skipped" | "failed" | "conflict";
  branch: string;
  message: string;
  conflicts?: string[];
}

export interface MergeConflictInfo {
  branch: string;
  conflictingFiles: string[];
}

export interface MergeStats {
  totalMerged: number;
  totalSkipped: number;
  totalFailed: number;
  totalConflicts: number;
}

const logger = createLogger("merge-queue", "root-planner");

interface MergeQueueEntry {
  branch: string;
  priority: number;
  enqueuedAt: number;
}

export interface MergeQueueDeps {
  execFileAsync: typeof execFileAsync;
  checkoutBranch: typeof checkoutBranch;
  mergeBranch: typeof coreMergeBranch;
  rebaseBranch: typeof rebaseBranch;
  now: () => number;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

export class MergeQueue {
  private queue: MergeQueueEntry[];
  private merged: Set<string>;
  private stats: MergeStats;
  private mergeStrategy: MergeStrategy;
  private mainBranch: string;
  private repoPath: string;
  private gitMutex: GitMutex | null;
  private tracer: Tracer | null = null;

  private backgroundTimer: ReturnType<typeof setTimeout> | null;
  private backgroundRunning: boolean;
  private mergeResultCallbacks: ((result: MergeQueueResult) => void)[];
  private conflictCallbacks: ((info: MergeConflictInfo) => void)[];

  /** Retry-before-fix: how many times a conflicting branch is re-queued before escalating. */
  private retryCount: Map<string, number>;
  private maxConflictRetries: number;

  /**
   * Dependency injection seam for deterministic unit tests.
   * Production uses real git ops; tests can provide a pure in-memory implementation.
   */
  private deps: MergeQueueDeps;

  constructor(
    config: {
      mergeStrategy: MergeStrategy;
      mainBranch: string;
      repoPath: string;
      gitMutex?: GitMutex;
      /** Max times to re-queue a conflicting branch before firing onConflict. Default: 2. */
      maxConflictRetries?: number;
    },
    deps?: Partial<MergeQueueDeps>,
  ) {
    this.queue = [];
    this.merged = new Set();
    this.stats = {
      totalMerged: 0,
      totalSkipped: 0,
      totalFailed: 0,
      totalConflicts: 0,
    };
    this.mergeStrategy = config.mergeStrategy;
    this.mainBranch = config.mainBranch;
    this.repoPath = config.repoPath;
    this.gitMutex = config.gitMutex ?? null;

    this.backgroundTimer = null;
    this.backgroundRunning = false;
    this.mergeResultCallbacks = [];
    this.conflictCallbacks = [];
    this.retryCount = new Map();
    this.maxConflictRetries = config.maxConflictRetries ?? 2;

    this.deps = {
      execFileAsync,
      checkoutBranch,
      mergeBranch: coreMergeBranch,
      rebaseBranch,
      now: () => Date.now(),
      setTimeout,
      clearTimeout,
      ...deps,
    };
  }

  setTracer(tracer: Tracer): void {
    this.tracer = tracer;
  }

  enqueue(branch: string, priority: number = 5): void {
    if (this.merged.has(branch)) {
      logger.debug(`Branch ${branch} already merged, skipping`);
      return;
    }

    if (this.queue.some((e) => e.branch === branch)) {
      logger.debug(`Branch ${branch} already in queue, skipping`);
      return;
    }

    this.queue.push({ branch, priority, enqueuedAt: this.deps.now() });
    this.queue.sort((a, b) =>
      a.priority !== b.priority ? a.priority - b.priority : a.enqueuedAt - b.enqueuedAt,
    );
    logger.debug(`Enqueued branch ${branch}`, { priority });
  }

  dequeue(): string | undefined {
    const entry = this.queue.shift();
    return entry?.branch;
  }

  getQueue(): string[] {
    return this.queue.map((e) => e.branch);
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  resetRetryCount(branch: string): void {
    this.retryCount.delete(branch);
  }

  startBackground(intervalMs: number = 5_000): void {
    if (this.backgroundRunning) return;
    this.backgroundRunning = true;
    logger.info("Background merge queue started", { intervalMs });

    const tick = async (): Promise<void> => {
      if (!this.backgroundRunning) return;
      logger.debug("Merge queue tick", {
        queueLength: this.queue.length,
        mergedCount: this.merged.size,
      });

      try {
        while (this.queue.length > 0 && this.backgroundRunning) {
          const branch = this.dequeue();
          if (branch) {
            const result = await this.mergeBranch(branch);
            for (const cb of this.mergeResultCallbacks) {
              cb(result);
            }
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error("Background merge tick error", { error: msg });
      }

      if (this.backgroundRunning) {
        this.backgroundTimer = this.deps.setTimeout(() => void tick(), intervalMs);
      }
    };

    this.backgroundTimer = this.deps.setTimeout(() => void tick(), intervalMs);
  }

  stopBackground(): void {
    this.backgroundRunning = false;
    if (this.backgroundTimer) {
      this.deps.clearTimeout(this.backgroundTimer);
      this.backgroundTimer = null;
    }
    logger.info("Background merge queue stopped");
  }

  isBackgroundRunning(): boolean {
    return this.backgroundRunning;
  }

  onMergeResult(callback: (result: MergeQueueResult) => void): void {
    this.mergeResultCallbacks.push(callback);
  }

  onConflict(callback: (info: MergeConflictInfo) => void): void {
    this.conflictCallbacks.push(callback);
  }

  async processQueue(): Promise<MergeQueueResult[]> {
    const results: MergeQueueResult[] = [];

    while (this.queue.length > 0) {
      const branch = this.dequeue();
      if (branch) {
        const result = await this.mergeBranch(branch);
        results.push(result);
      }
    }

    return results;
  }

  async mergeBranch(branch: string): Promise<MergeQueueResult> {
    const cwd = this.repoPath;
    const span = this.tracer?.startSpan("merge.attempt", { agentId: "merge-queue" });
    span?.setAttributes({ branch, strategy: this.mergeStrategy, mainBranch: this.mainBranch });

    const taskIdMatch = branch.match(/task-(\d+)/);
    const taskId = taskIdMatch ? `task-${taskIdMatch[1]}` : undefined;
    logger.info(`Attempting to merge branch ${branch} into ${this.mainBranch}`, {
      branch,
      taskId,
      queueRemaining: this.queue.length,
    });

    if (this.gitMutex) {
      await this.gitMutex.acquire();
    }

    try {
      await this.ensureCleanState(this.mainBranch, cwd);

      try {
        await this.deps.execFileAsync("git", ["fetch", "origin", branch], { cwd });
      } catch (fetchError) {
        const fetchMsg = fetchError instanceof Error ? fetchError.message : String(fetchError);
        logger.warn(`Failed to fetch branch ${branch} from origin, trying local`, {
          error: fetchMsg,
        });
      }
      logger.debug("Fetch completed for branch", { branch, taskId });

      await this.deps.checkoutBranch(this.mainBranch, cwd);

      // After fetch, the branch exists as a remote tracking ref (origin/<branch>).
      // git merge cannot resolve bare branch names like "worker/task-049" to their
      // remote tracking counterparts — it only checks refs/heads/. We must use the
      // explicit origin/ prefix so git resolves refs/remotes/origin/<branch>.
      const mergeRef = `origin/${branch}`;
      logger.debug("Attempting merge", {
        mergeRef,
        mainBranch: this.mainBranch,
        strategy: this.mergeStrategy,
      });
      const mergeStartMs = this.deps.now();
      let result = await this.deps.mergeBranch(mergeRef, this.mainBranch, this.mergeStrategy, cwd);

      if (!result.success && !result.conflicted && this.mergeStrategy !== "merge-commit") {
        logger.warn(`${this.mergeStrategy} failed for ${branch}, falling back to merge-commit`, {
          branch,
          taskId,
          originalError: result.message,
        });
        await this.abortMerge(cwd);
        await this.deps.checkoutBranch(this.mainBranch, cwd);
        result = await this.deps.mergeBranch(mergeRef, this.mainBranch, "merge-commit", cwd);
      }

      if (result.success) {
        logger.debug("Merge timing", { branch, durationMs: this.deps.now() - mergeStartMs });
        this.merged.add(branch);
        this.stats.totalMerged++;

        try {
          await this.deps.execFileAsync("git", ["push", "origin", this.mainBranch], { cwd });
          logger.info(`Pushed ${this.mainBranch} to origin after merging ${branch}`, {
            branch,
            taskId,
            totalMerged: this.stats.totalMerged,
          });

          try {
            await this.deps.execFileAsync("git", ["push", "origin", "--delete", branch], { cwd });
            logger.debug(`Deleted remote branch ${branch}`, { branch, taskId });
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.debug(`Best-effort delete of remote branch ${branch} failed`, {
              error: errorMessage,
            });
          }
        } catch (pushError) {
          const pushMsg = pushError instanceof Error ? pushError.message : String(pushError);
          logger.error(`Failed to push ${this.mainBranch} to origin after merging ${branch}`, {
            branch,
            taskId,
            error: pushMsg,
          });
        }

        logger.info(`Successfully merged branch ${branch}`, {
          branch,
          taskId,
          totalMerged: this.stats.totalMerged,
        });
        span?.setAttributes({ status: "merged" });
        span?.setStatus("ok");
        span?.end();
        return { success: true, status: "merged", branch, message: result.message };
      }

      if (result.conflicted) {
        const conflicts = result.conflictingFiles ?? [];
        await this.abortMerge(cwd);

        this.stats.totalConflicts++;

        const retries = this.retryCount.get(branch) ?? 0;
        if (retries < this.maxConflictRetries) {
          // Rebase branch onto latest main before re-queuing so the next
          // merge attempt works against current HEAD rather than a stale base.
          let rebased = false;
          try {
            const localBranch = `retry-rebase-${this.deps.now()}`;
            await this.deps.execFileAsync(
              "git",
              ["checkout", "-b", localBranch, `origin/${branch}`],
              {
                cwd,
              },
            );
            const rebaseResult = await this.deps.rebaseBranch(localBranch, this.mainBranch, cwd);
            if (rebaseResult.success) {
              await this.deps.execFileAsync(
                "git",
                ["push", "origin", `${localBranch}:${branch}`, "--force"],
                { cwd },
              );
              rebased = true;
              logger.info("Rebased branch onto latest main before retry", { branch, taskId });
            }
            await this.ensureCleanState(this.mainBranch, cwd);
            try {
              await this.deps.execFileAsync("git", ["branch", "-D", localBranch], { cwd });
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              logger.debug(`Best-effort delete of local retry branch ${localBranch} failed`, {
                error: errorMessage,
              });
            }
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.warn("Retry rebase flow failed; restoring clean state", {
              branch,
              taskId,
              error: errorMessage,
            });
            await this.ensureCleanState(this.mainBranch, cwd);
          }

          this.enqueue(branch, 1);
          this.retryCount.set(branch, retries + 1);
          logger.info(`Re-queued conflicting branch for retry`, {
            branch,
            taskId,
            retry: retries + 1,
            maxRetries: this.maxConflictRetries,
            conflictingFiles: conflicts,
            rebased,
          });
          span?.setAttributes({ status: "retry", retryCount: retries + 1 });
          span?.setStatus("ok", "conflict retry");
          span?.end();
          return {
            success: false,
            status: "skipped",
            branch,
            message: `Conflict retry ${retries + 1}/${this.maxConflictRetries} — re-queued${rebased ? " (rebased)" : ""}`,
          };
        }

        logger.warn(`Merge conflict on branch ${branch} (retries exhausted)`, {
          branch,
          taskId,
          conflictingFiles: conflicts,
          totalConflicts: this.stats.totalConflicts,
          retriesExhausted: retries,
        });

        for (const cb of this.conflictCallbacks) {
          cb({ branch, conflictingFiles: conflicts });
        }

        span?.setAttributes({ status: "conflict", conflictCount: conflicts.length });
        span?.setStatus("error", "merge conflict");
        span?.end();
        return {
          success: false,
          status: "conflict",
          branch,
          message: `Merge conflict: ${conflicts.length} conflicting files`,
          conflicts,
        };
      }

      this.stats.totalFailed++;
      logger.error(`Failed to merge branch ${branch}`, {
        branch,
        taskId,
        error: result.message,
        totalFailed: this.stats.totalFailed,
      });
      span?.setStatus("error", result.message);
      span?.end();
      return { success: false, status: "failed", branch, message: result.message };
    } catch (error) {
      this.stats.totalFailed++;
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Error merging branch ${branch}`, {
        branch,
        taskId,
        error: msg,
        totalFailed: this.stats.totalFailed,
      });
      span?.setStatus("error", msg);
      span?.end();

      await this.ensureCleanState(this.mainBranch, cwd);

      return { success: false, status: "failed", branch, message: msg };
    } finally {
      if (this.gitMutex) {
        this.gitMutex.release();
      }
    }
  }

  private async abortMerge(cwd: string): Promise<void> {
    try {
      await this.deps.execFileAsync("git", ["rebase", "--abort"], { cwd });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.debug("Best-effort rebase abort failed", { error: errorMessage });
    }
    try {
      await this.deps.execFileAsync("git", ["merge", "--abort"], { cwd });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.debug("Best-effort merge abort failed", { error: errorMessage });
    }
  }

  /**
   * Nuclear git cleanup — best-effort and never throws.
   * Kept as a method so unit tests can inject git operations.
   */
  private async ensureCleanState(mainBranch: string, cwd: string): Promise<void> {
    await this.abortMerge(cwd);
    try {
      await this.deps.execFileAsync("git", ["reset", "--hard", "HEAD"], { cwd });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.debug("Best-effort git reset --hard failed", { error: errorMessage });
    }
    try {
      await this.deps.execFileAsync("git", ["clean", "-fd"], { cwd });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.debug("Best-effort git clean -fd failed", { error: errorMessage });
    }
    try {
      const { stdout } = await this.deps.execFileAsync(
        "git",
        ["branch", "--list", "retry-rebase-*"],
        { cwd },
      );
      const branches = stdout
        .trim()
        .split("\n")
        .map((b) => b.trim())
        .filter(Boolean);
      for (const branch of branches) {
        try {
          await this.deps.execFileAsync("git", ["branch", "-D", branch], { cwd });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.debug(`Best-effort delete of temp branch ${branch} failed`, {
            error: errorMessage,
          });
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.debug("Best-effort temp branch cleanup scan failed", { error: errorMessage });
    }
    try {
      await this.deps.execFileAsync("git", ["checkout", mainBranch], { cwd });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.debug(`Best-effort checkout of ${mainBranch} failed`, { error: errorMessage });
    }
  }

  isBranchMerged(branch: string): boolean {
    return this.merged.has(branch);
  }

  getMergeStats(): MergeStats {
    return { ...this.stats };
  }
}
