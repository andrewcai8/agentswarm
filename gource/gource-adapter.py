#!/usr/bin/env python3
"""
Gource Adapter for Longshot
==============================
Reads Longshot NDJSON events from stdin and outputs Gource Custom Log Format.

Gource format:  timestamp|username|type|file|colour

Usage:
    # Pipe from orchestrator:
    node packages/orchestrator/dist/main.js | python gource-adapter.py | gource --log-format custom -

    # Pipe from dashboard demo:
    python dashboard.py --demo --json-only | python gource-adapter.py | gource --log-format custom -

    # From a saved NDJSON log file:
    python gource-adapter.py < logs/run-2026-02-14.ndjson > session.gource
    gource --log-format custom session.gource

    # From poke-server SSE:
    curl -sN http://localhost:8787/events | python gource-adapter.py --sse | gource --log-format custom -

    # Generate standalone demo (no orchestrator):
    python gource-adapter.py --demo | gource --log-format custom -
    python gource-adapter.py --demo --save demo.gource   # save to file
"""

from __future__ import annotations

import argparse
import json
import math
import random
import re
import sys
import time

# ── Colour palette (hex, no #) ──────────────────────────────────────────────

ROLE_COLOURS = {
    "root-planner": "88CCEE",
    "planner":      "A5B4FC",
    "subplanner":   "C4B5FD",
    "worker":       "86EFAC",
    "reconciler":   "FDE68A",
}

STATUS_COLOURS = {
    "complete": "00AAFF",
    "failed":   "FF0000",
    "merged":   "AA00FF",
    "conflict": "FF4444",
    "cancelled":"666666",
}

# ── State ────────────────────────────────────────────────────────────────────

_parent_cache: dict[str, str | None] = {}
_desc_cache: dict[str, str] = {}


def _infer_parent(task_id: str) -> str | None:
    m = re.match(r"^(.*)-sub-\d+$", task_id)
    return m.group(1) if m else None


def _task_path(task_id: str, role_group: str) -> str:
    """Build a Gource file path from the task hierarchy."""
    parts: list[str] = []
    current: str | None = task_id
    seen: set[str] = set()
    while current and current not in seen:
        seen.add(current)
        parts.append(current)
        if current in _parent_cache:
            current = _parent_cache[current]
        else:
            current = _infer_parent(current)
    parts.reverse()
    return f"swarm/{role_group}/{'/'.join(parts)}"


def _colour(msg: str, status: str | None = None, role: str = "") -> str:
    if status and status in STATUS_COLOURS:
        return STATUS_COLOURS[status]
    if role and role in ROLE_COLOURS:
        return ROLE_COLOURS[role]
    # Fallback heuristic
    ml = msg.lower()
    if "created" in ml or "spawned" in ml:
        return "00FF00"
    if "completed" in ml or "success" in ml:
        return "00AAFF"
    if "failed" in ml or "error" in ml:
        return "FF0000"
    if "merge" in ml:
        return "AA00FF"
    return "FFFFFF"


def _username(agent_id: str, agent_role: str, task_id: str) -> str:
    if agent_role == "root-planner":
        return "root-planner"
    if agent_role == "reconciler":
        return "reconciler"
    if task_id.startswith("agent-") or task_id.startswith("feat-"):
        base = task_id.split("-sub-")[0]
        return base
    if agent_id and agent_id not in ("main", "monitor", "worker-pool", "planner", "state-writer"):
        return agent_id
    return agent_role or "orchestrator"


def _emit(ts: int, user: str, action: str, path: str, colour: str):
    user = user.replace("|", "")
    path = path.replace("|", "")
    sys.stdout.write(f"{ts}|{user}|{action}|{path}|{colour}\n")
    sys.stdout.flush()


# ── NDJSON → Gource ─────────────────────────────────────────────────────────

