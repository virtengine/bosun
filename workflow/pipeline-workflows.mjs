/**
 * @module workflow/pipeline-workflows
 * @description Config-driven pipeline workflow definitions and Bosun stage runner.
 */

import {
  FanoutPipeline,
  RacePipeline,
  SequentialPipeline,
  toMinimalDescriptor,
} from "../task/pipeline.mjs";
import { createHarnessAgentService } from "../agent/harness-agent-service.mjs";

const VALID_PIPELINE_TYPES = new Set(["sequential", "fanout", "race"]);

export const BUILTIN_PIPELINE_WORKFLOWS = Object.freeze({
  "code-review-chain": Object.freeze({
    name: "code-review-chain",
    type: "sequential",
    description: "Implement, validate, then review with fresh context at every stage.",
    stages: Object.freeze(["implement", "test", "review"]),
    builtin: true,
  }),
  "parallel-search": Object.freeze({
    name: "parallel-search",
    type: "fanout",
    description: "Broadcast the same search task to multiple agents and collect every result.",
    stages: Object.freeze([
      Object.freeze({ name: "search-codex", sdk: "codex" }),
      Object.freeze({ name: "search-claude", sdk: "claude" }),
      Object.freeze({ name: "search-copilot", sdk: "copilot" }),
    ]),
    builtin: true,
  }),
  "consensus-vote": Object.freeze({
    name: "consensus-vote",
    type: "fanout",
    description: "Fan out to multiple agents and compare their independent recommendations.",
    stages: Object.freeze([
      Object.freeze({ name: "vote-codex", sdk: "codex" }),
      Object.freeze({ name: "vote-claude", sdk: "claude" }),
      Object.freeze({ name: "vote-copilot", sdk: "copilot" }),
    ]),
    resultStrategy: "consensus-vote",
    builtin: true,
  }),
});

function normalizeStageDefinition(stage, index = 0) {
  if (typeof stage === "string") {
    return Object.freeze({
      id: stage,
      name: stage,
      role: stage,
      sdk: "auto",
      model: "auto",
    });
  }

  if (!stage || typeof stage !== "object") {
    throw new TypeError(`Invalid workflow stage at index ${index}`);
  }

  const name = String(stage.name || stage.id || `stage-${index + 1}`);
  return Object.freeze({
    ...stage,
    id: String(stage.id || name),
    name,
    role: String(stage.role || name),
    sdk: String(stage.sdk || "auto"),
    model: String(stage.model || "auto"),
  });
}

export function normalizePipelineWorkflowDefinition(name, workflow, options = {}) {
  if (!workflow || typeof workflow !== "object") {
    throw new TypeError(`Workflow "${name}" must be an object`);
  }

  const type = String(workflow.type || "sequential").toLowerCase();
  if (!VALID_PIPELINE_TYPES.has(type)) {
    throw new TypeError(`Workflow "${name}" has unsupported type "${type}"`);
  }

  const stages = Array.isArray(workflow.stages) && workflow.stages.length > 0
    ? workflow.stages.map((stage, index) => normalizeStageDefinition(stage, index))
    : Array.isArray(workflow.agents) && workflow.agents.length > 0
      ? workflow.agents.map((stage, index) => normalizeStageDefinition(stage, index))
      : [];
  if (stages.length === 0) {
    throw new TypeError(`Workflow "${name}" must declare at least one stage`);
  }

  return Object.freeze({
    ...workflow,
    name,
    type,
    description: String(workflow.description || "").trim(),
    stages: Object.freeze(stages),
    builtin: options.builtin === true || workflow.builtin === true,
    resultStrategy: workflow.resultStrategy ? String(workflow.resultStrategy) : null,
  });
}

export function normalizePipelineWorkflows(rawWorkflows = {}) {
  const normalized = {};

  for (const [name, workflow] of Object.entries(BUILTIN_PIPELINE_WORKFLOWS)) {
    normalized[name] = normalizePipelineWorkflowDefinition(name, workflow, { builtin: true });
  }

  if (rawWorkflows && typeof rawWorkflows === "object") {
    for (const [name, workflow] of Object.entries(rawWorkflows)) {
      normalized[name] = normalizePipelineWorkflowDefinition(name, workflow, { builtin: false });
    }
  }

  return Object.freeze(normalized);
}

export function listPipelineWorkflows(workflows = {}) {
  return Object.values(workflows)
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function getPipelineWorkflow(name, workflows = {}) {
  return workflows?.[name] || null;
}

function stageInstructionFor(stage) {
  const role = String(stage.role || stage.name || "agent").toLowerCase();
  if (role.includes("implement")) {
    return "Implement the requested change. Return a concise summary, changed files, and any follow-up risks.";
  }
  if (role.includes("test")) {
    return "Validate the current solution. Focus on tests, verification, and defects. Return findings and any failing checks.";
  }
  if (role.includes("review")) {
    return "Review the proposed change independently. Highlight correctness, regressions, and merge readiness.";
  }
  if (role.includes("search")) {
    return "Research the task independently and return the strongest relevant findings with file or branch references.";
  }
  if (role.includes("vote")) {
    return "Independently evaluate the options and return a recommendation, confidence, and short rationale.";
  }
  return "Execute your stage independently with fresh context and return a concise structured summary.";
}

function buildStagePrompt(workflow, stage, input, context) {
  const descriptor = toMinimalDescriptor(input);
  const priorOutput = context.previousOutput || null;
  const lines = [
    `Workflow: ${workflow.name}`,
    `Stage: ${stage.name}`,
    "",
    stageInstructionFor(stage),
    "",
    "Task descriptor:",
    JSON.stringify(descriptor, null, 2),
  ];

  if (priorOutput) {
    lines.push("", "Prior stage output reference:", JSON.stringify(priorOutput, null, 2));
  }

  if (stage.prompt) {
    lines.push("", "Stage override:", String(stage.prompt));
  }

  lines.push(
    "",
    "Return JSON if practical with keys: summary, status, paths, branch, confidence.",
  );

  return lines.join("\n");
}

function summarizeOutputText(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return String(text || "").trim().replace(/\s+/g, " ").slice(0, 400);
}

function normalizePipelineWorkflowSessionSegment(value, fallback = "session") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  return normalized || fallback;
}

