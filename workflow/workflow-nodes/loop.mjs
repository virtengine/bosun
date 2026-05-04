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

function clearInheritedTaskIdentity(data) {
  if (!data || typeof data !== "object") return;
  for (const key of [
    "taskId",
    "activeTaskId",
    "taskTitle",
    "task",
    "taskInfo",
    "taskDetail",
    "taskDescription",
    "branch",
    "branchName",
    "baseBranch",
    "_workflowRootTaskId",
    "_workflowParentTaskId",
    "_workflowRootSessionId",
    "_workflowParentSessionId",
  ]) {
    delete data[key];
  }
}

function resolveDispatchLaunchPlan(engine, workflowId, fallbackWindow) {
  const normalizedFallback = Math.max(1, Number(fallbackWindow) || 1);
  if (!engine || typeof engine.get !== "function") {
    return { windowSize: normalizedFallback, slotLimit: null };
  }
  const workflow = engine.get(workflowId);
  if (!workflow || !Array.isArray(workflow.nodes)) {
    return { windowSize: normalizedFallback, slotLimit: null };
  }

  const slotLimits = workflow.nodes
    .filter((candidate) => candidate && typeof candidate === "object")
    .filter((candidate) => candidate.type === "condition.slot_available" || candidate.type === "trigger.task_available")
    .map((candidate) => Number(candidate?.config?.maxParallel))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.max(1, Math.trunc(value)));

  if (slotLimits.length === 0) {
    return { windowSize: normalizedFallback, slotLimit: null };
  }

  const slotLimit = Math.max(1, Math.min(...slotLimits));
  return {
    windowSize: Math.max(1, Math.min(normalizedFallback, slotLimit)),
    slotLimit,
  };
}

async function waitForVisibleTaskLifecycleSlots(engine, minimumActiveSlots, maxWaitMs = 100) {
  void engine;
  void minimumActiveSlots;
  void maxWaitMs;
}

