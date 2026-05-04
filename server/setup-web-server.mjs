#!/usr/bin/env node

/**
 * bosun — Web-Based Setup Wizard Server
 *
 * Starts a lightweight HTTP server that serves the setup wizard UI
 * and provides REST API endpoints for configuration operations.
 *
 * Usage:
 *   bosun --setup               # launches this web wizard
 *   bosun --setup-terminal      # launches the legacy terminal wizard
 */

import { createServer } from "node:http";
import { readFileSync, existsSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { ensureTestRuntimeSandbox } from "../infra/test-runtime.mjs";
import { scaffoldSkills } from "../agent/bosun-skills.mjs";
import { ensureCodexConfig, ensureTrustedProjects } from "../shell/codex-config.mjs";
import {
  listTemplates as listWorkflowTemplates,
  listWorkflowSetupProfiles,
  getWorkflowSetupProfile,
  resolveWorkflowTemplateIds,
  normalizeTemplateOverridesById,
} from "../workflow/workflow-templates.mjs";
import { discoverTelegramChats } from "../telegram/get-telegram-chat-id.mjs";
import { buildAgentConfigurationGuide } from "../lib/agent-configuration-guide.mjs";
import { normalizeProviderAuthState } from "../agent/provider-auth-manager.mjs";
import {
  buildSharedProviderAccountSummary,
  resolveCodexSubscriptionAuth,
  resolveCopilotOAuthAuth,
  resolveSharedOAuthToken,
} from "../agent/provider-auth-state.mjs";
import {
  buildLocalConnectionEntry,
  readRemoteConnectionConfig,
  saveRemoteConnectionConfig,
  setLocalConnectionConfig,
} from "../tui/lib/connection-target.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function trimTrailingSlashes(value) {
  let out = String(value || "");
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

function isAzureOpenAIHost(value) {
  try {
    const parsed = value instanceof URL ? value : new URL(String(value || "").trim());
    const host = String(parsed.hostname || "").toLowerCase();
    return host === "openai.azure.com" || host.endsWith(".openai.azure.com") || host.endsWith(".cognitiveservices.azure.com");
  } catch {
    return false;
  }
}

function buildModelsProbeRequest({ apiKey = "", baseUrl = "" } = {}) {
  const trimmedBase = String(baseUrl || "").trim();
  const fallbackBase = "https://api.openai.com";
  const headers = { "Content-Type": "application/json" };

  try {
    const parsed = new URL(trimmedBase || fallbackBase);
    const pathname = trimTrailingSlashes(parsed.pathname || "");
    const lowerPath = pathname.toLowerCase();
    const isAzure = isAzureOpenAIHost(parsed);

    if (apiKey) {
      if (isAzure) headers["api-key"] = apiKey;
      else headers.Authorization = `Bearer ${apiKey}`;
    }

    if (lowerPath.endsWith("/models")) {
      if (isAzure) {
        if (lowerPath.endsWith("/openai/v1/models")) {
          parsed.pathname = "/openai/v1/models";
          parsed.search = "";
          return { endpoint: parsed.toString(), headers };
        }

        parsed.pathname = "/openai/models";
        parsed.search = "";
        parsed.searchParams.set("api-version", "2024-10-21");
        return { endpoint: parsed.toString(), headers };
      }

      return { endpoint: parsed.toString(), headers };
    }

    if (isAzure && (lowerPath === "/openai/v1" || lowerPath.startsWith("/openai/v1/"))) {
      parsed.pathname = "/openai/v1/models";
      parsed.search = "";
      return { endpoint: parsed.toString(), headers };
    }

    if (isAzure || lowerPath === "/openai" || lowerPath.startsWith("/openai/")) {
      parsed.pathname = "/openai/models";
      parsed.search = "";
      parsed.searchParams.set("api-version", "2024-10-21");
      return { endpoint: parsed.toString(), headers };
    }

    const v1Match = lowerPath.match(/^(.*\/v1)(?:\/.*)?$/);
    if (v1Match) {
      parsed.pathname = `${v1Match[1]}/models`;
      parsed.search = "";
      return { endpoint: parsed.toString(), headers };
    }

    parsed.pathname = `${pathname || ""}/v1/models`;
    parsed.search = "";
    return { endpoint: parsed.toString(), headers };
  } catch {
    const resolvedBase = trimTrailingSlashes(trimmedBase || fallbackBase);
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    return { endpoint: `${resolvedBase}/v1/models`, headers };
  }
}


// ── Vendor file serving (hoisting-safe) ───────────────────────────────────────────
// Resolution order:
//   1. ui/vendor/ bundled files — shipped in the npm tarball, zero CDN dependency
//   2. Node module resolution via createRequire — handles global install hoisting
//   3. CDN redirect — last resort
const _require = createRequire(import.meta.url);
const uiRootPreferred = resolve(__dirname, "..", "ui");
const uiRootFallback = resolve(__dirname, "..", "site", "ui");
const uiRoot = existsSync(uiRootPreferred) ? uiRootPreferred : uiRootFallback;
const BUNDLED_VENDOR_DIR = resolve(uiRoot, "vendor");

const VENDOR_FILES = {
  "preact.js":                { specifier: "preact/dist/preact.module.js",                  cdn: "https://esm.sh/preact@10.25.4" },
  "preact-hooks.js":          { specifier: "preact/hooks/dist/hooks.module.js",              cdn: "https://esm.sh/preact@10.25.4/hooks" },
  "preact-compat.js":         { specifier: "preact/compat/dist/compat.module.js",            cdn: "https://esm.sh/preact@10.25.4/compat" },
  "htm.js":                   { specifier: "htm/dist/htm.module.js",                         cdn: "https://esm.sh/htm@3.1.1" },
  "preact-signals-core.js":   { specifier: "@preact/signals-core/dist/signals-core.module.js", cdn: "https://cdn.jsdelivr.net/npm/@preact/signals-core@1.8.0/dist/signals-core.module.js" },
  "preact-signals.js":        { specifier: "@preact/signals/dist/signals.module.js",         cdn: "https://esm.sh/@preact/signals@1.3.1?deps=preact@10.25.4" },
  "es-module-shims.js":       { specifier: "es-module-shims/dist/es-module-shims.js",        cdn: "https://cdn.jsdelivr.net/npm/es-module-shims@1.10.0/dist/es-module-shims.min.js" },
};

function resolveVendorPath(specifier) {
  // Direct resolution first (works when package exports allow the sub-path)
  try { return _require.resolve(specifier); } catch (e) {
    if (e.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") return null;
  }
  // ERR_PACKAGE_PATH_NOT_EXPORTED: walk up from the package main entry to find the file
  const isScoped = specifier.startsWith("@");
  const firstSlash = specifier.indexOf("/");
  const secondSlash = isScoped ? specifier.indexOf("/", firstSlash + 1) : firstSlash;
  if (secondSlash === -1) return null;
  const pkgName = specifier.slice(0, secondSlash);
  const filePath = specifier.slice(secondSlash + 1);
  try {
    const pkgMain = _require.resolve(pkgName);
    let dir = dirname(pkgMain);
    while (dir !== dirname(dir)) {
      if (existsSync(resolve(dir, "package.json"))) {
        const candidate = resolve(dir, filePath);
        return existsSync(candidate) ? candidate : null;
      }
      dir = dirname(dir);
    }
  } catch { /* not installed */ }
  return null;
}

/** Returns { ok, files: [{name, resolved, available}] } */
function checkVendorFiles() {
  const files = Object.entries(VENDOR_FILES).map(([name, { specifier, cdn }]) => {
    const resolved = resolveVendorPath(specifier);
    return { name, specifier, cdn, resolved, available: !!(resolved && existsSync(resolved)) };
  });
  const allOk = files.every((f) => f.available);
  return { ok: allOk, files };
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_PORT = 3456;
const MAX_PORT_ATTEMPTS = 20;
const CALLBACK_PORT = Number(process.env.BOSUN_CALLBACK_PORT) || 54317;
const DEFAULT_TELEGRAM_UI_PORT = 3080;

const MODELS = {
  copilot: [
    { value: "claude-opus-4.6", label: "claude-opus-4.6", recommended: true },
    { value: "claude-sonnet-4.6", label: "claude-sonnet-4.6" },
    { value: "claude-opus-4.5", label: "claude-opus-4.5" },
    { value: "claude-sonnet-4.5", label: "claude-sonnet-4.5" },
    { value: "claude-sonnet-4", label: "claude-sonnet-4" },
    { value: "claude-haiku-4.5", label: "claude-haiku-4.5" },
    { value: "gpt-5.2-codex", label: "gpt-5.2-codex" },
    { value: "gpt-5.3-codex", label: "gpt-5.3-codex" },
    { value: "gpt-5.1-codex", label: "gpt-5.1-codex" },
    { value: "gpt-5.1-codex-mini", label: "gpt-5.1-codex-mini" },
    { value: "gpt-5.1-codex-max", label: "gpt-5.1-codex-max" },
    { value: "gpt-5.2", label: "gpt-5.2" },
    { value: "gpt-5.1", label: "gpt-5.1" },
    { value: "gpt-5-mini", label: "gpt-5-mini" },
    { value: "gemini-3.1-pro", label: "gemini-3.1-pro" },
    { value: "gemini-3-pro", label: "gemini-3-pro" },
    { value: "gemini-3-flash", label: "gemini-3-flash" },
    { value: "gemini-2.5-pro", label: "gemini-2.5-pro" },
    { value: "grok-code-fast-1", label: "grok-code-fast-1" },
  ],
  codex: [
    { value: "gpt-5.3-codex", label: "gpt-5.3-codex", recommended: true },
    { value: "gpt-5.2-codex", label: "gpt-5.2-codex" },
    { value: "gpt-5.1-codex", label: "gpt-5.1-codex" },
    { value: "gpt-5.1-codex-mini", label: "gpt-5.1-codex-mini" },
    { value: "gpt-5.1-codex-max", label: "gpt-5.1-codex-max" },
    { value: "gpt-5.2", label: "gpt-5.2" },
    { value: "gpt-5.1", label: "gpt-5.1" },
    { value: "gpt-5-mini", label: "gpt-5-mini" },
  ],
  claude: [
    { value: "claude-opus-4.6", label: "claude-opus-4.6", recommended: true },
    { value: "claude-sonnet-4.6", label: "claude-sonnet-4.6" },
    { value: "claude-opus-4.5", label: "claude-opus-4.5" },
    { value: "claude-sonnet-4.5", label: "claude-sonnet-4.5" },
    { value: "claude-sonnet-4", label: "claude-sonnet-4" },
    { value: "claude-haiku-4.5", label: "claude-haiku-4.5" },
  ],
  gemini: [
    { value: "gemini-2.5-pro", label: "gemini-2.5-pro", recommended: true },
    { value: "gemini-2.5-flash", label: "gemini-2.5-flash" },
    { value: "gemini-2.0-flash", label: "gemini-2.0-flash" },
    { value: "gemini-1.5-pro", label: "gemini-1.5-pro" },
    { value: "gemini-1.5-flash", label: "gemini-1.5-flash" },
  ],
  opencode: [
    { value: "gpt-5.3-codex", label: "gpt-5.3-codex", recommended: true },
    { value: "gpt-5.2-codex", label: "gpt-5.2-codex" },
    { value: "claude-opus-4.6", label: "claude-opus-4.6" },
    { value: "gemini-2.5-pro", label: "gemini-2.5-pro" },
  ],
};

const EXECUTOR_TYPES = [
  { value: "COPILOT", label: "GitHub Copilot (recommended)", recommended: true },
  { value: "CODEX", label: "OpenAI Codex CLI" },
  { value: "CLAUDE_CODE", label: "Claude Code" },
  { value: "GEMINI", label: "Google Gemini" },
  { value: "OPENCODE", label: "OpenCode (local server)" },
];

const KANBAN_BACKENDS = [
  { value: "internal", label: "Internal (SQLite — recommended)", recommended: true },
  { value: "github", label: "GitHub Projects" },
  { value: "jira", label: "Atlassian Jira" },
];

const WORKFLOW_TEMPLATE_SUMMARIES = Object.freeze(listWorkflowTemplates());
const WORKFLOW_TEMPLATE_ID_SET = new Set(
  WORKFLOW_TEMPLATE_SUMMARIES.map((template) => String(template.id || "").trim()).filter(Boolean),
);
const WORKFLOW_SETUP_PROFILES = Object.freeze(listWorkflowSetupProfiles());
const WORKFLOW_SETUP_PROFILE_IDS = new Set(
  WORKFLOW_SETUP_PROFILES.map((profile) => String(profile.id || "").trim()).filter(Boolean),
);

function normalizeWorkflowProfile(rawValue, fallback = "balanced") {
  const normalized = String(rawValue || "").trim().toLowerCase();
  if (WORKFLOW_SETUP_PROFILE_IDS.has(normalized)) return normalized;
  return fallback;
}

function normalizeSetupStringList(rawValue) {
  const source = Array.isArray(rawValue)
    ? rawValue
    : String(rawValue || "").split(/\r?\n|,/);
  const normalized = [];
  for (const entry of source) {
    const value = String(entry || "").trim();
    if (!value || normalized.includes(value)) continue;
    normalized.push(value);
  }
  return normalized;
}

function normalizeWorkflowTemplateIds(rawValue, fallback = []) {
  const source = Array.isArray(rawValue)
    ? rawValue
    : String(rawValue || "")
      .split(",");
  const normalized = [];
  for (const entry of source) {
    const id = String(entry || "").trim();
    if (!id || !WORKFLOW_TEMPLATE_ID_SET.has(id) || normalized.includes(id)) continue;
    normalized.push(id);
  }
  if (normalized.length > 0) return normalized;
  return Array.isArray(fallback) ? [...fallback] : [];
}

function normalizeWorkflowTemplateOverrides(rawValue, selectedTemplateIds = []) {
  return normalizeTemplateOverridesById(rawValue, selectedTemplateIds);
}

function normalizeWorkspaceId(value, fallback = "workspace") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || fallback;
}

function trimSlashEdges(value) {
  const text = String(value || "");
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) === 47) start += 1;
  while (end > start && text.charCodeAt(end - 1) === 47) end -= 1;
  return text.slice(start, end);
}

function extractRepoNameFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  if (/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(raw)) {
    return raw.split("/").pop() || "";
  }
  try {
    const parsed = new URL(raw);
    const pathname = trimSlashEdges(String(parsed.pathname || "").replace(/\.git$/i, ""));
    return pathname.split("/").pop() || "";
  } catch {
    const cleaned = trimSlashEdges(raw.replace(/\\/g, "/").replace(/\.git$/i, ""));
    return cleaned.split("/").pop() || "";
  }
}

function normalizeRepoSlug(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  if (/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(raw)) return raw;
  const markerIdx = raw.toLowerCase().indexOf("github.com");
  if (markerIdx === -1) return "";
  let tail = raw.slice(markerIdx + "github.com".length);
  if (tail.startsWith(":") || tail.startsWith("/")) tail = tail.slice(1);
  tail = trimSlashEdges(tail.replace(/\.git$/i, ""));
  const parts = tail.split("/").filter(Boolean);
  if (parts.length < 2) return "";
  return `${parts[0]}/${parts[1]}`;
}

function normalizeRepoConfigEntry(repo, index = 0) {
  const raw = typeof repo === "string" ? { slug: repo } : (repo && typeof repo === "object" ? repo : null);
  if (!raw) return null;
  const slug = normalizeRepoSlug(raw.slug || raw.url || raw.path || raw.name || "");
  const url =
    String(raw.url || "").trim() ||
    (slug ? `https://github.com/${slug}.git` : "");
  const name = String(raw.name || raw.id || "").trim() || extractRepoNameFromText(slug || url || raw.path || "");
  if (!name && !slug && !url) return null;
  return {
    name: name || extractRepoNameFromText(url || slug) || `repo-${index + 1}`,
    slug,
    url,
    primary: Boolean(raw.primary) || index === 0,
  };
}

function normalizeWorkspaceConfigEntry(workspace, index = 0) {
  if (!workspace || typeof workspace !== "object") return null;
  const fallbackId = `workspace-${index + 1}`;
  const id = normalizeWorkspaceId(
    workspace.id || workspace.name || fallbackId,
    fallbackId,
  );
  const name = String(workspace.name || workspace.id || id).trim() || id;
  const repos = Array.isArray(workspace.repos)
    ? workspace.repos
        .map((repo, repoIndex) => normalizeRepoConfigEntry(repo, repoIndex))
        .filter(Boolean)
    : [];
  let activeRepo = String(workspace.activeRepo || "").trim();
  if (!activeRepo && repos[0]?.name) activeRepo = repos[0].name;
  if (activeRepo && !repos.some((repo) => repo.name === activeRepo)) {
    activeRepo = repos[0]?.name || "";
  }
  return {
    id,
    name,
    repos,
    createdAt: workspace.createdAt || new Date().toISOString(),
    activeRepo: activeRepo || null,
  };
}

