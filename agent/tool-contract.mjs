import { resolveToolRetryPolicy } from "./tool-retry-policy.mjs";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function cloneJson(value) {
  if (value == null) return value ?? null;
  return JSON.parse(JSON.stringify(value));
}

function uniqueStrings(values, { lowercase = false } = {}) {
  const input = Array.isArray(values) ? values : [values];
  const seen = new Set();
  const result = [];
  for (const value of input) {
    const normalized = normalizeText(value);
    if (!normalized) continue;
    const key = lowercase ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(lowercase ? key : normalized);
  }
  return result;
}

export function normalizeToolSandboxMode(value) {
  const normalized = normalizeText(value).toLowerCase();
  if ([
    "inherit",
    "read-only",
    "workspace-write",
    "restricted",
    "danger-full-access",
    "none",
  ].includes(normalized)) {
    return normalized;
  }
  return "inherit";
}

export function normalizeToolTruncationPolicy(value = {}, defaults = {}) {
  const merged = {
    ...((defaults && typeof defaults === "object") ? defaults : {}),
    ...((value && typeof value === "object") ? value : {}),
  };
  const maxChars = Number(merged.maxChars);
  const tailChars = Number(merged.tailChars);
  return {
    maxChars: Number.isFinite(maxChars) && maxChars > 0 ? Math.trunc(maxChars) : 0,
    tailChars: Number.isFinite(tailChars) && tailChars >= 0 ? Math.trunc(tailChars) : 0,
  };
}

export function buildToolPolicyContract(toolDefinition = {}, envelope = {}, options = {}) {
  const context = envelope?.context && typeof envelope.context === "object"
    ? envelope.context
    : {};
  const retry = resolveToolRetryPolicy(toolDefinition, context, options.retry || options.retryPolicy || {});
  const truncation = normalizeToolTruncationPolicy(
    options.truncation ?? context?.truncation,
    options.truncationDefaults,
  );
  return {
    approval: {
      mode: normalizeText(context?.approval?.mode).toLowerCase() || "inherit",
      state: normalizeText(context?.approval?.state).toLowerCase() || null,
      requestId: normalizeText(context?.approval?.requestId || context?.approvalRequestId) || null,
      requiredHint: toolDefinition?.requiresApproval === true || context?.executionPolicy?.approvalRequired === true,
    },
    network: {
      mode: normalizeText(
        toolDefinition?.networkAccess
        || toolDefinition?.network?.mode
        || context?.network?.mode
        || options.networkMode,
      ).toLowerCase() || "inherit",
      requestedHosts: uniqueStrings(context?.network?.requestedHosts || context?.requestedHosts, { lowercase: true }),
      allowedHosts: uniqueStrings([
        ...(context?.network?.allowedHosts || []),
        ...(toolDefinition?.allowedHosts || []),
      ], { lowercase: true }),
      blockedHosts: uniqueStrings([
        ...(context?.network?.blockedHosts || []),
        ...(toolDefinition?.blockedHosts || []),
      ], { lowercase: true }),
    },
    sandbox: {
      mode: normalizeToolSandboxMode(
        toolDefinition?.sandbox
        ?? context?.sandbox
        ?? options?.sandbox,
      ),
    },
    retry,
    truncation,
    metadata: cloneJson(toolDefinition?.metadata) || {},
  };
}

export default buildToolPolicyContract;
