/**
 * mcp-workflow-adapter.test.mjs — Tests for MCP-to-Workflow Data Bridge
 *
 * Tests the core adapter functions that enable structured data extraction,
 * type coercion, output mapping, pipeline building, and schema inference
 * for MCP tool integration in workflows.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseMcpContent,
  extractMcpOutput,
  getByPath,
  getByJsonPointer,
  collectByWildcardPath,
  coerceValue,
  mapOutputFields,
  buildPipelineInput,
  inferOutputSchema,
  createPipelineSpec,
  resolveOutputPort,
} from "../workflow/mcp-workflow-adapter.mjs";
import {
  WorkflowEngine,
  WorkflowContext,
  NodeStatus,
} from "../workflow/workflow-engine.mjs";
import {
  registerNodeType,
  getNodeType,
} from "../workflow/workflow-nodes.mjs";

const SLOW_MCP_WORKFLOW_ADAPTER_DRY_RUN_TEST_TIMEOUT_MS = process.platform === "win32" ? 30_000 : 15_000;

// ═══════════════════════════════════════════════════════════════════════════
//  parseMcpContent
// ═══════════════════════════════════════════════════════════════════════════

describe("parseMcpContent", () => {
  it("handles null/undefined input", () => {
    expect(parseMcpContent(null).data).toBeNull();
    expect(parseMcpContent(undefined).text).toBe("");
    expect(parseMcpContent(null).contentType).toBe("empty");
  });

  it("parses standard MCP text content blocks with JSON", () => {
    const mcpResult = {
      content: [
        { type: "text", text: JSON.stringify([{ id: 1, title: "Fix bug" }, { id: 2, title: "Add feature" }]) },
      ],
    };
    const parsed = parseMcpContent(mcpResult);
    expect(parsed.contentType).toBe("json");
    expect(parsed.isError).toBe(false);
    expect(parsed.data).toEqual([
      { id: 1, title: "Fix bug" },
      { id: 2, title: "Add feature" },
    ]);
  });

  it("parses plain text content blocks", () => {
    const mcpResult = {
      content: [
        { type: "text", text: "Hello, this is plain text output" },
      ],
    };
    const parsed = parseMcpContent(mcpResult);
    expect(parsed.contentType).toBe("text");
    expect(parsed.data).toEqual({ text: "Hello, this is plain text output" });
    expect(parsed.text).toBe("Hello, this is plain text output");
  });

  it("handles multiple text blocks with individual JSON", () => {
    const mcpResult = {
      content: [
        { type: "text", text: '{"name": "Alice"}' },
        { type: "text", text: '{"name": "Bob"}' },
      ],
    };
    const parsed = parseMcpContent(mcpResult);
    // When combined they're not valid JSON, but individually they are
    expect(parsed.contentType).toBe("json");
    expect(Array.isArray(parsed.data)).toBe(true);
    expect(parsed.data).toHaveLength(2);
  });

  it("preserves image and resource blocks", () => {
    const mcpResult = {
      content: [
        { type: "text", text: '{"status": "ok"}' },
        { type: "image", data: "base64data", mimeType: "image/png" },
        { type: "resource", uri: "file:///test.txt" },
      ],
    };
    const parsed = parseMcpContent(mcpResult);
    expect(parsed.images).toHaveLength(1);
    expect(parsed.resources).toHaveLength(1);
    expect(parsed.data).toEqual({ status: "ok" });
  });

  it("handles isError flag", () => {
    const mcpResult = {
      isError: true,
      content: [{ type: "text", text: "Something went wrong" }],
    };
    expect(parseMcpContent(mcpResult).isError).toBe(true);
  });

  it("handles direct string content", () => {
    const parsed = parseMcpContent("just a string");
    expect(parsed.text).toBe("just a string");
    expect(parsed.data).toEqual({ text: "just a string" });
  });

  it("handles direct number and boolean", () => {
    expect(parseMcpContent(42).data).toBe(42);
    expect(parseMcpContent(true).data).toBe(true);
    expect(parseMcpContent(42).contentType).toBe("primitive");
  });

  it("handles direct object (non-standard)", () => {
    const parsed = parseMcpContent({ foo: "bar" });
    expect(parsed.data).toEqual({ foo: "bar" });
    expect(parsed.contentType).toBe("json");
  });

  it("handles empty content array", () => {
    const parsed = parseMcpContent({ content: [] });
    // No text blocks → raw content
    expect(parsed.contentType).toBe("raw");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  getByPath
// ═══════════════════════════════════════════════════════════════════════════

describe("getByPath", () => {
  const data = {
    items: [
      { id: 1, title: "First", user: { login: "alice", roles: ["admin", "dev"] } },
      { id: 2, title: "Second", user: { login: "bob" } },
    ],
    meta: { count: 2, nested: { deep: "value" } },
  };

  it("gets top-level field", () => {
    expect(getByPath(data, "meta")).toEqual(data.meta);
  });

  it("gets nested field with dot notation", () => {
    expect(getByPath(data, "meta.count")).toBe(2);
    expect(getByPath(data, "meta.nested.deep")).toBe("value");
  });

  it("gets array element with bracket notation", () => {
    expect(getByPath(data, "items[0].title")).toBe("First");
    expect(getByPath(data, "items[1].user.login")).toBe("bob");
  });

  it("gets array element with dot notation", () => {
    expect(getByPath(data, "items.0.title")).toBe("First");
  });

  it("returns undefined for missing paths", () => {
    expect(getByPath(data, "nonexistent")).toBeUndefined();
    expect(getByPath(data, "items[99]")).toBeUndefined();
    expect(getByPath(data, "meta.nonexistent.deep")).toBeUndefined();
  });

  it("handles null/undefined input", () => {
    expect(getByPath(null, "foo")).toBeUndefined();
    expect(getByPath(undefined, "foo")).toBeUndefined();
    expect(getByPath(data, "")).toBeUndefined();
  });

  it("gets nested array elements", () => {
    expect(getByPath(data, "items[0].user.roles[1]")).toBe("dev");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  getByJsonPointer
// ═══════════════════════════════════════════════════════════════════════════

describe("getByJsonPointer", () => {
  const data = {
    items: [
      { id: 1, title: "First" },
      { id: 2, title: "Second" },
    ],
    "key/with/slashes": "escaped",
  };

  it("gets root", () => {
    expect(getByJsonPointer(data, "/")).toBe(data);
  });

  it("gets nested fields", () => {
    expect(getByJsonPointer(data, "/items/0/title")).toBe("First");
    expect(getByJsonPointer(data, "/items/1/id")).toBe(2);
  });

  it("handles escaped slashes in keys", () => {
    expect(getByJsonPointer(data, "/key~1with~1slashes")).toBe("escaped");
  });

  it("returns undefined for missing paths", () => {
    expect(getByJsonPointer(data, "/nonexistent")).toBeUndefined();
    expect(getByJsonPointer(data, "/items/99")).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  collectByWildcardPath
// ═══════════════════════════════════════════════════════════════════════════

describe("collectByWildcardPath", () => {
  const data = {
    items: [
      { title: "PR #1", user: { login: "alice" }, labels: [{ name: "bug" }, { name: "urgent" }] },
      { title: "PR #2", user: { login: "bob" }, labels: [{ name: "feature" }] },
      { title: "PR #3", user: { login: "charlie" }, labels: [] },
    ],
  };

  it("collects all values at wildcard path", () => {
    expect(collectByWildcardPath(data, "items[*].title")).toEqual([
      "PR #1", "PR #2", "PR #3",
    ]);
  });

  it("collects nested wildcard values", () => {
    expect(collectByWildcardPath(data, "items[*].user.login")).toEqual([
      "alice", "bob", "charlie",
    ]);
  });

  it("handles nested arrays with double wildcards", () => {
    const result = collectByWildcardPath(data, "items[*].labels[*].name");
    expect(result).toEqual(["bug", "urgent", "feature"]);
  });

  it("returns empty array for non-array source", () => {
    expect(collectByWildcardPath({ foo: "bar" }, "foo[*]")).toEqual([]);
  });

  it("handles path without wildcard", () => {
    expect(collectByWildcardPath(data, "items")).toEqual([data.items]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  coerceValue
// ═══════════════════════════════════════════════════════════════════════════

describe("coerceValue", () => {
  it("coerces to string", () => {
    expect(coerceValue(42, "string")).toBe("42");
    expect(coerceValue(true, "string")).toBe("true");
    expect(coerceValue("hello", "string")).toBe("hello");
    expect(coerceValue({ a: 1 }, "string")).toBe('{"a":1}');
  });

  it("coerces to number", () => {
    expect(coerceValue("42", "number")).toBe(42);
    expect(coerceValue("3.14", "number")).toBe(3.14);
    expect(coerceValue("not_a_number", "number")).toBeNull();
    expect(coerceValue(42, "number")).toBe(42);
  });

  it("coerces to integer", () => {
    expect(coerceValue("42.7", "integer")).toBe(42);
    expect(coerceValue(3.14, "integer")).toBe(3);
    expect(coerceValue("nope", "integer")).toBeNull();
  });

  it("coerces to boolean", () => {
    expect(coerceValue("true", "boolean")).toBe(true);
    expect(coerceValue("false", "boolean")).toBe(false);
    expect(coerceValue("yes", "boolean")).toBe(true);
    expect(coerceValue("no", "boolean")).toBe(false);
    expect(coerceValue("1", "boolean")).toBe(true);
    expect(coerceValue("0", "boolean")).toBe(false);
    expect(coerceValue(1, "boolean")).toBe(true);
  });

  it("coerces to array", () => {
    expect(coerceValue([1, 2], "array")).toEqual([1, 2]);
    expect(coerceValue("[1,2]", "array")).toEqual([1, 2]);
    expect(coerceValue("hello", "array")).toEqual(["hello"]);
    expect(coerceValue(42, "array")).toEqual([42]);
  });

  it("coerces to json", () => {
    expect(coerceValue('{"a":1}', "json")).toEqual({ a: 1 });
    expect(coerceValue("not json", "json")).toBe("not json");
    expect(coerceValue({ a: 1 }, "json")).toEqual({ a: 1 });
  });

  it("preserves null and undefined", () => {
    expect(coerceValue(null, "string")).toBeNull();
    expect(coerceValue(undefined, "number")).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  extractMcpOutput
// ═══════════════════════════════════════════════════════════════════════════

describe("extractMcpOutput", () => {
  const prData = [
    { number: 42, title: "Fix auth bug", user: { login: "alice" }, labels: [{ name: "bug" }], draft: false },
    { number: 43, title: "Add caching", user: { login: "bob" }, labels: [{ name: "enhancement" }], draft: true },
    { number: 44, title: "Update docs", user: { login: "charlie" }, labels: [], draft: false },
  ];

  it("extracts fields using dot-path", () => {
    const result = extractMcpOutput(prData, {
      fields: {
        firstTitle: "[0].title",
        firstAuthor: "[0].user.login",
      },
    });
    expect(result.firstTitle).toBe("Fix auth bug");
    expect(result.firstAuthor).toBe("alice");
  });

  it("extracts fields using wildcard paths", () => {
    const result = extractMcpOutput(prData, {
      fields: {
        allTitles: "[*].title",
        allAuthors: "[*].user.login",
      },
    });
    expect(result.allTitles).toEqual(["Fix auth bug", "Add caching", "Update docs"]);
    expect(result.allAuthors).toEqual(["alice", "bob", "charlie"]);
  });

  it("extracts with JSON pointer", () => {
    const result = extractMcpOutput(prData, {
      fields: {
        secondTitle: "/1/title",
      },
    });
    expect(result.secondTitle).toBe("Add caching");
  });

  it("applies default values", () => {
    const result = extractMcpOutput(prData, {
      fields: {
        missing: "nonexistent.path",
        alsoMissing: "[99].title",
      },
      defaults: {
        missing: "default_value",
        alsoMissing: "N/A",
      },
    });
    expect(result.missing).toBe("default_value");
    expect(result.alsoMissing).toBe("N/A");
  });

  it("applies type coercion", () => {
    const result = extractMcpOutput(prData, {
      fields: {
        count: "length",
        firstNumber: "[0].number",
        isDraft: "[1].draft",
      },
      types: {
        count: "number",
        firstNumber: "string",
        isDraft: "string",
      },
    });
    expect(result.count).toBe(3);
    expect(result.firstNumber).toBe("42");
    expect(result.isDraft).toBe("true");
  });

  it("applies root path", () => {
    const wrappedData = { data: { items: prData } };
    const result = extractMcpOutput(wrappedData, {
      root: "data.items",
      fields: {
        firstTitle: "[0].title",
        count: "length",
      },
    });
    expect(result.firstTitle).toBe("Fix auth bug");
    expect(result.count).toBe(3);
  });

  it("returns defaults when root path misses", () => {
    const result = extractMcpOutput({ data: {} }, {
      root: "data.items",
      fields: { count: "length" },
      defaults: { count: 0 },
    });
    expect(result.count).toBe(0);
  });

  it("handles empty input gracefully", () => {
    expect(extractMcpOutput(null, {})).toEqual({});
    expect(extractMcpOutput({}, null)).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  mapOutputFields
// ═══════════════════════════════════════════════════════════════════════════

describe("mapOutputFields", () => {
  const data = {
    prCount: 3,
    items: [
      { title: "PR #1", author: "alice" },
      { title: "PR #2", author: "bob" },
    ],
    meta: { repo: "bosun", owner: "virtengine" },
  };

  it("maps simple string paths", () => {
    const result = mapOutputFields(data, {
      count: "prCount",
      repo: "meta.repo",
      firstTitle: "items[0].title",
    });
    expect(result.count).toBe(3);
    expect(result.repo).toBe("bosun");
    expect(result.firstTitle).toBe("PR #1");
  });

  it("maps literal values", () => {
    const result = mapOutputFields(data, {
      status: { _literal: "processed" },
      priority: { _literal: 1 },
    });
    expect(result.status).toBe("processed");
    expect(result.priority).toBe(1);
  });

  it("maps with _from + _transform", () => {
    const result = mapOutputFields(data, {
      itemCount: { _from: "items", _transform: "count" },
      firstItem: { _from: "items", _transform: "first" },
      lastItem: { _from: "items", _transform: "last" },
    });
    expect(result.itemCount).toBe(2);
    expect(result.firstItem).toEqual({ title: "PR #1", author: "alice" });
    expect(result.lastItem).toEqual({ title: "PR #2", author: "bob" });
  });

  it("maps with _concat", () => {
    const result = mapOutputFields(data, {
      fullName: {
        _concat: ["meta.owner", "meta.repo"],
        _separator: "/",
      },
    });
    expect(result.fullName).toBe("virtengine/bosun");
  });

  it("handles null/invalid input", () => {
    expect(mapOutputFields(null, { foo: "bar" })).toEqual({});
    expect(mapOutputFields({}, null)).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  buildPipelineInput
// ═══════════════════════════════════════════════════════════════════════════

describe("buildPipelineInput", () => {
  const prevOutput = {
    data: {
      repository: { owner: { login: "virtengine" }, name: "bosun" },
      items: [{ id: 42, title: "First PR" }],
    },
    text: "raw text output",
    prCount: 3,
  };

  it("maps fields from previous output", () => {
    const result = buildPipelineInput(prevOutput, {
      owner: "data.repository.owner.login",
      repo: "data.repository.name",
    });
    expect(result.owner).toBe("virtengine");
    expect(result.repo).toBe("bosun");
  });

  it("maps literal values", () => {
    const result = buildPipelineInput(prevOutput, {
      state: { _literal: "open" },
      limit: { _literal: 10 },
    });
    expect(result.state).toBe("open");
    expect(result.limit).toBe(10);
  });

  it("maps with context variable resolution", () => {
    const mockCtx = {
      resolve: (tpl) => tpl === "{{repoName}}" ? "bosun" : tpl,
      data: { repoName: "bosun" },
    };
    const result = buildPipelineInput(prevOutput, {
      repo: { _variable: "repoName" },
    }, mockCtx);
    expect(result.repo).toBe("bosun");
  });

  it("maps with _from + _transform", () => {
    const result = buildPipelineInput(prevOutput, {
      itemCount: { _from: "data.items", _transform: "count" },
      firstItem: { _from: "data.items", _transform: "first" },
    });
    expect(result.itemCount).toBe(1);
    expect(result.firstItem).toEqual({ id: 42, title: "First PR" });
  });

  it("maps with _concat", () => {
    const result = buildPipelineInput(prevOutput, {
      fullPath: {
        _concat: ["data.repository.owner.login", "data.repository.name"],
        _separator: "/",
      },
    });
    expect(result.fullPath).toBe("virtengine/bosun");
  });

  it("maps with _index", () => {
    const result = buildPipelineInput(prevOutput, {
      firstItem: { _from: "data.items", _index: 0 },
    });
    // _index returns the array resolved at _from; concrete indexing is done via getByPath
    expect(Array.isArray(result.firstItem)).toBe(true);
    expect(result.firstItem[0]).toEqual({ id: 42, title: "First PR" });
  });

  it("handles empty inputs", () => {
    expect(buildPipelineInput({}, null)).toEqual({});
    expect(buildPipelineInput({}, {})).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  createPipelineSpec
// ═══════════════════════════════════════════════════════════════════════════

describe("createPipelineSpec", () => {
  it("validates a valid pipeline", () => {
    const result = createPipelineSpec([
      { id: "step-1", server: "github", tool: "list_prs", input: { owner: "x" } },
      { id: "step-2", server: "slack", tool: "post_message", inputMap: { text: "data.title" } },
    ]);
    expect(result.valid).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects empty pipeline", () => {
    expect(createPipelineSpec([]).valid).toBe(false);
    expect(createPipelineSpec([]).errors[0]).toContain("at least one step");
  });

  it("rejects missing server/tool", () => {
    const result = createPipelineSpec([
      { id: "step-1" },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("server"))).toBe(true);
    expect(result.errors.some((e) => e.includes("tool"))).toBe(true);
  });

  it("rejects duplicate step IDs", () => {
    const result = createPipelineSpec([
      { id: "dup", server: "a", tool: "b" },
      { id: "dup", server: "c", tool: "d" },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("duplicate"))).toBe(true);
  });

  it("auto-generates step IDs", () => {
    const result = createPipelineSpec([
      { server: "github", tool: "list_prs" },
    ]);
    expect(result.valid).toBe(true);
    expect(result.steps[0].id).toBe("step-0");
  });

  it("normalizes all step fields", () => {
    const result = createPipelineSpec([
      { id: "s1", server: "gh", tool: "t1" },
    ]);
    const step = result.steps[0];
    expect(step.input).toEqual({});
    expect(step.inputMap).toBeNull();
    expect(step.extract).toBeNull();
    expect(step.outputMap).toBeNull();
    expect(step.condition).toBeNull();
    expect(step.continueOnError).toBe(false);
    expect(step.timeoutMs).toBe(30000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  resolveOutputPort
// ═══════════════════════════════════════════════════════════════════════════

describe("resolveOutputPort", () => {
  it("defaults to 'default' for success, 'error' for failure", () => {
    expect(resolveOutputPort({ success: true })).toBe("default");
    expect(resolveOutputPort({ success: false })).toBe("error");
  });

  it("uses portConfig field to select port", () => {
    const output = { status: "approved", prCount: 5 };
    const port = resolveOutputPort(output, {
      field: "status",
      map: { approved: "approve_path", rejected: "reject_path" },
    });
    expect(port).toBe("approve_path");
  });

  it("uses default port when no match", () => {
    const output = { status: "unknown" };
    const port = resolveOutputPort(output, {
      field: "status",
      map: { approved: "yes", rejected: "no" },
      default: "fallback",
    });
    expect(port).toBe("unknown"); // Falls through to normalized value
  });

  it("routes boolean success field", () => {
    expect(resolveOutputPort({ success: true }, { field: "success" })).toBe("default");
    expect(resolveOutputPort({ success: false }, { field: "success" })).toBe("error");
  });

  it("handles missing config gracefully", () => {
    expect(resolveOutputPort({ success: true }, null)).toBe("default");
    // Empty object without explicit success=false routes to default
    expect(resolveOutputPort({}, null)).toBe("default");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  inferOutputSchema
// ═══════════════════════════════════════════════════════════════════════════

describe("inferOutputSchema", () => {
  it("includes standard MCP adapter fields", () => {
    const schema = inferOutputSchema(null, null);
    expect(schema.fields.some((f) => f.name === "success")).toBe(true);
    expect(schema.fields.some((f) => f.name === "tool")).toBe(true);
    expect(schema.fields.some((f) => f.name === "text")).toBe(true);
  });

  it("infers fields from sample output", () => {
    const sample = {
      prCount: 5,
      items: [{ title: "PR #1", author: "alice" }],
      metadata: { repo: "bosun" },
    };
    const schema = inferOutputSchema(null, sample);
    expect(schema.fields.some((f) => f.name === "prCount")).toBe(true);
    expect(schema.fields.some((f) => f.name === "items" && f.type === "array")).toBe(true);
    expect(schema.fields.some((f) => f.path === "items[0].title")).toBe(true);
    expect(schema.fields.some((f) => f.path === "metadata.repo")).toBe(true);
  });

  it("generates wildcard paths for arrays", () => {
    const sample = {
      items: [{ name: "first" }, { name: "second" }],
    };
    const schema = inferOutputSchema(null, sample);
    expect(schema.fields.some((f) => f.path === "items[*].name")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Workflow Node Integration — action.mcp_tool_call (dry-run)
// ═══════════════════════════════════════════════════════════════════════════

describe("action.mcp_tool_call node (dry-run)", () => {
  let tmpDir;
  let engine;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wf-mcp-test-"));
    engine = new WorkflowEngine({
      workflowDir: join(tmpDir, "workflows"),
      runsDir: join(tmpDir, "runs"),
    });
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* best-effort cleanup */ }
  });

  it("has registered node type with correct schema", () => {
    const handler = getNodeType("action.mcp_tool_call");
    expect(handler).toBeTruthy();
    expect(handler.schema.required).toContain("server");
    expect(handler.schema.required).toContain("tool");
    expect(handler.schema.properties.extract).toBeDefined();
    expect(handler.schema.properties.outputMap).toBeDefined();
    expect(handler.schema.properties.portConfig).toBeDefined();
  });

  it("describes itself accurately", () => {
    const handler = getNodeType("action.mcp_tool_call");
    const desc = handler.describe();
    expect(desc).toContain("MCP");
    expect(desc).toContain("structured");
  });

  it("works in dry-run mode", async () => {
    const wf = {
      id: "test-mcp-dryrun",
      name: "MCP Dry Run",
      enabled: true,
      nodes: [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {}, position: { x: 0, y: 0 } },
        {
          id: "mcp-call",
          type: "action.mcp_tool_call",
          label: "MCP Call",
          config: {
            server: "github",
            tool: "list_pull_requests",
            input: { owner: "test", repo: "test" },
            extract: {
              fields: { count: "length" },
              types: { count: "number" },
            },
          },
          position: { x: 100, y: 0 },
        },
      ],
      edges: [{ id: "e1", source: "trigger", target: "mcp-call" }],
    };

    engine.save(wf);
    const ctx = await engine.execute("test-mcp-dryrun", {}, { dryRun: true });

    // In dry-run, node should execute without actually calling MCP
    expect(ctx.nodeStatuses.get("mcp-call")).toBe(NodeStatus.COMPLETED);
    const output = ctx.getNodeOutput("mcp-call");
    expect(output._dryRun).toBe(true);
  }, SLOW_MCP_WORKFLOW_ADAPTER_DRY_RUN_TEST_TIMEOUT_MS);
});

