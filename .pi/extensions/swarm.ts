/**
 * Agent Swarm — Pi Extension
 *
 * Registers tools and commands that let the user orchestrate
 * a massively parallel coding swarm from Pi's chat interface.
 *
 * Tools:
 *   launch_swarm  — kick off the orchestrator with a free-form request
 *   swarm_status  — check current progress / metrics
 *   swarm_stop    — gracefully stop a running swarm
 *
 * Commands:
 *   /swarm <request>  — shorthand to launch the swarm
 *
 * The extension runs the orchestrator in-process (background).
 * Pi's LLM sees live swarm state via the `context` event so it can
 * report progress naturally in conversation.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Module-level swarm state
// ---------------------------------------------------------------------------

interface SwarmState {
  status: "idle" | "starting" | "running" | "stopping" | "stopped" | "error";
  request: string;
  startedAt: number;
  error?: string;

  // Live counters (updated by orchestrator callbacks)
  iteration: number;
  tasksCreated: number;
  tasksCompleted: number;
  tasksFailed: number;
  activeWorkers: number;
  commitsPerHour: number;
  totalTokensUsed: number;
  recentEvents: string[]; // rolling log of last 20 events
}

function createInitialState(): SwarmState {
  return {
    status: "idle",
    request: "",
    startedAt: 0,
    iteration: 0,
    tasksCreated: 0,
    tasksCompleted: 0,
    tasksFailed: 0,
    activeWorkers: 0,
    commitsPerHour: 0,
    totalTokensUsed: 0,
    recentEvents: [],
  };
}

let swarmState: SwarmState = createInitialState();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let orchestratorInstance: any = null; // Orchestrator type, but imported dynamically

function pushEvent(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19); // HH:MM:SS
  swarmState.recentEvents.push(`[${ts}] ${msg}`);
  if (swarmState.recentEvents.length > 20) {
    swarmState.recentEvents.shift();
  }
}

function formatSnapshot(): string {
  const s = swarmState;
  const elapsed = s.startedAt > 0
    ? Math.round((Date.now() - s.startedAt) / 1000)
    : 0;
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;

  const lines = [
    `Status: ${s.status}`,
    `Request: ${s.request.slice(0, 120)}`,
    `Elapsed: ${mins}m ${secs}s`,
    `Iteration: ${s.iteration}`,
    `Tasks: ${s.tasksCreated} created, ${s.tasksCompleted} completed, ${s.tasksFailed} failed`,
    `Active workers: ${s.activeWorkers}`,
    `Commits/hr: ${s.commitsPerHour.toFixed(1)}`,
    `Tokens used: ${s.totalTokensUsed.toLocaleString()}`,
  ];

  if (s.recentEvents.length > 0) {
    lines.push("", "Recent events:");
    for (const e of s.recentEvents.slice(-10)) {
      lines.push(`  ${e}`);
    }
  }

  if (s.error) {
    lines.push("", `Error: ${s.error}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // The project root is wherever pi was launched (cwd).
  // The orchestrator package is built at packages/orchestrator/dist/.
  const projectRoot = process.cwd();

  // -----------------------------------------------------------------------
  // Tool: launch_swarm
  // -----------------------------------------------------------------------
  pi.registerTool({
    name: "launch_swarm",
    label: "Launch Swarm",
    description:
      "Launch the agent swarm to build a project in parallel. " +
      "Spawns multiple sandbox workers that each take a task, write code, " +
      "commit, and hand off results. The orchestrator plans, dispatches, " +
      "merges, and reconciles automatically. Returns immediately; use " +
      "swarm_status to check progress.",
    parameters: Type.Object({
      request: Type.String({
        description:
          "The high-level build request. Be specific about what to build, " +
          "reference spec files with @SPEC.md or @FEATURES.json if available.",
      }),
      maxWorkers: Type.Optional(
        Type.Number({
          description:
            "Maximum concurrent sandbox workers. Default: value from env MAX_WORKERS or 4.",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, onUpdate, _ctx) {
      if (swarmState.status === "running" || swarmState.status === "starting") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Swarm is already ${swarmState.status}. Use swarm_status to check progress or swarm_stop to halt it.`,
            },
          ],
          details: { error: "already_running" },
        };
      }

      // Reset state
      swarmState = createInitialState();
      swarmState.status = "starting";
      swarmState.request = params.request;
      swarmState.startedAt = Date.now();

      onUpdate?.({
        content: [{ type: "text" as const, text: "Initializing orchestrator..." }],
        details: { status: "starting" },
      });

      try {
        // Dynamic import — the orchestrator package must be built first.
        // We resolve from the project root's node_modules or the workspace link.
        const orchestratorPath = resolve(
          projectRoot,
          "packages",
          "orchestrator",
          "dist",
          "orchestrator.js",
        );
        const { createOrchestrator } = await import(orchestratorPath);

        const overrides: Record<string, unknown> = {};
        if (params.maxWorkers !== undefined) {
          overrides.maxWorkers = params.maxWorkers;
        }

        orchestratorInstance = await createOrchestrator({
          projectRoot,
          configOverrides: Object.keys(overrides).length > 0 ? overrides : undefined,
          callbacks: {
            onTaskCreated(task: { id: string; description: string }) {
              swarmState.tasksCreated++;
              pushEvent(`Task created: ${task.id} — ${task.description.slice(0, 60)}`);
            },
            onTaskCompleted(
              task: { id: string },
              handoff: { status: string },
            ) {
              if (handoff.status === "complete") {
                swarmState.tasksCompleted++;
              } else {
                swarmState.tasksFailed++;
              }
              pushEvent(`Task ${task.id} ${handoff.status}`);
            },
            onIterationComplete(
              iteration: number,
              tasks: unknown[],
              handoffs: unknown[],
            ) {
              swarmState.iteration = iteration;
              pushEvent(
                `Iteration ${iteration}: ${tasks.length} tasks, ${handoffs.length} handoffs`,
              );
            },
            onError(error: Error) {
              pushEvent(`Planner error: ${error.message}`);
            },
            onSweepComplete(tasks: unknown[]) {
              if ((tasks as unknown[]).length > 0) {
                pushEvent(`Reconciler: ${(tasks as unknown[]).length} fix tasks`);
              }
            },
            onReconcilerError(error: Error) {
              pushEvent(`Reconciler error: ${error.message}`);
            },
            onWorkerTimeout(workerId: string, taskId: string) {
              pushEvent(`TIMEOUT: worker ${workerId} on task ${taskId}`);
            },
            onEmptyDiff(_workerId: string, taskId: string) {
              pushEvent(`Empty diff from task ${taskId}`);
            },
            onMetricsUpdate(snapshot: {
              activeWorkers: number;
              commitsPerHour: number;
              totalTokensUsed: number;
              completedTasks: number;
              failedTasks: number;
            }) {
              swarmState.activeWorkers = snapshot.activeWorkers;
              swarmState.commitsPerHour = snapshot.commitsPerHour;
              swarmState.totalTokensUsed = snapshot.totalTokensUsed;
              swarmState.tasksCompleted = snapshot.completedTasks;
              swarmState.tasksFailed = snapshot.failedTasks;
            },
            onTaskStatusChange(
              task: { id: string; description: string },
              oldStatus: string,
              newStatus: string,
            ) {
              pushEvent(`${task.id}: ${oldStatus} -> ${newStatus}`);
            },
          },
        });

        swarmState.status = "running";
        pushEvent("Orchestrator started");

        // Fire-and-forget: run the planner loop in the background.
        // We don't await — this returns immediately so Pi stays responsive.
        orchestratorInstance
          .run(params.request)
          .then((snapshot: Record<string, unknown>) => {
            swarmState.status = "stopped";
            pushEvent(`Planner loop complete: ${JSON.stringify(snapshot)}`);
          })
          .catch((err: Error) => {
            swarmState.status = "error";
            swarmState.error = err.message;
            pushEvent(`FATAL: ${err.message}`);
          });

        const workers = params.maxWorkers ?? orchestratorInstance.config?.maxWorkers ?? 4;

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Swarm launched with up to ${workers} parallel workers.\n` +
                `Request: ${params.request.slice(0, 200)}\n\n` +
                `The orchestrator is running in the background. ` +
                `Use the swarm_status tool to check progress, or swarm_stop to halt.`,
            },
          ],
          details: { status: "launched", workers },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        swarmState.status = "error";
        swarmState.error = msg;

        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to launch swarm: ${msg}\n\nMake sure:\n- .env has LLM_BASE_URL and GIT_REPO_URL set\n- packages/orchestrator is built (pnpm build)`,
            },
          ],
          details: { error: msg },
        };
      }
    },
  });

  // -----------------------------------------------------------------------
  // Tool: swarm_status
  // -----------------------------------------------------------------------
  pi.registerTool({
    name: "swarm_status",
    label: "Swarm Status",
    description:
      "Check the current status of the agent swarm. Returns metrics " +
      "including tasks created/completed, active workers, commits per hour, " +
      "and recent events.",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      if (swarmState.status === "idle") {
        return {
          content: [
            {
              type: "text" as const,
              text: "No swarm is running. Use launch_swarm to start one.",
            },
          ],
          details: { status: "idle" },
        };
      }

      // Pull latest snapshot from orchestrator if available
      if (orchestratorInstance && typeof orchestratorInstance.getSnapshot === "function") {
        try {
          const snapshot = orchestratorInstance.getSnapshot();
          swarmState.activeWorkers = snapshot.activeWorkers;
          swarmState.commitsPerHour = snapshot.commitsPerHour;
          swarmState.totalTokensUsed = snapshot.totalTokensUsed;
        } catch {
          // Ignore — may be shut down
        }
      }

      return {
        content: [{ type: "text" as const, text: formatSnapshot() }],
        details: { ...swarmState },
      };
    },
  });

  // -----------------------------------------------------------------------
  // Tool: swarm_stop
  // -----------------------------------------------------------------------
  pi.registerTool({
    name: "swarm_stop",
    label: "Stop Swarm",
    description:
      "Gracefully stop the running agent swarm. Completes in-progress tasks " +
      "then shuts down. Returns final metrics.",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      if (swarmState.status !== "running" && swarmState.status !== "starting") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Swarm is not running (status: ${swarmState.status}).`,
            },
          ],
          details: { status: swarmState.status },
        };
      }

      swarmState.status = "stopping";
      pushEvent("Stop requested by user");

      try {
        if (orchestratorInstance && typeof orchestratorInstance.stop === "function") {
          await orchestratorInstance.stop();
        }
        swarmState.status = "stopped";
        pushEvent("Orchestrator stopped");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        swarmState.status = "error";
        swarmState.error = msg;
        pushEvent(`Error during stop: ${msg}`);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Swarm stopped.\n\n${formatSnapshot()}`,
          },
        ],
        details: { ...swarmState },
      };
    },
  });

  // -----------------------------------------------------------------------
  // Command: /swarm <request>
  // -----------------------------------------------------------------------
  pi.registerCommand("swarm", {
    description: "Launch the agent swarm with a build request",
    handler: async (args, _ctx) => {
      if (!args.trim()) {
        pi.sendUserMessage(
          "Usage: /swarm <request>\n\n" +
            "Example: /swarm Build VoxelCraft according to @SPEC.md and @FEATURES.json",
        );
        return;
      }

      // Inject a user message that will trigger the LLM to call launch_swarm
      pi.sendUserMessage(
        `Launch the agent swarm with this request: ${args}\n\n` +
          "Use the launch_swarm tool to start it.",
      );
    },
  });

  // -----------------------------------------------------------------------
  // Context injection: swarm state in every turn
  // -----------------------------------------------------------------------
  pi.on("context", (_event, _ctx) => {
    if (swarmState.status === "idle") return;

    // Inject current swarm state so the LLM naturally knows about it.
    return {
      context:
        "## Active Agent Swarm\n" +
        "```\n" +
        formatSnapshot() +
        "\n```\n" +
        "You have access to swarm_status and swarm_stop tools to manage it.\n",
    };
  });
}
