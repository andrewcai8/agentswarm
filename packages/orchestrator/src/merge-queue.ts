import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HarnessConfig } from "@agentswarm/core";
import {
  checkoutBranch,
  mergeBranch as coreMergeBranch,
  getConflicts,
  createLogger,
} from "@agentswarm/core";
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

export interface MergeStats {
  totalMerged: number;
  totalSkipped: number;
  totalFailed: number;
  totalConflicts: number;
}

async function abortMerge(cwd: string): Promise<void> {
  try {
    await execFileAsync("git", ["merge", "--abort"], { cwd });
  } catch {
    try {
      await execFileAsync("git", ["rebase", "--abort"], { cwd });
    } catch {
      // Neither merge nor rebase in progress — clean state
    }
  }
}

const logger = createLogger("merge-queue", "root-planner");

export class MergeQueue {
  private queue: string[];
  private merged: Set<string>;
  private stats: MergeStats;
  private mergeStrategy: MergeStrategy;
  private mainBranch: string;
  private repoPath: string;
  private gitMutex: GitMutex | null;

  private backgroundTimer: ReturnType<typeof setTimeout> | null;
  private backgroundRunning: boolean;
  private mergeResultCallbacks: ((result: MergeQueueResult) => void)[];

  constructor(config: {
    mergeStrategy: MergeStrategy;
    mainBranch: string;
    repoPath: string;
    gitMutex?: GitMutex;
  }) {
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
  }

  enqueue(branch: string): void {
    if (this.merged.has(branch)) {
      logger.debug(`Branch ${branch} already merged, skipping`);
      return;
    }

    if (this.queue.includes(branch)) {
      logger.debug(`Branch ${branch} already in queue, skipping`);
      return;
    }

    this.queue.push(branch);
    logger.debug(`Enqueued branch ${branch}`);
  }

  dequeue(): string | undefined {
    return this.queue.shift();
  }

  getQueue(): string[] {
    return [...this.queue];
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  startBackground(intervalMs: number = 5_000): void {
    if (this.backgroundRunning) return;
    this.backgroundRunning = true;
    logger.info("Background merge queue started", { intervalMs });

    const tick = async (): Promise<void> => {
      if (!this.backgroundRunning) return;

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
        this.backgroundTimer = setTimeout(() => void tick(), intervalMs);
      }
    };

    this.backgroundTimer = setTimeout(() => void tick(), intervalMs);
  }

  stopBackground(): void {
    this.backgroundRunning = false;
    if (this.backgroundTimer) {
      clearTimeout(this.backgroundTimer);
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

    logger.info(`Attempting to merge branch ${branch} into ${this.mainBranch}`);

    if (this.gitMutex) {
      await this.gitMutex.acquire();
    }

    try {
      // Fetch the branch from origin (workers push branches to remote)
      try {
        await execFileAsync("git", ["fetch", "origin", branch], { cwd });
      } catch (fetchError) {
        const fetchMsg = fetchError instanceof Error ? fetchError.message : String(fetchError);
        logger.warn(`Failed to fetch branch ${branch} from origin, trying local`, { error: fetchMsg });
      }

      await checkoutBranch(this.mainBranch, cwd);

      const result = await coreMergeBranch(branch, this.mainBranch, this.mergeStrategy, cwd);

      if (result.success) {
        this.merged.add(branch);
        this.stats.totalMerged++;
        logger.info(`Successfully merged branch ${branch}: ${result.message}`);
        return { success: true, status: "merged", branch, message: result.message };
      }

      if (result.conflicted) {
        const conflicts = await getConflicts(cwd);
        await abortMerge(cwd);

        this.stats.totalConflicts++;
        logger.warn(`Merge conflict on branch ${branch}: ${conflicts.length} conflicting files`);
        return {
          success: false,
          status: "conflict",
          branch,
          message: `Merge conflict: ${conflicts.length} conflicting files`,
          conflicts,
        };
      }

      this.stats.totalFailed++;
      logger.error(`Failed to merge branch ${branch}: ${result.message}`);
      return { success: false, status: "failed", branch, message: result.message };
    } catch (error) {
      this.stats.totalFailed++;
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Error merging branch ${branch}: ${msg}`);

      try {
        await checkoutBranch(this.mainBranch, cwd);
      } catch {
        // Best effort
      }

      return { success: false, status: "failed", branch, message: msg };
    } finally {
      if (this.gitMutex) {
        this.gitMutex.release();
      }
    }
  }

  isBranchMerged(branch: string): boolean {
    return this.merged.has(branch);
  }

  getMergeStats(): MergeStats {
    return { ...this.stats };
  }
}
