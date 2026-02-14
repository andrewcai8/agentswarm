# AgentSwarm — Project Plan

## Vision

Build a massively parallel autonomous coding system for a hackathon. A local orchestrator (running on your machine) fans out tasks to ~100 concurrent Modal sandboxed coding agents, all committing to the same repo, producing a non-trivial software project autonomously at ~1,000 commits/hour.

The hackathon deliverable is both **the harness itself** and **whatever it builds** (VoxelCraft — a browser-based Minecraft clone in TypeScript + raw WebGL2).

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  YOUR MACHINE (Local)                                       │
│                                                             │
│  main.ts ─── Orchestrator                                   │
│    ├── Planner     (streaming LLM loop: Task[] → dispatch)  │
│    ├── Subplanner  (recursive decomposition of big tasks)   │
│    ├── WorkerPool  (spawns Modal sandboxes via Python)       │
│    ├── TaskQueue   (priority queue + state machine)          │
│    ├── MergeQueue  (background: fetch → merge → main)       │
│    ├── GitMutex    (serializes local git operations)         │
│    ├── Monitor     (health checks, stuck detection, metrics) │
│    └── Reconciler  (periodic tsc + npm test → fix tasks)    │
│                                                             │
│  target-repo/      (the project being built)                │
└────────────┬────────────────────────────────────────────────┘
             │  spawn_sandbox.py (Python subprocess)
             ▼
┌─────────────────────────────────────────────────────────────┐
│  MODAL (Remote — Ephemeral Sandboxes)                       │
│                                                             │
│  Each sandbox:                                              │
│    1. Receives task.json (written to /workspace)            │
│    2. Clones target repo (token-authed), checks out branch  │
│    3. Runs worker-runner.js (Pi coding agent SDK)           │
│    4. Agent calls LLM, writes code, commits                 │
│    5. Pushes branch to GitHub                               │
│    6. Writes result.json (Handoff)                          │
│    7. Sandbox terminates                                    │
│                                                             │
│  LLM Backend: GLM-5 on Modal 8x B200 via SGLang            │
└─────────────────────────────────────────────────────────────┘
```

### Key Protocol: How a Task Flows (Streaming Model)

```
1. PLANNER reads repo state + FEATURES.json
   ↓
2. PLANNER calls LLM → creates 50-100 Task[] → dispatches immediately
   ↓
3. Tasks dispatch concurrently (up to maxWorkers=100)
   Each task: WorkerPool → spawn_sandbox.py → Modal sandbox
   ↓
4. SANDBOX AGENT (Pi SDK) receives task
   → Reads relevant files in scope
   → Calls LLM (GLM-5 via Modal)
   → Writes code, commits to branch
   → Pushes branch to GitHub
   → Writes result.json (Handoff)
   ↓
5. ORCHESTRATOR reads result.json, terminates sandbox
   → Handoff pushed to pendingHandoffs queue
   ↓
6. MERGE-QUEUE (background) fetches branch, merges to main
   → GitMutex serializes all local git operations
   → If conflict: skip + log
   ↓
7. PLANNER collects completed handoffs continuously
   → After 3+ handoffs arrive, triggers re-planning
   → Emits new tasks while old ones still running
   ↓
   (loop continues until FEATURES.json is complete or max iterations)
```

---

## Budget

| Resource | Credits | Burn Rate | Notes |
|----------|---------|-----------|-------|
| Modal | $5,000 | Sandboxes: ~$0.02-0.05/task. GLM-5 8xB200: ~$50/hr | Sandboxes are cheap. Self-hosted LLM scales to zero when idle. |
| RunPod | $600 | H200 SXM 8x: ~$28.72/hr | Currently down. Modal is primary. |

### GLM-5 Deployment Status

| Provider | GPU | $/hr (8x) | Status |
|----------|-----|-----------|--------|
| Modal | 8x B200 | ~$50/hr | ✅ LIVE — `https://cameronai--glm5-inference-glm5.us-east.modal.direct` |
| RunPod | 8x H200 SXM | ~$28.72/hr | ❌ DOWN — endpoint unavailable |

**Strategy**: Modal-only for now. RunPod as backup when it comes back online.

---

## Repository Structure

