/**
 * opencode-sdk-compat.mjs — Fail loudly when the OpenCode CLI and the
 * @opencode-ai/sdk disagree.
 *
 * The two ship independently and their contract is a stdout string:
 * `createOpencodeServer()` resolves only when the child's output contains a
 * line starting with "opencode server listening". OpenCode CLI 2.x changed that
 * banner (it prints "server listening on <url>" plus a server password), so a
 * 1.x SDK against a 2.x CLI never matches, sits out its full startup timeout,
 * and then fails with a message that names neither version.
 *
 * Verified working pairing: @opencode-ai/sdk 1.18.32 + opencode-ai CLI 1.18.32.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveOpencodeBinary } from "./opencode-binary.mjs";

/** SDK major versions known to parse the 1.x "opencode server listening" banner. */
export const SUPPORTED_SDK_MAJOR = 1;

let _cached;

async function readSdkVersion() {
  // The package is ESM-only: its "exports" map has no "require" condition, so
  // createRequire().resolve() throws ERR_PACKAGE_PATH_NOT_EXPORTED, and it does
  // not expose ./package.json either. Resolve the real ESM entry with
  // import.meta.resolve and walk up to the manifest.
  try {
    let dir = dirname(fileURLToPath(import.meta.resolve("@opencode-ai/sdk")));
    for (let i = 0; i < 5; i++) {
      const manifest = join(dir, "package.json");
      if (existsSync(manifest)) {
        const pkg = JSON.parse(readFileSync(manifest, "utf8"));
        if (pkg?.name === "@opencode-ai/sdk") return pkg.version || "";
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return "";
  } catch {
    return "";
  }
}

function readCliVersion(binary) {
  if (!binary || binary === "opencode") return "";
  try {
    const out = execFileSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return String(out).trim().split(/\r?\n/)[0] || "";
  } catch {
    return "";
  }
}

function majorOf(version) {
  const match = String(version || "").match(/^(\d+)\./);
  return match ? Number(match[1]) : null;
}

/**
 * Compare the installed CLI and SDK.
 *
 * @param {object} [options]
 * @param {boolean} [options.reload=false]
 * @returns {Promise<{ok: boolean, sdkVersion: string, cliVersion: string, reason: string}>}
 */
export async function checkOpencodeSdkCompat({ reload = false } = {}) {
  if (_cached && !reload) return _cached;
  const sdkVersion = await readSdkVersion();
  const binary = resolveOpencodeBinary();
  const cliVersion = readCliVersion(binary);
  const sdkMajor = majorOf(sdkVersion);
  const cliMajor = majorOf(cliVersion);

  let ok = true;
  let reason = "compatible";
  if (!sdkVersion) {
    ok = false;
    reason = "@opencode-ai/sdk is not installed";
  } else if (sdkMajor !== SUPPORTED_SDK_MAJOR) {
    ok = false;
    reason =
      `@opencode-ai/sdk ${sdkVersion} is unsupported; this integration targets ` +
      `${SUPPORTED_SDK_MAJOR}.x (which parses the 1.x server banner)`;
  } else if (cliMajor !== null && cliMajor !== sdkMajor) {
    ok = false;
    reason =
      `opencode CLI ${cliVersion} does not match @opencode-ai/sdk ${sdkVersion}. ` +
      `The SDK matches the server banner of its own major; install the matching CLI ` +
      `(npm i -g opencode-ai@${sdkVersion})`;
  }

  _cached = { ok, sdkVersion, cliVersion, reason, binary };
  return _cached;
}

/**
 * Log a warning when the pair is incompatible. Called on the server-start path,
 * where the mismatch otherwise surfaces only as a startup timeout.
 * @returns {Promise<boolean>} true when a warning was emitted
 */
export async function warnOnOpencodeSdkMismatch() {
  const result = await checkOpencodeSdkCompat({ reload: true });
  if (result.ok) return false;
  console.warn(
    `[opencode-shell] SDK/CLI version mismatch: ${result.reason}. ` +
      `Server startup is expected to time out until this is resolved.`,
  );
  return true;
}

export function resetOpencodeSdkCompatCache() {
  _cached = null;
}

export default checkOpencodeSdkCompat;
