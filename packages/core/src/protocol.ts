/** @module Wire protocol message types for orchestrator-sandbox communication */

import type { Handoff, SandboxStatus, Task, TaskStatus } from "./types.js";

// Request: orchestrator → sandbox worker
export interface TaskAssignment {
  type: "task_assignment";
  task: Task;
  systemPrompt: string;
  repoSnapshot: string;
  llmConfig: {
    endpoint: string;
    model: string;
    maxTokens: number;
    temperature: number;
  };
}

// Response: sandbox → orchestrator
export interface TaskResult {
  type: "task_result";
  handoff: Handoff;
}

// Progress update: sandbox → orchestrator (periodic)
export interface ProgressUpdate {
  type: "progress_update";
  taskId: string;
  sandboxId: string;
  status: SandboxStatus["status"];
  progress: string;
  currentFile?: string;
  toolCallsSoFar: number;
  tokensSoFar: number;
}

// Health check response
export interface HealthResponse {
  type: "health";
  sandboxId: string;
  status: "healthy" | "unhealthy";
  uptime: number;
  memoryUsageMb: number;
  taskId?: string;
  taskStatus?: TaskStatus;
}

// All message types
export type OrchestratorMessage = TaskAssignment;
export type SandboxMessage = TaskResult | ProgressUpdate | HealthResponse;
export type ProtocolMessage = OrchestratorMessage | SandboxMessage;
