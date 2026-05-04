import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

describe("async safety guards", () => {
  const monitorSource = readFileSync(resolve(process.cwd(), "infra/monitor.mjs"), "utf8");
  const analyzerSource = readFileSync(
    resolve(process.cwd(), "agent/agent-work-analyzer.mjs"),
    "utf8",
  );
  const launcherSource = readFileSync(resolve(process.cwd(), "agent/agent-launcher.mjs"), "utf8");
  const updateSource = readFileSync(resolve(process.cwd(), "infra/update-check.mjs"), "utf8");

  it("handles monitor failure promises with explicit catch guards", () => {
    expect(monitorSource).toContain(
      'handleMonitorFailure("uncaughtException", err).catch((failureErr) => {',
    );
    expect(monitorSource).toContain(
      'handleMonitorFailure("unhandledRejection", err).catch((failureErr) => {',
    );
    expect(monitorSource).toContain(
      'handleMonitorFailure(reason, error).catch((failureErr) => {',
    );
  });

  it("guards detached monitor scheduler/notifier dispatches", () => {
    expect(monitorSource).toContain("function runDetached(label, promiseOrFn) {");
    expect(monitorSource).toContain(
      'runDetached("agent-alerts:poll-interval", pollAgentAlerts);',
    );
    expect(monitorSource).toContain(
      'runDetached("telegram-notifier:interval-update", sendUpdate)',
    );
    expect(monitorSource).not.toContain("void pollAgentAlerts();");
    expect(monitorSource).not.toContain('void publishTaskPlannerStatus("interval");');
    expect(monitorSource).not.toContain("setInterval(sendUpdate, intervalMs);");
  });

  it("guards agent-work-analyzer stuck sweep interval", () => {
    expect(analyzerSource).toContain("runStuckSweep().catch((err) => {");
  });

  it("guards agent-launcher fire-and-forget registry operations", () => {
    expect(launcherSource).toContain(
      "ensureThreadRegistryLoaded().catch((err) => {",
    );
    expect(launcherSource).toContain(
      "invalidateThreadAsync(taskKey).catch((err) => {",
    );
  });

  it("guards auto-update poll scheduling", () => {
    expect(updateSource).toContain("const runPollSafely = () => {");
    expect(updateSource).toContain(
      "autoUpdateTimer = setInterval(runPollSafely, intervalMs);",
    );
    expect(updateSource).not.toContain(
      "autoUpdateTimer = setInterval(() => void poll(), intervalMs);",
    );
  });
});
