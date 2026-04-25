/**
 * copilot-shell.mjs — Persistent Copilot SDK agent for bosun.
 *
 * Uses the GitHub Copilot SDK (@github/copilot-sdk) to maintain a persistent
 * session with multi-turn conversation, tool use (shell, file I/O, MCP), and
 * streaming. Designed as a drop-in primary agent when Copilot is configured
 * as the primary executor.
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync, copyFileSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolveRepoRoot } from "../config/repo-root.mjs";
import { loadConfig } from "../config/config.mjs";
import { getGitHubToken } from "../github/github-auth-manager.mjs";
import {
  isTransientStreamError,
  streamRetryDelay,
  MAX_STREAM_RETRIES,
} from "../infra/stream-resilience.mjs";
import { maybeCompressSessionItems } from "../workspace/context-cache.mjs";
import { createShellSessionCompat } from "./shell-session-compat.mjs";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));
const require = createRequire(import.meta.url);

// Lazy-import MCP registry — cached at module scope per AGENTS.md rules.
let _mcpRegistry = null;
async function getMcpRegistry() {
  if (!_mcpRegistry) {
    _mcpRegistry = await import("../workflow/mcp-registry.mjs");
  }
  return _mcpRegistry;
}

// ── Configuration ────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000; // 60 min for agentic tasks
const MAX_TIMER_DELAY_MS = 2_147_483_647; // Node.js timer clamp (2^31 - 1)
const STATE_FILE = resolve(__dirname, "..", "logs", "copilot-shell-state.json");
const SESSION_LOG_DIR = resolve(__dirname, "..", "logs", "copilot-sessions");
const REPO_ROOT = resolveRepoRoot();
const timeoutNormalizationWarningKey = new Set();

// Valid reasoning effort levels for models that support it
const VALID_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"];

// ── State ────────────────────────────────────────────────────────────────────

let CopilotClientClass = null; // CopilotClient class from SDK
let copilotClient = null;
let clientStarted = false;
let activeSession = null;
let activeSessionId = null;
let activeTurn = false;
let turnCount = 0;
let workspacePath = null;
const copilotSessionCompat = createShellSessionCompat({
  adapterName: "copilot",
  providerSelection: "copilot",
});

function envFlagEnabled(value) {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "on", "y"].includes(raw);
}

function getMcpRuntimeConfig() {
  try {
    const cfg = loadConfig();
    return cfg?.mcpServers && typeof cfg.mcpServers === "object"
      ? cfg.mcpServers
      : {};
  } catch {
    return {};
  }
}

function resolveCopilotTransport() {
  const raw = String(process.env.COPILOT_TRANSPORT || "auto")
    .trim()
    .toLowerCase();
  if (["auto", "sdk", "cli", "url"].includes(raw)) {
    return raw;
  }
  console.warn(
    `[copilot-shell] invalid COPILOT_TRANSPORT='${raw}', defaulting to 'auto'`,
  );
  return "auto";
}

export function resolveCopilotCliLaunchConfig({
  env = process.env,
  repoRoot = REPO_ROOT,
  cliArgs = [],
  fileExists = existsSync,
  execPath = process.execPath,
} = {}) {
  const explicitCliPath =
    String(env.COPILOT_CLI_PATH || env.GITHUB_COPILOT_CLI_PATH || "").trim() ||
    undefined;
  const normalizedCliArgs = Array.isArray(cliArgs) ? [...cliArgs] : [];

  if (explicitCliPath) {
    return {
      cliPath: explicitCliPath,
      cliArgs: normalizedCliArgs,
      source: "env",
    };
  }

  const bundledLoaderPath = resolve(
    repoRoot,
    "node_modules",
    "@github",
    "copilot",
    "npm-loader.js",
  );
  if (fileExists(bundledLoaderPath)) {
    return {
      cliPath: execPath,
      cliArgs: [bundledLoaderPath, ...normalizedCliArgs],
      source: "bundled",
    };
  }

  return {
    cliPath: undefined,
    cliArgs: normalizedCliArgs,
    source: "path",
  };
}

function normalizeProfileKey(name) {
  return String(name || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_");
}

function parseMcpServersValue(raw) {
  if (!raw) return null;
  const parsed = safeJsonParse(raw);
  if (!parsed) return null;
  if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
    return parsed.mcpServers;
  }
  if (parsed["github.copilot.mcpServers"]) {
    return parsed["github.copilot.mcpServers"];
  }
  if (parsed.mcp && parsed.mcp.servers && typeof parsed.mcp.servers === "object") {
    return parsed.mcp.servers;
  }
  if (typeof parsed === "object") return parsed;
  return null;
}

function resolveCopilotProfile(env = process.env) {
  const name = String(env.COPILOT_PROFILE || "").trim();
  if (!name) {
    return { name: "", model: "", reasoningEffort: "", mcpConfig: "", mcpServers: null };
  }
  const key = normalizeProfileKey(name);
  const prefix = `COPILOT_PROFILE_${key}_`;
  const model = String(env[`${prefix}MODEL`] || "").trim();
  const reasoningEffort = String(env[`${prefix}REASONING_EFFORT`] || "").trim();
  const mcpConfig = String(env[`${prefix}MCP_CONFIG`] || "").trim();
  const mcpServers = parseMcpServersValue(env[`${prefix}MCP_SERVERS`]);
  return {
    name,
    model,
    reasoningEffort,
    mcpConfig,
    mcpServers,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function timestamp() {
  return new Date().toISOString();
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function safeStringify(value, maxLen = 8000) {
  let text = "";
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text.length > maxLen) {
    text = text.slice(0, maxLen) + "...";
  }
  return text;
}

function parsePositiveTimeoutMs(value, fallback = DEFAULT_TIMEOUT_MS) {
  const fallbackValue = Number(fallback);
  if (!Number.isFinite(fallbackValue) || fallbackValue <= 0) {
    throw new Error("parsePositiveTimeoutMs requires a positive finite fallback");
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackValue;
  return parsed;
}

function normalizeTimeoutMs(value, { fallback = DEFAULT_TIMEOUT_MS, label = "timeoutMs" } = {}) {
  const parsed = parsePositiveTimeoutMs(value, fallback);
  const normalized = Math.min(parsed, MAX_TIMER_DELAY_MS);
  if (normalized !== parsed && !timeoutNormalizationWarningKey.has(label)) {
    timeoutNormalizationWarningKey.add(label);
    console.warn(
      `[copilot-shell] ${label} ${parsed}ms exceeds Node.js timer max; clamped to ${MAX_TIMER_DELAY_MS}ms`,
    );
  }
  return normalized;
}

function initSessionLog(sessionId, prompt, timeoutMs) {
  if (!sessionId) return null;
  try {
    mkdirSync(SESSION_LOG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const shortId = sessionId.slice(0, 8);
    const logPath = resolve(
      SESSION_LOG_DIR,
      `copilot-session-${stamp}-${shortId}.log`,
    );
    const header = [
      "# Copilot Session Log",
      `# Timestamp: ${timestamp()}`,
      `# Session ID: ${sessionId}`,
      `# Timeout: ${timeoutMs}ms`,
      `# Prompt: ${(prompt || "").slice(0, 500)}`,
      "",
    ].join("\n");
    appendFileSync(logPath, header + "\n");
    return logPath;
  } catch {
    return null;
  }
}

function logSessionEvent(logPath, event) {
  if (!logPath || !event) return;
  try {
    const payload = safeStringify(event);
    appendFileSync(
      logPath,
      `${timestamp()} ${event.type || "event"} ${payload}\n`,
    );
  } catch {
    /* best effort */
  }
}

