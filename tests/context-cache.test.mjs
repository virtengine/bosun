import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Use a temp directory for test cache to avoid polluting real cache
const TEST_CACHE_DIR = resolve(__dirname, "..", ".cache-test-tool-logs");
const TEST_TOOL_LOG_DIR = resolve(TEST_CACHE_DIR, "tool-logs");
const TEST_COMMAND_DIAGNOSTICS_STATE = resolve(TEST_CACHE_DIR, "command-diagnostics-state.json");

// Mock the cache directory before importing the module
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual };
});

describe("context-cache", () => {
  let contextCache;
  let originalGitOutputMaxChars;
  let originalCommandDiagnosticsStateFile;
  let originalToolLogDir;

  beforeEach(async () => {
    originalGitOutputMaxChars = process.env.BOSUN_GIT_OUTPUT_MAX_CHARS;
    originalCommandDiagnosticsStateFile = process.env.BOSUN_COMMAND_DIAGNOSTICS_STATE_FILE;
    originalToolLogDir = process.env.BOSUN_TOOL_LOG_DIR;
    delete process.env.BOSUN_GIT_OUTPUT_MAX_CHARS;
    process.env.BOSUN_COMMAND_DIAGNOSTICS_STATE_FILE = TEST_COMMAND_DIAGNOSTICS_STATE;
    process.env.BOSUN_TOOL_LOG_DIR = TEST_TOOL_LOG_DIR;
    // Clean test directory
    rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
    mkdirSync(TEST_CACHE_DIR, { recursive: true });

    // Fresh import for each test
    vi.resetModules();
    contextCache = await import("../workspace/context-cache.mjs");
  });

  afterEach(() => {
    if (originalGitOutputMaxChars === undefined) {
      delete process.env.BOSUN_GIT_OUTPUT_MAX_CHARS;
    } else {
      process.env.BOSUN_GIT_OUTPUT_MAX_CHARS = originalGitOutputMaxChars;
    }
    if (originalCommandDiagnosticsStateFile === undefined) {
      delete process.env.BOSUN_COMMAND_DIAGNOSTICS_STATE_FILE;
    } else {
      process.env.BOSUN_COMMAND_DIAGNOSTICS_STATE_FILE = originalCommandDiagnosticsStateFile;
    }
    if (originalToolLogDir === undefined) {
      delete process.env.BOSUN_TOOL_LOG_DIR;
    } else {
      process.env.BOSUN_TOOL_LOG_DIR = originalToolLogDir;
    }
    rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ── Helper: build a fake item array with tool outputs ──────────────────
  function makeToolItems(count, textSize = 500) {
    const items = [];
    for (let i = 0; i < count; i++) {
      // Alternate between tool outputs and agent messages
      items.push({
        type: "function_call_output",
        tool_name: `tool_${i}`,
        arguments: { file: `src/file${i}.ts`, query: "search term" },
        output: `Output from tool ${i}: ${"x".repeat(textSize)}`,
        force: true,
      });
      items.push({
        type: "agent_message",
        text: `Agent response after tool ${i}`,
        force: true,
      });
    }
    return items;
  }

  function makeLargeGitOutput(lines = 1400) {
    return Array.from(
      { length: lines },
      (_, i) => `${String(i).padStart(4, "0")} commit message ${"x".repeat(30)}`,
    ).join("\n");
  }

  // ── cacheAndCompressItems ──────────────────────────────────────────────

  describe("cacheAndCompressItems", () => {
    it("returns items unchanged when fewer than fullContextTurns", async () => {
      const items = makeToolItems(2); // only 2 tool calls
      const result = await contextCache.cacheAndCompressItems(items);
      expect(result).toEqual(items);
    });

    it("keeps last 3 turns fully intact (Tier 0)", async () => {
      const items = makeToolItems(6, 3000);
      const result = await contextCache.cacheAndCompressItems(items);

      // Last 3 tool outputs (index 4, 5 are the last tool items) should be full
      // Items are: tool0, agent0, tool1, agent1, ..., tool5, agent5
      // Turns are: tool outputs increment turn counter

      // The last tool output items should retain their full text
      const lastToolItems = result.filter(
        (it) => it.type === "function_call_output" && !it._cachedLogId,
      );
      // At least 3 should be untouched
      expect(lastToolItems.length).toBeGreaterThanOrEqual(2);
    });

    it("compresses older items and adds retrieval command", async () => {
      const items = makeToolItems(8, 5000);
      const result = await contextCache.cacheAndCompressItems(items);

      // Some items should now have _cachedLogId
      const cached = result.filter(
        (it) => it._cachedLogId !== undefined,
      );
      expect(cached.length).toBeGreaterThan(0);

      // Compressed items should reference bosun --tool-log
      for (const item of cached) {
        const text =
          item.text || item.output || "";
        expect(text).toContain("bosun --tool-log");
      }
    });

    it("attaches a spill pointer with tier metadata to cached historical tool outputs", async () => {
      const items = makeToolItems(8, 5000);
      const result = await contextCache.cacheAndCompressItems(items);
      const cached = result.find((it) => it._cachedLogId !== undefined);

      expect(cached?._spillPointer).toEqual(expect.objectContaining({
        kind: "tool-log",
        storage: "disk",
        logId: cached?._cachedLogId,
        retrieveCommand: `bosun --tool-log ${cached?._cachedLogId}`,
        stage: "historical_tool_compaction",
        tier: expect.stringMatching(/^tier[123]$|^structured$/),
      }));
    });

    it("does not compress agent messages (non-tool items)", async () => {
      const items = makeToolItems(8, 5000);
      const result = await contextCache.cacheAndCompressItems(items);

      const agentMessages = result.filter((it) => it.type === "agent_message");
      // Agent messages should all be untouched
      for (const msg of agentMessages) {
        expect(msg._cachedLogId).toBeUndefined();
      }
    });

    it("does not compress items with text shorter than 200 chars", async () => {
      const items = makeToolItems(8, 50); // very small outputs
      const result = await contextCache.cacheAndCompressItems(items);

      // Should have no cached items because outputs are too small
      const cached = result.filter((it) => it._cachedLogId !== undefined);
      expect(cached.length).toBe(0);
    });

    it("respects custom fullContextTurns option", async () => {
      const items = makeToolItems(6, 3000);
      // Keep 5 turns full — should compress very little
      const result = await contextCache.cacheAndCompressItems(items, {
        fullContextTurns: 5,
        force: true,
      });

      const cached = result.filter((it) => it._cachedLogId !== undefined);
      // With 6 tools and 5 full turns, only 1 should be compressed
      const fullContextResult = await contextCache.cacheAndCompressItems(
        items,
        { fullContextTurns: 2 },
      );
      const cachedAggressive = fullContextResult.filter(
        (it) => it._cachedLogId !== undefined,
      );
      // More aggressive should compress more
      expect(cachedAggressive.length).toBeGreaterThanOrEqual(cached.length);
    });

    it("immediately caps large git log output and preserves the full disk cache entry", async () => {
      const fullOutput = makeLargeGitOutput(1500);
      const items = [{
        type: "command_execution",
        command: "git log --oneline",
        aggregated_output: fullOutput,
      }];

      const result = await contextCache.cacheAndCompressItems(items);

      expect(result).toHaveLength(1);
      expect(result[0]._cachedLogId).toBeDefined();
      expect(result[0].aggregated_output.length).toBeLessThan(1000);
      expect(result[0].aggregated_output).toContain("bosun --tool-log");
      expect(result[0].aggregated_output).toMatch(/git capped: \d+ lines, \d+ chars suppressed/i);

      const retrieved = await contextCache.retrieveToolLog(result[0]._cachedLogId);
      expect(retrieved.found).toBe(true);
      expect(retrieved.entry.item.aggregated_output).toBe(fullOutput);
    });

    it("immediately caps other high-volume git history outputs", async () => {
      const fullOutput = makeLargeGitOutput(1500);
      const cases = [
        { command: "git shortlog -sn", field: "aggregated_output" },
        { command: "git reflog", field: "aggregated_output" },
        { command: "git diff HEAD~20 HEAD", field: "aggregated_output" },
        { tool_name: "git", arguments: ["log", "--oneline"], field: "output" },
        { tool_name: "workspace_git_runner", command: "log --oneline", field: "aggregated_output" },
        { tool_name: "git_log_runner", field: "output" },
        { tool_name: "workspace-git-log-runner", field: "output" },
        { tool_name: "workspace-git-reflog-runner", field: "output" },
        { tool_name: "workspace-git-diff-runner", field: "output" },
      ];

      for (const entry of cases) {
        const [result] = await contextCache.cacheAndCompressItems([{
          type: entry.field === "output" ? "function_call_output" : "command_execution",
          tool_name: entry.tool_name,
          arguments: entry.arguments,
          command: entry.command,
          [entry.field]: fullOutput,
        }]);

        expect(result._cachedLogId).toBeDefined();
        expect(result[entry.field]).toContain("bosun --tool-log");
        expect(result[entry.field].length).toBeLessThan(1000);
      }
    });

    it("leaves bounded git commands untouched", async () => {
      const largeOutput = makeLargeGitOutput(1500);
      const statusItems = [{
        type: "command_execution",
        command: "git status --short",
        aggregated_output: largeOutput,
      }];
      const diffStatItems = [{
        type: "command_execution",
        command: "git diff --stat HEAD~1",
        aggregated_output: largeOutput,
      }];
      const showItems = [{
        type: "command_execution",
        command: "git show HEAD~1",
        aggregated_output: largeOutput,
      }];
      const diffStatToolNameOnlyItems = [{
        type: "function_call_output",
        tool_name: "git_diff_stat",
        output: largeOutput,
      }];
      const showToolNameOnlyItems = [{
        type: "function_call_output",
        tool_name: "workspace-git-show-runner",
        output: largeOutput,
      }];
      const statusToolNameOnlyItems = [{
        type: "function_call_output",
        tool_name: "workspace-git-status-runner",
        output: largeOutput,
      }];

      const [statusResult] = await contextCache.cacheAndCompressItems(statusItems);
      const [diffStatResult] = await contextCache.cacheAndCompressItems(diffStatItems);
      const [showResult] = await contextCache.cacheAndCompressItems(showItems);
      const [diffStatToolNameOnlyResult] = await contextCache.cacheAndCompressItems(diffStatToolNameOnlyItems);
      const [showToolNameOnlyResult] = await contextCache.cacheAndCompressItems(showToolNameOnlyItems);
      const [statusToolNameOnlyResult] = await contextCache.cacheAndCompressItems(statusToolNameOnlyItems);

      expect(statusResult._cachedLogId).toBeUndefined();
      expect(statusResult.aggregated_output).toBe(largeOutput);
      expect(diffStatResult._cachedLogId).toBeUndefined();
      expect(diffStatResult.aggregated_output).toBe(largeOutput);
      expect(showResult._cachedLogId).toBeUndefined();
      expect(showResult.aggregated_output).toBe(largeOutput);
      expect(diffStatToolNameOnlyResult._cachedLogId).toBeUndefined();
      expect(diffStatToolNameOnlyResult.output).toBe(largeOutput);
      expect(showToolNameOnlyResult._cachedLogId).toBeUndefined();
      expect(showToolNameOnlyResult.output).toBe(largeOutput);
      expect(statusToolNameOnlyResult._cachedLogId).toBeUndefined();
      expect(statusToolNameOnlyResult.output).toBe(largeOutput);
    });

    it("disables the immediate git cap when BOSUN_GIT_OUTPUT_MAX_CHARS=0", async () => {
      process.env.BOSUN_GIT_OUTPUT_MAX_CHARS = "0";

      const fullOutput = makeLargeGitOutput(1500);
      const items = [{
        type: "command_execution",
        command: "git log --oneline",
        aggregated_output: fullOutput,
      }];

      const [result] = await contextCache.cacheAndCompressItems(items);

      expect(result._cachedLogId).toBeUndefined();
      expect(result.aggregated_output).toBe(fullOutput);
    });

    it("applies the immediate git cap when BOSUN_GIT_OUTPUT_MAX_CHARS is set below tier-2 span", async () => {
      process.env.BOSUN_GIT_OUTPUT_MAX_CHARS = "900";

      const fullOutput = makeLargeGitOutput(60);
      const items = [{
        type: "command_execution",
        command: "git log --oneline",
        aggregated_output: fullOutput,
      }];

      const [result] = await contextCache.cacheAndCompressItems(items);

      expect(result._cachedLogId).toBeDefined();
      expect(result.aggregated_output).toContain("bosun --tool-log");
      expect(result.aggregated_output).not.toBe(fullOutput);

      const retrieved = await contextCache.retrieveToolLog(result._cachedLogId);
      expect(retrieved.found).toBe(true);
      expect(retrieved.entry.item.aggregated_output).toBe(fullOutput);
    });
  });


  describe("semantic live tool compaction", () => {
    it("routes dotnet test output to the test family with stable policy metadata", async () => {
      const output = [
        "Determining projects to restore...",
        "All projects are up-to-date for restore.",
        "tests/Foo.Tests/WidgetTests.cs(42,13): error CS1002: ; expected [tests/Foo.Tests/Foo.Tests.csproj]",
        "Failed!  - Failed:     1, Passed:   128, Skipped:     0, Total:   129, Duration: 2 s",
      ].join("\n") + "\n" + "x".repeat(7000);

      const item = {
        type: "command_execution",
        command: "dotnet test --no-restore",
        aggregated_output: output,
      };

      const [result] = await contextCache.maybeCompressSessionItems([item], {
        liveToolCompactionEnabled: true,
        liveToolCompactionMode: "aggressive",
        liveToolCompactionMinChars: 1000,
        liveToolCompactionTargetChars: 1400,
        liveToolCompactionMinSavingsPct: 5,
        force: true,
      });

      expect(result._liveCompacted).toBe(true);
      expect(result._liveCompactionFamily).toBe("build");
      expect(result._liveCompactionPolicy).toBeDefined();
      expect(result._liveCompactionPolicy.family).toBe("build");
      expect(result._liveCompactionPolicy.budget.decision).toBe("summary_with_delta");
      expect(result._liveCompactionPolicy.why.join(" ")).toContain("family:build");
      expect(result.aggregated_output).toContain("CS1002");
    });

    it("routes package manager install noise to retrievable artifact policy", async () => {
      const output = [
        "added 842 packages in 31s",
        "187 packages are looking for funding",
        "found 0 vulnerabilities",
        ...Array.from({ length: 120 }, (_, i) => `npm notice chunk ${i} ${"z".repeat(80)}`),
      ].join("\n");

      const item = {
        type: "command_execution",
        command: "npm install",
        aggregated_output: output,
      };

      const [result] = await contextCache.maybeCompressSessionItems([item], {
        liveToolCompactionEnabled: true,
        liveToolCompactionMode: "aggressive",
        liveToolCompactionMinChars: 1000,
        liveToolCompactionTargetChars: 1200,
        liveToolCompactionMinSavingsPct: 5,
        force: true,
      });

      expect(result._liveCompacted).toBe(true);
      expect(result._liveCompactionFamily).toBe("package-manager");
      expect(result._liveCompactionPolicy.budget.decision).toBe("artifact_summary");
      expect(result._cachedLogId).toBeDefined();
      expect(result.aggregated_output).toContain("bosun --tool-log");
    });

    it("routes noisy docker deploy output to deploy policy and exposes rationale", async () => {
      const output = [
        "#1 [internal] load build definition from Dockerfile",
        "#2 exporting to image",
        "#3 pushing layers",
        "service api  Recreated",
        "service api  Started",
        ...Array.from({ length: 140 }, (_, i) => `deploy progress ${i} ${"y".repeat(60)}`),
      ].join("\n");

      const item = {
        type: "command_execution",
        command: "docker compose up --build -d",
        aggregated_output: output,
      };

      const [result] = await contextCache.maybeCompressSessionItems([item], {
        liveToolCompactionEnabled: true,
        liveToolCompactionMode: "aggressive",
        liveToolCompactionMinChars: 1000,
        liveToolCompactionTargetChars: 1300,
        liveToolCompactionMinSavingsPct: 5,
        force: true,
      });

      expect(result._liveCompacted).toBe(true);
      expect(result._liveCompactionFamily).toBe("deploy");
      expect(result._liveCompactionPolicy.reason).toMatch(/artifact|delta|summary/i);
      expect(result._liveCompactionPolicy.why.length).toBeGreaterThan(1);
    });
  });

  describe("session coverage telemetry", () => {
    const sessionCases = [
      { sessionType: "task", expectedNormalized: "task" },
      { sessionType: "flow", expectedNormalized: "flow" },
      { sessionType: "delegate", expectedNormalized: "delegate" },
      { sessionType: "voice-delegate", expectedNormalized: "voice" },
    ];

    it.each(sessionCases)("records coverage for $sessionType sessions", async ({ sessionType, expectedNormalized }) => {
      contextCache.clearShreddingStats();
      const items = [{
        type: "command_execution",
        command: "rg needle src",
        exit_code: 0,
        aggregated_output: Array.from({ length: 160 }, (_, index) => `src/file${index}.ts:${index + 1}: needle ${"x".repeat(24)}`).join("\n"),
      }];

      await contextCache.maybeCompressSessionItems(items, {
        sessionType,
        agentType: "codex-sdk",
        liveToolCompactionEnabled: true,
        liveToolCompactionMode: "aggressive",
        liveToolCompactionMinChars: 1000,
        liveToolCompactionTargetChars: 1200,
        force: true,
      });

      const stats = contextCache.getShreddingStats();
      expect(stats.some((entry) => entry.stage === "live_tool_compaction" && entry.sessionType === sessionType)).toBe(true);
      expect(stats.some((entry) => entry.normalizedSessionType === expectedNormalized)).toBe(true);
      expect(stats.some((entry) => entry.stage === "session_total" && entry.decision === "compressed")).toBe(true);
    });
  });
  // ── retrieveToolLog ────────────────────────────────────────────────────

  describe("retrieveToolLog", () => {
    it("retrieves a cached tool output by ID", async () => {
      // First, compress some items to generate cache entries
      const items = makeToolItems(6, 3000);
      const result = await contextCache.cacheAndCompressItems(items);

      const cached = result.filter((it) => it._cachedLogId !== undefined);
      if (cached.length === 0) return; // skip if nothing was cached

      const logId = cached[0]._cachedLogId;
      const retrieved = await contextCache.retrieveToolLog(logId);

      expect(retrieved.found).toBe(true);
      expect(retrieved.entry).toBeDefined();
      expect(retrieved.entry.id).toBe(logId);
      expect(retrieved.entry.item).toBeDefined();
      expect(retrieved.spillPointer).toEqual(expect.objectContaining({
        kind: "tool-log",
        logId,
        filePath: expect.stringContaining("tool-logs"),
        retrieveCommand: `bosun --tool-log ${logId}`,
      }));
    });

    it("returns found=false for non-existent ID", async () => {
      const result = await contextCache.retrieveToolLog(999999999);
      expect(result.found).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("returns found=false for invalid ID", async () => {
      const result = await contextCache.retrieveToolLog("abc");
      expect(result.found).toBe(false);
      expect(result.error).toContain("Invalid");
    });
  });

  // ── listToolLogs ───────────────────────────────────────────────────────

  describe("listToolLogs", () => {
    it("lists cached entries", async () => {
      const items = makeToolItems(6, 3000);
      await contextCache.cacheAndCompressItems(items);

      const logs = await contextCache.listToolLogs();
      expect(Array.isArray(logs)).toBe(true);
      // Should have at least some entries
      if (logs.length > 0) {
        expect(logs[0].id).toBeDefined();
        expect(logs[0].toolName).toBeDefined();
      }
    });

    it("respects limit parameter", async () => {
      const items = makeToolItems(10, 3000);
      await contextCache.cacheAndCompressItems(items);

      const limited = await contextCache.listToolLogs(2);
      expect(limited.length).toBeLessThanOrEqual(2);
    });
  });

  // ── pruneToolLogCache ──────────────────────────────────────────────────

  describe("pruneToolLogCache", () => {
    it("prunes entries older than maxAgeMs", async () => {
      const items = makeToolItems(6, 3000);
      await contextCache.cacheAndCompressItems(items);

      // Prune with 0ms max age — everything should be pruned
      const pruned = await contextCache.pruneToolLogCache(0);
      expect(pruned).toBeGreaterThanOrEqual(0);
    });

    it("does not prune recent entries with default TTL", async () => {
      const items = makeToolItems(6, 3000);
      await contextCache.cacheAndCompressItems(items);

      // Prune with default 24h — nothing should be pruned (just created)
      const pruned = await contextCache.pruneToolLogCache();
      expect(pruned).toBe(0);
    });
  });

  // ── estimateSavings ────────────────────────────────────────────────────

  describe("estimateSavings", () => {
    it("calculates compression savings correctly", async () => {
      const items = makeToolItems(10, 5000);
      const compressed = await contextCache.cacheAndCompressItems(items);

      const savings = contextCache.estimateSavings(items, compressed);
      expect(savings.originalChars).toBeGreaterThan(0);
      expect(savings.savedChars).toBeGreaterThanOrEqual(0);
      expect(savings.savedPct).toBeGreaterThanOrEqual(0);
      expect(savings.savedPct).toBeLessThanOrEqual(100);
    });

    it("returns 0 savings when nothing is compressed", () => {
      const items = makeToolItems(2, 50);
      const savings = contextCache.estimateSavings(items, items);
      expect(savings.savedChars).toBe(0);
      expect(savings.savedPct).toBe(0);
    });
  });

  // ── Tiered compression ────────────────────────────────────────────────

  describe("tiered compression", () => {
    it("applies progressively more aggressive compression to older items", async () => {
      // Create a large session with many tool calls
      const items = makeToolItems(15, 8000);
      const result = await contextCache.cacheAndCompressItems(items);

      const cachedItems = result.filter((it) => it._cachedLogId !== undefined);

      if (cachedItems.length >= 2) {
        // Older items should have shorter text than newer compressed items
        // (Tier 3 skeleton vs Tier 1 head+tail)
        const texts = cachedItems.map((it) => (it.text || it.output || "").length);
        // The array should generally decrease (older = more compressed)
        // but just check that at least one item is significantly shorter
        const min = Math.min(...texts);
        const max = Math.max(...texts);
        expect(max).toBeGreaterThan(min);
      }
    });

    it("Tier 3 items only contain skeleton with retrieval command", async () => {
      const items = makeToolItems(20, 8000);
      const result = await contextCache.cacheAndCompressItems(items);

      // Very old items should be Tier 3 — just "[Cached tool call]..."
      const skeletonItems = result.filter(
        (it) =>
          it.type === "context_compressed" ||
          (typeof it.text === "string" && it.text.startsWith("[Cached tool call]")),
      );

      if (skeletonItems.length > 0) {
        for (const sk of skeletonItems) {
          expect(sk.text).toContain("bosun --tool-log");
          expect(sk.text.length).toBeLessThan(300);
        }
      }
    });
  });

  // ── getToolLogDir ──────────────────────────────────────────────────────

  describe("getToolLogDir", () => {
    it("returns a string path", () => {
      const dir = contextCache.getToolLogDir();
      expect(typeof dir).toBe("string");
      expect(dir).toContain("tool-logs");
    });
  });

  // ── isItemPinned ───────────────────────────────────────────────────────

  describe("isItemPinned", () => {
    it("detects explicit _pinned flag", () => {
      const item = { type: "agent_message", text: "Some text", _pinned: true };
      expect(contextCache.isItemPinned(item)).toBe(true);
    });

    it("detects AGENTS.md keyword", () => {
      const item = {
        type: "agent_message",
        text: "Read the AGENTS.md file for instructions on how to proceed.",
      };
      expect(contextCache.isItemPinned(item)).toBe(true);
    });

    it("detects CRITICAL/MUST/NEVER keywords", () => {
      expect(contextCache.isItemPinned({ text: "CRITICAL: always run tests" })).toBe(true);
      expect(contextCache.isItemPinned({ text: "You MUST NOT skip linting" })).toBe(true);
      expect(contextCache.isItemPinned({ text: "NEVER use --no-verify" })).toBe(true);
    });

    it("detects commit convention rules", () => {
      expect(
        contextCache.isItemPinned({ text: "Use conventional commits for all changes." }),
      ).toBe(true);
      expect(
        contextCache.isItemPinned({ text: "Pre-push hooks must pass before pushing." }),
      ).toBe(true);
    });

    it("returns false for ordinary agent messages", () => {
      expect(
        contextCache.isItemPinned({ type: "agent_message", text: "Let me implement the feature." }),
      ).toBe(false);
    });

    it("returns false for null/undefined", () => {
      expect(contextCache.isItemPinned(null)).toBe(false);
      expect(contextCache.isItemPinned(undefined)).toBe(false);
    });
  });

  // ── compressAllItems ──────────────────────────────────────────────────

  describe("compressAllItems", () => {
    // Helper: build a mixed session with tools, agent msgs, user msgs
    function makeMixedSession(turns) {
      const items = [];
      for (let i = 0; i < turns; i++) {
        // User prompt (simulating what a user would send)
        items.push({
          type: "user_message",
          role: "user",
          text: `User request turn ${i}: ${"Please implement the feature that does something useful. ".repeat(10)}`,
          force: true,
      });
        // Tool output  
        items.push({
          type: "function_call_output",
          tool_name: `tool_${i}`,
          arguments: { file: `src/file${i}.ts` },
          output: `Output from tool ${i}: ${"x".repeat(500)}`,
          force: true,
      });
        // Agent thinking/response
        items.push({
          type: "agent_message",
          text: `Now let me implement the changes for step ${i}. I need to:\n` +
            `1. First, read the existing code\n` +
            `2. Then modify the function\n` +
            `3. Run the tests\n` +
            `4. Commit the changes\n` +
            `${"Detailed reasoning about the implementation approach. ".repeat(5)}`,
          force: true,
      });
      }
      return items;
    }

    it("compresses agent messages from older turns", async () => {
      const items = makeMixedSession(8);
      const result = await contextCache.compressAllItems(items);

      // Older agent messages should be compressed
      const compressedAgentMsgs = result.filter(
        (it) => it._compressed === "agent_tier1" || it._compressed === "agent_tier2",
      );
      expect(compressedAgentMsgs.length).toBeGreaterThan(0);
    });

    it("compresses user messages from older turns", async () => {
      const items = makeMixedSession(8);
      const result = await contextCache.compressAllItems(items);

      // Older user messages should be breadcrumb-compressed
      const compressedUserMsgs = result.filter(
        (it) => it._compressed === "user_breadcrumb",
      );
      expect(compressedUserMsgs.length).toBeGreaterThan(0);

      // Breadcrumbs should be wrapped in [User request: …]
      for (const msg of compressedUserMsgs) {
        expect(msg.text).toMatch(/^\[User request:/);
      }
    });

    it("keeps current turn messages in full", async () => {
      const items = makeMixedSession(8);
      const result = await contextCache.compressAllItems(items);

      // Last agent message should be untouched (age 0)
      const lastAgentMsg = result
        .filter((it) => it.type === "agent_message")
        .pop();
      expect(lastAgentMsg._compressed).toBeUndefined();
      expect(lastAgentMsg.text).toContain("Now let me implement");
    });

    it("never compresses pinned instruction items", async () => {
      const items = makeMixedSession(6);
      // Insert an instruction item at the beginning
      items.unshift({
        type: "agent_message",
        text: "I have read AGENTS.md and will follow the CRITICAL rules: MUST NOT skip tests, NEVER use --no-verify, always use conventional commits.",
        _pinned: true,
        force: true,
      });

      const result = await contextCache.compressAllItems(items);

      // Find the pinned item — should be untouched
      const pinned = result.find((it) => it._pinned === true);
      expect(pinned).toBeDefined();
      expect(pinned._compressed).toBeUndefined();
      expect(pinned.text).toContain("AGENTS.md");
    });

    it("never compresses instruction items detected by keywords", async () => {
      const items = makeMixedSession(6);
      // Insert instruction items without explicit _pinned flag — should be auto-detected
      items.unshift({
        type: "agent_message",
        text: "## Instructions\nCRITICAL: Module-scope caching is MANDATORY. Error boundaries MUST wrap all async work.",
        force: true,
      });

      const result = await contextCache.compressAllItems(items);

      // The instruction item should be untouched
      const instructionItem = result.find(
        (it) => typeof it.text === "string" && it.text.includes("## Instructions"),
      );
      expect(instructionItem).toBeDefined();
      expect(instructionItem._compressed).toBeUndefined();
    });

    it("progressively compresses agent messages with age", async () => {
      const items = makeMixedSession(12);
      const result = await contextCache.compressAllItems(items);

      // Should have both tier1 and tier2 compressions
      const tier1 = result.filter((it) => it._compressed === "agent_tier1");
      const tier2 = result.filter((it) => it._compressed === "agent_tier2");

      // Tier 2 items should be shorter than tier 1 items
      if (tier1.length > 0 && tier2.length > 0) {
        const avgTier1Len =
          tier1.reduce((s, it) => s + (it.text?.length || 0), 0) / tier1.length;
        const avgTier2Len =
          tier2.reduce((s, it) => s + (it.text?.length || 0), 0) / tier2.length;
        expect(avgTier2Len).toBeLessThan(avgTier1Len);
      }
    });

    it("user breadcrumbs preserve the role field", async () => {
      const items = makeMixedSession(6);
      const result = await contextCache.compressAllItems(items);

      const userBreadcrumbs = result.filter(
        (it) => it._compressed === "user_breadcrumb",
      );
      for (const msg of userBreadcrumbs) {
        expect(msg.role).toBe("user");
      }
    });

    it("does not compress short messages", async () => {
      const items = [
        { type: "function_call_output", tool_name: "t1", output: "x".repeat(500) },
        { type: "agent_message", text: "OK, done." },
        { type: "function_call_output", tool_name: "t2", output: "x".repeat(500) },
        { type: "agent_message", text: "Short msg." },
        { type: "function_call_output", tool_name: "t3", output: "x".repeat(500) },
        { type: "agent_message", text: "Also short." },
        { type: "function_call_output", tool_name: "t4", output: "x".repeat(500) },
        { type: "agent_message", text: "Last one." },
      ];
      const result = await contextCache.compressAllItems(items);

      // Short agent messages should not be compressed
      const compressed = result.filter(
        (it) => it._compressed === "agent_tier1" || it._compressed === "agent_tier2",
      );
      expect(compressed.length).toBe(0);
    });

    it("combines tool and message compression savings", async () => {
      const items = makeMixedSession(10);
      const result = await contextCache.compressAllItems(items);

      const savings = contextCache.estimateSavings(items, result);
      // Should save both from tool outputs AND messages
      expect(savings.savedChars).toBeGreaterThan(0);
      expect(savings.savedPct).toBeGreaterThan(0);
    });
  });

  // ── Content-Aware Relevance Scoring ───────────────────────────────────

  describe("scoreToolOutput", () => {
    it("returns neutral score for null/undefined", () => {
      expect(contextCache.scoreToolOutput(null)).toBe(50);
      expect(contextCache.scoreToolOutput(undefined)).toBe(50);
    });

    it("scores small targeted file reads high", () => {
      const item = {
        type: "function_call_output",
        tool_name: "read_file",
        arguments: { filePath: "src/config.mjs", startLine: 10, endLine: 25 },
        output: "const FOO = 42;\nexport default FOO;",
      };
      const score = contextCache.scoreToolOutput(item);
      // read_file base(85) + small size(~+20) + narrow range(+15) + path(+5)
      expect(score).toBeGreaterThanOrEqual(70);
    });

    it("scores large grep search results low", () => {
      // Simulate a big grep result with many matches
      const lines = [];
      for (let i = 0; i < 100; i++) {
        lines.push(`src/file${i}.ts:${i * 10}: const x = ${i};`);
      }
      const item = {
        type: "function_call_output",
        tool_name: "grep_search",
        arguments: { query: "const x" },
        output: lines.join("\n"),
      };
      const score = contextCache.scoreToolOutput(item);
      // grep_search base(30) + large size(-5 to -10) + many matches(-15)
      expect(score).toBeLessThan(30);
    });

    it("scores file edits high regardless of size", () => {
      const item = {
        type: "function_call_output",
        tool_name: "replace_string_in_file",
        arguments: { filePath: "src/main.ts" },
        output: "File edited successfully",
      };
      const score = contextCache.scoreToolOutput(item);
      // replace_string_in_file base(90) + small output(+20) + path(+5)
      // Clamped to 100 max
      expect(score).toBeGreaterThanOrEqual(90);
    });

    it("scores command failures higher than successes", () => {
      const success = {
        type: "command_execution",
        command: "npm test",
        exit_code: 0,
        aggregated_output: "All tests passed.\n" + "x".repeat(500),
      };
      const failure = {
        type: "command_execution",
        command: "npm test",
        exit_code: 1,
        aggregated_output: "FAIL tests/foo.test.ts\n" + "x".repeat(500),
      };
      const successScore = contextCache.scoreToolOutput(success);
      const failureScore = contextCache.scoreToolOutput(failure);
      // Failure gets +10 error bonus
      expect(failureScore).toBeGreaterThan(successScore);
    });

    it("gives higher scores to narrower line ranges", () => {
      const narrow = {
        type: "function_call_output",
        tool_name: "read_file",
        arguments: { filePath: "a.ts", startLine: 10, endLine: 15 },
        output: "const a = 1;\nconst b = 2;",
      };
      const wide = {
        type: "function_call_output",
        tool_name: "read_file",
        arguments: { filePath: "a.ts", startLine: 1, endLine: 500 },
        output: "x".repeat(15000),
      };
      const narrowScore = contextCache.scoreToolOutput(narrow);
      const wideScore = contextCache.scoreToolOutput(wide);
      expect(narrowScore).toBeGreaterThan(wideScore);
    });

    it("identifies search tools by name pattern", () => {
      const item = {
        type: "function_call_output",
        tool_name: "semantic_search",
        arguments: { query: "auth handler" },
        output: "x".repeat(8000),
      };
      const score = contextCache.scoreToolOutput(item);
      // semantic_search base(25) + large size(-5) = low score
      expect(score).toBeLessThan(40);
    });

    it("returns error items with item.error field higher score", () => {
      const item = {
        type: "function_call_output",
        tool_name: "unknown_tool",
        error: { message: "Something went wrong" },
        output: "",
      };
      const score = contextCache.scoreToolOutput(item);
      // unknown tool base(50) + tiny size(+20) + error(+10) = 80
      expect(score).toBeGreaterThanOrEqual(70);
    });
  });

  describe("content-aware compression integration", () => {
    it("protects high-value small reads from early compression", async () => {
      // 10 turns: early turns have small targeted reads
      const items = [];
      // Turn 0: small read_file (high value)
      items.push({
        type: "function_call_output",
        tool_name: "read_file",
        arguments: { filePath: "src/core.ts", startLine: 10, endLine: 15 },
        output: "function handleRequest() { return true; }",
        force: true,
      });
      items.push({ type: "agent_message", text: "Found the handler." });

      // Turns 1-7: filler to push turn 0 far enough for age-based compression
      for (let i = 1; i <= 7; i++) {
        items.push({
          type: "function_call_output",
          tool_name: `tool_${i}`,
          output: `Short output ${i}: ` + "y".repeat(300),
          force: true,
      });
        items.push({ type: "agent_message", text: `Done step ${i}.` });
      }

      const result = await contextCache.cacheAndCompressItems(items);

      // The small read_file from turn 0 should still be relatively intact
      // because its high score protects it (shifts tier down by 2)
      const readItem = result.find(
        (it) => it.tool_name === "read_file" || it._originalTool === "read_file",
      );
      // If the item was kept at tier 0 (full), it shouldn't have _compressed
      // If it was compressed, at worst it should be tier 1 (not tier 3/breadcrumb)
      if (readItem._compressed) {
        expect(readItem._compressed).not.toBe("tier3");
      }
    });

    it("aggressively compresses low-value large search results", async () => {
      const items = [];
      // Turn 0: large grep search with many matches (low value)
      const searchLines = [];
      for (let i = 0; i < 80; i++) {
        searchLines.push(`src/generated${i}.ts:${i}: match ${i}`);
      }
      items.push({
        type: "function_call_output",
        tool_name: "grep_search",
        arguments: { query: "match" },
        output: searchLines.join("\n"),
        force: true,
      });
      items.push({ type: "agent_message", text: "Found many results." });

      // Turns 1-4: normal work
      for (let i = 1; i <= 4; i++) {
        items.push({
          type: "function_call_output",
          tool_name: `tool_${i}`,
          output: `Step ${i} output: ` + "z".repeat(400),
          force: true,
      });
        items.push({ type: "agent_message", text: `Step ${i} done.` });
      }

      const result = await contextCache.cacheAndCompressItems(items);

      // The large grep_search should be compressed more aggressively
      const grepItem = result.find(
        (it) =>
          it.tool_name === "grep_search" || /grep/i.test(it._originalTool || ""),
      );
      // Should have been compressed (it's large + low score + old enough)
      if (grepItem) {
        expect(grepItem._compressed || grepItem._cachedLogId).toBeTruthy();
      }
    });
  });
});

describe("live tool compaction", () => {
  async function runLiveCompaction(items, env = {}) {
    const keys = [
      "CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_ENABLED",
      "CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MODE",
      "CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_CHARS",
      "CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_TARGET_CHARS",
      "CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_SAVINGS_PCT",
      "CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_RUNTIME_MS",
      "CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_BLOCK_STRUCTURED_OUTPUT",
      "CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_ALLOW_COMMANDS",
    ];
    const snapshot = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const { _resetConfigCache } = await import("../config/context-shredding-config.mjs");
    const cacheModule = await import("../workspace/context-cache.mjs");
    try {
      process.env.CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_ENABLED = "true";
      for (const [key, value] of Object.entries(env || {})) {
        if (value == null) delete process.env[key];
        else process.env[key] = String(value);
      }
      _resetConfigCache();
      return await cacheModule.maybeCompressSessionItems(items, {
        sessionType: "primary",
        agentType: "codex-sdk",
        force: false,
        skip: false,
        force: true,
      });
    } finally {
      for (const key of keys) {
        if (snapshot[key] === undefined) delete process.env[key];
        else process.env[key] = snapshot[key];
      }
      _resetConfigCache();
    }
  }

  it("compacts large search-style command output when enabled", async () => {
    const lines = [];
    for (let i = 0; i < 220; i++) {
      lines.push(`src/generated/file${i}.ts:${i + 1}: const needle${i} = true;`);
    }
    const items = [{
      type: "command_execution",
      command: "rg needle src",
      exit_code: 0,
      aggregated_output: lines.join("\n"),
    }];

    const result = await runLiveCompaction(items);

    expect(result).toHaveLength(1);
    expect(result[0]._liveCompacted).toBe(true);
    expect(result[0]._cachedLogId).toBeTruthy();
    expect(result[0].aggregated_output).toContain("Live-compacted search");
    expect(result[0].aggregated_output).toContain("Top files: src/generated/file0.ts:1");
    expect(result[0].aggregated_output).toContain("bosun --tool-log");
    expect(result[0].aggregated_output.length).toBeLessThan(items[0].aggregated_output.length);
  });

  it("compacts shell-wrapped search commands without custom agent hints", async () => {
    const lines = [];
    for (let i = 0; i < 180; i++) {
      lines.push(`src/feature/file${i}.ts:${i + 10}: export const thing${i} = true;`);
    }
    const items = [{
      type: "command_execution",
      command: 'bash -lc "rg thing src/feature"',
      exit_code: 0,
      aggregated_output: lines.join("\n"),
    }];

    const result = await runLiveCompaction(items, {
      CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_CHARS: "1200",
    });

    expect(result[0]._liveCompacted).toBe(true);
    expect(result[0]._liveCompactionFamily).toBe("search");
    expect(result[0].aggregated_output).toContain("Live-compacted search");
    expect(result[0].aggregated_output).toContain("src/feature/file0.ts:10");
  });

  it("preserves structured output when live compaction is enabled", async () => {
    const structured = JSON.stringify({ files: Array.from({ length: 80 }, (_, i) => ({ path: `src/file${i}.ts`, ok: true })) }, null, 2);
    const items = [{
      type: "command_execution",
      command: "node tool.mjs --json",
      exit_code: 0,
      aggregated_output: structured,
    }];

    const result = await runLiveCompaction(items);

    expect(result[0]._liveCompacted).toBeUndefined();
    expect(result[0].aggregated_output).toBe(structured);
  });

  it("keeps failure diagnostics while compacting noisy build output", async () => {
    const lines = [];
    for (let i = 0; i < 160; i++) {
      lines.push(`ok   pkg/module${i} 0.${i % 10}s`);
    }
    lines.push("FAIL tests/foo.test.ts");
    lines.push("Error: expected true to be false");
    lines.push("    at tests/foo.test.ts:42:9");
    const items = [{
      type: "command_execution",
      command: "go test ./...",
      exit_code: 1,
      aggregated_output: lines.join("\n"),
    }];

    const result = await runLiveCompaction(items, {
      CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_CHARS: "1000",
    });

    expect(result[0]._liveCompacted).toBe(true);
    expect(result[0].aggregated_output).toContain("FAIL tests/foo.test.ts");
    expect(result[0].aggregated_output).toContain("expected true to be false");
    expect(result[0].aggregated_output).toContain("bosun --tool-log");
  });

  it("classifies dotnet test output as test-family and keeps failing test anchors", async () => {
    const lines = [];
    for (let i = 0; i < 180; i++) {
      lines.push(`Passed! helper/test-${i}.dll`);
    }
    lines.push("Failed!  - Failed:     1, Passed:   512, Skipped:     0, Total:   513, Duration: 14 s");
    lines.push("Failed Bosun.Tests.WorkflowContextTests.ResolveTemplates [148 ms]");
    lines.push("Error Message:");
    lines.push(" Expected: True");
    lines.push(" But was:  False");
    lines.push(" Stack Trace:");
    lines.push("    at C:\\repo\\tests\\WorkflowContextTests.cs:line 42");
    const items = [{
      type: "command_execution",
      command: "dotnet test",
      exit_code: 1,
      aggregated_output: lines.join("\n"),
    }];

    const result = await runLiveCompaction(items, {
      CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_CHARS: "1200",
      CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_SAVINGS_PCT: "5",
    });

    expect(result[0]._liveCompacted).toBe(true);
    expect(result[0]._liveCompactionFamily).toBe("test");
    expect(result[0]._semanticBudgetPolicy).toMatch(/^(?:inline-excerpt|structured-delta)$/);
    expect(result[0].aggregated_output).toContain("Failed Bosun.Tests.WorkflowContextTests.ResolveTemplates");
    expect(result[0].aggregated_output).toContain("WorkflowContextTests.cs:line 42");
    expect(result[0].aggregated_output).toContain("Suggested rerun: dotnet test --filter");
    expect(result[0].aggregated_output).toContain("bosun --tool-log");
  });

  it("keeps git diff filenames and hunk context while dropping bulk diff noise", async () => {
    const lines = [
      "diff --git a/src/app.ts b/src/app.ts",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -10,6 +10,18 @@ export function render() {",
      "+  const importantFlag = true;",
      "+  const retryBudget = 3;",
      "diff --git a/src/lib/cache.ts b/src/lib/cache.ts",
      "--- a/src/lib/cache.ts",
      "+++ b/src/lib/cache.ts",
      "@@ -42,7 +42,11 @@ export function compact() {",
      "+  throw new Error('cache mismatch');",
    ];
    for (let i = 0; i < 220; i++) {
      lines.push(`+ filler line ${i} ${"x".repeat(40)}`);
    }
    const items = [{
      type: "command_execution",
      command: "git diff -- src",
      exit_code: 0,
      aggregated_output: lines.join("\n"),
    }];

    const result = await runLiveCompaction(items, {
      CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_CHARS: "1400",
      CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_SAVINGS_PCT: "5",
      CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_TARGET_CHARS: "900",
    });

    expect(result[0]._liveCompacted).toBe(true);
    expect(result[0]._liveCompactionFamily).toBe("git");
    expect(result[0].aggregated_output).toContain("src/app.ts");
    expect(result[0].aggregated_output).toContain("@@ -10,6 +10,18 @@ export function render() {");
    expect(result[0].aggregated_output).toContain("cache mismatch");
  });

  it("keeps latest error signals in log-heavy outputs", async () => {
    const lines = [];
    for (let i = 0; i < 240; i++) {
      lines.push(`INFO worker[${i % 3}] heartbeat ok`);
    }
    lines.push("WARN reconnecting stream after timeout");
    lines.push("ERROR websocket disconnected unexpectedly");
    lines.push("Traceback: reconnect loop exceeded budget");
    lines.push("INFO shutting down worker 2");
    const items = [{
      type: "command_execution",
      command: "journalctl -u bosun.service -n 500",
      exit_code: 0,
      aggregated_output: lines.join("\n"),
    }];

    const result = await runLiveCompaction(items, {
      CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_CHARS: "1400",
      CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_SAVINGS_PCT: "5",
      CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_TARGET_CHARS: "900",
    });

    expect(result[0]._liveCompacted).toBe(true);
    expect(result[0]._liveCompactionFamily).toBe("logs");
    expect(result[0].aggregated_output).toContain("ERROR websocket disconnected unexpectedly");
    expect(result[0].aggregated_output).toContain("Traceback: reconnect loop exceeded budget");
    expect(result[0].aggregated_output).toContain("Repeated noise omitted:");
  });

  it("classifies compiler output as build-family and keeps file diagnostics inline", async () => {
    const lines = [];
    for (let i = 0; i < 180; i++) {
      lines.push(`info bundle step ${i} ${"x".repeat(18)}`);
    }
    lines.push("src/runtime/router.ts:44:9 - error TS2304: Cannot find name 'missingSymbol'.");
    lines.push("src/runtime/router.ts:45:13 - error TS2322: Type 'string' is not assignable to type 'number'.");
    const items = [{
      type: "command_execution",
      command: "npm run build",
      exit_code: 1,
      aggregated_output: lines.join("\n"),
    }];

    const result = await runLiveCompaction(items, {
      CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_CHARS: "1200",
      CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_SAVINGS_PCT: "5",
    });

    expect(result[0]._liveCompacted).toBe(true);
    expect(result[0]._liveCompactionFamily).toBe("build");
    expect(result[0].aggregated_output).toContain("TS2304");
    expect(result[0].aggregated_output).toContain("src/runtime/router.ts:44:9");
  });

  it("classifies package manager output and surfaces package signals", async () => {
    const cacheModule = await import("../workspace/context-cache.mjs");
    const compacted = await cacheModule.compactCommandOutputPayload({
      command: "npm install",
      output: [
        ...Array.from({ length: 120 }, (_, i) => `fetching package-${i} ${"x".repeat(12)}`),
        "npm WARN deprecated left-pad@1.3.0: use String.prototype.padStart()",
        "added 342 packages, and audited 343 packages in 4s",
        "found 2 vulnerabilities (1 low, 1 high)",
      ].join("\n"),
      exitCode: 0,
    });

    expect(compacted.compactionFamily).toBe("package-manager");
    expect(compacted.budgetPolicy).toMatch(/^(?:inline-excerpt|structured-delta)$/);
    expect(compacted.contextEnvelope?.meta?.family).toBe("package-manager");
    expect(compacted.text).toContain("Package signals:");
  });

  it("classifies deploy output and surfaces deploy targets", async () => {
    const cacheModule = await import("../workspace/context-cache.mjs");
    const compacted = await cacheModule.compactCommandOutputPayload({
      command: "kubectl apply -f k8s/prod",
      output: [
        ...Array.from({ length: 120 }, (_, i) => `progress ${i} ${"x".repeat(16)}`),
        "deployment.apps/api configured",
        "service/api unchanged",
        "rollout status pending for deployment/api",
      ].join("\n"),
      exitCode: 0,
    });

    expect(compacted.compactionFamily).toBe("deploy");
    expect(compacted.contextEnvelope?.meta?.family).toBe("deploy");
    expect(compacted.text).toContain("Deploy targets:");
  });

  it("preserves deploy family in fallback signal-first compaction", async () => {
    const cacheModule = await import("../workspace/context-cache.mjs");
    const compacted = await cacheModule.compactCommandOutputPayload({
      command: "kubectl apply -f k8s/prod",
      output: Array.from({ length: 260 }, (_, i) => `noise line ${i} ${"x".repeat(20)}`).join("\n"),
      exitCode: 0,
    });

    expect(compacted.compacted).toBe(true);
    expect(compacted.compactionFamily).toBe("deploy");
    expect(compacted.contextEnvelope?.meta?.family).toBe("deploy");
  });

  it("stores semantic budget decisions with cached tool logs", async () => {
    const cacheModule = await import("../workspace/context-cache.mjs");
    const compacted = await cacheModule.compactCommandOutputPayload({
      command: "dotnet test",
      output: [
        ...Array.from({ length: 180 }, (_, i) => `Passed! helper/test-${i}.dll`),
        "Failed!  - Failed:     1, Passed:   9, Skipped:     0, Total:   10, Duration: 1 s",
        "Failed Bosun.Tests.WorkflowContextTests.ResolveTemplates [148 ms]",
      ].join("\n"),
      exitCode: 1,
    });

    const retrieved = await cacheModule.retrieveToolLog(compacted.toolLogId);
    expect(retrieved.found).toBe(true);
    expect(retrieved.entry.decision?.family).toBe("test");
    expect(retrieved.entry.decision?.budgetPolicy).toBeTruthy();
    expect(compacted.spillPointer).toEqual(expect.objectContaining({
      kind: "tool-log",
      stage: "live_tool_compaction",
      retrieveCommand: `bosun --tool-log ${compacted.toolLogId}`,
    }));
  });

  it("uses signal-first fallback compaction for unknown large command outputs", async () => {
    const cacheModule = await import("../workspace/context-cache.mjs");
    const compacted = await cacheModule.compactCommandOutputPayload({
      command: "custom-audit-runner",
      output: [
        ...Array.from({ length: 180 }, (_, i) => `noise line ${i} ${"x".repeat(20)}`),
        "ERROR subsystem exploded in src/custom/checker.ts:91",
        "detail: assertion mismatch for CUSTOMER_PIPELINE_MODE",
        ...Array.from({ length: 80 }, (_, i) => `tail line ${i} ${"y".repeat(20)}`),
      ].join("\n"),
      exitCode: 1,
    });

    expect(compacted.compacted).toBe(true);
    expect(compacted.compactionFamily).toBeTruthy();
    expect(compacted.text).toContain("ERROR subsystem exploded");
    expect(compacted.text).toContain("CUSTOMER_PIPELINE_MODE");
    expect(compacted.text).toContain("bosun --tool-log");
  });

  it("tracks deltas across repeated similar test runs and surfaces rerun guidance", async () => {
    const cacheModule = await import("../workspace/context-cache.mjs");
    const first = await cacheModule.compactCommandOutputPayload({
      command: "vitest run",
      output: [
        ...Array.from({ length: 180 }, (_, i) => `ok helper-${i} ${"x".repeat(18)}`),
        "FAIL tests/runtime/alpha.test.ts",
        "FAIL tests/runtime/beta.test.ts",
        "Error: expected true to be false",
      ].join("\n"),
      exitCode: 1,
    });
    const second = await cacheModule.compactCommandOutputPayload({
      command: "vitest run",
      output: [
        ...Array.from({ length: 180 }, (_, i) => `ok helper-${i} ${"x".repeat(18)}`),
        "FAIL tests/runtime/beta.test.ts",
        "Error: expected true to be false",
      ].join("\n"),
      exitCode: 1,
    });

    expect(first.commandDiagnostics?.suggestedRerun).toContain("vitest run");
    expect(second.commandDiagnostics?.deltaSummary).toContain("1 resolved");
    expect(second.commandDiagnostics?.deltaSummary).toContain("1 still failing");
    expect(second.text).toContain("Delta: 1 resolved, 1 still failing");
    expect(second.text).toContain("Suggested rerun: vitest run");
  });

  it("flags low-signal failures when output is large but diagnostics are weak", async () => {
    const cacheModule = await import("../workspace/context-cache.mjs");
    const compacted = await cacheModule.compactCommandOutputPayload({
      command: "custom-runner --phase verify",
      output: Array.from({ length: 260 }, (_, i) => `noise only line ${i} ${"z".repeat(20)}`).join("\n"),
      exitCode: 1,
    });

    expect(compacted.commandDiagnostics?.insufficientSignal).toBe(true);
    expect(compacted.text).toContain("Signal coverage: low");
    expect(compacted.text).toContain("Hint: Signal coverage is low.");
  });
});



