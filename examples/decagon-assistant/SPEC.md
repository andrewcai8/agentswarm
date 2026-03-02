# Decagon Conversational Assistant — Project Spec

## Document Ownership
- Type: User input to swarm.
- Created by: User before run.
- Updated by: User is primary editor; agents may propose edits but must not change intent, success criteria ranking, or non-negotiables without explicit user approval.

## Product Statement
We are building a developer workflow copilot — a conversational AI assistant that feels humanlike and natural — for the Decagon AI challenge. The assistant is a full-stack Next.js application powered by the Anthropic Claude API, deployed publicly, featuring real-time streaming responses, persistent cross-session memory, and deep multi-turn context understanding. The target audience is Decagon judges evaluating conversational quality, naturalness, context retention, and genuine utility for developer workflows (code review, debugging, architecture guidance, workflow optimization).

## Success Criteria (Ranked)
1. **Naturalness**: Conversations feel indistinguishable from chatting with a sharp, friendly senior engineer. No robotic phrasing, no walls of text, no over-hedging. Responses match the user's energy — terse when they're terse, detailed when they ask for depth.
2. **Context retention**: The assistant remembers everything within a session and key facts across sessions. It references prior conversation points naturally ("You mentioned earlier you were using Postgres — did you end up switching?"). It never asks for information already provided.
3. **Utility**: The assistant genuinely helps developers accomplish real tasks — reviewing code snippets, explaining error messages, suggesting architecture patterns, debugging logic, improving workflows. Responses are actionable, not generic.

### Hard Limits
- Time budget: 24 hours from first commit to deployed demo
- Resource budget: Vercel hobby tier (serverless functions, 10s timeout on hobby — use streaming to work around), Neon/Supabase free tier for Postgres
- External services: Anthropic Claude API (claude-sonnet-4-5-20250929 primary, claude-haiku-4-5-20251001 for memory summarization), no other paid APIs
- Runtime mode: Deployed publicly on Vercel with HTTPS, must work on mobile and desktop browsers

## Acceptance Tests (Runnable, Objective)
- `npm run build` completes with zero errors and zero TypeScript warnings
- `npm run test` passes all unit and integration tests with 0 failures
- `npm run lint` returns 0 issues
- Opening the deployed URL in a browser shows the chat interface within 2 seconds
- Sending "Hello, I'm working on a React project" and then "Can you help me debug a useEffect issue?" in sequence produces a response that references the React context from the first message without re-asking
- Refreshing the page and sending "What were we talking about?" returns a response that references the previous conversation
- Streaming tokens appear in the UI within 500ms of sending a message (no full-response delay)
- Sending 10 messages in a conversation maintains coherent context throughout — the 10th response references relevant details from messages 1-3
- The assistant responds with varied sentence structure and length — no two consecutive responses start the same way
- Sending a code snippet with a bug produces a response that identifies the specific bug, explains why it's wrong, and provides a corrected version

## Non-Negotiables
- No TODOs, placeholders, or pseudocode in core paths.
- Every API route has input validation and explicit error handling with user-friendly error messages.
- Every major component has at least one minimal test.
- No silent failures; errors are surfaced in both server logs and client UI.
- No hidden background assumptions; all required setup is documented.
- Streaming must work — no buffered full-response delivery. Tokens appear incrementally.
- Conversation history is persisted to database, not just in-memory or localStorage.
- The UI must be responsive (mobile + desktop) and feel polished enough for a demo.
- No exposed API keys in client-side code.

## Architecture Constraints
### Topology
- Repo structure: monorepo (single Next.js app with API routes)
- Primary boundaries: UI (React components) / API (Next.js route handlers) / Storage (Postgres via Prisma) / LLM (Anthropic SDK wrapper)

### Contracts
- API contract source of truth: `src/app/api/` — Next.js App Router route handlers
- Database schema source of truth: `prisma/schema.prisma`
- Type definitions source of truth: `src/types/` — shared TypeScript interfaces

