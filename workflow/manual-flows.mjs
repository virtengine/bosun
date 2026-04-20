// CLAUDE:SUMMARY — manual-flows
// Backend for Manual Run Flows — one-shot templates with user-configurable forms
// that trigger codebase-wide transformations (audit/annotate, skill generation,
// config preparation). Each template defines form fields, validation, and an
// executor function. Runs are persisted to .bosun/manual-flows/runs/.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executeAnnotationAudit } from "./manual-flow-audit.mjs";
import { resolveResearchEvidenceSidecarConfig } from "./research-evidence-sidecar.mjs";
import { RESEARCH_EVIDENCE_AGENT_TEMPLATE } from "../workflow-templates/research-evidence.mjs";
import { WorkflowExecutionLedger } from "./execution-ledger.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Types ────────────────────────────────────────────────────────────────────
/**
 * @typedef {Object} ManualFlowField
 * @property {string}   id          — unique field key
 * @property {string}   label       — display label
 * @property {"text"|"textarea"|"select"|"toggle"|"number"} type
 * @property {string}   [placeholder]
 * @property {*}        [defaultValue]
 * @property {boolean}  [required]
 * @property {Array<{label:string, value:string}>} [options] — for select fields
 * @property {string}   [helpText]
 */

/**
 * @typedef {Object} ManualFlowTemplate
 * @property {string}   id
 * @property {string}   name
 * @property {string}   description
 * @property {string}   icon         — icon key for UI
 * @property {string}   category     — e.g. "audit", "transform", "generate"
 * @property {ManualFlowField[]} fields
 * @property {string[]} tags
 * @property {boolean}  [builtin]    — true for built-in templates
 * @property {string}   [version]
 */

/**
 * @typedef {Object} ManualFlowRun
 * @property {string}   id
 * @property {string}   templateId
 * @property {string}   templateName
 * @property {Object}   formValues   — user-submitted field values
 * @property {"pending"|"running"|"completed"|"failed"} status
 * @property {string}   startedAt
 * @property {string}   [completedAt]
 * @property {Object}   [result]     — executor output
 * @property {string}   [error]
 * @property {Object}   [metadata]
 */

// ── Directories ──────────────────────────────────────────────────────────────

function getFlowsDir(rootDir) {
  return resolve(rootDir, ".bosun", "manual-flows");
}

function getRunsDir(rootDir) {
  return resolve(getFlowsDir(rootDir), "runs");
}

function getTemplatesDir(rootDir) {
  return resolve(getFlowsDir(rootDir), "templates");
}

function getWorkflowRunsDir(rootDir) {
  return resolve(rootDir, ".bosun", "workflow-runs");
}

function ensureDirs(rootDir) {
  mkdirSync(getRunsDir(rootDir), { recursive: true });
  mkdirSync(getTemplatesDir(rootDir), { recursive: true });
}

function getManualFlowWorkflowId(templateId) {
  const src = String(templateId || "custom").trim();
  let result = "";
  for (const ch of src) {
    const lower = ch.toLowerCase();
    if (
      (lower >= "a" && lower <= "z") ||
      (lower >= "0" && lower <= "9") ||
      ch === "_" || ch === "." || ch === "-"
    ) {
      result += ch;
    } else if (result.length > 0 && result[result.length - 1] !== "-") {
      result += "-";
    }
  }
  while (result.startsWith("-")) result = result.slice(1);
  while (result.endsWith("-")) result = result.slice(0, -1);
  return `manual-flow.${result || "custom"}`;
}

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return null;
  }
}

function uniqueTextList(values = []) {
  const seen = new Set();
  const normalized = [];
  const list = Array.isArray(values) ? values : [values];
  for (const value of list) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    normalized.push(text);
  }
  return normalized;
}

function normalizeIsoTimestamp(value, fallback = null) {
  const text = String(value || "").trim();
  if (text) return text;
  return fallback || new Date().toISOString();
}

function toEpochMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function mapManualFlowStatusToLedgerStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "failed") return "failed";
  if (normalized === "running") return "running";
  if (normalized === "completed") return "completed";
  return "pending";
}

function createManualFlowTimelineEvent(eventType, payload = {}) {
  const timestamp = normalizeIsoTimestamp(payload.timestamp);
  return {
    id: String(payload.id || `mfe-${randomUUID()}`),
    timestamp,
    eventType: String(eventType || "event").trim() || "event",
    status: payload.status ? String(payload.status).trim() : undefined,
    message: payload.message ? String(payload.message).trim() : undefined,
    stepId: payload.stepId ? String(payload.stepId).trim() : undefined,
    stepTitle: payload.stepTitle ? String(payload.stepTitle).trim() : undefined,
    lane: payload.lane ? String(payload.lane).trim() : undefined,
    taskId: payload.taskId ? String(payload.taskId).trim() : undefined,
    workflowRunId: payload.workflowRunId ? String(payload.workflowRunId).trim() : undefined,
    details: payload.details && typeof payload.details === "object" ? cloneJson(payload.details) : undefined,
  };
}

function normalizeManualFlowStep(step = {}, fallbackOrder = 0) {
  const dependsOnStepIds = uniqueTextList(step.dependsOnStepIds || step.dependsOn || []);
  const status = String(step.status || "").trim().toLowerCase();
  const normalizedStatus = status || (dependsOnStepIds.length > 0 ? "blocked" : "ready");
  return {
    id: String(step.id || `step-${fallbackOrder || 1}`).trim(),
    title: String(step.title || step.label || `Step ${fallbackOrder || 1}`).trim(),
    prompt: String(step.prompt || step.instructions || "").trim(),
    order: Number.isFinite(Number(step.order)) ? Number(step.order) : fallbackOrder,
    lane: String(step.lane || step.agent || "").trim().toUpperCase() || null,
    status: normalizedStatus,
    dependsOnStepIds,
    ready: normalizedStatus === "ready",
    taskId: step.taskId ? String(step.taskId).trim() : null,
    taskTitle: step.taskTitle ? String(step.taskTitle).trim() : null,
    workflowRunId: step.workflowRunId ? String(step.workflowRunId).trim() : null,
    summary: step.summary ? String(step.summary).trim() : "",
  };
}

function normalizeManualFlowObservability(raw = {}, run = {}) {
  const timeline = Array.isArray(raw.timeline)
    ? raw.timeline
        .map((entry) => createManualFlowTimelineEvent(entry?.eventType || "event", entry || {}))
        .sort((left, right) => toEpochMs(left.timestamp) - toEpochMs(right.timestamp))
    : [];
  const steps = Array.isArray(raw.steps)
    ? raw.steps.map((step, index) => normalizeManualFlowStep(step, index + 1))
    : [];
  const taskIds = uniqueTextList([
    ...(Array.isArray(raw?.related?.taskIds) ? raw.related.taskIds : []),
    ...steps.map((step) => step.taskId),
  ]);
  const workflowRunIds = uniqueTextList([
    ...(Array.isArray(raw?.related?.workflowRunIds) ? raw.related.workflowRunIds : []),
    ...steps.map((step) => step.workflowRunId),
  ]);
  const laneIds = uniqueTextList(steps.map((step) => step.lane).filter(Boolean));
  const statusCounts = {
    ready: 0,
    blocked: 0,
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    pending: 0,
  };
  for (const step of steps) {
    if (statusCounts[step.status] === undefined) {
      statusCounts.pending += 1;
    } else {
      statusCounts[step.status] += 1;
    }
  }
  const lastEventAt = timeline.at(-1)?.timestamp || raw.lastEventAt || run.completedAt || run.startedAt || null;
  return {
    version: 1,
    queueStrategy: String(raw.queueStrategy || "").trim() || null,
    parseMode: String(raw.parseMode || "").trim() || null,
    planTitle: String(raw.planTitle || run.templateName || "").trim() || null,
    objective: String(raw.objective || "").trim() || null,
    updatedAt: normalizeIsoTimestamp(raw.updatedAt || lastEventAt || run.startedAt),
    lastEventAt: lastEventAt ? normalizeIsoTimestamp(lastEventAt) : null,
    timeline,
    steps,
    related: {
      taskIds,
      workflowRunIds,
    },
    summary: {
      eventCount: timeline.length,
      stepCount: steps.length,
      readyStepCount: statusCounts.ready,
      blockedStepCount: statusCounts.blocked,
      queuedStepCount: statusCounts.queued,
      runningStepCount: statusCounts.running,
      completedStepCount: statusCounts.completed,
      failedStepCount: statusCounts.failed,
      pendingStepCount: statusCounts.pending,
      laneCount: laneIds.length,
      taskCount: taskIds.length,
      workflowRunCount: workflowRunIds.length,
    },
  };
}

function normalizeManualFlowRun(run = {}) {
  const normalized = {
    ...run,
    id: String(run.id || "").trim(),
    templateId: String(run.templateId || "").trim(),
    templateName: String(run.templateName || run.templateId || "Manual Flow").trim(),
    workflowId: String(run.workflowId || getManualFlowWorkflowId(run.templateId)).trim(),
    runKind: "manual-flow",
    status: String(run.status || "pending").trim().toLowerCase() || "pending",
    startedAt: normalizeIsoTimestamp(run.startedAt),
    completedAt: run.completedAt ? normalizeIsoTimestamp(run.completedAt) : null,
    result: run.result ?? null,
    error: run.error ?? null,
    metadata: normalizeManualFlowRunMetadata(run.metadata) || null,
  };
  normalized.observability = normalizeManualFlowObservability(run.observability || {}, normalized);
  return normalized;
}

