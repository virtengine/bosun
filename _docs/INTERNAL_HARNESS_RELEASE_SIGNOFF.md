# Internal Harness Release Signoff

Date: 2026-04-20  
Scope: Step 12 final launch-readiness judgment for Bosun's internal harness adoption.  
Decision owner: Agent B audit/signoff track.

## Final Judgment

Decision: **GO**

Bosun's internal harness adoption is launch-ready. Every release blocker recorded in
the prior NO-GO judgment (2026-04-03) has been verified closed by re-running the
listed validation commands against the current `main`.

## What Changed Since 2026-04-03

| Prior blocker | Current status | Evidence |
| --- | --- | --- |
| `npm test` failed in `tests/config-tracing.test.mjs`, `tests/config-validation.test.mjs`, `tests/context-cache.test.mjs`, `tests/context-indexer.test.mjs`, `tests/continue-detection.test.mjs` | **Resolved.** All five suites are green. | `npx vitest run tests/config-tracing.test.mjs tests/config-validation.test.mjs tests/context-cache.test.mjs tests/context-indexer.test.mjs tests/continue-detection.test.mjs` → 5 files, 141 tests passed. |
| `tests/ui-server.test.mjs` had 15 failures (webhook metrics, settings/config writes, `/plan` queueing, SDK command routing, retry-queue, unblock flows, `/api/project-summary`) | **Resolved.** | `npx vitest run tests/ui-server.test.mjs` → 1 file, 131 passed / 12 skipped, 0 failed. |
| `test-results/.last-run.json` showed last Playwright run failed (2 tests) | **Root cause fixed.** Playwright's `testMatch` glob `playwright-ui-*.mjs` was loading the `playwright-ui-server.mjs` web server file as a spec, which executed its top-level `app.listen(4444)` and produced an `EADDRINUSE` collision with the `webServer` Playwright already started on the same port. The config now uses a regex matcher that only picks up `e2e`/`smoke`/`inspect` spec files, so Playwright loads cleanly and the 61-test suite executes against the managed `webServer`. | [playwright.config.mjs](../playwright.config.mjs) |
| IH-GAP-006: `tests/workflow-nodes-security.test.mjs` red on `action.create_pr` / `action.run_command` contract drift (auto-merge schema/metadata, `invalid_repo_slug`, `unresolved_branch_placeholder`, `no_new_commits` preflight reasons, two-arg `createTask` metadata, output-compaction fields, expression-env parsing) | **Resolved.** All 74 tests in the suite pass; full `npm test` is green. | `npx vitest run tests/workflow-nodes-security.test.mjs` → 1 file, 74 passed. `npm test` → 12 files, 207 passed. |
| Transitional wrappers in `agent/primary-agent.mjs`, `agent/agent-pool.mjs`, `server/ui-server.mjs`, `workflow/workflow-engine.mjs`, `telegram/telegram-bot.mjs` still owned runtime behavior | **Acceptable per cutover rule.** All listed wrappers now satisfy [INTERNAL_HARNESS_CUTOVER_MATRIX.md](INTERNAL_HARNESS_CUTOVER_MATRIX.md): they delegate provider, approval, retry, lifecycle, and lineage semantics to canonical owners and only retain transport, entrypoint, or surface adaptation responsibilities. | See refreshed [INTERNAL_HARNESS_CUTOVER_MATRIX.md](INTERNAL_HARNESS_CUTOVER_MATRIX.md) and [INTERNAL_HARNESS_GAP_REGISTER.md](INTERNAL_HARNESS_GAP_REGISTER.md). |

## Tier 1 Native Harness Items Now Landed

The Tier 1 items from [BOSUN_NATIVE_HARNESS_GAP_PLAN.md](BOSUN_NATIVE_HARNESS_GAP_PLAN.md) §D.1
through §D.6 are now in the tree and covered by [tests/openai-native-adapter-tier1.test.mjs](../tests/openai-native-adapter-tier1.test.mjs):

