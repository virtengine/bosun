#!/usr/bin/env node
/**
 * check-vendored-dompurify.mjs — fail the build if any shipped DOMPurify is
 * below the security floor.
 *
 * Dependabot reads package-lock.json and nothing else, so a DOMPurify embedded
 * in a vendored browser bundle is structurally invisible to it. This gate is
 * the only channel that can observe one, so it must cover both places DOMPurify
 * reaches production here:
 *
 *   1. every committed bundle that carries DOMPurify, anywhere under the SHIPPED
 *      roots — and those roots are DERIVED from package.json `files[]` and the
 *      Pages `publish_dir`, not declared here (see tools/dompurify-discovery.mjs),
 *      and
 *   2. every lockfile, so a re-resolved nested 2.x copy is caught too — including
 *      the Electron shell's `desktop/package-lock.json`, which is a shipped
 *      package with its own manifest and is not a workspace member of the root.
 *
 * The bundle set is discovered, not declared, and neither are the roots. A
 * hardcoded two-path list is the shape of assumption that caused the original
 * exposure: it produced exit 0 and a green suite for a genuine 2.3.3 bundle
 * committed at a third, unlisted path that still reached the npm tarball and
 * GitHub Pages. Replacing that list with a hardcoded root list was the same
 * assumption one level up — `tui/` and `native/` ship and were not scanned.
 * BUNDLE_TARGETS is still checked, as an ADDITIONAL byte-identity assertion, so
 * ui/ <-> site/ui drift protection is not silently lost by the scan.
 *
 * Check 1 works on the committed BYTES, not on a package manifest: it reads the
 * bundle's banner marker and the minified runtime `X.version="..."` marker and
 * requires them to agree. Rewriting only the banner therefore fails the gate —
 * which is what stops a cosmetic version-string edit from passing as a fix.
 *
 * Usage:
 *   node tools/check-vendored-dompurify.mjs [bundle ...]
 *   node tools/check-vendored-dompurify.mjs --lockfile-only
 *
 * Explicit bundle arguments override the default target list (used by tests and
 * for checking a candidate bundle before installing it).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { BUNDLE_TARGETS } from "./build-vendor-toastui.mjs";
import { ADVISORY_DATA_PATH, loadAdvisoryData } from "./dompurify-advisories.mjs";
import { discoverDompurifyBundles, toRepoRelative } from "./dompurify-discovery.mjs";
import { DOMPURIFY_MIN_VERSION, inspectDompurifyBundle } from "./dompurify-floor.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const lockfileOnly = args.includes("--lockfile-only");
const explicit = args.filter((a) => !a.startsWith("--"));

/**
 * Every lockfile in the repo, DISCOVERED from the tracked tree rather than
 * hardcoded to the root one. `desktop/` is a shipped package with its own
 * manifest and lockfile and is not a workspace member of the root manifest
 * (dependency-audit.yml's header says so), so a hardcoded root path checked one
 * lockfile while a nested 2.x copy planted one directory over went unreported.
 */
