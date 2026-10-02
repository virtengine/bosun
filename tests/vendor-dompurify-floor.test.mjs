import { execFileSync } from "node:child_process";
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
import {
  assertChannelsAccounted,
  assertScanRootsCover,
  classifyDompurifyCandidate,
  deriveContainerScanRoots,
  deriveScanRoots,
  discoverDompurifyBundles,
  findDompurifyBundles,
  listTopLevelSegments,
  listTrackedVendoredFiles,
  MINIMUM_SCAN_ROOTS,
  PACKAGE_MANIFEST,
  PAGES_WORKFLOW,
  DOCKER_IGNORE,
  DOCKERFILE,
  parseDockerignore,
  readPublishDir,
  resolveScanChannels,
  resolveScanRoots,
} from "../tools/dompurify-discovery.mjs";

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

/**
 * The bundle set must be DISCOVERED, not declared — and so must the ROOTS it is
 * discovered under.
 *
 * Two hand-maintained lists have already failed here, each the previous fix's
 * shape one level up. Hardcoded bundle PATHS missed `ui/assets/vendor/…`;
 * replacing those with hardcoded scan ROOTS (`["ui","site"]`) missed `tui/` and
 * `native/`, which package.json `files[]` ships and which therefore reach the npm
 * tarball. A genuine DOMPurify 2.3.3 bundle committed at
 * `tui/vendor-dompurify-probe.min.js` gave gate exit 0 and a green suite.
 *
 * So the roots are derived from the repo's own declaration of what ships:
 * package.json `files[]` plus the Pages `publish_dir`. MINIMUM_SCAN_ROOTS
 * survives only as an asserted floor, and these tests pin both halves: the
 * derivation, and the requirement that a newly added `files[]` root is covered
 * without editing the tool.
 */
describe("vendored bundle discovery roots are derived, not declared", () => {
  const MANIFEST = readFileSync(resolve(REPO_ROOT, PACKAGE_MANIFEST), "utf8");
  const WORKFLOW = readFileSync(resolve(REPO_ROOT, PAGES_WORKFLOW), "utf8");

  it("derives roots from package.json files[] and the Pages publish_dir", () => {
    const manifest = JSON.parse(MANIFEST);
    const publishDir = readPublishDir(WORKFLOW);

    expect(publishDir).toBe("site");
    const roots = deriveScanRoots({ manifest, publishDir });

    // Every shipped top-level segment, from both sources.
    expect(roots).toContain("ui");
    expect(roots).toContain("tui");
    expect(roots).toContain("native");
    expect(roots).toContain("tools");
    expect(roots).toContain("site");
    expect(roots).toContain("desktop");
    expect(roots.length).toBeGreaterThan(20);
    expect([...roots]).toEqual([...roots].sort());
    expect(new Set(roots).size).toBe(roots.length);
  });

  it("covers every root the previous hardcoded list enumerated, asserted not assumed", () => {
    // MINIMUM_SCAN_ROOTS is the documented floor the derivation must never drop
    // below; assertScanRootsCover throws if it does. This test is that assertion
    // against the REAL manifest, so deleting `ui/` from files[] — which stops it
    // shipping and would otherwise stop it being checked — fails here.
    expect(assertScanRootsCover(resolveScanRoots({ cwd: REPO_ROOT }))).toContain("ui");
    expect(() => assertScanRootsCover(["tui", "site"])).toThrow(/do not cover/);
    expect(() => assertScanRootsCover(["ui"])).toThrow(/do not cover.*site/s);
  });

  it("covers a NEWLY ADDED files[] root without editing the tool", () => {
    // The regression the whole derivation exists for. A root the tool has never
    // heard of is picked up from the manifest alone — this test fails if anyone
    // reintroduces a literal list, because a literal cannot know about
    // `shiny-new-root/`.
    const manifest = { files: ["ui/", "site/", "shiny-new-root/", "cli.mjs"] };
    const roots = deriveScanRoots({ manifest, publishDir: "site" });
    expect(roots).toContain("shiny-new-root");
    expect(roots).toContain("cli.mjs");

    // And discovery then reports a below-floor bundle planted in it, by name.
    const found = findDompurifyBundles({
      files: ["shiny-new-root/bundle.min.js"],
      readFile: () => '/*! @license DOMPurify 2.3.3 | (c) Cure53 */\nn.version="2.3.3",n.removed=[]\n',
      roots,
    });
    expect(found.map((b) => b.path)).toEqual(["shiny-new-root/bundle.min.js"]);
    expect(inspectDompurifyBundle(found[0].source, found[0].path).ok).toBe(false);
  });

  it("refuses to guess when the manifest or the workflow stops declaring its roots", () => {
    // Fail closed rather than falling back to a hardcoded list — that fallback
    // is exactly the defect being removed.
    // deriveScanRoots stays pure; the floor check is assertScanRootsCover's job,
    // and a derivation that cannot cover the floor must be rejected by it.
    expect(deriveScanRoots({ manifest: { files: [] }, publishDir: "site" })).toEqual(["site"]);
    expect(() => assertScanRootsCover(deriveScanRoots({ manifest: { files: [] }, publishDir: "site" })))
      .toThrow(/do not cover/);
    expect(() => deriveScanRoots({ manifest: {}, publishDir: "site" }))
      .toThrow(/no files\[\] array/);
    expect(() => readPublishDir("name: Deploy\n"))
      .toThrow(/no publish_dir found/);
  });

  it("enumerates tracked files under the DERIVED roots, not a fixed pair", () => {
    const roots = resolveScanRoots({ cwd: REPO_ROOT });
    const tracked = listTrackedVendoredFiles(REPO_ROOT, roots);
    expect(tracked.length).toBeGreaterThan(100);
    // Far wider than the old ["ui","site"] pair — that widening is the fix.
    const topLevel = new Set(tracked.map((p) => p.split("/")[0]));
    expect([...topLevel].sort()).toEqual(roots);
    for (const path of tracked) {
      expect(path.includes("\\")).toBe(false);
    }
    // And the specific root the previous literal list omitted is now included.
    expect(tracked.some((p) => p.startsWith("tui/"))).toBe(true);
  });
});

