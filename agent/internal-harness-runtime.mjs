import {
  expireApprovalRequest,
  upsertHarnessRunApprovalRequest,
} from "../workflow/approval-queue.mjs";
import { createFollowupQueue } from "./harness/followup-queue.mjs";
import { createHarnessEventContract, normalizeHarnessEvent } from "./harness/event-contract.mjs";
import { createHarnessRunContract, normalizeHarnessRunVerb } from "./harness/run-contract.mjs";
import { createHarnessRuntimeConfig, resolveHarnessStageRuntime } from "./harness/runtime-config.mjs";
import {
  appendHarnessHistory,
  appendHarnessSessionEvent,
  createHarnessSessionState,
  replaceHarnessFollowups,
  replaceHarnessSteering,
  setHarnessActiveTurn,
  updateHarnessSessionState,
} from "./harness/session-state.mjs";
import { createSteeringQueue } from "./harness/steering-queue.mjs";
import { createTurnRunner } from "./harness/turn-runner.mjs";
import { normalizeTurnResult } from "./harness/message-normalizer.mjs";

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function toPositiveInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : fallback;
}

function buildStageMap(profile) {
  const map = new Map();
  for (const stage of Array.isArray(profile?.stages) ? profile.stages : []) {
    if (!stage?.id) continue;
    map.set(stage.id, stage);
  }
  return map;
}

function emitEvent(hook, payload) {
  if (typeof hook !== "function") return;
  try {
    hook(payload);
  } catch {
    // Harness event hooks must never break execution.
  }
}

function cloneValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeOutcomeToken(value) {
  return toTrimmedString(value).toLowerCase();
}

function buildOutcomeAliases(outcome) {
  const normalized = normalizeOutcomeToken(outcome);
  if (!normalized) return [];
  const aliases = [normalized];
  if (["success", "completed", "complete", "ok", "pass", "passed"].includes(normalized)) {
    aliases.push("next");
  }
  if (["failure", "failed", "error"].includes(normalized)) {
    aliases.push("failure");
    aliases.push("error");
  }
  if (normalized === "repair-exhausted") {
    aliases.push("failure");
    aliases.push("error");
  }
  return [...new Set(aliases.filter(Boolean))];
}

function resolveStageTransition(stage, outcomes) {
  const transitions = Array.isArray(stage?.transitions) ? stage.transitions : [];
  const requested = Array.isArray(outcomes) ? outcomes : [outcomes];
  const aliases = requested.flatMap((entry) => buildOutcomeAliases(entry));
  if (aliases.length > 0) {
    for (const outcome of aliases) {
      const match = transitions.find((entry) => normalizeOutcomeToken(entry?.on || "next") === outcome);
      if (match) {
        return {
          on: normalizeOutcomeToken(match.on || "next") || "next",
          to: toTrimmedString(match.to || ""),
        };
      }
    }
  }
  return null;
}

function normalizeExecutionResult(result, mode) {
  const raw = normalizeTurnResult(result, { mode });
  const success = raw.success !== false;
  const outcome = normalizeOutcomeToken(
    raw.outcome || raw.transitionOutcome || raw.status || (success ? "success" : "failure"),
  ) || (success ? "success" : "failure");
  const status = toTrimmedString(raw.status || (success ? "completed" : "failed")) || (success ? "completed" : "failed");
  return {
    ...raw,
    success,
    outcome,
    status,
    mode,
    threadId: raw.threadId || null,
  };
}

function buildDryRunResult(stage, mode) {
  return {
    success: true,
    outcome: "success",
    status: "dry_run",
    dryRun: true,
    simulated: true,
    output: `Dry-run completed for stage "${stage.id}"`,
    mode,
    threadId: null,
  };
}

function stageRequiresOperatorApproval(stage = {}) {
  const stageType = toTrimmedString(stage?.type).toLowerCase();
  if (stageType === "gate") return true;
  if (stage?.approvalRequired === true) return true;
  if (stage?.approval && typeof stage.approval === "object") {
    if (stage.approval.required !== false) return true;
  }
  const tools = Array.isArray(stage?.tools) ? stage.tools : [];
  return tools.some((tool) => {
    const normalized = toTrimmedString(tool).toLowerCase();
    return normalized === "approval_gate"
      || normalized === "await_approval"
      || normalized === "manual_approval";
  });
}

function normalizeApprovalDecision(value, fallback = "approved") {
  const normalized = toTrimmedString(value).toLowerCase();
  if (["approved", "denied", "expired", "aborted"].includes(normalized)) return normalized;
  if (normalized === "approve" || normalized === "success") return "approved";
  if (normalized === "deny" || normalized === "denied" || normalized === "rejected") return "denied";
  if (normalized === "timeout") return "expired";
  return fallback;
}

function buildApprovalPreview(stage, result = {}) {
  const preview = toTrimmedString(
    result?.summary
    || result?.output
    || result?.error
    || stage?.prompt
    || "",
  );
  return preview || null;
}

