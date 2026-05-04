import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { listPromotedStrategiesFromStateLedger, resolveStateLedgerPath } from "../lib/state-ledger-sqlite.mjs";

const DEFAULT_SKILLBOOK_FILE = ".bosun/skillbook/strategies.json";
const SKILLBOOK_VERSION = "1.0.0";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeNullable(value) {
  const text = normalizeText(value);
  return text || null;
}

function normalizeTimestamp(value) {
  return normalizeNullable(value) || new Date().toISOString();
}

function cloneJson(value) {
  if (value == null) return null;
  return JSON.parse(JSON.stringify(value));
}

function normalizeStringList(value, { maxItems = 24, maxLength = 240 } = {}) {
  const rawValues = Array.isArray(value)
    ? value
    : (typeof value === "string" && value.includes(",")
        ? value.split(",")
        : [value]);
  const out = [];
  const seen = new Set();
  for (const raw of rawValues) {
    const text = normalizeText(raw);
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

function normalizeConfidence(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(1, parsed));
}

function normalizePathHint(value) {
  return normalizeText(value).replace(/\\/g, "/").replace(/^\.\//, "");
}

function normalizePathList(value, { maxItems = 24, maxLength = 320 } = {}) {
  const rawValues = Array.isArray(value)
    ? value
    : (typeof value === "string" && value.includes(",")
        ? value.split(",")
        : [value]);
  const out = [];
  const seen = new Set();
  for (const raw of rawValues) {
    const normalized = normalizePathHint(raw);
    if (!normalized) continue;
    const clipped = normalized.length > maxLength ? normalized.slice(0, maxLength).trim() : normalized;
    const key = clipped.toLowerCase();
    if (!clipped || seen.has(key)) continue;
    seen.add(key);
    out.push(clipped);
    if (out.length >= maxItems) break;
  }
  return out;
}

function tokenizeSearchTerms(value, { maxTokens = 24 } = {}) {
  const rawValues = Array.isArray(value) ? value : [value];
  const out = [];
  const seen = new Set();
  for (const rawValue of rawValues) {
    const text = normalizeText(rawValue).toLowerCase();
    if (!text) continue;
    const tokens = text
      .split(/[^a-z0-9]+/i)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3);
    for (const token of tokens) {
      if (seen.has(token)) continue;
      seen.add(token);
      out.push(token);
      if (out.length >= maxTokens) return out;
    }
  }
  return out;
}

function buildStrategySearchBlob(entry = {}) {
  return [
    entry.strategyId,
    entry.workflowId,
    entry.scope,
    entry.scopeLevel,
    entry.category,
    entry.decision,
    entry.status,
    entry.recommendation,
    entry.rationale,
    ...(Array.isArray(entry.tags) ? entry.tags : []),
    ...(Array.isArray(entry.evidence) ? entry.evidence : []),
    ...(Array.isArray(entry.provenance) ? entry.provenance : []),
    ...(Array.isArray(entry.relatedPaths) ? entry.relatedPaths : []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function countMatchingTokens(blob, tokens = []) {
  if (!blob || !Array.isArray(tokens) || tokens.length === 0) return 0;
  let count = 0;
  for (const token of tokens) {
    if (blob.includes(token)) count += 1;
  }
  return count;
}

function computeRecencyBonus(updatedAt) {
  const timestamp = Date.parse(String(updatedAt || ""));
  if (!Number.isFinite(timestamp)) return 0;
  const ageDays = Math.max(0, (Date.now() - timestamp) / (24 * 60 * 60 * 1000));
  if (ageDays <= 3) return 12;
  if (ageDays <= 14) return 8;
  if (ageDays <= 45) return 4;
  return 0;
}

function scoreSkillbookStrategy(entry = {}, options = {}) {
  const blob = buildStrategySearchBlob(entry);
  const queryTokens = tokenizeSearchTerms(options.query);
  const requestedTags = normalizeStringList(options.tags || [], { maxItems: 16, maxLength: 80 })
    .map((value) => value.toLowerCase());
  const entryTags = Array.isArray(entry.tags) ? entry.tags.map((value) => String(value || "").toLowerCase()) : [];
  const requestedPaths = normalizePathList([
    ...(Array.isArray(options.relatedPaths) ? options.relatedPaths : []),
    ...(Array.isArray(options.changedFiles) ? options.changedFiles : []),
  ]);
  const entryPaths = normalizePathList(entry.relatedPaths || []);
  const pathMatchPaths = requestedPaths.filter((path) => entryPaths.includes(path));
  const tagMatches = requestedTags.filter((tag) => entryTags.includes(tag)).length;
  const queryMatches = countMatchingTokens(blob, queryTokens);
  const confidence = normalizeConfidence(entry.confidence) ?? 0.5;
  const historyLength = Array.isArray(entry.history) ? entry.history.length : 0;
  let score = confidence * 100;
  score += Math.min(18, historyLength * 3);
  score += computeRecencyBonus(entry.updatedAt);
  score += tagMatches * 8;
  score += queryMatches * 6;
  if (String(entry.status || "").toLowerCase() === "promoted") score += 10;
  if (String(entry.status || "").toLowerCase() === "reverted") score -= 12;
  if (String(entry.workflowId || "").trim() && String(entry.workflowId || "").trim() === String(options.workflowId || "").trim()) {
    score += 16;
  }
  if (String(entry.scope || "").trim() && String(entry.scope || "").trim() === String(options.scope || "").trim()) {
    score += 12;
  }
  if (String(entry.scopeLevel || "").trim().toLowerCase() === "workspace") score += 2;
  score += pathMatchPaths.length * 22;
  return {
    score,
    pathMatchPaths,
  };
}

function toRankedSkillbookEntry(entry = {}, rank = 0, score = 0, pathMatchPaths = []) {
  return {
    ...entry,
    rank,
    score,
    relevanceScore: score,
    pathMatchPaths: normalizePathList(pathMatchPaths || []),
  };
}

function createEmptySkillbook() {
  return {
    version: SKILLBOOK_VERSION,
    updatedAt: new Date().toISOString(),
    strategies: [],
  };
}

function isLikelyTestRuntime() {
  if (process.env.BOSUN_TEST_SANDBOX === "1") return true;
  if (process.env.VITEST) return true;
  if (process.env.VITEST_POOL_ID) return true;
  if (process.env.VITEST_WORKER_ID) return true;
  if (process.env.JEST_WORKER_ID) return true;
  if (process.env.NODE_ENV === "test") return true;
  const argv = Array.isArray(process.argv) ? process.argv.join(" ").toLowerCase() : "";
  return argv.includes("vitest") || argv.includes("--test");
}

function shouldReadSkillbookFromStateLedger(options = {}) {
  if (options.preferStateLedger === true) return true;
  if (process.env.BOSUN_SKILLBOOK_LEDGER_READS === "1") return true;
  if (!isLikelyTestRuntime()) return true;
  if (existsSync(resolveSkillbookPath(options))) return false;
  const ledgerPath = resolveStateLedgerPath(options);
  return ledgerPath === ":memory:" || existsSync(ledgerPath);
}

function mapLedgerStrategyToSkillbookEntry(record = {}) {
  if (!record || typeof record !== "object") return null;
  const document = record.document && typeof record.document === "object" && !Array.isArray(record.document)
    ? record.document
    : {};
  const strategy = document.strategy && typeof document.strategy === "object" && !Array.isArray(document.strategy)
    ? document.strategy
    : {};
  const knowledgeEntry =
    document.knowledge?.entry && typeof document.knowledge.entry === "object" && !Array.isArray(document.knowledge.entry)
      ? document.knowledge.entry
      : {};
  try {
    return normalizeSkillbookEntry({
      ...document,
      ...strategy,
      strategyId:
        normalizeNullable(record.strategyId)
        || normalizeNullable(document.strategyId)
        || normalizeNullable(strategy.strategyId),
      workflowId:
        normalizeNullable(record.workflowId)
        || normalizeNullable(document.workflowId)
        || normalizeNullable(strategy.workflowId),
      runId:
        normalizeNullable(record.runId)
        || normalizeNullable(document.runId)
        || normalizeNullable(strategy.runId),
      category:
        normalizeNullable(record.category)
        || normalizeNullable(document.category)
        || normalizeNullable(strategy.category),
      decision:
        normalizeNullable(record.decision)
        || normalizeNullable(document.decision)
        || normalizeNullable(strategy.decision),
      status:
        normalizeNullable(record.status)
        || normalizeNullable(document.status)
        || normalizeNullable(strategy.status),
      verificationStatus:
        normalizeNullable(record.verificationStatus)
        || normalizeNullable(document.verificationStatus)
        || normalizeNullable(strategy.verificationStatus),
      confidence:
        record.confidence ?? document.confidence ?? strategy.confidence ?? null,
      recommendation:
        normalizeNullable(record.recommendation)
        || normalizeNullable(document.recommendation)
        || normalizeNullable(strategy.recommendation),
      rationale:
        normalizeNullable(record.rationale)
        || normalizeNullable(document.rationale)
        || normalizeNullable(strategy.rationale),
      relatedPaths:
        document.relatedPaths
        || strategy.relatedPaths
        || knowledgeEntry.relatedPaths
        || strategy?.knowledge?.entry?.relatedPaths
        || [],
      updatedAt:
        normalizeNullable(record.updatedAt)
        || normalizeNullable(document.updatedAt)
        || normalizeNullable(strategy.updatedAt)
        || normalizeNullable(record.promotedAt),
      firstPromotedAt:
        normalizeNullable(document.firstPromotedAt)
        || normalizeNullable(strategy.firstPromotedAt)
        || normalizeNullable(record.promotedAt),
      history:
        Array.isArray(document.history)
          ? document.history
          : (Array.isArray(strategy.history) ? strategy.history : []),
    });
  } catch {
    return null;
  }
}

function loadSkillbookFromStateLedger(options = {}) {
  try {
    const rows = listPromotedStrategiesFromStateLedger({
      repoRoot: options.repoRoot,
    });
    const strategies = rows
      .map((row) => mapLedgerStrategyToSkillbookEntry(row))
      .filter(Boolean);
    if (strategies.length === 0) return null;
    strategies.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return {
      version: SKILLBOOK_VERSION,
      updatedAt: normalizeTimestamp(strategies[0]?.updatedAt),
      strategies,
      source: "state-ledger",
    };
  } catch {
    return null;
  }
}

function normalizeHistoryEntry(entry = {}) {
  if (!entry || typeof entry !== "object") return null;
  const timestamp = normalizeTimestamp(entry.timestamp || entry.updatedAt || entry.createdAt);
  const decision = normalizeNullable(entry.decision || entry.status);
  const runId = normalizeNullable(entry.runId);
  if (!decision && !runId) return null;
  return {
    timestamp,
    decision: decision || "promote_strategy",
    status: normalizeNullable(entry.status) || decision || "promoted",
    runId,
    workflowId: normalizeNullable(entry.workflowId),
    score: Number.isFinite(Number(entry.score)) ? Number(entry.score) : null,
    grade: normalizeNullable(entry.grade),
    benchmark: cloneJson(entry.benchmark),
    metrics: cloneJson(entry.metrics),
    knowledgeHash: normalizeNullable(entry.knowledgeHash),
    summary: normalizeNullable(entry.summary),
    rationale: normalizeNullable(entry.rationale),
  };
}

function normalizeSkillbookEntry(entry = {}, existing = null) {
  const strategyId = normalizeText(entry.strategyId || entry.strategy?.strategyId || existing?.strategyId || "");
  if (!strategyId) {
    throw new Error("skillbook strategyId is required");
  }
  const updatedAt = normalizeTimestamp(entry.updatedAt || entry.promotedAt || entry.timestamp);
  const historyEntries = Array.isArray(existing?.history) ? existing.history : [];
  const appendedHistory = normalizeHistoryEntry({
    timestamp: updatedAt,
    decision: entry.decision,
    status: entry.status,
    runId: entry.runId,
    workflowId: entry.workflowId,
    score: entry.evaluation?.score,
    grade: entry.evaluation?.grade,
    benchmark: entry.benchmark,
    metrics: entry.metrics,
    knowledgeHash: entry.knowledge?.hash || entry.knowledgeHash,
    summary: entry.summary || entry.recommendation,
    rationale: entry.rationale,
  });
  const mergedHistory = [...historyEntries];
  if (appendedHistory) {
    const historyKey = `${appendedHistory.timestamp}|${appendedHistory.decision}|${appendedHistory.runId || ""}`;
    const existingKeys = new Set(
      mergedHistory.map((item) => `${item.timestamp}|${item.decision}|${item.runId || ""}`),
    );
    if (!existingKeys.has(historyKey)) {
      mergedHistory.push(appendedHistory);
    }
  }
  mergedHistory.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));

  return {
    strategyId,
    workflowId: normalizeNullable(entry.workflowId) || normalizeNullable(existing?.workflowId),
    runId: normalizeNullable(entry.runId) || normalizeNullable(existing?.runId),
    taskId: normalizeNullable(entry.taskId) || normalizeNullable(existing?.taskId),
    sessionId: normalizeNullable(entry.sessionId) || normalizeNullable(existing?.sessionId),
    teamId: normalizeNullable(entry.teamId) || normalizeNullable(existing?.teamId),
    workspaceId: normalizeNullable(entry.workspaceId) || normalizeNullable(existing?.workspaceId),
    scope: normalizeNullable(entry.scope) || normalizeNullable(existing?.scope),
    scopeLevel: normalizeNullable(entry.scopeLevel) || normalizeNullable(existing?.scopeLevel) || "workspace",
    category: normalizeNullable(entry.category) || normalizeNullable(existing?.category) || "strategy",
    decision: normalizeNullable(entry.decision) || normalizeNullable(existing?.decision) || "promote_strategy",
    status: normalizeNullable(entry.status) || normalizeNullable(existing?.status) || "promoted",
    verificationStatus:
      normalizeNullable(entry.verificationStatus)
      || normalizeNullable(existing?.verificationStatus)
      || normalizeNullable(entry.decision)
      || "promote_strategy",
    confidence: normalizeConfidence(entry.confidence ?? existing?.confidence),
    recommendation: normalizeNullable(entry.recommendation) || normalizeNullable(existing?.recommendation),
    rationale: normalizeNullable(entry.rationale) || normalizeNullable(existing?.rationale),
    evidence: normalizeStringList(entry.evidence ?? existing?.evidence),
    provenance: normalizeStringList(entry.provenance ?? existing?.provenance),
    tags: normalizeStringList(entry.tags ?? existing?.tags, { maxItems: 32, maxLength: 80 }),
    relatedPaths: normalizePathList(entry.relatedPaths ?? existing?.relatedPaths),
    benchmark: cloneJson(entry.benchmark ?? existing?.benchmark),
    metrics: cloneJson(entry.metrics ?? existing?.metrics),
    evaluation: cloneJson(entry.evaluation ?? existing?.evaluation),
    knowledge: cloneJson(entry.knowledge ?? existing?.knowledge),
    firstPromotedAt:
      normalizeNullable(existing?.firstPromotedAt)
      || normalizeNullable(entry.firstPromotedAt)
      || updatedAt,
    updatedAt,
    history: mergedHistory,
  };
}

async function ensureParentDir(filePath) {
  await mkdir(dirname(filePath), { recursive: true });
}

export function resolveSkillbookPath(options = {}) {
  const repoRoot = normalizeText(options.repoRoot || process.cwd()) || process.cwd();
  const explicit = normalizeText(options.skillbookPath || options.path || "");
  return resolve(repoRoot, explicit || DEFAULT_SKILLBOOK_FILE);
}

export function loadSkillbookSync(options = {}) {
  const skillbookPath = resolveSkillbookPath(options);
  if (!existsSync(skillbookPath)) {
    return createEmptySkillbook();
  }
  try {
    const raw = JSON.parse(readFileSync(skillbookPath, "utf8"));
    const strategies = Array.isArray(raw?.strategies)
      ? raw.strategies.map((entry) => normalizeSkillbookEntry(entry)).filter(Boolean)
      : [];
    strategies.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return {
      version: normalizeText(raw?.version) || SKILLBOOK_VERSION,
      updatedAt: normalizeTimestamp(raw?.updatedAt),
      strategies,
    };
  } catch {
    return createEmptySkillbook();
  }
}

function buildSkillbookProtocolTitle(entry = {}) {
  return normalizeNullable(entry.recommendation)
    || normalizeNullable(entry.strategyId)
    || "Reusable strategy guidance";
}

function buildSkillbookProtocolTags(entry = {}) {
  return normalizeStringList([
    ...(Array.isArray(entry.tags) ? entry.tags : []),
    ...(Array.isArray(entry.provenance) ? entry.provenance : []),
    ...(Array.isArray(entry.evidence) ? entry.evidence : []),
    entry.category,
    entry.decision,
    entry.scope,
  ], { maxItems: 16, maxLength: 80 });
}

export function listSkillbookStrategyProtocolsSync(options = {}) {
  const skillbook = loadSkillbookSync(options);
  return (Array.isArray(skillbook.strategies) ? skillbook.strategies : []).map((entry) => ({
    id: `skillbook-${normalizeText(entry.strategyId).replace(/[^a-z0-9_-]+/gi, "-").toLowerCase()}`,
    strategyId: normalizeText(entry.strategyId),
    title: buildSkillbookProtocolTitle(entry),
    description: normalizeNullable(entry.rationale) || normalizeNullable(entry.recommendation) || "",
    tags: buildSkillbookProtocolTags(entry),
    important: String(entry.status || "").toLowerCase() === "promoted" || (normalizeConfidence(entry.confidence) ?? 0) >= 0.75,
    updatedAt: normalizeTimestamp(entry.updatedAt),
    recommendation: normalizeNullable(entry.recommendation),
    rationale: normalizeNullable(entry.rationale),
    relatedPaths: normalizePathList(entry.relatedPaths || []),
    status: normalizeNullable(entry.status) || "promoted",
    confidence: normalizeConfidence(entry.confidence),
  }));
}

export function buildSkillbookProtocolMarkdown(entry = {}) {
  const title = buildSkillbookProtocolTitle(entry);
  const tags = buildSkillbookProtocolTags(entry);
  const relatedPaths = normalizePathList(entry.relatedPaths || []);
  const lines = [
    `# Skill: ${title}`,
    "",
  ];
  if (normalizeNullable(entry.recommendation)) {
    lines.push(`- Recommendation: ${normalizeNullable(entry.recommendation)}`);
  }
  if (normalizeNullable(entry.rationale)) {
    lines.push(`- Rationale: ${normalizeNullable(entry.rationale)}`);
  }
  if (tags.length > 0) {
    lines.push(`- Tags: ${tags.slice(0, 6).join(", ")}`);
  }
  if (relatedPaths.length > 0) {
    lines.push(`- Related Paths: ${relatedPaths.slice(0, 4).join(", ")}`);
  }
  if (normalizeConfidence(entry.confidence) != null) {
    lines.push(`- Confidence: ${normalizeConfidence(entry.confidence).toFixed(2)}`);
  }
  return lines.join("\n").trim();
}

export async function loadSkillbook(options = {}) {
  if (shouldReadSkillbookFromStateLedger(options)) {
    const ledgerSkillbook = loadSkillbookFromStateLedger(options);
    if (ledgerSkillbook?.strategies?.length) {
      return ledgerSkillbook;
    }
  }
  const skillbookPath = resolveSkillbookPath(options);
  if (!existsSync(skillbookPath)) {
    return createEmptySkillbook();
  }
  try {
    const raw = JSON.parse(await readFile(skillbookPath, "utf8"));
    const strategies = Array.isArray(raw?.strategies)
      ? raw.strategies.map((entry) => normalizeSkillbookEntry(entry)).filter(Boolean)
      : [];
    strategies.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return {
      version: normalizeText(raw?.version) || SKILLBOOK_VERSION,
      updatedAt: normalizeTimestamp(raw?.updatedAt),
      strategies,
    };
  } catch {
    return createEmptySkillbook();
  }
}

async function saveSkillbook(skillbook, options = {}) {
  const skillbookPath = resolveSkillbookPath(options);
  await ensureParentDir(skillbookPath);
  await writeFile(skillbookPath, JSON.stringify({
    version: SKILLBOOK_VERSION,
    updatedAt: new Date().toISOString(),
    strategies: Array.isArray(skillbook?.strategies) ? skillbook.strategies : [],
  }, null, 2), "utf8");
  return skillbookPath;
}

export async function upsertSkillbookStrategy(record = {}, options = {}) {
  const skillbook = await loadSkillbook(options);
  const strategies = Array.isArray(skillbook.strategies) ? skillbook.strategies : [];
  const strategyId = normalizeText(record.strategyId || record.strategy?.strategyId || "");
  if (!strategyId) {
    throw new Error("skillbook strategyId is required");
  }
  const existingIndex = strategies.findIndex((entry) => entry?.strategyId === strategyId);
  const existing = existingIndex >= 0 ? strategies[existingIndex] : null;
  const normalized = normalizeSkillbookEntry(record, existing);
  if (existingIndex >= 0) {
    strategies[existingIndex] = normalized;
  } else {
    strategies.push(normalized);
  }
  strategies.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const path = await saveSkillbook({ ...skillbook, strategies }, options);
  return {
    success: true,
    strategyId,
    entry: normalized,
    path,
  };
}

export async function getSkillbookStrategy(strategyId, options = {}) {
  const normalizedId = normalizeText(strategyId);
  if (!normalizedId) return null;
  const skillbook = await loadSkillbook(options);
  return skillbook.strategies.find((entry) => entry.strategyId === normalizedId) || null;
}

export async function listSkillbookStrategies(options = {}) {
  const {
    workflowId,
    category,
    scopeLevel,
    scope,
    decision,
    status,
    tags,
    query,
    minConfidence,
    sort = "recent",
    limit,
  } = options;
  const skillbook = await loadSkillbook(options);
  let entries = skillbook.strategies;
  if (workflowId) {
    const normalized = normalizeText(workflowId);
    entries = entries.filter((entry) => entry.workflowId === normalized);
  }
  if (category) {
    const normalized = normalizeText(category).toLowerCase();
    entries = entries.filter((entry) => String(entry.category || "").toLowerCase() === normalized);
  }
  if (scopeLevel) {
    const normalized = normalizeText(scopeLevel).toLowerCase();
    entries = entries.filter((entry) => String(entry.scopeLevel || "").toLowerCase() === normalized);
  }
  if (scope) {
    const normalized = normalizeText(scope);
    entries = entries.filter((entry) => String(entry.scope || "") === normalized);
  }
  if (decision) {
    const normalized = normalizeText(decision).toLowerCase();
    entries = entries.filter((entry) => String(entry.decision || "").toLowerCase() === normalized);
  }
  if (status) {
    const normalized = normalizeText(status).toLowerCase();
    entries = entries.filter((entry) => String(entry.status || "").toLowerCase() === normalized);
  }
  if (tags) {
    const normalizedTags = normalizeStringList(tags, { maxItems: 16, maxLength: 80 })
      .map((value) => value.toLowerCase());
    if (normalizedTags.length > 0) {
      entries = entries.filter((entry) => {
        const entryTags = Array.isArray(entry.tags) ? entry.tags.map((value) => String(value || "").toLowerCase()) : [];
        return normalizedTags.every((tag) => entryTags.includes(tag));
      });
    }
  }
  if (Number.isFinite(Number(minConfidence))) {
    const minimum = Math.max(0, Math.min(1, Number(minConfidence)));
    entries = entries.filter((entry) => (normalizeConfidence(entry.confidence) ?? 0) >= minimum);
  }
  const queryTokens = tokenizeSearchTerms(query);
  if (queryTokens.length > 0) {
    entries = entries.filter((entry) => countMatchingTokens(buildStrategySearchBlob(entry), queryTokens) > 0);
  }
  if (String(sort || "").trim().toLowerCase() === "ranked") {
    entries = entries
      .map((entry) => ({ entry, ...scoreSkillbookStrategy(entry, options) }))
      .sort((left, right) => right.score - left.score || String(right.entry.updatedAt).localeCompare(String(left.entry.updatedAt)))
      .map(({ entry, score, pathMatchPaths }, index) => toRankedSkillbookEntry(entry, index + 1, score, pathMatchPaths));
  }
  const limitNumber = Number(limit);
  if (Number.isFinite(limitNumber) && limitNumber > 0) {
    entries = entries.slice(0, Math.trunc(limitNumber));
  }
  return entries;
}

export function buildSkillbookGuidanceSummary(strategies = [], options = {}) {
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.trunc(Number(options.limit))) : 5;
  const selected = (Array.isArray(strategies) ? strategies : []).slice(0, limit);
  if (selected.length === 0) return "";
  const lines = ["Reusable strategy guidance:"];
  for (const entry of selected) {
    const recommendation = normalizeNullable(entry?.recommendation) || normalizeNullable(entry?.strategyId) || "Unnamed strategy";
    const rationale = normalizeNullable(entry?.rationale);
    const confidence = normalizeConfidence(entry?.confidence);
    const tags = Array.isArray(entry?.tags) ? entry.tags.slice(0, 4).join(", ") : "";
    const pathMatches = normalizePathList(entry?.pathMatchPaths || []).slice(0, 2).join(", ");
    lines.push(
      [
        `- ${recommendation}`,
        confidence != null ? `confidence=${confidence.toFixed(2)}` : "",
        tags ? `tags=${tags}` : "",
        pathMatches ? `matched=${pathMatches}` : "",
      ].filter(Boolean).join(" | "),
    );
    if (rationale) {
      lines.push(`  rationale: ${rationale}`);
    }
  }
  return lines.join("\n");
}

export async function findReusableSkillbookStrategies(options = {}) {
  const strategies = await listSkillbookStrategies({
    ...options,
    sort: "ranked",
  });
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Math.trunc(Number(options.limit))) : 5;
  const selected = strategies.slice(0, limit);
  return {
    skillbookPath: resolveSkillbookPath(options),
    total: strategies.length,
    matched: selected.length,
    strategies: selected,
    guidanceSummary: buildSkillbookGuidanceSummary(selected, options),
  };
}
