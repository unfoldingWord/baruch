# Baruch — AI Configuration Assistant for BT Servant

## CRITICAL: Branching Model (develop → main)

Two long-lived branches:

- **`develop`** is the integration branch and the default branch. Every feature branch and every PR targets `develop`. Staging deploys automatically after CI passes on a push to `develop`. Bot review plus CI is enough to merge there.
- **`main`** is the release branch. It only ever receives `develop` (a release PR, "Release vX.Y.Z: develop → main") or a `hotfix/*` branch. Only the repo owner can merge to `main` (branch protection restricts pushes and requires a code-owner review; see `.github/CODEOWNERS`). Production deploys from `main` by tag.
- **Rule: `develop` is always releasable.** Work that is not ready to ship stays on its feature branch, or merges behind a flag that is off in production. Never cherry-pick into `main`; if something on `develop` must not ship, revert it on `develop` or flag it off, then release.
- **Hotfix:** branch from `main` as `hotfix/<name>`, PR into `main`, then open a PR from `main` into `develop` the same day so `develop` stays ahead of `main`.
- **Release:** merge the release PR, tag `v<version>` on the resulting `main` commit, dispatch the production deploy on that tag.
- **Merge methods:** feature PRs into `develop` are **squash**-merged (`develop` requires linear history). Release and hotfix PRs into `main` use a **merge commit**, never squash or rebase; a ruleset on `main` allows only merge commits. A squash would copy `develop`'s work into a new commit that `develop` never contains, so the branches would diverge and every later release PR would re-list already-shipped commits. With merge commits, the next release PR shows only what is new, and `git log --first-parent main` lists one commit per release. Never delete `develop` when merging a release PR.
- **Up to date before merge:** `develop` requires a PR branch to be current with `develop` before it merges (use "Update branch"), so two PRs that pass alone cannot break together. `main` does not, because `develop` never contains `main`'s release merge commits.

CI's `Release Source` job refuses a PR into `main` from any other branch. The production deploy (`deploy-prod.yml`) refuses to run on anything but a `v*` tag that is on `main`. `tests/unit/workflows-branching.test.ts` pins these triggers and guards.

### Ask Before Pushing

**ALWAYS ask the user before pushing changes.** Always create a feature branch and a PR against `develop`. Never push to `develop` or `main` directly.

## Project Overview

Baruch is a Cloudflare Worker that powers an AI configuration assistant and knowledge base guide. Admins chat with Baruch to configure bt-servant-worker (prompt overrides, modes, MCP servers) via admin API tools. Baruch also uses MCP tools directly to help users access connected knowledge bases.

## Architecture

- **Runtime**: Cloudflare Workers with single unified Durable Object (UserDO)
- **Framework**: Hono router
- **AI**: Claude via raw `globalThis.fetch()` to Anthropic API (SDK kept for types only)
- **Storage**: KV for prompt overrides, DO storage for user sessions/queues/memory
- **Streaming**: SSE-first — `/enqueue` returns SSE stream directly; callback mode also supported
- **Queue**: Internal FIFO within UserDO; processing in `fetch()` handler, `alarm()` as safety net only

## Key Conventions

### Never Do

- Never push directly to `develop` or `main`; every change is a PR into `develop`
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

Baruch has 5 admin-configurable prompt slots:

- `identity` — Who Baruch is
- `methodology` — How Baruch guides configuration and KB interaction
- `tool_guidance` — How Baruch uses its tools
- `mcp_tool_guidance` — How Baruch uses MCP tools and connected knowledge bases
- `instructions` — Behavioral rules and constraints

Single-tier override: admin KV overrides → hardcoded defaults (no user/mode hierarchy).

### Built-in Tools (14 total)

**BT Servant admin API tools** (8) — calls bt-servant-worker via `ADMIN_API_KEY` (falls back to `ENGINE_API_KEY` when unset):

- Prompt overrides: get, set
- Modes: list, get, create/update, delete
- MCP servers: list, set

**Baruch self-config tools** (4) — reads/writes Baruch's own KV:

- Baruch prompt overrides: get, set
- Baruch MCP servers: get, set

**Memory tools** (2) — internal DO storage:

- Memory: read, update

**MCP tools** (dynamic) — discovered at chat time from configured MCP servers, exposed directly as Claude tools.

### Environments

- **dev**: `baruch-dev` — auto-deployed on PRs into `develop` or `main` (`deploy-dev.yml`, or manual dispatch)
- **staging**: `baruch-staging` — deploys automatically after CI succeeds on a **push to `develop`** (`deploy-staging.yml`). PR branches never deploy, and CI runs for a release PR (whose head is also `develop`) do not deploy either.
- **prod**: `baruch` — manual `workflow_dispatch` of `deploy-prod.yml`, and only on a `v*` release tag that is on `main`. Any other ref is refused before anything deploys:

  ```bash
  gh workflow run deploy-prod.yml --ref v<version>
  ```

### Version Bumping and Release Tags

Every PR bumps the version in `package.json` on its branch, before the final push (the `version` lifecycle hook regenerates `src/generated/version.ts`):

- **Patch** (`pnpm version patch --no-git-tag-version`): bug fixes, docs, CI, minor tweaks
- **Minor** (`pnpm version minor --no-git-tag-version`): new features, behavioral changes

Use `--no-git-tag-version` on branches; feature PRs into `develop` are not tagged. After a release PR (`develop` → `main`) or hotfix is merged, tag the resulting `main` commit and push the tag, then dispatch the production deploy on it:

```bash
git checkout main && git pull
git tag v<version>
git push origin v<version>
```

Tags are created on `main` only, never on `develop`.
