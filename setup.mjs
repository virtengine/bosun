#!/usr/bin/env node

/**
 * bosun — Setup Wizard
 *
 * Interactive CLI that configures bosun for a new or existing repository.
 * Handles:
 *   - Prerequisites validation
 *   - Environment file generation (.env + bosun.config.json)
 *   - Executor/model configuration (N executors with weights & failover)
 *   - Multi-repo setup (separate backend/frontend repos)
 *   - Prompt template scaffolding (.bosun/agents/*.md)
 *   - First-run auto-detection (launches automatically on virgin installs)
 *
 * Usage:
 *   bosun --setup              # interactive wizard
 *   bosun-setup                # same (bin alias)
 *   npx bosun setup
 *   node setup.mjs --non-interactive   # use env vars, skip prompts
 */

import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname, basename, relative, isAbsolute } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  readCodexConfig,
  getConfigPath,
  auditStreamTimeouts,
  ensureCodexConfig,
  printConfigSummary,
} from "./shell/codex-config.mjs";
import {
  ensureAgentPromptWorkspace,
  getAgentPromptDefinitions,
  PROMPT_WORKSPACE_DIR,
} from "./agent/agent-prompts.mjs";
import {
  buildHookScaffoldOptionsFromEnv,
  normalizeHookTargets,
  scaffoldAgentHookFiles,
} from "./agent/hook-profiles.mjs";
import { initLibrary } from "./infra/library-manager.mjs";
import { detectLegacySetup, applyAllCompatibility } from "./compat.mjs";
import { DEFAULT_MODEL_PROFILES } from "./task/task-complexity.mjs";
import { pullWorkspaceRepos, listWorkspaces } from "./workspace/workspace-manager.mjs";
import {
  discoverProviders,
  formatProvidersForMenu,
  formatModelsForMenu,
  buildExecutorEntry,
} from "./shell/opencode-providers.mjs";
import {
  listTemplates as listWorkflowTemplates,
  listWorkflowSetupProfiles,
  resolveWorkflowTemplateIds,
  normalizeTemplateOverridesById,
} from "./workflow/workflow-templates.mjs";
import { discoverTelegramChats } from "./telegram/get-telegram-chat-id.mjs";
import {
  buildLocalConnectionEntry,
  readRemoteConnectionConfig,
  saveRemoteConnectionConfig,
  setLocalConnectionConfig,
} from "./tui/lib/connection-target.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const isNonInteractive =
  process.argv.includes("--non-interactive") || process.argv.includes("-y");
const SETUP_TOTAL_STEPS = 9;

