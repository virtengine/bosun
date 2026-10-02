#!/usr/bin/env node
/**
 * refresh-dompurify-advisories.mjs — regenerate tools/dompurify-advisories.json
 * from the GitHub Advisory Database.
 *
 * The floor gate is the ONLY channel that can see DOMPurify inside the vendored
 * browser bundle (dependabot reads package-lock.json and nothing else), so the
 * data behind that floor has to be refreshable, not written once and forgotten.
 *
 * Run this whenever dompurify publishes, and expect `DOMPURIFY_MIN_VERSION` /
 * `DOMPURIFY_VERSION` in tools/dompurify-floor.mjs to move if the derivation
 * changed — the tests fail loudly when they disagree, which is the point.
 *
 * Requires the `gh` CLI to be authenticated. Never fails the build silently: a
 * non-zero exit here means the committed data is now stale, not that it is fine.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUTPUT_PATH = fileURLToPath(new URL("./dompurify-advisories.json", import.meta.url));
const LIST_ENDPOINT = "/advisories?ecosystem=npm&affects=dompurify&per_page=100";

function gh(args) {
  return JSON.parse(execFileSync("gh", ["api", args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
}

const listed = gh(LIST_ENDPOINT);
if (!Array.isArray(listed) || listed.length === 0) {
  throw new Error(`${LIST_ENDPOINT} returned no advisories — refusing to overwrite the committed data`);
}

const advisories = listed.map((entry) => {
  // The list endpoint omits per-package ranges, so each advisory is fetched in full.
  const detail = gh(`/advisories/${entry.ghsa_id}`);
  const ranges = (detail.vulnerabilities || [])
    .filter((vulnerability) => vulnerability.package?.name === "dompurify")
    .map((vulnerability) => ({
      vulnerableVersionRange: vulnerability.vulnerable_version_range,
      firstPatchedVersion: vulnerability.first_patched_version,
    }));
  if (ranges.length === 0) {
    throw new Error(`${detail.ghsa_id} has no dompurify vulnerability range; refusing to record it as empty`);
  }
  return {
    ghsaId: detail.ghsa_id,
    severity: detail.severity,
    publishedAt: detail.published_at,
    htmlUrl: detail.html_url,
    ranges,
  };
});

advisories.sort((left, right) => String(left.publishedAt).localeCompare(String(right.publishedAt)));

const document = {
  generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  source: `gh api "${LIST_ENDPOINT}"`,
  regenerateWith: "npm run refresh:dompurify-advisories",
  advisories,
};

writeFileSync(OUTPUT_PATH, `${JSON.stringify(document, null, 2)}\n`, "utf8");
process.stdout.write(`Wrote ${advisories.length} advisories to ${OUTPUT_PATH}\n`);
process.stdout.write("Now re-run: node tools/check-vendored-dompurify.mjs\n");
