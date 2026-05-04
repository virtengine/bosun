# Internal Harness Consolidation Matrix

Date: 2026-04-03  
Scope: Step 11 dual-agent consolidation and gap closure for Bosun's internal harness adoption.

## Reconciliation Inputs

This consolidation pass reconciles the repository against:

- [2026-04-02-bosun-internal-agent-harness-adoption-plan.md](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/_docs/2026-04-02-bosun-internal-agent-harness-adoption-plan.md)
- [2026-04-03-bosun-internal-agent-harness-adoption-plan-continued.md](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/_docs/2026-04-03-bosun-internal-agent-harness-adoption-plan-continued.md)
- [INTERNAL_HARNESS_CUTOVER_MATRIX.md](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/_docs/INTERNAL_HARNESS_CUTOVER_MATRIX.md)
- [INTERNAL_HARNESS_ROLLOUT_RUNBOOK.md](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/_docs/INTERNAL_HARNESS_ROLLOUT_RUNBOOK.md)
- [INTERNAL_HARNESS_NATIVE_BOUNDARY.md](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/_docs/INTERNAL_HARNESS_NATIVE_BOUNDARY.md)
- [INTERNAL_HARNESS_RELEASE_SIGNOFF.md](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/_docs/INTERNAL_HARNESS_RELEASE_SIGNOFF.md)

## Runtime Ownership Matrix

| Runtime area | Canonical owner | Transitional file(s) still present | Convergence result | Evidence |
| --- | --- | --- | --- | --- |
| Session lifecycle, lineage, replay, resume | `agent/session-manager.mjs`, `agent/thread-registry.mjs`, `agent/subagent-control.mjs` | `agent/primary-agent.mjs`, `agent/agent-pool.mjs`, `shell/shell-session-compat.mjs` | Converged with residual wrappers | `session-manager.mjs` owns lifecycle APIs and default manager; shell/session wrappers delegate into it. |
| Harness execution and per-turn runtime | `agent/internal-harness-runtime.mjs`, `agent/harness/*`, `agent/agent-launcher.mjs` | `agent/agent-pool.mjs`, `agent/primary-agent.mjs` | Converged | Harness session creation and run APIs are delegated through manager/runtime seams; bounded launcher transport now lives in `agent-launcher.mjs` and `agent-pool.mjs` is only a facade. |
| Provider resolution and normalized provider runtime | `agent/provider-kernel.mjs`, `agent/provider-session.mjs`, `agent/provider-registry.mjs` | `agent/primary-agent.mjs`, `shell/*` | Converged | Canonical provider selection and execution sessions resolve through the provider kernel; `primary-agent` and shell transport catalogs call into it instead of defining parallel provider registries. |
| Tool control plane | `agent/tool-orchestrator.mjs`, `agent/tool-runtime-context.mjs`, `agent/tool-approval-manager.mjs`, `agent/tool-network-policy.mjs` | `shell/shell-session-compat.mjs` | Converged | Tool policy, approvals, retry, network, and truncation rules are centralized in the orchestrator; shell compatibility only adapts transport. |
| Canonical event and projection spine | `agent/agent-event-bus.mjs`, `infra/session-telemetry.mjs`, `infra/live-event-projector.mjs`, `infra/replay-reader.mjs` | `workflow/workflow-engine.mjs`, `shell/shell-session-compat.mjs` | Converged with residual ingestion-side debt | Canonical event normalization and telemetry recording are centralized; some producers still emit directly into the spine but do not define a second schema. |
| Surface APIs for web, TUI, Telegram | `server/routes/harness-*.mjs`, `server/routes/harness-agent-bridge.mjs`, `server/routes/harness-surface-payload.mjs`, `ui/modules/harness-client.js`, `telegram/harness-api-client.mjs`, `telegram/telegram-surface-runtime.mjs`, `telegram/telegram-bot.mjs`, `tui/lib/ws-bridge.mjs` | none for harness ownership | Converged | Surface clients call canonical harness endpoints; `ui-server` is only route composition, `infra/monitor.mjs` owns Telegram/UI-server lifecycle, `telegram-surface-runtime.mjs` is the only allowed Telegram-to-ui-server bridge, and `telegram-bot.mjs` is only a channel adapter that consumes injected UI runtime metadata plus canonical harness APIs. |
| Workflow-linked harness execution | `workflow/harness-session-node.mjs`, `workflow/harness-tool-node.mjs`, `workflow/harness-approval-node.mjs`, `workflow/harness-subagent-node.mjs`, `workflow/delegation-runtime.mjs`, `workflow/workflow-nodes/*.mjs` | none for workflow-linked harness ownership | Converged | `workflow/workflow-nodes.mjs` is now only the public composition shell, the built-in registrars live under `workflow/workflow-nodes/*.mjs`, and shared delegation watchdog/audit/guard state moved into `workflow/delegation-runtime.mjs` so `workflow-engine.mjs` stays a scheduler plus run bookkeeper instead of a second agent runtime. |
| Optional native hot path | `lib/hot-path-runtime.mjs`, `native/bosun-unified-exec/*`, `native/bosun-telemetry/*` | none beyond optional fallbacks | Converged with environment-only validation residual | Native boundary is explicit; Node remains the control plane and JS fallbacks remain authoritative for correctness. `tools/native-rust.mjs` now resolves Rustup-installed cargo correctly, and the only remaining validation blocker is host MSVC linker/SDK availability tracked in `IH-GAP-007`. |

