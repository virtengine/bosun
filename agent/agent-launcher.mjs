// CLAUDE:SUMMARY — agent-launcher
// Resolves SDK selection and fallback order for ephemeral agent threads,
// including env/config-driven failover and launch orchestration across Codex,
// Copilot, Claude, and compatible adapters.

/**
 * agent-launcher.mjs — Canonical SDK launcher and retry transport
 *
 * Canonical architecture note:
 * This module owns bounded launcher concerns only: SDK selection, slot
 * scheduling, ephemeral thread launch transport, and legacy retry transport.
 * It must not become a second lifecycle/control-plane owner. Session lineage,
 * replay, and subagent state remain canonical in `session-manager.mjs`,
 * `thread-registry.mjs`, `subagent-control.mjs`, and `agent/harness/*`.
 *
 * WHY THIS EXISTS:
 * ────────────────
 * The primary agent in monitor.mjs is a long-lived singleton thread.
 * Every operation that calls `execPrimaryPrompt` serialises behind that single
 * thread — task attempts, conflict resolution, follow-ups, and health-checks
 * all compete for the same lock.  Under load (or when a single prompt is
 * slow) this creates a bottleneck that stalls the entire monitor pipeline.
 *
 * This module provides **ephemeral, per-operation SDK threads** that spin up
 * on demand and tear down after a single prompt completes.  Each call gets its
 * own isolated thread, so multiple operations can run concurrently without
 * blocking each other.
 *
 * MULTI-SDK SUPPORT:
 * ──────────────────
 * The pool dynamically selects the correct SDK adapter (Codex, Copilot, or
 * Claude) based on configuration.  Resolution order:
 *   1. `AGENT_POOL_SDK` env var (explicit override)
 *   2. `PRIMARY_AGENT` env var → maps to SDK
 *   3. `loadConfig().agentPool.sdk` from `bosun.config.json`
 *   4. Fallback chain through available SDKs
 *
 * EXPORTS:
 *   launchEphemeralThread(prompt, cwd, timeoutMs, extra?)
 *     → Low-level: spawns a fresh SDK thread, runs one prompt,
 *       returns { success, output, items, error, sdk }.
 *
 *   execPooledPrompt(userMessage, options?)
 *     → High-level: matches the execPrimaryPrompt signature
 *       ({ finalResponse, items, usage }) so callers in monitor.mjs can
 *       swap in without changing surrounding code.
 *
 *   getPoolSdkName()     → returns current pool SDK name
 *   setPoolSdk(name)     → override pool SDK at runtime
 *   resetPoolSdkCache()  → force re-resolution
 *   getAvailableSdks()   → returns list of non-disabled SDKs
 */

import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import "../infra/windows-hidden-child-processes.mjs";
import { loadConfig } from "../config/config.mjs";
import { resolveAgentSdkModuleEntry, resolveCodexSdkInstall } from "./agent-sdk.mjs";
import { buildProviderKernelSettings, createProviderKernel } from "./provider-kernel.mjs";
import { createProviderRegistry } from "./provider-registry.mjs";
import { readHarnessExecutorFabric } from "./harness-executor-config.mjs";
import { resolveRepoRoot, resolveAgentRepoRoot } from "../config/repo-root.mjs";
import { resolveCodexProfileRuntime, readCodexConfigRuntimeDefaults } from "../shell/codex-model-profiles.mjs";
import { buildTaskWritableRoots } from "../shell/codex-config.mjs";
import {
  importCopilotSdkModuleWithCompat,
  resolveCopilotSdkAuthOptions,
  resolveCopilotCliLaunchConfig,
} from "../shell/copilot-shell.mjs";
import openaiNativeAdapter from "../shell/openai-native-adapter.mjs";
import { getGitHubToken } from "../github/github-auth-manager.mjs";
import {
  isTransientStreamError,
  streamRetryDelay,
  MAX_STREAM_RETRIES,
} from "../infra/stream-resilience.mjs";
import {
  maybeCompressSessionItems,
  normalizeContextShreddingSessionType,
} from "../workspace/context-cache.mjs";
import { compileInternalHarnessProfile } from "./internal-harness-profile.mjs";
import {
  createHarnessProviderSessionRuntime,
  planPersistentThreadExecution,
} from "./internal-harness-control-plane.mjs";
import {
  buildInternalHarnessTurnExecutor,
  createInternalHarnessSession as createHarnessRuntimeSession,
} from "./internal-harness-runtime.mjs";
import { buildHarnessCompileOptions } from "./harness/runtime-config.mjs";
import {
  createCompiledHarnessSession as createManagedCompiledHarnessSession,
  getBosunSessionManager,
  createHarnessSession as createManagedHarnessSession,
  runCompiledHarnessSession as runManagedCompiledHarnessSession,
  runHarnessSession as runManagedHarnessSession,
} from "./session-manager.mjs";
import {
  addActiveSessionListener as addManagedActiveSessionListener,
  getActiveSessions as getManagedActiveSessions,
  hasActiveSession as hasManagedActiveSession,
  registerActiveSession as registerManagedActiveSession,
  steerActiveThread as steerManagedActiveThread,
  unregisterActiveSession as unregisterManagedActiveSession,
} from "./subagent-control.mjs";
import {
  clearThreadRegistry as clearManagedThreadRegistry,
  deleteThreadRecord as deleteManagedThreadRecord,
  ensureThreadRegistryLoaded as ensureManagedThreadRegistryLoaded,
  getActiveThreads as getManagedActiveThreads,
  getThreadRecord as getManagedThreadRecord,
  invalidateThread as invalidateManagedThread,
  invalidateThreadAsync as invalidateManagedThreadAsync,
  MAX_THREAD_TURNS,
  pruneAllExhaustedThreads as pruneManagedAllExhaustedThreads,
  setThreadRecord as setManagedThreadRecord,
  sdkSupportsPersistentThreads,
  THREAD_MAX_ABSOLUTE_AGE_MS,
  THREAD_MAX_AGE_MS,
} from "./thread-registry.mjs";
import {
  bufferItemsWithBosunHotPathExec,
  getBosunHotPathStatus,
} from "../lib/hot-path-runtime.mjs";

// Upper bound for externally supplied harness timeouts to avoid unbounded runs.
const MAX_HARNESS_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

// Lazy-load MCP registry to avoid circular dependencies.
// Cached at module scope per AGENTS.md hard rules.
let _mcpRegistry = null;
async function getMcpRegistry() {
  if (!_mcpRegistry) {
    _mcpRegistry = await import("../workflow/mcp-registry.mjs");
  }
  return _mcpRegistry;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Repository root for the active workspace.
 * Uses lazy resolution so workspace config changes are picked up per-call.
 * Prefers workspace-aware agent root over raw REPO_ROOT.
 */
let _cachedRepoRoot = null;
function getAgentRepoRoot() {
  if (!_cachedRepoRoot) {
    _cachedRepoRoot = resolveAgentRepoRoot();
  }
  return _cachedRepoRoot;
}
/** @deprecated Use getAgentRepoRoot() — kept for backward compat */
const REPO_ROOT = resolveAgentRepoRoot();

/** Default timeout: 6 hours — agents should run until the stream-based watchdog detects real issues */
const DEFAULT_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/**
 * Hard timeout buffer: added on top of the soft timeout.
 * If the SDK's async iterator ignores the AbortSignal, this hard timeout
 * forcibly breaks the Promise.race to prevent infinite hangs.
 */
const HARD_TIMEOUT_BUFFER_MS = 5 * 60_000; // 5 minutes

/** Tag for console logging */
const TAG = "[agent-pool]";
const DEFAULT_AGENT_EXECUTION_MAX_PARALLEL = 3;
const require = createRequire(import.meta.url);
const CODEX_SDK_SPECIFIER = "@openai/codex-sdk";
const MODULE_PRESENCE_CACHE = new Map();
const activeAgentExecutionSlots = new Map();
const queuedAgentExecutionSlots = [];

function resolveCodexWindowsRuntime() {
  if (process.platform !== "win32") {
    return { supported: false, packageName: null, binaryPath: null };
  }

  const runtimeMap = {
    x64: {
      packageName: "@openai/codex-win32-x64",
      binaryParts: ["vendor", "x86_64-pc-windows-msvc", "codex", "codex.exe"],
    },
    arm64: {
      packageName: "@openai/codex-win32-arm64",
      binaryParts: ["vendor", "aarch64-pc-windows-msvc", "codex", "codex.exe"],
    },
  };

  const runtimeInfo = runtimeMap[process.arch];
  if (!runtimeInfo) {
    return { supported: false, packageName: null, binaryPath: null };
  }

  try {
    const runtimePkgJson = require.resolve(`${runtimeInfo.packageName}/package.json`);
    return {
      supported: true,
      packageName: runtimeInfo.packageName,
      binaryPath: resolve(dirname(runtimePkgJson), ...runtimeInfo.binaryParts),
    };
  } catch {
    return {
      supported: true,
      packageName: runtimeInfo.packageName,
      binaryPath: null,
    };
  }
}

function getCodexRuntimePrerequisiteFailure() {
  const runtime = resolveCodexWindowsRuntime();
  if (!runtime.supported) return null;
  if (!runtime.binaryPath) {
    return `${runtime.packageName} not installed`;
  }
  if (!existsSync(runtime.binaryPath)) {
    return `Codex SDK runtime missing at ${runtime.binaryPath}`;
  }
  return null;
}

function isDeterministicSdkFailure(errorValue) {
  const message = String(errorValue || "").toLowerCase();
  if (!message) return false;
  if (message.includes("failed to list models") && message.includes("400")) {
    return true;
  }
  if (message.includes("enoent")) return true;
  if (message.includes("sdk runtime missing")) return true;
  if (message.includes("sdk not available")) return true;
  if (message.includes("not installed")) return true;
  return false;
}

function parsePositiveInt(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(1, Math.trunc(parsed));
}

function resolveAgentExecutionMaxParallel(explicit = null) {
  const direct = parsePositiveInt(explicit);
  if (direct) return direct;
  const envValue =
    parsePositiveInt(process.env.AGENT_POOL_MAX_PARALLEL) ||
    parsePositiveInt(process.env.WORKFLOW_AGENT_MAX_PARALLEL);
  if (envValue) return envValue;
  try {
    const cfg = loadConfig();
    const configValue =
      parsePositiveInt(cfg?.agentPool?.maxParallel) ||
      parsePositiveInt(cfg?.internalExecutor?.maxParallel);
    if (configValue) return configValue;
  } catch {
    // Best-effort only; fall back to a safe default.
  }
  return DEFAULT_AGENT_EXECUTION_MAX_PARALLEL;
}

function summarizeAgentSlotMeta(meta = {}) {
  if (!meta || typeof meta !== "object") return {};
  const summary = {};
  const scalarKeys = [
    "taskKey",
    "taskId",
    "taskTitle",
    "workflowRunId",
    "workflowId",
    "workflowName",
    "workflowNodeId",
    "workflowNodeLabel",
    "cwd",
    "sdk",
    "model",
    "sessionType",
  ];
  for (const key of scalarKeys) {
    const value = meta[key];
    if (value == null) continue;
    const normalized = String(value).trim();
    if (normalized) summary[key] = normalized;
  }
  return summary;
}

function toPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : {};
}

function emitAgentSlotHook(hook, payload) {
  if (typeof hook !== "function") return;
  try {
    hook(payload);
  } catch {
    // Slot telemetry must never break agent execution.
  }
}

function buildAgentSlotSnapshot(overrides = {}) {
  const maxParallel = resolveAgentExecutionMaxParallel(overrides.maxParallel);
  return {
    maxParallel,
    activeSlots: activeAgentExecutionSlots.size,
    queuedSlots: queuedAgentExecutionSlots.length,
    ...overrides,
  };
}

function grantQueuedAgentExecutionSlot(request) {
  const grantedAt = Date.now();
  const lease = {
    slotId: request.slotId,
    ownerKey: request.ownerKey,
    requestedAt: request.requestedAt,
    queuedAt: request.queuedAt,
    acquiredAt: grantedAt,
    waitedMs: Math.max(0, grantedAt - request.requestedAt),
    maxParallel: request.maxParallel,
    meta: request.meta,
    onReleased: request.onReleased,
  };
  activeAgentExecutionSlots.set(lease.slotId, lease);
  const payload = buildAgentSlotSnapshot({
    slotId: lease.slotId,
    ownerKey: lease.ownerKey,
    queuedAt: lease.queuedAt,
    acquiredAt: lease.acquiredAt,
    requestedAt: lease.requestedAt,
    waitedMs: lease.waitedMs,
    maxParallel: lease.maxParallel,
    meta: lease.meta,
  });
  emitAgentSlotHook(request.onAcquired, payload);
  request.resolve(lease);
}

function pumpQueuedAgentExecutionSlots() {
  while (queuedAgentExecutionSlots.length > 0) {
    const next = queuedAgentExecutionSlots[0];
    const maxParallel = resolveAgentExecutionMaxParallel(next.maxParallel);
    if (activeAgentExecutionSlots.size >= maxParallel) break;
    queuedAgentExecutionSlots.shift();
    grantQueuedAgentExecutionSlot(next);
  }
}

export function getAvailableSlots(maxParallel = null) {
  return Math.max(
    0,
    resolveAgentExecutionMaxParallel(maxParallel) - activeAgentExecutionSlots.size,
  );
}

export function getAgentExecutionSlotStatus() {
  return {
    maxParallel: resolveAgentExecutionMaxParallel(),
    activeSlots: activeAgentExecutionSlots.size,
    queuedSlots: queuedAgentExecutionSlots.length,
    active: Array.from(activeAgentExecutionSlots.values()).map((lease) => ({
      slotId: lease.slotId,
      ownerKey: lease.ownerKey,
      requestedAt: lease.requestedAt,
      queuedAt: lease.queuedAt,
      acquiredAt: lease.acquiredAt,
      waitedMs: lease.waitedMs,
      maxParallel: lease.maxParallel,
      meta: { ...lease.meta },
    })),
    queued: queuedAgentExecutionSlots.map((request) => ({
      slotId: request.slotId,
      ownerKey: request.ownerKey,
      requestedAt: request.requestedAt,
      queuedAt: request.queuedAt,
      maxParallel: request.maxParallel,
      meta: { ...request.meta },
    })),
  };
}

export async function allocateSlot(ownerKey = "", options = {}) {
  const normalizedOwnerKey =
    String(
      ownerKey ||
      options.taskKey ||
      options.taskId ||
      options.workflowRunId ||
      options.workflowId ||
      "",
    ).trim() || `agent-slot:${randomUUID()}`;
  const slotId = `agent-slot-${randomUUID().slice(0, 8)}`;
  const requestedAt = Date.now();
  const maxParallel = resolveAgentExecutionMaxParallel(options.maxParallel);
  const meta = summarizeAgentSlotMeta({
    ...options.meta,
    taskKey: options.taskKey,
    taskId: options.taskId,
    taskTitle: options.taskTitle,
    workflowRunId: options.workflowRunId,
    workflowId: options.workflowId,
    workflowName: options.workflowName,
    workflowNodeId: options.workflowNodeId,
    workflowNodeLabel: options.workflowNodeLabel,
    cwd: options.cwd,
    sdk: options.sdk,
    model: options.model,
    sessionType: options.sessionType,
  });
  const request = {
    slotId,
    ownerKey: normalizedOwnerKey,
    requestedAt,
    queuedAt: null,
    maxParallel,
    meta,
    onAcquired: options.onAcquired,
    onReleased: options.onReleased,
    resolve: null,
    reject: null,
  };

  if (activeAgentExecutionSlots.size < maxParallel) {
    return await new Promise((resolve) => {
      request.resolve = resolve;
      grantQueuedAgentExecutionSlot(request);
    });
  }

  request.queuedAt = Date.now();
  emitAgentSlotHook(
    options.onQueued,
    buildAgentSlotSnapshot({
      slotId,
      ownerKey: normalizedOwnerKey,
      requestedAt,
      queuedAt: request.queuedAt,
      maxParallel,
      queuedSlots: queuedAgentExecutionSlots.length + 1,
      meta,
      queueDepth: queuedAgentExecutionSlots.length + 1,
    }),
  );
  return await new Promise((resolve, reject) => {
    request.resolve = resolve;
    request.reject = reject;
    queuedAgentExecutionSlots.push(request);
  });
}

export async function releaseSlot(slotRef = null) {
  const slotId =
    typeof slotRef === "string"
      ? slotRef
      : String(slotRef?.slotId || "").trim();
  if (!slotId) {
    return buildAgentSlotSnapshot({ released: false, reason: "missing_slot_id" });
  }
  const lease = activeAgentExecutionSlots.get(slotId);
  if (!lease) {
    return buildAgentSlotSnapshot({ released: false, slotId, reason: "slot_not_found" });
  }
  activeAgentExecutionSlots.delete(slotId);
  const releasedAt = Date.now();
  const payload = buildAgentSlotSnapshot({
    slotId,
    ownerKey: lease.ownerKey,
    requestedAt: lease.requestedAt,
    queuedAt: lease.queuedAt,
    acquiredAt: lease.acquiredAt,
    releasedAt,
    waitedMs: lease.waitedMs,
    runDurationMs: Math.max(0, releasedAt - lease.acquiredAt),
    maxParallel: lease.maxParallel,
    meta: lease.meta,
    released: true,
  });
  emitAgentSlotHook(lease.onReleased, payload);
  pumpQueuedAgentExecutionSlots();
  return payload;
}

async function withAgentExecutionSlot(cwd, extra = {}, runner) {
  if (extra?.slotLease) {
    return await runner(extra.slotLease);
  }
  const slotOwnerKey =
    String(
      extra?.slotOwnerKey ||
      extra?.taskKey ||
      extra?.taskId ||
      extra?.workflowRunId ||
      extra?.workflowId ||
      "",
    ).trim() || `agent-slot:${randomUUID()}`;
  let slotLease = null;
  try {
    slotLease = await allocateSlot(slotOwnerKey, {
      taskKey: extra?.taskKey,
      taskId: extra?.taskId,
      taskTitle: extra?.taskTitle,
      workflowRunId: extra?.workflowRunId,
      workflowId: extra?.workflowId,
      workflowName: extra?.workflowName,
      workflowNodeId: extra?.workflowNodeId,
      workflowNodeLabel: extra?.workflowNodeLabel,
      cwd,
      sdk: extra?.sdk,
      model: extra?.model,
      sessionType: extra?.sessionType,
      meta: extra?.slotMeta,
      maxParallel: extra?.slotMaxParallel,
      onQueued: extra?.onSlotQueued,
      onAcquired: extra?.onSlotAcquired,
      onReleased: extra?.onSlotReleased,
    });
    return await runner(slotLease);
  } finally {
    if (slotLease?.slotId) {
      await releaseSlot(slotLease);
    }
  }
}

function hasOptionalModule(specifier) {
  if (MODULE_PRESENCE_CACHE.has(specifier)) {
    return MODULE_PRESENCE_CACHE.get(specifier);
  }
  let ok = false;
  if (specifier === CODEX_SDK_SPECIFIER) {
    ok = Boolean(resolveCodexSdkInstall({ extraRoots: [getAgentRepoRoot(), process.cwd()] }));
  } else {
    try {
      require.resolve(specifier);
      ok = true;
    } catch {
      ok = Boolean(
        resolveAgentSdkModuleEntry(specifier, { extraRoots: [getAgentRepoRoot(), process.cwd()] }),
      );
    }
  }
  // Only cache positive results — negative lookups should be re-checked on
  // each attempt so that a late `npm install` or delayed filesystem flush
  // can resolve the SDK without requiring a full daemon restart.
  if (ok) {
    MODULE_PRESENCE_CACHE.set(specifier, true);
  }
  return ok;
}

async function importCodexSdkModule() {
  if (process.env.VITEST) {
    const ctorMock = globalThis.__agentPoolMockCodexCtor;
    const startMock = globalThis.__agentPoolMockCodexStartThread;
    const resumeMock = globalThis.__agentPoolMockCodexResumeThread;
    if (
      typeof ctorMock === "function" &&
      typeof startMock === "function" &&
      typeof resumeMock === "function"
    ) {
      const makeThread = (threadId = "mock-codex-thread", text = "codex-output") => ({
        id: threadId,
        runStreamed: async () => ({
          events: {
            async *[Symbol.asyncIterator]() {
              yield {
                type: "item.completed",
                item: { type: "agent_message", text },
              };
            },
          },
        }),
      });
      return {
        Codex: class VitestCodex {
          constructor(...args) {
            ctorMock(...args);
          }

          startThread(...args) {
            if (process.env.__MOCK_CODEX_AVAILABLE !== "1") {
              return {
                id: "mock-codex-unavailable",
                runStreamed: async () => {
                  throw new Error("Codex SDK not available: mocked unavailable");
                },
              };
            }
            const injected = startMock(...args);
            if (injected !== undefined) return injected;
            return makeThread("mock-codex-thread-new", "codex-output");
          }

          resumeThread(...args) {
            if (process.env.__MOCK_CODEX_AVAILABLE !== "1") {
              throw new Error("Codex SDK not available: mocked unavailable");
            }
            const injected = resumeMock(...args);
            if (injected !== undefined) return injected;
            const [threadId] = args;
            return makeThread(threadId || "mock-codex-thread-resumed", "codex-resumed-output");
          }
        },
      };
    }
  }
  return import("@openai/codex-sdk");
}

async function importCopilotSdkModule() {
  if (process.env.VITEST) {
    const startMock = globalThis.__agentPoolMockCopilotStart;
    const createSessionMock = globalThis.__agentPoolMockCopilotCreateSession;
    const resumeSessionMock = globalThis.__agentPoolMockCopilotResumeSession;
    if (
      typeof startMock === "function" &&
      typeof createSessionMock === "function" &&
      typeof resumeSessionMock === "function"
    ) {
      if (process.env.__MOCK_COPILOT_AVAILABLE !== "1") {
        throw new Error("Cannot find module '@github/copilot-sdk'");
      }
      return {
        CopilotClient: class VitestCopilotClient {
          async start() {
            const injected = startMock();
            if (injected !== undefined) return injected;
          }

          async stop() {}

          async resumeSession(...args) {
            const injected = resumeSessionMock(...args);
            if (injected !== undefined) return injected;
            const [sessionId] = args;
            return {
              sessionId: sessionId || "mock-copilot-session-resumed",
              sendAndWait: async () => {},
              on: (cb) => {
                cb({
                  type: "assistant.message",
                  data: { content: "copilot-output" },
                });
                return () => {};
              },
            };
          }

          async createSession(...args) {
            const injected = createSessionMock(...args);
            if (injected !== undefined) return injected;
            return {
              sessionId: "mock-copilot-session-new",
              sendAndWait: async () => {},
              on: (cb) => {
                cb({
                  type: "assistant.message",
                  data: { content: "copilot-output" },
                });
                return () => {};
              },
            };
          }
        },
      };
    }
  }
  return await importCopilotSdkModuleWithCompat();
}

async function importClaudeSdkModule() {
  if (process.env.VITEST) {
    const queryMock = globalThis.__agentPoolMockClaudeQuery;
    if (typeof queryMock === "function") {
      if (process.env.__MOCK_CLAUDE_AVAILABLE !== "1") {
        throw new Error("Cannot find module '@anthropic-ai/claude-agent-sdk'");
      }
      return {
        query(payload = {}) {
          const injected = queryMock(payload);
          if (injected !== undefined) return injected;
          return {
            async *[Symbol.asyncIterator]() {
              let sessionId = "mock-claude-session-new";
              try {
                const promptIterator = payload?.prompt?.[Symbol.asyncIterator]?.();
                if (promptIterator) {
                  const first = await promptIterator.next();
                  if (!first?.done) {
                    const incoming = first?.value?.session_id || first?.value?.sessionId;
                    if (incoming) sessionId = incoming;
                  }
                }
              } catch {
                /* best effort */
              }
              yield {
                type: "assistant",
                session_id: sessionId,
                message: {
                  content: [{ type: "text", text: "claude-output" }],
                },
              };
              yield { type: "result", session_id: sessionId };
            },
          };
        },
      };
    }
  }
  return import("@anthropic-ai/claude-agent-sdk");
}
const MAX_PROMPT_BYTES = 180_000;
const MAX_SET_TIMEOUT_MS = 2_147_483_647; // Node.js setTimeout 32-bit signed max
let timeoutClampWarningKey = "";
const MIN_SILENT_STREAM_FRACTION = 0.25;
const MAX_SILENT_STREAM_GRACE_MS = 30_000;
const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 120_000;
const COPILOT_IDLE_TIMEOUT_GRACE_MS = 1_000;
const DEFAULT_MAX_ITEMS_PER_TURN = 600;
const DEFAULT_MAX_ITEM_CHARS = 12_000;
const TOOL_OUTPUT_GUARDRAIL = String.raw`

[Tool Output Guardrail] Keep tool outputs compact: prefer narrow searches, bounded command output (for example head/tail), and summaries for large results instead of dumping full payloads.
[Context Cache] Older tool outputs are automatically compressed and cached to disk. If you see "[…compressed — full output: bosun --tool-log <ID>]" and need the full output, run that command to retrieve it.
[Message Compression] Older agent reasoning and past user prompts are progressively compressed. Instruction-bearing content (AGENTS.md rules, system directives) is pinned and never compressed.`;

function parseBoundedNumber(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(Math.trunc(num), min), max);
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

