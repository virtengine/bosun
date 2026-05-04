# Bosun Internal Harness Module Boundaries

## Permanent core

- `agent/agent-launcher.mjs`
  - Canonical bounded launcher/runtime adapter for SDK selection, slot scheduling, ephemeral thread execution, and legacy retry transport.
- `agent/internal-harness-runtime.mjs`
  - Composition root for harness execution dependencies and canonical session runtime wiring.
- `agent/internal-harness-control-plane.mjs`
  - Durable run metadata, run lineage, artifact compilation, and control-plane state transitions.
- `agent/internal-harness-profile.mjs`
  - Stable profile compiler and profile-level validation.
- `agent/provider-kernel.mjs`
  - Normalized provider interface only.
- `agent/session-manager.mjs`
  - Session lifecycle owner and replay/subagent integration point.
- `agent/thread-registry.mjs`
  - Thread lineage owner.
- `agent/harness/run-contract.mjs`
  - Canonical run verbs and required metadata fields.
- `agent/harness/event-contract.mjs`
  - Canonical internal event vocabulary and required IDs.
- `agent/harness/runtime-config.mjs`
  - Canonical split between profile defaults, provider selection, tool policy, and surface metadata.
- `agent/harness/agent-loop.mjs`
  - Per-run loop facade only.
- `agent/harness/turn-runner.mjs`
  - Per-turn execution path through provider session plus tool runner.
- `agent/harness/tool-runner.mjs`
  - Tool execution bridge through the tool orchestrator.
- `agent/harness/steering-queue.mjs`
  - Pending operator interventions.
- `agent/harness/followup-queue.mjs`
  - Pending follow-up work.
- `agent/harness/session-state.mjs`
  - In-memory harness session state shape.

## Transitional adapters

- `agent/primary-agent.mjs`
  - Compatibility facade for primary interactive entrypoints.
- `agent/agent-pool.mjs`
  - Compatibility facade that re-exports launcher and canonical harness/session entrypoints.
- `agent/harness-agent-service.mjs`
  - Compatibility bridge that routes task execution into pooled agent services.

## Explicit dependency direction

- Surfaces (`server/*`, `telegram/*`, `ui/*`, workflow callers) may depend on `primary-agent.mjs`, `agent-pool.mjs`, or canonical harness/session modules during migration, but new lifecycle logic must land in the permanent core.
- `primary-agent.mjs`, `agent-pool.mjs`, and `agent-launcher.mjs` may call into `internal-harness-runtime.mjs`, `session-manager.mjs`, `thread-registry.mjs`, and `provider-kernel.mjs`.
- `agent-launcher.mjs` may own SDK launch transport, slot scheduling, and legacy retry transport, but it must not own lifecycle state, lineage, replay state, or harness contracts.
- `provider-kernel.mjs` must not depend on workflow, TUI, Telegram, or surface-specific modules.
- `session-manager.mjs` and `thread-registry.mjs` may consume harness contracts, but surfaces must not bypass them to manage lineage directly.
- `turn-runner.mjs` may consume provider and tool contracts, but it must not own session/control-plane policy.

## Forbidden lifecycle owners

- `agent/primary-agent.mjs`
- `agent/agent-pool.mjs`
- `shell/*`
- `server/*`
- `workflow/*`
- `ui/*`
- `telegram/*`

These modules may adapt or project harness behavior, but they are forbidden from becoming alternate owners of:

- session lifecycle state
- thread lineage
- harness run contracts
- harness event schema
- turn orchestration policy
- control-plane transitions
