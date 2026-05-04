/**
 * @module task/pipeline
 * @description Declarative multi-agent pipeline primitives with fresh-context stage isolation.
 */

import { randomUUID } from "node:crypto";

function normalizeStage(stage, index) {
  if (typeof stage === "function") {
    return {
      id: `stage-${index + 1}`,
      name: stage.name || `stage-${index + 1}`,
      run: stage,
      meta: {},
    };
  }

  if (stage && typeof stage === "object") {
    const runner =
      typeof stage.run === "function"
        ? stage.run.bind(stage)
        : typeof stage.execute === "function"
          ? stage.execute.bind(stage)
          : null;
    if (!runner) {
      throw new TypeError(`Pipeline stage ${index + 1} is missing run/execute()`);
    }
    return {
      id: String(stage.id || stage.name || `stage-${index + 1}`),
      name: String(stage.name || stage.id || `stage-${index + 1}`),
      run: runner,
      meta: { ...stage },
    };
  }

  throw new TypeError(`Unsupported pipeline stage at index ${index}`);
}

function normalizeStages(stages) {
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new TypeError("Pipeline requires at least one stage");
  }
  return stages.map((stage, index) => normalizeStage(stage, index));
}

function normalizeError(error) {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack || "",
    };
  }
  return {
    message: String(error || "Unknown pipeline error"),
    name: "Error",
    stack: "",
  };
}

function coerceText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function pickDescriptorFields(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const descriptor = {};
  const mappings = [
    ["taskId", ["taskId", "id"]],
    ["title", ["title", "taskTitle", "name"]],
    ["summary", ["summary", "message", "result"]],
    ["branch", ["branch", "branchName"]],
    ["baseBranch", ["baseBranch"]],
    ["repoRoot", ["repoRoot", "cwd"]],
    ["repoSlug", ["repoSlug"]],
    ["workspace", ["workspace"]],
    ["repository", ["repository", "repo"]],
    ["status", ["status"]],
  ];

  for (const [targetKey, candidateKeys] of mappings) {
    for (const key of candidateKeys) {
      const candidate = value[key];
      if (candidate == null || candidate === "") continue;
      descriptor[targetKey] = candidate;
      break;
    }
  }

  const paths = value.paths || value.filePaths || value.files;
  if (Array.isArray(paths) && paths.length > 0) {
    descriptor.paths = paths.filter(Boolean).map((entry) => String(entry)).slice(0, 50);
  }

  return Object.keys(descriptor).length > 0 ? descriptor : null;
}

export function toMinimalDescriptor(value) {
  const descriptor = pickDescriptorFields(value);
  if (descriptor) return descriptor;
  if (Array.isArray(value)) {
    return {
      items: value.slice(0, 10).map((entry) => toMinimalDescriptor(entry)),
    };
  }
  return {
    summary: coerceText(value).slice(0, 4000),
  };
}

function defaultPrepareStageInput(previousRecord, initialInput) {
  if (!previousRecord) return toMinimalDescriptor(initialInput);
  return previousRecord.descriptor || toMinimalDescriptor(previousRecord.output);
}

function defaultGetTokensUsed(result) {
  const candidates = [
    result?.tokensUsed,
    result?.usage?.totalTokens,
    result?.usage?.total_tokens,
    result?.tokenUsage?.total,
    result?.metrics?.tokensUsed,
  ];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 0;
}

function createBaseContext({
  pipelineType,
  runId,
  stage,
  index,
  initialInput,
  stageInput,
  previousRecord,
  signal,
  options,
}) {
  return {
    runId,
    pipelineType,
    stageId: stage.id,
    stageName: stage.name,
    stageIndex: index,
    initialInput: toMinimalDescriptor(initialInput),
    input: toMinimalDescriptor(stageInput),
    previousOutput: previousRecord ? previousRecord.descriptor : null,
    freshContext: true,
    signal,
    options,
  };
}

function createStageRecord({ stage, index, input, result, startedAt, endedAt, successOverride }) {
  const rawOutput = result && typeof result === "object" && Object.hasOwn(result, "output")
    ? result.output
    : result;
  const success =
    typeof successOverride === "boolean"
      ? successOverride
      : !(result && typeof result === "object" && result.success === false);
  return {
    stageId: stage.id,
    stageName: stage.name,
    stageIndex: index,
    input: toMinimalDescriptor(input),
    output: rawOutput,
    descriptor: toMinimalDescriptor(
      result && typeof result === "object" && result.descriptor
        ? result.descriptor
        : rawOutput,
    ),
    success,
    tokensUsed: defaultGetTokensUsed(result),
    meta: result && typeof result === "object" ? { ...result } : {},
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
  };
}

function createCancelledRecord(stage, index, input, reason) {
  const now = Date.now();
  return {
    stageId: stage.id,
    stageName: stage.name,
    stageIndex: index,
    input: toMinimalDescriptor(input),
    output: null,
    descriptor: { summary: reason },
    success: false,
    tokensUsed: 0,
    meta: { cancelled: true, reason },
    startedAt: now,
    endedAt: now,
    durationMs: 0,
  };
}

