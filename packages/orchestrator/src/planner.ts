/**
 * Root Planner - LLM-powered task decomposition and orchestration
 */

import type { Task, Handoff } from "@agentswarm/core";
import { createLogger, createBranch } from "@agentswarm/core";
import type { OrchestratorConfig } from "./config.js";
import type { TaskQueue } from "./task-queue.js";
import type { WorkerPool } from "./worker-pool.js";
import type { MergeQueue } from "./merge-queue.js";
import type { Monitor } from "./monitor.js";
import { LLMClient, type LLMMessage } from "./llm-client.js";
import { type RepoState, type RawTaskInput, readRepoState, parseLLMTaskArray, ConcurrencyLimiter } from "./shared.js";

const logger = createLogger("planner", "root-planner");

export interface PlannerConfig {
  maxIterations: number;
}

/**
 * Root planner that decomposes work into tasks using LLM,
 * dispatches them to workers, and collects handoffs
 */
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

  /**
   * Run the main planning loop
   */
  async runLoop(request: string): Promise<void> {
    this.running = true;
    logger.info("Starting planner loop", { request: request.slice(0, 200) });

    let iteration = 0;
    let allHandoffs: Handoff[] = [];

    while (this.running && iteration < this.plannerConfig.maxIterations) {
      iteration++;
      logger.info(`Planning iteration ${iteration}`);

      try {
        const repoState = await this.readRepoState();

        const tasks = await this.plan(request, repoState, allHandoffs);

        if (tasks.length === 0) {
          logger.info("No more tasks to create. Planning complete.");
          break;
        }

        logger.info(`Created ${tasks.length} tasks for iteration ${iteration}`);

        const handoffs = await this.executeTasks(tasks);
        allHandoffs.push(...handoffs);

        for (const task of tasks) {
          const taskObj = this.taskQueue.getById(task.id);
          if (taskObj?.status === "complete") {
            this.mergeQueue.enqueue(task.branch);
          }
        }
        const mergeResults = await this.mergeQueue.processQueue();
        for (const r of mergeResults) {
          this.monitor.recordMergeAttempt(r.success);
          logger.info("Merge result", {
            branch: r.branch,
            status: r.status,
            success: r.success,
          });
        }

        for (const cb of this.iterationCompleteCallbacks) {
          cb(iteration, tasks, handoffs);
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error(`Error in planning iteration ${iteration}`, { error: err.message });
        for (const cb of this.errorCallbacks) {
          cb(err);
        }
      }
    }

    this.running = false;
    logger.info("Planner loop finished", { iterations: iteration, totalHandoffs: allHandoffs.length });
  }

  /**
   * Stop the planning loop
   */
  stop(): void {
    this.running = false;
    logger.info("Planner stop requested");
  }

  /**
   * Check if planner is running
   */
  isRunning(): boolean {
    return this.running;
  }

  async readRepoState(): Promise<RepoState> {
    return readRepoState(this.targetRepoPath);
  }

  /**
   * Use LLM to decompose request into tasks
   */
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

  /**
   * Execute tasks by enqueueing and assigning to workers
   */
  async executeTasks(tasks: Task[]): Promise<Handoff[]> {
    // Enqueue all tasks
    for (const task of tasks) {
      this.taskQueue.enqueue(task);
      for (const cb of this.taskCreatedCallbacks) {
        cb(task);
      }
    }

    // Process tasks - assign to available workers
    const handoffPromises: Promise<{ task: Task; handoff: Handoff }>[] = [];

    for (const task of tasks) {
      const promise = (async () => {
        await this.dispatchLimiter.acquire();

        try {
          await createBranch(task.branch, this.targetRepoPath);
        } catch {
          // Branch may already exist
        }

        this.taskQueue.assignTask(task.id, `ephemeral-${task.id}`);
        this.taskQueue.startTask(task.id);

        try {
          const handoff = await this.workerPool.assignTask(task);

          // Check for empty diff
          if (handoff.filesChanged.length === 0) {
            this.monitor.recordEmptyDiff(task.assignedTo || "unknown", task.id);
          }

          // Update task status based on handoff
          if (handoff.status === "complete") {
            this.taskQueue.completeTask(task.id);
          } else {
            this.taskQueue.failTask(task.id);
          }

          // Record token usage
          this.monitor.recordTokenUsage(handoff.metrics.tokensUsed);

          // Fire callback
          for (const cb of this.taskCompletedCallbacks) {
            cb(task, handoff);
          }

          return { task, handoff };
        } catch (error) {
          this.taskQueue.failTask(task.id);
          const err = error instanceof Error ? error : new Error(String(error));
          throw err;
        } finally {
          this.dispatchLimiter.release();
        }
      })();

      handoffPromises.push(promise);
    }

    // Wait for all tasks to complete
    const results = await Promise.allSettled(handoffPromises);
    const handoffs: Handoff[] = [];

    for (const result of results) {
      if (result.status === "fulfilled") {
        handoffs.push(result.value.handoff);
      }
    }

    return handoffs;
  }

  /**
   * Register callback for task creation
   */
  onTaskCreated(callback: (task: Task) => void): void {
    this.taskCreatedCallbacks.push(callback);
  }

  /**
   * Register callback for task completion
   */
  onTaskCompleted(callback: (task: Task, handoff: Handoff) => void): void {
    this.taskCompletedCallbacks.push(callback);
  }

  /**
   * Register callback for iteration completion
   */
  onIterationComplete(callback: (iteration: number, tasks: Task[], handoffs: Handoff[]) => void): void {
    this.iterationCompleteCallbacks.push(callback);
  }

  /**
   * Register callback for errors
   */
  onError(callback: (error: Error) => void): void {
    this.errorCallbacks.push(callback);
  }
}
