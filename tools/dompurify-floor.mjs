/**
 * The DOMPurify security floor, and the version the vendored bundle is rebuilt against.
 *
 * `DOMPURIFY_MIN_VERSION` is DERIVED from the advisory data in
 * tools/dompurify-advisories.json — it is not a hand-typed literal. A vendored
 * browser bundle is invisible to dependabot, so this floor is the only channel
 * that can report a shipped DOMPurify inside an advisory range, which makes the
 * constant a security control with no second line of defence. A literal rotted
 * exactly that way before: it sat at 3.4.13, the precise lower bound of
 * GHSA-p98j-92pf-mc4p (>= 3.4.13, <= 3.4.15, first patched 3.4.16, published
 * 2026-09-30), and no test could tell, because the tests fed the constant to
 * itself. Deriving it from data means a new advisory moves the floor on the next
 * `npm run refresh:dompurify-advisories`, and tests/vendor-dompurify-floor.test.mjs
 * fails until the pinned literal below is re-derived to match.
 *
 * `DOMPURIFY_VERSION` is what tools/build-vendor-toastui.mjs forces into the
 * upstream tree, and is deliberately an explicit literal: it is a build input,
 * not a derivation. It must be at or above the derived floor, or this module
 * throws at import — so bumping an advisory floor cannot leave the rebuild
 * producing a still-vulnerable bundle.
 */
import {
  advisoryAffects,
  advisoriesAffecting,
  compareVersions,
  deriveAdvisoryFloor,
  loadAdvisoryData,
} from "./dompurify-advisories.mjs";

export { advisoryAffects, advisoriesAffecting, compareVersions, loadAdvisoryData };

/** The lowest 3.x version that no recorded advisory covers. Fails closed on bad data. */
export const DOMPURIFY_MIN_VERSION = deriveAdvisoryFloor();

/** The version the vendored bundle is actually rebuilt against. */
export const DOMPURIFY_VERSION = "3.4.16";

if (compareVersions(DOMPURIFY_VERSION, DOMPURIFY_MIN_VERSION) < 0) {
  throw new Error(
    `DOMPURIFY_VERSION ${DOMPURIFY_VERSION} is below the advisory-derived floor `
      + `${DOMPURIFY_MIN_VERSION}. Refresh the advisory data `
      + "(`npm run refresh:dompurify-advisories`), then bump DOMPURIFY_VERSION "
      + "and rebuild the bundle with `npm run build:vendor-toastui`.",
  );
}

const LICENSE_VERSION = /@license DOMPurify (\d+\.\d+\.\d+)/g;
const RUNTIME_VERSION = /\b[\w$]+\.version\s*=\s*["'](\d+\.\d+\.\d+)["']\s*,\s*[\w$]+\.removed\s*=\s*\[\]/g;

function captureVersions(source, expression) {
  return [...source.matchAll(expression)].map((match) => match[1]);
}

export function inspectDompurifyBundle(source, label = "bundle") {
  const licenseVersions = captureVersions(source, LICENSE_VERSION);
  const runtimeVersions = captureVersions(source, RUNTIME_VERSION);
  const versions = [...licenseVersions, ...runtimeVersions];

  if (licenseVersions.length !== 1 || runtimeVersions.length !== 1) {
    return {
      ok: false,
      versions,
      reason: `expected exactly one DOMPurify license marker and one runtime version marker (found ${licenseVersions.length} and ${runtimeVersions.length})`,
      label,
    };
  }

  if (licenseVersions[0] !== runtimeVersions[0]) {
    return {
      ok: false,
      versions,
      reason: `license/runtime DOMPurify versions disagree (${licenseVersions[0]} vs ${runtimeVersions[0]})`,
      label,
    };
  }

  if (compareVersions(runtimeVersions[0], DOMPURIFY_MIN_VERSION) < 0) {
    return {
      ok: false,
      versions,
      reason: `${runtimeVersions[0]} is below required floor ${DOMPURIFY_MIN_VERSION}`,
      label,
    };
  }

  return { ok: true, versions, reason: null, label };
}