export function normalizeHarnessTurnResult(result, context = {}) {
  const raw = result && typeof result === "object"
    ? { ...result }
    : {
        output: result == null ? "" : String(result),
      };
  const success = raw.success !== false;
  return {
    ...raw,
    success,
    outcome: toTrimmedString(raw.outcome || raw.transitionOutcome || raw.status || (success ? "success" : "failure")).toLowerCase()
      || (success ? "success" : "failure"),
    status: toTrimmedString(raw.status || (success ? "completed" : "failed")) || (success ? "completed" : "failed"),
    stageId: toTrimmedString(raw.stageId || context.stageId || ""),
    mode: toTrimmedString(raw.mode || context.mode || ""),
    threadId: raw.threadId || null,
  };
}

export function buildInternalHarnessTurnExecutor(options = {}) {
  if (typeof options.turnExecutor === "function") {
    return async function executeCustomHarnessTurn(context = {}) {
      return await options.turnExecutor({
        ...context,
        abortController: options.abortController || context.abortController || null,
        signal: options.abortController?.signal || context.signal || null,
      });
    };
  }

  const execInitialTurn = typeof options.execInitialTurn === "function"
    ? options.execInitialTurn
    : typeof options.execWithRetry === "function"
      ? options.execWithRetry
      : null;
  const execContinueTurn = typeof options.execContinueTurn === "function"
    ? options.execContinueTurn
    : typeof options.launchOrResumeThread === "function"
      ? options.launchOrResumeThread
      : null;
  const normalizeTimeoutMs = typeof options.normalizeTimeoutMs === "function"
    ? options.normalizeTimeoutMs
    : (value) => toPositiveInteger(value, 0) || undefined;
  const defaultTimeoutMs = normalizeTimeoutMs(options.defaultTimeoutMs || options.timeoutMs);
  const defaultCwd = toTrimmedString(options.defaultCwd || options.cwd || process.cwd()) || process.cwd();

  return async function executeHarnessTurn({
    profile,
    stage,
    taskKey,
    prompt,
    mode,
    timeoutMs,
  }) {
    const cwd = stage.cwd || options.cwd || profile.cwd || defaultCwd;
    const resolvedTimeoutMs = normalizeTimeoutMs(timeoutMs || stage.timeoutMs || options.timeoutMs) ?? defaultTimeoutMs;
    const sessionType = stage.sessionType || profile.sessionType || options.sessionType || "task";
    const sdk = stage.sdk || options.sdk || profile.sdk || undefined;
    const model = stage.model || options.model || profile.model || undefined;
    const stageTaskKey = stage.taskKey || taskKey || profile.taskKey || profile.agentId || stage.id;
    const sharedOptions = {
      cwd,
      timeoutMs: resolvedTimeoutMs,
      sdk,
      model,
      mcpServers: options.mcpServers,
      onEvent: options.onEvent,
      sessionType,
      forceContextShredding: options.forceContextShredding === true,
      skipContextShredding: options.skipContextShredding === true,
      compressEphemeralItems: options.compressEphemeralItems,
      abortController: options.abortController || null,
      slotOwnerKey: options.slotOwnerKey,
      slotMeta: options.slotMeta,
      slotMaxParallel: options.slotMaxParallel,
      onSlotQueued: options.onSlotQueued,
      onSlotAcquired: options.onSlotAcquired,
      onSlotReleased: options.onSlotReleased,
    };
    const normalizedMode = normalizeHarnessRunVerb(mode, "initial");

    if (["initial", "retry"].includes(normalizedMode)) {
      if (typeof execInitialTurn !== "function") {
        throw new Error("Harness initial turn executor is not configured");
      }
      const result = await execInitialTurn(prompt, {
        ...sharedOptions,
        taskKey: stageTaskKey,
        maxRetries: stage.maxRetries,
        maxContinues: stage.maxContinues,
      });
      return normalizeHarnessTurnResult(result, {
        stageId: stage.id,
        mode: normalizedMode,
      });
    }

    if (typeof execContinueTurn !== "function") {
      throw new Error("Harness continuation executor is not configured");
    }
    const result = await execContinueTurn(prompt, cwd, resolvedTimeoutMs, {
      taskKey: stageTaskKey,
      sdk: sharedOptions.sdk,
      model: sharedOptions.model,
      mcpServers: sharedOptions.mcpServers,
      sessionType: sharedOptions.sessionType,
      forceContextShredding: sharedOptions.forceContextShredding,
      skipContextShredding: sharedOptions.skipContextShredding,
      onEvent: sharedOptions.onEvent,
      abortController: sharedOptions.abortController,
      slotOwnerKey: sharedOptions.slotOwnerKey,
      slotMeta: sharedOptions.slotMeta,
      slotMaxParallel: sharedOptions.slotMaxParallel,
      onSlotQueued: sharedOptions.onSlotQueued,
      onSlotAcquired: sharedOptions.onSlotAcquired,
      onSlotReleased: sharedOptions.onSlotReleased,
      ignoreSdkCooldown: true,
    });
    return normalizeHarnessTurnResult(result, {
      stageId: stage.id,
      mode: normalizedMode,
    });
  };
}

