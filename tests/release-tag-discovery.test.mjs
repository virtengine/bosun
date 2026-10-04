import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Release-tag discovery in the SHIPPED workflow templates.
 *
 * `git describe --tags --abbrev=0` returns the nearest reachable tag of ANY
 * name. Bosun's own repo carries a stray bare `v` tag (commit 136a15dd) that IS
 * an ancestor of develop, so the unconstrained form returns `v` — and the
 * release notes are then built with the last tag literally set to `v` and a
 * changelog range that is 844 commits instead of 984.
 *
 * The fix is `--match '<prefix>[0-9]*'`, which selects only release-shaped tags.
 * `--match` also FAILS SAFE on its own: when it selects nothing, git exits 128
 * rather than falling back to an arbitrary tag — so the existing `|| echo` /
 * `${VAR:-HEAD~50}` fallbacks must be kept. That is what this suite pins.
 *
 * These tests read the shipped template SOURCE, not a reimplementation of it,
 * because the defect is in the literal string handed to the agent/executor.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

const TEMPLATE_FILES = [
  "workflow-templates/github.mjs",
  "workflow-templates/ci-cd.mjs",
];

/** Every `git describe --tags --abbrev=0...` invocation across the templates. */
function describeInvocations() {
  const found = [];
  for (const rel of TEMPLATE_FILES) {
    const src = readFileSync(join(REPO, rel), "utf8");
    // Capture the base form plus whatever flags/quoting follow it, so a
    // detector can tell `--abbrev=0 --match 'v[0-9]*'` from a bare `--abbrev=0`.
    const re = /git describe --tags --abbrev=0[^\n]*/g;
    for (const m of src.matchAll(re)) {
      // Pull the surrounding line so a failure names the exact call site.
      const lineStart = src.lastIndexOf("\n", m.index) + 1;
      const lineEnd = src.indexOf("\n", m.index);
      const line = src.slice(lineStart, lineEnd === -1 ? src.length : lineEnd).trim();
      // Stop at the shell terminator so a trailing fallback clause does not
      // become part of the invocation; keep the flags themselves.
      const invocation = m[0].split(/\s*\|\||\s*;\s/)[0].trim();
      found.push({ file: rel, invocation, line });
    }
  }
  return found;
}

describe("shipped templates discover the last RELEASE tag", () => {
  it("finds at least one git describe invocation to police (never vacuous)", () => {
    // A guard that passes because it matched nothing is decoration. If a future
    // refactor moves every describe out of these files, this fails loudly.
    expect(describeInvocations().length).toBeGreaterThan(0);
  });

  it("constrains every git describe --tags to a release-shaped tag pattern", () => {
    const offenders = describeInvocations().filter(
      ({ invocation }) => !/--match\s+/.test(invocation),
    );
    expect(
      offenders.map((o) => `${o.file}: ${o.line}`),
    ).toEqual([]);
  });

  it("keeps a fallback on every constrained describe (fail-safe, not fail-open)", () => {
    // `--match` exits 128 when it selects nothing. If the guard on that is
    // dropped, the template would substitute an EMPTY range and silently
    // produce an empty changelog / empty last-tag instead of degrading.
    for (const rel of TEMPLATE_FILES) {
      const src = readFileSync(join(REPO, rel), "utf8");
      for (const line of src.split("\n")) {
        if (!/git describe --tags --abbrev=0/.test(line)) continue;
        const hasFallback =
          /\|\|\s*echo/.test(line) || /HEAD~50/.test(line) || /:-HEAD~50\}/.test(line);
        expect(
          hasFallback,
          `describe without a fallback in ${rel}: ${line.trim()}`,
        ).toBe(true);
      }
    }
  });

  it("matches tags that actually carry the release prefix and a digit", () => {
    // The pattern must be anchored to the shape we mean to accept; a pattern
    // that also matches a bare `v` would pass the checks above while
    // reproducing the exact bug.
    const { invocation } = describeInvocations()[0];
    expect(invocation).toMatch(/--match\s+'?\{\{releasePrefix\}\}\[0-9\]\*'?|--match\s+'v\[0-9\]\*'/);
  });
});