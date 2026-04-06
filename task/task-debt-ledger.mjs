import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_LEDGER_RELATIVE_PATH = ".bosun/workflow-runs/task-debt-ledger.jsonl";

function normalizeSeverity(value) {
  const severity = String(value || "")
    .trim()
    .toLowerCase();
  if (["critical", "high", "medium", "low"].includes(severity)) return severity;
  return "medium";
}

function normalizeDebtType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized || "unspecified";
}

function trimText(value, maxLength = 2000) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!Number.isFinite(maxLength) || maxLength <= 0) return text;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

export function normalizeDebtItems(rawDebtItems, fallbackReason = "") {
  const items = Array.isArray(rawDebtItems) ? rawDebtItems : [];
  const normalized = items
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const type = normalizeDebtType(item.type);
      const severity = normalizeSeverity(item.severity);
      const description = trimText(
        item.description || item.detail || item.message || "",
      );
      const criterion = trimText(item.criterion || "");
      if (!description && !criterion && type === "unspecified") return null;
      return {
        type,
        severity,
        description,
        criterion,
      };
    })
    .filter(Boolean);

  if (normalized.length > 0) return normalized;

  const fallback = trimText(fallbackReason);
  if (!fallback) return [];
  return [
    {
      type: "assessment_reason",
      severity: "medium",
      description: fallback,
      criterion: "",
    },
  ];
}

export function recordTaskDebt(entry, options = {}) {
  const ledgerPath = resolve(
    options.baseDir || process.cwd(),
    options.ledgerPath || DEFAULT_LEDGER_RELATIVE_PATH,
  );
  mkdirSync(dirname(ledgerPath), { recursive: true });

  const nowIso = new Date().toISOString();
  const payload = {
    recordedAt: nowIso,
    taskId: String(entry?.taskId || "").trim(),
    taskTitle: trimText(entry?.taskTitle || "", 500),
    attemptId: String(entry?.attemptId || "").trim(),
    trigger: String(entry?.trigger || "").trim(),
    action: String(entry?.action || "").trim(),
    reason: trimText(entry?.reason || ""),
    debtItems: normalizeDebtItems(entry?.debtItems, entry?.reason),
    metadata:
      entry?.metadata && typeof entry.metadata === "object" ? entry.metadata : {},
  };

  appendFileSync(ledgerPath, `${JSON.stringify(payload)}\n`, "utf8");
  return { ledgerPath, entry: payload };
}

export function readTaskDebtEntries(options = {}) {
  const ledgerPath = resolve(
    options.baseDir || process.cwd(),
    options.ledgerPath || DEFAULT_LEDGER_RELATIVE_PATH,
  );
  if (!existsSync(ledgerPath)) return [];
  const raw = readFileSync(ledgerPath, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const entries = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        entries.push(parsed);
      }
    } catch {
      // Skip malformed ledger lines.
    }
  }

  const limit = Number(options.limit);
  if (Number.isFinite(limit) && limit > 0 && entries.length > limit) {
    return entries.slice(entries.length - limit);
  }
  return entries;
}

export function summarizeTaskDebtLedger(entries = [], options = {}) {
  const allEntries = Array.isArray(entries) ? entries.filter((entry) => entry && typeof entry === "object") : [];
  const taskId = String(options.taskId || "").trim();
  const filtered = taskId
    ? allEntries.filter((entry) => String(entry.taskId || "").trim() === taskId)
    : allEntries;
  const severityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  const typeCounts = {};
  const taskIds = new Set();
  const recentReasons = [];

  for (const entry of filtered) {
    const currentTaskId = String(entry.taskId || "").trim();
    if (currentTaskId) taskIds.add(currentTaskId);
    const reason = trimText(entry.reason || "", 280);
    if (reason) recentReasons.push(reason);
    for (const item of normalizeDebtItems(entry.debtItems, entry.reason)) {
      severityCounts[item.severity] = Number(severityCounts[item.severity] || 0) + 1;
      typeCounts[item.type] = Number(typeCounts[item.type] || 0) + 1;
    }
  }

  const highestSeverity = ["critical", "high", "medium", "low"].find((severity) => severityCounts[severity] > 0) || "low";
  return {
    taskId: taskId || null,
    entryCount: filtered.length,
    taskCount: taskIds.size,
    severityCounts,
    typeCounts,
    highestSeverity,
    recentReasons: recentReasons.slice(-5),
  };
}

