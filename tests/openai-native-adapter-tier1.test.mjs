// tests/openai-native-adapter-tier1.test.mjs
//
// Coverage for Tier 1 Bosun-native adapter additions
// (BOSUN_NATIVE_HARNESS_GAP_PLAN §D.1–D.6):
//   • shouldEnablePromptCaching auto-detect
//   • computeCacheHitPct helper
//   • BudgetExceededError class
//   • /undo, /clear, /status slash commands (no API call)
//   • shell/session-store.mjs JSONL persistence + replay

import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  createOpenAINativeAdapter,
  shouldEnablePromptCaching,
  computeCacheHitPct,
  BudgetExceededError,
  sanitizeHistoryEntriesForRequest,
} from "../shell/openai-native-adapter.mjs";
import { createToolExecutor } from "../shell/tool-executor.mjs";
import {
  createSessionStore,
  replayEvents,
} from "../shell/session-store.mjs";

describe("shouldEnablePromptCaching", () => {
  it("respects explicit providerConfig.promptCaching=true", () => {
    expect(shouldEnablePromptCaching({ promptCaching: true, model: "gpt-4o" }, {})).toBe(true);
  });

  it("respects explicit providerConfig.promptCaching=false even on Anthropic models", () => {
    expect(
      shouldEnablePromptCaching({ promptCaching: false, model: "claude-3-7-sonnet" }, {}),
    ).toBe(false);
  });

  it("auto-detects claude-* model names", () => {
    expect(shouldEnablePromptCaching({ model: "claude-3-7-sonnet-20250219" }, {})).toBe(true);
  });

  it("auto-detects anthropic/<model> routes", () => {
    expect(shouldEnablePromptCaching({ model: "anthropic/claude-3-opus" }, {})).toBe(true);
  });

  it("auto-detects openrouter-style claude routes", () => {
    expect(shouldEnablePromptCaching({ model: "openrouter/claude-3-5-sonnet" }, {})).toBe(true);
  });

  it("does not enable for plain OpenAI models", () => {
    expect(shouldEnablePromptCaching({ model: "gpt-4o" }, {})).toBe(false);
    expect(shouldEnablePromptCaching({ model: "gpt-4.1" }, {})).toBe(false);
  });

  it("respects execOptions.promptCaching when providerConfig is empty", () => {
    expect(shouldEnablePromptCaching({}, { promptCaching: true })).toBe(true);
  });

  it("auto-detects provider=anthropic", () => {
    expect(shouldEnablePromptCaching({ provider: "anthropic", model: "gpt-4o" }, {})).toBe(true);
  });
});

describe("computeCacheHitPct", () => {
  it("returns 0 when input tokens are missing or zero", () => {
    expect(computeCacheHitPct(null)).toBe(0);
    expect(computeCacheHitPct({})).toBe(0);
    expect(computeCacheHitPct({ inputTokens: 0, cacheInputTokens: 100 })).toBe(0);
  });

  it("computes percentage with one-decimal rounding", () => {
    expect(computeCacheHitPct({ inputTokens: 1000, cacheInputTokens: 500 })).toBe(50);
    expect(computeCacheHitPct({ inputTokens: 1000, cacheInputTokens: 333 })).toBe(33.3);
  });

  it("clamps results to [0, 100]", () => {
    expect(computeCacheHitPct({ inputTokens: 100, cacheInputTokens: 200 })).toBe(100);
    expect(computeCacheHitPct({ inputTokens: 100, cacheInputTokens: -5 })).toBe(0);
  });
});

describe("BudgetExceededError", () => {
  it("carries the cost/limit metadata", () => {
    const err = new BudgetExceededError("over", { sessionId: "s1", costUsd: 1.23, limitUsd: 1 });
    expect(err.name).toBe("BudgetExceededError");
    expect(err.code).toBe("BUDGET_EXCEEDED");
    expect(err.sessionId).toBe("s1");
    expect(err.costUsd).toBe(1.23);
    expect(err.limitUsd).toBe(1);
    expect(err).toBeInstanceOf(Error);
  });
});

