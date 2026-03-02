/** @module Async git utilities for branch management, merging, diffing, and repository inspection */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "./logger.js";

const execFileAsync = promisify(execFile);
const logger = createLogger("git", "root-planner");

function logBestEffortFailure(operation: string, error: unknown): void {
  const errorMessage = error instanceof Error ? error.message : String(error);
  logger.debug(operation, { error: errorMessage });
}

// Types

export interface MergeResult {
  success: boolean;
  conflicted?: boolean;
  message: string;
  /** Files involved in a conflict. Populated before merge/rebase is aborted. */
  conflictingFiles?: string[];
}

export interface RebaseResult {
  success: boolean;
  conflicted: boolean;
  message: string;
}

export interface DiffStat {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
}

export interface CommitInfo {
  hash: string;
  message: string;
  author: string;
  date: number; // Unix timestamp ms
}

// Helper to get working directory with default
function getCwd(cwd?: string): string {
  return cwd ?? process.cwd();
}

/**
 * Parse `git status --porcelain` to extract files with conflict markers.
 * Must be called WHILE a merge/rebase conflict is active (before abort).
 * Status codes indicating conflicts: UU, AA, DD, AU, UA, DU, UD.
 */
async function getConflictingFilesFromStatus(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd });
    const lines = stdout
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
    const conflicts: string[] = [];

    for (const line of lines) {
      const status = line.substring(0, 2);
      const filePath = line.substring(3).trim();

      if (
        status === "UU" ||
        status === "AA" ||
        status === "DD" ||
        status === "AU" ||
        status === "UA" ||
        status === "DU" ||
        status === "UD"
      ) {
        conflicts.push(filePath);
      }
    }

    return conflicts;
  } catch (error) {
    logBestEffortFailure("Failed to collect conflicting files from git status", error);
    return [];
  }
}

// 1. Create a new branch
export async function createBranch(branchName: string, cwd?: string): Promise<void> {
  const workDir = getCwd(cwd);
  try {
    await execFileAsync("git", ["checkout", "-b", branchName], { cwd: workDir });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create branch "${branchName}": ${message}`);
  }
}

// 2. Checkout an existing branch
export async function checkoutBranch(branchName: string, cwd?: string): Promise<void> {
  const workDir = getCwd(cwd);
  try {
    await execFileAsync("git", ["checkout", branchName], { cwd: workDir });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to checkout branch "${branchName}": ${message}`);
  }
}

