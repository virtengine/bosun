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
import { createHarnessAgentService } from "../../agent/harness-agent-service.mjs";
import { getSessionTracker } from "../../infra/session-tracker.mjs";
import { fixGitConfigCorruption } from "../../workspace/worktree-manager.mjs";
import { buildRepoTopologyContext, hasRepoMapContext } from "../../lib/repo-map.mjs";
import { ensureContextIndexFresh } from "../../workspace/context-indexer.mjs";
import { findReusableSkillbookStrategies } from "../../workspace/skillbook-store.mjs";

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

registerNodeType("agent.select_profile", {
  describe: () => "Select an agent profile based on task characteristics",
  schema: {
    type: "object",
    properties: {
      profiles: {
        type: "object",
        description: "Map of profile name → matching criteria",
        additionalProperties: {
          type: "object",
          properties: {
            titlePatterns: { type: "array", items: { type: "string" } },
            tags: { type: "array", items: { type: "string" } },
            filePatterns: { type: "array", items: { type: "string" } },
          },
        },
      },
      default: { type: "string", default: "general", description: "Default profile if no match" },
    },
  },
  async execute(node, ctx) {
    const profiles = node.config?.profiles || {};
    const taskTitle = (ctx.data?.taskTitle || "").toLowerCase();
    const taskTags = (ctx.data?.taskTags || []).map((t) => t.toLowerCase());

    for (const [profileName, criteria] of Object.entries(profiles)) {
      // Check title patterns
      if (criteria.titlePatterns) {
        for (const pattern of criteria.titlePatterns) {
          if (new RegExp(pattern, "i").test(taskTitle)) {
            ctx.log(node.id, `Matched profile "${profileName}" via title pattern`);
            return { profile: profileName, matchedBy: "title" };
          }
        }
      }
      // Check tags
      if (criteria.tags) {
        for (const tag of criteria.tags) {
          if (taskTags.includes(tag.toLowerCase())) {
            ctx.log(node.id, `Matched profile "${profileName}" via tag`);
            return { profile: profileName, matchedBy: "tag" };
          }
        }
      }
    }

    const defaultProfile = node.config?.default || "general";
    ctx.log(node.id, `No profile matched, using default: ${defaultProfile}`);
    return { profile: defaultProfile, matchedBy: "default" };
  },
});

export function parsePlannerJsonFromText(value) {
  const text = normalizeLineEndings(String(value || ""))
    .replace(/\u001b\[[0-9;]*m/g, "")
    // Strip common agent prefixes: "Agent: ", "Assistant: ", etc.
    .replace(/^\s*(?:Agent|Assistant|Planner|Output)\s*:\s*/i, "")
    .trim();
  if (!text) return null;

  const candidates = [];
  // Match fenced blocks (```json ... ``` or ``` ... ```)
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = fenceRegex.exec(text)) !== null) {
    const body = String(match[1] || "").trim();
    if (body) candidates.push(body);
  }
  // Also try stripped text without fences as raw JSON
  const strippedText = text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
  if (strippedText && !candidates.includes(strippedText)) {
    candidates.push(strippedText);
  }
  candidates.push(text);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Try extracting a balanced object from prose-wrapped output.
    }

    const start = candidate.indexOf("{");
    if (start < 0) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < candidate.length; i += 1) {
      const ch = candidate[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }
      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{") depth += 1;
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const jsonSlice = candidate.slice(start, i + 1);
          try {
            const parsed = JSON.parse(jsonSlice);
            if (parsed && typeof parsed === "object") return parsed;
          } catch {
            // Keep scanning.
          }
        }
      }
    }
  }

  return null;
}

const PLANNER_SCORE_MAX = 10;
const PLANNER_RISK_LEVELS = ["low", "medium", "high", "critical"];
export const PLANNER_RISK_ORDER = { low: 0, medium: 1, high: 2, critical: 3 };
export const CALIBRATED_MIN_IMPACT_SCORE = 7;
export const CALIBRATED_MAX_RISK_WITHOUT_HUMAN = "medium";
export const STRICT_TASK_PLANNER_TASK_COUNT = 8;
const TASK_PLANNER_REQUIRED_TOP_LEVEL_KEYS = ["tasks"];
const TASK_PLANNER_REQUIRED_TASK_FIELDS = [
  "title",
  "description",
  "acceptance_criteria",
  "verification",
  "repo_areas",
  "impact",
  "confidence",
  "risk",
];
const TASK_PLANNER_ALLOWED_ESTIMATED_EFFORT = ["small", "medium", "large"];
const PLANNER_SCORE_MODE_RATIO = "ratio";
const PLANNER_SCORE_MODE_TEN = "ten";

function normalizeSkillbookGuidancePayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const strategies = Array.isArray(value.strategies)
    ? value.strategies.filter((entry) => entry && typeof entry === "object")
    : [];
  const guidanceSummary = String(value.guidanceSummary || value.summary || "").trim();
  if (!guidanceSummary && strategies.length === 0) return null;
  return {
    ...value,
    strategies,
    guidanceSummary,
  };
}

function buildSkillbookPromptContext(guidance) {
  const normalized = normalizeSkillbookGuidancePayload(guidance);
  if (!normalized) return "";
  return String(normalized.guidanceSummary || "").trim();
}

async function resolveReusableSkillbookGuidance(ctx, options = {}) {
  const repoRoot = String(options.repoRoot || ctx?.data?.repoRoot || process.cwd()).trim() || process.cwd();
  const workflowId = String(options.workflowId || ctx?.data?._workflowId || ctx?.data?.workflowId || "").trim();
  const category = String(options.category || "strategy").trim() || "strategy";
  const status = String(options.status || "promoted").trim() || "promoted";
  const query = String(options.query || "").trim();
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.trunc(Number(options.limit))) : 3;
  const result = await findReusableSkillbookStrategies({
    repoRoot,
    workflowId: workflowId || undefined,
    category,
    status,
    query: query || undefined,
    relatedPaths: Array.isArray(options.relatedPaths) ? options.relatedPaths : [],
    limit,
  });
  const strategies = Array.isArray(result?.strategies) ? result.strategies : [];
  return {
    success: true,
    repoRoot,
    workflowId: workflowId || null,
    category,
    status,
    query: query || null,
    total: Number(result?.total || 0),
    matched: Number(result?.matched || 0),
    strategies,
    guidanceSummary: String(result?.guidanceSummary || "").trim(),
    skillbookPath: result?.skillbookPath || null,
    strategyIds: strategies.map((entry) => entry?.strategyId).filter(Boolean),
  };
}

function parsePlannerNumericScore(value) {
  if (value == null) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? { numeric: value, scale: null } : null;
  }
  const raw = String(value || "").trim();
  if (!raw) return null;

  const ratioMatch = raw.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(1|10|100)$/);
  if (ratioMatch) {
    const numeric = Number(ratioMatch[1]);
    const denom = Number(ratioMatch[2]);
    if (!Number.isFinite(numeric) || !Number.isFinite(denom) || denom <= 0) return null;
    return { numeric, scale: denom };
  }

  const percentMatch = raw.match(/^(-?\d+(?:\.\d+)?)\s*%$/);
  if (percentMatch) {
    const numeric = Number(percentMatch[1]);
    if (!Number.isFinite(numeric)) return null;
    return { numeric, scale: 100 };
  }

  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return null;
  return { numeric, scale: null };
}

