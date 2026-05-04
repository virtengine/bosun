import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve, relative, extname, dirname, posix as pathPosix } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";

export const CONTEXT_INDEX_DIR = ".bosun/context-index";

const DB_FILE_NAME = "index.db";
const DOCS_DIR_NAME = "docs";
const ZOEKT_DIR_NAME = "zoekt";

const INCLUDED_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".cs",
  ".cpp",
  ".c",
  ".h",
  ".hpp",
  ".md",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".sh",
]);

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".tiff",
  ".mp3",
  ".wav",
  ".ogg",
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".pdf",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
]);

const EXCLUDED_DIR_NAMES = new Set([
  ".bosun",
  ".bosun-monitor",
  ".git",
  ".repo-mirror",
  ".code-search",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  ".cache",
  "execution-ledger",
  "logs",
  "node-compile-cache",
  "output",
  "playwright-report",
  "test-results",
  ".tmp",
  "tmp",
  "worktrees",
]);

const TASK_TYPE_ALIASES = Object.freeze({
  auto: "auto",
  ci: "ci-cd",
  cicd: "ci-cd",
  "ci-cd": "ci-cd",
  "ci_cd": "ci-cd",
  pipeline: "ci-cd",
  frontend: "frontend",
  "front-end": "frontend",
  ui: "frontend",
  web: "frontend",
  backend: "backend",
  api: "backend",
  server: "backend",
  infra: "infra",
  infrastructure: "infra",
  devops: "infra",
  docs: "docs",
  documentation: "docs",
  security: "security",
  sec: "security",
});

const TASK_TYPE_SCOPES = Object.freeze({
  "ci-cd": {
    includePathFragments: [
      ".github/workflows/",
      "github/workflows",
      "pipeline",
      "ci",
      "cd",
      "jenkins",
      "gitlab-ci",
      "buildkite",
    ],
    includeLanguages: ["yaml", "yml", "toml", "shell", "json"],
  },
  frontend: {
    includePathFragments: [
      "ui/",
      "site/",
      "web/",
      "frontend/",
      "components/",
      "pages/",
      "styles/",
      "public/",
    ],
    includeLanguages: ["javascript", "typescript", "css", "html", "markdown"],
  },
  backend: {
    includePathFragments: [
      "api/",
      "server/",
      "backend/",
      "service",
      "worker",
      "handlers/",
      "controllers/",
      "routes/",
      "db/",
    ],
    includeLanguages: ["javascript", "typescript", "python", "go", "rust", "java", "csharp"],
  },
  infra: {
    includePathFragments: [
      "infra/",
      "terraform",
      "k8s",
      "kubernetes",
      "helm",
      "docker",
      "compose",
      "deployment",
      "ops/",
    ],
    includeLanguages: ["yaml", "yml", "toml", "shell", "json"],
  },
  docs: {
    includePathFragments: ["docs/", "readme", "guide", "changelog", "adr", "spec"],
    includeLanguages: ["markdown", "json", "yaml", "yml", "toml"],
  },
  security: {
    includePathFragments: [
      "security",
      "auth",
      "oauth",
      "jwt",
      "policy",
      "permission",
      "rbac",
      "secret",
      "credential",
    ],
    includeLanguages: ["javascript", "typescript", "python", "go", "rust", "java", "csharp", "shell"],
  },
});

const DEFAULT_CONTEXT_INDEX_MAX_AGE_MS = 15 * 60 * 1000;
const DEFAULT_CONTEXT_FILE_SYMBOL_LIMIT = 6;
const DEFAULT_CONTEXT_FILE_RELATION_LIMIT = 4;
const GENERIC_RELATED_TEST_STEMS = new Set([
  "app",
  "config",
  "helper",
  "helpers",
  "index",
  "main",
  "test",
  "types",
  "util",
  "utils",
]);

let sqliteModulePromise = null;
let treeSitterAvailability = null;
let zoektAvailability = null;

async function getSqliteModule() {
  if (!sqliteModulePromise) {
    sqliteModulePromise = import("node:sqlite");
  }
  return sqliteModulePromise;
}

function resolvePaths(rootDir) {
  const resolvedRoot = resolve(rootDir || process.cwd());
  const indexDir = resolve(resolvedRoot, CONTEXT_INDEX_DIR);
  const dbPath = resolve(indexDir, DB_FILE_NAME);
  const docsPath = resolve(indexDir, DOCS_DIR_NAME);
  const zoektPath = resolve(indexDir, ZOEKT_DIR_NAME);
  return { rootDir: resolvedRoot, indexDir, dbPath, docsPath, zoektPath };
}

function ensureIndexDirs(paths) {
  mkdirSync(paths.indexDir, { recursive: true });
  mkdirSync(dirname(paths.dbPath), { recursive: true });
  mkdirSync(paths.docsPath, { recursive: true });
}