function addManualFlowEvent(run, eventType, payload = {}) {
  const normalized = normalizeManualFlowRun(run);
  const event = createManualFlowTimelineEvent(eventType, {
    ...payload,
    status: payload.status || normalized.status,
  });
  normalized.observability.timeline = [
    ...normalized.observability.timeline,
    event,
  ];
  normalized.observability = normalizeManualFlowObservability({
    ...normalized.observability,
    timeline: normalized.observability.timeline,
  }, normalized);
  return normalized;
}

function setManualFlowPlan(run, plan = {}) {
  const normalized = normalizeManualFlowRun(run);
  normalized.observability = normalizeManualFlowObservability({
    ...normalized.observability,
    queueStrategy: plan.queueStrategy || normalized.observability.queueStrategy,
    parseMode: plan.parseMode || normalized.observability.parseMode,
    planTitle: plan.planTitle || normalized.observability.planTitle,
    objective: plan.objective || normalized.observability.objective,
    steps: Array.isArray(plan.steps) ? plan.steps : normalized.observability.steps,
    related: {
      taskIds: uniqueTextList([
        ...(normalized.observability.related?.taskIds || []),
        ...(plan.relatedTaskIds || []),
      ]),
      workflowRunIds: uniqueTextList([
        ...(normalized.observability.related?.workflowRunIds || []),
        ...(plan.relatedWorkflowRunIds || []),
      ]),
    },
  }, normalized);
  return normalized;
}

function syncManualFlowLedger(run, rootDir, eventType = null, payload = {}) {
  try {
    const normalized = normalizeManualFlowRun(run);
    const ledger = new WorkflowExecutionLedger({ runsDir: getWorkflowRunsDir(rootDir) });
    ledger.ensureRun({
      runId: normalized.id,
      workflowId: normalized.workflowId,
      workflowName: normalized.templateName,
      runKind: normalized.runKind,
      startedAt: normalized.startedAt,
      endedAt: normalized.completedAt || null,
      status: mapManualFlowStatusToLedgerStatus(normalized.status),
      actor: "manual-flow",
    });
    if (!eventType) return;
    ledger.appendEvent({
      runId: normalized.id,
      workflowId: normalized.workflowId,
      workflowName: normalized.templateName,
      runKind: normalized.runKind,
      category: "workflow",
      eventType,
      status: mapManualFlowStatusToLedgerStatus(normalized.status),
      timestamp: normalizeIsoTimestamp(payload.timestamp),
      summary: String(payload.message || payload.summary || "").trim() || null,
      reason: String(payload.reason || "").trim() || null,
      executionKind: payload.executionKind || null,
      executionLabel: payload.stepTitle || null,
      childTaskId: payload.taskId || null,
      childRunId: payload.workflowRunId || null,
      workspaceId: normalized.metadata?.workspaceId || null,
      repoRoot: normalized.metadata?.workspaceDir || rootDir,
      surface: "manual-flow",
      channel: "manual-flow",
      meta: {
        manualFlowTemplateId: normalized.templateId,
        manualFlowRunId: normalized.id,
        stepId: payload.stepId || null,
        lane: payload.lane || null,
        order: payload.order || null,
      },
    });
  } catch (err) {
    console.warn(`[manual-flows] ledger sync failed for ${run?.id || "unknown"}: ${String(err?.message || err)}`);
  }
}

// ── Built-in Templates ───────────────────────────────────────────────────────

