# Longshot

Massively parallel autonomous coding: decompose any project into hundreds of tasks and execute them simultaneously in isolated cloud sandboxes.

## What it does

Longshot takes a natural-language build request and turns it into working code. A root planner breaks the request into granular tasks, dispatches them to ephemeral Modal sandboxes running in parallel, and merges the results back into your repository. A reconciler monitors build health throughout and automatically spawns fix tasks when something breaks.

The entire system is stateless. Workers are ephemeral, state lives only in Git, and the orchestrator runs locally while all execution happens in the cloud.

## Architecture

```
User request
    └── Root Planner (LLM)
            └── Subplanners (for large task scopes)
                    └── Workers (parallel, up to MAX_WORKERS)
                            └── Modal Sandboxes
                                    └── Pi Coding Agent (@mariozechner/pi-coding-agent)
                                            └── Merge Queue
                                                    └── Reconciler (self-healing)
```

**Three TypeScript packages** (scope `@longshot/*`):

- `packages/core` — shared types, logging, LLM client, git utilities
- `packages/orchestrator` — planner loop, worker pool, merge queue, reconciler
- `packages/sandbox` — Modal sandbox definition and worker harness
- `packages/mcp-server` — MCP server for controlling Longshot from AI assistants

**Python layer** (`main.py`, `dashboard.py`) wraps the Node orchestrator with a human-readable CLI and optional Rich TUI dashboard.

**Modal** provides the cloud sandboxes. Each worker runs in a fully isolated container with its own clone of the target repository.

## Prerequisites

- Node.js 22+
- pnpm
- Python 3.12+
- [uv](https://docs.astral.sh/uv/)
- [Modal](https://modal.com) account (`pip install modal && modal setup`)

## Quick Start

```bash
# Install dependencies
pnpm install
pnpm build

# Install Python dependencies
uv sync

# Configure environment
cp .env.example .env
# Edit .env with your LLM credentials and target repo

# Run
python main.py "Build a REST API according to SPEC.md"

# With the Rich TUI dashboard
python main.py "Build a REST API according to SPEC.md" --dashboard

# Reset target repo to initial commit before running
python main.py "Build a REST API according to SPEC.md" --reset

# Debug logging
python main.py "Build a REST API according to SPEC.md" --debug
```

## Configuration

All configuration is via environment variables in `.env`.

### Required

| Variable | Description |
|----------|-------------|
| `GIT_REPO_URL` | URL of the target repository workers will clone and commit to |
| `LLM_BASE_URL` | Base URL of your LLM API endpoint (OpenAI-compatible) |
| `LLM_API_KEY` | API key for the LLM endpoint |

For multiple LLM endpoints with load balancing, use `LLM_ENDPOINTS` instead of `LLM_BASE_URL`/`LLM_API_KEY`:

```json
LLM_ENDPOINTS=[{"name":"primary","endpoint":"https://...","apiKey":"sk-...","weight":100}]
```

### Workers

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_WORKERS` | `50` | Maximum number of parallel workers |
| `WORKER_TIMEOUT` | `1800` | Worker timeout in seconds |

### LLM

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_MODEL` | `glm-5` | Model name to pass to the API |
| `LLM_MAX_TOKENS` | `65536` | Max tokens per LLM request |
| `LLM_TEMPERATURE` | `0.7` | Sampling temperature |

### Sandboxes

| Variable | Default | Description |
|----------|---------|-------------|
| `SANDBOX_CPU_CORES` | `4` | CPU cores per Modal sandbox |
| `SANDBOX_MEMORY_MB` | `8192` | Memory per Modal sandbox (MB) |
| `SANDBOX_IDLE_TIMEOUT` | `300` | Sandbox idle timeout in seconds |

### Git

| Variable | Default | Description |
|----------|---------|-------------|
| `GIT_MAIN_BRANCH` | `main` | Main branch name in the target repo |
| `GIT_BRANCH_PREFIX` | `worker/` | Prefix for worker branches |

### Orchestrator

| Variable | Default | Description |
|----------|---------|-------------|
| `HEALTH_CHECK_INTERVAL` | `10` | Reconciler health check interval in seconds |
| `MERGE_STRATEGY` | `rebase` | Merge strategy: `fast-forward`, `rebase`, or `merge-commit` |
| `FINALIZATION_ENABLED` | `true` | Run build/test sweep after all tasks complete |
| `FINALIZATION_MAX_ATTEMPTS` | `3` | Max reconciler fix attempts during finalization |

## MCP Server

`packages/mcp-server` exposes Longshot as an [MCP](https://modelcontextprotocol.io) server, letting you control the orchestrator directly from Claude or any MCP-compatible AI assistant.

Build it:

```bash
pnpm --filter @longshot/mcp-server build
```

Then add it to your MCP client config pointing at `packages/mcp-server/dist/index.js`.

## Contributing

1. Fork the repo
2. Create a branch (`git checkout -b feat/your-feature`)
3. Commit your changes
4. Open a pull request against `main`

## License

See [LICENSE](./LICENSE).