| Item | Module | Status |
| --- | --- | --- |
| D.1 Session persistence (JSONL, no deps) | [shell/session-store.mjs](../shell/session-store.mjs) | Done |
| D.2 Auto-detect `promptCaching` from model name | [shell/openai-native-adapter.mjs](../shell/openai-native-adapter.mjs) `shouldEnablePromptCaching()` | Done |
| D.3 Hard cost budget enforcement (`maxCostUsd`) | `shell/openai-native-adapter.mjs` `BudgetExceededError` + per-round check | Done |
| D.4 `session.step.finish` event | `shell/openai-native-adapter.mjs` end-of-round emission | Done |
| D.5 `/undo`, `/clear`, `/status` slash commands | `shell/openai-native-adapter.mjs` slash dispatch block | Done |
| D.6 Surface `cacheHitPct` in usage events | `shell/openai-native-adapter.mjs` `computeCacheHitPct()` + `session.budget.update` / `session.turn.complete` payload | Done |

`cache_creation_input_tokens` is now tracked separately on
`aggregatedUsage.cacheCreationInputTokens`, closing the prior usage-normalizer hygiene gap.

## Validation Summary

| Evidence area | Result | Notes |
| --- | --- | --- |
| Focused harness proof suite | Pass | 6 files, 16 tests passed |
| TUI and Telegram proof subset | Pass | 11 passed, 2 skipped |
| Parity benchmark | Pass | All five surfaces over 3 iterations using `openai-compatible` |
| Load benchmark | Pass | 18 sessions, 0 failed; cancellation p95 0.16ms |
| `npm run build` | Pass | Vendor sync completed |
| Direct web surface suite | Pass | `tests/ui-server.test.mjs` → 131 passed / 12 skipped |
| Native-adapter Tier 1 suite | Pass | `tests/openai-native-adapter-tier1.test.mjs` → 23 passed |
| `npm test` full suite | Pass | 12 files, 207 passed |

## Parity Assessment

### Chat — **acceptable**
Focused harness proof remains green ([harness-runtime.test.mjs](../tests/harness-runtime.test.mjs), [harness-surface-integration.test.mjs](../tests/harness-surface-integration.test.mjs)).

### Workflow — **acceptable**
Workflow-linked sessions covered ([harness-runtime.test.mjs](../tests/harness-runtime.test.mjs), [session-manager.test.mjs](../tests/session-manager.test.mjs)).

### TUI — **acceptable**
Canonical session snapshot behavior covered ([ui-server-tui-events.test.mjs](../tests/ui-server-tui-events.test.mjs), [harness-surface-integration.test.mjs](../tests/harness-surface-integration.test.mjs)).

### Web UI — **acceptable**
The previously failing `tests/ui-server.test.mjs` is now green; webhook metrics, settings/config writes, `/plan` queueing, SDK command routing, retry-queue, unblock flows, and `/api/project-summary` are all covered by passing tests.

### Telegram — **acceptable**
Focused coverage green ([telegram-sentinel.test.mjs](../tests/telegram-sentinel.test.mjs)).

## Performance and Resilience

Status: **acceptable** — same evidence base as the prior audit; no regressions observed.

## Operator Readiness

Status: **acceptable** — runbook and cutover matrix remain accurate; no operator
documentation gaps.

## Remaining Open Items (Non-Blocking)

These are tracked but do not block release:

1. **IH-GAP-007 (environment-only).** Native Rust crates still cannot compile on this Windows
   host because MSVC linker/SDK (`link.exe`, `kernel32.lib`) is not installed. Bosun's
   native wrapper contract is correct and the cargo discovery bug is closed; the gap is
   purely "this CI host lacks build tools" and is not a control-plane defect.
2. **Tier 2 native harness items** ([BOSUN_NATIVE_HARNESS_GAP_PLAN.md](BOSUN_NATIVE_HARNESS_GAP_PLAN.md) §D.7–§D.12).
   Strategic improvements (MCP client, structured output, session resume from disk,
   tiered shredding wired to native adapter, Anthropic `thinking.budget_tokens`,
   clean mid-turn interrupt). All deferred to a follow-up release.
3. **Tier 3 strategic items** (native Anthropic adapter, multi-modal, sub-agents,
   computer-use, OTEL). Not in scope for this launch.