function normalizeWorkspaceConfigList(workspaces) {
  if (!Array.isArray(workspaces)) return [];
  const byId = new Map();
  for (let i = 0; i < workspaces.length; i += 1) {
    const normalized = normalizeWorkspaceConfigEntry(workspaces[i], i);
    if (!normalized) continue;
    const existing = byId.get(normalized.id);
    if (!existing) {
      byId.set(normalized.id, normalized);
      continue;
    }
    // Merge with precedence to latest entry while preserving earlier repo order.
    const repoMap = new Map();
    for (const repo of existing.repos || []) repoMap.set(repo.name, repo);
    for (const repo of normalized.repos || []) repoMap.set(repo.name, repo);
    byId.set(normalized.id, {
      ...existing,
      ...normalized,
      repos: [...repoMap.values()],
      activeRepo:
        normalized.activeRepo ||
        existing.activeRepo ||
        [...repoMap.values()][0]?.name ||
        null,
    });
  }
  return [...byId.values()];
}

function readExistingBosunConfig(bosunHome) {
  const configPath = resolve(bosunHome, "bosun.config.json");
  if (!existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function resolveSetupWorkspaceAndRepoConfig(existingConfig = {}, configJson = {}, env = {}) {
  const normalizedIncomingRepos = Array.isArray(configJson.repos)
    ? configJson.repos
        .map((repo, idx) => normalizeRepoConfigEntry(repo, idx))
        .filter(Boolean)
    : [];
  const normalizedExistingRepos = Array.isArray(existingConfig.repos)
    ? existingConfig.repos
        .map((repo, idx) => normalizeRepoConfigEntry(repo, idx))
        .filter(Boolean)
    : [];
  const repos =
    normalizedIncomingRepos.length > 0
      ? normalizedIncomingRepos
      : normalizedExistingRepos;

  const normalizedIncomingWorkspaces = normalizeWorkspaceConfigList(configJson.workspaces);
  const normalizedExistingWorkspaces = normalizeWorkspaceConfigList(existingConfig.workspaces);
  let workspaces = normalizedIncomingWorkspaces.length > 0
    ? normalizedIncomingWorkspaces
    : normalizedExistingWorkspaces;

  // Bootstrap a single default workspace when repos exist but no workspace
  // layout was provided, so the UI and workspace APIs stay consistent.
  if (workspaces.length === 0 && repos.length > 0) {
    const defaultWorkspaceId = normalizeWorkspaceId(
      configJson.projectName || env.projectName || existingConfig.projectName || "default",
      "default",
    );
    workspaces = [
      {
        id: defaultWorkspaceId,
        name:
          configJson.projectName ||
          env.projectName ||
          existingConfig.projectName ||
          "Default Workspace",
        repos: repos.map((repo, idx) => ({
          ...repo,
          primary: repo.primary === true || idx === 0,
        })),
        createdAt: new Date().toISOString(),
        activeRepo: repos[0]?.name || null,
      },
    ];
  }

  let activeWorkspace = "";
  if (workspaces.length > 0) {
    const requestedActiveWorkspace = normalizeWorkspaceId(
      configJson.activeWorkspace || existingConfig.activeWorkspace || workspaces[0]?.id,
      workspaces[0]?.id || "default",
    );
    activeWorkspace = workspaces.some((ws) => ws.id === requestedActiveWorkspace)
      ? requestedActiveWorkspace
      : workspaces[0].id;
  }

  return {
    repos,
    workspaces,
    activeWorkspace,
  };
}

function buildStableSetupDefaults({
  projectName,
  slug,
  repoVisibility,
  repoRoot,
  bosunHome,
  workspacesDir,
}) {
  const defaultWorkflowProfile = getWorkflowSetupProfile("balanced");
  const recommendedAutomationPreference = repoVisibility === "public"
    ? "actions-first"
    : "runtime-first";
  return {
    projectName: projectName || slug?.split("/").pop() || "my-project",
    repoSlug: slug,
    repoRoot,
    configDir: bosunHome,
    bosunHome,
    workspacesDir,
    executors: [
      {
        name: "primary",
        executor: "CODEX",
        model: "gpt-5.3-codex",
        weight: 100,
        role: "primary",
        authMode: "oauth",
        apiKey: "",
        baseUrl: "",
        connections: [],
        codexProfile: "",
      },
    ],
    executor: "CODEX",
    model: "gpt-5.3-codex",
    kanbanBackend: "internal",
    kanbanSyncPolicy: "internal-primary",
    executorMode: "internal",
    executorDistribution: "primary-only",
    maxParallel: 4,
    maxRetries: 3,
    failoverStrategy: "next-in-line",
    failoverCooldownMinutes: 5,
    failoverDisableOnConsecutive: 3,
    internalReplenishEnabled: false,
    internalReplenishMin: 1,
    internalReplenishMax: 2,
    workflowAutomationEnabled: true,
    workflowProfile: defaultWorkflowProfile.id,
    workflowDefaultTemplates: [...defaultWorkflowProfile.templateIds],
    workflowTemplateOverridesById: {},
    workflowAutoInstall: true,
    prAutomation: {
      assistiveActions: {
        installOnSetup: false,
      },
    },
    gates: {
      prs: {
        repoVisibility,
        automationPreference: recommendedAutomationPreference,
        githubActionsBudget: "ask-user",
      },
      checks: {
        mode: "all",
        requiredPatterns: [],
        optionalPatterns: [],
        ignorePatterns: [],
        requireAnyRequiredCheck: true,
        treatPendingRequiredAsBlocking: true,
        treatNeutralAsPass: false,
      },
      execution: {
        sandboxMode: "workspace-write",
        containerIsolationEnabled: false,
        containerRuntime: "auto",
        networkAccess: "default",
      },
      runtime: {
        enforceBacklog: true,
        agentTriggerControl: true,
      },
    },
    workflowNodeMaxRetries: 3,
    workflowNodeTimeoutMs: 600000,
    workflowRunStuckThresholdMs: 300000,
    workflowMaxPersistedRuns: 200,
    workflowMaxConcurrentBranches: 8,
    contextShreddingEnabled: true,
    contextShreddingFullContextTurns: 3,
    contextShreddingCompressToolOutputs: true,
    contextShreddingCompressMessages: true,
    contextShreddingTier1MaxAge: 5,
    contextShreddingTier2MaxAge: 9,
    contextShreddingTier1HeadChars: 2000,
    contextShreddingTier1TailChars: 800,
    contextShreddingTier2HeadChars: 600,
    contextShreddingTier2TailChars: 300,
    contextShreddingScoreHigh: 70,
    contextShreddingScoreLow: 30,
    contextShreddingCompressAgentMessages: true,
    contextShreddingCompressUserMessages: true,
    contextShreddingMsgTier0MaxAge: 1,
    contextShreddingMsgTier1MaxAge: 4,
    contextShreddingMsgMinCompressChars: 120,
    contextShreddingUserMsgFullTurns: 1,
    contextShreddingLiveToolCompactionEnabled: false,
    contextShreddingLiveToolCompactionMode: "auto",
    contextShreddingLiveToolCompactionMinChars: 4000,
    contextShreddingLiveToolCompactionTargetChars: 1800,
    contextShreddingLiveToolCompactionMinSavingsPct: 15,
    contextShreddingLiveToolCompactionMinRuntimeMs: 2000,
    contextShreddingLiveToolCompactionBlockStructuredOutput: true,
    contextShreddingLiveToolCompactionAllowCommands: "grep,rg,find,findstr,select-string,ag,ack,sift,fd,where,which,ls,dir,tree,git,go,npm,pnpm,yarn,npx,bun,node,python,python3,pytest,pip,pip3,poetry,docker,kubectl,helm,terraform,ansible,ansible-playbook,journalctl,tail,get-content,cargo,gradle,maven,mvn,javac,tsc,jest,vitest,deno,make,cmake,bazel,buck,nx,turbo,rush,composer,bundle",
    contextShreddingProfiles: "",
    voiceEnabled: true,
    voiceProvider: "auto",
    voiceModel: "gpt-audio-1.5",
    voiceVisionModel: "gpt-4.1-nano",
    voiceId: "alloy",
    voiceTurnDetection: "semantic_vad",
    voiceFallbackMode: "browser",
    voiceDelegateExecutor: "codex-sdk",
    voiceTranscriptionEnabled: true,
    voiceTranscriptionModel: "gpt-4o-transcribe",
    voiceAzureTranscriptionEnabled: false,
    openaiRealtimeApiKey: "",
    azureOpenaiRealtimeEndpoint: "",
    azureOpenaiRealtimeApiKey: "",
    azureOpenaiRealtimeDeployment: "gpt-audio-1.5",
    copilotEnableAllMcpTools: false,
    // Backward-compatible fields consumed by older setup UI revisions.
    distribution: "primary-only",
    cooldownMinutes: 5,
  };
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function getVersion() {
  try {
    return JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
}

function commandExists(cmd) {
  try {
    const check = process.platform === "win32"
      ? `where ${cmd} 2>nul`
      : `command -v ${cmd} 2>/dev/null`;
    execSync(check, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function toBooleanEnvString(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback ? "true" : "false";
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on", "y"].includes(normalized)) return "true";
  if (["0", "false", "no", "off", "n"].includes(normalized)) return "false";
  return fallback ? "true" : "false";
}

function pickNonEmptyValue(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    return value;
  }
  return undefined;
}

function toBoundedInt(rawValue, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.round(parsed);
  return Math.min(max, Math.max(min, rounded));
}

function normalizeEnumValue(rawValue, allowed, fallback) {
  const normalized = String(rawValue || "").trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function normalizeTelegramUiPort(rawValue, fallback = DEFAULT_TELEGRAM_UI_PORT) {
  const parsed = Number(String(rawValue || "").trim());
  if (Number.isFinite(parsed) && parsed > 0) {
    return String(Math.round(parsed));
  }
  return String(fallback);
}

function applyTelegramMiniAppSetupEnv(envMap, env, sourceEnv = process.env) {
  const telegramToken = String(
    env?.telegramToken || env?.TELEGRAM_BOT_TOKEN || sourceEnv.TELEGRAM_BOT_TOKEN || "",
  ).trim();
  if (!telegramToken) return false;

  envMap.TELEGRAM_BOT_TOKEN = telegramToken;

  const miniAppRaw =
    env?.telegramMiniappEnabled ??
    env?.telegramMiniAppEnabled ??
    env?.TELEGRAM_MINIAPP_ENABLED;
  envMap.TELEGRAM_MINIAPP_ENABLED = toBooleanEnvString(miniAppRaw, true);
  envMap.TELEGRAM_UI_PORT = normalizeTelegramUiPort(
    env?.telegramUiPort || env?.TELEGRAM_UI_PORT || sourceEnv.TELEGRAM_UI_PORT,
  );

  const tunnelRaw =
    env?.telegramUiTunnel ||
    env?.TELEGRAM_UI_TUNNEL ||
    sourceEnv.TELEGRAM_UI_TUNNEL;
  // Default to "quick" when no named-tunnel credentials are configured so the
  // UI starts successfully out-of-the-box without --setup.
  const hasNamedCreds = !!(
    (env?.CLOUDFLARE_TUNNEL_NAME || sourceEnv.CLOUDFLARE_TUNNEL_NAME) &&
    (env?.CLOUDFLARE_TUNNEL_CREDENTIALS || sourceEnv.CLOUDFLARE_TUNNEL_CREDENTIALS)
  );
  const tunnelDefault = hasNamedCreds ? "named" : "quick";
  envMap.TELEGRAM_UI_TUNNEL = String(tunnelRaw || tunnelDefault).trim() || tunnelDefault;

  const quickFallbackRaw =
    env?.telegramUiAllowQuickTunnelFallback ??
    env?.TELEGRAM_UI_ALLOW_QUICK_TUNNEL_FALLBACK ??
    sourceEnv.TELEGRAM_UI_ALLOW_QUICK_TUNNEL_FALLBACK;
  // Default true so named-tunnel failures fall back gracefully rather than
  // silently killing the Web UI. --setup sets this to false when credentials
  // are provided and the tunnel is known-good.
  envMap.TELEGRAM_UI_ALLOW_QUICK_TUNNEL_FALLBACK = toBooleanEnvString(
    quickFallbackRaw,
    true,
  );

  const fallbackAuthRaw =
    env?.telegramUiFallbackAuthEnabled ??
    env?.TELEGRAM_UI_FALLBACK_AUTH_ENABLED ??
    sourceEnv.TELEGRAM_UI_FALLBACK_AUTH_ENABLED;
  envMap.TELEGRAM_UI_FALLBACK_AUTH_ENABLED = toBooleanEnvString(
    fallbackAuthRaw,
    true,
  );

  const hostnamePolicyRaw =
    env?.cloudflareUsernameHostnamePolicy ||
    env?.CLOUDFLARE_USERNAME_HOSTNAME_POLICY ||
    sourceEnv.CLOUDFLARE_USERNAME_HOSTNAME_POLICY ||
    "per-user-fixed";
  envMap.CLOUDFLARE_USERNAME_HOSTNAME_POLICY = String(hostnamePolicyRaw).trim() || "per-user-fixed";

  const unsafeRaw =
    env?.telegramUiAllowUnsafe ??
    env?.TELEGRAM_UI_ALLOW_UNSAFE ??
    sourceEnv.TELEGRAM_UI_ALLOW_UNSAFE;
  envMap.TELEGRAM_UI_ALLOW_UNSAFE = toBooleanEnvString(unsafeRaw, false);
  return true;
}

function applyNonBlockingSetupEnvDefaults(envMap, env = {}, sourceEnv = process.env) {
  const maxParallel = toBoundedInt(
    pickNonEmptyValue(env.maxParallel, envMap.MAX_PARALLEL, sourceEnv.MAX_PARALLEL),
    4,
    { min: 1, max: 64 },
  );
  envMap.MAX_PARALLEL = String(maxParallel);

  envMap.KANBAN_BACKEND = normalizeEnumValue(
    pickNonEmptyValue(env.kanbanBackend, envMap.KANBAN_BACKEND, sourceEnv.KANBAN_BACKEND),
    ["internal", "github", "jira"],
    "internal",
  );
  envMap.KANBAN_SYNC_POLICY = normalizeEnumValue(
    pickNonEmptyValue(env.kanbanSyncPolicy, envMap.KANBAN_SYNC_POLICY, sourceEnv.KANBAN_SYNC_POLICY),
    ["internal-primary", "bidirectional"],
    "internal-primary",
  );
  envMap.BOSUN_AGENT_RUNTIME = normalizeEnumValue(
    pickNonEmptyValue(env.agentRuntime, envMap.BOSUN_AGENT_RUNTIME, sourceEnv.BOSUN_AGENT_RUNTIME),
    ["harness", "sdk-cli"],
    "harness",
  );
  envMap.BOSUN_PROVIDER_ROUTING_MODE = normalizeEnumValue(
    pickNonEmptyValue(
      env.providerRoutingMode,
      envMap.BOSUN_PROVIDER_ROUTING_MODE,
      sourceEnv.BOSUN_PROVIDER_ROUTING_MODE,
    ),
    ["default-only", "fallback", "spread"],
    "default-only",
  );
  envMap.EXECUTOR_MODE = normalizeEnumValue(
    pickNonEmptyValue(env.executorMode, envMap.EXECUTOR_MODE, sourceEnv.EXECUTOR_MODE),
    ["internal"],
    "internal",
  );
  envMap.EXECUTOR_DISTRIBUTION = normalizeEnumValue(
    pickNonEmptyValue(
      env.executorDistribution,
      envMap.EXECUTOR_DISTRIBUTION,
      sourceEnv.EXECUTOR_DISTRIBUTION,
    ),
    ["primary-only", "weighted", "round-robin"],
    "primary-only",
  );
  envMap.FAILOVER_STRATEGY = normalizeEnumValue(
    pickNonEmptyValue(env.failoverStrategy, envMap.FAILOVER_STRATEGY, sourceEnv.FAILOVER_STRATEGY),
    ["next-in-line", "weighted-random", "round-robin"],
    "next-in-line",
  );
  envMap.FAILOVER_MAX_RETRIES = String(
    toBoundedInt(
      pickNonEmptyValue(env.maxRetries, envMap.FAILOVER_MAX_RETRIES, sourceEnv.FAILOVER_MAX_RETRIES),
      3,
      { min: 0, max: 20 },
    ),
  );
  envMap.FAILOVER_COOLDOWN_MIN = String(
    toBoundedInt(
      pickNonEmptyValue(
        env.failoverCooldownMinutes,
        envMap.FAILOVER_COOLDOWN_MIN,
        sourceEnv.FAILOVER_COOLDOWN_MIN,
      ),
      5,
      { min: 1, max: 120 },
    ),
  );
  envMap.FAILOVER_DISABLE_AFTER = String(
    toBoundedInt(
      pickNonEmptyValue(
        env.failoverDisableOnConsecutive,
        envMap.FAILOVER_DISABLE_AFTER,
        sourceEnv.FAILOVER_DISABLE_AFTER,
      ),
      3,
      { min: 1, max: 50 },
    ),
  );
  envMap.PROJECT_REQUIREMENTS_PROFILE = normalizeEnumValue(
    pickNonEmptyValue(
      env.projectRequirementsProfile,
      envMap.PROJECT_REQUIREMENTS_PROFILE,
      sourceEnv.PROJECT_REQUIREMENTS_PROFILE,
    ),
    ["simple-feature", "feature", "large-feature", "system", "multi-system"],
    "feature",
  );

  envMap.INTERNAL_EXECUTOR_REPLENISH_ENABLED = toBooleanEnvString(
    pickNonEmptyValue(
      env.internalReplenishEnabled,
      envMap.INTERNAL_EXECUTOR_REPLENISH_ENABLED,
      sourceEnv.INTERNAL_EXECUTOR_REPLENISH_ENABLED,
    ),
    false,
  );
  const replenishMin = toBoundedInt(
    pickNonEmptyValue(
      env.internalReplenishMin,
      envMap.INTERNAL_EXECUTOR_REPLENISH_MIN_NEW_TASKS,
      sourceEnv.INTERNAL_EXECUTOR_REPLENISH_MIN_NEW_TASKS,
    ),
    1,
    { min: 1, max: 2 },
  );
  const replenishMax = toBoundedInt(
    pickNonEmptyValue(
      env.internalReplenishMax,
      envMap.INTERNAL_EXECUTOR_REPLENISH_MAX_NEW_TASKS,
      sourceEnv.INTERNAL_EXECUTOR_REPLENISH_MAX_NEW_TASKS,
    ),
    2,
    { min: replenishMin, max: 3 },
  );
  envMap.INTERNAL_EXECUTOR_REPLENISH_MIN_NEW_TASKS = String(replenishMin);
  envMap.INTERNAL_EXECUTOR_REPLENISH_MAX_NEW_TASKS = String(replenishMax);

  envMap.WORKFLOW_AUTOMATION_ENABLED = toBooleanEnvString(
    pickNonEmptyValue(
      env.workflowAutomationEnabled,
      envMap.WORKFLOW_AUTOMATION_ENABLED,
      sourceEnv.WORKFLOW_AUTOMATION_ENABLED,
    ),
    true,
  );
  const workflowProfile = normalizeWorkflowProfile(
    pickNonEmptyValue(
      env.workflowProfile,
      envMap.WORKFLOW_DEFAULT_PROFILE,
      sourceEnv.WORKFLOW_DEFAULT_PROFILE,
    ),
    "balanced",
  );
  envMap.WORKFLOW_DEFAULT_PROFILE = workflowProfile;
  envMap.WORKFLOW_DEFAULT_AUTOINSTALL = toBooleanEnvString(
    pickNonEmptyValue(
      env.workflowAutoInstall,
      envMap.WORKFLOW_DEFAULT_AUTOINSTALL,
      sourceEnv.WORKFLOW_DEFAULT_AUTOINSTALL,
    ),
    true,
  );
  const fallbackWorkflowTemplates = resolveWorkflowTemplateIds({
    profileId: workflowProfile,
  });
  const workflowTemplates = normalizeWorkflowTemplateIds(
    pickNonEmptyValue(
      env.workflowDefaultTemplates,
      envMap.WORKFLOW_DEFAULT_TEMPLATES,
      sourceEnv.WORKFLOW_DEFAULT_TEMPLATES,
    ),
    fallbackWorkflowTemplates,
  );
  envMap.WORKFLOW_DEFAULT_TEMPLATES =
    workflowTemplates.length > 0 ? workflowTemplates.join(",") : "none";
  envMap.BOSUN_PR_ASSISTIVE_ACTIONS_INSTALL_ON_SETUP = toBooleanEnvString(
    pickNonEmptyValue(
      env.assistiveActionsInstallOnSetup,
      envMap.BOSUN_PR_ASSISTIVE_ACTIONS_INSTALL_ON_SETUP,
      sourceEnv.BOSUN_PR_ASSISTIVE_ACTIONS_INSTALL_ON_SETUP,
    ),
    false,
  );
  envMap.BOSUN_GATES_REPO_VISIBILITY = normalizeEnumValue(
    pickNonEmptyValue(
      env.gatesRepoVisibility,
      envMap.BOSUN_GATES_REPO_VISIBILITY,
      sourceEnv.BOSUN_GATES_REPO_VISIBILITY,
    ),
    ["public", "private", "unknown"],
    "unknown",
  );
  envMap.BOSUN_GATES_AUTOMATION_PREFERENCE = normalizeEnumValue(
    pickNonEmptyValue(
      env.gatesAutomationPreference,
      envMap.BOSUN_GATES_AUTOMATION_PREFERENCE,
      sourceEnv.BOSUN_GATES_AUTOMATION_PREFERENCE,
    ),
    ["runtime-first", "actions-first"],
    envMap.BOSUN_GATES_REPO_VISIBILITY === "public" ? "actions-first" : "runtime-first",
  );
  envMap.BOSUN_GATES_ACTIONS_BUDGET = normalizeEnumValue(
    pickNonEmptyValue(
      env.gatesGithubActionsBudget,
      envMap.BOSUN_GATES_ACTIONS_BUDGET,
      sourceEnv.BOSUN_GATES_ACTIONS_BUDGET,
    ),
    ["ask-user", "available", "limited"],
    "ask-user",
  );
  envMap.BOSUN_GATES_CHECK_MODE = normalizeEnumValue(
    pickNonEmptyValue(
      env.gatesCheckMode,
      envMap.BOSUN_GATES_CHECK_MODE,
      sourceEnv.BOSUN_GATES_CHECK_MODE,
    ),
    ["all", "required-only"],
    "all",
  );
  envMap.BOSUN_REQUIRED_CHECK_PATTERNS = normalizeSetupStringList(
    pickNonEmptyValue(
      env.gatesRequiredPatterns,
      envMap.BOSUN_REQUIRED_CHECK_PATTERNS,
      sourceEnv.BOSUN_REQUIRED_CHECK_PATTERNS,
    ),
  ).join(",");
  envMap.BOSUN_OPTIONAL_CHECK_PATTERNS = normalizeSetupStringList(
    pickNonEmptyValue(
      env.gatesOptionalPatterns,
      envMap.BOSUN_OPTIONAL_CHECK_PATTERNS,
      sourceEnv.BOSUN_OPTIONAL_CHECK_PATTERNS,
    ),
  ).join(",");
  envMap.BOSUN_IGNORE_CHECK_PATTERNS = normalizeSetupStringList(
    pickNonEmptyValue(
      env.gatesIgnorePatterns,
      envMap.BOSUN_IGNORE_CHECK_PATTERNS,
      sourceEnv.BOSUN_IGNORE_CHECK_PATTERNS,
    ),
  ).join(",");
  envMap.BOSUN_GATES_REQUIRE_ANY_REQUIRED_CHECK = toBooleanEnvString(
    pickNonEmptyValue(
      env.gatesRequireAnyRequiredCheck,
      envMap.BOSUN_GATES_REQUIRE_ANY_REQUIRED_CHECK,
      sourceEnv.BOSUN_GATES_REQUIRE_ANY_REQUIRED_CHECK,
    ),
    true,
  );
  envMap.BOSUN_GATES_TREAT_PENDING_REQUIRED_AS_BLOCKING = toBooleanEnvString(
    pickNonEmptyValue(
      env.gatesTreatPendingRequiredAsBlocking,
      envMap.BOSUN_GATES_TREAT_PENDING_REQUIRED_AS_BLOCKING,
      sourceEnv.BOSUN_GATES_TREAT_PENDING_REQUIRED_AS_BLOCKING,
    ),
    true,
  );
  envMap.BOSUN_GATES_TREAT_NEUTRAL_AS_PASS = toBooleanEnvString(
    pickNonEmptyValue(
      env.gatesTreatNeutralAsPass,
      envMap.BOSUN_GATES_TREAT_NEUTRAL_AS_PASS,
      sourceEnv.BOSUN_GATES_TREAT_NEUTRAL_AS_PASS,
    ),
    false,
  );
  envMap.BOSUN_EXECUTION_NETWORK_ACCESS = String(
    pickNonEmptyValue(
      env.gatesNetworkAccess,
      envMap.BOSUN_EXECUTION_NETWORK_ACCESS,
      sourceEnv.BOSUN_EXECUTION_NETWORK_ACCESS,
    ) || "default",
  ).trim() || "default";
  envMap.BOSUN_GATES_ENFORCE_BACKLOG = toBooleanEnvString(
    pickNonEmptyValue(
      env.gatesEnforceBacklog,
      envMap.BOSUN_GATES_ENFORCE_BACKLOG,
      sourceEnv.BOSUN_GATES_ENFORCE_BACKLOG,
    ),
    true,
  );
  envMap.BOSUN_GATES_AGENT_TRIGGER_CONTROL = toBooleanEnvString(
    pickNonEmptyValue(
      env.gatesAgentTriggerControl,
      envMap.BOSUN_GATES_AGENT_TRIGGER_CONTROL,
      sourceEnv.BOSUN_GATES_AGENT_TRIGGER_CONTROL,
    ),
    true,
  );
  envMap.WORKFLOW_NODE_MAX_RETRIES = String(
    toBoundedInt(
      pickNonEmptyValue(
        env.workflowNodeMaxRetries,
        envMap.WORKFLOW_NODE_MAX_RETRIES,
        sourceEnv.WORKFLOW_NODE_MAX_RETRIES,
      ),
      3,
      { min: 0, max: 20 },
    ),
  );
  envMap.WORKFLOW_NODE_TIMEOUT_MS = String(
    toBoundedInt(
      pickNonEmptyValue(
        env.workflowNodeTimeoutMs,
        envMap.WORKFLOW_NODE_TIMEOUT_MS,
        sourceEnv.WORKFLOW_NODE_TIMEOUT_MS,
      ),
      600000,
      { min: 1000, max: 21_600_000 },
    ),
  );
  envMap.WORKFLOW_RUN_STUCK_THRESHOLD_MS = String(
    toBoundedInt(
      pickNonEmptyValue(
        env.workflowRunStuckThresholdMs,
        envMap.WORKFLOW_RUN_STUCK_THRESHOLD_MS,
        sourceEnv.WORKFLOW_RUN_STUCK_THRESHOLD_MS,
      ),
      300000,
      { min: 10000, max: 7_200_000 },
    ),
  );
  envMap.WORKFLOW_MAX_PERSISTED_RUNS = String(
    toBoundedInt(
      pickNonEmptyValue(
        env.workflowMaxPersistedRuns,
        envMap.WORKFLOW_MAX_PERSISTED_RUNS,
        sourceEnv.WORKFLOW_MAX_PERSISTED_RUNS,
      ),
      200,
      { min: 20, max: 5000 },
    ),
  );
  envMap.WORKFLOW_MAX_CONCURRENT_BRANCHES = String(
    toBoundedInt(
      pickNonEmptyValue(
        env.workflowMaxConcurrentBranches,
        envMap.WORKFLOW_MAX_CONCURRENT_BRANCHES,
        sourceEnv.WORKFLOW_MAX_CONCURRENT_BRANCHES,
      ),
      8,
      { min: 1, max: 64 },
    ),
  );
  envMap.CONTEXT_SHREDDING_ENABLED = toBooleanEnvString(
    pickNonEmptyValue(
      env.contextShreddingEnabled,
      env.CONTEXT_SHREDDING_ENABLED,
      envMap.CONTEXT_SHREDDING_ENABLED,
      sourceEnv.CONTEXT_SHREDDING_ENABLED,
    ),
    true,
  );
  const contextShreddingFullContextTurns = toBoundedInt(
    pickNonEmptyValue(
      env.contextShreddingFullContextTurns,
      env.CONTEXT_SHREDDING_FULL_CONTEXT_TURNS,
      envMap.CONTEXT_SHREDDING_FULL_CONTEXT_TURNS,
      sourceEnv.CONTEXT_SHREDDING_FULL_CONTEXT_TURNS,
    ),
    3,
    { min: 1, max: 50 },
  );
  envMap.CONTEXT_SHREDDING_FULL_CONTEXT_TURNS = String(contextShreddingFullContextTurns);
  envMap.CONTEXT_SHREDDING_COMPRESS_TOOL_OUTPUTS = toBooleanEnvString(
    pickNonEmptyValue(
      env.contextShreddingCompressToolOutputs,
      env.CONTEXT_SHREDDING_COMPRESS_TOOL_OUTPUTS,
      envMap.CONTEXT_SHREDDING_COMPRESS_TOOL_OUTPUTS,
      sourceEnv.CONTEXT_SHREDDING_COMPRESS_TOOL_OUTPUTS,
    ),
    true,
  );
  envMap.CONTEXT_SHREDDING_COMPRESS_MESSAGES = toBooleanEnvString(
    pickNonEmptyValue(
      env.contextShreddingCompressMessages,
      env.CONTEXT_SHREDDING_COMPRESS_MESSAGES,
      envMap.CONTEXT_SHREDDING_COMPRESS_MESSAGES,
      sourceEnv.CONTEXT_SHREDDING_COMPRESS_MESSAGES,
    ),
    true,
  );
  const contextShreddingTier1MaxAge = toBoundedInt(
    pickNonEmptyValue(
      env.contextShreddingTier1MaxAge,
      env.CONTEXT_SHREDDING_TIER1_MAX_AGE,
      envMap.CONTEXT_SHREDDING_TIER1_MAX_AGE,
      sourceEnv.CONTEXT_SHREDDING_TIER1_MAX_AGE,
    ),
    5,
    { min: contextShreddingFullContextTurns, max: 100 },
  );
  envMap.CONTEXT_SHREDDING_TIER1_MAX_AGE = String(contextShreddingTier1MaxAge);
  const contextShreddingTier2MaxAge = toBoundedInt(
    pickNonEmptyValue(
      env.contextShreddingTier2MaxAge,
      env.CONTEXT_SHREDDING_TIER2_MAX_AGE,
      envMap.CONTEXT_SHREDDING_TIER2_MAX_AGE,
      sourceEnv.CONTEXT_SHREDDING_TIER2_MAX_AGE,
    ),
    9,
    { min: contextShreddingTier1MaxAge, max: 200 },
  );
  envMap.CONTEXT_SHREDDING_TIER2_MAX_AGE = String(contextShreddingTier2MaxAge);
  envMap.CONTEXT_SHREDDING_TIER1_HEAD_CHARS = String(
    toBoundedInt(
      pickNonEmptyValue(
        env.contextShreddingTier1HeadChars,
        env.CONTEXT_SHREDDING_TIER1_HEAD_CHARS,
        envMap.CONTEXT_SHREDDING_TIER1_HEAD_CHARS,
        sourceEnv.CONTEXT_SHREDDING_TIER1_HEAD_CHARS,
      ),
      2000,
      { min: 100, max: 20000 },
    ),
  );
  envMap.CONTEXT_SHREDDING_TIER1_TAIL_CHARS = String(
    toBoundedInt(
      pickNonEmptyValue(
        env.contextShreddingTier1TailChars,
        env.CONTEXT_SHREDDING_TIER1_TAIL_CHARS,
        envMap.CONTEXT_SHREDDING_TIER1_TAIL_CHARS,
        sourceEnv.CONTEXT_SHREDDING_TIER1_TAIL_CHARS,
      ),
      800,
      { min: 0, max: 10000 },
    ),
  );
  envMap.CONTEXT_SHREDDING_TIER2_HEAD_CHARS = String(
    toBoundedInt(
      pickNonEmptyValue(
        env.contextShreddingTier2HeadChars,
        env.CONTEXT_SHREDDING_TIER2_HEAD_CHARS,
        envMap.CONTEXT_SHREDDING_TIER2_HEAD_CHARS,
        sourceEnv.CONTEXT_SHREDDING_TIER2_HEAD_CHARS,
      ),
      600,
      { min: 50, max: 10000 },
    ),
  );
  envMap.CONTEXT_SHREDDING_TIER2_TAIL_CHARS = String(
    toBoundedInt(
      pickNonEmptyValue(
        env.contextShreddingTier2TailChars,
        env.CONTEXT_SHREDDING_TIER2_TAIL_CHARS,
        envMap.CONTEXT_SHREDDING_TIER2_TAIL_CHARS,
        sourceEnv.CONTEXT_SHREDDING_TIER2_TAIL_CHARS,
      ),
      300,
      { min: 0, max: 5000 },
    ),
  );
  const contextShreddingScoreHigh = toBoundedInt(
    pickNonEmptyValue(
      env.contextShreddingScoreHigh,
      env.CONTEXT_SHREDDING_SCORE_HIGH,
      envMap.CONTEXT_SHREDDING_SCORE_HIGH,
      sourceEnv.CONTEXT_SHREDDING_SCORE_HIGH,
    ),
    70,
    { min: 1, max: 100 },
  );
  envMap.CONTEXT_SHREDDING_SCORE_HIGH = String(contextShreddingScoreHigh);
  const contextShreddingScoreLow = toBoundedInt(
    pickNonEmptyValue(
      env.contextShreddingScoreLow,
      env.CONTEXT_SHREDDING_SCORE_LOW,
      envMap.CONTEXT_SHREDDING_SCORE_LOW,
      sourceEnv.CONTEXT_SHREDDING_SCORE_LOW,
    ),
    30,
    { min: 0, max: Math.max(0, contextShreddingScoreHigh - 1) },
  );
  envMap.CONTEXT_SHREDDING_SCORE_LOW = String(contextShreddingScoreLow);
  envMap.CONTEXT_SHREDDING_COMPRESS_AGENT_MESSAGES = toBooleanEnvString(
    pickNonEmptyValue(
      env.contextShreddingCompressAgentMessages,
      env.CONTEXT_SHREDDING_COMPRESS_AGENT_MESSAGES,
      envMap.CONTEXT_SHREDDING_COMPRESS_AGENT_MESSAGES,
      sourceEnv.CONTEXT_SHREDDING_COMPRESS_AGENT_MESSAGES,
    ),
    true,
  );
  envMap.CONTEXT_SHREDDING_COMPRESS_USER_MESSAGES = toBooleanEnvString(
    pickNonEmptyValue(
      env.contextShreddingCompressUserMessages,
      env.CONTEXT_SHREDDING_COMPRESS_USER_MESSAGES,
      envMap.CONTEXT_SHREDDING_COMPRESS_USER_MESSAGES,
      sourceEnv.CONTEXT_SHREDDING_COMPRESS_USER_MESSAGES,
    ),
    true,
  );
  const contextShreddingMsgTier0MaxAge = toBoundedInt(
    pickNonEmptyValue(
      env.contextShreddingMsgTier0MaxAge,
      env.CONTEXT_SHREDDING_MSG_TIER0_MAX_AGE,
      envMap.CONTEXT_SHREDDING_MSG_TIER0_MAX_AGE,
      sourceEnv.CONTEXT_SHREDDING_MSG_TIER0_MAX_AGE,
    ),
    1,
    { min: 0, max: 20 },
  );
  envMap.CONTEXT_SHREDDING_MSG_TIER0_MAX_AGE = String(contextShreddingMsgTier0MaxAge);
  const contextShreddingMsgTier1MaxAge = toBoundedInt(
    pickNonEmptyValue(
      env.contextShreddingMsgTier1MaxAge,
      env.CONTEXT_SHREDDING_MSG_TIER1_MAX_AGE,
      envMap.CONTEXT_SHREDDING_MSG_TIER1_MAX_AGE,
      sourceEnv.CONTEXT_SHREDDING_MSG_TIER1_MAX_AGE,
    ),
    4,
    { min: contextShreddingMsgTier0MaxAge, max: 50 },
  );
  envMap.CONTEXT_SHREDDING_MSG_TIER1_MAX_AGE = String(contextShreddingMsgTier1MaxAge);
  envMap.CONTEXT_SHREDDING_MSG_MIN_COMPRESS_CHARS = String(
    toBoundedInt(
      pickNonEmptyValue(
        env.contextShreddingMsgMinCompressChars,
        env.CONTEXT_SHREDDING_MSG_MIN_COMPRESS_CHARS,
        envMap.CONTEXT_SHREDDING_MSG_MIN_COMPRESS_CHARS,
        sourceEnv.CONTEXT_SHREDDING_MSG_MIN_COMPRESS_CHARS,
      ),
      120,
      { min: 0, max: 10000 },
    ),
  );
  envMap.CONTEXT_SHREDDING_USER_MSG_FULL_TURNS = String(
    toBoundedInt(
      pickNonEmptyValue(
        env.contextShreddingUserMsgFullTurns,
        env.CONTEXT_SHREDDING_USER_MSG_FULL_TURNS,
        envMap.CONTEXT_SHREDDING_USER_MSG_FULL_TURNS,
        sourceEnv.CONTEXT_SHREDDING_USER_MSG_FULL_TURNS,
      ),
      1,
      { min: 0, max: 20 },
    ),
  );
  envMap.CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_ENABLED = toBooleanEnvString(
    pickNonEmptyValue(
      env.contextShreddingLiveToolCompactionEnabled,
      env.CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_ENABLED,
      envMap.CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_ENABLED,
      sourceEnv.CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_ENABLED,
    ),
    false,
  );
  const liveToolCompactionMode = String(
    pickNonEmptyValue(
      env.contextShreddingLiveToolCompactionMode,
      env.CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MODE,
      envMap.CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MODE,
      sourceEnv.CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MODE,
    ) || "auto",
  ).trim().toLowerCase();
  envMap.CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MODE = ["off", "auto", "aggressive"].includes(liveToolCompactionMode)
    ? liveToolCompactionMode
    : "auto";
  envMap.CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_CHARS = String(
    toBoundedInt(
      pickNonEmptyValue(
        env.contextShreddingLiveToolCompactionMinChars,
        env.CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_CHARS,
        envMap.CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_CHARS,
        sourceEnv.CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_CHARS,
      ),
      4000,
      { min: 500, max: 500000 },
    ),
  );
  envMap.CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_TARGET_CHARS = String(
    toBoundedInt(
      pickNonEmptyValue(
        env.contextShreddingLiveToolCompactionTargetChars,
        env.CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_TARGET_CHARS,
        envMap.CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_TARGET_CHARS,
        sourceEnv.CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_TARGET_CHARS,
      ),
      1800,
      { min: 200, max: 50000 },
    ),
  );
  envMap.CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_SAVINGS_PCT = String(
    toBoundedInt(
      pickNonEmptyValue(
        env.contextShreddingLiveToolCompactionMinSavingsPct,
        env.CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_SAVINGS_PCT,
        envMap.CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_SAVINGS_PCT,
        sourceEnv.CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_SAVINGS_PCT,
      ),
      15,
      { min: 0, max: 95 },
    ),
  );
  envMap.CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_RUNTIME_MS = String(
    toBoundedInt(
      pickNonEmptyValue(
        env.contextShreddingLiveToolCompactionMinRuntimeMs,
        env.CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_RUNTIME_MS,
        envMap.CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_RUNTIME_MS,
        sourceEnv.CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_RUNTIME_MS,
      ),
      2000,
      { min: 0, max: 3600000 },
    ),
  );
  envMap.CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_BLOCK_STRUCTURED_OUTPUT = toBooleanEnvString(
    pickNonEmptyValue(
      env.contextShreddingLiveToolCompactionBlockStructuredOutput,
      env.CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_BLOCK_STRUCTURED_OUTPUT,
      envMap.CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_BLOCK_STRUCTURED_OUTPUT,
      sourceEnv.CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_BLOCK_STRUCTURED_OUTPUT,
    ),
    true,
  );
  const liveToolCompactionAllowCommands =
    env.contextShreddingLiveToolCompactionAllowCommands
    ?? env.CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_ALLOW_COMMANDS
    ?? envMap.CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_ALLOW_COMMANDS
    ?? sourceEnv.CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_ALLOW_COMMANDS
    ?? "grep,rg,find,findstr,select-string,ag,ack,sift,fd,where,which,ls,dir,tree,git,go,npm,pnpm,yarn,npx,bun,node,python,python3,pytest,pip,pip3,poetry,docker,kubectl,helm,terraform,ansible,ansible-playbook,journalctl,tail,get-content,cargo,gradle,maven,mvn,javac,tsc,jest,vitest,deno,make,cmake,bazel,buck,nx,turbo,rush,composer,bundle";
  envMap.CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_ALLOW_COMMANDS = String(liveToolCompactionAllowCommands).trim();
  const contextShreddingProfiles =
    env.contextShreddingProfiles
    ?? env.CONTEXT_SHREDDING_PROFILES
    ?? envMap.CONTEXT_SHREDDING_PROFILES
    ?? sourceEnv.CONTEXT_SHREDDING_PROFILES
    ?? "";
  envMap.CONTEXT_SHREDDING_PROFILES = String(contextShreddingProfiles).trim();
  envMap.COPILOT_ENABLE_ALL_GITHUB_MCP_TOOLS = toBooleanEnvString(
    pickNonEmptyValue(
      env.copilotEnableAllMcpTools,
      envMap.COPILOT_ENABLE_ALL_GITHUB_MCP_TOOLS,
      sourceEnv.COPILOT_ENABLE_ALL_GITHUB_MCP_TOOLS,
    ),
    false,
  );

  envMap.COPILOT_AGENT_MAX_REQUESTS = String(
    toBoundedInt(
      pickNonEmptyValue(
        env.copilotAgentMaxRequests,
        envMap.COPILOT_AGENT_MAX_REQUESTS,
        sourceEnv.COPILOT_AGENT_MAX_REQUESTS,
      ),
      500,
      { min: 1, max: 5000 },
    ),
  );
  envMap.CODEX_AGENT_MAX_THREADS = String(
    toBoundedInt(
      pickNonEmptyValue(
        env.codexAgentMaxThreads,
        envMap.CODEX_AGENT_MAX_THREADS,
        sourceEnv.CODEX_AGENT_MAX_THREADS,
      ),
      12,
      { min: 1, max: 256 },
    ),
  );
  envMap.CODEX_TRANSPORT = normalizeEnumValue(
    pickNonEmptyValue(env.codexTransport, envMap.CODEX_TRANSPORT, sourceEnv.CODEX_TRANSPORT),
    ["sdk", "auto", "cli"],
    "sdk",
  );
  envMap.COPILOT_TRANSPORT = normalizeEnumValue(
    pickNonEmptyValue(
      env.copilotTransport,
      envMap.COPILOT_TRANSPORT,
      sourceEnv.COPILOT_TRANSPORT,
    ),
    ["sdk", "auto", "cli", "url"],
    "sdk",
  );
  envMap.CODEX_SANDBOX = normalizeEnumValue(
    pickNonEmptyValue(env.codexSandbox, envMap.CODEX_SANDBOX, sourceEnv.CODEX_SANDBOX),
    ["workspace-write", "danger-full-access", "read-only"],
    "workspace-write",
  );
  envMap.VOICE_ENABLED = toBooleanEnvString(
    pickNonEmptyValue(
      env.voiceEnabled,
      env.VOICE_ENABLED,
      envMap.VOICE_ENABLED,
      sourceEnv.VOICE_ENABLED,
    ),
    true,
  );
  envMap.VOICE_PROVIDER = normalizeEnumValue(
    pickNonEmptyValue(
      env.voiceProvider,
      env.VOICE_PROVIDER,
      envMap.VOICE_PROVIDER,
      sourceEnv.VOICE_PROVIDER,
    ),
    ["auto", "openai", "azure", "claude", "gemini", "fallback"],
    "auto",
  );
  envMap.VOICE_MODEL = String(
    pickNonEmptyValue(
      env.voiceModel,
      env.VOICE_MODEL,
      envMap.VOICE_MODEL,
      sourceEnv.VOICE_MODEL,
    ) || "gpt-audio-1.5",
  ).trim() || "gpt-audio-1.5";
  envMap.VOICE_VISION_MODEL = String(
    pickNonEmptyValue(
      env.voiceVisionModel,
      env.VOICE_VISION_MODEL,
      envMap.VOICE_VISION_MODEL,
      sourceEnv.VOICE_VISION_MODEL,
    ) || "gpt-4.1-nano",
  ).trim() || "gpt-4.1-nano";
  envMap.VOICE_ID = normalizeEnumValue(
    pickNonEmptyValue(
      env.voiceId,
      env.VOICE_ID,
      envMap.VOICE_ID,
      sourceEnv.VOICE_ID,
    ),
    ["alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse"],
    "alloy",
  );
  envMap.VOICE_TURN_DETECTION = normalizeEnumValue(
    pickNonEmptyValue(
      env.voiceTurnDetection,
      env.VOICE_TURN_DETECTION,
      envMap.VOICE_TURN_DETECTION,
      sourceEnv.VOICE_TURN_DETECTION,
    ),
    ["server_vad", "semantic_vad", "none"],
    "semantic_vad",
  );
  envMap.VOICE_FALLBACK_MODE = normalizeEnumValue(
    pickNonEmptyValue(
      env.voiceFallbackMode,
      env.VOICE_FALLBACK_MODE,
      envMap.VOICE_FALLBACK_MODE,
      sourceEnv.VOICE_FALLBACK_MODE,
    ),
    ["browser", "disabled"],
    "browser",
  );
  envMap.VOICE_DELEGATE_EXECUTOR = normalizeEnumValue(
    pickNonEmptyValue(
      env.voiceDelegateExecutor,
      env.VOICE_DELEGATE_EXECUTOR,
      envMap.VOICE_DELEGATE_EXECUTOR,
      sourceEnv.VOICE_DELEGATE_EXECUTOR,
    ),
    ["codex-sdk", "copilot-sdk", "claude-sdk", "gemini-sdk", "opencode-sdk"],
    "codex-sdk",
  );
  envMap.VOICE_TRANSCRIPTION_ENABLED = toBooleanEnvString(
    pickNonEmptyValue(
      env.voiceTranscriptionEnabled,
      env.VOICE_TRANSCRIPTION_ENABLED,
      envMap.VOICE_TRANSCRIPTION_ENABLED,
      sourceEnv.VOICE_TRANSCRIPTION_ENABLED,
    ),
    true,
  );
  envMap.VOICE_TRANSCRIPTION_MODEL = String(
    pickNonEmptyValue(
      env.voiceTranscriptionModel,
      env.VOICE_TRANSCRIPTION_MODEL,
      envMap.VOICE_TRANSCRIPTION_MODEL,
      sourceEnv.VOICE_TRANSCRIPTION_MODEL,
    ) || "gpt-4o-transcribe",
  ).trim() || "gpt-4o-transcribe";
  envMap.VOICE_AZURE_TRANSCRIPTION_ENABLED = toBooleanEnvString(
    pickNonEmptyValue(
      env.voiceAzureTranscriptionEnabled,
      env.VOICE_AZURE_TRANSCRIPTION_ENABLED,
      envMap.VOICE_AZURE_TRANSCRIPTION_ENABLED,
      sourceEnv.VOICE_AZURE_TRANSCRIPTION_ENABLED,
    ),
    false,
  );

  const openaiRealtimeApiKey = pickNonEmptyValue(
    env.openaiRealtimeApiKey,
    env.OPENAI_REALTIME_API_KEY,
    envMap.OPENAI_REALTIME_API_KEY,
    sourceEnv.OPENAI_REALTIME_API_KEY,
  );
  if (openaiRealtimeApiKey !== undefined) {
    envMap.OPENAI_REALTIME_API_KEY = String(openaiRealtimeApiKey).trim();
  }

  const azureRealtimeEndpoint = pickNonEmptyValue(
    env.azureOpenaiRealtimeEndpoint,
    env.AZURE_OPENAI_REALTIME_ENDPOINT,
    envMap.AZURE_OPENAI_REALTIME_ENDPOINT,
    sourceEnv.AZURE_OPENAI_REALTIME_ENDPOINT,
    sourceEnv.AZURE_OPENAI_ENDPOINT,
  );
  if (azureRealtimeEndpoint !== undefined) {
    envMap.AZURE_OPENAI_REALTIME_ENDPOINT = String(azureRealtimeEndpoint).trim();
  }

  const azureRealtimeApiKey = pickNonEmptyValue(
    env.azureOpenaiRealtimeApiKey,
    env.AZURE_OPENAI_REALTIME_API_KEY,
    envMap.AZURE_OPENAI_REALTIME_API_KEY,
    sourceEnv.AZURE_OPENAI_REALTIME_API_KEY,
    sourceEnv.AZURE_OPENAI_API_KEY,
  );
  if (azureRealtimeApiKey !== undefined) {
    envMap.AZURE_OPENAI_REALTIME_API_KEY = String(azureRealtimeApiKey).trim();
  }

  envMap.AZURE_OPENAI_REALTIME_DEPLOYMENT = String(
    pickNonEmptyValue(
      env.azureOpenaiRealtimeDeployment,
      env.AZURE_OPENAI_REALTIME_DEPLOYMENT,
      envMap.AZURE_OPENAI_REALTIME_DEPLOYMENT,
      sourceEnv.AZURE_OPENAI_REALTIME_DEPLOYMENT,
    ) || "gpt-audio-1.5",
  ).trim() || "gpt-audio-1.5";

  envMap.CONTAINER_ENABLED = toBooleanEnvString(
    pickNonEmptyValue(env.containerEnabled, envMap.CONTAINER_ENABLED, sourceEnv.CONTAINER_ENABLED),
    false,
  );
  envMap.CONTAINER_RUNTIME = normalizeEnumValue(
    pickNonEmptyValue(env.containerRuntime, envMap.CONTAINER_RUNTIME, sourceEnv.CONTAINER_RUNTIME),
    ["auto", "docker", "podman", "container"],
    "auto",
  );
  envMap.WHATSAPP_ENABLED = toBooleanEnvString(
    pickNonEmptyValue(env.whatsappEnabled, envMap.WHATSAPP_ENABLED, sourceEnv.WHATSAPP_ENABLED),
    false,
  );
  envMap.TELEGRAM_INTERVAL_MIN = String(
    toBoundedInt(
      pickNonEmptyValue(
        env.telegramIntervalMin,
        envMap.TELEGRAM_INTERVAL_MIN,
        sourceEnv.TELEGRAM_INTERVAL_MIN,
      ),
      10,
      { min: 1, max: 1440 },
    ),
  );

  const orchestratorArgs = pickNonEmptyValue(
    env.orchestratorArgs,
    envMap.ORCHESTRATOR_ARGS,
    sourceEnv.ORCHESTRATOR_ARGS,
  );
  if (orchestratorArgs !== undefined) {
    envMap.ORCHESTRATOR_ARGS = String(orchestratorArgs).trim();
  }
  if (!envMap.ORCHESTRATOR_ARGS || String(envMap.ORCHESTRATOR_ARGS).trim() === "") {
    envMap.ORCHESTRATOR_ARGS = `-MaxParallel ${maxParallel}`;
  }

  applyHarnessProviderSetupDefaults(envMap, env, sourceEnv);
}

function hasConfiguredSetupValue(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return false;
  const lowered = normalized.toLowerCase();
  return lowered !== "undefined" && lowered !== "null";
}

function maybeSetEnvDefault(envMap, key, value) {
  if (!hasConfiguredSetupValue(value) || hasConfiguredSetupValue(envMap[key])) return false;
  envMap[key] = String(value).trim();
  return true;
}

function buildSetupHarnessProviderSummary(sourceEnv = process.env, settings = {}) {
  const effectiveSettings = settings && typeof settings === "object" ? { ...settings } : {};
  const providerIds = [
    "openai-codex-subscription",
    "openai-responses",
    "azure-openai-responses",
    "anthropic-messages",
    "claude-subscription-shim",
    "copilot-oauth",
    "openrouter",
    "perplexity",
    "deepinfra",
    "groq",
    "together",
    "xai",
    "fireworks",
    "cerebras",
    "sambanova",
    "nebius",
    "gemini-generate-content",
  ];
  const providers = providerIds.map((providerId) => normalizeProviderAuthState(providerId, {}, {
    env: sourceEnv,
    settings: effectiveSettings,
  }));
  const preferredDefault =
    providers.find((entry) => entry.providerId === "openai-codex-subscription" && entry.authenticated)
    || providers.find((entry) => entry.providerId === "openai-responses" && entry.authenticated)
    || providers.find((entry) => entry.providerId === "azure-openai-responses" && entry.authenticated)
    || providers.find((entry) => entry.providerId === "claude-subscription-shim" && entry.authenticated)
    || providers.find((entry) => entry.providerId === "copilot-oauth" && entry.authenticated)
    || providers.find((entry) => entry.providerId === "anthropic-messages" && entry.authenticated)
    || providers.find((entry) => entry.providerId === "openrouter" && entry.authenticated)
    || providers.find((entry) => entry.providerId === "perplexity" && entry.authenticated)
    || providers.find((entry) => entry.providerId === "deepinfra" && entry.authenticated)
    || providers.find((entry) => entry.providerId === "groq" && entry.authenticated)
    || providers.find((entry) => entry.providerId === "together" && entry.authenticated)
    || providers.find((entry) => entry.providerId === "xai" && entry.authenticated)
    || providers.find((entry) => entry.providerId === "fireworks" && entry.authenticated)
    || providers.find((entry) => entry.providerId === "cerebras" && entry.authenticated)
    || providers.find((entry) => entry.providerId === "sambanova" && entry.authenticated)
    || providers.find((entry) => entry.providerId === "nebius" && entry.authenticated)
    || providers.find((entry) => entry.providerId === "gemini-generate-content" && entry.authenticated)
    || null;
  return {
    providers,
    recommendedDefaultProviderId: preferredDefault?.providerId || "openai-responses",
  };
}

function applyHarnessProviderSetupDefaults(envMap, env = {}, sourceEnv = process.env) {
  const sharedAccounts = buildSharedProviderAccountSummary(true);
  const codexAuth = resolveCodexSubscriptionAuth(sourceEnv);
  const copilotAuth = resolveCopilotOAuthAuth(sourceEnv);

  if (codexAuth?.authenticated) {
    maybeSetEnvDefault(envMap, "BOSUN_PROVIDER_OPENAI_CODEX_SUBSCRIPTION_ENABLED", "true");
    if ((codexAuth.authMode || "").toLowerCase() !== "apikey") {
      maybeSetEnvDefault(envMap, "BOSUN_PROVIDER_OPENAI_CODEX_SUBSCRIPTION_MODE", "oauth");
    }
  }

  const openAiApiKey = pickNonEmptyValue(
    env.openaiApiKey,
    envMap.OPENAI_API_KEY,
    sourceEnv.OPENAI_API_KEY,
  );
  if (hasConfiguredSetupValue(openAiApiKey)) {
    maybeSetEnvDefault(envMap, "BOSUN_PROVIDER_OPENAI_RESPONSES_ENABLED", "true");
  }

  const azureEndpoint = pickNonEmptyValue(
    env.azureOpenaiRealtimeEndpoint,
    envMap.AZURE_OPENAI_ENDPOINT,
    sourceEnv.AZURE_OPENAI_ENDPOINT,
    sourceEnv.AZURE_OPENAI_REALTIME_ENDPOINT,
  );
  const azureApiKey = pickNonEmptyValue(
    env.azureOpenaiRealtimeApiKey,
    envMap.AZURE_OPENAI_API_KEY,
    sourceEnv.AZURE_OPENAI_API_KEY,
    sourceEnv.AZURE_OPENAI_REALTIME_API_KEY,
  );
  if ((hasConfiguredSetupValue(azureApiKey) || sharedAccounts.azure?.connected) && hasConfiguredSetupValue(azureEndpoint)) {
    maybeSetEnvDefault(envMap, "BOSUN_PROVIDER_AZURE_OPENAI_ENABLED", "true");
    if (sharedAccounts.azure?.connected && !hasConfiguredSetupValue(azureApiKey)) {
      maybeSetEnvDefault(envMap, "BOSUN_PROVIDER_AZURE_OPENAI_MODE", "oauth");
    }
  }

  const anthropicApiKey = pickNonEmptyValue(
    env.anthropicApiKey,
    envMap.ANTHROPIC_API_KEY,
    sourceEnv.ANTHROPIC_API_KEY,
  );
  if (hasConfiguredSetupValue(anthropicApiKey)) {
    maybeSetEnvDefault(envMap, "BOSUN_PROVIDER_ANTHROPIC_ENABLED", "true");
  }

  if (sharedAccounts.claude?.connected) {
    maybeSetEnvDefault(envMap, "BOSUN_PROVIDER_CLAUDE_SUBSCRIPTION_ENABLED", "true");
    maybeSetEnvDefault(envMap, "BOSUN_PROVIDER_CLAUDE_SUBSCRIPTION_MODE", "oauth");
  }

  if (copilotAuth?.authenticated) {
    maybeSetEnvDefault(envMap, "BOSUN_PROVIDER_COPILOT_OAUTH_ENABLED", "true");
  }

  if (!hasConfiguredSetupValue(envMap.BOSUN_PROVIDER_DEFAULT)) {
    const summary = buildSetupHarnessProviderSummary(sourceEnv, envMap);
    maybeSetEnvDefault(envMap, "BOSUN_PROVIDER_DEFAULT", summary.recommendedDefaultProviderId);
  }
}

function getCommandVersion(cmd) {
  try {
    return execSync(`${cmd} --version`, { stdio: "pipe", encoding: "utf8" }).trim().split("\n")[0];
  } catch {
    return null;
  }
}

function isWslInteropRuntime() {
  return Boolean(
    process.env.WSL_DISTRO_NAME
    || process.env.WSL_INTEROP
    || (process.platform === "win32"
      && String(process.env.HOME || "")
        .trim()
        .startsWith("/home/")),
  );
}

/**
 * Resolve the Bosun Home directory — the single root where bosun stores all its
 * configs, workspaces, and tooling.  Resolution order:
 *   1. BOSUN_HOME env var  (set by bosun after first run)
 *   2. BOSUN_DIR env var   (legacy compat)
 *   3. cwd if it already has a bosun.config.json AND is not inside a git repo
 *      we don't own (safety: prevents "bosun --setup" from contaminating whatever
 *      repo the user happened to be in when they ran the command)
 *   4. platform default config home + /bosun (same as runtime loader)
 */
function resolveConfigDir() {
  if (process.env.BOSUN_HOME) return resolve(process.env.BOSUN_HOME);
  if (process.env.BOSUN_DIR)  return resolve(process.env.BOSUN_DIR);

  const cwd = process.cwd();

  // Only treat CWD as an existing bosun home when:
  //  (a) it has a bosun.config.json (unambiguous marker — a generic .env is NOT enough
  //      because many repos ship one and we must not corrupt them), AND
  //  (b) it does NOT appear to be a foreign git repository
  //      (i.e. there is no .git directory that was initialised by someone else).
  const hasBosunConfig = existsSync(resolve(cwd, "bosun.config.json"));
  if (hasBosunConfig) {
    // Confirm it looks like an intentional bosun home (has .env too, or is ~/bosun)
    const isExpectedHome = resolve(homedir(), "bosun") === cwd ||
      existsSync(resolve(cwd, ".env"));
    if (isExpectedHome) return cwd;
  }

  const sandbox = ensureTestRuntimeSandbox();
  if (sandbox?.configDir) return sandbox.configDir;

  const preferWindowsDirs =
    process.platform === "win32" && !isWslInteropRuntime();
  const baseDir = preferWindowsDirs
    ? process.env.APPDATA
      || process.env.LOCALAPPDATA
      || process.env.USERPROFILE
      || process.env.HOME
      || homedir()
    : process.env.HOME
      || process.env.XDG_CONFIG_HOME
      || process.env.USERPROFILE
      || process.env.APPDATA
      || process.env.LOCALAPPDATA
      || homedir();

  return resolve(baseDir, "bosun");
}

/**
 * Ensure the given directory is listed in Claude Code's global
 * ~/.claude/settings.json under permissions.additionalDirectories.
 *
 * Claude Code uses this list to decide which directories outside the current
 * project root are readable/writable without per-session permission prompts.
 *
 * @param {string} dirPath  Absolute path to add
 * @returns {{ added: boolean, path: string }}
 */
function ensureClaudeAdditionalDirectory(dirPath) {
  const claudeDir = resolve(homedir(), ".claude");
  const settingsPath = resolve(claudeDir, "settings.json");
  const targetPath = resolve(dirPath);

  try {
    mkdirSync(claudeDir, { recursive: true });
    let settings = {};
    if (existsSync(settingsPath)) {
      try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); } catch { /* keep empty */ }
    }

    const perms = settings.permissions || (settings.permissions = {});
    const additional = perms.additionalDirectories || (perms.additionalDirectories = []);

    if (!additional.includes(targetPath)) {
      additional.push(targetPath);
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
      return { added: true, path: settingsPath };
    }
    return { added: false, path: settingsPath };
  } catch (err) {
    console.warn("[setup] could not update ~/.claude/settings.json:", err.message);
    return { added: false, path: settingsPath };
  }
}

/**
 * All projects live under here; global shared configs also live here.
 * Default: BOSUN_HOME/workspaces
 */
function resolveWorkspacesDir(bosunHome) {
  if (process.env.BOSUN_WORKSPACES_DIR) return resolve(process.env.BOSUN_WORKSPACES_DIR);
  return resolve(bosunHome || resolveConfigDir(), "workspaces");
}

function hasSetupMarkers(dir) {
  return [".env", "bosun.config.json", ".bosun.json", "bosun.json"]
    .some((name) => existsSync(resolve(dir, name)));
}

function detectRepoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", { stdio: "pipe", encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}

function detectRepoSlug() {
  try {
    const url = execSync("git remote get-url origin", { stdio: "pipe", encoding: "utf8" }).trim();
    const m = url.match(/github\.com[/:](.+?)(?:\.git)?$/);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

function detectProjectName(repoRoot) {
  try {
    const pkg = resolve(repoRoot, "package.json");
    if (existsSync(pkg)) {
      return JSON.parse(readFileSync(pkg, "utf8")).name || "";
    }
  } catch { /* ignore */ }
  return "";
}

function detectRepoVisibility(slug = detectRepoSlug()) {
  const normalized = normalizeRepoSlug(slug);
  if (!normalized || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) return "unknown";
  try {
    const output = execSync(`gh repo view ${JSON.stringify(normalized)} --json isPrivate`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const parsed = JSON.parse(output || "{}");
    if (parsed?.isPrivate === true) return "private";
    if (parsed?.isPrivate === false) return "public";
  } catch {
    // best-effort only
  }
  return "unknown";
}

function isStackLikeResponseText(value) {
  if (typeof value !== "string") return false;
  const lower = value.toLowerCase();
  return (value.includes("\n") && lower.includes(" at ")) || lower.includes("error:\n    at ");
}

function scrubResponseBody(body) {
  if (body == null) return body;
  if (body instanceof Error) {
    const safeMessage = String(body.message || "Internal server error");
    return { ok: false, error: isStackLikeResponseText(safeMessage) ? "Internal server error" : safeMessage };
  }
  if (typeof body === "string") {
    return isStackLikeResponseText(body) ? "Internal server error" : body;
  }
  if (Array.isArray(body)) return body.map((entry) => scrubResponseBody(entry));
  if (typeof body !== "object") return body;
  const out = {};
  for (const [key, value] of Object.entries(body)) {
    if (String(key).toLowerCase() === "stack") continue;
    out[key] = scrubResponseBody(value);
  }
  return out;
}

function jsonResponse(res, status, body) {
  const data = JSON.stringify(scrubResponseBody(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(data);
}

function textResponse(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// ── API Handlers ─────────────────────────────────────────────────────────────

function handlePrerequisites() {
  const git = commandExists("git");
  const gh = commandExists("gh");
  const node = commandExists("node");
  const pwsh = commandExists("pwsh");

  let ghAuth = false;
  if (gh) {
    try {
      execSync("gh auth status", { stdio: "pipe" });
      ghAuth = true;
    } catch { /* not authed */ }
  }

  return {
    ok: true,
    prerequisites: {
      git: {
        installed: git,
        version: git ? getCommandVersion("git") : null,
        required: true,
      },
      gh: {
        installed: gh,
        authenticated: ghAuth,
        version: gh ? getCommandVersion("gh") : null,
        required: true,
      },
      node: {
        installed: node,
        version: node ? process.version : null,
        required: true,
      },
      pwsh: {
        installed: pwsh,
        version: pwsh ? getCommandVersion("pwsh") : null,
        required: process.platform === "win32",
      },
    },
  };
}

async function handleStatus() {
  const configDir = resolveConfigDir();
  const configured = hasSetupMarkers(configDir);
  const repoRoot = detectRepoRoot();
  const slug = detectRepoSlug();
  const repoVisibility = detectRepoVisibility(slug);
  const projectName = detectProjectName(repoRoot);

  let existingConfig = null;
  const configPath = resolve(configDir, "bosun.config.json");
  if (existsSync(configPath)) {
    try {
      existingConfig = JSON.parse(readFileSync(configPath, "utf8"));
    } catch { /* ignore */ }
  }

  let existingEnv = {};
  const envPath = resolve(configDir, ".env");
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        existingEnv[key] = value;
      }
    }
  }

  // ── Detect existing GitHub OAuth ──────────────────────────────────────────
  let githubOAuth = null;
  try {
    const { loadOAuthState, getUserToken } = await import("../github/github-app-auth.mjs");
    const state = loadOAuthState();
    const token = getUserToken();
    if (token && state) {
      githubOAuth = {
        connected: true,
        user: state.user?.login || state.user?.name || null,
        savedAt: state.savedAt || null,
        installationIds: Array.isArray(state.installationIds) ? state.installationIds : [],
      };
    }
  } catch { /* github-app-auth not available — ignore */ }

  // ── Detect startup service + desktop shortcut status ──────────────────────
  let startupStatus = null;
  let desktopShortcutStatus = null;
  try {
    const { getStartupStatus, getStartupMethodName } = await import("../infra/startup-service.mjs");
    const status_ = getStartupStatus();
    startupStatus = { ...status_, methodName: getStartupMethodName() };
  } catch { /* ignore */ }
  try {
    const { getDesktopShortcutStatus, getDesktopShortcutMethodName } = await import("../infra/desktop-shortcut.mjs");
    const status_ = getDesktopShortcutStatus();
    desktopShortcutStatus = { ...status_, methodName: getDesktopShortcutMethodName() };
  } catch { /* ignore */ }

  const sharedConnectedAccounts = buildSharedProviderAccountSummary(true);
  const harnessProviderSetup = buildSetupHarnessProviderSummary(process.env, existingEnv);

  return {
    ok: true,
    configured,
    configDir,
    bosunHome: configDir,
    workspacesDir: resolveWorkspacesDir(configDir),
    repoRoot,
    slug,
    repoVisibility,
    projectName,
    existingConfig,
    existingEnv,
    githubOAuth,
    sharedConnectedAccounts,
    harnessProviderSetup,
    startupStatus,
    desktopShortcutStatus,
    version: getVersion(),
  };
}

function handleDefaults() {
  const repoRoot = detectRepoRoot();
  const slug = detectRepoSlug();
  const repoVisibility = detectRepoVisibility(slug);
  const projectName = detectProjectName(repoRoot);
  const bosunHome = resolveConfigDir();
  const workspacesDir = resolveWorkspacesDir(bosunHome);

  return {
    ok: true,
    defaults: buildStableSetupDefaults({
      projectName,
      slug,
      repoVisibility,
      repoRoot,
      bosunHome,
      workspacesDir,
    }),
    agentArchitecture: buildAgentConfigurationGuide({
      BOSUN_AGENT_RUNTIME: "harness",
      PRIMARY_AGENT: "codex-sdk",
      INTERNAL_EXECUTOR_SDK: "auto",
      EXECUTOR_MODE: "internal",
      EXECUTOR_DISTRIBUTION: "primary-only",
      EXECUTORS: "CODEX:DEFAULT:100",
      BOSUN_PROVIDER_DEFAULT: "openai-responses",
      BOSUN_PROVIDER_ROUTING_MODE: "default-only",
    }),
  };
}

function handleModels() {
  return { ok: true, models: MODELS };
}

function handleExecutors() {
  return { ok: true, executors: EXECUTOR_TYPES, kanbanBackends: KANBAN_BACKENDS };
}

function handleWorkflowTemplates() {
  const profileLookup = new Map(
    WORKFLOW_SETUP_PROFILES.map((profile) => [profile.id, profile]),
  );
  const templates = WORKFLOW_TEMPLATE_SUMMARIES.map((template) => ({
    ...template,
    setupProfileIds: Array.from(profileLookup.values())
      .filter((profile) => profile.templateIds.includes(template.id))
      .map((profile) => profile.id),
  }));
  return {
    ok: true,
    templates,
    profiles: WORKFLOW_SETUP_PROFILES.map((profile) => ({
      ...profile,
      templateCount: profile.templateIds.length,
    })),
    recommendedProfile: "balanced",
  };
}

/**
 * Attempt to fetch the live model list from an OpenAI-compatible endpoint.
 * Falls back to the static MODELS list if the probe fails.
 */
async function handleModelsProbe(body) {
  const { executor = "CODEX", apiKey = "", baseUrl = "" } = body || {};

  // Copilot and Claude Code use OAuth — we can't probe their model lists from
  // the server side. Return the static list with a note.
  if (
    executor === "COPILOT" ||
    executor === "CLAUDE_CODE" ||
    executor === "GEMINI" ||
    executor === "OPENCODE"
  ) {
    const key =
      executor === "COPILOT"
        ? "copilot"
        : executor === "CLAUDE_CODE"
          ? "claude"
          : executor === "GEMINI"
            ? "gemini"
            : "opencode";
    return {
      ok: true,
      models: MODELS[key] || [],
      source: "static",
      note: `${executor} uses OAuth authentication. Models listed are known-good values; your actual available models depend on your subscription.`,
    };
  }

  // For OpenAI / compatible endpoints, try GET /v1/models
  const { endpoint, headers } = buildModelsProbeRequest({ apiKey, baseUrl });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const resp = await fetch(endpoint, { headers, signal: controller.signal });
    clearTimeout(timeout);

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }

    const data = await resp.json();
    const ids = (data.data || [])
      .map((m) => m.id)
      .filter((id) => typeof id === "string" && id.length > 0)
      .sort();

    if (!ids.length) {
      throw new Error("Response contained no models");
    }

    // Mark the first id as recommended; preserve static recommendations where
    // they overlap with the live list.
    const staticRecommended = new Set(
      (MODELS.codex || []).filter((m) => m.recommended).map((m) => m.value),
    );

    const models = ids.map((id) => ({
      value: id,
      label: id,
      recommended: staticRecommended.has(id),
      live: true,
    }));

    // If none are recommended, recommend the first
    if (!models.some((m) => m.recommended) && models.length > 0) {
      models[0].recommended = true;
    }

    return { ok: true, models, source: "live", endpoint };
  } catch (err) {
    // Probe failed — return static list with a warning
    return {
      ok: true,
      models: MODELS.codex || [],
      source: "static",
      warning: `Could not reach ${endpoint}: ${err.message}. Showing static model list.`,
    };
  }
}

async function handleVoiceEndpointTest(body) {
  const { provider, apiKey, endpoint: azureEndpoint, deployment, authSource } = body || {};
  if (!provider) {
    return { ok: false, error: "provider is required" };
  }

  const normalizedProvider = String(provider).trim().toLowerCase();
  const useOAuth = authSource === "oauth";
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    let testUrl = "";
    const headers = {};

    if (normalizedProvider === "openai") {
      testUrl = "https://api.openai.com/v1/models";
      if (apiKey && !useOAuth) {
        headers.Authorization = `Bearer ${apiKey}`;
      } else {
        const shared = resolveSharedOAuthToken("openai", true);
        if (shared?.token) headers.Authorization = `Bearer ${shared.token}`;
      }
      if (!headers.Authorization) {
        return { ok: false, error: "No API key or OAuth token available" };
      }
    } else if (normalizedProvider === "azure") {
      if (!azureEndpoint) {
        return { ok: false, error: "Azure endpoint URL is required" };
      }
      if (!apiKey) {
        return { ok: false, error: "Azure API key is required" };
      }
      // Strip path suffix so users can paste full URLs without double-path 404s.
      let base = trimTrailingSlashes(String(azureEndpoint));
      try { const u = new URL(base); base = `${u.protocol}//${u.host}`; } catch { /* keep as-is */ }
      // Prefer /openai/models as a credential check — it works on both classic
      // Azure OpenAI resources AND Azure AI Foundry "Global Standard" deployments.
      // If a deployment name is provided, we verify it separately after confirming
      // the endpoint + key are valid.
      headers["api-key"] = apiKey;
      testUrl = `${base}/openai/models?api-version=2024-10-21`;
    } else if (normalizedProvider === "claude") {
      testUrl = "https://api.anthropic.com/v1/models";
      headers["anthropic-version"] = "2023-06-01";
      if (apiKey && !useOAuth) {
        headers["x-api-key"] = apiKey;
      } else {
        const shared = resolveSharedOAuthToken("claude", true);
        if (shared?.token) headers["x-api-key"] = shared.token;
      }
      if (!headers["x-api-key"]) {
        return { ok: false, error: "No API key or OAuth token available" };
      }
    } else if (normalizedProvider === "gemini") {
      let k = (apiKey && !useOAuth) ? apiKey : null;
      if (!k) {
        const shared = resolveSharedOAuthToken("gemini", true);
        if (shared?.token) k = shared.token;
      }
      if (!k) {
        return { ok: false, error: "No API key or OAuth token available" };
      }
      testUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(k)}`;
    } else {
      return { ok: false, error: `Unknown provider: ${provider}` };
    }

    const resp = await fetch(testUrl, { headers, signal: controller.signal });
    clearTimeout(timer);
    const latencyMs = Date.now() - start;
    if (resp.ok || resp.status === 200) {
      // For Azure with a deployment name, do a secondary check to verify the
      // deployment exists. We try chat/completions with max_tokens=1 — realtime
      // deployments return 400 (wrong endpoint type) which still confirms existence.
      if (normalizedProvider === "azure" && deployment) {
        const dep = String(deployment).trim();
        try {
          let base = trimTrailingSlashes(String(azureEndpoint));
          try { const u = new URL(base); base = `${u.protocol}//${u.host}`; } catch { /* keep */ }
          const depUrl = `${base}/openai/deployments/${encodeURIComponent(dep)}/chat/completions?api-version=2024-10-21`;
          const depCtrl = new AbortController();
          const depTimer = setTimeout(() => depCtrl.abort(), 8_000);
          const depResp = await fetch(depUrl, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ messages: [{ role: "user", content: "test" }], max_tokens: 1 }),
            signal: depCtrl.signal,
          });
          clearTimeout(depTimer);
          // 200 = chat model works, 400 = realtime model (expected), both confirm deployment exists
          if (depResp.ok || depResp.status === 400) {
            return { ok: true, latencyMs, deployment: dep };
          }
          if (depResp.status === 404) {
            return { ok: false, error: `Credentials valid but deployment "${dep}" not found — check the deployment name in Azure AI Foundry`, latencyMs };
          }
          return { ok: true, latencyMs, warning: `Credentials valid. Could not verify deployment "${dep}" (HTTP ${depResp.status})` };
        } catch {
          return { ok: true, latencyMs, warning: `Credentials valid. Could not verify deployment "${dep}" (timeout)` };
        }
      }
      return { ok: true, latencyMs };
    }
    const text = await resp.text().catch(() => "");
    let error = `HTTP ${resp.status}`;
    try {
      const parsed = JSON.parse(text);
      error = parsed?.error?.message || parsed?.error || error;
    } catch {
      // Keep generic HTTP status message.
    }
    // Azure-specific: provide helpful messages for common errors
    if (normalizedProvider === "azure") {
      if (resp.status === 401 || resp.status === 403) {
        error = `Authentication failed (HTTP ${resp.status}) — check API key and endpoint URL`;
      } else if (resp.status === 404) {
        error = `Endpoint not found (HTTP 404) — check the Azure endpoint URL. Use https://<resource>.openai.azure.com`;
      }
    }
    return { ok: false, error, latencyMs };
  } catch (err) {
    clearTimeout(timer);
    const latencyMs = Date.now() - start;
    const error = err?.name === "AbortError" ? "Timeout (10s)" : (err?.message || "Connection failed");
    return { ok: false, error, latencyMs };
  }
}

