/**
 * Worker Pool — Ephemeral sandbox model
 *
 * Each task gets its own short-lived Modal sandbox:
 *   create → write task.json → exec worker-runner.js → read result.json → terminate
 *
 * There is no persistent pool. `start()` and `stop()` are no-ops.
 * `assignTask()` spawns a Python subprocess that handles the full sandbox lifecycle.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Task, Handoff, HarnessConfig } from "@agentswarm/core";
import { createLogger } from "@agentswarm/core";

const execFileAsync = promisify(execFile);

const logger = createLogger("worker-pool", "root-planner");

export interface Worker {
  id: string;
  currentTask: Task;
  startedAt: number;
}

export class WorkerPool {
  private activeWorkers: Map<string, Worker>;
  private workerPrompt: string;
  private config: {
    maxWorkers: number;
    workerTimeout: number;
    llm: HarnessConfig["llm"];
    git: HarnessConfig["git"];
    pythonPath: string;
    gitToken?: string;
  };
  private taskCompleteCallbacks: ((handoff: Handoff) => void)[];
  private workerFailedCallbacks: ((taskId: string, error: Error) => void)[];

  constructor(
    config: {
      maxWorkers: number;
      workerTimeout: number;
      llm: HarnessConfig["llm"];
      git: HarnessConfig["git"];
      pythonPath: string;
      gitToken?: string;
    },
    workerPrompt: string,
  ) {
    this.activeWorkers = new Map();
    this.workerPrompt = workerPrompt;
    this.config = config;
    this.taskCompleteCallbacks = [];
    this.workerFailedCallbacks = [];
  }

  /**
   * No-op — ephemeral model has no persistent sandboxes to start.
   */
  async start(): Promise<void> {
    logger.info("Worker pool ready (ephemeral mode)", { maxWorkers: this.config.maxWorkers });
  }

  /**
   * No-op — ephemeral sandboxes self-terminate after each task.
   */
  async stop(): Promise<void> {
    logger.info("Worker pool stopped", { activeCount: this.activeWorkers.size });
  }

  async assignTask(task: Task): Promise<Handoff> {
    const worker: Worker = {
      id: `ephemeral-${task.id}`,
      currentTask: task,
      startedAt: Date.now(),
    };
    this.activeWorkers.set(worker.id, worker);

    logger.info("Dispatching task to ephemeral sandbox", { taskId: task.id });

    const endpoint = this.config.llm.endpoints[0];
    const baseUrl = endpoint.endpoint.replace(/\/+$/, "");
    const llmEndpointUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;

    const payload = JSON.stringify({
      task,
      systemPrompt: this.workerPrompt,
      repoUrl: this.config.git.repoUrl,
      gitToken: this.config.gitToken || process.env.GIT_TOKEN || "",
      llmConfig: {
        endpoint: llmEndpointUrl,
        model: this.config.llm.model,
        maxTokens: this.config.llm.maxTokens,
        temperature: this.config.llm.temperature,
        apiKey: endpoint.apiKey,
      },
    });

    try {
      const { stdout, stderr } = await execFileAsync(
        this.config.pythonPath,
        ["infra/spawn_sandbox.py", payload],
        {
          cwd: process.cwd(),
          timeout: this.config.workerTimeout * 1000,
          // Worker stdout includes streamed logs + final JSON handoff; large diffs can be several MB
          maxBuffer: 50 * 1024 * 1024,
        },
      );

      if (stderr) {
        logger.warn("Sandbox stderr output", { taskId: task.id, stderr: stderr.slice(0, 500) });
      }

      // The last line of stdout is the JSON handoff result.
      // Previous lines are streamed worker logs.
      const lines = stdout.trim().split("\n");
      const lastLine = lines[lines.length - 1];

      let handoff: Handoff;
      try {
        handoff = JSON.parse(lastLine);
      } catch {
        throw new Error(
          `Failed to parse sandbox output as Handoff JSON: ${lastLine.slice(0, 200)}`
        );
      }

      for (const cb of this.taskCompleteCallbacks) {
        cb(handoff);
      }

      logger.info("Task completed", { taskId: task.id, status: handoff.status });

      return handoff;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error("Ephemeral sandbox failed", { taskId: task.id, error: err.message });

      for (const cb of this.workerFailedCallbacks) {
        cb(task.id, err);
      }

      throw err;
    } finally {
      this.activeWorkers.delete(worker.id);
    }
  }

  getAvailableWorkers(): { id: string }[] {
    const available = this.config.maxWorkers - this.activeWorkers.size;
    if (available <= 0) return [];
    return Array.from({ length: available }, (_, i) => ({ id: `slot-${i}` }));
  }

  getAllWorkers(): Worker[] {
    return Array.from(this.activeWorkers.values());
  }

  getWorkerCount(): number {
    return this.activeWorkers.size;
  }

  getActiveTaskCount(): number {
    return this.activeWorkers.size;
  }

  onTaskComplete(callback: (handoff: Handoff) => void): void {
    this.taskCompleteCallbacks.push(callback);
  }

  onWorkerFailed(callback: (taskId: string, error: Error) => void): void {
    this.workerFailedCallbacks.push(callback);
  }
}
