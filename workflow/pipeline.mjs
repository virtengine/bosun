/**
 * @module pipeline
 * @description Declarative multi-agent pipeline primitives with fresh-context handoff.
 */

import { randomUUID } from "node:crypto";
import { createHarnessAgentService } from "../agent/harness-agent-service.mjs";
import { MsgHub } from "./msg-hub.mjs";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_SUMMARY_CHARS = 320;

function safeClone(value) {
  if (value == null) return value;
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
    }
  }
  return JSON.parse(JSON.stringify(value));
}

function truncateText(value, limit = DEFAULT_SUMMARY_CHARS) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function normalizeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack || null,
    };
  }
  return {
    name: "Error",
    message: String(error ?? "Unknown error"),
    stack: null,
  };
}

function normalizeUsage(usage) {
  if (usage == null) return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  if (typeof usage === "number" && Number.isFinite(usage)) {
    return { promptTokens: 0, completionTokens: 0, totalTokens: Math.max(0, usage) };
  }
  const promptTokens = Number(
    usage.promptTokens ?? usage.inputTokens ?? usage.prompt_tokens ?? 0,
  );
  const completionTokens = Number(
    usage.completionTokens ?? usage.outputTokens ?? usage.completion_tokens ?? 0,
  );
  const totalCandidate = Number(
    usage.totalTokens ?? usage.total_tokens ?? promptTokens + completionTokens,
  );
  return {
    promptTokens: Number.isFinite(promptTokens) ? Math.max(0, promptTokens) : 0,
    completionTokens: Number.isFinite(completionTokens)
      ? Math.max(0, completionTokens)
      : 0,
    totalTokens: Number.isFinite(totalCandidate) ? Math.max(0, totalCandidate) : 0,
  };
}

function addUsageTotals(total, usage) {
  const normalized = normalizeUsage(usage);
  total.promptTokens += normalized.promptTokens;
  total.completionTokens += normalized.completionTokens;
  total.totalTokens += normalized.totalTokens;
  return total;
}

function resolveValueAtPath(value, path) {
  const normalizedPath = String(path || "").trim();
  if (!normalizedPath) return undefined;
  return normalizedPath.split(".").reduce((acc, part) => {
    if (acc == null) return undefined;
    return acc[part];
  }, value);
}

function resolveTemplate(template, scope) {
  if (typeof template !== "string") return template;
  return template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_, path) => {
    const resolved = resolveValueAtPath(scope, path);
    if (resolved == null) return "";
    if (typeof resolved === "string") return resolved;
    return JSON.stringify(resolved, null, 2);
  });
}

function normalizeFilePaths(paths) {
  if (!Array.isArray(paths)) return [];
  return [...new Set(paths.map((entry) => String(entry || "").trim()).filter(Boolean))];
}

function normalizePipelineSessionSegment(value, fallback = "session") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  return normalized || fallback;
}

function summarizeOutput(result) {
  const explicit = String(result.summary || "").trim();
  if (explicit) return truncateText(explicit);
  const output = typeof result.output === "string"
    ? result.output
    : result.output == null
      ? ""
      : JSON.stringify(result.output, null, 2);
  return truncateText(output);
}

function normalizeTransfer(result, fallback = {}) {
  const filePaths = normalizeFilePaths(
    result.filePaths || result.files || result.changedFiles || fallback.filePaths,
  );
  return {
    taskId: result.taskId || fallback.taskId || null,
    branch: result.branch || fallback.branch || null,
    filePaths,
    summary: summarizeOutput(result),
    output: safeClone(result.output),
    metadata:
      result.metadata && typeof result.metadata === "object"
        ? safeClone(result.metadata)
        : null,
  };
}

