function normalizeText(value) {
  return String(value ?? "").trim();
}

function cloneJson(value) {
  if (value == null) return value ?? null;
  return JSON.parse(JSON.stringify(value));
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function uniqueStrings(values, { lowercase = false } = {}) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized) continue;
    const key = lowercase ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(lowercase ? key : normalized);
  }
  return result;
}

function normalizeApprovalHint(value) {
  if (value === true) return true;
  const normalized = normalizeText(value).toLowerCase();
  if (["manual", "always", "required", "true", "yes"].includes(normalized)) return true;
  return false;
}

function normalizeNetworkHint(value) {
  if (value === false) return "deny";
  const normalized = normalizeText(value).toLowerCase();
  if (["deny", "offline", "none"].includes(normalized)) return "deny";
  if (["restricted", "allowlist"].includes(normalized)) return "restricted";
  if (["allow", "enabled", "true"].includes(normalized)) return "allow";
  return "inherit";
}

function normalizeToolSchema(definition = {}) {
  const metadata = definition.metadata && typeof definition.metadata === "object"
    ? definition.metadata
    : {};
  const parameters = definition.parameters && typeof definition.parameters === "object"
    ? definition.parameters
    : (metadata.parameters && typeof metadata.parameters === "object"
        ? metadata.parameters
        : null);
  const inputSchema = definition.inputSchema && typeof definition.inputSchema === "object"
    ? definition.inputSchema
    : (metadata.inputSchema && typeof metadata.inputSchema === "object"
        ? metadata.inputSchema
        : null);
  return {
    parameters: parameters ? cloneJson(parameters) : null,
    inputSchema: inputSchema ? cloneJson(inputSchema) : null,
  };
}

export function mergeToolDefinitions(base = {}, overlay = {}) {
  const mergedAliases = uniqueStrings([
    ...asArray(base.aliases),
    ...asArray(overlay.aliases),
  ]);
  const mergedTags = uniqueStrings([
    ...asArray(base.tags),
    ...asArray(overlay.tags),
  ]);
  const baseAllowedHosts = asArray(base.allowedHosts);
  const overlayAllowedHosts = asArray(overlay.allowedHosts);
  const baseBlockedHosts = asArray(base.blockedHosts);
  const overlayBlockedHosts = asArray(overlay.blockedHosts);
  return {
    ...cloneJson(base),
    ...cloneJson(overlay),
    handler: typeof overlay.handler === "function"
      ? overlay.handler
      : (typeof base.handler === "function" ? base.handler : null),
    aliases: mergedAliases,
    tags: mergedTags,
    allowedHosts: uniqueStrings([...baseAllowedHosts, ...overlayAllowedHosts], { lowercase: true }),
    blockedHosts: uniqueStrings([...baseBlockedHosts, ...overlayBlockedHosts], { lowercase: true }),
  };
}

export function normalizeToolDefinition(definition = {}, options = {}) {
  const fallbackId = normalizeText(options.fallbackId);
  const id = normalizeText(
    definition.id || definition.name || definition.toolName || fallbackId,
  );
  if (!id) return null;
  const aliases = uniqueStrings(
    asArray(definition.aliases)
      .concat(definition.name && definition.name !== id ? [definition.name] : []),
  ).filter((entry) => entry !== id);
  const description = normalizeText(definition.description || definition.summary);
  const source = normalizeText(definition.source || options.source) || "runtime";
  const { parameters, inputSchema } = normalizeToolSchema(definition);
  return {
    id,
    name: normalizeText(definition.name || id) || id,
    description: description || null,
    source,
    aliases,
    tags: uniqueStrings(asArray(definition.tags)),
    requiresApproval: normalizeApprovalHint(
      definition.requiresApproval ?? definition.approvalRequired ?? definition.approval,
    ),
    networkAccess: normalizeNetworkHint(
      definition.networkAccess ?? definition.network?.mode ?? definition.internetAccess,
    ),
    sandbox: normalizeText(definition.sandbox ?? definition.sandboxMode) || "inherit",
    allowedHosts: uniqueStrings(asArray(definition.allowedHosts), { lowercase: true }),
    blockedHosts: uniqueStrings(asArray(definition.blockedHosts), { lowercase: true }),
    approvalReason: normalizeText(definition.approvalReason) || null,
    retry: definition.retry && typeof definition.retry === "object"
      ? cloneJson(definition.retry)
      : null,
    parameters,
    inputSchema,
    metadata: definition.metadata && typeof definition.metadata === "object"
      ? cloneJson(definition.metadata)
      : {},
    handler: typeof definition.handler === "function" ? definition.handler : null,
  };
}

export function composeToolRegistryEntries(sources = [], options = {}) {
  const inputSources = Array.isArray(sources) ? sources : [sources];
  const entries = new Map();
  for (const sourceEntry of inputSources) {
    const sourceName = normalizeText(sourceEntry?.source || sourceEntry?.name || options.source) || "runtime";
    const rawDefinitions = Array.isArray(sourceEntry)
      ? sourceEntry
      : (Array.isArray(sourceEntry?.definitions)
          ? sourceEntry.definitions
          : (sourceEntry && typeof sourceEntry === "object"
              ? Object.entries(sourceEntry)
                  .filter(([key]) => key !== "source" && key !== "name" && key !== "definitions")
                  .map(([key, value]) => ({ id: key, ...(value && typeof value === "object" ? value : {}) }))
              : []));
    for (let index = 0; index < rawDefinitions.length; index += 1) {
      const normalized = normalizeToolDefinition(rawDefinitions[index], {
        source: sourceName,
        fallbackId: `${sourceName}-${index + 1}`,
      });
      if (!normalized) continue;
      const existing = entries.get(normalized.id);
      entries.set(normalized.id, existing ? mergeToolDefinitions(existing, normalized) : normalized);
    }
  }
  return Array.from(entries.values()).sort((left, right) => left.id.localeCompare(right.id));
}

export function resolveToolDefinition(toolName, registryEntries = []) {
  const requested = normalizeText(toolName);
  if (!requested) return null;
  const lowered = requested.toLowerCase();
  const entries = Array.isArray(registryEntries) ? registryEntries : [];
  const exactMatch = entries.find((entry) => (
    entry.id === requested || entry.id.toLowerCase() === lowered
  ));
  if (exactMatch) return exactMatch;
  return entries.find((entry) => (
    Array.isArray(entry.aliases) && entry.aliases.some((alias) => alias.toLowerCase() === lowered)
  )) || null;
}

export function createToolRegistry(sources = [], options = {}) {
  const entries = composeToolRegistryEntries(sources, options);
  return {
    listTools() {
      return entries.slice();
    },
    getTool(toolName) {
      return resolveToolDefinition(toolName, entries);
    },
    hasTool(toolName) {
      return Boolean(resolveToolDefinition(toolName, entries));
    },
    execute(toolName, args = {}, context = {}) {
      const tool = resolveToolDefinition(toolName, entries);
      if (!tool) {
        throw new Error(`Unknown tool: ${toolName}`);
      }
      if (typeof tool.handler !== "function") {
        throw new Error(`Tool does not provide a handler: ${tool.id}`);
      }
      return tool.handler(args, context, tool);
    },
  };
}

export default createToolRegistry;
