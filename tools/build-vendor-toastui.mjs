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
 *     3. npm install, then FORCE the 3.x line into the resolved tree and assert
 *        it — the `overrides` entry alone is a silent no-op against the
 *        lockfile upstream commits (see forceDompurifyVersion)
 *     4. build libs/toastmark (rollup) — the editor build imports its ESM
 *        output and fails outright without it
 *     5. build apps/editor with `webpack build --env minify`, producing
 *        dist/cdn/toastui-editor-all.min.js
 *     6. verify the floor, then install into ui/assets/ and site/ui/assets/
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
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  compareVersions,
  DOMPURIFY_MIN_VERSION,
  DOMPURIFY_VERSION,
  inspectDompurifyBundle,
} from "./dompurify-floor.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/**
 * Upstream tag that corresponds to @toast-ui/editor 3.2.2.
 *
 * NOTE the tag shape: nhn/tui.editor tags each package in the monorepo as
 * `editor@<version>`, not `v<version>`. There is no `v3.2.2` tag upstream, so a
 * `v`-prefixed value makes `git clone --branch` fail outright and turns the gate's
 * documented remediation command into a dead end.
 */
export const TOASTUI_TAG = "editor@3.2.2";
export const TOASTUI_REPO = "https://github.com/nhn/tui.editor.git";
export const BUNDLE_RELATIVE_PATH = "assets/toastui-editor-all.min.js";

/** Both committed locations that must carry the same bytes. */
export const BUNDLE_TARGETS = [
  resolve(ROOT, "ui", "assets", "toastui-editor-all.min.js"),
  resolve(ROOT, "site", "ui", "assets", "toastui-editor-all.min.js"),
];

/**
 * How to invoke npm for the upstream dependency install.
 *
 * `npm` cannot simply be spawned by name here. On Windows the PATH entry is a
 * `npm.cmd` shim: execFileSync without a shell dies with ENOENT, and with a
 * shell it dies with EINVAL. So we drive npm's own JS entrypoint with the same
 * `process.execPath` already used for rollup and webpack, resolving it in order:
 *
 *   1. `npm_execpath` — set whenever this script runs under `npm run`, and
 *      already an absolute path to npm's cli bundle.
 *   2. `node_modules/npm/bin/npm-cli.js` next to the running node binary —
 *      correct when the script is run as plain `node tools/...`, including on
 *      this repo's Windows hosts.
 *   3. A plain `npm` on PATH through a shell — the POSIX fallback, kept last
 *      because it is the only option that depends on the caller's PATH.
 */
const NPM_CLI_CANDIDATES = [
  process.env.npm_execpath,
  join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
];

function resolveNpmInvocation() {
  for (const candidate of NPM_CLI_CANDIDATES) {
    if (candidate && existsSync(candidate)) {
      return { command: process.execPath, args: [candidate], shell: false };
    }
  }
  return { command: "npm", args: [], shell: true };
}

const NPM_INVOCATION = resolveNpmInvocation();
export const NPM_COMMAND = NPM_INVOCATION.command;
export const NPM_ARGS_INSTALL = [...NPM_INVOCATION.args, "install", "--no-audit", "--no-fund"];
export const NPM_USES_SHELL = NPM_INVOCATION.shell;

function log(message) {
  process.stdout.write(`[build-vendor-toastui] ${message}\n`);
}

/** Directory listing that yields nothing on an unreadable dir instead of throwing. */
function safeReaddir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Read the version of every dompurify actually installed in a node_modules tree.
 *
 * Walks the tree for every `dompurify` directory and reads its package.json, so
 * both the hoisted copy and any nested copy (e.g.
 * `@toast-ui/editor/node_modules/dompurify`) are seen. Webpack resolves the
 * nested copy first, so a green root version with a live nested 2.x still ships
 * 2.x — both must be reported.
 *
 * @param {string} root repository root (the worktree being installed into)
 * @returns {Array<{path: string, version: string|null}>}
 */
export function readInstalledDompurifyVersions(root) {
  const nodeModules = join(root, "node_modules");
  if (!existsSync(nodeModules)) return [];

  const found = [];
  const stack = [nodeModules];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of safeReaddir(dir)) {
      if (!entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      if (entry.name === "dompurify") {
        let version = null;
        try {
          version = JSON.parse(readFileSync(join(full, "package.json"), "utf8")).version ?? null;
        } catch {
          version = null;
        }
        found.push({ path: full, version });
        continue;
      }
      // Descend into scope dirs and into node_modules dirs so nested copies
      // (`@scope/pkg/node_modules/dompurify`) are reachable. Walking every
      // package dir in a 2400-package upstream tree would be needlessly slow, so
      // scope contents are expanded to their member packages and nowhere else.
      if (entry.name.startsWith("@")) {
        for (const member of safeReaddir(full)) {
          if (member.isDirectory()) stack.push(join(full, member.name));
        }
      } else if (entry.name === "node_modules") {
        stack.push(full);
      }
    }
  }
  return found;
}

