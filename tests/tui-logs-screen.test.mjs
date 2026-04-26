import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  LOG_LEVEL_FILTERS,
  LOG_RING_BUFFER_LIMIT,
  appendLogEntry,
  buildExportFileName,
  buildSearchMatches,
  createDefaultLogsFilterState,
  exportVisibleLogs,
  filterLogEntries,
  formatLogTimestamp,
  getActiveLogSources,
  getSearchResultNavigation,
  toggleLogSource,
  wrapLogEntryRows,
} from "../ui/tui/logs-screen-helpers.js";

const tempDirs = [];

function createTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "bosun-tui-logs-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("tui logs screen helpers", () => {
  it("keeps only the latest 2000 log entries in the ring buffer", () => {
    let entries = [];
    for (let index = 0; index < LOG_RING_BUFFER_LIMIT + 5; index += 1) {
      entries = appendLogEntry(entries, {
        ts: `2026-03-06T14:30:${String(index % 60).padStart(2, "0")}.000Z`,
        level: "info",
        source: "monitor",
        sessionId: `session-${index}`,
        message: `line ${index}`,
      });
    }

    expect(entries).toHaveLength(LOG_RING_BUFFER_LIMIT);
    expect(entries[0].message).toBe("line 5");
    expect(entries.at(-1).message).toBe(`line ${LOG_RING_BUFFER_LIMIT + 4}`);
  });

  it("defaults all built-in sources on and includes session ids as they appear", () => {
    const filters = createDefaultLogsFilterState();
    expect(getActiveLogSources(filters)).toEqual([
      "agent-pool",
      "kanban",
      "monitor",
      "telegram-ui",
      "workflow",
    ]);

    const next = toggleLogSource(filters, "session:abc123");
    expect(next.sources["session:abc123"]).toBe(true);
  });

  it("filters by source, session, level, and search text together", () => {
    const entries = [
      { ts: "2026-03-06T14:30:00.000Z", level: "debug", source: "monitor", sessionId: null, message: "boot" },
      { ts: "2026-03-06T14:30:01.000Z", level: "info", source: "workflow", sessionId: "session-a", message: "task ok" },
      { ts: "2026-03-06T14:30:02.000Z", level: "warn", source: "workflow", sessionId: "session-b", message: "slow task" },
      { ts: "2026-03-06T14:30:03.000Z", level: "error", source: "kanban", sessionId: "session-a", message: "task failed" },
    ];
    const filters = {
      levelMode: LOG_LEVEL_FILTERS.WARN_PLUS,
      sources: {
        monitor: false,
        workflow: true,
        kanban: false,
        "session:session-a": true,
        "session:session-b": true,
      },
      searchText: "task",
    };

    expect(filterLogEntries(entries, filters).map((entry) => entry.message)).toEqual(["slow task"]);
  });

  it("builds case-insensitive search matches across repeated terms", () => {
    const matches = buildSearchMatches("Error: task failed. task retry scheduled", "task");
    expect(matches).toEqual([
      { start: 7, end: 11 },
      { start: 20, end: 24 },
    ]);
  });

  it("wraps log rows and search navigation tracks entry hits across wrapped lines", () => {
    const entries = [
      {
        ts: "2026-03-06T14:30:00.000Z",
        level: "error",
        source: "workflow",
        sessionId: "session-a",
        message: "task failed during deploy because task payload was invalid",
      },
    ];

    const rows = wrapLogEntryRows(entries, { terminalWidth: 50 });
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0].prefix).toContain("workflow/session-a");
    expect(rows[1].prefix.trim()).toBe("");

    const nav = getSearchResultNavigation(entries, "task");
    expect(nav.total).toBe(2);
    expect(nav.matches[0].entryId).toBe(nav.matches[1].entryId);
  });

  it("formats timestamps with millisecond precision and exports visible logs into the logs folder", () => {
    expect(formatLogTimestamp("2026-03-06T14:30:12.345Z")).toBe("14:30:12.345");
    expect(buildExportFileName(new Date("2026-03-06T14:30:00.000Z"))).toBe("bosun-2026-03-06T14-30-00.log");

    const dir = createTempDir();
    const contents = [
      "14:30:00.000 | INFO | monitor | first line",
      "14:30:01.000 | ERROR | workflow | second line",
    ];

    const result = exportVisibleLogs({
      cwd: dir,
      entries: contents,
      date: new Date("2026-03-06T14:30:00.000Z"),
    });

    expect(result).toEqual({
      fileName: "bosun-2026-03-06T14-30-00.log",
      filePath: join(dir, "logs", "bosun-2026-03-06T14-30-00.log"),
      relativePath: "logs/bosun-2026-03-06T14-30-00.log",
    });
    expect(readFileSync(result.filePath, "utf8")).toBe(contents.join("\n"));
  });
});
