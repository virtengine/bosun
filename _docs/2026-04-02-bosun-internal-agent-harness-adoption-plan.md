# Bosun Internal Agent Harness Adoption Plan

Date: 2026-04-02
Scope: `bosun/` plus the sibling projects `opencode-dev/opencode-dev`, `codex-main`, `openclaude`, and `pi-mono-main`
Goal: build one Bosun-native internal agent harness that powers TUI, chat, workflow, web UI, and Telegram with full observability, strong provider coverage, and minimal duplicated runtime logic.

## Executive Decision

Bosun should not keep growing the current `primary-agent.mjs` plus `agent-pool.mjs` plus `shell/*` arrangement as the long-term control plane.

Bosun should instead converge on:

1. One Bosun-native harness runtime in `.mjs` for orchestration, workflow integration, UI integration, approvals, settings, and state.
2. One provider abstraction layer in `.mjs` that normalizes subscription-backed and API-backed models into a single turn contract.
3. One event and ledger model in Bosun that every surface consumes.
4. One optional Rust sidecar for the hot path only:
   - long-running unified exec process management
   - tool orchestration under load
   - high-frequency telemetry buffering and export

The best donor split is:

- `pi-mono-main`: core agent loop, provider abstraction shape, extension model
- `codex-main`: unified exec, multi-agent control plane, TUI interaction patterns, telemetry discipline
- `opencode-dev/opencode-dev`: provider discovery, session processor/event projection, tool registry shape, client-server split
- `openclaude`: provider shims, permission model, transport reliability, in-process swarm patterns

## Bosun Current State

Bosun already has the right seams, but they are too fragmented to become the in-house gold standard without consolidation.

Current Bosun files that already form the base:

- `bosun/agent/internal-harness-profile.mjs`
- `bosun/agent/internal-harness-control-plane.mjs`
- `bosun/agent/internal-harness-runtime.mjs`
- `bosun/agent/agent-pool.mjs`
- `bosun/agent/primary-agent.mjs`
- `bosun/agent/agent-event-bus.mjs`
- `bosun/workflow/workflow-engine.mjs`
- `bosun/workflow/execution-ledger.mjs`
- `bosun/server/ui-server.mjs`
- `bosun/tui/app.mjs`
- `bosun/telegram/telegram-bot.mjs`
- `bosun/shell/codex-shell.mjs`
- `bosun/shell/claude-shell.mjs`
- `bosun/shell/copilot-shell.mjs`
- `bosun/shell/gemini-shell.mjs`
- `bosun/shell/opencode-shell.mjs`
- `bosun/shell/opencode-providers.mjs`

The problem is not that Bosun lacks features. The problem is that the runtime contract is split across:

- persistent primary-agent routing
- pooled ephemeral execution
- per-provider shell adapters
- workflow execution
- TUI state
- Telegram command handling

That split is why Bosun still feels like multiple agent systems bolted together instead of one internal harness.

## Target Architecture

### 1. Harness Core

Bosun needs one canonical turn and lifecycle engine.

Source donors:

- `pi-mono-main/packages/agent/src/agent-loop.ts`
- `pi-mono-main/packages/agent/src/agent.ts`
- `opencode-dev/opencode-dev/packages/opencode/src/session/processor.ts`
- `openclaude/src/utils/task/framework.ts`

Bosun target files:

- Keep and expand:
  - `bosun/agent/internal-harness-runtime.mjs`
  - `bosun/agent/internal-harness-profile.mjs`
  - `bosun/agent/internal-harness-control-plane.mjs`
- Add:
  - `bosun/agent/harness/agent-loop.mjs`
  - `bosun/agent/harness/turn-runner.mjs`
  - `bosun/agent/harness/tool-runner.mjs`
  - `bosun/agent/harness/steering-queue.mjs`
  - `bosun/agent/harness/followup-queue.mjs`
  - `bosun/agent/harness/session-state.mjs`
  - `bosun/agent/harness/message-normalizer.mjs`

Required behavior:

- one event contract for:
  - `agent_start`
  - `turn_start`
  - `message_start`
  - `message_update`
  - `message_end`
  - `tool_execution_start`
  - `tool_execution_update`
  - `tool_execution_end`
  - `turn_end`
  - `agent_end`
  - `approval_requested`
  - `approval_resolved`
  - `intervention_requested`
  - `intervention_delivered`
- one session model for:
  - initial prompt
  - continue
  - retry
  - steer
  - follow-up
  - abort
  - resume

### 2. Provider Kernel

Bosun needs one provider registry and one provider session contract. It must support:

- ChatGPT subscription-backed Codex
- OpenAI API
- Azure OpenAI Responses
- Claude subscription-backed flows
- Anthropic API
- Ollama and other OpenAI-compatible local providers
- Copilot-style OAuth-backed models
- optional OpenCode-compatible providers

Source donors:

- `pi-mono-main/packages/ai/src/api-registry.ts`
- `pi-mono-main/packages/ai/src/providers/register-builtins.ts`
- `pi-mono-main/packages/ai/src/providers/openai-codex-responses.ts`
- `pi-mono-main/packages/ai/src/providers/azure-openai-responses.ts`
- `pi-mono-main/packages/ai/src/env-api-keys.ts`
- `opencode-dev/opencode-dev/packages/opencode/src/provider/provider.ts`
- `opencode-dev/opencode-dev/packages/opencode/src/provider/transform.ts`
- `opencode-dev/opencode-dev/packages/opencode/src/provider/models.ts`
- `openclaude/src/services/api/openaiShim.ts`
- `openclaude/src/services/api/providerConfig.js`

Bosun target files:

