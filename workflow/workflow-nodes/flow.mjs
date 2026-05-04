/**
 * workflow-nodes.mjs — Built-in Workflow Node Types for Bosun
 *
 * Registers all standard node types that can be used in workflow definitions.
 * Node types are organized by category:
 *
 *   TRIGGERS    — Events that start workflow execution
 *   CONDITIONS  — Branching logic / gates
 *   ACTIONS     — Side-effect operations (run agent, create task, etc.)
 *   VALIDATION  — Verification gates (screenshots, tests, model review)
 *   TRANSFORM   — Data transformation / aggregation
 *   NOTIFY      — Notifications (telegram, log, etc.)
 *
 * Each node type must export:
 *   execute(node, ctx, engine) → Promise<any>   — The node's logic
 *   describe() → string                         — Human-readable description
 *   schema → object                             — JSON Schema for node config
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { execSync, execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { getAgentToolConfig, getEffectiveTools } from "../../agent/agent-tool-config.mjs";
import { getToolsPromptBlock } from "../../agent/agent-custom-tools.mjs";
import { buildRelevantSkillsPromptBlock, findRelevantSkills } from "../../agent/bosun-skills.mjs";
import { getSessionTracker } from "../../infra/session-tracker.mjs";
import { fixGitConfigCorruption } from "../../workspace/worktree-manager.mjs";
import { executeHarnessApprovalNode } from "../harness-approval-node.mjs";

import {
  registerNodeType,
  BOSUN_ATTACHED_PR_LABEL,
  PORTABLE_PRUNE_AND_COUNT_WORKTREES_COMMAND,
  PORTABLE_WORKTREE_COUNT_COMMAND,
  TAG,
  WORKFLOW_AGENT_EVENT_PREVIEW_LIMIT,
  WORKFLOW_AGENT_HEARTBEAT_MS,
  WORKFLOW_TELEGRAM_ICON_MAP,
  bindTaskContext,
  buildAgentEventPreview,
  buildAgentExecutionDigest,
  buildGitExecutionEnv,
  buildTaskContextBlock,
  buildWorkflowAgentToolContract,
  collectWakePhraseCandidates,
  condenseAgentItems,
  createKanbanTaskWithProject,
  decodeWorkflowUnicodeIconToken,
  deriveManagedWorktreeDirName,
  detectWakePhraseMatch,
  execGitArgsSync,
  extractStreamText,
  extractSymbolHint,
  formatAttachmentLine,
  formatCommentLine,
  getPathValue,
  isBosunStateComment,
  isManagedBosunWorktree,
  makeIsolatedGitEnv,
  normalizeLegacyWorkflowCommand,
  normalizeLineEndings,
  normalizeNarrativeText,
  normalizeTaskAttachments,
  normalizeTaskComments,
  normalizeWorkflowStack,
  normalizeWorkflowTelegramText,
  parseBooleanSetting,
  parsePathListingLine,
  resolveGitCandidates,
  resolveWorkflowNodeValue,
  simplifyPathLabel,
  summarizeAgentStreamEvent,
  summarizeAssistantMessageData,
  summarizeAssistantUsage,
  summarizePathListingBlock,
  trimLogText,
} from "./definitions.mjs";

function createManagedTimeout(callback, ms) {
  let timer = null;
  return {
    promise: new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        try {
          resolve(callback());
        } catch (error) {
          reject(error);
        }
      }, ms);
      if (timer?.unref) timer.unref();
    }),
    clear() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

function buildFlowChildInput(ctx, workflowId, data = {}) {
  const sourceData = ctx?.data && typeof ctx.data === "object" ? ctx.data : {};
  const parentWorkflowId = String(sourceData._workflowId || "").trim();
  const workflowStack = normalizeWorkflowStack(sourceData._workflowStack);
  if (parentWorkflowId && workflowStack[workflowStack.length - 1] !== parentWorkflowId) {
    workflowStack.push(parentWorkflowId);
  }
  const rootRunId = String(sourceData._workflowRootRunId || sourceData._rootRunId || ctx?.id || "").trim() || ctx?.id || null;
  const parentSessionId = String(
    sourceData._workflowSessionId ||
    sourceData._workflowParentSessionId ||
    sourceData.sessionId ||
    sourceData.taskId ||
    "",
  ).trim() || null;
  const rootSessionId = String(
    sourceData._workflowRootSessionId ||
    parentSessionId ||
    sourceData.taskId ||
    "",
  ).trim() || parentSessionId;
  return {
    ...data,
    _parentWorkflowId: parentWorkflowId || null,
    _workflowParentRunId: ctx?.id || null,
    _workflowRootRunId: rootRunId,
    _workflowParentSessionId: parentSessionId,
    _workflowRootSessionId: rootSessionId,
    _workflowDelegationDepth: Number(sourceData._workflowDelegationDepth || 0) + 1,
    _workflowStack: [...workflowStack, workflowId],
  };
}

function buildFlowChildRunOptions(ctx) {
  const sourceData = ctx?.data && typeof ctx.data === "object" ? ctx.data : {};
  return {
    _parentRunId: ctx?.id || null,
    _rootRunId: String(sourceData._workflowRootRunId || sourceData._rootRunId || ctx?.id || "").trim() || ctx?.id || null,
  };
}

registerNodeType("flow.try_catch", {
  describe: () => "Error boundary — execute a sub-workflow and catch failures gracefully",
  schema: {
    type: "object",
    properties: {
      tryWorkflowId: { type: "string", description: "Workflow ID to execute in the 'try' block" },
      catchWorkflowId: { type: "string", description: "Optional workflow ID to execute on error" },
      finallyWorkflowId: { type: "string", description: "Optional workflow ID to always execute after try/catch" },
      tryNodes: { type: "array", items: { type: "string" }, description: "Reserved alternate try-block node IDs" },
      errorVariable: { type: "string", default: "$error", description: "Variable name to store the caught error object" },
      propagateError: { type: "boolean", default: false, description: "Re-throw after catch/finally when true" },
      maxRetries: { type: "number", default: 0, description: "Retry the try block up to N additional times" },
      retryDelayMs: { type: "number", default: 1000, description: "Delay between retries in ms" },
    },
  },
  async execute(node, ctx, engine) {
    const tryWorkflowId = String(ctx.resolve(node.config?.tryWorkflowId || "") || "").trim();
    const catchWorkflowId = String(ctx.resolve(node.config?.catchWorkflowId || "") || "").trim();
    const finallyWorkflowId = String(ctx.resolve(node.config?.finallyWorkflowId || "") || "").trim();
    const errorVariable = node.config?.errorVariable || "$error";
    const propagateError = node.config?.propagateError === true;
    const maxRetries = Math.max(0, Math.min(10, Number(node.config?.maxRetries || 0) || 0));
    const retryDelayMs = Math.max(0, Number(node.config?.retryDelayMs || 1000) || 1000);

    let tryResult = null;
    let caughtError = null;
    let catchResult = null;
    let finallyResult = null;
    let attempts = 0;

    if (tryWorkflowId && engine?.execute) {
      const attemptLimit = 1 + maxRetries;
      while (attempts < attemptLimit) {
        attempts += 1;
        try {
          ctx.log(node.id, `try: executing workflow "${tryWorkflowId}" (attempt ${attempts}/${attemptLimit})`);
          const runCtx = await engine.execute(
            tryWorkflowId,
            buildFlowChildInput(ctx, tryWorkflowId, { ...ctx.data }),
            buildFlowChildRunOptions(ctx),
          );
          const hasErrors = Array.isArray(runCtx?.errors) && runCtx.errors.length > 0;
          if (hasErrors) {
            const message = runCtx.errors.map((entry) => entry?.error || entry?.message || String(entry)).join("; ");
            throw new Error(message);
          }
          tryResult = { success: true, runId: runCtx?.id || null, attempt: attempts };
          caughtError = null;
          break;
        } catch (error) {
          caughtError = error;
          if (attempts < attemptLimit) {
            ctx.log(node.id, `try: attempt ${attempts} failed, retrying in ${retryDelayMs}ms…`);
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          }
        }
      }
    } else if (!tryWorkflowId) {
      tryResult = { success: true, passthrough: true };
    } else {
      tryResult = { success: true, noEngine: true };
    }

    if (caughtError) {
      ctx.log(node.id, `catch: error from try block — ${caughtError.message}`);
      const errorObject = {
        message: caughtError.message,
        name: caughtError.name || "Error",
        stack: caughtError.stack || null,
        attempt: attempts,
      };
      ctx.data[errorVariable] = errorObject;
      tryResult = { success: false, error: errorObject.message, attempt: attempts };

      if (catchWorkflowId && engine?.execute) {
        try {
          ctx.log(node.id, `catch: executing workflow "${catchWorkflowId}"`);
          const catchCtx = await engine.execute(
            catchWorkflowId,
            buildFlowChildInput(ctx, catchWorkflowId, { ...ctx.data, [errorVariable]: errorObject }),
            buildFlowChildRunOptions(ctx),
          );
          catchResult = { executed: true, runId: catchCtx?.id || null };
        } catch (error) {
          catchResult = { executed: true, error: error?.message || String(error) };
          ctx.log(node.id, `catch workflow also failed: ${catchResult.error}`, "warn");
        }
      }
    }

    if (finallyWorkflowId && engine?.execute) {
      try {
        ctx.log(node.id, `finally: executing workflow "${finallyWorkflowId}"`);
        const finallyCtx = await engine.execute(
          finallyWorkflowId,
          buildFlowChildInput(ctx, finallyWorkflowId, { ...ctx.data }),
          buildFlowChildRunOptions(ctx),
        );
        finallyResult = { executed: true, runId: finallyCtx?.id || null };
      } catch (error) {
        finallyResult = { executed: true, error: error?.message || String(error) };
        ctx.log(node.id, `finally workflow failed: ${finallyResult.error}`, "warn");
      }
    }

    if (caughtError && propagateError) {
      throw caughtError;
    }

    return {
      tryResult,
      catchResult,
      finallyResult,
      hadError: Boolean(caughtError),
      errorMessage: caughtError?.message || null,
      attempts,
    };
  },
});

registerNodeType("flow.gate", {
  describe: () => "Pause workflow execution until a condition is met or manual approval is given",
  schema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["manual", "condition", "timeout"],
        default: "condition",
        description: "Gate mode: manual (requires approval), condition (auto-check expression), timeout (wait then proceed)",
      },
      condition: { type: "string", description: "JS expression that must return true to open gate (condition mode)" },
      timeoutMs: { type: "number", default: 300000, description: "Max wait time before gate auto-opens or fails (ms)" },
      onTimeout: { type: "string", enum: ["proceed", "fail"], default: "proceed", description: "Action when timeout is reached" },
      pollIntervalMs: { type: "number", default: 5000, description: "How often to re-evaluate the condition (ms)" },
      reason: { type: "string", description: "Human-readable description of what this gate is waiting for" },
    },
  },
  async execute(node, ctx, engine) {
    return executeHarnessApprovalNode(node, ctx, engine);
  },
});

registerNodeType("flow.join", {
  describe: () => "Explicitly join multiple branches before continuing",
  schema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["all", "any", "quorum"],
        default: "all",
        description: "Join condition. 'all' waits for all listed sources, 'any' waits for one, 'quorum' waits for N",
      },
      sourceNodeIds: {
        type: "array",
        items: { type: "string" },
        description: "Optional explicit source node IDs to evaluate at join time",
      },
      quorum: {
        type: "number",
        description: "Required count when mode='quorum'",
      },
      includeSkipped: {
        type: "boolean",
        default: true,
        description: "Whether skipped sources count as arrived",
      },
      failOnUnmet: {
        type: "boolean",
        default: false,
        description: "Throw when join criteria are not met",
      },
    },
  },
  async execute(node, ctx) {
    const mode = String(ctx.resolve(node.config?.mode || "all") || "all").toLowerCase();
    const includeSkipped = parseBooleanSetting(
      resolveWorkflowNodeValue(node.config?.includeSkipped ?? true, ctx),
      true,
    );
    const failOnUnmet = parseBooleanSetting(
      resolveWorkflowNodeValue(node.config?.failOnUnmet ?? false, ctx),
      false,
    );

    const configuredSourceIds = Array.isArray(node.config?.sourceNodeIds)
      ? node.config.sourceNodeIds
      : [];
    const sourceNodeIds = configuredSourceIds
      .map((value) => String(resolveWorkflowNodeValue(value, ctx) || "").trim())
      .filter(Boolean);

    const statuses = sourceNodeIds.map((sourceNodeId) => {
      const status = typeof ctx.getNodeStatus === "function"
        ? String(ctx.getNodeStatus(sourceNodeId) || "pending").toLowerCase()
        : "pending";
      return { sourceNodeId, status };
    });

    const arrivedStates = includeSkipped
      ? new Set(["completed", "failed", "skipped"])
      : new Set(["completed", "failed"]);
    const arrived = statuses.filter((entry) => arrivedStates.has(entry.status));
    const pendingSources = statuses
      .filter((entry) => !arrivedStates.has(entry.status))
      .map((entry) => entry.sourceNodeId);

    const resolvedQuorumRaw = Number(ctx.resolve(node.config?.quorum ?? 0));
    const resolvedQuorum = Number.isFinite(resolvedQuorumRaw)
      ? Math.max(1, Math.trunc(resolvedQuorumRaw))
      : Math.max(1, sourceNodeIds.length || 1);

    let joined = true;
    if (sourceNodeIds.length > 0) {
      if (mode === "any") {
        joined = arrived.length > 0;
      } else if (mode === "quorum") {
        joined = arrived.length >= Math.min(resolvedQuorum, sourceNodeIds.length);
      } else {
        joined = pendingSources.length === 0;
      }
    }

    if (!joined && failOnUnmet) {
      throw new Error(
        `Join criteria not met for node ${node.id}: mode=${mode}, pending=${pendingSources.join(",") || "none"}`,
      );
    }

    return {
      joined,
      mode,
      sourceCount: sourceNodeIds.length,
      arrivedCount: arrived.length,
      pendingSources,
      quorum: mode === "quorum" ? resolvedQuorum : undefined,
      includeSkipped,
    };
  },
});

registerNodeType("flow.end", {
  describe: () => "End the workflow immediately with explicit terminal status",
  schema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["completed", "failed"],
        default: "completed",
      },
      message: { type: "string", description: "Terminal reason or summary" },
      output: {
        description: "Optional structured output persisted on workflow terminal metadata",
      },
    },
  },
  async execute(node, ctx) {
    const rawStatus = String(ctx.resolve(node.config?.status || "completed") || "completed")
      .trim()
      .toLowerCase();
    const status = rawStatus === "failed" ? "failed" : "completed";
    const message = String(ctx.resolve(node.config?.message || "") || "").trim();
    const output = resolveWorkflowNodeValue(node.config?.output, ctx);

    if (message) {
      const level = status === "failed" ? "warn" : "info";
      ctx.log(node.id, `Workflow end requested (${status}): ${message}`, level);
    }

    return {
      _workflowEnd: true,
      status,
      message,
      output,
      nodeId: node.id,
      timestamp: Date.now(),
    };
  },
});

const UNIVERSAL_FLOW_NODE = {
  describe: () => "Run a universal reusable subworkflow (alias of execute-workflow pattern)",
  schema: {
    type: "object",
    properties: {
      workflowId: { type: "string", description: "Shared subworkflow to run" },
      mode: { type: "string", enum: ["sync", "dispatch"], default: "sync" },
      input: { type: "object", additionalProperties: true },
      inheritContext: { type: "boolean", default: true },
      outputVariable: { type: "string" },
      allowRecursive: { type: "boolean", default: false },
    },
    required: ["workflowId"],
  },
  async execute(node, ctx, engine) {
    const workflowId = String(ctx.resolve(node.config?.workflowId || "") || "").trim();
    const mode = String(ctx.resolve(node.config?.mode || "sync") || "sync")
      .trim()
      .toLowerCase();
    const outputVariable = String(ctx.resolve(node.config?.outputVariable || "") || "").trim();
    const inheritContext = parseBooleanSetting(
      resolveWorkflowNodeValue(node.config?.inheritContext ?? true, ctx),
      true,
    );
    const allowRecursive = parseBooleanSetting(
      resolveWorkflowNodeValue(node.config?.allowRecursive ?? false, ctx),
      false,
    );

    if (!workflowId) {
      throw new Error("flow.universal: 'workflowId' is required");
    }
    if (!engine || typeof engine.execute !== "function") {
      throw new Error("flow.universal: workflow engine is not available");
    }
    if (mode !== "sync" && mode !== "dispatch") {
      throw new Error(`flow.universal: invalid mode \"${mode}\"`);
    }

    const resolvedInputConfig = resolveWorkflowNodeValue(node.config?.input ?? {}, ctx);
    if (
      resolvedInputConfig != null &&
      (typeof resolvedInputConfig !== "object" || Array.isArray(resolvedInputConfig))
    ) {
      throw new Error("flow.universal: 'input' must resolve to an object");
    }
    const configuredInput = resolvedInputConfig && typeof resolvedInputConfig === "object"
      ? resolvedInputConfig
      : {};

    const sourceData = ctx.data && typeof ctx.data === "object" ? ctx.data : {};
    const inheritedInput = inheritContext ? { ...sourceData } : {};

    const parentWorkflowId = String(ctx.data?._workflowId || "").trim();
    const workflowStack = normalizeWorkflowStack(ctx.data?._workflowStack);
    if (parentWorkflowId && workflowStack[workflowStack.length - 1] !== parentWorkflowId) {
      workflowStack.push(parentWorkflowId);
    }
    if (!allowRecursive && workflowStack.includes(workflowId)) {
      const cyclePath = [...workflowStack, workflowId].join(" -> ");
      throw new Error(
        `flow.universal: recursive workflow call blocked (${cyclePath}). Set allowRecursive=true to override.`,
      );
    }

    const childInput = buildFlowChildInput(ctx, workflowId, {
      ...inheritedInput,
      ...configuredInput,
    });
    const trackerTaskId = String(sourceData.taskId || sourceData.task?.id || "").trim();
    const trackerTaskTitle = String(sourceData.taskTitle || sourceData.task?.title || trackerTaskId).trim();
    const tracker = trackerTaskId ? getSessionTracker() : null;
    if (tracker && trackerTaskId) {
      if (!tracker.getSessionById(trackerTaskId)) {
        tracker.createSession({
          id: trackerTaskId,
          type: "task",
          taskId: trackerTaskId,
          metadata: {
            title: trackerTaskTitle || trackerTaskId,
            workspaceId: String(sourceData.workspaceId || sourceData.activeWorkspace || "").trim() || undefined,
            workspaceDir: String(sourceData.worktreePath || sourceData.repoRoot || process.cwd()).trim() || undefined,
            branch: String(sourceData.branch || sourceData.task?.branchName || "").trim() || undefined,
          },
        });
      } else {
        tracker.updateSessionStatus(trackerTaskId, "active");
      }
      tracker.recordEvent(trackerTaskId, {
        role: "system",
        type: "system",
        content: `${mode === "dispatch" ? "Dispatching" : "Executing"} universal workflow \"${workflowId}\"`,
        timestamp: new Date().toISOString(),
        _sessionType: "task",
      });
    }

    if (mode === "dispatch") {
      ctx.log(node.id, `Dispatching universal workflow \"${workflowId}\"`);
      let dispatched;
      try {
        dispatched = Promise.resolve(engine.execute(
          workflowId,
          childInput,
          buildFlowChildRunOptions(ctx),
        ));
      } catch (err) {
        dispatched = Promise.reject(err);
      }
      dispatched
        .then((childCtx) => {
          const status = childCtx?.errors?.length ? "failed" : "completed";
          ctx.log(node.id, `Dispatched universal workflow \"${workflowId}\" finished with status=${status}`);
          if (tracker && trackerTaskId) {
            tracker.recordEvent(trackerTaskId, {
              role: status === "completed" ? "assistant" : "system",
              type: status === "completed" ? "agent_message" : "error",
              content: `Universal workflow \"${workflowId}\" finished with status=${status}`,
              timestamp: new Date().toISOString(),
              _sessionType: "task",
            });
            tracker.endSession(trackerTaskId, status);
          }
        })
        .catch((err) => {
          ctx.log(node.id, `Dispatched universal workflow \"${workflowId}\" failed: ${err.message}`, "error");
          if (tracker && trackerTaskId) {
            tracker.recordEvent(trackerTaskId, {
              role: "system",
              type: "error",
              content: `Universal workflow \"${workflowId}\" failed: ${err?.message || err}`,
              timestamp: new Date().toISOString(),
              _sessionType: "task",
            });
            tracker.endSession(trackerTaskId, "failed");
          }
        });

      const output = {
        success: true,
        queued: true,
        mode: "dispatch",
        workflowId,
        parentRunId: ctx.id,
      };
      if (outputVariable) ctx.data[outputVariable] = output;
      return output;
    }

    ctx.log(node.id, `Executing universal workflow \"${workflowId}\" (sync)`);
    const childCtx = await engine.execute(workflowId, childInput, buildFlowChildRunOptions(ctx));
    const errorCount = Array.isArray(childCtx?.errors) ? childCtx.errors.length : 0;
    const terminalMessage = String(childCtx?.data?._workflowTerminalMessage || "").trim() || null;
    const terminalOutput = childCtx?.data?._workflowTerminalOutput ?? null;
    const output = {
      success: errorCount === 0,
      queued: false,
      mode: "sync",
      workflowId,
      runId: childCtx?.id || null,
      status: errorCount > 0 ? "failed" : "completed",
      errorCount,
      message: terminalMessage,
      output: terminalOutput,
    };
    if (tracker && trackerTaskId) {
      const statusText = output.status || (output.success ? "completed" : "failed");
      tracker.recordEvent(trackerTaskId, {
        role: output.success ? "assistant" : "system",
        type: output.success ? "agent_message" : "error",
        content: `Universal workflow \"${workflowId}\" finished with status=${statusText}`,
        timestamp: new Date().toISOString(),
        _sessionType: "task",
      });
      tracker.endSession(trackerTaskId, statusText);
    }
    if (outputVariable) ctx.data[outputVariable] = output;
    return output;
  },
};

registerNodeType("flow.universal", UNIVERSAL_FLOW_NODE);

registerNodeType("flow.universial", UNIVERSAL_FLOW_NODE);

registerNodeType("flow.parallel", {
  describe: () => "Execute multiple named branches (sub-workflows) simultaneously and collect all results",
  schema: {
    type: "object",
    properties: {
      branches: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Branch label (used as key in results)" },
            workflowId: { type: "string", description: "Workflow ID to execute for this branch" },
            data: { type: "object", description: "Optional data overrides for this branch" },
          },
          required: ["name", "workflowId"],
        },
        description: "List of branches to execute in parallel",
      },
      failStrategy: {
        type: "string",
        enum: ["all-settled", "fail-fast"],
        default: "all-settled",
        description: "'all-settled' waits for every branch; 'fail-fast' aborts remaining on first failure",
      },
      timeoutMs: {
        type: "number",
        default: 300000,
        description: "Maximum time to wait for all branches (ms)",
      },
    },
    required: ["branches"],
  },
  async execute(node, ctx, engine) {
    const branches = Array.isArray(node.config?.branches) ? node.config.branches : [];
    const strategy = node.config?.failStrategy || "all-settled";
    const timeoutMs = node.config?.timeoutMs || 300000;

    if (branches.length === 0) {
      return { branches: [], results: {}, successCount: 0, failCount: 0 };
    }
    if (!engine?.execute) {
      throw new Error("flow.parallel requires an engine with sub-workflow execution support");
    }

    ctx.log(node.id, `parallel: launching ${branches.length} branches (${strategy})`);

    const makeBranchPromise = (branch) => {
      const workflowId = ctx.resolve(branch.workflowId || "");
      if (!workflowId) {
        return Promise.resolve({ name: branch.name, success: false, error: "Missing workflowId" });
      }
      const branchData = buildFlowChildInput(ctx, workflowId, {
        ...ctx.data,
        ...(branch.data || {}),
        _parallelBranch: branch.name,
      });
      return engine.execute(
        workflowId,
        branchData,
        buildFlowChildRunOptions(ctx),
      ).then(
        (runCtx) => {
          const hasErrors = Array.isArray(runCtx?.errors) && runCtx.errors.length > 0;
          return {
            name: branch.name,
            success: !hasErrors,
            runId: runCtx?.id || null,
            error: hasErrors ? runCtx.errors[0]?.error : null,
          };
        },
        (error) => ({
          name: branch.name,
          success: false,
          runId: null,
          error: error?.message || String(error),
        }),
      );
    };

    let branchResults;
    if (strategy === "fail-fast") {
      const timeoutControl = createManagedTimeout(() => {
        throw new Error(`Parallel branches timed out after ${timeoutMs}ms`);
      }, timeoutMs);
      try {
        branchResults = await Promise.race([
          Promise.all(branches.map((branch) => makeBranchPromise(branch).then((result) => {
            if (!result.success) throw Object.assign(new Error(result.error || "Branch failed"), { branchName: result.name });
            return result;
          }))),
          timeoutControl.promise,
        ]);
      } catch (error) {
        branchResults = [{ name: error.branchName || "unknown", success: false, error: error.message }];
      } finally {
        timeoutControl.clear();
      }
    } else {
      const timeoutControl = createManagedTimeout(() => "__timeout__", timeoutMs);
      const allSettledPromise = Promise.allSettled(branches.map(makeBranchPromise)).then((settled) =>
        settled.map((entry, index) =>
          entry.status === "fulfilled"
            ? entry.value
            : { name: branches[index]?.name || `branch-${index}`, success: false, error: entry.reason?.message || String(entry.reason) },
        ),
      );
      try {
        const winner = await Promise.race([allSettledPromise, timeoutControl.promise]);
        if (winner === "__timeout__") {
          branchResults = branches.map((branch) => ({ name: branch.name, success: false, error: "Timed out" }));
        } else {
          branchResults = winner;
        }
      } finally {
        timeoutControl.clear();
      }
    }

    const results = {};
    for (const result of branchResults) {
      results[result.name] = result;
    }
    const successCount = branchResults.filter((result) => result.success).length;
    const failCount = branchResults.length - successCount;
    ctx.log(node.id, `parallel: ${successCount}/${branchResults.length} branches succeeded`);

    return {
      branches: branchResults.map((result) => result.name),
      results,
      successCount,
      failCount,
      totalBranches: branches.length,
    };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
//  LOOP / ITERATION
// ═══════════════════════════════════════════════════════════════════════════

