/**
 * dompurify-advisories.mjs — the advisory data the DOMPurify floor is derived from.
 *
 * Why this exists: a vendored browser bundle is invisible to dependabot, so the
 * floor gate in check-vendored-dompurify.mjs is the only channel that can report
 * a shipped DOMPurify inside an advisory range. That makes `DOMPURIFY_MIN_VERSION`
 * a security control, not a convenience constant — and a security control that is
 * a hand-typed literal silently rots. It already did: the floor sat at 3.4.13,
 * which is exactly the lower bound of GHSA-p98j-92pf-mc4p (>= 3.4.13, <= 3.4.15),
 * published 2026-09-30. Nothing in the repo could notice.
 *
 * So the advisory list is committed (tools/dompurify-advisories.json, regenerate
 * with `npm run refresh:dompurify-advisories`) and the floor is COMPUTED from it,
 * then cross-checked in tests against a literal that must be re-derived when the
 * data moves. Fail-closed throughout: an unparseable range throws rather than
 * being skipped, because a silently skipped advisory is a silently open gate.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ADVISORY_DATA_PATH = fileURLToPath(
  new URL("./dompurify-advisories.json", import.meta.url),
);

/** The 3.x line is the only one this repo can ship (2.x cannot be forced into the toast-ui tree). */
const SCAN_MAJOR = 3;
const SCAN_MAX_MINOR = 60;
const SCAN_MAX_PATCH = 99;

export function compareVersions(left, right) {
  const a = String(left).split(".").map(Number);
  const b = String(right).split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Parse a `vulnerable_version_range` into a list of comparators.
 * Throws on anything outside the observed grammar rather than guessing: an
 * advisory we cannot evaluate must break the build, not pass through it.
 */
export function parseVulnerableRange(range, label = "range") {
  if (typeof range !== "string" || range.trim() === "") {
    throw new Error(`${label}: missing vulnerable_version_range`);
  }
  return range.split(",").map((clause) => {
    const match = clause.trim().match(/^(>=|<=|>|<|=)?\s*(\d+)\.(\d+)\.(\d+)$/);
    if (!match) {
      throw new Error(`${label}: unsupported vulnerable_version_range ${JSON.stringify(clause.trim())}`);
    }
    return {
      operator: match[1] || "=",
      version: `${match[2]}.${match[3]}.${match[4]}`,
    };
  });
}

function satisfiesComparator(version, comparator) {
  const cmp = compareVersions(version, comparator.version);
  switch (comparator.operator) {
    case ">":
      return cmp > 0;
    case ">=":
      return cmp >= 0;
    case "<":
      return cmp < 0;
    case "<=":
      return cmp <= 0;
    case "=":
      return cmp === 0;
    default:
      throw new Error(`unsupported comparator operator ${JSON.stringify(comparator.operator)}`);
  }
}

/** True when `version` falls inside any range recorded for `advisory`. */
export function advisoryAffects(advisory, version) {
  return (advisory.ranges || []).some((range) =>
    parseVulnerableRange(range.vulnerableVersionRange, advisory.ghsaId).every((comparator) =>
      satisfiesComparator(version, comparator),
    ),
  );
}

export function loadAdvisoryData(path = ADVISORY_DATA_PATH) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(data.advisories) || data.advisories.length === 0) {
    throw new Error(`advisory data at ${path} contains no advisories`);
  }
  return data;
}

/** Every advisory in the committed data whose ranges cover `version`. */
export function advisoriesAffecting(version, data = loadAdvisoryData()) {
  return data.advisories.filter((advisory) => advisoryAffects(advisory, version));
}

/**
 * The lowest 3.x version that no advisory covers — i.e. the floor, derived from
 * data rather than asserted. Scans rather than reading `first_patched_version`
 * because two advisories have no patched version at all and several patched
 * versions are themselves covered by a later advisory.
 */
export function deriveAdvisoryFloor(data = loadAdvisoryData()) {
  for (let minor = 0; minor <= SCAN_MAX_MINOR; minor += 1) {
    for (let patch = 0; patch <= SCAN_MAX_PATCH; patch += 1) {
      const candidate = `${SCAN_MAJOR}.${minor}.${patch}`;
      if (advisoriesAffecting(candidate, data).length === 0) return candidate;
    }
  }
  throw new Error(
    `no ${SCAN_MAJOR}.x version clears the ${data.advisories.length} recorded advisories `
      + "within the scan window; widen SCAN_MAX_MINOR/SCAN_MAX_PATCH or re-derive manually",
  );
}