// 3. Merge source into target (default: current branch)
export async function mergeBranch(
  source: string,
  target?: string,
  strategy?: "fast-forward" | "rebase" | "merge-commit",
  cwd?: string,
): Promise<MergeResult> {
  const workDir = getCwd(cwd);

  try {
    // Get current branch if target not specified
    let targetBranch = target;
    if (!targetBranch) {
      const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: workDir,
      });
      targetBranch = stdout.trim();
    }

    if (!targetBranch) {
      return {
        success: false,
        message: "Could not determine target branch",
      };
    }

    // Save current branch for later
    const currentBranch = targetBranch;

    switch (strategy) {
      case "fast-forward": {
        // Checkout target, then merge with --ff-only
        await execFileAsync("git", ["checkout", targetBranch], { cwd: workDir });
        try {
          await execFileAsync("git", ["merge", "--ff-only", source], { cwd: workDir });
          return {
            success: true,
            message: `Successfully fast-forward merged ${source} into ${targetBranch}`,
          };
        } catch (error) {
          // Check if it's a conflict situation
          const errMsg = error instanceof Error ? error.message : String(error);
          if (errMsg.includes("fatal: Not possible to fast-forward")) {
            return {
              success: false,
              conflicted: false,
              message: `Cannot fast-forward: ${errMsg}`,
            };
          }
          // Check for conflicts
          const conflictingFiles = await getConflictingFilesFromStatus(workDir);
          if (conflictingFiles.length > 0) {
            await execFileAsync("git", ["merge", "--abort"], { cwd: workDir });
            return {
              success: false,
              conflicted: true,
              conflictingFiles,
              message: `Merge conflict in ${conflictingFiles.length} file(s): ${conflictingFiles.join(", ")}`,
            };
          }
          throw error;
        }
      }

      case "rebase": {
        // Clean up stale rebase state from a previous interrupted operation
        try {
          await execFileAsync("git", ["rebase", "--abort"], { cwd: workDir });
        } catch (error) {
          logBestEffortFailure("Preflight rebase abort failed", error);
        }

        const tmpBranch = `tmp-rebase-${Date.now()}`;
        try {
          await execFileAsync("git", ["checkout", "-b", tmpBranch, source], { cwd: workDir });
        } catch (error) {
          // Source ref doesn't exist or checkout failed
          const errMsg = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            message: `Failed to checkout source for rebase: ${errMsg}`,
          };
        }
        try {
          await execFileAsync("git", ["rebase", targetBranch], { cwd: workDir });
          // Fast-forward merge the rebased temp branch into target
          await execFileAsync("git", ["checkout", targetBranch], { cwd: workDir });
          await execFileAsync("git", ["merge", "--ff-only", tmpBranch], { cwd: workDir });
          // Clean up temp branch
          try {
            await execFileAsync("git", ["branch", "-D", tmpBranch], { cwd: workDir });
          } catch (error) {
            logBestEffortFailure(`Failed to delete temp rebase branch ${tmpBranch}`, error);
          }
          return {
            success: true,
            message: `Successfully rebased ${source} onto ${targetBranch}`,
          };
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          if (errMsg.includes("could not apply") || errMsg.includes("CONFLICT")) {
            const conflictingFiles = await getConflictingFilesFromStatus(workDir);
            try {
              await execFileAsync("git", ["rebase", "--abort"], { cwd: workDir });
            } catch (error) {
              logBestEffortFailure("Failed to abort rebase after conflict", error);
            }
            try {
              await execFileAsync("git", ["checkout", currentBranch], { cwd: workDir });
            } catch (error) {
              logBestEffortFailure(`Failed to checkout original branch ${currentBranch}`, error);
            }
            try {
              await execFileAsync("git", ["branch", "-D", tmpBranch], { cwd: workDir });
            } catch (error) {
              logBestEffortFailure(`Failed to delete temp rebase branch ${tmpBranch}`, error);
            }
            return {
              success: false,
              conflicted: true,
              conflictingFiles,
              message: `Rebase conflict in ${conflictingFiles.length} file(s): ${conflictingFiles.join(", ")}`,
            };
          }
          // Non-conflict failure — abort any in-progress rebase before cleanup
          try {
            await execFileAsync("git", ["rebase", "--abort"], { cwd: workDir });
          } catch (error) {
            logBestEffortFailure("Failed to abort rebase after non-conflict failure", error);
          }
          try {
            await execFileAsync("git", ["checkout", currentBranch], { cwd: workDir });
          } catch (error) {
            logBestEffortFailure(`Failed to checkout original branch ${currentBranch}`, error);
          }
          try {
            await execFileAsync("git", ["branch", "-D", tmpBranch], { cwd: workDir });
          } catch (error) {
            logBestEffortFailure(`Failed to delete temp rebase branch ${tmpBranch}`, error);
          }
          throw error;
        }
      }
      default: {
        // Checkout target, then merge with --no-ff
        await execFileAsync("git", ["checkout", targetBranch], { cwd: workDir });
        try {
          await execFileAsync("git", ["merge", "--no-ff", source], { cwd: workDir });
          return {
            success: true,
            message: `Successfully merged ${source} into ${targetBranch}`,
          };
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          // Check for merge conflicts
          const conflictingFiles = await getConflictingFilesFromStatus(workDir);
          if (conflictingFiles.length > 0) {
            await execFileAsync("git", ["merge", "--abort"], { cwd: workDir });
            return {
              success: false,
              conflicted: true,
              conflictingFiles,
              message: `Merge conflict in ${conflictingFiles.length} file(s): ${conflictingFiles.join(", ")}`,
            };
          }
          return {
            success: false,
            message: `Merge failed: ${errMsg}`,
          };
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Merge operation failed: ${message}`,
    };
  }
}

// 4. Rebase branch onto another
export async function rebaseBranch(
  branchName: string,
  onto: string,
  cwd?: string,
): Promise<RebaseResult> {
  const workDir = getCwd(cwd);
  try {
    // First checkout the branch we want to rebase
    await execFileAsync("git", ["checkout", branchName], { cwd: workDir });
    // Perform the rebase
    await execFileAsync("git", ["rebase", onto], { cwd: workDir });
    return {
      success: true,
      conflicted: false,
      message: `Successfully rebased ${branchName} onto ${onto}`,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    // Check for conflict markers in output
    const conflicted = errMsg.includes("fatal: could not apply") || errMsg.includes("CONFLICT");
    // Always abort any in-progress rebase to leave the repo in a clean state,
    // regardless of whether the failure was a conflict or something else.
    try {
      await execFileAsync("git", ["rebase", "--abort"], { cwd: workDir });
    } catch (error) {
      logBestEffortFailure("Failed to abort rebase while cleaning repository state", error);
    }

    return {
      success: false,
      conflicted,
      message: conflicted ? "Rebase conflict occurred" : `Rebase failed: ${errMsg}`,
    };
  }
}

// 5. Get current branch name
export async function getCurrentBranch(cwd?: string): Promise<string> {
  const workDir = getCwd(cwd);
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: workDir,
    });
    return stdout.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to get current branch: ${message}`);
  }
}

