# Bosun Session And Lifecycle Boundaries

## Canonical Mutation Owners

- `agent/session-manager.mjs`
  - Owns session creation, continuation, resume, replay attachment, cancellation, completion, and lifecycle transitions.
- `agent/thread-registry.mjs`
  - Owns thread identity, root lineage, parent-child attachment, persisted thread resume records, and thread status updates.
- `agent/subagent-control.mjs`
  - Owns subagent spawn records, wait semantics, completion propagation, and parent-child spawn inspection.
- `agent/session-replay.mjs`
  - Owns replay snapshots, replay cursors, and resumable state assembly.
- `agent/session-snapshot-store.mjs`
  - Owns durable snapshot/event persistence for replay state.

## Query-Only Lifecycle Views

- `agent/lineage-graph.mjs`
  - Query layer for lineage trees, descendants, siblings, and thread lineage.
- Surfaces, workflows, UI, Telegram, and shell adapters
  - May query lifecycle state through session-manager outputs and query helpers.
  - Must not mutate lifecycle state directly.

## Transitional Facades Only

- `agent/primary-agent.mjs`
  - May route primary-session requests into session-manager and shell/session compat layers.
  - Must not own lifecycle state machines, replay rules, or lineage rules.
- `agent/agent-launcher.mjs`
  - May own bounded executor launch transport, SDK fallback, and slot scheduling.
  - Must not own the long-term session model, lineage graph, or replay semantics.
- `agent/agent-pool.mjs`
  - Thin compatibility facade over `agent-launcher.mjs` and canonical session/thread helpers.
  - Must not reintroduce hidden lifecycle rules or direct launcher policy.
- `shell/shell-session-compat.mjs`
  - Transitional shell facade that forwards session activation and execution metadata into `session-manager.mjs`.
  - Must not define alternate replay, lineage, or lifecycle behavior.

## Forbidden Ownership

- `shell/*`
  - No canonical session or replay mutation.
- `server/*`
  - No ad hoc session graph mutation outside session-manager APIs.
- `workflow/*`
  - No alternate lifecycle store or replay model.
- `telegram/*`, `ui/*`, `tui/*`, `desktop/*`
  - No direct mutation of thread lineage or subagent wait/completion records.
