# Provider Boundaries

## Canonical Core

- `agent/provider-kernel.mjs` is the only supported provider execution entrypoint.
- `agent/provider-registry.mjs` is the authoritative provider inventory, selection, enablement, and default-resolution layer.
- `agent/provider-session.mjs` owns the normalized provider session contract consumed by the harness.
- `agent/provider-auth-manager.mjs`, `agent/provider-model-catalog.mjs`, and `agent/provider-capabilities.mjs` provide normalized auth, catalog, and capability metadata for the registry.
- `agent/provider-message-transform.mjs` plus `agent/providers/provider-stream-normalizer.mjs` and `agent/providers/provider-usage-normalizer.mjs` own Bosun-native stream and usage normalization.

## Provider-Specific Modules

- Only `agent/providers/*.mjs` and `agent/auth/*.mjs` may encode provider-specific quirks, env hints, auth setting resolution, transport metadata, or model aliases.
- Provider-specific modules must not own session lifecycle, workflow semantics, tool policy, approval semantics, or surface behavior.

## Transitional Adapters

- `shell/codex-shell.mjs`, `shell/claude-shell.mjs`, `shell/opencode-shell.mjs`, `shell/copilot-shell.mjs`, and `shell/gemini-shell.mjs` are transitional transport adapters only.
- Shell modules may keep runtime-process management and SDK/CLI bridging, but they must not become authoritative provider catalogs, auth interpreters, or stream/usage normalizers.
- `shell/opencode-providers.mjs` remains a compatibility wrapper only and must delegate into agent-owned provider discovery code.

## Forbidden Ownership

- Surfaces under `server/`, `workflow/`, `telegram/`, `ui/`, and `tui/` must consume normalized provider contracts and registry output only.
- No module outside `agent/` may define a second provider catalog, default-provider resolver, or provider-session contract.
