import { describe, expect, it } from "vitest";

import {
  createCoverageStubResult,
  shouldExecuteOriginalForCoverage,
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
});
