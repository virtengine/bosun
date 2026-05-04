import React from "react";
import htm from "htm";
import { getFooterHints } from "../../ui/tui/HelpScreen.js";
import * as ink from "ink";

const Box = ink.Box ?? ink.default?.Box;
const Text = ink.Text ?? ink.default?.Text;
const useInput = ink.useInput ?? ink.default?.useInput;

const html = htm.bind(React.createElement);
const REFRESH_MS = 3000;
const MAX_INBOX_ITEMS = 18;
const MAX_DETAIL_LINES = 14;
const MAX_RUN_ROWS = 8;
const MAX_DIAGNOSTIC_LINES = 8;
const MAX_SNAPSHOT_LINES = 5;

function truncate(value, width = 60) {
  const text = String(value || "");
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(0, width - 1))}…`;
}

function formatEventTime(value) {
  if (!value) return "--:--:--";
  try {
    return new Date(value).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return "--:--:--";
  }
}

function eventTone(status = "", eventType = "") {
  const normalizedStatus = String(status || "").trim().toLowerCase();
  const normalizedType = String(eventType || "").trim().toLowerCase();
  if (normalizedStatus === "failed" || normalizedType.includes("error")) return "red";
  if (normalizedStatus === "running" || normalizedType.includes("start")) return "yellow";
  if (normalizedStatus === "completed" || normalizedType.includes("complete") || normalizedType.includes("end")) return "green";
  return undefined;
}

function approvalTone(kind = "", state = "") {
  const normalizedKind = String(kind || "").trim().toLowerCase();
  const normalizedState = String(state || "").trim().toLowerCase();
  if (normalizedState === "stalled" || normalizedState === "failed" || normalizedState === "denied") return "red";
  if (normalizedKind === "workflow") return "cyan";
  if (normalizedKind === "harness-approval") return "yellow";
  if (normalizedKind === "harness-attention") return "magenta";
  return undefined;
}

function workflowRunTone(status = "") {
  const normalizedStatus = String(status || "").trim().toLowerCase();
  if (normalizedStatus === "failed" || normalizedStatus === "cancelled" || normalizedStatus === "canceled") return "red";
  if (normalizedStatus === "running") return "yellow";
  if (normalizedStatus === "completed") return "green";
  if (normalizedStatus === "waiting" || normalizedStatus === "paused") return "magenta";
  return undefined;
}

function getHarnessRunState(run) {
  return String(
    run?.health?.state
    || run?.status
    || run?.outcome
    || run?.result?.status
    || run?.result?.outcome
    || "unknown",
  ).trim().toLowerCase();
}

function getHarnessApprovalRequestId(run) {
  return String(
    run?.health?.approvalRequestId
    || run?.approvalRequestId
    || run?.requestId
    || run?.latestApproval?.requestId
    || "",
  ).trim();
}

function getHarnessAttentionDetail(run) {
  return String(
    run?.health?.attentionReason
    || run?.health?.lastEventSummary
    || run?.latestEvent?.summary
    || run?.summary
    || "",
  ).trim();
}

function formatHarnessStage(run) {
  return String(
    run?.currentStageId
    || run?.health?.approvalStageId
    || run?.stageId
    || run?.completedStageId
    || run?.result?.completedStageId
    || "—",
  ).trim() || "—";
}

function getTimestampValue(value) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function formatRelativeSeconds(value) {
  const timestamp = getTimestampValue(value);
  if (!timestamp) return "n/a";
  const diffSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function getApprovalLabel(request) {
  return truncate(
    request?.title
      || request?.label
      || request?.summary
      || request?.workflowName
      || request?.runId
      || request?.scopeId
      || request?.requestId
      || "approval request",
    72,
  );
}

function normalizeWorkflowApproval(request) {
  const requestId = String(request?.requestId || request?.id || "").trim();
  if (!requestId) return null;
  return {
    key: `workflow:${requestId}`,
    kind: "workflow",
    requestId,
    label: getApprovalLabel(request),
    state: String(request?.status || "pending").trim().toLowerCase(),
    workflowName: String(request?.workflowName || request?.workflowId || request?.scopeId || "").trim(),
    runId: String(request?.runId || request?.scopeId || "").trim(),
    stageId: String(request?.stageId || request?.nodeId || request?.stepId || "").trim(),
    note: String(request?.note || request?.reason || request?.prompt || request?.summary || "").trim(),
    createdAt: request?.createdAt || request?.requestedAt || request?.updatedAt || null,
    detail: request,
  };
}

function normalizeHarnessApproval(request) {
  const requestId = String(request?.requestId || request?.id || "").trim();
  if (!requestId) return null;
  return {
    key: `harness-approval:${requestId}`,
    kind: "harness-approval",
    requestId,
    label: getApprovalLabel(request),
    state: String(request?.status || "pending").trim().toLowerCase(),
    workflowName: String(request?.workflowName || request?.scopeId || "").trim(),
    runId: String(request?.runId || request?.scopeId || "").trim(),
    stageId: String(request?.stageId || request?.approvalStageId || "").trim(),
    note: String(request?.note || request?.reason || request?.prompt || request?.summary || "").trim(),
    createdAt: request?.createdAt || request?.requestedAt || request?.updatedAt || null,
    detail: request,
  };
}

function normalizeHarnessRun(run) {
  const runId = String(run?.runId || "").trim();
  if (!runId) return null;
  const state = getHarnessRunState(run);
  if (!["waiting", "stalled"].includes(state)) return null;
  return {
    key: `harness-attention:${runId}`,
    kind: "harness-attention",
    requestId: getHarnessApprovalRequestId(run),
    label: truncate(run?.name || runId, 72),
    state,
    workflowName: String(run?.workflowName || run?.templateId || "").trim(),
    runId,
    stageId: formatHarnessStage(run),
    note: getHarnessAttentionDetail(run),
    createdAt: run?.updatedAt || run?.createdAt || run?.startedAt || null,
    detail: run,
  };
}

function normalizeWorkflowRun(run) {
  const runId = String(run?.runId || "").trim();
  if (!runId) return null;
  const status = String(run?.status || run?.result?.status || "unknown").trim().toLowerCase();
  return {
    runId,
    workflowId: String(run?.workflowId || run?.detail?.data?._workflowId || "").trim(),
    workflowName: String(run?.workflowName || run?.detail?.data?._workflowName || "").trim(),
    status,
    triggerSource: String(run?.triggerSource || run?.detail?.triggerSource || "").trim(),
    startedAt: run?.startedAt || run?.createdAt || null,
    updatedAt: run?.updatedAt || run?.endedAt || run?.startedAt || null,
    endedAt: run?.endedAt || null,
    durationMs: Number(run?.durationMs || 0) || 0,
    error: String(run?.error || run?.detail?.error || "").trim(),
    approvalPending: run?.approvalPending === true || run?.detail?.approvalPending === true,
    heartbeatRun: run?.heartbeatRun || run?.detail?.heartbeatRun || null,
    wakeupRequest: run?.wakeupRequest || run?.detail?.wakeupRequest || null,
    issueAdvisor: run?.issueAdvisor || run?.detail?.issueAdvisor || null,
    ledgerEvents: Array.isArray(run?.ledger?.events) ? run.ledger.events : [],
    detail: run,
  };
}

function buildOperatorInboxItems(workflowApprovals, harnessApprovals, harnessRuns) {
  const items = [];
  const seen = new Set();
  for (const request of Array.isArray(workflowApprovals) ? workflowApprovals : []) {
    const item = normalizeWorkflowApproval(request);
    if (!item || seen.has(item.key)) continue;
    seen.add(item.key);
    items.push(item);
  }
  for (const request of Array.isArray(harnessApprovals) ? harnessApprovals : []) {
    const item = normalizeHarnessApproval(request);
    if (!item || seen.has(item.key)) continue;
    seen.add(item.key);
    items.push(item);
  }
  for (const run of Array.isArray(harnessRuns) ? harnessRuns : []) {
    const item = normalizeHarnessRun(run);
    if (!item || seen.has(item.key)) continue;
    seen.add(item.key);
    items.push(item);
  }
  return items
    .sort((a, b) => getTimestampValue(b.createdAt) - getTimestampValue(a.createdAt))
    .slice(0, MAX_INBOX_ITEMS);
}

function inboxDetailLines(item) {
  if (!item) return [];
  const requestState = item.state || "pending";
  const lines = [
    `Kind          ${item.kind}`,
    `Request ID    ${item.requestId || "none"}`,
    `Run ID        ${item.runId || "n/a"}`,
    `Workflow      ${item.workflowName || "n/a"}`,
    `Stage         ${item.stageId || "n/a"}`,
    `State         ${requestState}`,
    `Created       ${item.createdAt ? String(item.createdAt) : "n/a"}`,
    `Summary       ${item.label || "n/a"}`,
    `Detail        ${item.note || "No detail available"}`,
  ];

  const extraFields = item.kind === "harness-attention"
    ? [
        `Attention     ${getHarnessAttentionDetail(item.detail) || "No attention detail available"}`,
        `Approval      ${getHarnessApprovalRequestId(item.detail) || "not required"}`,
      ]
    : [
        `Actor         ${String(item.detail?.requestedBy || item.detail?.actor || "operator").trim() || "operator"}`,
        `Scope         ${String(item.detail?.scopeType || "workflow-run").trim() || "workflow-run"}`,
      ];

  return [...lines, ...extraFields].slice(0, MAX_DETAIL_LINES);
}

function describeInboxItem(item, isSelected) {
  const prefix = item.kind === "workflow"
    ? "WF "
    : item.kind === "harness-approval"
      ? "HR "
      : "AT ";
  const headline = `${prefix}${truncate(item.label, 26).padEnd(27, " ")} ${truncate(item.state, 8).padEnd(8, " ")} ${truncate(item.stageId || item.runId || "n/a", 20)}`;
  const detail = truncate(item.note || item.workflowName || item.runId || "No detail available", 60);
  return {
    key: item.key,
    color: approvalTone(item.kind, item.state),
    inverse: isSelected,
    line: `${headline} ${detail}`,
  };
}

function describeWorkflowRunRow(run, isSelected) {
  const title = truncate(run.workflowName || run.workflowId || "workflow", 24).padEnd(25, " ");
  const status = truncate(run.status || "unknown", 10).padEnd(10, " ");
  const trigger = truncate(run.triggerSource || "manual", 10).padEnd(10, " ");
  const detail = truncate(
    run.error
      || (run.approvalPending ? "approval pending" : "")
      || formatRelativeSeconds(run.updatedAt || run.startedAt),
    40,
  );
  return {
    key: run.runId,
    color: workflowRunTone(run.status),
    inverse: isSelected,
    line: `${truncate(run.runId, 8).padEnd(9, " ")} ${title} ${status} ${trigger} ${detail}`,
  };
}

function summarizeLedgerEvent(event) {
  if (!event || typeof event !== "object") return "Unknown event";
  const parts = [String(event.eventType || "event").trim() || "event"];
  if (event.nodeId) parts.push(String(event.nodeId).trim());
  if (event.status) parts.push(`status=${String(event.status).trim()}`);
  if (event.error) parts.push(`error=${String(event.error).trim()}`);
  return parts.join(" · ");
}

function extractEvaluationLines(evaluation) {
  if (!evaluation || typeof evaluation !== "object") {
    return ["No evaluation recorded."];
  }
  const lines = [];
  const status = String(evaluation.status || evaluation.outcome || evaluation.verdict || "").trim();
  const score = evaluation.score ?? evaluation.healthScore ?? evaluation.confidence;
  const summary = String(evaluation.summary || evaluation.reason || evaluation.recommendation || "").trim();
  if (status) lines.push(`Status: ${status}`);
  if (score !== undefined && score !== null && score !== "") lines.push(`Score: ${score}`);
  if (summary) lines.push(`Summary: ${summary}`);
  const issues = Array.isArray(evaluation.issues) ? evaluation.issues : Array.isArray(evaluation.findings) ? evaluation.findings : [];
  for (const issue of issues.slice(0, 4)) {
    const issueText = typeof issue === "string"
      ? issue
      : String(issue?.summary || issue?.message || issue?.reason || issue?.title || "").trim();
    if (issueText) lines.push(`Issue: ${issueText}`);
  }
  return lines.length ? lines.slice(0, MAX_DIAGNOSTIC_LINES) : ["Evaluation data loaded but empty."];
}

function extractForensicsLines(forensics) {
  if (!forensics || typeof forensics !== "object") {
    return ["No forensics snapshot recorded."];
  }
  const lines = [];
  const summary = String(forensics.summary || forensics.reason || forensics.status || "").trim();
  if (summary) lines.push(`Summary: ${summary}`);
  const failedNodes = Array.isArray(forensics.failedNodes) ? forensics.failedNodes : [];
  const artifacts = Array.isArray(forensics.artifacts) ? forensics.artifacts : [];
  const traces = Array.isArray(forensics.trace) ? forensics.trace : Array.isArray(forensics.events) ? forensics.events : [];
  if (failedNodes.length) {
    lines.push(`Failed nodes: ${failedNodes.slice(0, 3).map((entry) => String(entry?.nodeId || entry?.id || entry)).join(", ")}`);
  }
  if (artifacts.length) {
    lines.push(`Artifacts: ${artifacts.slice(0, 3).map((entry) => String(entry?.path || entry?.label || entry?.name || entry)).join(", ")}`);
  }
  for (const entry of traces.slice(0, 3)) {
    const traceText = typeof entry === "string"
      ? entry
      : String(entry?.summary || entry?.message || entry?.reason || entry?.eventType || "").trim();
    if (traceText) lines.push(`Trace: ${traceText}`);
  }
  return lines.length ? lines.slice(0, MAX_DIAGNOSTIC_LINES) : ["Forensics data loaded but empty."];
}

function extractSnapshotLines(snapshots) {
  const items = Array.isArray(snapshots) ? snapshots : [];
  if (!items.length) return ["No snapshots recorded."];
  return items.slice(0, MAX_SNAPSHOT_LINES).map((entry, index) => {
    const snapshotId = String(entry?.snapshotId || entry?.id || `snapshot-${index + 1}`).trim();
    const createdAt = String(entry?.createdAt || entry?.timestamp || "").trim() || "unknown time";
    const status = String(entry?.status || entry?.result || "").trim() || "saved";
    return `${snapshotId} · ${status} · ${createdAt}`;
  });
}

function InboxDetail({ item }) {
  const lines = inboxDetailLines(item);
  return html`
    <${Box} flexDirection="column" paddingY=${1}>
      <${Text} key="workflow-inbox-detail-title" bold>Workflow Inbox Detail<//>
      ${lines.map((line, index) => html`<${Text} key=${`line-${index}`} wrap="truncate-end">${line}<//>`)}
      <${Box} key="workflow-inbox-detail-actions" marginTop=${1} flexDirection="column">
        <${Text} key="workflow-inbox-detail-help" dimColor>[A]pprove  [X] deny  [Esc] close<//>
      <//>
    <//>
  `;
}

function WorkflowRunDetail({ run, evaluation, forensics, snapshots, snapshotStatusLine }) {
  const safeRun = run || {};
  const detailLines = [
    `Run ID        ${safeRun.runId || "n/a"}`,
    `Workflow      ${safeRun.workflowName || safeRun.workflowId || "n/a"}`,
    `Status        ${safeRun.status || "unknown"}`,
    `Trigger       ${safeRun.triggerSource || "manual"}`,
    `Started       ${safeRun.startedAt || "n/a"}`,
    `Updated       ${safeRun.updatedAt || safeRun.endedAt || "n/a"}`,
    `Duration      ${safeRun.durationMs ? `${Math.round(safeRun.durationMs / 1000)}s` : "n/a"}`,
    `Approval      ${safeRun.approvalPending ? "pending" : "not required"}`,
    `Heartbeat     ${safeRun.heartbeatRun?.runId || "n/a"}`,
    `Wakeup        ${safeRun.wakeupRequest?.requestId || "n/a"}`,
    `Issue Advisor ${String(safeRun.issueAdvisor?.recommendedAction || "none").trim() || "none"}`,
    `Error         ${safeRun.error || "none"}`,
  ];
  const ledgerEvents = Array.isArray(safeRun.ledgerEvents) ? safeRun.ledgerEvents.slice(-6) : [];

  return html`
    <${Box} flexDirection="column" paddingY=${1}>
      <${Text} key="workflow-run-detail-title" bold>Workflow Run Detail<//>
      ${detailLines.map((line, index) => html`<${Text} key=${`detail-${index}`} wrap="truncate-end">${line}<//>`)}
      <${Box} key="workflow-run-ledger" marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
        <${Text} key="workflow-run-ledger-title" bold>Recent Ledger Events<//>
        ${ledgerEvents.length
          ? ledgerEvents.map((event, index) => html`
              <${Text} key=${`${safeRun.runId || "run"}-${index}`} wrap="truncate-end">
                ${truncate(summarizeLedgerEvent(event), 96)}
              <//>
            `)
          : html`<${Text} key="workflow-run-no-ledger-events" dimColor>No ledger events recorded.<//>`}
      <//>
      <${Box} key="workflow-run-evaluation" marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
        <${Text} key="workflow-run-evaluation-title" bold>Run Evaluation<//>
        ${extractEvaluationLines(evaluation).map((line, index) => html`
          <${Text} key=${`evaluation-${index}`} wrap="truncate-end">${line}<//>
        `)}
      <//>
      <${Box} key="workflow-run-forensics" marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
        <${Text} key="workflow-run-forensics-title" bold>Run Forensics<//>
        ${extractForensicsLines(forensics).map((line, index) => html`
          <${Text} key=${`forensics-${index}`} wrap="truncate-end">${line}<//>
        `)}
      <//>
      <${Box} key="workflow-run-snapshots" marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
        <${Text} key="workflow-run-snapshots-title" bold>Run Snapshots<//>
        ${extractSnapshotLines(snapshots).map((line, index) => html`
          <${Text} key=${`snapshot-${index}`} wrap="truncate-end">${line}<//>
        `)}
        ${snapshotStatusLine ? html`<${Text} key="workflow-run-snapshot-status" color="yellow">${snapshotStatusLine}<//>` : null}
      <//>
      <${Box} key="workflow-run-actions" marginTop=${1} flexDirection="column">
        <${Text} key="workflow-run-actions-help" dimColor>[F] forensics  [V] evaluate  [P] snapshot  [O] restore  [M] remediate  [C]ancel  [T] retry  [A]pprove  [X] deny  [Esc] close<//>
      <//>
    <//>
  `;
}

export default function WorkflowsScreen({
  workflowsState,
  workflowEvents = [],
  stats = {},
  requestJson,
  onFooterHintsChange,
}) {
  const workflows = Array.isArray(workflowsState?.workflows) ? workflowsState.workflows : [];
  const loading = Boolean(workflowsState?.loading);
  const error = workflowsState?.error ? String(workflowsState.error) : "";
  const activeWorkflowRuns = Array.isArray(stats?.workflows?.active) ? stats.workflows.active : [];
  const totalWorkflows = Number(stats?.workflows?.total || workflows.length || 0);

  const [workflowApprovals, setWorkflowApprovals] = React.useState([]);
  const [harnessApprovals, setHarnessApprovals] = React.useState([]);
  const [harnessRuns, setHarnessRuns] = React.useState([]);
  const [workflowRuns, setWorkflowRuns] = React.useState([]);
  const [selectedInboxIndex, setSelectedInboxIndex] = React.useState(0);
  const [selectedRunIndex, setSelectedRunIndex] = React.useState(0);
  const [detailItem, setDetailItem] = React.useState(null);
  const [workflowRunDetail, setWorkflowRunDetail] = React.useState(null);
  const [workflowRunEvaluation, setWorkflowRunEvaluation] = React.useState(null);
  const [workflowRunForensics, setWorkflowRunForensics] = React.useState(null);
  const [workflowRunSnapshots, setWorkflowRunSnapshots] = React.useState([]);
  const [workflowRunSnapshotStatusLine, setWorkflowRunSnapshotStatusLine] = React.useState("");
  const [statusLine, setStatusLine] = React.useState("");

  const operatorInbox = React.useMemo(
    () => buildOperatorInboxItems(workflowApprovals, harnessApprovals, harnessRuns),
    [workflowApprovals, harnessApprovals, harnessRuns],
  );
  const recentWorkflowRuns = React.useMemo(
    () => (Array.isArray(workflowRuns) ? workflowRuns : []).map(normalizeWorkflowRun).filter(Boolean).slice(0, MAX_RUN_ROWS),
    [workflowRuns],
  );
  const selectedItem = operatorInbox[selectedInboxIndex] || operatorInbox[0] || null;
  const selectedRun = recentWorkflowRuns[selectedRunIndex] || recentWorkflowRuns[0] || null;

  const refreshInbox = React.useCallback(async () => {
    if (typeof requestJson !== "function") {
      setStatusLine("requestJson is unavailable for workflow operator inbox.");
      return;
    }
    try {
      const [surfacePayload, workflowRunsPayload] = await Promise.all([
        requestJson("/api/harness/surface?view=workflows&limit=25"),
        requestJson("/api/workflows/runs?limit=8"),
      ]);
      setWorkflowApprovals(Array.isArray(surfacePayload?.workflows?.approvals) ? surfacePayload.workflows.approvals : []);
      setHarnessApprovals(Array.isArray(surfacePayload?.harness?.approvals) ? surfacePayload.harness.approvals : []);
      setHarnessRuns(Array.isArray(surfacePayload?.harness?.runs) ? surfacePayload.harness.runs : []);
      setWorkflowRuns(
        Array.isArray(workflowRunsPayload?.runs)
          ? workflowRunsPayload.runs
          : Array.isArray(surfacePayload?.workflows?.runs)
            ? surfacePayload.workflows.runs
            : [],
      );
      setStatusLine("");
    } catch (err) {
      setStatusLine(String(err?.message || err || "Unable to refresh workflow operator inbox"));
    }
  }, [requestJson]);

  const resolveInboxItem = React.useCallback(async (item, decision) => {
    if (!item) return;
    if (typeof requestJson !== "function") {
      setStatusLine("requestJson is unavailable for inbox actions.");
      return;
    }
    if (!item.requestId) {
      setStatusLine("Selected inbox item has no approval request to resolve.");
      return;
    }
    try {
      if (item.kind === "workflow") {
        // "/api/workflows/approvals/${encodeURIComponent(item.requestId)}/resolve"
        await requestJson(`/api/workflows/approvals/${encodeURIComponent(item.requestId)}/resolve`, {
          method: "POST",
          body: {
            decision,
            actor: "operator",
            note: `${decision} from workflow operator inbox`,
          },
        });
      } else {
        // "/api/harness/approvals/${encodeURIComponent(item.requestId)}/resolve"
        await requestJson(`/api/harness/approvals/${encodeURIComponent(item.requestId)}/resolve`, {
          method: "POST",
          body: {
            decision,
            actor: "operator",
            note: `${decision} from workflow operator inbox`,
          },
        });
      }
      setStatusLine(decision === "approved" ? "Approval granted." : "Approval denied.");
      setDetailItem(null);
      await refreshInbox();
    } catch (err) {
      setStatusLine(String(err?.message || err || "Unable to resolve approval request"));
    }
  }, [refreshInbox, requestJson]);

  const loadWorkflowRunDetail = React.useCallback(async (runId) => {
    if (!runId || typeof requestJson !== "function") return;
    try {
      const payload = await requestJson(`/api/workflows/runs/${encodeURIComponent(runId)}`);
      setWorkflowRunDetail(normalizeWorkflowRun(payload?.run || payload));
      setStatusLine("");
    } catch (err) {
      setStatusLine(String(err?.message || err || "Unable to load workflow run detail"));
    }
  }, [requestJson]);

  const loadWorkflowRunEvaluation = React.useCallback(async (runId) => {
    if (!runId || typeof requestJson !== "function") return;
    try {
      const payload = await requestJson(`/api/workflows/runs/${encodeURIComponent(runId)}/evaluate`);
      setWorkflowRunEvaluation(payload?.evaluation || payload || null);
    } catch (err) {
      setStatusLine(String(err?.message || err || "Unable to load workflow evaluation"));
    }
  }, [requestJson]);

  const loadWorkflowRunForensics = React.useCallback(async (runId) => {
    if (!runId || typeof requestJson !== "function") return;
    try {
      const payload = await requestJson(`/api/workflows/runs/${encodeURIComponent(runId)}/forensics`);
      setWorkflowRunForensics(payload?.forensics || payload || null);
    } catch (err) {
      setStatusLine(String(err?.message || err || "Unable to load workflow forensics"));
    }
  }, [requestJson]);

  const loadWorkflowRunSnapshots = React.useCallback(async (runId) => {
    if (!runId || typeof requestJson !== "function") return;
    try {
      const payload = await requestJson(`/api/workflows/runs/${encodeURIComponent(runId)}/snapshots`);
      setWorkflowRunSnapshots(Array.isArray(payload?.snapshots) ? payload.snapshots : []);
      setWorkflowRunSnapshotStatusLine("");
    } catch (err) {
      setWorkflowRunSnapshotStatusLine(String(err?.message || err || "Unable to load workflow snapshots"));
    }
  }, [requestJson]);

  const openWorkflowRunDetail = React.useCallback(async () => {
    if (!selectedRun?.runId) return;
    setWorkflowRunDetail(selectedRun);
    setWorkflowRunEvaluation(null);
    setWorkflowRunForensics(null);
    setWorkflowRunSnapshots([]);
    setWorkflowRunSnapshotStatusLine("");
    await Promise.all([
      loadWorkflowRunDetail(selectedRun.runId),
      loadWorkflowRunEvaluation(selectedRun.runId),
      loadWorkflowRunForensics(selectedRun.runId),
      loadWorkflowRunSnapshots(selectedRun.runId),
    ]);
  }, [loadWorkflowRunDetail, loadWorkflowRunEvaluation, loadWorkflowRunForensics, loadWorkflowRunSnapshots, selectedRun]);

  const resolveWorkflowRunApproval = React.useCallback(async (decision) => {
    const run = workflowRunDetail || selectedRun;
    const runId = String(run?.runId || "").trim();
    if (!runId || typeof requestJson !== "function") return;
    try {
      await requestJson(`/api/workflows/runs/${encodeURIComponent(runId)}/approval`, {
        method: "POST",
        body: { decision, note: `${decision} from workflow run detail` },
      });
      setStatusLine(decision === "approved" ? "Workflow approval granted." : "Workflow approval denied.");
      await Promise.all([
        loadWorkflowRunDetail(runId),
        loadWorkflowRunEvaluation(runId),
        loadWorkflowRunForensics(runId),
        loadWorkflowRunSnapshots(runId),
      ]);
      await refreshInbox();
    } catch (err) {
      setStatusLine(String(err?.message || err || "Unable to resolve workflow approval"));
    }
  }, [loadWorkflowRunDetail, loadWorkflowRunEvaluation, loadWorkflowRunForensics, loadWorkflowRunSnapshots, refreshInbox, requestJson, selectedRun, workflowRunDetail]);

  const cancelWorkflowRun = React.useCallback(async () => {
    const run = workflowRunDetail || selectedRun;
    const runId = String(run?.runId || "").trim();
    if (!runId || typeof requestJson !== "function") return;
    try {
      await requestJson(`/api/workflows/runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
      });
      setStatusLine("Workflow run cancellation requested.");
      await Promise.all([
        loadWorkflowRunDetail(runId),
        loadWorkflowRunEvaluation(runId),
        loadWorkflowRunForensics(runId),
        loadWorkflowRunSnapshots(runId),
      ]);
      await refreshInbox();
    } catch (err) {
      setStatusLine(String(err?.message || err || "Unable to cancel workflow run"));
    }
  }, [loadWorkflowRunDetail, loadWorkflowRunEvaluation, loadWorkflowRunForensics, loadWorkflowRunSnapshots, refreshInbox, requestJson, selectedRun, workflowRunDetail]);

  const retryWorkflowRun = React.useCallback(async () => {
    const run = workflowRunDetail || selectedRun;
    const runId = String(run?.runId || "").trim();
    if (!runId || typeof requestJson !== "function") return;
    try {
      const options = await requestJson(`/api/workflows/runs/${encodeURIComponent(runId)}/retry`, {
        method: "POST",
        body: {},
      });
      const recommendedMode = String(
        options?.recommendedMode
          || options?.defaultMode
          || options?.modes?.[0]?.mode
          || options?.options?.[0]?.mode
          || "from_failed",
      ).trim() || "from_failed";
      await requestJson(`/api/workflows/runs/${encodeURIComponent(runId)}/retry`, {
        method: "POST",
        body: { mode: recommendedMode },
      });
      setStatusLine(`Workflow run retry queued (${recommendedMode}).`);
      await refreshInbox();
    } catch (err) {
      setStatusLine(String(err?.message || err || "Unable to retry workflow run"));
    }
  }, [refreshInbox, requestJson, selectedRun, workflowRunDetail]);

  const createWorkflowRunSnapshot = React.useCallback(async () => {
    const run = workflowRunDetail || selectedRun;
    const runId = String(run?.runId || "").trim();
    if (!runId || typeof requestJson !== "function") return;
    try {
      const payload = await requestJson(`/api/workflows/runs/${encodeURIComponent(runId)}/snapshot`, {
        method: "POST",
        body: {},
      });
      setWorkflowRunSnapshotStatusLine(`Snapshot created: ${payload?.snapshotId || payload?.runId || "ok"}`);
      await loadWorkflowRunSnapshots(runId);
    } catch (err) {
      setWorkflowRunSnapshotStatusLine(String(err?.message || err || "Unable to create snapshot"));
    }
  }, [loadWorkflowRunSnapshots, requestJson, selectedRun, workflowRunDetail]);

  const restoreWorkflowRunSnapshot = React.useCallback(async () => {
    const run = workflowRunDetail || selectedRun;
    const runId = String(run?.runId || "").trim();
    if (!runId || typeof requestJson !== "function") return;
    try {
      const payload = await requestJson(`/api/workflows/runs/${encodeURIComponent(runId)}/restore`, {
        method: "POST",
        body: { variables: {} },
      });
      setWorkflowRunSnapshotStatusLine(`Restore queued: ${payload?.runId || runId}`);
      await Promise.all([
        loadWorkflowRunSnapshots(runId),
        refreshInbox(),
      ]);
    } catch (err) {
      setWorkflowRunSnapshotStatusLine(String(err?.message || err || "Unable to restore snapshot"));
    }
  }, [loadWorkflowRunSnapshots, refreshInbox, requestJson, selectedRun, workflowRunDetail]);

  const remediateWorkflowRun = React.useCallback(async () => {
    const run = workflowRunDetail || selectedRun;
    const runId = String(run?.runId || "").trim();
    if (!runId || typeof requestJson !== "function") return;
    const actions = [];
    if (run?.issueAdvisor?.recommendedAction) {
      actions.push({
        type: String(run.issueAdvisor.recommendedAction).trim(),
        nodeId: String(run.issueAdvisor?.nodeId || "").trim() || undefined,
      });
    }
    if (!actions.length) {
      actions.push({ type: "inspect_failure" });
    }
    try {
      const payload = await requestJson(`/api/workflows/runs/${encodeURIComponent(runId)}/remediate`, {
        method: "POST",
        body: {
          actions,
          autoRetry: true,
        },
      });
      const retryTriggered = payload?.retryTriggered ? ` · retry ${payload?.retryRunId || "queued"}` : "";
      setWorkflowRunSnapshotStatusLine(`Remediation noted: ${actions.length} action(s)${retryTriggered}`);
      await Promise.all([
        loadWorkflowRunDetail(runId),
        loadWorkflowRunEvaluation(runId),
        loadWorkflowRunForensics(runId),
        loadWorkflowRunSnapshots(runId),
        refreshInbox(),
      ]);
    } catch (err) {
      setWorkflowRunSnapshotStatusLine(String(err?.message || err || "Unable to remediate workflow run"));
    }
  }, [loadWorkflowRunDetail, loadWorkflowRunEvaluation, loadWorkflowRunForensics, loadWorkflowRunSnapshots, refreshInbox, requestJson, selectedRun, workflowRunDetail]);

  React.useEffect(() => {
    void refreshInbox();
    const timer = setInterval(() => {
      void refreshInbox();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refreshInbox]);

  React.useEffect(() => {
    setSelectedInboxIndex((current) => {
      if (!operatorInbox.length) return 0;
      return Math.min(current, operatorInbox.length - 1);
    });
  }, [operatorInbox.length]);

  React.useEffect(() => {
    setSelectedRunIndex((current) => {
      if (!recentWorkflowRuns.length) return 0;
      return Math.min(current, recentWorkflowRuns.length - 1);
    });
  }, [recentWorkflowRuns.length]);

  React.useEffect(() => {
    if (typeof onFooterHintsChange !== "function") return;
    onFooterHintsChange(getFooterHints("workflows", {
      workflowInboxDetailOpen: Boolean(detailItem),
      workflowRunDetailOpen: Boolean(workflowRunDetail),
    }));
  }, [detailItem, onFooterHintsChange, workflowRunDetail]);

  useInput((input, key) => {
    if (workflowRunDetail) {
      if (key.escape) {
        setWorkflowRunDetail(null);
        setWorkflowRunEvaluation(null);
        setWorkflowRunForensics(null);
        setWorkflowRunSnapshots([]);
        setWorkflowRunSnapshotStatusLine("");
        return;
      }
      if (input === "f" || input === "F") {
        void loadWorkflowRunForensics(String((workflowRunDetail || selectedRun)?.runId || "").trim());
        return;
      }
      if (input === "v" || input === "V") {
        void loadWorkflowRunEvaluation(String((workflowRunDetail || selectedRun)?.runId || "").trim());
        return;
      }
      if (input === "p" || input === "P") {
        void createWorkflowRunSnapshot();
        return;
      }
      if (input === "o" || input === "O") {
        void restoreWorkflowRunSnapshot();
        return;
      }
      if (input === "m" || input === "M") {
        void remediateWorkflowRun();
        return;
      }
      if (input === "c" || input === "C") {
        void cancelWorkflowRun();
        return;
      }
      if (input === "t" || input === "T") {
        void retryWorkflowRun();
        return;
      }
      if (input === "a" || input === "A") {
        void resolveWorkflowRunApproval("approved");
        return;
      }
      if (input === "x" || input === "X") {
        void resolveWorkflowRunApproval("denied");
      }
      return;
    }

    if (detailItem) {
      if (key.escape) {
        setDetailItem(null);
        return;
      }
      if (input === "a" || input === "A") {
        void resolveInboxItem(detailItem, "approved");
        return;
      }
      if (input === "x" || input === "X") {
        void resolveInboxItem(detailItem, "denied");
      }
      return;
    }

    if (key.upArrow) {
      setSelectedInboxIndex((current) => {
        if (!operatorInbox.length) return 0;
        return current <= 0 ? operatorInbox.length - 1 : current - 1;
      });
      return;
    }
    if (key.downArrow) {
      setSelectedInboxIndex((current) => {
        if (!operatorInbox.length) return 0;
        return current >= operatorInbox.length - 1 ? 0 : current + 1;
      });
      return;
    }
    if (key.return || input === "`r") {
      if (selectedItem) setDetailItem(selectedItem);
      return;
    }
    if (input === "a" || input === "A") {
      void resolveInboxItem(selectedItem, "approved");
      return;
    }
    if (input === "x" || input === "X") {
      void resolveInboxItem(selectedItem, "denied");
      return;
    }
    if (input === "r" || input === "R") {
      void refreshInbox();
      return;
    }
    if (input === "[") {
      setSelectedRunIndex((current) => {
        if (!recentWorkflowRuns.length) return 0;
        return current <= 0 ? recentWorkflowRuns.length - 1 : current - 1;
      });
      return;
    }
    if (input === "]") {
      setSelectedRunIndex((current) => {
        if (!recentWorkflowRuns.length) return 0;
        return current >= recentWorkflowRuns.length - 1 ? 0 : current + 1;
      });
      return;
    }
    if (input === "g" || input === "G") {
      void openWorkflowRunDetail();
    }
  }, {
    isActive: true,
  });

  return html`
    <${Box} flexDirection="column" paddingY=${1} paddingX=${1}>
      ${workflowRunDetail
        ? html`
            <${WorkflowRunDetail}
              key="workflow-run-detail-view"
              run=${workflowRunDetail}
              evaluation=${workflowRunEvaluation}
              forensics=${workflowRunForensics}
              snapshots=${workflowRunSnapshots}
              snapshotStatusLine=${workflowRunSnapshotStatusLine}
            />`
        : detailItem
        ? html`<${InboxDetail} key="workflow-inbox-detail-view" item=${detailItem} />`
        : html`
            <${Box} key="workflow-operator-inbox" flexDirection="column" borderStyle="single" paddingX=${1}>
              <${Text} key="workflow-operator-inbox-title" bold>Operator Inbox (${operatorInbox.length})<//>
              <${Text} key="workflow-operator-inbox-subtitle" dimColor>Pending workflow approvals plus waiting or stalled harness runs<//>
              ${operatorInbox.length
                ? operatorInbox.map((item, index) => {
                    const row = describeInboxItem(item, index === selectedInboxIndex);
                    return html`
                      <${Text} key=${row.key} color=${row.color} inverse=${row.inverse} wrap="truncate-end">
                        ${row.line}
                      <//>
                    `;
                  })
                : html`<${Text} key="workflow-operator-inbox-empty" dimColor>No operator action is currently required.<//>`}
            <//>

            <${Box} key="workflow-recent-runs" marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
              <${Text} key="workflow-recent-runs-title" bold>Recent Workflow Runs (${recentWorkflowRuns.length})<//>
              <${Text} key="workflow-recent-runs-help" dimColor>[G detail · [ / ] select]<//>
              ${recentWorkflowRuns.length
                ? recentWorkflowRuns.map((run, index) => {
                    const row = describeWorkflowRunRow(run, index === selectedRunIndex);
                    return html`
                      <${Text} key=${row.key} color=${row.color} inverse=${row.inverse} wrap="truncate-end">
                        ${row.line}
                      <//>
                    `;
                  })
                : html`<${Text} key="workflow-recent-runs-empty" dimColor>No workflow runs recorded yet.<//>`}
            <//>

            <${Box} key="workflow-snapshot" marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
              <${Text} key="workflow-snapshot-title" bold>Workflow Snapshot<//>
              <${Text} key="workflow-snapshot-configured">Configured: ${workflows.length}${loading ? " (loading)" : ""}<//>
              <${Text} key="workflow-snapshot-active">Active Runs: ${activeWorkflowRuns.length}/${totalWorkflows}<//>
              <${Text} key="workflow-snapshot-approvals">Pending Approvals: ${workflowApprovals.length + harnessApprovals.length}<//>
              ${error ? html`<${Text} key="workflow-snapshot-error" color="red">${error}<//>` : null}
            <//>

            <${Box} key="workflow-configured-list" marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
              <${Text} key="workflow-configured-list-title" bold>Configured Workflows<//>
              ${workflows.length
                ? workflows.slice(0, 10).map((workflow, index) => html`
                    <${Text} key=${`${workflow.id || workflow.name || "workflow"}-${index}`} wrap="truncate-end">
                      ${truncate(workflow.name || workflow.id || "workflow", 32).padEnd(34, " ")}
                      ${String(workflow.enabled === false ? "disabled" : "enabled").padEnd(9, " ")}
                      ${truncate(workflow.source || workflow.file || "configured", 34)}
                    <//>
                  `)
                : html`<${Text} key="workflow-configured-list-empty" dimColor>No workflows loaded yet.<//>`}
            <//>

            <${Box} key="workflow-event-timeline" marginTop=${1} flexDirection="column" borderStyle="single" paddingX=${1}>
              <${Text} key="workflow-event-timeline-title" bold>Workflow Event Timeline<//>
              ${workflowEvents.length
                ? workflowEvents.slice(0, 8).map((event, index) => html`
                    <${Text}
                      key=${`${event.id || `${event.workflowId || "wf"}-${event.runId || "run"}`}-${index}`}
                      color=${eventTone(event.status, event.eventType)}
                      wrap="truncate-end"
                    >
                      ${formatEventTime(event.timestamp || event.at || event.createdAt)}
                      ${"  "}
                      ${truncate(event.workflowName || event.workflowId || "workflow", 24).padEnd(26, " ")}
                      ${truncate(event.eventType || event.status || "event", 18).padEnd(20, " ")}
                      ${truncate(event.error || event.message || event.nodeLabel || event.nodeId || "-", 56)}
                    <//>
                  `)
                : html`<${Text} key="workflow-event-timeline-empty" dimColor>No workflow status events streamed yet.<//>`}
            <//>
          `}
      ${statusLine
        ? html`
            <${Box} key="workflow-status-line" marginTop=${1}>
              <${Text} key="workflow-status-line-text" color="yellow">${statusLine}<//>
            <//>
          `
        : null}
    <//>
  `;
}
