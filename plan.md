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
│    ├── Planner     (LLM: decompose work → Task[])           │
│    ├── Subplanner  (recursive decomposition of big tasks)   │
│    ├── WorkerPool  (spawns Modal sandboxes via Python)       │
│    ├── TaskQueue   (priority queue + state machine)          │
│    ├── MergeQueue  (branch → main via ff/rebase/merge)      │
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
│    2. Clones target repo, checks out task branch            │
│    3. Runs worker-runner.js (Pi coding agent SDK)           │
│    4. Agent calls LLM, writes code, runs tests, commits    │
│    5. Writes result.json (Handoff)                          │
│    6. Sandbox terminates                                    │
│                                                             │
│  LLM Backend: RunPod serverless (GLM-5)                     │
│    — AND self-hosted GLM-5 on Modal 8x B200 via SGLang      │
└─────────────────────────────────────────────────────────────┘
```

### Key Protocol: How a Task Flows

```
1. PLANNER reads repo state + FEATURES.json
   ↓
2. PLANNER calls LLM → creates Task[] (id, description, scope, acceptance, branch)
   ↓
3. ORCHESTRATOR assigns each task to an ephemeral sandbox (up to maxWorkers concurrently)
   ↓
4. WORKER-POOL spawns Modal sandbox → writes task.json → execs worker-runner.js
   ↓
5. SANDBOX AGENT (Pi SDK) receives task
   → Reads relevant files in scope
   → Calls LLM (GLM-5 via RunPod/Modal)
   → Writes code, runs tests, commits to branch
   → Writes result.json (Handoff: status, summary, diff, metrics)
   ↓
6. ORCHESTRATOR reads result.json, terminates sandbox
   ↓
7. MERGE-QUEUE merges branch to main (fast-forward/rebase/merge-commit)
   → If conflict: log + skip (future: spawn conflict-resolution worker)
   ↓
8. PLANNER receives handoff → updates understanding → creates next Task batch
   ↓
   (loop continues until FEATURES.json is complete or max iterations reached)
