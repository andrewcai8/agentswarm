# @longshot/sandbox

Modal sandbox worker harness — runs inside ephemeral cloud sandboxes to execute coding tasks on behalf of the Longshot orchestrator.

## Purpose

This package implements the worker side of the orchestrator↔sandbox contract. Each sandbox receives a `task.json` payload, runs the pi-coding-agent against the target repository, performs a safety-net commit and TypeScript build check, and writes a `result.json` handoff back for the orchestrator to consume.

## Architecture

```
spawn_sandbox.py (Python, Modal)
    └── writes task.json to /workspace/
    └── invokes worker-runner.ts (this package)
            └── reads task.json
            └── registers LLM model with Pi ModelRegistry
            └── creates AgentSession with 7 tools
                    (read, bash, edit, write, grep, find, ls)
            └── runs session.prompt(taskPrompt)
            └── safety-net commit (git add -A && git commit)
            └── tsc --noEmit build check
            └── extracts git diff stats
            └── writes result.json (Handoff)
    └── reads result.json → returns to orchestrator
```

### Sandbox Contract

| Path | Description |
|------|-------------|
| `/workspace/task.json` | Input: `TaskPayload` (task, systemPrompt, llmConfig, repoUrl, trace) |
| `/workspace/AGENTS.md` | Worker instructions written at startup (systemPrompt) |
| `/workspace/repo/` | Cloned target repository (working directory for the agent) |
| `/workspace/result.json` | Output: `Handoff` serialized as JSON |

## File Guide

| File | Description |
|------|-------------|
| `worker-runner.ts` | Main harness: `runWorker()` function and `buildTaskPrompt()` helper. Handles tracing propagation, artifact filtering, empty-response detection, and safety-net commit logic |
| `handoff.ts` | `buildHandoff()` factory and `getGitDiffStat()` — parses `git diff --numstat` output into structured file/line counts |
| `index.ts` | Public API barrel |

## Complexity

**Medium** — three files with a clear linear flow. The most nuanced parts are artifact filtering (prevents committing `node_modules`/`dist`) and the empty-response guard (detects 0-token LLM responses before committing scaffold files).

## How to Test

```bash
pnpm --filter @longshot/sandbox test
```

## How to Modify

- **Add a Pi tool**: extend the `fullPiTools` array in `worker-runner.ts` by importing additional tools from `@mariozechner/pi-coding-agent`.
- **Change artifact exclusions**: edit `ARTIFACT_PATTERNS` and `GITIGNORE_ESSENTIALS` in `worker-runner.ts`.
- **Adjust build check timeout**: edit the `timeout` passed to `execSync("npx tsc --noEmit", ...)`.
- **Change task prompt format**: edit `buildTaskPrompt()` in `worker-runner.ts`.

Do not change the `TASK_PATH` / `RESULT_PATH` / `WORK_DIR` constants without updating `infra/spawn_sandbox.py` to match.
