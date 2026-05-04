/**
 * mcp-registry.mjs — Centralized MCP Server Registry & Management
 *
 * Provides a curated catalog of popular MCP servers that can be installed
 * with one click, plus helpers to resolve installed servers for injection
 * into agent launches (Codex config.toml, Copilot CLI args, Claude env).
 *
 * Storage: installed servers are persisted as `type: "mcp"` entries in the
 * existing library system (`.bosun/mcp-servers/*.json` + `library.json`).
 *
 * EXPORTS:
 *   CURATED_MCP_CATALOG       — frozen array of known-good MCP server defs
 *   MCP_STABILITY_TIERS       — supported registry stability tiers
 *   RESEARCH_MCP_BUNDLES      — first-class research/scientific tool bundles
 *   listCatalog()             — read-only catalog query
 *   getCatalogEntry(id)       — single catalog entry by ID
 *   listResearchToolBundles() — available research/scientific tool bundles
 *   getResearchToolBundle()   — normalized research tool bundle by ID
 *   installMcpServer()        — one-click install from catalog or custom def
 *   uninstallMcpServer()      — remove an installed server
 *   listInstalledMcpServers() — all installed MCP servers
 *   getInstalledMcpServer()   — single installed server by ID
 *   resolveMcpServersForAgent() — resolve IDs to full configs for SDK injection
 *   wrapServersWithDiscoveryProxy() — collapse many servers into one discovery proxy
 *   buildCodexMcpToml()       — convert configs → Codex TOML blocks
 *   buildCopilotMcpJson()     — convert configs → Copilot MCP JSON
 *   buildClaudeMcpEnv()       — convert configs → Claude MCP env format
 */

import { resolve, join, dirname } from "node:path";
import { existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import "../infra/windows-hidden-child-processes.mjs";
import { listCustomTools } from "../agent/agent-custom-tools.mjs";

// Lazy-import library manager to avoid circular dependency at module load.
// Cached at module scope per AGENTS.md hard rules.
let _libManager = null;
async function getLibManager() {
  if (!_libManager) {
    _libManager = await import("../infra/library-manager.mjs");
  }
  return _libManager;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TAG = "[mcp-registry]";
const __dirname = dirname(fileURLToPath(import.meta.url));
const DISCOVERY_PROXY_SCRIPT = resolve(__dirname, "mcp-discovery-proxy.mjs");
const DISCOVERY_PROXY_ID = "bosun-discovery-proxy";
const DEFAULT_SHARED_HOST_STARTUP_TIMEOUT_MS = 5_000;
export const MCP_STABILITY_TIERS = Object.freeze(["verified", "experimental"]);
export const RESEARCH_MCP_BUNDLES = Object.freeze([
  Object.freeze({
    id: "scientific-evidence",
    name: "Scientific Evidence",
    description:
      "Literature-first research bundle for Bosun evidence workflows: web search, document retrieval, PDF-capable corpus review, and runtime log evidence.",
    recommendedMcpServers: Object.freeze(["fetch", "filesystem", "context7"]),
    optionalMcpServers: Object.freeze(["exa", "brave-search", "microsoft-docs"]),
    nativeCapabilities: Object.freeze([
      Object.freeze({
        id: "pdf-corpus-ingestion",
        name: "PDF Corpus Ingestion",
        description: "Bosun sidecar extracts and scores local PDF/text corpus files for grounded evidence bundles.",
      }),
      Object.freeze({
        id: "runtime-log-query",
        name: "Runtime Log Query",
        description: "Bosun sidecar can pull bounded monitor/error/runtime log snippets into the same evidence artifact.",
      }),
      Object.freeze({
        id: "reviewed-finding-promotion",
        name: "Reviewed Finding Promotion",
        description: "Only verifier-approved findings are promoted into shared knowledge while raw evidence stays in sidecar artifacts.",
      }),
    ]),
    preferredSearchServers: Object.freeze(["exa", "brave-search", "fetch"]),
    preferredDocumentServers: Object.freeze(["fetch", "filesystem", "context7", "microsoft-docs"]),
    evidenceWorkflowIds: Object.freeze(["template-research-evidence-agent"]),
    tags: Object.freeze(["research", "scientific-evidence", "citations", "pdf", "runtime-logs"]),
  }),
]);

export function normalizeMcpStabilityTier(value, { fallback = "experimental" } = {}) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "verified" || normalized === "stable" || normalized === "production") {
    return "verified";
  }
  if (
    normalized === "experimental"
    || normalized === "unverified"
    || normalized === "preview"
    || normalized === "beta"
  ) {
    return "experimental";
  }
  return fallback;
}

