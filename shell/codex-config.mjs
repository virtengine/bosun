/**
 * codex-config.mjs — Manages the Codex CLI config (~/.codex/config.toml)
 *
 * Ensures the user's Codex CLI configuration has:
 *   1. Sufficient stream_idle_timeout_ms on all model providers
 *   2. Recommended defaults for long-running agentic workloads
 *   3. Feature flags for sub-agents, memory, undo, collaboration
 *   4. Sandbox permissions and shell environment policy
 *   5. Common MCP servers (context7, microsoft-docs)
 *
 * SCOPE: This manages the GLOBAL ~/.codex/config.toml which contains:
 *   - Model provider configs (API keys, base URLs) — MUST be global
 *   - Stream timeouts & retry settings — per-provider, global
 *   - Sandbox workspace-write (writable_roots) — spans multiple repos, global
 *   - Feature flags, MCP servers, agent_sdk — kept as FALLBACK defaults
 *     (prefer repo-level .codex/config.toml via repo-config.mjs)
 *
 * For project-scoped settings, see repo-config.mjs which generates
 * .codex/config.toml at the repo level.
 *
 * Uses string-based TOML manipulation (no parser dependency) — we only
 * append or patch well-known sections rather than rewriting the whole file.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, parse, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCodexProfileRuntime } from "./codex-model-profiles.mjs";
import {
  CONFIG_PATH,
  ensureTrustedProjects,
  getConfigPath,
  readCodexConfig,
  writeCodexConfig,
} from "./codex-config-file.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Constants ────────────────────────────────────────────────────────────────

/** Minimum recommended stream idle timeout (ms) for complex agentic tasks. */
const MIN_STREAM_IDLE_TIMEOUT_MS = 300_000; // 5 minutes

/** The recommended (generous) timeout for heavy reasoning models. */
const RECOMMENDED_STREAM_IDLE_TIMEOUT_MS = 3_600_000; // 60 minutes

// ── Agent SDK Selection (config.toml) ───────────────────────────────────────

const AGENT_SDK_HEADER = "[agent_sdk]";
const AGENT_SDK_CAPS_HEADER = "[agent_sdk.capabilities]";

const AGENTS_HEADER = "[agents]";
const DEFAULT_AGENT_MAX_THREADS = 12;

/**
 * Build the default [agent_sdk] TOML block.
 * @param {string} [primary="codex"]  The primary SDK: "codex", "copilot", or "claude"
 * @returns {string}
 */
function buildDefaultAgentSdkBlock(primary = "codex") {
  const caps = {
    codex:   { steering: true,  subagents: true,  vscodeTools: false },
    copilot: { steering: false, subagents: true,  vscodeTools: true  },
    claude:  { steering: false, subagents: true,  vscodeTools: false },
  };
  const c = caps[primary] || caps.codex;
  return [
    "",
    "# ── Agent SDK selection (added by bosun) ──",
    AGENT_SDK_HEADER,
    "# Primary agent SDK used for in-process automation.",
    '# Supported: "codex", "copilot", "claude"',
    `primary = "${primary}"`,
    "# Max concurrent agent threads per Codex session.",
    `max_threads = ${DEFAULT_AGENT_MAX_THREADS}`,
    "",
    AGENT_SDK_CAPS_HEADER,
    "# Live steering updates during an active run.",
    `steering = ${c.steering}`,
    "# Ability to spawn subagents/child tasks.",
    `subagents = ${c.subagents}`,
    "# Access to VS Code tools (Copilot extension).",
    `vscode_tools = ${c.vscodeTools}`,
    "",
  ].join("\n");
}

// ── Feature Flags ────────────────────────────────────────────────────────────

/**
 * Feature flags that should be enabled for sub-agents, collaboration,
 * memory, and continuous operation.  Keys are the [features] TOML keys;
 * values are { default, envVar, comment }.
 */
const RECOMMENDED_FEATURES = {
  // Sub-agents & collaboration
  child_agents_md:        { default: true, envVar: "CODEX_FEATURES_CHILD_AGENTS_MD",   comment: "Enable sub-agent discovery via CODEX.md" },
  multi_agent:                 { default: true, envVar: "CODEX_FEATURES_MULTI_AGENT",             comment: "Enable collaboration mode" },
  collaboration_modes:    { default: true, envVar: "CODEX_FEATURES_COLLABORATION_MODES", comment: "Enable collaboration mode selection" },

  // Continuity & recovery
  memories:            { default: true, envVar: "CODEX_FEATURES_MEMORIES",        comment: "Persistent memory across sessions" },
  undo:                   { default: true, envVar: "CODEX_FEATURES_UNDO",               comment: "Safe rollback of agent changes" },
  steer:                  { default: true, envVar: "CODEX_FEATURES_STEER",              comment: "Live steering during runs" },
  personality:            { default: true, envVar: "CODEX_FEATURES_PERSONALITY",         comment: "Agent personality persistence" },

  // Sandbox & execution
  use_linux_sandbox_bwrap:{ default: true, envVar: "CODEX_FEATURES_BWRAP",              comment: "Linux bubblewrap sandbox" },
  shell_tool:             { default: true, envVar: null,                                 comment: "Shell tool access" },
  unified_exec:           { default: true, envVar: null,                                 comment: "Unified execution" },
  shell_snapshot:         { default: true, envVar: null,                                 comment: "Shell state snapshots" },
  request_rule:           { default: true, envVar: null,                                 comment: "Request-level approval rules" },

  // Performance & networking
  // DISABLED: enable_request_compression corrupts the JSON request body when
  // used with Azure OpenAI wire_api=responses, causing invalid_request_error:
  // "'}' is invalid after a property name" / BytePositionInLine: ~82000.
  // The compression codec embeds unescaped content inside a JSON string field,
  // breaking the Azure Responses API parser even on small (~1 paragraph) inputs.
  enable_request_compression: { default: false, envVar: "CODEX_FEATURES_REQUEST_COMPRESSION", comment: "Compress requests (DISABLED — breaks Azure wire_api=responses)" },
  remote_models:          { default: true, envVar: null,                                 comment: "Remote model support" },
  skill_mcp_dependency_install: { default: true, envVar: null,                           comment: "Auto-install MCP skill deps" },

  // Experimental (disabled by default unless explicitly enabled)
};

const CRITICAL_ALWAYS_ON_FEATURES = new Set([
  "child_agents_md",
  "memories",
  "multi_agent",
  "collaboration_modes",
  "shell_tool",
  "unified_exec",
]);

// Features that must be DISABLED regardless of user-set value.
// These cause known compatibility failures (e.g. Azure wire_api=responses
// breaks when enable_request_compression embeds unescaped content in JSON).
const CRITICAL_ALWAYS_OFF_FEATURES = new Set([
  "enable_request_compression",
]);

function shouldDisableRemoteModels(envOverrides = process.env) {
  try {
    return resolveCodexProfileRuntime(envOverrides).provider === "azure";
  } catch {
    return false;
  }
}

function resolveRuntimePlatform(value = process.platform) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return process.platform;
  if (raw === "win32" || raw === "windows" || raw === "windows_nt" || raw.startsWith("mingw")) {
    return "win32";
  }
  if (raw === "darwin" || raw === "mac" || raw === "macos" || raw === "osx") {
    return "darwin";
  }
  if (raw === "linux") {
    return "linux";
  }
  return raw;
}

function resolvePlatformFromEnv(envOverrides = process.env, explicitPlatform = "") {
  return resolveRuntimePlatform(
    explicitPlatform ||
    envOverrides?.BOSUN_HOST_PLATFORM ||
    envOverrides?.npm_config_platform ||
    envOverrides?.OS ||
    process.platform,
  );
}

function getDefaultSandboxTempRoots({ platform = process.platform, tempDir = "" } = {}) {
  const resolvedPlatform = resolveRuntimePlatform(platform);
  if (resolvedPlatform === "win32") {
    const candidate = String(tempDir || process.env.TEMP || process.env.TMP || tmpdir() || "").trim();
    return candidate && isAbsolute(candidate) ? [candidate] : [];
  }
  return ["/tmp"];
}

function shouldDisableLinuxBwrap(envOverrides = process.env) {
  return resolvePlatformFromEnv(envOverrides) !== "linux";
}

