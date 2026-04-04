/**
 * issue-continuation.mjs — Issue-State Continuation Loop Template
 *
 * Workflow-owned continuation loop:
 * - Polls external task state each turn
 * - Continues agent execution while not terminal
 * - Detects stuck sessions from unchanged commit/file progress
 * - Emits session-stuck event and routes by configured onStuck action
 */

import { edge, node, resetLayout } from "./_helpers.mjs";

resetLayout();

export const CONTINUATION_LOOP_TEMPLATE = {
  id: "template-continuation-loop",
  name: "Continuation Loop",
  description:
    "Issue-state continuation loop. Polls externalStatus, keeps driving the " +
    "agent until terminal state or max turns, and handles stuck sessions " +
    "with retry/escalate/pause.",
  category: "reliability",
  enabled: true,
  recommended: false,
  trigger: "trigger.task_available",
  variables: {
    taskId: "",
    worktreePath: "",
    maxTurns: 8,
    pollIntervalMs: 30000,
    terminalStates: ["done", "cancelled"],
    stuckThresholdMs: 300000,
    maxStuckAutoRetries: 1,
    onStuck: "escalate", // retry | escalate | pause
    continuePrompt:
      "Continue this task from the current state. Focus on the next missing step and push toward completion.",
    retryPrompt:
      "No progress was detected recently. Try a different approach and make concrete progress (commit or file updates).",
    sdk: "auto",
    model: "",
    timeoutMs: 1800000,
  },
  nodes: [
    node("trigger", "trigger.task_available", "Task Available", {
      maxParallel: 1,
      pollIntervalMs: "{{pollIntervalMs}}",
      status: "inprogress",
    }, { x: 420, y: 60 }),

    node("init-turn", "action.set_variable", "Initialize Turn Counter", {
      key: "continuationTurn",
      value: "0",
      isExpression: true,
    }, { x: 420, y: 170 }),

    node("init-progress-at", "action.set_variable", "Initialize Progress Clock", {
      key: "lastProgressAt",
      value: "Date.now()",
      isExpression: true,
    }, { x: 420, y: 280 }),

    node("init-signature", "action.set_variable", "Initialize Progress Signature", {
      key: "lastProgressSignature",
      value: "''",
      isExpression: true,
    }, { x: 420, y: 390 }),

    node("init-stuck-retry-count", "action.set_variable", "Initialize Stuck Retry Count", {
      key: "stuckRetryCount",
      value: "0",
      isExpression: true,
    }, { x: 420, y: 450 }),

    node("poll-task", "action.bosun_function", "Poll External Task State", {
      function: "tasks.get",
      args: {
        taskId: "{{taskId}}",
      },
      outputVariable: "continuationTask",
    }, { x: 420, y: 500 }),

    node("derive-status", "action.set_variable", "Derive External Status", {
      key: "currentExternalStatus",
      value:
        "String(($data?.continuationTask?.externalStatus ?? $data?.continuationTask?.status ?? '') || '').trim().toLowerCase()",
      isExpression: true,
    }, { x: 420, y: 610 }),

    node("terminal-check", "condition.expression", "Terminal State Reached?", {
      expression:
        "(() => { const s = String($data?.currentExternalStatus || '').trim().toLowerCase(); const t = Array.isArray($data?.terminalStates) ? $data.terminalStates.map(v => String(v || '').trim().toLowerCase()).filter(Boolean) : []; return Boolean(s) && t.includes(s); })()",
    }, { x: 420, y: 720, outputs: ["yes", "no"] }),

    node("end-terminal", "flow.end", "End: Terminal State", {
      status: "completed",
      message: "Continuation loop completed: terminal external state '{{currentExternalStatus}}' reached for task {{taskId}}.",
      output: {
        reason: "terminal_state",
        taskId: "{{taskId}}",
        externalStatus: "{{currentExternalStatus}}",
      },
    }, { x: 160, y: 860 }),

    node("max-turns-check", "condition.expression", "Max Turns Reached?", {
      expression: "Number($data?.continuationTurn || 0) >= Number($data?.maxTurns || 0)",
    }, { x: 620, y: 860, outputs: ["yes", "no"] }),

    node("end-max-turns", "flow.end", "End: Max Turns", {
      status: "failed",
      message: "Continuation loop stopped after reaching maxTurns={{maxTurns}} for task {{taskId}}.",
      output: {
        reason: "max_turns",
        taskId: "{{taskId}}",
        turns: "{{continuationTurn}}",
      },
    }, { x: 460, y: 1000 }),

    node("run-agent", "action.run_agent", "Drive Agent", {
      prompt: "{{continuePrompt}}",
      taskId: "{{taskId}}",
      cwd: "{{worktreePath}}",
      sdk: "{{sdk}}",
      model: "{{model}}",
      timeoutMs: "{{timeoutMs}}",
      failOnError: false,
    }, { x: 800, y: 1000 }),

    node("capture-progress", "action.run_command", "Capture Progress Signature", {
      command:
        "node -e \"const cp=require('node:child_process');const crypto=require('node:crypto');const head=(cp.execSync('git rev-parse HEAD',{encoding:'utf8'}).trim()||'');const dirtyRaw=cp.execSync('git status --porcelain=v1',{encoding:'utf8'});const dirtyCount=dirtyRaw.split(/\\r?\\n/).filter(Boolean).length;const statusDigest=crypto.createHash('sha1').update(dirtyRaw).digest('hex').slice(0,16);process.stdout.write(JSON.stringify({head,dirtyCount,statusDigest}));\"",
      cwd: "{{worktreePath}}",
      failOnError: false,
    }, { x: 800, y: 1120 }),

    node("derive-signature", "action.set_variable", "Derive Signature", {
      key: "currentProgressSignature",
      value:
        "(() => { const raw = String($ctx.getNodeOutput('capture-progress')?.output || '').trim(); try { const parsed = JSON.parse(raw); const head = String(parsed?.head || ''); const dirty = Number(parsed?.dirtyCount || 0); const statusDigest = String(parsed?.statusDigest || ''); return `${head}:${dirty}:${statusDigest}`; } catch { return ''; } })()",
      isExpression: true,
    }, { x: 800, y: 1240 }),

    node("progress-changed", "condition.expression", "Progress Changed?", {
      expression: "String($data?.currentProgressSignature || '') !== String($data?.lastProgressSignature || '')",
    }, { x: 800, y: 1360, outputs: ["yes", "no"] }),

    node("mark-progress-at", "action.set_variable", "Update Progress Clock", {
      key: "lastProgressAt",
      value:
        "(() => { const changed = String($data?.currentProgressSignature || '') !== String($data?.lastProgressSignature || ''); return changed ? Date.now() : Number($data?.lastProgressAt || 0); })()",
      isExpression: true,
    }, { x: 680, y: 1490 }),

    node("mark-progress-sig", "action.set_variable", "Update Progress Signature", {
      key: "lastProgressSignature",
      value: "$data?.currentProgressSignature || ''",
      isExpression: true,
    }, { x: 680, y: 1600 }),

    node("reset-stuck-retry-count", "action.set_variable", "Reset Stuck Retry Count On Progress", {
      key: "stuckRetryCount",
      value:
        "(() => { const changed = String($data?.currentProgressSignature || '') !== String($data?.lastProgressSignature || ''); return changed ? 0 : Number($data?.stuckRetryCount || 0); })()",
      isExpression: true,
    }, { x: 680, y: 1710 }),

    node("stuck-check", "condition.expression", "Session Stuck?", {
      expression:
        "(Date.now() - Number($data?.lastProgressAt || 0)) >= Number($data?.stuckThresholdMs || 0)",
    }, { x: 980, y: 1820, outputs: ["yes", "no"] }),

    node("emit-stuck", "action.emit_event", "Emit session-stuck", {
      eventType: "session-stuck",
      payload: {
        taskId: "{{taskId}}",
        turn: "{{continuationTurn}}",
        externalStatus: "{{currentExternalStatus}}",
        stuckThresholdMs: "{{stuckThresholdMs}}",
        stuckForMs: "{{Math.max(0, Date.now() - Number($data?.lastProgressAt || 0))}}",
        onStuck: "{{onStuck}}",
        stuckRetryCount: "{{stuckRetryCount}}",
        maxStuckAutoRetries: "{{maxStuckAutoRetries}}",
        lastProgressAt: "{{lastProgressAt}}",
        lastProgressSignature: "{{lastProgressSignature}}",
        currentProgressSignature: "{{currentProgressSignature}}",
        progressSnapshot: "{{$ctx.getNodeOutput('capture-progress')?.output || ''}}",
        lastAgentSuccess: "{{$ctx.getNodeOutput('run-agent')?.success === true}}",
        lastAgentOutput: "{{$ctx.getNodeOutput('run-agent')?.output || ''}}",
      },
      outputVariable: "sessionStuckEvent",
    }, { x: 980, y: 1600 }),

    node("stuck-route", "condition.switch", "Route onStuck Action", {
      value: "$data?.onStuck || 'escalate'",
      cases: {
        retry: "retry",
        escalate: "escalate",
        pause: "pause",
      },
    }, { x: 980, y: 1710, outputs: ["retry", "escalate", "pause", "default"] }),

    node("stuck-retry-budget", "condition.expression", "Stuck Retry Budget Remaining?", {
      expression: "Number($data?.stuckRetryCount || 0) < Number($data?.maxStuckAutoRetries || 0)",
    }, { x: 760, y: 1820, outputs: ["yes", "no"] }),

    node("stuck-retry", "action.run_agent", "Retry After Stuck", {
      prompt:
        "{{retryPrompt}}\n\n" +
        "Stuck context:\n" +
        "- taskId: {{taskId}}\n" +
        "- externalStatus: {{currentExternalStatus}}\n" +
        "- turn: {{continuationTurn}}\n" +
        "- stuckRetryCount: {{stuckRetryCount}}/{{maxStuckAutoRetries}}\n" +
        "- stuckForMs: {{Math.max(0, Date.now() - Number($data?.lastProgressAt || 0))}}\n" +
        "- lastProgressSignature: {{lastProgressSignature}}\n" +
        "- currentProgressSignature: {{currentProgressSignature}}\n" +
        "- progressSnapshot: {{$ctx.getNodeOutput('capture-progress')?.output || ''}}\n" +
        "- lastAgentOutput: {{$ctx.getNodeOutput('run-agent')?.output || ''}}\n\n" +
        "Try a materially different approach. If you cannot create progress, explain the specific blocker.",
      taskId: "{{taskId}}",
      cwd: "{{worktreePath}}",
      sdk: "{{sdk}}",
      model: "{{model}}",
      timeoutMs: "{{timeoutMs}}",
      failOnError: false,
    }, { x: 760, y: 1830 }),

    node("increment-stuck-retry-count", "action.set_variable", "Increment Stuck Retry Count", {
      key: "stuckRetryCount",
      value: "Number($data?.stuckRetryCount || 0) + 1",
      isExpression: true,
    }, { x: 760, y: 1940 }),

    node("stuck-escalate", "notify.log", "Escalate Stuck Session", {
      level: "warn",
      message:
        "session-stuck: escalation requested for task {{taskId}} at turn {{continuationTurn}} (externalStatus={{currentExternalStatus}}, stuckForMs={{Math.max(0, Date.now() - Number($data?.lastProgressAt || 0))}}, stuckRetryCount={{stuckRetryCount}}/{{maxStuckAutoRetries}}, lastProgressSignature={{lastProgressSignature}}, currentProgressSignature={{currentProgressSignature}})",
    }, { x: 980, y: 1830 }),

    node("stuck-escalate-budget", "notify.log", "Escalate Stuck Session (Retry Limit)", {
      level: "warn",
      message:
        "session-stuck: retry budget exhausted for task {{taskId}} at turn {{continuationTurn}} (externalStatus={{currentExternalStatus}}, stuckForMs={{Math.max(0, Date.now() - Number($data?.lastProgressAt || 0))}}, stuckRetryCount={{stuckRetryCount}}/{{maxStuckAutoRetries}}, lastProgressSignature={{lastProgressSignature}}, currentProgressSignature={{currentProgressSignature}})",
    }, { x: 760, y: 2050 }),

    node("stuck-pause", "notify.log", "Pause Stuck Session", {
      level: "warn",
      message:
        "session-stuck: paused task {{taskId}} at turn {{continuationTurn}} (externalStatus={{currentExternalStatus}})",
    }, { x: 1200, y: 1830 }),

    node("end-escalated", "flow.end", "End: Escalated", {
      status: "failed",
      message: "Continuation loop escalated due to session-stuck for task {{taskId}}.",
      output: {
        reason: "stuck_escalated",
        taskId: "{{taskId}}",
        event: "{{sessionStuckEvent.eventType}}",
        stuckRetryCount: "{{stuckRetryCount}}",
        maxStuckAutoRetries: "{{maxStuckAutoRetries}}",
      },
    }, { x: 980, y: 1950 }),

    node("end-escalated-budget", "flow.end", "End: Escalated (Retry Limit)", {
      status: "failed",
      message: "Continuation loop escalated after exhausting stuck retry budget for task {{taskId}}.",
      output: {
        reason: "stuck_escalated_retry_budget",
        taskId: "{{taskId}}",
        event: "{{sessionStuckEvent.eventType}}",
        stuckRetryCount: "{{stuckRetryCount}}",
        maxStuckAutoRetries: "{{maxStuckAutoRetries}}",
      },
    }, { x: 760, y: 2160 }),

    node("end-paused", "flow.end", "End: Paused", {
      status: "completed",
      message: "Continuation loop paused due to session-stuck for task {{taskId}}.",
      output: {
        reason: "stuck_paused",
        taskId: "{{taskId}}",
        event: "{{sessionStuckEvent.eventType}}",
      },
    }, { x: 1200, y: 1950 }),

    node("wait-next-turn", "action.delay", "Wait Poll Interval", {
      ms: "{{pollIntervalMs}}",
      reason: "Waiting before next external status poll",
    }, { x: 760, y: 1950 }),

    node("increment-turn", "action.set_variable", "Increment Turn", {
      key: "continuationTurn",
      value: "Number($data?.continuationTurn || 0) + 1",
      isExpression: true,
    }, { x: 760, y: 2060 }),

    node("wait-next-turn-no-stuck", "action.delay", "Wait (No Stuck)", {
      ms: "{{pollIntervalMs}}",
      reason: "Waiting before next external status poll",
    }, { x: 1080, y: 1950 }),

    node("increment-turn-no-stuck", "action.set_variable", "Increment Turn (No Stuck)", {
      key: "continuationTurn",
      value: "Number($data?.continuationTurn || 0) + 1",
      isExpression: true,
    }, { x: 1080, y: 2060 }),
  ],
  edges: [
    edge("trigger", "init-turn"),
    edge("init-turn", "init-progress-at"),
    edge("init-progress-at", "init-signature"),
    edge("init-signature", "init-stuck-retry-count"),
    edge("init-stuck-retry-count", "poll-task"),
    edge("poll-task", "derive-status"),
    edge("derive-status", "terminal-check"),
    edge("terminal-check", "end-terminal", { condition: "$output?.result === true", port: "yes" }),
    edge("terminal-check", "max-turns-check", { condition: "$output?.result !== true", port: "no" }),
    edge("max-turns-check", "end-max-turns", { condition: "$output?.result === true", port: "yes" }),
    edge("max-turns-check", "run-agent", { condition: "$output?.result !== true", port: "no" }),
    edge("run-agent", "capture-progress"),
    edge("capture-progress", "derive-signature"),
    edge("derive-signature", "progress-changed"),
    edge("progress-changed", "mark-progress-at"),
    edge("mark-progress-at", "mark-progress-sig"),
    edge("mark-progress-sig", "reset-stuck-retry-count"),
    edge("reset-stuck-retry-count", "stuck-check"),
    edge("stuck-check", "emit-stuck", { condition: "$output?.result === true", port: "yes" }),
    edge("stuck-check", "wait-next-turn-no-stuck", { condition: "$output?.result !== true", port: "no" }),
    edge("emit-stuck", "stuck-route"),
    edge("stuck-route", "stuck-retry-budget", { port: "retry" }),
    edge("stuck-route", "stuck-escalate", { port: "escalate" }),
    edge("stuck-route", "stuck-pause", { port: "pause" }),
    edge("stuck-route", "stuck-escalate", { port: "default" }),
    edge("stuck-retry-budget", "stuck-retry", { condition: "$output?.result === true", port: "yes" }),
    edge("stuck-retry-budget", "stuck-escalate-budget", { condition: "$output?.result !== true", port: "no" }),
    edge("stuck-retry", "increment-stuck-retry-count"),
    edge("increment-stuck-retry-count", "wait-next-turn"),
    edge("stuck-escalate", "end-escalated", { port: "default" }),
    edge("stuck-escalate-budget", "end-escalated-budget", { port: "default" }),
    edge("stuck-pause", "end-paused", { port: "default" }),
    edge("wait-next-turn", "increment-turn"),
    edge("wait-next-turn-no-stuck", "increment-turn-no-stuck"),
    edge("increment-turn", "poll-task", { backEdge: true, maxIterations: 500 }),
    edge("increment-turn-no-stuck", "poll-task", { backEdge: true, maxIterations: 500 }),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2026-03-10T00:00:00Z",
    templateVersion: "1.1.0",
    tags: ["continuation", "loop", "linear", "external-status", "stuck-detection"],
    configType: "continuation-loop",
  },
};

export default CONTINUATION_LOOP_TEMPLATE;
