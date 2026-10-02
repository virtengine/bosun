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
 * So the roots are DERIVED here, from the repo's own declaration of what ships.
 * There are three shipping channels, and each is read from the file that declares
 * it rather than from a list kept here:
 *
 *   1. the npm tarball  — the top-level path segment of every package.json
 *      `files[]` entry;
 *   2. GitHub Pages    — the `publish_dir` parsed out of
 *      .github/workflows/deploy-site.yaml;
 *   3. the container   — the Dockerfile does `COPY . .`, so the build context is
 *      the whole repo MINUS .dockerignore. That exclusion list is the repo's own
 *      declaration of what the image does NOT ship, so the container scan set is
 *      every top-level tracked segment that .dockerignore does not exclude. A
 *      root the image picks up is scanned the day it is added, with no edit here.
 *
 * Rounds 4, 5 and 6 of review were each this same finding at a different
 * granularity (paths → roots → the set of DECLARATIONS feeding the roots), so the
 * derivation now has to answer one question completely: which declarations say
 * what ships? Answering it per-channel is not enough; the union of all channels
 * is what gets scanned, and assertChannelsAccounted() proves no tracked segment
 * fell through the classification unnoticed.
 *
 * Matching .dockerignore happens at TOP-LEVEL-SEGMENT granularity, which is all
 * `git ls-files` needs. That is deliberately fail-OPEN: a pattern this matcher
 * cannot evaluate at that granularity (one with an interior `/`) leaves its
 * segment INCLUDED, so a matcher limitation widens the scan instead of silently
 * narrowing it. Unmatchable therefore means "scan it", never "skip it".
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

/** Manifest declaring what the container image does NOT ship. */
export const DOCKER_IGNORE = ".dockerignore";

/** The Dockerfile whose `COPY . .` makes repo-minus-.dockerignore the image. */
export const DOCKERFILE = "Dockerfile";

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
 * @param {string[]} [options.containerRoots] roots the container image ships
 * @returns {string[]} sorted, de-duplicated repo-relative roots
 */
export function deriveScanRoots({ manifest, publishDir, containerRoots } = {}) {
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
  for (const root of containerRoots ?? []) roots.add(String(root).trim());
  // MINIMUM_SCAN_ROOTS is deliberately NOT unioned in here. Folding the floor
  // into the derivation would make assertScanRootsCover unreachable — the
  // assertion would be satisfied by construction and could never fire, which is
  // the same "cannot check itself" defect the derived floor replaced. The floor
  // is checked by resolveScanRoots(), which is the only caller that scans.
  return [...roots].sort();
}

/**
 * Every top-level tracked segment in the checkout.
 *
 * This is the candidate universe the shipping channels then partition. Reading
 * it is what lets assertChannelsAccounted() prove that every segment was
 * classified by some channel, instead of trusting that the channels happened to
 * agree on it.
 *
 * @returns {string[]} sorted, de-duplicated top-level segments
 */