/**
 * Default installer used by `forceDompurifyVersion`: a direct, `--no-save`
 * install of the 3.x line into the upstream worktree.
 *
 * `--no-save` is deliberate — it must not rewrite the lockfile we deliberately
 * kept for toolchain reproducibility, and it must not be undone by a later
 * `npm install` in the same tree.
 */
function defaultDompurifyInstall(workdir, version) {
  execFileSync(NPM_COMMAND, [...NPM_ARGS_INSTALL, "--no-save", `dompurify@${version}`], {
    cwd: workdir,
    stdio: "inherit",
    shell: NPM_USES_SHELL,
  });
}

/**
 * Force dompurify >= the floor into an already-installed upstream worktree.
 *
 * WHY A ROOT `overrides` ENTRY IS NOT ENOUGH
 * ------------------------------------------
 * nhn/tui.editor at `editor@3.2.2` commits a package-lock.json that pins
 * `node_modules/dompurify` to 2.3.3, and its root package record has no
 * `overrides` key. npm does not apply a newly-added root `overrides` entry
 * against a lockfile that predates it, so writing `overrides.dompurify` into
 * the upstream package.json is silently a no-op: `npm install` completes
 * successfully, reports nothing, and leaves 2.3.3 installed. Measured against
 * seven install variants (bare override, scoped override, `--package-lock-only`,
 * seeding packages[""].overrides, seeding plus dropping the stale entry), only
 * deleting the lockfile produced 3.x — and deleting it floats upstream's own
 * lint toolchain, after which upstream's source fails with 158 eslint errors.
 *
 * So we keep the lockfile (toolchain reproducibility is load-bearing) and force
 * the 3.x line in on top with a direct `--no-save` install, then delete the
 * nested `@toast-ui/editor/node_modules/dompurify` copy that webpack resolves
 * ahead of the hoisted one.
 *
 * The resolved tree is then asserted here, so a silently-defeated override fails
 * at its source instead of 40 seconds later inside the bundle floor check.
 *
 * @param {string} workdir installed upstream worktree to correct in place
 * @param {{install?: Function, log?: Function}} [deps] injectable for tests
 * @returns {Array<{path: string, version: string|null}>} every dompurify left
 */
export function forceDompurifyVersion(
  workdir,
  { install = defaultDompurifyInstall, log: logger = log } = {},
) {
  install(workdir, DOMPURIFY_VERSION);
  rmSync(join(workdir, "node_modules", "@toast-ui", "editor", "node_modules", "dompurify"), {
    recursive: true,
    force: true,
  });

  const installed = readInstalledDompurifyVersions(workdir);
  if (installed.length === 0) {
    throw new Error("no dompurify found in the upstream tree after forcing the override");
  }
  const bad = installed.filter(
    (entry) => !entry.version || compareVersions(entry.version, DOMPURIFY_MIN_VERSION) < 0,
  );
  if (bad.length > 0) {
    throw new Error(
      `dompurify ${DOMPURIFY_VERSION} was forced but the resolved tree still carries ` +
        `${bad.map((entry) => `${entry.version ?? "unknown"} at ${entry.path}`).join(", ")} ` +
        `(floor ${DOMPURIFY_MIN_VERSION}). Upstream committed a lockfile that npm will not ` +
        `re-resolve against a new root overrides entry, so the 3.x line must be installed ` +
        `directly. Refusing to build a bundle from this tree.`,
    );
  }
  logger(
    `dompurify in tree: ${installed.map((entry) => entry.version).join(", ")}, nested copy removed`,
  );
  return installed;
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
    // -c core.autocrlf=false / core.eol=lf keeps the checkout byte-faithful to
    // upstream. Without it a Windows clone rewrites line endings to CRLF and the
    // upstream prettier lint in the build then fails on 258 files — a failure
    // that looks like a build problem but is purely a checkout problem.
    execFileSync(
      "git",
      [
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.eol=lf",
        "clone",
        "--depth",
        "1",
        "--branch",
        TOASTUI_TAG,
        TOASTUI_REPO,
        workdir,
      ],
      {
        stdio: "inherit",
      },
    );

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

    log("installing upstream dependencies (npm install)");
    execFileSync(NPM_COMMAND, NPM_ARGS_INSTALL, {
      cwd: workdir,
      stdio: "inherit",
      shell: NPM_USES_SHELL,
    });

    // The root `overrides` entry written above is NOT sufficient on its own:
    // upstream commits a lockfile that predates it, so npm keeps 2.3.3. See
    // forceDompurifyVersion() for the measurements. Assert the resolved tree
    // before the 40s build so a defeated override fails here, not at the floor
    // check with a confusing "2.3.3 is below floor" message.
    log("forcing dompurify 3.x into the upstream tree");
    forceDompurifyVersion(workdir);

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
