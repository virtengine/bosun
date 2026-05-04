import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function extractFunctionSource(source, functionName, nextFunctionName) {
  const startToken = `function ${functionName}() {`;
  const endToken = `function ${nextFunctionName}(`;
  const startIndex = source.indexOf(startToken);
  const endIndex = source.indexOf(endToken, startIndex);

  if (startIndex === -1 || endIndex === -1) {
    throw new Error(`Unable to extract ${functionName} from source`);
  }

  return source.slice(startIndex, endIndex);
}

describe("workflow run history UI pagination", () => {
  const uiSource = readFileSync(resolve(process.cwd(), "ui/tabs/workflows.js"), "utf8");
  const siteSource = readFileSync(resolve(process.cwd(), "site/ui/tabs/workflows.js"), "utf8");
  const uiWorkflowListSource = extractFunctionSource(uiSource, "WorkflowListView", "RunHistoryView");
  const siteWorkflowListSource = extractFunctionSource(siteSource, "WorkflowListView", "RunHistoryView");
  const uiRunHistorySource = extractFunctionSource(uiSource, "RunHistoryView", "WorkflowCodeView");
  const siteRunHistorySource = extractFunctionSource(siteSource, "RunHistoryView", "WorkflowCodeView");

  for (const [label, source] of [
    ["ui", uiSource],
    ["site", siteSource],
  ]) {
    it(`${label} track total counts and next offsets from workflow run pagination`, () => {
      expect(source).toContain("workflowRunsTotal");
      expect(source).toContain("workflowRunsNextOffset");
      expect(source).toContain("data?.pagination?.total");
      expect(source).toContain("data?.pagination?.nextOffset");
      expect(source).toContain("data?.pagination?.hasMore");
    });

    it(`${label} scopes workflow run requests to the selected workspace`, () => {
      expect(source).toContain("buildWorkflowRunApiPath");
      expect(source).toContain("activeWorkspaceId.value");
      expect(source).toContain("searchParams.set(\"workspace\", workspaceId)");
      expect(source).toContain("apiFetch(buildWorkflowRunApiPath(`/api/workflows/runs/${encodeURIComponent(safeRunId)}`))");
    });

    it(`${label} shows explicit loading and retry states for run history and run details`, () => {
      expect(source).toContain("workflowRunsLoading");
      expect(source).toContain("workflowRunsError");
      expect(source).toContain("workflowRunDetailLoading");
      expect(source).toContain("workflowRunDetailError");
      expect(source).toContain("Loading workflow runs…");
      expect(source).toContain("Fetching run details…");
      expect(source).toContain("Retry");
      expect(source).toContain("Refreshing…");
    });

    it(`${label} refreshes live run history incrementally instead of refetching the full loaded list`, () => {
      expect(source).toContain("mergeWorkflowRunRefresh");
      expect(source).toContain("preserveExisting: true");
      expect(source).not.toContain("limit: Math.max(runs.length, WORKFLOW_RUN_PAGE_SIZE)");
    });

    it(`${label} keeps older workflow pagination manual-only`, () => {
      expect(source).not.toContain("tailSentinelRef");
      expect(source).not.toContain("autoLoadMoreRef");
      expect(source).not.toContain("new IntersectionObserver");
      expect(source).toContain("Load more runs");
      expect(source).toContain("of ${totalRuns} run(s)");
    });

    it(`${label} exposes DAG revision history in run details`, () => {
      if (label !== "ui") return;
      expect(source).toContain("DAG Revisions");
      expect(source).toContain("Graph Before:");
      expect(source).toContain("Graph After:");
    });

    it(`${label} exposes execution lineage detail in run details`, () => {
      expect(source).toContain("Execution Lineage");
      expect(source).toContain("Execution Activity");
      expect(source).toContain("Execution Timeline");
      expect(source).toContain("runGraph?.executions");
      expect(source).toContain("runGraph?.timeline");
    });

    it(`${label} exposes delegated topology and run-family navigation in run details`, () => {
      expect(source).toContain("Delegation Topology");
      expect(source).toContain("Delegation Depth:");
      expect(source).toContain("Task Lineage:");
      expect(source).toContain("Session Lineage:");
      expect(source).toContain("Child Runs:");
      expect(source).toContain("Child Sessions:");
      expect(source).toContain("Family Runs:");
      expect(source).toContain("Family Sessions:");
      expect(source).toContain("Open Child Run");
    });

    it(`${label} exposes governance and goal context in run details`, () => {
      expect(source).toContain("Governance & Goals");
      expect(source).toContain("Primary Goal:");
      expect(source).toContain("Goal Ancestry:");
      expect(source).toContain("Budget Window:");
      expect(source).toContain("Approval Hold");
      expect(source).toContain("Approval Pending");
      expect(source).toContain("Heartbeat Run:");
      expect(source).toContain("Wakeup Request:");
      expect(source).toContain("Approve Run");
      expect(source).toContain("Deny Run");
    });

    it(`${label} exposes workflow team coordination context in run details`, () => {
      expect(source).toContain("workflowTeamState");
      expect(source).toContain("teamSummary");
      expect(source).toContain("Team Coordination");
      expect(source).toContain("Shared Team Tasks");
      expect(source).toContain("Team Messages");
      expect(source).toContain("Coordination Events");
      expect(source).toContain("Lead:");
      expect(source).toContain("Default Channel:");
      expect(source).toContain("summarizeWorkflowTeamTaskEntry");
      expect(source).toContain("summarizeWorkflowTeamMessageEntry");
    });

    it(`${label} exposes complete state-ledger audit sections in run details`, () => {
      expect(source).toContain("State Ledger Audit");
      expect(source).toContain("Workflow Events:");
      expect(source).toContain("Known Sessions:");
      expect(source).toContain("Known Agents:");
      expect(source).toContain("Session & Agent Activity");
      expect(source).toContain("Tool Calls");
      expect(source).toContain("Artifacts");
      expect(source).toContain("Operator Actions");
      expect(source).toContain("Claim Events");
      expect(source).toContain("Promoted Strategy Events");
      expect(source).toContain("No workflow lifecycle events recorded in the state ledger.");
    });

    it(`${label} exposes the operator approval queue in run history`, () => {
      expect(source).toContain("Approval Queue");
      expect(source).toContain("Pending Approvals");
      expect(source).toContain("Approve Request");
      expect(source).toContain("Deny Request");
      expect(source).toContain("/api/workflows/approvals");
    });

    it(`${label} exposes scope filters and target routing for the approval queue`, () => {
      expect(source).toContain("approvalScopeFilter");
      expect(source).toContain("normalizeApprovalScopeType");
      expect(source).toContain("getApprovalScopeBadgeStyles");
      expect(source).toContain("Open Harness Monitor");
      expect(source).toContain("No approval requests match the selected scope filter.");
    });

    it(`${label} exposes explicit edge port mapping controls`, () => {
      if (label !== "ui") return;
      expect(source).toContain("Port Bindings");
      expect(source).toContain("Source Port");
      expect(source).toContain("Target Port");
      expect(source).toContain("updateEdgePortMapping");
      expect(source).toContain("Select source port");
      expect(source).toContain("Select target port");
    });
  }

  for (const [label, source] of [
    ["ui", uiWorkflowListSource],
    ["site", siteWorkflowListSource],
  ]) {
    it(`${label} keeps workflow cards wrapped into stable header and action regions`, () => {
      expect(source).toContain("display: flex; flex-direction: column; gap: 8px;");
      expect(source).toContain("display: flex; align-items: flex-start; gap: 8px; flex-wrap: wrap;");
      expect(source).toContain("justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-top: 2px;");
      expect(source).toContain("whiteSpace: 'nowrap'");
    });
  }

  for (const [label, source] of [
    ["ui", uiRunHistorySource],
    ["site", siteRunHistorySource],
  ]) {
    it(`${label} keeps RunHistoryView free of canvas-only edge editing symbols`, () => {
      expect(source).not.toMatch(/\beditingNode\b/);
      expect(source).not.toMatch(/\bselectedEdge\b/);
      expect(source).not.toContain("Selected edge");
      expect(source).not.toContain("Port Bindings");
      expect(source).not.toContain("updateEdgePortMapping");
      expect(source).not.toContain("validateEdgePortMapping");
    });
  }

  it("ui exposes durable session-family and ledger source context in run details", () => {
    expect(uiSource).toContain("Durable Sessions:");
    expect(uiSource).toContain("Durable Session Family:");
    expect(uiSource).toContain("Source:");
    expect(uiSource).toContain("state ledger / SQLite");
    expect(uiSource).toContain("All Sessions:");
  });

  it("server caps and caches durable session list reads for session polling", () => {
    const serverSource = readFileSync(resolve(process.cwd(), "server/ui-server.mjs"), "utf8");

    expect(serverSource).toContain("const DURABLE_SESSION_LIST_LIMIT = 750;");
    expect(serverSource).toContain("const DURABLE_SESSION_LIST_CACHE_TTL_MS = 5000;");
    expect(serverSource).toContain("const durableSessionListCache = new Map();");
    expect(serverSource).toContain("cloneSessionSummaryRecords");
  });
});
