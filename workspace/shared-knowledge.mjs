/**
 * shared-knowledge.mjs — Agent-to-agent knowledge sharing for bosun.
 *
 * Allows agents across the fleet to contribute lessons learned, patterns,
 * and critical findings to a shared knowledge base (AGENTS.md or a
 * designated knowledge file).
 *
 * Features:
 *   - Append-only knowledge entries with dedup
 *   - Structured entry format with metadata (agent, timestamp, scope)
 *   - Git-conflict-safe appending (append to dedicated section)
 *   - Rate limiting to prevent spam
 *   - Entry validation before write
 *   - Persistent scoped memory retrieval for team/workspace/session/run
 *
 * Knowledge entries are appended to a `## Agent Learnings` section at the
 * bottom of the target file (default: AGENTS.md), mirrored into the SQLite
 * state ledger, and projected into a compatibility JSON registry for later
 * runs.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import crypto from "node:crypto";
import {
  appendKnowledgeEntryToStateLedger,
  listKnowledgeEntriesFromStateLedger,
  resolveStateLedgerPath,
} from "../lib/state-ledger-sqlite.mjs";
import { ensureContextIndexFresh, getContextPathAdjacency } from "./context-indexer.mjs";

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_SECTION_HEADER = "## Agent Learnings";
const DEFAULT_TARGET_FILE = "AGENTS.md";
const DEFAULT_REGISTRY_FILE = ".cache/bosun/persistent-memory.json";
const ENTRY_SEPARATOR = "\n---\n";
const MAX_ENTRY_LENGTH = 2000;
const MIN_ENTRY_LENGTH = 20;
const RATE_LIMIT_MS = 30_000;
const DEFAULT_BRIEFING_LIMIT = 4;
const REGISTRY_VERSION = "1.0.0";
const CONTEXT_INDEX_FILE = ".bosun/context-index/agent-index.json";
const MEMORY_SCOPE_PRIORITY = {
  run: 4,
  session: 3,
  workspace: 2,
  team: 1,
};
const MEMORY_SCOPES = new Set(Object.keys(MEMORY_SCOPE_PRIORITY));
const PATH_ADJACENCY_RELATION_TYPES = new Set(["file_imports_file"]);
const DIRECT_PATH_MATCH_SCORE = 140;
const ADJACENT_PATH_MATCH_SCORE = 80;

// ── State ────────────────────────────────────────────────────────────────────

const knowledgeState = {
  repoRoot: null,
  targetFile: DEFAULT_TARGET_FILE,
  registryFile: DEFAULT_REGISTRY_FILE,
  sectionHeader: DEFAULT_SECTION_HEADER,
  entriesWritten: 0,
  lastWriteAt: null,
  lastWriteByThrottleKey: new Map(),
  entryHashes: new Set(),
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeNullable(value) {
  const text = normalizeText(value);
  return text || null;
}

function getScopeThrottleKey(entry) {
  const scopeLevel = normalizeScopeLevel(entry?.scopeLevel);
  const scopeId = getScopeIdentifier(entry, scopeLevel);
  return `${scopeLevel}:${scopeId || "default"}`;
}

function normalizeStringList(value, { maxItems = 12, maxLength = 240 } = {}) {
  const rawValues = Array.isArray(value)
    ? value
    : (typeof value === "string" && value.includes(",")
        ? value.split(",")
        : [value]);
  const out = [];
  const seen = new Set();
  for (const entry of rawValues) {
    const text = normalizeText(entry);
    if (!text) continue;
    const clipped = text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
    const key = clipped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clipped);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeRepoPath(value, repoRoot = knowledgeState.repoRoot || process.cwd()) {
  const text = normalizeText(value);
  if (!text) return "";
  const withoutPrefix = text.replace(/^file:\/\//i, "");
  let normalized = withoutPrefix.replace(/\\/g, "/");
  if (repoRoot && (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("/"))) {
    try {
      normalized = relative(repoRoot, withoutPrefix).replace(/\\/g, "/");
    } catch {
      // fall back to the normalized absolute path
    }
  }
  normalized = normalized.replace(/^\.\//, "").replace(/^\/+/, "");
  const segments = normalized
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments[0] === ".") segments.shift();
  return segments.join("/");
}

function normalizeRelatedPaths(value, { maxItems = 24, maxLength = 320, repoRoot } = {}) {
  const rawValues = Array.isArray(value)
    ? value
    : (typeof value === "string" && value.includes(",")
        ? value.split(",")
        : [value]);
  const out = [];
  const seen = new Set();
  for (const entry of rawValues) {
    const normalized = normalizeRepoPath(entry, repoRoot);
    if (!normalized) continue;
    const clipped = normalized.length > maxLength
      ? normalized.slice(0, maxLength).trim()
      : normalized;
    const key = clipped.toLowerCase();
    if (!clipped || seen.has(key)) continue;
    seen.add(key);
    out.push(clipped);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeConfidence(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(1, parsed));
}

function normalizeScopeLevel(value) {
  const raw = normalizeText(value).toLowerCase();
  if (!raw) return "workspace";
  return MEMORY_SCOPES.has(raw) ? raw : "workspace";
}

function extractPathCandidatesFromText(value, repoRoot = knowledgeState.repoRoot || process.cwd()) {
  const text = normalizeText(value);
  if (!text) return [];
  const candidates = [];
  let start = -1;
  for (let i = 0; i <= text.length; i++) {
    const ch = i < text.length ? text[i] : "";
    const isPathChar =
      ch === "/" || ch === "\\" || ch === "." || ch === "-" || ch === "_" ||
      (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9");
    if (isPathChar) {
      if (start < 0) start = i;
    } else {
      if (start >= 0) {
        const token = text.slice(start, i);
        if (token.includes(".")) candidates.push(token);
        start = -1;
      }
    }
  }
  return normalizeRelatedPaths(candidates, { repoRoot, maxItems: 24 });
}

function getScopeIdentifier(entry, scopeLevel = entry?.scopeLevel) {
  const normalizedScope = normalizeScopeLevel(scopeLevel);
  if (normalizedScope === "team") return normalizeNullable(entry?.teamId);
  if (normalizedScope === "workspace") return normalizeNullable(entry?.workspaceId);
  if (normalizedScope === "session") return normalizeNullable(entry?.sessionId);
  if (normalizedScope === "run") return normalizeNullable(entry?.runId);
  return null;
}

function truncateInline(text, maxLength = 220) {
  const normalized = normalizeText(text).replace(/\s+/g, " ");
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function tokenize(text) {
  return Array.from(
    new Set(
      normalizeText(text)
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3),
    ),
  );
}

function getRegistryPath(repoRoot = knowledgeState.repoRoot || process.cwd()) {
  return resolve(repoRoot, knowledgeState.registryFile || DEFAULT_REGISTRY_FILE);
}

async function ensureParentDir(filePath) {
  await mkdir(dirname(filePath), { recursive: true });
}

function createEmptyRegistry() {
  return {
    version: REGISTRY_VERSION,
    updatedAt: new Date().toISOString(),
    entries: [],
  };
}

function serializeEntry(entry) {
  const normalizedScopeLevel = normalizeScopeLevel(entry?.scopeLevel);
  const repoRoot = knowledgeState.repoRoot || process.cwd();
  const relatedPaths = normalizeRelatedPaths(
    [
      ...(Array.isArray(entry?.relatedPaths) ? entry.relatedPaths : []),
      ...(Array.isArray(entry?.document?.relatedPaths) ? entry.document.relatedPaths : []),
      ...extractPathCandidatesFromText(entry?.taskRef, repoRoot),
      ...extractPathCandidatesFromText(entry?.scope, repoRoot),
      ...extractPathCandidatesFromText(entry?.content, repoRoot),
      ...(Array.isArray(entry?.provenance)
        ? entry.provenance.flatMap((value) => extractPathCandidatesFromText(value, repoRoot))
        : []),
      ...(Array.isArray(entry?.evidence)
        ? entry.evidence.flatMap((value) => extractPathCandidatesFromText(value, repoRoot))
        : []),
      ...(Array.isArray(entry?.tags)
        ? entry.tags.flatMap((value) => extractPathCandidatesFromText(value, repoRoot))
        : []),
    ],
    { repoRoot },
  );
  const normalizedEntry = {
    content: normalizeText(entry?.content),
    scope: normalizeNullable(entry?.scope),
    agentId: normalizeText(entry?.agentId || "unknown"),
    agentType: normalizeText(entry?.agentType || "codex"),
    category: normalizeText(entry?.category || "pattern"),
    taskRef: normalizeNullable(entry?.taskRef),
    timestamp: normalizeText(entry?.timestamp) || new Date().toISOString(),
    scopeLevel: normalizedScopeLevel,
    teamId: normalizeNullable(entry?.teamId),
    workspaceId: normalizeNullable(entry?.workspaceId),
    sessionId: normalizeNullable(entry?.sessionId),
    runId: normalizeNullable(entry?.runId),
    workflowId: normalizeNullable(entry?.workflowId),
    strategyId: normalizeNullable(entry?.strategyId),
    confidence: normalizeConfidence(entry?.confidence),
    verificationStatus: normalizeNullable(entry?.verificationStatus),
    verifiedAt: normalizeNullable(entry?.verifiedAt),
    provenance: normalizeStringList(entry?.provenance),
    evidence: normalizeStringList(entry?.evidence),
    tags: Array.isArray(entry?.tags)
      ? entry.tags.map((tag) => normalizeText(tag)).filter(Boolean)
      : [],
    relatedPaths,
  };
  if (!getScopeIdentifier(normalizedEntry, normalizedScopeLevel) && normalizedScopeLevel === "workspace") {
    normalizedEntry.workspaceId = "default";
  }
  normalizedEntry.hash =
    normalizeText(entry?.hash) ||
    hashEntry(normalizedEntry.content, normalizedEntry.scope, normalizedEntry);
  return normalizedEntry;
}

function normalizeRegistryEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const entry = serializeEntry(raw);
  if (!entry.content) return null;
  if (!getScopeIdentifier(entry, entry.scopeLevel)) return null;
  return entry;
}

async function loadLegacyRegistryEntries(repoRoot = knowledgeState.repoRoot || process.cwd()) {
  const registryPath = getRegistryPath(repoRoot);
  if (!existsSync(registryPath)) return createEmptyRegistry();

  try {
    const raw = JSON.parse(await readFile(registryPath, "utf8"));
    const entries = Array.isArray(raw?.entries)
      ? raw.entries.map((entry) => normalizeRegistryEntry(entry)).filter(Boolean)
      : [];
    return {
      version: normalizeText(raw?.version) || REGISTRY_VERSION,
      updatedAt: normalizeText(raw?.updatedAt) || new Date().toISOString(),
      entries,
    };
  } catch {
    return createEmptyRegistry();
  }
}

async function backfillLedgerEntries(repoRoot, entries = []) {
  for (const rawEntry of Array.isArray(entries) ? entries : []) {
    const entry = normalizeRegistryEntry(rawEntry);
    if (!entry) continue;
    try {
      appendKnowledgeEntryToStateLedger(entry, { repoRoot });
    } catch {
      // best-effort migration only
    }
  }
}

function loadLedgerRegistryEntries(repoRoot = knowledgeState.repoRoot || process.cwd()) {
  try {
    const entries = listKnowledgeEntriesFromStateLedger({ repoRoot, limit: 5000 })
      .map((entry) => normalizeRegistryEntry(entry))
      .filter(Boolean);
    if (entries.length > 0) {
      return {
        version: REGISTRY_VERSION,
        updatedAt: entries[0]?.timestamp || new Date().toISOString(),
        entries,
      };
    }
  } catch {
    // fall through to null
  }
  return null;
}

async function loadRegistryEntries(repoRoot = knowledgeState.repoRoot || process.cwd()) {
  const ledgerRegistry = loadLedgerRegistryEntries(repoRoot);
  if (ledgerRegistry) return ledgerRegistry;

  const legacyRegistry = await loadLegacyRegistryEntries(repoRoot);
  if (legacyRegistry.entries.length > 0) {
    await backfillLedgerEntries(repoRoot, legacyRegistry.entries);
    const syncedRegistry = loadLedgerRegistryEntries(repoRoot) || legacyRegistry;
    await saveRegistryEntries(repoRoot, syncedRegistry);
    return syncedRegistry;
  }
  return legacyRegistry;
}

async function saveRegistryEntries(repoRoot, registry) {
  const registryPath = getRegistryPath(repoRoot);
  await ensureParentDir(registryPath);
  const payload = {
    version: REGISTRY_VERSION,
    updatedAt: new Date().toISOString(),
    entries: Array.isArray(registry?.entries)
      ? registry.entries.map((entry) => serializeEntry(entry))
      : [],
  };
  await writeFile(registryPath, JSON.stringify(payload, null, 2), "utf8");
}

async function syncRegistryProjectionFromLedger(repoRoot = knowledgeState.repoRoot || process.cwd()) {
  const registry = loadLedgerRegistryEntries(repoRoot) || createEmptyRegistry();
  await saveRegistryEntries(repoRoot, registry);
  return registry;
}

async function ensureEntryHashesLoaded() {
  knowledgeState.entryHashes.clear();
  const repoRoot = knowledgeState.repoRoot || process.cwd();
  const registry =
    loadLedgerRegistryEntries(repoRoot)
    || await loadLegacyRegistryEntries(repoRoot);
  for (const entry of registry.entries) {
    if (entry?.hash) knowledgeState.entryHashes.add(entry.hash);
  }

  if (knowledgeState.entryHashes.size > 0) return;

  const filePath = resolve(knowledgeState.repoRoot || process.cwd(), knowledgeState.targetFile);
  if (!existsSync(filePath)) return;

  try {
    const content = await readFile(filePath, "utf8");
    const sectionIdx = content.indexOf(knowledgeState.sectionHeader);
    if (sectionIdx === -1) return;
    const sectionContent = content.slice(sectionIdx);
    const entries = sectionContent.split(/^### /m).slice(1);
    for (const block of entries) {
      const lines = block.split("\n");
      const contentLines = lines.filter(
        (line) =>
          !line.startsWith(">") &&
          !line.startsWith("###") &&
          !line.startsWith("---") &&
          line.trim().length > 0,
      );
      const entryContent = contentLines.join(" ").trim();
      if (!entryContent) continue;
      const scopeMatch = lines[0]?.match(/\(([^)]+)\)/);
      const hash = hashEntry(entryContent, scopeMatch?.[1] || null, {
        scopeLevel: "workspace",
      });
      knowledgeState.entryHashes.add(hash);
    }
  } catch {
    // best-effort fallback only
  }
}

function buildSearchText(entry) {
  return [
    entry.content,
    entry.scope,
    entry.category,
    entry.taskRef,
    entry.agentId,
    entry.teamId,
    entry.workspaceId,
    entry.sessionId,
    entry.runId,
    entry.workflowId,
    entry.strategyId,
    entry.verificationStatus,
    ...(Array.isArray(entry.provenance) ? entry.provenance : []),
    ...(Array.isArray(entry.evidence) ? entry.evidence : []),
    ...(Array.isArray(entry.tags) ? entry.tags : []),
    ...(Array.isArray(entry.relatedPaths) ? entry.relatedPaths : []),
    ...(Array.isArray(entry.document?.relatedPaths) ? entry.document.relatedPaths : []),
  ]
    .filter(Boolean)
    .join(" ");
}

function isEntryVisibleForContext(entry, context) {
  const scopeLevel = normalizeScopeLevel(entry?.scopeLevel);
  if (scopeLevel === "team") {
    return Boolean(entry.teamId) && normalizeNullable(entry.teamId) === normalizeNullable(context.teamId);
  }
  if (scopeLevel === "workspace") {
    return Boolean(entry.workspaceId) && normalizeNullable(entry.workspaceId) === normalizeNullable(context.workspaceId);
  }
  if (scopeLevel === "session") {
    return Boolean(entry.sessionId) && normalizeNullable(entry.sessionId) === normalizeNullable(context.sessionId);
  }
  if (scopeLevel === "run") {
    return Boolean(entry.runId) && normalizeNullable(entry.runId) === normalizeNullable(context.runId);
  }
  return false;
}

async function loadContextPathAdjacency(repoRoot, directPaths = []) {
  const contextIndexDbPath = resolve(repoRoot, ".bosun", "context-index", "index.db");
  const hasRefreshablePath = (Array.isArray(directPaths) ? directPaths : [])
    .some((relPath) => existsSync(resolve(repoRoot, String(relPath || ""))));
  if (hasRefreshablePath) {
    try {
      await ensureContextIndexFresh({
        rootDir: repoRoot,
        changedFiles: directPaths,
        useTreeSitter: false,
        useZoekt: false,
      });
    } catch {
      // best-effort refresh only
    }
  }
  if (existsSync(contextIndexDbPath)) {
    try {
      const dbAdjacency = await getContextPathAdjacency(directPaths, {
        rootDir: repoRoot,
        relationTypes: [...PATH_ADJACENCY_RELATION_TYPES],
      });
      if (dbAdjacency instanceof Map && dbAdjacency.size > 0) {
        return dbAdjacency;
      }
    } catch {
      // fall back to the JSON projection below
    }
  }
  const indexPath = resolve(repoRoot, CONTEXT_INDEX_FILE);
  if (!existsSync(indexPath)) {
    return new Map();
  }
  try {
    const payload = JSON.parse(await readFile(indexPath, "utf8"));
    const relations = Array.isArray(payload?.relations) ? payload.relations : [];
    const adjacency = new Map();
    const addEdge = (fromPath, toPath) => {
      const from = normalizeRepoPath(fromPath, repoRoot);
      const to = normalizeRepoPath(toPath, repoRoot);
      if (!from || !to || from === to) return;
      if (!adjacency.has(from)) adjacency.set(from, new Set());
      adjacency.get(from).add(to);
    };
    for (const relation of relations) {
      if (!PATH_ADJACENCY_RELATION_TYPES.has(relation?.relationType)) continue;
      addEdge(relation.fromPath, relation.toPath);
      addEdge(relation.toPath, relation.fromPath);
    }
    return adjacency;
  } catch {
    return new Map();
  }
}

async function buildPathContext(options = {}, repoRoot = knowledgeState.repoRoot || process.cwd()) {
  const directPaths = new Set(normalizeRelatedPaths([
    ...(Array.isArray(options.relatedPaths) ? options.relatedPaths : []),
    ...(Array.isArray(options.changedFiles) ? options.changedFiles : []),
  ], { repoRoot }));
  if (directPaths.size === 0) {
    return { directPaths, adjacentPaths: new Set() };
  }
  const adjacency = await loadContextPathAdjacency(repoRoot, [...directPaths]);
  const adjacentPaths = new Set();
  for (const directPath of directPaths) {
    const neighbors = adjacency.get(directPath);
    if (!neighbors) continue;
    for (const neighbor of neighbors) {
      if (!directPaths.has(neighbor)) adjacentPaths.add(neighbor);
    }
  }
  return { directPaths, adjacentPaths };
}

function collectEntryRelatedPaths(entry, repoRoot = knowledgeState.repoRoot || process.cwd()) {
  return normalizeRelatedPaths([
    ...(Array.isArray(entry?.relatedPaths) ? entry.relatedPaths : []),
    ...(Array.isArray(entry?.document?.relatedPaths) ? entry.document.relatedPaths : []),
    ...(Array.isArray(entry?.provenance)
      ? entry.provenance.flatMap((value) => extractPathCandidatesFromText(value, repoRoot))
      : []),
    ...(Array.isArray(entry?.evidence)
      ? entry.evidence.flatMap((value) => extractPathCandidatesFromText(value, repoRoot))
      : []),
    ...(Array.isArray(entry?.tags)
      ? entry.tags.flatMap((value) => extractPathCandidatesFromText(value, repoRoot))
      : []),
    ...extractPathCandidatesFromText(entry?.content, repoRoot),
    ...extractPathCandidatesFromText(entry?.taskRef, repoRoot),
  ], { repoRoot });
}

function scoreEntry(entry, queryTokens, context, pathContext = { directPaths: new Set(), adjacentPaths: new Set() }) {
  const scopeLevel = normalizeScopeLevel(entry?.scopeLevel);
  const priority = MEMORY_SCOPE_PRIORITY[scopeLevel] || 0;
  const haystack = tokenize(buildSearchText(entry));
  const tokenSet = new Set(haystack);
  let score = priority * 100;
  const directPathHits = [];
  const adjacentPathHits = [];

  for (const token of queryTokens) {
    if (tokenSet.has(token)) score += 25;
  }

  if (entry.taskRef && context.taskId && normalizeText(entry.taskRef) === normalizeText(context.taskId)) {
    score += 50;
  }

  const entryRelatedPaths = collectEntryRelatedPaths(entry, context.repoRoot);
  for (const relatedPath of entryRelatedPaths) {
    if (pathContext.directPaths.has(relatedPath)) {
      directPathHits.push(relatedPath);
      score += DIRECT_PATH_MATCH_SCORE;
      continue;
    }
    if (pathContext.adjacentPaths.has(relatedPath)) {
      adjacentPathHits.push(relatedPath);
      score += ADJACENT_PATH_MATCH_SCORE;
    }
  }

  const timestampMs = Date.parse(entry.timestamp || "") || 0;
  score += Math.floor(timestampMs / 1000 / 60 / 60 / 24);
  return {
    score,
    relatedPaths: entryRelatedPaths,
    directPathHits,
    adjacentPathHits,
  };
}

// ── Initialization ───────────────────────────────────────────────────────────

export function initSharedKnowledge(opts = {}) {
  knowledgeState.repoRoot = opts.repoRoot || process.cwd();
  knowledgeState.targetFile = opts.targetFile || DEFAULT_TARGET_FILE;
  knowledgeState.registryFile = opts.registryFile || DEFAULT_REGISTRY_FILE;
  knowledgeState.sectionHeader = opts.sectionHeader || DEFAULT_SECTION_HEADER;
  knowledgeState.entriesWritten = 0;
  knowledgeState.lastWriteAt = null;
  knowledgeState.lastWriteByThrottleKey = new Map();
  knowledgeState.entryHashes = new Set();
}

// ── Entry Format ─────────────────────────────────────────────────────────────

export function buildKnowledgeEntry(opts = {}) {
  const entry = {
    content: normalizeText(opts.content),
    scope: normalizeNullable(opts.scope),
    agentId: normalizeText(opts.agentId || "unknown"),
    agentType: normalizeText(opts.agentType || "codex"),
    category: normalizeText(opts.category || "pattern"),
    taskRef: normalizeNullable(opts.taskRef),
    timestamp: new Date().toISOString(),
    scopeLevel: normalizeScopeLevel(opts.scopeLevel),
    teamId: normalizeNullable(opts.teamId),
    workspaceId: normalizeNullable(opts.workspaceId),
    sessionId: normalizeNullable(opts.sessionId),
    runId: normalizeNullable(opts.runId),
    workflowId: normalizeNullable(opts.workflowId),
    strategyId: normalizeNullable(opts.strategyId),
    confidence: normalizeConfidence(opts.confidence),
    verificationStatus: normalizeNullable(opts.verificationStatus),
    verifiedAt: normalizeNullable(opts.verifiedAt),
    provenance: normalizeStringList(opts.provenance),
    evidence: normalizeStringList(opts.evidence),
    tags: Array.isArray(opts.tags)
      ? opts.tags.map((tag) => normalizeText(tag)).filter(Boolean)
      : [],
    relatedPaths: normalizeRelatedPaths(opts.relatedPaths),
  };
  if (!getScopeIdentifier(entry, entry.scopeLevel) && entry.scopeLevel === "workspace") {
    entry.workspaceId = "default";
  }
  entry.hash = hashEntry(entry.content, entry.scope, entry);
  return entry;
}

export function formatEntryAsMarkdown(entry) {
  const lines = [];
  const datePart =
    entry.timestamp?.split("T")[0] || new Date().toISOString().split("T")[0];
  const scopePart = entry.scope ? ` (${entry.scope})` : "";
  const catPart = entry.category ? `[${entry.category}]` : "";
  const taskPart = entry.taskRef ? ` • ref: \`${entry.taskRef}\`` : "";
  const scopeLevel = normalizeScopeLevel(entry.scopeLevel);
  const scopeId = getScopeIdentifier(entry, scopeLevel) || "unknown";

  lines.push(`### ${catPart}${scopePart} — ${datePart}${taskPart}`);
  lines.push("");
  lines.push(`> **Agent:** ${entry.agentId} (${entry.agentType})`);
  lines.push(`> **Memory Scope:** ${scopeLevel}:${scopeId}`);
  if (entry.workflowId) {
    lines.push(`> **Workflow:** ${entry.workflowId}`);
  }
  if (entry.strategyId) {
    lines.push(`> **Strategy ID:** ${entry.strategyId}`);
  }
  if (entry.confidence != null) {
    lines.push(`> **Confidence:** ${entry.confidence.toFixed(2)}`);
  }
  if (entry.verificationStatus || entry.verifiedAt) {
    const verifiedParts = [entry.verificationStatus, entry.verifiedAt].filter(Boolean);
    lines.push(`> **Verification:** ${verifiedParts.join(" @ ")}`);
  }
  if (Array.isArray(entry.provenance) && entry.provenance.length > 0) {
    lines.push(`> **Provenance:** ${entry.provenance.join(" | ")}`);
  }
  if (Array.isArray(entry.evidence) && entry.evidence.length > 0) {
    lines.push(`> **Evidence:** ${entry.evidence.join(" | ")}`);
  }
  if (Array.isArray(entry.tags) && entry.tags.length > 0) {
    lines.push(`> **Tags:** ${entry.tags.join(", ")}`);
  }
  if (Array.isArray(entry.relatedPaths) && entry.relatedPaths.length > 0) {
    lines.push(`> **Related Paths:** ${entry.relatedPaths.join(" | ")}`);
  }
  lines.push("");
  lines.push(entry.content);
  lines.push("");

  return lines.join("\n");
}

// ── Validation ───────────────────────────────────────────────────────────────

export function validateEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return { valid: false, reason: "entry must be an object" };
  }

  const content = normalizeText(entry.content);
  if (content.length < MIN_ENTRY_LENGTH) {
    return {
      valid: false,
      reason: `content too short (min ${MIN_ENTRY_LENGTH} chars)`,
    };
  }
  if (content.length > MAX_ENTRY_LENGTH) {
    return {
      valid: false,
      reason: `content too long (max ${MAX_ENTRY_LENGTH} chars)`,
    };
  }

  const lowValuePatterns = [
    /^(ok|done|yes|no|maybe|test|todo|fixme|hack)$/i,
    /^[^a-zA-Z]*$/,
    /(.)\1{20,}/,
  ];
  for (const pattern of lowValuePatterns) {
    if (pattern.test(content)) {
      return { valid: false, reason: "entry appears to be low-value or noise" };
    }
  }

  const validCategories = [
    "pattern",
    "gotcha",
    "perf",
    "security",
    "convention",
    "tip",
    "bug",
    "strategy",
    "benchmark",
    "evaluation",
  ];
  if (entry.category && !validCategories.includes(entry.category)) {
    return {
      valid: false,
      reason: `invalid category — must be one of: ${validCategories.join(", ")}`,
    };
  }

  const scopeLevel = normalizeScopeLevel(entry.scopeLevel);
  if (!MEMORY_SCOPES.has(scopeLevel)) {
    return { valid: false, reason: "invalid scopeLevel" };
  }

  if (!getScopeIdentifier(entry, scopeLevel)) {
    return {
      valid: false,
      reason: `missing scope identifier for ${scopeLevel} memory`,
    };
  }

  return { valid: true };
}

// ── Deduplication ────────────────────────────────────────────────────────────

function hashEntry(content, scope, entry = {}) {
  const scopeLevel = normalizeScopeLevel(entry.scopeLevel);
  const repoRoot = normalizeText(resolve(knowledgeState.repoRoot || process.cwd())).toLowerCase();
  const data = [
    repoRoot,
    normalizeText(scope),
    normalizeText(content).toLowerCase(),
    scopeLevel,
    normalizeText(entry.teamId).toLowerCase(),
    normalizeText(entry.workspaceId).toLowerCase(),
    normalizeText(entry.sessionId).toLowerCase(),
    normalizeText(entry.runId).toLowerCase(),
  ].join("|");
  return crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
}

export function isDuplicate(entry) {
  return knowledgeState.entryHashes.has(entry.hash);
}

// ── Write ────────────────────────────────────────────────────────────────────

async function writeKnowledgeMarkdownMirror(filePath, markdown) {
  await ensureParentDir(filePath);
  let content = "";
  if (existsSync(filePath)) {
    content = await readFile(filePath, "utf8");
  }

  const sectionIdx = content.indexOf(knowledgeState.sectionHeader);
  if (sectionIdx === -1) {
    const newContent =
      content.trimEnd() +
      "\n\n" +
      knowledgeState.sectionHeader +
      "\n\n" +
      markdown +
      ENTRY_SEPARATOR;
    await writeFile(filePath, newContent, "utf8");
    return;
  }

  const afterSection = content.slice(sectionIdx + knowledgeState.sectionHeader.length);
  const nextSectionMatch = afterSection.match(/\n## [^#]/);
  if (nextSectionMatch) {
    const insertPos =
      sectionIdx +
      knowledgeState.sectionHeader.length +
      nextSectionMatch.index;
    const before = content.slice(0, insertPos);
    const after = content.slice(insertPos);
    await writeFile(
      filePath,
      before + "\n" + markdown + ENTRY_SEPARATOR + after,
      "utf8",
    );
    return;
  }

  await writeFile(
    filePath,
    content.trimEnd() + "\n\n" + markdown + ENTRY_SEPARATOR,
    "utf8",
  );
}

export async function appendKnowledgeEntry(entry, options = {}) {
  const normalizedEntry = serializeEntry(entry);
  const validation = validateEntry(normalizedEntry);
  if (!validation.valid) {
    return { success: false, reason: validation.reason };
  }

  const agentId = normalizeText(normalizedEntry.agentId || "unknown");
  const scopeThrottleKey = getScopeThrottleKey(normalizedEntry);
  const throttleKey = `${agentId}::${scopeThrottleKey}`;
  const skipRateLimit = options?.skipRateLimit === true;
  const now = Date.now();
  const lastRelevantWrite = knowledgeState.lastWriteByThrottleKey.get(throttleKey) || 0;
  if (!skipRateLimit && lastRelevantWrite) {
    const elapsed = now - lastRelevantWrite;
    if (elapsed < RATE_LIMIT_MS) {
      return {
        success: false,
        reason: `rate limited — wait ${Math.ceil((RATE_LIMIT_MS - elapsed) / 1000)}s`,
      };
    }
  }

  await ensureEntryHashesLoaded();
  if (isDuplicate(normalizedEntry)) {
    return { success: false, reason: "duplicate entry — already recorded" };
  }

  const markdown = formatEntryAsMarkdown(normalizedEntry);
  const effectiveRepoRoot = knowledgeState.repoRoot || process.cwd();
  const filePath = resolve(knowledgeState.repoRoot || process.cwd(), knowledgeState.targetFile);

  try {
    const ledgerResult = appendKnowledgeEntryToStateLedger(normalizedEntry, {
      repoRoot: effectiveRepoRoot,
    });
    const syncedRegistry = await syncRegistryProjectionFromLedger(effectiveRepoRoot);
    const syncedContainsEntry = Array.isArray(syncedRegistry?.entries)
      && syncedRegistry.entries.some((entry) => entry?.hash === normalizedEntry.hash);
    if (!syncedContainsEntry) {
      const legacyRegistry = await loadLegacyRegistryEntries(effectiveRepoRoot);
      await saveRegistryEntries(effectiveRepoRoot, {
        ...legacyRegistry,
        entries: [
          normalizedEntry,
          ...legacyRegistry.entries.filter((entry) => entry?.hash !== normalizedEntry.hash),
        ],
      });
    }

    let mirrored = true;
    let mirrorReason = null;
    try {
      await writeKnowledgeMarkdownMirror(filePath, markdown);
    } catch (mirrorError) {
      mirrored = false;
      mirrorReason = `markdown mirror failed: ${mirrorError.message}`;
    }

    knowledgeState.entryHashes.add(normalizedEntry.hash);
    knowledgeState.entriesWritten++;
    const completedAt = Date.now();
    knowledgeState.lastWriteAt = completedAt;
    knowledgeState.lastWriteByThrottleKey.set(throttleKey, completedAt);

    return {
      success: true,
      hash: normalizedEntry.hash,
      registryPath: getRegistryPath(effectiveRepoRoot),
      ledgerPath: ledgerResult?.path || resolveStateLedgerPath({
        repoRoot: effectiveRepoRoot,
      }),
      mirrored,
      mirrorReason,
    };
  } catch (err) {
    return { success: false, reason: `write error: ${err.message}` };
  }
}

// ── Read / Retrieve ──────────────────────────────────────────────────────────

export async function readKnowledgeEntries() {
  const filePath = resolve(knowledgeState.repoRoot || process.cwd(), knowledgeState.targetFile);
  if (!existsSync(filePath)) return [];

  try {
    const content = await readFile(filePath, "utf8");
    const sectionIdx = content.indexOf(knowledgeState.sectionHeader);
    if (sectionIdx === -1) return [];

    const sectionContent = content.slice(
      sectionIdx + knowledgeState.sectionHeader.length,
    );
    const nextSectionMatch = sectionContent.match(/\n## [^#]/);
    const relevantContent = nextSectionMatch
      ? sectionContent.slice(0, nextSectionMatch.index)
      : sectionContent;

    const blocks = relevantContent.split(/^### /m).slice(1);
    const entries = [];

    for (const block of blocks) {
      const lines = block.split("\n");
      const header = lines[0] || "";
      const catMatch = header.match(/^\[([^\]]+)\]/);
      const scopeMatch = header.match(/\(([^)]+)\)/);
      const dateMatch = header.match(/(\d{4}-\d{2}-\d{2})/);
      const refMatch = header.match(/ref: `([^`]+)`/);
      const agentLine = lines.find((line) => line.startsWith("> **Agent:**"));
      const agentMatch = agentLine?.match(/\*\*Agent:\*\* ([^ ]+) \(([^)]+)\)/);
      const memoryScopeLine = lines.find((line) => line.startsWith("> **Memory Scope:**"));
      const memoryScopeMatch = memoryScopeLine?.match(/\*\*Memory Scope:\*\* ([^:]+):(.+)/);
      const tagsLine = lines.find((line) => line.startsWith("> **Tags:**"));
      const tags = tagsLine
        ? tagsLine.replace(/^> \*\*Tags:\*\* /, "").split(",").map((tag) => normalizeText(tag)).filter(Boolean)
        : [];

      const contentLines = lines
        .filter(
          (line) =>
            !line.startsWith(">") && line.trim().length > 0 && !line.startsWith("---"),
        )
        .slice(1);

      entries.push({
        category: catMatch?.[1] || "unknown",
        scope: scopeMatch?.[1] || null,
        date: dateMatch?.[1] || null,
        taskRef: refMatch?.[1] || null,
        agentId: agentMatch?.[1] || "unknown",
        agentType: agentMatch?.[2] || "unknown",
        scopeLevel: normalizeScopeLevel(memoryScopeMatch?.[1] || "workspace"),
        scopeId: normalizeNullable(memoryScopeMatch?.[2]),
        tags,
        content: contentLines.join("\n").trim(),
      });
    }

    return entries;
  } catch {
    return [];
  }
}

export async function retrieveKnowledgeEntries(options = {}) {
  const repoRoot = options.repoRoot || knowledgeState.repoRoot || process.cwd();
  const registry = await loadRegistryEntries(repoRoot);
  const context = {
    teamId: normalizeNullable(options.teamId),
    workspaceId: normalizeNullable(options.workspaceId),
    sessionId: normalizeNullable(options.sessionId),
    runId: normalizeNullable(options.runId),
    taskId: normalizeNullable(options.taskId),
    repoRoot,
  };
  const queryTokens = tokenize(
    [
      options.query,
      options.taskTitle,
      options.taskDescription,
    ]
      .filter(Boolean)
      .join(" "),
  );
  const limit = Math.max(1, Number(options.limit) || DEFAULT_BRIEFING_LIMIT);
  const pathContext = await buildPathContext(options, repoRoot);

  return registry.entries
    .filter((entry) => isEntryVisibleForContext(entry, context))
    .map((entry) => {
      const scored = scoreEntry(entry, queryTokens, context, pathContext);
      return {
        ...entry,
        ...scored,
      };
    })
    .sort((left, right) => {
      const scopeDelta =
        (MEMORY_SCOPE_PRIORITY[right.scopeLevel] || 0) -
        (MEMORY_SCOPE_PRIORITY[left.scopeLevel] || 0);
      if (scopeDelta !== 0) return scopeDelta;
      if (right.score !== left.score) return right.score - left.score;
      return (Date.parse(right.timestamp || "") || 0) - (Date.parse(left.timestamp || "") || 0);
    })
    .slice(0, limit);
}

export function formatKnowledgeBriefing(entries, options = {}) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  if (list.length === 0) return "";
  const maxEntries = Math.max(1, Number(options.maxEntries) || DEFAULT_BRIEFING_LIMIT);
  const header = normalizeText(options.header) || "## Persistent Memory Briefing";
  const lines = [
    header,
    "Use these retrieved memories only when relevant. Narrower scopes override broader ones.",
    "",
  ];

  for (const entry of list.slice(0, maxEntries)) {
    const scopeLevel = normalizeScopeLevel(entry.scopeLevel);
    const topic = entry.scope ? ` (${entry.scope})` : "";
    const scopeId = getScopeIdentifier(entry, scopeLevel) || "unknown";
    const taskPart = entry.taskRef ? ` • ref: \`${entry.taskRef}\`` : "";
    const directPaths = normalizeRelatedPaths(entry.directPathHits || []);
    const adjacentPaths = normalizeRelatedPaths(entry.adjacentPathHits || []);
    const pathReason = directPaths.length > 0
      ? ` • matched=${directPaths.slice(0, 2).join(", ")}`
      : (adjacentPaths.length > 0
          ? ` • graph=${adjacentPaths.slice(0, 2).join(", ")}`
          : "");
    lines.push(
      `- [${scopeLevel}]${topic} ${truncateInline(entry.content)} • scope=${scopeId}${taskPart}${pathReason}`,
    );
  }

  return lines.join("\n").trim();
}

// ── Getters ──────────────────────────────────────────────────────────────────

export function getKnowledgeState() {
  return {
    ...knowledgeState,
    entryHashes: knowledgeState.entryHashes.size,
    throttleKeys: knowledgeState.lastWriteByThrottleKey.size,
  };
}

export function formatKnowledgeSummary() {
  return [
    `:u1f4da: Shared Knowledge: ${knowledgeState.entriesWritten} entries written this session`,
    `Target: ${knowledgeState.targetFile}`,
    `Registry: ${knowledgeState.registryFile}`,
    `Dedup cache: ${knowledgeState.entryHashes.size} hashes`,
    `Throttle keys: ${knowledgeState.lastWriteByThrottleKey.size}`,
    knowledgeState.lastWriteAt
      ? `Last write: ${new Date(knowledgeState.lastWriteAt).toISOString()}`
      : "No writes this session",
  ].join("\n");
}
