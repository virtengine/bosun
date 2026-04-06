import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildTaskDebtOperationalProtocols,
  normalizeDebtItems,
  recordTaskDebt,
  readTaskDebtEntries,
  summarizeTaskDebtLedger,
} from "../task/task-debt-ledger.mjs";

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("task-debt-ledger", () => {
  it("normalizes debt items and falls back to reason when empty", () => {
    const explicit = normalizeDebtItems([
      {
        type: "missing_functionality",
        severity: "HIGH",
        description: "Add retry timeout handling",
      },
      {
        criterion: "Load test should pass under failover",
      },
    ]);
    expect(explicit).toHaveLength(2);
    expect(explicit[0]).toMatchObject({
      type: "missing_functionality",
      severity: "high",
      description: "Add retry timeout handling",
    });
    expect(explicit[1]).toMatchObject({
      type: "unspecified",
      severity: "medium",
      criterion: "Load test should pass under failover",
    });

    const fallback = normalizeDebtItems([], "verification partially passed");
    expect(fallback).toHaveLength(1);
    expect(fallback[0]).toMatchObject({
      type: "assessment_reason",
      severity: "medium",
      description: "verification partially passed",
    });
  });

  it("records and reads debt entries from JSONL ledger", async () => {
    const baseDir = makeTempDir("debt-ledger-");
    try {
      const first = recordTaskDebt(
        {
          taskId: "TASK-100",
          taskTitle: "Stabilize pipeline retries",
          attemptId: "attempt-1",
          trigger: "agent_completed",
          action: "accept_with_debt",
          reason: "core flow done, edge cases deferred",
          debtItems: [
            { type: "missing_functionality", severity: "low", description: "Add docs" },
          ],
        },
        { baseDir },
      );

      recordTaskDebt(
        {
          taskId: "TASK-101",
          taskTitle: "Split giant feature",
          action: "split_task",
          reason: "scope too broad",
          debtItems: [],
        },
        { baseDir },
      );

      const entries = readTaskDebtEntries({ baseDir });
      expect(entries).toHaveLength(2);
      expect(first.ledgerPath.endsWith("task-debt-ledger.jsonl")).toBe(true);
      expect(entries[0]).toMatchObject({
        taskId: "TASK-100",
        action: "accept_with_debt",
      });
      expect(entries[1]).toMatchObject({
        taskId: "TASK-101",
        action: "split_task",
      });
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it("skips malformed JSONL rows when reading", async () => {
    const baseDir = makeTempDir("debt-ledger-malformed-");
    try {
      const ledgerPath = join(
        baseDir,
        ".bosun",
        "workflow-runs",
        "task-debt-ledger.jsonl",
      );
      const dir = join(baseDir, ".bosun", "workflow-runs");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        ledgerPath,
        "",
        "utf8",
      );
      writeFileSync(
        ledgerPath,
        '{"taskId":"TASK-A","action":"accept_with_debt"}\nnot-json\n{"taskId":"TASK-B","action":"split_task"}\n',
        "utf8",
      );
      const entries = readTaskDebtEntries({ baseDir, limit: 10 });
      expect(entries).toHaveLength(2);
      expect(entries.map((entry) => entry.taskId)).toEqual(["TASK-A", "TASK-B"]);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it("summarizes debt entries and emits runtime protocols", async () => {
    const baseDir = makeTempDir("debt-ledger-summary-");
    try {
      recordTaskDebt(
        {
          taskId: "TASK-300",
          taskTitle: "Patch cycle",
          action: "accept_with_debt",
          reason: "verification deferred after compile fix",
          debtItems: [
            { type: "missing_tests", severity: "high", description: "Add regression tests" },
          ],
        },
        { baseDir },
      );
      recordTaskDebt(
        {
          taskId: "TASK-300",
          taskTitle: "Patch cycle",
          action: "split_task",
          reason: "scope too broad for one run",
          debtItems: [
            { type: "task_split", severity: "medium", description: "Create follow-up tasks" },
          ],
        },
        { baseDir },
      );

      const entries = readTaskDebtEntries({ baseDir });
      const summary = summarizeTaskDebtLedger(entries, { taskId: "TASK-300" });
      const protocols = buildTaskDebtOperationalProtocols(entries, { taskId: "TASK-300" });

      expect(summary).toMatchObject({
        entryCount: 2,
        highestSeverity: "high",
      });
      expect(summary.typeCounts).toEqual(expect.objectContaining({
        missing_tests: 1,
        task_split: 1,
      }));
      expect(protocols.map((entry) => entry.title)).toEqual(expect.arrayContaining([
        "Quality Monitoring Protocol",
        "Error Recovery Protocol",
        "Operational Note-Taking Protocol",
      ]));
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});
