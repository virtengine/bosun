import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("monitor workflow startup guards", () => {
  const monitorSource = readFileSync(resolve(process.cwd(), "infra/monitor.mjs"), "utf8");
  const maintenanceSource = readFileSync(resolve(process.cwd(), "infra/maintenance.mjs"), "utf8");
  const lifecycleTemplateSource = readFileSync(
    resolve(process.cwd(), "workflow-templates/task-lifecycle.mjs"),
    "utf8",
  );
  const workflowTemplatesSource = readFileSync(
    resolve(process.cwd(), "workflow/workflow-templates.mjs"),
    "utf8",
  );
  const buildReviewFixTaskHandoffFactory = (() => {
    const modes = {
      ACTIVE_SESSION_STEERING: "active_session_steering",
      REVIEW_REDISPATCH: "review_redispatch",
    };
    const states = {
      ACTIVE_SESSION_ATTACHED: "active_session_attached",
      SESSION_REBIND_REQUESTED: "session_rebind_requested",
    };
    const match = monitorSource.match(
      /function buildReviewFixTaskHandoff\(task, reason, extra = \{\}\) \{[\s\S]*?\n\}/,
    );
    if (!match) {
      throw new Error("buildReviewFixTaskHandoff source not found");
    }
    return new Function(
      "parsePositivePrNumber",
      "REVIEW_FIX_HANDOFF_MODES",
      "REVIEW_FIX_HANDOFF_STATES",
      `${match[0]}; return buildReviewFixTaskHandoff;`,
    )(
      (value) => {
        const parsed = Number(String(value || "").trim());
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      },
      modes,
      states,
    );
  })();

  it("initializes workflow automation before runtime subsystems in non-test mode", () => {
    expect(monitorSource).toContain("if (!isMonitorTestRuntime) {");
    expect(monitorSource).toContain("await ensureWorkflowAutomationEngine().catch(() => {});");
    expect(monitorSource).toContain("// ── Task Management Subsystem Initialization");
    expect(
      monitorSource.indexOf("await ensureWorkflowAutomationEngine().catch(() => {});"),
    ).toBeLessThan(
      monitorSource.indexOf("// ── Task Management Subsystem Initialization"),
    );
  });

  it("disables self-restart watcher by default for internal and hybrid executor modes", () => {
    expect(monitorSource).toContain("function isSelfRestartWatcherEnabled()");
    expect(monitorSource).toContain('toLowerCase() === "internal"');
    expect(monitorSource).toContain('toLowerCase() === "hybrid"');
    expect(monitorSource).toContain(
      "Auto self-restart from file churn causes unnecessary restart storms.",
    );
  });

  it("declares monitor-monitor runtime state before reload-time helpers use it", () => {
    expect(monitorSource).toContain("const monitorMonitor = {");
    expect(monitorSource).toContain("sdkFailures: new Map()");
    expect(monitorSource).toContain("function refreshMonitorMonitorRuntime()");
    expect(monitorSource).toContain("const previousMonitorRuntime = snapshotMonitorMonitorRuntime();");
    expect(
      monitorSource.indexOf("const monitorMonitor = {"),
    ).toBeLessThan(
      monitorSource.indexOf("function refreshMonitorMonitorRuntime()"),
    );
  });

  it("wires task-store start guards into workflow automation services", () => {
    expect(monitorSource).toContain("taskStore: {");
    expect(monitorSource).toContain("canStartTask,");
  });

  it("normalizes kanban createTask calls from both one-arg and two-arg adapters", () => {
    expect(monitorSource).toContain("createTask: async (projectIdOrTaskData = {}, taskDataArg = undefined) => {");
    expect(monitorSource).toContain("const invokedWithProjectId = typeof projectIdOrTaskData === \"string\";");
    expect(monitorSource).toContain(
      "(invokedWithProjectId ? projectIdOrTaskData : payload?.projectId) ||",
    );
  });

  it("auto-disables stale task-batch-pr workflows when workflowDefaults no longer request them", () => {
    expect(monitorSource).toContain('import("../workflow/workflow-templates.mjs")');
    expect(monitorSource).toContain('const staleWorkflowTemplateIds = ["template-task-batch-pr", "template-continuation-loop"]');
    expect(monitorSource).toContain("workflowTemplates.resolveWorkflowTemplateIds({");
    expect(monitorSource).toContain('resolveWorkflowTemplateConfig(config?.workflows || [])');
    expect(monitorSource).toContain('template-continuation-loop');
    expect(monitorSource).toContain("requestedTemplateIds.has(installedFrom)");
    expect(monitorSource).toContain("auto-disabled stale workflow");
  });

  it("forces agent session monitor template reconciliation on startup", () => {
    expect(monitorSource).toContain('forceUpdateTemplateIds: [');
    expect(monitorSource).toContain('"template-task-lifecycle"');
    expect(monitorSource).toContain('"template-bosun-pr-watchdog"');
    expect(monitorSource).toContain('"template-github-kanban-sync"');
    expect(monitorSource).toContain('"template-task-batch-processor"');
    expect(monitorSource).toContain('"template-agent-session-monitor"');
    expect(monitorSource).toContain("Number(reconcile?.autoUpdated || 0) > 0");
    expect(monitorSource).toContain("reconcile.updatedWorkflowIds.length > 0");
    expect(monitorSource).toContain('typeof engine.load === "function"');
    expect(monitorSource).toContain("engine.load();");
  });

  it("fails startup when startup-critical workflow mismatches survive reconciliation", () => {
    expect(monitorSource).toContain("Array.isArray(reconcile?.criticalRemaining) && reconcile.criticalRemaining.length > 0");
    expect(monitorSource).toContain("Startup-critical workflow template mismatch remains after reconcile");
    expect(monitorSource).toContain("issue?.code");
  });

  it("resumes interrupted workflow runs after monitor services are wired", () => {
    expect(monitorSource).toContain('runWorkflowRecoveryWithPolicy(');
    expect(monitorSource).toContain('"workflow-history-unstick"');
    expect(monitorSource).toContain("WORKFLOW_STARTUP_HISTORY_RECOVERY_DELAY_MS");
    expect(monitorSource).toContain("workflowStartupHistoryRecoveryDelayMs");
    expect(monitorSource).toContain('if (!engine?.resumeInterruptedRuns) {');
    expect(monitorSource).toContain('await engine.resumeInterruptedRuns();');
    expect(
      monitorSource.indexOf("bindWorkflowEngineToAnomalyDetector(engine);"),
    ).toBeLessThan(
      monitorSource.indexOf('await engine.resumeInterruptedRuns();'),
    );
  });

  it("stores workflow definitions and runs under the selected repoRoot", () => {
    expect(monitorSource).toContain('workflowDir: resolve(repoRoot, ".bosun", "workflows")');
    expect(monitorSource).toContain('runsDir: resolve(repoRoot, ".bosun", "workflow-runs")');
  });

  it("derives and exports a repo-scoped agent endpoint port before workflow task polling", () => {
    expect(monitorSource).toContain("function deriveRepoScopedAgentEndpointPort(repoRoot)");
    expect(monitorSource).toContain("function syncAgentEndpointPortEnv(port)");
    expect(monitorSource).toContain("const requestedAgentEndpointPort = resolveMonitorAgentEndpointPort(repoRoot);");
    expect(monitorSource).toContain("syncAgentEndpointPortEnv(agentEndpoint.getPort());");
    expect(
      monitorSource.indexOf("const requestedAgentEndpointPort = resolveMonitorAgentEndpointPort(repoRoot);"),
    ).toBeLessThan(
      monitorSource.indexOf("agentEndpoint = createAgentEndpoint({"),
    );
  });

  it("kicks schedule-driven workflow polling immediately when workflow lifecycle owns dispatch", () => {
    expect(monitorSource).toContain("let pollWorkflowSchedulesOnce = async () => {};");
    expect(
      monitorSource.indexOf("let pollWorkflowSchedulesOnce = async () => {}"),
    ).toBeLessThan(
      monitorSource.indexOf('"stale-dispatch-unstick"'),
    );
    expect(monitorSource).toContain('pollWorkflowSchedulesOnce = async function pollWorkflowSchedulesOnce(');
    expect(monitorSource).toContain('const includeTaskPoll = opts?.includeTaskPoll !== false;');
    expect(monitorSource).not.toContain('_lastRunAt: Date.now()');
    expect(monitorSource).toContain('triggerNode?.type === "trigger.task_available"');
    expect(monitorSource).toContain('triggerNode?.type === "trigger.task_low"');
    expect(monitorSource).toContain('"stale-dispatch-unstick"');
    expect(monitorSource).toContain('"stale-dispatch-task-poll-unstick"');
    expect(monitorSource).toContain('throwOnError: true');
    expect(monitorSource).toContain('requireEngine: true');
    const startupTaskPollHook = monitorSource.indexOf('"stale-dispatch-task-poll-unstick"');
    expect(startupTaskPollHook).toBeGreaterThan(-1);
    expect(
      monitorSource.indexOf('internalTaskExecutor.start();'),
    ).toBeLessThan(startupTaskPollHook);
    expect(monitorSource).toContain('scheduleStartupWorkflowRecovery(');
  });

  it("runs task recovery immediately after startup workflow cleanup when lifecycle is delegated", () => {
    expect(monitorSource).toContain("async function runWorkflowOwnedTaskRecoveryPass(source)");
    expect(monitorSource).toContain('await runWorkflowOwnedTaskRecoveryPass(');
    expect(monitorSource).toContain('"startup-workflow-history-unstick"');
    expect(monitorSource).toContain('"startup-stale-dispatch-task-poll-unstick"');
    expect(monitorSource).toContain(`await engine.resumeInterruptedRuns();
            await runWorkflowOwnedTaskRecoveryPass(
              "startup-workflow-history-unstick",`);
    expect(monitorSource).toContain(`throwOnError: true,
              });
              await runWorkflowOwnedTaskRecoveryPass(
                "startup-stale-dispatch-task-poll-unstick",`);
  });

  it("kicks non-task schedule polling during workflow automation startup", () => {
    expect(
      monitorSource.indexOf('await ensureWorkflowAutomationEngine().catch(() => {});'),
    ).toBeLessThan(
      monitorSource.indexOf('"stale-dispatch-unstick"'),
    );
  });

  it("defines bounded workflow recovery policy and structured telemetry", () => {
    expect(monitorSource).toContain("const DEFAULT_WORKFLOW_RECOVERY_POLICY = Object.freeze({");
    expect(monitorSource).toContain("function normalizeWorkflowRecoveryPolicy(candidate = {})");
    expect(monitorSource).toContain("applyWorkflowRecoveryPolicy(configWorkflowRecovery, \"startup-config\")");
    expect(monitorSource).toContain("applyWorkflowRecoveryPolicy(");
    expect(monitorSource).toContain("emitWorkflowRecoveryTelemetry(\"policy_updated\"");
    expect(monitorSource).toContain("emitWorkflowRecoveryTelemetry(\"attempt\"");
    expect(monitorSource).toContain("emitWorkflowRecoveryTelemetry(\"suppressed\"");
    expect(monitorSource).toContain("emitWorkflowRecoveryTelemetry(\"retry_scheduled\"");
    expect(monitorSource).toContain("emitWorkflowRecoveryTelemetry(\"escalated\"");
    expect(monitorSource).toContain("component: \"monitor.workflow-recovery\"");
  });

  it("runs workflow-history unstick through the same bounded self-healing policy", () => {
    expect(monitorSource).toContain('"workflow-history-unstick"');
    expect(monitorSource).toContain("engine?.resumeInterruptedRuns");
  });

  it("allows workflow automation init retries after transient startup failure", () => {
    expect(monitorSource).toContain("workflowAutomationInitDone = true;");
    expect(monitorSource).toContain("workflowAutomationInitDone = false;");
    const catchStart = monitorSource.indexOf("} catch (err) {");
    const finallyStart = monitorSource.indexOf("} finally {");
    const catchBlock = monitorSource.slice(catchStart, finallyStart);
    const finallyBlock = monitorSource.slice(finallyStart, finallyStart + 160);
    expect(catchBlock).toContain("workflowAutomationInitDone = false;");
    expect(finallyBlock).toContain("workflowAutomationInitPromise = null;");
    expect(finallyBlock).not.toContain("workflowAutomationInitDone = true;");
  });

  it("blocks workflow automation startup when Node child-process launch is unavailable", () => {
    expect(monitorSource).toContain("checkChildProcessLaunch,");
    expect(monitorSource).toContain("const childProcessCapability = checkChildProcessLaunch();");
    expect(monitorSource).toContain("workflow automation blocked: Node child-process launch unavailable");
    expect(
      monitorSource.indexOf("const childProcessCapability = checkChildProcessLaunch();"),
    ).toBeLessThan(
      monitorSource.indexOf("const [{ getWorkflowEngine }, { createTask, getTask }, wfNodes, workflowTemplates] = await Promise.all(["),
    );
  });

  it("defaults workflow automation to enabled when env is unset", () => {
    expect(monitorSource).toContain("process.env.WORKFLOW_AUTOMATION_ENABLED");
    expect(monitorSource).toContain("  true,");
  });

  it("requires npm start lifecycle for dev-mode self-restart watcher by default", () => {
    expect(monitorSource).toContain("process.env.npm_lifecycle_event");
    expect(monitorSource).toContain('npmLifecycleEvent === "start"');
    expect(monitorSource).toContain('npmLifecycleEvent.startsWith("start:")');
    expect(monitorSource).toContain(
      "CLI command mode in source checkout",
    );
  });

  it("repairs core.bare corruption against the bosun repo root", () => {
    expect(monitorSource).toContain('fixGitConfigCorruption(resolve(__dirname, ".."));');
    expect(monitorSource).not.toContain('fixGitConfigCorruption(resolve(__dirname, "..", ".."));');
    expect(maintenanceSource).toContain('const repoRoot = resolve(import.meta.dirname || ".", "..");');
    expect(maintenanceSource).not.toContain('const repoRoot = resolve(import.meta.dirname || ".", "..", "..");');
  });

  it("uses BOSUN_PROMPT_PLANNER path before workspace-root planner fallback", () => {
    expect(monitorSource).toContain("process.env.BOSUN_PROMPT_PLANNER");
    expect(monitorSource).toContain("BOSUN_PROMPT_PLANNER=");
  });

  it("screens planner prompt fallbacks with markdown safety auditing", () => {
    expect(monitorSource).toContain("function resolvePlannerPromptCandidate(");
    expect(monitorSource).toContain('channel: "planner-prompt"');
    expect(monitorSource).toContain("recordMarkdownSafetyAuditEvent(");
    expect(monitorSource).toContain("blocked unsafe planner prompt");
  });

  it("guards backend task-id resolution against unresolved template tokens", () => {
    expect(monitorSource).toContain("function hasUnresolvedTemplateToken(value)");
    expect(monitorSource).toContain("if (!rawId || hasUnresolvedTemplateToken(rawId)) return null;");
  });

  it("lets explicit review-agent env override workflow replacement", () => {
    expect(
      monitorSource.indexOf("const explicit = process.env.INTERNAL_EXECUTOR_REVIEW_AGENT_ENABLED;"),
    ).toBeLessThan(
      monitorSource.indexOf("if (isWorkflowReplacingModule(\"review-agent.mjs\")) return false;"),
    );
  });

  it("attempts branch-to-PR recovery before resetting stale inreview tasks during review-agent rehydrate", () => {
    expect(monitorSource).toContain("let existingPr = await findExistingPrForBranchInRepo(");
    expect(monitorSource).toContain("existingPr = await findExistingPrForBranchApiInRepo(");
    expect(monitorSource).toContain("updateInternalTask(taskId, {");
    expect(monitorSource).toContain("const hasReviewReference = Boolean(prUrl || prNumber);");
    expect(monitorSource).toContain(
      "review rehydrate redispatch ${taskId}: missing prUrl/prNumber",
    );
    expect(monitorSource).toContain("redispatchInReviewTask(task, \"review-agent-rehydrate\"");
    expect(monitorSource).toContain("dispatchFixTask: (taskId, issues) => {");
    expect(monitorSource).toContain("supervisor dispatch-fix: no active session");
    expect(monitorSource).toContain("review-fix-redispatch");
    expect(monitorSource).toContain("re-dispatching inreview session");
    expect(monitorSource).toContain("mode: REVIEW_FIX_HANDOFF_MODES.REVIEW_REDISPATCH");
    expect(monitorSource).toContain('taskPatch.status = "todo";');
    expect(monitorSource).toContain("taskPatch.sessionId = null;");
    expect(monitorSource).toContain("taskPatch.latestSessionId = null;");
    expect(monitorSource).toContain('taskStatus: workflowTask.status');
  });

  it("builds a redispatch handoff that clears stale session linkage and requests a new session", () => {
    const handoff = buildReviewFixTaskHandoffFactory(
      {
        id: "TASK-REDISPATCH-1",
        title: "Repair rejected review",
        status: "inreview",
        branchName: "task/rejected-review",
        prNumber: 321,
        prUrl: "https://github.com/virtengine/bosun/pull/321",
        reviewStatus: "changes_requested",
        sessionId: "session-stale-1",
        latestSessionId: "session-stale-1",
        meta: { keep: true },
      },
      "review-fix-redispatch",
      {
        mode: "review_redispatch",
        workflowEvent: "task.review_fix_requested",
        reviewIssues: [
          {
            severity: "major",
            category: "review",
            file: "src/app.ts",
            line: 42,
            description: "Address the rejected review comment",
          },
        ],
      },
    );

    expect(handoff.mode).toBe("review_redispatch");
    expect(handoff.taskPatch.status).toBe("todo");
    expect(handoff.taskPatch.sessionId).toBeNull();
    expect(handoff.taskPatch.latestSessionId).toBeNull();
    expect(handoff.taskPatch.branchName).toBe("task/rejected-review");
    expect(handoff.taskPatch.prNumber).toBe(321);
    expect(handoff.taskPatch.prUrl).toBe("https://github.com/virtengine/bosun/pull/321");
    expect(handoff.taskPatch.reviewIssues).toHaveLength(1);
    expect(handoff.taskPatch.reviewFixDispatchMode).toBe("review_redispatch");
    expect(handoff.taskPatch.reviewFixState).toBe("session_rebind_requested");
    expect(handoff.workflowPayload.taskStatus).toBe("todo");
    expect(handoff.workflowPayload.task.sessionId).toBeNull();
    expect(handoff.workflowPayload.task.latestSessionId).toBeNull();
    expect(handoff.workflowPayload.task.reviewIssues).toHaveLength(1);
    expect(handoff.workflowPayload.reviewFixDispatchMode).toBe("review_redispatch");
  });

  it("keeps inreview remediation on dedicated review-fix redispatch instead of task lifecycle polling", () => {
    expect(lifecycleTemplateSource).toContain('statuses: ["todo"]');
    expect(monitorSource).toContain("review-fix-redispatch");
    expect(monitorSource).toContain("re-dispatching inreview session");
  });

  it("forces deterministic lifecycle worktree recovery routing during startup reconciliation", () => {
    expect(monitorSource).toContain('"template-task-lifecycle"');
    expect(lifecycleTemplateSource).toContain("$ctx.getNodeOutput('acquire-worktree')?.retryable === true");
    expect(workflowTemplatesSource).toContain("hasDeterministicTaskLifecycleWorktreeRouting");
    expect(workflowTemplatesSource).toContain('edgeDef?.source || "").trim() === source');
    expect(workflowTemplatesSource).toContain('String(retryGate?.config?.expression || "").trim()');
    expect(workflowTemplatesSource).toContain('"wt-retry-eligible"');
    expect(workflowTemplatesSource).toContain('"recover-worktree"');
    expect(workflowTemplatesSource).toContain('"release-claim-wt-failed"');
  });

  it("resolves repo slug from task/PR context before flow-gate merge and review rehydrate", () => {
    expect(monitorSource).toContain("function resolveTaskRepoSlug(task, context = {})");
    expect(monitorSource).toContain("const resolvedRepoSlug = resolveTaskRepoSlug(task, context);");
    expect(monitorSource).toContain("if (resolvedRepoSlug) autoArgs.push(\"--repo\", resolvedRepoSlug);");
    expect(monitorSource).toContain("findExistingPrForBranchInRepo(");
    expect(monitorSource).toContain("findExistingPrForBranchApiInRepo(");
    expect(monitorSource).toContain("repoSlug: taskRepoSlug || undefined");
  });

  it("runs periodic merged-PR reconciliation for inreview tasks", () => {
    expect(monitorSource).toContain("async function checkMergedPRsAndUpdateTasks()");
    expect(monitorSource).toContain("workflowTaskReconcileInFlight");
    expect(monitorSource).toContain("[monitor] review reconcile: PR #");
    expect(monitorSource).toContain("safeSetInterval(\"workflow-review-merge-reconcile\"");
    expect(monitorSource).toContain("checkMergedPRsAndUpdateTasks();");
  });

  it("recovers merged PR tasks that were bounced back to todo/inprogress", () => {
    expect(monitorSource).toContain("const mergedRecoveryCandidates = [");
    expect(monitorSource).toContain("...(getInternalTasksByStatus(\"todo\") || []),");
    expect(monitorSource).toContain("...(getInternalTasksByStatus(\"inprogress\") || []),");
    expect(monitorSource).toContain("const allowsMergedRecovery =");
    expect(monitorSource).toContain("const allowsInreviewMergeCheck = taskStatus === \"inreview\"");
    expect(monitorSource).toContain("if (!approved && !allowsMergedRecovery && !allowsInreviewMergeCheck) continue;");
    expect(monitorSource).toContain("marking ${taskId} done${recoverySuffix}");
  });
});


