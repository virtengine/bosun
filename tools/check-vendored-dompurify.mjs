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
 *   1. every committed bundle under the shipped roots that mentions DOMPurify
 *      (DISCOVERED by content from the tracked tree — see
 *      tools/dompurify-discovery.mjs), and
 *   2. the lockfile, so a re-resolved nested 2.x copy is caught too.
 *
 * The bundle set is discovered, not declared. A hardcoded two-path list is the
 * same shape of assumption that caused the original exposure: it produced exit 0
 * and a green suite for a genuine 2.3.3 bundle committed at a third, unlisted
 * path that still reached the npm tarball and GitHub Pages. BUNDLE_TARGETS is
 * still checked, as an ADDITIONAL byte-identity assertion, so ui/ <-> site/ui
 * drift protection is not silently lost by the scan.
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

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BUNDLE_TARGETS } from "./build-vendor-toastui.mjs";
import { ADVISORY_DATA_PATH, loadAdvisoryData } from "./dompurify-advisories.mjs";
import { discoverDompurifyBundles, toRepoRelative } from "./dompurify-discovery.mjs";
import { DOMPURIFY_MIN_VERSION, inspectDompurifyBundle } from "./dompurify-floor.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const lockfileOnly = args.includes("--lockfile-only");
const explicit = args.filter((a) => !a.startsWith("--"));
const lockfilePath = resolve(repoRoot, "package-lock.json");

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
    ? explicit.map((path) => {
        const absolute = resolve(path);
        return { absolute, label: toRepoRelative(repoRoot, absolute), source: undefined };
      })
    : discoverDompurifyBundles({ cwd: repoRoot }).map((bundle) => {
        const absolute = resolve(repoRoot, bundle.path);
        return { absolute, label: toRepoRelative(repoRoot, absolute), source: bundle.source };
      });

  if (discovered.length === 0) {
    fail(
      "no committed bundle under the shipped roots mentions DOMPurify — "
        + "the vendored bundle is missing or was moved, so the gate has nothing to check. "
        + "Rebuild with: npm run build:vendor-toastui",
    );
  } else {
    process.stdout.write(
      `INFO discovered ${discovered.length} committed bundle(s) mentioning DOMPurify\n`,
    );
  }

  for (const bundle of discovered) {
    const { absolute, label } = bundle;
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

// ── Lockfile ─────────────────────────────────────────────────────────────────
// Every dompurify entry in the lockfile must clear the floor. A nested
// `node_modules/<pkg>/node_modules/dompurify` entry is exactly how the 2.5.9
// copy hid from the root pin, so all of them are checked, not just the root.
try {
  const lock = JSON.parse(readFileSync(lockfilePath, "utf8"));
  const entries = Object.entries(lock.packages || {}).filter(([key]) =>
    /(^|\/)node_modules\/dompurify$/.test(key),
  );
  if (entries.length === 0) {
    fail(`${lockfilePath}: no dompurify entry found — cannot verify the installed set`);
  }
  for (const [key, value] of entries) {
    const version = value?.version;
    const result = inspectDompurifyBundle(
      `/*! @license DOMPurify ${version} */ n.version="${version}",n.removed=[]`,
      key,
    );
    if (result.ok) {
      process.stdout.write(`PASS ${lockfilePath}: ${key} -> ${version}\n`);
    } else {
      fail(
        `${lockfilePath}: ${key} -> ${version} is below required floor ${DOMPURIFY_MIN_VERSION}`,
      );
    }
  }
} catch (error) {
  fail(`${lockfilePath}: cannot read lockfile: ${error.message}`);
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
      `PASS ${ADVISORY_DATA_PATH}: ${data.advisories.length} advisories, `
        + `generated ${data.generatedAt} (${ageDays} days old)\n`,
    );
  }
} catch (error) {
  fail(`${ADVISORY_DATA_PATH}: cannot read advisory data: ${error.message}`);
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