function normalizeAgent(agent, index, options = {}) {
  const agentRunner =
    typeof options.agentRunner === "function" ? options.agentRunner : null;
  if (typeof agent === "function") {
    return {
      id: `agent-${index + 1}`,
      name: agent.name || `agent-${index + 1}`,
      run: agent,
      config: {},
    };
  }
  if (agent && typeof agent === "object") {
    const run =
      typeof agent.run === "function"
        ? agent.run.bind(agent)
        : typeof agent.execute === "function"
          ? agent.execute.bind(agent)
          : null;
    if (!run && !agentRunner) {
      throw new TypeError(`Pipeline agent at index ${index} must expose run() or execute().`);
    }
    return {
      id: String(agent.id || agent.name || `agent-${index + 1}`),
      name: String(agent.name || agent.id || `agent-${index + 1}`),
      run: run || ((descriptor, context) => agentRunner(agent, descriptor, context)),
      config: { ...agent },
    };
  }
  if (agentRunner) {
    return {
      id: `agent-${index + 1}`,
      name: `agent-${index + 1}`,
      run: (descriptor, context) => agentRunner(agent, descriptor, context),
      config: { value: agent },
    };
  }
  throw new TypeError(`Invalid pipeline agent at index ${index}.`);
}

function normalizeAgentResult(rawResult) {
  if (rawResult == null) {
    return {
      success: true,
      output: null,
      summary: "",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      metadata: null,
      branch: null,
      filePaths: [],
      raw: rawResult,
    };
  }

  if (typeof rawResult !== "object" || Array.isArray(rawResult)) {
    return {
      success: true,
      output: rawResult,
      summary: truncateText(rawResult),
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      metadata: null,
      branch: null,
      filePaths: [],
      raw: rawResult,
    };
  }

  const output =
    rawResult.output ?? rawResult.result ?? rawResult.finalResponse ?? rawResult.message ?? null;
  return {
    success: rawResult.success !== false,
    output,
    summary: truncateText(rawResult.summary || output || rawResult.error || ""),
    usage: normalizeUsage(rawResult.usage ?? rawResult.tokensUsed),
    metadata:
      rawResult.metadata && typeof rawResult.metadata === "object"
        ? safeClone(rawResult.metadata)
        : null,
    branch: rawResult.branch || null,
    filePaths: normalizeFilePaths(
      rawResult.filePaths || rawResult.files || rawResult.changedFiles,
    ),
    error: rawResult.error ? String(rawResult.error) : null,
    raw: safeClone(rawResult),
  };
}

function makeFreshContext(taskInput, previousOutput) {
  return Object.freeze({
    task: safeClone(taskInput),
    previous: previousOutput ? safeClone(previousOutput) : null,
  });
}

function relayAbort(sourceSignal, controller) {
  if (!sourceSignal) return () => {};
  const abort = () => controller.abort(sourceSignal.reason);
  if (sourceSignal.aborted) {
    abort();
    return () => {};
  }
  sourceSignal.addEventListener("abort", abort, { once: true });
  return () => sourceSignal.removeEventListener("abort", abort);
}

function createPipelineResult(kind, runId) {
  return {
    runId,
    kind,
    success: false,
    outputs: [],
    timing: {
      startedAt: new Date().toISOString(),
      startedAtMs: Date.now(),
      finishedAt: null,
      finishedAtMs: null,
      durationMs: 0,
    },
    tokensUsed: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
    errors: [],
    finalOutput: null,
    winner: null,
  };
}

class BasePipeline {
  constructor(kind, agents, options = {}) {
    this.kind = kind;
    this.agents = (Array.isArray(agents) ? agents : []).map((agent, index) =>
      normalizeAgent(agent, index, options));
    if (this.agents.length === 0) {
      throw new Error(`${kind} pipeline requires at least one agent.`);
    }
    this.options = { ...options };
    this.id = String(options.id || `${kind}-${randomUUID()}`);
    this.name = String(options.name || this.id);
  }

  async run(input = {}, runOptions = {}) {
    const result = createPipelineResult(this.kind, randomUUID());
    const managedHub = !this.options.hub && this.options.createHub !== false;
    const hub = this.options.hub || (await MsgHub.create(this.agents, this.options.hubOptions || {}));
    try {
      await this._runInternal(input, runOptions, result, hub);
    } finally {
      result.timing.finishedAtMs = Date.now();
      result.timing.finishedAt = new Date(result.timing.finishedAtMs).toISOString();
      result.timing.durationMs =
        result.timing.finishedAtMs - result.timing.startedAtMs;
      if (managedHub) {
        await hub.close();
      }
    }
    return result;
  }

