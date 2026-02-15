#!/usr/bin/env python3
"""
Gource Adapter for AgentSwarm
=============================
Reads AgentSwarm NDJSON events from stdin and outputs Gource Custom Log Format.

Format: timestamp|username|type|file|color

Usage:
    python3 dashboard.py --json-only | python3 gource-adapter.py | gource --log-format custom -
"""

import sys
import json
import time

def get_color(msg):
    """Return hex color (no #) for event type."""
    msg = msg.lower()
    if "created" in msg or "spawned" in msg:
        return "00FF00" # Green
    if "completed" in msg or "success" in msg:
        return "00AAFF" # Blue
    if "failed" in msg or "error" in msg:
        return "FF0000" # Red
    if "merge" in msg:
        return "AA00FF" # Purple
    return "FFFFFF" # White

def process_line(line):
    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        return

    # 1. Timestamp (seconds)
    # Use current time if we want "live" feel, or event time for accuracy.
    # For Gource realtime mode, using event timestamp is usually best if it matches flow.
    # event['timestamp'] is ms, convert to seconds.
    ts_ms = event.get("timestamp")
    if ts_ms:
        ts = int(ts_ms / 1000)
    else:
        ts = int(time.time())

    msg = event.get("message", "")
    data = event.get("data") or {}

    # 2. Extract Entities
    task_id = str(data.get("taskId") or event.get("taskId") or "")
    agent_role = event.get("agentRole", "System")

    # 3. Determine User
    user = agent_role
    # If task_id looks like an agent ("agent-coder-1"), treat it as the user
    if task_id.startswith("agent-"):
        user = task_id.split("-sub-")[0] # clean up sub-task IDs from agent names

    if not user or user == "System":
        user = "Orchestrator"

    # 4. Determine File Path
    # Group by Agent Role to create distinct clusters ("lobes") in the graph
    # swarm / {role} / {parent} / {task}

    role_group = f"{agent_role}s" # e.g. "workers", "subplanners"

    parent_id = data.get("parentId") or data.get("parentTaskId")
    if parent_id:
        path = f"swarm/{role_group}/{parent_id}/{task_id}"
    elif task_id:
        path = f"swarm/{role_group}/{task_id}"
    else:
        path = f"swarm/{role_group}/orchestrator_log"

    # 5. Determine Action (A, M, D)
    action = "M"
    if msg == "Task created" or msg == "Worker dispatched" or "spawned" in msg:
        action = "A"

    # 6. Color
    color = get_color(msg)

    # Sanitize for pipe format (remove pipes)
    user = str(user).replace("|", "")
    path = str(path).replace("|", "")

    # Output: timestamp|username|type|file|color
    print(f"{ts}|{user}|{action}|{path}|{color}")
    sys.stdout.flush()

def main():
    # Read from stdin
    try:
        for line in sys.stdin:
            if not line: break
            process_line(line)
    except KeyboardInterrupt:
        pass

if __name__ == "__main__":
    main()
