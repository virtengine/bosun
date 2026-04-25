/**
 * workflow-engine-worker.mjs
 *
 * Worker thread that hosts the Bosun workflow engine, completely isolated from
 * the UI server's HTTP / WebSocket event loop.
 *
 * Protocol (parentPort messages):
 *
 * Parent → Worker:
 *   { type: "init",    workerData: { repoRoot, workflowDir, runsDir } }
 *   { type: "call",    callId, method, args }      — proxied engine method call
 *   { type: "svc-res", callId, result?, error? }   — response to a service call
 *
 * Worker → Parent:
 *   { type: "ready" }                              — engine fully initialised
 *   { type: "result",  callId, result }            — successful engine call
 *   { type: "error",   callId, error, stack? }     — failed engine call
 *   { type: "event",   eventName, payload }        — forwarded engine event
 *   { type: "svc-call",callId, method, args }      — request main-thread service
 */

import { parentPort, workerData } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = workerData?.repoRoot || resolve(__dirname, "..");
const MAX_CLONE_SANITIZE_DEPTH = 8;

// ── Pending service calls (worker awaiting main-thread response) ──────────────
const pendingSvcCalls = new Map();

function describeFunction(value) {
  const name = String(value?.name || "").trim();
  return name ? `[Function ${name}]` : "[Function]";
}

function sanitizeCloneSafeValue(value, options = {}, depth = 0, seen = new WeakSet()) {
  const hasOwn = (key) => Object.prototype.hasOwnProperty.call(options || {}, key);
  const functionValue = hasOwn("functionValue") ? options.functionValue : "[Function]";
  const circularValue = hasOwn("circularValue") ? options.circularValue : "[Circular]";
  const truncationValue = hasOwn("truncationValue") ? options.truncationValue : "[Truncated]";
  const includeErrorStack = hasOwn("includeErrorStack") ? options.includeErrorStack : true;

  if (depth > MAX_CLONE_SANITIZE_DEPTH) return truncationValue;
  if (value === null || value === undefined) return value;

  const valueType = typeof value;
  if (valueType === "function") {
    return typeof functionValue === "function"
      ? functionValue(value)
      : functionValue;
  }
  if (valueType === "symbol") return String(value);
  if (valueType !== "object") return value;

  if (seen.has(value)) return circularValue;
  if (value instanceof Date) return value;
  if (value instanceof URL) return String(value);
  if (value instanceof RegExp) return String(value);
  if (value instanceof Error) {
    seen.add(value);
    const out = {
      name: value.name || "Error",
      message: value.message || "",
    };
    if (includeErrorStack && value.stack) out.stack = value.stack;
    if (value.code != null) out.code = value.code;
    if (value.cause !== undefined) {
      out.cause = sanitizeCloneSafeValue(value.cause, options, depth + 1, seen);
    }
    for (const [key, entry] of Object.entries(value)) {
      if (key in out) continue;
      const next = sanitizeCloneSafeValue(entry, options, depth + 1, seen);
      if (next !== undefined) out[key] = next;
    }
    seen.delete(value);
    return out;
  }
  if (Array.isArray(value)) {
    seen.add(value);
    const out = value.map((entry) => sanitizeCloneSafeValue(entry, options, depth + 1, seen));
    seen.delete(value);
    return out;
  }
  if (value instanceof Map) {
    seen.add(value);
    const out = Array.from(value.entries(), ([key, entry]) => ([
      sanitizeCloneSafeValue(key, options, depth + 1, seen),
      sanitizeCloneSafeValue(entry, options, depth + 1, seen),
    ]));
    seen.delete(value);
    return out;
  }
  if (value instanceof Set) {
    seen.add(value);
    const out = Array.from(value.values(), (entry) =>
      sanitizeCloneSafeValue(entry, options, depth + 1, seen),
    );
    seen.delete(value);
    return out;
  }
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (value instanceof ArrayBuffer) return value.slice(0);

  seen.add(value);
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    const next = sanitizeCloneSafeValue(entry, options, depth + 1, seen);
    if (next !== undefined) out[key] = next;
  }
  seen.delete(value);
  return out;
}

