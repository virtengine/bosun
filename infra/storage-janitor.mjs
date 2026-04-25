/**
 * storage-janitor.mjs - Continuous, automatic cleanup of `.bosun/` artifacts.
 *
 * Runs on a periodic interval from monitor.mjs. Bounds the disk footprint of
 * artifacts that would otherwise grow forever:
 *
 *   - .bosun/.cache/harness/observability/events.jsonl   (rotated by size)
 *   - .bosun/.cache/state-ledger.sqlite                  (WAL checkpoint + opportunistic VACUUM)
 *   - .bosun/.cache/kanban-state.json.bak*               (retained K most-recent)
 *   - .bosun/logs/monitor*.log                           (per-file size cap, tail-truncate)
 *   - .bosun/logs/sessions/*.json                        (age-based prune)
 *   - .bosun/quarantine/**                               (TTL prune)
 *   - .bosun/audit/inventory.json                        (TTL prune; regenerates on next scan)
 *
 * All operations are best-effort: failures are logged and never throw to the caller.
 * Defaults are conservative and fully overridable via env vars.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { readdir, rm, stat as fsStat, unlink } from "node:fs/promises";
import { resolve, join, basename } from "node:path";

// ── Defaults (all tunable via env) ──────────────────────────────────────────
const MB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

function envInt(name, def, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function envBool(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  return /^(1|true|yes|on)$/i.test(String(raw));
}

export function getJanitorConfig() {
  return Object.freeze({
    // Harness telemetry events.jsonl rotation
    harnessEventsMaxBytes: envInt("BOSUN_HARNESS_EVENTS_MAX_BYTES", 64 * MB, { min: MB }),
    harnessEventsKeep: envInt("BOSUN_HARNESS_EVENTS_KEEP", 3, { min: 0, max: 20 }),

    // Kanban state backups retention
    kanbanBackupKeep: envInt("BOSUN_KANBAN_BACKUP_KEEP", 5, { min: 0, max: 100 }),

    // Per-file monitor log cap (truncate from head, keep most recent half)
    monitorLogMaxBytes: envInt("BOSUN_MONITOR_LOG_MAX_BYTES", 25 * MB, { min: MB }),

    // Age-based pruning
    sessionLogTtlMs: envInt("BOSUN_SESSION_LOG_TTL_DAYS", 14, { min: 1, max: 365 }) * DAY_MS,
    quarantineTtlMs: envInt("BOSUN_QUARANTINE_TTL_DAYS", 7, { min: 1, max: 365 }) * DAY_MS,
    auditInventoryTtlMs: envInt("BOSUN_AUDIT_INVENTORY_TTL_DAYS", 7, { min: 1, max: 365 }) * DAY_MS,

    // SQLite vacuum
    ledgerWalCheckpointEnabled: envBool("BOSUN_LEDGER_WAL_CHECKPOINT", true),
    ledgerFullVacuumThresholdBytes: envInt(
      "BOSUN_LEDGER_FULL_VACUUM_BYTES",
      0, // 0 = disabled (full VACUUM can be slow & rewrites whole file)
      { min: 0 },
    ),
    ledgerFreelistVacuumThreshold: envInt(
      "BOSUN_LEDGER_INCREMENTAL_VACUUM_PAGES",
      2000,
      { min: 0 },
    ),

    // SQLite row retention (append-only event tables).
    // Default 7 days — the state-ledger is an observability/event-audit store,
    // not a long-term archive. Workflow runs and task history live in their
    // own projection tables (workflow_runs, session_activity, etc.) which are
    // *not* pruned by age here. Raise via BOSUN_LEDGER_EVENT_RETENTION_DAYS if
    // you need a longer debug window.
    ledgerEventRetentionMs:
      envInt("BOSUN_LEDGER_EVENT_RETENTION_DAYS", 7, { min: 1, max: 365 }) * DAY_MS,
    ledgerEventDeleteBatchSize: envInt("BOSUN_LEDGER_EVENT_DELETE_BATCH", 5000, { min: 100, max: 100000 }),
    ledgerEventMaxDeletePerSweep: envInt("BOSUN_LEDGER_EVENT_MAX_DELETE_PER_SWEEP", 500000, { min: 1000 }),

    // SQLite row-count caps per event table. Even within the retention
    // window, cap the total row count to bound steady-state ledger size.
    // Rows are trimmed oldest-first after age-based pruning has run, so the
    // cap is an *upper bound* and usually not hit. Set to 0 to disable a cap.
    ledgerEventRowCaps: Object.freeze({
      workflow_events: envInt("BOSUN_LEDGER_WORKFLOW_EVENTS_MAX_ROWS", 200000, { min: 0 }),
      task_trace_events: envInt("BOSUN_LEDGER_TASK_TRACE_EVENTS_MAX_ROWS", 100000, { min: 0 }),
      task_claim_events: envInt("BOSUN_LEDGER_TASK_CLAIM_EVENTS_MAX_ROWS", 50000, { min: 0 }),
      harness_events: envInt("BOSUN_LEDGER_HARNESS_EVENTS_MAX_ROWS", 100000, { min: 0 }),
      tool_calls: envInt("BOSUN_LEDGER_TOOL_CALLS_MAX_ROWS", 50000, { min: 0 }),
    }),

    // Compaction via VACUUM INTO + atomic swap (large DBs)
    ledgerCompactionThresholdBytes: envInt(
      "BOSUN_LEDGER_COMPACTION_BYTES",
      512 * MB,
      { min: 16 * MB },
    ),

    // Janitor sweep cadence (read by monitor wiring)
    intervalMs: envInt("BOSUN_STORAGE_JANITOR_INTERVAL_MIN", 30, { min: 1, max: 24 * 60 }) * 60 * 1000,
    startupDelayMs: envInt("BOSUN_STORAGE_JANITOR_STARTUP_DELAY_SEC", 60, { min: 0, max: 3600 }) * 1000,
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function safeStat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

async function safeReaddir(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function logJanitor(message) {
  if (process.env.VITEST || process.env.NODE_ENV === "test") return;
  console.log(`[storage-janitor] ${message}`);
}

function warnJanitor(message) {
  console.warn(`[storage-janitor] ${message}`);
}

// ── Harness events.jsonl rotation ───────────────────────────────────────────
/**
 * Rotate the harness observability events.jsonl when it exceeds maxBytes.
 * The active file is renamed to `events.jsonl.1`, shifting older rotations up
 * (`.1` → `.2`, etc.). Anything beyond `keep` is deleted.
 *
 * Safe to call while telemetry is appending: persist uses fs.appendFile which
 * opens-write-closes per batch, so a rename between batches is non-disruptive.
 */