export function normalizePlannerScore(value, { preferTenScaleIntegers = false, preserveFractionalTenScale = false } = {}) {
  const parsed = parsePlannerNumericScore(value);
  if (!parsed) return null;

  let scaled = parsed.numeric;
  if (parsed.scale === 1) {
    scaled = parsed.numeric * PLANNER_SCORE_MAX;
  } else if (parsed.scale === 100) {
    scaled = parsed.numeric / 10;
  } else if (parsed.scale === 10) {
    scaled = parsed.numeric;
  } else if (scaled > 10 && scaled <= 100) {
    scaled = scaled / 10;
  } else if (scaled > 0 && scaled < 1) {
    const hasFractionalPart = Math.abs((scaled % 1)) > Number.EPSILON;
    if (!(preserveFractionalTenScale && hasFractionalPart)) {
      scaled = scaled * PLANNER_SCORE_MAX;
    }
  } else if (scaled === 1) {
    scaled = preferTenScaleIntegers ? 1 : PLANNER_SCORE_MAX;
  }

  const clamped = Math.max(0, Math.min(PLANNER_SCORE_MAX, scaled));
  return Math.round(clamped * 10) / 10;
}

function inferPlannerTaskScoreMode(task) {
  if (!task || typeof task !== "object") return PLANNER_SCORE_MODE_RATIO;
  const candidates = [task.impact, task.confidence, task.risk];
  for (const candidate of candidates) {
    const parsed = parsePlannerNumericScore(candidate);
    if (!parsed) continue;
    if (parsed.scale === 10) return PLANNER_SCORE_MODE_TEN;
    if (parsed.scale === 1 || parsed.scale === 100) return PLANNER_SCORE_MODE_RATIO;
    if (parsed.numeric > 1 && parsed.numeric <= PLANNER_SCORE_MAX) return PLANNER_SCORE_MODE_TEN;
    if (parsed.numeric > PLANNER_SCORE_MAX && parsed.numeric <= 100) return PLANNER_SCORE_MODE_RATIO;
  }
  return PLANNER_SCORE_MODE_RATIO;
}

export function normalizePlannerRiskLevel(value, { preferTenScaleIntegers = false, preserveFractionalTenScale = false } = {}) {
  const raw = String(value || "").trim().toLowerCase();
  if (PLANNER_RISK_LEVELS.includes(raw)) return raw;

  if (raw) {
    if (/\b(critical|catastrophic|severe|blocker|sev[\s-]*0|sev[\s-]*1|data\s+loss|outage|downtime|rce)\b/.test(raw)) return "critical";
    if (/\b(high|significant|major|risky|dangerous|blast\s+radius|customer[\s-]*impact|security|compliance|incident|breaking\s+change|migration\s+risk)\b/.test(raw)) return "high";
    if (/\b(medium|moderate)\b/.test(raw)) return "medium";
    if (/\b(low|minor|trivial|safe)\b/.test(raw)) return "low";
  }

  const numeric = normalizePlannerScore(value, { preferTenScaleIntegers, preserveFractionalTenScale });
  if (!Number.isFinite(numeric)) return null;
  if (numeric >= 9) return "critical";
  if (numeric >= 7) return "high";
  if (numeric >= 4) return "medium";
  return "low";
}

function validateStrictPlannerRequiredField(name, value, { type = "string", allowEmpty = false } = {}) {
  if (type === "array") {
    if (!Array.isArray(value)) {
      throw new Error(`Planner task missing required ${name} array`);
    }
    const normalized = value
      .map((entry) => String(entry || "").trim())
      .filter(Boolean);
    if (!allowEmpty && normalized.length === 0) {
      throw new Error(`Planner task missing required ${name} array`);
    }
    return normalized;
  }

  if (type === "score") {
    if (value === undefined || value === null || value === "") {
      throw new Error(`Planner task missing required ${name} score`);
    }
    return value;
  }

  const normalized = String(value || "").trim();
  if (!allowEmpty && !normalized) {
    throw new Error(`Planner task missing required ${name}`);
  }
  return normalized;
}