registerNodeType("loop.for_each", {
  describe: () =>
    "Iterate over an array, executing a sub-workflow for each item. " +
    "Supports parallel fan-out via maxConcurrent and provides per-item " +
    "context injection under the configured variable name.",
  schema: {
    type: "object",
    properties: {
      items: { type: "string", description: "Expression that resolves to an array" },
      variable: { type: "string", default: "item", description: "Variable name for current item" },
      indexVariable: { type: "string", default: "index", description: "Variable name for current index" },
      maxIterations: { type: "number", default: 50, description: "Cap on total iterations" },
      maxConcurrent: { type: "number", default: 1, description: "Parallel fan-out width (1 = sequential)" },
      workflowId: { type: "string", description: "Sub-workflow to execute for each item (optional)" },
    },
    required: ["items"],
  },
  async execute(node, ctx, engine) {
    const rawExpr = node.config?.items || "[]";
    // Strip trailing semicolons — the expression is wrapped in return(expr)
    // so a stray ";" after an IIFE "})();" causes "Unexpected token ';'"
    const expr = rawExpr.replace(/;\s*$/, "");
    let items;
    try {
      const fn = new Function("$data", "$ctx", `return (${expr});`);
      items = fn(ctx.data, ctx);
    } catch (evalErr) {
      ctx.log(node.id, `[loop] items expression eval error: ${evalErr?.message || evalErr} — expr snippet: ${expr.slice(0, 120)}`);
      items = [];
    }
    if (!Array.isArray(items)) {
      ctx.log(node.id, `[loop] items is not array (type=${typeof items}), wrapping: ${JSON.stringify(items)?.slice(0, 200)}`);
      items = [items];
    }
    if (items.length === 0) {
      ctx.log(node.id, `[loop] items resolved to empty array — expression: ${expr.slice(0, 200)}`);
    }
    const max = node.config?.maxIterations || 50;
    items = items.slice(0, max);
    const varName = node.config?.variable || "item";
    const indexVar = node.config?.indexVariable || "index";
    const maxConcurrent = Math.max(1, node.config?.maxConcurrent || 1);
    const subWorkflowId = node.config?.workflowId || "";
    const subWorkflowMode = String(ctx.resolve(node.config?.mode || "sync") || "sync").trim().toLowerCase() || "sync";

    // Store items for downstream processing (backward compat)
    ctx.data[`_loop_${node.id}_items`] = items;
    ctx.data[`_loop_${node.id}_count`] = items.length;

    const results = [];

    // If a sub-workflow is specified, fan-out execution across items
    if (subWorkflowId && engine?.execute) {
      ctx.log(node.id, `Fan-out: ${items.length} item(s), concurrency=${maxConcurrent}, workflow=${subWorkflowId}`);

      const dispatchLaunchPlan = subWorkflowMode === "dispatch"
        ? resolveDispatchLaunchPlan(engine, subWorkflowId, maxConcurrent)
        : { windowSize: maxConcurrent, slotLimit: null };

      // Process items in bounded windows so slot-gated child workflows can
      // observe earlier allocations before later dispatches fan out.
      for (let batchStart = 0; batchStart < items.length; batchStart += dispatchLaunchPlan.windowSize) {
        const batch = items.slice(batchStart, batchStart + dispatchLaunchPlan.windowSize);
        const batchPromises = batch.map(async (item, batchIdx) => {
          const itemIndex = batchStart + batchIdx;
          const itemData = {
            ...ctx.data,
            [varName]: item,
            [indexVar]: itemIndex,
            _loopParentNodeId: node.id,
            _loopIteration: itemIndex,
            _loopTotal: items.length,
          };
          if (item && typeof item === "object" && !Array.isArray(item)) {
            const taskId = String(item.taskId || item.id || item.task_id || "").trim();
            const taskTitle = String(item.taskTitle || item.title || taskId).trim();
            const taskRecord = {
              ...item,
              ...(taskId ? { id: taskId } : {}),
              ...(taskTitle ? { title: taskTitle } : {}),
            };
            if (taskId) {
              clearInheritedTaskIdentity(itemData);
              itemData[varName] = item;
              itemData[indexVar] = itemIndex;
              itemData._loopParentNodeId = node.id;
              itemData._loopIteration = itemIndex;
              itemData._loopTotal = items.length;
              bindTaskContext({ data: itemData }, { taskId, taskTitle, task: taskRecord });
              itemData._workflowRootTaskId = taskId;
              itemData._workflowParentTaskId = taskId;
              itemData._workflowRootSessionId = taskId;
              itemData._workflowParentSessionId = taskId;
            }
            const description = String(item.taskDescription || item.description || "").trim();
            const branch = String(item.branch || item.branchName || "").trim();
            const baseBranch = String(item.baseBranch || item.base_branch || "").trim();
            const repository = String(item.repository || "").trim();
            const workspace = String(item.workspace || "").trim();
            const scope = String(item.scope || "").trim();
            if (description) itemData.taskDescription = description;
            if (branch) {
              itemData.branch = branch;
              itemData.branchName = branch;
            }
            if (baseBranch) itemData.baseBranch = baseBranch;
            if (repository) itemData.repository = repository;
            if (workspace) itemData.workspace = workspace;
            if (scope) itemData.scope = scope;
          }
          try {
            if (subWorkflowMode === "dispatch") {
              Promise.resolve(engine.execute(subWorkflowId, itemData))
                .then((runCtx) => {
                  const status = Array.isArray(runCtx?.errors) && runCtx.errors.length > 0 ? "failed" : "completed";
                  ctx.log(node.id, `Loop dispatch item ${itemIndex} finished with status=${status}`);
                })
                .catch((err) => {
                  ctx.log(node.id, `Loop dispatch item ${itemIndex} failed: ${err?.message || err}`, "error");
                });
              return {
                index: itemIndex,
                item,
                success: true,
                queued: true,
                mode: "dispatch",
                workflowId: subWorkflowId,
              };
            }
            const runCtx = await engine.execute(subWorkflowId, itemData);
            const ok = !runCtx?.errors?.length;
            return { index: itemIndex, item, success: ok, runId: runCtx?.id || null, mode: "sync", workflowId: subWorkflowId };
          } catch (err) {
            return { index: itemIndex, item, success: false, error: err?.message || String(err) };
          }
        });
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);
      }
    } else {
      // No sub-workflow — store items for downstream node access (legacy mode)
      for (let i = 0; i < items.length; i++) {
        ctx.data[varName] = items[i];
        ctx.data[indexVar] = i;
        results.push({ index: i, item: items[i], success: true });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    const failCount = results.length - successCount;
    ctx.log(node.id, `Loop complete: ${successCount} succeeded, ${failCount} failed out of ${items.length}`);

    return {
      items,
      count: items.length,
      totalItems: items.length,
      variable: varName,
      results,
      successCount,
      failCount,
    };
  },
});

registerNodeType("loop.while", {
  describe: () =>
    "Repeat a sub-workflow until a condition evaluates to false or max iterations " +
    "are reached. Enables convergence loops (generate→verify→revise) by executing " +
    "a child workflow repeatedly and passing each iteration's output as input to the next.",
  schema: {
    type: "object",
    properties: {
      condition: {
        type: "string",
        description:
          "JS expression evaluated AFTER each iteration. Loop continues while this is truthy. " +
          "Access $data (accumulated state), $iteration (current 0-based index), $result (last iteration output).",
      },
      workflowId: { type: "string", description: "Sub-workflow to execute each iteration" },
      maxIterations: { type: "number", default: 10, description: "Safety cap on total iterations" },
      stateVariable: {
        type: "string",
        default: "loopState",
        description: "Context key that accumulates state across iterations",
      },
      delayMs: { type: "number", default: 0, description: "Delay between iterations (ms)" },
      earlyExitOn: {
        type: "string",
        enum: ["success", "failure", "never"],
        default: "never",
        description: "Stop early when sub-workflow succeeds or fails",
      },
    },
    required: ["condition"],
  },
  async execute(node, ctx, engine) {
    const condExpr = node.config?.condition || "false";
    const subWorkflowId = ctx.resolve(node.config?.workflowId || "");
    const maxIter = Math.max(1, Math.min(200, Number(node.config?.maxIterations) || 10));
    const stateVar = node.config?.stateVariable || "loopState";
    const delayMs = Math.max(0, Number(node.config?.delayMs) || 0);
    const earlyExitOn = node.config?.earlyExitOn || "never";

    const iterations = [];
    let loopState = ctx.data[stateVar] || {};
    let converged = false;
    let lastResult = null;

    for (let i = 0; i < maxIter; i++) {
      ctx.log(node.id, `While-loop iteration ${i + 1}/${maxIter}`);

      // Execute sub-workflow if specified
      if (subWorkflowId && engine?.execute) {
        const iterInput = {
          ...ctx.data,
          [stateVar]: loopState,
          _whileIteration: i,
          _whileMaxIterations: maxIter,
          _previousAttempts: iterations.map((r) => r.output),
        };

        try {
          const childCtx = await engine.execute(subWorkflowId, iterInput, { force: true });
          const ok = !childCtx?.errors?.length;
          const childOutputs = childCtx?.nodeOutputs
            ? Object.fromEntries(childCtx.nodeOutputs)
            : {};
          lastResult = { success: ok, outputs: childOutputs, runId: childCtx?.id || null };

          // Merge child outputs into loop state
          loopState = { ...loopState, ...childOutputs, _lastSuccess: ok, _iteration: i };
          iterations.push({ index: i, success: ok, output: childOutputs });

          // Early exit
          if (earlyExitOn === "success" && ok) {
            ctx.log(node.id, `Early exit: sub-workflow succeeded on iteration ${i + 1}`);
            converged = true;
            break;
          }
          if (earlyExitOn === "failure" && !ok) {
            ctx.log(node.id, `Early exit: sub-workflow failed on iteration ${i + 1}`);
            converged = true;
            break;
          }
        } catch (err) {
          lastResult = { success: false, error: err.message };
          iterations.push({ index: i, success: false, error: err.message });
          loopState = { ...loopState, _lastSuccess: false, _lastError: err.message, _iteration: i };
        }
      } else {
        // No sub-workflow — just evaluate condition each cycle (useful with
        // back-edge patterns where downstream inline nodes modify context)
        lastResult = { success: true, data: ctx.data };
        loopState = { ...loopState, _iteration: i };
        iterations.push({ index: i, success: true });
      }

      // Update context with accumulated state
      ctx.data[stateVar] = loopState;

      // Evaluate continue condition
      try {
        const fn = new Function("$data", "$iteration", "$result", "$state",
          `return (${condExpr});`);
        const shouldContinue = fn(ctx.data, i, lastResult, loopState);
        if (!shouldContinue) {
          ctx.log(node.id, `Condition false after iteration ${i + 1} — loop converged`);
          converged = true;
          break;
        }
      } catch (err) {
        ctx.log(node.id, `Condition eval error: ${err.message} — stopping loop`, "warn");
        converged = true;
        break;
      }

      // Inter-iteration delay
      if (delayMs > 0 && i < maxIter - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    const totalIterations = iterations.length;
    const successCount = iterations.filter((r) => r.success).length;
    ctx.log(node.id,
      `While-loop done: ${totalIterations} iteration(s), ${successCount} succeeded, converged=${converged}`);

    return {
      converged,
      iterations: totalIterations,
      maxIterations: maxIter,
      successCount,
      failCount: totalIterations - successCount,
      results: iterations,
      finalState: loopState,
      lastResult,
    };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
//  SESSION / AGENT MANAGEMENT — Direct session control
// ═══════════════════════════════════════════════════════════════════════════
