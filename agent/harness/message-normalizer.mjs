import { normalizeHarnessEvent } from "./event-contract.mjs";

export { normalizeHarnessEvent };

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

export function normalizeHarnessMessage(input, defaults = {}) {
  if (input && typeof input === "object") {
    return {
      role: toTrimmedString(input.role || defaults.role || "assistant") || "assistant",
      content: toTrimmedString(input.content || input.text || defaults.content || ""),
      timestamp: toTrimmedString(input.timestamp || defaults.timestamp || new Date().toISOString()) || new Date().toISOString(),
      meta: input.meta && typeof input.meta === "object" ? { ...input.meta } : {},
    };
  }
  return {
    role: toTrimmedString(defaults.role || "assistant") || "assistant",
    content: toTrimmedString(input || defaults.content || ""),
    timestamp: toTrimmedString(defaults.timestamp || new Date().toISOString()) || new Date().toISOString(),
    meta: {},
  };
}

export function normalizeTurnResult(result = {}, defaults = {}) {
  return {
    success: result?.success !== false,
    output: toTrimmedString(result?.output || result?.finalResponse || defaults.output || ""),
    finalResponse: toTrimmedString(result?.finalResponse || result?.output || defaults.output || ""),
    status: toTrimmedString(result?.status || defaults.status || (result?.success === false ? "failed" : "completed")) || "completed",
    outcome: toTrimmedString(result?.outcome || defaults.outcome || (result?.success === false ? "failure" : "success")) || "success",
    sessionId: toTrimmedString(result?.sessionId || defaults.sessionId || "") || null,
    threadId: toTrimmedString(result?.threadId || defaults.threadId || "") || null,
    providerId: toTrimmedString(result?.providerId || defaults.providerId || "") || null,
    model: toTrimmedString(result?.model || defaults.model || "") || null,
    items: Array.isArray(result?.items) ? result.items : [],
    usage: result?.usage && typeof result.usage === "object" ? { ...result.usage } : null,
    raw: result,
  };
}

export default normalizeHarnessEvent;
