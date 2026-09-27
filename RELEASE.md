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
4. **npm is hands-off for agents.** Do not `npm publish`, `npm unpublish`,
   `npm deprecate`, or `npm dist-tag add/rm` without explicit human approval.
   Published versions cannot be cleanly removed once they are out.
5. **Do not hand-run `git tag -d` / `git push origin :refs/tags/...`.** A release
   tag that once existed on the remote must never disappear. On 2026-09-24 an
   automated run deleted `v0.42.5` from `origin` via exactly that command, outside
   the card it was working, while the underlying question was still unanswered.
   The commit survived, so the tag was restorable — but a tag on a commit that was
   later garbage-collected would not have been.
6. **Do not tag retroactively without a human decision.** Several npm versions
   (`0.42.5`, `0.42.6`, `0.43.0`) were published without a corresponding tag.
   Backfilling them is a judgement call about the historical record, not a
   mechanical fix.

## Known drift, documented rather than silently fixed

As of 2026-09-27 these npm versions have **no** git tag and **no** GitHub release:

| npm version | Published | Note |
|---|---|---|
| `0.42.5` | 2026-03-24 | Tag existed and was deleted; see rule 5. |
| `0.42.6` | 2026-03-27 | Widest gap — sits between the newest published release `v0.42.4` and npm `latest`. |
| `0.43.0` | 2026-05-10 | Superseded by `0.43.1` within 48h; its changes are covered by the `v0.43.1` notes. |

`v0.42.3` has a GitHub release but no corresponding npm version — the mirror-image
asymmetry. None of this is repaired retroactively without an explicit decision, per
rule 6.

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

All four must name the same version. If they do not, stop and reconcile — do not
"fix" it by publishing or by deleting anything.
