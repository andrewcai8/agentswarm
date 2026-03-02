import { execSync } from "node:child_process";
import type { Handoff } from "@longshot/core";

export function buildHandoff(
  taskId: string,
  status: Handoff["status"],
  summary: string,
  metrics: Handoff["metrics"]
): Handoff {
  const diffStat = getGitDiffStat();
  
  return {
    taskId,
    status,
    summary,
    diff: "",
    filesChanged: diffStat.filesChanged,
    concerns: [],
    suggestions: [],
    metrics: {
      linesAdded: diffStat.linesAdded,
      linesRemoved: diffStat.linesRemoved,
      filesCreated: diffStat.filesCreated,
      filesModified: diffStat.filesModified,
      tokensUsed: metrics.tokensUsed,
      toolCallCount: metrics.toolCallCount,
      durationMs: metrics.durationMs,
    },
  };
}

interface DiffStatResult {
  filesChanged: string[];
  linesAdded: number;
  linesRemoved: number;
  filesCreated: number;
  filesModified: number;
}

function getGitDiffStat(): DiffStatResult {
  try {
    // Get files changed with line counts
    const numstatOutput = execSync("git diff --numstat", {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    }).trim();

    const filesChanged: string[] = [];
    let linesAdded = 0;
    let linesRemoved = 0;

    if (numstatOutput) {
      for (const line of numstatOutput.split("\n")) {
        const parts = line.split("\t");
        if (parts.length >= 3) {
          if (parts[0] !== "-") linesAdded += parseInt(parts[0], 10);
          if (parts[1] !== "-") linesRemoved += parseInt(parts[1], 10);
          filesChanged.push(parts[2]);
        }
      }
    }

    // Detect new files vs modified
    let filesCreated = 0;
    let filesModified = 0;
    try {
      const newFiles = execSync("git diff --diff-filter=A --name-only", {
        encoding: "utf-8",
      }).trim();
      filesCreated = newFiles ? newFiles.split("\n").length : 0;
      filesModified = Math.max(0, filesChanged.length - filesCreated);
    } catch {
      filesModified = filesChanged.length;
    }

    return { filesChanged, linesAdded, linesRemoved, filesCreated, filesModified };
  } catch {
    return { filesChanged: [], linesAdded: 0, linesRemoved: 0, filesCreated: 0, filesModified: 0 };
  }
}
