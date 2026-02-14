"""
GLM-5 Client Helper
====================

Simple OpenAI-compatible client for the deployed GLM-5 endpoint.
Used by the orchestrator's LLM client to make inference calls.

The endpoint is deployed via `modal deploy infra/deploy_glm5.py` and
uses `@modal.experimental.http_server` which exposes a "flash URL"
(low-latency direct endpoint). The URL format is:
    https://<workspace>--glm5-inference-glm5.<region>.modal.direct

Usage:
    from infra.glm5_client import get_endpoint_url, create_openai_config

    url = get_endpoint_url()
    config = create_openai_config(url)
    # Pass config["base_url"], config["api_key"], config["model"] to OpenAI client
"""

import os


def get_endpoint_url() -> str:
    """
    Get the GLM-5 endpoint URL.

    Checks GLM5_ENDPOINT env var. The URL should point to the
    modal.experimental.http_server flash URL (not a regular web_server URL).
    """
    url = os.environ.get("GLM5_ENDPOINT")
    if url:
        return url

    raise RuntimeError(
        "GLM5_ENDPOINT environment variable not set. "
        "Deploy GLM-5 first: `modal deploy infra/deploy_glm5.py` "
        "then set GLM5_ENDPOINT to the flash URL from the deploy output."
    )


def create_openai_config(endpoint_url: str) -> dict[str, str]:
    """
    Create config dict for OpenAI-compatible client.

    The deployed SGLang server serves the model as "glm-5" at /v1/chat/completions.
    modal.experimental.http_server endpoints don't require auth tokens by default,
    but we pass MODAL_TOKEN_ID if available for forward-compatibility.

    Returns:
        dict with base_url, api_key, model suitable for openai.OpenAI()
    """
    return {
        "base_url": f"{endpoint_url.rstrip('/')}/v1",
        "api_key": os.environ.get("MODAL_TOKEN_ID", "not-needed"),
        "model": "glm-5",
    }