// ── Zero-dependency terminal styling (replaces chalk) ────────────────────────
const isTTY = process.stdout.isTTY;
const chalk = {
  bold: (s) => (isTTY ? `\x1b[1m${s}\x1b[22m` : s),
  dim: (s) => (isTTY ? `\x1b[2m${s}\x1b[22m` : s),
  cyan: (s) => (isTTY ? `\x1b[36m${s}\x1b[39m` : s),
  green: (s) => (isTTY ? `\x1b[32m${s}\x1b[39m` : s),
  yellow: (s) => (isTTY ? `\x1b[33m${s}\x1b[39m` : s),
  red: (s) => (isTTY ? `\x1b[31m${s}\x1b[39m` : s),
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function getVersion() {
  try {
    return JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8"))
      .version;
  } catch {
    return "0.0.0";
  }
}

function formatTelegramChatChoice(chat) {
  const parts = [String(chat.id)];
  if (chat.type) parts.push(chat.type);
  if (chat.username) parts.push(`@${chat.username}`);
  if (chat.title) parts.push(chat.title);
  return parts.join(" · ");
}

function hasSetupMarkers(dir) {
  const markers = [
    ".env",
    "bosun.config.json",
    ".bosun.json",
    "bosun.json",
  ];
  return markers.some((name) => existsSync(resolve(dir, name)));
}

function hasConfigFiles(dir) {
  const markers = [
    "bosun.config.json",
    ".bosun.json",
    "bosun.json",
  ];
  return markers.some((name) => existsSync(resolve(dir, name)));
}

function isPathInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolveConfigDir(_repoRoot) {
  // 1. Explicit env override
  const explicit = process.env.BOSUN_DIR;
  if (explicit) return resolve(explicit);

  // 2. Platform-aware user home directory — never write config into the
  //    bosun package directory (could be node_modules, wiped on npm install).
  const isWindows = process.platform === "win32";
  const baseDir = isWindows
    ? process.env.APPDATA ||
      process.env.LOCALAPPDATA ||
      process.env.USERPROFILE ||
      process.env.HOME ||
      homedir()
    : process.env.HOME ||
      process.env.XDG_CONFIG_HOME ||
      process.env.USERPROFILE ||
      homedir();
  return resolve(baseDir, "bosun");
}

function getSetupProgressPath(configDir) {
  return resolve(configDir || __dirname, ".setup-progress.json");
}

function readSetupProgress(configDir) {
  const progressPath = getSetupProgressPath(configDir);
  if (!existsSync(progressPath)) return null;
  try {
    const raw = readFileSync(progressPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeSetupProgress(configDir, data) {
  const progressPath = getSetupProgressPath(configDir);
  try {
    mkdirSync(dirname(progressPath), { recursive: true });
    writeFileSync(progressPath, JSON.stringify(data, null, 2) + "\n", "utf8");
    return progressPath;
  } catch {
    return "";
  }
}

/**
 * Save a snapshot of env and configJson alongside setup progress so the user
 * can resume where they left off if setup crashes or is interrupted.
 */
function writeSetupSnapshot(configDir, { step, label, env, configJson }) {
  writeSetupProgress(configDir, {
    status: "incomplete",
    step,
    total: SETUP_TOTAL_STEPS,
    label,
    updatedAt: new Date().toISOString(),
    snapshot: {
      env: env || {},
      configJson: configJson || {},
    },
  });
}

function clearSetupProgress(configDir) {
  const progressPath = getSetupProgressPath(configDir);
  if (!existsSync(progressPath)) return;
  try {
    rmSync(progressPath);
  } catch {
    /* ignore */
  }
}

function printBanner() {
  const ver = getVersion();
  const title = `Codex Monitor — Setup Wizard  v${ver}`;
  const pad = Math.max(0, 57 - title.length);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  console.log("");
  console.log(
    "  ╔═══════════════════════════════════════════════════════════════╗",
  );
  console.log(`  ║${" ".repeat(left + 3)}${title}${" ".repeat(right + 3)}║`);
  console.log(
    "  ╚═══════════════════════════════════════════════════════════════╝",
  );
  console.log("");
  console.log(
    chalk.dim("  This wizard will configure bosun for your project."),
  );
  console.log(
    chalk.dim("  Press Enter to accept defaults shown in [brackets]."),
  );
  console.log(
    chalk.dim("  Setup writes .env and config files at the end (cancel anytime to discard changes)."),
  );
  console.log("");
}

function heading(text) {
  const line = "\u2500".repeat(Math.max(0, 59 - text.length));
  console.log(`\n  ${chalk.bold(text)} ${chalk.dim(line)}\n`);
}

function headingStep(step, label, markProgress) {
  if (typeof markProgress === "function") {
    markProgress(step, label);
  }
  heading(`Step ${step} of ${SETUP_TOTAL_STEPS} — ${label}`);
}

function check(label, ok, hint) {
  const icon = ok ? ":check:" : ":close:";
  console.log(`  ${icon} ${label}`);
  if (!ok && hint) console.log(`     → ${hint}`);
  return ok;
}

function info(msg) {
  console.log(`  :help:  ${msg}`);
}

function success(msg) {
  console.log(`  :check: ${msg}`);
}

function warn(msg) {
  console.log(`  :alert:  ${msg}`);
}

function escapeTelegramHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function commandExists(cmd) {
  try {
    execSync(`${process.platform === "win32" ? "where" : "which"} ${cmd}`, {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function normalizeBaseUrl(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/+$/, "");
  }
  return `https://${trimmed.replace(/\/+$/, "")}`;
}

function openUrlInBrowser(url) {
  const target = String(url || "").trim();
  if (!target) return false;
  try {
    if (process.platform === "darwin") {
      const res = spawnSync("open", [target], { stdio: "ignore" });
      return res.status === 0;
    }
    if (process.platform === "win32") {
      const res = spawnSync("cmd", ["/c", "start", "", target], {
        stdio: "ignore",
        shell: false,
      });
      return res.status === 0;
    }
    if (commandExists("xdg-open")) {
      const res = spawnSync("xdg-open", [target], { stdio: "ignore" });
      return res.status === 0;
    }
    if (commandExists("gio")) {
      const res = spawnSync("gio", ["open", target], { stdio: "ignore" });
      return res.status === 0;
    }
  } catch {
    return false;
  }
  return false;
}

function buildJiraAuthHeaders(email, token) {
  const credentials = Buffer.from(`${email}:${token}`).toString("base64");
  return {
    Authorization: `Basic ${credentials}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function jiraRequest({ baseUrl, email, token, path, method = "GET", body }) {
  if (!baseUrl || !email || !token) {
    throw new Error("Jira credentials are missing");
  }
  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const response = await fetch(url, {
    method,
    headers: buildJiraAuthHeaders(email, token),
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!response || typeof response.status !== "number") {
    throw new Error(`Jira API ${method} ${path} failed: no HTTP response`);
  }
  if (response.status === 204) return null;
  const contentType = String(response.headers.get("content-type") || "");
  let payload = null;
  if (contentType.includes("application/json")) {
    payload = await response.json().catch(() => null);
  } else {
    payload = await response.text().catch(() => "");
  }
  if (!response.ok) {
    const message =
      payload?.errorMessages?.join("; ") ||
      (payload?.errors ? Object.values(payload.errors || {}).join("; ") : "");
    throw new Error(
      `Jira API ${method} ${path} failed (${response.status}): ${message || response.statusText || "Unknown error"}`,
    );
  }
  return payload;
}

async function listJiraProjects({ baseUrl, email, token }) {
  const projects = [];
  let startAt = 0;
  while (true) {
    const page = await jiraRequest({
      baseUrl,
      email,
      token,
      path: `/rest/api/3/project/search?startAt=${startAt}&maxResults=50&orderBy=name`,
    });
    const values = Array.isArray(page?.values) ? page.values : [];
    projects.push(...values);
    if (values.length === 0 || page?.isLast) break;
    startAt += values.length;
  }
  return projects.map((project) => ({
    key: String(project.key || project.id || "").trim(),
    name: project.name || project.key || "Unnamed Jira Project",
    id: String(project.id || project.key || ""),
  }));
}

async function listJiraIssueTypes({ baseUrl, email, token }) {
  const data = await jiraRequest({
    baseUrl,
    email,
    token,
    path: "/rest/api/3/issuetype",
  });
  return (Array.isArray(data) ? data : [])
    .map((entry) => ({
      id: String(entry?.id || ""),
      name: String(entry?.name || "").trim(),
      subtask: Boolean(entry?.subtask),
    }))
    .filter((entry) => entry.name);
}

async function listJiraFields({ baseUrl, email, token }) {
  const data = await jiraRequest({
    baseUrl,
    email,
    token,
    path: "/rest/api/3/field",
  });
  return (Array.isArray(data) ? data : [])
    .map((field) => ({
      id: String(field?.id || "").trim(),
      name: String(field?.name || "").trim(),
      custom: String(field?.id || "").startsWith("customfield_"),
    }))
    .filter((field) => field.id && field.name);
}

async function searchJiraUsers({ baseUrl, email, token, query }) {
  const data = await jiraRequest({
    baseUrl,
    email,
    token,
    path: `/rest/api/3/user/search?maxResults=20&query=${encodeURIComponent(
      String(query || "").trim(),
    )}`,
  });
  return (Array.isArray(data) ? data : []).map((user) => ({
    accountId: String(user?.accountId || ""),
    displayName: user?.displayName || "",
    emailAddress: user?.emailAddress || "",
  }));
}

function isSubtaskIssueType(issueType) {
  const name = String(issueType || "")
    .trim()
    .toLowerCase();
  return name.includes("subtask") || name.includes("sub-task");
}

export function getScriptRuntimePrerequisiteStatus(
  platform = process.platform,
  checker = commandExists,
) {
  const bundledPwsh = resolve(__dirname, ".cache", "bosun", "pwsh", "pwsh");
  const bundledPwshExists = existsSync(bundledPwsh);

  if (platform === "win32") {
    return {
      required: {
        label: "PowerShell (pwsh)",
        command: "pwsh",
        ok: checker("pwsh") || bundledPwshExists,
        hint: "Install: https://github.com/PowerShell/PowerShell",
      },
      optionalPwsh: null,
    };
  }

  return {
    required: {
      label: "bash",
      command: "bash",
      ok: checker("bash"),
      hint: "Install bash via your system package manager",
    },
    optionalPwsh: {
      label: "PowerShell (pwsh)",
      command: "pwsh",
      ok: checker("pwsh") || bundledPwshExists,
      hint: "Optional on macOS/Linux (needed only for .ps1 scripts)",
    },
  };
}

export function getDefaultOrchestratorScripts(
  platform = process.platform,
  baseDir = __dirname,
) {
  const variants = ["ps1", "sh"]
    .map((ext) => {
      const orchestratorPath = resolve(baseDir, `orchestrator.${ext}`);
      return {
        ext,
        orchestratorPath,
        available: existsSync(orchestratorPath),
      };
    })
    .filter((variant) => variant.available);

  const preferredExt = platform === "win32" ? "ps1" : "sh";
  const selectedDefault =
    variants.find((variant) => variant.ext === preferredExt) || variants[0] || null;

  return {
    preferredExt,
    variants,
    selectedDefault,
  };
}

export function formatOrchestratorScriptForEnv(
  scriptPath,
  configDir = __dirname,
) {
  const raw = String(scriptPath || "").trim();
  if (!raw) return "";

  const absolutePath = isAbsolute(raw) ? raw : resolve(configDir, raw);
  const relativePath = relative(configDir, absolutePath);
  if (!relativePath || relativePath === ".") {
    return `./${basename(absolutePath)}`.replace(/\\/g, "/");
  }

  if (isAbsolute(relativePath)) {
    return absolutePath.replace(/\\/g, "/");
  }

  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.startsWith(".") || normalized.startsWith("..")) {
    return normalized;
  }
  return `./${normalized}`;
}

export function resolveSetupOrchestratorDefaults({
  platform = process.platform,
  repoRoot = process.cwd(),
  configDir = __dirname,
  packageDir = __dirname,
} = {}) {
  const repoScriptDefaults = getDefaultOrchestratorScripts(
    platform,
    resolve(repoRoot, "scripts", "bosun"),
  );
  const packageScriptDefaults = getDefaultOrchestratorScripts(
    platform,
    packageDir,
  );
  const orchestratorDefaults =
    [repoScriptDefaults, packageScriptDefaults].find((defaults) =>
      defaults.variants.some(
        (variant) => variant.ext === defaults.preferredExt,
      ),
    ) ||
    [repoScriptDefaults, packageScriptDefaults].find(
      (defaults) => defaults.variants.length > 0,
    ) ||
    packageScriptDefaults;
  const selectedDefault = orchestratorDefaults.selectedDefault;

  return {
    repoScriptDefaults,
    packageScriptDefaults,
    orchestratorDefaults,
    selectedDefault,
    orchestratorScriptEnvValue: selectedDefault
      ? formatOrchestratorScriptForEnv(selectedDefault.orchestratorPath, configDir)
      : "",
  };
}

function parseEnvAssignmentLine(line) {
  const raw = String(line || "").trim();
  if (!raw || raw.startsWith("#")) return null;
  const normalized = raw.startsWith("export ") ? raw.slice(7).trim() : raw;
  const match = normalized.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!match) return null;
  const key = match[1];
  let value = match[2] ?? "";
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    const quote = value[0];
    value = value.slice(1, -1);
    if (quote === '"') {
      value = value
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
  } else {
    const hashIdx = value.indexOf("#");
    if (hashIdx >= 0) {
      value = value.slice(0, hashIdx).trimEnd();
    }
  }

  return { key, value };
}

export function applyEnvFileToProcess(envPath, options = {}) {
  const override = Boolean(options.override);
  const result = {
    path: envPath,
    found: false,
    loaded: 0,
    skipped: 0,
  };

  if (!envPath || !existsSync(envPath)) {
    return result;
  }

  result.found = true;
  const content = readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvAssignmentLine(line);
    if (!parsed) continue;
    if (!override && process.env[parsed.key] !== undefined) {
      result.skipped += 1;
      continue;
    }
    process.env[parsed.key] = parsed.value;
    result.loaded += 1;
  }

  return result;
}

/**
 * Check if a binary exists in the package's own node_modules/.bin/.
 * When installed globally, npm only symlinks the top-level package's bin
 * entries to the global path — transitive dependency binaries live here instead.
 */
function bundledBinExists(cmd) {
  const base = resolve(__dirname, "node_modules", ".bin", cmd);
  return existsSync(base) || existsSync(base + ".cmd");
}

function normalizeRepoSlug(owner, repo) {
  const cleanOwner = String(owner || "").trim();
  const cleanRepo = String(repo || "")
    .trim()
    .replace(/\.git$/i, "");
  if (!cleanOwner || !cleanRepo) return "";
  return `${cleanOwner}/${cleanRepo}`;
}

function parseRepoSlugFromUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";

  const directMatch = trimmed.match(
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/,
  );
  if (directMatch) {
    return normalizeRepoSlug(directMatch[1], directMatch[2]);
  }

  const scpMatch = trimmed.match(
    /^[^@]+@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/,
  );
  if (scpMatch) {
    return normalizeRepoSlug(scpMatch[1], scpMatch[2]);
  }

  const hostPathMatch = trimmed.match(
    /^[^:\/]+:([^/]+)\/([^/]+?)(?:\.git)?$/,
  );
  if (hostPathMatch) {
    return normalizeRepoSlug(hostPathMatch[1], hostPathMatch[2]);
  }

  let path = "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      path = parsed.pathname || "";
    } catch {
      const pathMatch = trimmed.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i);
      if (pathMatch) {
        path = `/${pathMatch[1]}`;
      }
    }
  }

  if (path) {
    const segments = path.split("/").filter(Boolean);
    if (segments.length >= 2) {
      const owner = segments[segments.length - 2];
      const repo = segments[segments.length - 1];
      return normalizeRepoSlug(owner, repo);
    }
  }

  return "";
}

function normalizeRepoKey(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  const parsed = parseRepoSlugFromUrl(trimmed);
  const normalized = parsed || trimmed;
  return normalized.trim().toLowerCase();
}

function buildWorkspaceChoices(configJson) {
  const choices = [];
  const seen = new Set();
  if (!Array.isArray(configJson?.workspaces)) return choices;
  for (const ws of configJson.workspaces) {
    const id = String(ws?.id || "").trim();
    const name = String(ws?.name || id || "").trim();
    const label = name || id;
    const key = String(id || name || "").trim();
    if (!key) continue;
    const normalized = key.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    choices.push({
      id: id || name,
      name,
      label,
      repos: Array.isArray(ws?.repos) ? ws.repos : [],
    });
  }
  return choices;
}

function findWorkspacePrimaryRepo(workspace) {
  const repos = Array.isArray(workspace?.repos) ? workspace.repos : [];
  return repos.find((repo) => repo?.primary) || repos[0] || null;
}

function detectRepoSlug(cwd) {
  try {
    const remote = execSync("git remote get-url origin", {
      encoding: "utf8",
      cwd: cwd || process.cwd(),
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    const parsed = parseRepoSlugFromUrl(remote);
    return parsed || null;
  } catch {
    return null;
  }
}

function detectRepoRemoteUrl(cwd) {
  try {
    return execSync("git remote get-url origin", {
      encoding: "utf8",
      cwd: cwd || process.cwd(),
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function detectRepoRoot(cwd) {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      cwd: cwd || process.cwd(),
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
  } catch {
    return cwd || process.cwd();
  }
}

function detectProjectName(repoRoot) {
  const pkgPath = resolve(repoRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg.name) return pkg.name.replace(/^@[^/]+\//, "");
    } catch {
      /* skip */
    }
  }
  return basename(repoRoot);
}

function hasSshKeyMaterial() {
  if (process.env.SSH_AUTH_SOCK) return true;
  const home = homedir();
  if (!home) return false;
  const candidates = [
    ".ssh/id_rsa.pub",
    ".ssh/id_ed25519.pub",
    ".ssh/id_ecdsa.pub",
    ".ssh/id_dsa.pub",
  ];
  return candidates.some((rel) => existsSync(resolve(home, rel)));
}

function isSshGitUrl(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  return text.startsWith("git@") || text.startsWith("ssh://");
}

function buildDefaultGitUrl(slug, repoRoot) {
  const normalizedSlug = String(slug || "").trim();
  if (!normalizedSlug) return "";
  const remote = detectRepoRemoteUrl(repoRoot);
  if (remote) return remote;
  const preferSsh = hasSshKeyMaterial();
  return preferSsh
    ? `git@github.com:${normalizedSlug}.git`
    : `https://github.com/${normalizedSlug}.git`;
}

function formatModelVariant(profile) {
  if (!profile?.model && !profile?.variant) return "";
  if (profile?.model && profile?.variant) {
    return `${profile.model} (${profile.variant})`;
  }
  return profile?.model || profile?.variant || "";
}

function printExecutorModelReference() {
  const codexProfiles = DEFAULT_MODEL_PROFILES?.CODEX || {};
  const copilotProfiles = DEFAULT_MODEL_PROFILES?.COPILOT || {};
  const codexLow = formatModelVariant(codexProfiles.low);
  const codexMed = formatModelVariant(codexProfiles.medium);
  const codexHigh = formatModelVariant(codexProfiles.high);
  const copilotLow = formatModelVariant(copilotProfiles.low);
  const copilotMed = formatModelVariant(copilotProfiles.medium);
  const copilotHigh = formatModelVariant(copilotProfiles.high);

  console.log(chalk.dim("  Default model/variant reference (model → variant):"));
  if (codexLow || codexMed || codexHigh) {
    console.log(
      chalk.dim(
        `    CODEX: ${[codexLow, codexMed, codexHigh].filter(Boolean).join(" · ")}`,
      ),
    );
  }
  if (copilotLow || copilotMed || copilotHigh) {
    console.log(
      chalk.dim(
        `    COPILOT (Claude): ${[copilotLow, copilotMed, copilotHigh].filter(Boolean).join(" · ")}`,
      ),
    );
  }
  console.log(
    chalk.dim(
      "  Variants are the tokens used in EXECUTORS/config (ex: CODEX:DEFAULT, COPILOT:CLAUDE_OPUS_4_6).",
    ),
  );
  console.log(
    chalk.dim(
      "  Model names are used for overrides (ex: CODEX → gpt-5.2-codex, COPILOT → opus-4.6).",
    ),
  );
  console.log(
    chalk.dim(
      "  Copilot GPT variants (if used) follow tokens like GPT_4_1; Claude variants are CLAUDE_*.",
    ),
  );
  console.log();
}

function buildRepositoryChoices(configJson, repoRoot, options = {}) {
  const choices = [];
  const seen = new Set();
  const workspaceSlugs = new Set();
  const workspaceFilter = String(options.workspaceId || "")
    .trim()
    .toLowerCase();
  const includeWorkspacePrefix = options.includeWorkspacePrefix !== false;

  const recordWorkspaceRepo = (repo) => {
    if (!repo) return;
    const slugKey = normalizeRepoKey(repo.slug);
    const nameKey = normalizeRepoKey(repo.name);
    if (slugKey) workspaceSlugs.add(slugKey);
    if (nameKey) workspaceSlugs.add(nameKey);
  };

  const pushChoice = (input) => {
    if (!input) return;
    const name = String(input.name || "").trim();
    const slug = String(input.slug || "").trim();
    const workspace = String(input.workspace || input.workspaceId || "").trim();
    if (!name && !slug) return;
    const key = normalizeRepoKey(slug || name);
    if (!key) return;
    const normalizedWorkspace = workspace.toLowerCase();
    const seenKey = `${normalizedWorkspace}:${key}`;
    if (seen.has(seenKey)) return;
    seen.add(seenKey);
    const labelParts = [];
    if (workspace && includeWorkspacePrefix) labelParts.push(`ws:${workspace}`);
    labelParts.push(name || slug);
    if (slug && name && slug !== name) labelParts.push(`(${slug})`);
    const label = labelParts.join(" ");
    choices.push({
      label,
      name,
      slug,
      workspace,
      value: slug || name,
    });
  };

  if (Array.isArray(configJson?.workspaces)) {
    for (const ws of configJson.workspaces) {
      const wsId = String(ws?.id || "").trim();
      const wsName = String(ws?.name || wsId || "").trim();
      const wsLabel = wsName || wsId;
      const wsKey = String(wsId || wsName || "").trim().toLowerCase();
      if (workspaceFilter && wsKey !== workspaceFilter) continue;
      for (const repo of ws?.repos || []) {
        recordWorkspaceRepo(repo);
        pushChoice({
          name: repo?.name,
          slug: repo?.slug,
          workspace: wsLabel,
        });
      }
    }
  }

  // Only add standalone repos that aren't already covered by a workspace
  if (!workspaceFilter && Array.isArray(configJson?.repositories)) {
    for (const repo of configJson.repositories) {
      const slugKey = normalizeRepoKey(repo?.slug);
      const nameKey = normalizeRepoKey(repo?.name);
      if ((slugKey && workspaceSlugs.has(slugKey)) || (nameKey && workspaceSlugs.has(nameKey))) {
        continue;
      }
      pushChoice(repo);
    }
  }

  if (choices.length === 0 && repoRoot) {
    pushChoice({ name: basename(repoRoot) });
  }

  return choices;
}

function defaultVariantForExecutor(executor) {
  const normalized = String(executor || "").trim().toUpperCase();
  if (normalized === "CODEX") return "DEFAULT";
  if (normalized === "COPILOT" || normalized === "CLAUDE") {
    return "CLAUDE_OPUS_4_6";
  }
  if (normalized === "GEMINI") return "DEFAULT";
  return "DEFAULT";
}

function runGhCommand(args, cwd) {
  const normalizedArgs = Array.isArray(args)
    ? args.map((entry) => String(entry))
    : [];
  const output = execFileSync("gh", normalizedArgs, {
    encoding: "utf8",
    cwd: cwd || process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return String(output || "").trim();
}

function formatGhErrorReason(err) {
  if (!err) return "";
  const stderr = String(err.stderr || "").trim();
  const stdout = String(err.stdout || "").trim();
  const message = String(err.message || "").trim();
  return stderr || stdout || message;
}

function detectGitHubUserLogin(cwd) {
  try {
    return runGhCommand(["api", "user", "--jq", ".login"], cwd);
  } catch {
    return "";
  }
}

function getGitHubAuthStatus(cwd) {
  if (!commandExists("gh")) {
    return { ok: false, reason: "gh CLI not found" };
  }
  const login = detectGitHubUserLogin(cwd);
  if (login) {
    return { ok: true, login };
  }
  return { ok: false, reason: "gh auth required" };
}

function getGitHubAuthScopes(cwd) {
  if (!commandExists("gh")) return [];
  try {
    const output = execSync("gh auth status --hostname github.com 2>&1", {
      encoding: "utf8",
      cwd: cwd || process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 3000,
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: "1",
      },
    });
    const line = String(output || "")
      .split(/\r?\n/)
      .find((entry) => entry.toLowerCase().includes("token scopes"));
    if (!line) return [];
    const scopesText = line.split(":").slice(1).join(":");
    return scopesText
      .split(",")
      .map((scope) => String(scope || "").trim().replace(/^['"\s]+|['"\s]+$/g, ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function tryRunGhCommand(args, cwd) {
  try {
    return { ok: true, output: runGhCommand(args, cwd), error: "" };
  } catch (err) {
    return { ok: false, output: "", error: formatGhErrorReason(err) };
  }
}

function collectProjectCandidates(node, out) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const item of node) collectProjectCandidates(item, out);
    return;
  }
  if (typeof node !== "object") return;

  if (
    Object.prototype.hasOwnProperty.call(node, "title") ||
    Object.prototype.hasOwnProperty.call(node, "number") ||
    Object.prototype.hasOwnProperty.call(node, "url") ||
    Object.prototype.hasOwnProperty.call(node, "projectNumber")
  ) {
    out.push(node);
  }

  for (const value of Object.values(node)) {
    if (value && (Array.isArray(value) || typeof value === "object")) {
      collectProjectCandidates(value, out);
    }
  }
}

function parseGitHubProjectList(rawOutput) {
  const rawText = String(rawOutput || "").trim();
  if (!rawText) return [];

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return [];
  }

  const candidates = [];
  collectProjectCandidates(parsed, candidates);
  return candidates;
}

function extractProjectNumberFromText(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\d+$/.test(text)) return text;

  const lower = text.toLowerCase();
  const scanAfter = (marker) => {
    const idx = lower.indexOf(marker);
    if (idx === -1) return "";
    const tail = text.slice(idx + marker.length);
    const match = tail.match(/\d+/);
    return match ? match[0] : "";
  };

  const candidates = [
    scanAfter("/projects/"),
    scanAfter("/projects/v2/"),
    scanAfter("project number"),
    scanAfter("project id"),
    scanAfter("project"),
    scanAfter("number"),
  ].filter(Boolean);

  if (candidates.length > 0) return candidates[0];
  if (/project/i.test(text)) {
    const fallback = text.match(/\b(\d+)\b/);
    if (fallback && fallback[1]) return fallback[1];
  }
  return "";
}

function extractProjectNumber(value) {
  if (value === null || value === undefined) return "";

  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.trunc(value);
    return normalized > 0 ? String(normalized) : "";
  }

  if (typeof value === "string") {
    return extractProjectNumberFromText(value);
  }

  if (typeof value === "object") {
    const keys = [
      "number",
      "projectNumber",
      "project_number",
      "url",
      "resourcePath",
      "html_url",
      "id",
      "text",
      "message",
    ];
    for (const key of keys) {
      const nested = extractProjectNumber(value?.[key]);
      if (nested) return nested;
    }
    return extractProjectNumberFromText(JSON.stringify(value));
  }

  return "";
}

function resolveOrCreateGitHubProject({
  owner,
  title,
  cwd,
  repoOwner,
  githubLogin,
  runCommand = runGhCommand,
}) {
  const normalizedOwner = String(owner || "").trim();
  const normalizedRepoOwner = String(repoOwner || "").trim();
  const normalizedGithubLogin = String(githubLogin || "").trim();
  const normalizedTitle = String(title || "").trim();
  if (!normalizedTitle) {
    return {
      number: "",
      owner: "",
      reason: "missing GitHub Project title",
    };
  }

  const ownerCandidates = [];
  for (const candidate of [
    normalizedOwner,
    normalizedGithubLogin,
    normalizedRepoOwner,
  ]) {
    if (!candidate) continue;
    if (!ownerCandidates.includes(candidate)) ownerCandidates.push(candidate);
  }

  if (ownerCandidates.length === 0) {
    return {
      number: "",
      owner: "",
      reason: "missing GitHub Project owner",
    };
  }

  const reasons = [];
  const normalizedTitleLower = normalizedTitle.toLowerCase();

  for (const candidateOwner of ownerCandidates) {
    let listFailed = false;
    let hadListProjects = false;

    try {
      const listRaw = runCommand(
        ["project", "list", "--owner", candidateOwner, "--format", "json"],
        cwd,
      );
      const projects = parseGitHubProjectList(listRaw);
      hadListProjects = projects.length > 0;

      const existing = projects.find(
        (project) =>
          String(project?.title || "")
            .trim()
            .toLowerCase() === normalizedTitleLower,
      );
      const existingNumber = extractProjectNumber(existing);
      if (existingNumber) {
        return {
          number: existingNumber,
          owner: candidateOwner,
          reason: "",
        };
      }
    } catch (err) {
      listFailed = true;
      const reason = formatGhErrorReason(err);
      reasons.push(
        reason
          ? `list failed for owner '${candidateOwner}': ${reason}`
          : `list failed for owner '${candidateOwner}'`,
      );
    }

    try {
      const createRaw = runCommand(
        [
          "project",
          "create",
          "--owner",
          candidateOwner,
          "--title",
          normalizedTitle,
        ],
        cwd,
      );
      const createdNumber = extractProjectNumber(createRaw);
      if (createdNumber) {
        return {
          number: createdNumber,
          owner: candidateOwner,
          reason: "",
        };
      }

      reasons.push(
        `create returned no project number for owner '${candidateOwner}'`,
      );
    } catch (err) {
      const reason = formatGhErrorReason(err);
      const context = listFailed
        ? "list+create"
        : hadListProjects
          ? "create"
          : "create";
      reasons.push(
        reason
          ? `${context} failed for owner '${candidateOwner}': ${reason}`
          : `${context} failed for owner '${candidateOwner}'`,
      );
    }
  }

  return {
    number: "",
    owner: ownerCandidates[0] || "",
    reason:
      reasons.find(Boolean) ||
      "no matching project found and project creation failed",
  };
}

function resolveOrCreateGitHubProjectNumber(options) {
  return resolveOrCreateGitHubProject(options).number;
}

const DEFAULT_GITHUB_PROJECT_STATUSES = {
  todo: "Todo",
  inprogress: "In Progress",
  inreview: "In Review",
  done: "Done",
  cancelled: "Cancelled",
};

const PROJECT_STATUS_ALIASES = {
  todo: ["todo", "to do", "backlog", "queued"],
  inprogress: ["in progress", "in-progress", "doing", "active"],
  inreview: ["in review", "review", "needs review", "ready for review"],
  done: ["done", "complete", "completed", "closed"],
  cancelled: ["cancelled", "canceled", "abandoned", "wontfix", "won't fix"],
};

function normalizeStatusOption(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getGitHubProjectFields({ owner, number, cwd, runCommand = runGhCommand }) {
  if (!owner || !number) return [];
  try {
    const raw = runCommand(
      ["project", "field-list", String(number), "--owner", owner, "--format", "json"],
      cwd,
    );
    const parsed = JSON.parse(String(raw || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function resolveProjectStatusMapping(statusOptions = []) {
  const normalizedOptions = statusOptions
    .map((opt) => ({
      name: String(opt?.name || "").trim(),
      norm: normalizeStatusOption(opt?.name || ""),
    }))
    .filter((opt) => opt.name && opt.norm);

  const findOption = (candidates) => {
    for (const candidate of candidates) {
      const normCandidate = normalizeStatusOption(candidate);
      const found = normalizedOptions.find((opt) => opt.norm === normCandidate);
      if (found) return found.name;
    }
    return "";
  };

  const mapping = {};
  for (const [key, aliases] of Object.entries(PROJECT_STATUS_ALIASES)) {
    const desired = DEFAULT_GITHUB_PROJECT_STATUSES[key];
    const candidates = [desired, ...aliases];
    mapping[key] = findOption(candidates);
  }

  const fallbacks = [];
  if (!mapping.inreview && mapping.inprogress) {
    mapping.inreview = mapping.inprogress;
    fallbacks.push({ key: "inreview", value: mapping.inprogress });
  }
  if (!mapping.cancelled && mapping.done) {
    mapping.cancelled = mapping.done;
    fallbacks.push({ key: "cancelled", value: mapping.done });
  }

  const missing = Object.entries(mapping)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  return { mapping, missing, fallbacks };
}

function getDefaultPromptOverrides() {
  const entries = getAgentPromptDefinitions().map((def) => [
    def.key,
    `${PROMPT_WORKSPACE_DIR}/${def.filename}`,
  ]);
  return Object.fromEntries(entries);
}

function ensureRepoGitIgnoreEntry(repoRoot, entry) {
  const gitignorePath = resolve(repoRoot, ".gitignore");
  const normalizedEntry = String(entry || "").trim();
  if (!normalizedEntry) return false;

  let existing = "";
  if (existsSync(gitignorePath)) {
    existing = readFileSync(gitignorePath, "utf8");
  }

  const hasEntry = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .includes(normalizedEntry);
  if (hasEntry) return false;

  const next =
    existing.endsWith("\n") || !existing ? existing : `${existing}\n`;
  writeFileSync(gitignorePath, `${next}${normalizedEntry}\n`, "utf8");
  return true;
}

function buildRecommendedVsCodeSettings(env = {}) {
  const maxRequests = Math.max(
    50,
    Number(env.COPILOT_AGENT_MAX_REQUESTS || process.env.COPILOT_AGENT_MAX_REQUESTS || 500),
  );

  return {
    "github.copilot.chat.searchSubagent.enabled": true,
    "github.copilot.chat.switchAgent.enabled": true,
    "github.copilot.chat.cli.customAgents.enabled": true,
    "github.copilot.chat.cli.mcp.enabled": true,
    "github.copilot.chat.agent.enabled": true,
    "github.copilot.chat.agent.maxRequests": maxRequests,
    "github.copilot.chat.thinking.collapsedTools": "withThinking",
    "github.copilot.chat.thinking.generateTitles": true,
    "github.copilot.chat.confirmEditRequestRemoval": false,
    "github.copilot.chat.confirmRetryRequestRemoval": false,
    "github.copilot.chat.terminal.enableAutoApprove": true,
    "github.copilot.chat.terminal.autoReplyToPrompts": true,
    "github.copilot.chat.tools.autoApprove": true,
    "github.copilot.chat.tools.runSubagent.enabled": true,
    "github.copilot.chat.tools.searchSubagent.enabled": true,
  };
}

function mergePlainObjects(base, updates) {
  const out = { ...(base || {}) };
  for (const [key, value] of Object.entries(updates || {})) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      out[key] &&
      typeof out[key] === "object" &&
      !Array.isArray(out[key])
    ) {
      out[key] = mergePlainObjects(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function writeWorkspaceVsCodeSettings(repoRoot, env) {
  try {
    const vscodeDir = resolve(repoRoot, ".vscode");
    const settingsPath = resolve(vscodeDir, "settings.json");
    mkdirSync(vscodeDir, { recursive: true });

    let existing = {};
    if (existsSync(settingsPath)) {
      try {
        existing = JSON.parse(readFileSync(settingsPath, "utf8"));
      } catch {
        existing = {};
      }
    }

    const recommended = buildRecommendedVsCodeSettings(env);
    const merged = mergePlainObjects(existing, recommended);
    writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
    return { path: settingsPath, updated: true };
  } catch (err) {
    return { path: null, updated: false, error: err.message };
  }
}

function buildRecommendedCopilotMcpServers() {
  return {
    context7: {
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
    },
    "sequential-thinking": {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    },
    playwright: {
      command: "npx",
      args: ["-y", "@playwright/mcp@latest"],
    },
    "microsoft-docs": {
      url: "https://learn.microsoft.com/api/mcp",
    },
  };
}

function writeWorkspaceCopilotMcpConfig(repoRoot) {
  try {
    const vscodeDir = resolve(repoRoot, ".vscode");
    const mcpPath = resolve(vscodeDir, "mcp.json");
    mkdirSync(vscodeDir, { recursive: true });

    let existing = {};
    if (existsSync(mcpPath)) {
      try {
        existing = JSON.parse(readFileSync(mcpPath, "utf8"));
      } catch {
        existing = {};
      }
    }

    const existingServers =
      existing.mcpServers ||
      existing["github.copilot.mcpServers"] ||
      existing;

    const recommended = buildRecommendedCopilotMcpServers();
    const mergedServers = {
      ...recommended,
      ...(typeof existingServers === "object" ? existingServers : {}),
    };

    const next = { mcpServers: mergedServers };
    writeFileSync(mcpPath, JSON.stringify(next, null, 2) + "\n", "utf8");
    return { path: mcpPath, updated: true };
  } catch (err) {
    return { path: null, updated: false, error: err.message };
  }
}

function parseHookCommandInput(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) return null;
  const lowered = raw.toLowerCase();
  if (["none", "off", "disable", "disabled"].includes(lowered)) {
    return [];
  }
  return raw
    .split(/\s*;;\s*|\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function printHookScaffoldSummary(result) {
  if (!result || !result.enabled) {
    info("Agent hook scaffolding disabled.");
    return;
  }

  const totalChanged = result.written.length + result.updated.length;
  if (totalChanged > 0) {
    success(`Configured ${totalChanged} agent hook file(s).`);
  } else {
    info("Agent hook files already existed — no file changes needed.");
  }

  if (result.written.length > 0) {
    for (const path of result.written) {
      console.log(`    + ${path}`);
    }
  }
  if (result.updated.length > 0) {
    for (const path of result.updated) {
      console.log(`    ~ ${path}`);
    }
  }
  if (result.skipped.length > 0) {
    for (const path of result.skipped) {
      console.log(`    = ${path} (kept existing)`);
    }
  }
  if (result.warnings.length > 0) {
    for (const warning of result.warnings) {
      warn(warning);
    }
  }
}

// ── Prompt System ────────────────────────────────────────────────────────────

function createPrompt() {
  // Fix for Windows PowerShell readline issues
  // Only use terminal mode if stdin is actually a TTY
  // This prevents both double-echo and output duplication
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY && process.stdout.isTTY,
  });

  return {
    ask(question, defaultValue) {
      return new Promise((res) => {
        const suffix = defaultValue ? ` [${defaultValue}]` : "";
        rl.question(`  ${question}${suffix}: `, (answer) => {
          res(answer.trim() || defaultValue || "");
        });
      });
    },
    confirm(question, defaultYes = true) {
      return new Promise((res) => {
        const hint = defaultYes ? "[Y/n]" : "[y/N]";
        rl.question(`  ${question} ${hint}: `, (answer) => {
          const a = answer.trim().toLowerCase();
          if (!a) res(defaultYes);
          else res(a === "y" || a === "yes");
        });
      });
    },
    choose(question, options, defaultIdx = 0) {
      return new Promise((res) => {
        console.log(`  ${question}`);
        options.forEach((opt, i) => {
          const marker = i === defaultIdx ? "→" : " ";
          console.log(`  ${marker} ${i + 1}) ${opt}`);
        });
        rl.question(`  Choice [${defaultIdx + 1}]: `, (answer) => {
          const idx = answer.trim() ? Number(answer.trim()) - 1 : defaultIdx;
          res(Math.max(0, Math.min(idx, options.length - 1)));
        });
      });
    },
    close() {
      rl.close();
    },
  };
}

// ── Executor Templates ───────────────────────────────────────────────────────

const EXECUTOR_PRESETS = {
  "copilot-codex": [
    {
      name: "copilot-claude",
      executor: "COPILOT",
      variant: "CLAUDE_OPUS_4_6",
      weight: 50,
      role: "primary",
    },
    {
      name: "codex-default",
      executor: "CODEX",
      variant: "DEFAULT",
      weight: 50,
      role: "backup",
    },
  ],
  "copilot-only": [
    {
      name: "copilot-claude",
      executor: "COPILOT",
      variant: "CLAUDE_OPUS_4_6",
      weight: 100,
      role: "primary",
    },
  ],
  "codex-only": [
    {
      name: "codex-default",
      executor: "CODEX",
      variant: "DEFAULT",
      weight: 100,
      role: "primary",
    },
  ],
  "claude-only": [
    {
      name: "claude-default",
      executor: "CLAUDE",
      variant: "CLAUDE_OPUS_4",
      weight: 100,
      role: "primary",
    },
  ],
  "gemini-only": [
    {
      name: "gemini-default",
      executor: "GEMINI",
      variant: "DEFAULT",
      weight: 100,
      role: "primary",
    },
  ],
  "gemini-codex": [
    {
      name: "gemini-default",
      executor: "GEMINI",
      variant: "DEFAULT",
      weight: 60,
      role: "primary",
    },
    {
      name: "codex-backup",
      executor: "CODEX",
      variant: "DEFAULT",
      weight: 40,
      role: "backup",
    },
  ],
  "opencode-only": [
    {
      name: "opencode-default",
      executor: "OPENCODE",
      variant: "DEFAULT",
      weight: 100,
      role: "primary",
    },
  ],
  "opencode-codex": [
    {
      name: "opencode-default",
      executor: "OPENCODE",
      variant: "DEFAULT",
      weight: 60,
      role: "primary",
    },
    {
      name: "codex-backup",
      executor: "CODEX",
      variant: "DEFAULT",
      weight: 40,
      role: "backup",
    },
  ],
  // OpenCode provider-specific presets are built dynamically via opencode-providers.mjs.
  // The "opencode-choose-provider" preset key in Step 4 triggers live provider discovery.
  // Users can also manually create provider executors in bosun.config.json:
  //   { "executor": "OPENCODE", "provider": "anthropic", "providerConfig": { "model": "anthropic/claude-sonnet-4-20250514" } }
  triple: [
    {
      name: "copilot-claude",
      executor: "COPILOT",
      variant: "CLAUDE_OPUS_4_6",
      weight: 40,
      role: "primary",
    },
    {
      name: "codex-default",
      executor: "CODEX",
      variant: "DEFAULT",
      weight: 35,
      role: "backup",
    },
    {
      name: "copilot-gpt",
      executor: "COPILOT",
      variant: "GPT_4_1",
      weight: 25,
      role: "tertiary",
    },
  ],
};

const FAILOVER_STRATEGIES = [
  {
    name: "next-in-line",
    desc: "Use the next executor by role priority (primary → backup → tertiary)",
  },
  {
    name: "weighted-random",
    desc: "Randomly select from remaining executors by weight",
  },
  { name: "round-robin", desc: "Cycle through remaining executors evenly" },
];

const DISTRIBUTION_MODES = [
  {
    name: "weighted",
    desc: "Distribute tasks by configured weight percentages",
  },
  { name: "round-robin", desc: "Alternate between executors equally" },
  {
    name: "primary-only",
    desc: "Always use primary; others only for failover",
  },
];

const SETUP_PROFILES = [
  {
    key: "recommended",
    label: "Recommended — configure important choices, keep safe defaults",
  },
  {
    key: "advanced",
    label: "Advanced — full control over all setup options",
  },
];

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.round(n);
}

function normalizeEnum(value, allowed, fallback) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function parseBooleanEnvValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on", "y"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off", "n"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizeWorkflowTemplateIdList(rawValue, fallback = []) {
  const source = Array.isArray(rawValue)
    ? rawValue
    : String(rawValue || "").split(",");
  const validIds = new Set(listWorkflowTemplates().map((template) => String(template?.id || "").trim()).filter(Boolean));
  const normalized = [];
  for (const entry of source) {
    const id = String(entry || "").trim();
    if (!id || !validIds.has(id) || normalized.includes(id)) continue;
    normalized.push(id);
  }
  return normalized.length > 0 ? normalized : [...fallback];
}

async function promptForWorkflowTemplateOverrides(prompt, templateIds = [], existingOverrides = {}) {
  const templates = listWorkflowTemplates();
  const templateLookup = new Map(templates.map((template) => [String(template?.id || ""), template]));
  const normalized = {};

  for (const templateId of templateIds) {
    const template = templateLookup.get(String(templateId || ""));
    if (!template) continue;
    const variables = Array.isArray(template.variables) ? template.variables : [];
    if (variables.length === 0) continue;

    const configureTemplate = await prompt.confirm(
      `Customize variables for ${template.name}?`,
      false,
    );
    if (!configureTemplate) {
      continue;
    }

    info(`Configuring ${template.name}`);
    const nextOverrides = {};
    for (const variable of variables) {
      const key = String(variable?.key || "").trim();
      if (!key) continue;
      const existing = existingOverrides?.[templateId]?.[key];
      const defaultValue = existing ?? variable?.defaultValue ?? "";
      const label = `${key}${variable?.required ? " (required)" : ""}`;
      if (variable?.type === "toggle") {
        nextOverrides[key] = await prompt.confirm(label, Boolean(defaultValue));
        continue;
      }
      const answer = await prompt.ask(label, defaultValue == null ? "" : String(defaultValue));
      nextOverrides[key] = variable?.type === "number"
        ? (answer === "" ? "" : Number(answer))
        : answer;
    }
    if (Object.keys(nextOverrides).length > 0) {
      normalized[templateId] = nextOverrides;
    }
  }

  return normalizeTemplateOverridesById(normalized, templateIds);
}

function toBooleanEnvString(value, fallback = false) {
  return parseBooleanEnvValue(value, fallback) ? "true" : "false";
}

const DEFAULT_TELEGRAM_UI_PORT = 3080;

function normalizeTelegramUiPort(rawValue, fallback = DEFAULT_TELEGRAM_UI_PORT) {
  const parsed = Number(String(rawValue || "").trim());
  if (Number.isFinite(parsed) && parsed > 0) {
    return String(Math.round(parsed));
  }
  return String(fallback);
}

function applyTelegramMiniAppDefaults(env, sourceEnv = process.env) {
  const telegramToken = String(
    env.TELEGRAM_BOT_TOKEN || sourceEnv.TELEGRAM_BOT_TOKEN || "",
  ).trim();
  if (!telegramToken) return false;

  const miniAppRaw = env.TELEGRAM_MINIAPP_ENABLED;
  if (
    miniAppRaw === undefined ||
    miniAppRaw === null ||
    String(miniAppRaw).trim() === ""
  ) {
    env.TELEGRAM_MINIAPP_ENABLED = "true";
  } else {
    env.TELEGRAM_MINIAPP_ENABLED = toBooleanEnvString(miniAppRaw, true);
  }

  env.TELEGRAM_UI_PORT = normalizeTelegramUiPort(
    env.TELEGRAM_UI_PORT || sourceEnv.TELEGRAM_UI_PORT,
  );

  // Default tunnel mode: if named tunnel credentials are present, use "named";
  // otherwise fall back to "quick" so the UI works out-of-the-box without setup.
  if (!env.TELEGRAM_UI_TUNNEL && !sourceEnv.TELEGRAM_UI_TUNNEL) {
    const hasNamedCreds = !!(
      (env.CLOUDFLARE_TUNNEL_NAME || sourceEnv.CLOUDFLARE_TUNNEL_NAME) &&
      (env.CLOUDFLARE_TUNNEL_CREDENTIALS || sourceEnv.CLOUDFLARE_TUNNEL_CREDENTIALS)
    );
    env.TELEGRAM_UI_TUNNEL = hasNamedCreds ? "named" : "quick";
  }
  if (!env.TELEGRAM_UI_ALLOW_UNSAFE && !sourceEnv.TELEGRAM_UI_ALLOW_UNSAFE) {
    env.TELEGRAM_UI_ALLOW_UNSAFE = "false";
  }
  if (
    !env.TELEGRAM_UI_ALLOW_QUICK_TUNNEL_FALLBACK
    && !sourceEnv.TELEGRAM_UI_ALLOW_QUICK_TUNNEL_FALLBACK
  ) {
    // Allow quick tunnel as fallback by default so named-tunnel failures don't
    // silently kill the UI. Users who explicitly set "named" during --setup will
    // have this set to "false" by the wizard if credentials were provided.
    env.TELEGRAM_UI_ALLOW_QUICK_TUNNEL_FALLBACK = "true";
  }
  if (
    !env.TELEGRAM_UI_FALLBACK_AUTH_ENABLED
    && !sourceEnv.TELEGRAM_UI_FALLBACK_AUTH_ENABLED
  ) {
    env.TELEGRAM_UI_FALLBACK_AUTH_ENABLED = "true";
  }
  if (
    !env.CLOUDFLARE_USERNAME_HOSTNAME_POLICY
    && !sourceEnv.CLOUDFLARE_USERNAME_HOSTNAME_POLICY
  ) {
    env.CLOUDFLARE_USERNAME_HOSTNAME_POLICY = "per-user-fixed";
  }
  return true;
}

function readProcValue(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function hasBwrapBinary() {
  if (process.platform !== "linux") return false;
  try {
    execSync("bwrap --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function detectBwrapSupport() {
  if (process.platform !== "linux") return false;
  const unpriv = readProcValue("/proc/sys/kernel/unprivileged_userns_clone");
  if (unpriv === "0") return false;
  const maxUserNs = readProcValue("/proc/sys/user/max_user_namespaces");
  if (maxUserNs && Number(maxUserNs) === 0) return false;
  return hasBwrapBinary();
}

function buildDefaultWritableRoots(repoRoot) {
  if (!repoRoot) return "";
  const roots = new Set();
  const repo = String(repoRoot);
  if (repo) {
    const parent = dirname(repo);
    if (parent && parent !== repo) roots.add(parent);
    roots.add(repo);
    roots.add(resolve(repo, ".git"));
    // Worktree checkout paths (used by task-executor)
    roots.add(resolve(repo, ".cache", "worktrees"));
    // Cache directories for agent work logs, build artifacts, etc.
    roots.add(resolve(repo, ".cache"));
  }
  // /tmp needed for sandbox temp files, pip installs, etc.
  roots.add("/tmp");
  return Array.from(roots).join(",");
}

function normalizeSetupConfiguration({
  env,
  configJson,
  repoRoot,
  slug,
  configDir,
}) {
  env.PROJECT_NAME =
    env.PROJECT_NAME || configJson.projectName || basename(repoRoot);
  env.REPO_ROOT = env.REPO_ROOT || repoRoot;
  env.GITHUB_REPO = env.GITHUB_REPO || slug || "";

  env.MAX_PARALLEL = String(toPositiveInt(env.MAX_PARALLEL || "6", 6));
  env.TELEGRAM_INTERVAL_MIN = String(
    toPositiveInt(env.TELEGRAM_INTERVAL_MIN || "10", 10),
  );
  applyTelegramMiniAppDefaults(env, process.env);

  env.KANBAN_BACKEND = normalizeEnum(
    env.KANBAN_BACKEND,
    ["internal", "github", "jira"],
    "internal",
  );
  env.KANBAN_SYNC_POLICY = normalizeEnum(
    env.KANBAN_SYNC_POLICY,
    ["internal-primary", "bidirectional"],
    "internal-primary",
  );
  env.PROJECT_REQUIREMENTS_PROFILE = normalizeEnum(
    env.PROJECT_REQUIREMENTS_PROFILE,
    [
      "simple-feature",
      "feature",
      "large-feature",
      "system",
      "multi-system",
    ],
    "feature",
  );
  env.INTERNAL_EXECUTOR_REPLENISH_ENABLED = toBooleanEnvString(
    env.INTERNAL_EXECUTOR_REPLENISH_ENABLED,
    false,
  );
  env.INTERNAL_EXECUTOR_REPLENISH_MIN_NEW_TASKS = String(
    toPositiveInt(env.INTERNAL_EXECUTOR_REPLENISH_MIN_NEW_TASKS, 1),
  );
  env.INTERNAL_EXECUTOR_REPLENISH_MAX_NEW_TASKS = String(
    toPositiveInt(env.INTERNAL_EXECUTOR_REPLENISH_MAX_NEW_TASKS, 2),
  );
  env.COPILOT_NO_EXPERIMENTAL = toBooleanEnvString(
    env.COPILOT_NO_EXPERIMENTAL,
    false,
  );
  env.COPILOT_NO_ALLOW_ALL = toBooleanEnvString(
    env.COPILOT_NO_ALLOW_ALL,
    false,
  );
  env.COPILOT_ENABLE_ASK_USER = toBooleanEnvString(
    env.COPILOT_ENABLE_ASK_USER,
    false,
  );
  env.COPILOT_ENABLE_ALL_GITHUB_MCP_TOOLS = toBooleanEnvString(
    env.COPILOT_ENABLE_ALL_GITHUB_MCP_TOOLS,
    false,
  );
  env.COPILOT_AGENT_MAX_REQUESTS = String(
    toPositiveInt(env.COPILOT_AGENT_MAX_REQUESTS || 500, 500),
  );
  env.WORKFLOW_AUTOMATION_ENABLED = toBooleanEnvString(
    env.WORKFLOW_AUTOMATION_ENABLED,
    true,
  );
  const workflowProfile = String(
    env.WORKFLOW_DEFAULT_PROFILE || configJson.workflowDefaults?.profile || "balanced",
  ).trim().toLowerCase() || "balanced";
  const fallbackWorkflowTemplateIds = resolveWorkflowTemplateIds({ profileId: workflowProfile });
  const workflowTemplateIds = normalizeWorkflowTemplateIdList(
    env.WORKFLOW_DEFAULT_TEMPLATES || configJson.workflowDefaults?.templates,
    fallbackWorkflowTemplateIds,
  );
  env.WORKFLOW_DEFAULT_PROFILE = workflowProfile;
  env.WORKFLOW_DEFAULT_TEMPLATES = workflowTemplateIds.length > 0
    ? workflowTemplateIds.join(",")
    : "none";
  env.WORKFLOW_DEFAULT_AUTOINSTALL = toBooleanEnvString(
    env.WORKFLOW_DEFAULT_AUTOINSTALL ?? configJson.workflowDefaults?.autoInstall,
    true,
  );
  configJson.workflowDefaults = {
    profile: workflowProfile,
    autoInstall: parseBooleanEnvValue(env.WORKFLOW_DEFAULT_AUTOINSTALL, true),
    templates: workflowTemplateIds,
    templateOverridesById: normalizeTemplateOverridesById(
      configJson.workflowDefaults?.templateOverridesById,
      workflowTemplateIds,
    ),
  };
  configJson.prAutomation = {
    ...(configJson.prAutomation && typeof configJson.prAutomation === "object" ? configJson.prAutomation : {}),
    assistiveActions: {
      ...(configJson.prAutomation?.assistiveActions && typeof configJson.prAutomation.assistiveActions === "object"
        ? configJson.prAutomation.assistiveActions
        : {}),
      installOnSetup: parseBooleanEnvValue(
        env.BOSUN_PR_ASSISTIVE_ACTIONS_INSTALL_ON_SETUP
          ?? configJson.prAutomation?.assistiveActions?.installOnSetup,
        false,
      ),
    },
  };
  const normalizedRepoVisibility = normalizeEnum(
    env.BOSUN_GATES_REPO_VISIBILITY,
    ["public", "private", "unknown"],
    String(configJson.gates?.prs?.repoVisibility || "unknown").trim().toLowerCase() || "unknown",
  );
  const recommendedAutomationPreference = normalizedRepoVisibility === "public"
    ? "actions-first"
    : "runtime-first";
  configJson.gates = {
    ...(configJson.gates && typeof configJson.gates === "object" ? configJson.gates : {}),
    prs: {
      ...(configJson.gates?.prs && typeof configJson.gates.prs === "object" ? configJson.gates.prs : {}),
      repoVisibility: normalizedRepoVisibility,
      automationPreference: normalizeEnum(
        env.BOSUN_GATES_AUTOMATION_PREFERENCE,
        ["runtime-first", "actions-first"],
        String(configJson.gates?.prs?.automationPreference || recommendedAutomationPreference).trim().toLowerCase()
          || recommendedAutomationPreference,
      ),
      githubActionsBudget: normalizeEnum(
        env.BOSUN_GATES_ACTIONS_BUDGET,
        ["ask-user", "available", "limited"],
        String(configJson.gates?.prs?.githubActionsBudget || "ask-user").trim().toLowerCase() || "ask-user",
      ),
    },
    checks: {
      ...(configJson.gates?.checks && typeof configJson.gates.checks === "object" ? configJson.gates.checks : {}),
      mode: normalizeEnum(
        env.BOSUN_GATES_CHECK_MODE,
        ["all", "required-only"],
        String(configJson.gates?.checks?.mode || "all").trim().toLowerCase() || "all",
      ),
      requiredPatterns: normalizeCsvOrArray(configJson.gates?.checks?.requiredPatterns || []),
      optionalPatterns: normalizeCsvOrArray(configJson.gates?.checks?.optionalPatterns || []),
      ignorePatterns: normalizeCsvOrArray(configJson.gates?.checks?.ignorePatterns || []),
      requireAnyRequiredCheck: parseBooleanEnvValue(
        env.BOSUN_GATES_REQUIRE_ANY_REQUIRED_CHECK ?? configJson.gates?.checks?.requireAnyRequiredCheck,
        true,
      ),
      treatPendingRequiredAsBlocking: parseBooleanEnvValue(
        env.BOSUN_GATES_TREAT_PENDING_REQUIRED_AS_BLOCKING ?? configJson.gates?.checks?.treatPendingRequiredAsBlocking,
        true,
      ),
      treatNeutralAsPass: parseBooleanEnvValue(
        env.BOSUN_GATES_TREAT_NEUTRAL_AS_PASS ?? configJson.gates?.checks?.treatNeutralAsPass,
        false,
      ),
    },
    execution: {
      ...(configJson.gates?.execution && typeof configJson.gates.execution === "object" ? configJson.gates.execution : {}),
      sandboxMode: String(
        env.CODEX_SANDBOX || configJson.gates?.execution?.sandboxMode || "workspace-write",
      ).trim().toLowerCase(),
      containerIsolationEnabled: parseBooleanEnvValue(
        env.CONTAINER_ENABLED ?? configJson.gates?.execution?.containerIsolationEnabled,
        false,
      ),
      containerRuntime: String(
        env.CONTAINER_RUNTIME || configJson.gates?.execution?.containerRuntime || "auto",
      ).trim().toLowerCase(),
      networkAccess: String(
        env.BOSUN_EXECUTION_NETWORK_ACCESS || configJson.gates?.execution?.networkAccess || "default",
      ).trim().toLowerCase(),
    },
    runtime: {
      ...(configJson.gates?.runtime && typeof configJson.gates.runtime === "object" ? configJson.gates.runtime : {}),
      enforceBacklog: parseBooleanEnvValue(
        env.BOSUN_GATES_ENFORCE_BACKLOG ?? configJson.gates?.runtime?.enforceBacklog,
        true,
      ),
      agentTriggerControl: parseBooleanEnvValue(
        env.BOSUN_GATES_AGENT_TRIGGER_CONTROL ?? configJson.gates?.runtime?.agentTriggerControl,
        true,
      ),
    },
  };
  env.EXECUTOR_MODE = normalizeEnum(
    env.EXECUTOR_MODE,
    ["internal", "hybrid"],
    "internal",
  );

  env.VOICE_ENABLED = toBooleanEnvString(env.VOICE_ENABLED, true);
  env.VOICE_PROVIDER = normalizeEnum(
    env.VOICE_PROVIDER,
    ["auto", "openai", "azure", "claude", "gemini", "fallback"],
    "auto",
  );
  env.VOICE_MODEL =
    env.VOICE_MODEL || "gpt-realtime-1.5";
  env.VOICE_VISION_MODEL =
    env.VOICE_VISION_MODEL || "gpt-4.1-mini";
  env.VOICE_ID = normalizeEnum(
    env.VOICE_ID,
    [
      "alloy",
      "ash",
      "ballad",
      "coral",
      "echo",
      "fable",
      "onyx",
      "nova",
      "sage",
      "shimmer",
      "verse",
    ],
    "alloy",
  );
  env.VOICE_TURN_DETECTION = normalizeEnum(
    env.VOICE_TURN_DETECTION,
    ["server_vad", "semantic_vad", "none"],
    "semantic_vad",
  );
  env.VOICE_FALLBACK_MODE = normalizeEnum(
    env.VOICE_FALLBACK_MODE,
    ["browser", "disabled"],
    "browser",
  );
  env.VOICE_DELEGATE_EXECUTOR = normalizeEnum(
    env.VOICE_DELEGATE_EXECUTOR,
    [
      "codex-sdk",
      "copilot-sdk",
      "claude-sdk",
      "gemini-sdk",
      "opencode-sdk",
    ],
    env.PRIMARY_AGENT || "codex-sdk",
  );
  env.AZURE_OPENAI_REALTIME_DEPLOYMENT =
    env.AZURE_OPENAI_REALTIME_DEPLOYMENT || "gpt-realtime-1.5";

  env.CODEX_MODEL_PROFILE = normalizeEnum(
    env.CODEX_MODEL_PROFILE,
    ["xl", "m"],
    "xl",
  );
  env.CODEX_MODEL_PROFILE_SUBAGENT = normalizeEnum(
    env.CODEX_MODEL_PROFILE_SUBAGENT || env.CODEX_SUBAGENT_PROFILE,
    ["xl", "m"],
    "m",
  );
  env.CODEX_MODEL_PROFILE_XL_PROVIDER = normalizeEnum(
    env.CODEX_MODEL_PROFILE_XL_PROVIDER,
    ["openai", "azure", "compatible"],
    "openai",
  );
  env.CODEX_MODEL_PROFILE_M_PROVIDER = normalizeEnum(
    env.CODEX_MODEL_PROFILE_M_PROVIDER,
    ["openai", "azure", "compatible"],
    "openai",
  );
  env.CODEX_MODEL_PROFILE_XL_MODEL =
    env.CODEX_MODEL_PROFILE_XL_MODEL || "gpt-5.3-codex";
  env.CODEX_MODEL_PROFILE_M_MODEL =
    env.CODEX_MODEL_PROFILE_M_MODEL || "gpt-5.1-codex-mini";
  env.CODEX_SUBAGENT_MODEL =
    env.CODEX_SUBAGENT_MODEL || env.CODEX_MODEL_PROFILE_M_MODEL;
  env.CODEX_AGENT_MAX_THREADS = String(
    toPositiveInt(
      env.CODEX_AGENT_MAX_THREADS || env.CODEX_AGENTS_MAX_THREADS || "12",
      12,
    ),
  );
  env.CODEX_SANDBOX = normalizeEnum(
    env.CODEX_SANDBOX,
    ["workspace-write", "danger-full-access", "read-only"],
    "workspace-write",
  );
  env.CODEX_FEATURES_BWRAP = toBooleanEnvString(
    env.CODEX_FEATURES_BWRAP,
    detectBwrapSupport(),
  );
  env.CODEX_SANDBOX_PERMISSIONS =
    env.CODEX_SANDBOX_PERMISSIONS || "disk-full-write-access";
  env.CODEX_SANDBOX_WRITABLE_ROOTS =
    env.CODEX_SANDBOX_WRITABLE_ROOTS || buildDefaultWritableRoots(repoRoot);

  env.CODEX_TRANSPORT = normalizeEnum(
    env.CODEX_TRANSPORT || process.env.CODEX_TRANSPORT,
    ["sdk", "auto", "cli"],
    "sdk",
  );
  env.COPILOT_TRANSPORT = normalizeEnum(
    env.COPILOT_TRANSPORT || process.env.COPILOT_TRANSPORT,
    ["sdk", "auto", "cli", "url"],
    "sdk",
  );
  env.COPILOT_MCP_CONFIG =
    env.COPILOT_MCP_CONFIG || resolve(repoRoot, ".vscode", "mcp.json");
  env.CLAUDE_TRANSPORT = normalizeEnum(
    env.CLAUDE_TRANSPORT || process.env.CLAUDE_TRANSPORT,
    ["sdk", "auto", "cli"],
    "sdk",
  );
  env.GEMINI_TRANSPORT = normalizeEnum(
    env.GEMINI_TRANSPORT || process.env.GEMINI_TRANSPORT,
    ["sdk", "auto", "cli"],
    "auto",
  );

  env.WHATSAPP_ENABLED = toBooleanEnvString(env.WHATSAPP_ENABLED, false);

  env.CONTAINER_ENABLED = toBooleanEnvString(env.CONTAINER_ENABLED, false);

  env.CONTAINER_RUNTIME = normalizeEnum(
    env.CONTAINER_RUNTIME,
    ["auto", "docker", "podman", "container"],
    "auto",
  );
  if (env.ORCHESTRATOR_SCRIPT) {
    env.ORCHESTRATOR_SCRIPT = formatOrchestratorScriptForEnv(
      env.ORCHESTRATOR_SCRIPT,
      configDir || __dirname,
    );
  }

  if (
    !Array.isArray(configJson.executors) ||
    configJson.executors.length === 0
  ) {
    configJson.executors = EXECUTOR_PRESETS["codex-only"];
  }
  configJson.executors = configJson.executors.map((executor, index) => ({
    ...executor,
    name: executor.name || `executor-${index + 1}`,
    executor: String(executor.executor || "CODEX").toUpperCase(),
    variant: executor.variant || "DEFAULT",
    weight: toPositiveInt(executor.weight || 1, 1),
    role:
      executor.role ||
      (index === 0
        ? "primary"
        : index === 1
          ? "backup"
          : `executor-${index + 1}`),
    enabled: executor.enabled !== false,
  }));

  // Derive PRIMARY_AGENT from executor config for SDK resolution
  {
    const primaryExec = configJson.executors.find((e) => e.role === "primary");
    if (primaryExec) {
      const sdkMap = {
        CODEX: "codex-sdk",
        COPILOT: "copilot-sdk",
        CLAUDE: "claude-sdk",
        GEMINI: "gemini-sdk",
        OPENCODE: "opencode-sdk",
      };
      env.PRIMARY_AGENT = env.PRIMARY_AGENT ||
        sdkMap[String(primaryExec.executor).toUpperCase()] || "codex-sdk";
    }
  }

  configJson.failover = {
    strategy: normalizeEnum(
      configJson.failover?.strategy || env.FAILOVER_STRATEGY || "next-in-line",
      ["next-in-line", "weighted-random", "round-robin"],
      "next-in-line",
    ),
    maxRetries: toPositiveInt(
      configJson.failover?.maxRetries || env.FAILOVER_MAX_RETRIES || 3,
      3,
    ),
    cooldownMinutes: toPositiveInt(
      configJson.failover?.cooldownMinutes || env.FAILOVER_COOLDOWN_MIN || 5,
      5,
    ),
    disableOnConsecutiveFailures: toPositiveInt(
      configJson.failover?.disableOnConsecutiveFailures ||
        env.FAILOVER_DISABLE_AFTER ||
        3,
      3,
    ),
  };

  configJson.distribution = normalizeEnum(
    configJson.distribution || env.EXECUTOR_DISTRIBUTION || "primary-only",
    ["weighted", "round-robin", "primary-only"],
    "primary-only",
  );

  if (
    !Array.isArray(configJson.repositories) ||
    configJson.repositories.length === 0
  ) {
    configJson.repositories = [
      {
        name: basename(repoRoot),
        slug: env.GITHUB_REPO,
        primary: true,
      },
    ];
  }

  configJson.projectName = env.PROJECT_NAME;
  configJson.kanban = {
    ...(configJson.kanban || {}),
    backend: env.KANBAN_BACKEND,
    syncPolicy: env.KANBAN_SYNC_POLICY,
  };
  configJson.internalExecutor = {
    ...(configJson.internalExecutor || {}),
    mode: env.EXECUTOR_MODE,
  };
}

function formatEnvValue(value) {
  const raw = String(value ?? "");
  const needsQuotes = /\s|#|=/.test(raw);
  if (!needsQuotes) return raw;
  return `"${raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function buildStandardizedEnvFile(templateText, envEntries) {
  const lines = templateText.split(/\r?\n/);
  const entryMap = new Map(
    Object.entries(envEntries)
      .filter(([key]) => !key.startsWith("_"))
      .map(([key, value]) => [key, String(value ?? "")]),
  );

  const consumed = new Set();
  const seenKeys = new Set();
  const updated = lines.flatMap((line) => {
    const trimmedLine = String(line || "").trim();
    const noComment = trimmedLine.startsWith("#") ? trimmedLine.slice(1).trimStart() : trimmedLine;
    const eqIdx = noComment.indexOf("=");
    if (eqIdx <= 0) return [line];
    const key = noComment.slice(0, eqIdx).trim();
    if (!/^[A-Z0-9_]+$/.test(key)) return [line];
    if (seenKeys.has(key)) return [];
    seenKeys.add(key);
    if (!entryMap.has(key)) return [line];
    consumed.add(key);
    return [`${key}=${formatEnvValue(entryMap.get(key))}`];
  });

  const extras = [...entryMap.keys()].filter((key) => !consumed.has(key));
  if (extras.length > 0) {
    updated.push("");
    updated.push("# Added by setup wizard");
    for (const key of extras.sort()) {
      updated.push(`${key}=${formatEnvValue(entryMap.get(key))}`);
    }
  }

  const header = [
    "# Generated by bosun setup wizard",
    `# ${new Date().toISOString()}`,
    "",
  ];
  return [...header, ...updated].join("\n") + "\n";
}

/**
 * Merge new env values from a setup run into an existing .env file.
 *
 * Strategy:
 *   - Preserves all comments and structure from the existing file
 *   - Updates values for keys that exist in both (setup wins)
 *   - Appends new keys that only exist in the setup result
 *   - Skips internal keys starting with "_"
 *   - Preserves keys that exist in the file but not in the setup result
 *
 * @param {string} existingContent  The current .env file content
 * @param {object} newEntries       The env object from the setup wizard
 * @returns {string}  Merged .env content
 */
export function mergeEnvFiles(existingContent, newEntries) {
  const entryMap = new Map(
    Object.entries(newEntries)
      .filter(([key]) => !key.startsWith("_"))
      .filter(([, val]) => val !== undefined && val !== null && String(val) !== "")
      .map(([key, value]) => [key, String(value ?? "")]),
  );

  const consumed = new Set();
  const lines = existingContent.split(/\r?\n/);

  const merged = lines.map((line) => {
    const trimmed = line.trim();
    // Preserve comments and blank lines
    if (!trimmed || trimmed.startsWith("#")) return line;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) return line;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!entryMap.has(key)) return line; // preserve existing keys not in new entries

    consumed.add(key);
    const newVal = entryMap.get(key);
    return `${key}=${formatEnvValue(newVal)}`;
  });

  // Append any new keys that didn't exist in the original file
  const extras = [...entryMap.keys()].filter((key) => !consumed.has(key));
  if (extras.length > 0) {
    merged.push("");
    merged.push(`# Added by setup wizard (${new Date().toISOString()})`);
    for (const key of extras.sort()) {
      merged.push(`${key}=${formatEnvValue(entryMap.get(key))}`);
    }
  }

  return merged.join("\n");
}

// ── Agent Template ───────────────────────────────────────────────────────────

function generateAgentsMd(projectName, repoSlug) {
  return `# ${projectName} — Agent Guide

## CRITICAL

Always work on tasks longer than you think are needed to accommodate edge cases, testing, and quality.
Ensure tests pass and build is clean with 0 warnings before deciding a task is complete.
When working on a task, do not stop until it is COMPLETELY done end-to-end.

Before finishing a task — create a commit using conventional commits and push.

### PR Creation

After committing:
- Push your branch updates
- Hand off PR lifecycle to Bosun management (do not run direct PR-create commands)
- Ensure pre-push hooks pass
- Fix any lint or test errors encountered

## Overview

- Repository: \`${repoSlug}\`
- Task management: Internal board (auto-configured by bosun)

## Build & Test

\`\`\`bash
# Add your build commands here
npm run build
npm test
\`\`\`

## Commit Conventions

Use [Conventional Commits](https://www.conventionalcommits.org/):

\`\`\`
type(scope): description
\`\`\`

Valid types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert

## Pre-commit / Pre-push

Linting and formatting are enforced before commit.
Tests and builds are verified before push.
`;
}

// ── Main Setup Flow ──────────────────────────────────────────────────────────

async function main() {
  printBanner();

  const repoRoot = detectRepoRoot();
  const configDir = resolveConfigDir(repoRoot);
  const slug = detectRepoSlug();
  const projectName = detectProjectName(repoRoot);
  console.log();
  info(`Bosun config directory: ${configDir}`);
  info(`Workspace root: ${resolve(configDir, "workspaces")}`);
  if (process.env.BOSUN_DIR) {
    info(`BOSUN_DIR override detected: ${process.env.BOSUN_DIR}`);
  }
  const setupProgress = readSetupProgress(configDir);
  let resumeFromStep = 0;
  let resumedEnv = null;
  let resumedConfigJson = null;
  const markSetupProgress = (step, label) => {
    // We save a full snapshot (including env/configJson) so resume can restore state
    const existing = readSetupProgress(configDir);
    writeSetupProgress(configDir, {
      status: "incomplete",
      step,
      total: SETUP_TOTAL_STEPS,
      label,
      updatedAt: new Date().toISOString(),
      snapshot: existing?.snapshot || undefined,
    });
  };
  /** Save a full snapshot of env and configJson at the current step. */
  const saveSetupSnapshot = (step, label, env, configJson) => {
    writeSetupSnapshot(configDir, { step, label, env, configJson });
  };

  if (setupProgress?.status === "incomplete" && setupProgress.step > 1) {
    const label = setupProgress.label ? ` — ${setupProgress.label}` : "";
    const timestamp = setupProgress.updatedAt
      ? ` (last updated ${setupProgress.updatedAt})`
      : "";
    console.log();
    info(
      `Detected an incomplete setup that ended at step ${setupProgress.step} of ${SETUP_TOTAL_STEPS}${label}${timestamp}.`,
    );
    if (setupProgress.snapshot?.env) {
      // We have a snapshot — offer to resume
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const resumeAnswer = await new Promise((res) => {
        rl.question(
          "  Resume where you left off? [Y/n]: ",
          (answer) => { rl.close(); res((answer || "Y").trim().toLowerCase()); },
        );
      });
      if (resumeAnswer !== "n" && resumeAnswer !== "no") {
        resumeFromStep = setupProgress.step;
        resumedEnv = setupProgress.snapshot.env;
        resumedConfigJson = setupProgress.snapshot.configJson;
        info(`Resuming from step ${resumeFromStep}. Previously collected values will be restored.`);
      } else {
        info("Starting fresh setup from the beginning.");
        clearSetupProgress(configDir);
      }
    } else {
      info("No saved state found from previous run — starting fresh.");
    }
    console.log();
  }

  // ── Step 1: Prerequisites ───────────────────────────────
  headingStep(1, "Prerequisites", markSetupProgress);
  const hasNode = check(
    "Node.js ≥ 18",
    Number(process.versions.node.split(".")[0]) >= 18,
  );
  const hasGit = check("git", commandExists("git"));
  const runtimeStatus = getScriptRuntimePrerequisiteStatus();
  check(
    runtimeStatus.required.label,
    runtimeStatus.required.ok,
    runtimeStatus.required.hint,
  );
  if (runtimeStatus.optionalPwsh) {
    if (runtimeStatus.optionalPwsh.ok) {
      info(
        `${runtimeStatus.optionalPwsh.label} detected (${runtimeStatus.optionalPwsh.hint}).`,
      );
    } else {
      warn(
        `${runtimeStatus.optionalPwsh.label} not found (${runtimeStatus.optionalPwsh.hint}).`,
      );
    }
  }
  check(
    "GitHub CLI (gh)",
    commandExists("gh"),
    "Recommended: https://cli.github.com/",
  );

  if (!hasNode) {
    console.error("\n  Node.js 18+ is required. Aborting.\n");
    process.exit(1);
  }

  const envCandidates = [resolve(configDir, ".env"), resolve(repoRoot, ".env")];
  const seenEnvPaths = new Set();
  let detectedEnv = false;
  let loadedEnvEntries = 0;
  for (const envPath of envCandidates) {
    if (seenEnvPaths.has(envPath)) continue;
    seenEnvPaths.add(envPath);
    const applied = applyEnvFileToProcess(envPath, { override: false });
    if (applied.found) {
      detectedEnv = true;
      loadedEnvEntries += applied.loaded;
    }
  }
  if (detectedEnv) {
    info(
      "Detected .env file -> overriding default setting with existing config",
    );
    info(
      `Loaded ${loadedEnvEntries} value(s) from existing environment file(s).`,
    );
  }

  const env = {};
  const configJson = {
    projectName,
    executors: [],
    failover: {},
    distribution: "primary-only",
    repositories: [],
    agentPrompts: {},
  };

  // Restore snapshot state if resuming from a previous incomplete setup
  if (resumedEnv) {
    Object.assign(env, resumedEnv);
    // Restore cross-step flags from snapshot
    if (env._CLONE_WORKSPACES === "1") cloneWorkspacesAfterSetup = true;
  }
  if (resumedConfigJson) {
    Object.assign(configJson, resumedConfigJson);
  }

  env.REPO_ROOT = process.env.REPO_ROOT || repoRoot;

  if (isNonInteractive) {
    return runNonInteractive({
      env,
      configJson,
      repoRoot,
      slug,
      projectName,
      configDir,
    });
  }

  const prompt = createPrompt();
  let aborted = false;
  let cloneWorkspacesAfterSetup = false;
  const headingStepWithSnapshot = (step, label) => {
    headingStep(step, label, markSetupProgress);
    if (step > 1) {
      saveSetupSnapshot(step, label, env, configJson);
    }
  };

  // Variables set in early steps that later steps depend on.
  // Declared as `let` so they can be restored from a resume snapshot.
  let setupProfile = env._SETUP_PROFILE || "recommended";
  let isAdvancedSetup = setupProfile === "advanced";

  try {
    // ── Step 2: Setup Mode + Project Identity ─────────────
    if (resumeFromStep > 2) {
      info(`Skipping step 2 (restored from previous run).`);
      // Restore isAdvancedSetup from env snapshot
      setupProfile = env._SETUP_PROFILE || "recommended";
      isAdvancedSetup = setupProfile === "advanced";
    } else {
    headingStepWithSnapshot(2, "Setup Mode & Project Identity");
    const setupProfileIdx = await prompt.choose(
      "How much setup detail do you want?",
      SETUP_PROFILES.map((profile) => profile.label),
      0,
    );
    setupProfile = SETUP_PROFILES[setupProfileIdx]?.key || "recommended";
    isAdvancedSetup = setupProfile === "advanced";
    env._SETUP_PROFILE = setupProfile;
    info(
      isAdvancedSetup
        ? "Advanced mode enabled — all sections will prompt for detailed overrides."
        : "Recommended mode enabled — only key decisions are prompted; safe defaults fill the rest.",
    );

    env.PROJECT_NAME = await prompt.ask("Project name", projectName);
    env.GITHUB_REPO = await prompt.ask(
      "GitHub repo slug (org/repo)",
      process.env.GITHUB_REPO || slug || "",
    );
    configJson.projectName = env.PROJECT_NAME;
    saveSetupSnapshot(2, "Setup Mode & Project Identity", env, configJson);
    } // end step 2

    // ── Step 3: Workspace & Repository ─────────────────────
    if (resumeFromStep > 3) {
      info(`Skipping step 3 (restored from previous run).`);
    } else {
    headingStepWithSnapshot(3, "Workspace & Repository Configuration");

    const useWorkspaces = await prompt.confirm(
      "Set up multi-repo workspaces? (organizes repos into ~/bosun/workspaces/)",
      isAdvancedSetup,
    );

    if (useWorkspaces) {
      info("Workspaces group related repositories together.\n");
      info(`Repositories will be cloned into: ${resolve(configDir, "workspaces")}\n`);

      configJson.workspaces = [];
      let addMoreWs = true;
      let wsIdx = 0;

      while (addMoreWs) {
        const wsName = await prompt.ask(
          `  Workspace ${wsIdx + 1} — name`,
          wsIdx === 0 ? projectName : "",
        );
        const wsId = wsName.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");

        const wsRepos = [];
        let addMoreRepos = true;
        let repoIdx = 0;

        while (addMoreRepos) {
          let repoUrl = await prompt.ask(
            `    Repo ${repoIdx + 1} — git URL (SSH or HTTPS)`,
            repoIdx === 0
              ? buildDefaultGitUrl(env.GITHUB_REPO || slug, repoRoot)
              : "",
          );
          if (repoUrl && isSshGitUrl(repoUrl) && !hasSshKeyMaterial()) {
            warn(
              "SSH URL detected but no SSH agent/keys found. Cloning may fail unless SSH is configured.",
            );
            const switchToHttps = await prompt.confirm(
              "Use HTTPS URL instead?",
              true,
            );
            if (switchToHttps) {
              const parsedSlug = parseRepoSlugFromUrl(repoUrl);
              if (parsedSlug) {
                repoUrl = `https://github.com/${parsedSlug}.git`;
              }
            }
          }
          const parsedSlug = parseRepoSlugFromUrl(repoUrl);
          const parsedRepoName = parsedSlug ? parsedSlug.split("/")[1] : "";
          const defaultNameFromUrl = repoUrl
            ? (repoUrl.match(/[/:]([^/]+?)(?:\.git)?$/) || [])[1] || ""
            : "";
          const defaultName = defaultNameFromUrl || parsedRepoName;
          const repoSlugDefault =
            parsedSlug || (repoIdx === 0 ? env.GITHUB_REPO : "");
          const repoName = await prompt.ask(
            `    Repo ${repoIdx + 1} — directory name`,
            defaultName || (repoIdx === 0 ? basename(repoRoot) : ""),
          );
          const repoSlug = await prompt.ask(
            `    Repo ${repoIdx + 1} — GitHub slug (org/repo)`,
            repoSlugDefault,
          );

          wsRepos.push({
            name: repoName,
            url: repoUrl,
            slug: repoSlug,
            primary: repoIdx === 0,
          });
          repoIdx++;
          addMoreRepos = await prompt.confirm("    Add another repo to this workspace?", false);
        }

        configJson.workspaces.push({
          id: wsId,
          name: wsName,
          repos: wsRepos,
          createdAt: new Date().toISOString(),
          activeRepo: wsRepos[0]?.name || null,
        });

        // Also populate legacy repositories array for backward compat
        for (const repo of wsRepos) {
          configJson.repositories.push({
            name: repo.name,
            slug: repo.slug,
            primary: repo.primary,
          });
        }

        wsIdx++;
        addMoreWs = await prompt.confirm("Add another workspace?", false);
      }

      if (configJson.workspaces.length > 0) {
        configJson.activeWorkspace = configJson.workspaces[0].id;
      }

      cloneWorkspacesAfterSetup = await prompt.confirm(
        "Clone/pull workspace repos now (recommended)?",
        true,
      );
      env._CLONE_WORKSPACES = cloneWorkspacesAfterSetup ? "1" : "0";
    } else {
      // Single-repo mode (classic) — still works as before
      const multiRepo = isAdvancedSetup
        ? await prompt.confirm(
            "Do you have multiple repositories (e.g. separate backend/frontend)?",
            false,
          )
        : false;

      if (multiRepo) {
        info("Configure each repository. The first is the primary.\n");
        let addMore = true;
        let repoIdx = 0;
        while (addMore) {
          const repoName = await prompt.ask(
            `  Repo ${repoIdx + 1} — name`,
            repoIdx === 0 ? basename(repoRoot) : "",
          );
          const repoPath = await prompt.ask(
            `  Repo ${repoIdx + 1} — local path`,
            repoIdx === 0 ? repoRoot : "",
          );
          const repoSlugDefault =
            detectRepoSlug(repoPath) || (repoIdx === 0 ? env.GITHUB_REPO : "");
          const repoSlug = await prompt.ask(
            `  Repo ${repoIdx + 1} — GitHub slug`,
            repoSlugDefault,
          );
          configJson.repositories.push({
            name: repoName,
            path: repoPath,
            slug: repoSlug,
            primary: repoIdx === 0,
          });
          repoIdx++;
          addMore = await prompt.confirm("Add another repository?", false);
        }
      } else {
        configJson.repositories.push({
          name: basename(repoRoot),
          slug: env.GITHUB_REPO,
          primary: true,
        });
        if (!isAdvancedSetup) {
          info(
            "Using single-repo defaults (recommended mode). Re-run setup in Advanced mode for multi-repo config.",
          );
        }
      }
    }
    saveSetupSnapshot(3, "Workspace & Repository Configuration", env, configJson);
    } // end step 3

    // ── Step 4: Executor Configuration ─────────────────────
    if (resumeFromStep > 4) {
      info(`Skipping step 4 (restored from previous run).`);
    } else {
    headingStepWithSnapshot(4, "Executor / Agent Configuration");
    console.log("  Executors are the AI agents that work on tasks.\n");

    const presetOptions = isAdvancedSetup
      ? [
          "Codex only",
          "Copilot + Codex (50/50 split)",
          "Copilot only (Claude Opus 4.6)",
          "Claude only (direct API)",
          "Gemini only (direct SDK + CLI fallback)",
          "Gemini + Codex (60/40 split)",
          "OpenCode only (auto — uses OpenCode default provider)",
          "OpenCode + Codex (60/40 split)",
          "OpenCode (choose provider) — pick from 100+ providers",
          "Triple (Copilot Claude 40%, Codex 35%, Copilot GPT 25%)",
          "Custom — I'll define my own executors",
        ]
      : [
          "Codex only",
          "Copilot + Codex (50/50 split)",
          "Copilot only (Claude Opus 4.6)",
          "Claude only (direct API)",
          "Gemini only (direct SDK + CLI fallback)",
          "Gemini + Codex (60/40 split)",
          "OpenCode only (auto — uses OpenCode default provider)",
          "OpenCode + Codex (60/40 split)",
          "OpenCode (choose provider) — pick from 100+ providers",
          "Triple (Copilot Claude 40%, Codex 35%, Copilot GPT 25%)",
        ];

    const presetIdx = await prompt.choose(
      "Select executor preset:",
      presetOptions,
      0,
    );

    const presetNames = isAdvancedSetup
      ? [
          "codex-only",
          "copilot-codex",
          "copilot-only",
          "claude-only",
          "gemini-only",
          "gemini-codex",
          "opencode-only",
          "opencode-codex",
          "opencode-choose-provider",
          "triple",
          "custom",
        ]
      : [
          "codex-only",
          "copilot-codex",
          "copilot-only",
          "claude-only",
          "gemini-only",
          "gemini-codex",
          "opencode-only",
          "opencode-codex",
          "opencode-choose-provider",
          "triple",
        ];
    const presetKey = presetNames[presetIdx] || "codex-only";

    if (presetKey === "custom") {
      info("Define your executors. Enter empty name to finish.\n");
      printExecutorModelReference();
      console.log(
        chalk.dim(
          "  Weights are relative (they do not need to sum to 100). Percentages are normalized from the total.",
        ),
      );
      console.log();
      let execIdx = 0;
      const roles = ["primary", "backup", "tertiary"];
      while (true) {
        const eName = await prompt.ask(
          `  Executor ${execIdx + 1} — name (empty to finish)`,
          "",
        );
        if (!eName) break;
        const eType = await prompt.ask("  Executor type", "COPILOT");
        const eVariant = await prompt.ask(
          "  Model variant",
          defaultVariantForExecutor(eType),
        );
        const eWeight = Number(
          await prompt.ask("  Weight (relative number)", "50"),
        );
        configJson.executors.push({
          name: eName,
          executor: eType.toUpperCase(),
          variant: eVariant,
          weight: eWeight,
          role: roles[execIdx] || `executor-${execIdx + 1}`,
          enabled: true,
        });
        const totalWeight = configJson.executors.reduce(
          (sum, entry) => sum + (Number(entry.weight) || 0),
          0,
        );
        if (totalWeight > 0) {
          console.log(
            chalk.dim(
              `  Current total weight: ${totalWeight} (percentages will be normalized)`,
            ),
          );
          console.log();
        }
        execIdx++;
      }
    } else if (presetKey === "opencode-choose-provider") {
      // Dynamic provider selection — discover from OpenCode
      console.log(chalk.dim("\n  Discovering OpenCode providers...\n"));
      let snapshot = null;
      try {
        snapshot = await discoverProviders({ force: true });
      } catch (err) {
        console.warn(chalk.yellow(`  Could not query OpenCode: ${err.message}`));
      }

      if (snapshot && snapshot.providers.length > 0) {
        const connectedProviders = snapshot.connected || [];
        const allProviders = snapshot.providers;

        if (connectedProviders.length > 0) {
          console.log(chalk.green(`  ✓ ${connectedProviders.length} connected: `) +
            connectedProviders.map((p) => p.id).join(", "));
        }
        console.log(chalk.dim(`  ${allProviders.length} total providers available\n`));

        // Ask: single provider or multi-provider rotation
        const modeIdx = await prompt.choose(
          "How many OpenCode providers?",
          [
            "Single provider — one provider for all tasks",
            "Multi-provider rotation — distribute across providers by weight",
          ],
          0,
        );

        if (modeIdx === 0) {
          // Single provider
          const providerMenuItems = formatProvidersForMenu(allProviders);
          const providerIdx = await prompt.choose(
            "Select provider:",
            providerMenuItems,
            connectedProviders.length > 0
              ? allProviders.findIndex((p) => p.id === connectedProviders[0].id)
              : 0,
          );
          const sp = allProviders[providerIdx];
          let modelFullId = `${sp.id}/`;

          if (sp.models.length > 0) {
            const modelMenuItems = formatModelsForMenu(sp.models);
            const displayModels = modelMenuItems.length > 20
              ? [...modelMenuItems.slice(0, 20), `... ${modelMenuItems.length - 20} more (manual input)`]
              : modelMenuItems;
            const mIdx = await prompt.choose(`Model from ${sp.name}:`, displayModels, 0);
            modelFullId = mIdx < sp.models.length
              ? sp.models[mIdx].fullId
              : await prompt.ask(`Model ID (${sp.id}/model-name)`, modelFullId);
          } else {
            modelFullId = await prompt.ask(`Model ID (${sp.id}/model-name)`, modelFullId);
          }

          configJson.executors = [
            buildExecutorEntry(sp.id, modelFullId, { weight: 100 }),
          ];
          configJson.executors[0].role = "primary";
          configJson.executors[0].enabled = true;
        } else {
          // Multi-provider rotation
          configJson.executors = [];
          const roles = ["primary", "backup", "tertiary"];
          let addMore = true;
          let idx = 0;

          while (addMore) {
            const providerMenuItems = formatProvidersForMenu(allProviders);
            const providerIdx = await prompt.choose(
              `Provider for executor #${idx + 1}:`,
              providerMenuItems,
              0,
            );
            const sp = allProviders[providerIdx];
            let modelFullId = `${sp.id}/`;

            if (sp.models.length > 0) {
              const modelMenuItems = formatModelsForMenu(sp.models);
              const displayModels = modelMenuItems.length > 15
                ? [...modelMenuItems.slice(0, 15), `... ${modelMenuItems.length - 15} more`]
                : modelMenuItems;
              const mIdx = await prompt.choose(`Model from ${sp.name}:`, displayModels, 0);
              modelFullId = mIdx < sp.models.length
                ? sp.models[mIdx].fullId
                : await prompt.ask(`Model ID (${sp.id}/model-name)`, modelFullId);
            } else {
              modelFullId = await prompt.ask(`Model ID (${sp.id}/model-name)`, modelFullId);
            }

            const weight = toPositiveInt(
              await prompt.ask(`Weight for ${sp.id}`, "100"),
              100,
            );

            const entry = buildExecutorEntry(sp.id, modelFullId, { weight });
            entry.role = roles[idx] || `executor-${idx + 1}`;
            entry.enabled = true;
            configJson.executors.push(entry);
            info(`Added: ${modelFullId} (weight ${weight})`);

            idx++;
            addMore = await prompt.confirm("Add another provider?", false);
          }
        }
      } else {
        // Fallback: no providers discovered, use default opencode-only preset
        console.log(chalk.yellow("  Could not discover providers. Using default OpenCode config."));
        console.log(chalk.dim("  Tip: Install opencode and run 'opencode auth login' to add providers.\n"));
        configJson.executors = EXECUTOR_PRESETS["opencode-only"];
      }
    } else {
      configJson.executors = EXECUTOR_PRESETS[presetKey];
    }

    // Show executor summary
    console.log("\n  Configured executors:");
    const totalWeight = configJson.executors.reduce((s, e) => s + e.weight, 0);
    for (const e of configJson.executors) {
      const pct = Math.round((e.weight / totalWeight) * 100);
      console.log(
        `    ${e.role.padEnd(10)} ${e.executor}:${e.variant} — ${pct}%`,
      );
    }

    if (isAdvancedSetup) {
      console.log();
      console.log(
        chalk.dim("  What happens when an executor fails repeatedly?"),
      );
      console.log();

      const failoverIdx = await prompt.choose(
        "Select failover strategy:",
        FAILOVER_STRATEGIES.map((f) => `${f.name} — ${f.desc}`),
        0,
      );
      configJson.failover = {
        strategy: FAILOVER_STRATEGIES[failoverIdx].name,
        maxRetries: Number(
          await prompt.ask("Max retries before failover", "3"),
        ),
        cooldownMinutes: Number(
          await prompt.ask("Cooldown after disabling executor (minutes)", "5"),
        ),
        disableOnConsecutiveFailures: Number(
          await prompt.ask(
            "Disable executor after N consecutive failures",
            "3",
          ),
        ),
      };

      const stableDistributionDefaultIdx = Math.max(
        0,
        DISTRIBUTION_MODES.findIndex((d) => d.name === "primary-only"),
      );
      const distIdx = await prompt.choose(
        "\n  Task distribution mode:",
        DISTRIBUTION_MODES.map((d) => `${d.name} — ${d.desc}`),
        stableDistributionDefaultIdx,
      );
      configJson.distribution = DISTRIBUTION_MODES[distIdx].name;
    } else {
      configJson.failover = {
        strategy: "next-in-line",
        maxRetries: 3,
        cooldownMinutes: 5,
        disableOnConsecutiveFailures: 3,
      };
      configJson.distribution = "primary-only";
      info(
        "Using stable routing defaults: primary-only distribution, next-in-line failover.",
      );
    }

    // ── SDK Fallback Configuration ─────────────────────────
    // Determine which SDKs are being used in executor config
    const usedSdks = new Set(
      configJson.executors.map((e) => String(e.executor).toUpperCase()),
    );
    // Disable SDKs not represented in executor config — unconditional, prevents
    // accidental routing to an SDK the user hasn't configured.
    if (!usedSdks.has("CODEX"))   { env.CODEX_SDK_DISABLED   = "true"; } else { delete env.CODEX_SDK_DISABLED;   }
    if (!usedSdks.has("COPILOT")) { env.COPILOT_SDK_DISABLED = "true"; } else { delete env.COPILOT_SDK_DISABLED; }
    if (!usedSdks.has("CLAUDE"))  { env.CLAUDE_SDK_DISABLED  = "true"; } else { delete env.CLAUDE_SDK_DISABLED;  }
    if (!usedSdks.has("GEMINI"))  { env.GEMINI_SDK_DISABLED  = "true"; } else { delete env.GEMINI_SDK_DISABLED;  }
    if (!usedSdks.has("OPENCODE")) {
      env.OPENCODE_SDK_DISABLED = "true";
    } else {
      delete env.OPENCODE_SDK_DISABLED;
    }

    if (isAdvancedSetup) {
      console.log();
      info("SDK fallback configuration — which SDKs should be available for fallback?");
      console.log(chalk.dim("  SDKs not in your executor preset will be tried as fallback on failure."));
      console.log(chalk.dim("  Disable SDKs you don't have credentials for to avoid error cascades.\n"));

      const wantCodexFallback = usedSdks.has("CODEX") || await prompt.confirm(
        "Enable Codex SDK fallback? (requires OPENAI_API_KEY)",
        !!process.env.OPENAI_API_KEY || usedSdks.has("CODEX"),
      );
      if (!wantCodexFallback) env.CODEX_SDK_DISABLED = "true";
      else delete env.CODEX_SDK_DISABLED;

      const wantCopilotFallback = usedSdks.has("COPILOT") || await prompt.confirm(
        "Enable Copilot SDK fallback? (requires COPILOT_CLI_TOKEN or GITHUB_TOKEN)",
        !!process.env.COPILOT_CLI_TOKEN || !!process.env.GITHUB_TOKEN,
      );
      if (!wantCopilotFallback) env.COPILOT_SDK_DISABLED = "true";
      else delete env.COPILOT_SDK_DISABLED;

      const wantClaudeFallback = usedSdks.has("CLAUDE") || await prompt.confirm(
        "Enable Claude SDK fallback? (requires ANTHROPIC_API_KEY)",
        !!process.env.ANTHROPIC_API_KEY,
      );
      if (!wantClaudeFallback) env.CLAUDE_SDK_DISABLED = "true";
      else delete env.CLAUDE_SDK_DISABLED;

      const wantGeminiFallback = usedSdks.has("GEMINI") || await prompt.confirm(
        "Enable Gemini SDK fallback? (requires GEMINI_API_KEY or GOOGLE_API_KEY)",
        !!process.env.GEMINI_API_KEY || !!process.env.GOOGLE_API_KEY,
      );
      if (!wantGeminiFallback) env.GEMINI_SDK_DISABLED = "true";
      else delete env.GEMINI_SDK_DISABLED;

      const wantOpenCodeFallback = usedSdks.has("OPENCODE") || await prompt.confirm(
        "Enable OpenCode SDK fallback? (requires opencode binary on PATH)",
        false,
      );
      if (!wantOpenCodeFallback) env.OPENCODE_SDK_DISABLED = "true";
      else delete env.OPENCODE_SDK_DISABLED;
    }
    saveSetupSnapshot(4, "Executor / Agent Configuration", env, configJson);
    } // end step 4

    // Recompute usedSdks from configJson (works for both fresh and resumed runs)
    const usedSdks = new Set(
      (configJson.executors || []).map((e) => String(e.executor).toUpperCase()),
    );

    // ── Step 5: AI Provider Keys ─────────────────────────────
    if (resumeFromStep > 5) {
      info(`Skipping step 5 (restored from previous run).`);
    } else {
    headingStepWithSnapshot(5, "AI Provider Keys");
    console.log(
      "  Configure API keys for the agent SDKs in your executor preset.\n",
    );

    // Determine which SDK families are needed
    const needsCodexSdk = usedSdks.has("CODEX") || env.CODEX_SDK_DISABLED !== "true";
    const needsCopilotSdk = usedSdks.has("COPILOT") || env.COPILOT_SDK_DISABLED !== "true";
    const needsClaudeSdk = usedSdks.has("CLAUDE") || env.CLAUDE_SDK_DISABLED !== "true";
    const needsGeminiSdk = usedSdks.has("GEMINI") || env.GEMINI_SDK_DISABLED !== "true";
    const needsOpencodeSdk = usedSdks.has("OPENCODE") || env.OPENCODE_SDK_DISABLED !== "true";

    // ── 5a. Copilot / GitHub Token ──────────────────────
    if (needsCopilotSdk) {
      console.log(chalk.bold("  Copilot SDK") + chalk.dim(" (uses GitHub token)\n"));
      const existingGhToken = process.env.COPILOT_CLI_TOKEN || process.env.GITHUB_TOKEN || "";
      if (existingGhToken) {
        info(`GitHub token detected (${existingGhToken.slice(0, 8)}…). Copilot SDK will use it.`);
      } else {
        const ghToken = await prompt.ask(
          "GitHub Token (GITHUB_TOKEN or COPILOT_CLI_TOKEN, blank to skip)",
          "",
        );
        if (ghToken) env.GITHUB_TOKEN = ghToken;
      }
      // Copilot permission defaults
      env.COPILOT_NO_ALLOW_ALL = env.COPILOT_NO_ALLOW_ALL || "false";
      env.COPILOT_ENABLE_ASK_USER = env.COPILOT_ENABLE_ASK_USER || "false";
      env.COPILOT_AGENT_MAX_REQUESTS = env.COPILOT_AGENT_MAX_REQUESTS || "500";
    }

    // ── 5b. Claude / Anthropic Key ──────────────────────
    if (needsClaudeSdk) {
      console.log(chalk.bold("\n  Claude SDK") + chalk.dim(" (uses Anthropic API key)\n"));
      const existingAnthropicKey = process.env.ANTHROPIC_API_KEY || "";
      if (existingAnthropicKey) {
        info(`Anthropic API key detected (${existingAnthropicKey.slice(0, 8)}…). Claude SDK will use it.`);
      } else {
        const anthropicKey = await prompt.ask(
          "Anthropic API Key (ANTHROPIC_API_KEY, blank to skip)",
          "",
        );
        if (anthropicKey) env.ANTHROPIC_API_KEY = anthropicKey;
      }
      // Claude always runs in bypass mode under Bosun
      env.CLAUDE_PERMISSION_MODE = env.CLAUDE_PERMISSION_MODE || "bypassPermissions";
    }

    // ── 5c. Codex / OpenAI Key ──────────────────────────
    if (needsCodexSdk) {
      console.log(chalk.bold("\n  Codex SDK") + chalk.dim(" (uses OpenAI API key)\n"));

      const providerIdx = await prompt.choose(
        "Select AI provider for Codex:",
        [
          "OpenAI (default)",
          "Azure OpenAI",
          "Local model (Ollama, vLLM, etc.)",
          "Other OpenAI-compatible endpoint",
          "None — disable Codex SDK",
        ],
        0,
      );

      if (providerIdx < 4) {
        env.OPENAI_API_KEY = await prompt.ask(
          "API Key",
          process.env.OPENAI_API_KEY || process.env.AZURE_OPENAI_API_KEY || "",
        );
      }
      if (providerIdx === 1) {
        env.AZURE_OPENAI_API_KEY = env.OPENAI_API_KEY;
        env.OPENAI_BASE_URL = await prompt.ask(
          "Azure endpoint URL",
          process.env.OPENAI_BASE_URL || "",
        );
        env.CODEX_MODEL = await prompt.ask(
          "Deployment/model name",
          process.env.CODEX_MODEL || "",
        );
      } else if (providerIdx === 2) {
        env.OPENAI_API_KEY = env.OPENAI_API_KEY || "ollama";
        env.OPENAI_BASE_URL = await prompt.ask(
          "Local API URL",
          "http://localhost:11434/v1",
        );
        env.CODEX_MODEL = await prompt.ask("Model name", "codex");
      } else if (providerIdx === 3) {
        env.OPENAI_BASE_URL = await prompt.ask("API Base URL", "");
        env.CODEX_MODEL = await prompt.ask("Model name", "");
      } else if (providerIdx === 4) {
        env.CODEX_SDK_DISABLED = "true";
      }

      if (providerIdx < 4) {
        const configureProfiles = await prompt.confirm(
          "Configure model profiles (xl/m) for one-click switching?",
          true,
        );
        if (configureProfiles) {
          const activeProfileIdx = await prompt.choose(
            "Default active profile:",
            ["xl (high quality)", "m (faster/cheaper)"],
            0,
          );
          env.CODEX_MODEL_PROFILE = activeProfileIdx === 0 ? "xl" : "m";
          env.CODEX_MODEL_PROFILE_SUBAGENT = activeProfileIdx === 0 ? "m" : "xl";

          env.CODEX_MODEL_PROFILE_XL_MODEL = await prompt.ask(
            "XL profile model",
            process.env.CODEX_MODEL_PROFILE_XL_MODEL ||
              process.env.CODEX_MODEL ||
              "gpt-5.3-codex",
          );
          env.CODEX_MODEL_PROFILE_M_MODEL = await prompt.ask(
            "M profile model",
            process.env.CODEX_MODEL_PROFILE_M_MODEL || "gpt-5.1-codex-mini",
          );

          const providerName =
            providerIdx === 1 ? "azure" : providerIdx === 3 ? "compatible" : "openai";
          env.CODEX_MODEL_PROFILE_XL_PROVIDER =
            process.env.CODEX_MODEL_PROFILE_XL_PROVIDER || providerName;
          env.CODEX_MODEL_PROFILE_M_PROVIDER =
            process.env.CODEX_MODEL_PROFILE_M_PROVIDER || providerName;

          if (!env.CODEX_SUBAGENT_MODEL) {
            env.CODEX_SUBAGENT_MODEL =
              env.CODEX_MODEL_PROFILE_M_MODEL || "gpt-5.1-codex-mini";
          }
        }
      }
    } else {
      // Codex not needed — skip OpenAI key prompts entirely
      info("Codex SDK not in executor preset — skipping OpenAI configuration.");
    }

    // ── 5d. Gemini / Google AI Key ────────────────────────
    if (needsGeminiSdk) {
      console.log(chalk.bold("\n  Gemini SDK") + chalk.dim(" (uses Google AI API key)\n"));
      const existingGeminiKey =
        process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
      if (existingGeminiKey) {
        info(`Gemini API key detected (${existingGeminiKey.slice(0, 8)}…). Gemini SDK will use it.`);
      } else {
        const geminiKey = await prompt.ask(
          "Gemini API Key (GEMINI_API_KEY / GOOGLE_API_KEY, blank to skip)",
          "",
        );
        if (geminiKey) {
          env.GEMINI_API_KEY = geminiKey;
        }
      }
      env.GEMINI_MODEL =
        env.GEMINI_MODEL ||
        process.env.GEMINI_MODEL ||
        "gemini-2.5-pro";
      const geminiTransportIdx = await prompt.choose(
        "Gemini transport mode:",
        [
          "auto (recommended: SDK first, CLI fallback)",
          "sdk only",
          "cli only",
        ],
        0,
      );
      env.GEMINI_TRANSPORT =
        geminiTransportIdx === 1
          ? "sdk"
          : geminiTransportIdx === 2
            ? "cli"
            : "auto";
      if (env.GEMINI_TRANSPORT !== "sdk") {
        const cliPath = await prompt.ask(
          "Gemini CLI binary path (GEMINI_CLI_PATH, leave blank for default 'gemini')",
          process.env.GEMINI_CLI_PATH || "",
        );
        if (cliPath) {
          env.GEMINI_CLI_PATH = cliPath;
        }
      }
    } else {
      info("Gemini SDK not in executor preset — skipping Gemini configuration.");
    }

    // ── 5e. OpenCode Provider Configuration ─────────────────────────
    if (needsOpencodeSdk) {
      console.log(chalk.bold("\n  OpenCode SDK") + chalk.dim(" (dynamic provider discovery)\n"));

      // Basic OpenCode settings
      env.OPENCODE_PORT = String(
        toPositiveInt(
          env.OPENCODE_PORT || process.env.OPENCODE_PORT || "4096",
          4096,
        ),
      );
      env.OPENCODE_TIMEOUT_MS = String(
        toPositiveInt(
          env.OPENCODE_TIMEOUT_MS || process.env.OPENCODE_TIMEOUT_MS || "3600000",
          3600000,
        ),
      );

      // Discover providers from OpenCode (live query)
      let snapshot = null;
      try {
        info("Querying OpenCode for available providers...");
        snapshot = await discoverProviders({ force: true });
      } catch (err) {
        console.warn(chalk.yellow(`  Could not query OpenCode providers: ${err.message}`));
      }

      if (snapshot && snapshot.providers.length > 0) {
        // Show connected vs all providers
        const connectedProviders = snapshot.connected || [];
        const allProviders = snapshot.providers;

        if (connectedProviders.length > 0) {
          console.log(chalk.green(`  ✓ ${connectedProviders.length} connected provider(s): `) +
            connectedProviders.map((p) => p.id).join(", "));
        }
        console.log(chalk.dim(`  ${allProviders.length} total provider(s) available in OpenCode\n`));

        // Ask user how they want to configure OpenCode providers
        const configModeIdx = await prompt.choose(
          "OpenCode provider configuration:",
          [
            "Auto — use OpenCode defaults (recommended for single-provider)",
            "Select provider — choose one provider for this executor",
            "Multi-provider — configure multiple OpenCode executors with different providers",
            "Manual — set OPENCODE_MODEL env var directly",
          ],
          0,
        );

        if (configModeIdx === 0) {
          // Auto mode — let OpenCode use its configured default
          info("OpenCode will use its configured default provider and model.");
          env.OPENCODE_MODEL = "";

        } else if (configModeIdx === 1) {
          // Select a single provider
          const providerMenuItems = formatProvidersForMenu(allProviders);
          const providerIdx = await prompt.choose(
            "Select OpenCode provider:",
            providerMenuItems,
            connectedProviders.length > 0
              ? allProviders.findIndex((p) => p.id === connectedProviders[0].id)
              : 0,
          );
          const selectedProvider = allProviders[providerIdx];

          if (selectedProvider && selectedProvider.models.length > 0) {
            // Let user pick a model from the selected provider
            const modelMenuItems = formatModelsForMenu(selectedProvider.models);
            const modelIdx = await prompt.choose(
              `Select model from ${selectedProvider.name}:`,
              modelMenuItems.length > 20
                ? [...modelMenuItems.slice(0, 20), `... and ${modelMenuItems.length - 20} more (type model name manually)`]
                : modelMenuItems,
              0,
            );

            if (modelIdx < selectedProvider.models.length) {
              const selectedModel = selectedProvider.models[modelIdx];
              env.OPENCODE_MODEL = selectedModel.fullId;
              env.OPENCODE_PROVIDER_ID = selectedProvider.id;
              info(`Selected: ${selectedModel.fullId}`);

              // Update executor entry with provider info
              if (configJson.executors) {
                for (const ex of configJson.executors) {
                  if (ex.executor === "OPENCODE" && !ex.provider) {
                    ex.provider = selectedProvider.id;
                    ex.providerConfig = { model: selectedModel.fullId };
                  }
                }
              }
            } else {
              // User selected "more" — ask for manual model input
              const manualModel = await prompt.ask(
                `Model ID (format: ${selectedProvider.id}/model-name)`,
                `${selectedProvider.id}/`,
              );
              env.OPENCODE_MODEL = manualModel;
              env.OPENCODE_PROVIDER_ID = selectedProvider.id;
            }
          } else if (selectedProvider) {
            // Provider has no models listed — manual input
            const manualModel = await prompt.ask(
              `Model ID for ${selectedProvider.name} (format: provider/model)`,
              `${selectedProvider.id}/`,
            );
            env.OPENCODE_MODEL = manualModel;
            env.OPENCODE_PROVIDER_ID = selectedProvider.id;
          }

          // Check if provider is connected, offer auth guidance
          if (selectedProvider && !selectedProvider.connected) {
            console.log(chalk.yellow(`\n  ⚠ ${selectedProvider.name} is not connected yet.`));
            const authMethods = selectedProvider.authMethods || [];
            if (authMethods.length > 0) {
              console.log(chalk.dim("  Available auth methods:"));
              for (const m of authMethods) {
                console.log(chalk.dim(`    - ${m.label} (${m.type})`));
              }
            }
            console.log(chalk.dim("  Run: opencode auth login    to add credentials\n"));
          }

        } else if (configModeIdx === 2) {
          // Multi-provider mode — build multiple OpenCode executors
          console.log(chalk.dim("\n  Configure multiple OpenCode executors, each with a different provider.\n"));
          const multiExecutors = [];
          let addMore = true;

          while (addMore) {
            const providerMenuItems = formatProvidersForMenu(allProviders);
            const providerIdx = await prompt.choose(
              `Provider for executor #${multiExecutors.length + 1}:`,
              providerMenuItems,
              0,
            );
            const selectedProvider = allProviders[providerIdx];

            let selectedModelFullId = `${selectedProvider.id}/`;
            if (selectedProvider.models.length > 0) {
              const modelMenuItems = formatModelsForMenu(selectedProvider.models);
              const displayModels = modelMenuItems.length > 15
                ? [...modelMenuItems.slice(0, 15), `... and ${modelMenuItems.length - 15} more`]
                : modelMenuItems;
              const modelIdx = await prompt.choose(
                `Model from ${selectedProvider.name}:`,
                displayModels,
                0,
              );
              if (modelIdx < selectedProvider.models.length) {
                selectedModelFullId = selectedProvider.models[modelIdx].fullId;
              } else {
                selectedModelFullId = await prompt.ask(
                  `Model ID (format: ${selectedProvider.id}/model-name)`,
                  selectedModelFullId,
                );
              }
            } else {
              selectedModelFullId = await prompt.ask(
                `Model ID (format: ${selectedProvider.id}/model-name)`,
                selectedModelFullId,
              );
            }

            const weight = toPositiveInt(
              await prompt.ask(`Weight for ${selectedProvider.id}`, "100"),
              100,
            );

            multiExecutors.push(
              buildExecutorEntry(selectedProvider.id, selectedModelFullId, { weight }),
            );
            info(`Added: ${selectedModelFullId} (weight ${weight})`);

            addMore = await prompt.confirm("Add another OpenCode provider?", false);
          }

          if (multiExecutors.length > 0) {
            // Replace OpenCode executors in config
            configJson.executors = (configJson.executors || [])
              .filter((e) => e.executor !== "OPENCODE")
              .concat(multiExecutors);
            info(`Configured ${multiExecutors.length} OpenCode executor(s)`);
          }

        } else {
          // Manual mode
          env.OPENCODE_MODEL = await prompt.ask(
            "OPENCODE_MODEL (provider/model format, e.g. anthropic/claude-sonnet-4-20250514)",
            env.OPENCODE_MODEL || process.env.OPENCODE_MODEL || "",
          );
        }
      } else {
        // No providers discovered — fall back to manual config
        console.log(chalk.yellow("  Could not discover OpenCode providers (is opencode installed?).\n"));
        console.log(chalk.dim("  Tip: Install opencode, then run 'opencode auth login' to add providers.\n"));
        env.OPENCODE_MODEL = await prompt.ask(
          "OPENCODE_MODEL (provider/model format, or blank for default)",
          env.OPENCODE_MODEL || process.env.OPENCODE_MODEL || "",
        );
      }

      info(
        `OpenCode config: port=${env.OPENCODE_PORT}, timeout=${env.OPENCODE_TIMEOUT_MS}ms` +
        (env.OPENCODE_MODEL ? `, model=${env.OPENCODE_MODEL}` : ", model=auto"),
      );
    } else {
      info("OpenCode SDK not in executor preset — skipping OpenCode configuration.");
    }

    // ── 5f. Voice Mode ─────────────────────────────────────
    console.log(chalk.bold("\n  Voice Mode") + chalk.dim(" (Realtime voice assistant)\n"));
    const enableVoice = await prompt.confirm(
      "Enable voice mode in the UI?",
      parseBooleanEnvValue(process.env.VOICE_ENABLED, true),
    );
    env.VOICE_ENABLED = enableVoice ? "true" : "false";
    if (enableVoice) {
      const providerIdx = await prompt.choose(
        "Voice provider:",
        [
          "auto (recommended)",
          "openai",
          "azure",
          "claude (fallback voice + Claude vision)",
          "gemini (fallback voice + Gemini vision)",
          "fallback (browser speech only)",
        ],
        0,
      );
      const providerOptions = ["auto", "openai", "azure", "claude", "gemini", "fallback"];
      env.VOICE_PROVIDER = providerOptions[providerIdx] || "auto";

      env.VOICE_ID = await prompt.ask(
        "Voice ID",
        process.env.VOICE_ID || "alloy",
      );
      env.VOICE_MODEL = await prompt.ask(
        "Realtime voice model",
        process.env.VOICE_MODEL || "gpt-realtime-1.5",
      );
      env.VOICE_VISION_MODEL = await prompt.ask(
        "Vision model for camera/screen analysis",
        process.env.VOICE_VISION_MODEL || "gpt-4.1-mini",
      );
      env.VOICE_TURN_DETECTION = await prompt.ask(
        "Turn detection (server_vad|semantic_vad|none)",
        process.env.VOICE_TURN_DETECTION || "semantic_vad",
      );
      env.VOICE_FALLBACK_MODE = await prompt.ask(
        "Fallback mode (browser|disabled)",
        process.env.VOICE_FALLBACK_MODE || "browser",
      );
      env.VOICE_DELEGATE_EXECUTOR = await prompt.ask(
        "Delegate executor (codex-sdk|copilot-sdk|claude-sdk|gemini-sdk|opencode-sdk)",
        process.env.VOICE_DELEGATE_EXECUTOR || env.PRIMARY_AGENT || "codex-sdk",
      );
      if (env.VOICE_PROVIDER === "openai" || env.VOICE_PROVIDER === "auto") {
        env.OPENAI_REALTIME_API_KEY = await prompt.ask(
          "OpenAI Realtime key (OPENAI_REALTIME_API_KEY, blank uses OPENAI_API_KEY)",
          process.env.OPENAI_REALTIME_API_KEY || env.OPENAI_API_KEY || "",
        );
      }
      if (env.VOICE_PROVIDER === "azure" || env.VOICE_PROVIDER === "auto") {
        env.AZURE_OPENAI_REALTIME_ENDPOINT = await prompt.ask(
          "Azure Realtime endpoint (AZURE_OPENAI_REALTIME_ENDPOINT)",
          process.env.AZURE_OPENAI_REALTIME_ENDPOINT || process.env.AZURE_OPENAI_ENDPOINT || "",
        );
        env.AZURE_OPENAI_REALTIME_API_KEY = await prompt.ask(
          "Azure Realtime key (AZURE_OPENAI_REALTIME_API_KEY, blank uses AZURE_OPENAI_API_KEY)",
          process.env.AZURE_OPENAI_REALTIME_API_KEY || process.env.AZURE_OPENAI_API_KEY || "",
        );
        env.AZURE_OPENAI_REALTIME_DEPLOYMENT = await prompt.ask(
          "Azure Realtime deployment (AZURE_OPENAI_REALTIME_DEPLOYMENT)",
          process.env.AZURE_OPENAI_REALTIME_DEPLOYMENT || "gpt-realtime-1.5",
        );
      }
      if (env.VOICE_PROVIDER === "claude" && !env.ANTHROPIC_API_KEY) {
        env.ANTHROPIC_API_KEY = await prompt.ask(
          "Anthropic API key for Claude voice/vision fallback (ANTHROPIC_API_KEY)",
          process.env.ANTHROPIC_API_KEY || "",
        );
      }
      if (
        env.VOICE_PROVIDER === "gemini" &&
        !env.GEMINI_API_KEY &&
        !env.GOOGLE_API_KEY
      ) {
        const geminiVoiceKey = await prompt.ask(
          "Gemini API key for Gemini voice/vision fallback (GEMINI_API_KEY or GOOGLE_API_KEY)",
          process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "",
        );
        if (geminiVoiceKey) {
          env.GEMINI_API_KEY = geminiVoiceKey;
        }
      }
    }
    saveSetupSnapshot(5, "AI Provider Keys", env, configJson);
    } // end step 5

    // ── Step 6: Telegram ──────────────────────────────────
    if (resumeFromStep > 6) {
      info(`Skipping step 6 (restored from previous run).`);
    } else {
    headingStepWithSnapshot(6, "Telegram Notifications");
    console.log(
      "  The Telegram bot sends real-time notifications and lets you\n" +
        "  control the orchestrator via /status, /tasks, /restart, etc.\n",
    );

    const wantTelegram = await prompt.confirm(
      "Set up Telegram notifications?",
      true,
    );
    if (wantTelegram) {
      // Step 1: Create bot
      console.log(
        "\n" +
          chalk.bold("Step 1: Create Your Bot") +
          chalk.dim(" (if you haven't already)"),
      );
      console.log(
        "  1. Open Telegram and search for " + chalk.cyan("@BotFather"),
      );
      console.log("  2. Send: " + chalk.cyan("/newbot"));
      console.log("  3. Choose a display name (e.g., 'MyProject Monitor')");
      console.log(
        "  4. Choose a username ending in 'bot' (e.g., 'myproject_monitor_bot')",
      );
      console.log("  5. Copy the bot token BotFather gives you");
      console.log();

      const hasBotReady = await prompt.confirm(
        "Have you created your bot and have the token ready?",
        false,
      );

      if (!hasBotReady) {
        warn("No problem! You can set up Telegram later by:");
        console.log("  1. Adding TELEGRAM_BOT_TOKEN to .env");
        console.log("  2. Adding TELEGRAM_CHAT_ID to .env");
        console.log("  3. Or re-running: bosun --setup");
        console.log();
      } else {
        // Step 2: Get bot token
        console.log("\n" + chalk.bold("Step 2: Enter Your Bot Token"));
        console.log(
          chalk.dim(
            "  Looks like: 1234567890:ABCdefGHIjklMNOpqrsTUVwxyz-1234567890",
          ),
        );
        console.log();

        env.TELEGRAM_BOT_TOKEN = await prompt.ask(
          "Bot Token",
          process.env.TELEGRAM_BOT_TOKEN || "",
        );

        if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_BOT_TOKEN.length > 20) {
          // Validate token format
          const tokenValid = /^\d+:[A-Za-z0-9_-]+$/.test(
            env.TELEGRAM_BOT_TOKEN,
          );
          if (!tokenValid) {
            warn(
              "Token format looks incorrect. Make sure you copied the full token from BotFather.",
            );
          } else {
            info("✓ Token format looks good");
          }

          // Step 3: Get chat ID
          console.log("\n" + chalk.bold("Step 3: Get Your Chat ID"));
          console.log("  Your chat ID tells the bot where to send messages.");
          console.log();

          const knowsChatId = await prompt.confirm(
            "Do you already know your chat ID?",
            false,
          );

          if (knowsChatId) {
            env.TELEGRAM_CHAT_ID = await prompt.ask(
              "Chat ID (numeric, e.g., 123456789)",
              process.env.TELEGRAM_CHAT_ID || "",
            );
          } else {
            // Guide user to get chat ID
            console.log("\n" + chalk.cyan("To get your chat ID:") + "\n");
            console.log(
              "  1. Open Telegram and search for your bot's username",
            );
            console.log(
              "  2. Click " +
                chalk.cyan("START") +
                " or send any message (e.g., 'Hello')",
            );
            console.log("  3. Come back here and we'll detect your chat ID");
            console.log();

            const ready = await prompt.confirm(
              "Ready? (I've messaged my bot)",
              false,
            );

            if (ready) {
              // Try to fetch chat ID from Telegram API
              info("Fetching your chat ID from Telegram...");
              try {
                const discovery = await discoverTelegramChats(env.TELEGRAM_BOT_TOKEN);

                if (discovery.chats.length === 1) {
                  env.TELEGRAM_CHAT_ID = String(discovery.chats[0].id);
                  info(`✓ Found your chat ID: ${env.TELEGRAM_CHAT_ID}`);
                  console.log();
                } else if (discovery.chats.length > 1) {
                  const selectedIdx = await prompt.choose(
                    "Select the chat Bosun should use:",
                    discovery.chats.map(formatTelegramChatChoice),
                    0,
                  );
                  const selectedChat = discovery.chats[selectedIdx];
                  env.TELEGRAM_CHAT_ID = String(selectedChat.id);
                  info(`✓ Selected chat ID: ${env.TELEGRAM_CHAT_ID}`);
                  console.log();
                } else {
                  warn(
                    discovery.message ||
                    "Couldn't find a chat ID. Make sure you sent a message to your bot.",
                  );
                  console.log(
                    chalk.dim(
                      "  Or run: bosun-chat-id (after starting the bot)",
                    ),
                  );
                  env.TELEGRAM_CHAT_ID = await prompt.ask(
                    "Enter chat ID manually (or leave empty to set up later)",
                    "",
                  );
                }
              } catch (err) {
                warn(`Failed to fetch chat ID: ${err.message}`);
                console.log(
                  chalk.dim(
                    "  You can run: bosun-chat-id (after starting the bot)",
                  ),
                );
                env.TELEGRAM_CHAT_ID = await prompt.ask(
                  "Enter chat ID manually (or leave empty to set up later)",
                  "",
                );
              }
            } else {
              console.log();
              info("No problem! You can get your chat ID later by:");
              console.log(
                "  • Running: " +
                  chalk.cyan("bosun-chat-id") +
                  " (after starting bosun)",
              );
              console.log(
                "  • Or manually: " +
                  chalk.cyan(
                    "curl 'https://api.telegram.org/bot<TOKEN>/getUpdates'",
                  ),
              );
              console.log("  Then add TELEGRAM_CHAT_ID to .env");
              console.log();
            }
          }

          // Step 4: Verify setup
          if (env.TELEGRAM_CHAT_ID) {
            console.log("\n" + chalk.bold("Step 4: Test Your Setup"));
            const testNow = await prompt.confirm(
              "Send a test message to verify setup?",
              true,
            );

            if (testNow) {
              info("Sending test message...");
              try {
                const projectLabel = escapeTelegramHtml(
                  env.PROJECT_NAME || configJson.projectName || "Unknown",
                );
                const testMsg =
                  ":bot: <b>Telegram Bot Test</b>\n\n" +
                  "Your bosun Telegram bot is configured correctly!\n\n" +
                  `Project: ${projectLabel}\n` +
                  "Try: /status, /tasks, /help";

                const response = await fetch(
                  `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      chat_id: env.TELEGRAM_CHAT_ID,
                      text: testMsg,
                      parse_mode: "HTML",
                    }),
                  },
                );

                const result = await response.json();
                if (result.ok) {
                  info("✓ Test message sent! Check your Telegram.");
                } else {
                  warn(
                    `Test message failed: ${result.description || "Unknown error"}`,
                  );
                }
              } catch (err) {
                warn(`Failed to send test message: ${err.message}`);
              }
            }
          }
        } else {
          warn(
            "Bot token is required for Telegram setup. You can add it to .env later.",
          );
        }
      }
    }

    // ── Sub-step 6b: Web UI / Telegram Mini App / Cloudflare Tunnel ──────────
    const hasTelegramToken = !!(env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN);
    if (hasTelegramToken) {
      console.log();
      console.log(chalk.bold("  Web UI & Telegram Mini App"));
      console.log(
        chalk.dim("  Bosun includes a browser-based dashboard that can open inside Telegram\n") +
        chalk.dim("  as a Mini App. External HTTPS access is provided via a Cloudflare tunnel\n") +
        chalk.dim("  (cloudflared). Without the tunnel, the UI is LAN-only.\n"),
      );

      const wantWebUi = await prompt.confirm(
        "Enable browser Web UI / Telegram Mini App?",
        true,
      );

      if (!wantWebUi) {
        env.TELEGRAM_MINIAPP_ENABLED = "false";
        env.TELEGRAM_UI_TUNNEL = "disabled";
        info("Web UI disabled. Re-run setup or add TELEGRAM_MINIAPP_ENABLED=true to .env to enable later.");
      } else {
        env.TELEGRAM_MINIAPP_ENABLED = "true";
        env.TELEGRAM_UI_PORT = normalizeTelegramUiPort(
          env.TELEGRAM_UI_PORT || process.env.TELEGRAM_UI_PORT,
        );
        env.TELEGRAM_UI_ALLOW_UNSAFE = "false";

        console.log();
        const tunnelModeIdx = await prompt.choose(
          "How should the Web UI be exposed externally?",
          [
            "Quick tunnel  — ephemeral trycloudflare.com URL (simplest, no account needed)",
            "Named tunnel  — permanent custom URL (requires Cloudflare account + credentials)",
            "LAN only      — local network access only, no public tunnel",
          ],
          0,
        );

        if (tunnelModeIdx === 0) {
          // ── Quick tunnel ──────────────────────────────────────────────────
          env.TELEGRAM_UI_TUNNEL = "quick";
          env.TELEGRAM_UI_ALLOW_QUICK_TUNNEL_FALLBACK = "true";
          info("✓ Quick tunnel selected — a trycloudflare.com URL will appear on startup.");
          console.log(chalk.dim("  The URL changes on restart. Install cloudflared if not already present:"));
          console.log(chalk.dim("    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"));

        } else if (tunnelModeIdx === 1) {
          // ── Named tunnel ──────────────────────────────────────────────────
          env.TELEGRAM_UI_TUNNEL = "named";

          console.log();
          console.log(chalk.bold("  Named Tunnel Setup"));
          console.log(
            chalk.dim("  Prerequisites:\n") +
            chalk.dim("    1. Cloudflare account with a registered domain\n") +
            chalk.dim("    2. cloudflared CLI installed:\n") +
            chalk.dim("         https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n") +
            chalk.dim("    3. Run:  cloudflared tunnel login\n") +
            chalk.dim("    4. Run:  cloudflared tunnel create <your-tunnel-name>\n") +
            chalk.dim("    5. Copy the credentials JSON path shown (e.g. ~/.cloudflared/<uuid>.json)\n"),
          );

          const hasCredsReady = await prompt.confirm(
            "Do you have your tunnel credentials file ready?",
            false,
          );

          if (hasCredsReady) {
            env.CLOUDFLARE_TUNNEL_NAME = await prompt.ask(
              "Tunnel name  (from: cloudflared tunnel create <name>)",
              process.env.CLOUDFLARE_TUNNEL_NAME || "",
            );
            env.CLOUDFLARE_TUNNEL_CREDENTIALS = await prompt.ask(
              "Credentials file path  (e.g. ~/.cloudflared/<uuid>.json)",
              process.env.CLOUDFLARE_TUNNEL_CREDENTIALS || "",
            );
            env.CLOUDFLARE_BASE_DOMAIN = await prompt.ask(
              "Your Cloudflare domain  (e.g. example.com — used for auto hostname)",
              process.env.CLOUDFLARE_BASE_DOMAIN || "",
            );

            if (isAdvancedSetup) {
              const explicitHostname = await prompt.ask(
                "Custom hostname (leave blank for auto: bosun-<username>.<domain>)",
                process.env.CLOUDFLARE_TUNNEL_HOSTNAME || "",
              );
              if (explicitHostname) {
                env.CLOUDFLARE_TUNNEL_HOSTNAME = explicitHostname;
              }

              const cfApiToken = await prompt.ask(
                "Cloudflare API token for DNS auto-sync (optional — leave blank to skip)",
                process.env.CLOUDFLARE_API_TOKEN || "",
              );
              if (cfApiToken) {
                env.CLOUDFLARE_API_TOKEN = cfApiToken;
                env.CLOUDFLARE_DNS_SYNC_ENABLED = "true";
                const cfZoneId = await prompt.ask(
                  "Cloudflare Zone ID  (from your domain's Overview page)",
                  process.env.CLOUDFLARE_ZONE_ID || "",
                );
                if (cfZoneId) env.CLOUDFLARE_ZONE_ID = cfZoneId;
              }
            }

            const hasNameAndCreds = env.CLOUDFLARE_TUNNEL_NAME && env.CLOUDFLARE_TUNNEL_CREDENTIALS;
            if (hasNameAndCreds) {
              env.TELEGRAM_UI_ALLOW_QUICK_TUNNEL_FALLBACK = "false";
              info("✓ Named tunnel configured.");
              if (!env.CLOUDFLARE_BASE_DOMAIN && !process.env.CLOUDFLARE_BASE_DOMAIN) {
                warn("No base domain set — hostname auto-resolution will fail. Set CLOUDFLARE_BASE_DOMAIN in .env.");
              }
            } else {
              warn("Tunnel name or credentials path missing — enabling quick tunnel as fallback.");
              warn("Add CLOUDFLARE_TUNNEL_NAME + CLOUDFLARE_TUNNEL_CREDENTIALS to .env to activate named tunnel.");
              env.TELEGRAM_UI_ALLOW_QUICK_TUNNEL_FALLBACK = "true";
            }
          } else {
            warn("No problem! Add these to .env when ready:");
            console.log(chalk.cyan("  CLOUDFLARE_TUNNEL_NAME=<tunnel-name>"));
            console.log(chalk.cyan("  CLOUDFLARE_TUNNEL_CREDENTIALS=~/.cloudflared/<uuid>.json"));
            console.log(chalk.cyan("  CLOUDFLARE_BASE_DOMAIN=example.com"));
            console.log();
            warn("Enabling quick tunnel as fallback until named tunnel credentials are in .env.");
            env.TELEGRAM_UI_ALLOW_QUICK_TUNNEL_FALLBACK = "true";
          }

        } else {
          // ── LAN only ──────────────────────────────────────────────────────
          env.TELEGRAM_UI_TUNNEL = "disabled";
          const lanPort = env.TELEGRAM_UI_PORT || "3080";
          info(`LAN-only mode — Web UI will be accessible at https://localhost:${lanPort}`);
          info("Note: Telegram Mini App requires an external HTTPS URL and will not work in LAN-only mode.");
          env.TELEGRAM_MINIAPP_ENABLED = "false";
        }

        if (isAdvancedSetup && tunnelModeIdx < 2) {
          console.log();
          const customPort = await prompt.ask(
            "Web UI port",
            String(env.TELEGRAM_UI_PORT || process.env.TELEGRAM_UI_PORT || "3080"),
          );
          env.TELEGRAM_UI_PORT = customPort || env.TELEGRAM_UI_PORT || "3080";
        }
      }
    } // end sub-step 6b

    saveSetupSnapshot(6, "Telegram Notifications", env, configJson);
    } // end step 6

    // ── Step 7: Kanban + Execution ─────────────────────────
    if (resumeFromStep > 7) {
      info(`Skipping step 7 (restored from previous run).`);
    } else {
    headingStepWithSnapshot(7, "Kanban & Execution");
    const workspaceChoices = buildWorkspaceChoices(configJson);
    const repoChoices = buildRepositoryChoices(configJson, repoRoot);
    let selectedRepoChoice = repoChoices[0] || null;
    let selectedWorkspaceChoice = null;

    if (workspaceChoices.length > 0) {
      console.log(
        chalk.dim(
          "  Multiple workspaces detected. Select which workspace this bosun instance should manage tasks for.",
        ),
      );
      const workspaceLabels = workspaceChoices.map((choice) => choice.label);
      workspaceLabels.push("Decide later (skip)");
      const defaultWorkspaceIdx = (() => {
        const active = String(
          configJson.activeWorkspace ||
            configJson.defaultWorkspace ||
            "",
        )
          .trim()
          .toLowerCase();
        if (active) {
          const matchIdx = workspaceChoices.findIndex((choice) => {
            const id = String(choice.id || "").trim().toLowerCase();
            const name = String(choice.name || "").trim().toLowerCase();
            return active === id || active === name;
          });
          if (matchIdx >= 0) return matchIdx;
        }
        return 0;
      })();
      const selectedIdx = await prompt.choose(
        "Primary workspace for task board",
        workspaceLabels,
        Math.min(defaultWorkspaceIdx, workspaceChoices.length - 1),
      );
      if (selectedIdx >= 0 && selectedIdx < workspaceChoices.length) {
        selectedWorkspaceChoice = workspaceChoices[selectedIdx];
        const selectedWorkspaceId =
          selectedWorkspaceChoice.id || selectedWorkspaceChoice.name || "";
        if (selectedWorkspaceId) {
          configJson.activeWorkspace = selectedWorkspaceId;
          configJson.defaultWorkspace = selectedWorkspaceId;
          env.BOSUN_WORKSPACE = selectedWorkspaceId;
        }
        const primaryRepo = findWorkspacePrimaryRepo(selectedWorkspaceChoice);
        if (primaryRepo) {
          selectedRepoChoice = {
            name: primaryRepo.name,
            slug: primaryRepo.slug,
            workspace: selectedWorkspaceChoice.label,
            value: primaryRepo.slug || primaryRepo.name,
          };
          if (selectedRepoChoice?.value) {
            configJson.defaultRepository = selectedRepoChoice.value;
          }
        }
      } else {
        selectedWorkspaceChoice = null;
      }
      console.log();
      info(
        "The kanban board manages tasks for this workspace. Individual tasks can target specific repos within the workspace.",
      );
      console.log();
    } else if (repoChoices.length > 1) {
      console.log(
        chalk.dim(
          "  Multiple repositories detected. Select which repo this bosun instance should manage tasks for.",
        ),
      );
      const repoLabels = repoChoices.map((choice) => choice.label);
      repoLabels.push("Decide later (skip)");
      const defaultRepoIdx = (() => {
        const slugDefault =
          process.env.GITHUB_REPOSITORY || env.GITHUB_REPO || "";
        if (slugDefault) {
          const matchIdx = repoChoices.findIndex(
            (choice) => choice.slug === slugDefault,
          );
          if (matchIdx >= 0) return matchIdx;
        }
        const primaryIdx = repoChoices.findIndex(
          (choice) => choice.slug && choice.slug === configJson?.repositories?.find((repo) => repo.primary)?.slug,
        );
        return primaryIdx >= 0 ? primaryIdx : 0;
      })();
      const selectedIdx = await prompt.choose(
        "Primary repo for task board",
        repoLabels,
        Math.min(defaultRepoIdx, repoChoices.length - 1),
      );
      if (selectedIdx >= 0 && selectedIdx < repoChoices.length) {
        selectedRepoChoice = repoChoices[selectedIdx];
        if (selectedRepoChoice?.value) {
          configJson.defaultRepository = selectedRepoChoice.value;
        }
      } else {
        selectedRepoChoice = null;
      }
    } else if (selectedRepoChoice?.value) {
      configJson.defaultRepository = selectedRepoChoice.value;
    }

    const backendDefault = String(
      process.env.KANBAN_BACKEND || configJson.kanban?.backend || "internal",
    )
      .trim()
      .toLowerCase();
    let selectedKanbanBackend = "internal";
    let skipGitHubProjectSetup = false;
    while (true) {
      const backendIdx = await prompt.choose(
        "Select task board backend:",
        [
          "Internal Store (internal, recommended primary)",
          "GitHub Issues (github)",
          "Jira Issues (jira)",
        ],
        backendDefault === "github"
            ? 1
            : backendDefault === "jira"
              ? 2
              : 0,
      );
      selectedKanbanBackend =
        backendIdx === 1
          ? "github"
          : backendIdx === 2
            ? "jira"
            : "internal";

      if (selectedKanbanBackend !== "github") break;

      const ghStatus = getGitHubAuthStatus(repoRoot);
      if (ghStatus.ok) break;

      warn(
        `GitHub auth is required to auto-detect projects, create boards, and sync issues. ${ghStatus.reason || ""}`.trim(),
      );
      info(
        "If you do not plan to use GitHub as the task manager, pick Internal or Jira.",
      );
      info("Authenticate with GitHub using: gh auth login");
      const ghActionIdx = await prompt.choose(
        "How do you want to proceed?",
        [
          "Continue with GitHub (skip Projects setup for now)",
          "Choose a different backend",
          "Exit setup",
        ],
        1,
      );
      if (ghActionIdx === 0) {
        skipGitHubProjectSetup = true;
        break;
      }
      if (ghActionIdx === 1) {
        continue;
      }
      aborted = true;
      break;
    }
    if (aborted) {
      return;
    }
    env.KANBAN_BACKEND = selectedKanbanBackend;
    const syncPolicyIdx = await prompt.choose(
      "Select sync policy:",
      [
        "Internal primary (recommended) — external is secondary mirror",
        "Bidirectional (legacy) — external can drive internal status",
      ],
      0,
    );
    const selectedSyncPolicy =
      syncPolicyIdx === 1 ? "bidirectional" : "internal-primary";
    env.KANBAN_SYNC_POLICY = selectedSyncPolicy;
    configJson.kanban = {
      backend: selectedKanbanBackend,
      syncPolicy: selectedSyncPolicy,
    };

    const modeDefault = String(
      process.env.EXECUTOR_MODE || configJson.internalExecutor?.mode || "internal",
    )
      .trim()
      .toLowerCase();
    const execModeIdx = await prompt.choose(
      "Select execution mode:",
      [
        "Internal executor (recommended)",
      ],
      0,
    );
    const selectedExecutorMode = "internal";
    env.EXECUTOR_MODE = selectedExecutorMode;
    configJson.internalExecutor = {
      ...(configJson.internalExecutor || {}),
      mode: selectedExecutorMode,
    };

    const requirementsProfileDefault = String(
      process.env.PROJECT_REQUIREMENTS_PROFILE ||
        configJson.projectRequirements?.profile ||
        "feature",
    )
      .trim()
      .toLowerCase();
    const profileOptions = [
      "simple-feature",
      "feature",
      "large-feature",
      "system",
      "multi-system",
    ];
    const profileIdx = await prompt.choose(
      "Project requirements profile:",
      [
        "Simple Feature",
        "Feature",
        "Large Feature",
        "System",
        "Multi-System",
      ],
      Math.max(0, profileOptions.indexOf(requirementsProfileDefault)),
    );
    env.PROJECT_REQUIREMENTS_PROFILE = profileOptions[profileIdx] || "feature";
    const requirementsNotes = await prompt.ask(
      "Requirements notes (optional)",
      process.env.PROJECT_REQUIREMENTS_NOTES ||
        configJson.projectRequirements?.notes ||
        "",
    );
    env.PROJECT_REQUIREMENTS_NOTES = requirementsNotes;
    configJson.projectRequirements = {
      profile: env.PROJECT_REQUIREMENTS_PROFILE,
      notes: env.PROJECT_REQUIREMENTS_NOTES,
    };

    const replenishEnabled = await prompt.confirm(
      "Enable experimental autonomous backlog replenishment?",
      false,
    );
    env.INTERNAL_EXECUTOR_REPLENISH_ENABLED = replenishEnabled
      ? "true"
      : "false";
    const replenishMin = replenishEnabled
      ? await prompt.ask(
          "Minimum new tasks per completed task (1-2)",
          process.env.INTERNAL_EXECUTOR_REPLENISH_MIN_NEW_TASKS || "1",
        )
      : "1";
    const replenishMax = replenishEnabled
      ? await prompt.ask(
          "Maximum new tasks per completed task (1-3)",
          process.env.INTERNAL_EXECUTOR_REPLENISH_MAX_NEW_TASKS || "2",
        )
      : "2";
    env.INTERNAL_EXECUTOR_REPLENISH_MIN_NEW_TASKS = replenishMin;
    env.INTERNAL_EXECUTOR_REPLENISH_MAX_NEW_TASKS = replenishMax;
    configJson.internalExecutor = {
      ...(configJson.internalExecutor || {}),
      backlogReplenishment: {
        enabled: replenishEnabled,
        minNewTasks: toPositiveInt(replenishMin, 1),
        maxNewTasks: toPositiveInt(replenishMax, 2),
        requirePriority: true,
      },
      projectRequirements: {
        profile: env.PROJECT_REQUIREMENTS_PROFILE,
        notes: env.PROJECT_REQUIREMENTS_NOTES,
      },
    };

    const workflowProfiles = listWorkflowSetupProfiles();
    const workflowProfileIds = workflowProfiles.map((profile) => profile.id);
    const workflowProfileLabels = workflowProfiles.map((profile) => `${profile.name} — ${profile.description}`);
    const workflowProfileDefault = String(
      env.WORKFLOW_DEFAULT_PROFILE || configJson.workflowDefaults?.profile || "balanced",
    ).trim().toLowerCase() || "balanced";
    const workflowProfileIdx = await prompt.choose(
      "Workflow install profile:",
      workflowProfileLabels,
      Math.max(0, workflowProfileIds.indexOf(workflowProfileDefault)),
    );
    const selectedWorkflowProfile = workflowProfileIds[workflowProfileIdx] || "balanced";
    const defaultWorkflowTemplateIds = resolveWorkflowTemplateIds({ profileId: selectedWorkflowProfile });
    const selectedWorkflowTemplateIds = normalizeWorkflowTemplateIdList(
      configJson.workflowDefaults?.templates,
      defaultWorkflowTemplateIds,
    );
    env.WORKFLOW_DEFAULT_PROFILE = selectedWorkflowProfile;
    env.WORKFLOW_DEFAULT_TEMPLATES = selectedWorkflowTemplateIds.length > 0
      ? selectedWorkflowTemplateIds.join(",")
      : "none";
    env.WORKFLOW_DEFAULT_AUTOINSTALL = toBooleanEnvString(
      await prompt.confirm(
        "Auto-install selected workflow templates on startup?",
        parseBooleanEnvValue(
          env.WORKFLOW_DEFAULT_AUTOINSTALL ?? configJson.workflowDefaults?.autoInstall,
          true,
        ),
      ),
      true,
    );
    env.BOSUN_PR_ASSISTIVE_ACTIONS_INSTALL_ON_SETUP = toBooleanEnvString(
      await prompt.confirm(
        "Install optional assistive GitHub Actions into configured repos during setup?",
        parseBooleanEnvValue(
          env.BOSUN_PR_ASSISTIVE_ACTIONS_INSTALL_ON_SETUP
            ?? configJson.prAutomation?.assistiveActions?.installOnSetup,
          false,
        ),
      ),
      false,
    );
    configJson.prAutomation = {
      ...(configJson.prAutomation && typeof configJson.prAutomation === "object" ? configJson.prAutomation : {}),
      assistiveActions: {
        ...(configJson.prAutomation?.assistiveActions && typeof configJson.prAutomation.assistiveActions === "object"
          ? configJson.prAutomation.assistiveActions
          : {}),
        installOnSetup: parseBooleanEnvValue(env.BOSUN_PR_ASSISTIVE_ACTIONS_INSTALL_ON_SETUP, false),
      },
    };
    const workflowOverrides = await promptForWorkflowTemplateOverrides(
      prompt,
      selectedWorkflowTemplateIds,
      configJson.workflowDefaults?.templateOverridesById || {},
    );
    configJson.workflowDefaults = {
      profile: selectedWorkflowProfile,
      autoInstall: parseBooleanEnvValue(env.WORKFLOW_DEFAULT_AUTOINSTALL, true),
      templates: selectedWorkflowTemplateIds,
      templateOverridesById: workflowOverrides,
    };

    if (selectedKanbanBackend === "github") {
      const githubRepoChoices = selectedWorkspaceChoice
        ? buildRepositoryChoices(configJson, repoRoot, {
            workspaceId: selectedWorkspaceChoice.id || selectedWorkspaceChoice.name,
            includeWorkspacePrefix: false,
          })
        : repoChoices;
      const primaryRepoSlug =
        selectedRepoChoice?.slug ||
        configJson.repositories?.find((repo) => repo.primary && repo.slug)?.slug ||
        "";
      const repoSlugDefaults = [
        process.env.GITHUB_REPOSITORY,
        process.env.GITHUB_REPO,
        env.GITHUB_REPO,
        primaryRepoSlug,
        slug,
      ]
        .map((entry) => String(entry || "").trim())
        .filter(Boolean);
      const repoSlugDefault = repoSlugDefaults[0] || "";

      info(
        "Pick the repo that should receive tasks (issues/projects). If you have multiple orgs, use the owner for that repo.",
      );
      let repoInput = repoSlugDefault;
      if (githubRepoChoices.length > 1) {
        const repoLabels = githubRepoChoices.map((choice) => choice.label);
        repoLabels.push("Enter manually");
        const repoIdx = await prompt.choose(
          "Select GitHub repo for tasks",
          repoLabels,
          githubRepoChoices.findIndex(
            (choice) => choice.slug && choice.slug === repoSlugDefault,
          ) >= 0
            ? githubRepoChoices.findIndex(
                (choice) => choice.slug && choice.slug === repoSlugDefault,
              )
            : 0,
        );
        if (repoIdx >= 0 && repoIdx < githubRepoChoices.length) {
          repoInput =
            githubRepoChoices[repoIdx]?.slug ||
            githubRepoChoices[repoIdx]?.name ||
            repoSlugDefault;
        } else {
          repoInput = await prompt.ask(
            "GitHub repository for tasks (owner/repo or URL)",
            repoSlugDefault,
          );
        }
      } else {
        repoInput = await prompt.ask(
          "GitHub repository for tasks (owner/repo or URL)",
          repoSlugDefault,
        );
      }
      const parsedRepoSlug = parseRepoSlugFromUrl(repoInput || repoSlugDefault);
      if (parsedRepoSlug) {
        const [repoOwner, repoName] = parsedRepoSlug.split("/", 2);
        env.GITHUB_REPO_OWNER = repoOwner || "";
        env.GITHUB_REPO_NAME = repoName || "";
      } else {
        const [slugOwner, slugRepo] = String(slug || "").split("/", 2);
        env.GITHUB_REPO_OWNER = await prompt.ask(
          "GitHub owner/org",
          process.env.GITHUB_REPO_OWNER || slugOwner || "",
        );
        env.GITHUB_REPO_NAME = await prompt.ask(
          "GitHub repository name",
          process.env.GITHUB_REPO_NAME || slugRepo || basename(repoRoot),
        );
      }
      if (env.GITHUB_REPO_OWNER && env.GITHUB_REPO_NAME) {
        env.GITHUB_REPOSITORY = `${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}`;
        env.GITHUB_REPO = env.GITHUB_REPOSITORY;
        env.KANBAN_PROJECT_ID = env.GITHUB_REPOSITORY;
      }

      if (env.GITHUB_REPOSITORY && !skipGitHubProjectSetup) {
        const repoCheck = tryRunGhCommand(
          ["repo", "view", env.GITHUB_REPOSITORY, "--json", "name", "--jq", ".name"],
          repoRoot,
        );
        if (!repoCheck.ok) {
          warn(
            `Could not access repo via gh: ${env.GITHUB_REPOSITORY}. ${repoCheck.error || ""}`.trim(),
          );
          const repoActionIdx = await prompt.choose(
            "Continue with GitHub backend?",
            [
              "Continue (use GitHub anyway)",
              "Switch to a different backend",
              "Exit setup",
            ],
            0,
          );
          if (repoActionIdx === 1) {
            selectedKanbanBackend = "internal";
            env.KANBAN_BACKEND = selectedKanbanBackend;
          } else if (repoActionIdx === 2) {
            aborted = true;
            return;
          }
        }
      }

      // If backend was switched away from github during repo validation, skip remaining GitHub-specific setup
      if (selectedKanbanBackend !== "github") {
        configJson.kanban = {
          backend: selectedKanbanBackend,
          syncPolicy: selectedSyncPolicy,
        };
        info("Backend switched from GitHub. Skipping GitHub-specific configuration.");
      } else {

      let detectedLogin = "";
      try {
        detectedLogin = detectGitHubUserLogin(repoRoot);
      } catch (err) {
        warn(`Could not detect GitHub login: ${formatGhErrorReason(err)}`);
      }

      const githubTaskModeDefault = String(
        process.env.GITHUB_PROJECT_MODE ||
          configJson.kanban?.github?.mode ||
          (skipGitHubProjectSetup ? "issues" : "kanban"),
      )
        .trim()
        .toLowerCase();
      const githubTaskModeIdx = await prompt.choose(
        "Use GitHub backend as:",
        [
          "GitHub Projects Kanban (default)",
          "GitHub Issues only (no Projects board)",
        ],
        githubTaskModeDefault === "issues" ? 1 : 0,
      );
      let githubTaskMode = githubTaskModeIdx === 1 ? "issues" : "kanban";
      if (skipGitHubProjectSetup && githubTaskMode === "kanban") {
        const downgrade = await prompt.confirm(
          "GitHub auth is missing. Switch to Issues-only mode for now?",
          true,
        );
        if (downgrade) githubTaskMode = "issues";
      }

      if (githubTaskMode === "kanban" && !skipGitHubProjectSetup) {
        const scopes = getGitHubAuthScopes(repoRoot);
        const missingScopes = [];
        if (!scopes.includes("project")) missingScopes.push("project");
        if (
          detectedLogin &&
          env.GITHUB_REPO_OWNER &&
          env.GITHUB_REPO_OWNER !== detectedLogin
        ) {
          if (!scopes.includes("read:org")) missingScopes.push("read:org");
        }
        if (missingScopes.length > 0) {
          warn(
            `GitHub token is missing scopes required for Projects: ${missingScopes.join(
              ", ",
            )}.`,
          );
          info(
            "Run: gh auth refresh -h github.com -s project,repo,read:org",
          );
          const scopeActionIdx = await prompt.choose(
            "Proceed without Projects?",
            [
              "Use Issues-only for now",
              "Continue and try Projects anyway",
              "Exit setup",
            ],
            0,
          );
          if (scopeActionIdx === 0) {
            githubTaskMode = "issues";
          } else if (scopeActionIdx === 2) {
            aborted = true;
            return;
          }
        }
      }
      env.GITHUB_PROJECT_MODE = githubTaskMode;
      if (!env.GITHUB_DEFAULT_ASSIGNEE) {
        env.GITHUB_DEFAULT_ASSIGNEE =
          process.env.GITHUB_DEFAULT_ASSIGNEE ||
          detectedLogin ||
          env.GITHUB_REPO_OWNER ||
          "";
      }

      const canonicalLabel = "bosun";
      const existingScopeLabels = String(
        process.env.BOSUN_TASK_LABELS || "",
      )
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
      if (!existingScopeLabels.includes(canonicalLabel)) {
        existingScopeLabels.unshift(canonicalLabel);
      }
      if (!existingScopeLabels.includes("codex-monitor")) {
        existingScopeLabels.push("codex-monitor");
      }
      env.BOSUN_TASK_LABEL = canonicalLabel;
      env.BOSUN_TASK_LABELS = existingScopeLabels.join(",");
      env.BOSUN_ENFORCE_TASK_LABEL = "true";

      if (githubTaskMode === "kanban" && !skipGitHubProjectSetup) {
        env.GITHUB_PROJECT_OWNER =
          process.env.GITHUB_PROJECT_OWNER || env.GITHUB_REPO_OWNER || "";
        env.GITHUB_PROJECT_TITLE = await prompt.ask(
          "GitHub Project title",
          process.env.GITHUB_PROJECT_TITLE ||
            configJson.kanban?.github?.projectTitle ||
            "Bosun",
        );
        let resolvedProject = null;
        try {
          resolvedProject = resolveOrCreateGitHubProject({
            owner: env.GITHUB_PROJECT_OWNER,
            title: env.GITHUB_PROJECT_TITLE,
            cwd: repoRoot,
            repoOwner: env.GITHUB_REPO_OWNER,
            githubLogin: detectedLogin,
          });
        } catch (err) {
          warn(
            `GitHub Projects setup failed: ${formatGhErrorReason(err) || "unknown error"}.`,
          );
          const projectActionIdx = await prompt.choose(
            "Proceed without Projects?",
            [
              "Use Issues-only for now",
              "Continue without project",
              "Exit setup",
            ],
            0,
          );
          if (projectActionIdx === 0) {
            githubTaskMode = "issues";
            env.GITHUB_PROJECT_MODE = githubTaskMode;
          } else if (projectActionIdx === 2) {
            aborted = true;
            return;
          }
        }

        if (githubTaskMode === "kanban") {
          if (resolvedProject?.number) {
            env.GITHUB_PROJECT_NUMBER = resolvedProject.number;
            const linkedOwner =
              resolvedProject.owner || env.GITHUB_PROJECT_OWNER;
            if (linkedOwner) {
              env.GITHUB_PROJECT_OWNER = linkedOwner;
            }
            success(
              `GitHub Project linked: ${env.GITHUB_PROJECT_OWNER}#${resolvedProject.number} (${env.GITHUB_PROJECT_TITLE})`,
            );

            let fields = [];
            try {
              fields = getGitHubProjectFields({
                owner: env.GITHUB_PROJECT_OWNER,
                number: resolvedProject.number,
                cwd: repoRoot,
              });
            } catch (err) {
              warn(
                `Failed to read GitHub Project fields: ${formatGhErrorReason(err)}`,
              );
            }
            const statusField = fields.find(
              (field) =>
                String(field?.name || "").trim().toLowerCase() === "status",
            );
            if (statusField && Array.isArray(statusField.options)) {
              const { mapping, missing, fallbacks } =
                resolveProjectStatusMapping(statusField.options);
              const statusEnvKeys = {
                todo: "GITHUB_PROJECT_STATUS_TODO",
                inprogress: "GITHUB_PROJECT_STATUS_INPROGRESS",
                inreview: "GITHUB_PROJECT_STATUS_INREVIEW",
                done: "GITHUB_PROJECT_STATUS_DONE",
                cancelled: "GITHUB_PROJECT_STATUS_CANCELLED",
              };
              for (const [key, value] of Object.entries(mapping)) {
                const envKey = statusEnvKeys[key];
                if (!envKey || !value) continue;
                if (!env[envKey] && !process.env[envKey]) {
                  env[envKey] = value;
                }
              }

              if (fallbacks.length > 0) {
                const fallbackSummary = fallbacks
                  .map((entry) => `${entry.key} → ${entry.value}`)
                  .join(", ");
                warn(
                  `GitHub Project Status options missing. Using fallbacks: ${fallbackSummary}.`,
                );
              }
              if (missing.length > 0) {
                warn(
                  `GitHub Project Status options still missing: ${missing.join(
                    ", ",
                  )}. Add them in GitHub or set GITHUB_PROJECT_STATUS_* overrides.`,
                );
              } else {
                info("GitHub Project Status mapping verified.");
              }
            } else if (fields.length > 0) {
              warn(
                "GitHub Project has no Status field metadata. Status sync may be limited.",
              );
            }
          } else {
            const reasonSuffix = resolvedProject?.reason
              ? ` Reason: ${resolvedProject.reason}`
              : "";
            warn(
              `Could not auto-detect/create GitHub Project. Issues will still be created and can be linked later.${reasonSuffix}`,
            );
          }
        }
      } else if (githubTaskMode === "kanban" && skipGitHubProjectSetup) {
        warn(
          "Skipping GitHub Project auto-setup (auth missing). You can re-run setup after `gh auth login`.",
        );
      }

      configJson.kanban = {
        backend: selectedKanbanBackend,
        syncPolicy: selectedSyncPolicy,
        github: {
          mode: githubTaskMode,
          projectTitle: env.GITHUB_PROJECT_TITLE || "Bosun",
          projectOwner: env.GITHUB_PROJECT_OWNER || env.GITHUB_REPO_OWNER || "",
          projectNumber: env.GITHUB_PROJECT_NUMBER || "",
          taskLabel: env.BOSUN_TASK_LABEL || "bosun",
        },
      };
      info(
        "GitHub backend configured. bosun-scoped issues are auto-assigned/labeled and can be linked to a Projects kanban board.",
      );
      } // end github-still-active else
    }

    if (selectedKanbanBackend === "jira") {
      const jiraBaseDefault =
        process.env.JIRA_BASE_URL || configJson.kanban?.jira?.baseUrl || "";
      const jiraEmailDefault =
        process.env.JIRA_EMAIL || configJson.kanban?.jira?.email || "";
      const jiraTokenDefault =
        process.env.JIRA_API_TOKEN || configJson.kanban?.jira?.apiToken || "";
      const jiraProjectDefault =
        process.env.JIRA_PROJECT_KEY || configJson.kanban?.jira?.projectKey || "";
      const jiraIssueTypeDefault =
        process.env.JIRA_ISSUE_TYPE || configJson.kanban?.jira?.issueType || "Task";

      env.JIRA_BASE_URL = normalizeBaseUrl(
        await prompt.ask("Jira site URL", jiraBaseDefault),
      );
      if (env.JIRA_BASE_URL) {
        const openTokenPage = await prompt.confirm(
          "Open Jira API token page in your browser?",
          true,
        );
        if (openTokenPage) {
          const opened = openUrlInBrowser(
            "https://id.atlassian.com/manage-profile/security/api-tokens",
          );
          if (!opened) {
            warn(
              "Unable to open browser. Visit https://id.atlassian.com/manage-profile/security/api-tokens",
            );
          }
        }
      }

      env.JIRA_EMAIL = await prompt.ask("Jira account email", jiraEmailDefault);
      env.JIRA_API_TOKEN = await prompt.ask(
        "Jira API token",
        jiraTokenDefault,
      );

      const hasJiraCreds =
        Boolean(env.JIRA_BASE_URL) &&
        Boolean(env.JIRA_EMAIL) &&
        Boolean(env.JIRA_API_TOKEN);

      let projects = [];
      if (hasJiraCreds) {
        const lookupProjects = await prompt.confirm(
          "Look up Jira projects now?",
          true,
        );
        if (lookupProjects) {
          try {
            projects = await listJiraProjects({
              baseUrl: env.JIRA_BASE_URL,
              email: env.JIRA_EMAIL,
              token: env.JIRA_API_TOKEN,
            });
          } catch (err) {
            warn(`Failed to load Jira projects: ${err.message}`);
          }
        }
      }

      const selectProjectKey = async (projectList, fallbackKey) => {
        if (!Array.isArray(projectList) || projectList.length === 0) {
          return await prompt.ask("Jira project key", fallbackKey || "");
        }
        const filter = await prompt.ask(
          "Filter Jira projects (optional)",
          "",
        );
        const normalizedFilter = filter.trim().toLowerCase();
        const filtered = normalizedFilter
          ? projectList.filter(
              (project) =>
                String(project.name || "").toLowerCase().includes(normalizedFilter) ||
                String(project.key || "").toLowerCase().includes(normalizedFilter),
            )
          : projectList;
        const visible = filtered.slice(0, 20);
        const options = visible.map(
          (project) => `${project.name} (${project.key})`,
        );
        options.push("Enter project key manually");
        options.push("Open Jira Projects page");
        options.push("Create a new Jira project");
        const choiceIdx = await prompt.choose(
          "Select Jira project for bosun tasks:",
          options,
          0,
        );
        if (choiceIdx < visible.length) {
          return visible[choiceIdx].key;
        }
        if (choiceIdx === visible.length) {
          return await prompt.ask("Jira project key", fallbackKey || "");
        }
        if (choiceIdx === visible.length + 1) {
          const url = `${env.JIRA_BASE_URL}/jira/projects`;
          const opened = openUrlInBrowser(url);
          if (!opened) warn(`Open this URL manually: ${url}`);
          const requery = hasJiraCreds
            ? await prompt.confirm("Re-fetch Jira projects now?", true)
            : false;
          if (requery) {
            try {
              const refreshed = await listJiraProjects({
                baseUrl: env.JIRA_BASE_URL,
                email: env.JIRA_EMAIL,
                token: env.JIRA_API_TOKEN,
              });
              return await selectProjectKey(refreshed, fallbackKey);
            } catch (err) {
              warn(`Failed to refresh Jira projects: ${err.message}`);
            }
          }
          return await prompt.ask("Jira project key", fallbackKey || "");
        }
        const createUrl = `${env.JIRA_BASE_URL}/jira/projects`;
        const opened = openUrlInBrowser(createUrl);
        if (!opened) warn(`Open this URL manually: ${createUrl}`);
        info("Create the project in Jira, then enter the new project key.");
        const createdKey = await prompt.ask("New Jira project key", "");
        if (!createdKey) {
          return await prompt.ask("Jira project key", fallbackKey || "");
        }
        if (hasJiraCreds) {
          const requery = await prompt.confirm(
            "Re-fetch Jira projects now?",
            true,
          );
          if (requery) {
            try {
              const refreshed = await listJiraProjects({
                baseUrl: env.JIRA_BASE_URL,
                email: env.JIRA_EMAIL,
                token: env.JIRA_API_TOKEN,
              });
              const match = refreshed.find(
                (project) =>
                  String(project.key || "").toUpperCase() ===
                  String(createdKey || "").toUpperCase(),
              );
              if (match) return match.key;
            } catch (err) {
              warn(`Failed to refresh Jira projects: ${err.message}`);
            }
          }
        }
        return createdKey;
      };

      env.JIRA_PROJECT_KEY = String(
        await selectProjectKey(projects, jiraProjectDefault),
      )
        .trim()
        .toUpperCase();

      let jiraIssueType = jiraIssueTypeDefault;
      if (hasJiraCreds) {
        const lookupIssueTypes = await prompt.confirm(
          "Look up Jira issue types now?",
          isAdvancedSetup,
        );
        if (lookupIssueTypes) {
          try {
            const issueTypes = await listJiraIssueTypes({
              baseUrl: env.JIRA_BASE_URL,
              email: env.JIRA_EMAIL,
              token: env.JIRA_API_TOKEN,
            });
            if (issueTypes.length > 0) {
              const issueOptions = issueTypes.map((entry) =>
                entry.subtask ? `${entry.name} (subtask)` : entry.name,
              );
              issueOptions.push("Enter issue type manually");
              const defaultIdx = Math.max(
                0,
                issueOptions.findIndex(
                  (option) =>
                    option.toLowerCase() === jiraIssueType.toLowerCase() ||
                    option
                      .toLowerCase()
                      .startsWith(jiraIssueType.toLowerCase()),
                ),
              );
              const issueIdx = await prompt.choose(
                "Select default Jira issue type:",
                issueOptions,
                defaultIdx,
              );
              if (issueIdx < issueTypes.length) {
                jiraIssueType = issueTypes[issueIdx].name;
              } else {
                jiraIssueType = await prompt.ask(
                  "Default Jira issue type",
                  jiraIssueTypeDefault,
                );
              }
            } else {
              jiraIssueType = await prompt.ask(
                "Default Jira issue type",
                jiraIssueTypeDefault,
              );
            }
          } catch (err) {
            warn(`Failed to load Jira issue types: ${err.message}`);
            jiraIssueType = await prompt.ask(
              "Default Jira issue type",
              jiraIssueTypeDefault,
            );
          }
        } else {
          jiraIssueType = await prompt.ask(
            "Default Jira issue type",
            jiraIssueTypeDefault,
          );
        }
      } else {
        jiraIssueType = await prompt.ask(
          "Default Jira issue type",
          jiraIssueTypeDefault,
        );
      }
      env.JIRA_ISSUE_TYPE = jiraIssueType;

      if (isSubtaskIssueType(env.JIRA_ISSUE_TYPE)) {
        env.JIRA_SUBTASK_PARENT_KEY = await prompt.ask(
          "Parent issue key for subtasks",
          process.env.JIRA_SUBTASK_PARENT_KEY || "",
        );
      }

      const canonicalLabel = "bosun";
      const jiraScopeLabels = String(
        process.env.JIRA_TASK_LABELS ||
          process.env.BOSUN_TASK_LABELS ||
          "",
      )
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
      if (!jiraScopeLabels.includes(canonicalLabel)) {
        jiraScopeLabels.unshift(canonicalLabel);
      }
      if (!jiraScopeLabels.includes("codex-monitor")) {
        jiraScopeLabels.push("codex-monitor");
      }
      env.BOSUN_TASK_LABEL = canonicalLabel;
      env.BOSUN_TASK_LABELS = jiraScopeLabels.join(",");
      env.BOSUN_ENFORCE_TASK_LABEL = "true";
      env.JIRA_TASK_LABELS = env.BOSUN_TASK_LABELS;
      env.JIRA_ENFORCE_TASK_LABEL = "true";

      if (hasJiraCreds) {
        const wantsAssignee = await prompt.confirm(
          "Set a default Jira assignee for new tasks?",
          false,
        );
        if (wantsAssignee) {
          const query = await prompt.ask(
            "Search users by name/email (optional)",
            "",
          );
          let selectedAccountId = "";
          if (query) {
            try {
              const users = await searchJiraUsers({
                baseUrl: env.JIRA_BASE_URL,
                email: env.JIRA_EMAIL,
                token: env.JIRA_API_TOKEN,
                query,
              });
              if (users.length > 0) {
                const userOptions = users.map((user) => {
                  const emailSuffix = user.emailAddress
                    ? ` <${user.emailAddress}>`
                    : "";
                  return `${user.displayName}${emailSuffix} (${user.accountId})`;
                });
                userOptions.push("Enter account ID manually");
                const userIdx = await prompt.choose(
                  "Select default Jira assignee:",
                  userOptions,
                  0,
                );
                if (userIdx < users.length) {
                  selectedAccountId = users[userIdx].accountId;
                }
              } else {
                warn("No Jira users matched that search.");
              }
            } catch (err) {
              warn(`Failed to search Jira users: ${err.message}`);
            }
          }
          if (!selectedAccountId) {
            selectedAccountId = await prompt.ask(
              "Default assignee account ID",
              process.env.JIRA_DEFAULT_ASSIGNEE || "",
            );
          }
          env.JIRA_DEFAULT_ASSIGNEE = selectedAccountId;
        }
      }

      if (isAdvancedSetup) {
        env.JIRA_STATUS_TODO = await prompt.ask(
          "Jira status for TODO",
          process.env.JIRA_STATUS_TODO ||
            configJson.kanban?.jira?.statusMapping?.todo ||
            "To Do",
        );
        env.JIRA_STATUS_INPROGRESS = await prompt.ask(
          "Jira status for IN PROGRESS",
          process.env.JIRA_STATUS_INPROGRESS ||
            configJson.kanban?.jira?.statusMapping?.inprogress ||
            "In Progress",
        );
        env.JIRA_STATUS_INREVIEW = await prompt.ask(
          "Jira status for IN REVIEW",
          process.env.JIRA_STATUS_INREVIEW ||
            configJson.kanban?.jira?.statusMapping?.inreview ||
            "In Review",
        );
        env.JIRA_STATUS_DONE = await prompt.ask(
          "Jira status for DONE",
          process.env.JIRA_STATUS_DONE ||
            configJson.kanban?.jira?.statusMapping?.done ||
            "Done",
        );
        env.JIRA_STATUS_CANCELLED = await prompt.ask(
          "Jira status for CANCELLED",
          process.env.JIRA_STATUS_CANCELLED ||
            configJson.kanban?.jira?.statusMapping?.cancelled ||
            "Cancelled",
        );
      }

      const configureSharedState = await prompt.confirm(
        "Configure Jira shared-state fields now?",
        isAdvancedSetup,
      );
      if (configureSharedState && hasJiraCreds) {
        let jiraFields = [];
        try {
          jiraFields = await listJiraFields({
            baseUrl: env.JIRA_BASE_URL,
            email: env.JIRA_EMAIL,
            token: env.JIRA_API_TOKEN,
          });
        } catch (err) {
          warn(`Failed to load Jira fields: ${err.message}`);
        }
        if (jiraFields.length === 0) {
          const openFields = await prompt.confirm(
            "Open Jira custom fields page in your browser?",
            false,
          );
          if (openFields) {
            const url = `${env.JIRA_BASE_URL}/jira/settings/issues/fields`;
            const opened = openUrlInBrowser(url);
            if (!opened) warn(`Open this URL manually: ${url}`);
          }
        }

        const selectFieldId = async (label, fallbackValue) => {
          if (!jiraFields.length) {
            return await prompt.ask(`${label} field id`, fallbackValue || "");
          }
          const filter = await prompt.ask(
            `Filter fields for ${label} (optional)`,
            "",
          );
          const normalized = filter.trim().toLowerCase();
          const filtered = normalized
            ? jiraFields.filter((field) =>
                String(field.name || "")
                  .toLowerCase()
                  .includes(normalized),
              )
            : jiraFields;
          const visible = filtered.slice(0, 20);
          const options = visible.map(
            (field) => `${field.name} (${field.id})`,
          );
          options.push("Enter field id manually");
          options.push("Skip");
          const choiceIdx = await prompt.choose(
            `Select Jira field for ${label}:`,
            options,
            0,
          );
          if (choiceIdx < visible.length) return visible[choiceIdx].id;
          if (choiceIdx === visible.length) {
            return await prompt.ask(`${label} field id`, fallbackValue || "");
          }
          return "";
        };

        const storageModeIdx = await prompt.choose(
          "Shared-state storage mode:",
          [
            "Single JSON custom field (recommended)",
            "Multiple custom fields (advanced)",
            "Comments only (no custom fields)",
          ],
          0,
        );
        if (storageModeIdx === 0) {
          env.JIRA_CUSTOM_FIELD_SHARED_STATE = await selectFieldId(
            "shared state JSON",
            process.env.JIRA_CUSTOM_FIELD_SHARED_STATE || "",
          );
        } else if (storageModeIdx === 1) {
          env.JIRA_CUSTOM_FIELD_OWNER_ID = await selectFieldId(
            "ownerId",
            process.env.JIRA_CUSTOM_FIELD_OWNER_ID || "",
          );
          env.JIRA_CUSTOM_FIELD_ATTEMPT_TOKEN = await selectFieldId(
            "attemptToken",
            process.env.JIRA_CUSTOM_FIELD_ATTEMPT_TOKEN || "",
          );
          env.JIRA_CUSTOM_FIELD_ATTEMPT_STARTED = await selectFieldId(
            "attemptStarted",
            process.env.JIRA_CUSTOM_FIELD_ATTEMPT_STARTED || "",
          );
          env.JIRA_CUSTOM_FIELD_HEARTBEAT = await selectFieldId(
            "heartbeat",
            process.env.JIRA_CUSTOM_FIELD_HEARTBEAT || "",
          );
          env.JIRA_CUSTOM_FIELD_RETRY_COUNT = await selectFieldId(
            "retryCount",
            process.env.JIRA_CUSTOM_FIELD_RETRY_COUNT || "",
          );
          env.JIRA_CUSTOM_FIELD_IGNORE_REASON = await selectFieldId(
            "ignoreReason",
            process.env.JIRA_CUSTOM_FIELD_IGNORE_REASON || "",
          );
        } else {
          info(
            "Shared-state will be stored in Jira comments and labels only.",
          );
        }
      }

      configJson.kanban = {
        backend: selectedKanbanBackend,
        syncPolicy: selectedSyncPolicy,
        jira: {
          baseUrl: env.JIRA_BASE_URL,
          email: env.JIRA_EMAIL,
          projectKey: env.JIRA_PROJECT_KEY,
          issueType: env.JIRA_ISSUE_TYPE || "Task",
        },
      };
      success("Jira backend configured.");
    }

    // ── Codex CLI Config (config.toml) ─────────────────────
    heading("Codex CLI Config");
    console.log(chalk.dim("  ~/.codex/config.toml — agent-level config\n"));

    const existingToml = readCodexConfig();
    const configTomlPath = getConfigPath();

    if (!existingToml) {
      info(
        "No Codex CLI config found. Will create one with recommended settings.",
      );
    } else {
      info(`Found existing config: ${configTomlPath}`);
    }

    // Check stream timeouts
    const timeouts = auditStreamTimeouts(existingToml);
    const lowTimeouts = timeouts.filter((t) => t.needsUpdate);
    if (lowTimeouts.length > 0) {
      for (const t of lowTimeouts) {
        const label =
          t.currentValue === null
            ? "not set"
            : `${(t.currentValue / 1000).toFixed(0)}s`;
        warn(
          `[${t.provider}] stream_idle_timeout_ms is ${label} — too low for complex reasoning.`,
        );
      }
      const fixTimeouts = await prompt.confirm(
        "Set stream timeouts to 60 minutes (recommended for agentic workloads)?",
        true,
      );
      if (!fixTimeouts) {
        env._SKIP_TIMEOUT_FIX = "1";
      }
    } else if (timeouts.length > 0) {
      success("Stream timeouts look good across all providers.");
    }

    // ── Orchestrator ──────────────────────────────────────
    heading("Orchestrator Script");
    console.log(
      chalk.dim(
        "  The orchestrator manages task execution and agent spawning.\n",
      ),
    );

    // Check for default scripts in repo first, then package fallback.
    const { orchestratorDefaults, selectedDefault, orchestratorScriptEnvValue } =
      resolveSetupOrchestratorDefaults({
        platform: process.platform,
        repoRoot,
        configDir,
      });
    const hasDefaultScripts = orchestratorDefaults.variants.length > 0;

    if (hasDefaultScripts) {
      info(`Found default orchestrator scripts in bosun:`);
      for (const variant of orchestratorDefaults.variants) {
        const preferredTag =
          variant.ext === orchestratorDefaults.preferredExt ? " (preferred)" : "";
        info(
          `  - orchestrator.${variant.ext}${preferredTag}`,
        );
      }

      const useDefault = isAdvancedSetup
        ? await prompt.confirm(
            `Use the default ${basename(selectedDefault.orchestratorPath)} script?`,
            true,
          )
        : true;

      if (useDefault) {
        env.ORCHESTRATOR_SCRIPT = orchestratorScriptEnvValue;
        success(`Using default ${basename(selectedDefault.orchestratorPath)}`);
      } else {
        const customPath = await prompt.ask(
          "Path to your custom orchestrator script",
          "",
        );
        if (customPath) {
          env.ORCHESTRATOR_SCRIPT = customPath;
        } else {
          info(
            "No orchestrator script configured. bosun will manage tasks directly.",
          );
        }
      }
    } else {
      const hasOrcScript = isAdvancedSetup
        ? await prompt.confirm(
            "Do you have an existing orchestrator script?",
            false,
          )
        : false;
      if (hasOrcScript) {
        env.ORCHESTRATOR_SCRIPT = await prompt.ask(
          "Path to orchestrator script",
          "",
        );
      } else {
        info(
          "No orchestrator script configured. bosun will manage tasks directly.",
        );
      }
    }

    env.MAX_PARALLEL = await prompt.ask(
      "Max parallel agent slots",
      process.env.MAX_PARALLEL || "6",
    );

    // ── Agent Templates ───────────────────────────────────
    heading("Agent Templates");
    console.log(
      chalk.dim(
        "  bosun prompt templates are scaffolded to .bosun/agents and loaded automatically.\n",
      ),
    );
    const generateAgents = isAdvancedSetup
      ? await prompt.confirm(
          "Scaffold .bosun/agents prompt files?",
          true,
        )
      : true;

    if (generateAgents) {
      const promptsResult = ensureAgentPromptWorkspace(repoRoot);
      const addedGitIgnore = ensureRepoGitIgnoreEntry(
        repoRoot,
        "/.bosun/",
      );
      configJson.agentPrompts = getDefaultPromptOverrides();

      if (addedGitIgnore) {
        success("Updated .gitignore with '/.bosun/'");
      }
      if (promptsResult.written.length > 0) {
        success(
          `Created ${promptsResult.written.length} prompt template file(s) in ${relative(repoRoot, promptsResult.workspaceDir)}`,
        );
      } else {
        info("Prompt templates already exist — keeping existing files");
      }

      // Optional AGENTS.md seed
      const agentsMdPath = resolve(repoRoot, "AGENTS.md");
      if (!existsSync(agentsMdPath)) {
        const createAgentsGuide = await prompt.confirm(
          "Create AGENTS.md guide file as well?",
          true,
        );
        if (createAgentsGuide) {
          writeFileSync(
            agentsMdPath,
            generateAgentsMd(env.PROJECT_NAME, env.GITHUB_REPO),
            "utf8",
          );
          success(`Created ${relative(repoRoot, agentsMdPath)}`);
        }
      } else {
        info("AGENTS.md already exists — leaving unchanged");
      }
    } else {
      configJson.agentPrompts = getDefaultPromptOverrides();
    }

    // ── Library Init ────────────────────────────────────────
    try {
      const libResult = initLibrary(repoRoot);
      const entriesCount = libResult?.manifest?.entries?.length ?? 0;
      const scaffolded = libResult?.scaffolded?.written?.length ?? 0;
      if (entriesCount > 0) {
        success(`Initialized library (${entriesCount} entries, ${scaffolded} profiles scaffolded).`);
      } else {
        info("Library initialized (no entries found yet).");
      }
    } catch (err) {
      info(`Library init skipped: ${err.message}`);
    }

    // ── Agent Hooks ───────────────────────────────────────
    heading("Agent Hooks");
    console.log(
      chalk.dim(
        "  Configure shared hook policies for Codex, Claude Code, and Copilot CLI.\n",
      ),
    );

    const scaffoldHooks = isAdvancedSetup
      ? await prompt.confirm(
          "Scaffold hook configs for Codex/Claude/Copilot?",
          true,
        )
      : true;

    if (scaffoldHooks) {
      const profileMap = ["strict", "balanced", "lightweight", "none"];
      let profile = "balanced";
      let targets = ["codex", "claude", "copilot"];
      let prePushRaw = process.env.BOSUN_HOOK_PREPUSH || "";
      let preCommitRaw = process.env.BOSUN_HOOK_PRECOMMIT || "";
      let taskCompleteRaw = process.env.BOSUN_HOOK_TASK_COMPLETE || "";
      let overwriteHooks = false;

      if (isAdvancedSetup) {
        const profileIdx = await prompt.choose(
          "Select hook policy:",
          [
            "Strict — pre-commit + pre-push + task validation",
            "Balanced — pre-push + task validation",
            "Lightweight — session/audit hooks only (no validation gates)",
            "None — disable bosun built-in validation hooks",
          ],
          0,
        );
        profile = profileMap[profileIdx] || "strict";

        const targetIdx = await prompt.choose(
          "Hook files to scaffold:",
          [
            "All agents (Codex + Claude + Copilot)",
            "Codex + Claude",
            "Codex + Copilot",
            "Codex only",
            "Custom target list",
          ],
          0,
        );

        if (targetIdx === 0) targets = ["codex", "claude", "copilot"];
        else if (targetIdx === 1) targets = ["codex", "claude"];
        else if (targetIdx === 2) targets = ["codex", "copilot"];
        else if (targetIdx === 3) targets = ["codex"];
        else {
          const customTargets = await prompt.ask(
            "Custom targets (comma-separated: codex,claude,copilot)",
            "codex,claude,copilot",
          );
          targets = normalizeHookTargets(customTargets);
        }

        console.log(
          chalk.dim(
            "  Optional command overrides: use ';;' between commands, or 'none' to disable a hook event.\n",
          ),
        );

        prePushRaw = await prompt.ask(
          "Pre-push command override",
          process.env.BOSUN_HOOK_PREPUSH || "",
        );
        preCommitRaw = await prompt.ask(
          "Pre-commit command override",
          process.env.BOSUN_HOOK_PRECOMMIT || "",
        );
        taskCompleteRaw = await prompt.ask(
          "Task-complete command override",
          process.env.BOSUN_HOOK_TASK_COMPLETE || "",
        );

        overwriteHooks = await prompt.confirm(
          "Overwrite existing generated hook files when present?",
          false,
        );
      } else {
        info(
          "Using recommended hook defaults: balanced policy for codex, claude, and copilot.",
        );
      }

      const hookResult = scaffoldAgentHookFiles(repoRoot, {
        enabled: true,
        profile,
        targets,
        overwriteExisting: overwriteHooks,
        commands: {
          PrePush: parseHookCommandInput(prePushRaw),
          PreCommit: parseHookCommandInput(preCommitRaw),
          TaskComplete: parseHookCommandInput(taskCompleteRaw),
        },
      });

      printHookScaffoldSummary(hookResult);
      Object.assign(env, hookResult.env);
      configJson.hookProfiles = {
        enabled: true,
        profile,
        targets,
        overwriteExisting: overwriteHooks,
      };
    } else {
      const hookResult = scaffoldAgentHookFiles(repoRoot, { enabled: false });
      Object.assign(env, hookResult.env);
      configJson.hookProfiles = {
        enabled: false,
      };
      info("Hook scaffolding skipped by user selection.");
    }

    // ── Per-workspace kanban wiring ───────────────────────
    // When multiple workspaces exist, offer to wire kanban/project config for
    // each workspace beyond the primary one already configured above.
    if (
      workspaceChoices.length > 1 &&
      (selectedKanbanBackend === "github" || selectedKanbanBackend === "jira")
    ) {
      const selectedWsId = String(
        selectedWorkspaceChoice?.id || selectedWorkspaceChoice?.name || "",
      )
        .trim()
        .toLowerCase();
      const remainingWorkspaces = workspaceChoices.filter((ws) => {
        const wsId = String(ws.id || ws.name || "").trim().toLowerCase();
        return wsId && wsId !== selectedWsId;
      });

      if (remainingWorkspaces.length > 0) {
        console.log();
        heading("Per-Workspace Project Wiring");
        info(
          `You have ${remainingWorkspaces.length} additional workspace(s). Each can have its own project/board.`,
        );

        for (const ws of remainingWorkspaces) {
          const wsLabel = ws.label || ws.name || ws.id;
          const wireUp = await prompt.confirm(
            `Configure kanban project for workspace "${wsLabel}"?`,
            true,
          );
          if (!wireUp) continue;

          const wsRepos = Array.isArray(ws.repos) ? ws.repos : [];
          const primaryRepo = wsRepos.find((r) => r?.primary) || wsRepos[0] || null;
          const primarySlug = primaryRepo?.slug || "";

          if (selectedKanbanBackend === "github") {
            let wsRepoSlug = primarySlug;
            if (!wsRepoSlug) {
              wsRepoSlug = await prompt.ask(
                `  GitHub repo slug for "${wsLabel}" (owner/repo)`,
                "",
              );
            }
            const parsedSlug = parseRepoSlugFromUrl(wsRepoSlug) || wsRepoSlug;
            const [wsOwner, wsRepoName] = String(parsedSlug || "").split("/", 2);

            let wsProjectNumber = "";
            let wsProjectTitle = "";
            let wsProjectOwner = wsOwner || "";

            if (wsOwner && wsRepoName && !skipGitHubProjectSetup) {
              wsProjectTitle = await prompt.ask(
                `  GitHub Project title for "${wsLabel}"`,
                wsLabel,
              );
              wsProjectOwner = await prompt.ask(
                `  GitHub Project owner for "${wsLabel}"`,
                wsOwner,
              );

              try {
                let wsLogin = "";
                try {
                  wsLogin = detectGitHubUserLogin(repoRoot);
                } catch {
                  // ignore
                }
                const wsProject = resolveOrCreateGitHubProject({
                  owner: wsProjectOwner,
                  title: wsProjectTitle,
                  cwd: repoRoot,
                  repoOwner: wsOwner,
                  githubLogin: wsLogin,
                });
                if (wsProject?.number) {
                  wsProjectNumber = wsProject.number;
                  if (wsProject.owner) wsProjectOwner = wsProject.owner;
                  success(
                    `  Linked GitHub Project for "${wsLabel}": ${wsProjectOwner}#${wsProjectNumber}`,
                  );
                } else {
                  warn(
                    `  Could not auto-detect/create GitHub Project for "${wsLabel}".${wsProject?.reason ? ` ${wsProject.reason}` : ""}`,
                  );
                }
              } catch (err) {
                warn(
                  `  GitHub Projects setup failed for "${wsLabel}": ${formatGhErrorReason(err) || "unknown error"}`,
                );
              }
            }

            // Persist per-workspace kanban config
            const wsObj = configJson.workspaces?.find(
              (w) =>
                String(w?.id || "").toLowerCase() ===
                String(ws.id || "").toLowerCase(),
            );
            if (wsObj) {
              wsObj.kanban = {
                backend: "github",
                github: {
                  repo: parsedSlug || "",
                  repoOwner: wsOwner || "",
                  repoName: wsRepoName || "",
                  projectOwner: wsProjectOwner,
                  projectTitle: wsProjectTitle,
                  projectNumber: wsProjectNumber,
                },
              };
            }
          } else if (selectedKanbanBackend === "jira") {
            const wsJiraProject = await prompt.ask(
              `  Jira project key for "${wsLabel}"`,
              "",
            );
            const wsObj = configJson.workspaces?.find(
              (w) =>
                String(w?.id || "").toLowerCase() ===
                String(ws.id || "").toLowerCase(),
            );
            if (wsObj) {
              wsObj.kanban = {
                backend: "jira",
                jira: {
                  projectKey: wsJiraProject.trim().toUpperCase(),
                },
              };
            }
          }
        }
      }
    }

    saveSetupSnapshot(7, "Kanban & Execution", env, configJson);
    } // end step 7

    // ── Step 8: Optional Channels ─────────────────────────
    if (resumeFromStep > 8) {
      info(`Skipping step 8 (restored from previous run).`);
    } else {
    headingStepWithSnapshot(8, "Optional Channels (WhatsApp & Container)");

    console.log(
      chalk.dim(
        "  These are optional features. Skip them if you only want Telegram.",
      ),
    );

    // WhatsApp
    const enableWhatsApp = await prompt.confirm(
      "Enable WhatsApp channel?",
      false,
    );
    if (enableWhatsApp) {
      env.WHATSAPP_ENABLED = "true";
      env.WHATSAPP_CHAT_ID = await prompt.ask(
        "WhatsApp Chat/Group ID (JID)",
        process.env.WHATSAPP_CHAT_ID || "",
      );
      env.WHATSAPP_ASSISTANT_NAME = isAdvancedSetup
        ? await prompt.ask(
            "WhatsApp assistant display name",
            env.PROJECT_NAME || "Codex Monitor",
          )
        : env.PROJECT_NAME || "Codex Monitor";
      info(
        "Run `bosun --whatsapp-auth` after setup to authenticate with WhatsApp.",
      );
    } else {
      env.WHATSAPP_ENABLED = "false";
    }

    // Container isolation
    const enableContainer = await prompt.confirm(
      "Enable container isolation for agent execution?",
      false,
    );
    if (enableContainer) {
      env.CONTAINER_ENABLED = "true";
      if (isAdvancedSetup) {
        const runtimeIdx = await prompt.choose(
          "Container runtime",
          ["docker", "podman", "auto-detect"],
          2,
        );
        env.CONTAINER_RUNTIME = ["docker", "podman", "auto"][runtimeIdx];
        env.CONTAINER_IMAGE = await prompt.ask(
          "Container image",
          process.env.CONTAINER_IMAGE || "node:22-slim",
        );
        env.CONTAINER_MEMORY_LIMIT = await prompt.ask(
          "Memory limit (e.g. 2g)",
          process.env.CONTAINER_MEMORY_LIMIT || "4g",
        );
      } else {
        env.CONTAINER_RUNTIME = process.env.CONTAINER_RUNTIME || "auto";
        env.CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || "node:22-slim";
      }
    } else {
      env.CONTAINER_ENABLED = "false";
    }
    saveSetupSnapshot(8, "Optional Channels", env, configJson);
    } // end step 8

    // ── Step 9: Running Mode ──────────────────────────────
    if (resumeFromStep > 9) {
      info(`Skipping step 9 (restored from previous run).`);
    } else {
    headingStepWithSnapshot(9, "Running Mode");

    const {
      getStartupStatus,
      getStartupMethodName,
    } = await import("./infra/startup-service.mjs");
    const {
      getDesktopShortcutStatus,
      getDesktopShortcutMethodName,
      resolveElectronLauncher,
    } = await import("./infra/desktop-shortcut.mjs");

    const currentStartup = getStartupStatus();
    const methodName = getStartupMethodName();
    const desktopMethod = getDesktopShortcutMethodName();
    const shortcutSupported = desktopMethod !== "unsupported";
    const currentShortcut = getDesktopShortcutStatus();
    const electronLauncher = resolveElectronLauncher();
    const hasElectron = Boolean(electronLauncher?.executable);

    let skipRunningModeConfig = false;
    const alreadyConfigured = currentStartup.installed || currentShortcut.installed;
    if (alreadyConfigured) {
      if (currentStartup.installed) {
        info(`Background service already registered (${currentStartup.method}).`);
      }
      if (currentShortcut.installed) {
        info(`Desktop shortcut already installed (${currentShortcut.method}).`);
      }
      const change = await prompt.confirm("Change the running mode?", false);
      if (!change) {
        env._DESKTOP_SHORTCUT = "skip";
        env._STARTUP_SERVICE = "skip";
        env.BOSUN_SENTINEL_AUTO_START = env.BOSUN_SENTINEL_AUTO_START || "false";
        env._RUNNING_MODE = "skip";
        env._START_AFTER_SETUP = "0";
        env._OPEN_PORTAL_AFTER_SETUP = "0";
        skipRunningModeConfig = true;
      }
    }

    if (!skipRunningModeConfig) {
      console.log();
      console.log(chalk.bold("  How should Bosun run on this machine?"));
      console.log();
      console.log(chalk.cyan("  0  ·  Manual"));
      console.log(chalk.dim("       Start bosun yourself from a terminal whenever you need it."));
      console.log(chalk.dim("       Best for: CI servers, development, occasional use, SSH hosts."));
      console.log();
      console.log(
        chalk.cyan("  1  ·  Quick Launch") +
        (shortcutSupported
          ? chalk.dim(`  (${desktopMethod})`)
          : chalk.dim("  — shortcut unavailable on this OS")),
      );
      console.log(chalk.dim("       Adds a desktop shortcut for one-click launch of the Bosun portal."));
      console.log(chalk.dim("       Bosun does not start automatically — you open it when you need it."));
      console.log();
      console.log(chalk.cyan("  2  ·  Background Service") + chalk.dim("  ← recommended"));
      console.log(chalk.dim(`       Registers with ${methodName} to auto-start at login.`));
      console.log(chalk.dim("       Starts silently in the background. If it crashes, the OS restarts it."));
      console.log(chalk.dim("       Creates a desktop shortcut to open the portal UI anytime."));
      console.log();
      console.log(chalk.cyan("  3  ·  Sentinel Mode") + chalk.dim("  (maximum uptime)"));
      console.log(chalk.dim("       Like Background Service, plus a Node-level watchdog that"));
      console.log(chalk.dim("       continuously monitors Bosun and revives it if it becomes unresponsive."));
      console.log(chalk.dim("       Ideal for always-on teams who depend on zero downtime."));
      console.log();

      const defaultModeIdx = 2;
      const modeIdx = await prompt.choose(
        "Select running mode:",
        [
          "Manual           — run from terminal when needed",
          "Quick Launch     — desktop shortcut, no auto-start",
          "Background       — auto-start at login via OS service (auto-restart on crash)",
          "Sentinel         — background + Node watchdog for maximum uptime",
        ],
        defaultModeIdx,
      );

      if (modeIdx === 0) {
        // Manual: no shortcut, no service
        env._DESKTOP_SHORTCUT = "0";
        env._STARTUP_SERVICE = "0";
        env.BOSUN_SENTINEL_AUTO_START = "false";
      } else if (modeIdx === 1) {
        // Quick Launch: shortcut only
        env._DESKTOP_SHORTCUT = shortcutSupported ? "1" : "0";
        env._STARTUP_SERVICE = "0";
        env.BOSUN_SENTINEL_AUTO_START = "false";
      } else if (modeIdx === 2) {
        // Background Service: OS-managed auto-start + shortcut
        env._DESKTOP_SHORTCUT = shortcutSupported ? "1" : "0";
        env._STARTUP_SERVICE = "1";
        env.BOSUN_SENTINEL_AUTO_START = "false";
      } else {
        // Sentinel Mode: background + sentinel watchdog + shortcut
        env._DESKTOP_SHORTCUT = shortcutSupported ? "1" : "0";
        env._STARTUP_SERVICE = "1";
        env.BOSUN_SENTINEL_AUTO_START = "true";
      }

      env._RUNNING_MODE = String(modeIdx);

      // ── Post-setup launch options (background/sentinel modes only) ────
      if (modeIdx >= 2) {
        console.log();
        console.log(chalk.dim("  Bosun will auto-start on your next login."));
        const startNow = await prompt.confirm(
          "Start Bosun in the background right after setup completes?",
          true,
        );
        env._START_AFTER_SETUP = startNow ? "1" : "0";
        if (startNow && hasElectron) {
          const openPortal = await prompt.confirm(
            "Also open the Bosun desktop portal once Bosun has started?",
            false,
          );
          env._OPEN_PORTAL_AFTER_SETUP = openPortal ? "1" : "0";
        } else {
          env._OPEN_PORTAL_AFTER_SETUP = "0";
        }
      } else {
        env._START_AFTER_SETUP = "0";
        env._OPEN_PORTAL_AFTER_SETUP = "0";
      }
    }

    saveSetupSnapshot(9, "Running Mode", env, configJson);

    // ── Context Shredding advanced configuration (advanced setup only) ──
    if (isAdvancedSetup) {
      console.log();
      console.log(chalk.bold.cyan("  Context Shredding"));
      console.log(chalk.dim(
        "  Context Shredding compresses old tool outputs and messages to reduce\n" +
        "  token usage and avoid context overflow on long-running sessions.\n" +
        "  Pinned instructions (AGENTS.md, MUST rules) are never compressed.\n",
      ));

      const shreddingEnabled = await prompt.confirm(
        "Enable Context Shredding (recommended)?",
        env.CONTEXT_SHREDDING_ENABLED
          ? env.CONTEXT_SHREDDING_ENABLED !== "false"
          : true,
      );
      env.CONTEXT_SHREDDING_ENABLED = shreddingEnabled ? "true" : "false";

      if (shreddingEnabled) {
        const fullTurns = await prompt.ask(
          "Full-context turns (Tier 0 — keep uncompressed)",
          env.CONTEXT_SHREDDING_FULL_CONTEXT_TURNS || "3",
        );
        if (fullTurns && String(fullTurns).trim() !== "3") {
          env.CONTEXT_SHREDDING_FULL_CONTEXT_TURNS = String(fullTurns).trim();
        }

        const compressMessages = await prompt.confirm(
          "Compress agent reasoning & user messages?",
          env.CONTEXT_SHREDDING_COMPRESS_MESSAGES
            ? env.CONTEXT_SHREDDING_COMPRESS_MESSAGES !== "false"
            : true,
        );
        env.CONTEXT_SHREDDING_COMPRESS_MESSAGES = compressMessages ? "true" : "false";

        console.log(chalk.dim(
          "\n  Advanced tier tuning (press Enter to keep defaults):",
        ));

        const tier1MaxAge = await prompt.ask(
          "Tier 1 max age (light compression, in turns)",
          env.CONTEXT_SHREDDING_TIER1_MAX_AGE || "5",
        );
        if (tier1MaxAge && String(tier1MaxAge).trim() !== "5") {
          env.CONTEXT_SHREDDING_TIER1_MAX_AGE = String(tier1MaxAge).trim();
        }

        const tier2MaxAge = await prompt.ask(
          "Tier 2 max age (moderate compression, in turns)",
          env.CONTEXT_SHREDDING_TIER2_MAX_AGE || "9",
        );
        if (tier2MaxAge && String(tier2MaxAge).trim() !== "9") {
          env.CONTEXT_SHREDDING_TIER2_MAX_AGE = String(tier2MaxAge).trim();
        }

        console.log();
        console.log(chalk.dim(
          "  Per-type profiles let you tune shredding per interaction type.\n" +
          "  Example: {\"perType\":{\"voice\":{\"fullContextTurns\":6}},\"perAgent\":{\"claude-sdk\":{\"tier1MaxAge\":8}}}\n" +
          "  Leave blank to use global defaults.\n",
        ));
        const profiles = await prompt.ask(
          "Per-type profiles JSON (optional)",
          env.CONTEXT_SHREDDING_PROFILES || "",
        );
        if (profiles && String(profiles).trim()) {
          // Validate JSON before saving
          try {
            JSON.parse(String(profiles).trim());
            env.CONTEXT_SHREDDING_PROFILES = String(profiles).trim();
          } catch {
            console.warn(chalk.yellow("  ⚠ Invalid JSON — skipping profiles override."));
          }
        }
      }
    }

    } // end step 9

  } finally {
    prompt.close();
  }

  // ── Write Files ─────────────────────────────────────────
  normalizeSetupConfiguration({ env, configJson, repoRoot, slug, configDir });
  await writeConfigFiles({ env, configJson, repoRoot, configDir });
  clearSetupProgress(configDir);

  if (cloneWorkspacesAfterSetup && Array.isArray(configJson.workspaces) && configJson.workspaces.length > 0) {
    heading("Cloning Workspace Repos");
    for (const ws of configJson.workspaces) {
      const wsId = ws?.id;
      if (!wsId) continue;
      try {
        const results = pullWorkspaceRepos(configDir, wsId);
        for (const result of results) {
          if (result.success) {
            success(`Workspace ${wsId}: ${result.name} ready`);
          } else {
            warn(
              `Workspace ${wsId}: ${result.name} ${result.error ? `— ${result.error}` : "failed"}`,
            );
          }
        }
      } catch (err) {
        warn(`Workspace ${wsId}: clone/pull failed — ${err.message || err}`);
      }
    }
  }
}

// ── Non-Interactive Mode ─────────────────────────────────────────────────────

async function runNonInteractive({
  env,
  configJson,
  repoRoot,
  slug,
  projectName,
  configDir,
}) {
  env.PROJECT_NAME = process.env.PROJECT_NAME || projectName;
  env.REPO_ROOT = process.env.REPO_ROOT || repoRoot;
  env.GITHUB_REPO = process.env.GITHUB_REPO || slug || "";
  env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
  env.TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
  applyTelegramMiniAppDefaults(env, process.env);
  env.KANBAN_BACKEND = process.env.KANBAN_BACKEND || "internal";
  env.KANBAN_SYNC_POLICY =
    process.env.KANBAN_SYNC_POLICY || "internal-primary";
  env.EXECUTOR_MODE = process.env.EXECUTOR_MODE || "internal";
  env.PROJECT_REQUIREMENTS_PROFILE =
    process.env.PROJECT_REQUIREMENTS_PROFILE || "feature";
  env.PROJECT_REQUIREMENTS_NOTES = process.env.PROJECT_REQUIREMENTS_NOTES || "";
  env.INTERNAL_EXECUTOR_REPLENISH_ENABLED =
    process.env.INTERNAL_EXECUTOR_REPLENISH_ENABLED || "false";
  env.INTERNAL_EXECUTOR_REPLENISH_MIN_NEW_TASKS =
    process.env.INTERNAL_EXECUTOR_REPLENISH_MIN_NEW_TASKS || "1";
  env.INTERNAL_EXECUTOR_REPLENISH_MAX_NEW_TASKS =
    process.env.INTERNAL_EXECUTOR_REPLENISH_MAX_NEW_TASKS || "2";
  env.GITHUB_REPO_OWNER =
    process.env.GITHUB_REPO_OWNER || (slug ? String(slug).split("/")[0] : "");
  env.GITHUB_REPO_NAME =
    process.env.GITHUB_REPO_NAME || (slug ? String(slug).split("/")[1] : "");
  env.GITHUB_REPOSITORY =
    process.env.GITHUB_REPOSITORY ||
    (env.GITHUB_REPO_OWNER && env.GITHUB_REPO_NAME
      ? `${env.GITHUB_REPO_OWNER}/${env.GITHUB_REPO_NAME}`
      : "");
  if (!env.GITHUB_REPO && env.GITHUB_REPOSITORY) {
    env.GITHUB_REPO = env.GITHUB_REPOSITORY;
  }
  env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
  env.VOICE_ENABLED = process.env.VOICE_ENABLED || "true";
  env.VOICE_PROVIDER = process.env.VOICE_PROVIDER || "auto";
  env.VOICE_MODEL =
    process.env.VOICE_MODEL || "gpt-realtime-1.5";
  env.VOICE_VISION_MODEL = process.env.VOICE_VISION_MODEL || "gpt-4.1-mini";
  env.OPENAI_REALTIME_API_KEY = process.env.OPENAI_REALTIME_API_KEY || "";
  env.AZURE_OPENAI_REALTIME_ENDPOINT =
    process.env.AZURE_OPENAI_REALTIME_ENDPOINT || "";
  env.AZURE_OPENAI_REALTIME_API_KEY =
    process.env.AZURE_OPENAI_REALTIME_API_KEY || "";
  env.AZURE_OPENAI_REALTIME_DEPLOYMENT =
    process.env.AZURE_OPENAI_REALTIME_DEPLOYMENT || "gpt-realtime-1.5";
  env.VOICE_ID = process.env.VOICE_ID || "alloy";
  env.VOICE_TURN_DETECTION = process.env.VOICE_TURN_DETECTION || "semantic_vad";
  env.VOICE_FALLBACK_MODE = process.env.VOICE_FALLBACK_MODE || "browser";
  env.VOICE_DELEGATE_EXECUTOR =
    process.env.VOICE_DELEGATE_EXECUTOR ||
    process.env.PRIMARY_AGENT ||
    "codex-sdk";
  env.CODEX_MODEL_PROFILE = process.env.CODEX_MODEL_PROFILE || "xl";
  env.CODEX_MODEL_PROFILE_SUBAGENT =
    process.env.CODEX_MODEL_PROFILE_SUBAGENT ||
    process.env.CODEX_SUBAGENT_PROFILE ||
    "m";
  env.CODEX_MODEL_PROFILE_XL_MODEL =
    process.env.CODEX_MODEL_PROFILE_XL_MODEL || "gpt-5.3-codex";
  env.CODEX_MODEL_PROFILE_M_MODEL =
    process.env.CODEX_MODEL_PROFILE_M_MODEL || "gpt-5.1-codex-mini";
  env.CODEX_MODEL_PROFILE_XL_PROVIDER =
    process.env.CODEX_MODEL_PROFILE_XL_PROVIDER || "openai";
  env.CODEX_MODEL_PROFILE_M_PROVIDER =
    process.env.CODEX_MODEL_PROFILE_M_PROVIDER || "openai";
  env.CODEX_SUBAGENT_MODEL =
    process.env.CODEX_SUBAGENT_MODEL || env.CODEX_MODEL_PROFILE_M_MODEL;
  env.CODEX_AGENT_MAX_THREADS =
    process.env.CODEX_AGENT_MAX_THREADS ||
    process.env.CODEX_AGENTS_MAX_THREADS ||
    "12";
  env.CODEX_SANDBOX = process.env.CODEX_SANDBOX || "workspace-write";
  env.MAX_PARALLEL = process.env.MAX_PARALLEL || "6";
  if (!process.env.ORCHESTRATOR_SCRIPT) {
    const { orchestratorScriptEnvValue } = resolveSetupOrchestratorDefaults({
      platform: process.platform,
      repoRoot,
      configDir,
    });
    if (orchestratorScriptEnvValue) {
      env.ORCHESTRATOR_SCRIPT = orchestratorScriptEnvValue;
    }
  } else {
    env.ORCHESTRATOR_SCRIPT = process.env.ORCHESTRATOR_SCRIPT;
  }

  // Optional channels
  env.WHATSAPP_ENABLED = process.env.WHATSAPP_ENABLED || "false";
  env.WHATSAPP_CHAT_ID = process.env.WHATSAPP_CHAT_ID || "";
  env.CONTAINER_ENABLED = process.env.CONTAINER_ENABLED || "false";
  env.CONTAINER_RUNTIME = process.env.CONTAINER_RUNTIME || "auto";

  // Copilot cloud: disabled by default — set to 0 to allow @copilot PR comments
  env.COPILOT_CLOUD_DISABLED = process.env.COPILOT_CLOUD_DISABLED || "true";
  env.COPILOT_NO_EXPERIMENTAL =
    process.env.COPILOT_NO_EXPERIMENTAL || "false";
  env.COPILOT_NO_ALLOW_ALL = process.env.COPILOT_NO_ALLOW_ALL || "false";
  env.COPILOT_ENABLE_ASK_USER =
    process.env.COPILOT_ENABLE_ASK_USER || "false";
  env.COPILOT_ENABLE_ALL_GITHUB_MCP_TOOLS =
    process.env.COPILOT_ENABLE_ALL_GITHUB_MCP_TOOLS || "false";
  env.WORKFLOW_AUTOMATION_ENABLED =
    process.env.WORKFLOW_AUTOMATION_ENABLED || "true";
  env.COPILOT_AGENT_MAX_REQUESTS =
    process.env.COPILOT_AGENT_MAX_REQUESTS || "500";

  // Claude SDK: permission mode and API key passthrough
  env.CLAUDE_PERMISSION_MODE =
    process.env.CLAUDE_PERMISSION_MODE || "bypassPermissions";
  if (process.env.ANTHROPIC_API_KEY) {
    env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  }

  // Parse EXECUTORS env if set, else use default preset
  if (process.env.EXECUTORS) {
    const entries = process.env.EXECUTORS.split(",").map((e) => e.trim());
    const roles = ["primary", "backup", "tertiary"];
    for (let i = 0; i < entries.length; i++) {
      const parts = entries[i].split(":");
      if (parts.length >= 2) {
        configJson.executors.push({
          name: `${parts[0].toLowerCase()}-${parts[1].toLowerCase()}`,
          executor: parts[0].toUpperCase(),
          variant: parts[1],
          weight: parts[2]
            ? Number(parts[2])
            : Math.floor(100 / entries.length),
          role: roles[i] || `executor-${i + 1}`,
          enabled: true,
        });
      }
    }
  }
  if (!configJson.executors.length) {
    // Smart default: pick preset based on available API keys
    const hasOpenAI = !!process.env.OPENAI_API_KEY;
    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
    const hasGemini =
      !!process.env.GEMINI_API_KEY || !!process.env.GOOGLE_API_KEY;
    const hasGitHub = !!process.env.GITHUB_TOKEN || !!process.env.COPILOT_CLI_TOKEN;
    const presetEnv = (process.env.EXECUTOR_PRESET || "").toLowerCase();
    if (presetEnv && EXECUTOR_PRESETS[presetEnv]) {
      configJson.executors = EXECUTOR_PRESETS[presetEnv];
    } else if (hasGitHub) {
      configJson.executors = hasOpenAI
        ? EXECUTOR_PRESETS["copilot-codex"]
        : EXECUTOR_PRESETS["copilot-only"];
    } else if (hasAnthropic) {
      configJson.executors = EXECUTOR_PRESETS["claude-only"];
    } else if (hasGemini) {
      configJson.executors = hasOpenAI
        ? EXECUTOR_PRESETS["gemini-codex"]
        : EXECUTOR_PRESETS["gemini-only"];
    } else {
      configJson.executors = EXECUTOR_PRESETS["codex-only"];
    }
  }

  // Derive PRIMARY_AGENT from executor preset's primary role
  {
    const primaryExec = (configJson.executors || []).find(
      (e) => e.role === "primary",
    );
    if (primaryExec) {
      const sdkMap = {
        CODEX: "codex-sdk",
        COPILOT: "copilot-sdk",
        CLAUDE: "claude-sdk",
        GEMINI: "gemini-sdk",
        OPENCODE: "opencode-sdk",
      };
      env.PRIMARY_AGENT = sdkMap[String(primaryExec.executor).toUpperCase()] || "codex-sdk";
    }
  }

  configJson.projectName = env.PROJECT_NAME;
  configJson.kanban = {
    backend: env.KANBAN_BACKEND || "internal",
    syncPolicy: env.KANBAN_SYNC_POLICY || "internal-primary",
  };
  configJson.projectRequirements = {
    profile: env.PROJECT_REQUIREMENTS_PROFILE || "feature",
    notes: env.PROJECT_REQUIREMENTS_NOTES || "",
  };
  configJson.internalExecutor = {
    ...(configJson.internalExecutor || {}),
    mode: env.EXECUTOR_MODE || "internal",
    backlogReplenishment: {
      enabled:
        String(env.INTERNAL_EXECUTOR_REPLENISH_ENABLED || "false").toLowerCase() ===
        "true",
      minNewTasks: toPositiveInt(env.INTERNAL_EXECUTOR_REPLENISH_MIN_NEW_TASKS, 1),
      maxNewTasks: toPositiveInt(env.INTERNAL_EXECUTOR_REPLENISH_MAX_NEW_TASKS, 2),
      requirePriority: true,
    },
    projectRequirements: {
      profile: env.PROJECT_REQUIREMENTS_PROFILE || "feature",
      notes: env.PROJECT_REQUIREMENTS_NOTES || "",
    },
  };
  configJson.failover = {
    strategy: process.env.FAILOVER_STRATEGY || "next-in-line",
    maxRetries: Number(process.env.FAILOVER_MAX_RETRIES || "3"),
    cooldownMinutes: Number(process.env.FAILOVER_COOLDOWN_MIN || "5"),
    disableOnConsecutiveFailures: Number(
      process.env.FAILOVER_DISABLE_AFTER || "3",
    ),
  };
  configJson.distribution = process.env.EXECUTOR_DISTRIBUTION || "primary-only";
  configJson.repositories = [
    {
      name: basename(repoRoot),
      slug: env.GITHUB_REPO,
      primary: true,
    },
  ];
  configJson.agentPrompts = getDefaultPromptOverrides();
  ensureAgentPromptWorkspace(repoRoot);
  ensureRepoGitIgnoreEntry(repoRoot, "/.bosun/");
  try {
    initLibrary(repoRoot);
  } catch (err) {
    info(`Library init skipped: ${err.message}`);
  }

  const hookOptions = buildHookScaffoldOptionsFromEnv(process.env);
  const hookResult = scaffoldAgentHookFiles(repoRoot, hookOptions);
  Object.assign(env, hookResult.env);
  configJson.hookProfiles = {
    enabled: hookResult.enabled,
    profile: hookResult.profile,
    targets: hookResult.targets,
    overwriteExisting: Boolean(hookOptions.overwriteExisting),
  };
  printHookScaffoldSummary(hookResult);

  // Running mode: RUNNING_MODE=0|1|2|3 sets startup+shortcut+sentinel together.
  // 0=Manual  1=Quick Launch (shortcut only)  2=Background Service  3=Sentinel
  // Individual STARTUP_SERVICE / DESKTOP_SHORTCUT env vars still work as legacy overrides.
  const runningModeRaw = process.env.RUNNING_MODE ?? process.env.BOSUN_RUNNING_MODE;
  if (runningModeRaw !== undefined) {
    const modeIdx = parseInt(runningModeRaw, 10);
    if (modeIdx === 0) {
      env._DESKTOP_SHORTCUT = "0";
      env._STARTUP_SERVICE = "0";
      env.BOSUN_SENTINEL_AUTO_START = env.BOSUN_SENTINEL_AUTO_START || "false";
    } else if (modeIdx === 1) {
      env._DESKTOP_SHORTCUT = "1";
      env._STARTUP_SERVICE = "0";
      env.BOSUN_SENTINEL_AUTO_START = env.BOSUN_SENTINEL_AUTO_START || "false";
    } else if (modeIdx === 2) {
      env._DESKTOP_SHORTCUT = "1";
      env._STARTUP_SERVICE = "1";
      env.BOSUN_SENTINEL_AUTO_START = env.BOSUN_SENTINEL_AUTO_START || "false";
    } else if (modeIdx === 3) {
      env._DESKTOP_SHORTCUT = "1";
      env._STARTUP_SERVICE = "1";
      env.BOSUN_SENTINEL_AUTO_START = "true";
    }
  } else {
    // Legacy: individual env vars still supported
    if (parseBooleanEnvValue(process.env.STARTUP_SERVICE, false)) {
      env._STARTUP_SERVICE = "1";
    } else if (
      process.env.STARTUP_SERVICE !== undefined &&
      !parseBooleanEnvValue(process.env.STARTUP_SERVICE, true)
    ) {
      env._STARTUP_SERVICE = "0";
    }
    // else: don't set — writeConfigFiles will skip silently

    // Desktop shortcut: respect DESKTOP_SHORTCUT env in non-interactive mode
    const desktopShortcutEnv =
      process.env.DESKTOP_SHORTCUT ?? process.env.BOSUN_DESKTOP_SHORTCUT;
    if (parseBooleanEnvValue(desktopShortcutEnv, false)) {
      env._DESKTOP_SHORTCUT = "1";
    } else if (
      desktopShortcutEnv !== undefined &&
      !parseBooleanEnvValue(desktopShortcutEnv, true)
    ) {
      env._DESKTOP_SHORTCUT = "0";
    }
  }

  // ── Workspace bootstrap ────────────────────────────────────────────────
  // If workspaces are configured, auto-clone repos and verify .git
  if (Array.isArray(configJson.workspaces) && configJson.workspaces.length > 0) {
    for (const ws of configJson.workspaces) {
      if (!ws.id || !ws.repos?.length) continue;
      try {
        const { pullWorkspaceRepos } = await import("./workspace/workspace-manager.mjs");
        const results = pullWorkspaceRepos(configDir, ws.id);
        for (const r of results) {
          if (r.success) {
            info(`  ✓ Workspace repo ready: ${r.name}`);
          } else {
            warn(`  :alert: Workspace repo ${r.name}: ${r.error}`);
          }
        }
        // Set BOSUN_AGENT_REPO_ROOT to workspace primary repo
        const primaryRepo = ws.repos.find((r) => r.primary) || ws.repos[0];
        if (primaryRepo) {
          const wsPath = resolve(configDir, "workspaces", ws.id);
          const primaryRepoPath = resolve(wsPath, primaryRepo.name);
          if (existsSync(resolve(primaryRepoPath, ".git"))) {
            env.BOSUN_AGENT_REPO_ROOT = primaryRepoPath;
            info(`  Agent repo root: ${primaryRepoPath}`);
          }
        }
      } catch (err) {
        warn(`  Workspace bootstrap for ${ws.id} failed: ${err.message}`);
      }
    }
  }

  normalizeSetupConfiguration({ env, configJson, repoRoot, slug, configDir });
  await writeConfigFiles({ env, configJson, repoRoot, configDir });
}

// ── File Writing ─────────────────────────────────────────────────────────────

async function writeConfigFiles({ env, configJson, repoRoot, configDir }) {
  heading("Writing Configuration");
  const targetDir = resolve(configDir || __dirname);
  mkdirSync(targetDir, { recursive: true });
  ensureAgentPromptWorkspace(repoRoot);
  ensureRepoGitIgnoreEntry(repoRoot, "/.bosun/");
  if (
    !configJson.agentPrompts ||
    Object.keys(configJson.agentPrompts).length === 0
  ) {
    configJson.agentPrompts = getDefaultPromptOverrides();
  }

  // ── .env file ──────────────────────────────────────────
  const envPath = resolve(targetDir, ".env");

  const envTemplatePath = resolve(__dirname, ".env.example");
  const templateText = existsSync(envTemplatePath)
    ? readFileSync(envTemplatePath, "utf8")
    : "";

  const envOut = templateText
    ? buildStandardizedEnvFile(templateText, env)
    : buildStandardizedEnvFile("", env);

  if (existsSync(envPath)) {
    // ── Merge into existing .env ──
    // Back up the current .env, then merge new values into it.
    // Strategy: preserve existing user values for keys they explicitly set,
    // add new keys from the setup wizard, update keys the user changed in setup.
    const backupPath = resolve(targetDir, `.env.backup.${Date.now()}`);
    const existingContent = readFileSync(envPath, "utf8");
    writeFileSync(backupPath, existingContent, "utf8");
    info(`.env backed up to ${relative(repoRoot, backupPath)}`);

    const merged = mergeEnvFiles(existingContent, env);
    writeFileSync(envPath, merged, "utf8");
    success(`Environment merged into ${relative(repoRoot, envPath)}`);
  } else {
    writeFileSync(envPath, envOut, "utf8");
    success(`Environment written to ${relative(repoRoot, envPath)}`);
  }

  // ── bosun.config.json ──────────────────────────
  // Write config with schema reference for editor autocomplete
  const configOut = { $schema: "./bosun.schema.json", ...configJson };
  const configPath = resolve(targetDir, "bosun.config.json");
  writeFileSync(configPath, JSON.stringify(configOut, null, 2) + "\n", "utf8");
  success(`Config written to ${relative(repoRoot, configPath)}`);

  const localProtocol = parseBooleanEnvValue(env.TELEGRAM_UI_TLS_DISABLE, false) ? "http" : "https";
  const localHost = String(env.TELEGRAM_UI_DESKTOP_HOST || env.TELEGRAM_UI_HOST || "127.0.0.1").trim() || "127.0.0.1";
  const localPort = normalizeTelegramUiPort(env.TELEGRAM_UI_PORT || process.env.TELEGRAM_UI_PORT);
  const localConnection = buildLocalConnectionEntry({
    name: "Local Backend",
    host: localHost,
    port: Number(localPort),
    protocol: localProtocol,
  });
  if (localConnection) {
    const remoteConnectionConfig = setLocalConnectionConfig(
      readRemoteConnectionConfig(targetDir),
      localConnection,
    );
    saveRemoteConnectionConfig(remoteConnectionConfig, targetDir);
    success(`Backend connection seeded for ${localConnection.endpoint}`);
  }

  const installAssistiveActions = parseBooleanEnvValue(
    env.BOSUN_PR_ASSISTIVE_ACTIONS_INSTALL_ON_SETUP
      ?? configJson.prAutomation?.assistiveActions?.installOnSetup,
    false,
  );

  if (installAssistiveActions) {
    heading("Assistive GitHub Actions");
    const workflowSources = [
      {
        source: resolve(__dirname, ".github", "workflows", "bosun-pr-attach.yml"),
        targetParts: [".github", "workflows", "bosun-pr-attach.yml"],
      },
      {
        source: resolve(__dirname, ".github", "workflows", "bosun-pr-ci-signal.yml"),
        targetParts: [".github", "workflows", "bosun-pr-ci-signal.yml"],
      },
    ];
    const repoTargets = [];
    const seenRepoTargets = new Set();
    const addRepoTarget = (repoPath) => {
      const fullPath = resolve(String(repoPath || ""));
      if (!fullPath || seenRepoTargets.has(fullPath)) return;
      if (!existsSync(fullPath) || !existsSync(resolve(fullPath, ".git"))) return;
      seenRepoTargets.add(fullPath);
      repoTargets.push(fullPath);
    };

    addRepoTarget(repoRoot);
    const bosunDir = env.BOSUN_DIR || configDir || targetDir;
    const workspaceRoot = resolve(bosunDir, "workspaces");
    for (const workspace of Array.isArray(configOut.workspaces) ? configOut.workspaces : []) {
      for (const repo of Array.isArray(workspace?.repos) ? workspace.repos : []) {
        addRepoTarget(resolve(workspaceRoot, workspace.id || workspace.name || "", repo.name || ""));
      }
    }

    for (const repoPath of repoTargets) {
      for (const workflow of workflowSources) {
        const targetPath = resolve(repoPath, ...workflow.targetParts);
        if (existsSync(targetPath)) {
          info(`Assistive workflow already present: ${relative(repoRoot, targetPath)}`);
          continue;
        }
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, readFileSync(workflow.source, "utf8"), "utf8");
        success(`Installed assistive workflow: ${relative(repoRoot, targetPath)}`);
      }
    }
  } else {
    info("Assistive GitHub Actions left uninstalled. Bosun runtime workflows still operate without them.");
  }

  // If the setup target directory differs from the package dir but a local .env
  // exists there without a config file, seed a config copy to avoid mismatches.
  const packageDir = resolve(__dirname);
  if (resolve(packageDir) !== resolve(targetDir)) {
    const packageEnvPath = resolve(packageDir, ".env");
    const packageConfigPath = resolve(packageDir, "bosun.config.json");
    if (existsSync(packageEnvPath) && !existsSync(packageConfigPath)) {
      writeFileSync(
        packageConfigPath,
        JSON.stringify(configOut, null, 2) + "\n",
        "utf8",
      );
      success(`Config written to ${relative(repoRoot, packageConfigPath)}`);
    }
  }

  // ── Workspace VS Code settings ─────────────────────────
  const vscodeSettingsResult = writeWorkspaceVsCodeSettings(repoRoot, env);
  if (vscodeSettingsResult.updated) {
    success(
      `Workspace settings updated: ${relative(repoRoot, vscodeSettingsResult.path)}`,
    );
  } else if (vscodeSettingsResult.error) {
    warn(`Could not update workspace settings: ${vscodeSettingsResult.error}`);
  }

  const copilotMcpResult = writeWorkspaceCopilotMcpConfig(repoRoot);
  if (copilotMcpResult.updated) {
    success(
      `Copilot MCP config updated: ${relative(repoRoot, copilotMcpResult.path)}`,
    );
  } else if (copilotMcpResult.error) {
    warn(`Could not update Copilot MCP config: ${copilotMcpResult.error}`);
  }

  // Derive primary SDK from executor configuration.
  const primaryExecutor = (configJson.executors || []).find(
    (e) => e.role === "primary",
  );
  const executorToPrimarySdk = {
    CODEX: "codex",
    COPILOT: "copilot",
    CLAUDE: "claude",
  };
  const primarySdk = primaryExecutor
    ? executorToPrimarySdk[String(primaryExecutor.executor).toUpperCase()] ||
      "codex"
    : "codex";
  const repoConfigOptions = {
    primarySdk,
  };

  // ── Repo-level AI configs for all workspace repos ──────
  heading("Repo-Level AI Configs");
  try {
    const { ensureRepoConfigs, printRepoConfigSummary } = await import("./config/repo-config.mjs");
    // Apply to the primary repo
    const repoResult = ensureRepoConfigs(repoRoot, repoConfigOptions);
    printRepoConfigSummary(repoResult, (msg) => console.log(msg));

    // Also apply to all workspace repos under $BOSUN_DIR/workspaces/
    const bosunDir = env.BOSUN_DIR || configDir || resolve(homedir(), "bosun");
    const bosunConfigPath = resolve(bosunDir, "bosun.config.json");
    if (existsSync(bosunConfigPath)) {
      try {
        const bosunCfg = JSON.parse(readFileSync(bosunConfigPath, "utf8"));
        const wsDir = resolve(bosunDir, "workspaces");
        for (const ws of bosunCfg.workspaces || []) {
          for (const repo of ws.repos || []) {
            const wsRepoPath = resolve(wsDir, ws.id || ws.name || "", repo.name);
            if (wsRepoPath !== repoRoot && existsSync(wsRepoPath)) {
              const wsResult = ensureRepoConfigs(wsRepoPath, repoConfigOptions);
              const anyChange = Object.values(wsResult).some((r) => r.created || r.updated);
              if (anyChange) {
                info(`Workspace repo: ${repo.name}`);
                printRepoConfigSummary(wsResult, (msg) => console.log(msg));
              }
            }
          }
        }
      } catch (wsErr) {
        warn(`Could not update workspace repo configs: ${wsErr.message}`);
      }
    }
  } catch (rcErr) {
    warn(`Could not apply repo-level configs: ${rcErr.message}`);
  }

  // ── Codex CLI config.toml ─────────────────────────────
  heading("Codex CLI Config");
  const tomlResult = ensureCodexConfig({
    dryRun: false,
    primarySdk,
    env: {
      ...process.env,
      ...env,
    },
  });
  printConfigSummary(tomlResult, (msg) => console.log(msg));

  // ── Install dependencies ───────────────────────────────
  heading("Installing Dependencies");
  try {
    if (commandExists("pnpm")) {
      execSync("pnpm install", { cwd: __dirname, stdio: "inherit" });
    } else {
      execSync("npm install", { cwd: __dirname, stdio: "inherit" });
    }
    success("Dependencies installed");
  } catch {
    warn(
      "Dependency install failed — run manually: pnpm install (or) npm install",
    );
  }

  // ── Desktop shortcut ───────────────────────────────────
  if (env._DESKTOP_SHORTCUT === "1") {
    heading("Desktop Shortcut");
    try {
      const { installDesktopShortcut } = await import("./infra/desktop-shortcut.mjs");
      const result = installDesktopShortcut();
      if (result.success) {
        success(`Desktop shortcut installed (${result.method})`);
        if (result.path) info(`Path: ${result.path}`);
      } else {
        warn(`Could not install desktop shortcut: ${result.error}`);
      }
    } catch (err) {
      warn(`Desktop shortcut installation failed: ${err.message}`);
    }
  } else if (env._DESKTOP_SHORTCUT === "0") {
    info("Desktop shortcut skipped — enable anytime: bosun --desktop-shortcut");
  }

  // ── Startup Service ────────────────────────────────────
  if (env._STARTUP_SERVICE === "1") {
    heading("Startup Service");
    try {
      const { installStartupService } = await import("./infra/startup-service.mjs");
      const result = await installStartupService({ daemon: true });
      if (result.success) {
        success(`Registered via ${result.method}`);
        if (result.name) info(`Service name: ${result.name}`);
        if (result.path) info(`Config path: ${result.path}`);
      } else {
        warn(`Could not register startup service: ${result.error}`);
        info("You can try manually later: bosun --enable-startup");
      }
    } catch (err) {
      warn(`Startup service registration failed: ${err.message}`);
      info("You can try manually later: bosun --enable-startup");
    }
  } else if (env._STARTUP_SERVICE === "0") {
    info(
      "Startup service skipped — enable anytime: bosun --setup",
    );
  }

  // ── Start Bosun Now ────────────────────────────────────
  if (env._START_AFTER_SETUP === "1") {
    heading("Starting Bosun");
    try {
      const { spawn: _spawn } = await import("child_process");
      const cliPath = resolve(__dirname, "cli.mjs");
      const daemonChild = _spawn(
        process.execPath,
        [cliPath, "--daemon"],
        {
          detached: true,
          stdio: "ignore",
          cwd: __dirname,
          windowsHide: true,
        },
      );
      daemonChild.unref();
      success("Bosun started in background (daemon mode)");
      info("Check status:  bosun --daemon-status");
      info("View logs:     bosun --logs");
      if (env._OPEN_PORTAL_AFTER_SETUP === "1") {
        const { resolveElectronLauncher: _getLauncher } =
          await import("./infra/desktop-shortcut.mjs");
        const launcher = _getLauncher();
        if (launcher?.executable) {
          const portalChild = _spawn(
            launcher.executable,
            launcher.args || [],
            { detached: true, stdio: "ignore", windowsHide: false },
          );
          portalChild.unref();
          success("Bosun portal is opening...");
        } else {
          warn("Electron not found — portal launch skipped.");
          info("Open the portal manually: bosun --desktop");
        }
      }
    } catch (err) {
      warn(`Could not start Bosun: ${err.message}`);
      info("Start manually: bosun --daemon");
    }
  }

  // ── Summary ────────────────────────────────────────────
  console.log("");
  console.log(
    "  ╔═══════════════════════════════════════════════════════════════╗",
  );
  console.log(
    "  ║                    :check: Setup Complete!                        ║",
  );
  console.log(
    "  ╚═══════════════════════════════════════════════════════════════╝",
  );
  console.log("");

  // Executor summary
  const totalWeight = configJson.executors.reduce((s, e) => s + e.weight, 0);
  console.log(chalk.bold("  Executors:"));
  for (const e of configJson.executors) {
    const pct =
      totalWeight > 0 ? Math.round((e.weight / totalWeight) * 100) : 0;
    console.log(
      `    ${e.role.padEnd(10)} ${e.executor}:${e.variant} — ${pct}%`,
    );
  }
  console.log(
    chalk.dim(
      `  Strategy: ${configJson.distribution} distribution, ${configJson.failover.strategy} failover`,
    ),
  );

  // Missing items
  console.log("");
  if (!env.TELEGRAM_BOT_TOKEN && !process.env.TELEGRAM_BOT_TOKEN) {
    info("Telegram not configured — add TELEGRAM_BOT_TOKEN to .env later.");
  }
  if (
    !env.OPENAI_API_KEY &&
    !env.AZURE_OPENAI_API_KEY &&
    !env.CODEX_MODEL_PROFILE_XL_API_KEY &&
    !env.CODEX_MODEL_PROFILE_M_API_KEY &&
    !process.env.OPENAI_API_KEY &&
    !process.env.AZURE_OPENAI_API_KEY &&
    !process.env.CODEX_MODEL_PROFILE_XL_API_KEY &&
    !process.env.CODEX_MODEL_PROFILE_M_API_KEY &&
    !parseBooleanEnvValue(env.CODEX_SDK_DISABLED, false)
  ) {
    info("No API key set — AI analysis & autofix will be disabled.");
  }
  if (
    !env.GEMINI_API_KEY &&
    !env.GOOGLE_API_KEY &&
    !process.env.GEMINI_API_KEY &&
    !process.env.GOOGLE_API_KEY &&
    !parseBooleanEnvValue(env.GEMINI_SDK_DISABLED, false)
  ) {
    info("No Gemini key set — Gemini SDK will be unavailable until configured.");
  }

  console.log("");
  console.log(chalk.bold("  Next steps:"));
  console.log("");
  console.log(chalk.green("    bosun"));
  console.log(chalk.dim("    Start the orchestrator supervisor\n"));
  console.log(chalk.green("    bosun --setup"));
  console.log(chalk.dim("    Re-run this wizard anytime\n"));
  console.log(chalk.green("    bosun --enable-startup"));
  console.log(chalk.dim("    Register auto-start on login (or use bosun --setup for the full wizard)\n"));
  console.log(chalk.green("    bosun --help"));
  console.log(chalk.dim("    See all options & env vars\n"));
}

// ── Auto-Launch Detection ────────────────────────────────────────────────────

/**
 * Check whether setup should run automatically (first launch detection).
 * Called from monitor.mjs before starting the main loop.
 */
export function shouldRunSetup() {
  // Apply legacy compat so BOSUN_DIR is set before resolveConfigDir is called
  applyAllCompatibility();

  // If a legacy codex-monitor setup exists and the user hasn't migrated yet,
  // skip the setup wizard — they are already configured.
  const legacyInfo = detectLegacySetup();
  if (legacyInfo.hasLegacy) return false;

  // Always check the package directory first — this is where bosun stores its
  // config when installed within a project (e.g. scripts/bosun/).
  // This prevents false "first run" detection when cwd differs from install dir.
  if (hasSetupMarkers(__dirname)) return false;

  const repoRoot = detectRepoRoot();
  const configDir = resolveConfigDir(repoRoot);
  return !hasSetupMarkers(configDir);
}

/**
 * Run setup wizard. Can be imported and called from monitor.mjs.
 */
export async function runSetup() {
  await main();
}

export {
  applyTelegramMiniAppDefaults,
  normalizeTelegramUiPort,
  extractProjectNumber,
  resolveOrCreateGitHubProjectNumber,
  resolveOrCreateGitHubProject,
  runGhCommand,
  readSetupProgress,
  writeSetupSnapshot,
  buildWorkspaceChoices,
  getGitHubAuthScopes,
  buildRecommendedVsCodeSettings,
  writeWorkspaceVsCodeSettings,
};

// ── Entry Point ──────────────────────────────────────────────────────────────

// Only run the wizard when executed directly (not when imported by cli.mjs)
const __filename_setup = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename_setup)) {
  main().catch((err) => {
    console.error(`\n  Setup failed: ${err.message}\n`);
    process.exit(1);
  });
}
