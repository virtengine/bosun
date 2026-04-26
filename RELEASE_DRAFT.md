# Bosun Release Draft

Date: 2026-04-20  
Source: [_docs/INTERNAL_HARNESS_RELEASE_SIGNOFF.md](_docs/INTERNAL_HARNESS_RELEASE_SIGNOFF.md) (decision = **GO**).

## Highlights

- **Internal harness adoption is launch-ready.** All five validation suites listed
  as blockers in the prior NO-GO judgment (`config-tracing`, `config-validation`,
  `context-cache`, `context-indexer`, `continue-detection`) are green, and
  `tests/ui-server.test.mjs` (web surface) is green at 131 passed / 12 skipped.
- **Workflow node security drift (IH-GAP-006) closed.**
  `tests/workflow-nodes-security.test.mjs` is green at 74 passed; the
  `action.create_pr` / `action.run_command` contract is fully covered for
  auto-merge metadata, preflight block reasons (`invalid_repo_slug`,
  `unresolved_branch_placeholder`, `no_new_commits`), two-arg `createTask`
  metadata, output compaction, and expression-env parsing.
- **Playwright e2e harness restored.** `playwright.config.mjs` no longer loads
  `playwright-ui-server.mjs` as a spec; the regex testMatch eliminates the
  `EADDRINUSE :::4444` collision that produced the prior `.last-run.json` failure.
- **Tier 1 native harness items landed** ([_docs/BOSUN_NATIVE_HARNESS_GAP_PLAN.md](_docs/BOSUN_NATIVE_HARNESS_GAP_PLAN.md) §D.1–§D.6).

## What's New

### Native Harness — Tier 1 (`shell/openai-native-adapter.mjs`)

- **Crash-safe session persistence** ([shell/session-store.mjs](shell/session-store.mjs)).
  Append-only JSONL store at `~/.bosun/native-sessions/<id>.jsonl` (override with
  `rootDir` option); replays into a complete in-memory session via `replayEvents()`.
  No external dependency.
- **`promptCaching` auto-detect** via `shouldEnablePromptCaching()`. Anthropic-routed
  models (`claude-*`, `anthropic/*`, `*/claude-*`, `provider=anthropic`) automatically
  enable Anthropic-style `cache_control` injection. Explicit caller flag still wins.
- **Hard cost budget enforcement.** Set `execOptions.maxCostUsd` (or
  `providerConfig.maxCostUsd`); exceeding it now emits a `session.budget.exceeded`
  event and throws `BudgetExceededError` with `{ sessionId, costUsd, limitUsd }`.
- **`session.step.finish` event** mirrors the AI SDK `onStepFinish` callback —
  fires after each tool-call round with `text`, `toolCalls`, `toolResults`,
  `stopReason`, `usage`, and `isContinued`.
- **`/undo`, `/clear`, `/status` slash commands.** Run without an API call;
  emit `session.undo` / `session.cleared` / `session.status` events.
- **Cache hit ratio surfaced.** New `cacheHitPct` field on `session.budget.update`
  and `session.turn.complete`. `cache_creation_input_tokens` is now tracked
  separately on `aggregatedUsage.cacheCreationInputTokens` (Anthropic bills it
  differently from cached reads).
- **`session.budget.update` event** fires every round with `cumulativeCostUsd`,
  `maxCostUsd`, `cacheHitPct`, and a snapshot of `aggregatedUsage` for live
  cost/cache dashboards.

### Test Tooling

- Playwright `testMatch` switched from `playwright-ui-*.mjs` to
  `/playwright-ui-(e2e|smoke|inspect)\.mjs$/` so the bundled web server file
  is no longer loaded as a spec. Eliminates the `EADDRINUSE :::4444`
  failure recorded in `test-results/.last-run.json`.

## Tests

- `npm test` → 12 files, 207 passed.
- `npx vitest run tests/openai-native-adapter-tier1.test.mjs` → 1 file, 23 passed.
- `npx vitest run tests/workflow-nodes-security.test.mjs` → 1 file, 74 passed.
- `npx vitest run tests/ui-server.test.mjs` → 1 file, 131 passed / 12 skipped.

## Known Limitations / Non-Blocking Follow-ups

- **IH-GAP-007 environment gap.** Native Rust crates can't compile here because
  Windows MSVC linker/SDK (`link.exe`/`kernel32.lib`) is not installed.
  `npm run native:check|test|build` still blocked on this host. Bosun's native
  wrapper contract is correct.
- **Tier 2 native items deferred** (MCP client, structured output, session resume
  from disk wired into `ensureSession()`, tiered shredding wired to the native
  adapter, Anthropic `thinking.budget_tokens`, clean mid-turn interrupt).
- **Tier 3 strategic items deferred** (native Anthropic Messages API adapter,
  multi-modal/image inputs, sub-agent spawning, computer-use, OTEL).
- **Improvement plan items still pending:** Agent HQ tab, Context Pack workflow,
  Task Template approval flow, Branch/Worker runtime separation, Memory Bulletin
  + briefing injection, full GUI setup with validations.

## Upgrade Notes

- New optional `execOptions.maxCostUsd` (or `providerConfig.maxCostUsd`) on the
  native OpenAI adapter. When set, expect `session.budget.exceeded` +
  `BudgetExceededError` instead of unbounded spend on runaway sessions.
- New `cacheHitPct` and `cumulativeCostUsd` fields on `session.budget.update`
  and `session.turn.complete`. Existing consumers ignoring unknown fields are
  unaffected.
- `session.step.finish` is a new event; consumers wiring custom telemetry should
  add it to their event allowlists if they currently filter strictly.
- `shell/session-store.mjs` is a new module; nothing in the existing adapter
  imports it yet (Tier 2 D.9 wires `ensureSession()` into it).

See [CHANGELOG.md](CHANGELOG.md) for the full changelog and
[_docs/INTERNAL_HARNESS_RELEASE_SIGNOFF.md](_docs/INTERNAL_HARNESS_RELEASE_SIGNOFF.md)
for the audit record behind this release.
