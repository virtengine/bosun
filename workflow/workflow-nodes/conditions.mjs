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
import { cfgOrCtx } from "./transforms.mjs";
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

registerNodeType("condition.expression", {
  describe: () => "Evaluate a JS expression to branch workflow execution",
  schema: {
    type: "object",
    properties: {
      expression: { type: "string", description: "JS expression. Access $data, $output, $ctx" },
    },
    required: ["expression"],
  },
  async execute(node, ctx) {
    const expr = node.config?.expression;
    if (!expr) throw new Error("Expression is required");
    const normalizedExpr = String(expr)
      .replace(/\{\{([A-Za-z0-9_][A-Za-z0-9_.-]*)\}\}/g, (match, path) => {
        const resolved = ctx.resolve(`{{${path}}}`);
        if (resolved === match || resolved == null) return match;
        if (typeof resolved === "string") return JSON.stringify(resolved);
        try {
          return JSON.stringify(resolved);
        } catch {
          return String(resolved);
        }
      })
      .trim();
    const blockedPatterns = [
      /(?:^|[^\w$.])(globalThis|global|window|document|process|require|module|exports)(?:[^\w$]|$)/,
      /(?:^|[^\w$.])(Function|eval)(?:[^\w$]|$)/,
    ];
    if (blockedPatterns.some((pattern) => pattern.test(normalizedExpr))) {
      throw new Error("Expression contains unsupported syntax");
    }
    try {
      const fn = new Function("$data", "$ctx", "$output", `"use strict"; return (${normalizedExpr});`);
      const allOutputs = {};
      for (const [k, v] of ctx.nodeOutputs) allOutputs[k] = v;
      const result = fn(ctx.data, ctx, allOutputs);
      ctx.log(node.id, `Expression "${normalizedExpr}" → ${result}`);
      return { result: !!result, value: result };
    } catch (err) {
      throw new Error(`Expression error: ${err.message}`);
    }
  },
});

registerNodeType("condition.task_has_tag", {
  describe: () => "Check if current task has a specific tag or label",
  schema: {
    type: "object",
    properties: {
      tag: { type: "string", description: "Tag to check for" },
      field: { type: "string", default: "tags", description: "Field to check (tags, labels, title)" },
    },
    required: ["tag"],
  },
  async execute(node, ctx) {
    const tag = node.config?.tag?.toLowerCase();
    const field = node.config?.field || "tags";
    let haystack = ctx.data?.task?.[field] || ctx.data?.[field] || "";
    if (Array.isArray(haystack)) haystack = haystack.join(",").toLowerCase();
    else haystack = String(haystack).toLowerCase();
    const result = haystack.includes(tag);
    ctx.log(node.id, `Tag check: "${tag}" in ${field} → ${result}`);
    return { result, tag, field };
  },
});

registerNodeType("condition.file_exists", {
  describe: () => "Check if a file or directory exists in the workspace",
  schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File or directory path (supports {{variables}})" },
    },
    required: ["path"],
  },
  async execute(node, ctx) {
    const filePath = ctx.resolve(node.config?.path || "");
    const exists = existsSync(filePath);
    ctx.log(node.id, `File check: "${filePath}" → ${exists}`);
    return { result: exists, path: filePath };
  },
});

