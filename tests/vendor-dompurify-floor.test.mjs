import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
  BUNDLE_TARGETS,
  forceDompurifyVersion,
  readInstalledDompurifyVersions,
  TOASTUI_TAG,
} from "../tools/build-vendor-toastui.mjs";
import {
  advisoriesAffecting,
  DOMPURIFY_MIN_VERSION,
  DOMPURIFY_VERSION,
  inspectDompurifyBundle,
} from "../tools/dompurify-floor.mjs";
import {
  ADVISORY_DATA_PATH,
  advisoryAffects,
  deriveAdvisoryFloor,
  parseVulnerableRange,
} from "../tools/dompurify-advisories.mjs";
import { readFileSync } from "node:fs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * The floor is a security control with no second line of defence: dependabot reads
 * package-lock.json only, so a DOMPurify inside the vendored bundle is reported by
 * nothing else. It is therefore DERIVED from tools/dompurify-advisories.json rather
 * than typed in, and pinned below to a literal that a human must re-derive when the
 * data moves. An earlier literal-only floor sat at 3.4.13 — the exact lower bound of
 * GHSA-p98j-92pf-mc4p — and these tests were structurally incapable of noticing,
 * because they fed the constant to itself on both sides of the assertion.
 */
describe("DOMPurify floor is derived from advisory data, not asserted", () => {
  it("derives the floor from the committed advisory data", () => {
    expect(DOMPURIFY_MIN_VERSION).toBe(deriveAdvisoryFloor());
  });

  it("matches an independently re-derived literal, so stale data cannot pass silently", () => {
    // Re-derive by hand from the data as of 2026-10-02: the newest advisory is
    // GHSA-p98j-92pf-mc4p (>= 3.4.13, <= 3.4.15, first patched 3.4.16), so the
    // lowest 3.x version clearing every recorded range is 3.4.16. If `npm run
    // refresh:dompurify-advisories` moves the floor, THIS assertion fails and
    // demands a conscious re-derivation — which is the whole point.
    expect(DOMPURIFY_MIN_VERSION).toBe("3.4.16");
  });

  it("no version inside the newest advisory's range is acceptable", () => {
    // The regression this test exists for: floor 3.4.13 admitted 3.4.13/14/15.
    for (const version of ["3.4.13", "3.4.14", "3.4.15"]) {
      expect(advisoriesAffecting(version).map((a) => a.ghsaId)).toContain("GHSA-p98j-92pf-mc4p");
      const result = inspectDompurifyBundle(
        `/*! @license DOMPurify ${version} */ n.version="${version}",n.removed=[]`,
        "fixture.js",
      );
      expect(result.ok, `${version} is inside GHSA-p98j-92pf-mc4p but passed the gate`).toBe(false);
    }
  });

  it("rejects the pre-3.4.16 floor values a literal floor used to allow", () => {
    // Proven by mutation: with the floor moved back to 3.4.12 (itself inside
    // GHSA-55q2-fjhq-7xh7) the previous suite stayed 14/14 green.
    for (const version of ["3.4.11", "3.4.12"]) {
      expect(advisoriesAffecting(version).length).toBeGreaterThan(0);
      expect(
        inspectDompurifyBundle(
          `/*! @license DOMPurify ${version} */ n.version="${version}",n.removed=[]`,
          "fixture.js",
        ).ok,
      ).toBe(false);
    }
  });

  it("keeps the rebuild target at or above the derived floor", () => {
    expect(compare(DOMPURIFY_VERSION, DOMPURIFY_MIN_VERSION)).toBeGreaterThanOrEqual(0);
    expect(advisoriesAffecting(DOMPURIFY_VERSION)).toEqual([]);
  });

  it("fails closed on advisory data it cannot evaluate", () => {
    // A silently-skipped advisory is a silently-open gate, so an unparseable range
    // must throw rather than be ignored.
    expect(() => parseVulnerableRange("^3.0.0 || <2.0.0", "GHSA-test")).toThrow(/unsupported/);
    expect(() => parseVulnerableRange("", "GHSA-test")).toThrow(/missing/);
    expect(() => advisoryAffects({ ghsaId: "GHSA-test", ranges: [{ vulnerableVersionRange: "garbage" }] }, "3.4.16")).toThrow();
  });

  it("evaluates multi-clause ranges as a conjunction", () => {
    const advisory = {
      ghsaId: "GHSA-test",
      ranges: [{ vulnerableVersionRange: ">= 3.4.13, <= 3.4.15", firstPatchedVersion: "3.4.16" }],
    };
    expect(advisoryAffects(advisory, "3.4.12")).toBe(false);
    expect(advisoryAffects(advisory, "3.4.13")).toBe(true);
    expect(advisoryAffects(advisory, "3.4.15")).toBe(true);
    expect(advisoryAffects(advisory, "3.4.16")).toBe(false);
  });

  it("records real advisory records with dated provenance", () => {
    const data = JSON.parse(readFileSync(ADVISORY_DATA_PATH, "utf8"));
    expect(data.advisories.length).toBeGreaterThan(20);
    expect(Date.parse(data.generatedAt)).not.toBeNaN();
    for (const advisory of data.advisories) {
      expect(advisory.ghsaId).toMatch(/^GHSA-/);
      expect(advisory.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(advisory.ranges.length).toBeGreaterThan(0);
    }
  });
});

function compare(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

describe("vendored DOMPurify floor", () => {
  it("accepts the derived minimum floor version itself", () => {
    const result = inspectDompurifyBundle(
      `/*! @license DOMPurify ${DOMPURIFY_MIN_VERSION} */ n.version="${DOMPURIFY_MIN_VERSION}",n.removed=[]`,
      "fixture.js",
    );
    expect(result.ok).toBe(true);
    expect(result.versions).toEqual([DOMPURIFY_MIN_VERSION, DOMPURIFY_MIN_VERSION]);
  });

  it("rejects a bundle containing a pre-floor implementation marker", () => {
    const result = inspectDompurifyBundle(
      '/*! @license DOMPurify 2.3.3 */ n.version="2.3.3",n.removed=[]',
      "fixture.js",
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(
      // Escape every regex metacharacter, not just the dots: CodeQL's
      // "Incomplete string escaping or encoding" (js/incomplete-sanitization)
      // flags a hand-rolled `replace(/\./g)` because it leaves backslashes and
      // the rest of the metacharacter set unescaped. This is the same idiom used
      // by config/repo-config.mjs:escapeRegex and workflow-canvas-utils.mjs.
      new RegExp(`below required floor ${DOMPURIFY_MIN_VERSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
  });

  it("rejects the nested lockfile version that used to be pinned at 2.5.9", () => {
    const result = inspectDompurifyBundle(
      '/*! @license DOMPurify 2.5.9 */ n.version="2.5.9",n.removed=[]',
      "fixture.js",
    );
    expect(result.ok).toBe(false);
  });

  it("rejects missing or inconsistent version markers", () => {
    expect(inspectDompurifyBundle("not a sanitizer", "fixture.js").ok).toBe(false);
    // A bundle whose banner marker was rewritten but whose runtime version was
    // not is exactly the "cosmetic string substitution" failure mode.
    expect(
      inspectDompurifyBundle(
        `/*! @license DOMPurify ${DOMPURIFY_VERSION} */ n.version="2.3.3",n.removed=[]`,
        "fixture.js",
      ).ok,
    ).toBe(false);
  });
});

describe("regeneration inputs", () => {
  // The gate prints `npm run build:vendor-toastui` as its remediation command, so
  // the regeneration path must actually be runnable. nhn/tui.editor tags each
  // package in the monorepo as `editor@<version>`; there is no `v<version>` tag,
  // and a wrong tag makes `git clone --branch` fail before npm ever runs.
  it("pins an upstream tag that exists in nhn/tui.editor", () => {
    expect(TOASTUI_TAG).toBe("editor@3.2.2");
    expect(TOASTUI_TAG).not.toMatch(/^v\d/);
  });
});

describe("committed vendored bundles", () => {
  it("covers every committed bundle location", () => {
    expect(BUNDLE_TARGETS.map((p) => p.replace(REPO_ROOT, "").replace(/\\/g, "/"))).toEqual([
      "/ui/assets/toastui-editor-all.min.js",
      "/site/ui/assets/toastui-editor-all.min.js",
    ]);
  });

  for (const bundlePath of BUNDLE_TARGETS) {
    const label = bundlePath.replace(REPO_ROOT, "");
    it(`ships DOMPurify at or above the floor in ${label}`, () => {
      const source = readFileSync(bundlePath, "utf8");
      const result = inspectDompurifyBundle(source, label);
      expect(result.ok, `${label}: ${result.reason}`).toBe(true);
      // The banner marker and the runtime `.version` marker must agree, so a
      // substring rewrite of the banner alone cannot pass this gate.
      expect(result.versions).toEqual([DOMPURIFY_VERSION, DOMPURIFY_VERSION]);
    });
  }

  it("keeps ui/ and site/ui byte-identical so Pages ships what the gate checked", () => {
    const [ui, site] = BUNDLE_TARGETS.map((p) => readFileSync(p));
    expect(Buffer.compare(ui, site)).toBe(0);
  });
});

/**
 * Behavioural coverage for the upstream tree fix-up.
 *
 * The defect this guards against was NOT a constant: a root `overrides` entry
 * written into nhn/tui.editor's package.json is silently ignored by npm because
 * the lockfile it commits predates the override, so `npm install` "succeeds" and
 * leaves DOMPurify 2.3.3 installed. A test that only pins a string constant
 * cannot see that — the whole defect lived in code such a test never executes.
 * These tests build a tree shaped like the real upstream one and assert on what
 * `forceDompurifyVersion()` actually does to it.
 */
describe("upstream tree dompurify force-up", () => {
  const realTrees = [];

  function makeTree(versions) {
    const root = mkdtempSync(join(tmpdir(), "bosun-tui-fixture-"));
    realTrees.push(root);
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "fixture" }, null, 2)}\n`);
    for (const [relativePath, version] of Object.entries(versions)) {
      const target = join(root, relativePath);
      mkdirSync(target, { recursive: true });
      writeFileSync(
        join(target, "package.json"),
        `${JSON.stringify({ name: "dompurify", version }, null, 2)}\n`,
      );
    }
    return root;
  }

  /** Shapes the tree exactly as `nhn/tui.editor@editor@3.2.2` resolves it. */
  const STALE_UPSTREAM_TREE = {
    "node_modules/dompurify": "2.3.3",
    "node_modules/@toast-ui/editor/node_modules/dompurify": "2.3.3",
  };

  it("sees both the hoisted and the nested dompurify, not just one", () => {
    const root = makeTree(STALE_UPSTREAM_TREE);
    const found = readInstalledDompurifyVersions(root);
    // Webpack resolves the nested copy first, so a check that only looked at the
    // hoisted one would have reported a clean tree while shipping 2.x.
    expect(found).toHaveLength(2);
    expect(found.map((entry) => entry.version).sort()).toEqual(["2.3.3", "2.3.3"]);
    expect(found.some((entry) => entry.path.includes("@toast-ui"))).toBe(true);
  });

  it("lifts a stale 2.3.3 tree to the floor and removes the nested copy", () => {
    const root = makeTree(STALE_UPSTREAM_TREE);
    const logged = [];

    // Stand in for `npm install --no-save dompurify@<version>`: the hoisted copy
    // is replaced. Real npm leaves the nested copy alone, which is exactly why
    // forceDompurifyVersion has to delete it separately.
    const install = (workdir, version) => {
      writeFileSync(
        join(workdir, "node_modules", "dompurify", "package.json"),
        `${JSON.stringify({ name: "dompurify", version }, null, 2)}\n`,
      );
    };

    const installed = forceDompurifyVersion(root, { install, log: (m) => logged.push(m) });

    expect(installed.map((entry) => entry.version)).toEqual([DOMPURIFY_VERSION]);
    expect(readInstalledDompurifyVersions(root).map((e) => e.version)).toEqual([DOMPURIFY_VERSION]);
    expect(
      readInstalledDompurifyVersions(root).some((e) => e.path.includes("@toast-ui")),
    ).toBe(false);
    // The pre-build assertion must state what the tree actually holds, so an
    // operator can see the fix-up worked without re-reading the source.
    expect(logged.join("\n")).toContain(DOMPURIFY_VERSION);
  });

  it("fails loudly when the install leaves the tree below the floor", () => {
    const root = makeTree(STALE_UPSTREAM_TREE);
    // An installer that does nothing models the real npm behaviour against the
    // committed lockfile: the run "succeeds" and 2.3.3 is still there. The point
    // of the assertion is that this now fails HERE, at the source, instead of
    // 40 seconds later inside the bundle floor check.
    expect(() => forceDompurifyVersion(root, { install: () => {}, log: () => {} })).toThrow(
      /still carries/,
    );
  });

  it("fails when the tree has no dompurify at all rather than building blind", () => {
    const root = makeTree({});
    expect(() => forceDompurifyVersion(root, { install: () => {}, log: () => {} })).toThrow(
      /no dompurify found/,
    );
  });

  it("removes a below-floor NESTED copy even when the hoisted root is already fine", () => {
    // Real npm does not touch the nested copy, so a tree can reach webpack with
    // a clean root and a live 2.x underneath — and webpack resolves the nested
    // one first. The deletion is what saves us here, so assert on its result
    // rather than on a throw that cannot happen once the copy is gone.
    const root = makeTree({
      "node_modules/dompurify": DOMPURIFY_VERSION,
      "node_modules/@toast-ui/editor/node_modules/dompurify": "2.3.3",
    });

    const installed = forceDompurifyVersion(root, { install: () => {}, log: () => {} });

    expect(installed.map((entry) => entry.version)).toEqual([DOMPURIFY_VERSION]);
    expect(installed.some((entry) => entry.path.includes("@toast-ui"))).toBe(false);
  });

  afterAll(() => {
    for (const root of realTrees) rmSync(root, { recursive: true, force: true });
  });
});