describe("sanitizeHistoryEntriesForRequest", () => {
  it("truncates oversized request entries before they exceed OpenAI per-item limits", () => {
    const history = [
      { type: "user_message", text: "u".repeat(1800) },
      {
        type: "assistant_message",
        text: "a".repeat(1700),
        toolCalls: [{ callId: "call-1", name: "demo", arguments: "x".repeat(1600) }],
      },
      { type: "function_call_output", callId: "call-1", output: "o".repeat(1500) },
    ];

    const sanitized = sanitizeHistoryEntriesForRequest(history, { maxChars: 1024 });

    expect(sanitized[0].text.length).toBeLessThanOrEqual(1024);
    expect(sanitized[0].text).toContain("truncated");
    expect(sanitized[1].text.length).toBeLessThanOrEqual(1024);
    expect(sanitized[1].toolCalls[0].arguments.length).toBeLessThanOrEqual(1024);
    expect(sanitized[2].output.length).toBeLessThanOrEqual(1024);
  });

  it("returns the original history when no entry exceeds the cap", () => {
    const history = [
      { type: "user_message", text: "short" },
      { type: "assistant_message", text: "still short" },
    ];

    expect(sanitizeHistoryEntriesForRequest(history, { maxChars: 1024 })).toBe(history);
  });

  it("truncates oversized structured tool payloads before request serialization", () => {
    const history = [
      {
        type: "assistant_message",
        text: "tool turn",
        toolCalls: [{ callId: "call-1", name: "demo", arguments: { blob: "x".repeat(1800) } }],
      },
      { type: "function_call_output", callId: "call-1", output: { blob: "o".repeat(1900) } },
    ];

    const sanitized = sanitizeHistoryEntriesForRequest(history, { maxChars: 1024 });

    expect(typeof sanitized[0].toolCalls[0].arguments).toBe("string");
    expect(sanitized[0].toolCalls[0].arguments.length).toBeLessThanOrEqual(1024);
    expect(sanitized[0].toolCalls[0].arguments).toContain("truncated");
    expect(typeof sanitized[1].output).toBe("string");
    expect(sanitized[1].output.length).toBeLessThanOrEqual(1024);
    expect(sanitized[1].output).toContain("truncated");
  });
});

describe("native adapter slash commands", () => {
  let adapter;
  beforeEach(() => {
    adapter = createOpenAINativeAdapter();
  });

  async function seed(sessionId) {
    // Manually populate session messages by reaching through getInfo path —
    // we avoid an API call by crafting messages on the in-memory session
    // via an /undo on a clear session, then mutating the listSessions result.
    // Instead we just invoke /clear which is a no-op on a fresh session
    // but records the session id.
    const events = [];
    const onEvent = (ev) => events.push(ev);
    // Pre-populate: use /clear then push known messages by going through /undo
    // path — but the easier route is to call exec with /status which doesn't
    // mutate. To reliably seed, we use the adapter's exposed Map via
    // listSessions/getSessionMessages plus a hand-crafted session.
    // Simpler: call /clear to register the session id, then push messages by
    // invoking /undo (no-op) and then directly manipulating via the public
    // surface.  In practice we test the slash commands using messages we
    // create via the real path: a /clear initializes, then we use an
    // internal helper exposed for tests by re-importing the module's session
    // store.  Easiest of all: drive everything through real /clear + /status.
    return { events, onEvent };
  }

  it("/status reports a fresh session without making an API call", async () => {
    const events = [];
    const result = await adapter.exec("/status", {
      sessionId: "test-status-1",
      providerConfig: { model: "gpt-4o" },
      onEvent: (ev) => events.push(ev),
    });
    expect(result.ok).toBe(true);
    expect(result.status?.sessionId).toBe("test-status-1");
    expect(result.status?.model).toBe("gpt-4o");
    expect(result.status?.messageCount).toBe(0);
    const statusEv = events.find((e) => e.type === "session.status");
    expect(statusEv).toBeTruthy();
    expect(statusEv.sessionId).toBe("test-status-1");
  });

  it("/clear empties session history without an API call", async () => {
    // Initialize the session
    await adapter.exec("/status", {
      sessionId: "test-clear-1",
      providerConfig: { model: "gpt-4o" },
    });
    const events = [];
    const result = await adapter.exec("/clear", {
      sessionId: "test-clear-1",
      providerConfig: { model: "gpt-4o" },
      onEvent: (ev) => events.push(ev),
    });
    expect(result.ok).toBe(true);
    expect(result.cleared).toBe(true);
    expect(result.removedCount).toBe(0);
    const clearedEv = events.find((e) => e.type === "session.cleared");
    expect(clearedEv).toBeTruthy();
  });

  it("/undo on an empty session is a safe no-op", async () => {
    const result = await adapter.exec("/undo", {
      sessionId: "test-undo-empty",
      providerConfig: { model: "gpt-4o" },
    });
    expect(result.ok).toBe(true);
    expect(result.undone).toBe(true);
    expect(result.removedCount).toBe(0);
  });

  it("/status, /clear, and /undo never set the session as busy after returning", async () => {
    const sid = "test-busy-clear";
    await adapter.exec("/status", { sessionId: sid, providerConfig: { model: "gpt-4o" } });
    expect(adapter.isBusy(sid)).toBe(false);
    await adapter.exec("/clear", { sessionId: sid, providerConfig: { model: "gpt-4o" } });
    expect(adapter.isBusy(sid)).toBe(false);
    await adapter.exec("/undo", { sessionId: sid, providerConfig: { model: "gpt-4o" } });
    expect(adapter.isBusy(sid)).toBe(false);
  });
});