export function createInternalHarnessRuntime(compiledProfile, options = {}) {
  const profile = compiledProfile && typeof compiledProfile === "object"
    ? compiledProfile
    : {};
  const stageMap = buildStageMap(profile);
  const maxSteps = Math.max(8, stageMap.size * 4);
  const dryRun = options.dryRun === true;
  const taskKey = toTrimmedString(options.taskKey || profile.taskKey || profile.agentId || profile.name || "harness");
  const runId = toTrimmedString(options.runId || options.sessionId || taskKey || profile.agentId || "harness-run");
  const taskId = toTrimmedString(options.taskId || profile.taskId || "");
  const taskTitle = toTrimmedString(options.taskTitle || profile.taskTitle || profile.name || "");
  const approvalRepoRoot = toTrimmedString(options.approvalRepoRoot || options.repoRoot || "");
  const sessionId = toTrimmedString(options.sessionId || runId || taskKey || profile.agentId || "harness-session");
  const runtimeConfig = createHarnessRuntimeConfig(profile, {
    ...options,
    runId,
    sessionId,
    taskKey,
    taskId,
    taskTitle,
  });
  const runContract = createHarnessRunContract({
    profile,
    runtimeConfig,
    runId,
    sessionId,
    taskKey,
    taskId,
    taskTitle,
    dryRun,
    metadata: {
      surface: runtimeConfig.surface.surface,
      channel: runtimeConfig.surface.channel,
      requestedBy: runtimeConfig.surface.requestedBy,
      cwd: runtimeConfig.profileDefaults.cwd,
    },
  });
  const eventContract = createHarnessEventContract({
    runtimeConfig,
    runContract,
  });
  const followupQueue = createFollowupQueue(options.followups || []);
  const steeringQueue = createSteeringQueue(options.pendingInterventions || []);
  let sessionState = createHarnessSessionState({
    sessionId,
    runId,
    taskKey,
    status: dryRun ? "dry_run" : "idle",
    provider: runtimeConfig.providerSelection.providerId || profile.provider || null,
    runtimeConfig,
    contracts: {
      run: runContract,
      event: eventContract,
    },
    profile: {
      agentId: profile.agentId || null,
      name: profile.name || null,
      entryStageId: profile.entryStageId || null,
      sessionType: profile.sessionType || null,
    },
  });
  let activeRunContract = runContract;
  let aborted = false;
  let activeStageId = "";
  let activeStageTaskKey = "";
  let pendingApproval = null;
  let turnRunnerPromise = null;

  function syncQueues() {
    sessionState = replaceHarnessFollowups(sessionState, followupQueue.list());
    sessionState = replaceHarnessSteering(sessionState, steeringQueue.list());
  }

  syncQueues();

  function updateSession(patch = {}) {
    sessionState = updateHarnessSessionState(sessionState, patch);
    return sessionState;
  }

  function emitHarnessEvent(payload = {}) {
    const event = normalizeHarnessEvent(payload, {
      ...eventContract.defaults,
      runId: activeRunContract.runId || runId,
      parentRunId: activeRunContract.parentRunId || null,
      rootRunId: activeRunContract.rootRunId || activeRunContract.runId || runId,
      sessionId: activeRunContract.sessionId || sessionId,
      threadId: payload.threadId || sessionState?.activeTurn?.threadId || null,
      taskKey: activeRunContract.taskKey || taskKey,
      taskId: activeRunContract.taskId || taskId,
      taskTitle: activeRunContract.taskTitle || taskTitle,
      verb: activeRunContract.verb || null,
      actor: activeRunContract.actor || activeRunContract.metadata?.requestedBy || null,
      stageId: payload.stageId || activeStageId || null,
    });
    sessionState = appendHarnessSessionEvent(sessionState, event);
    emitEvent(options.onEvent, event);
    return event;
  }

  async function getTurnRunner() {
    if (!turnRunnerPromise) {
      turnRunnerPromise = createTurnRunner({
        toolOrchestrator: options.toolOrchestrator,
        providerRegistry: options.providerRegistry,
        adapters: options.adapters,
        configExecutors: options.configExecutors,
        getProviderRunner: options.getProviderRunner,
        runProviderTurn: options.runProviderTurn,
        sessionManager: options.sessionManager,
        onEvent: options.onEvent,
      });
    }
    return await turnRunnerPromise;
  }

  async function executeStageTurn(stage, mode, step) {
    const stageRuntime = resolveHarnessStageRuntime(stage, runtimeConfig);
    if (dryRun) {
      return buildDryRunResult(stage, mode);
    }
    if (typeof options.executeTurn === "function") {
      return await options.executeTurn({
        profile,
        runtimeConfig,
        runContract: activeRunContract,
        stage,
        stageRuntime,
        taskKey: stageRuntime.taskKey || toTrimmedString(stage.taskKey || taskKey),
        prompt: stage.prompt,
        mode,
        dryRun,
        timeoutMs: stageRuntime.timeoutMs || undefined,
        step,
        abortController: options.abortController || null,
        signal: options.abortController?.signal || null,
      });
    }
    const turnRunner = await getTurnRunner();
    return await turnRunner.runStageTurn({
      profile,
      stage,
      taskKey: stageRuntime.taskKey || toTrimmedString(stage.taskKey || taskKey),
      provider: stageRuntime.provider || stage.provider || profile.provider || null,
      executionMode: mode,
      timeoutMs: stageRuntime.timeoutMs || undefined,
      sessionType: stageRuntime.sessionType || toTrimmedString(stage.sessionType || profile.sessionType || options.sessionType || "harness") || "harness",
      cwd: stageRuntime.cwd || toTrimmedString(stage.cwd || profile.cwd || options.cwd || ""),
      model: stageRuntime.model || toTrimmedString(stage.model || profile.model || options.model || ""),
      toolPolicy: stageRuntime.toolPolicy || {},
      allowedTools: stageRuntime.toolPolicy?.allowedTools || [],
      deniedTools: stageRuntime.toolPolicy?.deniedTools || [],
      subagentContract: options.subagentContract || null,
    });
  }

  function canSteerActiveTurn() {
    if (dryRun || aborted) return false;
    if (!activeStageId || !activeStageTaskKey) return false;
    return typeof options.steerActiveTurn === "function";
  }

  function clearPendingApproval() {
    if (!pendingApproval) return;
    if (pendingApproval.timer) clearTimeout(pendingApproval.timer);
    pendingApproval = null;
  }

  function resolvePendingApproval(payload = {}) {
    if (!pendingApproval) return false;
    const current = pendingApproval;
    pendingApproval = null;
    if (current.timer) clearTimeout(current.timer);
    current.resolve({
      decision: normalizeApprovalDecision(payload?.decision, "approved"),
      actorId: toTrimmedString(payload?.actorId || payload?.actor || "operator") || "operator",
      note: toTrimmedString(payload?.note),
      requestId: toTrimmedString(payload?.requestId || current.requestId) || current.requestId,
      stageId: current.stageId,
      stageType: current.stageType,
      resolvedAt: new Date().toISOString(),
      prompt: toTrimmedString(payload?.prompt),
    });
    return true;
  }

  async function waitForStageApproval(stage, result, historyEntry) {
    const approvalConfig = stage?.approval && typeof stage.approval === "object" ? stage.approval : {};
    const timeoutMs = toPositiveInteger(
      approvalConfig.timeoutMs ?? stage?.approvalTimeoutMs ?? 0,
      0,
    );
    const approvalMode = toTrimmedString(approvalConfig.mode || "manual") || "manual";
    const requestRecord = approvalRepoRoot
      ? upsertHarnessRunApprovalRequest({
          runId,
          taskId: taskId || null,
          taskTitle: taskTitle || null,
          taskKey,
          stageId: stage.id,
          stageType: stage.type || null,
          agentId: profile.agentId || null,
          artifactId: toTrimmedString(options.artifactId) || null,
          sourceOrigin: toTrimmedString(options.sourceOrigin) || null,
          sourcePath: toTrimmedString(options.sourcePath) || null,
          requestedBy: toTrimmedString(approvalConfig.requestedBy || options.requestedBy || "harness") || "harness",
          reason: toTrimmedString(approvalConfig.reason || `Harness stage "${stage.id}" requires operator approval before continuation.`),
          preview: buildApprovalPreview(stage, result),
          timeoutMs: timeoutMs || undefined,
          mode: approvalMode,
          approvalNote: toTrimmedString(approvalConfig.note),
        }, { repoRoot: approvalRepoRoot })
      : {
          ok: true,
          request: {
            requestId: `harness-run:${runId}`,
            scopeType: "harness-run",
            scopeId: runId,
            runId,
            stageId: stage.id,
            stageType: stage.type || null,
            requestedBy: toTrimmedString(approvalConfig.requestedBy || options.requestedBy || "harness") || "harness",
            status: "pending",
          },
        };
    const request = requestRecord?.request || null;
    const requestedAt = new Date().toISOString();
    emitHarnessEvent({
      type: "harness:approval-requested",
      stageId: stage.id,
      stageType: stage.type || null,
      requestId: request?.requestId || `harness-run:${runId}`,
      requestedBy: request?.requestedBy || "harness",
      reason: request?.reason || null,
      preview: request?.preview || buildApprovalPreview(stage, result),
      status: "pending",
      timestamp: requestedAt,
    });
    historyEntry.approval = {
      requestId: request?.requestId || `harness-run:${runId}`,
      requestedAt,
      requestedBy: request?.requestedBy || "harness",
      status: "pending",
      stageId: stage.id,
      stageType: stage.type || null,
    };
    const approvalOutcome = await new Promise((resolve) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            if (approvalRepoRoot && request?.requestId) {
              try {
                expireApprovalRequest(request.requestId, {
                  repoRoot: approvalRepoRoot,
                  actorId: "system:timeout",
                  note: `Harness approval timed out after ${timeoutMs}ms.`,
                });
              } catch {
                // best effort
              }
            }
            resolvePendingApproval({
              decision: "expired",
              actorId: "system:timeout",
              note: `Harness approval timed out after ${timeoutMs}ms.`,
              requestId: request?.requestId,
            });
          }, timeoutMs)
        : null;
      pendingApproval = {
        requestId: request?.requestId || `harness-run:${runId}`,
        stageId: stage.id,
        stageType: stage.type || null,
        resolve,
        timer,
      };
    });
    if (options.emitApprovalResolutionEvent !== false) {
      emitHarnessEvent({
        type: "harness:approval-resolved",
        stageId: stage.id,
        stageType: stage.type || null,
        requestId: approvalOutcome.requestId || request?.requestId || `harness-run:${runId}`,
        decision: approvalOutcome.decision,
        actor: approvalOutcome.actorId || null,
        note: approvalOutcome.note || null,
        status: approvalOutcome.decision,
        timestamp: approvalOutcome.resolvedAt || new Date().toISOString(),
      });
    }
    historyEntry.approval = {
      ...(historyEntry.approval || {}),
      status: approvalOutcome.decision,
      decision: approvalOutcome.decision,
      actorId: approvalOutcome.actorId || null,
      note: approvalOutcome.note || null,
      resolvedAt: approvalOutcome.resolvedAt || new Date().toISOString(),
    };
    return approvalOutcome;
  }

  const session = {
    abort(reason = "aborted") {
      aborted = true;
      resolvePendingApproval({
        decision: "aborted",
        actorId: "system:abort",
        note: toTrimmedString(reason) || "Harness run aborted",
      });
      updateSession({
        status: "aborted",
        activeTurn: null,
      });
      emitHarnessEvent({
        type: "harness:aborted",
        reason,
        timestamp: new Date().toISOString(),
      });
    },
    canSteer() {
      return canSteerActiveTurn();
    },
    queueFollowup(message, meta = {}) {
      const entry = followupQueue.enqueue(message, meta);
      syncQueues();
      emitHarnessEvent({
        type: "harness:followup-queued",
        payload: {
          message: entry.message,
          meta: entry.meta,
        },
        timestamp: entry.queuedAt,
      });
      return entry;
    },
    listFollowups() {
      return followupQueue.list();
    },
    drainFollowups() {
      const drained = followupQueue.drain();
      syncQueues();
      return drained;
    },
    listPendingInterventions() {
      return steeringQueue.list();
    },
    getRunContract() {
      return cloneValue(activeRunContract);
    },
    getRuntimeConfig() {
      return cloneValue(runtimeConfig);
    },
    getState() {
      return cloneValue(sessionState);
    },
    steer(prompt, meta = {}) {
      const interventionType = toTrimmedString(meta?.kind || meta?.type || "nudge") || "nudge";
      steeringQueue.enqueue(prompt, meta);
      syncQueues();
      if (interventionType === "approval" && pendingApproval) {
        const pending = pendingApproval;
        const requestedStageId = toTrimmedString(meta?.requestedStageId || meta?.stageId);
        if (requestedStageId && requestedStageId !== pending.stageId) {
          steeringQueue.dequeue();
          syncQueues();
          return {
            ok: false,
            delivered: false,
            reason: "stage_mismatch",
            interventionType,
            stageId: pending.stageId,
            targetTaskKey: taskKey,
          };
        }
        const delivered = resolvePendingApproval({
          decision: meta?.decision || meta?.status || meta?.reason || "approved",
          actorId: meta?.actor || meta?.actorId || "operator",
          note: meta?.note || prompt,
          requestId: meta?.requestId || pending.requestId,
          prompt,
        });
        steeringQueue.dequeue();
        syncQueues();
        return {
          ok: delivered,
          delivered,
          reason: delivered ? "approval_recorded" : "not_waiting_for_approval",
          interventionType,
          stageId: pending.stageId,
          targetTaskKey: taskKey,
          requestId: pending.requestId,
          decision: normalizeApprovalDecision(meta?.decision || meta?.status || meta?.reason, "approved"),
        };
      }
      const instruction = toTrimmedString(prompt);
      const stageId = activeStageId || null;
      const targetTaskKey = activeStageTaskKey || taskKey;
      const timestamp = new Date().toISOString();
      if (!instruction) {
        steeringQueue.dequeue();
        syncQueues();
        emitHarnessEvent({
          type: "harness:intervention-rejected",
          stageId,
          targetTaskKey,
          interventionType,
          reason: "empty_prompt",
          timestamp,
          meta: meta && typeof meta === "object" ? { ...meta } : {},
        });
        return {
          ok: false,
          delivered: false,
          reason: "empty_prompt",
          interventionType,
          stageId,
          targetTaskKey,
        };
      }
      if (!canSteerActiveTurn()) {
        steeringQueue.dequeue();
        syncQueues();
        emitHarnessEvent({
          type: "harness:intervention-rejected",
          stageId,
          targetTaskKey,
          interventionType,
          reason: dryRun ? "dry_run" : "not_steerable",
          prompt: instruction,
          timestamp,
          meta: meta && typeof meta === "object" ? { ...meta } : {},
        });
        return {
          ok: false,
          delivered: false,
          reason: dryRun ? "dry_run" : "not_steerable",
          interventionType,
          stageId,
          targetTaskKey,
        };
      }
      emitHarnessEvent({
        type: "harness:intervention-requested",
        stageId,
        targetTaskKey,
        interventionType,
        prompt: instruction,
        timestamp,
        meta: meta && typeof meta === "object" ? { ...meta } : {},
      });
      const delivered = options.steerActiveTurn(targetTaskKey, instruction) === true;
      steeringQueue.dequeue();
      syncQueues();
      emitHarnessEvent({
        type: delivered ? "harness:intervention-delivered" : "harness:intervention-rejected",
        stageId,
        targetTaskKey,
        interventionType,
        reason: delivered ? "steered" : "not_steerable",
        prompt: instruction,
        timestamp: new Date().toISOString(),
        meta: meta && typeof meta === "object" ? { ...meta } : {},
      });
      return {
        ok: delivered,
        delivered,
        reason: delivered ? "steered" : "not_steerable",
        interventionType,
        stageId,
        targetTaskKey,
      };
    },
    async run(input = {}) {
      activeRunContract = createHarnessRunContract(input, {
        ...activeRunContract,
        verb: activeRunContract.verb || "initial",
        runId,
        sessionId,
        taskKey,
        taskId,
        taskTitle,
        surface: runtimeConfig.surface.surface,
        channel: runtimeConfig.surface.channel,
        actor: runtimeConfig.surface.requestedBy,
        metadata: {
          ...(activeRunContract.metadata || {}),
          surface: runtimeConfig.surface.surface,
          channel: runtimeConfig.surface.channel,
          requestedBy: runtimeConfig.surface.requestedBy,
        },
      });
      updateSession({
        contracts: {
          ...(sessionState.contracts || {}),
          run: activeRunContract,
          event: eventContract,
        },
      });
      if (activeRunContract.followupMessage) {
        session.queueFollowup(activeRunContract.followupMessage, {
          source: activeRunContract.surface || "harness",
          verb: activeRunContract.verb,
        });
      }
      if (activeRunContract.verb === "abort") {
        session.abort(activeRunContract.prompt || "aborted");
        return {
          success: false,
          status: "aborted",
          runId,
          dryRun,
          currentStageId: activeStageId || null,
          completedStageId: null,
          history: [],
        };
      }
      const history = [];
      const repairAttempts = new Map();
      const startedAt = Date.now();
      let currentStageId = toTrimmedString(activeRunContract.requestedStageId || profile.entryStageId);
      let steps = 0;
      let lastCompletedStageId = "";

      updateSession({
        status: dryRun ? "dry_run" : "running",
      });
      emitHarnessEvent({
        type: "harness:session-start",
        verb: activeRunContract.verb,
        dryRun,
        entryStageId: currentStageId,
        timestamp: new Date(startedAt).toISOString(),
      });

      while (currentStageId && steps < maxSteps) {
        if (aborted) {
          activeStageId = "";
          activeStageTaskKey = "";
          sessionState = setHarnessActiveTurn(sessionState, null);
          return {
            success: false,
            status: "aborted",
            runId,
            dryRun,
            currentStageId,
            completedStageId: lastCompletedStageId || null,
            history,
          };
        }
        const stage = stageMap.get(currentStageId);
        if (!stage) {
          activeStageId = "";
          activeStageTaskKey = "";
          sessionState = setHarnessActiveTurn(sessionState, null);
          return {
            success: false,
            status: "invalid_stage",
            runId,
            dryRun,
            currentStageId,
            completedStageId: lastCompletedStageId || null,
            history,
            error: `Unknown stage "${currentStageId}"`,
          };
        }

        steps += 1;
        const stageStartedAt = Date.now();
        const stageRepairAttempt = Number(repairAttempts.get(stage.id) || 0);
        const mode = history.length === 0
          ? normalizeHarnessRunVerb(activeRunContract.verb, "initial")
          : "continue";
        activeStageId = stage.id;
        activeStageTaskKey = toTrimmedString(stage.taskKey || taskKey);
        sessionState = setHarnessActiveTurn(sessionState, {
          stageId: stage.id,
          taskKey: activeStageTaskKey,
          step: steps,
          mode,
          startedAt: new Date(stageStartedAt).toISOString(),
        });
        emitHarnessEvent({
          type: "harness:stage-start",
          stageId: stage.id,
          stageType: stage.type,
          mode,
          step: steps,
          maxSteps,
          dryRun,
          repairAttempt: stageRepairAttempt,
          timestamp: new Date(stageStartedAt).toISOString(),
        });

        let rawResult;
        try {
          rawResult = await executeStageTurn(stage, mode, steps);
        } catch (error) {
          const wasAborted =
            aborted === true ||
            options.abortController?.signal?.aborted === true ||
            error?.name === "AbortError" ||
            /abort|cancel|stop/i.test(String(error?.message || ""));
          if (wasAborted) {
            activeStageId = "";
            activeStageTaskKey = "";
            sessionState = setHarnessActiveTurn(sessionState, null);
            updateSession({ status: "aborted" });
            return {
              success: false,
              status: "aborted",
              runId,
              dryRun,
              currentStageId: stage.id,
              completedStageId: lastCompletedStageId || null,
              history,
              error: String(error?.message || "Harness run aborted"),
            };
          }
          throw error;
        }

        if (aborted || options.abortController?.signal?.aborted === true) {
          activeStageId = "";
          activeStageTaskKey = "";
          sessionState = setHarnessActiveTurn(sessionState, null);
          updateSession({ status: "aborted" });
          return {
            success: false,
            status: "aborted",
            runId,
            dryRun,
            currentStageId: stage.id,
            completedStageId: lastCompletedStageId || null,
            history,
          };
        }

        const result = normalizeExecutionResult(rawResult, mode);
        const endedAt = Date.now();
        const historyEntry = {
          index: history.length,
          step: steps,
          stageId: stage.id,
          stageType: stage.type,
          mode,
          dryRun,
          repairAttempt: stageRepairAttempt,
          startedAt: new Date(stageStartedAt).toISOString(),
          endedAt: new Date(endedAt).toISOString(),
          durationMs: Math.max(0, endedAt - stageStartedAt),
          ok: result.success,
          outcome: result.outcome,
          status: result.status,
          result,
          nextStageId: null,
          transitionReason: null,
        };
        history.push(historyEntry);
        sessionState = appendHarnessHistory(sessionState, historyEntry);
        emitHarnessEvent({
          type: "harness:stage-result",
          stageId: stage.id,
          ok: result.success,
          outcome: result.outcome,
          status: result.status,
          dryRun,
          timestamp: new Date(endedAt).toISOString(),
          result,
        });

        if (result.success && !dryRun && stageRequiresOperatorApproval(stage)) {
          updateSession({ status: "waiting_approval" });
          const approvalOutcome = await waitForStageApproval(stage, result, historyEntry);
          if (approvalOutcome.decision !== "approved") {
            const deniedTransition = resolveStageTransition(stage, [
              approvalOutcome.decision === "expired" ? "approval-expired" : "approval-denied",
              approvalOutcome.decision,
              "failure",
              "error",
            ]);
            if (deniedTransition?.to) {
              historyEntry.nextStageId = deniedTransition.to;
              historyEntry.transitionReason = approvalOutcome.decision === "expired" ? "approval-expired" : "approval-denied";
              emitHarnessEvent({
                type: "harness:stage-transition",
                stageId: stage.id,
                toStageId: deniedTransition.to,
                reason: historyEntry.transitionReason,
                dryRun,
                timestamp: new Date().toISOString(),
              });
              lastCompletedStageId = stage.id;
              currentStageId = deniedTransition.to;
              updateSession({ status: "running" });
              continue;
            }
            const blockedAt = Date.now();
            const blocked = {
              success: false,
              status: approvalOutcome.decision === "expired" ? "approval_expired" : "approval_denied",
              runId,
              dryRun,
              currentStageId: stage.id,
              completedStageId: lastCompletedStageId || null,
              history,
              error: approvalOutcome.decision === "expired"
                ? `Harness approval for stage "${stage.id}" expired`
                : `Harness approval for stage "${stage.id}" was denied`,
              durationMs: Math.max(0, blockedAt - startedAt),
            };
            emitHarnessEvent({
              type: "harness:failed",
              stageId: stage.id,
              dryRun,
              timestamp: new Date(blockedAt).toISOString(),
              result: blocked,
            });
            activeStageId = "";
            activeStageTaskKey = "";
            sessionState = setHarnessActiveTurn(sessionState, null);
            updateSession({
              status: blocked.status,
              activeTurn: null,
              lastError: blocked.error,
            });
            clearPendingApproval();
            return blocked;
          }
          updateSession({ status: "running" });
        }

        const directTransition = resolveStageTransition(stage, [result.outcome]);
        if (directTransition?.to) {
          historyEntry.nextStageId = directTransition.to;
          historyEntry.transitionReason = result.outcome;
          emitHarnessEvent({
            type: "harness:stage-transition",
            stageId: stage.id,
            toStageId: directTransition.to,
            reason: result.outcome,
            dryRun,
            timestamp: new Date().toISOString(),
          });
          lastCompletedStageId = stage.id;
          currentStageId = directTransition.to;
          continue;
        }

        if (result.success) {
          const nextStage = resolveStageTransition(stage, ["success", "next"]);
          if (!nextStage?.to) {
            const completedAt = Date.now();
            const completed = {
              success: true,
              status: "completed",
              runId,
              dryRun,
              currentStageId: stage.id,
              completedStageId: stage.id,
              history,
              durationMs: Math.max(0, completedAt - startedAt),
            };
            emitHarnessEvent({
              type: "harness:completed",
              dryRun,
              stageId: stage.id,
              timestamp: new Date(completedAt).toISOString(),
              result: completed,
            });
            activeStageId = "";
            activeStageTaskKey = "";
            sessionState = setHarnessActiveTurn(sessionState, null);
            updateSession({
              status: "completed",
              activeTurn: null,
            });
            return completed;
          }
          historyEntry.nextStageId = nextStage.to;
          historyEntry.transitionReason = nextStage.on || "success";
          emitHarnessEvent({
            type: "harness:stage-transition",
            stageId: stage.id,
            toStageId: nextStage.to,
            reason: nextStage.on || "success",
            dryRun,
            timestamp: new Date().toISOString(),
          });
          lastCompletedStageId = stage.id;
          currentStageId = nextStage.to;
          continue;
        }

        const repairLoop = stage.repairLoop && typeof stage.repairLoop === "object"
          ? stage.repairLoop
          : null;
        if (repairLoop?.targetStageId) {
          const nextAttempts = Number(repairAttempts.get(stage.id) || 0) + 1;
          if (nextAttempts <= Number(repairLoop.maxAttempts || 0)) {
            repairAttempts.set(stage.id, nextAttempts);
            const backoffMs = toPositiveInteger(repairLoop.backoffMs, 0);
            if (backoffMs > 0) {
              emitHarnessEvent({
                type: "harness:stage-backoff",
                stageId: stage.id,
                backoffMs,
                attempt: nextAttempts,
                dryRun,
                timestamp: new Date().toISOString(),
              });
              if (!dryRun) {
                await sleep(backoffMs);
              }
            }
            historyEntry.nextStageId = repairLoop.targetStageId;
            historyEntry.transitionReason = "repair";
            emitHarnessEvent({
              type: "harness:stage-transition",
              stageId: stage.id,
              toStageId: repairLoop.targetStageId,
              reason: "repair",
              attempt: nextAttempts,
              dryRun,
              timestamp: new Date().toISOString(),
            });
            lastCompletedStageId = stage.id;
            currentStageId = repairLoop.targetStageId;
            continue;
          }
        }

        const exhaustedTransition = resolveStageTransition(stage, ["repair-exhausted", "failure", "error"]);
        if (exhaustedTransition?.to) {
          historyEntry.nextStageId = exhaustedTransition.to;
          historyEntry.transitionReason = exhaustedTransition.on || "repair-exhausted";
          emitHarnessEvent({
            type: "harness:stage-transition",
            stageId: stage.id,
            toStageId: exhaustedTransition.to,
            reason: exhaustedTransition.on || "repair-exhausted",
            dryRun,
            timestamp: new Date().toISOString(),
          });
          lastCompletedStageId = stage.id;
          currentStageId = exhaustedTransition.to;
          continue;
        }

        const failedAt = Date.now();
        const failed = {
          success: false,
          status: "failed",
          runId,
          dryRun,
          currentStageId: stage.id,
          completedStageId: lastCompletedStageId || null,
          history,
          error: result.error || `Harness stage "${stage.id}" failed`,
          durationMs: Math.max(0, failedAt - startedAt),
        };
        emitHarnessEvent({
          type: "harness:stage-failed",
          stageId: stage.id,
          outcome: result.outcome,
          status: result.status,
          dryRun,
          timestamp: new Date(failedAt).toISOString(),
          result: failed,
        });
        emitHarnessEvent({
          type: "harness:failed",
          stageId: stage.id,
          dryRun,
          timestamp: new Date(failedAt).toISOString(),
          result: failed,
        });
        activeStageId = "";
        activeStageTaskKey = "";
        sessionState = setHarnessActiveTurn(sessionState, null);
        updateSession({
          status: "failed",
          activeTurn: null,
          lastError: failed.error,
        });
        clearPendingApproval();
        return failed;
      }

      const exhaustedAt = Date.now();
      const exhausted = {
        success: false,
        status: "loop_limit_exceeded",
        runId,
        dryRun,
        currentStageId,
        completedStageId: lastCompletedStageId || null,
        history,
        error: `Harness exceeded step budget (${maxSteps})`,
        durationMs: Math.max(0, exhaustedAt - startedAt),
      };
      emitHarnessEvent({
        type: "harness:failed",
        stageId: currentStageId,
        dryRun,
        timestamp: new Date(exhaustedAt).toISOString(),
        result: exhausted,
      });
      activeStageId = "";
      activeStageTaskKey = "";
      sessionState = setHarnessActiveTurn(sessionState, null);
      updateSession({
        status: "loop_limit_exceeded",
        activeTurn: null,
        lastError: exhausted.error,
      });
      clearPendingApproval();
      return exhausted;
    },
  };
  return {
    runtimeConfig,
    runContract,
    eventContract,
    session,
  };
}

export function createInternalHarnessSession(compiledProfile, options = {}) {
  return createInternalHarnessRuntime(compiledProfile, options).session;
}

export default createInternalHarnessSession;
