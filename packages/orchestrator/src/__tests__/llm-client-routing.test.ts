/**
 * Tests for LLMClient routing, health tracking, and latency-adaptive weighting.
 * Covers the gaps identified in issue #29:
 *   - Endpoint demotion after repeated failures
 *   - Recovery probe after RECOVERY_PROBE_MS
 *   - Deterministic weighted ordering when Math.random is controlled
 *   - Latency-adaptive effectiveWeight changes
 *
 * Uses node:test + node:assert/strict. No extra dependencies.
 * All network calls are intercepted via globalThis.fetch.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { LLMClient } from "../llm-client.js";

// ---------------------------------------------------------------------------
// Constants mirrored from llm-client.ts (kept in sync manually)
// ---------------------------------------------------------------------------
const UNHEALTHY_THRESHOLD = 3; // consecutive failures before demotion
const RECOVERY_PROBE_MS = 30_000; // ms before an unhealthy endpoint gets a probe

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
const originalRandom = Math.random;
const originalDateNow = Date.now;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Math.random = originalRandom;
  Date.now = originalDateNow;
});

/** A fetch stub that always succeeds with the given content string. */
function successFetch(content = "ok"): typeof fetch {
  return async () => {
    const body = JSON.stringify({
      choices: [{ message: { content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  };
}

/** A fetch stub that always returns an HTTP error. */
function _errorFetch(status = 500): typeof fetch {
  return async () => new Response("error", { status });
}

/** Build a two-endpoint client with controllable fetch. */
function makeTwoEndpointClient(timeoutMs = 1000): LLMClient {
  return new LLMClient({
    endpoints: [
      { name: "primary", endpoint: "https://primary.example.com", weight: 80 },
      { name: "secondary", endpoint: "https://secondary.example.com", weight: 20 },
    ],
    model: "test-model",
    maxTokens: 10,
    temperature: 0,
    timeoutMs,
  });
}

const MESSAGES = [{ role: "user" as const, content: "ping" }];

// ---------------------------------------------------------------------------
// Health tracking — endpoint demotion after repeated failures
// ---------------------------------------------------------------------------

describe("LLMClient — health tracking: endpoint demotion", () => {
  let client: LLMClient;

  beforeEach(() => {
    client = makeTwoEndpointClient();
  });

  it("endpoint stays healthy before UNHEALTHY_THRESHOLD failures", async () => {
    let callCount = 0;
    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("primary")) {
        callCount++;
        // Fail only the first two calls (below threshold)
        if (callCount < UNHEALTHY_THRESHOLD) {
          return new Response("err", { status: 500 });
        }
      }
      return successFetch()(input);
    };

    // Two failures on primary — still healthy, should succeed via secondary
    await client.complete(MESSAGES).catch(() => {});
    await client.complete(MESSAGES).catch(() => {});

    const stats = client.getEndpointStats();
    const primary = stats.find((s) => s.name === "primary");
    assert.ok(primary, "primary endpoint must exist in stats");
    assert.strictEqual(primary.healthy, true, "primary should still be healthy below threshold");
  });

  it(`marks endpoint unhealthy after ${UNHEALTHY_THRESHOLD} consecutive failures`, async () => {
    // Route all requests to primary first (Math.random = 0 picks highest-weight first)
    Math.random = () => 0;

    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("primary")) return new Response("err", { status: 500 });
      return successFetch()(input);
    };

    // Drive UNHEALTHY_THRESHOLD failures on primary
    for (let i = 0; i < UNHEALTHY_THRESHOLD; i++) {
      await client.complete(MESSAGES).catch(() => {});
    }

    const stats = client.getEndpointStats();
    const primary = stats.find((s) => s.name === "primary");
    assert.ok(primary);
    assert.strictEqual(
      primary.healthy,
      false,
      "primary must be marked unhealthy after threshold failures",
    );
    assert.ok(
      primary.totalFailures >= UNHEALTHY_THRESHOLD,
      "totalFailures must reflect recorded failures",
    );
  });

  it("resets consecutive failure count on a successful request", async () => {
    Math.random = () => 0;
    let callCount = 0;

    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("primary")) {
        callCount++;
        // Fail twice then succeed
        if (callCount <= 2) return new Response("err", { status: 500 });
      }
      return successFetch()(input);
    };

    // Two failures (below threshold)
    await client.complete(MESSAGES).catch(() => {});
    await client.complete(MESSAGES).catch(() => {});
    // One success on primary
    await client.complete(MESSAGES);

    const stats = client.getEndpointStats();
    const primary = stats.find((s) => s.name === "primary");
    assert.ok(primary);
    assert.strictEqual(primary.healthy, true, "primary should be healthy after a success");
  });

  it("demoted endpoint is tried last (after healthy endpoints)", async () => {
    Math.random = () => 0;
    const callOrder: string[] = [];

    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      const name = url.includes("primary") ? "primary" : "secondary";
      callOrder.push(name);

      if (url.includes("primary")) return new Response("err", { status: 500 });
      return successFetch()(input);
    };

    // Demote primary
    for (let i = 0; i < UNHEALTHY_THRESHOLD; i++) {
      await client.complete(MESSAGES).catch(() => {});
    }

    callOrder.length = 0; // reset tracking

    // Next call: secondary (healthy) should be tried before primary (unhealthy)
    await client.complete(MESSAGES);

    assert.strictEqual(
      callOrder[0],
      "secondary",
      "healthy secondary must be tried before demoted primary",
    );
  });
});

