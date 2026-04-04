# Bosun Monitor Session — 04 Apr 2026 (Hourly Run 2)

**Status: warning → recovering**

---

## Runtime State

- Daemon: PID 22632, active
- Branch: `bosun/codex-self-improvement-loop-commits` — pushed 2 fix commits to origin
- Config: `.bosun`, repo-root `.`
- Monitor log: `.bosun/logs/monitor.log`
- Task batch: **8/8 dispatched** at 17:47Z (was 0/0 for multiple prior cycles)

---

## Task Stats (at session close)

| Status   | Count |
|----------|-------|
| done     | 104 (unchanged — no new merges this session) |
| inprogress | 3+ (newly dispatched) |
| blocked  | 28 (was 36 — 8 reset to todo) |
| todo     | 7 stubs + 8 newly eligible |
| draft    | 10 |
| cancelled| 3 |

---

## Root Causes Addressed This Session

### Bug 1 (continued from session 1): `ensureBosunLabels` in `action.create_pr`
- **Symptom**: Bosun-created PRs missing `bosun-pr-bosun-created` label → PR watchdog classifies all as `public_observation_only`
- **Fix**: Added `ensureBosunLabels()` helper in `workflow/workflow-nodes/actions.mjs` that calls `gh label create --force` before any PR label operations. Called before `gh pr create` in main path.
- **Commit**: `32446039`
- **Note**: The stash lost the initial implementation; fix was re-applied cleanly this session.

### Bug 2 (new): `bosun-pr-attach.yml` branch pattern detection
- **Fix**: Added branch name pattern check (`task/HEX-slug`) and body markers to `isBosunCreated` detection in the GitHub Action.
- **Commit**: same as above

### Bug 3 (new): Mutually exclusive security/generic CI failure classification
- **Symptom**: PR #473 has both CodeQL failure (security) AND Build+Tests failures (generic). The `else if (hasSecurityFail)` branch is taken exclusively, so `ciFailures=[]`. The security path dispatched no agent (no open CodeQL alerts). Result: `generic-fix-needed=false`, PR #473 silently dropped every cycle.
- **Fix**: In `fetch-and-classify` in `workflow-templates/github.mjs`, after pushing to `securityFailures`, also push non-security failed checks to `ciFailures` with `alsoInSecurityFailures: true` flag.
- **Commit**: `00da09b5`
- **Evidence**: Log at 17:35Z showed `fix-needed=true`, `security-fix-needed=true`, `dispatch-security-fix-agents SKIPPED`, `generic-fix-needed=false`

### Bug 4 (new): 0-attempt tasks in blocked state
- **Symptom**: 8 tasks were `blocked` with 0 attempts — stuck permanently, never run
- **Root cause**: Unknown (possibly set by stale cleanup or dependency logic)
- **Fix**: Reset all 8 to `todo` via `bosun task update`. All 8 dispatched on next batch cycle.
- **Tasks reset**: `684e3621`, `52840c3e`, `f82209df`, `a91b95b7`, `f41ba544`, `4eb8ae88`, `98f07c2c`, `a6a0198e`
- **Note**: This is a 1-per-session cleanup action, not a durable fix. Root cause for why tasks ended up blocked with 0 attempts should be investigated.

---

## PR #473 Status

- Labels: now has `bosun-pr-bosun-created` ✓ and `bosun-needs-fix` ✓
- CI failures: Build+Tests FAIL, Existing E2E Suite FAIL, Node-Type Coverage Gate FAIL, All Workflow Tests Pass FAIL, CodeQL FAIL
- Expected behavior: next PR watchdog cycle should see `ciFailures=[473]` AND `securityFailures=[473]` and dispatch a fix agent

---

## Commits Made

1. `32446039` — fix: ensure Bosun labels exist in repo before PR creation (+ bosun-pr-attach.yml belt-and-suspenders + fix cli-task-routing test)
2. `00da09b5` — fix: push PR to ciFailures when it has both security and non-security CI failures

Both pushed to origin/bosun/codex-self-improvement-loop-commits.

---

## Validation

- `node --check workflow/workflow-nodes/actions.mjs` ✓ Syntax OK
- `node --check workflow-templates/github.mjs` ✓ Syntax OK
- `npm run build` ✓ Pass
- `tests/workflow-templates.test.mjs` ✓ 158 passed
- `tests/github-pr-trust-regression.test.mjs` ✓ 2 passed
- `tests/cli-task-routing.test.mjs` ✓ 3 passed (fixed assertion to match `resolvedConfigDirArg`)

---

## Current Blockers

1. **No new merges since 2026-03-31** — throughput still 0. PR #473 is the only open PR and needs the fix agent to actually fix the CI failures (Build+Tests). This is now unblocked by the ciFailures fix.

2. **0-attempt blocked task root cause unknown** — why did 8 tasks end up blocked with 0 attempts? Possible sources: (a) task creation logic setting status incorrectly, (b) planner or importer setting status incorrectly, (c) dependency logic blocking tasks without dispatching. Investigate `task-store.mjs` creation path and planner materialization.

3. **Codex API 500 transient issue** — copilot fallback is active; new tasks will use copilot

---

## Handoff for Next Session

1. **Check if PR #473 got a fix agent dispatched** — look for `dispatch-fix-agents` with PR #473 in the log
2. **Monitor if any of the 8 dispatched tasks complete successfully** — if they all block again with 0 tokens, the agent execution path itself is broken
3. **Investigate 0-attempt blocked task root cause** — check `task-store.mjs` `createTask` and `materializeTask` for status assignment. Look for any path that creates tasks in `blocked` status without going through attempt tracking.
4. **PR merge throughput** — if PR #473 fix agent runs and CI passes, check if auto-merge fires correctly. Expected next merge: PR #473.
