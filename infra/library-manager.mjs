/**
 * library-manager.mjs — Centralized Library for Prompts, Agents & Skills
 *
 * Provides a unified registry that workflows and task executors can reference
 * via `{{prompt:name}}`, `{{agent:name}}`, and `{{skill:name}}` interpolation.
 *
 * Storage layout:
 *   .bosun/agents/       — Prompt markdown files (existing convention)
 *   .bosun/skills/       — Skill markdown files (existing convention)
 *   .bosun/profiles/     — Agent profile JSON files (new)
 *   .bosun/library.json  — Unified manifest (index of all library items)
 *
 * Multi-workspace aware:
 *   Per-workspace overrides are stored under each workspace's root directory,
 *   falling back to the global BOSUN_HOME location.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync, rmSync } from "node:fs";
import { resolve, basename, relative, extname, sep } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { getAgentToolConfig, getEffectiveTools } from "../agent/agent-tool-config.mjs";
import { nowISO, toStringArray, uniqueStrings } from "./library-manager-utils.mjs";
import { evaluateMarkdownSafety, recordMarkdownSafetyAuditEvent } from "../lib/skill-markdown-safety.mjs";
import {
  WELL_KNOWN_AGENT_SOURCES,
  computeWellKnownSourceTrust,
  listWellKnownAgentSources,
  clearWellKnownAgentSourceProbeCache,
  probeWellKnownAgentSources,
} from "./library-manager-well-known-sources.mjs";

// ── Constants ─────────────────────────────────────────────────────────────────

export const LIBRARY_MANIFEST = "library.json";
export const PROMPT_DIR = ".bosun/agents";
export const SKILL_DIR = ".bosun/skills";
export const PROFILE_DIR = ".bosun/profiles";
export const MCP_DIR = ".bosun/mcp-servers";
export const TOOL_DIR = ".bosun/tools";
export const HOOK_DIR = ".bosun/hooks";
export const LIBRARY_INDEX_DIR = ".bosun/library-index";
export const AGENT_PROFILE_INDEX = "agent-profiles.json";
export const SKILL_ENTRY_INDEX = "skills.json";

const UNRESOLVED_TEMPLATE_TOKEN_RE = /\{\{[^{}]+\}\}/;

const agentProfileIndexCache = new Map();
const skillEntryIndexCache = new Map();
const repoContextCache = new Map();

const REPO_CONTEXT_TTL_MS = 120_000;

export function hasUnresolvedTemplateTokens(value) {
  return UNRESOLVED_TEMPLATE_TOKEN_RE.test(String(value || ""));
}

/**
 * Maps file extensions → domain tags used for scoring.
 * Intentionally broad — a single file can belong to multiple domains.
 */
const EXT_DOMAIN_MAP = Object.freeze({
  ".js": ["javascript", "web"],
  ".mjs": ["javascript", "web"],
  ".cjs": ["javascript", "web"],
  ".jsx": ["javascript", "react", "frontend", "web"],
  ".ts": ["typescript", "web"],
  ".tsx": ["typescript", "react", "frontend", "web"],
  ".vue": ["vue", "frontend", "web"],
  ".svelte": ["svelte", "frontend", "web"],
  ".css": ["styling", "frontend", "web"],
  ".scss": ["styling", "frontend", "web"],
  ".less": ["styling", "frontend", "web"],
  ".html": ["frontend", "web"],
  ".py": ["python"],
  ".pyx": ["python"],
  ".go": ["go", "backend"],
  ".rs": ["rust", "systems"],
  ".java": ["java", "backend"],
  ".kt": ["kotlin", "backend"],
  ".cs": ["csharp", "dotnet", "backend"],
  ".fs": ["fsharp", "dotnet", "backend"],
  ".rb": ["ruby", "backend"],
  ".php": ["php", "backend"],
  ".swift": ["swift", "mobile"],
  ".m": ["objc", "mobile"],
  ".dart": ["dart", "flutter", "mobile"],
  ".c": ["c", "systems"],
  ".cpp": ["cpp", "systems"],
  ".h": ["c", "systems"],
  ".hpp": ["cpp", "systems"],
  ".sh": ["shell", "devops"],
  ".bash": ["shell", "devops"],
  ".ps1": ["powershell", "devops"],
  ".sql": ["database", "sql"],
  ".graphql": ["graphql", "api"],
  ".proto": ["protobuf", "api", "grpc"],
  ".yaml": ["config"],
  ".yml": ["config"],
  ".toml": ["config"],
  ".json": ["config"],
  ".xml": ["config"],
  ".tf": ["terraform", "infra", "devops"],
  ".hcl": ["terraform", "infra", "devops"],
  ".dockerfile": ["docker", "infra", "devops"],
  ".md": ["docs"],
  ".mdx": ["docs"],
  ".rst": ["docs"],
});

/**
 * Maps special filenames (case-insensitive) → domain tags.
 */
const FILENAME_DOMAIN_MAP = Object.freeze({
  "dockerfile": ["docker", "infra", "devops"],
  "docker-compose.yml": ["docker", "infra", "devops"],
  "docker-compose.yaml": ["docker", "infra", "devops"],
  "makefile": ["build", "devops"],
  "cmakelists.txt": ["cmake", "build", "cpp"],
  "package.json": ["javascript", "node", "web"],
  "tsconfig.json": ["typescript", "web"],
  "requirements.txt": ["python"],
  "pyproject.toml": ["python"],
  "cargo.toml": ["rust", "systems"],
  "go.mod": ["go", "backend"],
  "gemfile": ["ruby", "backend"],
  "composer.json": ["php", "backend"],
  ".github/workflows": ["ci", "devops", "github"],
  "jenkinsfile": ["ci", "devops"],
  ".gitlab-ci.yml": ["ci", "devops"],
});

/**
 * Maps path segments → domain tags for deeper context.
 */
const PATH_SEGMENT_DOMAINS = Object.freeze({
  test: ["testing"],
  tests: ["testing"],
  __tests__: ["testing"],
  spec: ["testing"],
  e2e: ["testing", "e2e"],
  fixtures: ["testing"],
  src: [],
  lib: [],
  dist: ["build"],
  build: ["build"],
  docs: ["docs"],
  scripts: ["devops", "scripting"],
  infra: ["infra", "devops"],
  deploy: ["infra", "devops"],
  k8s: ["kubernetes", "infra", "devops"],
  migrations: ["database"],
  models: ["backend", "database"],
  api: ["api", "backend"],
  routes: ["api", "backend"],
  controllers: ["api", "backend"],
  middleware: ["backend"],
  components: ["frontend"],
  pages: ["frontend"],
  hooks: ["frontend", "react"],
  styles: ["styling", "frontend"],
  utils: ["utility"],
  helpers: ["utility"],
  config: ["config"],
});

/**
 * Maps detected stack IDs (from detectProjectStack) → skill-relevant tags.
 */
const STACK_DOMAIN_MAP = Object.freeze({
  node: ["javascript", "node", "web"],
  python: ["python"],
  go: ["go", "backend"],
  rust: ["rust", "systems"],
  java: ["java", "backend"],
  dotnet: ["csharp", "dotnet", "backend"],
  ruby: ["ruby", "backend"],
  php: ["php", "backend"],
  make: ["build"],
});

/**
 * Maps detected framework names → skill-relevant tags.
 */
const FRAMEWORK_DOMAIN_MAP = Object.freeze({
  react: ["react", "frontend", "web"],
  nextjs: ["react", "nextjs", "frontend", "web", "ssr"],
  vue: ["vue", "frontend", "web"],
  nuxt: ["vue", "nuxt", "frontend", "web", "ssr"],
  svelte: ["svelte", "frontend", "web"],
  angular: ["angular", "frontend", "web"],
  express: ["express", "backend", "api", "web"],
  fastify: ["fastify", "backend", "api", "web"],
  nestjs: ["nestjs", "backend", "api", "web"],
  electron: ["electron", "desktop"],
  django: ["django", "python", "backend", "web"],
  flask: ["flask", "python", "backend", "api"],
  fastapi: ["fastapi", "python", "backend", "api"],
  pytorch: ["pytorch", "python", "ml", "ai"],
  tensorflow: ["tensorflow", "python", "ml", "ai"],
  spring: ["spring", "java", "backend"],
  rails: ["rails", "ruby", "backend", "web"],
  laravel: ["laravel", "php", "backend", "web"],
  gin: ["gin", "go", "backend", "api"],
  actix: ["actix", "rust", "backend", "api"],
  axum: ["axum", "rust", "backend", "api"],
});

/** Resource types managed by the library */
export const RESOURCE_TYPES = Object.freeze(["prompt", "agent", "skill", "mcp", "custom-tool", "hook"]);
export const AGENT_LIBRARY_CATEGORIES = Object.freeze(["task", "interactive", "voice"]);
export const INTERACTIVE_AGENT_MODES = Object.freeze(["ask", "agent", "plan", "web", "instant", "custom", "voice"]);

export function normalizeAgentProfileType(rawType, options = {}) {
  const value = String(rawType || "").trim().toLowerCase();
  if (value === "voice" || value === "task" || value === "chat") return value;
  if (options?.voiceAgent === true) return "voice";
  return "task";
}

export function normalizeAgentLibraryCategory(rawCategory, options = {}) {
  const value = String(rawCategory || "").trim().toLowerCase();
  if (AGENT_LIBRARY_CATEGORIES.includes(value)) return value;
  const profileType = normalizeAgentProfileType(options?.agentType, { voiceAgent: options?.voiceAgent });
  if (profileType === "voice") return "voice";
  if (profileType === "chat") return "interactive";
  return "task";
}

export function normalizeInteractiveAgentMode(rawMode, options = {}) {
  const value = String(rawMode || "").trim().toLowerCase();
  if (INTERACTIVE_AGENT_MODES.includes(value)) return value;
  if (options?.agentCategory === "voice") return "voice";
  if (options?.agentCategory === "interactive") return "agent";
  return "";
}

