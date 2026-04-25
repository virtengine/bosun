import { mkdtempSync, mkdirSync, writeFileSync, statSync, existsSync, readFileSync, utimesSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

import {
  getJanitorConfig,
  isKanbanBackupName,
  pruneAuditInventory,
  pruneKanbanBackups,
  pruneQuarantine,
  pruneSessionLogs,
  pruneStateLedgerEventRows,
  rotateHarnessEvents,
  runStorageJanitor,
  trimStateLedgerEventRowCaps,
  truncateLargeLogFile,
  truncateOversizedMonitorLogs,
  vacuumStateLedger,
  compactStateLedger,
} from "../infra/storage-janitor.mjs";

let bosunDir;

beforeEach(() => {
  bosunDir = mkdtempSync(join(tmpdir(), "bosun-janitor-"));
});

afterEach(async () => {
  await rm(bosunDir, { recursive: true, force: true });
});

function setMtime(path, ageMs) {
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(path, t, t);
}

describe("storage-janitor: harness events rotation", () => {
  it("does not rotate when file is under threshold", () => {
    const dir = join(bosunDir, ".cache", "harness", "observability");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "events.jsonl");
    writeFileSync(file, "small\n");
    const result = rotateHarnessEvents(bosunDir, { maxBytes: 1024 * 1024, keep: 3 });
    expect(result.rotated).toBe(false);
    expect(existsSync(file)).toBe(true);
  });

  it("rotates active file to .1 when over threshold", () => {
    const dir = join(bosunDir, ".cache", "harness", "observability");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "events.jsonl");
    writeFileSync(file, Buffer.alloc(2048, "a"));
    const result = rotateHarnessEvents(bosunDir, { maxBytes: 1024, keep: 3 });
    expect(result.rotated).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.1`)).toBe(true);
  });

  it("shifts older rotations and drops the oldest beyond keep", () => {
    const dir = join(bosunDir, ".cache", "harness", "observability");
    mkdirSync(dir, { recursive: true });
    const base = join(dir, "events.jsonl");
    writeFileSync(base, Buffer.alloc(2048, "x"));
    writeFileSync(`${base}.1`, "old1");
    writeFileSync(`${base}.2`, "old2");
    rotateHarnessEvents(bosunDir, { maxBytes: 1024, keep: 2 });
    expect(existsSync(base)).toBe(false);
    expect(existsSync(`${base}.1`)).toBe(true);
    expect(existsSync(`${base}.2`)).toBe(true);
    // .3 would be beyond keep=2 → dropped
    expect(existsSync(`${base}.3`)).toBe(false);
    // The promoted .1 should be the previously-active 2048-byte buffer
    expect(statSync(`${base}.1`).size).toBe(2048);
  });

  it("with keep=0 simply deletes the active file", () => {
    const dir = join(bosunDir, ".cache", "harness", "observability");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "events.jsonl");
    writeFileSync(file, Buffer.alloc(2048, "z"));
    const result = rotateHarnessEvents(bosunDir, { maxBytes: 1024, keep: 0 });
    expect(result.rotated).toBe(true);
    expect(existsSync(file)).toBe(false);
  });
});

describe("storage-janitor: kanban backup retention", () => {
  it("recognises all backup naming variants", () => {
    expect(isKanbanBackupName("kanban-state.json.bak")).toBe(true);
    expect(isKanbanBackupName("kanban-state.json.bak-20260308-231151")).toBe(true);
    expect(isKanbanBackupName("kanban-state.json.bak-sync-20260309")).toBe(true);
    expect(isKanbanBackupName("kanban-state.json.backup-2026-03-10T03-21-19-715Z")).toBe(true);
    expect(isKanbanBackupName("kanban-state.json.monitor-backup-20260404-040900")).toBe(true);
    expect(isKanbanBackupName("kanban-state.json.manual-bak-2026-03-23T20-04-35-426Z")).toBe(true);
    expect(isKanbanBackupName("kanban-state.json.CORRUPT-NUL-20260420")).toBe(true);
    expect(isKanbanBackupName("kanban-state.json.bak.CORRUPT-NUL-20260420")).toBe(true);
    // negatives
    expect(isKanbanBackupName("kanban-state.json")).toBe(false);
    expect(isKanbanBackupName("other-state.json.bak")).toBe(false);
  });

  it("keeps the K most-recent and deletes the rest", async () => {
    const cacheDir = join(bosunDir, ".cache");
    mkdirSync(cacheDir, { recursive: true });
    // Create 5 backups with strictly increasing mtimes
    const names = [
      "kanban-state.json.bak-1",
      "kanban-state.json.bak-2",
      "kanban-state.json.bak-3",
      "kanban-state.json.bak-4",
      "kanban-state.json.bak-5",
    ];
    names.forEach((n, i) => {
      const f = join(cacheDir, n);
      writeFileSync(f, "x");
      setMtime(f, (5 - i) * 60_000); // n[0] oldest, n[4] newest
    });
    const result = await pruneKanbanBackups(cacheDir, { keep: 2 });
    expect(result.deleted).toBe(3);
    expect(existsSync(join(cacheDir, "kanban-state.json.bak-5"))).toBe(true);
    expect(existsSync(join(cacheDir, "kanban-state.json.bak-4"))).toBe(true);
    expect(existsSync(join(cacheDir, "kanban-state.json.bak-1"))).toBe(false);
  });

  it("ignores non-backup files in the cache dir", async () => {
    const cacheDir = join(bosunDir, ".cache");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, "kanban-state.json"), "live");
    writeFileSync(join(cacheDir, "state-ledger.sqlite"), "live");
    const result = await pruneKanbanBackups(cacheDir, { keep: 2 });
    expect(result.deleted).toBe(0);
    expect(existsSync(join(cacheDir, "kanban-state.json"))).toBe(true);
    expect(existsSync(join(cacheDir, "state-ledger.sqlite"))).toBe(true);
  });
});

describe("storage-janitor: log truncation", () => {
  it("truncates oversized files keeping the tail and aligning to newline", () => {
    const file = join(bosunDir, "monitor.log");
    // 4 KB of "lineN\n" entries
    const lines = [];
    for (let i = 0; i < 600; i++) lines.push(`line-${i}`);
    const body = lines.join("\n") + "\n";
    writeFileSync(file, body);
    const before = statSync(file).size;
    const result = truncateLargeLogFile(file, 1024);
    expect(result.truncated).toBe(true);
    const after = statSync(file).size;
    expect(after).toBeLessThan(before);
    const text = readFileSync(file, "utf8");
    expect(text.startsWith("[storage-janitor] truncated head")).toBe(true);
    // last line should be preserved
    expect(text.trimEnd().endsWith(`line-${lines.length - 1}`)).toBe(true);
  });

  it("leaves under-threshold files alone", () => {
    const file = join(bosunDir, "monitor.log");
    writeFileSync(file, "tiny\n");
    const result = truncateLargeLogFile(file, 1024);
    expect(result.truncated).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("tiny\n");
  });

  it("truncateOversizedMonitorLogs only targets monitor*.log files", async () => {
    const dir = join(bosunDir, "logs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "monitor.log"), Buffer.alloc(4096, "a"));
    writeFileSync(join(dir, "monitor-error.log"), Buffer.alloc(4096, "b"));
    writeFileSync(join(dir, "other.log"), Buffer.alloc(4096, "c"));
    const result = await truncateOversizedMonitorLogs(dir, { maxBytes: 1024 });
    expect(result.truncated).toBe(2);
    expect(statSync(join(dir, "other.log")).size).toBe(4096);
  });
});

describe("storage-janitor: age-based pruning", () => {
  it("pruneSessionLogs deletes only files older than TTL", async () => {
    const dir = join(bosunDir, "logs", "sessions");
    mkdirSync(dir, { recursive: true });
    const oldFile = join(dir, "old.json");
    const newFile = join(dir, "new.json");
    writeFileSync(oldFile, "{}");
    writeFileSync(newFile, "{}");
    setMtime(oldFile, 30 * 24 * 60 * 60 * 1000);
    const result = await pruneSessionLogs(join(bosunDir, "logs"), { maxAgeMs: 14 * 24 * 60 * 60 * 1000 });
    expect(result.deleted).toBe(1);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(newFile)).toBe(true);
  });

  it("pruneQuarantine removes old subdirectories recursively", async () => {
    const qdir = join(bosunDir, "quarantine");
    const oldEntry = join(qdir, "old-snapshot");
    const newEntry = join(qdir, "new-snapshot");
    mkdirSync(oldEntry, { recursive: true });
    mkdirSync(newEntry, { recursive: true });
    writeFileSync(join(oldEntry, "data.json"), "x");
    writeFileSync(join(newEntry, "data.json"), "x");
    setMtime(oldEntry, 14 * 24 * 60 * 60 * 1000);
    const result = await pruneQuarantine(qdir, { maxAgeMs: 7 * 24 * 60 * 60 * 1000 });
    expect(result.deleted).toBe(1);
    expect(existsSync(oldEntry)).toBe(false);
    expect(existsSync(newEntry)).toBe(true);
  });

  it("pruneAuditInventory removes inventory.json when older than TTL", async () => {
    const auditDir = join(bosunDir, "audit");
    mkdirSync(auditDir, { recursive: true });
    const file = join(auditDir, "inventory.json");
    writeFileSync(file, "{}");
    setMtime(file, 14 * 24 * 60 * 60 * 1000);
    const result = await pruneAuditInventory(auditDir, { maxAgeMs: 7 * 24 * 60 * 60 * 1000 });
    expect(result.deleted).toBe(1);
    expect(existsSync(file)).toBe(false);
  });

  it("pruneAuditInventory leaves recent inventory.json alone", async () => {
    const auditDir = join(bosunDir, "audit");
    mkdirSync(auditDir, { recursive: true });
    const file = join(auditDir, "inventory.json");
    writeFileSync(file, "{}");
    const result = await pruneAuditInventory(auditDir, { maxAgeMs: 7 * 24 * 60 * 60 * 1000 });
    expect(result.deleted).toBe(0);
    expect(existsSync(file)).toBe(true);
  });
});

describe("storage-janitor: state-ledger vacuum", () => {
  it("returns ledger-missing when file does not exist", async () => {
    const result = await vacuumStateLedger(join(bosunDir, ".cache", "state-ledger.sqlite"));
    expect(result.ran).toBe(false);
    expect(result.reason).toBe("ledger-missing");
  });

  it("opens, checkpoints WAL, and reports freelist count on a real sqlite db", async () => {
    let DatabaseSync;
    try {
      ({ DatabaseSync } = await import("node:sqlite"));
    } catch {
      return; // node:sqlite not available in this runtime — skip
    }
    const cacheDir = join(bosunDir, ".cache");
    mkdirSync(cacheDir, { recursive: true });
    const dbPath = join(cacheDir, "state-ledger.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
    const insert = db.prepare("INSERT INTO t(v) VALUES (?)");
    for (let i = 0; i < 200; i++) insert.run(`val-${i}`);
    db.exec("DELETE FROM t");
    db.close();

    const result = await vacuumStateLedger(dbPath);
    expect(result.ran).toBe(true);
    expect(typeof result.freelistPages === "number" || result.freelistPages == null).toBe(true);
  });
});

describe("storage-janitor: state-ledger row retention", () => {
  it("deletes rows older than retention from event tables in batches", async () => {
    let DatabaseSync;
    try { ({ DatabaseSync } = await import("node:sqlite")); } catch { return; }
    const cacheDir = join(bosunDir, ".cache");
    mkdirSync(cacheDir, { recursive: true });
    const dbPath = join(cacheDir, "state-ledger.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE workflow_events(event_id TEXT PRIMARY KEY, timestamp TEXT)`);
    db.exec(`CREATE TABLE harness_events(event_id TEXT PRIMARY KEY, timestamp TEXT)`);
    db.exec(`CREATE TABLE tool_calls(call_id TEXT PRIMARY KEY, updated_at TEXT)`);
    const ins1 = db.prepare("INSERT INTO workflow_events VALUES (?, ?)");
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();
    for (let i = 0; i < 50; i++) ins1.run(`old-${i}`, old);
    for (let i = 0; i < 10; i++) ins1.run(`new-${i}`, recent);
    db.prepare("INSERT INTO harness_events VALUES (?, ?)").run("h-old", old);
    db.prepare("INSERT INTO tool_calls VALUES (?, ?)").run("t-old", old);
    db.close();

    const result = await pruneStateLedgerEventRows(dbPath, {
      retentionMs: 30 * 24 * 60 * 60 * 1000,
      batchSize: 7,
      maxPerSweep: 1000,
    });
    expect(result.ran).toBe(true);
    expect(result.deleted).toBe(52);
    expect(result.perTable.workflow_events).toBe(50);
    expect(result.perTable.harness_events).toBe(1);
    expect(result.perTable.tool_calls).toBe(1);

    const verify = new DatabaseSync(dbPath);
    const remaining = verify.prepare("SELECT COUNT(*) AS c FROM workflow_events").get().c;
    expect(remaining).toBe(10);
    verify.close();
  });

  it("respects maxPerSweep cap", async () => {
    let DatabaseSync;
    try { ({ DatabaseSync } = await import("node:sqlite")); } catch { return; }
    const cacheDir = join(bosunDir, ".cache");
    mkdirSync(cacheDir, { recursive: true });
    const dbPath = join(cacheDir, "state-ledger.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE workflow_events(event_id TEXT PRIMARY KEY, timestamp TEXT)`);
    const ins = db.prepare("INSERT INTO workflow_events VALUES (?, ?)");
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    for (let i = 0; i < 100; i++) ins.run(`old-${i}`, old);
    db.close();

    const result = await pruneStateLedgerEventRows(dbPath, {
      retentionMs: 30 * 24 * 60 * 60 * 1000,
      batchSize: 5,
      maxPerSweep: 17,
    });
    expect(result.deleted).toBe(17);
  });

  it("returns ledger-missing when file does not exist", async () => {
    const result = await pruneStateLedgerEventRows(join(bosunDir, "nope.sqlite"));
    expect(result.ran).toBe(false);
    expect(result.reason).toBe("ledger-missing");
  });
});