/**
 * The container image is the third shipping channel, and rounds 4, 5 and 6 of
 * review were this same finding at three granularities — hardcoded bundle paths,
 * then hardcoded scan roots, then an incomplete SET OF DECLARATIONS feeding the
 * roots. `package.json files[]` and `publish_dir` model the npm tarball and Pages
 * accurately; nothing modelled `COPY . .`, so a genuine DOMPurify 2.3.3 bundle
 * committed at `scripts/vendor-dompurify-probe.js` shipped inside
 * `virtengine/bosun:<sha>` with gate exit 0 and a green suite.
 *
 * These tests pin the third channel and, critically, the ASYMMETRY the reviewer
 * called out: `tests/` is excluded by `.dockerignore`, so widening the container
 * channel must NOT turn this gate's own marker-carrying test file into a FAIL.
 */
describe("the container channel is derived from .dockerignore, not declared", () => {
  const DOCKERIGNORE = readFileSync(resolve(REPO_ROOT, DOCKER_IGNORE), "utf8");
  const DOCKERFILE_SOURCE = readFileSync(resolve(REPO_ROOT, DOCKERFILE), "utf8");

  it("models the image as repo-minus-.dockerignore, from the declarations", () => {
    const segments = listTopLevelSegments(REPO_ROOT);
    const container = deriveContainerScanRoots({
      dockerignore: DOCKERIGNORE,
      segments,
    });

    // The premise the whole container model rests on: the Dockerfile copies the
    // whole build context, which is what makes the exclusion list meaningful.
    expect(/^\s*COPY\s+\.\s+\.\s*$/m.test(DOCKERFILE_SOURCE)).toBe(true);

    // Roots the image ships that NO other channel declares — this is the hole.
    for (const root of ["scripts", "bin", "core", "src", "plugins", "evidence"]) {
      expect(container).toContain(root);
    }
    // And .dockerignore's own exclusions are honoured.
    for (const root of ["tests", "docs", "desktop", "node_modules", "output"]) {
      expect(container).not.toContain(root);
    }
    expect(container.length).toBeGreaterThan(segments.length / 2);
  });

  it("covers a NEWLY ADDED shipping root with no edit to the tool", () => {
    // The regression the derivation exists for, at the container granularity: a
    // top-level directory nobody has ever heard of is scanned the day it is
    // tracked and not excluded, because the set is computed from the tree.
    const container = deriveContainerScanRoots({
      dockerignore: DOCKERIGNORE,
      segments: ["shiny-new-root", "tests", "docs"],
    });
    expect(container).toContain("shiny-new-root");

    // ...and a below-floor bundle planted there is reported, by name.
    const roots = deriveScanRoots({ manifest: { files: ["ui/"] }, publishDir: "site", containerRoots: container });
    const found = findDompurifyBundles({
      files: ["shiny-new-root/bundle.min.js"],
      readFile: () => '/*! @license DOMPurify 2.3.3 | (c) Cure53 */\nn.version="2.3.3",n.removed=[]\n',
      roots,
    });
    expect(found.map((b) => b.path)).toEqual(["shiny-new-root/bundle.min.js"]);
    expect(inspectDompurifyBundle(found[0].source, found[0].path).ok).toBe(false);
  });

  it("honours .dockerignore semantics: comments, dir-only, globs and negation", () => {
    const source = [
      "# a comment",
      "",
      "node_modules",
      "tests/",
      "*.log",
      "output/",
      "!output/keep.log",
    ].join("\n");
    const rules = parseDockerignore(source);
    // comment + blank lines dropped; negation and dir-only recorded.
    expect(rules).toHaveLength(5);

    const container = deriveContainerScanRoots({
      dockerignore: source,
      // `output` is a tracked DIRECTORY, so `output/` excludes the segment; the
      // negation is at file depth and does not resurrect the segment.
      segments: ["app", "tests", "debug.log", "output", "node_modules"],
    });
    expect(container).toEqual(["app"]);
  });

  it("keeps the ASYMMETRY: `tests/` is excluded, so the gate's own test file is not a FAIL", () => {
    // The reviewer required this direction explicitly. Widening the container
    // channel must not report `tests/vendor-dompurify-floor.test.mjs`, which does
    // carry a `@license DOMPurify 2.3.3` marker (as a fixture) and would be a
    // genuine below-floor FAIL if `tests/` were scanned.
    const { roots, channels } = resolveScanChannels({ cwd: REPO_ROOT });
    expect(channels.container).not.toContain("tests");
    expect(roots).not.toContain("tests");

    const tracked = listTrackedVendoredFiles(REPO_ROOT, roots);
    expect(tracked.some((p) => p.startsWith("tests/"))).toBe(false);

    // The gate really does pass on the committed tree with the container channel
    // active, so the widening is not reporting the repo's own marker strings.
    const bundles = findDompurifyBundles({
      files: tracked,
      readFile: (path) => readFileSync(resolve(REPO_ROOT, path), "utf8"),
      roots,
    });
    expect(bundles.map((b) => b.path)).toEqual([
      "site/ui/assets/toastui-editor-all.min.js",
      "ui/assets/toastui-editor-all.min.js",
    ]);
    for (const bundle of bundles) {
      expect(inspectDompurifyBundle(bundle.source, bundle.path).ok).toBe(true);
    }
  });

  it("finds a below-floor bundle committed at a CONTAINER-ONLY root (the round-6 repro)", () => {
    // Exactly the reviewer's reproduction, as a permanent regression test: the
    // genuine 2.3.3 bundle at `scripts/`, a root no channel declared before.
    const { roots } = resolveScanChannels({ cwd: REPO_ROOT });
    expect(roots).toContain("scripts");

    const found = findDompurifyBundles({
      files: ["scripts/vendor-dompurify-probe.js"],
      readFile: () => '/*! @license DOMPurify 2.3.3 | (c) Cure53 */\nn.version="2.3.3",n.removed=[]\n',
      roots,
    });
    expect(found).toHaveLength(1);
    const result = inspectDompurifyBundle(found[0].source, found[0].path);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/2\.3\.3 is below required floor/);
  });

  it("refuses to guess when a declaration stops saying what it says", () => {
    // Fail closed on each declaration rather than falling back to a literal.
    expect(() => parseDockerignore("# only comments\n\n")).toThrow(/declares no exclusions/);
    // A Dockerfile that stops copying the whole context invalidates the model
    // that .dockerignore describes, so the gate must stop rather than keep
    // reporting roots for a channel it no longer understands.
    expect(() => resolveScanChannels({
      cwd: REPO_ROOT,
      dockerfile: "FROM node:22\nWORKDIR /app\nCOPY package.json ./\n",
    })).toThrow(/no longer copies the whole build context/);
  });

  it("cannot have the container channel derived and then silently dropped", () => {
    // The load-bearing assertion. It compares two INDEPENDENT derivations — the
    // channel from .dockerignore, the scan set from the union of declarations —
    // so it genuinely fires when the union stops covering a channel.
    const { channels, roots } = resolveScanChannels({ cwd: REPO_ROOT });
    for (const channel of Object.keys(channels)) {
      for (const root of channels[channel]) {
        expect(roots).toContain(root);
      }
    }
    expect(() => assertChannelsAccounted(["scripts", "somebrandnewroot"], roots))
      .toThrow(/missing from the scan set/);
    expect(() => assertChannelsAccounted(["ui"], ["ui"])).not.toThrow();
  });

  it("refuses an empty container channel rather than checking almost nothing", () => {
    // If the matcher ever regressed into excluding everything, the gate would get
    // a short root list and still print PASS. This is the round-3 "assertion fed
    // its own input" shape, checked against the TREE instead.
    const everything = ["ui", "site", "scripts", "tools"];
    const excludedByAll = deriveContainerScanRoots({
      dockerignore: everything.map((r) => `${r}/`).join("\n"),
      segments: everything,
    });
    expect(excludedByAll).toEqual([]);
  });
});