/** @type {ManualFlowTemplate[]} */
export const BUILTIN_FLOW_TEMPLATES = [
  {
    id: "codebase-annotation-audit",
    name: "Codebase Annotation Audit",
    description:
      "Systematically audit & annotate the codebase with CLAUDE:SUMMARY and CLAUDE:WARN comments so future AI agents navigate 4× faster. Documentation-only — no code behavior changes.",
    icon: "search",
    category: "audit",
    tags: ["audit", "annotation", "documentation", "onboarding"],
    builtin: true,
    version: "1.0.0",
    fields: [
      {
        id: "targetDir",
        label: "Target Directory",
        type: "text",
        placeholder: "src/  (leave blank for entire repo)",
        defaultValue: "",
        required: false,
        helpText: "Relative path from repo root. Leave empty to audit the entire repository.",
      },
      {
        id: "fileExtensions",
        label: "File Extensions",
        type: "text",
        placeholder: ".mjs, .js, .ts, .py",
        defaultValue: ".mjs, .js, .ts, .tsx, .jsx, .py",
        required: false,
        helpText: "Comma-separated list of extensions to audit. Leave empty for all source files.",
      },
      {
        id: "skipGenerated",
        label: "Skip Generated Files",
        type: "toggle",
        defaultValue: true,
        helpText: "Skip lockfiles, build output, .min.js, etc.",
      },
      {
        id: "phases",
        label: "Phases to Run",
        type: "select",
        defaultValue: "all",
        options: [
          { label: "All Phases (1-6)", value: "all" },
          { label: "Inventory Only (Phase 1)", value: "inventory" },
          { label: "Summaries Only (Phase 2)", value: "summaries" },
          { label: "Warnings Only (Phase 3)", value: "warnings" },
          { label: "Manifest Audit (Phase 4)", value: "manifest" },
          { label: "Conformity Check (Phase 5)", value: "conformity" },
          { label: "Regeneration Schedule (Phase 6)", value: "schedule" },
        ],
        required: true,
        helpText: "Which audit phases to execute. Run 'All' for a full audit.",
      },
      {
        id: "dryRun",
        label: "Dry Run",
        type: "toggle",
        defaultValue: false,
        helpText: "Preview what would be annotated without writing any files.",
      },
      {
        id: "commitMessage",
        label: "Commit Message",
        type: "text",
        placeholder: "docs(audit): annotate codebase",
        defaultValue: "docs(audit): annotate codebase with CLAUDE:SUMMARY and CLAUDE:WARN",
        required: false,
        helpText: "Commit message for the annotation changes. Leave empty to skip auto-commit.",
      },
    ],
  },
  {
    id: "generate-skills",
    name: "Generate Agent Skills",
    description:
      "Analyze the codebase and auto-generate Bosun skill files (.md) capturing key patterns, domain knowledge, and pitfalls for future agents.",
    icon: "book",
    category: "generate",
    tags: ["skills", "knowledge", "patterns", "automation"],
    builtin: true,
    version: "1.0.0",
    fields: [
      {
        id: "targetModules",
        label: "Target Modules",
        type: "text",
        placeholder: "e.g. auth, payments, api  (blank = all)",
        defaultValue: "",
        required: false,
        helpText: "Comma-separated module/directory names to analyze.",
      },
      {
        id: "skillScope",
        label: "Skill Scope",
        type: "select",
        defaultValue: "global",
        options: [
          { label: "Global (shared across workspaces)", value: "global" },
          { label: "Workspace-local", value: "workspace" },
        ],
        required: true,
      },
      {
        id: "includeExamples",
        label: "Include Code Examples",
        type: "toggle",
        defaultValue: true,
        helpText: "Embed short code snippets demonstrating patterns.",
      },
      {
        id: "maxSkills",
        label: "Max Skills to Generate",
        type: "number",
        defaultValue: 10,
        required: false,
        helpText: "Maximum number of skill files to create in one run.",
      },
    ],
  },
  {
    id: "prepare-agents-md",
    name: "Prepare AGENTS.md",
    description:
      "Generate or update the AGENTS.md file at repo root with accurate build commands, module inventory, environment variables, and project conventions.",
    icon: "file-text",
    category: "generate",
    tags: ["agents", "documentation", "onboarding", "config"],
    builtin: true,
    version: "1.0.0",
    fields: [
      {
        id: "repoRoot",
        label: "Repository Root",
        type: "text",
        placeholder: "(current workspace)",
        defaultValue: "",
        required: false,
        helpText: "Absolute path to repo root. Defaults to current workspace.",
      },
      {
        id: "includeEnvVars",
        label: "Include Environment Variables",
        type: "toggle",
        defaultValue: true,
        helpText: "Document all .env / env var references found in the codebase.",
      },
      {
        id: "includeModuleInventory",
        label: "Include Module Inventory",
        type: "toggle",
        defaultValue: true,
        helpText: "List all top-level modules with 1-line descriptions.",
      },
      {
        id: "mode",
        label: "Mode",
        type: "select",
        defaultValue: "update",
        options: [
          { label: "Update existing AGENTS.md", value: "update" },
          { label: "Generate from scratch", value: "generate" },
        ],
        required: true,
      },
    ],
  },
  {
    id: "codebase-health-check",
    name: "Codebase Health Check",
    description:
      "Run a comprehensive health check: dead code detection, dependency audit, circular imports, and test coverage gaps.",
    icon: "activity",
    category: "audit",
    tags: ["health", "quality", "dead-code", "dependencies", "coverage"],
    builtin: true,
    version: "1.0.0",
    fields: [
      {
        id: "checks",
        label: "Checks to Run",
        type: "select",
        defaultValue: "all",
        options: [
          { label: "All Checks", value: "all" },
          { label: "Dead Code Detection", value: "dead-code" },
          { label: "Dependency Audit", value: "deps" },
          { label: "Circular Import Detection", value: "circular" },
          { label: "Test Coverage Gaps", value: "coverage" },
        ],
        required: true,
      },
      {
        id: "targetDir",
        label: "Target Directory",
        type: "text",
        placeholder: "src/  (leave blank for entire repo)",
        defaultValue: "",
        required: false,
      },
      {
        id: "outputFormat",
        label: "Output Format",
        type: "select",
        defaultValue: "json",
        options: [
          { label: "JSON Report", value: "json" },
          { label: "Markdown Report", value: "markdown" },
          { label: "Both", value: "both" },
        ],
        required: true,
      },
    ],
  },
  {
    id: "context-index-full",
    name: "Context Index (Full)",
    description:
      "Build a Bosun-native context index (SQLite + optional tree-sitter + optional Zoekt) and generate agent-first index artifacts.",
    icon: "database",
    category: "audit",
    tags: ["context", "index", "sqlite", "agents"],
    builtin: true,
    version: "1.0.0",
    fields: [
      {
        id: "includeTests",
        label: "Include Tests",
        type: "toggle",
        defaultValue: true,
        helpText: "Include test/spec files in the context index.",
      },
      {
        id: "maxFileBytes",
        label: "Max File Size (bytes)",
        type: "number",
        defaultValue: 800000,
        helpText: "Skip files larger than this size when indexing.",
      },
      {
        id: "useTreeSitter",
        label: "Use tree-sitter",
        type: "toggle",
        defaultValue: true,
        helpText: "Use tree-sitter tags for symbol extraction when available.",
      },
      {
        id: "useZoekt",
        label: "Use Zoekt",
        type: "toggle",
        defaultValue: true,
        helpText: "Build an optional Zoekt index when zoekt-index is installed.",
      },
    ],
  },
  {
    id: "queued-execution-plan",
    name: "Queued Execution Plan",
    description:
      "Turn a large implementation plan into a Bosun-native queued run with step-level observability, lane ownership, dependency edges, and optional task-graph creation.",
    icon: "workflow",
    category: "planning",
    tags: ["planning", "queue", "dag", "sprint", "subtasks", "agents"],
    builtin: true,
    version: "1.0.0",
    fields: [
      {
        id: "planTitle",
        label: "Plan Title",
        type: "text",
        placeholder: "Bosun Internal Harness Adoption",
        defaultValue: "",
        required: true,
        helpText: "Human-readable title for the queued plan and any tasks created from it.",
      },
      {
        id: "objective",
        label: "Objective",
        type: "textarea",
        placeholder: "Describe the end state this queue is intended to deliver.",
        defaultValue: "",
        required: true,
        helpText: "Used in observability, run summaries, and generated task descriptions.",
      },
      {
        id: "planDocument",
        label: "Plan Document",
        type: "textarea",
        placeholder: "Paste headings like ## Step 1 A: ... with the prompt body beneath each heading.",
        defaultValue: "",
        required: true,
        helpText:
          "Accepts the 12-step queue format used in Bosun planning docs, or a JSON array of step objects. " +
          "Headings like '## Step 1 A: Title' are parsed automatically.",
      },
      {
        id: "queueStrategy",
        label: "Queue Strategy",
        type: "select",
        defaultValue: "agent-lane-queue",
        options: [
          { label: "Agent Lane Queue", value: "agent-lane-queue" },
          { label: "Global Sequential", value: "global-sequential" },
          { label: "Explicit Dependencies Only", value: "explicit-only" },
        ],
        required: true,
        helpText: "Controls default dependencies when the plan document does not declare them explicitly.",
      },
      {
        id: "createTasks",
        label: "Create Task Graph",
        type: "toggle",
        defaultValue: true,
        helpText: "Create Bosun tasks and dependency edges for each parsed step when task APIs are available.",
      },
      {
        id: "taskPriority",
        label: "Task Priority",
        type: "select",
        defaultValue: "high",
        options: [
          { label: "Critical", value: "critical" },
          { label: "High", value: "high" },
          { label: "Medium", value: "medium" },
          { label: "Low", value: "low" },
        ],
        required: true,
      },
      {
        id: "sprintId",
        label: "Sprint ID",
        type: "text",
        placeholder: "optional-sprint-id",
        defaultValue: "",
        required: false,
        helpText: "Optional sprint assignment applied to created step tasks when Bosun sprint APIs are available.",
      },
    ],
  },
  {
    id: "research-agent",
    name: "Research Agent (Aletheia-Style)",
    description:
      "Launch an iterative research agent inspired by Google DeepMind's Aletheia. " +
      "Generates a candidate solution, verifies it with an independent model, " +
      "and iterates through revision or full regeneration cycles until convergence. " +
      "Supports literature search, configurable iteration limits, and multi-domain research.",
    icon: "microscope",
    category: "research",
    tags: ["research", "aletheia", "convergence", "verification", "ai-agent"],
    builtin: true,
    version: "1.0.0",
    fields: [
      {
        id: "problem",
        label: "Research Problem",
        type: "textarea",
        placeholder: "e.g. Prove that for every ε > 0 there exists a δ > 0 such that...",
        defaultValue: "",
        required: true,
        helpText: "The research problem or question to investigate. Be as specific as possible.",
      },
      {
        id: "domain",
        label: "Domain",
        type: "select",
        defaultValue: "mathematics",
        options: [
          { label: "Mathematics", value: "mathematics" },
          { label: "Computer Science", value: "computer-science" },
          { label: "Physics", value: "physics" },
          { label: "Biology", value: "biology" },
          { label: "Chemistry", value: "chemistry" },
          { label: "Engineering", value: "engineering" },
        ],
        required: true,
        helpText: "Research domain — guides literature search and agent prompts.",
      },
      {
        id: "maxIterations",
        label: "Max Iterations",
        type: "number",
        defaultValue: 10,
        required: false,
        helpText: "Maximum generate→verify→revise cycles before stopping (1-50).",
      },
      {
        id: "searchLiterature",
        label: "Search Literature First",
        type: "toggle",
        defaultValue: true,
        helpText: "Run a web search for relevant papers before generating a solution.",
      },
      {
        id: "useEvidenceSidecar",
        label: "Use Evidence Sidecar",
        type: "toggle",
        defaultValue: true,
        helpText:
          "Build a structured scientific evidence bundle before generation. " +
          "Bosun remains the orchestrator; only reviewed findings are promoted into shared knowledge.",
      },
      {
        id: "evidenceMode",
        label: "Evidence Mode",
        type: "select",
        defaultValue: "answer",
        options: [
          { label: "Answer Grounding", value: "answer" },
          { label: "Summarize Evidence", value: "summarize" },
          { label: "Contradiction Detection", value: "contradictions" },
          { label: "Evidence Inventory Only", value: "evidence-only" },
        ],
        required: true,
        helpText: "Controls how the scientific evidence bundle is assembled and prioritized.",
      },
      {
        id: "corpusPaths",
        label: "Evidence Corpus Paths",
        type: "textarea",
        placeholder: "docs/research\npapers/notes.md",
        defaultValue: "",
        required: false,
        helpText:
          "Optional newline- or comma-separated local text sources. PDFs remain excluded from the Bosun context index; " +
          "use sidecar-ready text or extracted notes here instead.",
      },
      {
        id: "maxEvidenceSources",
        label: "Max Evidence Sources",
        type: "number",
        defaultValue: 6,
        required: false,
        helpText: "Maximum evidence items retained in the sidecar bundle (1-20).",
      },
      {
        id: "promoteReviewedFindings",
        label: "Promote Reviewed Findings",
        type: "toggle",
        defaultValue: true,
        helpText:
          "When verification returns CORRECT, write a concise reviewed finding into shared knowledge. " +
          "Raw sidecar artifacts stay outside shared knowledge.",
      },
      {
        id: "sidecarCommand",
        label: "External Sidecar Command",
        type: "text",
        placeholder: "uv run ace-sidecar --mode research",
        defaultValue: "",
        required: false,
        helpText:
          "Optional command that reads JSON from stdin and returns structured evidence JSON. " +
          "Leave blank to use Bosun-local evidence bundling only.",
      },
      {
        id: "executionMode",
        label: "Execution Mode",
        type: "select",
        defaultValue: "workflow",
        options: [
          { label: "Workflow Engine (back-edge loops)", value: "workflow" },
          { label: "Task Dispatch (agent picks up)", value: "task" },
        ],
        required: true,
        helpText: "Workflow mode runs the full generate→verify→revise loop automatically. Task mode dispatches to an available agent.",
      },
    ],
  },
  {
    id: "release-notes-draft",
    name: "Release Notes Draft",
    description:
      "Create structured release notes from recent commits/PRs with optional audience-specific tone and risk highlights.",
    icon: "book",
    category: "generate",
    tags: ["release", "notes", "changelog", "documentation"],
    builtin: true,
    version: "1.0.0",
    fields: [
      {
        id: "baseRef",
        label: "Base Ref",
        type: "text",
        placeholder: "e.g. main or v1.2.0",
        defaultValue: "main",
        required: true,
      },
      {
        id: "targetRef",
        label: "Target Ref",
        type: "text",
        placeholder: "e.g. HEAD or release branch",
        defaultValue: "HEAD",
        required: true,
      },
      {
        id: "audience",
        label: "Audience",
        type: "select",
        defaultValue: "engineering",
        options: [
          { label: "Engineering", value: "engineering" },
          { label: "Product", value: "product" },
          { label: "Customer-facing", value: "customer" },
        ],
        required: true,
      },
      {
        id: "includeRiskSection",
        label: "Include Risk/Breaking Changes",
        type: "toggle",
        defaultValue: true,
      },
    ],
  },
  {
    id: "pre-pr-readiness",
    name: "Pre-PR Readiness Check",
    description:
      "Prepare a change for PR by validating scope, tests, docs impact, and reviewer-facing summary.",
    icon: "check",
    category: "transform",
    tags: ["pr", "review", "quality", "delivery"],
    builtin: true,
    version: "1.0.0",
    fields: [
      {
        id: "changeSummary",
        label: "Change Summary",
        type: "textarea",
        placeholder: "What changed and why",
        defaultValue: "",
        required: true,
      },
      {
        id: "runTests",
        label: "Run Targeted Tests",
        type: "toggle",
        defaultValue: true,
      },
      {
        id: "runBuild",
        label: "Run Build",
        type: "toggle",
        defaultValue: true,
      },
      {
        id: "includeChecklist",
        label: "Include Reviewer Checklist",
        type: "toggle",
        defaultValue: true,
      },
    ],
  },
  {
    id: "bug-repro-investigation",
    name: "Bug Repro & Investigation",
    description:
      "Build a focused investigation task for reproducing an issue, narrowing root cause, and proposing a safe fix path.",
    icon: "bug",
    category: "audit",
    tags: ["bug", "debug", "investigation", "root-cause"],
    builtin: true,
    version: "1.0.0",
    fields: [
      {
        id: "issueDescription",
        label: "Issue Description",
        type: "textarea",
        placeholder: "Observed behavior, expected behavior, scope",
        defaultValue: "",
        required: true,
      },
      {
        id: "affectedArea",
        label: "Affected Area",
        type: "text",
        placeholder: "e.g. ui/tabs/manual-flows.js",
        defaultValue: "",
        required: false,
      },
      {
        id: "severity",
        label: "Severity",
        type: "select",
        defaultValue: "medium",
        options: [
          { label: "Low", value: "low" },
          { label: "Medium", value: "medium" },
          { label: "High", value: "high" },
          { label: "Critical", value: "critical" },
        ],
        required: true,
      },
    ],
  },
  {
    id: "test-hardening-pass",
    name: "Test Hardening Pass",
    description:
      "Identify fragile test areas and prepare a deterministic hardening plan with targeted improvements.",
    icon: "shield",
    category: "reliability",
    tags: ["tests", "reliability", "deterministic", "quality"],
    builtin: true,
    version: "1.0.0",
    fields: [
      {
        id: "testTarget",
        label: "Test Target",
        type: "text",
        placeholder: "e.g. tests/manual-flows.test.mjs or tests/**",
        defaultValue: "tests/**",
        required: true,
      },
      {
        id: "focus",
        label: "Hardening Focus",
        type: "select",
        defaultValue: "flakiness",
        options: [
          { label: "Flakiness", value: "flakiness" },
          { label: "Coverage gaps", value: "coverage" },
          { label: "Fixture cleanup", value: "fixtures" },
          { label: "All", value: "all" },
        ],
        required: true,
      },
      {
        id: "enforceDeterminism",
        label: "Enforce Determinism",
        type: "toggle",
        defaultValue: true,
      },
    ],
  },
  {
    id: "dependency-upgrade-plan",
    name: "Dependency Upgrade Plan",
    description:
      "Generate an upgrade plan with compatibility risks, migration tasks, and rollback strategy.",
    icon: "refresh",
    category: "transform",
    tags: ["dependencies", "upgrade", "migration", "risk"],
    builtin: true,
    version: "1.0.0",
    fields: [
      {
        id: "packageScope",
        label: "Package Scope",
        type: "text",
        placeholder: "e.g. preact, @mui/*, vitest",
        defaultValue: "",
        required: true,
      },
      {
        id: "targetVersion",
        label: "Target Version",
        type: "text",
        placeholder: "e.g. latest, ^5, 1.2.3",
        defaultValue: "latest",
        required: true,
      },
      {
        id: "includeRollback",
        label: "Include Rollback Plan",
        type: "toggle",
        defaultValue: true,
      },
    ],
  },
  {
    id: "security-secret-audit",
    name: "Security Secret Audit",
    description:
      "Audit for potential secret exposure patterns, risky config defaults, and missing safeguards.",
    icon: "lock",
    category: "security",
    tags: ["security", "secrets", "audit", "compliance"],
    builtin: true,
    version: "1.0.0",
    fields: [
      {
        id: "scanScope",
        label: "Scan Scope",
        type: "text",
        placeholder: "e.g. ., src/, config/",
        defaultValue: ".",
        required: true,
      },
      {
        id: "includeHistoryHints",
        label: "Include Git History Hints",
        type: "toggle",
        defaultValue: false,
      },
      {
        id: "outputFormat",
        label: "Output Format",
        type: "select",
        defaultValue: "markdown",
        options: [
          { label: "Markdown", value: "markdown" },
          { label: "JSON", value: "json" },
          { label: "Both", value: "both" },
        ],
        required: true,
      },
    ],
  },
  {
    id: "incident-postmortem-pack",
    name: "Incident Postmortem Pack",
    description:
      "Create a postmortem-ready package: timeline, impact summary, contributing factors, and follow-up actions.",
    icon: "alert",
    category: "reliability",
    tags: ["incident", "postmortem", "reliability", "operations"],
    builtin: true,
    version: "1.0.0",
    fields: [
      {
        id: "incidentTitle",
        label: "Incident Title",
        type: "text",
        placeholder: "Short incident title",
        defaultValue: "",
        required: true,
      },
      {
        id: "impactSummary",
        label: "Impact Summary",
        type: "textarea",
        placeholder: "Who was impacted and how",
        defaultValue: "",
        required: true,
      },
      {
        id: "includeActionItems",
        label: "Include Action Items",
        type: "toggle",
        defaultValue: true,
      },
    ],
  },
  {
    id: "docs-gap-analysis",
    name: "Docs Gap Analysis",
    description:
      "Identify documentation blind spots between implementation and docs, then prepare prioritized updates.",
    icon: "search",
    category: "audit",
    tags: ["docs", "analysis", "coverage", "onboarding"],
    builtin: true,
    version: "1.0.0",
    fields: [
      {
        id: "docsPath",
        label: "Docs Path",
        type: "text",
        placeholder: "e.g. docs/, README.md",
        defaultValue: "docs/",
        required: false,
      },
      {
        id: "codeScope",
        label: "Code Scope",
        type: "text",
        placeholder: "e.g. src/, bosun/",
        defaultValue: "",
        required: false,
      },
      {
        id: "outputStyle",
        label: "Output Style",
        type: "select",
        defaultValue: "prioritized-list",
        options: [
          { label: "Prioritized list", value: "prioritized-list" },
          { label: "Checklist", value: "checklist" },
          { label: "Action plan", value: "action-plan" },
        ],
        required: true,
      },
    ],
  },
  {
    id: "onboarding-quickstart-pack",
    name: "Onboarding Quickstart Pack",
    description:
      "Generate an onboarding pack covering setup, architecture hotspots, first-task path, and common pitfalls.",
    icon: "book",
    category: "generate",
    tags: ["onboarding", "developer-experience", "documentation", "handoff"],
    builtin: true,
    version: "1.0.0",
    fields: [
      {
        id: "targetPersona",
        label: "Target Persona",
        type: "select",
        defaultValue: "engineer",
        options: [
          { label: "Engineer", value: "engineer" },
          { label: "QA", value: "qa" },
          { label: "SRE/DevOps", value: "sre" },
          { label: "Product/PM", value: "pm" },
        ],
        required: true,
      },
      {
        id: "timeBudgetHours",
        label: "Onboarding Time Budget (hours)",
        type: "number",
        defaultValue: 4,
        required: false,
      },
      {
        id: "includeFirstTaskGuide",
        label: "Include First Task Guide",
        type: "toggle",
        defaultValue: true,
      },
    ],
  },
];

