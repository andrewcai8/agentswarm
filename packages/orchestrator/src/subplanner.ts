import type { Task, Handoff, Tracer, Span } from "@agentswarm/core";
import { createLogger } from "@agentswarm/core";
import type { OrchestratorConfig } from "./config.js";
import type { TaskQueue } from "./task-queue.js";
import type { WorkerPool } from "./worker-pool.js";
import type { MergeQueue } from "./merge-queue.js";
import type { Monitor } from "./monitor.js";
import { createPlannerPiSession, cleanupPiSession } from "./shared.js";
import { type RepoState, type RawTaskInput, readRepoState, parseLLMTaskArray, ConcurrencyLimiter, slugifyForBranch } from "./shared.js";

const logger = createLogger("subplanner", "subplanner");

export interface SubplannerConfig {
  maxDepth: number;
  scopeThreshold: number;
  maxSubtasks: number;
}

export const DEFAULT_SUBPLANNER_CONFIG: SubplannerConfig = {
  maxDepth: 3,
  scopeThreshold: 4,
  maxSubtasks: 10,
};

export function aggregateHandoffs(parentTask: Task, subtasks: Task[], handoffs: Handoff[]): Handoff {
  const completedCount = handoffs.filter((h) => h.status === "complete").length;
  const failedCount = handoffs.filter((h) => h.status === "failed").length;
  const totalSubtasks = subtasks.length;

  let status: Handoff["status"];
  if (completedCount === totalSubtasks) {
    status = "complete";
  } else if (failedCount === totalSubtasks) {
    status = "failed";
  } else if (completedCount > 0) {
    status = "partial";
  } else {
    status = "blocked";
  }

  const summaryParts = handoffs.map(
    (h) => `[${h.taskId}] (${h.status}): ${h.summary}`
  );
  const summary = `Decomposed "${parentTask.description}" into ${totalSubtasks} subtasks. ` +
    `${completedCount} complete, ${failedCount} failed, ` +
    `${totalSubtasks - completedCount - failedCount} other.\n\n` +
    summaryParts.join("\n");

  const filesChangedSet = new Set<string>();
  for (const h of handoffs) {
    for (const f of h.filesChanged) {
      filesChangedSet.add(f);
    }
  }

  const allConcerns: string[] = [];
  const allSuggestions: string[] = [];
  for (const h of handoffs) {
    for (const c of h.concerns) {
      allConcerns.push(`[${h.taskId}] ${c}`);
    }
    for (const s of h.suggestions) {
      allSuggestions.push(`[${h.taskId}] ${s}`);
    }
  }

  const metrics = {
    linesAdded: 0,
    linesRemoved: 0,
    filesCreated: 0,
    filesModified: 0,
    tokensUsed: 0,
    toolCallCount: 0,
    durationMs: 0,
  };
  for (const h of handoffs) {
    metrics.linesAdded += h.metrics.linesAdded;
    metrics.linesRemoved += h.metrics.linesRemoved;
    metrics.filesCreated += h.metrics.filesCreated;
    metrics.filesModified += h.metrics.filesModified;
    metrics.tokensUsed += h.metrics.tokensUsed;
    metrics.toolCallCount += h.metrics.toolCallCount;
    metrics.durationMs = Math.max(metrics.durationMs, h.metrics.durationMs);
  }

  return {
    taskId: parentTask.id,
    status,
    summary,
    diff: handoffs.map((h) => h.diff).filter(Boolean).join("\n"),
    filesChanged: Array.from(filesChangedSet),
    concerns: allConcerns,
    suggestions: allSuggestions,
    metrics,
  };
}

export function createFailureHandoff(task: Task, error: Error): Handoff {
  return {
    taskId: task.id,
    status: "failed",
    summary: `Subplanner decomposition failed: ${error.message}`,
    diff: "",
    filesChanged: [],
    concerns: [error.message],
    suggestions: ["Consider sending this task directly to a worker without decomposition"],
    metrics: {
      linesAdded: 0,
      linesRemoved: 0,
      filesCreated: 0,
      filesModified: 0,
      tokensUsed: 0,
      toolCallCount: 0,
      durationMs: 0,
    },
  };
}

export function shouldDecompose(task: Task, config: SubplannerConfig, currentDepth: number): boolean {
  if (currentDepth >= config.maxDepth) {
    return false;
  }

  if (task.scope.length < config.scopeThreshold) {
    return false;
  }

  return true;
}

