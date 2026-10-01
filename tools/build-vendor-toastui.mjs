#!/usr/bin/env node
/**
 * build-vendor-toastui.mjs — rebuild the vendored Toast UI Editor browser bundle.
 *
 * WHY THIS EXISTS
 * ---------------
 * `ui/assets/toastui-editor-all.min.js` is a committed build artifact of
 * `@toast-ui/editor@3.2.2`. That package hard-pins `"dompurify": "^2.3.3"`, and
 * npm cannot hoist the 3.x line into its subtree, so the *published* bundle
 * embeds DOMPurify 2.x. Bosun ships that bundle to GitHub Pages (site/ui is a
 * copy of ui/ at deploy time) and loads it at runtime from
 * `ui/components/task-markdown.js`.
 *
 * The consequence is that DOMPurify 2.x lives inside a shipped artifact where
 * no dependabot alert can ever see it: dependabot only reads
 * package-lock.json, and a vendored bundle appears in no manifest. Every open
 * dompurify advisory whose range covers 2.x therefore applies to code we serve
 * in production, with zero alert coverage.
 *
 * `@toast-ui/editor` has no release that allows dompurify 3.x, so the fix is to
 * rebuild the bundle ourselves from the upstream source tree with the 3.x line
 * forced via an npm `overrides` entry. That is what this script does.
 *
 * WHY A SCRIPT AND NOT A HAND-EDIT
 * -------------------------------
 * Editing the bundle's version literal by string substitution would make the
 * artifact *look* patched while still executing DOMPurify 2.x internals — a
 * cosmetic fix for a security finding. The bundle must be produced by a real
 * upstream build. `tools/check-vendored-dompurify.mjs` is the independent gate
 * that fails CI if the committed bytes ever regress below the floor.
 *
 * USAGE
 *   node tools/build-vendor-toastui.mjs [--from <path-to-prebuilt-bundle>]
 *
 *   Default (full) mode clones and builds nhn/tui.editor at TOASTUI_TAG:
 *     1. clone the tag into a temp dir
 *     2. add `"overrides": { "dompurify": "<DOMPURIFY_VERSION>" }` to its root
 *        package.json so the 3.x line wins over the hard ^2.3.3 pin
 *     3. build libs/toastmark (rollup) — the editor build imports its ESM
 *        output and fails outright without it
 *     4. build apps/editor with `webpack build --env minify`, producing
 *        dist/cdn/toastui-editor-all.min.js
 *     5. verify the floor, then install into ui/assets/ and site/ui/assets/
 *
 *   --from <path> skips the clone and build and installs an already-built
 *   bundle. This is the mode used in CI-adjacent refreshes and for verifying
 *   a bundle produced elsewhere. The floor check still applies — a bundle below
 *   the floor is refused, never installed.
 *
 * Both install targets are written: site/ui is a symlink to ../ui in the
 * working tree, but git tracks the resolved blob, so a stale site/ui copy is
 * what actually ships to GitHub Pages.
 */

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DOMPURIFY_MIN_VERSION,
  DOMPURIFY_VERSION,
  inspectDompurifyBundle,
} from "./dompurify-floor.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/** Upstream tag that corresponds to @toast-ui/editor 3.2.2. */
export const TOASTUI_TAG = "v3.2.2";
export const TOASTUI_REPO = "https://github.com/nhn/tui.editor.git";
export const BUNDLE_RELATIVE_PATH = "assets/toastui-editor-all.min.js";

/** Both committed locations that must carry the same bytes. */
export const BUNDLE_TARGETS = [
  resolve(ROOT, "ui", "assets", "toastui-editor-all.min.js"),
  resolve(ROOT, "site", "ui", "assets", "toastui-editor-all.min.js"),
];

function log(message) {
  process.stdout.write(`[build-vendor-toastui] ${message}\n`);
}

/**
 * Build the upstream bundle from source with dompurify 3.x forced.
 *
 * @returns {string} path to the built toastui-editor-all.min.js
 */
export function buildFromUpstream() {
  const workdir = mkdtempSync(join(tmpdir(), "bosun-tui-editor-"));
  try {
    log(`cloning ${TOASTUI_REPO} @ ${TOASTUI_TAG}`);
    execFileSync("git", ["clone", "--depth", "1", "--branch", TOASTUI_TAG, TOASTUI_REPO, workdir], {
      stdio: "inherit",
    });

    // Force the 3.x line over the hard "^2.3.3" pin in apps/editor/package.json.
    const pkgPath = join(workdir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.overrides = { ...(pkg.overrides || {}), dompurify: DOMPURIFY_VERSION };
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    log(`forced overrides.dompurify=${DOMPURIFY_VERSION} in upstream package.json`);

    const run = (cwd, file, args) =>
      execFileSync(process.execPath, [join(workdir, "node_modules", file), ...args], {
        cwd: join(workdir, cwd),
        stdio: "inherit",
        env: { ...process.env, WEBPACK_BUILD: "true" },
      });

    log("installing upstream dependencies (npm install picks up the override)");
    execFileSync("npm", ["install", "--no-audit", "--no-fund"], {
      cwd: workdir,
      stdio: "inherit",
    });

    // The editor build imports @toast-ui/toastmark's ESM output, which does not
    // exist in a fresh clone. Build it first or webpack fails to resolve it.
    log("building libs/toastmark (rollup)");
    run("libs/toastmark", "rollup/dist/bin/rollup", ["-c"]);

    log("building apps/editor (webpack build --env minify)");
    run("apps/editor", "webpack/bin/webpack.js", ["build", "--env", "minify"]);

    const built = join(workdir, "apps", "editor", "dist", "cdn", "toastui-editor-all.min.js");
    if (!existsSync(built)) {
      throw new Error(`upstream build produced no bundle at ${built}`);
    }
    // Copy out of the temp dir before it is removed.
    const staged = join(tmpdir(), `bosun-tui-bundle-${process.pid}.min.js`);
    copyFileSync(built, staged);
    return staged;
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

/**
 * Verify a candidate bundle carries an acceptable DOMPurify, then install it
 * into every committed location.
 *
 * @param {string} bundlePath candidate bundle to install
 * @returns {{ok: true, versions: string[], installed: string[]}}
 */
export function installBundle(bundlePath) {
  const source = readFileSync(bundlePath, "utf8");
  const result = inspectDompurifyBundle(source, bundlePath);
  if (!result.ok) {
    throw new Error(
      `refusing to install ${bundlePath}: ${result.reason} (found ${result.versions.join(", ") || "no markers"})`,
    );
  }
  log(`bundle verified: DOMPurify ${result.versions.join(" / ")} (floor ${DOMPURIFY_MIN_VERSION})`);
  for (const target of BUNDLE_TARGETS) {
    copyFileSync(bundlePath, target);
    log(`installed -> ${target}`);
  }
  return { ok: true, versions: result.versions, installed: BUNDLE_TARGETS };
}

function main(argv) {
  const fromIndex = argv.indexOf("--from");
  if (fromIndex !== -1) {
    const path = argv[fromIndex + 1];
    if (!path) {
      throw new Error("--from requires a path to a prebuilt bundle");
    }
    log(`installing prebuilt bundle from ${path}`);
    installBundle(resolve(path));
    return;
  }

  const built = buildFromUpstream();
  try {
    installBundle(built);
  } finally {
    rmSync(built, { force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[build-vendor-toastui] FAILED: ${error.message}\n`);
    process.exitCode = 1;
  }
}