function clampNumeric(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

async function finalizeBufferedTurnItems(items, limits = {}) {
  const maxItems = clampNumeric(
    limits.maxItems,
    1,
    Number.MAX_SAFE_INTEGER,
    Array.isArray(items) ? items.length : 1,
  );
  const maxItemChars = clampNumeric(limits.maxItemChars, 1, 100_000, 4000);
  const initialDroppedItems = clampNumeric(limits.droppedItems, 0, Number.MAX_SAFE_INTEGER, 0);
  const sourceItems = Array.isArray(items) ? items : [];
  const hotPathResult = await bufferItemsWithBosunHotPathExec(sourceItems, {
    maxItems,
    maxItemChars,
    droppedItems: initialDroppedItems,
  });
  if (hotPathResult?.ok) {
    const compacted = Array.isArray(hotPathResult.items) ? [...hotPathResult.items] : [];
    if (hotPathResult.notice && typeof hotPathResult.notice === "object") {
      compacted.push(hotPathResult.notice);
    }
    return {
      items: compacted,
      droppedItems: Number(hotPathResult.droppedItems || 0),
      hotPath: getBosunHotPathStatus().exec,
    };
  }

  const bounded = sourceItems
    .slice(0, maxItems)
    .map((item) => truncateItemForStorage(item, maxItemChars));
  const droppedItems = initialDroppedItems + Math.max(0, sourceItems.length - bounded.length);
  if (droppedItems > 0) {
    bounded.push({
      type: "stream_notice",
      text: `Dropped ${droppedItems} completed items to stay within INTERNAL_EXECUTOR_STREAM_MAX_ITEMS_PER_TURN=${maxItems}.`,
    });
  }
  return {
    items: bounded,
    droppedItems,
    hotPath: getBosunHotPathStatus().exec,
  };
}

function normalizeSdkForShredding(sdk) {
  const raw = String(sdk || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.endsWith("-sdk")) return raw;
  if (raw === "codex") return "codex-sdk";
  if (raw === "copilot") return "copilot-sdk";
  if (raw === "claude") return "claude-sdk";
  return raw;
}

async function maybeCompressResultItems(
  items,
  {
    sdk = "",
    sessionType = "task",
    sessionId = null,
    allowCompression = true,
    forceCompression = false,
    skipCompression = false,
  } = {},
) {
  if (!Array.isArray(items) || items.length === 0) {
    return items;
  }
  if (skipCompression) return items;
  if (!allowCompression && !forceCompression) return items;

  const resolvedSessionType = normalizeContextShreddingSessionType(sessionType, "task");
  const agentType = normalizeSdkForShredding(sdk);
  return maybeCompressSessionItems(items, {
    sessionType: resolvedSessionType,
    agentType,
    sessionId,
    force: forceCompression,
    skip: skipCompression,
  });
}

export function shouldCompressSessionItemsByDefault(
  sessionType,
  { compressEphemeralItems = false, forceCompression = false } = {},
) {
  if (forceCompression) return true;
  const resolvedSessionType = normalizeContextShreddingSessionType(sessionType, "task");
  if (resolvedSessionType === "ephemeral") {
    return compressEphemeralItems;
  }
  return true;
}

function resolveCodexStreamSafety(totalTimeoutMs) {
  const minSilentStreamFraction =
    typeof MIN_SILENT_STREAM_FRACTION === "number" && Number.isFinite(MIN_SILENT_STREAM_FRACTION)
      ? MIN_SILENT_STREAM_FRACTION
      : 0.25;
  const maxSilentStreamGraceMs =
    typeof MAX_SILENT_STREAM_GRACE_MS === "number" && Number.isFinite(MAX_SILENT_STREAM_GRACE_MS)
      ? MAX_SILENT_STREAM_GRACE_MS
      : 30_000;
  const streamCfg = getInternalExecutorStreamConfig();
  const firstEventRaw =
    process.env.INTERNAL_EXECUTOR_STREAM_FIRST_EVENT_TIMEOUT_MS ||
    process.env.AGENT_POOL_FIRST_EVENT_TIMEOUT_MS ||
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
    const silentBudgetFloor = Math.min(
      maxAllowed,
      Math.max(
        configuredFirstEventMs,
        Math.min(
          Math.trunc(budgetMs * minSilentStreamFraction),
          maxSilentStreamGraceMs,
        ),
      ),
    );
    firstEventTimeoutMs = clampTimerDelayMs(silentBudgetFloor, "first-event-timeout");
  }

  return {
    firstEventTimeoutMs,
    maxItemsPerTurn: parseBoundedNumber(maxItemsRaw, DEFAULT_MAX_ITEMS_PER_TURN, 1, 5000),
    maxItemChars: parseBoundedNumber(maxItemCharsRaw, DEFAULT_MAX_ITEM_CHARS, 1, 250000),
  };
}

function clampTimerDelayMs(delayMs, label = "timer") {
  const parsed = Number(delayMs);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  const clamped = Math.min(Math.trunc(parsed), MAX_SET_TIMEOUT_MS);
  if (clamped !== Math.trunc(parsed)) {
    const warningKey = `${label}:${parsed}`;
    if (timeoutClampWarningKey !== warningKey) {
      timeoutClampWarningKey = warningKey;
      console.warn(
        `${TAG} ${label} delay ${parsed}ms exceeds Node timer max; clamped to ${MAX_SET_TIMEOUT_MS}ms`,
      );
    }
  }
  return clamped;
}

function getFirstEventTimeoutMs(totalTimeoutMs) {
  return resolveCodexStreamSafety(totalTimeoutMs).firstEventTimeoutMs;
}

function isMeaningfulOpenaiNativeEvent(event) {
  if (typeof event === "string") {
    return event.trim().length > 0;
  }
  if (!event || typeof event !== "object") {
    return false;
  }
  if (typeof event.delta === "string" && event.delta.trim()) return true;
  if (typeof event.text === "string" && event.text.trim()) return true;
  if (typeof event.error === "string" && event.error.trim()) return true;
  if (Array.isArray(event.toolCalls) && event.toolCalls.length > 0) return true;
  if (Array.isArray(event.toolResults) && event.toolResults.length > 0) return true;
  return false;
}

function normalizeHarnessTimeoutMs(timeoutMs) {
  const parsed = Number(timeoutMs);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  const clamped = Math.min(Math.trunc(parsed), MAX_HARNESS_TIMEOUT_MS);
  return clamped;
}

function sanitizeAndBoundPrompt(text) {
  if (typeof text !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const sanitized = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  const bytes = Buffer.byteLength(sanitized, "utf8");
  if (bytes <= MAX_PROMPT_BYTES) return sanitized;
  const buf = Buffer.from(sanitized, "utf8").slice(0, MAX_PROMPT_BYTES);
  const truncated = buf.toString("utf8");
  const removedBytes = bytes - MAX_PROMPT_BYTES;
  console.warn(
    `${TAG} prompt truncated: ${bytes} → ${MAX_PROMPT_BYTES} bytes (removed ${removedBytes})`,
  );
  return (
    truncated +
    `\n\n[...prompt truncated — ${removedBytes} bytes removed to stay within API limits]`
  );
}

function envFlagEnabled(value) {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "on", "y"].includes(raw);
}

function normalizeRequestedMcpServerIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
}

function applyNodeWarningSuppressionEnv(runtimeEnv) {
  const nextEnv = { ...(runtimeEnv || {}) };
  if (String(process.env.BOSUN_SUPPRESS_NODE_WARNINGS ?? "").trim() === "0") {
    return nextEnv;
  }
  if (!nextEnv.NODE_NO_WARNINGS) {
    nextEnv.NODE_NO_WARNINGS = "1";
  }
  return nextEnv;
}

const GITHUB_TOKEN_CACHE_TTL_MS = 60_000;
let cachedGithubSessionToken = null;
let cachedGithubSessionTokenAt = 0;
let githubSessionTokenPromise = null;
let githubTokenSourceLogged = "";

function parseGithubRepoSlug(raw) {
  const text = String(raw || "").trim();
  if (!text) return { owner: "", repo: "" };
  const m = text.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!m) return { owner: "", repo: "" };
  return { owner: m[1], repo: m[2] };
}

async function resolveGithubSessionToken() {
  const now = Date.now();
  if (
    cachedGithubSessionToken &&
    now - cachedGithubSessionTokenAt < GITHUB_TOKEN_CACHE_TTL_MS
  ) {
    return cachedGithubSessionToken;
  }
  if (githubSessionTokenPromise) return githubSessionTokenPromise;

  githubSessionTokenPromise = (async () => {
    const explicitToken =
      process.env.GH_TOKEN ||
      process.env.GITHUB_TOKEN ||
      process.env.COPILOT_CLI_TOKEN ||
      process.env.GITHUB_PAT ||
      "";
    if (explicitToken) {
      cachedGithubSessionToken = explicitToken;
      cachedGithubSessionTokenAt = Date.now();
      return explicitToken;
    }

    try {
      const { owner, repo } = parseGithubRepoSlug(process.env.GITHUB_REPOSITORY);
      const { token, type } = await getGitHubToken({
        owner: owner || undefined,
        repo: repo || undefined,
      });
      if (token) {
        cachedGithubSessionToken = token;
        cachedGithubSessionTokenAt = Date.now();
        if (githubTokenSourceLogged !== type) {
          githubTokenSourceLogged = type || "unknown";
          console.log(`${TAG} injected GitHub token into agent session env (${type || "unknown"})`);
        }
        return token;
      }
    } catch {
      // best effort
    }
    return "";
  })();

  try {
    return await githubSessionTokenPromise;
  } finally {
    githubSessionTokenPromise = null;
  }
}

function injectGitHubSessionEnv(baseEnv, token) {
  const env = { ...(baseEnv || {}) };
  const resolved = String(token || "").trim();
  if (!resolved) return env;
  if (!env.GH_TOKEN) env.GH_TOKEN = resolved;
  if (!env.GITHUB_TOKEN) env.GITHUB_TOKEN = resolved;
  return env;
}

/**
 * Extract a human-readable task heading from the prompt built by _buildTaskPrompt.
 * The first line is "# Task: Task Title" (legacy: "# TASKID — Task Title");
 * we return the title portion only.
 * Falls back to the raw first line if no em-dash separator is found.
 * @param {string} prompt
 * @returns {string}
 */
function extractTaskHeading(prompt) {
  const firstLine = String(prompt || "").split(/\r?\n/)[0].replace(/^#+\s*/, "").trim();
  if (!firstLine) return "Execute Task";
  const lowerLine = firstLine.toLowerCase();
  if (lowerLine.startsWith("task")) {
    let index = 4;
    while (index < firstLine.length && /\s/.test(firstLine[index])) index += 1;
    const separator = firstLine[index];
    if (separator === ":" || separator === "-" || separator === "\u2014") {
      index += 1;
      while (index < firstLine.length && /\s/.test(firstLine[index])) index += 1;
      const title = firstLine.slice(index).trim();
      if (title) return title;
    }
  }
  const dashIdx = firstLine.indexOf(" \u2014 ");
  const title = dashIdx !== -1 ? firstLine.slice(dashIdx + 3).trim() : firstLine;
  return title || "Execute Task";
}

function shouldAutoApproveCopilotPermissions() {
  const raw = process.env.COPILOT_AUTO_APPROVE_PERMISSIONS;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return true;
  }
  return envFlagEnabled(raw);
}

function buildCopilotPermissionHandler() {
  if (!shouldAutoApproveCopilotPermissions()) return undefined;
  return async () => ({ kind: "approved" });
}

/**
 * Build a per-attempt abort controller that preserves external abort semantics.
 *
 * Internal attempt timeouts must not abort the caller-provided controller.
 * Otherwise retries are immediately pre-aborted and treated as external kills.
 *
 * @param {AbortController|null|undefined} externalAC
 * @param {number} timeoutMs
 * @returns {{ controller: AbortController, cleanup: () => void }}
 */
function createScopedAbortController(externalAC, timeoutMs) {
  const controller = new AbortController();
  const externalSignal = externalAC?.signal || null;
  const forwardExternalAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort(externalSignal?.reason || "external_abort");
    }
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      forwardExternalAbort();
    } else {
      externalSignal.addEventListener("abort", forwardExternalAbort, {
        once: true,
      });
    }
  }

  const timeoutHandle = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort("timeout");
    }
  }, clampTimerDelayMs(timeoutMs, "abort-timeout"));
  if (timeoutHandle && typeof timeoutHandle.unref === "function") {
    timeoutHandle.unref();
  }

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(timeoutHandle);
    if (externalSignal) {
      externalSignal.removeEventListener("abort", forwardExternalAbort);
    }
  };

  return { controller, cleanup };
}

function shouldFallbackForSdkError(error) {
  if (!error) return false;
  const message = String(error).toLowerCase();
  if (!message) return false;
  if (message.includes("failed to list models") && (message.includes("400") || message.includes("bad request"))) {
    return true;
  }
  if (message.includes("protocol version mismatch")) return true;
  if (message.includes("sdk expects version") && message.includes("server reports version")) {
    return true;
  }
  // SDK not installed / not found
  if (message.includes("not available")) return true;
  // Missing finish_reason (incomplete response)
  if (message.includes("missing finish_reason")) return true;
  if (message.includes("missing") && message.includes("finish_reason")) return true;
  // Model-related errors — SDK doesn't support the requested model
  if (message.includes("not supported")) return true;
  if (message.includes("model not found")) return true;
  if (message.includes("model_not_found")) return true;
  if (message.includes("does not exist")) return true;
  if (message.includes("invalid model")) return true;
  // Auth / key errors — SDK isn't properly configured
  if (message.includes("unauthorized") || message.includes("401")) return true;
  if (
    message.includes("api key") &&
    (message.includes("invalid") ||
      message.includes("missing") ||
      message.includes("required"))
  ) {
    return true;
  }
  if (
    message.includes("authentication") &&
    (message.includes("failed") ||
      message.includes("required") ||
      message.includes("error"))
  ) {
    return true;
  }
  if (message.includes("forbidden") || message.includes("403")) return true;
  // Connection errors — SDK endpoint is unreachable
  if (message.includes("econnrefused")) return true;
  if (message.includes("enotfound")) return true;
  if (message.includes("connection refused")) return true;
  if (message.includes("connection reset")) return true;
  if (message.includes("etimedout")) return true;
  if (message.includes("failed to list models")) return true;
  // Runtime/provider instability: fail over to next SDK immediately.
  if (message.includes("timeout")) return true;
  if (message.includes("rate limit") || message.includes("429")) return true;
  if (message.includes("service unavailable") || message.includes("503")) {
    return true;
  }
  if (message.includes("bad gateway") || message.includes("502")) return true;
  if (message.includes("gateway timeout") || message.includes("504")) {
    return true;
  }
  if (message.includes("overloaded") || message.includes("server error")) {
    return true;
  }
  // Spawn failures: binary not found on Windows (.cmd resolution)
  if (message.includes("enoent")) return true;
  if (message.includes("file not found") || message.includes("file specified")) return true;
  if (message.includes("os error 2")) return true;
  if (message.includes("spawn failed")) return true;
  if (message.includes("codex exec exited")) return true;
  return false;
}

/**
 * Check whether an SDK has the minimum prerequisites to be attempted.
 * This prevents wasting time and error logs trying unconfigured SDKs.
 *
 * @param {string} name  SDK canonical name
 * @returns {{ ok: boolean, reason: string|null }}
 */
function hasSdkPrerequisites(name, runtimeEnv = process.env) {
  // Test mocks bypass prerequisite checks
  if (process.env[`__MOCK_${name.toUpperCase()}_AVAILABLE`] === "1") {
    return { ok: true, reason: null };
  }

  if (name === "codex") {
    if (!hasOptionalModule("@openai/codex-sdk")) {
      return { ok: false, reason: "@openai/codex-sdk not installed" };
    }
    const runtimeFailure = getCodexRuntimePrerequisiteFailure();
    if (runtimeFailure) {
      return { ok: false, reason: runtimeFailure };
    }
    // Codex auth can come from env vars, config env_key mappings, or persisted
    // CLI login state (for example ~/.codex/auth.json). Because login-based
    // auth is valid and hard to validate exhaustively, avoid false negatives.
    const hasKey =
      runtimeEnv.OPENAI_API_KEY ||
      runtimeEnv.AZURE_OPENAI_API_KEY ||
      runtimeEnv.CODEX_MODEL_PROFILE_XL_API_KEY ||
      runtimeEnv.CODEX_MODEL_PROFILE_M_API_KEY;
    if (hasKey) return { ok: true, reason: null };

    // Check ~/.codex/config.toml — Codex CLI SDK reads auth env_key refs from there.
    try {
      const configToml = resolve(homedir(), ".codex", "config.toml");
      if (existsSync(configToml)) {
        const tomlText = readFileSync(configToml, "utf8");
        // Extract all env_key = "VAR_NAME" entries and check if any are set
        for (const match of tomlText.matchAll(/env_key\s*=\s*"([^"]+)"/g)) {
          if (runtimeEnv[match[1]]) return { ok: true, reason: null };
        }
      }
    } catch {
      // best effort — fall through to failure
    }

    // Login-based auth sessions are sufficient even without env keys.
    try {
      const authJson = resolve(homedir(), ".codex", "auth.json");
      if (existsSync(authJson)) {
        const authText = readFileSync(authJson, "utf8").trim();
        if (authText) return { ok: true, reason: null };
      }
    } catch {
      // best effort — fall through to permissive behavior
    }

    // Do not hard-block Codex when auth source cannot be determined.
    return { ok: true, reason: null };
  }
  if (name === "copilot") {
    if (!hasOptionalModule("@github/copilot-sdk")) {
      return { ok: false, reason: "@github/copilot-sdk not installed" };
    }
    // Copilot auth can come from multiple sources (OAuth manager, gh auth,
    // VS Code Copilot login, env tokens). Don't block execution here.
    return { ok: true, reason: null };
  }
  if (name === "claude") {
    if (!hasOptionalModule("@anthropic-ai/claude-agent-sdk")) {
      return { ok: false, reason: "@anthropic-ai/claude-agent-sdk not installed" };
    }
    const hasKey = runtimeEnv.ANTHROPIC_API_KEY;
    if (!hasKey) {
      return { ok: false, reason: "no ANTHROPIC_API_KEY" };
    }
    return { ok: true, reason: null };
  }
  if (name === "opencode") {
    if (!hasOptionalModule("@opencode-ai/sdk")) {
      return { ok: false, reason: "@opencode-ai/sdk not installed" };
    }
    return { ok: true, reason: null };
  }
  if (name === "openai-native") {
    // The in-process native adapter only needs an API key reachable by the
    // configured harness executor. Accept any of the common credential keys.
    const hasKey =
      runtimeEnv.OPENAI_API_KEY
      || runtimeEnv.AZURE_OPENAI_API_KEY
      || runtimeEnv.AZURE_API_KEY
      || runtimeEnv.AZURE_SWEDEN_OPENAI_API_KEY;
    if (!hasKey) {
      return { ok: false, reason: "no OPENAI_API_KEY / AZURE_OPENAI_API_KEY" };
    }
    return { ok: true, reason: null };
  }
  return { ok: true, reason: null };
}

/**
 * Detect if an error is a context/token overflow that should trigger a
 * new thread instead of retrying on the same (exhausted) session.
 * @param {string|Error} error
 * @returns {boolean}
 */
export function isContextOverflowError(error) {
  if (!error) return false;
  const msg = String(error).toLowerCase();
  return (
    msg.includes("invalid string length") ||
    msg.includes("string too long") ||
    msg.includes("context_length_exceeded") ||
    msg.includes("prompt_too_long") ||
    msg.includes("prompt is too long") ||
    msg.includes("context too long") ||
    msg.includes("context length exceeded") ||
    msg.includes("token_budget") ||
    msg.includes("turn_limit_reached") ||
    msg.includes("conversation too long") ||
    msg.includes("maximum context length") ||
    msg.includes("max token") ||
    msg.includes("maximum number of tokens") ||
    msg.includes("string_above_max_length") ||
    msg.includes("input too large") ||
    msg.includes("reduce the length")
  );
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

async function withTemporaryEnv(overrides, fn) {
  if (!overrides || typeof overrides !== "object") {
    return await fn();
  }
  const prev = new Map();
  const touched = [];
  for (const [key, value] of Object.entries(overrides)) {
    if (!key) continue;
    prev.set(key, process.env[key]);
    touched.push(key);
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }
  try {
    return await fn();
  } finally {
    for (const key of touched) {
      const oldValue = prev.get(key);
      if (oldValue == null) {
        delete process.env[key];
      } else {
        process.env[key] = oldValue;
      }
    }
  }
}

function injectProviderConfigCredentialEnv(baseEnv, providerConfig = null, providerId = "") {
  const env = { ...(baseEnv || {}) };
  const config =
    providerConfig && typeof providerConfig === "object" && !Array.isArray(providerConfig)
      ? providerConfig
      : null;
  const apiKey = String(config?.apiKey || "").trim();
  if (!apiKey) return env;

  const normalizedProviderId = String(
    providerId || config?.providerId || config?.provider || config?.selectionId || "",
  ).trim().toLowerCase();
  const baseUrl = String(config?.baseUrl || config?.endpoint || config?.deployment || "").trim();
  const sourceEnvKey = String(config?.credentials?.sources?.apiKey || "").trim();
  const isAzure =
    normalizedProviderId.includes("azure")
    || (baseUrl && isAzureOpenAIBaseUrl(baseUrl));
  const preferredEnvKey = sourceEnvKey || (isAzure ? "AZURE_OPENAI_API_KEY" : "OPENAI_API_KEY");

  if (!env[preferredEnvKey]) {
    env[preferredEnvKey] = apiKey;
  }
  if (isAzure && !env.AZURE_OPENAI_API_KEY) {
    env.AZURE_OPENAI_API_KEY = apiKey;
  }
  if (!isAzure && !env.OPENAI_API_KEY) {
    env.OPENAI_API_KEY = apiKey;
  }
  return env;
}

/**
 * Build Codex SDK constructor options with Azure auto-detection.
 * When OPENAI_BASE_URL points to Azure, configures the SDK with Azure
 * provider settings via `config` and maps the API key via `env`.
 * Otherwise strips OPENAI_BASE_URL so the SDK uses its default auth.
 */
function normalizeCodexSandboxMode(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "workspace-write";
  if (raw === "disk-full-write-access" || raw === "workspace-write") return "workspace-write";
  if (raw === "disk-read-only" || raw === "read-only") return "read-only";
  if (raw === "danger-full-access") return "danger-full-access";
  return raw;
}

function buildInjectedCodexSandboxConfig(envInput, workingDirectory) {
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
        repoRoot: getAgentRepoRoot(),
        tempDir: envInput?.TEMP || envInput?.TMP || "",
        platform: envInput?.BOSUN_HOST_PLATFORM || envInput?.npm_config_platform || envInput?.OS || process.platform,
      }),
    };
  }
  return config;
}

function buildCodexSdkOptions(envInput = process.env, options = {}) {
  const workingDirectory = String(options?.workingDirectory || getAgentRepoRoot() || REPO_ROOT).trim() || REPO_ROOT;
  const resolved = resolveCodexProfileRuntime(envInput);
  const { env: resolvedEnv, configProvider } = resolved;
  const baseUrl = resolvedEnv.OPENAI_BASE_URL || "";
  /** @param {string} url */
  const isAzureOpenAIBaseUrl = (url) => {
    try {
      const parsed = new URL(url);
      const host = String(parsed.hostname || "").toLowerCase();
      return host === "openai.azure.com" || host.endsWith(".openai.azure.com") || host.endsWith(".cognitiveservices.azure.com");
    } catch {
      return false;
    }
  };
  const getAzureProviderEndpointEnvKeys = (sectionName) => {
    const normalizedName = String(sectionName || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    const keys = ["AZURE_OPENAI_ENDPOINT"];
    if (normalizedName) {
      keys.push(`${normalizedName}_ENDPOINT`);
      keys.push(`${normalizedName}_BASE_URL`);
      if (normalizedName.startsWith("AZURE_")) {
        const suffix = normalizedName.slice("AZURE_".length);
        if (suffix) {
          keys.push(`AZURE_${suffix}_ENDPOINT`);
          keys.push(`AZURE_${suffix}_BASE_URL`);
        }
      }
    }
    return [...new Set(keys)];
  };
  const isAzure = isAzureOpenAIBaseUrl(baseUrl);
  const env = { ...resolvedEnv };
  const unsetEnvKeys = [];
  // Always strip OPENAI_BASE_URL — for Azure we use config overrides,
  // for non-Azure the CLI should use its built-in endpoint.
  delete env.OPENAI_BASE_URL;
  delete env.OPENAI_ORGANIZATION;
  delete env.OPENAI_PROJECT;

  const injectedSandboxConfig = buildInjectedCodexSandboxConfig(envInput, workingDirectory);

  if (isAzure) {
    // Map OPENAI_API_KEY → AZURE_OPENAI_API_KEY for Azure auth
    if (env.OPENAI_API_KEY && !env.AZURE_OPENAI_API_KEY) {
      env.AZURE_OPENAI_API_KEY = env.OPENAI_API_KEY;
    }
    // Use the config.toml provider section name and env_key when available,
    // so the SDK config override is consistent with the user's config.toml.
    const providerSectionName = configProvider?.name || "azure";
    const providerEnvKey = configProvider?.envKey || "AZURE_OPENAI_API_KEY";
    const azureModel = env.CODEX_MODEL || undefined;

    // ── Strip env keys for non-selected Azure providers ────────────────────
    // When config.toml defines multiple Azure providers (e.g. US + Sweden),
    // the SDK reads config.toml and considers any provider whose env_key is
    // set as "configured". This causes the SDK to list models from ALL
    // providers — if a non-selected provider's endpoint returns 400 (wrong
    // API version, missing deployment, etc.) the entire session fails.
    // Fix: remove env keys for Azure providers we're NOT using so the SDK
    // skips them. Only strip Azure-specific keys to avoid breaking non-Azure
    // fallback auth paths (e.g. OPENAI_API_KEY used by SDK internally).
    try {
      const configDefaults = readCodexConfigRuntimeDefaults();
      const allProviders = configDefaults?.providers || {};
      for (const [sectionName, section] of Object.entries(allProviders)) {
        if (sectionName === providerSectionName) continue; // keep selected provider
        const otherBaseUrl = (section.baseUrl || "").trim();
        const otherEnvKey = (section.envKey || "").trim();
        // Only strip keys that belong to Azure-type endpoints (not OpenAI direct)
        if (!otherBaseUrl || !isAzureOpenAIBaseUrl(otherBaseUrl)) continue;
        if (!otherEnvKey || otherEnvKey === providerEnvKey) continue;
        delete env[otherEnvKey];
        if (!unsetEnvKeys.includes(otherEnvKey)) unsetEnvKeys.push(otherEnvKey);
        for (const endpointKey of getAzureProviderEndpointEnvKeys(sectionName)) {
          if (endpointKey === "AZURE_OPENAI_ENDPOINT") continue;
          delete env[endpointKey];
          if (!unsetEnvKeys.includes(endpointKey)) unsetEnvKeys.push(endpointKey);
        }
      }
    } catch {
      // best effort — if config reading fails, don't block execution
    }

    for (const key of Object.keys(env)) {
      if (!key.startsWith("AZURE_OPENAI_API_KEY") || key === providerEnvKey) continue;
      delete env[key];
      if (!unsetEnvKeys.includes(key)) unsetEnvKeys.push(key);
    }

    return {
      env,
      unsetEnvKeys,
      config: {
        ...injectedSandboxConfig,
        model_provider: providerSectionName,
        model_providers: {
          [providerSectionName]: {
            name: "Azure OpenAI",
            base_url: baseUrl,
            env_key: providerEnvKey,
            wire_api: "responses",
          },
        },
        features: {
          remote_models: false,
        },
        ...(azureModel ? { model: azureModel } : {}),
      },
    };
  }
  return {
    env,
    unsetEnvKeys,
    config: injectedSandboxConfig,
  };
}

// ---------------------------------------------------------------------------
// SDK Adapter Registry
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} SdkAdapter
 * @property {string}   name           Human-readable SDK name.
 * @property {Function} load           Async loader returning the launcher fn.
 * @property {string}   envDisableKey  Env var name that disables this SDK.
 */

