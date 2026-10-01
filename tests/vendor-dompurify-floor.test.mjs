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
  DOMPURIFY_MIN_VERSION,
  DOMPURIFY_VERSION,
  inspectDompurifyBundle,
} from "../tools/dompurify-floor.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

describe("vendored DOMPurify floor", () => {
  it("accepts the minimum unconditionally patched version", () => {
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