describe("shell/session-store", () => {
  let tmpRoot;
  let store;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bosun-session-store-"));
    store = createSessionStore({ rootDir: tmpRoot });
  });

  it("appends and replays a full session lifecycle", async () => {
    const sid = "lifecycle-1";
    await store.append(sid, "session.created", { model: "gpt-4o" });
    await store.append(sid, "user_message", { text: "hi" });
    await store.append(sid, "assistant_message", { text: "hello" });
    await store.append(sid, "session.usage", { inputTokens: 100, outputTokens: 50, costUsd: 0.01 });
    await store.append(sid, "session.lastResponseId", { id: "resp_abc" });

    const session = await store.load(sid);
    expect(session).not.toBeNull();
    expect(session.model).toBe("gpt-4o");
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0]).toMatchObject({ type: "user_message", text: "hi" });
    expect(session.messages[1]).toMatchObject({ type: "assistant_message", text: "hello" });
    expect(session.lastResponseId).toBe("resp_abc");
    expect(session.aggregatedUsage).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.01,
    });
  });

  it("returns null for a non-existent session", async () => {
    expect(await store.load("does-not-exist")).toBeNull();
  });

  it("lists stored sessions and removes them", async () => {
    await store.append("a", "session.created", { model: "x" });
    await store.append("b", "session.created", { model: "y" });
    const ids = await store.list();
    expect(new Set(ids)).toEqual(new Set(["a", "b"]));
    expect(await store.remove("a")).toBe(true);
    expect(await store.remove("a")).toBe(false);
    expect(new Set(await store.list())).toEqual(new Set(["b"]));
  });

  it("rejects path traversal in session ids", async () => {
    const evil = "../../../etc/passwd";
    const ok = await store.append(evil, "session.created", { model: "x" });
    expect(ok).toBe(true);
    // safeId() should have stripped the dots and slashes.
    const filePath = store.sessionPath(evil);
    expect(path.dirname(filePath)).toBe(tmpRoot);
    expect(path.basename(filePath)).not.toContain("..");
    expect(path.basename(filePath)).not.toContain("/");
    expect(path.basename(filePath)).not.toContain("\\");
  });

  it("survives a malformed (truncated) JSONL line", async () => {
    const sid = "crashy";
    await store.append(sid, "user_message", { text: "good line" });
    // Simulate a partial write at the tail.
    await fs.appendFile(store.sessionPath(sid), "{not-valid-json", "utf8");
    const session = await store.load(sid);
    expect(session).not.toBeNull();
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].text).toBe("good line");
  });

  it("session.cleared event resets messages on replay", () => {
    const session = replayEvents([
      { kind: "user_message", payload: { text: "a" }, ts: 1 },
      { kind: "assistant_message", payload: { text: "b" }, ts: 2 },
      { kind: "session.cleared", payload: {}, ts: 3 },
      { kind: "user_message", payload: { text: "c" }, ts: 4 },
    ]);
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].text).toBe("c");
  });

  it("counts session.compaction events", () => {
    const session = replayEvents([
      { kind: "session.created", payload: { model: "m" }, ts: 1 },
      { kind: "session.compaction", payload: {}, ts: 2 },
      { kind: "session.compaction", payload: {}, ts: 3 },
    ]);
    expect(session.compactionCount).toBe(2);
  });
});