function normalizeContextIndexPathHints(paths = [], rootDir = process.cwd()) {
  const root = resolve(rootDir || process.cwd());
  return [...new Set(
    (Array.isArray(paths) ? paths : [paths])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .map((value) => value.replace(/\\/g, "/"))
      .map((value) => {
        if (!value) return "";
        const absoluteCandidate = resolve(root, value);
        if (absoluteCandidate.startsWith(root)) {
          return relative(root, absoluteCandidate).replace(/\\/g, "/");
        }
        return value.replace(/^\.\//, "");
      })
      .filter(Boolean),
  )];
}

function resolveContextIndexMaxAgeMs(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : DEFAULT_CONTEXT_INDEX_MAX_AGE_MS;
}

function haveHintedFilesChangedSince(rootDir, changedFiles = [], lastIndexedAt = "") {
  const lastIndexedMs = Date.parse(String(lastIndexedAt || ""));
  if (!Number.isFinite(lastIndexedMs)) return changedFiles.length > 0;
  const normalizedFiles = normalizeContextIndexPathHints(changedFiles, rootDir);
  for (const relPath of normalizedFiles) {
    const absolutePath = resolve(rootDir, relPath);
    try {
      if (statSync(absolutePath).mtimeMs > lastIndexedMs + 1000) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

function computeWorkspaceSourceFreshness(rootDir, opts = {}) {
  const includeTests = opts.includeTests !== false;
  const maxFileBytes = Number.isFinite(Number(opts.maxFileBytes))
    ? Math.max(1024, Number(opts.maxFileBytes))
    : 800000;
  const paths = resolvePaths(rootDir);
  const scannedFiles = collectSourceFiles(paths.rootDir, { includeTests, maxFileBytes }, paths);
  let latestSourceMtimeMs = 0;
  let latestSourcePath = "";
  for (const file of scannedFiles) {
    const mtimeMs = Number(file?.mtimeMs || 0);
    if (mtimeMs > latestSourceMtimeMs) {
      latestSourceMtimeMs = mtimeMs;
      latestSourcePath = String(file?.relPath || "").replace(/\\/g, "/");
    }
  }
  return {
    sourceFileCount: scannedFiles.length,
    latestSourceMtimeMs: latestSourceMtimeMs || null,
    latestSourcePath: latestSourcePath || null,
  };
}

async function openDb(rootDir) {
  const paths = resolvePaths(rootDir);
  ensureIndexDirs(paths);

  const sqlite = await getSqliteModule();
  const DatabaseSync = sqlite.DatabaseSync;
  if (!DatabaseSync) {
    throw new Error("node:sqlite DatabaseSync is unavailable in this Node.js runtime");
  }

  const db = new DatabaseSync(paths.dbPath);
  ensureSchema(db);
  return { db, paths };
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      hash TEXT,
      size INTEGER,
      mtime_ms INTEGER,
      language TEXT,
      summary TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT,
      name TEXT,
      kind TEXT,
      line INTEGER,
      signature TEXT,
      parser TEXT
    );

    CREATE TABLE IF NOT EXISTS index_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS relations (
      edge_id TEXT PRIMARY KEY,
      from_node_id TEXT NOT NULL,
      from_node_type TEXT NOT NULL,
      from_path TEXT,
      from_name TEXT,
      to_node_id TEXT NOT NULL,
      to_node_type TEXT NOT NULL,
      to_path TEXT,
      to_name TEXT,
      relation_type TEXT NOT NULL,
      line INTEGER,
      weight INTEGER NOT NULL DEFAULT 1,
      metadata_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_symbols_path ON symbols(path);
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);
    CREATE INDEX IF NOT EXISTS idx_relations_from_node ON relations(from_node_id, relation_type);
    CREATE INDEX IF NOT EXISTS idx_relations_to_node ON relations(to_node_id, relation_type);
    CREATE INDEX IF NOT EXISTS idx_relations_from_path ON relations(from_path, relation_type);
    CREATE INDEX IF NOT EXISTS idx_relations_to_path ON relations(to_path, relation_type);
  `);
}

function setMeta(db, key, value) {
  db.prepare(`
    INSERT INTO index_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value ?? ""));
}

function getMeta(db, key) {
  const row = db.prepare("SELECT value FROM index_meta WHERE key = ?").get(key);
  return row?.value ?? null;
}

function shouldSkipTestPath(relPath) {
  return /(^|\/)(test|tests|__tests__|__mocks__)(\/|$)|\.(test|spec)\./i.test(relPath);
}

function shouldSkipDir(absPath, relPath, generatedPaths = {}) {
  const name = absPath.split(/[\\/]/).pop() || "";
  if (EXCLUDED_DIR_NAMES.has(name)) return true;
  const normalizedAbs = absPath.replaceAll("\\", "/");
  const normalizedGeneratedRoots = [
    generatedPaths?.indexDir,
    generatedPaths?.docsPath,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .map((value) => value.replaceAll("\\", "/"));
  for (const generatedRoot of normalizedGeneratedRoots) {
    if (normalizedAbs === generatedRoot) return true;
    if (normalizedAbs.startsWith(`${generatedRoot}/`)) return true;
  }
  if (!relPath) return false;
  return false;
}

function detectLanguage(filePath) {
  const extension = extname(filePath).toLowerCase();
  const map = {
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".cs": "csharp",
    ".cpp": "cpp",
    ".c": "c",
    ".h": "c",
    ".hpp": "cpp",
    ".md": "markdown",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".sh": "shell",
  };
  return map[extension] || "text";
}

function extractSummary(content) {
  const lines = String(content || "").split(/\r?\n/);
  const commentLike = /^(\/\/|#|\/\*|\*|<!--|--|;)/;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (commentLike.test(line)) {
      return line
        .replace(/^(\/\/|#|\/\*+|\*+|<!--|--|;+)/, "")
        .replace(/\*\/$/, "")
        .trim()
        .slice(0, 240);
    }
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (line) return line.slice(0, 240);
  }

  return "";
}

function lineFromIndex(content, index) {
  if (index <= 0) return 1;
  let line = 1;
  for (let i = 0; i < index && i < content.length; i += 1) {
    if (content[i] === "\n") line += 1;
  }
  return line;
}

function pushSymbol(target, dedupe, symbol) {
  if (!symbol?.name) return;
  const key = `${symbol.name}::${symbol.kind || "symbol"}::${symbol.line || 1}`;
  if (dedupe.has(key)) return;
  dedupe.add(key);
  target.push(symbol);
}

function extractHeuristicSymbols(content, language) {
  const symbols = [];
  const dedupe = new Set();

  const addFromRegex = (regex, build) => {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(content)) !== null) {
      const index = match.index || 0;
      const line = lineFromIndex(content, index);
      const symbol = build(match, line);
      pushSymbol(symbols, dedupe, { ...symbol, parser: "heuristic" });
      if (regex.lastIndex === match.index) {
        regex.lastIndex += 1;
      }
    }
  };

  if (["javascript", "typescript"].includes(language)) {
    addFromRegex(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/gm, (m, line) => ({
      name: m[1],
      kind: "function",
      line,
      signature: `${m[1]}(${(m[2] || "").trim()})`,
    }));

    addFromRegex(/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm, (m, line) => ({
      name: m[1],
      kind: "class",
      line,
      signature: `class ${m[1]}`,
    }));

    addFromRegex(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/gm, (m, line) => ({
      name: m[1],
      kind: "function",
      line,
      signature: `${m[1]}(${(m[2] || "").trim()})`,
    }));
  }

  if (language === "python") {
    addFromRegex(/^\s*class\s+([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*:/gm, (m, line) => ({
      name: m[1],
      kind: "class",
      line,
      signature: `class ${m[1]}`,
    }));

    addFromRegex(/^\s*def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*:/gm, (m, line) => ({
      name: m[1],
      kind: "function",
      line,
      signature: `${m[1]}(${(m[2] || "").trim()})`,
    }));
  }

  if (language === "go") {
    addFromRegex(/^\s*type\s+([A-Za-z_]\w*)\s+struct\b/gm, (m, line) => ({
      name: m[1],
      kind: "struct",
      line,
      signature: `type ${m[1]} struct`,
    }));

    addFromRegex(/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(([^)]*)\)/gm, (m, line) => ({
      name: m[1],
      kind: "function",
      line,
      signature: `${m[1]}(${(m[2] || "").trim()})`,
    }));
  }

  if (language === "rust") {
    addFromRegex(/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/gm, (m, line) => ({
      name: m[1],
      kind: "function",
      line,
      signature: `${m[1]}(${(m[2] || "").trim()})`,
    }));

    addFromRegex(/^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/gm, (m, line) => ({
      name: m[1],
      kind: "type",
      line,
      signature: m[0].trim(),
    }));
  }

  if (language === "shell") {
    addFromRegex(/^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\)\s*\{/gm, (m, line) => ({
      name: m[1],
      kind: "function",
      line,
      signature: `${m[1]}()`,
    }));
  }

  return symbols;
}

function ensureTreeSitterAvailability() {
  if (treeSitterAvailability) return treeSitterAvailability;

  const check = spawnSync("tree-sitter", ["--help"], { encoding: "utf8", stdio: "pipe" });
  treeSitterAvailability = {
    available: check.status === 0,
    command: "tree-sitter",
  };
  return treeSitterAvailability;
}

function parseTreeSitterTags(content) {
  const symbols = [];
  const dedupe = new Set();
  const lines = String(content || "").split(/\r?\n/);

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("!_TAG_")) continue;

    const parts = line.split("\t");
    const name = parts[0]?.trim() || "";
    if (!name) continue;

    const kindMatch = line.match(/;"\s*([^\s\t]+)/);
    const lineMatch = line.match(/\bline:(\d+)\b/) || line.match(/:(\d+):\d+/);
    const signature = parts[2] ? parts[2].trim() : "";

    pushSymbol(symbols, dedupe, {
      name,
      kind: (kindMatch?.[1] || "symbol").toLowerCase(),
      line: Number(lineMatch?.[1] || 1),
      signature,
      parser: "tree-sitter",
    });
  }

  return symbols;
}

async function extractSymbolsForFile(absPath, language, content, useTreeSitter) {
  if (useTreeSitter) {
    const ts = ensureTreeSitterAvailability();
    if (ts.available) {
      try {
        const output = execFileSync(ts.command, ["tags", absPath], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        const parsed = parseTreeSitterTags(output);
        if (parsed.length > 0) {
          return parsed;
        }
      } catch {
        // Fall through to heuristic extraction.
      }
    }
  }

  return extractHeuristicSymbols(content, language);
}

function makeRepoNodeId(rootDir) {
  return `repo:${pathPosix.normalize(String(rootDir || "").replaceAll("\\", "/"))}`;
}

function makeFileNodeId(relPath) {
  return `file:${String(relPath || "").replaceAll("\\", "/")}`;
}

function makeSymbolNodeId(symbol = {}) {
  return `symbol:${symbol.path || ""}:${symbol.name || ""}:${symbol.kind || "symbol"}:${Number(symbol.line || 1)}`;
}

function makeRelationEdgeId(relation = {}) {
  return [
    relation.fromNodeId,
    relation.relationType,
    relation.toNodeId,
    relation.line || 0,
  ].join("::");
}

function createRelation(relation = {}) {
  return {
    edgeId: makeRelationEdgeId(relation),
    fromNodeId: relation.fromNodeId,
    fromNodeType: relation.fromNodeType,
    fromPath: relation.fromPath || null,
    fromName: relation.fromName || null,
    toNodeId: relation.toNodeId,
    toNodeType: relation.toNodeType,
    toPath: relation.toPath || null,
    toName: relation.toName || null,
    relationType: relation.relationType,
    line: Number.isFinite(Number(relation.line)) ? Number(relation.line) : null,
    weight: Number.isFinite(Number(relation.weight)) ? Number(relation.weight) : 1,
    metadata: relation.metadata || null,
  };
}

function parseModuleSpecMatches(content, regex, specIndex = 1) {
  const matches = [];
  regex.lastIndex = 0;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const spec = String(match?.[specIndex] || "").trim();
    if (spec) {
      matches.push({
        spec,
        line: lineFromIndex(content, match.index || 0),
      });
    }
    if (regex.lastIndex === match.index) regex.lastIndex += 1;
  }
  return matches;
}

function extractImportTargets(relPath, language, content) {
  const imports = [];
  const pushImport = (spec, line, kind = "import") => {
    const normalized = String(spec || "").trim();
    if (!normalized) return;
    imports.push({ spec: normalized, line: Number(line || 1), kind });
  };

  if (["javascript", "typescript"].includes(language)) {
    for (const entry of parseModuleSpecMatches(content, /\bimport\s+[\s\S]*?\bfrom\s*["']([^"'`]+)["']/gm)) {
      pushImport(entry.spec, entry.line, "import");
    }
    for (const entry of parseModuleSpecMatches(content, /\bexport\s+[\s\S]*?\bfrom\s*["']([^"'`]+)["']/gm)) {
      pushImport(entry.spec, entry.line, "re-export");
    }
    for (const entry of parseModuleSpecMatches(content, /\brequire\(\s*["']([^"'`]+)["']\s*\)/gm)) {
      pushImport(entry.spec, entry.line, "require");
    }
    for (const entry of parseModuleSpecMatches(content, /\bimport\(\s*["']([^"'`]+)["']\s*\)/gm)) {
      pushImport(entry.spec, entry.line, "dynamic-import");
    }
    return imports;
  }

  if (language === "python") {
    for (const entry of parseModuleSpecMatches(content, /^\s*from\s+([.\w]+)\s+import\s+/gm)) {
      pushImport(entry.spec, entry.line, "from-import");
    }
    for (const entry of parseModuleSpecMatches(content, /^\s*import\s+([A-Za-z_][\w.]*)/gm)) {
      pushImport(entry.spec, entry.line, "import");
    }
    return imports;
  }

  return imports;
}

function resolveJsImportTarget(relPath, spec, filePathSet) {
  if (!spec.startsWith(".")) return null;
  const baseDir = pathPosix.dirname(relPath);
  const base = pathPosix.normalize(pathPosix.join(baseDir, spec));
  const candidates = new Set([base]);
  const extension = pathPosix.extname(base).toLowerCase();
  const extensions = [".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json"];
  if (!extension) {
    for (const ext of extensions) {
      candidates.add(`${base}${ext}`);
      candidates.add(pathPosix.join(base, `index${ext}`));
    }
  }
  for (const candidate of candidates) {
    if (filePathSet.has(candidate)) return candidate;
  }
  return null;
}

function resolvePythonImportTarget(relPath, spec, filePathSet) {
  if (!spec) return null;
  const leadingDots = spec.match(/^\.+/)?.[0]?.length || 0;
  let baseDir = pathPosix.dirname(relPath);
  if (leadingDots > 0) {
    for (let i = 1; i < leadingDots; i += 1) {
      baseDir = pathPosix.dirname(baseDir);
    }
  } else {
    baseDir = "";
  }
  const remainder = spec.slice(leadingDots).replaceAll(".", "/");
  const base = remainder
    ? pathPosix.normalize(baseDir ? pathPosix.join(baseDir, remainder) : remainder)
    : null;
  const candidates = [];
  if (base) {
    candidates.push(`${base}.py`);
    candidates.push(pathPosix.join(base, "__init__.py"));
  }
  for (const candidate of candidates) {
    if (filePathSet.has(candidate)) return candidate;
  }
  return null;
}

function resolveImportTarget(relPath, language, spec, filePathSet) {
  if (["javascript", "typescript"].includes(language)) {
    return resolveJsImportTarget(relPath, spec, filePathSet);
  }
  if (language === "python") {
    return resolvePythonImportTarget(relPath, spec, filePathSet);
  }
  return null;
}

function normalizeRelatedFileStem(pathValue) {
  return String(pathValue || "")
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .pop()?.toLowerCase()
    .replace(/(\.node)?\.test\.[^.]+$/i, "")
    .replace(/\.spec\.[^.]+$/i, "")
    .replace(/\.runtime\.[^.]+$/i, "")
    .replace(/\.integration\.[^.]+$/i, "")
    .replace(/\.unit\.[^.]+$/i, "")
    .replace(/\.e2e\.[^.]+$/i, "")
    .replace(/\.[^.]+$/i, "")
    || "";
}

function addDerivedTestRelations(files = [], addRelation = () => {}) {
  const testsByStem = new Map();
  const sourceFiles = [];

  for (const file of files) {
    const relPath = normalizeGraphPath(file?.relPath || "");
    if (!relPath) continue;
    const stem = normalizeRelatedFileStem(relPath);
    if (!stem || GENERIC_RELATED_TEST_STEMS.has(stem)) continue;
    const entry = { relPath, stem };
    if (shouldSkipTestPath(relPath)) {
      if (!testsByStem.has(stem)) testsByStem.set(stem, []);
      testsByStem.get(stem).push(entry);
      continue;
    }
    sourceFiles.push(entry);
  }

  for (const source of sourceFiles) {
    const relatedTests = testsByStem.get(source.stem) || [];
    for (const testFile of relatedTests.slice(0, 6)) {
      addRelation({
        fromNodeId: makeFileNodeId(source.relPath),
        fromNodeType: "file",
        fromPath: source.relPath,
        fromName: source.relPath,
        toNodeId: makeFileNodeId(testFile.relPath),
        toNodeType: "file",
        toPath: testFile.relPath,
        toName: testFile.relPath,
        relationType: "file_related_test",
        metadata: { derived: "stem-match", stem: source.stem },
      });
    }
  }
}

function buildGraphSummary(db) {
  const edgeCount = Number(db.prepare("SELECT COUNT(*) AS c FROM relations").get()?.c || 0);
  const relationTypes = db
    .prepare(`
      SELECT relation_type, COUNT(*) AS c
      FROM relations
      GROUP BY relation_type
      ORDER BY c DESC, relation_type ASC
    `)
    .all()
    .map((row) => ({
      relationType: row.relation_type,
      count: Number(row.c || 0),
    }));
  const fileCount = Number(db.prepare("SELECT COUNT(*) AS c FROM files").get()?.c || 0);
  const symbolCount = Number(db.prepare("SELECT COUNT(*) AS c FROM symbols").get()?.c || 0);
  return {
    nodeCount: fileCount + symbolCount + (fileCount > 0 ? 1 : 0),
    edgeCount,
    relationTypes,
  };
}

function rebuildContextRelations(db, rootDir, files = []) {
  const repoNodeId = makeRepoNodeId(rootDir);
  const filePathSet = new Set((Array.isArray(files) ? files : []).map((file) => String(file.relPath || "")));
  const symbolRows = db
    .prepare("SELECT path, name, kind, line, signature, parser FROM symbols ORDER BY path ASC, line ASC")
    .all();
  const insertRelation = db.prepare(`
    INSERT OR REPLACE INTO relations (
      edge_id, from_node_id, from_node_type, from_path, from_name,
      to_node_id, to_node_type, to_path, to_name, relation_type,
      line, weight, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.prepare("DELETE FROM relations").run();

  const relationCounts = new Map();
  const addRelation = (relation) => {
    const normalized = createRelation(relation);
    insertRelation.run(
      normalized.edgeId,
      normalized.fromNodeId,
      normalized.fromNodeType,
      normalized.fromPath,
      normalized.fromName,
      normalized.toNodeId,
      normalized.toNodeType,
      normalized.toPath,
      normalized.toName,
      normalized.relationType,
      normalized.line,
      normalized.weight,
      JSON.stringify(normalized.metadata || null),
    );
    relationCounts.set(
      normalized.relationType,
      Number(relationCounts.get(normalized.relationType) || 0) + 1,
    );
  };

  for (const file of files) {
    addRelation({
      fromNodeId: repoNodeId,
      fromNodeType: "repo",
      fromPath: null,
      fromName: rootDir,
      toNodeId: makeFileNodeId(file.relPath),
      toNodeType: "file",
      toPath: file.relPath,
      toName: file.relPath,
      relationType: "repo_contains_file",
    });
  }

  for (const symbol of symbolRows) {
    const symbolNodeId = makeSymbolNodeId(symbol);
    addRelation({
      fromNodeId: makeFileNodeId(symbol.path),
      fromNodeType: "file",
      fromPath: symbol.path,
      fromName: symbol.path,
      toNodeId: symbolNodeId,
      toNodeType: "symbol",
      toPath: symbol.path,
      toName: symbol.name,
      relationType: "file_defines_symbol",
      line: symbol.line,
      metadata: { kind: symbol.kind, signature: symbol.signature, parser: symbol.parser },
    });
    addRelation({
      fromNodeId: symbolNodeId,
      fromNodeType: "symbol",
      fromPath: symbol.path,
      fromName: symbol.name,
      toNodeId: makeFileNodeId(symbol.path),
      toNodeType: "file",
      toPath: symbol.path,
      toName: symbol.path,
      relationType: "symbol_declared_in_file",
      line: symbol.line,
      metadata: { kind: symbol.kind, signature: symbol.signature, parser: symbol.parser },
    });
  }

  for (const file of files) {
    const imports = extractImportTargets(file.relPath, file.language, file.content);
    for (const imported of imports) {
      const targetPath = resolveImportTarget(file.relPath, file.language, imported.spec, filePathSet);
      if (!targetPath) continue;
      addRelation({
        fromNodeId: makeFileNodeId(file.relPath),
        fromNodeType: "file",
        fromPath: file.relPath,
        fromName: file.relPath,
        toNodeId: makeFileNodeId(targetPath),
        toNodeType: "file",
        toPath: targetPath,
        toName: targetPath,
        relationType: "file_imports_file",
        line: imported.line,
        metadata: { spec: imported.spec, kind: imported.kind, language: file.language },
      });
    }
  }

  addDerivedTestRelations(files, addRelation);

  return {
    nodeCount: Number(files.length || 0) + Number(symbolRows.length || 0) + (files.length > 0 ? 1 : 0),
    edgeCount: Array.from(relationCounts.values()).reduce((sum, value) => sum + value, 0),
    relationTypes: Array.from(relationCounts.entries())
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([relationType, count]) => ({ relationType, count })),
  };
}

function collectSourceFiles(rootDir, options, generatedPaths = {}) {
  const includeTests = options.includeTests !== false;
  const maxFileBytes = Number(options.maxFileBytes || 800000);

  const files = [];

  function walk(absDir) {
    let entries = [];
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absPath = resolve(absDir, entry.name);
      const relPath = relative(rootDir, absPath).replaceAll("\\", "/");

      if (entry.isDirectory()) {
        if (shouldSkipDir(absPath, relPath, generatedPaths)) continue;
        walk(absPath);
        continue;
      }

      if (!entry.isFile()) continue;

      const extension = extname(entry.name).toLowerCase();
      if (BINARY_EXTENSIONS.has(extension)) continue;
      if (!INCLUDED_EXTENSIONS.has(extension)) continue;
      if (!includeTests && shouldSkipTestPath(relPath)) continue;

      let stat;
      try {
        stat = statSync(absPath);
      } catch {
        continue;
      }

      if (!stat.isFile()) continue;
      if (stat.size > maxFileBytes) continue;

      let buffer;
      try {
        buffer = readFileSync(absPath);
      } catch {
        continue;
      }

      const content = buffer.toString("utf8");
      const hash = createHash("sha256").update(buffer).digest("hex");
      const language = detectLanguage(relPath);
      const summary = extractSummary(content);

      files.push({
        absPath,
        relPath,
        hash,
        size: stat.size,
        mtimeMs: Math.round(stat.mtimeMs),
        language,
        summary,
        content,
      });
    }
  }

  walk(rootDir);
  return files;
}

function sanitizeDocName(relPath) {
  return `${relPath.replace(/[\\/]/g, "__").replace(/[^A-Za-z0-9._-]/g, "_")}.md`;
}

function writeFileDocs(db, docsPath) {
  rmSync(docsPath, { recursive: true, force: true });
  mkdirSync(docsPath, { recursive: true });

  const files = db
    .prepare("SELECT path, language, summary FROM files ORDER BY path ASC")
    .all();

  const symbolsStmt = db.prepare(
    "SELECT name, kind, line, signature FROM symbols WHERE path = ? ORDER BY line ASC LIMIT 20",
  );

  for (const file of files) {
    const symbols = symbolsStmt.all(file.path);
    const markdown = [
      `# ${file.path}`,
      "",
      `- Language: ${file.language || "unknown"}`,
      `- Summary: ${file.summary || "(none)"}`,
      "",
      "## Top Symbols",
      "",
      ...(symbols.length > 0
        ? symbols.map((s) => `- ${s.name} (${s.kind || "symbol"}) — line ${s.line || 1}${s.signature ? ` — ${String(s.signature).replace(/\s+/g, " ").trim()}` : ""}`)
        : ["- (none)"]),
      "",
    ].join("\n");

    writeFileSync(resolve(docsPath, sanitizeDocName(file.path)), markdown, "utf8");
  }
}

