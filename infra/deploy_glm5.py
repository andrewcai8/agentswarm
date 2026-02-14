"""
GLM-5 Inference Server on Modal
================================

Deploys GLM-5-FP8 on 8x B200 GPUs using SGLang's official GLM-5 Blackwell image.
Exposes an OpenAI-compatible API at /v1/chat/completions.

Uses lmsysorg/sglang:glm5-blackwell which has all GLM-5 architecture support,
DeepGEMM fixes, and correct transformers version baked in.

References:
    - HuggingFace: https://huggingface.co/zai-org/GLM-5
    - SGLang cookbook: https://cookbook.sglang.io/autoregressive/GLM/GLM-5

Usage:
    # Test with dummy weights (fast iteration)
    APP_USE_DUMMY_WEIGHTS=1 modal run infra/deploy_glm5.py

    # Deploy with real model weights
    modal deploy infra/deploy_glm5.py

    # Test deployed endpoint
    modal run infra/deploy_glm5.py --content "Write hello world in TypeScript"
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import time
from pathlib import Path

import aiohttp
import modal
import modal.experimental

here = Path(__file__).parent

# =============================================================================
# CONFIGURATION
# =============================================================================

REPO_ID = "zai-org/GLM-5-FP8"
SERVED_MODEL_NAME = "glm-5"
GPU_TYPE = "B200"
GPU_COUNT = 8
GPU = f"{GPU_TYPE}:{GPU_COUNT}"
SGLANG_PORT = 8000
MINUTES = 60  # seconds

REGION = "us"
PROXY_REGIONS = ["us-east"]
MIN_CONTAINERS = 2  # keep warm — 16+ min cold start makes scale-to-zero impractical
TARGET_INPUTS = 10

# =============================================================================
# IMAGE — official SGLang GLM-5 Blackwell image (everything pre-patched)
# =============================================================================

image = modal.Image.from_registry("lmsysorg/sglang:glm5-blackwell").entrypoint([])

# Volume for HuggingFace model cache
hf_cache_path = "/root/.cache/huggingface"
hf_cache_vol = modal.Volume.from_name("hf-cache-glm5", create_if_missing=True)

# Volume for DeepGEMM JIT cache (persists compiled kernels across restarts)
dg_cache_path = "/root/.cache/deep_gemm"
dg_cache_vol = modal.Volume.from_name("deepgemm-cache-glm5", create_if_missing=True)

USE_DUMMY_WEIGHTS = os.environ.get("APP_USE_DUMMY_WEIGHTS", "0") == "1"

image = image.env({
    "HF_XET_HIGH_PERFORMANCE": "1",
    "APP_USE_DUMMY_WEIGHTS": str(int(USE_DUMMY_WEIGHTS)),
    "SGLANG_ALLOW_OVERWRITE_LONGER_CONTEXT_LEN": "1",
    "SGLANG_JIT_DEEPGEMM_FAST_WARMUP": "1",
    "SGLANG_NSA_FORCE_MLA": "1",
    "SGLANG_LOCAL_IP_NIC": "overlay0",
})

# Pass through any local SGLANG env vars for experimentation
image = image.env(
    {key: value for key, value in os.environ.items()
     if key.startswith("SGL_") or key.startswith("SGLANG_")}
)


hf_secret = modal.Secret.from_name("huggingface")

if not USE_DUMMY_WEIGHTS:
    def _download_model(repo_id, revision=None):
        from huggingface_hub import snapshot_download
        snapshot_download(repo_id=repo_id, revision=revision)

    image = image.run_function(
        _download_model,
        volumes={hf_cache_path: hf_cache_vol},
        secrets=[hf_secret],
        args=(REPO_ID,),
    )

local_config_path = os.environ.get("APP_LOCAL_CONFIG_PATH")

if modal.is_local():
    if local_config_path is None:
        local_config_path = here / "config.yaml"
    image = image.add_local_file(str(local_config_path), "/root/config.yaml")


# =============================================================================
# SGLANG SERVER
# =============================================================================

def _start_server() -> subprocess.Popen:
    cmd = [
        f"HF_HUB_OFFLINE={1 - int(USE_DUMMY_WEIGHTS)}",
        "python", "-m", "sglang.launch_server",
        "--host", "0.0.0.0",
        "--port", str(SGLANG_PORT),
        "--model-path", REPO_ID,
        "--served-model-name", SERVED_MODEL_NAME,
        "--tp", str(GPU_COUNT),
        "--config", "/root/config.yaml",
    ]

    if USE_DUMMY_WEIGHTS:
        cmd.extend(["--load-format", "dummy"])

    print("Starting SGLang server with command:")
    print(*cmd)

    return subprocess.Popen(" ".join(cmd), shell=True, start_new_session=True)


def _wait_for_server(timeout: int = 1800) -> None:
    import requests as req_lib

    url = f"http://localhost:{SGLANG_PORT}/health"
    print(f"Waiting for server to be ready at {url}")

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            resp = req_lib.get(url, timeout=5)
            if resp.status_code == 200:
                print("SGLang server ready!")
                return
        except req_lib.exceptions.RequestException:
            pass
        time.sleep(5)

    raise TimeoutError(f"SGLang server failed to start within {timeout}s")


with image.imports():
    import sglang  # noqa


# =============================================================================
# MODAL APP
# =============================================================================

app = modal.App("glm5-inference", image=image)


@app.cls(
    gpu=GPU,
    scaledown_window=20 * MINUTES,
    timeout=30 * MINUTES,
    volumes={hf_cache_path: hf_cache_vol, dg_cache_path: dg_cache_vol},
    region=REGION,
    min_containers=MIN_CONTAINERS,
)
@modal.experimental.http_server(
    port=SGLANG_PORT,
    proxy_regions=PROXY_REGIONS,
    exit_grace_period=5,
)
@modal.concurrent(target_inputs=TARGET_INPUTS)
class GLM5:
    @modal.enter()
    def start(self):
        self.proc = _start_server()
        _wait_for_server()
        print("GLM-5 server started successfully")

    @modal.exit()
    def stop(self):
        import signal

        if hasattr(self, "proc") and self.proc:
            # SIGKILL immediately — preemption gives only 30s total, and
            # exit_grace_period eats some of that. No time for graceful shutdown.
            try:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)
            except (ProcessLookupError, OSError):
                pass
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass


# =============================================================================
# TEST ENTRYPOINT
# =============================================================================

@app.local_entrypoint()
async def test(test_timeout=60 * MINUTES, content=None, twice=True):
    url = GLM5._experimental_get_flash_urls()[0]

    if USE_DUMMY_WEIGHTS:
        system_prompt = {"role": "system", "content": "This system produces gibberish."}
    else:
        system_prompt = {
            "role": "system",
            "content": "You are a helpful coding assistant. Write clean, typed code.",
        }

    if content is None:
        content = "Write a TypeScript function that reverses a string. Include the type signature."

    messages = [system_prompt, {"role": "user", "content": content}]

    print(f"Sending messages to {url}:", *messages, sep="\n\t")
    await _probe(url, messages, timeout=test_timeout)

    if twice:
        messages[1]["content"] = "What is the capital of France?"
        print(f"\nSending second request to {url}:", *messages, sep="\n\t")
        await _probe(url, messages, timeout=1 * MINUTES)


async def _probe(url: str, messages: list, timeout: int = 60 * MINUTES) -> None:
    deadline = time.time() + timeout
    async with aiohttp.ClientSession(base_url=url) as session:
        while time.time() < deadline:
            try:
                await _send_streaming(session, messages)
                return
            except asyncio.TimeoutError:
                await asyncio.sleep(1)
            except aiohttp.client_exceptions.ClientResponseError as e:
                if e.status in (502, 503):  # 502/503 during startup
                    await asyncio.sleep(1)
                    continue
                raise e
    raise TimeoutError(f"No response from server within {timeout} seconds")


async def _send_streaming(
    session: aiohttp.ClientSession, messages: list, timeout: int | None = None
) -> None:
    payload = {
        "messages": messages,
        "stream": True,
        "max_tokens": 1024 if USE_DUMMY_WEIGHTS else 2048,
    }
    headers = {"Accept": "text/event-stream"}

    async with session.post(
        "/v1/chat/completions", json=payload, headers=headers, timeout=timeout
    ) as resp:
        resp.raise_for_status()
        full_text = ""

        async for raw in resp.content:
            line = raw.decode("utf-8", errors="ignore").strip()
            if not line:
                continue

            if not line.startswith("data:"):
                continue

            data = line[len("data:"):].strip()
            if data == "[DONE]":
                break

            try:
                evt = json.loads(data)
            except json.JSONDecodeError:
                continue

            delta = (evt.get("choices") or [{}])[0].get("delta") or {}
            chunk = delta.get("content") or delta.get("reasoning_content")

            if chunk:
                print(
                    chunk,
                    end="",
                    flush="\n" in chunk or "." in chunk or len(chunk) > 100,
                )
                full_text += chunk
        print()
        print(f"\n--- Generated {len(full_text)} characters ---")
