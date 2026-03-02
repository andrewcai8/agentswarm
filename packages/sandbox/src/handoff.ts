/** @module Handoff construction utilities for packaging worker results with git diff statistics */

import { execSync } from "node:child_process";
import { createLogger, type Handoff } from "@longshot/core";

const logger = createLogger("sandbox-handoff", "worker");

export function buildHandoff(
  taskId: string,
  status: Handoff["status"],
  summary: string,
  metrics: Handoff["metrics"],
): Handoff {
  const diffStat = getGitDiffStat();
  const normalizedDiffStat = diffStat ?? {
    filesChanged: [],
    linesAdded: 0,
    linesRemoved: 0,
    filesCreated: 0,
    filesModified: 0,
  };

  return {
    taskId,
    status,
    summary,
    diff: "",
    filesChanged: normalizedDiffStat.filesChanged,
    concerns: diffStat ? [] : ["Unable to compute git diff statistics"],
    suggestions: diffStat ? [] : ["Check git availability and repository state"],
    metrics: {
      linesAdded: normalizedDiffStat.linesAdded,
      linesRemoved: normalizedDiffStat.linesRemoved,
      filesCreated: normalizedDiffStat.filesCreated,
      filesModified: normalizedDiffStat.filesModified,
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

function getGitDiffStat(): DiffStatResult | undefined {
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
        const [addedRaw, removedRaw, filePath] = parts;
        if (addedRaw && removedRaw && filePath) {
          if (addedRaw !== "-") linesAdded += parseInt(addedRaw, 10);
          if (removedRaw !== "-") linesRemoved += parseInt(removedRaw, 10);
          filesChanged.push(filePath);
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
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.debug("Failed to classify created files from git diff-filter=A", {
        error: errorMessage,
      });
      filesModified = filesChanged.length;
    }

    return { filesChanged, linesAdded, linesRemoved, filesCreated, filesModified };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.warn("Failed to compute git diff statistics", { error: errorMessage });
    return undefined;
  }
}