def process_event(event: dict) -> None:
    msg = event.get("message", "")
    data = event.get("data") or {}
    agent_role = event.get("agentRole", "")
    agent_id = event.get("agentId", "")
    raw_ts = event.get("timestamp", 0)

    ts = int(raw_ts / 1000) if raw_ts > 1_000_000_000_000 else int(raw_ts)
    if ts == 0:
        ts = int(time.time())

    task_id = str(data.get("taskId") or event.get("taskId") or "")
    parent_id = data.get("parentId") or data.get("parentTaskId")

    if task_id and parent_id:
        _parent_cache[task_id] = str(parent_id)
    if task_id and data.get("desc"):
        _desc_cache[task_id] = str(data["desc"])

    role_group = f"{agent_role}s" if agent_role else "system"
    user = _username(agent_id, agent_role, task_id)

    if msg == "Task created" and task_id:
        path = _task_path(task_id, role_group)
        _emit(ts, user, "A", path, _colour(msg, role=agent_role))

    elif msg == "Task status" and task_id:
        new_status = data.get("to", "")
        path = _task_path(task_id, role_group)
        if new_status in ("complete", "failed", "cancelled"):
            _emit(ts, user, "D", path, _colour(msg, status=new_status))
        else:
            _emit(ts, user, "M", path, _colour(msg, role=agent_role))

    elif msg == "Task completed" and task_id:
        status = str(data.get("status", "complete"))
        path = _task_path(task_id, role_group)
        _emit(ts, user, "D", path, _colour(msg, status=status))

    elif msg == "Dispatching task to ephemeral sandbox" and task_id:
        path = _task_path(task_id, "workers")
        _emit(ts, user, "M", path, ROLE_COLOURS["worker"])

    elif msg == "Calling LLM for task decomposition":
        ptid = str(data.get("parentTaskId") or event.get("taskId") or "")
        if ptid:
            path = _task_path(ptid, "subplanners")
            _emit(ts, user, "M", path, ROLE_COLOURS["subplanner"])

    elif msg == "Subtask still complex — recursing":
        sid = str(data.get("subtaskId", ""))
        if sid:
            path = _task_path(sid, "subplanners")
            _emit(ts, user, "A", path, ROLE_COLOURS["subplanner"])

    elif msg == "Merge result":
        branch = str(data.get("branch", "")).replace("/", "_")
        status = str(data.get("status", "merged"))
        c = STATUS_COLOURS.get(status, "AA00FF")
        _emit(ts, user, "M", f"swarm/merges/{branch}", c)

    elif msg == "Reconciler created fix tasks":
        count = int(data.get("count", 1))
        for i in range(count):
            _emit(ts, "reconciler", "A", f"swarm/fixes/fix-{ts}-{i}", ROLE_COLOURS["reconciler"])

    elif msg == "Sweep check results":
        ok = data.get("buildOk") and data.get("testsOk")
        c = "00AAFF" if ok else "FF0000"
        _emit(ts, "reconciler", "M", "swarm/health/sweep", c)

    elif msg == "Iteration complete":
        it = data.get("iteration", 0)
        _emit(ts, "root-planner", "A", f"swarm/iterations/iter-{it}", ROLE_COLOURS["root-planner"])


# ── SSE parser ───────────────────────────────────────────────────────────────

def _read_sse(stream):
    for line in stream:
        line = line.strip()
        if line.startswith("data: "):
            try:
                yield json.loads(line[6:])
            except json.JSONDecodeError:
                pass


# ── Demo generator ───────────────────────────────────────────────────────────
# Outputs Gource lines directly with timestamps spread across simulated hours
# so Gource has time to animate.

DEMO_DESCS = [
    "Implement chunk meshing system", "Add block face culling",
    "Create player controller", "Setup WebGL2 renderer",
    "Build terrain noise generator", "Add skybox shader",
    "Implement block placement", "Create inventory UI overlay",
    "Add ambient occlusion", "Build water flow simulation",
    "Setup collision detection", "Create world save/load",
    "Add fog distance shader", "Implement biome blending",
    "Build particle system", "Add block breaking animation",
    "Create crafting grid UI", "Implement greedy meshing",
    "Add texture atlas packer", "Build chunk LOD system",
]


