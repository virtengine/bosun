/*
 * Session insights helpers.
 * Builds high-signal activity metrics from full session message history.
 */

const FILE_PATH_PATTERN =
  /([A-Za-z0-9_./-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|mdx|css|scss|less|html|yml|yaml|toml|env|lock|go|rs|py|sh|ps1|psm1|txt|sql|xml|csv))/g;

const EDIT_TOOL_HINTS = [
  "apply_patch",
  "write",
  "edit",
  "replace",
  "append",
  "create_file",
  "createfile",
  "update_file",
  "move_file",
  "delete_file",
];

const OPEN_TOOL_HINTS = [
  "read",
  "open",
  "view",
  "search",
  "grep",
  "rg",
  "glob",
  "list",
  "cat",
];

const CONTEXT_BREAKDOWN_LABELS = new Set([
  "system instructions",
  "tool definitions",
  "messages",
  "files",
  "tool results",
  "user context",
  "system",
]);

function toText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseCompactNumber(raw) {
  const text = String(raw || "").trim().toLowerCase();
  if (!text) return null;
  const match = text.match(/^(-?\d+(?:\.\d+)?)([km])?$/i);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  const suffix = String(match[2] || "").toLowerCase();
  if (suffix === "k") return Math.round(n * 1_000);
  if (suffix === "m") return Math.round(n * 1_000_000);
  return Math.round(n);
}

function normalizeFilePath(raw) {
  let text = String(raw || "").trim();
  while (text.startsWith("`") || text.startsWith("'") || text.startsWith('"')) {
    text = text.slice(1);
  }
  while (text.endsWith("`") || text.endsWith("'") || text.endsWith('"')) {
    text = text.slice(0, -1);
  }
  if (!text) return "";
  if (text.startsWith("..")) return "";
  return text.split("\\").join("/");
}

function addFile(map, path, count = 1, ts = "") {
  const safe = normalizeFilePath(path);
  if (!safe) return;
  const entry = map.get(safe) || { path: safe, count: 0, lastTs: "" };
  entry.count += Number.isFinite(count) ? count : 1;
  if (ts && (!entry.lastTs || String(ts) > String(entry.lastTs))) {
    entry.lastTs = ts;
  }
  map.set(safe, entry);
}

function extractFilesFromPatchText(text) {
  const files = [];
  const source = String(text || "");
  for (const line of source.split(/\r?\n/)) {
    const trimmed = String(line || "").trim();
    const updatePrefix = "*** Update File:";
    const addPrefix = "*** Add File:";
    const deletePrefix = "*** Delete File:";
    const movePrefix = "*** Move to:";
    let rawPath = "";
    if (trimmed.startsWith(updatePrefix)) rawPath = trimmed.slice(updatePrefix.length).trim();
    else if (trimmed.startsWith(addPrefix)) rawPath = trimmed.slice(addPrefix.length).trim();
    else if (trimmed.startsWith(deletePrefix)) rawPath = trimmed.slice(deletePrefix.length).trim();
    else if (trimmed.startsWith(movePrefix)) rawPath = trimmed.slice(movePrefix.length).trim();
    if (!rawPath) continue;
    const file = normalizeFilePath(rawPath);
    if (file) files.push(file);
  }
  return files;
}

function extractFilesFromText(text) {
  const files = [];
  const source = String(text || "");
  const allowedExt = new Set([
    "js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "md", "mdx", "css", "scss", "less",
    "html", "yml", "yaml", "toml", "env", "lock", "go", "rs", "py", "sh", "ps1", "psm1",
    "txt", "sql", "xml", "csv",
  ]);
  const tokens = source.split(/[^A-Za-z0-9_./-]+/);
  for (const token of tokens) {
    if (!token || token.length < 3) continue;
    const dotIdx = token.lastIndexOf(".");
    if (dotIdx <= 0 || dotIdx >= token.length - 1) continue;
    const ext = token.slice(dotIdx + 1).toLowerCase();
    if (!allowedExt.has(ext)) continue;
    const file = normalizeFilePath(token);
    if (file) files.push(file);
  }
  return files;
}

function classifyToolCall(toolName, content) {
  const tool = String(toolName || "").trim().toLowerCase();
  const cmd = String(content || "").trim().toLowerCase();

  if (EDIT_TOOL_HINTS.some((hint) => tool.includes(hint))) {
    return { kind: "edit", commandLike: tool === "command_execution" };
  }
  if (OPEN_TOOL_HINTS.some((hint) => tool.includes(hint))) {
    return { kind: "open", commandLike: tool === "command_execution" };
  }

  if (tool === "command_execution") {
    const firstLine = cmd.split("\n")[0] || "";
    if (/\b(apply_patch|sed\s+-i|perl\s+-i|tee\s+|cat\s+>)/.test(firstLine)) {
      return { kind: "edit", commandLike: true };
    }
    if (/\b(rg|grep|cat|sed|head|tail|ls|find|stat|git show)\b/.test(firstLine)) {
      return { kind: "open", commandLike: true };
    }
    return { kind: "other", commandLike: true };
  }

  return { kind: "other", commandLike: false };
}

