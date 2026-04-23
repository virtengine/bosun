import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("monitor self-restart defer hard caps", () => {
  const monitorSource = readFileSync(resolve(process.cwd(), "infra/monitor.mjs"), "utf8");

  it("defaults SELF_RESTART_DEFER_HARD_CAP to 6", () => {
    expect(monitorSource).toContain('process.env.SELF_RESTART_DEFER_HARD_CAP || "6"');
  });

  it("defines a max deferred-time cap", () => {
    expect(monitorSource).toContain('process.env.SELF_RESTART_MAX_DEFER_MS || "180000"');
  });

  it("defines a minimum active-slot age before forced restart", () => {
    expect(monitorSource).toContain(
      'process.env.SELF_RESTART_FORCE_ACTIVE_SLOT_MIN_AGE_MS',
    );
  });

  it("extends deferral when active agents are still young", () => {
    expect(monitorSource).toContain("getYoungActiveAgentRestartDeferralInfo");
    expect(monitorSource).toContain(
      "self-restart defer cap reached, but ${youngAgentInfo.activeSlots} active agent(s) are still young",
    );
  });

  it("forces restart path at hard cap with active-agent override", () => {
    expect(monitorSource).toContain(
      "selfRestartForSourceChange(filename, { forceActiveAgentExit: true });",
    );
    expect(monitorSource).toContain("if (activeSlots > 0 && !forceActiveAgentExit)");
    expect(monitorSource).toContain("if (activeWorkflowRuns > 0)");
    expect(monitorSource).toContain(
      "FORCED self-restart: proceeding with ${activeSlots} active agent(s) after defer hard cap",
    );
  });

  it("defers restart while workflow runs are still active", () => {
    expect(monitorSource).toContain("function getActiveWorkflowRunSummaries()");
    expect(monitorSource).toContain("reason: `${activeWorkflowRuns} workflow run(s) active`");
    expect(monitorSource).toContain(
      "self-restart deferred — ${activeWorkflowRuns.length} workflow run(s) still active",
    );
    expect(monitorSource).toContain(
      "continuing to defer until workflow work clears",
    );
    expect(monitorSource).not.toContain(
      "FORCED self-restart: proceeding with ${activeWorkflowRuns} active workflow run(s) after defer hard cap",
    );
  });
});
