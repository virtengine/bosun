import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { BUNDLE_ENTRIES, buildVendorMui, checkVendorMuiFreshness, compareBundles } from "../tools/build-vendor-mui.mjs";
import { testTimeout } from "./timeout-helper.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const VENDOR_DIR = resolve(REPO_ROOT, "ui", "vendor");
const SITE_VENDOR_DIR = resolve(REPO_ROOT, "site", "ui", "vendor");
const TOOL = resolve(REPO_ROOT, "tools", "build-vendor-mui.mjs");

// Rebuilding all three bundles costs ~13s on a Linux runner; the budget is sized
// for that rebuild, not for the byte comparison.
const REBUILD_TIMEOUT_MS = testTimeout(120_000);

function expectAllFresh(records, roots) {
  expect(records.map((r) => `${r.root}/${r.name}:${r.status}`)).toEqual(
    roots.flatMap((root) => BUNDLE_ENTRIES.map((entry) => `${root}/${entry.name}:ok`)),
  );
}

function runCheck() {
  try {
    const stdout = execFileSync(process.execPath, [TOOL, "--check"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("MUI vendor bundle freshness", () => {
  it(
    "committed bundles in ui/vendor match the current generator output",
    async () => {
      expectAllFresh(await checkVendorMuiFreshness({ committedDir: VENDOR_DIR }), ["ui/vendor"]);
    },
    REBUILD_TIMEOUT_MS,
  );

  it(
    "committed bundles in site/ui/vendor match the same generator output",
    async () => {
      expectAllFresh(await checkVendorMuiFreshness({ committedDir: SITE_VENDOR_DIR }), ["site/ui/vendor"]);
    },
    REBUILD_TIMEOUT_MS,
  );

  it(
    "checks BOTH vendor roots by default, so a partial regeneration cannot pass",
    async () => {
      const records = await checkVendorMuiFreshness();

      // A regeneration that updates ui/vendor but leaves site/ui/vendor stale is
      // the skew that would otherwise go unnoticed, so the default must cover
      // both roots rather than just one.
      expect(new Set(records.map((r) => r.root))).toEqual(new Set(["ui/vendor", "site/ui/vendor"]));
    },
    REBUILD_TIMEOUT_MS,
  );

  it(
    "`tools/build-vendor-mui.mjs --check` exits 0 on a fresh tree",
    () => {
      const result = runCheck();

      // Fails loudly with the regenerate instruction whenever the committed
      // bundles predate the pinned esbuild.
      expect(
        { status: result.status, stderr: result.stderr },
        "run `npm run build:vendor-mui` and commit all of ui/vendor/ and site/ui/vendor/",
      ).toEqual({ status: 0, stderr: "" });
    },
    REBUILD_TIMEOUT_MS,
  );

  it(
    "the guard rebuilds into a scratch directory and leaves the committed tree untouched",
    async () => {
      const before = BUNDLE_ENTRIES.map(({ name }) => readFileSync(resolve(VENDOR_DIR, name)));
      await checkVendorMuiFreshness();
      const after = BUNDLE_ENTRIES.map(({ name }) => readFileSync(resolve(VENDOR_DIR, name)));

      for (const [index, buffer] of before.entries()) {
        expect(
          after[index].equals(buffer),
          `${BUNDLE_ENTRIES[index].name} must not be rewritten by the guard`,
        ).toBe(true);
      }
    },
    REBUILD_TIMEOUT_MS,
  );
});

describe("compareBundles", () => {
  it("distinguishes fresh, drifted and missing committed files", () => {
    const scratch = mkdtempSync(join(tmpdir(), "bosun-vendor-mui-fixture-"));
    try {
      const builtDir = join(scratch, "built");
      const committedDir = join(scratch, "committed");
      mkdirSync(builtDir, { recursive: true });
      mkdirSync(committedDir, { recursive: true });

      // Faithful stand-ins for generator output: the real committed bytes.
      for (const { name } of BUNDLE_ENTRIES) {
        copyFileSync(resolve(VENDOR_DIR, name), join(builtDir, name));
      }
      // One stale copy, one absent file.
      copyFileSync(resolve(VENDOR_DIR, BUNDLE_ENTRIES[0].name), join(committedDir, BUNDLE_ENTRIES[0].name));
      writeFileSync(join(committedDir, BUNDLE_ENTRIES[1].name), "export const stale = true;\n");
      rmSync(join(committedDir, BUNDLE_ENTRIES[2].name), { force: true });

      const records = compareBundles({ builtDir, committedDir });

      expect(records.map((r) => `${r.name}:${r.status}`)).toEqual([
        `${BUNDLE_ENTRIES[0].name}:ok`,
        `${BUNDLE_ENTRIES[1].name}:differs`,
        `${BUNDLE_ENTRIES[2].name}:missing`,
      ]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, testTimeout(20_000));
});

describe("buildVendorMui", () => {
  it(
    "writes the site mirror only when every bundle built, so a partial failure cannot skew ui/vendor against site/ui/vendor",
    async () => {
      const scratch = mkdtempSync(join(tmpdir(), "bosun-vendor-mui-atomic-"));
      const realEntries = [...BUNDLE_ENTRIES];
      try {
        const outDir = join(scratch, "ui", "vendor");
        const siteOutDir = join(scratch, "site", "ui", "vendor");
        mkdirSync(siteOutDir, { recursive: true });
        // Sentinel: the mirror must still hold ONLY this file afterwards.
        writeFileSync(join(siteOutDir, "sentinel.js"), "untouched\n");

        // Swap one real entry for one that cannot resolve, so esbuild genuinely
        // fails for a single bundle in the middle of the set.
        BUNDLE_ENTRIES.length = 0;
        BUNDLE_ENTRIES.push(
          realEntries[0],
          {
            label: "@nonexistent/pkg-that-cannot-resolve",
            name: realEntries[1].name,
            stdin: {
              contents: "export * from '@nonexistent/pkg-that-cannot-resolve';",
              resolveDir: resolve(REPO_ROOT),
              loader: "js",
            },
          },
          realEntries[2],
        );

        const result = await buildVendorMui({ outDir, siteOutDir, silent: true });

        expect(result.ok).toBe(false);
        expect(result.failures.map((f) => f.label)).toEqual(["@nonexistent/pkg-that-cannot-resolve"]);
        expect(readdirSync(siteOutDir).sort()).toEqual(["sentinel.js"]);
      } finally {
        BUNDLE_ENTRIES.length = 0;
        BUNDLE_ENTRIES.push(...realEntries);
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    testTimeout(60_000),
  );
});

describe("guard wiring", () => {
  it("build:vendor-mui is a declared script so the guard and the fix share one entry point", () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"));

    expect(pkg.scripts["build:vendor-mui"]).toBe("node tools/build-vendor-mui.mjs");
  });

  it("every generator entry declares the filename it writes", () => {
    expect(BUNDLE_ENTRIES.length).toBeGreaterThan(0);
    for (const entry of BUNDLE_ENTRIES) {
      expect(entry.label).toMatch(/^@/);
      expect(entry.name).toMatch(/^[a-z0-9-]+\.js$/);
    }
  });

  it("the bundles the guard compares are git-tracked, since it validates committed bytes", () => {
    const tracked = execFileSync("git", ["ls-files", "ui/vendor", "site/ui/vendor"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .filter(Boolean);

    for (const { name } of BUNDLE_ENTRIES) {
      for (const dir of ["ui/vendor/", "site/ui/vendor/"]) {
        const relPath = `${dir}${name}`;
        expect(tracked, `${relPath} must be git-tracked`).toContain(relPath);
        expect(existsSync(resolve(REPO_ROOT, relPath))).toBe(true);
      }
    }
  });
});