function parseContextWindowSnapshot(text) {
  const source = String(text || "");
  const lower = source.toLowerCase();
  const tokenIdx = lower.indexOf("tokens");
  const slashIdx = source.indexOf("/");

  if (slashIdx > 0 && tokenIdx > slashIdx) {
    const left = source.slice(0, slashIdx).trim().split(/\s+/).pop() || "";
    const rightPart = source.slice(slashIdx + 1, tokenIdx).trim();
    const right = rightPart.split(/\s+/)[0] || "";
    const usedTokens = parseCompactNumber(left);
    const totalTokens = parseCompactNumber(right);

    let explicitPercent = null;
    const percentIdx = source.indexOf("%", tokenIdx);
    if (percentIdx > tokenIdx) {
      const leftSide = source.slice(0, percentIdx);
      const candidate = leftSide.split(/[^0-9.]+/).filter(Boolean).pop();
      if (candidate) {
        const n = Number(candidate);
        if (Number.isFinite(n)) explicitPercent = n;
      }
    }

    const percent =
      explicitPercent != null
        ? explicitPercent
        : usedTokens != null && totalTokens
          ? Math.round((usedTokens / totalTokens) * 1000) / 10
          : null;
    return { usedTokens, totalTokens, percent };
  }

  const marker = "context window:";
  const markerIdx = lower.indexOf(marker);
  if (markerIdx >= 0) {
    const pctIdx = source.indexOf("%", markerIdx);
    if (pctIdx > markerIdx) {
      const raw = source.slice(markerIdx + marker.length, pctIdx).trim();
      const numberText = raw.split(/\s+/)[0];
      const percent = Number(numberText);
      if (Number.isFinite(percent)) {
        return { usedTokens: null, totalTokens: null, percent };
      }
    }
  }

  return null;
}

function parseContextBreakdown(text) {
  const rows = [];
  const source = String(text || "");
  const lines = source.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z ]{1,40})\s+(\d+(?:\.\d+)?)%\s*$/);
    if (!match) continue;
    const label = String(match[1] || "").trim();
    const key = label.toLowerCase();
    if (!CONTEXT_BREAKDOWN_LABELS.has(key)) continue;
    const percent = Number(match[2]);
    if (!Number.isFinite(percent)) continue;
    rows.push({ label, percent });
  }
  return rows;
}

function normalizeUsage(value) {
  if (!value || typeof value !== "object") return null;
  const input =
    Number(value.input_tokens ?? value.prompt_tokens ?? value.input ?? value.prompt ?? 0) || 0;
  const output =
    Number(value.output_tokens ?? value.completion_tokens ?? value.output ?? value.completion ?? 0) || 0;
  const total = Number(value.total_tokens ?? value.total ?? input + output) || 0;
  if (input <= 0 && output <= 0 && total <= 0) return null;
  return { input, output, total };
}

export function formatCompactCount(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return "0";
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
    Math.max(0, n),
  );
}

