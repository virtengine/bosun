/**
 * codex-shell.mjs — Persistent Codex agent for bosun.
 *
 * Uses the Codex SDK (@openai/codex-sdk) to maintain a REAL persistent thread
 * with multi-turn conversation, tool use (shell, file I/O, MCP), and streaming.
 *
 * This is NOT a chatbot. Each user message dispatches a full agentic turn where
 * Codex can read files, run commands, call MCP tools, and produce structured
 * output — all streamed back in real-time via ThreadEvent callbacks.
 *
 * Thread persistence: The SDK stores threads in ~/.codex/sessions. We save the
 * thread_id so we can resume the same conversation across restarts.
 */

import "../infra/windows-hidden-child-processes.mjs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveAgentSdkConfig, resolveCodexSdkInstall } from "../agent/agent-sdk.mjs";
import { loadConfig } from "../config/config.mjs";
import { maybeCompressSessionItems } from "../workspace/context-cache.mjs";
import { resolveRepoRoot } from "../config/repo-root.mjs";
import {
  resolveCodexProfileRuntime,
  readCodexConfigRuntimeDefaults,
  getProviderEndpointEnvKeys,
} from "./codex-model-profiles.mjs";
import { buildTaskWritableRoots } from "./codex-config.mjs";
import {
  isTransientStreamError,
  streamRetryDelay,
  MAX_STREAM_RETRIES,
} from "../infra/stream-resilience.mjs";
import { normalizeProviderUsageMetadata } from "../agent/providers/provider-usage-normalizer.mjs";
import { createShellSessionCompat } from "./shell-session-compat.mjs";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));
const BOSUN_ROOT = resolve(__dirname, "..");

// ── Configuration ────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000; // 60 min for agentic tasks (matches Azure stream timeout)
const MAX_TIMER_DELAY_MS = 2_147_483_647; // Node.js timer clamp (2^31 - 1)
// MAX_STREAM_RETRIES, isTransientStreamError, streamRetryDelay ← imported from ./stream-resilience.mjs
const STATE_FILE = resolve(__dirname, "..", "logs", "codex-shell-state.json");
const SESSIONS_DIR = resolve(__dirname, "..", "logs", "codex-shell-sessions");
const MAX_PERSISTENT_TURNS = 50;
const timeoutNormalizationWarningKey = new Set();

// ── Payload safety ────────────────────────────────────────────────────────────
// The Codex API rejects JSON bodies with malformed or oversized strings.
// 180 KB is a safe ceiling; the API hard-errors around 200–400 KB payloads
// that contain embedded content with unescaped characters.
const MAX_PROMPT_BYTES = 180_000;
const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ITEMS_PER_TURN = 600;
const DEFAULT_MAX_ITEM_CHARS = 12_000;
const TOOL_OUTPUT_GUARDRAIL = String.raw`

[Tool Output Guardrail] Keep tool outputs compact: prefer narrow searches, bounded command output (for example head/tail), and summaries for large results instead of dumping full payloads.`;

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function parseBoundedNumber(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(Math.trunc(num), min), max);
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
      `[codex-shell] ${label} ${parsed}ms exceeds Node.js timer max; clamped to ${MAX_TIMER_DELAY_MS}ms`,
    );
  }
  return normalized;
}

function isAzureOpenAIBaseUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    const host = String(parsed.hostname || "").toLowerCase();
    return host === "openai.azure.com" || host.endsWith(".openai.azure.com") || host.endsWith(".cognitiveservices.azure.com");
  } catch {
    return false;
  }
}

function normalizeCodexSandboxMode(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "workspace-write";
  if (raw === "disk-full-write-access" || raw === "workspace-write") return "workspace-write";
  if (raw === "disk-read-only" || raw === "read-only") return "read-only";
  if (raw === "danger-full-access") return "danger-full-access";
  return raw;
}

function buildInjectedSandboxConfig(envInput, workingDirectory) {
  const sandboxMode = normalizeCodexSandboxMode(
    envInput?.CODEX_SANDBOX || envInput?.CODEX_SANDBOX_MODE || "workspace-write",
  );
  const config = {
    sandbox_mode: sandboxMode,
  };
  if (sandboxMode === "workspace-write") {
    config.sandbox_workspace_write = {
      network_access: true,
      exclude_tmpdir_env_var: false,
      exclude_slash_tmp: false,
      writable_roots: buildTaskWritableRoots({
        worktreePath: workingDirectory,
        repoRoot: REPO_ROOT,
        tempDir: envInput?.TEMP || envInput?.TMP || "",
        platform: envInput?.BOSUN_HOST_PLATFORM || envInput?.npm_config_platform || envInput?.OS || process.platform,
      }),
    };
  }
  return config;
}

function buildCodexSdkRuntime(streamProviderOverrides, envInput = process.env, workingDirectory = DEFAULT_WORKING_DIRECTORY) {
  const resolved = resolveCodexProfileRuntime(envInput);
  const { env: resolvedEnv, configProvider } = resolved;
  const runtimeDefaults = readCodexConfigRuntimeDefaults(envInput);
  const baseUrl = resolvedEnv.OPENAI_BASE_URL || "";
  const isAzure = isAzureOpenAIBaseUrl(baseUrl);
  const hasCustomBaseUrl = Boolean(String(baseUrl || "").trim());
  const env = { ...resolvedEnv };
  const unsetEnvKeys = [];

  delete env.OPENAI_BASE_URL;
  delete env.OPENAI_ORGANIZATION;
  delete env.OPENAI_PROJECT;

  // Use the config.toml provider section name and env_key when available,
  // so Bosun's config override is consistent with the user's config.toml
  // instead of hardcoding "azure" / "AZURE_OPENAI_API_KEY".
  const providerSectionName = (isAzure && configProvider?.name) || (isAzure ? "azure" : "openai");
  const providerEnvKey = (isAzure && configProvider?.envKey) || (isAzure ? "AZURE_OPENAI_API_KEY" : "OPENAI_API_KEY");

  if (isAzure && env.OPENAI_API_KEY && !env.AZURE_OPENAI_API_KEY) {
    env.AZURE_OPENAI_API_KEY = env.OPENAI_API_KEY;
  }

  if (isAzure) {
    try {
      const configDefaults = readCodexConfigRuntimeDefaults();
      const allProviders = configDefaults?.providers || {};
      for (const [sectionName, section] of Object.entries(allProviders)) {
        if (sectionName === providerSectionName) continue;
        const otherBaseUrl = String(section?.baseUrl || "").trim();
        const otherEnvKey = String(section?.envKey || "").trim();
        if (!otherBaseUrl || !isAzureOpenAIBaseUrl(otherBaseUrl)) continue;
        if (!otherEnvKey || otherEnvKey === providerEnvKey) continue;
        delete env[otherEnvKey];
        if (!unsetEnvKeys.includes(otherEnvKey)) {
          unsetEnvKeys.push(otherEnvKey);
        }
        // Also remove endpoint/base URL env keys associated with the non-selected provider
        const endpointKeys =
          typeof getProviderEndpointEnvKeys === "function"
            ? getProviderEndpointEnvKeys(sectionName, "azure")
            : [];
        for (const epKey of endpointKeys) {
          if (epKey in env) {
            delete env[epKey];
            if (!unsetEnvKeys.includes(epKey)) {
              unsetEnvKeys.push(epKey);
            }
          }
        }
      }
    } catch {
      // best effort — do not block SDK startup if config inspection fails
    }
  }

  const providerName = isAzure ? "azure" : "openai";
  const providerSectionNameResolved = isAzure
    ? providerSectionName
    : hasCustomBaseUrl
      ? (configProvider?.name || "openai-direct")
      : null;
  const config = isAzure
    ? {
        model_providers: {
          [providerSectionName]: {
            name: "Azure OpenAI",
            base_url: baseUrl,
            env_key: providerEnvKey,
            wire_api: "responses",
            ...streamProviderOverrides,
          },
        },
        features: {
          remote_models: false,
        },
      }
    : hasCustomBaseUrl
      ? {
          model_providers: providerSectionNameResolved
            ? {
                [providerSectionNameResolved]: {
                  ...streamProviderOverrides,
                },
              }
            : undefined,
        }
      : {};

  Object.assign(config, buildInjectedSandboxConfig(envInput, workingDirectory));

  if (providerSectionNameResolved) {
    config.model_provider = providerSectionNameResolved;
  }
  if (env.CODEX_MODEL) {
    config.model = env.CODEX_MODEL;
  }

  return {
    env,
    config,
    providerName,
    streamIdleTimeoutMs: streamProviderOverrides.stream_idle_timeout_ms,
    unsetEnvKeys,
  };
}