/**
 * Registry of supported SDK adapters.
 * Each entry maps a canonical name to its loader and disable-check env var.
 * @type {Record<string, SdkAdapter>}
 */
function normalizePoolSdkName(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw === "auto") return "";
  if (raw.includes("copilot")) return "copilot";
  if (
    raw === "openai-native"
    || raw === "openai_native"
    || raw === "azure"
    || raw === "azure-openai"
    || raw === "azure-openai-responses"
    || raw === "openai-responses"
  ) {
    return "openai-native";
  }
  if (raw.includes("codex") || raw.includes("gpt")) return "codex";
  if (raw.includes("claude")) return "claude";
  if (raw.includes("opencode")) return "opencode";
  return raw.replace(/-sdk$/, "");
}

const SDK_ADAPTERS = {
  codex: {
    name: "codex",
    load: loadCodexAdapter,
    envDisableKey: "CODEX_SDK_DISABLED",
  },
  copilot: {
    name: "copilot",
    load: loadCopilotAdapter,
    envDisableKey: "COPILOT_SDK_DISABLED",
  },
  claude: {
    name: "claude",
    load: loadClaudeAdapter,
    envDisableKey: "CLAUDE_SDK_DISABLED",
  },
  opencode: {
    name: "opencode",
    load: loadOpencodeAdapter,
    envDisableKey: "OPENCODE_SDK_DISABLED",
  },
  "openai-native": {
    name: "openai-native",
    load: loadOpenaiNativeAdapter,
    envDisableKey: "OPENAI_NATIVE_SDK_DISABLED",
  },
};

/**
 * Ordered fallback chain for SDK resolution.
 * Configurable via bosun.config.json → agentPool.fallbackOrder
 *
 * "openai-native" is listed first: it is the in-process kernel path that
 * connects directly to the configured harness executor (Azure OpenAI by
 * default) and avoids subprocess CLI failure modes (codex CLI / copilot
 * OAuth / etc.) when `agentRuntime: "harness"` is enabled.
 */
let SDK_FALLBACK_ORDER = ["openai-native", "codex", "copilot", "claude", "opencode"];

function getSdkFallbackOrder() {
  const envOrder = String(process.env.BOSUN_AGENT_POOL_FALLBACK_ORDER || "").trim();
  if (envOrder) {
    const parsed = envOrder
      .split(",")
      .map((value) => normalizePoolSdkName(value))
      .filter((value, index, arr) => SDK_ADAPTERS[value] && arr.indexOf(value) === index);
    if (parsed.length > 0) return parsed;
  }
  return SDK_FALLBACK_ORDER;
}

// Attempt to load custom fallback order from config
try {
  const cfg = loadConfig();
  const customOrder = cfg?.agentPool?.fallbackOrder;
  if (Array.isArray(customOrder) && customOrder.length > 0) {
    // Validate: only accept known SDK names
    const valid = customOrder
      .map((s) => normalizePoolSdkName(s))
      .filter((s) => SDK_ADAPTERS[s]);
    if (valid.length > 0) SDK_FALLBACK_ORDER = valid;
  }
} catch {
  // loadConfig not available or no custom order — use default
}

// ---------------------------------------------------------------------------
// SDK Resolution & Cache
// ---------------------------------------------------------------------------

/** @type {string|null} Cached resolved SDK name */
let resolvedSdkName = null;

/** @type {boolean} Whether initial resolution has been logged */
let resolutionLogged = false;

/**
 * Check whether an SDK is disabled via its env var.
 * @param {string} name SDK canonical name.
 * @returns {boolean}
 */
function isDisabled(name) {
  const adapter = SDK_ADAPTERS[name];
  if (!adapter) return true;
  if (processDisabledSdks.has(name)) return true;
  return envFlagEnabled(process.env[adapter.envDisableKey]);
}

function getFallbackUnusableReason(name, env = process.env) {
  if (name !== "codex") return "";
  const prerequisite = hasSdkPrerequisites("codex", env);
  if (prerequisite?.ok !== false) return "";
  const providerName =
    String(prerequisite?.provider || prerequisite?.providerId || "").trim() || "azure";
  const envKey =
    String(prerequisite?.envKey || "AZURE_OPENAI_API_KEY").trim()
      || "AZURE_OPENAI_API_KEY";
  return `missing ${envKey} for ${providerName}`;
}

/**
 * SDKs marked dead for the lifetime of this process. We populate this when an
 * SDK returns a deterministic 400-class auth/configuration error (e.g.
 * Copilot's "Failed to list models: 400") that will never succeed without
 * external action. Without this, every task launch retries the same broken
 * fallback SDK and floods the logs.
 */
const processDisabledSdks = new Map();

function markSdkProcessDisabled(name, reason) {
  if (!name || !SDK_ADAPTERS[name] || processDisabledSdks.has(name)) return;
  processDisabledSdks.set(name, String(reason || "deterministic failure"));
  console.warn(
    `${TAG} SDK "${name}" disabled for the rest of this process: ${reason}`,
  );
}

function isDeterministicAuthFailure(error) {
  const message = String(error || "").toLowerCase();
  if (!message) return false;
  if (message.includes("failed to list models") && message.includes("400")) {
    return true;
  }
  if (message.includes("401") && message.includes("unauthorized")) return true;
  if (message.includes("403") && message.includes("forbidden")) return true;
  return false;
}

const DEFAULT_SDK_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const sdkFailureCooldownUntil = new Map();

function getSdkFailureCooldownMs() {
  const parsed = Number(process.env.AGENT_POOL_SDK_FAILURE_COOLDOWN_MS);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_SDK_FAILURE_COOLDOWN_MS;
  }
  return Math.trunc(parsed);
}

function getSdkCooldownRemainingMs(name, nowMs = Date.now()) {
  const untilMs = Number(sdkFailureCooldownUntil.get(name) || 0);
  if (!untilMs || untilMs <= nowMs) {
    sdkFailureCooldownUntil.delete(name);
    return 0;
  }
  return untilMs - nowMs;
}

function shouldApplySdkCooldown(error) {
  if (!error) return false;
  const message = String(error).toLowerCase();
  if (!message) return false;

  if (
    message.includes("failed to list models")
    && (
      message.includes("400")
      ||
      message.includes("bad request")
      || message.includes("invalid url")
      || message.includes("deployment")
      || message.includes("api version")
      || message.includes("/models")
    )
  ) {
    return false;
  }
  if (message.includes("failed to list models")) return true;
  if (message.includes("protocol version mismatch")) return true;
  if (message.includes("sdk expects version") && message.includes("server reports version")) {
    return true;
  }
  if (message.includes("timeout")) return true;
  if (message.includes("rate limit") || message.includes("429")) return true;
  if (message.includes("service unavailable") || message.includes("503")) {
    return true;
  }
  if (message.includes("bad gateway") || message.includes("502")) return true;
  if (message.includes("gateway timeout") || message.includes("504")) {
    return true;
  }
  if (message.includes("overloaded") || message.includes("server error")) {
    return true;
  }
  if (message.includes("econnrefused")) return true;
  if (message.includes("enotfound")) return true;
  if (message.includes("connection reset")) return true;
  if (message.includes("etimedout")) return true;
  // Spawn failures (binary not found) — apply cooldown so we try fallback SDK
  if (message.includes("enoent")) return true;
  if (message.includes("file not found") || message.includes("file specified")) return true;
  if (message.includes("os error 2")) return true;
  if (message.includes("spawn failed")) return true;
  // Spawn failures: codex binary not found on Windows (.cmd not resolved)
  if (message.includes("enoent")) return true;
  if (message.includes("file not found") || message.includes("file specified")) return true;
  if (message.includes("os error 2")) return true;
  if (message.includes("spawn failed")) return true;
  return false;
}

function applySdkFailureCooldown(name, error, nowMs = Date.now()) {
  if (!name || !SDK_ADAPTERS[name]) return;
  if (!shouldApplySdkCooldown(error)) return;
  const cooldownMs = getSdkFailureCooldownMs();
  if (cooldownMs <= 0) return;
  const untilMs = nowMs + cooldownMs;
  const previous = Number(sdkFailureCooldownUntil.get(name) || 0);
  if (untilMs <= previous) return;
  sdkFailureCooldownUntil.set(name, untilMs);
  const roundedSec = Math.max(1, Math.ceil(cooldownMs / 1000));
  console.warn(
    `${TAG} SDK "${name}" entering failure cooldown for ${roundedSec}s after fallback-worthy error: ${error}`,
  );
}

const MONITOR_MONITOR_TASK_KEY = "monitor-monitor";
const MONITOR_MONITOR_THREAD_REFRESH_TURNS_REMAINING = parseBoundedNumber(process.env.DEVMODE_MONITOR_MONITOR_THREAD_REFRESH_TURNS_REMAINING, 5, 1, 1000);
let monitorMonitorTimeoutBoundsWarningKey = "";
let monitorMonitorTimeoutAdjustmentKey = "";

function parsePositiveTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
}

function clampMonitorMonitorTimeout(timeoutMs, taskKey) {
  if (String(taskKey || "").trim() !== MONITOR_MONITOR_TASK_KEY) {
    return timeoutMs;
  }
  const baseTimeoutMs = parsePositiveTimeoutMs(timeoutMs);
  if (baseTimeoutMs === null) return timeoutMs;

  const minMs = parsePositiveTimeoutMs(
    process.env.DEVMODE_MONITOR_MONITOR_TIMEOUT_MIN_MS,
  );
  const maxEnv = parsePositiveTimeoutMs(
    process.env.DEVMODE_MONITOR_MONITOR_TIMEOUT_MAX_MS,
  );

  let maxMs = maxEnv;
  if (minMs !== null && maxMs !== null && maxMs < minMs) {
    const warningKey = `${minMs}:${maxMs}`;
    if (monitorMonitorTimeoutBoundsWarningKey !== warningKey) {
      monitorMonitorTimeoutBoundsWarningKey = warningKey;
      console.warn(
        `${TAG} invalid monitor-monitor timeout bounds: DEVMODE_MONITOR_MONITOR_TIMEOUT_MAX_MS=${maxMs} is lower than DEVMODE_MONITOR_MONITOR_TIMEOUT_MIN_MS=${minMs}. Ignoring max bound.`,
      );
    }
    maxMs = null;
  }

  if (minMs === null && maxMs === null) {
    return baseTimeoutMs;
  }

  let bounded = baseTimeoutMs;
  if (minMs !== null && bounded < minMs) bounded = minMs;
  if (maxMs !== null && bounded > maxMs) bounded = maxMs;

  if (bounded !== baseTimeoutMs) {
    const adjustmentKey = `${baseTimeoutMs}:${bounded}:${minMs ?? "off"}:${maxMs ?? "off"}`;
    if (monitorMonitorTimeoutAdjustmentKey !== adjustmentKey) {
      monitorMonitorTimeoutAdjustmentKey = adjustmentKey;
      console.log(
        `${TAG} monitor-monitor timeout adjusted ${baseTimeoutMs}ms -> ${bounded}ms (min=${minMs ?? "off"}, max=${maxMs ?? "off"})`,
      );
    }
  }
  return bounded;
}

/**
 * Log which SDK was selected (only on first resolution).
 * @param {string} name SDK name.
 * @param {string} source How it was determined.
 */
function logResolution(name, source) {
  if (!resolutionLogged) {
    console.log(`${TAG} SDK selected: ${name} (via ${source})`);
    resolutionLogged = true;
  }
}

/**
 * Resolve which SDK the pool should use.
 *
 * Resolution order:
 *   1. Runtime override via `setPoolSdk()` (already cached)
 *   2. `AGENT_POOL_SDK` env var
 *   3. `PRIMARY_AGENT` env var
 *   4. `loadConfig().agentPool.sdk` from bosun.config.json
 *   5. First non-disabled SDK in fallback chain
 *
 * @returns {string} Canonical SDK name (e.g. "codex", "copilot", "claude", "opencode").
 */
export function resolvePoolSdkName() {
  if (resolvedSdkName) return resolvedSdkName;

  // 1. AGENT_POOL_SDK env var (explicit override)
  const envPoolSdk = normalizePoolSdkName(process.env.AGENT_POOL_SDK || "");
  if (envPoolSdk && SDK_ADAPTERS[envPoolSdk] && !isDisabled(envPoolSdk)) {
    resolvedSdkName = envPoolSdk;
    logResolution(envPoolSdk, "AGENT_POOL_SDK env");
    return resolvedSdkName;
  }

  // 2. PRIMARY_AGENT env var
  const envPrimary = normalizePoolSdkName(process.env.PRIMARY_AGENT || "");
  if (envPrimary && SDK_ADAPTERS[envPrimary] && !isDisabled(envPrimary)) {
    resolvedSdkName = envPrimary;
    logResolution(envPrimary, "PRIMARY_AGENT env");
    return resolvedSdkName;
  }

  // 3. bosun.config.json → agentPool.sdk
  try {
    const config = loadConfig();
    // 3. agentRuntime: "harness" + an enabled native executor → use openai-native
    // by default. This routes workflow agent runs through the in-process kernel +
    // native adapter (Azure OpenAI / OpenAI Responses) instead of subprocess CLI
    // SDKs that may have transient stdin/auth failures.
    const runtime = String(config?.agentRuntime || "").trim().toLowerCase();
    if (runtime === "harness" && config?.harness?.enabled !== false) {
      const harnessSelectionId = resolveHarnessNativeSelectionId(process.env);
      if (
        harnessSelectionId
        && SDK_ADAPTERS["openai-native"]
        && !isDisabled("openai-native")
      ) {
        const prereq = hasSdkPrerequisites("openai-native", process.env);
        if (prereq.ok) {
          resolvedSdkName = "openai-native";
          logResolution("openai-native", `harness primary executor "${harnessSelectionId}"`);
          return resolvedSdkName;
        }
      }
    }
    const configSdk = normalizePoolSdkName(
      config?.agentPool?.sdk ||
      config?.primaryAgent ||
      ""
    );
    if (configSdk && SDK_ADAPTERS[configSdk] && !isDisabled(configSdk)) {
      resolvedSdkName = configSdk;
      logResolution(configSdk, "bosun.config.json");
      return resolvedSdkName;
    }
  } catch {
    // config.mjs not available — continue with fallback
  }

  // 4. Fallback chain: first non-disabled SDK
  for (const name of getSdkFallbackOrder()) {
    if (isDisabled(name)) continue;
    const unusableReason = getFallbackUnusableReason(name);
    if (unusableReason) continue;
    resolvedSdkName = name;
    logResolution(name, "fallback chain");
    return resolvedSdkName;
  }

  // All disabled — default to codex anyway (will fail at load time)
  resolvedSdkName = "codex";
  logResolution("codex", "last resort (all SDKs disabled)");
  return resolvedSdkName;
}

// ---------------------------------------------------------------------------
// Public SDK management API
// ---------------------------------------------------------------------------

/**
 * Get the name of the currently resolved pool SDK.
 * @returns {string} SDK name ("codex", "copilot", or "claude").
 */
export function getPoolSdkName() {
  return resolvePoolSdkName();
}

/**
 * Override the pool SDK at runtime.
 * @param {string} name SDK name ("codex", "copilot", "claude", or "opencode").
 * @throws {Error} If the name is not a recognised SDK.
 */
export function setPoolSdk(name) {
  const normalised = normalizePoolSdkName(name);
  if (!SDK_ADAPTERS[normalised]) {
    throw new Error(
      `${TAG} unknown SDK "${name}". Valid: ${Object.keys(SDK_ADAPTERS).join(", ")}`,
    );
  }
  resolvedSdkName = normalised;
  resolutionLogged = false;
  logResolution(normalised, "setPoolSdk() runtime override");
}

/**
 * Force re-resolution of the pool SDK on next use.
 * Useful after environment changes.
 */
export function resetPoolSdkCache() {
  resolvedSdkName = null;
  resolutionLogged = false;
  sdkFailureCooldownUntil.clear();
}

export function setSdkFailureCooldownForTest(name, cooldownRemainingMs, nowMs = Date.now()) {
  if (!SDK_ADAPTERS[name]) {
    throw new Error(`Unknown SDK: ${name}`);
  }
  const remainingMs = Number(cooldownRemainingMs);
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    sdkFailureCooldownUntil.delete(name);
    return;
  }
  sdkFailureCooldownUntil.set(name, nowMs + Math.trunc(remainingMs));
}

/**
 * Returns the list of SDK names that are not disabled.
 * @returns {string[]}
 */
export function getAvailableSdks() {
  return Object.keys(SDK_ADAPTERS).filter((name) => !isDisabled(name));
}

// ---------------------------------------------------------------------------
// Per-SDK Ephemeral Thread Launchers
// ---------------------------------------------------------------------------

/**
 * Launch a single ephemeral prompt via the **Codex SDK**.
 *
 * Creates a fresh `Codex` instance + thread, streams one turn, tears down.
 *
 * @param {string}  prompt     Prompt text.
 * @param {string}  cwd        Working directory.
 * @param {number}  timeoutMs  Abort timeout in ms.
 * @param {object}  extra      Optional { onEvent, abortController }.
 * @returns {Promise<{ success: boolean, output: string, items: Array, error: string|null, sdk: string }>}
 */