function getRecommendedFeatureMeta(key, meta, envOverrides = process.env) {
  if (key === "use_linux_sandbox_bwrap" && shouldDisableLinuxBwrap(envOverrides)) {
    return {
      ...meta,
      default: false,
      comment: "Linux bubblewrap sandbox (DISABLED outside Linux)",
    };
  }
  if (key !== "remote_models") return meta;
  if (!shouldDisableRemoteModels(envOverrides)) return meta;
  return {
    ...meta,
    default: false,
    comment: "Remote model support (DISABLED for Azure - model listing returns HTTP 400)",
  };
}

function parsePositiveInt(value) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function resolveAgentMaxThreads(envOverrides = process.env) {
  const raw =
    envOverrides.CODEX_AGENT_MAX_THREADS ??
    envOverrides.CODEX_AGENTS_MAX_THREADS ??
    envOverrides.CODEX_MAX_THREADS;
  if (raw !== undefined) {
    return {
      value: parsePositiveInt(raw),
      explicit: true,
      raw,
    };
  }
  return {
    value: DEFAULT_AGENT_MAX_THREADS,
    explicit: false,
    raw: null,
  };
}

/**
 * Ensure max_threads is set under [agent_sdk] (NOT under [agents]).
 *
 * The [agents] section in Codex CLI uses serde(flatten), so any bare scalar
 * key is parsed as an agent role name and causes a deserialization error.
 * We store max_threads under [agent_sdk] which Bosun owns.
 *
 * Also migrates any stale max_threads from [agents] if found.
 */
function findSectionRange(toml, header) {
  const headerIdx = toml.indexOf(header);
  if (headerIdx === -1) return null;
  const afterHeader = headerIdx + header.length;
  const nextSection = toml.indexOf("\n[", afterHeader);
  const sectionEnd = nextSection === -1 ? toml.length : nextSection;
  return {
    headerIdx,
    afterHeader,
    sectionEnd,
    section: toml.substring(afterHeader, sectionEnd),
  };
}

function stripStaleAgentsMaxThreads(section) {
  const staleRegex = /^[ \t]*#[^\n]*max.*threads[^\n]*\n?|^[ \t]*max_threads\s*=\s*\d+[^\n]*\n?/gm;
  if (!staleRegex.test(section)) {
    return { section, changed: false };
  }
  return {
    section: section.replace(staleRegex, ""),
    changed: true,
  };
}

function sectionHasOnlyComments(section) {
  const remaining = String(section || "").trim();
  return !remaining || remaining.split(/\r?\n/).every((line) => {
    const trimmed = String(line || "").trim();
    return !trimmed || trimmed.startsWith("#");
  });
}

function removeStaleAgentsMaxThreads(toml) {
  let nextToml = toml;
  const agentsSection = findSectionRange(nextToml, AGENTS_HEADER);
  if (!agentsSection) {
    return { toml: nextToml, changed: false };
  }

  const strippedSection = stripStaleAgentsMaxThreads(agentsSection.section);
  if (!strippedSection.changed) {
    return { toml: nextToml, changed: false };
  }

  nextToml =
    nextToml.substring(0, agentsSection.afterHeader) +
    strippedSection.section +
    nextToml.substring(agentsSection.sectionEnd);

  const updatedAgentsSection = findSectionRange(nextToml, AGENTS_HEADER);
  if (!updatedAgentsSection) {
    return { toml: nextToml, changed: true };
  }

  if (!sectionHasOnlyComments(updatedAgentsSection.section)) {
    return { toml: nextToml, changed: true };
  }

  const lineStart = nextToml.lastIndexOf("\n", updatedAgentsSection.headerIdx);
  const removeFrom = lineStart === -1 ? updatedAgentsSection.headerIdx : lineStart;
  return {
    toml: nextToml.substring(0, removeFrom) + nextToml.substring(updatedAgentsSection.sectionEnd),
    changed: true,
  };
}
function resolveAgentSdkSectionRange(toml) {
  const sdkIdx = toml.indexOf(AGENT_SDK_HEADER);
  if (sdkIdx === -1) return null;
  const afterSdkHeader = sdkIdx + AGENT_SDK_HEADER.length;
  const capsIdx = toml.indexOf(AGENT_SDK_CAPS_HEADER, afterSdkHeader);
  const nextSectionIdx = toml.indexOf("\n[", afterSdkHeader);
  let sdkSectionEnd;
  if (capsIdx !== -1 && (nextSectionIdx === -1 || capsIdx <= nextSectionIdx)) {
    sdkSectionEnd = capsIdx;
  } else {
    sdkSectionEnd = nextSectionIdx === -1 ? toml.length : nextSectionIdx;
  }
  return { afterSdkHeader, sdkSectionEnd };
}

function upsertAgentSdkMaxThreads(toml, desired, overwrite) {
  const sdkRange = resolveAgentSdkSectionRange(toml);
  if (!sdkRange) {
    return {
      toml,
      changed: true,
      existing: null,
      added: true,
      updated: false,
    };
  }

  let sdkSection = toml.substring(sdkRange.afterSdkHeader, sdkRange.sdkSectionEnd);
  const maxThreadsRegex = /^max_threads\s*=\s*(\d+)/m;
  const match = sdkSection.match(maxThreadsRegex);
  if (match) {
    const existing = parsePositiveInt(match[1]);
    if (!overwrite || existing === desired) {
      return {
        toml,
        changed: false,
        existing,
        added: false,
        updated: false,
      };
    }
    sdkSection = sdkSection.replace(maxThreadsRegex, `max_threads = ${desired}`);
    return {
      toml: toml.substring(0, sdkRange.afterSdkHeader) + sdkSection + toml.substring(sdkRange.sdkSectionEnd),
      changed: true,
      existing,
      added: false,
      updated: true,
    };
  }

  sdkSection = sdkSection.trimEnd() + `\nmax_threads = ${desired}\n`;
  return {
    toml: toml.substring(0, sdkRange.afterSdkHeader) + sdkSection + toml.substring(sdkRange.sdkSectionEnd),
    changed: true,
    existing: null,
    added: true,
    updated: false,
  };
}

export function ensureAgentMaxThreads(
  toml,
  { maxThreads, overwrite = false } = {},
) {
  const result = {
    toml,
    changed: false,
    existing: null,
    applied: null,
    added: false,
    updated: false,
    skipped: false,
  };

  const desired = parsePositiveInt(maxThreads);
  if (!desired) {
    result.skipped = true;
    return result;
  }
  result.applied = desired;

  const migratedAgents = removeStaleAgentsMaxThreads(toml);
  toml = migratedAgents.toml;
  result.changed = migratedAgents.changed;

  const agentSdkUpdate = upsertAgentSdkMaxThreads(toml, desired, overwrite);
  result.toml = agentSdkUpdate.toml;
  result.existing = agentSdkUpdate.existing;
  result.added = agentSdkUpdate.added;
  result.updated = agentSdkUpdate.updated;
  result.changed = result.changed || agentSdkUpdate.changed;
  return result;
}
/**
 * Check whether config has a [features] section.
 */
export function hasFeaturesSection(toml) {
  return /^\[features\]/m.test(toml);
}

/**
 * Check whether config has a [shell_environment_policy] section.
 */
export function hasShellEnvPolicy(toml) {
  return /^\[shell_environment_policy\]/m.test(toml);
}

/**
 * Check whether config has sandbox_mode set (top-level key).
 */
export function hasSandboxMode(toml) {
  return /^sandbox_mode\s*=/m.test(toml);
}

function stripSandboxMode(toml) {
  let next = toml.replace(
    /^\s*#\s*Sandbox mode.*(?:\r?\n)?/gim,
    "",
  );
  next = next.replace(/^\s*sandbox_mode\s*=.*(?:\r?\n)?/gim, "");
  return next;
}

function extractSandboxModeValue(toml) {
  const lines = String(toml || "").split(/\r?\n/);
  const sandboxLine = lines.find((line) => line.trimStart().startsWith("sandbox_mode"));
  if (!sandboxLine) return "";
  const eqIdx = sandboxLine.indexOf("=");
  if (eqIdx === -1) return "";
  const raw = String(sandboxLine.slice(eqIdx + 1) || "").split("#")[0].trim();
  if (!raw) return "";
  const quoted = raw.match(/^"(.*)"$/) || raw.match(/^'(.*)'$/);
  if (quoted) return quoted[1];
  return raw;
}