export function normalizePlannerTaskForCreation(task, index, options = {}) {
  if (!task || typeof task !== "object") return null;
  const title = String(task.title || "").trim();
  if (!title) return null;
  const strict = options?.strict === true;

  const normalizeStringList = (value) => {
    if (!Array.isArray(value)) return [];
    return value
      .map((entry) => String(entry || "").trim())
      .filter(Boolean);
  };
  const normalizeRepoAreas = (value) => {
    const list = normalizeStringList(value);
    if (!list.length) return [];
    const dedup = new Set();
    const normalized = [];
    for (const area of list) {
      const key = area.toLowerCase();
      if (dedup.has(key)) continue;
      dedup.add(key);
      normalized.push(area);
    }
    return normalized;
  };
  const normalizeOptionalStringList = (value) => {
    if (Array.isArray(value)) return normalizeStringList(value);
    const entry = String(value || "").trim();
    return entry ? [entry] : [];
  };
  const normalizeTaskGraphKey = (value, fallback = "") => {
    const normalized = String(value || fallback || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return normalized || "";
  };
  const scoreMode = inferPlannerTaskScoreMode(task);
  const preferTenScaleIntegers = scoreMode === PLANNER_SCORE_MODE_TEN;

  const lines = [];
  const description = String(task.description || "").trim();
  if (description) lines.push(description);
  const acceptanceCriteria = strict
    ? validateStrictPlannerRequiredField("acceptance_criteria", task.acceptance_criteria, { type: "array" })
    : normalizeStringList(task.acceptance_criteria);
  const verification = strict
    ? validateStrictPlannerRequiredField("verification", task.verification, { type: "array" })
    : normalizeStringList(task.verification);
  const repoAreas = normalizeRepoAreas(
    strict
      ? validateStrictPlannerRequiredField("repo_areas", task.repo_areas || task.repoAreas, { type: "array" })
      : (task.repo_areas || task.repoAreas),
  );
  const impact = normalizePlannerScore(
    strict
      ? validateStrictPlannerRequiredField("impact", task.impact, { type: "score" })
      : task.impact,
    { preferTenScaleIntegers },
  );
  const confidence = normalizePlannerScore(
    strict
      ? validateStrictPlannerRequiredField("confidence", task.confidence, { type: "score" })
      : task.confidence,
    { preferTenScaleIntegers },
  );
  const risk = normalizePlannerRiskLevel(
    strict
      ? validateStrictPlannerRequiredField("risk", task.risk, { type: "score" })
      : task.risk,
    {
      preferTenScaleIntegers,
      preserveFractionalTenScale: scoreMode === PLANNER_SCORE_MODE_TEN,
    },
  );
  const estimatedEffort = String(task.estimated_effort || task.estimatedEffort || "").trim().toLowerCase();
  const whyNow = String(task.why_now || task.whyNow || "").trim();
  const killCriteria = normalizeStringList(task.kill_criteria || task.killCriteria);
  const taskKey = normalizeTaskGraphKey(
    task.task_key || task.taskKey || task.key || task.id || "",
    title,
  );
  const parentTaskKey = normalizeTaskGraphKey(
    task.parent_task_key ||
      task.parentTaskKey ||
      task.parent_key ||
      task.parentKey ||
      task.parent_task_title ||
      task.parentTaskTitle ||
      task.parent_title ||
      task.parentTitle ||
      "",
  );
  const parentTaskId = String(task.parent_task_id || task.parentTaskId || "").trim() || null;
  const dependencyTaskKeys = Array.from(new Set([
    ...normalizeOptionalStringList(task.depends_on_task_keys),
    ...normalizeOptionalStringList(task.dependsOnTaskKeys),
    ...normalizeOptionalStringList(task.dependency_keys),
    ...normalizeOptionalStringList(task.dependencyKeys),
    ...normalizeOptionalStringList(task.depends_on_titles),
    ...normalizeOptionalStringList(task.dependsOnTitles),
    ...normalizeOptionalStringList(task.dependency_titles),
    ...normalizeOptionalStringList(task.dependencyTitles),
  ].map((entry) => normalizeTaskGraphKey(entry)).filter(Boolean)));
  const dependencyTaskIds = Array.from(new Set([
    ...normalizeOptionalStringList(task.depends_on_task_ids),
    ...normalizeOptionalStringList(task.dependsOnTaskIds),
    ...normalizeOptionalStringList(task.dependency_task_ids),
    ...normalizeOptionalStringList(task.dependencyTaskIds),
  ].map((entry) => String(entry || "").trim()).filter(Boolean)));
  const decompositionKind = String(task.decomposition_kind || task.decompositionKind || "").trim().toLowerCase() || null;
  const spawnWhen = String(task.spawn_when || task.spawnWhen || "").trim() || null;
  const mergeBackPolicy = String(task.merge_back_policy || task.mergeBackPolicy || "").trim() || null;

  const appendList = (heading, values) => {
    if (!Array.isArray(values) || values.length === 0) return;
    const items = values
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    if (!items.length) return;
    lines.push("", `## ${heading}`);
    for (const item of items) lines.push(`- ${item}`);
  };

  appendList("Implementation Steps", task.implementation_steps);
  appendList("Acceptance Criteria", acceptanceCriteria);
  appendList("Verification", verification);

  const baseBranch = String(task.base_branch || "").trim();
  const workspace = String(task.workspace || "").trim();
  const repository = String(task.repository || task.repo || "").trim();
  const repositories = Array.isArray(task.repositories)
    ? task.repositories.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  const priority = String(task.priority || "").trim().toLowerCase();
  const tags = Array.isArray(task.tags || task.labels)
    ? (task.tags || task.labels)
      .map((entry) => String(entry || "").trim())
      .filter(Boolean)
    : [];
  const requestedStatus = String(task.status || "").trim().toLowerCase();
  const draft = Boolean(task.draft || requestedStatus === "draft");
  if (baseBranch) {
    lines.push("", `Base branch: \`${baseBranch}\``);
  }

  return {
    title,
    description: lines.join("\n").trim(),
    index,
    baseBranch: baseBranch || null,
    workspace: workspace || null,
    repository: repository || null,
    repositories,
    priority: ["low", "medium", "high", "critical"].includes(priority) ? priority : null,
    tags,
    draft,
    requestedStatus: requestedStatus || null,
    acceptanceCriteria,
    verification,
    repoAreas,
    impact,
    confidence,
    risk,
    estimatedEffort: estimatedEffort || null,
    whyNow: whyNow || null,
    killCriteria: killCriteria.length > 0 ? killCriteria : null,
    taskKey: taskKey || null,
    parentTaskKey: parentTaskKey || null,
    parentTaskId,
    dependencyTaskKeys,
    dependencyTaskIds,
    decompositionKind,
    spawnWhen,
    mergeBackPolicy,
  };
}
export function validateStrictTaskPlannerPayload(payload, options = {}) {
  const exactTaskCount = Number.isFinite(Number(options?.exactTaskCount))
    ? Math.max(1, Math.trunc(Number(options.exactTaskCount)))
    : STRICT_TASK_PLANNER_TASK_COUNT;

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      ok: false,
      error: "Planner payload must be a JSON object with exactly one top-level \"tasks\" key",
      code: "invalid_top_level_type",
    };
  }

  const topLevelKeys = Object.keys(payload);
  if (topLevelKeys.length !== TASK_PLANNER_REQUIRED_TOP_LEVEL_KEYS.length || topLevelKeys[0] !== "tasks") {
    return {
      ok: false,
      error: `Planner payload must contain exactly one top-level \"tasks\" key; found ${topLevelKeys.length ? topLevelKeys.join(", ") : "none"}`,
      code: "invalid_top_level_keys",
    };
  }

  if (!Array.isArray(payload.tasks)) {
    return {
      ok: false,
      error: 'Planner payload field "tasks" must be an array',
      code: "invalid_tasks_type",
      field: "tasks",
    };
  }

  if (payload.tasks.length !== exactTaskCount) {
    return {
      ok: false,
      error: `Planner payload must contain exactly ${exactTaskCount} tasks; found ${payload.tasks.length}`,
      code: "invalid_task_count",
      field: "tasks",
      expected: exactTaskCount,
      actual: payload.tasks.length,
    };
  }

  for (let i = 0; i < payload.tasks.length; i += 1) {
    const task = payload.tasks[i];
    const taskLabel = `tasks[${i}]`;
    if (!task || typeof task !== "object" || Array.isArray(task)) {
      return {
        ok: false,
        error: `${taskLabel} must be an object`,
        code: "invalid_task_type",
        taskIndex: i,
      };
    }

    for (const field of TASK_PLANNER_REQUIRED_TASK_FIELDS) {
      if (!(field in task)) {
        return {
          ok: false,
          error: `${taskLabel}.${field} is required`,
          code: "missing_required_field",
          taskIndex: i,
          field,
        };
      }
    }

    if (String(task.title || "").trim() === "") {
      return { ok: false, error: `${taskLabel}.title must be a non-empty string`, code: "invalid_field", taskIndex: i, field: "title" };
    }
    if (String(task.description || "").trim() === "") {
      return { ok: false, error: `${taskLabel}.description must be a non-empty string`, code: "invalid_field", taskIndex: i, field: "description" };
    }

    const listFields = ["acceptance_criteria", "verification", "repo_areas"];
    for (const field of listFields) {
      const value = task[field];
      if (!Array.isArray(value) || value.length === 0 || value.some((entry) => String(entry || "").trim() === "")) {
        return {
          ok: false,
          error: `${taskLabel}.${field} must be a non-empty array of non-empty strings`,
          code: "invalid_field",
          taskIndex: i,
          field,
        };
      }
    }

    const impact = normalizePlannerScore(task.impact, { preferTenScaleIntegers: false, preserveFractionalTenScale: true });
    if (!Number.isFinite(impact)) {
      return { ok: false, error: `${taskLabel}.impact must be a numeric planner score`, code: "invalid_field", taskIndex: i, field: "impact" };
    }
    const confidence = normalizePlannerScore(task.confidence, { preferTenScaleIntegers: false, preserveFractionalTenScale: true });
    if (!Number.isFinite(confidence)) {
      return { ok: false, error: `${taskLabel}.confidence must be a numeric planner score`, code: "invalid_field", taskIndex: i, field: "confidence" };
    }

    const risk = normalizePlannerRiskLevel(task.risk, { preferTenScaleIntegers: false, preserveFractionalTenScale: true });
    if (!risk || !PLANNER_RISK_LEVELS.includes(risk)) {
      return {
        ok: false,
        error: `${taskLabel}.risk must be one of: ${PLANNER_RISK_LEVELS.join(", ")}`,
        code: "invalid_enum",
        taskIndex: i,
        field: "risk",
      };
    }

    if (Object.prototype.hasOwnProperty.call(task, "estimated_effort")) {
      const estimatedEffort = String(task.estimated_effort || "").trim().toLowerCase();
      if (!TASK_PLANNER_ALLOWED_ESTIMATED_EFFORT.includes(estimatedEffort)) {
        return {
          ok: false,
          error: `${taskLabel}.estimated_effort must be one of: ${TASK_PLANNER_ALLOWED_ESTIMATED_EFFORT.join(", ")}`,
          code: "invalid_enum",
          taskIndex: i,
          field: "estimated_effort",
        };
      }
    }
  }

  return {
    ok: true,
    payload,
    tasks: payload.tasks,
  };
}

export function extractPlannerTasksFromWorkflowOutput(output, maxTasks = 5, options = {}) {
  const parsed = parsePlannerJsonFromText(output);
  if (!parsed) return [];

  const strict = options?.strict === true;
  const sourceTasks = strict
    ? (() => {
        const validation = validateStrictTaskPlannerPayload(parsed, {
          exactTaskCount: options?.exactCount,
        });
        return validation.ok ? validation.tasks : [];
      })()
    : (Array.isArray(parsed?.tasks) ? parsed.tasks : []);

  const max = Number.isFinite(Number(maxTasks))
    ? Math.max(1, Math.min(100, Math.trunc(Number(maxTasks))))
    : 5;
  const dedup = new Set();
  const tasks = [];
  for (let i = 0; i < sourceTasks.length && tasks.length < max; i += 1) {
    const normalized = normalizePlannerTaskForCreation(sourceTasks[i], i, { strict });
    if (!normalized) continue;
    const key = normalized.title.toLowerCase();
    if (dedup.has(key)) continue;
    dedup.add(key);
    tasks.push(normalized);
  }
  return tasks;
}