// ---------------------------------------------------------------------------
// Recovery probe after RECOVERY_PROBE_MS
// ---------------------------------------------------------------------------

describe("LLMClient — health tracking: recovery probe", () => {
  it("unhealthy endpoint is re-probed after RECOVERY_PROBE_MS and recovers on success", async () => {
    Math.random = () => 0;

    let now = Date.now();
    Date.now = () => now;

    const client = makeTwoEndpointClient();
    let primaryShouldFail = true;

    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("primary")) {
        if (primaryShouldFail) return new Response("err", { status: 500 });
      }
      return successFetch()(input);
    };

    // Demote primary
    for (let i = 0; i < UNHEALTHY_THRESHOLD; i++) {
      await client.complete(MESSAGES).catch(() => {});
    }

    const beforeRecovery = client.getEndpointStats().find((s) => s.name === "primary");
    assert.ok(beforeRecovery);
    assert.strictEqual(beforeRecovery.healthy, false, "primary should be unhealthy before probe");

    // Advance clock past RECOVERY_PROBE_MS
    now += RECOVERY_PROBE_MS + 1;
    primaryShouldFail = false;

    // Next selectEndpoints() call will mark primary healthy for probe
    const result = await client.complete(MESSAGES);

    const afterRecovery = client.getEndpointStats().find((s) => s.name === "primary");
    assert.ok(afterRecovery);
    assert.strictEqual(
      afterRecovery.healthy,
      true,
      "primary should be healthy after recovery probe",
    );
    assert.ok(result.content.length > 0, "request should succeed after recovery");
  });

  it("unhealthy endpoint is NOT probed before RECOVERY_PROBE_MS elapses", async () => {
    Math.random = () => 0;

    let now = Date.now();
    Date.now = () => now;

    const client = makeTwoEndpointClient();

    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("primary")) return new Response("err", { status: 500 });
      return successFetch()(input);
    };

    // Demote primary
    for (let i = 0; i < UNHEALTHY_THRESHOLD; i++) {
      await client.complete(MESSAGES).catch(() => {});
    }

    // Advance clock by less than RECOVERY_PROBE_MS
    now += RECOVERY_PROBE_MS - 1000;

    // Primary should still be unhealthy — secondary handles the request
    const result = await client.complete(MESSAGES);
    assert.strictEqual(result.endpoint, "secondary");

    const stats = client.getEndpointStats().find((s) => s.name === "primary");
    assert.ok(stats);
    assert.strictEqual(stats.healthy, false, "primary must still be unhealthy before probe window");
  });
});

// ---------------------------------------------------------------------------
// Weighted ordering — deterministic when Math.random is controlled
// ---------------------------------------------------------------------------

describe("LLMClient — weighted ordering (deterministic)", () => {
  it("higher-weight endpoint is selected first when random = 0.1", async () => {
    Math.random = () => 0.5; // pick=50 of 100 → skips light(10), lands on heavy(90)
    const callOrder: string[] = [];

    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      callOrder.push(url.includes("heavy") ? "heavy" : "light");
      return successFetch()(input);
    };

    const client = new LLMClient({
      endpoints: [
        { name: "light", endpoint: "https://light.example.com", weight: 10 },
        { name: "heavy", endpoint: "https://heavy.example.com", weight: 90 },
      ],
      model: "test-model",
      maxTokens: 10,
      temperature: 0,
      timeoutMs: 1000,
    });

    await client.complete(MESSAGES);
    assert.strictEqual(callOrder[0], "heavy", "heavy (weight=90) must be selected first");
  });

  it("lower-weight endpoint is selected first when random forces it", async () => {
    Math.random = () => 0; // pick=0 → immediately lands on first in array = light(10)
    const callOrder: string[] = [];

    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      callOrder.push(url.includes("heavy") ? "heavy" : "light");
      return successFetch()(input);
    };

    const client = new LLMClient({
      endpoints: [
        { name: "light", endpoint: "https://light.example.com", weight: 10 },
        { name: "heavy", endpoint: "https://heavy.example.com", weight: 90 },
      ],
      model: "test-model",
      maxTokens: 10,
      temperature: 0,
      timeoutMs: 1000,
    });

    await client.complete(MESSAGES);
    assert.strictEqual(callOrder[0], "light", "light must be selected first when random is high");
  });

  it("equal-weight endpoints: random=0 picks the first in declaration order", async () => {
    Math.random = () => 0;
    const callOrder: string[] = [];

    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      callOrder.push(url.includes("alpha") ? "alpha" : "beta");
      return successFetch()(input);
    };

    const client = new LLMClient({
      endpoints: [
        { name: "alpha", endpoint: "https://alpha.example.com", weight: 50 },
        { name: "beta", endpoint: "https://beta.example.com", weight: 50 },
      ],
      model: "test-model",
      maxTokens: 10,
      temperature: 0,
      timeoutMs: 1000,
    });

    await client.complete(MESSAGES);
    assert.strictEqual(
      callOrder[0],
      "alpha",
      "alpha must be tried first when weights are equal and random=0",
    );
  });

  it("getEndpointStats reflects effectiveWeight matches base weight before any latency data", () => {
    const client = new LLMClient({
      endpoints: [
        { name: "a", endpoint: "https://a.example.com", weight: 60 },
        { name: "b", endpoint: "https://b.example.com", weight: 40 },
      ],
      model: "test-model",
      maxTokens: 10,
      temperature: 0,
    });

    const stats = client.getEndpointStats();
    const a = stats.find((s) => s.name === "a");
    const b = stats.find((s) => s.name === "b");
    assert.ok(a);
    assert.ok(b);
    // Before any requests, effectiveWeight equals base weight
    assert.strictEqual(a.effectiveWeight, 60);
    assert.strictEqual(b.effectiveWeight, 40);
  });
});

