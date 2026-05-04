# Test Suite Guide

## Scope

Vitest and node test coverage for runtime, workflows, integrations, and UI.

## Start Points

- Config: `vitest.config/config.mjs`
- Shared-state docs: `tests/SHARED_STATE_TESTS.md`
- Fixtures/sandbox: `tests/fixtures/`, `tests/sandbox/`

## Naming Heuristics

- `*.test.mjs` - standard vitest suites.
- `*.node.test.mjs` - node-specific/runtime behavior checks.
- Feature-prefixed files usually map directly to module names.

## Fast Routing

- Workflow changes -> `tests/workflow-*.test.mjs`
- Task/kanban changes -> `tests/*task*.test.mjs`
- Workspace/shared-state changes -> `tests/workspace-*.test.mjs`, `tests/shared-state*.test.mjs`
- UI/server changes -> `tests/*ui*.test.mjs`, `tests/*setup*.test.mjs`

## Validation Order

1. Run focused tests for changed module.
2. Run full suite: `npm test`.
3. Run build: `npm run build`.

## Pre-push Adjacency Map

The pre-push hook (`.githooks/pre-push`) contains a module adjacency map that
controls which tests run when a source directory changes. When adding a new
test file or a new module, update the `ADJACENCY_MAP` array in the hook so the
pre-push hook picks it up without falling back to the full suite.

## Anti-Flake Conventions

### Timeouts

Use `testTimeout()` from `tests/timeout-helper.mjs` instead of per-file
`process.platform === 'win32' ? X : Y` patterns. Specify the **Linux baseline**
and the helper applies a platform multiplier automatically (3x on Windows by
default, overridable via `BOSUN_TEST_TIMEOUT_MULTIPLIER`).

```js
import { testTimeout } from "./timeout-helper.mjs";
vi.setConfig({ testTimeout: testTimeout(15_000) });
const SLOW_MY_TEST_TIMEOUT_MS = testTimeout(30_000);
```

### Retry

The vitest config enables `retry: 1` globally. This absorbs a single transient
OS-level hiccup (antivirus scan, disk flush, scheduling variance) without
hiding persistent regressions.

### Near-Timeout Reporter

A custom reporter (`tests/near-timeout-reporter.mjs`) warns at end-of-run
when any passing test consumed >75% of its timeout budget. Fix these **before**
they become flaky. Threshold is configurable via `BOSUN_TEST_TIMEOUT_WARN_PCT`.
