"""
GLM-5 Inference Server on Modal
================================

Deploys GLM-5 (zai-org/GLM-5-FP8) on 8x B200 GPUs using SGLang.
Exposes an OpenAI-compatible API at /v1/chat/completions.

Based on modal-projects/modal-jazz reference implementation.
Includes required SGLang patches for GLM-5 architecture support
and DeepGEMM fixes for B200 GPUs.

Usage:
    # Test with dummy weights (no GPU needed, syntax/API check only)
    APP_USE_DUMMY_WEIGHTS=1 modal run infra/deploy_glm5.py

    # Deploy with real model weights
    APP_USE_DUMMY_WEIGHTS=0 modal deploy infra/deploy_glm5.py

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

# =============================================================================
# CONFIGURATION
# =============================================================================

here = Path(__file__).parent

REPO_ID = "zai-org/GLM-5-FP8"
GPU_TYPE = "B200"
GPU_COUNT = 8
GPU = f"{GPU_TYPE}:{GPU_COUNT}"
SGLANG_PORT = 8000
MINUTES = 60  # seconds

# Scaling
REGION = "us"
PROXY_REGIONS = ["us-east"]
MIN_CONTAINERS = 0  # Set to 1 for production to keep a warm replica
TARGET_INPUTS = 10  # Concurrent requests per replica before autoscaling

# =============================================================================
# IMAGE DEFINITION
# =============================================================================

# Base: SGLang v0.5.8 official image (same version as modal-jazz reference)
image = modal.Image.from_registry("lmsysorg/sglang:v0.5.8").entrypoint([])

# Install transformers from source — GlmMoeDsaConfig was added Feb 8, 2026
# which is after the latest pip release (5.1.0, Feb 5). Once a new release
# ships we can pin to that version instead.
image = image.uv_pip_install(
    "transformers @ git+https://github.com/huggingface/transformers.git",
    "typing_extensions>=4.13",
)

# Patch SGLang for GLM-5 architecture support (GlmMoeDsaForCausalLM)
# This pulls SGLang PR #18297 and applies additional fixes for:
# - Model config recognition for GLM-5 architecture
# - Compressed tensors MoE import fix
# - Draft model (speculative decoding) support
# - NSA attention backend context length fix
# - Triton kernel grid size fix
image = (
    image.add_local_file(
        str(here / "glm5_support.patch"),
        "/root/glm5_support.patch",
        copy=True,
    )
    .run_commands(
        "cd /sgl-workspace/sglang && "
        "git fetch origin pull/18297/head:glm5_support && "
        "git checkout glm5_support && "
        "git apply /root/glm5_support.patch",
    )
    .run_commands(
        "rm -rf /root/.cache/deep_gemm/cache || true",
        "curl -L 'https://raw.githubusercontent.com/deepseek-ai/DeepGEMM/477618cd51baffca09c4b0b87e97c03fe827ef03/deep_gemm/include/deep_gemm/impls/sm100_fp8_mqa_logits.cuh' "
        "-o /usr/local/lib/python3.12/dist-packages/deep_gemm/include/deep_gemm/impls/sm100_fp8_mqa_logits.cuh",
    )
)

# HuggingFace cache volume (persist model weights across deploys)
hf_cache_path = "/root/.cache/huggingface"
hf_cache_vol = modal.Volume.from_name("hf-cache-glm5", create_if_missing=True)

# DeepGEMM JIT compilation cache volume
dg_cache_path = "/root/.cache/deep_gemm"
dg_cache_vol = modal.Volume.from_name("deepgemm-cache-glm5", create_if_missing=True)

USE_DUMMY_WEIGHTS = os.environ.get("APP_USE_DUMMY_WEIGHTS", "0") == "1"

# Environment variables
image = image.env({
    "HF_XET_HIGH_PERFORMANCE": "1",  # faster model downloads
    "APP_USE_DUMMY_WEIGHTS": str(int(USE_DUMMY_WEIGHTS)),
    "SGLANG_ALLOW_OVERWRITE_LONGER_CONTEXT_LEN": "1",
    "SGLANG_JIT_DEEPGEMM_FAST_WARMUP": "1",
    "SGLANG_NSA_FORCE_MLA": "1",
    "SGLANG_LOCAL_IP_NIC": "overlay0",
})

# Forward any SGLANG_ env vars from the deployment environment
image = image.env(
    {key: value for key, value in os.environ.items()
     if key.startswith("SGL_") or key.startswith("SGLANG_")}
)

# Download model weights at image build time (skip if using dummy weights)
if not USE_DUMMY_WEIGHTS:
    def _download_model(repo_id, revision=None):
        from huggingface_hub import snapshot_download
        snapshot_download(repo_id=repo_id, revision=revision)

    image = image.run_function(
        _download_model,
        volumes={hf_cache_path: hf_cache_vol},
        args=(REPO_ID,),
    )

# Add YAML config for SGLang server
image = image.add_local_file(str(here / "config.yaml"), "/root/config.yaml")

# =============================================================================
# SGLANG SERVER MANAGEMENT
# =============================================================================

def _start_server() -> subprocess.Popen:
    """Start SGLang server as a subprocess with DP attention."""
    cmd = [
        f"HF_HUB_OFFLINE={1 - int(USE_DUMMY_WEIGHTS)}",
        "python", "-m", "sglang.launch_server",
        "--host", "0.0.0.0",
        "--port", str(SGLANG_PORT),
        "--model-path", REPO_ID,
        "--served-model-name", "glm-5",
        "--tp", str(GPU_COUNT),
        "--dp", str(GPU_COUNT),
        "--enable-dp-attention",
        "--config", "/root/config.yaml",
    ]

    if USE_DUMMY_WEIGHTS:
        cmd.extend(["--load-format", "dummy"])

    print("Starting SGLang server with command:")
    print(*cmd)

    return subprocess.Popen(" ".join(cmd), shell=True, start_new_session=True)


def _wait_for_server(proc: subprocess.Popen, timeout: int = 600) -> None:
    """Wait for SGLang server to be ready. Fails fast if process dies."""
    import requests as req_lib

    url = f"http://localhost:{SGLANG_PORT}/health"
    print(f"Waiting for server to be ready at {url}")

    deadline = time.time() + timeout
    while time.time() < deadline:
        rc = proc.poll()
        if rc is not None:
            raise RuntimeError(f"SGLang server exited with code {rc}")
        try:
            resp = req_lib.get(url, timeout=5)
            if resp.status_code == 200:
                print("SGLang server ready!")
                return
        except req_lib.exceptions.RequestException:
            pass
        time.sleep(5)
        print(f"Waiting for SGLang... ({int(deadline - time.time())}s remaining)")

    raise TimeoutError(f"SGLang server failed to start within {timeout}s")


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
    exit_grace_period=25,
)
@modal.concurrent(target_inputs=TARGET_INPUTS)
class GLM5:
    """GLM-5 inference server with OpenAI-compatible API."""

    @modal.enter()
    def start(self):
        """Start SGLang server on container startup."""
        self.proc = _start_server()
        _wait_for_server(self.proc)
        print("GLM-5 server started successfully")

    @modal.exit()
    def stop(self):
        """Clean shutdown."""
        if hasattr(self, "proc") and self.proc:
            self.proc.terminate()
            self.proc.wait()


# =============================================================================
# TEST ENTRYPOINT
# =============================================================================

@app.local_entrypoint()
async def test(test_timeout=60 * MINUTES, content=None, twice=True):
    """
    Test the deployed GLM-5 endpoint.

    Usage:
        modal run infra/deploy_glm5.py
        modal run infra/deploy_glm5.py --content "Write hello world in TypeScript"
    """
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
    """Send request with retry logic for startup delays."""
    deadline = time.time() + timeout
    async with aiohttp.ClientSession(base_url=url) as session:
        while time.time() < deadline:
            try:
                await _send_streaming(session, messages)
                return
            except asyncio.TimeoutError:
                await asyncio.sleep(1)
            except aiohttp.client_exceptions.ClientResponseError as e:
                if e.status == 503:  # Service Unavailable during startup
                    await asyncio.sleep(1)
                    continue
                raise e
    raise TimeoutError(f"No response from server within {timeout} seconds")


async def _send_streaming(
    session: aiohttp.ClientSession, messages: list, timeout: int | None = None
) -> None:
    """Stream response from chat completions endpoint."""
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
