import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { registerNodeType } from "./workflow-engine.mjs";

export const WORKFLOW_CONTRACT_FILENAME = "WORKFLOW.md";
export const REQUIRED_WORKFLOW_CONTRACT_FIELDS = Object.freeze([
  "terminalStates",
  "forbiddenPatterns",
]);

const DEFAULT_WORKFLOW_CONTRACT = Object.freeze({
  exists: false,
  found: false,
  enabled: false,
  path: "",
  projectRoot: "",
  content: "",
  raw: "",
  projectDescription: "",
  terminalStates: Object.freeze([]),
  forbiddenPatterns: Object.freeze([]),
  preferredTools: Object.freeze([]),
  preferredModel: "",
  escalationContact: "",
  escalationPaths: Object.freeze([]),
  rules: Object.freeze([]),
  sections: Object.freeze({}),
});

const KEY_ALIASES = Object.freeze({
  projectdescription: "projectDescription",
  project_description: "projectDescription",
  description: "projectDescription",
  terminalstates: "terminalStates",
  terminal_states: "terminalStates",
  forbiddenpatterns: "forbiddenPatterns",
  forbidden_patterns: "forbiddenPatterns",
  preferredtools: "preferredTools",
  preferred_tools: "preferredTools",
  preferredmodel: "preferredModel",
  preferred_model: "preferredModel",
  escalationcontact: "escalationContact",
  escalation_contact: "escalationContact",
  escalationpaths: "escalationPaths",
  escalation_paths: "escalationPaths",
  rules: "rules",
});

const LIST_FIELDS = new Set(["terminalStates", "forbiddenPatterns", "preferredTools", "escalationPaths", "rules"]);
const TEXT_FIELDS = new Set([
  "projectDescription",
  "preferredModel",
  "escalationContact",
]);

let contractCache = new Map();

function createEmptyContract(projectRoot = "") {
  return {
    ...DEFAULT_WORKFLOW_CONTRACT,
    projectRoot,
    terminalStates: [],
    forbiddenPatterns: [],
    preferredTools: [],
    escalationPaths: [],
    rules: [],
    sections: {},
  };
}

function hydrateCompatShape(contract) {
  const normalized = contract || createEmptyContract();
  normalized.found = normalized.exists === true;
  normalized.raw = normalized.content || "";
  normalized.parsed = {
    projectDescription: normalized.projectDescription || "",
    terminalStates: [...(normalized.terminalStates || [])],
    forbiddenPatterns: [...(normalized.forbiddenPatterns || [])],
    preferredTools: [...(normalized.preferredTools || [])],
    preferredModel: normalized.preferredModel || "",
    escalationContact: normalized.escalationContact || "",
    escalationPaths: [...(normalized.escalationPaths || [])],
    rules: [...(normalized.rules || [])],
  };
  return normalized;
}

function normalizeContractKey(rawKey = "") {
  const trimmed = String(rawKey || "").trim();
  if (!trimmed) return "";
  const compact = trimmed.replace(/[\s-]+/g, "_").replace(/[^A-Za-z0-9_]/g, "").toLowerCase();
  return KEY_ALIASES[compact] || "";
}