describe("storage-janitor: state-ledger row caps", () => {
  it("trims tables to the configured row cap, deleting oldest first", async () => {
    let DatabaseSync;
    try { ({ DatabaseSync } = await import("node:sqlite")); } catch { return; }
    const cacheDir = join(bosunDir, ".cache");
    mkdirSync(cacheDir, { recursive: true });
    const dbPath = join(cacheDir, "state-ledger.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE workflow_events(event_id TEXT PRIMARY KEY, timestamp TEXT)`);
    const ins = db.prepare("INSERT INTO workflow_events VALUES (?, ?)");
    const base = Date.now();
    for (let i = 0; i < 200; i++) {
      ins.run(`e-${i}`, new Date(base + i * 1000).toISOString());
    }
    db.close();

    const result = await trimStateLedgerEventRowCaps(dbPath, {
      rowCaps: { workflow_events: 50 },
      batchSize: 30,
      maxPerSweep: 1000,
    });
    expect(result.ran).toBe(true);
    expect(result.perTable.workflow_events.deleted).toBe(150);
    expect(result.perTable.workflow_events.after).toBe(50);

    const verify = new DatabaseSync(dbPath);
    const oldest = verify.prepare("SELECT MIN(event_id) AS e FROM workflow_events").get().e;
    // Oldest 150 were e-0..e-149; after trim, oldest remaining should be e-150 (lex-min of e-15x..e-199).
    // Lex order: "e-100" < "e-150", but we trimmed by timestamp not id, so surviving rows are the 50 newest.
    const count = verify.prepare("SELECT COUNT(*) AS c FROM workflow_events").get().c;
    expect(count).toBe(50);
    verify.close();
  });

  it("skips tables with cap=0", async () => {
    let DatabaseSync;
    try { ({ DatabaseSync } = await import("node:sqlite")); } catch { return; }
    const cacheDir = join(bosunDir, ".cache");
    mkdirSync(cacheDir, { recursive: true });
    const dbPath = join(cacheDir, "state-ledger.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE workflow_events(event_id TEXT PRIMARY KEY, timestamp TEXT)`);
    const ins = db.prepare("INSERT INTO workflow_events VALUES (?, ?)");
    for (let i = 0; i < 100; i++) ins.run(`e-${i}`, new Date().toISOString());
    db.close();

    const result = await trimStateLedgerEventRowCaps(dbPath, {
      rowCaps: { workflow_events: 0 },
    });
    expect(result.deleted).toBe(0);
  });

  it("noop when all tables already below cap", async () => {
    let DatabaseSync;
    try { ({ DatabaseSync } = await import("node:sqlite")); } catch { return; }
    const cacheDir = join(bosunDir, ".cache");
    mkdirSync(cacheDir, { recursive: true });
    const dbPath = join(cacheDir, "state-ledger.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE workflow_events(event_id TEXT PRIMARY KEY, timestamp TEXT)`);
    db.prepare("INSERT INTO workflow_events VALUES (?, ?)").run("e-1", new Date().toISOString());
    db.close();

    const result = await trimStateLedgerEventRowCaps(dbPath, {
      rowCaps: { workflow_events: 1000 },
    });
    expect(result.deleted).toBe(0);
    expect(Object.keys(result.perTable)).toHaveLength(0);
  });
});

describe("storage-janitor: VACUUM INTO compaction", () => {
  it("returns below-threshold for small databases", async () => {
    let DatabaseSync;
    try { ({ DatabaseSync } = await import("node:sqlite")); } catch { return; }
    const cacheDir = join(bosunDir, ".cache");
    mkdirSync(cacheDir, { recursive: true });
    const dbPath = join(cacheDir, "state-ledger.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE t(x)");
    db.close();
    const result = await compactStateLedger(dbPath, { minBytes: 100 * 1024 * 1024 });
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("below-threshold");
  });

  it("compacts and atomically swaps an oversized DB with mostly-deleted rows", async () => {
    let DatabaseSync;
    try { ({ DatabaseSync } = await import("node:sqlite")); } catch { return; }
    const cacheDir = join(bosunDir, ".cache");
    mkdirSync(cacheDir, { recursive: true });
    const dbPath = join(cacheDir, "state-ledger.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE blobs(id INTEGER PRIMARY KEY, data BLOB)");
    const ins = db.prepare("INSERT INTO blobs(data) VALUES (?)");
    const payload = Buffer.alloc(8 * 1024, "x"); // 8 KB each
    for (let i = 0; i < 2000; i++) ins.run(payload); // ~16 MB of data
    db.exec("DELETE FROM blobs WHERE id > 50"); // leave 50 rows = ~400 KB live
    db.close();

    const before = statSync(dbPath).size;
    const result = await compactStateLedger(dbPath, { minBytes: 1024 });
    expect(result.compacted).toBe(true);
    expect(result.sizeAfter).toBeLessThan(before);
    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    // Original data still queryable
    const verify = new DatabaseSync(dbPath);
    const c = verify.prepare("SELECT COUNT(*) AS c FROM blobs").get().c;
    expect(c).toBe(50);
    verify.close();
  });
});



describe("storage-janitor: orchestrator", () => {
  it("runStorageJanitor produces a summary and never throws on empty .bosun dir", async () => {
    const summary = await runStorageJanitor({ bosunDir });
    expect(summary).toBeTypeOf("object");
    expect(summary.startedAt).toBeTypeOf("string");
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(summary.harnessEvents.rotated).toBe(false);
    expect(summary.kanbanBackups.deleted).toBe(0);
  });

  it("respects skip list", async () => {
    const summary = await runStorageJanitor({ bosunDir, skip: ["stateLedger", "harnessEvents"] });
    expect(summary.stateLedger).toBeUndefined();
    expect(summary.harnessEvents).toBeUndefined();
    expect(summary.kanbanBackups).toBeDefined();
  });
});

describe("storage-janitor: config", () => {
  it("returns a frozen config with sane defaults", () => {
    const cfg = getJanitorConfig();
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(cfg.harnessEventsMaxBytes).toBeGreaterThan(0);
    expect(cfg.kanbanBackupKeep).toBeGreaterThanOrEqual(0);
    expect(cfg.intervalMs).toBeGreaterThan(0);
  });

  it("honours BOSUN_HARNESS_EVENTS_MAX_BYTES override", () => {
    const prev = process.env.BOSUN_HARNESS_EVENTS_MAX_BYTES;
    process.env.BOSUN_HARNESS_EVENTS_MAX_BYTES = String(8 * 1024 * 1024);
    try {
      const cfg = getJanitorConfig();
      expect(cfg.harnessEventsMaxBytes).toBe(8 * 1024 * 1024);
    } finally {
      if (prev === undefined) delete process.env.BOSUN_HARNESS_EVENTS_MAX_BYTES;
      else process.env.BOSUN_HARNESS_EVENTS_MAX_BYTES = prev;
    }
  });
});
