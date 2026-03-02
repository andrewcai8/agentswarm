/** @module Shared domain types for the Longshot multi-agent system */

// Task status
export type TaskStatus = "pending" | "assigned" | "running" | "complete" | "failed" | "cancelled";

// Agent roles
export type AgentRole = "root-planner" | "subplanner" | "worker" | "reconciler";

// A task assigned by a planner to a worker
export interface Task {
  id: string; // Unique task ID (uuid)
  parentId?: string; // Parent task ID (if subtask)
  description: string; // What to do (natural language)
  scope: string[]; // File paths the worker should focus on
  acceptance: string; // How to know when done (natural language)
  branch: string; // Git branch name for this task
  status: TaskStatus;
  assignedTo?: string; // Sandbox ID
  createdAt: number; // Unix timestamp ms
  startedAt?: number;
  completedAt?: number;
  priority: number; // 1 (highest) to 10 (lowest)
  conflictSourceBranch?: string; // Original branch that conflicted (for conflict-fix tasks)
  retryCount?: number; // How many times this task has been retried (0 = first attempt)
}

// Handoff report from worker back to planner
export interface Handoff {
  taskId: string;
  status: "complete" | "partial" | "blocked" | "failed";
  summary: string; // What was done
  diff: string; // Git diff output
  filesChanged: string[]; // List of changed file paths
  concerns: string[]; // Issues discovered
  suggestions: string[]; // Recommendations for planner
  metrics: {
    linesAdded: number;
    linesRemoved: number;
    filesCreated: number;
    filesModified: number;
    tokensUsed: number;
    toolCallCount: number;
    durationMs: number;
  };
  /** tsc --noEmit exit code from post-agent build check. null = check did not run. */
  buildExitCode?: number | null;
}

// Worker sandbox status
export interface SandboxStatus {
  sandboxId: string;
  status: "starting" | "ready" | "working" | "completing" | "terminated" | "error";
  taskId?: string;
  progress?: string; // Current activity description
  healthCheck: {
    lastPing: number; // Unix timestamp ms
    consecutiveFailures: number;
  };
  url?: string; // Tunnel URL for HTTP access
}

export interface LLMEndpoint {
  name: string;
  endpoint: string;
  apiKey?: string;
  weight: number;
}

export interface HarnessConfig {
  maxWorkers: number;
  workerTimeout: number;
  mergeStrategy: "fast-forward" | "rebase" | "merge-commit";
  llm: {
    endpoints: LLMEndpoint[];
    model: string;
    maxTokens: number;
    temperature: number;
    timeoutMs?: number;
  };
  git: {
    repoUrl: string;
    mainBranch: string;
    branchPrefix: string;
  };
  sandbox: {
    imageTag: string;
    cpuCores: number;
    memoryMb: number;
    idleTimeout: number;
  };
}

// Structured log entry
export interface LogEntry {
  timestamp: number;
  level: "debug" | "info" | "warn" | "error";
  agentId: string;
  agentRole: AgentRole;
  taskId?: string;
  message: string;
  data?: Record<string, unknown>;
}

// Metrics snapshot
export interface MetricsSnapshot {
  timestamp: number;
  activeWorkers: number;
  pendingTasks: number;
  runningTasks: number;
  completedTasks: number;
  failedTasks: number;
  suspiciousTaskCount: number;
  commitsPerHour: number;
  mergeSuccessRate: number;
  totalTokensUsed: number;
  totalCostUsd: number;
  activeToolCalls: number;
  estimatedInFlightTokens: number;

  // Finalization phase metrics (populated only after finalization runs)
  finalizationAttempts?: number;
  finalizationBuildPassed?: boolean;
  finalizationTestsPassed?: boolean;
  finalizationAllMerged?: boolean;
  finalizationUnmergedCount?: number;
  finalizationDurationMs?: number;
}