// ── Template Registry ────────────────────────────────────────────────────────

/**
 * List all available manual flow templates (built-in + user-created).
 *
 * @param {string} [rootDir]
 * @returns {ManualFlowTemplate[]}
 */
export function listFlowTemplates(rootDir) {
  const templates = [...BUILTIN_FLOW_TEMPLATES];

  if (rootDir) {
    const dir = getTemplatesDir(rootDir);
    if (existsSync(dir)) {
      try {
        for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
          try {
            const tpl = JSON.parse(readFileSync(resolve(dir, f), "utf8"));
            if (tpl.id && tpl.name) {
              tpl.builtin = false;
              templates.push(tpl);
            }
          } catch { /* skip malformed */ }
        }
      } catch { /* dir read error */ }
    }
  }

  return templates;
}

/**
 * Get a specific template by ID.
 *
 * @param {string} templateId
 * @param {string} [rootDir]
 * @returns {ManualFlowTemplate|null}
 */
export function getFlowTemplate(templateId, rootDir) {
  return listFlowTemplates(rootDir).find((t) => t.id === templateId) || null;
}

/**
 * Save a user-created template.
 *
 * @param {ManualFlowTemplate} template
 * @param {string} rootDir
 * @returns {ManualFlowTemplate}
 */
export function saveFlowTemplate(template, rootDir) {
  ensureDirs(rootDir);
  const id = template.id || `custom-${Date.now().toString(36)}`;
  const tpl = { ...template, id, builtin: false };
  const filePath = resolve(getTemplatesDir(rootDir), `${id}.json`);
  writeFileSync(filePath, JSON.stringify(tpl, null, 2) + "\n", "utf8");
  return tpl;
}