function writeAgentIndexMarkdown(db, rootDir, indexDir) {
  const fileCount = db.prepare("SELECT COUNT(*) AS c FROM files").get()?.c || 0;
  const symbolCount = db.prepare("SELECT COUNT(*) AS c FROM symbols").get()?.c || 0;
  const graph = buildGraphSummary(db);
  const byLanguage = db
    .prepare("SELECT language, COUNT(*) AS c FROM files GROUP BY language ORDER BY c DESC, language ASC")
    .all();

  const sections = [
    "# Bosun Agent Index",
    "",
    `- Root: ${rootDir}`,
    `- Generated: ${new Date().toISOString()}`,
    `- Files indexed: ${fileCount}`,
    `- Symbols indexed: ${symbolCount}`,
    `- Graph nodes: ${graph.nodeCount}`,
    `- Graph edges: ${graph.edgeCount}`,
    "",
    "## Files by Language",
    "",
  ];

  for (const row of byLanguage) {
    sections.push(`### ${row.language || "unknown"} (${row.c})`);
    const files = db
      .prepare("SELECT path FROM files WHERE language = ? ORDER BY path ASC LIMIT 20")
      .all(row.language);
    for (const file of files) {
      sections.push(`- ${file.path}`);
    }
    sections.push("");
  }

  sections.push("## Search Tips");
  sections.push("");
  sections.push("- CLI run: `node cli.mjs --context-index run`");
  sections.push("- CLI status: `node cli.mjs --context-index status`");
  sections.push("- CLI search: `node cli.mjs --context-index search --context-index-query \"your query\"`");
  sections.push("- CLI graph: `node cli.mjs --context-index graph --context-index-query \"your query\"`");
  sections.push("- Programmatic: `searchContextIndex(\"query\", { rootDir, limit: 25 })`");
  sections.push("");

  writeFileSync(resolve(indexDir, "AGENT_INDEX.md"), sections.join("\n"), "utf8");
}

