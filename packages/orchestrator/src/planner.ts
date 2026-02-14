import type { Task, Handoff } from "@agentswarm/core";
import { createLogger } from "@agentswarm/core";
import type { OrchestratorConfig } from "./config.js";
import type { TaskQueue } from "./task-queue.js";
import type { WorkerPool } from "./worker-pool.js";
import type { MergeQueue } from "./merge-queue.js";
import type { Monitor } from "./monitor.js";
import { LLMClient, type LLMMessage } from "./llm-client.js";
import { type RepoState, readRepoState, parseLLMTaskArray, ConcurrencyLimiter } from "./shared.js";

const logger = createLogger("planner", "root-planner");

const LOOP_SLEEP_MS = 500;
const MIN_HANDOFFS_FOR_REPLAN = 3;

export interface PlannerConfig {
  maxIterations: number;
}

export class Planner {
  private config: OrchestratorConfig;
  private plannerConfig: PlannerConfig;
  private llmClient: LLMClient;
  private taskQueue: TaskQueue;
  private workerPool: WorkerPool;
  private mergeQueue: MergeQueue;
  private monitor: Monitor;
  private systemPrompt: string;
  private targetRepoPath: string;

  private running: boolean;
  private taskCounter: number;
  private dispatchLimiter: ConcurrencyLimiter;

  private pendingHandoffs: { task: Task; handoff: Handoff }[];
  private allHandoffs: Handoff[];
  private handoffsSinceLastPlan: Handoff[];
  private activeTasks: Set<string>;

  private taskCreatedCallbacks: ((task: Task) => void)[];
  private taskCompletedCallbacks: ((task: Task, handoff: Handoff) => void)[];
  private iterationCompleteCallbacks: ((iteration: number, tasks: Task[], handoffs: Handoff[]) => void)[];
  private errorCallbacks: ((error: Error) => void)[];

  constructor(
    config: OrchestratorConfig,
    plannerConfig: PlannerConfig,
    taskQueue: TaskQueue,
    workerPool: WorkerPool,
    mergeQueue: MergeQueue,
    monitor: Monitor,
    systemPrompt: string,
  ) {
    this.config = config;
    this.plannerConfig = plannerConfig;
    this.taskQueue = taskQueue;
    this.workerPool = workerPool;
    this.mergeQueue = mergeQueue;
    this.monitor = monitor;
    this.systemPrompt = systemPrompt;
    this.targetRepoPath = config.targetRepoPath;

    this.running = false;
    this.taskCounter = 0;
    this.dispatchLimiter = new ConcurrencyLimiter(config.maxWorkers);

    this.pendingHandoffs = [];
    this.allHandoffs = [];
    this.handoffsSinceLastPlan = [];
    this.activeTasks = new Set();

    this.llmClient = new LLMClient({
      endpoints: config.llm.endpoints,
      model: config.llm.model,
      maxTokens: config.llm.maxTokens,
      temperature: config.llm.temperature,
    });

    this.taskCreatedCallbacks = [];
    this.taskCompletedCallbacks = [];
    this.iterationCompleteCallbacks = [];
    this.errorCallbacks = [];
  }

  /** Streaming planning loop: dispatch tasks immediately, collect handoffs, replan when 3+ complete. */
  async runLoop(request: string): Promise<void> {
    this.running = true;
    logger.info("Starting streaming planner loop", { request: request.slice(0, 200) });

    let iteration = 0;
    let planningDone = false;

    while (this.running && iteration < this.plannerConfig.maxIterations) {
      try {
        this.collectCompletedHandoffs();

        const hasCapacity = this.dispatchLimiter.getActive() < this.config.maxWorkers;
        const hasEnoughHandoffs = this.handoffsSinceLastPlan.length >= MIN_HANDOFFS_FOR_REPLAN;
        const noActiveWork = this.activeTasks.size === 0 && iteration > 0;
        const needsPlan = hasCapacity && (iteration === 0 || hasEnoughHandoffs || noActiveWork);

        if (needsPlan && !planningDone) {
          iteration++;
          logger.info(`Planning iteration ${iteration}`, {
            activeWorkers: this.dispatchLimiter.getActive(),
            handoffsSinceLastPlan: this.handoffsSinceLastPlan.length,
          });

          const repoState = await this.readRepoState();
          const tasks = await this.plan(request, repoState, this.allHandoffs);

          // Capture before reset so callbacks receive the actual handoffs that triggered this plan
          const recentHandoffs = [...this.handoffsSinceLastPlan];
          this.handoffsSinceLastPlan = [];

          if (tasks.length === 0 && this.activeTasks.size === 0) {
            logger.info("No more tasks to create and no active work. Planning complete.");
            planningDone = true;
          } else if (tasks.length > 0) {
            logger.info(`Created ${tasks.length} tasks for iteration ${iteration}`);
            this.dispatchTasks(tasks);

            for (const cb of this.iterationCompleteCallbacks) {
              cb(iteration, tasks, recentHandoffs);
            }
          }
        }

        if (planningDone && this.activeTasks.size === 0) {
          break;
        }

        await sleep(LOOP_SLEEP_MS);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error(`Error in planning iteration ${iteration}`, { error: err.message });
        for (const cb of this.errorCallbacks) {
          cb(err);
        }
        await sleep(LOOP_SLEEP_MS);
      }
    }

    if (this.activeTasks.size > 0) {
      logger.info("Waiting for remaining active tasks", { count: this.activeTasks.size });
      while (this.activeTasks.size > 0 && this.running) {
        this.collectCompletedHandoffs();
        await sleep(LOOP_SLEEP_MS);
      }
    }

    this.running = false;
    logger.info("Planner loop finished", { iterations: iteration, totalHandoffs: this.allHandoffs.length });
  }