function getInternalExecutorStreamConfig() {
  try {
    const cfg = loadConfig();
    const stream = cfg?.internalExecutor?.stream;
    return stream && typeof stream === "object" ? stream : {};
  } catch {
    return {};
  }
}

function truncateText(text, maxChars) {
  if (typeof text !== "string") return text;
  if (!Number.isFinite(maxChars) || maxChars < 1 || text.length <= maxChars) {
    return text;
  }
  const trimmed = text.slice(0, maxChars);
  const removed = text.length - maxChars;
  return `${trimmed}

[…truncated ${removed} chars…]`;
}

function truncateItemForStorage(item, maxChars) {
  if (!item || typeof item !== "object") return item;
  if (!Number.isFinite(maxChars) || maxChars < 1) return item;

  const next = { ...item };
  const directStringKeys = [
    "text",
    "output",
    "aggregated_output",
    "stderr",
    "stdout",
    "result",
    "message",
  ];
  for (const key of directStringKeys) {
    if (typeof next[key] === "string") {
      next[key] = truncateText(next[key], maxChars);
    }
  }

  if (Array.isArray(next.content)) {
    next.content = next.content.map((entry) => {
      if (entry && typeof entry === "object" && typeof entry.text === "string") {
        return { ...entry, text: truncateText(entry.text, maxChars) };
      }
      return entry;
    });
  }

  if (next.error && typeof next.error === "object") {
    next.error = {
      ...next.error,
      message: truncateText(next.error.message, maxChars),
    };
  }

  return next;
}

function resolveCodexStreamSafety(totalTimeoutMs) {
  const streamCfg = getInternalExecutorStreamConfig();
  const firstEventRaw =
    process.env.INTERNAL_EXECUTOR_STREAM_FIRST_EVENT_TIMEOUT_MS ||
    streamCfg.firstEventTimeoutMs ||
    DEFAULT_FIRST_EVENT_TIMEOUT_MS;
  const maxItemsRaw =
    process.env.INTERNAL_EXECUTOR_STREAM_MAX_ITEMS_PER_TURN ||
    streamCfg.maxItemsPerTurn ||
    DEFAULT_MAX_ITEMS_PER_TURN;
  const maxItemCharsRaw =
    process.env.INTERNAL_EXECUTOR_STREAM_MAX_ITEM_CHARS ||
    streamCfg.maxItemChars ||
    DEFAULT_MAX_ITEM_CHARS;
  const configuredFirstEventMs = parseBoundedNumber(
    firstEventRaw,
    DEFAULT_FIRST_EVENT_TIMEOUT_MS,
    1_000,
    60 * 60 * 1000,
  );
  const budgetMs = Number(totalTimeoutMs);
  let firstEventTimeoutMs = null;
  if (Number.isFinite(budgetMs) && budgetMs > 2_000) {
    const maxAllowed = Math.max(1_000, budgetMs - 1_000);
    firstEventTimeoutMs = Math.min(configuredFirstEventMs, maxAllowed);
  }

  return {
    firstEventTimeoutMs,
    maxItemsPerTurn: parseBoundedNumber(maxItemsRaw, DEFAULT_MAX_ITEMS_PER_TURN, 1, 5000),
    maxItemChars: parseBoundedNumber(maxItemCharsRaw, DEFAULT_MAX_ITEM_CHARS, 1, 250000),
  };
}

/**
 * Strip ASCII control characters (except \n/\t) that corrupt JSON serialization,
 * then truncate the UTF-8 byte length to MAX_PROMPT_BYTES.
 * These two faults cause the two observed invalid_request_error variants:
 *   • unescaped control chars   → '}' is invalid after a property name
 *   • oversized body truncation → Expected end of string / end of data
 *
 * @param {string} text
 * @returns {string}
 */
function sanitizeAndTruncatePrompt(text) {
  if (typeof text !== "string") return "";
  // Remove control characters that JSON.stringify would have to escape but
  // the Codex SDK may inline-inject without escaping (\x00-\x08, \x0b-\x0c, \x0e-\x1f, \x7f)
  // eslint-disable-next-line no-control-regex
  const sanitized = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  // Fast-path: most prompts are well under the limit
  const bytes = Buffer.byteLength(sanitized, "utf8");
  if (bytes <= MAX_PROMPT_BYTES) return sanitized;
  // Truncate to MAX_PROMPT_BYTES bytes while respecting multi-byte char boundaries
  const buf = Buffer.from(sanitized, "utf8").slice(0, MAX_PROMPT_BYTES);
  const truncated = buf.toString("utf8");
  const removedBytes = bytes - MAX_PROMPT_BYTES;
  console.warn(
    `[codex-shell] prompt truncated: ${bytes} → ${MAX_PROMPT_BYTES} bytes (removed ${removedBytes} bytes) to avoid invalid_request_error`,
  );
  return truncated + `\n\n[...prompt truncated — ${removedBytes} bytes removed to stay within API limits]`;
}
const REPO_ROOT = resolveRepoRoot();
const DEFAULT_WORKING_DIRECTORY = REPO_ROOT;

// ── State ────────────────────────────────────────────────────────────────────