export function resolvePlannerMaterializationDefaults(ctx) {
  const data =
    ctx?.data && typeof ctx.data === "object" && !Array.isArray(ctx.data)
      ? ctx.data
      : {};
  const dataMeta =
    data.meta && typeof data.meta === "object" && !Array.isArray(data.meta)
      ? data.meta
      : {};
  const workspace = String(
    data.workspace ||
      data.workspaceId ||
      data._workspace ||
      data._workspaceId ||
      dataMeta.workspace ||
      process.env.BOSUN_WORKSPACE ||
      "",
  ).trim();
  const repository = String(
    data.repository ||
      data.repo ||
      data._targetRepo ||
      dataMeta.repository ||
      process.env.GITHUB_REPOSITORY ||
      "",
  ).trim();
  return {
    workspace,
    repository,
  };
}

export function normalizePlannerAreaKey(value) {
  return String(value || "").trim().toLowerCase();
}

export function resolveTaskRepoAreas(task) {
  const candidates = []
    .concat(Array.isArray(task?.repo_areas) ? task.repo_areas : [])
    .concat(Array.isArray(task?.repoAreas) ? task.repoAreas : [])
    .concat(Array.isArray(task?.meta?.repo_areas) ? task.meta.repo_areas : [])
    .concat(Array.isArray(task?.meta?.repoAreas) ? task.meta.repoAreas : [])
    .concat(Array.isArray(task?.meta?.planner?.repo_areas) ? task.meta.planner.repo_areas : [])
    .concat(Array.isArray(task?.meta?.planner?.repoAreas) ? task.meta.planner.repoAreas : []);
  if (!candidates.length) return [];
  const dedup = new Set();
  const normalized = [];
  for (const entry of candidates) {
    const area = String(entry || "").trim();
    if (!area) continue;
    const key = normalizePlannerAreaKey(area);
    if (!key || dedup.has(key)) continue;
    dedup.add(key);
    normalized.push(area);
  }
  return normalized;
}

function normalizePlannerTaskArchetype(task) {
  const explicitArchetype = String(
    task?.archetype || task?.taskArchetype || task?.task_archetype || "",
  )
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9()_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (explicitArchetype) return explicitArchetype;
  const title = String(task?.title || "").trim().toLowerCase();
  if (!title) return "general";
  const withoutPrefix = title.replace(/^\[[^\]]+\]\s*/, "").trim();
  const scoped = withoutPrefix.match(/^([a-z][a-z0-9_-]*)\(([^)]+)\)\s*:/);
  if (scoped) return scoped[1];
  const typed = withoutPrefix.match(/^([a-z][a-z0-9_-]*)\s*:/);
  if (typed) return typed[1];
  const fallback = withoutPrefix
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join("_");
  return fallback || "general";
}

function resolvePlannerPatternKeys(task) {
  const archetype = normalizePlannerTaskArchetype(task);
  const areas = resolveTaskRepoAreas(task);
  const normalizedAreas = areas.length > 0
    ? areas.map((area) => normalizePlannerAreaKey(area)).filter(Boolean)
    : ["global"];
  return normalizedAreas.map((area) => `${area}::${archetype}`);
}

function resolvePlannerDebtTrendSignal(task) {
  const numericCandidates = [
    task?.debt_trend,
    task?.debtTrend,
    task?.meta?.debt_trend,
    task?.meta?.debtTrend,
    task?.meta?.planner?.debt_trend,
    task?.meta?.planner?.debtTrend,
    task?.meta?.planner?.debt_growth,
    task?.meta?.planner?.debtGrowth,
  ];
  for (const candidate of numericCandidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric)) {
      return Math.max(0, Math.min(5, Math.abs(numeric)));
    }
  }

  const textCandidates = [
    task?.debt_trend,
    task?.debtTrend,
    task?.meta?.debt_trend,
    task?.meta?.debtTrend,
    task?.meta?.planner?.debt_trend,
    task?.meta?.planner?.debtTrend,
    task?.meta?.planner?.why_now,
    task?.meta?.planner?.whyNow,
    task?.description,
  ]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  for (const text of textCandidates) {
    if (/(worsen|worsening|increase|increasing|growth|growing|upward|regress)/.test(text)) {
      return 2;
    }
    if (/(stable|flat|neutral|steady)/.test(text)) {
      return 1;
    }
  }
  return 0;
}

function hasTaskCommitEvidence(task) {
  const commitCandidates = [
    task?.hasCommits,
    task?.meta?.hasCommits,
    task?.meta?.execution?.hasCommits,
    task?.meta?.execution?.commitCount,
    task?.meta?.execution?.commits,
    task?.commitCount,
    task?.commits,
    task?.meta?.commits,
  ];
  for (const candidate of commitCandidates) {
    if (typeof candidate === "boolean") return candidate;
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > 0) return true;
    if (Array.isArray(candidate) && candidate.length > 0) return true;
  }
  return false;
}

function createEmptyPlannerPatternPrior() {
  return {
    failureCount: 0,
    successCount: 0,
    failureWeight: 0,
    successWeight: 0,
    failureCounter: 0,
    negativePrior: 0,
    commitlessFailureCount: 0,
    commitlessSuccessCount: 0,
    commitlessFailureCounter: 0,
    signalTotals: {
      agentAttempts: 0,
      consecutiveNoCommits: 0,
      blockedReason: 0,
      debtTrend: 0,
    },
    lastUpdatedAt: null,
  };
}

function normalizePlannerPatternPrior(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return createEmptyPlannerPatternPrior();
  }
  const base = createEmptyPlannerPatternPrior();
  const signalTotals = entry.signalTotals && typeof entry.signalTotals === "object"
    ? entry.signalTotals
    : {};
  return {
    ...base,
    ...entry,
    signalTotals: {
      agentAttempts: Number(signalTotals.agentAttempts || 0),
      consecutiveNoCommits: Number(signalTotals.consecutiveNoCommits || 0),
      blockedReason: Number(signalTotals.blockedReason || 0),
      debtTrend: Number(signalTotals.debtTrend || 0),
    },
  };
}

export function resolvePlannerPriorFeedbackWeights(weights) {
  const config = weights && typeof weights === "object" && !Array.isArray(weights)
    ? weights
    : {};
  return {
    agentAttempts: Math.max(0, Number(config.agentAttempts || 0.6)),
    consecutiveNoCommits: Math.max(0, Number(config.consecutiveNoCommits || 1.3)),
    blockedReason: Math.max(0, Number(config.blockedReason || 1.8)),
    debtTrend: Math.max(0, Number(config.debtTrend || 0.7)),
    commitSuccess: Math.max(0, Number(config.commitSuccess || 2.2)),
    completedSuccess: Math.max(0, Number(config.completedSuccess || 0.8)),
  };
}

