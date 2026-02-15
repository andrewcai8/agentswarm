/**
 * Poke integration for AgentSwarm
 *
 * All Poke-related files live in this directory:
 *
 *   poke/
 *     server.ts        — MCP server exposing swarm tools to Poke
 *     notifier.ts      — Push alerts to your phone via Poke SDK
 *     state-writer.ts  — Writes metrics/tasks JSON for the MCP server
 *     Dockerfile       — Railway/container deployment
 *     index.ts         — This barrel file
 *
 * Local dev with ngrok (recommended):
 *   1. npx poke login
 *   2. pnpm poke:dev                 (terminal 1 — start MCP server)
 *   3. pnpm poke:ngrok               (terminal 2 — expose via ngrok)
 *   4. npx poke mcp add https://<ngrok-url>/mcp --name "AgentSwarm"
 *
 * Local dev with poke tunnel:
 *   1. npx poke login
 *   2. pnpm poke:dev                 (terminal 1)
 *   3. pnpm poke:tunnel              (terminal 2)
 *
 * Railway deployment:
 *   - Use poke/Dockerfile, Railway provides PORT automatically
 *   - npx poke mcp add https://<railway-domain>/mcp --name "AgentSwarm"
 *   - No API key needed between Railway and Poke
 */

export { PokeNotifier, createPokeNotifier } from "./notifier.js";
export type { PokeNotifierConfig } from "./notifier.js";
export { PokeStateWriter } from "./state-writer.js";
