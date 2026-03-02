import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

# Add repo root to path
REPO_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(REPO_ROOT))

import aiohttp  # noqa: E402
import modal  # noqa: E402

from infra.sandbox_image import create_agent_image, create_worker_image  # noqa: E402


def test_image_builds():
    """Verify the sandbox image builds and has all required tools."""
    print("\n" + "=" * 60)
    print("TEST 1: Image Build & Tool Verification")
    print("=" * 60)

    app = modal.App.lookup("longshot-test", create_if_missing=True)
    image = create_agent_image()

    # Define a function that runs inside the image to check tools
    sb = modal.Sandbox.create(
        "bash",
        "-c",
        """
        echo "=== Tool Check ==="
        echo "node: $(node --version 2>&1)"
        echo "npm: $(npm --version 2>&1)"
        echo "pnpm: $(pnpm --version 2>&1)"
        echo "git: $(git --version 2>&1)"
        echo "python3: $(python3 --version 2>&1)"
        echo "curl: $(curl --version 2>&1 | head -1)"
        echo "rg: $(rg --version 2>&1 | head -1)"
        echo "jq: $(jq --version 2>&1)"
        echo "=== All checks done ==="
        """,
        app=app,
        image=image,
        timeout=120,
    )

    # Read output
    proc_stdout = sb.stdout.read()
    print(proc_stdout)

    # Check return code
    sb.wait()
    rc = sb.returncode
    print(f"Exit code: {rc}")

    if rc == 0 and "All checks done" in proc_stdout:
        print("✅ TEST 1 PASSED: Image builds and all tools present")
        return True
    else:
        print("❌ TEST 1 FAILED: Image build or tool check failed")
        return False


# =============================================================================
# Test 2: Basic sandbox operations
# =============================================================================


def test_sandbox_basic():
    """Create a sandbox, run commands, verify filesystem, terminate."""
    print("\n" + "=" * 60)
    print("TEST 2: Basic Sandbox Operations")
    print("=" * 60)

    app = modal.App.lookup("longshot-test", create_if_missing=True)
    image = create_agent_image()

    # Create sandbox with sleep
    print("Creating sandbox...")
    sb = modal.Sandbox.create(
        "sleep",
        "infinity",
        app=app,
        image=image,
        timeout=120,
    )
    print(f"Sandbox created: {sb.object_id}")

    # Test 2a: Execute a command
    print("  Executing command...")
    proc = sb.exec("echo", "hello from sandbox")
    stdout = proc.stdout.read()
    proc.wait()
    assert "hello from sandbox" in stdout, f"Expected 'hello from sandbox', got: {stdout}"
    print(f"  ✅ Command execution: '{stdout.strip()}'")

    # Test 2b: Write and read a file
    print("  Writing file...")
    write_proc = sb.exec("bash", "-c", 'echo "test content" > /workspace/test.txt')
    write_proc.wait()

    read_proc = sb.exec("cat", "/workspace/test.txt")
    content = read_proc.stdout.read()
    read_proc.wait()
    assert "test content" in content, f"File content mismatch: {content}"
    print(f"  ✅ File I/O: '{content.strip()}'")

    # Test 2c: Git operations
    print("  Testing git...")
    git_proc = sb.exec(
        "bash",
        "-c",
        "cd /workspace && git init && "
        "echo 'hello' > hello.txt && "
        "git add . && "
        "git commit -m 'initial' && "
        "git log --oneline",
    )
    git_out = git_proc.stdout.read()
    git_proc.wait()
    assert "initial" in git_out, f"Git commit not found: {git_out}"
    print(f"  ✅ Git operations: '{git_out.strip()}'")

    # Test 2d: Node.js execution
    print("  Testing Node.js...")
    node_proc = sb.exec(
        "node", "-e", "console.log(JSON.stringify({version: process.version, ok: true}))"
    )
    node_out = node_proc.stdout.read()
    node_proc.wait()
    node_result = json.loads(node_out.strip())
    assert node_result["ok"] is True, f"Node.js failed: {node_out}"
    print(f"  ✅ Node.js: {node_result['version']}")

    # Terminate
    print("  Terminating sandbox...")
    sb.terminate()
    print("✅ TEST 2 PASSED: All basic sandbox operations work")
    return True


# =============================================================================
# Test 3: Agent HTTP server in sandbox
# =============================================================================


