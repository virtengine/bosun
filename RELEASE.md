# Releasing bosun

This document is the release contract for `virtengine/bosun`. It records what a
release is, how one is produced, and the rules that keep the npm version, the git
tag, and the GitHub release from drifting apart.

## What a release is

A bosun release is three objects that must agree on one version:

| Object | Authority |
|---|---|
| npm dist-tag `latest` | **Authoritative.** This is what `npm i -g bosun` and `npx bosun` actually hand a user. |
| git tag `vX.Y.Z` | Created automatically by CI after a successful publish. |
| GitHub release `vX.Y.Z` | Created automatically by CI at the same moment. |

`package.json` `version` is the input to the publish, not a fourth source of
truth — it must equal whatever npm currently reports before a publish is attempted.

If these three ever disagree, npm wins and the release record is brought up to it.
Never move npm backwards to match a stale tag.

## The automated path

`.github/workflows/publish.yaml` is the only supported way to ship. On a push to
`main` that touches `package.json`, source, or the lockfile — or on a manual
`workflow_dispatch` — it:

1. Compares `package.json` `version` against `npm view bosun version`. If the
   local version is not strictly newer, the run is a no-op.
2. Installs, runs the packed-CLI smoke test, and runs the full test suite.
3. Runs `npm publish --access public --provenance` (npm OIDC trusted publishing —
   no long-lived token is stored in this repo).
4. Creates the annotated tag `v$VERSION` and a GitHub release for it.

Steps 1 and 4 are both **idempotent and additive**. An existing tag or an existing
release is left untouched, and an older or equal version never publishes. This is
why a human should not hand-create tags: the guard is in the workflow, and manual
commands bypass it.

`workflow_dispatch` inputs:

- `dry-run` — run everything except the real `npm publish`, tag, and release.
- `force` — publish even when the version is not newer than the registry. Use for
  a re-publish of the same version; understand the consequences first.

## Tag convention — `vX.Y.Z`

All new release tags carry the `v` prefix: `v0.43.1`. This is the same string CI
constructs (`TAG="v$VERSION"`), so a hand-made tag and a CI-made tag are
indistinguishable to consumers.

Legacy exceptions that predate the convention and are **never** to be renamed,
deleted, or replicated:

| Tag | Why it exists |
|---|---|
| `v` | Points at `136a15dd`, an unrelated merge commit. Meaningless as a version. It is only a problem because GitHub's `--generate-notes` picks it as the compare base, producing over-narrow "Full Changelog" ranges. |
| `0.37.0`, `0.42.0` | Un-prefixed semver. Referenced by existing published releases. |

## Hard rules

These are not preferences. Violating any of them has already caused a real
incident in this repository's history.

1. **Never rewrite, move, or delete an existing tag.** Tags are the only immutable
   addresses in a git repo; consumers pin to them. All tagging is additive.
2. **Never force-push a release branch or rewrite pushed history.**
3. **Publishing is a human decision.** Creating the tag and creating the release
   happen inside the same CI step as the npm publish, so *any* human approval that
   governs publishing governs tagging with it. A draft release is cheap; a published
   one is not (it fires watcher notifications, webhooks, and moves the public
   `Latest` marker).

   **Verified caveat (2026-09-27): nothing in GitHub mechanically enforces this.**
   `npm-publish` exists as an environment but carries **zero** protection rules —
   no required reviewers, no wait timer — and branch protection on `main` requires
   only the `Build + Tests` status check. The single act that gates a publish is
   therefore *the merge to `main`*, which then fires `publish.yaml` automatically
   because `package.json` changed. There is no second confirmation. Treat landing
   anything on `main` with a bumped `package.json` as the publish approval itself,
   and note that `develop -> main` is the standing PR that performs it.
4. **npm is hands-off for agents.** Do not `npm publish`, `npm unpublish`,
   `npm deprecate`, or `npm dist-tag add/rm` without explicit human approval.
   Published versions cannot be cleanly removed once they are out.
5. **Do not hand-run `git tag -d` / `git push origin :refs/tags/...`.** A release
   tag that once existed on the remote must never disappear. On 2026-09-24 an
   automated run deleted `v0.42.5` from `origin` via exactly that command, outside
   the card it was working, while the underlying question was still unanswered.
   The commit survived, so the tag was restorable — but a tag on a commit that was
   later garbage-collected would not have been.