export function rotateHarnessEvents(configDir, opts = {}) {
  const cfg = getJanitorConfig();
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : cfg.harnessEventsMaxBytes;
  const keep = Number.isFinite(opts.keep) ? opts.keep : cfg.harnessEventsKeep;

  const eventsPath = resolve(
    String(configDir || process.cwd()),
    ".cache",
    "harness",
    "observability",
    "events.jsonl",
  );
  const stat = safeStat(eventsPath);
  if (!stat || !stat.isFile() || stat.size <= maxBytes) {
    return { rotated: false, sizeBytes: stat?.size || 0 };
  }

  try {
    // Drop the oldest if it exists at index `keep`
    const oldest = `${eventsPath}.${keep}`;
    if (existsSync(oldest)) {
      try { unlinkSync(oldest); } catch { /* best-effort */ }
    }
    // Shift .N-1 -> .N down to .1
    for (let i = keep - 1; i >= 1; i--) {
      const src = `${eventsPath}.${i}`;
      const dst = `${eventsPath}.${i + 1}`;
      if (existsSync(src)) {
        try { renameSync(src, dst); } catch { /* best-effort */ }
      }
    }
    // Active -> .1
    if (keep >= 1) {
      try { renameSync(eventsPath, `${eventsPath}.1`); }
      catch (err) {
        warnJanitor(`harness events rotate failed: ${err.message}`);
        return { rotated: false, sizeBytes: stat.size, error: err.message };
      }
    } else {
      // keep=0 means just truncate
      try { unlinkSync(eventsPath); } catch { /* best-effort */ }
    }
    logJanitor(`rotated harness events.jsonl (was ${(stat.size / MB).toFixed(1)} MB, keep=${keep})`);
    return { rotated: true, sizeBytes: stat.size };
  } catch (err) {
    warnJanitor(`harness events rotate error: ${err.message}`);
    return { rotated: false, sizeBytes: stat.size, error: err.message };
  }
}

// ── Kanban backup retention ─────────────────────────────────────────────────
const KANBAN_BACKUP_PATTERNS = [
  /^kanban-state\.json\.bak(?:[-.].*)?$/i,
  /^kanban-state\.json\.backup-.*$/i,
  /^kanban-state\.json\.monitor-backup-.*$/i,
  /^kanban-state\.json\.manual-bak-.*$/i,
  /^kanban-state\.json\..*CORRUPT.*$/i,
];