async def test_agent_server():
    """Deploy the agent HTTP server in a sandbox and test its endpoints."""
    print("\n" + "=" * 60)
    print("TEST 3: Agent HTTP Server")
    print("=" * 60)

    # Check if sandbox package is built
    dist_dir = REPO_ROOT / "packages" / "sandbox" / "dist"
    if not dist_dir.exists() or not (dist_dir / "server.js").exists():
        print("⚠️  packages/sandbox not built. Run 'pnpm build' first.")
        print("❌ TEST 3 SKIPPED")
        return False

    app = modal.App.lookup("longshot-test", create_if_missing=True)
    image = create_worker_image()
    port = 8080

    print("Creating sandbox with agent server...")
    sb = modal.Sandbox.create(
        "sleep",
        "infinity",
        app=app,
        image=image,
        timeout=300,
        encrypted_ports=[port],
        env={
            "PORT": str(port),
            "SANDBOX_ID": "test-sandbox-001",
        },
    )

    try:
        # Start the server in background
        print("  Starting agent server...")
        sb.exec(
            "bash",
            "-c",
            "nohup node /agent/packages/sandbox/dist/server.js > /tmp/server.log 2>&1 &",
        )

        # Get tunnel URL
        tunnels = sb.tunnels(timeout=60)
        url = tunnels[port].url
        print(f"  Server URL: {url}")

        # Wait for ready
        print("  Waiting for server to be ready...")
        async with aiohttp.ClientSession() as session:
            deadline = time.time() + 30
            ready = False
            while time.time() < deadline:
                try:
                    async with session.get(
                        f"{url}/health",
                        timeout=aiohttp.ClientTimeout(total=5),
                    ) as resp:
                        if resp.status == 200:
                            health = await resp.json()
                            print(f"  ✅ Health endpoint: {json.dumps(health)}")
                            ready = True
                            break
                except (TimeoutError, aiohttp.ClientError):
                    pass
                await asyncio.sleep(2)

            if not ready:
                print("  ❌ Server failed to become ready")
                return False

            # Test root endpoint
            async with session.get(f"{url}/") as resp:
                root_data = await resp.json()
                print(f"  ✅ Root endpoint: {json.dumps(root_data)}")

        print("✅ TEST 3 PASSED: Agent server responds to HTTP")
        return True

    finally:
        print("  Terminating sandbox...")
        sb.terminate()


# =============================================================================
# Test 4: Full agent loop (requires GLM-5)
# =============================================================================