function resolvePlannerOutcomeSignals(task, weights) {
  const attempts = Math.max(0, Number(task?.agentAttempts || task?.meta?.agentAttempts || 0));
  const noCommits = Math.max(
    0,
    Number(task?.consecutiveNoCommits || task?.meta?.consecutiveNoCommits || 0),
  );
  const blockedReason = String(task?.blockedReason || task?.meta?.blockedReason || "").trim();
  const debtTrendSignal = resolvePlannerDebtTrendSignal(task);
  const commitEvidence = hasTaskCommitEvidence(task);
  const status = String(task?.status || "").trim().toLowerCase();
  const completedStatus = ["done", "completed", "closed", "merged"].includes(status);
  const agentAttemptsPenalty = commitEvidence ? 0 : (attempts * weights.agentAttempts);
  const consecutiveNoCommitsPenalty = noCommits * weights.consecutiveNoCommits;
  const blockedPenalty = blockedReason ? weights.blockedReason : 0;
  const debtTrendPenalty = debtTrendSignal * weights.debtTrend;

  const failureWeight =
    agentAttemptsPenalty +
    consecutiveNoCommitsPenalty +
    blockedPenalty +
    debtTrendPenalty;
  const successWeight =
    (commitEvidence ? weights.commitSuccess : 0) +
    ((completedStatus && !blockedReason) ? weights.completedSuccess : 0);
  const commitlessFailureEvent = attempts > 0 && !commitEvidence;

  return {
    attempts,
    noCommits,
    blockedReason,
    debtTrendSignal,
    commitEvidence,
    commitlessFailureEvent,
    failureWeight,
    successWeight,
    failureComponents: {
      agentAttemptsPenalty,
      consecutiveNoCommitsPenalty,
      blockedPenalty,
      debtTrendPenalty,
    },
  };
}

export function resolvePlannerPriorStatePath() {
  const configured = String(process.env.BOSUN_PLANNER_PATTERN_PRIORS_FILE || "").trim();
  if (configured) return configured;
  return resolve(process.cwd(), ".bosun", "workflow-runs", "planner-pattern-priors.json");
}

export function shouldPersistPlannerPriorState() {
  if (String(process.env.BOSUN_DISABLE_PLANNER_PATTERN_PRIORS || "").trim().toLowerCase() === "true") {
    return false;
  }
  if (process.env.VITEST && process.env.BOSUN_TEST_ENABLE_PLANNER_PRIOR_PERSISTENCE !== "true") {
    return false;
  }
  return true;
}

export function loadPlannerPriorState(statePath) {
  const base = { version: 1, patterns: {}, outcomes: {} };
  if (!statePath || !existsSync(statePath)) return base;
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    if (!parsed || typeof parsed !== "object") return base;
    return {
      version: 1,
      patterns:
        parsed.patterns && typeof parsed.patterns === "object"
          ? Object.fromEntries(
            Object.entries(parsed.patterns).map(([key, value]) => [
              key,
              normalizePlannerPatternPrior(value),
            ]),
          )
          : {},
      outcomes: parsed.outcomes && typeof parsed.outcomes === "object" ? parsed.outcomes : {},
    };
  } catch {
    return base;
  }
}

export function savePlannerPriorState(statePath, state) {
  if (!statePath) return;
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch {
    // Best-effort persistence only.
  }
}

export function replayPlannerOutcomes(existingTasks, priorState, weights) {
  if (!Array.isArray(existingTasks) || existingTasks.length === 0) return;
  const nowIso = new Date().toISOString();
  const maxOutcomes = 5000;

  for (const task of existingTasks) {
    const taskId = String(task?.id || task?.task_id || "").trim();
    if (!taskId) continue;
    const keys = resolvePlannerPatternKeys(task);
    if (!keys.length) continue;
    const signals = resolvePlannerOutcomeSignals(task, weights);
    const signature = JSON.stringify({
      status: String(task?.status || "").trim().toLowerCase(),
      attempts: signals.attempts,
      noCommits: signals.noCommits,
      blockedReason: signals.blockedReason.toLowerCase(),
      debtTrendSignal: signals.debtTrendSignal,
      hasCommits: hasTaskCommitEvidence(task),
    });
    if (priorState.outcomes?.[taskId]?.signature === signature) continue;
    priorState.outcomes[taskId] = { signature, updatedAt: nowIso };

    for (const key of keys) {
      const current = normalizePlannerPatternPrior(priorState.patterns[key]);
      const priorCounter = Math.max(0, Number(current.failureCounter || 0));
      const priorCommitlessCounter = Math.max(0, Number(current.commitlessFailureCounter || 0));
      if (signals.failureWeight > 0) {
        current.failureCount = Number(current.failureCount || 0) + 1;
        current.failureWeight = Number(current.failureWeight || 0) + signals.failureWeight;
        current.signalTotals.agentAttempts += signals.failureComponents.agentAttemptsPenalty;
        current.signalTotals.consecutiveNoCommits += signals.failureComponents.consecutiveNoCommitsPenalty;
        current.signalTotals.blockedReason += signals.failureComponents.blockedPenalty;
        current.signalTotals.debtTrend += signals.failureComponents.debtTrendPenalty;
      }
      if (signals.successWeight > 0) {
        current.successCount = Number(current.successCount || 0) + 1;
        current.successWeight = Number(current.successWeight || 0) + signals.successWeight;
      }
      if (signals.commitlessFailureEvent) {
        current.commitlessFailureCount = Number(current.commitlessFailureCount || 0) + 1;
      }
      if (signals.commitEvidence) {
        current.commitlessSuccessCount = Number(current.commitlessSuccessCount || 0) + 1;
      }
      current.failureCounter = Number(
        Math.max(
          0,
          (priorCounter * 0.82) + signals.failureWeight - (signals.successWeight * 0.95),
        ).toFixed(3),
      );
      current.commitlessFailureCounter = Number(
        Math.max(
          0,
          (priorCommitlessCounter * 0.86) +
            (signals.commitlessFailureEvent ? 1.25 : 0) -
            (signals.commitEvidence ? 1.1 : 0),
        ).toFixed(3),
      );
      current.lastUpdatedAt = nowIso;
      priorState.patterns[key] = current;
    }
  }

  const outcomeEntries = Object.entries(priorState.outcomes || {});
  if (outcomeEntries.length > maxOutcomes) {
    outcomeEntries
      .sort((a, b) => String(a[1]?.updatedAt || "").localeCompare(String(b[1]?.updatedAt || "")))
      .slice(0, outcomeEntries.length - maxOutcomes)
      .forEach(([id]) => {
        delete priorState.outcomes[id];
      });
  }
}

export function resolvePlannerPriorRankingConfig(config) {
  const ranking = config && typeof config === "object" && !Array.isArray(config)
    ? config
    : {};
  return {
    failureThreshold: Math.max(1, Number(ranking.failureThreshold ?? ranking.failurePriorThreshold ?? 2) || 2),
    failurePriorStep: Math.max(0, Number(ranking.failurePriorStep ?? 1.5) || 1.5),
    maxNegativePrior: Math.max(0, Number(ranking.maxNegativePrior ?? ranking.maxFailurePriorPenalty ?? 8) || 8),
    signalPenaltyScale: Math.max(0, Number(ranking.signalPenaltyScale ?? ranking.feedbackSignalScale ?? 0.12) || 0.12),
  };
}

