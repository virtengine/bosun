import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("workflow copilot integration surfaces", () => {
  const workflowUiSource = readFileSync(resolve(process.cwd(), "ui/tabs/workflows.js"), "utf8");
  const sessionListSource = readFileSync(resolve(process.cwd(), "ui/components/session-list.js"), "utf8");
  const serverSource = readFileSync(resolve(process.cwd(), "server/ui-server.mjs"), "utf8");

  it("adds workflow and node copilot entry points in the workflows UI", () => {
    expect(workflowUiSource).toContain("Explain With Bosun");
    expect(workflowUiSource).toContain("Ask Bosun About Node");
    expect(workflowUiSource).toContain("Ask Bosun About This Node");
    expect(workflowUiSource).toContain("Fix This Node");
    expect(workflowUiSource).toContain("/copilot-context");
  });

  it("allows seeded workflow copilot sessions to bypass fresh-session reuse", () => {
    expect(sessionListSource).toContain("const allowReuseFresh = options?.reuseFresh !== false;");
    expect(sessionListSource).toContain("if (allowReuseFresh) {");
  });

  it("exposes server-side workflow and run copilot context builders", () => {
    expect(serverSource).toContain("function buildWorkflowCopilotContextPayload");
    expect(serverSource).toContain("function buildRunCopilotContextPayload");
    expect(serverSource).toContain('action === "copilot-context"');
  });

  it("keeps run copilot context resilient when optional forensics calls fail", () => {
    expect(serverSource).toContain("available: false");
    expect(serverSource).toContain("Failed to load node forensics");
    expect(serverSource).toContain("Failed to load run forensics");
  });
});
