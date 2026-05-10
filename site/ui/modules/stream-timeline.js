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

function toText(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function summarizeLine(text, limit = 180) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > limit ? `${compact.slice(0, Math.max(0, limit - 1))}…` : compact;
}

function normalizeFilePath(raw) {
  let text = String(raw || "").trim();
  while (text.startsWith("`") || text.startsWith("'") || text.startsWith("\"")) {
    text = text.slice(1);
  }
  while (text.endsWith("`") || text.endsWith("'") || text.endsWith("\"")) {
    text = text.slice(0, -1);
  }
  if (!text || text.startsWith("..")) return "";
  return text.split("\\").join("/");
}

function extractFilesFromPatchText(text) {
  const files = [];
  const source = String(text || "");
  for (const line of source.split(/\r?\n/)) {
    const trimmed = String(line || "").trim();
    const prefixes = [
      "*** Update File:",
      "*** Add File:",
      "*** Delete File:",
      "*** Move to:",
    ];
    const prefix = prefixes.find((candidate) => trimmed.startsWith(candidate));
    if (!prefix) continue;
    const file = normalizeFilePath(trimmed.slice(prefix.length).trim());
    if (file) files.push(file);
  }
  return files;
}

function extractFilesFromText(text) {
  const files = [];
  for (const match of String(text || "").matchAll(FILE_PATH_PATTERN)) {
    const file = normalizeFilePath(match[1]);
    if (file) files.push(file);
  }
  return files;
}

function dedupe(items = []) {
  return Array.from(new Set((items || []).filter(Boolean)));
}

function classifyToolCall(toolName, content) {
  const tool = String(toolName || "").trim().toLowerCase();
  const firstLine = String(content || "").split(/\r?\n/, 1)[0].trim().toLowerCase();

  if (EDIT_TOOL_HINTS.some((hint) => tool.includes(hint))) {
    return "patch_result";
  }
  if (OPEN_TOOL_HINTS.some((hint) => tool.includes(hint))) {
    return "file_exploration";
  }

  if (tool === "command_execution") {
    if (/\b(apply_patch|sed\s+-i|perl\s+-i|tee\s+|cat\s+>)/.test(firstLine)) {
      return "patch_result";
    }
    if (/\b(rg|grep|cat|sed|head|tail|ls|find|stat|git show|git diff)\b/.test(firstLine)) {
      return "file_exploration";
    }
  }

  return "tool_call";
}

function parseCommandStatus(content) {
  const firstLine = String(content || "").split(/\r?\n/, 1)[0] || "";
  const statusMatch = firstLine.match(/\[([^\]]+)\]\s*$/);
  if (!statusMatch) return [];
  return statusMatch[1]
    .split(",")
    .map((part) => summarizeLine(part, 24))
    .filter(Boolean);
}

function collectCompressionChips(msg) {
  const compression = msg?.meta?.compression || msg?.meta?.contextCompression || msg?.meta?.contextShredding;
  if (!compression || typeof compression !== "object") return [];
  const chips = [];
  if (compression.kind) chips.push(String(compression.kind));
  if (compression.cachedLogId) chips.push(`log ${compression.cachedLogId}`);
  if (Number.isFinite(Number(compression.originalLength))) {
    chips.push(`${Number(compression.originalLength)} chars`);
  }
  return chips;
}

function buildTimelineEntry(msg, overridePhase = "") {
  const type = String(msg?.type || "").toLowerCase();
  const text = toText(msg?.content);
  const firstLine = summarizeLine(text.split(/\r?\n/, 1)[0], 180);
  const toolName = String(msg?.meta?.toolName || "").trim();
  const lifecycle = String(msg?.meta?.lifecycle || "").trim();
  const itemType = String(msg?.meta?.itemType || "").trim();
  const files = dedupe([
    ...extractFilesFromPatchText(text),
    ...extractFilesFromText(text),
  ]);

  let phase = overridePhase || "thinking";
  if (!overridePhase) {
    if (type === "tool_call") phase = "tool_call";
    else if (type === "tool_result" || type === "tool_output") phase = "output";
    else if (type === "error" || type === "stream_error") phase = "error";
    else if (itemType === "file_change") phase = "patch_result";
  }

  const title =
    phase === "tool_call"
      ? firstLine || (toolName ? `${toolName}(…)` : "Tool call")
      : phase === "output"
        ? firstLine || "Tool output"
        : phase === "patch_result"
          ? files.length
            ? `Patched ${files.slice(0, 2).join(", ")}`
            : firstLine || "Patch result"
          : phase === "error"
            ? firstLine || "Stream error"
            : firstLine || "Thinking step";

  const chips = [];
  if (toolName) chips.push(toolName);
  if (lifecycle) chips.push(lifecycle.replace(/_/g, " "));
  for (const statusChip of parseCommandStatus(text)) chips.push(statusChip);
  for (const file of files.slice(0, 2)) chips.push(file);
  for (const compressionChip of collectCompressionChips(msg)) chips.push(compressionChip);

  return {
    id: String(msg?.id || msg?.messageId || msg?.timestamp || `${type}:${title}`),
    phase,
    title,
    text,
    preview: summarizeLine(text, 220),
    timestamp: msg?.timestamp || "",
    tone: phase === "error" ? "error" : phase === "patch_result" ? "success" : phase === "file_exploration" ? "info" : phase === "tool_call" ? "info" : "default",
    chips: dedupe(chips),
    files,
    raw: msg,
  };
}