function normalizeResearchBundle(bundle) {
  if (!bundle || typeof bundle !== "object") return null;
  return {
    ...bundle,
    recommendedMcpServers: Array.isArray(bundle.recommendedMcpServers) ? [...bundle.recommendedMcpServers] : [],
    optionalMcpServers: Array.isArray(bundle.optionalMcpServers) ? [...bundle.optionalMcpServers] : [],
    preferredSearchServers: Array.isArray(bundle.preferredSearchServers) ? [...bundle.preferredSearchServers] : [],
    preferredDocumentServers: Array.isArray(bundle.preferredDocumentServers) ? [...bundle.preferredDocumentServers] : [],
    nativeCapabilities: Array.isArray(bundle.nativeCapabilities)
      ? bundle.nativeCapabilities.map((entry) => ({ ...entry }))
      : [],
    evidenceWorkflowIds: Array.isArray(bundle.evidenceWorkflowIds) ? [...bundle.evidenceWorkflowIds] : [],
    tags: Array.isArray(bundle.tags) ? [...bundle.tags] : [],
  };
}

function normalizeCatalogEntry(entry) {
  if (!entry || typeof entry !== "object") return entry;
  const stabilityTier = normalizeMcpStabilityTier(entry.stabilityTier, {
    fallback: entry.source === "catalog" ? "verified" : "experimental",
  });
  return {
    ...entry,
    stabilityTier,
    installSurface: entry.installSurface || "curated",
    tags: Array.isArray(entry.tags) ? [...entry.tags] : [],
  };
}

/**
 * Curated catalog of popular, reliable MCP servers.
 * Each entry describes how to launch or connect to the server.
 *
 * Transport types:
 *   "stdio"  — launch via command+args, communicate over stdin/stdout
 *   "url"    — connect to a remote HTTP/SSE endpoint
 */