function sanitizeWorkerMessage(message) {
  const type = String(message?.type || "");
  const options = type === "svc-call"
    ? {
        functionValue: undefined,
        circularValue: "[Circular]",
        truncationValue: "[Truncated]",
      }
    : {
        functionValue: describeFunction,
        circularValue: "[Circular]",
        truncationValue: "[Truncated]",
      };
  return sanitizeCloneSafeValue(message, options);
}

function assertCloneSafeWorkerMessage(message, label = "workflow worker message") {
  if (typeof structuredClone !== "function") return message;
  try {
    structuredClone(message);
    return message;
  } catch (error) {
    const wrapped = new Error(
      `${label} is not structured-clone safe: ${error?.message || "unknown structuredClone failure"}`,
    );
    wrapped.cause = error;
    throw wrapped;
  }
}

function buildCloneSafeWorkerMessage(message, label = "workflow worker message") {
  return assertCloneSafeWorkerMessage(sanitizeWorkerMessage(message), label);
}

function postCloneSafeWorkerMessage(message, label = "workflow worker message") {
  if (!parentPort) {
    throw new Error("Workflow worker parent port is unavailable");
  }
  const safeMessage = buildCloneSafeWorkerMessage(message, label);
  parentPort.postMessage(safeMessage);
  return safeMessage;
}

function callMainService(method, args) {
  return new Promise((resolve, reject) => {
    if (!parentPort) {
      reject(new Error("Workflow worker parent port is unavailable"));
      return;
    }
    const callId = randomUUID();
    let safeMessage;
    try {
      safeMessage = buildCloneSafeWorkerMessage(
        { type: "svc-call", callId, method, args },
        `workflow worker svc-call ${method}`,
      );
    } catch (error) {
      reject(error);
      return;
    }
    pendingSvcCalls.set(callId, { resolve, reject });
    try {
      parentPort.postMessage(safeMessage);
    } catch (error) {
      pendingSvcCalls.delete(callId);
      reject(error);
    }
  });
}

// ── Load workflow modules ──────────────────────────────────────────────────────
let engine = null;

