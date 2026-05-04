import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AnomalyDetector,
  AnomalyType,
  Severity,
  createAnomalyDetector,
} from "../infra/anomaly-detector.mjs";

// Helper to make a detector with captured anomalies
function makeDetector(opts = {}) {
  const anomalies = [];
  const notifications = [];
  const detector = new AnomalyDetector({
    onAnomaly: (a) => anomalies.push(a),
    notify: (text) => notifications.push(text),
    thresholds: {
      // Lower thresholds for faster testing
      toolCallLoopWarn: 3,
      toolCallLoopKill: 6,
      rebaseWarn: 3,
      rebaseKill: 6,
      gitPushWarn: 2,
      gitPushKill: 4,
      subagentWarn: 3,
      subagentKill: 6,
      toolFailureWarn: 3,
      toolFailureKill: 8,
      thoughtSpinWarn: 5,
      thoughtSpinKill: 10,
      modelFailureKill: 2,
      repeatedErrorWarn: 3,
      repeatedErrorKill: 5,
      idleStallWarnSec: 2,
      idleStallKillSec: 5,
      commandFailureRateWarn: 25,
      alertDedupWindowMs: 100, // Short dedup for tests
      processCleanupMs: 1000,
      ...opts,
    },
  });
  return { detector, anomalies, notifications };
}

const PID = "abcdef12-3456-7890-abcd-ef1234567890";
const META = { processId: PID, stream: "stdout" };