function writeAgentIndexJson(db, indexDir, rootDir) {
  const files = db
    .prepare("SELECT path, hash, size, mtime_ms, language, summary, updated_at FROM files ORDER BY path ASC")
    .all();
  const symbols = db
    .prepare("SELECT path, name, kind, line, signature, parser FROM symbols ORDER BY path ASC, line ASC")
    .all();
  const relations = db
    .prepare(`
      SELECT edge_id, from_node_id, from_node_type, from_path, from_name,
             to_node_id, to_node_type, to_path, to_name, relation_type,
             line, weight, metadata_json
      FROM relations
      ORDER BY relation_type ASC, edge_id ASC
    `)
    .all()
    .map((row) => ({
      edgeId: row.edge_id,
      fromNodeId: row.from_node_id,
      fromNodeType: row.from_node_type,
      fromPath: row.from_path || null,
      fromName: row.from_name || null,
      toNodeId: row.to_node_id,
      toNodeType: row.to_node_type,
      toPath: row.to_path || null,
      toName: row.to_name || null,
      relationType: row.relation_type,
      line: Number.isFinite(Number(row.line)) ? Number(row.line) : null,
      weight: Number.isFinite(Number(row.weight)) ? Number(row.weight) : 1,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
    }));

  const payload = {
    generatedAt: new Date().toISOString(),
    rootDir,
    fileCount: files.length,
    symbolCount: symbols.length,
    graph: buildGraphSummary(db),
    files,
    symbols,
    relations,
  };

  writeFileSync(resolve(indexDir, "agent-index.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function ensureZoektAvailability() {
  if (zoektAvailability) return zoektAvailability;

  const commands = process.platform === "win32"
    ? ["zoekt-index.exe", "zoekt-index"]
    : ["zoekt-index"];

  for (const command of commands) {
    const check = spawnSync(command, ["--help"], {
      encoding: "utf8",
      stdio: "pipe",
    });
    if (check.status === 0) {
      zoektAvailability = { available: true, command };
      return zoektAvailability;
    }
  }

  zoektAvailability = { available: false, command: null };
  return zoektAvailability;
}

function runZoektIndex(rootDir, zoektPath, enabled) {
  if (!enabled) {
    return {
      enabled: false,
      available: false,
      success: false,
      command: null,
      message: "Zoekt indexing disabled",
    };
  }

  const availability = ensureZoektAvailability();
  if (!availability.available || !availability.command) {
    return {
      enabled: true,
      available: false,
      success: false,
      command: null,
      message: "zoekt-index binary not found",
    };
  }

  mkdirSync(zoektPath, { recursive: true });
  try {
    const output = execFileSync(
      availability.command,
      ["-index", zoektPath, rootDir],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return {
      enabled: true,
      available: true,
      success: true,
      command: availability.command,
      indexPath: zoektPath,
      message: String(output || "").trim() || "Zoekt index completed",
    };
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr).trim() : "";
    const stdout = error?.stdout ? String(error.stdout).trim() : "";
    const message = stderr || stdout || error?.message || "Zoekt index failed";
    return {
      enabled: true,
      available: true,
      success: false,
      command: availability.command,
      indexPath: zoektPath,
      message,
    };
  }
}

export async function runContextIndex(opts = {}) {
  const {
    rootDir = process.cwd(),
    includeTests = true,
    maxFileBytes = 800000,
    useTreeSitter = true,
    useZoekt = true,
  } = opts;

  const { db, paths } = await openDb(rootDir);

  try {
    const scannedFiles = collectSourceFiles(paths.rootDir, { includeTests, maxFileBytes }, paths);

    const existingRows = db
      .prepare("SELECT path, hash FROM files")
      .all();
    const existingByPath = new Map(existingRows.map((row) => [row.path, row]));
    const scannedByPath = new Map(scannedFiles.map((row) => [row.relPath, row]));

    const changed = [];
    const removed = [];

    for (const row of scannedFiles) {
      const existing = existingByPath.get(row.relPath);
      if (!existing || existing.hash !== row.hash) {
        changed.push(row);
      }
    }

    for (const row of existingRows) {
      if (!scannedByPath.has(row.path)) {
        removed.push(row.path);
      }
    }

    const nowIso = new Date().toISOString();
    const parserUsage = { "tree-sitter": 0, heuristic: 0 };

    db.exec("BEGIN");
    try {
      const deleteSymbolsForPath = db.prepare("DELETE FROM symbols WHERE path = ?");
      const deleteFileForPath = db.prepare("DELETE FROM files WHERE path = ?");
      const upsertFile = db.prepare(`
        INSERT INTO files (path, hash, size, mtime_ms, language, summary, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          hash = excluded.hash,
          size = excluded.size,
          mtime_ms = excluded.mtime_ms,
          language = excluded.language,
          summary = excluded.summary,
          updated_at = excluded.updated_at
      `);
      const insertSymbol = db.prepare(`
        INSERT INTO symbols (path, name, kind, line, signature, parser)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const path of removed) {
        deleteSymbolsForPath.run(path);
        deleteFileForPath.run(path);
      }

      for (const file of changed) {
        upsertFile.run(
          file.relPath,
          file.hash,
          file.size,
          file.mtimeMs,
          file.language,
          file.summary,
          nowIso,
        );

        deleteSymbolsForPath.run(file.relPath);
        const symbols = await extractSymbolsForFile(
          file.absPath,
          file.language,
          file.content,
          useTreeSitter,
        );

        for (const symbol of symbols) {
          insertSymbol.run(
            file.relPath,
            symbol.name,
            symbol.kind || "symbol",
            Number(symbol.line || 1),
            symbol.signature || "",
            symbol.parser || "heuristic",
          );
          if (symbol.parser === "tree-sitter") {
            parserUsage["tree-sitter"] += 1;
          } else {
            parserUsage.heuristic += 1;
          }
        }
      }

      setMeta(db, "last_indexed_at", nowIso);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    const graph = rebuildContextRelations(db, paths.rootDir, scannedFiles);
    setMeta(db, "graph_status", JSON.stringify(graph));

    const zoekt = runZoektIndex(paths.rootDir, paths.zoektPath, useZoekt !== false);
    setMeta(db, "zoekt_status", JSON.stringify(zoekt));

    writeFileDocs(db, paths.docsPath);
    writeAgentIndexMarkdown(db, paths.rootDir, paths.indexDir);
    writeAgentIndexJson(db, paths.indexDir, paths.rootDir);

    const symbolCount = db.prepare("SELECT COUNT(*) AS c FROM symbols").get()?.c || 0;

    return {
      indexedFiles: scannedFiles.length,
      changedFiles: changed.length,
      removedFiles: removed.length,
      symbolCount,
      graph,
      parserUsage,
      dbPath: paths.dbPath,
      docsPath: paths.docsPath,
      zoekt,
    };
  } finally {
    db.close();
  }
}

function escapeLikePattern(value) {
  return String(value).replace(/([%_\\])/g, "\\$1");
}

function normalizeTaskType(input) {
  const raw = String(input || "auto").trim().toLowerCase();
  if (!raw) return "auto";
  return TASK_TYPE_ALIASES[raw] || "auto";
}

function inferTaskTypeFromQuery(query) {
  const q = String(query || "").toLowerCase();
  if (!q) return "auto";
  if (/\b(ci|cd|pipeline|workflow|github actions|jenkins|buildkite|gitlab)\b/.test(q)) return "ci-cd";
  if (/\b(frontend|front-end|ui|component|css|html|react|preact|mui|tailwind)\b/.test(q)) return "frontend";
  if (/\b(api|backend|server|endpoint|handler|controller|database|sql|orm)\b/.test(q)) return "backend";
  if (/\b(infra|terraform|kubernetes|k8s|helm|docker|deployment|devops)\b/.test(q)) return "infra";
  if (/\b(doc|docs|documentation|readme|guide|changelog|adr|spec)\b/.test(q)) return "docs";
  if (/\b(security|auth|oauth|jwt|secret|credential|permission|rbac|vuln)\b/.test(q)) return "security";
  return "auto";
}

function computeScopeBoost(pathValue, languageValue, scope) {
  if (!scope) return 0;
  const normalizedPath = String(pathValue || "").toLowerCase();
  const normalizedLanguage = String(languageValue || "").toLowerCase();

  let boost = 0;
  for (const fragment of scope.includePathFragments || []) {
    if (normalizedPath.includes(String(fragment).toLowerCase())) {
      boost += 25;
    }
  }
  for (const language of scope.includeLanguages || []) {
    if (normalizedLanguage === String(language).toLowerCase()) {
      boost += 12;
      break;
    }
  }
  return boost;
}

export async function searchContextIndex(query, opts = {}) {
  const rootDir = opts.rootDir || process.cwd();
  const limit = Math.max(1, Number(opts.limit || 25));
  const fallbackToGlobal = opts.fallbackToGlobal !== false;
  const includeMeta = opts.includeMeta === true;
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery) return [];

  const requestedTaskType = normalizeTaskType(opts.taskType || "auto");
  const inferredTaskType = inferTaskTypeFromQuery(normalizedQuery);
  const resolvedTaskType = requestedTaskType === "auto" ? inferredTaskType : requestedTaskType;
  const scope = TASK_TYPE_SCOPES[resolvedTaskType] || null;

  const { db } = await openDb(rootDir);
  try {
    const pattern = `%${escapeLikePattern(normalizedQuery)}%`;
    const lower = normalizedQuery.toLowerCase();

    const fileRows = db
      .prepare(`
        SELECT path, language, summary
        FROM files
        WHERE path LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\'
        LIMIT ?
      `)
      .all(pattern, pattern, limit * 2);

    const symbolRows = db
      .prepare(`
        SELECT path, name, kind, line, signature, parser
        FROM symbols
        WHERE name LIKE ? ESCAPE '\\' OR signature LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\'
        LIMIT ?
      `)
      .all(pattern, pattern, pattern, limit * 3);

    const merged = [];

    for (const row of fileRows) {
      let score = 0;
      const path = String(row.path || "").toLowerCase();
      const summary = String(row.summary || "").toLowerCase();
      if (path.includes(lower)) score += 30;
      if (summary.includes(lower)) score += 15;
      const scopeBoost = computeScopeBoost(row.path, row.language, scope);
      score += scopeBoost;
      merged.push({
        type: "file",
        path: row.path,
        language: row.language,
        summary: row.summary,
        score,
        _scopeBoost: scopeBoost,
      });
    }

    for (const row of symbolRows) {
      let score = 0;
      const name = String(row.name || "").toLowerCase();
      const signature = String(row.signature || "").toLowerCase();
      const path = String(row.path || "").toLowerCase();
      if (name.includes(lower)) score += 45;
      if (signature.includes(lower)) score += 25;
      if (path.includes(lower)) score += 10;
      const scopeBoost = computeScopeBoost(row.path, null, scope);
      score += scopeBoost;
      merged.push({
        type: "symbol",
        path: row.path,
        name: row.name,
        kind: row.kind,
        line: row.line,
        signature: row.signature,
        parser: row.parser,
        score,
        _scopeBoost: scopeBoost,
      });
    }

    merged.sort((a, b) => b.score - a.score);
    const scopedOnly = merged.filter((item) => Number(item._scopeBoost || 0) > 0);
    const scopedStrongEnough = Boolean(scope) && scopedOnly.length > 0;

    let selected;
    let fallbackUsed = false;
    if (scopedStrongEnough) {
      selected = scopedOnly.slice(0, limit);
    } else if (scope && !fallbackToGlobal) {
      selected = scopedOnly.slice(0, limit);
    } else {
      selected = merged.slice(0, limit);
      fallbackUsed = Boolean(scope) && !scopedStrongEnough;
    }

    const cleaned = selected.map(({ _scopeBoost, ...rest }) => rest);
    if (includeMeta) {
      return {
        taskTypeRequested: requestedTaskType,
        taskTypeInferred: inferredTaskType,
        taskTypeUsed: resolvedTaskType,
        scopedResultCount: scopedOnly.length,
        fallbackUsed,
        results: cleaned,
      };
    }

    return cleaned;
  } finally {
    db.close();
  }
}

export async function ensureContextIndexFresh(opts = {}) {
  const rootDir = opts.rootDir || process.cwd();
  const maxAgeMs = resolveContextIndexMaxAgeMs(
    opts.maxAgeMs
    ?? process.env.BOSUN_CONTEXT_INDEX_MAX_AGE_MS,
  );
  const changedFiles = normalizeContextIndexPathHints(
    opts.changedFiles || opts.relatedPaths || [],
    rootDir,
  );
  const force = opts.force === true;
  const status = await getContextIndexStatus({
    rootDir,
    includeTests: opts.includeTests,
    maxFileBytes: opts.maxFileBytes,
    maxAgeMs,
  });
  const lastIndexedAt = String(status?.lastIndexedAt || "");
  const lastIndexedMs = Date.parse(lastIndexedAt);
  const missing = status?.ready !== true;
  const staleByAge = status?.staleBecauseAge === true
    || (
      !missing
      && maxAgeMs >= 0
      && (!Number.isFinite(lastIndexedMs) || (Date.now() - lastIndexedMs) > maxAgeMs)
    );
  const staleByWorkspace = status?.staleBecauseWorkspaceChanged === true;
  const staleByChangedFiles = changedFiles.length > 0
    ? haveHintedFilesChangedSince(rootDir, changedFiles, lastIndexedAt)
    : false;

  if (!force && !missing && !staleByAge && !staleByWorkspace && !staleByChangedFiles) {
    return {
      refreshed: false,
      reason: "fresh",
      rootDir: resolve(rootDir),
      status,
    };
  }

  const result = await runContextIndex({
    rootDir,
    includeTests: opts.includeTests,
    maxFileBytes: opts.maxFileBytes,
    useTreeSitter: opts.useTreeSitter,
    useZoekt: opts.useZoekt,
  });
  const nextStatus = await getContextIndexStatus({ rootDir });
  return {
    refreshed: true,
    reason: force
      ? "forced"
      : missing
        ? "missing"
        : staleByChangedFiles
          ? "changed-files"
          : staleByWorkspace
            ? "workspace-changed"
          : "stale",
    rootDir: resolve(rootDir),
    result,
    status: nextStatus,
  };
}

function mapRelationRow(row) {
  return {
    edgeId: row.edge_id,
    fromNodeId: row.from_node_id,
    fromNodeType: row.from_node_type,
    fromPath: row.from_path || null,
    fromName: row.from_name || null,
    toNodeId: row.to_node_id,
    toNodeType: row.to_node_type,
    toPath: row.to_path || null,
    toName: row.to_name || null,
    relationType: row.relation_type,
    line: Number.isFinite(Number(row.line)) ? Number(row.line) : null,
    weight: Number.isFinite(Number(row.weight)) ? Number(row.weight) : 1,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
  };
}

function normalizeGraphPath(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function normalizeIndexedFilePath(filePath, rootDir) {
  const [normalized] = normalizeContextIndexPathHints(filePath, rootDir);
  return normalizeGraphPath(normalized || "");
}

function dedupeNormalizedPaths(values = [], limit = Infinity) {
  const deduped = [];
  const seen = new Set();
  for (const value of values) {
    const normalized = normalizeGraphPath(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
    if (deduped.length >= limit) break;
  }
  return deduped;
}

function mapSymbolDetailRow(row = {}) {
  return {
    name: String(row.name || "").trim(),
    kind: String(row.kind || "symbol").trim() || "symbol",
    line: Number.isFinite(Number(row.line)) ? Number(row.line) : 1,
    signature: String(row.signature || "").trim(),
    parser: String(row.parser || "heuristic").trim() || "heuristic",
  };
}

function buildEffectiveFileSummary(fileRow = {}, symbols = []) {
  const summary = String(fileRow.summary || "").trim();
  if (summary) return summary;
  const symbolNames = dedupeNormalizedPaths(
    (Array.isArray(symbols) ? symbols : []).map((symbol) => symbol?.name || ""),
    3,
  );
  if (symbolNames.length === 0) return "";
  return `Defines ${symbolNames.join(", ")}`;
}

export async function getContextFileInsights(filePath, opts = {}) {
  const rootDir = opts.rootDir || process.cwd();
  const normalizedPath = normalizeIndexedFilePath(filePath, rootDir);
  if (!normalizedPath) return null;

  const symbolLimit = Math.max(1, Number(opts.symbolLimit || DEFAULT_CONTEXT_FILE_SYMBOL_LIMIT));
  const relationLimit = Math.max(1, Number(opts.relationLimit || DEFAULT_CONTEXT_FILE_RELATION_LIMIT));
  const { db } = await openDb(rootDir);

  try {
    const fileRow = db.prepare(`
      SELECT path, language, summary, size, mtime_ms, hash
      FROM files
      WHERE path = ?
    `).get(normalizedPath);
    if (!fileRow) return null;

    const symbols = db.prepare(`
      SELECT name, kind, line, signature, parser
      FROM symbols
      WHERE path = ?
      ORDER BY line ASC, name ASC
      LIMIT ?
    `).all(normalizedPath, symbolLimit).map((row) => mapSymbolDetailRow(row));

    const imports = dedupeNormalizedPaths(
      db.prepare(`
        SELECT to_path AS path
        FROM relations
        WHERE relation_type = 'file_imports_file'
          AND from_path = ?
        ORDER BY to_path ASC
        LIMIT ?
      `).all(normalizedPath, relationLimit * 2).map((row) => row.path),
      relationLimit,
    );

    const importedBy = dedupeNormalizedPaths(
      db.prepare(`
        SELECT from_path AS path
        FROM relations
        WHERE relation_type = 'file_imports_file'
          AND to_path = ?
        ORDER BY from_path ASC
        LIMIT ?
      `).all(normalizedPath, relationLimit * 2).map((row) => row.path),
      relationLimit,
    );

    const relatedTests = dedupeNormalizedPaths(
      db.prepare(`
        SELECT from_path AS fromPath, to_path AS toPath
        FROM relations
        WHERE relation_type = 'file_related_test'
          AND (from_path = ? OR to_path = ?)
        ORDER BY edge_id ASC
        LIMIT ?
      `).all(normalizedPath, normalizedPath, relationLimit * 2).map((row) => (
        normalizeGraphPath(row.fromPath) === normalizedPath ? row.toPath : row.fromPath
      )),
      relationLimit,
    );

    return {
      path: normalizeGraphPath(fileRow.path),
      language: String(fileRow.language || "unknown").trim() || "unknown",
      summary: buildEffectiveFileSummary(fileRow, symbols),
      size: Number.isFinite(Number(fileRow.size)) ? Number(fileRow.size) : null,
      mtimeMs: Number.isFinite(Number(fileRow.mtime_ms)) ? Number(fileRow.mtime_ms) : null,
      hash: String(fileRow.hash || "").trim() || null,
      symbols,
      imports,
      importedBy,
      relatedTests,
      relatedFiles: dedupeNormalizedPaths([
        ...imports,
        ...importedBy,
        ...relatedTests,
      ], relationLimit * 3),
      source: "context-index-db",
    };
  } finally {
    db.close();
  }
}

export async function getContextPathAdjacency(paths = [], opts = {}) {
  const rootDir = opts.rootDir || process.cwd();
  const normalizedPaths = [...new Set(
    (Array.isArray(paths) ? paths : [paths])
      .map((value) => normalizeGraphPath(value))
      .filter(Boolean),
  )];
  if (normalizedPaths.length === 0) return new Map();
  const relationTypes = [...new Set(
    (Array.isArray(opts.relationTypes) ? opts.relationTypes : ["file_imports_file"])
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  )];
  if (relationTypes.length === 0) return new Map();

  const { db } = await openDb(rootDir);
  try {
    const typePlaceholders = relationTypes.map(() => "?").join(", ");
    const pathPlaceholders = normalizedPaths.map(() => "?").join(", ");
    const rows = db.prepare(`
      SELECT *
      FROM relations
      WHERE relation_type IN (${typePlaceholders})
        AND (
          from_path IN (${pathPlaceholders})
          OR to_path IN (${pathPlaceholders})
        )
      ORDER BY relation_type ASC, edge_id ASC
    `).all(...relationTypes, ...normalizedPaths, ...normalizedPaths);
    const adjacency = new Map();
    const addEdge = (fromPath, toPath) => {
      const from = normalizeGraphPath(fromPath);
      const to = normalizeGraphPath(toPath);
      if (!from || !to || from === to) return;
      if (!adjacency.has(from)) adjacency.set(from, new Set());
      adjacency.get(from).add(to);
    };
    for (const row of rows) {
      const relation = mapRelationRow(row);
      addEdge(relation.fromPath, relation.toPath);
      addEdge(relation.toPath, relation.fromPath);
    }
    return adjacency;
  } finally {
    db.close();
  }
}

function buildGraphNode(nodeId, nodeType, details = {}, seeded = false) {
  return {
    id: nodeId,
    type: nodeType,
    path: details.path || null,
    name: details.name || null,
    kind: details.kind || null,
    line: Number.isFinite(Number(details.line)) ? Number(details.line) : null,
    summary: details.summary || null,
    language: details.language || null,
    seeded,
  };
}

export async function getContextGraph(query, opts = {}) {
  const rootDir = opts.rootDir || process.cwd();
  const limit = Math.max(1, Number(opts.limit || 25));
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery) {
    return {
      query: "",
      nodes: [],
      edges: [],
      graph: { nodeCount: 0, edgeCount: 0, relationTypes: [] },
    };
  }

  const { db } = await openDb(rootDir);
  try {
    const pattern = `%${escapeLikePattern(normalizedQuery)}%`;
    const seedFiles = db.prepare(`
      SELECT path, language, summary
      FROM files
      WHERE path LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\'
      ORDER BY path ASC
      LIMIT ?
    `).all(pattern, pattern, limit);
    const seedSymbols = db.prepare(`
      SELECT path, name, kind, line, signature, parser
      FROM symbols
      WHERE name LIKE ? ESCAPE '\\' OR signature LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\'
      ORDER BY path ASC, line ASC
      LIMIT ?
    `).all(pattern, pattern, pattern, limit * 2);

    const seedNodeIds = new Set();
    const seedPaths = new Set();
    const nodes = new Map();

    for (const file of seedFiles) {
      const nodeId = makeFileNodeId(file.path);
      seedNodeIds.add(nodeId);
      seedPaths.add(file.path);
      nodes.set(nodeId, buildGraphNode(nodeId, "file", file, true));
    }
    for (const symbol of seedSymbols) {
      const nodeId = makeSymbolNodeId(symbol);
      seedNodeIds.add(nodeId);
      seedPaths.add(symbol.path);
      nodes.set(nodeId, buildGraphNode(nodeId, "symbol", symbol, true));
      const fileNodeId = makeFileNodeId(symbol.path);
      if (!nodes.has(fileNodeId)) {
        nodes.set(fileNodeId, buildGraphNode(fileNodeId, "file", { path: symbol.path }, true));
      } else {
        nodes.get(fileNodeId).seeded = true;
      }
    }

    if (seedNodeIds.size === 0 && seedPaths.size === 0) {
      return {
        query: normalizedQuery,
        nodes: [],
        edges: [],
        graph: buildGraphSummary(db),
      };
    }

    const relationRows = db.prepare("SELECT * FROM relations ORDER BY relation_type ASC, edge_id ASC").all();
    const matchedEdges = [];
    for (const row of relationRows) {
      const relation = mapRelationRow(row);
      const touchesSeed =
        seedNodeIds.has(relation.fromNodeId)
        || seedNodeIds.has(relation.toNodeId)
        || (relation.fromPath && seedPaths.has(relation.fromPath))
        || (relation.toPath && seedPaths.has(relation.toPath));
      if (!touchesSeed) continue;
      matchedEdges.push(relation);
      if (!nodes.has(relation.fromNodeId)) {
        nodes.set(relation.fromNodeId, buildGraphNode(relation.fromNodeId, relation.fromNodeType, {
          path: relation.fromPath,
          name: relation.fromName,
        }));
      }
      if (!nodes.has(relation.toNodeId)) {
        nodes.set(relation.toNodeId, buildGraphNode(relation.toNodeId, relation.toNodeType, {
          path: relation.toPath,
          name: relation.toName,
        }));
      }
    }

    return {
      query: normalizedQuery,
      nodes: Array.from(nodes.values()),
      edges: matchedEdges,
      graph: buildGraphSummary(db),
    };
  } finally {
    db.close();
  }
}

export async function getContextIndexStatus(opts = {}) {
  const rootDir = opts.rootDir || process.cwd();
  const { db, paths } = await openDb(rootDir);
  try {
    const fileCount = db.prepare("SELECT COUNT(*) AS c FROM files").get()?.c || 0;
    const symbolCount = db.prepare("SELECT COUNT(*) AS c FROM symbols").get()?.c || 0;
    const latestIndexedSourceMtimeMs = Number(
      db.prepare("SELECT MAX(mtime_ms) AS m FROM files").get()?.m ?? NaN,
    );
    const lastIndexedAt = getMeta(db, "last_indexed_at");
    const lastIndexedMs = Date.parse(String(lastIndexedAt || ""));
    const maxAgeMs = resolveContextIndexMaxAgeMs(
      opts.maxAgeMs
      ?? process.env.BOSUN_CONTEXT_INDEX_MAX_AGE_MS,
    );
    const workspaceFreshness = computeWorkspaceSourceFreshness(paths.rootDir, opts);
    const staleSourceBaselineMs = Number.isFinite(latestIndexedSourceMtimeMs)
      ? latestIndexedSourceMtimeMs
      : lastIndexedMs;
    const staleBecauseWorkspaceChanged =
      workspaceFreshness.latestSourceMtimeMs != null
      && Number.isFinite(staleSourceBaselineMs)
      && workspaceFreshness.latestSourceMtimeMs > staleSourceBaselineMs + 1000;
    const staleBecauseAge =
      fileCount > 0
      && maxAgeMs >= 0
      && (!Number.isFinite(lastIndexedMs) || (Date.now() - lastIndexedMs) > maxAgeMs);
    const ready = existsSync(paths.dbPath) && fileCount > 0;
    const staleReasons = [];
    if (!ready) staleReasons.push("missing");
    if (staleBecauseWorkspaceChanged) staleReasons.push("workspace-changed");
    if (staleBecauseAge) staleReasons.push("age");
    let zoekt = null;
    const zoektRaw = getMeta(db, "zoekt_status");
    if (zoektRaw) {
      try {
        zoekt = JSON.parse(zoektRaw);
      } catch {
        zoekt = { message: zoektRaw };
      }
    }

    return {
      ready,
      dbPath: paths.dbPath,
      fileCount,
      symbolCount,
      graph: buildGraphSummary(db),
      lastIndexedAt,
      ageMs: Number.isFinite(lastIndexedMs) ? Math.max(0, Date.now() - lastIndexedMs) : null,
      maxAgeMs,
      sourceFileCount: workspaceFreshness.sourceFileCount,
      latestIndexedSourceMtimeMs: Number.isFinite(latestIndexedSourceMtimeMs)
        ? latestIndexedSourceMtimeMs
        : null,
      latestSourceMtimeMs: workspaceFreshness.latestSourceMtimeMs,
      latestSourcePath: workspaceFreshness.latestSourcePath,
      staleBecauseWorkspaceChanged,
      staleBecauseAge,
      stale: staleReasons.length > 0,
      staleReasons,
      zoekt,
    };
  } finally {
    db.close();
  }
}
