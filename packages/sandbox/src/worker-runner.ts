import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import type { Task, Handoff } from "@agentswarm/core";
import {
  AuthStorage,
  createAgentSession,
  codingTools,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";

const TASK_PATH = "/workspace/task.json";
const RESULT_PATH = "/workspace/result.json";
const WORK_DIR = "/workspace/repo";

interface TaskPayload {
  task: Task;
  systemPrompt: string;
  llmConfig: {
    endpoint: string;
    model: string;
    maxTokens: number;
    temperature: number;
    apiKey?: string;
  };
  repoUrl?: string;
}

function log(msg: string): void {
  process.stderr.write(`[worker] ${msg}\n`);
}

function safeExec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", timeout: 30_000 }).trim();
  } catch {
    return "";
  }
}

function writeResult(handoff: Handoff): void {
  writeFileSync(RESULT_PATH, JSON.stringify(handoff, null, 2), "utf-8");
  log(`Result written to ${RESULT_PATH}`);
}

export function buildTaskPrompt(task: Task, systemPrompt?: string): string {
  const parts: string[] = [];

  if (systemPrompt) {
    parts.push(
      "<system_instructions>",
      systemPrompt,
      "</system_instructions>",
      "",
    );
  }

  parts.push(
    `## Task: ${task.id}`,
    `**Description:** ${task.description}`,
    `**Scope (files to focus on):** ${task.scope.join(", ")}`,
    `**Acceptance criteria:** ${task.acceptance}`,
    `**Branch:** ${task.branch}`,
    "",
    "Complete this task. Commit your changes when done. Stay focused on the scoped files.",
  );

  return parts.join("\n");
}

export async function runWorker(): Promise<void> {
  const startTime = Date.now();

  log("Reading task payload...");
  const raw = readFileSync(TASK_PATH, "utf-8");
  const payload: TaskPayload = JSON.parse(raw);
  const { task, systemPrompt, llmConfig } = payload;
  log(`Task: ${task.id} — ${task.description.slice(0, 80)}`);

  const authStorage = new AuthStorage();
  const modelRegistry = new ModelRegistry(authStorage);
  modelRegistry.registerProvider("glm5", {
    baseUrl: llmConfig.endpoint,
    apiKey: llmConfig.apiKey || "no-key-needed", // Pi SDK requires a non-empty string
    api: "openai-completions",
    models: [{
      id: llmConfig.model,
      name: llmConfig.model,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072,
      maxTokens: llmConfig.maxTokens,
      compat: {
        maxTokensField: "max_tokens",
        supportsUsageInStreaming: false,
      },
    }],
  });

  const model = modelRegistry.find("glm5", llmConfig.model);
  if (!model) {
    throw new Error(`Model "${llmConfig.model}" not found in registry after registration`);
  }
  log(`Model registered: ${llmConfig.model} via ${llmConfig.endpoint}`);

  const startSha = safeExec("git rev-parse HEAD", WORK_DIR);
  log("Creating agent session...");
  const { session } = await createAgentSession({
    cwd: WORK_DIR,
    model,
    tools: codingTools,
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
    thinkingLevel: "off",
  });

  let toolCallCount = 0;
  let lastAssistantMessage = "";

  session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      toolCallCount++;
      if (toolCallCount % 5 === 0) {
        log(`Tool calls: ${toolCallCount}`);
      }
    }
    if (event.type === "message_end" && "message" in event) {
      const msg = event.message;
      if (msg && typeof msg === "object" && "role" in msg && msg.role === "assistant") {
        const content = "content" in msg ? msg.content : undefined;
        if (Array.isArray(content)) {
          const textParts: string[] = [];
          for (const part of content) {
            if (
              typeof part === "object" &&
              part !== null &&
              "type" in part &&
              part.type === "text" &&
              "text" in part &&
              typeof part.text === "string"
            ) {
              textParts.push(part.text);
            }
          }
          if (textParts.length > 0) {
            lastAssistantMessage = textParts.join("\n");
          }
        }
      }
    }
  });

  const prompt = buildTaskPrompt(task, systemPrompt);
  log("Running agent prompt...");
  await session.prompt(prompt);
  log("Agent prompt completed.");

  const stats = session.getSessionStats();
  const tokensUsed = stats.tokens.total;

  session.dispose();

  log("Extracting git diff stats...");
  const diff = safeExec(`git diff ${startSha} --no-color`, WORK_DIR);
  const numstat = safeExec(`git diff ${startSha} --numstat`, WORK_DIR);
  const filesCreatedRaw = safeExec(`git diff ${startSha} --diff-filter=A --name-only`, WORK_DIR);
  const filesChangedRaw = safeExec(`git diff ${startSha} --name-only`, WORK_DIR);

  const filesChanged = filesChangedRaw ? filesChangedRaw.split("\n").filter(Boolean) : [];
  const filesCreated = filesCreatedRaw ? filesCreatedRaw.split("\n").filter(Boolean) : [];

  let linesAdded = 0;
  let linesRemoved = 0;
  if (numstat) {
    for (const line of numstat.split("\n")) {
      const parts = line.split("\t");
      if (parts.length >= 2) {
        const added = parseInt(parts[0], 10);
        const removed = parseInt(parts[1], 10);
        if (!isNaN(added)) linesAdded += added;
        if (!isNaN(removed)) linesRemoved += removed;
      }
    }
  }

  const filesModified = filesChanged.length - filesCreated.length;

  const handoff: Handoff = {
    taskId: task.id,
    status: "complete",
    summary: lastAssistantMessage || "Task completed (no final message captured).",
    diff,
    filesChanged,
    concerns: [],
    suggestions: [],
    metrics: {
      linesAdded,
      linesRemoved,
      filesCreated: filesCreated.length,
      filesModified: Math.max(0, filesModified),
      tokensUsed,
      toolCallCount,
      durationMs: Date.now() - startTime,
    },
  };

  writeResult(handoff);
  log(`Done. Duration: ${handoff.metrics.durationMs}ms, Tools: ${toolCallCount}, Tokens: ${tokensUsed}`);
}

function readTaskIdSafe(): string {
  try {
    const raw = readFileSync(TASK_PATH, "utf-8");
    const payload = JSON.parse(raw) as { task?: { id?: string } };
    return payload.task?.id ?? "unknown";
  } catch {
    return "unknown";
  }
}

runWorker().catch((err: unknown) => {
  const errorMessage = err instanceof Error ? err.message : String(err);
  const errorStack = err instanceof Error ? err.stack : undefined;
  log(`FATAL: ${errorMessage}`);
  if (errorStack) {
    log(errorStack);
  }

  const taskId = readTaskIdSafe();
  const failureHandoff: Handoff = {
    taskId,
    status: "failed",
    summary: `Worker crashed: ${errorMessage}`,
    diff: "",
    filesChanged: [],
    concerns: [errorMessage],
    suggestions: ["Check worker logs for stack trace"],
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

  writeResult(failureHandoff);
  process.exit(1);
});
