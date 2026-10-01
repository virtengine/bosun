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
 *   1. the committed vendored bundles (ui/assets + site/ui/assets), and
 *   2. the lockfile, so a re-resolved nested 2.x copy is caught too.
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
if (!lockfileOnly) {
  const bundles = explicit.length > 0 ? explicit.map((p) => resolve(p)) : BUNDLE_TARGETS;
  for (const bundlePath of bundles) {
    try {
      const source = readFileSync(bundlePath, "utf8");
      const result = inspectDompurifyBundle(source, bundlePath);
      const found = result.versions.length ? result.versions.join(", ") : "no version markers";
      if (result.ok) {
        process.stdout.write(
          `PASS ${bundlePath}: DOMPurify ${found} (minimum ${DOMPURIFY_MIN_VERSION})\n`,
        );
      } else {
        fail(`${bundlePath}: ${result.reason}; found ${found}`);
      }
    } catch (error) {
      fail(`${bundlePath}: cannot read bundle: ${error.message}`);
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

if (failed) {
  process.stderr.write(
    `\nVendored DOMPurify is below the floor ${DOMPURIFY_MIN_VERSION}.\n`
      + "Rebuild with: npm run build:vendor-toastui\n"
      + "A vendored bundle is invisible to dependabot, so this gate is the only\n"
      + "channel that will report it.\n",
  );
  process.exitCode = 1;
}
