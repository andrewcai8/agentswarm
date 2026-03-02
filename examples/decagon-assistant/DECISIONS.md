# Architecture Decisions — Decagon Assistant

## Document Ownership
- Type: Agent-maintained living artifact.
- Created by: User or template bootstrap before run.
- Updated by: Agent whenever architecture-affecting choices are made; user can override or mark replaced.

## Format
Use short entries:
- Date: `YYYY-MM-DD`
- Decision: what was chosen
- Why: rationale
- Alternatives considered: brief list
- Status: active | replaced

## Decisions

### Direct Anthropic SDK over Vercel AI SDK
- Date: 2026-02-14
- Decision: Use `@anthropic-ai/sdk` directly instead of the Vercel AI SDK or LangChain.
- Why: Full control over streaming behavior, system prompt construction, and error handling. The Vercel AI SDK abstracts away details we need for natural conversation tuning (token-level streaming control, custom system prompt injection per request, precise context window management). LangChain adds unnecessary abstraction for a single-provider use case.
- Alternatives considered: Vercel AI SDK (simpler but less control), LangChain (too heavy, unnecessary abstraction layer), raw fetch to Anthropic API (too low-level, SDK handles auth and retries).
- Status: active

### Next.js App Router over Pages Router
- Date: 2026-02-14
- Decision: Use Next.js 14 App Router with server components and route handlers.
- Why: Route handlers provide native streaming support via `ReadableStream`. Server components reduce client bundle size. App Router is the current standard and what Decagon judges will expect from a modern Next.js app. Aligns with Vercel deployment patterns.
- Alternatives considered: Pages Router (stable but older pattern), separate Express backend + React SPA (more infra to manage, harder to deploy as one unit), Remix (less Vercel-native).
- Status: active

### Postgres with Prisma over In-Memory or localStorage
- Date: 2026-02-14
- Decision: Use PostgreSQL (Neon free tier) with Prisma ORM for all persistence — conversations, messages, and user memory.
- Why: Cross-session memory is a must-have. localStorage doesn't survive incognito or device switches. In-memory storage doesn't survive serverless cold starts on Vercel. Postgres gives us durable, queryable storage. Prisma provides type-safe database access that matches our TypeScript-strict policy. Neon's free tier provides serverless Postgres that pairs naturally with Vercel's serverless functions.
- Alternatives considered: SQLite (doesn't work on Vercel serverless), Supabase (heavier than needed), Redis (good for cache but not primary storage), Vercel KV (limited query capability).
- Status: active

### SSE-Style Streaming over WebSockets
- Date: 2026-02-14
- Decision: Use server-sent events pattern (ReadableStream in route handler, fetch + getReader on client) instead of WebSockets.
- Why: Vercel serverless functions don't support persistent WebSocket connections. SSE works natively with fetch API, requires no additional libraries, and streams through Vercel's edge network cleanly. The conversation pattern is request-response (user sends, assistant streams back) — full duplex is unnecessary.
- Alternatives considered: WebSocket via socket.io (Vercel incompatible without separate server), polling (bad UX, high latency), Vercel Edge Runtime with WebSocket (experimental, unreliable).
- Status: active

### Sliding Window + Summary for Context Management
- Date: 2026-02-14
- Decision: Keep the last 20 messages verbatim in the context window, and summarize older messages into a rolling summary using Claude Haiku.
- Why: Claude's context window is large but not infinite. Verbatim recent messages preserve conversational flow and detail. Summarizing older messages with Haiku (fast, cheap) preserves key facts without burning context tokens. 20 messages gives enough recency for natural conversation while leaving room for system prompt and memory injection.
- Alternatives considered: Full history truncation (loses context abruptly), embedding-based retrieval (over-engineered for MVP), no summarization with just truncation (loses important early context).
- Status: active

### Key-Value Memory Model over Vector Store
- Date: 2026-02-14
- Decision: Store user memories as simple key-value pairs (`{ userId, key, value, updatedAt }`) in Postgres rather than using a vector database.
- Why: The memory needs are structured and finite — user name, preferred language, tech stack, current project, communication preferences. These are naturally key-value. Vector search is overkill when we can inject all relevant memories directly into the system prompt (user will have at most 20-50 memory entries). Avoids adding a vector database dependency.
- Alternatives considered: Pinecone/Weaviate vector store (unnecessary complexity), JSON blob in a single row (harder to query and update individually), embeddings in Postgres with pgvector (adds extension dependency).
- Status: active

### Tailwind CSS over Component Libraries
- Date: 2026-02-14
- Decision: Use Tailwind CSS utility classes for all styling. No component library (shadcn/ui, Chakra, MUI).
- Why: The UI is a chat interface — fundamentally simple components (message bubbles, input bar, sidebar). A component library adds bundle size and opinionated styling that would need to be overridden for a custom conversational feel. Tailwind gives full control over the visual design while keeping the build fast. The "polished demo" requirement is better served by intentional design than by library defaults.
- Alternatives considered: shadcn/ui (good but adds many files for few components used), Chakra UI (heavy, React Server Component issues), raw CSS modules (no utility benefit).
- Status: active