- Add:
  - `bosun/agent/provider-registry.mjs`
  - `bosun/agent/provider-auth-manager.mjs`
  - `bosun/agent/provider-capabilities.mjs`
  - `bosun/agent/provider-session.mjs`
  - `bosun/agent/provider-message-transform.mjs`
  - `bosun/agent/provider-model-catalog.mjs`
  - `bosun/agent/providers/openai-responses.mjs`
  - `bosun/agent/providers/openai-codex-subscription.mjs`
  - `bosun/agent/providers/azure-openai-responses.mjs`
  - `bosun/agent/providers/anthropic-messages.mjs`
  - `bosun/agent/providers/claude-subscription-shim.mjs`
  - `bosun/agent/providers/openai-compatible.mjs`
  - `bosun/agent/providers/ollama.mjs`
  - `bosun/agent/providers/copilot-oauth.mjs`
- Shrink or deprecate into compatibility shims:
  - `bosun/shell/codex-shell.mjs`
  - `bosun/shell/claude-shell.mjs`
  - `bosun/shell/copilot-shell.mjs`
  - `bosun/shell/gemini-shell.mjs`
  - `bosun/shell/opencode-shell.mjs`
  - `bosun/shell/opencode-providers.mjs`

Required behavior:

- provider inventory from one place
- one normalized streaming event model
- one normalized tool-call model
- one normalized cost/usage model
- one normalized auth-status model
- one normalized reasoning-effort model

### 3. Tool Orchestrator

Bosun needs one tool execution path with explicit approval, sandbox, retry, truncation, and telemetry behavior.

Source donors:

- `codex-main/codex-rs/core/src/tools/orchestrator.rs`
- `codex-main/codex-rs/core/src/tools/registry.rs`
- `codex-main/codex-rs/core/src/tools/router.rs`
- `codex-main/codex-rs/core/src/tools/parallel.rs`
- `codex-main/codex-rs/core/src/tools/handlers/unified_exec.rs`
- `opencode-dev/opencode-dev/packages/opencode/src/tool/registry.ts`
- `pi-mono-main/packages/coding-agent/src/core/tools/*`
- `openclaude/src/utils/permissions/permissions.ts`

Bosun target files:

- Add:
  - `bosun/agent/tool-orchestrator.mjs`
  - `bosun/agent/tool-registry.mjs`
  - `bosun/agent/tool-approval-manager.mjs`
  - `bosun/agent/tool-network-policy.mjs`
  - `bosun/agent/tool-runtime-context.mjs`
  - `bosun/agent/tool-output-truncation.mjs`
- Integrate with:
  - `bosun/agent/internal-harness-runtime.mjs`
  - `bosun/workflow/approval-queue.mjs`
  - `bosun/server/ui-server.mjs`
  - `bosun/agent/agent-event-bus.mjs`

This layer must become the only place where Bosun decides:

- does this tool require approval
- does this tool require sandboxing
- should this tool be retried
- how is tool output truncated
- how is tool execution emitted to the ledger and UI

### 4. Session and Thread Control Plane

Bosun needs a real thread/session manager that is not split between the primary agent and the pooled agent path.

Source donors:

- `codex-main/codex-rs/core/src/agent/control.rs`
- `codex-main/codex-rs/core/src/thread_manager.rs`
- `codex-main/codex-rs/core/src/state/session.rs`
- `codex-main/codex-rs/app-server/src/thread_state.rs`
- `openclaude/src/utils/swarm/inProcessRunner.ts`
- `opencode-dev/opencode-dev/packages/opencode/src/session/index.ts`

Bosun target files:

- Rewrite heavily:
  - `bosun/agent/primary-agent.mjs`
  - `bosun/agent/agent-pool.mjs`
- Add:
  - `bosun/agent/session-manager.mjs`
  - `bosun/agent/thread-registry.mjs`
  - `bosun/agent/subagent-control.mjs`
  - `bosun/agent/session-replay.mjs`

New rule:

- `primary-agent.mjs` becomes a thin facade over the new harness session manager.
- `agent-pool.mjs` stops owning the whole agent story and becomes either:
  - a subprocess/thread launcher only, or
  - a compatibility layer until the new harness is fully adopted.

### 5. Observability Spine

Bosun already has strong raw data. It now needs one canonical observability model.

Source donors:

- `codex-main/codex-rs/otel/src/events/session_telemetry.rs`
- `codex-main/codex-rs/core/src/memory_trace.rs`
- `codex-main/codex-rs/exec/src/exec_events.rs`
- `openclaude/src/utils/telemetry/sessionTracing.ts`
- `openclaude/src/utils/telemetry/perfettoTracing.ts`
- `opencode-dev/opencode-dev/packages/opencode/src/server/event.ts`
- `opencode-dev/opencode-dev/packages/opencode/src/session/projectors.ts`

Bosun target files:

- Keep and extend:
  - `bosun/agent/agent-event-bus.mjs`
  - `bosun/workflow/execution-ledger.mjs`
- Add:
  - `bosun/infra/session-telemetry.mjs`
  - `bosun/infra/trace-export.mjs`
  - `bosun/infra/live-event-projector.mjs`
  - `bosun/infra/runtime-metrics.mjs`
  - `bosun/infra/provider-usage-ledger.mjs`

Mandatory tracked entities:

- provider request
- provider stream lifecycle
- tool approval decision
- tool execution
- file mutation
- patch application
- subagent spawn
- subagent completion
- intervention
- retry
- workflow node execution
- Telegram command dispatch
- TUI command dispatch

### 6. Surface Adapters

Every Bosun surface should call the same harness APIs.

Bosun target files:

- `bosun/workflow/workflow-engine.mjs`
- `bosun/server/ui-server.mjs`
- `bosun/tui/app.mjs`
- `bosun/telegram/telegram-bot.mjs`
- `bosun/ui/modules/session-api.js`
- `bosun/ui/modules/agent-events.js`
- `bosun/ui/modules/streaming.js`

New rule:

- surfaces must not own provider logic
- surfaces must not own retry logic
- surfaces must not own approval logic
- surfaces must not own session state transitions

They call the harness, subscribe to events, and render state.

## What To Port From Each Project

### `pi-mono-main`

Take directly into Bosun `.mjs`:

