# Project Repo Spec Template

## Document Ownership
- Type: User input to swarm.
- Created by: User before run.
- Updated by: User is primary editor; agents may propose edits but must not change intent, success criteria ranking, or non-negotiables without explicit user approval.

## Product Statement
`<2-4 sentences: what you are building, for whom, and the primary use case>`

## Success Criteria (Ranked)
1. `<highest-priority outcome with measurable target>`
2. `<second-priority outcome with measurable target>`
3. `<third-priority outcome with measurable target>`

### Hard Limits
- Time budget: `<e.g. 8 hours>`
- Resource budget: `<e.g. <= 2 CPU cores, <= 2 GB RAM, <= 1 GB disk>`
- External services: `<e.g. no paid APIs>`
- Runtime mode: `<e.g. must run offline>`

## Acceptance Tests (Runnable, Objective)
- `<exact command>` results in `<exact expected output/behavior>`
- `<exact command>` results in `<exact expected output/behavior>`
- `<manual flow with clear pass condition>`
- `<end-to-end scenario with deterministic expected result>`

## Non-Negotiables
- No TODOs, placeholders, or pseudocode in core paths.
- Every endpoint or command surface has validation and explicit error handling.
- Every major component has at least one minimal test.
- No silent failures; errors are surfaced in logs and UI.
- No hidden background assumptions; all required setup is documented.

## Architecture Constraints
### Topology
- Repo structure: `<monorepo | multi-package>`
- Primary boundaries: `<e.g. UI / API / worker / storage>`

### Contracts
- Event schema source of truth: `<path>`
- API contract source of truth: `<path>`
- Storage schema source of truth: `<path>`

### File/Folder Expectations
- `src/<area-a>/`: `<responsibility>`
- `src/<area-b>/`: `<responsibility>`
- `src/<area-c>/`: `<responsibility>`

## Dependency Philosophy
### Allowed
- `<list approved frameworks/libraries>`

### Banned
- `<list forbidden categories or specific packages>`

### Scaffold-Only (Must Be Replaced)
- `<temporary scaffolding deps/tools allowed early but not in final>`

## Scope Model
### Must Have (3-7)
- `<capability spine 1>`
- `<capability spine 2>`
- `<capability spine 3>`

### Nice to Have (3-7)
- `<optional enhancement 1>`
- `<optional enhancement 2>`
- `<optional enhancement 3>`

### Out of Scope
- `<tempting but intentionally excluded item 1>`
- `<tempting but intentionally excluded item 2>`
- `<tempting but intentionally excluded item 3>`

## Throughput / Scope Ranges
- Initial task fan-out target: `<e.g. 30-80 worker tasks in first hour>`
- Change size target: `<e.g. 10-20 PR-sized changes, avoid one giant PR>`
- Parallelism target: `<e.g. 1-3 active branches per subsystem>`
- Runtime target window: `<e.g. demo-ready in 2-4 hours>`

## Reliability Requirements (Long-Run Defense)
- Must survive process restarts without losing critical state.
- Must tolerate partial failures and continue degraded operation.
- Event ingestion and mutation endpoints are idempotent.
- Backpressure and rate limits prevent UI/API overload.
- Behavior under resource ceilings is explicit and testable.

## Required Living Artifacts
The repo must include and keep these files current:
- `README.md`: exact local setup and run commands from clean machine.
- `SPEC.md`: rewritten to current intent; do not append stale plans.
- `DECISIONS.md`: short architecture decisions with rationale and status.
- `RUNBOOK.md`: operational guide for running, monitoring, and recovery.

## Definition of Done
- All acceptance tests pass.
- Must-have scope is complete.
- Non-negotiables are satisfied.
- Required living artifacts are up-to-date and consistent with implementation.