// 6. Get diff statistics (uncommitted changes)
export async function getDiffStat(cwd?: string): Promise<DiffStat> {
  const workDir = getCwd(cwd);
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--shortstat"], { cwd: workDir });
    const trimmed = stdout.trim();

    if (!trimmed) {
      return {
        filesChanged: 0,
        linesAdded: 0,
        linesRemoved: 0,
      };
    }

    // Parse format: "X files changed, Y insertions(+), Z deletions(-)"
    const filesMatch = trimmed.match(/(\d+) files? changed/);
    const insertionsMatch = trimmed.match(/(\d+) insertions?\(\+\)/);
    const deletionsMatch = trimmed.match(/(\d+) deletions?\(-\)/);

    return {
      filesChanged: parseInt(filesMatch?.[1] ?? "0", 10),
      linesAdded: parseInt(insertionsMatch?.[1] ?? "0", 10),
      linesRemoved: parseInt(deletionsMatch?.[1] ?? "0", 10),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to get diff stat: ${message}`);
  }
}

// 7. Get recent commits
export async function getRecentCommits(count: number, cwd?: string): Promise<CommitInfo[]> {
  const workDir = getCwd(cwd);
  try {
    // Use ASCII record separator (0x1e) to delimit commits, avoiding issues with
    // commit messages that contain blank lines
    const SEP = "\x1e";
    const { stdout } = await execFileAsync(
      "git",
      ["log", `-${count}`, `--format=${SEP}%H%n%s%n%an%n%at`],
      { cwd: workDir },
    );

    const trimmed = stdout.trim();
    if (!trimmed) {
      return [];
    }

    const commits: CommitInfo[] = [];
    const blocks = trimmed.split(SEP).filter((b) => b.length > 0);

    for (const block of blocks) {
      const lines = block.trim().split("\n");
      const [hash, message, author, timestamp] = lines;
      if (hash && message && author && timestamp) {
        commits.push({
          hash: hash.trim(),
          message: message.trim(),
          author: author.trim(),
          date: parseInt(timestamp.trim(), 10) * 1000, // Convert seconds to ms
        });
      }
    }

    return commits;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to get recent commits: ${message}`);
  }
}

// 8. Get file tree (list of tracked files)
export async function getFileTree(cwd?: string, maxDepth?: number): Promise<string[]> {
  const workDir = getCwd(cwd);
  try {
    const { stdout } = await execFileAsync("git", ["ls-files"], { cwd: workDir });
    const files = stdout
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);

    if (maxDepth !== undefined && maxDepth > 0) {
      return files.filter((file) => {
        const depth = file.split("/").length;
        return depth <= maxDepth;
      });
    }

    return files;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to get file tree: ${message}`);
  }
}

// 9. Check for uncommitted changes
export async function hasUncommittedChanges(cwd?: string): Promise<boolean> {
  const workDir = getCwd(cwd);
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: workDir });
    return stdout.trim().length > 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to check for uncommitted changes: ${message}`);
  }
}
