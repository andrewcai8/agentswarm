/** @module MCP HTTP server exposing orchestrator control via subprocess management and NDJSON log tailing */
/**
 * Architecture: This server has two subsystems:
 *
 * 1. SUBPROCESS MANAGEMENT
 *    Spawns and controls `python3 main.py` as a child process.
 *    Tracks process state (idle/running/stopping), handles graceful
 *    shutdown (SIGTERM → 30s → SIGKILL), and manages lifecycle.
 *
 * 2. NDJSON LOG TAILING
 *    Polls the latest logs/run-*.ndjson file every 2 seconds.
 *    Extracts metrics snapshots and activity feed events for
 *    real-time status reporting to MCP clients.
 *
 * The server exposes 4 tools via MCP protocol over HTTP:
 *   - launch_swarm: Start orchestrator with a coding request
 *   - stop_swarm: Gracefully stop the running orchestrator
 *   - get_swarm_status: Current metrics and process state
 *   - get_activity_feed: Recent activity events from NDJSON log
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { type ChildProcess, spawn } from "child_process";
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "fs";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { resolve } from "path";
import { createInterface } from "readline";
import { z } from "zod";

// ---------------------------------------------------------------------------
// State management (module-level singletons)
// ---------------------------------------------------------------------------

let orchestratorProcess: ChildProcess | null = null;
let processState: "idle" | "starting" | "running" | "stopping" = "idle";
let startedAt: number | null = null;
let killTimeout: ReturnType<typeof setTimeout> | null = null;

interface SwarmMetrics {
  activeWorkers: number;
  pendingTasks: number;
  runningTasks: number;
  completedTasks: number;
  failedTasks: number;
  commitsPerHour: number;
  mergeSuccessRate: number;
  totalTokensUsed: number;
  totalCostUsd: number;
  activeToolCalls: number;
  estimatedInFlightTokens: number;
  mergeQueueDepth: number;
  totalMerged: number;
  totalMergeFailed: number;
  totalConflicts: number;
}

let latestMetrics: SwarmMetrics | null = null;

interface ActivityEvent {
  timestamp: string;
  message: string;
  level: string;
  data?: Record<string, unknown>;
}

const activityBuffer: ActivityEvent[] = [];
const MAX_ACTIVITY = 50;

// ---------------------------------------------------------------------------
// NDJSON log file tailing
// ---------------------------------------------------------------------------

let logTailInterval: ReturnType<typeof setInterval> | null = null;
let currentLogFile: string | null = null;
let logFileOffset = 0;

const PROJECT_ROOT = process.cwd();
const MAIN_PY = resolve(PROJECT_ROOT, "main.py");
const LOGS_DIR = resolve(PROJECT_ROOT, "logs");
const DEFAULT_REQUEST = "Build a playable MVP of Minecraft";

/** Find the most recently modified .ndjson in logs/. */
function findLatestLogFile(): string | null {
  if (!existsSync(LOGS_DIR)) return null;
  let entries: string[];
  try {
    entries = readdirSync(LOGS_DIR);
  } catch {
    return null;
  }
  const files = entries
    .filter((f) => f.startsWith("run-") && f.endsWith(".ndjson"))
    .map((f) => {
      const full = resolve(LOGS_DIR, f);
      try {
        return { path: full, mtime: statSync(full).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { path: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? files[0].path : null;
}

/** Read new bytes from the NDJSON log file and parse for metrics + activity. */
function tailLogFile(): void {
  const latest = findLatestLogFile();
  if (!latest) return;

  if (latest !== currentLogFile) {
    currentLogFile = latest;
    logFileOffset = 0;
  }

  let fd: number;
  try {
    fd = openSync(currentLogFile, "r");
  } catch {
    return;
  }

  try {
    const fileSize = fstatSync(fd).size;
    if (fileSize <= logFileOffset) return;

    const bytesToRead = fileSize - logFileOffset;
    const buffer = Buffer.alloc(bytesToRead);
    readSync(fd, buffer, 0, bytesToRead, logFileOffset);
    logFileOffset = fileSize;

    const lines = buffer.toString("utf-8").split("\n");
    for (const line of lines) {
      parseNdjsonLine(line);
    }
  } finally {
    closeSync(fd);
  }
}

function startLogTailing(): void {
  if (logTailInterval) return;
  logTailInterval = setInterval(tailLogFile, 2000);
  tailLogFile();
}

function stopLogTailing(): void {
  if (logTailInterval) {
    clearInterval(logTailInterval);
    logTailInterval = null;
  }
  currentLogFile = null;
  logFileOffset = 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip ANSI escape codes from main.py's colored output. */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "");
}

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return [
    String(d.getHours()).padStart(2, "0"),
    String(d.getMinutes()).padStart(2, "0"),
    String(d.getSeconds()).padStart(2, "0"),
  ].join(":");
}

function pushActivity(event: ActivityEvent): void {
  activityBuffer.push(event);
  if (activityBuffer.length > MAX_ACTIVITY) {
    activityBuffer.shift();
  }
}

function parseNdjsonLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return; // not valid JSON — skip
  }

  const ts =
    typeof parsed["timestamp"] === "number"
      ? new Date(parsed["timestamp"] as number).toISOString()
      : new Date().toISOString();
  const level = typeof parsed["level"] === "string" ? (parsed["level"] as string) : "info";
  const message = typeof parsed["message"] === "string" ? (parsed["message"] as string) : "";
  const data =
    typeof parsed["data"] === "object" && parsed["data"] !== null
      ? (parsed["data"] as Record<string, unknown>)
      : undefined;

  // Update metrics if this is a Metrics event
  if (message === "Metrics" && data) {
    latestMetrics = {
      activeWorkers: Number(data["activeWorkers"] ?? 0),
      pendingTasks: Number(data["pendingTasks"] ?? 0),
      runningTasks: Number(data["runningTasks"] ?? 0),
      completedTasks: Number(data["completedTasks"] ?? 0),
      failedTasks: Number(data["failedTasks"] ?? 0),
      commitsPerHour: Number(data["commitsPerHour"] ?? 0),
      mergeSuccessRate: Number(data["mergeSuccessRate"] ?? 0),
      totalTokensUsed: Number(data["totalTokensUsed"] ?? 0),
      totalCostUsd: Number(data["totalCostUsd"] ?? 0),
      activeToolCalls: Number(data["activeToolCalls"] ?? 0),
      estimatedInFlightTokens: Number(data["estimatedInFlightTokens"] ?? 0),
      mergeQueueDepth: Number(data["mergeQueueDepth"] ?? 0),
      totalMerged: Number(data["totalMerged"] ?? 0),
      totalMergeFailed: Number(data["totalMergeFailed"] ?? 0),
      totalConflicts: Number(data["totalConflicts"] ?? 0),
    };
  }

  // Push notable events to activity (skip noisy debug + periodic Metrics)
  if (level !== "debug" && message !== "Metrics") {
    pushActivity({ timestamp: ts, message, level, data });
  }
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

function registerTools(server: McpServer): void {
  server.tool(
    "launch_swarm",
    "Launch the AgentSwarm orchestrator to begin parallel autonomous coding. Resets the target repo and starts a fresh run.",
    {
      request: z.string().optional().describe(`Build request (defaults to '${DEFAULT_REQUEST}')`),
    },
    async ({ request }) => {
      if (processState !== "idle") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Swarm is already active (state: ${processState}). Use stop_swarm first.`,
            },
          ],
        };
      }

      if (!existsSync(MAIN_PY)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `main.py not found at ${MAIN_PY}. Is this the right project root?`,
            },
          ],
        };
      }

      processState = "starting";
      latestMetrics = null;

      const buildRequest = request ?? DEFAULT_REQUEST;

      // Same route as: python3 main.py --reset "Build a playable MVP of Minecraft"
      // This resets target-repo to its initial commit, then launches the orchestrator.
      const child = spawn("python3", [MAIN_PY, "--reset", buildRequest], {
        cwd: PROJECT_ROOT,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      orchestratorProcess = child;

      // main.py reformats NDJSON into colored human-readable text.
      // We capture it stripped of ANSI as plain-text activity.
      // Structured metrics come from tailing the NDJSON log file instead.
      if (child.stdout) {
        const rl = createInterface({ input: child.stdout });
        rl.on("line", (line: string) => {
          const clean = stripAnsi(line).trim();
          if (!clean) return;
          pushActivity({
            timestamp: new Date().toISOString(),
            message: clean,
            level: "info",
          });
        });
      }

      if (child.stderr) {
        const rl = createInterface({ input: child.stderr });
        rl.on("line", (line: string) => {
          const clean = stripAnsi(line).trim();
          if (!clean) return;
          pushActivity({
            timestamp: new Date().toISOString(),
            message: clean,
            level: "error",
          });
        });
      }

      child.on("error", (err: Error) => {
        processState = "idle";
        orchestratorProcess = null;
        startedAt = null;
        stopLogTailing();
        pushActivity({
          timestamp: new Date().toISOString(),
          message: `Process error: ${err.message}`,
          level: "error",
        });
      });

      child.on("exit", (code: number | null, signal: string | null) => {
        processState = "idle";
        orchestratorProcess = null;
        startedAt = null;
        stopLogTailing();
        if (killTimeout) {
          clearTimeout(killTimeout);
          killTimeout = null;
        }
        pushActivity({
          timestamp: new Date().toISOString(),
          message: `Orchestrator exited (code=${code}, signal=${signal})`,
          level: code === 0 ? "info" : "error",
        });
      });

      processState = "running";
      startedAt = Date.now();

      // The orchestrator writes ALL events to logs/run-*.ndjson.
      // Give it a few seconds to start up and create the file, then tail it.
      setTimeout(() => startLogTailing(), 3000);

      const pid = child.pid ?? "unknown";
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Swarm launched (PID ${pid}).`,
              `Request: "${buildRequest}"`,
              `Target repo will be reset, then orchestrator starts.`,
              `Use get_swarm_status to monitor progress.`,
            ].join("\n"),
          },
        ],
      };
    },
  );

  // ----- stop_swarm -----
  server.tool("stop_swarm", "Gracefully stop the running AgentSwarm orchestrator", {}, async () => {
    if (!orchestratorProcess || processState === "idle") {
      return {
        content: [{ type: "text" as const, text: "Swarm is not running." }],
      };
    }

    const pid = orchestratorProcess.pid ?? "unknown";
    processState = "stopping";
    orchestratorProcess.kill("SIGTERM");

    // Force kill after 30 seconds if still alive
    killTimeout = setTimeout(() => {
      if (orchestratorProcess) {
        orchestratorProcess.kill("SIGKILL");
        pushActivity({
          timestamp: new Date().toISOString(),
          message: "Force-killed orchestrator after 30s timeout",
          level: "warn",
        });
      }
      killTimeout = null;
    }, 30_000);

    return {
      content: [
        {
          type: "text" as const,
          text: `Stopping swarm (PID ${pid}). It will finish current tasks and shut down.`,
        },
      ],
    };
  });

  // ----- get_swarm_status -----
  server.tool(
    "get_swarm_status",
    "Get real-time status of the AgentSwarm orchestrator",
    {},
    async () => {
      if (processState === "idle" && !latestMetrics) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Swarm is not running. Use launch_swarm to start.",
            },
          ],
        };
      }

      const lines: string[] = ["=== AgentSwarm Status ==="];
      lines.push(`State: ${processState}`);

      if (startedAt) {
        lines.push(`Uptime: ${formatUptime(Date.now() - startedAt)}`);
      }

      if (latestMetrics) {
        const m = latestMetrics;
        lines.push(`Active Workers: ${m.activeWorkers}/${m.activeWorkers + m.pendingTasks}`);
        lines.push(`Commits/Hour: ${m.commitsPerHour.toFixed(1)}`);
        lines.push("");
        lines.push(
          `Tasks: ${m.completedTasks} completed, ${m.failedTasks} failed, ${m.pendingTasks} pending`,
        );
        lines.push(`Merge Rate: ${(m.mergeSuccessRate * 100).toFixed(1)}%`);
        lines.push(
          `Merged: ${m.totalMerged} | Conflicts: ${m.totalConflicts} | Failed: ${m.totalMergeFailed}`,
        );
        lines.push(`Tokens Used: ${formatTokens(m.totalTokensUsed)}`);
        lines.push(`Est. Cost: $${m.totalCostUsd.toFixed(2)}`);
        if (m.mergeQueueDepth > 0) {
          lines.push(`Merge Queue: ${m.mergeQueueDepth} pending`);
        }
      } else if (processState !== "idle") {
        lines.push("(waiting for first metrics — orchestrator is starting up)");
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  );

  // ----- get_activity_feed -----
  server.tool(
    "get_activity_feed",
    "Get recent activity events from the AgentSwarm orchestrator",
    {
      count: z
        .number()
        .optional()
        .describe("Number of recent events to return (default 10, max 50)"),
    },
    async ({ count }) => {
      if (activityBuffer.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No activity yet. Is the swarm running?",
            },
          ],
        };
      }

      const n = Math.min(Math.max(count ?? 10, 1), MAX_ACTIVITY);
      const slice = activityBuffer.slice(-n).reverse();

      const formatted = slice.map((e) => {
        const time = formatTime(new Date(e.timestamp).getTime());
        const level = e.level.toUpperCase();
        let line = `[${time}] [${level}] ${e.message}`;
        if (e.data && Object.keys(e.data).length > 0) {
          const pairs = Object.entries(e.data)
            .slice(0, 6)
            .map(([k, v]) => {
              const val = typeof v === "object" ? JSON.stringify(v) : String(v);
              return `${k}: ${val.length > 60 ? val.slice(0, 57) + "..." : val}`;
            })
            .join(", ");
          line += ` — ${pairs}`;
        }
        return line;
      });

      return {
        content: [{ type: "text" as const, text: formatted.join("\n") }],
      };
    },
  );
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env["PORT"] || "8787", 10);

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (req.url === "/mcp" || req.url?.startsWith("/mcp?")) {
    try {
      const server = new McpServer(
        { name: "longshot", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      registerTools(server);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end(`Internal error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else {
    res.writeHead(404);
    res.end("Not found — MCP endpoint is at /mcp");
  }
});

httpServer.listen(PORT, () => {
  console.log(`Longshot MCP server running at http://localhost:${PORT}/mcp`);
  console.log();
  console.log("Tools available:");
  console.log("  launch_swarm      — Reset target repo + start orchestrator");
  console.log("  stop_swarm        — Graceful shutdown");
  console.log("  get_swarm_status  — Real-time metrics");
  console.log("  get_activity_feed — Recent event log");
  console.log();
  console.log("Next step — in another terminal, run:");
  console.log();
  console.log(`  npx poke tunnel http://localhost:${PORT}/mcp --name "Longshot"`);
  console.log();
});
