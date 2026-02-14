import { readFile } from "node:fs/promises";
import { createLogger, getRecentCommits, getFileTree } from "@agentswarm/core";

const logger = createLogger("shared", "root-planner");

export interface RepoState {
  fileTree: string[];
  recentCommits: string[];
  featuresJson: string | null;
}

export interface RawTaskInput {
  id?: string;
  description: string;
  scope?: string[];
  acceptance?: string;
  branch?: string;
  priority?: number;
}

export async function readRepoState(targetRepoPath: string): Promise<RepoState> {
  const cwd = targetRepoPath;

  const fileTree = await getFileTree(cwd);

  const commits = await getRecentCommits(15, cwd);
  const recentCommits = commits.map((c) => `${c.hash.slice(0, 8)} ${c.message} (${c.author})`);

  let featuresJson: string | null = null;
  try {
    featuresJson = await readFile(`${cwd}/FEATURES.json`, "utf-8");
  } catch {
    // FEATURES.json may not exist yet
  }

  return { fileTree, recentCommits, featuresJson };
}

/**
 * Counting semaphore for bounding concurrent async operations.
 * Replaces the old serial dispatchLock mutex.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private waitQueue: (() => void)[] = [];

  constructor(private readonly maxConcurrent: number) {
    if (maxConcurrent < 1) throw new Error("maxConcurrent must be >= 1");
  }

  async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waitQueue.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  release(): void {
    this.active--;
    const next = this.waitQueue.shift();
    if (next) next();
  }

  getActive(): number {
    return this.active;
  }

  getQueueLength(): number {
    return this.waitQueue.length;
  }
}

/**
 * Serializes local git operations to prevent index.lock contention
 * when multiple concurrent tasks touch the same repository.
 */
export class GitMutex extends ConcurrencyLimiter {
  constructor() {
    super(1);
  }

  isLocked(): boolean {
    return this.getActive() > 0;
  }
}

export function parseLLMTaskArray(content: string): RawTaskInput[] {
  let cleaned = content.trim();

  if (cleaned.startsWith("```")) {
    const firstNewline = cleaned.indexOf("\n");
    const lastBackticks = cleaned.lastIndexOf("```");
    if (firstNewline !== -1 && lastBackticks > firstNewline) {
      cleaned = cleaned.slice(firstNewline + 1, lastBackticks).trim();
    }
  }

  const arrayStart = cleaned.indexOf("[");
  const arrayEnd = cleaned.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    cleaned = cleaned.slice(arrayStart, arrayEnd + 1);
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) {
      throw new Error("LLM response is not an array");
    }
    return parsed;
  } catch (error) {
    logger.error("Failed to parse LLM response as tasks", {
      content: content.slice(0, 500),
    });
    throw new Error(
      `Failed to parse LLM task decomposition: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