def run_demo(max_agents: int, total_features: int, save_path: str | None):
    """Massive Minecraft-themed Gource demo — hundreds of agents swarming.

    Many named orchestrators, sub-planners, and workers all active at once.
    Deep chained sub-agents, rapid pace, wide spread to fill the window.
    """
    total_features = max(total_features, 300)
    max_agents = max(max_agents, 60)

    base = int(time.time()) - (int(time.time()) % 86400)
    step = max(1, (86400 * 30) // (total_features * 10))

    out = sys.stdout
    fh = None
    if save_path:
        fh = open(save_path, "w")
        out = fh

    def emit(ts, user, action, path, colour):
        out.write(f"{ts}|{user}|{action}|{path}|{colour}\n")
        out.flush()

    # Minecraft systems — many top-level branches to spread wide
    SYSTEMS = [
        "chunk-meshing", "block-physics", "redstone-sim", "mob-ai",
        "terrain-gen", "biome-blend", "skybox-shader", "water-flow",
        "inventory-ui", "crafting-grid", "world-save", "multiplayer-net",
        "particle-fx", "lighting-engine", "collision", "texture-atlas",
        "entity-render", "nbt-parser", "command-block", "enchantment-sys",
        "world-gen", "chunk-loading", "block-registry", "recipe-sys",
        "pathfinding", "spawn-logic", "weather-sim", "sound-engine",
        "chat-system", "scoreboard", "dimension-mgr", "loot-tables",
    ]

    VERBS = [
        "optimize", "refactor", "debug", "implement", "test",
        "benchmark", "wire-up", "integrate", "fix", "extend",
        "compile", "validate", "serialize", "render", "dispatch",
    ]

    # Many distinct named agents
    ORCHESTRATORS = [f"orch-{i}" for i in range(1, 8)]
    SUBPLANNERS = [f"subplan-{i}" for i in range(1, 15)]
    WORKERS = [f"worker-{i}" for i in range(1, 30)]

    sim_ts = base
    task_n = 0
    sub_n = 0
    done = 0
    failed = 0
    active: dict[str, int] = {}
    lifetime: dict[str, int] = {}
    paths: dict[str, str] = {}
    owners: dict[str, str] = {}
    # Track chains: parent_tid → list of child tids
    children: dict[str, list[str]] = {}

    while done + failed < total_features:
        # Rapid pacing — mostly fast ticks
        r = random.random()
        if r < 0.05:
            sim_ts += random.randint(step * 2, step * 4)
        elif r < 0.55:
            sim_ts += random.randint(1, max(1, step // 4))
        else:
            sim_ts += random.randint(step // 4, step // 2)

        # Complete expired tasks
        for tid, start_t in list(active.items()):
            life = lifetime.get(tid, step * 4)
            if sim_ts - start_t > life:
                ok = random.random() < 0.82
                status = "complete" if ok else "failed"
                c = STATUS_COLOURS[status]
                owner = owners.get(tid, random.choice(WORKERS))
                # Use "M" (modify) instead of "D" (delete) so files stay visible
                emit(sim_ts, owner, "M", paths[tid], c)
                if ok:
                    done += 1
                else:
                    failed += 1
                del active[tid]

        # Multiple agents roam simultaneously
        if active:
            roam_count = random.randint(1, min(4, len(active)))
            for _ in range(roam_count):
                if random.random() < 0.25:
                    tid = random.choice(list(active.keys()))
                    agent = random.choice(ORCHESTRATORS + SUBPLANNERS)
                    emit(sim_ts, agent, "M", paths[tid], "88CCEE")

        # Aggressive spawning — bursts of 3-8
        elapsed_frac = min(1.0, (sim_ts - base) / (86400 * 8))
        target = max(5, int(max_agents * elapsed_frac))
        spawn_n = random.choice([2, 3, 4, 5, 5, 6, 8])

        for _ in range(spawn_n):
            if len(active) >= target or task_n >= total_features:
                break
            task_n += 1
            system = random.choice(SYSTEMS)

            # Chain off existing active tasks 50% of the time (deep sub-agents)
            parent_tid = None
            if active and random.random() < 0.50:
                parent_tid = random.choice(list(active.keys()))

            if parent_tid:
                sub_n += 1
                verb = random.choice(VERBS)
                tid = f"{parent_tid}/{verb}-{sub_n:03d}"
                path = paths[parent_tid] + f"/{verb}-{sub_n:03d}"
                owner = random.choice(SUBPLANNERS + WORKERS)
                children.setdefault(parent_tid, []).append(tid)
            else:
                verb = random.choice(VERBS)
                tid = f"{system}-{verb}-{task_n:03d}"
                path = f"minecraft/{system}/{verb}/{tid}"
                owner = random.choice(ORCHESTRATORS)

            paths[tid] = path
            owners[tid] = owner

            # Short lifetimes to keep churn high
            lr = random.random()
            if lr < 0.4:
                lifetime[tid] = random.randint(step, step * 3)
            elif lr < 0.8:
                lifetime[tid] = random.randint(step * 3, step * 6)
            else:
                lifetime[tid] = random.randint(step * 6, step * 10)

            # Creator is an orchestrator or subplanner
            creator = random.choice(ORCHESTRATORS)
            emit(sim_ts, creator, "A", path, ROLE_COLOURS["root-planner"])

            # Owner picks it up
            sim_ts += random.randint(1, max(1, step // 8))
            role_c = ROLE_COLOURS["worker"] if "worker" in owner else ROLE_COLOURS["subplanner"]
            emit(sim_ts, owner, "M", path, role_c)
            active[tid] = sim_ts

        # Many agents touching their active tasks simultaneously
        touch_count = min(len(active), random.randint(2, 8))
        if active:
            for tid in random.sample(list(active.keys()), touch_count):
                if random.random() < 0.12:
                    owner = owners.get(tid, random.choice(WORKERS))
                    emit(sim_ts, owner, "M", paths[tid], ROLE_COLOURS["worker"])

    emit(sim_ts + step, random.choice(ORCHESTRATORS), "M", "minecraft/COMPLETE", "00AAFF")

    if fh:
        fh.close()
        print(f"Saved: {save_path}", file=sys.stderr)


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description="Longshot → Gource adapter")
    ap.add_argument("--sse", action="store_true",
                    help="Read SSE (text/event-stream) from stdin instead of raw NDJSON")
    ap.add_argument("--demo", action="store_true",
                    help="Generate standalone demo log (no orchestrator needed)")
    ap.add_argument("--save", metavar="FILE",
                    help="With --demo: save to file instead of stdout")
    ap.add_argument("--agents", type=int, default=20,
                    help="Demo: max concurrent agents (default 20)")
    ap.add_argument("--features", type=int, default=60,
                    help="Demo: total features (default 60)")
    args = ap.parse_args()

    try:
        if args.demo:
            run_demo(args.agents, args.features, args.save)
        elif args.sse:
            for event in _read_sse(sys.stdin):
                process_event(event)
        else:
            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                try:
                    process_event(json.loads(line))
                except json.JSONDecodeError:
                    pass
    except (KeyboardInterrupt, BrokenPipeError):
        pass


if __name__ == "__main__":
    main()