function listRepoLockfiles() {
  const stdout = execFileSync("git", ["ls-files", "-z", "--", "**/package-lock.json", "package-lock.json"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  const found = stdout.split("\0").filter(Boolean).sort();
  if (found.length === 0) {
    throw new Error("no tracked package-lock.json found; cannot verify the installed set");
  }
  return found;
}

/** Does this manifest declare dompurify in any dependency field, including overrides? */
function hasDompurifyDependency(manifest) {
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    if (manifest?.[field] && "dompurify" in manifest[field]) return true;
  }
  if (manifest?.overrides?.dompurify) return true;
  for (const scoped of Object.values(manifest?.overrides ?? {})) {
    if (scoped && typeof scoped === "object" && scoped.dompurify) return true;
  }
  return false;
}

let failed = false;

function fail(message) {
  failed = true;
  process.stderr.write(`FAIL ${message}\n`);
}

// ── Bundles ──────────────────────────────────────────────────────────────────
// The bundle set is DISCOVERED from the tracked tree by content, so a bundle
// committed at a path nobody listed is still checked. Explicit arguments (tests,
// and checking a candidate bundle before installing it) replace the scan.
if (!lockfileOnly) {
  const discovered = explicit.length > 0
    ? {
        roots: ["<explicit>"],
        bundles: explicit.map((path) => {
          const absolute = resolve(path);
          return { path: toRepoRelative(repoRoot, absolute), source: undefined, absolute };
        }),
      }
    : (() => {
        const { roots, bundles } = discoverDompurifyBundles({ cwd: repoRoot });
        return {
          roots,
          bundles: bundles.map((bundle) => ({
            ...bundle,
            absolute: resolve(repoRoot, bundle.path),
          })),
        };
      })();

  if (discovered.bundles.length === 0) {
    fail(
      `no committed bundle under the shipped roots (${discovered.roots.join(", ")}) `
        + "carries DOMPurify — the vendored bundle is missing or was moved, so the "
        + "gate has nothing to check. Rebuild with: npm run build:vendor-toastui",
    );
  } else {
    process.stdout.write(
      `INFO derived ${discovered.roots.length} shipped scan root(s) from `
        + `package.json files[] + deploy-site.yaml publish_dir\n`
        + `INFO discovered ${discovered.bundles.length} committed bundle(s) carrying DOMPurify\n`,
    );
  }

  for (const bundle of discovered.bundles) {
    const { absolute, path: label } = bundle;
    try {
      const source = bundle.source ?? readFileSync(absolute, "utf8");
      const result = inspectDompurifyBundle(source, label);
      const found = result.versions.length ? result.versions.join(", ") : "no version markers";
      if (result.ok) {
        process.stdout.write(
          `PASS ${label}: DOMPurify ${found} (minimum ${DOMPURIFY_MIN_VERSION})\n`,
        );
      } else {
        fail(`${label}: ${result.reason}; found ${found}`);
      }
    } catch (error) {
      fail(`${label}: cannot read bundle: ${error.message}`);
    }
  }

  // BUNDLE_TARGETS is the canonical pair the rebuild script writes. Checking it
  // IN ADDITION to the scan keeps the ui/ <-> site/ui drift assertion alive: the
  // scan reports whichever copies exist, but only this pair asserts they are the
  // same bytes.
  if (explicit.length === 0) {
    const [uiBytes, siteBytes] = BUNDLE_TARGETS.map((p) => readFileSync(p));
    if (Buffer.compare(uiBytes, siteBytes) !== 0) {
      fail(
        `${toRepoRelative(repoRoot, BUNDLE_TARGETS[0])} and `
          + `${toRepoRelative(repoRoot, BUNDLE_TARGETS[1])} are not byte-identical; `
          + "Pages would ship different bytes than the npm tarball",
      );
    }
  }
}

// ── Lockfiles ────────────────────────────────────────────────────────────────
// Every dompurify entry in EVERY tracked lockfile must clear the floor. A nested
// `node_modules/<pkg>/node_modules/dompurify` entry is exactly how the 2.5.9 copy
// hid from the root pin, so all of them are checked, not just the root — and the
// set of lockfiles is discovered, so `desktop/package-lock.json` is covered the
// same way as the root one.
let lockfiles = [];
try {
  lockfiles = listRepoLockfiles();
} catch (error) {
  fail(`cannot enumerate lockfiles: ${error.message}`);
}

for (const relativePath of lockfiles) {
  const lockfilePath = resolve(repoRoot, relativePath);
  try {
    const lock = JSON.parse(readFileSync(lockfilePath, "utf8"));
    const entries = Object.entries(lock.packages || {}).filter(([key]) =>
      /(^|\/)node_modules\/dompurify$/.test(key),
    );
    if (entries.length === 0) {
      // Not every shipped package pulls dompurify, so an empty lockfile is only a
      // finding when that package's OWN manifest declares it. `desktop/package.json`
      // depends only on electron-updater today, so it legitimately has none — but
      // if the root manifest declared dompurify and the lockfile stopped resolving
      // it, that is exactly the drift this gate exists to catch, not a pass.
      const manifestPath = resolve(repoRoot, dirname(relativePath), "package.json");
      let declared = false;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        declared = hasDompurifyDependency(manifest);
      } catch {
        declared = false;
      }
      if (declared) {
        fail(
          `${relativePath}: ${manifestPath.replace(`${repoRoot}${sep}`, "")} declares `
            + "dompurify but the lockfile resolves no dompurify entry — the installed "
            + "set cannot be verified",
        );
      } else {
        process.stdout.write(
          `INFO ${relativePath}: no dompurify declared or resolved (nothing to check)\n`,
        );
      }
      continue;
    }
    for (const [key, value] of entries) {
      const version = value?.version;
      const result = inspectDompurifyBundle(
        `/*! @license DOMPurify ${version} */ n.version="${version}",n.removed=[]`,
        key,
      );
      if (result.ok) {
        process.stdout.write(`PASS ${relativePath}: ${key} -> ${version}\n`);
      } else {
        fail(`${relativePath}: ${key} -> ${version} is below required floor ${DOMPURIFY_MIN_VERSION}`);
      }
    }
  } catch (error) {
    fail(`${relativePath}: cannot read lockfile: ${error.message}`);
  }
}

// ── Advisory data provenance ────────────────────────────────────────────────
// The floor above is only as good as the advisory snapshot behind it, and nothing
// else in this repo re-checks that snapshot. So the gate states its own age and
// fails if the data is older than the staleness window: a year-old advisory list
// is an open gate that still reports PASS.
const ADVISORY_STALENESS_DAYS = 90;
try {
  const data = loadAdvisoryData();
  const ageDays = Math.floor((Date.now() - Date.parse(data.generatedAt)) / 86_400_000);
  if (!Number.isFinite(ageDays) || ageDays > ADVISORY_STALENESS_DAYS) {
    fail(
      `${ADVISORY_DATA_PATH}: advisory data is ${ageDays} days old `
        + `(generated ${data.generatedAt}); it must be under ${ADVISORY_STALENESS_DAYS}. `
        + "Refresh with: npm run refresh:dompurify-advisories",
    );
  } else {
    process.stdout.write(
      `PASS ${toRepoRelative(repoRoot, ADVISORY_DATA_PATH)}: ${data.advisories.length} advisories, `
        + `generated ${data.generatedAt} (${ageDays} days old)\n`,
    );
  }
} catch (error) {
  fail(`${toRepoRelative(repoRoot, ADVISORY_DATA_PATH)}: cannot read advisory data: ${error.message}`);
}

if (failed) {
  process.stderr.write(
    `\nVendored DOMPurify is below the floor ${DOMPURIFY_MIN_VERSION}.\n`
      + "Rebuild with: npm run build:vendor-toastui\n"
      + "A vendored bundle is invisible to dependabot, so this gate is the only\n"
      + "channel that will report it.\n",
  );
  process.exitCode = 1;
}