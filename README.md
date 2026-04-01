# Baruch

AI configuration assistant and knowledge base guide for [BT Servant](https://github.com/unfoldingWord/bt-servant-worker). Powered by Claude on Cloudflare Workers.

Admins chat with Baruch to configure bt-servant-worker (prompt overrides, modes, MCP servers) via admin API tools. Baruch also uses MCP tools directly to help users access connected knowledge bases.

## Architecture

| Layer     | Technology                                                    |
| --------- | ------------------------------------------------------------- |
| Runtime   | Cloudflare Workers + single Durable Object (UserDO)           |
| Router    | [Hono](https://hono.dev/)                                     |
| AI        | Claude via raw `globalThis.fetch()` to Anthropic Messages API |
| Storage   | KV (prompt overrides), DO SQLite (sessions, queues, memory)   |
| Streaming | SSE-first (POST `/enqueue` returns SSE stream directly)       |

The Anthropic SDK is kept as a **type-only** dependency. All HTTP calls use `globalThis.fetch()` to bypass Cloudflare's internal routing restrictions on SDK-managed fetch from Durable Object contexts.

### Request Flow

```
Client
  |
  v
Baruch Worker (stateless Hono router)
  |
  v
UserDO (per-user Durable Object)
  ├── Chat processing (orchestration loop)
  ├── Queue (internal FIFO, fetch handler context)
  ├── History, preferences, memory (DO storage)
  ├── Prompt resolution (KV overrides + defaults)
  └── MCP tool discovery (parallel at chat time)
        |
        v
  Claude API  +  bt-servant-worker API  +  MCP servers
```

## API Endpoints

All `/api/*` routes require `Authorization: Bearer <BARUCH_API_KEY>`.

### Chat

| Method | Path                         | Description                                  |
| ------ | ---------------------------- | -------------------------------------------- |
| `POST` | `/api/v1/chat`               | Synchronous chat (JSON response)             |
| `POST` | `/api/v1/chat/stream`        | Streaming chat (SSE response)                |
| `POST` | `/api/v1/chat/initiate`      | Opening message (SSE, cached after first)    |
| `POST` | `/api/v1/chat/queue`         | Enqueue message (SSE stream or 202 callback) |
| `GET`  | `/api/v1/chat/queue/:userId` | Queue status                                 |

### User Data

| Method       | Path                                          | Description           |
| ------------ | --------------------------------------------- | --------------------- |
| `GET/PUT`    | `/api/v1/orgs/:org/users/:userId/preferences` | Response language     |
| `GET/DELETE` | `/api/v1/orgs/:org/users/:userId/history`     | Chat history (max 50) |
| `GET/DELETE` | `/api/v1/orgs/:org/users/:userId/memory`      | Persistent memory     |

### Health

| Method | Path      | Description            |
| ------ | --------- | ---------------------- |
| `GET`  | `/health` | Health check (no auth) |

## SSE Event Format

All streaming endpoints emit `data: JSON\n\n` events:

| Event Type    | Payload                                                                          |
| ------------- | -------------------------------------------------------------------------------- |
| `status`      | `{ type: "status", message: "..." }`                                             |
| `progress`    | `{ type: "progress", text: "..." }`                                              |
| `tool_use`    | `{ type: "tool_use", tool: "...", input: {...} }`                                |
| `tool_result` | `{ type: "tool_result", tool: "...", result: {...} }`                            |
| `complete`    | `{ type: "complete", response: { responses: [...], response_language: "..." } }` |
| `error`       | `{ type: "error", error: "..." }`                                                |

## Built-in Tools (14)

**BT Servant admin API** (8) -- calls bt-servant-worker:
`get_prompt_overrides`, `set_prompt_overrides`, `list_modes`, `get_mode`, `create_or_update_mode`, `delete_mode`, `list_mcp_servers`, `set_mcp_servers`

**Baruch self-config** (4) -- reads/writes Baruch's own KV:
`get_baruch_prompt_overrides`, `set_baruch_prompt_overrides`, `get_baruch_mcp_servers`, `set_baruch_mcp_servers`

**Memory** (2) -- per-user DO storage:
`read_memory`, `update_memory`

**MCP tools** (dynamic) -- discovered at chat time from configured MCP servers.

Admin-only tools (`set_*`) are filtered from non-admin users at both the tool list and dispatch layers.

## Prompt System

5 admin-configurable slots, single-tier override (KV overrides win over hardcoded defaults):

| Slot                | Purpose                          |
| ------------------- | -------------------------------- |
| `identity`          | Who Baruch is                    |
| `methodology`       | How Baruch guides configuration  |
| `tool_guidance`     | How Baruch uses built-in tools   |
| `mcp_tool_guidance` | How Baruch uses MCP tools        |
| `instructions`      | Behavioral rules and constraints |

## Development

### Prerequisites

- Node.js >= 20
- pnpm >= 9
- Cloudflare account with Workers, KV, and Durable Objects

### Setup

```bash
pnpm install
cp .dev.vars.example .dev.vars  # Add your secrets
pnpm dev                        # Start local dev server
```

### Required Secrets

Set via `wrangler secret put <name>` or in `.dev.vars` for local dev:

| Secret              | Description                |
| ------------------- | -------------------------- |
| `ANTHROPIC_API_KEY` | Anthropic API key          |
| `BARUCH_API_KEY`    | Service authentication key |
| `ENGINE_API_KEY`    | bt-servant-worker API key  |
| `ENGINE_BASE_URL`   | bt-servant-worker base URL |

### Scripts

| Script              | Description                |
| ------------------- | -------------------------- |
| `pnpm dev`          | Local development server   |
| `pnpm test`         | Run all tests              |
| `pnpm check`        | TypeScript type check      |
| `pnpm lint`         | ESLint                     |
| `pnpm architecture` | Dependency rule validation |
| `pnpm format:check` | Prettier check             |
| `pnpm build`        | Build worker               |

### Code Quality

Enforced via ESLint fitness functions and pre-commit hooks:

- **max-lines-per-function**: 50
- **max-statements**: 25
- **complexity**: 10 (cyclomatic)
- **max-depth**: 4
- **max-nested-callbacks**: 3
- **max-params**: 5

Architecture rules (via [dependency-cruiser](https://github.com/sverweij/dependency-cruiser)):

- Types layer (`src/types/`) has zero internal dependencies
- Services cannot depend on routes
- No circular dependencies

### Testing

- Unit tests: `tests/unit/` (runs everywhere)
- E2E tests: `tests/e2e/` (skip on Windows -- SQLite/workerd incompatibility)
- Uses `@cloudflare/vitest-pool-workers` for real Durable Object testing

```bash
pnpm test          # Run all tests
pnpm test:watch    # Watch mode
```

## Project Structure

```
src/
├── index.ts                    # Hono router, auth middleware, route handlers
├── config/
│   ├── types.ts                # Env interface
│   └── constants.ts            # DO base URL
├── types/
│   ├── engine.ts               # ChatRequest, ChatResponse, SSE events
│   ├── prompt-overrides.ts     # 5 prompt slots, defaults, validation
│   ├── queue.ts                # QueueEntry
│   └── mcp.ts                  # MCPServerConfig
├── durable-objects/
│   └── user-do.ts              # Unified DO: chat, queue, preferences, history, memory
├── services/
│   ├── claude/
│   │   ├── anthropic-client.ts # Raw fetch to Anthropic API + SSE parser
│   │   ├── sse-parser.ts       # SSE line parser (async generator)
│   │   ├── orchestrator.ts     # Tool use loop
│   │   ├── tools.ts            # 14 built-in tool definitions
│   │   └── system-prompt.ts    # System prompt assembly
│   ├── admin-api/              # bt-servant-worker API client
│   ├── mcp/                    # MCP discovery, catalog, health tracking
│   ├── memory/                 # Persistent user memory (JSON sections)
│   └── progress/               # Webhook callback delivery
├── utils/                      # Crypto, errors, logging, org resolution, templates
└── generated/
    └── version.ts              # Auto-generated version constant
```

## Environments

| Environment | Worker Name      | Deploy Trigger              |
| ----------- | ---------------- | --------------------------- |
| dev         | `baruch-dev`     | Auto on PR to main          |
| staging     | `baruch-staging` | Auto when CI passes on main |
| production  | `baruch`         | Manual dispatch only        |

## CI/CD

GitHub Actions pipeline on every push/PR to main:

1. **Security audit** -- `pnpm audit --prod`
2. **Lint** -- format check + ESLint
3. **Type check** -- `tsc --noEmit`
4. **Architecture** -- dependency-cruiser validation
5. **Test** -- vitest (unit + e2e on Linux)
6. **Build** -- wrangler build

Deploy workflows run after CI passes. Production requires manual workflow dispatch.
