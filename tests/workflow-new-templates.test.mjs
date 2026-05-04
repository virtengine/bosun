import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  WORKFLOW_TEMPLATES,
  getTemplate,
  installTemplate,
} from "../workflow/workflow-templates.mjs";
import { VALIDATE_AND_PR_SUB } from "../workflow-templates/sub-workflows.mjs";
import {
  WorkflowEngine,
  getNodeType,
  registerNodeType,
} from "../workflow/workflow-engine.mjs";

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir;
let engine;

function makeTmpEngine() {
  tmpDir = mkdtempSync(join(tmpdir(), "wf-new-tpl-test-"));
  engine = new WorkflowEngine({
    workflowDir: join(tmpDir, "workflows"),
    runsDir: join(tmpDir, "runs"),
    services: {},
  });
  return engine;
}

function findNode(workflow, nodeId) {
  return workflow.nodes.find((node) => node.id === nodeId);
}

describe("template-health-check self-improvement loop", () => {
  it("collects recent runs, evaluates the latest run, and applies ratchet decisions", () => {
    const template = getTemplate("template-health-check");
    expect(template).toBeDefined();
    expect(template.variables.maxBenchmarkRuns).toBe(12);
    const collectNode = findNode(template, "collect-recent-runs");
    const evaluateNode = findNode(template, "evaluate-latest-run");
    expect(collectNode?.type).toBe("action.run_command");
    expect(collectNode?.config?.parseJson).toBe(true);
    expect(evaluateNode?.type).toBe("action.evaluate_run");
    expect(evaluateNode?.config?.runId).toBe("{{collect-recent-runs.output.latestRunId}}");
    expect(findNode(template, "apply-ratchet")?.type).toBe("action.apply_self_improvement_ratchet");
    expect(findNode(template, "ratchet-applied")?.type).toBe("condition.expression");
    expect(findNode(template, "ratchet-reverted")?.type).toBe("condition.expression");
    expect(template.edges.find((edge) => edge.source === "collect-recent-runs" && edge.target === "has-recent-runs")).toBeDefined();
    expect(template.edges.find((edge) => edge.source === "evaluate-latest-run" && edge.target === "apply-ratchet")).toBeDefined();
    expect(template.edges.find((edge) => edge.source === "apply-ratchet" && edge.target === "ratchet-applied")).toBeDefined();
    expect(template.edges.find((edge) => edge.source === "ratchet-reverted" && edge.target === "log-ratchet-revert")).toBeDefined();
  });
});

