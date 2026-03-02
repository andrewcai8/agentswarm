# Repository Conventions — Decagon Assistant

## Document Ownership
- Type: User input to swarm.
- Created by: User before run.
- Updated by: User is primary editor; agents may propose updates when constraints are unclear or conflicting.

## Scope Discipline
- Derive tasks from `SPEC.md` boundaries and acceptance tests.
- Prefer small, merge-safe changes; avoid broad refactors unless required by acceptance tests.
- If scope is insufficient, report gap explicitly and propose a bounded follow-up.
- Every task must map to at least one acceptance test or must-have capability from SPEC.md.

## Code Style
- Follow Next.js App Router conventions: `page.tsx` for pages, `route.ts` for API handlers, `layout.tsx` for layouts.
- Use TypeScript strict mode. All functions have explicit parameter and return types.
- React components use functional style with hooks. No class components.
- Use named exports, not default exports (except for Next.js pages which require default).
- File naming: `kebab-case.ts` for modules, `PascalCase.tsx` for React components.
- Avoid placeholder code, TODO stubs, and disabled checks.
- Keep functions under 50 lines. Extract logic into well-named helpers in the same file.
- Use `async/await` everywhere, never raw `.then()` chains.
- CSS: Tailwind utility classes only. No inline styles, no CSS modules, no global CSS beyond `globals.css`.

## Dependencies
- Allowed runtime: `next`, `react`, `react-dom`, `@anthropic-ai/sdk`, `@prisma/client`, `zod`, `nanoid`, `date-fns`.
- Allowed dev: `typescript`, `prisma`, `tailwindcss`, `postcss`, `autoprefixer`, `jest`, `@testing-library/react`, `@testing-library/jest-dom`, `eslint`, `prettier`.
- Do not introduce any dependency not on this list without explicit justification in the handoff.
- If a task can be done with native APIs (fetch, ReadableStream, TextEncoder), do not add a library.

## Testing Policy
- Run targeted tests relevant to changed files before completion.
- Run all acceptance-test commands in `SPEC.md` before final handoff: `npm run build`, `npm run test`, `npm run lint`.
- Never delete or weaken tests to make failures disappear.
- Test files live in `__tests__/` mirroring `src/` structure (e.g., `__tests__/lib/memory.test.ts`).
- Unit tests for `src/lib/` modules are required — these are the core logic.
- Component tests for key UI components (ChatWindow, MessageBubble) using Testing Library.
- API route tests using mocked request/response objects.
- Minimum test coverage: every exported function in `src/lib/` has at least one happy-path and one error-path test.

## Commit Expectations
- Make focused commits that map directly to acceptance tests or specific capabilities.
- Commit message format: `feat(scope): concise summary` or `fix(scope): concise summary`.
- Scopes: `ui`, `api`, `lib`, `db`, `config`, `test`, `deploy`.
- Examples: `feat(ui): add streaming message bubble with typing indicator`, `feat(lib): implement cross-session memory extraction`, `fix(api): handle Anthropic API timeout gracefully`.
- Include brief rationale in commit body when behavior changes are non-obvious.

## Safety / Quality
- No `any` types. Use `unknown` and narrow with type guards if the type is truly dynamic.
- No `@ts-ignore` or `@ts-expect-error` without explicit approval.
- No `eslint-disable` comments without explicit approval.
- All API routes validate input with Zod schemas. Never trust client input.
- Never log sensitive data (API keys, full conversation content in production logs).
- Anthropic API key must only exist in server-side environment variables, never in client bundles.
- Handle all async errors — no unhandled promise rejections.
- Preserve backward compatibility for database schema changes — always create migrations, never edit existing ones.

## Streaming-Specific Constraints
- Chat endpoint must use `ReadableStream` and `TransformStream` for token-by-token delivery.
- Response content type must be `text/event-stream` for SSE or `application/octet-stream` for raw streaming.
- Client must use `fetch` with `response.body.getReader()` — no polling, no WebSocket libraries.
- Streaming must handle backpressure — if the client disconnects, the server stream must close cleanly.
- Each streamed chunk must be a valid parseable unit (complete JSON object or complete text segment).

## Conversation & Memory Constraints
- Conversation messages are stored in Postgres immediately upon send/receive, not batched.
- Context window management: use a sliding window of recent messages plus a summary of older messages.
- Memory extraction runs after each assistant response — extract key facts (user name, tech stack, preferences) asynchronously.
- Memory retrieval runs before system prompt assembly — inject relevant memories into system prompt.
- Memory storage uses a simple key-value model: `{ userId, key, value, updatedAt }`.
- Conversation context window target: last 20 messages verbatim + summary of prior messages.

## Freshness Requirements
- Keep `README.md`, `SPEC.md`, `DECISIONS.md`, and `RUNBOOK.md` aligned with current implementation.
- Rewrite stale sections instead of appending contradictory notes.
- When a database schema changes, update `README.md` setup commands and `RUNBOOK.md` recovery steps.
