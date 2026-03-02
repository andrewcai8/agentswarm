# Repository Conventions (Template)

## Document Ownership
- Type: User input to swarm.
- Created by: User before run.
- Updated by: User is primary editor; agents may propose updates when constraints are unclear or conflicting.

## Scope Discipline
- Derive tasks from `SPEC.md` boundaries and acceptance tests.
- Prefer small, merge-safe changes; avoid broad refactors unless required by acceptance tests.
- If scope is insufficient, report gap explicitly and propose a bounded follow-up.

## Code Style
- Follow existing naming, module boundaries, and patterns in this repository.
- Avoid placeholder code, TODO stubs, and disabled checks.
- Keep functions small and readable; prefer explicit types.

## Dependencies
- Allowed: `<list allowed runtime/test deps or "none without approval">`.
- Do not introduce new dependencies without a clear justification in handoff.

## Testing Policy
- Run targeted tests relevant to changed files before completion.
- Run all acceptance-test commands in `SPEC.md` before final handoff.
- Never delete or weaken tests to make failures disappear.

## Commit Expectations
- Make focused commits that map directly to acceptance tests.
- Commit message format: `<e.g. feat(scope): concise summary>`.
- Include brief rationale in commit body when behavior changes are non-obvious.

## Safety / Quality
- No `any`, `@ts-ignore`, or equivalent type-safety bypasses without explicit approval.
- Preserve backward compatibility unless the feature explicitly requires a breaking change.
- If blocked after multiple attempts, return a clear blocked handoff with attempted fixes.

## Freshness Requirements
- Keep `README.md`, `SPEC.md`, `DECISIONS.md`, and `RUNBOOK.md` aligned with current implementation.
- Rewrite stale sections instead of appending contradictory notes.