function handleValidate(body) {
  const errors = {};
  const { field, value } = body || {};

  if (!field) return { ok: false, error: "Missing 'field' in request body" };

  switch (field) {
    case "projectName":
      if (!value || typeof value !== "string" || value.trim().length === 0) {
        errors.projectName = "Project name is required";
      } else if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_ -]*$/.test(value.trim())) {
        errors.projectName = "Project name must start with a letter/number and contain only letters, numbers, spaces, hyphens, underscores";
      }
      break;
    case "repoSlug":
      if (value && !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(value.trim())) {
        errors.repoSlug = "Repo slug must be in owner/repo format";
      }
      break;
    case "telegramToken":
      if (value && !/^\d+:[A-Za-z0-9_-]+$/.test(value.trim())) {
        errors.telegramToken = "Invalid Telegram bot token format (expected: 123456:ABCdef...)";
      }
      break;
    case "telegramChatId":
      if (value && !/^-?\d+$/.test(value.trim())) {
        errors.telegramChatId = "Chat ID must be a number (can be negative for groups)";
      }
      break;
    default:
      break;
  }

  return { ok: true, valid: Object.keys(errors).length === 0, errors };
}

async function handleTelegramChatIdLookup(body) {
  const token = String(body?.token || "").trim();
  if (!token) {
    return { ok: false, status: 400, error: "TELEGRAM_BOT_TOKEN is required" };
  }

  try {
    const { chats, message } = await discoverTelegramChats(token);
    return { ok: true, status: 200, chats, message };
  } catch {
    return { ok: false, status: 500, error: "Failed to discover Telegram chats" };
  }
}

