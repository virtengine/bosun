/**
 * dompurify-discovery.mjs — find the committed bundles that carry a DOMPurify.
 *
 * The floor gate in tools/check-vendored-dompurify.mjs is the only channel that
 * can see DOMPurify inside a vendored browser bundle at all: dependabot reads
 * package-lock.json and nothing else, so a bundle — any bundle — is structurally
 * invisible to it.
 *
 * An earlier version of that gate enumerated TWO hardcoded paths
 * (`ui/assets/toastui-editor-all.min.js` and its `site/ui/` twin). That is the
 * same shape of assumption that caused the original exposure: the gate
 * re-imported a hand-maintained list of "the places DOMPurify lives" instead of
 * deriving it. Proof it was not a backstop: committing a genuine DOMPurify 2.3.3
 * bundle at a third path (`ui/assets/vendor/markdown-editor.min.js`) produced
 * exit 0 and a fully green test suite, while that file reached both the npm
 * tarball (`ui/` is in package.json `files[]`) and GitHub Pages (deploy-site.yaml
 * does `cp -rL ui site/ui`).
 *
 * So the bundle set is DISCOVERED here, by content, from the tracked tree — never
 * declared. Discovery is deliberately broad: a tracked file under the vendored
 * roots whose bytes mention DOMPurify at all is a candidate, and
 * inspectDompurifyBundle() then fails it closed if it carries no parsable version.
 * That ordering is the fail-closed property — if a future re-minifier changes the
 * marker shape so nothing parses, the file is reported rather than skipped, so the
 * gate can never silently degrade into a no-op that prints PASS.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

/**
 * Roots whose tracked files are shipped. `ui/` is in package.json `files[]` so it
 * reaches the npm tarball, and deploy-site.yaml copies `ui/` into `site/ui` for
 * GitHub Pages, so both roots reach production.
 */
export const VENDORED_SCAN_ROOTS = ["ui", "site"];

/**
 * A tracked file is a DOMPurify candidate if its bytes mention DOMPurify at all.
 * Intentionally wide: the parsability decision belongs to the floor check, which
 * fails closed, so a widened marker can only ever produce a false alarm — never a
 * missed bundle.
 */
export const DOMPURIFY_MENTION = /DOMPurify/i;

/**
 * Tracked files under VENDORED_SCAN_ROOTS, as repo-relative POSIX paths.
 * Tracked-only on purpose: the gate must judge COMMITTED bytes, because those are
 * what ships — an untracked scratch copy in a working tree is not a finding.
 */
export function listTrackedVendoredFiles(cwd = process.cwd()) {
  let stdout;
  try {
    stdout = execFileSync("git", ["ls-files", "-z", "--", ...VENDORED_SCAN_ROOTS], {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `cannot enumerate tracked files under ${VENDORED_SCAN_ROOTS.join(", ")}: `
        + `${error.message}. The DOMPurify floor gate must DISCOVER its bundles; `
        + "a hardcoded path list is what let an unmonitored bundle through before.",
    );
  }
  return stdout.split("\0").filter(Boolean);
}

/** Repo-relative POSIX path for a file on disk, so gate output is machine-comparable. */
export function toRepoRelative(root, absolutePath) {
  return relative(root, absolutePath).split(sep).join("/");
}

/**
 * Select the DOMPurify-carrying bundles from a list of tracked paths.
 *
 * @param {object} options
 * @param {string[]} options.files    repo-relative tracked paths to consider
 * @param {(path: string) => string} options.readFile  byte reader, injected for tests
 * @returns {{path: string, source: string}[]} every candidate, sorted by path
 */
export function findDompurifyBundles({ files, readFile }) {
  const found = [];
  for (const path of [...files].sort()) {
    let source;
    try {
      source = readFile(path);
    } catch {
      // A tracked file that cannot be read (deleted in the working tree) is not
      // silently passed: `git ls-files` still lists it, and the working tree, not
      // the index, is what gets built and shipped.
      throw new Error(`tracked file under ${VENDORED_SCAN_ROOTS.join("/")} cannot be read: ${path}`);
    }
    if (DOMPURIFY_MENTION.test(source)) found.push({ path, source });
  }
  return found;
}

/**
 * Full discovery pass over a real checkout: enumerate tracked files, read them,
 * and keep the ones that mention DOMPurify.
 */
export function discoverDompurifyBundles({ cwd, files, readFile }) {
  const root = resolve(cwd);
  const tracked = files ?? listTrackedVendoredFiles(root);
  const reader =
    readFile
    ?? ((path) => readFileSync(resolve(root, path), "utf8"));
  return findDompurifyBundles({ files: tracked, readFile: reader });
}