export function isKanbanBackupName(name) {
  return KANBAN_BACKUP_PATTERNS.some((rx) => rx.test(name));
}

export async function pruneKanbanBackups(cacheDir, opts = {}) {
  const cfg = getJanitorConfig();
  const keep = Number.isFinite(opts.keep) ? opts.keep : cfg.kanbanBackupKeep;
  const dir = resolve(String(cacheDir || process.cwd()));
  const entries = await safeReaddir(dir);
  const candidates = [];
  for (const ent of entries) {
    if (!ent.isFile?.()) continue;
    if (!isKanbanBackupName(ent.name)) continue;
    const full = join(dir, ent.name);
    const st = safeStat(full);
    if (!st) continue;
    candidates.push({ path: full, name: ent.name, mtimeMs: st.mtimeMs, size: st.size });
  }
  if (candidates.length <= keep) {
    return { deleted: 0, kept: candidates.length, freedBytes: 0 };
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
  const toDelete = candidates.slice(keep);
  let freed = 0;
  let deleted = 0;
  for (const item of toDelete) {
    try {
      await unlink(item.path);
      freed += item.size;
      deleted++;
    } catch (err) {
      warnJanitor(`failed to delete kanban backup ${item.name}: ${err.message}`);
    }
  }
  if (deleted > 0) {
    logJanitor(`pruned ${deleted} kanban backup(s) (kept ${keep}, freed ${(freed / MB).toFixed(1)} MB)`);
  }
  return { deleted, kept: keep, freedBytes: freed };
}

// ── Per-file log truncation (tail-keeping) ──────────────────────────────────
/**
 * If `filePath` exceeds maxBytes, keep the most-recent half by reading the
 * tail and rewriting the file in place. Aligns the new start to the next
 * newline so partial lines aren't kept.
 *
 * This complements monitor.mjs's existing `truncateOldLogs` which only deletes
 * whole files; an actively-written `monitor.log` is never the oldest file.
 */
export function truncateLargeLogFile(filePath, maxBytes) {
  const stat = safeStat(filePath);
  if (!stat || !stat.isFile() || stat.size <= maxBytes) {
    return { truncated: false, sizeBytes: stat?.size || 0 };
  }
  const keepBytes = Math.floor(maxBytes / 2);
  const offset = stat.size - keepBytes;
  let fdRead = -1;
  let fdWrite = -1;
  try {
    fdRead = openSync(filePath, "r");
    const buf = Buffer.allocUnsafe(keepBytes);
    let bytesRead = 0;
    let pos = offset;
    while (bytesRead < keepBytes) {
      const n = readSync(fdRead, buf, bytesRead, keepBytes - bytesRead, pos);
      if (n <= 0) break;
      bytesRead += n;
      pos += n;
    }
    closeSync(fdRead);
    fdRead = -1;

    // Align start to next newline so we don't begin mid-line
    let startIdx = 0;
    const nl = buf.indexOf(0x0a, 0);
    if (nl !== -1 && nl < bytesRead - 1) startIdx = nl + 1;

    const header = Buffer.from(
      `[storage-janitor] truncated head; kept last ${(bytesRead - startIdx)} bytes at ${new Date().toISOString()}\n`,
    );
    fdWrite = openSync(filePath, "w");
    writeSync(fdWrite, header, 0, header.length);
    writeSync(fdWrite, buf, startIdx, bytesRead - startIdx);
    closeSync(fdWrite);
    fdWrite = -1;
    logJanitor(
      `truncated ${basename(filePath)} ${(stat.size / MB).toFixed(1)} MB → ${((bytesRead + header.length) / MB).toFixed(1)} MB`,
    );
    return { truncated: true, sizeBytes: stat.size, newSize: bytesRead + header.length };
  } catch (err) {
    if (fdRead !== -1) { try { closeSync(fdRead); } catch { /* */ } }
    if (fdWrite !== -1) { try { closeSync(fdWrite); } catch { /* */ } }
    warnJanitor(`truncate failed for ${basename(filePath)}: ${err.message}`);
    return { truncated: false, sizeBytes: stat.size, error: err.message };
  }
}

export async function truncateOversizedMonitorLogs(logDir, opts = {}) {
  const cfg = getJanitorConfig();
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : cfg.monitorLogMaxBytes;
  const dir = resolve(String(logDir || process.cwd()));
  const entries = await safeReaddir(dir);
  let truncated = 0;
  let freedBytes = 0;
  for (const ent of entries) {
    if (!ent.isFile?.()) continue;
    if (!/^monitor.*\.log$/i.test(ent.name)) continue;
    const full = join(dir, ent.name);
    const result = truncateLargeLogFile(full, maxBytes);
    if (result.truncated) {
      truncated++;
      freedBytes += (result.sizeBytes - result.newSize);
    }
  }
  return { truncated, freedBytes };
}

// ── Age-based directory prune ──────────────────────────────────────────────
async function pruneByAge(dir, maxAgeMs, { recursive = false } = {}) {
  const cutoff = Date.now() - maxAgeMs;
  const entries = await safeReaddir(dir);
  let deleted = 0;
  let freedBytes = 0;
  for (const ent of entries) {
    const full = join(dir, ent.name);
    const st = safeStat(full);
    if (!st) continue;
    if (st.mtimeMs >= cutoff) continue;
    try {
      if (st.isDirectory()) {
        if (!recursive) continue;
        // tally size first
        const size = await dirSize(full);
        await rm(full, { recursive: true, force: true });
        freedBytes += size;
        deleted++;
      } else {
        await unlink(full);
        freedBytes += st.size;
        deleted++;
      }
    } catch (err) {
      warnJanitor(`failed to remove ${full}: ${err.message}`);
    }
  }
  return { deleted, freedBytes };
}

async function dirSize(dir) {
  let total = 0;
  let stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    const entries = await safeReaddir(cur);
    for (const ent of entries) {
      const full = join(cur, ent.name);
      if (ent.isDirectory?.()) {
        stack.push(full);
      } else {
        const st = safeStat(full);
        if (st) total += st.size;
      }
    }
  }
  return total;
}