describe("task-executor in-progress recovery owner_mismatch guards", () => {
  const executorSource = readFileSync(resolve(process.cwd(), "task/task-executor.mjs"), "utf8");
  const monitorSource = readFileSync(resolve(process.cwd(), "infra/monitor.mjs"), "utf8");

  it("skips resumable dispatch in workflow-owned mode when workflow liveness evidence exists", () => {
    // When workflowOwnsTaskLifecycle is true and either the workflow run
    // already exists, recent workflow-run detail proves the DAG is still live,
    // or the agent thread is still alive,
    // recovery must NOT add the task to resumable (which calls executeTask()
    // and fires task.assigned, launching a second competing workflow run).
    // Stale shared-state alone is only allowed to override a lingering thread
    // record; it must not override active workflow-run evidence.
    expect(executorSource).toContain("if (this.workflowOwnsTaskLifecycle) {");
    expect(executorSource).toContain("let recentWorkflowEvidence = this._resolveRecentWorkflowEvidence(");
    expect(executorSource).toContain("const hasWorkflowEvidence =");
    expect(executorSource).toContain("const hasWorkflowLiveness =");
    expect(executorSource).toContain("this._resolveRecentWorkflowEvidence(");
    expect(executorSource).toContain("activeWorkflowEvidenceByTaskId");
    expect(executorSource).toContain(
      "if (hasWorkflowEvidence) {",
    );
    expect(executorSource).toContain(
      "if (hasWorkflowLiveness) {",
    );
    // The skip branch must appear BEFORE the resumable.push call
    const wfGuardPos = executorSource.indexOf("if (this.workflowOwnsTaskLifecycle) {");
    const resumablePushPos = executorSource.indexOf("resumable.push({ ...task, id });");
    expect(wfGuardPos).toBeLessThan(resumablePushPos);
  });

  it("falls back to the workflow run index when task metadata has not yet recorded latestRunId", () => {
    expect(executorSource).toContain("_findRecentWorkflowEvidenceEntriesByTaskId(taskId)");
    expect(executorSource).toContain('const WORKFLOW_RUNS_HISTORY_INDEX = "index.json";');
    expect(executorSource).toContain("const indexPath = resolve(workflowRunsDir, WORKFLOW_RUNS_HISTORY_INDEX);");
    expect(executorSource).toContain("entry?.taskId ||");
  });

  it("resets ownerless workflow-owned tasks instead of skipping them on freshness alone", () => {
    // Fresh inprogress rows are only safe to keep when a workflow run, thread,
    // or shared-state owner still exists. Otherwise the task is stranded and
    // should be reset back to todo for clean re-dispatch.
    expect(executorSource).toContain("task-executor-recovery-missing-workflow-run");
    expect(executorSource).toContain("bypassWorkflowOwnership: true");
  });

  it("uses stale threshold of 600s so recovery interval cannot race heartbeat renewal", () => {
    // INPROGRESS_RECOVERY_INTERVAL_MS is 300s.  If SHARED_STATE_STALE_THRESHOLD_MS
    // were also 300s they could coincide.  600s ensures a generous buffer so a
    // workflow that misses one heartbeat renewal is not immediately evicted.
    expect(executorSource).toContain("600_000");
    const defaultPos = executorSource.indexOf("|| 600_000");
    const staleConstPos = executorSource.indexOf("SHARED_STATE_STALE_THRESHOLD_MS");
    expect(staleConstPos).toBeLessThan(defaultPos + 200);
  });

  it("skips owner_mismatch check against own instanceId so workflow-owned claims are also respected", () => {
    // The old guard `ownerId !== this._instanceId` caused workflow-owned tasks
    // (which use wf-<uuid> as ownerId) to always pass through to the re-dispatch
    // path when their heartbeat was stale.  The simplified guard accepts any
    // non-stale owner.
    expect(executorSource).not.toContain("ownerId !== this._instanceId");
  });

  it("lets recovery bypass workflow-owned transition delegation when the workflow itself is being repaired", () => {
    expect(monitorSource).toContain("if (payload.bypassWorkflowOwnership === true) {");
    expect(monitorSource).toContain("return updateTaskStatus(normalizedTaskId, normalizedStatus, {");
    expect(monitorSource).toContain("bypassWorkflowOwnership: true");
  });
});

