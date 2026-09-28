/**
 * opencode-binary.mjs — Locate the OpenCode CLI executable.
 *
 * The @opencode-ai/sdk server launcher spawns the bare string "opencode".
 * That works on POSIX, where npm installs a real executable, but NOT on
 * Windows: `npm i -g opencode-ai` produces `opencode` (a POSIX sh shim),
 * `opencode.cmd` and `opencode.ps1` — and no `opencode.exe`. CreateProcessW
 * cannot run a `.cmd` without shell/PATHEXT, so the spawn fails with ENOENT
 * and Bosun degrades to a client-only attach that then fails with an
 * unhelpful "fetch failed".
 *
 * Resolution order (first hit wins):
 *   1. OPENCODE_BIN — explicit operator override, always absolute-ized.
 *   2. An `opencode.exe` on PATH (present on Windows once installed natively).
 *   3. The npm global install's real binary, found by resolving the shim's
 *      own `node_modules` package rather than guessing global prefixes.
 *   4. Bare "opencode" — last resort, correct on POSIX.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

const require = createRequire(import.meta.url);

/** npm packages that ship the opencode binary, newest-layout first. */
const BINARY_PACKAGES = ["@opencode-ai/cli", "opencode-ai"];

let _cached;

/**
 * Absolute path to a runnable opencode executable, or null when none is found.
 * @param {object} [options]
 * @param {boolean} [options.reload=false] bypass the module-scope cache
 * @param {string} [options.env=process.env]
 * @returns {string|null}
 */
export function resolveOpencodeBinary({ reload = false, env = process.env } = {}) {
  if (_cached && !reload) return _cached;
  _cached = _resolve(env) || null;
  return _cached;
}

function _resolve(env) {
  const override = String(env.OPENCODE_BIN || "").trim();
  if (override) {
    const abs = isAbsolute(override) ? override : resolve(process.cwd(), override);
    if (existsSync(abs)) return abs;
    console.warn(
      `[opencode-binary] OPENCODE_BIN="${override}" does not exist — falling back to PATH lookup`,
    );
  }
  return fromPath(env) || fromNodeModules() || "opencode";
}

/**
 * First runnable `opencode` on PATH.
 *
 * On Windows a bare-name spawn needs a real executable: the npm global install
 * ships `opencode` (a POSIX sh shim), `opencode.cmd` and `opencode.ps1`, none
 * of which CreateProcessW can run. So a PATH hit is only accepted when it is
 * NOT one of those shims, or when the shim's exec target can be followed (see
 * {@link followShim}).
 */
function fromPath(env) {
  const isWindows = process.platform === "win32";
  const names = isWindows ? ["opencode.exe", "opencode.cmd", "opencode"] : ["opencode"];
  const pathValue = String(env.PATH || env.Path || "");
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (!safeExists(candidate)) continue;
      if (!isWindows) return candidate;
      if (name === "opencode.exe") return candidate;
      // A .cmd/.sh shim: use what it execs, not the shim itself.
      const target = followShim(candidate);
      if (target) return target;
    }
  }
  return null;
}

function safeExists(path) {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

/**
 * Read an npm shim and return the binary it execs, if that binary exists.
 *
 * Both shim flavours name their target as the last token of an `exec` line:
 *   #!/bin/sh ... exec ".../node_modules/<pkg>/bin/opencode.exe" "$@"
 *   @ECHO off ... "%dp0%\node_modules\<pkg>\bin\opencode.exe" %*
 * @returns {string|null} absolute path to the target, or null
 */
function followShim(shimPath) {
  let text;
  try {
    text = readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }
  // Take the last line that mentions the binary; the shebang/EXEC line is last
  // in both shim styles, and taking the last match avoids the wrapper preamble.
  const lines = text.split(/\r?\n/).filter((line) => /opencode(\.exe)?/i.test(line));
  const last = lines[lines.length - 1];
  if (!last) return null;
  const quoted = [...last.matchAll(/["']([^"']*opencode(?:\.exe)?)["']/gi)]
    .map((m) => m[1])
    .pop();
  const candidate = quoted || last.trim();
  if (!candidate || !/opencode(\.exe)?$/i.test(candidate)) return null;
  const abs = isAbsolute(candidate) ? candidate : resolve(dirname(shimPath), candidate);
  return safeExists(abs) ? abs : null;
}

/**
 * Follow the npm shim to the package that actually holds the binary.
 *
 * The global `opencode` shim execs `<prefix>/node_modules/<pkg>/bin/opencode(.exe)`,
 * so reading the shim gives us the exact install location without consulting
 * npm config, nvm prefixes, or a hardcoded table of global roots.
 */
function fromNodeModules() {
  for (const pkg of BINARY_PACKAGES) {
    // The shim sits next to node_modules/, so resolve the package from there.
    const roots = [
      join(process.cwd(), "node_modules"),
      ...nodeModulesRoots(),
    ];
    for (const root of roots) {
      const binDir = join(root, ...pkg.split("/"), "bin");
      for (const name of ["opencode.exe", "opencode"]) {
        const candidate = join(binDir, name);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

/** Every node_modules directory that could hold a global install. */
function nodeModulesRoots() {
  const roots = new Set();
  try {
    // Resolving from this module finds a hoisted/local install of the SDK.
    const sdkPath = require.resolve("@opencode-ai/sdk/package.json");
    let dir = dirname(sdkPath);
    for (let i = 0; i < 6; i++) {
      if (dir.endsWith("node_modules")) {
        roots.add(dir);
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // SDK not resolvable from here; PATH lookup still applies.
  }
  for (const dir of String(process.env.PATH || "").split(delimiter)) {
    if (dir) roots.add(join(dir, "node_modules"));
  }
  return [...roots];
}

/**
 * Human-readable description of what was resolved and where it came from —
 * for the startup log and for error messages that used to say "fetch failed".
 */
export function describeOpencodeBinary({ env = process.env } = {}) {
  const resolved = resolveOpencodeBinary({ env });
  return {
    path: resolved,
    source:
      !resolved
        ? "none"
        : resolved === "opencode"
          ? "path-bare"
          : existsSync(resolved)
            ? "resolved"
            : "missing",
    platform: process.platform,
  };
}

/** Test seam: drop the module-scope cache. */
export function resetOpencodeBinaryCache() {
  _cached = undefined;
}

export default resolveOpencodeBinary;