export function resolveAgentProfileLibraryMetadata(entry, profile = {}) {
  const agentType = normalizeAgentProfileType(profile?.agentType, {
    voiceAgent: profile?.voiceAgent === true,
  });
  const agentCategory = normalizeAgentLibraryCategory(profile?.agentCategory, {
    agentType,
    voiceAgent: profile?.voiceAgent === true,
  });
  const interactiveMode = normalizeInteractiveAgentMode(
    profile?.interactiveMode || profile?.chatMode,
    { agentCategory },
  );
  const interactiveLabel = String(profile?.interactiveLabel || "").trim();
  const explicitDropdown = profile?.showInChatDropdown;
  const showInChatDropdown = agentCategory === "interactive"
    ? explicitDropdown === true
    : false;
  return {
    agentType,
    agentCategory,
    interactiveMode: interactiveMode || null,
    interactiveLabel: interactiveLabel || null,
    showInChatDropdown,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function getBosunHomeDir() {
  const explicit = process.env.BOSUN_HOME || process.env.BOSUN_DIR;
  if (explicit) return resolve(String(explicit));
  const modernDefault = resolve(homedir(), "bosun");
  if (existsSync(modernDefault)) return modernDefault;
  return resolve(homedir(), ".bosun");
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

function safeReadJson(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function safeWriteJson(filePath, data) {
  ensureDir(resolve(filePath, ".."));
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function getFileMtimeMs(filePath) {
  try {
    return Number(statSync(filePath)?.mtimeMs || 0);
  } catch {
    return 0;
  }
}

// ── Token estimation & similarity utilities ──────────────────────────────────

/**
 * Rough token estimate: ~4 chars per token (GPT-family tokenizers average 3.5–4.5).
 * Fast O(1) — no actual tokenizer needed.
 */
function estimateTokenCount(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

/**
 * Jaccard similarity on word-level unigrams. Returns 0–1.
 * Cheap O(n) — suitable for batch comparisons.
 */
function jaccardSimilarity(a, b) {
  const wordsA = new Set(String(a || "").toLowerCase().split(/\W+/).filter(Boolean));
  const wordsB = new Set(String(b || "").toLowerCase().split(/\W+/).filter(Boolean));
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) if (wordsB.has(w)) intersection++;
  return intersection / (wordsA.size + wordsB.size - intersection);
}

/**
 * Detect potential duplicates between import candidates and existing library entries.
 * Returns a Map<relPath, { existingEntry, similarity, reason }> for candidates that
 * appear to be duplicates of existing entries.
 */
function detectImportDuplicates(candidates, existingEntries) {
  const duplicates = new Map();
  if (!candidates?.length || !existingEntries?.length) return duplicates;

  // Build lookup structures for existing entries
  const existingByName = new Map();
  const existingBySlug = new Map();
  for (const entry of existingEntries) {
    const nameLower = String(entry.name || "").toLowerCase().trim();
    const slug = slugify(entry.name);
    if (nameLower) {
      if (!existingByName.has(nameLower)) existingByName.set(nameLower, []);
      existingByName.get(nameLower).push(entry);
    }
    if (slug) {
      if (!existingBySlug.has(slug)) existingBySlug.set(slug, []);
      existingBySlug.get(slug).push(entry);
    }
  }

  for (const candidate of candidates) {
    const candName = String(candidate.name || "").toLowerCase().trim();
    const candSlug = slugify(candidate.name);
    const candDesc = String(candidate.description || "").toLowerCase().trim();

    // 1. Exact name match
    if (candName && existingByName.has(candName)) {
      const matches = existingByName.get(candName);
      duplicates.set(candidate.relPath, {
        existingEntries: matches.map((e) => ({ id: e.id, name: e.name, type: e.type })),
        similarity: 1.0,
        reason: "exact-name",
      });
      continue;
    }

    // 2. Exact slug match
    if (candSlug && existingBySlug.has(candSlug)) {
      const matches = existingBySlug.get(candSlug);
      duplicates.set(candidate.relPath, {
        existingEntries: matches.map((e) => ({ id: e.id, name: e.name, type: e.type })),
        similarity: 0.95,
        reason: "slug-match",
      });
      continue;
    }

    // 3. High name+description similarity (Jaccard > 0.65)
    let bestSim = 0;
    let bestMatch = null;
    for (const entry of existingEntries) {
      const entryName = String(entry.name || "");
      const entryDesc = String(entry.description || "");
      const nameSim = jaccardSimilarity(candName, entryName);
      const descSim = candDesc && entryDesc ? jaccardSimilarity(candDesc, entryDesc) : 0;
      const combined = nameSim * 0.6 + descSim * 0.4;
      if (combined > bestSim) {
        bestSim = combined;
        bestMatch = entry;
      }
    }
    if (bestSim >= 0.65 && bestMatch) {
      duplicates.set(candidate.relPath, {
        existingEntries: [{ id: bestMatch.id, name: bestMatch.name, type: bestMatch.type }],
        similarity: Math.round(bestSim * 100) / 100,
        reason: "similar-content",
      });
    }
  }

  return duplicates;
}

/**
 * Detect duplicates among candidates themselves (intra-import).
 * Returns a Map<relPath, relPath[]> mapping each candidate to its duplicate peers.
 */
function detectIntraDuplicates(candidates) {
  const groups = new Map();
  if (!candidates?.length) return groups;
  const slugMap = new Map();
  for (const c of candidates) {
    const slug = slugify(c.name);
    if (!slug) continue;
    if (!slugMap.has(slug)) slugMap.set(slug, []);
    slugMap.get(slug).push(c.relPath);
  }
  for (const [, paths] of slugMap) {
    if (paths.length < 2) continue;
    for (const p of paths) {
      groups.set(p, paths.filter((other) => other !== p));
    }
  }
  return groups;
}

function slugify(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function isSafeGitRefName(value) {
  const ref = String(value || "").trim();
  if (!ref) return false;
  if (ref.startsWith("-") || ref.includes("..") || ref.includes("//")) return false;
  if (ref.endsWith("/") || ref.endsWith(".")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref);
}

function isSafeGitRepositorySource(value) {
  const source = String(value || "").trim();
  if (!source) return false;
  if (existsSync(source)) {
    return true;
  }
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+(?:\.git)?$/i.test(source)) {
    return true;
  }
  try {
    const parsed = new URL(source);
    if (!["http:", "https:", "ssh:", "file:"].includes(parsed.protocol)) return false;
    return Boolean(parsed.hostname || parsed.protocol === "file:");
  } catch {
    return false;
  }
}

function keywordTokens(value, { minLength = 3 } = {}) {
  return uniqueStrings(
    String(value || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= minLength),
  );
}

function parseJsonishArray(value) {
  if (Array.isArray(value)) return toStringArray(value);
  const raw = String(value || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw.replace(/'/g, '"'));
    return Array.isArray(parsed) ? toStringArray(parsed) : [];
  } catch {
    return raw
      .split(/[\s,]+/)
      .map((v) => String(v || '').trim())
      .filter(Boolean);
  }
}

function extractConventionalScope(taskTitle = '') {
  const normalized = String(taskTitle || '').toLowerCase();
  if (!normalized) return null;

  let cursor = 0;
  if (normalized.startsWith('[')) {
    const closingBracket = normalized.indexOf(']');
    if (closingBracket > 0) cursor = closingBracket + 1;
  }

  const candidate = normalized.slice(cursor).trimStart();
  const types = ["feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert"];
  for (const type of types) {
    const prefix = type + '(';
    if (!candidate.startsWith(prefix)) continue;
    const closingParen = candidate.indexOf(')', prefix.length);
    if (closingParen <= prefix.length) return null;
    const scope = candidate.slice(prefix.length, closingParen).trim();
    return scope || null;
  }
  return null;
}

function parseMatchEnvNumber(name, fallback) {
  const raw = Number.parseFloat(String(process.env[name] || '').trim());
  return Number.isFinite(raw) ? raw : fallback;
}

function buildTypeIndexRevision(manifest, type) {
  const entries = Array.isArray(manifest?.entries)
    ? manifest.entries.filter((entry) => entry?.type === type)
    : [];
  return entries
    .slice()
    .sort((a, b) => String(a?.id || "").localeCompare(String(b?.id || "")))
    .map((entry) => [entry.id, entry.filename, entry.updatedAt].join(":"))
    .join("|");
}

function buildAgentProfileIndexRevision(manifest) {
  return buildTypeIndexRevision(manifest, "agent");
}

function buildSkillIndexRevision(manifest) {
  return buildTypeIndexRevision(manifest, "skill");
}

function updateIndexCache(cache, rootDir, index, manifestMtimeMs = 0) {
  const cacheKey = resolve(rootDir || getBosunHomeDir());
  const payload = {
    ...index,
    count: Array.isArray(index?.profiles)
      ? index.profiles.length
      : Array.isArray(index?.skills)
        ? index.skills.length
        : Number(index?.count || 0),
  };
  cache.set(cacheKey, {
    manifestMtimeMs: Number(manifestMtimeMs || 0),
    index: payload,
  });
  return payload;
}

function updateAgentProfileIndexCache(rootDir, index, manifestMtimeMs = 0) {
  return updateIndexCache(agentProfileIndexCache, rootDir, index, manifestMtimeMs);
}

function updateSkillEntryIndexCache(rootDir, index, manifestMtimeMs = 0) {
  return updateIndexCache(skillEntryIndexCache, rootDir, index, manifestMtimeMs);
}

function buildIndexedAgentProfile(rootDir, entry) {
  const profile = getEntryContent(rootDir, entry);
  if (!profile || typeof profile !== "object") return null;
  const metadata = resolveAgentProfileLibraryMetadata(entry, profile);
  return {
    ...entry,
    profile,
    ...metadata,
    titlePatterns: toStringArray(profile?.titlePatterns),
    scopes: toStringArray(profile?.scopes),
    tags: uniqueStrings([...(entry?.tags || []), ...toStringArray(profile?.tags)]),
  };
}

function buildIndexedSkillEntry(entry) {
  const tags = uniqueStrings(entry?.tags || []);
  const keywords = keywordTokens(
    [entry?.id, entry?.name, entry?.description, ...tags].filter(Boolean).join(" "),
    { minLength: 3 },
  );
  return {
    ...entry,
    tags,
    keywords,
  };
}

// ── Repo-context signal layer ─────────────────────────────────────────────────

/**
 * Lazily import detectProjectStack to avoid circular dependencies.
 * Falls back gracefully if the module is unavailable.
 * @private - kept for future use when project-detection integration is complete
 */
let _detectProjectStack = null;

/**
 * Build a lightweight repo-context object from the workspace directory.
 * Results are cached per repoRoot with TTL (default 120s).
 *
 * The context is built purely from file-system marker files (package.json,
 * Cargo.toml, etc.) and is designed to complete in <20ms.
 *
 * @param {string} repoRoot
 * @returns {{ languages: string[], frameworks: string[], domains: string[], stacks: string[] }}
 */
export function buildRepoContext(repoRoot) {
  if (!repoRoot) return { languages: [], frameworks: [], domains: [], stacks: [] };
  const key = resolve(repoRoot);
  const cached = repoContextCache.get(key);
  if (cached && (Date.now() - cached.ts) < REPO_CONTEXT_TTL_MS) return cached.ctx;

  const ctx = _scanRepoContextFast(key);
  repoContextCache.set(key, { ts: Date.now(), ctx });
  return ctx;
}

const _STACK_MARKERS = [
  { id: "node", markers: ["package.json"] },
  { id: "python", markers: ["pyproject.toml", "setup.py", "requirements.txt", "Pipfile"] },
  { id: "go", markers: ["go.mod"] },
  { id: "rust", markers: ["Cargo.toml"] },
  { id: "java", markers: ["pom.xml", "build.gradle", "build.gradle.kts"] },
  { id: "dotnet", markers: ["*.csproj", "*.sln"] },
  { id: "ruby", markers: ["Gemfile"] },
  { id: "php", markers: ["composer.json"] },
];

const _FRAMEWORK_MARKERS = {
  node: [
    { file: "package.json", detect: (raw) => {
      const deps = `${raw}`;
      const found = [];
      if (deps.includes('"react"')) found.push("react");
      if (deps.includes('"next"')) found.push("nextjs");
      if (deps.includes('"vue"')) found.push("vue");
      if (deps.includes('"nuxt"')) found.push("nuxt");
      if (deps.includes('"svelte"')) found.push("svelte");
      if (deps.includes('"@angular/core"')) found.push("angular");
      if (deps.includes('"express"')) found.push("express");
      if (deps.includes('"fastify"')) found.push("fastify");
      if (deps.includes('"@nestjs/core"')) found.push("nestjs");
      if (deps.includes('"electron"')) found.push("electron");
      if (deps.includes('"vitest"') || deps.includes('"jest"') || deps.includes('"mocha"')) found.push("testing");
      return found;
    }},
  ],
};

function _scanRepoContextFast(rootDir) {
  const stacks = [];
  const frameworks = [];
  const domains = new Set();

  for (const def of _STACK_MARKERS) {
    const found = def.markers.some((m) => {
      if (m.includes("*")) {
        try {
          return readdirSync(rootDir).some((f) => f.endsWith(m.replace(/\*/g, "")));
        } catch { return false; }
      }
      return existsSync(resolve(rootDir, m));
    });
    if (!found) continue;
    stacks.push(def.id);
    const stackDomains = STACK_DOMAIN_MAP[def.id];
    if (stackDomains) for (const d of stackDomains) domains.add(d);
  }

  for (const stackId of stacks) {
    const fmDetectors = _FRAMEWORK_MARKERS[stackId];
    if (!fmDetectors) continue;
    for (const det of fmDetectors) {
      const fpath = resolve(rootDir, det.file);
      if (!existsSync(fpath)) continue;
      try {
        const raw = readFileSync(fpath, "utf8").slice(0, 8192);
        const found = det.detect(raw);
        for (const fw of found) {
          frameworks.push(fw);
          const fwDomains = FRAMEWORK_DOMAIN_MAP[fw];
          if (fwDomains) for (const d of fwDomains) domains.add(d);
        }
      } catch { /* ignore */ }
    }
  }

  const languages = uniqueStrings(stacks.flatMap((s) => STACK_DOMAIN_MAP[s] || []).filter((d) =>
    !["web", "backend", "systems", "build"].includes(d)));

  return {
    languages: uniqueStrings(languages),
    frameworks: uniqueStrings(frameworks),
    domains: [...domains],
    stacks: uniqueStrings(stacks),
  };
}

/**
 * Infer domain tags from a list of changed file paths.
 * Pure computation — no I/O. Designed for <1ms on typical inputs.
 *
 * @param {string[]} changedFiles
 * @returns {{ fileDomains: string[], fileLanguages: string[], testRelated: boolean }}
 */
export function inferFileContextSignals(changedFiles) {
  const domains = new Set();
  const languages = new Set();
  let testRelated = false;

  for (const filePath of changedFiles) {
    if (!filePath) continue;
    const normalized = String(filePath).replace(/\\/g, "/").toLowerCase();

    // Extension-based domains
    const ext = extname(normalized);
    const extDomains = EXT_DOMAIN_MAP[ext];
    if (extDomains) {
      for (const d of extDomains) domains.add(d);
      if (extDomains[0] && !["config", "docs", "styling", "web"].includes(extDomains[0])) {
        languages.add(extDomains[0]);
      }
    }

    // Filename-based domains (e.g. Dockerfile, Makefile)
    const fname = basename(normalized);
    const fnameDomains = FILENAME_DOMAIN_MAP[fname];
    if (fnameDomains) for (const d of fnameDomains) domains.add(d);

    // Path-segment domains
    const segments = normalized.split("/");
    for (const seg of segments) {
      const segDomains = PATH_SEGMENT_DOMAINS[seg];
      if (segDomains) for (const d of segDomains) domains.add(d);
    }

    // Test detection from filename patterns
    if (/\.(test|spec|e2e)\.[a-z]+$/.test(normalized) || /__(tests|test)__/.test(normalized)) {
      testRelated = true;
      domains.add("testing");
    }
  }

  return {
    fileDomains: [...domains],
    fileLanguages: [...languages],
    testRelated,
  };
}

/**
 * Precompiled regex cache for title patterns to avoid re-compiling on every match.
 */
const compiledRegexCache = new Map();
function getCompiledRegex(pattern) {
  let re = compiledRegexCache.get(pattern);
  if (re !== undefined) return re;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    re = null;
  }
  compiledRegexCache.set(pattern, re);
  return re;
}

function buildSkillSelection(rootDir, best, criteria = {}, opts = {}) {
  const skillIndex = loadSkillEntryIndex(rootDir);
  const indexedSkills = Array.isArray(skillIndex?.skills) ? skillIndex.skills : [];
  const tokenMap = skillIndex?.tokenMap || {};
  const indexedById = new Map(indexedSkills.map((entry) => [entry.id, entry]));
  const profileSkillIds = toStringArray(best?.profile?.skills);
  const titleRaw = String(criteria?.title || "").trim();
  const descRaw = String(criteria?.description || "").trim();
  const textBlob = [titleRaw, descRaw].filter(Boolean).join("\n");

  // Gather repo-context and file-context signals
  const repoCtx = criteria?.repoContext || (criteria?.repoRoot ? buildRepoContext(criteria.repoRoot) : null);
  const changedFiles = toStringArray(criteria?.changedFiles);
  const fileSignals = changedFiles.length > 0 ? inferFileContextSignals(changedFiles) : null;

  const criteriaTags = uniqueStrings([
    ...toStringArray(criteria?.tags),
    ...keywordTokens(textBlob, { minLength: 4 }),
    ...keywordTokens(changedFiles.join(" "), { minLength: 3 }),
    ...(repoCtx ? [...repoCtx.languages, ...repoCtx.frameworks, ...repoCtx.domains] : []),
    ...(fileSignals ? [...fileSignals.fileDomains, ...fileSignals.fileLanguages] : []),
  ]).map((value) => value.toLowerCase());

  const candidateIds = new Set(profileSkillIds);
  for (const tag of criteriaTags) {
    const ids = Array.isArray(tokenMap?.[tag]) ? tokenMap[tag] : [];
    if (ids.length > 128) continue;
    for (const id of ids) candidateIds.add(id);
  }

  // Build domain-relevance set for bonus scoring
  const contextDomains = new Set([
    ...(repoCtx ? [...repoCtx.languages, ...repoCtx.frameworks, ...repoCtx.domains] : []),
    ...(fileSignals ? [...fileSignals.fileDomains, ...fileSignals.fileLanguages] : []),
  ].map((d) => d.toLowerCase()));

  // Precompute title/description words for direct name matching
  const titleWords = new Set(titleRaw.toLowerCase().split(/\W+/).filter((w) => w.length >= 3));
  const descWords = new Set(descRaw.toLowerCase().split(/\W+/).filter((w) => w.length >= 3));

  const scored = [];
  const profileSkillSet = new Set(profileSkillIds.map((value) => value.toLowerCase()));
  const candidateEntries = candidateIds.size > 0
    ? [...candidateIds].map((id) => indexedById.get(id)).filter(Boolean)
    : [];
  for (const skill of candidateEntries) {
    let score = 0;
    const reasons = [];
    if (profileSkillSet.has(String(skill.id || "").toLowerCase())) {
      score += 12;
      reasons.push("profile-skill");
    }

    const haystack = new Set([
      ...skill.tags.map((value) => String(value || "").toLowerCase()),
      ...skill.keywords.map((value) => String(value || "").toLowerCase()),
      String(skill.id || "").toLowerCase(),
    ]);
    const tagHits = criteriaTags.filter((tag) => haystack.has(tag));
    if (tagHits.length > 0) {
      score += Math.min(6, tagHits.length * 2);
      reasons.push(`tags:${tagHits.slice(0, 4).join(",")}`);
    }

    // Signal: repo-context domain overlap → up to +4
    if (contextDomains.size > 0) {
      const domainHits = [...contextDomains].filter((d) => haystack.has(d));
      if (domainHits.length > 0) {
        const domainScore = Math.min(4, domainHits.length);
        score += domainScore;
        reasons.push(`domain:${domainHits.slice(0, 3).join(",")}`);
      }
    }

    // Signal: direct task-title match → up to +8
    // Matches skill name/description words against the task title for high-precision relevance
    if (titleWords.size > 0) {
      const skillNameWords = String(skill.name || "").toLowerCase().split(/\W+/).filter((w) => w.length >= 3);
      const skillDescWords = String(skill.description || "").toLowerCase().split(/\W+/).filter((w) => w.length >= 3);
      let titleHits = 0;
      for (const w of skillNameWords) {
        if (titleWords.has(w)) titleHits += 2;
        else if (descWords.has(w)) titleHits += 1;
      }
      for (const w of skillDescWords) {
        if (titleWords.has(w)) titleHits += 1;
      }
      if (titleHits > 0) {
        const titleScore = Math.min(8, titleHits);
        score += titleScore;
        reasons.push(`title-match:${titleScore}`);
      }
    }

    if (score <= 0) continue;
    scored.push({
      ...skill,
      score,
      reasons,
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });

  const skillTopN = Math.max(1, Number.parseInt(String(opts?.skillTopN ?? criteria?.skillTopN ?? 6), 10) || 6);
  const maxSkillTokens = Number.parseInt(String(opts?.maxSkillTokens ?? criteria?.maxSkillTokens ?? ""), 10) || 0;

  // Select skills: profile skills first, then top-N scored, enforce token budget if set
  let selectedCandidates;
  if (maxSkillTokens > 0) {
    selectedCandidates = [];
    let tokenBudget = maxSkillTokens;
    // Profile skills always included first (they're explicitly assigned)
    for (const skillId of profileSkillIds) {
      const entry = indexedById.get(skillId);
      if (!entry) continue;
      const content = getEntryContent(rootDir, entry);
      const tokens = estimateTokenCount(typeof content === "string" ? content : JSON.stringify(content || ""));
      tokenBudget -= tokens;
      selectedCandidates.push(entry);
    }
    // Then greedily add top-scored skills until budget exhausted
    const profileSet = new Set(profileSkillIds.map((id) => id.toLowerCase()));
    for (const candidate of scored) {
      if (selectedCandidates.length >= skillTopN) break;
      if (tokenBudget <= 0) break;
      if (profileSet.has(String(candidate.id || "").toLowerCase())) continue;
      const content = getEntryContent(rootDir, candidate);
      const tokens = estimateTokenCount(typeof content === "string" ? content : JSON.stringify(content || ""));
      if (tokens > tokenBudget && selectedCandidates.length > 0) continue;
      tokenBudget -= tokens;
      selectedCandidates.push(candidate);
    }
  } else {
    selectedCandidates = scored.slice(0, skillTopN);
  }

  const selectedSkillIds = uniqueStrings([
    ...profileSkillIds,
    ...selectedCandidates.map((entry) => entry.id),
  ]);
  const selectedSkills = selectedSkillIds
    .map((skillId) => scored.find((entry) => entry.id === skillId) || indexedSkills.find((entry) => entry.id === skillId))
    .filter(Boolean);

  return {
    selectedSkillIds,
    selectedSkills,
    candidates: scored.slice(0, Math.max(skillTopN, 20)),
    tokenBudgetUsed: maxSkillTokens > 0 ? maxSkillTokens : undefined,
  };
}

function resolvePromptSelection(rootDir, profile = {}) {
  const promptOverrideId = String(profile?.promptOverride || "").trim();
  if (!promptOverrideId) return null;
  const entry = getEntry(rootDir, promptOverrideId);
  if (!entry) {
    return {
      id: promptOverrideId,
      type: "inline-or-missing",
      name: promptOverrideId,
      description: "Prompt override is inline text or not present in the local library registry.",
    };
  }
  return {
    id: entry.id,
    type: "library-entry",
    name: entry.name,
    description: entry.description,
  };
}

function resolveToolSelection(rootDir, best) {
  const profile = best?.profile || {};
  const profileEnabledTools = toStringArray(profile?.enabledTools);
  const profileEnabledMcpServers = toStringArray(profile?.enabledMcpServers);
  const rawCfg = best?.id
    ? getAgentToolConfig(rootDir, best.id)
    : { enabledTools: null, enabledMcpServers: [], disabledBuiltinTools: [] };
  const effective = best?.id
    ? getEffectiveTools(rootDir, best.id)
    : { builtinTools: [], mcpServers: [] };

  const builtinToolIds = Array.isArray(effective?.builtinTools)
    ? effective.builtinTools.filter((tool) => tool?.enabled).map((tool) => tool.id)
    : [];
  const recommendedToolIds = uniqueStrings([
    ...toStringArray(rawCfg?.enabledTools),
    ...profileEnabledTools,
    ...builtinToolIds,
  ]);
  const enabledMcpServers = uniqueStrings([
    ...profileEnabledMcpServers,
    ...toStringArray(rawCfg?.enabledMcpServers),
    ...toStringArray(effective?.mcpServers),
  ]);

  return {
    builtinToolIds,
    recommendedToolIds,
    enabledMcpServers,
    disabledBuiltinTools: toStringArray(rawCfg?.disabledBuiltinTools),
  };
}

export function getLibraryIndexDir(rootDir) {
  return resolve(rootDir || getBosunHomeDir(), LIBRARY_INDEX_DIR);
}

export function getAgentProfileIndexPath(rootDir) {
  return resolve(rootDir || getBosunHomeDir(), LIBRARY_INDEX_DIR, AGENT_PROFILE_INDEX);
}

export function getSkillEntryIndexPath(rootDir) {
  return resolve(rootDir || getBosunHomeDir(), LIBRARY_INDEX_DIR, SKILL_ENTRY_INDEX);
}

export function rebuildAgentProfileIndex(rootDir, manifest = loadManifest(rootDir)) {
  const normalizedRoot = resolve(rootDir || getBosunHomeDir());
  const profiles = (manifest?.entries || [])
    .filter((entry) => entry?.type === "agent")
    .map((entry) => buildIndexedAgentProfile(normalizedRoot, entry))
    .filter(Boolean);

  const index = {
    generated: nowISO(),
    revision: buildAgentProfileIndexRevision(manifest),
    count: profiles.length,
    profiles,
  };
  safeWriteJson(getAgentProfileIndexPath(normalizedRoot), index);
  return updateAgentProfileIndexCache(normalizedRoot, index, getFileMtimeMs(getManifestPath(normalizedRoot)));
}

export function loadAgentProfileIndex(rootDir, options = {}) {
  const normalizedRoot = resolve(rootDir || getBosunHomeDir());
  const manifestPath = getManifestPath(normalizedRoot);
  const manifestMtimeMs = getFileMtimeMs(manifestPath);
  const cacheEntry = agentProfileIndexCache.get(normalizedRoot);
  if (cacheEntry && cacheEntry.manifestMtimeMs === manifestMtimeMs) {
    return cacheEntry.index;
  }

  const manifest = loadManifest(normalizedRoot);
  const revision = buildAgentProfileIndexRevision(manifest);
  const existing = safeReadJson(getAgentProfileIndexPath(normalizedRoot));
  if (existing && existing.revision === revision && Array.isArray(existing.profiles)) {
    return updateAgentProfileIndexCache(
      normalizedRoot,
      {
        generated: String(existing.generated || nowISO()),
        revision,
        count: existing.profiles.length,
        profiles: existing.profiles,
      },
      manifestMtimeMs,
    );
  }

  if (options?.allowRebuild === false) {
    return updateAgentProfileIndexCache(
      normalizedRoot,
      { generated: nowISO(), revision, count: 0, profiles: [] },
      manifestMtimeMs,
    );
  }

  return rebuildAgentProfileIndex(normalizedRoot, manifest);
}

export function listIndexedAgentProfiles(rootDir, options = {}) {
  const index = loadAgentProfileIndex(rootDir, options);
  return Array.isArray(index?.profiles) ? index.profiles : [];
}

export function rebuildSkillEntryIndex(rootDir, manifest = loadManifest(rootDir)) {
  const normalizedRoot = resolve(rootDir || getBosunHomeDir());
  const skills = (manifest?.entries || [])
    .filter((entry) => entry?.type === "skill")
    .map((entry) => buildIndexedSkillEntry(entry));

  const tokenMap = {};
  for (const skill of skills) {
    const tokens = uniqueStrings([
      String(skill.id || "").toLowerCase(),
      ...skill.tags.map((value) => String(value || "").toLowerCase()),
      ...skill.keywords.map((value) => String(value || "").toLowerCase()),
    ]);
    for (const token of tokens) {
      if (!tokenMap[token]) tokenMap[token] = [];
      tokenMap[token].push(skill.id);
    }
  }

  const index = {
    generated: nowISO(),
    revision: buildSkillIndexRevision(manifest),
    count: skills.length,
    skills,
    tokenMap,
  };
  safeWriteJson(getSkillEntryIndexPath(normalizedRoot), index);
  return updateSkillEntryIndexCache(normalizedRoot, index, getFileMtimeMs(getManifestPath(normalizedRoot)));
}

export function loadSkillEntryIndex(rootDir, options = {}) {
  const normalizedRoot = resolve(rootDir || getBosunHomeDir());
  const manifestPath = getManifestPath(normalizedRoot);
  const manifestMtimeMs = getFileMtimeMs(manifestPath);
  const cacheEntry = skillEntryIndexCache.get(normalizedRoot);
  if (cacheEntry && cacheEntry.manifestMtimeMs === manifestMtimeMs) {
    return cacheEntry.index;
  }

  const manifest = loadManifest(normalizedRoot);
  const revision = buildSkillIndexRevision(manifest);
  const existing = safeReadJson(getSkillEntryIndexPath(normalizedRoot));
  if (existing && existing.revision === revision && Array.isArray(existing.skills)) {
    return updateSkillEntryIndexCache(
      normalizedRoot,
      {
        generated: String(existing.generated || nowISO()),
        revision,
        count: existing.skills.length,
        skills: existing.skills,
        tokenMap: existing.tokenMap || {},
      },
      manifestMtimeMs,
    );
  }

  if (options?.allowRebuild === false) {
    return updateSkillEntryIndexCache(
      normalizedRoot,
      { generated: nowISO(), revision, count: 0, skills: [], tokenMap: {} },
      manifestMtimeMs,
    );
  }

  return rebuildSkillEntryIndex(normalizedRoot, manifest);
}

export function listIndexedSkillEntries(rootDir, options = {}) {
  const index = loadSkillEntryIndex(rootDir, options);
  return Array.isArray(index?.skills) ? index.skills : [];
}

function parseBooleanLike(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (["true", "yes", "on", "1"].includes(normalized)) return true;
  if (["false", "no", "off", "0"].includes(normalized)) return false;
  return fallback;
}

function extractSkillCommentMetadata(markdown = "") {
  const text = String(markdown || "");
  const tagsMatch = /<!--\s*tags:\s*(.+?)\s*-->/i.exec(text);
  const importantMatch = /<!--\s*(?:important|eager)\s*:\s*(true|false|yes|no|on|off|1|0)\s*-->/i.exec(text);
  const h1Match = /^#\s+(?:Skill:\s*)?(.+)$/im.exec(text);

  return {
    title: String(h1Match?.[1] || "").trim(),
    tags: String(tagsMatch?.[1] || "")
      .split(/[,\s]+/)
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean),
    important: parseBooleanLike(importantMatch?.[1], false),
  };
}

function extractDiscoveredSkillMetadata(content = "", fileName = "") {
  const { attrs } = parseSimpleFrontmatter(content);
  const commentMeta = extractSkillCommentMetadata(content);
  const h1Match = content.match(/^#\s+(?:Skill:\s*)?(.+)$/im);
  const title = String(
    getFrontmatterValue(attrs, ["title", "name"])
    || commentMeta.title
    || (h1Match ? h1Match[1].trim() : "")
    || basename(fileName, extname(fileName)),
  ).trim();
  const frontmatterTags = parseJsonishArray(getFrontmatterValue(attrs, ["tags"]) || "");
  const important = parseBooleanLike(
    getFrontmatterValue(attrs, ["important"]),
    commentMeta.important,
  );

  return {
    title,
    tags: frontmatterTags.length > 0 ? frontmatterTags : commentMeta.tags,
    important,
  };
}

function buildDiscoveredSkillId(fullPath, fileName, title, seenIds) {
  const stem = basename(fileName, extname(fileName));
  const parentStem = basename(resolve(fullPath, ".."));
  const baseId = slugify(
    title
    || (stem.toLowerCase() === "skill" ? parentStem : stem)
    || fileName,
  ) || "skill";
  return ensureUniqueId(baseId, seenIds);
}

export function resolveRepositorySkillTrust(workspaceRoot, options = {}) {
  const root = resolve(workspaceRoot || getBosunHomeDir());
  const trustMode = String(options?.trustMode || "").trim().toLowerCase();
  const allowCrossClientExpansion = options?.allowCrossClientExpansion === true
    || options?.trustCrossClientSkills === true
    || trustMode === "allow"
    || trustMode === "trusted";

  return {
    workspaceRoot: root,
    crossClientSkillsDir: resolve(root, ".agents", "skills"),
    trustMode: allowCrossClientExpansion ? "allow" : "catalog-only",
    allowCrossClientExpansion,
  };
}

/**
 * Scan the workspace (and global bosun home) skill directories and return
 * discovered skill entries split into trusted/catalog-only and blocked lists.
 *
 * @param {string} workspaceRoot - Absolute path to the workspace root
 * @returns {{ entries: object[], blockedEntries: object[] }}
 */
export function discoverLocalSkillCatalog(workspaceRoot, options = {}) {
  const root = resolve(workspaceRoot || getBosunHomeDir());
  const resolvedBosunHome = resolve(getBosunHomeDir());
  const trust = resolveRepositorySkillTrust(root, options);

  // Directories to scan: workspace .bosun/skills first, then global if different
  const scanDirs = [];
  const workspaceSkillDir = resolve(root, ".bosun", "skills");
  scanDirs.push({ dir: workspaceSkillDir, sourceKind: "workspace", rootRef: root });

    if (resolvedBosunHome !== root) {
      const globalSkillDir = resolve(resolvedBosunHome, ".bosun", "skills");
      if (globalSkillDir !== workspaceSkillDir) {
        scanDirs.push({ dir: globalSkillDir, sourceKind: "global", rootRef: resolvedBosunHome });
      }
    }

  const crossClientSkillsDir = trust.crossClientSkillsDir;
  if (existsSync(crossClientSkillsDir)) {
    scanDirs.push({ dir: crossClientSkillsDir, sourceKind: "cross-client", rootRef: root });
  }

  const entries = [];
  const blockedEntries = [];
  const seenIds = new Set();

  for (const { dir, sourceKind, rootRef } of scanDirs) {
    if (!existsSync(dir)) continue;

    let files = [];
    try {
      if (sourceKind === "cross-client") {
        files = walkFilesRecursive(dir)
          .filter((filePath) => basename(filePath).toLowerCase() === "skill.md")
          .sort((a, b) => a.localeCompare(b));
      } else {
        files = readdirSync(dir)
          .filter((name) => /\.md$/i.test(name))
          .map((name) => resolve(dir, name))
          .sort((a, b) => a.localeCompare(b));
      }
    } catch {
      continue;
    }

    for (const fullPath of files) {
      const fileName = basename(fullPath);
      let content = "";
      try {
        content = readFileSync(fullPath, "utf8");
      } catch {
        continue;
      }

      const relPath = relative(rootRef, fullPath).replace(/\\/g, "/");
      let updatedAt = nowISO();
      try {
        updatedAt = new Date(statSync(fullPath).mtimeMs).toISOString();
      } catch { /* ignore */ }
      const contentLength = content.length;

      const { title, tags, important } = extractDiscoveredSkillMetadata(content, fileName);
      const id = buildDiscoveredSkillId(fullPath, fileName, title, seenIds);

      const safetyResult = evaluateMarkdownSafety(content, { path: relPath, sourceKind }, {});

      if (safetyResult.blocked) {
        blockedEntries.push({
          id,
          sourcePath: relPath,
          sourceKind,
          trustState: "blocked",
          reasons: Array.isArray(safetyResult.safety?.reasons) ? safetyResult.safety.reasons : [],
        });
        try {
          recordMarkdownSafetyAuditEvent({
            sourcePath: relPath,
            sourceKind,
            reasons: safetyResult.safety?.reasons || [],
            trustState: "blocked",
          }, { rootDir: rootRef });
        } catch { /* best-effort */ }
        continue;
      }

      const catalogOnly = sourceKind === "cross-client"
        ? !trust.allowCrossClientExpansion
        : (safetyResult.safety?.score ?? 0) > 0;
      const trusted = !catalogOnly;
      const trustState = catalogOnly ? "catalog-only" : "trusted";
      const trustReason = sourceKind === "cross-client"
        ? (trusted ? "operator-trusted" : "cross-client skill catalog requires trust")
        : (catalogOnly ? uniqueStrings(safetyResult.safety?.reasons || []).join("; ") : "");

      entries.push({
        id,
        name: title,
        title,
        tags,
        important,
        sourcePath: relPath,
        sourceKind,
        updatedAt,
        catalogOnly,
        trusted,
        trustState,
        trustReason,
        contentLength,
      });
    }
  }

  return { entries, blockedEntries, trust };
}

export function resolveLibraryPlan(rootDir, criteria = {}, opts = {}) {
  const match = matchAgentProfiles(rootDir, criteria, opts);
  const best = match?.best || null;
  if (!best) {
    return {
      ...match,
      plan: null,
      alternatives: [],
    };
  }

  const skillSelection = buildSkillSelection(rootDir, best, criteria, opts);
  const prompt = resolvePromptSelection(rootDir, best.profile || {});
  const toolSelection = resolveToolSelection(rootDir, best);

  const plan = {
    planId: `resolve-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
    agentProfileId: best.id,
    agentName: best.name,
    prompt,
    skillIds: skillSelection.selectedSkillIds,
    selectedSkills: skillSelection.selectedSkills,
    builtinToolIds: toolSelection.builtinToolIds,
    recommendedToolIds: toolSelection.recommendedToolIds,
    enabledMcpServers: toolSelection.enabledMcpServers,
    disabledBuiltinTools: toolSelection.disabledBuiltinTools,
    confidence: Number(best.confidence || 0),
    autoApply: Boolean(match?.auto?.shouldAutoApply),
    reasons: uniqueStrings([
      ...toStringArray(best?.reasons),
      ...skillSelection.selectedSkills.flatMap((entry) => toStringArray(entry?.reasons)),
    ]),
  };

  return {
    ...match,
    plan,
    alternatives: (match?.candidates || []).slice(1).map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      score: candidate.score,
      confidence: candidate.confidence,
      reasons: candidate.reasons,
    })),
  };
}

// ── Manifest (library.json) ──────────────────────────────────────────────────

/**
 * @typedef {Object} LibraryEntry
 * @property {string} id          - unique slug
 * @property {"prompt"|"agent"|"skill"} type
 * @property {string} name        - human-readable name
 * @property {string} description - one-line summary
 * @property {string} filename    - relative path within the type-specific dir
 * @property {string[]} tags      - free-form search tags
 * @property {string} [scope]     - workspace scope or "global"
 * @property {string} [workspace] - workspace name (null = global)
 * @property {Object} [meta]      - type-specific metadata
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} AgentProfile
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {string[]} titlePatterns    - regex patterns matching task titles
 * @property {string[]} scopes           - conventional-commit scopes this agent handles
 * @property {string} [sdk]              - preferred SDK (COPILOT/CODEX/CLAUDE_CODE)
 * @property {string} [model]            - preferred model
 * @property {string} [promptOverride]   - prompt library ref (id) to use
 * @property {string[]} [skills]         - skill library refs to inject
 * @property {Object} [hookProfile]      - hook profile overrides
 * @property {Object} [env]              - extra env vars for the agent
 * @property {string[]} [enabledTools]   - list of tool IDs enabled for this agent (null = all)
 * @property {string[]} [enabledMcpServers] - list of MCP server IDs enabled for this agent
 * @property {"task"|"interactive"|"voice"} [agentCategory] - library grouping/category for the profile
 * @property {"ask"|"agent"|"plan"|"web"|"instant"|"custom"|"voice"} [interactiveMode] - preferred manual interaction mode
 * @property {string} [interactiveLabel] - custom label shown for manual agent type/grouping
 * @property {boolean} [showInChatDropdown] - whether this interactive profile is shown in the chat manual-agent dropdown
 */

/**
 * Get the manifest path for a workspace (or global).
 */
export function getManifestPath(rootDir) {
  return resolve(rootDir || getBosunHomeDir(), ".bosun", LIBRARY_MANIFEST);
}

/**
 * Load the library manifest.
 * @param {string} [rootDir] - workspace root or BOSUN_HOME
 * @returns {{ entries: LibraryEntry[], generated: string }}
 */
export function loadManifest(rootDir) {
  const manifestPath = getManifestPath(rootDir);
  const data = safeReadJson(manifestPath);
  if (data && Array.isArray(data.entries)) return data;
  return { entries: [], generated: nowISO() };
}

/**
 * Save the library manifest.
 */
export function saveManifest(rootDir, manifest) {
  const manifestPath = getManifestPath(rootDir);
  manifest.generated = nowISO();
  safeWriteJson(manifestPath, manifest);
  return manifestPath;
}

// ── CRUD operations ──────────────────────────────────────────────────────────

function dirForType(rootDir, type) {
  const root = rootDir || getBosunHomeDir();
  switch (type) {
    case "prompt": return resolve(root, PROMPT_DIR);
    case "skill":  return resolve(root, SKILL_DIR);
    case "agent":  return resolve(root, PROFILE_DIR);
    case "mcp":    return resolve(root, MCP_DIR);
    case "custom-tool": return resolve(root, TOOL_DIR);
    case "hook": return resolve(root, HOOK_DIR);
    default: throw new Error(`Unknown library resource type: ${type}`);
  }
}

function extForType(type) {
  if (type === "agent" || type === "mcp") return ".json";
  if (type === "custom-tool" || type === "hook") return ".json";
  return ".md";
}

/**
 * List all entries from the manifest, optionally filtered.
 */
export function listEntries(rootDir, { type, tags, scope, search, stabilityTier, installSurface, includeExperimental = true } = {}) {
  const { entries } = loadManifest(rootDir);
  let filtered = entries;
  if (type) filtered = filtered.filter((e) => e.type === type);
  if (scope) filtered = filtered.filter((e) => e.scope === scope || e.scope === "global");
  if (stabilityTier) {
    const expected = String(stabilityTier).trim().toLowerCase();
    filtered = filtered.filter((e) => String(e?.stabilityTier || "").trim().toLowerCase() === expected);
  } else if (includeExperimental === false) {
    filtered = filtered.filter((e) => String(e?.stabilityTier || "").trim().toLowerCase() !== "experimental");
  }
  if (installSurface) {
    const expected = String(installSurface).trim().toLowerCase();
    filtered = filtered.filter((e) => String(e?.installSurface || "").trim().toLowerCase() === expected);
  }
  if (tags && tags.length) {
    const tagSet = new Set(tags.map((t) => t.toLowerCase()));
    filtered = filtered.filter((e) => e.tags.some((t) => tagSet.has(t)));
  }
  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.id.includes(q) ||
        e.tags.some((t) => t.includes(q)),
    );
  }
  return filtered;
}

/**
 * Get a single entry by id.
 */
export function getEntry(rootDir, id) {
  const { entries } = loadManifest(rootDir);
  return entries.find((e) => e.id === id) || null;
}

function resolveEntryFilePath(rootDir, entry) {
  if (!entry || typeof entry !== "object") return "";
  const filename = typeof entry.filename === "string" ? entry.filename.trim() : "";
  if (!filename) return "";
  const dir = dirForType(rootDir, entry.type);
  const filePath = resolve(dir, filename);
  if (!filePath.startsWith(dir + sep) && filePath !== dir) return "";
  return filePath;
}

/**
 * Get the content (file body) for an entry.
 */
export function getEntryContent(rootDir, entry) {
  if (!entry) return null;
  const filePath = resolveEntryFilePath(rootDir, entry);
  if (!filePath) return null;
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf8");
    if (entry.type === "agent" || entry.type === "mcp" || entry.type === "custom-tool") {
      return JSON.parse(raw);
    }
    return raw;
  } catch {
    return null;
  }
}

/**
 * Create or update a library entry.
 * @param {string} rootDir
 * @param {Partial<LibraryEntry>} data - must include at least type, name
 * @param {string|Object} [content]    - file content (md string or JSON object)
 * @returns {LibraryEntry}
 */
export function upsertEntry(rootDir, data, content, options = {}) {
  if (!data.type || !RESOURCE_TYPES.includes(data.type)) {
    throw new Error(`Invalid resource type: ${data.type}`);
  }
  if (!data.name) throw new Error("Entry name is required");

  const manifest = loadManifest(rootDir);
  const id = data.id || slugify(data.name);
  const existingIdx = manifest.entries.findIndex((e) => e.id === id);
  const existing = existingIdx >= 0 ? manifest.entries[existingIdx] : null;

  const entry = {
    id,
    type: data.type,
    name: data.name,
    description: data.description || existing?.description || "",
    filename: data.filename || existing?.filename || `${id}${extForType(data.type)}`,
    tags: data.tags || existing?.tags || [],
    scope: data.scope || existing?.scope || "global",
    workspace: data.workspace ?? existing?.workspace ?? null,
    stabilityTier: data.stabilityTier || existing?.stabilityTier || null,
    installSurface: data.installSurface || existing?.installSurface || null,
    meta: { ...(existing?.meta || {}), ...(data.meta || {}) },
    createdAt: existing?.createdAt || nowISO(),
    updatedAt: nowISO(),
  };

  // Write content file
  if (content !== undefined) {
    const dir = ensureDir(dirForType(rootDir, entry.type));
    const filePath = resolve(dir, entry.filename);
    // Prevent path traversal — resolved path must stay within the type directory
    if (!filePath.startsWith(dir + sep) && filePath !== dir) {
      throw new Error(`Path traversal blocked: ${entry.filename}`);
    }
    const body = typeof content === "object" ? JSON.stringify(content, null, 2) + "\n" : String(content);
    writeFileSync(filePath, body, "utf8");
  }

  // Update manifest
  if (existingIdx >= 0) {
    manifest.entries[existingIdx] = entry;
  } else {
    manifest.entries.push(entry);
  }
  saveManifest(rootDir, manifest);
  if (options?.skipIndexSync !== true) {
    if (data.type === "agent") rebuildAgentProfileIndex(rootDir, manifest);
    if (data.type === "skill") rebuildSkillEntryIndex(rootDir, manifest);
  }

  return entry;
}

/**
 * Delete a library entry by id. Removes from manifest (optionally deletes file).
 */
export function deleteEntry(rootDir, id, { deleteFile = false, syncIndexes = true } = {}) {
  const manifest = loadManifest(rootDir);
  const idx = manifest.entries.findIndex((e) => e.id === id);
  if (idx < 0) return false;

  const entry = manifest.entries[idx];
  const deleteIds = new Set([entry.id]);
  const deletedSkillId = entry.type === "skill" ? String(entry.id || "").trim() : "";
  const sourceId = String(entry?.meta?.sourceId || "").trim();

  if (deletedSkillId) {
    for (const candidate of manifest.entries) {
      if (!candidate || candidate.id === entry.id || candidate.type !== "agent") continue;
      const profile = getEntryContent(rootDir, candidate);
      if (!profile || !Array.isArray(profile.skills) || !profile.skills.includes(deletedSkillId)) continue;
      const nextSkills = profile.skills.filter((skillId) => String(skillId || "").trim() !== deletedSkillId);
      if (nextSkills.length === profile.skills.length) continue;
      const filePath = resolveEntryFilePath(rootDir, candidate);
      if (!filePath) continue;
      writeFileSync(filePath, JSON.stringify({
        ...profile,
        skills: nextSkills,
      }, null, 2) + "\n", "utf8");
      candidate.updatedAt = nowISO();
    }
  }

  if (deletedSkillId && sourceId) {
    for (const candidate of manifest.entries) {
      if (!candidate || candidate.id === entry.id) continue;
      const candidateSourceId = String(candidate?.meta?.sourceId || "").trim();
      const candidateTags = Array.isArray(candidate?.tags) ? candidate.tags : [];
      if (!candidateSourceId || candidateSourceId !== sourceId) continue;
      if (!candidateTags.includes("imported")) continue;
      if (candidate.type === "agent" || candidate.type === "prompt" || candidate.type === "skill") {
        deleteIds.add(candidate.id);
      }
    }
  }

  const deletedEntries = manifest.entries.filter((candidate) => deleteIds.has(candidate.id));
  manifest.entries = manifest.entries.filter((candidate) => !deleteIds.has(candidate.id));
  saveManifest(rootDir, manifest);
  if (syncIndexes !== false) {
    rebuildAgentProfileIndex(rootDir, manifest);
    rebuildSkillEntryIndex(rootDir, manifest);
  }

  if (deleteFile) {
    for (const deletedEntry of deletedEntries) {
      const filePath = resolveEntryFilePath(rootDir, deletedEntry);
      if (!filePath) continue;
      try {
        unlinkSync(filePath);
      } catch { /* file may not exist */ }
    }
  }
  return true;
}

// ── Agent Profiles ───────────────────────────────────────────────────────────

/**
 * List all agent profiles.
 */
export function listAgentProfiles(rootDir) {
  return listEntries(rootDir, { type: "agent" }).map((e) => {
    const profile = getEntryContent(rootDir, e);
    return { ...e, profile };
  });
}

/**
 * Match a task to an agent profile based on title patterns and scopes.
 * Returns the best matching profile or null.
 *
 * @param {string} rootDir
 * @param {string} taskTitle
 * @returns {AgentProfile|null}
 */
export function matchAgentProfiles(rootDir, criteria = {}, opts = {}) {
  const title = String(criteria?.title || "").trim();
  const description = String(criteria?.description || "").trim();
  const requestedAgentType = String(criteria?.agentType || "").trim().toLowerCase();
  const topN = Math.max(1, Number.parseInt(String(opts?.topN ?? criteria?.topN ?? 5), 10) || 5);
  if (!title && !description) {
    return {
      best: null,
      candidates: [],
      auto: { shouldAutoApply: false, reason: "empty-input" },
      context: { title: "", description: "", requestedAgentType },
    };
  }

  const profiles = listIndexedAgentProfiles(rootDir);
  const taskScope = extractConventionalScope(title);
  const textBlob = `${title}\n${description}`.trim();
  const textBlobLower = textBlob.toLowerCase();

  // Repo-context and file-context signals
  const repoCtx = criteria?.repoContext || (criteria?.repoRoot ? buildRepoContext(criteria.repoRoot) : null);
  const changedFiles = toStringArray(criteria?.changedFiles);
  const fileSignals = changedFiles.length > 0 ? inferFileContextSignals(changedFiles) : null;

  const criteriaTags = uniqueStrings([
    ...toStringArray(criteria?.tags),
    ...toStringArray(String(criteria?.tagsCsv || "").split(",")),
    ...keywordTokens(textBlob, { minLength: 4 }),
    ...(repoCtx ? [...repoCtx.languages, ...repoCtx.frameworks] : []),
    ...(fileSignals ? fileSignals.fileLanguages : []),
  ]).map((v) => v.toLowerCase());
  const changedHints = keywordTokens(changedFiles.join(" "), { minLength: 3 });

  // Combined domain set for profile matching
  const contextDomains = new Set([
    ...(repoCtx ? [...repoCtx.languages, ...repoCtx.frameworks, ...repoCtx.domains] : []),
    ...(fileSignals ? [...fileSignals.fileDomains, ...fileSignals.fileLanguages] : []),
  ].map((d) => d.toLowerCase()));

  // Max theoretical score: 10 + 6 + 6 + 3 + 8 + 6 + 4 + 8 + 5 = 56
  const MAX_THEORETICAL_SCORE = 56;

  // Task-type detection (used by Signal 9)
  const TASK_TYPE_PATTERNS = {
    tdd: /\b(tdd|test.driven|write.*tests?|spec)\b/i,
    test: /\b(test|testing|coverage|jest|vitest|pytest|spec)\b/i,
    review: /\b(review|code.review|pr.review|audit|inspect)\b/i,
    docs: /\b(doc|documentation|readme|changelog|api.doc)\b/i,
    implementation: /\b(implement|build|create|develop|feat|feature|add)\b/i,
    fix: /\b(fix|bug|patch|hotfix|repair|resolve)\b/i,
    refactor: /\b(refactor|cleanup|reorganize|restructure|simplify)\b/i,
    devops: /\b(ci|cd|deploy|pipeline|docker|k8s|infra|terraform)\b/i,
  };
  const detectedTaskTypes = Object.entries(TASK_TYPE_PATTERNS)
    .filter(([, re]) => re.test(textBlob))
    .map(([type]) => type);

  const candidates = [];
  for (const entry of profiles) {
    const profile = entry.profile;
    if (!profile) continue;

    const profileType = String(profile?.agentType || "task").trim().toLowerCase() || "task";
    if (requestedAgentType && profileType && requestedAgentType !== profileType) continue;

    let score = 0;
    const reasons = [];
    const breakdown = {};

    // ── Signal 1: titlePattern regex match → +10 (precompiled) ──
    const patterns = toStringArray(profile.titlePatterns);
    let titlePatternScore = 0;
    for (const pattern of patterns) {
      const re = getCompiledRegex(pattern);
      if (re && re.test(textBlob)) {
        titlePatternScore = 10;
        reasons.push(`pattern:${pattern}`);
        break;
      }
    }
    score += titlePatternScore;
    breakdown.titlePattern = titlePatternScore;

    // ── Signal 2: conventional-commit scope match → +6 ──
    const scopes = toStringArray(profile.scopes).map((s) => s.toLowerCase());
    let scopeScore = 0;
    if (taskScope && scopes.includes(taskScope)) {
      scopeScore = 6;
      reasons.push(`scope:${taskScope}`);
    }
    score += scopeScore;
    breakdown.scope = scopeScore;

    // ── Signal 3: tag overlap → up to +6 ──
    const profileTags = uniqueStrings([...(entry.tags || []), ...toStringArray(profile.tags)]).map((v) => v.toLowerCase());
    const tagHits = criteriaTags.filter((tag) => profileTags.includes(tag));
    let tagScore = 0;
    if (tagHits.length > 0) {
      tagScore = Math.min(6, tagHits.length * 2);
      reasons.push(`tags:${tagHits.slice(0, 4).join(",")}`);
    }
    score += tagScore;
    breakdown.tags = tagScore;

    // ── Signal 4: voice-type hint → +3 ──
    let voiceScore = 0;
    if (profileType === "voice") {
      const voiceHint = /\bvoice\b|\bcall\b|\brealtime\b/.test(textBlobLower);
      if (voiceHint) {
        voiceScore = 3;
        reasons.push("voice-hint");
      }
    }
    score += voiceScore;
    breakdown.voice = voiceScore;

    // ── Signal 5: changed-file path match → up to +8 ──
    const scopeHitsFromPaths = scopes.filter((scope) =>
      changedHints.includes(scope) || changedFiles.some((f) => String(f).toLowerCase().includes(`/${scope}/`) || String(f).toLowerCase().includes(`\\${scope}\\`)),
    );
    let pathScore = 0;
    if (scopeHitsFromPaths.length > 0) {
      pathScore = Math.min(8, scopeHitsFromPaths.length * 2);
      reasons.push(`paths:${scopeHitsFromPaths.slice(0, 4).join(",")}`);
    }
    score += pathScore;
    breakdown.paths = pathScore;

    // ── Signal 6: repo-context domain match → up to +6 ──
    let domainScore = 0;
    if (contextDomains.size > 0) {
      const profileAllTags = new Set([...profileTags, ...scopes]);
      const domainHits = [...contextDomains].filter((d) => profileAllTags.has(d));
      if (domainHits.length > 0) {
        domainScore = Math.min(6, domainHits.length * 2);
        reasons.push(`repo-ctx:${domainHits.slice(0, 3).join(",")}`);
      }
    }
    score += domainScore;
    breakdown.repoCtx = domainScore;

    // ── Signal 7: file-type domain match → up to +4 ──
    let fileTypeScore = 0;
    if (fileSignals && fileSignals.fileDomains.length > 0) {
      const profileAllTags = new Set([...profileTags, ...scopes]);
      const fileHits = fileSignals.fileDomains.filter((d) => profileAllTags.has(d));
      if (fileHits.length > 0) {
        fileTypeScore = Math.min(4, fileHits.length);
        reasons.push(`file-type:${fileHits.slice(0, 3).join(",")}`);
      }
    }
    score += fileTypeScore;
    breakdown.fileType = fileTypeScore;

    // ── Signal 8: description keyword match → up to +8 ──
    const profileDesc = String(profile.description || "").toLowerCase();
    let descScore = 0;
    if (profileDesc.length > 10) {
      const descTokens = keywordTokens(profileDesc, { minLength: 4 });
      const titleTokens = keywordTokens(textBlob, { minLength: 4 });
      const descHits = descTokens.filter((t) => titleTokens.includes(t));
      if (descHits.length > 0) {
        descScore = Math.min(8, descHits.length * 2);
        reasons.push(`desc:${descHits.slice(0, 4).join(",")}`);
      }
    }
    score += descScore;
    breakdown.descMatch = descScore;

    // ── Signal 9: task-type hint → +5 ──
    let taskTypeScore = 0;
    if (detectedTaskTypes.length > 0) {
      const profileAllTags = new Set([...profileTags, ...scopes]);
      const taskTypeHits = detectedTaskTypes.filter((t) => profileAllTags.has(t));
      if (taskTypeHits.length > 0) {
        taskTypeScore = 5;
        reasons.push(`task-type:${taskTypeHits.join(",")}`);
      }
    }
    score += taskTypeScore;
    breakdown.taskType = taskTypeScore;

    if (score <= 0) continue;

    const confidence = Math.max(0, Math.min(1, score / MAX_THEORETICAL_SCORE));
    candidates.push({
      ...entry,
      agentType: profileType,
      score,
      confidence,
      reasons,
      breakdown,
      matchedScope: taskScope,
    });
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });

  const best = candidates[0] || null;
  const runnerUp = candidates[1] || null;
  const minScore = parseMatchEnvNumber("BOSUN_AGENT_MATCH_AUTO_MIN_SCORE", 12);
  const minConfidence = parseMatchEnvNumber("BOSUN_AGENT_MATCH_AUTO_MIN_CONFIDENCE", 0.72);
  const minDelta = parseMatchEnvNumber("BOSUN_AGENT_MATCH_AUTO_MIN_DELTA", 3);
  const shouldAutoApply = Boolean(
    best
      && Number(best.score || 0) >= minScore
      && Number(best.confidence || 0) >= minConfidence
      && (Number(best.score || 0) - Number(runnerUp?.score || 0)) >= minDelta,
  );

  return {
    best,
    candidates: candidates.slice(0, topN),
    auto: {
      shouldAutoApply,
      reason: shouldAutoApply ? "high-confidence" : "below-threshold",
      thresholds: { minScore, minConfidence, minDelta },
      runnerUpScore: Number(runnerUp?.score || 0),
    },
    context: {
      title,
      description,
      requestedAgentType,
      taskScope,
      detectedTaskTypes,
      changedFilesCount: changedFiles.length,
      repoContext: repoCtx || null,
      fileSignals: fileSignals || null,
    },
  };
}

/**
 * Backward-compatible single-best match helper.
 *
 * @param {string} rootDir
 * @param {string} taskTitle
 * @returns {AgentProfile|null}
 */
export function matchAgentProfile(rootDir, taskTitle) {
  const result = matchAgentProfiles(rootDir, { title: taskTitle }, { topN: 1 });
  return result.best || null;
}

export {
  WELL_KNOWN_AGENT_SOURCES,
  computeWellKnownSourceTrust,
  listWellKnownAgentSources,
  clearWellKnownAgentSourceProbeCache,
  probeWellKnownAgentSources,
};
function parseSimpleFrontmatter(markdown = "") {
  const text = String(markdown || "");
  if (!text.startsWith("---\n")) return { attrs: {}, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return { attrs: {}, body: text };
  const head = text.slice(4, end).split(/\r?\n/);
  const attrs = {};
  for (const line of head) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    attrs[m[1].trim()] = parseTomlValue(m[2]);
  }
  const body = text.slice(end + 5).trim();
  return { attrs, body };
}

function walkFilesRecursive(rootDir) {
  const stack = [rootDir];
  const files = [];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function ensureUniqueId(baseId, takenIds) {
  let id = baseId;
  let seq = 2;
  while (takenIds.has(id)) {
    id = `${baseId}-${seq}`;
    seq += 1;
  }
  takenIds.add(id);
  return id;
}

function getFrontmatterValue(attrs = {}, keys = []) {
  if (!attrs || typeof attrs !== "object") return null;
  for (const key of keys) {
    if (Object.hasOwn(attrs, key)) return attrs[key];
  }
  const lowerMap = new Map(
    Object.keys(attrs).map((key) => [String(key || "").toLowerCase(), attrs[key]]),
  );
  for (const key of keys) {
    const hit = lowerMap.get(String(key || "").toLowerCase());
    if (hit != null) return hit;
  }
  return null;
}

function normalizeImportedDescription(rawDescription, body = "") {
  const raw = String(rawDescription || "").trim();
  if (raw) {
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      return raw.slice(1, -1).trim();
    }
    return raw;
  }
  const fallback = String(body || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"));
  return String(fallback || "Imported library entry").trim();
}

function inferImportedEntryKind(relPath = "", fileName = "", attrs = {}) {
  const pathLower = String(relPath || "").toLowerCase();
  const fileLower = String(fileName || "").toLowerCase();
  const explicitType = String(getFrontmatterValue(attrs, ["type", "kind", "resourceType"]) || "").trim().toLowerCase();
  if (explicitType === "agent" || explicitType === "profile") return "agent";
  if (explicitType === "skill") return "skill";
  if (explicitType === "prompt") return "prompt";

  if (/\.agent\.md$/i.test(fileLower) || /\/\.github\/agents\//i.test(pathLower)) return "agent";
  if (
    fileLower === "skill.md"
    || /\.skill\.md$/i.test(fileLower)
    || /\/\.github\/skills\//i.test(pathLower)
    || /\/\.github\/plugins\/[^/]+\/skills\//i.test(pathLower)
  ) return "skill";
  if (
    /\.prompt\.md$/i.test(fileLower)
    || /\/prompts\//i.test(pathLower)
    || /\/\.github\/prompts\//i.test(pathLower)
    || fileLower === "copilot-instructions.md"
  ) return "prompt";
  return null;
}
function humanizeSlug(slug) {
  const value = String(slug || "").trim();
  if (!value) return "";
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function slugifyIdentifier(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return slugify(
    raw
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .replace(/[_.]+/g, "-"),
  );
}

function parseTomlValue(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) return "";
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const body = raw.slice(1, -1).trim();
    if (!body) return [];
    return body
      .split(",")
      .map((part) => String(part || "").trim())
      .filter(Boolean)
      .map((part) => {
        if (
          (part.startsWith('"') && part.endsWith('"'))
          || (part.startsWith("'") && part.endsWith("'"))
        ) {
          return part.slice(1, -1);
        }
        return part;
      });
  }
  return raw;
}

function parseMcpServersFromToml(tomlText, sourcePath = "") {
  const servers = new Map();
  const lines = String(tomlText || "").split(/\r?\n/);
  let current = null;

  for (const rawLine of lines) {
    const line = String(rawLine || "").trim();
    if (!line || line.startsWith("#")) continue;

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      const sectionName = String(sectionMatch[1] || "").trim();
      const mcpMatch = sectionName.match(/^mcp_servers\.([A-Za-z0-9_-]+)(?:\.(env))?$/i);
      if (!mcpMatch) {
        current = null;
        continue;
      }
      const rawId = String(mcpMatch[1] || "").trim();
      if (!rawId) {
        current = null;
        continue;
      }
      if (!servers.has(rawId)) {
        servers.set(rawId, {
          rawId,
          sourcePath,
          section: "mcp_servers." + rawId,
          main: {},
          envKeys: new Set(),
        });
      }
      current = {
        rawId,
        env: String(mcpMatch[2] || "").toLowerCase() === "env",
      };
      continue;
    }

    if (!current) continue;
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kv) continue;

    const key = String(kv[1] || "").trim();
    const value = parseTomlValue(kv[2]);
    if (!key) continue;

    const target = servers.get(current.rawId);
    if (!target) continue;
    if (current.env) {
      target.envKeys.add(key);
    } else {
      target.main[key] = value;
    }
  }

  const normalized = [];
  for (const record of servers.values()) {
    const id = slugifyIdentifier(record.rawId.replace(/_/g, "-"));
    if (!id) continue;

    const url = String(record.main.url || "").trim();
    const command = String(record.main.command || "").trim();
    const args = toStringArray(Array.isArray(record.main.args) ? record.main.args : []);
    const env = {};
    for (const key of record.envKeys) {
      env[key] = "";
    }

    if (!url && !command) continue;

    normalized.push({
      id,
      rawId: record.rawId,
      name: humanizeSlug(id),
      sourcePath: record.sourcePath,
      section: record.section,
      transport: url ? "url" : "stdio",
      url: url || null,
      command: command || null,
      args,
      env,
    });
  }

  return normalized;
}

/**
 * Parse MCP server definitions from JSON config (.mcp.json / .vscode/mcp.json).
 * Supports the VS Code MCP JSON format: { "servers": { "<id>": { ... } } }
 * and the flat format: { "<id>": { "command": ..., "args": [...] } }
 */
function parseMcpServersFromJson(jsonText, sourcePath = "") {
  const results = [];
  let parsed;
  try { parsed = JSON.parse(jsonText); } catch { return results; }
  if (!parsed || typeof parsed !== "object") return results;

  const serversObj = (parsed.servers && typeof parsed.servers === "object")
    ? parsed.servers
    : (parsed.mcpServers && typeof parsed.mcpServers === "object")
      ? parsed.mcpServers
      : parsed;
  for (const [rawId, def] of Object.entries(serversObj)) {
    if (!def || typeof def !== "object" || Array.isArray(def)) continue;
    const command = String(def.command || "").trim();
    const url = String(def.url || "").trim();
    if (!command && !url) continue;
    const id = slugifyIdentifier(rawId.replace(/_/g, "-")) || rawId;
    const args = toStringArray(Array.isArray(def.args) ? def.args : []);
    const env = {};
    if (def.env && typeof def.env === "object") {
      for (const k of Object.keys(def.env)) env[k] = "";
    }
    results.push({
      id,
      rawId,
      name: String(def.name || rawId).trim(),
      transport: url ? "url" : "stdio",
      command: command || undefined,
      args: args.length ? args : undefined,
      url: url || undefined,
      env,
      sourcePath,
    });
  }
  return results;
}

function discoverLocalAgentTemplates(rootDir) {
  const candidateDirs = uniqueStrings([
    resolve(rootDir, ".github", "agents"),
    resolve(rootDir, "..", ".github", "agents"),
  ]);

  const templatesById = new Map();
  for (const dir of candidateDirs) {
    if (!existsSync(dir)) continue;

    let files = [];
    try {
      files = readdirSync(dir)
        .filter((name) => /\.md$/i.test(name))
        .sort((a, b) => a.localeCompare(b));
    } catch {
      continue;
    }

    for (const fileName of files) {
      const fullPath = resolve(dir, fileName);
      let body = "";
      try {
        body = String(readFileSync(fullPath, "utf8") || "");
      } catch {
        continue;
      }
      const content = body.trim();
      if (!content) continue;

      const baseName = basename(fileName, ".md").replace(/\.agent$/i, "");
      const id = slugifyIdentifier(baseName);
      if (!id || templatesById.has(id)) continue;

      const firstHeading = content.match(/^#\s+(.+)$/m);
      const name = firstHeading
        ? String(firstHeading[1] || "").trim()
        : humanizeSlug(id);
      const descriptionLine = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith("#"));

      const relPathRaw = relative(rootDir, fullPath).replace(/\\/g, "/");
      const relPath = relPathRaw || ".github/agents/" + fileName;

      templatesById.set(id, {
        id,
        name: name || humanizeSlug(id),
        description: String(descriptionLine || ("Auto-synced prompt template from " + fileName)).slice(0, 240),
        relPath,
        content: body,
      });
    }
  }

  return [...templatesById.values()];
}

function discoverMcpServersFromCodexConfig(rootDir) {
  const candidates = uniqueStrings([
    resolve(rootDir, ".codex", "config.toml"),
    resolve(homedir(), ".codex", "config.toml"),
  ]);
  const discovered = [];
  const seenById = new Set();
  for (const configPath of candidates) {
    if (!existsSync(configPath)) continue;
    let raw = "";
    try {
      raw = readFileSync(configPath, "utf8");
    } catch {
      continue;
    }
    const parsed = parseMcpServersFromToml(raw, configPath);
    for (const entry of parsed) {
      if (!entry?.id || seenById.has(entry.id)) continue;
      seenById.add(entry.id);
      discovered.push(entry);
    }
  }
  return discovered;
}

/**
 * Auto-discover local prompt templates and MCP server definitions and sync
 * them into the library manifest/filesystem.
 */
export function syncAutoDiscoveredLibraryEntries(rootDir) {
  const root = rootDir || getBosunHomeDir();
  const manifestSnapshot = loadManifest(root);
  const existingEntries = Array.isArray(manifestSnapshot?.entries)
    ? manifestSnapshot.entries
    : [];
  const existingById = new Map(
    existingEntries
      .map((entry) => [String(entry?.id || "").trim(), entry])
      .filter(([id]) => Boolean(id)),
  );

  let promptEntriesUpserted = 0;
  let mcpEntriesUpserted = 0;
  let promptEntriesSkipped = 0;
  let mcpEntriesSkipped = 0;

  for (const template of discoverLocalAgentTemplates(root)) {
    const existing = existingById.get(template.id);
    const autoSyncMeta = existing?.meta?.autoSync || {};
    const canUpdateExisting =
      !existing
      || (existing.type === "prompt" && (
        String(autoSyncMeta.kind || "") === "local-agent-template"
        || template.id === "task-planner"
      ));

    if (!canUpdateExisting) {
      promptEntriesSkipped += 1;
      continue;
    }

    upsertEntry(root, {
      id: template.id,
      type: "prompt",
      name: template.name,
      description: template.description,
      tags: uniqueStrings([
        "prompt",
        "autodiscovered",
        "local-agent-template",
        template.id === "task-planner" ? "planner" : "",
      ]),
      meta: {
        autoSync: {
          kind: "local-agent-template",
          sourcePath: template.relPath,
          syncedAt: nowISO(),
        },
      },
    }, template.content);
    promptEntriesUpserted += 1;
  }

  for (const mcp of discoverMcpServersFromCodexConfig(root)) {
    const existing = existingById.get(mcp.id);
    const autoSyncMeta = existing?.meta?.autoSync || {};
    const canUpdateExisting =
      !existing
      || (existing.type === "mcp" && String(autoSyncMeta.kind || "") === "codex-mcp-config");

    if (!canUpdateExisting) {
      mcpEntriesSkipped += 1;
      continue;
    }

    const content = {
      id: mcp.id,
      name: mcp.name,
      description: "Auto-discovered from " + mcp.sourcePath,
      transport: mcp.transport,
      command: mcp.transport === "stdio" ? mcp.command : undefined,
      args: mcp.transport === "stdio" ? mcp.args : undefined,
      url: mcp.transport === "url" ? mcp.url : undefined,
      env: Object.keys(mcp.env || {}).length ? mcp.env : undefined,
      source: "autodiscovered",
      stabilityTier: "experimental",
      installSurface: "autodiscovered",
      tags: ["autodiscovered", "codex-config", "mcp"],
    };

    upsertEntry(root, {
      id: mcp.id,
      type: "mcp",
      name: mcp.name,
      description: content.description,
      tags: uniqueStrings(["mcp", "autodiscovered", "codex-config"]),
      stabilityTier: "experimental",
      installSurface: "autodiscovered",
      meta: {
        autoSync: {
          kind: "codex-mcp-config",
          sourcePath: mcp.sourcePath,
          section: mcp.section,
          rawId: mcp.rawId,
          syncedAt: nowISO(),
        },
      },
    }, content);
    mcpEntriesUpserted += 1;
  }

  return {
    promptEntriesUpserted,
    mcpEntriesUpserted,
    promptEntriesSkipped,
    mcpEntriesSkipped,
    totalUpserted: promptEntriesUpserted + mcpEntriesUpserted,
  };
}

function resolveRepositoryImportSource(options = {}) {
  const sourceId = String(options?.sourceId || "").trim().toLowerCase();
  const known = WELL_KNOWN_AGENT_SOURCES.find((source) => source.id === sourceId) || null;
  const repoUrl = String(options?.repoUrl || known?.repoUrl || "").trim();
  if (!repoUrl) throw new Error("Repository URL or source is required");

  const branch = String(options?.branch || known?.defaultBranch || "main").trim() || "main";
  if (!isSafeGitRepositorySource(repoUrl)) {
    throw new Error("URL must be a valid http(s), ssh, or git repository address");
  }
  if (!isSafeGitRefName(branch)) {
    throw new Error("Branch name contains invalid characters");
  }

  return { sourceId, known, repoUrl, branch };
}

function createRepositoryImportCheckoutDir(prefix, repoUrl, branch) {
  const cacheRoot = ensureDir(resolve(getBosunHomeDir(), ".cache", "imports"));
  const checkoutDir = resolve(cacheRoot, `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  ensureDir(checkoutDir);

  const clone = spawnSync("git", ["clone", "--depth", "1", "--branch", branch, "--", repoUrl, checkoutDir], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  const cloneStderr = String(clone.stderr || "").trim();
  const checkoutWarning = /clone succeeded.*checkout failed/i.test(cloneStderr);
  if (clone.status === 0 || checkoutWarning) return checkoutDir;

  rmSync(checkoutDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  if (/repository not found/i.test(cloneStderr)) {
    throw new Error(`Repository not found: ${repoUrl}`);
  }
  if (/could not read from remote/i.test(cloneStderr)) {
    throw new Error(`Cannot access repository (may be private or require authentication): ${repoUrl}`);
  }
  if (/not found in upstream/i.test(cloneStderr) || /remote branch.*not found/i.test(cloneStderr)) {
    throw new Error(`Branch "${branch}" not found in ${repoUrl}`);
  }
  if (clone.signal === "SIGTERM") {
    throw new Error(`Clone timed out — repository may be too large: ${repoUrl}`);
  }
  throw new Error(`Failed to clone repository: ${cloneStderr || "unknown error"}`);
}

function buildImportedMarkdownCandidate(candidate) {
  const { raw = "", attrs = {}, body = "", relPath = "", fileName = "", kind = null } = candidate || {};
  if (!kind) return null;

  const fileStem = basename(fileName, ".md");
  const relSegments = relPath.split(/[\\/]/).filter(Boolean);
  const parentSegment = relSegments.length > 1 ? relSegments[relSegments.length - 2] : "";
  const fallbackNameBase = fileStem.toLowerCase() === "skill" && parentSegment ? parentSegment : fileStem;
  const fallbackName = fallbackNameBase.replace(/\.agent$/i, "").replace(/\.skill$/i, "").replace(/\.prompt$/i, "");
  const name = String(getFrontmatterValue(attrs, ["name", "title"]) || fallbackName.replace(/[-_.]+/g, " ")).trim();
  const description = normalizeImportedDescription(getFrontmatterValue(attrs, ["description", "summary"]), body);

  return {
    ...candidate,
    fileStem,
    name,
    description,
  };
}

function sortImportedMarkdownCandidates(candidates = []) {
  const rank = { agent: 0, prompt: 1, skill: 2 };
  return candidates.sort((a, b) => {
    const aRank = Number(rank[a.kind] ?? 99);
    const bRank = Number(rank[b.kind] ?? 99);
    if (aRank !== bRank) return aRank - bRank;
    return String(a.relPath || "").localeCompare(String(b.relPath || ""));
  });
}

function collectRepositoryImportMarkdownCandidates(checkoutDir, options = {}) {
  const maxEntries = Math.max(
    1,
    Math.min(2000, Number.parseInt(String(options?.maxEntries ?? "500"), 10) || 500),
  );

  const files = walkFilesRecursive(checkoutDir);
  const candidates = sortImportedMarkdownCandidates(
    files
      .filter((fullPath) => /\.md$/i.test(fullPath))
      .map((fullPath) => {
        const relPath = fullPath.slice(checkoutDir.length + 1).replace(/\\/g, "/");
        const fileName = basename(fullPath);
        let raw = "";
        let parsed = { attrs: {}, body: "" };
        try {
          raw = readFileSync(fullPath, "utf8");
          parsed = parseSimpleFrontmatter(raw);
        } catch {
          return null;
        }
        const kind = inferImportedEntryKind(relPath, fileName, parsed.attrs);
        return buildImportedMarkdownCandidate({
          fullPath,
          relPath,
          fileName,
          raw,
          attrs: parsed.attrs,
          body: parsed.body,
          kind,
          selected: true,
        });
      })
      .filter(Boolean),
  ).slice(0, maxEntries);

  return { files, candidates };
}

function evaluateRepositoryImportCandidateSafety(candidate, context = {}) {
  const evaluation = evaluateMarkdownSafety(
    candidate?.raw || candidate?.body || "",
    {
      sourcePath: candidate?.relPath || "",
      repoUrl: context.repoUrl || "",
      repo: context.repoUrl || "",
      sourceRoot: context.checkoutDir || "",
      documentationContext: false,
    },
    context.configData || {},
  );
  return {
    blocked: evaluation?.blocked === true,
    reasons: Array.isArray(evaluation?.safety?.reasons) ? evaluation.safety.reasons : [],
    score: Number(evaluation?.safety?.score || 0),
  };
}

function filterRepositoryImportCandidates(candidates = [], context = {}) {
  const allowedCandidates = [];
  const blockedCandidates = [];
  const blockedCandidatesByType = { agent: 0, prompt: 0, skill: 0, mcp: 0 };

  for (const candidate of candidates) {
    if (!candidate || candidate.kind === "mcp") {
      allowedCandidates.push(candidate);
      continue;
    }
    const safety = evaluateRepositoryImportCandidateSafety(candidate, context);
    if (!safety.blocked) {
      allowedCandidates.push(candidate);
      continue;
    }
    const blockedCandidate = {
      ...candidate,
      reasons: safety.reasons,
      score: safety.score,
    };
    blockedCandidates.push(blockedCandidate);
    blockedCandidatesByType[candidate.kind] = (blockedCandidatesByType[candidate.kind] || 0) + 1;
    recordMarkdownSafetyAuditEvent({
      channel: context.auditChannel || "library-import-preview",
      sourcePath: candidate.relPath,
      repoUrl: context.repoUrl || "",
      reasons: safety.reasons,
      score: safety.score,
    }, {
      rootDir: context.rootDir || process.cwd(),
      policy: context.configData || {},
    });
  }

  return {
    candidates: allowedCandidates,
    blockedCandidates,
    blockedCandidatesByType,
  };
}

function listRepositoryMcpConfigFiles(checkoutDir, { includeLegacy = false } = {}) {
  const configFiles = [
    { path: resolve(checkoutDir, ".codex", "config.toml"), format: "toml" },
    { path: resolve(checkoutDir, ".mcp.json"), format: "json" },
    { path: resolve(checkoutDir, ".vscode", "mcp.json"), format: "json" },
  ];

  if (includeLegacy) {
    configFiles.splice(2, 0, { path: resolve(checkoutDir, "mcp.json"), format: "json" });
    configFiles.push({ path: resolve(checkoutDir, "claude_desktop_config.json"), format: "json" });
  }

  return configFiles;
}

function discoverRepositoryMcpConfigs(checkoutDir, options = {}) {
  const discovered = [];
  for (const { path: configPath, format } of listRepositoryMcpConfigFiles(checkoutDir, options)) {
    if (!existsSync(configPath)) continue;
    let raw = "";
    try {
      raw = readFileSync(configPath, "utf8");
    } catch {
      continue;
    }
    const relPath = relative(checkoutDir, configPath).replace(/\\/g, "/");
    const entries = format === "toml"
      ? parseMcpServersFromToml(raw, relPath)
      : parseMcpServersFromJson(raw, relPath);
    discovered.push(...entries.map((entry) => ({ ...entry, relPath, fileName: basename(configPath) })));
  }
  return discovered;
}

function appendRepositoryMcpImportCandidates(candidates, files, checkoutDir, byType) {
  for (const mcp of discoverRepositoryMcpConfigs(checkoutDir, { includeLegacy: true })) {
    candidates.push({
      relPath: `${mcp.relPath}#${mcp.id}`,
      fileName: mcp.fileName,
      kind: "mcp",
      name: mcp.name || mcp.id,
      description: `${mcp.transport === "stdio" ? "stdio" : "url"} MCP server${mcp.command ? ": " + mcp.command : ""}`,
      selected: true,
    });
    byType.mcp += 1;
  }

  const mcpSeenIds = new Set(candidates.filter((candidate) => candidate.kind === "mcp").map((candidate) => candidate.name));
  for (const fullPath of files) {
    const fileName = basename(fullPath);
    if (fileName !== "package.json" && fileName !== "pyproject.toml") continue;
    const relPath = relative(checkoutDir, fullPath).replace(/\\/g, "/");
    if (relPath === "package.json") continue;
    let raw = "";
    try {
      raw = readFileSync(fullPath, "utf8");
    } catch {
      continue;
    }

    if (fileName === "package.json") {
      let pkg;
      try {
        pkg = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!pkg || typeof pkg !== "object") continue;
      const bin = pkg.bin;
      if (!bin || typeof bin !== "object") continue;
      const mcpBins = Object.entries(bin).filter(([key]) => /^mcp[-_]?server/i.test(key) || /^mcp-/i.test(key));
      if (mcpBins.length === 0) continue;
      for (const [cmd] of mcpBins) {
        const id = slugifyIdentifier(cmd);
        if (mcpSeenIds.has(cmd) || mcpSeenIds.has(id)) continue;
        mcpSeenIds.add(cmd);
        const name = String(pkg.mcpName || pkg.name || cmd).trim();
        const description = String(pkg.description || "").trim();
        candidates.push({
          relPath: `${relPath}#${cmd}`,
          fileName,
          kind: "mcp",
          name: name.startsWith("@") ? cmd : name,
          description: description || `stdio MCP server: ${cmd}`,
          selected: true,
        });
        byType.mcp += 1;
      }
      continue;
    }

    const scriptMatch = raw.match(/\[project\.scripts\]([\s\S]*?)(?:\n\[|\n$)/);
    if (!scriptMatch) continue;
    const scriptLines = scriptMatch[1].split(/\r?\n/);
    for (const line of scriptLines) {
      const kv = line.match(/^\s*(mcp[-_]?server[-_]?\S*)\s*=/i);
      if (!kv) continue;
      const cmd = kv[1].trim();
      if (mcpSeenIds.has(cmd)) continue;
      mcpSeenIds.add(cmd);
      const nameMatch = raw.match(/^\s*name\s*=\s*"([^"]+)"/m);
      const descMatch = raw.match(/^\s*description\s*=\s*"([^"]+)"/m);
      candidates.push({
        relPath: `${relPath}#${cmd}`,
        fileName,
        kind: "mcp",
        name: nameMatch ? nameMatch[1] : cmd,
        description: descMatch ? descMatch[1] : `stdio MCP server: ${cmd}`,
        selected: true,
      });
      byType.mcp += 1;
    }
  }
}

export function scanRepositoryForImport(options = {}) {
  const { sourceId, known, repoUrl, branch } = resolveRepositoryImportSource(options);
  const maxEntries = Math.max(
    1,
    Math.min(
      2000,
      Number.parseInt(String(options?.maxEntries ?? "500"), 10) || 500,
    ),
  );

  const checkoutDir = createRepositoryImportCheckoutDir("scan", repoUrl, branch);

  try {
    const { files, candidates: rawCandidates } = collectRepositoryImportMarkdownCandidates(checkoutDir, { maxEntries });
    const filtered = filterRepositoryImportCandidates(rawCandidates, {
      rootDir: options?.rootDir || process.cwd(),
      repoUrl,
      checkoutDir,
      configData: options?.configData || {},
      auditChannel: "library-import-preview",
    });
    const candidates = [...filtered.candidates];

    const byType = { agent: 0, prompt: 0, skill: 0, mcp: 0 };
    for (const candidate of candidates) {
      byType[candidate.kind] = (byType[candidate.kind] || 0) + 1;
    }

    appendRepositoryMcpImportCandidates(candidates, files, checkoutDir, byType);

    const rootDir = options?.rootDir || null;
    let duplicateMap = {};
    let intraDuplicateMap = {};
    if (rootDir) {
      try {
        const existingEntries = listEntries(rootDir);
        const extDups = detectImportDuplicates(candidates, existingEntries);
        for (const [relPath, info] of extDups) {
          duplicateMap[relPath] = info;
          const cand = candidates.find((c) => c.relPath === relPath);
          if (cand && info.similarity >= 0.95) cand.selected = false;
        }
      } catch {}
    }

    const intraDups = detectIntraDuplicates(candidates);
    for (const [relPath, peers] of intraDups) {
      intraDuplicateMap[relPath] = peers;
    }

    return {
      ok: true,
      source: known ? { id: known.id, name: known.name } : { id: sourceId || "custom", name: repoUrl },
      repoUrl,
      branch,
      totalCandidates: candidates.length,
      candidatesByType: byType,
      candidates,
      blockedCandidates: filtered.blockedCandidates,
      blockedCandidatesByType: filtered.blockedCandidatesByType,
      duplicates: duplicateMap,
      intraDuplicates: intraDuplicateMap,
    };
  } finally {
    try { rmSync(checkoutDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch {}
  }
}

function importRepositoryMarkdownCandidate(rootDir, candidate, context) {
  const { known, repoUrl, branch, sourceId, importAgents, importSkills, importPrompts, takenIds, imported, importedByType } = context;
  const { attrs, body, relPath, fileStem, kind, name, description, raw } = candidate;
  const keywords = keywordTokens(`${name} ${description} ${relPath}`, { minLength: 4 }).slice(0, 10);

  if (kind === "prompt") {
    if (!importPrompts) return { needsAgentIndexRefresh: false, needsSkillIndexRefresh: false };
    const baseId = slugify(`${sourceId || "imported"}-${name}`) || slugify(fileStem) || `imported-prompt-${imported.length + 1}`;
    const id = ensureUniqueId(baseId, takenIds);
    const promptContent = String(body || raw || "").trim();
    if (!promptContent) return { needsAgentIndexRefresh: false, needsSkillIndexRefresh: false };
    upsertEntry(rootDir, {
      id,
      type: "prompt",
      name,
      description: description || `Imported prompt from ${known?.name || repoUrl}`,
      tags: uniqueStrings(["imported", "prompt", sourceId || "external", ...parseJsonishArray(getFrontmatterValue(attrs, ["tags"]))]),
      meta: {
        sourceId: sourceId || null,
        repoUrl,
        branch,
        relPath,
      },
    }, promptContent);
    imported.push({ id, name, relPath, type: "prompt", promptId: null });
    importedByType.prompt += 1;
    return { needsAgentIndexRefresh: false, needsSkillIndexRefresh: false };
  }

  if (kind === "skill") {
    if (!importSkills) return { needsAgentIndexRefresh: false, needsSkillIndexRefresh: false };
    const baseId = slugify(`${sourceId || "imported"}-${name}`) || slugify(fileStem) || `imported-skill-${imported.length + 1}`;
    const id = ensureUniqueId(baseId, takenIds);
    const skillContent = String(body || raw || "").trim();
    if (!skillContent) return { needsAgentIndexRefresh: false, needsSkillIndexRefresh: false };
    upsertEntry(rootDir, {
      id,
      type: "skill",
      name,
      description: description || "Imported skill",
      tags: uniqueStrings(["imported", "skill", sourceId || "external", ...parseJsonishArray(getFrontmatterValue(attrs, ["tags"]))]),
      meta: {
        sourceId: sourceId || null,
        repoUrl,
        branch,
        relPath,
      },
    }, skillContent, { skipIndexSync: true });
    imported.push({ id, name, relPath, type: "skill", promptId: null });
    importedByType.skill += 1;
    return { needsAgentIndexRefresh: false, needsSkillIndexRefresh: true };
  }

  if (kind !== "agent" || !importAgents) {
    return { needsAgentIndexRefresh: false, needsSkillIndexRefresh: false };
  }

  const baseId = slugify(`${sourceId || "imported"}-${name}`) || slugify(fileStem) || `imported-agent-${imported.length + 1}`;
  const id = ensureUniqueId(baseId, takenIds);
  const toolHints = parseJsonishArray(getFrontmatterValue(attrs, ["tools", "enabledTools"]));
  const profileSkillHints = parseJsonishArray(getFrontmatterValue(attrs, ["skills"]));
  const mcpHints = parseJsonishArray(getFrontmatterValue(attrs, ["enabledMcpServers", "mcpServers", "mcp"]));
  const titlePatternHints = parseJsonishArray(getFrontmatterValue(attrs, ["titlePatterns", "title_patterns", "patterns"]));
  const tags = uniqueStrings([
    "imported",
    sourceId || "external",
    ...parseJsonishArray(getFrontmatterValue(attrs, ["tags"])),
    ...keywords.slice(0, 4),
  ]);
  const pathScopes = uniqueStrings(
    relPath
      .split(/[\/]/)
      .slice(0, -1)
      .map((segment) => slugify(segment))
      .filter((segment) => segment && segment !== "github" && segment !== "agents"),
  ).slice(0, 6);
  const explicitScopes = parseJsonishArray(getFrontmatterValue(attrs, ["scopes", "scope"]));
  const scopes = uniqueStrings([...explicitScopes, ...pathScopes]).slice(0, 8);
  const titlePatterns = uniqueStrings([
    ...titlePatternHints,
    ...keywordTokens(name, { minLength: 4 }).slice(0, 4).map((token) => `\\b${token.replace(/[.*+?^${}()|[\\]\\]/g, "")}\\b`),
  ]);
  const promptId = `${id}-prompt`;

  if (importPrompts && body) {
    upsertEntry(rootDir, {
      id: promptId,
      type: "prompt",
      name: `${name} Prompt`,
      description: `Imported prompt from ${known?.name || repoUrl}`,
      tags: uniqueStrings(["imported", "agent-prompt", sourceId || "external"]),
      meta: {
        sourceId: sourceId || null,
        repoUrl,
        branch,
        relPath,
      },
    }, body);
    imported.push({ id: promptId, name: `${name} Prompt`, relPath, type: "prompt", promptId: null });
    importedByType.prompt += 1;
  }

  const explicitAgentType = String(getFrontmatterValue(attrs, ["agentType", "agent_type"]) || "").trim().toLowerCase();
  const profile = {
    id,
    name,
    description,
    titlePatterns: titlePatterns.length ? titlePatterns : ["\\btask\\b"],
    scopes,
    sdk: null,
    model: null,
    promptOverride: importPrompts && body ? promptId : null,
    skills: profileSkillHints,
    hookProfile: null,
    env: {},
    enabledTools: toolHints.length ? toolHints : null,
    enabledMcpServers: mcpHints,
    tags,
    agentType: explicitAgentType || (/voice|audio|realtime/i.test(`${name} ${description}`) ? "voice" : "task"),
    importMeta: {
      sourceId: sourceId || null,
      repoUrl,
      branch,
      relPath,
    },
  };

  upsertEntry(rootDir, {
    id,
    type: "agent",
    name,
    description,
    tags: profile.tags,
    meta: {
      sourceId: sourceId || null,
      repoUrl,
      branch,
      relPath,
    },
  }, profile, { skipIndexSync: true });

  imported.push({ id, name, relPath, type: "agent", promptId: importPrompts && body ? promptId : null });
  importedByType.agent += 1;
  return { needsAgentIndexRefresh: true, needsSkillIndexRefresh: false };
}

function importRepositoryMcpEntries(rootDir, checkoutDir, context) {
  const { sourceId, repoUrl, branch, takenIds, imported, importedByType } = context;
  for (const mcp of discoverRepositoryMcpConfigs(checkoutDir)) {
    const baseId = slugify(`${sourceId || "imported"}-${mcp.id}`) || slugify(mcp.id) || `imported-mcp-${imported.length + 1}`;
    const id = ensureUniqueId(baseId, takenIds);
    const content = {
      id,
      name: mcp.name,
      description: "Imported MCP server definition from " + mcp.relPath,
      transport: mcp.transport,
      command: mcp.transport === "stdio" ? mcp.command : undefined,
      args: mcp.transport === "stdio" ? mcp.args : undefined,
      url: mcp.transport === "url" ? mcp.url : undefined,
      env: Object.keys(mcp.env || {}).length ? mcp.env : undefined,
      source: "imported",
      stabilityTier: "experimental",
      installSurface: "repository-import",
      tags: ["imported", "mcp", sourceId || "external"],
    };
    upsertEntry(rootDir, {
      id,
      type: "mcp",
      name: mcp.name,
      description: content.description,
      tags: uniqueStrings(["imported", "mcp", sourceId || "external"]),
      stabilityTier: "experimental",
      installSurface: "repository-import",
      meta: {
        sourceId: sourceId || null,
        repoUrl,
        branch,
        relPath: mcp.relPath,
      },
    }, content);
    imported.push({ id, name: mcp.name, relPath: mcp.relPath, type: "mcp", promptId: null });
    importedByType.mcp += 1;
  }
}

export function importAgentProfilesFromRepository(rootDir, options = {}) {
  const { sourceId, known, repoUrl, branch } = resolveRepositoryImportSource(options);
  const importAgents = options?.importAgents !== false;
  const importSkills = options?.importSkills !== false;
  const importPrompts = options?.importPrompts !== false;
  const importTools = options?.importTools !== false;
  const includeEntries = Array.isArray(options?.includeEntries) ? new Set(options.includeEntries.map((e) => String(e || "").trim()).filter(Boolean)) : null;
  const maxProfiles = Math.max(
    1,
    Math.min(
      2000,
      Number.parseInt(String(options?.maxEntries ?? options?.maxProfiles ?? ""), 10) ||
        (includeEntries ? 2000 : 100),
    ),
  );

  const checkoutDir = createRepositoryImportCheckoutDir("import", repoUrl, branch);
  const { candidates: rawCandidates } = collectRepositoryImportMarkdownCandidates(checkoutDir, { maxEntries: maxProfiles });
  const filtered = filterRepositoryImportCandidates(rawCandidates, {
    rootDir,
    repoUrl,
    checkoutDir,
    configData: options?.configData || {},
    auditChannel: "library-import-import",
  });
  const candidates = filtered.candidates;

  const takenIds = new Set(
    listEntries(rootDir).map((entry) => String(entry?.id || "").trim()).filter(Boolean),
  );
  const imported = [];
  const importedByType = { agent: 0, prompt: 0, skill: 0, mcp: 0 };
  let needsAgentIndexRefresh = false;
  let needsSkillIndexRefresh = false;

  try {
    for (const candidate of candidates) {
      const { relPath } = candidate;
      if (includeEntries && !includeEntries.has(relPath)) continue;
      const result = importRepositoryMarkdownCandidate(rootDir, candidate, {
        known,
        repoUrl,
        branch,
        sourceId,
        importAgents,
        importSkills,
        importPrompts,
        takenIds,
        imported,
        importedByType,
      });
      needsAgentIndexRefresh = needsAgentIndexRefresh || result.needsAgentIndexRefresh;
      needsSkillIndexRefresh = needsSkillIndexRefresh || result.needsSkillIndexRefresh;
    }

    if (importTools) {
      importRepositoryMcpEntries(rootDir, checkoutDir, {
        sourceId,
        repoUrl,
        branch,
        takenIds,
        imported,
        importedByType,
      });
    }
  } finally {
    try { rmSync(checkoutDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch {}
  }

  if (needsAgentIndexRefresh) rebuildAgentProfileIndex(rootDir);
  if (needsSkillIndexRefresh) rebuildSkillEntryIndex(rootDir);

  return {
    ok: true,
    source: known ? { ...known } : { id: sourceId || "custom", repoUrl, defaultBranch: branch },
    repoUrl,
    branch,
    importedCount: imported.length,
    importedByType,
    imported,
    blockedCandidates: filtered.blockedCandidates,
    blockedCandidatesByType: filtered.blockedCandidatesByType,
  };
}

// ── Scope Auto-Detection ─────────────────────────────────────────────────────

/**
 * Auto-detect available scopes for a repository by scanning:
 * 1. Git commit history (conventional commit scopes)
 * 2. Top-level folder structure
 *
 * @param {string} repoRoot - repository root path
 * @param {{ maxCommits?: number }} [opts]
 * @returns {{ scopes: Array<{ name: string, source: string, count?: number }> }}
 */
export function detectScopes(repoRoot, opts = {}) {
  const { maxCommits = 200 } = opts;
  const scopes = new Map(); // name → { source, count }

  // 1. Scan git commit history for conventional commit scopes
  try {
    const gitEnv = { ...process.env };
    delete gitEnv.GIT_DIR;
    delete gitEnv.GIT_WORK_TREE;
    delete gitEnv.GIT_INDEX_FILE;
    delete gitEnv.GIT_COMMON_DIR;
    delete gitEnv.GIT_PREFIX;
    const safeMaxCommits = Math.max(1, Math.min(5000, Number.parseInt(String(maxCommits), 10) || 200));
    const logResult = spawnSync(
      "git",
      ["log", "--oneline", "-" + safeMaxCommits, "--format=%s"],
      {
        cwd: repoRoot,
        env: gitEnv,
        encoding: "utf8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (logResult.error) throw logResult.error;
    if (logResult.status !== 0) {
      throw new Error(String(logResult.stderr || logResult.stdout || "git log failed").trim());
    }
    const log = String(logResult.stdout || "");
    const scopeRegex = /(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)\(([^)]+)\)/gi;
    for (const line of log.split("\n")) {
      let m;
      while ((m = scopeRegex.exec(line)) !== null) {
        const name = m[1].toLowerCase().trim();
        if (!name) continue;
        const existing = scopes.get(name);
        if (existing) {
          existing.count++;
        } else {
          scopes.set(name, { name, source: "git", count: 1 });
        }
      }
    }
  } catch {
    // git not available or not a repo – skip
  }

  // 2. Scan top-level folders
  try {
    const entries = readdirSync(repoRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name.toLowerCase();
      // Skip common non-scope directories
      if (/^(\.|node_modules|dist|build|out|coverage|__pycache__|\.git)$/.test(name)) continue;
      if (!scopes.has(name)) {
        scopes.set(name, { name, source: "folder", count: 0 });
      } else {
        // If already from git, mark as both
        const existing = scopes.get(name);
        if (existing.source === "git") existing.source = "git+folder";
      }
    }
  } catch {
    // can't read directory
  }

  // Sort: git scopes first (by count desc), then folder scopes alphabetically
  const result = [...scopes.values()].sort((a, b) => {
    if (a.source.startsWith("git") && !b.source.startsWith("git")) return -1;
    if (!a.source.startsWith("git") && b.source.startsWith("git")) return 1;
    if (a.count !== b.count) return (b.count || 0) - (a.count || 0);
    return a.name.localeCompare(b.name);
  });

  return { scopes: result };
}

// ── Namespaced Reference Resolution ──────────────────────────────────────────

/**
 * Resolve `{{prompt:name}}`, `{{agent:name}}`, `{{skill:name}}` references
 * within a template string.
 *
 * @param {string} template     - template string with `{{type:name}}` placeholders
 * @param {string} rootDir      - workspace/bosun home root
 * @param {Object} [extraVars]  - additional simple `{{KEY}}` variables
 * @returns {string}
 */
export function resolveLibraryRefs(template, rootDir, extraVars = {}) {
  if (typeof template !== "string") return "";

  // First resolve namespaced refs: {{prompt:name}}, {{agent:name}}, {{skill:name}}, {{mcp:name}}
  let resolved = template.replace(
    /\{\{\s*(prompt|agent|skill|mcp):([A-Za-z0-9_-]+)\s*\}\}/gi,
    (_full, type, name) => {
      const typeLower = type.toLowerCase();
      const id = slugify(name);
      const entry = getEntry(rootDir, id);
      if (!entry || entry.type !== typeLower) {
        // Try a fuzzy lookup by name
        const entries = listEntries(rootDir, { type: typeLower });
        const byName = entries.find(
          (e) => e.id === id || slugify(e.name) === id || e.name.toLowerCase() === name.toLowerCase(),
        );
        if (byName) {
          const content = getEntryContent(rootDir, byName);
          if (content) return typeof content === "object" ? JSON.stringify(content) : content;
        }
        return `<!-- [library:${typeLower}:${name} not found] -->`;
      }
      const content = getEntryContent(rootDir, entry);
      if (!content) return `<!-- [library:${typeLower}:${name} empty] -->`;
      return typeof content === "object" ? JSON.stringify(content) : content;
    },
  );

  // Then resolve simple {{KEY}} variables
  if (extraVars && Object.keys(extraVars).length) {
    const normalized = {};
    for (const [k, v] of Object.entries(extraVars)) {
      normalized[String(k).trim().toUpperCase()] = v == null ? "" : String(v);
    }
    resolved = resolved.replace(
      /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g,
      (full, key) => {
        const hit = normalized[String(key).toUpperCase()];
        return hit != null ? hit : full; // Keep unresolved simple vars as-is
      },
    );
  }

  return resolved;
}
// ── Manifest Rebuild / Sync ──────────────────────────────────────────────────

/**
 * Rebuild the manifest by scanning the actual directories for files.
 * Merges with existing manifest data to preserve metadata.
 *
 * @param {string} rootDir
 * @returns {{ entries: LibraryEntry[], added: number, removed: number }}
 */
export function rebuildManifest(rootDir) {
  const existing = loadManifest(rootDir);
  const existingById = new Map(existing.entries.map((e) => [e.id, e]));
  const newEntries = [];
  let added = 0;
  let removed = 0;

  for (const type of RESOURCE_TYPES) {
    // custom-tool entries are self-managed by agent-custom-tools.mjs
    // (see TOOL_DIR / tools/index.json) — skip here to avoid double-indexing
    if (type === "custom-tool") continue;

    const dir = dirForType(rootDir, type);
    if (!existsSync(dir)) continue;

    const ext = extForType(type);
    let files = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(ext));
    } catch { continue; }

    for (const filename of files) {
      const filePath = resolve(dir, filename);
      let stat;
      try { stat = statSync(filePath); } catch { continue; }

      // Derive id from filename
      const id = slugify(basename(filename, ext));
      const existing = existingById.get(id);

      if (existing && existing.type === type) {
        // Keep existing metadata, update timestamp
        newEntries.push({ ...existing, updatedAt: stat.mtime.toISOString() });
        existingById.delete(id);
      } else {
        // New file not in manifest
        let name = basename(filename, ext)
          .replace(/-/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase());
        let description = "";
        let tags = [];

        // Try to extract metadata from file content
        try {
          const content = readFileSync(filePath, "utf8");
          if (type === "agent") {
            const parsed = JSON.parse(content);
            name = parsed.name || name;
            description = parsed.description || "";
            tags = parsed.tags || [];
          } else {
            // Markdown: extract title from first heading
            const h1 = /^#\s+(?:Skill:\s*)?(.+)/m.exec(content);
            if (h1) name = h1[1].trim();
            // Extract tags from comment
            const tagMatch = /<!--\s*tags:\s*(.+?)\s*-->/i.exec(content);
            if (tagMatch) {
              tags = tagMatch[1].split(/[,\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
            }
            // Extract description from first paragraph after heading
            const descMatch = /^#.+\n+(?:>\s*)?(.+)/m.exec(content);
            if (descMatch) description = descMatch[1].trim().slice(0, 200);
          }
        } catch { /* ignore parse errors */ }

        newEntries.push({
          id,
          type,
          name,
          description,
          filename,
          tags,
          scope: "global",
          workspace: null,
          meta: {},
          createdAt: stat.birthtime?.toISOString?.() || nowISO(),
          updatedAt: stat.mtime.toISOString(),
        });
        added++;
      }
    }
  }

  // Entries left in existingById were not found on disk → removed
  removed = existingById.size;

  const manifest = { entries: newEntries, generated: nowISO() };
  saveManifest(rootDir, manifest);
  rebuildAgentProfileIndex(rootDir, manifest);
  rebuildSkillEntryIndex(rootDir, manifest);

  return { entries: newEntries, added, removed };
}

// ── Multi-Workspace Resolution Chain ─────────────────────────────────────────

/**
 * Resolve a library reference across the workspace chain:
 *   1. Workspace-local (.bosun/ under workspace root)
 *   2. Global (BOSUN_HOME/.bosun/)
 *
 * @param {string} workspaceRoot
 * @param {string} id
 * @returns {{ entry: LibraryEntry|null, content: string|Object|null, source: string }}
 */
export function resolveEntry(workspaceRoot, id) {
  // 1. Check workspace-local
  if (workspaceRoot) {
    const entry = getEntry(workspaceRoot, id);
    if (entry) {
      const content = getEntryContent(workspaceRoot, entry);
      if (content) return { entry, content, source: "workspace" };
    }
  }

  // 2. Check global
  const globalRoot = getBosunHomeDir();
  if (globalRoot !== workspaceRoot) {
    const entry = getEntry(globalRoot, id);
    if (entry) {
      const content = getEntryContent(globalRoot, entry);
      if (content) return { entry, content, source: "global" };
    }
  }

  return { entry: null, content: null, source: "none" };
}

// ── Built-in Agent Profile Templates ─────────────────────────────────────────

export const BUILTIN_AGENT_PROFILES = [
  {
    id: "ui-agent",
    name: "UI Agent",
    description: "Front-end specialist for portal and UI tasks. Auto-selected for feat(portal), feat(ui), fix(portal) tasks.",
    titlePatterns: ["\\(portal\\)", "\\(ui\\)", "\\(frontend\\)", "\\(web\\)", "\\(css\\)", "\\bUI\\b", "\\bfrontend\\b"],
    scopes: ["portal", "ui", "frontend", "web", "css"],
    sdk: null,
    model: null,
    promptOverride: "frontend-agent",
    skills: ["frontend-patterns"],
    hookProfile: null,
    env: {},
    tags: ["ui", "frontend", "portal", "css", "web"],
    agentType: "task",
  },
  {
    id: "backend-agent",
    name: "Backend Agent",
    description: "Backend/API specialist. Auto-selected for feat(api), feat(server), feat(db) tasks.",
    titlePatterns: ["\\(api\\)", "\\(server\\)", "\\(db\\)", "\\(backend\\)", "\\bAPI\\b", "\\bserver\\b"],
    scopes: ["api", "server", "db", "backend"],
    sdk: null,
    model: null,
    promptOverride: null,
    skills: ["background-task-execution"],
    hookProfile: null,
    env: {},
    tags: ["api", "server", "backend", "database"],
    agentType: "task",
  },
  {
    id: "devops-agent",
    name: "DevOps Agent",
    description: "CI/CD and infrastructure specialist. Auto-selected for ci(), build(), infra() tasks.",
    titlePatterns: ["\\(ci\\)", "\\(cd\\)", "\\(build\\)", "\\(infra\\)", "\\(deploy\\)", "\\bCI\\b", "\\bCD\\b", "\\bpipeline\\b"],
    scopes: ["ci", "cd", "build", "infra", "deploy"],
    sdk: null,
    model: null,
    promptOverride: null,
    skills: [],
    hookProfile: null,
    env: {},
    tags: ["ci", "cd", "build", "deploy", "infra", "devops"],
    agentType: "task",
  },
  {
    id: "docs-agent",
    name: "Docs Agent",
    description: "Documentation specialist. Auto-selected for docs() tasks.",
    titlePatterns: ["\\(docs\\)", "\\(readme\\)", "\\bdocumentation\\b", "\\bREADME\\b", "\\baudit\\b", "\\bannotat"],
    scopes: ["docs", "readme", "audit"],
    sdk: null,
    model: null,
    promptOverride: null,
    skills: ["codebase-annotation-audit"],
    hookProfile: null,
    env: {},
    tags: ["docs", "documentation", "readme", "markdown", "audit", "annotation"],
    agentType: "task",
  },
  {
    id: "test-agent",
    name: "Test Agent",
    description: "Testing specialist. Auto-selected for test() tasks.",
    titlePatterns: ["\\(test\\)", "\\(tests\\)", "\\(e2e\\)", "\\(unit\\)", "\\btesting\\b"],
    scopes: ["test", "tests", "e2e", "unit"],
    sdk: null,
    model: null,
    promptOverride: null,
    skills: [],
    hookProfile: null,
    env: {},
    tags: ["test", "testing", "e2e", "unit", "coverage"],
    agentType: "task",
  },
  {
    id: "voice-agent-female",
    name: "Voice Agent (Female)",
    description: "Conversational voice specialist with concise guidance and call-friendly pacing.",
    titlePatterns: ["\\bvoice\\b", "\\bcall\\b", "\\bmeeting\\b", "\\bassistant\\b"],
    scopes: ["voice", "assistant"],
    sdk: null,
    model: null,
    promptOverride: null,
    skills: ["concise-voice-guidance", "conversation-memory"],
    hookProfile: null,
    env: {},
    tags: ["voice", "assistant", "realtime", "female", "default", "audio-agent"],
    agentType: "voice",
    voiceAgent: true,
    voicePersona: "female",
    voiceInstructions: "You are Nova, a female voice agent. You are NOT ChatGPT — never identify yourself as ChatGPT or any other AI assistant. Your name is Nova. Be concise, warm, and practical. Use tools for facts and execution. Keep spoken responses short and clear.",
    enabledTools: null,
    enabledMcpServers: [],
    customModes: [
      {
        id: "voice-command",
        description: "Execute voice commands with full tool access",
        prefix: "[MODE: voice-command] Execute the user's request using available tools. Always call tools when they can answer the question.\n\n",
      },
    ],
  },
  {
    id: "voice-agent-male",
    name: "Voice Agent (Male)",
    description: "Operational voice specialist focused on diagnostics and execution.",
    titlePatterns: ["\\bvoice\\b", "\\bcall\\b", "\\bmeeting\\b", "\\bassistant\\b"],
    scopes: ["voice", "assistant"],
    sdk: null,
    model: null,
    promptOverride: null,
    skills: ["ops-diagnostics", "task-execution"],
    hookProfile: null,
    env: {},
    tags: ["voice", "assistant", "realtime", "male", "default", "audio-agent"],
    agentType: "voice",
    voiceAgent: true,
    voicePersona: "male",
    voiceInstructions: "You are Atlas, a male voice agent. You are NOT ChatGPT — never identify yourself as ChatGPT or any other AI assistant. Your name is Atlas. Be direct and execution-oriented. Prefer actionable status updates. Use tools proactively for diagnostics.",
    enabledTools: null,
    enabledMcpServers: [],
  },
  {
    id: "voice-agent",
    name: "Voice Agent",
    description: "Default voice assistant agent. Handles real-time voice sessions, tool calls, and delegate orchestration. Customize tools and MCP servers for voice interactions.",
    titlePatterns: ["\\bvoice\\b", "\\bcall\\b", "\\bmeeting\\b", "\\bassistant\\b"],
    scopes: ["voice", "assistant"],
    sdk: null,
    model: null,
    promptOverride: null,
    skills: [],
    hookProfile: null,
    env: {},
    tags: ["voice", "assistant", "realtime", "default"],
    agentType: "voice",
    voiceAgent: true,
    voicePersona: "neutral",
    voiceInstructions: "You are Bosun, a voice assistant for the VirtEngine development platform. Be helpful, concise, and professional. Use tools to answer questions and execute tasks.",
    enabledTools: null,
    enabledMcpServers: [],
  },
];

/**
 * Scaffold built-in agent profiles into the profiles directory.
 * Does not overwrite existing profiles.
 *
 * @param {string} rootDir
 * @returns {{ written: string[], skipped: string[] }}
 */
export function scaffoldAgentProfiles(rootDir) {
  const dir = ensureDir(dirForType(rootDir, "agent"));
  const written = [];
  const skipped = [];

  for (const profile of BUILTIN_AGENT_PROFILES) {
    const filePath = resolve(dir, `${profile.id}.json`);
    if (existsSync(filePath)) {
      skipped.push(filePath);
      continue;
    }
    writeFileSync(filePath, JSON.stringify(profile, null, 2) + "\n", "utf8");
    written.push(filePath);
  }

  return { written, skipped };
}

/**
 * Initialize the full library for a root directory.
 * Scaffolds profiles, rebuilds manifest.
 *
 * @param {string} rootDir
 * @returns {{ manifest: Object, scaffolded: Object }}
 */
export function initLibrary(rootDir) {
  const scaffolded = scaffoldAgentProfiles(rootDir);
  const manifest = rebuildManifest(rootDir);
  const autoSynced = syncAutoDiscoveredLibraryEntries(rootDir);
  const latestManifest = loadManifest(rootDir);
  return {
    manifest: latestManifest?.entries ? latestManifest : manifest,
    scaffolded,
    autoSynced,
  };
}