async function initEngine(cfg = {}) {
  const base = pathToFileURL(repoRoot + "/").href;

  const [wfEngineMod, wfNodesMod, wfTemplatesMod] = await Promise.all([
    import(new URL("./workflow/workflow-engine.mjs", base).href),
    import(new URL("./workflow/workflow-nodes.mjs",  base).href),
    import(new URL("./workflow/workflow-templates.mjs", base).href),
  ]);

  if (typeof wfNodesMod?.ensureWorkflowNodeTypesLoaded === "function") {
    await wfNodesMod.ensureWorkflowNodeTypesLoaded({ repoRoot });
  }

  // ── Build proxied service bundle ──────────────────────────────────────────
  const telegram = {
    async sendMessage(chatId, text, opts = {}) {
      return callMainService("telegram.sendMessage", [chatId, text, opts]);
    },
  };

  const harnessAgent = {
    async launchEphemeralThread(prompt, cwd, timeout, opts) {
      return callMainService("harnessAgent.launchEphemeralThread", [prompt, cwd, timeout, opts]);
    },
    async launchOrResumeThread(prompt, cwd, timeout, opts) {
      return callMainService("harnessAgent.launchOrResumeThread", [prompt, cwd, timeout, opts]);
    },
    async execWithRetry(prompt, opts) {
      return callMainService("harnessAgent.execWithRetry", [prompt, opts]);
    },
    async continueSession(sessionId, prompt, opts) {
      return callMainService("harnessAgent.continueSession", [sessionId, prompt, opts]);
    },
    async killSession(sessionId) {
      return callMainService("harnessAgent.killSession", [sessionId]);
    },
  };

  const kanban = {
    async createTask(projectIdOrData, taskData) {
      return callMainService("kanban.createTask", [projectIdOrData, taskData]);
    },
    async updateTaskStatus(taskId, status, opts) {
      return callMainService("kanban.updateTaskStatus", [taskId, status, opts]);
    },
    async listTasks(projectId, filters) {
      return callMainService("kanban.listTasks", [projectId, filters]);
    },
    async getTask(taskId) {
      return callMainService("kanban.getTask", [taskId]);
    },
  };

  const meeting = {
    async schedule(...args) { return callMainService("meeting.schedule", args); },
    async cancel(...args)   { return callMainService("meeting.cancel",   args); },
    async get(...args)      { return callMainService("meeting.get",      args); },
  };

  const services = {
    telegram,
    harnessAgent,
    agentPool: harnessAgent,
    kanban,
    meeting,
  };

  // ── Create engine ─────────────────────────────────────────────────────────
  const engineOpts = {
    workflowDir: cfg.workflowDir,
    runsDir:     cfg.runsDir,
    services,
  };
  if (cfg.detectInterruptedRuns === false) {
    engineOpts.detectInterruptedRuns = false;
  }
  engine = wfEngineMod.getWorkflowEngine(engineOpts);

  // ── Forward engine events to main thread ──────────────────────────────────
  const FORWARDED_EVENTS = [
    "run:start", "run:end", "run:error", "run:cancel:requested",
    "node:start", "node:complete", "node:error", "node:skip",
    "edge:flow",
  ];
  for (const eventName of FORWARDED_EVENTS) {
    engine.on(eventName, (payload) => {
      try {
        postCloneSafeWorkerMessage(
          { type: "event", eventName, payload },
          `workflow worker event ${eventName}`,
        );
      } catch (error) {
        console.warn(`[wf-worker] failed to forward ${eventName}: ${error?.message || error}`);
      }
    });
  }

  // ── Install recommended templates ─────────────────────────────────────────
  if (typeof wfTemplatesMod?.installRecommendedWorkflowTemplates === "function") {
    try {
      await wfTemplatesMod.installRecommendedWorkflowTemplates(engine);
    } catch { /* non-fatal */ }
  }

  // ── Resume interrupted runs ────────────────────────────────────────────────
  const shouldResumeInterruptedRunsOnStart = cfg.resumeInterruptedRunsOnStart !== false;
  if (shouldResumeInterruptedRunsOnStart && typeof engine.resumeInterruptedRuns === "function") {
    setTimeout(() => engine.resumeInterruptedRuns().catch(() => {}), 0);
  }
}

// ── Serialize engine return values for structured clone ────────────────────────
function sanitise(value, depth = 0, seen = new WeakSet()) {
  if (depth > MAX_CLONE_SANITIZE_DEPTH || value === null || value === undefined) return value;
  if (typeof value === "function") return "[Function]";
  if (typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  if (value instanceof Date) return value;
  if (value instanceof Error) {
    return sanitizeCloneSafeValue(value, { functionValue: describeFunction }, depth, seen);
  }
  if (Array.isArray(value)) {
    seen.add(value);
    const out = value.map((entry) => sanitise(entry, depth + 1, seen));
    seen.delete(value);
    return out;
  }
  seen.add(value);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k.startsWith("_") && depth > 0) continue;
    out[k] = sanitise(v, depth + 1, seen);
  }
  seen.delete(value);
  return out;
}

