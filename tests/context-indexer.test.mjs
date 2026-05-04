import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  ensureContextIndexFresh,
  getContextFileInsights,
  getContextGraph,
  runContextIndex,
  searchContextIndex,
  getContextIndexStatus,
} from "../workspace/context-indexer.mjs";
import { readFileSync } from "node:fs";

let testRoot;

function makeTempRoot() {
  const dir = resolve(
    tmpdir(),
    `context-index-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("context-indexer", () => {
  beforeEach(() => {
    testRoot = makeTempRoot();
  });

  afterEach(async () => {
    if (testRoot && existsSync(testRoot)) {
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  it("indexes files and supports search/status", async () => {
    mkdirSync(resolve(testRoot, "src"), { recursive: true });
    mkdirSync(resolve(testRoot, "docs"), { recursive: true });

    writeFileSync(
      resolve(testRoot, "src", "alpha.mjs"),
      "// alpha module\nimport { formatGreeting } from \"./helper.mjs\";\nexport function greetUser(name) { return formatGreeting(name); }\n",
      "utf8",
    );

    writeFileSync(
      resolve(testRoot, "src", "helper.mjs"),
      "// helper module\nexport function formatGreeting(name) { return `hello ${name}`; }\n",
      "utf8",
    );

    writeFileSync(
      resolve(testRoot, "src", "beta.py"),
      "# beta module\ndef calc_total(value):\n    return value + 1\n",
      "utf8",
    );

    writeFileSync(
      resolve(testRoot, "docs", "notes.md"),
      "# Notes\nSome documentation for agents.\n",
      "utf8",
    );

    const result = await runContextIndex({
      rootDir: testRoot,
      includeTests: true,
      useTreeSitter: false,
      useZoekt: false,
    });

    expect(result.indexedFiles).toBeGreaterThan(0);
    expect(result.changedFiles).toBeGreaterThan(0);
    expect(result.symbolCount).toBeGreaterThan(0);

    const dbPath = resolve(testRoot, ".bosun", "context-index", "index.db");
    const agentIndexPath = resolve(testRoot, ".bosun", "context-index", "AGENT_INDEX.md");
    const agentIndexJsonPath = resolve(testRoot, ".bosun", "context-index", "agent-index.json");

    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(agentIndexPath)).toBe(true);
    const agentIndexJson = JSON.parse(readFileSync(agentIndexJsonPath, "utf8"));
    expect(Array.isArray(agentIndexJson.relations)).toBe(true);
    expect(agentIndexJson.relations.some((entry) => entry.relationType === "file_imports_file")).toBe(true);

    const hits = await searchContextIndex("greetUser", {
      rootDir: testRoot,
      limit: 10,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((hit) => hit.type === "symbol" && hit.name === "greetUser")).toBe(true);

    const status = await getContextIndexStatus({ rootDir: testRoot });
    expect(status.ready).toBe(true);
    expect(status.fileCount).toBeGreaterThan(0);
    expect(status.symbolCount).toBeGreaterThan(0);
    expect(status.graph.nodeCount).toBeGreaterThan(0);
    expect(status.graph.edgeCount).toBeGreaterThan(0);
    expect(status.graph.relationTypes.some((entry) => entry.relationType === "file_imports_file")).toBe(true);
    expect(status.stale).toBe(false);
    expect(status.staleReasons).toEqual([]);
    expect(status.latestSourcePath).toBeTruthy();
  });

  it("returns a graph neighborhood for seed symbols and imported files", async () => {
    mkdirSync(resolve(testRoot, "src"), { recursive: true });

    writeFileSync(
      resolve(testRoot, "src", "alpha.mjs"),
      "// alpha module\nimport { formatGreeting } from \"./helper.mjs\";\nexport function greetUser(name) { return formatGreeting(name); }\n",
      "utf8",
    );

    writeFileSync(
      resolve(testRoot, "src", "helper.mjs"),
      "// helper module\nexport function formatGreeting(name) { return `hello ${name}`; }\n",
      "utf8",
    );

    await runContextIndex({
      rootDir: testRoot,
      includeTests: true,
      useTreeSitter: false,
      useZoekt: false,
    });

    const graph = await getContextGraph("greetUser", {
      rootDir: testRoot,
      limit: 10,
    });

    expect(graph.nodes.some((node) => node.type === "symbol" && node.name === "greetUser")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "file" && String(node.path || "").endsWith("src/alpha.mjs"))).toBe(true);
    expect(graph.nodes.some((node) => node.type === "file" && String(node.path || "").endsWith("src/helper.mjs"))).toBe(true);
    expect(graph.edges.some((edge) => edge.relationType === "file_defines_symbol" && edge.toName === "greetUser")).toBe(true);
    expect(graph.edges.some((edge) => edge.relationType === "file_imports_file" && String(edge.toPath || "").endsWith("src/helper.mjs"))).toBe(true);
  });

  it("returns helpful per-file insights from the context index", async () => {
    mkdirSync(resolve(testRoot, "src"), { recursive: true });
    mkdirSync(resolve(testRoot, "tests"), { recursive: true });

    writeFileSync(
      resolve(testRoot, "src", "alpha.mjs"),
      "// alpha module\nimport { formatGreeting } from './helper.mjs';\nexport function greetUser(name) { return formatGreeting(name); }\n",
      "utf8",
    );

    writeFileSync(
      resolve(testRoot, "src", "helper.mjs"),
      "export function formatGreeting(name) { return `hello ${name}`; }\n",
      "utf8",
    );

    writeFileSync(
      resolve(testRoot, "tests", "alpha.test.mjs"),
      "import { greetUser } from '../src/alpha.mjs';\nexport function alphaRuntimeTest() { return greetUser('Bosun'); }\n",
      "utf8",
    );

    await runContextIndex({
      rootDir: testRoot,
      includeTests: true,
      useTreeSitter: false,
      useZoekt: false,
    });

    const insights = await getContextFileInsights("src/alpha.mjs", {
      rootDir: testRoot,
    });

    expect(insights).toMatchObject({
      path: "src/alpha.mjs",
      language: "javascript",
      summary: "alpha module",
    });
    expect(insights.symbols.some((entry) => entry.name === "greetUser")).toBe(true);
    expect(insights.imports).toContain("src/helper.mjs");
    expect(insights.relatedTests).toContain("tests/alpha.test.mjs");
  });

  it("rebuilds the context index when it is missing and changed files request graph context", async () => {
    mkdirSync(resolve(testRoot, "src"), { recursive: true });

    writeFileSync(
      resolve(testRoot, "src", "alpha.mjs"),
      "import { formatGreeting } from './helper.mjs';\nexport function greetUser(name) { return formatGreeting(name); }\n",
      "utf8",
    );
    writeFileSync(
      resolve(testRoot, "src", "helper.mjs"),
      "export function formatGreeting(name) { return `hello ${name}`; }\n",
      "utf8",
    );

    const refreshed = await ensureContextIndexFresh({
      rootDir: testRoot,
      changedFiles: ["src/alpha.mjs"],
      useTreeSitter: false,
      useZoekt: false,
    });

    expect(refreshed.refreshed).toBe(true);
    expect(refreshed.reason).toBe("missing");
    expect(refreshed.status.ready).toBe(true);

    const graph = await getContextGraph("greetUser", {
      rootDir: testRoot,
      limit: 10,
    });
    expect(graph.edges.some((edge) => edge.relationType === "file_imports_file" && String(edge.toPath || "").endsWith("src/helper.mjs"))).toBe(true);
  });

  it("reports stale context indexes when workspace source files changed after indexing", async () => {
    mkdirSync(resolve(testRoot, "src"), { recursive: true });

    const alphaPath = resolve(testRoot, "src", "alpha.mjs");
    writeFileSync(alphaPath, "export function greetUser(name) { return name; }\n", "utf8");

    await runContextIndex({
      rootDir: testRoot,
      includeTests: true,
      useTreeSitter: false,
      useZoekt: false,
    });

    writeFileSync(alphaPath, "export function greetUser(name) { return `${name}!`; }\n", "utf8");
    const futureDate = new Date(Date.now() + 5000);
    utimesSync(alphaPath, futureDate, futureDate);

    const status = await getContextIndexStatus({
      rootDir: testRoot,
      includeTests: true,
      maxAgeMs: 60 * 60 * 1000,
    });

    expect(status.ready).toBe(true);
    expect(status.stale).toBe(true);
    expect(status.staleBecauseWorkspaceChanged).toBe(true);
    expect(status.staleBecauseAge).toBe(false);
    expect(status.staleReasons).toContain("workspace-changed");
    expect(status.latestSourcePath).toBe("src/alpha.mjs");
  });

  it("supports task-type scoped search with optional fallback", async () => {
    mkdirSync(resolve(testRoot, "src", "ui"), { recursive: true });
    mkdirSync(resolve(testRoot, ".github", "workflows"), { recursive: true });

    writeFileSync(
      resolve(testRoot, "src", "ui", "button.tsx"),
      "export function renderButton(label: string) { return `<button>${label}</button>`; }\n",
      "utf8",
    );

    writeFileSync(
      resolve(testRoot, ".github", "workflows", "ci.yml"),
      "name: CI\non:\n  workflow_dispatch:\njobs:\n  build:\n    runs-on: ubuntu-latest\n",
      "utf8",
    );

    await runContextIndex({
      rootDir: testRoot,
      includeTests: true,
      useTreeSitter: false,
      useZoekt: false,
    });

    const strictFrontend = await searchContextIndex("ci.yml", {
      rootDir: testRoot,
      taskType: "frontend",
      fallbackToGlobal: false,
      limit: 10,
    });

    expect(Array.isArray(strictFrontend)).toBe(true);
    expect(strictFrontend.length).toBe(0);

    const frontendWithFallback = await searchContextIndex("ci.yml", {
      rootDir: testRoot,
      taskType: "frontend",
      fallbackToGlobal: true,
      includeMeta: true,
      limit: 10,
    });

    expect(frontendWithFallback.taskTypeUsed).toBe("frontend");
    expect(frontendWithFallback.fallbackUsed).toBe(true);
    expect(frontendWithFallback.results.some((hit) => String(hit.path || "").includes(".github/workflows/ci.yml"))).toBe(true);

    const scopedFrontend = await searchContextIndex("renderButton", {
      rootDir: testRoot,
      taskType: "frontend",
      includeMeta: true,
      limit: 10,
    });

    expect(scopedFrontend.fallbackUsed).toBe(false);
    expect(scopedFrontend.results.some((hit) => String(hit.path || "").includes("src/ui/button.tsx"))).toBe(true);
  });

  it("skips Bosun runtime mirrors and generated directories during indexing", async () => {
    mkdirSync(resolve(testRoot, "src"), { recursive: true });
    mkdirSync(resolve(testRoot, ".bosun", "workspaces", "mirror", "src"), { recursive: true });
    mkdirSync(resolve(testRoot, ".bosun-monitor"), { recursive: true });
    mkdirSync(resolve(testRoot, "output"), { recursive: true });
    mkdirSync(resolve(testRoot, "execution-ledger"), { recursive: true });

    writeFileSync(
      resolve(testRoot, "src", "live.mjs"),
      "export function liveSource() { return true; }\n",
      "utf8",
    );

    writeFileSync(
      resolve(testRoot, ".bosun", "workspaces", "mirror", "src", "live.mjs"),
      "export function mirroredSource() { return true; }\n",
      "utf8",
    );

    writeFileSync(
      resolve(testRoot, ".bosun-monitor", "session.md"),
      "# Runtime session\n",
      "utf8",
    );

    writeFileSync(
      resolve(testRoot, "output", "generated.json"),
      '{"generated":true}\n',
      "utf8",
    );

    writeFileSync(
      resolve(testRoot, "execution-ledger", "run.md"),
      "# Generated run log\n",
      "utf8",
    );

    await runContextIndex({
      rootDir: testRoot,
      includeTests: true,
      useTreeSitter: false,
      useZoekt: false,
    });

    const agentIndexJsonPath = resolve(testRoot, ".bosun", "context-index", "agent-index.json");
    const agentIndexJson = JSON.parse(readFileSync(agentIndexJsonPath, "utf8"));
    const indexedPaths = agentIndexJson.files.map((entry) => entry.path).sort();

    expect(indexedPaths).toEqual(["src/live.mjs"]);
  });

  it("keeps PDF files excluded from the Bosun-native context index boundary", () => {
    const source = readFileSync(resolve(process.cwd(), "workspace", "context-indexer.mjs"), "utf8");
    expect(source).toContain('".pdf"');
    expect(source).toMatch(/BINARY_EXTENSIONS\s*=\s*new Set\(/);
  });
});
