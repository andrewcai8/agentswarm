import { createLogger } from "@agentswarm/core";
import { createOrchestrator } from "./orchestrator.js";

const logger = createLogger("main", "root-planner");

async function main(): Promise<void> {
  const orchestrator = await createOrchestrator({
    callbacks: {
      onTaskCreated(task) {
        logger.info("Task created", {
          taskId: task.id,
          desc: task.description.slice(0, 80),
        });
      },
      onTaskCompleted(task, handoff) {
        logger.info("Task completed", { taskId: task.id, status: handoff.status });
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
        logger.error("Planner error", { error: error.message });
      },
      onSweepComplete(tasks) {
        if (tasks.length > 0) {
          logger.info("Reconciler created fix tasks", { count: tasks.length });
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
        logger.info("Metrics", { ...snapshot });
      },
      onTaskStatusChange(task, oldStatus, newStatus) {
        logger.info("Task status", {
          taskId: task.id,
          from: oldStatus,
          to: newStatus,
          desc: task.description.slice(0, 80),
        });
      },
    },
  });

  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down...");
    await orchestrator.stop();
    const snapshot = orchestrator.getSnapshot();
    logger.info("Final metrics", { ...snapshot });
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
    "Build VoxelCraft according to SPEC.md and FEATURES.json in the target repository.";
  const finalSnapshot = await orchestrator.run(request);

  logger.info("Planner loop complete", { ...finalSnapshot });
}

main().catch((error) => {
  logger.error("Fatal error", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
