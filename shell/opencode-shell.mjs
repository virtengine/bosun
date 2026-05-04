/**
 * opencode-shell.mjs — Persistent OpenCode agent adapter for bosun.
 *
 * Uses the OpenCode SDK (@opencode-ai/sdk) to maintain persistent sessions
 * with multi-turn conversation, tool use (shell, file I/O, MCP), and
 * real-time event streaming via Server-Sent Events.
 *
 * OpenCode runs a local HTTP server (Go binary) and exposes a type-safe
 * REST + SSE client. Each named bosun session maps to an OpenCode server
 * session UUID. Sessions persist across restarts by storing the UUID map
 * in logs/opencode-shell-state.json.
 *
 * SDK: @opencode-ai/sdk → https://opencode.ai/docs/sdk/
 * Server: opencode binary on PATH (https://opencode.ai)
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgentSdkConfig } from "../agent/agent-sdk.mjs";
import { resolveRepoRoot } from "../config/repo-root.mjs";
import {
  isTransientStreamError,
  streamRetryDelay,
  MAX_STREAM_RETRIES,
} from "../infra/stream-resilience.mjs";
import {
  discoverProviders,
} from "./opencode-providers.mjs";
import { maybeCompressSessionItems } from "../workspace/context-cache.mjs";
import { createShellSessionCompat } from "./shell-session-compat.mjs";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));

// ── Configuration ────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000; // 60 min — matches other adapters
const STATE_FILE = resolve(__dirname, "..", "logs", "opencode-shell-state.json");
const MAX_PERSISTENT_TURNS = 50;

const REPO_ROOT = resolveRepoRoot();

// ── State (module-scope — mandatory per AGENTS.md) ────────────────────────────

let _sdk = null;           // lazy-imported @opencode-ai/sdk module
let _client = null;         // REST client instance (createOpencodeClient)
let _server = null;         // server handle (has .close())
let _serverReady = false;   // true once ensureServerStarted() has succeeded

let activeTurn = false;
let turnCount = 0;
let activeNamedSessionId = null;  // bosun logical name ("primary", task-id, etc.)

/** Map: bosun named session id → OpenCode server session UUID */
const _sessionMap = new Map();

/** The OpenCode server session UUID currently in use */
let _activeServerSessionId = null;

