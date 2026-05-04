function toText(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function summarizeText(text, limit = 140) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

export function isTraceTurnMessage(msg) {
  if (!msg) return false;
  const type = String(msg.type || "").trim().toLowerCase();
  if (
    type === "tool_call"
    || type === "tool_result"
    || type === "tool_output"
    || type === "error"
    || type === "stream_error"
    || type === "system"
  ) {
    return true;
  }
  return String(msg.role || "").trim().toLowerCase() === "system";
}

function resolveTurnIndex(msg, fallbackTurnIndex = 0) {
  const explicit = Number(msg?.turnIndex);
  if (Number.isFinite(explicit)) return explicit;
  const role = String(msg?.role || "").trim().toLowerCase();
  if (role === "user") {
    return Math.max(0, fallbackTurnIndex + 1);
  }
  return Math.max(0, fallbackTurnIndex);
}

export function buildChatTurnGroups(messages = []) {
  const source = Array.isArray(messages) ? messages : [];
  if (!source.length) return [];
  const groups = [];
  let lastResolvedTurnIndex = -1;
  for (const msg of source) {
    const turnIndex = resolveTurnIndex(msg, lastResolvedTurnIndex);
    lastResolvedTurnIndex = Math.max(lastResolvedTurnIndex, turnIndex);
    const previous = groups[groups.length - 1] || null;
    const group = previous?.turnIndex === turnIndex
      ? previous
      : (() => {
          const next = {
            key: `turn-${turnIndex}-${groups.length}`,
            turnIndex,
            messages: [],
          };
          groups.push(next);
          return next;
        })();
    group.messages.push(msg);
  }

  const latestTurnIndex = groups.reduce(
    (maxValue, group) => Math.max(maxValue, Number(group?.turnIndex || 0)),
    0,
  );

  return groups.map((group, index) => {
    const nonTraceMessages = group.messages.filter((msg) => !isTraceTurnMessage(msg));
    const preview = nonTraceMessages
      .slice(0, 2)
      .map((msg, previewIndex) => ({
        id: msg?.id || msg?.messageId || `${group.key}-preview-${previewIndex}`,
        role: String(msg?.role || msg?.type || "message").trim().toLowerCase() || "message",
        text: summarizeText(toText(msg?.content ?? msg?.text ?? ""), 160),
      }))
      .filter((entry) => entry.text);
    const hiddenToolCount = group.messages.filter((msg) => {
      const type = String(msg?.type || "").trim().toLowerCase();
      return type === "tool_call" || type === "tool_result" || type === "tool_output";
    }).length;
    const hiddenTraceCount = group.messages.filter((msg) => isTraceTurnMessage(msg)).length;
    const hasAssistantMessage = group.messages.some((msg) => String(msg?.role || "").trim().toLowerCase() === "assistant");
    const isLatest = index === groups.length - 1 || group.turnIndex === latestTurnIndex;
    return {
      ...group,
      preview,
      isLatest,
      hasAssistantMessage,
      hiddenToolCount,
      hiddenTraceCount,
      messageCount: group.messages.length,
      collapsedByDefault: !isLatest,
      collapsedLabel: `${group.messages.length} previous message${group.messages.length === 1 ? "" : "s"}`,
      contextShredded: hiddenTraceCount > 0,
    };
  });
}