6. **Do not tag retroactively without a human decision.** Three npm versions
   (`0.42.5`, `0.42.6`, `0.43.0`) have no tag on `origin`, and they got that way two
   different ways: `0.42.5` *was* tagged and the tag was deleted (see rule 5), while
   `0.42.6` and `0.43.0` were never tagged at all. Backfilling any of them is a
   judgement call about the historical record, not a mechanical fix.

## Known drift, documented rather than silently fixed

The full three-way picture, reproducible with the command in
[Verifying a release](#verifying-a-release):

| Class | Members | Meaning |
|---|---|---|
| npm version, **no** tag, **no** release | `0.42.5`, `0.42.6`, `0.43.0` (recent); ~107 older versions from `0.26.3`–`0.41.10` | No tag **or** release survives on `origin` for any of these — but the three recent members do **not** share a cause, so read this cell per member. `0.42.5` **was** tagged; its tag was deleted from `origin` on 2026-09-24 (rule 5) and the tag object survives locally, so its correct entry is "tag existed and was deleted". `0.42.6` and `0.43.0` were never tagged at all: `0.42.6` is the widest gap (between the newest published release `v0.42.4` and npm `latest`), and `0.43.0` was superseded by `0.43.1` within 48h, so its changes are covered by the `v0.43.1` notes. The older ~107 sit in the same observable state; they are not individually adjudicated here. |
| Tag **and** release, **no** npm version | `v0.42.3` | Released on GitHub but never published to npm. |
| Tag, **no** release | `v0.36.29`, `v0.40.6` | Tagged and on npm, but no GitHub release was created. |
| Tag, no release, not a version | `v` | Legacy; see the tag-convention table above. |

So the invariant "every npm version has a tag and a release" does **not** hold
repo-wide and never has. Six versions do satisfy all three legs — `0.37.0`,
`0.42.0`, `0.42.1`, `0.42.2`, `0.42.4`, `0.43.1` — but they are the manual era, not
evidence of automation: every one of the six tags and all six releases predate the
step PR #533 added on 2026-09-23, `0.37.0`/`0.42.0` even use un-prefixed tags, and
each release is stamped at its own tag's timestamp (the newest, `v0.43.1`, carries
its tagger stamp to the second — 2026-09-18T14:09:51Z, five days before #533
existed). That step, which was meant to enforce the invariant going forward, has
**never executed**: zero npm versions have been published since it merged — the last
publish of any version is `0.43.1` on 2026-05-12 — so there has never been anything
for it to tag, and every `Publish to npm` job since is `skipped`. The invariant is
currently enforced by nothing at all. The three recent gaps above are the ones worth
a human decision because they sit after the newest release (`v0.42.4`).

**Decided 2026-09-27: no retroactive backfill.** None of these are repaired
retroactively, per rule 6. Recorded reasoning follows so the decision is not
re-litigated from scratch.

### Operator decisions on the historical record

On **2026-09-27 10:39Z** the operator (jonathan) directed, in the `#bosun` channel:

> No need to fix, just continue with task completion - instead of fixing an old
> tag/broken changelog link lets push further to get BOSUN stable and release a
> stable 0.43.2 instead?

Read against the two open items of the day, that is a **clear decline** of both
historical repairs — the message names both items, rules out fixing them, and
redirects to a 0.43.2 release instead:

| Item | Disposition |
|---|---|
| Restore the deleted `v0.42.5` tag | **DECLINED.** Not restored. The tag object survives locally and the exact restore is `git push origin 1aa14b71:refs/tags/v0.42.5` — reversible if the owner reverses the call. |
| "Broken" changelog link on published `v0.43.1` | **DECLINED, and the premise was wrong.** `compare/v...v0.43.1` returns HTTP **200**, not 404 (`v` points at `136a15dd`, an ancestor of `v0.43.1`). The real defect is only that the auto-generated range is narrow (789 commits vs 1105 for `v0.42.4...v0.43.1`), driven by `--generate-notes` picking the bare `v` tag as its base. The published body was left untouched. |
| Backfill tags for `0.42.5` / `0.42.6` / `0.43.0` | **DECLINED**, per rule 6 and the direction above. |
| Document the tag convention | **ACTIONED** — this file. |