// ── Engine method dispatcher ──────────────────────────────────────────────────
async function dispatch(method, args) {
  if (!engine) throw new Error("Workflow engine not yet initialised");
  switch (method) {
    case "execute": {
      const [workflowId, input, opts] = args;
      const ctx = await engine.execute(workflowId, input, opts);
      /* Return only the fields the main thread needs to avoid serialisation issues */
      return {
        id:         ctx?.id,
        workflowId: ctx?.workflowId,
        status:     ctx?.status,
        errors:     ctx?.errors || [],
        data:       sanitise(ctx?.data),
      };
    }
    case "evaluateTriggers":
      return engine.evaluateTriggers(...args);
    case "get":
      return sanitise(engine.get(...args));
    case "list":
      return sanitise(engine.list(...args));
    case "getRunHistory":
      return sanitise(await engine.getRunHistory?.(...args));
    case "getRunHistoryPage":
      return sanitise(await engine.getRunHistoryPage?.(...args));
    case "getRunDetail":
      return sanitise(await engine.getRunDetail?.(...args));
    case "getRunForensics":
      return sanitise(await engine.getRunForensics?.(...args));
    case "getNodeForensics":
      return sanitise(await engine.getNodeForensics?.(...args));
    case "getRetryOptions":
      return sanitise(await engine.getRetryOptions?.(...args));
    case "retryRun": {
      const retryResult = await engine.retryRun(...args);
      return sanitise({
        retryRunId: retryResult?.retryRunId || retryResult?.ctx?.id || null,
        originalRunId: retryResult?.originalRunId || null,
        mode: retryResult?.mode || null,
        ctx: retryResult?.ctx
          ? {
              id: retryResult.ctx.id,
              workflowId: retryResult.ctx.workflowId,
              status: retryResult.ctx.status,
              errors: retryResult.ctx.errors || [],
              data: sanitise(retryResult.ctx.data),
            }
          : null,
      });
    }
    case "restoreFromSnapshot": {
      const ctx = await engine.restoreFromSnapshot?.(...args);
      return { id: ctx?.id, workflowId: ctx?.workflowId, status: ctx?.status, errors: ctx?.errors || [] };
    }
    case "cancelRun":
      return engine.cancelRun?.(...args);
    case "createRunSnapshot":
      return engine.createRunSnapshot?.(...args);
    case "listSnapshots":
      return sanitise(engine.listSnapshots?.(...args));
    case "save":
      return engine.save(...args);
    case "import":
      return sanitise(engine.import(...args));
    case "delete":
      return engine.delete?.(...args);
    case "getConcurrencyStats":
      return sanitise(engine.getConcurrencyStats?.());
    case "getTaskTraceEvents":
      return sanitise(await engine.getTaskTraceEvents?.(...args));
    case "load":
      return engine.load?.();
    case "resumeInterruptedRuns":
      return engine.resumeInterruptedRuns?.();
    case "registerTaskTraceHook":
      /* Hooks cannot cross thread boundaries; silently ignore */
      return null;
    default:
      throw new Error(`Unknown engine method: ${method}`);
  }
}

// ── Message handler ────────────────────────────────────────────────────────────
if (parentPort) {
  parentPort.on("message", async (msg) => {
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "init") {
      try {
        await initEngine(msg.workerData || {});
        postCloneSafeWorkerMessage({ type: "ready" }, "workflow worker ready");
      } catch (err) {
        postCloneSafeWorkerMessage(
          { type: "error", callId: null, error: err?.message, stack: err?.stack },
          "workflow worker init error",
        );
      }
      return;
    }

    if (msg.type === "svc-res") {
      const pending = pendingSvcCalls.get(msg.callId);
      if (pending) {
        pendingSvcCalls.delete(msg.callId);
        if (msg.error) pending.reject(Object.assign(new Error(msg.error), { code: msg.code }));
        else pending.resolve(msg.result);
      }
      return;
    }

    if (msg.type === "call") {
      const { callId, method, args } = msg;
      try {
        const result = await dispatch(method, args || []);
        postCloneSafeWorkerMessage(
          { type: "result", callId, result },
          `workflow worker result ${method || "unknown"}`,
        );
      } catch (err) {
        postCloneSafeWorkerMessage(
          { type: "error", callId, error: err?.message, stack: err?.stack },
          `workflow worker error ${method || "unknown"}`,
        );
      }
    }
  });
}

export {
  assertCloneSafeWorkerMessage,
  buildCloneSafeWorkerMessage,
  sanitizeCloneSafeValue,
  sanitizeWorkerMessage,
};