export function buildSessionInsights(fullSession = null) {
  const persisted =
    fullSession?.insights && typeof fullSession.insights === "object"
      ? fullSession.insights
      : null;
  const messages = Array.isArray(fullSession?.messages) ? fullSession.messages : [];
  const tools = new Map();
  const openedFiles = new Map();
  const editedFiles = new Map();
  const referencedFiles = new Map();
  const recentActions = [];

  let toolCalls = 0;
  let toolResults = 0;
  let errors = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let systemMessages = 0;
  let commandExecutions = 0;
  let openOps = 0;
  let editOps = 0;
  let contextWindow = null;
  let contextBreakdown = [];
  let tokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  for (const msg of messages) {
    if (!msg) continue;
    const type = String(msg.type || "").toLowerCase();
    const role = String(msg.role || "").toLowerCase();
    const content = toText(msg.content);
    const ts = String(msg.timestamp || "");

    if (role === "user") userMessages += 1;
    if (role === "assistant" || type === "agent_message" || type === "assistant_message") {
      assistantMessages += 1;
    }
    if (type === "system" || role === "system") systemMessages += 1;
    if (type === "error" || type === "stream_error") {
      errors += 1;
      recentActions.push({
        type: "error",
        label: content.slice(0, 180),
        level: "error",
        timestamp: ts,
      });
    }

    const usage = normalizeUsage(msg?.meta?.usage) || normalizeUsage(msg?.usage) || null;
    if (usage) {
      tokenUsage.inputTokens += usage.input;
      tokenUsage.outputTokens += usage.output;
      tokenUsage.totalTokens += usage.total;
    }

    const snapshot = parseContextWindowSnapshot(content);
    if (snapshot) contextWindow = snapshot;
    const breakdown = parseContextBreakdown(content);
    if (breakdown.length) contextBreakdown = breakdown;

    if (type === "tool_result" || type === "tool_output") {
      toolResults += 1;
      continue;
    }
    if (type !== "tool_call") continue;
    if (String(msg?.meta?.lifecycle || "").toLowerCase() === "started") continue;

    toolCalls += 1;
    const toolName = String(msg?.meta?.toolName || "tool").trim() || "tool";
    tools.set(toolName, (tools.get(toolName) || 0) + 1);
    if (toolName.toLowerCase() === "command_execution") commandExecutions += 1;

    const classification = classifyToolCall(toolName, content);
    const patchFiles =
      toolName.toLowerCase().includes("apply_patch") || /[*]{3}\s+(?:Update|Add|Delete)\s+File:/.test(content)
        ? extractFilesFromPatchText(content)
        : [];
    const genericFiles = extractFilesFromText(content);
    const combinedFiles = patchFiles.length ? patchFiles : genericFiles;

    for (const file of genericFiles) addFile(referencedFiles, file, 1, ts);
    if (classification.kind === "open") {
      openOps += 1;
      for (const file of combinedFiles) addFile(openedFiles, file, 1, ts);
    } else if (classification.kind === "edit") {
      editOps += 1;
      for (const file of combinedFiles) addFile(editedFiles, file, 1, ts);
    }

    const shortDetail = content.split("\n")[0]?.slice(0, 180) || "";
    recentActions.push({
      type: "tool_call",
      label: `${toolName}${shortDetail ? `: ${shortDetail}` : ""}`,
      level: "info",
      timestamp: ts,
    });
  }

  const edited = Array.from(editedFiles.values()).sort((a, b) => b.count - a.count);
  const opened = Array.from(openedFiles.values()).sort((a, b) => b.count - a.count);
  const referenced = Array.from(referencedFiles.values()).sort((a, b) => b.count - a.count);
  const topTools = Array.from(tools.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  if (tokenUsage.inputTokens <= 0 && tokenUsage.outputTokens <= 0 && tokenUsage.totalTokens <= 0) {
    tokenUsage = null;
  }

  if (!contextWindow && tokenUsage?.totalTokens > 0) {
    contextWindow = {
      usedTokens: tokenUsage.totalTokens,
      totalTokens: null,
      percent: null,
    };
  }

  const derived = {
    totals: {
      messages: messages.length,
      toolCalls,
      toolResults,
      errors,
      userMessages,
      assistantMessages,
      systemMessages,
      commandExecutions,
      uniqueTools: tools.size,
    },
    fileCounts: {
      openedFiles: opened.length,
      editedFiles: edited.length,
      referencedFiles: referenced.length,
      openOps,
      editOps,
    },
    files: {
      opened,
      edited,
      referenced,
    },
    topTools,
    // Cap to 6 — the InspectorPanel only renders the first 6, so transferring
    // more across the worker boundary is wasted serialization cost.
    recentActions: recentActions
      .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")))
      .slice(0, 6),
    contextWindow,
    contextBreakdown,
    tokenUsage,
    activityDiff: {
      files: edited.map((entry) => ({
        path: entry.path,
        edits: entry.count,
        lastTs: entry.lastTs,
      })),
      totalFiles: edited.length,
    },
    generatedAt: new Date().toISOString(),
  };

  if (!persisted) return derived;

  return {
    ...derived,
    ...persisted,
    totals: persisted.totals || derived.totals,
    fileCounts: persisted.fileCounts || derived.fileCounts,
    files: persisted.files || derived.files,
    topTools: Array.isArray(persisted.topTools) ? persisted.topTools : derived.topTools,
    recentActions: Array.isArray(persisted.recentActions)
      ? persisted.recentActions
      : derived.recentActions,
    contextWindow: persisted.contextWindow || derived.contextWindow,
    contextBreakdown: Array.isArray(persisted.contextBreakdown)
      ? persisted.contextBreakdown
      : derived.contextBreakdown,
    tokenUsage: persisted.tokenUsage || derived.tokenUsage,
    activityDiff: persisted.activityDiff || derived.activityDiff,
    generatedAt: persisted.generatedAt || derived.generatedAt,
  };
}