export async function pruneSessionLogs(logsDir, opts = {}) {
  const cfg = getJanitorConfig();
  const maxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : cfg.sessionLogTtlMs;
  const dir = resolve(String(logsDir || process.cwd()), "sessions");
  if (!safeStat(dir)) return { deleted: 0, freedBytes: 0 };
  const result = await pruneByAge(dir, maxAgeMs, { recursive: false });
  if (result.deleted > 0) {
    logJanitor(`pruned ${result.deleted} session log(s) older than ${Math.round(maxAgeMs / DAY_MS)}d (${(result.freedBytes / MB).toFixed(1)} MB)`);
  }
  return result;
}

export async function pruneQuarantine(quarantineDir, opts = {}) {
  const cfg = getJanitorConfig();
  const maxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : cfg.quarantineTtlMs;
  const dir = resolve(String(quarantineDir));
  if (!safeStat(dir)) return { deleted: 0, freedBytes: 0 };
  const result = await pruneByAge(dir, maxAgeMs, { recursive: true });
  if (result.deleted > 0) {
    logJanitor(`pruned ${result.deleted} quarantine entry/entries older than ${Math.round(maxAgeMs / DAY_MS)}d (${(result.freedBytes / MB).toFixed(1)} MB)`);
  }
  return result;
}

export async function pruneAuditInventory(auditDir, opts = {}) {
  const cfg = getJanitorConfig();
  const maxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : cfg.auditInventoryTtlMs;
  const file = resolve(String(auditDir), "inventory.json");
  const st = safeStat(file);
  if (!st || !st.isFile()) return { deleted: 0, freedBytes: 0 };
  if (Date.now() - st.mtimeMs < maxAgeMs) return { deleted: 0, freedBytes: 0 };
  try {
    await unlink(file);
    logJanitor(`pruned stale audit inventory.json (${(st.size / MB).toFixed(1)} MB)`);
    return { deleted: 1, freedBytes: st.size };
  } catch (err) {
    warnJanitor(`failed to prune audit inventory.json: ${err.message}`);
    return { deleted: 0, freedBytes: 0 };
  }
}

// ── SQLite state-ledger compaction ──────────────────────────────────────────// Tables in the state-ledger that grow unboundedly with bosun activity. Each
// has a TEXT ISO timestamp column (lex-orderable) we can prune by age. Other
// tables (workflow_runs, agent_activity, session_activity, etc.) are projection
// tables holding current state and are NOT auto-pruned here.
const LEDGER_EVENT_RETENTION_TABLES = Object.freeze([
  { table: "workflow_events", column: "timestamp" },
  { table: "task_trace_events", column: "timestamp" },
  { table: "task_claim_events", column: "timestamp" },
  { table: "harness_events", column: "timestamp" },
  { table: "tool_calls", column: "updated_at" },
]);

/**
 * Delete event rows older than `retentionMs` from the high-volume append-only
 * tables. Uses small batched DELETEs so concurrent writers stay responsive.
 * Returns per-table deletion counts. Best-effort: skips tables that don't exist
 * and silently swallows lock errors (next sweep will try again).
 */