async function launchCodexThread(prompt, cwd, timeoutMs, extra = {}) {
  // Coerce to number — prevents string concatenation in setTimeout arithmetic
  timeoutMs = Number(timeoutMs) || DEFAULT_TIMEOUT_MS;
  const {
    onEvent,
    abortController: externalAC,
    onThreadReady = null,
    taskKey: steerKey = null,
    envOverrides = null,
    systemPrompt = "",
  } = extra;

  let reportedThreadId = null;
  const emitThreadReady = (threadId) => {
    if (!threadId || threadId === reportedThreadId) return;
    reportedThreadId = threadId;
    if (typeof onThreadReady === "function") {
      try {
        onThreadReady(threadId, "codex");
      } catch {
        /* best effort */
      }
    }
  };

  // ── 1. Load the SDK ──────────────────────────────────────────────────────
  let CodexClass;
  try {
    const mod = await importCodexSdkModule();
    CodexClass = mod.Codex;
    if (!CodexClass) throw new Error("Codex export not found in SDK module");
  } catch (err) {
    return {
      success: false,
      output: "",
      items: [],
      error: `Codex SDK not available: ${err.message}`,
      sdk: "codex",
      threadId: null,
    };
  }

  // ── 2. Create an ephemeral thread ────────────────────────────────────────
  // Sandbox policy: configurable via CODEX_SANDBOX env var.
  // Default is workspace-write: permissive for repo tasks while avoiding full host access.
  const sandboxPolicy = process.env.CODEX_SANDBOX || "workspace-write";

  // Pass feature overrides via --config so sub-agent and memory features are
  // available even if ~/.codex/config.toml hasn't been patched yet.
  const codexRuntimeEnv =
    envOverrides && typeof envOverrides === "object"
      ? { ...process.env, ...envOverrides }
      : process.env;
  const codexSessionEnv = applyNodeWarningSuppressionEnv(codexRuntimeEnv);
  const codexOpts = buildCodexSdkOptions(codexSessionEnv, { workingDirectory: cwd });
  const explicitEnvModel = String(envOverrides?.CODEX_MODEL || "").trim();
  if (explicitEnvModel) {
    codexOpts.env = { ...(codexOpts.env || {}), CODEX_MODEL: explicitEnvModel };
    codexOpts.config = { ...(codexOpts.config || {}), model: explicitEnvModel };
  }
  const modelOverride = String(extra?.model || "").trim();
  if (modelOverride) {
    codexOpts.env = { ...(codexOpts.env || {}), CODEX_MODEL: modelOverride };
    codexOpts.config = { ...(codexOpts.config || {}), model: modelOverride };
  }
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_ORGANIZATION;
  delete process.env.OPENAI_PROJECT;
  for (const key of codexOpts.unsetEnvKeys || []) {
    delete process.env[key];
  }
  Object.assign(process.env, codexOpts.env || {});
  codexOpts.config = {
    ...(codexOpts.config || {}),
    features: {
      ...(codexOpts.config?.features || {}),
      child_agents_md: true,
      multi_agent: true,
      memories: true,
      undo: true,
      steer: true,
    },
  };
  const codex = new CodexClass(codexOpts);
  const thread = codex.startThread({
    sandboxMode: sandboxPolicy,
    workingDirectory: cwd,
    skipGitRepoCheck: true,
    approvalPolicy: "never",
    webSearchMode: "live",
  });

  if (!thread) {
    return {
      success: false,
      output: "",
      items: [],
      error:
        "Codex SDK startThread() returned null — SDK may be misconfigured or API unreachable",
      sdk: "codex",
      threadId: null,
    };
  }
  emitThreadReady(thread.id || null);

  // Register active session for mid-execution steering
  if (steerKey) {
    registerActiveSession(steerKey, "codex", thread.id || null, (steerPrompt) => {
      // Codex steering: send a follow-up message to the live thread
      // Note: the thread is consumed in the streaming loop below, so
      // additional runStreamed calls are queued by the SDK
      thread
        .runStreamed(sanitizeAndBoundPrompt(steerPrompt), {
          signal: controller?.signal,
        })
        .catch(() => {});
    }, {
      parentSessionId: extra.parentSessionId || null,
      rootSessionId: extra.rootSessionId || extra.parentSessionId || steerKey,
    });
  }

  // ── 3. Timeout / abort wiring ────────────────────────────────────────────
  const { controller, cleanup: clearAbortScope } = createScopedAbortController(
    externalAC,
    timeoutMs,
  );

  // Hard timeout: safety net if the SDK's async iterator ignores AbortSignal.
  // Fires HARD_TIMEOUT_BUFFER_MS after the soft timeout to forcibly break the loop.
  let hardTimer;
  let firstEventTimer = null;
  let firstEventTimeoutHit = false;
  let eventCount = 0;

  // ── 4. Stream the turn ───────────────────────────────────────────────────
  try {
    const streamSafety = resolveCodexStreamSafety(timeoutMs);
    const anchoredPrompt = String(systemPrompt || "").trim()
      ? `${String(systemPrompt).trim()}\n\n---\n\n${prompt}`
      : prompt;
    const safePrompt = sanitizeAndBoundPrompt(`${anchoredPrompt}${TOOL_OUTPUT_GUARDRAIL}`);
    const turn = await Promise.race([
      thread.runStreamed(safePrompt, {
        signal: controller.signal,
      }),
      new Promise((_, reject) => {
        hardTimer = setTimeout(
          () => reject(new Error("hard_timeout")),
          clampTimerDelayMs(timeoutMs + HARD_TIMEOUT_BUFFER_MS, "codex-hard-timeout"),
        );
      }),
    ]);

    let finalResponse = "";
    const allItems = [];
    let droppedItems = 0;
    // Race the event iterator against a hard timeout.
    // The soft timeout fires controller.abort() which the SDK should honor.
    // The hard timeout is a safety net in case the SDK iterator ignores the abort.
    const hardTimeoutPromise = new Promise((_, reject) => {
      if (hardTimer) return;
      hardTimer = setTimeout(
        () => reject(new Error("hard_timeout")),
        clampTimerDelayMs(timeoutMs + HARD_TIMEOUT_BUFFER_MS, "codex-hard-timeout"),
      );
    });

    const iterateEvents = async () => {
      for await (const event of turn.events) {
        eventCount += 1;
        if (firstEventTimer) {
          clearTimeout(firstEventTimer);
          firstEventTimer = null;
        }
        if (controller.signal.aborted) break;
        if (event?.type === "thread.started" && event?.thread_id) {
          emitThreadReady(event.thread_id);
        }
        if (typeof onEvent === "function") {
          try {
            onEvent(event);
          } catch {
            /* caller errors must not kill stream */
          }
        }
        if (event.type === "item.completed") {
          if (allItems.length < streamSafety.maxItemsPerTurn) {
            allItems.push(event.item);
          } else {
            droppedItems += 1;
          }
          if (event.item.type === "agent_message" && event.item.text) {
            finalResponse += event.item.text + "\n";
          }
        }
      }
    };

    const firstEventTimeoutMs = streamSafety.firstEventTimeoutMs;
    if (firstEventTimeoutMs) {
      firstEventTimer = setTimeout(() => {
        if (eventCount > 0 || controller.signal.aborted) return;
        firstEventTimeoutHit = true;
        controller.abort("first_event_timeout");
      }, firstEventTimeoutMs);
      if (typeof firstEventTimer.unref === "function") firstEventTimer.unref();
    }

    await Promise.race([iterateEvents(), hardTimeoutPromise]);
    clearTimeout(hardTimer);
    if (firstEventTimer) clearTimeout(firstEventTimer);
    clearAbortScope();

    const finalizedItems = await finalizeBufferedTurnItems(allItems, {
      maxItems: streamSafety.maxItemsPerTurn,
      maxItemChars: streamSafety.maxItemChars,
      droppedItems,
    });

    const output =
      finalResponse.trim() || "(Agent completed with no text output)";
    const explicitCompletionSignal = hasExplicitCompletionSignal({
      output,
      items: allItems,
    });
    if (steerKey) unregisterActiveSession(steerKey);
    return {
      success: true,
      output,
      items: finalizedItems.items,
      error: null,
      sdk: "codex",
      threadId: thread.id || null,
      _hasExplicitCompletionSignal: explicitCompletionSignal,
      hotPath: {
        exec: finalizedItems.hotPath,
      },
    };
  } catch (err) {
    clearAbortScope();
    if (hardTimer) clearTimeout(hardTimer);
    if (firstEventTimer) clearTimeout(firstEventTimer);
    if (steerKey) unregisterActiveSession(steerKey);
    const isTimeout =
      err.name === "AbortError" ||
      String(err) === "timeout" ||
      err.message === "hard_timeout";
    if (isTimeout) {
      const firstEventSuffix = firstEventTimeoutHit
        ? ` (no events received within ${getFirstEventTimeoutMs(timeoutMs)}ms)`
        : "";
      return {
        success: false,
        output: "",
        items: [],
        error: `${TAG} codex timeout after ${timeoutMs}ms${err.message === "hard_timeout" ? " (hard timeout — SDK iterator unresponsive)" : ""}${firstEventSuffix}`,
        sdk: "codex",
        threadId: null,
      };
    }
    // ── Transient stream / network error ─ retry without resetting thread state ─
    if (isTransientStreamError(err)) {
      const retryAttempt = (extra._streamRetryAttempt || 0) + 1;
      if (retryAttempt < MAX_STREAM_RETRIES) {
        const delay = streamRetryDelay(retryAttempt - 1);
        console.warn(
          `${TAG} codex transient stream error (attempt ${retryAttempt}/${MAX_STREAM_RETRIES}): ${err.message || err} — retrying in ${Math.round(delay)}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
        return launchCodexThread(prompt, cwd, timeoutMs, {
          ...extra,
          _streamRetryAttempt: retryAttempt,
        });
      }
      console.error(
        `${TAG} codex stream disconnection not resolved after ${MAX_STREAM_RETRIES} attempts`,
      );
    }
    return {
      success: false,
      output: "",
      items: [],
      error: err.message,
      sdk: "codex",
      threadId: null,
    };
  }
}

/**
 * Build CLI arguments for ephemeral Copilot agent-pool sessions.
 * Mirrors copilot-shell.mjs buildCliArgs() for feature parity.
 */
function buildPoolCopilotCliArgs(mcpConfigPath) {
  const args = [];
  if (!envFlagEnabled(process.env.COPILOT_NO_EXPERIMENTAL)) {
    args.push("--experimental");
  }
  if (!envFlagEnabled(process.env.COPILOT_NO_ALLOW_ALL)) {
    args.push("--allow-all");
  }
  if (!envFlagEnabled(process.env.COPILOT_ENABLE_ASK_USER)) {
    args.push("--no-ask-user");
  }
  args.push("--no-auto-update");
  if (envFlagEnabled(process.env.COPILOT_ENABLE_ALL_GITHUB_MCP_TOOLS)) {
    args.push("--enable-all-github-mcp-tools");
  }
  if (envFlagEnabled(process.env.COPILOT_DISABLE_BUILTIN_MCPS)) {
    args.push("--disable-builtin-mcps");
  }
  // MCP config: prefer per-launch resolved config, fall back to env var
  const effectiveMcpConfig = mcpConfigPath || process.env.COPILOT_ADDITIONAL_MCP_CONFIG;
  if (effectiveMcpConfig) {
    args.push("--additional-mcp-config", effectiveMcpConfig);
  }
  return args;
}

/**
 * Auto-respond to agent user-input requests in pool sessions.
 * Ensures ephemeral agents never block waiting for human input.
 */
function autoRespondToUserInput(request) {
  if (request.choices && request.choices.length > 0) {
    return { answer: request.choices[0], wasFreeform: false };
  }
  const question = (request.question || "").toLowerCase();
  if (/\b(y\/n|yes\/no|confirm|proceed|continue)\b/i.test(question)) {
    return { answer: "yes", wasFreeform: true };
  }
  return {
    answer: "Proceed with your best judgment. Do not wait for human input.",
    wasFreeform: true,
  };
}

function createAbortReasonError(reason = "timeout") {
  const message = String(reason || "").trim() || "timeout";
  const error = new Error(message);
  error.name = "AbortError";
  error.abortReason = message;
  return error;
}

/**
 * Launch a single ephemeral prompt via the **Copilot SDK**.
 *
 * Creates a `CopilotClient` in LOCAL mode (stdio), starts it, resumes an
 * existing session when available, otherwise creates a new one, sends the
 * prompt, and collects the response.
 *
 * LOCAL mode ensures:
 * - Full model access (gpt-5.3-codex, claude-sonnet-4.5, etc.)
 * - MCP tool availability
 * - Sub-agent support
 * - No background session restrictions
 *
 * @param {string}  prompt     Prompt text.
 * @param {string}  cwd        Working directory.
 * @param {number}  timeoutMs  Abort timeout in ms.
 * @param {object}  extra      Optional { onEvent, abortController, resumeThreadId, onThreadReady }.
 * @returns {Promise<{ success: boolean, output: string, items: Array, error: string|null, sdk: string }>}
 */
async function launchCopilotThread(prompt, cwd, timeoutMs, extra = {}) {
  // Coerce to number — prevents string concatenation in setTimeout arithmetic
  timeoutMs = Number(timeoutMs) || DEFAULT_TIMEOUT_MS;
  const {
    onEvent,
    abortController: externalAC,
    resumeThreadId = null,
    onThreadReady = null,
    model: requestedModel = null,
    taskKey: steerKey = null,
    envOverrides = null,
  } = extra;

  // ── 1. Load the SDK ──────────────────────────────────────────────────────
  let CopilotClientClass;
  try {
    const mod = await importCopilotSdkModule();
    CopilotClientClass = mod.CopilotClient || mod.default?.CopilotClient;
    if (!CopilotClientClass) throw new Error("CopilotClient export not found");
  } catch (err) {
    return {
      success: false,
      output: "",
      items: [],
      error: `Copilot SDK not available: ${err.message}`,
      sdk: "copilot",
      threadId: null,
    };
  }

  const runtimeEnv =
    envOverrides && typeof envOverrides === "object"
      ? { ...process.env, ...envOverrides }
      : process.env;
  const runtimeSessionEnv = applyNodeWarningSuppressionEnv(runtimeEnv);

  // ── 3. Create & start ephemeral client (LOCAL mode) ──────────────────────
  // Use stdio transport (local) by default for full model/tool access.
  // Only use cliUrl (remote) if COPILOT_SESSION_MODE=remote is explicit.
  const sessionMode = (process.env.COPILOT_SESSION_MODE || "local").trim().toLowerCase();
  const cliUrl = process.env.COPILOT_CLI_URL || undefined;

  const { controller, cleanup: clearAbortScope } = createScopedAbortController(
    externalAC,
    timeoutMs,
  );

  let client;
  let unsubscribe = null;
  let stopCopilotFirstEventWatch = null;
  let finalResponse = "";
  let currentCopilotTurnText = "";
  let completedCopilotTurnText = "";
  let handleCopilotRawSendEvent = null;
  const allItems = [];
  const autoApprovePermissions = shouldAutoApproveCopilotPermissions();
  const clientEnv = autoApprovePermissions
    ? {
        ...runtimeSessionEnv,
        COPILOT_ALLOW_ALL: runtimeSessionEnv.COPILOT_ALLOW_ALL || "true",
      }
    : runtimeSessionEnv;
  try {
    await withSanitizedOpenAiEnv(async () => {
      let clientOpts;
      if (sessionMode === "remote" && cliUrl) {
        // Remote mode: connect to existing server (limited model/tool access)
        clientOpts = { cliUrl, env: clientEnv };
      } else {
        const localAuth = await resolveCopilotSdkAuthOptions({
          env: runtimeSessionEnv,
        });
        // Local mode (default): stdio for full capability
        // Write temp MCP config if resolved MCP servers are available
        let mcpConfigPath = null;
        if (extra._resolvedMcpServers?.length) {
          try {
            const registry = await getMcpRegistry();
            mcpConfigPath = registry.writeTempCopilotMcpConfig(cwd, extra._resolvedMcpServers);
          } catch (mcpErr) {
            console.warn(`${TAG} copilot MCP config write failed (non-fatal): ${mcpErr.message}`);
          }
        }
        const cliLaunch = resolveCopilotCliLaunchConfig({
          env: runtimeSessionEnv,
          repoRoot: REPO_ROOT,
          cliArgs: buildPoolCopilotCliArgs(mcpConfigPath),
        });
        clientOpts = {
          cwd,
          env: clientEnv,
          cliArgs: cliLaunch.cliArgs,
          useStdio: true,
        };
        if (localAuth?.githubToken) {
          clientOpts.githubToken = localAuth.githubToken;
          clientOpts.token = localAuth.token;
        }
        if (typeof localAuth?.useLoggedInUser === "boolean") {
          clientOpts.useLoggedInUser = localAuth.useLoggedInUser;
        }
        if (cliLaunch.cliPath) clientOpts.cliPath = cliLaunch.cliPath;
      }
      client = new CopilotClientClass(clientOpts);
      await client.start();
    });
  } catch (err) {
    clearAbortScope();
    return {
      success: false,
      output: "",
      items: [],
      error: `Copilot client start failed: ${err.message}`,
      sdk: "copilot",
      threadId: null,
    };
  }

  // ── 4. Resume/create session ─────────────────────────────────────────────
  try {
    const sessionConfig = {
      streaming: true,
      workingDirectory: cwd,
      systemMessage: {
        mode: "replace",
        content:
          "You are an ephemeral task agent. Execute the given task immediately. " +
          "Do NOT ask for confirmation. Produce concise, actionable output. " +
          "You are running in Windows PowerShell, not bash. Use PowerShell-native commands and syntax; " +
          "do not use Unix utilities like head/tail/grep or shell operators like &&. " +
          "The working directory is already the target repo/worktree, so prefer commands that run in the current directory instead of nesting git -C <path> calls. " +
          "In Git worktrees, `.git` may be a file that points at the real gitdir; treat that as normal and run git commands from the current directory instead of trying to inspect `.git` as a standalone repo. " +
          "After you have enough evidence or have completed the requested work, stop and return a compact final status instead of continuing to explore.",
      },
      infiniteSessions: { enabled: true },
      // Auto-respond to user input requests — agent should never block
      onUserInputRequest: autoRespondToUserInput,
    };
    const permissionHandler = buildCopilotPermissionHandler();
    if (permissionHandler) {
      sessionConfig.onPermissionRequest = permissionHandler;
    }
    const copilotModel = String(
      requestedModel ||
        process.env.COPILOT_MODEL ||
        process.env.COPILOT_SDK_MODEL ||
        "",
    ).trim();
    if (copilotModel) sessionConfig.model = copilotModel;

    // Reasoning effort: pass through if model supports it
    const effort = (
      process.env.COPILOT_REASONING_EFFORT ||
      process.env.COPILOT_SDK_REASONING_EFFORT ||
      ""
    ).toLowerCase();
    if (["low", "medium", "high", "xhigh"].includes(effort)) {
      sessionConfig.reasoningEffort = effort;
    }

    let session = null;
    if (resumeThreadId && typeof client.resumeSession === "function") {
      try {
        session = await client.resumeSession(resumeThreadId, sessionConfig);
      } catch (resumeErr) {
        console.warn(
          `${TAG} copilot resume failed for session ${resumeThreadId}: ${resumeErr.message || resumeErr}. Starting fresh session.`,
        );
      }
    }
    if (!session) {
      session = await client.createSession(sessionConfig);
    }
    const copilotSessionId =
      session?.sessionId || session?.id || resumeThreadId || null;
    if (copilotSessionId && typeof onThreadReady === "function") {
      try {
        onThreadReady(copilotSessionId, "copilot");
      } catch {
        /* best effort */
      }
    }

    // Register active session for mid-execution steering
    if (steerKey && session) {
      const hasSendMethod = typeof session.send === "function";
      if (hasSendMethod) {
        registerActiveSession(steerKey, "copilot", copilotSessionId, (steerPrompt) => {
          session.send({ prompt: steerPrompt }).catch(() => {});
        }, {
          parentSessionId: extra.parentSessionId || null,
          rootSessionId: extra.rootSessionId || extra.parentSessionId || steerKey,
        });
      }
    }

    // ── 5. Send prompt & collect response ──────────────────────────────────
    // Wire up event listener if session supports it
    if (typeof session.on === "function") {
      unsubscribe = session.on((event) => {
        if (!event) return;
        allItems.push(event);
        if (event.type === "assistant.turn_start") {
          currentCopilotTurnText = "";
        }
        if (event.type === "assistant.reasoning" && event.data?.content) {
          currentCopilotTurnText = mergeAssistantText(currentCopilotTurnText, event.data.content);
        }
        if (
          (event.type === "assistant.reasoning_delta"
            || event.type === "assistant.message_delta")
          && event.data?.deltaContent
        ) {
          currentCopilotTurnText = mergeAssistantText(
            currentCopilotTurnText,
            event.data.deltaContent,
          );
        }
        if (event.type === "assistant.message") {
          currentCopilotTurnText = mergeAssistantText(
            currentCopilotTurnText,
            event.data?.reasoningText || "",
          );
          currentCopilotTurnText = mergeAssistantText(
            currentCopilotTurnText,
            event.data?.content || "",
          );
          if (event.data?.content) {
            finalResponse = event.data.content;
          } else if (!finalResponse.trim() && currentCopilotTurnText.trim()) {
            finalResponse = currentCopilotTurnText.trim();
          }
        }
        if (event.type === "assistant.turn_end") {
          const settledTurnText = String(currentCopilotTurnText || "").trim();
          if (settledTurnText) {
            completedCopilotTurnText = settledTurnText;
            finalResponse = settledTurnText;
          }
        }
        if (!finalResponse.trim() && completedCopilotTurnText.trim()) {
          finalResponse = completedCopilotTurnText.trim();
        }
        if (typeof handleCopilotRawSendEvent === "function") {
          try {
            handleCopilotRawSendEvent(event);
          } catch {
            /* best effort */
          }
        }
        if (typeof onEvent === "function") {
          try {
            onEvent(event);
          } catch {
            /* best effort */
          }
        }
      });
    }

    const formattedPrompt =
      `# ${extractTaskHeading(prompt)}\n\n${prompt}\n\n---\n` +
      'Do NOT respond with "Ready" or ask what to do. EXECUTE this task.';

    const hasSend = typeof session.send === "function";
    const hasSendAndWait = typeof session.sendAndWait === "function";
    if (!hasSend && !hasSendAndWait) {
      throw new Error("Copilot session does not support send");
    }

    // Prefer send()+idle when available. Some Copilot SDK builds enforce a
    // fixed internal 300s idle timeout in sendAndWait() that ignores caller
    // timeout, which can cause monitor-monitor failover loops.
    const useRawSend = hasSend;
    const sendPromise = useRawSend
      ? session.send.call(session, { prompt: formattedPrompt })
      : session.sendAndWait.call(
          session,
          { prompt: formattedPrompt },
          timeoutMs,
        );

    if (useRawSend && typeof session.on === "function") {
      await new Promise((resolveP, rejectP) => {
        let settled = false;
        let off = null;
        let idleTimer = null;
        let turnSettleTimer = null;

        const clearTurnSettleTimer = () => {
          if (turnSettleTimer) {
            clearTimeout(turnSettleTimer);
            turnSettleTimer = null;
          }
        };

        const armTurnSettleTimer = () => {
          const candidateOutput = String(
            finalResponse || completedCopilotTurnText || currentCopilotTurnText || "",
          ).trim();
          if (!candidateOutput) return;
          clearTurnSettleTimer();
          turnSettleTimer = setTimeout(() => {
            finish(resolveP);
          }, COPILOT_TURN_SETTLE_MS);
          if (turnSettleTimer && typeof turnSettleTimer.unref === "function") {
            turnSettleTimer.unref();
          }
        };

        const finish = (cb) => {
          if (settled) return;
          settled = true;
          if (idleTimer) clearTimeout(idleTimer);
          clearTurnSettleTimer();
          if (typeof off === "function") off();
          handleCopilotRawSendEvent = null;
          cb();
        };

        const idleHandler = (event) => {
          if (event?.type === "session.idle") return finish(resolveP);
          if (event?.type === "session.error") {
            return finish(() =>
              rejectP(new Error(event.data?.message || "session error")),
            );
          }
        };
        off = session.on(idleHandler);
        handleCopilotRawSendEvent = (event) => {
          const eventType = String(event?.type || "");
          if (!eventType) return;
          if (
            eventType === "assistant.turn_start"
            || eventType === "assistant.message"
            || eventType === "assistant.message_delta"
            || eventType === "assistant.reasoning"
            || eventType === "assistant.reasoning_delta"
            || eventType === "assistant.streaming_delta"
            || eventType === "tool.execution_start"
            || eventType === "tool.execution_partial_result"
            || eventType === "permission.requested"
          ) {
            clearTurnSettleTimer();
            return;
          }
          if (eventType === "assistant.turn_end") {
            armTurnSettleTimer();
          }
        };
        Promise.resolve(sendPromise).catch((err) => finish(() => rejectP(err)));

        // Wire abort signal into this inner promise
        if (controller.signal) {
          const onAbort = () =>
            finish(() => rejectP(createAbortReasonError(controller.signal.reason || "timeout")));
          if (controller.signal.aborted) {
            onAbort();
          } else {
            controller.signal.addEventListener("abort", onAbort, {
              once: true,
            });
          }
        }

        idleTimer = setTimeout(() => {
          // If assistant output arrived but session.idle is missing/late, allow
          // the run to continue rather than stalling for the full hard timeout.
          if (finalResponse.trim()) return finish(resolveP);
          finish(() => rejectP(new Error("timeout_waiting_for_idle")));
        }, clampTimerDelayMs(timeoutMs + 1000, "copilot-idle-timeout"));
        if (idleTimer && typeof idleTimer.unref === "function") {
          idleTimer.unref();
        }
      });
    } else {
      // Hard timeout safety net for sendAndWait — mirrors the Codex SDK path.
      // If sendAndWait ignores the abort signal, this forcibly breaks the hang.
      const copilotHardTimeout = new Promise((_, reject) => {
        const ht = setTimeout(
          () => reject(new Error("hard_timeout")),
          clampTimerDelayMs(timeoutMs + HARD_TIMEOUT_BUFFER_MS, "copilot-hard-timeout"),
        );
        // Don't let this timer keep the process alive
        if (ht && typeof ht.unref === "function") ht.unref();
      });
      // Some Copilot SDK builds can stall sendAndWait without yielding any
      // events. Apply an early watchdog so we can fail over before the full
      // task timeout elapses.
      let copilotFirstEventTimeoutMs = null;
      const firstEventWatch =
        typeof session.on === "function"
          ? new Promise((_, reject) => {
              copilotFirstEventTimeoutMs = getFirstEventTimeoutMs(timeoutMs);
              if (!Number.isFinite(copilotFirstEventTimeoutMs) || copilotFirstEventTimeoutMs <= 0) {
                return;
              }
              let settled = false;
              let off = null;
              const timer = setTimeout(() => {
                settled = true;
                if (typeof off === "function") off();
                reject(new Error("timeout_no_events"));
              }, clampTimerDelayMs(copilotFirstEventTimeoutMs, "copilot-first-event-timeout"));
              if (timer && typeof timer.unref === "function") timer.unref();
              off = session.on((event) => {
                if (settled) return;
                if (!event || typeof event !== "object") return;
                const t = String(event.type || "");
                if (
                  t === "assistant.message" ||
                  t === "assistant.message_delta" ||
                  t === "session.idle" ||
                  t === "session.error"
                ) {
                  settled = true;
                  clearTimeout(timer);
                  if (typeof off === "function") off();
                }
              });
              stopCopilotFirstEventWatch = () => {
                settled = true;
                clearTimeout(timer);
                if (typeof off === "function") off();
              };
            })
          : null;
      await Promise.race(
        [sendPromise, copilotHardTimeout, firstEventWatch].filter(Boolean),
      );
    }

    const output =
      finalResponse.trim()
      || completedCopilotTurnText.trim()
      || currentCopilotTurnText.trim()
      || "(Agent completed with no text output)";
    return {
      success: true,
      output,
      items: allItems,
      error: null,
      sdk: "copilot",
      threadId: copilotSessionId,
      _hasExplicitCompletionSignal: hasExplicitCompletionSignal({
        output,
        items: allItems,
      }),
    };
  } catch (err) {
    const errMsg = String(err?.message || err || "");
    const abortReason = String(
      err?.abortReason
      || (controller.signal?.aborted ? controller.signal.reason : "")
      || "",
    ).trim();
    const hasAssistantOutput = !!finalResponse.trim();
    const isIdleWaitTimeout =
      /session\.idle/i.test(errMsg) && /timeout/i.test(errMsg);
    const isFirstEventTimeout =
      errMsg === "timeout_no_events"
      || errMsg === "first_event_timeout"
      || abortReason === "first_event_timeout";
    const isTimeout =
      err?.name === "AbortError" ||
      errMsg === "timeout" ||
      errMsg === "hard_timeout" ||
      errMsg === "timeout_no_events" ||
      errMsg === "timeout_waiting_for_idle" ||
      errMsg === "first_event_timeout" ||
      abortReason === "first_event_timeout" ||
      isIdleWaitTimeout;

    // Copilot SDK can occasionally emit the full assistant message but still
    // reject sendAndWait() due to a missing/late session.idle event. In that
    // case, keep the run progressing by accepting the captured assistant output.
    if (isIdleWaitTimeout && hasAssistantOutput) {
      console.warn(
        `${TAG} copilot sendAndWait timed out waiting for session.idle, but assistant output was received; accepting response`,
      );
      return {
        success: true,
        output: finalResponse.trim(),
        items: allItems,
        error: null,
        sdk: "copilot",
        threadId: resumeThreadId,
        _hasExplicitCompletionSignal: hasExplicitCompletionSignal({
          output: finalResponse.trim(),
          items: allItems,
        }),
      };
    }

    if (isTimeout) {
      const firstEventTimeoutMs = getFirstEventTimeoutMs(timeoutMs);
      const noEventsSuffix = isFirstEventTimeout
        ? ` (no events received within ${firstEventTimeoutMs}ms)`
        : "";
      const timeoutHeadline = isFirstEventTimeout
        ? `${TAG} copilot first_event_timeout after ${firstEventTimeoutMs}ms`
        : `${TAG} copilot timeout after ${timeoutMs}ms${isIdleWaitTimeout ? " waiting for session.idle" : ""}`;
      return {
        success: false,
        output: "",
        items: allItems,
        error: `${timeoutHeadline}${noEventsSuffix}`,
        sdk: "copilot",
        threadId: resumeThreadId,
      };
    }
    // ── Transient stream / network error ─ retry with a fresh Copilot session ─
    if (!isTimeout && !isIdleWaitTimeout && isTransientStreamError(err)) {
      const retryAttempt = (extra._streamRetryAttempt || 0) + 1;
      if (retryAttempt < MAX_STREAM_RETRIES) {
        const delay = streamRetryDelay(retryAttempt - 1);
        console.warn(
          `${TAG} copilot transient stream error (attempt ${retryAttempt}/${MAX_STREAM_RETRIES}): ${errMsg} — retrying in ${Math.round(delay)}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
        return launchCopilotThread(prompt, cwd, timeoutMs, {
          ...extra,
          _streamRetryAttempt: retryAttempt,
        });
      }
      console.error(
        `${TAG} copilot stream disconnection not resolved after ${MAX_STREAM_RETRIES} attempts`,
      );
    }
    return {
      success: false,
      output: "",
      items: allItems,
      error: errMsg || "unknown copilot error",
      sdk: "copilot",
      threadId: resumeThreadId,
    };
  } finally {
    try {
      if (typeof stopCopilotFirstEventWatch === "function") {
        stopCopilotFirstEventWatch();
      }
    } catch {
      /* best effort */
    }
    clearAbortScope();
    if (steerKey) unregisterActiveSession(steerKey);
    try {
      if (typeof unsubscribe === "function") unsubscribe();
    } catch {
      /* ignore */
    }
    // Best-effort teardown — don't let cleanup errors propagate
    try {
      if (client && typeof client.stop === "function") client.stop();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Resume an existing Copilot session and run a follow-up prompt.
 * Falls back to fresh session if resume fails.
 *
 * @param {string} threadId
 * @param {string} prompt
 * @param {string} cwd
 * @param {number} timeoutMs
 * @param {object} extra
 * @returns {Promise<{ success: boolean, output: string, items: Array, error: string|null, sdk: string, threadId: string|null }>}
 */
async function resumeCopilotThread(
  threadId,
  prompt,
  cwd,
  timeoutMs,
  extra = {},
) {
  return launchCopilotThread(prompt, cwd, timeoutMs, {
    ...extra,
    resumeThreadId: threadId,
  });
}

/**
 * Launch a single ephemeral prompt via the **Claude Agent SDK**.
 *
 * Creates a fresh message queue, pushes the user message, iterates the
 * response stream, and collects text output.  Fully ephemeral — no session
 * reuse.
 *
 * @param {string}  prompt     Prompt text.
 * @param {string}  cwd        Working directory.
 * @param {number}  timeoutMs  Abort timeout in ms.
 * @param {object}  extra      Optional { onEvent, abortController, resumeThreadId, onThreadReady }.
 * @returns {Promise<{ success: boolean, output: string, items: Array, error: string|null, sdk: string }>}
 */
async function launchClaudeThread(prompt, cwd, timeoutMs, extra = {}) {
  // Coerce to number — prevents string concatenation in setTimeout arithmetic
  timeoutMs = Number(timeoutMs) || DEFAULT_TIMEOUT_MS;
  const {
    onEvent,
    abortController: externalAC,
    claudeAllowedTools = null,
    claudePermissionMode = null,
    resumeThreadId = null,
    onThreadReady = null,
    model: requestedModel = null,
    taskKey: steerKey = null,
    envOverrides = null,
    systemPrompt = "",
  } = extra;

  // ── 1. Load the SDK ──────────────────────────────────────────────────────
  let queryFn;
  try {
    const mod = await importClaudeSdkModule();
    queryFn = mod.query;
    if (!queryFn) throw new Error("query() not found in Claude SDK");
  } catch (err) {
    return {
      success: false,
      output: "",
      items: [],
      error: `Claude SDK not available: ${err.message}`,
      sdk: "claude",
      threadId: null,
    };
  }

  // ── 2. Detect auth ──────────────────────────────────────────────────────
  const runtimeEnv =
    envOverrides && typeof envOverrides === "object"
      ? { ...process.env, ...envOverrides }
      : process.env;
  const runtimeSessionEnv = applyNodeWarningSuppressionEnv(runtimeEnv);
  const apiKey =
    runtimeSessionEnv.ANTHROPIC_API_KEY ||
    runtimeSessionEnv.CLAUDE_API_KEY ||
    runtimeSessionEnv.CLAUDE_KEY ||
    undefined;

  // ── 3. Build message queue ───────────────────────────────────────────────
  const { controller, cleanup: clearAbortScope } = createScopedAbortController(
    externalAC,
    timeoutMs,
  );
  // Hard timeout: force-break Promise.race if SDK ignores abort signal
  const hardTimeoutMs = timeoutMs + HARD_TIMEOUT_BUFFER_MS;
  let hardTimer = null;

  /**
   * Minimal async message queue for the Claude SDK streaming interface.
   * @returns {{ iterator: Function, push: Function, close: Function }}
   */
  function createMessageQueue() {
    const q = [];
    let resolver = null;
    let closed = false;

    async function* iterator() {
      while (true) {
        if (q.length > 0) {
          yield q.shift();
          continue;
        }
        if (closed) return;
        // Wire abort signal: if the controller fires while we're waiting
        // for the next message, break out of the wait instead of hanging forever.
        await new Promise((r) => {
          resolver = r;
          if (controller.signal) {
            const onAbort = () => {
              closed = true;
              r();
            };
            if (controller.signal.aborted) {
              closed = true;
              r();
              return;
            }
            controller.signal.addEventListener("abort", onAbort, {
              once: true,
            });
          }
        });
        resolver = null;
      }
    }
    function push(msg) {
      if (closed) return false;
      q.push(msg);
      if (resolver) {
        resolver();
        resolver = null;
      }
      return true;
    }
    function close() {
      closed = true;
      if (resolver) {
        resolver();
        resolver = null;
      }
    }
    return { iterator, push, close };
  }

  /**
   * Build a Claude-format user message.
   * @param {string} text
   * @returns {object}
   */
  function makeUserMessage(text) {
    return {
      type: "user",
      session_id: resumeThreadId || "",
      message: {
        role: "user",
        content: [{ type: "text", text }],
      },
      parent_tool_use_id: null,
    };
  }

  // ── 4. Execute query ─────────────────────────────────────────────────────
  // Inject MCP server config for Claude via environment variable
  let _claudeMcpEnvCleanup = null;
  if (extra._resolvedMcpServers?.length) {
    try {
      const registry = await getMcpRegistry();
      const { envVar } = registry.buildClaudeMcpEnv(extra._resolvedMcpServers);
      if (envVar) {
        const prev = process.env.CLAUDE_MCP_SERVERS;
        process.env.CLAUDE_MCP_SERVERS = envVar;
        _claudeMcpEnvCleanup = () => {
          if (prev === undefined) {
            delete process.env.CLAUDE_MCP_SERVERS;
          } else {
            process.env.CLAUDE_MCP_SERVERS = prev;
          }
        };
      }
    } catch (mcpErr) {
      console.warn(`${TAG} claude MCP env setup failed (non-fatal): ${mcpErr.message}`);
    }
  }
  try {
    const msgQueue = createMessageQueue();

    const formattedPrompt =
      `# ${extractTaskHeading(prompt)}\n\n${prompt}\n\n---\n` +
      'Do NOT respond with "Ready" or ask what to do. EXECUTE this task.';

    const anchoredPrompt = String(systemPrompt || "").trim()
      ? `${String(systemPrompt).trim()}\n\n---\n\n${formattedPrompt}`
      : formattedPrompt;
    msgQueue.push(makeUserMessage(anchoredPrompt));

    // Register active session for mid-execution steering (Claude uses message queue)
    if (steerKey) {
      registerActiveSession(steerKey, "claude", resumeThreadId, (steerPrompt) => {
        msgQueue.push(makeUserMessage(steerPrompt));
      }, {
        parentSessionId: extra.parentSessionId || null,
        rootSessionId: extra.rootSessionId || extra.parentSessionId || steerKey,
      });
    }

    const normalizeList = (value) => {
      if (Array.isArray(value)) {
        return value.map((entry) => String(entry || "").trim()).filter(Boolean);
      }
      return String(value || "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    };

    /** @type {object} */
    const options = {
      cwd,
      settingSources: ["user", "project"],
      permissionMode:
        claudePermissionMode ||
        runtimeSessionEnv.CLAUDE_PERMISSION_MODE ||
        "bypassPermissions",
    };
    if (apiKey) options.apiKey = apiKey;
    const explicitAllowedTools = normalizeList(claudeAllowedTools);
    const allowedTools = explicitAllowedTools.length
      ? explicitAllowedTools
      : normalizeList(runtimeSessionEnv.CLAUDE_ALLOWED_TOOLS);
    if (allowedTools.length) {
      options.allowedTools = allowedTools;
    }

    const model = String(
      requestedModel ||
        runtimeSessionEnv.CLAUDE_MODEL ||
        runtimeSessionEnv.CLAUDE_CODE_MODEL ||
        runtimeSessionEnv.ANTHROPIC_MODEL ||
        "",
    ).trim();
    if (model) options.model = model;

    const result = await withTemporaryEnv(runtimeSessionEnv, async () =>
      queryFn({
        prompt: msgQueue.iterator(),
        options,
      }),
    );

    let finalResponse = "";
    let activeClaudeSessionId = resumeThreadId || null;
    const allItems = [];

    // Wrap SDK execution in Promise.race to enforce hard timeout even if
    // the SDK's async iterator ignores the abort signal.
    const sdkExecution = (async () => {
      for await (const message of result) {
        // Check abort signal on every iteration
        if (controller.signal.aborted) {
          msgQueue.close();
          throw new Error("timeout");
        }

        const messageSessionId =
          message?.session_id || message?.sessionId || null;
        if (messageSessionId && messageSessionId !== activeClaudeSessionId) {
          activeClaudeSessionId = messageSessionId;
          if (typeof onThreadReady === "function") {
            try {
              onThreadReady(messageSessionId, "claude");
            } catch {
              /* best effort */
            }
          }
        }

        // Extract text from assistant messages
        const contentBlocks =
          message?.message?.content || message?.content || [];

        if (message?.type === "assistant" && Array.isArray(contentBlocks)) {
          for (const block of contentBlocks) {
            if (block?.type === "text" && block.text) {
              finalResponse += block.text + "\n";
            }
          }
        }

        // Normalise to item-style events for the onEvent callback
        const syntheticEvent = { type: message?.type || "unknown", message };
        allItems.push(syntheticEvent);
        if (typeof onEvent === "function") {
          try {
            onEvent(syntheticEvent);
          } catch {
            /* best effort */
          }
        }

        // If the SDK signals completion, close the queue
        if (message?.type === "result") {
          msgQueue.close();
        }
      }
    })();

    const hardTimeout = new Promise((_, reject) => {
      hardTimer = setTimeout(
        () => reject(new Error("hard-timeout")),
        clampTimerDelayMs(hardTimeoutMs, "claude-hard-timeout"),
      );
      if (hardTimer && typeof hardTimer.unref === "function") {
        hardTimer.unref();
      }
    });

    await Promise.race([sdkExecution, hardTimeout]);
    if (hardTimer) clearTimeout(hardTimer);

    clearAbortScope();
    msgQueue.close();
    if (steerKey) unregisterActiveSession(steerKey);

    const output =
      finalResponse.trim() || "(Agent completed with no text output)";
    if (typeof _claudeMcpEnvCleanup === "function") _claudeMcpEnvCleanup();
    return {
      success: true,
      output,
      items: allItems,
      error: null,
      sdk: "claude",
      threadId: activeClaudeSessionId,
      _hasExplicitCompletionSignal: hasExplicitCompletionSignal({
        output,
        items: allItems,
      }),
    };
  } catch (err) {
    if (typeof _claudeMcpEnvCleanup === "function") _claudeMcpEnvCleanup();
    clearAbortScope();
    if (hardTimer) clearTimeout(hardTimer);
    if (steerKey) unregisterActiveSession(steerKey);
    const isTimeout =
      err.name === "AbortError" ||
      String(err).includes("timeout") ||
      String(err.message).includes("timeout");
    if (isTimeout) {
      return {
        success: false,
        output: "",
        items: [],
        error: `${TAG} claude timeout after ${timeoutMs}ms`,
        sdk: "claude",
        threadId: resumeThreadId,
      };
    }
    // ── Transient stream / network error ─ retry with a fresh Claude query ──
    if (isTransientStreamError(err)) {
      const retryAttempt = (extra._streamRetryAttempt || 0) + 1;
      if (retryAttempt < MAX_STREAM_RETRIES) {
        const delay = streamRetryDelay(retryAttempt - 1);
        console.warn(
          `${TAG} claude transient stream error (attempt ${retryAttempt}/${MAX_STREAM_RETRIES}): ${err.message || err} — retrying in ${Math.round(delay)}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
        return launchClaudeThread(prompt, cwd, timeoutMs, {
          ...extra,
          _streamRetryAttempt: retryAttempt,
        });
      }
      console.error(
        `${TAG} claude stream disconnection not resolved after ${MAX_STREAM_RETRIES} attempts`,
      );
    }
    return {
      success: false,
      output: "",
      items: [],
      error: err.message,
      sdk: "claude",
      threadId: resumeThreadId,
    };
  }
}

/**
 * Resume an existing Claude session and run a follow-up prompt.
 * Falls back to fresh session semantics if resume is not supported upstream.
 *
 * @param {string} threadId
 * @param {string} prompt
 * @param {string} cwd
 * @param {number} timeoutMs
 * @param {object} extra
 * @returns {Promise<{ success: boolean, output: string, items: Array, error: string|null, sdk: string, threadId: string|null }>}
 */
async function resumeClaudeThread(
  threadId,
  prompt,
  cwd,
  timeoutMs,
  extra = {},
) {
  return launchClaudeThread(prompt, cwd, timeoutMs, {
    ...extra,
    resumeThreadId: threadId,
  });
}

// ---------------------------------------------------------------------------
// OpenAI Native (Azure / OpenAI Responses / OpenAI-compatible) launcher
// ---------------------------------------------------------------------------

function resolveHarnessNativeSelectionId(envInput = process.env) {
  // 1. Explicit env override always wins
  const envOverride = String(envInput?.BOSUN_HARNESS_NATIVE_SELECTION || "").trim();
  if (envOverride) return envOverride;
  // 2. Inspect harness config for a primary executor whose providerId maps to openai-native
  try {
    const cfg = loadConfig() || {};
    const fabric = readHarnessExecutorFabric(cfg);
    const executors = Array.isArray(fabric.executors) ? fabric.executors : [];
    if (executors.length > 0) {
      const registry = createProviderRegistry({
        adapters: {
          "openai-native": openaiNativeAdapter,
        },
        configExecutors: executors,
        env: envInput,
        includeBuiltins: false,
        preferNativeAdapters: true,
        settings: buildProviderKernelSettings(cfg),
      });
      const providerEntries = registry.listProviders();
      const runnableById = new Map(
        providerEntries
          .filter((entry) => entry?.adapterId === "openai-native" && entry?.auth?.canRun === true)
          .map((entry) => [String(entry.id || "").trim(), entry]),
      );
      const primaryId = String(fabric.primaryExecutorId || "").trim();
      if (primaryId && runnableById.has(primaryId)) {
        return primaryId;
      }
      const fallbackCandidate = executors
        .filter((entry) => entry?.enabled !== false && runnableById.has(String(entry.id || "").trim()))
        .sort((a, b) => Number(b?.weight || 0) - Number(a?.weight || 0))[0];
      if (fallbackCandidate) {
        return String(fallbackCandidate.id || fallbackCandidate.providerId || "").trim();
      }
    }
  } catch {
    // best effort
  }
  try {
    const cfg = loadConfig() || {};
    const harness = cfg.harness || {};
    const executors = Array.isArray(harness.executors) ? harness.executors : [];
    const primaryId = String(harness.primaryExecutor || "").trim();
    if (primaryId) {
      const found = executors.find((e) => String(e?.id || "") === primaryId && e?.enabled !== false);
      if (found) return String(found.id || found.providerId || "").trim();
    }
    // Fall back to the highest-weight enabled executor backed by an openai-native provider
    const candidates = executors
      .filter((e) => e && e.enabled !== false)
      .filter((e) => {
        const pid = String(e.providerId || e.provider || "").trim();
        return pid === "azure-openai-responses"
          || pid === "openai-responses"
          || pid === "openai-compatible";
      })
      .sort((a, b) => Number(b?.weight || 0) - Number(a?.weight || 0));
    if (candidates.length > 0) return String(candidates[0].id || candidates[0].providerId || "").trim();
  } catch {
    // best effort
  }
  return "";
}

function resolveRequestedNativeSelection(extra = {}, envInput = process.env) {
  const providerConfig =
    extra?.providerConfig && typeof extra.providerConfig === "object" && !Array.isArray(extra.providerConfig)
      ? extra.providerConfig
      : null;
  const candidates = [
    providerConfig?.selectionId,
    extra?.selectionId,
    extra?.providerSelection,
    extra?.provider,
    providerConfig?.provider,
    providerConfig?.providerId,
  ];
  for (const candidate of candidates) {
    const normalized = String(candidate || "").trim();
    if (!normalized || normalized === "openai-native") continue;
    return normalized;
  }
  return resolveHarnessNativeSelectionId(envInput);
}

async function launchOpenaiNativeThread(prompt, cwd, timeoutMs, extra = {}) {
  timeoutMs = Number(timeoutMs) || DEFAULT_TIMEOUT_MS;
  const {
    onEvent = null,
    abortController: externalAbortController = null,
    onThreadReady = null,
    resumeThreadId = null,
    envOverrides = null,
    model = null,
    taskKey = null,
  } = extra;
  const providerConfig =
    extra?.providerConfig && typeof extra.providerConfig === "object" && !Array.isArray(extra.providerConfig)
      ? { ...extra.providerConfig }
      : null;
  const normalizedProvider = String(
    extra?.provider || providerConfig?.provider || providerConfig?.providerId || "",
  ).trim() || null;

  const runtimeSessionEnv = injectProviderConfigCredentialEnv(
    envOverrides && typeof envOverrides === "object"
      ? { ...process.env, ...envOverrides }
      : { ...process.env },
    providerConfig,
    normalizedProvider,
  );
  const logicalSessionId = String(
    resumeThreadId
      || extra.sessionId
      || extra.workflowSessionId
      || taskKey
      || "",
  ).trim() || null;
  const persistent = Boolean(logicalSessionId);
  const trimmedModel = String(model || "").trim();
  const selectionId = resolveRequestedNativeSelection({
    ...extra,
    provider: normalizedProvider,
    providerConfig,
  }, runtimeSessionEnv);

  if (persistent && typeof onThreadReady === "function") {
    try {
      onThreadReady(logicalSessionId, "openai-native");
    } catch {
      /* caller errors must not break execution */
    }
  }

  const { controller, cleanup: clearAbortScope } = createScopedAbortController(
    externalAbortController,
    timeoutMs,
  );
  const firstEventTimeoutMs = getFirstEventTimeoutMs(timeoutMs);
  let firstEventTimer = null;
  let firstEventTimeoutHit = false;
  let nativeEventCount = 0;
  let nativeTerminalText = "";
  const nativeTerminalItems = [];
  const rememberNativeTerminalEvent = (event) => {
    const lifecycle = String(event?.type || "").trim().toLowerCase();
    const text = String(event?.text || event?.summary || event?.content || "").trim();
    if (!text) return;
    const syntheticItem = {
      type: lifecycle === "assistant_message" ? "agent_message" : "event",
      text,
      summary: text ? `${lifecycle}: ${text}` : lifecycle,
      meta: { lifecycle: lifecycle.replace(/\./g, "_") },
    };
    const isLifecycleTerminalEvent =
      lifecycle === "session.stream.complete"
      || lifecycle === "session.turn.complete"
      || lifecycle === "session.completed";
    const isTerminalAssistantHandoff =
      lifecycle === "assistant_message"
      && hasExplicitCompletionSignal({
        output: text,
        items: [syntheticItem],
      });
    if (!isLifecycleTerminalEvent && !isTerminalAssistantHandoff) {
      return;
    }
    nativeTerminalText = text;
    nativeTerminalItems.push(syntheticItem);
  };
  const recoverNativeTerminalResult = ({ output = "", items = [] } = {}) => {
    const recoveredOutput = String(output || nativeTerminalText || "").trim();
    if (!recoveredOutput) return null;
    const recoveredItems = [
      ...nativeTerminalItems,
      ...(Array.isArray(items) ? items : []),
    ];
    if (!hasExplicitCompletionSignal({
      output: recoveredOutput,
      items: recoveredItems,
    })) {
      return null;
    }
    return {
      success: true,
      output: recoveredOutput || "(Agent completed with no text output)",
      items: recoveredItems,
      error: null,
      sdk: "openai-native",
      threadId: persistent ? logicalSessionId : null,
      _hasExplicitCompletionSignal: true,
    };
  };
  const handleNativeEvent = (event) => {
    rememberNativeTerminalEvent(event);
    if (isMeaningfulOpenaiNativeEvent(event)) {
      nativeEventCount += 1;
      if (firstEventTimer) {
        clearTimeout(firstEventTimer);
        firstEventTimer = null;
      }
    }
    if (typeof onEvent === "function") {
      try {
        onEvent(event);
      } catch {
        /* best effort */
      }
    }
  };

  try {
    const providerKernel = createProviderKernel({
      adapters: {
        "openai-native": openaiNativeAdapter,
      },
      getConfig: () => loadConfig() || {},
      env: runtimeSessionEnv,
      sessionManager: getBosunSessionManager(),
      onEvent: handleNativeEvent,
    });
    const providerSession = providerKernel.createExecutionSession({
      adapterName: "openai-native",
      selectionId: selectionId || normalizedProvider || "azure-openai-responses",
      ...(normalizedProvider ? { provider: normalizedProvider } : {}),
      ...(providerConfig ? { providerConfig } : {}),
      sessionId: logicalSessionId,
      threadId: logicalSessionId,
      model: trimmedModel || providerConfig?.model || null,
      cwd,
      repoRoot: cwd,
      taskKey: taskKey || logicalSessionId,
      sessionType: extra.sessionType || "task",
      sessionManager: getBosunSessionManager(),
      onEvent: handleNativeEvent,
      subagentMaxParallel: extra.subagentMaxParallel,
    });

    if (firstEventTimeoutMs) {
      firstEventTimer = setTimeout(() => {
        if (nativeEventCount > 0 || controller.signal.aborted) return;
        firstEventTimeoutHit = true;
        controller.abort("first_event_timeout");
      }, firstEventTimeoutMs);
      if (typeof firstEventTimer.unref === "function") {
        firstEventTimer.unref();
      }
    }

    const result = await providerSession.runTurn(prompt, {
      onEvent: handleNativeEvent,
      timeoutMs,
      sessionId: logicalSessionId,
      threadId: logicalSessionId,
      abortController: controller,
      model: trimmedModel || providerConfig?.model || null,
      cwd,
      repoRoot: cwd,
      taskKey: taskKey || logicalSessionId,
      sessionType: extra.sessionType || "task",
      sessionManager: getBosunSessionManager(),
      subagentMaxParallel: extra.subagentMaxParallel,
    });
    const finalResponse = String(
      result?.finalResponse || result?.output || result?.text || nativeTerminalText || "",
    ).trim();
    const resultItems = Array.isArray(result?.items) ? result.items : [];
    const recoveredTerminalResult =
      result?.success === false || result?.ok === false
        ? recoverNativeTerminalResult({
            output: finalResponse,
            items: resultItems,
          })
        : null;
    if (recoveredTerminalResult) {
      console.warn(
        `${TAG} openai-native produced an explicit terminal response before reporting failure; accepting the terminal response`,
      );
      return recoveredTerminalResult;
    }
    const success = result?.success !== false && result?.ok !== false;
    return {
      success,
      output: success ? finalResponse : "",
      items: resultItems,
      error: success ? null : String(result?.error || finalResponse || "openai-native execution failed"),
      sdk: "openai-native",
      threadId: persistent ? logicalSessionId : null,
      _hasExplicitCompletionSignal: success
        ? hasExplicitCompletionSignal({
            output: finalResponse,
            items: resultItems,
          })
        : false,
    };
  } catch (err) {
    const recoveredTerminalResult = recoverNativeTerminalResult();
    if (recoveredTerminalResult) {
      console.warn(
        `${TAG} openai-native error after explicit terminal response; accepting the terminal response: ${err?.message || err}`,
      );
      return recoveredTerminalResult;
    }
    const abortReason = controller.signal.aborted
      ? String(controller.signal.reason || "")
      : "";
    if (abortReason === "first_event_timeout") {
      const noEventsSuffix = firstEventTimeoutMs
        ? ` (no events received within ${firstEventTimeoutMs}ms)`
        : "";
      return {
        success: false,
        output: "",
        items: [],
        error: `OpenAI Native execution error: first_event_timeout${noEventsSuffix}`,
        sdk: "openai-native",
        threadId: persistent ? logicalSessionId : null,
      };
    }
    return {
      success: false,
      output: "",
      items: [],
      error: `OpenAI Native execution error: ${err?.message || err}`,
      sdk: "openai-native",
      threadId: persistent ? logicalSessionId : null,
    };
  } finally {
      clearTimeout(firstEventTimer);
    if (firstEventTimer) {
      clearTimeout(firstEventTimer);
    }
    clearAbortScope();
  }
}

async function resumeOpenaiNativeThread(
  threadId,
  prompt,
  cwd,
  timeoutMs,
  extra = {},
) {
  return launchOpenaiNativeThread(prompt, cwd, timeoutMs, {
    ...extra,
    resumeThreadId: threadId,
    taskKey: extra.taskKey,
  });
}

// ---------------------------------------------------------------------------
// Adapter loader functions (return the per-SDK launcher)
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<Function>} The Codex launcher function.
 */
async function loadCodexAdapter() {
  return launchCodexThread;
}

/**
 * @returns {Promise<Function>} The Copilot launcher function.
 */
async function loadCopilotAdapter() {
  return launchCopilotThread;
}

/**
 * @returns {Promise<Function>} The Claude launcher function.
 */
async function loadClaudeAdapter() {
  return launchClaudeThread;
}

/**
 * @returns {Promise<Function>} The OpenCode launcher function.
 */
async function loadOpencodeAdapter() {
  return launchOpencodeThread;
}

/**
 * @returns {Promise<Function>} The OpenAI Native launcher function (Azure / OpenAI Responses).
 */
async function loadOpenaiNativeAdapter() {
  return launchOpenaiNativeThread;
}

const poolProviderSessionRuntime = createHarnessProviderSessionRuntime({
  launchers: {
    codex: launchCodexThread,
    copilot: launchCopilotThread,
    claude: launchClaudeThread,
    opencode: launchOpencodeThread,
    "openai-native": launchOpenaiNativeThread,
  },
  resumers: {
    resume_codex: resumeCodexThread,
    resume_copilot: resumeCopilotThread,
    resume_claude: resumeClaudeThread,
    resume_opencode: async (threadId, prompt, cwd, timeoutMs, extra = {}) =>
      await launchOpencodeThread(prompt, cwd, timeoutMs, {
        ...extra,
        resumeThreadId: threadId,
        taskKey: extra.taskKey,
      }),
    "resume_openai-native": resumeOpenaiNativeThread,
    resume_generic: resumeGenericThread,
  },
});

function isOpencodeFailureMessage(message) {
  const normalized = String(message || "").trim().toLowerCase();
  return normalized.startsWith(":close:") || normalized.startsWith(":clock:");
}

function formatOpencodeError(message) {
  return String(message || "")
    .replace(/^:(?:close|clock):\s*/i, "")
    .trim() || "OpenCode execution failed";
}

async function launchOpencodeThread(prompt, cwd, timeoutMs, extra = {}) {
  timeoutMs = Number(timeoutMs) || DEFAULT_TIMEOUT_MS;
  const {
    onEvent = null,
    abortController = null,
    onThreadReady = null,
    resumeThreadId = null,
    envOverrides = null,
    provider = null,
    providerConfig: rawProviderConfig = null,
    model = null,
    taskKey = null,
  } = extra;

  let execOpencodePrompt;
  try {
    ({ execOpencodePrompt } = await import("../shell/opencode-shell.mjs"));
    if (typeof execOpencodePrompt !== "function") {
      throw new Error("execOpencodePrompt export not found");
    }
  } catch (err) {
    return {
      success: false,
      output: "",
      items: [],
      error: `OpenCode SDK not available: ${err.message}`,
      sdk: "opencode",
      threadId: null,
    };
  }

  const runtimeSessionEnv =
    envOverrides && typeof envOverrides === "object"
      ? { ...process.env, ...envOverrides }
      : { ...process.env };
  const logicalSessionId = String(
    resumeThreadId ||
      extra.sessionId ||
      extra.workflowSessionId ||
      taskKey ||
      "",
  ).trim() || null;
  const persistent = Boolean(logicalSessionId);
  const normalizedProviderConfig =
    rawProviderConfig && typeof rawProviderConfig === "object" && !Array.isArray(rawProviderConfig)
      ? { ...rawProviderConfig }
      : null;
  const trimmedModel = String(model || "").trim();
  const providerConfig =
    normalizedProviderConfig || trimmedModel
      ? {
          ...(normalizedProviderConfig || {}),
          ...(trimmedModel ? { model: trimmedModel } : {}),
        }
      : null;
  const normalizedProvider = String(
    provider || providerConfig?.provider || "",
  ).trim() || null;

  if (persistent && typeof onThreadReady === "function") {
    try {
      onThreadReady(logicalSessionId, "opencode");
    } catch {
      /* caller errors must not break execution */
    }
  }

  try {
    const providerKernel = createProviderKernel({
      adapters: {
        "opencode-sdk": {
          name: "opencode-sdk",
          provider: "OPENCODE",
          exec: async (message, execOptions = {}) => await withTemporaryEnv(
            {
              ...runtimeSessionEnv,
              PRIMARY_AGENT: "opencode-sdk",
              PRIMARY_AGENT_SDK: "opencode-sdk",
              OPENCODE_SDK_DISABLED: null,
            },
            async () => {
              const forwardedProviderConfig =
                providerConfig && typeof providerConfig === "object" && !Array.isArray(providerConfig)
                  ? { ...providerConfig }
                  : (
                    execOptions.providerConfig
                    && typeof execOptions.providerConfig === "object"
                    && !Array.isArray(execOptions.providerConfig)
                  )
                    ? { ...execOptions.providerConfig }
                    : null;
              const forwardedProvider = String(
                normalizedProvider || execOptions.provider || "",
              ).trim() || null;
              return await execOpencodePrompt(message, {
                ...execOptions,
                onEvent: execOptions.onEvent ?? onEvent,
                timeoutMs: execOptions.timeoutMs ?? timeoutMs,
                persistent,
                sessionId: execOptions.sessionId ?? logicalSessionId,
                abortController: execOptions.abortController ?? abortController,
                ...(forwardedProvider ? { provider: forwardedProvider } : {}),
                ...(forwardedProviderConfig ? { providerConfig: forwardedProviderConfig } : {}),
              });
            },
          ),
        },
      },
      getConfig: () => loadConfig() || {},
      env: runtimeSessionEnv,
      sessionManager: getBosunSessionManager(),
      onEvent,
    });
    const providerSession = providerKernel.createExecutionSession({
      adapterName: "opencode-sdk",
      selectionId: normalizedProvider || "",
      provider: normalizedProvider,
      providerConfig,
      sessionId: logicalSessionId,
      threadId: logicalSessionId,
      model: trimmedModel || providerConfig?.model || null,
      cwd,
      repoRoot: cwd,
      taskKey: extra.taskKey || logicalSessionId,
      sessionType: extra.sessionType || "task",
      sessionManager: getBosunSessionManager(),
      onEvent,
      subagentMaxParallel: extra.subagentMaxParallel,
    });
    const result = await providerSession.runTurn(prompt, {
      onEvent,
      timeoutMs,
      sessionId: logicalSessionId,
      threadId: logicalSessionId,
      abortController,
      model: trimmedModel || providerConfig?.model || null,
      cwd,
      repoRoot: cwd,
      taskKey: extra.taskKey || logicalSessionId,
      sessionType: extra.sessionType || "task",
      sessionManager: getBosunSessionManager(),
      subagentMaxParallel: extra.subagentMaxParallel,
    });
    const finalResponse = String(
      result?.output || result?.text || result?.raw?.finalResponse || "",
    ).trim();
    const success = result?.success !== false && !isOpencodeFailureMessage(finalResponse);
    return {
      success,
      output: success ? finalResponse : "",
      items: Array.isArray(result?.items) ? result.items : [],
      error: success ? null : formatOpencodeError(finalResponse || result?.error),
      sdk: "opencode",
      threadId: persistent ? logicalSessionId : null,
      _hasExplicitCompletionSignal: success
        ? hasExplicitCompletionSignal({
            output: finalResponse,
            items: Array.isArray(result?.items) ? result.items : [],
          })
        : false,
    };
  } catch (err) {
    return {
      success: false,
      output: "",
      items: [],
      error: `OpenCode execution error: ${err.message || err}`,
      sdk: "opencode",
      threadId: persistent ? logicalSessionId : null,
    };
  }
}

// ---------------------------------------------------------------------------
// Unified ephemeral thread launcher
// ---------------------------------------------------------------------------

/**
 * Spin up a fresh, isolated SDK thread, execute a single prompt, and return
 * the result.  The thread is not reused — it exists only for this one
 * operation, which means it cannot block (or be blocked by) any other thread.
 *
 * SDK selection:
 *   - Pass `extra.sdk` to force a specific SDK for this call.
 *   - Otherwise uses the resolved pool SDK (env / config / fallback).
 *   - If the primary SDK fails with "not available", tries the fallback chain.
 *
 * @param {string}  prompt      The prompt to send to the agent.
 * @param {string}  [cwd]       Working directory (defaults to REPO_ROOT).
 * @param {number}  [timeoutMs] Abort after this many ms (default 90 min).
 * @param {object}  [extra]     Optional extras:
 * @param {string}  [extra.sdk]             Force a specific SDK for this call.
 * @param {string}  [extra.model]           Force model for SDKs that support it.
 * @param {Function} [extra.onEvent]        Callback for raw SDK events.
 * @param {AbortController} [extra.abortController] External abort controller.
 * @param {string[]|string} [extra.claudeAllowedTools] Claude tool allow-list.
 * @param {string} [extra.claudePermissionMode] Claude permission mode override.
 * @returns {Promise<{ success: boolean, output: string, items: Array, error: string|null, sdk: string }>}
 */
export async function launchEphemeralThread(
  prompt,
  cwd = REPO_ROOT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  extra = {},
) {
  return await withAgentExecutionSlot(cwd, extra, async (slotLease) => {
  const resolvedGithubToken = await resolveGithubSessionToken();
  const baseRuntimeEnv = injectProviderConfigCredentialEnv(
    extra?.envOverrides && typeof extra.envOverrides === "object"
      ? { ...process.env, ...extra.envOverrides }
      : { ...process.env },
    extra?.providerConfig,
    extra?.provider || extra?.providerConfig?.provider || extra?.providerConfig?.providerId || "",
  );
  const sessionEnv = injectGitHubSessionEnv(baseRuntimeEnv, resolvedGithubToken);
  const launchExtra = {
    ...extra,
    envOverrides: sessionEnv,
    slotLease,
  };
  if (launchExtra.sdk && launchExtra.pinSdk === true) {
    launchExtra.disableFallback = true;
  }

  // ── Resolve MCP servers for this launch ──────────────────────────────────
  try {
    if (!launchExtra._mcpResolved) {
      const cfg = loadConfig();
      const mcpCfg = cfg.mcpServers || {};
      if (mcpCfg.enabled !== false) {
        const hasExplicitMcpSelection = Array.isArray(launchExtra.mcpServers);
        const requestedIds = normalizeRequestedMcpServerIds(launchExtra.mcpServers);
        const defaultIds = !hasExplicitMcpSelection && mcpCfg.allowDefaultServers === true
          ? mcpCfg.defaultServers || []
          : [];
        const registry = await getMcpRegistry();
        let resolved = [];
        if (requestedIds.length || defaultIds.length) {
          resolved = await registry.resolveMcpServersForAgent(
            cwd,
            requestedIds,
            {
              defaultServers: defaultIds,
              catalogOverrides: mcpCfg.catalogOverrides || {},
              requireAuth: mcpCfg.requireAuth !== false,
            },
          );
        }
        if (resolved.length && typeof registry.wrapServersWithDiscoveryProxy === "function") {
          resolved = await registry.wrapServersWithDiscoveryProxy(cwd, resolved, {
            enabled: mcpCfg.useDiscoveryProxy !== false,
            includeCustomTools: mcpCfg.includeCustomToolsInDiscoveryProxy !== false,
            cacheTtlMs: mcpCfg.discoveryProxyCacheTtlMs,
            executeTimeoutMs: mcpCfg.discoveryProxyExecuteTimeoutMs,
          });
        }
        if (resolved.length) {
          launchExtra._resolvedMcpServers = resolved;
        }
      }
      launchExtra._mcpResolved = true;
    }
  } catch (mcpErr) {
    launchExtra._resolvedMcpServers = [];
    console.warn(`${TAG} MCP server resolution failed (servers skipped): ${mcpErr.message}`);
  }

  // Determine the primary SDK to try
  const requestedSdk = launchExtra.sdk
    ? normalizePoolSdkName(launchExtra.sdk)
    : null;

  const primaryName =
    requestedSdk && SDK_ADAPTERS[requestedSdk]
      ? requestedSdk
      : resolvePoolSdkName();

  const attemptOrder = launchExtra?.disableFallback
    ? [primaryName]
    : [
        primaryName,
        ...getSdkFallbackOrder().filter((name) => name !== primaryName),
      ];

  let lastAttemptResult = null;
  let primaryFailureResult = null;
  const triedSdkNames = [];
  const missingPrereqSdks = [];
  const cooledDownSdks = [];
  const ignoreSdkCooldown = launchExtra?.ignoreSdkCooldown === true;

  for (const name of attemptOrder) {
    const adapter = SDK_ADAPTERS[name];
    if (!adapter) continue;
    if (isDisabled(name)) continue;

    const cooldownRemainingMs = ignoreSdkCooldown
      ? 0
      : getSdkCooldownRemainingMs(name);
    if (cooldownRemainingMs > 0) {
      cooledDownSdks.push({ name, cooldownRemainingMs });
      const remainingSec = Math.max(1, Math.ceil(cooldownRemainingMs / 1000));
      if (name === primaryName) {
        console.warn(
          `${TAG} primary SDK "${name}" cooling down (${remainingSec}s remaining); trying fallback chain`,
        );
      } else {
        console.log(
          `${TAG} skipping fallback SDK "${name}" due to cooldown (${remainingSec}s remaining)`,
        );
      }
      continue;
    }

    // Check prerequisites before wasting time trying an unconfigured SDK
    const prereq = hasSdkPrerequisites(name, sessionEnv);
    if (!prereq.ok) {
      missingPrereqSdks.push({ name, reason: prereq.reason });
      if (name === primaryName) {
        console.warn(
          `${TAG} primary SDK "${name}" missing prerequisites: ${prereq.reason}; trying fallback chain`,
        );
      } else {
        console.log(`${TAG} skipping fallback SDK "${name}": ${prereq.reason}`);
      }
      continue;
    }

    if (name !== primaryName) {
      console.log(`${TAG} trying fallback SDK: ${name}`);
    }

    triedSdkNames.push(name);
    const result = await poolProviderSessionRuntime.launchSession({
      sdkName: name,
      prompt,
      cwd,
      timeoutMs,
      extra: launchExtra,
    });
    lastAttemptResult = result;

    if (result.success) {
      return result;
    }

    if (!shouldFallbackForSdkError(result.error)) {
      return result;
    }

    if (name === primaryName) {
      primaryFailureResult = result;
    }

    applySdkFailureCooldown(name, result.error);

    // Permanently disable a *fallback* SDK for this process if it returned a
    // deterministic auth/config error (e.g. Copilot "Failed to list models:
    // 400"). Otherwise every subsequent task launch will retry the same
    // broken fallback and flood the logs with identical warnings. Never
    // process-disable Codex this way: Codex 400s are often transient
    // upstream / Azure config drift, and existing tests rely on Codex
    // remaining retryable after such errors.
    if (
      name !== "codex" &&
      name !== primaryName &&
      isDeterministicAuthFailure(result.error)
    ) {
      markSdkProcessDisabled(name, result.error);
    }

    if (name === primaryName) {
      console.warn(
        `${TAG} primary SDK "${primaryName}" failed (${result.error}); trying fallback chain`,
      );
    } else {
      console.warn(
        `${TAG} fallback SDK "${name}" failed (${result.error}); trying next fallback`,
      );
    }
  }

  const eligibleSdks = Array.from(
    new Set(attemptOrder.filter((name) => SDK_ADAPTERS[name] && !isDisabled(name))),
  );
  const runnableSdks = eligibleSdks.filter((name) => {
    const prereq = hasSdkPrerequisites(name, sessionEnv);
    if (!prereq.ok) {
      if (!missingPrereqSdks.some((entry) => entry.name === name)) {
        missingPrereqSdks.push({ name, reason: prereq.reason });
      }
      return false;
    }
    return true;
  });
  const cooledDownSet = new Set(cooledDownSdks.map((entry) => entry.name));
  const missingPrereqSet = new Set(missingPrereqSdks.map((entry) => entry.name));
  const allEligibleUnavailable =
    eligibleSdks.length > 0 &&
    eligibleSdks.every(
      (name) => cooledDownSet.has(name) || missingPrereqSet.has(name),
    );

  if (
    !ignoreSdkCooldown &&
    !lastAttemptResult &&
    triedSdkNames.length === 0 &&
    runnableSdks.length > 0 &&
    runnableSdks.every((name) => cooledDownSet.has(name))
  ) {
    const forcedRetryOrder = runnableSdks.includes(primaryName)
      ? [primaryName, ...runnableSdks.filter((name) => name !== primaryName)]
      : runnableSdks;

    for (const name of forcedRetryOrder) {
      const cooldownRemainingMs = getSdkCooldownRemainingMs(name);
      if (cooldownRemainingMs <= 0) continue;

      const prereq = hasSdkPrerequisites(name, sessionEnv);
      if (!prereq.ok) {
        if (!missingPrereqSdks.some((entry) => entry.name === name)) {
          missingPrereqSdks.push({ name, reason: prereq.reason });
        }
        continue;
      }

      const remainingSec = Math.max(1, Math.ceil(cooldownRemainingMs / 1000));
      console.warn(
        `${TAG} all eligible SDKs are cooling down; force-retrying "${name}" (${remainingSec}s remaining)`,
      );

      triedSdkNames.push(name);
      const result = await poolProviderSessionRuntime.launchSession({
        sdkName: name,
        prompt,
        cwd,
        timeoutMs,
        extra: launchExtra,
      });
      lastAttemptResult = result;

      if (result.success) {
        return result;
      }

      if (!shouldFallbackForSdkError(result.error)) {
        return result;
      }

      applySdkFailureCooldown(name, result.error);
      break;
    }
  }

  // If every eligible SDK is unavailable (cooldown and/or missing credentials),
  // force one cooled-down attempt so work is not blocked for the full cooldown window.
  const shouldForceCooldownBypassAttempt =
    !ignoreSdkCooldown &&
    !lastAttemptResult &&
    triedSdkNames.length === 0 &&
    cooledDownSet.has(primaryName) &&
    allEligibleUnavailable;
  const forcedSdkName = shouldForceCooldownBypassAttempt
    ? cooledDownSet.has(primaryName)
      ? primaryName
      : eligibleSdks.find((name) => cooledDownSet.has(name)) || null
    : null;

  if (forcedSdkName) {
    const prereq = hasSdkPrerequisites(forcedSdkName, sessionEnv);
    if (!prereq.ok) {
      // Cooldown means we recently attempted this SDK. Keep one forced retry path
      // to avoid hard-blocking work on strict prerequisite heuristics.
      if (
        !missingPrereqSdks.some(
          (entry) => entry.name === forcedSdkName && entry.reason === prereq.reason,
        )
      ) {
        missingPrereqSdks.push({ name: forcedSdkName, reason: prereq.reason });
      }
      console.warn(
        `${TAG} all eligible SDKs unavailable; bypassing SDK "${forcedSdkName}" prerequisite gate for forced retry (${prereq.reason})`,
      );
    } else {
      console.warn(
        `${TAG} no runnable fallback SDK is available (cooldown/prerequisite gate); forcing SDK "${forcedSdkName}" retry`,
      );
    }
    triedSdkNames.push(forcedSdkName);
    const forcedResult = await poolProviderSessionRuntime.launchSession({
      sdkName: forcedSdkName,
      prompt,
      cwd,
      timeoutMs,
      extra: launchExtra,
    });
    if (forcedResult.success) {
      return forcedResult;
    }
    lastAttemptResult = forcedResult;
    if (!shouldFallbackForSdkError(forcedResult.error)) {
      return forcedResult;
    }
    applySdkFailureCooldown(forcedSdkName, forcedResult.error);
  }

  // Recovery path: when all SDKs were skipped due cooldown/prereq gates, force
  // one direct attempt against cooled-down SDKs to surface a concrete error.
  if (!lastAttemptResult && triedSdkNames.length === 0 && cooledDownSdks.length > 0) {
    const cooledDownRescueOrder = cooledDownSdks
      .map((entry) => entry.name)
      .filter((name, idx, arr) => SDK_ADAPTERS[name] && arr.indexOf(name) === idx)
      .sort((a, b) => {
        if (a === primaryName) return -1;
        if (b === primaryName) return 1;
        return 0;
      });

    for (const name of cooledDownRescueOrder) {
      const remainingMs = getSdkCooldownRemainingMs(name);
      const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000));
      console.warn(
        `${TAG} no runnable SDK remained after gating; rescue-attempting cooled-down SDK "${name}" (${remainingSec}s remaining)`,
      );

      triedSdkNames.push(name);
      const result = await poolProviderSessionRuntime.launchSession({
        sdkName: name,
        prompt,
        cwd,
        timeoutMs,
        extra: launchExtra,
      });
      lastAttemptResult = result;

      if (result.success) {
        return result;
      }

      if (!shouldFallbackForSdkError(result.error)) {
        return result;
      }

      if (name === primaryName) {
        primaryFailureResult = result;
      }

      applySdkFailureCooldown(name, result.error);
    }
  }
  // ── All SDKs exhausted ───────────────────────────────────────────────────
  if (lastAttemptResult) {
    if (
      primaryFailureResult &&
      lastAttemptResult.sdk !== primaryFailureResult.sdk
    ) {
      return primaryFailureResult;
    }
    return lastAttemptResult;
  }

  let errorMsg = `${TAG} no SDK available.`;
  if (triedSdkNames.length > 0) {
    errorMsg += ` Tried: ${triedSdkNames.join(", ")}.`;
  }
  if (missingPrereqSdks.length > 0) {
    errorMsg += ` Skipped (missing credentials): ${missingPrereqSdks
      .map((entry) => `${entry.name} (${entry.reason})`)
      .join(", ")}.`;
  }
  if (cooledDownSdks.length > 0) {
    errorMsg += ` Cooling down: ${cooledDownSdks
      .map(
        (entry) =>
          `${entry.name} (${Math.max(1, Math.ceil(entry.cooldownRemainingMs / 1000))}s remaining)`,
      )
      .join(", ")}.`;
  }
  if (eligibleSdks.length === 0) {
    errorMsg += " All SDKs are disabled.";
  }

  return {
    success: false,
    output: "",
    items: [],
    error: errorMsg,
    sdk: primaryName,
    threadId: null,
  };
  });
}

// ---------------------------------------------------------------------------
// High-level: drop-in replacement for execPrimaryPrompt
// ---------------------------------------------------------------------------

/**
 * Execute a prompt on a pooled ephemeral thread with the **same signature** as
 * `execPrimaryPrompt` from codex-shell.mjs.  This allows callers in
 * monitor.mjs to swap from the singleton agent to a concurrent pool thread
 * without changing any surrounding code.
 *
 * @param {string} userMessage  The prompt / instruction to execute.
 * @param {object} [options]    Compatible with execPrimaryPrompt options.
 * @param {Function}           [options.onEvent]         Callback for raw SDK events.
 * @param {object}             [options.statusData]      (Unused — accepted for compat.)
 * @param {number}             [options.timeoutMs]       Override default timeout.
 * @param {boolean}            [options.sendRawEvents]   (Unused — accepted for compat.)
 * @param {AbortController}    [options.abortController] External abort controller.
 * @param {string}             [options.cwd]             Working directory override.
 * @param {string}             [options.sdk]             Force a specific SDK.
 * @param {string}             [options.model]           Force model for SDKs that support it.
 * @param {string}             [options.sessionType]     Interaction type (task/chat/voice-delegate/etc) for shredding policy selection.
 * @param {boolean}            [options.forceContextShredding] Force compression even for short-lived session types.
 * @param {boolean}            [options.skipContextShredding]  Skip compression regardless of policy.
 * @param {boolean}            [options.compressEphemeralItems]
 *   Whether to apply context shredding/compression to bare ephemeral pooled runs.
 *   Non-ephemeral helper sessions (task/flow/delegate/voice) use the shared
 *   context-shredding path by default.
 * @returns {Promise<{ finalResponse: string, items: Array, usage: object|null }>}
 */
export async function execPooledPrompt(userMessage, options = {}) {
  const {
    onEvent,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    abortController,
    cwd = REPO_ROOT,
    sdk,
    model,
    mcpServers,
    sessionType = "ephemeral",
    forceContextShredding = false,
    skipContextShredding = false,
    compressEphemeralItems = envFlagEnabled(process.env.AGENT_POOL_COMPRESS_EPHEMERAL_ITEMS),
    // statusData and sendRawEvents are accepted but not used — keeps the
    // call-site compatible with execPrimaryPrompt without modification.
  } = options;

  const result = await launchEphemeralThread(userMessage, cwd, timeoutMs, {
    onEvent,
    abortController,
    sdk,
    model,
    mcpServers,
  });

  if (!result.success) {
    // Match execPrimaryPrompt behaviour: always return the triple, let the
    // caller inspect finalResponse for error handling.
    return {
      finalResponse: result.error
        ? `[agent-pool error] ${result.error}`
        : "(no output)",
      items: result.items || [],
      usage: null,
    };
  }

  let finalItems = result.items;
  if (shouldCompressSessionItemsByDefault(sessionType, {
    compressEphemeralItems,
    forceCompression: forceContextShredding,
  })) {
    try {
      finalItems = await maybeCompressResultItems(result.items, {
        sdk: sdk || result.sdk,
        sessionType,
        sessionId: options.sessionId || null,
        allowCompression: true,
        forceCompression: forceContextShredding,
        skipCompression: skipContextShredding,
      });
    } catch (error_) {
      console.warn(`${TAG} context compression failed (non-fatal): ${error_.message}`);
    }
  }

  return {
    finalResponse: result.output,
    items: finalItems,
    usage: null, // ephemeral threads don't aggregate usage today
  };
}

// ---------------------------------------------------------------------------
// Thread Persistence & Active Session Compatibility Adapters
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ThreadRecord
 * @property {string}      threadId
 * @property {string}      sdk
 * @property {string}      taskKey
 * @property {string}      cwd
 * @property {number}      turnCount
 * @property {number}      createdAt
 * @property {number}      lastUsedAt
 * @property {string|null} lastError
 * @property {boolean}     alive
 */

const THREAD_EXHAUSTION_WARNING_THRESHOLD = Math.floor(MAX_THREAD_TURNS * 0.8);

function getPersistentThreadRecord(taskKey) {
  return getManagedThreadRecord(taskKey);
}

function setPersistentThreadRecord(taskKey, record = {}) {
  return setManagedThreadRecord(taskKey, record);
}

function deletePersistentThreadRecord(taskKey) {
  return deleteManagedThreadRecord(taskKey);
}

function beginManagedExternalSession(sessionManager, sessionId, input = {}) {
  if (!sessionId) return null;
  return sessionManager.beginExternalSession({
    sessionId,
    parentSessionId: input.parentSessionId,
    rootSessionId: input.rootSessionId,
    scope: input.scope || "task",
    sessionType: input.sessionType || "task",
    providerSelection: input.providerSelection || "",
    adapterName: input.adapterName || "",
    taskKey: input.taskKey || sessionId,
    cwd: input.cwd || "",
    metadata: input.metadata,
    source: input.source || "agent-pool",
  });
}

function markManagedExternalSession(sessionManager, sessionId, input = {}) {
  if (!sessionId) return null;
  return sessionManager.continueSession(sessionId, {
    lifecycleState: input.lifecycleState || "running",
    action: input.action || "launch",
  });
}

function registerManagedExternalExecution(sessionManager, sessionId, input = {}) {
  if (!sessionId) return null;
  return sessionManager.registerExecution(sessionId, input);
}

function finalizeManagedExternalExecution(sessionManager, sessionId, input = {}) {
  if (!sessionId) return null;
  return sessionManager.finalizeExternalExecution(sessionId, input);
}

const managedExternalAbortControllers = new Map();

function setManagedExternalAbortController(sessionId, controller = null) {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId) return null;
  if (!controller) {
    managedExternalAbortControllers.delete(normalizedSessionId);
    return null;
  }
  managedExternalAbortControllers.set(normalizedSessionId, controller);
  return controller;
}

function getManagedExternalAbortController(sessionId) {
  const normalizedSessionId = String(sessionId || "").trim();
  return normalizedSessionId ? (managedExternalAbortControllers.get(normalizedSessionId) || null) : null;
}

function normalizeManagedExternalPrompt(runRequest = {}) {
  return String(
    runRequest.prompt
    || runRequest.message
    || runRequest.userMessage
    || "",
  ).trim();
}

function bindManagedExternalSessionController(sessionManager, sessionId, defaults = {}) {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!sessionManager || !normalizedSessionId || typeof sessionManager.bindExternalController !== "function") {
    return null;
  }
  return sessionManager.bindExternalController(normalizedSessionId, {
    abort(reason = "aborted") {
      const abortController = getManagedExternalAbortController(normalizedSessionId);
      if (abortController && !abortController.signal.aborted) {
        try {
          abortController.abort(reason);
        } catch {
          /* best effort */
        }
      }
    },
    async run(runRequest = {}) {
      const prompt = normalizeManagedExternalPrompt(runRequest);
      if (!prompt) {
        return sessionManager.getSession?.(normalizedSessionId) || {
          sessionId: normalizedSessionId,
          status: "running",
        };
      }
      const cwd = runRequest.cwd || defaults.cwd || process.cwd();
      const timeoutMs = Number(runRequest.timeoutMs || runRequest.timeout || defaults.timeoutMs) || DEFAULT_TIMEOUT_MS;
      const abortController =
        runRequest.abortController instanceof AbortController
          ? runRequest.abortController
          : new AbortController();
      setManagedExternalAbortController(normalizedSessionId, abortController);
      try {
        return await launchOrResumeThread(prompt, cwd, timeoutMs, {
          ...defaults,
          ...runRequest,
          cwd,
          timeoutMs,
          sessionId: normalizedSessionId,
          abortController,
          metadata: {
            ...toPlainObject(defaults.metadata),
            ...toPlainObject(runRequest.metadata),
          },
        });
      } finally {
        if (getManagedExternalAbortController(normalizedSessionId) === abortController) {
          setManagedExternalAbortController(normalizedSessionId, null);
        }
      }
    },
  });
}

export async function ensureThreadRegistryLoaded() {
  return ensureManagedThreadRegistryLoaded();
}

// Warm the persisted thread registry at module init without risking an
// unhandled rejection during detached startup flows.
ensureThreadRegistryLoaded().catch((err) => {
  console.warn(TAG + " thread registry warm-up failed: " + (err?.message || err));
});

function registerActiveSession(taskKey, sdk, threadId, sendFn, metadata = {}) {
  return registerManagedActiveSession(taskKey, sdk, threadId, sendFn, metadata);
}

function unregisterActiveSession(taskKey) {
  return unregisterManagedActiveSession(taskKey);
}

export function steerActiveThread(taskKey, prompt) {
  return steerManagedActiveThread(taskKey, prompt);
}

export function hasActiveSession(taskKey) {
  return hasManagedActiveSession(taskKey);
}

export function addActiveSessionListener(listener) {
  return addManagedActiveSessionListener(listener);
}

export function getActiveSessions() {
  return getManagedActiveSessions();
}

// ---------------------------------------------------------------------------
// Per-SDK Resume Launchers
// ---------------------------------------------------------------------------

/**
 * Detect unrecoverable Codex resume errors that indicate poisoned thread state.
 * These failures should force dropping cached thread metadata.
 *
 * @param {unknown} errorValue
 * @returns {boolean}
 */
function isPoisonedCodexResumeError(errorValue) {
  const lower = String(errorValue || "").toLowerCase();
  return (
    lower.includes("invalid_encrypted_content") ||
    lower.includes("encrypted content") ||
    lower.includes("could not be verified") ||
    lower.includes("state db missing rollout path") ||
    lower.includes("missing rollout path") ||
    lower.includes("tool call must have a tool call id") ||
    lower.includes("tool_call_id") ||
    (lower.includes("400") && lower.includes("tool call"))
  );
}

function isCodexResumeTimeoutError(errorValue) {
  return String(errorValue || "").toLowerCase().includes("codex resume timeout");
}

/**
 * Resume an existing Codex thread and run a follow-up prompt.
 * Uses `codex.resumeThread(threadId)` from @openai/codex-sdk.
 *
 * @param {string} threadId  Thread ID from a previous launchCodexThread.
 * @param {string} prompt    Follow-up prompt.
 * @param {string} cwd       Working directory.
 * @param {number} timeoutMs Abort timeout in ms.
 * @param {object} extra     Optional { onEvent, abortController }.
 * @returns {Promise<{ success: boolean, output: string, items: Array, error: string|null, sdk: string, threadId: string|null }>}
 */
async function resumeCodexThread(threadId, prompt, cwd, timeoutMs, extra = {}) {
  // Coerce to a positive integer and cap at DEFAULT_TIMEOUT_MS (6 h) to prevent
  // resource exhaustion from arbitrarily large user-controlled timer durations.
  const parsedMs = Number(timeoutMs);
  timeoutMs = (Number.isFinite(parsedMs) && parsedMs > 0)
    ? Math.min(Math.trunc(parsedMs), DEFAULT_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
  const { onEvent, abortController: externalAC, envOverrides = null } = extra;

  let CodexClass;
  try {
    const mod = await importCodexSdkModule();
    CodexClass = mod.Codex;
    if (!CodexClass) throw new Error("Codex export not found");
  } catch (err) {
    return {
      success: false,
      output: "",
      items: [],
      error: `Codex SDK not available: ${err.message}`,
      sdk: "codex",
      threadId: null,
    };
  }

  const codexRuntimeEnv =
    envOverrides && typeof envOverrides === "object"
      ? { ...process.env, ...envOverrides }
      : process.env;
  const codexSessionEnv = applyNodeWarningSuppressionEnv(codexRuntimeEnv);
  const codexOpts = buildCodexSdkOptions(codexSessionEnv, { workingDirectory: cwd });
  const explicitEnvModel = String(envOverrides?.CODEX_MODEL || "").trim();
  if (explicitEnvModel) {
    codexOpts.env = { ...(codexOpts.env || {}), CODEX_MODEL: explicitEnvModel };
    codexOpts.config = { ...(codexOpts.config || {}), model: explicitEnvModel };
  }
  const modelOverride = String(extra?.model || "").trim();
  if (modelOverride) {
    codexOpts.env = { ...(codexOpts.env || {}), CODEX_MODEL: modelOverride };
    codexOpts.config = { ...(codexOpts.config || {}), model: modelOverride };
  }
  codexOpts.config = {
    ...(codexOpts.config || {}),
    features: {
      ...(codexOpts.config?.features || {}),
      child_agents_md: true,
      multi_agent: true,
      memories: true,
      undo: true,
      steer: true,
    },
  };
  const codex = new CodexClass(codexOpts);

  let thread;
  try {
    const sandboxPolicy = process.env.CODEX_SANDBOX || "workspace-write";
    const resumeMetadata = {
      sessionId:
        String(extra.sessionId || extra.workflowSessionId || extra.taskKey || "").trim() || null,
      taskKey: String(extra.taskKey || "").trim() || null,
      sessionScope: String(extra.sessionScope || "task").trim() || "task",
      sessionType: String(extra.sessionType || "task").trim() || "task",
      cwd,
      metadata: toPlainObject(extra.metadata),
    };
    thread = codex.resumeThread(threadId, {
      sandboxMode: sandboxPolicy,
      workingDirectory: cwd,
      skipGitRepoCheck: true,
      approvalPolicy: "never",
    }, resumeMetadata);
  } catch (err) {
    // Resume failed (thread expired, not found, etc.) — signal caller to start fresh
    return {
      success: false,
      output: "",
      items: [],
      error: `Thread resume failed: ${err.message}`,
      sdk: "codex",
      threadId: null,
      poisonedResumeState: isPoisonedCodexResumeError(err.message),
    };
  }

  if (!thread) {
    return {
      success: false,
      output: "",
      items: [],
      error: "Codex SDK resumeThread() returned null — thread may have expired",
      sdk: "codex",
      threadId: null,
    };
  }

  const { controller, cleanup: clearAbortScope } = createScopedAbortController(
    externalAC,
    timeoutMs,
  );
  let hardTimer;
  let firstEventTimer = null;
  let firstEventTimeoutHit = false;
  let eventCount = 0;

  try {
    const safePrompt = sanitizeAndBoundPrompt(prompt);
    const turn = await Promise.race([
      thread.runStreamed(safePrompt, {
        signal: controller.signal,
      }),
      new Promise((_, reject) => {
        hardTimer = setTimeout(
          () => reject(new Error("hard_timeout")),
          clampTimerDelayMs(timeoutMs + HARD_TIMEOUT_BUFFER_MS, "codex-resume-hard-timeout"),
        );
      }),
    ]);
    let finalResponse = "";
    const allItems = [];

    // Hard timeout safety net (same as launchCodexThread)
    const hardTimeoutPromise = new Promise((_, reject) => {
      if (hardTimer) return;
      hardTimer = setTimeout(
        () => reject(new Error("hard_timeout")),
        clampTimerDelayMs(timeoutMs + HARD_TIMEOUT_BUFFER_MS, "codex-resume-hard-timeout"),
      );
    });

    const iterateEvents = async () => {
      for await (const event of turn.events) {
        eventCount += 1;
        if (firstEventTimer) {
          clearTimeout(firstEventTimer);
          firstEventTimer = null;
        }
        if (controller.signal.aborted) break;
        if (typeof onEvent === "function")
          try {
            onEvent(event);
          } catch {
            /* */
          }
        if (event.type === "item.completed") {
          allItems.push(event.item);
          if (event.item.type === "agent_message" && event.item.text) {
            finalResponse += event.item.text + "\n";
          }
        }
      }
    };

    const firstEventTimeoutMs = getFirstEventTimeoutMs(timeoutMs);
    if (firstEventTimeoutMs) {
      firstEventTimer = setTimeout(() => {
        if (eventCount > 0 || controller.signal.aborted) return;
        firstEventTimeoutHit = true;
        controller.abort("first_event_timeout");
      }, firstEventTimeoutMs);
      if (typeof firstEventTimer.unref === "function") firstEventTimer.unref();
    }

    await Promise.race([iterateEvents(), hardTimeoutPromise]);
    clearTimeout(hardTimer);
    if (firstEventTimer) clearTimeout(firstEventTimer);
    clearAbortScope();

    const streamSafety = resolveCodexStreamSafety(timeoutMs);
    const finalizedItems = await finalizeBufferedTurnItems(allItems, {
      maxItems: streamSafety.maxItemsPerTurn,
      maxItemChars: streamSafety.maxItemChars,
    });
    const newThreadId = thread.id || threadId;
    const output = finalResponse.trim() || "(resumed — no text output)";
    const explicitCompletionSignal = hasExplicitCompletionSignal({
      output,
      items: allItems,
    });
    return {
      success: true,
      output,
      items: finalizedItems.items,
      error: null,
      sdk: "codex",
      threadId: newThreadId,
      _hasExplicitCompletionSignal: explicitCompletionSignal,
      hotPath: {
        exec: finalizedItems.hotPath,
      },
    };
  } catch (err) {
    clearAbortScope();
    if (hardTimer) clearTimeout(hardTimer);
    if (firstEventTimer) clearTimeout(firstEventTimer);
    const isTimeout =
      err.name === "AbortError" ||
      String(err) === "timeout" ||
      err.message === "hard_timeout";
    const firstEventSuffix =
      isTimeout && firstEventTimeoutHit
        ? ` (no events received within ${getFirstEventTimeoutMs(timeoutMs)}ms)`
        : "";
    return {
      success: false,
      output: "",
      items: [],
      error: isTimeout
        ? `${TAG} codex resume timeout after ${timeoutMs}ms${err.message === "hard_timeout" ? " (hard timeout)" : ""}${firstEventSuffix}`
        : `Thread resume error: ${err.message}`,
      sdk: "codex",
      threadId: null,
      staleResumeState: isTimeout,
      poisonedResumeState:
        !isTimeout && isPoisonedCodexResumeError(err.message),
    };
  }
}

/**
 * "Resume" for SDKs without native thread persistence.
 * Falls back to starting a fresh thread with a context-carrying preamble.
 *
 * @param {string} _threadId  Ignored — no native resume available.
 * @param {string} prompt     Follow-up prompt.
 * @param {string} cwd        Working directory.
 * @param {number} timeoutMs  Abort timeout.
 * @param {object} extra      Optional extras.
 * @param {string} sdkName    "copilot", "claude", or "opencode".
 * @returns {Promise<Object>}
 */
async function resumeGenericThread(
  _threadId,
  prompt,
  cwd,
  timeoutMs,
  extra = {},
  sdkName = "copilot",
) {
  // No native resume — launch fresh with context preamble
  const contextPrompt = `# CONTINUATION — Resuming Prior Context\n\nYou are continuing work from a previous session. Pick up where you left off.\n\n---\n\n${prompt}`;
  const launcher =
    sdkName === "claude"
      ? launchClaudeThread
      : sdkName === "opencode"
        ? launchOpencodeThread
        : launchCopilotThread;
  const result = await launcher(contextPrompt, cwd, timeoutMs, extra);
  return { ...result, threadId: null }; // No persistent ID available
}

// ---------------------------------------------------------------------------
// Thread-Persistent Launcher
// ---------------------------------------------------------------------------

/**
 * Launch a new thread OR resume an existing one for the given task key.
 *
 * When a `taskKey` is provided:
 *   1. Check the thread registry for an existing, alive thread.
 *   2. If found and the same SDK — attempt resume (Codex) or context-carry (others).
 *   3. If resume fails or no prior thread — start fresh.
 *   4. Register the new thread for future resume.
 *
 * Without `taskKey`, behaves identically to `launchEphemeralThread`.
 *
 * @param {string}  prompt      Prompt to run.
 * @param {string}  [cwd]       Working directory.
 * @param {number}  [timeoutMs] Timeout in ms.
 * @param {object}  [extra]     Options:
 * @param {string}  [extra.taskKey]    Key for thread registry (task ID, PR number, etc.)
 * @param {string}  [extra.sdk]        Force a specific SDK.
 * @param {string}  [extra.model]      Force model for SDKs that support it.
 * @param {string}  [extra.sessionType] Interaction type used for context-shredding policy lookup.
 * @param {boolean} [extra.forceContextShredding] Force compression regardless of session type defaults.
 * @param {boolean} [extra.skipContextShredding]  Skip compression regardless of policy.
 * @param {boolean} [extra.pinSdk]     Keep SDK pinned when provided (disables fallback).
 * @param {Function} [extra.onEvent]   Event callback.
 * @param {AbortController} [extra.abortController]
 * @returns {Promise<{ success: boolean, output: string, items: Array, error: string|null, sdk: string, threadId: string|null, resumed: boolean }>}
 */
export async function launchOrResumeThread(
  prompt,
  cwd = REPO_ROOT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  extra = {},
) {
  return await withAgentExecutionSlot(cwd, extra, async (slotLease) => {
  await ensureThreadRegistryLoaded();
  const { taskKey, ...restExtra } = extra;
  const sessionManager = getBosunSessionManager();
  const existingThreadRecord = taskKey ? getPersistentThreadRecord(taskKey) : null;
  const managedSessionMetadata = {
    source: "agent-pool",
    ...toPlainObject(restExtra.metadata),
  };
  const managedSessionId = String(restExtra.sessionId || taskKey || "").trim() || null;
  if (managedSessionId) {
    bindManagedExternalSessionController(sessionManager, managedSessionId, {
      ...restExtra,
      sessionId: managedSessionId,
      taskKey,
      cwd,
      timeoutMs,
      sessionScope: restExtra.sessionScope || "task",
      sessionType: restExtra.sessionType || "task",
      parentSessionId: restExtra.parentSessionId,
      rootSessionId: restExtra.rootSessionId,
      metadata: managedSessionMetadata,
    });
    beginManagedExternalSession(sessionManager, managedSessionId, {
      parentSessionId: restExtra.parentSessionId,
      rootSessionId: restExtra.rootSessionId,
      scope: restExtra.sessionScope || "task",
      sessionType: restExtra.sessionType || "task",
      providerSelection: restExtra.sdk || "",
      adapterName: restExtra.sdk || "",
      taskKey,
      cwd,
      metadata: managedSessionMetadata,
      source: "agent-pool",
    });
    markManagedExternalSession(sessionManager, managedSessionId, {
      lifecycleState: existingThreadRecord?.alive && existingThreadRecord?.threadId ? "resuming" : "running",
      action: existingThreadRecord?.alive && existingThreadRecord?.threadId ? "resume" : "launch",
    });
  }
  const resolvedGithubToken = await resolveGithubSessionToken();
  const restBaseEnv =
    restExtra?.envOverrides && typeof restExtra.envOverrides === "object"
      ? { ...process.env, ...restExtra.envOverrides }
      : { ...process.env };
  restExtra.envOverrides = injectGitHubSessionEnv(
    restBaseEnv,
    resolvedGithubToken,
  );
  restExtra.envOverrides = applyNodeWarningSuppressionEnv(restExtra.envOverrides);
  restExtra.slotLease = slotLease;
  // Pass taskKey through as steer key so SDK launchers can register active sessions
  restExtra.taskKey = taskKey;
  if (restExtra.sdk && restExtra.pinSdk === true) {
    // Task-bound runs with an explicit SDK can optionally stay pinned to that SDK.
    restExtra.disableFallback = true;
  }
  timeoutMs = clampMonitorMonitorTimeout(timeoutMs, taskKey);

  // No taskKey — pure ephemeral (backward compatible)
  if (!taskKey) {
    const result = await launchEphemeralThread(
      prompt,
      cwd,
      timeoutMs,
      restExtra,
    );
    return { ...result, threadId: result.threadId || null, resumed: false };
  }

  // Check registry for existing thread through the canonical control-plane plan.
  const existing = getPersistentThreadRecord(taskKey);
  const requestedSdkName = restExtra.sdk || existing?.sdk || resolvePoolSdkName();
  const persistentPlan = planPersistentThreadExecution({
    taskKey,
    requestedSdk: requestedSdkName,
    existingRecord: existing,
    maxThreadTurns: MAX_THREAD_TURNS,
    warningThreshold: THREAD_EXHAUSTION_WARNING_THRESHOLD,
    absoluteAgeMs: THREAD_MAX_ABSOLUTE_AGE_MS,
    monitorTaskKey: MONITOR_MONITOR_TASK_KEY,
    monitorRefreshTurnsRemaining: MONITOR_MONITOR_THREAD_REFRESH_TURNS_REMAINING,
  });
  for (const warning of persistentPlan.warnings || []) {
    console.warn(`${TAG} :alert: ${warning}`);
  }
  if (existing && persistentPlan.invalidateRecord) {
    if (persistentPlan.reason === "sdk_changed") {
      console.log(
        `${TAG} SDK changed from ${existing.sdk} to ${requestedSdkName} for task "${taskKey}", starting fresh`,
      );
    } else if (persistentPlan.reason === "monitor_refresh_threshold") {
      console.log(
        `${TAG} proactively refreshing monitor-monitor thread with ${persistentPlan.turnsRemaining} turns remaining (threshold=${MONITOR_MONITOR_THREAD_REFRESH_TURNS_REMAINING})`,
      );
    } else if (persistentPlan.reason === "turn_limit_exceeded") {
      console.warn(
        `${TAG} thread for task "${taskKey}" exceeded ${MAX_THREAD_TURNS} turns (has ${existing.turnCount}) — invalidating and starting fresh`,
      );
    } else if (persistentPlan.reason === "absolute_age_exceeded") {
      console.warn(
        `${TAG} thread for task "${taskKey}" exceeded absolute age limit — invalidating and starting fresh`,
      );
    }
    if (persistentPlan.deleteRecord) {
      deletePersistentThreadRecord(taskKey);
    } else {
      existing.alive = false;
      setPersistentThreadRecord(taskKey, existing);
    }
  }
  if (existing && existing.alive && existing.threadId && persistentPlan.action === "resume_existing") {
    if (persistentPlan.strategy === "resume_generic") {
      console.log(
        `${TAG} context-carry resume for ${requestedSdkName} thread, task "${taskKey}"`,
      );
    } else {
      const label =
        persistentPlan.strategy === "resume_codex"
          ? "Codex thread"
          : persistentPlan.strategy === "resume_copilot"
            ? "Copilot session"
            : persistentPlan.strategy === "resume_claude"
              ? "Claude session"
              : "OpenCode session";
      console.log(
        `${TAG} resuming ${label} ${existing.threadId} for task "${taskKey}" (turn ${existing.turnCount + 1})`,
      );
    }
    const result = await poolProviderSessionRuntime.resumeSession({
      strategy: persistentPlan.strategy,
      sdkName: requestedSdkName,
      threadId: existing.threadId,
      prompt,
      cwd,
      timeoutMs,
      extra: {
        ...restExtra,
        taskKey,
      },
    });

    if (result?.success) {
      existing.turnCount += 1;
      existing.lastUsedAt = Date.now();
      existing.lastError = null;
      if (result.threadId) existing.threadId = result.threadId;
      if (persistentPlan.strategy !== "resume_codex") {
        existing.alive = !!existing.threadId;
      }
      setPersistentThreadRecord(taskKey, existing);
      finalizeManagedExternalExecution(sessionManager, managedSessionId, {
        success: true,
        status: "completed",
        threadId: existing.threadId,
        result: {
          ...result,
          resumed: true,
        },
      });
      return { ...result, resumed: true };
    }

    const poisonedResumeState =
      persistentPlan.strategy === "resume_codex"
      && (
        result?.poisonedResumeState
        || result?.staleResumeState
        || isPoisonedCodexResumeError(result?.error)
        || isCodexResumeTimeoutError(result?.error)
      );
    if (poisonedResumeState) {
      console.warn(
        `${TAG} resume failed for task "${taskKey}" with stale or corrupted state: ${result?.error}. Dropping cached thread metadata and starting fresh.`,
      );
      deletePersistentThreadRecord(taskKey);
    } else {
      const failurePrefix = persistentPlan.strategy === "resume_generic"
        ? `${TAG} context-carry resume failed for task "${taskKey}": ${result?.error}`
        : `${TAG} resume failed for task "${taskKey}": ${result?.error}. Starting fresh.`;
      console.warn(failurePrefix);
      existing.alive = false;
      existing.lastError = result?.error || existing.lastError || null;
      setPersistentThreadRecord(taskKey, existing);
    }
  }

  // Fresh launch — pre-register a thread as soon as the SDK exposes one.
  // This improves restart recovery for long-running tasks interrupted mid-turn.
  const callerOnThreadReady =
    typeof restExtra.onThreadReady === "function"
      ? restExtra.onThreadReady
      : null;
  const launchExtra = { ...restExtra };
  launchExtra.onThreadReady = (threadId, sdkName = null) => {
    const resolvedSdk =
      sdkName || launchExtra.sdk || resolvePoolSdkName() || "unknown";
    const sdkCanPersist = sdkSupportsPersistentThreads(resolvedSdk);

    if (threadId && sdkCanPersist) {
      const existing = getPersistentThreadRecord(taskKey);
      const createdAt = existing?.createdAt || Date.now();
      const turnCount = Number(existing?.turnCount || 1);
      setPersistentThreadRecord(taskKey, {
        threadId,
        sdk: resolvedSdk,
        taskKey,
        cwd,
        turnCount,
        createdAt,
        lastUsedAt: Date.now(),
        lastError: null,
        alive: true,
      });
    }
    if (callerOnThreadReady) {
      try {
        callerOnThreadReady(threadId, sdkName);
      } catch {
        /* caller errors must not break execution */
      }
    }
    if (managedSessionId) {
      registerManagedExternalExecution(sessionManager, managedSessionId, {
        scope: launchExtra.sessionScope || "task",
        sessionType: launchExtra.sessionType || "task",
        providerSelection: resolvedSdk,
        adapterName: resolvedSdk,
        taskKey,
        cwd,
        threadId,
        status: "active",
        metadata: managedSessionMetadata,
      });
    }
  };

  const result = await launchEphemeralThread(
    prompt,
    cwd,
    timeoutMs,
    launchExtra,
  );

  // Register/update thread record for future resume
  const existingRecord = getPersistentThreadRecord(taskKey);
  const resultSdk =
    result.sdk ||
    launchExtra.sdk ||
    existingRecord?.sdk ||
    resolvePoolSdkName() ||
    "unknown";
  const sdkCanPersist = sdkSupportsPersistentThreads(resultSdk);
  const finalThreadId = sdkCanPersist
    ? result.threadId ||
      (existingRecord?.sdk === resultSdk ? existingRecord?.threadId : null) ||
      null
    : null;
  const record = {
    threadId: finalThreadId,
    sdk: resultSdk,
    taskKey,
    cwd,
    turnCount: Number(existingRecord?.turnCount || 1),
    createdAt: existingRecord?.createdAt || Date.now(),
    lastUsedAt: Date.now(),
    lastError: result.success ? null : result.error,
    alive: result.success && sdkCanPersist && !!finalThreadId,
  };
  setPersistentThreadRecord(taskKey, record);
  if (managedSessionId) {
    registerManagedExternalExecution(sessionManager, managedSessionId, {
      scope: restExtra.sessionScope || "task",
      sessionType: restExtra.sessionType || "task",
      providerSelection: resultSdk,
      adapterName: resultSdk,
      taskKey,
      cwd,
      threadId: finalThreadId,
      status: result.success ? "active" : "failed",
      error: result.success ? null : result.error,
      metadata: {
        ...managedSessionMetadata,
        resumed: false,
      },
    });
    finalizeManagedExternalExecution(sessionManager, managedSessionId, {
      success: result.success,
      status: result.success ? "completed" : "failed",
      threadId: finalThreadId,
      error: result.success ? null : result.error,
      result: {
        ...result,
        resumed: false,
      },
    });
  }

  // Apply tiered context compression for persistent threads
  // Estimate context usage so shredding only kicks in above 50% fill.
  if (result.success && Array.isArray(result.items) && result.items.length > 0) {
    try {
      const compressedItems = await maybeCompressResultItems(result.items, {
        sdk: resultSdk,
        sessionType: restExtra.sessionType || "task",
        sessionId: managedSessionId || restExtra.sessionId || null,
        allowCompression: true,
        forceCompression: restExtra.forceContextShredding === true,
        skipCompression: restExtra.skipContextShredding === true,
      });
      return { ...result, items: compressedItems, threadId: finalThreadId, resumed: false };
    } catch (compErr) {
      console.warn(`${TAG} context compression failed (non-fatal): ${compErr.message}`);
    }
  }

  return { ...result, threadId: finalThreadId, resumed: false };
  });
}

export async function continueSession(sessionId, prompt, options = {}) {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId) {
    throw new Error(`${TAG} continueSession requires a sessionId`);
  }

  const sessionManager = getBosunSessionManager();
  const managedSession = sessionManager.getSession(normalizedSessionId);
  const managedMetadata = toPlainObject(managedSession?.metadata);
  const timeoutMs = Number(options.timeoutMs || options.timeout) || DEFAULT_TIMEOUT_MS;
  const cwd = options.cwd || managedMetadata.cwd || process.cwd();
  const resolvedTaskKey =
    String(options.taskKey || managedSession?.taskKey || normalizedSessionId).trim()
    || normalizedSessionId;
  const resolvedThreadId =
    String(
      options.resumeThreadId ||
      managedSession?.activeThreadId ||
      managedSession?.threadId ||
      normalizedSessionId,
    ).trim() || normalizedSessionId;
  const resolvedScope =
    String(options.sessionScope || managedSession?.scope || managedMetadata.scope || "task").trim()
    || "task";
  const resolvedSessionType =
    String(options.sessionType || managedSession?.sessionType || "task").trim()
    || "task";
  const resolvedSdk =
    options.sdk ||
    managedMetadata.providerSelection ||
    managedMetadata.adapterName ||
    undefined;
  bindManagedExternalSessionController(sessionManager, normalizedSessionId, {
    ...options,
    taskKey: resolvedTaskKey,
    sessionId: managedSession?.sessionId || normalizedSessionId,
    sessionScope: resolvedScope,
    sessionType: resolvedSessionType,
    parentSessionId: options.parentSessionId || managedSession?.parentSessionId || undefined,
    rootSessionId: options.rootSessionId || managedSession?.rootSessionId || undefined,
    resumeThreadId: resolvedThreadId,
    sdk: resolvedSdk,
    cwd,
    timeoutMs,
    metadata: {
      ...managedMetadata,
      ...toPlainObject(options.metadata),
      source: "agent-pool-continue",
      resumedFromSessionId: normalizedSessionId,
    },
  });
  return await sessionManager.continueSession(normalizedSessionId, {
    lifecycleState: "running",
    action: "continue",
    runRequest: {
      ...options,
      prompt,
      timeoutMs,
      cwd,
      taskKey: resolvedTaskKey,
      sessionId: managedSession?.sessionId || normalizedSessionId,
      sessionScope: resolvedScope,
      sessionType: resolvedSessionType,
      parentSessionId: options.parentSessionId || managedSession?.parentSessionId || undefined,
      rootSessionId: options.rootSessionId || managedSession?.rootSessionId || undefined,
      resumeThreadId: resolvedThreadId,
      sdk: resolvedSdk,
      metadata: {
        ...managedMetadata,
        ...toPlainObject(options.metadata),
        source: "agent-pool-continue",
        resumedFromSessionId: normalizedSessionId,
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Error Recovery Wrapper
// ---------------------------------------------------------------------------

const RETRY_OUTPUT_PLACEHOLDERS = new Set([
  "",
  "(agent completed with no text output)",
  "(resumed - no text output)",
  "(resumed — no text output)",
  "continued",
  "model response continued",
]);

const EXPLICIT_COMPLETION_LABEL_RE = /^\s*(?:completion(?:\s+message)?|task complete|done|completed)\s*:/im;
const EXPLICIT_COMPLETION_SIGNAL_RE = /task[_ ]complete\b/im;
const SESSION_COMPLETE_SIGNAL_RE = /^\s*session\.(?:turn|stream)\.complete\s*:/im;
const PLAIN_COMPLETION_PREFIX_RE = /^\s*(?:done|complete|completed|finished)\.?(?:\s|$)/i;
const TERMINAL_BLOCKED_PREFIX_RE = /^\s*(?:blocked:|i(?:'|’)?m blocked\b|i am blocked\b)/im;
const TERMINAL_NOOP_SUMMARY_RE = /^\s*(?:implemented and verified\.|confirmed\.\s+(?:the task work is already done|no new work remains|no additional work was needed|no additional code changes were required)|nothing new to do here\b)/im;
const TERMINAL_REFUSAL_PREFIX_RE = /^\s*(?:i(?:'|’)?m sorry,?\s+but\s+i\s+can(?:'|’)t|i\s+can\s+help,\s+but\s+i\s+can(?:'|’)t)\b/im;
const CONTINUATION_TRANSCRIPT_REFUSAL_RE = /(?:impersonate prior tool execution|continue a tool-use transcript|tool-call transcript|transcript dump|pasted transcript|pretend prior tool calls happened|silently continue a broken transcript|ask me again in a clean turn|normal workspace session|stable workspace session|live editable session|reliable command\/file mutation state|workspace mutation state)/i;
const TERMINAL_NOOP_INDICATORS = [
  /\balready implemented\b/i,
  /\balready complete(?:d)?\b/i,
  /\balready present\b/i,
  /\bnothing left to change\b/i,
  /\bnothing remains to implement\b/i,
  /\bno further action (?:is needed|required)\b/i,
  /\bno additional (?:changes|code changes|work) (?:were|was) (?:required|needed)\b/i,
  /\bno new work remains\b/i,
  /\bno new commit (?:created|required)\b/i,
  /\bworkspace is clean\b/i,
  /\bno uncommitted diff\b/i,
  /\bgit status --short\b.*\bclean\b/i,
];

const STRUCTURED_COMPLETION_HANDOFF_PATTERNS = [
  [/\bsummary\b/i, /\blikely touched files\b/i, /\bcompact editor handoff\b/i],
  [/\bvalidation run\b/i, /\brepository touched\b/i],
  [/\bonly completed the .* phase\b/i, /\bwhat i changed\b/i, /\bwhat it verifies\b/i],
];

const STRUCTURED_BLOCKED_HANDOFF_PATTERNS = [
  [/\bblocked:/i, /\bcompletion notes\b/i],
  [/\bstill blocked\b/i, /\bstate summary\b/i],
  [/\bblocked:/i, /\brepositories touched\b/i],
  [/\bblocked:/i, /\bworkspace remained clean\b/i],
  [
    /\bblocked:/i,
    /\bworkspace remain(?:s|ed) clean\b/i,
    /\b(?:no files were modified|no code changes were applied|no implementation was applied|have not applied any implementation changes)\b/i,
  ],
];

const COPILOT_TURN_SETTLE_MS = 1500;

function mergeAssistantText(existing, fragment) {
  const normalizedExisting = String(existing || "").trim();
  const normalizedFragment = String(fragment || "").trim();
  if (!normalizedFragment) return normalizedExisting;
  if (!normalizedExisting) return normalizedFragment;
  if (normalizedExisting === normalizedFragment) return normalizedExisting;
  if (normalizedFragment.includes(normalizedExisting)) return normalizedFragment;
  if (normalizedExisting.includes(normalizedFragment)) return normalizedExisting;
  return `${normalizedExisting}\n${normalizedFragment}`;
}

function collectResultText(result = {}) {
  const outputText = [
    result?.output,
    result?.summary,
    result?.narrative,
    result?.message,
    ...(Array.isArray(result?.stream) ? result.stream : []),
  ]
    .map((fragment) => String(fragment || ""))
    .filter(Boolean)
    .join("\n");
  const itemText = Array.isArray(result?.items)
    ? result.items
      .map((item) => {
        if (!item || typeof item !== "object") return String(item || "");
        const contentText = Array.isArray(item.content)
          ? item.content.map((entry) => String(entry?.text || "")).filter(Boolean).join("\n")
          : String(item.content || "");
        const eventDataText = item.data && typeof item.data === "object"
          ? [
              item.data.content,
              item.data.deltaContent,
              item.data.reasoningText,
              item.data.message,
            ]
            .map((fragment) => String(fragment || ""))
            .filter(Boolean)
            .join("\n")
          : "";
        return [
          item.text,
          item.message,
          item.summary,
          contentText,
          eventDataText,
        ]
          .map((fragment) => String(fragment || ""))
          .filter(Boolean)
          .join("\n");
      })
      .join("\n")
    : "";
  return `${outputText}\n${itemText}`.trim();
}

function hasExplicitCompletionSignal(result = {}) {
  if (result?._hasExplicitCompletionSignal === true) return true;
  const hasLifecycleCompletionSignal = Array.isArray(result?.items)
    && result.items.some((item) => {
      const lifecycle = String(item?.meta?.lifecycle || item?.lifecycle || "").trim().toLowerCase();
      return lifecycle === "session_turn_complete"
        || lifecycle === "session_stream_complete"
        || lifecycle === "session_completed";
    });
  const text = collectResultText(result);
  const noopIndicatorCount = text
    ? TERMINAL_NOOP_INDICATORS.reduce(
      (count, pattern) => count + (pattern.test(text) ? 1 : 0),
      0,
    )
    : 0;
  if (!text) return hasLifecycleCompletionSignal;
  const hasStructuredCompletionHandoff = STRUCTURED_COMPLETION_HANDOFF_PATTERNS.some((group) =>
    group.every((pattern) => pattern.test(text)),
  );
  const hasStructuredBlockedHandoff = STRUCTURED_BLOCKED_HANDOFF_PATTERNS.some((group) =>
    group.every((pattern) => pattern.test(text)),
  );
  return SESSION_COMPLETE_SIGNAL_RE.test(text)
    || hasLifecycleCompletionSignal
    || EXPLICIT_COMPLETION_LABEL_RE.test(text)
    || EXPLICIT_COMPLETION_SIGNAL_RE.test(text)
    || TERMINAL_BLOCKED_PREFIX_RE.test(text)
    || PLAIN_COMPLETION_PREFIX_RE.test(text)
    || hasStructuredCompletionHandoff
    || hasStructuredBlockedHandoff
    || TERMINAL_NOOP_SUMMARY_RE.test(text)
    || noopIndicatorCount >= 2;
}

function getContinuationRefusalMessage(result = {}) {
  const text = collectResultText(result);
  if (!text || !TERMINAL_REFUSAL_PREFIX_RE.test(text)) {
    return "";
  }
  if (
    CONTINUATION_TRANSCRIPT_REFUSAL_RE.test(text)
    || /\bcan(?:'|’)t complete this task as requested\b/i.test(text)
  ) {
    return text.split(/\n\s*\n/, 1)[0]?.trim() || text;
  }
  return "";
}

const RETRY_RECONNECT_PATTERNS = [
  /session\.idle/i,
  /no events received/i,
  /first_event_timeout/i,
  /timeout_no_events/i,
  /stream disconnection/i,
  /transient stream error/i,
  /transport/i,
  /network/i,
  /econnreset/i,
  /socket hang up/i,
  /connection.*closed/i,
  /connection.*reset/i,
  /reconnect/i,
];

function hasMeaningfulRetryResult(result = {}) {
  const output = String(result?.output || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!RETRY_OUTPUT_PLACEHOLDERS.has(output)) return true;
  if (Array.isArray(result?.items) && result.items.length > 0) return true;
  return false;
}

function normalizeRetryFailureFingerprint(result = {}) {
  const errorText = String(result?.error || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!errorText) return "";
  if (RETRY_RECONNECT_PATTERNS.some((pattern) => pattern.test(errorText))) {
    return errorText
      .replace(/\bafter \d+ms\b/g, "after <ms>")
      .replace(/attempt \d+\/\d+/g, "attempt <n>/<n>")
      .replace(/[a-f0-9]{8,}/g, "<id>")
      .slice(0, 160);
  }
  return "";
}

function classifyRetryCircuitBreak(result = {}, state = {}) {
  if (result?.success) {
    return {
      fingerprint: "",
      repeatedFingerprint: false,
      noOutputFailure: false,
      shouldBreak: false,
      blockedReason: null,
      error: null,
    };
  }

  const fingerprint = normalizeRetryFailureFingerprint(result);
  const repeatedFingerprint = Boolean(fingerprint) && Number(state.failureFingerprints?.get(fingerprint) || 0) >= 1;
  const noOutputFailure = !hasMeaningfulRetryResult(result);
  const repeatedNoOutput = noOutputFailure && Number(state.consecutiveNoOutputFailures || 0) >= 1;

  if (repeatedFingerprint) {
    return {
      fingerprint,
      repeatedFingerprint: true,
      noOutputFailure,
      shouldBreak: true,
      blockedReason: "blocked_by_env",
      error: `Repeated reconnect fingerprint detected: ${fingerprint}`,
    };
  }

  if (repeatedNoOutput) {
    return {
      fingerprint,
      repeatedFingerprint: false,
      noOutputFailure: true,
      shouldBreak: true,
      blockedReason: "no_output",
      error: "Repeated no-output agent starts detected; stopping retries",
    };
  }

  return {
    fingerprint,
    repeatedFingerprint: false,
    noOutputFailure,
    shouldBreak: false,
    blockedReason: null,
    error: null,
  };
}

/**
 * Execute a prompt with automatic error recovery via thread resume.
 *
 * If the initial run fails, this will:
 *   1. Resume the same thread with the error context
 *   2. Ask the agent to diagnose and fix the issue
 *   3. Retry up to `maxRetries` times
 *
 * Supports mid-execution CONTINUE signals:
 *   When the AbortController is aborted with reason "idle_continue",
 *   the current attempt is treated as a soft failure and retried with a
 *   CONTINUE prompt. A fresh AbortController is created for the next attempt.
 *   Up to `maxContinues` additional attempts are allowed for idle continues.
 *
 * @param {string}  prompt      Initial prompt.
 * @param {object}  options     Options:
 * @param {string}  options.taskKey       Required — identifies the thread.
 * @param {string}  [options.cwd]         Working directory.
 * @param {number}  [options.timeoutMs]   Per-attempt timeout.
 * @param {number}  [options.maxRetries]  Max follow-up attempts (default: 2).
 * @param {number}  [options.maxContinues] Max continuation attempts (default: 24).
 * @param {boolean} [options.requireCompletionSignal] Require explicit completion signal before returning success (default: true).
 * @param {Function} [options.shouldRetry] Custom predicate: (result) => boolean.
 * @param {Function} [options.buildRetryPrompt] Custom retry prompt builder: (result, attempt) => string.
 * @param {Function} [options.buildContinuePrompt] Custom continue prompt builder: (result, attempt) => string.
 * @param {string}  [options.sdk]         Force SDK.
 * @param {string}  [options.model]       Force model for SDKs that support it.
 * @param {Function} [options.onEvent]    Event callback.
 * @param {Function} [options.onAbortControllerReplaced] Called when AbortController is replaced after idle_continue.
 * @returns {Promise<{ success: boolean, output: string, items: Array, error: string|null, sdk: string, attempts: number, continues: number, resumed: boolean }>}
 */
export async function execWithRetry(prompt, options = {}) {
  const {
    taskKey,
    cwd = REPO_ROOT,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = 2,
    maxContinues = 24,
    requireCompletionSignal = true,
    shouldRetry,
    buildRetryPrompt,
    buildContinuePrompt,
    sdk,
    model,
    mcpServers,
    sessionType = "task",
    sessionId,
    sessionScope,
    parentSessionId,
    rootSessionId,
    metadata,
    onEvent,
    onAbortControllerReplaced,
    pinSdk = false,
    slotOwnerKey,
    slotMeta,
    slotMaxParallel,
    onSlotQueued,
    onSlotAcquired,
    onSlotReleased,
  } = options;

  // AbortController can be replaced on idle_continue, so track it mutably
  let abortController = options.abortController ?? null;

  if (!taskKey) {
    throw new Error(
      `${TAG} execWithRetry requires a taskKey for thread persistence`,
    );
  }

  let lastResult = null;
  const totalAttempts = 1 + maxRetries;
  let continuesUsed = 0;
  let attempt = 0;
  const failureFingerprints = new Map();
  let consecutiveNoOutputFailures = 0;
  const enforceCompletionSignal =
    requireCompletionSignal !== false
    && String(sessionType || "task").toLowerCase() !== "ephemeral";

  while (attempt < totalAttempts + continuesUsed) {
    attempt++;
    const isIdleContinue =
      lastResult?.error === "idle_continue" ||
      lastResult?._idleContinue === true;
    const isCompletionSignalContinue =
      lastResult?.error === "completion_signal_missing" ||
      lastResult?._awaitingCompletionSignal === true;
    const isContinuationAttempt = isIdleContinue || isCompletionSignalContinue;

    const currentPrompt =
      attempt === 1
        ? prompt
        : isContinuationAttempt && typeof buildContinuePrompt === "function"
          ? buildContinuePrompt(lastResult, attempt)
          : isCompletionSignalContinue
            ? `# CONTINUE WORK — TASK IS NOT COMPLETE\n\nContinue from the current workspace state and your current session state to finish the remaining work. If any prior tool transcript is missing or compressed, re-open the relevant files or rerun focused checks instead of claiming you cannot continue.\n\nReturn ONLY when all required work is done and include an explicit completion signal line such as one of:\n- Completion: <summary>\n- Completion message: <summary>\n- Task complete: <summary>\n- DONE: <summary>\n- COMPLETED: <summary>\n- task_complete\n\nDo not stop after partial progress.`
            : isIdleContinue
              ? "Continue exactly where you left off. Resume execution from the last incomplete step, avoid redoing completed work, and finish the task end-to-end."
          : typeof buildRetryPrompt === "function"
            ? buildRetryPrompt(lastResult, attempt)
            : `# ERROR RECOVERY — Attempt ${attempt}/${totalAttempts}\n\nYour previous attempt failed with:\n\`\`\`\n${lastResult?.error || lastResult?.output || "(unknown error)"}\n\`\`\`\n\nPlease diagnose the issue, fix it, and try again. Here was the original task:\n\n${prompt}`;

    console.log(
      `${TAG} execWithRetry: attempt ${attempt}/${totalAttempts + continuesUsed} for task "${taskKey}"${attempt > 1 ? (isIdleContinue ? " (idle-continue)" : " (resume)") : ""}`,
    );

    // Check if externally aborted (hard kill, not idle_continue)
    if (abortController?.signal?.aborted) {
      const reason = abortController.signal.reason;

      if (reason === "idle_continue" && continuesUsed < maxContinues) {
        // Soft abort — agent went idle, send CONTINUE
        continuesUsed++;
        console.log(
          `${TAG} idle_continue detected for "${taskKey}" (continue ${continuesUsed}/${maxContinues}) — sending CONTINUE prompt`,
        );

        // Replace the AbortController so the next attempt isn't pre-aborted
        abortController = new AbortController();
        if (typeof onAbortControllerReplaced === "function") {
          try {
            onAbortControllerReplaced(abortController);
          } catch {
            /* caller errors must not break execution */
          }
        }

        lastResult = {
          success: false,
          output: lastResult?.output || "",
          items: lastResult?.items || [],
          error: "idle_continue",
          sdk: sdk || "unknown",
          threadId: lastResult?.threadId || null,
          _idleContinue: true,
        };
        continue;
      }

      // Hard abort (watchdog_timeout or unknown)
      lastResult = {
        success: false,
        output: "",
        items: [],
        error: `Externally aborted (${reason || "watchdog or manual kill"})`,
        sdk: sdk || "unknown",
        threadId: null,
      };
      break;
    }

    lastResult = await launchOrResumeThread(currentPrompt, cwd, timeoutMs, {
      taskKey,
      sdk,
      model,
      mcpServers,
      sessionType,
      sessionId,
      sessionScope,
      parentSessionId,
      rootSessionId,
      metadata,
      onEvent,
      abortController,
      pinSdk,
      ignoreSdkCooldown: attempt > 1,
      slotOwnerKey,
      slotMeta,
      slotMaxParallel,
      onSlotQueued,
      onSlotAcquired,
      onSlotReleased,
    });

    // Check post-launch if aborted with idle_continue (race: abort fired during execution)
    if (
      !lastResult.success &&
      abortController?.signal?.aborted &&
      abortController.signal.reason === "idle_continue" &&
      continuesUsed < maxContinues
    ) {
      continuesUsed++;
      console.log(
        `${TAG} idle_continue (post-launch) for "${taskKey}" (continue ${continuesUsed}/${maxContinues})`,
      );

      abortController = new AbortController();
      if (typeof onAbortControllerReplaced === "function") {
        try {
          onAbortControllerReplaced(abortController);
        } catch {
          /* best-effort */
        }
      }

      lastResult._idleContinue = true;
      continue;
    }

    const retryCircuit = classifyRetryCircuitBreak(lastResult, {
      failureFingerprints,
      consecutiveNoOutputFailures,
    });
    if (retryCircuit.fingerprint) {
      failureFingerprints.set(
        retryCircuit.fingerprint,
        Number(failureFingerprints.get(retryCircuit.fingerprint) || 0) + 1,
      );
    }
    consecutiveNoOutputFailures = retryCircuit.noOutputFailure
      ? consecutiveNoOutputFailures + 1
      : 0;

    if (retryCircuit.shouldBreak) {
      console.warn(`${TAG} execWithRetry circuit breaker tripped for "${taskKey}": ${retryCircuit.error}`);
      return {
        ...lastResult,
        error: retryCircuit.error,
        blockedReason: retryCircuit.blockedReason,
        retryCircuitBroken: true,
        failureFingerprint: retryCircuit.fingerprint || null,
        attempts: attempt,
        continues: continuesUsed,
      };
    }

    // Check if we should retry
    if (lastResult.success) {
      // If caller has custom shouldRetry (e.g. "output must contain 'PASS'"), check it
      if (typeof shouldRetry === "function" && shouldRetry(lastResult)) {
        console.log(
          `${TAG} attempt ${attempt} succeeded but shouldRetry returned true`,
        );
        continue;
      }

      const continuationRefusalMessage =
        isContinuationAttempt || continuesUsed > 0 || attempt > 1
          ? getContinuationRefusalMessage(lastResult)
          : "";
      if (continuationRefusalMessage) {
        forceNewThread(taskKey, `continuation_refusal_attempt_${attempt}`);
        lastResult = {
          ...lastResult,
          success: false,
          error: `Agent refused continuation: ${continuationRefusalMessage}`,
          blockedReason: "continuation_refusal",
          _continuationRefusal: true,
        };
      }

      if (!lastResult.success) {
        const retriesLeft = totalAttempts + continuesUsed - attempt;
        if (retriesLeft > 0) {
          console.warn(
            `${TAG} attempt ${attempt} hit continuation refusal for "${taskKey}" — forcing a fresh thread retry (${retriesLeft} left)`,
          );
        }
      }

      if (lastResult.success && enforceCompletionSignal && !hasExplicitCompletionSignal(lastResult)) {
        if (continuesUsed < maxContinues) {
          continuesUsed++;
          console.log(
            `${TAG} attempt ${attempt} succeeded but missing explicit completion signal for "${taskKey}" (continue ${continuesUsed}/${maxContinues})`,
          );
          lastResult = {
            ...lastResult,
            success: false,
            error: "completion_signal_missing",
            _awaitingCompletionSignal: true,
          };
          continue;
        }

        return {
          ...lastResult,
          success: false,
          error: "Missing explicit completion signal after continuation budget exhausted",
          blockedReason: "incomplete_no_completion_signal",
          attempts: attempt,
          continues: continuesUsed,
        };
      }

      if (lastResult.success) {
        return { ...lastResult, attempts: attempt, continues: continuesUsed };
      }
    }

    // Failed — should we retry?
    const retriesLeft = totalAttempts + continuesUsed - attempt;
    const overflowFailure = isContextOverflowError(lastResult.error);
    if (overflowFailure) {
      forceNewThread(taskKey, `context_overflow_attempt_${attempt}`);
      console.warn(
        `${TAG} attempt ${attempt} hit context overflow for "${taskKey}" — invalidated persistent thread before retry`,
      );
    }
    if (isDeterministicSdkFailure(lastResult.error)) {
      console.warn(
        `${TAG} attempt ${attempt} hit deterministic SDK failure; retry suppressed: ${lastResult.error}`,
      );
      return { ...lastResult, attempts: attempt, continues: continuesUsed };
    }
    if (retriesLeft > 0) {
      if (typeof shouldRetry === "function" && !shouldRetry(lastResult)) {
        // Custom predicate says don't retry
        console.log(`${TAG} shouldRetry returned false — not retrying`);
        return { ...lastResult, attempts: attempt, continues: continuesUsed };
      }
      console.warn(
        `${TAG} attempt ${attempt} failed, will retry (${retriesLeft} left): ${lastResult.error}`,
      );
    }
  }

  return { ...lastResult, attempts: attempt, continues: continuesUsed };
}

function formatHarnessValidationError(validationReport) {
  const errorIssues = Array.isArray(validationReport?.errors)
    ? validationReport.errors
    : Array.isArray(validationReport?.issues)
      ? validationReport.issues.filter((issue) => issue?.level === "error")
      : [];
  if (errorIssues.length === 0) {
    return "Internal harness profile is invalid.";
  }
  return errorIssues
    .map((issue) =>
      issue?.path
        ? `${issue.code} (${issue.path}): ${issue.message}`
        : `${issue.code}: ${issue.message}`)
    .join("\n");
}

function buildHarnessTurnExecutor(options = {}) {
  return buildInternalHarnessTurnExecutor({
    ...options,
    defaultCwd: options.cwd || REPO_ROOT,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    normalizeTimeoutMs: normalizeHarnessTimeoutMs,
    execWithRetry,
    launchOrResumeThread,
  });
}

export function compileInternalHarnessSource(source, options = {}) {
  return compileInternalHarnessProfile(source, buildHarnessCompileOptions({
    ...options,
    cwd: options.cwd || REPO_ROOT,
  }));
}

function buildHarnessFacadeOptions(options = {}, overrides = {}) {
  return {
    ...options,
    ...overrides,
    onHarnessEvent: overrides.onHarnessEvent ?? options.onHarnessEvent,
    steerActiveTurn: (taskKey, prompt) => steerActiveThread(taskKey, prompt),
    buildTurnExecutor: (sessionOptions) => buildHarnessTurnExecutor(sessionOptions),
  };
}

export function createCompiledInternalHarnessSession(compiledProfile, options = {}) {
  const normalizedTimeoutMs = normalizeHarnessTimeoutMs(options.timeoutMs);
  return createManagedCompiledHarnessSession(compiledProfile, buildHarnessFacadeOptions(options, {
    timeoutMs: normalizedTimeoutMs ?? options.timeoutMs,
  }));
}

export function createInternalHarnessSession(profileSource, options = {}) {
  return createManagedHarnessSession(profileSource, buildHarnessFacadeOptions(options, {
    compileHarnessSource: (source, compileOptions) => compileInternalHarnessSource(source, compileOptions),
  }));
}

export async function runCompiledInternalHarnessProfile(compiledProfile, options = {}) {
  return runManagedCompiledHarnessSession(compiledProfile, buildHarnessFacadeOptions(options));
}

export async function runInternalHarnessProfile(profileSource, options = {}) {
  return runManagedHarnessSession(profileSource, buildHarnessFacadeOptions(options, {
    compileHarnessSource: (source, compileOptions) => compileInternalHarnessSource(source, compileOptions),
  }));
}

// ---------------------------------------------------------------------------
// Thread Management Exports
// ---------------------------------------------------------------------------

/**
 * Get the thread record for a task key.
 * @param {string} taskKey
 * @returns {ThreadRecord|null}
 */
export function getThreadRecord(taskKey) {
  return getManagedThreadRecord(taskKey);
}

/**
 * Async invalidate helper that first loads persisted registry state.
 * Useful at process startup to avoid races with lazy registry restore.
 *
 * @param {string} taskKey
 * @returns {Promise<void>}
 */
export async function invalidateThreadAsync(taskKey) {
  return invalidateManagedThreadAsync(taskKey);
}

/**
 * Invalidate (kill) a thread record so it won't be resumed.
 * @param {string} taskKey
 */
export function invalidateThread(taskKey) {
  const invalidated = invalidateManagedThread(taskKey);
  if (!invalidated) {
    invalidateThreadAsync(taskKey).catch((err) => {
      console.warn(
        TAG + " deferred invalidateThreadAsync failed for \"" + taskKey + "\": " + (err?.message || err),
      );
    });
  }
  return invalidated;
}

/**
 * Invalidate a thread and force a fresh start on next attempt.
 * Unlike invalidateThread which just sets alive=false, this also logs the reason.
 * @param {string} taskKey
 * @param {string} reason
 */
export function forceNewThread(taskKey, reason = "manual") {
  const record = getPersistentThreadRecord(taskKey);
  if (record) {
    console.log(
      `${TAG} force-invalidating thread for task "${taskKey}": ${reason} (was turn ${record.turnCount})`,
    );
  }
  invalidateThread(taskKey);
}

/**
 * Clear all thread records (e.g. on monitor restart).
 */
export function clearThreadRegistry() {
  return clearManagedThreadRegistry();
}

/**
 * Prune all threads that have exceeded MAX_THREAD_TURNS or are older than THREAD_MAX_ABSOLUTE_AGE_MS.
 * Call on startup to clean up zombie threads from prior runs.
 * @returns {number} Number of threads pruned
 */
export function pruneAllExhaustedThreads() {
  return pruneManagedAllExhaustedThreads();
}

/**
 * Get summary of all active threads.
 * @returns {Array<{ taskKey: string, sdk: string, threadId: string|null, turnCount: number, age: number }>}
 */
export function getActiveThreads() {
  return getManagedActiveThreads();
}



export const __testables = {
  shouldApplySdkCooldown,
  shouldFallbackForSdkError,
  hasMeaningfulRetryResult,
  hasExplicitCompletionSignal,
  normalizeRetryFailureFingerprint,
  classifyRetryCircuitBreak,
  injectGitHubSessionEnv,
};
