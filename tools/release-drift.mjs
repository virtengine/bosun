#!/usr/bin/env node

/**
 * release-drift.mjs — decides whether bosun's release records agree.
 *
 * `RELEASE.md` names three objects that a release must reconcile (npm, git tag,
 * GitHub release) and documents a long tail of historical disagreement. What it
 * did NOT have is anything that *runs*. The drift that matters is not the
 * documented history — it is a new disagreement appearing after a publish, and
 * nothing reported that. Measured 2026-09-29: GitHub release `v0.43.1` existed
 * while its git tag `v0.43.1` did **not** exist on `origin`, and no automation
 * noticed. The published library was ahead of its own release record.
 *
 * This module is the single decision point for that question. It compares four
 * records and returns findings with an explicit severity, so both a human and a
 * scheduled job read the same verdict:
 *
 *   | record            | authority                                    |
 *   |-------------------|----------------------------------------------|
 *   | npm dist-tag      | authoritative (what a user actually installs) |
 *   | git tag `vX.Y.Z`  | immutable address                            |
 *   | GitHub release    | the public record                            |
 *   | package.json      | the *input* to the next publish, not truth   |
 *
 * The gate is deliberately FAIL-CLOSED. A probe that could not reach npm or the
 * GitHub API is NOT treated as "no drift": an unreachable registry hides exactly
 * the drift this module exists to find, so an unavailable probe is an `error`
 * and the process exits 2. There is no path where a failed probe yields exit 0.
 *
 * Exit codes:
 *   0  all four records agree (informational findings only)
 *   1  drift detected (at least one `error` finding)
 *   2  a probe failed — the verdict is UNKNOWN, never "clean"
 *
 * Usage:
 *   node tools/release-drift.mjs                 # human-readable report
 *   node tools/release-drift.mjs --json          # machine-readable
 *   node tools/release-drift.mjs --repo x/y --npm-version 1.2.3   # offline
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Sentinel for "the probe could not produce a value". Never a real version. */
export const PROBE_FAILED = "probe-failed";

const SEVERITY_ERROR = "error";
const SEVERITY_INFO = "info";

export const DEFAULT_REPO = "virtengine/bosun";

/**
 * The release-tag prefix this repo's pipeline concatenates onto a version to
 * build a tag name (`commit-tag` and `gh release create` both do `"v" + version`,
 * see workflow-templates/ci-cd.mjs). Named once so `versionFromTag` and
 * `classifyTagName` cannot drift apart on what "a release tag" means.
 */
const RELEASE_TAG_PREFIX = "v";

/**
 * Parse a version, tolerating a leading `v` (tags carry it, npm does not).
 * Returns null for anything that is not `[v]MAJOR.MINOR.PATCH[-pre]`, so junk
 * is surfaced as a finding rather than coerced into an ordering.
 */
export function parseVersion(value) {
  if (typeof value !== "string") return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split("."),
  };
}

function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // a release outranks a prerelease
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      const diff = Number(left) - Number(right);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/** Semver precedence. Returns -1/0/1, or throws on an unparseable operand. */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left) throw new TypeError(`unparseable version: ${JSON.stringify(a)}`);
  if (!right) throw new TypeError(`unparseable version: ${JSON.stringify(b)}`);
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

/**
 * Normalise a tag name to its version, or null if it is not a version tag.
 *
 * Only `vX.Y.Z` is a release tag. A bare `X.Y.Z` (the two live strays `0.37.0`
 * and `0.42.0`) is a MALFORMED tag: returning null for it made it invisible in
 * BOTH directions — `tag-without-release` skipped it, and the summary's
 * `/^v\d/` filter hid it from the report — so the tool that exists to find
 * tag/release disagreement could not see that two of its own tags are
 * malformed. `classifyTagName` keeps the "is it a release tag?" decision and
 * this helper stays the "normalise if it is" one.
 */