```

---

## Budget

| Resource | Credits | Burn Rate | Notes |
|----------|---------|-----------|-------|
| Modal | $5,000 | Sandboxes: ~$0.02-0.05/task. GLM-5 8xB200: ~$50/hr | Sandboxes are cheap. Self-hosted LLM scales to zero when idle (`MIN_CONTAINERS=0`). |
| RunPod | $600 | H200 SXM 8x: ~$28.72/hr. ~20.9 hrs on $600. | GLM-5 deployed via serverless endpoint `8u0fdj5jh2rlxd`. |

### GLM-5 Deployment Status

Both providers now have GLM-5 deployed and validated:

| Provider | GPU | $/hr (8x) | Image | Status |
|----------|-----|-----------|-------|--------|
| Modal | 8x B200 | ~$50/hr | `lmsysorg/sglang:glm5-blackwell` | ✅ Deployed — dummy weight test passed, real weight deploy in progress |
| RunPod | 8x H200 SXM | ~$28.72/hr | Serverless endpoint | ✅ Deployed — endpoint `8u0fdj5jh2rlxd` |

### Hackathon Budget Math (29-hour hackathon)

| Provider | $/hr | Budget | Hours Covered | Covers 29hrs? |
|----------|------|--------|---------------|---------------|
| RunPod (H200 SXM) | $28.72 | $600 | ~20.9 hrs | ❌ 8 hrs short |
| Modal (B200) | $50.00 | $5,000 | ~100 hrs | ✅ More than enough |
| Both combined | — | $5,600 | — | ✅ RunPod primary (cheap), Modal overflow |

**Strategy**: Use RunPod as primary LLM backend (cheaper per hour). Modal GLM-5 as overflow/backup when RunPod credits run low or for burst throughput. Modal sandboxes for all agent execution regardless.

---

## Repository Structure

```
agentswarm/
├── package.json                  # Root monorepo (pnpm + turborepo)
├── tsconfig.base.json
├── turbo.json
├── pnpm-workspace.yaml
├── .env                          # RUNPOD_ENDPOINT_ID, RUNPOD_API_KEY, LLM_MODEL, GIT_REPO_URL
│
├── packages/
│   ├── core/                     # Shared types, protocol, logger, git ops
│   │   └── src/
│   │       ├── types.ts          # Task, Handoff, HarnessConfig, MetricsSnapshot, etc.
│   │       ├── protocol.ts       # TaskAssignment, TaskResult, ProgressUpdate message schemas
│   │       ├── git.ts            # 10 async git functions + 4 types
│   │       ├── logger.ts         # Structured JSON logger
│   │       └── index.ts          # Barrel export
│   │
│   ├── orchestrator/             # LOCAL — runs on your machine
│   │   └── src/
│   │       ├── main.ts           # Entry point — wires everything, starts planner loop
│   │       ├── config.ts         # OrchestratorConfig from env vars (RunPod endpoint, etc.)
│   │       ├── planner.ts        # Root planner: LLM → Task[] → dispatch → handoff → loop
│   │       ├── subplanner.ts     # Recursive subplanner for large tasks
│   │       ├── shared.ts         # readRepoState, parseLLMTaskArray, ConcurrencyLimiter
│   │       ├── worker-pool.ts    # Spawns ephemeral Modal sandboxes via Python subprocess
│   │       ├── task-queue.ts     # Priority queue + state machine (pending→assigned→running→complete/failed)
│   │       ├── merge-queue.ts    # Git merge queue (3 strategies, conflict detection)
│   │       ├── reconciler.ts     # Periodic tsc + npm test → LLM → fix tasks
│   │       ├── monitor.ts        # Health checks, stuck detection, metrics, timeout enforcement
│   │       ├── llm-client.ts     # Thin HTTP client for OpenAI-compatible /v1/chat/completions
│   │       └── index.ts          # Barrel export
│   │
│   ├── sandbox/                  # REMOTE — runs inside Modal sandboxes
│   │   └── src/
│   │       ├── worker-runner.ts  # Reads task.json, creates Pi agent session, runs task, writes result.json
│   │       ├── handoff.ts        # buildHandoff() — git diff stat parsing
│   │       └── index.ts          # Barrel export
│   │
│   └── dashboard/                # NOT STARTED — live web UI
│
├── infra/                        # Modal infrastructure (Python)
│   ├── sandbox_image.py          # Modal Image: Debian slim, Node 22, Git, ripgrep, pnpm, Pi SDK
│   ├── spawn_sandbox.py          # SandboxManager: create → write task.json → exec → read result.json → terminate
│   ├── deploy_glm5.py            # GLM-5 on 8x B200 via SGLang (with patches for GLM-5 architecture)
│   ├── glm5_client.py            # Helper for GLM-5 endpoint URL + OpenAI config generation
│   └── __init__.py
│
├── prompts/                      # All agent prompts (version controlled)
│   ├── root-planner.md           # Root planner: decompose work → Task JSON array
│   ├── subplanner.md             # Subplanner: recursive decomposition of large tasks
│   ├── worker.md                 # Worker: receive task → explore → implement → verify → commit → handoff
│   └── reconciler.md             # Reconciler: analyze build/test failures → fix task JSON array
│
├── target-repo/                  # The project agents will BUILD (VoxelCraft)
│   ├── SPEC.md                   # 522-line technical specification
│   ├── FEATURES.json             # 200 features with priority, status, files, acceptance criteria
│   ├── AGENTS.md                 # Agent coding instructions (style, constraints, conventions)
│   ├── package.json              # Vite + TypeScript project
│   ├── tsconfig.json
│   ├── index.html
│   └── src/index.ts              # Stub: WebGL2 context init (14 lines)
│
└── scripts/
    └── test_sandbox.py           # E2E test script (image, basic, server, full, all subcommands)