/**
 * "Is this a bundle" must be a real discriminator, not "mentions DOMPurify".
 *
 * Widening the scan roots to everything that ships makes a mention-match useless:
 * this gate's own tools/*.mjs, tools/dompurify-advisories.json and this test file
 * all say "DOMPurify", and a naive match reports 7 false FAILs against files that
 * contain no sanitizer at all.
 */
describe("DOMPurify candidate detection discriminates", () => {
  const STALE_BUNDLE = '/*! @license DOMPurify 2.3.3 | (c) Cure53 */\nn.version="2.3.3",n.removed=[]\n';

  it("is not a candidate when the file merely mentions DOMPurify", () => {
    // The exact false-positive shape the reviewer's measurement produced.
    for (const source of [
      "// mentions DOMPurify in a comment\nexport const x = 1;\n",
      "/* bundled with DOMPurify somewhere */\nvar x = 1;\n",
      '{"firstPatchedVersion":"3.4.16"}\n',
    ]) {
      expect(classifyDompurifyCandidate(source).candidate).toBe(false);
    }
  });

  it("is a candidate for the banner, the runtime marker, or both", () => {
    expect(classifyDompurifyCandidate(STALE_BUNDLE)).toEqual({
      candidate: true, banner: true, runtime: true,
    });
    // Exactly ONE is still a candidate — that is the fail-closed half, so a
    // re-minifier that breaks one marker shape produces a REPORT, not a skip.
    expect(classifyDompurifyCandidate('/*! @license DOMPurify 3.4.16 */\nvar x=1;\n'))
      .toEqual({ candidate: true, banner: true, runtime: false });
    expect(classifyDompurifyCandidate('n.version="2.3.3",n.removed=[]\n'))
      .toEqual({ candidate: true, banner: false, runtime: true });
  });

  it("fails closed on a bundle whose markers do not both parse", () => {
    const found = findDompurifyBundles({
      files: ["ui/assets/oddball.min.js"],
      readFile: () => "/*! @license DOMPurify 3.4.16 */\nvar x = 1;\n",
    });
    expect(found).toHaveLength(1);
    const result = inspectDompurifyBundle(found[0].source, found[0].path);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/expected exactly one DOMPurify license marker/);
  });

  it("ignores files that carry no DOMPurify at all", () => {
    const found = findDompurifyBundles({
      files: ["ui/components/task-markdown.js", "ui/index.html"],
      readFile: () => "export const x = 1;\n",
    });
    expect(found).toEqual([]);
  });

  it("refuses to pass a tracked file it cannot read", () => {
    // `git ls-files` still lists a file deleted in the working tree, and the
    // working tree is what gets built and shipped.
    expect(() =>
      findDompurifyBundles({
        files: ["ui/assets/gone.min.js"],
        readFile: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toThrow(/cannot be read/);
  });
});

describe("vendored bundle discovery", () => {
  const STALE_BUNDLE = '/*! @license DOMPurify 2.3.3 | (c) Cure53 */\nn.version="2.3.3",n.removed=[]\n';

  it("finds a below-floor bundle committed at an UNLISTED path", () => {
    // The exact mutation that defeated the two-path gate.
    const files = [
      "ui/assets/toastui-editor-all.min.js",
      "ui/assets/vendor/markdown-editor.min.js",
      "site/ui/assets/toastui-editor-all.min.js",
    ];
    const contents = {
      "ui/assets/toastui-editor-all.min.js": STALE_BUNDLE.replace(/2\.3\.3/g, DOMPURIFY_VERSION),
      "ui/assets/vendor/markdown-editor.min.js": STALE_BUNDLE,
      "site/ui/assets/toastui-editor-all.min.js": STALE_BUNDLE.replace(/2\.3\.3/g, DOMPURIFY_VERSION),
    };
    const found = findDompurifyBundles({ files, readFile: (p) => contents[p] });

    expect(found.map((b) => b.path)).toEqual([
      "site/ui/assets/toastui-editor-all.min.js",
      "ui/assets/toastui-editor-all.min.js",
      "ui/assets/vendor/markdown-editor.min.js",
    ]);

    // And the floor check then fails THAT path by name — discovery is not just
    // enumeration, it feeds the same below-floor verdict the gate reports.
    const stale = found.find((b) => b.path.includes("vendor/"));
    const result = inspectDompurifyBundle(stale.source, stale.path);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/2\.3\.3/);
  });

  it("discovers the real committed bundles at BOTH known locations", () => {
    const { roots, bundles } = discoverDompurifyBundles({ cwd: REPO_ROOT });
    expect(roots.length).toBeGreaterThan(20);
    const paths = bundles.map((b) => b.path).sort();
    expect(paths).toEqual([
      "site/ui/assets/toastui-editor-all.min.js",
      "ui/assets/toastui-editor-all.min.js",
    ]);
    for (const bundle of bundles) {
      expect(inspectDompurifyBundle(bundle.source, bundle.path).ok, bundle.path).toBe(true);
    }
  });

  it("keeps MINIMUM_SCAN_ROOTS honest — it is a floor, not the scan list", () => {
    // If this ever equals the derived set the derivation has been collapsed back
    // into a literal, which is the defect class this whole change removes.
    expect(MINIMUM_SCAN_ROOTS).toEqual(["ui", "site"]);
    const derived = resolveScanRoots({ cwd: REPO_ROOT });
    expect(derived.length).toBeGreaterThan(MINIMUM_SCAN_ROOTS.length * 5);
  });
});

describe("committed vendored bundles", () => {
  it("keeps the canonical pair the rebuild script writes", () => {
    // BUNDLE_TARGETS is still checked BY the gate as an additional byte-identity
    // assertion (drift protection between ui/ and site/ui/). Discovery is
    // additive, not a replacement: dropping this pair would silently lose it.
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

describe("advisory refresh has a producer", () => {
  // The gate hard-fails once the advisory snapshot passes its 90-day staleness
  // window (2026-12-31 for the committed data). With no scheduled producer that
  // is a guaranteed red build on a date nobody is watching, so the workflow that
  // refreshes it is asserted here rather than left to a reviewer's grep.
  const workflow = readFileSync(resolve(REPO_ROOT, ".github/workflows/dependency-audit.yml"), "utf8");

  it("refreshes on the weekly schedule, not on every push", () => {
    expect(workflow).toMatch(/schedule:/);
    expect(workflow).toMatch(/cron:/);
    expect(workflow).toMatch(/dompurify-advisory-refresh:/);
    expect(workflow).toMatch(/github\.event_name == 'schedule'/);
  });

  it("runs the refresh command the module's error message tells operators to run", () => {
    expect(workflow).toMatch(/refresh:dompurify-advisories/);
  });

  it("opens a pull request instead of merging unattended", () => {
    expect(workflow).toMatch(/gh pr create/);
    expect(workflow).toMatch(/--base develop/);
    // The dangerous shapes: an auto-merge or a push straight to develop.
    expect(workflow).not.toMatch(/gh pr merge/);
    expect(workflow).not.toMatch(/--auto-merge/);
    expect(workflow).not.toMatch(/git push[^\\n]*\bdevelop\b/);
    expect(workflow).toMatch(/never auto-merged/i);
  });

  it("grants only what opening the PR needs", () => {
    expect(workflow).toMatch(/permissions:\s*\n\s+contents: write\s*\n\s+pull-requests: write/);
  });
});

/**
 * The gate's own remediation is "read every shipped bundle and every lockfile".
 * It hardcoded ONE lockfile — the root `package-lock.json` — while `desktop/` is a
 * shipped package with its own manifest and lockfile and is not a workspace member
 * of the root manifest. A gate that fails a nested 2.x copy in the root lockfile
 * while ignoring an identical one a directory over is the same class of narrow
 * assumption the card was filed for, so the lockfile set is discovered too.
 */
describe("lockfile coverage is discovered, not hardcoded to the root manifest", () => {
  it("checks desktop/package-lock.json as well as the root one", () => {
    const gate = readFileSync(resolve(REPO_ROOT, "tools/check-vendored-dompurify.mjs"), "utf8");
    // No bare hardcoded lockfile path left to read.
    expect(gate).not.toMatch(/resolve\(repoRoot,\s*"package-lock\.json"\)/);
    expect(gate).toMatch(/listRepoLockfiles/);

    // And the second shipped lockfile really exists and is really tracked, so
    // this is not a test of an empty set.
    const tracked = execFileSync(
      "git",
      ["ls-files", "-z", "--", "**/package-lock.json", "package-lock.json"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    ).split("\0").filter(Boolean).sort();
    expect(tracked).toContain("package-lock.json");
    expect(tracked).toContain("desktop/package-lock.json");
  });

  it("fails when a shipped manifest declares dompurify but the lockfile resolves none", () => {
    // `desktop/package.json` depends only on electron-updater today, so an empty
    // desktop lockfile is legitimate and reported as INFO. But if a manifest DID
    // declare dompurify and the lockfile stopped resolving it, that is the drift
    // the gate exists to catch — silence would be the wrong verdict there.
    const desktopManifest = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "desktop/package.json"), "utf8"),
    );
    const desktopDeps = Object.keys(desktopManifest.dependencies ?? {});
    expect(desktopDeps.some((d) => d.includes("dompurify"))).toBe(false);

    const desktopLock = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "desktop/package-lock.json"), "utf8"),
    );
    const entries = Object.keys(desktopLock.packages ?? {}).filter((k) =>
      /(^|\/)node_modules\/dompurify$/.test(k),
    );
    // Consistent with the manifest: nothing declared, nothing resolved.
    expect(entries).toEqual([]);
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