export async function pruneStateLedgerEventRows(ledgerPath, opts = {}) {
  const cfg = getJanitorConfig();
  const retentionMs = Number.isFinite(opts.retentionMs) ? opts.retentionMs : cfg.ledgerEventRetentionMs;
  const batchSize = Number.isFinite(opts.batchSize) ? opts.batchSize : cfg.ledgerEventDeleteBatchSize;
  const maxPerSweep = Number.isFinite(opts.maxPerSweep) ? opts.maxPerSweep : cfg.ledgerEventMaxDeletePerSweep;
  const cutoffIso = new Date(Date.now() - retentionMs).toISOString();

  const path = resolve(String(ledgerPath));
  const stat = safeStat(path);
  if (!stat || !stat.isFile()) {
    return { ran: false, reason: "ledger-missing", deleted: 0 };
  }

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return { ran: false, reason: "sqlite-unavailable", deleted: 0 };
  }

  const summary = { ran: true, cutoff: cutoffIso, perTable: {}, deleted: 0 };
  let db;
  try {
    db = new DatabaseSync(path);
    db.exec("PRAGMA busy_timeout = 5000");
    const knownTables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => row.name),
    );
    for (const { table, column } of LEDGER_EVENT_RETENTION_TABLES) {
      if (!knownTables.has(table)) continue;
      let deleted = 0;
      let remaining = maxPerSweep;
      // Loop with limited DELETE batches so we don't hold a long write txn.
      // SQLite supports DELETE ... LIMIT only when compiled with SQLITE_ENABLE_UPDATE_DELETE_LIMIT,
      // which node:sqlite does NOT enable. Use a subquery on rowid instead.
      const stmt = db.prepare(
        `DELETE FROM "${table}" WHERE rowid IN (
           SELECT rowid FROM "${table}" WHERE "${column}" < ? ORDER BY "${column}" LIMIT ?
         )`,
      );
      while (remaining > 0) {
        const limit = Math.min(batchSize, remaining);
        let info;
        try {
          info = stmt.run(cutoffIso, limit);
        } catch (err) {
          warnJanitor(`prune ${table} batch failed: ${err.message}`);
          break;
        }
        const changes = Number(info?.changes || 0);
        deleted += changes;
        remaining -= changes;
        if (changes < limit) break; // exhausted
      }
      if (deleted > 0) summary.perTable[table] = deleted;
      summary.deleted += deleted;
    }
  } catch (err) {
    return { ran: false, reason: "open-failed", error: err.message, deleted: 0 };
  } finally {
    try { db?.close(); } catch { /* */ }
  }
  if (summary.deleted > 0) {
    const detail = Object.entries(summary.perTable)
      .map(([t, n]) => `${t}=${n}`)
      .join(" ");
    logJanitor(`pruned ${summary.deleted} ledger event row(s) older than ${cutoffIso} [${detail}]`);
  }
  return summary;
}

/**
 * Trim event tables to a per-table row cap, deleting the oldest rows first.
 * This is the steady-state safety net that bounds ledger size even if
 * retention-based pruning isn't aggressive enough (e.g. a workflow emitting
 * a huge burst of events within the retention window).
 *
 * Caps come from `cfg.ledgerEventRowCaps`; a cap of 0 disables trimming for
 * that table. Uses the same rowid-subquery DELETE pattern as the age pruner.
 */