```

---

## Current Status

### Phase 1: Foundation — ✅ CODE COMPLETE (not yet validated on live infra)

Everything is built. Nothing has been confirmed working against live Modal.

| Component | Status | Details |
|-----------|--------|---------|
| Monorepo scaffold | ✅ DONE | pnpm workspaces, turborepo, tsconfig, build/typecheck/clean scripts |
| `packages/core` | ✅ DONE | types.ts (Task, Handoff, HarnessConfig, MetricsSnapshot), protocol.ts, git.ts (10 functions), logger.ts |
| `infra/sandbox_image.py` | ✅ DONE | Debian slim + Node 22 + Git + ripgrep + pnpm 9 + Pi SDK. `create_worker_image()` copies built sandbox package. |
| `infra/deploy_glm5.py` | ✅ DONE | Official `lmsysorg/sglang:glm5-blackwell` image, GLM-5-FP8, 8x B200, HF cache volume, OpenAI-compatible API. No manual patches needed. |
| `infra/spawn_sandbox.py` | ✅ DONE | Ephemeral sandbox lifecycle: create → write task.json → clone repo → checkout branch → exec worker-runner.js → read result.json → terminate. |
| `infra/glm5_client.py` | ✅ DONE | Endpoint URL resolution, OpenAI config generation. |
| `packages/sandbox/worker-runner.ts` | ✅ DONE | Pi coding agent SDK integration. Registers GLM-5 as custom provider, creates agent session, runs task prompt, extracts git diff stats, writes Handoff to result.json. 227 lines. |
| `scripts/test_sandbox.py` | ✅ DONE | 4-layer test: image build, basic sandbox ops, server endpoints, full agent loop. |
| `prompts/worker.md` | ✅ DONE | 100 lines. Identity, tools, workflow, hard constraints, code quality, handoff format. |
| E2E validation on live Modal | ❌ NOT DONE | **This is the #1 blocker.** The entire pipeline has never been run against live Modal infrastructure. |

### Phase 2: Multi-Agent Orchestrator — ✅ COMPLETE (100%)

| Component | Status | Lines | Details |
|-----------|--------|-------|---------|
| `config.ts` | ✅ DONE | 77 | Loads from env vars. Required: RUNPOD_ENDPOINT_ID, RUNPOD_API_KEY, GIT_REPO_URL. Constructs RunPod endpoint URL. |
| `task-queue.ts` | ✅ DONE | 374 | PriorityQueue (min-heap) + TaskQueue (state machine with valid transitions). |
| `worker-pool.ts` | ✅ DONE | 163 | Ephemeral model. `assignTask()` spawns Python subprocess → spawn_sandbox.py → reads JSON handoff from stdout last line. |
| `merge-queue.ts` | ✅ DONE | 173 | 3 merge strategies. Conflict detection (skip+log, no auto-resolve). |
| `monitor.ts` | ✅ DONE | 205 | Health polling, stuck detection, timeout enforcement, empty diff alerts, MetricsSnapshot. |
| `llm-client.ts` | ✅ DONE | 91 | Thin fetch wrapper for OpenAI-compatible /v1/chat/completions. Bearer auth, timeout, usage parsing. |
| `planner.ts` | ✅ DONE | 315 | Reads repo state (file tree, commits, FEATURES.json). Calls LLM → parses Task JSON → dispatches to workers via ConcurrencyLimiter → collects handoffs → merges branches → loops. |
| `subplanner.ts` | ✅ DONE | 460 | Recursive decomposition. `shouldDecompose()` heuristic. Dispatch lock mutex. Worker timeout on polling. |
| `shared.ts` | ✅ DONE | 71 | readRepoState, parseLLMTaskArray, ConcurrencyLimiter — shared between planner + subplanner. |
| `main.ts` | ✅ DONE | 174 | Entry point. Wires config, task queue, worker pool, merge queue, monitor, planner, reconciler. Signal handling. |
| `reconciler.ts` | ✅ DONE | 237 | Timer-based sweep. Runs `tsc --noEmit` + `npm test` on target-repo. On failure → LLM → fix tasks (max 5, priority 1). |
| `prompts/root-planner.md` | ✅ DONE | 143 | Task decomposition rules, JSON schema, anti-patterns. |
| `prompts/subplanner.md` | ✅ DONE | 172 | Recursive decomposition workflow, scope containment, anti-patterns. |
| `prompts/reconciler.md` | ✅ DONE | 149 | Diagnostic agent: analyze failures → fix tasks. Error grouping, examples, anti-patterns. |
| Tests (orchestrator) | ✅ DONE | 1,094 | task-queue.test.ts (22), config.test.ts (10), monitor.test.ts (14), subplanner.test.ts (32). All pass. |
| Tests (sandbox) | ✅ DONE | 214 | sandbox.test.ts — sandbox lifecycle tests. |

#### Phase 2 Key Design Decisions
- **Ephemeral sandboxes**: No persistent worker pool. Each task gets a fresh sandbox → task.json → exec → result.json → terminate.
- **Python subprocess for sandbox lifecycle**: worker-pool.ts calls `spawn_sandbox.py` via `child_process.execFile`. Hot path (LLM calls) is pure TS.
- **RunPod serverless as primary LLM**: config.ts constructs `https://api.runpod.ai/v2/{RUNPOD_ENDPOINT_ID}/openai`. No self-hosted GLM-5 needed for testing.
- **Conflict detection only**: Merge conflicts are skipped + logged. No auto-resolution (defer to future).
- **ConcurrencyLimiter**: Dispatch lock prevents spawning more than `maxWorkers` sandboxes simultaneously.