export function rankPlannerTaskCandidates(tasks, priorState, rankingConfig) {
  const config = resolvePlannerPriorRankingConfig(rankingConfig);
  const scored = (Array.isArray(tasks) ? tasks : []).map((task) => {
    const impact = Number.isFinite(task?.impact) ? Number(task.impact) : 5;
    const confidence = Number.isFinite(task?.confidence) ? Number(task.confidence) : 5;
    const riskLevel = String(task?.risk || "").trim().toLowerCase();
    const riskPenalty = ({ low: 0, medium: 0.4, high: 0.9, critical: 1.6 })[riskLevel] || 0;
    const baseScore = (impact * 1.15) + (confidence * 0.85) - riskPenalty;

    const keys = resolvePlannerPatternKeys(task);
    const penalties = keys.map((key) => {
      const prior = priorState?.patterns?.[key];
      if (!prior || typeof prior !== "object") return { key, signalPenalty: 0, negativePrior: 0 };
      const failureCount = Number(prior.failureCount || 0);
      const successCount = Number(prior.successCount || 0);
      const failureWeight = Number(prior.failureWeight || 0);
      const successWeight = Number(prior.successWeight || 0);
      const configuredNegativePrior = Math.max(0, Number(prior.negativePrior || 0));
      const failureCounter = Number(prior.failureCounter || 0);
      const commitlessFailureCounter = Number(prior.commitlessFailureCounter || 0);
      const commitlessFailureCount = Number(prior.commitlessFailureCount || 0);
      const commitlessSuccessCount = Number(prior.commitlessSuccessCount || 0);
      const netFailureEvents = Math.max(0, failureCount - successCount);
      const netFailureWeight = Math.max(0, failureWeight - successWeight);
      const netCommitlessEvents = Math.max(0, commitlessFailureCount - commitlessSuccessCount);
      const recoveredFailureCounter = Math.min(
        Math.max(0, failureCounter - (Math.min(successCount, failureCount) * 0.9)),
        Math.max(0, failureCount - successCount + 1),
      );
      const recoveredCommitlessCounter = Math.max(
        0,
        commitlessFailureCounter - (Math.min(commitlessSuccessCount, commitlessFailureCount) * 0.85),
      );
      const repeatedFailureSignal = Math.max(
        netFailureEvents,
        recoveredFailureCounter,
        netCommitlessEvents,
        recoveredCommitlessCounter,
      );
      const recoveryDiscount = successCount >= failureCount && successCount > 0 ? 0.05 : 1;
      const signalPenalty = Math.max(
        netFailureWeight * config.signalPenaltyScale * 0.45 * recoveryDiscount,
        recoveredFailureCounter * config.signalPenaltyScale * 0.35 * recoveryDiscount,
      );
      const stronglyRecovered = successCount > 0 && successCount >= failureCount;
      const unrecoveredFailureSignal = Math.max(
        netFailureEvents,
        Math.max(0, repeatedFailureSignal - Math.max(0, successCount * 0.75)),
      );
      const positiveRecoveryBalance = Math.max(0, successCount - failureCount);
      const negativePrior = stronglyRecovered
        ? 0
        : (
          unrecoveredFailureSignal >= config.failureThreshold
            ? Math.max(
              configuredNegativePrior,
              Math.min(
                config.maxNegativePrior,
                Math.max(
                  0,
                  config.failurePriorStep * (unrecoveredFailureSignal - config.failureThreshold + 1) - (positiveRecoveryBalance * 6),
                ),
              ),
            )
            : 0
        );
      const recoveryBonus = stronglyRecovered
        ? Math.max(1.25, Math.min(5.5, (successCount - failureCount + 1.5) * 2.8))
        : (successCount === failureCount && successCount > 0 ? 0.3 : 0);
      return {
        key,
        signalPenalty,
        negativePrior,
        recoveryBonus,
        failureCounter: recoveredFailureCounter,
        commitlessFailureCounter: recoveredCommitlessCounter,
        netCommitlessEvents,
      };
    });
    const totalRecoveryBonus = penalties.reduce(
      (sum, item) => sum + Math.max(0, item.recoveryBonus || 0),
      0,
    );
    const totalPenalty = penalties.reduce(
      (sum, item) => sum + Math.max(0, item.signalPenalty + item.negativePrior - (item.recoveryBonus || 0)),
      0,
    );
    const averagePenalty = penalties.length > 0 ? totalPenalty / penalties.length : 0;
    const averageRecoveryBonus = penalties.length > 0 ? totalRecoveryBonus / penalties.length : 0;
    const rankScore = baseScore - averagePenalty + Math.min(0.35, averageRecoveryBonus * 0.12);

    return {
      ...task,
      _ranking: {
        baseScore: Number(baseScore.toFixed(3)),
        penalty: Number(averagePenalty.toFixed(3)),
        score: Number(rankScore.toFixed(3)),
        patternKeys: keys,
        penalties,
      },
    };
  });

  scored.sort((a, b) => {
    if ((b?._ranking?.score || 0) !== (a?._ranking?.score || 0)) {
      return (b?._ranking?.score || 0) - (a?._ranking?.score || 0);
    }
    return Number(a?.index || 0) - Number(b?.index || 0);
  });
  return scored;
}

export function rankPlannerTaskCandidatesForResume(tasks, plannerFeedback) {
  const resumeFeedback =
    plannerFeedback && typeof plannerFeedback === "object" && !Array.isArray(plannerFeedback)
      ? plannerFeedback
      : null;
  const taskList = Array.isArray(tasks) ? tasks : [];
  if (!resumeFeedback) return taskList;
  const hotTaskTitles = new Set(
    Array.isArray(resumeFeedback?.taskStore?.hotTasks)
      ? resumeFeedback.taskStore.hotTasks
          .map((task) => String(task?.title || "").trim().toLowerCase())
          .filter(Boolean)
      : [],
  );

  const normalizeResumeText = (value) => String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\b(validate|validation|stage|step|task|handoff|planner|resume|handling)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokenizeResumeText = (value) =>
    normalizeResumeText(value)
      .split(" ")
      .map((token) => {
        if (token.length > 3 && token.endsWith("s")) {
          return token.slice(0, -1);
        }
        return token;
      })
      .filter(Boolean);
  const matchesResumeLabel = (taskTokens, taskText, labelTokens, labelText) => {
    if (!labelText) return false;
    if (taskText === labelText) return true;
    if (taskText.includes(labelText)) return true;
    return labelTokens.length > 0 && labelTokens.every((token) => taskTokens.includes(token));
  };

  const nextStepLabel = String(resumeFeedback?.issueAdvisor?.nextStepLabel || "")
    .trim()
    .toLowerCase();
  const normalizedNextStep = normalizeResumeText(nextStepLabel);
  const dagStateSummary =
    resumeFeedback?.dagStateSummary && typeof resumeFeedback.dagStateSummary === "object"
      ? resumeFeedback.dagStateSummary
      : null;

  const completedLabels = (Array.isArray(dagStateSummary?.completedNodes) ? dagStateSummary.completedNodes : [])
    .map((node) => {
      const labelText = normalizeResumeText(node?.label || node?.title || node?.name || "");
      return {
        labelText,
        labelTokens: tokenizeResumeText(labelText),
      };
    })
    .filter((entry) => entry.labelText);

  const pendingNodes = Array.isArray(dagStateSummary?.pendingNodes) ? dagStateSummary.pendingNodes : [];
  const pendingOrder = pendingNodes
    .map((pendingNode, index) => {
      const labelText = normalizeResumeText(
        pendingNode?.label || pendingNode?.title || pendingNode?.name || pendingNode?.id || "",
      );
      return {
        index,
        labelText,
        labelTokens: tokenizeResumeText(labelText),
      };
    })
    .filter((entry) => entry.labelText);

  const rankedEntries = taskList
    .map((task, originalIndex) => {
      const title = normalizeResumeText(task?.title || "");
      const titleTokens = tokenizeResumeText(title);
      const taskIndex = Number.isFinite(Number(task?.index)) ? Number(task.index) : originalIndex;
      const exactMatch = normalizedNextStep && title === normalizedNextStep;
      const containsMatch = normalizedNextStep && !exactMatch && title.includes(normalizedNextStep);
      const pendingMatch = pendingOrder.find((entry) =>
        matchesResumeLabel(titleTokens, title, entry.labelTokens, entry.labelText),
      );
      const pendingIndex = pendingMatch ? pendingMatch.index : Number.POSITIVE_INFINITY;
      const completed = completedLabels.some((entry) =>
        matchesResumeLabel(titleTokens, title, entry.labelTokens, entry.labelText),
      );
      return {
        task,
        originalIndex,
        title,
        titleTokens,
        taskIndex,
        exactMatch,
        containsMatch,
        pendingIndex,
        completed,
      };
    })
    .filter((entry) => !entry.completed);

  if (!normalizedNextStep && completedLabels.length === 0 && pendingOrder.length === 0 && hotTaskTitles.size === 0) {
    return taskList;
  }

  if (!rankedEntries.length) return [];

  const exactMatchEntry = normalizedNextStep
    ? rankedEntries.find((entry) => entry.exactMatch) || rankedEntries.find((entry) => entry.containsMatch)
    : null;

  return rankedEntries
    .slice()
    .sort((a, b) => {
      const aIsResume = exactMatchEntry ? a === exactMatchEntry : false;
      const bIsResume = exactMatchEntry ? b === exactMatchEntry : false;
      if (aIsResume !== bIsResume) return aIsResume ? -1 : 1;

      const aHasPending = Number.isFinite(a.pendingIndex);
      const bHasPending = Number.isFinite(b.pendingIndex);
      if (aHasPending !== bHasPending) return aHasPending ? -1 : 1;
      if (aHasPending && bHasPending && a.pendingIndex !== b.pendingIndex) {
        return a.pendingIndex - b.pendingIndex;
      }

      const aHot = hotTaskTitles.has(String(a.task?.title || "").trim().toLowerCase());
      const bHot = hotTaskTitles.has(String(b.task?.title || "").trim().toLowerCase());
      if (aHot !== bHot) return aHot ? 1 : -1;

      return a.taskIndex - b.taskIndex;
    })
    .map(({ task }) => task);
}

