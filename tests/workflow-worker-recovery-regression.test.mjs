import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertCloneSafeWorkerMessage,
  buildCloneSafeWorkerMessage,
} from "../server/workflow-engine-worker.mjs";

class MockTrackerCarrier {
  constructor(nodeId) {
    this.nodeId = nodeId;
    this.latestSession = new Map([
      ["session", { id: `${nodeId}-session`, startedAt: Date.now() }],
    ]);
  }

  attach() {
    return this.nodeId;
  }
}

function walkValue(value, visitor, seen = new WeakSet()) {
  if (value === null || value === undefined) return;
  const valueType = typeof value;
  visitor(value);
  if (valueType !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) walkValue(entry, visitor, seen);
    return;
  }
  for (const entry of Object.values(value)) {
    walkValue(entry, visitor, seen);
  }
}

function createAgentBridgePayload(nodeId) {
  const tracker = new MockTrackerCarrier(nodeId);
  const ledgerRef = { nodeId, phase: "dispatch" };
  ledgerRef.self = ledgerRef;
  return {
    type: "svc-call",
    callId: `call-${nodeId}`,
    method: "harnessAgent.execWithRetry",
    args: [
      `Execute ${nodeId}`,
      {
        taskKey: `TASK-LIFECYCLE:${nodeId}`,
        sessionType: "task",
        systemPrompt: `System prompt for ${nodeId}`,
        onEvent: () => nodeId,
        tracker,
        slotMeta: {
          taskKey: `TASK-LIFECYCLE:${nodeId}`,
          onStatus: () => "running",
        },
        topology: {
          nodeId,
          latestSession: tracker,
          render: () => "not-cloneable",
        },
        ledgerRef,
        nestedCallbacks: [
          { phase: "plan", callback: () => "drop-me" },
        ],
      },
    ],
  };
}