function finalizePipelineResult(type, startedAt, outputs, errors, extra = {}) {
  const endedAt = Date.now();
  const tokensUsed = outputs.reduce(
    (sum, record) => sum + (Number(record?.tokensUsed) || 0),
    0,
  );
  const ok = errors.length === 0 && outputs.some((record) => record?.success !== false);
  return {
    ok,
    success: ok,
    type,
    outputs,
    timing: {
      startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - startedAt),
      stages: outputs.map((record) => ({
        stageId: record.stageId,
        stageName: record.stageName,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        durationMs: record.durationMs,
      })),
    },
    tokensUsed,
    errors,
    ...extra,
  };
}

function createPipeline(type, stages, options = {}, runner) {
  const normalizedStages = normalizeStages(stages);
  const pipelineOptions = { ...options };
  return Object.freeze({
    type,
    stages: normalizedStages.map((stage) => ({ ...stage.meta, id: stage.id, name: stage.name })),
    options: pipelineOptions,
    async run(initialInput, runtimeOptions = {}) {
      return runner(normalizedStages, initialInput, { ...pipelineOptions, ...runtimeOptions });
    },
  });
}

async function executeStage(stage, input, baseContext, options) {
  const createContext =
    typeof options.createContext === "function"
      ? options.createContext
      : (ctx) => ctx;
  const context = createContext(baseContext);
  if (context?.signal?.aborted) {
    const error = new Error(String(context.signal.reason || "aborted"));
    error.name = "AbortError";
    throw error;
  }
  return stage.run(input, context);
}

export function SequentialPipeline(stages, options = {}) {
  return createPipeline("sequential", stages, options, async (normalizedStages, initialInput, runtimeOptions) => {
    const startedAt = Date.now();
    const runId = String(runtimeOptions.runId || randomUUID());
    const outputs = [];
    const errors = [];
    const prepareStageInput =
      typeof runtimeOptions.prepareStageInput === "function"
        ? runtimeOptions.prepareStageInput
        : defaultPrepareStageInput;

    let previousRecord = null;
    for (const [index, stage] of normalizedStages.entries()) {
      const stageInput =
        index === 0
          ? initialInput
          : prepareStageInput(previousRecord, initialInput, stage, index, outputs.slice());
      const started = Date.now();
      try {
        runtimeOptions.onStageStart?.(stage, stageInput, index);
        const result = await executeStage(
          stage,
          stageInput,
          createBaseContext({
            pipelineType: "sequential",
            runId,
            stage,
            index,
            initialInput,
            stageInput,
            previousRecord,
            signal: runtimeOptions.signal || null,
            options: runtimeOptions,
          }),
          runtimeOptions,
        );
        const record = createStageRecord({
          stage,
          index,
          input: stageInput,
          result,
          startedAt: started,
          endedAt: Date.now(),
        });
        outputs.push(record);
        previousRecord = record;
        runtimeOptions.onStageComplete?.(record, index);
        if (record.success === false) {
          errors.push({ stageId: stage.id, stageName: stage.name, error: normalizeError(record.meta?.error || "Stage returned success=false") });
          break;
        }
      } catch (error) {
        const normalized = normalizeError(error);
        outputs.push(
          createStageRecord({
            stage,
            index,
            input: stageInput,
            result: { output: null, error: normalized.message, success: false },
            startedAt: started,
            endedAt: Date.now(),
            successOverride: false,
          }),
        );
        errors.push({ stageId: stage.id, stageName: stage.name, error: normalized });
        runtimeOptions.onStageError?.(normalized, stage, index);
        break;
      }
    }

    return finalizePipelineResult("sequential", startedAt, outputs, errors, {
      finalOutput: outputs.at(-1)?.output ?? null,
      runId,
    });
  });
}

export function FanoutPipeline(stages, options = {}) {
  return createPipeline("fanout", stages, options, async (normalizedStages, initialInput, runtimeOptions) => {
    const startedAt = Date.now();
    const runId = String(runtimeOptions.runId || randomUUID());
    const outputs = new Array(normalizedStages.length);
    const errors = [];
    const prepareStageInput =
      typeof runtimeOptions.prepareStageInput === "function"
        ? runtimeOptions.prepareStageInput
        : (_previousRecord, seed) => toMinimalDescriptor(seed);

    await Promise.allSettled(
      normalizedStages.map(async (stage, index) => {
        const stageInput = prepareStageInput(null, initialInput, stage, index, []);
        const started = Date.now();
        try {
          runtimeOptions.onStageStart?.(stage, stageInput, index);
          const result = await executeStage(
            stage,
            stageInput,
            createBaseContext({
              pipelineType: "fanout",
              runId,
              stage,
              index,
              initialInput,
              stageInput,
              previousRecord: null,
              signal: runtimeOptions.signal || null,
              options: runtimeOptions,
            }),
            runtimeOptions,
          );
          outputs[index] = createStageRecord({
            stage,
            index,
            input: stageInput,
            result,
            startedAt: started,
            endedAt: Date.now(),
          });
          runtimeOptions.onStageComplete?.(outputs[index], index);
          if (outputs[index].success === false) {
            errors.push({ stageId: stage.id, stageName: stage.name, error: normalizeError(outputs[index].meta?.error || "Stage returned success=false") });
          }
        } catch (error) {
          const normalized = normalizeError(error);
          outputs[index] = createStageRecord({
            stage,
            index,
            input: stageInput,
            result: { output: null, error: normalized.message, success: false },
            startedAt: started,
            endedAt: Date.now(),
            successOverride: false,
          });
          errors.push({ stageId: stage.id, stageName: stage.name, error: normalized });
          runtimeOptions.onStageError?.(normalized, stage, index);
        }
      }),
    );

    return finalizePipelineResult(
      "fanout",
      startedAt,
      outputs.filter(Boolean),
      errors,
      { runId },
    );
  });
}