function resolvePlannerFeedbackContext(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry || "").trim())
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (typeof value === "object") {
    const lines = [];
    const issueAdvisorSummary = String(value.issueAdvisorSummary || value.summary || "").trim();
    const recommendedAction = String(value.recommendedAction || "").trim();
    const nextStepGuidance = String(value.nextStepGuidance || "").trim();
    const currentNodeLabel = String(value?.dagStateSummary?.currentNode?.label || "").trim();
    const pendingNodes = Array.isArray(value?.dagStateSummary?.pendingNodes)
      ? value.dagStateSummary.pendingNodes
      : [];
    if (issueAdvisorSummary) lines.push(`issueAdvisorSummary: ${issueAdvisorSummary}`);
    if (recommendedAction) lines.push(`recommendedAction: ${recommendedAction}`);
    if (nextStepGuidance) lines.push(`nextStepGuidance: ${nextStepGuidance}`);
    if (currentNodeLabel) lines.push(`currentNode: ${currentNodeLabel}`);
    if (pendingNodes.length > 0) {
      lines.push(`pendingNodeCount: ${pendingNodes.length}`);
    }
    if (lines.length > 0) return lines.join("\n").trim();
    try {
      return JSON.stringify(value, null, 2).trim();
    } catch {
      return "";
    }
  }
  return String(value).trim();
}

export function buildPlannerSkipReasonHistogram(skipped = []) {
  const histogram = {};
  for (const entry of skipped) {
    const reason = String(entry?.reason || "unknown");
    histogram[reason] = (histogram[reason] || 0) + 1;
  }
  return histogram;
}