### Phase 3: Target Project (VoxelCraft) — ✅ SPEC COMPLETE

| Component | Status | Details |
|-----------|--------|---------|
| `SPEC.md` | ✅ DONE | 522 lines. Full technical specification: architecture, MVP scope, block registry, chunk format, coordinate systems, shader architecture, terrain pipeline, physics system, code conventions, milestones. |
| `FEATURES.json` | ✅ DONE | 200 features across 10 categories: engine (30), world (45), player (25), blocks (20), physics (15), ui (25), input (10), lighting (15), audio (5), performance (10). All have priority, status, files, acceptance criteria. |
| `AGENTS.md` | ✅ DONE | Agent coding instructions. Tech stack, file structure, code conventions, commit rules, hard constraints, architecture awareness, quality checklist. |
| `package.json` | ✅ DONE | Vite 5.4 + TypeScript 5.4. Scripts: dev, build, preview. |
| `tsconfig.json` | ✅ DONE | Strict mode, ES2022, ESM. |
| `index.html` | ✅ DONE | Canvas element + module script entry point. |
| `src/index.ts` | ✅ DONE | Stub: WebGL2 context init (14 lines). |

### Phase 4: Dashboard — ❌ NOT STARTED

Live web UI for monitoring the agent swarm during the demo run.

---

## Code Statistics

| Category | Lines | Files |
|----------|-------|-------|
| TypeScript (packages/) | 4,507 | 26 files |
| Python (infra/) | 697 | 5 files |
| Prompts (prompts/) | 560 | 4 files |
| Target repo spec | ~2,539 | 3 files (SPEC.md + FEATURES.json + AGENTS.md) |
| **Total** | **~8,303** | **38 files** |

Tests: 78 unit tests across 5 test files. All passing.

---

## What Needs To Happen (Priority Order)

### Step 1: Validate the Pipeline E2E (CRITICAL — do this first)

**Nothing else matters until a single task runs through the full loop successfully.**

The entire system has been built in isolation. Every component was coded without being run against live infrastructure. This is the highest-risk moment — if any integration point is broken, we need to find out now.

#### 1a. Validate sandbox image builds on Modal — ✅ PASSED (2025-02-14)
```bash
cd infra && modal run sandbox_image.py
```
Confirms: Node 22, Git, ripgrep, pnpm, Pi SDK all install correctly in the Modal image.

