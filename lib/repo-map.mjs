import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_FILE_LIMIT = 12;
const DEFAULT_MAX_SYMBOLS = 4;
const DEFAULT_TOPOLOGY_SUMMARY_LIMIT = 96;
const QUERY_STOP_WORDS = new Set([
  "about", "after", "again", "agent", "along", "also", "architect", "before", "being", "bosun",
  "build", "changes", "check", "code", "create", "debug", "editor", "ensure", "feature", "files",
  "from", "have", "implement", "implementation", "into", "large", "make", "mode", "plan", "phase",
  "repo", "task", "tests", "that", "them", "then", "this", "update", "validate", "validation",
  "with", "workflow", "worktree", "your",
]);
const IMPORTANT_PATHS = Object.freeze([
  "package.json",
  "AGENTS.md",
  "README.md",
  "README.mdx",
  "README.txt",
  "cli.mjs",
  "setup.mjs",
  "config/config.mjs",
  "infra/monitor.mjs",
  "workflow/workflow-nodes.mjs",
  "workflow/workflow-engine.mjs",
  "agent/primary-agent.mjs",
]);
const SOURCE_EXTENSIONS = new Set([".mjs", ".js", ".cjs", ".ts", ".tsx", ".jsx", ".json", ".md", ".yml", ".yaml"]);