let CodexClass = null; // The Codex class from SDK
const CODEX_SDK_SPECIFIER = "@openai/codex-sdk"; // Define the SDK specifier
let codexInstance = null; // Singleton Codex instance
let currentSessionId = null; // Most recently selected persistent session identifier
const persistentSessionStates = new Map();
let agentSdk = resolveAgentSdkConfig();
const codexSessionCompat = createShellSessionCompat({
  adapterName: "codex",
  providerSelection: "codex",
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function timestamp() {
  return new Date().toISOString();
}

function normalizeWorkingDirectory(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  try {
    return resolve(raw);
  } catch {
    return null;
  }
}

function createRuntimeCaps() {
  return {
    hasSteeringApi: false,
    steeringMethod: null,
  };
}

function createRuntimeState(overrides = {}) {
  return {
    thread: null,
    threadId: null,
    activeTurn: false,
    turnCount: 0,
    workingDirectory: DEFAULT_WORKING_DIRECTORY,
    threadNeedsPriming: false,
    runtimeCaps: createRuntimeCaps(),
    createdAt: timestamp(),
    lastActiveAt: timestamp(),
    ...overrides,
  };
}

function getSessionRuntimeState(sessionId, { create = true } = {}) {
  const normalizedSessionId = toTrimmedString(sessionId);
  if (!normalizedSessionId) return null;
  const existing = persistentSessionStates.get(normalizedSessionId);
  if (existing || !create) return existing || null;
  const next = createRuntimeState();
  persistentSessionStates.set(normalizedSessionId, next);
  return next;
}

function getWorkingDirectory(state = null) {
  return normalizeWorkingDirectory(state?.workingDirectory) || DEFAULT_WORKING_DIRECTORY;
}

function clearRuntimeState(state) {
  if (!state || typeof state !== "object") return;
  state.thread = null;
  state.threadId = null;
  state.activeTurn = false;
  state.turnCount = 0;
  state.workingDirectory = DEFAULT_WORKING_DIRECTORY;
  state.threadNeedsPriming = false;
  state.runtimeCaps = createRuntimeCaps();
  state.lastActiveAt = timestamp();
}

function findSingleBusySessionId() {
  const busyEntries = [...persistentSessionStates.entries()]
    .filter(([, state]) => state?.activeTurn);
  return busyEntries.length === 1 ? busyEntries[0][0] : null;
}

function resolveRuntimeStateForIntrospection(sessionId = null) {
  const explicit = toTrimmedString(sessionId);
  if (explicit) {
    return {
      sessionId: explicit,
      state: getSessionRuntimeState(explicit, { create: false }),
    };
  }
  const busySessionId = findSingleBusySessionId();
  if (busySessionId) {
    return {
      sessionId: busySessionId,
      state: getSessionRuntimeState(busySessionId, { create: false }),
    };
  }
  if (currentSessionId) {
    return {
      sessionId: currentSessionId,
      state: getSessionRuntimeState(currentSessionId, { create: false }),
    };
  }
  return { sessionId: null, state: null };
}

function resolveCodexTransport() {
  const raw = String(process.env.CODEX_TRANSPORT || "auto")
    .trim()
    .toLowerCase();
  if (["auto", "sdk", "cli"].includes(raw)) {
    return raw;
  }
  console.warn(
    `[codex-shell] invalid CODEX_TRANSPORT='${raw}', defaulting to 'auto'`,
  );
  return "auto";
}

function shouldUseBareCodexSdkImport(resolvedSdk = null) {
  if (import.meta.vitest || process.env.VITEST || process.env.VITEST_WORKER_ID) {
    return true;
  }
  const resolvedRoot = String(resolvedSdk?.rootDir || "").trim();
  return Boolean(resolvedRoot && resolve(resolvedRoot) === BOSUN_ROOT);
}

/**
 * Repair @openai/codex-sdk package.json if main/exports are missing.
 * npm install can leave the package.json in a broken state when the
 * SDK ships without proper entry points. The postinstall script normally
 * patches this, but the fix can be lost if npm re-extracts from cache
 * or if the install runs on a different lifecycle order.
 */
function repairCodexSdkPackageJson() {
  try {
    const codexPkgPath = resolve(__dirname, "..", "node_modules", "@openai", "codex-sdk", "package.json");
    if (!existsSync(codexPkgPath)) return;
    const codexPkg = JSON.parse(readFileSync(codexPkgPath, "utf8"));
    if (codexPkg.main || codexPkg.exports) return; // already valid
    const distIndex = resolve(__dirname, "..", "node_modules", "@openai", "codex-sdk", "dist", "index.js");
    if (!existsSync(distIndex)) return;
    codexPkg.main = "dist/index.js";
    codexPkg.type = "module";
    codexPkg.exports = { ".": { import: "./dist/index.js" } };
    const distTypes = distIndex.replace(/\.js$/, ".d.ts");
    if (existsSync(distTypes)) {
      codexPkg.types = "dist/index.d.ts";
      codexPkg.exports["."].types = "./dist/index.d.ts";
    }
    writeFileSync(codexPkgPath, JSON.stringify(codexPkg, null, 2), "utf8");
    console.log("[codex-shell] repaired @openai/codex-sdk package.json (missing main/exports)");
  } catch {
    // best-effort — postinstall may have already fixed it
  }
}

async function importCodexSdkModule(resolvedSdk) {
  if (shouldUseBareCodexSdkImport(resolvedSdk)) {
    try {
      const shim = await import("./codex-sdk-import.mjs");
      return await shim.loadBareCodexSdkModule();
    } catch (err) {
      if (!resolvedSdk?.entryPath) throw err;
    }
  }
  return import(pathToFileURL(resolvedSdk.entryPath).href);
}

// ── SDK Loading ──────────────────────────────────────────────────────────────

async function loadCodexSdk() {
  agentSdk = resolveAgentSdkConfig({ reload: true });
  if (agentSdk.primary !== "codex") {
    console.warn(
      `[codex-shell] agent_sdk.primary=${agentSdk.primary} — Codex SDK disabled`,
    );
    return null;
  }
  const transport = resolveCodexTransport();
  if (transport === "cli") {
    console.warn(
      "[codex-shell] CODEX_TRANSPORT=cli uses SDK compatibility mode with persistent thread resume",
    );
  }
  if (CodexClass) return CodexClass;
  try {
    const resolvedSdk = resolveCodexSdkInstall({ extraRoots: [getWorkingDirectory(getSessionRuntimeState(currentSessionId, { create: false }))] });
    if (!resolvedSdk?.entryPath) {
      console.error("[codex-shell] failed to load SDK: no complete @openai/codex-sdk install found");
      return null;
    }
    const mod = await importCodexSdkModule(resolvedSdk);
    CodexClass = mod.Codex;
    console.log(`[codex-shell] SDK loaded successfully from ${resolvedSdk.rootDir}`);
    return CodexClass;
  } catch (err) {
    console.error(`[codex-shell] failed to load SDK: ${err.message}`);
    return null;
  }
}

// ── State Persistence ────────────────────────────────────────────────────────

async function loadState() {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const data = JSON.parse(raw);
    currentSessionId = data.currentSessionId || null;
    persistentSessionStates.clear();
    if (currentSessionId) {
      persistentSessionStates.set(currentSessionId, createRuntimeState({
        threadId: data.threadId || null,
        turnCount: data.turnCount || 0,
        workingDirectory:
          normalizeWorkingDirectory(data.workingDirectory) ||
          DEFAULT_WORKING_DIRECTORY,
        createdAt: data.createdAt || timestamp(),
        lastActiveAt: data.updatedAt || timestamp(),
      }));
    }
    const currentState = getSessionRuntimeState(currentSessionId, { create: false });
    console.log(
      `[codex-shell] loaded state: threadId=${currentState?.threadId || null}, turns=${currentState?.turnCount || 0}, session=${currentSessionId}, cwd=${getWorkingDirectory(currentState)}`,
    );
    codexSessionCompat.hydrate({
      sessionId: currentSessionId,
      threadId: currentState?.threadId || null,
      cwd: getWorkingDirectory(currentState),
      status: currentState?.threadId ? "active" : "idle",
      metadata: {
        providerThreadId: currentState?.threadId || null,
        turnCount: currentState?.turnCount || 0,
      },
    });
  } catch {
    currentSessionId = null;
    persistentSessionStates.clear();
    codexSessionCompat.reset({ keepManagedRecord: false });
  }
}

async function saveState() {
  try {
    const currentState = getSessionRuntimeState(currentSessionId, { create: false });
    await mkdir(resolve(__dirname, "..", "logs"), { recursive: true });
    await writeFile(
      STATE_FILE,
      JSON.stringify(
        {
          threadId: currentState?.threadId || null,
          turnCount: currentState?.turnCount || 0,
          currentSessionId,
          workingDirectory: getWorkingDirectory(currentState),
          createdAt: currentState?.createdAt || null,
          updatedAt: timestamp(),
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch (err) {
    console.warn(`[codex-shell] failed to save state: ${err.message}`);
  }
}

// ── Session Persistence ──────────────────────────────────────────────────────

function sessionFilePath(sessionId) {
  return resolve(SESSIONS_DIR, `${sessionId}.json`);
}

async function loadSessionData(sessionId) {
  const READ_TIMEOUT_MS = 5000;
  const readPromise = readFile(sessionFilePath(sessionId), "utf8");
  const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Read session file timeout')), READ_TIMEOUT_MS));
  try {
    const raw = await Promise.race([readPromise, timeoutPromise]);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveSessionData(sessionId, data) {
  const WRITE_TIMEOUT_MS = 5000;
  try {
    await mkdir(SESSIONS_DIR, { recursive: true });
    const writePromise = writeFile(sessionFilePath(sessionId), JSON.stringify(data, null, 2), "utf8");
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Write session file timeout')), WRITE_TIMEOUT_MS));
    await Promise.race([writePromise, timeoutPromise]);
  } catch (err) {
    console.warn(`[codex-shell] failed to save session ${sessionId}: ${err.message}`);
  }
}

async function persistSessionState(sessionId, state, { activate = false, status = null } = {}) {
  const normalizedSessionId = toTrimmedString(sessionId);
  if (!normalizedSessionId || !state) return;
  const existing = await loadSessionData(normalizedSessionId);
  const createdAt = state.createdAt || existing?.createdAt || timestamp();
  const lastActiveAt = timestamp();
  state.createdAt = createdAt;
  state.lastActiveAt = lastActiveAt;
  await saveSessionData(normalizedSessionId, {
    threadId: state.threadId,
    turnCount: state.turnCount,
    workingDirectory: getWorkingDirectory(state),
    createdAt,
    lastActiveAt,
  });
  codexSessionCompat.ensureManagedSession(normalizedSessionId, {
    activate,
    threadId: state.threadId,
    cwd: getWorkingDirectory(state),
    status: status || (state.activeTurn ? "running" : state.threadId ? "active" : "idle"),
    metadata: {
      providerThreadId: state.threadId,
      turnCount: state.turnCount,
    },
  });
  if (activate || normalizedSessionId === currentSessionId) {
    currentSessionId = normalizedSessionId;
    await saveState();
  }
}

async function loadSession(sessionId) {
  const normalizedSessionId = toTrimmedString(sessionId);
  if (!normalizedSessionId) return null;
  let state = getSessionRuntimeState(normalizedSessionId, { create: false });
  let source = "memory";
  if (!state) {
  const data = await loadSessionData(sessionId);
  if (data) {
      state = createRuntimeState({
        threadId: data.threadId || null,
        turnCount: data.turnCount || 0,
        workingDirectory:
          normalizeWorkingDirectory(data.workingDirectory) ||
          DEFAULT_WORKING_DIRECTORY,
        createdAt: data.createdAt || timestamp(),
        lastActiveAt: data.lastActiveAt || timestamp(),
      });
      source = "compat-session-file";
      console.log(`[codex-shell] loaded session ${normalizedSessionId}: threadId=${state.threadId}, turns=${state.turnCount}, cwd=${getWorkingDirectory(state)}`);
  } else {
      state = createRuntimeState();
      source = "compat-session-created";
      console.log(`[codex-shell] created new session ${normalizedSessionId}`);
    }
    persistentSessionStates.set(normalizedSessionId, state);
  }
  currentSessionId = normalizedSessionId;
  codexSessionCompat.switchSession(normalizedSessionId, {
    threadId: state.threadId,
    cwd: getWorkingDirectory(state),
    status: state.activeTurn ? "running" : state.threadId ? "active" : "idle",
    metadata: {
      providerThreadId: state.threadId,
      turnCount: state.turnCount,
      source,
    },
  });
  await saveState();
  return state;
}

// ── Thread Management ────────────────────────────────────────────────────────

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

## File Editing Strategy — IMPORTANT

When editing files, use the strongest structured edit primitive available:

1. **PREFER native Codex edit tools first** — if the runtime exposes built-in file editing tools such as
   \`apply_patch\` or direct file-write tools, use those before shell commands or ad hoc scripts.
2. **Use Bosun MCP file tools as the fallback structured path** when native edit tools are unavailable:
   - \`grep_search\` to locate code
   - \`read_file\` to confirm exact text
   - \`replace_lines\` for scoped block edits once line numbers are known
   - \`str_replace_editor\` for exact unique-string replacements
   - \`write_file\` only for new files or intentional full rewrites
3. **Never use shell-based patching when a structured edit tool exists** — avoid \`node -e\`, \`python -c\`,
   \`powershell -Command\`, \`sed -i\`, temp patch scripts, or one-off \`.cjs\` helpers just to edit files.
4. **Never leave repo-root scratch artifacts behind** — do not create \`.tmp-*\`, \`*.patch\`, \`*.cjs\`, or redirected
   \`*.log\` files in the workspace root for edit workflows. If a shell fallback is truly unavoidable, use \`tmp/codex/\`
   inside the repo or the OS temp directory, and delete those scratch files before finishing the turn.
5. **Prefer read/verify/edit cycles over blind rewrites** so the agent does not compensate for weak matches by
   materializing temporary files in the repository.

Key files:
  ${REPO_ROOT} — Repository root
  .cache/orchestrator-status.json — Live status data (if enabled)
  scripts/bosun/logs/ — Monitor logs (if available)
  AGENTS.md — Repo guide for agents
`;

const THREAD_BASE_OPTIONS = {
  sandboxMode: process.env.CODEX_SANDBOX || "workspace-write",
  skipGitRepoCheck: true,
  webSearchMode: "live",
  approvalPolicy: "never",
  // Note: sub-agent features (child_agents_md, multi_agent, memories, etc.)
  // are configured via ~/.codex/config.toml [features] section, not SDK ThreadOptions.
  // codex-config.mjs ensureFeatureFlags() handles this during setup.
};

function buildThreadOptions(state = null) {
  return {
    ...THREAD_BASE_OPTIONS,
    workingDirectory: getWorkingDirectory(state),
  };
}

/**
 * Get or create a thread.
 * Uses fresh-thread mode by default to avoid context bloat.
 * In CLI transport compatibility mode, reuse persisted thread IDs when possible.
 */
async function getThread(state, options = {}) {
  if (!state) throw new Error("Codex runtime state is required");
  if (state.thread) return state.thread;
  const threadOptions = buildThreadOptions(state);

  if (!codexInstance) {
    const Cls = await loadCodexSdk();
    if (!Cls) throw new Error("Codex SDK not available");

    // Inject stream resilience settings via --config overrides so they apply
    // even if config.toml hasn't been patched by codex-config.mjs yet.
    // This is the most reliable path for Azure/Foundry deployments where
    // dropped SSE streams ("response.failed") are the dominant failure mode.
    const STREAM_IDLE_TIMEOUT_MS = 3_600_000; // 60 min — matches Azure max stream lifetime
    const streamProviderOverrides = {
      stream_idle_timeout_ms: STREAM_IDLE_TIMEOUT_MS,
      stream_max_retries: 15,
      request_max_retries: 6,
    };
    const runtime = buildCodexSdkRuntime(streamProviderOverrides, process.env, getWorkingDirectory(state));

    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_ORGANIZATION;
    delete process.env.OPENAI_PROJECT;
    for (const key of runtime.unsetEnvKeys || []) {
      delete process.env[key];
    }
    Object.assign(process.env, runtime.env);

    codexInstance = new Cls({
      config: {
        ...runtime.config,
        model_provider: runtime.config?.model_provider,
        model_providers: runtime.config?.model_providers,
        model: runtime.config?.model,
        features: {
          ...(runtime.config?.features || {}),
          child_agents_md: true,
          multi_agent: true,
          memories: true,
          undo: true,
          steer: true,
        },
      },
    });

    console.log(`[codex-shell] created Codex instance (provider=${runtime.providerName}, stream_idle_timeout=${runtime.streamIdleTimeoutMs}ms, stream_max_retries=${streamProviderOverrides.stream_max_retries})`);
  }

  const transport = resolveCodexTransport();
  const shouldResume = transport === "cli";

  if (state.threadId && shouldResume) {
    if (typeof codexInstance.resumeThread === "function") {
      try {
        state.thread = codexInstance.resumeThread(
          state.threadId,
          threadOptions,
        );
        if (state.thread) {
          detectThreadCapabilities(state.thread, state);
          console.log(`[codex-shell] resumed thread ${state.threadId}`);
          return state.thread;
        }
      } catch (err) {
        console.warn(
          `[codex-shell] failed to resume thread ${state.threadId}: ${err.message} — starting fresh`,
        );
      }
    } else {
      console.warn(
        "[codex-shell] SDK does not expose resumeThread(); starting fresh thread",
      );
    }
    state.threadId = null;
  }

  // Fresh-thread mode (default): avoid token overflow from long-running reuse.
  if (state.threadId && !shouldResume) {
    console.log(
      `[codex-shell] discarding previous thread ${state.threadId} — creating fresh thread per task`,
    );
    state.threadId = null;
  }

  // Start a new thread — defer the system prompt to the first user message so
  // the priming turn is STREAMED (runStreamed) instead of blocking (run).
  // This eliminates the 2-5 minute silent delay the chat UI suffered because
  // the old `thread.run(SYSTEM_PROMPT)` call produced zero streaming events.
  state.thread = codexInstance.startThread(threadOptions);
  detectThreadCapabilities(state.thread, state);
  state.threadNeedsPriming = true;

  if (state.thread.id) {
    state.threadId = state.thread.id;
    if (options.sessionId) {
      await persistSessionState(options.sessionId, state);
    } else if (currentSessionId) {
      await saveState();
    }
    console.log(`[codex-shell] new thread started: ${state.threadId} (priming deferred to first user turn, cwd=${threadOptions.workingDirectory})`);
  } else {
    console.log(`[codex-shell] new thread started (priming deferred to first user turn, cwd=${threadOptions.workingDirectory})`);
  }

  return state.thread;
}

function detectThreadCapabilities(thread, state = null) {
  if (!thread || typeof thread !== "object") {
    const fallbackCaps = createRuntimeCaps();
    if (state) state.runtimeCaps = fallbackCaps;
    return fallbackCaps;
  }
  const candidates = ["steer", "sendSteer", "steering"];
  const method =
    candidates.find((name) => typeof thread?.[name] === "function") || null;
  const caps = {
    hasSteeringApi: !!method,
    steeringMethod: method,
  };
  if (state) state.runtimeCaps = caps;
  return caps;
}

// ── Event Formatting ─────────────────────────────────────────────────────────

/**
 * Format a ThreadEvent into a human-readable string for Telegram streaming.
 * Returns null for events that shouldn't be sent.
 */
function formatEvent(event) {
  switch (event.type) {
    case "item.started": {
      const item = event.item;
      switch (item.type) {
        case "command_execution":
          return `:zap: Running: \`${item.command}\``;
        case "file_change":
          return null; // wait for completed
        case "mcp_tool_call":
          return `:plug: MCP [${item.server}]: ${item.tool}`;
        case "reasoning":
          return item.text ? `:u1f4ad: ${item.text.slice(0, 300)}` : null;
        case "agent_message":
          return null; // wait for completed for full text
        case "todo_list":
          if (item.items && item.items.length > 0) {
            const todoLines = item.items.map(
              (t) => `  ${t.completed ? ":check:" : ":dot:"} ${t.text}`,
            );
            return `:clipboard: Plan:\n${todoLines.join("\n")}`;
          }
          return null;
        case "web_search":
          return `:search: Searching: ${item.query}`;
        default:
          return null;
      }
    }

    case "item.completed": {
      const item = event.item;
      switch (item.type) {
        case "command_execution": {
          const status = item.exit_code === 0 ? ":check:" : ":close:";
          const output = item.aggregated_output
            ? `\n${item.aggregated_output.slice(-500)}`
            : "";
          return `${status} Command done: \`${item.command}\` (exit ${item.exit_code ?? "?"})${output}`;
        }
        case "file_change": {
          if (item.changes && item.changes.length > 0) {
            const fileLines = item.changes.map(
              (c) =>
                `  ${c.kind === "add" ? ":plus:" : c.kind === "delete" ? ":trash:" : ":edit:"} ${c.path}`,
            );
            return `:folder: Files changed:\n${fileLines.join("\n")}`;
          }
          return null;
        }
        case "agent_message":
          return item.text || null;
        case "mcp_tool_call": {
          const status = item.status === "completed" ? ":check:" : ":close:";
          const resultInfo = item.error
            ? `Error: ${item.error.message}`
            : "done";
          return `${status} MCP [${item.server}/${item.tool}]: ${resultInfo}`;
        }
        case "todo_list": {
          if (item.items && item.items.length > 0) {
            const todoLines = item.items.map(
              (t) => `  ${t.completed ? ":check:" : ":dot:"} ${t.text}`,
            );
            return `:clipboard: Updated plan:\n${todoLines.join("\n")}`;
          }
          return null;
        }
        default:
          return null;
      }
    }

    case "item.updated": {
      const item = event.item;
      // Stream partial reasoning and command output
      if (item.type === "reasoning" && item.text) {
        return `:u1f4ad: ${item.text.slice(0, 300)}`;
      }
      if (item.type === "todo_list" && item.items) {
        const todoLines = item.items.map(
          (t) => `  ${t.completed ? ":check:" : ":dot:"} ${t.text}`,
        );
        return `:clipboard: Plan update:\n${todoLines.join("\n")}`;
      }
      return null;
    }

    case "turn.completed":
      return null; // handled by caller
    case "turn.failed":
      return `:close: Turn failed: ${event.error?.message || "unknown error"}`;
    case "error":
      return `:close: Error: ${event.message}`;
    default:
      return null;
  }
}

function isRecoverableThreadError(err) {
  const message = err?.message || String(err || "");
  const lower = message.toLowerCase();
  // JSON body parse failures from the Codex API — thread state is corrupt;
  // reset and retry with a fresh thread (the sanitizeAndTruncatePrompt guard
  // on the next attempt will prevent recurrence).
  const isJsonBodyError =
    lower.includes("failed to parse request body as json") ||
    lower.includes("bytepositioninline") ||
    lower.includes("expected end of string") ||
    lower.includes("is invalid after a property name") ||
    (lower.includes("invalid_request_error") && lower.includes("json"));
  return (
    isJsonBodyError ||
    lower.includes("was provided without its required following item") ||
    (lower.includes("type 'reasoning'") && lower.includes("required following item")) ||
    lower.includes("function call output is missing for call id") ||
    lower.includes("invalid_encrypted_content") ||
    lower.includes("could not be verified") ||
    lower.includes("state db missing rollout path") ||
    lower.includes("rollout path") ||
    lower.includes("tool call must have a tool call id") ||
    lower.includes("tool_call_id") ||
    (lower.includes("400") && lower.includes("tool call"))
  );
}

// ── Main Execution ───────────────────────────────────────────────────────────

/**
 * Send a message to the Codex agent and stream events back.
 *
 * @param {string} userMessage - The user's message/task
 * @param {object} options
 * @param {function} options.onEvent - Callback for each formatted event string
 * @param {object} options.statusData - Current orchestrator status (for context)
 * @param {number} options.timeoutMs - Timeout in ms
 * @returns {Promise<{finalResponse: string, items: Array, usage: object|null}>}
 */
export async function execCodexPrompt(userMessage, options = {}) {
  const {
    onEvent = null,
    statusData = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    sendRawEvents = false,
    abortController = null,
    persistent = false,
    sessionId = null,
    mode = null,
    cwd = null,
  } = options;
  const normalizedTimeoutMs = normalizeTimeoutMs(timeoutMs, {
    fallback: DEFAULT_TIMEOUT_MS,
    label: "execCodexPrompt.timeoutMs",
  });

  agentSdk = resolveAgentSdkConfig({ reload: true });
  if (agentSdk.primary !== "codex") {
    return {
      finalResponse: `:close: Agent SDK set to "${agentSdk.primary}" — Codex SDK disabled.`,
      items: [],
      usage: null,
    };
  }

  const persistentSessionId = persistent
    ? (toTrimmedString(sessionId || "") || "primary")
    : "";
  const logicalSessionId = persistentSessionId || `codex-task-${Date.now()}`;
  const shouldActivateManagedSession = persistent || Boolean(currentSessionId || persistentSessionId);
  const providerRuntime = codexSessionCompat.resolveProvider({
    providerSelection: options.providerSelection || "codex",
    model: process.env.CODEX_MODEL || null,
  });
  const requestedWorkingDirectory = normalizeWorkingDirectory(cwd);
  const state = persistent
    ? (await loadSession(persistentSessionId))
    : createRuntimeState({
        workingDirectory: requestedWorkingDirectory || DEFAULT_WORKING_DIRECTORY,
      });

  if (state.activeTurn) {
    return {
      finalResponse:
        ":clock: Agent is still executing a previous task. Please wait.",
      items: [],
      usage: null,
    };
  }

  state.activeTurn = true;

  try {
    const streamSafety = resolveCodexStreamSafety(normalizedTimeoutMs);

    if (!persistent) {
      // Task executor path — keep existing fresh-thread behavior
      state.thread = null;
      state.threadId = null;
      state.turnCount = 0;
      state.threadNeedsPriming = false;
      state.workingDirectory = requestedWorkingDirectory || DEFAULT_WORKING_DIRECTORY;
    } else if (state.turnCount >= MAX_PERSISTENT_TURNS) {
      // Thread is too long — start fresh within the same session
      console.log(`[codex-shell] session ${persistentSessionId} hit ${MAX_PERSISTENT_TURNS} turns — rotating thread`);
      state.thread = null;
      state.threadId = null;
      state.turnCount = 0;
      state.threadNeedsPriming = false;
    }
    // else: persistent && same session && under limit → reuse state.thread

    if (
      requestedWorkingDirectory &&
      requestedWorkingDirectory !== getWorkingDirectory(state)
    ) {
      state.workingDirectory = requestedWorkingDirectory;
      state.thread = null;
      state.threadId = null;
      state.turnCount = 0;
      state.threadNeedsPriming = false;
      if (persistent) {
        await persistSessionState(persistentSessionId, state, { activate: true });
      }
      console.log(
        `[codex-shell] switched working directory to ${requestedWorkingDirectory} for session ${persistentSessionId || "(ephemeral)"}`,
      );
    }
    codexSessionCompat.beginTurn(logicalSessionId, {
      activate: shouldActivateManagedSession,
      status: "running",
      threadId: state.threadId,
      cwd: getWorkingDirectory(state),
      providerSelection: providerRuntime.providerId || "codex",
      model: providerRuntime.providerConfig?.model || process.env.CODEX_MODEL || null,
      metadata: {
        providerThreadId: state.threadId,
        persistent,
        mode: mode || null,
      },
    });

    // ── Mode detection ───────────────────────────────────────────────────
    // "ask" mode should be lightweight — no heavy executor framing that
    // instructs the agent to run commands and read files.  The mode is
    // either passed explicitly or detected from the MODE prefix that
    // primary-agent.mjs prepends.
    const isAskMode =
      mode === "ask" || /^\[MODE:\s*ask\]/i.test(userMessage);

    // Build the user prompt with optional status context (built once, reused across retries)
    let prompt = userMessage;
    if (statusData && !isAskMode) {
      const statusSnippet = JSON.stringify(statusData, null, 2).slice(0, 2000);
      prompt = `[Orchestrator Status]\n\`\`\`json\n${statusSnippet}\n\`\`\`\n\n# YOUR TASK — EXECUTE NOW\n\n${userMessage}\n\n---\nDo NOT respond with "Ready" or ask what to do. EXECUTE this task. Read files, run commands, produce detailed output.${TOOL_OUTPUT_GUARDRAIL}`;
    } else if (isAskMode) {
      // Ask mode — pass through without executor framing.  The mode
      // prefix from primary-agent already tells the model to be brief.
      prompt = userMessage;
    } else {
      prompt = `${userMessage}\n\n\n# YOUR TASK — EXECUTE NOW\n\n\n---\nDo NOT respond with "Ready" or ask what to do. EXECUTE this task. Read files, run commands, produce detailed output & complete the user's request E2E.${TOOL_OUTPUT_GUARDRAIL}`;
    }
    // Sanitize & size-guard once — prevents invalid_request_error from oversized
    // bodies (BytePositionInLine > 80 000) or unescaped control characters.
    let safePrompt = sanitizeAndTruncatePrompt(prompt);

    let threadResetDone = false;

    for (let attempt = 0; attempt < MAX_STREAM_RETRIES; attempt += 1) {
      const thread = await getThread(state, {
        sessionId: persistent ? persistentSessionId : null,
      });

      // If the thread is freshly created (or was just reset in a recovery path),
      // prepend the system prompt so the agent gets its identity/context on the
      // FIRST streamed turn.  Previously this was done via a blocking
      // `thread.run(SYSTEM_PROMPT)` call inside `getThread()`, which produced
      // zero streaming events and caused the chat UI to appear frozen for
      // 2-5+ minutes.  Checking threadNeedsPriming INSIDE the retry loop
      // ensures a freshly-reset thread still receives the primer.
      let attemptPrompt = safePrompt;
      if (state.threadNeedsPriming) {
        // Ask mode gets a lightweight primer — no heavy executor directives
        // that contradict the "don't use tools" instruction.
        const primer = isAskMode
          ? "You are a helpful AI assistant deployed inside the bosun orchestrator. " +
            "Answer the user's questions concisely. Only use tools when explicitly asked to."
          : SYSTEM_PROMPT;
        attemptPrompt = sanitizeAndTruncatePrompt(
          primer + "\n\n---\n\n" + prompt,
        );
        state.threadNeedsPriming = false;
      }

      // Each attempt gets a fresh AbortController tied to the same timeout budget.
      // We intentionally do NOT share the same controller across retries: if the
      // first attempt times out the signal is already aborted and the retry would
      // immediately fail.  The total wall-clock budget is still bounded by the
      // outer timeoutMs passed in.
      const controller = abortController || new AbortController();
      const timer = setTimeout(
        () => controller.abort("timeout"),
        normalizedTimeoutMs,
      );

      try {
        // Use runStreamed for real-time event streaming
        const streamedTurn = await thread.runStreamed(attemptPrompt, {
          signal: controller.signal,
        });

        let finalResponse = "";
        const allItems = [];
        let finalUsage = null;
        let turnFailedErr = null;
        let firstEventTimer = null;
        let eventCount = 0;
        let droppedItems = 0;

        // Process events from the async generator
        if (streamSafety.firstEventTimeoutMs) {
          firstEventTimer = setTimeout(() => {
            if (eventCount > 0 || controller.signal.aborted) return;
            controller.abort("first_event_timeout");
          }, streamSafety.firstEventTimeoutMs);
          if (typeof firstEventTimer.unref === "function") {
            firstEventTimer.unref();
          }
        }

        for await (const event of streamedTurn.events) {
          eventCount += 1;
          codexSessionCompat.recordStreamEvent(logicalSessionId, event, {
            activate: shouldActivateManagedSession,
            threadId: state.threadId || event?.thread_id || null,
            cwd: getWorkingDirectory(state),
            providerSelection: providerRuntime.providerId || "codex",
            model: providerRuntime.providerConfig?.model || process.env.CODEX_MODEL || null,
          });
          if (firstEventTimer) {
            clearTimeout(firstEventTimer);
            firstEventTimer = null;
          }
          // Capture thread ID on first turn
          if (event.type === "thread.started" && event.thread_id) {
            state.threadId = event.thread_id;
            if (persistent) {
              await persistSessionState(persistentSessionId, state, { activate: true, status: "running" });
            } else if (currentSessionId) {
              await saveState();
            }
            codexSessionCompat.beginTurn(logicalSessionId, {
              activate: shouldActivateManagedSession,
              status: "running",
              threadId: state.threadId,
              cwd: getWorkingDirectory(state),
              providerSelection: providerRuntime.providerId || "codex",
              model: providerRuntime.providerConfig?.model || process.env.CODEX_MODEL || null,
              metadata: {
                providerThreadId: state.threadId,
                persistent,
              },
            });
          }

          // turn.failed is emitted by the SDK when the server signals response.failed.
          // Convert it into a retriable error so the retry loop can back off & retry.
          if (event.type === "turn.failed") {
            const detail = event.error?.message || "response.failed";
            turnFailedErr = new Error(`stream disconnected before completion: ${detail}`);
          }

          // Format and emit event
          if (onEvent) {
            const formatted = formatEvent(event);
            if (formatted || sendRawEvents) {
              try {
                if (sendRawEvents) {
                  await onEvent(formatted, event);
                } else {
                  await onEvent(formatted);
                }
              } catch {
                /* best effort */
              }
            }
          }

          // Collect items
          if (event.type === "item.completed") {
            if (allItems.length < streamSafety.maxItemsPerTurn) {
              allItems.push(
                truncateItemForStorage(event.item, streamSafety.maxItemChars),
              );
            } else {
              droppedItems += 1;
            }
            if (event.item.type === "agent_message" && event.item.text) {
              finalResponse += event.item.text + "\n";
            }
          }

          // Track usage
          if (event.type === "turn.completed") {
            finalUsage = normalizeProviderUsageMetadata(
              event.usage
              || event.turn?.usage
              || event.result?.usage
              || finalUsage,
            ) || finalUsage;
            state.turnCount++;
            if (persistent) {
              await persistSessionState(persistentSessionId, state, { activate: true, status: "active" });
            } else if (currentSessionId) {
              await saveState();
            }
            codexSessionCompat.completeTurn(logicalSessionId, {
              activate: shouldActivateManagedSession,
              status: "completed",
              threadId: state.threadId,
              cwd: getWorkingDirectory(state),
              providerSelection: providerRuntime.providerId || "codex",
              model: providerRuntime.providerConfig?.model || process.env.CODEX_MODEL || null,
              metadata: {
                providerThreadId: state.threadId,
                turnCount: state.turnCount,
                persistent,
              },
            });
          }
        }

        if (firstEventTimer) {
          clearTimeout(firstEventTimer);
          firstEventTimer = null;
        }

        if (droppedItems > 0) {
          allItems.push({
            type: "stream_notice",
            text: `Dropped ${droppedItems} completed items to stay within INTERNAL_EXECUTOR_STREAM_MAX_ITEMS_PER_TURN=${streamSafety.maxItemsPerTurn}.`,
          });
        }

        // If a turn.failed event was seen during the stream, treat it as a
        // transient stream error so the retry loop handles it correctly.
        if (turnFailedErr) throw turnFailedErr;

        clearTimeout(timer);

        // Apply context shredding to collected items (SDK session path)
        const compressedItems = await maybeCompressSessionItems(allItems, {
          sessionType: persistent ? "primary" : "task",
          agentType: "codex-sdk",
          sessionId: persistent ? persistentSessionId : logicalSessionId,
        });

        return {
          finalResponse:
            finalResponse.trim() || "(Agent completed with no text output)",
          items: compressedItems,
          usage: finalUsage,
        };
      } catch (err) {
        clearTimeout(timer);

        if (err.name === "AbortError") {
          const reason = controller.signal.reason;
          if (reason === "first_event_timeout") {
            err = new Error(
              `stream disconnected before completion: no stream events within ${streamSafety.firstEventTimeoutMs}ms`,
            );
          } else {
            const msg =
              reason === "user_stop"
                ? ":close: Agent stopped by user."
                : `:clock: Agent timed out after ${normalizedTimeoutMs / 1000}s`;
            codexSessionCompat.abortTurn(logicalSessionId, {
              activate: shouldActivateManagedSession,
              status: reason === "user_stop" ? "aborted" : "timeout",
              threadId: state.threadId,
              cwd: getWorkingDirectory(state),
              error: msg,
              providerSelection: providerRuntime.providerId || "codex",
              model: providerRuntime.providerConfig?.model || process.env.CODEX_MODEL || null,
              metadata: {
                providerThreadId: state.threadId,
                persistent,
              },
            });
            return { finalResponse: msg, items: [], usage: null };
          }
        }

        // ── Thread corruption errors: reset thread & retry once ──────────────
        if (!threadResetDone && isRecoverableThreadError(err)) {
          console.warn(
            `[codex-shell] recoverable thread error: ${err.message || err} — resetting thread`,
          );
          clearRuntimeState(state);
          if (persistent) {
            await persistSessionState(persistentSessionId, state, { activate: true, status: "idle" });
          }
          threadResetDone = true;
          continue; // retry without counting against stream-retry budget
        }

        // ── Transient stream/network errors: backoff & retry ─────────────────
        if (isTransientStreamError(err)) {
          const attemptsLeft = MAX_STREAM_RETRIES - 1 - attempt;
          if (attemptsLeft > 0) {
            const delay = streamRetryDelay(attempt);
            console.warn(
              `[codex-shell] transient stream error (attempt ${attempt + 1}/${MAX_STREAM_RETRIES}): ${err.message || err} — retrying in ${Math.round(delay)}ms`,
            );
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          // Exhausted all retries
          console.error(
            `[codex-shell] stream disconnection not resolved after ${MAX_STREAM_RETRIES} attempts — giving up`,
          );
          codexSessionCompat.failTurn(logicalSessionId, {
            activate: shouldActivateManagedSession,
            status: "failed",
            threadId: state.threadId,
            cwd: getWorkingDirectory(state),
            error: err?.message || String(err),
            providerSelection: providerRuntime.providerId || "codex",
            model: providerRuntime.providerConfig?.model || process.env.CODEX_MODEL || null,
            metadata: {
              providerThreadId: state.threadId,
              persistent,
            },
          });
          return {
            finalResponse: `:close: Stream disconnected after ${MAX_STREAM_RETRIES} retries: ${err.message}`,
            items: [],
            usage: null,
          };
        }

        codexSessionCompat.failTurn(logicalSessionId, {
          activate: shouldActivateManagedSession,
          status: "failed",
          threadId: state.threadId,
          cwd: getWorkingDirectory(state),
          error: err?.message || String(err),
          providerSelection: providerRuntime.providerId || "codex",
          model: providerRuntime.providerConfig?.model || process.env.CODEX_MODEL || null,
          metadata: {
            providerThreadId: state.threadId,
            persistent,
          },
        });

        throw err;
      }
    }
    return {
      finalResponse: ":close: Agent failed after all retry attempts.",
      items: [],
      usage: null,
    };
  } finally {
    state.activeTurn = false;
  }
}

/**
 * Try to steer an in-flight agent without stopping the run.
 * Best-effort: uses SDK steering APIs if available, else returns unsupported.
 */
export async function steerCodexPrompt(message, options = {}) {
  try {
    agentSdk = resolveAgentSdkConfig({ reload: true });
    if (agentSdk.primary !== "codex") {
      return { ok: false, reason: "agent_sdk_not_codex" };
    }
    if (!agentSdk.capabilities?.steering) {
      return { ok: false, reason: "steering_disabled" };
    }
    const explicitSessionId = toTrimmedString(options?.sessionId || "");
    const targetSessionId =
      explicitSessionId
      || findSingleBusySessionId()
      || currentSessionId
      || null;
    const state = getSessionRuntimeState(targetSessionId, { create: false });
    if (!state) {
      return { ok: false, reason: "no_active_session" };
    }
    const thread = await getThread(state, { sessionId: targetSessionId });
    const runtimeCaps = detectThreadCapabilities(thread, state);
    const steerFn = runtimeCaps.steeringMethod
      ? thread?.[runtimeCaps.steeringMethod]
      : null;

    if (typeof steerFn === "function") {
      await steerFn.call(thread, message);
      return { ok: true, mode: "steer" };
    }

    return {
      ok: false,
      reason: "sdk_no_steering_api",
      detail: "Current Codex SDK Thread exposes only run()/runStreamed()",
    };
  } catch (err) {
    return { ok: false, reason: err.message || "steer_failed" };
  }
}

/**
 * Check if a turn is currently in flight.
 */
export function isCodexBusy() {
  return [...persistentSessionStates.values()].some((state) => state?.activeTurn);
}

/**
 * Get thread info for display.
 */
export function getThreadInfo(sessionId = null) {
  const target = resolveRuntimeStateForIntrospection(sessionId);
  const state = target.state;
  return codexSessionCompat.getSessionInfo({
    threadId: state?.threadId || null,
    turnCount: state?.turnCount || 0,
    isActive: !!state?.thread,
    isBusy: !!state?.activeTurn,
    sessionId: target.sessionId,
    cwd: getWorkingDirectory(state),
    sessionCount: persistentSessionStates.size,
  });
}

/**
 * Reset the thread — starts a fresh conversation.
 */
export async function resetThread(sessionId = null) {
  const normalizedSessionId = toTrimmedString(sessionId);
  if (normalizedSessionId) {
    const state = getSessionRuntimeState(normalizedSessionId, { create: false });
    if (state) {
      clearRuntimeState(state);
      await persistSessionState(normalizedSessionId, state, { activate: normalizedSessionId === currentSessionId, status: "idle" });
    }
    if (normalizedSessionId === currentSessionId) {
      currentSessionId = null;
      await saveState();
    }
    console.log(`[codex-shell] session reset: ${normalizedSessionId}`);
    return;
  }
  persistentSessionStates.clear();
  currentSessionId = null;
  codexSessionCompat.reset({
    status: "idle",
    threadId: null,
    cwd: DEFAULT_WORKING_DIRECTORY,
    metadata: {
      providerThreadId: null,
      turnCount: 0,
    },
  });
  await saveState();
  console.log("[codex-shell] thread reset");
}

// ── Session Exports ──────────────────────────────────────────────────────────

/**
 * Get the currently active session ID.
 */
export function getActiveSessionId() {
  return codexSessionCompat.getActiveSessionId();
}

/**
 * Get the shell-private session store directory.
 */
export function getSessionStoreDir() {
  return SESSIONS_DIR;
}

/**
 * List all saved sessions from logs/codex-shell-sessions/.
 */
export async function listSessions() {
  const extraSessions = [];
  try {
    await mkdir(SESSIONS_DIR, { recursive: true });
    const files = await readdir(SESSIONS_DIR);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const id = f.replace(/\.json$/, "");
      const data = await loadSessionData(id);
      if (data) {
        extraSessions.push({
          id,
          sessionId: id,
          threadId: data.threadId || null,
          cwd: data.workingDirectory || null,
          createdAt: data.createdAt || null,
          lastActiveAt: data.lastActiveAt || null,
          adapter: "codex",
          status: data.threadId ? "active" : "idle",
          metadata: {
            providerThreadId: data.threadId || null,
            turnCount: data.turnCount || 0,
          },
        });
      }
    }
  } catch {
    return codexSessionCompat.listSessions();
  }
  return codexSessionCompat.listSessions({ extraSessions });
}

/**
 * Switch to a different session (saves current, loads target).
 */
export async function switchSession(id) {
  await loadSession(id);
  return codexSessionCompat.getSessionRecord(id);
}

/**
 * Create a new named session (does not switch to it).
 */
export async function createSession(id) {
  const data = {
    threadId: null,
    turnCount: 0,
    createdAt: timestamp(),
    lastActiveAt: timestamp(),
  };
  await saveSessionData(id, data);
  codexSessionCompat.createSession(id, {
    activate: false,
    status: "idle",
    threadId: null,
    cwd: DEFAULT_WORKING_DIRECTORY,
    metadata: {
      providerThreadId: null,
      turnCount: 0,
      createdAt: data.createdAt,
      lastActiveAt: data.lastActiveAt,
    },
  });
  return {
    id,
    sessionId: id,
    ...data,
  };
}

// ── Initialisation ──────────────────────────────────────────────────────────

export async function initCodexShell() {
  if (codexInstance) {
    // Already initialised — skip to avoid double-init when switchPrimaryAgent
    // resets the primary-agent `initialized` flag and triggers a second call.
    return;
  }
  await loadState();

  // Pre-load SDK
  const Cls = await loadCodexSdk();
  if (Cls) {
    const STREAM_IDLE_TIMEOUT_MS = 3_600_000; // 60 min — matches Azure max stream lifetime
    const streamProviderOverrides = {
      stream_idle_timeout_ms: STREAM_IDLE_TIMEOUT_MS,
      stream_max_retries: 15,
      request_max_retries: 6,
    };
    const runtime = buildCodexSdkRuntime(streamProviderOverrides, process.env, getWorkingDirectory(getSessionRuntimeState(currentSessionId, { create: false })));

    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_ORGANIZATION;
    delete process.env.OPENAI_PROJECT;
    for (const key of runtime.unsetEnvKeys || []) {
      delete process.env[key];
    }
    Object.assign(process.env, runtime.env);

    codexInstance = new Cls({
      config: {
        ...runtime.config,
        features: {
          ...(runtime.config?.features || {}),
          child_agents_md: true,
          multi_agent: true,
          memories: true,
          undo: true,
          steer: true,
        },
      },
    });
    console.log(`[codex-shell] initialised with Codex SDK (provider=${runtime.providerName}, sub-agent features enabled)`);
  } else {
    console.warn(
      "[codex-shell] initialised WITHOUT Codex SDK — agent will not work",
    );
  }
}
