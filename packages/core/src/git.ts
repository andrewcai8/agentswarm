import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Types

export interface MergeResult {
  success: boolean;
  conflicted?: boolean;
  message: string;
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
  cwd?: string
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
          const statusResult = await execFileAsync("git", ["status", "--porcelain"], {
            cwd: workDir,
          });
          if (statusResult.stdout.includes("UU") || statusResult.stdout.includes("AA")) {
            await execFileAsync("git", ["merge", "--abort"], { cwd: workDir });
            return {
              success: false,
              conflicted: true,
              message: "Merge conflict occurred",
            };
          }
          throw error;
        }
      }

      case "rebase": {
        // Checkout source, rebase onto target, then checkout target and merge --ff-only
        await execFileAsync("git", ["checkout", source], { cwd: workDir });
        try {
          await execFileAsync("git", ["rebase", targetBranch], { cwd: workDir });
          // Now fast-forward merge the rebased source into target
          await execFileAsync("git", ["checkout", targetBranch], { cwd: workDir });
          await execFileAsync("git", ["merge", "--ff-only", source], { cwd: workDir });
          return {
            success: true,
            message: `Successfully rebased ${source} onto ${targetBranch}`,
          };
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          // Check for rebase conflicts
          if (errMsg.includes("fatal: could not apply") || errMsg.includes("CONFLICT")) {
            await execFileAsync("git", ["rebase", "--abort"], { cwd: workDir });
            await execFileAsync("git", ["checkout", currentBranch], { cwd: workDir });
            return {
              success: false,
              conflicted: true,
              message: "Rebase conflict occurred",
            };
          }
          throw error;
        }
      }

      case "merge-commit":
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
          const statusResult = await execFileAsync("git", ["status", "--porcelain"], {
            cwd: workDir,
          });
          if (statusResult.stdout.includes("UU") || statusResult.stdout.includes("AA")) {
            await execFileAsync("git", ["merge", "--abort"], { cwd: workDir });
            return {
              success: false,
              conflicted: true,
              message: "Merge conflict occurred",
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
export async function rebaseBranch(branchName: string, onto: string, cwd?: string): Promise<RebaseResult> {
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
    if (conflicted) {
      // Abort the rebase to leave repo in clean state
      try {
        await execFileAsync("git", ["rebase", "--abort"], { cwd: workDir });
      } catch {
        // Ignore abort errors
      }
      return {
        success: false,
        conflicted: true,
        message: "Rebase conflict occurred",
      };
    }
    return {
      success: false,
      conflicted: false,
      message: `Rebase failed: ${errMsg}`,
    };
  }
}

// 5. Get list of conflicted files
export async function getConflicts(cwd?: string): Promise<string[]> {
  const workDir = getCwd(cwd);
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: workDir });
    const lines = stdout.trim().split("\n").filter((line) => line.length > 0);
    const conflicts: string[] = [];

    for (const line of lines) {
      // Conflict markers: UU (both modified), AA (both added), DD (both deleted), AU, UA, DU, UD
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
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to get conflicts: ${message}`);
  }
}

// 6. Get current branch name
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

// 7. Get diff statistics (uncommitted changes)
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
      filesChanged: filesMatch ? parseInt(filesMatch[1], 10) : 0,
      linesAdded: insertionsMatch ? parseInt(insertionsMatch[1], 10) : 0,
      linesRemoved: deletionsMatch ? parseInt(deletionsMatch[1], 10) : 0,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to get diff stat: ${message}`);
  }
}

// 8. Get recent commits
export async function getRecentCommits(count: number, cwd?: string): Promise<CommitInfo[]> {
  const workDir = getCwd(cwd);
  try {
    // Use ASCII record separator (0x1e) to delimit commits, avoiding issues with
    // commit messages that contain blank lines
    const SEP = "\x1e";
    const { stdout } = await execFileAsync(
      "git",
      ["log", `-${count}`, `--format=${SEP}%H%n%s%n%an%n%at`],
      { cwd: workDir }
    );

    const trimmed = stdout.trim();
    if (!trimmed) {
      return [];
    }

    const commits: CommitInfo[] = [];
    const blocks = trimmed.split(SEP).filter((b) => b.length > 0);

    for (const block of blocks) {
      const lines = block.trim().split("\n");
      if (lines.length >= 4) {
        commits.push({
          hash: lines[0].trim(),
          message: lines[1].trim(),
          author: lines[2].trim(),
          date: parseInt(lines[3].trim(), 10) * 1000, // Convert seconds to ms
        });
      }
    }

    return commits;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to get recent commits: ${message}`);
  }
}

// 9. Get file tree (list of tracked files)
export async function getFileTree(cwd?: string, maxDepth?: number): Promise<string[]> {
  const workDir = getCwd(cwd);
  try {
    const { stdout } = await execFileAsync("git", ["ls-files"], { cwd: workDir });
    const files = stdout.trim().split("\n").filter((line) => line.length > 0);

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

// 10. Check for uncommitted changes
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