- `packages/agent/src/agent-loop.ts`
- `packages/agent/src/agent.ts`
- `packages/ai/src/api-registry.ts`
- `packages/ai/src/providers/register-builtins.ts`
- `packages/ai/src/providers/openai-codex-responses.ts`
- `packages/ai/src/providers/azure-openai-responses.ts`
- `packages/ai/src/providers/openai-completions.ts`
- `packages/ai/src/providers/openai-responses.ts`
- `packages/ai/src/env-api-keys.ts`
- `packages/coding-agent/src/core/extensions/*`
- `packages/coding-agent/src/core/tools/*`
- `packages/coding-agent/src/core/model-resolver.ts`
- `packages/coding-agent/src/core/event-bus.ts`
- `packages/tui/src/*`

Main contribution to Bosun:

- clean turn lifecycle
- clean provider registry
- extension system
- tool rendering and TUI composition
- first-class support for local OpenAI-compatible providers

### `codex-main`

Take as the model for Bosun's performance-critical path and multi-agent control plane:

- `codex-rs/core/src/tools/orchestrator.rs`
- `codex-rs/core/src/unified_exec/process_manager.rs`
- `codex-rs/core/src/unified_exec/head_tail_buffer.rs`
- `codex-rs/core/src/unified_exec/async_watcher.rs`
- `codex-rs/core/src/agent/control.rs`
- `codex-rs/core/src/thread_manager.rs`
- `codex-rs/core/src/memory_trace.rs`
- `codex-rs/otel/src/events/session_telemetry.rs`
- `codex-rs/app-server/src/thread_state.rs`
- `codex-rs/tui/src/multi_agents.rs`
- `codex-rs/tui/src/chatwidget.rs`
- `codex-rs/tui/src/streaming/controller.rs`

Main contribution to Bosun:

- strong async process lifecycle management
- multi-agent thread registry and spawn semantics
- session telemetry and metrics
- unified exec done properly
- better TUI interaction model for multi-agent workflows

### `opencode-dev/opencode-dev`

Take as the model for provider discovery, projectors, and client-server surfaces:

- `packages/opencode/src/provider/provider.ts`
- `packages/opencode/src/provider/transform.ts`
- `packages/opencode/src/provider/models.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/session/compaction.ts`
- `packages/opencode/src/tool/registry.ts`
- `packages/opencode/src/server/server.ts`
- `packages/opencode/src/server/router.ts`
- `packages/opencode/src/server/routes/session.ts`
- `packages/opencode/src/server/routes/provider.ts`
- `packages/opencode/src/server/routes/event.ts`
- `packages/opencode/src/cli/cmd/tui/thread.ts`

Main contribution to Bosun:

- dynamic provider inventory
- session processor with projector-friendly events
- tool registry composition
- proper client/server split for TUI and remote control

### `openclaude`

Take as the model for compatibility shims, permissions, transports, and in-process teammates:

- `src/services/api/openaiShim.ts`
- `src/services/api/codexShim.js`
- `src/utils/permissions/permissions.ts`
- `src/utils/telemetry/sessionTracing.ts`
- `src/cli/transports/HybridTransport.ts`
- `src/cli/transports/SerialBatchEventUploader.ts`
- `src/utils/swarm/inProcessRunner.ts`
- `src/utils/task/framework.ts`

Main contribution to Bosun:

- Claude-style provider abstraction on top of non-Claude providers
- robust permission explanation and gating
- transport backpressure and batched event upload
- in-process teammate coordination

## Bosun Rewrite Matrix

### Keep And Expand

- `bosun/agent/internal-harness-profile.mjs`
  - keep as the harness spec compiler
  - extend to compile provider requirements, tool bundles, approval rules, reasoning policy, retry policy
- `bosun/agent/internal-harness-runtime.mjs`
  - keep as the execution kernel entry
  - refactor to call the new `agent/harness/*` modules
- `bosun/agent/internal-harness-control-plane.mjs`
  - keep as control-plane metadata and artifact persistence
  - extend for active sessions, run lineage, provider choices, and performance counters
- `bosun/agent/agent-event-bus.mjs`
  - keep as Bosun's real-time nervous system
  - expand to become the only event bus for agent lifecycle, tool events, approvals, and subagents
- `bosun/workflow/execution-ledger.mjs`
  - keep as the durable run spine
  - expand schema for provider turn IDs, tool IDs, thread IDs, approval IDs, span IDs, and session lineage
- `bosun/workflow/workflow-engine.mjs`
  - keep as the workflow orchestrator
  - change node execution to call the harness session manager instead of bespoke agent paths

### Rewrite Heavily

- `bosun/agent/primary-agent.mjs`
  - convert from adapter-switchboard into harness facade plus active-session selector
- `bosun/agent/agent-pool.mjs`
  - split into:
    - session registry
    - retry policy
    - subprocess launcher
    - thread persistence
  - stop using it as the monolithic home for every agent concern
- `bosun/server/ui-server.mjs`
  - consolidate agent, provider, session, approval, and observability endpoints around the new harness
- `bosun/telegram/telegram-bot.mjs`
  - route free text, commands, steering, and approvals through the harness APIs
- `bosun/tui/app.mjs`
  - make the TUI subscribe to live harness state instead of assembling partial views from multiple ad hoc feeds

### Demote To Compatibility Shims

- `bosun/shell/codex-shell.mjs`
- `bosun/shell/claude-shell.mjs`
- `bosun/shell/copilot-shell.mjs`
- `bosun/shell/gemini-shell.mjs`
- `bosun/shell/opencode-shell.mjs`
- `bosun/shell/opencode-providers.mjs`

These should remain temporarily for backward compatibility while the new provider kernel lands, then become thin wrappers or be retired.

## Exact Rust Rewrites Worth Doing

Only a few Bosun paths deserve Rust. Everything else should stay in `.mjs` for velocity and direct integration.

### Rust Crate 1: Unified Exec Runtime

Create:

- `bosun/native/bosun-unified-exec/Cargo.toml`
- `bosun/native/bosun-unified-exec/src/main.rs`
- `bosun/native/bosun-unified-exec/src/process_manager.rs`
- `bosun/native/bosun-unified-exec/src/head_tail_buffer.rs`
- `bosun/native/bosun-unified-exec/src/async_watcher.rs`
- `bosun/native/bosun-unified-exec/src/tool_orchestrator.rs`

