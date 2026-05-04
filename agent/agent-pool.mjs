/**
 * agent-pool.mjs — Compatibility facade for legacy pool/thread entrypoints
 *
 * Canonical architecture note:
 * `agent-launcher.mjs` owns the bounded launcher/runtime transport surface.
 * `session-manager.mjs`, `thread-registry.mjs`, `subagent-control.mjs`, and
 * `agent/harness/*` remain the canonical lifecycle and harness owners.
 *
 * This file must stay a thin compatibility facade only.
 */

export * from "./agent-launcher.mjs";