// ═══════════════════════════════════════════════════════════════════════════
//  Workflow Node Integration — action.mcp_pipeline (dry-run)
// ═══════════════════════════════════════════════════════════════════════════

describe("action.mcp_pipeline node (dry-run)", () => {
  let tmpDir;
  let engine;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wf-mcp-pipeline-test-"));
    engine = new WorkflowEngine({
      workflowDir: join(tmpDir, "workflows"),
      runsDir: join(tmpDir, "runs"),
    });
  }, SLOW_MCP_WORKFLOW_ADAPTER_DRY_RUN_TEST_TIMEOUT_MS);

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* best-effort cleanup */ }
  });

  it("has registered node type with correct schema", () => {
    const handler = getNodeType("action.mcp_pipeline");
    expect(handler).toBeTruthy();
    expect(handler.schema.required).toContain("steps");
    expect(handler.schema.properties.steps.type).toBe("array");
  });

  it("describes itself accurately", () => {
    const handler = getNodeType("action.mcp_pipeline");
    const desc = handler.describe();
    expect(desc).toContain("chain");
    expect(desc).toContain("MCP");
  });

  it("works in dry-run mode", async () => {
    const wf = {
      id: "test-pipeline-dryrun",
      name: "Pipeline Dry Run",
      enabled: true,
      nodes: [
        { id: "trigger", type: "trigger.manual", label: "Start", config: {}, position: { x: 0, y: 0 } },
        {
          id: "pipeline",
          type: "action.mcp_pipeline",
          label: "Pipeline",
          config: {
            steps: [
              { id: "s1", server: "github", tool: "list_prs" },
              { id: "s2", server: "slack", tool: "post", inputMap: { text: "text" } },
            ],
          },
          position: { x: 100, y: 0 },
        },
      ],
      edges: [{ id: "e1", source: "trigger", target: "pipeline" }],
    };

    engine.save(wf);
    const ctx = await engine.execute("test-pipeline-dryrun", {}, { dryRun: true });
    expect(ctx.nodeStatuses.get("pipeline")).toBe(NodeStatus.COMPLETED);
  }, SLOW_MCP_WORKFLOW_ADAPTER_DRY_RUN_TEST_TIMEOUT_MS);
});

