import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  executeWorkflowCommand,
  getTemplateRunDependencyIds,
  installTemplateRunDependencies,
  listWorkflowSummaries,
  parseWorkflowInput,
} from "../workflow/workflow-cli.mjs";

describe("workflow CLI helpers", () => {
  it("lists builtin and configured workflows", () => {
    const summaries = listWorkflowSummaries({
      workflows: {
        customRace: {
          type: "race",
          agents: ["implement", "review"],
        },
      },
    });

    expect(summaries.some((entry) => entry.name === "code-review-chain")).toBe(true);
    expect(summaries.some((entry) => entry.name === "customRace" && entry.source === "config")).toBe(true);
  });

  it("parses file and inline workflow input", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "bosun-workflow-cli-"));
    try {
      const filePath = resolve(dir, "input.json");
      writeFileSync(filePath, JSON.stringify({ title: "From file", prompt: "Run it" }), "utf8");

      expect(parseWorkflowInput('{"title":"Inline","prompt":"Go"}')).toEqual({
        title: "Inline",
        prompt: "Go",
      });
      expect(parseWorkflowInput(filePath)).toEqual({
        title: "From file",
        prompt: "Run it",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs declarative workflows with injected services", async () => {
    const stdout = [];
    const prompts = [];

    const response = await executeWorkflowCommand(
      ["workflow", "run", "code-review-chain", "--input", '{"title":"Task","prompt":"Ship it"}'],
      {
        stdout: (line) => stdout.push(line),
        config: { workflows: {} },
        forceJsonOutput: true,
        services: {
          agentPool: {
            async execWithRetry(prompt) {
              prompts.push(prompt);
              return {
                success: true,
                output: "step-" + prompts.length,
                usage: { totalTokens: 1 },
              };
            },
          },
        },
      },
    );

    expect(response.ok).toBe(true);
    expect(response.result.success).toBe(true);
    expect(prompts).toHaveLength(3);
    expect(JSON.parse(stdout[0]).success).toBe(true);
  });

  it("lists workflow-engine templates", async () => {
    const stdout = [];
    const response = await executeWorkflowCommand(["workflow", "templates", "--json"], {
      stdout: (line) => stdout.push(line),
    });

    expect(response.ok).toBe(true);
    const payload = JSON.parse(stdout[0]);
    expect(payload.some((entry) => entry.id === "template-task-lifecycle")).toBe(true);
    expect(payload.some((entry) => entry.id === "template-backend-agent")).toBe(true);
  });

  it("resolves required child templates for template-run dispatch targets", () => {
    expect(getTemplateRunDependencyIds("template-bosun-pr-watchdog")).toEqual(
      expect.arrayContaining([
        "template-pr-fix-single",
        "template-pr-security-fix-single",
      ]),
    );
  });

  it("installs required child templates into template-run engines", () => {
    const savedIds = [];
    const installed = installTemplateRunDependencies({
      save(def) {
        savedIds.push(def.id);
      },
    }, "template-bosun-pr-watchdog");

    expect(installed).toEqual(
      expect.arrayContaining([
        "template-pr-fix-single",
        "template-pr-security-fix-single",
      ]),
    );
    expect(savedIds).toEqual(expect.arrayContaining(installed));
  });

  it("dry-runs workflow-engine templates with traced node output", async () => {
    const stdout = [];
    const response = await executeWorkflowCommand(
      [
        "workflow",
        "template-run",
        "template-backend-agent",
        "--dry-run",
        "--json",
        "--input-json",
        JSON.stringify({
          taskTitle: "Fix prompt routing",
          taskDescription: "Inspect backend agent planning flow",
          branch: "task/fix-prompt-routing",
          testCommand: "npm test",
          buildCommand: "npm run build",
          lintCommand: "npm run lint",
        }),
      ],
      {
        stdout: (line) => stdout.push(line),
      },
    );

    expect(response.ok).toBe(true);
    expect(response.report.status).toBe("completed");
    expect(response.report.dryRun).toBe(true);
    const payload = JSON.parse(stdout[0]);
    expect(payload.template.id).toBe("template-backend-agent");
    expect(payload.nodes.some((node) => node.id === "plan-work" && node.type === "action.run_agent")).toBe(true);
    expect(payload.nodes.some((node) => node.id === "write-tests" && node.status === "completed")).toBe(true);
  });

  it("reports custom node health summaries in JSON", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "bosun-workflow-cli-nodes-"));
    mkdirSync(join(dir, "custom-nodes"), { recursive: true });
    try {
      writeFileSync(join(dir, "custom-nodes", "good.mjs"), [
        'export const manifest = { id: "good-node", name: "Good Node", version: "1.0.0" };',
        'export const type = "custom.good";',
        "export const inputs = [];",
        "export const outputs = ['success'];",
        "export function describe(){ return 'good'; }",
        "export async function execute(){ return { success: true, port: 'success' }; }",
        "",
      ].join("\n"), "utf8");
      writeFileSync(join(dir, "custom-nodes", "broken.mjs"), [
        'export const manifest = "bad";',
        'export const type = "custom.broken";',
        "export const inputs = [];",
        "export const outputs = [];",
        "export function describe(){ return 'broken'; }",
        "export async function execute(){ return { success: true, port: 'success' }; }",
        "",
      ].join("\n"), "utf8");

      const stdout = [];
      const response = await executeWorkflowCommand(["workflow", "nodes", "--json"], {
        stdout: (line) => stdout.push(line),
        repoRoot: dir,
      });

      expect(response.ok).toBe(true);
      const payload = JSON.parse(stdout[0]);
      expect(payload.summary.loaded).toBe(1);
      expect(payload.summary.skipped).toBe(1);
      expect(payload.plugins.some((entry) => entry.fileName === "broken.mjs" && entry.status === "skipped")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