The tags and releases recorded in this document were all created before the
`gh release create` step existed in CI — `git log -S 'gh release create' --
.github/workflows/publish.yaml` returns exactly one commit, #533 on 2026-09-23 — so
none of them are evidence that the automation works. Its first real test will be
the next publish.

The forward-looking fix for the narrow range is *not* editing release bodies. That
789-commit range was a one-off: it was produced while `v0.43.1` was the release
being created, so `v0.43.1` did not yet exist and the bare `v` tag was the nearest
tagged ancestor. That condition is already gone — `v0.43.1` now descends from `v`
and is an ancestor of any future release, and GitHub picks it as the base. Probed
live on 2026-09-28 with `gh api -X POST repos/virtengine/bosun/releases/generate-notes
-f tag_name=v0.43.2 -f target_commitish=main`, the generated body ends
`compare/v0.43.1...v0.43.2`. No structural change is needed or permitted: making `v`
stop being the nearest tagged ancestor would mean rewriting, moving, or deleting it,
which hard rule 1 and the tag table above both forbid. If an explicit base is wanted
anyway, take the rule-compliant route and name it in CI rather than in history —
pass `--notes-start-tag "v$PREV"` to `gh release create` in `publish.yaml` (the REST
`previous_tag_name` parameter does the same), which pins the compare base without
touching any tag.


## Automated drift check

The invariant above used to be enforced by nothing that runs. `npm run release:drift`
(`tools/release-drift.mjs`) closes that gap: it compares package.json, the tags on
`origin`, the GitHub releases, and the npm `latest` dist-tag, and fails when they
disagree.

```bash
npm run release:drift          # human-readable report
node tools/release-drift.mjs --json
```

Exit codes are the contract:

| Exit | Meaning |
|---|---|
| `0` | all four records agree (informational findings only) |
| `1` | drift detected — reconcile per this document; do **not** publish or delete anything to "fix" it |
| `2` | a probe failed — the verdict is UNKNOWN, never "clean" |

Exit `2` is deliberate and is the whole point of the module. A registry that cannot
be reached hides exactly the drift this check exists to find, so an unreachable npm
or GitHub API is an error, never a silent pass. On Windows the npm probe invokes
`npm-cli.js` through the running node rather than `execFile("npm")`, because npm is
a shim script there and `CreateProcessW` rejects it with `EINVAL`.

Two `info` findings can print on a clean repo, which is why a real repo reports
CLEAN while still printing lines: `tag-without-release` (`v0.36.29`, `v0.40.6` — the
documented historical tail) and `release-staged` (the normal state of `develop`
between a version cut and its publish). Everything else the module emits is an
`error`. Do not hand-maintain that list here — the severity of each code is decided
in `tools/release-drift.mjs`, and `npm test -- tests/release-drift.test.mjs` is what
pins it. "A manifest ahead of npm is informational, not drift" is a decision, not an
oversight: `develop` carries the next version before its publish.

An override such as `--npm-version` replaces that record's probe outright, so the
command can be exercised offline. It is a real override, not a display flag: the
verdict is computed against the value you pass.

## Release checklist

- [ ] `node -p "require('./package.json').version"` is the intended version and is
      strictly greater than `npm view bosun version`.
- [ ] `npm test` is green on `main` (or the commit to be released).
- [ ] CHANGELOG entry written per `CHANGELOG_ENTRY.md`.
- [ ] The change has landed via a PR against `develop` and been integrated into
      `main` — the publish workflow only listens to `main`.
- [ ] Human approval recorded for the publish.
- [ ] After the run: `git ls-remote --tags origin refs/tags/v$VERSION` matches, and
      `gh release view v$VERSION --json isDraft,tagName` shows `isDraft:false`.

## Verifying a release

```bash
npm view bosun version                              # authoritative version
npm view bosun dist-tags --json                     # {"latest":"X.Y.Z"}
git ls-remote --tags origin 'refs/tags/v*'          # tag present on the remote
gh release list --limit 10                          # release present, not a draft
gh api repos/virtengine/bosun/releases/latest --jq .tag_name
```

All five must name the same version. If they do not, stop and reconcile — do not
"fix" it by publishing or by deleting anything.