Primary donor files:

- `codex-main/codex-rs/core/src/unified_exec/process_manager.rs`
- `codex-main/codex-rs/core/src/unified_exec/head_tail_buffer.rs`
- `codex-main/codex-rs/core/src/unified_exec/async_watcher.rs`
- `codex-main/codex-rs/core/src/tools/orchestrator.rs`

Bosun integration points:

- `bosun/agent/tool-orchestrator.mjs`
- `bosun/agent/agent-pool.mjs`
- `bosun/server/ui-server.mjs`
- `bosun/workflow/workflow-engine.mjs`

Reason:

- this is the highest-throughput and most failure-sensitive path
- Rust gives better control over process lifecycle, buffering, cancellation, and backpressure

### Rust Crate 2: Telemetry Buffer And Export

Create:

- `bosun/native/bosun-telemetry/Cargo.toml`
- `bosun/native/bosun-telemetry/src/main.rs`
- `bosun/native/bosun-telemetry/src/session_telemetry.rs`
- `bosun/native/bosun-telemetry/src/metrics.rs`
- `bosun/native/bosun-telemetry/src/export.rs`

Primary donor files:

- `codex-main/codex-rs/otel/src/events/session_telemetry.rs`
- `openclaude/src/utils/telemetry/sessionTracing.ts`

Bosun integration points:

- `bosun/infra/session-telemetry.mjs`
- `bosun/agent/agent-event-bus.mjs`
- `bosun/workflow/execution-ledger.mjs`

Reason:

- high-frequency event export and metrics aggregation should not compete with the Node event loop when many agents are active

### Do Not Rewrite In Rust Yet

Do not spend time rewriting these in Rust initially:

- provider registry
- auth manager
- workflow orchestration
- Telegram integration
- UI server endpoints
- TUI rendering
- settings
- approval queue

Those belong in `.mjs` because Bosun needs fast iteration there.

## Provider Support Plan

### Must-Have At Launch

- OpenAI API
- Azure OpenAI Responses
- ChatGPT subscription-backed Codex
- Anthropic API
- Claude subscription-backed usage path
- Ollama via OpenAI-compatible driver
- generic OpenAI-compatible endpoint

### Should-Have Next

- GitHub Copilot OAuth-backed models
- Gemini direct and Gemini CLI
- OpenCode-compatible providers

### Provider Auth Files To Add

- `bosun/agent/provider-auth-manager.mjs`
- `bosun/agent/auth/openai-api-key.mjs`
- `bosun/agent/auth/azure-openai.mjs`
- `bosun/agent/auth/chatgpt-codex-subscription.mjs`
- `bosun/agent/auth/anthropic-api-key.mjs`
- `bosun/agent/auth/claude-subscription.mjs`
- `bosun/agent/auth/openai-compatible.mjs`
- `bosun/agent/auth/copilot-oauth.mjs`

## Surface Integration Plan

### Workflow Engine

Change:

- `bosun/workflow/workflow-engine.mjs`
- `bosun/workflow/workflow-nodes.mjs`
- `bosun/workflow/workflow-contract.mjs`

So that workflow nodes can:

- spawn harness sessions
- wait on subagent results
- inspect structured outputs
- request approvals
- observe provider/tool telemetry in-line

### TUI

Change:

- `bosun/tui/app.mjs`
- `bosun/tui/screens/agents.mjs`
- `bosun/tui/screens/logs.mjs`
- `bosun/tui/screens/telemetry.mjs`
- `bosun/tui/screens/workflows.mjs`

Add:

- live session inspector
- subagent tree view
- provider usage strip
- approval queue panel
- unified exec live output view

Primary donor references:

- `codex-main/codex-rs/tui/src/multi_agents.rs`
- `codex-main/codex-rs/tui/src/chatwidget.rs`
- `pi-mono-main/packages/tui/src/*`
- `opencode-dev/opencode-dev/packages/opencode/src/cli/cmd/tui/*`

### Telegram

Change:

- `bosun/telegram/telegram-bot.mjs`

So Telegram can:

- start or steer any harness session
- resolve approval requests
- inspect live provider/tool status
- switch providers without bypassing the harness

### Web UI And API

Change:

- `bosun/server/ui-server.mjs`
- `bosun/ui/modules/session-api.js`
- `bosun/ui/modules/agent-events.js`
- `bosun/ui/modules/streaming.js`

Add endpoints for:

- provider inventory
- provider auth status
- active harness sessions
- session lineage
- tool approvals
- live exec streams
- event tails
- cost and token summaries

## Implementation Order

### Phase 1: Harness Core In `.mjs`

Build first:

- `bosun/agent/harness/agent-loop.mjs`
- `bosun/agent/provider-registry.mjs`
- `bosun/agent/session-manager.mjs`
- `bosun/agent/tool-orchestrator.mjs`

Refactor:

- `bosun/agent/internal-harness-runtime.mjs`
- `bosun/agent/primary-agent.mjs`

Success criteria:

- TUI, UI server, workflow engine, and Telegram can all start the same harness session type
- one provider-neutral event model exists

### Phase 2: Provider Consolidation

Build:

- `bosun/agent/providers/*`
- `bosun/agent/provider-auth-manager.mjs`
- `bosun/agent/provider-model-catalog.mjs`

Demote:

- `bosun/shell/*`

Success criteria:

- same prompt can run on ChatGPT Codex, OpenAI API, Azure OpenAI, Claude, and Ollama without surface-specific code paths

### Phase 3: Observability And Ledger Upgrade

Build:

- `bosun/infra/session-telemetry.mjs`
- `bosun/infra/runtime-metrics.mjs`

Extend:

- `bosun/agent/agent-event-bus.mjs`
- `bosun/workflow/execution-ledger.mjs`

Success criteria:

- every turn, tool call, approval, retry, and provider request is queryable

### Phase 4: Surface Unification

