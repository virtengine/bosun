import { getContextFileInsights } from "./context-indexer.mjs";

const FILE_READ_TOOL_NAMES = new Set([
  "read_file",
  "read_file_content",
]);

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function normalizeToolName(toolName) {
  return toTrimmedString(toolName).toLowerCase();
}

function resolveRootDir(context = {}) {
  return toTrimmedString(context.repoRoot || context.cwd || process.cwd()) || process.cwd();
}

function resolveRequestedFilePath(args = {}) {
  return toTrimmedString(
    args.filePath
    || args.path
    || args?.context?.filePath
    || args?.context?.path
    || "",
  );
}

function formatSymbolLine(symbol = {}) {
  const name = toTrimmedString(symbol.name) || "symbol";
  const kind = toTrimmedString(symbol.kind) || "symbol";
  const line = Number.isFinite(Number(symbol.line)) ? Number(symbol.line) : 1;
  const signature = toTrimmedString(symbol.signature);
  return `- ${name} (${kind}) — line ${line}${signature ? ` — ${signature.replace(/\s+/g, " ")}` : ""}`;
}

function appendPathSection(lines, heading, values = []) {
  const entries = Array.isArray(values)
    ? values.map((value) => toTrimmedString(value)).filter(Boolean)
    : [];
  if (entries.length === 0) return;
  lines.push(heading, "");
  for (const entry of entries) {
    lines.push(`- ${entry}`);
  }
  lines.push("");
}

export function renderInjectedFileContext(insights = {}) {
  const path = toTrimmedString(insights.path);
  if (!path) return "";

  const lines = [
    "## Injected File Context",
    "",
    `- Path: ${path}`,
    `- Language: ${toTrimmedString(insights.language) || "unknown"}`,
  ];
  const summary = toTrimmedString(insights.summary);
  if (summary) {
    lines.push(`- Summary: ${summary}`);
  }
  lines.push("");

  const symbols = Array.isArray(insights.symbols) ? insights.symbols : [];
  if (symbols.length > 0) {
    lines.push("### Key Symbols", "", ...symbols.map((symbol) => formatSymbolLine(symbol)), "");
  }

  appendPathSection(lines, "### Direct Imports", insights.imports);
  appendPathSection(lines, "### Imported By", insights.importedBy);
  appendPathSection(lines, "### Related Tests", insights.relatedTests);

  return lines.join("\n").trim();
}

async function injectReadFileContext(toolName, args, result, context = {}) {
  if (!FILE_READ_TOOL_NAMES.has(normalizeToolName(toolName))) return result;
  const filePath = resolveRequestedFilePath(args);
  if (!filePath) return result;

  if (typeof result === "string") {
    const trimmed = result.trim();
    if (!trimmed || /^could not read\b/i.test(trimmed) || /^filepath is required\b/i.test(trimmed)) {
      return result;
    }
    if (trimmed.includes("## Injected File Context")) {
      return result;
    }
  }

  if (result && typeof result === "object" && result.success === false) {
    return result;
  }

  const insights = await getContextFileInsights(filePath, {
    rootDir: resolveRootDir(context),
  });
  if (!insights) return result;

  const contextBlock = renderInjectedFileContext(insights);
  if (!contextBlock) return result;

  if (typeof result === "string") {
    return `${result.trimEnd()}\n\n${contextBlock}`;
  }

  if (result && typeof result === "object" && !Array.isArray(result)) {
    if (result.injectedContext) return result;
    return {
      ...result,
      injectedContext: {
        kind: "file-read",
        text: contextBlock,
        file: insights,
      },
    };
  }

  return result;
}

export function createContextInjector(options = {}) {
  const handlers = Array.isArray(options.handlers) && options.handlers.length > 0
    ? options.handlers
    : [injectReadFileContext];

  return {
    async injectToolResult(toolName, args = {}, result, context = {}) {
      let nextResult = result;
      for (const handler of handlers) {
        nextResult = await handler(toolName, args, nextResult, context, options);
      }
      return nextResult;
    },
  };
}

export async function injectToolResultContext(toolName, args = {}, result, context = {}, options = {}) {
  return await createContextInjector(options).injectToolResult(toolName, args, result, context);
}

export default createContextInjector;