function toPositiveInt(value, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function normalizeRepoAreas(values) {
  return uniqueStrings(values).map((value) => value.replace(/\\/g, "/").toLowerCase());
}

function truncateText(value, limit = DEFAULT_TOPOLOGY_SUMMARY_LIMIT) {
  const text = String(value || "").trim();
  const max = toPositiveInt(limit, DEFAULT_TOPOLOGY_SUMMARY_LIMIT);
  if (!text || text.length <= max) return text;
  if (max <= 3) return text.slice(0, max);
  const ellipsis = "...";
  const sliceLength = Math.max(1, max - ellipsis.length);
  const nextWordBreak = text.indexOf(" ", sliceLength);
  if (nextWordBreak > sliceLength && nextWordBreak - sliceLength <= 12) {
    return `${text.slice(0, nextWordBreak).trimEnd()}${ellipsis}`;
  }
  const truncated = text.slice(0, sliceLength);
  const lastWordBreak = truncated.lastIndexOf(" ");
  const prefersWordBoundary = lastWordBreak >= Math.floor(sliceLength * 0.6);
  const display = prefersWordBoundary ? truncated.slice(0, lastWordBreak) : truncated;
  return `${display.trimEnd()}${ellipsis}`;
}

function isTokenWordChar(char) {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (code >= 48 && code <= 57)
    || code === 95
    || (code >= 97 && code <= 122)
    || (code >= 65 && code <= 90);
}

function trimTokenBoundaryPunctuation(token) {
  const value = String(token || "");
  let start = 0;
  let end = value.length;
  while (start < end && !isTokenWordChar(value[start])) start += 1;
  while (end > start && !isTokenWordChar(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

function summarizePathSegment(segment) {
  return String(segment || "")
    .replace(/[-_]+/g, " ")
    .replace(/\.m?js$/i, "")
    .replace(/\.tsx?$/i, "")
    .replace(/\.jsx?$/i, "")
    .replace(/\.ya?ml$/i, "")
    .replace(/\.json$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function inferRepoMapEntry(pathValue) {
  const path = String(pathValue || "").trim().replace(/\\/g, "/");
  if (!path) return null;
  const name = path.split("/").pop() || path;
  const stem = summarizePathSegment(name);
  const dir = path.includes("/") ? path.split("/").slice(0, -1).join("/") : "";
  const dirHint = dir ? summarizePathSegment(dir.split("/").pop()) : "";
  const symbols = [];
  const lowerStem = stem.toLowerCase();
  if (lowerStem) {
    const compact = lowerStem
      .split(" ")
      .filter(Boolean)
      .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
      .join("");
    if (compact) {
      symbols.push(compact);
      if (!compact.startsWith("test")) symbols.push(`test${compact.charAt(0).toUpperCase()}${compact.slice(1)}`);
    }
  }
  const summaryParts = [];
  if (dirHint) summaryParts.push(`${dirHint} module`);
  if (stem) summaryParts.push(stem);
  return {
    path,
    summary: summaryParts.join(" — "),
    symbols: uniqueStrings(symbols).slice(0, DEFAULT_MAX_SYMBOLS),
  };
}

function normalizeRepoMapFile(entry, maxSymbols = DEFAULT_MAX_SYMBOLS) {
  if (!entry || typeof entry !== "object") return null;
  const path = String(entry.path || entry.file || "").trim().replace(/\\/g, "/");
  if (!path) return null;
  return {
    path,
    summary: String(entry.summary || entry.description || "").trim(),
    symbols: uniqueStrings(entry.symbols).slice(0, maxSymbols),
    adjacentPaths: uniqueStrings(entry.adjacentPaths || entry.adjacent).map((value) => value.replace(/\\/g, "/")),
  };
}

export function normalizeRepoMap(repoMap, opts = {}) {
  if (!repoMap || typeof repoMap !== "object") return null;
  const maxSymbols = toPositiveInt(opts.maxSymbols, DEFAULT_MAX_SYMBOLS);
  const rawRoot = String(repoMap.root || repoMap.repoRoot || "").trim();
  const root = rawRoot ? rawRoot.replace(/\\/g, "/") : "";
  const files = Array.isArray(repoMap.files)
    ? repoMap.files.map((entry) => normalizeRepoMapFile(entry, maxSymbols)).filter(Boolean)
    : [];
  if (!root && files.length === 0) return null;
  return { root, files };
}

export function formatRepoMap(repoMap, opts = {}) {
  const normalized = normalizeRepoMap(repoMap, opts);
  if (!normalized) return "";
  const lines = [String(opts.title || "## Repo Map")];
  if (normalized.root) lines.push(`- Root: ${normalized.root}`);
  for (const file of normalized.files) {
    const parts = [file.path];
    if (file.symbols.length) parts.push(`symbols: ${file.symbols.join(", ")}`);
    if (file.summary) parts.push(file.summary);
    lines.push(`- ${parts.join(" — ")}`);
  }
  return lines.join("\n");
}

function inferRepoOwner(pathValue) {
  const normalizedPath = String(pathValue || "").trim().replace(/\\/g, "/");
  if (!normalizedPath) return "root";
  const segments = normalizedPath.split("/");
  if (segments.length === 1) return "root";
  const [owner] = segments;
  return owner || "root";
}

function pathMatchesRepoAreas(pathValue, repoAreas = []) {
  const allowedAreas = normalizeRepoAreas(repoAreas);
  if (allowedAreas.length === 0) return true;
  const normalizedPath = String(pathValue || "").trim().replace(/\\/g, "/");
  if (!normalizedPath) return false;
  const owner = inferRepoOwner(normalizedPath).toLowerCase();
  if (allowedAreas.includes(owner)) return true;
  if (owner === "tests") {
    const lowerPath = normalizedPath.toLowerCase();
    return allowedAreas.some((area) => lowerPath.includes(area));
  }
  if (owner === "root") {
    const stem = summarizePathSegment(normalizedPath.split("/").pop() || "").toLowerCase().replace(/\s+/g, "");
    return allowedAreas.some((area) => stem === area.replace(/[^a-z0-9]/g, ""));
  }
  return false;
}

function filterRepoMapFiles(files, repoAreas = [], fileLimit = DEFAULT_FILE_LIMIT) {
  const allowedAreas = normalizeRepoAreas(repoAreas);
  const limited = Array.isArray(files) ? files : [];
  if (allowedAreas.length === 0) return limited.slice(0, fileLimit);
  const filtered = limited.filter((file) => pathMatchesRepoAreas(file?.path, allowedAreas));
  if (filtered.length === 0) return [];
  const filteredPaths = new Set(filtered.map((file) => String(file.path || "").replace(/\\/g, "/")));
  return filtered
    .map((file) => ({
      ...file,
      adjacentPaths: uniqueStrings(file?.adjacentPaths || [])
        .map((value) => value.replace(/\\/g, "/"))
        .filter((value) => filteredPaths.has(value) || pathMatchesRepoAreas(value, allowedAreas)),
    }))
    .slice(0, fileLimit);
}

function normalizeAdjacencyStem(pathValue) {
  return String(pathValue || "")
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .pop()?.toLowerCase()
    .replace(/(\.node)?\.test\.[^.]+$/i, "")
    .replace(/\.spec\.[^.]+$/i, "")
    .replace(/\.runtime\.[^.]+$/i, "")
    .replace(/\.[^.]+$/i, "")
    || "";
}

function scoreRepoAdjacency(left, right) {
  if (!left || !right || left.path === right.path) return -1;
  const leftPath = String(left.path || "").replace(/\\/g, "/");
  const rightPath = String(right.path || "").replace(/\\/g, "/");
  const leftDir = leftPath.includes("/") ? leftPath.split("/").slice(0, -1).join("/") : "";
  const rightDir = rightPath.includes("/") ? rightPath.split("/").slice(0, -1).join("/") : "";
  const leftOwner = inferRepoOwner(leftPath);
  const rightOwner = inferRepoOwner(rightPath);
  const leftStem = normalizeAdjacencyStem(leftPath);
  const rightStem = normalizeAdjacencyStem(rightPath);
  let score = 0;
  if (leftDir && leftDir === rightDir) score += 60;
  if (leftOwner && leftOwner === rightOwner) score += 25;
  if (leftStem && leftStem === rightStem) score += 40;
  if ((leftOwner === "tests" || rightOwner === "tests") && leftStem && leftStem === rightStem) score += 30;
  return score;
}

export function hasRepoMapContext(value = "") {
  const text = String(value || "");
  return text.includes("## Repo Topology") || text.includes("## Repo Map");
}

export function formatRepoTopology(repoMap, opts = {}) {
  const normalized = normalizeRepoMap(repoMap, opts);
  if (!normalized) return "";
  const files = Array.isArray(normalized.files) ? normalized.files : [];
  const lines = [String(opts.title || "## Repo Topology")];
  const summaryLimit = toPositiveInt(opts.repoMapSummaryLimit || opts.summaryLimit, DEFAULT_TOPOLOGY_SUMMARY_LIMIT);
  if (normalized.root) lines.push(`- Root: ${normalized.root}`);
  if (files.length === 0) return lines.join("\n");

  const areaCounts = new Map();
  for (const file of files) {
    const owner = inferRepoOwner(file.path);
    areaCounts.set(owner, (areaCounts.get(owner) || 0) + 1);
  }
  const areas = [...areaCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([owner, count]) => `${owner} (${count})`);
  if (areas.length) lines.push(`- Areas: ${areas.join(", ")}`);

  const adjacencyLimit = toPositiveInt(opts.repoMapAdjacencyLimit || opts.adjacencyLimit, 2);
  for (const file of files) {
    const owner = inferRepoOwner(file.path);
    const summary = truncateText(file.summary, summaryLimit);
    const graphAdjacent = uniqueStrings(file.adjacentPaths)
      .filter((candidate) => candidate && candidate !== file.path)
      .slice(0, adjacencyLimit);
    const adjacent = graphAdjacent.length > 0
      ? graphAdjacent
      : files
        .map((candidate) => ({ path: candidate.path, score: scoreRepoAdjacency(file, candidate) }))
        .filter((candidate) => candidate.score > 0)
        .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
        .slice(0, adjacencyLimit)
        .map((candidate) => candidate.path);
    const parts = [file.path, `owner: ${owner}`];
    if (summary) parts.push(summary);
    if (adjacent.length) parts.push(`adjacent: ${adjacent.join(", ")}`);
    lines.push(`- ${parts.join(" — ")}`);
  }
  return lines.join("\n");
}

export function buildRepoTopologyContext(options = {}) {
  return formatRepoTopology(buildRepoMap(options), options);
}

function resolveRootDir(options = {}) {
  const explicit = String(options.rootDir || options.repoRoot || options.cwd || "").trim();
  if (explicit) return explicit.replace(/\\/g, "/");
  const fallback = String(process.cwd() || "").trim();
  return fallback ? fallback.replace(/\\/g, "/") : "";
}

function loadAgentIndex(rootDir) {
  const dbPath = resolve(rootDir, ".bosun", "context-index", "index.db");
  if (rootDir && existsSync(dbPath)) {
    try {
      const db = new DatabaseSync(dbPath);
      try {
        const files = db.prepare(`
          SELECT path, summary
          FROM files
          ORDER BY path ASC
        `).all();
        const symbols = db.prepare(`
          SELECT path, name, kind, line, signature
          FROM symbols
          ORDER BY path ASC, line ASC
        `).all();
        const relations = db.prepare(`
          SELECT from_path AS fromPath,
                 to_path AS toPath,
                 relation_type AS relationType
          FROM relations
          ORDER BY relation_type ASC, edge_id ASC
        `).all();
        return { filePath: dbPath, files, symbols, relations, source: "context-index-db" };
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
  }
  if (!rootDir) return null;
  const filePath = resolve(rootDir, ".bosun", "context-index", "agent-index.json");
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    const files = Array.isArray(parsed?.files) ? parsed.files : [];
    const symbols = Array.isArray(parsed?.symbols) ? parsed.symbols : [];
    const relations = Array.isArray(parsed?.relations) ? parsed.relations : [];
    return { filePath, files, symbols, relations };
  } catch {
    return null;
  }
}

function buildIndexMaps(index) {
  const fileByPath = new Map();
  const symbolsByPath = new Map();
  const graphAdjacencyByPath = new Map();
  if (!index) return { fileByPath, symbolsByPath, graphAdjacencyByPath };
  for (const file of index.files || []) {
    const path = String(file?.path || "").trim().replace(/\\/g, "/");
    if (!path) continue;
    fileByPath.set(path, file);
  }
  for (const symbol of index.symbols || []) {
    const path = String(symbol?.path || "").trim().replace(/\\/g, "/");
    if (!path) continue;
    if (!symbolsByPath.has(path)) symbolsByPath.set(path, []);
    symbolsByPath.get(path).push(symbol);
  }
  for (const relation of index.relations || []) {
    const relationType = String(relation?.relationType || "").trim();
    if (relationType !== "file_imports_file") continue;
    const fromPath = String(relation?.fromPath || "").trim().replace(/\\/g, "/");
    const toPath = String(relation?.toPath || "").trim().replace(/\\/g, "/");
    if (!fromPath || !toPath || fromPath === toPath) continue;
    if (!graphAdjacencyByPath.has(fromPath)) graphAdjacencyByPath.set(fromPath, new Set());
    if (!graphAdjacencyByPath.has(toPath)) graphAdjacencyByPath.set(toPath, new Set());
    graphAdjacencyByPath.get(fromPath).add(toPath);
    graphAdjacencyByPath.get(toPath).add(fromPath);
  }
  return { fileByPath, symbolsByPath, graphAdjacencyByPath };
}

function tokenizeQuery(...parts) {
  return uniqueStrings(
    parts
      .map((part) => String(part || "").toLowerCase())
      .flatMap((part) => part.match(/[a-z0-9][a-z0-9._/-]{2,}/g) || [])
      .map((token) => trimTokenBoundaryPunctuation(token))
      .filter((token) => token.length >= 3 && !QUERY_STOP_WORDS.has(token)),
  );
}

function takeTopSymbols(symbols, tokens, maxSymbols) {
  const normalizedTokens = Array.isArray(tokens) ? tokens : [];
  const scored = (Array.isArray(symbols) ? symbols : []).map((symbol) => {
    const name = String(symbol?.name || "").trim();
    const signature = String(symbol?.signature || "").trim();
    const lowerName = name.toLowerCase();
    const lowerSignature = signature.toLowerCase();
    let score = 0;
    for (const token of normalizedTokens) {
      if (lowerName.includes(token)) score += 30;
      if (lowerSignature.includes(token)) score += 10;
    }
    return { name, score, line: Number(symbol?.line || 0) };
  });
  scored.sort((left, right) => right.score - left.score || left.line - right.line || left.name.localeCompare(right.name));
  return uniqueStrings(scored.map((entry) => entry.name)).slice(0, maxSymbols);
}

function buildEntryFromIndex(path, maps, tokens, maxSymbols, adjacencyLimit = 2) {
  const normalizedPath = String(path || "").trim().replace(/\\/g, "/");
  if (!normalizedPath) return null;
  const file = maps.fileByPath.get(normalizedPath);
  const symbols = maps.symbolsByPath.get(normalizedPath) || [];
  const adjacentPaths = [...(maps.graphAdjacencyByPath.get(normalizedPath) || new Set())]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, adjacencyLimit);
  const matchedSymbols = takeTopSymbols(symbols, tokens, maxSymbols);
  if (!file) {
    const fallback = inferRepoMapEntry(normalizedPath);
    if (!fallback) return null;
    return {
      ...fallback,
      symbols: matchedSymbols.length > 0 ? matchedSymbols : fallback.symbols.slice(0, maxSymbols),
      adjacentPaths,
    };
  }
  return {
    path: normalizedPath,
    summary: String(file.summary || "").trim(),
    symbols: matchedSymbols.length > 0 ? matchedSymbols : takeTopSymbols(symbols, [], maxSymbols),
    adjacentPaths,
  };
}

function scoreIndexedFile(file, symbols, tokens) {
  const path = String(file?.path || "").toLowerCase();
  const summary = String(file?.summary || "").toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (path.includes(token)) score += 24;
    if (summary.includes(token)) score += 12;
    for (const symbol of symbols) {
      const name = String(symbol?.name || "").toLowerCase();
      const signature = String(symbol?.signature || "").toLowerCase();
      if (name.includes(token)) score += 20;
      if (signature.includes(token)) score += 8;
    }
  }
  if (IMPORTANT_PATHS.includes(file?.path)) score += 10;
  return score;
}

function pickEntriesFromIndex(index, tokens, fileLimit, maxSymbols) {
  if (!index) return [];
  const maps = buildIndexMaps(index);
  const scored = [];
  for (const file of index.files || []) {
    const path = String(file?.path || "").trim().replace(/\\/g, "/");
    if (!path) continue;
    const symbols = maps.symbolsByPath.get(path) || [];
    const score = scoreIndexedFile(file, symbols, tokens);
    if (score <= 0) continue;
    scored.push({ path, score });
  }
  scored.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  return scored
    .slice(0, fileLimit)
    .map((entry) => buildEntryFromIndex(entry.path, maps, tokens, maxSymbols))
    .filter(Boolean);
}

function pickImportantEntriesFromIndex(index, fileLimit, maxSymbols) {
  if (!index) return [];
  const maps = buildIndexMaps(index);
  const picked = [];
  for (const path of IMPORTANT_PATHS) {
    const entry = buildEntryFromIndex(path, maps, [], maxSymbols);
    if (entry) picked.push(entry);
  }
  if (picked.length >= fileLimit) return picked.slice(0, fileLimit);

  const seenDirs = new Set(picked.map((entry) => entry.path.split("/")[0] || ""));
  for (const file of index.files || []) {
    const path = String(file?.path || "").trim().replace(/\\/g, "/");
    if (!path || picked.some((entry) => entry.path === path)) continue;
    const topDir = path.split("/")[0] || "";
    if (seenDirs.has(topDir) && topDir) continue;
    const entry = buildEntryFromIndex(path, maps, [], maxSymbols);
    if (!entry) continue;
    picked.push(entry);
    if (topDir) seenDirs.add(topDir);
    if (picked.length >= fileLimit) break;
  }
  return picked.slice(0, fileLimit);
}

function scanFilesystemEntries(rootDir, fileLimit, maxSymbols) {
  if (!rootDir || !existsSync(rootDir)) return [];
  const picked = [];
  const pushEntry = (relPath) => {
    const entry = inferRepoMapEntry(relPath);
    if (!entry || picked.some((item) => item.path === entry.path)) return;
    picked.push({ ...entry, symbols: entry.symbols.slice(0, maxSymbols) });
  };

  for (const relPath of IMPORTANT_PATHS) {
    const absPath = resolve(rootDir, relPath);
    if (existsSync(absPath)) pushEntry(relPath);
    if (picked.length >= fileLimit) return picked;
  }

  const topEntries = readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith(".") || entry.name === ".github")
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of topEntries) {
    if (picked.length >= fileLimit) break;
    if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      pushEntry(entry.name);
      continue;
    }
    if (!entry.isDirectory()) continue;
    const dirPath = join(rootDir, entry.name);
    const child = readdirSync(dirPath, { withFileTypes: true })
      .filter((item) => item.isFile() && SOURCE_EXTENSIONS.has(extname(item.name).toLowerCase()))
      .sort((left, right) => left.name.localeCompare(right.name))[0];
    if (child) pushEntry(join(entry.name, child.name));
  }

  return picked.slice(0, fileLimit);
}

export function buildRepoMap(options = {}) {
  const maxSymbols = toPositiveInt(options.repoMapMaxSymbols, DEFAULT_MAX_SYMBOLS);
  const fileLimit = toPositiveInt(options.repoMapFileLimit, DEFAULT_FILE_LIMIT);
  const expandedFileLimit = Math.max(fileLimit, fileLimit * 4);
  const repoAreas = normalizeRepoAreas(options.repoAreas);
  const explicit = normalizeRepoMap(options.repoMap, { maxSymbols });
  const rootDir = resolveRootDir(options);
  if (explicit) {
    return {
      root: explicit.root || rootDir,
      files: filterRepoMapFiles(explicit.files, repoAreas, fileLimit),
    };
  }

  const changedFiles = uniqueStrings(options.changedFiles).map((value) => value.replace(/\\/g, "/"));
  const queryTokens = tokenizeQuery(
    options.repoMapQuery,
    options.query,
    options.taskTitle,
    options.taskDescription,
    options.prompt,
    options.userMessage,
  );

  const index = loadAgentIndex(rootDir);
  const maps = buildIndexMaps(index);

  let files = [];
  if (changedFiles.length > 0) {
    files = filterRepoMapFiles(changedFiles
      .map((path) => buildEntryFromIndex(path, maps, queryTokens, maxSymbols))
      .filter(Boolean), repoAreas, fileLimit);
  }

  if (files.length === 0 && queryTokens.length > 0) {
    files = filterRepoMapFiles(
      pickEntriesFromIndex(index, queryTokens, expandedFileLimit, maxSymbols),
      repoAreas,
      fileLimit,
    );
  }

  if (files.length === 0) {
    files = filterRepoMapFiles(
      pickImportantEntriesFromIndex(index, expandedFileLimit, maxSymbols),
      repoAreas,
      fileLimit,
    );
  }

  if (files.length === 0) {
    files = filterRepoMapFiles(
      scanFilesystemEntries(rootDir, expandedFileLimit, maxSymbols),
      repoAreas,
      fileLimit,
    );
  }

  if (!rootDir && files.length === 0) return null;
  return { root: rootDir, files };
}

export function inferExecutionRole(options = {}, effectiveMode = "agent") {
  const explicitRole = String(options.executionRole || "").trim().toLowerCase();
  if (explicitRole) return explicitRole;
  if (effectiveMode === "plan") return "architect";
  const architectPlan = String(options.architectPlan || options.planSummary || "").trim();
  if (architectPlan) return "editor";
  return "";
}

export function buildArchitectEditorFrame(options = {}, effectiveMode = "agent") {
  const executionRole = inferExecutionRole(options, effectiveMode);
  if (!executionRole) {
    return "";
  }
  const repoAreas = normalizeRepoAreas(options.repoAreas);
  const repoMapBlock = options.includeRepoMap === false
    ? ""
    : formatRepoTopology(buildRepoMap(options), options);
  const architectPlan = String(options.architectPlan || options.planSummary || "").trim();
  const lines = ["## Architect/Editor Execution"];

  if (executionRole === "architect") {
    lines.push(
      "You are the architect phase.",
      "Do not implement code changes in this phase.",
      "Use the repo topology to produce a compact structural plan that an editor can execute and validate.",
      "Editor handoff: include ordered implementation steps, touched files, risks, and validation guidance.",
    );
  } else if (executionRole === "editor") {
    lines.push(
      "You are the editor phase.",
      "Implement the approved plan with focused edits and verification.",
      "Prefer the supplied repo topology over broad rediscovery unless validation reveals drift.",
    );
    if (architectPlan) {
      lines.push("", "## Architect Plan", architectPlan);
    }
  }
  if (repoAreas.length > 0) {
    lines.push(
      "",
      "Restrict discovery and edits to these repo areas unless the task evidence proves a dependency chain beyond them:",
      "Only inspect tests that directly cover these repo areas or the files you expect to touch.",
      "Avoid unrelated test suites from other product areas unless the dependency chain explicitly reaches them.",
    );
    for (const repoArea of repoAreas) lines.push(`- ${repoArea}`);
  }
  if (repoMapBlock) {
    lines.push("", repoMapBlock);
  }

  return lines.join("\n");
}

