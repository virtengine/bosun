/**
 * repo-config.mjs — Generates repo-level configuration files for AI executors.
 *
 * Produces per-repo configs for all 3 AI agent SDKs:
 *   1. `.codex/config.toml`       — Codex CLI project-level config
 *   2. `.claude/settings.local.json` — Claude Code project permissions + hooks
 *   3. `.vscode/settings.json`    — VS Code / Copilot settings
 *   4. `.vscode/mcp.json`         — Copilot MCP server definitions
 *
 * Unlike the global `~/.codex/config.toml` managed by codex-config.mjs,
 * these files live **inside** the repo directory and contain only settings
 * that are project-scoped (MCP servers, sandbox permissions, features,
 * shell env policy, agent SDK).  Global/user-level settings (API keys,
 * model providers, writable_roots, stream timeouts) stay in the global
 * config.
 *
 * Usage:
 *   import { ensureRepoConfigs, printRepoConfigSummary } from "./repo-config.mjs";
 *   const result = ensureRepoConfigs("/path/to/repo");
 *   printRepoConfigSummary(result);
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import * as codexConfig from "../shell/codex-config.mjs";
import {
  buildRecommendedVsCodeSettings,
} from "../setup.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const _missingCodexHelpersWarned = new Set();
const COMMON_DEFAULT_MCP_SERVER_IDS = new Set([
  "context7",
  "sequential-thinking",
  "playwright",
  "microsoft-docs",
  "microsoft_docs",
]);

function warnMissingCodexHelper(name) {
  if (_missingCodexHelpersWarned.has(name)) return;
  _missingCodexHelpersWarned.add(name);
  console.warn(
    `[repo-config] codex-config helper "${name}" missing or invalid; using compatibility fallback`,
  );
}

function toTomlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function parseWritableRootsInput(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || "").trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function resolveConfigPlatform(env = process.env) {
  const raw = String(
    env?.BOSUN_HOST_PLATFORM ||
    env?.npm_config_platform ||
    env?.OS ||
    process.platform,
  ).trim().toLowerCase();
  if (raw === "win32" || raw === "windows" || raw === "windows_nt" || raw.startsWith("mingw")) {
    return "win32";
  }
  if (raw === "darwin" || raw === "mac" || raw === "macos" || raw === "osx") {
    return "darwin";
  }
  if (raw === "linux") {
    return "linux";
  }
  return process.platform;
}

function getFallbackSandboxTempRoots(env = process.env, platform = resolveConfigPlatform(env)) {
  if (platform === "win32") {
    const candidate = String(env?.TEMP || env?.TMP || tmpdir() || "").trim();
    return candidate && isAbsolute(candidate) ? [candidate] : [];
  }
  return ["/tmp"];
}

function fallbackBuildSandboxMode(envValue) {
  const mode = String(envValue || "workspace-write").trim() || "workspace-write";
  return `\n# Sandbox mode (added by bosun)\nsandbox_mode = "${mode}"\n`;
}

function fallbackBuildSandboxWorkspaceWrite(options = {}) {
  const { writableRoots, repoRoot, platform = process.platform, tempDir = "" } = options;
  const roots = new Set();

  for (const entry of parseWritableRootsInput(writableRoots)) {
    if (isAbsolute(entry)) roots.add(entry);
  }
  if (repoRoot && isAbsolute(repoRoot)) {
    roots.add(repoRoot);
    const ancestor =
      typeof codexConfig?.ensureGitAncestor === "function"
        ? codexConfig.ensureGitAncestor(repoRoot)
        : null;
    const gitDir =
      String(ancestor?.gitDir || "").trim() || resolve(repoRoot, ".git");
    if (gitDir && isAbsolute(gitDir)) {
      roots.add(gitDir);
    }
    const parent = dirname(repoRoot);
    if (parent && parent !== repoRoot) roots.add(parent);
  }
  const sandboxEnv = tempDir ? { TEMP: tempDir } : process.env;
  for (const tempRoot of getFallbackSandboxTempRoots(sandboxEnv, platform)) {
    if (isAbsolute(tempRoot)) roots.add(tempRoot);
  }

  if (!roots.size) return "";
  return [
    "",
    "# Workspace-write sandbox defaults (compat fallback)",
    "[sandbox_workspace_write]",
    "network_access = true",
    "exclude_tmpdir_env_var = false",
    "exclude_slash_tmp = false",
    `writable_roots = [${Array.from(roots).map(toTomlString).join(", ")}]`,
    "",
  ].join("\n");
}

function fallbackBuildFeaturesBlock(envOverrides = process.env) {
  const disableLinuxBwrap = resolveConfigPlatform(envOverrides) !== "linux";
  return [
    "",
    "# Feature flags (compat fallback)",
    "[features]",
    "child_agents_md = true",
    "multi_agent = true",
    "collaboration_modes = true",
    "memories = true",
    "shell_tool = true",
    "unified_exec = true",
    `use_linux_sandbox_bwrap = ${disableLinuxBwrap ? "false" : "true"}`,
    "",
  ].join("\n");
}

function fallbackBuildShellEnvPolicy(policy = "all") {
  const inherit = String(policy || "all").trim() || "all";
  return `\n[shell_environment_policy]\ninherit = "${inherit}"\n`;
}

function fallbackBuildCommonMcpBlocks() {
  return [
    "",
    "[mcp_servers.context7]",
    "startup_timeout_sec = 120",
    'command = "npx"',
    'args = ["-y", "@upstash/context7-mcp"]',
    "",
    "[mcp_servers.sequential-thinking]",
    "startup_timeout_sec = 120",
    'command = "npx"',
    'args = ["-y", "@modelcontextprotocol/server-sequential-thinking"]',
    "",
    "[mcp_servers.playwright]",
    "startup_timeout_sec = 120",
    'command = "npx"',
    'args = ["-y", "@playwright/mcp@latest"]',
    "",
    "[mcp_servers.microsoft-docs]",
    'url = "https://learn.microsoft.com/api/mcp"',
    "",
  ].join("\n");
}

/**
 * Build TOML blocks for all installed MCP servers in the library.
 * Falls back to empty string if the library is not initialized or has no MCP entries.
 * This reads the library manifest synchronously for use in config generation.
 *
 * @param {string} repoRoot — workspace root directory
 * @returns {string} — TOML blocks for installed MCP servers
 */
