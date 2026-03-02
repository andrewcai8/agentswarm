# Decagon Conversational Assistant

## Document Ownership
- Type: Agent-maintained living artifact.
- Created by: User or template bootstrap before run.
- Updated by: Agent during implementation; user may edit anytime.

A developer workflow copilot that feels like chatting with a sharp, friendly senior engineer. Built for the Decagon AI challenge. Powered by Claude, deployed on Vercel, with persistent memory and streaming responses.

## Prerequisites
- Node.js 20.x or later
- npm 10.x or later
- PostgreSQL 15+ (local) OR a Neon/Supabase connection string
- Anthropic API key with access to claude-sonnet-4-5-20250929

## Quick Start (Clean Machine)

1. Clone and install:
```bash
git clone <your-repo-url> decagon-assistant
cd decagon-assistant
npm install
```

2. Set up environment:
```bash
cp .env.example .env
```

Edit `.env` with your values:
```
ANTHROPIC_API_KEY=sk-ant-...
DATABASE_URL=postgresql://user:password@localhost:5432/decagon_assistant
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

3. Set up database:
```bash
npx prisma generate
npx prisma db push
```

4. Run development server:
```bash
npm run dev
```

5. Open http://localhost:3000 in your browser.

## Verify
- `npm run build` — TypeScript compilation, zero errors
- `npm run test` — All unit and integration tests pass
- `npm run lint` — Zero ESLint issues
- Open http://localhost:3000, send a message, verify streaming response appears within 500ms
- Send 3 messages in sequence, verify the 3rd response references context from the 1st
- Refresh the page, send "What were we talking about?" — verify it references the prior conversation

## Demo Flow (For Decagon Judges)
1. Open the deployed URL in a browser
2. Type "Hey, I'm working on a Next.js app and running into a weird hydration error"
3. Watch the response stream in real-time with natural, conversational tone
4. Follow up: "It happens when I use useEffect to fetch data on mount"
5. Observe the assistant builds on the prior context without re-asking
6. Ask: "Can you show me the right pattern?"
7. Verify the code snippet is syntax-highlighted with a copy button
8. Send 3-4 more messages deepening the conversation
9. Refresh the browser page
10. Type "What were we working on?" — verify the assistant recalls the full conversation context
11. Start a new conversation from the sidebar, verify the old one is listed and resumable

## Project Structure
```
src/
  app/                    # Next.js App Router
    page.tsx              # Main chat page
    layout.tsx            # Root layout with providers
    api/
      chat/route.ts       # Streaming chat completion endpoint
      conversations/route.ts  # Conversation CRUD
      memory/route.ts     # User memory endpoints
  components/             # React UI components
    ChatWindow.tsx        # Main chat container
    MessageBubble.tsx     # Individual message display
    InputBar.tsx          # Message input with send button
    Sidebar.tsx           # Conversation list sidebar
    CodeBlock.tsx         # Syntax-highlighted code rendering
    TypingIndicator.tsx   # Streaming indicator dots
  lib/                    # Core business logic
    anthropic.ts          # Claude API client + streaming
    conversation.ts       # Conversation CRUD + context windowing
    memory.ts             # Cross-session memory extraction + retrieval
    system-prompt.ts      # Dynamic prompt assembly
  types/                  # Shared TypeScript interfaces
    index.ts              # Message, Conversation, Memory types
prisma/
  schema.prisma           # Database schema
__tests__/                # Tests mirroring src structure
```

## Scripts
- `npm run dev` — Start development server on port 3000
- `npm run build` — Production build
- `npm run start` — Start production server
- `npm run test` — Run all tests
- `npm run lint` — Run ESLint
- `npm run db:push` — Push schema changes to database
- `npm run db:studio` — Open Prisma Studio for database inspection

## Deployment (Vercel)
1. Push to GitHub
2. Connect repo to Vercel
3. Set environment variables in Vercel dashboard: `ANTHROPIC_API_KEY`, `DATABASE_URL`
4. Deploy — Vercel auto-detects Next.js and configures build
5. Verify the deployed URL works with the demo flow above
