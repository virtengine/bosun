import {
  spillToolOutputToCache,
  truncateCompactedPreviewText,
  truncateCompactedToolOutput,
} from "../workspace/context-cache.mjs";

export function truncateToolOutput(output, options = {}) {
  return truncateCompactedToolOutput(output, options);
}

export async function materializeTruncatedToolOutput(output, truncatedResult = null, options = {}) {
  const truncated = truncatedResult || truncateCompactedToolOutput(output, options);
  if (!truncated?.truncated || options.spillToDisk === false) {
    return truncated;
  }

  const spillPointer = await spillToolOutputToCache(output, {
    toolName: options.toolName || "tool-output",
    argsPreview: options.argsPreview || "",
    source: "tool-output-truncation",
    stage: "tool_output_truncation",
    tier: "preview",
    compressionKind: "tool_output_preview",
    compactionMode: "bounded-preview",
    family: options.family || "tool-output",
    commandFamily: options.commandFamily || "tool-output",
    budgetPolicy: options.budgetPolicy || "preview-pointer",
    originalChars: truncated.originalChars,
    retainedChars: truncated.retainedChars,
    originalBytes: truncated.originalBytes,
    retainedBytes: truncated.retainedBytes,
  });

  const basePreview = String(
    truncated.preview
    ?? (typeof truncated.data === "string" ? truncated.data : truncated.data?.preview || ""),
  );
  const retrieveLine = spillPointer?.retrieveCommand
    ? `\n\n[Full output spilled to disk: ${spillPointer.retrieveCommand}]`
    : "";
  const preview = `${basePreview}${retrieveLine}`;
  const retainedBytes = Buffer.byteLength(preview, "utf8");
  const retainedChars = preview.length;

  return {
    ...truncated,
    preview,
    data: truncated.format === "text"
      ? preview
      : {
          ...(truncated.data && typeof truncated.data === "object" ? truncated.data : {}),
          preview,
          spillPointer,
        },
    spillPointer: spillPointer
      ? {
          ...spillPointer,
          retainedChars,
          retainedBytes,
        }
      : null,
    retrieveCommand: spillPointer?.retrieveCommand || null,
    retainedChars,
    retainedBytes,
  };
}

export const truncateText = truncateCompactedPreviewText;

export default truncateToolOutput;