  async _runInternal() {
    throw new Error("_runInternal must be implemented by subclasses.");
  }

  async _invokeAgent(agent, descriptor, runOptions, result, hub, extra = {}) {
    const startedAtMs = Date.now();
    const controller = new AbortController();
    const disconnectAbort = relayAbort(runOptions.signal, controller);
    try {
      const rawResult = await agent.run(descriptor, {
        signal: controller.signal,
        pipeline: {
          id: this.id,
          name: this.name,
          kind: this.kind,
          runId: result.runId,
        },
        hub,
        agent,
        agentIndex: extra.agentIndex ?? -1,
        previousOutput: safeClone(extra.previousOutput ?? null),
        options: { ...this.options, ...runOptions },
      });
      const normalized = normalizeAgentResult(rawResult);
      const finishedAtMs = Date.now();
      const outputEntry = {
        agentId: agent.id,
        agentName: agent.name,
        index: extra.agentIndex ?? -1,
        success: normalized.success,
        output: normalized.output,
        summary: normalized.summary,
        metadata: normalized.metadata,
        branch: normalized.branch,
        filePaths: normalized.filePaths,
        timing: {
          startedAt: new Date(startedAtMs).toISOString(),
          startedAtMs,
          finishedAt: new Date(finishedAtMs).toISOString(),
          finishedAtMs,
          durationMs: finishedAtMs - startedAtMs,
        },
        tokensUsed: normalized.usage,
        raw: normalized.raw,
        error: normalized.error,
      };

      addUsageTotals(result.tokensUsed, normalized.usage);
      if (!normalized.success) {
        const err = normalizeError(normalized.error || `Agent ${agent.name} failed.`);
        result.errors.push({
          agentId: agent.id,
          agentName: agent.name,
          index: outputEntry.index,
          error: err,
        });
      } else if (hub) {
        await hub.publish(agent.id, {
          kind: "agent-output",
          taskId: descriptor.task?.taskId || descriptor.task?.id || null,
          branch: outputEntry.branch || descriptor.task?.branch || null,
          filePaths: outputEntry.filePaths,
          summary: outputEntry.summary,
          metadata: outputEntry.metadata,
        });
      }

      return { outputEntry, transfer: normalizeTransfer(outputEntry, descriptor.task || {}) };
    } catch (error) {
      const normalizedError = normalizeError(error);
      const finishedAtMs = Date.now();
      const outputEntry = {
        agentId: agent.id,
        agentName: agent.name,
        index: extra.agentIndex ?? -1,
        success: false,
        output: null,
        summary: normalizedError.message,
        metadata: null,
        branch: null,
        filePaths: [],
        timing: {
          startedAt: new Date(startedAtMs).toISOString(),
          startedAtMs,
          finishedAt: new Date(finishedAtMs).toISOString(),
          finishedAtMs,
          durationMs: finishedAtMs - startedAtMs,
        },
        tokensUsed: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        raw: null,
        error: normalizedError.message,
      };
      result.errors.push({
        agentId: agent.id,
        agentName: agent.name,
        index: outputEntry.index,
        error: normalizedError,
      });
      return { outputEntry, transfer: null };
    } finally {
      disconnectAbort();
    }
  }
}

export class SequentialPipeline extends BasePipeline {
  constructor(agents, options = {}) {
    super("sequential", agents, options);
  }

  async _runInternal(input, runOptions, result, hub) {
    let previousOutput = null;
    for (let index = 0; index < this.agents.length; index += 1) {
      const agent = this.agents[index];
      const descriptor = makeFreshContext(input, previousOutput);
      const { outputEntry, transfer } = await this._invokeAgent(
        agent,
        descriptor,
        runOptions,
        result,
        hub,
        { agentIndex: index, previousOutput },
      );
      result.outputs.push(outputEntry);
      if (!outputEntry.success) {
        result.success = false;
        result.finalOutput = previousOutput;
        return;
      }
      previousOutput = transfer;
      result.finalOutput = safeClone(previousOutput);
    }
    result.success = true;
  }
}

