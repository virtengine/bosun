# Internal Harness Native Boundary

## Scope

Step 9 hardens Bosun's native layer into a narrow acceleration boundary. The
canonical Node bridge is [`lib/hot-path-runtime.mjs`](../lib/hot-path-runtime.mjs).
Rust exists only to accelerate the hot path. Node `.mjs` remains the control
plane.

## Canonical Owners

### `lib/hot-path-runtime.mjs`

- Owns native capability detection.
- Owns stdio JSONL transport selection.
- Owns safe fallback behavior when native services are unavailable.
- Owns normalized request and response mapping for:
  - `truncate_output`
  - `buffer_items`
  - `run_process`
  - `cancel_process`
  - `watch_paths`
  - `append_events`
  - `export_trace`
  - `flush`
  - `reset`
- Owns operator status reporting for exec and telemetry services.

### `native/bosun-unified-exec`

- Owns subprocess lifecycle.
- Owns stdout/stderr head-tail buffering and truncation helpers.
- Owns cancellation responsiveness and timeout termination.
- Owns narrow file-watch polling for hot-path invalidation/watcher needs.
- Must not own provider logic, workflow semantics, approval rules, settings,
  session models, or UI behavior.

### `native/bosun-telemetry`

- Owns high-frequency event ingestion buffering.
- Owns bounded in-memory retention for mirrored canonical events.
- Owns trace export acceleration over canonical event payloads.
- Must not define a competing event schema, projection model, or business-logic
  layer.

## Forbidden In Rust

- Provider selection and provider fallback policy.
- Workflow composition or workflow-node ownership.
- Approval decisions or approval persistence policy.
- Session/thread/subagent lifecycle semantics.
- Settings resolution.
- Web, TUI, Telegram, or chat surface APIs.

## Bridge Contract

The bridge protocol is newline-delimited JSON over stdio.

Every request must include:

- `id`
- `command`

Every response returns:

- `id`
- `ok`
- `protocolVersion`
- `service`
- `version`

### Exec Commands

- `status`
  Returns process manager and watcher capability/status snapshots.
- `truncate_output`
  Accepts `output` and `truncation`.
- `buffer_items`
  Accepts `items` and `limits`.
- `run_process`
  Accepts `processId`, `command`, `args`, `cwd`, `env`, `stdin`,
  `timeoutMs`, `maxBufferBytes`, `tailBufferBytes`.
- `cancel_process`
  Accepts `processId`.
- `watch_paths`
  Accepts `paths`, `timeoutMs`, `pollMs`.

### Telemetry Commands

- `status`
  Returns queue and retention counters.
- `append_events`
  Accepts canonical Bosun events plus optional `maxInMemoryEvents`.
- `export_trace`
  Accepts the same filter keys used by the canonical observability spine.
- `flush`
  Confirms ingestion has drained into the in-memory native store.
- `reset`
  Clears native mirrored state for tests and controlled resets.

## Fallback Rules

- If the native binary is missing or disabled, `hot-path-runtime.mjs` falls back
  to in-process JavaScript behavior.
- Fallback must preserve contract shape for callers.
- Fallback must keep Bosun correct, even if less performant.
- Higher layers must never call native binaries directly.

## Validation Contract

### Throughput

- Mixed telemetry ingestion throughput from `npm run bench:harness-hotpath`.
- Session throughput from `npm run bench:harness:load`.

### Cancellation

- Process cancellation and timeout behavior covered by focused hot-path tests.
- Load-bench cancellation latency reported in `bench/harness-load-bench.mjs`.

### Stream Responsiveness

- Head-tail buffer retention and truncation correctness proven by focused tests.
- Watch-path change detection and timeout behavior proven by focused tests.

### Telemetry Compatibility

- Native export must preserve the canonical Chrome-trace shape.
- Replay/live projections remain derived from the canonical Node event schema.
- Native telemetry is a mirror and accelerator, not the source of truth.

## Remaining `.mjs` Responsibilities

- Session lifecycle and lineage ownership.
- Provider/tool/approval/workflow control-plane behavior.
- Canonical event normalization.
- Projection stores and live-view semantics.
- Surface APIs for server, TUI, web UI, and Telegram.
