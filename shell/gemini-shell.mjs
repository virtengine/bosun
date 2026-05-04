/**
 * gemini-shell.mjs — Gemini adapter for Bosun.
 *
 * Supports:
 *   1) Direct SDK calls via @google/genai
 *   2) CLI fallback via the Gemini CLI binary
 *
 * Transport is controlled by GEMINI_TRANSPORT:
 *   auto (default) -> prefer SDK, fall back to CLI
 *   sdk            -> SDK only
 *   cli            -> CLI only
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isTransientStreamError,
  streamRetryDelay,
  MAX_STREAM_RETRIES,
} from "../infra/stream-resilience.mjs";
import { resolveRepoRoot } from "../config/repo-root.mjs";
import { createShellSessionCompat } from "./shell-session-compat.mjs";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000; // 60 min for agentic task runs
const STATE_FILE = resolve(__dirname, "..", "logs", "gemini-shell-state.json");
const REPO_ROOT = resolveRepoRoot();
const MAX_PROMPT_BYTES = 180_000;

let GoogleGenAIClass = null;
let geminiClient = null;
let activeTurn = false;
let activeSessionId = null;
let turnCount = 0;
let stateLoaded = false;
let activeTransport = "auto";
const geminiSessionCompat = createShellSessionCompat({
  adapterName: "gemini",
  providerSelection: "gemini",
});

function timestamp() {
  return new Date().toISOString();
}

function envFlagEnabled(value) {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "on", "y"].includes(raw);
}

function resolveGeminiTransport() {
  const raw = String(process.env.GEMINI_TRANSPORT || "auto")
    .trim()
    .toLowerCase();
  if (["auto", "sdk", "cli"].includes(raw)) return raw;
  console.warn(
    `[gemini-shell] invalid GEMINI_TRANSPORT='${raw}', defaulting to 'auto'`,
  );
  return "auto";
}

function resolveGeminiModel(options = {}) {
  const explicit = String(options.model || "").trim();
  if (explicit) return explicit;
  return String(process.env.GEMINI_MODEL || "gemini-2.5-pro").trim();
}

function resolveGeminiApiKey() {
  return String(
    process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      "",
  ).trim();
}

function resolveGeminiCliPath() {
  return String(process.env.GEMINI_CLI_PATH || "gemini").trim();
}

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
    `[gemini-shell] prompt truncated: ${bytes} → ${MAX_PROMPT_BYTES} bytes (removed ${removedBytes} bytes)`,
  );
  return truncated + `\n\n[...prompt truncated — ${removedBytes} bytes removed]`;
}

function appendStatusContext(prompt, statusData) {
  if (!statusData || typeof statusData !== "object") return prompt;
  try {
    const payload = JSON.stringify(statusData, null, 2);
    return `${prompt}\n\nOrchestrator Status:\n${payload}`;
  } catch {
    return prompt;
  }
}

function splitArgs(input) {
  const text = String(input || "").trim();
  if (!text) return [];
  const out = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`|([^\s]+)/g;
  let match = re.exec(text);
  while (match) {
    const token =
      match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
    if (token) out.push(token.replace(/\\(["'`\\])/g, "$1"));
    match = re.exec(text);
  }
  return out;
}

function extractTextFromGeminiResponse(response) {
  if (!response) return "";
  if (typeof response.text === "string") return response.text.trim();
  if (typeof response.text === "function") {
    try {
      const text = response.text();
      if (typeof text === "string") return text.trim();
    } catch {
      // no-op
    }
  }
  const candidates = Array.isArray(response.candidates)
    ? response.candidates
    : [];
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts;
    if (!Array.isArray(parts)) continue;
    const merged = parts
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    if (merged) return merged;
  }
  return "";
}

function extractUsage(response) {
  const usage = response?.usageMetadata || response?.usage || null;
  if (!usage || typeof usage !== "object") return null;
  return {
    promptTokens:
      Number(usage.promptTokenCount ?? usage.input_tokens ?? usage.prompt_tokens) ||
      null,
    completionTokens:
      Number(
        usage.candidatesTokenCount ??
          usage.output_tokens ??
          usage.completion_tokens,
      ) || null,
    totalTokens:
      Number(usage.totalTokenCount ?? usage.total_tokens) || null,
  };
}

function extractTextFromCliOutput(stdout, stderr = "") {
  const joined = String(stdout || "").trim();
  const fallback = joined || String(stderr || "").trim();
  if (!fallback) return "";

  const tryParse = (raw) => {
    if (!raw) return "";
    try {
      const data = JSON.parse(raw);
      if (typeof data?.text === "string" && data.text.trim()) {
        return data.text.trim();
      }
      if (typeof data?.output_text === "string" && data.output_text.trim()) {
        return data.output_text.trim();
      }
      if (typeof data?.response?.text === "string" && data.response.text.trim()) {
        return data.response.text.trim();
      }
      if (typeof data?.message === "string" && data.message.trim()) {
        return data.message.trim();
      }
      if (Array.isArray(data?.candidates)) {
        for (const candidate of data.candidates) {
          const parts = candidate?.content?.parts;
          if (!Array.isArray(parts)) continue;
          const text = parts
            .map((part) => (typeof part?.text === "string" ? part.text : ""))
            .filter(Boolean)
            .join("\n")
            .trim();
          if (text) return text;
        }
      }
    } catch {
      // ignore parse errors
    }
    return "";
  };

  const parsedWhole = tryParse(fallback);
  if (parsedWhole) return parsedWhole;
  for (const line of fallback.split(/\r?\n/).reverse()) {
    const parsedLine = tryParse(line.trim());
    if (parsedLine) return parsedLine;
  }
  return fallback;
}

async function loadGeminiSdk() {
  if (GoogleGenAIClass) return GoogleGenAIClass;
  try {
    const mod = await import("@google/genai");
    GoogleGenAIClass =
      mod?.GoogleGenAI ||
      mod?.default?.GoogleGenAI ||
      mod?.default ||
      null;
    if (!GoogleGenAIClass) {
      console.error("[gemini-shell] @google/genai loaded but GoogleGenAI export missing");
      return null;
    }
    console.log("[gemini-shell] SDK loaded successfully");
    return GoogleGenAIClass;
  } catch (err) {
    console.error(`[gemini-shell] failed to load @google/genai: ${err.message}`);
    return null;
  }
}

async function loadState() {
  if (stateLoaded) return;
  stateLoaded = true;
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const data = JSON.parse(raw);
    activeSessionId = data.activeSessionId || null;
    turnCount = data.turnCount || 0;
    activeTransport = data.activeTransport || "auto";
    geminiSessionCompat.hydrate({
      sessionId: activeSessionId,
      status: activeSessionId ? "idle" : "inactive",
      metadata: {
        transport: activeTransport,
        turnCount,
      },
    });
  } catch {
    activeSessionId = null;
    turnCount = 0;
    activeTransport = "auto";
    geminiSessionCompat.reset({ keepManagedRecord: false });
  }
}

async function saveState() {
  try {
    await mkdir(resolve(__dirname, "..", "logs"), { recursive: true });
    await writeFile(
      STATE_FILE,
      JSON.stringify(
        {
          activeSessionId,
          turnCount,
          activeTransport,
          updatedAt: timestamp(),
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch (err) {
    console.warn(`[gemini-shell] failed to save state: ${err.message}`);
  }
}

async function ensureGeminiClient() {
  if (geminiClient) return true;
  const apiKey = resolveGeminiApiKey();
  if (!apiKey) {
    console.warn("[gemini-shell] GEMINI_API_KEY/GOOGLE_API_KEY is not set");
    return false;
  }
  const Cls = await loadGeminiSdk();
  if (!Cls) return false;
  try {
    geminiClient = new Cls({ apiKey });
    return true;
  } catch (err) {
    console.error(`[gemini-shell] failed to initialize SDK client: ${err.message}`);
    geminiClient = null;
    return false;
  }
}

function withTimeout(promise, timeoutMs, abortSignal = null) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectPromise(
        new Error(`Gemini request timed out after ${Math.round(timeoutMs / 1000)}s`),
      );
    }, timeoutMs);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(new Error("Gemini request aborted"));
    };

    if (abortSignal) {
      if (abortSignal.aborted) return onAbort();
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (abortSignal) {
          abortSignal.removeEventListener("abort", onAbort);
        }
        resolvePromise(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (abortSignal) {
          abortSignal.removeEventListener("abort", onAbort);
        }
        rejectPromise(error);
      },
    );
  });
}

function runCliCommand(cliPath, args, timeoutMs, abortSignal = null) {
  return new Promise((resolvePromise) => {
    const child = spawn(cliPath, args, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // no-op
      }
      resolvePromise({
        ok: false,
        code: null,
        stdout,
        stderr: stderr || `Timed out after ${Math.round(timeoutMs / 1000)}s`,
      });
    }, timeoutMs);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGTERM");
      } catch {
        // no-op
      }
      resolvePromise({
        ok: false,
        code: null,
        stdout,
        stderr: "Aborted",
      });
    };

    if (abortSignal) {
      if (abortSignal.aborted) {
        onAbort();
        return;
      }
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk || "");
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk || "");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
      resolvePromise({
        ok: false,
        code: null,
        stdout,
        stderr: err.message || String(err),
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
      resolvePromise({
        ok: code === 0,
        code,
        stdout,
        stderr,
      });
    });
  });
}

function buildCliAttempts(promptText) {
  const attempts = [];
  const custom = String(process.env.GEMINI_CLI_ARGS || "").trim();
  if (custom) {
    const rawTokens = splitArgs(custom);
    if (rawTokens.length > 0) {
      const hasPlaceholder = rawTokens.some((token) => token.includes("{prompt}"));
      const mapped = rawTokens.map((token) =>
        token.replaceAll("{prompt}", promptText),
      );
      if (!hasPlaceholder) mapped.push(promptText);
      attempts.push(mapped);
    }
  }

  attempts.push(["--prompt", promptText, "--format", "json"]);
  attempts.push(["--prompt", promptText, "--format", "text"]);
  attempts.push(["--prompt", promptText]);
  attempts.push(["-p", promptText, "--format", "json"]);
  attempts.push(["-p", promptText]);
  attempts.push([promptText]);

  return attempts;
}

async function execGeminiCliPrompt(promptText, options = {}) {
  const cliPath = resolveGeminiCliPath();
  const timeoutMs = Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const attempts = buildCliAttempts(promptText);
  let lastError = "Gemini CLI failed";

  for (let i = 0; i < attempts.length; i++) {
    const args = attempts[i];
    if (typeof options.onEvent === "function") {
      options.onEvent(
        `:zap: Gemini CLI (${i + 1}/${attempts.length}): ${cliPath} ${args.join(" ")}`,
      );
    }
    const result = await runCliCommand(
      cliPath,
      args,
      timeoutMs,
      options.abortController?.signal || null,
    );
    if (result.ok) {
      const finalResponse = extractTextFromCliOutput(result.stdout, result.stderr);
      return {
        finalResponse: finalResponse || "Gemini CLI completed with no text output.",
        items: finalResponse
          ? [{ type: "text", text: finalResponse }]
          : [],
        usage: null,
      };
    }
    const stderr = String(result.stderr || "").trim();
    if (stderr) {
      lastError = stderr;
    } else if (result.code !== null) {
      lastError = `Gemini CLI exited with code ${result.code}`;
    }
  }

  return {
    finalResponse: `:close: Gemini CLI failed: ${lastError}`,
    items: [],
    usage: null,
  };
}

export async function execGeminiPrompt(userMessage, options = {}) {
  await loadState();

  if (envFlagEnabled(process.env.GEMINI_SDK_DISABLED)) {
    return {
      finalResponse: ":close: Gemini adapter disabled via GEMINI_SDK_DISABLED.",
      items: [],
      usage: null,
    };
  }

  if (activeTurn) {
    return {
      finalResponse:
        ":clock: Gemini agent is still executing a previous task. Please wait.",
      items: [],
      usage: null,
    };
  }

  const timeoutMs = Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const transport = resolveGeminiTransport();
  activeTransport = transport;

  const preferredSession = String(options.sessionId || "").trim();
  if (preferredSession) {
    activeSessionId = preferredSession;
  } else if (!activeSessionId) {
    activeSessionId = "primary-gemini";
  }

  const preparedPrompt = sanitizeAndTruncatePrompt(
    appendStatusContext(String(userMessage || ""), options.statusData),
  );
  activeTurn = true;
  let retryAttempt = 0;
  const logicalSessionId = activeSessionId || preferredSession || "primary-gemini";
  const providerRuntime = geminiSessionCompat.resolveProvider({
    providerSelection: options.providerSelection || "gemini",
    model: resolveGeminiModel(options),
  });
  geminiSessionCompat.beginTurn(logicalSessionId, {
    activate: Boolean(activeSessionId || preferredSession),
    status: "running",
    providerSelection: providerRuntime.providerId || "gemini",
    model: providerRuntime.providerConfig?.model || resolveGeminiModel(options),
    metadata: {
      transport,
      turnCount,
    },
  });

  while (retryAttempt <= MAX_STREAM_RETRIES) {
    try {
      if (transport === "cli") {
        const cliResult = await execGeminiCliPrompt(preparedPrompt, options);
        turnCount += 1;
        await saveState();
        geminiSessionCompat.completeTurn(logicalSessionId, {
          activate: Boolean(activeSessionId || preferredSession),
          status: "completed",
          providerSelection: providerRuntime.providerId || "gemini",
          model: providerRuntime.providerConfig?.model || resolveGeminiModel(options),
          metadata: {
            transport,
            turnCount,
          },
        });
        return cliResult;
      }

      if (typeof options.onEvent === "function") {
        options.onEvent(":cpu: Gemini SDK: generating response…");
      }

      const sdkReady = await ensureGeminiClient();
      if (!sdkReady) {
        if (transport === "sdk") {
          return {
            finalResponse:
              ":close: Gemini SDK unavailable. Install @google/genai and set GEMINI_API_KEY (or GOOGLE_API_KEY), or set GEMINI_TRANSPORT=cli.",
            items: [],
            usage: null,
          };
        }
        const cliResult = await execGeminiCliPrompt(preparedPrompt, options);
        turnCount += 1;
        await saveState();
        geminiSessionCompat.completeTurn(logicalSessionId, {
          activate: Boolean(activeSessionId || preferredSession),
          status: "completed",
          providerSelection: providerRuntime.providerId || "gemini",
          model: providerRuntime.providerConfig?.model || resolveGeminiModel(options),
          metadata: {
            transport,
            turnCount,
          },
        });
        return cliResult;
      }

      const model = resolveGeminiModel(options);
      const response = await withTimeout(
        geminiClient.models.generateContent({
          model,
          contents: preparedPrompt,
        }),
        timeoutMs,
        options.abortController?.signal || null,
      );
      const finalResponse = extractTextFromGeminiResponse(response);
      turnCount += 1;
      await saveState();
      geminiSessionCompat.completeTurn(logicalSessionId, {
        activate: Boolean(activeSessionId || preferredSession),
        status: "completed",
        providerSelection: providerRuntime.providerId || "gemini",
        metadata: {
          transport,
          turnCount,
          model,
        },
      });
      return {
        finalResponse: finalResponse || "Gemini SDK completed with no text output.",
        items: finalResponse
          ? [{ type: "text", text: finalResponse }]
          : [],
        usage: extractUsage(response),
      };
    } catch (err) {
      const retryable = isTransientStreamError(err) && retryAttempt < MAX_STREAM_RETRIES;
      if (retryable) {
        retryAttempt += 1;
        const delay = streamRetryDelay(retryAttempt);
        console.warn(
          `[gemini-shell] transient error (attempt ${retryAttempt}/${MAX_STREAM_RETRIES}): ${err.message || err} — retrying in ${Math.round(delay)}ms`,
        );
        await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
        continue;
      }
      geminiSessionCompat.failTurn(logicalSessionId, {
        activate: Boolean(activeSessionId || preferredSession),
        status: "failed",
        error: err?.message || String(err),
        providerSelection: providerRuntime.providerId || "gemini",
        model: providerRuntime.providerConfig?.model || resolveGeminiModel(options),
        metadata: {
          transport,
          turnCount,
        },
      });
      return {
        finalResponse: `:close: Gemini agent failed: ${err.message || String(err)}`,
        items: [],
        usage: null,
      };
    } finally {
      activeTurn = false;
    }
  }

  activeTurn = false;
  geminiSessionCompat.failTurn(logicalSessionId, {
    activate: Boolean(activeSessionId || preferredSession),
    status: "failed",
    error: "Gemini agent failed after all retry attempts.",
    providerSelection: providerRuntime.providerId || "gemini",
    model: providerRuntime.providerConfig?.model || resolveGeminiModel(options),
    metadata: {
      transport,
      turnCount,
    },
  });
  return {
    finalResponse: ":close: Gemini agent failed after all retry attempts.",
    items: [],
    usage: null,
  };
}

export async function steerGeminiPrompt() {
  return {
    ok: false,
    reason: activeTurn ? "steering_unsupported" : "idle",
    message: activeTurn
      ? "Gemini adapter does not support steering during active turns."
      : "No active Gemini turn.",
  };
}

export function isGeminiBusy() {
  return activeTurn;
}

export function getSessionInfo() {
  return geminiSessionCompat.getSessionInfo({
    sessionId: activeSessionId,
    turnCount,
    isActive: Boolean(activeSessionId),
    isBusy: activeTurn,
    transport: activeTransport,
  });
}

export function getActiveSessionId() {
  return geminiSessionCompat.getActiveSessionId();
}

export async function listSessions() {
  await loadState();
  return geminiSessionCompat.listSessions({
    extraSessions: activeSessionId
      ? [{
          id: activeSessionId,
          sessionId: activeSessionId,
          title: "Gemini Session",
          active: true,
          turnCount,
          status: "idle",
          metadata: {
            transport: activeTransport,
            turnCount,
          },
        }]
      : [],
  });
}

export async function switchSession(id) {
  await loadState();
  const next = String(id || "").trim();
  if (!next) return;
  activeSessionId = next;
  await saveState();
  return geminiSessionCompat.switchSession(next, {
    metadata: {
      transport: activeTransport,
      turnCount,
    },
  });
}

export async function createSession(id) {
  await loadState();
  const next = String(id || "").trim();
  if (!next) {
    throw new Error("session id required");
  }
  activeSessionId = next;
  turnCount = 0;
  await saveState();
  geminiSessionCompat.switchSession(next, {
    status: "idle",
    metadata: {
      transport: activeTransport,
      turnCount,
    },
  });
  return { id: next, sessionId: next };
}

export async function resetSession() {
  activeTurn = false;
  activeSessionId = null;
  turnCount = 0;
  activeTransport = "auto";
  geminiClient = null;
  geminiSessionCompat.reset({
    status: "idle",
    metadata: {
      transport: activeTransport,
      turnCount: 0,
    },
  });
  await saveState();
}

export async function initGeminiShell() {
  await loadState();
  if (envFlagEnabled(process.env.GEMINI_SDK_DISABLED)) return false;
  const transport = resolveGeminiTransport();
  activeTransport = transport;
  if (transport === "cli") return true;
  if (transport === "sdk") return ensureGeminiClient();
  const sdkReady = await ensureGeminiClient();
  return sdkReady || true;
}
