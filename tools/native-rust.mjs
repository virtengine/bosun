#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");
const MANIFEST_PATHS = [
  resolve(ROOT_DIR, "native", "bosun-unified-exec", "Cargo.toml"),
  resolve(ROOT_DIR, "native", "bosun-telemetry", "Cargo.toml"),
];
const IS_MAIN = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

function buildCargoCandidatePaths(env = process.env, platform = process.platform) {
  const executableName = platform === "win32" ? "cargo.exe" : "cargo";
  const candidates = [];
  const explicit = String(env.BOSUN_CARGO_BIN || "").trim();
  if (explicit) {
    candidates.push(explicit);
  }

  const homeRoots = [
    env.CARGO_HOME,
    env.USERPROFILE ? resolve(env.USERPROFILE, ".cargo") : "",
    env.HOME ? resolve(env.HOME, ".cargo") : "",
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  for (const homeRoot of homeRoots) {
    candidates.push(resolve(homeRoot, "bin", executableName));
  }

  return [...new Set(candidates)];
}

function commandExists(command, probe = spawnSync) {
  const probeResult = probe(command, ["--version"], {
    stdio: "pipe",
    windowsHide: true,
  });
  return probeResult.status === 0;
}

export function resolveCargoExecutable(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const probe = options.probe || spawnSync;
  const exists = options.exists || existsSync;

  if (commandExists("cargo", probe)) {
    return "cargo";
  }

  for (const candidate of buildCargoCandidatePaths(env, platform)) {
    if (!exists(candidate)) continue;
    if (commandExists(candidate, probe)) {
      return candidate;
    }
  }

  return null;
}

export function hasCargo(options = {}) {
  return Boolean(resolveCargoExecutable(options));
}

function runCargo(cargoExecutable, args, options = {}) {
  return spawnSync(cargoExecutable, args, {
    cwd: ROOT_DIR,
    stdio: options.silent ? "pipe" : "inherit",
    windowsHide: true,
  });
}

function getMode() {
  const raw = String(process.argv[2] || "build").trim().toLowerCase();
  if (["build", "test", "check"].includes(raw)) return raw;
  return "build";
}

if (IS_MAIN) {
  const mode = getMode();
  const silent = process.argv.includes("--silent");
  const requireNative =
    process.argv.includes("--require")
    || process.env.BOSUN_REQUIRE_NATIVE === "1";
  const cargoExecutable = resolveCargoExecutable();

  if (!cargoExecutable) {
    if (requireNative) {
      console.error("[native-rust] cargo is required but was not found on PATH or in the standard Rustup home.");
      process.exit(1);
    }
    if (!silent) {
      console.log("[native-rust] cargo not found on PATH or in the standard Rustup home; skipping optional Bosun native build.");
    }
    process.exit(0);
  }

  const baseArgs = mode === "build"
    ? ["build", "--release"]
    : [mode];

  for (const manifestPath of MANIFEST_PATHS) {
    if (!existsSync(manifestPath)) {
      console.error(`[native-rust] Missing Cargo manifest: ${manifestPath}`);
      process.exit(1);
    }
    const result = runCargo(cargoExecutable, [...baseArgs, "--manifest-path", manifestPath], { silent });
    if (result.status !== 0) {
      process.exit(result.status || 1);
    }
  }

  if (!silent) {
    console.log(`[native-rust] cargo ${mode} completed for ${MANIFEST_PATHS.length} native crate(s).`);
  }
}