export function listTopLevelSegments(cwd = process.cwd()) {
  let stdout;
  try {
    stdout = execFileSync("git", ["ls-files", "-z"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `cannot enumerate tracked files: ${error.message}. The DOMPurify floor gate `
        + "must classify the whole tracked tree against every shipping channel; an "
        + "unenumerable tree means it cannot know what ships.",
    );
  }
  const segments = new Set();
  for (const path of stdout.split("\0").filter(Boolean)) {
    const segment = path.split("/")[0].trim();
    if (segment) segments.add(segment);
  }
  return [...segments].sort();
}

/**
 * Parse .dockerignore into exclusion patterns.
 *
 * Docker's own semantics: one pattern per line, `#` comments, blank lines
 * ignored, a trailing `/` meaning "directory only", and a leading `!` negating
 * a previous exclusion (later lines win, exactly as Docker resolves them).
 * Everything else — `*`, `**`, `?` globs — is handled by globToRegExp.
 *
 * @returns {{pattern: string, negated: boolean, dirOnly: boolean}[]}
 */
export function parseDockerignore(source, label = DOCKER_IGNORE) {
  const rules = [];
  for (const rawLine of String(source).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    const body = (negated ? line.slice(1) : line).trim();
    if (!body) continue;
    rules.push({
      pattern: body.replace(/\/+$/, ""),
      negated,
      dirOnly: body.endsWith("/"),
    });
  }
  if (rules.length === 0) {
    throw new Error(
      `${label} declares no exclusions. The Dockerfile copies the whole build `
        + "context, so an empty .dockerignore would mean the image ships every "
        + "tracked file. Verify the file still exists and still excludes something "
        + "rather than letting the container channel silently widen to the tree.",
    );
  }
  return rules;
}

/**
 * Translate one .dockerignore glob to an anchored RegExp over a repo-relative
 * path. A pattern with no `/` matches at any depth (Docker's rule for
 * single-segment patterns), which matters because `tests/` here excludes
 * `tests/...` but must not be read as excluding a root named `tests` from the
 * scan — the container channel is what applies these rules, and the root set is
 * top-level segments.
 */
function globToRegExp(pattern) {
  const anchored = pattern.includes("/") && !pattern.startsWith("**/");
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i += 1;
        if (pattern[i + 1] === "/") i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return new RegExp(anchored ? `^${out}(/.*)?$` : `(^|/)${out}(/.*)?$`);
}

/**
 * Does one .dockerignore rule exclude a top-level tracked segment?
 *
 * `segments` lets a `dirOnly` rule (`tests/`) distinguish a directory from a
 * same-named file: `tests/` must not exclude a tracked FILE named `tests`.
 * A rule whose pattern carries an interior `/` cannot be evaluated against a bare
 * top-level segment, and this returns false — fail-OPEN, so the segment stays
 * INCLUDED and gets scanned. A matcher limitation must never be the reason a
 * shipping root goes unexamined.
 */
function ruleExcludesSegment(rule, segment, segments) {
  if (rule.dirOnly && !segments.has(segment)) return false;
  if (rule.pattern.includes("/")) return false;
  return globToRegExp(rule.pattern).test(segment);
}

/**
 * The container channel: top-level tracked segments the image ships.
 *
 * The Dockerfile does `COPY . .`, so the build context is the repo minus
 * .dockerignore. Reading that exclusion list is reading the repo's own
 * declaration of what the image does NOT ship — which is why this is a
 * derivation and not a fourth hardcoded list.
 *
 * @param {object} options
 * @param {string} options.dockerignore raw .dockerignore contents
 * @param {string[]} options.segments  every top-level tracked segment
 * @returns {string[]} segments not excluded by the final resolved rule set
 */
export function deriveContainerScanRoots({ dockerignore, segments, label = DOCKER_IGNORE } = {}) {
  if (!Array.isArray(segments)) {
    throw new Error("deriveContainerScanRoots needs the tracked top-level segments");
  }
  const rules = parseDockerignore(dockerignore, label);
  const universe = new Set(segments);
  return segments.filter((segment) => {
    let excluded = false;
    for (const rule of rules) {
      if (!ruleExcludesSegment(rule, segment, universe)) continue;
      excluded = !rule.negated;
    }
    return !excluded;
  });
}

/**
 * Throws unless every root a channel claims is present in the scan set.
 *
 * The scan set is the UNION of the channels, so a channel whose roots are not in
 * it is a channel that was derived and then silently dropped — which is how the
 * Docker channel went unmodelled in the first place. The two arguments are
 * computed independently (the channel from `.dockerignore`, the scan set from the
 * union of every declaration), so this can genuinely fire; an assertion fed only
 * its own output could not, and that is the defect class this module keeps
 * having to be defended against.
 */
export function assertChannelsAccounted(channelRoots, scanRoots) {
  const covered = new Set(scanRoots);
  const missing = [...new Set(channelRoots)].filter((root) => !covered.has(root));
  if (missing.length > 0) {
    throw new Error(
      `shipping-channel root(s) ${missing.map((r) => JSON.stringify(r)).join(", ")} `
        + `are missing from the scan set ${JSON.stringify(scanRoots)}. Every channel `
        + `must be unioned into what the gate scans: a channel that is derived and `
        + `then dropped is exactly how an unmonitored bundle gets shipped.`,
    );
  }
  return scanRoots;
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
 * The real scan roots for a checkout: derived from every shipping channel, then
 * asserted complete and asserted against the floor.
 *
 * `resolveScanRoots` returns the roots; `resolveScanChannels` returns the same
 * roots PLUS the per-channel breakdown, which the gate prints so a coverage
 * change is visible in CI output rather than inferred from a count.
 */
export function resolveScanChannels({
  cwd,
  manifest,
  workflow,
  publishDir,
  dockerignore,
  dockerfile,
  segments,
} = {}) {
  const root = resolve(cwd ?? process.cwd());
  const manifestSource = manifest ?? readFileSync(resolve(root, PACKAGE_MANIFEST), "utf8");
  const workflowSource = workflow ?? readFileSync(resolve(root, PAGES_WORKFLOW), "utf8");
  const dockerignoreSource = dockerignore ?? readFileSync(resolve(root, DOCKER_IGNORE), "utf8");
  const dockerfileSource = dockerfile ?? readFileSync(resolve(root, DOCKERFILE), "utf8");

  // The container model is only valid while the Dockerfile copies the whole
  // build context. If it starts copying a subdirectory, repo-minus-.dockerignore
  // stops being the image and this derivation would silently over-report — so the
  // premise is checked rather than assumed.
  if (!/^\s*COPY\s+\.\s+\.\s*$/m.test(dockerfileSource)) {
    throw new Error(
      `${DOCKERFILE} no longer copies the whole build context with \`COPY . .\`. `
        + "The container channel derives its roots from .dockerignore, which is "
        + "only the image's content while the whole tree is copied. Update the gate "
        + "deliberately rather than letting it keep modelling a channel it no "
        + "longer understands.",
    );
  }

  const universe = segments ?? listTopLevelSegments(root);
  const container = deriveContainerScanRoots({
    dockerignore: dockerignoreSource,
    segments: universe,
  });
  // The container channel must be wired AND must have resolved to something.
  // A matcher regression that excluded everything would otherwise hand the gate
  // a short root list and a green build, which is the round-3 "assertion fed its
  // own input" shape: the check has to be against the tree, not against the
  // derivation's own output.
  if (container.length === 0) {
    throw new Error(
      `${DOCKER_IGNORE} excludes every one of the ${universe.length} tracked `
        + `top-level segment(s), so the container channel derives no scan root. `
        + "The image ships almost the whole repo, so the gate would now check "
        + "almost nothing while still printing PASS. Fix the .dockerignore matcher.",
    );
  }
  const manifestObject = JSON.parse(manifestSource);
  const pagesDir = String(publishDir ?? readPublishDir(workflowSource)).trim();
  const npmRoots = deriveScanRoots({ manifest: manifestObject, publishDir: pagesDir });
  const derived = deriveScanRoots({
    manifest: manifestObject,
    publishDir: pagesDir,
    containerRoots: container,
  });

  // The scan set must actually contain the container channel's roots, and the
  // union must cover the documented floor.
  assertChannelsAccounted(container, derived);
  return {
    roots: assertScanRootsCover(derived),
    channels: {
      npm: npmRoots,
      pages: [pagesDir],
      container,
    },
    segments: universe,
  };
}

/** The real scan roots for a checkout. */
export function resolveScanRoots(options = {}) {
  return resolveScanChannels(options).roots;
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
  // Resolved once: resolveScanChannels() does the git enumeration and the
  // assertions, so calling resolveScanRoots() first would do all of that twice.
  const resolved = roots ? { roots } : resolveScanChannels({ cwd: root });
  const scanRoots = resolved.roots;
  const channels = resolved.channels ?? null;
  const tracked = files ?? listTrackedVendoredFiles(root, scanRoots);
  const reader =
    readFile
    ?? ((path) => readFileSync(resolve(root, path), "utf8"));
  return {
    roots: scanRoots,
    channels,
    bundles: findDompurifyBundles({ files: tracked, readFile: reader, roots: scanRoots }),
  };
}
