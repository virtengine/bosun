export const PROJECTION_CONTRACT_SCHEMA_VERSION = 1;

export function createProjectionContract() {
  return {
    schemaVersion: PROJECTION_CONTRACT_SCHEMA_VERSION,
    kind: "bosun-projection-contract",
    liveOnlyCaches: [
      "infra/live-event-projector.mjs:recentEvents",
      "infra/runtime-metrics.mjs",
      "infra/provider-usage-ledger.mjs",
    ],
    durableStores: [
      "lib/state-ledger-sqlite.mjs:workflow_events",
      "lib/state-ledger-sqlite.mjs:harness_events",
      "infra/session-telemetry-runtime.mjs:events.jsonl",
    ],
    projectionStores: [
      "infra/session-projection-store.mjs",
      "infra/approval-projection-store.mjs",
      "infra/subagent-projection-store.mjs",
    ],
    rebuildRule: "All live and replay views must be rebuilt solely from canonical events normalized by infra/event-schema.mjs.",
    persistenceRule: "SQLite is the durable query substrate; JSONL is the private append-only event journal for replay and convergence checks.",
  };
}

export default createProjectionContract;
