import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  truncateCompactedPreviewText,
  truncateCompactedToolOutput,
} from "../workspace/context-cache.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const DEFAULT_MAX_ITEM_CHARS = 4000;
const DEFAULT_PROCESS_TIMEOUT_MS = 60_000;
const DEFAULT_WATCH_TIMEOUT_MS = 2_000;
const DEFAULT_WATCH_POLL_MS = 50;
const DEFAULT_PROCESS_BUFFER_BYTES = 64 * 1024;
const DEFAULT_PROCESS_TAIL_BYTES = 12 * 1024;

const TEST_OVERRIDES = {
  execClient: null,
  telemetryClient: null,
  disableNative: false,
};

const DEFAULT_EXEC_STATUS = Object.freeze({
  service: "exec",
  mode: "javascript",
  transport: "in_process",
  available: true,
  reason: "javascript",
  requests: 0,
  truncateOps: 0,
  bufferOps: 0,
  processOps: 0,
  watchOps: 0,
  cancellations: 0,
  fallbacks: 0,
  nativeRequests: 0,
  nativeFailures: 0,
  nativeAvailable: false,
  nativeBinary: null,
  nativeVersion: null,
  droppedItems: 0,
  truncatedFields: 0,
  originalBytes: 0,
  retainedBytes: 0,
  bufferedItems: 0,
  retainedItems: 0,
  bufferNoticeCount: 0,
  lastRequestAt: null,
  lastSuccessAt: null,
  lastError: null,
});

const DEFAULT_TELEMETRY_STATUS = Object.freeze({
  service: "telemetry",
  mode: "javascript",
  transport: "in_process",
  available: true,
  reason: "javascript",
  requests: 0,
  appendOps: 0,
  exportOps: 0,
  resetOps: 0,
  appendedEvents: 0,
  exportedEvents: 0,
  nativeRequests: 0,
  nativeFailures: 0,
  nativeAvailable: false,
  nativeBinary: null,
  nativeVersion: null,
  fallbacks: 0,
  lastRequestAt: null,
  lastSuccessAt: null,
  lastError: null,
});

const execStatus = createStatus(DEFAULT_EXEC_STATUS);
const telemetryStatus = createStatus(DEFAULT_TELEMETRY_STATUS);

function createStatus(template) {
  return { ...template };
}

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

function toPositiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : fallback;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createAbortError(reason = "aborted") {
  const error = new Error(String(reason || "aborted"));
  error.name = "AbortError";
  return error;
}

function trimTailToBytes(text, maxBytes) {
  if (!(maxBytes > 0)) return "";
  const buffer = Buffer.from(String(text ?? ""), "utf8");
  if (buffer.length <= maxBytes) return buffer.toString("utf8");
  return buffer.subarray(buffer.length - maxBytes).toString("utf8");
}

class HeadTailTextBuffer {
  constructor(options = {}) {
    this.maxBytes = toPositiveInteger(options.maxBytes, DEFAULT_PROCESS_BUFFER_BYTES);
    this.tailBytes = Math.min(
      toPositiveInteger(options.tailBytes, DEFAULT_PROCESS_TAIL_BYTES),
      Math.max(1024, this.maxBytes - 1024),
    );
    this.headBudgetBytes = Math.max(1024, this.maxBytes - this.tailBytes);
    this.head = "";
    this.tail = "";
    this.originalBytes = 0;
    this.truncated = false;
    this.droppedBytes = 0;
  }

  push(chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
    if (!text) return;
    const bytes = byteLength(text);
    this.originalBytes += bytes;

    if (!this.truncated && byteLength(this.head) + bytes <= this.headBudgetBytes) {
      this.head += text;
      return;
    }

    this.truncated = true;
    this.droppedBytes += bytes;
    this.tail = trimTailToBytes(`${this.tail}${text}`, this.tailBytes);
  }