export class FanoutPipeline extends BasePipeline {
  constructor(agents, options = {}) {
    super("fanout", agents, options);
  }

  async _runInternal(input, runOptions, result, hub) {
    const descriptor = makeFreshContext(input, null);
    const settled = await Promise.all(
      this.agents.map((agent, index) =>
        this._invokeAgent(agent, descriptor, runOptions, result, hub, { agentIndex: index }))
    );
    result.outputs = settled.map((entry) => entry.outputEntry);
    result.success = result.outputs.some((entry) => entry.success);
    const firstSuccess = settled.find((entry) => entry.outputEntry.success);
    result.finalOutput = firstSuccess ? safeClone(firstSuccess.transfer) : null;
  }
}

export class RacePipeline extends BasePipeline {
  constructor(agents, options = {}) {
    super("race", agents, options);
  }

  async _runInternal(input, runOptions, result, hub) {
    const descriptor = makeFreshContext(input, null);
    const runners = this.agents.map((agent, index) => {
      const controller = new AbortController();
      const disconnectAbort = relayAbort(runOptions.signal, controller);
      const promise = this._invokeAgent(
        {
          ...agent,
          run: (agentInput, agentContext) =>
            agent.run(agentInput, { ...agentContext, signal: controller.signal }),
        },
        descriptor,
        { ...runOptions, signal: controller.signal },
        result,
        hub,
        { agentIndex: index },
      ).finally(disconnectAbort);
      return { agent, index, controller, promise };
    });

    const unresolved = new Map(
      runners.map((entry) => [
        entry.index,
        entry.promise.then((value) => ({ index: entry.index, value })),
      ]),
    );

    let winner = null;
    while (unresolved.size > 0) {
      const { index, value } = await Promise.race(unresolved.values());
      unresolved.delete(index);
      result.outputs[index] = value.outputEntry;
      if (value.outputEntry.success) {
        winner = { index, transfer: value.transfer, output: value.outputEntry };
        for (const runner of runners) {
          if (runner.index !== index) {
            runner.controller.abort("race_lost");
          }
        }
        break;
      }
    }

    await Promise.allSettled(runners.map((entry) => entry.promise));
    result.outputs = result.outputs.filter(Boolean);
    result.success = Boolean(winner);
    result.winner = winner
      ? {
          index: winner.index,
          agentId: winner.output.agentId,
          agentName: winner.output.agentName,
        }
      : null;
    result.finalOutput = winner ? safeClone(winner.transfer) : null;
  }
}

function buildTaskDescription(taskInput) {
  const task = taskInput?.task || taskInput || {};
  const lines = [];
  const title = String(task.title || task.name || task.taskId || task.id || "").trim();
  const prompt = String(task.prompt || task.description || task.goal || "").trim();
  const branch = String(task.branch || "").trim();
  const filePaths = normalizeFilePaths(task.filePaths || task.files);
  if (title) lines.push(`Title: ${title}`);
  if (prompt) lines.push(`Task: ${prompt}`);
  if (branch) lines.push(`Branch: ${branch}`);
  if (filePaths.length > 0) {
    lines.push(`Files: ${filePaths.join(", ")}`);
  }
  return lines.join("\n");
}

function buildPreviousStageBlock(input) {
  if (!input?.previous) return "";
  const previous = input.previous;
  const lines = ["Previous stage output:"];
  if (previous.summary) lines.push(previous.summary);
  if (previous.branch) lines.push(`Branch: ${previous.branch}`);
  if (previous.filePaths?.length) lines.push(`Files: ${previous.filePaths.join(", ")}`);
  return lines.join("\n");
}

