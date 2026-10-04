import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { VENDOR_MANIFEST, checkVendorSyncFreshness, compareVendorFiles } from "../tools/vendor-sync.mjs";
import { checkDemoDefaultsFreshness } from "../tools/generate-demo-defaults.mjs";
import { checkDemoUiFreshness, compareMirror } from "../tools/sync-demo-ui.mjs";
import { testTimeout } from "./timeout-helper.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const VENDOR_DIR = resolve(REPO_ROOT, "ui", "vendor");
const SITE_VENDOR_DIR = resolve(REPO_ROOT, "site", "ui", "vendor");

// The guards re-resolve node_modules and rebuild the ~2MB demo-defaults payload,
// so the budget is sized for a cold run, not for the byte comparison.
const GUARD_TIMEOUT_MS = testTimeout(120_000);

const toPosix = (value) => value.split("\\").join("/");

/** Copy a real committed vendor file into a scratch dir as a stand-in for output. */
function copyInto(dir, name, fromDir = VENDOR_DIR) {
  copyFileSync(resolve(fromDir, name), join(dir, name));
}

function runTool(relPath, ...args) {
  try {
    const stdout = execFileSync(process.execPath, [resolve(REPO_ROOT, relPath), ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("vendor-sync freshness guard", () => {
  it(
    "committed bundles in ui/vendor match the current node_modules resolution",
    async () => {
      const records = await checkVendorSyncFreshness({ committedDir: VENDOR_DIR });

      // Every entry must resolve offline to a byte-identical committed file. An
      // entry that cannot resolve is reported as 'unvended', which is not 'ok',
      // so a guard that silently skipped a file could not pass this.
      expect(records.map((r) => `${r.name}:${r.status}`)).toEqual(
        VENDOR_MANIFEST.map((entry) => `${entry.name}:ok`),
      );
    },
    GUARD_TIMEOUT_MS,
  );

  it(
    "checks BOTH vendor roots by default, so a half-regenerated mirror cannot pass",
    async () => {
      const records = await checkVendorSyncFreshness();

      // site/ui/vendor is a verbatim mirror written by sync-demo-ui.mjs, so a
      // vendor-sync run that updates ui/ and leaves the mirror behind is exactly
      // the skew that would otherwise go unnoticed.
      expect(new Set(records.map((r) => r.root))).toEqual(new Set(["ui/vendor", "site/ui/vendor"]));
    },
    GUARD_TIMEOUT_MS,
  );

  it(
    "`tools/vendor-sync.mjs --check` exits 0 on a fresh tree",
    () => {
      const result = runTool("tools/vendor-sync.mjs", "--check");

      expect(
        { status: result.status, stderr: result.stderr },
        "run `npm run build` and commit all of ui/vendor/ and site/ui/vendor/",
      ).toEqual({ status: 0, stderr: "" });
    },
    GUARD_TIMEOUT_MS,
  );

  it("the guard rebuilds into a scratch directory and leaves the committed tree untouched", async () => {
    const before = VENDOR_MANIFEST.map((entry) => readFileSync(resolve(VENDOR_DIR, entry.name)));
    await checkVendorSyncFreshness();
    const after = VENDOR_MANIFEST.map((entry) => readFileSync(resolve(VENDOR_DIR, entry.name)));

    for (const [index, buffer] of before.entries()) {
      expect(
        after[index].equals(buffer),
        `${VENDOR_MANIFEST[index].name} must not be rewritten by the guard`,
      ).toBe(true);
    }
  }, GUARD_TIMEOUT_MS);
});

describe("compareVendorFiles", () => {
  it("distinguishes fresh, drifted, missing and unresolvable committed files", () => {
    const scratch = mkdtempSync(join(tmpdir(), "bosun-vendor-sync-fixture-"));
    try {
      const builtDir = join(scratch, "built");
      const committedDir = join(scratch, "committed");
      mkdirSync(builtDir, { recursive: true });
      mkdirSync(committedDir, { recursive: true });
      const [first, second, third] = VENDOR_MANIFEST;

      // Faithful stand-ins for generator output: the real committed bytes.
      copyInto(builtDir, first.name, VENDOR_DIR);
      copyInto(builtDir, second.name, VENDOR_DIR);
      // Entry 3 has no built output at all -> the generator could not resolve it.
      // It must read as 'unvended' (not 'ok'), or a guard would pass on a file
      // it never actually verified.
      writeFileSync(join(committedDir, second.name), "export const stale = true;\n");
      copyInto(committedDir, first.name, VENDOR_DIR);
      copyInto(committedDir, third.name, VENDOR_DIR);

      const records = compareVendorFiles({ builtDir, committedDir });
      const byName = Object.fromEntries(records.map((r) => [r.name, r.status]));

      expect(byName[first.name]).toBe("ok");
      expect(byName[second.name]).toBe("differs");
      expect(byName[third.name]).toBe("unvended");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, testTimeout(20_000));

  it("reports a committed file whose bytes differ from the generator output", () => {
    const scratch = mkdtempSync(join(tmpdir(), "bosun-vendor-sync-missing-"));
    try {
      const builtDir = join(scratch, "built");
      const committedDir = join(scratch, "committed");
      mkdirSync(builtDir, { recursive: true });
      mkdirSync(committedDir, { recursive: true });
      const entry = VENDOR_MANIFEST[0];

      copyInto(builtDir, entry.name, VENDOR_DIR);
      writeFileSync(join(committedDir, entry.name), "export const stale = true;\n");

      expect(compareVendorFiles({ builtDir, committedDir })[0].status).toBe("differs");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, testTimeout(20_000));
});

describe("demo-defaults freshness guard", () => {
  it(
    "both committed roots match the generator output",
    async () => {
      const records = await checkDemoDefaultsFreshness();

      expect(records.map((r) => `${r.root}:${r.status}`).sort()).toEqual([
        "site/ui/demo-defaults.js:ok",
        "ui/demo-defaults.js:ok",
      ]);
    },
    GUARD_TIMEOUT_MS,
  );

  it(
    "`tools/generate-demo-defaults.mjs --check` exits 0 on a fresh tree",
    () => {
      const result = runTool("tools/generate-demo-defaults.mjs", "--check");

      expect(
        { status: result.status, stderr: result.stderr },
        "run `npm run demo-defaults:sync` and commit both demo-defaults.js files",
      ).toEqual({ status: 0, stderr: "" });
    },
    GUARD_TIMEOUT_MS,
  );

  it(
    "generator output is EOL-invariant, so a core.autocrlf contributor cannot red the gate",
    async () => {
      // Without normalisation the artifact inlines CRLF sources verbatim, so the
      // bytes change with the checkout's EOL setting and the gate goes red for
      // exactly the contributors who produce the skew. Assert the rendered output
      // carries no CR at all rather than re-deriving the whole build.
      const { buildDemoDefaultsData, renderDefaultsScript } = await import(
        "../tools/generate-demo-defaults.mjs"
      );
      const content = renderDefaultsScript(await buildDemoDefaultsData());

      expect(content).not.toContain("\r");
    },
    GUARD_TIMEOUT_MS,
  );
});

describe("demo-ui mirror freshness guard", () => {
  it(
    "every mirrored file in site/ui matches ui/",
    () => {
      const records = checkDemoUiFreshness();
      const drifted = records.filter((r) => r.status !== "ok");

      expect(drifted, JSON.stringify(drifted, null, 2)).toEqual([]);
      // Sanity: the guard must actually be covering a meaningful number of files,
      // otherwise an empty plan would trivially pass.
      expect(records.length).toBeGreaterThan(50);
      // Real-call root label must name the mirror, so a CI drift message points
      // at site/ui/ and not at ui/.
      expect(new Set(records.map((r) => r.root))).toEqual(new Set(["site/ui"]));
    },
    GUARD_TIMEOUT_MS,
  );

  it(
    "`tools/sync-demo-ui.mjs --check` exits 0 on a fresh tree",
    () => {
      const result = runTool("tools/sync-demo-ui.mjs", "--check");

      expect(
        { status: result.status, stderr: result.stderr },
        "run `npm run demo-ui:sync` and commit all of the resulting site/ui/ files",
      ).toEqual({ status: 0, stderr: "" });
    },
    GUARD_TIMEOUT_MS,
  );

  it("the guard does not write into site/ui", () => {
    const before = execFileSync("git", ["status", "--porcelain", "--", "site/ui"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    checkDemoUiFreshness();
    const after = execFileSync("git", ["status", "--porcelain", "--", "site/ui"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    expect(after).toBe(before);
  }, GUARD_TIMEOUT_MS);
});

describe("compareMirror", () => {
  it("flags content drift, a missing mirror copy, and a source-only file", () => {
    // Fixture roots mirror the real layout (…/ui/… and …/site/ui/…) because the
    // report key is relative to the target root's PARENT — a flat layout would
    // yield component-only paths and prove nothing about the committed report.
    const scratch = mkdtempSync(join(tmpdir(), "bosun-demo-ui-fixture-"));
    try {
      const sourceRoot = join(scratch, "ui");
      const targetRoot = join(scratch, "site", "ui");
      const sourceDir = join(sourceRoot, "components");
      const targetDir = join(targetRoot, "components");
      mkdirSync(sourceDir, { recursive: true });
      mkdirSync(targetDir, { recursive: true });

      writeFileSync(join(sourceDir, "same.js"), "export const a = 1;\n");
      writeFileSync(join(targetDir, "same.js"), "export const a = 1;\n");
      writeFileSync(join(sourceDir, "changed.js"), "export const b = 2;\n");
      writeFileSync(join(targetDir, "changed.js"), "export const b = 999;\n");
      writeFileSync(join(sourceDir, "not-mirrored-yet.js"), "export const c = 3;\n");

      const records = compareMirror({ sourceRoot, targetRoot });
      const byPath = Object.fromEntries(records.map((r) => [r.relPath, r.status]));

      expect(Object.values(byPath).filter((s) => s === "ok")).toHaveLength(1);
      expect(byPath[toPosix("components/changed.js")]).toBe("differs");
      expect(byPath[toPosix("components/not-mirrored-yet.js")]).toBe("missing");
      // Every record carries one root label, so a reader can tell which of ui/
      // and site/ui/ drifted. Its exact value is ROOT-relative, so a scratch
      // fixture yields a long ../.. path — only the real call is asserted on.
      expect(new Set(records.map((r) => r.root)).size).toBe(1);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, testTimeout(20_000));

  it("flags a mirror file whose source was deleted — the orphan a write-only sync leaves behind", () => {
    const scratch = mkdtempSync(join(tmpdir(), "bosun-demo-ui-orphan-"));
    try {
      const sourceRoot = join(scratch, "ui");
      const targetRoot = join(scratch, "site", "ui");
      mkdirSync(join(sourceRoot, "components"), { recursive: true });
      mkdirSync(join(targetRoot, "components"), { recursive: true });

      // The source was deleted; the sync never removes, so the copy survives.
      writeFileSync(join(targetRoot, "components", "removed-from-ui.js"), "export const orphan = 1;\n");

      const records = compareMirror({ sourceRoot, targetRoot });

      expect(records.map((r) => [r.relPath, r.status])).toEqual([
        [toPosix("components/removed-from-ui.js"), "orphan"],
      ]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, testTimeout(20_000));
});

describe("guard wiring", () => {
  it("every guard is declared as a fail-closed ci.yaml step with no continue-on-error", () => {
    const ci = readFileSync(resolve(REPO_ROOT, ".github", "workflows", "ci.yaml"), "utf8");

    for (const run of [
      "node tools/build-vendor-mui.mjs --check",
      "node tools/vendor-sync.mjs --check",
      "node tools/generate-demo-defaults.mjs --check",
      "node tools/sync-demo-ui.mjs --check",
    ]) {
      const step = ci.split(/(?=\n      - name: )/).find((chunk) => chunk.includes(run));
      expect(step, `ci.yaml must have a step running \`${run}\``).toBeDefined();
      expect(step).not.toContain("continue-on-error");
    }
  });

  it("keeps the four gates as separate steps so one failure cannot mask another", () => {
    const ci = readFileSync(resolve(REPO_ROOT, ".github", "workflows", "ci.yaml"), "utf8");
    const runs = ["build-vendor-mui.mjs --check", "vendor-sync.mjs --check", "generate-demo-defaults.mjs --check", "sync-demo-ui.mjs --check"];

    for (const run of runs) {
      expect(ci.split(run)).toHaveLength(2);
    }
  });

  it("the artifacts each guard validates are git-tracked, since it validates committed bytes", () => {
    const tracked = execFileSync("git", ["ls-files", "ui", "site/ui"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .filter(Boolean);

    for (const { name } of VENDOR_MANIFEST) {
      for (const dir of ["ui/vendor/", "site/ui/vendor/"]) {
        const relPath = `${dir}${name}`;
        expect(tracked, `${relPath} must be git-tracked`).toContain(relPath);
        expect(existsSync(resolve(REPO_ROOT, relPath))).toBe(true);
      }
    }

    // Note the pathspec is `ui`, not `ui/vendor` — ui/demo-defaults.js lives at
    // the top of ui/ and would be silently excluded by the narrower form.
    for (const relPath of ["ui/demo-defaults.js", "site/ui/demo-defaults.js"]) {
      expect(tracked, `${relPath} must be git-tracked`).toContain(relPath);
      expect(existsSync(resolve(REPO_ROOT, relPath))).toBe(true);
    }
  });
});