export const CURATED_MCP_CATALOG = Object.freeze([
  // ── Official / Microsoft / GitHub ────────────────────────────────────────
  {
    id: "github",
    name: "GitHub",
    description: "GitHub API — repositories, issues, PRs, code search, actions",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@anthropic/mcp-github"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "" },
    tags: ["github", "vcs", "official"],
    stabilityTier: "verified",
    source: "catalog",
    homepage: "https://github.com/anthropics/github-mcp-server",
  },
  {
    id: "microsoft-docs",
    name: "Microsoft Docs",
    description: "Microsoft Learn documentation search and retrieval",
    transport: "url",
    url: "https://learn.microsoft.com/api/mcp",
    tags: ["docs", "microsoft", "official"],
    stabilityTier: "verified",
    source: "catalog",
    homepage: "https://learn.microsoft.com",
  },
  {
    id: "context7",
    name: "Context7",
    description: "Up-to-date library documentation and code examples",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@upstash/context7-mcp"],
    tags: ["docs", "libraries", "community"],
    stabilityTier: "verified",
    source: "catalog",
    homepage: "https://github.com/nicepkg/context7",
  },
  // ── Official MCP Reference Servers ───────────────────────────────────────
  {
    id: "sequential-thinking",
    name: "Sequential Thinking",
    description: "Dynamic, reflective problem-solving through structured thought sequences",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    tags: ["reasoning", "official"],
    stabilityTier: "verified",
    source: "catalog",
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  {
    id: "filesystem",
    name: "Filesystem",
    description: "Secure file system operations with configurable access controls",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    tags: ["filesystem", "official"],
    stabilityTier: "verified",
    source: "catalog",
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  {
    id: "fetch",
    name: "Fetch",
    description: "Web content fetching and conversion for efficient LLM usage",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-fetch"],
    tags: ["web", "http", "official"],
    stabilityTier: "verified",
    source: "catalog",
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  {
    id: "memory",
    name: "Memory",
    description: "Knowledge graph-based persistent memory for entities and relations",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    tags: ["memory", "knowledge-graph", "official"],
    stabilityTier: "verified",
    source: "catalog",
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  {
    id: "postgres",
    name: "PostgreSQL",
    description: "Read-only PostgreSQL database access with schema inspection",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres"],
    env: { POSTGRES_CONNECTION_STRING: "" },
    tags: ["database", "postgres", "official"],
    stabilityTier: "verified",
    source: "catalog",
    homepage: "https://github.com/modelcontextprotocol/servers",
  },
  // ── Browser / UI Testing ────────────────────────────────────────────────
  {
    id: "playwright",
    name: "Playwright",
    description: "Browser automation — navigate, interact, screenshot, test web apps",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest"],
    tags: ["browser", "testing", "automation", "official"],
    stabilityTier: "verified",
    source: "catalog",
    homepage: "https://github.com/nicholasrq/playwright-mcp",
  },
  {
    id: "puppeteer",
    name: "Puppeteer",
    description: "Chrome automation via Puppeteer for browser control and screenshots",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@anthropic/mcp-puppeteer"],
    tags: ["browser", "testing", "screenshot"],
    stabilityTier: "experimental",
    source: "catalog",
    homepage: "https://github.com/anthropics/puppeteer-mcp-server",
  },
  // ── Search / Knowledge ──────────────────────────────────────────────────
  {
    id: "brave-search",
    name: "Brave Search",
    description: "Web and local search using the Brave Search API",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@anthropic/mcp-brave-search"],
    env: { BRAVE_API_KEY: "" },
    tags: ["search", "web"],
    stabilityTier: "experimental",
    source: "catalog",
    homepage: "https://github.com/anthropics/brave-search-mcp-server",
  },
  {
    id: "exa",
    name: "Exa Search",
    description: "Neural search engine for precise, up-to-date web results",
    transport: "stdio",
    command: "npx",
    args: ["-y", "exa-mcp-server"],
    env: { EXA_API_KEY: "" },
    tags: ["search", "web", "ai"],
    stabilityTier: "experimental",
    source: "catalog",
    homepage: "https://github.com/nicepkg/exa-mcp-server",
  },
  // ── Productivity / Project Management ───────────────────────────────────
  {
    id: "linear",
    name: "Linear",
    description: "Linear project management — issues, projects, teams",
    transport: "stdio",
    command: "npx",
    args: ["-y", "mcp-linear"],
    env: { LINEAR_API_KEY: "" },
    tags: ["project-management", "issues"],
    stabilityTier: "experimental",
    source: "catalog",
    homepage: "https://github.com/nicepkg/mcp-linear",
  },
  {
    id: "slack",
    name: "Slack",
    description: "Slack workspace messaging, channels, and search",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@anthropic/mcp-slack"],
    env: { SLACK_BOT_TOKEN: "", SLACK_TEAM_ID: "" },
    tags: ["messaging", "slack"],
    stabilityTier: "experimental",
    source: "catalog",
    homepage: "https://github.com/anthropics/slack-mcp-server",
  },
  // ── Storage / Cloud ─────────────────────────────────────────────────────
  {
    id: "google-drive",
    name: "Google Drive",
    description: "Google Drive file search and retrieval",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@anthropic/mcp-google-drive"],
    tags: ["cloud", "storage", "google"],
    stabilityTier: "experimental",
    source: "catalog",
    homepage: "https://github.com/anthropics/google-drive-mcp-server",
  },
].map((entry) => Object.freeze(normalizeCatalogEntry(entry))));

// ── Catalog Queries ───────────────────────────────────────────────────────────

/**
 * List catalog entries, defaulting to the verified install surface.
 * @param {{ tags?: string[], stabilityTier?: string, includeExperimental?: boolean }} [options]
 * @returns {ReadonlyArray<Object>}
 */
export function listCatalog({ tags, stabilityTier, includeExperimental = false } = {}) {
  const normalizedTier = normalizeMcpStabilityTier(stabilityTier, { fallback: null });
  const tagSet = tags?.length
    ? new Set(tags.map((t) => String(t || "").trim().toLowerCase()).filter(Boolean))
    : null;
  return CURATED_MCP_CATALOG.filter((entry) => {
    if (normalizedTier && entry.stabilityTier !== normalizedTier) return false;
    if (!normalizedTier && includeExperimental === false && entry.stabilityTier !== "verified") {
      return false;
    }
    if (tagSet && !entry.tags.some((t) => tagSet.has(t.toLowerCase()))) return false;
    return true;
  });
}

/**
 * Get a single catalog entry by ID.
 * @param {string} id
 * @returns {Object|null}
 */
export function getCatalogEntry(id) {
  const normalized = String(id || "").trim().toLowerCase();
  return CURATED_MCP_CATALOG.find((e) => e.id === normalized) || null;
}

export function listResearchToolBundles() {
  return RESEARCH_MCP_BUNDLES.map((bundle) => normalizeResearchBundle(bundle));
}

export function getResearchToolBundle(id = "scientific-evidence", options = {}) {
  const normalizedId = String(id || "scientific-evidence").trim().toLowerCase() || "scientific-evidence";
  const includeExperimental = options.includeExperimental !== false;
  const bundle = RESEARCH_MCP_BUNDLES.find((entry) => entry.id === normalizedId) || null;
  if (!bundle) return null;
  const normalized = normalizeResearchBundle(bundle);
  const expandServers = (ids) =>
    ids
      .map((serverId) => getCatalogEntry(serverId))
      .filter(Boolean)
      .filter((entry) => includeExperimental || entry.stabilityTier === "verified");
  const recommendedEntries = expandServers(normalized.recommendedMcpServers);
  const optionalEntries = expandServers(normalized.optionalMcpServers);
  return {
    ...normalized,
    recommendedCatalogEntries: recommendedEntries,
    optionalCatalogEntries: optionalEntries,
    recommendedServerIds: recommendedEntries.map((entry) => entry.id),
    optionalServerIds: optionalEntries.map((entry) => entry.id),
  };
}

function normalizeMcpEnv(env = {}, { requireAuth = true } = {}) {
  const normalized = {};
  const missing = [];
  for (const [key, value] of Object.entries(env || {})) {
    const trimmedValue = String(value ?? "").trim();
    if (trimmedValue) {
      normalized[key] = trimmedValue;
      continue;
    }
    const inheritedValue = String(process.env[key] ?? "").trim();
    if (inheritedValue) {
      normalized[key] = inheritedValue;
      continue;
    }
    if (requireAuth) {
      missing.push(key);
    }
  }
  return { env: normalized, missing };
}

function finalizeResolvedServer(server, options = {}) {
  const requireAuth = options.requireAuth !== false;
  const normalizedId = String(server?.id || "").trim();
  if (!normalizedId) {
    return {
      server: null,
      error: `${TAG} resolved MCP server is missing an id`,
    };
  }

  const transport = String(server?.transport || "stdio")
    .trim()
    .toLowerCase();
  const { env, missing } = normalizeMcpEnv(server?.env || {}, { requireAuth });
  if (missing.length > 0) {
    return {
      server: null,
      error: `${TAG} MCP server "${normalizedId}" missing required auth env: ${missing.join(", ")}`,
    };
  }

  if (transport === "url") {
    const url = String(server?.url || "").trim();
    if (!url) {
      return {
        server: null,
        error: `${TAG} MCP server "${normalizedId}" is missing a url`,
      };
    }
    return {
      server: {
        id: normalizedId,
        name: server?.name || normalizedId,
        description: server?.description || "",
        transport,
        url,
        env,
        stabilityTier: normalizeMcpStabilityTier(server?.stabilityTier, { fallback: null }),
        installSurface: server?.installSurface || null,
        source: server?.source || null,
        homepage: server?.homepage || null,
      },
      error: null,
    };
  }

  const command = String(server?.command || "").trim();
  if (!command) {
    return {
      server: null,
      error: `${TAG} MCP server "${normalizedId}" is missing a command`,
    };
  }
  return {
    server: {
      id: normalizedId,
      name: server?.name || normalizedId,
      description: server?.description || "",
      transport,
      command,
      args: Array.isArray(server?.args) ? [...server.args] : [],
      url: null,
      env,
      stabilityTier: normalizeMcpStabilityTier(server?.stabilityTier, { fallback: null }),
      installSurface: server?.installSurface || null,
      source: server?.source || null,
      homepage: server?.homepage || null,
    },
    error: null,
  };
}

// ── Install / Uninstall ───────────────────────────────────────────────────────

/**
 * Install an MCP server from the catalog or a custom definition.
 *
 * Catalog install:
 *   installMcpServer(rootDir, "github")
 *
 * Custom install:
 *   installMcpServer(rootDir, { id: "my-server", name: "My Server", ... })
 *
 * @param {string} rootDir — workspace root
 * @param {string|Object} catalogIdOrDef — catalog ID string or full server def
 * @param {{ envOverrides?: Object }} [options]
 * @returns {Promise<Object>} — the created library entry
 */
export async function installMcpServer(rootDir, catalogIdOrDef, { envOverrides } = {}) {
  const lib = await getLibManager();

  let serverDef;
  if (typeof catalogIdOrDef === "string") {
    const catalogEntry = getCatalogEntry(catalogIdOrDef);
    if (!catalogEntry) {
      throw new Error(`${TAG} MCP server "${catalogIdOrDef}" not found in catalog. Use listCatalog() to see available servers.`);
    }
    // Clone catalog entry so we don't mutate the frozen original
    serverDef = { ...catalogEntry };
  } else if (catalogIdOrDef && typeof catalogIdOrDef === "object") {
    serverDef = { ...catalogIdOrDef };
    if (!serverDef.id) serverDef.id = serverDef.name ? slugify(serverDef.name) : `custom-${randomUUID().slice(0, 8)}`;
    if (!serverDef.name) serverDef.name = serverDef.id;
    serverDef.source = serverDef.source || "custom";
  } else {
    throw new Error(`${TAG} installMcpServer requires a catalog ID string or server definition object`);
  }
  serverDef.stabilityTier = normalizeMcpStabilityTier(serverDef.stabilityTier, {
    fallback: serverDef.source === "catalog" ? "verified" : "experimental",
  });
  serverDef.installSurface = serverDef.installSurface || (serverDef.source === "catalog" ? "curated" : "custom");

  // Apply environment overrides
  if (envOverrides && typeof envOverrides === "object") {
    serverDef.env = { ...(serverDef.env || {}), ...envOverrides };
  }

  // Persist via library manager as type "mcp"
  const entry = lib.upsertEntry(rootDir, {
    type: "mcp",
    id: serverDef.id,
    name: serverDef.name,
    description: serverDef.description || "",
    tags: serverDef.tags || [],
    stabilityTier: serverDef.stabilityTier,
    installSurface: serverDef.installSurface,
    meta: {
      transport: serverDef.transport || "stdio",
      command: serverDef.command || null,
      args: serverDef.args || [],
      url: serverDef.url || null,
      env: serverDef.env || {},
      source: serverDef.source || "catalog",
      homepage: serverDef.homepage || null,
      stabilityTier: serverDef.stabilityTier,
      installSurface: serverDef.installSurface,
    },
  }, serverDef);

  console.log(`${TAG} Installed MCP server: ${entry.id} (${serverDef.transport})`);
  return entry;
}

/**
 * Uninstall an MCP server by ID.
 * @param {string} rootDir
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function uninstallMcpServer(rootDir, id) {
  const lib = await getLibManager();
  const removed = lib.deleteEntry(rootDir, id, { deleteFile: true });
  if (removed) {
    console.log(`${TAG} Uninstalled MCP server: ${id}`);
  }
  return removed;
}

/**
 * List all installed MCP servers.
 * @param {string} rootDir
 * @returns {Promise<Array<Object>>}
 */
export async function listInstalledMcpServers(rootDir) {
  const lib = await getLibManager();
  return lib.listEntries(rootDir, { type: "mcp" });
}

/**
 * Get a single installed MCP server by ID.
 * @param {string} rootDir
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
export async function getInstalledMcpServer(rootDir, id) {
  const lib = await getLibManager();
  const entry = lib.getEntry(rootDir, id);
  if (!entry || entry.type !== "mcp") return null;
  // Merge entry metadata with file content to get full config
  const content = lib.getEntryContent(rootDir, entry);
  return { ...entry, serverConfig: content };
}

// ── Agent Launch Resolution ───────────────────────────────────────────────────

/**
 * Resolve an array of MCP server IDs into full server configurations
 * ready for injection into SDK adapters.
 *
 * @param {string} rootDir
 * @param {string[]} mcpServerIds — array of installed server IDs
 * @param {{ defaultServers?: string[], catalogOverrides?: Object }} [options]
 * @returns {Promise<Array<Object>>} — resolved server configs
 */
export async function resolveMcpServersForAgent(rootDir, mcpServerIds = [], options = {}) {
  const {
    defaultServers = [],
    catalogOverrides = {},
    requireAuth = true,
  } = options;

  // Merge requested IDs with defaults (deduplicate)
  const allIds = [...new Set([...defaultServers, ...mcpServerIds])];
  if (!allIds.length) return [];

  const lib = await getLibManager();
  const resolved = [];

  for (const id of allIds) {
    const entry = lib.getEntry(rootDir, id);
    if (entry && entry.type === "mcp") {
      const content = lib.getEntryContent(rootDir, entry);
      const config = content || entry.meta || {};
      // Apply per-server catalog overrides (e.g. env vars)
      if (catalogOverrides[id]) {
        config.env = { ...(config.env || {}), ...catalogOverrides[id] };
      }
      const finalized = finalizeResolvedServer(
        {
          id: entry.id,
          name: entry.name,
          description: entry.description || config.description || "",
          transport: config.transport || entry.meta?.transport || "stdio",
          command: config.command || entry.meta?.command || null,
          args: config.args || entry.meta?.args || [],
          url: config.url || entry.meta?.url || null,
          env: config.env || entry.meta?.env || {},
          source: config.source || entry.meta?.source || null,
          homepage: config.homepage || entry.meta?.homepage || null,
          stabilityTier: config.stabilityTier || entry.stabilityTier || entry.meta?.stabilityTier || null,
          installSurface: config.installSurface || entry.installSurface || entry.meta?.installSurface || null,
        },
        { requireAuth },
      );
      if (finalized.server) {
        resolved.push(finalized.server);
      } else {
        const catalogEntry = getCatalogEntry(id);
        if (catalogEntry) {
          const fallbackConfig = { ...catalogEntry };
          if (catalogOverrides[id]) {
            fallbackConfig.env = {
              ...(fallbackConfig.env || {}),
              ...catalogOverrides[id],
            };
          }
          const fallback = finalizeResolvedServer(
            {
              id: fallbackConfig.id,
              name: fallbackConfig.name,
              description: fallbackConfig.description || "",
              transport: fallbackConfig.transport,
              command: fallbackConfig.command || null,
              args: fallbackConfig.args || [],
              url: fallbackConfig.url || null,
              env: fallbackConfig.env || {},
              source: fallbackConfig.source || null,
              homepage: fallbackConfig.homepage || null,
              stabilityTier: fallbackConfig.stabilityTier || null,
              installSurface: fallbackConfig.installSurface || null,
            },
            { requireAuth },
          );
          if (fallback.server) {
            console.warn(
              `${TAG} MCP server "${id}" installed config invalid; falling back to curated catalog`,
            );
            resolved.push(fallback.server);
          } else if (fallback.error) {
            console.warn(fallback.error);
          }
        } else if (finalized.error) {
          console.warn(finalized.error);
        }
      }
    } else {
      // Check catalog as fallback (auto-install from catalog)
      const catalogEntry = getCatalogEntry(id);
      if (catalogEntry) {
        const config = { ...catalogEntry };
        if (catalogOverrides[id]) {
          config.env = { ...(config.env || {}), ...catalogOverrides[id] };
        }
        const finalized = finalizeResolvedServer(
          {
            id: config.id,
            name: config.name,
            description: config.description || "",
            transport: config.transport,
            command: config.command || null,
            args: config.args || [],
            url: config.url || null,
            env: config.env || {},
            source: config.source || null,
            homepage: config.homepage || null,
            stabilityTier: config.stabilityTier || null,
            installSurface: config.installSurface || null,
          },
          { requireAuth },
        );
        if (finalized.server) {
          resolved.push(finalized.server);
        } else if (finalized.error) {
          console.warn(finalized.error);
        }
      } else {
        console.warn(`${TAG} MCP server "${id}" not found (installed or catalog), skipping`);
      }
    }
  }

  return resolved;
}

function writeDiscoveryProxyConfig(rootDir, payload) {
  const normalizedRootDir = String(rootDir || "").trim();
  if (!normalizedRootDir) {
    throw new Error(`${TAG} discovery proxy rootDir is required`);
  }
  if (containsUnresolvedTemplate(normalizedRootDir)) {
    throw new Error(`${TAG} discovery proxy rootDir contains an unresolved template: ${normalizedRootDir}`);
  }
  const resolvedRootDir = resolve(normalizedRootDir);
  const normalizedPayload = {
    ...payload,
    rootDir: resolvedRootDir,
  };
  const serialized = JSON.stringify(normalizedPayload, null, 2);
  const digest = createHash("sha1").update(serialized).digest("hex").slice(0, 12);
  const dir = resolve(resolvedRootDir, ".bosun", ".tmp");
  mkdirSync(dir, { recursive: true });
  const filePath = resolve(dir, `mcp-discovery-proxy-${digest}.json`);
  if (!existsSync(filePath) || readFileSync(filePath, "utf8") !== serialized) {
    writeFileSync(filePath, serialized, "utf8");
  }
  return filePath;
}

function containsUnresolvedTemplate(value) {
  const text = String(value || "");
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf("{{", cursor);
    if (open === -1) return false;
    const close = text.indexOf("}}", open + 2);
    if (close === -1) return false;
    if (close > open + 2) return true;
    cursor = open + 2;
  }
  return false;
}

function envFlagEnabled(value, fallback = false) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  return ["1", "true", "yes", "on", "y"].includes(normalized);
}

function sleep(ms) {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms);
    if (typeof timer?.unref === "function") timer.unref();
  });
}

