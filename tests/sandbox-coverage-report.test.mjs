import { describe, expect, it } from "vitest";

import {
  createCoverageNodeResult,
  createCoverageStubResult,
  shouldExecuteOriginalForCoverage,
  shouldStubCoverageGates,
} from "./sandbox/coverage-report-helpers.mjs";

describe("sandbox coverage report stubs", () => {
  it("keeps control-flow node types on their original executors", () => {
    expect(shouldExecuteOriginalForCoverage("trigger.manual")).toBe(true);
    expect(shouldExecuteOriginalForCoverage("condition.expression")).toBe(true);
    expect(shouldExecuteOriginalForCoverage("flow.parallel")).toBe(true);
    expect(shouldExecuteOriginalForCoverage("transform.template")).toBe(true);
  });

  it("stubs side-effecting node types with safe deterministic payloads", () => {
    expect(shouldExecuteOriginalForCoverage("action.run_command")).toBe(false);
    expect(shouldExecuteOriginalForCoverage("notify.telegram")).toBe(false);
    expect(shouldExecuteOriginalForCoverage("meeting.finalize")).toBe(false);

    expect(createCoverageStubResult("action.run_command")).toMatchObject({
      success: true,
      passed: true,
      result: true,
      repo: "virtengine/bosun",
      repoSlug: "virtengine/bosun",
      prNumber: 1,
      stubbedForCoverage: true,
      nodeType: "action.run_command",
    });
  });

  it("can produce failing in-process gate results", () => {
    expect(createCoverageNodeResult("flow.gate", {
      passed: false,
      reason: "threshold not met",
      summary: "timeout gate blocked in-process",
    })).toMatchObject({
      success: false,
      passed: false,
      blocked: true,
      exitCode: 1,
      reason: "threshold not met",
      nodeType: "flow.gate",
    });
  });

  it("only enables stubbed gates when BOSUN_STUB_GATES=1", () => {
    const previous = process.env.BOSUN_STUB_GATES;
    delete process.env.BOSUN_STUB_GATES;
    expect(shouldStubCoverageGates()).toBe(false);
    process.env.BOSUN_STUB_GATES = "1";
    expect(shouldStubCoverageGates()).toBe(true);
    if (previous === undefined) delete process.env.BOSUN_STUB_GATES;
    else process.env.BOSUN_STUB_GATES = previous;
  });
});