describe("AnomalyDetector", () => {
  let detector;
  let anomalies;
  let notifications;

  beforeEach(() => {
    const d = makeDetector();
    detector = d.detector;
    anomalies = d.anomalies;
    notifications = d.notifications;
  });

  afterEach(() => {
    detector.stop();
  });

  describe("Token Overflow (P0)", () => {
    it("detects token overflow and marks process dead", () => {
      const line =
        "Error: CAPIError: 400 prompt token count of 292514 exceeds the limit of 272000";
      detector.processLine(line, META);

      expect(anomalies).toHaveLength(1);
      expect(anomalies[0].type).toBe(AnomalyType.TOKEN_OVERFLOW);
      expect(anomalies[0].severity).toBe(Severity.CRITICAL);
      expect(anomalies[0].action).toBe("kill");
      expect(anomalies[0].data.tokenCount).toBe(292514);
      expect(anomalies[0].data.limit).toBe(272000);
    });

    it("stops processing lines after token overflow (dead process)", () => {
      const overflowLine =
        "CAPIError: 400 prompt token count of 500000 exceeds the limit of 272000";
      detector.processLine(overflowLine, META);
      expect(anomalies).toHaveLength(1);

      // Further lines should be ignored
      detector.processLine('{"ToolCall":{"title":"apply_patch"}}', META);
      expect(anomalies).toHaveLength(1); // No new anomalies
    });
  });

  describe("Model Not Supported (P0)", () => {
    it("warns on first failure at medium severity, kills at threshold", () => {
      const line = "CAPIError: 400 The requested model is not supported";
      detector.processLine(line, META);
      expect(anomalies).toHaveLength(1);
      // First failure is MEDIUM — model issues are external, not immediately actionable
      expect(anomalies[0].severity).toBe(Severity.MEDIUM);
      expect(anomalies[0].action).toBe("warn");

      // Second failure hits kill threshold (modelFailureKill=2 in test config)
      detector.processLine(line, META);
      const kills = anomalies.filter(
        (a) =>
          a.type === AnomalyType.MODEL_NOT_SUPPORTED && a.action === "kill",
      );
      expect(kills.length).toBeGreaterThanOrEqual(1);
      expect(kills[0].severity).toBe(Severity.HIGH);
    });
  });

  describe("Stream Death (P1)", () => {
    it("detects stream completion error", () => {
      const line = "Stream completed without a response.completed event";
      detector.processLine(line, META);

      expect(anomalies).toHaveLength(1);
      expect(anomalies[0].type).toBe(AnomalyType.STREAM_DEATH);
      expect(anomalies[0].severity).toBe(Severity.HIGH);
      expect(anomalies[0].action).toBe("restart");
    });
  });

  describe("Tool Call Loop (P2)", () => {
    it("detects consecutive identical tool calls", () => {
      const line =
        '{"ToolCall":{"toolCallId":"tc1","title":"apply_patch","kind":"execute","rawInput":{}}}';

      // Below threshold — no anomaly
      detector.processLine(line, META);
      detector.processLine(line, META);
      expect(anomalies).toHaveLength(0);

      // Hit warn threshold (3)
      detector.processLine(line, META);
      expect(anomalies).toHaveLength(1);
      expect(anomalies[0].type).toBe(AnomalyType.TOOL_CALL_LOOP);
      expect(anomalies[0].severity).toBe(Severity.MEDIUM);
    });

    it("resets counter when different tool is called", () => {
      const line1 =
        '{"ToolCall":{"toolCallId":"tc1","title":"apply_patch","kind":"execute"}}';
      const line2 =
        '{"ToolCall":{"toolCallId":"tc2","title":"read_file","kind":"execute"}}';

      detector.processLine(line1, META);
      detector.processLine(line1, META);
      detector.processLine(line2, META); // Resets
      detector.processLine(line2, META);

      // Never hit threshold — no anomalies
      expect(anomalies).toHaveLength(0);
    });

    it("escalates to HIGH at kill threshold", async () => {
      const line =
        '{"ToolCall":{"toolCallId":"tc1","title":"apply_patch","kind":"execute","rawInput":{}}}';

      for (let i = 0; i < 6; i++) {
        detector.processLine(line, META);
      }

      // Should have at least a HIGH severity anomaly at kill threshold
      const highs = anomalies.filter((a) => a.severity === Severity.HIGH);
      expect(highs.length).toBeGreaterThanOrEqual(1);
      expect(highs[0].action).toBe("kill");
    });

    it("does NOT false-positive on different edits to the same file", () => {
      // Simulates an agent making 15 DIFFERENT edits to the same test file
      // (each edit has different rawInput content — this is normal development)
      for (let i = 0; i < 15; i++) {
        const line = `{"ToolCall":{"toolCallId":"tc${i}","title":"Editing x/take/keeper/keeper_test.go","kind":"execute","rawInput":{"oldString":"line ${i} old","newString":"line ${i} new"}}}`;
        detector.processLine(line, META);
      }

      // No anomaly should fire — each edit is different content
      const loopAnomalies = anomalies.filter(
        (a) => a.type === AnomalyType.TOOL_CALL_LOOP,
      );
      expect(loopAnomalies).toHaveLength(0);
    });

    it("DOES detect truly identical edits to the same file (real death loop)", () => {
      // Same file, same content every time — this IS a death loop
      const line =
        '{"ToolCall":{"toolCallId":"tc1","title":"Editing x/take/keeper/keeper_test.go","kind":"execute","rawInput":{"oldString":"same old","newString":"same new"}}}';

      // Iterative tools get 3x thresholds: warn = 9, kill = 18
      for (let i = 0; i < 9; i++) {
        detector.processLine(line, META);
      }

      const warns = anomalies.filter(
        (a) => a.type === AnomalyType.TOOL_CALL_LOOP && a.severity === Severity.MEDIUM,
      );
      expect(warns.length).toBeGreaterThanOrEqual(1);
      expect(warns[0].message).toContain("identical content");
    });

    it("applies elevated thresholds for iterative tools (Editing, Reading)", () => {
      // Non-iterative tool hits warn at 3
      const nonIterative =
        '{"ToolCall":{"toolCallId":"tc1","title":"apply_patch","kind":"execute","rawInput":{}}}';
      for (let i = 0; i < 3; i++) {
        detector.processLine(nonIterative, META);
      }
      expect(anomalies.filter((a) => a.type === AnomalyType.TOOL_CALL_LOOP)).toHaveLength(1);

      // Reset for a fresh process
      const d2 = makeDetector();
      const editLine =
        '{"ToolCall":{"toolCallId":"tc1","title":"Editing src/foo.go","kind":"execute","rawInput":{"old":"x","new":"y"}}}';

      // Iterative tool should NOT warn at 3 (3x multiplier means warn at 9)
      for (let i = 0; i < 3; i++) {
        d2.detector.processLine(editLine, META);
      }
      const editLoops = d2.anomalies.filter((a) => a.type === AnomalyType.TOOL_CALL_LOOP);
      expect(editLoops).toHaveLength(0);
      d2.detector.stop();
    });

    it("ignores toolCallId differences when fingerprinting", () => {
      // Same content, different toolCallId — should still count as consecutive
      const line1 =
        '{"ToolCall":{"toolCallId":"aaaa","title":"apply_patch","kind":"execute","rawInput":{"content":"x"}}}';
      const line2 =
        '{"ToolCall":{"toolCallId":"bbbb","title":"apply_patch","kind":"execute","rawInput":{"content":"x"}}}';
      const line3 =
        '{"ToolCall":{"toolCallId":"cccc","title":"apply_patch","kind":"execute","rawInput":{"content":"x"}}}';

      detector.processLine(line1, META);
      detector.processLine(line2, META);
      detector.processLine(line3, META);

      // Should detect loop at 3 (same content despite different toolCallIds)
      const loops = anomalies.filter((a) => a.type === AnomalyType.TOOL_CALL_LOOP);
      expect(loops.length).toBeGreaterThanOrEqual(1);
    });

    it("detects near-identical non-iterative tool calls with only volatile arg drift", () => {
      const lines = [
        '{"ToolCall":{"toolCallId":"tc1","title":"run_in_terminal","kind":"execute","rawInput":{"command":"npm test -- --shard 101 --tmp C:/tmp/run-1234567890"}}}',
        '{"ToolCall":{"toolCallId":"tc2","title":"run_in_terminal","kind":"execute","rawInput":{"command":"npm test -- --shard 102 --tmp C:/tmp/run-1234567891"}}}',
        '{"ToolCall":{"toolCallId":"tc3","title":"run_in_terminal","kind":"execute","rawInput":{"command":"npm test -- --shard 103 --tmp C:/tmp/run-1234567892"}}}',
      ];

      for (const line of lines) {
        detector.processLine(line, META);
      }

      const loops = anomalies.filter((a) => a.type === AnomalyType.TOOL_CALL_LOOP);
      expect(loops.length).toBeGreaterThanOrEqual(1);
      expect(loops[0].message).toContain("near-identical");
      expect(loops[0].data.loopKind).toBe("near_identical");
    });
  });

  describe("Rebase Spiral (P1)", () => {
    it("detects repeated rebase --continue", () => {
      const line = '{"command":"git rebase --continue"}';

      for (let i = 0; i < 3; i++) {
        detector.processLine(line, META);
      }

      expect(anomalies.length).toBeGreaterThanOrEqual(1);
      expect(anomalies[0].type).toBe(AnomalyType.REBASE_SPIRAL);
    });

    it("counts rebase --abort separately", () => {
      detector.processLine("git rebase --continue", META);
      detector.processLine("git rebase --abort", META);
      detector.processLine("git rebase --continue", META);

      // Only 2 rebase continues — below threshold of 3
      expect(
        anomalies.filter((a) => a.type === AnomalyType.REBASE_SPIRAL),
      ).toHaveLength(0);
    });
  });

  describe("Git Push Loop (P2)", () => {
    it("detects repeated git push", () => {
      detector.processLine("git push --set-upstream origin ve/branch", META);
      detector.processLine("git push origin main", META);

      const pushAnomalies = anomalies.filter(
        (a) => a.type === AnomalyType.GIT_PUSH_LOOP,
      );
      expect(pushAnomalies.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Subagent Waste (P2)", () => {
    it("detects excessive subagent spawning", () => {
      const line =
        '{"ToolCall":{"toolCallId":"tc1","title":"spawn","kind":"execute","rawInput":{"prompt":"do stuff","description":"stuff"}}}';

      for (let i = 0; i < 3; i++) {
        detector.processLine(line, META);
      }

      const subagentAnomalies = anomalies.filter(
        (a) => a.type === AnomalyType.SUBAGENT_WASTE,
      );
      expect(subagentAnomalies.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Tool Failures (P3)", () => {
    it("detects cascading tool failures", () => {
      const line =
        '{"ToolUpdate":{"toolCallId":"tc1","status":"failed","rawOutput":{"message":"Path does not exist"}}}';

      for (let i = 0; i < 3; i++) {
        detector.processLine(line, META);
      }

      const failAnomalies = anomalies.filter(
        (a) => a.type === AnomalyType.TOOL_FAILURE_CASCADE,
      );
      expect(failAnomalies.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Thought Spinning (P3)", () => {
    it("detects repeated identical thoughts", () => {
      const line = '{"Thought":{"type":"text","text":"Continuing rebase"}}';

      for (let i = 0; i < 5; i++) {
        detector.processLine(line, META);
      }

      const spinAnomalies = anomalies.filter(
        (a) => a.type === AnomalyType.THOUGHT_SPINNING,
      );
      expect(spinAnomalies.length).toBeGreaterThanOrEqual(1);
    });

    it("ignores short thoughts (single tokens)", () => {
      const line = '{"Thought":{"type":"text","text":"I"}}';

      for (let i = 0; i < 20; i++) {
        detector.processLine(line, META);
      }

      const spinAnomalies = anomalies.filter(
        (a) => a.type === AnomalyType.THOUGHT_SPINNING,
      );
      expect(spinAnomalies).toHaveLength(0);
    });

    it("ignores short streaming token fragments (portal, trust)", () => {
      // These are single-word streaming tokens that accumulate massive counts
      // in agent logs but are NOT real repeated thoughts
      const portalLine = '{"Thought":{"type":"text","text":"portal"}}';
      const trustLine = '{"Thought":{"type":"text","text":" trust"}}';

      for (let i = 0; i < 60; i++) {
        detector.processLine(portalLine, META);
        detector.processLine(trustLine, META);
      }

      const spinAnomalies = anomalies.filter(
        (a) => a.type === AnomalyType.THOUGHT_SPINNING,
      );
      expect(spinAnomalies).toHaveLength(0);
    });

    it("detects near-identical reasoning summaries in Codex format", () => {
      const lines = [
        '{"method":"item/completed","params":{"item":{"type":"reasoning","summary":["Retrying build verification for shard 101 in tmp 555000111"]}}}',
        '{"method":"item/completed","params":{"item":{"type":"reasoning","summary":["Retrying build verification for shard 102 in tmp 555000222"]}}}',
        '{"method":"item/completed","params":{"item":{"type":"reasoning","summary":["Retrying build verification for shard 103 in tmp 555000333"]}}}',
        '{"method":"item/completed","params":{"item":{"type":"reasoning","summary":["Retrying build verification for shard 104 in tmp 555000444"]}}}',
        '{"method":"item/completed","params":{"item":{"type":"reasoning","summary":["Retrying build verification for shard 105 in tmp 555000555"]}}}',
      ];

      for (const line of lines) {
        detector.processLine(line, META);
      }

      const spinAnomalies = anomalies.filter(
        (a) =>
          a.type === AnomalyType.THOUGHT_SPINNING &&
          a.data?.loopKind === "near_identical_reasoning",
      );
      expect(spinAnomalies.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Session Completion", () => {
    it("marks process dead on Done event", () => {
      detector.processLine('{"Done":"end_turn"}', META);

      // Process should be dead — no further anomalies
      detector.processLine(
        "CAPIError: 400 prompt token count of 999999 exceeds the limit of 272000",
        META,
      );

      // Only the Done line was processed, not the token overflow
      const overflows = anomalies.filter(
        (a) => a.type === AnomalyType.TOKEN_OVERFLOW,
      );
      expect(overflows).toHaveLength(0);
    });

    it("marks process dead on task_complete event", () => {
      detector.processLine('{"method":"codex/event/task_complete"}', META);

      detector.processLine(
        "Stream completed without a response.completed event",
        META,
      );
      const deaths = anomalies.filter(
        (a) => a.type === AnomalyType.STREAM_DEATH,
      );
      expect(deaths).toHaveLength(0);
    });
  });

  describe("getStats()", () => {
    it("returns correct statistics", () => {
      detector.processLine("hello", META);
      detector.processLine("world", META);

      const stats = detector.getStats();
      expect(stats.totalLinesProcessed).toBe(2);
      expect(stats.activeProcesses).toBe(1);
      expect(stats.deadProcesses).toBe(0);
      expect(stats.processes).toHaveLength(1);
      expect(stats.processes[0].shortId).toBe("abcdef12");
      expect(stats.processes[0].lineCount).toBe(2);
    });

    it("tracks dead processes separately", () => {
      detector.processLine('{"Done":"end_turn"}', META);
      const stats = detector.getStats();
      expect(stats.activeProcesses).toBe(0);
      expect(stats.deadProcesses).toBe(1);
    });
  });

  describe("getStatusReport()", () => {
    it("returns formatted HTML report", () => {
      detector.processLine("hello", META);
      const report = detector.getStatusReport();
      expect(report).toContain("Anomaly Detector Status");
      expect(report).toContain("Lines:");
    });
  });

  describe("Dedup protection", () => {
    it("does not emit duplicate anomalies within dedup window", () => {
      const line =
        '{"ToolCall":{"toolCallId":"tc1","title":"apply_patch","kind":"execute","rawInput":{}}}';

      // Hit warn threshold
      for (let i = 0; i < 3; i++) {
        detector.processLine(line, META);
      }

      const firstCount = anomalies.length;

      // Keep adding — should NOT re-emit the same severity anomaly
      detector.processLine(line, META);
      detector.processLine(line, META);
      // Count should only increase when escalating to a new severity (HIGH)
      // The MEDIUM warn shouldn't repeat
      const mediumAnomalies = anomalies.filter(
        (a) => a.severity === Severity.MEDIUM,
      );
      expect(mediumAnomalies.length).toBeLessThanOrEqual(1);
    });
  });

  describe("Notifications", () => {
    it("sends Telegram notification for CRITICAL anomalies", () => {
      const line =
        "CAPIError: 400 prompt token count of 500000 exceeds the limit of 272000";
      detector.processLine(line, META);

      expect(notifications.length).toBeGreaterThanOrEqual(1);
      expect(notifications[0]).toContain("TOKEN_OVERFLOW");
    });

    it("does not send notifications for LOW severity", () => {
      // Self-debug loop is LOW severity
      const line =
        '{"method":"item/completed","params":{"item":{"type":"reasoning","summary":["Troubleshooting grep command"]}}}';
      detector.processLine(line, META);

      // Notifications should be empty (LOW severity doesn't notify)
      expect(notifications).toHaveLength(0);
    });
  });

  describe("Meta enrichment", () => {
    it("captures taskTitle from metadata", () => {
      const meta = {
        ...META,
        taskTitle: "feat(market): add order books",
      };
      detector.processLine(
        "CAPIError: 400 prompt token count of 300000 exceeds the limit of 272000",
        meta,
      );

      expect(anomalies[0].taskTitle).toBe("feat(market): add order books");
    });
  });

  describe("resetProcess()", () => {
    it("clears tracking state for a process", () => {
      detector.processLine("hello", META);
      expect(detector.getStats().activeProcesses).toBe(1);

      detector.resetProcess(PID);
      expect(detector.getStats().activeProcesses).toBe(0);
    });
  });

  describe("Command Failure Rate (P3)", () => {
    it("detects high command failure rate", () => {
      const fail =
        '{"method":"item/completed","params":{"item":{"type":"commandExecution","status":"failed","exitCode":1}}}';
      const success =
        '{"method":"item/completed","params":{"item":{"type":"commandExecution","status":"completed","exitCode":0}}}';

      // 8 failures, 2 successes = 80% failure rate
      for (let i = 0; i < 8; i++) {
        detector.processLine(fail, META);
      }
      for (let i = 0; i < 2; i++) {
        detector.processLine(success, META);
      }

      const rateAnomalies = anomalies.filter(
        (a) => a.type === AnomalyType.COMMAND_FAILURE_RATE,
      );
      expect(rateAnomalies.length).toBeGreaterThanOrEqual(1);
    });
  });
  describe("Kill action escalation", () => {
    it("emits kill action for subagent waste at kill threshold", () => {
      // Matches RE_SUBAGENT_SPAWN: "ToolCall" with "rawInput":{"prompt":...}
      const spawnLine = '{"ToolCall":{"toolCallId":"tc1","title":"runSubagent","kind":"invoke","rawInput":{"prompt":"do something"}}}';
      for (let i = 0; i < 6; i++) {
        detector.processLine(spawnLine, META);
      }
      const kills = anomalies.filter(
        (a) =>
          a.type === AnomalyType.SUBAGENT_WASTE && a.action === "kill",
      );
      expect(kills.length).toBeGreaterThanOrEqual(1);
      expect(kills[0].severity).toBe(Severity.HIGH);
    });

    it("emits kill action for tool failure cascade at kill threshold", () => {
      // Matches RE_TOOL_UPDATE_FAILED: "ToolUpdate" with "status":"failed"
      const failLine = '{"ToolUpdate":{"toolCallId":"tc1","status":"failed","error":"something broke"}}';
      for (let i = 0; i < 8; i++) {
        detector.processLine(failLine, META);
      }
      const kills = anomalies.filter(
        (a) =>
          a.type === AnomalyType.TOOL_FAILURE_CASCADE && a.action === "kill",
      );
      expect(kills.length).toBeGreaterThanOrEqual(1);
    });

    it("emits kill action for git push loop at kill threshold", () => {
      const pushLine = "git push --set-upstream origin feature-branch";
      for (let i = 0; i < 4; i++) {
        detector.processLine(pushLine, META);
      }
      const kills = anomalies.filter(
        (a) =>
          a.type === AnomalyType.GIT_PUSH_LOOP && a.action === "kill",
      );
      expect(kills.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Thought spinning exclusions", () => {
    it("excludes operational test-running thoughts from spinning detection", () => {
      // Uses the actual Copilot thought format: "Thought":{"type":"text","text":"..."}
      const thoughtLine = '{"Thought":{"type":"text","text":"Running integration tests"}}';
      for (let i = 0; i < 15; i++) {
        detector.processLine(thoughtLine, META);
      }
      const spinAnomalies = anomalies.filter(
        (a) => a.type === AnomalyType.THOUGHT_SPINNING,
      );
      expect(spinAnomalies).toHaveLength(0);
    });

    it("excludes 'waiting for' thoughts from spinning detection", () => {
      const thoughtLine = '{"Thought":{"type":"text","text":"Waiting for tests to complete"}}';
      for (let i = 0; i < 15; i++) {
        detector.processLine(thoughtLine, META);
      }
      const spinAnomalies = anomalies.filter(
        (a) => a.type === AnomalyType.THOUGHT_SPINNING,
      );
      expect(spinAnomalies).toHaveLength(0);
    });

    it("still detects genuine thought spinning (non-operational)", () => {
      const thoughtLine = '{"Thought":{"type":"text","text":"I need to fix this bug somehow"}}';
      for (let i = 0; i < 15; i++) {
        detector.processLine(thoughtLine, META);
      }
      const spinAnomalies = anomalies.filter(
        (a) => a.type === AnomalyType.THOUGHT_SPINNING,
      );
      expect(spinAnomalies.length).toBeGreaterThanOrEqual(1);
    });
  });

});

describe("createAnomalyDetector factory", () => {
  it("creates and starts a detector", () => {
    const detector = createAnomalyDetector();
    expect(detector).toBeInstanceOf(AnomalyDetector);
    detector.stop();
  });
});

describe("Circuit breaker escalation", () => {
  it("escalates warn-only anomalies to kill after 3 dedup cycles", async () => {
    // Use very short dedup (50ms) so we can cycle quickly
    const { detector, anomalies } = makeDetector({ alertDedupWindowMs: 50 });

    // MODEL_NOT_SUPPORTED below kill threshold emits action: "warn"
    // with modelFailureKill=2, the 1st failure is below threshold
    const msLine = "CAPIError: 400 The requested model is not supported for this operation.";
    const pid = "circuit-breaker-test-1234-5678-abcdef012345";
    const meta = { processId: pid, stream: "stdout" };

    // Cycle 1: first failure (warn)
    detector.processLine(msLine, meta);
    await new Promise((r) => setTimeout(r, 60));

    // Cycle 2: second failure (but still same dedup key, need to wait)
    detector.processLine(msLine, meta);
    await new Promise((r) => setTimeout(r, 60));

    // Cycle 3: third failure
    detector.processLine(msLine, meta);
    await new Promise((r) => setTimeout(r, 60));

    // Cycle 4: fourth failure should trigger escalation
    detector.processLine(msLine, meta);

    const killAnoms = anomalies.filter(
      (a) =>
        a.type === AnomalyType.MODEL_NOT_SUPPORTED &&
        a.action === "kill",
    );
    // Should have at least 1 kill: either from threshold escalation (at 2)
    // or from circuit breaker (after 3 warn cycles)
    expect(killAnoms.length).toBeGreaterThanOrEqual(1);

    detector.stop();
  });

  it("escalates git push warn to kill after repeated warnings", async () => {
    const { detector, anomalies } = makeDetector({
      alertDedupWindowMs: 50,
      gitPushWarn: 2,
      gitPushKill: 100, // High kill threshold so we rely on circuit breaker
    });

    const pushLine = "git push --set-upstream origin feature-branch";
    const pid = "gitpush-breaker-1234-5678-abcdef012345";
    const meta = { processId: pid, stream: "stdout" };

    // Push enough to trigger warn (threshold=2)
    detector.processLine(pushLine, meta);
    detector.processLine(pushLine, meta);
    // First warn emitted

    // Wait for dedup, push again to get 2nd warn
    await new Promise((r) => setTimeout(r, 60));
    detector.processLine(pushLine, meta);

    await new Promise((r) => setTimeout(r, 60));
    detector.processLine(pushLine, meta);

    await new Promise((r) => setTimeout(r, 60));
    detector.processLine(pushLine, meta);

    // After 3+ warn cycles, circuit breaker should escalate to kill
    const killAnoms = anomalies.filter(
      (a) =>
        a.type === AnomalyType.GIT_PUSH_LOOP &&
        a.action === "kill",
    );
    expect(killAnoms.length).toBeGreaterThanOrEqual(1);
    // Verify escalation message
    const escalated = killAnoms.find((a) => a.message.includes("[ESCALATED]"));
    expect(escalated).toBeDefined();

    detector.stop();
  });
});

describe("MODEL_NOT_SUPPORTED kill at threshold", () => {
  it("emits kill action when model failures hit kill threshold", () => {
    const { detector, anomalies } = makeDetector({ modelFailureKill: 2 });

    const msLine = "CAPIError: 400 The requested model is not supported for this operation.";
    detector.processLine(msLine, META);
    detector.processLine(msLine, META);

    const kills = anomalies.filter(
      (a) =>
        a.type === AnomalyType.MODEL_NOT_SUPPORTED &&
        a.action === "kill",
    );
    expect(kills.length).toBeGreaterThanOrEqual(1);
    expect(kills[0].severity).toBe(Severity.HIGH);
    expect(kills[0].message).toContain("failures");
  });
});
