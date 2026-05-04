/**
 * Tests for back-edge (convergence loop) support in the workflow engine,
 * and the new node types: loop.while, transform.llm_parse, action.web_search.
 *
 * Also validates the Aletheia research-agent template structure.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  WorkflowEngine,
  WorkflowContext,
  NodeStatus,
} from "../workflow/workflow-engine.mjs";
import {
  registerNodeType,
  getNodeType,
} from "../workflow/workflow-nodes.mjs";
import { WORKFLOW_TEMPLATES, TEMPLATE_CATEGORIES } from "../workflow/workflow-templates.mjs";

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir;
let engine;
const SLOW_WORKFLOW_BACK_EDGE_TEST_TIMEOUT_MS = process.platform === "win32" ? 30_000 : 10_000;

function makeTmpEngine(services = {}) {
  tmpDir = mkdtempSync(join(tmpdir(), "wf-backedge-test-"));
  engine = new WorkflowEngine({
    workflowDir: join(tmpDir, "workflows"),
    runsDir: join(tmpDir, "runs"),
    services,
  });
  return engine;
}

function makeWorkflow(nodes, edges, opts = {}) {
  return {
    id: opts.id || "test-wf-" + Math.random().toString(36).slice(2, 8),
    name: opts.name || "Test Workflow",
    description: opts.description || "Back-edge test workflow",
    enabled: true,
    nodes,
    edges,
    variables: opts.variables || {},
  };
}

function backEdgeTest(name, fn) {
  return it(name, fn, SLOW_WORKFLOW_BACK_EDGE_TEST_TIMEOUT_MS);
}

// ═══════════════════════════════════════════════════════════════════════════
//  BACK-EDGE ENGINE SUPPORT
// ═══════════════════════════════════════════════════════════════════════════

describe("WorkflowEngine - back-edge (convergence loops)", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  backEdgeTest("executes a simple back-edge loop until condition is false", async () => {
    // Graph: trigger → counter → check → [back to counter if count < 3]
    //                                   → done (if count >= 3)
    let count = 0;

    const counterType = "test.be_counter_" + Math.random().toString(36).slice(2, 8);
    registerNodeType(counterType, {
      describe: () => "Increment counter",
      schema: { type: "object", properties: {} },
      async execute(node, ctx) {
        count++;
        ctx.data._count = count;
        return { count };
      },
    });

    const doneType = "test.be_done_" + Math.random().toString(36).slice(2, 8);
    const doneLog = [];
    registerNodeType(doneType, {
      describe: () => "Done marker",
      schema: { type: "object", properties: {} },
      async execute(node, ctx) {
        doneLog.push(ctx.data._count);
        return { final: ctx.data._count };
      },
    });

    const wf = makeWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "counter", type: counterType, label: "Counter", config: {} },
        { id: "done", type: doneType, label: "Done", config: {} },
      ],
      [
        { id: "e1", source: "trigger", target: "counter" },
        { id: "e2", source: "counter", target: "done" },
        {
          id: "e-back",
          source: "counter",
          target: "counter",
          backEdge: true,
          condition: "$data._count < 3",
        },
      ],
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});
    expect(result.errors).toEqual([]);
    // Counter should have run 3 times (1, 2, 3 — back-edge fires at 1 and 2, stops at 3)
    expect(count).toBe(3);
    // Done runs when counter completes — at least once (final iteration)
    expect(doneLog.length).toBeGreaterThanOrEqual(1);
    expect(doneLog).toContain(3); // last done execution sees count=3
  });

  backEdgeTest("enforces MAX_BACK_EDGE_ITERATIONS safety cap", async () => {
    // Infinite loop — back-edge always fires
    let count = 0;
    const infType = "test.be_infinite_" + Math.random().toString(36).slice(2, 8);
    registerNodeType(infType, {
      describe: () => "Always increment",
      schema: { type: "object", properties: {} },
      async execute() { count++; return { count }; },
    });

    const wf = makeWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "loop", type: infType, label: "Loop", config: {} },
      ],
      [
        { id: "e1", source: "trigger", target: "loop" },
        { id: "e-back", source: "loop", target: "loop", backEdge: true, maxIterations: 5 },
      ],
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});
    // Should stop after maxIterations + 1 (initial run + 5 back-edges)
    expect(count).toBeLessThanOrEqual(6);
    expect(count).toBeGreaterThanOrEqual(5);
  });

  backEdgeTest("emits loop:back_edge events", async () => {
    const events = [];
    let count = 0;
    const evType = "test.be_event_" + Math.random().toString(36).slice(2, 8);
    registerNodeType(evType, {
      describe: () => "Count",
      schema: { type: "object", properties: {} },
      async execute(node, ctx) {
        count++;
        ctx.data._c = count;
        return { count };
      },
    });

    const wf = makeWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "node", type: evType, label: "Node", config: {} },
      ],
      [
        { id: "e1", source: "trigger", target: "node" },
        { id: "e-back", source: "node", target: "node", backEdge: true, condition: "$data._c < 3" },
      ],
    );

    engine.save(wf);
    engine.on("loop:back_edge", (ev) => events.push(ev));
    await engine.execute(wf.id, {});

    expect(events.length).toBe(2); // fires at count=1 and count=2
    expect(events[0].source).toBe("node");
    expect(events[0].target).toBe("node");
    expect(events[0].iteration).toBe(1);
    expect(events[1].iteration).toBe(2);
  });

  backEdgeTest("emits loop:exhausted when max iterations exceeded", async () => {
    const exhausted = [];
    const exhType = "test.be_exhaust_" + Math.random().toString(36).slice(2, 8);
    registerNodeType(exhType, {
      describe: () => "Always loop",
      schema: { type: "object", properties: {} },
      async execute() { return {}; },
    });

    const wf = makeWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "node", type: exhType, label: "Node", config: {} },
      ],
      [
        { id: "e1", source: "trigger", target: "node" },
        { id: "e-back", source: "node", target: "node", backEdge: true, maxIterations: 2 },
      ],
    );

    engine.save(wf);
    engine.on("loop:exhausted", (ev) => exhausted.push(ev));
    await engine.execute(wf.id, {});

    expect(exhausted.length).toBe(1);
    expect(exhausted[0].iterations).toBe(2);
  });

  backEdgeTest("resets downstream subgraph on back-edge", async () => {
    // trigger → A → B → C, with back-edge from C→A
    // On each loop, A, B, and C should all re-execute
    const execOrder = [];
    const makeType = (name) => {
      const t = `test.be_sub_${name}_` + Math.random().toString(36).slice(2, 8);
      registerNodeType(t, {
        describe: () => `Node ${name}`,
        schema: { type: "object", properties: {} },
        async execute(node, ctx) {
          execOrder.push(name);
          ctx.data[`_${name}_count`] = (ctx.data[`_${name}_count`] || 0) + 1;
          return { name, ran: ctx.data[`_${name}_count`] };
        },
      });
      return t;
    };

    const typeA = makeType("A");
    const typeB = makeType("B");
    const typeC = makeType("C");

    const wf = makeWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "a", type: typeA, label: "A", config: {} },
        { id: "b", type: typeB, label: "B", config: {} },
        { id: "c", type: typeC, label: "C", config: {} },
      ],
      [
        { id: "e1", source: "trigger", target: "a" },
        { id: "e2", source: "a", target: "b" },
        { id: "e3", source: "b", target: "c" },
        { id: "e-back", source: "c", target: "a", backEdge: true, condition: "$data._A_count < 2" },
      ],
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});
    expect(result.errors).toEqual([]);

    // A, B, C should each appear twice: first run + one back-edge loop
    const countA = execOrder.filter((n) => n === "A").length;
    const countB = execOrder.filter((n) => n === "B").length;
    const countC = execOrder.filter((n) => n === "C").length;
    expect(countA).toBe(2);
    expect(countB).toBe(2);
    expect(countC).toBe(2);
  });

  backEdgeTest("does not follow back-edge when condition is false", async () => {
    let count = 0;
    const skipType = "test.be_skip_" + Math.random().toString(36).slice(2, 8);
    registerNodeType(skipType, {
      describe: () => "Track execution",
      schema: { type: "object", properties: {} },
      async execute() { count++; return { count }; },
    });

    const wf = makeWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "node", type: skipType, label: "Node", config: {} },
      ],
      [
        { id: "e1", source: "trigger", target: "node" },
        // Condition always false — back-edge should never fire
        { id: "e-back", source: "node", target: "node", backEdge: true, condition: "false" },
      ],
    );

    engine.save(wf);
    await engine.execute(wf.id, {});
    expect(count).toBe(1); // Only initial execution
  });

  backEdgeTest("back-edge from downstream node to mid-graph node", async () => {
    // trigger → A → B → C → back→B
    // B and C should re-execute, A should NOT re-execute
    const execLog = [];
    const midType = (name) => {
      const t = `test.be_mid_${name}_` + Math.random().toString(36).slice(2, 8);
      registerNodeType(t, {
        describe: () => `Node ${name}`,
        schema: { type: "object", properties: {} },
        async execute(node, ctx) {
          execLog.push(name);
          ctx.data[`_${name}`] = (ctx.data[`_${name}`] || 0) + 1;
          return { ok: true };
        },
      });
      return t;
    };

    const tA = midType("A");
    const tB = midType("B");
    const tC = midType("C");

    const wf = makeWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "a", type: tA, label: "A", config: {} },
        { id: "b", type: tB, label: "B", config: {} },
        { id: "c", type: tC, label: "C", config: {} },
      ],
      [
        { id: "e1", source: "trigger", target: "a" },
        { id: "e2", source: "a", target: "b" },
        { id: "e3", source: "b", target: "c" },
        { id: "e-back", source: "c", target: "b", backEdge: true, condition: "$data._B < 2" },
      ],
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});
    expect(result.errors).toEqual([]);

    const countA = execLog.filter((n) => n === "A").length;
    const countB = execLog.filter((n) => n === "B").length;
    const countC = execLog.filter((n) => n === "C").length;
    // A runs once (not in back-edge subgraph), B and C each run twice
    expect(countA).toBe(1);
    expect(countB).toBe(2);
    expect(countC).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  transform.llm_parse NODE TYPE
// ═══════════════════════════════════════════════════════════════════════════

describe("transform.llm_parse", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  backEdgeTest("extracts fields using regex patterns", async () => {
    const sourceType = "test.parse_src_" + Math.random().toString(36).slice(2, 8);
    registerNodeType(sourceType, {
      describe: () => "Produce LLM output",
      schema: { type: "object", properties: {} },
      async execute() {
        return {
          output: "The answer is CORRECT with score: 95 and confidence: high",
        };
      },
    });

    const wf = makeWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "source", type: sourceType, label: "Source", config: {} },
        {
          id: "parse",
          type: "transform.llm_parse",
          label: "Parse",
          config: {
            input: "source",
            field: "output",
            patterns: {
              verdict: "\\b(CORRECT|INCORRECT|PARTIAL)\\b",
              score: "score:\\s*(\\d+)",
            },
          },
        },
      ],
      [
        { id: "e1", source: "trigger", target: "source" },
        { id: "e2", source: "source", target: "parse" },
      ],
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});
    expect(result.errors).toEqual([]);

    const parseOutput = result.getNodeOutput("parse");
    expect(parseOutput.parsed.verdict).toBe("CORRECT");
    expect(parseOutput.parsed.score).toBe("95");
  });

  backEdgeTest("extracts fields using keyword matching", async () => {
    const srcType = "test.parse_kw_" + Math.random().toString(36).slice(2, 8);
    registerNodeType(srcType, {
      describe: () => "Produce text",
      schema: { type: "object", properties: {} },
      async execute() {
        return { output: "The verification found a minor issue in step 3." };
      },
    });

    const wf = makeWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "src", type: srcType, label: "Source", config: {} },
        {
          id: "parse",
          type: "transform.llm_parse",
          label: "Parse",
          config: {
            input: "src",
            keywords: {
              severity: ["critical", "minor", "correct"],
            },
            outputPort: "severity",
          },
        },
      ],
      [
        { id: "e1", source: "trigger", target: "src" },
        { id: "e2", source: "src", target: "parse" },
      ],
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});
    expect(result.errors).toEqual([]);

    const parseOutput = result.getNodeOutput("parse");
    expect(parseOutput.parsed.severity).toBe("minor");
    expect(parseOutput.matchedPort).toBe("minor");
  });

  backEdgeTest("sets matchedPort from outputPort field", async () => {
    const srcType2 = "test.parse_port_" + Math.random().toString(36).slice(2, 8);
    registerNodeType(srcType2, {
      describe: () => "Verdict source",
      schema: { type: "object", properties: {} },
      async execute() {
        return { output: "VERDICT: PASS — all checks succeeded." };
      },
    });

    const wf = makeWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "src", type: srcType2, label: "Source", config: {} },
        {
          id: "parse",
          type: "transform.llm_parse",
          label: "Parse",
          config: {
            input: "src",
            patterns: { verdict: "VERDICT:\\s*(PASS|FAIL|PARTIAL)" },
            outputPort: "verdict",
          },
        },
      ],
      [
        { id: "e1", source: "trigger", target: "src" },
        { id: "e2", source: "src", target: "parse" },
      ],
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});
    const parseOutput = result.getNodeOutput("parse");
    expect(parseOutput.matchedPort).toBe("pass");
    expect(parseOutput.parsed.verdict).toBe("PASS");
  });

  backEdgeTest("handles missing patterns gracefully (null fields)", async () => {
    const srcType3 = "test.parse_miss_" + Math.random().toString(36).slice(2, 8);
    registerNodeType(srcType3, {
      describe: () => "No matching text",
      schema: { type: "object", properties: {} },
      async execute() {
        return { output: "Nothing relevant here at all." };
      },
    });

    const wf = makeWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "src", type: srcType3, label: "Source", config: {} },
        {
          id: "parse",
          type: "transform.llm_parse",
          label: "Parse",
          config: {
            input: "src",
            patterns: { score: "score:\\s*(\\d+)" },
            keywords: { severity: ["critical", "minor"] },
          },
        },
      ],
      [
        { id: "e1", source: "trigger", target: "src" },
        { id: "e2", source: "src", target: "parse" },
      ],
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});
    const parseOutput = result.getNodeOutput("parse");
    expect(parseOutput.parsed.score).toBeNull();
    expect(parseOutput.parsed.severity).toBeNull();
    expect(parseOutput.matchedPort).toBe("default");
  });

  backEdgeTest("routes downstream via matchedPort + source port edges", async () => {
    const srcType4 = "test.parse_route_src_" + Math.random().toString(36).slice(2, 8);
    registerNodeType(srcType4, {
      describe: () => "Source",
      schema: { type: "object", properties: {} },
      async execute() {
        return { output: "The result is CRITICAL — fundamental flaw detected." };
      },
    });

    const visited = [];
    const branchType = "test.parse_route_branch_" + Math.random().toString(36).slice(2, 8);
    registerNodeType(branchType, {
      describe: () => "Branch marker",
      schema: { type: "object", properties: {} },
      async execute(node) { visited.push(node.id); return {}; },
    });

    const wf = makeWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "src", type: srcType4, label: "Source", config: {} },
        {
          id: "parse",
          type: "transform.llm_parse",
          label: "Parse",
          config: {
            input: "src",
            keywords: { severity: ["critical", "minor", "correct"] },
            outputPort: "severity",
          },
        },
        { id: "correct-branch", type: branchType, label: "Correct", config: {} },
        { id: "minor-branch", type: branchType, label: "Minor", config: {} },
        { id: "critical-branch", type: branchType, label: "Critical", config: {} },
      ],
      [
        { id: "e1", source: "trigger", target: "src" },
        { id: "e2", source: "src", target: "parse" },
        { id: "e3", source: "parse", target: "correct-branch", sourcePort: "correct" },
        { id: "e4", source: "parse", target: "minor-branch", sourcePort: "minor" },
        { id: "e5", source: "parse", target: "critical-branch", sourcePort: "critical" },
      ],
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});
    expect(result.errors).toEqual([]);
    expect(visited).toEqual(["critical-branch"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  loop.while NODE TYPE
// ═══════════════════════════════════════════════════════════════════════════

describe("loop.while", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  backEdgeTest("executes without sub-workflow (condition-only mode)", async () => {
    // loop.while with no workflowId — just evaluates condition each iteration
    let iterations = 0;

    // We need the while loop to depend on context data modified externally
    // In no-subworkflow mode it loops, incrementing _iteration in loopState
    const wf = makeWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "loop",
          type: "loop.while",
          label: "While",
          config: {
            condition: "$iteration < 4",
            maxIterations: 10,
          },
        },
      ],
      [
        { id: "e1", source: "trigger", target: "loop" },
      ],
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});
    expect(result.errors).toEqual([]);

    const loopOutput = result.getNodeOutput("loop");
    expect(loopOutput.converged).toBe(true);
    expect(loopOutput.iterations).toBe(5); // iterations 0,1,2,3 continue; iteration 4 stops
  });

  backEdgeTest("respects maxIterations cap", async () => {
    const wf = makeWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "loop",
          type: "loop.while",
          label: "While",
          config: {
            condition: "true", // always continue
            maxIterations: 3,
          },
        },
      ],
      [
        { id: "e1", source: "trigger", target: "loop" },
      ],
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});
    const loopOutput = result.getNodeOutput("loop");
    expect(loopOutput.iterations).toBe(3);
    expect(loopOutput.converged).toBe(false);
  });

  backEdgeTest("returns converged=true when condition evaluates to false", async () => {
    const wf = makeWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "loop",
          type: "loop.while",
          label: "While",
          config: {
            condition: "$iteration < 2",
            maxIterations: 100,
          },
        },
      ],
      [
        { id: "e1", source: "trigger", target: "loop" },
      ],
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});
    const loopOutput = result.getNodeOutput("loop");
    expect(loopOutput.converged).toBe(true);
    expect(loopOutput.iterations).toBe(3); // 0,1 continue, 2 stops
  });

  backEdgeTest("handles condition evaluation errors gracefully (stops loop)", async () => {
    const wf = makeWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "loop",
          type: "loop.while",
          label: "While",
          config: {
            condition: "undefinedVar.foo.bar", // will throw
            maxIterations: 10,
          },
        },
      ],
      [
        { id: "e1", source: "trigger", target: "loop" },
      ],
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});
    const loopOutput = result.getNodeOutput("loop");
    // Should stop immediately (converged=true due to error) after 1 iteration
    expect(loopOutput.converged).toBe(true);
    expect(loopOutput.iterations).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  action.web_search NODE TYPE
// ═══════════════════════════════════════════════════════════════════════════

describe("action.web_search", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  backEdgeTest("throws when query is empty", async () => {
    const wf = makeWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "search", type: "action.web_search", label: "Search", config: { query: "", maxRetries: 0 } },
      ],
      [{ id: "e1", source: "trigger", target: "search" }],
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});
    expect(result.errors.length).toBeGreaterThan(0);
  });

  backEdgeTest("returns results structure with fetch engine (may fail network)", async () => {
    // This test validates the output shape even if fetch fails
    const wf = makeWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "search",
          type: "action.web_search",
          label: "Search",
          config: {
            query: "test query for validation",
            maxResults: 3,
            engine: "fetch",
            // Ensure deterministic, fast failure in CI/offline environments.
            apiUrl: "http://127.0.0.1:1/unreachable-search-endpoint",
          },
        },
      ],
      [{ id: "e1", source: "trigger", target: "search" }],
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});
    const searchOutput = result.getNodeOutput("search");
    // Even if network fails, should have the expected shape
    expect(searchOutput).toBeDefined();
    expect(searchOutput.engine).toBe("fetch");
    expect(searchOutput.query).toBe("test query for validation");
    expect(Array.isArray(searchOutput.results)).toBe(true);
    expect(typeof searchOutput.resultCount).toBe("number");
  });

  backEdgeTest("resolves template variables in query", async () => {
    const wf = makeWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        {
          id: "search",
          type: "action.web_search",
          label: "Search",
          config: {
            query: "{{searchTerm}} proof verification",
            maxResults: 1,
            engine: "fetch",
            // Avoid external network flakiness while still exercising template resolution.
            apiUrl: "http://127.0.0.1:1/unreachable-search-endpoint",
          },
        },
      ],
      [{ id: "e1", source: "trigger", target: "search" }],
      { variables: { searchTerm: "Riemann hypothesis" } },
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});
    const searchOutput = result.getNodeOutput("search");
    expect(searchOutput.query).toBe("Riemann hypothesis proof verification");
  });

  backEdgeTest("decodes HTML entities only once when flattening web results", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => {
      const parsedUrl = new URL(String(url));
      if (parsedUrl.hostname === "api.duckduckgo.com") {
        return {
          ok: true,
          async json() {
            return {
              RelatedTopics: [
                {
                  Text: "Encoded result",
                  FirstURL: "https://example.com/encoded",
                },
              ],
            };
          },
        };
      }

      return {
        ok: true,
        async text() {
          return '<article><p>&amp;lt;safe&amp;gt; &amp;amp; sound</p></article>';
        },
      };
    });

    try {
      const wf = makeWorkflow(
        [
          { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
          {
            id: "search",
            type: "action.web_search",
            label: "Search",
            config: {
              query: "encoded result",
              maxResults: 1,
              engine: "fetch",
              extractContent: true,
            },
          },
        ],
        [{ id: "e1", source: "trigger", target: "search" }],
      );

      engine.save(wf);
      const result = await engine.execute(wf.id, {});
      const searchOutput = result.getNodeOutput("search");
      expect(searchOutput.results?.[0]?.content).toContain("&lt;safe&gt; &amp; sound");
      expect(searchOutput.results?.[0]?.content).not.toContain("<safe>");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  backEdgeTest("extracts plain text content without preserving script or style payloads", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => {
      const parsedUrl = new URL(String(url));
      if (parsedUrl.hostname === "api.duckduckgo.com") {
        return {
          ok: true,
          async json() {
            return {
              RelatedTopics: [
                {
                  Text: "Example result",
                  FirstURL: "https://example.com/article",
                },
              ],
            };
          },
        };
      }

      return {
        ok: true,
        async text() {
          return '<html><body><h1>Headline</h1><script >alert(1)</script><style>body{color:red}</style><p>Body &amp; copy</p></body></html>';
        },
      };
    });

    try {
      const wf = makeWorkflow(
        [
          { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
          {
            id: "search",
            type: "action.web_search",
            label: "Search",
            config: {
              query: "safe extraction",
              maxResults: 1,
              engine: "fetch",
              extractContent: true,
            },
          },
        ],
        [{ id: "e1", source: "trigger", target: "search" }],
      );

      engine.save(wf);
      const result = await engine.execute(wf.id, {});
      const searchOutput = result.getNodeOutput("search");
      expect(searchOutput.results[0].content).toContain("Headline");
      expect(searchOutput.results[0].content).toContain("Body & copy");
      expect(searchOutput.results[0].content).not.toContain("alert(1)");
      expect(searchOutput.results[0].content).not.toContain("color:red");
      expect(searchOutput.results[0].content).not.toContain("<script");
      expect(searchOutput.results[0].content).not.toContain("<style");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  INTEGRATED BACK-EDGE + LLM PARSE (Aletheia pattern)
// ═══════════════════════════════════════════════════════════════════════════

describe("Aletheia pattern - back-edge + llm_parse routing", () => {
  beforeEach(() => { makeTmpEngine(); });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  backEdgeTest("generate→parse→branch→revise loop with back-edge", async () => {
    // Simulates: generator → parse verdict → branch (correct/minor)
    // minor → reviser → back-edge to generator
    // correct → output
    const execLog = [];
    let genCount = 0;

    const genType = "test.aletheia_gen_" + Math.random().toString(36).slice(2, 8);
    registerNodeType(genType, {
      describe: () => "Generator",
      schema: { type: "object", properties: {} },
      async execute(node, ctx) {
        genCount++;
        execLog.push(`gen:${genCount}`);
        // First generation has minor issue, second is correct
        const verdictText = genCount >= 2
          ? "VERDICT: correct — proof is valid"
          : "VERDICT: minor — step 3 needs refinement";
        return { output: verdictText };
      },
    });

    const reviseType = "test.aletheia_revise_" + Math.random().toString(36).slice(2, 8);
    registerNodeType(reviseType, {
      describe: () => "Reviser",
      schema: { type: "object", properties: {} },
      async execute(node, ctx) {
        execLog.push("revise");
        return { output: "revised proof with corrections" };
      },
    });

    const outputType = "test.aletheia_out_" + Math.random().toString(36).slice(2, 8);
    registerNodeType(outputType, {
      describe: () => "Output",
      schema: { type: "object", properties: {} },
      async execute(node) {
        execLog.push("output");
        return { final: true };
      },
    });

    const wf = makeWorkflow(
      [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        { id: "gen", type: genType, label: "Generator", config: {} },
        {
          id: "parse",
          type: "transform.llm_parse",
          label: "Parse Verdict",
          config: {
            input: "gen",
            keywords: { verdict: ["correct", "minor", "critical"] },
            outputPort: "verdict",
          },
        },
        { id: "revise", type: reviseType, label: "Reviser", config: {} },
        { id: "out", type: outputType, label: "Output", config: {} },
      ],
      [
        { id: "e1", source: "trigger", target: "gen" },
        { id: "e2", source: "gen", target: "parse" },
        { id: "e3", source: "parse", target: "out", sourcePort: "correct" },
        { id: "e4", source: "parse", target: "revise", sourcePort: "minor" },
        // Back-edge: revise → gen (loop back for another attempt)
        { id: "e-back", source: "revise", target: "gen", backEdge: true },
      ],
    );

    engine.save(wf);
    const result = await engine.execute(wf.id, {});
    expect(result.errors).toEqual([]);

    // Expected order: gen:1 → parse → revise → [back-edge] → gen:2 → parse → output
    expect(execLog).toContain("gen:1");
    expect(execLog).toContain("revise");
    expect(execLog).toContain("gen:2");
    expect(execLog).toContain("output");
    expect(genCount).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  RESEARCH TEMPLATE STRUCTURAL VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

describe("Research template registration", () => {
  it("RESEARCH_AGENT_TEMPLATE is in WORKFLOW_TEMPLATES", () => {
    const tpl = WORKFLOW_TEMPLATES.find((t) => t.id === "template-research-agent");
    expect(tpl).toBeDefined();
    expect(tpl.name).toContain("Research");
    expect(tpl.category).toBe("research");
  });

  it("research category exists in TEMPLATE_CATEGORIES", () => {
    expect(TEMPLATE_CATEGORIES.research).toBeDefined();
    expect(TEMPLATE_CATEGORIES.research.label).toBe("Research");
  });

  it("template has valid node/edge structure", () => {
    const tpl = WORKFLOW_TEMPLATES.find((t) => t.id === "template-research-agent");
    expect(tpl.nodes.length).toBeGreaterThan(0);
    expect(tpl.edges.length).toBeGreaterThan(0);

    const nodeIds = new Set(tpl.nodes.map((n) => n.id));
    // All edges reference valid nodes
    for (const edge of tpl.edges) {
      expect(nodeIds.has(edge.source)).toBe(true);
      expect(nodeIds.has(edge.target)).toBe(true);
    }
  });

  it("template has back-edges for convergence loops", () => {
    const tpl = WORKFLOW_TEMPLATES.find((t) => t.id === "template-research-agent");
    const backEdges = tpl.edges.filter((e) => e.backEdge === true);
    expect(backEdges.length).toBeGreaterThan(0);
  });

  it("template uses the new node types", () => {
    const tpl = WORKFLOW_TEMPLATES.find((t) => t.id === "template-research-agent");
    const nodeTypes = new Set(tpl.nodes.map((n) => n.type));
    expect(nodeTypes.has("transform.llm_parse")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  EDGE HELPER — backEdge support
// ═══════════════════════════════════════════════════════════════════════════

describe("Edge helper backEdge support", () => {
  it("edge() helper creates edges with backEdge property", async () => {
    const { edge } = await import("../workflow-templates/_helpers.mjs");
    const e = edge("a", "b", { backEdge: true, label: "loop back" });
    expect(e.backEdge).toBe(true);
    expect(e.label).toBe("loop back");
    expect(e.source).toBe("a");
    expect(e.target).toBe("b");
    expect(e.id).toBeDefined();
  });

  it("edge() helper omits backEdge when not specified", async () => {
    const { edge } = await import("../workflow-templates/_helpers.mjs");
    const e = edge("x", "y");
    expect(e.backEdge).toBeUndefined();
    expect(e.label).toBeUndefined();
  });
});


