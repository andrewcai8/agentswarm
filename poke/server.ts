/**
 * Poke MCP Server for AgentSwarm
 *
 * Exposes orchestrator state as MCP tools so you can text your Poke agent
 * questions like "how's the swarm doing?" and get live metrics back.
 *
 * Usage:
 *   npx tsx poke/server.ts
 *   npx poke tunnel http://localhost:8787/mcp --name "AgentSwarm"
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod/v4";
import { createServer } from "node:http";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT) || Number(process.env.POKE_PORT) || 8787;
const STATE_DIR = process.env.AGENTSWARM_STATE_DIR || path.resolve("./state");
const REPO_ROOT = path.resolve(".");

const server = new McpServer({
  name: "AgentSwarm",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Tool: get_swarm_status
// ---------------------------------------------------------------------------
server.tool(
  "get_swarm_status",
  "Get current AgentSwarm metrics: active workers, pending/completed/failed tasks, commits/hour, cost",
  {},
  async () => {
    const metricsPath = path.join(STATE_DIR, "metrics.json");
    if (fs.existsSync(metricsPath)) {
      const raw = fs.readFileSync(metricsPath, "utf-8");
      const m = JSON.parse(raw);
      const lines = [
        `Active workers: ${m.activeWorkers}`,
        `Pending tasks:  ${m.pendingTasks}`,
        `Completed:      ${m.completedTasks}`,
        `Failed:         ${m.failedTasks}`,
        `Commits/hour:   ${m.commitsPerHour?.toFixed(1) ?? "N/A"}`,
        `Merge success:  ${((m.mergeSuccessRate ?? 0) * 100).toFixed(0)}%`,
        `Tokens used:    ${m.totalTokensUsed?.toLocaleString() ?? 0}`,
        `Cost:           $${m.totalCostUsd?.toFixed(4) ?? "0.00"}`,
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
    return {
      content: [{ type: "text" as const, text: "No active swarm session. Start the orchestrator first." }],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: get_task_queue
// ---------------------------------------------------------------------------
server.tool(
  "get_task_queue",
  "List tasks by status (pending, running, complete, failed, or all)",
  { status: z.enum(["pending", "running", "complete", "failed", "all"]).optional() },
  async ({ status }) => {
    const tasksPath = path.join(STATE_DIR, "tasks.json");
    if (!fs.existsSync(tasksPath)) {
      return { content: [{ type: "text" as const, text: "No tasks found." }] };
    }
    const tasks = JSON.parse(fs.readFileSync(tasksPath, "utf-8")) as Array<{
      id: string;
      description: string;
      status: string;
      priority: number;
    }>;
    const filtered = status && status !== "all" ? tasks.filter((t) => t.status === status) : tasks;
    if (filtered.length === 0) {
      return { content: [{ type: "text" as const, text: `No ${status ?? ""} tasks.` }] };
    }
    const summary = filtered
      .slice(0, 20)
      .map((t) => `[${t.status}] (p${t.priority}) ${t.id}: ${t.description.slice(0, 80)}`)
      .join("\n");
    const footer = filtered.length > 20 ? `\n... and ${filtered.length - 20} more` : "";
    return { content: [{ type: "text" as const, text: summary + footer }] };
  },
);

// ---------------------------------------------------------------------------
// Tool: get_repo_health
// ---------------------------------------------------------------------------
server.tool(
  "get_repo_health",
  "Run tsc and npm test on a generated repo to check build health",
  { repoName: z.string().describe("Repo folder name inside generated-repos/, e.g. minecraft-browser") },
  async ({ repoName }) => {
    const repoPath = path.resolve("generated-repos", repoName);
    if (!fs.existsSync(repoPath)) {
      return { content: [{ type: "text" as const, text: `Repo not found: ${repoName}` }] };
    }
    const results: string[] = [];
    try {
      execSync("npx tsc --noEmit 2>&1", { cwd: repoPath, encoding: "utf-8", timeout: 60_000 });
      results.push("Build: PASS");
    } catch (e: unknown) {
      const err = e as { stdout?: string };
      results.push(`Build: FAIL\n${(err.stdout ?? "").slice(0, 2000)}`);
    }
    try {
      execSync("npm test 2>&1", { cwd: repoPath, encoding: "utf-8", timeout: 60_000 });
      results.push("Tests: PASS");
    } catch (e: unknown) {
      const err = e as { stdout?: string };
      results.push(`Tests: FAIL\n${(err.stdout ?? "").slice(0, 2000)}`);
    }
    return { content: [{ type: "text" as const, text: results.join("\n\n") }] };
  },
);

// ---------------------------------------------------------------------------
// Tool: list_generated_repos
// ---------------------------------------------------------------------------
server.tool(
  "list_generated_repos",
  "List all repos generated by the AgentSwarm",
  {},
  async () => {
    const reposDir = path.resolve("generated-repos");
    if (!fs.existsSync(reposDir)) {
      return { content: [{ type: "text" as const, text: "No generated-repos directory found." }] };
    }
    const entries = fs.readdirSync(reposDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    if (entries.length === 0) {
      return { content: [{ type: "text" as const, text: "No repos generated yet." }] };
    }
    const list = entries.map((d) => {
      const specPath = path.join(reposDir, d.name, "SPEC.md");
      const hasSpec = fs.existsSync(specPath) ? " (has SPEC.md)" : "";
      return `- ${d.name}${hasSpec}`;
    });
    return { content: [{ type: "text" as const, text: list.join("\n") }] };
  },
);

// ---------------------------------------------------------------------------
// Tool: read_spec
// ---------------------------------------------------------------------------
server.tool(
  "read_spec",
  "Read the SPEC.md for a generated repo",
  { repoName: z.string().describe("Name of the repo in generated-repos/") },
  async ({ repoName }) => {
    const specPath = path.resolve("generated-repos", repoName, "SPEC.md");
    if (!fs.existsSync(specPath)) {
      return { content: [{ type: "text" as const, text: `No SPEC.md found for ${repoName}` }] };
    }
    const content = fs.readFileSync(specPath, "utf-8");
    return { content: [{ type: "text" as const, text: content.slice(0, 8000) }] };
  },
);

// ---------------------------------------------------------------------------
// Tool: get_recent_commits
// ---------------------------------------------------------------------------
server.tool(
  "get_recent_commits",
  "Show recent git commits and active branches in the AgentSwarm repo",
  { count: z.number().optional().default(15) },
  async ({ count }) => {
    try {
      const log = execSync(`git log --oneline -${count}`, {
        cwd: REPO_ROOT,
        encoding: "utf-8",
      });
      const branches = execSync("git branch --list 'worker/*' 2>/dev/null || echo '(none)'", {
        cwd: REPO_ROOT,
        encoding: "utf-8",
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Recent commits:\n${log}\nWorker branches:\n${branches.trim()}`,
          },
        ],
      };
    } catch (e: unknown) {
      return { content: [{ type: "text" as const, text: `Git error: ${(e as Error).message}` }] };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: get_agent_roles
// ---------------------------------------------------------------------------
server.tool(
  "get_agent_roles",
  "Describe the 4 agent roles used in AgentSwarm: root-planner, subplanner, worker, reconciler",
  {},
  async () => {
    const roles = [
      "Root Planner: Decomposes the project spec into independent parallel tasks. Reads repo state and emits task arrays.",
      "Subplanner: Recursively breaks complex tasks into 2-10 smaller subtasks to increase parallelism.",
      "Worker: Receives a task, implements it in a sandboxed environment, runs tests, and commits to a branch.",
      "Reconciler: Periodic health-check agent. Runs tsc + npm test, creates priority-1 fix tasks if the build is broken.",
    ];
    return { content: [{ type: "text" as const, text: roles.join("\n\n") }] };
  },
);

// ---------------------------------------------------------------------------
// HTTP server with Streamable HTTP transport
// ---------------------------------------------------------------------------
const httpServer = createServer(async (req, res) => {
  if (req.url === "/mcp" && req.method === "POST") {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } else if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", name: "AgentSwarm Poke Server" }));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

// Bind to 0.0.0.0 on Railway/container environments, localhost otherwise
const HOST = process.env.RAILWAY_ENVIRONMENT ? "0.0.0.0" : "127.0.0.1";

httpServer.listen(PORT, HOST, async () => {
  console.log(`AgentSwarm Poke MCP server running on http://${HOST}:${PORT}/mcp`);
  console.log(`Health check: http://${HOST}:${PORT}/health`);
  console.log("");

  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    // --- Railway deployment ---
    console.log("Railway public URL:");
    console.log(`  https://${process.env.RAILWAY_PUBLIC_DOMAIN}/mcp`);
    console.log("");
    console.log("Connect to Poke:");
    console.log(`  npx poke mcp add https://${process.env.RAILWAY_PUBLIC_DOMAIN}/mcp --name "AgentSwarm"`);
  } else {
    // --- Local dev: detect ngrok tunnel ---
    try {
      const resp = await fetch("http://127.0.0.1:4040/api/tunnels");
      const data = (await resp.json()) as { tunnels: Array<{ public_url: string; config: { addr: string } }> };
      const tunnel = data.tunnels.find(
        (t) => t.config.addr.includes(String(PORT)) && t.public_url.startsWith("https"),
      );
      if (tunnel) {
        console.log("ngrok tunnel detected:");
        console.log(`  ${tunnel.public_url}/mcp`);
        console.log("");
        console.log("Connect to Poke:");
        console.log(`  npx poke mcp add ${tunnel.public_url}/mcp --name "AgentSwarm"`);
      } else {
        printLocalInstructions();
      }
    } catch {
      // ngrok not running — show manual instructions
      printLocalInstructions();
    }
  }
});

function printLocalInstructions(): void {
  console.log("To expose to Poke, run one of these in another terminal:");
  console.log("");
  console.log("  Option A (ngrok):");
  console.log(`    pnpm poke:ngrok`);
  console.log(`    Then: npx poke mcp add https://<your-ngrok-url>/mcp --name "AgentSwarm"`);
  console.log("");
  console.log("  Option B (poke tunnel):");
  console.log(`    pnpm poke:tunnel`);
}
