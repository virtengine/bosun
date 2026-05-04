# Shell Compatibility Boundaries

Step 8 freezes shell ownership to compatibility-only concerns.

## Canonical owners

- `agent/provider-kernel.mjs`
  Owns provider selection, alias normalization, and provider config resolution.
- `agent/session-manager.mjs`
  Owns shell session lifecycle, session activation, and execution registration.
- `agent/tool-orchestrator.mjs`
  Owns direct compatibility-tool execution when a shell path must invoke Bosun tools.
- `infra/session-telemetry.mjs`
  Owns canonical shell-originated lifecycle, stream, and tool observability events.

## Shell responsibilities that remain

- Translate SDK or CLI transport setup into Bosun runtime calls.
- Preserve legacy entrypoint names and lightweight session switching affordances.
- Map provider-native stream messages into Bosun compatibility stream events.
- Keep temporary local resume hints only when the upstream SDK requires them.

## Responsibilities that must not remain in shell adapters

- Authoritative provider inventory or provider default selection.
- Authoritative session lifecycle state machines.
- Shell-local approval or tool policy engines.
- Private event schemas used as the source of truth for observability.
- Long-term runtime ownership outside `shell-session-compat.mjs`.

## Transitional modules

- `shell/codex-shell.mjs`
- `shell/claude-shell.mjs`
- `shell/opencode-shell.mjs`
- `shell/copilot-shell.mjs`
- `shell/gemini-shell.mjs`
- `shell/opencode-providers.mjs`

These files remain as transport shims only. `shell/shell-session-compat.mjs` is the narrow compatibility bridge.

## Compatibility contract

- Legacy shell entrypoints keep their public session names, but those names map into canonical `sessionId` records owned by `agent/session-manager.mjs`.
- Provider-native thread or transport identifiers map into canonical `threadId` metadata only. Shell adapters must not treat those IDs as separate authoritative session identities.
- Shell-originated lifecycle transitions map to canonical telemetry/event types through `shell-session-compat.mjs`:
  - `beginTurn` -> `shell.session.running`
  - `completeTurn` -> `shell.session.completed`
  - `failTurn` -> `shell.session.failed`
  - `abortTurn` -> `shell.session.aborted`
- Shell-originated stream events map to `shell.stream.event` and preserve the raw provider event type in metadata for observability and lineage.
- Shell-originated tool events map to `shell.tool.event` and must enter the canonical tool orchestrator path when a shell needs Bosun-managed tools.
- Shell adapter failures must surface as normalized session/tool/provider errors via canonical telemetry fields (`status`, `error`, `providerId`, `toolId`, `toolName`) rather than shell-private error schemas.

## Migration table

| Shell module | Previous runtime ownership | Canonical owner now |
| --- | --- | --- |
| `codex-shell.mjs` | Shell-local session status updates and stream event isolation | `shell-session-compat.mjs` + `session-manager.mjs` + `session-telemetry.mjs` |
| `claude-shell.mjs` | Shell-local session status updates and stream event isolation | `shell-session-compat.mjs` + `session-manager.mjs` + `session-telemetry.mjs` |
| `opencode-shell.mjs` | Shell-local session status updates, provider selection drift, stream event isolation | `shell-session-compat.mjs` + `provider-kernel.mjs` + `session-manager.mjs` + `session-telemetry.mjs` |
| `copilot-shell.mjs` | Shell-local session status updates and stream event isolation | `shell-session-compat.mjs` + `session-manager.mjs` + `session-telemetry.mjs` |
| `gemini-shell.mjs` | Shell-local session status updates and transport-owned runtime state | `shell-session-compat.mjs` + `session-manager.mjs` + `session-telemetry.mjs` |
| `opencode-providers.mjs` | Potential parallel provider inventory | `agent/provider-runtime-discovery.mjs` and provider registry paths |