/**
 * Delete a user-created template (built-ins cannot be deleted).
 *
 * @param {string} templateId
 * @param {string} rootDir
 * @returns {boolean}
 */
export function deleteFlowTemplate(templateId, rootDir) {
  if (BUILTIN_FLOW_TEMPLATES.some((t) => t.id === templateId)) return false;
  const filePath = resolve(getTemplatesDir(rootDir), `${templateId}.json`);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
    return true;
  }
  return false;
}

// ── Run Management ───────────────────────────────────────────────────────────

/**
 * Create a new manual flow run.
 *
 * @param {string} templateId
 * @param {Object} formValues
 * @param {string} rootDir
 * @returns {ManualFlowRun}
 */
export function createRun(templateId, formValues, rootDir, opts = {}) {
  ensureDirs(rootDir);
  const template = getFlowTemplate(templateId, rootDir);
  if (!template) throw new Error(`Template not found: ${templateId}`);

  validateRequiredManualFlowFields(template, formValues);
  const resolved = resolveManualFlowValues(template, formValues);
  const run = normalizeManualFlowRun(createManualFlowRunRecord(templateId, template.name, resolved, opts));

  writeRunToDisk(run, rootDir);
  syncManualFlowLedger(run, rootDir, "manual-flow.created", {
    timestamp: run.startedAt,
    message: `${run.templateName} queued`,
  });
  return run;
}

function validateRequiredManualFlowFields(template, formValues) {
  for (const field of template.fields) {
    if (!field.required) continue;
    const value = formValues[field.id];
    if (value === undefined || value === null || value === "") {
      throw new Error(`Required field missing: ${field.label} (${field.id})`);
    }
  }
}

function resolveManualFlowValues(template, formValues) {
  const resolved = {};
  for (const field of template.fields) {
    if (formValues[field.id] !== undefined && formValues[field.id] !== null) {
      resolved[field.id] = formValues[field.id];
    } else if (field.defaultValue !== undefined) {
      resolved[field.id] = field.defaultValue;
    }
  }
  return resolved;
}

