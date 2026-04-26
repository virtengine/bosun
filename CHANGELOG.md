# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog,
and this project adheres to Semantic Versioning.

## [Unreleased]

### Internal Harness Adoption — Release Sign-off Flipped to GO (2026-04-20)

- Re-audited [_docs/INTERNAL_HARNESS_RELEASE_SIGNOFF.md](_docs/INTERNAL_HARNESS_RELEASE_SIGNOFF.md):
  every blocker from the prior 2026-04-03 NO-GO judgment is closed.
- IH-GAP-006 (workflow-nodes-security drift) closed; the suite is green at
  74 passed and `npm test` reports 12 files / 207 passed.
- IH-GAP-007 reduced to environment-only (Windows MSVC linker absent); the
  control-plane contract is intact.

### Native Harness — Tier 1 (`shell/openai-native-adapter.mjs`)

- **Added** [shell/session-store.mjs](shell/session-store.mjs): crash-safe
  append-only JSONL session store with `replayEvents()` reconstruction
  (no external dependency).
- **Added** `shouldEnablePromptCaching()` auto-detect for Anthropic-routed
  models (`claude-*`, `anthropic/*`, `*/claude-*`, `provider=anthropic`).
- **Added** hard cost budget enforcement: `execOptions.maxCostUsd` /
  `providerConfig.maxCostUsd` with `BudgetExceededError` and a
  `session.budget.exceeded` event.
- **Added** `session.step.finish` event after every tool-call round
  (mirrors AI SDK `onStepFinish`).
- **Added** `/undo`, `/clear`, `/status` slash commands (no API call;
  emit `session.undo` / `session.cleared` / `session.status`).
- **Added** `cacheHitPct` and `cumulativeCostUsd` fields on
  `session.budget.update` and `session.turn.complete`.
- **Added** separate `aggregatedUsage.cacheCreationInputTokens` tracking
  (Anthropic bills cache creation separately from cached reads).
- **Added** [tests/openai-native-adapter-tier1.test.mjs](tests/openai-native-adapter-tier1.test.mjs)
  covering the above (23 tests passing).

### Test Tooling

- **Fixed** Playwright `EADDRINUSE :::4444` regression: `playwright.config.mjs`
  now uses a regex `testMatch` of `/playwright-ui-(e2e|smoke|inspect)\.mjs$/`
  so the bundled `playwright-ui-server.mjs` web server file is no longer
  loaded by the test runner.

### Documentation

- Refreshed [_docs/INTERNAL_HARNESS_RELEASE_SIGNOFF.md](_docs/INTERNAL_HARNESS_RELEASE_SIGNOFF.md),
  [_docs/INTERNAL_HARNESS_GAP_REGISTER.md](_docs/INTERNAL_HARNESS_GAP_REGISTER.md),
  [_docs/INTERNAL_HARNESS_CUTOVER_MATRIX.md](_docs/INTERNAL_HARNESS_CUTOVER_MATRIX.md),
  and [_docs/BOSUN_NATIVE_HARNESS_GAP_PLAN.md](_docs/BOSUN_NATIVE_HARNESS_GAP_PLAN.md)
  to reflect closed gaps and Tier 1 native-harness completion.
- Filled out [RELEASE_DRAFT.md](RELEASE_DRAFT.md) (was an unrendered
  `{{releaseNotes}}` template placeholder).

## [0.40.6] - 2026-03-08

### Features
- Added task status persistence, runtime snapshots, richer execution metadata, and runtime management improvements for task handling.
- Added epic dependency management across the task store, API, CLI update flow, and UI.
- Added sprint execution and task ordering modes, sprint management endpoints, and enhanced task DAG retrieval.
- Added Jira-style task detail improvements, richer metadata fields, and expanded subtask management flows.
- Added cooperative workflow cancellation, stricter workflow start guards, and broader workflow task filtering behavior.
- Added support for serving shared `/lib` modules from the UI server and improved chat/manual draft handling with a JSON-RPC compatibility shim.
- Added failover and recovery improvements for primary and adapter agent sessions.
- Added Kanban board enhancements, including improved column loading behavior and broader task management updates.

### Fixes
- Fixed monitor workflow scheduling by hoisting the poll helper scope and ensuring automation polls start during monitor startup.
- Fixed workflow profile selection, schedule polling on startup, task trigger polling, and downstream gating when trigger conditions evaluate false.
- Fixed workflow task dispatch initialization by binding task claims and dispatch context earlier in the automation flow.
- Fixed worktree acquisition and PR creation edge cases by falling back unresolved base branches and always passing `--body` to `gh pr create`.
- Fixed workspace and runtime path resolution by correcting config-dir, repo-root, and AppData workspace command precedence.
- Fixed Git environment leakage in workspace sync and hook-safe commit detection paths, and repaired Git config corruption in the pre-push hook and worktree manager.
- Fixed empty external task issue creation in the Kanban integration.
- Fixed task detail string replacement behavior and related modal data handling regressions.

### Refactors
- Removed unused workflow task trace hook initialization.
- Removed unused demo API routes.
- Refactored tool discovery and execution flow to simplify agent tooling behavior.

### Docs
- Added monitor recovery, health check, and incident log updates for Bosun environment stability work.
- Added documentation encouraging users to star the project and included a star history chart.

### Tests
- Added regression coverage for Kanban scroll behavior and legacy task handling.
- Added workflow tests for Git environment sanitization and stabilized `create_pr` base-branch checks.
- Added Playwright smoke coverage for the portal UI.
- Expanded CLI daemon PID tracking and task store DAG test coverage.

### Chores
- Updated package versions through the `0.40.x` release line.
- Bumped the `npm_and_yarn` dependency group across both package directories.