**Result:** All 8 tools verified: node v22.22.0, npm 10.9.4, pnpm 9.15.9, git 2.39.5, rg 14.1.1, jq 1.6, python3 3.12.10, curl 7.88.1. Image builds in ~50s total across 6 layers.

#### 1b. Validate a single sandbox lifecycle — ✅ PASSED (2025-02-14)
Run `spawn_sandbox.py` directly with a trivial task payload (no LLM needed — just file I/O):
- Create sandbox → write task.json → clone a repo → exec a simple Node script → read result.json → terminate
- This validates: Modal sandbox API, file I/O, git clone, Node.js execution, cleanup

**Result:** `python scripts/test_sandbox.py basic` — sandbox created (sb-2hHCBQZVzZX2rpxZgx6c7W), command exec, file I/O, git init+commit, Node.js v22.22.0 all passed.

#### 1c. Validate the Pi coding agent inside a sandbox
Run `worker-runner.ts` inside a sandbox with a real LLM call to the RunPod endpoint:
- Task: "Create a file `src/utils/constants.ts` that exports `CHUNK_SIZE = 16`"
- This validates: Pi SDK registration, GLM-5 provider config, LLM round-trip, tool execution, git commit, handoff generation

#### 1d. Validate the orchestrator main.ts with 1 worker
```bash
GIT_REPO_URL=<repo> MAX_WORKERS=1 node packages/orchestrator/dist/main.js
```
- Does the planner call RunPod and get back valid Task JSON?
- Does it spawn one sandbox and get a handoff?
- Does the merge queue merge the branch?
- Does the next planner iteration see the new commits?

**Expected issues to surface:**
- Modal SDK API changes (sandbox creation, file I/O, exec)
- Pi SDK integration bugs (provider registration, agent session, tool calling format)
- RunPod endpoint compatibility (request format, response parsing, auth headers)
- spawn_sandbox.py stdout parsing (last-line JSON extraction)
- Git operations (clone with auth, branch creation, merge conflicts on first merge)

**Budget for this step:** ~$5-10 Modal (sandbox creation), ~$1-2 RunPod (a few LLM calls). Negligible.

---

### Step 2: Fix What Breaks in Step 1

This is guaranteed to be necessary. Integration bugs will surface. Fix them iteratively:
- Sandbox lifecycle failures → fix spawn_sandbox.py
- LLM response parsing failures → fix parseLLMTaskArray or prompt
- Pi SDK issues → fix worker-runner.ts provider registration
- Git auth issues → fix clone URL / credential handling

---

### Step 3: Small-Scale Validation (3-5 workers)

Once single-worker works:
```bash
MAX_WORKERS=3 node packages/orchestrator/dist/main.js
```

Watch for:
- **Merge conflicts**: Are tasks getting overlapping file scopes? → Tune planner prompt
- **Task quality**: Is the planner producing sensible, independent tasks? → Tune root-planner.md
- **Worker effectiveness**: Are agents actually producing correct code? → Tune worker.md and AGENTS.md
- **Concurrency bugs**: Does the ConcurrencyLimiter work under real load?
- **Token waste**: Are agents looping without making progress? → Add iteration limits, check token counts

---

### Step 4: Medium-Scale Test (10-20 workers)

Scale up and let it run for 30-60 minutes. Measure:
- Commits/hour rate
- Merge success rate
- Task completion rate (complete vs failed vs blocked)
- Token cost per task
- Whether the reconciler actually catches and fixes build breaks
- Whether VoxelCraft is actually taking shape (can you run `npm run dev`?)

---

### Step 5: Dashboard (for the demo)

Build `packages/dashboard` — a live web UI that makes the hackathon demo visually compelling:

| Panel | Shows |
|-------|-------|
| Agent Grid | Live status of all active sandboxes (idle, working, done, failed) |
| Commit Feed | Real-time stream of commits landing on main |
| Metrics | Commits/hr, tasks completed, merge success rate, token cost |
| Log Viewer | Agent conversation replay (what the LLM said, what tools it used) |
| VoxelCraft Preview | Embedded iframe of `npm run dev` showing the game being built live |

