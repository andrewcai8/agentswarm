import type { Task, Handoff, Tracer, Span } from "@longshot/core";
import { createLogger } from "@longshot/core";
import type { OrchestratorConfig } from "./config.js";
import type { TaskQueue } from "./task-queue.js";
import type { WorkerPool } from "./worker-pool.js";
import type { MergeQueue } from "./merge-queue.js";
import type { Monitor } from "./monitor.js";
import { createPlannerPiSession, cleanupPiSession, type PiSessionResult } from "./shared.js";
import { type RepoState, type RawTaskInput, readRepoState, parsePlannerResponse, parseLLMTaskArray, ConcurrencyLimiter, slugifyForBranch, sleep, MAX_HANDOFF_SUMMARY_CHARS, MAX_FILES_PER_HANDOFF } from "./shared.js";

const logger = createLogger("subplanner", "subplanner");

const LOOP_SLEEP_MS = 500;
const MIN_HANDOFFS_FOR_REPLAN = 1;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;
const MAX_CONSECUTIVE_ERRORS = 5;
const MAX_SUBPLANNER_ITERATIONS = 20;

function collectCompletedHandoffs(
  pending: { subtask: Task; handoff: Handoff }[],
  all: Handoff[],
  sinceLastPlan: Handoff[],
): void {
  while (pending.length > 0) {
    const item = pending.shift();
    if (!item) break;
    all.push(item.handoff);
    sinceLastPlan.push(item.handoff);
  }
}

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

    const pendingHandoffs: { subtask: Task; handoff: Handoff }[] = [];
    const allHandoffs: Handoff[] = [];
    let handoffsSinceLastPlan: Handoff[] = [];
    const activeTasks = new Set<string>();
    const dispatchedTaskIds = new Set<string>();
    const allSubtasks: Task[] = [];
    let scratchpad = "";
    let piSession: PiSessionResult | null = null;
    let lastTotalTokens = 0;

    let iteration = 0;
    let planningDone = false;
    let consecutiveErrors = 0;

    try {
      logger.debug("Subplanner decompose starting", { parentTaskId: parentTask.id, depth, description: parentTask.description.slice(0, 200), scope: parentTask.scope, acceptance: parentTask.acceptance.slice(0, 200) });

      const initialRepoState = await readRepoState(this.targetRepoPath);

      piSession = await createPlannerPiSession({
        systemPrompt: this.systemPrompt,
        targetRepoPath: this.targetRepoPath,
        llmConfig: this.config.llm,
      });

      while (iteration < MAX_SUBPLANNER_ITERATIONS) {
        try {
          collectCompletedHandoffs(pendingHandoffs, allHandoffs, handoffsSinceLastPlan);

          const hasCapacity = activeTasks.size < this.config.maxWorkers;
          const hasEnoughHandoffs = handoffsSinceLastPlan.length >= MIN_HANDOFFS_FOR_REPLAN;
          const noActiveWork = activeTasks.size === 0 && iteration > 0;
          const needsPlan = hasCapacity && (iteration === 0 || hasEnoughHandoffs || noActiveWork) && !planningDone;

          if (needsPlan && piSession) {
            const session = piSession.session;
            const repoState = iteration === 0 ? initialRepoState : await readRepoState(this.targetRepoPath);

            const message = iteration === 0
              ? this.buildInitialMessage(parentTask, repoState, depth)
              : this.buildFollowUpMessage(repoState, handoffsSinceLastPlan, activeTasks, dispatchedTaskIds);

            logger.info(`Subplanner planning iteration ${iteration + 1}`, {
              parentTaskId: parentTask.id,
              depth,
              handoffsSinceLastPlan: handoffsSinceLastPlan.length,
              activeTasks: activeTasks.size,
            });

            await session.prompt(message);

            const stats = session.getSessionStats();
            const tokenDelta = stats.tokens.total - lastTotalTokens;
            lastTotalTokens = stats.tokens.total;
            this.monitor.recordTokenUsage(tokenDelta);

            const responseText = session.getLastAssistantText();
            logger.debug("Subplanner LLM response", { parentTaskId: parentTask.id, responseLength: responseText?.length ?? 0, preview: responseText?.slice(0, 500) ?? "" });

            if (!responseText) {
              logger.warn("Pi session returned no text for subplanner", { parentTaskId: parentTask.id });
              handoffsSinceLastPlan = [];
              iteration++;
              consecutiveErrors = 0;

              if (activeTasks.size === 0) {
                planningDone = true;
              }
            } else {
              const { scratchpad: newScratchpad, tasks: rawTasks } = parsePlannerResponse(responseText);
              if (newScratchpad) {
                scratchpad = newScratchpad;
              }
              logger.debug("Subplanner scratchpad", { scratchpad: scratchpad.slice(0, 500) });

              const tasks = this.buildSubtasksFromRaw(rawTasks, parentTask, dispatchedTaskIds);

              handoffsSinceLastPlan = [];
              iteration++;
              consecutiveErrors = 0;

              if (tasks.length === 0 && activeTasks.size === 0) {
                if (iteration === 1) {
                  taskLogger.info("LLM returned no subtasks — task is atomic, dispatching to worker directly");
                  cleanupPiSession(session, piSession.tempDir);
                  piSession = null;
                  const handoff = await this.executeAsWorkerTask(parentTask, span);
                  span?.setAttributes({ atomic: true });
                  span?.setStatus("ok");
                  span?.end();
                  return handoff;
                } else {
                  planningDone = true;
                }
              } else if (tasks.length > 0) {
                allSubtasks.push(...tasks);

                for (const cb of this.decompositionCallbacks) {
                  cb(parentTask, tasks, depth);
                }

                taskLogger.info(`Decomposed into ${tasks.length} subtasks`, {
                  subtaskIds: tasks.map((s) => s.id),
                  depth,
                  iteration,
                });

                this.dispatchSubtasksBatch(tasks, parentTask, depth, pendingHandoffs, activeTasks, dispatchedTaskIds, parentSpan);
              }
            }
          }

          if (planningDone && activeTasks.size === 0) {
            break;
          }
          if (!planningDone && activeTasks.size === 0 && iteration > 0 && handoffsSinceLastPlan.length === 0) {
            break;
          }

          await sleep(LOOP_SLEEP_MS);
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          consecutiveErrors++;

          const backoffMs = Math.min(
            BACKOFF_BASE_MS * Math.pow(2, consecutiveErrors - 1),
            BACKOFF_MAX_MS,
          );

          logger.error(`Subplanner planning failed (attempt ${consecutiveErrors}), retrying in ${(backoffMs / 1000).toFixed(0)}s`, {
            error: err.message,
            parentTaskId: parentTask.id,
            consecutiveErrors,
            iteration: iteration + 1,
            activeTasks: activeTasks.size,
          });

          for (const cb of this.errorCallbacks) {
            cb(err, parentTask.id);
          }

          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            logger.error(`Aborting subplanner after ${MAX_CONSECUTIVE_ERRORS} consecutive failures`, { parentTaskId: parentTask.id });
            break;
          }

          await sleep(backoffMs);
        }
      }

      collectCompletedHandoffs(pendingHandoffs, allHandoffs, handoffsSinceLastPlan);

      while (activeTasks.size > 0) {
        collectCompletedHandoffs(pendingHandoffs, allHandoffs, handoffsSinceLastPlan);
        await sleep(LOOP_SLEEP_MS);
      }

      for (const subtask of allSubtasks) {
        const taskObj = this.taskQueue.getById(subtask.id);
        if (taskObj?.status === "complete") {
          this.mergeQueue.enqueue(subtask.branch, subtask.priority);
        }
      }

      const aggregated = aggregateHandoffs(parentTask, allSubtasks, allHandoffs);
      span?.setAttributes({ subtaskCount: allSubtasks.length, status: aggregated.status });
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
    } finally {
      if (piSession) {
        cleanupPiSession(piSession.session, piSession.tempDir);
      }
    }
  }

  private buildInitialMessage(parentTask: Task, repoState: RepoState, depth: number): string {
    let msg = `## Parent Task\n`;
    msg += `- **ID**: ${parentTask.id}\n`;
    msg += `- **Description**: ${parentTask.description}\n`;
    msg += `- **Scope**: ${parentTask.scope.join(", ")}\n`;
    msg += `- **Acceptance**: ${parentTask.acceptance}\n`;
    msg += `- **Priority**: ${parentTask.priority}\n`;
    msg += `- **Decomposition Depth**: ${depth}\n\n`;

    msg += `## Repository File Tree\n${repoState.fileTree.join("\n")}\n\n`;
    msg += `## Recent Commits\n${repoState.recentCommits.join("\n")}\n\n`;

    if (repoState.featuresJson) {
      msg += `## FEATURES.json\n${repoState.featuresJson}\n\n`;
    }

    msg += `This is the initial planning call. Respond with a JSON object: { "scratchpad": "your analysis and plan", "tasks": [{ "id": "...", "description": "...", "scope": ["..."], "acceptance": "...", "priority": N }] }. If the task is atomic (no decomposition needed), return an empty tasks array.\n`;

    logger.debug("Built initial subplanner prompt", { length: msg.length, parentTaskId: parentTask.id, depth });
    return msg;
  }

  private buildFollowUpMessage(
    repoState: RepoState,
    newHandoffs: Handoff[],
    activeTasks: Set<string>,
    dispatchedTaskIds: Set<string>,
  ): string {
    let msg = `## Updated Repository State\n`;
    msg += `File tree:\n${repoState.fileTree.join("\n")}\n\n`;
    msg += `Recent commits:\n${repoState.recentCommits.join("\n")}\n\n`;

    if (repoState.featuresJson) {
      msg += `## FEATURES.json\n${repoState.featuresJson}\n\n`;
    }

    if (newHandoffs.length > 0) {
      msg += `## New Subtask Handoffs (${newHandoffs.length} since last plan)\n`;
      for (const h of newHandoffs) {
        msg += `### Task ${h.taskId} — ${h.status}\n`;

        const summary = h.summary.length > MAX_HANDOFF_SUMMARY_CHARS
          ? h.summary.slice(0, MAX_HANDOFF_SUMMARY_CHARS) + "\u2026"
          : h.summary;
        msg += `Summary: ${summary}\n`;

        const files = h.filesChanged.length > MAX_FILES_PER_HANDOFF
          ? [...h.filesChanged.slice(0, MAX_FILES_PER_HANDOFF), `... (${h.filesChanged.length - MAX_FILES_PER_HANDOFF} more)`]
          : h.filesChanged;
        msg += `Files changed: ${files.join(", ")}\n`;

        if (h.concerns.length > 0) msg += `Concerns: ${h.concerns.join("; ")}\n`;
        if (h.suggestions.length > 0) msg += `Suggestions: ${h.suggestions.join("; ")}\n`;
        msg += `\n`;
      }
    }

    if (activeTasks.size > 0) {
      msg += `## Currently Active Subtasks (${activeTasks.size})\n`;
      for (const id of activeTasks) {
        const t = this.taskQueue.getById(id);
        if (t) msg += `- ${id}: ${t.description.slice(0, 120)}\n`;
      }
      msg += `\n`;
    }

    msg += `Continue planning. Review the new handoffs and current state. Rewrite your scratchpad and emit the next batch of subtasks as JSON: { "scratchpad": "...", "tasks": [...] }. Subtask ID deduplication is handled automatically — do not re-emit previously used IDs. Return empty tasks array if all work is done.\n`;

    logger.debug("Built follow-up subplanner prompt", { length: msg.length, newHandoffs: newHandoffs.length, activeTasks: activeTasks.size, dispatchedIds: dispatchedTaskIds.size });
    return msg;
  }

  private buildSubtasksFromRaw(
    rawTasks: RawTaskInput[],
    parentTask: Task,
    dispatchedTaskIds: Set<string>,
  ): Task[] {
    const filtered = rawTasks.filter((r) => r.description?.trim());
    const subtasks: Task[] = [];
    let subCounter = dispatchedTaskIds.size;

    for (const raw of filtered) {
      subCounter++;
      const id = raw.id || `${parentTask.id}-sub-${subCounter}`;

      if (dispatchedTaskIds.has(id)) {
        logger.warn("Skipping duplicate subtask ID from LLM", { subtaskId: id, parentTaskId: parentTask.id });
        continue;
      }

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
  }

  private dispatchSubtasksBatch(
    tasks: Task[],
    parentTask: Task,
    currentDepth: number,
    pendingHandoffs: { subtask: Task; handoff: Handoff }[],
    activeTasks: Set<string>,
    dispatchedTaskIds: Set<string>,
    parentSpan?: Span,
  ): void {
    for (const subtask of tasks) {
      this.taskQueue.enqueue(subtask);
      for (const cb of this.subtaskCreatedCallbacks) {
        cb(subtask, subtask.parentId || "unknown");
      }

      dispatchedTaskIds.add(subtask.id);
      activeTasks.add(subtask.id);

      const promise = (async () => {
        await this.dispatchLimiter.acquire();
        logger.debug("Subtask dispatch acquired slot", { subtaskId: subtask.id, limiterActive: this.dispatchLimiter.getActive(), limiterQueued: this.dispatchLimiter.getQueueLength() });

        try {
          let handoff: Handoff;

          logger.debug("Subtask dispatch decision", { subtaskId: subtask.id, scopeSize: subtask.scope.length, willDecompose: shouldDecompose(subtask, this.subplannerConfig, currentDepth + 1), currentDepth, maxDepth: this.subplannerConfig.maxDepth, scopeThreshold: this.subplannerConfig.scopeThreshold });

          if (shouldDecompose(subtask, this.subplannerConfig, currentDepth + 1)) {
            logger.info("Subtask still complex — recursing", {
              subtaskId: subtask.id,
              scopeSize: subtask.scope.length,
              nextDepth: currentDepth + 1,
            });

            this.taskQueue.assignTask(subtask.id, "subplanner");
            this.taskQueue.startTask(subtask.id);

            handoff = await this.decomposeAndExecute(subtask, currentDepth + 1, parentSpan);
          } else {
            this.taskQueue.assignTask(subtask.id, `ephemeral-${subtask.id}`);
            this.taskQueue.startTask(subtask.id);

            handoff = await this.workerPool.assignTask(subtask, parentSpan);

            if (handoff.filesChanged.length === 0) {
              this.monitor.recordEmptyDiff(subtask.assignedTo || "unknown", subtask.id);
            }

            this.monitor.recordTokenUsage(handoff.metrics.tokensUsed);
          }

          if (handoff.status === "complete") {
            this.taskQueue.completeTask(subtask.id);
          } else {
            this.taskQueue.failTask(subtask.id);
          }

          logger.info("Subtask completed", {
            subtaskId: subtask.id,
            status: handoff.status,
            parentId: subtask.parentId,
          });

          for (const cb of this.subtaskCompletedCallbacks) {
            cb(subtask, handoff, subtask.parentId || "unknown");
          }

          pendingHandoffs.push({ subtask, handoff });
        } catch (error) {
          this.taskQueue.failTask(subtask.id);
          const err = error instanceof Error ? error : new Error(String(error));
          logger.error("Subtask dispatch failed", { subtaskId: subtask.id, error: err.message });

          pendingHandoffs.push({ subtask, handoff: createFailureHandoff(subtask, err) });
        } finally {
          this.dispatchLimiter.release();
          activeTasks.delete(subtask.id);
        }
      })();

      promise.catch((error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error("Unhandled subtask dispatch error", { subtaskId: subtask.id, error: err.message });
        activeTasks.delete(subtask.id);
        for (const cb of this.errorCallbacks) {
          cb(err, parentTask.id);
        }
      });
    }
  }

  private async executeAsWorkerTask(task: Task, parentSpan?: Span): Promise<Handoff> {
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
