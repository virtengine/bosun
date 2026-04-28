import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import {
  getSessionActivityFromStateLedger,
  resetStateLedgerCache,
} from "../lib/state-ledger-sqlite.mjs";
import {
  _test,
  addSessionStateListener,
  createSessionTracker,
  SessionTracker,
} from "../infra/session-tracker.mjs";

describe("session-tracker", () => {
  /** @type {SessionTracker} */
  let tracker;

  beforeEach(() => {
    tracker = createSessionTracker({ maxMessages: 5 });
  });

  describe("startSession / endSession", () => {
    it("resolves workspace-mirror tracker paths back to the source repo logs directory", () => {
      const sourceRepo = join(tmpdir(), "bosun-source-repo");
      const mirrorInfraDir = join(
        sourceRepo,
        ".bosun",
        "workspaces",
        "virtengine-gh",
        "bosun",
        "infra",
      );

      expect(_test.resolveSessionTrackerSourceRepoRoot(mirrorInfraDir)).toBe(sourceRepo);
    });

    it("creates a new session", () => {
      tracker.startSession("task-1", "Test Task");
      const session = tracker.getSession("task-1");

      expect(session).toBeTruthy();
      expect(session.taskId).toBe("task-1");
      expect(session.taskTitle).toBe("Test Task");
      expect(session.status).toBe("active");
      expect(session.messages).toEqual([]);
      expect(session.totalEvents).toBe(0);
    });

    it("uses a bounded default history budget for primary chat sessions", () => {
      const session = tracker.createSession({ id: "chat-default-budget", type: "primary" });
      expect(session.maxMessages).toBe(600);
    });

    it("ends a session with status", () => {
      tracker.startSession("task-1", "Test Task");
      tracker.endSession("task-1", "completed");

      const session = tracker.getSession("task-1");
      expect(session.status).toBe("no_output");
      expect(session.endedAt).toBeGreaterThan(0);
    });

    it("does not classify planner handoffs mentioning optional pre-push hooks as commit-blocked", () => {
      const status = _test.deriveTerminalSessionStatus({
        messages: [{
          role: "assistant",
          content: [
            "Editor handoff",
            "",
            "- Planned files:",
            "  - `workflow/workflow-engine.mjs`",
            "  - `tests/workflow-engine.test.mjs`",
            "  - optional `.githooks/pre-push` only if a new test file is added",
            "",
            "No code changes were made in this planning phase.",
          ].join("\n"),
        }],
      }, "completed");

      expect(status).toBe("completed");
    });

    it("replaces existing session", () => {
      tracker.startSession("task-1", "First");
      tracker.recordEvent("task-1", {
        type: "item.completed",
        item: { type: "agent_message", text: "hello" },
      });
      tracker.startSession("task-1", "Second");

      const session = tracker.getSession("task-1");
      expect(session.taskTitle).toBe("Second");
      expect(session.messages).toEqual([]);
    });

    it("returns null for non-existent session", () => {
      expect(tracker.getSession("nonexistent")).toBeNull();
    });
    it("emits state listener payloads for lifecycle changes", () => {
      const events = [];
      const unsubscribe = addSessionStateListener((payload) => events.push(payload));

      tracker.startSession("task-1", "Test Task");
      tracker.updateSessionStatus("task-1", "completed");
      tracker.renameSession("task-1", "Renamed Task");
      tracker.endSession("task-1", "completed");
      unsubscribe();

      expect(events.map((event) => event.reason)).toEqual([
        "session-created",
        "session-status",
        "session-renamed",
        "session-ended",
      ]);
      expect(events.every((event) => event.event?.kind === "state")).toBe(true);
      expect(events[0]?.session?.taskId).toBe("task-1");
    });
  });

  describe("recordEvent", () => {
    it("records Codex agent_message events", () => {
      tracker.startSession("task-1", "Test");
      tracker.recordEvent("task-1", {
        type: "item.completed",
        item: { type: "agent_message", text: "I will fix the bug" },
      });

      const messages = tracker.getLastMessages("task-1");
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("agent_message");
      expect(messages[0].content).toContain("fix the bug");
    });

    it("preserves compression metadata on normalized Codex agent messages", () => {
      tracker.startSession("task-1", "Test");
      tracker.recordEvent("task-1", {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: "Condensed summary",
          _compressed: "agent_tier1",
          _originalLength: 420,
        },
      });

      const messages = tracker.getLastMessages("task-1");
      expect(messages).toHaveLength(1);
      expect(messages[0].meta?.compression).toEqual(
        expect.objectContaining({
          kind: "agent_tier1",
          originalLength: 420,
        }),
      );
    });

    it("records Codex function_call events", () => {
      tracker.startSession("task-1", "Test");
      tracker.recordEvent("task-1", {
        type: "item.completed",
        item: { type: "function_call", name: "read_file", arguments: "/path/to/file" },
      });

      const messages = tracker.getLastMessages("task-1");
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("tool_call");
      expect(messages[0].meta.toolName).toBe("read_file");
    });

    it("records Codex function_call_output events", () => {
      tracker.startSession("task-1", "Test");
      tracker.recordEvent("task-1", {
        type: "item.completed",
        item: { type: "function_call_output", output: "file contents here" },
      });

      const messages = tracker.getLastMessages("task-1");
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("tool_result");
    });

    it("records Codex command_execution events", () => {
      tracker.startSession("task-1", "Test");
      tracker.recordEvent("task-1", {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "git status -sb",
          aggregated_output: "## main",
          status: "completed",
          exit_code: 0,
        },
      });

      const messages = tracker.getLastMessages("task-1");
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("tool_call");
      expect(messages[0].meta.toolName).toBe("command_execution");
      expect(messages[0].content).toContain("git status -sb");
      expect(messages[0].content).toContain("## main");
    });

    it("records Codex reasoning events as system messages", () => {
      tracker.startSession("task-1", "Test");
      tracker.recordEvent("task-1", {
        type: "item.completed",
        item: { type: "reasoning", text: "Planning the next edit" },
      });

      const messages = tracker.getLastMessages("task-1");
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("system");
      expect(messages[0].content).toContain("Planning the next edit");
    });

    it("records Codex reasoning update events as system messages", () => {
      tracker.startSession("task-1", "Test");
      tracker.recordEvent("task-1", {
        type: "item.updated",
        item: { type: "reasoning", text: "Inspecting workspace state" },
      });

      const messages = tracker.getLastMessages("task-1");
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("system");
      expect(messages[0].content).toContain("Inspecting workspace state");
    });

    it("records Codex command start events as tool calls", () => {
      tracker.startSession("task-1", "Test");
      tracker.recordEvent("task-1", {
        type: "item.started",
        item: { type: "command_execution", command: "npm test" },
      });

      const messages = tracker.getLastMessages("task-1");
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("tool_call");
      expect(messages[0].content).toContain("npm test");
    });

    it("records plain formatted stream lines as system messages", () => {
      tracker.startSession("task-1", "Test");
      tracker.recordEvent("task-1", ":u1f4ad: Thinking about approach");

      const messages = tracker.getLastMessages("task-1");
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("system");
      expect(messages[0].content).toContain("Thinking about approach");
    });

    it("records assistant.message events", () => {
      tracker.startSession("task-1", "Test");
      tracker.recordEvent("task-1", {
        type: "assistant.message",
        data: { content: "Done. Changes are applied." },
      });

      const messages = tracker.getLastMessages("task-1");
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("agent_message");
      expect(messages[0].content).toContain("Done. Changes are applied.");
    });

    it("records session.turn.complete text as an agent message and trajectory step", () => {
      tracker.startSession("task-1", "Test");
      tracker.recordEvent("task-1", {
        type: "session.turn.complete",
        text: "Done. Changes are applied.",
      });

      const messages = tracker.getLastMessages("task-1");
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("agent_message");
      expect(messages[0].content).toContain("Done. Changes are applied.");

      const session = tracker.getSession("task-1");
      expect(session?.trajectory?.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "agent_message",
            summary: "Done. Changes are applied.",
          }),
        ]),
      );
    });

    it("ignores low-signal stream noise for activity tracking", () => {
      tracker.startSession("task-1", "Test");
      const session = tracker.getSession("task-1");
      const before = session.lastActivityAt;

      tracker.recordEvent("task-1", { type: "turn_context" });
      tracker.recordEvent("task-1", {
        type: "event_msg",
        payload: { type: "token_count" },
      });

      const messages = tracker.getLastMessages("task-1");
      expect(messages).toHaveLength(0);
      expect(session.totalEvents).toBe(0);
      expect(session.lastActivityAt).toBe(before);
    });

    it("builds replayable trajectory steps with compact summaries", () => {
      tracker.startSession("task-1", "Replay test");
      tracker.recordEvent("task-1", {
        role: "user",
        content: "Investigate flaky tests in the API suite",
        timestamp: "2026-03-22T10:00:00.000Z",
      });
      tracker.recordEvent("task-1", {
        type: "item.completed",
        item: { type: "reasoning", text: "Checking recent failures and narrowing likely causes" },
      });
      tracker.recordEvent("task-1", {
        type: "item.started",
        item: { type: "command_execution", command: "npm test -- tests/session-api.test.mjs" },
      });
      tracker.recordEvent("task-1", {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "npm test -- tests/session-api.test.mjs",
          aggregated_output: "1 failed, 12 passed",
          status: "completed",
          exit_code: 1,
        },
      });
      tracker.recordEvent("task-1", {
        type: "assistant.message",
        data: { content: "Found a stale session fixture; patching the failing expectation." },
      });

      const session = tracker.getSession("task-1");
      expect(Array.isArray(session.trajectory?.steps)).toBe(true);
      expect(session.trajectory.steps.length).toBeGreaterThanOrEqual(4);
      expect(session.trajectory.steps[0]).toEqual(
        expect.objectContaining({
          kind: "user_message",
          summary: "Investigate flaky tests in the API suite",
        }),
      );
      expect(session.trajectory.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "reasoning",
            summary: expect.stringMatching(/checking recent failures/i),
          }),
          expect.objectContaining({
            kind: "tool_call",
            summary: "Ran npm test -- tests/session-api.test.mjs",
          }),
          expect.objectContaining({
            kind: "tool_result",
            summary: expect.stringMatching(/npm test -- tests\/session-api\.test\.mjs/i),
          }),
          expect.objectContaining({
            kind: "agent_message",
            summary: expect.stringMatching(/found a stale session fixture/i),
          }),
        ]),
      );
    });

    it("persists trajectory data across disk reloads", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "bosun-session-tracker-"));
      try {
      const persisted = new SessionTracker({ persistDir: tempDir, flushIntervalMs: 5 });
      persisted.startSession("task-2", "Persist replay test");
      persisted.recordEvent("task-2", {
        role: "user",
        content: "Resume the failed run from the last meaningful step",
      });
      persisted.recordEvent("task-2", {
        type: "assistant.message",
        data: { content: "I will continue from the last failing command." },
      });
      persisted.updateSessionStatus("task-2", "failed");
      persisted.flushNow();

      const restored = new SessionTracker({ persistDir: tempDir, flushIntervalMs: 5 });
      const session = restored.getSession("task-2");
      expect(session?.trajectory?.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "user_message" }),
          expect.objectContaining({ kind: "agent_message" }),
        ]),
      );
      expect(session?.summary).toEqual(
        expect.objectContaining({
          shortSteps: expect.arrayContaining([
            expect.objectContaining({ summary: expect.stringMatching(/resume the failed run/i) }),
          ]),
        }),
      );
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("persists delegated session lineage metadata and exposes it in summaries", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "bosun-session-tracker-lineage-"));
      try {
        const persisted = new SessionTracker({ persistDir: tempDir, flushIntervalMs: 5 });
        persisted.createSession({
          id: "TASK-42:delegate:run-1:handoff",
          type: "delegate",
          taskId: "TASK-42",
          metadata: {
            title: "Child delegate session",
            workspaceId: "virtengine-gh",
            rootTaskId: "TASK-42",
            parentTaskId: "TASK-42",
            rootSessionId: "TASK-42",
            parentSessionId: "TASK-42",
            rootRunId: "run-root-1",
            parentRunId: "run-parent-1",
            delegationDepth: 2,
          },
        });
        persisted.recordEvent("TASK-42:delegate:run-1:handoff", {
          role: "assistant",
          content: "Delegated workflow finished successfully.",
        });
        persisted.endSession("TASK-42:delegate:run-1:handoff", "completed");
        persisted.flushNow();
        persisted.destroy();

        const restored = new SessionTracker({ persistDir: tempDir, flushIntervalMs: 5 });
        const session = restored.getSession("TASK-42:delegate:run-1:handoff");
        const summary = restored.listAllSessions().find((entry) => entry.id === "TASK-42:delegate:run-1:handoff");
        expect(session?.metadata).toEqual(expect.objectContaining({
          rootTaskId: "TASK-42",
          parentTaskId: "TASK-42",
          rootSessionId: "TASK-42",
          parentSessionId: "TASK-42",
          rootRunId: "run-root-1",
          parentRunId: "run-parent-1",
          delegationDepth: 2,
        }));
        expect(summary).toEqual(expect.objectContaining({
          taskId: "TASK-42",
          rootTaskId: "TASK-42",
          parentTaskId: "TASK-42",
          rootSessionId: "TASK-42",
          parentSessionId: "TASK-42",
          rootRunId: "run-root-1",
          parentRunId: "run-parent-1",
          delegationDepth: 2,
        }));
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("backfills persisted sessions into the sqlite session_activity index on reload", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "bosun-session-tracker-backfill-"));
      const repoRoot = mkdtempSync(join(tmpdir(), "bosun-session-tracker-ledger-"));
      const sandboxLedgerDir = mkdtempSync(join(tmpdir(), "bosun-session-tracker-sandbox-ledger-"));
      const sandboxLedgerPath = join(sandboxLedgerDir, "state-ledger.sqlite");
      const previousRepoRoot = process.env.REPO_ROOT;
      const previousLedgerPath = process.env.BOSUN_STATE_LEDGER_PATH;
      process.env.REPO_ROOT = repoRoot;
      process.env.BOSUN_STATE_LEDGER_PATH = sandboxLedgerPath;
      try {
        writeFileSync(join(tempDir, "persisted-session-1.json"), JSON.stringify({
          id: "persisted-session-1",
          taskId: "persisted-session-1",
          taskTitle: "Persisted session",
          type: "primary",
          status: "completed",
          createdAt: "2026-03-31T09:00:00.000Z",
          lastActiveAt: "2026-03-31T09:10:00.000Z",
          startedAt: Date.parse("2026-03-31T09:00:00.000Z"),
          endedAt: Date.parse("2026-03-31T09:10:00.000Z"),
          turnCount: 1,
          messages: [
            {
              role: "assistant",
              content: "Recovered from disk",
              timestamp: "2026-03-31T09:10:00.000Z",
            },
          ],
          metadata: {
            title: "Persisted session",
            workspaceId: "workspace-reload",
            workspaceDir: join(repoRoot, "workspace-reload"),
            workspaceRoot: repoRoot,
            workflowId: "wf-reload",
            workflowName: "Reload Workflow",
          },
        }, null, 2));

        const restored = new SessionTracker({ persistDir: tempDir, flushIntervalMs: 5 });
        const session = restored.getSessionMessages("persisted-session-1");
        expect(session?.id).toBe("persisted-session-1");

        const ledgerSession = getSessionActivityFromStateLedger("persisted-session-1", { repoRoot });
        expect(ledgerSession).toEqual(expect.objectContaining({
          sessionId: "persisted-session-1",
          workspaceId: "workspace-reload",
          latestWorkflowId: "wf-reload",
          latestWorkflowName: "Reload Workflow",
          document: expect.objectContaining({
            workspaceDir: join(repoRoot, "workspace-reload"),
            workspaceRoot: repoRoot,
            metadata: expect.objectContaining({
              workspaceId: "workspace-reload",
              workspaceDir: join(repoRoot, "workspace-reload"),
              workspaceRoot: repoRoot,
            }),
          }),
        }));
        restored.destroy();
      } finally {
        resetStateLedgerCache();
        if (previousRepoRoot === undefined) delete process.env.REPO_ROOT;
        else process.env.REPO_ROOT = previousRepoRoot;
        if (previousLedgerPath === undefined) delete process.env.BOSUN_STATE_LEDGER_PATH;
        else process.env.BOSUN_STATE_LEDGER_PATH = previousLedgerPath;
        rmSync(tempDir, { recursive: true, force: true });
        rmSync(repoRoot, { recursive: true, force: true });
        rmSync(sandboxLedgerDir, { recursive: true, force: true });
      }
    });

    it("records Copilot message events", () => {
      tracker.startSession("task-1", "Test");
      tracker.recordEvent("task-1", {
        type: "message",
        content: "copilot says hello",
      });

      const messages = tracker.getLastMessages("task-1");
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("agent_message");
    });

    it("records Claude content_block_delta events", () => {
      tracker.startSession("task-1", "Test");
      tracker.recordEvent("task-1", {
        type: "content_block_delta",
        delta: { text: "claude response" },
      });

      const messages = tracker.getLastMessages("task-1");
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("agent_message");
    });

    it("records error events", () => {
      tracker.startSession("task-1", "Test");
      tracker.recordEvent("task-1", {
        type: "error",
        error: { message: "rate limit exceeded" },
      });

      const messages = tracker.getLastMessages("task-1");
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe("error");
      expect(messages[0].content).toContain("rate limit");
    });

    it("respects maxMessages ring buffer", () => {
      tracker.startSession("task-1", "Test");

      for (let i = 0; i < 10; i++) {
        tracker.recordEvent("task-1", {
          type: "item.completed",
          item: { type: "agent_message", text: `message ${i}` },
        });
      }

      const messages = tracker.getLastMessages("task-1");
      expect(messages).toHaveLength(5); // maxMessages = 5
      expect(messages[0].content).toContain("message 5");
      expect(messages[4].content).toContain("message 9");

      const session = tracker.getSession("task-1");
      expect(session.totalEvents).toBe(10);
    });

    it("ignores events for non-existent sessions", () => {
      // Should not throw
      tracker.recordEvent("nonexistent", {
        type: "item.completed",
        item: { type: "agent_message", text: "hello" },
      });
    });

    it("skips uninteresting events", () => {
      tracker.startSession("task-1", "Test");
      tracker.recordEvent("task-1", { type: "item.created", item: { type: "session" } });

      // item.created is not tracked as a message
      const messages = tracker.getLastMessages("task-1");
      expect(messages).toHaveLength(0);

      // Low-signal events should not keep the session alive
      const session = tracker.getSession("task-1");
      expect(session.totalEvents).toBe(0);
    });
  });

  describe("getMessageSummary", () => {
    it("returns formatted summary", () => {
      tracker.startSession("task-1", "Fix Bug");
      tracker.recordEvent("task-1", {
        type: "item.completed",
        item: { type: "agent_message", text: "Analyzing the code" },
      });
      tracker.recordEvent("task-1", {
        type: "item.completed",
        item: { type: "function_call", name: "read_file", arguments: "main.go" },
      });

      const summary = tracker.getMessageSummary("task-1");
      expect(summary).toContain("Fix Bug");
      expect(summary).toContain("AGENT");
      expect(summary).toContain("TOOL");
      expect(summary).toContain("read_file");
    });

    it("returns placeholder for empty sessions", () => {
      tracker.startSession("task-1", "Test");
      const summary = tracker.getMessageSummary("task-1");
      expect(summary).toContain("no session messages recorded");
    });

    it("returns placeholder for non-existent sessions", () => {
      const summary = tracker.getMessageSummary("nonexistent");
      expect(summary).toContain("no session messages recorded");
    });
  });

  describe("isSessionIdle", () => {
    it("detects idle sessions", () => {
      const shortTracker = createSessionTracker({ idleThresholdMs: 50 });
      shortTracker.startSession("task-1", "Test");

      expect(shortTracker.isSessionIdle("task-1")).toBe(false);

      // Hack: manually set lastActivityAt in the past
      const session = shortTracker.getSession("task-1");
      session.lastActivityAt = Date.now() - 100;

      expect(shortTracker.isSessionIdle("task-1")).toBe(true);
    });

    it("returns false for non-existent sessions", () => {
      expect(tracker.isSessionIdle("nonexistent")).toBe(false);
    });
  });

  describe("removeSession / getStats", () => {
    it("removes sessions", () => {
      tracker.startSession("task-1", "Test");
      tracker.removeSession("task-1");
      expect(tracker.getSession("task-1")).toBeNull();
    });

    it("suppresses late-event auto-recreation after a session is removed", () => {
      tracker.createSession({ id: "task-retired", type: "primary" });
      tracker.removeSession("task-retired");

      tracker.recordEvent("task-retired", {
        role: "assistant",
        type: "agent_message",
        content: "late event should be ignored",
        timestamp: new Date().toISOString(),
      });
      expect(tracker.getSession("task-retired")).toBeNull();

      tracker.createSession({ id: "task-retired", type: "primary" });
      tracker.recordEvent("task-retired", {
        role: "assistant",
        type: "agent_message",
        content: "fresh event should be accepted",
        timestamp: new Date().toISOString(),
      });

      const session = tracker.getSession("task-retired");
      expect(session).toBeTruthy();
      expect(session.messages.at(-1)?.content).toContain("fresh event should be accepted");
    });

    it("tracks stats", () => {
      tracker.startSession("task-1", "Test 1");
      tracker.startSession("task-2", "Test 2");
      tracker.endSession("task-1", "completed");

      const stats = tracker.getStats();
      expect(stats.total).toBe(2);
      expect(stats.active).toBe(1);
      expect(stats.completed).toBe(1);
    });
  });

  describe("persisted insights", () => {
    it("derives idle and stalled list statuses for active sessions", () => {
      vi.useFakeTimers();
      try {
        const timedTracker = createSessionTracker({ maxMessages: 10, idleThresholdMs: 1000, persistDir: null });
        timedTracker.createSession({ id: "chat-idle", type: "primary" });
        timedTracker.createSession({ id: "chat-stalled", type: "primary" });

        vi.advanceTimersByTime(1500);
        timedTracker.recordEvent("chat-idle", {
          type: "assistant",
          role: "assistant",
          content: "still working",
          timestamp: new Date().toISOString(),
        });
        vi.advanceTimersByTime(1200);

        const listed = timedTracker.listAllSessions();
        expect(listed.find((entry) => entry.id === "chat-idle")?.status).toBe("idle");
        expect(listed.find((entry) => entry.id === "chat-stalled")?.status).toBe("stalled");
      } finally {
        vi.useRealTimers();
      }
    });

    it("preserves lifecycle status separately from runtime state in list payloads", () => {
      vi.useFakeTimers();
      try {
        const timedTracker = createSessionTracker({ maxMessages: 10, idleThresholdMs: 1000, persistDir: null });
        timedTracker.createSession({ id: "chat-runtime", type: "primary" });

        vi.advanceTimersByTime(1200);

        const listed = timedTracker.listAllSessions().find((entry) => entry.id === "chat-runtime");
        expect(listed).toEqual(
          expect.objectContaining({
            status: "idle",
            lifecycleStatus: "active",
            runtimeState: "idle",
            runtimeIsLive: false,
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("stores inspector insights on sessions and reloads them from disk", () => {
      const persistDir = mkdtempSync(join(tmpdir(), "bosun-session-tracker-"));
      try {
        const persistentTracker = createSessionTracker({ maxMessages: 10, persistDir });
        persistentTracker.createSession({ id: "chat-1", type: "primary" });
        persistentTracker.recordEvent("chat-1", {
          role: "system",
          type: "system",
          content: "Context Window\n103.2K / 272K tokens • 38%\nMessages 4.2%",
          timestamp: "2026-03-04T01:00:00.000Z",
        });
        persistentTracker.recordEvent("chat-1", {
          type: "item.completed",
          item: { type: "function_call", name: "read_file", arguments: "ui/app.js" },
        });
        persistentTracker.flush();
        persistentTracker.destroy();

        const reloadedTracker = createSessionTracker({ maxMessages: 10, persistDir });
        const session = reloadedTracker.getSessionMessages("chat-1");
        const listed = reloadedTracker.listAllSessions().find((entry) => entry.id === "chat-1");

        expect(session?.insights?.totals?.toolCalls).toBe(1);
        expect(session?.insights?.contextWindow?.percent).toBe(38);
        expect(listed?.insights?.contextWindow?.usedTokens).toBe(103200);

        reloadedTracker.destroy();
      } finally {
        rmSync(persistDir, { recursive: true, force: true });
      }
    });

    it("hydrates persisted sessions before recording events or updating status", () => {
      const persistDir = mkdtempSync(join(tmpdir(), "bosun-session-tracker-"));
      try {
        const persistentTracker = createSessionTracker({ maxMessages: 10, persistDir });
        persistentTracker.createSession({
          id: "persisted-delegate-session",
          type: "task-delegate",
          metadata: {
            title: "Persisted Delegate Session",
            parentSessionId: "persisted-parent-session",
          },
        });
        persistentTracker.recordEvent("persisted-delegate-session", {
          role: "system",
          content: "[Delegation] Started live session delegate-live-child",
          timestamp: "2026-04-25T00:00:00.000Z",
        });
        persistentTracker.flush();
        persistentTracker.destroy();

        const reloadedTracker = createSessionTracker({ maxMessages: 10, persistDir });
        expect(reloadedTracker.getSessionById("persisted-delegate-session")).toEqual(
          expect.objectContaining({
            id: "persisted-delegate-session",
            status: "active",
          }),
        );

        reloadedTracker.recordEvent("persisted-delegate-session", {
          role: "system",
          content: "[Delegation Cancelled] Session aborted because parent requested cancellation",
          timestamp: "2026-04-25T00:01:00.000Z",
        });
        reloadedTracker.updateSessionStatus("persisted-delegate-session", "aborted");

        const session = reloadedTracker.getSessionMessages("persisted-delegate-session");
        expect(session?.status).toBe("aborted");
        expect(session?.messages).toEqual(expect.arrayContaining([
          expect.objectContaining({
            content: "[Delegation] Started live session delegate-live-child",
          }),
          expect.objectContaining({
            content: "[Delegation Cancelled] Session aborted because parent requested cancellation",
          }),
        ]));
        reloadedTracker.destroy();
      } finally {
        rmSync(persistDir, { recursive: true, force: true });
      }
    });

    it("stores replayable trajectories with normalized step summaries", () => {
      const persistDir = mkdtempSync(join(tmpdir(), "bosun-session-tracker-"));
      try {
        const persistentTracker = createSessionTracker({ maxMessages: 20, persistDir });
        persistentTracker.createSession({ id: "chat-replay", type: "primary" });
        persistentTracker.recordEvent("chat-replay", {
          type: "item.started",
          item: { type: "reasoning", text: "Inspecting workspace state" },
        });
        persistentTracker.recordEvent("chat-replay", {
          type: "item.completed",
          item: { type: "function_call", name: "read_file", arguments: "ui/app.js" },
        });
        persistentTracker.recordEvent("chat-replay", {
          type: "item.completed",
          item: { type: "agent_message", text: "Patched the session sidebar and validated the state flow." },
        });
        persistentTracker.recordEvent("chat-replay", {
          type: "item.completed",
          item: {
            type: "command_execution",
            command: "npm test -- tests/session-tracker.test.mjs",
            status: "completed",
            exit_code: 0,
            aggregated_output: "1 passed",
          },
        });
        persistentTracker.flush();
        const session = persistentTracker.getSessionMessages("chat-replay");

        expect(session?.trajectory).toEqual(
          expect.objectContaining({
            version: 1,
            replayable: true,
            steps: expect.arrayContaining([
              expect.objectContaining({ kind: "reasoning", summary: "Inspecting workspace state" }),
              expect.objectContaining({ kind: "tool_call", summary: "read_file ui/app.js" }),
              expect.objectContaining({ kind: "assistant", summary: "Patched the session sidebar and validated the state flow." }),
              expect.objectContaining({ kind: "command", summary: "npm test -- tests/session-tracker.test.mjs" }),
            ]),
          }),
        );
        expect(session?.trajectory?.steps.every((step) => typeof step.id === "string" && step.id.length > 0)).toBe(true);
        expect(session?.trajectory?.steps.every((step) => typeof step.timestamp === "string" && step.timestamp.length > 0)).toBe(true);
        expect(session?.summary).toMatchObject({
          failedOrLongRun: false,
          resumable: false,
          totalSteps: 4,
        });
        expect(session?.summary?.shortSteps.map((step) => step.summary)).toEqual([
          "Inspecting workspace state",
          "read_file ui/app.js",
          "Patched the session sidebar and validated the state flow.",
          "npm test -- tests/session-tracker.test.mjs",
        ]);
        expect(session?.summary?.latestStep?.summary).toBe("npm test -- tests/session-tracker.test.mjs");

        persistentTracker.destroy();

        const reloadedTracker = createSessionTracker({ maxMessages: 20, persistDir });
        const reloaded = reloadedTracker.getSessionMessages("chat-replay");
        expect(reloaded?.trajectory?.steps).toHaveLength(4);
        expect(reloaded?.trajectory?.steps.map((step) => step.summary)).toEqual([
          "Inspecting workspace state",
          "read_file ui/app.js",
          "Patched the session sidebar and validated the state flow.",
          "npm test -- tests/session-tracker.test.mjs",
        ]);
        expect(reloaded?.summary?.shortSteps.map((step) => step.summary)).toEqual([
          "Inspecting workspace state",
          "read_file ui/app.js",
          "Patched the session sidebar and validated the state flow.",
          "npm test -- tests/session-tracker.test.mjs",
        ]);
        reloadedTracker.destroy();
      } finally {
        rmSync(persistDir, { recursive: true, force: true });
      }
    });

    it("marks failed or long runs as resumable and trims short summaries", () => {
      tracker = createSessionTracker({ maxMessages: 50, persistDir: null });
      tracker.createSession({ id: "chat-resume", type: "primary" });

      for (let index = 0; index < 14; index += 1) {
        tracker.recordEvent("chat-resume", {
          role: "assistant",
          content: "Step " + (index + 1) + " completed",
          timestamp: new Date(Date.now() + index * 1000).toISOString(),
        });
      }
      tracker.updateSessionStatus("chat-resume", "failed");

      const session = tracker.getSessionMessages("chat-resume");
      expect(session?.summary?.failedOrLongRun).toBe(true);
      expect(session?.summary?.resumable).toBe(true);
      expect(session?.summary?.shortSteps).toHaveLength(12);
      expect(session?.summary?.shortSteps[0]?.summary).toBe("Step 3 completed");
      expect(session?.summary?.latestStep?.summary).toBe("Step 14 completed");
    });

    it("keeps trajectory steps when message ring buffer truncates", () => {
      tracker = createSessionTracker({ maxMessages: 2, persistDir: null });
      tracker.createSession({ id: "chat-truncate", type: "primary" });

      tracker.recordEvent("chat-truncate", {
        type: "item.completed",
        item: { type: "reasoning", text: "Step one analysis" },
      });
      tracker.recordEvent("chat-truncate", {
        type: "item.completed",
        item: { type: "function_call", name: "read_file", arguments: "task/task-executor.mjs" },
      });
      tracker.recordEvent("chat-truncate", {
        type: "item.completed",
        item: { type: "agent_message", text: "Implemented the replay plumbing." },
      });

      expect(tracker.getLastMessages("chat-truncate")).toHaveLength(2);
      const session = tracker.getSessionMessages("chat-truncate");
      expect(session?.trajectory?.steps.map((step) => step.summary)).toEqual([
        "Step one analysis",
        "read_file task/task-executor.mjs",
        "Implemented the replay plumbing.",
      ]);
    });
  });
});
