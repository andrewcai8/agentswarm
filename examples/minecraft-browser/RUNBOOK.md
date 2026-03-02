# Runbook

## Document Ownership
- Type: Agent-maintained living artifact.
- Created by: User or template bootstrap before run.
- Updated by: Agent as operating procedures and recovery steps evolve.

## Operating Modes
- Local dev: `npm run dev`
- Swarm run: `codex --mode default --instruction-file AGENTS.md`
- Recovery run: `npm run dev -- --host 0.0.0.0 --strictPort`

## Monitoring
- Key logs: browser console, terminal output from Vite, and `playwright-report/` for E2E failures.
- Key metrics: average frame time, chunk generation time, chunk mesh rebuild counts, and save latency.
- Failure signals: persistent frame time above 33 ms, chunk loads stalling near player, block edits not persisted after reload, repeated uncaught runtime exceptions.

## Recovery Procedures
### Restart Orchestrator
1. Stop current dev process with `Ctrl+C`.
2. Clear transient artifacts with `rm -rf node_modules/.vite`.
3. Restart with `npm run dev` and validate by loading the world.

### Partial Failure Handling
1. Identify failed component from logs: render loop, world generation, input, or persistence.
2. Isolate and retry by disabling the failing subsystem behind a feature flag or fallback path while keeping read-only world view available.
3. Verify healthy state by running `npm run test` and manual smoke flow for movement and block edit.

### Resource Ceiling Behavior
- CPU cap response: reduce render distance and chunk meshing budget per frame.
- Memory cap response: evict far chunks from memory and compact block edit history.
- Disk cap response: rotate save snapshots and keep latest plus one rollback snapshot.