let agentSdk = resolveAgentSdkConfig();
const opencodeSessionCompat = createShellSessionCompat({
  adapterName: "opencode",
  providerSelection: "opencode",
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function timestamp() {
  return new Date().toISOString();
}

function envFlagEnabled(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on", "y"].includes(raw);
}

function normalizePrimaryExpectation(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.includes("opencode")) return "opencode";
  if (raw.includes("codex") || raw.includes("gpt")) return "codex";
  if (raw.includes("copilot")) return "copilot";
  if (raw.includes("claude")) return "claude";
  if (raw.includes("gemini")) return "gemini";
  return raw;
}

function shouldBypassAgentSdkPrimaryGuard(expectedPrimary = null) {
  return normalizePrimaryExpectation(expectedPrimary) === "opencode";
}

/**
 * Parse "provider/modelId" or just "modelId" into { providerID, modelID }.
 * Accepts optional executor-level overrides that take highest priority.
 *
 * Priority:
 *   1. executorOverrides.provider + executorOverrides.model (from bosun.config.json executor entry)
 *   2. OPENCODE_PROVIDER_ID + OPENCODE_MODEL_ID env vars
 *   3. OPENCODE_MODEL env var (may contain "provider/model" format)
 *   4. null → let OpenCode use its configured default
 */
function resolveModelConfig(executorOverrides = null) {
  // 1. Executor-level overrides (from per-executor providerConfig in bosun.config.json)
  if (executorOverrides) {
    const overrideModel = String(executorOverrides.model || "").trim();
    const overrideProvider = String(executorOverrides.provider || "").trim();
    if (overrideModel) {
      // Model may be "provider/model" format
      const slashIdx = overrideModel.indexOf("/");
      if (slashIdx > 0) {
        return {
          providerID: overrideModel.slice(0, slashIdx),
          modelID: overrideModel.slice(slashIdx + 1),
        };
      }
      return { providerID: overrideProvider || null, modelID: overrideModel };
    }
  }

  // 2. Explicit separate env overrides
  const raw = String(
    process.env.OPENCODE_MODEL ||
    process.env.OPENCODE_MODEL_ID ||
    "",
  ).trim();

  const explicitProvider = String(process.env.OPENCODE_PROVIDER_ID || "").trim();
  const explicitModel = String(process.env.OPENCODE_MODEL_ID || "").trim();
  if (explicitProvider && explicitModel) {
    return { providerID: explicitProvider, modelID: explicitModel };
  }

  if (!raw) return null; // let OpenCode use its configured default

  // "anthropic/claude-3-5-sonnet-20241022" → { providerID: "anthropic", modelID: "..." }
  const slashIdx = raw.indexOf("/");
  if (slashIdx > 0) {
    return {
      providerID: raw.slice(0, slashIdx),
      modelID: raw.slice(slashIdx + 1),
    };
  }

  // bare model name — no provider prefix
  return { providerID: null, modelID: raw };
}

function resolvePort() {
  const raw = Number(process.env.OPENCODE_PORT || "4096");
  return Number.isFinite(raw) && raw > 0 ? raw : 4096;
}

function resolveTimeoutMs() {
  const raw = Number(process.env.OPENCODE_TIMEOUT_MS || "0");
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

// ── SDK Loading ───────────────────────────────────────────────────────────────

/**
 * Lazy-import @opencode-ai/sdk (cached at module scope per AGENTS.md rules).
 * Returns the module or null if not installed.
 */
async function loadOpencodeSDK() {
  if (_sdk) return _sdk;
  try {
    _sdk = await import("@opencode-ai/sdk");
    console.log("[opencode-shell] SDK loaded successfully");
    return _sdk;
  } catch (err) {
    console.error(`[opencode-shell] failed to load @opencode-ai/sdk: ${err.message}`);
    return null;
  }
}

// ── Server Lifecycle ──────────────────────────────────────────────────────────

/**
 * Start the OpenCode server if not already running.
 * Caches handles at module scope — safe to call on every turn.
 *
 * createOpencode() starts a local Go server and returns { client, server }.
 * createOpencodeClient() attaches to an already-running server.
 *
 * @param {object} [executorOverrides] - Per-executor provider config from bosun.config.json
 */
async function ensureServerStarted(executorOverrides = null) {
  if (_serverReady && _client) return true;

  const sdk = await loadOpencodeSDK();
  if (!sdk) {
    console.error("[opencode-shell] SDK not available — cannot start server");
    return false;
  }

  if (envFlagEnabled(process.env.OPENCODE_SDK_DISABLED)) {
    console.warn("[opencode-shell] disabled via OPENCODE_SDK_DISABLED");
    return false;
  }

  // Per-executor port override takes priority
  const port = executorOverrides?.port || resolvePort();

  // Build optional config overrides
  const configOverride = {};
  const modelCfg = resolveModelConfig(executorOverrides);
  if (modelCfg?.modelID) {
    // OpenCode config accepts: { model: "provider/modelId" }
    const fullModel = modelCfg.providerID
      ? `${modelCfg.providerID}/${modelCfg.modelID}`
      : modelCfg.modelID;
    configOverride.model = fullModel;
  }

  // Pass provider-specific API key if provided in executor config
  if (executorOverrides?.apiKey) {
    configOverride.apiKey = executorOverrides.apiKey;
  }
  // Pass provider-specific base URL if provided
  if (executorOverrides?.baseUrl) {
    configOverride.baseUrl = executorOverrides.baseUrl;
  }

  try {
    const { createOpencode } = sdk;
    const result = await createOpencode({
      hostname: "127.0.0.1",
      port,
      timeout: 10_000,
      config: Object.keys(configOverride).length ? configOverride : undefined,
    });

    _client = result.client;
    _server = result.server;
    _serverReady = true;

    // Register cleanup on normal process exit
    process.once("exit", () => {
      try {
        if (_server && typeof _server.close === "function") _server.close();
      } catch {
        /* best-effort */
      }
    });

    console.log(`[opencode-shell] server started (port ${port})`);
    return true;
  } catch (startErr) {
    // If server already running, try client-only attach
    console.warn(
      `[opencode-shell] createOpencode() failed: ${startErr.message} — trying client-only attach`,
    );
    try {
      const { createOpencodeClient } = sdk;
      _client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${port}` });
      _serverReady = true;
      console.log(`[opencode-shell] attached to existing server at port ${port}`);
      return true;
    } catch (attachErr) {
      console.error(
        `[opencode-shell] client-only attach also failed: ${attachErr.message}`,
      );
      return false;
    }
  }
}

// ── State Persistence ─────────────────────────────────────────────────────────

async function loadState() {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const data = JSON.parse(raw);
    activeNamedSessionId = data.activeNamedSessionId || null;
    turnCount = data.turnCount || 0;
    if (data.sessionMap && typeof data.sessionMap === "object") {
      for (const [k, v] of Object.entries(data.sessionMap)) {
        _sessionMap.set(k, v);
      }
    }
    _activeServerSessionId = data.activeServerSessionId || null;
    console.log(
      `[opencode-shell] loaded state: named=${activeNamedSessionId}, turns=${turnCount}, sessions=${_sessionMap.size}`,
    );
    opencodeSessionCompat.hydrate({
      sessionId: activeNamedSessionId,
      threadId: _activeServerSessionId,
      status: _activeServerSessionId ? "active" : "idle",
      metadata: {
        providerThreadId: _activeServerSessionId,
        sessionCount: _sessionMap.size,
        turnCount,
      },
    });
  } catch {
    activeNamedSessionId = null;
    turnCount = 0;
    _activeServerSessionId = null;
    opencodeSessionCompat.reset({ keepManagedRecord: false });
  }
}

async function saveState() {
  try {
    await mkdir(resolve(__dirname, "..", "logs"), { recursive: true });
    const sessionMapObj = Object.fromEntries(_sessionMap.entries());
    await writeFile(
      STATE_FILE,
      JSON.stringify(
        {
          activeNamedSessionId,
          activeServerSessionId: _activeServerSessionId,
          sessionMap: sessionMapObj,
          turnCount,
          updatedAt: timestamp(),
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch (err) {
    console.warn(`[opencode-shell] failed to save state: ${err.message}`);
  }
}

// ── Session Management ────────────────────────────────────────────────────────

/**
 * Verify a server session UUID still exists on the server.
 * OpenCode sessions are ephemeral per server start, so UUIDs from
 * a previous run are invalid after restart.
 */
async function serverSessionExists(serverSessionId) {
  if (!serverSessionId || !_client) return false;
  try {
    const result = await _client.session.get({ path: { id: serverSessionId } });
    return !result.error;
  } catch {
    return false;
  }
}

/**
 * Get or create an OpenCode server session for the given bosun named session.
 * Recovers stale UUIDs (from previous server runs) by creating fresh sessions.
 */
async function getOrCreateServerSession(namedId) {
  const existing = _sessionMap.get(namedId);

  if (existing) {
    // Verify the session is still alive on the server
    const alive = await serverSessionExists(existing);
    if (alive) {
      _activeServerSessionId = existing;
      return existing;
    }
    // Stale UUID — server was restarted; create a fresh session
    console.log(
      `[opencode-shell] session ${namedId} (${existing.slice(0, 8)}) stale — creating fresh`,
    );
    _sessionMap.delete(namedId);
  }

  try {
    const newSession = await _client.session.create({
      body: { title: `bosun/${namedId}` },
    });
    const newId = newSession?.data?.id || newSession?.id;
    if (!newId) throw new Error("session.create() returned no id");
    _sessionMap.set(namedId, newId);
    _activeServerSessionId = newId;
    console.log(
      `[opencode-shell] created server session ${newId.slice(0, 8)} for "${namedId}"`,
    );
    await saveState();
    return newId;
  } catch (err) {
    console.error(`[opencode-shell] failed to create server session: ${err.message}`);
    throw err;
  }
}

// ── Event Formatting ──────────────────────────────────────────────────────────

/**
 * Format an OpenCode SSE event into a human-readable string for streaming.
 * OpenCode SSE events have { type, properties } shape.
 * Returns null for events that should not be forwarded.
 */
function formatOpencodeEvent(event) {
  if (!event) return null;
  const { type, properties: p = {} } = event;

  switch (type) {
    // ── Session lifecycle ──────────────────────────────────────────────────
    case "session.created":
    case "session.updated":
      return null; // internal bookkeeping

    case "session.error":
      return `:close: OpenCode error: ${p.error || p.message || "unknown"}`;

    // ── Message streaming ──────────────────────────────────────────────────
    case "message.part": {
      // Partial content blocks — only emit substantive text to avoid noise
      if (p.type === "text" && typeof p.content === "string" && p.content.length > 20) {
        return p.content;
      }
      // Reasoning / thinking blocks
      if (p.type === "thinking" && p.thinking) {
        return `:u1f4ad: ${p.thinking.slice(0, 300)}`;
      }
      return null;
    }

    case "message.completed": {
      // Full message — extract text if not already emitted via message.part
      if (!p.body) return null;
      const parts = Array.isArray(p.body.parts) ? p.body.parts : [];
      const texts = parts
        .filter((pt) => pt.type === "text" && typeof pt.text === "string")
        .map((pt) => pt.text.trim())
        .filter(Boolean);
      if (texts.length > 0) return texts.join("\n");
      return null;
    }

    // ── Tool calls (embedded in message events via properties.tool) ────────
    case "tool.start": {
      const tool = p.tool || "";
      if (tool.startsWith("mcp_")) {
        const [, server, ...nameParts] = tool.split("_");
        return `:plug: MCP [${server}]: ${nameParts.join("_")}`;
      }
      if (tool === "bash" || tool === "shell" || tool === "run") {
        return `:zap: Running: \`${p.input?.command || p.input?.cmd || tool}\``;
      }
      if (tool === "write" || tool === "edit" || tool === "file_write") {
        return `:edit: Writing: ${p.input?.path || p.input?.file_path || "file"}`;
      }
      if (tool === "read" || tool === "file_read") {
        return `:file: Reading: ${p.input?.path || p.input?.file_path || "file"}`;
      }
      if (tool === "web_search" || tool === "webSearch") {
        return `:search: Searching: ${p.input?.query || ""}`;
      }
      if (tool === "glob" || tool === "find") {
        return `:search: Finding: ${p.input?.pattern || p.input?.query || ""}`;
      }
      // Generic tool
      return `:settings: Tool: ${tool}`;
    }

    case "tool.complete": {
      const tool = p.tool || "";
      const isError = !!p.error || p.exitCode !== undefined && p.exitCode !== 0;
      const status = isError ? ":close:" : ":check:";

      if (tool.startsWith("mcp_")) {
        const [, server, ...nameParts] = tool.split("_");
        const errMsg = p.error ? `: ${p.error}` : "";
        return `${status} MCP [${server}/${nameParts.join("_")}]${errMsg}`;
      }
      if (tool === "bash" || tool === "shell" || tool === "run") {
        const cmd = p.input?.command || p.input?.cmd || tool;
        const output = typeof p.output === "string" ? p.output.slice(-400) : "";
        const exitPart = p.exitCode !== undefined ? ` (exit ${p.exitCode})` : "";
        return `${status} Command: \`${cmd}\`${exitPart}${output ? `\n${output}` : ""}`;
      }
      if (tool === "write" || tool === "edit" || tool === "file_write") {
        const path = p.input?.path || p.input?.file_path || "file";
        return `${status} File written: ${path}`;
      }
      return null; // suppress other complete events
    }

    // ── File changes ───────────────────────────────────────────────────────
    case "file.updated":
    case "file.created": {
      const action = type === "file.created" ? ":plus:" : ":edit:";
      return `${action} ${p.path || p.file || "file"}`;
    }

    case "file.deleted":
      return `:trash: Deleted: ${p.path || p.file || "file"}`;

    // ── Error / completion ─────────────────────────────────────────────────
    case "prompt.completed":
    case "turn.completed":
      return null; // handled by caller

    case "error":
    case "prompt.error":
      return `:close: Error: ${p.message || p.error || "unknown"}`;

    default:
      return null;
  }
}

// ── Prompt Safety ─────────────────────────────────────────────────────────────

const MAX_PROMPT_BYTES = 180_000;

function sanitizeAndTruncatePrompt(text) {
  if (typeof text !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const sanitized = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  const bytes = Buffer.byteLength(sanitized, "utf8");
  if (bytes <= MAX_PROMPT_BYTES) return sanitized;
  const buf = Buffer.from(sanitized, "utf8").slice(0, MAX_PROMPT_BYTES);
  const truncated = buf.toString("utf8");
  const removedBytes = bytes - MAX_PROMPT_BYTES;
  console.warn(
    `[opencode-shell] prompt truncated: ${bytes} → ${MAX_PROMPT_BYTES} bytes (removed ${removedBytes} bytes)`,
  );
  return truncated + `\n\n[...prompt truncated — ${removedBytes} bytes removed]`;
}

// ── Main Execution ────────────────────────────────────────────────────────────

/**
 * Send a message to the OpenCode agent and stream events back.
 *
 * Concurrency model:
 *   • client.session.prompt() is blocking — it resolves when the turn finishes.
 *   • client.event.subscribe() is an SSE stream — we run it concurrently to
 *     forward live events to onEvent as they arrive.
 *   • Both are torn down together in the finally block.
 *
 * @param {string} userMessage
 * @param {object} options
 * @param {function} [options.onEvent]        - Callback for each formatted event string
 * @param {object}  [options.statusData]      - Orchestrator status for context
 * @param {number}  [options.timeoutMs]       - Timeout in ms
 * @param {boolean} [options.persistent]      - Reuse session across calls
 * @param {string}  [options.sessionId]       - Named session identifier
 * @param {boolean} [options.sendRawEvents]   - Also pass raw event object to onEvent
 * @param {AbortController} [options.abortController] - External abort signal
 * @param {object}  [options.providerConfig]  - Per-executor provider config from bosun.config.json
 * @param {string}  [options.provider]        - Provider name for this executor
 * @param {string}  [options.expectedPrimary] - Bosun-selected primary adapter name, when known
 * @returns {Promise<{finalResponse: string, items: Array, usage: null}>}
 */
export async function execOpencodePrompt(userMessage, options = {}) {
  const {
    onEvent = null,
    statusData = null,
    timeoutMs = resolveTimeoutMs(),
    persistent = false,
    sessionId = null,
    sendRawEvents = false,
    abortController = null,
    mode = null,
    providerConfig = null,
    provider = null,
    expectedPrimary = null,
  } = options;

  // Build executor-level overrides from provider config
  const executorOverrides = providerConfig
    ? { ...providerConfig, provider: provider || providerConfig.provider || null }
    : null;

  // Re-read config in case it changed hot
  agentSdk = resolveAgentSdkConfig({ reload: true });
  if (
    agentSdk.primary !== "opencode" &&
    !shouldBypassAgentSdkPrimaryGuard(expectedPrimary)
  ) {
    return {
      finalResponse: `:close: Agent SDK set to "${agentSdk.primary}" — OpenCode disabled.`,
      items: [],
      usage: null,
    };
  }

  if (envFlagEnabled(process.env.OPENCODE_SDK_DISABLED)) {
    return {
      finalResponse: ":close: OpenCode disabled via OPENCODE_SDK_DISABLED.",
      items: [],
      usage: null,
    };
  }

  if (activeTurn) {
    return {
      finalResponse: ":clock: OpenCode agent is still executing a previous task. Please wait.",
      items: [],
      usage: null,
    };
  }

  activeTurn = true;

  try {
    const started = await ensureServerStarted(executorOverrides);
    if (!started) {
      return {
        finalResponse: ":close: OpenCode server could not be started. Check that the opencode binary is on PATH.",
        items: [],
        usage: null,
      };
    }

    // Resolve which bosun session to use
    const namedId = persistent
      ? (sessionId || activeNamedSessionId || "primary")
      : (sessionId || `ephemeral-${Date.now()}`);

    if (persistent && namedId !== activeNamedSessionId) {
      activeNamedSessionId = namedId;
    }
    const shouldActivateManagedSession = persistent || Boolean(sessionId);
    const providerRuntime = opencodeSessionCompat.resolveProvider({
      providerSelection: provider || executorOverrides?.provider || "opencode",
      model: executorOverrides?.model || null,
    });
    opencodeSessionCompat.beginTurn(namedId, {
      activate: shouldActivateManagedSession,
      status: "running",
      threadId: _activeServerSessionId,
      providerSelection: providerRuntime.providerId || "opencode",
      model: providerRuntime.providerConfig?.model || executorOverrides?.model || null,
      metadata: {
        providerThreadId: _activeServerSessionId,
        turnCount,
        persistent,
        mode: mode || null,
      },
    });

    // Ensure we have a server session UUID
    let serverSessionId;
    try {
      serverSessionId = await getOrCreateServerSession(namedId);
    } catch (err) {
      opencodeSessionCompat.failTurn(namedId, {
        activate: shouldActivateManagedSession,
        status: "failed",
        threadId: _activeServerSessionId,
        error: err.message,
        providerSelection: providerRuntime.providerId || "opencode",
        model: providerRuntime.providerConfig?.model || executorOverrides?.model || null,
        metadata: {
          providerThreadId: _activeServerSessionId,
          persistent,
        },
      });
      return {
        finalResponse: `:close: Could not establish OpenCode session: ${err.message}`,
        items: [],
        usage: null,
      };
    }

    // ── Mode detection ───────────────────────────────────────────────────
    const isAskMode =
      mode === "ask" || /^\[MODE:\s*ask\]/i.test(userMessage);

    // Build enriched prompt
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
      prompt = `[Orchestrator Status]\n\`\`\`json\n${statusSnippet}\n\`\`\`\n\n# YOUR TASK — EXECUTE NOW\n\n${userMessage}\n\n---\nDo NOT respond with "Ready" or ask what to do. EXECUTE this task.`;
    } else {
      prompt = `${userMessage}\n\n---\nDo NOT respond with "Ready" or ask what to do. EXECUTE this task end-to-end.`;
    }
    const safePrompt = sanitizeAndTruncatePrompt(prompt);

    // Resolve model config (executor overrides take priority over env vars)
    const modelCfg = resolveModelConfig(executorOverrides);
    const promptBody = {
      parts: [{ type: "text", text: safePrompt }],
    };
    if (modelCfg?.modelID) {
      promptBody.model = {
        ...(modelCfg.providerID ? { providerID: modelCfg.providerID } : {}),
        modelID: modelCfg.modelID,
      };
    }

    // ── Retry loop ──────────────────────────────────────────────────────────
    for (let attempt = 0; attempt < MAX_STREAM_RETRIES; attempt++) {
      const controller = abortController || new AbortController();
      const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);

      // SSE event subscription — runs concurrently; collects formatted strings
      let sseSubscription = null;
      const sseForwardingPromise = (async () => {
        if (!onEvent) return;
        try {
          const evStream = await _client.event.subscribe();
          sseSubscription = evStream;
          for await (const event of evStream.stream) {
            if (controller.signal.aborted) break;
            // Only forward events belonging to our session
            const eventSessionId =
              event.properties?.sessionId ||
              event.properties?.session_id ||
              event.sessionId;
            if (eventSessionId && eventSessionId !== serverSessionId) continue;
            opencodeSessionCompat.recordStreamEvent(namedId, event, {
              activate: shouldActivateManagedSession,
              threadId: serverSessionId,
              providerSelection: providerRuntime.providerId || "opencode",
              model: providerRuntime.providerConfig?.model || executorOverrides?.model || null,
            });
            const formatted = formatOpencodeEvent(event);
            if (formatted) {
              try {
                if (sendRawEvents) {
                  await onEvent(formatted, event);
                } else {
                  await onEvent(formatted);
                }
              } catch {
                /* best-effort */
              }
            }
          }
        } catch (streamErr) {
          // Non-fatal: SSE stream closure during abort or server shutdown
          if (!controller.signal.aborted) {
            console.warn(`[opencode-shell] SSE stream error: ${streamErr.message}`);
          }
        }
      })();

      try {
        // Race the blocking prompt call against the abort signal so the turn
        // is promptly cancelled even if the SDK doesn't natively accept AbortSignal.
        const abortRace = new Promise((_, reject) => {
          if (controller.signal.aborted) {
            const e = new Error("AbortError");
            e.name = "AbortError";
            reject(e);
            return;
          }
          const onAbort = () => {
            const e = new Error("AbortError");
            e.name = "AbortError";
            reject(e);
          };
          controller.signal.addEventListener("abort", onAbort, { once: true });
        });

        const result = await Promise.race([
          _client.session.prompt({
            path: { id: serverSessionId },
            body: promptBody,
          }),
          abortRace,
        ]);

        clearTimeout(timer);

        // Tear down SSE subscription (close so the async iterator exits)
        try {
          if (sseSubscription && typeof sseSubscription.destroy === "function") {
            sseSubscription.destroy();
          }
        } catch {
          /* best-effort */
        }
        await sseForwardingPromise.catch(() => {});

        // Extract text response from result
        const info = result?.data?.info || result?.info || {};
        const parts =
          result?.data?.parts ||
          result?.parts ||
          (Array.isArray(info.parts) ? info.parts : []);

        const textParts = parts
          .filter((p) => p?.type === "text" && typeof p.text === "string")
          .map((p) => p.text.trim())
          .filter(Boolean);

        const finalResponse =
          textParts.join("\n") ||
          (typeof info.content === "string" ? info.content.trim() : "") ||
          "(Agent completed with no text output)";

        // Track turn count
        turnCount++;
        if (persistent || turnCount % 10 === 0) {
          await saveState().catch(() => {});
        }
        opencodeSessionCompat.completeTurn(namedId, {
          activate: shouldActivateManagedSession,
          status: "completed",
          threadId: serverSessionId,
          providerSelection: providerRuntime.providerId || "opencode",
          model: providerRuntime.providerConfig?.model || executorOverrides?.model || null,
          metadata: {
            providerThreadId: serverSessionId,
            turnCount,
            persistent,
          },
        });

        // Rotate ephemeral sessions to avoid unbounded session accumulation
        if (!persistent && namedId.startsWith("ephemeral-")) {
          _sessionMap.delete(namedId);
          _activeServerSessionId = null;
        }

        // Apply context shredding to collected items (SDK session path)
        const compressedParts = await maybeCompressSessionItems(parts, {
          sessionType: persistent ? "primary" : "task",
          agentType: "opencode-sdk",
        });

        return { finalResponse, items: compressedParts, usage: null };
      } catch (err) {
        clearTimeout(timer);

        // Clean up SSE on error
        try {
          if (sseSubscription && typeof sseSubscription.destroy === "function") {
            sseSubscription.destroy();
          }
        } catch {
          /* best-effort */
        }
        await sseForwardingPromise.catch(() => {});

        if (err.name === "AbortError" || controller.signal.aborted) {
          const reason = controller.signal.reason;
          const msg =
            reason === "user_stop"
              ? ":close: Agent stopped by user."
              : `:clock: Agent timed out after ${timeoutMs / 1000}s`;

          // Try to abort the server-side turn
          try {
            await _client.session.abort({ path: { id: serverSessionId } });
          } catch {
            /* best-effort */
          }

          opencodeSessionCompat.abortTurn(namedId, {
            activate: shouldActivateManagedSession,
            status: reason === "user_stop" ? "aborted" : "timeout",
            threadId: serverSessionId,
            error: msg,
            providerSelection: providerRuntime.providerId || "opencode",
            model: providerRuntime.providerConfig?.model || executorOverrides?.model || null,
            metadata: {
              providerThreadId: serverSessionId,
              persistent,
            },
          });
          return { finalResponse: msg, items: [], usage: null };
        }

        // Transient network/HTTP errors — retry with backoff
        if (isTransientStreamError(err)) {
          const attemptsLeft = MAX_STREAM_RETRIES - 1 - attempt;
          if (attemptsLeft > 0) {
            const delay = streamRetryDelay(attempt);
            console.warn(
              `[opencode-shell] transient error (attempt ${attempt + 1}/${MAX_STREAM_RETRIES}): ${err.message} — retrying in ${Math.round(delay)}ms`,
            );
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          return {
            finalResponse: `:close: OpenCode: connection failed after ${MAX_STREAM_RETRIES} retries: ${err.message}`,
            items: [],
            usage: null,
          };
        }

        opencodeSessionCompat.failTurn(namedId, {
          activate: shouldActivateManagedSession,
          status: "failed",
          threadId: serverSessionId,
          error: err?.message || String(err),
          providerSelection: providerRuntime.providerId || "opencode",
          model: providerRuntime.providerConfig?.model || executorOverrides?.model || null,
          metadata: {
            providerThreadId: serverSessionId,
            persistent,
          },
        });

        throw err;
      }
    }

    opencodeSessionCompat.failTurn(activeNamedSessionId || sessionId || "primary", {
      activate: Boolean(activeNamedSessionId || sessionId),
      status: "failed",
      threadId: _activeServerSessionId,
      error: "OpenCode agent failed after all retry attempts.",
      providerSelection: providerRuntime.providerId || "opencode",
      model: providerRuntime.providerConfig?.model || executorOverrides?.model || null,
      metadata: {
        providerThreadId: _activeServerSessionId,
        persistent,
      },
    });
    return {
      finalResponse: ":close: OpenCode agent failed after all retry attempts.",
      items: [],
      usage: null,
    };
  } finally {
    activeTurn = false;
  }
}

// ── Steering ───────────────────────────────────────────────────────────────────

/**
 * Attempt to interrupt an in-flight OpenCode turn.
 *
 * OpenCode does not support mid-turn message injection (unlike Codex steer).
 * The correct pattern is abort + re-queue a new prompt with the steering message.
 * This function aborts the active turn; the caller is responsible for re-queuing.
 *
 * @param {string} _message - Steering message (for logging; will be surfaced to caller)
 * @returns {Promise<{ok: boolean, reason?: string, mode?: string}>}
 */
export async function steerOpencodePrompt(_message, options = {}) {
  try {
    agentSdk = resolveAgentSdkConfig({ reload: true });
    if (
      agentSdk.primary !== "opencode" &&
      !shouldBypassAgentSdkPrimaryGuard(options?.expectedPrimary)
    ) {
      return { ok: false, reason: "agent_sdk_not_opencode" };
    }
    if (!agentSdk.capabilities?.steering) {
      return { ok: false, reason: "steering_disabled" };
    }
    if (!_activeServerSessionId) {
      return { ok: false, reason: "no_active_session" };
    }
    if (!_client) {
      return { ok: false, reason: "client_not_initialized" };
    }

    await _client.session.abort({ path: { id: _activeServerSessionId } });
    return { ok: true, mode: "abort" };
  } catch (err) {
    return { ok: false, reason: err.message || "abort_failed" };
  }
}

// ── Status / Info ──────────────────────────────────────────────────────────────

export function isOpencodeBusy() {
  return !!activeTurn;
}

export function getSessionInfo() {
  return opencodeSessionCompat.getSessionInfo({
    namedSessionId: activeNamedSessionId,
    serverSessionId: _activeServerSessionId,
    turnCount,
    isActive: _serverReady,
    isBusy: activeTurn,
    sessionCount: _sessionMap.size,
    threadId: _activeServerSessionId,
  });
}

export function getActiveSessionId() {
  return opencodeSessionCompat.getActiveSessionId();
}

// ── Session Management Exports ─────────────────────────────────────────────────

export async function listSessions() {
  const sessions = [];
  for (const [namedId, serverUUID] of _sessionMap.entries()) {
    sessions.push({
      id: namedId,
      serverSessionId: serverUUID,
      isActive: namedId === activeNamedSessionId,
      threadId: serverUUID,
      metadata: {
        providerThreadId: serverUUID,
      },
    });
  }
  // Also query the server for its live sessions if available
  if (_client) {
    try {
      const result = await _client.session.list();
      const serverSessions = result?.data || result || [];
      for (const ss of serverSessions) {
        const ssId = ss?.id;
        if (!ssId) continue;
        // Only include server sessions not already mapped
        const alreadyMapped = sessions.some((s) => s.serverSessionId === ssId);
        if (!alreadyMapped) {
          sessions.push({
            id: `server:${ssId}`,
            serverSessionId: ssId,
            isActive: ssId === _activeServerSessionId,
            serverManaged: true,
            threadId: ssId,
            metadata: {
              providerThreadId: ssId,
            },
          });
        }
      }
    } catch {
      /* best-effort */
    }
  }
  return opencodeSessionCompat.listSessions({ extraSessions: sessions });
}

export async function switchSession(namedId) {
  activeNamedSessionId = namedId;
  _activeServerSessionId = _sessionMap.get(namedId) || null;
  console.log(`[opencode-shell] switched to session "${namedId}"`);
  await saveState();
  return opencodeSessionCompat.switchSession(namedId, {
    threadId: _activeServerSessionId,
    status: _activeServerSessionId ? "active" : "idle",
    metadata: {
      providerThreadId: _activeServerSessionId,
      sessionCount: _sessionMap.size,
      turnCount,
    },
  });
}

export async function createSession(namedId) {
  if (_sessionMap.has(namedId)) {
    opencodeSessionCompat.createSession(namedId, {
      activate: false,
      status: "idle",
      threadId: _sessionMap.get(namedId),
      metadata: {
        providerThreadId: _sessionMap.get(namedId),
        sessionCount: _sessionMap.size,
        turnCount,
      },
    });
    return { id: namedId, sessionId: namedId, serverSessionId: _sessionMap.get(namedId) };
  }
  // Defer actual server session creation until first prompt
  opencodeSessionCompat.createSession(namedId, {
    activate: false,
    status: "idle",
    threadId: null,
    metadata: {
      providerThreadId: null,
      sessionCount: _sessionMap.size,
      turnCount,
    },
  });
  return { id: namedId, sessionId: namedId, serverSessionId: null };
}

// ── Reset ──────────────────────────────────────────────────────────────────────

export async function resetSession() {
  // Abort active turn if any
  if (_activeServerSessionId && _client) {
    try {
      await _client.session.abort({ path: { id: _activeServerSessionId } });
    } catch {
      /* best-effort */
    }
  }
  activeTurn = false;
  _activeServerSessionId = null;
  activeNamedSessionId = null;
  turnCount = 0;
  _sessionMap.clear();
  opencodeSessionCompat.reset({
    status: "idle",
    threadId: null,
    metadata: {
      providerThreadId: null,
      sessionCount: 0,
      turnCount: 0,
    },
  });
  await saveState();
  console.log("[opencode-shell] session reset");
}

// ── Initialisation ─────────────────────────────────────────────────────────────

export async function initOpencodeShell() {
  await loadState();

  if (envFlagEnabled(process.env.OPENCODE_SDK_DISABLED)) {
    console.warn("[opencode-shell] SDK disabled via OPENCODE_SDK_DISABLED — skipping init");
    return;
  }

  const sdk = await loadOpencodeSDK();
  if (sdk) {
    console.log("[opencode-shell] initialised (server will start on first prompt)");
  } else {
    console.warn(
      "[opencode-shell] initialised WITHOUT @opencode-ai/sdk — install it to use OpenCode as primary agent",
    );
  }
}

// ── Provider Discovery (delegates to opencode-providers.mjs) ───────────────

/**
 * Discover live providers from the OpenCode server or CLI.
 * Passes the existing SDK client if one is available.
 */
export async function discoverOpencodeProviders(opts = {}) {
  return discoverProviders({ ...opts, client: _client || undefined });
}

/**
 * Get connected (credential-configured) providers.
 */
export {
  getConnectedProviders,
  getProviderModels,
  isProviderConnected,
  invalidateCache as invalidateProviderCache,
} from "./opencode-providers.mjs";
