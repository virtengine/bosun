import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

import { buildRepoMap, buildArchitectEditorFrame, formatRepoTopology } from "../lib/repo-map.mjs";

let testRoot;

function makeTempRoot() {
  const dir = resolve(
    tmpdir(),
    `repo-map-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("repo-map", () => {
  beforeEach(() => {
    testRoot = makeTempRoot();
  });

  afterEach(async () => {
    if (testRoot && existsSync(testRoot)) {
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  it("builds a query-scoped repo map from the Bosun agent index", () => {
    const indexDir = resolve(testRoot, ".bosun", "context-index");
    mkdirSync(indexDir, { recursive: true });
    writeFileSync(resolve(indexDir, "agent-index.json"), JSON.stringify({
      files: [
        { path: "agent/primary-agent.mjs", summary: "primary agent routing and prompt framing" },
        { path: "tests/primary-agent.runtime.test.mjs", summary: "runtime coverage for primary agent framing" },
        { path: "workflow/workflow-nodes.mjs", summary: "workflow node implementations" },
      ],
      symbols: [
        { path: "agent/primary-agent.mjs", name: "buildArchitectEditorFrame", kind: "function", line: 100, signature: "buildArchitectEditorFrame(options, effectiveMode)" },
        { path: "agent/primary-agent.mjs", name: "execPrimaryPrompt", kind: "function", line: 200, signature: "execPrimaryPrompt(userMessage, options)" },
        { path: "tests/primary-agent.runtime.test.mjs", name: "primaryAgentRuntime", kind: "test", line: 10, signature: "primary agent framing tests" },
      ],
      relations: [
        {
          relationType: "file_imports_file",
          fromPath: "agent/primary-agent.mjs",
          toPath: "workflow/workflow-nodes.mjs",
        },
      ],
    }, null, 2), "utf8");

    const repoMap = buildRepoMap({
      repoRoot: testRoot,
      query: "primary agent framing",
      repoMapFileLimit: 2,
    });

    expect(repoMap.root).toBe(testRoot.replace(/\\/g, "/"));
    expect(repoMap.files).toHaveLength(2);
    expect(repoMap.files[0].path).toBe("agent/primary-agent.mjs");
    expect(repoMap.files[0].symbols).toContain("buildArchitectEditorFrame");
    expect(repoMap.files[0].adjacentPaths).toContain("workflow/workflow-nodes.mjs");
  });

  it("builds a query-scoped repo map from the indexed graph database when the json projection is absent", async () => {
    const { rm } = await import("node:fs/promises");
    const { runContextIndex } = await import("../workspace/context-indexer.mjs");

    mkdirSync(resolve(testRoot, "agent"), { recursive: true });
    mkdirSync(resolve(testRoot, "workflow"), { recursive: true });
    writeFileSync(
      resolve(testRoot, "agent", "primary-agent.mjs"),
      "import { runWorkflowNode } from '../workflow/workflow-nodes.mjs';\nexport function buildArchitectEditorFrame(options) { return runWorkflowNode(options); }\n",
      "utf8",
    );
    writeFileSync(
      resolve(testRoot, "workflow", "workflow-nodes.mjs"),
      "export function runWorkflowNode(options) { return options; }\n",
      "utf8",
    );

    await runContextIndex({
      rootDir: testRoot,
      includeTests: true,
      useTreeSitter: false,
      useZoekt: false,
    });
    await rm(resolve(testRoot, ".bosun", "context-index", "agent-index.json"), { force: true });

    const repoMap = buildRepoMap({
      repoRoot: testRoot,
      query: "architect editor frame",
      repoMapFileLimit: 2,
    });

    expect(repoMap.root).toBe(testRoot.replace(/\\/g, "/"));
    expect(repoMap.files).toHaveLength(2);
    expect(repoMap.files[0].path).toBe("agent/primary-agent.mjs");
    expect(repoMap.files[0].symbols).toContain("buildArchitectEditorFrame");
    expect(repoMap.files[0].adjacentPaths).toContain("workflow/workflow-nodes.mjs");
  });

  it("prepends architect/editor framing with explicit repo maps", () => {
    const frame = buildArchitectEditorFrame({
      executionRole: "editor",
      architectPlan: "1. Update prompt framing\n2. Run focused tests",
      repoMap: {
        root: "C:/repo",
        files: [
          { path: "agent/primary-agent.mjs", summary: "primary agent runtime", symbols: ["execPrimaryPrompt"] },
        ],
      },
    }, "agent");

    expect(frame).toContain("## Architect/Editor Execution");
    expect(frame).toContain("You are the editor phase.");
    expect(frame).toContain("## Architect Plan");
    expect(frame).toContain("## Repo Topology");
    expect(frame).toContain("Root: C:/repo");
    expect(frame).toContain("owner: agent");
    expect(frame).toContain("agent/primary-agent.mjs");
  });

  it("formats compact repo topology with ownership and adjacency summaries", () => {
    const topology = formatRepoTopology({
      root: "C:/repo",
      files: [
        { path: "workflow/workflow-engine.mjs", summary: "workflow runtime" },
        { path: "workflow/workflow-nodes.mjs", summary: "workflow nodes" },
        { path: "tests/workflow-engine.test.mjs", summary: "workflow runtime coverage" },
      ],
    });

    expect(topology).toContain("## Repo Topology");
    expect(topology).toContain("Areas: workflow (2), tests (1)");
    expect(topology).toContain("workflow/workflow-engine.mjs");
    expect(topology).toContain("owner: workflow");
    expect(topology).toContain("adjacent: workflow/workflow-nodes.mjs, tests/workflow-engine.test.mjs");
  });

  it("prefers graph adjacency over heuristic adjacency when available", () => {
    const topology = formatRepoTopology({
      root: "C:/repo",
      files: [
        {
          path: "agent/primary-agent.mjs",
          summary: "primary agent runtime",
          adjacentPaths: ["workflow/workflow-nodes.mjs"],
        },
        {
          path: "tests/primary-agent.runtime.test.mjs",
          summary: "runtime coverage for primary agent framing",
        },
        {
          path: "workflow/workflow-nodes.mjs",
          summary: "workflow nodes",
        },
      ],
    });

    expect(topology).toContain("adjacent: workflow/workflow-nodes.mjs");
    expect(topology).not.toContain("adjacent: tests/primary-agent.runtime.test.mjs");
  });

  it("caps repo topology summaries to protect prompt budget", () => {
    const topology = formatRepoTopology({
      root: "C:/repo",
      files: [
        {
          path: "workflow/workflow-engine.mjs",
          summary: "This summary is intentionally very long so the compact repo topology formatter trims it before injecting it into planner and execution prompts.",
        },
      ],
    }, { repoMapSummaryLimit: 60 });

    expect(topology).toContain("This summary is intentionally very long so the compact repo...");
    expect(topology).not.toContain("formatter trims it before injecting");
  });

  it("omits repo topology when architect/editor framing disables enrichment", () => {
    const frame = buildArchitectEditorFrame({
      executionRole: "editor",
      architectPlan: "1. Update prompt framing\n2. Run focused tests",
      includeRepoMap: false,
      repoMap: {
        root: "C:/repo",
        files: [
          { path: "workflow/workflow-engine.mjs", summary: "workflow runtime" },
        ],
      },
    }, "agent");

    expect(frame).toContain("## Architect/Editor Execution");
    expect(frame).toContain("## Architect Plan");
    expect(frame).not.toContain("## Repo Topology");
  });

  it("scopes architect/editor repo topology to declared repo areas", () => {
    const frame = buildArchitectEditorFrame({
      executionRole: "editor",
      repoAreas: ["workflow", "cli"],
      repoMap: {
        root: "C:/repo",
        files: [
          { path: "workflow/workflow-engine.mjs", summary: "workflow runtime" },
          { path: "voice/voice-tools.mjs", summary: "voice adapter" },
          { path: "cli.mjs", summary: "command entrypoint" },
        ],
      },
    }, "agent");

    expect(frame).toContain("Restrict discovery and edits to these repo areas");
    expect(frame).toContain("Only inspect tests that directly cover these repo areas");
    expect(frame).toContain("Avoid unrelated test suites from other product areas");
    expect(frame).toContain("- workflow");
    expect(frame).toContain("- cli");
    expect(frame).toContain("workflow/workflow-engine.mjs");
    expect(frame).toContain("cli.mjs");
    expect(frame).not.toContain("voice/voice-tools.mjs");
  });

  it("does not inject repo topology when no architect or editor role is active", () => {
    const frame = buildArchitectEditorFrame({
      repoMap: {
        root: "C:/repo",
        files: [
          { path: "workflow/workflow-engine.mjs", summary: "workflow runtime" },
        ],
      },
    }, "agent");

    expect(frame).toBe("");
  });

  it("handles slash-heavy query input without regex backtracking", () => {
    const indexDir = resolve(testRoot, ".bosun", "context-index");
    mkdirSync(indexDir, { recursive: true });
    writeFileSync(resolve(indexDir, "agent-index.json"), JSON.stringify({
      files: [
        { path: "lib/repo-map.mjs", summary: "repo map query tokenization" },
      ],
      symbols: [
        { path: "lib/repo-map.mjs", name: "tokenizeQuery", kind: "function", line: 155, signature: "tokenizeQuery(...parts)" },
      ],
    }, null, 2), "utf8");

    const repoMap = buildRepoMap({
      repoRoot: testRoot,
      query: `${"/".repeat(5000)}repo-map///`,
      repoMapFileLimit: 1,
    });

    expect(repoMap.files).toHaveLength(1);
    expect(repoMap.files[0].path).toBe("lib/repo-map.mjs");
    expect(repoMap.files[0].symbols).toContain("tokenizeQuery");
  });
});