function insertTopLevelSandboxMode(toml, modeValue) {
  const block = buildSandboxMode(modeValue).trim();
  const tableIdx = toml.search(/^\s*\[/m);
  if (tableIdx === -1) {
    return `${toml.trimEnd()}\n\n${block}\n`;
  }
  const head = toml.slice(0, tableIdx).trimEnd();
  const tail = toml.slice(tableIdx).trimStart();
  return `${head}\n\n${block}\n\n${tail}`;
}

function ensureTopLevelSandboxMode(toml, envValue) {
  const existingValue = extractSandboxModeValue(toml);
  const modeValue = envValue || existingValue || "workspace-write";
  const stripped = stripSandboxMode(toml);
  const updated = insertTopLevelSandboxMode(stripped, modeValue);
  return {
    toml: updated,
    changed: updated !== toml,
  };
}

/**
 * Build a [features] block with the recommended flags.
 * Reads environment overrides: set CODEX_FEATURES_<NAME>=false to disable.
 *
 * @param {object} [envOverrides]  Optional env map (defaults to process.env)
 * @returns {string}  TOML block
 */
export function buildFeaturesBlock(envOverrides = process.env) {
  const lines = [
    "",
    "# ── Feature flags (added by bosun) ──",
    "[features]",
  ];

  for (const [key, meta] of Object.entries(RECOMMENDED_FEATURES)) {
    const resolvedMeta = getRecommendedFeatureMeta(key, meta, envOverrides);
    let enabled = resolvedMeta.default;
    // Check env override
    if (resolvedMeta.envVar && envOverrides[resolvedMeta.envVar] !== undefined) {
      enabled = parseBoolEnv(envOverrides[resolvedMeta.envVar]);
    }
    if (resolvedMeta.comment) lines.push(`# ${resolvedMeta.comment}`);
    lines.push(`${key} = ${enabled}`);
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Ensure all recommended feature flags are present in an existing [features]
 * section.  Only adds missing keys — never overwrites user choices.
 *
 * @param {string} toml  Current config.toml content
 * @param {object} [envOverrides]  Optional env map (defaults to process.env)
 * @returns {{ toml: string, added: string[] }}
 */
export function ensureFeatureFlags(toml, envOverrides = process.env) {
  const added = [];
  const forcedOffFeatures = new Set(CRITICAL_ALWAYS_OFF_FEATURES);
  if (shouldDisableLinuxBwrap(envOverrides)) {
    forcedOffFeatures.add("use_linux_sandbox_bwrap");
  }
  if (shouldDisableRemoteModels(envOverrides)) {
    forcedOffFeatures.add("remote_models");
  }

  if (!hasFeaturesSection(toml)) {
    toml += buildFeaturesBlock(envOverrides);
    added.push(...Object.keys(RECOMMENDED_FEATURES));
    return { toml, added };
  }

  // Find the [features] section boundaries
  const header = "[features]";
  const headerIdx = toml.indexOf(header);
  const afterHeader = headerIdx + header.length;
  const nextSection = toml.indexOf("\n[", afterHeader);
  const sectionEnd = nextSection === -1 ? toml.length : nextSection;
  let section = toml.substring(afterHeader, sectionEnd);

  for (const [key, meta] of Object.entries(RECOMMENDED_FEATURES)) {
    const resolvedMeta = getRecommendedFeatureMeta(key, meta, envOverrides);
    const keyRegex = new RegExp(`^${escapeRegex(key)}\\s*=`, "m");
    const hasEnvOverride =
      resolvedMeta.envVar && envOverrides[resolvedMeta.envVar] !== undefined;
    const envValue = hasEnvOverride
      ? parseBoolEnv(envOverrides[resolvedMeta.envVar])
      : null;

    if (!keyRegex.test(section)) {
      const enabled = hasEnvOverride ? envValue : resolvedMeta.default;
      section = section.trimEnd() + `\n${key} = ${enabled}\n`;
      added.push(key);
      continue;
    }

    if (hasEnvOverride) {
      const valueRegex = new RegExp(
        `^(${escapeRegex(key)}\\s*=\\s*)(true|false)\\b.*$`,
        "m",
      );
      if (valueRegex.test(section)) {
        section = section.replace(valueRegex, `$1${envValue}`);
      }
    }

    if (CRITICAL_ALWAYS_ON_FEATURES.has(key)) {
      const disabledRegex = new RegExp(
        `^(${escapeRegex(key)}\\s*=\\s*)false\\b.*$`,
        "m",
      );
      if (disabledRegex.test(section)) {
        section = section.replace(disabledRegex, `$1true`);
      }
    }

    // Force certain features OFF regardless of what is in the file.
    // (e.g. enable_request_compression corrupts JSON bodies on Azure wire_api=responses)
    if (forcedOffFeatures.has(key)) {
      const enabledRegex = new RegExp(
        `^(${escapeRegex(key)}\\s*=\\s*)true\\b.*$`,
        "m",
      );
      if (enabledRegex.test(section)) {
        section = section.replace(enabledRegex, `$1false`);
      }
    }
  }

  toml = toml.substring(0, afterHeader) + section + toml.substring(sectionEnd);
  return { toml, added };
}

/**
 * Build the sandbox_mode top-level key.
 * Default: "workspace-write" for agentic workloads.
 *
 * Codex CLI expects sandbox_mode as a plain string, NOT an array.
 *
 * @param {string} [envValue]  CODEX_SANDBOX_MODE env var value
 * @returns {string}  TOML line(s)
 */
function normalizeSandboxModeValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  switch (raw.toLowerCase()) {
    case "disk-full-write-access":
    case "workspace-write":
      return "workspace-write";
    case "disk-read-only":
    case "read-only":
      return "read-only";
    case "danger-full-access":
      return "danger-full-access";
    default:
      return raw;
  }
}

export function buildSandboxMode(envValue) {
  const mode = normalizeSandboxModeValue(envValue) || "workspace-write";
  return `\n# Sandbox mode (added by bosun)\nsandbox_mode = "${mode}"\n`;
}

/**
 * @deprecated Compatibility shim for older callers.
 * `sandbox_permissions` has been replaced by `sandbox_mode` in Codex CLI.
 */
export function buildSandboxPermissions(envValue) {
  return buildSandboxMode(envValue);
}

/**
 * @deprecated Compatibility shim for older callers.
 * Retained to avoid runtime failures during mixed-version startup.
 */
export function ensureTopLevelSandboxPermissions(toml, envValue) {
  return ensureTopLevelSandboxMode(
    toml,
    normalizeSandboxModeValue(envValue) || undefined,
  );
}

function parseTomlArrayLiteral(raw) {
  if (!raw) return [];
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!inner.trim()) return [];
  return inner
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.replace(/^"(.*)"$/, "$1"))
    .map((item) => item.replace(/\\(["\\])/g, "$1"));
}

function formatTomlArray(values) {
  return `[${values.map((value) => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(", ")}]`;
}

function normalizeWritableRoots(input, { repoRoot, additionalRoots, validateExistence = false, platform = process.platform, tempDir = "" } = {}) {
  const roots = new Set();
  const addRoot = (value) => {
    const trimmed = String(value || "").trim();
    if (!trimmed) return;
    // Reject bare relative paths like ".git" — they resolve relative to CWD
    // at Codex launch time and cause "writable root does not exist" errors
    // (e.g. /home/user/.codex/.git). Only accept absolute paths.
    if (!isAbsolute(trimmed)) return;
    // When validateExistence is true, skip paths that don't exist on disk.
    // This prevents the sandbox from failing to start with phantom roots.
    if (validateExistence && !existsSync(trimmed)) return;
    roots.add(trimmed);
  };
  // Always-add: these are primary roots (repo root, parent) that should be
  // present even if validateExistence is true — they're the intended CWD.
  const addPrimaryRoot = (value) => {
    const trimmed = String(value || "").trim();
    if (!trimmed || !isAbsolute(trimmed)) return;
    roots.add(trimmed);
  };
  if (Array.isArray(input)) {
    input.forEach(addRoot);
  } else if (typeof input === "string") {
    input
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .forEach(addRoot);
  }

  // Add paths for a repo root — only if it's a non-empty absolute path
  const addRepoRootPaths = (repo) => {
    if (!repo) return;
    const r = String(repo).trim();
    if (!r || !isAbsolute(r)) return;
    // Repo root and parent are always added (they're primary working dirs)
    addPrimaryRoot(r);
    const gitDir = resolve(r, ".git");
    // Only add .git if it actually exists (prevents phantom writable roots)
    if (existsSync(gitDir)) addRoot(gitDir);
    const cacheWorktrees = resolve(r, ".cache", "worktrees");
    // Only add .cache subdirs if they exist — avoid phantom roots
    if (existsSync(cacheWorktrees)) addRoot(cacheWorktrees);
    const cacheDir = resolve(r, ".cache");
    if (existsSync(cacheDir)) addRoot(cacheDir);
    const parent = dirname(r);
    if (parent && parent !== r) addPrimaryRoot(parent);
  };

  addRepoRootPaths(repoRoot);

  // Add paths for additional workspace repo roots
  if (Array.isArray(additionalRoots)) {
    for (const root of additionalRoots) {
      addRepoRootPaths(root);
    }
  }

  for (const tempRoot of getDefaultSandboxTempRoots({ platform, tempDir })) {
    addRoot(tempRoot);
  }

  return Array.from(roots);
}

/**
 * Validate that a directory has a valid .git ancestor (regular repo or worktree).
 * In worktrees, .git is a file containing "gitdir: <path>" — follow the reference
 * to find the actual git object store. Returns the resolved .git directory path
 * or null if not found.
 * @param {string} dir - Directory to check
 * @returns {{ gitDir: string|null, mainWorktreeRoot: string|null, isWorktree: boolean }}
 */
export function ensureGitAncestor(dir) {
  if (!dir) return { gitDir: null, mainWorktreeRoot: null, isWorktree: false };
  let current = resolve(dir);
  const { root } = parse(current);
  while (current !== root) {
    const gitPath = resolve(current, ".git");
    if (existsSync(gitPath)) {
      try {
        const stat = statSync(gitPath);
        if (stat.isDirectory()) {
          // Regular git repo
          return { gitDir: gitPath, mainWorktreeRoot: current, isWorktree: false };
        }
        if (stat.isFile()) {
          // Worktree: .git is a file with "gitdir: <relative-or-absolute-path>"
          const content = readFileSync(gitPath, "utf8").trim();
          const match = content.match(/^gitdir:\s*(.+)$/);
          if (match) {
            const gitdirRef = resolve(current, match[1].trim());
            // Worktree gitdir points to <main-repo>/.git/worktrees/<name>
            // Walk up 2 levels to get the main .git directory
            const mainGitDir = resolve(gitdirRef, "..", "..");
            const mainRepoRoot = dirname(mainGitDir);
            return {
              gitDir: mainGitDir,
              mainWorktreeRoot: mainRepoRoot,
              isWorktree: true,
            };
          }
        }
      } catch { /* permission error, race, etc. */ }
    }
    current = dirname(current);
  }
  return { gitDir: null, mainWorktreeRoot: null, isWorktree: false };
}

/**
 * Build writable roots for a specific task's execution context.
 * Combines the global config roots with task-specific paths (worktree, repo root).
 * @param {{ worktreePath?: string, repoRoot?: string, existingRoots?: string[] }} opts
 * @returns {string[]} Merged writable roots
 */
export function buildTaskWritableRoots({ worktreePath, repoRoot, existingRoots = [], tempDir = "", platform = process.platform } = {}) {
  const roots = new Set(existingRoots.filter(r => r && isAbsolute(r) && existsSync(r)));
  const addIfExists = (p) => {
    if (p && isAbsolute(p) && existsSync(p)) roots.add(p);
  };
  // Add path even if it doesn't exist yet (will be created by the task)
  const addRoot = (p) => {
    if (p && isAbsolute(p)) roots.add(p);
  };

  if (worktreePath) {
    addRoot(worktreePath); // Worktree dir itself may be about to be created
    // Worktrees have a .git file pointing to main repo — resolve the actual git dir
    const ancestor = ensureGitAncestor(worktreePath);
    if (ancestor.gitDir) addIfExists(ancestor.gitDir);
    if (ancestor.mainWorktreeRoot) {
      addIfExists(resolve(ancestor.mainWorktreeRoot, ".git"));
      addIfExists(resolve(ancestor.mainWorktreeRoot, ".cache", "worktrees"));
    }
  }
  if (repoRoot) {
    addRoot(repoRoot);
    const gitDir = resolve(repoRoot, ".git");
    if (existsSync(gitDir)) addIfExists(gitDir);
    addIfExists(resolve(repoRoot, ".cache", "worktrees"));
    addIfExists(resolve(repoRoot, ".cache"));
    const parent = dirname(repoRoot);
    if (parent && parent !== repoRoot) addIfExists(parent);
  }
  for (const tempRoot of getDefaultSandboxTempRoots({ platform, tempDir })) {
    addIfExists(tempRoot);
  }
  return Array.from(roots);
}

export function hasSandboxWorkspaceWrite(toml) {
  return /^\[sandbox_workspace_write\]/m.test(toml);
}

export function buildSandboxWorkspaceWrite(options = {}) {
  const {
    writableRoots = [],
    repoRoot,
    additionalRoots,
    networkAccess = true,
    excludeTmpdirEnvVar = false,
    excludeSlashTmp = false,
    platform = process.platform,
    tempDir = "",
  } = options;

  const desiredRoots = normalizeWritableRoots(writableRoots, {
    repoRoot,
    additionalRoots,
    validateExistence: true,
    platform,
    tempDir,
  });
  if (desiredRoots.length === 0) {
    return "";
  }
  return buildSandboxWorkspaceWriteBlock({
    desiredRoots,
    networkAccess,
    excludeTmpdirEnvVar,
    excludeSlashTmp,
  });
}

function buildSandboxWorkspaceWriteBlock({
  desiredRoots,
  networkAccess,
  excludeTmpdirEnvVar,
  excludeSlashTmp,
}) {
  return [
    "",
    "# ── Workspace-write sandbox defaults (added by bosun) ──",
    "[sandbox_workspace_write]",
    `network_access = ${networkAccess}`,
    `exclude_tmpdir_env_var = ${excludeTmpdirEnvVar}`,
    `exclude_slash_tmp = ${excludeSlashTmp}`,
    `writable_roots = ${formatTomlArray(desiredRoots)}`,
    "",
  ].join("\n");
}

function findTomlSection(toml, header) {
  const headerIdx = toml.indexOf(header);
  if (headerIdx === -1) return null;
  const afterHeader = headerIdx + header.length;
  const nextSection = toml.indexOf("\n[", afterHeader);
  const sectionEnd = nextSection === -1 ? toml.length : nextSection;
  return {
    headerIdx,
    afterHeader,
    sectionEnd,
    section: toml.substring(afterHeader, sectionEnd),
  };
}

function ensureSandboxWorkspaceFlags(section, flags) {
  let nextSection = section;
  let changed = false;
  for (const [key, value] of Object.entries(flags)) {
    const keyRegex = new RegExp(`^${escapeRegex(key)}\\s*=`, "m");
    if (keyRegex.test(nextSection)) continue;
    nextSection = nextSection.trimEnd() + `\n${key} = ${value}\n`;
    changed = true;
  }
  return { section: nextSection, changed };
}

function mergeSandboxWorkspaceRoots(section, desiredRoots, repoRoot, { platform = process.platform, tempDir = "" } = {}) {
  const rootsRegex = /^writable_roots\s*=\s*(\[[^\]]*\])\s*$/m;
  const match = section.match(rootsRegex);
  if (!match) {
    if (desiredRoots.length === 0) {
      return { section, changed: false, rootsAdded: [] };
    }
    return {
      section: section.trimEnd() + `\nwritable_roots = ${formatTomlArray(desiredRoots)}\n`,
      changed: true,
      rootsAdded: desiredRoots,
    };
  }

  const existingRoots = parseTomlArrayLiteral(match[1]);
  const preservedRoots = new Set(getDefaultSandboxTempRoots({ platform, tempDir }));
  const validExisting = existingRoots.filter((root) => preservedRoots.has(root) || existsSync(root));
  const merged = normalizeWritableRoots(validExisting, {
    repoRoot,
    validateExistence: true,
    platform,
    tempDir,
  });
  const rootsAdded = [];
  for (const root of desiredRoots) {
    if (merged.includes(root)) continue;
    merged.push(root);
    rootsAdded.push(root);
  }

  let changed = existingRoots.some((root) => !preservedRoots.has(root) && !existsSync(root));
  const formatted = formatTomlArray(merged);
  if (formatted !== match[1]) {
    section = section.replace(rootsRegex, `writable_roots = ${formatted}`);
    changed = true;
  }

  return { section, changed, rootsAdded };
}

export function ensureSandboxWorkspaceWrite(toml, options = {}) {
  const {
    writableRoots = [],
    repoRoot,
    additionalRoots,
    networkAccess = true,
    excludeTmpdirEnvVar = false,
    excludeSlashTmp = false,
    platform = process.platform,
    tempDir = "",
  } = options;

  const desiredRoots = normalizeWritableRoots(writableRoots, {
    repoRoot,
    additionalRoots,
    validateExistence: true,
    platform,
    tempDir,
  });
  if (!hasSandboxWorkspaceWrite(toml)) {
    if (desiredRoots.length === 0) {
      return { toml, changed: false, added: false, rootsAdded: [] };
    }
    return {
      toml: toml.trimEnd() + "\n" + buildSandboxWorkspaceWriteBlock({
        desiredRoots,
        networkAccess,
        excludeTmpdirEnvVar,
        excludeSlashTmp,
      }),
      changed: true,
      added: true,
      rootsAdded: desiredRoots,
    };
  }

  const sectionInfo = findTomlSection(toml, "[sandbox_workspace_write]");
  if (!sectionInfo) {
    return { toml, changed: false, added: false, rootsAdded: [] };
  }

  const flagsResult = ensureSandboxWorkspaceFlags(sectionInfo.section, {
    network_access: networkAccess,
    exclude_tmpdir_env_var: excludeTmpdirEnvVar,
    exclude_slash_tmp: excludeSlashTmp,
  });
  const rootsResult = mergeSandboxWorkspaceRoots(flagsResult.section, desiredRoots, repoRoot, {
    platform,
    tempDir,
  });
  if (!flagsResult.changed && !rootsResult.changed) {
    return { toml, changed: false, added: false, rootsAdded: [] };
  }

  return {
    toml:
      toml.substring(0, sectionInfo.afterHeader) +
      rootsResult.section +
      toml.substring(sectionInfo.sectionEnd),
    changed: true,
    added: false,
    rootsAdded: rootsResult.rootsAdded,
  };
}

/**
 * Prunes non-existent entries from the `[sandbox_workspace_write]` writable_roots list.
 *
 * Looks up the `writable_roots` array in the `[sandbox_workspace_write]` section,
 * checks each path on disk, and removes any roots that no longer exist. The `/tmp`
 * root is always preserved, even if it cannot be checked reliably. Returns the
 * updated TOML (if any change was made), a `changed` flag, and the list of roots
 * that were removed.
 *
 * @param {string} toml - The full Codex TOML configuration contents.
 * @returns {{ toml: string, changed: boolean, removed: string[] }} Result of pruning.
 */
export function pruneStaleSandboxRoots(toml, options = {}) {
  if (!hasSandboxWorkspaceWrite(toml)) {
    return { toml, changed: false, removed: [] };
  }
  const sectionInfo = findTomlSection(toml, "[sandbox_workspace_write]");
  if (!sectionInfo) return { toml, changed: false, removed: [] };

  const rootsRegex = /^writable_roots\s*=\s*(\[[^\]]*\])\s*$/m;
  const match = sectionInfo.section.match(rootsRegex);
  if (!match) return { toml, changed: false, removed: [] };

  const existing = parseTomlArrayLiteral(match[1]);
  const preservedRoots = new Set(getDefaultSandboxTempRoots(options));
  const valid = existing.filter((root) => preservedRoots.has(root) || existsSync(root));
  const removed = existing.filter((root) => !preservedRoots.has(root) && !existsSync(root));
  if (removed.length === 0) return { toml, changed: false, removed: [] };

  const nextSection = sectionInfo.section.replace(
    rootsRegex,
    `writable_roots = ${formatTomlArray(valid)}`,
  );
  return {
    toml:
      toml.substring(0, sectionInfo.afterHeader) +
      nextSection +
      toml.substring(sectionInfo.sectionEnd),
    changed: true,
    removed,
  };
}
/**
 * Build the [shell_environment_policy] section.
 * Default: inherit = "all" so .NET, Go, Node etc. env vars are visible.
 *
 * @param {string} [policy]  "all" | "none" | "allowlist"
 * @returns {string}  TOML block
 */
export function buildShellEnvPolicy(policy = "all") {
  return [
    "",
    "# ── Shell environment policy (added by bosun) ──",
    "[shell_environment_policy]",
    `inherit = "${policy}"`,
    "",
  ].join("\n");
}

/**
 * Check whether config has a [mcp_servers.context7] section.
 */
export function hasContext7Mcp(toml) {
  return /^\[mcp_servers\.context7\]/m.test(toml);
}

/**
 * Check whether config has a [mcp_servers.microsoft-docs] or microsoft_docs section.
 */
export function hasMicrosoftDocsMcp(toml) {
  return /^\[mcp_servers\.microsoft[_-]docs\]/m.test(toml);
}

/**
 * Build MCP server blocks for common servers: context7, sequential-thinking,
 * playwright, and microsoft-docs. These are universally useful for
 * documentation lookups and related tasks.
 */
const COMMON_MCP_SERVER_DEFS = [
  {
    name: "context7",
    headerComment: "# ── Common MCP servers (added by bosun) ──",
    lines: [
      "[mcp_servers.context7]",
      "startup_timeout_sec = 120",
      'command = "npx"',
      'args = ["-y", "@upstash/context7-mcp"]',
    ],
    isPresent: hasContext7Mcp,
  },
  {
    name: "sequential-thinking",
    lines: [
      "[mcp_servers.sequential-thinking]",
      "startup_timeout_sec = 120",
      'command = "npx"',
      'args = ["-y", "@modelcontextprotocol/server-sequential-thinking"]',
    ],
    isPresent: (toml) => hasNamedMcpServer(toml, "sequential-thinking"),
  },
  {
    name: "playwright",
    lines: [
      "[mcp_servers.playwright]",
      "startup_timeout_sec = 120",
      'command = "npx"',
      'args = ["-y", "@playwright/mcp@latest"]',
    ],
    isPresent: (toml) => hasNamedMcpServer(toml, "playwright"),
  },
  {
    name: "microsoft-docs",
    lines: [
      "[mcp_servers.microsoft-docs]",
      'url = "https://learn.microsoft.com/api/mcp"',
    ],
    isPresent: hasMicrosoftDocsMcp,
  },
];

function shouldIncludeDefaultMcpServers(env = process.env) {
  const raw = String(env.BOSUN_MCP_ALLOW_DEFAULT_SERVERS || "")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "on", "y"].includes(raw);
}

function buildCommonMcpBlock(definition) {
  return [
    "",
    ...(definition.headerComment ? [definition.headerComment] : []),
    ...definition.lines,
    "",
  ].join("\n");
}

export function buildCommonMcpBlocks(env = process.env) {
  if (!shouldIncludeDefaultMcpServers(env)) {
    return "";
  }
  return COMMON_MCP_SERVER_DEFS.map(buildCommonMcpBlock).join("");
}

function hasNamedMcpServer(toml, name) {
  return new RegExp(`^\\[mcp_servers\\.${escapeRegex(name)}\\]`, "m").test(
    toml,
  );
}

function ensureMcpStartupTimeout(toml, name, timeoutSec = 120) {
  const header = `[mcp_servers.${name}]`;
  const headerIdx = toml.indexOf(header);
  if (headerIdx === -1) return { toml, changed: false };

  const afterHeader = headerIdx + header.length;
  const nextSection = toml.indexOf("\n[", afterHeader);
  const sectionEnd = nextSection === -1 ? toml.length : nextSection;
  let section = toml.substring(afterHeader, sectionEnd);

  const timeoutRegex = /^startup_timeout_sec\s*=\s*\d+.*$/m;
  let changed = false;
  if (timeoutRegex.test(section)) {
    const desired = `startup_timeout_sec = ${timeoutSec}`;
    const updated = section.replace(timeoutRegex, desired);
    if (updated !== section) {
      section = updated;
      changed = true;
    }
  } else {
    section = section.trimEnd() + `\nstartup_timeout_sec = ${timeoutSec}\n`;
    changed = true;
  }

  if (!changed) return { toml, changed: false };
  return {
    toml: toml.substring(0, afterHeader) + section + toml.substring(sectionEnd),
    changed: true,
  };
}

function stripUnsupportedMicrosoftDocsToolsConfig(toml) {
  let nextToml = String(toml || "");
  for (const name of ["microsoft-docs", "microsoft_docs"]) {
    const header = `[mcp_servers.${name}]`;
    const headerIdx = nextToml.indexOf(header);
    if (headerIdx === -1) continue;

    const afterHeader = headerIdx + header.length;
    const nextSection = nextToml.indexOf("\n[", afterHeader);
    const sectionEnd = nextSection === -1 ? nextToml.length : nextSection;
    const section = nextToml.substring(afterHeader, sectionEnd);
    const cleaned = section.replace(
      /^\s*tools\s*=\s*\[[^\n]*\]\s*(?:\r?\n)?/gm,
      "",
    );

    if (cleaned !== section) {
      nextToml =
        nextToml.substring(0, afterHeader) + cleaned + nextToml.substring(sectionEnd);
    }
  }
  return nextToml;
}

function stripDeprecatedSandboxPermissions(toml) {
  return String(toml || "").replace(
    /^\s*sandbox_permissions\s*=.*(?:\r?\n)?/gim,
    "",
  );
}

// ── Public API ───────────────────────────────────────────────────────────────

export { readCodexConfig };

export { writeCodexConfig };

export { getConfigPath };

/**
 * Check whether the config already has an [agent_sdk] section.
 */
export function hasAgentSdkConfig(toml) {
  return /^\[agent_sdk\]/m.test(toml);
}

/**
 * Build the default agent SDK block.
 * @param {object}  [opts]
 * @param {string}  [opts.primary="codex"]  Primary SDK: "codex", "copilot", or "claude"
 * @returns {string}
 */
export function buildAgentSdkBlock({ primary = "codex" } = {}) {
  return buildDefaultAgentSdkBlock(primary);
}



/**
 * Scan all [model_providers.*] sections for stream_idle_timeout_ms.
 * Returns an array of { provider, currentValue, needsUpdate }.
 */
export function auditStreamTimeouts(toml) {
  const results = [];
  // Find all model_providers sections
  const providerRegex = /^\[model_providers\.(\w+)\]/gm;
  let match;
  while ((match = providerRegex.exec(toml)) !== null) {
    const providerName = match[1];
    const sectionStart = match.index + match[0].length;
    const nextSection = toml.indexOf("\n[", sectionStart);
    const sectionEnd = nextSection === -1 ? toml.length : nextSection;
    const section = toml.substring(sectionStart, sectionEnd);

    const timeoutMatch = section.match(/stream_idle_timeout_ms\s*=\s*(\d+)/);
    const currentValue = timeoutMatch ? Number(timeoutMatch[1]) : null;

    results.push({
      provider: providerName,
      currentValue,
      needsUpdate:
        currentValue === null || currentValue < MIN_STREAM_IDLE_TIMEOUT_MS,
      recommended: RECOMMENDED_STREAM_IDLE_TIMEOUT_MS,
    });
  }
  return results;
}

/**
 * Set stream_idle_timeout_ms on a specific model provider section.
 * If the key already exists, update it.  If not, append it at the end of the section.
 *
 * @param {string} toml  Current TOML content
 * @param {string} providerName  e.g. "azure", "openai"
 * @param {number} value  Timeout in ms
 * @returns {string}  Updated TOML
 */
export function setStreamTimeout(toml, providerName, value) {
  const header = `[model_providers.${providerName}]`;
  const headerIdx = toml.indexOf(header);
  if (headerIdx === -1) return toml;

  const afterHeader = headerIdx + header.length;
  const nextSection = toml.indexOf("\n[", afterHeader);
  const sectionEnd = nextSection === -1 ? toml.length : nextSection;

  let section = toml.substring(afterHeader, sectionEnd);

  const timeoutRegex = /^stream_idle_timeout_ms\s*=\s*\d+.*$/m;
  if (timeoutRegex.test(section)) {
    section = section.replace(
      timeoutRegex,
      `stream_idle_timeout_ms = ${value}  # Updated by bosun`,
    );
  } else {
    // Append to end of section
    section =
      section.trimEnd() +
      `\nstream_idle_timeout_ms = ${value}  # Added by bosun\n`;
  }

  return toml.substring(0, afterHeader) + section + toml.substring(sectionEnd);
}

function hasModelProviderSection(toml, providerName) {
  return new RegExp(`^\\[model_providers\\.${escapeRegex(providerName)}\\]`, "m").test(
    toml,
  );
}

function buildModelProviderSection(providerName, config = {}) {
  const lines = ["", `[model_providers.${providerName}]`];
  if (config.name) lines.push(`name = "${config.name}"`);
  if (config.baseUrl) lines.push(`base_url = "${config.baseUrl}"`);
  if (config.envKey) lines.push(`env_key = "${config.envKey}"`);
  if (config.wireApi) lines.push(`wire_api = "${config.wireApi}"`);
  if (config.model) lines.push(`model = "${config.model}"`);
  lines.push("");
  return lines.join("\n");
}

function setModelProviderField(toml, providerName, key, value) {
  const header = `[model_providers.${providerName}]`;
  const headerIdx = toml.indexOf(header);
  if (headerIdx === -1) return toml;

  const afterHeader = headerIdx + header.length;
  const nextSection = toml.indexOf("\n[", afterHeader);
  const sectionEnd = nextSection === -1 ? toml.length : nextSection;

  let section = toml.substring(afterHeader, sectionEnd);
  const fieldRegex = new RegExp(`^${escapeRegex(key)}\\s*=.*$`, "m");
  const escapedValue = String(value || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  const line = `${key} = "${escapedValue}"`;

  if (fieldRegex.test(section)) {
    section = section.replace(fieldRegex, line);
  } else {
    section = `${section.trimEnd()}\n${line}\n`;
  }

  return toml.substring(0, afterHeader) + section + toml.substring(sectionEnd);
}

/**
 * Codex CLI built-in provider IDs that cannot be used in [model_providers.*].
 * Declaring these in config.toml causes a fatal "reserved built-in provider"
 * error on Codex CLI >=0.x (March 2026+).
 */
const CODEX_RESERVED_PROVIDER_IDS = new Set(["openai"]);

/**
 * Migrate legacy [model_providers.openai] sections that Bosun previously
 * generated.  Newer Codex CLI versions reject this ID as a reserved built-in.
 * We rename it to "openai-direct" so existing timeout / retry settings
 * are preserved without triggering the error.
 */
function migrateReservedProviderIds(toml) {
  const migrated = [];
  for (const reserved of CODEX_RESERVED_PROVIDER_IDS) {
    const header = `[model_providers.${reserved}]`;
    if (toml.includes(header)) {
      const replacement = `[model_providers.${reserved}-direct]`;
      toml = toml.replace(header, replacement);
      migrated.push({ from: reserved, to: `${reserved}-direct` });
    }
  }
  return { toml, migrated };
}

export function ensureModelProviderSectionsFromEnv(toml, env = process.env) {
  const added = [];
  const updated = [];
  const { env: resolvedEnv, active } = resolveCodexProfileRuntime(env);

  // Migrate any legacy reserved provider IDs before adding new sections
  const migration = migrateReservedProviderIds(toml);
  toml = migration.toml;

  const activeProvider = String(active?.provider || "").toLowerCase();
  const activeBaseUrl =
    active?.baseUrl ||
    resolvedEnv.OPENAI_BASE_URL ||
    "";

  if (
    activeProvider === "azure" ||
    (() => {
      try {
        const parsed = new URL(String(activeBaseUrl || ""));
        const host = String(parsed.hostname || "").toLowerCase();
        return host === "openai.azure.com" || host.endsWith(".openai.azure.com") || host.endsWith(".cognitiveservices.azure.com");
      } catch {
        return false;
      }
    })()
  ) {
    if (!hasModelProviderSection(toml, "azure")) {
      toml += buildModelProviderSection("azure", {
        name: "Azure OpenAI",
        baseUrl: activeBaseUrl,
        envKey: "AZURE_OPENAI_API_KEY",
        wireApi: "responses",
        model: active?.model || resolvedEnv.CODEX_MODEL || "",
      });
      added.push("azure");
    } else if (activeBaseUrl) {
      const updatedToml = setModelProviderField(toml, "azure", "base_url", activeBaseUrl);
      if (updatedToml !== toml) {
        toml = updatedToml;
        updated.push("azure.base_url");
      }
    }
  }

  // NOTE: Do NOT add [model_providers.openai] — it is a Codex built-in.
  // The built-in already handles OPENAI_API_KEY.  Declaring it causes:
  //   "model_providers contains reserved built-in provider IDs: openai"

  return { toml, added, updated, migrated: migration.migrated };
}

/**
 * Ensure retry settings exist on a model provider section.
 * Adds sensible defaults for long-running agentic workloads.
 */
export function ensureRetrySettings(toml, providerName) {
  const header = `[model_providers.${providerName}]`;
  const headerIdx = toml.indexOf(header);
  if (headerIdx === -1) return toml;

  const afterHeader = headerIdx + header.length;
  const nextSection = toml.indexOf("\n[", afterHeader);
  const sectionEnd = nextSection === -1 ? toml.length : nextSection;

  let section = toml.substring(afterHeader, sectionEnd);

  const defaults = {
    request_max_retries: 6,
    stream_max_retries: 15,
  };

  for (const [key, defaultVal] of Object.entries(defaults)) {
    const keyRegex = new RegExp(`^${key}\\s*=`, "m");
    if (!keyRegex.test(section)) {
      section =
        section.trimEnd() +
        `\n${key} = ${defaultVal}  # Added by bosun\n`;
    }
  }

  return toml.substring(0, afterHeader) + section + toml.substring(sectionEnd);
}

/**
 * High-level: ensure the config.toml is properly configured for bosun.
 *
 * Returns an object describing what was done:
 *   { created, timeoutsFixed[], retriesAdded[],
 *     featuresAdded[], sandboxAdded, shellEnvAdded, commonMcpAdded, path }
 *
 * @param {object} opts
 * @param {boolean} [opts.dryRun]  If true, returns result without writing
 * @param {object}  [opts.env]     Environment overrides (defaults to process.env)
 * @param {string}  [opts.primarySdk]  Primary agent SDK: "codex", "copilot", or "claude"
 */
function resolveSandboxWorkspaceOptions(env) {
  const repoRoot =
    env.BOSUN_AGENT_REPO_ROOT ||
    env.REPO_ROOT ||
    env.BOSUN_HOME ||
    process.cwd();
  const additionalRoots = env.BOSUN_WORKSPACES_DIR
    ? [env.BOSUN_WORKSPACES_DIR]
    : [];
  return {
    repoRoot,
    additionalRoots,
    writableRoots: env.CODEX_SANDBOX_WRITABLE_ROOTS,
  };
}

function applySandboxDefaults(toml, env, result) {
  const sandboxModeResult = ensureTopLevelSandboxMode(
    toml,
    env.CODEX_SANDBOX_MODE || env.CODEX_SANDBOX,
  );
  let nextToml = sandboxModeResult.toml;
  if (sandboxModeResult.changed) {
    result.sandboxAdded = true;
  }

  const sandboxOptions = resolveSandboxWorkspaceOptions(env);
  const sandboxWorkspaceResult = ensureSandboxWorkspaceWrite(nextToml, sandboxOptions);
  nextToml = sandboxWorkspaceResult.toml;
  result.sandboxWorkspaceAdded = sandboxWorkspaceResult.added;
  result.sandboxWorkspaceUpdated =
    sandboxWorkspaceResult.changed && !sandboxWorkspaceResult.added;
  result.sandboxWorkspaceRootsAdded = sandboxWorkspaceResult.rootsAdded;

  const pruneResult = pruneStaleSandboxRoots(nextToml);
  nextToml = pruneResult.toml;
  result.sandboxStaleRootsRemoved = pruneResult.removed;

  if (!hasShellEnvPolicy(nextToml)) {
    nextToml += buildShellEnvPolicy(env.CODEX_SHELL_ENV_POLICY || "all");
    result.shellEnvAdded = true;
  }

  return { toml: nextToml, ...sandboxOptions };
}

function normalizePrimarySdkName(primarySdk, env) {
  const rawPrimary = String(primarySdk || env.PRIMARY_AGENT || "codex")
    .trim()
    .toLowerCase();
  if (rawPrimary === "copilot" || rawPrimary.includes("copilot")) return "copilot";
  if (rawPrimary === "claude" || rawPrimary.includes("claude")) return "claude";
  if (rawPrimary === "codex" || rawPrimary.includes("codex")) return "codex";
  return "codex";
}

function applyAgentSdkDefaults(toml, env, primarySdk, result) {
  let nextToml = toml;
  const normalizedPrimary = normalizePrimarySdkName(primarySdk, env);
  if (!hasAgentSdkConfig(nextToml)) {
    nextToml += buildAgentSdkBlock({ primary: normalizedPrimary });
    result.agentSdkAdded = true;
  }

  const maxThreads = resolveAgentMaxThreads(env);
  if (maxThreads.explicit && !maxThreads.value) {
    result.agentMaxThreadsSkipped = String(maxThreads.raw);
    return nextToml;
  }

  const maxThreadsResult = ensureAgentMaxThreads(nextToml, {
    maxThreads: maxThreads.value,
    overwrite: maxThreads.explicit,
  });
  nextToml = maxThreadsResult.toml;
  if (maxThreadsResult.changed && !maxThreadsResult.skipped) {
    result.agentMaxThreads = {
      from: maxThreadsResult.existing,
      to: maxThreadsResult.applied,
      explicit: maxThreads.explicit,
    };
  } else if (maxThreadsResult.skipped && maxThreads.explicit) {
    result.agentMaxThreadsSkipped = String(maxThreads.raw);
  }

  return nextToml;
}

function ensureCommonMcpDefaults(toml, result, env = process.env) {
  if (!shouldIncludeDefaultMcpServers(env)) {
    return toml;
  }
  let nextToml = toml;
  for (const definition of COMMON_MCP_SERVER_DEFS) {
    if (!definition.isPresent(nextToml)) {
      nextToml += buildCommonMcpBlock(definition);
      result.commonMcpAdded = true;
    }
  }

  for (const serverName of ["context7", "sequential-thinking", "playwright"]) {
    const timeoutResult = ensureMcpStartupTimeout(nextToml, serverName, 120);
    nextToml = timeoutResult.toml;
  }

  return nextToml;
}

function applyModelProviderDefaults(toml, env, result) {
  let nextToml = toml;
  const providerResult = ensureModelProviderSectionsFromEnv(nextToml, env);
  nextToml = providerResult.toml;
  result.profileProvidersAdded = providerResult.added;

  const timeoutAudit = auditStreamTimeouts(nextToml);
  for (const item of timeoutAudit) {
    if (!item.needsUpdate) continue;
    nextToml = setStreamTimeout(nextToml, item.provider, RECOMMENDED_STREAM_IDLE_TIMEOUT_MS);
    result.timeoutsFixed.push({
      provider: item.provider,
      from: item.currentValue,
      to: RECOMMENDED_STREAM_IDLE_TIMEOUT_MS,
    });
  }

  for (const provider of auditStreamTimeouts(nextToml).map((item) => item.provider)) {
    const beforeRetry = nextToml;
    nextToml = ensureRetrySettings(nextToml, provider);
    if (nextToml !== beforeRetry) {
      result.retriesAdded.push(provider);
    }
  }

  return nextToml;
}

function applyTrustedProjectDefaults(repoRoot, additionalRoots, dryRun, result) {
  const trustPaths = [repoRoot, ...additionalRoots]
    .map((p) => String(p || "").trim())
    .filter(Boolean)
    .filter((p) => isAbsolute(p));
  if (trustPaths.length > 0) {
    const trustResult = ensureTrustedProjects(trustPaths, { dryRun });
    result.trustedProjectsAdded = trustResult.added;
  }
}

function createEnsureCodexConfigResult() {
  return {
    path: CONFIG_PATH,
    created: false,
    agentSdkAdded: false,
    featuresAdded: [],
    agentMaxThreads: null,
    agentMaxThreadsSkipped: null,
    sandboxAdded: false,
    sandboxWorkspaceAdded: false,
    sandboxWorkspaceUpdated: false,
    sandboxWorkspaceRootsAdded: [],
    sandboxStaleRootsRemoved: [],
    shellEnvAdded: false,
    commonMcpAdded: false,
    profileProvidersAdded: [],
    timeoutsFixed: [],
    retriesAdded: [],
    trustedProjectsAdded: [],
    noChanges: true,
  };
}

function looksLikeToml(content) {
  // A valid TOML file either: starts with a comment (#), a section header ([...]),
  // a key = value assignment, or is effectively empty (only whitespace/comments).
  // Reject files that start with freeform prose (e.g., agent instruction text).
  const trimmed = String(content || "").trimStart();
  if (!trimmed) return true; // empty is fine
  // TOML lines start with #, [, a bare/quoted key, or whitespace
  const firstLine = trimmed.split(/\r?\n/)[0] || "";
  return /^[\s]*([#\[]|[A-Za-z0-9_"'])/.test(firstLine) &&
    !/^(You are |I am |As an |This is a |Here is |The following|REMAIN IN |While you )/.test(firstLine);
}

function initializeCodexConfigState(result) {
  const configExisted = existsSync(CONFIG_PATH);
  const originalToml = readCodexConfig();
  if (!configExisted) {
    result.created = true;
    return { originalToml, toml: "" };
  }
  if (!looksLikeToml(originalToml)) {
    // The file contains non-TOML content (e.g., agent instructions written by
    // an earlier Codex session or incorrect write). Treat as freshly created to
    // avoid producing a hybrid file that breaks the Codex desktop app.
    console.warn(
      "[codex-config] ~/.codex/config.toml contains non-TOML content — treating as empty and regenerating",
    );
    result.created = true;
    return { originalToml, toml: "" };
  }
  return {
    originalToml,
    toml: stripUnsupportedMicrosoftDocsToolsConfig(
      stripDeprecatedSandboxPermissions(originalToml),
    ),
  };
}

function applyEnsureCodexConfigDefaults(toml, env, primarySdk, result) {
  const sandboxState = applySandboxDefaults(toml, env, result);
  let nextToml = sandboxState.toml;

  nextToml = applyAgentSdkDefaults(nextToml, env, primarySdk, result);

  const featureResult = ensureFeatureFlags(nextToml, env);
  result.featuresAdded = featureResult.added;
  nextToml = featureResult.toml;

  nextToml = ensureCommonMcpDefaults(nextToml, result, env);
  nextToml = applyModelProviderDefaults(nextToml, env, result);

  return { sandboxState, toml: nextToml };
}

function persistCodexConfigIfChanged(toml, originalToml, dryRun, result) {
  const changed = toml !== originalToml;
  result.noChanges = !result.created && !changed;
  if (!dryRun && (result.created || changed)) {
    writeCodexConfig(toml);
  }
}

export function ensureCodexConfig({
  dryRun = false,
  env = process.env,
  primarySdk,
} = {}) {
  const result = createEnsureCodexConfigResult();
  const { originalToml, toml: initialToml } = initializeCodexConfigState(result);
  const { sandboxState, toml } = applyEnsureCodexConfigDefaults(
    initialToml,
    env,
    primarySdk,
    result,
  );

  persistCodexConfigIfChanged(toml, originalToml, dryRun, result);
  applyTrustedProjectDefaults(
    sandboxState.repoRoot,
    sandboxState.additionalRoots,
    dryRun,
    result,
  );
  return result;
}

function logConfigSummaryHeader(result, log) {
  if (result.created) {
    log("  :edit: Created new Codex CLI config");
  }

  if (result.agentSdkAdded) {
    log("  :check: Added agent SDK selection block");
  }

  if (result.featuresAdded && result.featuresAdded.length > 0) {
    const key = result.featuresAdded.length <= 5
      ? result.featuresAdded.join(", ")
      : `${result.featuresAdded.length} feature flags`;
    log(`  :check: Added feature flags: ${key}`);
  }
}

function logSandboxSummary(result, log) {
  if (result.sandboxAdded) {
    log("  :check: Added sandbox permissions (disk-full-write-access)");
  }

  if (result.sandboxWorkspaceAdded) {
    log("  :check: Added sandbox workspace-write defaults");
  } else if (result.sandboxWorkspaceUpdated) {
    log("  :check: Updated sandbox workspace-write defaults");
  }

  if (result.sandboxWorkspaceRootsAdded && result.sandboxWorkspaceRootsAdded.length > 0) {
    log(
      `     Writable roots: ${result.sandboxWorkspaceRootsAdded.join(", ")}`,
    );
  }

  if (result.sandboxStaleRootsRemoved && result.sandboxStaleRootsRemoved.length > 0) {
    log(
      `  :trash:  Pruned ${result.sandboxStaleRootsRemoved.length} stale writable root(s) that no longer exist`,
    );
    for (const r of result.sandboxStaleRootsRemoved) {
      log(`     - ${r}`);
    }
  }

  if (result.shellEnvAdded) {
    log("  :check: Added shell environment policy (inherit=all)");
  }
}

function logAgentSdkSummary(result, log) {
  if (result.agentMaxThreads) {
    const fromLabel =
      result.agentMaxThreads.from === null
        ? "unset"
        : String(result.agentMaxThreads.from);
    const toLabel = String(result.agentMaxThreads.to);
    const note = result.agentMaxThreads.explicit ? " (env override)" : "";
    log(`  :check: Set agents.max_threads: ${fromLabel} → ${toLabel}${note}`);
  } else if (result.agentMaxThreadsSkipped) {
    log(
      `  :alert: Skipped agents.max_threads (invalid value: ${result.agentMaxThreadsSkipped})`,
    );
  }
}

function logProviderSummary(result, log) {
  if (result.commonMcpAdded) {
    log(
      "  :check: Added common MCP servers (context7, sequential-thinking, playwright, microsoft-docs)",
    );
  }

  if (result.profileProvidersAdded && result.profileProvidersAdded.length > 0) {
    log(
      `  :check: Added model provider sections: ${result.profileProvidersAdded.join(", ")}`,
    );
  }

  for (const t of result.timeoutsFixed) {
    const fromLabel =
      t.from === null ? "not set" : `${(t.from / 1000).toFixed(0)}s`;
    const toLabel = `${(t.to / 1000 / 60).toFixed(0)} min`;
    log(
      `  :check: Set stream_idle_timeout_ms on [${t.provider}]: ${fromLabel} → ${toLabel}`,
    );
  }

  for (const p of result.retriesAdded) {
    log(`  :check: Added retry settings to [${p}]`);
  }
}

/**
 * Print a human-friendly summary of what ensureCodexConfig() did.
 * @param {object} result  Return value from ensureCodexConfig()
 * @param {(msg: string) => void} [log]  Logger (default: console.log)
 */
export function printConfigSummary(result, log = console.log) {
  if (result.noChanges) {
    log("  :check: Codex CLI config is already up to date");
    log(`     ${result.path}`);
    return;
  }

  logConfigSummaryHeader(result, log);
  logSandboxSummary(result, log);
  logAgentSdkSummary(result, log);
  logProviderSummary(result, log);
  log(`     Config: ${result.path}`);
}
export { ensureTrustedProjects };
// ── Internal Helpers ─────────────────────────────────────────────────────────

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseBoolEnv(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (["0", "false", "no", "off", "n"].includes(raw)) return false;
  return true;
}


