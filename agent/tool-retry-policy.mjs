function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizePositiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : fallback;
}

function normalizeStrategy(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (["fixed", "linear", "exponential"].includes(normalized)) return normalized;
  return "fixed";
}

function compactPolicy(policy = {}) {
  const entries = Object.entries((policy && typeof policy === "object") ? policy : {});
  return Object.fromEntries(entries.filter(([, value]) => value != null && value !== ""));
}

export function resolveToolRetryPolicy(toolDefinition = {}, context = {}, options = {}) {
  const merged = {
    ...compactPolicy(options),
    ...compactPolicy(toolDefinition?.retry),
    ...compactPolicy(context?.retry),
  };
  return {
    maxAttempts: normalizePositiveInteger(
      merged.maxAttempts ?? merged.attempts,
      1,
    ),
    backoffMs: Math.max(0, normalizePositiveInteger(merged.backoffMs, 0)),
    strategy: normalizeStrategy(merged.strategy),
  };
}

export function getToolRetryDelayMs(policy = {}, attempt = 1) {
  const backoffMs = Math.max(0, normalizePositiveInteger(policy?.backoffMs, 0));
  if (backoffMs <= 0) return 0;
  const strategy = normalizeStrategy(policy?.strategy);
  if (strategy === "linear") {
    return backoffMs * Math.max(1, normalizePositiveInteger(attempt, 1));
  }
  if (strategy === "exponential") {
    return backoffMs * (2 ** Math.max(0, normalizePositiveInteger(attempt, 1) - 1));
  }
  return backoffMs;
}

export function shouldRetryToolExecution(error, attempt = 1, policy = {}) {
  const maxAttempts = normalizePositiveInteger(policy?.maxAttempts, 1);
  if (normalizePositiveInteger(attempt, 1) >= maxAttempts) return false;
  if (error?.retryable === false) return false;
  return true;
}

export default resolveToolRetryPolicy;
