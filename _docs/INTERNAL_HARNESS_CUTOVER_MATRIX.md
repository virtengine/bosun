# Internal Harness Cutover Matrix

Date: 2026-04-20
Scope: Step 10 cutover proof for Bosun's internal harness adoption.

All listed wrappers have been re-audited as of 2026-04-20 and judged compliant
with the cutover rule below — they delegate provider, approval, retry,
lifecycle, and lineage semantics to canonical owners. The 2026-04-03
release signoff blocker on "transitional wrappers still own divergent runtime
behavior" is therefore closed (see [INTERNAL_HARNESS_RELEASE_SIGNOFF.md](INTERNAL_HARNESS_RELEASE_SIGNOFF.md)).

## Canonical Runtime Owners

- Session lifecycle, lineage, replay, and subagents: `agent/session-manager.mjs`, `agent/thread-registry.mjs`, `agent/subagent-control.mjs`
- Harness execution and turn orchestration: `agent/internal-harness-runtime.mjs`, `agent/harness/*`
- Provider resolution and normalized model/runtime contracts: `agent/provider-kernel.mjs`, `agent/provider-registry.mjs`, `agent/provider-session.mjs`
- Tool execution, approvals, retry, network, sandbox, and truncation policy: `agent/tool-orchestrator.mjs`, `agent/tool-runtime-context.mjs`
- Canonical event and projection spine: `agent/agent-event-bus.mjs`, `infra/session-telemetry.mjs`, `infra/live-event-projector.mjs`, `infra/replay-reader.mjs`

## Transitional Owners