// ── CLI Args & Handlers ──────────────────────────────────────────────────────

/**
 * Build CLI arguments for the Copilot subprocess.
 * Enables experimental features (fleet, autopilot), auto-permissions,
 * sub-agents, and autonomy.
 */
async function buildCliArgs() {
  const args = [];

  // Always enable experimental features (fleet, autopilot, persisted permissions, etc.)
  if (!envFlagEnabled(process.env.COPILOT_NO_EXPERIMENTAL)) {
    args.push("--experimental");
  }

  // Auto-approve all permissions (tools, paths, URLs) — equivalent to /allow-all or /yolo
  if (!envFlagEnabled(process.env.COPILOT_NO_ALLOW_ALL)) {
    args.push("--allow-all");
  }

  // Disable ask_user tool — agent works fully autonomously
  if (!envFlagEnabled(process.env.COPILOT_ENABLE_ASK_USER)) {
    args.push("--no-ask-user");
  }

  // Prevent auto-update during SDK sessions (avoid mid-task restarts)
  args.push("--no-auto-update");

  // Enable all GitHub MCP tools if requested
  if (envFlagEnabled(process.env.COPILOT_ENABLE_ALL_GITHUB_MCP_TOOLS)) {
    args.push("--enable-all-github-mcp-tools");
  }

  // Disable built-in MCPs if custom ones are provided exclusively
  if (envFlagEnabled(process.env.COPILOT_DISABLE_BUILTIN_MCPS)) {
    args.push("--disable-builtin-mcps");
  }

  // Enable parallel tool execution for sub-agent-like concurrency
  if (!envFlagEnabled(process.env.COPILOT_DISABLE_PARALLEL_TOOLS)) {
    // Parallel is on by default; only disable if explicitly set
  } else {
    args.push("--disable-parallel-tools-execution");
  }

  // Add additional MCP config if available (for fleet/task sub-agent MCP servers)
  const mcpConfigPath = process.env.COPILOT_ADDITIONAL_MCP_CONFIG;
  if (mcpConfigPath) {
    args.push("--additional-mcp-config", mcpConfigPath);
  }

  // Also write a temp MCP config from the library if installed servers exist
  // (non-fatal: library MCP is a convenience, not a hard requirement)
  if (!mcpConfigPath) {
    try {
      const registry = await getMcpRegistry();
      const mcpCfg = getMcpRuntimeConfig();
      const installed = await registry.listInstalledMcpServers(REPO_ROOT);
      const ids = installed && installed.length ? installed.map((e) => e.id) : [];
      let resolved = await registry.resolveMcpServersForAgent(REPO_ROOT, ids);
      if (typeof registry.wrapServersWithDiscoveryProxy === "function") {
        resolved = registry.wrapServersWithDiscoveryProxy(REPO_ROOT, resolved, {
          enabled: mcpCfg.useDiscoveryProxy !== false,
          includeCustomTools: mcpCfg.includeCustomToolsInDiscoveryProxy !== false,
          cacheTtlMs: mcpCfg.discoveryProxyCacheTtlMs,
          executeTimeoutMs: mcpCfg.discoveryProxyExecuteTimeoutMs,
        });
      }
      if (resolved && resolved.length) {
        const tmpPath = registry.writeTempCopilotMcpConfig(REPO_ROOT, resolved);
        args.push("--additional-mcp-config", tmpPath);
        console.log(`[copilot-shell] injected ${resolved.length} library MCP server(s) via CLI args`);
      }
    } catch (err) {
      console.warn(`[copilot-shell] failed to inject library MCP servers into CLI args: ${err.message}`);
    }
  }

  if (args.length > 0) {
    console.log(`[copilot-shell] cliArgs: ${args.join(" ")}`);
  }
  return args;
}

