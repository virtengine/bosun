/**
 * agent-sdk.mjs — Unified Agent SDK selection (config.toml)
 *
 * Reads ~/.codex/config.toml to determine the primary agent SDK and
 * capability flags for bosun integrations.
 *
 * Supported primary agents: "codex", "copilot", "claude", "opencode", "gemini"
 * Capability flags: steering, subagents, vscode_tools
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgentRepoRoot, resolveRepoRoot } from "../config/repo-root.mjs";
import { readCodexConfig } from "../shell/codex-config.mjs";

const SUPPORTED_PRIMARY = new Set([
  "codex",
  "copilot",
  "claude",
  "opencode",
  "gemini",
]);
const DEFAULT_PRIMARY = "codex";

const DEFAULT_CAPABILITIES_BY_PRIMARY = {
  codex: {
    steering: true,
    subagents: true,
    vscodeTools: false,
  },
  copilot: {
    steering: false,
    subagents: true,
    vscodeTools: true,
  },
  claude: {
    steering: false,
    subagents: true,
    vscodeTools: false,
  },
  opencode: {
    steering: true,
    subagents: true,
    vscodeTools: false,
  },
  gemini: {
    steering: false,
    subagents: true,
    vscodeTools: false,
  },
};

const DEFAULT_CAPABILITIES = {
  steering: false,
  subagents: false,
  vscodeTools: false,
};

let cachedConfig = null;
const __dirname = dirname(fileURLToPath(import.meta.url));
const CODEX_PLATFORM_PACKAGE_MAP = Object.freeze({
  "darwin-arm64": {
    packageDir: "@openai/codex-darwin-arm64",
    binaryPath: "vendor/aarch64-apple-darwin/codex/codex",
  },
  "darwin-x64": {
    packageDir: "@openai/codex-darwin-x64",
    binaryPath: "vendor/x86_64-apple-darwin/codex/codex",
  },
  "linux-arm64": {
    packageDir: "@openai/codex-linux-arm64",
    binaryPath: "vendor/aarch64-unknown-linux-musl/codex/codex",
  },
  "linux-x64": {
    packageDir: "@openai/codex-linux-x64",
    binaryPath: "vendor/x86_64-unknown-linux-musl/codex/codex",
  },
  "win32-arm64": {
    packageDir: "@openai/codex-win32-arm64",
    binaryPath: "vendor/aarch64-pc-windows-msvc/codex/codex.exe",
  },
  "win32-x64": {
    packageDir: "@openai/codex-win32-x64",
    binaryPath: "vendor/x86_64-pc-windows-msvc/codex/codex.exe",
  },
});

function normalizePrimary(value) {
  const primary = String(value || "").trim().toLowerCase();
  if (SUPPORTED_PRIMARY.has(primary)) return primary;
  return DEFAULT_PRIMARY;
}

function parseTomlSection(toml, header) {
  if (!toml || !header) return null;
  const idx = toml.indexOf(header);
  if (idx === -1) return null;
  const afterHeader = idx + header.length;
  const nextSection = toml.indexOf("\n[", afterHeader);
  const end = nextSection === -1 ? toml.length : nextSection;
  return toml.substring(afterHeader, end);
}

function parseTomlValue(section, key) {
  if (!section) return null;
  const regex = new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, "m");
  const match = section.match(regex);
  if (!match) return null;
  return match[1].trim();
}

function parseTomlString(raw) {
  if (!raw) return null;
  const trimmed = raw.split(/\s+#/)[0].trim();
  const quote =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"));
  if (quote) return trimmed.slice(1, -1);
  return trimmed;
}

function parseTomlBool(raw) {
  if (!raw) return null;
  const trimmed = raw.split(/\s+#/)[0].trim().toLowerCase();
  if (trimmed.startsWith("true")) return true;
  if (trimmed.startsWith("false")) return false;
  if (trimmed.startsWith("1")) return true;
  if (trimmed.startsWith("0")) return false;
  return null;
}

function parseCapabilities(section) {
  const steering = parseTomlBool(parseTomlValue(section, "steering"));
  const subagents = parseTomlBool(parseTomlValue(section, "subagents"));
  const vscodeTools =
    parseTomlBool(parseTomlValue(section, "vscode_tools")) ??
    parseTomlBool(parseTomlValue(section, "vscodeTools"));
  return {
    steering,
    subagents,
    vscodeTools,
  };
}

function normalizeRootCandidate(rootDir) {
  const raw = String(rootDir || "").trim();
  if (!raw) return null;
  try {
    const resolved = resolve(raw);
    return existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

function uniqueRoots(roots) {
  const seen = new Set();
  const ordered = [];
  for (const root of roots) {
    const normalized = normalizeRootCandidate(root);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

function createRequireForRoot(rootDir) {
  const packageJson = resolve(rootDir, "package.json");
  if (existsSync(packageJson)) return createRequire(packageJson);
  return createRequire(resolve(rootDir, "__bosun_agent_sdk__.cjs"));
}

function resolveModuleEntryFromPackageDir(packageDir) {
  const packageJsonPath = resolve(packageDir, "package.json");
  if (!existsSync(packageJsonPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const exportRoot = pkg?.exports?.["."] ?? pkg?.exports;
    const candidate =
      (typeof exportRoot === "string" && exportRoot) ||
      (exportRoot && typeof exportRoot.import === "string" && exportRoot.import) ||
      (typeof pkg?.module === "string" && pkg.module) ||
      (typeof pkg?.main === "string" && pkg.main) ||
      null;
    return candidate ? resolve(packageDir, candidate) : packageJsonPath;
  } catch {
    return null;
  }
}

function resolveModuleEntryFromRoot(specifier, rootDir) {
  try {
    return createRequireForRoot(rootDir).resolve(specifier);
  } catch {
    const packageDir = resolve(rootDir, "node_modules", ...specifier.split("/"));
    return resolveModuleEntryFromPackageDir(packageDir);
  }
}

export function getAgentSdkModuleRoots(options = {}) {
  const extraRoots = Array.isArray(options.extraRoots) ? options.extraRoots : [];
  return uniqueRoots([
    ...extraRoots,
    options.rootDir,
    process.env.BOSUN_AGENT_REPO_ROOT,
    resolveAgentRepoRoot(),
    resolveRepoRoot({ cwd: process.cwd() }),
    process.cwd(),
    resolve(__dirname, ".."),
  ]);
}

export function resolveAgentSdkModuleEntry(specifier, options = {}) {
  for (const rootDir of getAgentSdkModuleRoots(options)) {
    const entryPath = resolveModuleEntryFromRoot(specifier, rootDir);
    if (entryPath && existsSync(entryPath)) {
      return { entryPath, rootDir };
    }
  }
  return null;
}

export function hasCodexCliBinary(rootDir, options = {}) {
  const platform = String(options.platform || process.platform).trim().toLowerCase();
  const arch = String(options.arch || process.arch).trim().toLowerCase();
  const platformEntry = CODEX_PLATFORM_PACKAGE_MAP[`${platform}-${arch}`];
  if (!platformEntry) return true;
  const packageRoot = resolve(rootDir, "node_modules", ...platformEntry.packageDir.split("/"));
  return existsSync(resolve(packageRoot, platformEntry.binaryPath));
}

export function resolveCodexSdkInstall(options = {}) {
  for (const rootDir of getAgentSdkModuleRoots(options)) {
    const entryPath = resolveModuleEntryFromRoot("@openai/codex-sdk", rootDir);
    if (!entryPath || !existsSync(entryPath)) continue;
    if (!hasCodexCliBinary(rootDir, options)) continue;
    return { entryPath, rootDir };
  }
  return null;
}

export function parseAgentSdkConfig(toml, options = {}) {
  const agentSection = parseTomlSection(toml, "[agent_sdk]");
  const capsSection = parseTomlSection(toml, "[agent_sdk.capabilities]");

  const primaryRaw = parseTomlString(parseTomlValue(agentSection, "primary"));
  // config.toml is the only durable record of the primary SDK, so an absent
  // [agent_sdk] block used to force DEFAULT_PRIMARY ("codex") and silently
  // disable every other executor — including opencode, whose shell refuses to
  // run when the primary is not "opencode". Fall back to what the operator
  // actually asked for (PRIMARY_AGENT / bosun config primaryAgent) before
  // defaulting, so configuring opencode in bosun.config.json is sufficient.
  const fallbackPrimary = normalizePrimary(
    options.fallbackPrimaryRaw || DEFAULT_PRIMARY,
  );
  const primary = normalizePrimary(primaryRaw || fallbackPrimary);
  const defaults =
    DEFAULT_CAPABILITIES_BY_PRIMARY[primary] || DEFAULT_CAPABILITIES;

  const parsedCaps = parseCapabilities(capsSection);

  const capabilities = {
    steering:
      parsedCaps.steering !== null ? parsedCaps.steering : defaults.steering,
    subagents:
      parsedCaps.subagents !== null ? parsedCaps.subagents : defaults.subagents,
    vscodeTools:
      parsedCaps.vscodeTools !== null
        ? parsedCaps.vscodeTools
        : defaults.vscodeTools,
  };

  return {
    primary,
    capabilities,
    source: agentSection
      ? "config.toml"
      : primaryRaw || !options.fallbackPrimaryRaw
        ? "defaults"
        : "env-fallback",
    raw: {
      primary: primaryRaw,
      capabilities: parsedCaps,
    },
  };
}

/**
 * Best-effort read of the operator's requested primary SDK from the environment
 * (PRIMARY_AGENT / PRIMARY_AGENT_SDK, the same vars config.mjs honours). Returns
 * "" when unset or unrecognized so the caller keeps DEFAULT_PRIMARY.
 */
function readEnvPrimaryFallback(env = process.env) {
  const raw = String(
    env?.PRIMARY_AGENT || env?.PRIMARY_AGENT_SDK || "",
  ).trim();
  if (!raw) return "";
  // Accept both the executor key ("opencode") and the SDK spelling
  // ("opencode-sdk"); normalizePrimary rejects anything unsupported.
  const candidate = raw.toLowerCase().replace(/-sdk$/, "").replace(/-cli$/, "");
  return SUPPORTED_PRIMARY.has(candidate) ? candidate : "";
}

export function resolveAgentSdkConfig({ reload = false, env } = {}) {
  if (cachedConfig && !reload) return cachedConfig;
  const toml = readCodexConfig();
  cachedConfig = parseAgentSdkConfig(toml || "", {
    fallbackPrimaryRaw: readEnvPrimaryFallback(env || process.env),
  });
  return cachedConfig;
}

export function resetAgentSdkCache() {
  cachedConfig = null;
}