const STAGE_PROMPTS = Object.freeze({
  implement: (input) => [
    "You are the implementation stage in a Bosun fresh-context pipeline.",
    "Work only from the structured task descriptor and any prior stage summary.",
    buildTaskDescription(input.task),
    buildPreviousStageBlock(input),
    "Respond with a concise implementation summary, changed files, and branch notes.",
  ].filter(Boolean).join("\n\n"),
  test: (input) => [
    "You are the verification stage in a Bosun fresh-context pipeline.",
    buildTaskDescription(input.task),
    buildPreviousStageBlock(input),
    "Validate the work, list tests run or needed, and highlight any gaps.",
  ].filter(Boolean).join("\n\n"),
  review: (input) => [
    "You are the review stage in a Bosun fresh-context pipeline.",
    buildTaskDescription(input.task),
    buildPreviousStageBlock(input),
    "Produce a code-review style verdict with risks, blockers, and follow-ups.",
  ].filter(Boolean).join("\n\n"),
  search: (input) => [
    "You are a parallel research stage in a Bosun fanout pipeline.",
    buildTaskDescription(input.task),
    "Generate a concise approach, findings, and recommended next step.",
  ].filter(Boolean).join("\n\n"),
  vote: (input) => [
    "You are a voting stage in a Bosun consensus pipeline.",
    buildTaskDescription(input.task),
    buildPreviousStageBlock(input),
    "Reply with Verdict: approve|reject|abstain, Confidence: 0-100, and a short rationale.",
  ].filter(Boolean).join("\n\n"),
});

function normalizePipelineInput(input) {
  if (typeof input === "string") {
    return { title: "Workflow Task", prompt: input, description: input };
  }
  if (input && typeof input === "object") return safeClone(input);
  return {};
}

function buildAgentPrompt(spec, input, context) {
  const scope = {
    task: input.task,
    previous: input.previous,
    pipeline: context.pipeline,
    agent: { id: context.agent.id, name: context.agent.name },
  };
  if (typeof spec.promptBuilder === "function") {
    return spec.promptBuilder(input, context);
  }
  if (typeof spec.promptTemplate === "string") {
    return resolveTemplate(spec.promptTemplate, scope);
  }
  if (typeof spec.prompt === "string" && spec.prompt.trim()) {
    return resolveTemplate(spec.prompt, scope);
  }
  const stageKey = String(spec.stage || spec.role || spec.name || "implement")
    .trim()
    .toLowerCase();
  const factory = STAGE_PROMPTS[stageKey] || STAGE_PROMPTS.implement;
  return factory(input);
}

function buildAgentTaskKey(workflowName, spec, pipelineContext) {
  const parts = [
    workflowName || pipelineContext?.name || "pipeline",
    spec.name || spec.id || spec.stage || spec.sdk || "agent",
    pipelineContext?.runId || randomUUID(),
  ];
  return parts.map((entry) => String(entry || "").trim()).filter(Boolean).join(":");
}

function buildManagedPipelineSessionContext(spec, taskInput, context, taskKey) {
  const task = taskInput?.task || {};
  const taskId = String(task.taskId || task.id || "").trim() || null;
  const pipelineRunId = String(context?.pipeline?.runId || "").trim() || null;
  const workflowName = String(context?.pipeline?.name || "").trim() || "pipeline";
  const stageName = String(spec.name || spec.id || spec.stage || spec.sdk || "agent").trim() || "agent";
  const fallbackParentSessionId =
    String(
      task.sessionId ||
      task.parentSessionId ||
      task.rootSessionId ||
      taskId ||
      "",
    ).trim() || null;
  const sessionId = [
    taskId || workflowName,
    "pipeline",
    normalizePipelineSessionSegment(stageName, "agent"),
    normalizePipelineSessionSegment(pipelineRunId || taskKey, "run"),
  ].join(":");
  return {
    taskId,
    sessionId,
    sessionScope: taskId ? "pipeline-task" : "pipeline-flow",
    parentSessionId: fallbackParentSessionId,
    rootSessionId:
      String(task.rootSessionId || fallbackParentSessionId || taskId || "").trim() || null,
    metadata: {
      source: "workflow-pipeline-agent",
      pipelineId: String(context?.pipeline?.id || "").trim() || null,
      pipelineName: workflowName,
      pipelineKind: String(context?.pipeline?.kind || "").trim() || null,
      pipelineRunId,
      stageName,
      taskId,
      taskTitle: String(task.title || task.name || "").trim() || null,
    },
  };
}