function normalizeManualFlowRunMetadata(metadata = {}) {
  if (!metadata || typeof metadata !== "object") return null;
  const normalized = {};

  const repository = String(
    metadata.repository || metadata.targetRepo || metadata.repo || "",
  ).trim();
  if (repository) {
    normalized.repository = repository;
    normalized.targetRepo = repository;
  }

  const workspaceId = String(metadata.workspaceId || metadata.workspace || "").trim();
  if (workspaceId) normalized.workspaceId = workspaceId;

  const workspaceDir = String(metadata.workspaceDir || metadata.rootDir || "").trim();
  if (workspaceDir) normalized.workspaceDir = workspaceDir;

  const projectId = String(metadata.projectId || metadata.project || "").trim();
  if (projectId) normalized.projectId = projectId;

  const triggerSource = String(metadata.triggerSource || metadata.source || "").trim();
  if (triggerSource) normalized.triggerSource = triggerSource;

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function createManualFlowRunRecord(templateId, templateName, formValues, opts = {}) {
  const startedAt = new Date().toISOString();
  let run = {
    id: `mfr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    templateId,
    templateName,
    workflowId: getManualFlowWorkflowId(templateId),
    runKind: "manual-flow",
    formValues,
    status: "pending",
    startedAt,
    completedAt: null,
    result: null,
    error: null,
    metadata: normalizeManualFlowRunMetadata(opts?.metadata),
  };
  run = addManualFlowEvent(run, "manual-flow.created", {
    timestamp: startedAt,
    status: "pending",
    message: `${templateName} queued`,
  });
  return run;
}

/**
 * Mark a run as started.
 *
 * @param {string} runId
 * @param {string} rootDir
 * @returns {ManualFlowRun}
 */
export function startRun(runId, rootDir) {
  let run = getRun(runId, rootDir);
  if (!run) throw new Error(`Run not found: ${runId}`);
  run.status = "running";
  run = addManualFlowEvent(run, "manual-flow.started", {
    status: "running",
    message: `${run.templateName} started`,
  });
  writeRunToDisk(run, rootDir);
  syncManualFlowLedger(run, rootDir, "run.start", {
    timestamp: run.observability?.lastEventAt,
    message: `${run.templateName} started`,
  });
  return run;
}

/**
 * Mark a run as completed with a result.
 *
 * @param {string} runId
 * @param {Object} result
 * @param {string} rootDir
 * @returns {ManualFlowRun}
 */
export function completeRun(runId, result, rootDir) {
  let run = getRun(runId, rootDir);
  if (!run) throw new Error(`Run not found: ${runId}`);
  run.status = "completed";
  run.completedAt = new Date().toISOString();
  run.result = result || {};
  if (run.result?.taskGraph && typeof run.result.taskGraph === "object") {
    run = setManualFlowPlan(run, {
      relatedTaskIds: [
        run.result.taskGraph.parentTaskId,
        ...(Array.isArray(run.result.taskGraph.tasks)
          ? run.result.taskGraph.tasks.map((task) => task?.taskId || task?.id)
          : []),
      ],
    });
  }
  if (run.result?.workflowRunId || run.result?.runId) {
    run = setManualFlowPlan(run, {
      relatedWorkflowRunIds: [run.result.workflowRunId || run.result.runId],
    });
  }
  run = addManualFlowEvent(run, "manual-flow.completed", {
    timestamp: run.completedAt,
    status: "completed",
    message: `${run.templateName} completed`,
    details: {
      mode: run.result?.mode || null,
    },
  });
  writeRunToDisk(run, rootDir);
  syncManualFlowLedger(run, rootDir, "run.end", {
    timestamp: run.completedAt,
    message: `${run.templateName} completed`,
    workflowRunId: run.result?.workflowRunId || run.result?.runId || null,
    taskId: run.result?.taskId || run.result?.taskGraph?.parentTaskId || null,
  });
  return run;
}

/**
 * Mark a run as failed.
 *
 * @param {string} runId
 * @param {string} error
 * @param {string} rootDir
 * @returns {ManualFlowRun}
 */
export function failRun(runId, error, rootDir) {
  let run = getRun(runId, rootDir);
  if (!run) throw new Error(`Run not found: ${runId}`);
  run.status = "failed";
  run.completedAt = new Date().toISOString();
  run.error = error;
  run = addManualFlowEvent(run, "manual-flow.failed", {
    timestamp: run.completedAt,
    status: "failed",
    message: String(error || "Execution failed"),
  });
  writeRunToDisk(run, rootDir);
  syncManualFlowLedger(run, rootDir, "run.error", {
    timestamp: run.completedAt,
    message: String(error || "Execution failed"),
    reason: String(error || "Execution failed"),
  });
  return run;
}

/**
 * Get a single run by ID.
 */
export function getRun(runId, rootDir) {
  const filePath = resolve(getRunsDir(rootDir), `${runId}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return normalizeManualFlowRun(JSON.parse(readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

/**
 * List all runs, newest first.
 *
 * @param {string}  rootDir
 * @param {Object}  [opts]
 * @param {string}  [opts.templateId]  — filter by template
 * @param {string}  [opts.status]      — filter by status
 * @param {number}  [opts.limit=50]
 * @returns {ManualFlowRun[]}
 */
export function listRuns(rootDir, opts = {}) {
  const dir = getRunsDir(rootDir);
  if (!existsSync(dir)) return [];

  let files;
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse();
  } catch {
    return [];
  }

  const limit = opts.limit || 50;
  const results = [];

  for (const f of files) {
    if (results.length >= limit) break;
    try {
      const run = JSON.parse(readFileSync(resolve(dir, f), "utf8"));
      if (opts.templateId && run.templateId !== opts.templateId) continue;
      if (opts.status && run.status !== opts.status) continue;
      results.push(normalizeManualFlowRun(run));
    } catch { /* skip */ }
  }

  return results;
}

// ── Execution Dispatcher ─────────────────────────────────────────────────────

/**
 * Execute a manual flow: create a run, dispatch to the appropriate executor,
 * and return the run record. The actual work is dispatched as a Bosun task or
 * run inline depending on the template.
 *
 * @param {string} templateId
 * @param {Object} formValues
 * @param {string} rootDir
 * @param {Object} [context]  — optional: { taskManager, agentPool, config }
 * @returns {Promise<ManualFlowRun>}
 */
export async function executeFlow(templateId, formValues, rootDir, context = {}) {
  const run = createRun(templateId, formValues, rootDir, {
    metadata: context?.runMetadata,
  });

  try {
    let activeRun = startRun(run.id, rootDir);
    const updateActiveRun = (mutator, eventSpec = null) => {
      const current = getRun(activeRun.id, rootDir);
      if (!current) throw new Error(`Run not found: ${activeRun.id}`);
      const draft = cloneJson(current) || current;
      const mutated = typeof mutator === "function"
        ? (mutator(draft) || draft)
        : draft;
      const normalized = eventSpec?.eventType
        ? addManualFlowEvent(mutated, eventSpec.eventType, eventSpec)
        : normalizeManualFlowRun(mutated);
      writeRunToDisk(normalized, rootDir);
      if (eventSpec?.eventType) {
        syncManualFlowLedger(normalized, rootDir, eventSpec.eventType, eventSpec);
      }
      activeRun = normalized;
      return activeRun;
    };

    const template = getFlowTemplate(templateId, rootDir);
    if (!template) throw new Error(`Template not found: ${templateId}`);

    // Execute based on template category / id
    let result;
    switch (templateId) {
      case "codebase-annotation-audit":
        result = await executeAnnotationAudit(run.formValues, rootDir, context);
        break;
      case "generate-skills":
        result = await executeSkillGeneration(run.formValues, rootDir, context);
        break;
      case "prepare-agents-md":
        result = await executeAgentsMdPrep(run.formValues, rootDir, context);
        break;
      case "codebase-health-check":
        result = await executeHealthCheck(run.formValues, rootDir, context);
        break;
      case "context-index-full":
        result = await executeContextIndexFull(run.formValues, rootDir, context);
        break;
      case "queued-execution-plan":
        result = await executeQueuedExecutionPlan(run.formValues, rootDir, {
          ...context,
          runId: activeRun.id,
          updateRun: updateActiveRun,
        });
        break;
      case "research-agent":
        result = await executeResearchAgent(run.formValues, rootDir, {
          ...context,
          runId: activeRun.id,
          updateRun: updateActiveRun,
        });
        break;
      default:
        // For custom templates, create a Bosun task
        result = await executeCustomFlow(template, run.formValues, rootDir, context);
        break;
    }

    return completeRun(activeRun.id, result, rootDir);
  } catch (err) {
    console.warn("[manual-flows] execution failed for " + run.id + ": " + (err?.message || String(err)));
    return failRun(run.id, err?.message || "Execution failed", rootDir);
  }
}

/** Stub executor for skill generation flow. */
async function executeSkillGeneration(formValues, rootDir, context) {
  const modules = (formValues.targetModules || "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);

  if (context.taskManager && typeof context.taskManager.createTask === "function") {
    const task = await context.taskManager.createTask({
      title: "docs(skills): generate agent skills from codebase analysis",
      description: `Analyze ${modules.length > 0 ? modules.join(", ") : "all modules"} and generate up to ${formValues.maxSkills || 10} skill files.\nScope: ${formValues.skillScope || "global"}\nInclude examples: ${formValues.includeExamples !== false}`,
      priority: "medium",
      labels: ["skills", "documentation", "automation"],
    });
    return { mode: "task-dispatched", taskId: task.id || task._id };
  }

  return {
    mode: "instructions",
    instructions:
      "Create a task with title 'docs(skills): generate agent skills' to have an agent analyze the codebase and produce skill files.",
    targetModules: modules,
    scope: formValues.skillScope || "global",
  };
}

/** Stub executor for AGENTS.md preparation flow. */
async function executeAgentsMdPrep(formValues, rootDir, context) {
  const agentsMdPath = resolve(formValues.repoRoot || rootDir, "AGENTS.md");
  const exists = existsSync(agentsMdPath);

  if (context.taskManager && typeof context.taskManager.createTask === "function") {
    const task = await context.taskManager.createTask({
      title: `docs(agents): ${formValues.mode === "generate" ? "generate" : "update"} AGENTS.md`,
      description: `${formValues.mode === "generate" ? "Generate" : "Update"} the AGENTS.md file at repo root.\nCurrent state: ${exists ? "exists" : "missing"}\nInclude env vars: ${formValues.includeEnvVars !== false}\nInclude module inventory: ${formValues.includeModuleInventory !== false}`,
      priority: "medium",
      labels: ["docs", "agents-md"],
    });
    return { mode: "task-dispatched", taskId: task.id || task._id };
  }

  return {
    mode: "instructions",
    agentsMdExists: exists,
    instructions: `${exists ? "Update" : "Create"} AGENTS.md at repo root with build commands, module inventory, and env vars.`,
  };
}

/** Stub executor for health check flow. */
async function executeHealthCheck(formValues, rootDir, context) {
  if (context.taskManager && typeof context.taskManager.createTask === "function") {
    const task = await context.taskManager.createTask({
      title: `chore(health): codebase health check — ${formValues.checks || "all"}`,
      description: `Run ${formValues.checks === "all" ? "all" : formValues.checks} health check(s).\nTarget: ${formValues.targetDir || "entire repo"}\nOutput: ${formValues.outputFormat || "json"}`,
      priority: "medium",
      labels: ["health", "quality", "audit"],
    });
    return { mode: "task-dispatched", taskId: task.id || task._id };
  }

  return {
    mode: "instructions",
    checks: formValues.checks || "all",
    targetDir: formValues.targetDir || "(entire repo)",
    instructions: "Create a health check task to analyze: dead code, deps, circular imports, coverage gaps.",
  };
}

async function executeContextIndexFull(formValues, rootDir, _context = {}) {
  const { runContextIndex } = await import("../workspace/context-indexer.mjs");
  const result = await runContextIndex({
    rootDir,
    includeTests: formValues.includeTests !== false,
    maxFileBytes: Number(formValues.maxFileBytes || 800000),
    useTreeSitter: formValues.useTreeSitter !== false,
    useZoekt: formValues.useZoekt !== false,
  });
  return {
    ...result,
    mode: "indexed",
  };
}

function normalizeQueueStrategy(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["global-sequential", "explicit-only", "agent-lane-queue"].includes(normalized)) {
    return normalized;
  }
  return "agent-lane-queue";
}

function parseDependsOnLine(block = "") {
  const match = block.match(/^depends\s*on\s*:\s*(.+)$/im);
  if (!match) return [];
  return uniqueTextList(
    String(match[1] || "")
      .split(/[,\n]/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function parseQueuedExecutionPlanDocument(planDocument = "") {
  const raw = String(planDocument || "").trim();
  if (!raw) {
    throw new Error("Plan document is required.");
  }

  if (raw.startsWith("[")) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("Plan JSON must be a non-empty array of steps.");
    }
    return {
      mode: "json",
      steps: parsed.map((entry, index) => ({
        id: String(entry?.id || `step-${index + 1}`).trim(),
        title: String(entry?.title || entry?.name || `Step ${index + 1}`).trim(),
        prompt: String(entry?.prompt || entry?.instructions || "").trim(),
        lane: String(entry?.lane || entry?.agent || "").trim().toUpperCase() || null,
        order: Number.isFinite(Number(entry?.order)) ? Number(entry.order) : index + 1,
        dependsOnStepIds: uniqueTextList(entry?.dependsOnStepIds || entry?.dependsOn || []),
      })),
    };
  }

  const headingRe = /^##\s*Step\s+(\d+)(?:\s+([A-Za-z]))?\s*:\s*(.+)$/gim;
  const matches = Array.from(raw.matchAll(headingRe));
  if (matches.length > 0) {
    const steps = matches.map((match, index) => {
      const blockStart = match.index + match[0].length;
      const blockEnd = index + 1 < matches.length ? matches[index + 1].index : raw.length;
      const block = raw.slice(blockStart, blockEnd).trim();
      const order = Number(match[1] || index + 1);
      const lane = String(match[2] || "").trim().toUpperCase() || null;
      const title = String(match[3] || `Step ${order}`).trim();
      const explicitDepends = parseDependsOnLine(block);
      const prompt = block
        .replace(/^depends\s*on\s*:.+$/gim, "")
        .trim();
      return {
        id: `step-${order}${lane ? `-${lane.toLowerCase()}` : ""}`,
        title,
        prompt,
        lane,
        order,
        dependsOnStepIds: explicitDepends,
      };
    });
    return { mode: "markdown-headings", steps };
  }

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    throw new Error("Plan document does not contain any steps.");
  }
  return {
    mode: "line-list",
    steps: lines.map((line, index) => {
      const laneMatch = line.match(/^\[([A-Za-z])\]\s*(.+)$/);
      const lane = laneMatch ? String(laneMatch[1] || "").trim().toUpperCase() : null;
      const title = laneMatch ? laneMatch[2] : line.replace(/^\d+[\).\s-]+/, "").trim();
      return {
        id: `step-${index + 1}${lane ? `-${lane.toLowerCase()}` : ""}`,
        title: title || `Step ${index + 1}`,
        prompt: title || `Step ${index + 1}`,
        lane,
        order: index + 1,
        dependsOnStepIds: [],
      };
    }),
  };
}

function buildQueuedExecutionPlan(parsed, formValues = {}) {
  const queueStrategy = normalizeQueueStrategy(formValues.queueStrategy);
  const ordered = [...parsed.steps]
    .map((step, index) => ({
      ...step,
      order: Number.isFinite(Number(step.order)) ? Number(step.order) : index + 1,
    }))
    .sort((left, right) => Number(left.order || 0) - Number(right.order || 0));
  const lastByLane = new Map();
  let previousGlobalStepId = null;

  const steps = ordered.map((step, index) => {
    let dependsOnStepIds = uniqueTextList(step.dependsOnStepIds || []);
    if (dependsOnStepIds.length === 0) {
      if (queueStrategy === "global-sequential" && previousGlobalStepId) {
        dependsOnStepIds = [previousGlobalStepId];
      } else if (queueStrategy === "agent-lane-queue") {
        const laneKey = String(step.lane || "_default").trim().toUpperCase();
        const previousLaneStepId = lastByLane.get(laneKey);
        if (previousLaneStepId) {
          dependsOnStepIds = [previousLaneStepId];
        }
      }
    }
    const status = dependsOnStepIds.length > 0 ? "blocked" : "ready";
    const normalized = normalizeManualFlowStep({
      ...step,
      order: step.order || index + 1,
      dependsOnStepIds,
      status,
    }, index + 1);
    lastByLane.set(String(normalized.lane || "_default").trim().toUpperCase(), normalized.id);
    previousGlobalStepId = normalized.id;
    return normalized;
  });

  const laneCount = uniqueTextList(steps.map((step) => step.lane).filter(Boolean)).length;
  return {
    planTitle: String(formValues.planTitle || "").trim(),
    objective: String(formValues.objective || "").trim(),
    parseMode: parsed.mode,
    queueStrategy,
    laneCount,
    steps,
    readyStepIds: steps.filter((step) => step.status === "ready").map((step) => step.id),
    blockedStepIds: steps.filter((step) => step.status === "blocked").map((step) => step.id),
  };
}

function buildQueuedStepTaskDescription(plan, step) {
  const dependencySummary = step.dependsOnStepIds.length > 0
    ? step.dependsOnStepIds.join(", ")
    : "none";
  return [
    `Plan: ${plan.planTitle}`,
    "",
    `Objective: ${plan.objective}`,
    "",
    `Step ID: ${step.id}`,
    `Order: ${step.order}`,
    `Lane: ${step.lane || "unassigned"}`,
    `Depends On: ${dependencySummary}`,
    "",
    "Prompt:",
    step.prompt || step.title,
  ].join("\n");
}

async function executeQueuedExecutionPlan(formValues, _rootDir, context = {}) {
  const parsed = parseQueuedExecutionPlanDocument(formValues.planDocument);
  const plan = buildQueuedExecutionPlan(parsed, formValues);

  if (typeof context.updateRun === "function") {
    context.updateRun((draft) => setManualFlowPlan(draft, plan), {
      eventType: "manual-flow.plan.parsed",
      executionKind: "plan",
      message: `Parsed ${plan.steps.length} queued step(s)`,
      summary: `Parsed ${plan.steps.length} queued step(s)`,
    });
  }

  let taskGraph = null;
  const createTasks = parseManualFlowBoolean(formValues.createTasks, true);
  if (createTasks && context.taskManager && typeof context.taskManager.createTaskGraph === "function") {
    taskGraph = await context.taskManager.createTaskGraph({
      parentTask: {
        title: `plan: ${plan.planTitle}`,
        description: [
          plan.objective,
          "",
          `Queue strategy: ${plan.queueStrategy}`,
          `Parsed from: ${plan.parseMode}`,
          `Step count: ${plan.steps.length}`,
        ].join("\n"),
        priority: formValues.taskPriority || "high",
        labels: ["manual-plan", "queued-plan", "planning"],
        meta: {
          manualPlan: true,
          manualFlowRunId: context.runId || null,
          queueStrategy: plan.queueStrategy,
        },
      },
      tasks: plan.steps.map((step) => ({
        clientId: step.id,
        title: `${step.lane ? `[${step.lane}] ` : ""}Step ${step.order}: ${step.title}`,
        description: buildQueuedStepTaskDescription(plan, step),
        priority: formValues.taskPriority || "high",
        labels: ["manual-plan-step", "queued-plan", step.lane ? `agent-${step.lane.toLowerCase()}` : null].filter(Boolean),
        dependsOnTaskClientIds: step.dependsOnStepIds,
        sprintId: String(formValues.sprintId || "").trim() || undefined,
        meta: {
          manualPlan: true,
          manualFlowRunId: context.runId || null,
          stepId: step.id,
          stepOrder: step.order,
          stepLane: step.lane,
          queueStrategy: plan.queueStrategy,
          stepPrompt: step.prompt,
        },
      })),
    });
    const taskMap = new Map(
      (Array.isArray(taskGraph?.tasks) ? taskGraph.tasks : [])
        .filter((entry) => entry?.clientId)
        .map((entry) => [entry.clientId, entry]),
    );
    const planWithTasks = {
      ...plan,
      relatedTaskIds: [
        taskGraph?.parentTaskId || null,
        ...(Array.isArray(taskGraph?.tasks) ? taskGraph.tasks.map((entry) => entry?.taskId || entry?.id) : []),
      ],
      steps: plan.steps.map((step) => {
        const linked = taskMap.get(step.id);
        return normalizeManualFlowStep({
          ...step,
          taskId: linked?.taskId || linked?.id || null,
          taskTitle: linked?.title || null,
          status: step.status === "ready" ? "queued" : step.status,
        }, step.order);
      }),
    };
    if (typeof context.updateRun === "function") {
      context.updateRun((draft) => setManualFlowPlan(draft, planWithTasks), {
        eventType: "manual-flow.plan.tasks-created",
        executionKind: "task-graph",
        message: `Created ${taskGraph?.taskCount || plan.steps.length} queued task(s)`,
        taskId: taskGraph?.parentTaskId || null,
      });
    }
    return {
      mode: "task-graph-created",
      accepted: true,
      planTitle: plan.planTitle,
      objective: plan.objective,
      queueStrategy: plan.queueStrategy,
      parseMode: plan.parseMode,
      laneCount: plan.laneCount,
      stepCount: plan.steps.length,
      readyStepIds: plan.readyStepIds,
      blockedStepIds: plan.blockedStepIds,
      steps: planWithTasks.steps,
      taskGraph,
    };
  }

  return {
    mode: "queued-plan",
    accepted: true,
    planTitle: plan.planTitle,
    objective: plan.objective,
    queueStrategy: plan.queueStrategy,
    parseMode: plan.parseMode,
    laneCount: plan.laneCount,
    stepCount: plan.steps.length,
    readyStepIds: plan.readyStepIds,
    blockedStepIds: plan.blockedStepIds,
    steps: plan.steps,
  };
}

async function executeResearchAgent(formValues, rootDir, context = {}) {
  const researchConfig = resolveResearchAgentConfig(formValues, rootDir);
  const {
    problem,
    domain,
    maxIterations,
    searchLiterature,
    executionMode,
    useEvidenceSidecar,
  } = researchConfig;

  if (executionMode === "task") {
    const taskDescription = buildResearchTaskDescription(researchConfig);
    if (context.taskManager && typeof context.taskManager.createTask === "function") {
      const task = await context.taskManager.createTask({
        title: `research: ${useEvidenceSidecar ? "evidence-backed" : "iterative"} agent (${domain})`,
        description: taskDescription,
        priority: "high",
        labels: useEvidenceSidecar
          ? ["research", "verification-loop", "scientific-evidence", "aletheia"]
          : ["research", "verification-loop", "aletheia"],
      });
      return {
        mode: "task-dispatched",
        taskId: task.id || task._id,
        problem,
        domain,
        maxIterations,
        searchLiterature,
        useEvidenceSidecar,
        evidenceMode: researchConfig.evidenceMode,
      };
    }
    return buildResearchInstructionsResult(
      researchConfig,
      "Task manager unavailable. Create a high-priority research task using the provided configuration.",
    );
  }

  const engine = context.engine;
  if (!engine || typeof engine.execute !== "function") {
    return buildResearchInstructionsResult(
      researchConfig,
      "Workflow execution mode requires an active workflow engine. Retry from the Workflows launcher or switch to Task mode.",
    );
  }

  const templateId = useEvidenceSidecar
    ? ensureTemplateWorkflowInstalled(engine, RESEARCH_EVIDENCE_AGENT_TEMPLATE)
    : await ensureBundledTemplateInstalled(engine, "template-research-agent");

  const input = buildResearchWorkflowInput(researchConfig, rootDir, context);

  Promise.resolve()
    .then(() => engine.execute(templateId, input, { force: true, triggerSource: "manual" }))
    .then((workflowResult) => {
      const workflowRunId = String(workflowResult?.runId || workflowResult?.workflowRunId || "").trim();
      if (workflowRunId && typeof context.updateRun === "function") {
        context.updateRun((draft) => setManualFlowPlan(draft, {
          relatedWorkflowRunIds: [workflowRunId],
        }), {
          eventType: "manual-flow.workflow-dispatched",
          executionKind: "workflow",
          message: `Workflow run ${workflowRunId} dispatched`,
          workflowRunId,
        });
      }
      return workflowResult;
    })
    .catch((err) => {
      console.error(`[manual-flows] research-agent dispatch failed: ${err.message}`);
    });

  return {
    mode: "workflow-dispatched",
    accepted: true,
    workflowId: templateId,
    problem,
    domain,
    maxIterations,
    searchLiterature,
    useEvidenceSidecar,
    evidenceMode: researchConfig.evidenceMode,
    triggerSource: "manual",
  };
}

function resolveResearchAgentConfig(formValues, rootDir = process.cwd()) {
  const problem = String(formValues?.problem || "").trim();
  if (!problem) {
    throw new Error("Research problem is required.");
  }

  const domain = String(formValues?.domain || "computer-science").trim() || "computer-science";
  const maxIterationsRaw = Number(formValues?.maxIterations);
  const maxIterations = Number.isFinite(maxIterationsRaw)
    ? Math.min(50, Math.max(1, Math.floor(maxIterationsRaw)))
    : 10;
  const useEvidenceSidecar = parseManualFlowBoolean(formValues?.useEvidenceSidecar, true);
  const evidenceConfig = resolveResearchEvidenceSidecarConfig({
    repoRoot: rootDir,
    problem,
    domain,
    evidenceMode: formValues?.evidenceMode,
    maxEvidenceSources: formValues?.maxEvidenceSources,
    corpusPaths: formValues?.corpusPaths,
    searchLiterature: formValues?.searchLiterature,
    promoteReviewedFindings: formValues?.promoteReviewedFindings,
    sidecarCommand: formValues?.sidecarCommand,
    triggerSource: "manual",
  });

  return {
    problem,
    domain,
    maxIterations,
    searchLiterature: evidenceConfig.searchLiterature,
    executionMode: String(formValues?.executionMode || "workflow").trim().toLowerCase(),
    useEvidenceSidecar,
    evidenceMode: evidenceConfig.evidenceMode,
    corpusPaths: evidenceConfig.corpusPaths,
    maxEvidenceSources: evidenceConfig.maxEvidenceSources,
    promoteReviewedFindings: evidenceConfig.promoteReviewedFindings,
    sidecarCommand: evidenceConfig.sidecarCommand,
  };
}

function buildResearchTaskDescription(config) {
  const {
    problem,
    domain,
    maxIterations,
    searchLiterature,
    useEvidenceSidecar,
    evidenceMode,
    corpusPaths,
    maxEvidenceSources,
    promoteReviewedFindings,
    sidecarCommand,
  } = config;
  const baseDescription = (
    `Run iterative research for the following problem:\n\n` +
    `${problem}\n\n` +
    `Domain: ${domain}\n` +
    `Max iterations: ${maxIterations}\n` +
    `Search literature first: ${searchLiterature}\n\n` +
    `Use a generate -> verify -> revise loop. If verification identifies critical flaws, ` +
    `regenerate from a fundamentally different approach.`
  );
  if (!useEvidenceSidecar) {
    return baseDescription;
  }
  const corpusLine = corpusPaths.length > 0
    ? `Evidence corpus paths: ${corpusPaths.join(", ")}\n`
    : "Evidence corpus paths: (none provided)\n";
  const externalLine = sidecarCommand
    ? `External sidecar command: ${sidecarCommand}\n`
    : "External sidecar command: Bosun-local evidence bundling only\n";
  return (
    `${baseDescription}\n\n` +
    `Use the Bosun scientific evidence sidecar before generation.\n` +
    `Evidence mode: ${evidenceMode}\n` +
    `Max evidence sources: ${maxEvidenceSources}\n` +
    `${corpusLine}` +
    `Promote reviewed findings: ${promoteReviewedFindings}\n` +
    `${externalLine}` +
    `Only write back reviewed findings after verification returns CORRECT.`
  );
}

function buildResearchInstructionsResult(config, instructions) {
  const {
    problem,
    domain,
    maxIterations,
    searchLiterature,
    useEvidenceSidecar,
    evidenceMode,
    corpusPaths,
    maxEvidenceSources,
    promoteReviewedFindings,
    sidecarCommand,
  } = config;
  return {
    mode: "instructions",
    problem,
    domain,
    maxIterations,
    searchLiterature,
    useEvidenceSidecar,
    evidenceMode,
    corpusPaths,
    maxEvidenceSources,
    promoteReviewedFindings,
    sidecarCommand,
    instructions,
  };
}

function parseManualFlowBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "n"].includes(normalized)) return false;
  return fallback;
}

