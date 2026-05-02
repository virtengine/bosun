#!/usr/bin/env node

/**
 * bosun — Configuration System
 *
 * Loads configuration from (in priority order):
 *   1. CLI flags (--key value)
 *   2. Environment variables
 *   3. .env file
 *   4. bosun.config.json (project config)
 *   5. Built-in defaults
 *
 * Executor configuration supports N executors with weights and failover.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, basename, relative, isAbsolute } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { resolveAgentSdkConfig } from "../agent/agent-sdk.mjs";
import {
  ensureAgentPromptWorkspace,
  getAgentPromptDefinitions,
  resolveAgentPrompts,
} from "../agent/agent-prompts.mjs";
import {
  resolveAgentRepoRoot,
  resolveRepoLocalBosunDir,
  resolveTrustedBosunConfigDir,
  detectBosunModuleRoot,
} from "./repo-root.mjs";
import { applyAllCompatibility } from "../compat.mjs";
import { ensureTestRuntimeSandbox } from "../infra/test-runtime.mjs";
import { CONFIG_FILES } from "./config-file-names.mjs";
import { ExecutorScheduler, loadExecutorConfig } from "./executor-config.mjs";
import { normalizePipelineWorkflows } from "../workflow/pipeline-workflows.mjs";
import { getOAuthUserLogin } from "../github/github-app-auth.mjs";
import { resolveMarkdownSafetyPolicy } from "../lib/skill-markdown-safety.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));


function hasSetupMarkers(dir) {
  const markers = [".env", ...CONFIG_FILES];
  return markers.some((name) => existsSync(resolve(dir, name)));
}

function hasConfigFiles(dir) {
  return CONFIG_FILES.some((name) => existsSync(resolve(dir, name)));
}

function isPathInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Returns true if the given directory appears to be the root of the bosun npm module
 * (i.e. contains a package.json with `"name": "bosun"` or the bosun main entry point).
 * @param {string} dirPath
 * @returns {boolean}
 */
function isBosunModuleRoot(dirPath) {
  if (!dirPath) return false;
  const pkgPath = resolve(dirPath, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return pkg.name === "bosun" || pkg.name === "@virtengine/bosun";
  } catch {
    return false;
  }
}

/**
 * Resolve the watch path with smart fallback logic.
 *
 * Priority:
 *  1. configuredWatchPath — if it exists on disk, use it as-is.
 *  2. scriptPath — if configuredWatchPath is missing/nonexistent.
 *  3. repoRoot or configDir — last resort.
 *
 * @param {{ configuredWatchPath?: string, scriptPath?: string, repoRoot?: string, configDir?: string }} opts
 * @returns {string}
 */
function resolveDefaultWatchPath({ configuredWatchPath, scriptPath, repoRoot: root, configDir } = {}) {
  if (configuredWatchPath && existsSync(configuredWatchPath)) {
    return configuredWatchPath;
  }
  if (scriptPath && existsSync(scriptPath)) {
    return scriptPath;
  }
  // Fall back — return scriptPath regardless (caller specified it as configured)
  if (scriptPath) return scriptPath;
  if (configuredWatchPath) return configuredWatchPath;
  return root || configDir || __dirname;
}

function isWslInteropRuntime() {
  return Boolean(
    process.env.WSL_DISTRO_NAME ||
    process.env.WSL_INTEROP ||
    (process.platform === "win32" &&
      String(process.env.HOME || "")
        .trim()
        .startsWith("/home/")),
  );
}

function parseListEntries(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || "").trim()).filter(Boolean);
  }
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseListSetting(value) {
  return parseListEntries(value);
}

export function resolveTrustedAuthorList(value, options = {}) {
  const {
    includeOAuthTrustedAuthor = false,
    oauthTrustedAuthor,
  } = options;
  const merged = [];
  const seen = new Set();
  const addEntry = (entry) => {
    const normalized = String(entry || "").trim();
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(normalized);
  };

  parseListEntries(value).forEach(addEntry);

  if (includeOAuthTrustedAuthor) {
    addEntry(oauthTrustedAuthor ?? getOAuthUserLogin());
  }

  return merged;
}

function resolveConfigDir(repoRoot) {
  if (process.env.BOSUN_CONFIG_PATH) {
    return dirname(resolve(process.env.BOSUN_CONFIG_PATH));
  }
  // 1. Explicit env override (BOSUN_HOME supersedes BOSUN_DIR; both are aliases)
  if (process.env.BOSUN_HOME) return resolveTrustedBosunConfigDir(process.env.BOSUN_HOME, repoRoot);
  if (process.env.BOSUN_DIR) return resolveTrustedBosunConfigDir(process.env.BOSUN_DIR, repoRoot);

  // 2. Prefer repo-local runtime state for source checkouts and repo-scoped runs.
  const repoLocalConfigDir = resolveRepoLocalBosunDir(repoRoot);
  if (repoLocalConfigDir) return repoLocalConfigDir;

  // 3. Fallback: check the bosun module's own directory for a .bosun/ config.
  //    This ensures `bosun` (global) finds the same config as `npm start` which
  //    explicitly passes `--config-dir .bosun`.  Without this, running from a
  //    directory outside the module (e.g. home dir) misses workspaces, .env
  //    vars (TELEGRAM_UI_PORT, TELEGRAM_MINIAPP_ENABLED, etc.), and task store.
  //    NOTE: when repoRoot is empty, `resolve("")` collapses to process.cwd()
  //    which often equals moduleRoot for source checkouts. Skipping the
  //    equality guard in that case allows the module-local `.bosun` to be
  //    picked up instead of falling through to the global AppData dir.
  const moduleRoot = detectBosunModuleRoot();
  const repoRootProvided = typeof repoRoot === "string" && repoRoot.trim() !== "";
  if (moduleRoot && (!repoRootProvided || resolve(moduleRoot) !== resolve(repoRoot))) {
    const moduleLocalConfigDir = resolveRepoLocalBosunDir(moduleRoot);
    if (moduleLocalConfigDir) return moduleLocalConfigDir;
  }

  // 4. Tests must not fall through to the user's real global Bosun home.
  const sandbox = ensureTestRuntimeSandbox();
  if (sandbox?.configDir) return sandbox.configDir;

  // 5. Platform-aware user home
  const preferWindowsDirs =
    process.platform === "win32" && !isWslInteropRuntime();
  const baseDir = preferWindowsDirs
    ? process.env.APPDATA ||
      process.env.LOCALAPPDATA ||
      process.env.USERPROFILE ||
      process.env.HOME ||
      os.homedir()
    : process.env.HOME ||
      process.env.XDG_CONFIG_HOME ||
      process.env.USERPROFILE ||
      process.env.APPDATA ||
      process.env.LOCALAPPDATA ||
      os.homedir();
  return resolve(baseDir, "bosun");
}

function getConfigSearchDirs(repoRoot) {
  const dirs = new Set();
  if (process.env.BOSUN_HOME) dirs.add(resolve(process.env.BOSUN_HOME));
  if (process.env.BOSUN_DIR) dirs.add(resolve(process.env.BOSUN_DIR));
  dirs.add(resolveConfigDir(repoRoot));
  if (process.env.APPDATA) dirs.add(resolve(process.env.APPDATA, "bosun"));
  if (process.env.LOCALAPPDATA) dirs.add(resolve(process.env.LOCALAPPDATA, "bosun"));
  if (process.env.USERPROFILE) dirs.add(resolve(process.env.USERPROFILE, "bosun"));
  if (process.env.HOME) dirs.add(resolve(process.env.HOME, "bosun"));
  return [...dirs].filter(Boolean);
}

function collectRepoPathsFromConfig(cfg, configDir) {
  const paths = [];
  const pushPath = (path) => {
    if (!path) return;
    paths.push(isAbsolute(path) ? path : resolve(configDir, path));
  };

  const repos = cfg.repositories || cfg.repos || [];
  if (Array.isArray(repos)) {
    for (const repo of repos) {
      const repoPath = typeof repo === "string" ? repo : (repo?.path || repo?.repoRoot);
      pushPath(repoPath);
    }
  }

  const workspaces = cfg.workspaces || [];
  if (Array.isArray(workspaces)) {
    for (const ws of workspaces) {
      const wsBase = ws?.path
        ? (isAbsolute(ws.path) ? ws.path : resolve(configDir, ws.path))
        : (ws?.id ? resolve(configDir, "workspaces", ws.id) : null);
      const wsRepos = ws?.repos || ws?.repositories || [];
      if (!Array.isArray(wsRepos)) continue;
      for (const repo of wsRepos) {
        const repoPath = typeof repo === "string" ? repo : (repo?.path || repo?.repoRoot);
        if (repoPath) {
          pushPath(repoPath);
          continue;
        }
        if (wsBase && repo?.name) pushPath(resolve(wsBase, repo.name));
      }
    }
  }

  return paths;
}

function ensurePromptWorkspaceGitIgnore(repoRoot) {
  const gitignorePath = resolve(repoRoot, ".gitignore");
  const entry = "/.bosun/";
  let existing = "";
  try {
    if (existsSync(gitignorePath)) {
      existing = readFileSync(gitignorePath, "utf8");
    }
  } catch {
    return;
  }
  const hasEntry = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .includes(entry);
  if (hasEntry) return;
  const next =
    existing.endsWith("\n") || !existing ? existing : `${existing}\n`;
  try {
    writeFileSync(gitignorePath, `${next}${entry}\n`, "utf8");
  } catch {
    /* best effort */
  }
}

// ── .env loader ──────────────────────────────────────────────────────────────

function loadDotEnv(dir, options = {}) {
  const { override = false } = options;
  const envPath = resolve(dir, ".env");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (override || !(key in process.env)) {
      process.env[key] = val;
    }
  }
}

function loadDotEnvFile(envPath, options = {}) {
  const { override = false } = options;
  const resolved = resolve(envPath);
  if (!existsSync(resolved)) return;
  const lines = readFileSync(resolved, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (override || !(key in process.env)) {
      process.env[key] = val;
    }
  }
}

function readEnvValueFromFile(envPath, key) {
  if (!envPath || !existsSync(envPath)) return undefined;
  const lines = readFileSync(envPath, "utf8").split("\n");
  let found;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const parsedKey = trimmed.slice(0, eqIdx).trim();
    if (parsedKey !== key) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    found = value;
  }
  return found;
}

function resolveKanbanBackendSource({ envPaths = [], configFilePath, configData }) {
  const key = "KANBAN_BACKEND";
  let source = "default";
  let sourcePath = null;

  if (process.env[key] != null && String(process.env[key]).trim() !== "") {
    let envFileMatch = null;
    for (const envPath of envPaths) {
      const value = readEnvValueFromFile(envPath, key);
      if (value != null && String(value).trim() !== "") {
        envFileMatch = envPath;
      }
    }
    if (envFileMatch) {
      source = "env-file";
      sourcePath = envFileMatch;
    } else {
      source = "process-env";
    }
  } else if (configData?.kanban?.backend != null) {
    source = "config-file";
    sourcePath = configFilePath || null;
  }

  return Object.freeze({
    key,
    rawValue:
      process.env[key] || configData?.kanban?.backend || "internal",
    source,
    sourcePath,
  });
}