/**
 * Auto-approve all permission requests (shell, write, read, mcp, url).
 * This is the SDK equivalent of --allow-all / --yolo.
 */
function autoApprovePermissions(request, _invocation) {
  return { kind: "approved", rules: [] };
}

/**
 * Auto-respond to agent user-input requests.
 * Provides sensible defaults so the agent never blocks waiting for human input.
 */
function autoRespondToUserInput(request, _invocation) {
  // If choices are provided, pick the first one
  if (request.choices && request.choices.length > 0) {
    console.log(
      `[copilot-shell] auto-responding to "${request.question}" with choice: "${request.choices[0]}"`,
    );
    return { answer: request.choices[0], wasFreeform: false };
  }
  // For y/n style questions, default to "yes"
  const question = (request.question || "").toLowerCase();
  if (/\b(y\/n|yes\/no|confirm|proceed|continue)\b/i.test(question)) {
    console.log(
      `[copilot-shell] auto-responding "yes" to: "${request.question}"`,
    );
    return { answer: "yes", wasFreeform: true };
  }
  // Generic: tell the agent to proceed with its best judgment
  console.log(
    `[copilot-shell] auto-responding to: "${request.question}"`,
  );
  return {
    answer: "Proceed with your best judgment. Do not wait for human input.",
    wasFreeform: true,
  };
}

/**
 * Session lifecycle hooks for observability and logging.
 */
function buildSessionHooks() {
  return {
    onPreToolUse: async (input, _invocation) => {
      // Auto-allow all tool executions
      return { permissionDecision: "allow" };
    },
    onSessionStart: async (input, _invocation) => {
      console.log(`[copilot-shell] session hook: started (source=${input.source})`);
      return {};
    },
    onSessionEnd: async (input, _invocation) => {
      console.log(
        `[copilot-shell] session hook: ended (reason=${input.reason})`,
      );
      return {};
    },
    onErrorOccurred: async (input, _invocation) => {
      console.error(
        `[copilot-shell] session hook: error in ${input.errorContext}: ${input.error} (recoverable=${input.recoverable})`,
      );
      // Auto-retry recoverable errors
      if (input.recoverable) {
        return { errorHandling: "retry", retryCount: 2 };
      }
      return { errorHandling: "skip" };
    },
  };
}

// ── SDK Loading ──────────────────────────────────────────────────────────────

let _attemptedJsonRpcNodeCompatPatch = false;

function ensureJsonRpcNodeCompatShim(options = {}) {
  const state = options.shimState && typeof options.shimState === "object"
    ? options.shimState
    : null;
  if (state) {
    if (state.attempted) return false;
    state.attempted = true;
  } else {
    if (_attemptedJsonRpcNodeCompatPatch) return false;
    _attemptedJsonRpcNodeCompatPatch = true;
  }

  try {
    const resolvePackageJsonPath =
      typeof options.resolvePackageJsonPath === "function"
        ? options.resolvePackageJsonPath
        : () => require.resolve("vscode-jsonrpc/package.json");
    const fileExists =
      typeof options.fileExists === "function"
        ? options.fileExists
        : existsSync;
    const copyFile =
      typeof options.copyFile === "function"
        ? options.copyFile
        : copyFileSync;
    const log =
      typeof options.log === "function"
        ? options.log
        : console.log;
    const warn =
      typeof options.warn === "function"
        ? options.warn
        : console.warn;
    const packageJsonPath = resolvePackageJsonPath();
    const packageDir = dirname(packageJsonPath);
    const extensionlessNodePath = resolve(packageDir, "node");
    const nodeJsPath = resolve(packageDir, "node.js");
    if (fileExists(extensionlessNodePath) || !fileExists(nodeJsPath)) {
      return false;
    }
    copyFile(nodeJsPath, extensionlessNodePath);
    log(
      `[copilot-shell] applied vscode-jsonrpc compatibility shim: ${extensionlessNodePath}`,
    );
    return true;
  } catch (err) {
    const warn =
      typeof options.warn === "function"
        ? options.warn
        : console.warn;
    warn(
      `[copilot-shell] unable to apply vscode-jsonrpc compatibility shim: ${err?.message || err}`,
    );
    return false;
  }
}

export async function importCopilotSdkModuleWithCompat(options = {}) {
  const importer =
    typeof options.importer === "function"
      ? options.importer
      : async () => await import("@github/copilot-sdk");
  const shimApplied = ensureJsonRpcNodeCompatShim(options);
  try {
    return await importer();
  } catch (err) {
    const message = String(err?.message || err || "");
    if (
      message.includes("vscode-jsonrpc/node") &&
      (shimApplied || ensureJsonRpcNodeCompatShim(options))
    ) {
      return await importer();
    }
    throw err;
  }
}