function buildResultDescriptor(input, result, stage) {
  const inherited = toMinimalDescriptor(input);
  const outputText = summarizeOutputText(result?.output ?? result);
  const descriptor = {
    ...inherited,
    summary: outputText || inherited.summary || `${stage.name} completed`,
    stage: stage.name,
  };
  const resultPaths = result?.paths || result?.files || result?.filePaths;
  if (Array.isArray(resultPaths) && resultPaths.length > 0) {
    descriptor.paths = resultPaths.slice(0, 50).map((entry) => String(entry));
  }
  return descriptor;
}

async function runBosunStage(workflow, stage, input, context, options = {}) {
  if (typeof options.runStage === "function") {
    return options.runStage(stage, input, context, workflow);
  }

  const harnessAgentService = createHarnessAgentService();
  const prompt = buildStagePrompt(workflow, stage, input, context);
  const cwd = String(stage.cwd || input?.repoRoot || input?.cwd || options.repoRoot || process.cwd());
  const timeoutMs = Number(stage.timeoutMs || options.timeoutMs || 60 * 60 * 1000);
  const taskId = String(input?.taskId || input?.id || input?.task?.taskId || input?.task?.id || "").trim() || null;
  const pipelineRunId = String(context?.pipeline?.runId || "").trim() || null;
  const workflowSessionId = [
    taskId || workflow.name,
    "pipeline-stage",
    normalizePipelineWorkflowSessionSegment(stage.id || stage.name, "stage"),
    normalizePipelineWorkflowSessionSegment(pipelineRunId || workflow.name, "run"),
  ].join(":");
  const parentSessionId = String(
    input?.sessionId ||
    input?.parentSessionId ||
    input?.rootSessionId ||
    taskId ||
    "",
  ).trim() || null;
  const result = await harnessAgentService.runTask(prompt, {
    autoRecover: false,
    taskKey: workflowSessionId,
    cwd,
    timeoutMs,
    sdk: String(stage.sdk || options.sdk || "auto"),
    model: String(stage.model || options.model || "auto"),
    sessionType: "pipeline-stage",
    sessionId: workflowSessionId,
    sessionScope: taskId ? "pipeline-workflow-task" : "pipeline-workflow-flow",
    parentSessionId,
    rootSessionId: String(input?.rootSessionId || parentSessionId || taskId || "").trim() || null,
    metadata: {
      source: "pipeline-workflow-stage",
      workflowName: workflow.name,
      workflowType: workflow.type,
      stageId: String(stage.id || stage.name || "").trim() || null,
      stageName: String(stage.name || stage.id || "").trim() || null,
      pipelineRunId,
      taskId,
      taskTitle: String(input?.title || input?.taskTitle || input?.task?.title || "").trim() || null,
    },
  });
  return {
    ...result,
    descriptor: buildResultDescriptor(input, result, stage),
  };
}

function selectPipelineFactory(type) {
  if (type === "fanout") return FanoutPipeline;
  if (type === "race") return RacePipeline;
  return SequentialPipeline;
}

function buildConsensusSummary(outputs = []) {
  const buckets = new Map();
  for (const output of outputs) {
    if (!output || output.success === false) continue;
    const key = summarizeOutputText(output.output).toLowerCase();
    if (!key) continue;
    const bucket = buckets.get(key) || {
      count: 0,
      stages: [],
      summary: summarizeOutputText(output.output),
    };
    bucket.count += 1;
    bucket.stages.push(output.stageName);
    buckets.set(key, bucket);
  }
  return Array.from(buckets.values()).sort((left, right) => right.count - left.count)[0] || null;
}

export function createPipelineWorkflowRunner(workflow, options = {}) {
  const stages = workflow.stages.map((stage) => ({
    ...stage,
    async run(input, context) {
      return runBosunStage(workflow, stage, input, context, options);
    },
  }));
  const factory = selectPipelineFactory(workflow.type);
  return factory(stages, {
    createContext(context) {
      return {
        ...context,
        workflow: workflow.name,
      };
    },
  });
}

export async function runPipelineWorkflow(name, input, options = {}) {
  const workflows = options.workflows || normalizePipelineWorkflows(options.config?.workflows || {});
  const workflow = getPipelineWorkflow(name, workflows);
  if (!workflow) {
    throw new Error(`Unknown workflow "${name}"`);
  }

  const runner = createPipelineWorkflowRunner(workflow, options);
  const result = await runner.run(input, options.runtime || {});
  if (workflow.resultStrategy === "consensus-vote") {
    return {
      ...result,
      consensus: buildConsensusSummary(result.outputs),
    };
  }
  return result;
}

export default {
  BUILTIN_PIPELINE_WORKFLOWS,
  normalizePipelineWorkflowDefinition,
  normalizePipelineWorkflows,
  listPipelineWorkflows,
  getPipelineWorkflow,
  createPipelineWorkflowRunner,
  runPipelineWorkflow,
};
