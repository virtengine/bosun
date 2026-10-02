/**
 * dompurify-discovery.mjs — find the committed bundles that carry a DOMPurify.
 *
 * The floor gate in tools/check-vendored-dompurify.mjs is the only channel that
 * can see DOMPurify inside a vendored browser bundle at all: dependabot reads
 * package-lock.json and nothing else, so a bundle — any bundle — is structurally
 * invisible to it.
 *
 * Two hand-maintained lists have already failed that way, and each failure was
 * the previous fix's shape repeated one level up:
 *
 *   1. Two hardcoded bundle PATHS
 *      (`ui/assets/toastui-editor-all.min.js` and its `site/ui/` twin).
 *      Committing a genuine DOMPurify 2.3.3 bundle at a third path
 *      (`ui/assets/vendor/markdown-editor.min.js`) gave gate exit 0 and a green
 *      suite, while that file reached the npm tarball (`ui/` is in
 *      package.json `files[]`) and GitHub Pages (deploy-site.yaml does
 *      `cp -rL ui site/ui`).
 *
 *   2. A hardcoded list of scan ROOTS (`VENDORED_SCAN_ROOTS = ["ui", "site"]`).
 *      Same assumption, coarser granularity: `package.json` `files[]` ships 20+
 *      roots including `tui/` and `native/`, none of which were scanned. A real
 *      2.3.3 bundle committed at `tui/vendor-dompurify-probe.min.js` reached
 *      `npm pack` and produced gate exit 0 with a green suite.
 *
 * So the roots are DERIVED here, from the repo's own declaration of what ships:
 * the top-level path segment of every package.json `files[]` entry (the npm
 * tarball) plus the GitHub Pages `publish_dir` from
 * .github/workflows/deploy-site.yaml. A root that is added to the manifest is
 * scanned the day it is added, not the day someone remembers to edit this file.
 *
 * MINIMUM_SCAN_ROOTS survives as a documented FLOOR, not as the source of truth:
 * `assertScanRootsCover()` throws if the derived set ever stops covering it, so
 * the derivation cannot quietly shrink below what it replaced.
 *
 * Widening the roots is only safe because CANDIDATE detection is a real
 * discriminator rather than "any shipped file that mentions DOMPurify": with the
 * derived root set, a naive mention-match reports 7 false FAILs — this gate's own
 * `tools/*.mjs`, `tools/dompurify-advisories.json` and the test file all say
 * "DOMPurify". A file becomes a candidate only when it carries an actual DOMPurify
 * identity marker: an `@license DOMPurify <semver>` banner, or the minified
 * runtime `.version="<semver>",.removed=[]` pair, or both. Exactly one of the two
 * is still a candidate, and then FAILS CLOSED — a bundle whose markers stopped
 * parsing is reported, never skipped, so a re-minifier can never turn this gate
 * into a no-op that prints PASS.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

/**
 * The floor the derived root set must always cover. This is NOT the scan list —
 * see deriveScanRoots() — it is the assertion that keeps the derivation from
 * regressing below the literal it replaced.
 */
export const MINIMUM_SCAN_ROOTS = ["ui", "site"];

/**
 * DOMPurify identity markers, the same shapes tools/dompurify-floor.mjs reads.
 *
 * A file is a bundle candidate when it carries the license banner, the runtime
 * pair, or both. Carrying NEITHER means the file merely talks about DOMPurify
 * (the gate's own source does), so it is not a sanitizer at all and inspecting it
 * would only produce noise. Carrying exactly ONE is a broken/minified-differently
 * bundle and is deliberately still a candidate, so it fails closed.
 */