export function RacePipeline(stages, options = {}) {
  return createPipeline("race", stages, options, async (normalizedStages, initialInput, runtimeOptions) => {
    const startedAt = Date.now();
    const runId = String(runtimeOptions.runId || randomUUID());
    const outputs = new Array(normalizedStages.length);
    const errors = [];
    const prepareStageInput =
      typeof runtimeOptions.prepareStageInput === "function"
        ? runtimeOptions.prepareStageInput
        : (_previousRecord, seed) => toMinimalDescriptor(seed);

    const controllers = normalizedStages.map(() => new AbortController());
    if (runtimeOptions.signal) {
      const propagateAbort = () => {
        for (const controller of controllers) {
          if (!controller.signal.aborted) {
            controller.abort(runtimeOptions.signal.reason || "aborted");
          }
        }
      };
      if (runtimeOptions.signal.aborted) {
        propagateAbort();
      } else {
        runtimeOptions.signal.addEventListener("abort", propagateAbort, { once: true });
      }
    }

    let winner = null;
    let resolved = false;

    const settleWinner = (record, index) => {
      winner = { ...record, stageIndex: index };
      for (const [controllerIndex, controller] of controllers.entries()) {
        if (controllerIndex === index || controller.signal.aborted) continue;
        controller.abort("race_won");
        if (!outputs[controllerIndex]) {
          outputs[controllerIndex] = createCancelledRecord(
            normalizedStages[controllerIndex],
            controllerIndex,
            prepareStageInput(null, initialInput, normalizedStages[controllerIndex], controllerIndex, []),
            "Cancelled after another stage won the race",
          );
        }
      }
      resolved = true;
      return finalizePipelineResult(
        "race",
        startedAt,
        outputs.filter(Boolean),
        errors,
        { winner, finalOutput: winner.output, runId },
      );
    };

    const pending = normalizedStages.map((stage, index) => (async () => {
      const stageInput = prepareStageInput(null, initialInput, stage, index, []);
      const started = Date.now();
      try {
        runtimeOptions.onStageStart?.(stage, stageInput, index);
        const result = await executeStage(
          stage,
          stageInput,
          createBaseContext({
            pipelineType: "race",
            runId,
            stage,
            index,
            initialInput,
            stageInput,
            previousRecord: null,
            signal: controllers[index].signal,
            options: runtimeOptions,
          }),
          runtimeOptions,
        );
        const record = createStageRecord({
          stage,
          index,
          input: stageInput,
          result,
          startedAt: started,
          endedAt: Date.now(),
        });
        outputs[index] = record;
        runtimeOptions.onStageComplete?.(record, index);
        if (record.success !== false && !resolved) {
          return settleWinner(record, index);
        }
        if (record.success === false) {
          errors.push({ stageId: stage.id, stageName: stage.name, error: normalizeError(record.meta?.error || "Stage returned success=false") });
        }
        return null;
      } catch (error) {
        const normalized = normalizeError(error);
        const isAbort = normalized.name === "AbortError" || /aborted|race_won/i.test(normalized.message);
        outputs[index] = createStageRecord({
          stage,
          index,
          input: stageInput,
          result: { output: null, error: normalized.message, success: false },
          startedAt: started,
          endedAt: Date.now(),
          successOverride: false,
        });
        if (!isAbort || !resolved) {
          errors.push({ stageId: stage.id, stageName: stage.name, error: normalized });
          runtimeOptions.onStageError?.(normalized, stage, index);
        }
        return null;
      }
    })());

    const firstResult = await Promise.race(pending);
    if (firstResult) return firstResult;

    await Promise.allSettled(pending);
    return finalizePipelineResult(
      "race",
      startedAt,
      outputs.filter(Boolean),
      errors,
      { winner: null, finalOutput: null, runId },
    );
  });
}

export default {
  SequentialPipeline,
  FanoutPipeline,
  RacePipeline,
  toMinimalDescriptor,
};
