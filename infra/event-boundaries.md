# Bosun Observability Event Boundaries

## Canonical Event Owner

- `infra/event-schema.mjs`
  - Owns canonical event normalization, identifier fields, category rules, and payload lifting.

## Canonical Ingress And Coordination

- `agent/agent-event-bus.mjs`
  - May emit runtime events.
  - Must normalize bus-originated events through `infra/event-schema.mjs`.
- `infra/session-telemetry.mjs`
  - Owns canonical ingestion, private JSONL persistence, metrics/provider/projector fan-out, and summary APIs.
- `workflow/execution-ledger.mjs`
  - May emit workflow-linked canonical events into the observability spine.
- `agent/internal-harness-control-plane.mjs`
  - May emit harness-run canonical events into the observability spine.

## Durable Persistence Owners

- `lib/state-ledger-sqlite.mjs`
  - Owns durable SQLite-backed workflow, harness, approval, task-trace, and audit persistence.
- `infra/session-telemetry-runtime.mjs`
  - Owns the private append-only JSONL event journal under `.bosun/.cache/harness/observability/`.

## Projection Consumers

- `infra/live-event-projector.mjs`
  - Live derived state only.
- `infra/session-projection-store.mjs`
  - Session/run lineage projections only.
- `infra/approval-projection-store.mjs`
  - Approval-chain projections only.
- `infra/subagent-projection-store.mjs`
  - Subagent lineage projections only.
- `infra/runtime-metrics.mjs`
  - Aggregate metrics consumer only.
- `infra/provider-usage-ledger.mjs`
  - Provider/model usage consumer only.
- `infra/trace-export.mjs`
  - Trace-export consumer only.
- `infra/replay-reader.mjs`
  - Historical reconstruction consumer only.

## Forbidden Ownership

- UI, TUI, Telegram, and workflow surfaces
  - Must not invent private event schemas for authoritative runtime state.
- Projection stores
  - Must not become primary mutation owners.
- Provider/tool/surface modules
  - Must not persist competing event ledgers outside the canonical spine and state ledger.