## Transitional Files That Still Exist

| File | Current role | Why it remains transitional |
| --- | --- | --- |
| `agent/primary-agent.mjs` | Legacy-facing primary-session facade | Preserves historical prompt framing and failover entrypoint behavior for chat/session parity, but shell adapter imports and controller binding are delegated out. |
| `agent/agent-pool.mjs` | Compatibility re-export facade | Legacy import path remains for compatibility, but implementation ownership moved into `agent/agent-launcher.mjs` and canonical session/thread modules. |
| `shell/shell-session-compat.mjs` | Narrow shell compatibility bridge | Purposefully translates legacy shell session shapes into canonical manager/kernel/orchestrator/telemetry contracts. |
| `shell/shell-adapter-registry.mjs` | Shell transport catalog | Centralizes shell executor imports and adapter-specific parity helpers for compatibility callers without becoming a second provider/session/tool owner. |

## Convergence Decision

Bosun now has one coherent architecture story:

1. Canonical runtime ownership lives in the harness/session/provider/tool/observability modules, not in surface wrappers.
2. Transitional files can be named explicitly and mapped to canonical owners, and `agent-pool.mjs` is now an auditable facade instead of a hidden launcher owner.
3. The remaining debt is no longer hidden. It is bounded and tracked in [INTERNAL_HARNESS_GAP_REGISTER.md](C:/Users/jON/Documents/source/repos/virtengine-gh/bosun/_docs/INTERNAL_HARNESS_GAP_REGISTER.md), and neither `ui-server.mjs` nor `telegram-bot.mjs` is counted as a hidden harness owner.

## Explicit Non-Owners

The following files are not accepted as hidden long-term owners:

- `agent/primary-agent.mjs` is not the lifecycle source of truth.
- `agent/agent-pool.mjs` is not the canonical orchestration model.
- `workflow/workflow-engine.mjs` is not a second agent runtime.
- `workflow/workflow-nodes.mjs` is only the public composition entrypoint over the modular registrars and is not a second workflow runtime.
- `server/ui-server.mjs` is not the canonical harness business-logic owner; it only composes canonical harness route/support modules.
- `telegram/telegram-bot.mjs` is not the session/provider/thread control plane; it is only the Telegram channel adapter over injected UI-runtime metadata and canonical harness APIs.
- `shell/*` is not a second provider/session/tool architecture.