function handleApply(body) {
  try {
    const { env = {}, configJson = {} } = body || {};

    // Resolve home + workspaces dirs — prefer what the user chose in the wizard
    const bosunHome    = env.bosunHome    ? resolve(env.bosunHome)    : resolveConfigDir();
    const workspacesDir = env.workspacesDir ? resolve(env.workspacesDir) : resolveWorkspacesDir(bosunHome);
    const existingConfig = readExistingBosunConfig(bosunHome);

    // ── Create directory scaffold ───────────────────────────────────────────
    mkdirSync(bosunHome, { recursive: true });
    mkdirSync(workspacesDir, { recursive: true });

    // Global Codex CLI settings (shared across all workspaces)
    const codexDir = resolve(workspacesDir, ".codex");
    mkdirSync(codexDir, { recursive: true });
    const codexConfigPath = resolve(codexDir, "config.json");
    if (!existsSync(codexConfigPath)) {
      writeFileSync(codexConfigPath, JSON.stringify({
        "$schema": "https://openai.github.io/codex/schemas/config.json",
        fullAutoErrorMode: "ask",
        notify: false,
        history: { enabled: true, maxItems: 1000 },
        dangerouslyAllowFilePatterns: ["AGENTS.md", ".bosun/"],
      }, null, 2) + "\n", "utf8");
    }

    // Global VS Code / Copilot settings (shared across all workspaces)
    const vscodeDir = resolve(workspacesDir, ".vscode");
    mkdirSync(vscodeDir, { recursive: true });
    const vscodeSettingsPath = resolve(vscodeDir, "settings.json");
    if (!existsSync(vscodeSettingsPath)) {
      writeFileSync(vscodeSettingsPath, JSON.stringify({
        "github.copilot.enable": { "*": true },
        "github.copilot.editor.enableAutoCompletions": true,
        "chat.agent.enabled": true,
        "github.copilot.advanced": { "listCount": 10 },
      }, null, 2) + "\n", "utf8");
    }

    // Global hook templates + shared prompt library
    mkdirSync(resolve(workspacesDir, ".bosun", "hooks"),   { recursive: true });
    mkdirSync(resolve(workspacesDir, ".bosun", "prompts"), { recursive: true });

    // Scaffold built-in skills knowledge base
    try {
      scaffoldSkills(bosunHome);
    } catch (error_) {
      console.warn("[setup] skills scaffold warning:", error_.message);
    }

    // Self-documenting README
    const workspacesReadme = resolve(workspacesDir, "README.md");
    if (!existsSync(workspacesReadme)) {
      writeFileSync(workspacesReadme, [
        "# Bosun Workspaces",
        "",
        "Managed by [Bosun](https://github.com/virtengine/bosun).",
        "",
        "Each sub-directory here is a **workspace** (project). Bosun clones the repos",
        "it needs to work on into each workspace folder and manages hooks, prompts, and",
        "configs for each one.",
        "",
        "## Global settings (apply to every workspace)",
        "",
        "| Path | Purpose |",
        "|------|---------|",
        "| `.codex/config.json` | OpenAI Codex CLI config |",
        "| `.vscode/settings.json` | VS Code / Copilot settings |",
        "| `.bosun/hooks/` | Git hook templates (override per workspace) |",
        "| `.bosun/prompts/` | Shared agent prompt library |",
        "",
        "## Per-workspace settings",
        "",
        "Create `<workspace>/.bosun/config.json` to override any global setting for",
        "that workspace only. Hooks in `<workspace>/.bosun/hooks/` take priority over",
        "the global templates above.",
      ].join("\n") + "\n", "utf8");
    }

    // ── Build .env ──────────────────────────────────────────────────────────
    const envLines = [
      "# Generated by bosun setup wizard",
      `# ${new Date().toISOString()}`,
      "",
      "# Bosun home — root for all bosun data",
      `BOSUN_HOME=${bosunHome}`,
      `BOSUN_WORKSPACES_DIR=${workspacesDir}`,
      "",
    ];

    const envMap = {
      PROJECT_NAME: env.projectName || "my-project",
      GITHUB_REPO: env.repoSlug || "",
      ORCHESTRATOR_ARGS: env.orchestratorArgs || "",
      EXECUTORS: env.executors || "",
      BOSUN_PROJECT_DIR: bosunHome,
    };

    applyTelegramMiniAppSetupEnv(envMap, env, process.env);
    if (env.telegramChatId)      envMap.TELEGRAM_CHAT_ID         = env.telegramChatId;
    if (env.jiraUrl)             envMap.JIRA_BASE_URL            = env.jiraUrl;
    if (env.jiraProjectKey)      envMap.JIRA_PROJECT_KEY         = env.jiraProjectKey;
    if (env.jiraApiToken)        envMap.JIRA_API_TOKEN           = env.jiraApiToken;
    if (env.githubProjectNumber) envMap.GITHUB_PROJECT_NUMBER    = String(env.githubProjectNumber);

    // ── Optional setup values ───────────────────────────────────────────────
    if (env.primaryAgent)               envMap.PRIMARY_AGENT                 = env.primaryAgent;
    if (env.agentRuntime)               envMap.BOSUN_AGENT_RUNTIME           = env.agentRuntime;
    if (env.orchestratorScript)         envMap.ORCHESTRATOR_SCRIPT           = env.orchestratorScript;

    // ── Codex model profile settings ───────────────────────────────────────
    if (env.codexModelProfile)          envMap.CODEX_MODEL_PROFILE              = env.codexModelProfile;
    if (env.codexModelProfileSubagent)  envMap.CODEX_MODEL_PROFILE_SUBAGENT     = env.codexModelProfileSubagent;
    if (env.codexXlProvider)            envMap.CODEX_MODEL_PROFILE_XL_PROVIDER  = env.codexXlProvider;
    if (env.codexXlModel)               envMap.CODEX_MODEL_PROFILE_XL_MODEL     = env.codexXlModel;
    if (env.codexMProvider)             envMap.CODEX_MODEL_PROFILE_M_PROVIDER   = env.codexMProvider;
    if (env.codexMModel)                envMap.CODEX_MODEL_PROFILE_M_MODEL      = env.codexMModel;
    if (env.codexSandboxPermissions)    envMap.CODEX_SANDBOX_PERMISSIONS        = env.codexSandboxPermissions;
    if (env.codexSandboxWritableRoots)  envMap.CODEX_SANDBOX_WRITABLE_ROOTS     = env.codexSandboxWritableRoots;
    if (env.codexFeaturesNoBwrap)       envMap.CODEX_FEATURES_NO_BWRAP          = "true";

    // ── Copilot settings ───────────────────────────────────────────────────
    if (env.copilotNoExperimental)      envMap.COPILOT_NO_EXPERIMENTAL          = "true";
    if (env.copilotNoAllowAll)          envMap.COPILOT_NO_ALLOW_ALL             = "true";
    if (env.copilotEnableAskUser)       envMap.COPILOT_ENABLE_ASK_USER          = "true";
    if (env.copilotMcpConfig)           envMap.COPILOT_MCP_CONFIG               = env.copilotMcpConfig;

    // ── Sentinel / watchdog ────────────────────────────────────────────────
    if (env.sentinelAutoStart != null)          envMap.BOSUN_SENTINEL_AUTO_START        = env.sentinelAutoStart ? "true" : "false";
    if (env.sentinelStrict != null)             envMap.BOSUN_SENTINEL_STRICT            = env.sentinelStrict ? "true" : "false";
    if (env.sentinelAutoRestartMonitor != null) envMap.SENTINEL_AUTO_RESTART_MONITOR    = env.sentinelAutoRestartMonitor ? "true" : "false";
    if (env.sentinelCrashLoopThreshold)         envMap.SENTINEL_CRASH_LOOP_THRESHOLD    = String(env.sentinelCrashLoopThreshold);
    if (env.sentinelCrashLoopWindowMin)         envMap.SENTINEL_CRASH_LOOP_WINDOW_MIN   = String(env.sentinelCrashLoopWindowMin);
    if (env.sentinelRepairAgentEnabled != null) envMap.SENTINEL_REPAIR_AGENT_ENABLED    = env.sentinelRepairAgentEnabled ? "true" : "false";
    if (env.sentinelRepairTimeoutMin)           envMap.SENTINEL_REPAIR_TIMEOUT_MIN      = String(env.sentinelRepairTimeoutMin);

    // ── Daemon restart policy ──────────────────────────────────────────────
    if (env.daemonRestartDelayMs != null)       envMap.RESTART_DELAY_MS                      = String(env.daemonRestartDelayMs);
    if (env.daemonMaxRestarts != null)          envMap.MAX_RESTARTS                           = String(env.daemonMaxRestarts);
    if (env.daemonMaxInstantRestarts)           envMap.BOSUN_DAEMON_MAX_INSTANT_RESTARTS      = String(env.daemonMaxInstantRestarts);
    if (env.daemonInstantCrashWindowMs)         envMap.BOSUN_DAEMON_INSTANT_CRASH_WINDOW_MS   = String(env.daemonInstantCrashWindowMs);

    // Ensure every setup field has safe defaults and invalid values are normalized.
    applyNonBlockingSetupEnvDefaults(envMap, env, process.env);

    // Write executor-specific API keys for any executor configured with api-key auth mode.
    // Executors using OAuth login (codex auth login / gh auth login / claude login)
    // do NOT need env vars — omitting them lets the executor use its stored credentials.
    if (Array.isArray(configJson.executors)) {
      for (const ex of configJson.executors) {
        if (ex?.authMode !== "api-key") continue;
        const type = (ex.executor || "").toUpperCase();
        const isPrimaryRole = String(ex.role || "").toLowerCase() === "primary";
        const codexProfileName = String(ex.codexProfile || "").trim();
        const codexProfileEnvBase = codexProfileName
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, "_");
        if (type === "CODEX" || type === "OPENAI") {
          const connections = Array.isArray(ex.connections) ? ex.connections.filter((c) => c.apiKey || c.baseUrl) : [];
          if (connections.length > 0) {
            // Multi-connection path — first connection is the primary key/endpoint
            const primary = connections[0];
            if (primary.apiKey && (isPrimaryRole || !envMap.OPENAI_API_KEY)) {
              envMap.OPENAI_API_KEY = primary.apiKey;
            }
            if (primary.baseUrl && (isPrimaryRole || !envMap.OPENAI_BASE_URL)) {
              envMap.OPENAI_BASE_URL = primary.baseUrl;
            }
            if (
              codexProfileName &&
              (isPrimaryRole || !envMap.CODEX_MODEL_PROFILE)
            ) {
              envMap.CODEX_MODEL_PROFILE = codexProfileName;
            }
            // Additional connections become named Codex model profiles
            for (let ci = 1; ci < connections.length; ci++) {
              const conn = connections[ci];
              const profileName = (conn.name || `profile${ci}`)
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, "_");
              if (conn.apiKey)  envMap[`CODEX_MODEL_PROFILE_${profileName}_API_KEY`]  = conn.apiKey;
              if (conn.baseUrl) envMap[`CODEX_MODEL_PROFILE_${profileName}_BASE_URL`] = conn.baseUrl;
            }
          } else if (codexProfileEnvBase) {
            // Explicit per-executor profile path.
            if (ex.apiKey) {
              envMap[`CODEX_MODEL_PROFILE_${codexProfileEnvBase}_API_KEY`] = ex.apiKey;
            }
            if (ex.baseUrl) {
              envMap[`CODEX_MODEL_PROFILE_${codexProfileEnvBase}_BASE_URL`] = ex.baseUrl;
            }
            if (ex.apiKey && (isPrimaryRole || !envMap.OPENAI_API_KEY)) {
              envMap.OPENAI_API_KEY = ex.apiKey;
            }
            if (ex.baseUrl && (isPrimaryRole || !envMap.OPENAI_BASE_URL)) {
              envMap.OPENAI_BASE_URL = ex.baseUrl;
            }
            if (isPrimaryRole || !envMap.CODEX_MODEL_PROFILE) {
              envMap.CODEX_MODEL_PROFILE = codexProfileName;
            }
          } else {
            // Legacy single-key path (no connections array configured)
            if (ex.apiKey && (isPrimaryRole || !envMap.OPENAI_API_KEY)) {
              envMap.OPENAI_API_KEY = ex.apiKey;
            }
            if (ex.baseUrl && (isPrimaryRole || !envMap.OPENAI_BASE_URL)) {
              envMap.OPENAI_BASE_URL = ex.baseUrl;
            }
          }
        } else if (type === "CLAUDE_CODE" || type === "ANTHROPIC") {
          if (ex.apiKey)  envMap.ANTHROPIC_API_KEY  = ex.apiKey;
          if (ex.baseUrl) envMap.ANTHROPIC_BASE_URL = ex.baseUrl;
          // Note: Anthropic does not have a native multi-profile env-var system;
          // only a single key/endpoint is supported for this executor type.
        } else if (type === "GEMINI" || type === "GOOGLE_GEMINI") {
          if (ex.apiKey) {
            envMap.GEMINI_API_KEY = ex.apiKey;
          }
          if (ex.baseUrl) {
            envMap.GEMINI_BASE_URL = ex.baseUrl;
          }
        }
        // COPILOT uses gh auth — no API key env vars needed.
      }
    }

    for (const [key, value] of Object.entries(envMap)) {
      if (value !== undefined && value !== null && value !== "") {
        envLines.push(`${key}=${value}`);
      }
    }

    const envPath = resolve(bosunHome, ".env");
    writeFileSync(envPath, envLines.join("\n") + "\n", "utf8");

    // ── Build bosun.config.json ─────────────────────────────────────────────
    const config = {
      ...existingConfig,
      projectName: configJson.projectName || env.projectName || "my-project",
      bosunHome,
      workspacesDir,
      executors:
        Array.isArray(configJson.executors)
          ? configJson.executors
          : Array.isArray(existingConfig.executors)
            ? existingConfig.executors
            : [],
      failover: configJson.failover || {
        ...(existingConfig.failover || {}),
        strategy: env.failoverStrategy || "next-in-line",
        maxRetries: Number(env.maxRetries) || 3,
        cooldownMinutes: Number(env.failoverCooldownMinutes) || 5,
        disableOnConsecutiveFailures: Number(env.failoverDisableOnConsecutive) || 3,
      },
      distribution:
        configJson.distribution ||
        existingConfig.distribution ||
        env.executorDistribution ||
        "primary-only",
    };

    const workflowProfile = normalizeWorkflowProfile(
      configJson.workflowDefaults?.profile || env.workflowProfile,
      "balanced",
    );
    const fallbackWorkflowTemplateIds = resolveWorkflowTemplateIds({ profileId: workflowProfile });
    const workflowDefaultTemplateIds = normalizeWorkflowTemplateIds(
      configJson.workflowDefaults?.templates || env.workflowDefaultTemplates,
      fallbackWorkflowTemplateIds,
    );
    const workflowTemplateOverridesById = normalizeWorkflowTemplateOverrides(
      configJson.workflowDefaults?.templateOverridesById || env.workflowTemplateOverridesById,
      workflowDefaultTemplateIds,
    );
    const workflowAutoInstall = Boolean(
      configJson.workflowDefaults?.autoInstall ??
      env.workflowAutoInstall ??
      true,
    );
    const workflowEngineConfig = {
      nodeMaxRetries: toBoundedInt(
        configJson.workflowEngine?.nodeMaxRetries ?? env.workflowNodeMaxRetries,
        3,
        { min: 0, max: 20 },
      ),
      nodeTimeoutMs: toBoundedInt(
        configJson.workflowEngine?.nodeTimeoutMs ?? env.workflowNodeTimeoutMs,
        600000,
        { min: 1000, max: 21_600_000 },
      ),
      runStuckThresholdMs: toBoundedInt(
        configJson.workflowEngine?.runStuckThresholdMs ?? env.workflowRunStuckThresholdMs,
        300000,
        { min: 10000, max: 7_200_000 },
      ),
      maxPersistedRuns: toBoundedInt(
        configJson.workflowEngine?.maxPersistedRuns ?? env.workflowMaxPersistedRuns,
        200,
        { min: 20, max: 5000 },
      ),
      maxConcurrentBranches: toBoundedInt(
        configJson.workflowEngine?.maxConcurrentBranches ?? env.workflowMaxConcurrentBranches,
        8,
        { min: 1, max: 64 },
      ),
    };
    config.workflowDefaults = {
      profile: workflowProfile,
      autoInstall: workflowAutoInstall,
      templates: workflowDefaultTemplateIds,
      templateOverridesById: workflowTemplateOverridesById,
    };
    config.prAutomation = {
      ...(existingConfig.prAutomation && typeof existingConfig.prAutomation === "object" ? existingConfig.prAutomation : {}),
      ...(configJson.prAutomation && typeof configJson.prAutomation === "object" ? configJson.prAutomation : {}),
      assistiveActions: {
        ...((existingConfig.prAutomation?.assistiveActions && typeof existingConfig.prAutomation.assistiveActions === "object")
          ? existingConfig.prAutomation.assistiveActions
          : {}),
        ...((configJson.prAutomation?.assistiveActions && typeof configJson.prAutomation.assistiveActions === "object")
          ? configJson.prAutomation.assistiveActions
          : {}),
      },
    };
    config.gates = {
      ...(existingConfig.gates && typeof existingConfig.gates === "object" ? existingConfig.gates : {}),
      ...(configJson.gates && typeof configJson.gates === "object" ? configJson.gates : {}),
      prs: {
        ...((existingConfig.gates?.prs && typeof existingConfig.gates.prs === "object")
          ? existingConfig.gates.prs
          : {}),
        ...((configJson.gates?.prs && typeof configJson.gates.prs === "object")
          ? configJson.gates.prs
          : {}),
      },
      checks: {
        ...((existingConfig.gates?.checks && typeof existingConfig.gates.checks === "object")
          ? existingConfig.gates.checks
          : {}),
        ...((configJson.gates?.checks && typeof configJson.gates.checks === "object")
          ? configJson.gates.checks
          : {}),
      },
      execution: {
        ...((existingConfig.gates?.execution && typeof existingConfig.gates.execution === "object")
          ? existingConfig.gates.execution
          : {}),
        ...((configJson.gates?.execution && typeof configJson.gates.execution === "object")
          ? configJson.gates.execution
          : {}),
      },
      runtime: {
        ...((existingConfig.gates?.runtime && typeof existingConfig.gates.runtime === "object")
          ? existingConfig.gates.runtime
          : {}),
        ...((configJson.gates?.runtime && typeof configJson.gates.runtime === "object")
          ? configJson.gates.runtime
          : {}),
      },
    };

    const localProtocol = toBooleanEnvString(envMap.TELEGRAM_UI_TLS_DISABLE, false) === "true" ? "http" : "https";
    const localHost = String(envMap.TELEGRAM_UI_DESKTOP_HOST || envMap.TELEGRAM_UI_HOST || "127.0.0.1").trim() || "127.0.0.1";
    const localConnection = buildLocalConnectionEntry({
      name: "Local Backend",
      host: localHost,
      port: Number(envMap.TELEGRAM_UI_PORT || DEFAULT_TELEGRAM_UI_PORT),
      protocol: localProtocol,
    });
    if (localConnection) {
      const remoteConfig = setLocalConnectionConfig(
        readRemoteConnectionConfig(bosunHome),
        localConnection,
      );
      saveRemoteConnectionConfig(remoteConfig, bosunHome);
    }
    config.workflowEngine = workflowEngineConfig;

    if (configJson.executorMode)               config.executorMode               = configJson.executorMode;
    if (configJson.primaryAgent)               config.primaryAgent               = configJson.primaryAgent;
    if (configJson.projectRequirementsProfile) config.projectRequirementsProfile = configJson.projectRequirementsProfile;
    if (configJson.internalReplenish)          config.internalReplenish          = configJson.internalReplenish;
    if (configJson.kanban)                     config.kanban                     = configJson.kanban;
    if (configJson.voice && typeof configJson.voice === "object") config.voice = configJson.voice;

    const workspaceConfig = resolveSetupWorkspaceAndRepoConfig(
      existingConfig,
      configJson,
      env,
    );
    if (workspaceConfig.repos.length > 0) {
      config.repos = workspaceConfig.repos;
    } else {
      delete config.repos;
    }

    if (workspaceConfig.workspaces.length > 0) {
      config.workspaces = workspaceConfig.workspaces;
      config.activeWorkspace = workspaceConfig.activeWorkspace;
    } else {
      delete config.workspaces;
      delete config.activeWorkspace;
    }

    const configPath = resolve(bosunHome, "bosun.config.json");
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");

    // ── Trust the BOSUN_HOME in every agent CLI ─────────────────────────────
    // Without this, running a codex agent from bosunHome is rejected with:
    //   ":alert: Project config.toml files are disabled…"
    // We also register bosunHome with Claude Code so it won't prompt for
    // permission when accessing the workspace directories.

    // 1. Codex: add bosunHome to trusted_projects in ~/.codex/config.toml
    try {
      const trustedResult = ensureTrustedProjects([bosunHome, workspacesDir]);
      if (trustedResult.added.length > 0) {
        console.log("  :check: Codex: trusted bosun home directory:", trustedResult.added.join(", "));
      }
    } catch (err) {
      console.warn("[setup] could not update codex trusted_projects:", err.message);
    }

    // 2. Claude Code: add bosunHome to additionalDirectories
    try {
      const claudeResult = ensureClaudeAdditionalDirectory(bosunHome);
      const claudeWs = ensureClaudeAdditionalDirectory(workspacesDir);
      if (claudeResult.added || claudeWs.added) {
        console.log("  :check: Claude: added bosun directories to additionalDirectories");
      }
    } catch (err) {
      console.warn("[setup] could not update claude settings:", err.message);
    }

    // 3. Call ensureCodexConfig to ensure ~/.codex/config.toml has global
    //    bosun settings (sandbox, feature flags, timeouts, etc.).
    try {
      ensureCodexConfig({
        env: { ...process.env, BOSUN_HOME: bosunHome, BOSUN_WORKSPACES_DIR: workspacesDir },
      });
    } catch (err) {
      console.warn("[setup] could not update codex global config:", err.message);
    }

    return { ok: true, bosunHome, workspacesDir, envPath, configPath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Server ───────────────────────────────────────────────────────────────────

/**
 * Handle /api/setup/* routes.
 * Reusable from both the standalone setup server and the unified ui-server.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {URL} url
 * @param {object} [options]
 * @param {() => void} [options.onComplete] - callback for unified mode (instead of process.exit)
 * @returns {Promise<boolean>} true if the route was handled
 */
async function handleSetupApi(req, res, url, options = {}) {
  if (!url.pathname.startsWith("/api/setup/")) return false;

  const route = url.pathname.replace("/api/setup/", "");

  try {
    switch (route) {
      case "status":
        jsonResponse(res, 200, await handleStatus());
        return true;
      case "vendor-status":
        jsonResponse(res, 200, checkVendorFiles());
        return true;
      case "prerequisites":
        jsonResponse(res, 200, handlePrerequisites());
        return true;
      case "defaults":
        jsonResponse(res, 200, handleDefaults());
        return true;
      case "models":
        jsonResponse(res, 200, handleModels());
        return true;
      case "models/probe":
        if (req.method !== "POST") {
          jsonResponse(res, 405, { ok: false, error: "POST required" });
          return true;
        }
        jsonResponse(res, 200, await handleModelsProbe(await readBody(req)));
        return true;
      case "executors":
        jsonResponse(res, 200, handleExecutors());
        return true;
      case "workflows":
        jsonResponse(res, 200, handleWorkflowTemplates());
        return true;
      case "voice/endpoints/test":
        if (req.method !== "POST") {
          jsonResponse(res, 405, { ok: false, error: "POST required" });
          return true;
        }
        jsonResponse(res, 200, await handleVoiceEndpointTest(await readBody(req)));
        return true;

      // ── Voice OAuth auth routes ─────────────────────────────────────────
      case "voice/auth/openai/status":
      case "voice/auth/claude/status":
      case "voice/auth/gemini/status": {
        const provider = route.split("/")[2]; // openai | claude | gemini
        try {
          const statusFns = {
            openai: "getOpenAILoginStatus",
            claude: "getClaudeLoginStatus",
            gemini: "getGeminiLoginStatus",
          };
          const mod = await import("../voice/voice-auth-manager.mjs");
          const fn = mod[statusFns[provider]];
          if (!fn) throw new Error(`No status function for ${provider}`);
          jsonResponse(res, 200, { ok: true, ...fn() });
        } catch (err) {
          jsonResponse(res, 200, { ok: true, status: "idle", hasToken: false, error: err.message });
        }
        return true;
      }
      case "voice/auth/openai/login":
      case "voice/auth/claude/login":
      case "voice/auth/gemini/login": {
        if (req.method !== "POST") {
          jsonResponse(res, 405, { ok: false, error: "POST required" });
          return true;
        }
        const provider = route.split("/")[2];
        try {
          const loginFns = {
            openai: "startOpenAICodexLogin",
            claude: "startClaudeLogin",
            gemini: "startGeminiLogin",
          };
          const mod = await import("../voice/voice-auth-manager.mjs");
          const fn = mod[loginFns[provider]];
          if (!fn) throw new Error(`No login function for ${provider}`);
          const result = fn({ openBrowser: false });
          jsonResponse(res, 200, { ok: true, ...(result || {}) });
        } catch (err) {
          jsonResponse(res, 500, { ok: false, error: err.message });
        }
        return true;
      }
      case "voice/auth/openai/logout":
      case "voice/auth/claude/logout":
      case "voice/auth/gemini/logout": {
        if (req.method !== "POST") {
          jsonResponse(res, 405, { ok: false, error: "POST required" });
          return true;
        }
        const provider = route.split("/")[2];
        try {
          const logoutFns = {
            openai: "logoutOpenAI",
            claude: "logoutClaude",
            gemini: "logoutGemini",
          };
          const mod = await import("../voice/voice-auth-manager.mjs");
          const fn = mod[logoutFns[provider]];
          if (!fn) throw new Error(`No logout function for ${provider}`);
          const result = fn();
          jsonResponse(res, 200, { ok: true, ...(result || {}) });
        } catch (err) {
          jsonResponse(res, 500, { ok: false, error: err.message });
        }
        return true;
      }
      case "voice/auth/openai/cancel":
      case "voice/auth/claude/cancel":
      case "voice/auth/gemini/cancel": {
        if (req.method !== "POST") {
          jsonResponse(res, 405, { ok: false, error: "POST required" });
          return true;
        }
        const provider = route.split("/")[2];
        try {
          const cancelFns = {
            openai: "cancelOpenAILogin",
            claude: "cancelClaudeLogin",
            gemini: "cancelGeminiLogin",
          };
          const mod = await import("../voice/voice-auth-manager.mjs");
          const fn = mod[cancelFns[provider]];
          if (!fn) throw new Error(`No cancel function for ${provider}`);
          fn();
          jsonResponse(res, 200, { ok: true });
        } catch (err) {
          jsonResponse(res, 500, { ok: false, error: err.message });
        }
        return true;
      }

      case "validate":
        if (req.method !== "POST") {
          jsonResponse(res, 405, { ok: false, error: "POST required" });
          return true;
        }
        jsonResponse(res, 200, handleValidate(await readBody(req)));
        return true;
      case "telegram-chat-id": {
        if (req.method !== "POST") {
          jsonResponse(res, 405, { ok: false, error: "POST required" });
          return true;
        }
        const result = await handleTelegramChatIdLookup(await readBody(req));
        jsonResponse(res, result.status, result);
        return true;
      }
      case "apply":
        if (req.method !== "POST") {
          jsonResponse(res, 405, { ok: false, error: "POST required" });
          return true;
        }
        jsonResponse(res, 200, handleApply(await readBody(req)));
        return true;
      case "install-startup": {
        if (req.method !== "POST") {
          jsonResponse(res, 405, { ok: false, error: "POST required" });
          return true;
        }
        try {
          const body_ = await readBody(req);
          const { installStartupService } = await import("../infra/startup-service.mjs");
          const result = await installStartupService({ daemon: body_?.daemon !== false });
          jsonResponse(res, 200, { ok: true, ...result });
        } catch (err) {
          jsonResponse(res, 500, { ok: false, error: err.message });
        }
        return true;
      }
      case "remove-startup": {
        if (req.method !== "POST") {
          jsonResponse(res, 405, { ok: false, error: "POST required" });
          return true;
        }
        try {
          const { removeStartupService } = await import("../infra/startup-service.mjs");
          const result = await removeStartupService();
          jsonResponse(res, 200, { ok: true, ...result });
        } catch (err) {
          jsonResponse(res, 500, { ok: false, error: err.message });
        }
        return true;
      }
      case "install-desktop-shortcut": {
        if (req.method !== "POST") {
          jsonResponse(res, 405, { ok: false, error: "POST required" });
          return true;
        }
        try {
          const { installDesktopShortcut } = await import("../infra/desktop-shortcut.mjs");
          const result = installDesktopShortcut();
          jsonResponse(res, 200, { ok: true, ...result });
        } catch (err) {
          jsonResponse(res, 500, { ok: false, error: err.message });
        }
        return true;
      }
      case "remove-desktop-shortcut": {
        if (req.method !== "POST") {
          jsonResponse(res, 405, { ok: false, error: "POST required" });
          return true;
        }
        try {
          const { removeDesktopShortcut } = await import("../infra/desktop-shortcut.mjs");
          const result = removeDesktopShortcut();
          jsonResponse(res, 200, { ok: true, ...result });
        } catch (err) {
          jsonResponse(res, 500, { ok: false, error: err.message });
        }
        return true;
      }
      case "complete":
        if (req.method !== "POST") {
          jsonResponse(res, 405, { ok: false, error: "POST required" });
          return true;
        }
        jsonResponse(res, 200, { ok: true, message: "Setup complete" });
        if (options.onComplete) {
          // Unified mode: signal completion instead of exiting
          setTimeout(() => options.onComplete(), 500);
        } else {
          // Standalone mode: shut down setup server
          setTimeout(() => {
            console.log("\n  :check: Setup complete — shutting down wizard server.\n");
            if (callbackServer) callbackServer.close();
            server.close();
            process.exit(0);
          }, 500);
        }
        return true;
      case "oauth-state": {
        // The setup wizard polls this to detect when the GitHub OAuth callback
        // has been received (possibly on a different port).
        const pendingPath = oauthPendingPath();
        if (existsSync(pendingPath)) {
          try {
            const raw = readFileSync(pendingPath, "utf8");
            const data = JSON.parse(raw);
            // Delete the file so it's only claimed once
            try { unlinkSync(pendingPath); } catch { /* ignore */ }
            jsonResponse(res, 200, { ok: true, pending: true, ...data });
          } catch {
            jsonResponse(res, 200, { ok: true, pending: false });
          }
        } else {
          jsonResponse(res, 200, { ok: true, pending: false });
        }
        return true;
      }
      default:
        jsonResponse(res, 404, { ok: false, error: `Unknown route: ${route}` });
        return true;
    }
  } catch (err) {
    jsonResponse(res, 500, { ok: false, error: err.message });
    return true;
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // Health check / relay-page detection
  if (url.pathname === "/ping") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify({ ok: true, server: "setup" }));
    return;
  }

  // Vendor library files for the setup UI
  // Priority: bundled ui/vendor/ → node_modules resolution → CDN redirect
  if (url.pathname.startsWith("/vendor/")) {
    const name = url.pathname.replace(/^\/vendor\//, "");
    const entry = VENDOR_FILES[name];
    if (!entry) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }
    const vendorHeaders = {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
      "Access-Control-Allow-Origin": "*",
    };
    // ── 1. Bundled static file ─────────────────────────────────────────────
    const bundledPath = resolve(BUNDLED_VENDOR_DIR, name);
    if (existsSync(bundledPath)) {
      try {
        const data = readFileSync(bundledPath);
        res.writeHead(200, { ...vendorHeaders, "X-Bosun-Vendor": "bundled" });
        res.end(data);
        return;
      } catch { /* fall through */ }
    }
    // ── 2. node_modules resolution ────────────────────────────────────────
    const localPath = resolveVendorPath(entry.specifier);
    if (localPath && existsSync(localPath)) {
      try {
        const data = readFileSync(localPath);
        res.writeHead(200, { ...vendorHeaders, "X-Bosun-Vendor": "node_modules" });
        res.end(data);
        return;
      } catch { /* fall through to CDN */ }
    }
    // ── 3. CDN fallback ───────────────────────────────────────────────────
    res.writeHead(302, { Location: entry.cdn, "Cache-Control": "no-store" });
    res.end();
    return;
  }

  // API routes — delegate to the shared handler (standalone mode, no onComplete callback)
  if (url.pathname.startsWith("/api/setup/")) {
    await handleSetupApi(req, res, url);
    return;
  }

  // Static file serving from ui/
  let pathname = url.pathname === "/" || url.pathname === "/setup" ? "/setup.html" : url.pathname;
  const filePath = resolve(uiRoot, `.${pathname}`);

  if (!filePath.startsWith(uiRoot)) {
    textResponse(res, 403, "Forbidden");
    return;
  }

  if (!existsSync(filePath)) {
    // Fallback to setup.html for SPA-style routing
    const fallback = resolve(uiRoot, "setup.html");
    if (existsSync(fallback)) {
      const data = readFileSync(fallback);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(data);
      return;
    }
    textResponse(res, 404, "Not Found");
    return;
  }

  try {
    const ext = extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const data = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch (err) {
    textResponse(res, 500, `Failed to load ${pathname}: ${err.message}`);
  }
}

let server = null;
let callbackServer = null;

// Path for persisting a received OAuth code until the setup wizard claims it
function oauthPendingPath() {
  return resolve(homedir(), ".bosun", "pending-oauth.json");
}

/**
 * Starts a small HTTP server on CALLBACK_PORT (default 54317) whose only job
 * is to catch the GitHub OAuth redirect that GitHub fires after the user
 * authorises the Bosun GitHub App from the Marketplace.
 *
 * Why a separate server?
 *   • The setup wizard runs on a random port (default 3456).
 *   • The GitHub App's OAuth callback URL is registered as
 *     http://127.0.0.1:54317/github/callback in the GitHub App settings.
 *   • When a brand-new user installs from the Marketplace the OAuth redirect
 *     lands on port 54317 — but nothing is listening there unless we bind it.
 *   • This catcher runs whenever `bosun --setup` is active so the redirect is
 *     caught, the code is saved, and the user is bounced back to the wizard.
 *
 * @param {number} setupPort  The port the setup wizard is listening on
 */
async function startCallbackCatcher(setupPort) {
  const WAITING_PAGE = (port) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bosun — GitHub App Setup</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
         background:#0d1117;color:#c9d1d9;display:flex;align-items:center;
         justify-content:center;min-height:100vh;padding:20px}
    .card{background:#161b22;border:1px solid #30363d;border-radius:12px;
          padding:40px 48px;max-width:520px;width:100%;text-align:center}
    h1{font-size:22px;margin-bottom:8px;color:#f0f6fc}
    p{color:#8b949e;font-size:14px;line-height:1.6;margin-bottom:20px}
    .step{background:#0d1117;border:1px solid #30363d;border-radius:8px;
          padding:12px 16px;text-align:left;margin-bottom:10px;font-size:13px}
    .step strong{color:#58a6ff}
    code{background:#30363d;padding:2px 6px;border-radius:4px;font-size:12px;
         color:#79c0ff}
    .btn{display:inline-block;margin-top:16px;padding:10px 24px;
         background:#238636;color:#fff;border-radius:6px;text-decoration:none;
         font-size:14px;font-weight:600}
    .logo{font-size:40px;margin-bottom:16px}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">:rocket:</div>
    <h1>Bosun GitHub App Setup</h1>
    <p>Bosun needs to be running on your machine before you complete the GitHub Marketplace installation.</p>
    <div class="step"><strong>Step 1:</strong> Open a terminal and run:<br><br><code>bosun --setup</code></div>
    <div class="step"><strong>Step 2:</strong> Keep the setup wizard open, then return to the GitHub Marketplace and click <strong>Install</strong> again.</div>
    <div class="step"><strong>Step 3:</strong> GitHub will redirect back here automatically and you'll be taken to the setup wizard.</div>
    <a href="http://localhost:${port}" class="btn">Open Setup Wizard →</a>
  </div>
</body>
</html>`;

  const SUCCESS_PAGE = (setupPort) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bosun — Authorized!</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
         background:#0d1117;color:#c9d1d9;display:flex;align-items:center;
         justify-content:center;min-height:100vh}
    .card{text-align:center;padding:40px;max-width:420px}
    .icon{font-size:56px;margin-bottom:16px}
    h1{color:#f0f6fc;font-size:22px;margin-bottom:8px}
    p{color:#8b949e;font-size:14px}
  </style>
  <meta http-equiv="refresh" content="2;url=http://localhost:${setupPort}/?oauth=success">
</head>
<body>
  <div class="card">
    <div class="icon">:check:</div>
    <h1>GitHub App Authorized!</h1>
    <p>Redirecting you to the Bosun setup wizard…</p>
  </div>
</body>
</html>`;

  callbackServer = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${CALLBACK_PORT}`);
    const pathname = url.pathname;

    // Health check for relay pages / JS polling
    if (pathname === "/ping") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify({ ok: true, setupPort }));
      return;
    }

    // The actual OAuth callback GitHub redirects to
    if (pathname === "/github/callback" || pathname === "/api/github/callback") {
      const code = url.searchParams.get("code") || "";
      const installationId = url.searchParams.get("installation_id") || "";
      const setupAction = url.searchParams.get("setup_action") || "";

      if (!code) {
        // No code — user navigated here directly; show instructions
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(WAITING_PAGE(setupPort));
        return;
      }

      // Persist the code so the setup wizard can pick it up via polling
      try {
        const dir = resolve(homedir(), ".bosun");
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(oauthPendingPath(), JSON.stringify({
          code,
          installation_id: installationId,
          setup_action: setupAction,
          received_at: new Date().toISOString(),
        }), "utf8");
      } catch { /* non-fatal — redirect still works */ }

      // Redirect to setup wizard, passing the code as query params
      const redir = new URL(`http://localhost:${setupPort}/`);
      redir.searchParams.set("oauth_code", code);
      if (installationId) redir.searchParams.set("installation_id", installationId);
      if (setupAction) redir.searchParams.set("setup_action", setupAction);

      // Show a brief success splash, then meta-refresh to setup wizard
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(SUCCESS_PAGE(setupPort));
      return;
    }

    // Anything else → instructions page
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(WAITING_PAGE(setupPort));
  });

  try {
    await tryListen(callbackServer, CALLBACK_PORT);
    console.log(`  :server: GitHub OAuth callback listener: http://127.0.0.1:${CALLBACK_PORT}/github/callback`);
    console.log(`     ↳ Keep this terminal open while installing from GitHub Marketplace.\n`);
  } catch (err) {
    if (err.code === "EADDRINUSE") {
      // Another Bosun instance (or the main UI server) is already on this port — that's fine.
      console.log(`  :help:  Port ${CALLBACK_PORT} is already in use (main Bosun server may be running).\n`);
    } else {
      console.warn(`  :alert:  Could not start OAuth callback listener on port ${CALLBACK_PORT}: ${err.message}`);
    }
    callbackServer = null;
  }
}

function tryListen(srv, port) {
  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(port, "0.0.0.0", () => {
      srv.removeListener("error", reject);
      resolve(srv.address().port);
    });
  });
}