function validateKanbanBackendConfig({ kanbanBackend, kanban, jira, repoMirror }) {
  if (kanbanBackend === "jira") {
    const missing = [];
    if (!jira?.baseUrl) missing.push("JIRA_BASE_URL");
    if (!jira?.email) missing.push("JIRA_EMAIL");
    if (!jira?.apiToken) missing.push("JIRA_API_TOKEN");
    const hasProjectKey = Boolean(jira?.projectKey || kanban?.projectId);
    if (!hasProjectKey) {
      missing.push("JIRA_PROJECT_KEY (or KANBAN_PROJECT_ID)");
    }
    if (missing.length > 0) {
      throw new Error(
        `[config] KANBAN_BACKEND=jira requires ${missing.join(", ")}. ` +
          `Either configure Jira credentials/project key or switch KANBAN_BACKEND=internal.`,
      );
    }
    return;
  }

  if (kanbanBackend !== "repo-mirror") return;

  const invalid = [];
  if (!repoMirror?.enabled) invalid.push("REPO_MIRROR_ENABLED=true");
  if (!repoMirror?.repoPath) invalid.push("REPO_MIRROR_REPO_PATH");
  if (repoMirror?.syncMode !== "projection") invalid.push("REPO_MIRROR_SYNC_MODE=projection");
  if (!["git", "local"].includes(repoMirror?.runStorage)) {
    invalid.push("REPO_MIRROR_RUN_STORAGE=git|local");
  }
  if (!["off", "git", "local"].includes(repoMirror?.messageStorage)) {
    invalid.push("REPO_MIRROR_MESSAGE_STORAGE=off|git|local");
  }
  if (invalid.length > 0) {
    throw new Error(
      `[config] KANBAN_BACKEND=repo-mirror requires ${invalid.join(", ")}. ` +
        `RepoMirror is projection-only in this build and must be explicitly enabled before selection.`,
    );
  }
}

function loadConfigFile(configDir) {
  const explicitConfigPath = process.env.BOSUN_CONFIG_PATH ? resolve(process.env.BOSUN_CONFIG_PATH) : "";
  if (explicitConfigPath) {
    if (!existsSync(explicitConfigPath)) {
      return { path: explicitConfigPath, data: null };
    }
    try {
      const raw = JSON.parse(readFileSync(explicitConfigPath, "utf8"));
      return { path: explicitConfigPath, data: raw };
    } catch {
      return { path: explicitConfigPath, data: null, error: "invalid-json" };
    }
  }
  for (const name of CONFIG_FILES) {
    const p = resolve(configDir, name);
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, "utf8"));
      return { path: p, data: raw };
    } catch {
      return { path: p, data: null, error: "invalid-json" };
    }
  }
  // Hint about the example template
  const examplePath = resolve(configDir, "bosun.config.example.json");
  if (existsSync(examplePath)) {
    console.log(
      `[config] No bosun.config.json found. Copy the example:\n` +
        `         cp ${examplePath} ${resolve(configDir, "bosun.config.json")}`,
    );
  }
  return { path: null, data: null };
}

export function readConfigDocument(repoRoot) {
  const configDir = resolveConfigDir(repoRoot || process.cwd());
  const configFile = loadConfigFile(configDir);
  const configData =
    configFile?.data && typeof configFile.data === "object"
      ? configFile.data
      : {};
  return {
    configDir,
    configPath: configFile?.path || null,
    configData,
  };
}

// ── CLI arg parser ───────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = { _positional: [], _flags: new Set() };
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        result[key] = args[i + 1];
        i++;
      } else {
        result._flags.add(key);
      }
    } else {
      result._positional.push(args[i]);
    }
  }
  return result;
}

// ── Config/profile helpers ───────────────────────────────────────────────────

function normalizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function applyEnvProfile(profile, options = {}) {
  if (!profile || typeof profile !== "object") return;
  const env = profile.env;
  if (!env || typeof env !== "object") return;
  const override = profile.envOverride === true || options.override === true;
  for (const [key, value] of Object.entries(env)) {
    if (!override && key in process.env) continue;
    process.env[key] = String(value);
  }
}

function applyProfileOverrides(configData, profile) {
  if (!configData || typeof configData !== "object") {
    return configData || {};
  }
  if (!profile || typeof profile !== "object") {
    return configData;
  }
  const overrides =
    profile.overrides || profile.config || profile.settings || {};
  if (!overrides || typeof overrides !== "object") {
    return configData;
  }
  return {
    ...configData,
    ...overrides,
    repositories: overrides.repositories ?? configData.repositories,
    executors: overrides.executors ?? configData.executors,
    failover: overrides.failover ?? configData.failover,
    distribution: overrides.distribution ?? configData.distribution,
    agentPrompts: overrides.agentPrompts ?? configData.agentPrompts,
    harness: overrides.harness ?? configData.harness,
  };
}

function resolveRepoPath(repoPath, baseDir) {
  if (!repoPath) return "";
  if (repoPath.startsWith("~")) {
    return resolve(
      process.env.HOME || process.env.USERPROFILE || "",
      repoPath.slice(1),
    );
  }
  return resolve(baseDir, repoPath);
}

function parseEnvBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  const raw = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(raw)) return true;
  if (["false", "0", "no", "n", "off"].includes(raw)) return false;
  return defaultValue;
}

function parseBoundedInteger(value, defaultValue, { min = null, max = null } = {}) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  if (Number.isFinite(min) && parsed < min) return defaultValue;
  if (Number.isFinite(max) && parsed > max) return defaultValue;
  return parsed;
}

function parseBoundedNumber(value, defaultValue, { min = null, max = null } = {}) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return defaultValue;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return defaultValue;
  if (Number.isFinite(min) && parsed < min) return defaultValue;
  if (Number.isFinite(max) && parsed > max) return defaultValue;
  return parsed;
}

function isEnvEnabled(value, defaultValue = false) {
  return parseEnvBoolean(value, defaultValue);
}

function buildDefaultTriggerTemplates() {
  return [
    {
      id: "daily-review-digest",
      name: "Daily Review Digest",
      description: "Create a daily review task for fleet health and backlog quality.",
      enabled: false,
      action: "create-task",
      trigger: {
        anyOf: [
          {
            kind: "interval",
            minutes: 24 * 60,
          },
        ],
      },
      minIntervalMinutes: 24 * 60,
      config: {
        title: "[m] Daily review digest",
        description:
          "Review active backlog, blocked tasks, and stale work. Capture next actions and priority adjustments.",
        priority: "medium",
        executor: "auto",
        model: "auto",
      },
    },
    {
      id: "stale-task-followup",
      name: "Stale Task Follow-up",
      description: "Create a follow-up task when stale in-progress work accumulates.",
      enabled: false,
      action: "create-task",
      trigger: {
        anyOf: [
          {
            kind: "metric",
            metric: "staleInProgressCount",
            operator: "gte",
            value: 1,
          },
        ],
      },
      minIntervalMinutes: 60,
      config: {
        title: "[m] Follow up stale in-progress tasks",
        description:
          "Audit stale in-progress tasks, unblock owners, or split work to recover flow.",
        priority: "high",
        staleHours: Number(process.env.STALE_TASK_AGE_HOURS || "24"),
        executor: "auto",
        model: "auto",
      },
    },
  ];
}

function resolveTriggerSystemConfig(configData, defaults) {
  const configTrigger =
    configData && typeof configData.triggerSystem === "object"
      ? configData.triggerSystem
      : configData && typeof configData.triggers === "object"
        ? configData.triggers
        : {};
  const templates = Array.isArray(configTrigger.templates)
    ? configTrigger.templates
    : defaults.templates;
  return Object.freeze({
    enabled: isEnvEnabled(
      process.env.TASK_TRIGGER_SYSTEM_ENABLED ?? configTrigger.enabled,
      false,
    ),
    templates,
    defaults: defaults.defaults,
  });
}

function toBoundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.trunc(parsed);
  return Math.min(max, Math.max(min, rounded));
}

const WORKTREE_BOOTSTRAP_STACK_IDS = Object.freeze([
  "node",
  "python",
  "go",
  "rust",
  "java",
  "dotnet",
  "ruby",
  "php",
  "make",
]);

function normalizeStringListConfig(value) {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\r?\n|,/)
      : [];
  const values = [];
  for (const entry of source) {
    const normalized = String(entry || "").trim();
    if (!normalized || values.includes(normalized)) continue;
    values.push(normalized);
  }
  return values;
}

function freezeNestedStringListMap(value) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  const normalized = {};
  for (const [rawKey, rawValue] of Object.entries(source)) {
    const key = String(rawKey || "").trim().toLowerCase();
    if (!key) continue;
    const values = normalizeStringListConfig(rawValue);
    if (values.length === 0) continue;
    normalized[key] = Object.freeze(values);
  }
  return Object.freeze(normalized);
}

function resolveWorktreeBootstrapConfig(configData = {}) {
  const raw = configData.worktreeBootstrap && typeof configData.worktreeBootstrap === "object"
    ? configData.worktreeBootstrap
    : {};
  const commandsByStack = {
    ...freezeNestedStringListMap(raw.commandsByStack),
  };
  for (const stackId of WORKTREE_BOOTSTRAP_STACK_IDS) {
    const envName = `WORKTREE_BOOTSTRAP_${stackId.toUpperCase()}_COMMAND`;
    const envValues = normalizeStringListConfig(process.env[envName]);
    if (envValues.length > 0) {
      commandsByStack[stackId] = Object.freeze(envValues);
    }
  }
  return Object.freeze({
    enabled: isEnvEnabled(
      process.env.WORKTREE_BOOTSTRAP_ENABLED ?? raw.enabled,
      false,
    ),
    linkSharedPaths: isEnvEnabled(
      process.env.WORKTREE_BOOTSTRAP_LINK_SHARED_PATHS ?? raw.linkSharedPaths,
      true,
    ),
    commandTimeoutMs: toBoundedInt(
      process.env.WORKTREE_BOOTSTRAP_COMMAND_TIMEOUT_MS ?? raw.commandTimeoutMs,
      10 * 60 * 1000,
      1000,
      60 * 60 * 1000,
    ),
    setupScript: String(
      process.env.WORKTREE_BOOTSTRAP_SETUP_SCRIPT ?? raw.setupScript ?? "",
    ).trim(),
    commandsByStack: Object.freeze(commandsByStack),
    sharedPathsByStack: freezeNestedStringListMap(raw.sharedPathsByStack),
  });
}

function normalizeStatusList(rawStates) {
  const source = Array.isArray(rawStates)
    ? rawStates
    : String(rawStates || "").split(",");
  const values = [];
  for (const raw of source) {
    const normalized = String(raw || "").trim().toLowerCase();
    if (!normalized || values.includes(normalized)) continue;
    values.push(normalized);
  }
  return values.length > 0 ? values : ["done", "cancelled"];
}

