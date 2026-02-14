import type { HarnessConfig, LLMEndpoint } from "@agentswarm/core";

export interface OrchestratorConfig extends HarnessConfig {
  targetRepoPath: string;
  pythonPath: string;
  healthCheckInterval: number;
}

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
    "Missing required env: LLM_ENDPOINTS (JSON array) or LLM_BASE_URL (single endpoint)"
  );
}

let cachedConfig: OrchestratorConfig | null = null;

export function loadConfig(): OrchestratorConfig {
  const endpoints = parseEndpoints();

  const gitRepoUrl = process.env.GIT_REPO_URL;
  if (!gitRepoUrl) {
    throw new Error("Missing required env: GIT_REPO_URL");
  }

  const mergeStrategy = process.env.MERGE_STRATEGY || "fast-forward";
  if (!ALLOWED_MERGE_STRATEGIES.includes(mergeStrategy as typeof ALLOWED_MERGE_STRATEGIES[number])) {
    throw new Error(
      `Invalid mergeStrategy: ${mergeStrategy}. Must be one of: ${ALLOWED_MERGE_STRATEGIES.join(", ")}`
    );
  }

  cachedConfig = {
    maxWorkers: Number(process.env.MAX_WORKERS) || 4,
    workerTimeout: Number(process.env.WORKER_TIMEOUT) || 1800,
    mergeStrategy: mergeStrategy as "fast-forward" | "rebase" | "merge-commit",
    llm: {
      endpoints,
      model: process.env.LLM_MODEL || "glm-5",
      maxTokens: Number(process.env.LLM_MAX_TOKENS) || 8192,
      temperature: Number(process.env.LLM_TEMPERATURE) || 0.7,
    },
    git: {
      repoUrl: gitRepoUrl,
      mainBranch: process.env.GIT_MAIN_BRANCH || "main",
      branchPrefix: process.env.GIT_BRANCH_PREFIX || "worker/",
    },
    sandbox: {
      imageTag: process.env.SANDBOX_IMAGE_TAG || "latest",
      cpuCores: Number(process.env.SANDBOX_CPU_CORES) || 4,
      memoryMb: Number(process.env.SANDBOX_MEMORY_MB) || 8192,
      idleTimeout: Number(process.env.SANDBOX_IDLE_TIMEOUT) || 300,
    },
    targetRepoPath: process.env.TARGET_REPO_PATH || "./target-repo",
    pythonPath: process.env.PYTHON_PATH || "python3",
    healthCheckInterval: Number(process.env.HEALTH_CHECK_INTERVAL) || 10,
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