export async function trimStateLedgerEventRowCaps(ledgerPath, opts = {}) {
  const cfg = getJanitorConfig();
  const caps = opts.rowCaps && typeof opts.rowCaps === "object" ? opts.rowCaps : cfg.ledgerEventRowCaps;
  const batchSize = Number.isFinite(opts.batchSize) ? opts.batchSize : cfg.ledgerEventDeleteBatchSize;
  const maxPerSweep = Number.isFinite(opts.maxPerSweep) ? opts.maxPerSweep : cfg.ledgerEventMaxDeletePerSweep;

  const path = resolve(String(ledgerPath));
  const stat = safeStat(path);
  if (!stat || !stat.isFile()) {
    return { ran: false, reason: "ledger-missing", deleted: 0 };
  }

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return { ran: false, reason: "sqlite-unavailable", deleted: 0 };
  }

  const summary = { ran: true, perTable: {}, deleted: 0 };
  let db;
  try {
    db = new DatabaseSync(path);
    db.exec("PRAGMA busy_timeout = 5000");
    const knownTables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => row.name),
    );
    for (const { table, column } of LEDGER_EVENT_RETENTION_TABLES) {
      const cap = Number(caps?.[table] || 0);
      if (!cap || cap <= 0) continue;
      if (!knownTables.has(table)) continue;
      let total;
      try {
        total = Number(db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get().c || 0);
      } catch {
        continue;
      }
      if (total <= cap) continue;
      const excess = Math.min(total - cap, maxPerSweep);
      // Delete oldest rows by timestamp column, in batches.
      const stmt = db.prepare(
        `DELETE FROM "${table}" WHERE rowid IN (
           SELECT rowid FROM "${table}" ORDER BY "${column}" ASC LIMIT ?
         )`,
      );
      let deleted = 0;
      let remaining = excess;
      while (remaining > 0) {
        const limit = Math.min(batchSize, remaining);
        let info;
        try {
          info = stmt.run(limit);
        } catch (err) {
          warnJanitor(`trim ${table} batch failed: ${err.message}`);
          break;
        }
        const changes = Number(info?.changes || 0);
        deleted += changes;
        remaining -= changes;
        if (changes < limit) break;
      }
      if (deleted > 0) {
        summary.perTable[table] = { deleted, cap, before: total, after: total - deleted };
        summary.deleted += deleted;
      }
    }
  } catch (err) {
    return { ran: false, reason: "open-failed", error: err.message, deleted: 0 };
  } finally {
    try { db?.close(); } catch { /* */ }
  }
  if (summary.deleted > 0) {
    const detail = Object.entries(summary.perTable)
      .map(([t, info]) => `${t}=${info.deleted}(cap=${info.cap})`)
      .join(" ");
    logJanitor(`trimmed ${summary.deleted} ledger event row(s) to row caps [${detail}]`);
  }
  return summary;
}

/**
 * One-shot full compaction using `VACUUM INTO`. This streams the live pages
 * to a sibling file without needing a giant in-process page cache (which is
 * what kills `sqlite3.exe "VACUUM"` on multi-GB databases with the error
 * `out of memory (7)`). After the rewrite we close, atomically swap, and
 * remove the WAL/SHM siblings of the old file.
 *
 * IMPORTANT: must run when no other process holds the ledger open. Intended
 * to be called once during monitor startup before other modules grab a
 * connection. Returns { compacted, sizeBefore, sizeAfter }.
 */