Refactor:

- `bosun/workflow/workflow-engine.mjs`
- `bosun/server/ui-server.mjs`
- `bosun/tui/app.mjs`
- `bosun/telegram/telegram-bot.mjs`

Success criteria:

- all surfaces are thin adapters over the same harness APIs

### Phase 5: Rust Hot Path

Build:

- `bosun/native/bosun-unified-exec`
- optional `bosun/native/bosun-telemetry`

Success criteria:

- heavy parallel exec and high-frequency event flow stop pressuring the Node main loop

## What Bosun Should Not Do

- Do not keep `primary-agent.mjs` as the long-term root of all provider logic.
- Do not let each surface maintain its own agent session semantics.
- Do not move high-churn runtime state into git.
- Do not make provider-specific shell wrappers the canonical contract.
- Do not rewrite large UI or workflow surfaces in Rust.
- Do not make advanced provider backends default-on; expose them through settings and explicit selection.

## 10-Step Implementation Prompts

The following steps are intentionally large and outcome-driven. Each prompt is written so it can be handed to an implementation agent or used as a milestone brief for a human engineer. The prompts assume Bosun is the destination system and the sibling projects are donor references, not runtime dependencies.

### Step 1: Establish The Canonical Harness Skeleton

**Goal**

Create the new Bosun-native harness module structure without breaking existing behavior. This step establishes the canonical internal layout and the compatibility boundary between the old agent paths and the new harness.

**Primary Bosun files**

- Create:
  - `bosun/agent/harness/agent-loop.mjs`
  - `bosun/agent/harness/turn-runner.mjs`
  - `bosun/agent/harness/tool-runner.mjs`
  - `bosun/agent/harness/steering-queue.mjs`
  - `bosun/agent/harness/followup-queue.mjs`
  - `bosun/agent/harness/session-state.mjs`
  - `bosun/agent/harness/message-normalizer.mjs`
- Refactor lightly:
  - `bosun/agent/internal-harness-runtime.mjs`
  - `bosun/agent/internal-harness-profile.mjs`
  - `bosun/agent/internal-harness-control-plane.mjs`

**Donor references**

- `pi-mono-main/packages/agent/src/agent-loop.ts`
- `pi-mono-main/packages/agent/src/agent.ts`
- `opencode-dev/opencode-dev/packages/opencode/src/session/processor.ts`
- `openclaude/src/utils/task/framework.ts`

**Implementation prompt**

Port the core agent-loop and turn-lifecycle ideas from `pi-mono-main` and the session-processing ideas from `opencode-dev` into Bosun `.mjs` modules under `bosun/agent/harness/`. Do not replace Bosun behavior wholesale in this step. Instead, define the canonical harness interfaces, event shapes, and session-state model that later steps will adopt. `internal-harness-runtime.mjs` should become the single execution entrypoint for the new harness modules, while `internal-harness-profile.mjs` should compile profile settings into a stable runtime config object. `internal-harness-control-plane.mjs` should begin tracking session metadata and run lineage using the new harness identifiers. Keep old paths working through compatibility routing. Do not introduce provider-specific behavior here. Deliver a harness skeleton that can start, continue, steer, retry, abort, and resume a session through one internal contract. Include focused tests or harness smoke coverage for lifecycle transitions and event emission.

**Completion criteria**

- New `bosun/agent/harness/*` modules exist and are wired into `internal-harness-runtime.mjs`.
- A canonical session-state object exists and supports initial prompt, continue, retry, steer, follow-up, abort, and resume.
- Existing Bosun entrypoints still load without breaking.
- The new harness emits a stable internal event contract for later steps to consume.

### Step 2: Replace Monolithic Agent Routing With A Real Session Manager

**Goal**

Stop treating `primary-agent.mjs` and `agent-pool.mjs` as the long-term home for all agent behavior. Introduce a real Bosun session manager and thread registry.

**Primary Bosun files**

- Create:
  - `bosun/agent/session-manager.mjs`
  - `bosun/agent/thread-registry.mjs`
  - `bosun/agent/subagent-control.mjs`
  - `bosun/agent/session-replay.mjs`
- Rewrite heavily:
  - `bosun/agent/primary-agent.mjs`
  - `bosun/agent/agent-pool.mjs`

**Donor references**

- `codex-main/codex-rs/core/src/agent/control.rs`
- `codex-main/codex-rs/core/src/thread_manager.rs`
- `codex-main/codex-rs/core/src/state/session.rs`
- `codex-main/codex-rs/app-server/src/thread_state.rs`
- `openclaude/src/utils/swarm/inProcessRunner.ts`
- `opencode-dev/opencode-dev/packages/opencode/src/session/index.ts`

**Implementation prompt**

Rebuild Bosun session ownership around a dedicated `session-manager.mjs` and `thread-registry.mjs`. `primary-agent.mjs` must become a thin facade that selects or creates active sessions and delegates execution into the new harness. `agent-pool.mjs` must stop being the monolithic owner of retries, subprocesses, and session state; split those concerns so it becomes either a launcher layer or a temporary compatibility adapter only. Implement Bosun-native thread IDs, lineage tracking, replay support, and subagent spawning semantics modeled after Codex thread/session control. Support parent-child relationships for workflow-triggered and user-triggered subagents. Ensure replay and resume semantics are explicit and durable. Preserve Bosun's current operational behavior where possible, but align everything to one session manager contract that all surfaces can share.

**Completion criteria**

- `primary-agent.mjs` is only a facade and no longer owns end-to-end provider logic.
- `agent-pool.mjs` has been decomposed and reduced in responsibility.
- Sessions, threads, subagents, lineage, and replay are all represented in dedicated modules.
- One session manager now owns the lifecycle for both long-lived and ephemeral runs.

### Step 3: Build The Provider Kernel And Normalize All Providers

**Goal**

Create one provider abstraction layer that Bosun uses everywhere, with normalized messages, streams, tools, usage, and auth state.

**Primary Bosun files**

