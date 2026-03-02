# Infrastructure

Modal cloud infrastructure configuration for running Longshot sandboxes at scale.

> **Note for contributors**: You do NOT need this directory for local development. 
> This is used for the hosted infrastructure running the GLM-5 model on GPUs.
> See [docs/models.md](../docs/models.md) for configuring your own LLM provider.

## Contents

- `sandbox_image.py` — Modal sandbox Docker image definition
- `spawn_sandbox.py` — Sandbox spawner called by the orchestrator's worker pool
- `serve_glm5.py` — GLM-5 model serving on Modal GPUs (internal use)