describe("createToolExecutor", () => {
  it("dispatches through toolOrchestrator.execute with full session context", async () => {
    const calls = [];
    const executor = createToolExecutor();
      const toolOrchestrator = {
        async execute(toolName, args, context) {
          calls.push({ toolName, args, context });
          return {
            ok: true,
            cwd: context.cwd,
            repoRoot: context.repoRoot,
            taskKey: context.taskKey,
            requestedBy: context.requestedBy,
            adapterName: context.adapterName,
            executor: context.executor,
            sdk: context.sdk,
            providerSelection: context.providerSelection,
            providerConfig: context.providerConfig,
            toolCallId: context.toolCallId,
          };
        },
      };

    const { results } = await executor.execute([
      {
        callId: "call-1",
        name: "edit_file",
        arguments: {
          path: "workspace/shared-knowledge.mjs",
          old_string: "before",
          new_string: "after",
        },
      },
    ], {
      sessionId: "session-1",
      cwd: "C:\\repo\\worktree",
      repoRoot: "C:\\repo",
        taskKey: "task-1",
        requestedBy: "workflow:test",
        agentProfileId: "default",
        adapter: { name: "openai-native" },
        provider: "azure-openai-responses",
        providerConfig: {
          selectionId: "azure-openai-responses-2",
          provider: "azure-openai-responses",
          endpoint: "https://secondary.example/openai/v1",
          apiVersion: "2024-10-01-preview",
        },
        sessionType: "workflow-agent",
        surface: "workflow",
        model: "gpt-5.4",
        toolOrchestrator,
      });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      toolName: "edit_file",
      args: {
        path: "workspace/shared-knowledge.mjs",
        old_string: "before",
        new_string: "after",
      },
      context: {
        sessionId: "session-1",
        cwd: "C:\\repo\\worktree",
        repoRoot: "C:\\repo",
        taskKey: "task-1",
        requestedBy: "workflow:test",
        agentProfileId: "default",
        adapterName: "openai-native",
        executor: "openai-native",
        sdk: "openai-native",
        providerSelection: "azure-openai-responses",
        providerConfig: {
          selectionId: "azure-openai-responses-2",
          provider: "azure-openai-responses",
          endpoint: "https://secondary.example/openai/v1",
          apiVersion: "2024-10-01-preview",
        },
        sessionType: "workflow-agent",
        surface: "workflow",
        model: "gpt-5.4",
        toolCallId: "call-1",
      },
    });
    expect(JSON.parse(results[0].output)).toMatchObject({
      ok: true,
      cwd: "C:\\repo\\worktree",
      repoRoot: "C:\\repo",
      taskKey: "task-1",
      requestedBy: "workflow:test",
      adapterName: "openai-native",
      executor: "openai-native",
      sdk: "openai-native",
      providerSelection: "azure-openai-responses",
      providerConfig: {
        selectionId: "azure-openai-responses-2",
        provider: "azure-openai-responses",
        endpoint: "https://secondary.example/openai/v1",
        apiVersion: "2024-10-01-preview",
      },
      toolCallId: "call-1",
    });
  });

  it("times out tools even when the executor ignores abortSignal", async () => {
    const executor = createToolExecutor();
    const started = [];

    const { results, anyTimedOut } = await executor.execute([
      {
        callId: "call-timeout-1",
        name: "run_validation",
        arguments: { command: "npm test" },
      },
    ], {
      sessionId: "session-timeout-1",
      toolTimeoutMs: 25,
      toolOrchestrator: {
        async execute(toolName, args, context) {
          started.push({ toolName, args, context });
          return await new Promise(() => {});
        },
      },
    });

    expect(started).toHaveLength(1);
    expect(anyTimedOut).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0].timedOut).toBe(true);
    expect(JSON.parse(results[0].output)).toEqual({
      error: 'Tool "run_validation" timed out after 25ms.',
    });
  });
});
