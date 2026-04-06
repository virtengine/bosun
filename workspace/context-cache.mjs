/**
 * context-cache.mjs — Tiered Context Compression with Disk-Backed Cache
 *
 * WHY THIS EXISTS:
 * ────────────────
 * Tool call outputs dominate agent context windows. A 20-turn session can
 * accumulate 200K+ tokens of tool outputs that are re-sent with every API
 * call.  This module implements a tiered compression strategy:
 *
 *   Tier 0 (turns N, N-1, N-2):  Full output — untouched
 *   Tier 1 (turns N-3 to N-5):   Light compression (~20% reduction)
 *   Tier 2 (turns N-6 to N-9):   Moderate compression (~60% reduction)
 *   Tier 3 (turns N-10+):        Skeleton — tool name, args summary, char count
 *
 * Before ANY compression, the full original output is persisted to
 * `.cache/tool-logs/` with a monotonic ID. The compressed placeholder
 * includes `bosun --tool-log <ID>` so agents can retrieve the full
 * output back into context on demand.
 *
 * EXPORTS:
 *   cacheAndCompressItems(items, currentTurnIndex)
 *     → Takes the accumulated items array and the current turn index,
 *       caches old outputs to disk, returns a new items array with
 *       tiered compression applied.
 *
 *   retrieveToolLog(id)
 *     → Reads the full cached output for the given numeric ID.
 *
 *   pruneToolLogCache(maxAgeMs?)
 *     → Deletes cache entries older than maxAgeMs (default 24h).
 *
 *   getToolLogDir()
 *     → Returns the absolute path to the cache directory.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TAG = "[context-cache]";
const TOOL_LOG_SCHEMA_VERSION = 2;

/** Cache directory lives alongside bosun's logs/ directory */
const TOOL_LOG_DIR = resolve(
  process.env.BOSUN_TOOL_LOG_DIR || resolve(__dirname, "..", ".cache", "tool-logs"),
);

/** Default max age for cached entries: 24 hours */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Monotonic counter — reset per process, files use timestamp + counter */
let _logCounter = 0;

/** In-memory index: logId → { file, ts, toolName, argsPreview, pointer } */
const _logIndex = new Map();

// ---------------------------------------------------------------------------
// Shredding Telemetry Ring Buffer
// ---------------------------------------------------------------------------

/** Max events to keep in the in-process ring buffer */
const MAX_SHREDDING_BUFFER = 500;

/**
 * @typedef {Object} ShreddingEvent
 * @property {string}  timestamp       - ISO timestamp
 * @property {number}  originalChars   - Chars before compression
 * @property {number}  compressedChars - Chars after compression
 * @property {number}  savedChars      - Difference
 * @property {number}  savedPct        - % reduction
 * @property {string}  [agentType]     - SDK / agent type
 * @property {string}  [attemptId]     - Task attempt ID
 * @property {string}  [taskId]        - Task ID
 */

/** @type {ShreddingEvent[]} */
const _shreddingRingBuffer = [];

/** Absolute path to the persistent shredding stats log */
const SHREDDING_LOG_FILE = resolve(__dirname, "..", ".cache", "agent-work-logs", "shredding-stats.jsonl");

// ---------------------------------------------------------------------------
// Tool-Log Memory Cache
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} MemCacheEntry
 * @property {object} entry      - The full parsed tool log entry
 * @property {number} sizeBytes  - Byte size of serialized entry
 * @property {number} addedAt    - Unix ms when cached
 */

/** logId → MemCacheEntry */
const _contentCache = new Map();

/** Total bytes across all in-memory cached entries */
let _contentCacheTotalBytes = 0;

/** @type {{ enabled: boolean, maxSizeBytes: number, archiveSizeLimitBytes: number }} */
const _contentCacheConfig = {
  enabled: false,
  maxSizeBytes: 50 * 1024 * 1024,           // 50 MB default in-memory limit
  archiveSizeLimitBytes: 200 * 1024 * 1024,  // 200 MB disk prune trigger
};

// ── Tier boundaries (measured in "age" = currentTurn - itemTurn) ──────────
const TIER_0_MAX_AGE = 2;  // last 3 turns: full context
const TIER_1_MAX_AGE = 5;  // turns 3-5: light compression
const TIER_2_MAX_AGE = 9;  // turns 6-9: moderate compression
const DEFAULT_GIT_OUTPUT_MAX_CHARS = 8000;

// ── Compression parameters ────────────────────────────────────────────────
const TIER_1_HEAD_CHARS = 2000;
const TIER_1_TAIL_CHARS = 800;
const TIER_2_HEAD_CHARS = 600;
const TIER_2_TAIL_CHARS = 300;

// ---------------------------------------------------------------------------
// Options Resolver — converts caller-supplied options into a full opts object
// with all fields defaulting to the module-scope constants above.
// ---------------------------------------------------------------------------

/**
 * Resolve caller-supplied compression options into a complete object.
 * All fields default to the module-scope constants.
 *
 * @param {object} [options]
 * @returns {object}  Fully populated internal options
 */
function resolveOpts(options = {}) {
  return {
    contextUsageThreshold: options.contextUsageThreshold ?? 0.50,
    contextUsageTarget:    options.contextUsageTarget    ?? 0.40,
    contextUsageCritical:  options.contextUsageCritical  ?? 0.70,
    fullContextTurns:     options.fullContextTurns     ?? 3,
    tier1MaxAge:          options.tier1MaxAge          ?? TIER_1_MAX_AGE,
    tier2MaxAge:          options.tier2MaxAge          ?? TIER_2_MAX_AGE,
    tier0MaxAge:          TIER_0_MAX_AGE, // not currently overridable, kept for symmetry
    tier1HeadChars:       options.tier1HeadChars       ?? TIER_1_HEAD_CHARS,
    tier1TailChars:       options.tier1TailChars       ?? TIER_1_TAIL_CHARS,
    tier2HeadChars:       options.tier2HeadChars       ?? TIER_2_HEAD_CHARS,
    tier2TailChars:       options.tier2TailChars       ?? TIER_2_TAIL_CHARS,
    scoreHighThreshold:   options.scoreHighThreshold   ?? SCORE_HIGH_DEFAULT,
    scoreLowThreshold:    options.scoreLowThreshold    ?? SCORE_LOW_DEFAULT,
    compressToolOutputs:  options.compressToolOutputs  ?? true,
    compressMessages:     options.compressMessages     ?? true,
    compressAgentMessages: options.compressAgentMessages ?? true,
    compressUserMessages:  options.compressUserMessages  ?? true,
    msgTier0MaxAge:       options.msgTier0MaxAge       ?? MSG_TIER_0_MAX_AGE,
    msgTier1MaxAge:       options.msgTier1MaxAge       ?? MSG_TIER_1_MAX_AGE,
    msgMinCompressChars:  options.msgMinCompressChars  ?? MSG_MIN_COMPRESS_CHARS,
    userMsgFullTurns:     options.userMsgFullTurns     ?? USER_MSG_FULL_TURNS,
    liveToolCompactionEnabled: options.liveToolCompactionEnabled ?? false,
    liveToolCompactionMode: String(options.liveToolCompactionMode ?? "auto").trim().toLowerCase() || "auto",
    liveToolCompactionMinChars: options.liveToolCompactionMinChars ?? 4000,
    liveToolCompactionTargetChars: options.liveToolCompactionTargetChars ?? 1800,
    liveToolCompactionMinSavingsPct: options.liveToolCompactionMinSavingsPct ?? 15,
    liveToolCompactionMinRuntimeMs: options.liveToolCompactionMinRuntimeMs ?? 2000,
    liveToolCompactionBlockStructured: options.liveToolCompactionBlockStructured ?? true,
    liveToolCompactionAllowCommands: Array.isArray(options.liveToolCompactionAllowCommands)
      ? options.liveToolCompactionAllowCommands.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
      : String(options.liveToolCompactionAllowCommands || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean),
    gitOutputMaxChars:    options.gitOutputMaxChars    ?? getGitOutputMaxCharsFromEnv(),
  };
}

function getGitOutputMaxCharsFromEnv() {
  const raw = process.env.BOSUN_GIT_OUTPUT_MAX_CHARS;
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_GIT_OUTPUT_MAX_CHARS;
  }
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_GIT_OUTPUT_MAX_CHARS;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Filesystem helpers (lazy-loaded to avoid top-level async)
// ---------------------------------------------------------------------------

let _fsPromises = null;
async function getFs() {
  if (!_fsPromises) {
    _fsPromises = await import("node:fs/promises");
  }
  return _fsPromises;
}

let _commandDiagnosticsMod = null;
async function getCommandDiagnosticsMod() {
  if (!_commandDiagnosticsMod) {
    _commandDiagnosticsMod = await import("./command-diagnostics.mjs");
  }
  return _commandDiagnosticsMod;
}

async function ensureCacheDir() {
  const fs = await getFs();
  await fs.mkdir(TOOL_LOG_DIR, { recursive: true });
}

function buildToolLogRetrieveCommand(logId) {
  const numericId = Number(logId);
  return Number.isFinite(numericId) && numericId > 0
    ? `bosun --tool-log ${numericId}`
    : null;
}

function safePositiveInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0
    ? Math.max(0, Math.trunc(numeric))
    : fallback;
}

function normalizeSpillStage(value, fallback = "tool_log") {
  const text = String(value || "").trim();
  return text || fallback;
}

function normalizeSpillTier(value, fallback = "spill") {
  const text = String(value || "").trim();
  return text || fallback;
}

function inferSpillTier({ compressionKind = null, budgetPolicy = null, inlineMode = null, fallback = "spill" } = {}) {
  const kind = String(compressionKind || "").trim().toLowerCase();
  const policy = String(budgetPolicy || "").trim().toLowerCase();
  const mode = String(inlineMode || "").trim().toLowerCase();
  if (kind.includes("tier1")) return "tier1";
  if (kind.includes("tier2")) return "tier2";
  if (kind.includes("tier3")) return "tier3";
  if (kind.includes("breadcrumb") || kind.includes("summary")) return "summary";
  if (kind.includes("signal") || kind.includes("delta")) return "structured";
  if (kind.includes("preview")) return "preview";
  if (policy === "structured-delta") return "structured";
  if (policy === "artifact-summary") return "summary";
  if (policy === "artifact-excerpt" || policy === "inline-excerpt") return "preview";
  if (mode === "delta-summary") return "structured";
  if (mode === "minimal-summary") return "summary";
  if (mode === "bounded-excerpt" || mode === "selected-lines") return "preview";
  return fallback;
}

function cloneSpillPointer(pointer) {
  if (!pointer || typeof pointer !== "object") return null;
  return JSON.parse(JSON.stringify(pointer));
}

function deriveTextFormat(item) {
  const itemText = getItemText(item);
  if (typeof itemText === "string" && itemText.trim()) return "text";
  return "json";
}

function buildToolLogSpillPointer({
  logId,
  filePath = null,
  ts = Date.now(),
  toolName = "unknown",
  argsPreview = "",
  source = "context-cache",
  stage = "tool_log",
  tier = null,
  compressionKind = null,
  compactionMode = null,
  family = null,
  commandFamily = null,
  budgetPolicy = null,
  originalChars = 0,
  retainedChars = 0,
  originalBytes = 0,
  retainedBytes = 0,
  format = "text",
} = {}) {
  const numericId = Number(logId);
  if (!Number.isFinite(numericId) || numericId < 1) return null;
  const retrieveCommand = buildToolLogRetrieveCommand(numericId);
  return {
    schemaVersion: TOOL_LOG_SCHEMA_VERSION,
    kind: "tool-log",
    storage: "disk",
    logId: numericId,
    filePath: filePath ? String(filePath) : null,
    retrieveCommand,
    retrievable: Boolean(retrieveCommand),
    source: String(source || "context-cache"),
    stage: normalizeSpillStage(stage, "tool_log"),
    tier: normalizeSpillTier(
      tier,
      inferSpillTier({ compressionKind, budgetPolicy, fallback: "spill" }),
    ),
    compressionKind: String(compressionKind || "").trim() || null,
    compactionMode: String(compactionMode || "").trim() || null,
    family: String(family || "").trim() || null,
    commandFamily: String(commandFamily || "").trim() || null,
    budgetPolicy: String(budgetPolicy || "").trim() || null,
    format: String(format || "text"),
    toolName: String(toolName || "unknown"),
    argsPreview: String(argsPreview || ""),
    originalChars: safePositiveInteger(originalChars, 0),
    retainedChars: safePositiveInteger(retainedChars, 0),
    originalBytes: safePositiveInteger(originalBytes, 0),
    retainedBytes: safePositiveInteger(retainedBytes, 0),
    createdAt: Number.isFinite(Number(ts)) ? Number(ts) : Date.now(),
  };
}

function resolveDecisionSpillMetadata(decision = null) {
  if (!decision || typeof decision !== "object") return {};
  return {
    source: decision.source || null,
    stage: decision.stage || null,
    tier: decision.tier || null,
    compressionKind: decision.compressionKind || null,
    compactionMode: decision.compactionMode || null,
    family: decision.family || null,
    commandFamily: decision.commandFamily || null,
    budgetPolicy: decision.budgetPolicy || null,
    originalChars: decision.originalChars,
    retainedChars: decision.retainedChars,
    originalBytes: decision.originalBytes,
    retainedBytes: decision.retainedBytes,
    format: decision.format || null,
  };
}

function createToolLogSpillPointerFromEntry(entry, overrides = {}) {
  if (!entry || typeof entry !== "object") return null;
  const decisionMeta = resolveDecisionSpillMetadata(entry.decision);
  return buildToolLogSpillPointer({
    logId: overrides.logId ?? entry.id,
    filePath: overrides.filePath ?? entry.filePath ?? null,
    ts: overrides.ts ?? entry.ts,
    toolName: overrides.toolName ?? entry.toolName,
    argsPreview: overrides.argsPreview ?? entry.argsPreview,
    source: overrides.source ?? decisionMeta.source ?? "context-cache",
    stage: overrides.stage ?? decisionMeta.stage ?? "tool_log",
    tier: overrides.tier ?? decisionMeta.tier,
    compressionKind: overrides.compressionKind ?? decisionMeta.compressionKind,
    compactionMode: overrides.compactionMode ?? decisionMeta.compactionMode,
    family: overrides.family ?? decisionMeta.family,
    commandFamily: overrides.commandFamily ?? decisionMeta.commandFamily,
    budgetPolicy: overrides.budgetPolicy ?? decisionMeta.budgetPolicy,
    originalChars: overrides.originalChars ?? decisionMeta.originalChars ?? getItemText(entry.item).length,
    retainedChars: overrides.retainedChars ?? decisionMeta.retainedChars ?? 0,
    originalBytes: overrides.originalBytes ?? decisionMeta.originalBytes ?? Buffer.byteLength(safeJsonStringify(entry.item ?? ""), "utf8"),
    retainedBytes: overrides.retainedBytes ?? decisionMeta.retainedBytes ?? 0,
    format: overrides.format ?? decisionMeta.format ?? deriveTextFormat(entry.item),
  });
}

function attachSpillPointer(item, pointer) {
  if (!item || typeof item !== "object" || !pointer) return item;
  const nextItem = { ...item, _spillPointer: cloneSpillPointer(pointer) };
  if (nextItem._cachedLogId == null && pointer.logId != null) {
    nextItem._cachedLogId = pointer.logId;
  }
  return nextItem;
}

function buildItemSpillPointer(logId, originalItem, retainedItem, overrides = {}) {
  const originalText = getItemText(originalItem);
  const retainedText = getItemText(retainedItem);
  return resolveToolLogSpillPointer(logId, {
    toolName: extractToolName(originalItem),
    argsPreview: extractArgsPreview(originalItem),
    originalChars: originalText.length,
    retainedChars: retainedText.length,
    originalBytes: Buffer.byteLength(safeJsonStringify(originalItem), "utf8"),
    retainedBytes: Buffer.byteLength(safeJsonStringify(retainedItem), "utf8"),
    format: deriveTextFormat(originalItem),
    ...overrides,
  });
}

export function resolveToolLogSpillPointer(logId, overrides = {}) {
  const numericId = Number(logId);
  if (!Number.isFinite(numericId) || numericId < 1) return null;
  const indexEntry = _logIndex.get(numericId);
  if (indexEntry?.pointer && !overrides?.refresh) {
    return cloneSpillPointer({
      ...indexEntry.pointer,
      ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)),
    });
  }
  return buildToolLogSpillPointer({
    logId: numericId,
    filePath: overrides.filePath ?? indexEntry?.file ?? resolve(TOOL_LOG_DIR, `${numericId}.json`),
    ts: overrides.ts ?? indexEntry?.ts ?? Date.now(),
    toolName: overrides.toolName ?? indexEntry?.toolName ?? "unknown",
    argsPreview: overrides.argsPreview ?? indexEntry?.argsPreview ?? "",
    source: overrides.source ?? "context-cache",
    stage: overrides.stage ?? "tool_log",
    tier: overrides.tier,
    compressionKind: overrides.compressionKind,
    compactionMode: overrides.compactionMode,
    family: overrides.family,
    commandFamily: overrides.commandFamily,
    budgetPolicy: overrides.budgetPolicy,
    originalChars: overrides.originalChars ?? 0,
    retainedChars: overrides.retainedChars ?? 0,
    originalBytes: overrides.originalBytes ?? 0,
    retainedBytes: overrides.retainedBytes ?? 0,
    format: overrides.format ?? "text",
  });
}

