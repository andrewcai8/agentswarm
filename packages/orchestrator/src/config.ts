/** @module Environment-driven configuration loader with typed defaults and validation */

import type { HarnessConfig, LLMEndpoint } from "@longshot/core";

export interface FinalizationConfig {
  maxAttempts: number;
  enabled: boolean;
  sweepTimeoutMs: number;
}

export interface OrchestratorConfig extends HarnessConfig {
  targetRepoPath: string;
  pythonPath: string;
  healthCheckInterval: number;
  /** Max ms to wait for LLM endpoints to become ready at startup. 0 = skip probe. */
  readinessTimeoutMs: number;
  finalization: FinalizationConfig;
}

/** Named type for the LLM configuration block (extracted from HarnessConfig). */
export type LLMConfig = OrchestratorConfig["llm"];

const ALLOWED_MERGE_STRATEGIES = ["fast-forward", "rebase", "merge-commit"] as const;

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function parseEndpoints(): LLMEndpoint[] {
  const endpoints: LLMEndpoint[] = [];

  // LLM_ENDPOINTS: JSON array format — [{name, endpoint, apiKey?, weight}]
  const endpointsJson = process.env.LLM_ENDPOINTS;
  if (endpointsJson) {
    const parsed = JSON.parse(endpointsJson) as Array<{
      name: string;
      endpoint: string;
      apiKey?: string;
      weight: number;
    }>;
    for (const ep of parsed) {
      endpoints.push({
        name: ep.name,
        endpoint: normalizeUrl(ep.endpoint),
        apiKey: ep.apiKey,
        weight: ep.weight,
      });
    }
    return endpoints;
  }

  // Fallback: LLM_BASE_URL (single endpoint, backwards compatible)
  const llmBaseUrl = process.env.LLM_BASE_URL;
  if (llmBaseUrl) {
    endpoints.push({
      name: "default",
      endpoint: normalizeUrl(llmBaseUrl),
      apiKey: process.env.LLM_API_KEY || undefined,
      weight: 100,
    });
    return endpoints;
  }

  throw new Error(
    "Missing required env: LLM_ENDPOINTS (JSON array) or LLM_BASE_URL (single endpoint)",
  );
}

let cachedConfig: OrchestratorConfig | null = null;

export function loadConfig(): OrchestratorConfig {
  const endpoints = parseEndpoints();

  const gitRepoUrl = process.env.GIT_REPO_URL;
  if (!gitRepoUrl) {
    throw new Error("Missing required env: GIT_REPO_URL");
  }

  const mergeStrategy = process.env.MERGE_STRATEGY || "rebase";
  if (
    !ALLOWED_MERGE_STRATEGIES.includes(mergeStrategy as (typeof ALLOWED_MERGE_STRATEGIES)[number])
  ) {
    throw new Error(
      `Invalid mergeStrategy: ${mergeStrategy}. Must be one of: ${ALLOWED_MERGE_STRATEGIES.join(", ")}`,
    );
  }

  cachedConfig = {
    maxWorkers: ((v) => (Number.isFinite(v) ? v : 50))(Number(process.env.MAX_WORKERS)),
    workerTimeout: ((v) => (Number.isFinite(v) ? v : 1800))(Number(process.env.WORKER_TIMEOUT)),
    mergeStrategy: mergeStrategy as "fast-forward" | "rebase" | "merge-commit",
    llm: {
      endpoints,
      model: process.env.LLM_MODEL || "glm-5",
      maxTokens: ((v) => (Number.isFinite(v) ? v : 65536))(Number(process.env.LLM_MAX_TOKENS)),
      temperature: ((v) => (Number.isFinite(v) ? v : 0.7))(Number(process.env.LLM_TEMPERATURE)),
      timeoutMs: process.env.LLM_TIMEOUT_MS ? Number(process.env.LLM_TIMEOUT_MS) : undefined,
    },
    git: {
      repoUrl: gitRepoUrl,
      mainBranch: process.env.GIT_MAIN_BRANCH || "main",
      branchPrefix: process.env.GIT_BRANCH_PREFIX || "worker/",
    },
    sandbox: {
      imageTag: process.env.SANDBOX_IMAGE_TAG || "latest",
      cpuCores: ((v) => (Number.isFinite(v) ? v : 4))(Number(process.env.SANDBOX_CPU_CORES)),
      memoryMb: ((v) => (Number.isFinite(v) ? v : 8192))(Number(process.env.SANDBOX_MEMORY_MB)),
      idleTimeout: ((v) => (Number.isFinite(v) ? v : 300))(
        Number(process.env.SANDBOX_IDLE_TIMEOUT),
      ),
    },
    targetRepoPath: process.env.TARGET_REPO_PATH || "./target-repo",
    pythonPath: process.env.PYTHON_PATH || "python3",
    healthCheckInterval: ((v) => (Number.isFinite(v) ? v : 10))(
      Number(process.env.HEALTH_CHECK_INTERVAL),
    ),
    readinessTimeoutMs: process.env.LLM_READINESS_TIMEOUT_MS
      ? Number(process.env.LLM_READINESS_TIMEOUT_MS)
      : 120_000,
    finalization: {
      maxAttempts: ((v) => (Number.isFinite(v) ? v : 3))(
        Number(process.env.FINALIZATION_MAX_ATTEMPTS),
      ),
      enabled: process.env.FINALIZATION_ENABLED !== "false",
      sweepTimeoutMs: ((v) => (Number.isFinite(v) ? v : 120_000))(
        Number(process.env.FINALIZATION_SWEEP_TIMEOUT_MS),
      ),
    },
  };

  return cachedConfig;
}

export function getConfig(): OrchestratorConfig {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}

export function resetConfig(): void {
  cachedConfig = null;
}