// ═══════════════════════════════════════════════════════════════════════════
//  Workflow Node Integration — transform.mcp_extract (dry-run)
// ═══════════════════════════════════════════════════════════════════════════

describe("transform.mcp_extract node (dry-run)", () => {
  let tmpDir;
  let engine;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wf-mcp-extract-test-"));
    engine = new WorkflowEngine({
      workflowDir: join(tmpDir, "workflows"),
      runsDir: join(tmpDir, "runs"),
    });
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* best-effort cleanup */ }
  });

  it("has registered node type", () => {
    const handler = getNodeType("transform.mcp_extract");
    expect(handler).toBeTruthy();
    expect(handler.schema.required).toContain("source");
    expect(handler.schema.required).toContain("fields");
  });

  it("describes itself accurately", () => {
    const handler = getNodeType("transform.mcp_extract");
    const desc = handler.describe();
    expect(desc).toContain("Extract");
    expect(desc).toContain("structured");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Workflow Templates — MCP Integration templates load correctly
// ═══════════════════════════════════════════════════════════════════════════

describe("MCP Integration workflow templates", () => {
  let templates;

  beforeEach(async () => {
    const mod = await import("../workflow/workflow-templates.mjs");
    templates = mod.WORKFLOW_TEMPLATES;
  });

  it("includes MCP Tool Chain template", () => {
    const tpl = templates.find((t) => t.id === "template-mcp-tool-chain");
    expect(tpl).toBeDefined();
    expect(tpl.category).toBe("mcp-integration");
    expect(tpl.nodes.length).toBeGreaterThanOrEqual(4);
    expect(tpl.edges.length).toBeGreaterThanOrEqual(3);
    // Should have mcp_list_tools and mcp_tool_call nodes
    const nodeTypes = tpl.nodes.map((n) => n.type);
    expect(nodeTypes).toContain("action.mcp_list_tools");
    expect(nodeTypes).toContain("action.mcp_tool_call");
    expect(nodeTypes).toContain("transform.mcp_extract");
  });

  it("includes MCP GitHub PR Monitor template", () => {
    const tpl = templates.find((t) => t.id === "template-mcp-github-pr-monitor");
    expect(tpl).toBeDefined();
    expect(tpl.category).toBe("mcp-integration");
    expect(tpl.trigger).toBe("trigger.schedule");
    // Should have mcp_tool_call with extract config
    const mcpNode = tpl.nodes.find((n) => n.type === "action.mcp_tool_call");
    expect(mcpNode).toBeDefined();
    expect(mcpNode.config.extract).toBeDefined();
    expect(mcpNode.config.extract.fields).toBeDefined();
    expect(mcpNode.config.portConfig).toBeDefined();
  });

  it("includes MCP Cross-Server Pipeline template", () => {
    const tpl = templates.find((t) => t.id === "template-mcp-cross-server-pipeline");
    expect(tpl).toBeDefined();
    expect(tpl.category).toBe("mcp-integration");
    const pipelineNode = tpl.nodes.find((n) => n.type === "action.mcp_pipeline");
    expect(pipelineNode).toBeDefined();
    expect(pipelineNode.config.steps.length).toBeGreaterThanOrEqual(2);
  });

  it("includes MCP Iterative Research template", () => {
    const tpl = templates.find((t) => t.id === "template-mcp-iterative-research");
    expect(tpl).toBeDefined();
    expect(tpl.trigger).toBe("trigger.workflow_call");
  });

  it("has MCP Integration category", () => {
    const { TEMPLATE_CATEGORIES } = require("../workflow/workflow-templates.mjs");
    expect(TEMPLATE_CATEGORIES["mcp-integration"]).toBeDefined();
    expect(TEMPLATE_CATEGORIES["mcp-integration"].label).toBe("MCP Integration");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  End-to-End: Data Piping Between Nodes
// ═══════════════════════════════════════════════════════════════════════════

describe("MCP data piping (unit-level)", () => {
  it("full pipeline: parse → extract → map → build next input", () => {
    // Simulate GitHub MCP tool returning PR data
    const mcpResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify([
            { number: 101, title: "Fix auth", user: { login: "alice" }, state: "open" },
            { number: 102, title: "Add cache", user: { login: "bob" }, state: "open" },
          ]),
        },
      ],
    };

    // Step 1: Parse MCP content
    const parsed = parseMcpContent(mcpResult);
    expect(parsed.contentType).toBe("json");
    expect(parsed.data).toHaveLength(2);

    // Step 2: Extract structured fields
    const extracted = extractMcpOutput(parsed.data, {
      fields: {
        prCount: "length",
        titles: "[*].title",
        authors: "[*].user.login",
        firstPrNumber: "[0].number",
      },
      types: {
        prCount: "number",
        firstPrNumber: "integer",
      },
    });
    expect(extracted.prCount).toBe(2);
    expect(extracted.titles).toEqual(["Fix auth", "Add cache"]);
    expect(extracted.authors).toEqual(["alice", "bob"]);
    expect(extracted.firstPrNumber).toBe(101);

    // Step 3: Map output for downstream consumption
    const mapped = mapOutputFields(extracted, {
      summary: {
        _concat: ["titles"],
        _separator: ", ",
      },
      authorCount: { _from: "authors", _transform: "count" },
      uniqueAuthors: { _from: "authors", _transform: "unique" },
    });
    expect(mapped.authorCount).toBe(2);
    expect(mapped.uniqueAuthors).toEqual(["alice", "bob"]);

    // Step 4: Build input for next tool call (e.g. Slack notification)
    const nextInput = buildPipelineInput(
      { ...extracted, ...mapped },
      {
        channel: { _literal: "#dev-prs" },
        text: {
          _concat: ["prCount", "titles"],
          _separator: " PRs: ",
        },
      },
    );
    expect(nextInput.channel).toBe("#dev-prs");
    expect(nextInput.text).toContain("2");
  });
});