async def test_full_agent(glm5_endpoint: str):
    """
    Full end-to-end test: spawn sandbox, send coding task to agent
    which calls GLM-5, and collect handoff.
    """
    print("\n" + "=" * 60)
    print("TEST 4: Full Agent Loop (with GLM-5)")
    print("=" * 60)

    # Load worker prompt
    prompt_path = REPO_ROOT / "prompts" / "worker.md"
    system_prompt = prompt_path.read_text()

    # Define a simple task
    task = {
        "id": "test-001",
        "description": (
            "Create a TypeScript file at /workspace/repo/src/greet.ts that exports "
            "a function called 'greet' which takes a name (string) and returns a greeting "
            "string like 'Hello, {name}!'. Also create a simple test at "
            "/workspace/repo/src/greet.test.ts that verifies the function works."
        ),
        "scope": ["src/greet.ts", "src/greet.test.ts"],
        "acceptance": ("greet('World') returns 'Hello, World!'. Test file exists and would pass."),
        "branch": "worker/test-001",
        "status": "assigned",
        "createdAt": int(time.time() * 1000),
        "priority": 5,
    }

    llm_config = {
        "endpoint": glm5_endpoint.rstrip("/"),
        "model": "glm-5",
        "maxTokens": 4096,
        "temperature": 0.7,
        "apiKey": os.environ.get("LLM_API_KEY", ""),
    }

    # Check if sandbox package is built
    dist_dir = REPO_ROOT / "packages" / "sandbox" / "dist"
    if not dist_dir.exists():
        print("⚠️  packages/sandbox not built. Run 'pnpm build' first.")
        return False

    app = modal.App.lookup("longshot-test", create_if_missing=True)
    image = create_worker_image()
    port = 8080

    print("Creating sandbox...")
    sb = modal.Sandbox.create(
        "sleep",
        "infinity",
        app=app,
        image=image,
        timeout=600,
        encrypted_ports=[port],
        env={
            "PORT": str(port),
            "SANDBOX_ID": "test-full-001",
        },
    )

    try:
        # Initialize a git repo in the sandbox for the agent to work in
        init_proc = sb.exec(
            "bash",
            "-c",
            "mkdir -p /workspace/repo/src && "
            "cd /workspace/repo && "
            "git init && "
            'echo \'{"name": "test-project", "type": "module"}\' > package.json && '
            "git add . && "
            "git commit -m 'initial' && "
            "git checkout -b worker/test-001",
        )
        init_proc.wait()
        print("  ✅ Repo initialized in sandbox")

        # Start agent server
        sb.exec(
            "bash",
            "-c",
            "nohup node /agent/packages/sandbox/dist/server.js > /tmp/server.log 2>&1 &",
        )

        # Wait for server
        tunnels = sb.tunnels(timeout=60)
        url = tunnels[port].url
        print(f"  Server URL: {url}")

        async with aiohttp.ClientSession() as session:
            # Wait for ready
            deadline = time.time() + 30
            while time.time() < deadline:
                try:
                    async with session.get(
                        f"{url}/health", timeout=aiohttp.ClientTimeout(total=5)
                    ) as resp:
                        if resp.status == 200:
                            break
                except (TimeoutError, aiohttp.ClientError):
                    pass
                await asyncio.sleep(2)

            # Send task
            assignment = {
                "type": "task_assignment",
                "task": task,
                "systemPrompt": system_prompt,
                "repoSnapshot": "",
                "llmConfig": llm_config,
            }

            print("  Sending task to agent (this may take 1-5 minutes)...")
            start = time.time()

            async with session.post(
                f"{url}/task",
                json=assignment,
                timeout=aiohttp.ClientTimeout(total=600),
            ) as resp:
                elapsed = time.time() - start
                print(f"  Response received in {elapsed:.1f}s (status {resp.status})")

                if resp.status == 200:
                    result = await resp.json()
                    handoff = result.get("handoff", result)

                    print("\n  === HANDOFF ===")
                    print(f"  Status:  {handoff.get('status', 'unknown')}")
                    print(f"  Summary: {handoff.get('summary', 'N/A')}")
                    print(f"  Files:   {handoff.get('filesChanged', [])}")
                    print(f"  Diff:\n{handoff.get('diff', '(none)')[:500]}")

                    if handoff.get("status") in ("complete", "partial"):
                        print("\n✅ TEST 4 PASSED: Full agent loop produced a handoff")
                        return True
                    else:
                        print(f"\n⚠️  TEST 4: Agent returned status '{handoff.get('status')}'")
                        print(f"  Concerns: {handoff.get('concerns', [])}")
                        return False
                else:
                    error = await resp.text()
                    print(f"  ❌ Task failed: {error[:300]}")
                    return False

    finally:
        print("  Terminating sandbox...")
        sb.terminate()


# =============================================================================
# CLI
# =============================================================================


def main():
    parser = argparse.ArgumentParser(description="Longshot E2E Tests")
    parser.add_argument(
        "test",
        choices=["image", "basic", "server", "full", "all"],
        help="Which test to run",
    )
    parser.add_argument(
        "--glm5-endpoint",
        default=os.environ.get("GLM5_ENDPOINT", ""),
        help="GLM-5 endpoint URL (required for 'full' test)",
    )
    args = parser.parse_args()

    results = {}

    if args.test in ("image", "all"):
        results["image"] = test_image_builds()

    if args.test in ("basic", "all"):
        results["basic"] = test_sandbox_basic()

    if args.test in ("server", "all"):
        results["server"] = asyncio.run(test_agent_server())

    if args.test in ("full", "all"):
        if not args.glm5_endpoint:
            print("\n❌ --glm5-endpoint required for 'full' test")
            print("   Deploy GLM-5 first: modal deploy infra/deploy_glm5.py")
            print("   Then: python scripts/test_sandbox.py full --glm5-endpoint URL")
            sys.exit(1)
        results["full"] = asyncio.run(test_full_agent(args.glm5_endpoint))

    # Summary
    print("\n" + "=" * 60)
    print("TEST SUMMARY")
    print("=" * 60)
    for name, passed in results.items():
        status = "✅ PASS" if passed else "❌ FAIL"
        print(f"  {status}  {name}")

    all_passed = all(results.values())
    print(f"\n{'✅ All tests passed!' if all_passed else '❌ Some tests failed.'}")
    sys.exit(0 if all_passed else 1)


if __name__ == "__main__":
    main()