export async function compactStateLedger(ledgerPath, opts = {}) {
  const cfg = getJanitorConfig();
  const minBytes = Number.isFinite(opts.minBytes) ? opts.minBytes : cfg.ledgerCompactionThresholdBytes;
  const path = resolve(String(ledgerPath));
  const stat = safeStat(path);
  if (!stat || !stat.isFile()) {
    return { compacted: false, reason: "ledger-missing" };
  }
  if (stat.size < minBytes) {
    return { compacted: false, reason: "below-threshold", sizeBefore: stat.size };
  }

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return { compacted: false, reason: "sqlite-unavailable", sizeBefore: stat.size };
  }

  const tmpPath = `${path}.compact-${process.pid}-${Date.now()}.tmp`;
  let db;
  let compactionError = null;
  try {
    db = new DatabaseSync(path);
    db.exec("PRAGMA busy_timeout = 30000");
    // Make sure WAL is folded into main first so VACUUM INTO sees the latest data.
    try { db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get(); } catch { /* */ }
    // Stream-rewrite to sidecar. Quote the path to handle backslashes/spaces.
    const safePath = tmpPath.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${safePath}'`);
  } catch (err) {
    compactionError = err;
  } finally {
    try { db?.close(); } catch { /* */ }
  }

  if (compactionError) {
    try { unlinkSync(tmpPath); } catch { /* */ }
    warnJanitor(`VACUUM INTO failed: ${compactionError.message}`);
    return { compacted: false, reason: "vacuum-failed", error: compactionError.message, sizeBefore: stat.size };
  }

  const newStat = safeStat(tmpPath);
  if (!newStat || newStat.size === 0) {
    try { unlinkSync(tmpPath); } catch { /* */ }
    return { compacted: false, reason: "empty-output", sizeBefore: stat.size };
  }

  // On Windows, the WAL/SHM siblings of the source DB often remain locked
  // for a brief moment after close() returns. Checkpoint+unlink them now so
  // the rename-swap below doesn't hit EBUSY. Best-effort — if a handle is
  // still open we retry the rename below.
  for (const sib of [`${path}-wal`, `${path}-shm`]) {
    try { if (existsSync(sib)) unlinkSync(sib); } catch { /* */ }
  }

  // Atomic swap with retry: rename old aside, move new into place, delete
  // old + WAL/SHM. Retries handle Windows file-handle release latency after
  // node:sqlite's DatabaseSync.close() returns (sometimes the OS keeps the
  // handle open for a few hundred milliseconds).
  const backupPath = `${path}.precompact-${Date.now()}`;
  const renameWithRetry = async (from, to, maxAttempts = 10) => {
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        renameSync(from, to);
        return;
      } catch (err) {
        lastErr = err;
        if (err?.code !== "EBUSY" && err?.code !== "EPERM" && err?.code !== "EACCES") throw err;
        // Exponential-ish backoff: 100ms, 200ms, 400ms, ... capped at 2s.
        const delay = Math.min(2000, 100 * 2 ** (attempt - 1));
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastErr;
  };

  try {
    await renameWithRetry(path, backupPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* */ }
    warnJanitor(`compaction swap failed (rename original): ${err.message}`);
    return { compacted: false, reason: "swap-rename-failed", error: err.message, sizeBefore: stat.size };
  }
  try {
    await renameWithRetry(tmpPath, path);
  } catch (err) {
    // Try to put the original back
    try { renameSync(backupPath, path); } catch { /* */ }
    try { unlinkSync(tmpPath); } catch { /* */ }
    warnJanitor(`compaction swap failed (rename new): ${err.message}`);
    return { compacted: false, reason: "swap-rename-failed", error: err.message, sizeBefore: stat.size };
  }
  // Best-effort: drop sidecars + the .precompact backup.
  for (const sib of [`${backupPath}-wal`, `${backupPath}-shm`, `${path}-wal`, `${path}-shm`]) {
    try { if (existsSync(sib)) unlinkSync(sib); } catch { /* */ }
  }
  try { unlinkSync(backupPath); } catch { /* */ }

  logJanitor(
    `compacted state-ledger via VACUUM INTO: ${(stat.size / MB).toFixed(1)} MB \u2192 ${(newStat.size / MB).toFixed(1)} MB (freed ${((stat.size - newStat.size) / MB).toFixed(1)} MB)`,
  );
  return { compacted: true, sizeBefore: stat.size, sizeAfter: newStat.size, freedBytes: stat.size - newStat.size };
}
/**
 * Opportunistic SQLite hygiene:
 *   1. PRAGMA wal_checkpoint(TRUNCATE)  — folds WAL into main file.
 *   2. PRAGMA incremental_vacuum         — only effective if auto_vacuum=2.
 *   3. Optional full VACUUM              — only when ledgerFullVacuumThresholdBytes > 0
 *      AND the file exceeds that threshold. Disabled by default because VACUUM
 *      rewrites the entire file (expensive on multi-GB ledgers).
 *
 * Best-effort: if node:sqlite is unavailable or the DB is locked, we skip.
 */
export async function vacuumStateLedger(ledgerPath, opts = {}) {
  const cfg = getJanitorConfig();
  const fullThreshold = Number.isFinite(opts.fullVacuumThresholdBytes)
    ? opts.fullVacuumThresholdBytes
    : cfg.ledgerFullVacuumThresholdBytes;
  const checkpointEnabled = opts.walCheckpoint ?? cfg.ledgerWalCheckpointEnabled;
  const freelistThreshold = Number.isFinite(opts.freelistThreshold)
    ? opts.freelistThreshold
    : cfg.ledgerFreelistVacuumThreshold;

  const path = resolve(String(ledgerPath));
  const stat = safeStat(path);
  if (!stat || !stat.isFile()) {
    return { ran: false, reason: "ledger-missing" };
  }

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return { ran: false, reason: "sqlite-unavailable", sizeBytes: stat.size };
  }

  let db;
  let walFrames = null;
  let freelistPages = null;
  let fullVacuumed = false;
  try {
    db = new DatabaseSync(path);

    if (checkpointEnabled) {
      try {
        const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
        // Result is { busy, log, checkpointed } on most builds
        walFrames = row?.checkpointed ?? null;
      } catch (err) {
        warnJanitor(`wal_checkpoint failed: ${err.message}`);
      }
    }

    let autoVacuumMode = 0;
    try {
      autoVacuumMode = db.prepare("PRAGMA auto_vacuum").get()?.auto_vacuum ?? 0;
    } catch { /* */ }

    try {
      freelistPages = db.prepare("PRAGMA freelist_count").get()?.freelist_count ?? 0;
    } catch { /* */ }

    if (autoVacuumMode === 2 && freelistPages != null && freelistPages >= freelistThreshold) {
      try {
        db.exec("PRAGMA incremental_vacuum");
      } catch (err) {
        warnJanitor(`incremental_vacuum failed: ${err.message}`);
      }
    }

    if (fullThreshold > 0 && stat.size >= fullThreshold) {
      try {
        db.exec("VACUUM");
        fullVacuumed = true;
      } catch (err) {
        warnJanitor(`VACUUM failed: ${err.message}`);
      }
    }
  } catch (err) {
    return { ran: false, reason: "open-failed", error: err.message, sizeBytes: stat.size };
  } finally {
    try { db?.close(); } catch { /* */ }
  }

  const after = safeStat(path);
  const freedBytes = after && stat.size > after.size ? stat.size - after.size : 0;
  if (walFrames != null || fullVacuumed || freedBytes > 0) {
    logJanitor(
      `state-ledger maintenance: walFrames=${walFrames ?? "n/a"} freelistPages=${freelistPages ?? "n/a"} fullVacuum=${fullVacuumed} freed=${(freedBytes / MB).toFixed(1)} MB (now ${(after?.size ?? stat.size) / MB | 0} MB)`,
    );
  }
  return { ran: true, walFrames, freelistPages, fullVacuumed, sizeBytes: after?.size ?? stat.size, freedBytes };
}

