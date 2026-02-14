import { createLogger, type LLMEndpoint } from "@agentswarm/core";

const logger = createLogger("llm-client", "root-planner");

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResponse {
  content: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  endpoint: string;
  latencyMs: number;
}

/** @deprecated Use LLMEndpoint from @agentswarm/core directly */
export type LLMEndpointConfig = LLMEndpoint;

export interface LLMClientConfig {
  endpoints: LLMEndpoint[];
  model: string;
  maxTokens: number;
  temperature: number;
  timeoutMs?: number;
}

export interface LLMClientSingleConfig {
  endpoint: string;
  model: string;
  maxTokens: number;
  temperature: number;
  apiKey?: string;
  timeoutMs?: number;
}

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface EndpointState {
  config: LLMEndpoint;
  effectiveWeight: number;
  avgLatencyMs: number;
  totalRequests: number;
  totalFailures: number;
  consecutiveFailures: number;
  lastFailureAt: number;
  healthy: boolean;
}

// EMA smoothing: 0.3 = responsive to recent latency shifts
const LATENCY_ALPHA = 0.3;
const UNHEALTHY_THRESHOLD = 3;
const RECOVERY_PROBE_MS = 30_000;

export class LLMClient {
  private config: LLMClientConfig;
  private states: EndpointState[];
  private requestCounter: number = 0;

  constructor(config: LLMClientConfig | LLMClientSingleConfig) {
    if ("endpoint" in config && !("endpoints" in config)) {
      this.config = {
        endpoints: [
          {
            name: "default",
            endpoint: config.endpoint,
            apiKey: config.apiKey,
            weight: 100,
          },
        ],
        model: config.model,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        timeoutMs: config.timeoutMs,
      };
    } else {
      this.config = config as LLMClientConfig;
    }

    if (this.config.endpoints.length === 0) {
      throw new Error("LLMClient requires at least one endpoint");
    }

    this.states = this.config.endpoints.map((ep) => ({
      config: ep,
      effectiveWeight: ep.weight,
      avgLatencyMs: 0,
      totalRequests: 0,
      totalFailures: 0,
      consecutiveFailures: 0,
      lastFailureAt: 0,
      healthy: true,
    }));

    const names = this.config.endpoints.map((e) => `${e.name}(w=${e.weight})`).join(", ");
    logger.info(`LLMClient initialized with ${this.config.endpoints.length} endpoint(s): ${names}`);
  }

  async complete(
    messages: LLMMessage[],
    overrides?: Partial<Pick<LLMClientConfig, "model" | "temperature" | "maxTokens">>
  ): Promise<LLMResponse> {
    const orderedEndpoints = this.selectEndpoints();
    let lastError: Error | null = null;

    for (const state of orderedEndpoints) {
      try {
        return await this.sendRequest(state, messages, overrides);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.recordFailure(state, lastError);

        if (orderedEndpoints.indexOf(state) < orderedEndpoints.length - 1) {
          logger.warn(`Endpoint ${state.config.name} failed, trying next`, {
            error: lastError.message,
            endpoint: state.config.name,
          });
        }
      }
    }

    throw new Error(
      `All ${this.config.endpoints.length} LLM endpoints failed. Last error: ${lastError?.message}`
    );
  }

  private selectEndpoints(): EndpointState[] {
    const now = Date.now();

    for (const state of this.states) {
      if (!state.healthy && now - state.lastFailureAt > RECOVERY_PROBE_MS) {
        state.healthy = true;
        state.consecutiveFailures = 0;
        logger.info(`Endpoint ${state.config.name} marked healthy for recovery probe`);
      }
    }

    const healthy = this.states.filter((s) => s.healthy);
    const unhealthy = this.states.filter((s) => !s.healthy);

    return [...this.weightedSort(healthy), ...unhealthy];
  }

