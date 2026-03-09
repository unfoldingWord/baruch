# Baruch — AI Configuration Assistant for BT Servant

## Project Overview

Baruch is a Cloudflare Worker that powers an AI configuration assistant. Instead of manually editing prompt overrides, modes, and MCP servers through the admin portal, admins chat with Baruch, who calls bt-servant-worker's admin API endpoints under the hood.

## Architecture

- **Runtime**: Cloudflare Workers with Durable Objects
- **Framework**: Hono router
- **AI**: Claude (Anthropic SDK) with tool use
- **Storage**: KV for prompt overrides, DO storage for user sessions/queues/memory

## Key Conventions

### Never Do

- Never push directly to main without asking
- Never run `wrangler deploy` directly — all deploys through CI/CD
- Never merge a PR without user permission
- Never commit secrets or `.dev.vars`
- Never let security lint warnings (e.g. `security/detect-object-injection`) slide — fix the code or add an `eslint-disable-next-line` with a justification comment before merging

### Code Quality (Fitness Functions)

- **max-lines-per-function**: 50 (skip blanks/comments)
- **max-statements**: 25 per function
- **complexity**: 10 (cyclomatic)
- **max-depth**: 4 (nested blocks)
- **max-nested-callbacks**: 3
- **max-params**: 5

### Architecture Rules

- Types layer (`src/types/`) has zero internal dependencies
- Services cannot depend on routes
- No circular dependencies
- Run `pnpm architecture` to verify

### Testing

- Unit tests in `tests/unit/`
- E2E tests in `tests/e2e/`
- E2E tests skip on Windows (SQLite/workerd incompatibility)
- Run `pnpm test` before committing

### Code Review Policy

- After opening or updating a PR, always run the claude-code-review agent
- Fix all issues found by the reviewer, including low-severity ones
- After fixing, re-run the reviewer again
- Keep iterating (fix → re-review) until the reviewer finds zero issues

### Prompt System

Baruch has 4 admin-configurable prompt slots:

- `identity` — Who Baruch is
- `methodology` — How Baruch guides configuration
- `tool_guidance` — How Baruch uses admin API tools
- `instructions` — Behavioral rules and constraints

Single-tier override: admin KV overrides → hardcoded defaults (no user/mode hierarchy).

### Admin API Tools (10 total)

Baruch calls bt-servant-worker's admin API via `ENGINE_API_KEY`:

- Prompt overrides: get, set
- Modes: list, get, create/update, delete
- MCP servers: list, set
- Memory: read, update (internal DO)

### Environments

- **dev**: `baruch-dev` — auto-deployed on PRs to main
- **staging**: `baruch-staging` — deployed when CI passes on main
- **prod**: `baruch` — manual dispatch only