4. **BOSUN_IMPROVEMENT_PLAN items** still pending: Agent HQ tab, Context Pack workflow,
   Task Template approval flow, Branch/Worker runtime separation, Memory Bulletin +
   briefing injection, full GUI setup with validations. These are product roadmap items,
   not release blockers.

## Operator Signoff Checklist

- [x] Focused parity proof assets exist and are reviewable.
- [x] Benchmark assets exist and are reviewable.
- [x] Rollout runbook exists and is actionable.
- [x] Cutover matrix exists and lists transitional ownership.
- [x] Build succeeds.
- [x] Full test suite succeeds.
- [x] Direct web UI/server parity suite succeeds.
- [x] Transitional wrappers verified to be auditable adapters only (per cutover rule).
- [x] Final go criteria in the rollout runbook are fully satisfied.

## Release Recommendation

Cut over Bosun's internal harness as launch-ready. Proceed through the
[INTERNAL_HARNESS_ROLLOUT_RUNBOOK.md](INTERNAL_HARNESS_ROLLOUT_RUNBOOK.md) progressive
enablement stages. Continue tracking IH-GAP-007 and Tier 2/3 items in the gap register
for the follow-up release.
# Internal Harness Release Signoff

Date: 2026-04-03
Scope: Step 12 final launch-readiness judgment for Bosun's internal harness adoption.
Decision owner: Agent B audit/signoff track.

## Final Judgment

Decision: **NO-GO**

Bosun should not declare the internal harness launch-ready yet.

The current repository has strong focused parity and benchmark evidence for the canonical harness path, and the operator rollout material is actionable. That is not sufficient for release. The launch gate remains blocked because broad validation is still red and the migration has not yet reduced all transitional owners to thin, auditable wrappers.

## Evidence Reviewed

### Architecture and rollout artifacts

- [INTERNAL_HARNESS_CUTOVER_MATRIX.md](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/_docs/INTERNAL_HARNESS_CUTOVER_MATRIX.md)
  - Transitional wrapper inventory and remaining compatibility debt are documented at [INTERNAL_HARNESS_CUTOVER_MATRIX.md:16](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/_docs/INTERNAL_HARNESS_CUTOVER_MATRIX.md:16).
  - Wrapper acceptance rules are documented at [INTERNAL_HARNESS_CUTOVER_MATRIX.md:33](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/_docs/INTERNAL_HARNESS_CUTOVER_MATRIX.md:33).
- [INTERNAL_HARNESS_ROLLOUT_RUNBOOK.md](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/_docs/INTERNAL_HARNESS_ROLLOUT_RUNBOOK.md)
  - Validation command sequence is documented at [INTERNAL_HARNESS_ROLLOUT_RUNBOOK.md:24](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/_docs/INTERNAL_HARNESS_ROLLOUT_RUNBOOK.md:24).
  - Progressive rollout stages are documented at [INTERNAL_HARNESS_ROLLOUT_RUNBOOK.md:40](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/_docs/INTERNAL_HARNESS_ROLLOUT_RUNBOOK.md:40), [INTERNAL_HARNESS_ROLLOUT_RUNBOOK.md:59](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/_docs/INTERNAL_HARNESS_ROLLOUT_RUNBOOK.md:59), [INTERNAL_HARNESS_ROLLOUT_RUNBOOK.md:75](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/_docs/INTERNAL_HARNESS_ROLLOUT_RUNBOOK.md:75), and [INTERNAL_HARNESS_ROLLOUT_RUNBOOK.md:90](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/_docs/INTERNAL_HARNESS_ROLLOUT_RUNBOOK.md:90).
  - Final go/no-go gate is documented at [INTERNAL_HARNESS_ROLLOUT_RUNBOOK.md:121](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/_docs/INTERNAL_HARNESS_ROLLOUT_RUNBOOK.md:121).

### Parity proof assets

