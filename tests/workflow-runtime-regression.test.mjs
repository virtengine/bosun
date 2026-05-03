import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("workflow runtime regression guards", () => {
  const actionSource = readFileSync(resolve(process.cwd(), "workflow/workflow-nodes/actions.mjs"), "utf8");
  const monitorSource = readFileSync(resolve(process.cwd(), "infra/monitor.mjs"), "utf8");

  it("retries agent workflow runs with a fresh session when stale session state crashes", () => {
    expect(actionSource).toContain("function isNullSessionIdCrash");
    expect(actionSource).toContain('retryWithFreshManagedSession("stale session state detected")');
    expect(actionSource).toContain("sessionId: freshSessionId");
    expect(actionSource).toContain("autoRecover: false");
  });

  it("ensures monitor bootstraps workflow node types before automation engine startup", () => {
    expect(monitorSource).toContain("wfNodes.ensureWorkflowNodeTypesLoaded");
    expect(monitorSource).toContain("await wfNodes.ensureWorkflowNodeTypesLoaded({ repoRoot });");
  });
});