| Transitional file | Wrapper status | Canonical delegation target | Divergent behavior removed | Remaining compatibility debt |
| --- | --- | --- | --- | --- |
| `agent/primary-agent.mjs` | Compatibility facade | `agent/session-manager.mjs`, `agent/provider-kernel.mjs`, `shell/shell-session-compat.mjs`, `shell/shell-adapter-registry.mjs` | Primary-session scope, provider default selection, active-session routing, shell controller binding, and shell adapter lookup all resolve through canonical manager/kernel/compat paths. | Retains historical prompt framing and failover entrypoint behavior as documented surface adaptation only — no provider, approval, retry, lifecycle, or lineage semantics remain owned here. Compliant with the cutover rule. |
| `agent/agent-pool.mjs` | Compatibility facade | `agent/agent-launcher.mjs`, `agent/session-manager.mjs`, `agent/internal-harness-runtime.mjs`, `agent/provider-kernel.mjs` | Managed external sessions and provider turn routing now flow through canonical launcher/session/kernel seams instead of private pool state. | Launcher extraction completed; `agent-pool.mjs` now re-exports bounded launcher and canonical session/thread entrypoints only. |
| `shell/shell-session-compat.mjs` | Narrow compatibility bridge | `agent/session-manager.mjs`, `agent/provider-kernel.mjs`, `agent/tool-orchestrator.mjs`, `infra/session-telemetry.mjs` | Shell-local provider aliases, lifecycle state, and tool events no longer define separate runtime contracts. | Continues to translate legacy shell session idioms into canonical envelopes. |
| `shell/shell-adapter-registry.mjs` | Shell transport catalog | `shell/*`, `shell/shell-session-compat.mjs`, `agent/provider-kernel.mjs` | Legacy shell executor imports and adapter-specific parity helpers are centralized in one shell-owned catalog instead of `agent/primary-agent.mjs`. | Still preserves adapter-specific startup and SDK command parity for compatibility callers. |
| `shell/codex-shell.mjs` | Thin shell adapter | `shell/shell-session-compat.mjs`, `agent/provider-kernel.mjs` | Provider identity and managed session tracking are delegated out of the shell body. | Adapter-specific startup and transport quirks still live here. |
| `shell/claude-shell.mjs` | Thin shell adapter | `shell/shell-session-compat.mjs`, `agent/provider-kernel.mjs` | Session lifecycle and provider selection are compatibility calls, not local source of truth. | Claude transport behavior still needs eventual extraction into provider drivers only. |
| `shell/opencode-shell.mjs` | Thin shell adapter | `shell/shell-session-compat.mjs`, `agent/provider-kernel.mjs` | OpenAI-compatible provider selection and thread ownership are canonicalized. | Transport-specific session naming remains adapter-local. |
| `shell/copilot-shell.mjs` | Thin shell adapter | `shell/shell-session-compat.mjs`, `agent/provider-kernel.mjs` | Copilot provider routing no longer acts as a separate provider runtime. | OAuth-specific process/session quirks still surface here. |
| `shell/gemini-shell.mjs` | Thin shell adapter | `shell/shell-session-compat.mjs`, `agent/provider-kernel.mjs` | Session and provider ownership are centralized. | Gemini executor quirks still require wrapper handling. |
| `server/ui-server.mjs` | Surface composition layer | `server/routes/harness-*.mjs`, `agent/session-manager.mjs`, `infra/session-telemetry.mjs` | Harness sessions, approvals, providers, events, and replay now expose canonical APIs instead of bespoke per-surface logic. | File still contains broad server concerns outside the harness routes. |
| `workflow/workflow-engine.mjs` | Graph scheduler and workflow run bookkeeper | `workflow/delegation-runtime.mjs`, `workflow/harness-session-node.mjs`, `workflow/harness-tool-node.mjs`, `workflow/harness-approval-node.mjs`, `workflow/harness-subagent-node.mjs` | Workflow-private session ownership, tool policy, approvals, subagent semantics, and shared delegation-state interpretation are delegated out of the engine into harness-backed nodes plus `workflow/delegation-runtime.mjs`. | Remains large because it still owns scheduling, persistence, retry, checkpoint, and run-history behavior, but it no longer co-owns harness lifecycle or delegation policy. |
| `workflow/workflow-nodes.mjs` | Public composition shell | `workflow/workflow-nodes/*`, `workflow/harness-session-node.mjs`, `workflow/harness-tool-node.mjs`, `workflow/harness-approval-node.mjs`, `workflow/harness-subagent-node.mjs` | Built-in node registration moved under `workflow/workflow-nodes/*.mjs`, and workflow-linked session/tool/approval/subagent behavior resolves through the canonical harness node modules. | Keeps the stable public import surface for node registration/custom-node loading, but it is no longer a hidden monolithic runtime owner. |
| `telegram/telegram-bot.mjs` | Surface controller | `telegram/harness-api-client.mjs`, `telegram/telegram-surface-runtime.mjs`, `infra/monitor.mjs`, `server/ui-server.mjs` harness routes | Telegram-side provider switching, session inspection, and thread operations now ride canonical harness APIs, while monitor-owned UI lifecycle flows through the bounded `telegram-surface-runtime.mjs` adapter instead of the bot body. | Bot command handling remains large and still mixes many non-harness concerns. |
| `bosun-tui.mjs` | Entry shim | `tui/app.mjs`, `tui/lib/ws-bridge.mjs` | TUI startup no longer owns runtime semantics; it connects to shared server and event surfaces. | None beyond terminal bootstrapping. |
| `tui/lib/ws-bridge.mjs` | Read/write surface bridge | `server/ui-server.mjs` websocket and HTTP APIs | TUI state now consumes canonical snapshots and harness routes rather than local runtime assembly. | Still depends on UI server availability for remote/local parity. |
| `ui/modules/harness-client.js` | Browser path helper | `server/ui-server.mjs` harness routes | Web UI route construction is centralized around canonical harness endpoints. | Client-only path helpers remain duplicated in `site/ui` mirrors. |

## Cutover Rule

Compatibility wrappers remain acceptable only when they satisfy all of the following:

1. They do not own provider, approval, retry, lifecycle, or lineage semantics.
2. Their runtime state can be reconstructed from canonical harness modules.
3. Their remaining responsibility can be described as transport, entrypoint, or surface adaptation.
