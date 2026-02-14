"""
Sandbox Spawner — File I/O + exec pattern for Modal sandboxes
=============================================================

Creates an ephemeral Modal sandbox, writes task.json into it,
clones the target repo, execs worker-runner.js, reads result.json,
and returns the handoff dict. Purely synchronous, no HTTP tunnels.

Usage:
    from infra.spawn_sandbox import run_task

    result = run_task({
        "task": {"id": "task-001", "branch": "worker/task-001", ...},
        "systemPrompt": "You are a coding agent...",
        "repoUrl": "https://github.com/org/repo.git",
        "llmConfig": {"endpoint": "...", "model": "...", "maxTokens": 4096,
                       "temperature": 0.2, "apiKey": "sk-..."},
    })
    print(result)  # Handoff dict
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import modal

from infra.sandbox_image import create_worker_image

# ---------------------------------------------------------------------------
# Module-level Modal resources
# ---------------------------------------------------------------------------
app = modal.App.lookup("agentswarm", create_if_missing=True)
image = create_worker_image()


# ---------------------------------------------------------------------------
# Core function
# ---------------------------------------------------------------------------
def run_task(payload: dict) -> dict:
    """
    Run a single coding task in an ephemeral Modal sandbox.

    Args:
        payload: dict with keys:
            task        – Task dict (must include ``id`` and ``branch``)
            systemPrompt – The worker system prompt
            repoUrl     – Git repo URL to clone
            llmConfig   – {endpoint, model, maxTokens, temperature, apiKey}

    Returns:
        Handoff result dict from the worker, or a failure stub on error.
    """
    task = payload["task"]
    task_id = task["id"]
    sb = None

    try:
        sb = modal.Sandbox.create(
            app=app,
            image=image,
            timeout=2400,
            workdir="/workspace",
        )
        print(f"[spawn] sandbox created for task {task_id}")

        f = sb.open("/workspace/task.json", "w")
        f.write(json.dumps(payload))
        f.close()

        # Build clone URL with token for push access
        repo_url = payload["repoUrl"]
        git_token = payload.get("gitToken", "")
        if git_token and "github.com" in repo_url:
            # Embed token: https://x-access-token:TOKEN@github.com/org/repo.git
            authed_url = repo_url.replace(
                "https://github.com",
                f"https://x-access-token:{git_token}@github.com",
            )
        else:
            authed_url = repo_url

        # Full clone (no --depth 1) so git diff against startSha works in worker-runner
        clone = sb.exec(
            "git", "clone", authed_url, "/workspace/repo",
            timeout=120,
        )
        clone.wait()

        branch = task["branch"]
        branch_proc = sb.exec(
            "git", "-C", "/workspace/repo", "checkout", "-b", branch,
        )
        branch_proc.wait()

        process = sb.exec("node", "/agent/worker-runner.js", timeout=1800)

        for line in process.stdout:
            print(f"[worker:{task_id}] {line}", end="")
        for line in process.stderr:
            print(f"[worker:{task_id}] {line}", end="", file=sys.stderr)

        process.wait()

        # Push branch to remote so merge-queue can fetch it
        if git_token:
            push_proc = sb.exec(
                "git", "-C", "/workspace/repo", "push", "origin", branch,
                timeout=120,
            )
            push_proc.wait()
            print(f"[spawn] pushed branch {branch} to origin")
        else:
            print(f"[spawn] WARNING: no GIT_TOKEN, skipping push for {branch}")

        f = sb.open("/workspace/result.json", "r")
        result = json.loads(f.read())
        f.close()

        print(f"[spawn] task {task_id} completed: {result.get('status', 'unknown')}")
        return result

    except Exception as e:
        print(f"[spawn] task {task_id} failed: {e}")
        return {
            "taskId": task_id,
            "status": "failed",
            "summary": str(e),
            "diff": "",
            "filesChanged": [],
            "concerns": [str(e)],
            "suggestions": ["Retry the task"],
            "metrics": {
                "linesAdded": 0,
                "linesRemoved": 0,
                "filesCreated": 0,
                "filesModified": 0,
                "tokensUsed": 0,
                "toolCallCount": 0,
                "durationMs": 0,
            },
        }

    finally:
        if sb is not None:
            try:
                sb.terminate()
                print(f"[spawn] sandbox terminated for task {task_id}")
            except Exception:
                pass


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    payload = json.loads(sys.argv[1])
    result = run_task(payload)
    print(json.dumps(result))