async function loadCopilotSdk() {
  if (CopilotClientClass) return CopilotClientClass;
  if (envFlagEnabled(process.env.COPILOT_SDK_DISABLED)) {
    console.warn("[copilot-shell] SDK disabled via COPILOT_SDK_DISABLED");
    return null;
  }

  try {
    const mod = await importCopilotSdkModuleWithCompat();
    CopilotClientClass =
      mod.CopilotClient || mod.default?.CopilotClient || null;
    if (!CopilotClientClass) {
      throw new Error("CopilotClient export not found");
    }
    console.log("[copilot-shell] SDK loaded successfully");
    return CopilotClientClass;
  } catch (err) {
    console.error(`[copilot-shell] failed to load SDK: ${err?.message || err}`);
    return null;
  }
}

/**
 * Detect GitHub token from multiple sources (auth passthrough).
 * Priority: Copilot-specific ENV > github-auth-manager (OAuth/App/gh-CLI/env) > undefined
 */
async function detectGitHubToken() {
  // 1. Copilot-specific token env var (highest priority, no round-trips)
  const copilotEnvToken = process.env.COPILOT_CLI_TOKEN || process.env.GITHUB_PAT;
  if (copilotEnvToken) {
    console.log("[copilot-shell] using Copilot token from environment");
    return copilotEnvToken;
  }

  // 2. Use unified auth manager (OAuth > App installation > gh CLI > GITHUB_TOKEN/GH_TOKEN)
  try {
    const { token, type } = await getGitHubToken().catch(() => ({
      token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
      type: "env",
    }));
    if (token) {
      console.log(`[copilot-shell] using token from auth manager (${type})`);
      return token;
    }
  } catch {
    // fall through
  }

  // 3. gh CLI is authenticated — SDK will use it automatically
  try {
    execSync("gh auth status", { stdio: "pipe", encoding: "utf8" });
    console.log("[copilot-shell] gh CLI is authenticated — using SDK default auth");
    return undefined;
  } catch {
    // gh not authenticated or not installed
  }

  console.log("[copilot-shell] no pre-auth detected, using SDK default auth");
  return undefined;
}

const OPENAI_ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT",
];

async function withSanitizedOpenAiEnv(fn) {
  const saved = {};
  for (const key of OPENAI_ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(process.env, key)) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[key] = value;
    }
  }
}

async function ensureClientStarted() {
  if (clientStarted && copilotClient) return true;
  const Cls = await loadCopilotSdk();
  if (!Cls) return false;

  // Build cliArgs for experimental features, permissions, and autonomy
  const cliLaunch = resolveCopilotCliLaunchConfig({
    cliArgs: await buildCliArgs(),
  });
  const cliPath = cliLaunch.cliPath;
  const cliArgs = cliLaunch.cliArgs;

  // Auth passthrough: detect from multiple sources
  const cliUrl = process.env.COPILOT_CLI_URL || undefined;
  const token = await detectGitHubToken();
  const transport = resolveCopilotTransport();

  // Session mode: "local" (default) uses stdio for full model access + MCP + sub-agents.
  // "auto" lets the SDK decide. "url" connects to remote server (potentially limited).
  const sessionMode = (process.env.COPILOT_SESSION_MODE || "local").trim().toLowerCase();

  let clientOptions;
  if (transport === "url") {
    if (!cliUrl) {
      console.warn(
        "[copilot-shell] COPILOT_TRANSPORT=url requested but COPILOT_CLI_URL is unset; falling back to local",
      );
      clientOptions = { cliPath, token, cliArgs, useStdio: true, cwd: REPO_ROOT };
    } else {
      clientOptions = { cliUrl };
    }
  } else if (transport === "cli") {
    clientOptions = { cliPath: cliPath || "copilot", token, cliArgs, useStdio: true, cwd: REPO_ROOT };
  } else if (transport === "sdk") {
    clientOptions = token
      ? { token, cliArgs, useStdio: true, cwd: REPO_ROOT }
      : { cliArgs, useStdio: true, cwd: REPO_ROOT };
  } else {
    // "auto" transport — use cliUrl if provided, otherwise local stdio
    if (cliUrl && sessionMode !== "local") {
      clientOptions = { cliUrl };
    } else {
      clientOptions = {
        cliPath,
        token,
        cliArgs,
        useStdio: true,
        cwd: REPO_ROOT,
      };
    }
  }

  const modeLabel = clientOptions.cliUrl ? "remote" : "local (stdio)";
  const cliLabel = cliPath || "copilot (PATH)";
  console.log(`[copilot-shell] starting client in ${modeLabel} mode`);
  if (!clientOptions.cliUrl) {
    console.log(
      `[copilot-shell] using ${cliLaunch.source} Copilot CLI: ${cliLabel}`,
    );
  }

  const START_TIMEOUT_MS = normalizeTimeoutMs(process.env.COPILOT_START_TIMEOUT_MS, {
    fallback: 20_000,
    label: "COPILOT_START_TIMEOUT_MS",
  });

  await withSanitizedOpenAiEnv(async () => {
    copilotClient = new Cls(clientOptions);
    await Promise.race([
      copilotClient.start(),
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `Copilot CLI failed to start within ${START_TIMEOUT_MS / 1000}s — ` +
                  `verify COPILOT_CLI_PATH or run \`gh auth login\``,
              ),
            ),
          START_TIMEOUT_MS,
        ),
      ),
    ]);
  });
  clientStarted = true;
  console.log("[copilot-shell] client started");
  return true;
}