registerNodeType("agent.run_planner", {
  describe: () => "Run the task planner agent to generate new backlog tasks",
  schema: {
    type: "object",
    properties: {
      taskCount: { type: "number", default: 5, description: "Number of tasks to generate" },
      context: { type: "string", description: "Additional context for the planner" },
      prompt: { type: "string", description: "Optional explicit planner prompt override" },
      outputVariable: { type: "string", description: "Optional context key to store planner output text" },
      repoMap: { type: "object", description: "Optional explicit repo map context" },
      repoMapQuery: { type: "string", description: "Optional query used to select a compact repo topology" },
      repoMapFileLimit: { type: "number", default: 8, description: "Maximum repo-map files to include" },
      projectId: { type: "string" },
      dedup: { type: "boolean", default: true },
      timeoutMs: { type: "number", default: 960000, description: "Node timeout in ms (recommended >= agentTimeoutMs)" },
      agentTimeoutMs: { type: "number", default: 900000, description: "Planner agent execution timeout in ms" },
      maxRetries: { type: "number", default: 0, description: "Retry attempts for planner node" },
      retryable: { type: "boolean", default: false, description: "Whether planner node should auto-retry on failure" },
      maxRetainedEvents: { type: "number", default: WORKFLOW_AGENT_EVENT_PREVIEW_LIMIT, description: "Maximum planner events retained in run output" },
    },
  },
  async execute(node, ctx, engine) {
    const count = Number(ctx.resolve(node.config?.taskCount || 5)) || 5;
    const context = ctx.resolve(node.config?.context || "");
    const plannerFeedback = resolvePlannerFeedbackContext(ctx.data?._plannerFeedback);
    const explicitPrompt = ctx.resolve(node.config?.prompt || "");
    const outputVariable = ctx.resolve(node.config?.outputVariable || "");
    const repoMapQuery = ctx.resolve(node.config?.repoMapQuery || "");
    const configuredNodeTimeout = Number(ctx.resolve(node.config?.timeoutMs || node.config?.timeout || 0));
    const configuredAgentTimeout = Number(ctx.resolve(node.config?.agentTimeoutMs || 0));

    let agentTimeoutMs = Number.isFinite(configuredAgentTimeout) && configuredAgentTimeout > 0
      ? Math.max(10000, Math.trunc(configuredAgentTimeout))
      : 9 * 60 * 1000;
    if (!(Number.isFinite(configuredAgentTimeout) && configuredAgentTimeout > 0) && Number.isFinite(configuredNodeTimeout) && configuredNodeTimeout > 15000) {
      agentTimeoutMs = Math.max(10000, Math.trunc(configuredNodeTimeout) - 5000);
    }

    ctx.log(node.id, `Running planner for ${count} tasks`);

    // This delegates to the existing planner prompt flow
    const agentPool = engine.services?.agentPool;
    const plannerPrompt = engine.services?.prompts?.planner;
    const basePrompt = explicitPrompt || plannerPrompt || "";
    const basePromptHasPlannerFeedback = plannerFeedback
      ? basePrompt.includes("Planner feedback context:") || basePrompt.includes(plannerFeedback)
      : false;
    const effectivePlannerFeedback = basePromptHasPlannerFeedback ? "" : plannerFeedback;
    const normalizedPlannerFeedback = String(effectivePlannerFeedback || "").trim();
    const resumeFromWriteTestsFirst = /resume\s+from\s+write\s+tests\s+first/i.test(normalizedPlannerFeedback);
    const resumedPlanRequirements = resumeFromWriteTestsFirst
      ? [
        "Resume execution from the pending Write Tests First checkpoint.",
        "Do not regenerate completed stages that occurred before Write Tests First.",
        `Return exactly ${count} tasks in a single JSON object: {\"tasks\":[...]}.`,
        "The first task must write or expand tests before any implementation work.",
        "Each task must include title, description, files, tests, and api_contracts.",
      ].join("\n")
      : "";
    const promptHasRepoMap = hasRepoMapContext(basePrompt);
    const resolvedRepoMap = node.config?.repoMap || ctx.data?.repoMap || null;
    const hasResolvedRepoMap = Boolean(
      resolvedRepoMap
      && typeof resolvedRepoMap === "object"
      && (
        String(resolvedRepoMap.root || resolvedRepoMap.repoRoot || "").trim()
        || (Array.isArray(resolvedRepoMap.files) && resolvedRepoMap.files.some((entry) => String(entry?.path || "").trim()))
      )
    );
    const resolvedRepoMapFileLimit = ctx.resolve(node.config?.repoMapFileLimit ?? null);
    const repoMapFileLimit =
      resolvedRepoMapFileLimit == null || resolvedRepoMapFileLimit === ""
        ? 8
        : (Number(resolvedRepoMapFileLimit) || 8);
    const repoMapChangedFiles =
      (Array.isArray(ctx.data?.changedFiles) ? ctx.data.changedFiles : null) ||
      (Array.isArray(ctx.data?.task?.changedFiles) ? ctx.data.task.changedFiles : null) ||
      [];
    if ((node.config?.repoMap || repoMapQuery) && !promptHasRepoMap && !hasResolvedRepoMap) {
      try {
        await ensureContextIndexFresh({
          rootDir: ctx.data?.repoRoot || process.cwd(),
          changedFiles: repoMapChangedFiles,
          useTreeSitter: false,
          useZoekt: false,
        });
      } catch (error) {
        ctx.log(node.id, `Context index refresh skipped (non-fatal): ${error?.message || error}`);
      }
    }
    const repoTopologyContext = (node.config?.repoMap || repoMapQuery)
      && !promptHasRepoMap
      ? buildRepoTopologyContext({
        repoMap: resolvedRepoMap,
        repoMapFileLimit,
        repoMapQuery,
        query: [context, explicitPrompt, plannerPrompt].filter(Boolean).join(" "),
        prompt: explicitPrompt || plannerPrompt || "",
        userMessage: context,
        taskTitle: ctx.data?.taskTitle || ctx.data?.task?.title || "",
        taskDescription:
          ctx.data?.taskDescription ||
          ctx.data?.task?.description ||
          ctx.data?.task?.body ||
          ctx.data?.taskDetail?.description ||
          ctx.data?.taskInfo?.description ||
          "",
        changedFiles: repoMapChangedFiles,
        cwd: process.cwd(),
        repoRoot: ctx.data?.repoRoot || process.cwd(),
      })
      : "";
    // Enforce strict output instructions to ensure the downstream materialize node
    // can parse the planner output. The planner prompt already defines the contract,
    // but we reinforce it here to prevent agents from wrapping output in prose.
    let skillbookGuidance = normalizeSkillbookGuidancePayload(ctx.data?._skillbookGuidance);
    const repoHasKnowledgeStore =
      existsSync(resolve(ctx.data?.repoRoot || process.cwd(), ".git"))
      || existsSync(resolve(ctx.data?.repoRoot || process.cwd(), ".bosun"));
    if (!skillbookGuidance && repoHasKnowledgeStore) {
      try {
        skillbookGuidance = await resolveReusableSkillbookGuidance(ctx, {
          repoRoot: ctx.data?.repoRoot || process.cwd(),
          workflowId: ctx.data?._workflowId || "",
          category: "strategy",
          status: "promoted",
          query: [
            ctx.data?.taskTitle,
            ctx.data?.taskDescription,
            context,
            explicitPrompt,
            plannerPrompt,
          ].filter(Boolean).join(" "),
          limit: 3,
        });
        if (skillbookGuidance?.matched > 0) {
          ctx.data._skillbookGuidance = skillbookGuidance;
        }
      } catch (error) {
        ctx.log(node.id, `Reusable skillbook guidance retrieval failed (non-fatal): ${error?.message || error}`);
      }
    }
    const skillbookPromptContext = buildSkillbookPromptContext(skillbookGuidance);
    if (skillbookPromptContext) {
      ctx.data._taskSkillbookGuidance = skillbookGuidance;
    }

    const outputEnforcement =
      `\n\n## CRITICAL OUTPUT REQUIREMENT\n` +
      `Generate exactly ${count} new tasks.\n` +
      ((context || normalizedPlannerFeedback || resumedPlanRequirements || repoTopologyContext || skillbookPromptContext)
        ? `${[
          context,
          normalizedPlannerFeedback ? `Planner feedback context:\n${normalizedPlannerFeedback}` : "",
          resumedPlanRequirements ? `Resume requirements:\n${resumedPlanRequirements}` : "",
          repoTopologyContext,
          skillbookPromptContext,
        ].filter(Boolean).join("\n\n")}\n\n`
        : "\n") +
      `Your response MUST be a single fenced JSON block with shape { "tasks": [...] }.\n` +
      `Do NOT include status updates, analysis notes, tool commentary, questions, or prose outside the JSON block.\n` +
      `The downstream system will parse your output as JSON — any extra text will cause task creation to fail.`;
    const promptText = basePrompt
      ? `${basePrompt}${outputEnforcement}`
      : "";

    if (agentPool?.launchEphemeralThread && promptText) {
      const harnessAgentService = createHarnessAgentService({ agentPool });
      let streamEventCount = 0;
      let lastStreamLog = "";
      const streamLines = [];
      const startedAt = Date.now();
      const maxRetainedEvents = Number.isFinite(Number(node.config?.maxRetainedEvents))
        ? Math.max(10, Math.min(500, Math.trunc(Number(node.config.maxRetainedEvents))))
        : WORKFLOW_AGENT_EVENT_PREVIEW_LIMIT;
      const launchExtra = {
        onEvent: (event) => {
          try {
            const line = summarizeAgentStreamEvent(event);
            if (!line || line === lastStreamLog) return;
            lastStreamLog = line;
            streamEventCount += 1;
            if (streamLines.length >= maxRetainedEvents) {
              streamLines.shift();
            }
            streamLines.push(line);
            ctx.log(node.id, line);
          } catch {
            // Stream callbacks must never crash workflow execution.
          }
        },
      };

      const heartbeat = setInterval(() => {
        const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        ctx.log(
          node.id,
          `Planner still running (${elapsedSec}s elapsed, streamEvents=${streamEventCount})`,
        );
      }, WORKFLOW_AGENT_HEARTBEAT_MS);

      let result;
      try {
        result = await harnessAgentService.launchEphemeralThread(
          promptText,
          process.cwd(),
          agentTimeoutMs,
          launchExtra,
        );
      } finally {
        clearInterval(heartbeat);
      }

      ctx.log(
        node.id,
        `Planner completed: success=${result.success} streamEvents=${streamEventCount}`,
      );

      const threadId = result.threadId || result.sessionId || null;
      if (threadId) {
        ctx.data.sessionId = threadId;
        ctx.data.threadId = threadId;
      }

      if (outputVariable) {
        ctx.data[outputVariable] = String(result.output || "").trim();
      }
      const digest = buildAgentExecutionDigest(result, streamLines, maxRetainedEvents);
      return {
        success: result.success,
        output: result.output,
        summary: digest.summary,
        narrative: digest.narrative,
        thoughts: digest.thoughts,
        stream: digest.stream,
        taskCount: count,
        sdk: result.sdk,
        items: digest.items,
        itemCount: digest.itemCount,
        omittedItemCount: digest.omittedItemCount,
        threadId,
        sessionId: threadId,
      };
    }

    return {
      success: false,
      error: explicitPrompt
        ? "Agent pool not available"
        : "Agent pool or planner prompt not available",
    };
  },
});

registerNodeType("agent.evidence_collect", {
  describe: () => "Collect all evidence from .bosun/evidence for review",
  schema: {
    type: "object",
    properties: {
      evidenceDir: { type: "string", default: ".bosun/evidence" },
      types: { type: "array", items: { type: "string" }, default: ["png", "jpg", "json", "log", "txt"] },
    },
  },
  async execute(node, ctx) {
    const dir = ctx.resolve(node.config?.evidenceDir || ".bosun/evidence");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      return { files: [], count: 0, dir };
    }
    const { readdirSync, statSync } = await import("node:fs");
    const types = node.config?.types || ["png", "jpg", "json", "log", "txt"];
    const files = readdirSync(dir)
      .filter((f) => {
        const ext = f.split(".").pop()?.toLowerCase();
        return types.includes(ext);
      })
      .map((f) => ({
        name: f,
        path: resolve(dir, f),
        size: statSync(resolve(dir, f)).size,
        type: f.split(".").pop()?.toLowerCase(),
      }));

    return { files, count: files.length, dir };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
//  FLOW CONTROL — Gates, barriers, and routing
// ═══════════════════════════════════════════════════════════════════════════
