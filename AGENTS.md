# Bosun Agent Guide

## Scope
Use this file as the top-level router for work inside `bosun/`.
Open the closest module `AGENTS.md` before editing.

## Start Fast
1. Confirm task area.
2. Jump to the mapped module below.
3. Edit only that module plus directly impacted callers/tests.
4. Run targeted tests, then `npm test`, then `npm run build`.

## Core Entry Points
- CLI: `cli.mjs`
- Setup: `setup.mjs`
- Monitor loop: `infra/monitor.mjs`
- Config loader: `config/config.mjs`

## Module Index
- `agent/AGENTS.md` - agent pool, prompts, hooks, autofix, fleet coordination.
- `infra/AGENTS.md` - monitor loop, health/recovery, runtime plumbing.
- `workflow/AGENTS.md` - workflow engine, nodes, adapters.
- `workflow-templates/AGENTS.md` - template library used by workflow engine.
- `task/AGENTS.md` - task execution, claims, context, archiving.
- `workspace/AGENTS.md` - workspace/worktree/shared-state lifecycle.
- `kanban/AGENTS.md` - Kanban adapter layer (GitHub, Jira, internal).
- `server/AGENTS.md` - HTTP API and setup/UI servers.
- `telegram/AGENTS.md` - Telegram/WhatsApp channels and sentinel.
- `shell/AGENTS.md` - executor shells (Codex, Copilot, Claude, OpenCode).
- `github/AGENTS.md` - GitHub App/OAuth auth and webhook paths.
- `ui/AGENTS.md` - Mini App frontend assets.
- `site/AGENTS.md` - marketing/docs website assets.
- `desktop/AGENTS.md` - Electron desktop shell.
- `tests/AGENTS.md` - test routing and coverage map.
- `config/AGENTS.md` - config schema, resolution, repo-root handling.
- `tools/AGENTS.md` - build/test utility scripts and maintenance helpers.
- `scripts/AGENTS.md` - migration and one-off utility scripts.
- `lib/AGENTS.md` - shared lightweight helpers.
- `git/AGENTS.md` - git safety, commit helpers, conflict utilities.
- `voice/AGENTS.md` - voice relay/auth/tooling modules.
- `_docs/AGENTS.md` - long-form source docs for generated docs site.
- `bench/AGENTS.md` - SWE-bench benchmarking tooling.
- `bin/AGENTS.md` - executable wrappers (`git` shim).

## Common Commands
- Install: `npm install`
- Test: `npm test`
- Build: `npm run build`
- Syntax check: `npm run syntax:check`

## High-Signal Files
- `package.json` - scripts/exports used by many modules.
- `vitest.config/config.mjs` - test discovery and environment.
- `.env.example` - supported runtime configuration knobs.

## Agent Learnings

### [pattern] (testing) — 2026-04-03 • ref: `MEM-2`

> **Agent:** workflow:test-node (workflow)
> **Memory Scope:** workspace:workspace-1
> **Confidence:** 0.00
> **Related Paths:** src/auth/login.mjs

Workspace memory: seed auth fixtures before browser login retries.

---

### [pattern] (testing) — 2026-04-03 • ref: `MEM-2`

> **Agent:** workflow:test-node (workflow)
> **Memory Scope:** workspace:workspace-1
> **Confidence:** 0.00
> **Related Paths:** src/auth/login.mjs

Workspace memory: seed auth fixtures before browser login retries.

---

### [pattern] (testing) — 2026-04-03 • ref: `MEM-2`

> **Agent:** workflow:test-node (workflow)
> **Memory Scope:** workspace:workspace-1
> **Confidence:** 0.00
> **Related Paths:** src/auth/login.mjs

Workspace memory: seed auth fixtures before browser login retries.

---