- Create:
  - `bosun/agent/provider-registry.mjs`
  - `bosun/agent/provider-auth-manager.mjs`
  - `bosun/agent/provider-capabilities.mjs`
  - `bosun/agent/provider-session.mjs`
  - `bosun/agent/provider-message-transform.mjs`
  - `bosun/agent/provider-model-catalog.mjs`
  - `bosun/agent/providers/openai-responses.mjs`
  - `bosun/agent/providers/openai-codex-subscription.mjs`
  - `bosun/agent/providers/azure-openai-responses.mjs`
  - `bosun/agent/providers/anthropic-messages.mjs`
  - `bosun/agent/providers/claude-subscription-shim.mjs`
  - `bosun/agent/providers/openai-compatible.mjs`
  - `bosun/agent/providers/ollama.mjs`
  - `bosun/agent/providers/copilot-oauth.mjs`

**Donor references**

- `pi-mono-main/packages/ai/src/api-registry.ts`
- `pi-mono-main/packages/ai/src/providers/register-builtins.ts`
- `pi-mono-main/packages/ai/src/providers/openai-codex-responses.ts`
- `pi-mono-main/packages/ai/src/providers/azure-openai-responses.ts`
- `pi-mono-main/packages/ai/src/providers/openai-responses.ts`
- `pi-mono-main/packages/ai/src/env-api-keys.ts`
- `opencode-dev/opencode-dev/packages/opencode/src/provider/provider.ts`
- `opencode-dev/opencode-dev/packages/opencode/src/provider/transform.ts`
- `opencode-dev/opencode-dev/packages/opencode/src/provider/models.ts`
- `openclaude/src/services/api/openaiShim.ts`
- `openclaude/src/services/api/providerConfig.js`

**Implementation prompt**

Port the provider registry and provider-driver patterns from `pi-mono-main` into Bosun and use `opencode-dev` as the reference for provider discovery and message transformation. Build a Bosun provider kernel that supports OpenAI API, Azure OpenAI Responses, ChatGPT subscription-backed Codex flows, Anthropic API, Claude subscription-backed flows, Ollama, generic OpenAI-compatible endpoints, and Copilot-style OAuth-backed models. Define one normalized provider session contract for prompt input, streaming output, tool calls, reasoning mode, usage accounting, error handling, and auth status. Do not let any Bosun surface talk directly to providers anymore. Provider-specific quirks should live in `bosun/agent/providers/*` and be hidden behind the registry. Keep advanced providers selectable in settings and off by default where appropriate.

**Completion criteria**

- One provider registry owns provider inventory and lookup.
- All supported providers conform to one normalized Bosun provider session contract.
- Usage, cost, auth status, and streaming events are normalized.
- Surface code no longer needs provider-specific branches.

### Step 4: Build Provider Auth, Model Catalog, And Settings Integration

**Goal**

Finish the operational layer for providers so Bosun can manage auth state, model availability, and provider selection centrally through settings and APIs.

**Primary Bosun files**

- Create:
  - `bosun/agent/auth/openai-api-key.mjs`
  - `bosun/agent/auth/azure-openai.mjs`
  - `bosun/agent/auth/chatgpt-codex-subscription.mjs`
  - `bosun/agent/auth/anthropic-api-key.mjs`
  - `bosun/agent/auth/claude-subscription.mjs`
  - `bosun/agent/auth/openai-compatible.mjs`
  - `bosun/agent/auth/copilot-oauth.mjs`
- Refactor:
  - `bosun/agent/provider-auth-manager.mjs`
  - `bosun/agent/provider-model-catalog.mjs`
  - `bosun/server/ui-server.mjs`
  - Bosun settings schema and settings update handlers that govern provider enablement

**Donor references**

- `pi-mono-main/packages/ai/src/env-api-keys.ts`
- `opencode-dev/opencode-dev/packages/opencode/src/server/routes/provider.ts`
- `openclaude/src/services/api/providerConfig.js`
- `openclaude/src/cli/transports/HybridTransport.ts`

**Implementation prompt**

Implement the auth and model-management layer for the provider kernel. Bosun must be able to report provider availability, auth status, missing credentials, supported models, and effective capabilities from one API surface. Add auth adapters for API-key-backed, subscription-backed, OAuth-backed, and OpenAI-compatible local providers. Integrate provider enablement into Bosun settings so optional backends remain explicit and not default-on. Update server endpoints to expose provider inventory, auth health, and model catalogs to the TUI and web UI. Ensure provider selection is runtime-configurable for chat, workflow, and Telegram paths without each surface maintaining its own provider resolution logic.

**Completion criteria**

- Bosun can enumerate providers, models, and auth status through one API contract.
- Provider auth logic is centralized and not duplicated across shells or surfaces.
- Settings can enable or disable advanced provider paths explicitly.
- Subscription, API, OAuth, and local-provider auth all work through one manager.

### Step 5: Replace Tool Execution With One Bosun Tool Orchestrator

**Goal**

Centralize approvals, sandbox policy, retries, truncation, tool telemetry, and execution routing into one Bosun tool orchestrator.

**Primary Bosun files**

- Create:
  - `bosun/agent/tool-orchestrator.mjs`
  - `bosun/agent/tool-registry.mjs`
  - `bosun/agent/tool-approval-manager.mjs`
  - `bosun/agent/tool-network-policy.mjs`
  - `bosun/agent/tool-runtime-context.mjs`
  - `bosun/agent/tool-output-truncation.mjs`
- Integrate:
  - `bosun/agent/internal-harness-runtime.mjs`
  - `bosun/workflow/approval-queue.mjs`
  - `bosun/agent/agent-event-bus.mjs`
  - `bosun/server/ui-server.mjs`

**Donor references**

- `codex-main/codex-rs/core/src/tools/orchestrator.rs`
- `codex-main/codex-rs/core/src/tools/registry.rs`
- `codex-main/codex-rs/core/src/tools/router.rs`
- `codex-main/codex-rs/core/src/tools/parallel.rs`
- `codex-main/codex-rs/core/src/tools/handlers/unified_exec.rs`
- `opencode-dev/opencode-dev/packages/opencode/src/tool/registry.ts`
- `pi-mono-main/packages/coding-agent/src/core/tools/*`
- `openclaude/src/utils/permissions/permissions.ts`