describe("template-error-recovery skillbook reuse", () => {
  it("loads reusable recovery strategies before analyze/retry agent steps", () => {
    const template = getTemplate("template-error-recovery");
    expect(template).toBeDefined();
    expect(findNode(template, "load-recovery-strategies")?.type).toBe("action.load_skillbook_strategies");
    expect(findNode(template, "analyze-error")?.config?.prompt).toContain("Reusable prior strategies:");
    expect(findNode(template, "retry-task")?.config?.prompt).toContain("reusableStrategies:");
    expect(template.edges.find((edge) => edge.source === "check-retries" && edge.target === "load-recovery-strategies")).toBeDefined();
    expect(template.edges.find((edge) => edge.source === "load-recovery-strategies" && edge.target === "analyze-error")).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Task Archiver Template
// ═══════════════════════════════════════════════════════════════════════════

describe("template-task-archiver", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("exists and has correct metadata", () => {
    const t = getTemplate("template-task-archiver");
    expect(t).toBeDefined();
    expect(t.name).toBe("Task Archiver");
    expect(t.category).toBe("reliability");
    expect(t.enabled).toBe(true);
    expect(t.recommended).toBe(true);
  });

  it("uses event-based trigger instead of schedule", () => {
    const t = getTemplate("template-task-archiver");
    expect(t.trigger).toBe("trigger.event");
    const triggerNode = t.nodes.find((n) => n.id === "trigger");
    expect(triggerNode).toBeDefined();
    expect(triggerNode.type).toBe("trigger.event");
    expect(triggerNode.config.eventType).toBe("task.status_changed");
    expect(triggerNode.config.filter).toContain("done");
    expect(triggerNode.config.filter).toContain("cancelled");
  });

  it("has proper archival pipeline nodes", () => {
    const t = getTemplate("template-task-archiver");
    const nodeIds = t.nodes.map((n) => n.id);
    expect(nodeIds).toContain("check-age");
    expect(nodeIds).toContain("check-already-archived");
    expect(nodeIds).toContain("archive-to-file");
    expect(nodeIds).toContain("cleanup-sessions");
    expect(nodeIds).toContain("delete-from-backend");
    expect(nodeIds).toContain("should-prune");
    expect(nodeIds).toContain("prune-archives");
    expect(nodeIds).toContain("log-result");
  });

  it("has correct variables with sensible defaults", () => {
    const t = getTemplate("template-task-archiver");
    expect(t.variables.ageHours).toBe(24);
    expect(t.variables.maxArchivePerSweep).toBe(50);
    expect(t.variables.retentionDays).toBe(90);
    expect(t.variables.pruneEnabled).toBe(true);
    expect(t.variables.dryRun).toBe(false);
  });

  it("replaces task-archiver.mjs module functions", () => {
    const t = getTemplate("template-task-archiver");
    expect(t.metadata.replaces.module).toBe("task-archiver.mjs");
    expect(t.metadata.replaces.functions).toContain("archiveCompletedTasks");
    expect(t.metadata.replaces.functions).toContain("archiveTaskToFile");
    expect(t.metadata.replaces.functions).toContain("cleanupAgentSessions");
    expect(t.metadata.replaces.functions).toContain("pruneOldArchives");
  });

  it("conditional pruning path skips prune when disabled", () => {
    const t = getTemplate("template-task-archiver");
    // should-prune → prune-archives (yes) or log-result (no)
    const pruneEdge = t.edges.find(
      (e) => e.source === "should-prune" && e.target === "prune-archives",
    );
    const skipPruneEdge = t.edges.find(
      (e) => e.source === "should-prune" && e.target === "log-result",
    );
    expect(pruneEdge).toBeDefined();
    expect(skipPruneEdge).toBeDefined();
    expect(pruneEdge.condition).toContain("true");
    expect(skipPruneEdge.condition).toContain("true");
  });

  it("installs and round-trips through engine", () => {
    const result = installTemplate("template-task-archiver", engine);
    expect(result.id).not.toBe("template-task-archiver");
    expect(result.metadata.installedFrom).toBe("template-task-archiver");
    const stored = engine.get(result.id);
    expect(stored).toBeDefined();
    expect(stored.name).toBe("Task Archiver");
    expect(stored.variables.ageHours).toBe(24);
  });

  it("installs with variable overrides", () => {
    const result = installTemplate("template-task-archiver", engine, {
      ageHours: 48,
      retentionDays: 30,
    });
    expect(result.variables.ageHours).toBe(48);
    expect(result.variables.retentionDays).toBe(30);
    expect(result.variables.pruneEnabled).toBe(true); // unchanged default
  });
});

describe("merge-before-push PR templates", () => {
  it("template-task-lifecycle enables merge-before-push conflict resolution", () => {
    const template = getTemplate("template-task-lifecycle");
    const pushNode = findNode(template, "push-branch");

    expect(pushNode).toBeDefined();
    expect(pushNode.config.mergeBaseBeforePush).toBe(true);
    expect(pushNode.config.autoResolveMergeConflicts).toBe(true);
    expect(pushNode.config.conflictResolverSdk).toBe("auto");
  });

  it("template-backend-agent gates PR creation on a successful conflict-aware push", () => {
    const template = getTemplate("template-backend-agent");
    const pushNode = findNode(template, "push-branch");
    const retryPushNode = findNode(template, "push-branch-retry");
    const pushOkNode = findNode(template, "push-ok");
    const retryPushOkNode = findNode(template, "push-ok-retry");

    expect(pushNode.config.mergeBaseBeforePush).toBe(true);
    expect(pushNode.config.autoResolveMergeConflicts).toBe(true);
    expect(pushNode.config.conflictResolverSdk).toBe("{{agentSdk}}");
    expect(retryPushNode.config.mergeBaseBeforePush).toBe(true);
    expect(retryPushNode.config.autoResolveMergeConflicts).toBe(true);
    expect(retryPushNode.config.conflictResolverSdk).toBe("{{agentSdk}}");
    expect(pushOkNode).toBeDefined();
    expect(retryPushOkNode).toBeDefined();
    expect(template.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "push-branch", target: "push-ok" }),
      expect.objectContaining({ source: "push-ok", target: "create-pr", sourcePort: "yes" }),
      expect.objectContaining({ source: "push-branch-retry", target: "push-ok-retry" }),
      expect.objectContaining({ source: "push-ok-retry", target: "create-pr-retry", sourcePort: "yes" }),
    ]));
  });

  it("validate-and-pr sub-workflow uses worktreePath and merge-before-push validation", () => {
    const pushNode = findNode(VALIDATE_AND_PR_SUB, "push");
    const pushOkNode = findNode(VALIDATE_AND_PR_SUB, "push-ok");

    expect(pushNode.config.worktreePath).toBe("{{worktreePath}}");
    expect(pushNode.config.baseBranch).toBe("{{baseBranch}}");
    expect(pushNode.config.mergeBaseBeforePush).toBe(true);
    expect(pushNode.config.autoResolveMergeConflicts).toBe(true);
    expect(pushOkNode).toBeDefined();
    expect(VALIDATE_AND_PR_SUB.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "push", target: "push-ok" }),
      expect.objectContaining({ source: "push-ok", target: "create-pr", sourcePort: "yes" }),
    ]));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  SDK Conflict Resolver Template