### File/Folder Expectations
- `src/app/`: Next.js App Router pages and layouts
- `src/app/api/chat/`: Chat completion streaming endpoint
- `src/app/api/conversations/`: CRUD for conversation history
- `src/app/api/memory/`: User memory/profile persistence endpoints
- `src/components/`: React UI components (ChatWindow, MessageBubble, InputBar, Sidebar)
- `src/lib/`: Core logic — Anthropic client wrapper, memory manager, conversation manager, system prompt builder
- `src/lib/anthropic.ts`: Anthropic SDK client initialization and streaming wrapper
- `src/lib/memory.ts`: Cross-session memory extraction, storage, and retrieval
- `src/lib/conversation.ts`: Conversation CRUD, message history management, context windowing
- `src/lib/system-prompt.ts`: Dynamic system prompt assembly from user memory + conversation context
- `src/types/`: Shared TypeScript interfaces and types
- `prisma/`: Database schema and migrations
- `__tests__/`: Test files mirroring src structure

## Dependency Philosophy
### Allowed
- `next` (14.x) — App Router, RSC, route handlers
- `react`, `react-dom` (18.x) — UI
- `@anthropic-ai/sdk` — Claude API client
- `prisma`, `@prisma/client` — Database ORM
- `tailwindcss`, `postcss`, `autoprefixer` — Styling
- `zod` — Runtime input validation
- `nanoid` — ID generation
- `date-fns` — Date formatting
- `jest`, `@testing-library/react`, `@testing-library/jest-dom` — Testing
- `typescript`, `eslint`, `prettier` — Dev tooling

### Banned
- No CSS-in-JS libraries (styled-components, emotion) — use Tailwind only
- No state management libraries (Redux, Zustand, Jotai) — React state + server state is sufficient
- No alternative LLM SDKs (langchain, llamaindex, vercel ai sdk) — use Anthropic SDK directly for full control
- No real-time frameworks (socket.io, pusher) — use native fetch streaming with ReadableStream
- No authentication libraries for MVP — no NextAuth, Clerk, etc. (out of scope)

### Scaffold-Only (Must Be Replaced)
- Mock in-memory storage may be used during initial development but must be replaced with Prisma/Postgres before acceptance testing

## Scope Model
### Must Have (7)
- Real-time streaming chat responses via Claude API with incremental token delivery
- Multi-turn conversation with full context window management (sliding window + summarization)
- Persistent conversation history stored in Postgres (create, list, continue, delete conversations)
- Cross-session user memory (assistant remembers user preferences, tech stack, name, working context)
- Dynamic system prompt that injects relevant user memories and conversation context
- Polished chat UI with message bubbles, typing indicators, markdown rendering, code syntax highlighting
- Deployed to Vercel with working public URL

### Nice to Have (5)
- Conversation title auto-generation from first message
- Code block copy button in rendered messages
- Keyboard shortcuts (Enter to send, Shift+Enter for newline, Ctrl+N new conversation)
- Dark mode / light mode toggle
- Conversation search/filter in sidebar

### Out of Scope
- User authentication / multi-user support (single-user demo is sufficient)
- Voice input/output
- File upload or image analysis
- Tool use / function calling (the assistant is purely conversational)
- Rate limiting or abuse prevention (demo context, not production)
- Analytics or telemetry
- Mobile native app (responsive web is sufficient)
- Webhook integrations or external service connections

## Throughput / Scope Ranges
- Initial task fan-out target: 15-30 worker tasks in first 2 hours
- Change size target: 8-15 PR-sized changes, each self-contained and testable
- Parallelism target: 2-4 active branches per subsystem (UI, API, lib, DB)
- Runtime target window: Core chat working in 6 hours, full feature set in 16 hours, polish + deploy in 24 hours

## Reliability Requirements (Long-Run Defense)
- Must survive process restarts without losing conversation history (Postgres persistence).
- Must tolerate Anthropic API failures gracefully — show user-friendly error, allow retry, don't corrupt conversation state.
- Streaming must handle client disconnects cleanly — no orphaned server processes or database corruption.
- Context window overflow must be handled via summarization, not truncation or crash.
- Database connection pooling must handle Vercel serverless cold starts.

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
- Application is deployed to Vercel and accessible via public URL.
- A Decagon judge can open the URL, have a 10-message conversation about debugging a React app, refresh the page, and the assistant remembers the context.
