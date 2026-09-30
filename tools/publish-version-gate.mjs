#!/usr/bin/env node

/**
 * publish-version-gate.mjs — decides whether a local version may be published.
 * The publish workflow used to inline its comparison as
 * `String.split(".").map(Number)` plus three `>` tests. That silently
 * mis-evaluates on any non-numeric component: a prerelease like `0.43.2-beta.1`
 * yields `NaN` in the patch slot, every comparison is false, and the gate
 * reports "not newer" — so a legitimate version bump never publishes. In the
 * other direction a blank registry response (network flake, `npm view`
 * non-zero exit) fell back to `0.0.0`, which made *every* local version look
 * newer and pushed the workflow at an unchanged version.
 *
 * Both are the same bug: an unparseable version must fail LOUD, never
 * silently resolve to "publish" or "skip". This module is the single
 * decision point; the workflow calls it instead of re-deriving the rule.
 *
 * The gate is deliberately FAIL-CLOSED. `0.0.0` is NOT used as the
 * "registry unreachable" fallback: every released version compares greater
 * than `0.0.0`, so that placeholder turned a network blip into a publish
 * attempt at an unchanged version. UNKNOWN_REGISTRY_VERSION is a sentinel
 * that no real version can equal, and it stops the gate instead.
 */

import { pathToFileURL } from "node:url";

/**
 * Sentinel meaning "the registry could not be reached". Deliberately not a
 * parseable version, so it can never be ordered against a real one.
 */
export const UNKNOWN_REGISTRY_VERSION = "unknown";

const SEMVER =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

/**
 * Parse a strict semver string into comparable parts.
 * Returns null for anything that is not exactly `MAJOR.MINOR.PATCH[-pre][+build]`.
 */
export function parseVersion(value) {
  if (typeof value !== "string") return null;
  const match = SEMVER.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split("."),
    build: match[5] ?? "",
  };
}

/** Compare two prerelease identifier lists per semver §11.4. */
function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  // A version with a prerelease has LOWER precedence than one without.
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
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
    // Numeric identifiers always have lower precedence than alphanumeric.
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * Standard semver precedence comparison. Build metadata is ignored.
 * Returns -1, 0, or 1; throws on an unparseable operand rather than
 * degrading to a silent false.
 */
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
 * Decide whether to publish.
 *
 * `registryVersion` must be a real version string, or UNKNOWN_REGISTRY_VERSION
 * when the registry could not be reached. An unknown registry STOPS the gate:
 * without `force`, a network failure must not turn into a publish attempt.
 *
 * `force` is the workflow_dispatch input documented as "Force publish even if
 * version unchanged", so it may only override stops that are about *comparison*
 * — an unknown/unparseable registry, or a version that is not newer. It may NOT
 * override a stop that is about the *local version being unparseable*: the
 * publish job builds the release tag as a bare `TAG="v$VERSION"` concatenation,
 * so a local version of `v0.44.0` produced the remote tag `vv0.44.0` and a
 * local version of `0.44` produced `v0.44`. `npm publish` does not catch either
 * (verified: `npm publish --dry-run` accepts `v0.44.0`, rc=0), so nothing
 * between this gate and `git tag` would refuse the typo. `forceable: false` is
 * how a stop states that.
 *
 * Returns { shouldPublish, reason, localVersion, registryVersion }.
 */
export function decidePublish({ localVersion, registryVersion, force = false }) {
  const registry = registryVersion === undefined
    ? UNKNOWN_REGISTRY_VERSION
    : registryVersion;

  const stop = (reason, { forceable = true } = {}) => {
    const overriding = forceable && force;
    return {
      shouldPublish: overriding,
      reason: overriding
        ? `${reason} — proceeding anyway because force was requested`
        : forceable || !force
          ? reason
          : `${reason} — force does NOT override this; the release tag is built from this value`,
      localVersion,
      registryVersion: registry,
    };
  };

  // The LOCAL version is checked first, deliberately. It is the only input
  // this module cannot let past: the publish job turns it into a git tag with a
  // bare `TAG="v$VERSION"` concatenation, and `npm publish --dry-run` accepts
  // `v0.44.0` (verified, rc=0), so nothing downstream refuses the typo. If this
  // check sat after the registry checks, then `force: true` + an unreachable
  // registry + a junk local version would stop on the forceable
  // unknown-registry reason and publish anyway — the same `vv0.44.0` remote tag
  // the ordering was meant to prevent. The registry stops stay forceable
  // (that is what the input is documented for); this one is not.
  if (!parseVersion(localVersion)) {
    return stop(
      `local package.json version is unparseable (${JSON.stringify(localVersion)})`,
      { forceable: false },
    );
  }

  if (registry === UNKNOWN_REGISTRY_VERSION) {
    return stop(
      "registry version is unknown (npm view failed); refusing to publish without a comparison",
    );
  }

  const parsedRegistry = parseVersion(registry);
  if (!parsedRegistry) {
    return stop(
      `registry returned an unparseable version (${JSON.stringify(registry)}); refusing to publish on a guess`,
    );
  }

  if (compareVersions(localVersion, registry) > 0) {
    return {
      shouldPublish: true,
      reason: `${localVersion} is newer than registry ${registry}`,
      localVersion,
      registryVersion: registry,
    };
  }

  if (force) {
    return {
      shouldPublish: true,
      reason: `force requested; ${localVersion} is not newer than registry ${registry}`,
      localVersion,
      registryVersion: registry,
    };
  }

  return {
    shouldPublish: false,
    reason: `${localVersion} is not newer than registry ${registry}`,
    localVersion,
    registryVersion: registry,
  };
}

// `file://${process.argv[1]}` never matches on Windows: argv[1] is a
// backslash path, import.meta.url is a percent-encoded URL. pathToFileURL
// normalizes both, so the CLI branch fires on every platform.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , localArg, registryArg, forceArg] = process.argv;
  const decision = decidePublish({
    localVersion: localArg,
    registryVersion: registryArg,
    force: forceArg === "true",
  });
  console.log(JSON.stringify(decision));
  // Exit 0 for ANY successful decision — including "skip". A non-zero exit
  // must mean the gate itself failed, not that it declined to publish, so
  // callers can use the exit status as an error signal without `|| true`
  // masking a broken gate into a silent "skip".
  process.exit(0);
}
