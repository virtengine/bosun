function truncate(value, max) {
  const text = String(value || "");
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function buildSubagentSummaryLines(snapshot = {}) {
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
  if (!items.length) {
    return ["No subagent lineage recorded."];
  }
  return items.slice(0, 8).map((entry) => {
    const spawnId = truncate(entry?.spawnId || entry?.childSessionId || "subagent", 18);
    const status = truncate(entry?.status || "unknown", 10);
    const child = truncate(entry?.childSessionId || entry?.childThreadId || "-", 20);
    return `${spawnId.padEnd(19, " ")} ${status.padEnd(10, " ")} ${child}`;
  });
}