function buildResearchWorkflowInput(config, rootDir, context = {}) {
  const {
    problem,
    domain,
    maxIterations,
    searchLiterature,
    useEvidenceSidecar,
    evidenceMode,
    corpusPaths,
    maxEvidenceSources,
    promoteReviewedFindings,
    sidecarCommand,
  } = config;
  return {
    repoRoot: rootDir,
    workspaceId: String(context?.runMetadata?.workspaceId || "").trim(),
    taskId: String(context?.taskId || "").trim(),
    runId: String(context?.runId || "").trim(),
    problem,
    domain,
    maxIterations,
    searchLiterature,
    useEvidenceSidecar,
    evidenceMode,
    corpusPaths,
    maxEvidenceSources,
    promoteReviewedFindings,
    sidecarCommand,
    iterationCount: 0,
    currentDraft: "",
    _previousFeedback: "",
    triggerSource: "manual",
  };
}

async function ensureBundledTemplateInstalled(engine, templateId) {
  const existing = engine.get(templateId);
  if (existing) return existing.id || templateId;
  const { installTemplate } = await import("./workflow-templates.mjs");
  const installed = installTemplate(templateId, engine);
  return installed?.id || templateId;
}

function ensureTemplateWorkflowInstalled(engine, templateDefinition) {
  const templateId = String(templateDefinition?.id || "").trim();
  if (!templateId) {
    throw new Error("Research evidence template is missing an id.");
  }
  const existing = engine.get(templateId);
  if (existing) return existing.id || templateId;

  const definition = JSON.parse(JSON.stringify(templateDefinition));
  definition.id = templateId;
  definition.enabled = true;
  definition.metadata = {
    ...(definition.metadata || {}),
    installedFrom: templateId,
    templateSource: "manual-flow-local",
  };
  const saved = engine.save(definition);
  return saved?.id || templateId;
}

