# Entry Point — Decagon Assistant

This file explains the purpose of each markdown document in this project and the order to use them.

## Ownership Matrix
| File | Created Before First Swarm Run By | Updated During Swarm Run By | Role |
|---|---|---|---|
| `SPEC.md` | User | User (agents may propose edits) | Product contract: what we're building, success criteria, acceptance tests, scope boundaries |
| `AGENTS.md` | User | User (agents may propose edits) | Execution policy: coding conventions, dependency rules, testing requirements, commit format |
| `README.md` | Template bootstrap | Agent | Quick start: exact setup, run, verify, and deploy commands from clean machine |
| `RUNBOOK.md` | Template bootstrap | Agent | Operations: monitoring signals, recovery procedures, resource ceiling behavior |
| `DECISIONS.md` | Template bootstrap | Agent | Architecture log: key technical choices with rationale and alternatives |

## Read Order
1. `SPEC.md` — Understand what we're building and what "done" means
2. `AGENTS.md` — Understand how to write code in this repo
3. `README.md` — Understand how to set up and run the project
4. `RUNBOOK.md` — Understand how to operate and recover the system
5. `DECISIONS.md` — Understand why the architecture looks the way it does

## File Roles

### `SPEC.md`
- Product contract for the Decagon conversational assistant challenge.
- Defines: product statement, ranked success criteria (naturalness > context > utility), acceptance tests, architecture constraints, dependency philosophy, scope model, and definition of done.
- Source of truth for "what we are building" and "what counts as done."
- User input file. Agents may propose changes but must not alter intent, success criteria ranking, or non-negotiables.

### `AGENTS.md`
- Execution policy for all coding agents working in this repo.
- Defines: code style (Next.js App Router conventions, TypeScript strict), dependency allowlist, testing policy (unit + component + API route tests), commit format, streaming constraints, conversation/memory constraints.
- Source of truth for "how work should be done in this repo."
- User input file.

### `README.md`
- Quick start for humans and automation.
- Contains exact commands: clone, install, env setup, database setup, dev server, build, test, lint, deploy.
- Source of truth for "how to run this project from a clean machine."
- Agent-maintained — updated as setup steps evolve.

### `RUNBOOK.md`
- Operations and incident handling guide.
- Defines: operating modes (local dev, Vercel production), monitoring signals (API latency, error rates, cold starts), recovery procedures (API failure, database issues, deployment failure).
- Source of truth for "how to operate and recover the system."
- Agent-maintained.

### `DECISIONS.md`
- Architecture decision log.
- Captures: direct Anthropic SDK (over Vercel AI SDK), App Router (over Pages), Postgres+Prisma (over localStorage), SSE streaming (over WebSocket), sliding window context (over full history), key-value memory (over vector store), Tailwind (over component libs).
- Source of truth for "why the architecture looks this way."
- Agent-maintained.

## Maintenance Rules
- Keep all files consistent with current implementation.
- Rewrite stale sections instead of appending contradictory notes.
- If behavior changes, update `SPEC.md`, `README.md`, `RUNBOOK.md`, and `DECISIONS.md` in the same change.
- When database schema changes, update `README.md` setup commands and `RUNBOOK.md` recovery steps in the same commit.