  stop(): void {
    this.running = false;
    logger.info("Planner stop requested");
  }

  isRunning(): boolean {
    return this.running;
  }

  async readRepoState(): Promise<RepoState> {
    return readRepoState(this.targetRepoPath);
  }

  async plan(request: string, repoState: RepoState, previousHandoffs: Handoff[]): Promise<Task[]> {
    let userMessage = `## Request\n${request}\n\n`;
    userMessage += `## Repository File Tree\n${repoState.fileTree.join("\n")}\n\n`;
    userMessage += `## Recent Commits\n${repoState.recentCommits.join("\n")}\n\n`;

    if (repoState.featuresJson) {
      userMessage += `## FEATURES.json\n${repoState.featuresJson}\n\n`;
    }

    if (previousHandoffs.length > 0) {
      userMessage += `## Previous Worker Handoffs\n`;
      for (const h of previousHandoffs) {
        userMessage += `### Task ${h.taskId} — ${h.status}\n`;
        userMessage += `Summary: ${h.summary}\n`;
        userMessage += `Files changed: ${h.filesChanged.join(", ")}\n`;
        if (h.concerns.length > 0) userMessage += `Concerns: ${h.concerns.join("; ")}\n`;
        if (h.suggestions.length > 0) userMessage += `Suggestions: ${h.suggestions.join("; ")}\n`;
        userMessage += `\n`;
      }
    }

    const messages: LLMMessage[] = [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: userMessage },
    ];

    logger.info("Calling LLM for task decomposition", { messageLength: userMessage.length });

    const response = await this.llmClient.complete(messages);
    this.monitor.recordTokenUsage(response.usage.totalTokens);

    const rawTasks = parseLLMTaskArray(response.content);

    const tasks: Task[] = rawTasks.map((raw) => {
      this.taskCounter++;
      const id = raw.id || `task-${String(this.taskCounter).padStart(3, "0")}`;
      return {
        id,
        description: raw.description,
        scope: raw.scope || [],
        acceptance: raw.acceptance || "",
        branch: raw.branch || `${this.config.git.branchPrefix}${id}`,
        status: "pending" as const,
        createdAt: Date.now(),
        priority: raw.priority || 5,
      };
    });

    return tasks;
  }

  private dispatchTasks(tasks: Task[]): void {
    for (const task of tasks) {
      this.taskQueue.enqueue(task);
      for (const cb of this.taskCreatedCallbacks) {
        cb(task);
      }

      this.activeTasks.add(task.id);
      this.dispatchSingleTask(task);
    }
  }

  /** Fire-and-forget: dispatches task to a worker, pushes result to pendingHandoffs on completion. */
  private dispatchSingleTask(task: Task): void {
    const promise = (async () => {
      await this.dispatchLimiter.acquire();

      // No local branch creation — branches are created inside sandboxes
      // and pushed to remote. Merge queue fetches from origin.

      this.taskQueue.assignTask(task.id, `ephemeral-${task.id}`);
      this.taskQueue.startTask(task.id);

      try {
        const handoff = await this.workerPool.assignTask(task);

        if (handoff.filesChanged.length === 0) {
          const workerId = this.taskQueue.getById(task.id)?.assignedTo || "unknown";
          this.monitor.recordEmptyDiff(workerId, task.id);
        }

        if (handoff.status === "complete") {
          this.taskQueue.completeTask(task.id);
        } else {
          this.taskQueue.failTask(task.id);
        }

        this.monitor.recordTokenUsage(handoff.metrics.tokensUsed);

        for (const cb of this.taskCompletedCallbacks) {
          cb(task, handoff);
        }

        this.pendingHandoffs.push({ task, handoff });
      } catch (error) {
        this.taskQueue.failTask(task.id);
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error("Task dispatch failed", { taskId: task.id, error: err.message });

        const failureHandoff: Handoff = {
          taskId: task.id,
          status: "failed",
          summary: `Worker failed: ${err.message}`,
          diff: "",
          filesChanged: [],
          concerns: [err.message],
          suggestions: ["Retry the task"],
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
        this.pendingHandoffs.push({ task, handoff: failureHandoff });
      } finally {
        this.dispatchLimiter.release();
        this.activeTasks.delete(task.id);
      }
    })();

    promise.catch((error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error("Unhandled dispatch error", { taskId: task.id, error: err.message });
      this.activeTasks.delete(task.id);
      for (const cb of this.errorCallbacks) {
        cb(err);
      }
    });
  }

  /** Drains pendingHandoffs (populated by dispatchSingleTask) into allHandoffs + merge queue. */
  private collectCompletedHandoffs(): void {
    while (this.pendingHandoffs.length > 0) {
      const completed = this.pendingHandoffs.shift();
      if (!completed) break;

      const { task, handoff } = completed;

      this.allHandoffs.push(handoff);
      this.handoffsSinceLastPlan.push(handoff);

      if (handoff.status === "complete") {
        this.mergeQueue.enqueue(task.branch);
      }

      logger.info("Collected handoff", {
        taskId: task.id,
        status: handoff.status,
        filesChanged: handoff.filesChanged.length,
      });
    }
  }

  onTaskCreated(callback: (task: Task) => void): void {
    this.taskCreatedCallbacks.push(callback);
  }

  onTaskCompleted(callback: (task: Task, handoff: Handoff) => void): void {
    this.taskCompletedCallbacks.push(callback);
  }

  onIterationComplete(callback: (iteration: number, tasks: Task[], handoffs: Handoff[]) => void): void {
    this.iterationCompleteCallbacks.push(callback);
  }

  onError(callback: (error: Error) => void): void {
    this.errorCallbacks.push(callback);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