// ═══════════════════════════════════════════════════════════════════════════

describe("template-sdk-conflict-resolver", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("exists and has correct metadata", () => {
    const t = getTemplate("template-sdk-conflict-resolver");
    expect(t).toBeDefined();
    expect(t.name).toBe("SDK Conflict Resolver");
    expect(t.category).toBe("github");
    expect(t.enabled).toBe(true);
    expect(t.recommended).toBe(true);
  });

  it("uses event-based trigger for PR conflicts", () => {
    const t = getTemplate("template-sdk-conflict-resolver");
    expect(t.trigger).toBe("trigger.event");
    const triggerNode = t.nodes.find((n) => n.id === "trigger");
    expect(triggerNode).toBeDefined();
    expect(triggerNode.type).toBe("trigger.event");
    expect(triggerNode.config.eventType).toBe("pr.conflict_detected");
  });

  it("has cooldown and attempt-exhaustion guards before resolution", () => {
    const t = getTemplate("template-sdk-conflict-resolver");
    const nodeIds = t.nodes.map((n) => n.id);
    expect(nodeIds).toContain("check-cooldown");
    expect(nodeIds).toContain("check-attempts");
    expect(nodeIds).toContain("escalate-cooldown");
    expect(nodeIds).toContain("escalate-exhausted");

    // Cooldown → escalate path
    const cooldownEsc = t.edges.find(
      (e) => e.source === "check-cooldown" && e.target === "escalate-cooldown",
    );
    expect(cooldownEsc).toBeDefined();
  });

  it("classifies files into auto and manual categories", () => {
    const t = getTemplate("template-sdk-conflict-resolver");
    const classifyNode = t.nodes.find((n) => n.id === "classify-files");
    expect(classifyNode).toBeDefined();
    expect(classifyNode.type).toBe("action.set_variable");
    // Should reference known lock files
    const valueExpr = classifyNode.config.value;
    expect(valueExpr).toContain("pnpm-lock.yaml");
    expect(valueExpr).toContain("package-lock.json");
    expect(valueExpr).toContain("CHANGELOG.md");
  });

  it("splits into auto-only and manual+agent resolution paths", () => {
    const t = getTemplate("template-sdk-conflict-resolver");
    // has-manual → launch-agent (yes) or commit-auto-only (no)
    const agentPath = t.edges.find(
      (e) => e.source === "has-manual" && e.target === "launch-agent",
    );
    const autoOnlyPath = t.edges.find(
      (e) => e.source === "has-manual" && e.target === "commit-auto-only",
    );
    expect(agentPath).toBeDefined();
    expect(autoOnlyPath).toBeDefined();
  });

  it("verifies conflict markers after agent resolution", () => {
    const t = getTemplate("template-sdk-conflict-resolver");
    const verifyNode = t.nodes.find((n) => n.id === "verify-clean");
    expect(verifyNode).toBeDefined();
    expect(verifyNode.config.command).toContain("<<<<<<");

    const markersNode = t.nodes.find((n) => n.id === "markers-clean");
    expect(markersNode).toBeDefined();
    expect(markersNode.type).toBe("condition.expression");
    // markers-clean → push-result (clean) or escalate-markers (dirty)
    const pushEdge = t.edges.find(
      (e) => e.source === "markers-clean" && e.target === "push-result",
    );
    const escEdge = t.edges.find(
      (e) => e.source === "markers-clean" && e.target === "escalate-markers",
    );
    expect(pushEdge).toBeDefined();
    expect(escEdge).toBeDefined();
  });

  it("chains into PR Merge Strategy after successful push", () => {
    const t = getTemplate("template-sdk-conflict-resolver");
    const chainNode = t.nodes.find((n) => n.id === "chain-merge-strategy");
    expect(chainNode).toBeDefined();
    expect(chainNode.type).toBe("action.execute_workflow");
    expect(chainNode.config.workflowId).toBe("template-pr-merge-strategy");
    expect(chainNode.config.mode).toBe("dispatch");

    // push-result → chain-merge-strategy
    const chainEdge = t.edges.find(
      (e) => e.source === "push-result" && e.target === "chain-merge-strategy",
    );
    expect(chainEdge).toBeDefined();
  });

  it("has correct variables with safety defaults", () => {
    const t = getTemplate("template-sdk-conflict-resolver");
    expect(t.variables.timeoutMs).toBe(600000);
    expect(t.variables.cooldownMs).toBe(1800000);
    expect(t.variables.maxAttempts).toBe(4);
    expect(t.variables.baseBranch).toBe("main");
  });

  it("replaces sdk-conflict-resolver.mjs module functions", () => {
    const t = getTemplate("template-sdk-conflict-resolver");
    expect(t.metadata.replaces.module).toBe("sdk-conflict-resolver.mjs");
    expect(t.metadata.replaces.functions).toContain("resolveConflictsWithSDK");
    expect(t.metadata.replaces.functions).toContain("buildSDKConflictPrompt");
    expect(t.metadata.replaces.functions).toContain("isSDKResolutionOnCooldown");
    expect(t.metadata.replaces.functions).toContain("isSDKResolutionExhausted");
  });

  it("installs and round-trips through engine", () => {
    const result = installTemplate("template-sdk-conflict-resolver", engine);
    expect(result.metadata.installedFrom).toBe("template-sdk-conflict-resolver");
    const stored = engine.get(result.id);
    expect(stored.name).toBe("SDK Conflict Resolver");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Sync Engine Template
// ═══════════════════════════════════════════════════════════════════════════

describe("template-sync-engine", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("exists and has correct metadata", () => {
    const t = getTemplate("template-sync-engine");
    expect(t).toBeDefined();
    expect(t.name).toBe("Kanban Sync Engine");
    expect(t.category).toBe("reliability");
    expect(t.enabled).toBe(true);
    expect(t.recommended).toBe(true);
  });

  it("uses event-based trigger instead of interval timer", () => {
    const t = getTemplate("template-sync-engine");
    expect(t.trigger).toBe("trigger.event");
    const triggerNode = t.nodes.find((n) => n.id === "trigger");
    expect(triggerNode).toBeDefined();
    expect(triggerNode.type).toBe("trigger.event");
    expect(triggerNode.config.eventType).toBe("sync.requested");
  });

  it("has pull/push pipeline with failure tracking", () => {
    const t = getTemplate("template-sync-engine");
    const nodeIds = t.nodes.map((n) => n.id);
    expect(nodeIds).toContain("pull-external");
    expect(nodeIds).toContain("pull-ok");
    expect(nodeIds).toContain("push-internal");
    expect(nodeIds).toContain("push-ok");
    expect(nodeIds).toContain("count-failures");
    expect(nodeIds).toContain("should-alert");
    expect(nodeIds).toContain("alert-failures");
  });

  it("handles rate limiting with back-off", () => {
    const t = getTemplate("template-sync-engine");
    const rateLimitNode = t.nodes.find((n) => n.id === "check-rate-limit");
    expect(rateLimitNode).toBeDefined();
    expect(rateLimitNode.config.expression).toContain("rate.limit");
    expect(rateLimitNode.config.expression).toContain("429");

    const handleNode = t.nodes.find((n) => n.id === "handle-rate-limit");
    expect(handleNode).toBeDefined();
    expect(handleNode.type).toBe("action.handle_rate_limit");
  });

  it("alerts after configurable consecutive failure threshold", () => {
    const t = getTemplate("template-sync-engine");
    const shouldAlertNode = t.nodes.find((n) => n.id === "should-alert");
    expect(shouldAlertNode).toBeDefined();
    expect(shouldAlertNode.config.expression).toContain("failureAlertThreshold");

    const alertNode = t.nodes.find((n) => n.id === "alert-failures");
    expect(alertNode).toBeDefined();
    expect(alertNode.type).toBe("notify.telegram");
  });

  it("has correct variables with sensible defaults", () => {
    const t = getTemplate("template-sync-engine");
    expect(t.variables.syncPolicy).toBe("internal-primary");
    expect(t.variables.syncIntervalMs).toBe(60000);
    expect(t.variables.failureAlertThreshold).toBe(3);
    expect(t.variables.rateLimitAlertThreshold).toBe(3);
    expect(t.variables.backoffIntervalMs).toBe(300000);
    expect(t.variables.backoffThreshold).toBe(5);
  });

  it("replaces sync-engine.mjs module functions", () => {
    const t = getTemplate("template-sync-engine");
    expect(t.metadata.replaces.module).toBe("sync-engine.mjs");
    expect(t.metadata.replaces.functions).toContain("SyncEngine.pullFromExternal");
    expect(t.metadata.replaces.functions).toContain("SyncEngine.pushToExternal");
    expect(t.metadata.replaces.functions).toContain("SyncEngine.sync");
  });

  it("installs and round-trips through engine", () => {
    const result = installTemplate("template-sync-engine", engine);
    expect(result.metadata.installedFrom).toBe("template-sync-engine");
    const stored = engine.get(result.id);
    expect(stored.name).toBe("Kanban Sync Engine");
    expect(stored.variables.syncPolicy).toBe("internal-primary");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Task Orphan Worktree Recovery Template
// ═══════════════════════════════════════════════════════════════════════════

describe("template-task-orphan-worktree-recovery", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("exists and has workflow-owned replacement metadata", () => {
    const t = getTemplate("template-task-orphan-worktree-recovery");
    expect(t).toBeDefined();
    expect(t.name).toBe("Task Orphan Worktree Recovery");
    expect(t.category).toBe("reliability");
    expect(t.trigger).toBe("trigger.schedule");
    expect(t.metadata?.replaces?.module).toBe("task-executor.mjs");
    expect(t.metadata?.replaces?.functions).toContain("_recoverOrphanedWorktrees");
  });

  it("runs recovery command via tools/workflow-orphan-worktree-recovery.mjs", () => {
    const t = getTemplate("template-task-orphan-worktree-recovery");
    const recoverNode = t.nodes.find((n) => n.id === "recover");
    expect(recoverNode).toBeDefined();
    expect(recoverNode.type).toBe("action.run_command");
    expect(recoverNode.config.command).toContain("tools/workflow-orphan-worktree-recovery.mjs");
  });

  it("installs and round-trips through engine", () => {
    const result = installTemplate("template-task-orphan-worktree-recovery", engine);
    expect(result.metadata.installedFrom).toBe("template-task-orphan-worktree-recovery");
    const stored = engine.get(result.id);
    expect(stored.name).toBe("Task Orphan Worktree Recovery");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Workflow Chaining Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("workflow chaining", () => {
  it("Error Recovery chains to Task Repair Worktree on failed retry", () => {
    const t = getTemplate("template-error-recovery");
    expect(t).toBeDefined();

    const chainNode = t.nodes.find((n) => n.id === "chain-repair");
    expect(chainNode, "Error Recovery should have a chain-repair node").toBeDefined();
    expect(chainNode.type).toBe("action.execute_workflow");
    expect(chainNode.config.workflowId).toBe("template-task-repair-worktree");
    expect(chainNode.config.mode).toBe("dispatch");

    // Verify the chain node is connected in the graph
    const incomingEdge = t.edges.find((e) => e.target === "chain-repair");
    expect(incomingEdge, "chain-repair must have an incoming edge").toBeDefined();
    const outgoingEdge = t.edges.find((e) => e.source === "chain-repair");
    expect(outgoingEdge, "chain-repair must have an outgoing edge").toBeDefined();
  });

  it("Task Finalization Guard chains to Task Archiver on success", () => {
    const t = getTemplate("template-task-finalization-guard");
    expect(t).toBeDefined();

    const chainNode = t.nodes.find((n) => n.id === "chain-archiver");
    expect(chainNode, "Finalization Guard should have a chain-archiver node").toBeDefined();
    expect(chainNode.type).toBe("flow.universal");
    expect(chainNode.config.workflowId).toBe("template-task-archiver");
    expect(chainNode.config.mode).toBe("dispatch");

    // Verify connectivity
    const incomingEdge = t.edges.find((e) => e.target === "chain-archiver");
    expect(incomingEdge, "chain-archiver must have an incoming edge").toBeDefined();
  });

  it("Task Finalization Guard does not force todo when PR exists but worktree is missing", () => {
    const t = getTemplate("template-task-finalization-guard");
    expect(t).toBeDefined();

    const guardNode = t.nodes.find((n) => n.id === "has-pr-missing-context");
    expect(guardNode).toBeDefined();
    expect(guardNode.type).toBe("condition.expression");

    const routeToGuard = t.edges.find(
      (e) => e.source === "has-worktree" && e.target === "has-pr-missing-context",
    );
    expect(routeToGuard).toBeDefined();

    const skipRoute = t.edges.find(
      (e) => e.source === "has-pr-missing-context" && e.target === "notify-skip-missing-context",
    );
    expect(skipRoute).toBeDefined();

    const directTodoFromMissing = t.edges.find(
      (e) => e.source === "has-worktree" && e.target === "mark-todo-missing",
    );
    expect(directTodoFromMissing).toBeUndefined();
  });


  it("SDK Conflict Resolver chains to PR Merge Strategy after push", () => {
    const t = getTemplate("template-sdk-conflict-resolver");
    expect(t).toBeDefined();

    const chainNode = t.nodes.find((n) => n.id === "chain-merge-strategy");
    expect(chainNode).toBeDefined();
    expect(chainNode.type).toBe("action.execute_workflow");
    expect(chainNode.config.workflowId).toBe("template-pr-merge-strategy");

    // push-result → chain-merge-strategy → notify-resolved
    const pushToChain = t.edges.find(
      (e) => e.source === "push-result" && e.target === "chain-merge-strategy",
    );
    const chainToNotify = t.edges.find(
      (e) => e.source === "chain-merge-strategy" && e.target === "notify-resolved",
    );
    expect(pushToChain).toBeDefined();
    expect(chainToNotify).toBeDefined();
  });

  it("all chaining nodes reference templates that exist", () => {
    const allTemplateIds = new Set(WORKFLOW_TEMPLATES.map((t) => t.id));
    const chainingNodes = [];
    for (const t of WORKFLOW_TEMPLATES) {
      for (const n of t.nodes) {
        if (
          ["action.execute_workflow", "flow.universal"].includes(n.type)
          && n.config?.workflowId
        ) {
          chainingNodes.push({ templateId: t.id, nodeId: n.id, target: n.config.workflowId });
        }
      }
    }

    expect(chainingNodes.length).toBeGreaterThanOrEqual(3);
    for (const cn of chainingNodes) {
      // Skip variable-interpolated references like {{childWorkflowId}}
      if (cn.target.startsWith("{{")) continue;
      expect(
        allTemplateIds.has(cn.target),
        `${cn.templateId}/${cn.nodeId} chains to "${cn.target}" which is not a known template`,
      ).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Event-Driven Trigger Coverage
// ═══════════════════════════════════════════════════════════════════════════

describe("event-driven triggers", () => {
  it("new templates all use trigger.event instead of trigger.schedule", () => {
    const newTemplateIds = [
      "template-task-archiver",
      "template-sdk-conflict-resolver",
      "template-sync-engine",
    ];
    for (const id of newTemplateIds) {
      const t = getTemplate(id);
      expect(t.trigger, `${id} should use trigger.event`).toBe("trigger.event");
      const triggerNode = t.nodes.find((n) => n.type === "trigger.event");
      expect(triggerNode, `${id} should have a trigger.event node`).toBeDefined();
      expect(
        typeof triggerNode.config.eventType,
        `${id} trigger node should have eventType`,
      ).toBe("string");
    }
  });

  it("event types are unique across new templates", () => {
    const newTemplateIds = [
      "template-task-archiver",
      "template-sdk-conflict-resolver",
      "template-sync-engine",
    ];
    const eventTypes = newTemplateIds.map((id) => {
      const t = getTemplate(id);
      return t.nodes.find((n) => n.type === "trigger.event").config.eventType;
    });
    const unique = new Set(eventTypes);
    expect(unique.size).toBe(eventTypes.length);
  });
});