export function createBosunAgent(spec = {}, services = {}) {
  const normalizedSpec = { timeoutMs: DEFAULT_TIMEOUT_MS, sdk: "auto", ...spec };
  return {
    id: String(normalizedSpec.id || normalizedSpec.name || normalizedSpec.stage || randomUUID()),
    name: String(normalizedSpec.name || normalizedSpec.id || normalizedSpec.stage || "agent"),
    async run(input, context = {}) {
      const agentPool = services.agentPool || normalizedSpec.agentPool;
      if (!agentPool) {
        throw new Error(`Bosun pipeline agent "${normalizedSpec.name || normalizedSpec.id || "agent"}" requires agentPool service.`);
      }

      const taskInput = {
        task: normalizePipelineInput(input.task),
        previous: input.previous ? safeClone(input.previous) : null,
      };
      const prompt = buildAgentPrompt(normalizedSpec, taskInput, context);
      const timeoutMs = Number(normalizedSpec.timeoutMs || normalizedSpec.timeout || DEFAULT_TIMEOUT_MS);
      const cwd = resolveTemplate(
        normalizedSpec.cwd || taskInput.task.cwd || process.cwd(),
        { task: taskInput.task, previous: taskInput.previous },
      );
      const sdk = normalizedSpec.sdk || "auto";
      const model = normalizedSpec.model || undefined;
      const abortController = new AbortController();
      const disconnectAbort = relayAbort(context.signal, abortController);
      const taskKey = buildAgentTaskKey(context.pipeline?.name, normalizedSpec, context.pipeline);
      const managedSession = buildManagedPipelineSessionContext(
        normalizedSpec,
        taskInput,
        context,
        taskKey,
      );
      const harnessAgentService = createHarnessAgentService({ agentPool });

      try {
        const rawResult = await harnessAgentService.runTask(prompt, {
          autoRecover: normalizedSpec.autoRecover !== false,
          taskKey,
          cwd,
          timeoutMs,
          sdk,
          model,
          sessionId: managedSession.sessionId,
          sessionScope: managedSession.sessionScope,
          parentSessionId: managedSession.parentSessionId,
          rootSessionId: managedSession.rootSessionId,
          metadata: managedSession.metadata,
          abortController,
          maxRetries: Number(normalizedSpec.maxRetries ?? 1),
          maxContinues: Number(normalizedSpec.maxContinues ?? 1),
        });

        return {
          success: rawResult?.success !== false,
          output: rawResult?.output ?? rawResult?.finalResponse ?? rawResult?.message ?? "",
          summary:
            rawResult?.summary || rawResult?.output || rawResult?.finalResponse || rawResult?.message || "",
          usage: rawResult?.usage || rawResult?.tokensUsed || null,
          metadata: {
            sdk: rawResult?.sdk || sdk,
            model,
            threadId: rawResult?.threadId || null,
            stage: normalizedSpec.stage || null,
          },
          branch: taskInput.task.branch || null,
          filePaths: normalizeFilePaths(taskInput.task.filePaths || taskInput.task.files),
          error: rawResult?.error || null,
          raw: rawResult,
        };
      } finally {
        disconnectAbort();
      }
    },
  };
}

export const BUILTIN_WORKFLOWS = Object.freeze({
  "code-review-chain": {
    type: "sequential",
    description: "Implementation -> verification -> review with fresh-context handoff.",
    stages: ["implement", "test", "review"],
  },
  "parallel-search": {
    type: "fanout",
    description: "Broadcast the same task to multiple SDKs and collect all findings.",
    agents: [
      { name: "codex-search", stage: "search", sdk: "codex" },
      { name: "claude-search", stage: "search", sdk: "claude" },
      { name: "copilot-search", stage: "search", sdk: "copilot" },
    ],
  },
  "consensus-vote": {
    type: "fanout",
    description: "Ask multiple agents for approve/reject/abstain votes on the same task.",
    agents: [
      { name: "codex-vote", stage: "vote", sdk: "codex" },
      { name: "claude-vote", stage: "vote", sdk: "claude" },
      { name: "copilot-vote", stage: "vote", sdk: "copilot" },
    ],
  },
});

