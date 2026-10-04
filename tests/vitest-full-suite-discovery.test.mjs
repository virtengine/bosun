import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildVitestBatchArgs,
  buildVitestFullSuitePlan,
  listVitestSuiteFiles,
} from "../tools/vitest-full-suite.mjs";

const tempDirs = [];
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function createFixtureTree() {
  const root = mkdtempSync(resolve(tmpdir(), "bosun-suite-discovery-"));
  tempDirs.push(root);
  mkdirSync(resolve(root, "tests", "nested"), { recursive: true });
  mkdirSync(resolve(root, "tests", "fixtures"), { recursive: true });
  writeFileSync(resolve(root, "package.json"), JSON.stringify({ name: "fixture", private: true }));
  writeFileSync(resolve(root, "tests", "top.test.mjs"), "export default {};\n");
  writeFileSync(resolve(root, "tests", "node-only.node.test.mjs"), "export default {};\n");
  writeFileSync(resolve(root, "tests", "nested", "deep.test.mjs"), "export default {};\n");
  writeFileSync(resolve(root, "tests", "nested", "deep.node.test.mjs"), "export default {};\n");
  writeFileSync(resolve(root, "tests", "fixtures", "helper.mjs"), "export default {};\n");
  return root;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

// Ground truth for "what exists on disk", walked independently of
// listVitestSuiteFiles(). Deriving it from the function under test would make this
// file unable to detect a regression in that function — a re-introduced
// non-recursive readdir would shrink both sides of the comparison together and the
// guard would stay green, which is exactly what the first draft of this test did.
function listSuitesOnDisk(packageRoot) {
  const discovered = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = relative(packageRoot, entryPath).split(sep).join("/");
      if (relativePath.endsWith(".test.mjs") && !relativePath.endsWith(".node.test.mjs")) {
        discovered.push(relativePath);
      }
    }
  };
  walk(join(packageRoot, "tests"));
  return discovered.sort();
}

describe("vitest full-suite discovery", () => {
  it("collects suites from nested suite directories, not just tests/ top level", () => {
    const root = createFixtureTree();

    const suites = listVitestSuiteFiles({ startDir: root });

    expect(suites).toContain("tests/top.test.mjs");
    expect(suites).toContain("tests/nested/deep.test.mjs");
    expect(suites).not.toContain("tests/nested/deep.node.test.mjs");
    expect(suites).not.toContain("tests/node-only.node.test.mjs");
    expect(suites).not.toContain("tests/fixtures/helper.mjs");
  });

  it("returns repo-relative POSIX paths so vitest filters match on any platform", () => {
    const root = createFixtureTree();

    const suites = listVitestSuiteFiles({ startDir: root });

    for (const suite of suites) {
      expect(suite.startsWith("tests/")).toBe(true);
      expect(suite.includes("\\")).toBe(false);
    }
  });

  it("keeps a suite added in a NEW directory reachable by the resolved run set", () => {
    // Regression guard: this is the defect that let 11 tests/tui/*.test.mjs suites
    // ship unrun. Discovery must be recursive so the next directory added does not
    // silently vanish from `npm test`.
    const root = createFixtureTree();
    mkdirSync(resolve(root, "tests", "brand-new-dir"), { recursive: true });
    writeFileSync(resolve(root, "tests", "brand-new-dir", "added.test.mjs"), "export default {};\n");

    const plan = buildVitestFullSuitePlan({ startDir: root });
    const runSet = new Set([...plan.allSuites, ...(plan.deferredHeavySuites || [])]);

    expect(listVitestSuiteFiles({ startDir: root })).toContain("tests/brand-new-dir/added.test.mjs");
    expect(runSet.has("tests/brand-new-dir/added.test.mjs")).toBe(true);
  });

  it("does not regress to a top-level-only readdir when the defect is reintroduced", () => {
    // Proves the guard is load-bearing: a non-recursive readdir drops the nested
    // suite and this assertion goes red.
    const root = createFixtureTree();
    const brokenDiscovery = readdirSync(resolve(root, "tests"), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => `tests/${entry.name}`)
      .filter((name) => name.endsWith(".test.mjs") && !name.endsWith(".node.test.mjs"))
      .sort();

    expect(brokenDiscovery).not.toContain("tests/nested/deep.test.mjs");
    expect(listVitestSuiteFiles({ startDir: root })).toContain("tests/nested/deep.test.mjs");
  });
});