export class Subplanner {
  private config: OrchestratorConfig;
  private subplannerConfig: SubplannerConfig;
  private taskQueue: TaskQueue;
  private workerPool: WorkerPool;
  private mergeQueue: MergeQueue;
  private monitor: Monitor;
  private systemPrompt: string;
  private targetRepoPath: string;
  private tracer: Tracer | null = null;

  private dispatchLimiter: ConcurrencyLimiter;

  private subtaskCreatedCallbacks: ((subtask: Task, parentId: string) => void)[];
  private subtaskCompletedCallbacks: ((subtask: Task, handoff: Handoff, parentId: string) => void)[];
  private decompositionCallbacks: ((parentTask: Task, subtasks: Task[], depth: number) => void)[];
  private errorCallbacks: ((error: Error, parentTaskId: string) => void)[];

  constructor(
    config: OrchestratorConfig,
    subplannerConfig: SubplannerConfig,
    taskQueue: TaskQueue,
    workerPool: WorkerPool,
    mergeQueue: MergeQueue,
    monitor: Monitor,
    systemPrompt: string,
  ) {
    this.config = config;
    this.subplannerConfig = subplannerConfig;
    this.taskQueue = taskQueue;
    this.workerPool = workerPool;
    this.mergeQueue = mergeQueue;
    this.monitor = monitor;
    this.systemPrompt = systemPrompt;
    this.targetRepoPath = config.targetRepoPath;

    this.dispatchLimiter = new ConcurrencyLimiter(config.maxWorkers);

    this.subtaskCreatedCallbacks = [];
    this.subtaskCompletedCallbacks = [];
    this.decompositionCallbacks = [];
    this.errorCallbacks = [];
  }

  setTracer(tracer: Tracer): void {
    this.tracer = tracer;
  }

  async decomposeAndExecute(parentTask: Task, depth: number = 0, parentSpan?: Span): Promise<Handoff> {
    const taskLogger = logger.withTask(parentTask.id);
    taskLogger.info("Starting subplanner decomposition", {
      parentTaskId: parentTask.id,
      depth,
      scopeSize: parentTask.scope.length,
    });

    const span = parentSpan
      ? parentSpan.child("subplanner.decomposeAndExecute", { agentId: "subplanner" })
      : this.tracer?.startSpan("subplanner.decomposeAndExecute", { agentId: "subplanner" });
    span?.setAttributes({ parentTaskId: parentTask.id, depth, scopeSize: parentTask.scope.length });

    try {
      logger.debug("Subplanner decompose starting", { parentTaskId: parentTask.id, depth, description: parentTask.description.slice(0, 200), scope: parentTask.scope, acceptance: parentTask.acceptance.slice(0, 200) });
      const repoState = await readRepoState(this.targetRepoPath);
      const subtasks = await this.decompose(parentTask, repoState, depth, span);

      if (subtasks.length === 0) {
        taskLogger.info("LLM returned no subtasks — task is atomic, dispatching to worker directly");
        const handoff = await this.executeAsWorkerTask(parentTask, span);
        span?.setAttributes({ atomic: true });
        span?.setStatus("ok");
        span?.end();
        return handoff;
      }

      for (const cb of this.decompositionCallbacks) {
        cb(parentTask, subtasks, depth);
      }

      taskLogger.info(`Decomposed into ${subtasks.length} subtasks`, {
        subtaskIds: subtasks.map((s) => s.id),
        depth,
      });

      const handoffs = await this.executeSubtasks(subtasks, depth, span);

      for (const subtask of subtasks) {
        const taskObj = this.taskQueue.getById(subtask.id);
        if (taskObj?.status === "complete") {
          this.mergeQueue.enqueue(subtask.branch);
        }
      }

      const aggregated = aggregateHandoffs(parentTask, subtasks, handoffs);
      span?.setAttributes({ subtaskCount: subtasks.length, status: aggregated.status });
      span?.setStatus(aggregated.status === "complete" ? "ok" : "error");
      span?.end();
      return aggregated;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      taskLogger.error("Subplanner decomposition failed", { error: err.message, depth });

      for (const cb of this.errorCallbacks) {
        cb(err, parentTask.id);
      }

      span?.setStatus("error", err.message);
      span?.end();
      return createFailureHandoff(parentTask, err);
    }
  }