function normalizeConfiguredAgent(agent, index, services) {
  if (typeof agent === "function") return agent;
  if (agent && typeof agent === "object" && (typeof agent.run === "function" || typeof agent.execute === "function")) {
    return agent;
  }
  if (typeof agent === "string") {
    return createBosunAgent({ name: agent, stage: agent }, services);
  }
  if (agent && typeof agent === "object") {
    return createBosunAgent(agent, services);
  }
  throw new TypeError(`Invalid workflow agent at index ${index}.`);
}

export function resolveWorkflowDefinition(name, configuredWorkflows = {}) {
  const configValue = configuredWorkflows?.[name];
  if (configValue && typeof configValue === "object") {
    return { name, source: "config", definition: { ...configValue, id: name, name } };
  }
  const builtin = BUILTIN_WORKFLOWS[name];
  if (builtin) {
    return { name, source: "builtin", definition: { ...builtin, id: name, name } };
  }
  return null;
}

export function listWorkflowDefinitions(configuredWorkflows = {}) {
  const names = new Set([
    ...Object.keys(BUILTIN_WORKFLOWS),
    ...Object.keys(configuredWorkflows || {}),
  ]);
  return [...names]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => resolveWorkflowDefinition(name, configuredWorkflows));
}

export function createConfiguredPipeline(definition, options = {}) {
  const normalized = definition?.definition ? definition.definition : definition;
  if (!normalized || typeof normalized !== "object") {
    throw new Error("Workflow definition must be an object.");
  }

  const type = String(normalized.type || "sequential").trim().toLowerCase();
  const rawAgents =
    type === "sequential"
      ? normalized.stages || normalized.agents
      : normalized.agents || normalized.stages;
  if (!Array.isArray(rawAgents) || rawAgents.length === 0) {
    throw new Error(`Workflow "${normalized.name || normalized.id || "workflow"}" must define at least one stage/agent.`);
  }

  const services = options.services || {};
  const agents = rawAgents.map((agent, index) => normalizeConfiguredAgent(agent, index, services));
  const pipelineOptions = {
    id: normalized.id,
    name: normalized.name,
    hub: options.hub,
    createHub: options.createHub,
    hubOptions: options.hubOptions,
  };

  switch (type) {
    case "sequential":
      return new SequentialPipeline(agents, pipelineOptions);
    case "fanout":
      return new FanoutPipeline(agents, pipelineOptions);
    case "race":
      return new RacePipeline(agents, pipelineOptions);
    default:
      throw new Error(`Unsupported workflow type: ${type}`);
  }
}

export async function runConfiguredWorkflow(name, input = {}, options = {}) {
  const resolved = resolveWorkflowDefinition(name, options.workflows || {});
  if (!resolved) {
    throw new Error(`Unknown workflow: ${name}`);
  }
  const pipeline = createConfiguredPipeline(resolved, options);
  return pipeline.run(input, options.runOptions || {});
}

export function parsePipelineDefinition(definition) {
  if (typeof definition === "string") {
    return JSON.parse(definition);
  }
  return safeClone(definition);
}

export function createPipeline(definition, options = {}) {
  return createConfiguredPipeline(parsePipelineDefinition(definition), options);
}

export class Pipeline extends SequentialPipeline {
  constructor(config = {}, options = {}) {
    const definition = parsePipelineDefinition(config);
    const stages = definition.stages || definition.agents || [];
    super(stages, { ...options, id: definition.id, name: definition.name });
    this.definition = definition;
  }
}

export class PipelineStage {
  constructor(config = {}) {
    Object.assign(this, config);
  }
}

export default {
  Pipeline,
  PipelineStage,
  SequentialPipeline,
  FanoutPipeline,
  RacePipeline,
  MsgHub,
  BUILTIN_WORKFLOWS,
  createBosunAgent,
  createConfiguredPipeline,
  createPipeline,
  listWorkflowDefinitions,
  parsePipelineDefinition,
  resolveWorkflowDefinition,
  runConfiguredWorkflow,
};