describe("workflow-engine interrupted run deduplication", () => {
  const engineSource = readFileSync(
    resolve(process.cwd(), "workflow/workflow-engine.mjs"),
    "utf8",
  );

  it("deduplicates interrupted runs by taskId before resuming", () => {
    expect(engineSource).toContain("latestByTaskId");
    expect(engineSource).toContain("duplicate_task_run");
  });

  it("keeps only the most recent interrupted run per taskId (by startedAt)", () => {
    expect(engineSource).toContain("dedupedCount");
  });

  it("reads taskId from detail.data.taskId or detail.inputData.taskId", () => {
    expect(engineSource).toContain("this._resolveRunTaskIdentity(run, detail)?.taskId");
  });

  it("bounds orphan interrupted-run scans so archived run details do not stall startup", () => {
    expect(engineSource).toContain("WORKFLOW_INTERRUPTED_ORPHAN_SCAN_MAX_FILES");
    expect(engineSource).toContain("WORKFLOW_INTERRUPTED_ORPHAN_SCAN_WINDOW_MS");
    expect(engineSource).toContain("Orphan interrupted-run scan limited");
    expect(engineSource).toContain("this._getInterruptedOrphanRunCandidates()");
  });

  it("yields during interrupted-run resume scans so UI requests are not starved", () => {
    expect(engineSource).toContain("WORKFLOW_INTERRUPTED_RESUME_YIELD_EVERY");
    expect(engineSource).toContain("function maybeYieldInterruptedResumeWork(iteration)");
    expect(engineSource).toContain("await maybeYieldInterruptedResumeWork(resumeLoopCount);");
  });
});

describe("shared-state-manager registry repair", () => {
  const ssmSource = readFileSync(
    resolve(process.cwd(), "workspace/shared-state-manager.mjs"),
    "utf8",
  );

  it("repairs missing fields instead of wiping all claims on invalid structure", () => {
    expect(ssmSource).toContain("repaired");
  });

  it("no longer resets the entire registry for structural issues", () => {
    expect(ssmSource).not.toContain('"[SharedStateManager] Invalid registry structure, resetting"');
  });
});