registerNodeType("condition.switch", {
  describe: () => "Multi-way branch based on a value matching cases",
  schema: {
    type: "object",
    properties: {
      value: { type: "string", description: "Expression to evaluate" },
      expression: { type: "string", description: "Legacy alias for value" },
      field: { type: "string", description: "Legacy field lookup key (fallback when no expression is provided)" },
      cases: {
        type: "object",
        description: "Map of case values to output port names",
        additionalProperties: { type: "string" },
      },
    },
    required: [],
  },
  async execute(node, ctx) {
    let value;
    const expr = node.config?.value || node.config?.expression || "";
    if (expr) {
      try {
        const fn = new Function("$data", "$ctx", `return (${expr});`);
        value = fn(ctx.data, ctx);
      } catch {
        value = ctx.resolve(expr);
      }
    } else if (node.config?.field) {
      const field = String(node.config.field || "").trim();
      value = field ? ctx.data?.[field] : undefined;
      if (value === undefined && field) {
        for (const output of ctx.nodeOutputs?.values?.() || []) {
          if (
            output &&
            typeof output === "object" &&
            Object.prototype.hasOwnProperty.call(output, field)
          ) {
            value = output[field];
            break;
          }
        }
      }
    }
    const cases = node.config?.cases || {};
    const matchedPort = cases[String(value)] || "default";
    ctx.log(node.id, `Switch: "${value}" → port "${matchedPort}"`);
    return { value, matchedPort, port: matchedPort };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
//  ACTIONS — Side-effect operations
// ═══════════════════════════════════════════════════════════════════════════

registerNodeType("condition.slot_available", {
  describe: () =>
    "Gate checking both global and per-base-branch concurrency limits.",
  schema: {
    type: "object",
    properties: {
      maxParallel: { type: "number", default: 3, description: "Maximum concurrent slots" },
      baseBranchLimit: { type: "number", default: 0, description: "Per-base-branch limit (0 = unlimited)" },
      baseBranch: { type: "string", description: "Base branch to check against" },
    },
  },
  async execute(node, ctx, engine) {
    const maxParallel = node.config?.maxParallel ?? 3;
    const baseBranchLimit = node.config?.baseBranchLimit ?? 0;
    const currentTaskId = String(ctx.data?.taskId || "").trim();
    const reservedBaseBranch = cfgOrCtx(node, ctx, "baseBranch") || ctx.data?.baseBranch || "";
    if (currentTaskId && engine && typeof engine.reserveTaskLifecycleSlot === "function") {
      const reservation = engine.reserveTaskLifecycleSlot({
        runId: ctx.id,
        taskId: currentTaskId,
        baseBranch: reservedBaseBranch,
        maxParallel,
        baseBranchLimit,
      });
      if (reservation.result) {
        ctx.data._reservedTaskLifecycleSlot = {
          taskId: currentTaskId,
          baseBranch: String(reservedBaseBranch || "").trim(),
          reservedAt: Date.now(),
          status: "reserved",
        };
      } else if (
        ctx.data?._reservedTaskLifecycleSlot
        && String(ctx.data._reservedTaskLifecycleSlot.taskId || "").trim() === currentTaskId
      ) {
        ctx.data._reservedTaskLifecycleSlot = null;
      }
      ctx.log(node.id, `Slot check: ${reservation.activeSlotCount}/${maxParallel}, perBranch=${reservation.baseBranchOk} → ${reservation.result}`);
      return reservation;
    }

    const slotSnapshot =
      typeof engine?.getTaskLifecycleSlotSnapshot === "function"
        ? engine.getTaskLifecycleSlotSnapshot({ excludeTaskId: currentTaskId })
        : null;
    const workflowActiveTaskIds = new Set(
      Array.isArray(slotSnapshot?.activeTaskIds) && slotSnapshot.activeTaskIds.length > 0
        ? slotSnapshot.activeTaskIds
        : (typeof engine?.getActiveRuns === "function" ? engine.getActiveRuns() : [])
          .filter((run) => String(run?.workflowName || "").trim().toLowerCase() === "task lifecycle")
          .map((run) => String(run?.taskId || "").trim())
          .filter((taskId) => taskId && taskId !== currentTaskId)
          .filter(Boolean),
    );
    const activeSlotCount = Number(
      ctx.data?.activeSlotCount
      ?? slotSnapshot?.activeSlotCount
      ?? (workflowActiveTaskIds.size > 0 ? workflowActiveTaskIds.size : 0),
    ) || 0;
    const slotsAvailable = activeSlotCount < maxParallel;

    let baseBranchOk = true;
    if (baseBranchLimit > 0) {
      const baseBranch = reservedBaseBranch;
      if (baseBranch) {
        const counts = ctx.data?.baseBranchSlotCounts || slotSnapshot?.baseBranchSlotCounts || {};
        const key = baseBranch.replace(/^origin\//, "");
        baseBranchOk = (counts[key] ?? 0) < baseBranchLimit;
      }
    }

    const result = slotsAvailable && baseBranchOk;
    if (result && currentTaskId) {
      ctx.data._reservedTaskLifecycleSlot = {
        taskId: currentTaskId,
        baseBranch: String(reservedBaseBranch || "").trim(),
        reservedAt: Date.now(),
        status: "reserved",
      };
    } else if (
      ctx.data?._reservedTaskLifecycleSlot
      && String(ctx.data._reservedTaskLifecycleSlot.taskId || "").trim() === currentTaskId
    ) {
      ctx.data._reservedTaskLifecycleSlot = null;
    }
    ctx.log(node.id, `Slot check: ${activeSlotCount}/${maxParallel}, perBranch=${baseBranchOk} → ${result}`);
    return { result, slotsAvailable, baseBranchOk, activeSlotCount, maxParallel };
  },
});

// ── action.allocate_slot ────────────────────────────────────────────────────