function buildInstalledMcpBlocks(repoRoot, options = {}) {
  const { skipServerIds = new Set() } = options;
  try {
    const manifestPath = resolve(repoRoot, ".bosun", "library.json");
    if (!existsSync(manifestPath)) return "";
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const mcpEntries = (manifest.entries || []).filter((e) => e.type === "mcp");
    if (!mcpEntries.length) return "";

    const lines = [];
    for (const entry of mcpEntries) {
      const meta = entry.meta || {};
      const safeId = String(entry.id).replace(/[^a-zA-Z0-9_-]/g, "_");

      // Skip entries that are already covered by common blocks
      if (skipServerIds.has(safeId)) {
        continue;
      }

      if (meta.transport === "url" && meta.url) {
        lines.push("");
        lines.push(`[mcp_servers.${safeId}]`);
        lines.push(`url = ${toTomlString(meta.url)}`);
      } else if (meta.command) {
        lines.push("");
        lines.push(`[mcp_servers.${safeId}]`);
        lines.push(`command = ${toTomlString(meta.command)}`);
        if (meta.args && meta.args.length) {
          const argsStr = meta.args.map((a) => toTomlString(a)).join(", ");
          lines.push(`args = [${argsStr}]`);
        }
      } else {
        continue;
      }

      // Write env block if present (skip empty-value keys)
      const envEntries = Object.entries(meta.env || {}).filter(
        ([, v]) => v != null && String(v).trim() !== "",
      );
      if (envEntries.length) {
        lines.push(`[mcp_servers.${safeId}.env]`);
        for (const [key, value] of envEntries) {
          lines.push(`${key} = ${toTomlString(String(value))}`);
        }
      }
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

function fallbackBuildAgentSdkBlock({ primary = "codex" } = {}) {
  const normalized = String(primary || "codex").trim().toLowerCase();
  const resolved = ["codex", "copilot", "claude"].includes(normalized)
    ? normalized
    : "codex";
  const caps = {
    codex: { steering: true, subagents: true, vscodeTools: false },
    copilot: { steering: false, subagents: true, vscodeTools: true },
    claude: { steering: false, subagents: true, vscodeTools: false },
  };
  const c = caps[resolved];
  return [
    "",
    "[agent_sdk]",
    `primary = "${resolved}"`,
    "max_threads = 12",
    "",
    "[agent_sdk.capabilities]",
    `steering = ${c.steering}`,
    `subagents = ${c.subagents}`,
    `vscode_tools = ${c.vscodeTools}`,
    "",
  ].join("\n");
}

function getCodexHelper(name, fallback) {
  const candidate = codexConfig?.[name];
  if (typeof candidate === "function") return candidate;
  warnMissingCodexHelper(name);
  return fallback;
}

const buildFeaturesBlock = getCodexHelper(
  "buildFeaturesBlock",
  fallbackBuildFeaturesBlock,
);
const buildShellEnvPolicy = getCodexHelper(
  "buildShellEnvPolicy",
  fallbackBuildShellEnvPolicy,
);
const buildSandboxMode = getCodexHelper(
  "buildSandboxMode",
  fallbackBuildSandboxMode,
);
const buildSandboxWorkspaceWrite = getCodexHelper(
  "buildSandboxWorkspaceWrite",
  fallbackBuildSandboxWorkspaceWrite,
);
const buildCommonMcpBlocks = getCodexHelper(
  "buildCommonMcpBlocks",
  fallbackBuildCommonMcpBlocks,
);
const buildAgentSdkBlock = getCodexHelper(
  "buildAgentSdkBlock",
  fallbackBuildAgentSdkBlock,
);

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Read a JSON file, returning null on missing/invalid.
 * @param {string} filePath
 * @returns {object|null}
 */
function loadJson(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Write a JSON file with pretty printing, creating parent dirs as needed.
 * @param {string} filePath
 * @param {object} data
 */
function writeJson(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/**
 * Shallow-merge two plain objects. `updates` keys overwrite `base` keys
 * except when the base value is non-empty and both are plain objects
 * (in which case we recurse).
 * @param {object} base
 * @param {object} updates
 * @returns {object}
 */
function mergePlainObjects(base, updates) {
  const out = { ...(base || {}) };
  for (const [key, value] of Object.entries(updates || {})) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      out[key] &&
      typeof out[key] === "object" &&
      !Array.isArray(out[key])
    ) {
      out[key] = mergePlainObjects(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Merge two arrays, keeping all unique entries (set union by JSON identity).
 * @param {any[]} existing
 * @param {any[]} additions
 * @returns {any[]}
 */
function mergeArrayUnique(existing, additions) {
  const seen = new Set((existing || []).map((v) => JSON.stringify(v)));
  const result = [...(existing || [])];
  for (const item of additions || []) {
    const key = JSON.stringify(item);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

function normalizeClaudePermissionsAllow(values = []) {
  const normalized = [];
  const seen = new Set();

  for (const rawValue of values) {
    let value = String(rawValue || "").trim();
    if (!value) continue;

    if (value === "computer:*") value = "Computer:*";
    if (value === "go *") continue;

    if (seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }

  return normalized;
}

/**
 * Check whether a TOML string contains a given section header.
 * @param {string} toml
 * @param {string} header  e.g. "[features]"
 * @returns {boolean}
 */
function hasTomlSection(toml, header) {
  const sectionHeaderRegex = new RegExp(`^\\s*${escapeRegex(header)}\\s*$`, "m");
  return sectionHeaderRegex.test(toml);
}

/**
 * Append a TOML block to a string only if the section header is not present.
 * @param {string} toml     Current content
 * @param {string} header   Section header to look for
 * @param {string} block    Block to append if missing
 * @returns {{ toml: string, added: boolean }}
 */
function appendTomlBlockIfMissing(toml, header, block) {
  if (hasTomlSection(toml, header)) {
    return { toml, added: false };
  }
  return { toml: toml.trimEnd() + "\n" + block, added: true };
}

function stripDeprecatedSandboxPermissions(toml) {
  return String(toml || "").replace(
    /^\s*sandbox_permissions\s*=.*(?:\r?\n)?/gim,
    "",
  );
}

function stripUnsupportedMicrosoftDocsToolsConfig(toml) {
  let nextToml = String(toml || "");
  for (const name of ["microsoft-docs", "microsoft_docs"]) {
    const header = `[mcp_servers.${name}]`;
    const headerIdx = nextToml.indexOf(header);
    if (headerIdx === -1) continue;

    const afterHeader = headerIdx + header.length;
    const nextSection = nextToml.indexOf("\n[", afterHeader);
    const resolvedSectionEnd = nextSection === -1 ? nextToml.length : nextSection;
    const section = nextToml.substring(afterHeader, resolvedSectionEnd);
    const cleaned = section.replace(
      /^\s*tools\s*=\s*\[[^\n]*\]\s*(?:\r?\n)?/gm,
      "",
    );

    if (cleaned !== section) {
      nextToml =
        nextToml.substring(0, afterHeader) + cleaned + nextToml.substring(resolvedSectionEnd);
    }
  }
  return nextToml;
}

function ensureMcpStartupTimeout(toml, name, timeoutSec = 120) {
  const header = `[mcp_servers.${name}]`;
  const headerIdx = toml.indexOf(header);
  if (headerIdx === -1) return toml;

  const afterHeader = headerIdx + header.length;
  const nextSection = toml.indexOf("\n[", afterHeader);
  const sectionEnd = nextSection === -1 ? toml.length : nextSection;
  let section = toml.substring(afterHeader, sectionEnd);

  const timeoutRegex = /^startup_timeout_sec\s*=\s*\d+.*$/m;
  if (timeoutRegex.test(section)) {
    section = section.replace(timeoutRegex, `startup_timeout_sec = ${timeoutSec}`);
  } else {
    section = section.trimEnd() + `\nstartup_timeout_sec = ${timeoutSec}\n`;
  }

  return toml.substring(0, afterHeader) + section + toml.substring(sectionEnd);
}

/**
 * Resolve the default bosun bridge script path.
 * @param {string} [explicit]  Explicit override
 * @returns {string}
 */
function resolveBridgePath(explicit) {
  if (explicit) return explicit;
  return "agent/agent-hook-bridge.mjs";
}

// ── 1. Codex project-level config.toml ──────────────────────────────────────

/**
 * Build the full content of a project-level `.codex/config.toml`.
 *
 * This generates ONLY project-scoped settings:
 *   - MCP servers (context7, sequential-thinking, playwright, microsoft-docs)
 *   - sandbox_mode
 *   - [sandbox_workspace_write]
 *   - [features] section
 *   - [shell_environment_policy]
 *   - [agent_sdk] with primary, max_threads, capabilities
 *
 * It does NOT contain (these belong in the global ~/.codex/config.toml):
 *   - [model_providers.*] — API keys are user-level
 *   - stream_idle_timeout_ms, retry settings — per-provider, global
 *
 * @param {object} options
 * @param {string}  options.repoRoot       Absolute path to the repo
 * @param {string}  [options.primarySdk]   "codex" | "copilot" | "claude" (default: "codex")
 * @param {object}  [options.env]          Environment overrides
 * @returns {string}  TOML content
 */
export function buildRepoCodexConfig(options = {}) {
  const {
    repoRoot,
    primarySdk = "codex",
    env = process.env,
  } = options;

  const parts = [
    "# Codex CLI project-level configuration",
    "# Generated by bosun repo-config — project-scoped settings only.",
    "#",
    "# Global settings (API keys, model providers) live in",
    "# ~/.codex/config.toml and are NOT duplicated here.",
    "",
  ];
  const platform = resolveConfigPlatform(env);

  // ── Sandbox mode ──
  parts.push(buildSandboxMode(env.CODEX_SANDBOX_MODE || env.CODEX_SANDBOX || undefined).trim());
  parts.push("");

  // ── Sandbox workspace write ──
  if (repoRoot) {
    const workspaceWriteBlock = buildSandboxWorkspaceWrite({
      writableRoots: env.CODEX_SANDBOX_WRITABLE_ROOTS || "",
      repoRoot,
      platform,
      tempDir: env.TEMP || env.TMP || "",
    });
    if (workspaceWriteBlock) {
      parts.push(workspaceWriteBlock.trim());
      parts.push("");
    }
  }

  // ── Features ──
  parts.push(buildFeaturesBlock(env).trim());
  parts.push("");

  // ── Shell environment policy ──
  parts.push(buildShellEnvPolicy(env.CODEX_SHELL_ENV_POLICY || "all").trim());
  parts.push("");

  // ── Agent SDK ──
  const resolvedPrimary = (() => {
    if (primarySdk && ["codex", "copilot", "claude"].includes(primarySdk)) {
      return primarySdk;
    }
    const envPrimary = (env.PRIMARY_AGENT || "").trim().toLowerCase().replace(/-sdk$/, "");
    if (["codex", "copilot", "claude"].includes(envPrimary)) return envPrimary;
    return "codex";
  })();
  parts.push(buildAgentSdkBlock({ primary: resolvedPrimary }).trim());
  parts.push("");

  // ── MCP servers ──
  const commonMcpBlocks = buildCommonMcpBlocks(env).trim();
  if (commonMcpBlocks) {
    parts.push(commonMcpBlocks);
    parts.push("");
  }

  // ── Installed library MCP servers ──
  if (repoRoot) {
    const installedBlocks = buildInstalledMcpBlocks(repoRoot, {
      skipServerIds: commonMcpBlocks ? COMMON_DEFAULT_MCP_SERVER_IDS : new Set(),
    }).trim();
    if (installedBlocks) {
      parts.push(installedBlocks);
      parts.push("");
    }
  }

  return parts.join("\n") + "\n";
}

/**
 * Merge a generated TOML config into an existing one.
 *
 * Strategy: for each well-known section header in the generated content,
 * if the existing content already has that section, leave it untouched.
 * Otherwise, append the section.  This preserves user customizations
 * while filling in missing defaults.
 *
 * @param {string} existing  Current file content
 * @param {string} generated Full generated content
 * @returns {string}  Merged content
 */
function mergeCodexToml(existing, generated) {
  // Extract sections from generated content
  // A section starts with a line matching /^\[.+\]/ and runs until the next
  // section header or EOF.
  const sectionRegex = /^(\[[\w._-]+\])/gm;
  const sections = [];
  let match;
  while ((match = sectionRegex.exec(generated)) !== null) {
    sections.push({ header: match[1], index: match.index });
  }

  // Also handle top-level keys that appear before the first section
  const firstSectionIdx = sections.length > 0 ? sections[0].index : generated.length;
  const preamble = generated.substring(0, firstSectionIdx);

  // Check for top-level keys in preamble (e.g. sandbox_permissions = ...)
  const topLevelKeys = [];
  for (const line of preamble.split("\n")) {
    const keyMatch = line.match(/^(\w+)\s*=/);
    if (keyMatch) topLevelKeys.push(keyMatch[1]);
  }

  let result = stripUnsupportedMicrosoftDocsToolsConfig(
    stripDeprecatedSandboxPermissions(existing.trimEnd()),
  );

  // Add missing top-level keys
  for (const key of topLevelKeys) {
    const keyRegex = new RegExp(`^${escapeRegex(key)}\\s*=`, "m");
    if (!keyRegex.test(result)) {
      // Find the line in the preamble
      for (const line of preamble.split("\n")) {
        if (line.startsWith(`${key} `) || line.startsWith(`${key}=`)) {
          result += "\n" + line;
          break;
        }
      }
    }
  }

  // Add missing sections
  for (let i = 0; i < sections.length; i++) {
    const { header, index: startIdx } = sections[i];
    const endIdx = i + 1 < sections.length ? sections[i + 1].index : generated.length;
    const block = generated.substring(startIdx, endIdx);

    if (!hasTomlSection(result, header)) {
      result = result.trimEnd() + "\n\n" + block.trim();
    }
  }

  result = ensureMcpStartupTimeout(result, "context7", 120);
  result = ensureMcpStartupTimeout(result, "sequential-thinking", 120);
  result = ensureMcpStartupTimeout(result, "playwright", 120);

  return stripUnsupportedMicrosoftDocsToolsConfig(
    stripDeprecatedSandboxPermissions(result),
  ).trimEnd() + "\n";
}

// ── 2. Claude settings.local.json ───────────────────────────────────────────

/**
 * Default Claude Code permission allowlist for Bosun-managed repos.
 *
 * Comprehensive enough to allow agents full autonomous operation
 * without interactive prompts, while staying explicit about what's allowed.
 */
const CLAUDE_PERMISSIONS_ALLOW = [
  // Full bash access
  "Bash(*)",
  // Explicit safe command families
  "Bash(git:*)",
  "Bash(gh:*)",
  "Bash(go:*)",
  "Bash(make:*)",
  "Bash(cd:*)",
  "Bash(ls:*)",
  // MCP tools
  // Web access (trusted domains)
  "WebFetch(domain:github.com)",
  "WebFetch(domain:bosun.ai)",
  // File editing
  "Edit",
  "MultiEdit",
  // File read/write
  "Read",
  "Write",
  // Computer tool
  "Computer:*",
];

/** Claude Code permission deny list (empty — we trust managed repos). */
const CLAUDE_PERMISSIONS_DENY = [];

/**
 * Build the Claude hooks object using the bosun bridge.
 * @param {string} bridgePath  Absolute path to agent-hook-bridge.mjs
 * @returns {object}  Hooks section for settings.local.json
 */
function buildClaudeHooks(bridgePath) {
  const nodeBin = (process.env.BOSUN_HOOK_NODE_BIN || "node").trim();
  const mkCmd = (event) => `${nodeBin} ${bridgePath} --agent claude --event ${event}`;
  return {
    UserPromptSubmit: [
      {
        matcher: "",
        hooks: [{ type: "command", command: mkCmd("UserPromptSubmit") }],
      },
    ],
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: mkCmd("PreToolUse") }],
      },
    ],
    PostToolUse: [
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: mkCmd("PostToolUse") }],
      },
    ],
    Stop: [
      {
        matcher: "",
        hooks: [{ type: "command", command: mkCmd("Stop") }],
      },
    ],
  };
}

/**
 * Build the `.claude/settings.local.json` content for a repo.
 *
 * Includes:
 *   - `permissions.allow` — comprehensive tool allowlist
 *   - `permissions.deny`  — empty (trusted repos)
 *   - `hooks`             — lifecycle hooks via bosun bridge
 *
 * @param {object} options
 * @param {string}  options.repoRoot         Absolute path to the repo
 * @param {string}  [options.bosunBridgePath]  Path to agent-hook-bridge.mjs
 * @returns {object}  JSON-serializable settings object
 */
export function buildRepoClaudeSettings(options = {}) {
  const { bosunBridgePath } = options;
  const bridgePath = resolveBridgePath(bosunBridgePath);

  return {
    permissions: {
      allow: [...CLAUDE_PERMISSIONS_ALLOW],
      deny: [...CLAUDE_PERMISSIONS_DENY],
    },
    hooks: buildClaudeHooks(bridgePath),
  };
}

/**
 * Merge generated Claude settings into an existing settings.local.json.
 *
 * - permissions.allow: union (add missing, keep existing)
 * - permissions.deny: replace with generated (empty)
 * - hooks: replace with latest bridge path
 *
 * @param {object|null} existing  Current file content (parsed JSON)
 * @param {object}      generated Generated settings
 * @returns {object}  Merged settings
 */
function mergeClaudeSettings(existing, generated) {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...existing }
      : {};

  // Merge permissions
  const existingPerms = base.permissions && typeof base.permissions === "object"
    ? base.permissions
    : {};
  const genPerms = generated.permissions || {};

  base.permissions = {
    allow: normalizeClaudePermissionsAllow(
      mergeArrayUnique(existingPerms.allow, genPerms.allow),
    ),
    deny: genPerms.deny || [],
  };

  // Hooks: always replace with latest bridge paths
  base.hooks = generated.hooks;

  return base;
}

// ── 3. VS Code settings ─────────────────────────────────────────────────────

/**
 * Build the `.vscode/settings.json` content object for a repo.
 *
 * Delegates to `buildRecommendedVsCodeSettings` from setup.mjs for
 * consistent settings across wizard and repo-config paths.
 *
 * @param {object} [options]
 * @param {object} [options.env]  Environment overrides
 * @returns {object}  JSON-serializable settings
 */
export function buildRepoVsCodeSettings(options = {}) {
  const { env = {} } = options;
  return buildRecommendedVsCodeSettings(env);
}

// ── 4. VS Code MCP config ──────────────────────────────────────────────────

/**
 * Build the `.vscode/mcp.json` content object.
 *
 * Includes all recommended MCP servers for Copilot:
 *   - context7, sequential-thinking, playwright, microsoft-docs
 *
 * @returns {object}  JSON-serializable MCP config
 */
export function buildRepoVsCodeMcpConfig() {
  return {
    mcpServers: {
      context7: {
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
        startup_timeout_sec: 120,
      },
      "sequential-thinking": {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
        startup_timeout_sec: 120,
      },
      playwright: {
        command: "npx",
        args: ["-y", "@playwright/mcp@latest"],
        startup_timeout_sec: 120,
      },
      "microsoft-docs": {
        url: "https://learn.microsoft.com/api/mcp",
      },
    },
  };
}

// ── 5. Main entry point ─────────────────────────────────────────────────────

/**
 * @typedef {object} FileResult
 * @property {string}  path     Absolute path to the file
 * @property {boolean} created  True if the file was freshly created
 * @property {boolean} updated  True if the file was updated (merged)
 * @property {boolean} skipped  True if no changes were needed
 */

/**
 * @typedef {object} RepoConfigResult
 * @property {FileResult} codexConfig    `.codex/config.toml`
 * @property {FileResult} claudeSettings `.claude/settings.local.json`
 * @property {FileResult} vsCodeSettings `.vscode/settings.json`
 * @property {FileResult} vsCodeMcp      `.vscode/mcp.json`
 */

/**
 * Ensure ALL repo-level AI executor configs exist in a given repo directory.
 *
 * For each config file:
 *   - `.codex/config.toml`:          Create or merge (add missing sections, don't overwrite)
 *   - `.claude/settings.local.json`: Merge permissions.allow (add missing entries), replace hooks
 *   - `.vscode/settings.json`:       Merge (existing values take priority, add missing)
 *   - `.vscode/mcp.json`:            Merge servers (existing take priority, add missing)
 *
 * @param {string} repoRoot  Absolute path to the repo directory
 * @param {object} [options]
 * @param {string}  [options.primarySdk]       "codex" | "copilot" | "claude" (default: "codex")
 * @param {string}  [options.bosunBridgePath]  Path to agent-hook-bridge.mjs
 * @param {object}  [options.env]              Environment overrides
 * @param {boolean} [options.dryRun]           If true, return results without writing files
 * @returns {RepoConfigResult}
 */
export function ensureRepoConfigs(repoRoot, options = {}) {
  const {
    primarySdk = "codex",
    bosunBridgePath,
    env = process.env,
    dryRun = false,
  } = options;

  const root = resolve(repoRoot);

  /** @type {RepoConfigResult} */
  const result = {
    codexConfig: { path: "", created: false, updated: false, skipped: false },
    claudeSettings: { path: "", created: false, updated: false, skipped: false },
    vsCodeSettings: { path: "", created: false, updated: false, skipped: false },
    vsCodeMcp: { path: "", created: false, updated: false, skipped: false },
  };

  // ── 1. .codex/config.toml ────────────────────────────────

  {
    const configPath = resolve(root, ".codex", "config.toml");
    result.codexConfig.path = configPath;

    const generated = buildRepoCodexConfig({ repoRoot: root, primarySdk, env });

    if (existsSync(configPath)) {
      const existing = readFileSync(configPath, "utf8");
      const merged = mergeCodexToml(existing, generated);
      if (merged.trimEnd() === existing.trimEnd()) {
        result.codexConfig.skipped = true;
      } else if (!dryRun) {
        writeFileSync(configPath, merged, "utf8");
        result.codexConfig.updated = true;
      } else {
        result.codexConfig.updated = true;
      }
    } else {
      if (!dryRun) {
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(configPath, generated, "utf8");
      }
      result.codexConfig.created = true;
    }
  }

  // ── 2. .claude/settings.local.json ────────────────────────

  {
    const settingsPath = resolve(root, ".claude", "settings.local.json");
    result.claudeSettings.path = settingsPath;

    const generated = buildRepoClaudeSettings({ repoRoot: root, bosunBridgePath });

    if (existsSync(settingsPath)) {
      const existing = loadJson(settingsPath);
      if (existing === null) {
        // File exists but is invalid JSON — write fresh
        if (!dryRun) {
          writeJson(settingsPath, generated);
        }
        result.claudeSettings.updated = true;
      } else {
        const merged = mergeClaudeSettings(existing, generated);
        const existingStr = JSON.stringify(existing, null, 2);
        const mergedStr = JSON.stringify(merged, null, 2);
        if (existingStr === mergedStr) {
          result.claudeSettings.skipped = true;
        } else if (!dryRun) {
          writeJson(settingsPath, merged);
          result.claudeSettings.updated = true;
        } else {
          result.claudeSettings.updated = true;
        }
      }
    } else {
      if (!dryRun) {
        writeJson(settingsPath, generated);
      }
      result.claudeSettings.created = true;
    }
  }

  // ── 3. .vscode/settings.json ──────────────────────────────

  {
    const settingsPath = resolve(root, ".vscode", "settings.json");
    result.vsCodeSettings.path = settingsPath;

    const recommended = buildRepoVsCodeSettings({ env });

    if (existsSync(settingsPath)) {
      let existing = {};
      try {
        existing = JSON.parse(readFileSync(settingsPath, "utf8"));
      } catch {
        existing = {};
      }

      // Existing values take priority for non-empty keys; add missing keys
      const merged = { ...recommended, ...existing };
      const existingStr = JSON.stringify(existing, null, 2);
      const mergedStr = JSON.stringify(merged, null, 2);
      if (existingStr === mergedStr) {
        result.vsCodeSettings.skipped = true;
      } else if (!dryRun) {
        mkdirSync(dirname(settingsPath), { recursive: true });
        writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
        result.vsCodeSettings.updated = true;
      } else {
        result.vsCodeSettings.updated = true;
      }
    } else {
      if (!dryRun) {
        mkdirSync(dirname(settingsPath), { recursive: true });
        writeFileSync(settingsPath, JSON.stringify(recommended, null, 2) + "\n", "utf8");
      }
      result.vsCodeSettings.created = true;
    }
  }

  // ── 4. .vscode/mcp.json ──────────────────────────────────

  {
    const mcpPath = resolve(root, ".vscode", "mcp.json");
    result.vsCodeMcp.path = mcpPath;

    const generated = buildRepoVsCodeMcpConfig();

    if (existsSync(mcpPath)) {
      let existing = {};
      try {
        existing = JSON.parse(readFileSync(mcpPath, "utf8"));
      } catch {
        existing = {};
      }

      const existingServers =
        existing.mcpServers ||
        existing["github.copilot.mcpServers"] ||
        (typeof existing === "object" && !existing.mcpServers ? existing : {});

      // Existing servers take priority; add missing from generated
      const mergedServers = {
        ...generated.mcpServers,
        ...(typeof existingServers === "object" ? existingServers : {}),
      };

      const next = { mcpServers: mergedServers };
      const existingStr = JSON.stringify(existing, null, 2);
      const nextStr = JSON.stringify(next, null, 2);
      if (existingStr === nextStr) {
        result.vsCodeMcp.skipped = true;
      } else if (!dryRun) {
        mkdirSync(dirname(mcpPath), { recursive: true });
        writeFileSync(mcpPath, JSON.stringify(next, null, 2) + "\n", "utf8");
        result.vsCodeMcp.updated = true;
      } else {
        result.vsCodeMcp.updated = true;
      }
    } else {
      if (!dryRun) {
        mkdirSync(dirname(mcpPath), { recursive: true });
        writeFileSync(mcpPath, JSON.stringify(generated, null, 2) + "\n", "utf8");
      }
      result.vsCodeMcp.created = true;
    }
  }

  return result;
}

// ── 6. Summary printer ──────────────────────────────────────────────────────

/**
 * Print a human-readable summary of what `ensureRepoConfigs()` did.
 *
 * @param {RepoConfigResult} result  Return value from ensureRepoConfigs()
 * @param {(msg: string) => void} [log]  Logger function (default: console.log)
 */
export function printRepoConfigSummary(result, log = console.log) {
  const entries = [
    { label: ".codex/config.toml", data: result.codexConfig },
    { label: ".claude/settings.local.json", data: result.claudeSettings },
    { label: ".vscode/settings.json", data: result.vsCodeSettings },
    { label: ".vscode/mcp.json", data: result.vsCodeMcp },
  ];

  let anyChange = false;

  for (const { label, data } of entries) {
    if (data.created) {
      log(`  + ${label}  (created)`);
      anyChange = true;
    } else if (data.updated) {
      log(`  ~ ${label}  (updated)`);
      anyChange = true;
    } else if (data.skipped) {
      log(`  = ${label}  (up to date)`);
    }
  }

  if (!anyChange) {
    log("  All repo-level AI configs are already up to date.");
  }
}

// ── Internal regex helper ────────────────────────────────────────────────────

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