**Tech**: React + WebSocket from orchestrator. The monitor already tracks all the metrics — just need to pipe them to a frontend.

---

### Step 6: Full-Scale Run (50-100 workers)

The hackathon demo. Requirements:
- **GIT_REPO_URL**: Push target-repo to GitHub. All sandboxes clone from there, push branches back.
- **LLM decision**: RunPod primary (~$28.72/hr, $600 budget ≈ 21hrs) + Modal GLM-5 overflow (~$50/hr from $5k). Both deployed.
- **Concurrency**: Ramp from 50 → 100 workers. Watch for Modal rate limits.
- **Run duration**: 2-6 hours depending on how fast features land.
- **Goal**: 200 features in FEATURES.json → as many as possible pass.

---

### Step 7: Polish for Demo

- Record metrics: total commits, features completed, time elapsed
- Screenshot/video of dashboard during the run
- Show VoxelCraft running in a browser (the output)
- Show the commit history (hundreds of commits from autonomous agents)

---

## Known Issues & Follow-ups

| Issue | Severity | Details |
|-------|----------|---------|
| E2E never validated | CRITICAL | The entire pipeline has never run against live Modal/RunPod. |
| GIT_REPO_URL not set | CRITICAL | .env has `GIT_REPO_URL=` (empty). Need a GitHub repo for sandboxes to clone/push. |
| Unbounded subtask fan-out | MEDIUM | Subplanner launches all subtasks concurrently. At depth-3 recursion could fan to ~1000 LLM calls. ConcurrencyLimiter helps but doesn't cap recursion breadth. |
| `shouldDecompose` heuristic is simplistic | MINOR | Scope size is a poor proxy for complexity. Good enough for now. |
| No auto-merge conflict resolution | MEDIUM | Merge conflicts are skipped + logged. At 100 workers, conflict rate could be high. |
| Pi SDK compatibility unknown | MEDIUM | worker-runner.ts imports from `@mariozechner/pi-coding-agent` — never tested against the actual package. API surface may have changed. |
| sandbox_image.py installs Pi SDK v0.52.0 | MINOR | Pinned version. May need update if API changed. |
| No dashboard | LOW | Nice-to-have for demo. System works without it. |
| No freshness mechanisms | LOW | No scratchpad or auto-summarization for long agent sessions. Workers are ephemeral (one task each), so less critical. |

---

## Environment Variables (Required for main.ts)

```env
# LLM Backend (RunPod serverless)
RUNPOD_ENDPOINT_ID=8u0fdj5jh2rlxd
RUNPOD_API_KEY=<your-key>
LLM_MODEL=glm-5

# Git (MUST be set before running)
GIT_REPO_URL=https://github.com/<org>/<repo>.git

# Optional overrides
MAX_WORKERS=4              # Default: 4. Scale up to 100.
WORKER_TIMEOUT=1800        # Default: 1800 (30 min per task)
MERGE_STRATEGY=fast-forward # Options: fast-forward, rebase, merge-commit
TARGET_REPO_PATH=./target-repo
PYTHON_PATH=python3
LLM_MAX_TOKENS=8192
LLM_TEMPERATURE=0.7
```

## GLM-5 on Modal (Self-Hosted)

```bash
# Deploy (costs ~$50/hr while running, scales to zero when idle)
modal deploy infra/deploy_glm5.py

# Test the endpoint
modal run infra/deploy_glm5.py --content "Hello, what can you do?"

# Endpoint URL pattern:
# https://<workspace>--glm5-inference-glm5.modal.direct
# OpenAI-compatible: POST /v1/chat/completions
```

Uses official `lmsysorg/sglang:glm5-blackwell` Docker image with EAGLE speculative decoding.
Config follows SGLang cookbook: https://cookbook.sglang.io/autoregressive/GLM/GLM-5
