function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function normalizeToolNameSet(values) {
  return new Set(
    (Array.isArray(values) ? values : [values])
      .map((entry) => toTrimmedString(entry).toLowerCase())
      .filter(Boolean),
  );
}

function resolveToolPolicy(context = {}, options = {}) {
  const contract = context.subagentContract && typeof context.subagentContract === "object"
    ? context.subagentContract
    : {};
  const contractToolPolicy = contract.toolPolicy && typeof contract.toolPolicy === "object"
    ? contract.toolPolicy
    : {};
  const contextToolPolicy = context.toolPolicy && typeof context.toolPolicy === "object"
    ? context.toolPolicy
    : {};
  const optionToolPolicy = options.toolPolicy && typeof options.toolPolicy === "object"
    ? options.toolPolicy
    : {};
  return {
    allowedTools: [
      ...(Array.isArray(optionToolPolicy.allowedTools) ? optionToolPolicy.allowedTools : []),
      ...(Array.isArray(context.allowedTools) ? context.allowedTools : []),
      ...(Array.isArray(contextToolPolicy.allowedTools) ? contextToolPolicy.allowedTools : []),
      ...(Array.isArray(contractToolPolicy.allowedTools) ? contractToolPolicy.allowedTools : []),
    ],
    deniedTools: [
      ...(Array.isArray(optionToolPolicy.deniedTools) ? optionToolPolicy.deniedTools : []),
      ...(Array.isArray(context.deniedTools) ? context.deniedTools : []),
      ...(Array.isArray(contextToolPolicy.deniedTools) ? contextToolPolicy.deniedTools : []),
      ...(Array.isArray(contractToolPolicy.deniedTools) ? contractToolPolicy.deniedTools : []),
    ],
  };
}

function isToolAllowed(toolName, policy = {}) {
  const normalized = toTrimmedString(toolName).toLowerCase();
  if (!normalized) return false;
  const allowedTools = normalizeToolNameSet(policy.allowedTools);
  const deniedTools = normalizeToolNameSet(policy.deniedTools);
  if (deniedTools.has(normalized)) return false;
  if (allowedTools.size > 0) return allowedTools.has(normalized);
  return true;
}

export async function createToolRunner(options = {}) {
  const orchestrator = options.toolOrchestrator;
  return {
    listTools(context = {}) {
      const tools = typeof orchestrator?.listTools === "function" ? orchestrator.listTools(context) : [];
      const policy = resolveToolPolicy(context, options);
      return (Array.isArray(tools) ? tools : []).filter((tool) => {
        const name = toTrimmedString(tool?.id || tool?.name || tool);
        return isToolAllowed(name, policy);
      });
    },
    async runTool(toolName, args = {}, context = {}) {
      const execute = typeof orchestrator?.executeTool === "function"
        ? orchestrator.executeTool.bind(orchestrator)
        : (typeof orchestrator?.execute === "function" ? orchestrator.execute.bind(orchestrator) : null);
      if (typeof execute !== "function") {
        throw new Error("Tool orchestrator is not configured");
      }
      const policy = resolveToolPolicy(context, options);
      if (!isToolAllowed(toolName, policy)) {
        throw new Error(`Tool "${toTrimmedString(toolName) || "unknown"}" is not allowed in this subagent contract`);
      }
      const normalizedAllowedTools = [...normalizeToolNameSet(policy.allowedTools)];
      const normalizedDeniedTools = [...normalizeToolNameSet(policy.deniedTools)];
      const nextToolPolicy =
        normalizedAllowedTools.length > 0
        || normalizedDeniedTools.length > 0
        || (context.toolPolicy && typeof context.toolPolicy === "object")
          ? {
              ...(context.toolPolicy && typeof context.toolPolicy === "object" ? context.toolPolicy : {}),
              ...(normalizedAllowedTools.length > 0 ? { allowedTools: normalizedAllowedTools } : {}),
              ...(normalizedDeniedTools.length > 0 ? { deniedTools: normalizedDeniedTools } : {}),
            }
          : undefined;
      return await execute(toolName, args, {
        ...context,
        ...(nextToolPolicy ? { toolPolicy: nextToolPolicy } : {}),
        onEvent: context.onEvent || options.onEvent,
      });
    },
  };
}

export default createToolRunner;