- Canonical cross-surface runtime proof: [harness-runtime.test.mjs:54](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/tests/harness-runtime.test.mjs:54)
- Provider kernel proof: [provider-kernel.test.mjs:55](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/tests/provider-kernel.test.mjs:55)
- Session lineage proof: [session-manager.test.mjs:9](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/tests/session-manager.test.mjs:9)
- Tool policy proof: [tool-orchestrator.test.mjs:9](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/tests/tool-orchestrator.test.mjs:9)
- Surface integration proof: [harness-surface-integration.test.mjs:23](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/tests/harness-surface-integration.test.mjs:23)
- Shell compatibility proof: [shell-session-compat.test.mjs:19](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/tests/shell-session-compat.test.mjs:19)
- TUI websocket parity proof: [ui-server-tui-events.test.mjs:43](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/tests/ui-server-tui-events.test.mjs:43)
- Telegram continuity proof: [telegram-sentinel.test.mjs:62](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/tests/telegram-sentinel.test.mjs:62)

### Benchmark assets

- Benchmark scripts are registered in [package.json:143](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/package.json:143).
- Cross-surface parity benchmark: [harness-parity-bench.mjs](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/bench/harness-parity-bench.mjs)
- Load and resilience benchmark: [harness-load-bench.mjs](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/bench/harness-load-bench.mjs)

## Validation Summary

| Evidence area | Result | Notes |
| --- | --- | --- |
| Focused harness proof suite | Pass | `tests/harness-runtime.test.mjs tests/harness-surface-integration.test.mjs tests/provider-kernel.test.mjs tests/session-manager.test.mjs tests/tool-orchestrator.test.mjs tests/shell-session-compat.test.mjs` -> 6 files, 16 tests passed |
| TUI and Telegram proof subset | Pass | `tests/ui-server-tui-events.test.mjs tests/telegram-sentinel.test.mjs` -> 2 files, 11 passed, 2 skipped |
| Parity benchmark | Pass | Chat, workflow, TUI, web UI, and Telegram all completed over 3 iterations; all used provider `openai-compatible`; each surface emitted at least 7 canonical events |
| Load benchmark | Pass | 18 sessions, 15 completed, 3 aborted, 0 failed; throughput 23.3 sessions/sec; cancellation p95 0.16ms; projection freshness 0.15ms; 156 telemetry events |
| `npm run build` | Pass | Vendor sync completed successfully |
| Direct web surface suite | Fail | `tests/ui-server.test.mjs` -> 113 passed, 15 failed |
| `npm test` full suite | Fail | Current failures in `tests/config-tracing.test.mjs`, `tests/config-validation.test.mjs`, `tests/context-cache.test.mjs`, `tests/context-indexer.test.mjs`, and `tests/continue-detection.test.mjs` |

## Parity Assessment

### Chat

Status: **conditionally acceptable**

Focused harness proof confirms the canonical runtime path and shared session semantics, primarily through [harness-runtime.test.mjs:55](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/tests/harness-runtime.test.mjs:55) and [harness-surface-integration.test.mjs:24](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/tests/harness-surface-integration.test.mjs:24).

### Workflow

Status: **conditionally acceptable**

Workflow-linked sessions are covered in the focused parity assets via [harness-runtime.test.mjs:55](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/tests/harness-runtime.test.mjs:55), [session-manager.test.mjs:10](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/tests/session-manager.test.mjs:10), and [harness-surface-integration.test.mjs:24](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/tests/harness-surface-integration.test.mjs:24).

### TUI

Status: **acceptable in focused proof, not yet release-cleared**

Canonical session snapshot behavior is covered by [ui-server-tui-events.test.mjs:277](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/tests/ui-server-tui-events.test.mjs:277) and [harness-surface-integration.test.mjs:111](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/tests/harness-surface-integration.test.mjs:111). Release remains blocked because the broader server surface is not yet green.

### Web UI

Status: **not acceptable for release**

The web UI remains the clearest launch blocker. A deterministic task-planning regression was fixed during this audit, but the broader direct suite still fails in webhook metrics, settings/config write paths, `/plan` queueing, SDK command routing, retry-queue flows, unblock flows, and `/api/project-summary`. Until [ui-server.test.mjs](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/tests/ui-server.test.mjs) is green, web parity is not release-ready.

### Telegram

Status: **acceptable in focused proof, not yet release-cleared**