export const LICENSE_BANNER = /@license\s+DOMPurify\s+(\d+\.\d+\.\d+)/;
export const RUNTIME_MARKER = /\b[\w$]+\.version\s*=\s*["'](\d+\.\d+\.\d+)["']\s*,\s*[\w$]+\.removed\s*=\s*\[\]/;

/** Manifest declaring what the npm tarball ships. */
export const PACKAGE_MANIFEST = "package.json";

/** Workflow declaring what GitHub Pages ships. */
export const PAGES_WORKFLOW = ".github/workflows/deploy-site.yaml";

/**
 * Top-level path segment of every `files[]` entry, plus the Pages publish dir.
 *
 * `files[]` entries are either directories (`ui/`), files (`cli.mjs`) or globs;
 * all three are reduced to their first segment, which is exactly the granularity
 * `git ls-files` wants.
 *
 * @param {object} options
 * @param {object} options.manifest parsed root package.json
 * @param {string} [options.publishDir] value of the Pages workflow's publish_dir
 * @returns {string[]} sorted, de-duplicated repo-relative roots
 */
export function deriveScanRoots({ manifest, publishDir } = {}) {
  if (!manifest || !Array.isArray(manifest.files)) {
    throw new Error(
      `${PACKAGE_MANIFEST} has no files[] array. The DOMPurify floor gate derives `
        + "its scan roots from what ships in the npm tarball, so it cannot fall "
        + "back to a hardcoded list — a hardcoded list is what let an unmonitored "
        + "bundle through before.",
    );
  }
  const roots = new Set();
  for (const entry of manifest.files) {
    const segment = String(entry).split("/")[0].trim();
    if (segment) roots.add(segment);
  }
  if (publishDir) roots.add(String(publishDir).trim());
  // MINIMUM_SCAN_ROOTS is deliberately NOT unioned in here. Folding the floor
  // into the derivation would make assertScanRootsCover unreachable — the
  // assertion would be satisfied by construction and could never fire, which is
  // the same "cannot check itself" defect the derived floor replaced. The floor
  // is checked by resolveScanRoots(), which is the only caller that scans.
  return [...roots].sort();
}

/**
 * The Pages publish dir, read out of the deploy workflow.
 *
 * Parsed rather than hardcoded for the same reason the roots are parsed: a second
 * workflow, or a renamed publish directory, must be picked up automatically.
 */
export function readPublishDir(workflowSource, label = PAGES_WORKFLOW) {
  const match = String(workflowSource).match(/^\s*publish_dir:\s*(\S+)\s*$/m);
  if (!match) {
    throw new Error(
      `${label}: no publish_dir found. The DOMPurify floor gate derives its scan `
        + "roots from what GitHub Pages ships; if this workflow no longer declares "
        + "a publish_dir, update the gate deliberately rather than letting it fall "
        + "back to a hardcoded path.",
    );
  }
  return match[1];
}

/**
 * Throws unless `derived` covers every root in `minimum`.
 *
 * The derived set is the source of truth, but it is derived from a file a human
 * edits. Without this assertion, deleting `ui/` from `files[]` — which stops it
 * shipping — would also silently stop the gate checking the bundle inside it.
 */
export function assertScanRootsCover(derived, minimum = MINIMUM_SCAN_ROOTS) {
  const covered = new Set(derived);
  const missing = minimum.filter((root) => !covered.has(root));
  if (missing.length > 0) {
    throw new Error(
      `derived scan roots ${JSON.stringify(derived)} do not cover the required `
        + `floor ${JSON.stringify(missing)}. ${PACKAGE_MANIFEST} files[] and the `
        + "Pages publish_dir must together cover every root the vendored DOMPurify "
        + "reaches.",
    );
  }
  return derived;
}

/**
 * The real scan roots for a checkout: derived, then asserted against the floor.
 */
export function resolveScanRoots({ cwd, manifest, workflow, publishDir } = {}) {
  const root = resolve(cwd ?? process.cwd());
  const manifestSource = manifest ?? readFileSync(resolve(root, PACKAGE_MANIFEST), "utf8");
  const workflowSource = workflow ?? readFileSync(resolve(root, PAGES_WORKFLOW), "utf8");
  return assertScanRootsCover(
    deriveScanRoots({
      manifest: JSON.parse(manifestSource),
      publishDir: publishDir ?? readPublishDir(workflowSource),
    }),
  );
}

/**
 * Tracked files under the scan roots, as repo-relative POSIX paths.
 * Tracked-only on purpose: the gate must judge COMMITTED bytes, because those are
 * what ships — an untracked scratch copy in a working tree is not a finding.
 */
export function listTrackedVendoredFiles(cwd = process.cwd(), roots = resolveScanRoots({ cwd })) {
  let stdout;
  try {
    stdout = execFileSync("git", ["ls-files", "-z", "--", ...roots], {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `cannot enumerate tracked files under ${roots.join(", ")}: ${error.message}. `
        + "The DOMPurify floor gate must DISCOVER its bundles; a hardcoded path list "
        + "is what let an unmonitored bundle through before.",
    );
  }
  return stdout.split("\0").filter(Boolean);
}

/** Repo-relative POSIX path for a file on disk, so gate output is machine-comparable. */
export function toRepoRelative(root, absolutePath) {
  return relative(root, absolutePath).split(sep).join("/");
}

/**
 * Does this file carry DOMPurify's identity, as opposed to merely mentioning it?
 *
 * @returns {{candidate: boolean, banner: boolean, runtime: boolean}}
 */
export function classifyDompurifyCandidate(source) {
  const banner = LICENSE_BANNER.test(source);
  const runtime = RUNTIME_MARKER.test(source);
  return { candidate: banner || runtime, banner, runtime };
}

/**
 * Select the DOMPurify-carrying bundles from a list of tracked paths.
 *
 * @param {object} options
 * @param {string[]} options.files    repo-relative tracked paths to consider
 * @param {(path: string) => string} options.readFile  byte reader, injected for tests
 * @param {string[]} [options.roots]  root set named in error messages
 * @returns {{path: string, source: string}[]} every candidate, sorted by path
 */
export function findDompurifyBundles({ files, readFile, roots = MINIMUM_SCAN_ROOTS }) {
  const found = [];
  for (const path of [...files].sort()) {
    let source;
    try {
      source = readFile(path);
    } catch {
      // A tracked file that cannot be read (deleted in the working tree) is not
      // silently passed: `git ls-files` still lists it, and the working tree, not
      // the index, is what gets built and shipped.
      throw new Error(`tracked file under ${roots.join("/")} cannot be read: ${path}`);
    }
    if (classifyDompurifyCandidate(source).candidate) found.push({ path, source });
  }
  return found;
}

/**
 * Full discovery pass over a real checkout: derive the roots, enumerate tracked
 * files, read them, and keep the ones that actually carry DOMPurify.
 */
export function discoverDompurifyBundles({ cwd, files, readFile, roots } = {}) {
  const root = resolve(cwd ?? process.cwd());
  const scanRoots = roots ?? resolveScanRoots({ cwd: root });
  const tracked = files ?? listTrackedVendoredFiles(root, scanRoots);
  const reader =
    readFile
    ?? ((path) => readFileSync(resolve(root, path), "utf8"));
  return {
    roots: scanRoots,
    bundles: findDompurifyBundles({ files: tracked, readFile: reader, roots: scanRoots }),
  };
}