  snapshot() {
    const notice = this.truncated
      ? `\n...truncated ${this.droppedBytes} bytes...\n`
      : "";
    const text = this.truncated
      ? `${this.head}${notice}${this.tail}`
      : this.head;
    return {
      text,
      truncated: this.truncated,
      originalBytes: this.originalBytes,
      retainedBytes: byteLength(text),
      droppedBytes: this.droppedBytes,
      maxBytes: this.maxBytes,
    };
  }
}

class NativeJsonlService {
  constructor(kind, statusRef, options = {}) {
    this.kind = kind;
    this.statusRef = statusRef;
    this.envVar = options.envVar;
    this.binaryName = options.binaryName;
    this.child = null;
    this.buffer = "";
    this.requestSeq = 0;
    this.pending = new Map();
    this.exited = false;
  }

  resolveBinaryPath() {
    const explicit = toTrimmedString(process.env[this.envVar]);
    if (explicit && existsSync(explicit)) return explicit;
    const extension = process.platform === "win32" ? ".exe" : "";
    const candidates = [
      resolve(REPO_ROOT, "native", this.binaryName, "target", "release", `${this.binaryName}${extension}`),
      resolve(REPO_ROOT, "native", this.binaryName, "target", "debug", `${this.binaryName}${extension}`),
      resolve(REPO_ROOT, "target", "release", `${this.binaryName}${extension}`),
      resolve(REPO_ROOT, "target", "debug", `${this.binaryName}${extension}`),
    ];
    return candidates.find((candidate) => existsSync(candidate)) || null;
  }

  getTestClient() {
    return this.kind === "exec" ? TEST_OVERRIDES.execClient : TEST_OVERRIDES.telemetryClient;
  }

  describeAvailability() {
    const testClient = this.getTestClient();
    if (testClient) {
      return {
        available: true,
        binaryPath: "[test-double]",
        transport: "test-double",
        mode: "native",
      };
    }
    if (TEST_OVERRIDES.disableNative) {
      return {
        available: false,
        binaryPath: null,
        transport: "in_process",
        mode: "javascript",
      };
    }
    const binaryPath = this.resolveBinaryPath();
    return {
      available: Boolean(binaryPath),
      binaryPath,
      transport: binaryPath ? "stdio_jsonl" : "in_process",
      mode: binaryPath ? "native" : "javascript",
    };
  }