**Implementation prompt**

Create a single Bosun tool orchestrator that owns tool lookup, approval checks, permission explanation, retry policy, sandbox policy, network policy, output truncation, and execution event emission. Port the strong orchestration semantics from `codex-main` and combine them with the composable tool-registry patterns from `opencode-dev` and `pi-mono-main`. No surface, provider adapter, or workflow node should decide tool policy independently after this step. Tool runs must emit structured lifecycle events, approval IDs, retry metadata, truncation metadata, and execution results into the event bus and durable ledger. Preserve Bosun's existing approval queue integration and extend it so approvals can be resolved from UI, TUI, workflow, and Telegram through one common tool-approval manager.

**Completion criteria**

- All tool execution is routed through `tool-orchestrator.mjs`.
- Approval and sandbox decisions are centralized.
- Tool output truncation and retry behavior are consistent across providers and surfaces.
- Tool events are queryable and observable.

### Step 6: Upgrade Bosun Into A First-Class Observability Harness

**Goal**

Make Bosun's event bus and execution ledger the canonical observability spine for sessions, providers, tools, approvals, file changes, and subagents.

**Primary Bosun files**

- Create:
  - `bosun/infra/session-telemetry.mjs`
  - `bosun/infra/trace-export.mjs`
  - `bosun/infra/live-event-projector.mjs`
  - `bosun/infra/runtime-metrics.mjs`
  - `bosun/infra/provider-usage-ledger.mjs`
- Extend:
  - `bosun/agent/agent-event-bus.mjs`
  - `bosun/workflow/execution-ledger.mjs`
  - `bosun/agent/internal-harness-control-plane.mjs`

**Donor references**

- `codex-main/codex-rs/otel/src/events/session_telemetry.rs`
- `codex-main/codex-rs/core/src/memory_trace.rs`
- `codex-main/codex-rs/exec/src/exec_events.rs`
- `openclaude/src/utils/telemetry/sessionTracing.ts`
- `openclaude/src/utils/telemetry/perfettoTracing.ts`
- `opencode-dev/opencode-dev/packages/opencode/src/server/event.ts`
- `opencode-dev/opencode-dev/packages/opencode/src/session/projectors.ts`

**Implementation prompt**

Extend Bosun's event and ledger layers so the harness has full observability by default. Every provider request, stream chunk, tool execution, approval decision, file mutation, patch application, retry, workflow node execution, subagent spawn, subagent completion, Telegram command, and TUI action must be representable in a unified event schema and persisted or projected appropriately. Build live projectors for UI and TUI consumption, durable ledgers for auditing and replay, and structured telemetry exports for metrics and tracing. Preserve Bosun's private-state approach and keep noisy ephemeral data out of git. The goal is not just logs; it is a queryable, end-to-end runtime spine for the gold-standard internal agent harness.

**Completion criteria**

- Bosun emits one canonical event model for the harness.
- Execution ledger schema supports threads, spans, provider turns, tool IDs, approvals, and lineage.
- Live views and historical replay use the same source-of-truth events.
- Cost, token, latency, retry, and tool metrics are queryable.

### Step 7: Unify Workflow Engine Execution Around Harness Sessions

**Goal**

Make the workflow engine a thin orchestration layer over harness sessions instead of a parallel agent implementation.

**Primary Bosun files**

- Refactor:
  - `bosun/workflow/workflow-engine.mjs`
  - `bosun/workflow/workflow-nodes.mjs`
  - `bosun/workflow/workflow-contract.mjs`
  - `bosun/workflow/execution-ledger.mjs`

**Donor references**

- `opencode-dev/opencode-dev/packages/opencode/src/session/processor.ts`
- `codex-main/codex-rs/core/src/agent/control.rs`
- `openclaude/src/utils/swarm/inProcessRunner.ts`

**Implementation prompt**

Refactor Bosun workflows so agent nodes, tool nodes, and approval-aware nodes all use the new harness session manager. Workflow nodes should be able to start sessions, steer active sessions, wait for structured outputs, inspect provider/tool telemetry, spawn subagents, and resolve approvals without bypassing harness semantics. Remove bespoke workflow-only agent pathways. Ensure workflow execution emits the same events and ledger entries as chat and TUI sessions. Support parent-child lineage between workflows and the sessions they create. Make workflow execution deterministic from the perspective of harness APIs, even when providers differ underneath.

**Completion criteria**

- Workflow nodes invoke the harness instead of private agent logic.
- Workflow-triggered sessions use the same thread/session model as chat and TUI.
- Workflow observability is fully aligned with the harness event contract.
- Structured outputs and approvals flow through standard session APIs.

### Step 8: Unify The User Surfaces Around The Harness APIs

**Goal**

Make the web UI, TUI, and Telegram adapters render and control the same live harness state instead of stitching together separate runtime views.

**Primary Bosun files**

- Refactor:
  - `bosun/server/ui-server.mjs`
  - `bosun/tui/app.mjs`
  - `bosun/tui/screens/agents.mjs`
  - `bosun/tui/screens/logs.mjs`
  - `bosun/tui/screens/telemetry.mjs`
  - `bosun/tui/screens/workflows.mjs`
  - `bosun/telegram/telegram-bot.mjs`
  - `bosun/ui/modules/session-api.js`
  - `bosun/ui/modules/agent-events.js`
  - `bosun/ui/modules/streaming.js`

**Donor references**

- `codex-main/codex-rs/tui/src/multi_agents.rs`
- `codex-main/codex-rs/tui/src/chatwidget.rs`
- `codex-main/codex-rs/tui/src/streaming/controller.rs`
- `pi-mono-main/packages/tui/src/*`
- `opencode-dev/opencode-dev/packages/opencode/src/cli/cmd/tui/thread.ts`
- `opencode-dev/opencode-dev/packages/opencode/src/server/routes/session.ts`
- `opencode-dev/opencode-dev/packages/opencode/src/server/routes/event.ts`