  private async decompose(
    parentTask: Task,
    repoState: RepoState,
    depth: number,
    parentSpan?: Span,
  ): Promise<Task[]> {
    let userMessage = `## Parent Task\n`;
    userMessage += `- **ID**: ${parentTask.id}\n`;
    userMessage += `- **Description**: ${parentTask.description}\n`;
    userMessage += `- **Scope**: ${parentTask.scope.join(", ")}\n`;
    userMessage += `- **Acceptance**: ${parentTask.acceptance}\n`;
    userMessage += `- **Priority**: ${parentTask.priority}\n`;
    userMessage += `- **Decomposition Depth**: ${depth}\n\n`;

    userMessage += `## Repository File Tree\n${repoState.fileTree.join("\n")}\n\n`;
    userMessage += `## Recent Commits\n${repoState.recentCommits.join("\n")}\n\n`;

    if (repoState.featuresJson) {
      userMessage += `## FEATURES.json\n${repoState.featuresJson}\n\n`;
    }

    logger.info("Creating ephemeral Pi session for task decomposition", {
      parentTaskId: parentTask.id,
      messageLength: userMessage.length,
      depth,
    });

    const piResult = await createPlannerPiSession({
      systemPrompt: this.systemPrompt,
      targetRepoPath: this.targetRepoPath,
      llmConfig: this.config.llm,
    });

    try {
      await piResult.session.prompt(userMessage);

      const stats = piResult.session.getSessionStats();
      this.monitor.recordTokenUsage(stats.tokens.total);

      const responseText = piResult.session.getLastAssistantText();
      logger.debug("Subplanner LLM response", { parentTaskId: parentTask.id, responseLength: responseText?.length ?? 0, preview: responseText?.slice(0, 500) ?? "" });
      if (!responseText) {
        logger.warn("Pi session returned no text for decomposition", {
          parentTaskId: parentTask.id,
        });
        return [];
      }

      const rawSubtasks = parseLLMTaskArray(responseText).filter((r) => r.description?.trim());

      const subtasks: Task[] = [];
      let subCounter = 0;

      for (const raw of rawSubtasks) {
        subCounter++;
        const id = raw.id || `${parentTask.id}-sub-${subCounter}`;
        let validScope = raw.scope || [];

        const invalidFiles = validScope.filter((f) => !parentTask.scope.includes(f));
        if (invalidFiles.length > 0) {
          logger.warn("Subtask scope contains files outside parent scope — removing them", {
            parentTaskId: parentTask.id,
            subtaskId: id,
            invalidFiles,
          });
          validScope = validScope.filter((f) => parentTask.scope.includes(f));
          if (validScope.length === 0) {
            logger.warn("Subtask has no valid scope files after filtering — skipping", { subtaskId: id });
            continue;
          }
        }

        const subtask: Task = {
          id,
          parentId: parentTask.id,
          description: raw.description,
          scope: validScope,
          acceptance: raw.acceptance || "",
          branch: raw.branch || `${this.config.git.branchPrefix}${id}-${slugifyForBranch(raw.description)}`,
          status: "pending" as const,
          createdAt: Date.now(),
          priority: raw.priority || parentTask.priority,
        };

        subtasks.push(subtask);
      }

      for (const st of subtasks) {
        logger.debug("Subtask created", { id: st.id, parentId: parentTask.id, description: st.description.slice(0, 200), scope: st.scope, priority: st.priority });
      }

      if (subtasks.length > this.subplannerConfig.maxSubtasks) {
        logger.warn("Too many subtasks — truncating", {
          parentTaskId: parentTask.id,
          count: subtasks.length,
          max: this.subplannerConfig.maxSubtasks,
        });
        return subtasks.slice(0, this.subplannerConfig.maxSubtasks);
      }

      return subtasks;
    } finally {
      cleanupPiSession(piResult.session, piResult.tempDir);
    }
  }

