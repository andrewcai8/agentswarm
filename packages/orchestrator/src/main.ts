import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { createLogger, enableFileLogging, closeFileLogging, enableTracing, closeTracing, setLogLevel, getLogLevel } from "@agentswarm/core";
import { createOrchestrator } from "./orchestrator.js";

loadDotenv({ path: resolve(process.cwd(), ".env") });

// Re-resolve log level after dotenv loads (env var may come from .env file)
if (process.env.LOG_LEVEL) {
  const level = process.env.LOG_LEVEL.toLowerCase().trim();
  if (level === "debug" || level === "info" || level === "warn" || level === "error") {
    setLogLevel(level);
  }
}

const logger = createLogger("main", "root-planner");

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

async function main(): Promise<void> {
  const logFile = enableFileLogging(process.cwd());
  const { traceFile, llmDetailFile } = enableTracing(process.cwd());

  logger.info("Run files", { logFile, traceFile, llmDetailFile });
  logger.info("Log level", { stdout: getLogLevel(), file: "debug" });

  const orchestrator = await createOrchestrator({
    callbacks: {
      onTaskCreated(task) {
        logger.info("Task created", {
          taskId: task.id,
          parentId: task.parentId,
          desc: task.description.slice(0, 200),
        });
      },
      onTaskCompleted(task, handoff) {
        const duration = formatDuration(handoff.metrics.durationMs);
        const filesChanged = handoff.filesChanged.length;

        logger.info("Task completed", {
          taskId: task.id,
          parentId: task.parentId,
          status: handoff.status,
          duration,
          summary: handoff.summary.slice(0, 250),
          filesChanged,
          linesAdded: handoff.metrics.linesAdded,
          linesRemoved: handoff.metrics.linesRemoved,
          filesCreated: handoff.metrics.filesCreated,
          filesModified: handoff.metrics.filesModified,
          tokensUsed: handoff.metrics.tokensUsed,
          toolCallCount: handoff.metrics.toolCallCount,
          durationMs: handoff.metrics.durationMs,
        });

        // Anomaly warnings for suspiciously large outputs
        if (filesChanged > 100) {
          logger.warn("Anomaly: task changed unusually many files", {
            taskId: task.id,
            filesChanged,
            hint: "Worker may have committed node_modules or generated files",
          });
        }
        if (handoff.metrics.linesAdded > 50_000) {
          logger.warn("Anomaly: task added unusually many lines", {
            taskId: task.id,
            linesAdded: handoff.metrics.linesAdded,
            hint: "Worker may have committed vendored/generated content",
          });
        }
      },
      onIterationComplete(iteration, tasks, handoffs) {
        const snapshot = orchestrator.getSnapshot();
        logger.info("Iteration complete", {
          iteration,
          tasks: tasks.length,
          handoffs: handoffs.length,
          ...snapshot,
        });
      },
      onError(error) {
        // Enrich planner errors with orchestrator context
        const snapshot = orchestrator.getSnapshot();
        logger.error("Planner error", {
          error: error.message,
          activeWorkers: snapshot.activeWorkers,
          pendingTasks: snapshot.pendingTasks,
          completedTasks: snapshot.completedTasks,
          failedTasks: snapshot.failedTasks,
        });
      },
      onSweepComplete(result) {
        if (result.fixTasks.length > 0) {
          logger.info("Reconciler created fix tasks", {
            count: result.fixTasks.length,
            taskIds: result.fixTasks.map((t) => t.id),
          });
        }
        if (!result.buildOk || !result.testsOk || result.hasConflictMarkers) {
          logger.info("Reconciler sweep health", {
            buildOk: result.buildOk,
            testsOk: result.testsOk,
            hasConflictMarkers: result.hasConflictMarkers,
            conflictFiles: result.conflictFiles.length,
          });
        }
      },
      onReconcilerError(error) {
        logger.error("Reconciler error", { error: error.message });
      },
      onWorkerTimeout(workerId, taskId) {
        logger.error("Worker timed out", { workerId, taskId });
      },
      onEmptyDiff(workerId, taskId) {
        logger.warn("Empty diff from worker", { workerId, taskId });
      },
      onMetricsUpdate(snapshot) {
        // Include merge stats from the merge queue
        const mergeStats = orchestrator.mergeQueue.getMergeStats();
        logger.info("Metrics", {
          ...snapshot,
          mergeQueueDepth: orchestrator.mergeQueue.getQueueLength(),
          totalMerged: mergeStats.totalMerged,
          totalMergeFailed: mergeStats.totalFailed,
          totalConflicts: mergeStats.totalConflicts,
        });
      },
      onTaskStatusChange(task, oldStatus, newStatus) {
        // Skip pending→assigned — redundant with "Dispatching task to ephemeral sandbox"
        // event which carries richer context.  All other transitions are forwarded so the
        // dashboard can track the full task lifecycle (notably assigned→running for live
        // execution progress, timers, and active-worker counts).
        if (oldStatus === "pending" && newStatus === "assigned") return;

        logger.info("Task status", {
          taskId: task.id,
          parentId: task.parentId,
          from: oldStatus,
          to: newStatus,
          desc: task.description.slice(0, 200),
        });
      },
      onFinalizationStart() {
        logger.info("Finalization phase started");
      },
      onFinalizationAttempt(attempt, sweepResult) {
        logger.info("Finalization attempt", {
          attempt,
          buildOk: sweepResult.buildOk,
          testsOk: sweepResult.testsOk,
          hasConflictMarkers: sweepResult.hasConflictMarkers,
          conflictFiles: sweepResult.conflictFiles.length,
          fixTasks: sweepResult.fixTasks.length,
        });
      },
      onFinalizationComplete(attempts, passed) {
        logger.info("Finalization phase complete", {
          attempts,
          passed,
        });
      },
    },
  });

  /** Log the final run summary and close file handles. */
  function finalize(snapshot: ReturnType<typeof orchestrator.getSnapshot>): void {
    const mergeStats = orchestrator.mergeQueue.getMergeStats();
    logger.info("Final summary", {
      ...snapshot,
      totalMerged: mergeStats.totalMerged,
      totalMergeFailed: mergeStats.totalFailed,
      totalConflicts: mergeStats.totalConflicts,
      logFile,
      traceFile,
      llmDetailFile,
    });
    closeTracing();
    closeFileLogging();
  }

  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down...");
    await orchestrator.stop();
    finalize(orchestrator.getSnapshot());
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  logger.info("Orchestrator started — beginning planner loop");

  const request =
    process.argv[2] || "Build Minecraft according to SPEC.md and FEATURES.json in the target repository.";
  const finalSnapshot = await orchestrator.run(request);

  finalize(finalSnapshot);

  const buildOk = finalSnapshot.finalizationBuildPassed !== false;
  const testsOk = finalSnapshot.finalizationTestsPassed !== false;
  const allMerged = finalSnapshot.finalizationAllMerged !== false;
  if (!buildOk || !testsOk || !allMerged) {
    logger.error("Run did not pass finalization", {
      buildOk,
      testsOk,
      allMerged,
      unmergedCount: finalSnapshot.finalizationUnmergedCount ?? 0,
    });
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error("Fatal error", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