describe("workflow worker recovery regressions", () => {
  const uiServerSource = readFileSync(resolve(process.cwd(), "server/ui-server.mjs"), "utf8");
  const harnessBridgeSource = readFileSync(resolve(process.cwd(), "server/routes/harness-agent-bridge.mjs"), "utf8");
  const workerSource = readFileSync(resolve(process.cwd(), "server/workflow-engine-worker.mjs"), "utf8");

  it("keeps UI-owned worker-backed engines from owning interrupted-run recovery", () => {
    expect(uiServerSource).toContain("detectInterruptedRuns: false");
    expect(uiServerSource).toContain("resumeInterruptedRunsOnStart: false");
    expect(workerSource).toContain("if (cfg.detectInterruptedRuns === false)");
    expect(workerSource).toContain("const shouldResumeInterruptedRunsOnStart = cfg.resumeInterruptedRunsOnStart !== false;");
    expect(workerSource).toContain("if (shouldResumeInterruptedRunsOnStart && typeof engine.resumeInterruptedRuns === \"function\")");
    expect(workerSource).toContain("setTimeout(() => engine.resumeInterruptedRuns().catch(() => {}), 0);");
    expect(uiServerSource).not.toContain('proxy.resumeInterruptedRuns().catch((err) => {');
    expect(uiServerSource).not.toContain('engine.resumeInterruptedRuns().catch((err) => {');
  });

  it("gives workflow workers a longer default startup window before falling back in-process", () => {
    expect(uiServerSource).toContain("BOSUN_WORKFLOW_WORKER_START_TIMEOUT_MS");
    expect(uiServerSource).toContain("|| 15000");
  });

  it("deduplicates expensive status payload assembly behind a longer cache window", () => {
    expect(uiServerSource).toContain('getOrComputeCachedApiResponse("status", 15000');
    expect(uiServerSource).toContain("const monitor = buildCurrentTuiMonitorStats();");
    expect(uiServerSource).toContain("const durableRuntime = buildDurableRuntimeSurface(monitor);");
  });

  it("returns retry payloads with retryRunId for worker-backed workflow actions", () => {
    expect(workerSource).toContain('case "retryRun": {');
    expect(workerSource).toContain("retryRunId: retryResult?.retryRunId || retryResult?.ctx?.id || null");
    expect(workerSource).toContain("originalRunId: retryResult?.originalRunId || null");
    expect(workerSource).toContain("mode: retryResult?.mode || null");
  });

  it("drops dead workflow worker proxies so the UI can recreate them", () => {
    expect(uiServerSource).toContain("_handleWorkerUnavailable(err)");
    expect(uiServerSource).toContain("this._pending.clear();");
    expect(uiServerSource).toContain("isAvailable()");
    expect(uiServerSource).toContain("!engine.isAvailable()");
    expect(uiServerSource).toContain("_wfEngineByWorkspace.delete(workspaceKey);");
  });

  it("forwards agent pool bridge calls with the current prompt-plus-options signatures", () => {
    expect(workerSource).toContain('async launchOrResumeThread(prompt, cwd, timeout, opts) {');
    expect(workerSource).toContain("function sanitizeWorkerMessage(message) {");
    expect(workerSource).toContain("function assertCloneSafeWorkerMessage(message, label = \"workflow worker message\") {");
    expect(workerSource).toContain("function postCloneSafeWorkerMessage(message, label = \"workflow worker message\") {");
    expect(workerSource).toContain('return callMainService("harnessAgent.launchOrResumeThread", [prompt, cwd, timeout, opts]);');
    expect(workerSource).toContain('async execWithRetry(prompt, opts) {');
    expect(workerSource).toContain('return callMainService("harnessAgent.execWithRetry", [prompt, opts]);');
    expect(workerSource).toContain('workflow worker svc-call ${method}');
    expect(uiServerSource).toContain('from "./routes/harness-agent-bridge.mjs"');
    expect(uiServerSource).toContain("const handledCall = await executeHarnessBridgeServiceCall(method, args, {");
    expect(harnessBridgeSource).toContain("function normalizeHarnessAgentBridgeArgs(fn, args = [])");
    expect(harnessBridgeSource).toContain("options.slotMeta?.taskKey ||");
    expect(harnessBridgeSource).toContain("options.targetTaskKey ||");
    expect(harnessBridgeSource).toContain("const normalizedArgs = normalizeHarnessAgentBridgeArgs(fn, args);");
    expect(harnessBridgeSource).toContain('result: await harnessAgentService.execWithRetry(normalizedArgs[0], normalizedArgs[1] || {}),');
  });

  it("keeps web-surface prompt execution on the canonical harness facade", () => {
    expect(uiServerSource).toContain("const harnessAgentService = createHarnessAgentService();");
    expect(uiServerSource).toContain("resolveBackgroundPromptExecutor({ uiDeps, harnessAgentService })");
    expect(harnessBridgeSource).toContain(": harnessAgentService.runInteractivePrompt.bind(harnessAgentService);");
    expect(harnessBridgeSource).toContain("return harnessAgentService.runBackgroundPrompt.bind(harnessAgentService);");
    expect(harnessBridgeSource).toContain('case "harnessAgent":');
  });

  it.each([
    "run-agent-plan",
    "run-agent-tests",
    "run-agent-implement",
  ])("sanitizes %s service payloads into clone-safe worker messages", (nodeId) => {
    const message = buildCloneSafeWorkerMessage(
      createAgentBridgePayload(nodeId),
      `test bridge ${nodeId}`,
    );

    expect(() => assertCloneSafeWorkerMessage(message, `assert ${nodeId}`)).not.toThrow();
    expect(message.args[1].taskKey).toBe(`TASK-LIFECYCLE:${nodeId}`);
    expect(message.args[1].tracker).toEqual(expect.objectContaining({ nodeId }));
    expect(message.args[1].tracker).not.toBeInstanceOf(MockTrackerCarrier);
    expect(message.args[1].ledgerRef.self).toBe("[Circular]");
    expect(message.args[1].nestedCallbacks).toEqual([{ phase: "plan" }]);

    walkValue(message, (entry) => {
      expect(typeof entry).not.toBe("function");
    });
  });
});