  private async executeSubtasks(subtasks: Task[], currentDepth: number, parentSpan?: Span): Promise<Handoff[]> {
    for (const subtask of subtasks) {
      this.taskQueue.enqueue(subtask);
      for (const cb of this.subtaskCreatedCallbacks) {
        cb(subtask, subtask.parentId || "unknown");
      }
    }

    const handoffPromises: Promise<{ subtask: Task; handoff: Handoff }>[] = [];

    for (const subtask of subtasks) {
      logger.debug("Subtask dispatch decision", { subtaskId: subtask.id, scopeSize: subtask.scope.length, willDecompose: shouldDecompose(subtask, this.subplannerConfig, currentDepth + 1), currentDepth, maxDepth: this.subplannerConfig.maxDepth, scopeThreshold: this.subplannerConfig.scopeThreshold });
      const promise = (async () => {
        if (shouldDecompose(subtask, this.subplannerConfig, currentDepth + 1)) {
          logger.info("Subtask still complex — recursing", {
            subtaskId: subtask.id,
            scopeSize: subtask.scope.length,
            nextDepth: currentDepth + 1,
          });

          this.taskQueue.assignTask(subtask.id, "subplanner");
          this.taskQueue.startTask(subtask.id);

          const handoff = await this.decomposeAndExecute(subtask, currentDepth + 1, parentSpan);

          if (handoff.status === "complete") {
            this.taskQueue.completeTask(subtask.id);
          } else {
            this.taskQueue.failTask(subtask.id);
          }

          return { subtask, handoff };
        }

        return this.dispatchToWorker(subtask, parentSpan);
      })();

      handoffPromises.push(promise);
    }

    const results = await Promise.allSettled(handoffPromises);
    const handoffs: Handoff[] = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") {
        handoffs.push(result.value.handoff);
        const { subtask, handoff } = result.value;
        for (const cb of this.subtaskCompletedCallbacks) {
          cb(subtask, handoff, subtask.parentId || "unknown");
        }
      } else {
        logger.error("Subtask execution failed", { reason: result.reason });
        handoffs.push(createFailureHandoff(
          subtasks[i],
          result.reason instanceof Error ? result.reason : new Error(String(result.reason))
        ));
      }
    }

    return handoffs;
  }

  private async dispatchToWorker(subtask: Task, parentSpan?: Span): Promise<{ subtask: Task; handoff: Handoff }> {
    await this.dispatchLimiter.acquire();
    logger.debug("Subtask worker dispatch", { subtaskId: subtask.id, limiterActive: this.dispatchLimiter.getActive(), limiterQueued: this.dispatchLimiter.getQueueLength() });

    // No local branch creation — branches are created inside sandboxes
    // and pushed to remote. Merge queue fetches from origin.

    this.taskQueue.assignTask(subtask.id, `ephemeral-${subtask.id}`);
    this.taskQueue.startTask(subtask.id);

    try {
      const handoff = await this.workerPool.assignTask(subtask, parentSpan);

      if (handoff.filesChanged.length === 0) {
        this.monitor.recordEmptyDiff(subtask.assignedTo || "unknown", subtask.id);
      }

      if (handoff.status === "complete") {
        this.taskQueue.completeTask(subtask.id);
      } else {
        this.taskQueue.failTask(subtask.id);
      }

      this.monitor.recordTokenUsage(handoff.metrics.tokensUsed);

      logger.info("Subtask completed by worker", {
        subtaskId: subtask.id,
        status: handoff.status,
        parentId: subtask.parentId,
      });

      return { subtask, handoff };
    } catch (error) {
      this.taskQueue.failTask(subtask.id);
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error("Worker dispatch failed for subtask", {
        subtaskId: subtask.id,
        error: err.message,
      });
      throw err;
    } finally {
      this.dispatchLimiter.release();
    }
  }

  private async executeAsWorkerTask(task: Task, parentSpan?: Span): Promise<Handoff> {
    // Task is already in 'running' state (set by planner), so we skip
    // assignTask/startTask and dispatch directly to the worker.
    // The planner handles the final complete/fail transition.
    await this.dispatchLimiter.acquire();

    try {
      const handoff = await this.workerPool.assignTask(task, parentSpan);

      if (handoff.filesChanged.length === 0) {
        this.monitor.recordEmptyDiff(task.assignedTo || "unknown", task.id);
      }

      this.monitor.recordTokenUsage(handoff.metrics.tokensUsed);

      return handoff;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error("Worker dispatch failed for atomic task", {
        taskId: task.id,
        error: err.message,
      });
      throw err;
    } finally {
      this.dispatchLimiter.release();
    }
  }

  onSubtaskCreated(callback: (subtask: Task, parentId: string) => void): void {
    this.subtaskCreatedCallbacks.push(callback);
  }

  onSubtaskCompleted(callback: (subtask: Task, handoff: Handoff, parentId: string) => void): void {
    this.subtaskCompletedCallbacks.push(callback);
  }

  onDecomposition(callback: (parentTask: Task, subtasks: Task[], depth: number) => void): void {
    this.decompositionCallbacks.push(callback);
  }

  onError(callback: (error: Error, parentTaskId: string) => void): void {
    this.errorCallbacks.push(callback);
  }
}