  async request(command, payload = {}, options = {}) {
    const testClient = this.getTestClient();
    if (testClient) {
      this.statusRef.nativeAvailable = true;
      this.statusRef.mode = "native";
      this.statusRef.transport = "test-double";
      this.statusRef.reason = "native";
      this.statusRef.nativeRequests += 1;
      const response = await testClient.request(command, payload, options);
      if (response?.version) {
        this.statusRef.nativeVersion = response.version;
      }
      return response;
    }

    if (TEST_OVERRIDES.disableNative) return null;

    const binaryPath = this.resolveBinaryPath();
    if (!binaryPath) {
      this.statusRef.nativeAvailable = false;
      return null;
    }

    this.statusRef.nativeAvailable = true;
    this.statusRef.nativeBinary = binaryPath;
    const child = this.ensureChild(binaryPath);
    if (!child) return null;

    const id = `${this.kind}-${Date.now()}-${++this.requestSeq}`;
    const timeoutMs = toPositiveInteger(options.timeoutMs, DEFAULT_PROCESS_TIMEOUT_MS);
    this.statusRef.nativeRequests += 1;

    return new Promise((resolve, reject) => {
      let timer = null;
      let abortCleanup = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (abortCleanup) abortCleanup();
        this.pending.delete(id);
      };

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          cleanup();
          this.statusRef.nativeFailures += 1;
          this.statusRef.lastError = `native_timeout:${command}`;
          reject(new Error(`native_timeout:${command}`));
        }, timeoutMs);
      }

      if (options.signal) {
        const onAbort = () => {
          cleanup();
          this.statusRef.cancellations = (this.statusRef.cancellations || 0) + 1;
          if (payload?.processId && this.kind === "exec") {
            void this.request("cancel_process", { processId: payload.processId }, { timeoutMs: 500 }).catch(() => {});
          }
          reject(createAbortError(options.signal.reason || "aborted"));
        };
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
        abortCleanup = () => options.signal.removeEventListener("abort", onAbort);
      }

      this.pending.set(id, {
        resolve: (response) => {
          cleanup();
          resolve(response);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });

      try {
        child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`);
      } catch (error) {
        cleanup();
        this.statusRef.nativeFailures += 1;
        this.statusRef.lastError = String(error?.message || error);
        reject(error);
      }
    });
  }

  ensureChild(binaryPath) {
    if (this.child && !this.exited) return this.child;
    try {
      const child = spawn(binaryPath, [], {
        cwd: REPO_ROOT,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => this.handleStdout(chunk));
      child.stderr?.setEncoding?.("utf8");
      child.stderr?.on?.("data", (chunk) => {
        const text = toTrimmedString(chunk);
        if (text) {
          this.statusRef.lastError = text;
        }
      });
      child.on("exit", () => {
        this.exited = true;
        this.child = null;
        const pending = [...this.pending.values()];
        this.pending.clear();
        for (const entry of pending) {
          entry.reject(new Error(`${this.kind}_native_exited`));
        }
      });
      this.child = child;
      this.exited = false;
      this.statusRef.mode = "native";
      this.statusRef.transport = "stdio_jsonl";
      this.statusRef.reason = "native";
      return child;
    } catch (error) {
      this.statusRef.nativeFailures += 1;
      this.statusRef.lastError = String(error?.message || error);
      this.child = null;
      this.exited = true;
      return null;
    }
  }

  handleStdout(chunk) {
    this.buffer += String(chunk ?? "");
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex < 0) break;
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) continue;
      let payload = null;
      try {
        payload = JSON.parse(line);
      } catch (error) {
        this.statusRef.nativeFailures += 1;
        this.statusRef.lastError = `invalid_native_json:${error?.message || error}`;
        continue;
      }
      const id = toTrimmedString(payload?.id);
      if (!id) continue;
      const pending = this.pending.get(id);
      if (!pending) continue;
      if (payload?.ok === false) {
        this.statusRef.nativeFailures += 1;
        this.statusRef.lastError = String(payload?.error || `${this.kind}_native_error`);
        pending.reject(new Error(this.statusRef.lastError));
        continue;
      }
      if (payload?.version) {
        this.statusRef.nativeVersion = payload.version;
      }
      pending.resolve(payload);
    }
  }

  resetForTests() {
    if (this.child && !this.exited) {
      try {
        this.child.kill();
      } catch {
        // best effort
      }
    }
    this.child = null;
    this.buffer = "";
    this.pending.clear();
    this.exited = false;
  }
}

const execNativeService = new NativeJsonlService("exec", execStatus, {
  envVar: "BOSUN_NATIVE_EXEC_BIN",
  binaryName: "bosun-unified-exec",
});

const telemetryNativeService = new NativeJsonlService("telemetry", telemetryStatus, {
  envVar: "BOSUN_NATIVE_TELEMETRY_BIN",
  binaryName: "bosun-telemetry",
});

export function cloneHotPathValue(value) {
  if (value == null) return value ?? null;
  if (typeof value !== "object") return value;
  if (Array.isArray(value) || isPlainObject(value)) {
    try {
      return clonePlainValue(value, new WeakMap());
    } catch {
      // Fall through to generic cloning for unexpected edge cases.
    }
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // Fall back to JSON cloning for plain telemetry payloads.
    }
  }
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clonePlainValue(value, seen) {
  if (value == null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const next = new Array(value.length);
    seen.set(value, next);
    for (let index = 0; index < value.length; index += 1) {
      next[index] = clonePlainValue(value[index], seen);
    }
    return next;
  }
  const next = {};
  seen.set(value, next);
  for (const [key, entry] of Object.entries(value)) {
    next[key] = clonePlainValue(entry, seen);
  }
  return next;
}

function markStatusRequest(status) {
  status.requests += 1;
  status.lastRequestAt = nowIso();
}

function markStatusSuccess(status, reason = status.reason) {
  status.reason = reason;
  status.lastSuccessAt = nowIso();
}

function markStatusFallback(status, reason = "javascript") {
  status.mode = "javascript";
  status.transport = "in_process";
  status.reason = reason;
  status.fallbacks += 1;
}

function recordTextTruncation(originalText, truncatedText) {
  execStatus.originalBytes += byteLength(originalText);
  execStatus.retainedBytes += byteLength(truncatedText);
}

function truncateTextValue(text, maxChars) {
  if (typeof text !== "string") return text;
  const truncated = truncateCompactedPreviewText(text, { maxChars });
  if (truncated.truncated) {
    recordTextTruncation(text, truncated.text);
    execStatus.truncatedFields += 1;
  }
  return truncated.text;
}

function truncateBufferedItem(item, maxItemChars) {
  if (!item || typeof item !== "object") return item;
  if (!Number.isFinite(maxItemChars) || maxItemChars < 1) return cloneHotPathValue(item);

  const next = cloneHotPathValue(item);
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
      next[key] = truncateTextValue(next[key], maxItemChars);
    }
  }

  if (Array.isArray(next.content)) {
    next.content = next.content.map((entry) => {
      if (entry && typeof entry === "object" && typeof entry.text === "string") {
        return { ...entry, text: truncateTextValue(entry.text, maxItemChars) };
      }
      return entry;
    });
  }

  if (next.error && typeof next.error === "object" && typeof next.error.message === "string") {
    next.error = {
      ...next.error,
      message: truncateTextValue(next.error.message, maxItemChars),
    };
  }

  return next;
}

async function requestExecNative(command, payload = {}, options = {}) {
  if (options.preferNative === false) return null;
  return execNativeService.request(command, payload, options);
}

async function requestTelemetryNative(command, payload = {}, options = {}) {
  if (options.preferNative === false) return null;
  return telemetryNativeService.request(command, payload, options);
}

function normalizeNativeTruncateResponse(payload, output) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.result && typeof payload.result === "object") {
    return cloneHotPathValue(payload.result);
  }
  if (payload.preview || payload.data) {
    return {
      format: typeof output === "string" ? "text" : "json",
      data: payload.data ?? output,
      preview: payload.preview ?? String(output ?? ""),
      truncated: Boolean(payload.truncated),
      originalChars: Number(payload.originalChars || 0),
      retainedChars: Number(payload.retainedChars || 0),
      originalBytes: Number(payload.originalBytes || 0),
      retainedBytes: Number(payload.retainedBytes || 0),
    };
  }
  return null;
}

export async function truncateWithBosunHotPathExec(output, truncation = {}) {
  markStatusRequest(execStatus);
  execStatus.truncateOps += 1;
  try {
    const native = await requestExecNative("truncate_output", {
      output,
      truncation,
    }, {
      timeoutMs: truncation.timeoutMs,
      signal: truncation.signal,
    });
    const normalized = normalizeNativeTruncateResponse(native, output);
    if (normalized) {
      execStatus.originalBytes += Number(normalized.originalBytes || 0);
      execStatus.retainedBytes += Number(normalized.retainedBytes || 0);
      markStatusSuccess(execStatus, "native");
      return normalized;
    }
  } catch (error) {
    execStatus.nativeFailures += 1;
    execStatus.lastError = String(error?.message || error);
  }

  markStatusFallback(execStatus, "javascript");
  const truncated = truncateCompactedToolOutput(output, truncation);
  execStatus.originalBytes += Number(truncated.originalBytes || 0);
  execStatus.retainedBytes += Number(truncated.retainedBytes || 0);
  markStatusSuccess(execStatus, "javascript");
  return truncated;
}

export async function bufferItemsWithBosunHotPathExec(items = [], limits = {}) {
  markStatusRequest(execStatus);
  execStatus.bufferOps += 1;
  const sourceItems = Array.isArray(items) ? items : [];
  const maxItems = toPositiveInteger(limits.maxItems, sourceItems.length || 1);
  const maxItemChars = toPositiveInteger(limits.maxItemChars, DEFAULT_MAX_ITEM_CHARS);
  const initialDroppedItems = Math.max(0, Math.trunc(Number(limits.droppedItems) || 0));

  try {
    const native = await requestExecNative("buffer_items", {
      items: sourceItems,
      limits: {
        maxItems,
        maxItemChars,
        droppedItems: initialDroppedItems,
      },
    }, {
      timeoutMs: limits.timeoutMs,
      signal: limits.signal,
    });
    if (native && Array.isArray(native.items)) {
      execStatus.bufferedItems += sourceItems.length;
      execStatus.retainedItems += native.items.length;
      execStatus.droppedItems += Number(native.droppedItems || 0);
      if (native.notice) {
        execStatus.bufferNoticeCount += 1;
      }
      markStatusSuccess(execStatus, "native");
      return {
        ok: true,
        items: cloneHotPathValue(native.items),
        droppedItems: Number(native.droppedItems || 0),
        notice: native.notice ? cloneHotPathValue(native.notice) : null,
      };
    }
  } catch (error) {
    execStatus.nativeFailures += 1;
    execStatus.lastError = String(error?.message || error);
  }

  markStatusFallback(execStatus, "javascript");
  const retainedItems = sourceItems
    .slice(0, maxItems)
    .map((item) => truncateBufferedItem(item, maxItemChars));
  const droppedItems = initialDroppedItems + Math.max(0, sourceItems.length - retainedItems.length);
  const notice = droppedItems > 0
    ? {
        type: "stream_notice",
        text: `Dropped ${droppedItems} completed items to stay within INTERNAL_EXECUTOR_STREAM_MAX_ITEMS_PER_TURN=${maxItems}.`,
      }
    : null;

  execStatus.bufferedItems += sourceItems.length;
  execStatus.retainedItems += retainedItems.length;
  execStatus.droppedItems += droppedItems;
  if (notice) {
    execStatus.bufferNoticeCount += 1;
  }
  markStatusSuccess(execStatus, "javascript");
  return {
    ok: true,
    items: retainedItems,
    droppedItems,
    notice,
  };
}

async function runProcessFallback(request = {}, options = {}) {
  const command = toTrimmedString(request.command);
  if (!command) {
    throw new Error("command is required");
  }
  const args = Array.isArray(request.args) ? request.args.map((entry) => String(entry)) : [];
  const cwd = toTrimmedString(request.cwd) || REPO_ROOT;
  const processId = toTrimmedString(request.processId) || `proc-${Date.now()}`;
  const timeoutMs = toPositiveInteger(
    options.timeoutMs ?? request.timeoutMs,
    DEFAULT_PROCESS_TIMEOUT_MS,
  );
  const stdoutBuffer = new HeadTailTextBuffer({
    maxBytes: toPositiveInteger(request.maxBufferBytes, DEFAULT_PROCESS_BUFFER_BYTES),
    tailBytes: toPositiveInteger(request.tailBufferBytes, DEFAULT_PROCESS_TAIL_BYTES),
  });
  const stderrBuffer = new HeadTailTextBuffer({
    maxBytes: toPositiveInteger(request.maxBufferBytes, DEFAULT_PROCESS_BUFFER_BYTES),
    tailBytes: toPositiveInteger(request.tailBufferBytes, DEFAULT_PROCESS_TAIL_BYTES),
  });

  return await new Promise((resolve, reject) => {
    const startedAt = performance.now();
    let timeoutId = null;
    let settled = false;
    let cancelled = false;
    let timedOut = false;
    let child = null;
    let abortHandler = null;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (options.signal && abortHandler) {
        options.signal.removeEventListener("abort", abortHandler);
      }
    };

    const finalize = (payload) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(payload);
    };

    try {
      child = spawn(command, args, {
        cwd,
        env: {
          ...process.env,
          ...(isPlainObject(request.env) ? request.env : {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      cleanup();
      reject(error);
      return;
    }

    if (request.stdin != null) {
      child.stdin.write(String(request.stdin));
    }
    child.stdin.end();

    child.stdout.on("data", (chunk) => stdoutBuffer.push(chunk));
    child.stderr.on("data", (chunk) => stderrBuffer.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      cleanup();
      reject(error);
    });
    child.on("close", (code, signalName) => {
      const durationMs = Number((performance.now() - startedAt).toFixed(2));
      finalize({
        ok: true,
        processId,
        exitCode: Number.isFinite(Number(code)) ? Number(code) : null,
        signal: signalName || null,
        cancelled,
        timedOut,
        durationMs,
        stdout: stdoutBuffer.snapshot().text,
        stderr: stderrBuffer.snapshot().text,
        buffer: {
          stdout: stdoutBuffer.snapshot(),
          stderr: stderrBuffer.snapshot(),
        },
      });
    });

    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        try {
          child.kill();
        } catch {
          // best effort
        }
      }, timeoutMs);
    }

    if (options.signal) {
      abortHandler = () => {
        cancelled = true;
        try {
          child.kill();
        } catch {
          // best effort
        }
      };
      if (options.signal.aborted) {
        abortHandler();
      } else {
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }
    }
  });
}

export async function runProcessWithBosunHotPathExec(request = {}, options = {}) {
  markStatusRequest(execStatus);
  execStatus.processOps += 1;
  const processId = toTrimmedString(request.processId) || `proc-${Date.now()}`;
  try {
    const native = await requestExecNative("run_process", {
      processId,
      command: request.command,
      args: Array.isArray(request.args) ? request.args : [],
      cwd: request.cwd || null,
      env: isPlainObject(request.env) ? request.env : {},
      stdin: request.stdin ?? null,
      timeoutMs: request.timeoutMs ?? options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS,
      maxBufferBytes: request.maxBufferBytes ?? DEFAULT_PROCESS_BUFFER_BYTES,
      tailBufferBytes: request.tailBufferBytes ?? DEFAULT_PROCESS_TAIL_BYTES,
    }, {
      timeoutMs: options.timeoutMs ?? request.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS,
      signal: options.signal,
    });
    if (native && typeof native === "object" && native.processId) {
      if (native.cancelled) execStatus.cancellations += 1;
      markStatusSuccess(execStatus, "native");
      return cloneHotPathValue(native);
    }
  } catch (error) {
    execStatus.nativeFailures += 1;
    execStatus.lastError = String(error?.message || error);
  }

  markStatusFallback(execStatus, "javascript");
  const result = await runProcessFallback({ ...request, processId }, options);
  if (result.cancelled) execStatus.cancellations += 1;
  execStatus.originalBytes += Number(result.buffer?.stdout?.originalBytes || 0);
  execStatus.originalBytes += Number(result.buffer?.stderr?.originalBytes || 0);
  execStatus.retainedBytes += Number(result.buffer?.stdout?.retainedBytes || 0);
  execStatus.retainedBytes += Number(result.buffer?.stderr?.retainedBytes || 0);
  markStatusSuccess(execStatus, "javascript");
  return result;
}

function readWatchStamp(path) {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

async function watchPathsFallback(request = {}, options = {}) {
  const paths = Array.isArray(request.paths)
    ? request.paths.map((entry) => toTrimmedString(entry)).filter(Boolean)
    : [];
  if (!paths.length) {
    throw new Error("paths is required");
  }
  const timeoutMs = toPositiveInteger(
    options.timeoutMs ?? request.timeoutMs,
    DEFAULT_WATCH_TIMEOUT_MS,
  );
  const pollMs = toPositiveInteger(request.pollMs, DEFAULT_WATCH_POLL_MS);
  const startedAt = performance.now();
  const baseline = new Map(paths.map((entry) => [entry, readWatchStamp(entry)]));

  while ((performance.now() - startedAt) < timeoutMs) {
    if (options.signal?.aborted) {
      throw createAbortError(options.signal.reason || "aborted");
    }
    const changedPaths = paths.filter((entry) => readWatchStamp(entry) !== baseline.get(entry));
    if (changedPaths.length > 0) {
      return {
        ok: true,
        changed: true,
        changedPaths,
        timedOut: false,
        durationMs: Number((performance.now() - startedAt).toFixed(2)),
      };
    }
    await wait(pollMs);
  }

  return {
    ok: true,
    changed: false,
    changedPaths: [],
    timedOut: true,
    durationMs: Number((performance.now() - startedAt).toFixed(2)),
  };
}

export async function watchPathsWithBosunHotPathExec(request = {}, options = {}) {
  markStatusRequest(execStatus);
  execStatus.watchOps += 1;
  try {
    const native = await requestExecNative("watch_paths", {
      paths: Array.isArray(request.paths) ? request.paths : [],
      timeoutMs: request.timeoutMs ?? options.timeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS,
      pollMs: request.pollMs ?? DEFAULT_WATCH_POLL_MS,
    }, {
      timeoutMs: request.timeoutMs ?? options.timeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS,
      signal: options.signal,
    });
    if (native && typeof native === "object" && Array.isArray(native.changedPaths)) {
      markStatusSuccess(execStatus, "native");
      return cloneHotPathValue(native);
    }
  } catch (error) {
    execStatus.nativeFailures += 1;
    execStatus.lastError = String(error?.message || error);
  }

  markStatusFallback(execStatus, "javascript");
  const result = await watchPathsFallback(request, options);
  markStatusSuccess(execStatus, "javascript");
  return result;
}

export async function appendEventsWithBosunHotPathTelemetry(events = [], options = {}) {
  markStatusRequest(telemetryStatus);
  telemetryStatus.appendOps += 1;
  const normalizedEvents = Array.isArray(events) ? events : [];
  try {
    const native = await requestTelemetryNative("append_events", {
      events: normalizedEvents,
      maxInMemoryEvents: options.maxInMemoryEvents,
    }, {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    if (native && typeof native === "object") {
      telemetryStatus.appendedEvents += normalizedEvents.length;
      markStatusSuccess(telemetryStatus, "native");
      return cloneHotPathValue(native);
    }
  } catch (error) {
    telemetryStatus.nativeFailures += 1;
    telemetryStatus.lastError = String(error?.message || error);
  }

  markStatusFallback(telemetryStatus, "javascript");
  telemetryStatus.appendedEvents += normalizedEvents.length;
  markStatusSuccess(telemetryStatus, "javascript");
  return {
    ok: true,
    service: "bosun-telemetry",
    accepted: normalizedEvents.length,
    eventCount: normalizedEvents.length,
  };
}

export async function exportTraceWithBosunHotPathTelemetry(filter = {}, options = {}) {
  markStatusRequest(telemetryStatus);
  telemetryStatus.exportOps += 1;
  try {
    const native = await requestTelemetryNative("export_trace", {
      filter,
    }, {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    if (native && typeof native === "object") {
      telemetryStatus.exportedEvents += Array.isArray(native?.trace?.traceEvents)
        ? native.trace.traceEvents.length
        : 0;
      markStatusSuccess(telemetryStatus, "native");
      return cloneHotPathValue(native.trace ?? native);
    }
  } catch (error) {
    telemetryStatus.nativeFailures += 1;
    telemetryStatus.lastError = String(error?.message || error);
  }

  markStatusFallback(telemetryStatus, "javascript");
  markStatusSuccess(telemetryStatus, "javascript");
  return null;
}

export async function flushBosunHotPathTelemetry(options = {}) {
  if (TEST_OVERRIDES.telemetryClient?.flush) {
    await TEST_OVERRIDES.telemetryClient.flush(options);
    return;
  }
  try {
    await requestTelemetryNative("flush", {}, {
      timeoutMs: options.timeoutMs || 1_000,
      preferNative: options.preferNative,
    });
  } catch {
    // best effort
  }
}

export async function resetBosunHotPathTelemetryForTests() {
  telemetryStatus.resetOps += 1;
  if (TEST_OVERRIDES.telemetryClient?.reset) {
    await TEST_OVERRIDES.telemetryClient.reset();
    return;
  }
  try {
    await requestTelemetryNative("reset", {}, { timeoutMs: 500 });
  } catch {
    // best effort
  }
}

export function getBosunHotPathStatus() {
  const execAvailability = execNativeService.describeAvailability();
  const telemetryAvailability = telemetryNativeService.describeAvailability();
  if (!execStatus.nativeAvailable && execAvailability.available) {
    execStatus.nativeAvailable = true;
    execStatus.nativeBinary = execAvailability.binaryPath;
  }
  if (!telemetryStatus.nativeAvailable && telemetryAvailability.available) {
    telemetryStatus.nativeAvailable = true;
    telemetryStatus.nativeBinary = telemetryAvailability.binaryPath;
  }
  return {
    mode:
      execStatus.mode === "native"
      || telemetryStatus.mode === "native"
      || execAvailability.mode === "native"
      || telemetryAvailability.mode === "native"
        ? "native"
        : "javascript",
    exec: cloneHotPathValue(execStatus),
    telemetry: cloneHotPathValue(telemetryStatus),
  };
}

export function configureBosunHotPathRuntimeForTests(overrides = {}) {
  if (Object.prototype.hasOwnProperty.call(overrides, "execClient")) {
    TEST_OVERRIDES.execClient = overrides.execClient || null;
  }
  if (Object.prototype.hasOwnProperty.call(overrides, "telemetryClient")) {
    TEST_OVERRIDES.telemetryClient = overrides.telemetryClient || null;
  }
  if (Object.prototype.hasOwnProperty.call(overrides, "disableNative")) {
    TEST_OVERRIDES.disableNative = overrides.disableNative === true;
  }
}

export function resetBosunHotPathRuntimeForTests(options = {}) {
  const resetExec = options.exec !== false;
  const resetTelemetry = options.telemetry !== false;

  if (resetExec) {
    const next = createStatus(DEFAULT_EXEC_STATUS);
    for (const key of Object.keys(execStatus)) {
      execStatus[key] = next[key];
    }
    execNativeService.resetForTests();
  }

  if (resetTelemetry) {
    const next = createStatus(DEFAULT_TELEMETRY_STATUS);
    for (const key of Object.keys(telemetryStatus)) {
      telemetryStatus[key] = next[key];
    }
    telemetryNativeService.resetForTests();
  }

  TEST_OVERRIDES.execClient = null;
  TEST_OVERRIDES.telemetryClient = null;
  TEST_OVERRIDES.disableNative = false;
}

export default {
  appendEventsWithBosunHotPathTelemetry,
  bufferItemsWithBosunHotPathExec,
  cloneHotPathValue,
  configureBosunHotPathRuntimeForTests,
  exportTraceWithBosunHotPathTelemetry,
  flushBosunHotPathTelemetry,
  getBosunHotPathStatus,
  resetBosunHotPathRuntimeForTests,
  resetBosunHotPathTelemetryForTests,
  runProcessWithBosunHotPathExec,
  truncateWithBosunHotPathExec,
  watchPathsWithBosunHotPathExec,
};
