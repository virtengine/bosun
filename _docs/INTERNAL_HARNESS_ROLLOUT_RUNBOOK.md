# Internal Harness Rollout Runbook

Date: 2026-04-03
Scope: staged Step 10 cutover of Bosun onto the internal harness as the runtime source of truth.

## Objective

Enable Bosun's internal harness progressively across chat, workflow, TUI, web UI, and Telegram while preserving a fast rollback path. Transitional wrappers may remain, but canonical behavior must come from:

- `agent/session-manager.mjs`
- `agent/internal-harness-runtime.mjs`
- `agent/provider-kernel.mjs`
- `agent/tool-orchestrator.mjs`
- `infra/session-telemetry.mjs`

## Operator Preconditions

1. `BOSUN_HARNESS_ENABLED=true`
2. `BOSUN_HARNESS_VALIDATION_MODE=report` for the first enablement pass
3. `BOSUN_HARNESS_SOURCE` points at the intended harness source/profile when compile-and-run flows are used
4. Provider defaults are set through the canonical provider config, not shell-local flags
5. The UI server is the API source for TUI, web UI, and Telegram harness controls

## Validation Commands

Run in this order:

```powershell
npm run syntax:check
node tools/vitest-runner.mjs run --config vitest.config.mjs tests/harness-runtime.test.mjs tests/harness-surface-integration.test.mjs tests/provider-kernel.test.mjs tests/session-manager.test.mjs tests/tool-orchestrator.test.mjs tests/shell-session-compat.test.mjs
node tools/vitest-runner.mjs run --config vitest.config.mjs tests/ui-server.test.mjs tests/ui-server-tui-events.test.mjs tests/telegram-sentinel.test.mjs
node bench/harness-parity-bench.mjs
node bench/harness-load-bench.mjs
npm test
npm run build
```

## Rollout Stages

### Stage 0: Proof Mode

- Set `BOSUN_HARNESS_ENABLED=true`
- Keep `BOSUN_HARNESS_VALIDATION_MODE=report`
- Run the focused harness proof suite and both harness benchmarks
- Verify all transitional wrappers still delegate to canonical harness modules per `_docs/INTERNAL_HARNESS_CUTOVER_MATRIX.md`

Success criteria:

- Focused harness tests pass
- `bench/harness-parity-bench.mjs` shows successful runs for chat, workflow, TUI, web UI, and Telegram
- `bench/harness-load-bench.mjs` completes without failed sessions

Stop criteria:

- Any surface requires shell-local or workflow-local semantics to succeed
- Provider selection or approvals differ by surface
- Load benchmark reports failed sessions or stalled telemetry flushes

### Stage 1: Interactive Surfaces

- Enable chat plus web UI/TUI monitoring against the canonical harness APIs
- Confirm `/api/harness/surface`, `/api/harness/runs`, `/api/harness/approvals`, and websocket session snapshots are healthy
- Confirm shell adapters only contribute transport compatibility

Success criteria:

- Chat, web UI, and TUI show the same active session and run identifiers
- Approval and session updates appear in the same event/projection spine

Rollback:

- Disable `BOSUN_HARNESS_ENABLED`
- Revert to wrapper-only monitoring while preserving state ledgers and harness run artifacts for analysis

### Stage 2: Workflow-Linked Execution

- Enable workflow-triggered harness sessions and harness-backed workflow nodes
- Verify workflow-created sessions appear in the same lineage graph and replay/event endpoints as interactive sessions

Success criteria:

- Workflow-linked sessions share canonical `sessionId`, `rootSessionId`, `parentSessionId`, and approval identifiers
- Workflow outputs resolve through `workflow/harness-output-contract.mjs`

Stop criteria:

- Workflow execution requires private approval logic
- Workflow-linked runs stop appearing in the canonical harness telemetry or replay endpoints

### Stage 3: Telegram Cutover

- Enable Telegram controls against the UI server harness routes via `telegram/harness-api-client.mjs`
- Validate provider selection, thread inspection, run summaries, and approval actions through canonical APIs

Success criteria:

- Telegram can inspect and steer harness-backed state without shell-local provider catalogs
- Telegram approval actions resolve the same pending requests visible in web UI/TUI

Rollback:

- Keep Telegram command surface enabled but disable harness-originated actions until route parity is restored

## Metrics To Watch

- Active harness run count and terminal state mix
- Approval request backlog and approval resolution latency
- Provider usage totals and default-provider consistency
- Telemetry projection freshness after flush
- Aborted/failed session counts during concurrent load

## Failure Handling

If any stop criterion is met:

1. Stop progressive rollout at the current stage.
2. Preserve benchmark output and focused test output.
3. Keep compatibility wrappers in place, but do not treat them as proof of cutover readiness.
4. Open a bounded follow-up against the owning canonical module, not the surface wrapper.

## Go/No-Go Gate

Go only if all of the following are true:

- Focused proof suites pass
- `npm test` passes
- `npm run build` passes
- Parity bench succeeds for chat, workflow, TUI, web UI, and Telegram
- Load bench succeeds without failed sessions
- No wrapper in the cutover matrix still owns divergent runtime semantics

No-go if any surface still diverges, even if wrappers continue to function.
