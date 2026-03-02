# Runbook — Decagon Assistant

## Document Ownership
- Type: Agent-maintained living artifact.
- Created by: User or template bootstrap before run.
- Updated by: Agent as operating procedures and recovery steps evolve.

## Operating Modes

### Local Development
```bash
npm run dev
```
Starts Next.js dev server on http://localhost:3000 with hot reload. Requires local Postgres or Neon connection string in `.env`.

### Production (Vercel)
Deployed automatically on push to `main`. Vercel handles build, serverless function deployment, and CDN for static assets. No manual intervention needed.

### Database Inspection
```bash
npx prisma studio
```
Opens a web UI on http://localhost:5555 for browsing conversations, messages, and memory entries.

## Monitoring

### Key Logs
- Vercel function logs: Vercel Dashboard > Project > Functions tab > Logs
- Local dev: stdout in the terminal running `npm run dev`
- Database queries: Set `DEBUG=prisma:query` in `.env` for verbose Prisma logging

### Key Metrics to Watch
- Anthropic API response latency (first token time) — should be under 500ms
- Database query latency — connection pool exhaustion shows as timeouts
- Vercel function duration — must stay under 10s on hobby tier (streaming keeps connection alive)
- Error rate on `/api/chat` — any 500s indicate broken streaming or API issues

### Failure Signals
- Chat messages show "Something went wrong" error — check Vercel function logs for Anthropic API errors
- Messages load but streaming doesn't start — check `Content-Type` header and `ReadableStream` response
- Page loads but conversation history is empty — database connection issue, check `DATABASE_URL`
- Slow first message after idle period — Vercel cold start + Prisma connection pool initialization (expected, ~2-3s)

## Recovery Procedures

### Anthropic API Failure
1. Check Anthropic status page: https://status.anthropic.com
2. Check API key validity: verify `ANTHROPIC_API_KEY` in Vercel environment variables
3. Check rate limits: Anthropic returns 429 with `retry-after` header
4. If rate limited: the UI should show a user-friendly "Please wait" message; no action needed
5. If API is down: the UI shows an error state; conversations are preserved in Postgres; service resumes automatically when API recovers

### Database Connection Failure
1. Check Neon/Supabase dashboard for database status
2. Verify `DATABASE_URL` is correct in Vercel environment variables
3. If connection pool exhausted: redeploy on Vercel to reset serverless function instances
4. If schema drift: run `npx prisma db push` against production database (use Neon branching for safety)
5. Verify recovery: open deployed URL, send a message, confirm it persists after refresh

### Corrupt Conversation State
1. Open Prisma Studio against the production database
2. Identify the corrupt conversation by ID
3. Delete orphaned messages or conversations with missing required fields
4. The UI will reflect the fix on next page load — no redeploy needed

### Vercel Deployment Failure
1. Check Vercel build logs for TypeScript compilation errors
2. Run `npm run build` locally to reproduce
3. Fix the build error, push to `main`
4. Vercel auto-redeploys on push

### Full Reset (Nuclear Option)
1. Drop and recreate the database: `npx prisma db push --force-reset` (destroys all data)
2. Redeploy on Vercel: Vercel Dashboard > Deployments > Redeploy
3. Verify: open URL, start a new conversation, confirm streaming works

## Resource Ceiling Behavior
- **Vercel function timeout (10s on hobby)**: Streaming keeps the connection alive, so long responses work. If Claude generates an extremely long response, the stream may be cut off at 10s. Mitigation: set `max_tokens` to 1024 in the Anthropic API call.
- **Database connection limit (Neon free tier: 20 connections)**: Prisma connection pooling handles this. If exceeded, requests queue and timeout after 5s. Mitigation: keep Prisma pool size at 5 in the connection string (`?connection_limit=5`).
- **Anthropic rate limits (free tier varies)**: Claude returns 429 errors. The API wrapper catches these and returns a retry-friendly error to the client. No server-side retry — let the user click "retry" to avoid runaway costs.