// ---------------------------------------------------------------------------
// Latency-adaptive weighting — effectiveWeight changes after requests
// ---------------------------------------------------------------------------

describe("LLMClient — latency-adaptive weighting", () => {
  it("faster endpoint gets a higher effectiveWeight than the slower one", async () => {
    Math.random = () => 0;

    const _callIndex = 0;
    const latencies = [100, 500]; // primary fast, secondary slow

    globalThis.fetch = async (input, _init) => {
      const url = typeof input === "string" ? input : input.toString();
      const delay = url.includes("primary") ? latencies[0]! : latencies[1]!;
      await new Promise((r) => setTimeout(r, delay));
      return successFetch()(input);
    };

    const client = new LLMClient({
      endpoints: [
        { name: "primary", endpoint: "https://primary.example.com", weight: 50 },
        { name: "secondary", endpoint: "https://secondary.example.com", weight: 50 },
      ],
      model: "test-model",
      maxTokens: 10,
      temperature: 0,
      timeoutMs: 5000,
    });

    // Seed latency data: one success on each endpoint
    Math.random = () => 0;
    await client.complete(MESSAGES); // hits primary (fast)

    Math.random = () => 0.9999;
    await client.complete(MESSAGES); // hits secondary (slow)

    const stats = client.getEndpointStats();
    const primary = stats.find((s) => s.name === "primary");
    const secondary = stats.find((s) => s.name === "secondary");
    assert.ok(primary);
    assert.ok(secondary);

    assert.ok(
      primary.effectiveWeight > secondary.effectiveWeight,
      `faster primary (${primary.effectiveWeight}) should have higher effectiveWeight than slower secondary (${secondary.effectiveWeight})`,
    );
  });

  it("endpoint with no latency data keeps effectiveWeight equal to base weight", async () => {
    Math.random = () => 0;

    globalThis.fetch = successFetch();

    const client = new LLMClient({
      endpoints: [{ name: "only", endpoint: "https://only.example.com", weight: 75 }],
      model: "test-model",
      maxTokens: 10,
      temperature: 0,
      timeoutMs: 1000,
    });

    await client.complete(MESSAGES);

    const stats = client.getEndpointStats();
    const only = stats.find((s) => s.name === "only");
    assert.ok(only);
    // Single endpoint — rebalanceWeights skips when healthyWithLatency.length < 2
    assert.strictEqual(
      only.effectiveWeight,
      75,
      "single endpoint effectiveWeight must stay at base weight",
    );
  });

  it("avgLatencyMs is updated via EMA after successful requests", async () => {
    Math.random = () => 0;
    const ALPHA = 0.3;
    const FIRST_LATENCY = 200;
    const SECOND_LATENCY = 600;

    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      const delay = callCount === 1 ? FIRST_LATENCY : SECOND_LATENCY;
      await new Promise((r) => setTimeout(r, delay));
      return successFetch()(String(callCount));
    };

    const client = new LLMClient({
      endpoint: "https://llm.example.com",
      model: "test-model",
      maxTokens: 10,
      temperature: 0,
      timeoutMs: 5000,
    });

    await client.complete(MESSAGES); // sets avgLatency = FIRST_LATENCY (first call)
    await client.complete(MESSAGES); // EMA update

    const stats = client.getEndpointStats();
    const ep = stats[0];
    assert.ok(ep);

    // EMA after two calls: first sets avgLatency = FIRST_LATENCY, then:
    // avgLatency = ALPHA * SECOND_LATENCY + (1 - ALPHA) * FIRST_LATENCY
    const expectedEMA = ALPHA * SECOND_LATENCY + (1 - ALPHA) * FIRST_LATENCY;

    // Allow ±50ms tolerance for timing variance in CI
    assert.ok(
      Math.abs(ep.avgLatencyMs - expectedEMA) < 50,
      `avgLatencyMs (${ep.avgLatencyMs}) should be close to EMA (${Math.round(expectedEMA)}) ±50ms`,
    );
  });
});