```
agentswarm/
├── dashboard.py                  # Rich terminal dashboard (748 lines, fullscreen TUI)
├── package.json                  # Root monorepo (pnpm + turborepo)
├── tsconfig.base.json
├── turbo.json
├── pnpm-workspace.yaml
├── .env                          # LLM_ENDPOINTS, GIT_REPO_URL, GIT_TOKEN
│
├── .pi/
│   └── extensions/
│       └── swarm.ts              # Pi extension: launch_swarm, swarm_status, swarm_stop (436 lines)
│
├── packages/
│   ├── core/                     # Shared types, protocol, logger, git ops
│   │   └── src/
│   │       ├── types.ts          # Task, Handoff, HarnessConfig, MetricsSnapshot
│   │       ├── protocol.ts       # TaskAssignment, TaskResult, ProgressUpdate
│   │       ├── git.ts            # 10 async git functions + 4 types
│   │       ├── logger.ts         # Structured JSON logger
│   │       └── index.ts          # Barrel export
│   │
│   ├── orchestrator/             # LOCAL — runs on your machine
│   │   └── src/
│   │       ├── main.ts           # Entry point — creates orchestrator, signal handling
│   │       ├── orchestrator.ts   # Factory: wires config, components, callbacks
│   │       ├── config.ts         # OrchestratorConfig from env vars
│   │       ├── planner.ts        # Streaming planner: dispatch → collect → replan
│   │       ├── subplanner.ts     # Recursive subplanner for large tasks
│   │       ├── shared.ts         # readRepoState, parseLLMTaskArray, ConcurrencyLimiter, GitMutex
│   │       ├── worker-pool.ts    # Spawns ephemeral Modal sandboxes via Python subprocess
│   │       ├── task-queue.ts     # Priority queue + state machine
│   │       ├── merge-queue.ts    # Background merge queue with GitMutex + fetch-from-origin
│   │       ├── reconciler.ts     # Periodic tsc + npm test → LLM → fix tasks
│   │       ├── monitor.ts        # Health checks, stuck detection, metrics
│   │       ├── llm-client.ts     # Multi-endpoint LLM client with weighted routing
│   │       └── index.ts          # Barrel export
│   │
│   ├── sandbox/                  # REMOTE — runs inside Modal sandboxes
│   │   └── src/
│   │       ├── worker-runner.ts  # Pi SDK agent: task → code → commit → push → handoff
│   │       ├── handoff.ts        # buildHandoff() — git diff stat parsing
│   │       └── index.ts          # Barrel export
│   │
│   └── dashboard/                # NOT STARTED — future web UI (React)
│
├── infra/                        # Modal infrastructure (Python)
│   ├── sandbox_image.py          # Modal Image: Debian slim, Node 22, Git, ripgrep, pnpm, Pi SDK
│   ├── spawn_sandbox.py          # Sandbox: create → clone (authed) → exec → push → read result → terminate
│   ├── deploy_glm5.py            # GLM-5 on 8x B200 via SGLang
│   ├── glm5_client.py            # Endpoint URL resolution
│   ├── config.yaml               # SGLang server config (EAGLE speculative decoding, memory, batching)
│   └── __init__.py
│
├── prompts/                      # All agent prompts (constraint-based)
│   ├── root-planner.md           # Streaming planner: 50-100 tasks, overlap-tolerant
│   ├── subplanner.md             # Recursive decomposition
│   ├── worker.md                 # Worker: constraint-based, handoff-rich
│   └── reconciler.md             # Build healer: error grouping → fix tasks
│
├── generated-repos/              # Project specs generated via bootstrap template
│   ├── bootstrap.md              # Template for generating new project specs
│   ├── README.md                 # Instructions for creating new projects
│   ├── example/                  # Example project spec (SPEC, AGENTS, RUNBOOK, etc.)
│   └── minecraft-browser/        # VoxelCraft project spec (SPEC, AGENTS, RUNBOOK, etc.)
│
└── scripts/
    └── test_sandbox.py           # E2E test script
```

---

## Current Status (2026-02-14)

### Phase 0: LLM Backend — ✅ LIVE

GLM-5 on Modal confirmed healthy. Token usage at 11% with 14 concurrent requests — massive headroom for 100 workers. EAGLE speculative decoding active: accept rate 0.78-0.87, ~3.3 tokens/step.

### Phase 1: Foundation — ✅ VALIDATED ON LIVE INFRA

