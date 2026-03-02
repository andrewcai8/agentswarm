# Entry Point

This file explains the purpose of each markdown document in this template and the order to use them.

## Ownership Matrix
| File | Created Before First Swarm Run By | Updated During Swarm Run By | Role |
|---|---|---|---|
| `SPEC.md` | User | User (agents may propose edits) | Product contract and acceptance boundary |
| `AGENTS.md` | User | User (agents may propose edits) | Execution policy and constraints |
| `README.md` | Template bootstrap | Agent | Template that agents update into current setup/run/verify commands |
| `RUNBOOK.md` | Template bootstrap | Agent | Template that agents update into current operating and recovery procedures |
| `DECISIONS.md` | Template bootstrap | Agent | Template that agents update into current architecture decision history and rationale |

## Read Order
1. `SPEC.md`
2. `AGENTS.md`
3. `README.md`
4. `RUNBOOK.md`
5. `DECISIONS.md`

## File Roles

### `SPEC.md`
- Product contract.
- Defines goals, success criteria, acceptance tests, architecture boundaries, constraints, and scope.
- Source of truth for "what we are building" and "what counts as done."
- User input file.

### `AGENTS.md`
- Execution policy for coding agents.
- Defines coding guardrails, test expectations, commit behavior, and freshness rules.
- Source of truth for "how work should be done in this repo."
- User input file.

### `README.md`
- Quick start for humans and automation.
- Contains exact setup, run, and verification commands.
- Source of truth for "how to run this project from a clean machine."
- Starts as a template and is updated by agents during implementation.

### `RUNBOOK.md`
- Operations and incident handling guide.
- Defines monitoring signals, restart steps, and recovery procedures.
- Source of truth for "how to operate and recover the system."
- Starts as a template and is updated by agents during implementation.

### `DECISIONS.md`
- Short architecture decision log.
- Captures important tradeoffs and why choices were made.
- Source of truth for "why the architecture looks this way."
- Starts as a template and is updated by agents during implementation.

## Maintenance Rules
- Keep all files consistent with current implementation.
- Rewrite stale sections instead of appending contradictory notes.
- If behavior changes, update `SPEC.md`, `README.md`, `RUNBOOK.md`, and `DECISIONS.md` in the same change.