function createThinkingBlock(entries) {
  const title = entries[0]?.title || "Thinking";
  return {
    key: `thinking:${entries[0]?.id || title}`,
    phase: "thinking",
    tone: "default",
    title,
    summary:
      entries.length === 1
        ? title
        : `${entries.length} thinking steps`,
    chips: entries.length > 1 ? [`${entries.length} steps`] : [],
    entries,
    hasError: false,
  };
}

function createToolBlock(messages, startIndex) {
  const call = messages[startIndex];
  const callText = toText(call?.content);
  const toolName = String(call?.meta?.toolName || "").trim() || "tool";
  const phase = classifyToolCall(toolName, callText);
  const entries = [buildTimelineEntry(call, "tool_call")];
  let index = startIndex + 1;
  let resultCount = 0;
  let hasError = false;

  while (index < messages.length) {
    const next = messages[index];
    const nextType = String(next?.type || "").toLowerCase();
    if (nextType === "tool_result" || nextType === "tool_output") {
      entries.push(buildTimelineEntry(next, "output"));
      resultCount += 1;
      index += 1;
      continue;
    }
    if (nextType === "error" || nextType === "stream_error") {
      entries.push(buildTimelineEntry(next, "error"));
      hasError = true;
      index += 1;
    }
    break;
  }

  const files = dedupe(entries.flatMap((entry) => entry.files || []));
  const title =
    phase === "file_exploration"
      ? files[0]
        ? `Explored ${files[0]}`
        : `Explored with ${toolName}`
      : phase === "patch_result"
        ? files.length
          ? `Patched ${files.slice(0, 2).join(", ")}`
          : `Patched with ${toolName}`
        : summarizeLine(callText.split(/\r?\n/, 1)[0], 180) || `Ran ${toolName}`;

  const chips = dedupe([
    toolName,
    resultCount > 0 ? `${resultCount} output${resultCount === 1 ? "" : "s"}` : "",
    ...files.slice(0, 2),
    ...entries.flatMap((entry) => entry.chips || []).filter((chip) => chip !== toolName),
  ]);

  return {
    block: {
      key: `${phase}:${entries[0]?.id || toolName}`,
      phase,
      tone: hasError ? "error" : phase === "patch_result" ? "success" : "info",
      title,
      summary: resultCount > 0 ? `${title} (${resultCount} output${resultCount === 1 ? "" : "s"})` : title,
      chips,
      entries,
      hasError,
    },
    nextIndex: index,
  };
}

export function buildTraceTimelineBlocks(messages = []) {
  const blocks = [];
  const list = Array.isArray(messages) ? messages.filter(Boolean) : [];
  let index = 0;

  while (index < list.length) {
    const msg = list[index];
    const type = String(msg?.type || "").toLowerCase();

    if (type === "tool_call") {
      const { block, nextIndex } = createToolBlock(list, index);
      blocks.push(block);
      index = nextIndex;
      continue;
    }

    if (type === "tool_result" || type === "tool_output") {
      const entry = buildTimelineEntry(msg, "output");
      blocks.push({
        key: `output:${entry.id}`,
        phase: "output",
        tone: entry.tone,
        title: entry.title,
        summary: entry.title,
        chips: entry.chips,
        entries: [entry],
        hasError: false,
      });
      index += 1;
      continue;
    }

    if (type === "error" || type === "stream_error") {
      const entry = buildTimelineEntry(msg, "error");
      blocks.push({
        key: `error:${entry.id}`,
        phase: "error",
        tone: "error",
        title: entry.title,
        summary: entry.title,
        chips: entry.chips,
        entries: [entry],
        hasError: true,
      });
      index += 1;
      continue;
    }

    const itemType = String(msg?.meta?.itemType || "").toLowerCase();
    if (itemType === "file_change") {
      const entry = buildTimelineEntry(msg);
      blocks.push({
        key: `patch_result:${entry.id}`,
        phase: entry.phase || "patch_result",
        tone: entry.tone,
        title: entry.title,
        summary: entry.title,
        chips: entry.chips,
        entries: [entry],
        hasError: false,
      });
      index += 1;
      continue;
    }

    const thinkingEntries = [];
    while (index < list.length) {
      const next = list[index];
      const nextType = String(next?.type || "").toLowerCase();
      const nextItemType = String(next?.meta?.itemType || "").toLowerCase();
      if (
        nextType === "tool_call" ||
        nextType === "tool_result" ||
        nextType === "tool_output" ||
        nextType === "error" ||
        nextType === "stream_error" ||
        nextItemType === "file_change"
      ) {
        break;
      }
      thinkingEntries.push(buildTimelineEntry(next, "thinking"));
      index += 1;
    }

    if (thinkingEntries.length) {
      blocks.push(createThinkingBlock(thinkingEntries));
    }
  }

  return blocks;
}
