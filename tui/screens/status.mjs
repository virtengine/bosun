import React from "react";
import htm from "htm";
import * as ink from "ink";

const Box = ink.Box ?? ink.default?.Box;
const Text = ink.Text ?? ink.default?.Text;

const html = htm.bind(React.createElement);

function metric(label, value, suffix = "") {
  return html`
    <${Box} borderStyle="single" paddingX=${1} marginRight=${1}>
      <${Text} dimColor>${label}: <//>
      <${Text} bold>${value}${suffix}<//>
    <//>
  `;
}

function formatDurationSeconds(value) {
  const totalSeconds = Math.max(0, Math.trunc(Number(value || 0)));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export default function StatusScreen({ stats, sessions, tasks }) {
  const s = {
    runtimeMs: 0,
    totalCostUsd: 0,
    retryQueue: { count: 0, items: [] },
    workflows: { active: [], total: 0 },
    memory: { used: 0, total: 0 },
    cpu: { usage: 0 },
    executor: { mode: "internal", paused: false, activeSlots: 0, maxParallel: 0, slots: [] },
    recovery: { totals: {}, lastRun: null, recentRuns: [] },
    ...(stats || {}),
  };
  const activeSessions = (sessions || []).filter((session) => session?.status === "active");
  const executorSlots = Array.isArray(s.executor?.slots) ? s.executor.slots : [];
  const sessionHealth = s.sessionHealth && typeof s.sessionHealth === "object" ? s.sessionHealth : {};
  const durableContext = s.context && typeof s.context === "object" ? s.context : {};
  const toolSummary = s.toolSummary && typeof s.toolSummary === "object" ? s.toolSummary : {};
  const topTools = Array.isArray(toolSummary.topTools) ? toolSummary.topTools.slice(0, 3) : [];
  const harness = s.harness && typeof s.harness === "object" ? s.harness : null;
  const lastRecovery = s.recovery?.lastRun && typeof s.recovery.lastRun === "object"
    ? s.recovery.lastRun
    : null;
  const lastHarnessRun = harness?.lastRun && typeof harness.lastRun === "object"
    ? harness.lastRun
    : null;
  const metrics = [
    { key: "active-sessions", label: "Active Sessions", value: activeSessions.length },
    { key: "tasks", label: "Tasks", value: (tasks || []).length },
    { key: "retry-queue", label: "Retry Queue", value: s.retryQueue?.count || 0 },
    { key: "recovery-resets", label: "Recovery Resets", value: s.recovery?.totals?.resetToTodo || 0 },
    { key: "harness-runs", label: "Harness Runs", value: harness?.totals?.total || 0 },
    { key: "cost", label: "Cost", value: Number(s.totalCostUsd || 0).toFixed(2), suffix: " USD" },
  ];

  return html`
    <${Box} flexDirection="column" paddingY=${1}>
      <${Box}>
        ${metrics.map((item) => html`
          <${React.Fragment} key=${item.key}>
            ${metric(item.label, item.value, item.suffix || "")}
          <//>
        `)}
      <//>
      <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
        <${Text} bold>Runtime Snapshot<//>
        <${Text}>
          CPU ${Number(s.cpu?.usage || 0).toFixed(1)}%  |  Memory
          ${Math.round(Number(s.memory?.used || 0) / 1024 / 1024)}MB /
          ${Math.round(Number(s.memory?.total || 0) / 1024 / 1024)}MB
        <//>
        <${Text}>
          Workflows ${(s.workflows?.active || []).length}/${s.workflows?.total || 0}
        <//>
        <${Text}>
          Executor ${s.executor?.activeSlots || 0}/${s.executor?.maxParallel || 0}
          {" | "}mode ${s.executor?.mode || "internal"}
          {s.executor?.paused ? " | paused" : ""}
        <//>
      <//>
      <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
        <${Text} bold>Durable Runtime<//>
        <${Text}>
          Sessions live ${Number(durableContext.liveSessionCount || sessionHealth.live || s.activeSessionCount || 0)}
          {" | "}completed ${Number(durableContext.completedSessionCount || sessionHealth.completed || s.completedSessionCount || 0)}
          {" | "}total ${Number(s.totalSessionCount || s.totalSessions || sessions?.length || 0)}
        <//>
        <${Text}>
          Context near-limit ${Number(durableContext.sessionsNearContextLimit || 0)}
          {" | "}high-pressure ${Number(durableContext.sessionsHighContextPressure || 0)}
          {" | "}max ${Number(durableContext.maxContextUsagePercent || 0)}%
        <//>
        <${Text}>
          State ledger / SQL
          {" | "}editing ${Number(sessionHealth.editing || 0)}
          {" | "}blocked ${Number(sessionHealth.blocked || 0)}
          {" | "}stalled ${Number(sessionHealth.stalled || 0)}
        <//>
        <${Text}>
          Top tools ${topTools.length
            ? topTools.map((tool) => `${tool.name}:${Number(tool.count || 0)}`).join(", ")
            : "none"}
        <//>
      <//>
      <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
        <${Text} bold>Recovery / Orphans<//>
        ${lastRecovery
          ? html`
              <${React.Fragment} key="last-recovery">
                <${Text}>
                  Last ${lastRecovery.trigger || "interval"} run: scanned ${lastRecovery.scannedCount || 0}
                  {" | "}resumed ${lastRecovery.resumedCount || 0}
                  {" | "}reset ${lastRecovery.resetToTodoCount || 0}
                  {" | "}drift ${lastRecovery.reconciledDriftCount || 0}
                <//>
                <${Text}>
                  Stale owners ${lastRecovery.staleSharedClaimCount || 0}
                  {" | "}active claims ${lastRecovery.skippedForActiveClaimCount || 0}
                  {" | "}workflow ownerless ${lastRecovery.workflowOwnerlessResetCount || 0}
                  {" | "}duration ${formatDurationSeconds((lastRecovery.durationMs || 0) / 1000)}
                <//>
              <//>
            `
          : html`<${Text} dimColor>No recovery activity recorded yet<//>`}
      <//>
      <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
        <${Text} bold>Harness Runs<//>
        ${harness
          ? html`
              <${Text}>
                Runs ${harness.totals?.total || 0}
                {" | "}success ${harness.totals?.successful || 0}
                {" | "}failed ${harness.totals?.failed || 0}
                {" | "}dry-run ${harness.totals?.dryRuns || 0}
              <//>
              <${Text}>
                Active profile ${harness.activeProfile?.name || harness.activeProfile?.agentId || "-"}
                {" | "}validation ${harness.validationMode || "-"}
              <//>
              ${lastHarnessRun
                ? html`
                    <${Text}>
                      Last ${lastHarnessRun.mode || "run"} ${lastHarnessRun.status || "unknown"}
                      {" | "}success ${lastHarnessRun.success === true ? "yes" : "no"}
                      {" | "}artifact ${lastHarnessRun.artifactId || "-"}
                    <//>
                  `
                : html`<${Text} dimColor>No harness runs recorded yet<//>`}
            `
          : html`<${Text} dimColor>Harness telemetry unavailable<//>`}
      <//>
      <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
        <${Text} bold>Executor Slots<//>
        ${executorSlots.length
          ? executorSlots.slice(0, 5).map((slot) => html`
              <${Text} key=${slot.taskId || slot.taskTitle}>
                ${(slot.taskTitle || slot.taskId || "-").slice(0, 44)}
                {" | "}${slot.status || "running"}
                {" | "}${slot.sdk || "agent"}
                {" | "}${formatDurationSeconds(slot.runningFor || 0)}
              <//>
            `)
          : html`<${Text} dimColor>No active executor slots<//>`}
      <//>
      <${Box} marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
        <${Text} bold>Active Sessions<//>
        ${activeSessions.length
          ? activeSessions.slice(0, 5).map((session) => html`
              <${Text} key=${session.id}>
                ${String(session.id || "").slice(0, 8)}  ${session.title || session.taskId || "-"}
              <//>
            `)
          : html`<${Text} dimColor>No active sessions<//>`}
      <//>
    <//>
  `;
}