function versionFromTag(tag) {
  if (typeof tag !== "string" || !tag.startsWith(RELEASE_TAG_PREFIX)) return null;
  const parsed = parseVersion(tag);
  if (!parsed) return null;
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

/**
 * Classify a tag name into the three cases the report has to keep distinct:
 *   - `release`  : `vX.Y.Z[-pre]` — a tag this repo's workflow creates.
 *   - `malformed`: looks like a version but is not in release form
 *                  (`0.37.0`, `0.42.0`, `v`, `1.2`, `v1.2.3.4`). Reported at
 *                  info level: a stray malformed tag is worth seeing, and it is
 *                  not evidence that npm, the tag and the release record
 *                  disagree, so it must never fail the gate. `v` is in this
 *                  bucket, not `other` — see the branch below.
 *   - `other`    : not a version at all (`latest`, `nightly`, work tags).
 */
export function classifyTagName(tag) {
  if (typeof tag !== "string" || tag.trim() === "") return "other";
  if (versionFromTag(tag) !== null) return "release";
  // A bare `v` — the release prefix with the version missing — is MALFORMED,
  // not "other". It is the exact ref this repo's own release pipeline creates
  // when version resolution yields "": `commit-tag` and `gh release create`
  // both build the name by concatenating `"v" + version` (see
  // workflow-templates/ci-cd.mjs), and that produced `refs/tags/v` on the real
  // remote, which a human had to delete by hand on 2026-09-29. Classifying it
  // "other" made the gate blind to the one ref it most needed to see: `other`
  // is skipped by BOTH the `tag-without-release` loop (:208) and the
  // `malformed-tag` loop (:223), so the tag that this tool exists to surface
  // produced NO finding at all. A prefix-only tag carries no digit, so the
  // digit test below cannot reach it.
  if (tag.trim() === RELEASE_TAG_PREFIX) return "malformed";
  // A tag that is *nearly* a version is more likely a typo'd release tag than
  // an intentional work tag, so it is surfaced. The shape is deliberately
  // loose (any digit, any punctuation) — the point is to see it, not to accept
  // it; `malformed` never becomes a version anywhere in this module.
  return /\d/.test(tag) ? "malformed" : "other";
}

/**
 * Compare the four records and return findings.
 *
 * @param {object} state
 * @param {string|null|typeof PROBE_FAILED} state.manifest  package.json version
 * @param {string[]|typeof PROBE_FAILED}    state.tags      tag names on origin
 * @param {Array<{tag_name:string,isDraft:boolean}>|typeof PROBE_FAILED} state.releases
 * @param {string|null|typeof PROBE_FAILED} state.npmVersion
 * @returns {{ ok:boolean, exitCode:number, findings:Array<{code:string,severity:string,detail:string}> }}
 */
export function classifyReleaseState(state) {
  const findings = [];
  const error = (code, detail) => findings.push({ code, severity: SEVERITY_ERROR, detail });
  const info = (code, detail) => findings.push({ code, severity: SEVERITY_INFO, detail });

  // A probe that did not return is UNKNOWN, not clean. Bail before comparing,
  // because every downstream comparison would be against a phantom value.
  for (const [name, value] of [
    ["package.json", state.manifest],
    ["git tags", state.tags],
    ["GitHub releases", state.releases],
    ["npm", state.npmVersion],
  ]) {
    if (value === PROBE_FAILED) {
      error(
        "probe-failed",
        `the ${name} probe did not return a value; drift is UNKNOWN, not absent`,
      );
    }
  }
  if (findings.length > 0) {
    return { ok: false, exitCode: 2, findings };
  }

  const releases = state.releases;
  const tags = state.tags;

  // --- Draft releases. Class of the real 2026-03-23 incident: v0.42.5 sat as a
  // draft with a publishedAt, on a URL that resolved, for months.
  for (const release of releases) {
    if (release.isDraft) {
      error(
        "draft-release",
        `release ${release.tag_name} is still a DRAFT — it is not a published record`,
      );
    }
  }

  // --- Release present, tag absent. The 2026-09-29 defect. A release whose tag
  // does not exist is un-checkoutable and cannot be verified by its own contract.
  for (const release of releases) {
    const version = versionFromTag(release.tag_name);
    if (version === null) continue;
    if (!tags.includes(release.tag_name)) {
      error(
        "release-missing-tag",
        `release ${release.tag_name} exists but tag ${release.tag_name} is absent from origin`,
      );
    }
  }

  // --- Tag present, release absent. Documented historical class
  // (v0.36.29, v0.40.6) — worth reporting, not worth failing the build.
  const releasedTags = new Set(releases.map((r) => r.tag_name));
  for (const tag of tags) {
    if (classifyTagName(tag) !== "release") continue; // malformed/other: see below
    if (!releasedTags.has(tag)) {
      info("tag-without-release", `tag ${tag} has no GitHub release`);
    }
  }

  // --- Malformed release-shaped tags. The two live strays are `0.37.0` and
  // `0.42.0`: a version without the `v` prefix, each of which HAS a matching
  // GitHub release (also unprefixed), so they disagree with nothing — but they
  // are the exact stray-tag class a release tool exists to surface, and until
  // this finding existed they were invisible to it. Info, never error: a
  // malformed tag is a hygiene defect, not evidence that npm, the tags and the
  // release records have drifted apart. Deleting a published tag is a human
  // decision (see RELEASE.md) — this reports, it does not remediate.
  for (const tag of tags) {
    if (classifyTagName(tag) !== "malformed") continue;
    info(
      "malformed-tag",
      `tag ${tag} is not a \`vX.Y.Z\` release tag; it is ignored by every version ` +
        "comparison here, so it can never report or cause drift",
    );
  }

  // --- npm vs the newest published release record. This is the headline
  // invariant: the published library must not be ahead of its own record.
  const published = releases
    .filter((r) => !r.isDraft)
    .map((r) => versionFromTag(r.tag_name))
    .filter((v) => v !== null)
    .sort(compareVersions);
  const newestRelease = published.length > 0 ? published[published.length - 1] : null;

  if (state.npmVersion === null) {
    error("npm-version-missing", "npm reports no `latest` version for bosun");
  } else if (newestRelease !== null) {
    const cmp = compareVersions(state.npmVersion, newestRelease);
    if (cmp > 0) {
      error(
        "npm-ahead-of-release-record",
        `npm has ${state.npmVersion} but the newest published release is v${newestRelease} — the published library is ahead of its own release record`,
      );
    } else if (cmp < 0) {
      error(
        "release-record-ahead-of-npm",
        `release v${newestRelease} is published but npm latest is only ${state.npmVersion}`,
      );
    }
  }

  // --- package.json vs npm. Being *ahead* is the normal staged state between a
  // cut and its publish (`develop` carries the next version); being *behind*
  // means the manifest contradicts the registry.
  if (state.npmVersion !== null && state.manifest !== null) {
    if (parseVersion(state.manifest) === null) {
      error("manifest-unparseable", `package.json version is not semver: ${JSON.stringify(state.manifest)}`);
    } else {
      const cmp = compareVersions(state.manifest, state.npmVersion);
      if (cmp < 0) {
        error(
          "manifest-behind-npm",
          `package.json says ${state.manifest} but npm latest is ${state.npmVersion}`,
        );
      } else if (cmp > 0) {
        info(
          "release-staged",
          `package.json ${state.manifest} is ahead of npm ${state.npmVersion} — staged, not yet published`,
        );
      }
    }
  }

  const hasError = findings.some((f) => f.severity === SEVERITY_ERROR);
  return { ok: !hasError, exitCode: hasError ? 1 : 0, findings };
}

/** Default probes. Each returns a value or PROBE_FAILED — never throws. */
export function createProbes({ repo = DEFAULT_REPO, run }) {
  const exec = run ?? defaultRun;
  return {
    async manifest(cwd) {
      try {
        const raw = await exec("node", [
          "-p",
          "JSON.parse(require('fs').readFileSync('package.json','utf8')).version",
        ], { cwd });
        return raw.trim();
      } catch {
        return PROBE_FAILED;
      }
    },
    async tags() {
      try {
        const raw = await exec("git", ["ls-remote", "--tags", "origin"]);
        const names = new Set();
        for (const line of raw.split("\n")) {
          const match = /refs\/tags\/(\S+?)(\^\{\})?$/.exec(line.trim());
          if (match) names.add(match[1]);
        }
        return [...names];
      } catch {
        return PROBE_FAILED;
      }
    },
    async releases() {
      try {
        const raw = await exec("gh", [
          "api",
          `repos/${repo}/releases?per_page=100`,
        ]);
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return PROBE_FAILED;
        return parsed.map((r) => ({ tag_name: r.tag_name, isDraft: Boolean(r.draft) }));
      } catch {
        return PROBE_FAILED;
      }
    },
    async npmVersion() {
      // `execFile("npm", ...)` does not work on Windows: npm is a shell shim
      // (`npm`/`npm.cmd`), never a PE image, so CreateProcessW fails with
      // EINVAL and the probe reports "registry unreachable" on a machine whose
      // registry is perfectly reachable. Resolve npm's real JS entry point
      // beside the running node, and only fall back to a shell when that
      // cannot be found.
      const npmCli = resolveNpmCli();
      try {
        const raw = npmCli
          ? await exec(process.execPath, [npmCli, "view", "bosun", "version"])
          : await exec("npm", ["view", "bosun", "version"], { shell: true });
        const value = raw.trim();
        return value.length > 0 ? value : null;
      } catch {
        return PROBE_FAILED;
      }
    },
  };
}

/**
 * Locate npm's real JS entry point, so npm can be invoked without a shell.
 * On Windows `execFile("npm", ...)` fails with EINVAL because npm is a shim
 * script; spawning `process.execPath` against `npm-cli.js` sidesteps the shim
 * entirely and behaves identically on POSIX. Returns null when it cannot be
 * found, so the caller can fall back to a shell.
 */
export function resolveNpmCli() {
  const candidates = [
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function defaultRun(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "utf8", windowsHide: true, ...options }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/**
 * Collect all four records. Never throws; failures become PROBE_FAILED.
 *
 * A caller-supplied override (`options.npmVersion`, `options.manifest`,
 * `options.tags`, `options.releases`) replaces that record's probe entirely.
 * This is what makes `--npm-version` an *override* rather than decorative:
 * without it the flag was accepted, ignored, and the command still reported the
 * live registry's verdict — a fail-closed gate silently answering a question
 * nobody asked. `undefined` means "probe it"; only an explicit value short-circuits.
 */
export async function collectReleaseState(options = {}) {
  const probes = options.probes ?? createProbes(options);
  const [probedManifest, probedTags, probedReleases, probedNpmVersion] = await Promise.all([
    probes.manifest(options.cwd),
    probes.tags(),
    probes.releases(),
    probes.npmVersion(),
  ]);
  return {
    manifest: options.manifest ?? probedManifest,
    tags: options.tags ?? probedTags,
    releases: options.releases ?? probedReleases,
    npmVersion: options.npmVersion ?? probedNpmVersion,
  };
}

function formatReport(result, state) {
  const lines = [];
  // The summary used a `/^v\d/` filter, which made the malformed tags invisible
  // in the one line a human is most likely to read. Report the same three
  // buckets `classifyTagName` uses, and say so, rather than filtering silently.
  const bucket = (name) => {
    if (!Array.isArray(state.tags)) return String(state.tags);
    return state.tags.filter((t) => classifyTagName(t) === name).join(", ") || "(none)";
  };
  const releaseBuckets = Array.isArray(state.releases)
    ? state.releases.map((r) => r.tag_name)
    : null;

  lines.push("bosun release drift");
  lines.push("");
  lines.push(`  package.json      ${state.manifest}`);
  lines.push(`  npm latest        ${state.npmVersion}`);
  lines.push(`  release tags      ${bucket("release")}`);
  lines.push(`  malformed tags    ${bucket("malformed")}`);
  lines.push(
    `  non-version tags  ${bucket("other")}` +
      `   (ignored — not version-shaped; shown for completeness)`,
  );
  lines.push(
    `  release records   ${releaseBuckets === null
      ? String(state.releases)
      : releaseBuckets.join(", ") || "(none)"}`,
  );
  lines.push("");
  if (result.findings.length === 0) {
    lines.push("  DRIFT: none — all records agree.");
  } else {
    for (const finding of result.findings) {
      const tag = finding.severity === SEVERITY_ERROR ? "ERROR" : "info ";
      lines.push(`  ${tag}  [${finding.code}] ${finding.detail}`);
    }
  }
  lines.push("");
  if (result.exitCode === 2) {
    lines.push("  VERDICT: UNKNOWN — a probe failed. Re-run with network access.");
  } else if (result.exitCode === 1) {
    lines.push("  VERDICT: DRIFTED — reconcile per RELEASE.md. Do not publish or delete anything to 'fix' it.");
  } else {
    lines.push("  VERDICT: CLEAN.");
  }
  return lines.join("\n");
}

async function main(argv) {
  const args = argv.slice(2);
  const json = args.includes("--json");
  const readArg = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };

  const repo = readArg("--repo") ?? DEFAULT_REPO;
  const overrides = {};
  const npmOverride = readArg("--npm-version");
  if (npmOverride !== undefined) overrides.npmVersion = npmOverride;

  const state = await collectReleaseState({ repo, cwd: process.cwd(), ...overrides });
  const result = classifyReleaseState(state);

  if (json) {
    console.log(JSON.stringify({ ...result, state }, null, 2));
  } else {
    console.log(formatReport(result, state));
  }
  process.exit(result.exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).catch((err) => {
    console.error(`release-drift: the gate itself failed: ${err?.message ?? err}`);
    process.exit(2);
  });
}
