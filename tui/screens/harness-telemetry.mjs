function pad(text, width) {
  const value = String(text || "");
  if (width <= 0) return "";
  if (value.length >= width) return value.slice(0, width);
  return `${value}${" ".repeat(width - value.length)}`;
}

function truncate(value, max) {
  const text = String(value || "");
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function normalizeHarnessLiveness(payload) {
  if (Array.isArray(payload?.agents)) return payload.agents;
  if (Array.isArray(payload)) return payload;
  return [];
}

export function normalizeHarnessErrorPatterns(payload) {
  if (
    payload
    && typeof payload === "object"
    && !Array.isArray(payload?.patterns)
    && !Array.isArray(payload?.errors)
  ) {
    return Object.entries(payload).map(([pattern, detail]) => ({
      pattern,
      ...(detail && typeof detail === "object" ? detail : {}),
    }));
  }
  if (Array.isArray(payload?.patterns)) return payload.patterns;
  if (Array.isArray(payload?.errors)) return payload.errors;
  return [];
}

export function describeHarnessLivenessRow(entry, width = 72) {
  const id = String(entry?.agentId || entry?.sessionId || entry?.taskId || "agent").trim();
  const state = String(entry?.status || entry?.state || entry?.health || "unknown").trim();
  const heartbeat = String(entry?.lastHeartbeatAt || entry?.updatedAt || entry?.lastSeenAt || "").trim();
  const detail = String(entry?.summary || entry?.reason || entry?.taskTitle || "").replace(/\s+/g, " ").trim();
  return pad(`${truncate(id, 16).padEnd(17, " ")} ${truncate(state, 12).padEnd(12, " ")} ${truncate(heartbeat || "n/a", 24).padEnd(24, " ")} ${truncate(detail || "-", width - 55)}`, width);
}

export function describeHarnessErrorPatternRow(entry, width = 72) {
  const label = String(entry?.pattern || entry?.error || entry?.message || entry?.reason || "error").replace(/\s+/g, " ").trim();
  const count = Number(entry?.count || entry?.hits || entry?.occurrences || 0);
  const scope = String(entry?.taskId || entry?.sessionId || entry?.agentId || entry?.source || "").trim();
  return pad(`${truncate(label, 44).padEnd(45, " ")} ${String(count).padStart(4, " ")} ${truncate(scope || "-", width - 51)}`, width);
}

export function buildHarnessMonitorDetailLines(statusPayload, livenessItems, errorItems) {
  const status = statusPayload && typeof statusPayload === "object" ? statusPayload : {};
  const listenerCount = Number(status?.listenerCount || 0);
  const eventLogSize = Number(status?.eventLogSize || 0);
  const trackedAgents = Number(status?.trackedAgents || livenessItems.length || 0);
  const started = status?.started === true ? "yes" : "no";
  return [
    `Started       ${started}`,
    `Tracked agents ${trackedAgents}`,
    `Event log size ${eventLogSize}`,
    `Listeners     ${listenerCount}`,
    `Alive agents  ${livenessItems.filter((entry) => entry?.alive !== false).length}`,
    `Stale agents  ${livenessItems.filter((entry) => entry?.alive === false).length}`,
    `Error patterns ${errorItems.length}`,
  ];
}
