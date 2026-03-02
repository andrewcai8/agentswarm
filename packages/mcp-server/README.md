# @longshot/mcp-server

MCP HTTP server exposing orchestrator control to external tools (Claude, Cursor, any MCP-compatible client).

## Purpose

This package wraps the Longshot orchestrator (`main.py`) in an [MCP](https://modelcontextprotocol.io) server, letting AI assistants launch, monitor, and stop coding runs without touching the CLI directly.

## Architecture

The server (`src/index.ts`, ~590 lines) contains two subsystems:

### 1. Subprocess Management

Spawns `python3 main.py --reset <request>` as a child process and tracks its lifecycle:

- `processState`: `idle` | `starting` | `running` | `stopping`
- Graceful shutdown: SIGTERM → 30-second timeout → SIGKILL
- stdout/stderr from `main.py` are stripped of ANSI and pushed to the activity buffer as plain-text events

### 2. NDJSON Log Tailing

Polls the newest `logs/run-*.ndjson` file every 2 seconds using a byte-offset cursor (no line buffering):

- Parses each NDJSON line for structured events
- `"Metrics"` messages update `latestMetrics` (displayed by `get_swarm_status`)
- All non-debug, non-Metrics events are pushed to `activityBuffer` (ring buffer, 50 entries)

## Exposed Tools

| Tool | Description |
|------|-------------|
| `launch_swarm` | Reset target repo + start orchestrator with a natural-language request |
| `stop_swarm` | Send SIGTERM; force SIGKILL after 30s if still alive |
| `get_swarm_status` | Current process state, uptime, task counts, merge stats, token usage |
| `get_activity_feed` | Recent log events (default 10, max 50), formatted as `[HH:MM:SS] [LEVEL] message` |

## File Guide

| File | Description |
|------|-------------|
| `src/index.ts` | Entire server implementation — both subsystems + HTTP server + MCP tool registration |

## How to Test

```bash
pnpm --filter @longshot/mcp-server build
node packages/mcp-server/dist/index.js
# Server starts on PORT (default 8787)
```

Point your MCP client at `http://localhost:8787/mcp`.

## How to Modify

- **Change the port**: set `PORT` env var (default `8787`).
- **Add a new tool**: call `server.tool(name, description, schema, handler)` inside `registerTools()` in `src/index.ts`.
- **Change log poll interval**: edit the `setInterval(tailLogFile, 2000)` call in `startLogTailing()`.
- **Extend metrics**: add fields to `SwarmMetrics` interface and update the `parseNdjsonLine` extractor.
- **Change SIGKILL timeout**: edit the `30_000` constant in the `stop_swarm` handler.