**Implementation prompt**

Refactor every Bosun interaction surface so it speaks to the same harness APIs and event streams. The web UI should expose session control, approvals, provider inventory, live exec streams, event tails, and usage summaries through server endpoints backed by the new session manager and observability spine. The TUI should render a live session inspector, subagent tree, provider usage strip, approval queue, logs, workflows, and live exec output without assembling state from incompatible sources. Telegram should be able to start, steer, inspect, and approve harness activity through the same APIs. Remove surface-owned retry logic, provider logic, and session-state transitions.

**Completion criteria**

- UI, TUI, and Telegram all call one harness API layer.
- Session state is consistent across all surfaces.
- Approvals and steering actions work identically everywhere.
- Live telemetry and execution output are visible across surfaces.

### Step 9: Demote Shell Adapters Into Compatibility Shims And Preserve Parity

**Goal**

Shrink Bosun's existing shell/provider wrappers into thin compatibility shims while preserving external behavior during migration.

**Primary Bosun files**

- Refactor or demote:
  - `bosun/shell/codex-shell.mjs`
  - `bosun/shell/claude-shell.mjs`
  - `bosun/shell/copilot-shell.mjs`
  - `bosun/shell/gemini-shell.mjs`
  - `bosun/shell/opencode-shell.mjs`
  - `bosun/shell/opencode-providers.mjs`
- Verify packaging paths that reference harness assets and shell imports

**Donor references**

- `openclaude/src/services/api/codexShim.js`
- `openclaude/src/services/api/openaiShim.ts`
- `openclaude/src/cli/transports/SerialBatchEventUploader.ts`
- `opencode-dev/opencode-dev/packages/opencode/src/provider/provider.ts`

**Implementation prompt**

Convert Bosun's current shell adapters from being de facto provider runtimes into thin compatibility layers over the new provider kernel and harness session manager. Existing shell entrypoints may remain temporarily for backward compatibility, but they must delegate into the canonical Bosun contracts rather than owning their own provider and session logic. Preserve feature parity for existing user flows during the migration. Verify packaging and publish checks for harness runtime assets, especially internal harness modules and shell import paths that Bosun expects to ship. This step is complete only when the shell layer is no longer the source of truth for agent semantics.

**Completion criteria**

- `shell/*` modules are wrappers, not core runtime owners.
- Existing entrypoints still work while using the new harness under the hood.
- Packaging and smoke checks still include required harness artifacts.
- Provider and session behavior are no longer duplicated in shell adapters.

### Step 10: Move The Hot Path To Rust And Finish Performance Hardening

**Goal**

Port only the performance-critical execution and telemetry paths to Rust after the `.mjs` architecture is stable, then validate Bosun under load.

**Primary Bosun files**

- Create:
  - `bosun/native/bosun-unified-exec/Cargo.toml`
  - `bosun/native/bosun-unified-exec/src/main.rs`
  - `bosun/native/bosun-unified-exec/src/process_manager.rs`
  - `bosun/native/bosun-unified-exec/src/head_tail_buffer.rs`
  - `bosun/native/bosun-unified-exec/src/async_watcher.rs`
  - `bosun/native/bosun-unified-exec/src/tool_orchestrator.rs`
  - `bosun/native/bosun-telemetry/Cargo.toml`
  - `bosun/native/bosun-telemetry/src/main.rs`
  - `bosun/native/bosun-telemetry/src/session_telemetry.rs`
  - `bosun/native/bosun-telemetry/src/metrics.rs`
  - `bosun/native/bosun-telemetry/src/export.rs`
- Integrate with:
  - `bosun/agent/tool-orchestrator.mjs`
  - `bosun/agent/agent-pool.mjs`
  - `bosun/infra/session-telemetry.mjs`
  - `bosun/server/ui-server.mjs`
  - `bosun/workflow/workflow-engine.mjs`

**Donor references**

- `codex-main/codex-rs/core/src/unified_exec/process_manager.rs`
- `codex-main/codex-rs/core/src/unified_exec/head_tail_buffer.rs`
- `codex-main/codex-rs/core/src/unified_exec/async_watcher.rs`
- `codex-main/codex-rs/core/src/tools/orchestrator.rs`
- `codex-main/codex-rs/otel/src/events/session_telemetry.rs`
- `openclaude/src/utils/telemetry/sessionTracing.ts`

**Implementation prompt**

After the `.mjs` harness is functionally complete, port the hot execution and telemetry path to Rust. Build a Bosun-native unified-exec runtime that handles process lifecycle, cancellation, buffering, truncation, and backpressure under heavy parallel load. Build a Bosun-native telemetry service that can buffer, aggregate, and export high-frequency events without starving the Node event loop. Integrate both through clean `.mjs` boundaries so Bosun retains fast iteration on orchestration, providers, settings, workflows, UI, and approvals. Finish this step with load validation, failure-injection testing, and operational metrics proving that Bosun remains responsive while running multiple parallel sessions, tools, and subagents across chat, workflow, TUI, and Telegram surfaces.

**Completion criteria**

- Unified exec and telemetry hot paths run through Rust-backed components.
- Node remains the control plane and Rust remains the hot-path engine only.
- Bosun demonstrates improved throughput, buffering, and cancellation behavior under load.
- Performance and reliability validation exists for parallel agent execution.

## Final Recommendation

If Bosun wants a first-class internal harness, the correct move is:

1. Port the `pi-mono` agent loop and provider architecture into Bosun `.mjs`.
2. Rebuild Bosun session and subagent control around Codex-style thread management and telemetry.
3. Use OpenCode's provider discovery, session processor, and tool registry patterns to clean up Bosun's server-facing control plane.
4. Use OpenClaude's permission and transport patterns for durable subscription-backed and remote flows.
5. Move only the hot exec and telemetry path into Rust once the `.mjs` architecture is stable.

That produces one Bosun-native harness, not another wrapper around four incompatible agent runtimes.
