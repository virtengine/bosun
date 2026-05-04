function normalizeText(value) {
  return String(value ?? "").trim();
}

function uniqueLowercase(values) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [values])
      .map((value) => normalizeText(value).toLowerCase())
      .filter(Boolean),
  ));
}

function normalizeMode(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (["inherit", "deny", "allow", "restricted", "offline"].includes(normalized)) return normalized;
  return "inherit";
}

function resolveMode(tool = {}, context = {}, options = {}) {
  return normalizeMode(
    tool.networkAccess
    ?? tool.network?.mode
    ?? context?.network?.mode
    ?? context.networkMode
    ?? options.defaultMode,
  );
}

export function evaluateToolNetworkPolicy(tool = {}, context = {}, options = {}) {
  const mode = resolveMode(tool, context, options);
  const requestedHosts = uniqueLowercase(
    context?.network?.requestedHosts ?? context.requestedHosts ?? tool.requestedHosts,
  );
  const allowedHosts = uniqueLowercase([
    ...(context?.network?.allowedHosts || context.allowedHosts || options.allowedHosts || []),
    ...(tool.allowedHosts || []),
  ]);
  const blockedHosts = uniqueLowercase([
    ...(context?.network?.blockedHosts || context.blockedHosts || options.blockedHosts || []),
    ...(tool.blockedHosts || []),
  ]);
  const blockedHost = requestedHosts.find((host) => blockedHosts.includes(host)) || null;
  const unauthorizedHost = (
    mode === "restricted" && requestedHosts.find((host) => !allowedHosts.includes(host))
  ) || null;
  const allowed = (
    mode !== "deny"
    && mode !== "offline"
    && !blockedHost
    && !unauthorizedHost
  );
  const reason = blockedHost
    ? `Host ${blockedHost} is blocked by policy.`
    : (unauthorizedHost
        ? `Host ${unauthorizedHost} is not allowlisted for restricted network access.`
        : ((mode === "deny" || mode === "offline")
            ? "Network access is disabled for this tool execution."
            : null));
  return {
    toolId: normalizeText(tool.id || tool.name) || null,
    mode,
    requestedHosts,
    allowedHosts,
    blockedHosts,
    allowed,
    blocked: !allowed,
    reason,
  };
}

export function createToolNetworkPolicy(defaultOptions = {}) {
  return {
    evaluate(tool, context = {}, options = {}) {
      return evaluateToolNetworkPolicy(tool, context, { ...defaultOptions, ...options });
    },
    assertAllowed(tool, context = {}, options = {}) {
      const result = evaluateToolNetworkPolicy(tool, context, { ...defaultOptions, ...options });
      if (!result.allowed) {
        throw new Error(result.reason || "Network access is blocked for this tool execution.");
      }
      return result;
    },
  };
}

export default createToolNetworkPolicy;
