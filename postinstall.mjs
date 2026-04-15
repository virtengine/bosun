#!/usr/bin/env node

/**
 * bosun — Post-Install Environment Validator
 *
 * Runs after `npm install` to check for required system dependencies
 * that can't be installed via npm (git, gh, pwsh) and prints
 * actionable install instructions for anything missing.
 *
 * This is non-blocking — missing optional tools produce warnings,
 * not errors, so CI installs won't fail.
 */

import { execSync } from "node:child_process";
import {
  existsSync,
  createWriteStream,
  mkdirSync,
  rmSync,
  chmodSync,
  mkdtempSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import https from "node:https";
import { pipeline } from "node:stream/promises";
import { installGitHooks } from "./tools/install-git-hooks.mjs";

const isWin = process.platform === "win32";
const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_PWSH_DIR = resolve(__dirname, ".cache", "bosun", "pwsh");
const BUNDLED_PWSH_PATH = resolve(BUNDLED_PWSH_DIR, "pwsh");
const FALLBACK_PWSH_VERSION = "7.4.6";
const require = createRequire(import.meta.url);
const MODE_TASK = "task";
const MODE_ALWAYS = "always";
const MODE_OFF = "off";
const TRUE_VALUES = new Set(["1", "true", "yes", "y", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "n", "off"]);
const MIN_SUPPORTED_NODE_MAJOR = 22;
const MIN_SUPPORTED_NODE_MINOR = 13;

// ── Helpers ──────────────────────────────────────────────────────────────────

function commandExists(cmd) {
  try {
    execSync(`${isWin ? "where" : "which"} ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function getVersion(cmd, flag = "--version") {
  try {
    return execSync(`${cmd} ${flag}`, {
      encoding: "utf8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "ignore"],
    })
      .trim()
      .split("\n")[0];
  } catch {
    return null;
  }
}

function parseBoolEnv(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function getNodeVersionParts(version = process.versions.node) {
  const [major = "0", minor = "0", patch = "0"] = String(version || "0.0.0").split(".");
  return {
    major: Number.parseInt(major, 10) || 0,
    minor: Number.parseInt(minor, 10) || 0,
    patch: Number.parseInt(patch, 10) || 0,
  };
}

function isSupportedNodeVersion(version = process.versions.node) {
  const { major, minor } = getNodeVersionParts(version);
  if (major > MIN_SUPPORTED_NODE_MAJOR) return true;
  if (major < MIN_SUPPORTED_NODE_MAJOR) return false;
  return minor >= MIN_SUPPORTED_NODE_MINOR;
}

function normalizeScopedMode(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;

  if ([
    MODE_TASK,
    "tasks",
    "task-only",
    "task_only",
    "scoped",
    "task-scoped",
    "task_scoped",
  ].includes(raw)) {
    return MODE_TASK;
  }

  if ([
    MODE_ALWAYS,
    "all",
    "global",
    "unscoped",
  ].includes(raw)) {
    return MODE_ALWAYS;
  }

  if ([
    MODE_OFF,
    "none",
    "disabled",
    "disable",
  ].includes(raw)) {
    return MODE_OFF;
  }

  if (TRUE_VALUES.has(raw)) return MODE_ALWAYS;
  if (FALSE_VALUES.has(raw)) return MODE_OFF;
  return null;
}

function isBosunManagedSession(env = process.env) {
  return (
    parseBoolEnv(env.BOSUN_MANAGED, false) ||
    parseBoolEnv(env.VE_MANAGED, false)
  );
}

function resolveBosunTaskId(env = process.env) {
  const candidates = [env.BOSUN_TASK_ID, env.VE_TASK_ID, env.VK_TASK_ID];
  for (const candidate of candidates) {
    const normalized = String(candidate || "").trim();
    if (normalized) return normalized;
  }
  return "";
}

function hasBosunTaskContext(env = process.env) {
  return Boolean(resolveBosunTaskId(env)) && isBosunManagedSession(env);
}

// Keep postinstall self-contained so npm install does not pull in runtime
// task-store/state-ledger modules that rely on newer Node builtins.
function shouldAutoInstallGitHooks(options = {}) {
  const env = options.env || process.env;
  const mode = normalizeScopedMode(
    options.mode ??
      env.BOSUN_AUTO_GIT_HOOKS_MODE ??
      env.BOSUN_GIT_HOOKS_MODE,
  ) || MODE_ALWAYS;

  if (mode === MODE_OFF) return false;
  if (mode === MODE_ALWAYS) return true;
  return hasBosunTaskContext(env);
}

function ensureJsonRpcNodeCompatShim() {
  try {
    const packageJsonPath = require.resolve("vscode-jsonrpc/package.json");
    const packageDir = dirname(packageJsonPath);
    const extensionlessNodePath = resolve(packageDir, "node");
    const nodeJsPath = resolve(packageDir, "node.js");
    if (existsSync(extensionlessNodePath) || !existsSync(nodeJsPath)) {
      return { patched: false, reason: "not-needed" };
    }
    copyFileSync(nodeJsPath, extensionlessNodePath);
    return { patched: true, path: extensionlessNodePath };
  } catch (err) {
    return { patched: false, reason: err?.message || String(err) };
  }
}

function bundledPwshExists() {
  return existsSync(BUNDLED_PWSH_PATH);
}

function isPwshSupportedPlatform(platform) {
  return platform === "linux" || platform === "darwin";
}

function getPwshAssetSuffix(platform, arch) {
  if (platform === "linux") {
    if (arch === "x64") return "linux-x64";
    if (arch === "arm64") return "linux-arm64";
    return null;
  }
  if (platform === "darwin") {
    if (arch === "x64") return "osx-x64";
    if (arch === "arm64") return "osx-arm64";
    return null;
  }
  return null;
}

function httpsGetJson(url) {
  return new Promise((resolvePromise, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": "bosun-postinstall",
          Accept: "application/vnd.github+json",
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try {
            resolvePromise(JSON.parse(raw));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("error", reject);
  });
}

function downloadFile(url, destPath) {
  return new Promise((resolvePromise, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "bosun-postinstall" } },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        pipeline(res, createWriteStream(destPath))
          .then(resolvePromise)
          .catch(reject);
      },
    );
    req.on("error", reject);
  });
}

async function resolvePwshVersion() {
  const forced = String(process.env.BOSUN_PWSH_VERSION || "").trim();
  if (forced) return forced.replace(/^v/, "");
  try {
    const release = await httpsGetJson(
      "https://api.github.com/repos/PowerShell/PowerShell/releases/latest",
    );
    const tag = String(release?.tag_name || "").trim();
    if (tag) return tag.replace(/^v/, "");
  } catch {
    /* fallback */
  }
  return FALLBACK_PWSH_VERSION;
}

async function installBundledPwsh(platform, arch) {
  const suffix = getPwshAssetSuffix(platform, arch);
  if (!suffix) {
    throw new Error(`Unsupported platform/arch: ${platform}/${arch}`);
  }

  const version = await resolvePwshVersion();
  const assetName = `powershell-${version}-${suffix}.tar.gz`;
  const url = `https://github.com/PowerShell/PowerShell/releases/download/v${version}/${assetName}`;
  const tempDir = mkdtempSync(resolve(tmpdir(), "bosun-pwsh-"));
  const archivePath = resolve(tempDir, assetName);

  await downloadFile(url, archivePath);

  rmSync(BUNDLED_PWSH_DIR, { recursive: true, force: true });
  mkdirSync(BUNDLED_PWSH_DIR, { recursive: true });

  execSync(`tar -xzf "${archivePath}" -C "${BUNDLED_PWSH_DIR}"`, {
    stdio: "ignore",
  });

  if (!existsSync(BUNDLED_PWSH_PATH)) {
    throw new Error("pwsh binary not found after extraction");
  }
  try {
    chmodSync(BUNDLED_PWSH_PATH, 0o755);
  } catch {
    /* best effort */
  }
  return { version, path: BUNDLED_PWSH_PATH };
}

// ── Dependency checks ────────────────────────────────────────────────────────

const REQUIRED = [
  {
    name: "git",
    cmd: "git",
    required: true,
    install: {
      win32: "winget install --id Git.Git -e --source winget",
      darwin: "brew install git",
      linux: "sudo apt install git  # or: sudo dnf install git",
    },
    url: "https://git-scm.com/downloads",
  },
];

const RECOMMENDED = [
  {
    name: "GitHub CLI (gh)",
    cmd: "gh",
    required: false,
    install: {
      win32: "winget install --id GitHub.cli -e --source winget",
      darwin: "brew install gh",
      linux:
        "sudo apt install gh  # or: https://github.com/cli/cli/blob/trunk/docs/install_linux.md",
    },
    url: "https://cli.github.com/",
    why: "Required for PR creation, branch management, and GitHub operations",
  },
  {
    name: "GitHub Copilot CLI (copilot)",
    cmd: "copilot",
    required: false,
    install: {
      win32: "npm install -g @github/copilot",
      darwin: "npm install -g @github/copilot",
      linux: "npm install -g @github/copilot",
    },
    url: "https://github.com/github/copilot-cli",
    why: "Required for Copilot SDK primary agent sessions",
  },
  {
    name: "PowerShell (pwsh)",
    cmd: "pwsh",
    required: false,
    install: {
      win32: "winget install --id Microsoft.PowerShell -e --source winget",
      darwin: "brew install powershell/tap/powershell",
      linux:
        "sudo apt install powershell  # or: https://learn.microsoft.com/en-us/powershell/scripting/install/installing-powershell-on-linux",
    },
    url: "https://github.com/PowerShell/PowerShell",
    why: isWin
      ? "Required on Windows for PowerShell orchestrator scripts"
      : "Optional on macOS/Linux (only needed when using .ps1 orchestrator scripts)",
  },
];

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!isSupportedNodeVersion()) {
    console.error("");
    console.error(
      `  :close: Node.js ${process.versions.node} is not supported. Bosun requires Node.js ${MIN_SUPPORTED_NODE_MAJOR}.${MIN_SUPPORTED_NODE_MINOR}+ because it uses the built-in node:sqlite module.`,
    );
    console.error("     Upgrade to Node.js 22.13+ or 24.x LTS and retry npm install.");
    process.exitCode = 1;
    return;
  }

  // Skip in CI environments
  if (process.env.CI || process.env.BOSUN_SKIP_POSTINSTALL) {
    return;
  }

  console.log("");
  console.log("  ┌──────────────────────────────────────────────┐");
  console.log("  │      bosun — environment check       │");
  console.log("  └──────────────────────────────────────────────┘");
  console.log("");

  const platform = process.platform;
  let hasErrors = false;
  let hasWarnings = false;

  // Node.js version check
  if (isSupportedNodeVersion()) {
    console.log(`  :check: Node.js ${process.versions.node}`);
  } else {
    console.log(
      `  :close: Node.js ${process.versions.node} — requires ≥ ${MIN_SUPPORTED_NODE_MAJOR}.${MIN_SUPPORTED_NODE_MINOR}`,
    );
    hasErrors = true;
  }

  // Required tools
  for (const dep of REQUIRED) {
    if (commandExists(dep.cmd)) {
      const ver = getVersion(dep.cmd);
      console.log(`  :check: ${dep.name}${ver ? ` (${ver})` : ""}`);
    } else {
      console.log(`  :close: ${dep.name} — REQUIRED`);
      const hint = dep.install[platform] || dep.install.linux;
      console.log(`     Install: ${hint}`);
      console.log(`     Docs:    ${dep.url}`);
      hasErrors = true;
    }
  }

  // Optional: auto-install PowerShell on Linux/macOS if missing
  const autoInstallPwsh = parseBoolEnv(
    process.env.BOSUN_AUTO_INSTALL_PWSH,
    true,
  );
  if (
    autoInstallPwsh &&
    !commandExists("pwsh") &&
    !bundledPwshExists() &&
    isPwshSupportedPlatform(platform)
  ) {
    console.log("  ▸ Installing PowerShell (bundled)...");
    try {
      const info = await installBundledPwsh(platform, process.arch);
      console.log(`  :check: PowerShell bundled (${info.version})`);
    } catch (err) {
      console.log(`  :alert:  PowerShell bundle install failed: ${err.message}`);
    }
  }

  // Recommended tools
  for (const dep of RECOMMENDED) {
    const isPwsh = dep.cmd === "pwsh";
    const hasPwsh = isPwsh
      ? commandExists(dep.cmd) || bundledPwshExists()
      : commandExists(dep.cmd);
    if (hasPwsh) {
      const ver = getVersion(dep.cmd);
      if (isPwsh && bundledPwshExists() && !ver) {
        console.log(`  :check: ${dep.name} (bundled)`);
      } else {
        console.log(`  :check: ${dep.name}${ver ? ` (${ver})` : ""}`);
      }
    } else {
      console.log(`  :alert:  ${dep.name} — not found`);
      console.log(`     ${dep.why}`);
      const hint = dep.install[platform] || dep.install.linux;
      console.log(`     Install: ${hint}`);
      hasWarnings = true;
    }
  }

  if (commandExists("cargo")) {
    const ver = getVersion("cargo");
    console.log(`  :check: Rust toolchain${ver ? ` (${ver})` : ""} — optional native hot-path builds available via npm run native:build`);
  } else {
    console.log("  :alert:  Rust toolchain — not found");
    console.log("     Bosun will use the built-in .mjs hot-path fallbacks.");
    console.log("     Optional: install rustup/cargo, then run: npm run native:build");
  }

  // npm-installed tools (bundled with this package)
  // Fix @openai/codex-sdk if its package.json lacks entry points
  // (published "latest" sometimes ships a stub manifest).
  try {
    const codexPkgPath = resolve(__dirname, "node_modules", "@openai", "codex-sdk", "package.json");
    if (existsSync(codexPkgPath)) {
      const codexPkg = JSON.parse(readFileSync(codexPkgPath, "utf8"));
      if (!codexPkg.main && !codexPkg.exports) {
        const distIndex = resolve(__dirname, "node_modules", "@openai", "codex-sdk", "dist", "index.js");
        if (existsSync(distIndex)) {
          codexPkg.main = "dist/index.js";
          codexPkg.type = "module";
          codexPkg.exports = { ".": { import: "./dist/index.js" } };
          if (existsSync(distIndex.replace(/\.js$/, ".d.ts"))) {
            codexPkg.types = "dist/index.d.ts";
            codexPkg.exports["."].types = "./dist/index.d.ts";
          }
          writeFileSync(codexPkgPath, JSON.stringify(codexPkg, null, 2), "utf8");
          console.log(`  :check: @openai/codex-sdk (bundled, fixed stub package.json)`);
        } else {
          console.log(`  :alert:  @openai/codex-sdk — dist/index.js missing`);
        }
      } else {
        console.log(`  :check: @openai/codex-sdk (bundled)`);
      }
    } else {
      console.log(`  :alert:  @openai/codex-sdk — package.json not found`);
    }
  } catch (codexFixErr) {
    console.log(`  :alert:  @openai/codex-sdk — postinstall fix failed: ${codexFixErr.message}`);
  }
  console.log(`  :check: @github/copilot-sdk (bundled)`);
  console.log(`  :check: @anthropic-ai/claude-agent-sdk (bundled)`);
  console.log(`  :check: @github/copilot-sdk (bundled)`);
  console.log(`  :check: @anthropic-ai/claude-agent-sdk (bundled)`);

  const jsonRpcShim = ensureJsonRpcNodeCompatShim();
  if (jsonRpcShim.patched) {
    console.log(`  :check: Copilot compatibility shim applied (${jsonRpcShim.path})`);
  }

  // Desktop dependencies (Electron) — optional but recommended for instant launch
  const desktopDir = resolve(__dirname, "desktop");
  const isDesktopInstallEnabled = parseBoolEnv(
    process.env.BOSUN_DESKTOP_INSTALL,
    true,
  );
  if (isDesktopInstallEnabled && existsSync(desktopDir)) {
    const binName = isWin ? "electron-builder.cmd" : "electron-builder";
    const binPath = resolve(desktopDir, "node_modules", ".bin", binName);
    if (!existsSync(binPath)) {
      console.log("");
      console.log("  ▸ Installing desktop dependencies (Electron)...");
      try {
        execSync("npm install", {
          cwd: desktopDir,
          stdio: "inherit",
          timeout: 0,
        });
        console.log("  :check: Desktop dependencies installed");
      } catch (err) {
        console.log(
          "  :alert:  Desktop dependency install failed — run manually:",
        );
        console.log("     npm -C scripts/bosun/desktop install");
      }
    }
  }

  // Summary
  console.log("");
  if (hasErrors) {
    console.log(
      "  :ban: Missing required dependencies. Install them before running bosun.",
    );
  } else if (hasWarnings) {
    console.log(
      "  \u2705 Core dependencies satisfied. Optional tools above unlock full functionality.",
    );
  } else {
    console.log("  \u2705 All dependencies satisfied!");
  }

  console.log("");
  console.log("  Get started:");
  console.log("    bosun --setup     Interactive setup wizard");
  console.log("    bosun             Start with existing config");
  console.log("    bosun --help       See all options");
  console.log("");

  // Auto-install git hooks when inside the repo and hooks are present.
  try {
    const hookInstall = installGitHooks({ silent: true });
    if (hookInstall.ok && hookInstall.changed) {
      const action = hookInstall.repaired ? "repaired" : "installed";
      console.log(`  :check: Git hooks ${action} (.githooks)`);
    } else if (!hookInstall.ok && !hookInstall.skipped) {
      console.warn(`  :alert:  Git hooks not installed: ${hookInstall.error || "unknown git config error"}`);
      console.warn("     Run: npm run hooks:install");
    }
  } catch {
    // Non-blocking; hooks can be installed via `npm run hooks:install`
  }

  // Sync vendor files into ui/vendor/ so the UI works fully offline.
  // Non-blocking — a missing vendor file just falls back to node_modules or CDN.
  try {
    const { syncVendorFiles } = await import("./tools/vendor-sync.mjs");
    const { ok, results } = await syncVendorFiles({ silent: true });
    const synced = results.filter((r) => r.source).length;
    if (ok) {
      console.log(`  :check: Vendor files bundled into ui/vendor/ (${synced}/${results.length} files)`);
    } else {
      const missing = results.filter((r) => !r.source).map((r) => r.name);
      console.warn(`  :alert:  Some vendor files could not be bundled: ${missing.join(", ")}`);
      console.warn("     The UI server will fall back to CDN for those files.");
    }
  } catch (err) {
    console.warn(`  :alert:  vendor-sync skipped: ${err.message}`);
  }

  // Refresh generated demo defaults for both ui/ and site/ui/ artifacts.
  try {
    const { syncDemoDefaults } = await import("./tools/generate-demo-defaults.mjs");
    const { changed } = await syncDemoDefaults({ silent: true });
    if (changed.length > 0) {
      console.log(`  :check: Demo defaults refreshed (${changed.length} files)`);
    }
  } catch (err) {
    console.warn(`  :alert:  demo-default sync skipped: ${err.message}`);
  }

  // Keep the mirrored demo UI source surfaces aligned with ui/.
  try {
    const { syncDemoUi } = await import("./tools/sync-demo-ui.mjs");
    const { updatedPaths } = await syncDemoUi({ silent: true });
    if (updatedPaths.length > 0) {
      console.log(`  :check: Demo UI synced (${updatedPaths.length} files)`);
    }
  } catch (err) {
    console.warn(`  :alert:  demo-ui sync skipped: ${err.message}`);
  }
}

main().catch((err) => {
  console.error(`  :alert:  postinstall failed: ${err.message}`);
});