| Step | Status | Details |
|------|--------|---------|
| 0a. GLM-5 endpoint live | ✅ DONE | Modal 8xB200, SGLang, EAGLE speculative decoding |
| 0b. GitHub repo created | ✅ DONE | `https://github.com/andrewcai8/swarm-minecraft.git` |
| 1a. Sandbox image builds | ✅ PASSED | Node 22, Git, ripgrep, pnpm, Pi SDK all verified |
| 1b. Single sandbox lifecycle | ✅ PASSED | Create, write, clone, exec, read, terminate |
| 1c. Pi agent in sandbox | ✅ PASSED | 26 tool calls, 62 seconds, correct output |
| 1d. Full orchestrator E2E | ✅ PASSED | 27 tasks, 0 failures, 108 commits/hr, 100% merge |

10 integration bugs found and fixed during validation.

### Phase 2: Orchestrator — ✅ COMPLETE + STREAMING UPGRADE

| Component | Status | Lines | Details |
|-----------|--------|-------|---------|
| `orchestrator.ts` | ✅ DONE | 262 | Factory: wires all components, GitMutex, GIT_TOKEN, background merge |
| `config.ts` | ✅ DONE | 110 | Multi-endpoint JSON, default maxWorkers=100 |
| `planner.ts` | ✅ DONE | 346 | **Streaming**: dispatch immediately, collect handoffs, replan on 3+ completions |
| `subplanner.ts` | ✅ DONE | 441 | Recursive decomposition, no local branch creation |
| `shared.ts` | ✅ DONE | 124 | ConcurrencyLimiter + GitMutex |
| `worker-pool.ts` | ✅ DONE | 176 | 50MB maxBuffer, GIT_TOKEN passthrough |
| `task-queue.ts` | ✅ DONE | 366 | PriorityQueue + state machine |
| `merge-queue.ts` | ✅ DONE | 244 | Background mode, fetch-from-origin, GitMutex |
| `monitor.ts` | ✅ DONE | 152 | Health polling, stuck detection, metrics |
| `llm-client.ts` | ✅ DONE | 301 | Multi-endpoint weighted routing |
| `reconciler.ts` | ✅ DONE | 235 | Timer-based build healer |
| `main.ts` | ✅ DONE | 91 | Entry point with signal handling |