function openBrowser(url) {
  const mode = String(process.env.BOSUN_UI_BROWSER_OPEN_MODE || "manual")
    .trim()
    .toLowerCase();
  const allowByMode = mode === "auto";
  const setupAutoOpenRaw = String(
    process.env.BOSUN_SETUP_AUTO_OPEN_BROWSER || "",
  ).trim();
  const setupAutoOpenEnabled = setupAutoOpenRaw
    ? ["1", "true", "yes", "on"].includes(setupAutoOpenRaw.toLowerCase())
    : true;
  if (!allowByMode || !setupAutoOpenEnabled) return false;

  const cmd =
    process.platform === "win32" ? `start "" "${url}"`
    : process.platform === "darwin" ? `open "${url}"`
    : `xdg-open "${url}"`;
  try {
    execSync(cmd, { stdio: "ignore" });
    return true;
  } catch {
    return false; // user can open manually
  }
}

export async function startSetupServer(options = {}) {
  const preferredPort = options.port ?? (Number(process.env.BOSUN_SETUP_PORT) || DEFAULT_PORT);

  server = createServer(handleRequest);

  let actualPort;
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    try {
      actualPort = await tryListen(server, preferredPort + attempt);
      break;
    } catch (err) {
      if (err.code !== "EADDRINUSE" || attempt === MAX_PORT_ATTEMPTS - 1) {
        // Last resort: random port
        try {
          actualPort = await tryListen(server, 0);
          break;
        } catch (e) {
          console.error(`  :close: Could not start setup server: ${e.message}`);
          process.exit(1);
        }
      }
    }
  }

  const url = `http://localhost:${actualPort}`;
  const version = getVersion();

  // Start the OAuth callback catcher on the dedicated callback port so that
  // GitHub Marketplace redirects land somewhere even before bosun is fully set up.
  await startCallbackCatcher(actualPort);

  console.log(`
  ┌──────────────────────────────────────────────────┐
  │                                                  │
  │   :rocket:  Bosun Setup Wizard v${version.padEnd(25)}│
  │                                                  │
  │   Open in your browser:                          │
  │   ${url.padEnd(45)}│
  │                                                  │
  │   Press Ctrl+C to cancel setup                   │
  │                                                  │
  └──────────────────────────────────────────────────┘
`);

  const opened = openBrowser(url);
  if (!opened) {
    console.log("  Browser auto-open disabled or unavailable — open the URL manually.");
  }

  // Keep the process alive
  return new Promise((resolve) => {
    server.on("close", resolve);
    process.on("SIGINT", () => {
      console.log("\n  Setup cancelled.\n");
      if (callbackServer) callbackServer.close();
      server.close();
      process.exit(0);
    });
  });
}

export {
  applyTelegramMiniAppSetupEnv,
  applyNonBlockingSetupEnvDefaults,
  buildModelsProbeRequest,
  handleSetupApi,
  handleTelegramChatIdLookup,
  isAzureOpenAIHost,
  normalizeWorkflowTemplateOverrides,
  normalizeTelegramUiPort,
  normalizeRepoConfigEntry,
  normalizeWorkspaceConfigList,
  resolveSetupWorkspaceAndRepoConfig,
};

// Entry point when run directly
const __filename_setup_web = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename_setup_web)) {
  startSetupServer().catch((err) => {
    console.error(`\n  Setup server failed: ${err.message}\n`);
    process.exit(1);
  });
}
