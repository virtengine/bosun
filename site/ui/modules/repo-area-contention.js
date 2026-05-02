function safeIsoString(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const ts = Date.parse(text);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

function formatRelative(isoStr) {
  if (!isoStr) return "never";
  const diff = Date.now() - Date.parse(isoStr);
  if (!Number.isFinite(diff) || diff < 0) return "just now";
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return mins + " minutes ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return "about " + hrs + " hour" + (hrs > 1 ? "s" : "") + " ago";
  const days = Math.floor(hrs / 24);
  return days + " day" + (days > 1 ? "s" : "") + " ago";
}

export function normalizeRepoAreaContentionSummary(summary = null) {
  const hotAreas = Array.isArray(summary?.hotAreas)
    ? summary.hotAreas.map((area) => ({
      area: String(area?.area || "").trim(),
      events: Math.max(0, Math.trunc(Number(area?.events || 0))),
      waitingTasks: Math.max(0, Math.trunc(Number(area?.waitingTasks || 0))),
      activeSlots: Math.max(0, Math.trunc(Number(area?.activeSlots || 0))),
      avgWaitMs: Math.max(0, Math.trunc(Number(area?.avgWaitMs || 0))),
      lastContentionAt: safeIsoString(area?.lastContentionAt),
      detailHref: String(area?.detailHref || "").trim() || null,
    })).filter((area) => area.area)
    : [];
  const recent = Array.isArray(summary?.recent)
    ? summary.recent.map((event) => ({
      area: String(event?.area || "").trim(),
      taskId: String(event?.taskId || "").trim(),
      waitMs: Math.max(0, Math.trunc(Number(event?.waitMs || 0))),
      at: safeIsoString(event?.at),
      resolutionReason: String(event?.resolutionReason || "unknown").trim() || "unknown",
      detailHref: String(event?.detailHref || "").trim() || null,
    })).filter((event) => event.area && event.taskId)
    : [];

  return {
    generatedAt: safeIsoString(summary?.generatedAt) || null,
    totalEvents: Math.max(0, Math.trunc(Number(summary?.totalEvents || 0))),
    totalWaitMs: Math.max(0, Math.trunc(Number(summary?.totalWaitMs || 0))),
    stale: summary?.stale === true,
    staleAgeMs: Math.max(0, Math.trunc(Number(summary?.staleAgeMs || 0))),
    hotAreas,
    recent,
  };
}

export function buildRepoAreaContentionViewModel(summary = null) {
  const normalized = normalizeRepoAreaContentionSummary(summary);
  if (normalized.totalEvents === 0 && normalized.hotAreas.length === 0) {
    return {
      tone: "success",
      headline: "No repo-area contention detected",
      summary: "Claim flow has not reported any recent repo-area lock contention.",
      totalEventsLabel: "0 events",
      totalWaitLabel: "0s",
      hotAreas: [],
      recentEvents: [],
    };
  }

  const tone = normalized.stale ? "info" : "warning";
  const headline = normalized.hotAreas.length > 0 ? "Hot repo areas" : "Recent repo-area contention";
  const waitSeconds = Math.round(normalized.totalWaitMs / 1000);
  const summaryText = normalized.stale
    ? "Stale contention telemetry — validate with current operator logs before acting."
    : "Recent claim stalls are concentrated in the repo areas below.";

  return {
    tone,
    headline,
    summary: summaryText,
    totalEventsLabel: normalized.totalEvents + (normalized.totalEvents === 1 ? " event" : " events"),
    totalWaitLabel: waitSeconds + "s wait",
    hotAreas: normalized.hotAreas.map((area) => ({
      ...area,
      eventsLabel: area.events + (area.events === 1 ? " event" : " events"),
      waitingLabel: area.waitingTasks + " waiting",
      activeLabel: area.activeSlots + " active",
      avgWaitLabel: Math.round(area.avgWaitMs / 1000) + "s avg wait",
      lastSeenLabel: formatRelative(area.lastContentionAt),
    })),
    recentEvents: normalized.recent.map((event) => ({
      ...event,
      title: event.area + " contention",
      subtitle: event.taskId + " · " + Math.round(event.waitMs / 1000) + "s · " + event.resolutionReason,
      lastSeenLabel: formatRelative(event.at),
    })),
  };
}
