/**
 * The version that clears every open dompurify advisory affecting this repo
 * (13 ranges), and the version the bundle is actually rebuilt against.
 * `DOMPURIFY_MIN_VERSION` is the gate floor and never moves below it;
 * `DOMPURIFY_VERSION` is what tools/build-vendor-toastui.mjs forces upstream.
 */
export const DOMPURIFY_MIN_VERSION = "3.4.13";
export const DOMPURIFY_VERSION = "3.4.16";

const LICENSE_VERSION = /@license DOMPurify (\d+\.\d+\.\d+)/g;
const RUNTIME_VERSION = /\b[\w$]+\.version\s*=\s*["'](\d+\.\d+\.\d+)["']\s*,\s*[\w$]+\.removed\s*=\s*\[\]/g;

export function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

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