**Architecture (Cursor "self-driving codebases" inspired):**
- Streaming planner loop (not batch-and-wait)
- Background merge queue (doesn't block planning)
- GitMutex serializes all local git operations
- Workers push branches to GitHub (token-authed)
- Merge queue fetches from origin before merging
- No local branch creation (branches created inside sandboxes only)
- Relaxed overlap policy (accept turbulence, system converges)
- Task fan-out: 50-100 per planning call

### Phase 2 Prompts — ✅ REWRITTEN (constraint-based)

| Prompt | Lines | Style |
|--------|-------|-------|
| `root-planner.md` | 131 | 50-100 tasks, NEVER < 20, overlap accepted, streaming-aware |
| `worker.md` | 67 | NEVER TODOs, NEVER modify outside scope, 3 strikes = stop |
| `reconciler.md` | 118 | NEVER > 5 fix tasks, ALWAYS cite error |
| `subplanner.md` | 154 | Unchanged |

### Phase 3: Target Project (VoxelCraft) — ✅ SPEC COMPLETE

Specs live in `generated-repos/minecraft-browser/` (SPEC.md, AGENTS.md, RUNBOOK.md, etc.).
GitHub: `https://github.com/andrewcai8/swarm-minecraft.git` (1 commit: initial scaffold).
Note: `target-repo/` is not checked into this repo — it is cloned at runtime by the orchestrator.

### Phase 4: Dashboard — ✅ RICH TERMINAL UI COMPLETE / ❌ WEB UI NOT STARTED

**Rich Terminal Dashboard** (`dashboard.py` — 748 lines, fully functional)

A fullscreen, multi-panel TUI using Python's `rich` library that refreshes at 2 Hz. Consumes NDJSON events from the orchestrator's structured logger and `Monitor` metrics snapshots.

| Panel | Shows |
|-------|-------|
| Header | Elapsed time, active agent count (N/max), commits/hr |
| Metrics | Iteration, tasks done/total (%), failed, pending, merge rate, tokens, estimated cost |
| Agent Grid | Visual heatmap — colored block per slot (yellow=running, green=done, red=failed, gray=idle) |
| Merge Queue | Success rate bar, merged/conflict/failed counts |
| Activity Feed | Real-time scrolling event log (task lifecycle, merge results, reconciler sweeps, errors) |
| Footer | Overall feature progress bar (completed/total) |

Three input modes:
- `python dashboard.py --demo` — synthetic data generator (no orchestrator needed)
- `node packages/orchestrator/dist/main.js | python dashboard.py --stdin` — pipe mode
- `python dashboard.py` — spawns orchestrator as subprocess

**Observability backend** (`packages/orchestrator/src/monitor.ts` — 152 lines):
- Periodic health polling with configurable interval
- Worker timeout detection with callbacks
- Token usage and merge success/failure tracking
- Emits `MetricsSnapshot` events consumed by the dashboard

**Web UI**: Not started. No React, no web framework code. Listed as future goal in README.

---

## Code Statistics

| Category | Lines | Files |
|----------|-------|-------|
| TypeScript (packages/) | 3,783 | 15 source files |
| TypeScript (.pi/extensions/) | 436 | 1 file |
| Python (infra/) | 689 | 6 files (incl. config.yaml) |
| Python (dashboard.py) | 748 | 1 file |
| Python (scripts/) | 448 | 1 file |
| Prompts (prompts/) | 470 | 4 files |
| Generated-repos specs | 716 | 15 files |
| Tests | 1,335 | 5 test files |
| **Total** | **~8,625** | **48 files** |

Tests: 85 unit tests. All passing (<100ms).

---

## What Needs To Happen (Priority Order)

### ~~Step 0: Prerequisites~~ — ✅ DONE
### ~~Step 1: Validate Pipeline E2E~~ — ✅ DONE
### ~~Step 2: Fix What Broke~~ — ✅ DONE (10 bugs)
### ~~Step 2b: Architecture Upgrade~~ — ✅ DONE (Cursor-inspired streaming)

---

### Step 3: Full-Scale Run (100 workers) — 🔜 NEXT

Skip gradual ramp — GLM-5 showed 11% utilization with 14 concurrent requests.

```bash
node packages/orchestrator/dist/main.js
```

Default: `MAX_WORKERS=100`. Streaming planner generates 50-100 tasks per iteration.

**Watch for:**
- GLM-5 saturation (token usage, queue depth, gen throughput)
- Merge conflict rate (relaxed overlap = some conflicts expected)
- Task quality (is planner producing sensible tasks?)
- Sandbox creation rate (can Modal handle 100 concurrent?)
- Git push contention (100 workers pushing simultaneously)
- Local machine (100 Python subprocesses, memory, file descriptors)

**Success criteria:**
- Sustained 100 workers for 30+ minutes
- >50% task completion rate
- Merge success rate >70%
- VoxelCraft begins taking shape

---

### Step 4: Dashboard (for the demo) — ✅ TERMINAL UI DONE

Rich terminal dashboard is fully built (`dashboard.py`, 749 lines). See Phase 4 above for details.

**Remaining (nice-to-have):**
- Web UI (React + WebSocket) for remote monitoring — not started
- Log Viewer (agent conversation replay) — not in terminal dashboard
- VoxelCraft Preview (embedded iframe of the game being built live) — requires web UI

---

### Step 5: Sustained Production Run

Multi-hour run targeting 200 FEATURES.json features. VoxelCraft should be playable.

---

### Step 6: Polish for Demo

Record metrics, screenshots, video. Show VoxelCraft + commit history.

---

## Known Issues

| Issue | Severity | Details |
|-------|----------|---------|
| RunPod down | MEDIUM | Endpoint unavailable. Modal-only for now. |
| `tokensUsed: 0` in handoff | LOW | Pi SDK counter incompatible with GLM-5 streaming. |
| No auto-merge conflict resolution | MEDIUM | Conflicts skipped + logged. Could be significant at 100 workers. |
| Unbounded subtask fan-out | MEDIUM | Could fan to ~1000 LLM calls at depth-3. |
| No web dashboard | LOW | Terminal dashboard exists. Web UI is nice-to-have for remote monitoring. |
| `shared mem limit` warnings | LOW | SGLang falls back to low-smem kernel for large prefills. |

---

## Environment Variables

```env
LLM_ENDPOINTS=[{"name":"modal-b200","endpoint":"https://cameronai--glm5-inference-glm5.us-east.modal.direct","weight":100}]
LLM_MODEL=glm-5
GIT_REPO_URL=https://github.com/andrewcai8/swarm-minecraft.git
GIT_TOKEN=<github-pat-with-push-access>

# Optional
MAX_WORKERS=100
WORKER_TIMEOUT=1800
MERGE_STRATEGY=fast-forward
TARGET_REPO_PATH=./target-repo
PYTHON_PATH=python3
LLM_MAX_TOKENS=8192
LLM_TEMPERATURE=0.7
```

## Running

```bash
pnpm run build
node packages/orchestrator/dist/main.js
```