// ── Orchestrator ────────────────────────────────────────────────────────────
/**
 * Run all configured cleanup tasks. Returns a summary; never throws.
 *
 * @param {object} opts
 * @param {string} opts.bosunDir          - Resolved `.bosun/` directory.
 * @param {object} [opts.overrides]       - Per-task option overrides.
 * @param {string[]} [opts.skip]          - Names of tasks to skip.
 */
export async function runStorageJanitor(opts = {}) {
  const bosunDir = resolve(String(opts.bosunDir || process.cwd()));
  const overrides = opts.overrides || {};
  const skip = new Set(Array.isArray(opts.skip) ? opts.skip : []);
  const startedAt = Date.now();
  const summary = { startedAt: new Date(startedAt).toISOString() };

  if (!skip.has("harnessEvents")) {
    try {
      summary.harnessEvents = rotateHarnessEvents(bosunDir, overrides.harnessEvents);
    } catch (err) {
      summary.harnessEvents = { error: err.message };
    }
  }

  if (!skip.has("kanbanBackups")) {
    try {
      summary.kanbanBackups = await pruneKanbanBackups(
        join(bosunDir, ".cache"),
        overrides.kanbanBackups,
      );
    } catch (err) {
      summary.kanbanBackups = { error: err.message };
    }
  }

  if (!skip.has("monitorLogs")) {
    try {
      summary.monitorLogs = await truncateOversizedMonitorLogs(
        join(bosunDir, "logs"),
        overrides.monitorLogs,
      );
    } catch (err) {
      summary.monitorLogs = { error: err.message };
    }
  }

  if (!skip.has("sessionLogs")) {
    try {
      summary.sessionLogs = await pruneSessionLogs(
        join(bosunDir, "logs"),
        overrides.sessionLogs,
      );
    } catch (err) {
      summary.sessionLogs = { error: err.message };
    }
  }

  if (!skip.has("quarantine")) {
    try {
      summary.quarantine = await pruneQuarantine(
        join(bosunDir, "quarantine"),
        overrides.quarantine,
      );
    } catch (err) {
      summary.quarantine = { error: err.message };
    }
  }

  if (!skip.has("auditInventory")) {
    try {
      summary.auditInventory = await pruneAuditInventory(
        join(bosunDir, "audit"),
        overrides.auditInventory,
      );
    } catch (err) {
      summary.auditInventory = { error: err.message };
    }
  }

  if (!skip.has("stateLedgerRows")) {
    try {
      summary.stateLedgerRows = await pruneStateLedgerEventRows(
        join(bosunDir, ".cache", "state-ledger.sqlite"),
        overrides.stateLedgerRows,
      );
    } catch (err) {
      summary.stateLedgerRows = { error: err.message };
    }
  }

  if (!skip.has("stateLedgerRowCaps")) {
    try {
      summary.stateLedgerRowCaps = await trimStateLedgerEventRowCaps(
        join(bosunDir, ".cache", "state-ledger.sqlite"),
        overrides.stateLedgerRowCaps,
      );
    } catch (err) {
      summary.stateLedgerRowCaps = { error: err.message };
    }
  }

  if (!skip.has("stateLedger")) {
    try {
      summary.stateLedger = await vacuumStateLedger(
        join(bosunDir, ".cache", "state-ledger.sqlite"),
        overrides.stateLedger,
      );
    } catch (err) {
      summary.stateLedger = { error: err.message };
    }
  }

  summary.durationMs = Date.now() - startedAt;
  return summary;
}