// ── State Persistence ────────────────────────────────────────────────────────

async function loadState() {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const data = JSON.parse(raw);
    activeSessionId = data.sessionId || null;
    turnCount = data.turnCount || 0;
    workspacePath = data.workspacePath || null;
    console.log(
      `[copilot-shell] loaded state: sessionId=${activeSessionId}, turns=${turnCount}`,
    );
    copilotSessionCompat.hydrate({
      sessionId: activeSessionId,
      status: activeSessionId ? "idle" : "inactive",
      cwd: workspacePath || "",
      metadata: {
        workspacePath,
        turnCount,
      },
    });
  } catch {
    activeSessionId = null;
    turnCount = 0;
    workspacePath = null;
    copilotSessionCompat.reset({ keepManagedRecord: false });
  }
}

async function saveState() {
  try {
    await mkdir(resolve(__dirname, "..", "logs"), { recursive: true });
    await writeFile(
      STATE_FILE,
      JSON.stringify(
        {
          sessionId: activeSessionId,
          turnCount,
          workspacePath,
          updatedAt: timestamp(),
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch (err) {
    console.warn(`[copilot-shell] failed to save state: ${err.message}`);
  }
}

// ── System Prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `# AGENT DIRECTIVE — EXECUTE IMMEDIATELY

You are an autonomous AI coding agent deployed inside bosun.
You are NOT a chatbot. You are NOT waiting for input. You EXECUTE tasks.

CRITICAL RULES:
1. NEVER respond with "Ready" or "What would you like me to do?" — you already have your task below.
2. NEVER ask clarifying questions — infer intent and take action.
3. DO the work. Read files, run commands, analyze code, write output.
4. Show your work as you go — print what you're reading, what you found, what you're doing next.
5. Produce DETAILED, STRUCTURED output with your findings and actions taken.
6. If the task involves analysis, actually READ the files and show what you found.
7. If the task involves code changes, actually MAKE the changes.
8. Think step-by-step, show your reasoning, then act.

You have FULL ACCESS to:
- The target repository checked out for this bosun instance
- Shell: git, gh, node, go, make, and all system commands (pwsh optional)
- File read/write: read any file, create/edit any file
- MCP servers configured in this environment (availability varies)
- Subagents and VS Code tools when available

Key files:
  ${REPO_ROOT} — Repository root
  .cache/orchestrator-status.json — Live status data (if enabled)
  scripts/bosun/logs/ — Monitor logs (if available)
  AGENTS.md — Repo guide for agents
`;

// ── MCP / Tool Config ────────────────────────────────────────────────────────

function loadMcpServersFromFile(path) {
  if (!path || !existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const parsed = safeJsonParse(raw);
  if (!parsed) return null;
  if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
    return parsed.mcpServers;
  }
  if (
    parsed.mcp &&
    parsed.mcp.servers &&
    typeof parsed.mcp.servers === "object"
  ) {
    return parsed.mcp.servers;
  }
  if (parsed["github.copilot.mcpServers"]) {
    return parsed["github.copilot.mcpServers"];
  }
  return null;
}

function loadMcpServers(profile = null) {
  if (profile?.mcpServers) return profile.mcpServers;
  if (profile?.mcpConfig) {
    return loadMcpServersFromFile(profile.mcpConfig);
  }
  if (process.env.COPILOT_MCP_SERVERS) {
    const parsed = parseMcpServersValue(process.env.COPILOT_MCP_SERVERS);
    if (parsed) return parsed;
  }
  const configPath =
    process.env.COPILOT_MCP_CONFIG || resolve(REPO_ROOT, ".vscode", "mcp.json");
  return loadMcpServersFromFile(configPath);
}

/**
 * Merge installed MCP library servers into an existing mcpServers map.
 * Called during session build to inject library-managed MCP servers into
 * the Copilot SDK session alongside any profile/env servers.
 *
 * Non-fatal: if the registry is unavailable or encounters errors, the
 * original servers map is returned unchanged.
 *
 * @param {Object|null} existingServers — mcpServers from profile/env/config
 * @returns {Promise<Object|null>} — merged servers map
 */
async function mergeLibraryMcpServers(existingServers) {
  try {
    const registry = await getMcpRegistry();
    const mcpCfg = getMcpRuntimeConfig();
    const installed = await registry.listInstalledMcpServers(REPO_ROOT);
    const installedIds = installed && installed.length ? installed.map((e) => e.id) : [];

    // Resolve all installed servers into full configs
    let resolved = await registry.resolveMcpServersForAgent(REPO_ROOT, installedIds);
    if (typeof registry.wrapServersWithDiscoveryProxy === "function") {
      resolved = registry.wrapServersWithDiscoveryProxy(REPO_ROOT, resolved, {
        enabled: mcpCfg.useDiscoveryProxy !== false,
        includeCustomTools: mcpCfg.includeCustomToolsInDiscoveryProxy !== false,
        cacheTtlMs: mcpCfg.discoveryProxyCacheTtlMs,
        executeTimeoutMs: mcpCfg.discoveryProxyExecuteTimeoutMs,
      });
    }
    if (!resolved || !resolved.length) return existingServers;

    // Convert to Copilot mcpServers format: { [id]: { command, args, env? } | { url } }
    const copilotJson = registry.buildCopilotMcpJson(resolved);
    const libraryServers = copilotJson?.mcpServers || {};
    if (!Object.keys(libraryServers).length) return existingServers;

    // Merge: existing servers take precedence over library ones (user overrides win)
    const merged = { ...libraryServers, ...(existingServers || {}) };
    console.log(
      `[copilot-shell] Merged ${Object.keys(libraryServers).length} library MCP server(s) into session`,
    );
    return merged;
  } catch (err) {
    console.warn(`[copilot-shell] Failed to merge library MCP servers: ${err.message}`);
    return existingServers;
  }
}

async function buildSessionConfig() {
  const profile = resolveCopilotProfile();
  const config = {
    streaming: true,
    systemMessage: {
      mode: "replace",
      content: SYSTEM_PROMPT,
    },
    infiniteSessions: { enabled: true },
    // Auto-approve all permissions (belt-and-suspenders with --allow-all cliArg)
    onPermissionRequest: autoApprovePermissions,
    // Auto-respond to agent questions (belt-and-suspenders with --no-ask-user)
    onUserInputRequest: autoRespondToUserInput,
    // Session lifecycle hooks for observability
    hooks: buildSessionHooks(),
    // Set working directory to repo root
    workingDirectory: REPO_ROOT,
  };
  const model =
    profile.model ||
    process.env.COPILOT_MODEL ||
    process.env.COPILOT_SDK_MODEL ||
    "";
  if (model) config.model = model;

  // Reasoning effort: low | medium | high | xhigh
  const effort =
    profile.reasoningEffort ||
    process.env.COPILOT_REASONING_EFFORT ||
    process.env.COPILOT_SDK_REASONING_EFFORT ||
    "";
  if (effort && VALID_REASONING_EFFORTS.includes(effort.toLowerCase())) {
    config.reasoningEffort = effort.toLowerCase();
  }

  // Load MCP servers from profile/env/config, then merge library-managed servers
  const baseServers = loadMcpServers(profile);
  const mcpServers = await mergeLibraryMcpServers(baseServers);
  if (mcpServers) config.mcpServers = mcpServers;
  return config;
}

// ── Session Management ───────────────────────────────────────────────────────

async function getSession() {
  if (activeSession) return activeSession;
  const started = await ensureClientStarted();
  if (!started) throw new Error("Copilot SDK not available");

  const config = await buildSessionConfig();

  if (activeSessionId && typeof copilotClient?.resumeSession === "function") {
    try {
      activeSession = await copilotClient.resumeSession(
        activeSessionId,
        config,
      );
      workspacePath = activeSession?.workspacePath || workspacePath;
      console.log(`[copilot-shell] resumed session ${activeSessionId}`);
      return activeSession;
    } catch (err) {
      console.warn(
        `[copilot-shell] failed to resume session ${activeSessionId}: ${err.message} — starting fresh`,
      );
      activeSessionId = null;
    }
  }

  activeSession = await copilotClient.createSession(config);
  activeSessionId =
    activeSession?.sessionId || activeSession?.id || activeSessionId;
  workspacePath = activeSession?.workspacePath || workspacePath;
  await saveState();
  console.log(`[copilot-shell] new session started: ${activeSessionId}`);
  return activeSession;
}

// ── Main Execution ───────────────────────────────────────────────────────────

export async function execCopilotPrompt(userMessage, options = {}) {
  const {
    onEvent = null,
    statusData = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    sendRawEvents = false,
    abortController = null,
    persistent = false,
    mode = null,
  } = options;
  const normalizedTimeoutMs = normalizeTimeoutMs(timeoutMs, {
    fallback: DEFAULT_TIMEOUT_MS,
    label: "execCopilotPrompt.timeoutMs",
  });

  if (activeTurn && !options._holdActiveTurn) {
    return {
      finalResponse:
        ":clock: Agent is still executing a previous task. Please wait.",
      items: [],
      usage: null,
    };
  }

  if (!options._holdActiveTurn) activeTurn = true;
  /** Sentinel: true while a retry call is pending so finally skips cleanup. */
  let _retryPending = false;

  if (!persistent) {
    // Task executor path — fresh session each call
    activeSession = null;
  }

  let unsubscribe = null;
  const session = await getSession();
  const logPath = initSessionLog(activeSessionId, userMessage, normalizedTimeoutMs);
  const items = [];
  let finalResponse = "";
  let responseFromMessage = false;
  const logicalSessionId =
    String(options.sessionId || activeSessionId || "").trim()
    || "primary-copilot";
  const providerRuntime = copilotSessionCompat.resolveProvider({
    providerSelection: options.providerSelection || "copilot",
    model: process.env.COPILOT_MODEL || process.env.COPILOT_SDK_MODEL || null,
  });
  copilotSessionCompat.beginTurn(logicalSessionId, {
    activate: Boolean(options.sessionId || activeSessionId),
    status: "running",
    cwd: workspacePath || REPO_ROOT,
    providerSelection: providerRuntime.providerId || "copilot",
    model: providerRuntime.providerConfig?.model || process.env.COPILOT_MODEL || process.env.COPILOT_SDK_MODEL || null,
    metadata: {
      workspacePath,
      turnCount,
      persistent,
      mode: mode || null,
    },
  });

  const handleEvent = async (event) => {
    if (!event) return;
    logSessionEvent(logPath, event);
    copilotSessionCompat.recordStreamEvent(activeSessionId || logicalSessionId, event, {
      activate: Boolean(options.sessionId || activeSessionId),
      cwd: workspacePath || REPO_ROOT,
      providerSelection: providerRuntime.providerId || "copilot",
      model: providerRuntime.providerConfig?.model || process.env.COPILOT_MODEL || process.env.COPILOT_SDK_MODEL || null,
    });
    items.push(event);
    if (event.type === "assistant.message" && event.data?.content) {
      finalResponse = event.data.content;
      responseFromMessage = true;
    }
    if (
      !responseFromMessage &&
      event.type === "assistant.message_delta" &&
      event.data?.deltaContent
    ) {
      finalResponse += event.data.deltaContent;
    }
    if (event.type === "session.idle") {
      turnCount += 1;
      await saveState();
      copilotSessionCompat.completeTurn(activeSessionId || logicalSessionId, {
        activate: Boolean(activeSessionId || options.sessionId),
        status: "completed",
        cwd: workspacePath || REPO_ROOT,
        providerSelection: providerRuntime.providerId || "copilot",
        model: providerRuntime.providerConfig?.model || process.env.COPILOT_MODEL || process.env.COPILOT_SDK_MODEL || null,
        metadata: {
          workspacePath,
          turnCount,
          persistent,
          mode: mode || null,
        },
      });
    }
    if (onEvent) {
      try {
        if (sendRawEvents) {
          await onEvent(null, event);
        } else {
          await onEvent(null);
        }
      } catch {
        /* best effort */
      }
    }
  };

  try {
    if (typeof session.on === "function") {
      unsubscribe = session.on(handleEvent);
    }

    const controller = abortController || new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), normalizedTimeoutMs);

    const onAbort = () => {
      const reason = controller.signal.reason || "user_stop";
      if (typeof session.abort === "function") session.abort(reason);
      if (typeof session.cancel === "function") session.cancel(reason);
      if (typeof session.stop === "function") session.stop(reason);
    };
    if (controller?.signal) {
      controller.signal.addEventListener("abort", onAbort, { once: true });
    }

    // ── Mode detection ───────────────────────────────────────────────────
    const isAskMode =
      mode === "ask" || /^\[MODE:\s*ask\]/i.test(userMessage);

    // Build prompt with optional orchestrator status
    let prompt = userMessage;
    if (isAskMode) {
      // Ask mode — pass through without executor framing
      if (statusData) {
        const statusSnippet = JSON.stringify(statusData, null, 2).slice(0, 2000);
        prompt = `[Orchestrator Status]\n\`\`\`json\n${statusSnippet}\n\`\`\`\n\n${userMessage}`;
      } else {
        prompt = userMessage;
      }
    } else if (statusData) {
      const statusSnippet = JSON.stringify(statusData, null, 2).slice(0, 2000);
      prompt = `[Orchestrator Status]\n\`\`\`json\n${statusSnippet}\n\`\`\`\n\n# YOUR TASK — EXECUTE NOW\n\n${userMessage}\n\n---\nDo NOT respond with "Ready" or ask what to do. EXECUTE this task. Read files, run commands, produce detailed output & complete the user's request E2E.`;
    } else {
      prompt = `${userMessage}\n\n\n# YOUR TASK — EXECUTE NOW\n\n\n---\nDo NOT respond with "Ready" or ask what to do. EXECUTE this task. Read files, run commands, produce detailed output & complete the user's request E2E.`;
    }

    const sendFn = session.sendAndWait || session.send;
    if (typeof sendFn !== "function") {
      throw new Error("Copilot SDK session does not support send");
    }

    // Pass timeout parameter to sendAndWait to override 60s SDK default
    const sendPromise = session.sendAndWait
      ? sendFn.call(session, { prompt }, normalizedTimeoutMs)
      : sendFn.call(session, { prompt });

    // If send() returns before idle, wait for session.idle if available
    if (!session.sendAndWait) {
      await new Promise((resolve, reject) => {
        const idleHandler = (event) => {
          if (!event) return;
          if (event.type === "session.idle") resolve();
          if (event.type === "session.error") {
            reject(new Error(event.data?.message || "session error"));
          }
        };
        const off = session.on ? session.on(idleHandler) : null;
        Promise.resolve(sendPromise).catch(reject);
        setTimeout(
          resolve,
          normalizeTimeoutMs(normalizedTimeoutMs + 1000, {
            fallback: DEFAULT_TIMEOUT_MS,
            label: "execCopilotPrompt.idleWaitResolveTimeoutMs",
          }),
        );
        if (typeof off === "function") {
          setTimeout(
            () => off(),
            normalizeTimeoutMs(normalizedTimeoutMs + 2000, {
              fallback: DEFAULT_TIMEOUT_MS,
              label: "execCopilotPrompt.idleWaitCleanupTimeoutMs",
            }),
          );
        }
      });
    } else {
      await sendPromise;
    }

    clearTimeout(timer);
    controller.signal?.removeEventListener("abort", onAbort);

    // Apply context shredding to collected items (SDK session path)
    const compressedItems = await maybeCompressSessionItems(items, {
      sessionType: persistent ? "primary" : "task",
      agentType: "copilot-sdk",
    });

    return {
      finalResponse:
        finalResponse.trim() || "(Agent completed with no text output)",
      items: compressedItems,
      usage: null,
    };
  } catch (err) {
    if (err?.name === "AbortError" || /abort|timeout/i.test(err?.message)) {
      const reason = abortController?.signal?.reason || "timeout";
      const msg =
        reason === "user_stop"
          ? ":close: Agent stopped by user."
          : `:clock: Agent timed out after ${normalizedTimeoutMs / 1000}s`;
      copilotSessionCompat.abortTurn(activeSessionId || logicalSessionId, {
        activate: Boolean(activeSessionId || options.sessionId),
        status: reason === "user_stop" ? "aborted" : "timeout",
        cwd: workspacePath || REPO_ROOT,
        error: msg,
        providerSelection: providerRuntime.providerId || "copilot",
        model: providerRuntime.providerConfig?.model || process.env.COPILOT_MODEL || process.env.COPILOT_SDK_MODEL || null,
        metadata: {
          workspacePath,
          turnCount,
          persistent,
          mode: mode || null,
        },
      });
      return { finalResponse: msg, items: [], usage: null };
    }
    // ── Transient stream retry ──────────────────────────────────────────────────
    // Reset session and re-run; _retryPending holds the activeTurn lock.
    if (isTransientStreamError(err)) {
      const retryAttempt = (options._streamRetryAttempt || 0) + 1;
      if (retryAttempt < MAX_STREAM_RETRIES) {
        if (typeof unsubscribe === "function") try { unsubscribe(); } catch { /* best effort */ }
        unsubscribe = null;
        activeSession = null; // force getSession() to create a fresh session
        const delay = streamRetryDelay(retryAttempt - 1);
        console.warn(
          `[copilot-shell] transient stream error (attempt ${retryAttempt}/${MAX_STREAM_RETRIES}): ${err.message || err} — retrying in ${Math.round(delay)}ms`,
        );
        _retryPending = true; // prevent outer finally from releasing activeTurn
        await new Promise((r) => setTimeout(r, delay));
        return execCopilotPrompt(userMessage, {
          ...options,
          _streamRetryAttempt: retryAttempt,
          _holdActiveTurn: true, // skip activeTurn guard in recursive call
        });
      }
      console.error(
        `[copilot-shell] stream disconnection not resolved after ${MAX_STREAM_RETRIES} attempts`,
      );
      copilotSessionCompat.failTurn(activeSessionId || logicalSessionId, {
        activate: Boolean(activeSessionId || options.sessionId),
        status: "failed",
        cwd: workspacePath || REPO_ROOT,
        error: err.message,
        providerSelection: providerRuntime.providerId || "copilot",
        model: providerRuntime.providerConfig?.model || process.env.COPILOT_MODEL || process.env.COPILOT_SDK_MODEL || null,
        metadata: {
          workspacePath,
          turnCount,
          persistent,
          mode: mode || null,
        },
      });
      return {
        finalResponse: `:close: Stream disconnected after ${MAX_STREAM_RETRIES} retries: ${err.message}`,
        items: [],
        usage: null,
      };
    }
    copilotSessionCompat.failTurn(activeSessionId || logicalSessionId, {
      activate: Boolean(activeSessionId || options.sessionId),
      status: "failed",
      cwd: workspacePath || REPO_ROOT,
      error: err?.message || String(err),
      providerSelection: providerRuntime.providerId || "copilot",
      model: providerRuntime.providerConfig?.model || process.env.COPILOT_MODEL || process.env.COPILOT_SDK_MODEL || null,
      metadata: {
        workspacePath,
        turnCount,
        persistent,
        mode: mode || null,
      },
    });
    throw err;
  } finally {
    // Only the outermost invocation (or the final retry) cleans up.
    if (!_retryPending) {
      if (typeof unsubscribe === "function") {
        try {
          unsubscribe();
        } catch {
          /* best effort */
        }
      } else if (typeof session.off === "function") {
        try {
          session.off(handleEvent);
        } catch {
          /* best effort */
        }
      }
      activeTurn = false;
    }
  }
}

/**
 * Copilot SDK does not currently expose steering APIs. We return unsupported.
 */
export async function steerCopilotPrompt() {
  return { ok: false, reason: "unsupported" };
}

export function isCopilotBusy() {
  return !!activeTurn;
}

export function getSessionInfo() {
  return copilotSessionCompat.getSessionInfo({
    sessionId: activeSessionId,
    turnCount,
    isActive: !!activeSession,
    isBusy: !!activeTurn,
    workspacePath,
    cwd: workspacePath || REPO_ROOT,
  });
}

export async function resetSession() {
  activeSession = null;
  activeSessionId = null;
  workspacePath = null;
  turnCount = 0;
  activeTurn = false;
  copilotSessionCompat.reset({
    status: "idle",
    cwd: "",
    metadata: {
      workspacePath: null,
      turnCount: 0,
    },
  });
  await saveState();
  console.log("[copilot-shell] session reset");
}

export async function initCopilotShell() {
  await loadState();
  const started = await ensureClientStarted();
  if (started) {
    console.log("[copilot-shell] initialised with Copilot SDK");
    return true;
  }
  console.warn(
    "[copilot-shell] initialised WITHOUT Copilot SDK — agent will not work",
  );
  return false;
}