describe("vitest full-suite coverage of the real repository", () => {
  it("reaches every *.test.mjs on disk with no suite silently dropped", () => {
    const plan = buildVitestFullSuitePlan({ startDir: repoRoot });
    const runSet = new Set([...plan.allSuites, ...(plan.deferredHeavySuites || [])]);
    const onDisk = listSuitesOnDisk(repoRoot);

    // tests/workflow-guaranteed.test.mjs is a documented, deliberate platform gate
    // (shouldIncludeWorkflowGuaranteedSuite() excludes it on win32 local runs; it is
    // still run in CI and via BOSUN_VITEST_INCLUDE_GUARANTEED=1). It is the ONLY
    // permitted on-disk-but-not-planned suite -- anything else here is the defect.
    const platformGated = process.platform === "win32"
      ? new Set(["tests/workflow-guaranteed.test.mjs"])
      : new Set();
    const unreachable = onDisk.filter((suite) => !runSet.has(suite) && !platformGated.has(suite));

    expect(
      unreachable,
      `these suites exist on disk but are absent from the npm test run set: ${unreachable.join(", ")}`,
    ).toEqual([]);
  });

  it("never drops a nested tests/ suite directory", () => {
    const plan = buildVitestFullSuitePlan({ startDir: repoRoot });
    const runSet = new Set([...plan.allSuites, ...(plan.deferredHeavySuites || [])]);
    const nested = listSuitesOnDisk(repoRoot)
      .filter((suite) => suite.slice("tests/".length).includes("/"));

    expect(nested.length).toBeGreaterThan(0);
    expect(nested.filter((suite) => !runSet.has(suite))).toEqual([]);
  });

  it("reaches the tests/tui suites that CI previously never executed", () => {
    const plan = buildVitestFullSuitePlan({ startDir: repoRoot });
    const runSet = new Set([...plan.allSuites, ...(plan.deferredHeavySuites || [])]);

    for (const suite of ["tests/tui/screens.test.mjs", "tests/tui/unit.test.mjs"]) {
      expect(existsSync(resolve(repoRoot, suite))).toBe(true);
      expect(runSet.has(suite)).toBe(true);
    }
  });

  it("discovers the same suites on disk that vitest itself would collect", () => {
    // Close the loop on the two halves of the pipeline. The plan feeds vitest
    // positional filters, and those filters are SUBSTRING matches -- a top-level
    // `tests/utils.test.mjs` also matches `tests/tui/utils.test.mjs`. So "in the
    // run set" is not the same claim as "runs exactly once", and the directory count
    // alone would not catch a filter that over- or under-collects.
    const plan = buildVitestFullSuitePlan({ startDir: repoRoot });
    const runSet = new Set([...plan.allSuites, ...(plan.deferredHeavySuites || [])]);
    const onDisk = listSuitesOnDisk(repoRoot);

    // Every discovered suite must be a real file (no phantom path handed to vitest).
    for (const suite of runSet) {
      expect(existsSync(resolve(repoRoot, suite)), `${suite} is planned but missing on disk`).toBe(true);
    }

    // Every nested suite must be reachable; this is the invariant that regressed.
    const nested = onDisk.filter((suite) => suite.slice("tests/".length).includes("/"));
    expect(nested.length).toBeGreaterThan(0);
    for (const suite of nested) {
      expect(runSet.has(suite), `${suite} is not reachable by npm test`).toBe(true);
    }
  });

  it("passes nested suite paths through to the vitest batch args verbatim", () => {
    const args = buildVitestBatchArgs(["tests/tui/screens.test.mjs"], { project: "fast" });

    expect(args).toContain("tests/tui/screens.test.mjs");
    expect(args).toContain("--project");
    expect(args).toContain("fast");
  });
});
