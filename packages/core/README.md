# @longshot/core

Shared domain types, utilities, and infrastructure for the Longshot multi-agent system.

## Purpose

This package provides the foundational building blocks used by every other package in the monorepo: task and handoff types, structured logging, distributed tracing, and git utilities. It has **zero external dependencies** — pure TypeScript with only Node.js built-ins.

## Architecture

All exports flow through `src/index.ts`. The package is intentionally thin — no business logic, no side effects at import time.

## File Guide

| File | Description |
|------|-------------|
| `types.ts` | Core domain types: `Task`, `Handoff`, `HarnessConfig`, `MetricsSnapshot`, `SandboxStatus`, `LLMEndpoint`, `LogEntry` |
| `logger.ts` | Structured NDJSON logger. Dual output: file (all levels) and stdout (filtered by `LOG_LEVEL`). Tag logs per-agent with `createLogger(agentId, role)` |
| `tracer.ts` | Distributed tracing with `Tracer` and `Span` classes. Writes to `logs/trace-*.ndjson` and `logs/llm-detail-*.ndjson`. Propagate context across process boundaries with `Tracer.fromPropagated()` |
| `git.ts` | Async git utilities: `createBranch`, `checkoutBranch`, `mergeBranch` (fast-forward / rebase / merge-commit), `rebaseBranch`, `getDiffStat`, `getRecentCommits`, `getFileTree`, `hasUncommittedChanges` |
| `index.ts` | Public API barrel — re-exports everything above |

## Complexity

**Easy** — great first contribution target. Types are plain interfaces, utilities are thin wrappers, no complex state machines.

## How to Test

```bash
pnpm --filter @longshot/core build
```

There are no unit tests in this package currently. Add them alongside any new utility function.

## How to Modify

1. **Add a new type**: edit `types.ts` and re-export from `index.ts` if not already covered by `export *`.
2. **Add a git utility**: add an `async function` to `git.ts` following the existing pattern (promisified `execFile`, error wrapping, optional `cwd` parameter).
3. **Add a log level**: extend `LOG_LEVEL_ORDER` in `logger.ts` and update the `LogLevel` type.
4. **Add tracing attributes**: use `span.setAttribute(key, value)` or `span.setAttributes({})` anywhere you hold a `Span` reference.

Keep this package dependency-free. Any new import must come from `node:*` built-ins only.