function resolveWorkflowConfig(configData = {}) {
  const rawWorkflows = configData?.workflows;
  const rawEntries = Array.isArray(rawWorkflows) ? rawWorkflows : [];
  const normalized = [];

  for (const rawEntry of rawEntries) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue;
    const type = String(rawEntry.type || "").trim().toLowerCase();
    if (!type) continue;

    const entryBase = {
      type,
      enabled: rawEntry.enabled !== false,
      name: String(rawEntry.name || "").trim() || null,
    };

    if (type !== "continuation-loop") {
      normalized.push(Object.freeze(entryBase));
      continue;
    }

    const onStuckRaw = String(rawEntry.onStuck || "escalate").trim().toLowerCase();
    const onStuck = ["retry", "escalate", "pause"].includes(onStuckRaw)
      ? onStuckRaw
      : "escalate";

    normalized.push(Object.freeze({
      ...entryBase,
      taskId: String(rawEntry.taskId || "").trim(),
      worktreePath: String(rawEntry.worktreePath || "").trim(),
      maxTurns: toBoundedInt(rawEntry.maxTurns, 8, 1, 1000),
      pollIntervalMs: toBoundedInt(rawEntry.pollIntervalMs, 30000, 1000, 3600000),
      terminalStates: normalizeStatusList(rawEntry.terminalStates),
      stuckThresholdMs: toBoundedInt(rawEntry.stuckThresholdMs, 300000, 1000, 86400000),
      onStuck,
      continuePrompt: String(rawEntry.continuePrompt || "").trim(),
      retryPrompt: String(rawEntry.retryPrompt || "").trim(),
      sdk: String(rawEntry.sdk || "auto").trim() || "auto",
      model: String(rawEntry.model || "").trim(),
      timeoutMs: toBoundedInt(rawEntry.timeoutMs, 1800000, 1000, 21600000),
    }));
  }

  // Support declarative pipeline workflow maps while keeping backward-compatible
  // array semantics for continuation-loop style entries.
  if (rawWorkflows && typeof rawWorkflows === "object" && !Array.isArray(rawWorkflows)) {
    const namedWorkflows = normalizePipelineWorkflows(rawWorkflows);
    for (const [workflowName, workflowDefinition] of Object.entries(namedWorkflows)) {
      Object.defineProperty(normalized, workflowName, {
        value: workflowDefinition,
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
  }

  return Object.freeze(normalized);
}

// ── Git helpers ──────────────────────────────────────────────────────────────

function detectRepoSlug(repoRoot = "") {
  const tryResolve = (cwd) => {
    try {
      const remote = execSync("git remote get-url origin", {
        cwd,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();
      const match = remote.match(/github\.com[/:]([^/]+\/[^/.]+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  };

  // First try current working directory
  const direct = tryResolve(process.cwd());
  if (direct) return direct;

  // Fall back to detected repo root if provided
  if (repoRoot) {
    const viaRoot = tryResolve(repoRoot);
    if (viaRoot) return viaRoot;
  }

  // Last resort — use cached detectRepoRoot (avoids redundant subprocess calls)
  const root = detectRepoRoot();
  if (root && root !== process.cwd()) {
    const viaRoot = tryResolve(root);
    if (viaRoot) return viaRoot;
  }

  return null;
}

let _detectRepoRootCache = null;

function detectRepoRoot() {
  if (_detectRepoRootCache) return _detectRepoRootCache;
  const result = _detectRepoRootUncached();
  _detectRepoRootCache = result;
  return result;
}

function _detectRepoRootUncached() {
  const gitExecOptions = {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
    timeout: 3000,
  };

  // 1. Explicit env var
  if (process.env.REPO_ROOT) {
    const envRoot = resolve(process.env.REPO_ROOT);
    if (existsSync(envRoot)) return envRoot;
  }

  // 2. Check bosun config for workspace repos FIRST — this is the primary
  //    source of truth and works regardless of whether cwd is inside a git repo.
  const configDirs = getConfigSearchDirs();
  let fallbackRepo = null;
  for (const cfgName of CONFIG_FILES) {
    for (const configDir of configDirs) {
      const cfgPath = resolve(configDir, cfgName);
      if (!existsSync(cfgPath)) continue;
      try {
        const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
        const repoPaths = collectRepoPathsFromConfig(cfg, configDir);
        for (const repoPath of repoPaths) {
          if (!repoPath || !existsSync(repoPath)) continue;
          if (existsSync(resolve(repoPath, ".git"))) return repoPath;
          fallbackRepo ??= repoPath;
        }
      } catch {
        /* invalid config */
      }
    }
  }
  if (fallbackRepo) return fallbackRepo;

  // 3. Try git from cwd
  try {
    const gitRoot = execSync("git rev-parse --show-toplevel", {
      ...gitExecOptions,
    }).trim();
    if (gitRoot) return gitRoot;
  } catch {
    // not in a git repo from cwd
  }

  // 4. Bosun package directory may be inside a repo (common: scripts/bosun/ within a project)
  try {
    const gitRoot = execSync("git rev-parse --show-toplevel", {
      cwd: __dirname,
      ...gitExecOptions,
    }).trim();
    if (gitRoot) return gitRoot;
  } catch {
    // bosun installed standalone, not in a repo
  }

  // 5. Module root detection — when bosun is installed as a standalone npm package,
  //    use the module root directory as a stable base for config resolution.
  const moduleRoot = detectBosunModuleRoot();
  if (moduleRoot && moduleRoot !== process.cwd()) {
    try {
      const gitRoot = execSync("git rev-parse --show-toplevel", {
        cwd: moduleRoot,
        ...gitExecOptions,
      }).trim();
      if (gitRoot) return gitRoot;
    } catch {
      // module root is not inside a git repo
    }
  }

  // 6. Final fallback — return cwd silently. The config system resolves
  //    repos from BOSUN_HOME workspaces, so a missing git repo in cwd is
  //    expected for globally-installed usage and daemon spawns.
  return process.cwd();
}

// ── Executor Configuration ───────────────────────────────────────────────────

/**
 * Executor config schema:
 *
 * {
 *   "executors": [
 *     {
 *       "name": "copilot-claude",
 *       "executor": "COPILOT",
 *       "variant": "CLAUDE_OPUS_4_6",
 *       "weight": 50,
 *       "role": "primary",
 *       "enabled": true
 *     },
 *     {
 *       "name": "codex-default",
 *       "executor": "CODEX",
 *       "variant": "DEFAULT",
 *       "weight": 50,
 *       "role": "backup",
 *       "enabled": true
 *     }
 *   ],
 *   "failover": {
 *     "strategy": "next-in-line",   // "next-in-line" | "weighted-random" | "round-robin"
 *     "maxRetries": 3,
 *     "cooldownMinutes": 5,
 *     "disableOnConsecutiveFailures": 3
 *   },
 *   "distribution": "weighted"      // "weighted" | "round-robin" | "primary-only"
 * }
 */

function normalizePrimaryAgent(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (!raw) return "codex-sdk";
  if (["codex", "codex-sdk"].includes(raw)) return "codex-sdk";
  if (["copilot", "copilot-sdk", "github-copilot"].includes(raw))
    return "copilot-sdk";
  if (["claude", "claude-sdk", "claude_code", "claude-code"].includes(raw))
    return "claude-sdk";
  if (["gemini", "gemini-sdk", "google-gemini"].includes(raw))
    return "gemini-sdk";
  if (["opencode", "opencode-sdk", "open-code"].includes(raw))
    return "opencode-sdk";
  return raw;
}

function normalizeAgentRuntime(value) {
  return String(value || "").trim().toLowerCase() === "sdk-cli"
    ? "sdk-cli"
    : "harness";
}

function normalizeInternalExecutorMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "hybrid") return "internal";
  return normalized === "internal" ? "internal" : "internal";
}

function normalizeKanbanBackend(value) {
  const backend = String(value || "")
    .trim()
    .toLowerCase();
  if (
    backend === "internal" ||
    backend === "github" ||
    backend === "jira" ||
    backend === "repo-mirror"
  ) {
    return backend;
  }
  return "internal";
}

function normalizeRepoMirrorSyncMode(value) {
  const mode = String(value || "")
    .trim()
    .toLowerCase();
  return mode || "projection";
}

function normalizeRepoMirrorRunStorage(value) {
  const storage = String(value || "")
    .trim()
    .toLowerCase();
  return storage || "git";
}

function normalizeRepoMirrorMessageStorage(value) {
  const storage = String(value || "")
    .trim()
    .toLowerCase();
  return storage || "off";
}

function normalizeKanbanSyncPolicy(value) {
  const policy = String(value || "")
    .trim()
    .toLowerCase();
  if (policy === "internal-primary" || policy === "bidirectional") {
    return policy;
  }
  return "internal-primary";
}

function normalizeProjectRequirementsProfile(value) {
  const profile = String(value || "")
    .trim()
    .toLowerCase();
  if (
    [
      "simple-feature",
      "feature",
      "large-feature",
      "system",
      "multi-system",
    ].includes(profile)
  ) {
    return profile;
  }
  return "feature";
}

// ── Multi-Repo Support ───────────────────────────────────────────────────────

/**
 * Multi-repo config schema (supports defaults + selection):
 *
 * {
 *   "defaultRepository": "backend",
 *   "repositoryDefaults": {
 *     "orchestratorScript": "./orchestrator.ps1",
 *     "orchestratorArgs": "-MaxParallel 6",
 *     "profile": "local"
 *   },
 *   "repositories": [
 *     {
 *       "name": "backend",
 *       "path": "/path/to/backend",
 *       "slug": "org/backend",
 *       "primary": true
 *     },
 *     {
 *       "name": "frontend",
 *       "path": "/path/to/frontend",
 *       "slug": "org/frontend",
 *       "profile": "frontend"
 *     }
 *   ]
 * }
 */

function normalizeRepoEntry(entry, defaults, baseDir) {
  if (!entry || typeof entry !== "object") return null;
  const name = String(entry.name || entry.id || "").trim();
  if (!name) return null;
  const repoPath =
    entry.path || entry.repoRoot || defaults.path || defaults.repoRoot || "";
  const resolvedPath = repoPath ? resolveRepoPath(repoPath, baseDir) : "";
  const slug = entry.slug || entry.repo || defaults.slug || defaults.repo || "";
  const aliases = Array.isArray(entry.aliases)
    ? entry.aliases.map(normalizeKey).filter(Boolean)
    : [];
  return {
    ...defaults,
    ...entry,
    name,
    id: normalizeKey(name),
    path: resolvedPath,
    slug,
    aliases,
    primary: entry.primary === true || defaults.primary === true,
  };
}

function resolveRepoSelection(repositories, selection) {
  if (!repositories || repositories.length === 0) return null;
  const target = normalizeKey(selection);
  if (!target) return null;
  return (
    repositories.find((repo) => repo.id === target) ||
    repositories.find((repo) => normalizeKey(repo.name) === target) ||
    repositories.find((repo) => normalizeKey(repo.slug) === target) ||
    repositories.find((repo) => repo.aliases?.includes(target)) ||
    null
  );
}

function loadRepoConfig(configDir, configData = {}, options = {}) {
  const repoRootOverride = options.repoRootOverride || "";
  const baseDir = configDir || process.cwd();
  const repoDefaults =
    configData.repositoryDefaults || configData.repositories?.defaults || {};
  let repoEntries = null;
  if (Array.isArray(configData.repositories)) {
    repoEntries = configData.repositories;
  } else if (Array.isArray(configData.repositories?.items)) {
    repoEntries = configData.repositories.items;
  } else if (Array.isArray(configData.repositories?.list)) {
    repoEntries = configData.repositories.list;
  }

  if (repoEntries && repoEntries.length) {
    return repoEntries
      .map((entry) => normalizeRepoEntry(entry, repoDefaults, baseDir))
      .filter(Boolean);
  }

  const repoRoot = repoRootOverride || detectRepoRoot();
  const slug = detectRepoSlug();
  return [
    {
      name: basename(repoRoot),
      id: normalizeKey(basename(repoRoot)),
      path: repoRoot,
      slug: process.env.GITHUB_REPO || slug || "unknown/unknown",
      primary: true,
    },
  ];
}

function loadWorkspaceRepoConfig(configDir, configData = {}, activeWorkspace = "") {
  const workspaces = Array.isArray(configData.workspaces)
    ? configData.workspaces
    : [];
  if (workspaces.length === 0) return [];

  const targetWorkspaceId = normalizeKey(activeWorkspace || configData.activeWorkspace || "");
  const targetWorkspace =
    (targetWorkspaceId
      ? workspaces.find((workspace) => normalizeKey(workspace?.id) === targetWorkspaceId)
      : null) ||
    workspaces[0];

  if (!targetWorkspace || !Array.isArray(targetWorkspace.repos)) {
    return [];
  }

  const workspacePath = resolve(configDir, "workspaces", targetWorkspace.id);
  const activeRepoName = normalizeKey(targetWorkspace.activeRepo || "");

  return targetWorkspace.repos
    .map((repo, index) => {
      const rawRepo =
        typeof repo === "string"
          ? { slug: repo }
          : (repo && typeof repo === "object" ? repo : null);
      if (!rawRepo) return null;
      const slug = String(rawRepo.slug || "").trim();
      const name = String(rawRepo.name || rawRepo.id || slug.split("/").pop() || "")
        .trim()
        .replace(/\.git$/i, "");
      if (!name) return null;
      const repoPath = resolve(workspacePath, name);
      return {
        name,
        id: normalizeKey(name),
        path: repoPath,
        slug,
        url:
          String(rawRepo.url || "").trim() ||
          (slug ? `https://github.com/${slug}.git` : ""),
        workspace: String(targetWorkspace.id || "").trim(),
        primary:
          rawRepo.primary === true ||
          (activeRepoName && normalizeKey(name) === activeRepoName) ||
          (!activeRepoName && index === 0),
      };
    })
    .filter(Boolean);
}

function loadAgentPrompts(configDir, repoRoot, configData) {
  const resolved = resolveAgentPrompts(configDir, repoRoot, configData);
  return { ...resolved.prompts, _sources: resolved.sources };
}

// ── Main Configuration Loader ────────────────────────────────────────────────

/**
 * Load the full bosun configuration.
 * Returns a frozen config object used by all modules.
 */
export function loadConfig(argv = process.argv, options = {}) {
  // Apply legacy CODEX_MONITOR_* → BOSUN_* compatibility before anything else
  applyAllCompatibility();

  const { reloadEnv = false } = options;
  const cli = parseArgs(argv);
  const repoRootOverride = cli["repo-root"] || process.env.REPO_ROOT || "";
  const normalizedRepoRootOverride = repoRootOverride
    ? resolve(repoRootOverride)
    : "";
  const explicitConfigDirRaw =
    cli["config-dir"] || process.env.BOSUN_HOME || process.env.BOSUN_DIR || "";
  const hasExplicitConfigDir = String(explicitConfigDirRaw || "").trim() !== "";
  const envOverride = reloadEnv || !isEnvEnabled(process.env.BOSUN_ENV_NO_OVERRIDE, false);
  let detectedRepoRoot = "";
  const getFallbackRepoRoot = () => {
    if (normalizedRepoRootOverride) return normalizedRepoRootOverride;
    if (!detectedRepoRoot) detectedRepoRoot = detectRepoRoot();
    return detectedRepoRoot;
  };

  // Determine config directory (where bosun stores its config)
  let configDir =
    (explicitConfigDirRaw ? resolve(explicitConfigDirRaw) : "") ||
    resolveConfigDir(normalizedRepoRootOverride);
  const canonicalEnvPath = resolve(configDir, ".env");
  const repoEnvPath = resolve(normalizedRepoRootOverride || getFallbackRepoRoot(), ".env");
  const canonicalEnvExists = existsSync(canonicalEnvPath);

  // If BOSUN_HOME/BOSUN_DIR is declared in the canonical config-dir .env,
  // load that first and then pivot into the explicit config dir before reading
  // config files.
  if (!hasExplicitConfigDir) {
    loadDotEnv(configDir, { override: envOverride });
    const envConfigDirRaw = process.env.BOSUN_HOME || process.env.BOSUN_DIR || "";
    if (String(envConfigDirRaw).trim()) {
      const resolvedEnvConfigDir = resolveTrustedBosunConfigDir(
        envConfigDirRaw,
        normalizedRepoRootOverride || getFallbackRepoRoot(),
      );
      if (resolvedEnvConfigDir !== resolve(configDir)) {
        configDir = resolvedEnvConfigDir;
      }
    }
  }

  const configFile = loadConfigFile(configDir);
  let configData = configFile.data || {};
  const configFileHadInvalidJson = configFile.error === "invalid-json";

  // Load workspace configuration
  const workspacesDir = resolve(configDir, "workspaces");
  const activeWorkspace = cli["workspace"] ||
    process.env.BOSUN_WORKSPACE ||
    configData.activeWorkspace ||
    configData.defaultWorkspace ||
    "";

  let repositories = loadWorkspaceRepoConfig(
    configDir,
    configData,
    activeWorkspace,
  );
  if (!repositories.length) {
    repositories = loadRepoConfig(configDir, configData, {
      repoRootOverride,
    });
  }

  const repoSelection =
    cli["repo-name"] ||
    cli.repository ||
    process.env.BOSUN_REPO ||
    process.env.BOSUN_REPO_NAME ||
    process.env.REPO_NAME ||
    configData.defaultRepository ||
    configData.defaultRepo ||
    configData.repositories?.default ||
    "";

  let selectedRepository =
    resolveRepoSelection(repositories, repoSelection) ||
    repositories.find((repo) => repo.primary) ||
    repositories[0] ||
    null;

  // Resolve repo root. Explicit repo-root/REPO_ROOT must win over workspace clones
  // so source-based runs can pin execution to the developer working tree.
  const explicitRepoRoot = normalizedRepoRootOverride ||
    (process.env.REPO_ROOT ? resolve(process.env.REPO_ROOT) : "");
  const selectedRepoPath = selectedRepository?.path || "";
  const selectedRepoHasGit = selectedRepoPath && existsSync(resolve(selectedRepoPath, ".git"));
  let repoRoot =
    explicitRepoRoot ||
    (selectedRepoHasGit ? selectedRepoPath : null) ||
    getFallbackRepoRoot();

  // Resolve agent execution root. Keep workspace-aware behavior by default,
  // but honor explicit repo-root/REPO_ROOT overrides.
  const agentRepoRoot = explicitRepoRoot || resolveAgentRepoRoot();

  // Load .env from the canonical config dir — Bosun's runtime .env is the
  // primary source of truth for Bosun-specific configuration, so it should
  // override any stale shell env vars. Users who want shell vars to take
  // precedence can use profiles or set BOSUN_ENV_NO_OVERRIDE=1.
  loadDotEnv(configDir, { override: envOverride });

  const allowRepoEnvWithExplicitConfig = isEnvEnabled(
    process.env.BOSUN_LOAD_REPO_ENV_WITH_EXPLICIT_CONFIG,
    false,
  );
  const shouldLoadRepoEnv =
    (!hasExplicitConfigDir || allowRepoEnvWithExplicitConfig) &&
    !canonicalEnvExists &&
    resolve(repoRoot) !== resolve(configDir);

  // Legacy compatibility: fall back to the repo-root .env only when the
  // canonical config-dir .env does not exist yet.
  if (shouldLoadRepoEnv) {
    loadDotEnv(repoRoot, { override: envOverride });
  }

  const initialRepoRoot = repoRoot;

  const profiles = configData.profiles || configData.envProfiles || {};
  const defaultProfile =
    configData.defaultProfile ||
    configData.defaultEnvProfile ||
    (profiles.default ? "default" : "");
  const profileName =
    cli.profile ||
    process.env.BOSUN_PROFILE ||
    process.env.BOSUN_ENV_PROFILE ||
    selectedRepository?.profile ||
    selectedRepository?.envProfile ||
    defaultProfile ||
    "";
  const profile = profileName ? profiles[profileName] : null;

  if (profile?.envFile) {
    const envFilePath = resolve(configDir, profile.envFile);
    loadDotEnvFile(envFilePath, { override: profile.envOverride === true });
  }
  applyEnvProfile(profile, { override: reloadEnv });

  // Apply profile overrides (executors, repos, etc.)
  configData = applyProfileOverrides(configData, profile);
  repositories = loadWorkspaceRepoConfig(
    configDir,
    configData,
    activeWorkspace,
  );
  if (!repositories.length) {
    repositories = loadRepoConfig(configDir, configData, { repoRootOverride });
  }
  selectedRepository =
    resolveRepoSelection(
      repositories,
      repoSelection ||
        profile?.repository ||
        profile?.repo ||
        profile?.defaultRepository ||
        "",
    ) ||
    repositories.find((repo) => repo.primary) ||
    repositories[0] ||
    null;
  {
    const selPath = selectedRepository?.path || "";
    const selHasGit = selPath && existsSync(resolve(selPath, ".git"));
    repoRoot =
      explicitRepoRoot ||
      (selHasGit ? selPath : null) ||
      getFallbackRepoRoot();
  }

  if (
    shouldLoadRepoEnv &&
    resolve(repoRoot) !== resolve(initialRepoRoot)
  ) {
    loadDotEnv(repoRoot, { override: envOverride });
  }

  const envPaths = [resolve(configDir, ".env")];
  if (shouldLoadRepoEnv) {
    envPaths.push(resolve(repoRoot, ".env"));
  }
  const kanbanSource = resolveKanbanBackendSource({
    envPaths,
    configFilePath: configFile.path,
    configData,
  });

  // ── Project identity ─────────────────────────────────────
  const projectName =
    cli["project-name"] ||
    process.env.PROJECT_NAME ||
    selectedRepository?.projectName ||
    configData.projectName ||
    detectProjectName(configDir, repoRoot);

  const repoSlug =
    cli["repo"] ||
    process.env.GITHUB_REPO ||
    selectedRepository?.slug ||
    detectRepoSlug() ||
    "unknown/unknown";

  const repoUrlBase =
    process.env.GITHUB_REPO_URL ||
    selectedRepository?.repoUrlBase ||
    `https://github.com/${repoSlug}`;

  const mode =
    (
      cli.mode ||
      process.env.BOSUN_MODE ||
      configData.mode ||
      selectedRepository?.mode ||
      ""
    )
      .toString()
      .toLowerCase() ||
    "generic";

  // ── Orchestrator ─────────────────────────────────────────
  const defaultScript =
    selectedRepository?.orchestratorScript ||
    configData.orchestratorScript ||
    findOrchestratorScript(configDir, repoRoot);
  const defaultArgs =
    mode === "virtengine" ? "-MaxParallel 6 -WaitForMutex" : "";
  const rawScript =
    cli.script || process.env.ORCHESTRATOR_SCRIPT || defaultScript;
  // Resolve relative paths against configDir (not cwd) so that
  // relative script paths resolve correctly
  // regardless of what directory the process was started from.
  let scriptPath = resolve(configDir, rawScript);
  // If the resolved path doesn't exist and rawScript is just a filename (no path separators),
  // fall back to auto-detection to find it in common locations.
  if (
    !existsSync(scriptPath) &&
    !rawScript.includes("/") &&
    !rawScript.includes("\\")
  ) {
    const autoDetected = findOrchestratorScript(configDir, repoRoot);
    if (existsSync(autoDetected)) {
      scriptPath = autoDetected;
    }
  }
  const scriptArgsRaw =
    cli.args ||
    process.env.ORCHESTRATOR_ARGS ||
    selectedRepository?.orchestratorArgs ||
    configData.orchestratorArgs ||
    defaultArgs;
  const scriptArgs = scriptArgsRaw.split(" ").filter(Boolean);

  // ── Timing ───────────────────────────────────────────────
  const restartDelayMs = Number(
    cli["restart-delay"] || process.env.RESTART_DELAY_MS || "180000",
  );
  const maxRestarts = Number(
    cli["max-restarts"] || process.env.MAX_RESTARTS || "0",
  );

  // ── Logging ──────────────────────────────────────────────
  const logDir = resolve(
    cli["log-dir"] ||
      process.env.LOG_DIR ||
      selectedRepository?.logDir ||
      configData.logDir ||
      resolve(configDir, "logs"),
  );
  // Max total size of the log directory in MB. 0 = unlimited.
  const logMaxSizeMb = Number(
    process.env.LOG_MAX_SIZE_MB ?? configData.logMaxSizeMb ?? 500,
  );
  // How often to check log folder size (minutes). 0 = only at startup.
  const logCleanupIntervalMin = Number(
    process.env.LOG_CLEANUP_INTERVAL_MIN ??
      configData.logCleanupIntervalMin ??
      30,
  );

  // ── Agent SDK Selection ───────────────────────────────────
  const agentSdk = resolveAgentSdkConfig();

  // ── Feature flags ────────────────────────────────────────
  const flags = cli._flags;
  const watchEnabled = flags.has("no-watch")
    ? false
    : configData.watchEnabled !== undefined
      ? configData.watchEnabled
      : true;
  const watchPath = resolve(
    cli["watch-path"] ||
      process.env.WATCH_PATH ||
      selectedRepository?.watchPath ||
      configData.watchPath ||
      scriptPath,
  );
  const echoLogs = flags.has("echo-logs")
    ? true
    : flags.has("no-echo-logs")
      ? false
      : configData.echoLogs !== undefined
        ? configData.echoLogs
        : false;
  const autoFixEnabled = flags.has("no-autofix")
    ? false
    : configData.autoFixEnabled !== undefined
      ? configData.autoFixEnabled
      : true;
  const interactiveShellEnabled =
    flags.has("shell") ||
    flags.has("interactive") ||
    isEnvEnabled(process.env.BOSUN_SHELL, false) ||
    isEnvEnabled(process.env.BOSUN_INTERACTIVE, false) ||
    configData.interactiveShellEnabled === true ||
    configData.shellEnabled === true;
  const preflightEnabled = flags.has("no-preflight")
    ? false
    : configData.preflightEnabled !== undefined
      ? configData.preflightEnabled
      : isEnvEnabled(process.env.BOSUN_PREFLIGHT_DISABLED, false)
        ? false
        : true;
  const preflightRetryMs = Number(
    cli["preflight-retry"] ||
      process.env.BOSUN_PREFLIGHT_RETRY_MS ||
      configData.preflightRetryMs ||
      "300000",
  );
  const codexEnabled =
    !flags.has("no-codex") &&
    (configData.codexEnabled !== undefined ? configData.codexEnabled : true) &&
    !isEnvEnabled(process.env.CODEX_SDK_DISABLED, false) &&
    agentSdk.primary === "codex";
  const agentRuntime = normalizeAgentRuntime(
    cli["agent-runtime"] ||
      process.env.BOSUN_AGENT_RUNTIME ||
      configData.agentRuntime ||
      "harness",
  );
  const primaryAgent = normalizePrimaryAgent(
    cli["primary-agent"] ||
      cli.agent ||
      process.env.PRIMARY_AGENT ||
      process.env.PRIMARY_AGENT_SDK ||
      configData.primaryAgent ||
      "codex-sdk",
  );
  const primaryAgentEnabled = isEnvEnabled(
    process.env.PRIMARY_AGENT_DISABLED,
    false,
  )
    ? false
    : primaryAgent === "codex-sdk"
      ? codexEnabled
      : primaryAgent === "copilot-sdk"
        ? !isEnvEnabled(process.env.COPILOT_SDK_DISABLED, false)
        : primaryAgent === "claude-sdk"
          ? !isEnvEnabled(process.env.CLAUDE_SDK_DISABLED, false)
          : primaryAgent === "gemini-sdk"
            ? !isEnvEnabled(process.env.GEMINI_SDK_DISABLED, false)
            : primaryAgent === "opencode-sdk"
              ? !isEnvEnabled(process.env.OPENCODE_SDK_DISABLED, false)
              : false;

  // agentPoolEnabled: true when ANY agent SDK is available for pooled operations
  // This decouples pooled prompt execution from specific SDK selection
  const agentPoolEnabled =
    !isEnvEnabled(process.env.CODEX_SDK_DISABLED, false) ||
    !isEnvEnabled(process.env.COPILOT_SDK_DISABLED, false) ||
    !isEnvEnabled(process.env.CLAUDE_SDK_DISABLED, false) ||
    !isEnvEnabled(process.env.GEMINI_SDK_DISABLED, false) ||
    !isEnvEnabled(process.env.OPENCODE_SDK_DISABLED, false);

  // ── Internal Executor ────────────────────────────────────
  // Bosun now treats the internal queued-task engine as one mode: "internal".
  // Legacy EXECUTOR_MODE=hybrid is accepted and normalized for compatibility.
  const kanbanBackend = normalizeKanbanBackend(
    process.env.KANBAN_BACKEND || configData.kanban?.backend || "internal",
  );
  const kanbanSyncPolicy = normalizeKanbanSyncPolicy(
    process.env.KANBAN_SYNC_POLICY || configData.kanban?.syncPolicy,
  );
  const kanban = Object.freeze({
    backend: kanbanBackend,
    projectId:
      process.env.KANBAN_PROJECT_ID || configData.kanban?.projectId || null,
    syncPolicy: kanbanSyncPolicy,
  });
  const githubProjectSync = Object.freeze({
    webhookPath:
      process.env.GITHUB_PROJECT_WEBHOOK_PATH ||
      configData.kanban?.github?.project?.webhook?.path ||
      "/api/webhooks/github/project-sync",
    webhookSecret:
      process.env.GITHUB_PROJECT_WEBHOOK_SECRET ||
      process.env.GITHUB_WEBHOOK_SECRET ||
      configData.kanban?.github?.project?.webhook?.secret ||
      "",
    webhookRequireSignature: isEnvEnabled(
      process.env.GITHUB_PROJECT_WEBHOOK_REQUIRE_SIGNATURE ??
        configData.kanban?.github?.project?.webhook?.requireSignature,
      Boolean(
        process.env.GITHUB_PROJECT_WEBHOOK_SECRET ||
          process.env.GITHUB_WEBHOOK_SECRET ||
          configData.kanban?.github?.project?.webhook?.secret,
      ),
    ),
    alertFailureThreshold: Math.max(
      1,
      Number(
        process.env.GITHUB_PROJECT_SYNC_ALERT_FAILURE_THRESHOLD ||
          configData.kanban?.github?.project?.syncMonitoring
            ?.alertFailureThreshold ||
          3,
      ),
    ),
    rateLimitAlertThreshold: Math.max(
      1,
      Number(
        process.env.GITHUB_PROJECT_SYNC_RATE_LIMIT_ALERT_THRESHOLD ||
          configData.kanban?.github?.project?.syncMonitoring
            ?.rateLimitAlertThreshold ||
          3,
      ),
    ),
  });
  const jira = Object.freeze({
    baseUrl:
      process.env.JIRA_BASE_URL || configData.kanban?.jira?.baseUrl || "",
    email: process.env.JIRA_EMAIL || configData.kanban?.jira?.email || "",
    apiToken:
      process.env.JIRA_API_TOKEN || configData.kanban?.jira?.apiToken || "",
    projectKey:
      process.env.JIRA_PROJECT_KEY || configData.kanban?.jira?.projectKey || "",
    issueType:
      process.env.JIRA_ISSUE_TYPE ||
      configData.kanban?.jira?.issueType ||
      "Task",
    baseBranchField:
      process.env.JIRA_CUSTOM_FIELD_BASE_BRANCH ||
      configData.kanban?.jira?.baseBranchField ||
      "",
    statusMapping: Object.freeze({
      todo:
        process.env.JIRA_STATUS_TODO ||
        configData.kanban?.jira?.statusMapping?.todo ||
        "To Do",
      inprogress:
        process.env.JIRA_STATUS_INPROGRESS ||
        configData.kanban?.jira?.statusMapping?.inprogress ||
        "In Progress",
      inreview:
        process.env.JIRA_STATUS_INREVIEW ||
        configData.kanban?.jira?.statusMapping?.inreview ||
        "In Review",
      done:
        process.env.JIRA_STATUS_DONE ||
        configData.kanban?.jira?.statusMapping?.done ||
        "Done",
      cancelled:
        process.env.JIRA_STATUS_CANCELLED ||
        configData.kanban?.jira?.statusMapping?.cancelled ||
        "Cancelled",
    }),
    labels: Object.freeze({
      claimed:
        process.env.JIRA_LABEL_CLAIMED ||
        configData.kanban?.jira?.labels?.claimed ||
        "codex:claimed",
      working:
        process.env.JIRA_LABEL_WORKING ||
        configData.kanban?.jira?.labels?.working ||
        "codex:working",
      stale:
        process.env.JIRA_LABEL_STALE ||
        configData.kanban?.jira?.labels?.stale ||
        "codex:stale",
      ignore:
        process.env.JIRA_LABEL_IGNORE ||
        configData.kanban?.jira?.labels?.ignore ||
        "codex:ignore",
    }),
    sharedStateFields: Object.freeze({
      ownerId:
        process.env.JIRA_CUSTOM_FIELD_OWNER_ID ||
        configData.kanban?.jira?.sharedStateFields?.ownerId ||
        "",
      attemptToken:
        process.env.JIRA_CUSTOM_FIELD_ATTEMPT_TOKEN ||
        configData.kanban?.jira?.sharedStateFields?.attemptToken ||
        "",
      attemptStarted:
        process.env.JIRA_CUSTOM_FIELD_ATTEMPT_STARTED ||
        configData.kanban?.jira?.sharedStateFields?.attemptStarted ||
        "",
      heartbeat:
        process.env.JIRA_CUSTOM_FIELD_HEARTBEAT ||
        configData.kanban?.jira?.sharedStateFields?.heartbeat ||
        "",
      retryCount:
        process.env.JIRA_CUSTOM_FIELD_RETRY_COUNT ||
        configData.kanban?.jira?.sharedStateFields?.retryCount ||
        "",
      ignoreReason:
        process.env.JIRA_CUSTOM_FIELD_IGNORE_REASON ||
        configData.kanban?.jira?.sharedStateFields?.ignoreReason ||
        "",
    }),
  });
  const repoMirror = Object.freeze({
    enabled: isEnvEnabled(
      process.env.REPO_MIRROR_ENABLED ?? configData.kanban?.repoMirror?.enabled,
      false,
    ),
    repoPath:
      String(
        process.env.REPO_MIRROR_REPO_PATH || configData.kanban?.repoMirror?.repoPath || "",
      ).trim(),
    syncMode: normalizeRepoMirrorSyncMode(
      process.env.REPO_MIRROR_SYNC_MODE || configData.kanban?.repoMirror?.syncMode,
    ),
    runStorage: normalizeRepoMirrorRunStorage(
      process.env.REPO_MIRROR_RUN_STORAGE || configData.kanban?.repoMirror?.runStorage,
    ),
    messageStorage: normalizeRepoMirrorMessageStorage(
      process.env.REPO_MIRROR_MESSAGE_STORAGE ||
        configData.kanban?.repoMirror?.messageStorage,
    ),
    publicRoadmapEnabled: isEnvEnabled(
      process.env.REPO_MIRROR_PUBLIC_ROADMAP_ENABLED ??
        configData.kanban?.repoMirror?.publicRoadmapEnabled,
      false,
    ),
  });
  validateKanbanBackendConfig({ kanbanBackend, kanban, jira, repoMirror });

  const internalExecutorConfig = configData.internalExecutor || {};
  const workflowRecoveryConfig =
    configData.workflowRecovery && typeof configData.workflowRecovery === "object"
      ? configData.workflowRecovery
      : {};
  const envInternalExecutorParallel = configFileHadInvalidJson
    ? undefined
    : process.env.INTERNAL_EXECUTOR_PARALLEL;
  const projectRequirements = {
    profile: normalizeProjectRequirementsProfile(
      process.env.PROJECT_REQUIREMENTS_PROFILE ||
        configData.projectRequirements?.profile ||
        internalExecutorConfig.projectRequirements?.profile ||
        "feature",
    ),
    notes: String(
      process.env.PROJECT_REQUIREMENTS_NOTES ||
        configData.projectRequirements?.notes ||
        internalExecutorConfig.projectRequirements?.notes ||
        "",
    ).trim(),
  };
  const replenishMin = Math.max(
    1,
    Math.min(
      2,
      Number(
        process.env.INTERNAL_EXECUTOR_REPLENISH_MIN_NEW_TASKS ||
          internalExecutorConfig.backlogReplenishment?.minNewTasks ||
          1,
      ),
    ),
  );
  const replenishMax = Math.max(
    replenishMin,
    Math.min(
      3,
      Number(
        process.env.INTERNAL_EXECUTOR_REPLENISH_MAX_NEW_TASKS ||
          internalExecutorConfig.backlogReplenishment?.maxNewTasks ||
          2,
      ),
    ),
  );
  const executorMode = normalizeInternalExecutorMode(
    process.env.EXECUTOR_MODE ||
    internalExecutorConfig.mode ||
    "internal",
  );
  const reviewAgentToggleRaw =
    process.env.INTERNAL_EXECUTOR_REVIEW_AGENT_ENABLED;
  const reviewAgentEnabled =
    reviewAgentToggleRaw !== undefined &&
    String(reviewAgentToggleRaw).trim() !== ""
      ? isEnvEnabled(reviewAgentToggleRaw, true)
      : internalExecutorConfig.reviewAgentEnabled !== false;
  const workflowRecoveryMaxAttempts = parseBoundedInteger(
    process.env.WORKFLOW_RECOVERY_MAX_ATTEMPTS ??
      workflowRecoveryConfig.maxAttempts,
    5,
    { min: 1, max: 20 },
  );
  const workflowRecoveryEscalationThreshold = parseBoundedInteger(
    process.env.WORKFLOW_RECOVERY_ESCALATION_THRESHOLD ??
      workflowRecoveryConfig.escalationWarnAfterAttempts ??
      workflowRecoveryConfig.escalationThreshold,
    3,
    { min: 1, max: workflowRecoveryMaxAttempts },
  );
  const workflowRecovery = Object.freeze({
    maxAttempts: workflowRecoveryMaxAttempts,
    escalationWarnAfterAttempts: workflowRecoveryEscalationThreshold,
    baseBackoffMs: parseBoundedInteger(
      process.env.WORKFLOW_RECOVERY_BACKOFF_BASE_MS ??
        workflowRecoveryConfig.baseBackoffMs,
      5000,
      { min: 50, max: 60_000 },
    ),
    maxBackoffMs: parseBoundedInteger(
      process.env.WORKFLOW_RECOVERY_BACKOFF_MAX_MS ??
        workflowRecoveryConfig.maxBackoffMs,
      60_000,
      { min: 1000, max: 30 * 60 * 1000 },
    ),
    jitterRatio: parseBoundedNumber(
      process.env.WORKFLOW_RECOVERY_BACKOFF_JITTER_RATIO ??
        workflowRecoveryConfig.jitterRatio,
      0.2,
      { min: 0, max: 0.9 },
    ),
  });
  const internalExecutor = {
    mode: executorMode,
    maxParallel: Number(
      envInternalExecutorParallel ||
        internalExecutorConfig.maxParallel ||
        3,
    ),
    baseBranchParallelLimit: Number(
      process.env.INTERNAL_EXECUTOR_BASE_BRANCH_PARALLEL ||
        internalExecutorConfig.baseBranchParallelLimit ||
        0,
    ),
    pollIntervalMs: Number(
      process.env.INTERNAL_EXECUTOR_POLL_MS ||
        internalExecutorConfig.pollIntervalMs ||
        30000,
    ),
    sdk:
      process.env.INTERNAL_EXECUTOR_SDK || internalExecutorConfig.sdk || "auto",
    taskTimeoutMs: Number(
      process.env.INTERNAL_EXECUTOR_TIMEOUT_MS ||
        internalExecutorConfig.taskTimeoutMs ||
        90 * 60 * 1000,
    ),
    maxRetries: Number(
      process.env.INTERNAL_EXECUTOR_MAX_RETRIES ||
        internalExecutorConfig.maxRetries ||
        2,
    ),
    retryReviewThreshold: Number(
      process.env.INTERNAL_EXECUTOR_RETRY_REVIEW_THRESHOLD ||
        internalExecutorConfig.retryReviewThreshold ||
        internalExecutorConfig.maxRetries ||
        3,
    ),
    retryDelayMs: Number(
      process.env.INTERNAL_EXECUTOR_RETRY_DELAY_MS ||
        internalExecutorConfig.retryDelayMs ||
        15000,
    ),
    autoCreatePr: internalExecutorConfig.autoCreatePr !== false,
    projectId:
      process.env.INTERNAL_EXECUTOR_PROJECT_ID ||
      internalExecutorConfig.projectId ||
      null,
    reviewAgentEnabled,
    reviewMaxConcurrent: Number(
      process.env.INTERNAL_EXECUTOR_REVIEW_MAX_CONCURRENT ||
        internalExecutorConfig.reviewMaxConcurrent ||
        2,
    ),
    reviewTimeoutMs: Number(
      process.env.INTERNAL_EXECUTOR_REVIEW_TIMEOUT_MS ||
        internalExecutorConfig.reviewTimeoutMs ||
        300000,
    ),
    taskClaimOwnerStaleTtlMs: Number(
      process.env.TASK_CLAIM_OWNER_STALE_TTL_MS ||
        internalExecutorConfig.taskClaimOwnerStaleTtlMs ||
        10 * 60 * 1000,
    ),
    taskClaimRenewIntervalMs: Number(
      process.env.TASK_CLAIM_RENEW_INTERVAL_MS ||
        internalExecutorConfig.taskClaimRenewIntervalMs ||
        5 * 60 * 1000,
    ),
    backlogReplenishment: {
      enabled: isEnvEnabled(
        process.env.INTERNAL_EXECUTOR_REPLENISH_ENABLED,
        internalExecutorConfig.backlogReplenishment?.enabled === true,
      ),
      minNewTasks: replenishMin,
      maxNewTasks: replenishMax,
      requirePriority: isEnvEnabled(
        process.env.INTERNAL_EXECUTOR_REPLENISH_REQUIRE_PRIORITY,
        internalExecutorConfig.backlogReplenishment?.requirePriority !== false,
      ),
    },
    stream: {
      maxRetries: Number(
        process.env.INTERNAL_EXECUTOR_STREAM_MAX_RETRIES ||
          internalExecutorConfig.stream?.maxRetries ||
          5,
      ),
      retryBaseMs: Number(
        process.env.INTERNAL_EXECUTOR_STREAM_RETRY_BASE_MS ||
          internalExecutorConfig.stream?.retryBaseMs ||
          2000,
      ),
      retryMaxMs: Number(
        process.env.INTERNAL_EXECUTOR_STREAM_RETRY_MAX_MS ||
          internalExecutorConfig.stream?.retryMaxMs ||
          32000,
      ),
      firstEventTimeoutMs: Number(
        process.env.INTERNAL_EXECUTOR_STREAM_FIRST_EVENT_TIMEOUT_MS ||
          internalExecutorConfig.stream?.firstEventTimeoutMs ||
          120000,
      ),
      maxItemsPerTurn: Number(
        process.env.INTERNAL_EXECUTOR_STREAM_MAX_ITEMS_PER_TURN ||
          internalExecutorConfig.stream?.maxItemsPerTurn ||
          600,
      ),
      maxItemChars: Number(
        process.env.INTERNAL_EXECUTOR_STREAM_MAX_ITEM_CHARS ||
          internalExecutorConfig.stream?.maxItemChars ||
          12000,
      ),
    },
    projectRequirements,
  };

  // ── Tracing ──────────────────────────────────────────────
  const tracingEndpoint =
    process.env.BOSUN_OTEL_ENDPOINT || configData?.tracing?.endpoint || null;
  const tracingEnabled = configData?.tracing?.enabled ?? Boolean(tracingEndpoint);
  const tracingSampleRate = Number(configData?.tracing?.sampleRate ?? 1);

  // ── Telegram ─────────────────────────────────────────────
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN || "";
  const telegramChatId = process.env.TELEGRAM_CHAT_ID || "";
  const telegramIntervalMin = Number(process.env.TELEGRAM_INTERVAL_MIN || "10");
  const telegramCommandPollTimeoutSec = Math.max(
    5,
    Number(process.env.TELEGRAM_COMMAND_POLL_TIMEOUT_SEC || "20"),
  );
  const telegramCommandConcurrency = Math.max(
    1,
    Number(process.env.TELEGRAM_COMMAND_CONCURRENCY || "2"),
  );
  const telegramCommandMaxBatch = Math.max(
    1,
    Number(process.env.TELEGRAM_COMMAND_MAX_BATCH || "25"),
  );
  const telegramBotEnabled = !flags.has("no-telegram-bot") && !!telegramToken;
  const telegramCommandEnabled = flags.has("telegram-commands")
    ? !telegramBotEnabled
    : false;
  // Verbosity: minimal (critical+error only), summary (default — up to warnings
  // + key info), detailed (everything including debug).
  const telegramVerbosity = (
    process.env.TELEGRAM_VERBOSITY ||
    configData.telegramVerbosity ||
    "summary"
  ).toLowerCase();

  const triggerSystemDefaults = Object.freeze({
    templates: buildDefaultTriggerTemplates(),
    defaults: Object.freeze({
      executor: "auto",
      model: "auto",
    }),
  });
  const triggerSystem = resolveTriggerSystemConfig(
    configData,
    triggerSystemDefaults,
  );
  const workflows = resolveWorkflowConfig(configData);
  const workflowWorktreeRecoveryCooldownMin = toBoundedInt(
    process.env.WORKFLOW_WORKTREE_RECOVERY_COOLDOWN_MIN ??
      configData.workflowWorktreeRecoveryCooldownMin,
    15,
    1,
    1440,
  );
  const worktreeBootstrap = resolveWorktreeBootstrapConfig(configData);

  // ── GitHub Reconciler ───────────────────────────────────
  const ghReconcileEnabled = isEnvEnabled(
    process.env.GH_RECONCILE_ENABLED ?? configData.ghReconcileEnabled,
    process.env.VITEST ? false : true,
  );
  const ghReconcileIntervalMs = Number(
    process.env.GH_RECONCILE_INTERVAL_MS ||
      configData.ghReconcileIntervalMs ||
      5 * 60 * 1000,
  );
  const ghReconcileMergedLookbackHours = Number(
    process.env.GH_RECONCILE_MERGED_LOOKBACK_HOURS ||
      configData.ghReconcileMergedLookbackHours ||
      72,
  );
  const ghReconcileTrackingLabels = String(
    process.env.GH_RECONCILE_TRACKING_LABELS ||
      configData.ghReconcileTrackingLabels ||
      "tracking",
  )
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  // ── Branch Routing ────────────────────────────────────────
  // Maps scope patterns (from conventional commit scopes in task titles) to
  // upstream branches.  Allows e.g. all "bosun" tasks to route to
  // "origin/ve/bosun-staging" instead of the default target branch.
  //
  // Config format (bosun.config.json):
  //   "branchRouting": {
  //     "defaultBranch": "origin/staging",
  //     "scopeMap": {
  //       "bosun": "origin/ve/bosun-staging",
  //       "veid":          "origin/staging",
  //       "provider":      "origin/staging"
  //     },
  //     "autoRebaseOnMerge": true,
  //     "assessWithSdk": true
  //   }
  //
  // Env overrides:
  //   BRANCH_ROUTING_SCOPE_MAP=bosun:origin/ve/bosun-staging,veid:origin/staging
  //   AUTO_REBASE_ON_MERGE=true
  //   ASSESS_WITH_SDK=true
  const branchRoutingRaw = configData.branchRouting || {};
  const defaultTargetBranch =
    process.env.DEFAULT_TARGET_BRANCH ||
    branchRoutingRaw.defaultBranch ||
    "origin/main";
  const scopeMapEnv = process.env.BRANCH_ROUTING_SCOPE_MAP || "";
  const scopeMapFromEnv = {};
  if (scopeMapEnv) {
    for (const pair of scopeMapEnv.split(",")) {
      const [scope, branch] = pair.split(":").map((s) => s.trim());
      if (scope && branch) scopeMapFromEnv[scope.toLowerCase()] = branch;
    }
  }
  const scopeMap = {
    ...(branchRoutingRaw.scopeMap || {}),
    ...scopeMapFromEnv,
  };
  // Normalise keys to lowercase
  const normalizedScopeMap = {};
  for (const [key, val] of Object.entries(scopeMap)) {
    normalizedScopeMap[key.toLowerCase()] = val;
  }
  const autoRebaseOnMerge = isEnvEnabled(
    process.env.AUTO_REBASE_ON_MERGE ?? branchRoutingRaw.autoRebaseOnMerge,
    true,
  );
  const assessWithSdk = isEnvEnabled(
    process.env.ASSESS_WITH_SDK ?? branchRoutingRaw.assessWithSdk,
    true,
  );
  const branchRouting = Object.freeze({
    defaultBranch: defaultTargetBranch,
    scopeMap: Object.freeze(normalizedScopeMap),
    autoRebaseOnMerge,
    assessWithSdk,
  });

  const workflowDefaults =
    configData.workflowDefaults && typeof configData.workflowDefaults === "object"
      ? {
          ...configData.workflowDefaults,
          templates: Array.isArray(configData.workflowDefaults.templates)
            ? [...configData.workflowDefaults.templates]
            : configData.workflowDefaults.templates,
          templateOverridesById:
            configData.workflowDefaults.templateOverridesById &&
            typeof configData.workflowDefaults.templateOverridesById === "object"
              ? { ...configData.workflowDefaults.templateOverridesById }
              : {},
        }
      : {};

  // ── Fleet Coordination ─────────────────────────────────────
  // Multi-workstation collaboration: when 2+ bosun instances share
  // the same repo, the fleet system coordinates task planning, dispatch,
  // and conflict-aware ordering.
  const fleetEnabled = isEnvEnabled(
    process.env.FLEET_ENABLED ?? configData.fleetEnabled,
    true,
  );
  const fleetBufferMultiplier = Number(
    process.env.FLEET_BUFFER_MULTIPLIER ||
      configData.fleetBufferMultiplier ||
      "3",
  );
  const fleetSyncIntervalMs = Number(
    process.env.FLEET_SYNC_INTERVAL_MS ||
      configData.fleetSyncIntervalMs ||
      String(2 * 60 * 1000), // 2 minutes
  );
  const fleetPresenceTtlMs = Number(
    process.env.FLEET_PRESENCE_TTL_MS ||
      configData.fleetPresenceTtlMs ||
      String(5 * 60 * 1000), // 5 minutes
  );
  const fleetKnowledgeEnabled = isEnvEnabled(
    process.env.FLEET_KNOWLEDGE_ENABLED ?? configData.fleetKnowledgeEnabled,
    true,
  );
  const fleetKnowledgeFile = String(
    process.env.FLEET_KNOWLEDGE_FILE ||
      configData.fleetKnowledgeFile ||
      "AGENTS.md",
  );
  const fleet = Object.freeze({
    enabled: fleetEnabled,
    bufferMultiplier: fleetBufferMultiplier,
    syncIntervalMs: fleetSyncIntervalMs,
    presenceTtlMs: fleetPresenceTtlMs,
    knowledgeEnabled: fleetKnowledgeEnabled,
    knowledgeFile: fleetKnowledgeFile,
  });

  // ── Dependabot Auto-Merge ─────────────────────────────────
  const dependabotAutoMerge = isEnvEnabled(
    process.env.DEPENDABOT_AUTO_MERGE ?? configData.dependabotAutoMerge,
    true,
  );
  const dependabotAutoMergeIntervalMin = Number(
    process.env.DEPENDABOT_AUTO_MERGE_INTERVAL_MIN || "10",
  );
  // Merge method: squash (default), merge, rebase
  const dependabotMergeMethod = String(
    process.env.DEPENDABOT_MERGE_METHOD ||
      configData.dependabotMergeMethod ||
      "squash",
  ).toLowerCase();
  // PR authors to auto-merge (comma-separated). Default: dependabot[bot]
  const dependabotAuthors = String(
    process.env.DEPENDABOT_AUTHORS ||
      configData.dependabotAuthors ||
      "dependabot[bot],app/dependabot",
  )
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);

  const prAutomationData =
    configData.prAutomation && typeof configData.prAutomation === "object"
      ? configData.prAutomation
      : {};
  const prAutomation = Object.freeze({
    attachMode: String(
      process.env.BOSUN_PR_ATTACH_MODE ||
        prAutomationData.attachMode ||
        "all",
    )
      .trim()
      .toLowerCase(),
    trustedAuthors: resolveTrustedAuthorList(
      process.env.BOSUN_PR_TRUSTED_AUTHORS ?? prAutomationData.trustedAuthors ?? [],
      { includeOAuthTrustedAuthor: true },
    ),
    allowTrustedFixes: isEnvEnabled(
      process.env.BOSUN_PR_ALLOW_TRUSTED_FIXES ?? prAutomationData.allowTrustedFixes,
      false,
    ),
    allowTrustedMerges: isEnvEnabled(
      process.env.BOSUN_PR_ALLOW_TRUSTED_MERGES ?? prAutomationData.allowTrustedMerges,
      false,
    ),
    assistiveActions: Object.freeze({
      installOnSetup: isEnvEnabled(
        process.env.BOSUN_PR_ASSISTIVE_ACTIONS_INSTALL_ON_SETUP ?? prAutomationData?.assistiveActions?.installOnSetup,
        false,
      ),
    }),
  });
  const gatesData =
    configData.gates && typeof configData.gates === "object"
      ? configData.gates
      : {};
  const gatesPrsData =
    gatesData.prs && typeof gatesData.prs === "object"
      ? gatesData.prs
      : {};
  const gatesChecksData =
    gatesData.checks && typeof gatesData.checks === "object"
      ? gatesData.checks
      : {};
  const gatesExecutionData =
    gatesData.execution && typeof gatesData.execution === "object"
      ? gatesData.execution
      : {};
  const gatesWorktreesData =
    gatesData.worktrees && typeof gatesData.worktrees === "object"
      ? gatesData.worktrees
      : {};
  const gatesRuntimeData =
    gatesData.runtime && typeof gatesData.runtime === "object"
      ? gatesData.runtime
      : {};
  const hasExplicitWorktreeBootstrapEnabled =
    configData.worktreeBootstrap &&
    typeof configData.worktreeBootstrap === "object" &&
    Object.prototype.hasOwnProperty.call(configData.worktreeBootstrap, "enabled");
  const managedWorktreeDefault = hasExplicitWorktreeBootstrapEnabled
    ? worktreeBootstrap.enabled
    : true;
  const repoVisibilityRaw = String(
    process.env.BOSUN_GATES_REPO_VISIBILITY ||
      gatesPrsData.repoVisibility ||
      "unknown",
  )
    .trim()
    .toLowerCase();
  const repoVisibility = ["public", "private", "unknown"].includes(repoVisibilityRaw)
    ? repoVisibilityRaw
    : "unknown";
  const automationPreferenceRaw = String(
    process.env.BOSUN_GATES_AUTOMATION_PREFERENCE ||
      gatesPrsData.automationPreference ||
      (repoVisibility === "public" ? "actions-first" : "runtime-first"),
  )
    .trim()
    .toLowerCase();
  const automationPreference = ["runtime-first", "actions-first"].includes(automationPreferenceRaw)
    ? automationPreferenceRaw
    : (repoVisibility === "public" ? "actions-first" : "runtime-first");
  const githubActionsBudgetRaw = String(
    process.env.BOSUN_GATES_ACTIONS_BUDGET ||
      gatesPrsData.githubActionsBudget ||
      "ask-user",
  )
    .trim()
    .toLowerCase();
  const githubActionsBudget = ["ask-user", "available", "limited"].includes(githubActionsBudgetRaw)
    ? githubActionsBudgetRaw
    : "ask-user";
  const checkModeRaw = String(
    process.env.BOSUN_GATES_CHECK_MODE ||
      gatesChecksData.mode ||
      "all",
  )
    .trim()
    .toLowerCase();
  const checkMode = ["all", "required-only"].includes(checkModeRaw)
    ? checkModeRaw
    : "all";
  const gates = Object.freeze({
    prs: Object.freeze({
      repoVisibility,
      automationPreference,
      githubActionsBudget,
    }),
    checks: Object.freeze({
      mode: checkMode,
      requiredPatterns: parseListSetting(
        process.env.BOSUN_REQUIRED_CHECK_PATTERNS ?? gatesChecksData.requiredPatterns ?? [],
      ),
      optionalPatterns: parseListSetting(
        process.env.BOSUN_OPTIONAL_CHECK_PATTERNS ?? gatesChecksData.optionalPatterns ?? [],
      ),
      ignorePatterns: parseListSetting(
        process.env.BOSUN_IGNORE_CHECK_PATTERNS ?? gatesChecksData.ignorePatterns ?? [],
      ),
      requireAnyRequiredCheck: isEnvEnabled(
        process.env.BOSUN_GATES_REQUIRE_ANY_REQUIRED_CHECK ?? gatesChecksData.requireAnyRequiredCheck,
        true,
      ),
      treatPendingRequiredAsBlocking: isEnvEnabled(
        process.env.BOSUN_GATES_TREAT_PENDING_REQUIRED_AS_BLOCKING ?? gatesChecksData.treatPendingRequiredAsBlocking,
        true,
      ),
      treatNeutralAsPass: isEnvEnabled(
        process.env.BOSUN_GATES_TREAT_NEUTRAL_AS_PASS ?? gatesChecksData.treatNeutralAsPass,
        false,
      ),
    }),
    execution: Object.freeze({
      sandboxMode: String(
        process.env.CODEX_SANDBOX ||
          gatesExecutionData.sandboxMode ||
          "workspace-write",
      )
        .trim()
        .toLowerCase(),
      containerIsolationEnabled: isEnvEnabled(
        process.env.CONTAINER_ENABLED ?? gatesExecutionData.containerIsolationEnabled,
        false,
      ),
      containerRuntime: String(
        process.env.CONTAINER_RUNTIME ||
          gatesExecutionData.containerRuntime ||
          "auto",
      )
        .trim()
        .toLowerCase(),
      networkAccess: String(
        process.env.BOSUN_EXECUTION_NETWORK_ACCESS ||
          gatesExecutionData.networkAccess ||
          "default",
      )
        .trim()
        .toLowerCase(),
    }),
    worktrees: Object.freeze({
      requireBootstrap: isEnvEnabled(
        process.env.BOSUN_GATES_WORKTREE_REQUIRE_BOOTSTRAP ??
          gatesWorktreesData.requireBootstrap,
        managedWorktreeDefault,
      ),
      requireReadiness: isEnvEnabled(
        process.env.BOSUN_GATES_WORKTREE_REQUIRE_READINESS ??
          gatesWorktreesData.requireReadiness,
        managedWorktreeDefault,
      ),
      enforcePushHook: isEnvEnabled(
        process.env.BOSUN_GATES_WORKTREE_ENFORCE_PUSH_HOOK ??
          gatesWorktreesData.enforcePushHook,
        true,
      ),
    }),
    runtime: Object.freeze({
      enforceBacklog: isEnvEnabled(
        process.env.BOSUN_GATES_ENFORCE_BACKLOG ??
          gatesRuntimeData.enforceBacklog ??
          configData.enforceBacklog,
        true,
      ),
      agentTriggerControl: isEnvEnabled(
        process.env.BOSUN_GATES_AGENT_TRIGGER_CONTROL ??
          gatesRuntimeData.agentTriggerControl ??
          configData.agentTriggerControl,
        true,
      ),
    }),
  });
  const harnessData =
    configData.harness && typeof configData.harness === "object"
      ? configData.harness
      : {};
  const providersData =
    configData.providers && typeof configData.providers === "object"
      ? configData.providers
      : {};
  const harnessValidationData =
    harnessData.validation && typeof harnessData.validation === "object"
      ? harnessData.validation
      : {};
  const harnessValidationModeRaw = String(
    process.env.BOSUN_HARNESS_VALIDATION_MODE ??
      harnessValidationData.mode ??
      "report",
  )
    .trim()
    .toLowerCase();
  const harness = Object.freeze({
    enabled: isEnvEnabled(
      process.env.BOSUN_HARNESS_ENABLED ?? harnessData.enabled,
      agentRuntime === "harness",
    ),
    source: String(
      process.env.BOSUN_HARNESS_SOURCE ??
        harnessData.source ??
        "",
    ).trim(),
    validation: Object.freeze({
      mode: ["off", "report", "enforce"].includes(harnessValidationModeRaw)
        ? harnessValidationModeRaw
        : "report",
    }),
    primaryExecutor: String(harnessData.primaryExecutor ?? "").trim() || "",
    routingMode: String(harnessData.routingMode ?? providersData.routingMode ?? "default-only").trim().toLowerCase() || "default-only",
    executors: Array.isArray(harnessData.executors)
      ? harnessData.executors.map((entry) => ({ ...(entry && typeof entry === "object" ? entry : {}) }))
      : [],
  });
  const providers = Object.freeze({
    ...(providersData || {}),
  });

  // ── Status file ──────────────────────────────────────────
  const cacheDir = resolve(
    repoRoot,
    configData.cacheDir || selectedRepository?.cacheDir || ".cache",
  );
  const statusPath =
    process.env.STATUS_FILE ||
    configData.statusPath ||
    selectedRepository?.statusPath ||
    resolve(cacheDir, "bosun-status.json");
  const lockBase =
    configData.telegramPollLockPath ||
    selectedRepository?.telegramPollLockPath ||
    resolve(cacheDir, "telegram-getupdates.lock");
  const telegramPollLockPath = lockBase.endsWith(".lock")
    ? resolve(lockBase)
    : resolve(lockBase, "telegram-getupdates.lock");

  // ── Executors ────────────────────────────────────────────
  const executorConfig = loadExecutorConfig(configDir, configData);
  const scheduler = new ExecutorScheduler(executorConfig);

  // ── Agent prompts ────────────────────────────────────────
  ensurePromptWorkspaceGitIgnore(repoRoot);
  ensureAgentPromptWorkspace(repoRoot);
  const agentPrompts = loadAgentPrompts(configDir, repoRoot, configData);
  const agentPromptSources = agentPrompts._sources || {};
  delete agentPrompts._sources;
  const markdownSafety = resolveMarkdownSafetyPolicy(configData, { rootDir: repoRoot });
  const agentPromptCatalog = getAgentPromptDefinitions();

  // ── First-run detection ──────────────────────────────────
  const isFirstRun = !hasSetupMarkers(configDir);

  const config = {
    // Identity
    projectName,
    mode,
    repoSlug,
    repoUrlBase,
    repoRoot,
    configDir,
    envPaths,

    // Orchestrator
    scriptPath,
    scriptArgs,
    restartDelayMs,
    maxRestarts,

    // Logging
    logDir,
    logMaxSizeMb,
    logCleanupIntervalMin,

    // Agent SDK
    agentSdk,

    // Feature flags
    watchEnabled,
    watchPath,
    echoLogs,
    autoFixEnabled,
    interactiveShellEnabled,
    preflightEnabled,
    preflightRetryMs,
    codexEnabled,
    agentRuntime,
    agentPoolEnabled,
    primaryAgent,
    primaryAgentEnabled,

    // Internal Executor
    internalExecutor,
    workflowRecovery,
    executorMode: internalExecutor.mode,
    kanban,
    kanbanSource,
    githubProjectSync,
    jira,
    repoMirror,
    projectRequirements,

    // Voice assistant
    voice: Object.freeze(configData.voice || {}),

    // Merge Strategy
    codexAnalyzeMergeStrategy:
      codexEnabled &&
      (process.env.CODEX_ANALYZE_MERGE_STRATEGY || "").toLowerCase() !==
        "false",
    mergeStrategyTimeoutMs:
      parseInt(process.env.MERGE_STRATEGY_TIMEOUT_MS, 10) || 10 * 60 * 1000,

    // Autofix mode hint (informational — actual detection uses isDevMode())
    autofixMode: process.env.AUTOFIX_MODE || "auto",

    tracing: {
      enabled: tracingEnabled,
      endpoint: tracingEndpoint,
      sampleRate: Number.isFinite(tracingSampleRate) ? tracingSampleRate : 1,
    },

    // Telegram
    telegramToken,
    telegramChatId,
    telegramIntervalMin,
    telegramCommandPollTimeoutSec,
    telegramCommandConcurrency,
    telegramCommandMaxBatch,
    telegramBotEnabled,
    telegramCommandEnabled,
    telegramVerbosity,
    telemetry: Object.freeze({
      costPer1kTokensUsd: Object.freeze({
        claude: Number.isFinite(Number(configData.telemetry?.costPer1kTokensUsd?.claude)) ? Number(configData.telemetry.costPer1kTokensUsd.claude) : 0.003,
        codex: Number.isFinite(Number(configData.telemetry?.costPer1kTokensUsd?.codex)) ? Number(configData.telemetry.costPer1kTokensUsd.codex) : 0.002,
        gemini: Number.isFinite(Number(configData.telemetry?.costPer1kTokensUsd?.gemini)) ? Number(configData.telemetry.costPer1kTokensUsd.gemini) : 0.0001,
        copilot: Number.isFinite(Number(configData.telemetry?.costPer1kTokensUsd?.copilot)) ? Number(configData.telemetry.costPer1kTokensUsd.copilot) : 0,
      }),
    }),
    triggerSystem,
    workflows,
  workflowWorktreeRecoveryCooldownMin,
    worktreeBootstrap,

    // GitHub Reconciler
    githubReconcile: {
      enabled: ghReconcileEnabled,
      intervalMs: ghReconcileIntervalMs,
      mergedLookbackHours: ghReconcileMergedLookbackHours,
      trackingLabels: ghReconcileTrackingLabels,
    },

    // Dependabot Auto-Merge
    dependabotAutoMerge,
    dependabotAutoMergeIntervalMin,
    dependabotMergeMethod,
    dependabotAuthors,

    // Branch Routing
    branchRouting,

    // PR automation trust policy
    prAutomation,
    gates,

    // Fleet Coordination
    fleet,

    // Workflow template defaults + opt-in typed workflow entries
    workflowDefaults: Object.freeze(workflowDefaults),
    harness,
    providers,

    // Paths
    statusPath,
    telegramPollLockPath,
    cacheDir,

    // Executors
    executorConfig,
    scheduler,

    // Multi-repo / Workspaces
    repositories,
    selectedRepository,
    workspacesDir,
    activeWorkspace,
    agentRepoRoot,

    // Agent prompts
    agentPrompts,
    agentPromptSources,
    agentPromptCatalog,
    markdownSafety,

    // First run
    isFirstRun,

    // Security controls
    security: Object.freeze({
      // List of trusted issue creators (primary GitHub account or configured list)
      trustedCreators:
        configData.trustedCreators ||
        process.env.BOSUN_TRUSTED_CREATORS?.split(",") ||
        [],
      // Enforce all new tasks go to backlog
      enforceBacklog:
        typeof configData.enforceBacklog === "boolean"
          ? configData.enforceBacklog
          : true,
      // Control agent triggers: restrict agent activation to trusted sources
      agentTriggerControl:
        typeof configData.agentTriggerControl === "boolean"
          ? configData.agentTriggerControl
          : true,
    }),
  };

  return Object.freeze(config);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function detectProjectName(configDir, repoRoot) {
  // Try package.json in repo root
  const pkgPath = resolve(repoRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg.name) return pkg.name.replace(/^@[^/]+\//, "");
    } catch {
      /* skip */
    }
  }
  // Fallback to directory name
  return basename(repoRoot);
}

function findOrchestratorScript(configDir, repoRoot) {
  const shellModeEnv = String(process.env.BOSUN_SHELL_MODE || "")
    .trim()
    .toLowerCase();
  const shellModeRequested = ["1", "true", "yes", "on"].includes(shellModeEnv);
  const orchestratorEnv = String(process.env.ORCHESTRATOR_SCRIPT || "")
    .trim()
    .toLowerCase();
  const preferShellScript =
    shellModeRequested ||
    orchestratorEnv.endsWith(".sh") ||
    (process.platform !== "win32" && !orchestratorEnv.endsWith(".ps1"));

  const shCandidates = [
    resolve(configDir, "orchestrator.sh"),
    resolve(configDir, "..", "orchestrator.sh"),
    resolve(repoRoot, "scripts", "orchestrator.sh"),
    resolve(repoRoot, "orchestrator.sh"),
    resolve(process.cwd(), "orchestrator.sh"),
  ];

  const psCandidates = [
    resolve(configDir, "orchestrator.ps1"),
    resolve(configDir, "..", "orchestrator.ps1"),
    resolve(repoRoot, "scripts", "orchestrator.ps1"),
    resolve(repoRoot, "orchestrator.ps1"),
    resolve(process.cwd(), "orchestrator.ps1"),
  ];

  const candidates = preferShellScript
    ? [...shCandidates, ...psCandidates]
    : [...psCandidates, ...shCandidates];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return preferShellScript
    ? resolve(configDir, "..", "orchestrator.sh")
    : resolve(configDir, "..", "orchestrator.ps1");
}

// ── Exports ──────────────────────────────────────────────────────────────────

export {
  ExecutorScheduler,
  loadExecutorConfig,
  loadRepoConfig,
  loadAgentPrompts,
  parseEnvBoolean,
  getAgentPromptDefinitions,
  resolveAgentRepoRoot,
};
export default loadConfig;
