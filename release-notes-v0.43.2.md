# bosun v0.43.2

A stability release. Every change in it fixes a path that failed *silently* —
where bosun reported success while the work underneath had not happened, or
where configuration was present and quietly not read.

## What was broken

The OpenCode executor had four independent ways to look healthy while being
unusable:

1. **A failed run was reported as a success.** The shell looked at the exit
   code in isolation and discarded the result payload, so an agent that errored
   out closed its task as green. The monitor loop and the board both saw a pass.
2. **The CLI binary often could not be found at all.** The shell spawned a bare
   `opencode`, which does not resolve on Windows (npm ships only `.sh`/`.cmd`/
   `.ps1` shims). The resulting error was `fetch failed`, which points at a port
   or a network rather than at a missing binary.
3. **A config that could not be parsed was ignored without a word.** Resolution
   fell through to defaults, which then failed at call time with an error that
   bore no relation to the actual cause.
4. **The agent-SDK primary was not honoured.** When the agent SDK was the
   configured primary executor, the shell still drove the CLI path.

Two further traps are now covered by tests: a 1.x SDK against a 2.x CLI waits out
its startup timeout because the readiness banner changed shape, and a
`bosun.config.json` sitting in the repo root instead of `.bosun/` is read by
nothing.

## What changed

- `shell/opencode-result.mjs` (new) — derives the outcome from the result
  payload as well as the exit code, and reports the error rather than the
  success.
- `shell/opencode-binary.mjs` (new) — resolves the binary from an explicit
  config value, then the agent SDK, then `PATH`, and says which one it used.
- `shell/opencode-sdk-compat.mjs` (new) — the compatibility shim between SDK
  shapes, so an SDK minor bump cannot silently change result parsing.
- `shell/opencode-shell.mjs`, `agent/agent-sdk.mjs`, `config/config.mjs`,
  `shell/codex-config.mjs` — honour the SDK primary, warn on a repo-root config
  instead of ignoring it, and surface an unresolvable config.
- **`@opencode-ai/sdk` is now pinned to `^1.18.32`** rather than `latest`. The
  floating tag made the build non-reproducible and could pull a breaking SDK
  change into any publish.
- 339 lines of new tests across `tests/opencode-executor-wiring.test.mjs` and
  `tests/opencode-result.test.mjs`.

## Upgrading

No configuration changes are required. If you set `PRIMARY_AGENT=opencode-sdk`,
bosun previously ignored it and fell back to `codex`; it is now honoured. If you
were relying on that silent fallback, set `PRIMARY_AGENT=codex` explicitly.

## Known limitation in this release

The corrected semver gate (`tools/publish-version-gate.mjs`, added in #548) is
**not yet wired into `publish.yaml`**. Wiring it requires a commit that touches
`.github/workflows/`, and the automation token in use lacks the `workflow`
scope, so the push is rejected. `publish.yaml` therefore still runs the older
inline `split('.')` version comparison. For this release that is harmless — the
gate handles a plain `0.43.1 → 0.43.2` bump correctly — but a *prerelease* bump
(for example `0.43.3-beta.1`) would still be silently skipped. Fixing it needs a
token with the `workflow` scope.

**Full Changelog**: https://github.com/virtengine/bosun/compare/v0.43.1...v0.43.2