function buildProtocolEntry(entry = {}) {
  return {
    id: String(entry.id || "").trim(),
    title: trimText(entry.title || "Operational Protocol", 160),
    description: trimText(entry.description || "", 320),
    tags: Array.isArray(entry.tags) ? entry.tags.map((value) => String(value || "").trim()).filter(Boolean) : [],
    important: entry.important === true,
    content: trimText(entry.content || "", 2400),
    sourceKind: "runtime-protocol",
    sourcePath: `runtime://${String(entry.id || "protocol").trim() || "protocol"}`,
    trusted: true,
    trustState: "trusted",
    trustReason: "runtime-protocol",
    catalogOnly: false,
  };
}

export function buildTaskDebtOperationalProtocols(entries = [], options = {}) {
  const summary = summarizeTaskDebtLedger(entries, options);
  if (summary.entryCount === 0) return [];

  const protocols = [];
  protocols.push(buildProtocolEntry({
    id: "runtime-quality-monitoring",
    title: "Quality Monitoring Protocol",
    description: "Turn deferred work into an explicit quality signal instead of letting it disappear into summaries.",
    tags: ["quality", "debt", "verification", "monitoring"],
    important: summary.highestSeverity === "critical" || summary.highestSeverity === "high",
    content: [
      "# Skill: Quality Monitoring Protocol",
      "",
      `- Debt Entries Seen: ${summary.entryCount}`,
      `- Highest Severity: ${summary.highestSeverity}`,
      `- Severity Counts: critical=${summary.severityCounts.critical}, high=${summary.severityCounts.high}, medium=${summary.severityCounts.medium}, low=${summary.severityCounts.low}`,
      "- Runtime Primitive: whenever work completes with debt, record the missing verification or acceptance gap as a first-class follow-up signal.",
      "- Release Rule: do not collapse high-severity debt into a generic success summary.",
    ].join("\n"),
  }));

  protocols.push(buildProtocolEntry({
    id: "runtime-error-recovery",
    title: "Error Recovery Protocol",
    description: "Use actual deferred-failure evidence to choose the next recovery step.",
    tags: ["recovery", "retry", "debt", "failure"],
    important: true,
    content: [
      "# Skill: Error Recovery Protocol",
      "",
      `- Debt Types Observed: ${Object.keys(summary.typeCounts).slice(0, 6).join(", ") || "unspecified"}`,
      `- Recent Reasons: ${summary.recentReasons.slice(-3).join(" | ") || "none recorded"}`,
      "- Runtime Primitive: promote repeated or high-severity debt into a recovery plan instead of retrying blindly.",
      "- Escalation Rule: when the same debt reason repeats, switch to replan, decompose, or operator escalation rather than another identical attempt.",
    ].join("\n"),
  }));

  if (summary.entryCount >= 2 || summary.taskCount >= 2) {
    protocols.push(buildProtocolEntry({
      id: "runtime-note-taking",
      title: "Operational Note-Taking Protocol",
      description: "Capture deferred work as a concise ledger the next agent can act on immediately.",
      tags: ["notes", "handoff", "debt", "ledger"],
      important: true,
      content: [
        "# Skill: Operational Note-Taking Protocol",
        "",
        `- Distinct Tasks With Debt: ${summary.taskCount}`,
        `- Recent Deferred Reasons: ${summary.recentReasons.slice(-4).join(" | ") || "none recorded"}`,
        "- Runtime Primitive: keep a terse ledger of deferred work, blocker reason, and next action instead of writing long prose handoffs.",
        "- Handoff Rule: one line per deferred item, with severity and the smallest next validation step.",
      ].join("\n"),
    }));
  }

  return protocols;
}