  private weightedSort(states: EndpointState[]): EndpointState[] {
    if (states.length <= 1) return [...states];

    if (states.every((s) => s.effectiveWeight === 0)) return [...states];

    const result: EndpointState[] = [];
    const remaining = [...states];

    while (remaining.length > 0) {
      const remainingWeight = remaining.reduce((sum, s) => sum + s.effectiveWeight, 0);
      let pick = Math.random() * remainingWeight;

      let selectedIdx = 0;
      for (let i = 0; i < remaining.length; i++) {
        pick -= remaining[i].effectiveWeight;
        if (pick <= 0) {
          selectedIdx = i;
          break;
        }
      }

      result.push(remaining[selectedIdx]);
      remaining.splice(selectedIdx, 1);
    }

    return result;
  }

  private async sendRequest(
    state: EndpointState,
    messages: LLMMessage[],
    overrides?: Partial<Pick<LLMClientConfig, "model" | "temperature" | "maxTokens">>
  ): Promise<LLMResponse> {
    const startMs = Date.now();
    state.totalRequests++;
    this.requestCounter++;

    const url = `${state.config.endpoint}/v1/chat/completions`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(state.config.apiKey ? { Authorization: `Bearer ${state.config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: overrides?.model ?? this.config.model,
        messages,
        temperature: overrides?.temperature ?? this.config.temperature,
        max_tokens: overrides?.maxTokens ?? this.config.maxTokens,
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 120_000),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LLM request failed (${response.status}) from ${state.config.name}: ${body}`);
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const latencyMs = Date.now() - startMs;

    this.recordSuccess(state, latencyMs);

    return {
      content: data.choices[0].message.content,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
      endpoint: state.config.name,
      latencyMs,
    };
  }

  private recordSuccess(state: EndpointState, latencyMs: number): void {
    state.consecutiveFailures = 0;
    state.healthy = true;

    if (state.avgLatencyMs === 0) {
      state.avgLatencyMs = latencyMs;
    } else {
      state.avgLatencyMs = LATENCY_ALPHA * latencyMs + (1 - LATENCY_ALPHA) * state.avgLatencyMs;
    }

    this.rebalanceWeights();
  }

  private recordFailure(state: EndpointState, error: Error): void {
    state.totalFailures++;
    state.consecutiveFailures++;
    state.lastFailureAt = Date.now();

    if (state.consecutiveFailures >= UNHEALTHY_THRESHOLD) {
      state.healthy = false;
      logger.warn(`Endpoint ${state.config.name} marked unhealthy after ${state.consecutiveFailures} consecutive failures`, {
        lastError: error.message,
      });
    }
  }

  /**
   * Latency-adaptive weight rebalancing.
   * Faster endpoints get up to 2x their base weight; endpoints 2x slower get 0.5x.
   */
  private rebalanceWeights(): void {
    const healthyWithLatency = this.states.filter((s) => s.healthy && s.avgLatencyMs > 0);
    if (healthyWithLatency.length < 2) return;

    const minLatency = Math.min(...healthyWithLatency.map((s) => s.avgLatencyMs));

    for (const state of healthyWithLatency) {
      const latencyRatio = state.avgLatencyMs / minLatency;
      const latencyScale = Math.max(0.5, 1.0 / latencyRatio);
      state.effectiveWeight = state.config.weight * latencyScale;
    }
  }

  getEndpointStats(): Array<{
    name: string;
    endpoint: string;
    healthy: boolean;
    effectiveWeight: number;
    avgLatencyMs: number;
    totalRequests: number;
    totalFailures: number;
  }> {
    return this.states.map((s) => ({
      name: s.config.name,
      endpoint: s.config.endpoint,
      healthy: s.healthy,
      effectiveWeight: Math.round(s.effectiveWeight * 10) / 10,
      avgLatencyMs: Math.round(s.avgLatencyMs),
      totalRequests: s.totalRequests,
      totalFailures: s.totalFailures,
    }));
  }

  get totalRequests(): number {
    return this.requestCounter;
  }
}