function normalizeHeadingKey(rawHeading = "") {
  return normalizeContractKey(String(rawHeading || "").replace(/^#+\s*/, ""));
}

function stripWrappingQuotes(value = "") {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseInlineList(rawValue = "") {
  const trimmed = String(rawValue || "").trim();
  if (!trimmed) return [];

  const normalized = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;

  return normalized
    .split(",")
    .map((entry) => stripWrappingQuotes(entry))
    .filter(Boolean);
}

function dedupeStrings(values = []) {
  const out = [];
  const seen = new Set();
  for (const rawValue of values) {
    const value = stripWrappingQuotes(rawValue);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function appendListValues(contract, key, values = []) {
  if (!LIST_FIELDS.has(key)) return;
  contract[key] = dedupeStrings([...(contract[key] || []), ...values]);
}

function appendTextValue(contract, key, value = "") {
  if (!TEXT_FIELDS.has(key)) return;
  const trimmed = String(value || "").trim();
  if (!trimmed) return;
  contract[key] = contract[key]
    ? `${contract[key]}\n${trimmed}`
    : trimmed;
}

function storeSectionValue(contract, key) {
  if (!key) return;
  if (LIST_FIELDS.has(key)) {
    contract.sections[key] = [...(contract[key] || [])];
    return;
  }
  if (TEXT_FIELDS.has(key)) {
    contract.sections[key] = contract[key] || "";
  }
}

function finalizeCollector(contract, collector) {
  if (!collector?.key) return;
  const key = collector.key;
  if (LIST_FIELDS.has(key)) {
    appendListValues(contract, key, collector.items || []);
  } else if (TEXT_FIELDS.has(key)) {
    const text = (collector.lines || [])
      .map((line) => String(line || "").trim())
      .filter(Boolean)
      .join("\n")
      .trim();
    appendTextValue(contract, key, text);
  }
  storeSectionValue(contract, key);
}

function parseMarkdownHeadingLine(trimmedLine = "") {
  const line = String(trimmedLine || "");
  if (!line || line[0] !== "#") return null;
  let depth = 0;
  while (depth < line.length && depth < 6 && line[depth] === "#") depth += 1;
  if (depth < 1 || depth > 6) return null;
  if (line[depth] !== " ") return null;
  return line.slice(depth + 1);
}

function isAsciiLetter(char) {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isContractFieldKeyChar(char) {
  if (!char) return false;
  if (char === " " || char === "_" || char === "-") return true;
  const code = char.charCodeAt(0);
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57)
  );
}

function parseContractFieldLine(rawLine = "") {
  const line = String(rawLine || "");
  const trimmedStart = line.trimStart();
  if (!trimmedStart || !isAsciiLetter(trimmedStart[0])) return null;
  let idx = 1;
  while (idx < trimmedStart.length) {
    const ch = trimmedStart[idx];
    if (ch === ":") break;
    if (!isContractFieldKeyChar(ch)) return null;
    idx += 1;
  }
  if (trimmedStart[idx] !== ":") return null;
  const key = trimmedStart.slice(0, idx).trimEnd();
  if (!key) return null;
  return {
    key,
    value: trimmedStart.slice(idx + 1).trimStart(),
  };
}

function parseMarkdownBulletLine(rawLine = "") {
  const line = String(rawLine || "");
  const trimmedStart = line.trimStart();
  if (!trimmedStart) return null;
  const marker = trimmedStart[0];
  if (marker !== "-" && marker !== "*") return null;
  const separator = trimmedStart[1];
  if (separator !== " " && separator !== "\t") return null;
  return trimmedStart.slice(2).trimStart();
}

export function parseWorkflowContractMarkdown(content = "", projectRoot = "") {
  const contract = createEmptyContract(projectRoot);
  const source = String(content || "");
  contract.content = source.trim();
  contract.enabled = contract.content.length > 0;
  if (!contract.enabled) return contract;

  const lines = source.split(/\r?\n/);
  let inFence = false;
  let collector = null;

  for (const rawLine of lines) {
    const line = String(rawLine || "");
    const trimmed = line.trim();

    if (/^```/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const headingText = parseMarkdownHeadingLine(trimmed);
    if (headingText !== null) {
      finalizeCollector(contract, collector);
      collector = null;
      const headingKey = normalizeHeadingKey(headingText);
      if (headingKey) {
        collector = LIST_FIELDS.has(headingKey)
          ? { key: headingKey, items: [] }
          : { key: headingKey, lines: [] };
      }
      continue;
    }

    const fieldMatch = parseContractFieldLine(line);
    if (fieldMatch) {
      finalizeCollector(contract, collector);
      collector = null;

      const key = normalizeContractKey(fieldMatch.key);
      if (!key) continue;

      const rawValue = String(fieldMatch.value || "").trim();
      if (LIST_FIELDS.has(key)) {
        if (rawValue) {
          appendListValues(contract, key, parseInlineList(rawValue));
          storeSectionValue(contract, key);
        } else {
          collector = { key, items: [] };
        }
        continue;
      }

      if (TEXT_FIELDS.has(key)) {
        if (rawValue) {
          appendTextValue(contract, key, stripWrappingQuotes(rawValue));
          storeSectionValue(contract, key);
        } else {
          collector = { key, lines: [] };
        }
      }
      continue;
    }

    if (!collector) continue;

    if (LIST_FIELDS.has(collector.key)) {
      const bulletText = parseMarkdownBulletLine(line);
      if (bulletText !== null) {
        collector.items.push(stripWrappingQuotes(bulletText));
        continue;
      }
      if (!trimmed) continue;
      finalizeCollector(contract, collector);
      collector = null;
      continue;
    }

    if (TEXT_FIELDS.has(collector.key)) {
      if (!trimmed) {
        if ((collector.lines || []).length > 0) collector.lines.push("");
        continue;
      }
      collector.lines.push(trimmed);
    }
  }

  finalizeCollector(contract, collector);
  contract.projectDescription = String(contract.projectDescription || "").trim();
  contract.preferredModel = String(contract.preferredModel || "").trim();
  contract.escalationContact = String(contract.escalationContact || "").trim();
  contract.terminalStates = dedupeStrings(contract.terminalStates);
  contract.forbiddenPatterns = dedupeStrings(contract.forbiddenPatterns);
  contract.preferredTools = dedupeStrings(contract.preferredTools);
  contract.escalationPaths = dedupeStrings(contract.escalationPaths);
  contract.rules = dedupeStrings(contract.rules);
  storeSectionValue(contract, "projectDescription");
  storeSectionValue(contract, "preferredTools");
  storeSectionValue(contract, "preferredModel");
  storeSectionValue(contract, "escalationContact");
  storeSectionValue(contract, "escalationPaths");
  storeSectionValue(contract, "rules");
  return hydrateCompatShape(contract);
}

export function loadWorkflowContract(projectRoot = process.cwd(), options = {}) {
  const normalizedRoot = resolve(projectRoot || process.cwd());
  const workflowMdPath = resolve(normalizedRoot, WORKFLOW_CONTRACT_FILENAME);
  const useCache = options.useCache !== false;

  if (useCache && contractCache.has(normalizedRoot)) {
    return contractCache.get(normalizedRoot);
  }

  if (!existsSync(workflowMdPath)) {
    const empty = {
      ...createEmptyContract(normalizedRoot),
      path: workflowMdPath,
    };
    hydrateCompatShape(empty);
    if (useCache) contractCache.set(normalizedRoot, empty);
    return empty;
  }

  const content = readFileSync(workflowMdPath, "utf8");
  const contract = parseWorkflowContractMarkdown(content, normalizedRoot);
  contract.exists = true;
  contract.found = true;
  contract.enabled = true;
  contract.path = workflowMdPath;
  contract.raw = contract.content;
  hydrateCompatShape(contract);
  if (useCache) contractCache.set(normalizedRoot, contract);
  return contract;
}

export function validateWorkflowContract(input) {
  const contract = typeof input === "string"
    ? loadWorkflowContract(input, { useCache: false })
    : { ...createEmptyContract(input?.projectRoot || ""), ...(input || {}) };

  const errors = [];
  if (!contract.exists && !contract.enabled) {
    return { valid: true, errors, contract };
  }

  for (const field of REQUIRED_WORKFLOW_CONTRACT_FIELDS) {
    const values = Array.isArray(contract[field]) ? contract[field] : [];
    if (values.length === 0) {
      const hint = field === "terminalStates"
        ? "Add `terminalStates: [done]` or a `## Terminal States` section."
        : "Add `forbiddenPatterns:` with at least one disallowed shell pattern.";
      errors.push({
        field,
        message: `WORKFLOW.md is missing required field \`${field}\`. ${hint}`,
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    contract,
  };
}

export function buildWorkflowContractPromptBlock(input) {
  const contract = typeof input === "string"
    ? loadWorkflowContract(input)
    : input;

  const rawContent = String(contract?.content || contract?.raw || "").trim();
  const exists = contract?.exists === true || contract?.found === true || Boolean(rawContent);
  if (!exists || !rawContent) return "";

  const lines = [
    "## WORKFLOW.md Contract",
    `- **Source:** ${contract.path}`,
    "- **Behavior:** Treat this file as a project-specific runtime contract.",
    "",
    rawContent,
  ];

  return lines.join("\n").trim();
}

export function clearWorkflowContractCache(projectRoot) {
  if (!projectRoot) {
    contractCache.clear();
    return;
  }
  contractCache.delete(resolve(projectRoot));
}

export function getWorkflowContract(projectRoot) {
  return loadWorkflowContract(projectRoot);
}

export function clearContractCache(projectRoot) {
  clearWorkflowContractCache(projectRoot);
}

export function hasWorkflowContract(projectRoot) {
  return loadWorkflowContract(projectRoot).exists;
}

export function validateContract(projectRoot) {
  return validateWorkflowContract(projectRoot);
}

function resolveContractRepoRoot(node, ctx) {
  return resolve(
    String(
      node?.config?.repoRoot
      || ctx?.data?.repoRoot
      || ctx?.repoRoot
      || process.cwd(),
    ).trim() || process.cwd(),
  );
}

registerNodeType("read-workflow-contract", {
  describe: () => "Load WORKFLOW.md from the current repository root into workflow context.",
  schema: {
    type: "object",
    properties: {
      repoRoot: { type: "string", description: "Repository root to inspect for WORKFLOW.md" },
      useCache: { type: "boolean", description: "Reuse cached WORKFLOW.md parse results" },
    },
  },
  async execute(node, ctx) {
    const repoRoot = resolveContractRepoRoot(node, ctx);
    const useCache = node?.config?.useCache !== false;
    const contract = loadWorkflowContract(repoRoot, { useCache });
    if (ctx?.data && typeof ctx.data === "object") {
      ctx.data._workflowContract = contract;
    }
    ctx?.log?.(
      node?.id || "read-workflow-contract",
      contract.exists
        ? `Loaded WORKFLOW.md contract from ${contract.path}`
        : `No WORKFLOW.md contract found at ${contract.path}`,
    );
    return {
      success: true,
      found: contract.exists === true,
      contract,
      path: contract.path,
    };
  },
});

registerNodeType("workflow-contract-validation", {
  describe: () => "Validate a loaded WORKFLOW.md contract before agent execution begins.",
  schema: {
    type: "object",
    properties: {
      repoRoot: { type: "string", description: "Repository root to inspect for WORKFLOW.md" },
    },
  },
  async execute(node, ctx) {
    const repoRoot = resolveContractRepoRoot(node, ctx);
    const contract =
      ctx?.data?._workflowContract && typeof ctx.data._workflowContract === "object"
        ? ctx.data._workflowContract
        : loadWorkflowContract(repoRoot);
    const validation = validateWorkflowContract(contract);
    if (ctx?.data && typeof ctx.data === "object") {
      ctx.data._workflowContract = validation.contract;
    }
    if (!validation.valid) {
      const message = validation.errors.map((entry) => entry?.message || String(entry || "")).filter(Boolean).join(" ");
      ctx?.log?.(node?.id || "workflow-contract-validation", message, "warn");
      throw new Error(message || "WORKFLOW.md validation failed");
    }
    ctx?.log?.(
      node?.id || "workflow-contract-validation",
      validation.contract?.exists
        ? `Validated WORKFLOW.md contract at ${validation.contract.path}`
        : "No WORKFLOW.md contract present; continuing without project contract.",
    );
    return {
      success: true,
      valid: true,
      contract: validation.contract,
      found: validation.contract?.exists === true,
    };
  },
});

function normalizeLineageText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function normalizeLineageInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.trunc(parsed));
}

export function buildWorkflowLineageContract(input = {}) {
  const runId = normalizeLineageText(input.runId);
  const rootRunId = normalizeLineageText(input.rootRunId) || runId;
  const sessionId = normalizeLineageText(input.sessionId);
  const childSessionId = normalizeLineageText(input.childSessionId);
  const resolvedSessionId = childSessionId || sessionId;
  const rootSessionId = normalizeLineageText(input.rootSessionId) || resolvedSessionId;
  const parentSessionId = normalizeLineageText(input.parentSessionId);
  const taskId = normalizeLineageText(input.taskId);
  const taskTitle = normalizeLineageText(input.taskTitle);
  const nodeId = normalizeLineageText(input.nodeId);
  const nodeLabel = normalizeLineageText(input.nodeLabel) || nodeId;
  return {
    runId,
    workflowId: normalizeLineageText(input.workflowId),
    workflowName: normalizeLineageText(input.workflowName),
    rootRunId,
    parentRunId: normalizeLineageText(input.parentRunId),
    sessionId: resolvedSessionId,
    rootSessionId,
    parentSessionId,
    childSessionId,
    threadId: normalizeLineageText(input.threadId) || resolvedSessionId,
    taskId,
    taskTitle,
    nodeId,
    nodeLabel,
    childRunId: normalizeLineageText(input.childRunId),
    approvalRequestId: normalizeLineageText(input.approvalRequestId),
    spawnId: normalizeLineageText(input.spawnId),
    delegationDepth: normalizeLineageInteger(input.delegationDepth, 0),
  };
}