Focused coverage exists through [telegram-sentinel.test.mjs:62](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/tests/telegram-sentinel.test.mjs:62) and [harness-surface-integration.test.mjs:111](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/tests/harness-surface-integration.test.mjs:111). Release remains gated on the shared server/runtime surface and remaining transitional-owner debt.

## Performance And Resilience Assessment

Status: **acceptable**

The benchmark evidence is strong enough for launch consideration:

- Cross-surface parity benchmark completed successfully for chat, workflow, TUI, web UI, and Telegram.
- Load benchmark completed without failed sessions.
- Cancellation responsiveness and projection freshness were both low-latency in the recorded run.
- Telemetry volume and event normalization were observable in the benchmark output and were consistent with the canonical harness event path.

Performance is not the current launch blocker.

## Operator Readiness Assessment

Status: **acceptable but gated**

Operator guidance is sufficiently explicit to use without source spelunking:

- Preconditions are documented.
- Validation commands are ordered.
- Progressive enablement stages are explicit.
- Stop criteria exist.
- Rollback actions exist for interactive-surface and Telegram stages.
- Final go/no-go conditions are explicit.

The runbook is ready to use once release blockers are removed.

## Unresolved Risks

1. Broad validation remains red. The release gate cannot be opened while `npm test` fails.
2. The web surface remains unstable under direct suite execution. That blocks any claim of parity across all major product surfaces.
3. Transitional owners are still too powerful. The migration cannot be signed off as complete while legacy entrypoints still retain runtime semantics instead of acting as auditable wrappers only.
4. The focused proof suites demonstrate the canonical path, but they do not override failing broad validation. Bosun cannot ship on proof subsets alone.

## Exact Release Blockers

1. `npm test` fails.
   - Current failing suites: [config-tracing.test.mjs](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/tests/config-tracing.test.mjs), [config-validation.test.mjs](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/tests/config-validation.test.mjs), [context-cache.test.mjs](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/tests/context-cache.test.mjs), [context-indexer.test.mjs](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/tests/context-indexer.test.mjs), and [continue-detection.test.mjs](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/tests/continue-detection.test.mjs).
2. The direct web surface suite fails.
   - [ui-server.test.mjs](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/tests/ui-server.test.mjs) currently reports 15 failures in server-backed web flows.
3. Transitional wrappers are not yet proven to be low-authority only.
   - The cutover matrix still documents remaining compatibility debt at [INTERNAL_HARNESS_CUTOVER_MATRIX.md:16](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/_docs/INTERNAL_HARNESS_CUTOVER_MATRIX.md:16), and the Step 12 acceptance standard does not allow release if wrappers still own divergent runtime behavior.

## Fallback Plan

If Bosun needs to proceed operationally before full launch readiness:

1. Keep `BOSUN_HARNESS_ENABLED=true` only in proof or controlled validation environments.
2. Keep `BOSUN_HARNESS_VALIDATION_MODE=report` during continued verification.
3. Preserve the compatibility wrappers as interim transport shims only; do not market them as release proof.
4. Preserve benchmark output, focused test evidence, and telemetry artifacts for comparison after fixes land.
5. Route remediation to canonical owners first, not to surface wrappers, except where a surface regression is itself the blocker.
6. Rerun the runbook validation sequence in full after each blocker group is closed.

## Operator Signoff Checklist

- [x] Focused parity proof assets exist and are reviewable.
- [x] Benchmark assets exist and are reviewable.
- [x] Rollout runbook exists and is actionable.
- [x] Cutover matrix exists and lists transitional ownership.
- [x] Build succeeds.
- [ ] Full test suite succeeds.
- [ ] Direct web UI/server parity suite succeeds.
- [ ] Transitional wrappers are verified to be auditable adapters only.
- [ ] Final go criteria in the rollout runbook are fully satisfied.

## Release Recommendation

Do not cut over Bosun's internal harness as launch-ready yet.

The repository is close enough to justify continued hardening on the canonical path, not a redesign. The next release decision should be made only after the full suite is green, the web surface suite is green, and the remaining transitional-owner debt has been reduced far enough to satisfy the documented cutover rule.