export function getItemSpillPointer(item) {
  if (!item || typeof item !== "object") return null;
  if (item._spillPointer && typeof item._spillPointer === "object") {
    return cloneSpillPointer(item._spillPointer);
  }
  if (item._cachedLogId != null) {
    return resolveToolLogSpillPointer(item._cachedLogId, {
      stage: item._liveCompacted ? "live_tool_compaction" : "historical_tool_compaction",
      tier: item._compressed ? inferSpillTier({ compressionKind: item._compressed }) : undefined,
      compressionKind: item._compressed || undefined,
      family: item._liveCompactionFamily || item._contextEnvelope?.meta?.family || undefined,
      commandFamily: item._liveCompactionCommandFamily || item._contextEnvelope?.meta?.commandFamily || undefined,
      budgetPolicy: item._semanticBudgetPolicy || item._contextEnvelope?.meta?.budgetPolicy || undefined,
      retainedChars: getItemText(item).length,
      retainedBytes: Buffer.byteLength(getItemText(item), "utf8"),
      format: deriveTextFormat(item),
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cache Write
// ---------------------------------------------------------------------------

/**
 * Persist a tool output to disk and return a numeric log ID.
 *
 * @param {object} item        The original item object (has text/output/etc.)
 * @param {string} toolName    Name of the tool call
 * @param {string} argsPreview Short summary of arguments
 * @param {object|null} [decision] Optional semantic budget decision metadata
 * @returns {Promise<number>}  The assigned log ID
 */
async function writeToCache(item, toolName, argsPreview, decision = null) {
  await ensureCacheDir();
  const fs = await getFs();

  _logCounter += 1;
  const logId = Date.now() * 1000 + _logCounter; // unique, sortable
  const filename = `${logId}.json`;
  const filepath = resolve(TOOL_LOG_DIR, filename);
  const originalText = getItemText(item);
  const serializedItem = safeJsonStringify(item);

  const entry = {
    id: logId,
    ts: Date.now(),
    toolName: toolName || "unknown",
    argsPreview: argsPreview || "",
    ...(decision && typeof decision === "object" ? { decision } : {}),
    item,
  };
  entry.filePath = filepath;
  entry.pointer = createToolLogSpillPointerFromEntry(entry, {
    filePath: filepath,
    originalChars: resolveDecisionSpillMetadata(decision).originalChars ?? originalText.length,
    originalBytes: resolveDecisionSpillMetadata(decision).originalBytes ?? Buffer.byteLength(serializedItem, "utf8"),
  });

  try {
    await fs.writeFile(filepath, JSON.stringify(entry), "utf8");
    _logIndex.set(logId, {
      file: filepath,
      ts: entry.ts,
      toolName: entry.toolName,
      argsPreview: entry.argsPreview,
      pointer: cloneSpillPointer(entry.pointer),
    });

    // Optionally keep full content in memory for fast retrieval
    if (_contentCacheConfig.enabled) {
      const serialized = JSON.stringify(entry);
      const sizeBytes = serialized.length * 2; // rough UTF-16 estimate
      _contentCache.set(logId, { entry, sizeBytes, addedAt: Date.now() });
      _contentCacheTotalBytes += sizeBytes;
      // Evict oldest entries if over the size cap
      if (_contentCacheTotalBytes > _contentCacheConfig.maxSizeBytes) {
        _evictContentCacheBySize();
      }
    }
  } catch (err) {
    console.warn(`${TAG} failed to cache tool log ${logId}: ${err.message}`);
  }

  return logId;
}

async function updateCachedDecision(logId, decision) {
  const numericId = Number(logId);
  if (!Number.isFinite(numericId) || numericId < 1) return;
  if (!decision || typeof decision !== "object") return;
  const filepath = _logIndex.get(numericId)?.file || resolve(TOOL_LOG_DIR, `${numericId}.json`);
  try {
    const fs = await getFs();
    const raw = await fs.readFile(filepath, "utf8");
    const entry = JSON.parse(raw);
    entry.decision = decision;
    entry.pointer = createToolLogSpillPointerFromEntry(entry, entry.pointer || {});
    await fs.writeFile(filepath, JSON.stringify(entry), "utf8");
    const indexEntry = _logIndex.get(numericId);
    if (indexEntry) {
      _logIndex.set(numericId, {
        ...indexEntry,
        pointer: cloneSpillPointer(entry.pointer),
      });
    }
    const memEntry = _contentCache.get(numericId);
    if (memEntry?.entry) {
      memEntry.entry.decision = decision;
      memEntry.entry.pointer = cloneSpillPointer(entry.pointer);
    }
  } catch {
    // best effort only
  }
}
// ---------------------------------------------------------------------------
// Cache Read
// ---------------------------------------------------------------------------

/**
 * Retrieve the full original tool output for a given log ID.
 *
 * @param {number|string} id  The numeric log ID
 * @returns {Promise<{ found: boolean, entry?: object, error?: string }>}
 */
export async function retrieveToolLog(id) {
  const numId = Number(id);
  if (!Number.isFinite(numId) || numId < 1) {
    return { found: false, error: "Invalid log ID" };
  }

  // Fast path: in-memory content cache (only populated when toolLogCache.enabled = true)
  const memEntry = _contentCache.get(numId);
  if (memEntry) {
    const pointer = createToolLogSpillPointerFromEntry(memEntry.entry, memEntry.entry.pointer || {});
    return { found: true, entry: { ...memEntry.entry, pointer }, spillPointer: pointer, fromMemCache: true };
  }

  // Try in-memory index first
  const indexEntry = _logIndex.get(numId);
  const filepath = indexEntry?.file || resolve(TOOL_LOG_DIR, `${numId}.json`);

  try {
    const fs = await getFs();
    const raw = await fs.readFile(filepath, "utf8");
    const entry = JSON.parse(raw);
    const pointer = createToolLogSpillPointerFromEntry(entry, {
      filePath: entry.filePath || filepath,
      ...(entry.pointer && typeof entry.pointer === "object" ? entry.pointer : {}),
    });
    if (pointer && !entry.pointer) {
      entry.pointer = pointer;
    }
    return { found: true, entry, spillPointer: pointer };
  } catch (err) {
    if (err.code === "ENOENT") {
      return { found: false, error: `Tool log ${numId} not found (may have been pruned)` };
    }
    return { found: false, error: `Failed to read tool log ${numId}: ${err.message}` };
  }
}

/**
 * List available cached tool logs (most recent first).
 *
 * @param {number} [limit=20]  Max entries to return
 * @returns {Promise<Array<{ id: number, ts: number, toolName: string, argsPreview: string }>>}
 */
export async function listToolLogs(limit = 20) {
  try {
    const fs = await getFs();
    await ensureCacheDir();
    const files = await fs.readdir(TOOL_LOG_DIR);
    const jsonFiles = files
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse()
      .slice(0, limit);

    const results = [];
    for (const f of jsonFiles) {
      try {
        const raw = await fs.readFile(resolve(TOOL_LOG_DIR, f), "utf8");
        const entry = JSON.parse(raw);
        const pointer = createToolLogSpillPointerFromEntry(entry, {
          filePath: entry.filePath || resolve(TOOL_LOG_DIR, f),
          ...(entry.pointer && typeof entry.pointer === "object" ? entry.pointer : {}),
        });
        results.push({
          id: entry.id,
          ts: entry.ts,
          toolName: entry.toolName,
          argsPreview: entry.argsPreview,
          decision: entry.decision || null,
          pointer,
        });
      } catch {
        // skip corrupt entries
      }
    }
    return results;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Cache Pruning
// ---------------------------------------------------------------------------

/**
 * Delete cache entries older than maxAgeMs.
 *
 * @param {number} [maxAgeMs=86400000]  Max age in milliseconds (default 24h)
 * @returns {Promise<number>}  Count of pruned entries
 */
export async function pruneToolLogCache(maxAgeMs = DEFAULT_MAX_AGE_MS) {
  try {
    const fs = await getFs();
    await ensureCacheDir();
    const files = await fs.readdir(TOOL_LOG_DIR);
    const cutoff = Date.now() - maxAgeMs;
    let pruned = 0;

    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const filepath = resolve(TOOL_LOG_DIR, f);
      try {
        const stat = await fs.stat(filepath);
        if (stat.mtimeMs < cutoff) {
          await fs.unlink(filepath);
          pruned++;
          // Also remove from in-memory index
          const numId = Number(f.replace(".json", ""));
          if (Number.isFinite(numId)) _logIndex.delete(numId);
        }
      } catch {
        // skip
      }
    }

    if (pruned > 0) {
      console.log(`${TAG} pruned ${pruned} expired tool log(s)`);
    }
    return pruned;
  } catch (err) {
    console.warn(`${TAG} prune failed: ${err.message}`);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Item Inspection Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the primary text content from an item (checks multiple fields).
 */
function getItemText(item) {
  if (!item || typeof item !== "object") return "";
  return (
    item.text ||
    item.output ||
    item.aggregated_output ||
    item.stdout ||
    item.stderr ||
    item.result ||
    item.message ||
    (item.error && typeof item.error === "object" ? item.error.message : "") ||
    ""
  );
}

function getCompressionMessageId(item) {
  const value =
    item?.id
    ?? item?.messageId
    ?? item?.toolCallId
    ?? item?.callId
    ?? null;
  const text = String(value || "").trim();
  return text || null;
}

function getCompressionTurnIndex(item) {
  const value = Number(item?.turnIndex ?? item?._turnIndex ?? item?.turn ?? NaN);
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
}

function buildCompressionEventPayload({
  item = null,
  beforeText = "",
  afterText = "",
  sessionId = null,
  stage = null,
  decision = "compressed",
  reason = null,
  agentType = null,
  sessionType = null,
  normalizedSessionType = null,
  compactionFamily = null,
  commandFamily = null,
  compressionKind = null,
  cachedLogId = null,
}) {
  const originalChars = String(beforeText || "").length;
  const compressedChars = String(afterText || "").length;
  const savedChars = Math.max(0, originalChars - compressedChars);
  const savedPct = originalChars > 0
    ? Math.max(0, Math.round((savedChars / originalChars) * 100))
    : 0;
  return {
    originalChars,
    compressedChars,
    savedChars,
    savedPct,
    ...(agentType ? { agentType } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(stage ? { stage } : {}),
    ...(decision ? { decision } : {}),
    ...(reason ? { reason } : {}),
    ...(sessionType ? { sessionType } : {}),
    ...(normalizedSessionType ? { normalizedSessionType } : {}),
    ...(compactionFamily ? { compactionFamily } : {}),
    ...(commandFamily ? { commandFamily } : {}),
    ...(compressionKind ? { compressionKind } : {}),
    ...(cachedLogId ? { cachedLogId } : {}),
    ...(item?.type ? { itemType: String(item.type) } : {}),
    ...(item?.role ? { itemRole: String(item.role) } : {}),
    ...(getCompressionMessageId(item) ? { messageId: getCompressionMessageId(item) } : {}),
    ...(getCompressionTurnIndex(item) != null ? { turnIndex: getCompressionTurnIndex(item) } : {}),
    beforePreview: truncateCompactedPreviewText(beforeText, { maxChars: 3200, tailChars: 600 }).text,
    afterPreview: truncateCompactedPreviewText(afterText, { maxChars: 3200, tailChars: 600 }).text,
  };
}

/**
 * Set the text content on a tool output item, matching whichever field
 * the item originally uses (text, output, aggregated_output, etc.).
 * @param {object} item
 * @param {string} newText
 */
function setItemText(item, newText) {
  if (!item || typeof item !== "object") return;
  if (item.text !== undefined) { item.text = newText; return; }
  if (item.output !== undefined) { item.output = newText; return; }
  if (item.aggregated_output !== undefined) { item.aggregated_output = newText; return; }
  if (item.stdout !== undefined) { item.stdout = newText; return; }
  if (item.stderr !== undefined && !item.stdout) { item.stderr = newText; return; }
  if (item.result !== undefined) { item.result = newText; return; }
  if (item.message !== undefined) { item.message = newText; return; }
  // Fallback: set .output
  item.output = newText;
}

/**
 * Get a human-readable size for text.
 */
function charLabel(text) {
  const len = typeof text === "string" ? text.length : 0;
  if (len < 1024) return `${len} chars`;
  return `${(len / 1024).toFixed(1)}K chars`;
}

/**
 * Extract tool name from an item.
 */
function extractToolName(item) {
  if (!item || typeof item !== "object") return "unknown";
  return (
    item.tool_name ||
    item.toolName ||
    item.name ||
    item.call?.name ||
    item.type ||
    "unknown"
  );
}

/**
 * Build a short preview of tool arguments.
 */
function extractArgsPreview(item) {
  if (!item || typeof item !== "object") return "";
  const args = item.arguments || item.args || item.call?.arguments;
  if (!args) return "";
  if (typeof args === "string") {
    return args.length > 120 ? args.slice(0, 120) + "…" : args;
  }
  if (typeof args === "object") {
    // Keep file paths and short values, truncate long ones
    const parts = [];
    for (const [k, v] of Object.entries(args)) {
      const sv = String(v ?? "");
      if (sv.length > 80) {
        parts.push(`${k}: "${sv.slice(0, 60)}…"`);
      } else {
        parts.push(`${k}: "${sv}"`);
      }
      if (parts.join(", ").length > 120) break;
    }
    return parts.join(", ");
  }
  return "";
}

const LIVE_TOOL_RETRIEVE_PLACEHOLDER = "__BOSUN_TOOL_LOG__";
const LIVE_ERROR_REGEX = /\b(error|errors|fatal|failed|failure|panic|traceback|exception|undefined|denied|not found|enoent|eacces|segmentation fault|assertion|unhandled|stack trace|msb\d+|nu\d+|cs\d+|ts\d+)\b/i;
const LIVE_WARN_REGEX = /\b(warn|warning|deprecated)\b/i;
const LIVE_SUMMARY_REGEX = /\b(summary|total|totals|passed|failed|skipped|collected|found|matched|changed|insertions|deletions|done in|finished|ran \d+ tests?|test suites|packages? audited|up to date|build failed|completed|build succeeded|test run|tests run|total tests|passed!|failed!|restore completed|restore failed|time elapsed)\b/i;
const LIVE_STATUS_REGEX = /^(FAIL|ERROR|warning|fatal|M\s|A\s|D\s|R\s|\?\?|@@|diff --git|--- |\+\+\+ |> |xUnit\.net|Test Run Failed|Test Run Successful|Failed!)/i;
const LIVE_STRUCTURED_FLAG_REGEX = /(^|\s)(--json|--format(?:=|\s+)json|-json\b|-o(?:=|\s+)json|--output(?:=|\s+)json|{{json\s+\.}})/i;
const LIVE_FILE_REF_REGEX = /((?:[A-Za-z]:)?[.~/\\\w-]+(?:[\\/][^:\s]+)+(?::\d+(?::\d+)?)?)/;
const LIVE_SHELL_WRAPPERS = new Set(["bash", "sh", "zsh", "pwsh", "powershell", "cmd"]);
const LIVE_ENV_WRAPPERS = new Set(["env", "command", "time", "nohup"]);
const GENERIC_SIGNAL_MARKER = "\n...[selected signal lines]...\n";
const GENERIC_OMITTED_MARKER = "\n...[middle content omitted]...\n";

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueValues(values = []) {
  return [...new Set(values)];
}

function extractCommandLine(item) {
  if (!item || typeof item !== "object") return "";
  return String(
    item.command ||
    item.cmd ||
    item.input?.command ||
    item.input?.cmd ||
    item.arguments?.command ||
    item.arguments?.cmd ||
    item.args?.command ||
    item.args?.cmd ||
    ""
  ).trim();
}

function normalizeCommandToken(token) {
  return String(token || "")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/^.*[\\/]/, "")
    .replace(/\.(exe|cmd|bat|ps1)$/i, "")
    .toLowerCase();
}

function tokenizeCommandLine(commandLine) {
  const input = String(commandLine || "");
  const tokens = [];
  let index = 0;

  while (index < input.length) {
    while (index < input.length) {
      const code = input.charCodeAt(index);
      if (code !== 9 && code !== 10 && code !== 11 && code !== 12 && code !== 13 && code !== 32) break;
      index += 1;
    }
    if (index >= input.length) break;

    const quote = input[index];
    if (quote === '"' || quote === "'") {
      const start = index;
      index += 1;
      while (index < input.length && input[index] !== quote) {
        index += 1;
      }
      if (index < input.length) {
        index += 1;
        tokens.push(input.slice(start, index));
        continue;
      }
      index = start;
    }

    const start = index;
    while (index < input.length) {
      const code = input.charCodeAt(index);
      if (code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32) break;
      index += 1;
    }
    tokens.push(input.slice(start, index));
  }

  return tokens;
}

function extractNestedCommandToken(token) {
  const inner = String(token || "").trim().replace(/^['"]|['"]$/g, "");
  if (!inner) return "";
  const innerTokens = tokenizeCommandLine(inner);
  return normalizeCommandToken(innerTokens[0]);
}

function resolveCommandLeadToken(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return "";
  let index = 0;
  while (index < tokens.length) {
    const current = normalizeCommandToken(tokens[index]);
    if (!current) {
      index += 1;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(String(tokens[index] || ""))) {
      index += 1;
      continue;
    }
    if (LIVE_ENV_WRAPPERS.has(current)) {
      index += 1;
      continue;
    }
    if (LIVE_SHELL_WRAPPERS.has(current)) {
      for (let inner = index + 1; inner < tokens.length; inner += 1) {
        const raw = String(tokens[inner] || "").trim();
        const normalized = normalizeCommandToken(raw);
        if (!raw) continue;
        if (["-c", "-lc", "/c", "-command", "-encodedcommand", "-nop", "-noprofile", "-noninteractive", "-login", "-i"].includes(normalized)) {
          continue;
        }
        if (raw.startsWith("-")) continue;
        const nested = extractNestedCommandToken(raw);
        if (nested && !LIVE_SHELL_WRAPPERS.has(nested)) return nested;
      }
      return current;
    }
    return current;
  }
  return "";
}

function extractCommandFamily(item) {
  const commandLine = extractCommandLine(item);
  const tokens = tokenizeCommandLine(commandLine);
  const first = resolveCommandLeadToken(tokens);
  if (first && !LIVE_SHELL_WRAPPERS.has(first)) {
    return first;
  }
  const toolName = normalizeCommandToken(extractToolName(item));
  if (toolName && !["command_execution", "function_call_output", "tool_result", "tool_output", "command_output"].includes(toolName)) {
    return toolName;
  }
  return first || toolName || "unknown";
}

function extractFileKey(line) {
  const normalized = String(line || "");
  const match = normalized.match(/^([^:\n]+\.[A-Za-z0-9_]+(?::\d+(?::\d+)?)?)/) || normalized.match(LIVE_FILE_REF_REGEX);
  return match ? match[1] : "";
}

function getItemRuntimeMs(item) {
  const candidates = [item?.duration_ms, item?.durationMs, item?.elapsed_ms, item?.elapsedMs, item?.runtime_ms, item?.runtimeMs];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function isLikelyStructuredOutput(text, item) {
  const commandLine = extractCommandLine(item);
  if (LIVE_STRUCTURED_FLAG_REGEX.test(commandLine)) return true;
  const trimmed = String(text || "").trim();
  if (!trimmed) return false;
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

function hasSourceDiagnosticLine(text) {
  const lines = String(text || "").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const severityMatch = /\b(?:error|warning)\b/i.exec(line);
    if (!severityMatch) continue;

    const prefix = line.slice(0, severityMatch.index).trimEnd();
    if (!prefix) continue;

    const colonIndex = prefix.indexOf(":");
    const filePart = (colonIndex === -1 ? prefix : prefix.slice(0, colonIndex)).trim();
    if (!/\.(?:cs|fs|vb|ts|tsx|js|jsx|java|kt|go|rs|cpp|c|h|hpp)$/i.test(filePart)) continue;

    if (colonIndex !== -1) {
      const location = prefix.slice(colonIndex + 1).trim();
      if (location && !/^\d+(?::\d+)?$/.test(location)) continue;
    }

    return true;
  }

  return false;
}

function hasBuildDiagnosticSignals(item) {
  const text = [item?.aggregated_output, item?.output, item?.text]
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n");
  if (!text) return false;
  return (
    /\b(?:error|warning)\s+(?:TS|CS|MSB|NU)\d+\b/i.test(text)
    || hasSourceDiagnosticLine(text)
    || /\b(?:Build FAILED|Cannot find name|not assignable to type|The build failed\.)\b/i.test(text)
  );
}

const LIVE_TEST_COMMANDS = new Set(["pytest", "jest", "vitest", "xunit", "nunit", "ctest"]);
const LIVE_BUILD_COMMANDS = new Set(["cargo", "gradle", "maven", "mvn", "javac", "tsc", "deno", "make", "cmake", "bazel", "buck", "nx", "turbo", "rush", "msbuild"]);
const LIVE_PACKAGE_MANAGER_COMMANDS = new Set(["npm", "pnpm", "yarn", "bun", "pip", "pip3", "poetry", "composer", "bundle"]);
const LIVE_DEPLOY_COMMANDS = new Set(["docker", "kubectl", "helm", "terraform", "ansible", "ansible-playbook", "serverless", "vercel", "netlify", "flyctl", "aws", "az", "gcloud", "systemctl"]);
const LIVE_TEST_SIGNAL_REGEX = /^(?:FAIL\b|Failed\b|--- FAIL:|Error Message:| Stack Trace:|\s*Expected:|\s*But was:|FAILED\s+)/i;
const LIVE_BUILD_DIAGNOSTIC_REGEX = /\b(?:TS|CS|MSB|NU)\d+\b/;
const LIVE_PACKAGE_SIGNAL_REGEX = /\b(?:deprecated|vulnerabilit|npm ERR!|pnpm ERR!|ERR_PNPM|peer dep|peer dependency|added \d+ packages|removed \d+ packages|changed \d+ packages|audited \d+ packages|workspace)\b/i;
const LIVE_DEPLOY_SIGNAL_REGEX = /\b(?:deployment|service|release|revision|namespace|ingress|rollout|configured|created|unchanged|available|healthy|deployed|rollback|timeout|url:|hostname|endpoint)\b/i;

function classifyLiveFamily(commandFamily, item) {
  const cmd = String(commandFamily || "").trim().toLowerCase();
  const commandLine = extractCommandLine(item);
  const full = `${cmd} ${commandLine}`.toLowerCase();
  const hasBuildDiagnostics = hasBuildDiagnosticSignals(item);

  if (["grep", "rg", "find", "findstr", "select-string", "ag", "ack", "sift", "fd", "where", "which", "ls", "dir", "tree", "gci", "get-childitem"].includes(cmd) || /git\s+grep\b/.test(full)) return "search";
  if (cmd === "git") return "git";
  if (["journalctl", "tail", "get-content"].includes(cmd)) return "logs";
  if (["docker", "kubectl"].includes(cmd) && /logs?\b|tail\b|follow\b|--follow\b/.test(full)) return "logs";
  if (LIVE_TEST_COMMANDS.has(cmd)) return hasBuildDiagnostics ? "build" : "test";
  if (cmd === "dotnet" && /\btest\b/.test(full)) return hasBuildDiagnostics ? "build" : "test";
  if (cmd === "go" && /\btest\b/.test(full)) return hasBuildDiagnostics ? "build" : "test";
  if (["node", "python", "python3", "npx", ...LIVE_PACKAGE_MANAGER_COMMANDS].includes(cmd)
    && /\b(?:test|pytest|jest|vitest|mocha|ava|unittest|coverage|xunit|nunit)\b/.test(full)) {
    return hasBuildDiagnostics ? "build" : "test";
  }
  if (LIVE_PACKAGE_MANAGER_COMMANDS.has(cmd)
    && /\b(?:install|add|remove|uninstall|update|upgrade|audit|outdated|dedupe|prune|ci|sync|restore|publish|list)\b/.test(full)) {
    return "package-manager";
  }
  if (LIVE_BUILD_COMMANDS.has(cmd)) return "build";
  if (cmd === "dotnet" && /\b(?:build|publish|restore|pack|msbuild)\b/.test(full)) return "build";
  if (["node", "python", "python3", "npx", ...LIVE_PACKAGE_MANAGER_COMMANDS].includes(cmd)
    && /\b(?:build|compile|lint|typecheck|tsc|webpack|vite)\b/.test(full)) {
    return "build";
  }
  if (LIVE_DEPLOY_COMMANDS.has(cmd)
    && /\b(?:deploy|apply|rollout|release|sync|upgrade|promote|publish|install|plan|destroy|diff|status|up|compose)\b/.test(full)) {
    return "deploy";
  }
  if (hasBuildDiagnostics) return "build";
  return "generic";
}

function chooseLiveBudgetPolicy(family, analysis, opts) {
  const targetChars = Math.max(200, Number(opts?.liveToolCompactionTargetChars) || 1800);
  const lineCount = Number(analysis?.lineCount) || 0;
  const savedPct = Number(analysis?.savedPct) || 0;
  const policy = {
    family,
    reason: "inline_summary",
    budget: {
      targetChars,
      decision: "inline_summary",
      retrievable: false,
    },
    why: [`family:${family}`, `lines:${lineCount}`, `savedPct:${savedPct}`],
  };

  if (["package-manager", "deploy", "logs"].includes(family)) {
    policy.reason = "artifact_summary";
    policy.budget.decision = "artifact_summary";
    policy.budget.retrievable = true;
    policy.why.push("large-noisy-output");
  } else if (family === "git") {
    policy.reason = "structured_delta";
    policy.budget.decision = "structured_delta";
    policy.budget.retrievable = true;
    policy.why.push("delta-friendly-family");
  } else if (family === "search") {
    policy.reason = "inline_excerpt";
    policy.budget.decision = "inline_excerpt";
    policy.why.push("match-oriented-family");
  } else if (family === "test") {
    policy.reason = "inline_summary";
    policy.budget.decision = "inline_summary";
    policy.why.push("failure-signals-prioritized");
  } else if (family === "build") {
    policy.reason = "summary_with_delta";
    policy.budget.decision = "summary_with_delta";
    policy.budget.retrievable = true;
    policy.why.push("diagnostics-over-progress");
  }

  return policy;
}function collectSignalIndices(lines, predicate, radius = 0, limit = Infinity) {
  const out = new Set();
  let count = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (!predicate(lines[index], index)) continue;
    for (let inner = Math.max(0, index - radius); inner <= Math.min(lines.length - 1, index + radius); inner += 1) {
      out.add(inner);
    }
    count += 1;
    if (count >= limit) break;
  }
  return out;
}

function summarizeRepeatedNoise(lines) {
  const counts = new Map();
  for (const line of lines) {
    const trimmed = String(line || "").trim();
    if (!trimmed || trimmed.length < 8) continue;
    counts.set(trimmed, (counts.get(trimmed) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 4)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([line, count]) => `${line.slice(0, 70)}${line.length > 70 ? "…" : ""} x${count}`);
}

function buildSearchFileSummary(lines) {
  const counts = new Map();
  for (const line of lines) {
    const key = extractFileKey(line);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([file, count]) => `${file} (${count})`);
}

function normalizeSearchTerm(value) {
  return String(value || "").replace(/^['"`]+|['"`]+$/g, "").trim();
}

function isHighSignalSearchTerm(term) {
  const normalized = normalizeSearchTerm(term);
  if (normalized.length < 4) return false;
  if (/^(error|errors|failed|failure|exception|warning|warnings|runtime|type|assertion|network|permission|configuration)$/i.test(normalized)) {
    return false;
  }
  return true;
}

function scoreSearchTerm(term) {
  const normalized = normalizeSearchTerm(term);
  let score = normalized.length;
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(normalized)) score += 80;
  if (/^(TS|CS|MSB|NU)\d+$/i.test(normalized)) score += 70;
  if (normalized.includes("/") || normalized.includes("\\")) score += 50;
  if (/\b[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+\b/.test(normalized)) score += 40;
  if (/['"`]/.test(term)) score += 30;
  return score;
}

function collectCandidateSearchTerms(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return [];
  const candidates = [];

  for (const match of normalized.matchAll(/['"`]([^'"`]{4,})['"`]/g)) {
    candidates.push(match[1]);
  }
  for (const match of normalized.matchAll(/\b(?:TS|CS|MSB|NU)\d+\b/gi)) {
    candidates.push(match[0]);
  }
  for (const match of normalized.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) {
    candidates.push(match[0]);
  }
  for (const match of normalized.matchAll(/\b(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\b/g)) {
    candidates.push(match[0]);
  }
  for (const match of normalized.matchAll(/\b[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+\b/g)) {
    candidates.push(match[0]);
  }

  const detail = normalized.split(":").slice(1).join(":").trim();
  if (detail.length >= 8) candidates.push(detail);

  return uniqueValues(candidates)
    .filter(isHighSignalSearchTerm)
    .sort((left, right) => scoreSearchTerm(right) - scoreSearchTerm(left))
    .slice(0, 6);
}

function collectDiagnosticSearchTerms(lines, family) {
  const sourceLines = lines.filter((line) =>
    LIVE_ERROR_REGEX.test(line) ||
    LIVE_STATUS_REGEX.test(line) ||
    LIVE_SUMMARY_REGEX.test(line) ||
    (family === "build" && !!extractFileKey(line))
  );
  return uniqueValues(
    sourceLines.flatMap((line) => collectCandidateSearchTerms(line)),
  ).slice(0, 10);
}

function collectExactSignalLines(input) {
  const deduped = new Set();
  for (const line of String(input || "").split("\n")) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    if (LIVE_ERROR_REGEX.test(trimmed) || LIVE_WARN_REGEX.test(trimmed) || LIVE_SUMMARY_REGEX.test(trimmed) || LIVE_STATUS_REGEX.test(trimmed) || extractFileKey(trimmed)) {
      deduped.add(trimmed);
    }
  }
  return [...deduped].slice(0, 120);
}

function isLowValuePassLine(line) {
  const normalized = String(line || "").trim();
  if (!normalized) return false;
  return /^Passed!\s+\S+/i.test(normalized) || /^Test run for .+\.dll/i.test(normalized);
}

function pickSelectedLines(lines, family, mode) {
  const maxLinesByFamily = { search: 20, test: 18, build: 18, git: 18, logs: 16, "package-manager": 14, deploy: 14 };
  const maxLines = mode === "aggressive" ? 12 : (maxLinesByFamily[family] || 20);
  const buildRadius = family === "build" || family === "test" ? 1 : 0;
  const errorSet = collectSignalIndices(lines, (line) => LIVE_ERROR_REGEX.test(line) || LIVE_STATUS_REGEX.test(line), buildRadius, mode === "aggressive" ? 8 : 12);
  const warnSet = collectSignalIndices(lines, (line) => LIVE_WARN_REGEX.test(line), 0, mode === "aggressive" ? 4 : 6);
  const summarySet = collectSignalIndices(lines, (line) => LIVE_SUMMARY_REGEX.test(line) && !isLowValuePassLine(line), 0, mode === "aggressive" ? 5 : 8);
  const fileSet = collectSignalIndices(lines, (line) => !!extractFileKey(line), 0, family === "search" ? maxLines : 8);
  const testSet = collectSignalIndices(lines, (line) => LIVE_TEST_SIGNAL_REGEX.test(line), 1, mode === "aggressive" ? 8 : 10);
  const buildSet = collectSignalIndices(lines, (line) => LIVE_BUILD_DIAGNOSTIC_REGEX.test(line), 1, mode === "aggressive" ? 8 : 10);
  const packageSet = collectSignalIndices(lines, (line) => LIVE_PACKAGE_SIGNAL_REGEX.test(line), 0, mode === "aggressive" ? 8 : 10);
  const deploySet = collectSignalIndices(lines, (line) => LIVE_DEPLOY_SIGNAL_REGEX.test(line), 0, mode === "aggressive" ? 8 : 10);
  const diagnosticTerms = collectDiagnosticSearchTerms(lines, family);
  const termSet = collectSignalIndices(
    lines,
    (line) => diagnosticTerms.some((term) => new RegExp(escapeRegExp(term), "i").test(line)),
    buildRadius,
    mode === "aggressive" ? 8 : 12,
  );
  const selected = new Set();
  const addIndices = (iterable) => {
    for (const idx of iterable) {
      if (selected.size < maxLines) selected.add(idx);
    }
  };
  addIndices(errorSet);
  if (family === "test") addIndices(testSet);
  if (family === "build") addIndices(buildSet);
  if (family === "package-manager") addIndices(packageSet);
  if (family === "deploy") addIndices(deploySet);
  addIndices(warnSet);
  addIndices(summarySet);
  addIndices(termSet);
  if (["search", "git", "test", "build"].includes(family)) addIndices(fileSet);
  if ((family === "logs" || family === "deploy") && selected.size < maxLines) {
    for (let i = Math.max(0, lines.length - (mode === "aggressive" ? 8 : 12)); i < lines.length && selected.size < maxLines; i += 1) {
      selected.add(i);
    }
  }
  if (selected.size < Math.min(6, maxLines)) {
    for (let i = 0; i < Math.min(lines.length, 6) && selected.size < maxLines; i += 1) {
      selected.add(i);
    }
  }
  if (selected.size < Math.min(maxLines, lines.length) && !["search", "git", "test", "build"].includes(family)) {
    for (let i = Math.max(0, lines.length - 6); i < lines.length && selected.size < maxLines; i += 1) {
      selected.add(i);
    }
  }
  return [...selected].sort((a, b) => a - b).map((idx) => lines[idx]).filter(Boolean);
}

function renderGenericSignalExcerptText(item, logRef, opts) {
  const originalText = getItemText(item);
  if (typeof originalText !== "string" || !originalText) return "";
  const maxChars = Math.max(
    Number(opts?.liveToolCompactionTargetChars) || 1800,
    900,
  );
  if (originalText.length <= maxChars) return originalText;

  const signalLines = collectExactSignalLines(originalText).join("\n");
  let headChars = Math.min(Math.max(240, Math.floor(maxChars * 0.5)), maxChars);
  let tailChars = Math.min(Math.max(160, Math.floor(maxChars * 0.2)), maxChars);

  while (headChars + tailChars + GENERIC_OMITTED_MARKER.length > maxChars) {
    if (headChars >= tailChars && headChars > 120) {
      headChars = Math.max(120, headChars - 80);
    } else if (tailChars > 80) {
      tailChars = Math.max(80, tailChars - 80);
    } else {
      break;
    }
  }

  const head = originalText.slice(0, headChars);
  const tail = originalText.slice(originalText.length - tailChars);
  const retrieve = `bosun --tool-log ${logRef}`;
  const budget =
    maxChars -
    head.length -
    tail.length -
    GENERIC_OMITTED_MARKER.length -
    retrieve.length -
    64;

  const signalSnippet = budget > 0 && signalLines
    ? signalLines.slice(0, Math.max(0, budget))
    : "";

  const note = `\n\n[Signal-first excerpt — full output: ${retrieve}]`;
  return [
    head,
    GENERIC_OMITTED_MARKER,
    signalSnippet ? `${GENERIC_SIGNAL_MARKER}${signalSnippet}` : "",
    tail,
    note,
  ]
    .join("")
    .slice(0, maxChars + note.length)
    .trimEnd();
}

function appendCommandDiagnosticFooter(baseText, diagnostic, opts) {
  if (!diagnostic || typeof diagnostic !== "object") return baseText;
  const { renderCommandDiagnosticFooter } = diagnostic._helpers || {};
  const footerText = typeof renderCommandDiagnosticFooter === "function"
    ? renderCommandDiagnosticFooter(diagnostic)
    : "";
  if (!footerText) return baseText;
  const maxChars = Math.max(
    Number(opts?.liveToolCompactionTargetChars) || 1800,
    900,
  );
  const footer = `\n\n${footerText}`;
  const combined = `${String(baseText || "").trimEnd()}${footer}`;
  if (combined.length <= maxChars + 320) return combined;
  const headBudget = Math.max(240, maxChars - footer.length - 80);
  return `${String(baseText || "").slice(0, headBudget).trimEnd()}\n\n[...summary trimmed for diagnostics...]\n\n${footerText}`;
}

function buildPackageSignalSummary(lines) {
  const entries = [];
  for (const line of lines) {
    for (const match of String(line).matchAll(/\b(@?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?)@([~^]?[0-9][A-Za-z0-9+_.-]*)\b/g)) {
      entries.push(`${match[1]}@${match[2]}`);
      if (entries.length >= 6) return uniqueValues(entries);
    }
    if (LIVE_PACKAGE_SIGNAL_REGEX.test(line)) {
      entries.push(String(line).trim());
      if (entries.length >= 6) return uniqueValues(entries);
    }
  }
  return uniqueValues(entries).slice(0, 6);
}

function buildDeploySignalSummary(lines) {
  const entries = [];
  for (const line of lines) {
    const match = String(line).match(/\b(?:deployment|service|release|revision|namespace|ingress|rollout)\/?([A-Za-z0-9_.-]+)?\b/i);
    if (match) entries.push(match[0].trim());
  }
  return uniqueValues(entries).slice(0, 6);
}

function resolveLiveSummaryLabel(family) {
  if (family === "package-manager") return "Package signals";
  if (family === "deploy") return "Deploy targets";
  if (family === "test") return "Test anchors";
  return "Top files";
}

function buildLiveSignalSummary(lines, family) {
  if (family === "package-manager") return buildPackageSignalSummary(lines);
  if (family === "deploy") return buildDeploySignalSummary(lines);
  return family === "search" || family === "git" || family === "test" || family === "build"
    ? buildSearchFileSummary(lines)
    : [];
}

function resolveSemanticBudgetPolicy({ family = "generic", diagnostic = null, retrieveCommand = null, directArtifact = false } = {}) {
  const artifactStored = Boolean(retrieveCommand);
  if (!artifactStored) {
    return {
      name: "full-inline",
      reason: "Output fit the inline budget; no retrieval artifact was needed.",
      artifactStored: false,
      inlineMode: "full",
      structuredDelta: false,
      lowSignal: false,
    };
  }
  if (diagnostic?.deltaSummary) {
    return {
      name: "structured-delta",
      reason: `${family} output produced stable delta signals, so Bosun kept the delta inline and stored the full artifact.`,
      artifactStored: true,
      inlineMode: "delta-summary",
      structuredDelta: true,
      lowSignal: diagnostic?.insufficientSignal === true,
    };
  }
  if (diagnostic?.insufficientSignal) {
    return {
      name: "artifact-summary",
      reason: `${family} output was large but low-signal, so Bosun stored the full artifact and kept only a compact summary inline.`,
      artifactStored: true,
      inlineMode: "minimal-summary",
      structuredDelta: false,
      lowSignal: true,
    };
  }
  if (directArtifact) {
    return {
      name: "artifact-excerpt",
      reason: `${family} output exceeded its inline budget, so Bosun kept a bounded excerpt inline and cached the full artifact.`,
      artifactStored: true,
      inlineMode: "bounded-excerpt",
      structuredDelta: false,
      lowSignal: false,
    };
  }
  return {
    name: "inline-excerpt",
    reason: `${family} output matched the semantic excerpt policy, so Bosun kept high-signal lines inline and cached the full artifact.`,
    artifactStored: true,
    inlineMode: "selected-lines",
    structuredDelta: false,
    lowSignal: false,
  };
}

function formatEnvelopeCounts(map = {}, preferredOrder = []) {
  const entries = Object.entries(map || {}).filter(([, count]) => Number(count) > 0);
  const order = new Map(preferredOrder.map((value, index) => [value, index]));
  return entries
    .sort((left, right) => {
      const leftOrder = order.has(left[0]) ? order.get(left[0]) : Number.MAX_SAFE_INTEGER;
      const rightOrder = order.has(right[0]) ? order.get(right[0]) : Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return String(left[0]).localeCompare(String(right[0]));
    })
    .map(([key, count]) => `${key}=${count}`);
}

export function buildContextEnvelope({
  scope = "command",
  items = [],
  command = "",
  family = "generic",
  commandFamily = "unknown",
  budgetPolicy = "full-inline",
  budgetReason = "",
  retrieveCommand = null,
  summary = "",
  deltaSummary = "",
  suggestedRerun = "",
  hint = "",
  lowSignal = false,
  originalChars = 0,
  compactedChars = 0,
  excerptStrategy = "selected-lines",
} = {}) {
  if (scope === "continuation") {
    const counts = { agent: 0, user: 0, tool: 0, other: 0 };
    const toolFamilies = {};
    const budgetPolicies = {};
    let lowSignalToolCount = 0;
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || typeof item !== "object") continue;
      const compressedTag = String(item._compressed || "").trim().toLowerCase();
      const text = String(item.text || item.output || item.aggregated_output || "").toLowerCase();
      const spillPointer = getItemSpillPointer(item);
      const hasToolPlaceholder = Boolean(item._cachedLogId) || Boolean(spillPointer?.retrievable) || text.includes("full output: bosun --tool-log") || text.includes(" chars compressed");
      if (compressedTag.startsWith("agent_")) { counts.agent += 1; continue; }
      if (compressedTag === "user_breadcrumb") { counts.user += 1; continue; }
      if (hasToolPlaceholder) {
        counts.tool += 1;
        const envelopeMeta = item._contextEnvelope?.meta || {};
        const effectiveFamily = String(envelopeMeta.family || item._liveCompactionFamily || item._commandDiagnostics?.family || "generic").trim() || "generic";
        const effectiveBudget = String(envelopeMeta.budgetPolicy || item._semanticBudgetPolicy || (item._cachedLogId ? "cached" : "full-inline")).trim() || "cached";
        toolFamilies[effectiveFamily] = (toolFamilies[effectiveFamily] || 0) + 1;
        budgetPolicies[effectiveBudget] = (budgetPolicies[effectiveBudget] || 0) + 1;
        if (envelopeMeta.lowSignal === true || item._commandDiagnostics?.insufficientSignal === true) lowSignalToolCount += 1;
        continue;
      }
      if (compressedTag) counts.other += 1;
    }
    const total = counts.agent + counts.user + counts.tool + counts.other;
    if (total === 0) return null;
    const detailParts = [];
    if (counts.agent) detailParts.push(`${counts.agent} agent message${counts.agent === 1 ? "" : "s"}`);
    if (counts.user) detailParts.push(`${counts.user} user prompt${counts.user === 1 ? "" : "s"}`);
    if (counts.tool) detailParts.push(`${counts.tool} tool output${counts.tool === 1 ? "" : "s"}`);
    if (counts.other) detailParts.push(`${counts.other} other item${counts.other === 1 ? "" : "s"}`);
    const familyDetails = formatEnvelopeCounts(toolFamilies, ["search", "test", "build", "git", "logs", "package-manager", "deploy", "generic"]);
    const budgetDetails = formatEnvelopeCounts(budgetPolicies, ["structured-delta", "inline-excerpt", "artifact-excerpt", "artifact-summary", "cached", "full-inline"]);
    const sentences = [
      `Context summarized for continuation: ${total} older item${total === 1 ? "" : "s"} compressed (${detailParts.join(", ")}). Session history in this view is unchanged.`,
    ];
    if (familyDetails.length) sentences.push(`Tool evidence families: ${familyDetails.join(", ")}.`);
    if (budgetDetails.length) sentences.push(`Budget policies: ${budgetDetails.join(", ")}.`);
    if (lowSignalToolCount) sentences.push(`Low-signal tool outputs: ${lowSignalToolCount}.`);
    return {
      scope,
      content: sentences.join(" "),
      meta: { total, counts, detail: detailParts.join(", "), toolFamilies, budgetPolicies, lowSignalToolCount },
    };
  }
  const savedChars = Math.max(0, Number(originalChars) - Number(compactedChars));
  const savedPct = Number(originalChars) > 0 ? Math.max(0, Math.round((savedChars / Math.max(1, Number(originalChars))) * 100)) : 0;
  const parts = [`Command evidence: ${family}/${commandFamily} via ${budgetPolicy}.`];
  if (summary) parts.push(`Summary: ${summary}`);
  if (deltaSummary) parts.push(`Delta: ${deltaSummary}`);
  if (suggestedRerun) parts.push(`Suggested rerun: ${suggestedRerun}`);
  if (hint) parts.push(`Hint: ${hint}`);
  if (budgetReason) parts.push(`Budget: ${budgetReason}`);
  if (retrieveCommand) parts.push(`Retrieve: ${retrieveCommand}`);
  return {
    scope,
    content: parts.join(" "),
    meta: { command, family, commandFamily, budgetPolicy, budgetReason, retrieveCommand, summary, deltaSummary, suggestedRerun, hint, lowSignal, originalChars, compactedChars, savedChars, savedPct, excerptStrategy },
  };
}

function attachCommandEnvelope(compactedItem, {
  family = "generic",
  commandFamily = "unknown",
  diagnostic = null,
  logId = null,
  originalChars = 0,
  compactedChars = 0,
  excerptStrategy = "selected-lines",
  directArtifact = false,
} = {}) {
  const retrieveCommand = logId ? `bosun --tool-log ${logId}` : null;
  const policy = resolveSemanticBudgetPolicy({ family, diagnostic, retrieveCommand, directArtifact });
  const envelope = buildContextEnvelope({
    scope: "command",
    command: extractCommandLine(compactedItem) || extractToolName(compactedItem),
    family,
    commandFamily,
    budgetPolicy: policy.name,
    budgetReason: policy.reason,
    retrieveCommand,
    summary: diagnostic?.summary || "",
    deltaSummary: diagnostic?.deltaSummary || "",
    suggestedRerun: diagnostic?.suggestedRerun || "",
    hint: diagnostic?.hint || "",
    lowSignal: diagnostic?.insufficientSignal === true,
    originalChars,
    compactedChars,
    excerptStrategy,
  });
  compactedItem._semanticBudgetPolicy = policy.name;
  compactedItem._semanticBudgetReason = policy.reason;
  compactedItem._contextEnvelope = envelope;
  return envelope;
}
function renderLiveCompactionText(analysis, logRef, opts) {
  const retrieve = `bosun --tool-log ${logRef}`;
  const header = `[Live-compacted ${analysis.family}] ${analysis.commandLabel} -> ${analysis.lineCount} lines / ${charLabel(analysis.originalText)}, saved ~${analysis.savedPct}% | Full output: ${retrieve}`;
  const sections = [header];
  if (analysis.highlights.length) sections.push(`Highlights: ${analysis.highlights.join("; ")}`);
  if (analysis.fileSummary.length) sections.push(`${analysis.summaryLabel || "Top files"}: ${analysis.fileSummary.join(", ")}`);
  if (analysis.repeatedSummary.length) sections.push(`Repeated noise omitted: ${analysis.repeatedSummary.join("; ")}`);
  if (analysis.selectedLines.length) sections.push(`Selected lines:\n${analysis.selectedLines.join("\n")}`);
  let rendered = sections.join("\n\n");
  const targetChars = Math.max(200, Number(opts.liveToolCompactionTargetChars) || 1800);
  let selected = [...analysis.selectedLines];
  let repeated = [...analysis.repeatedSummary];
  let fileSummary = [...analysis.fileSummary];
  while (rendered.length > targetChars && selected.length > 6) {
    selected.splice(Math.floor(selected.length / 2), 1);
    const nextSections = [header];
    if (analysis.highlights.length) nextSections.push(`Highlights: ${analysis.highlights.join("; ")}`);
    if (fileSummary.length) nextSections.push(`${analysis.summaryLabel || "Top files"}: ${fileSummary.join(", ")}`);
    if (repeated.length) nextSections.push(`Repeated noise omitted: ${repeated.join("; ")}`);
    if (selected.length) nextSections.push(`Selected lines:\n${selected.join("\n")}`);
    rendered = nextSections.join("\n\n");
  }
  if (rendered.length > targetChars && repeated.length) {
    repeated = [];
    const nextSections = [header];
    if (analysis.highlights.length) nextSections.push(`Highlights: ${analysis.highlights.join("; ")}`);
    if (fileSummary.length) nextSections.push(`${analysis.summaryLabel || "Top files"}: ${fileSummary.join(", ")}`);
    if (selected.length) nextSections.push(`Selected lines:\n${selected.join("\n")}`);
    rendered = nextSections.join("\n\n");
  }
  if (rendered.length > targetChars && fileSummary.length > 4) {
    fileSummary = fileSummary.slice(0, 4);
    const nextSections = [header];
    if (analysis.highlights.length) nextSections.push(`Highlights: ${analysis.highlights.join("; ")}`);
    if (fileSummary.length) nextSections.push(`${analysis.summaryLabel || "Top files"}: ${fileSummary.join(", ")}`);
    if (selected.length) nextSections.push(`Selected lines:\n${selected.join("\n")}`);
    rendered = nextSections.join("\n\n");
  }
  if (rendered.length > targetChars) {
    rendered = `${rendered.slice(0, Math.max(120, targetChars - retrieve.length - 40))}\n\n[...live summary trimmed... full output: ${retrieve}]`;
  }
  return rendered;
}

async function analyzeCommandDiagnosticForItem(item, logId = null) {
  const text = getItemText(item);
  if (!text) return null;
  const { analyzeCommandDiagnostic, renderCommandDiagnosticFooter } = await getCommandDiagnosticsMod();
  const diagnostic = await analyzeCommandDiagnostic({
    command: extractCommandLine(item),
    args: Array.isArray(item?.arguments?.argv)
      ? item.arguments.argv
      : Array.isArray(item?.args)
        ? item.args
        : [],
    output: item?.aggregated_output ?? item?.output ?? item?.text ?? item?.stdout ?? "",
    stderr: item?.stderr ?? "",
    exitCode: item?.exit_code ?? item?.exitCode ?? 0,
  });
  if (!diagnostic) return null;
  return {
    ...diagnostic,
    retrieveCommand: logId ? `bosun --tool-log ${logId}` : null,
    _helpers: { renderCommandDiagnosticFooter },
  };
}

function analyzeLiveToolOutput(item, opts, { force = false } = {}) {
  const originalText = getItemText(item);
  if (typeof originalText !== "string" || (!force && originalText.length < (opts.liveToolCompactionMinChars ?? 4000))) return null;
  const commandFamily = extractCommandFamily(item);
  const allowlist = new Set((opts.liveToolCompactionAllowCommands || []).map((value) => String(value).trim().toLowerCase()).filter(Boolean));
  const enforceAllowlist =
    allowlist.size > 0 &&
    !allowlist.has(commandFamily) &&
    item?.type !== "command_execution" &&
    item?.type !== "command_output";
  if (enforceAllowlist) return null;
  if (opts.liveToolCompactionBlockStructured !== false && isLikelyStructuredOutput(originalText, item)) return null;
  const family = classifyLiveFamily(commandFamily, item);
  const normalizedText = originalText.replace(/\r\n?/g, "\n");
  const lines = normalizedText.split("\n");
  if (lines.length < 20 && normalizedText.length < (opts.liveToolCompactionTargetChars ?? 1800) * 1.5) return null;
  const mode = opts.liveToolCompactionMode === "aggressive" ? "aggressive" : "auto";
  const selectedLines = pickSelectedLines(lines, family, mode);
  if (!selectedLines.length) return null;
  const errorCount = lines.filter((line) => LIVE_ERROR_REGEX.test(line)).length;
  const warningCount = lines.filter((line) => LIVE_WARN_REGEX.test(line)).length;
  const fileMatches = lines.filter((line) => !!extractFileKey(line)).length;
  const packageSignalCount = family === "package-manager" ? lines.filter((line) => LIVE_PACKAGE_SIGNAL_REGEX.test(line)).length : 0;
  const deploySignalCount = family === "deploy" ? lines.filter((line) => LIVE_DEPLOY_SIGNAL_REGEX.test(line)).length : 0;
  const highlights = [];
  if (errorCount) highlights.push(`${errorCount} error line${errorCount === 1 ? "" : "s"}`);
  if (warningCount) highlights.push(`${warningCount} warning line${warningCount === 1 ? "" : "s"}`);
  if (["search", "git", "test", "build"].includes(family) && fileMatches) highlights.push(`${fileMatches} file or match line${fileMatches === 1 ? "" : "s"}`);
  if (packageSignalCount) highlights.push(`${packageSignalCount} package signal${packageSignalCount === 1 ? "" : "s"}`);
  if (deploySignalCount) highlights.push(`${deploySignalCount} deploy signal${deploySignalCount === 1 ? "" : "s"}`);
  if (!highlights.length) highlights.push(`${selectedLines.length} high-signal line${selectedLines.length === 1 ? "" : "s"}`);
  const repeatedSummary = summarizeRepeatedNoise(lines);
  const fileSummary = buildLiveSignalSummary(lines, family);
  const summaryLabel = resolveLiveSummaryLabel(family);
  const preview = renderLiveCompactionText({
    family,
    commandLabel: extractCommandLine(item) || extractToolName(item),
    originalText,
    lineCount: lines.length,
    highlights,
    fileSummary,
    summaryLabel,
    repeatedSummary,
    selectedLines,
    savedPct: 0,
  }, LIVE_TOOL_RETRIEVE_PLACEHOLDER, opts);
  const savedPct = Math.max(0, Math.round(((originalText.length - preview.length) / Math.max(1, originalText.length)) * 100));
  if (savedPct < (opts.liveToolCompactionMinSavingsPct ?? 15)) return null;
  return {
    family,
    commandFamily,
    originalText,
    lineCount: lines.length,
    highlights,
    fileSummary,
    summaryLabel,
    repeatedSummary,
    selectedLines,
    commandLabel: extractCommandLine(item) || extractToolName(item),
    savedPct,
  };
}

function shouldApplyLiveCompaction(item, opts, contextUsagePct, force = false) {
  if (force) return true;
  if (!opts.liveToolCompactionEnabled) return false;
  if (opts.liveToolCompactionMode === "off") return false;
  const currentText = getItemText(item);
  if (typeof currentText !== "string" || currentText.length < (opts.liveToolCompactionMinChars ?? 4000)) return false;
  if (opts.liveToolCompactionMode === "aggressive") return true;
  const runtimeMs = getItemRuntimeMs(item);
  const runtimeReady = runtimeMs == null || runtimeMs >= (opts.liveToolCompactionMinRuntimeMs ?? 2000);
  const sizePressure = currentText.length >= Math.max((opts.liveToolCompactionMinChars ?? 4000) * 2, (opts.liveToolCompactionTargetChars ?? 1800) * 2);
  const contextPressure = typeof contextUsagePct === "number" && contextUsagePct >= (opts.contextUsageThreshold ?? 0.5);
  return runtimeReady && (sizePressure || contextPressure);
}

async function compactStandaloneToolItem(
  item,
  opts = {},
  {
    agentType = null,
    force = false,
    sessionId = null,
    sessionType = null,
    normalizedSessionType = null,
  } = {},
) {
  if (!item || typeof item !== "object") return item;
  const existingText = getItemText(item);
  if (!force && (typeof existingText !== "string" || existingText.length < (opts.liveToolCompactionMinChars ?? 4000))) {
    return item;
  }
  if (opts.liveToolCompactionBlockStructured !== false && isLikelyStructuredOutput(existingText, item)) {
    return item;
  }

  const directGitClass = classifyImmediateGitOutput(item, opts);
  if (directGitClass) {
    const diagnostic = await analyzeCommandDiagnosticForItem(item);
    const logId = await writeToCache(item, extractToolName(item), extractArgsPreview(item), {
      source: "context-cache",
      stage: "live_tool_compaction",
      tier: "tier2",
      compressionKind: "git_tier2",
      compactionMode: "bounded-excerpt",
      family: "git",
      commandFamily: extractCommandFamily(item),
      budgetPolicy: diagnostic?.deltaSummary ? "structured-delta" : "artifact-excerpt",
      originalChars: existingText.length,
    });
    const compactedItem = applyImmediateGitCompression(item, logId, opts);
    if (diagnostic) {
      compactedItem._commandDiagnostics = diagnostic;
      setItemText(compactedItem, appendCommandDiagnosticFooter(getItemText(compactedItem), diagnostic, opts));
    }
    const compactedText = getItemText(compactedItem);
    const envelope = attachCommandEnvelope(compactedItem, {
      family: "git",
      commandFamily: extractCommandFamily(item),
      diagnostic,
      logId,
      originalChars: existingText.length,
      compactedChars: compactedText.length,
      excerptStrategy: "bounded-excerpt",
      directArtifact: true,
    });
    await updateCachedDecision(logId, envelope?.meta || null);
    const spillPointer = buildItemSpillPointer(logId, item, compactedItem, {
      stage: "live_tool_compaction",
      tier: "tier2",
      source: "context-cache",
      compressionKind: "git_tier2",
      compactionMode: "bounded-excerpt",
      family: "git",
      commandFamily: extractCommandFamily(item),
      budgetPolicy: envelope?.meta?.budgetPolicy || "artifact-excerpt",
    });
    const pointerBoundItem = attachSpillPointer(compactedItem, spillPointer);
    recordShreddingEvent(buildCompressionEventPayload({
      item: pointerBoundItem,
      beforeText: existingText,
      afterText: getItemText(pointerBoundItem),
      sessionId,
      stage: "live_tool_compaction",
      decision: "compressed",
      reason: "Live compaction converted a large git payload into a bounded excerpt with retrieval hints.",
      agentType,
      sessionType,
      normalizedSessionType,
      compactionFamily: "git",
      commandFamily: extractCommandFamily(item),
      compressionKind: "git_tier2",
      cachedLogId: logId,
    }));
    return pointerBoundItem;
  }

  const analysis = analyzeLiveToolOutput(item, opts, { force });
  const liveBudgetPolicy = analysis ? chooseLiveBudgetPolicy(analysis.family, analysis, opts) : null;
  if (analysis) {
    const diagnostic = await analyzeCommandDiagnosticForItem(item);
    const logId = await writeToCache(item, extractToolName(item), extractArgsPreview(item), {
      source: "context-cache",
      stage: "live_tool_compaction",
      tier: inferSpillTier({
        compressionKind: "live_signal_excerpt",
        budgetPolicy: liveBudgetPolicy?.name || liveBudgetPolicy?.budget?.decision,
        inlineMode: liveBudgetPolicy?.inlineMode,
        fallback: "structured",
      }),
      compressionKind: "live_signal_excerpt",
      compactionMode: liveBudgetPolicy?.inlineMode || "selected-lines",
      family: analysis.family,
      commandFamily: analysis.commandFamily,
      budgetPolicy: diagnostic?.deltaSummary ? "structured-delta" : "inline-excerpt",
      originalChars: analysis.originalText.length,
    });
    const compactedItemBase = {
      ...item,
      _cachedLogId: logId,
      _liveCompacted: true,
      _liveCompactionFamily: analysis.family,
      _liveCompactionCommandFamily: analysis.commandFamily,
      _liveCompactionPolicy: liveBudgetPolicy,
    };
    if (diagnostic) compactedItemBase._commandDiagnostics = diagnostic;
    setItemText(
      compactedItemBase,
      appendCommandDiagnosticFooter(
        renderLiveCompactionText(analysis, logId, opts),
        diagnostic,
        opts,
      ),
    );
    const compactedText = getItemText(compactedItemBase);
    const envelope = attachCommandEnvelope(compactedItemBase, {
      family: analysis.family,
      commandFamily: analysis.commandFamily,
      diagnostic,
      logId,
      originalChars: analysis.originalText.length,
      compactedChars: compactedText.length,
      excerptStrategy: "selected-lines",
    });
    await updateCachedDecision(logId, envelope?.meta || null);
    const compactedItem = attachSpillPointer(compactedItemBase, buildItemSpillPointer(logId, item, compactedItemBase, {
      stage: "live_tool_compaction",
      tier: inferSpillTier({
        budgetPolicy: envelope?.meta?.budgetPolicy,
        inlineMode: liveBudgetPolicy?.inlineMode,
        compressionKind: "live_signal_excerpt",
        fallback: "structured",
      }),
      source: "context-cache",
      compressionKind: "live_signal_excerpt",
      compactionMode: liveBudgetPolicy?.inlineMode || "selected-lines",
      family: analysis.family,
      commandFamily: analysis.commandFamily,
      budgetPolicy: envelope?.meta?.budgetPolicy || compactedItemBase._semanticBudgetPolicy || "inline-excerpt",
    }));
    recordShreddingEvent(buildCompressionEventPayload({
      item: compactedItem,
      beforeText: analysis.originalText,
      afterText: compactedText,
      sessionId,
      stage: "live_tool_compaction",
      decision: "compressed",
      reason: "Live compaction extracted high-signal lines from a large command result before it entered retained context.",
      agentType,
      sessionType,
      normalizedSessionType,
      compactionFamily: analysis.family,
      commandFamily: analysis.commandFamily,
      compressionKind: "live_signal_excerpt",
      cachedLogId: logId,
    }));
    return compactedItem;
  }

  const diagnostic = await analyzeCommandDiagnosticForItem(item);
  const fallbackFamily = classifyLiveFamily(extractCommandFamily(item), item);
  const logId = await writeToCache(item, extractToolName(item), extractArgsPreview(item), {
    source: "context-cache",
    stage: "live_tool_compaction",
    tier: diagnostic?.insufficientSignal ? "summary" : "structured",
    compressionKind: "live_generic_excerpt",
    compactionMode: diagnostic?.insufficientSignal ? "minimal-summary" : "signal-first",
    family: fallbackFamily,
    commandFamily: extractCommandFamily(item),
    budgetPolicy: diagnostic?.insufficientSignal ? "artifact-summary" : "inline-excerpt",
    originalChars: existingText.length,
  });
  const compactedItemBase = {
    ...item,
    _cachedLogId: logId,
    _liveCompacted: true,
    _liveCompactionFamily: fallbackFamily,
    _liveCompactionCommandFamily: extractCommandFamily(item),
    _liveCompactionPolicy: {
      family: "generic",
      reason: "signal_excerpt",
      budget: {
        targetChars: Math.max(200, Number(opts?.liveToolCompactionTargetChars) || 1800),
        decision: "inline_excerpt",
        retrievable: true,
      },
      why: ["family:generic", "fallback-signal-excerpt"],
    },
  };
  if (diagnostic) compactedItemBase._commandDiagnostics = diagnostic;
  setItemText(
    compactedItemBase,
    appendCommandDiagnosticFooter(
      renderGenericSignalExcerptText(item, logId, opts),
      diagnostic,
      opts,
    ),
  );
  const compactedText = getItemText(compactedItemBase);
  if (!compactedText || compactedText.length >= existingText.length) {
    return item;
  }
  const envelope = attachCommandEnvelope(compactedItemBase, {
    family: fallbackFamily,
    commandFamily: extractCommandFamily(item),
    diagnostic,
    logId,
    originalChars: existingText.length,
    compactedChars: compactedText.length,
    excerptStrategy: diagnostic?.insufficientSignal ? "minimal-summary" : "signal-first",
    directArtifact: diagnostic?.insufficientSignal === true,
  });
  await updateCachedDecision(logId, envelope?.meta || null);
  const compactedItem = attachSpillPointer(compactedItemBase, buildItemSpillPointer(logId, item, compactedItemBase, {
    stage: "live_tool_compaction",
    tier: inferSpillTier({
      budgetPolicy: envelope?.meta?.budgetPolicy,
      inlineMode: compactedItemBase?._liveCompactionPolicy?.budget?.decision,
      compressionKind: "live_generic_excerpt",
      fallback: diagnostic?.insufficientSignal ? "summary" : "structured",
    }),
    source: "context-cache",
    compressionKind: "live_generic_excerpt",
    compactionMode: diagnostic?.insufficientSignal ? "minimal-summary" : "signal-first",
    family: fallbackFamily,
    commandFamily: extractCommandFamily(item),
    budgetPolicy: envelope?.meta?.budgetPolicy || compactedItemBase._semanticBudgetPolicy || "artifact-summary",
  }));
  recordShreddingEvent(buildCompressionEventPayload({
    item: compactedItem,
    beforeText: existingText,
    afterText: compactedText,
    sessionId,
    stage: "live_tool_compaction",
    decision: "compressed",
    reason: "Live compaction fell back to a generic signal-first excerpt to keep the command output retrievable but smaller.",
    agentType,
    sessionType,
    normalizedSessionType,
    compactionFamily: fallbackFamily,
    commandFamily: extractCommandFamily(item),
    compressionKind: "live_generic_excerpt",
    cachedLogId: logId,
  }));
  return compactedItem;
}

async function maybeCompactLiveToolOutputs(items, opts = {}, {
  contextUsagePct = null,
  force = false,
  agentType = null,
  sessionId = null,
  sessionType = null,
  normalizedSessionType = null,
} = {}) {
  if (!Array.isArray(items) || items.length === 0) return items;
  let changed = false;
  const nextItems = [];
  for (const item of items) {
    if (classifyItem(item) !== "tool_output") {
      nextItems.push(item);
      continue;
    }
    if (!shouldApplyLiveCompaction(item, opts, contextUsagePct, force)) {
      nextItems.push(item);
      continue;
    }
    const compactedItem = await compactStandaloneToolItem(item, opts, {
      agentType,
      force,
      sessionId,
      sessionType,
      normalizedSessionType,
    });
    nextItems.push(compactedItem);
    changed = changed || compactedItem !== item;
  }
  return changed ? nextItems : items;
}

export async function compactCommandOutputPayload(
  payload = {},
  {
    sessionType = "flow",
    agentType = "workflow",
    force = true,
  } = {},
) {
  const outputText =
    typeof payload.output === "string"
      ? payload.output
      : typeof payload.stdout === "string"
        ? payload.stdout
        : "";
  const stderrText = typeof payload.stderr === "string" ? payload.stderr : "";
  const trimmedOutput = outputText.trim();
  const trimmedStderr = stderrText.trim();
  const combinedText = [trimmedOutput, trimmedStderr && trimmedStderr !== trimmedOutput ? `[stderr]\n${trimmedStderr}` : ""]
    .filter(Boolean)
    .join("\n\n")
    .trim();

  if (!combinedText) {
    return {
      text: "",
      compacted: false,
      originalChars: 0,
      compactedChars: 0,
      item: null,
      toolLogId: null,
      retrieveCommand: null,
      compactionFamily: null,
      commandFamily: null,
      budgetPolicy: "full-inline",
      budgetReason: "Output fit the inline budget; no retrieval artifact was needed.",
      contextEnvelope: null,
    };
  }

  const syntheticItem = {
    type: "command_execution",
    tool_name: payload.toolName || "command_execution",
    command: String(payload.command || "").trim(),
    arguments: Array.isArray(payload.args)
      ? { argv: payload.args.map((value) => String(value)) }
      : payload.args,
    aggregated_output: combinedText,
    exit_code: Number.isFinite(Number(payload.exitCode)) ? Number(payload.exitCode) : undefined,
    duration_ms: Number.isFinite(Number(payload.durationMs)) ? Number(payload.durationMs) : undefined,
  };

  const compactedItems = await maybeCompressSessionItems([syntheticItem], {
    sessionType,
    agentType,
    force,
    skip: false,
  });
  const compactedItem = compactedItems[0] || syntheticItem;
  const compactedText = String(getItemText(compactedItem) || combinedText).trim();
  const toolLogId = compactedItem?._cachedLogId || null;
  const spillPointer = getItemSpillPointer(compactedItem);
  const commandDiagnostics = compactedItem?._commandDiagnostics || null;
  const contextEnvelope = compactedItem?._contextEnvelope || buildContextEnvelope({
    scope: "command",
    command: extractCommandLine(syntheticItem) || extractToolName(syntheticItem),
    family: compactedItem?._liveCompactionFamily || classifyLiveFamily(extractCommandFamily(syntheticItem), syntheticItem),
    commandFamily: compactedItem?._liveCompactionCommandFamily || extractCommandFamily(syntheticItem),
    budgetPolicy: compactedItem?._semanticBudgetPolicy || (toolLogId ? "inline-excerpt" : "full-inline"),
    budgetReason: compactedItem?._semanticBudgetReason || (toolLogId
      ? "Bosun kept a compact inline summary and stored the full artifact for retrieval."
      : "Output fit the inline budget; no retrieval artifact was needed."),
    retrieveCommand: toolLogId ? `bosun --tool-log ${toolLogId}` : null,
    summary: commandDiagnostics?.summary || "",
    deltaSummary: commandDiagnostics?.deltaSummary || "",
    suggestedRerun: commandDiagnostics?.suggestedRerun || "",
    hint: commandDiagnostics?.hint || "",
    lowSignal: commandDiagnostics?.insufficientSignal === true,
    originalChars: combinedText.length,
    compactedChars: compactedText.length,
    excerptStrategy: toolLogId ? "selected-lines" : "full",
  });

  return {
    text: compactedText,
    compacted: compactedText.length < combinedText.length,
    originalChars: combinedText.length,
    compactedChars: compactedText.length,
    item: compactedItem,
    toolLogId,
    spillPointer,
    retrieveCommand: toolLogId ? `bosun --tool-log ${toolLogId}` : null,
    compactionFamily: compactedItem?._liveCompactionFamily || null,
    commandFamily: compactedItem?._liveCompactionCommandFamily || extractCommandFamily(syntheticItem),
    commandDiagnostics,
    budgetPolicy: contextEnvelope?.meta?.budgetPolicy || compactedItem?._semanticBudgetPolicy || "full-inline",
    budgetReason: contextEnvelope?.meta?.budgetReason || compactedItem?._semanticBudgetReason || "",
    contextEnvelope,
  };
}
function extractCommandText(item) {
  if (!item || typeof item !== "object") return "";

  const directCommand = typeof item.command === "string" ? item.command : "";
  if (directCommand) return directCommand;

  const args = item.arguments || item.args || item.call?.arguments;
  if (typeof args === "string") {
    const trimmed = args.trim();
    if (!trimmed) return "";
    const parsed = safeParse(args);
    if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) {
      return extractCommandText({ arguments: parsed });
    }
    return trimmed;
  }

  if (Array.isArray(args)) {
    return args.map((part) => String(part ?? "")).join(" ").trim();
  }

  const argsObj = args;
  if (!argsObj || typeof argsObj !== "object") return "";

  for (const key of ["command", "cmd", "argv", "args"]) {
    const value = argsObj[key];
    if (typeof value === "string" && value.trim()) return value;
    if (Array.isArray(value)) return value.map((part) => String(part ?? "")).join(" ").trim();
  }

  return "";
}

function normalizeGitTokenSource(value) {
  return String(value || "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function inferGitCommandSignals(toolName, commandText) {
  const normalizedToolName = normalizeGitTokenSource(toolName);
  const normalizedCommand = normalizeGitTokenSource(commandText);
  const merged = `${normalizedCommand} ${normalizedToolName}`.trim();

  const commandLooksGit = /\bgit\b/.test(normalizedCommand);
  const toolLooksGit = normalizedToolName.includes("git");
  if (!toolLooksGit && !commandLooksGit) {
    return {
      eligible: false,
      boundedDiff: false,
      hasLog: false,
      hasShortlog: false,
      hasReflog: false,
      hasDiff: false,
      hasShow: false,
      hasStatus: false,
    };
  }

  let commandBody = normalizedCommand.startsWith("git ")
    ? normalizedCommand.slice(4).trim()
    : normalizedCommand;

  if (!commandBody && toolLooksGit) {
    commandBody = normalizedToolName
      .replaceAll(/\bgit\b/g, " ")
      .replaceAll(/\s+/g, " ")
      .trim();
  }

  const source = `${commandBody} ${normalizedToolName}`.trim();
  const hasShortlog = /\bshortlog\b/.test(source);
  const hasReflog = /\breflog\b/.test(source);
  const hasLog = !hasShortlog && !hasReflog && /\blog\b/.test(source);
  const hasDiff = /\bdiff\b/.test(source);
  const hasShow = /\bshow\b/.test(source);
  const hasStatus = /\bstatus\b/.test(source);
  const boundedDiff = /(?:^|\s)--(?:stat|shortstat|numstat|name-only|name-status|summary)\b/.test(commandBody)
    || /\bdiff(?:\s|-)*(?:stat|shortstat|numstat|name only|name status|summary)\b/.test(merged);
  return { eligible: true, boundedDiff, hasLog, hasShortlog, hasReflog, hasDiff, hasShow, hasStatus };
}

function classifyImmediateGitOutput(item, opts) {
  const maxChars = opts?.gitOutputMaxChars ?? DEFAULT_GIT_OUTPUT_MAX_CHARS;
  if (!Number.isFinite(maxChars) || maxChars <= 0) return null;

  const text = getItemText(item);
  if (typeof text !== "string" || text.length <= maxChars) return null;

  const toolName = extractToolName(item);
  const commandText = extractCommandText(item);
  const {
    eligible,
    boundedDiff,
    hasLog,
    hasShortlog,
    hasReflog,
    hasDiff,
    hasShow,
    hasStatus,
  } = inferGitCommandSignals(toolName, commandText);
  if (!eligible) return null;

  if (hasStatus || hasShow) return null;
  if (hasShortlog) return { kind: "shortlog", text };
  if (hasReflog) return { kind: "reflog", text };
  if (hasLog) return { kind: "log", text };
  if (hasDiff && !boundedDiff) return { kind: "diff", text };

  return null;
}

function compressImmediateGitText(text, logId, opts) {
  const headChars = opts?.tier2HeadChars ?? TIER_2_HEAD_CHARS;
  const tailChars = opts?.tier2TailChars ?? TIER_2_TAIL_CHARS;
  if (typeof text !== "string" || text.length <= headChars + tailChars + 200) {
    return text;
  }

  const head = text.slice(0, headChars);
  const tail = tailChars > 0 ? text.slice(-tailChars) : "";
  const omitted = text.length - headChars - (tailChars > 0 ? tailChars : 0);
  const lineCount = text.length === 0 ? 0 : (text.match(/\n/g) || []).length + 1;
  const note = `\n\n[…git capped: ${lineCount} lines, ${omitted} chars suppressed. Full: bosun --tool-log ${logId}]\n\n`;
  return head + note + tail;
}

function applyImmediateGitCompression(item, logId, opts) {
  const compressedBase = {
    ...item,
    _cachedLogId: logId,
    _compressed: "git_tier2",
    _liveCompacted: true,
    _liveCompactionFamily: "git",
    _liveCompactionCommandFamily: extractCommandFamily(item),
    _liveCompactionPolicy: {
      family: "generic",
      reason: "signal_excerpt",
      budget: {
        targetChars: Math.max(200, Number(opts?.liveToolCompactionTargetChars) || 1800),
        decision: "inline_excerpt",
        retrievable: true,
      },
      why: ["family:generic", "fallback-signal-excerpt"],
    },
  };
  setItemText(compressedBase, compressImmediateGitText(getItemText(item), logId, opts));
  return attachSpillPointer(compressedBase, buildItemSpillPointer(logId, item, compressedBase, {
    stage: "historical_tool_compaction",
    tier: "tier2",
    source: "context-cache",
    compressionKind: "git_tier2",
    compactionMode: "bounded-excerpt",
    family: "git",
    commandFamily: extractCommandFamily(item),
    budgetPolicy: "artifact-excerpt",
  }));
}
// ---------------------------------------------------------------------------
// Tiered Compression
// ---------------------------------------------------------------------------

/**
 * Light compression (Tier 1): keep head + tail of output.
 * ~20% reduction for typical outputs.
 */
function compressTier1(text, logId, opts) {
  const headChars = opts?.tier1HeadChars ?? TIER_1_HEAD_CHARS;
  const tailChars = opts?.tier1TailChars ?? TIER_1_TAIL_CHARS;
  if (typeof text !== "string" || text.length <= headChars + tailChars + 200) {
    return text; // small enough already
  }
  const head = text.slice(0, headChars);
  const tail = tailChars > 0 ? text.slice(-tailChars) : "";
  const omitted = text.length - headChars - (tailChars > 0 ? tailChars : 0);
  return (
    head +
    `\n\n[…${omitted} chars compressed — full output: bosun --tool-log ${logId}]\n\n` +
    tail
  );
}

/**
 * Moderate compression (Tier 2): smaller head + tail.
 * ~60% reduction for typical outputs.
 */
function compressTier2(text, logId, opts) {
  const headChars = opts?.tier2HeadChars ?? TIER_2_HEAD_CHARS;
  const tailChars = opts?.tier2TailChars ?? TIER_2_TAIL_CHARS;
  if (typeof text !== "string" || text.length <= headChars + tailChars + 200) {
    return text;
  }
  const head = text.slice(0, headChars);
  const tail = tailChars > 0 ? text.slice(-tailChars) : "";
  const omitted = text.length - headChars - (tailChars > 0 ? tailChars : 0);
  return (
    head +
    `\n\n[…${omitted} chars compressed — full output: bosun --tool-log ${logId}]\n\n` +
    tail
  );
}

/**
 * Maximum compression (Tier 3): skeleton only.
 * Just tool name, args preview, output size, and retrieval command.
 */
function compressTier3(item, logId) {
  const toolName = extractToolName(item);
  const argsPreview = extractArgsPreview(item);
  const text = getItemText(item);
  const size = charLabel(text);
  return `[Cached tool call] ${toolName}(${argsPreview}) → ${size} | Retrieve: bosun --tool-log ${logId}`;
}

/**
 * Apply compression to an item at the appropriate tier, replacing text content.
 *
 * @param {object} item      The original item
 * @param {number} logId     The cache log ID
 * @param {number} tier      Compression tier (1, 2, or 3)
 * @returns {object}         New item with compressed text
 */
function applyCompression(item, logId, tier, opts) {
  if (!item || typeof item !== "object") return item;

  if (tier === 3) {
    // Skeleton — replace the entire item with a minimal summary
    const compressed = {
      type: item.type || "context_compressed",
      _cachedLogId: logId,
      _compressed: "tool_tier3",
      text: compressTier3(item, logId),
    };
    return attachSpillPointer(compressed, buildItemSpillPointer(logId, item, compressed, {
      stage: "historical_tool_compaction",
      tier: "tier3",
      source: "context-cache",
      compressionKind: "tool_tier3",
      compactionMode: "skeleton-summary",
      family: "tool-output",
      commandFamily: extractCommandFamily(item),
      budgetPolicy: "artifact-summary",
    }));
  }

  const compressor = tier === 1
    ? (text, id) => compressTier1(text, id, opts)
    : (text, id) => compressTier2(text, id, opts);
  const next = { ...item };
  next._cachedLogId = logId;
  next._compressed = tier === 1 ? "tool_tier1" : "tool_tier2";

  // Compress all text-bearing fields
  const textKeys = ["text", "output", "aggregated_output", "result", "message"];
  for (const key of textKeys) {
    if (typeof next[key] === "string" && next[key].length > 200) {
      next[key] = compressor(next[key], logId);
    }
  }

  if (Array.isArray(next.content)) {
    next.content = next.content.map((entry) => {
      if (entry && typeof entry === "object" && typeof entry.text === "string" && entry.text.length > 200) {
        return { ...entry, text: compressor(entry.text, logId) };
      }
      return entry;
    });
  }

  return attachSpillPointer(next, buildItemSpillPointer(logId, item, next, {
    stage: "historical_tool_compaction",
    tier: tier === 1 ? "tier1" : "tier2",
    source: "context-cache",
    compressionKind: next._compressed,
    compactionMode: tier === 1 ? "head-tail-wide" : "head-tail-tight",
    family: "tool-output",
    commandFamily: extractCommandFamily(item),
    budgetPolicy: tier === 1 ? "artifact-excerpt" : "inline-excerpt",
  }));
}

// ---------------------------------------------------------------------------
// Assign Turns to Items
// ---------------------------------------------------------------------------

/**
 * Determine the "turn" of an item based on its position in the items array.
 * Items generated by tool calls that produce output are grouped into turns.
 *
 * We use a simple heuristic: each "tool_call" / "function_call" or
 * "item.completed" with tool output increments the turn counter.
 *
 * @param {Array} items  The full items array
 * @returns {Array<{ item: object, turn: number, index: number }>}
 */
function assignTurns(items) {
  let currentTurn = 0;
  const result = [];

  for (const item of items) {
    if (!item || typeof item !== "object") {
      result.push({ item, turn: currentTurn });
      continue;
    }

    // Detect turn boundaries: tool outputs, agent messages
    const isToolOutput =
      item.type === "function_call_output" ||
      item.type === "tool_result" ||
      item.type === "tool_output" ||
      item.type === "command_output" ||
      item.type === "command_execution" ||
      (item.type === "item.completed" && item.item?.type !== "agent_message");

    if (isToolOutput) {
      currentTurn++;
    }

    result.push({ item, turn: currentTurn });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers — extracted for readability
// ---------------------------------------------------------------------------

/**
 * Determine compression tier from item age.
 * @param {number} age  currentTurn - itemTurn
 * @returns {1|2|3}
 */
function resolveTier(age, opts) {
  const t1 = opts?.tier1MaxAge ?? TIER_1_MAX_AGE;
  const t2 = opts?.tier2MaxAge ?? TIER_2_MAX_AGE;
  if (age <= t1) return 1;
  if (age <= t2) return 2;
  return 3;
}

/**
 * Decide whether an item is a candidate for compression (has enough text).
 * @param {object} item
 * @returns {boolean}
 */
function isCompressCandidate(item) {
  const text = getItemText(item);
  return Boolean(text && text.length >= 200);
}

// ===========================================================================
// CONTENT-AWARE RELEVANCE SCORING
// ===========================================================================
//
// Age-based compression is necessary but insufficient.  A 3-line file read
// from 8 turns ago might be the critical method definition the agent is
// currently modifying, while a 400-result grep search from 2 turns ago is
// 99% noise.
//
// This system scores each tool output's "value density" on a 0-100 scale,
// then uses that score to shift the compression tier:
//
//   High score (70-100) → protect: shift tier down by 2 (delay compression)
//   Normal     (30-69)  → default: use age-based tier as-is
//   Low score  (0-29)   → accelerate: shift tier up by 1 (compress sooner)
//
// Additionally, RETROSPECTIVE RELEVANCE scans subsequent items to detect
// which parts of a large output the agent actually used (by matching file
// paths, symbol names, etc.).
//
// Everything is deterministic — zero API cost, zero latency.
// ---------------------------------------------------------------------------

// ── Score thresholds ──────────────────────────────────────────────────────
// These module-scope constants are the defaults; opts can override them.
const SCORE_HIGH_DEFAULT = 70;   // protect from compression
const SCORE_LOW_DEFAULT = 30;    // accelerate compression
/** @deprecated use SCORE_HIGH_DEFAULT; kept for backward-compat references */
const SCORE_HIGH = SCORE_HIGH_DEFAULT;
/** @deprecated use SCORE_LOW_DEFAULT; kept for backward-compat references */
const SCORE_LOW = SCORE_LOW_DEFAULT;
const TIER_SHIFT_PROTECT = -2;
const TIER_SHIFT_ACCELERATE = 1;

// ── Tool type scoring profiles ────────────────────────────────────────────
// Maps tool types / names to baseline value density.
// Specific reads are high-value; broad searches are low-value.
const TOOL_SCORE_PROFILES = {
  // High-value: targeted, specific reads
  read_file:                85,
  readFile:                 85,
  file_read:                85,

  // High-value: the agent is actively changing code
  replace_string_in_file:   90,
  create_file:              90,
  edit_file:                90,
  file_change:              85,

  // Medium-value: errors/diagnostics the agent might need
  get_errors:               75,
  command_execution:        50,  // varies — adjusted by exit code & output size
  run_in_terminal:          50,

  // Low-value: broad discovery — most results are noise
  grep_search:              30,
  semantic_search:          25,
  file_search:              20,
  search_subagent:          25,
  web_search:               20,
  list_dir:                 35,
  list_directory:           35,

  // Medium: MCP tools (vary widely, default to medium)
  mcp_tool_call:            45,
};

/**
 * Score a tool output item's inherent value density (0-100).
 *
 * Uses multiple signals:
 *   1. Tool type (baseline from TOOL_SCORE_PROFILES)
 *   2. Output size (small = higher density, large = lower density)
 *   3. Specificity signals (line ranges, single file vs. many matches)
 *   4. Error/success status
 *
 * @param {object} item  The tool output item
 * @returns {number}     Score 0-100
 */
export function scoreToolOutput(item) {
  if (!item || typeof item !== "object") return 50;

  const toolName = extractToolName(item);
  const text = getItemText(item);
  const textLen = text?.length || 0;

  // 1. Baseline from tool type
  let score = resolveBaseScore(toolName);

  // 2. Size adjustment — small outputs are denser
  score += scoreSizeAdjustment(textLen);

  // 3. Specificity signals
  score += scoreSpecificityAdjustment(item, toolName, textLen);

  // 4. Error/success signal
  score += scoreErrorAdjustment(item);

  // Clamp to 0-100
  return Math.max(0, Math.min(100, score));
}

/**
 * Resolve a baseline score from tool name, with fuzzy matching.
 * @param {string} toolName
 * @returns {number}
 */
function resolveBaseScore(toolName) {
  if (!toolName) return 50;
  const lower = toolName.toLowerCase();

  // Direct match
  if (TOOL_SCORE_PROFILES[toolName] !== undefined) {
    return TOOL_SCORE_PROFILES[toolName];
  }

  // Fuzzy match: check if any profile key is contained in the tool name
  for (const [key, val] of Object.entries(TOOL_SCORE_PROFILES)) {
    if (lower.includes(key.toLowerCase())) return val;
  }

  // Check for common patterns
  if (lower.includes("read") || lower.includes("get_file")) return 80;
  if (lower.includes("search") || lower.includes("find")) return 25;
  if (lower.includes("edit") || lower.includes("write") || lower.includes("replace")) return 85;
  if (lower.includes("list") || lower.includes("dir")) return 35;
  if (lower.includes("run") || lower.includes("exec") || lower.includes("terminal")) return 50;

  return 50; // unknown tool — neutral
}

/**
 * Adjust score based on output size.
 * Small outputs (< 500 chars) are almost always high-value.
 * Very large outputs (> 10K) are almost always search dumps.
 *
 * @param {number} textLen
 * @returns {number}  Adjustment (-20 to +20)
 */
function scoreSizeAdjustment(textLen) {
  if (textLen < 200)   return 20;   // tiny → almost certainly targeted
  if (textLen < 500)   return 15;   // small → probably a specific read
  if (textLen < 2000)  return 5;    // medium → neutral
  if (textLen < 5000)  return 0;    // normal
  if (textLen < 10000) return -5;   // large → getting noisy
  if (textLen < 20000) return -10;  // very large → likely search dump
  return -20;                        // huge → almost certainly bulk results
}

/**
 * Adjust score based on specificity signals in the item.
 *
 * @param {object} item
 * @param {string} toolName
 * @param {number} textLen
 * @returns {number}  Adjustment (-15 to +15)
 */
function scoreSpecificityAdjustment(item, toolName, textLen) {
  let adj = 0;
  const args = item.arguments || item.args || item.call?.arguments || {};
  const argsObj = typeof args === "string" ? safeParse(args) : args;

  // File reads with narrow line ranges are highly specific
  if (argsObj.startLine && argsObj.endLine) {
    const range = Number(argsObj.endLine) - Number(argsObj.startLine);
    if (range <= 30) adj += 15;       // reading ≤30 lines = very targeted
    else if (range <= 100) adj += 5;  // reading ≤100 lines = moderately targeted
    else adj -= 5;                     // reading 200+ lines = broad
  }

  // Single file path = more specific than no path
  if (argsObj.filePath || argsObj.file || argsObj.path) {
    adj += 5;
  }

  // Search results: count match lines as a noise indicator
  const lower = toolName.toLowerCase();
  if (lower.includes("search") || lower.includes("grep") || lower.includes("find")) {
    const matchCount = countSearchMatches(item);
    if (matchCount > 50) adj -= 15;       // 50+ matches = very noisy
    else if (matchCount > 20) adj -= 10;  // 20+ = noisy
    else if (matchCount > 5) adj -= 5;    // 5+ = moderate
    else if (matchCount <= 3) adj += 5;   // ≤3 = highly specific
  }

  return adj;
}

/**
 * Adjust score based on error/success signals.
 *
 * @param {object} item
 * @returns {number}  Adjustment (-10 to +10)
 */
function scoreErrorAdjustment(item) {
  // Command execution with non-zero exit → errors are valuable for debugging
  if (item.exit_code !== undefined) {
    if (item.exit_code !== 0) return 10;  // error output is important
    // Successful commands with tiny output → just need to know it worked
    const text = getItemText(item);
    if (text && text.length < 100) return 5; // compact success
  }

  // Items with error fields are diagnostic — preserve longer
  if (item.error) return 10;

  return 0;
}

/**
 * Count the number of search match lines in a tool output.
 * Heuristic: count lines matching common search result patterns.
 *
 * @param {object} item
 * @returns {number}
 */
function countSearchMatches(item) {
  const text = getItemText(item);
  if (!text) return 0;

  // Count lines that look like search results:
  //   - "path/file.ts:123: matched text"  (grep format)
  //   - "<match path="..." line=N>"       (XML match format)
  //   - "  src/foo.ts"                    (file search format)
  let count = 0;
  const lines = text.split("\n");
  for (const line of lines) {
    if (
      /^\s*\S+\.\w+:\d+/.test(line) ||          // grep: file.ts:123
      /<match\s+path=/.test(line) ||             // XML match
      /^\d+\s+match/.test(line) ||               // "N matches"
      /^\s+\S+\.\w+\s*$/.test(line)              // bare file path
    ) {
      count++;
    }
  }
  return count;
}

/**
 * Safely parse JSON, returning empty object on failure.
 * @param {string} str
 * @returns {object}
 */
function safeParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Retrospective Relevance
// ---------------------------------------------------------------------------
//
// After scoring each item individually, scan SUBSEQUENT items to detect
// which earlier tool outputs the agent actually acted on.
//
// Signals:
//   - Agent reads file X → any earlier search mentioning file X is relevant
//   - Agent edits file X at line Y → any earlier read of X around line Y
//     is highly relevant
//   - Agent references a symbol name → outputs containing that symbol
//     are relevant
//
// Items identified as "retrospectively relevant" get their score boosted.
// ---------------------------------------------------------------------------

/**
 * Try to extract a path value from an argument key.
 * @returns {string|null}  normalised path or null
 */
function extractPathFromArg(argsObj, key) {
  const val = argsObj[key];
  if (typeof val !== "string" || val.length <= 2 || val.length >= 300) return null;
  if (/[/\\]/.test(val) || /\.\w{1,6}$/.test(val)) {
    return normalizePathForMatching(val);
  }
  return null;
}

/**
 * Extract file paths and line numbers from an item's arguments.
 *
 * @param {object} item
 * @returns {{ paths: string[], lines: number[] }}
 */
function extractItemTargets(item) {
  if (!item || typeof item !== "object") return { paths: [], lines: [] };

  const args = item.arguments || item.args || item.call?.arguments || {};
  const argsObj = typeof args === "string" ? safeParse(args) : args;

  const paths = [];
  const lines = [];

  // Collect file paths from various fields
  for (const key of ["filePath", "file", "path", "includePattern", "query"]) {
    const p = extractPathFromArg(argsObj, key);
    if (p) paths.push(p);
  }

  // Collect line numbers
  for (const key of ["startLine", "endLine", "line"]) {
    const val = Number(argsObj[key]);
    if (Number.isFinite(val) && val > 0) lines.push(val);
  }

  // Also extract paths from file_change items
  if (Array.isArray(item.changes)) {
    for (const ch of item.changes) {
      if (ch?.path) paths.push(normalizePathForMatching(ch.path));
    }
  }

  return { paths, lines };
}

/**
 * Normalize a file path for fuzzy matching: lowercase, forward slashes,
 * strip leading ./ or absolute prefix.
 *
 * @param {string} p
 * @returns {string}
 */
function normalizePathForMatching(p) {
  return p
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .toLowerCase();
}

/**
 * Build a retrospective relevance map for a sequence of turn-tagged items.
 *
 * Scans items from newest to oldest. For each item that acts on a file path
 * (read, edit, terminal command referencing a path), marks any OLDER item
 * that mentions that path in its output as "retrospectively relevant."
 *
 * @param {Array<{item: object, turn: number}>} turnItems
 * @returns {Map<object, number>}  item → bonus score (0-30)
 */
function buildRetrospectiveRelevanceMap(turnItems) {
  const bonusMap = new Map();

  // Phase 1: Collect all "action paths" — files the agent explicitly targeted
  //          in reads, edits, or commands.
  const actionPaths = new Set();
  for (const { item } of turnItems) {
    const { paths } = extractItemTargets(item);
    for (const p of paths) actionPaths.add(p);
  }

  if (actionPaths.size === 0) return bonusMap;

  // Phase 2: For each older item, check if its OUTPUT mentions any action path.
  //          If yes, that item's output contained something the agent later used.
  for (const { item } of turnItems) {
    const text = getItemText(item);
    if (!text || text.length < 50) continue;

    const textLower = text.toLowerCase().replaceAll("\\", "/");
    let matchCount = 0;

    for (const actionPath of actionPaths) {
      // Use just the filename or last 2 segments for matching
      // to avoid false negatives from different absolute path prefixes
      const segments = actionPath.split("/");
      const shortPath = segments.slice(-2).join("/");
      if (shortPath.length >= 4 && textLower.includes(shortPath)) {
        matchCount++;
      }
    }

    if (matchCount > 0) {
      // Bonus proportional to how many action paths this output mentions
      // Cap at 30 to avoid over-protecting search results that mention
      // half the codebase
      const bonus = Math.min(30, matchCount * 10);
      bonusMap.set(item, bonus);
    }
  }

  return bonusMap;
}

/**
 * Apply score-based tier adjustment.
 *
 * High scores protect items from compression (shift tier down).
 * Low scores accelerate compression (shift tier up).
 *
 * @param {number} baseTier  The age-based tier (1, 2, or 3)
 * @param {number} score     The content-aware score (0-100)
 * @returns {number}         Adjusted tier (0, 1, 2, or 3)
 */
function adjustTierByScore(baseTier, score, opts) {
  const high = opts?.scoreHighThreshold ?? SCORE_HIGH_DEFAULT;
  const low  = opts?.scoreLowThreshold  ?? SCORE_LOW_DEFAULT;
  if (score >= high) {
    // Protect: shift tier down (less compression)
    return Math.max(0, baseTier + TIER_SHIFT_PROTECT);
  }
  if (score < low) {
    // Accelerate: shift tier up (more compression)
    return Math.min(3, baseTier + TIER_SHIFT_ACCELERATE);
  }
  return baseTier; // Normal: use age-based tier as-is
}

// ---------------------------------------------------------------------------
// Smart Search Result Compression
// ---------------------------------------------------------------------------
//
// For large search outputs (grep_search with 50+ results), instead of
// just head/tail truncation, extract only the results that the agent
// actually used (by matching against subsequent file reads/edits).
// ---------------------------------------------------------------------------

/**
 * Smart-compress a large search result by keeping only relevant matches.
 *
 * @param {string}    text         The full search output
 * @param {Set<string>} actionPaths  Paths the agent later acted on
 * @param {number}    logId        Cache log ID for retrieval command
 * @returns {string}               Compressed output with relevant matches preserved
 */
function smartCompressSearchResult(text, actionPaths, logId) {
  if (!text || actionPaths.size === 0) return null; // fall back to standard compression

  const lines = text.split("\n");
  const keptLines = [];
  let droppedCount = 0;

  for (const line of lines) {
    const lineLower = line.toLowerCase().replaceAll("\\", "/");
    let isRelevant = false;

    // Keep lines that mention any action path
    for (const actionPath of actionPaths) {
      const segments = actionPath.split("/");
      const shortPath = segments.slice(-2).join("/");
      if (shortPath.length >= 4 && lineLower.includes(shortPath)) {
        isRelevant = true;
        break;
      }
    }

    // Also keep header/summary lines (first 2, last 1)
    if (keptLines.length < 2 || lines.indexOf(line) >= lines.length - 1) {
      isRelevant = true;
    }

    if (isRelevant) {
      keptLines.push(line);
    } else {
      droppedCount++;
    }
  }

  // Only use smart compression if we actually filtered something significant
  if (droppedCount < 5) return null; // not worth it — fall back to standard

  const compressed = keptLines.join("\n");
  return (
    compressed +
    `\n\n[…${droppedCount} irrelevant search results filtered — full output: bosun --tool-log ${logId}]`
  );
}

// ---------------------------------------------------------------------------
// Main Entry Point (Content-Aware)
// ---------------------------------------------------------------------------

/**
 * Cache old tool outputs to disk and apply tiered compression.
 *
 * This is the main API. Call it with the accumulated items array and the
 * system returns a new array with old items compressed and cache-backed.
 *
 * Items that are NOT tool outputs (agent messages, stream notices) are
 * passed through untouched.
 *
 * @param {Array}  items       The full accumulated items array
 * @param {object} [options]   Optional overrides
 * @param {number} [options.fullContextTurns=3]  Turns to keep in full
 * @returns {Promise<Array>}   New items array with compression applied
 */
export async function cacheAndCompressItems(items, options = {}) {
  if (!Array.isArray(items) || items.length === 0) return items;

  // If shredding is explicitly disabled, pass through unchanged
  if (options._skip === true) return items;

  const opts = resolveOpts(options);

  // Skip tool output compression if disabled
  if (!opts.compressToolOutputs) {
    return items;
  }

  const turnItems = assignTurns(items);
  const maxTurn = turnItems.reduce((m, t) => Math.max(m, t.turn), 0);

  // ── Content-aware scoring pass ──────────────────────────────────────────
  // Phase 1: Score every item's inherent value density
  const scores = new Map();
  for (const { item } of turnItems) {
    scores.set(item, scoreToolOutput(item));
  }

  // Phase 2: Retrospective relevance — boost items whose output the agent
  //          later acted on (read/edited a file mentioned in search results)
  const retroBonus = buildRetrospectiveRelevanceMap(turnItems);
  for (const [item, bonus] of retroBonus) {
    const current = scores.get(item) || 50;
    scores.set(item, Math.min(100, current + bonus));
  }

  // Collect all action paths for smart search compression
  const actionPaths = new Set();
  for (const { item } of turnItems) {
    const { paths } = extractItemTargets(item);
    for (const p of paths) actionPaths.add(p);
  }

  const result = [];
  const cachePromises = [];
  const trace = options?._compressionTrace && typeof options._compressionTrace === "object"
    ? { ...options._compressionTrace }
    : null;

  for (const { item, turn } of turnItems) {
    const age = maxTurn - turn;
    processCompressItem(
      item, age, scores, actionPaths, result, cachePromises, opts, trace,
    );
  }

  // Await all cache writes in parallel
  if (cachePromises.length > 0) {
    await Promise.all(cachePromises);
  }

  return result;
}

/**
 * Process a single item for the compression pipeline (extracted to keep
 * `cacheAndCompressItems` under cognitive-complexity limit).
 * @param {object} item
 * @param {number} age
 * @param {Map} scores
 * @param {Set} actionPaths
 * @param {Array} result     Mutated — items are pushed here
 * @param {Array} cachePromises  Mutated — cache promises pushed here
 */
function processCompressItem(item, age, scores, actionPaths, result, cachePromises, opts, trace = null) {
  const immediateGitOutput = classifyImmediateGitOutput(item, opts);
  if (immediateGitOutput && !item._cachedLogId) {
    const toolName = extractToolName(item);
    const argsPreview = extractArgsPreview(item);
    const cacheIdx = result.length;
    result.push(item);
    cachePromises.push(
      writeToCache(item, toolName, argsPreview, {
        source: "context-cache",
        stage: "historical_tool_compaction",
        tier: "tier2",
        compressionKind: "git_tier2",
        compactionMode: "bounded-excerpt",
        family: "git",
        commandFamily: extractCommandFamily(item),
        budgetPolicy: "artifact-excerpt",
        originalChars: getItemText(item).length,
      }).then((logId) => {
        const nextItem = applyImmediateGitCompression(item, logId, opts);
        result[cacheIdx] = nextItem;
        if (trace) {
          recordShreddingEvent(buildCompressionEventPayload({
            item: nextItem,
            beforeText: getItemText(item),
            afterText: getItemText(nextItem),
            sessionId: trace.sessionId,
            stage: "historical_tool_compaction",
            decision: "compressed",
            reason: "Immediate git output cap compacted an oversized diff or status payload.",
            agentType: trace.agentType,
            sessionType: trace.sessionType,
            normalizedSessionType: trace.normalizedSessionType,
            compactionFamily: "git",
            commandFamily: extractCommandFamily(item),
            compressionKind: "git_tier2",
            cachedLogId: logId,
          }));
        }
      }),
    );
    return;
  }

  // Tier 0: keep full
  const tier0Limit = opts?.tier0MaxAge ?? TIER_0_MAX_AGE;
  if (age <= tier0Limit) { result.push(item); return; }

  // Skip items that have no meaningful text to compress
  if (!isCompressCandidate(item)) { result.push(item); return; }

  // Content-aware tier resolution
  const itemScore = scores.get(item) ?? 50;
  const baseTier = resolveTier(age, opts);
  const tier = adjustTierByScore(baseTier, itemScore, opts);

  // Tier 0 after score adjustment: item is valuable enough to protect
  if (tier === 0) { result.push(item); return; }

  // Already compressed? Re-apply at potentially more aggressive tier
  if (item._cachedLogId) {
    const nextItem = applyCompression(item, item._cachedLogId, tier, opts);
    result.push(nextItem);
    if (trace) {
      recordShreddingEvent(buildCompressionEventPayload({
        item: nextItem,
        beforeText: getItemText(item),
        afterText: getItemText(nextItem),
        sessionId: trace.sessionId,
        stage: "historical_tool_compaction",
        decision: "compressed",
        reason: "An older tool output was re-compacted at a more aggressive context tier.",
        agentType: trace.agentType,
        sessionType: trace.sessionType,
        normalizedSessionType: trace.normalizedSessionType,
        compactionFamily: "tool-output",
        commandFamily: extractCommandFamily(item),
        compressionKind: `tool_tier${tier}`,
        cachedLogId: item._cachedLogId,
      }));
    }
    return;
  }

  // Cache the original, then compress
  const toolName = extractToolName(item);
  const argsPreview = extractArgsPreview(item);
  const cacheIdx = result.length;
  result.push(item); // placeholder — will be replaced

  cachePromises.push(
    writeToCache(item, toolName, argsPreview, {
      source: "context-cache",
      stage: "historical_tool_compaction",
      tier: tier === 1 ? "tier1" : tier === 2 ? "tier2" : "tier3",
      compressionKind: `tool_tier${tier}`,
      compactionMode: tier === 1 ? "head-tail-wide" : tier === 2 ? "head-tail-tight" : "skeleton-summary",
      family: "tool-output",
      commandFamily: extractCommandFamily(item),
      budgetPolicy: tier === 3 ? "artifact-summary" : tier === 1 ? "artifact-excerpt" : "inline-excerpt",
      originalChars: getItemText(item).length,
    }).then((logId) => {
      const smartResult = trySmartSearchCompress(item, toolName, itemScore, actionPaths, logId, opts);
      const nextItem = smartResult || applyCompression(item, logId, tier, opts);
      result[cacheIdx] = nextItem;
      if (trace) {
        recordShreddingEvent(buildCompressionEventPayload({
          item: nextItem,
          beforeText: getItemText(item),
          afterText: getItemText(nextItem),
          sessionId: trace.sessionId,
          stage: "historical_tool_compaction",
          decision: "compressed",
          reason: smartResult
            ? "A low-signal historical search result was compacted to keep only action-relevant lines."
            : "An older tool output was compacted to reduce retained session context.",
          agentType: trace.agentType,
          sessionType: trace.sessionType,
          normalizedSessionType: trace.normalizedSessionType,
          compactionFamily: smartResult ? "search" : "tool-output",
          commandFamily: extractCommandFamily(item),
          compressionKind: smartResult ? "search_signal_excerpt" : `tool_tier${tier}`,
          cachedLogId: logId,
        }));
      }
    }),
  );
}

/**
 * Attempt smart search result compression for low-score search outputs.
 * Returns null if smart compression is not applicable.
 */
function trySmartSearchCompress(item, toolName, itemScore, actionPaths, logId, opts) {
  const scoreLow = opts?.scoreLowThreshold ?? SCORE_LOW_DEFAULT;
  if (itemScore >= scoreLow || actionPaths.size === 0) return null;
  const lower = (toolName || "").toLowerCase();
  const isSearch =
    lower.includes("search") || lower.includes("grep") || lower.includes("find");
  if (!isSearch) return null;

  const text = getItemText(item);
  const smartText = smartCompressSearchResult(text, actionPaths, logId);
  if (!smartText) return null;

  const compressed = { ...item, _cachedLogId: logId, _compressed: "search_signal_excerpt" };
  setItemText(compressed, smartText);
  return attachSpillPointer(compressed, buildItemSpillPointer(logId, item, compressed, {
    stage: "historical_tool_compaction",
    tier: "structured",
    source: "context-cache",
    compressionKind: "search_signal_excerpt",
    compactionMode: "action-aware-signal-lines",
    family: "search",
    commandFamily: extractCommandFamily(item),
    budgetPolicy: "inline-excerpt",
  }));
}

// ===========================================================================
// MESSAGE COMPRESSION — Agent & User Text
// ===========================================================================
//
// Tool outputs are already handled above.  This section compresses the
// *other* two categories that bloat long-running sessions:
//
//   1. Agent "thinking" messages — verbose planning, narration, step lists.
//      Example:  "Now let me implement the integration.  I need to:\n
//        1. Import cacheAndCompressItems…\n  2. Apply compression…"
//      Compressed:  "Implement context-cache integration across 5 files"
//
//   2. User request messages — the original prompt.  Critical for the
//      current turn, but nearly zero value once the task is complete.
//      Compressed:  "[User request: implement tiered context compression]"
//
//   3. Pinned content — instructions, AGENTS.md rules, system directives.
//      These are NEVER compressed, regardless of age.
//
// All compression is deterministic (zero API cost, zero latency).
// ---------------------------------------------------------------------------

// ── Instruction-pinning keywords ──────────────────────────────────────────
// If an item's text contains ANY of these markers (case-insensitive),
// it is classified as "pinned" and exempt from compression.
const PINNED_KEYWORDS = [
  "AGENTS.md",
  "CRITICAL",
  "MUST NOT",
  "MUST NEVER",
  "NEVER use",
  "ALWAYS use",
  "MANDATORY",
  "HARD RULE",
  "## Instructions",
  "## Rules",
  "# AGENT DIRECTIVE",
  "Pre-commit",
  "Pre-push",
  "Commit Conventions",
  "conventional commits",
  "--no-verify",
  "permanently banned",
  "Module-scope caching",
  "Async safety",
  "Error boundaries",
  "Test quality",
  "No architectural shortcuts",
  "_pinned",
];

/** Pre-compiled regex for pinned detection (case-insensitive) */
const PINNED_RE = new RegExp(
  PINNED_KEYWORDS.map((k) => k.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)).join("|"),
  "i",
);

// ── Agent message compression parameters ──────────────────────────────────
// Age thresholds for agent messages (turns since the message was produced)
const MSG_TIER_0_MAX_AGE = 1;   // current + previous turn: full text
const MSG_TIER_1_MAX_AGE = 4;   // turns 2-4: moderate compression
                                 // turns 5+:  breadcrumb only

// Minimum text length to bother compressing
const MSG_MIN_COMPRESS_CHARS = 120;

// ── User message compression parameters ──────────────────────────────────
const USER_MSG_FULL_TURNS = 1;  // only the CURRENT turn keeps the full user prompt
const USER_MSG_BREADCRUMB_MAX = 100; // max chars for the breadcrumb summary

// ---------------------------------------------------------------------------
// Pinning Detection
// ---------------------------------------------------------------------------

/**
 * Check if an item contains instruction/rule content that must be preserved.
 *
 * Detects:
 *   - Explicit `_pinned: true` flag
 *   - AGENTS.md content / repo rules
 *   - System directives (CRITICAL, MUST, NEVER, etc.)
 *   - Commit conventions, pre-push rules, etc.
 *
 * @param {object} item
 * @returns {boolean}
 */
export function isItemPinned(item) {
  if (!item || typeof item !== "object") return false;

  // Explicit pin flag
  if (item._pinned === true) return true;

  // Check text content
  const text = getItemText(item);
  if (!text) return false;

  return PINNED_RE.test(text);
}

// ---------------------------------------------------------------------------
// Deterministic Agent Message Summarization
// ---------------------------------------------------------------------------

/**
 * Extract a short action summary from verbose agent "thinking" text.
 *
 * Strategy (deterministic, no LLM):
 *   1. Strip markdown formatting / numbered lists
 *   2. Extract the first sentence (usually states the intent)
 *   3. Truncate to ~80 chars, keeping whole words
 *
 * @param {string} text  The agent message text
 * @returns {string}     Short summary (≤80 chars)
 */
function summarizeAgentMessage(text) {
  if (!text || typeof text !== "string") return "";

  // Strip markdown fences, bullet/number lists, extra whitespace
  let clean = text
    .replaceAll(/```[\s\S]*?```/g, "[code block]")                // code fences
    .replaceAll(/^\s*[-*•]\s+/gm, "")                              // bullet lists
    .replaceAll(/^\s*\d+[.)]\s+/gm, "")                            // numbered lists
    .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, "$1")                    // markdown links
    .replaceAll(/#{1,6}\s+/g, "")                                  // headings
    .replaceAll(/[`*_~]+/g, "")                                    // inline formatting
    .replaceAll(/\n{2,}/g, ". ")                                   // paragraph breaks → period
    .replaceAll("\n", " ")                                           // newlines → space
    .replaceAll(/\s{2,}/g, " ")                                    // collapse whitespace
    .trim();

  // Take only the first "sentence" (up to first period, colon, or dash boundary)
  const sentenceEnd = clean.search(/[.!?]\s|:\s*\n|—\s/);
  if (sentenceEnd > 10 && sentenceEnd < 100) {
    clean = clean.slice(0, sentenceEnd + 1).trim();
  }

  // Truncate to ~80 chars at a word boundary
  if (clean.length > 80) {
    const cut = clean.lastIndexOf(" ", 78);
    clean = clean.slice(0, cut > 20 ? cut : 78) + "…";
  }

  return clean || text.slice(0, 60).trim() + "…";
}

/**
 * Extract the core intent from a user prompt.
 *
 * Takes the first meaningful sentence and strips formatting.
 * Result is wrapped in [User request: …] brackets.
 *
 * @param {string} text  The user's prompt text
 * @returns {string}     Bracketed summary
 */
function summarizeUserMessage(text) {
  if (!text || typeof text !== "string") return "[User request]";

  // Strip the TOOL_OUTPUT_GUARDRAIL suffix if present
  const guardrailIdx = text.indexOf("[Tool Output Guardrail]");
  const rawText = guardrailIdx > 0 ? text.slice(0, guardrailIdx).trim() : text;

  // Remove code blocks and markdown
  let clean = rawText
    .replaceAll(/```[\s\S]*?```/g, "")
    .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replaceAll(/#{1,6}\s+/g, "")
    .replaceAll(/[`*_~]+/g, "")
    .replaceAll(/\n{2,}/g, ". ")
    .replaceAll("\n", " ")
    .replaceAll(/\s{2,}/g, " ")
    .trim();

  // If there's a system prompt prepended, skip to the user's actual content
  const directiveIdx = clean.indexOf("---");
  if (directiveIdx > 0 && directiveIdx < clean.length - 10) {
    clean = clean.slice(directiveIdx + 3).trim();
  }

  // Take the core intent — first substantial sentence
  const firstPeriod = clean.search(/[.!?]\s/);
  if (firstPeriod > 5 && firstPeriod < USER_MSG_BREADCRUMB_MAX) {
    clean = clean.slice(0, firstPeriod + 1);
  } else if (clean.length > USER_MSG_BREADCRUMB_MAX) {
    const cut = clean.lastIndexOf(" ", USER_MSG_BREADCRUMB_MAX - 3);
    clean = clean.slice(0, cut > 20 ? cut : USER_MSG_BREADCRUMB_MAX - 3) + "…";
  }

  return `[User request: ${clean}]`;
}

// ---------------------------------------------------------------------------
// Message Classification
// ---------------------------------------------------------------------------

/**
 * Classify an item for message compression purposes.
 *
 * @param {object} item
 * @returns {"pinned"|"agent_msg"|"user_msg"|"tool_output"|"other"}
 */
function classifyItem(item) {
  if (!item || typeof item !== "object") return "other";

  // Check pinned first — takes priority over everything
  if (isItemPinned(item)) return "pinned";

  // Agent thinking/response messages
  if (
    item.type === "agent_message" ||
    item.type === "assistant" ||
    item.role === "assistant"
  ) {
    return "agent_msg";
  }

  // User messages / prompts
  if (item.role === "user" || item.type === "user_message") {
    return "user_msg";
  }

  // Tool outputs (handled by the tool compression system)
  if (
    item.type === "function_call_output" ||
    item.type === "tool_result" ||
    item.type === "tool_output" ||
    item.type === "command_output" ||
    item.type === "command_execution"
  ) {
    return "tool_output";
  }

  return "other";
}

// ---------------------------------------------------------------------------
// Unified Compression Entry Point
// ---------------------------------------------------------------------------

/**
 * Compress ALL item types: tool outputs (existing), agent messages (new),
 * and user messages (new).  Pinned items are never touched.
 *
 * This wraps `cacheAndCompressItems` (tool output compression) and adds
 * agent + user message compression on top.
 *
 * Context-usage-aware behaviour:
 *   When `options.contextUsagePct` is provided (0.0–1.0), shredding only
 *   activates if usage >= `contextUsageThreshold` (default 0.50).
 *   Aggression scales linearly from the threshold to the critical level
 *   (default 0.70).  Above the critical level, tier boundaries are halved
 *   — meaning items are compressed much earlier.
 *
 * @param {Array}  items       The full accumulated items array
 * @param {object} [options]   Optional overrides
 * @param {number} [options.fullContextTurns=3]  Turns to keep tool outputs full
 * @param {number} [options.contextUsagePct]     Estimated context fill (0.0–1.0)
 * @returns {Promise<Array>}   Compressed items array
 */
export async function compressAllItems(items, options = {}) {
  if (!Array.isArray(items) || items.length === 0) return items;

  // If shredding is explicitly disabled, pass through unchanged
  if (options._skip === true) return items;

  const opts = resolveOpts(options);

  // ── Context-usage-based gating ──────────────────────────────
  const usagePct = typeof options.contextUsagePct === "number"
    ? options.contextUsagePct
    : null;
  const threshold = opts.contextUsageThreshold ?? 0.50;
  const target    = opts.contextUsageTarget    ?? 0.40;
  const critical  = opts.contextUsageCritical  ?? 0.70;

  // When context usage info is available and below threshold, skip shredding
  if (usagePct !== null && usagePct < threshold) {
    return items;
  }

  // ── Progressive aggression ──────────────────────────────────
  // When usage info is available, tighten tier boundaries proportionally.
  // aggression ranges from 0.0 (at threshold) to 1.0 (at critical).
  // At 1.0+, all tier boundaries are halved — items age out 2× faster.
  if (usagePct !== null && usagePct >= threshold) {
    const range = Math.max(critical - threshold, 0.01);
    const aggression = Math.min((usagePct - threshold) / range, 1.5);
    // Scale tier boundaries down — more aggression means earlier compression
    // At aggression 0.0: original values (1× multiplier)
    // At aggression 1.0: halved (0.5× multiplier)
    // At aggression 1.5: quartered (0.25× multiplier) — emergency mode
    const scaleFactor = Math.max(1 - aggression * 0.5, 0.25);
    opts.fullContextTurns = Math.max(1, Math.round(opts.fullContextTurns * scaleFactor));
    opts.tier1MaxAge      = Math.max(2, Math.round(opts.tier1MaxAge * scaleFactor));
    opts.tier2MaxAge      = Math.max(3, Math.round(opts.tier2MaxAge * scaleFactor));
    opts.msgTier0MaxAge   = Math.max(0, Math.round(opts.msgTier0MaxAge * scaleFactor));
    opts.msgTier1MaxAge   = Math.max(1, Math.round(opts.msgTier1MaxAge * scaleFactor));

    // Also shrink the char limits for heavy compression at high aggression
    if (aggression >= 0.8) {
      const charScale = Math.max(1 - (aggression - 0.8) * 1.5, 0.3);
      opts.tier1HeadChars = Math.round(opts.tier1HeadChars * charScale);
      opts.tier1TailChars = Math.round(opts.tier1TailChars * charScale);
      opts.tier2HeadChars = Math.round(opts.tier2HeadChars * charScale);
      opts.tier2TailChars = Math.round(opts.tier2TailChars * charScale);
    }
  }

  // Step 1: Apply tool output compression (existing system)
  let result = await cacheAndCompressItems(items, options);

  // Step 2: Apply message compression to agent + user messages
  // Skip entirely if message compression is turned off
  if (!opts.compressMessages) return result;

  const turnItems = assignTurns(result);
  const maxTurn = turnItems.reduce((m, t) => Math.max(m, t.turn), 0);

  // Not enough turns to need message compression yet
  if (maxTurn < 2) return result;

  const trace = options?._compressionTrace && typeof options._compressionTrace === "object"
    ? { ...options._compressionTrace }
    : null;
  const nextItems = [];
  for (const { item, turn } of turnItems) {
    const age = maxTurn - turn;
    const kind = classifyItem(item);

    // Pinned: never compress
    if (kind === "pinned") {
      nextItems.push(item);
      continue;
    }

    // Tool outputs: already compressed by cacheAndCompressItems
    if (kind === "tool_output") {
      nextItems.push(item);
      continue;
    }

    // Other/unknown: pass through
    if (kind === "other") {
      nextItems.push(item);
      continue;
    }

    // Agent messages: tiered compression based on age
    if (kind === "agent_msg") {
      if (!opts.compressAgentMessages) {
        nextItems.push(item);
        continue;
      }
      nextItems.push(await compressAgentMessage(item, age, opts, trace));
      continue;
    }

    // User messages: compress after the current turn
    if (kind === "user_msg") {
      if (!opts.compressUserMessages) {
        nextItems.push(item);
        continue;
      }
      nextItems.push(await compressUserMessage(item, age, opts, trace));
      continue;
    }

    nextItems.push(item);
  }

  return nextItems;
}

/**
 * Apply tiered compression to an agent message item.
 *
 * @param {object} item  The agent_message item
 * @param {number} age   Turns since this message
 * @returns {object}     Possibly compressed item
 */
async function cacheCompressedMessageSnapshot(item, compressedItem, trace = null, compressionKind = null, reason = null) {
  const beforeText = getItemText(item);
  const afterText = getItemText(compressedItem);
  let cachedLogId = compressedItem?._cachedLogId || item?._cachedLogId || null;
  if (!cachedLogId && beforeText) {
    const synthetic = {
      id: getCompressionMessageId(item) || undefined,
      type: item?.type || "agent_message",
      role: item?.role,
      text: beforeText,
    };
    cachedLogId = await writeToCache(
      synthetic,
      item?.type || item?.role || "context-message",
      `${item?.role || item?.type || "message"}:${getCompressionMessageId(item) || "snapshot"}`,
      {
        source: "context-cache",
        stage: "message_compaction",
        tier: inferSpillTier({ compressionKind, fallback: compressionKind === "user_breadcrumb" ? "summary" : "preview" }),
        compressionKind,
        compactionMode: compressionKind === "user_breadcrumb" ? "breadcrumb" : "message-summary",
        family: "message",
        commandFamily: item?.role || item?.type || "message",
        budgetPolicy: compressionKind === "user_breadcrumb" ? "artifact-summary" : "inline-excerpt",
        originalChars: beforeText.length,
      },
    );
  }
  const nextItem = cachedLogId
    ? attachSpillPointer(
      { ...compressedItem, _cachedLogId: compressedItem?._cachedLogId || cachedLogId },
      buildItemSpillPointer(cachedLogId, item, compressedItem, {
        stage: "message_compaction",
        tier: inferSpillTier({ compressionKind, fallback: compressionKind === "user_breadcrumb" ? "summary" : "preview" }),
        source: "context-cache",
        compressionKind,
        compactionMode: compressionKind === "user_breadcrumb" ? "breadcrumb" : "message-summary",
        family: "message",
        commandFamily: item?.role || item?.type || "message",
        budgetPolicy: compressionKind === "user_breadcrumb" ? "artifact-summary" : "inline-excerpt",
      }),
    )
    : compressedItem;
  if (trace) {
    recordShreddingEvent(buildCompressionEventPayload({
      item: nextItem,
      beforeText,
      afterText,
      sessionId: trace.sessionId,
      stage: "message_compaction",
      decision: "compressed",
      reason,
      agentType: trace.agentType,
      sessionType: trace.sessionType,
      normalizedSessionType: trace.normalizedSessionType,
      compactionFamily: "message",
      commandFamily: item?.role || item?.type || "message",
      compressionKind,
      cachedLogId,
    }));
  }
  return nextItem;
}

async function compressAgentMessage(item, age, opts, trace = null) {
  const minChars = opts?.msgMinCompressChars ?? MSG_MIN_COMPRESS_CHARS;
  const tier0Age  = opts?.msgTier0MaxAge     ?? MSG_TIER_0_MAX_AGE;
  const tier1Age  = opts?.msgTier1MaxAge     ?? MSG_TIER_1_MAX_AGE;

  const text = getItemText(item);
  if (!text || text.length < minChars) return item;

  // Tier 0: full text (current + previous turn)
  if (age <= tier0Age) return item;

  // Tier 1: moderate — keep first 200 chars + summary
  if (age <= tier1Age) {
    const summary = summarizeAgentMessage(text);
    const preview = text.length > 200 ? text.slice(0, 200) + "…" : text;
    if (preview.length >= text.length - 20) return item; // not worth compressing
    return await cacheCompressedMessageSnapshot(item, {
      ...item,
      text: `${summary}\n\n[…${text.length - 200} chars of agent reasoning compressed]`,
      _originalLength: text.length,
      _compressed: "agent_tier1",
    }, trace, "agent_tier1", "An older assistant message was reduced to a summary plus a short retained excerpt.");
  }

  // Tier 2: breadcrumb only (5+ turns old)
  const summary = summarizeAgentMessage(text);
  return await cacheCompressedMessageSnapshot(item, {
    type: item.type || "agent_message",
    id: item.id,
    role: item.role,
    text: `[Agent: ${summary}]`,
    _originalLength: text.length,
    _compressed: "agent_tier2",
  }, trace, "agent_tier2", "An older assistant message was collapsed to a breadcrumb to preserve only the core intent.");
}

/**
 * Apply compression to a user message item.
 *
 * @param {object} item  The user message item
 * @param {number} age   Turns since this message
 * @returns {object}     Possibly compressed item
 */
async function compressUserMessage(item, age, opts, trace = null) {
  const minChars  = opts?.msgMinCompressChars ?? MSG_MIN_COMPRESS_CHARS;
  const fullTurns = opts?.userMsgFullTurns    ?? USER_MSG_FULL_TURNS;

  const text = getItemText(item);
  if (!text || text.length < minChars) return item;

  // Current turn: keep full
  if (age <= fullTurns) return item;

  // Strip the TOOL_OUTPUT_GUARDRAIL and system prompt before summarizing
  // so the breadcrumb only captures the user's actual request
  const summary = summarizeUserMessage(text);
  return await cacheCompressedMessageSnapshot(item, {
    type: item.type || "user_message",
    id: item.id,
    role: item.role,
    text: summary,
    _originalLength: text.length,
    _compressed: "user_breadcrumb",
  }, trace, "user_breadcrumb", "An older user prompt was reduced to a breadcrumb so it no longer occupies full context.");
}

// ---------------------------------------------------------------------------
// Public API — Estimations & Diagnostics
// ---------------------------------------------------------------------------

/**
 * Convenience: estimate the token savings from compression.
 *
 * @param {Array} original     Items before compression
 * @param {Array} compressed   Items after compression
 * @returns {{ originalChars: number, compressedChars: number, savedChars: number, savedPct: number }}
 */
export function estimateSavings(original, compressed) {
  const countChars = (items) =>
    items.reduce((sum, item) => sum + (getItemText(item)?.length || 0), 0);
  const originalChars = countChars(original);
  const compressedChars = countChars(compressed);
  const savedChars = originalChars - compressedChars;
  const savedPct = originalChars > 0 ? Math.round((savedChars / originalChars) * 100) : 0;
  return { originalChars, compressedChars, savedChars, savedPct };
}

/**
 * Estimate the context usage percentage for an items array.
 *
 * Uses a chars-to-tokens heuristic (1 token ≈ 4 chars) and the model's
 * context window size.  Falls back to 128K tokens as the default window.
 *
 * @param {Array}  items               The items array to estimate
 * @param {number} [contextWindowTokens=128000]  Model context window in tokens
 * @returns {number}  Estimated fill ratio (0.0–1.0)
 */
export function estimateContextUsagePct(items, contextWindowTokens = 128_000) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  const CHARS_PER_TOKEN = 4;
  const totalChars = items.reduce(
    (sum, item) => sum + (getItemText(item)?.length || 0),
    0,
  );
  const estimatedTokens = totalChars / CHARS_PER_TOKEN;
  return Math.min(estimatedTokens / contextWindowTokens, 1.0);
}

function cloneJson(value) {
  if (value == null) return value ?? null;
  return JSON.parse(JSON.stringify(value));
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return JSON.stringify({ type: typeof value, preview: String(value) }, null, 2);
  }
}

export async function spillToolOutputToCache(output, options = {}) {
  const format = typeof output === "string" ? "text" : "json";
  const serialized = format === "text" ? String(output ?? "") : safeJsonStringify(output);
  const syntheticItem = {
    type: "tool_output_spill",
    tool_name: String(options.toolName || "tool-output"),
    arguments: options.argsPreview ? { preview: String(options.argsPreview) } : undefined,
    output: serialized,
  };
  const decision = {
    source: options.source || "tool-output-truncation",
    stage: options.stage || "tool_output_truncation",
    tier: options.tier || "preview",
    compressionKind: options.compressionKind || "tool_output_preview",
    compactionMode: options.compactionMode || "bounded-preview",
    family: options.family || "tool-output",
    commandFamily: options.commandFamily || "tool-output",
    budgetPolicy: options.budgetPolicy || "preview-pointer",
    originalChars: safePositiveInteger(options.originalChars, serialized.length),
    retainedChars: safePositiveInteger(options.retainedChars, 0),
    originalBytes: safePositiveInteger(options.originalBytes, Buffer.byteLength(serialized, "utf8")),
    retainedBytes: safePositiveInteger(options.retainedBytes, 0),
    format,
  };
  const logId = await writeToCache(
    syntheticItem,
    syntheticItem.tool_name,
    String(options.argsPreview || ""),
    decision,
  );
  return resolveToolLogSpillPointer(logId, decision);
}

export function truncateCompactedPreviewText(text, options = {}) {
  const value = String(text ?? "");
  const maxChars = Number.isFinite(Number(options.maxChars))
    ? Math.max(1, Math.trunc(Number(options.maxChars)))
    : 4000;
  const marker = String(options.marker ?? "…truncated");
  if (value.length <= maxChars) {
    return {
      text: value,
      truncated: false,
      originalChars: value.length,
      retainedChars: value.length,
    };
  }
  const tailChars = Number.isFinite(Number(options.tailChars))
    ? Math.max(0, Math.trunc(Number(options.tailChars)))
    : Math.min(400, Math.floor(maxChars * 0.2));
  const headChars = Math.max(0, maxChars - tailChars - marker.length - 2);
  const nextValue = `${value.slice(0, headChars)}\n${marker}\n${tailChars > 0 ? value.slice(-tailChars) : ""}`;
  return {
    text: nextValue,
    truncated: true,
    originalChars: value.length,
    retainedChars: nextValue.length,
  };
}

export function truncateCompactedToolOutput(output, options = {}) {
  const format = typeof output === "string" ? "text" : "json";
  const serialized = format === "text" ? String(output ?? "") : safeJsonStringify(output);
  const truncatedText = truncateCompactedPreviewText(serialized, options);
  const originalBytes = Buffer.byteLength(serialized, "utf8");
  const retainedBytes = Buffer.byteLength(truncatedText.text, "utf8");
  if (!truncatedText.truncated) {
    return {
      format,
      data: format === "text" ? serialized : cloneJson(output),
      preview: serialized,
      truncated: false,
      originalChars: truncatedText.originalChars,
      retainedChars: truncatedText.retainedChars,
      originalBytes,
      retainedBytes,
    };
  }
  return {
    format,
    data: format === "text"
      ? truncatedText.text
      : {
          truncated: true,
          preview: truncatedText.text,
        },
    preview: truncatedText.text,
    truncated: true,
    originalChars: truncatedText.originalChars,
    retainedChars: truncatedText.retainedChars,
    originalBytes,
    retainedBytes,
  };
}

export function normalizeContextShreddingSessionType(value, fallback = "primary") {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "workflow" || raw === "pipeline-stage" || raw.startsWith("flow")) {
    return "flow";
  }
  if (raw === "subagent" || raw === "delegate") {
    return "delegate";
  }
  if (raw === "voice-dispatch" || raw === "voice" || raw.startsWith("voice-")) {
    return "voice";
  }
  return raw;
}

function countSessionChars(items) {
  return Array.isArray(items)
    ? items.reduce((sum, item) => sum + (getItemText(item)?.length || 0), 0)
    : 0;
}

function buildCoverageEventStats(items) {
  const originalChars = countSessionChars(items);
  return {
    originalChars,
    compressedChars: originalChars,
    savedChars: 0,
    savedPct: 0,
  };
}

/**
 * Returns the absolute path to the tool log cache directory.
 */
export function getToolLogDir() {
  return TOOL_LOG_DIR;
}

/**
 * Returns the default options object for `compressAllItems` / `cacheAndCompressItems`.
 * Useful for tests and documentation — shows all configurable fields with defaults.
 *
 * @returns {object}
 */
export function getDefaultCompressOptions() {
  return resolveOpts({});
}

// ---------------------------------------------------------------------------
// Tool-Log Memory Cache — Public API
// ---------------------------------------------------------------------------

/**
 * Evict the oldest content-cache entries until we're under the size limit.
 * Internal helper — called automatically on write.
 */
function _evictContentCacheBySize() {
  if (!_contentCache.size) return;
  const sorted = [..._contentCache.entries()].sort((a, b) => a[1].addedAt - b[1].addedAt);
  let idx = 0;
  while (_contentCacheTotalBytes > _contentCacheConfig.maxSizeBytes && idx < sorted.length) {
    const [logId, entry] = sorted[idx++];
    _contentCacheTotalBytes = Math.max(0, _contentCacheTotalBytes - entry.sizeBytes);
    _contentCache.delete(logId);
  }
}

/**
 * Configure the tool-log in-memory content cache.
 *
 * Supported options:
 *   - `enabled` {boolean}              — master switch (default: false)
 *   - `maxSizeBytes` {number}          — max total bytes in cache (default: 50MB)
 *   - `archiveSizeLimitBytes` {number} — triggers disk pruning when exceeded (default: 200MB)
 *
 * @param {{ enabled?: boolean, maxSizeBytes?: number, archiveSizeLimitBytes?: number }} opts
 */
export function configureToolLogMemCache(opts = {}) {
  if (typeof opts.enabled === "boolean") _contentCacheConfig.enabled = opts.enabled;
  if (typeof opts.maxSizeBytes === "number" && opts.maxSizeBytes > 0) {
    _contentCacheConfig.maxSizeBytes = opts.maxSizeBytes;
  }
  if (typeof opts.archiveSizeLimitBytes === "number" && opts.archiveSizeLimitBytes > 0) {
    _contentCacheConfig.archiveSizeLimitBytes = opts.archiveSizeLimitBytes;
  }
  // Trim if new limit is smaller than current usage
  if (_contentCacheTotalBytes > _contentCacheConfig.maxSizeBytes) {
    _evictContentCacheBySize();
  }
}

/**
 * Evict tool-log memory cache entries that are older than `maxAgeMs`,
 * or all entries if `all` is true.
 *
 * @param {{ maxAgeMs?: number, all?: boolean }} [opts]
 * @returns {number} Number of entries evicted
 */
export function evictToolLogMemCache({ maxAgeMs, all = false } = {}) {
  if (all) {
    const count = _contentCache.size;
    _contentCache.clear();
    _contentCacheTotalBytes = 0;
    return count;
  }
  if (!maxAgeMs || !Number.isFinite(maxAgeMs)) return 0;
  const cutoff = Date.now() - maxAgeMs;
  let evicted = 0;
  for (const [logId, entry] of _contentCache.entries()) {
    if (entry.addedAt < cutoff) {
      _contentCacheTotalBytes = Math.max(0, _contentCacheTotalBytes - entry.sizeBytes);
      _contentCache.delete(logId);
      evicted++;
    }
  }
  return evicted;
}

/**
 * Return statistics about the current in-memory tool-log content cache.
 *
 * @returns {{ enabled: boolean, count: number, totalBytes: number, maxSizeBytes: number, archiveSizeLimitBytes: number }}
 */
export function getToolLogMemCacheStats() {
  return {
    enabled: _contentCacheConfig.enabled,
    count: _contentCache.size,
    totalBytes: _contentCacheTotalBytes,
    maxSizeBytes: _contentCacheConfig.maxSizeBytes,
    archiveSizeLimitBytes: _contentCacheConfig.archiveSizeLimitBytes,
  };
}

// ---------------------------------------------------------------------------
// Context Shredding Telemetry
// ---------------------------------------------------------------------------

/**
 * Append a shredding event to the ring buffer and persist to disk.
 *
 * @param {{ originalChars: number, compressedChars: number, savedChars: number, savedPct: number,
 *           agentType?: string, attemptId?: string, taskId?: string }} stats
 */
export function recordShreddingEvent(stats) {
  if (!stats || typeof stats !== "object") return;
  const { originalChars = 0, compressedChars = 0, savedChars = 0, savedPct = 0,
          agentType = null, attemptId = null, taskId = null, stage = null,
          compactionFamily = null, commandFamily = null, sessionType = null,
          normalizedSessionType = null, decision = null, reason = null,
          sessionId = null, messageId = null, turnIndex = null, cachedLogId = null,
          itemType = null, itemRole = null, compressionKind = null,
          beforePreview = null, afterPreview = null } = stats;

  // Skip no-op events (nothing to report)
  if (originalChars === 0 && compressedChars === 0) return;

  const event = {
    timestamp: new Date().toISOString(),
    originalChars,
    compressedChars,
    savedChars,
    savedPct,
    ...(agentType  ? { agentType }  : {}),
    ...(attemptId  ? { attemptId }  : {}),
    ...(taskId     ? { taskId }     : {}),
    ...(stage      ? { stage }      : {}),
    ...(compactionFamily ? { compactionFamily } : {}),
    ...(commandFamily ? { commandFamily } : {}),
    ...(sessionType ? { sessionType } : {}),
    ...(normalizedSessionType ? { normalizedSessionType } : {}),
    ...(decision ? { decision } : {}),
    ...(reason ? { reason } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(messageId ? { messageId } : {}),
    ...(Number.isFinite(Number(turnIndex)) ? { turnIndex: Math.max(0, Math.trunc(Number(turnIndex))) } : {}),
    ...(cachedLogId ? { cachedLogId } : {}),
    ...(itemType ? { itemType } : {}),
    ...(itemRole ? { itemRole } : {}),
    ...(compressionKind ? { compressionKind } : {}),
    ...(beforePreview ? { beforePreview } : {}),
    ...(afterPreview ? { afterPreview } : {}),
  };

  // Ring buffer — evict oldest when full
  _shreddingRingBuffer.push(event);
  if (_shreddingRingBuffer.length > MAX_SHREDDING_BUFFER) {
    _shreddingRingBuffer.shift();
  }

  // Persist to disk (fire-and-forget, non-blocking)
  _appendShreddingEventToDisk(event).catch((err) => {
    console.warn(`${TAG} failed to persist shredding event: ${err.message}`);
  });
}

/** @returns {ShreddingEvent[]} Copy of the ring buffer */
export function getShreddingStats() {
  return [..._shreddingRingBuffer];
}

/** Clear ring buffer — intended for tests only */
export function clearShreddingStats() {
  _shreddingRingBuffer.length = 0;
}

/**
 * Append a shredding event JSON line to the shredding log file.
 * Creates the parent directory if needed.
 * @param {ShreddingEvent} event
 */
async function _appendShreddingEventToDisk(event) {
  const fs = await getFs();
  const { resolve: nodeResolve } = await import("node:path");
  const dir = nodeResolve(SHREDDING_LOG_FILE, "..");
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(SHREDDING_LOG_FILE, JSON.stringify(event) + "\n", "utf8");
}

/**
 * Returns the absolute path to the shredding stats log file.
 */
export function getShreddingLogFile() {
  return SHREDDING_LOG_FILE;
}

// ---------------------------------------------------------------------------
// High-Level Convenience — maybeCompressSessionItems
// ---------------------------------------------------------------------------

/**
 * Convenience wrapper for SDK shell adapters and any execution path that
 * collects an items array and wants context-shredding applied.
 *
 * Resolves shredding configuration for the given session/agent type, checks
 * context usage against the configured threshold, compresses items when
 * warranted, and records shredding stats.  Returns the (possibly compressed)
 * items array — safe to call even when shredding is disabled.
 *
 * @param {Array}  items              The collected items array from the agent turn
 * @param {object} [opts]
 * @param {string} [opts.sessionType="primary"]  Interaction type (task, primary, chat, voice, …)
 * @param {string} [opts.agentType=""]           Agent SDK identifier (codex-sdk, claude-sdk, …)
 * @param {boolean} [opts.force=false]           Force compression even if below threshold
 * @param {boolean} [opts.skip=false]            Skip compression entirely
 * @returns {Promise<Array>}  Compressed (or unchanged) items array
 */
export async function maybeCompressSessionItems(
  items,
  { sessionType = "primary", agentType = "", force = false, skip = false, sessionId = null } = {},
) {
  if (!Array.isArray(items) || items.length === 0) return items;
  const rawSessionType = String(sessionType || "").trim().toLowerCase() || "primary";
  const normalizedSessionType = normalizeContextShreddingSessionType(rawSessionType, "primary");
  if (skip) {
    recordShreddingEvent({
      ...buildCoverageEventStats(items),
      agentType: agentType || "unknown",
      stage: "session_skipped",
      sessionType: rawSessionType,
      normalizedSessionType,
      decision: "skip_flag",
      reason: "Caller explicitly skipped context shredding for this turn.",
      ...(sessionId ? { sessionId } : {}),
    });
    return items;
  }

  // Lazy-import config to avoid circular dependency
  const { resolveContextShreddingOptions } = await import(
    "../config/context-shredding-config.mjs"
  );

  const shreddingOpts = {
    ...resolveContextShreddingOptions(normalizedSessionType, agentType),
    ...Object.fromEntries(Object.entries({
      liveToolCompactionEnabled: arguments[1]?.liveToolCompactionEnabled,
      liveToolCompactionMode: arguments[1]?.liveToolCompactionMode,
      liveToolCompactionMinChars: arguments[1]?.liveToolCompactionMinChars,
      liveToolCompactionTargetChars: arguments[1]?.liveToolCompactionTargetChars,
      liveToolCompactionMinSavingsPct: arguments[1]?.liveToolCompactionMinSavingsPct,
      liveToolCompactionMinRuntimeMs: arguments[1]?.liveToolCompactionMinRuntimeMs,
      liveToolCompactionBlockStructured: arguments[1]?.liveToolCompactionBlockStructured,
      liveToolCompactionAllowCommands: arguments[1]?.liveToolCompactionAllowCommands,
    }).filter(([, value]) => value !== undefined)),
  };
  if (shreddingOpts?._skip === true && !force) {
    recordShreddingEvent({
      ...buildCoverageEventStats(items),
      agentType: agentType || "unknown",
      stage: "session_skipped",
      sessionType: rawSessionType,
      normalizedSessionType,
      decision: "config_disabled",
      reason: "Context shredding is disabled for this session type or agent profile.",
      ...(sessionId ? { sessionId } : {}),
    });
    return items;
  }

  const usagePct = estimateContextUsagePct(items);
  const threshold = Number.isFinite(shreddingOpts?.contextUsageThreshold)
    ? Number(shreddingOpts.contextUsageThreshold)
    : 0.5;

  const workingItems = await maybeCompactLiveToolOutputs(items, shreddingOpts, {
    contextUsagePct: usagePct,
    force,
    agentType,
    sessionId,
    sessionType: rawSessionType,
    normalizedSessionType,
  });
  const workingUsagePct = workingItems === items
    ? usagePct
    : estimateContextUsagePct(workingItems);

  if (!force && workingUsagePct < threshold) {
    recordShreddingEvent({
      ...estimateSavings(items, workingItems),
      agentType: agentType || "unknown",
      stage: "session_skipped",
      sessionType: rawSessionType,
      normalizedSessionType,
      decision: "below_threshold",
      reason: `Estimated context usage ${Math.round(workingUsagePct * 100)}% stayed below the ${Math.round(threshold * 100)}% shredding threshold.`,
      ...(sessionId ? { sessionId } : {}),
    });
    return workingItems;
  }

  shreddingOpts.contextUsagePct = workingUsagePct;
  shreddingOpts._compressionTrace = {
    sessionId,
    agentType,
    sessionType: rawSessionType,
    normalizedSessionType,
  };
  const compressedItems = await compressAllItems(workingItems, shreddingOpts);

  try {
    const savings = estimateSavings(items, compressedItems);
    recordShreddingEvent({
      ...savings,
      agentType: agentType || "unknown",
      stage: "session_total",
      sessionType: rawSessionType,
      normalizedSessionType,
      decision: savings.savedChars > 0 ? "compressed" : "pass_through",
      reason: savings.savedChars > 0
        ? "Context shredding reduced the retained session payload."
        : "This session reached the compaction pipeline but the retained payload stayed effectively unchanged.",
      ...(sessionId ? { sessionId } : {}),
    });
  } catch {
    /* non-fatal */
  }

  return compressedItems;
}