function isProcessAlive(pid) {
  const parsed = Number(pid);
  if (!Number.isInteger(parsed) || parsed <= 0) return false;
  try {
    process.kill(parsed, 0);
    return true;
  } catch {
    return false;
  }
}

function readJsonFileSafe(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, "utf8");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function isSharedDiscoveryHostHealthy(url) {
  const normalized = String(url || "").trim();
  if (!normalized) return false;
  try {
    const healthUrl = new URL(normalized.replace(/\/mcp$/, "/health"));
    const response = await fetch(healthUrl, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureSharedDiscoveryProxyHost(rootDir, configPath, options = {}) {
  const startupTimeoutMs =
    Number(options.startupTimeoutMs) || DEFAULT_SHARED_HOST_STARTUP_TIMEOUT_MS;
  const statePath = String(options.statePath || "")
    .trim() || configPath.replace(/\.json$/i, ".host.json");
  const host = String(options.host || process.env.BOSUN_DISCOVERY_HOST || "127.0.0.1").trim() || "127.0.0.1";

  const existing = readJsonFileSafe(statePath);
  if (existing?.url && isProcessAlive(existing.pid) && await isSharedDiscoveryHostHealthy(existing.url)) {
    return existing;
  }

  const child = spawn(
    process.execPath,
    [DISCOVERY_PROXY_SCRIPT, "--shared-host", configPath, statePath],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: process.platform === "win32",
      cwd: homedir(),
      env: {
        ...process.env,
        BOSUN_DISCOVERY_HOST: host,
        BOSUN_DISCOVERY_HOST_STATE_PATH: statePath,
      },
    },
  );
  child.unref();

  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    const state = readJsonFileSafe(statePath);
    if (state?.url && isProcessAlive(state.pid) && await isSharedDiscoveryHostHealthy(state.url)) {
      return state;
    }
    await sleep(125);
  }

  throw new Error(`${TAG} shared discovery host failed to start within ${startupTimeoutMs}ms`);
}

function buildStdioDiscoveryProxyEntry(configPath, servers, discoveredCustomTools) {
  return [
    {
      id: DISCOVERY_PROXY_ID,
      name: "Bosun Discovery Proxy",
      transport: "stdio",
      command: process.execPath,
      args: [DISCOVERY_PROXY_SCRIPT, configPath],
      env: {
        BOSUN_DISCOVERY_PROXY_CONFIG_PATH: configPath,
      },
      tags: ["bosun", "discovery", "proxy"],
      meta: {
        wrappedServerIds: servers.map((server) => server.id),
        customToolCount: discoveredCustomTools.length,
        sharedHost: false,
      },
    },
  ];
}

export async function wrapServersWithDiscoveryProxy(rootDir, servers = [], options = {}) {
  const {
    enabled = true,
    includeCustomTools = true,
    timeoutMs = 30000,
    cacheTtlMs = 60000,
    executeTimeoutMs = 10000,
    sharedHost = envFlagEnabled(process.env.BOSUN_MCP_DISCOVERY_SHARED, true),
    sharedHostStartupTimeoutMs = DEFAULT_SHARED_HOST_STARTUP_TIMEOUT_MS,
  } = options;

  if (enabled === false) return servers;
  if (Array.isArray(servers) && servers.some((server) => server?.id === DISCOVERY_PROXY_ID)) {
    return servers;
  }

  const normalizedRootDir = String(rootDir || "").trim();
  const discoveredCustomTools = includeCustomTools
    ? listCustomTools(normalizedRootDir, { includeGlobal: true, includeBuiltins: true })
    : [];
  const hasCustomTools = discoveredCustomTools.length > 0;
  const hasWrappedServers = Array.isArray(servers) && servers.length > 0;

  if (!hasWrappedServers && !hasCustomTools) {
    return servers;
  }

  const configPath = writeDiscoveryProxyConfig(normalizedRootDir, {
    rootDir: normalizedRootDir,
    timeoutMs,
    cacheTtlMs,
    executeTimeoutMs,
    includeCustomTools,
    servers,
  });

  if (sharedHost === false) {
    return buildStdioDiscoveryProxyEntry(configPath, servers, discoveredCustomTools);
  }

  try {
    const state = await ensureSharedDiscoveryProxyHost(normalizedRootDir, configPath, {
      startupTimeoutMs: sharedHostStartupTimeoutMs,
    });
    return [
      {
        id: DISCOVERY_PROXY_ID,
        name: "Bosun Discovery Proxy",
        transport: "url",
        url: state.url,
        env: {},
        tags: ["bosun", "discovery", "proxy"],
        meta: {
          wrappedServerIds: servers.map((server) => server.id),
          customToolCount: discoveredCustomTools.length,
          sharedHost: true,
          sharedHostPid: state.pid,
        },
      },
    ];
  } catch (error) {
    console.warn(`${TAG} shared discovery host unavailable; falling back to stdio proxy: ${error?.message || error}`);
    return buildStdioDiscoveryProxyEntry(configPath, servers, discoveredCustomTools);
  }
}

// ── SDK-Specific Format Builders ──────────────────────────────────────────────

/**
 * Convert resolved MCP server configs into Codex CLI config.toml format.
 *
 * Example output:
 *   [mcp_servers.github]
 *   command = "npx"
 *   args = ["-y", "@anthropic/mcp-github"]
 *   [mcp_servers.github.env]
 *   GITHUB_PERSONAL_ACCESS_TOKEN = "..."
 *
 * @param {Array<Object>} servers — resolved server configs
 * @returns {string} — TOML string
 */
export function buildCodexMcpToml(servers) {
  if (!servers || !servers.length) return "";

  const lines = [];
  for (const srv of servers) {
    const safeId = String(srv.id).replace(/[^a-zA-Z0-9_-]/g, "_");

    if (srv.transport === "url" && srv.url) {
      lines.push("");
      lines.push(`[mcp_servers.${safeId}]`);
      lines.push(`url = ${toTomlString(srv.url)}`);
    } else if (srv.command) {
      lines.push("");
      lines.push(`[mcp_servers.${safeId}]`);
      lines.push(`command = ${toTomlString(srv.command)}`);
      if (srv.args && srv.args.length) {
        const argsStr = srv.args.map((a) => toTomlString(a)).join(", ");
        lines.push(`args = [${argsStr}]`);
      }
    } else {
      continue; // Skip servers without command or url
    }

    // Write env block if present (skip empty-value keys)
    const envEntries = Object.entries(srv.env || {}).filter(
      ([, v]) => v != null && String(v).trim() !== "",
    );
    if (envEntries.length) {
      lines.push(`[mcp_servers.${safeId}.env]`);
      for (const [key, value] of envEntries) {
        lines.push(`${key} = ${toTomlString(String(value))}`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Convert resolved MCP server configs into Copilot SDK MCP JSON config.
 * Written as a temp file and passed via --additional-mcp-config.
 *
 * @param {Array<Object>} servers — resolved server configs
 * @returns {Object} — { mcpServers: { [id]: { command, args, env? } | { url } } }
 */
export function buildCopilotMcpJson(servers) {
  if (!servers || !servers.length) return { mcpServers: {} };

  const mcpServers = {};
  for (const srv of servers) {
    if (srv.transport === "url" && srv.url) {
      mcpServers[srv.id] = { url: srv.url };
    } else if (srv.command) {
      const entry = { command: srv.command };
      if (srv.args && srv.args.length) entry.args = srv.args;
      const envEntries = Object.entries(srv.env || {}).filter(
        ([, v]) => v != null && String(v).trim() !== "",
      );
      if (envEntries.length) entry.env = Object.fromEntries(envEntries);
      mcpServers[srv.id] = entry;
    }
  }

  return { mcpServers };
}

/**
 * Convert resolved MCP server configs into Claude Code MCP environment format.
 * Claude Code uses CLAUDE_MCP_SERVERS env var (JSON) or .claude/mcp_servers.json.
 *
 * @param {Array<Object>} servers — resolved server configs
 * @returns {{ envVar: string, fileContent: Object }} — env var value + file format
 */
export function buildClaudeMcpEnv(servers) {
  if (!servers || !servers.length) {
    return { envVar: "", fileContent: { mcpServers: {} } };
  }

  const mcpServers = {};
  for (const srv of servers) {
    if (srv.transport === "url" && srv.url) {
      mcpServers[srv.id] = { type: "url", url: srv.url };
    } else if (srv.command) {
      const entry = { type: "stdio", command: srv.command };
      if (srv.args && srv.args.length) entry.args = srv.args;
      const envEntries = Object.entries(srv.env || {}).filter(
        ([, v]) => v != null && String(v).trim() !== "",
      );
      if (envEntries.length) entry.env = Object.fromEntries(envEntries);
      mcpServers[srv.id] = entry;
    }
  }

  return {
    envVar: JSON.stringify({ mcpServers }),
    fileContent: { mcpServers },
  };
}

/**
 * Write a temporary MCP config file for Copilot --additional-mcp-config.
 * Returns the path to the temp file.
 *
 * @param {string} rootDir
 * @param {Array<Object>} servers
 * @returns {string} — path to temp MCP config JSON
 */
export function writeTempCopilotMcpConfig(rootDir, servers) {
  const mcpConfig = buildCopilotMcpJson(servers);
  const dir = resolve(rootDir, ".bosun", ".tmp");
  mkdirSync(dir, { recursive: true });
  const filePath = resolve(dir, `mcp-config-${Date.now()}.json`);
  writeFileSync(filePath, JSON.stringify(mcpConfig, null, 2), "utf8");
  return filePath;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toTomlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
