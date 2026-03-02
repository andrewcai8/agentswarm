#!/usr/bin/env python3
"""
Longshot Dashboard -- Rich Terminal UI
=========================================
Real-time monitoring for the massively parallel autonomous coding system.
Reads NDJSON from the TypeScript orchestrator and renders a fullscreen
multi-panel dashboard at 4 Hz.

Usage:
    python dashboard.py --demo                  # synthetic data (no orchestrator needed)
    python dashboard.py --demo --agents 100     # demo with 100 agent slots
    python dashboard.py --follow                # tail latest logs/run-*.ndjson live (use with Poke)
    node packages/orchestrator/dist/main.js | python dashboard.py --stdin
    python dashboard.py                         # spawns orchestrator subprocess
Controls:
    + / -                                       # zoom planner tree levels in/out
    tab                                         # switch between Agent Grid and Activity tabs
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import random
import re
import select
import subprocess
import sys
import termios
import threading
import time
import tty
from collections import deque
from datetime import datetime, timedelta
from typing import Any

try:
    from rich.console import Console
    from rich.layout import Layout
    from rich.live import Live
    from rich.panel import Panel
    from rich.table import Table
    from rich.text import Text
except ImportError:
    print("Rich library required.  pip install rich")
    sys.exit(1)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MAX_ACTIVITY = 50
COST_PER_1K = 0.001  # default $/1K tokens -- override with --cost-rate


# ---------------------------------------------------------------------------
# Planner Tree State -- recursive root/planner/subplanner hierarchy
# ---------------------------------------------------------------------------


class PlannerTreeState:
    ROOT_ID = "root-planner"

    def __init__(self):
        self.parent: dict[str, str | None] = {self.ROOT_ID: None}
        self.children: dict[str, list[str]] = {self.ROOT_ID: []}
        self.status: dict[str, str] = {self.ROOT_ID: "running"}
        self.role: dict[str, str] = {self.ROOT_ID: "root-planner"}
        self._order: dict[str, int] = {self.ROOT_ID: 0}
        self._counter = 1
        self.desc: dict[str, str] = {}
        self.started_at: dict[str, float] = {}
        self.worker_progress: dict[str, str] = {}
        self.handoff_metrics: dict[str, dict[str, Any]] = {}

    @staticmethod
    def infer_parent_id(task_id: str) -> str | None:
        m = re.match(r"^(.*)-sub-\d+$", task_id)
        return m.group(1) if m else None

    def ensure(
        self,
        node_id: str,
        parent_id: str | None = None,
        role: str | None = None,
        desc: str = "",
    ):
        if not node_id:
            return
        if desc:
            self.desc[node_id] = desc

        if node_id == self.ROOT_ID:
            parent_id = None
        elif parent_id is None:
            parent_id = self.infer_parent_id(node_id) or self.ROOT_ID

        if node_id not in self.parent:
            self.parent[node_id] = parent_id
            self.children.setdefault(node_id, [])
            self.status.setdefault(node_id, "pending")
            if role:
                self.role[node_id] = role
            self._order[node_id] = self._counter
            self._counter += 1
        elif role:
            self.role[node_id] = role

        if parent_id is not None:
            if parent_id not in self.parent:
                parent_parent = (
                    None
                    if parent_id == self.ROOT_ID
                    else self.infer_parent_id(parent_id) or self.ROOT_ID
                )
                self.ensure(parent_id, parent_parent)
            kids = self.children.setdefault(parent_id, [])
            if node_id not in kids:
                kids.append(node_id)
            if self.parent.get(node_id) != parent_id:
                old_parent = self.parent.get(node_id)
                if old_parent and node_id in self.children.get(old_parent, []):
                    self.children[old_parent].remove(node_id)
                self.parent[node_id] = parent_id

    def update_status(
        self,
        node_id: str,
        status: str,
        parent_id: str | None = None,
        role: str | None = None,
        desc: str = "",
    ):
        self.ensure(node_id, parent_id, role, desc)
        self.status[node_id] = status
        if status in ("running", "assigned") and node_id not in self.started_at:
            self.started_at[node_id] = time.time()
        elif status in ("complete", "failed", "cancelled"):
            self.started_at.pop(node_id, None)

    def _depth_map(self) -> dict[str, int]:
        depth = {self.ROOT_ID: 0}
        q = deque([self.ROOT_ID])
        while q:
            cur = q.popleft()
            for child in self.children.get(cur, []):
                depth[child] = depth[cur] + 1
                q.append(child)
        return depth

    def snapshot(self) -> dict[str, Any]:
        depth = self._depth_map()

        status_progress = {
            "idle": 0.0,
            "pending": 0.1,
            "assigned": 0.25,
            "running": 0.6,
            "complete": 1.0,
            "failed": 1.0,
            "cancelled": 1.0,
        }

        progress: dict[str, float] = {}

        def calc(node_id: str) -> float:
            if node_id in progress:
                return progress[node_id]
            kids = self.children.get(node_id, [])
            st = self.status.get(node_id, "pending")
            if st in ("complete", "failed", "cancelled"):
                p = 1.0
            elif kids:
                vals = [calc(k) for k in kids]
                p = sum(vals) / max(len(vals), 1)
            else:
                p = status_progress.get(st, 0.0)
            progress[node_id] = max(0.0, min(1.0, p))
            return progress[node_id]

        calc(self.ROOT_ID)

        nodes: dict[str, dict[str, Any]] = {}
        for node_id, node_depth in depth.items():
            kids = sorted(self.children.get(node_id, []), key=lambda x: self._order.get(x, 0))
            node_role = self.role.get(node_id)
            if not node_role:
                node_role = "planner" if node_depth == 1 else "subplanner"
            nodes[node_id] = {
                "id": node_id,
                "depth": node_depth,
                "status": self.status.get(node_id, "pending"),
                "progress": progress.get(node_id, 0.0),
                "children": kids,
                "role": node_role,
                "desc": self.desc.get(node_id, ""),
                "started_at": self.started_at.get(node_id),
                "worker_progress": self.worker_progress.get(node_id, ""),
                "handoff_metrics": self.handoff_metrics.get(node_id),
            }

        max_depth = max(depth.values()) if depth else 0
        return {"root": self.ROOT_ID, "nodes": nodes, "max_depth": max_depth}


# ---------------------------------------------------------------------------
# Shared Dashboard State (thread-safe)
# ---------------------------------------------------------------------------


class DashboardState:
    def __init__(self, max_agents: int, total_features: int, cost_rate: float):
        self._lock = threading.RLock()
        self.start_time = time.time()
        self.cost_rate = cost_rate

        # MetricsSnapshot fields
        self.active_workers = 0
        self.pending_tasks = 0
        self.completed_tasks = 0
        self.failed_tasks = 0
        self.commits_per_hour = 0.0
        self.merge_success_rate = 0.0
        self.total_tokens = 0
        self.estimated_in_flight = 0

        # Planner tree
        self.tree = PlannerTreeState()
        self.max_agents = max_agents
        self.total_features = total_features
        self.visible_levels = 2
        self.active_tab = "grid"
        self.in_progress_scroll = 0
        self.completed_scroll = 0

        # Merge
        self.merge_merged = 0
        self.merge_conflicts = 0
        self.merge_failed = 0

        # Activity feed
        self.activity: deque[tuple[str, str, str]] = deque(maxlen=MAX_ACTIVITY)

        # Lines added (cumulative)
        self.lines_added = 0

        # Iteration counter
        self.iteration = 0

        self.planner_thinking = False
        self.planner_thinking_since = 0.0
        self.completion_times: deque[float] = deque(maxlen=300)

    def _derive_counts_from_tree(self):
        """Derive task counts from tree state for real-time updates between Monitor polls."""
        running = 0
        pending = 0
        completed = 0
        failed = 0
        for node_id, status in self.tree.status.items():
            if node_id == PlannerTreeState.ROOT_ID:
                continue
            if status in ("running", "assigned"):
                running += 1
            elif status == "pending":
                pending += 1
            elif status == "complete":
                completed += 1
            elif status == "failed":
                failed += 1
        self.active_workers = running
        self.pending_tasks = pending
        self.completed_tasks = completed
        self.failed_tasks = failed

    @staticmethod
    def _event_node_role(agent_role: str) -> str | None:
        if agent_role == "subplanner":
            return "subplanner"
        if agent_role == "worker":
            return "worker"
        return None

    def adjust_visible_levels(self, delta: int):
        with self._lock:
            cap = self._current_level_cap_locked()
            self.visible_levels = max(1, min(cap, self.visible_levels + delta))

    def switch_tab(self, direction: int = 1):
        with self._lock:
            tabs = ["grid", "activity"]
            i = tabs.index(self.active_tab) if self.active_tab in tabs else 0
            self.active_tab = tabs[(i + direction) % len(tabs)]

    def set_tab(self, tab: str):
        with self._lock:
            if tab in ("grid", "activity"):
                self.active_tab = tab

    def adjust_tree_scroll(self, pane: str, delta: int):
        with self._lock:
            if pane == "in_progress":
                self.in_progress_scroll = max(0, self.in_progress_scroll + delta)
            elif pane == "completed":
                self.completed_scroll = max(0, self.completed_scroll + delta)

    def _current_level_cap_locked(self) -> int:
        tree_snapshot = self.tree.snapshot()
        active_depths = [
            n["depth"]
            for n in tree_snapshot["nodes"].values()
            if n["status"] in ("pending", "assigned", "running")
        ]
        return max(1, (max(active_depths) if active_depths else 0) + 1)

    def ingest(self, event: dict[str, Any]):
        with self._lock:
            msg = event.get("message", "")
            data = event.get("data") or {}
            level = event.get("level", "info")
            agent_role = event.get("agentRole", "")
            ts = event.get("timestamp", 0)
            ts_str = (
                datetime.fromtimestamp(ts / 1000).strftime("%H:%M:%S")
                if ts
                else time.strftime("%H:%M:%S")
            )

            event_task_id = str(data.get("taskId") or event.get("taskId") or "")
            node_role = self._event_node_role(agent_role)

            if event_task_id:
                parent_id = (
                    data.get("parentId")
                    or data.get("parentTaskId")
                    or PlannerTreeState.infer_parent_id(event_task_id)
                )
                self.tree.ensure(event_task_id, parent_id, node_role)

            # -- Metrics snapshot (periodic from Monitor) -------------------
            if msg == "Metrics":
                self.active_workers = data.get("activeWorkers", self.active_workers)
                self.pending_tasks = data.get("pendingTasks", self.pending_tasks)
                self.completed_tasks = data.get("completedTasks", self.completed_tasks)
                self.failed_tasks = data.get("failedTasks", self.failed_tasks)
                self.commits_per_hour = data.get("commitsPerHour", self.commits_per_hour)
                self.merge_success_rate = data.get("mergeSuccessRate", self.merge_success_rate)
                self.total_tokens = data.get("totalTokensUsed", self.total_tokens)
                self.estimated_in_flight = data.get("estimatedInFlightTokens", 0)

            # -- Per-task lifecycle (from wired TaskQueue.onStatusChange) ----
            elif msg == "Task status":
                task_id = data.get("taskId", "")
                new_st = data.get("to", "")
                if task_id and new_st:
                    parent_id = data.get("parentId") or data.get("parentTaskId")
                    self.tree.update_status(
                        task_id, new_st, parent_id, node_role, desc=data.get("desc", "")
                    )

            # -- Task created (from Planner callback) -----------------------
            elif msg == "Task created":
                task_id = data.get("taskId", "")
                desc = data.get("desc", "")
                if task_id:
                    parent_id = data.get("parentId") or data.get("parentTaskId")
                    self.tree.update_status(task_id, "pending", parent_id, node_role, desc=desc)
                self.planner_thinking = False
                self._feed(ts_str, f"  + {task_id}  {desc[:52]}", "cyan")

            # -- Task completed ---------------------------------------------
            elif msg == "Task completed":
                task_id = data.get("taskId", "")
                status = data.get("status", "")
                final = "complete" if status in ("complete", "partial") else "failed"
                if task_id:
                    parent_id = data.get("parentId") or data.get("parentTaskId")
                    self.tree.update_status(task_id, final, parent_id, node_role)
                if task_id and data.get("linesAdded") is not None:
                    self.tree.handoff_metrics[task_id] = {
                        "linesAdded": data.get("linesAdded", 0),
                        "linesRemoved": data.get("linesRemoved", 0),
                        "filesChanged": data.get("filesChanged", 0),
                        "tokensUsed": data.get("tokensUsed", 0),
                        "durationMs": data.get("durationMs", 0),
                        "summary": (data.get("summary") or "")[:80],
                    }
                if final == "complete":
                    self.completion_times.append(time.time())
                style = "green" if final == "complete" else "red"
                self._feed(ts_str, f"  {task_id}  {status}", style)

            # -- Worker dispatched ------------------------------------------
            elif msg == "Dispatching task to ephemeral sandbox":
                task_id = data.get("taskId", "")
                if task_id:
                    parent_id = data.get("parentId") or data.get("parentTaskId")
                    self.tree.update_status(task_id, "assigned", parent_id, node_role)

            # -- Subplanner decomposition lifecycle -------------------------
            elif msg == "Calling LLM for task decomposition":
                self.planner_thinking = True
                self.planner_thinking_since = time.time()
                parent_task_id = data.get("parentTaskId") or event.get("taskId")
                if parent_task_id:
                    parent_parent = PlannerTreeState.infer_parent_id(str(parent_task_id))
                    self.tree.update_status(
                        str(parent_task_id),
                        "running",
                        parent_parent,
                        "subplanner",
                    )

            elif msg == "Subtask still complex — recursing":
                subtask_id = data.get("subtaskId", "")
                if subtask_id:
                    parent_id = (
                        data.get("parentId")
                        or data.get("parentTaskId")
                        or PlannerTreeState.infer_parent_id(str(subtask_id))
                    )
                    self.tree.update_status(str(subtask_id), "running", parent_id, "subplanner")

            elif msg == "Subtask completed by worker":
                subtask_id = data.get("subtaskId", "")
                if subtask_id:
                    parent_id = (
                        data.get("parentId")
                        or data.get("parentTaskId")
                        or PlannerTreeState.infer_parent_id(str(subtask_id))
                    )
                    status = data.get("status", "")
                    final = "complete" if status in ("complete", "partial") else "failed"
                    self.tree.update_status(str(subtask_id), final, parent_id)

            # -- Merge results (from new planner logging) -------------------
            elif msg == "Merge result":
                status = data.get("status", "")
                branch = data.get("branch", "")[:30]
                if status == "merged":
                    self.merge_merged += 1
                    self._feed(ts_str, f"  >> merged  {branch}", "green")
                elif status == "conflict":
                    self.merge_conflicts += 1
                    self._feed(ts_str, f"  !! conflict  {branch}", "yellow")
                else:
                    self.merge_failed += 1
                    self._feed(ts_str, f"  xx merge fail  {branch}", "red")

            # -- Iteration --------------------------------------------------
            elif msg == "Iteration complete":
                self.planner_thinking = False
                self.iteration = data.get("iteration", self.iteration)
                n = data.get("tasks", 0)
                self._feed(ts_str, f"  -- iteration {self.iteration}  ({n} tasks)", "blue")

            # -- Reconciler -------------------------------------------------
            elif msg == "Reconciler created fix tasks":
                c = data.get("count", 0)
                self._feed(ts_str, f"  reconciler  {c} fix tasks", "yellow")

            elif msg == "Sweep check results":
                ok = data.get("buildOk") and data.get("testsOk")
                label = "all green" if ok else "NEEDS FIX"
                self._feed(ts_str, f"  sweep: {label}", "green" if ok else "red")

            # -- Worker progress (streamed from Modal sandboxes) ----------
            elif msg == "Worker progress":
                task_id = data.get("taskId", "")
                phase = data.get("phase", "")
                detail = (data.get("detail") or "")[:60]
                if task_id:
                    self.tree.worker_progress[task_id] = detail
                if phase == "sandbox":
                    self._feed(ts_str, f"  \u2699 {task_id}  {detail}", "cyan")
                else:
                    self._feed(ts_str, f"  \u25b8 {task_id}  {detail}", "dim")

            # -- Timeouts / errors ------------------------------------------
            elif msg == "Worker timed out":
                tid = data.get("taskId", "")
                if tid:
                    self.tree.update_status(
                        tid,
                        "failed",
                        data.get("parentId") or data.get("parentTaskId"),
                        node_role,
                    )
                self._feed(ts_str, f"  TIMEOUT  {tid}", "bold red")

            elif level == "error":
                if agent_role == "planner" or agent_role == "root-planner":
                    self.planner_thinking = False
                self._feed(ts_str, f"  ERR  {msg[:60]}", "bold red")

            self._derive_counts_from_tree()

    def _feed(self, ts: str, msg: str, style: str):
        self.activity.appendleft((ts, msg, style))

    # -- snapshot for renderers ---------------------------------------------

    def snap(self) -> dict[str, Any]:
        with self._lock:
            elapsed = time.time() - self.start_time
            total_merge = self.merge_merged + self.merge_conflicts + self.merge_failed
            tree_snapshot = self.tree.snapshot()
            active_depths = [
                n["depth"]
                for n in tree_snapshot["nodes"].values()
                if n["status"] in ("pending", "assigned", "running")
            ]
            tree_snapshot["active_max_depth"] = max(active_depths) if active_depths else 0
            cap = max(1, tree_snapshot["active_max_depth"] + 1)
            self.visible_levels = max(1, min(self.visible_levels, cap))
            total_tasks = (
                self.active_workers + self.pending_tasks + self.completed_tasks + self.failed_tasks
            )
            return {
                "elapsed": elapsed,
                "active": self.active_workers,
                "pending": self.pending_tasks,
                "completed": self.completed_tasks,
                "failed": self.failed_tasks,
                "cph": self.commits_per_hour,
                "merge_rate": self.merge_success_rate,
                "tokens": self.total_tokens,
                "estimated_in_flight": self.estimated_in_flight,
                "cost": self.total_tokens / 1000.0 * self.cost_rate,
                "max_agents": self.max_agents,
                "total_tasks": total_tasks,
                "merge_merged": self.merge_merged,
                "merge_conflicts": self.merge_conflicts,
                "merge_failed": self.merge_failed,
                "merge_total": total_merge,
                "activity": list(self.activity),
                "iteration": self.iteration,
                "tree": tree_snapshot,
                "visible_levels": self.visible_levels,
                "active_tab": self.active_tab,
                "in_progress_scroll": self.in_progress_scroll,
                "completed_scroll": self.completed_scroll,
                "planner_thinking": self.planner_thinking,
                "planner_thinking_since": self.planner_thinking_since,
                "recent_velocity": self._compute_velocity(),
                "sparkline": self._compute_sparkline(),
            }

    def _compute_velocity(self) -> float:
        now = time.time()
        cutoff = now - 60
        return sum(1 for t in self.completion_times if t > cutoff)

    def _compute_sparkline(self) -> str:
        now = time.time()
        buckets = [0] * 10
        bucket_width = 30.0
        for t in self.completion_times:
            age = now - t
            if age > 300:
                continue
            idx = min(9, int(age / bucket_width))
            buckets[9 - idx] += 1
        chars = " ▁▂▃▄▅▆▇█"
        mx = max(max(buckets), 1)
        return "".join(chars[min(len(chars) - 1, int(b / mx * (len(chars) - 1)))] for b in buckets)


# ---------------------------------------------------------------------------
# Layout
# ---------------------------------------------------------------------------


def make_layout() -> Layout:
    root = Layout(name="root")
    root.split_column(
        Layout(name="header", size=3),
        Layout(name="body", ratio=1),
        Layout(name="footer_row", size=5),
    )
    root["body"].split_row(
        Layout(name="left", size=30, minimum_size=26),
        Layout(name="right", ratio=1, minimum_size=40),
    )
    root["footer_row"].split_row(
        Layout(name="footer", ratio=1),
        Layout(name="controls", ratio=1),
    )
    root["left"].split_column(
        Layout(name="metrics", ratio=1),
        Layout(name="merge", size=9),
    )
    return root


def apply_tab_layout(layout: Layout, active_tab: str):
    _ = active_tab
    layout["header"].visible = True
    layout["footer_row"].visible = True
    layout["left"].visible = True
    layout["right"].visible = True


def _grid_pane_from_mouse(mouse_x: int, mouse_y: int, term_w: int, term_h: int) -> str | None:
    _ = mouse_y
    _ = term_h
    left_width = 30
    right_start = left_width + 2
    if mouse_x < right_start:
        return None
    right_width = max(1, term_w - left_width)
    split = right_start + (right_width // 2)
    return "in_progress" if mouse_x < split else "completed"


# ---------------------------------------------------------------------------
# Panel renderers
# ---------------------------------------------------------------------------


def _fmt_tokens(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)


def _elapsed_str(s: float) -> str:
    h = int(s // 3600)
    m = int((s % 3600) // 60)
    sec = int(s % 60)
    return f"{h:02d}:{m:02d}:{sec:02d}"


def render_header(s: dict[str, Any]) -> Panel:
    tbl = Table.grid(expand=True)
    tbl.add_column(justify="left", ratio=1)
    tbl.add_column(justify="center", ratio=1)
    tbl.add_column(justify="right", ratio=1)

    elapsed = _elapsed_str(s["elapsed"])
    active = s["active"]
    total = s["total_tasks"]
    merged = s["merge_merged"]

    if s.get("planner_thinking"):
        thinking_sec = int(time.time() - s.get("planner_thinking_since", time.time()))
        dots = "●" * ((int(time.time() * 2) % 3) + 1)
        center = f"[bold bright_yellow]PLANNING {dots}[/] [dim]({thinking_sec}s)[/]"
    else:
        center = (
            f"[bold bright_white]{active}[/] [dim]active[/]"
            f"  [bold bright_white]{total}[/] [dim]total[/]"
        )

    tbl.add_row(
        f"[bold bright_cyan]LONGSHOT[/]  [dim]{elapsed}[/]",
        center,
        f"[bold bright_green]{merged}[/] [dim]merged[/]",
    )
    return Panel(tbl, style="bright_cyan", height=3)


def render_metrics(s: dict[str, Any]) -> Panel:
    tbl = Table(show_header=False, box=None, padding=(0, 1), expand=True)
    tbl.add_column("k", style="dim", no_wrap=True, width=13)
    tbl.add_column("v", justify="right")

    done = s["completed"]
    total = s["total_tasks"]
    pct = done / total * 100 if total else 0
    rate = s["merge_rate"]
    rate_color = "bright_green" if rate > 0.9 else "yellow" if rate > 0.7 else "bright_red"

    tbl.add_row("Iteration", f"[bright_white]{s['iteration']}[/]")
    tbl.add_row("Commits/hr", f"[bright_green]{s['cph']:,.0f}[/]")
    tbl.add_row("Completed", f"[bright_green]{done}[/][dim]/{total}  {pct:.0f}%[/]")
    tbl.add_row("Failed", f"[bright_red]{s['failed']}[/]" if s["failed"] else "[dim]0[/]")
    tbl.add_row("Pending", f"[yellow]{s['pending']}[/]" if s["pending"] else "[dim]0[/]")
    tbl.add_row("Merge rate", f"[{rate_color}]{rate * 100:.1f}%[/]")
    in_flight = s.get("estimated_in_flight", 0)
    token_label = f"[bright_cyan]{_fmt_tokens(s['tokens'])}[/]"
    if in_flight > 0:
        token_label += f" [dim](~+{_fmt_tokens(in_flight)} wip)[/]"
    tbl.add_row("Tokens", token_label)
    tbl.add_row("Est. cost", f"[bright_cyan]${s['cost']:.2f}[/]")

    sparkline = s.get("sparkline", "          ")
    velocity = s.get("recent_velocity", 0)
    tbl.add_row(
        "Velocity", f"[bright_green]{sparkline}[/] [bright_white]{velocity:.1f}[/][dim]/min[/]"
    )
    tbl.add_row("Running", f"[bright_yellow]{s['active']}[/]" if s["active"] else "[dim]0[/]")

    return Panel(tbl, title="[bold]METRICS[/]", border_style="bright_blue")


def _tabs_title(active_tab: str) -> str:
    if active_tab == "activity":
        return "[dim]Agent Grid[/]  [reverse] Activity [/]"
    return "[reverse] Agent Grid [/]  [dim]Activity[/]"


def render_grid(s: dict[str, Any]) -> Panel:
    tree_data = s["tree"]
    nodes = tree_data["nodes"]
    root_id = tree_data["root"]
    visible_levels = s["visible_levels"]
    max_visible_depth = max(0, visible_levels - 1)
    max_visible_depth = max(0, visible_levels - 1)

    def meter(progress: float, status: str) -> str:
        if status in ("failed", "cancelled"):
            return "[bright_red]■■■■[/]"
        fill = max(0, min(4, int(round(progress * 4))))
        return f"[bright_green]{'■' * fill}[/][bright_black]{'□' * (4 - fill)}[/]"

    def status_markup(status: str) -> str:
        style = {
            "running": "bright_yellow",
            "complete": "bright_green",
            "failed": "bright_red",
            "assigned": "cyan",
            "pending": "blue",
            "cancelled": "bright_red",
        }.get(status, "dim")
        return f"[{style}]{status}[/]"

    def label_for(node: dict[str, Any], muted: bool = False) -> Text:
        role = node["role"]
        role_label = {
            "root-planner": "root",
            "planner": "plan",
            "subplanner": "sub",
            "worker": "wkr",
        }.get(role, role)
        node_id = node["id"]
        if len(node_id) > 20:
            node_id = f"..{node_id[-18:]}"

        desc = node.get("desc", "")
        if desc and len(desc) > 32:
            desc = desc[:30] + ".."

        parts = [
            meter(node["progress"], node["status"]),
            f" [bold]{node_id}[/]",
            f" [dim]({role_label})[/]",
        ]
        if desc:
            parts.append(f' [italic bright_white]"{desc}"[/]')

        parts.append(f" {status_markup(node['status'])}")

        st = node["status"]
        started = node.get("started_at")
        if st in ("running", "assigned") and started:
            elapsed = int(time.time() - started)
            m, sec = divmod(elapsed, 60)
            dur_str = f"{m}m{sec:02d}s" if m else f"{sec}s"
            color = "bright_red" if elapsed > 300 else "bright_yellow" if elapsed > 180 else "dim"
            parts.append(f" [{color}][{dur_str}][/]")

        wp = node.get("worker_progress", "")
        if st in ("running", "assigned") and wp:
            parts.append(f" [dim]> {wp[:40]}[/]")

        hm = node.get("handoff_metrics")
        if st in ("complete", "failed") and hm:
            la = hm.get("linesAdded", 0)
            lr = hm.get("linesRemoved", 0)
            fc = hm.get("filesChanged", 0)
            tok = hm.get("tokensUsed", 0)
            tok_str = f"{tok / 1000:.1f}K" if tok >= 1000 else str(tok)
            parts.append(f" [dim]+{la}/-{lr} {fc}f {tok_str}tok[/]")

        txt = Text.from_markup("".join(parts))
        if muted:
            txt.stylize("dim")
        return txt

    def is_terminal(node_id: str) -> bool:
        return nodes.get(node_id, {}).get("status") in ("complete", "failed", "cancelled")

    def has_bucket(node_id: str, show_terminal: bool) -> bool:
        node = nodes.get(node_id)
        if not node:
            return False
        self_match = is_terminal(node_id) if show_terminal else not is_terminal(node_id)
        if self_match and node_id != root_id:
            return True
        return any(has_bucket(child, show_terminal) for child in node["children"])

    def hidden_descendants(node_id: str, depth: int, show_terminal: bool) -> int:
        count = 0
        for child in nodes.get(node_id, {}).get("children", []):
            if not has_bucket(child, show_terminal):
                continue
            if depth > max_visible_depth and child != root_id:
                count += 1
            count += hidden_descendants(child, depth + 1, show_terminal)
        return count

    if root_id not in nodes:
        return Panel("[dim]waiting for planner events ...[/]", title="[bold]PLANNER TREE[/]")

    def build_bucket_lines(show_terminal: bool) -> list[Text]:
        lines: list[Text] = []

        def emit(parent_id: str, depth: int, prefix: str):
            visible_children = [
                cid for cid in nodes[parent_id]["children"] if has_bucket(cid, show_terminal)
            ]
            for idx, child_id in enumerate(visible_children):
                child = nodes.get(child_id)
                if not child:
                    continue
                is_last = idx == len(visible_children) - 1
                connector = "└─ " if is_last else "├─ "
                child_match = is_terminal(child_id) if show_terminal else not is_terminal(child_id)

                line = Text()
                line.append(f"{prefix}{connector}", style="bright_black")
                line.append_text(label_for(child, muted=not child_match))
                lines.append(line)

                if depth >= max_visible_depth:
                    hidden = hidden_descendants(child_id, depth + 1, show_terminal)
                    if hidden > 0:
                        hidden_line = Text()
                        tail = "   " if is_last else "│  "
                        hidden_line.append(f"{prefix}{tail}└─ ", style="bright_black")
                        hidden_line.append(f"... {hidden} hidden", style="dim")
                        lines.append(hidden_line)
                    continue

                next_prefix = prefix + ("   " if is_last else "│  ")
                emit(child_id, depth + 1, next_prefix)

        emit(root_id, 0, "")
        if not lines:
            lines.append(Text.from_markup("[dim]none[/]"))
        return lines

    in_progress_lines = build_bucket_lines(show_terminal=False)
    completed_lines = build_bucket_lines(show_terminal=True)

    try:
        term_lines = os.get_terminal_size().lines
    except OSError:
        term_lines = 28
    # Match right-pane body height (total - header - footer - borders).
    pane_height = max(10, term_lines - 10)
    # Reserve one content row for the scroll indicator line.
    pane_window = max(3, pane_height - 3)

    def _windowed(
        lines: list[Text],
        offset: int,
        scroll_hint: str,
        window: int,
    ) -> tuple[Text, int, int]:
        max_offset = max(0, len(lines) - window)
        clamped = max(0, min(offset, max_offset))
        out = Text()
        visible = lines[clamped : clamped + window]
        for i in range(window):
            if i < len(visible):
                out.append_text(visible[i])
            if i < window - 1:
                out.append("\n")

        start = clamped + 1 if len(lines) > 0 else 0
        end = min(len(lines), clamped + window) if len(lines) > 0 else 0
        out.append("\n")
        out.append(
            f" {start}-{end}/{len(lines)} ({scroll_hint})",
            style="dim",
        )
        return out, clamped, max_offset

    in_progress_text, _, _ = _windowed(
        in_progress_lines,
        s["in_progress_scroll"],
        "w/s to scroll",
        pane_window,
    )
    completed_text, _, _ = _windowed(
        completed_lines,
        s["completed_scroll"],
        "e/d to scroll",
        pane_window,
    )

    trees = Table.grid(expand=True)
    trees.add_column(ratio=1)
    trees.add_column(ratio=1)
    trees.add_row(
        Panel(
            in_progress_text,
            title="[bold]In Progress[/]",
            border_style="bright_yellow",
            height=pane_height,
        ),
        Panel(
            completed_text,
            title="[bold]Completed[/]",
            border_style="bright_green",
            height=pane_height,
        ),
    )

    wrap = Table.grid(expand=True)
    wrap.add_column(ratio=1)
    wrap.add_row(trees)
    return Panel(
        wrap,
        title=_tabs_title(s["active_tab"]),
        border_style="bright_yellow",
    )


def render_merge(s: dict[str, Any]) -> Panel:
    rate = s["merge_rate"]
    bar_w = 20
    filled = int(rate * bar_w) if s["merge_total"] > 0 else 0
    bar = (
        "[bright_green]"
        + "\u2588" * filled
        + "[/]"
        + "[bright_black]"
        + "\u2591" * (bar_w - filled)
        + "[/]"
    )
    pct = f"{rate * 100:.0f}%" if s["merge_total"] > 0 else " -- "

    tbl = Table(show_header=False, box=None, padding=(0, 1), expand=True)
    tbl.add_column("k", style="dim", no_wrap=True, width=11)
    tbl.add_column("v", justify="right")
    tbl.add_row("Success", f"{bar} {pct}")
    tbl.add_row("Merged", f"[bright_green]{s['merge_merged']}[/]")
    tbl.add_row(
        "Conflicts", f"[yellow]{s['merge_conflicts']}[/]" if s["merge_conflicts"] else "[dim]0[/]"
    )
    tbl.add_row(
        "Failed", f"[bright_red]{s['merge_failed']}[/]" if s["merge_failed"] else "[dim]0[/]"
    )

    return Panel(tbl, title="[bold]MERGE QUEUE[/]", border_style="bright_magenta")


def render_activity(s: dict[str, Any]) -> Panel:
    logs = s["activity"]
    txt = Text()
    for ts_str, msg, style in logs:
        txt.append(f" {ts_str}", style="dim")
        txt.append(f"{msg}\n", style=style)
    if not logs:
        txt.append("  waiting for events ...", style="dim italic")
    return Panel(
        txt,
        title=_tabs_title(s["active_tab"]),
        border_style="bright_green",
    )


def render_footer(s: dict[str, Any]) -> Panel:
    done = s["completed"]
    total = s["total_tasks"]
    pct = done / total if total else 0
    bar_w = 50
    filled = int(pct * bar_w)
    bar = (
        "[bold bright_green]"
        + "\u2588" * filled
        + "[/]"
        + "[bright_black]"
        + "\u2591" * (bar_w - filled)
        + "[/]"
    )
    txt = Text.from_markup(
        f"  [bold]TASKS[/]  {bar}  [bright_white]{done}[/]"
        f"[dim]/{total}[/]  [bright_cyan]{pct * 100:.0f}%[/]"
    )
    return Panel(txt, style="bright_cyan", height=3)


def render_controls(s: dict[str, Any], interactive: bool) -> Panel:
    max_levels = s["tree"].get("active_max_depth", s["tree"]["max_depth"]) + 1
    txt = Text.from_markup(
        f"[bold bright_white]Showing levels {s['visible_levels']}/{max_levels} of agents[/]"
        f"[bright_black] | [/]"
        f"[bold bright_white]+/- zoom levels[/]"
        f"[bright_black] | [/]"
        f"[bold bright_white]tab={s['active_tab']}[/]"
    )
    return Panel(txt, title="[bold bright_white]CONTROLS[/]", border_style="bright_cyan", height=3)


# ---------------------------------------------------------------------------
# NDJSON readers
# ---------------------------------------------------------------------------


def reader_subprocess(cmd: list[str], q: queue.Queue[Any], cwd: str):
    """Spawn orchestrator process, read NDJSON lines from stdout."""
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            cwd=cwd,
            env={**os.environ},
        )
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                q.put(json.loads(line))
            except json.JSONDecodeError:
                pass
        proc.wait()
    except Exception as exc:
        q.put(
            {
                "level": "error",
                "message": f"Process error: {exc}",
                "timestamp": int(time.time() * 1000),
            }
        )
    finally:
        q.put(None)


def reader_stdin(q: queue.Queue[Any]):
    """Read NDJSON from stdin (pipe mode)."""
    try:
        while True:
            line = sys.stdin.readline()
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            try:
                q.put(json.loads(line))
            except json.JSONDecodeError:
                pass
    finally:
        q.put(None)


def reader_replay(filepath: str, speed: float, q: queue.Queue[Any]):
    """Replay an NDJSON log file, preserving original timestamp deltas."""
    try:
        with open(filepath) as f:
            lines = f.readlines()

        events: list[tuple[int, dict[str, Any]]] = []
        for raw in lines:
            raw = raw.strip()
            if not raw:
                continue
            try:
                ev = json.loads(raw)
                ts = ev.get("timestamp", 0)
                events.append((ts, ev))
            except json.JSONDecodeError:
                continue

        if not events:
            q.put(None)
            return

        base_ts = events[0][0]
        wall_start = time.time()

        for ts, ev in events:
            delta_s = (ts - base_ts) / 1000.0
            target_wall = wall_start + delta_s / speed
            wait = target_wall - time.time()
            if wait > 0:
                time.sleep(wait)
            q.put(ev)
    finally:
        q.put(None)


def _find_latest_ndjson(logs_dir: str) -> str | None:
    if not os.path.isdir(logs_dir):
        return None
    files = [f for f in os.listdir(logs_dir) if f.startswith("run-") and f.endswith(".ndjson")]
    if not files:
        return None
    files.sort(key=lambda f: os.path.getmtime(os.path.join(logs_dir, f)), reverse=True)
    return os.path.join(logs_dir, files[0])


def reader_follow(logs_dir: str, q: queue.Queue[Any]):
    """Tail the latest NDJSON log file live — like tail -f.

    Waits for a log file to appear, reads existing content to catch up,
    then polls for new lines.  Switches to a newer file if one appears
    (new orchestrator run).
    """
    current_path: str | None = None
    fh = None
    check_counter = 0

    try:
        while True:
            if check_counter % 8 == 0:
                latest = _find_latest_ndjson(logs_dir)
                if latest and latest != current_path:
                    if fh:
                        fh.close()
                    current_path = latest
                    fh = open(current_path)
            check_counter += 1

            if fh is None:
                time.sleep(0.25)
                continue

            had_data = False
            while True:
                line = fh.readline()
                if not line:
                    break
                line = line.strip()
                if line:
                    try:
                        q.put(json.loads(line))
                        had_data = True
                    except json.JSONDecodeError:
                        pass

            if not had_data:
                time.sleep(0.25)
    finally:
        if fh:
            fh.close()
        q.put(None)


# ---------------------------------------------------------------------------
# Demo data generator
# ---------------------------------------------------------------------------

_DEMO_DESCS = [
    "Implement chunk meshing system",
    "Add block face culling",
    "Create player controller",
    "Setup WebGL2 renderer",
    "Build terrain noise generator",
    "Add skybox shader",
    "Implement block placement",
    "Create inventory UI overlay",
    "Add ambient occlusion",
    "Build water flow simulation",
    "Setup collision detection",
    "Create world save/load",
    "Add fog distance shader",
    "Implement biome blending",
    "Build particle system",
    "Add block breaking animation",
    "Create crafting grid UI",
    "Implement greedy meshing",
    "Add texture atlas packer",
    "Build chunk LOD system",
    "Setup audio manager",
    "Create main menu screen",
    "Add day/night cycle",
    "Implement frustum culling",
    "Build entity component system",
]


def demo_generator(q: queue.Queue[Any], max_agents: int, total_features: int):
    """Generate synthetic orchestrator events for demo mode."""
    start = time.time()
    task_n = 0
    done = 0
    failed = 0
    merged = 0
    conflicts = 0
    iteration = 0
    tokens = 0
    active: dict[str, float] = {}
    created: list[str] = []
    child_counters: dict[str, int] = {}

    try:
        while done + failed < total_features:
            now = time.time()
            elapsed = now - start
            ts = int(now * 1000)

            ramp = min(1.0, elapsed / 25.0)
            target = int(max_agents * ramp)

            # -- complete some running tasks --------------------------------
            for tid, started in list(active.items()):
                dur = random.uniform(2.5, 10.0)
                if now - started > dur:
                    ok = random.random() < 0.92
                    status = "complete" if ok else "failed"
                    tok = random.randint(3000, 18000)
                    tokens += tok

                    if ok:
                        done += 1
                    else:
                        failed += 1

                    q.put(
                        {
                            "timestamp": ts,
                            "level": "info",
                            "agentId": "main",
                            "agentRole": "root-planner",
                            "message": "Task completed",
                            "data": {
                                "taskId": tid,
                                "status": status,
                                "summary": f"Completed: {random.choice(_DEMO_DESCS)[:60]}",
                                "filesChanged": random.randint(1, 8),
                                "linesAdded": random.randint(20, 500),
                                "linesRemoved": random.randint(0, 100),
                                "filesCreated": random.randint(0, 3),
                                "filesModified": random.randint(1, 5),
                                "tokensUsed": tok,
                                "toolCallCount": random.randint(5, 40),
                                "durationMs": int((now - started) * 1000),
                            },
                        }
                    )
                    q.put(
                        {
                            "timestamp": ts,
                            "level": "info",
                            "agentId": "main",
                            "agentRole": "root-planner",
                            "message": "Task status",
                            "data": {"taskId": tid, "from": "running", "to": status},
                        }
                    )

                    # merge
                    if ok:
                        if random.random() < 0.94:
                            merged += 1
                            q.put(
                                {
                                    "timestamp": ts,
                                    "level": "info",
                                    "agentId": "planner",
                                    "agentRole": "root-planner",
                                    "message": "Merge result",
                                    "data": {
                                        "branch": f"worker/{tid}",
                                        "status": "merged",
                                        "success": True,
                                    },
                                }
                            )
                        else:
                            conflicts += 1
                            q.put(
                                {
                                    "timestamp": ts,
                                    "level": "warn",
                                    "agentId": "planner",
                                    "agentRole": "root-planner",
                                    "message": "Merge result",
                                    "data": {
                                        "branch": f"worker/{tid}",
                                        "status": "conflict",
                                        "success": False,
                                    },
                                }
                            )
                    del active[tid]

            # -- spawn new tasks to fill slots ------------------------------
            while len(active) < target and task_n < total_features:
                task_n += 1
                parent_id = ""
                parent_pool = [t for t in created if t.count("-sub-") < 2]
                if parent_pool and random.random() < 0.5:
                    parent_id = random.choice(parent_pool)
                    child_counters[parent_id] = child_counters.get(parent_id, 0) + 1
                    tid = f"{parent_id}-sub-{child_counters[parent_id]}"
                else:
                    tid = f"agent-{task_n:03d}"
                desc = random.choice(_DEMO_DESCS)
                created.append(tid)

                q.put(
                    {
                        "timestamp": ts,
                        "level": "info",
                        "agentId": "main",
                        "agentRole": "root-planner",
                        "message": "Task created",
                        "data": {"taskId": tid, "desc": desc, "parentId": parent_id or None},
                    }
                )
                q.put(
                    {
                        "timestamp": ts,
                        "level": "info",
                        "agentId": "worker-pool",
                        "agentRole": "root-planner",
                        "message": "Dispatching task to ephemeral sandbox",
                        "data": {"taskId": tid, "parentId": parent_id or None},
                    }
                )
                q.put(
                    {
                        "timestamp": ts,
                        "level": "info",
                        "agentId": "main",
                        "agentRole": "root-planner",
                        "message": "Task status",
                        "data": {
                            "taskId": tid,
                            "parentId": parent_id or None,
                            "from": "pending",
                            "to": "running",
                            "desc": desc,
                        },
                    }
                )
                active[tid] = now

            for tid_active in list(active.keys()):
                if random.random() < 0.3:
                    phases = [
                        "Cloning repo...",
                        "Installing deps...",
                        "Reading codebase...",
                        "Writing implementation...",
                        "Running tests...",
                        "Committing changes...",
                        f"Tool calls: {random.randint(5, 40)}",
                        "Analyzing code structure...",
                    ]
                    q.put(
                        {
                            "timestamp": ts,
                            "level": "info",
                            "agentId": "worker-pool",
                            "agentRole": "root-planner",
                            "message": "Worker progress",
                            "data": {
                                "taskId": tid_active,
                                "phase": "execution",
                                "detail": random.choice(phases),
                            },
                        }
                    )

            if random.random() < 0.35:
                eh = max(elapsed / 3600, 0.001)
                ma = merged + conflicts
                q.put(
                    {
                        "timestamp": ts,
                        "level": "info",
                        "agentId": "monitor",
                        "agentRole": "root-planner",
                        "message": "Metrics",
                        "data": {
                            "timestamp": ts,
                            "activeWorkers": len(active),
                            "pendingTasks": max(0, task_n - done - failed - len(active)),
                            "completedTasks": done,
                            "failedTasks": failed,
                            "commitsPerHour": done / eh,
                            "mergeSuccessRate": merged / ma if ma else 0,
                            "totalTokensUsed": tokens,
                            "totalCostUsd": 0,
                        },
                    }
                )

            # -- iteration events -------------------------------------------
            if done > 0 and done % 15 == 0 and random.random() < 0.4:
                iteration += 1
                q.put(
                    {
                        "timestamp": ts,
                        "level": "info",
                        "agentId": "main",
                        "agentRole": "root-planner",
                        "message": "Iteration complete",
                        "data": {
                            "iteration": iteration,
                            "tasks": random.randint(8, 20),
                            "handoffs": random.randint(8, 20),
                            "activeWorkers": len(active),
                            "completedTasks": done,
                        },
                    }
                )

            if done > 0 and done % 20 == 0 and random.random() < 0.5:
                q.put(
                    {
                        "timestamp": ts,
                        "level": "info",
                        "agentId": "planner",
                        "agentRole": "root-planner",
                        "message": "Calling LLM for task decomposition",
                        "data": {
                            "isFirstPlan": False,
                            "historyMessages": random.randint(4, 20),
                            "newHandoffs": random.randint(3, 10),
                        },
                    }
                )

            # -- occasional reconciler sweep --------------------------------
            if random.random() < 0.015:
                b = random.random() < 0.85
                t = random.random() < 0.80
                q.put(
                    {
                        "timestamp": ts,
                        "level": "info",
                        "agentId": "reconciler",
                        "agentRole": "reconciler",
                        "message": "Sweep check results",
                        "data": {"buildOk": b, "testsOk": t},
                    }
                )
                if not (b and t):
                    fc = random.randint(1, 3)
                    q.put(
                        {
                            "timestamp": ts,
                            "level": "info",
                            "agentId": "main",
                            "agentRole": "root-planner",
                            "message": "Reconciler created fix tasks",
                            "data": {"count": fc},
                        }
                    )

            time.sleep(0.25)
    finally:
        q.put(None)


# ---------------------------------------------------------------------------
# Input controls
# ---------------------------------------------------------------------------


class KeyPoller:
    def __init__(self, enabled: bool):
        self.enabled = enabled and os.name == "posix" and sys.stdin.isatty()
        self.fd: int | None = None
        self._old: Any = None

    def __enter__(self):
        if self.enabled:
            self.fd = sys.stdin.fileno()
            self._old = termios.tcgetattr(self.fd)
            tty.setcbreak(self.fd)
            # Enable mouse reporting (press/drag + wheel, SGR mode).
            sys.stdout.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h")
            sys.stdout.flush()
        return self

    def __exit__(self, exc_type, exc, tb):
        if self.enabled and self.fd is not None and self._old is not None:
            sys.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1006l")
            sys.stdout.flush()
            termios.tcsetattr(self.fd, termios.TCSADRAIN, self._old)

    def poll(self) -> str:
        if not self.enabled or self.fd is None:
            return ""
        ready, _, _ = select.select([self.fd], [], [], 0)
        if not ready:
            return ""
        raw = os.read(self.fd, 1)
        if not raw:
            return ""
        if raw == b"\x1b":
            seq = b""
            deadline = time.time() + 0.08
            while time.time() < deadline:
                rdy, _, _ = select.select([self.fd], [], [], 0.005)
                if not rdy:
                    break
                chunk = os.read(self.fd, 1)
                if not chunk:
                    break
                seq += chunk
            if seq.startswith(b"[<") and (seq.endswith(b"M") or seq.endswith(b"m")):
                body = seq[2:-1].decode("ascii", errors="ignore")
                parts = body.split(";")
                if len(parts) == 3:
                    try:
                        button = int(parts[0])
                        mx = int(parts[1])
                        my = int(parts[2])
                    except ValueError:
                        button = -1
                        mx = 0
                        my = 0
                    if button in (64, 96):
                        return f"MWHEEL_UP:{mx}:{my}"
                    if button in (65, 97):
                        return f"MWHEEL_DOWN:{mx}:{my}"
                    if (button & 64) and (button & 1) == 0:
                        return f"MWHEEL_UP:{mx}:{my}"
                    if (button & 64) and (button & 1) == 1:
                        return f"MWHEEL_DOWN:{mx}:{my}"
            if seq.startswith(b"[M") and len(seq) >= 5:
                # X10 mouse mode: ESC [ M Cb Cx Cy
                cb = seq[2]
                mx = max(1, seq[3] - 32)
                my = max(1, seq[4] - 32)
                btn = cb - 32
                if (btn & 64) and (btn & 1) == 0:
                    return f"MWHEEL_UP:{mx}:{my}"
                if (btn & 64) and (btn & 1) == 1:
                    return f"MWHEEL_DOWN:{mx}:{my}"
            if seq.endswith(b"A"):
                return "ESC"
            if seq.endswith(b"B"):
                return "ESC"
            if seq.endswith(b"C"):
                return "RIGHT"
            if seq.endswith(b"D"):
                return "LEFT"
            return "ESC"
        if raw == b"\t":
            return "TAB"
        return raw.decode("utf-8", errors="ignore")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def print_json_loop(q: queue.Queue[Any]):
    """Read from queue and print raw NDJSON to stdout."""
    while True:
        try:
            item = q.get()
            if item is None:
                break
            print(json.dumps(item), flush=True)
        except KeyboardInterrupt:
            break
        except Exception:
            break


def main():
    ap = argparse.ArgumentParser(description="Longshot Rich Terminal Dashboard")
    ap.add_argument("--demo", action="store_true", help="Synthetic data mode")
    ap.add_argument("--stdin", action="store_true", help="Read NDJSON from stdin")
    ap.add_argument(
        "--replay",
        type=str,
        default=None,
        metavar="FILE",
        help="Replay an NDJSON log file at original speed",
    )
    ap.add_argument(
        "--follow",
        action="store_true",
        help="Tail the latest logs/run-*.ndjson file live (use alongside Poke)",
    )
    ap.add_argument(
        "--speed",
        type=float,
        default=1.0,
        help="Replay speed multiplier (default 1.0, e.g. 10 = 10x faster)",
    )
    ap.add_argument("--json-only", action="store_true", help="Output raw NDJSON to stdout (no TUI)")
    ap.add_argument("--agents", type=int, default=100, help="Max agent slots (default 100)")
    ap.add_argument("--features", type=int, default=200, help="Total features (default 200)")
    ap.add_argument("--hz", type=int, default=4, help="Refresh rate Hz (default 4)")
    ap.add_argument(
        "--cost-rate", type=float, default=COST_PER_1K, help="$/1K tokens for cost estimate"
    )
    args = ap.parse_args()

    # If JSON-only, we don't need rich console or dashboard state
    if args.json_only:
        dq: queue.Queue[Any] = queue.Queue()
        if args.follow:
            logs_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
            thr = threading.Thread(target=reader_follow, args=(logs_dir, dq), daemon=True)
        elif args.demo:
            thr = threading.Thread(
                target=demo_generator, args=(dq, args.agents, args.features), daemon=True
            )
        elif args.stdin:
            thr = threading.Thread(target=reader_stdin, args=(dq,), daemon=True)
        else:
            cwd = os.path.dirname(os.path.abspath(__file__))
            thr = threading.Thread(
                target=reader_subprocess,
                args=(["node", "packages/orchestrator/dist/main.js"], dq, cwd),
                daemon=True,
            )
        thr.start()
        print_json_loop(dq)
        return

    console = Console()
    state = DashboardState(args.agents, args.features, args.cost_rate)
    dq: queue.Queue[Any] = queue.Queue()

    if args.follow:
        logs_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
        thr = threading.Thread(target=reader_follow, args=(logs_dir, dq), daemon=True)
    elif args.replay:
        thr = threading.Thread(
            target=reader_replay, args=(args.replay, args.speed, dq), daemon=True
        )
    elif args.demo:
        thr = threading.Thread(
            target=demo_generator, args=(dq, args.agents, args.features), daemon=True
        )
    elif args.stdin:
        thr = threading.Thread(target=reader_stdin, args=(dq,), daemon=True)
    else:
        cwd = os.path.dirname(os.path.abspath(__file__))
        thr = threading.Thread(
            target=reader_subprocess,
            args=(["node", "packages/orchestrator/dist/main.js"], dq, cwd),
            daemon=True,
        )
    thr.start()

    layout = make_layout()
    interactive_zoom = sys.stdin.isatty() and not args.stdin

    try:
        with KeyPoller(interactive_zoom) as key_poller:
            with Live(layout, console=console, refresh_per_second=args.hz, screen=True):
                running = True
                stream_ended = False
                while running:
                    key = key_poller.poll()
                    while key:
                        if key in ("+", "="):
                            state.adjust_visible_levels(1)
                        elif key in ("-", "_"):
                            state.adjust_visible_levels(-1)
                        elif key.startswith("MWHEEL_UP:") or key.startswith("MWHEEL_DOWN:"):
                            parts = key.split(":")
                            if len(parts) == 3:
                                _, sx, sy = parts
                                try:
                                    mx = int(sx)
                                    my = int(sy)
                                except ValueError:
                                    mx = 0
                                    my = 0
                                cur = state.snap()
                                if cur["active_tab"] == "grid":
                                    pane = _grid_pane_from_mouse(
                                        mx,
                                        my,
                                        console.size.width,
                                        console.size.height,
                                    )
                                    if pane:
                                        delta = -2 if key.startswith("MWHEEL_UP:") else 2
                                        state.adjust_tree_scroll(pane, delta)
                        elif key in ("TAB", "]", "RIGHT", "l", "L"):
                            state.switch_tab(1)
                        elif key in ("[", "LEFT", "h", "H"):
                            state.switch_tab(-1)
                        elif key in ("g", "G"):
                            state.set_tab("grid")
                        elif key in ("a", "A"):
                            state.set_tab("activity")
                        elif key in ("w", "W"):
                            cur = state.snap()
                            if cur["active_tab"] == "grid":
                                state.adjust_tree_scroll("in_progress", -2)
                        elif key in ("s", "S"):
                            cur = state.snap()
                            if cur["active_tab"] == "grid":
                                state.adjust_tree_scroll("in_progress", 2)
                        elif key in ("e", "E"):
                            cur = state.snap()
                            if cur["active_tab"] == "grid":
                                state.adjust_tree_scroll("completed", -2)
                        elif key in ("d", "D"):
                            cur = state.snap()
                            if cur["active_tab"] == "grid":
                                state.adjust_tree_scroll("completed", 2)
                        key = key_poller.poll()

                    # drain queue
                    batch = 0
                    while (not stream_ended) and batch < 200:  # cap per tick
                        try:
                            item = dq.get_nowait()
                            if item is None:
                                stream_ended = True
                                break
                            state.ingest(item)
                            batch += 1
                        except queue.Empty:
                            break

                    # render
                    s = state.snap()
                    apply_tab_layout(layout, s["active_tab"])
                    layout["header"].update(render_header(s))
                    layout["metrics"].update(render_metrics(s))
                    layout["merge"].update(render_merge(s))
                    if s["active_tab"] == "activity":
                        layout["right"].update(render_activity(s))
                    else:
                        layout["right"].update(render_grid(s))
                    layout["footer"].update(render_footer(s))
                    layout["controls"].update(render_controls(s, interactive_zoom))

                    time.sleep(1.0 / args.hz)

    except KeyboardInterrupt:
        pass

    # final summary
    s = state.snap()
    console.print()
    console.print("[bold bright_cyan]Longshot Session Complete[/]")
    console.print(f"  Duration    {timedelta(seconds=int(s['elapsed']))}")
    console.print(f"  Completed   {s['completed']} / {s['total_tasks']}")
    console.print(f"  Failed      {s['failed']}")
    console.print(
        f"  Merged      {s['merge_merged']}  "
        f"conflicts {s['merge_conflicts']}  "
        f"failed {s['merge_failed']}"
    )
    console.print(f"  Tokens      {s['tokens']:,}")
    console.print(f"  Est. cost   ${s['cost']:.2f}")
    console.print()


if __name__ == "__main__":
    main()