/** Executor for user-created custom templates. */
async function executeCustomFlow(template, formValues, rootDir, context) {
  const templateValues = buildCustomFlowTemplateValues(template, formValues, {
    repository:
      context?.runMetadata?.repository ||
      context?.runMetadata?.targetRepo ||
      "",
    workspaceId: context?.runMetadata?.workspaceId || "",
  });
  const action = resolveCustomFlowAction(template);
  const actionKind = String(action?.kind || "task").trim().toLowerCase();

  if (context.taskManager && typeof context.taskManager.createTask === "function") {
    const { taskTitleTemplate, taskDescriptionTemplate, taskPriority, taskLabels } =
      resolveCustomFlowTaskConfig(actionKind, action);

    const renderedTitle = renderTemplateString(taskTitleTemplate, templateValues);
    const renderedDescription = renderTemplateString(taskDescriptionTemplate, templateValues);

    const task = await context.taskManager.createTask({
      title: renderedTitle || `run(${template.category || "custom"}): ${template.name}`,
      description: renderedDescription || `Manual flow execution: ${template.description || template.name}\n\nForm values:\n${JSON.stringify(formValues, null, 2)}`,
      priority: taskPriority,
      labels: taskLabels.length > 0
        ? taskLabels.map((label) => renderTemplateString(label, templateValues)).filter(Boolean)
        : ["manual-flow", template.category || "custom"],
    });
    return {
      mode: "task-dispatched",
      taskId: task.id || task._id,
      action: actionKind,
    };
  }

  if (actionKind === "instructions") {
    const instructionsTemplate = String(action?.instructions || "").trim();
    const renderedInstructions = renderTemplateString(instructionsTemplate, templateValues);
    return {
      mode: "instructions",
      template: template.id,
      formValues,
      action: actionKind,
      instructions: renderedInstructions || `Create a task to execute the "${template.name}" flow with the submitted form values.`,
    };
  }

  return {
    mode: "instructions",
    template: template.id,
    formValues,
    action: actionKind,
    instructions: `Create a task to execute the "${template.name}" flow with the submitted form values.`,
  };
}

function buildCustomFlowTemplateValues(template, formValues, extraValues = {}) {
  return {
    ...(formValues || {}),
    ...(extraValues || {}),
    templateName: template?.name || "",
    templateId: template?.id || "",
    category: template?.category || "custom",
  };
}

function resolveCustomFlowAction(template) {
  return template?.action && typeof template.action === "object"
    ? template.action
    : { kind: "task" };
}

function resolveCustomFlowTaskConfig(actionKind, action) {
  const taskAction = actionKind === "task" && action?.task && typeof action.task === "object"
    ? action.task
    : {};

  return {
    taskTitleTemplate: String(taskAction?.title || "").trim(),
    taskDescriptionTemplate: String(taskAction?.description || "").trim(),
    taskPriority: String(taskAction?.priority || "medium").trim() || "medium",
    taskLabels: Array.isArray(taskAction?.labels)
      ? taskAction.labels.map((label) => String(label || "").trim()).filter(Boolean)
      : [],
  };
}

function renderTemplateString(templateText = "", values = {}) {
  const raw = String(templateText || "");
  if (!raw) return "";
  return raw.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_all, key) => {
    const val = values[key];
    if (val == null) return "";
    if (typeof val === "object") {
      try {
        return JSON.stringify(val);
      } catch {
        return "";
      }
    }
    return String(val);
  });
}

// ── Persistence helpers ──────────────────────────────────────────────────────

function writeRunToDisk(run, rootDir) {
  const dir = getRunsDir(rootDir);
  mkdirSync(dir, { recursive: true });
  const normalized = normalizeManualFlowRun(run);
  writeFileSync(resolve(dir, `${normalized.id}.json`), JSON.stringify(normalized, null, 2) + "\n", "utf8");
}
