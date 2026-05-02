/**
 * workflow-nodes.mjs — Built-in Workflow Node Types for Bosun
 *
 * Registers all standard node types that can be used in workflow definitions.
 * Node types are organized by category:
 *
 *   TRIGGERS    — Events that start workflow execution
 *   CONDITIONS  — Branching logic / gates
 *   ACTIONS     — Side-effect operations (run agent, create task, etc.)
 *   VALIDATION  — Verification gates (screenshots, tests, model review)
 *   TRANSFORM   — Data transformation / aggregation
 *   NOTIFY      — Notifications (telegram, log, etc.)
 *
 * Each node type must export:
 *   execute(node, ctx, engine) → Promise<any>   — The node's logic
 *   describe() → string                         — Human-readable description
 *   schema → object                             — JSON Schema for node config
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { execSync, execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { getAgentToolConfig, getEffectiveTools } from "../../agent/agent-tool-config.mjs";
import { getToolsPromptBlock } from "../../agent/agent-custom-tools.mjs";
import { buildRelevantSkillsPromptBlock, findRelevantSkills } from "../../agent/bosun-skills.mjs";
import { getSessionTracker } from "../../infra/session-tracker.mjs";
import { fixGitConfigCorruption } from "../../workspace/worktree-manager.mjs";
import { registerNodeType as registerWorkflowEngineNodeType } from "../workflow-engine.mjs";

const TAG = "[workflow-nodes]";
const DEFAULT_GIT_EXEC_MAX_BUFFER = 16 * 1024 * 1024;
const PORTABLE_WORKTREE_COUNT_COMMAND = "node -e \"const cp=require('node:child_process');const wt=cp.execSync('git worktree list --porcelain',{encoding:'utf8'});const count=(wt.match(/^worktree /gm)||[]).length;process.stdout.write(String(count)+'\\\\n');\"";
const PORTABLE_PRUNE_AND_COUNT_WORKTREES_COMMAND = "node -e \"const cp=require('node:child_process');cp.execSync('git worktree prune',{stdio:'ignore'});const wt=cp.execSync('git worktree list --porcelain',{encoding:'utf8'});const count=(wt.match(/^worktree /gm)||[]).length;process.stdout.write(String(count)+'\\\\n');\"";
const WORKFLOW_AGENT_HEARTBEAT_MS = (() => {
  const raw = Number(process.env.WORKFLOW_AGENT_HEARTBEAT_MS || 30000);
  if (!Number.isFinite(raw)) return 30000;
  return Math.max(5000, Math.min(120000, Math.trunc(raw)));
})();
const WORKFLOW_AGENT_EVENT_PREVIEW_LIMIT = (() => {
  const raw = Number(process.env.WORKFLOW_AGENT_EVENT_PREVIEW_LIMIT || 80);
  if (!Number.isFinite(raw)) return 80;
  return Math.max(20, Math.min(500, Math.trunc(raw)));
})();
const BOSUN_ATTACHED_PR_LABEL = "bosun-attached";
const BOSUN_CREATED_PR_LABEL = "bosun-pr-bosun-created";

const _builtinNodeDefinitions = new Map();
function registerNodeType(type, handler) {
  if (!handler || typeof handler.execute !== "function") {
    throw new Error(`${TAG} Node type "${type}" must have an execute function`);
  }
  _builtinNodeDefinitions.set(type, handler);
  registerWorkflowEngineNodeType(type, handler, { source: "builtin" });
}

export function getBuiltinNodeDefinition(type) {
  return _builtinNodeDefinitions.get(type) || null;
}

export function listBuiltinNodeDefinitions() {
  return [..._builtinNodeDefinitions.entries()].map(([type, handler]) => ({
    type,
    handler,
  }));
}

function appendSafeDirectoryGitConfig(env, safeDirectories = []) {
  const normalizedDirectories = Array.from(new Set(
    (Array.isArray(safeDirectories) ? safeDirectories : [safeDirectories])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .map((value) => resolve(value)),
  ));
  if (normalizedDirectories.length === 0) return env;

  const nextEnv = { ...env };
  let configCount = Number.parseInt(String(nextEnv.GIT_CONFIG_COUNT || "0"), 10);
  if (!Number.isFinite(configCount) || configCount < 0) configCount = 0;

  const existingSafeDirectories = new Set();
  for (let index = 0; index < configCount; index += 1) {
    if (String(nextEnv[`GIT_CONFIG_KEY_${index}`] || "").trim() !== "safe.directory") continue;
    const existingValue = String(nextEnv[`GIT_CONFIG_VALUE_${index}`] || "").trim();
    if (existingValue) existingSafeDirectories.add(resolve(existingValue));
  }

  for (const directory of normalizedDirectories) {
    if (existingSafeDirectories.has(directory)) continue;
    nextEnv[`GIT_CONFIG_KEY_${configCount}`] = "safe.directory";
    nextEnv[`GIT_CONFIG_VALUE_${configCount}`] = directory;
    existingSafeDirectories.add(directory);
    configCount += 1;
  }

  nextEnv.GIT_CONFIG_COUNT = String(configCount);
  return nextEnv;
}

function makeIsolatedGitEnv(extra = {}, options = {}) {
  const env = { ...process.env, ...extra };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_PREFIX",
  ]) {
    delete env[key];
  }
  const safeDirectories = [
    ...(Array.isArray(options?.safeDirectories) ? options.safeDirectories : []),
    options?.cwd,
  ];
  return appendSafeDirectoryGitConfig(env, safeDirectories);
}

function resolveGitCandidates(env = process.env) {
  const candidates = [];
  const envGitExe = env?.GIT_EXE || process.env.GIT_EXE;
  if (envGitExe) candidates.push(envGitExe);
  if (process.platform === "win32") {
    candidates.push(
      "C:\\Program Files\\Git\\cmd\\git.exe",
      "C:\\Program Files\\Git\\bin\\git.exe",
      "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
      "C:\\Program Files (x86)\\Git\\bin\\git.exe",
    );
  } else {
    candidates.push(
      "/usr/bin/git",
      "/usr/local/bin/git",
      "/bin/git",
      "/opt/homebrew/bin/git",
    );
  }

  if (process.platform === "win32") {
    try {
      const whereOutput = execFileSync("where.exe", ["git"], {
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      for (const line of String(whereOutput || "").split(/\r?\n/)) {
        const candidate = line.trim();
        if (!candidate) continue;
        candidates.push(candidate);
      }
    } catch {
      /* best-effort */
    }
  }

  candidates.push("git");
  const deduped = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = process.platform === "win32"
      ? String(candidate || "").toLowerCase()
      : String(candidate || "");
    if (!candidate || seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

function buildGitExecutionEnv(baseEnv, gitBinary) {
  if (process.platform !== "win32") return baseEnv;
  const normalizedBinary = String(gitBinary || "").replace(/\//g, "\\");
  if (!normalizedBinary.includes("\\") || !normalizedBinary.toLowerCase().endsWith("\\git.exe")) {
    return baseEnv;
  }
  const env = { ...baseEnv };
  const pathKey = Object.prototype.hasOwnProperty.call(env, "Path")
    ? "Path"
    : "PATH";
  const existing = String(env[pathKey] ?? env.PATH ?? env.Path ?? "");
  const parts = existing
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  const seen = new Set(parts.map((part) => part.toLowerCase()));
  const binaryDir = dirname(normalizedBinary);
  const gitRoot = dirname(binaryDir);
  for (const dir of [
    binaryDir,
    `${gitRoot}\\cmd`,
    `${gitRoot}\\bin`,
    `${gitRoot}\\mingw64\\bin`,
    `${gitRoot}\\usr\\bin`,
  ]) {
    const normalizedDir = String(dir || "").replace(/\//g, "\\");
    if (!normalizedDir || seen.has(normalizedDir.toLowerCase())) continue;
    seen.add(normalizedDir.toLowerCase());
    parts.unshift(normalizedDir);
  }
  env[pathKey] = parts.join(";");
  if (pathKey === "PATH") env.Path = env[pathKey];
  else env.PATH = env[pathKey];
  return env;
}

function execGitArgsSync(args, options = {}) {
  if (!Array.isArray(args) || !args.length) {
    throw new Error("execGitArgsSync requires a non-empty args array");
  }
  const env = makeIsolatedGitEnv(options.env);
  if (env.GIT_TERMINAL_PROMPT == null) env.GIT_TERMINAL_PROMPT = "0";
  if (env.GCM_INTERACTIVE == null) env.GCM_INTERACTIVE = "never";
  if (env.GIT_ASKPASS == null) env.GIT_ASKPASS = "echo";
  const gitArgs = args.map((arg) => String(arg));
  let lastEnoent = null;
  for (const gitBinary of resolveGitCandidates(env)) {
    const execOptions = {
      ...options,
      env: buildGitExecutionEnv(env, gitBinary),
    };
    if (execOptions.maxBuffer == null) {
      execOptions.maxBuffer = DEFAULT_GIT_EXEC_MAX_BUFFER;
    }
    try {
      return execFileSync(gitBinary, gitArgs, execOptions);
    } catch (error) {
      if (error?.code === "ENOENT") {
        lastEnoent = error;
        continue;
      }
      if (process.platform === "win32" && error?.code === "EPERM") {
        const fallback = spawnSync(gitBinary, gitArgs, execOptions);
        if (fallback?.error?.code === "ENOENT") {
          lastEnoent = fallback.error;
          continue;
        }
        if (!fallback?.error && Number(fallback?.status) === 0) {
          return fallback.stdout;
        }
        if (fallback?.error) {
          fallback.error.stdout = fallback.stdout;
          fallback.error.stderr = fallback.stderr;
          throw fallback.error;
        }
      }
      throw error;
    }
  }
  if (lastEnoent) throw lastEnoent;
  throw new Error("Git executable not found");
}

function trimLogText(value, max = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function trimLogTextPreservingTail(value, max = 180, tailChars = 80) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const safeMax = Number.isFinite(Number(max)) ? Math.max(8, Math.trunc(Number(max))) : 180;
  if (text.length <= safeMax) return text;
  const ellipsis = " ... ";
  const safeTail = Number.isFinite(Number(tailChars))
    ? Math.max(0, Math.trunc(Number(tailChars)))
    : 80;
  const tail = Math.min(safeTail, Math.max(0, safeMax - ellipsis.length - 1));
  const head = Math.max(1, safeMax - ellipsis.length - tail);
  return `${text.slice(0, head)}${ellipsis}${text.slice(-tail)}`;
}

function normalizeLineEndings(value) {
  if (value == null) return "";
  return String(value)
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function simplifyPathLabel(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  if (!normalized) return "";
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length >= 2) return parts.slice(-2).join("/");
  return parts[0] || normalized;
}

const PR_EVENT_ALIAS_MAP = Object.freeze({
  open: "opened",
  opened: "opened",
  reopen: "opened",
  reopened: "opened",
  ready_for_review: "opened",
  readyforreview: "opened",
  synchronize: "opened",
  synchronized: "opened",
  edited: "opened",
  merge: "merged",
  merged: "merged",
  review_requested: "review_requested",
  reviewrequest: "review_requested",
  review_requested_event: "review_requested",
  changes_requested: "changes_requested",
  change_requested: "changes_requested",
  requested_changes: "changes_requested",
  approved: "approved",
  approval: "approved",
  close: "closed",
  closed: "closed",
});

function normalizePrEventName(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  const normalized = raw.replace(/[\s-]+/g, "_");
  return PR_EVENT_ALIAS_MAP[normalized] || normalized;
}

function evaluateTaskAssignedTriggerConfig(config = {}, eventData = {}) {
  let triggered = eventData?.eventType === "task.assigned";
  if (!triggered) return false;

  const task = eventData?.task || eventData || {};
  const expectedAgentType = String(config?.agentType || "").trim().toLowerCase();
  if (expectedAgentType) {
    const candidateTypes = new Set(
      [
        eventData?.agentType,
        eventData?.assignedAgentType,
        eventData?.task?.agentType,
        eventData?.task?.assignedAgentType,
        eventData?.task?.agentProfile,
        task?.agentType,
        task?.assignedAgentType,
        task?.agentProfile,
      ]
        .map((value) => String(value || "").trim().toLowerCase())
        .filter(Boolean),
    );
    triggered = candidateTypes.has(expectedAgentType);
  }

  if (triggered && config?.taskPattern) {
    try {
      const regex = new RegExp(String(config.taskPattern), "i");
      const searchableText = [
        eventData?.taskTitle,
        task?.title,
        ...(Array.isArray(task?.tags) ? task.tags : []),
      ]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .join(" ");
      triggered = regex.test(searchableText);
    } catch {
      triggered = false;
    }
  }

  if (triggered && config?.filter) {
    try {
      const fn = new Function("task", "$data", `return !!(${config.filter});`);
      triggered = Boolean(fn(task, eventData));
    } catch {
      triggered = false;
    }
  }

  return triggered;
}

function listManagedBosunWorktreeRoots(repoRoot) {
  const normalizedRepoRoot = resolve(String(repoRoot || process.cwd()));
  const roots = new Set([
    resolve(normalizedRepoRoot, ".bosun", "worktrees"),
  ]);
  try {
    const output = execGitArgsSync(["worktree", "list", "--porcelain"], {
      cwd: normalizedRepoRoot,
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const line of String(output || "").split(/\r?\n/)) {
      if (!line.startsWith("worktree ")) continue;
      const attachedRoot = resolve(line.slice("worktree ".length).trim());
      if (!attachedRoot) continue;
      roots.add(resolve(attachedRoot, ".bosun", "worktrees"));
    }
  } catch {
    // Best-effort only. Fall back to the repo-local managed root.
  }
  return [...roots];
}

function isManagedBosunWorktree(worktreePath, repoRoot) {
  const resolvedWorktree = resolve(String(worktreePath || ""));
  const managedRoots = listManagedBosunWorktreeRoots(repoRoot);
  return managedRoots.some((managedRoot) => (
    resolvedWorktree === managedRoot ||
    resolvedWorktree.startsWith(`${managedRoot}\\`) ||
    resolvedWorktree.startsWith(`${managedRoot}/`)
  ));
}

function deriveManagedWorktreeDirName(taskId, branch) {
  const taskToken = String(taskId || "task")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 12)
    || "task";
  const branchHash = createHash("sha1")
    .update(String(branch || "branch"))
    .digest("hex")
    .slice(0, 10);
  return `task-${taskToken}-${branchHash}`;
}

const WORKFLOW_TELEGRAM_ICON_MAP = Object.freeze({
  check: "✅",
  close: "❌",
  alert: "⚠️",
  warning: "⚠️",
  help: "❓",
  info: "ℹ️",
  dot: "•",
  folder: "📁",
  refresh: "🔄",
  lock: "🔒",
  unlock: "🔓",
  play: "▶️",
  pause: "⏸️",
  stop: "⏹️",
  rocket: "🚀",
  gear: "⚙️",
  wrench: "🔧",
  search: "🔍",
  clipboard: "📋",
  chart: "📊",
  hourglass: "⏳",
  fire: "🔥",
  bug: "🐛",
  sparkles: "✨",
});

function decodeWorkflowUnicodeIconToken(name) {
  const raw = String(name || "").trim().toLowerCase();
  if (!raw) return "";
  const normalized = raw.startsWith("u") ? raw.slice(1) : raw;
  if (!/^[0-9a-f]{4,6}$/.test(normalized)) return "";
  try {
    return String.fromCodePoint(parseInt(normalized, 16));
  } catch {
    return "";
  }
}

function normalizeWorkflowTelegramText(value) {
  const text = String(value || "");
  if (!text) return "";
  return text.replace(/:([a-zA-Z0-9_+-]{2,}):/g, (token, iconName) => {
    const key = String(iconName || "").trim().toLowerCase();
    if (!key) return token;
    const squashed = key.replace(/[-+]/g, "");
    const glyph = WORKFLOW_TELEGRAM_ICON_MAP[key]
      || WORKFLOW_TELEGRAM_ICON_MAP[squashed]
      || decodeWorkflowUnicodeIconToken(key)
      || decodeWorkflowUnicodeIconToken(squashed);
    return glyph || token;
  });
}

function isAsciiDigit(value) {
  return value >= "0" && value <= "9";
}
function buildPathListingResult(pathValue, lineValue, detailValue) {
  const path = String(pathValue || "").trim();
  const lineText = String(lineValue || "").trim();
  if (!path || !lineText) return null;
  for (const char of lineText) {
    if (!isAsciiDigit(char)) return null;
  }
  return {
    path,
    line: Number(lineText),
    detail: String(detailValue || "").trim(),
  };
}
function parsePathListingLine(line) {
  const raw = String(line || "").trim();
  if (!raw) return null;
  if (raw.length > 3 && raw[1] === ":" && (raw[2] === "\\" || raw[2] === "/")) {
    const lineSep = raw.indexOf(":", 3);
    if (lineSep !== -1) {
      const detailSep = raw.indexOf(":", lineSep + 1);
      if (detailSep !== -1) {
        return buildPathListingResult(raw.slice(0, lineSep), raw.slice(lineSep + 1, detailSep), raw.slice(detailSep + 1));
      }
    }
  }
  if (raw.startsWith("/")) {
    const lineSep = raw.indexOf(":", 1);
    if (lineSep !== -1) {
      const detailSep = raw.indexOf(":", lineSep + 1);
      if (detailSep !== -1) {
        return buildPathListingResult(raw.slice(0, lineSep), raw.slice(lineSep + 1, detailSep), raw.slice(detailSep + 1));
      }
    }
  }
  return null;
}

function extractSymbolHint(detail) {
  const text = String(detail || "");
  if (!text) return "";
  const patterns = [
    /\b(?:async\s+)?function\s+([A-Za-z0-9_$]+)/i,
    /\bclass\s+([A-Za-z0-9_$]+)/i,
    /\b(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/i,
    /\b([A-Za-z0-9_$]+)\s*:\s*function\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return "";
}

function summarizePathListingBlock(value) {
  const lines = normalizeLineEndings(value)
    .split("\n")
    .map((line) => String(line || "").trim())
    .filter(Boolean);
  if (!lines.length) return "";

  const entries = [];
  for (const line of lines) {
    const parsed = parsePathListingLine(line);
    if (parsed) entries.push(parsed);
  }

  if (entries.length < 3) return "";
  const fileStats = new Map();
  const symbols = new Set();
  for (const entry of entries) {
    const label = simplifyPathLabel(entry.path) || entry.path;
    const current = fileStats.get(label) || { count: 0 };
    current.count += 1;
    fileStats.set(label, current);
    const symbol = extractSymbolHint(entry.detail);
    if (symbol) symbols.add(symbol);
  }

  const fileList = Array.from(fileStats.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 4)
    .map(([label, stat]) => `${label} (${stat.count})`)
    .join(", ");
  const symbolList = Array.from(symbols).slice(0, 6).join(", ");

  const summaryParts = [
    `Indexed ${entries.length} code references across ${fileStats.size} file${fileStats.size === 1 ? "" : "s"}`,
  ];
  if (fileList) summaryParts.push(`Top files: ${fileList}`);
  if (symbolList) summaryParts.push(`Symbols: ${symbolList}`);

  return trimLogText(summaryParts.join(". "), 320);
}

function normalizeNarrativeText(value, options = {}) {
  const maxParagraphs = Number.isFinite(options.maxParagraphs) ? options.maxParagraphs : 4;
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : 2200;
  const raw = normalizeLineEndings(value);
  if (!raw) return "";

  const pathSummary = summarizePathListingBlock(raw);
  if (pathSummary) return pathSummary;

  const paragraphs = raw
    .split(/\n{2,}/)
    .map((paragraph) =>
      paragraph
        .split("\n")
        .map((line) => String(line || "").trim())
        .filter(Boolean)
        .join(" "),
    )
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, Math.max(1, maxParagraphs));

  const text = paragraphs.join("\n\n").trim();
  if (!text) return "";
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function summarizeAssistantUsage(data = {}) {
  const usage = data?.usage && typeof data.usage === "object" ? data.usage : data;
  if (!usage || typeof usage !== "object") return "";

  const pickNumber = (...keys) => {
    for (const key of keys) {
      const candidate = Number(usage?.[key]);
      if (Number.isFinite(candidate) && candidate >= 0) return candidate;
    }
    return null;
  };

  const model = trimLogText(usage?.model || data?.model || "", 60);
  const prompt = pickNumber("prompt_tokens", "inputTokens", "promptTokens");
  const completion = pickNumber("completion_tokens", "outputTokens", "completionTokens");
  const total = pickNumber("total_tokens", "totalTokens");
  const durationMs = pickNumber("duration", "durationMs");
  const parts = [];

  if (model) parts.push(`model=${model}`);
  if (prompt != null) parts.push(`prompt=${prompt}`);
  if (completion != null) parts.push(`completion=${completion}`);
  if (total != null) parts.push(`total=${total}`);
  if (durationMs != null) parts.push(`duration=${Math.round(durationMs)}ms`);
  if (!parts.length) return "";
  return `Usage: ${parts.join(" · ")}`;
}

function bindTaskContext(ctx, { taskId, taskTitle, task = null } = {}) {
  if (!ctx || typeof ctx !== "object") return;
  if (!ctx.data || typeof ctx.data !== "object") {
    ctx.data = {};
  }

  const normalizedTaskId = String(taskId || task?.id || task?.task_id || "").trim();
  if (normalizedTaskId) {
    ctx.data.taskId = normalizedTaskId;
    ctx.data.activeTaskId = normalizedTaskId;
  }

  const normalizedTaskTitle = String(taskTitle || task?.title || "").trim();
  if (normalizedTaskTitle) {
    ctx.data.taskTitle = normalizedTaskTitle;
  }

  if (task && typeof task === "object") {
    ctx.data.task = task;
  }
}
async function createKanbanTaskWithProject(kanban, taskData = {}, projectIdValue = "") {
  if (!kanban || typeof kanban.createTask !== "function") {
    throw new Error("Kanban adapter not available");
  }

  const payload =
    taskData && typeof taskData === "object" ? { ...taskData } : {};
  const resolvedProjectId = String(projectIdValue || payload.projectId || "").trim();

  if (resolvedProjectId) {
    payload.projectId = resolvedProjectId;
  }

  const createTaskParamNames = (() => {
    try {
      const inspectTarget =
        typeof kanban.createTask?.getMockImplementation === "function"
          ? kanban.createTask.getMockImplementation() || kanban.createTask
          : kanban.createTask;
      const source = Function.prototype.toString.call(inspectTarget);
      const parenMatch = source.match(/^[^(]*\(([^)]*)\)/s);
      if (parenMatch) {
        return String(parenMatch[1] || "")
          .split(",")
          .map((entry) =>
            String(entry || "")
              .trim()
              .replace(/^\.{3}/, "")
              .replace(/\s*=.*$/s, "")
              .trim(),
          )
          .filter(Boolean);
      }
      const arrowMatch = source.match(/^(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/);
      if (arrowMatch?.[1]) return [arrowMatch[1]];
    } catch {
      // Fall back to the project-aware signature when adapter source is opaque.
    }
    return [];
  })();
  const firstParamName = String(createTaskParamNames[0] || "").toLowerCase();
  const payloadOnlyCreateTask =
    createTaskParamNames.length === 1 &&
    /(task|payload|spec|data)/i.test(firstParamName) &&
    !/project/i.test(firstParamName);

  if (payloadOnlyCreateTask) {
    return kanban.createTask(payload);
  }

  const taskPayload = { ...payload };
  delete taskPayload.projectId;
  return kanban.createTask(resolvedProjectId, taskPayload);
}

function summarizeAssistantMessageData(data = {}) {
  const messageText = normalizeNarrativeText(
    extractStreamText(data?.content) ||
      extractStreamText(data?.text) ||
      extractStreamText(data?.deltaContent),
    { maxParagraphs: 1, maxChars: 260 },
  );
  if (messageText) return `Agent: ${trimLogText(messageText, 220)}`;

  const detailText = normalizeNarrativeText(data?.detailedContent, {
    maxParagraphs: 1,
    maxChars: 260,
  });
  if (detailText) return `Agent detail: ${trimLogText(detailText, 220)}`;

  const toolRequests = Array.isArray(data?.toolRequests)
    ? data.toolRequests
        .map((req) => String(req?.name || "").trim())
        .filter(Boolean)
    : [];
  if (toolRequests.length) {
    const unique = Array.from(new Set(toolRequests)).slice(0, 4).join(", ");
    return `Agent requested tools: ${unique}`;
  }

  const reasoningText = normalizeNarrativeText(data?.reasoningOpaque, {
    maxParagraphs: 1,
    maxChars: 220,
  });
  if (reasoningText) return `Thinking: ${trimLogText(reasoningText, 220)}`;

  return "";
}

function summarizeSessionStepToolNames(event = {}, prefix = "Tool call:") {
  const toolCalls = Array.isArray(event?.toolCalls) ? event.toolCalls : [];
  const toolResults = Array.isArray(event?.toolResults) ? event.toolResults : [];
  const callNameById = new Map();
  for (const toolCall of toolCalls) {
    const callId = String(toolCall?.callId || toolCall?.id || "").trim();
    const name = String(toolCall?.name || toolCall?.toolName || "").trim();
    if (callId && name) callNameById.set(callId, name);
  }
  const names = prefix === "Tool result:"
    ? toolResults
        .map((toolResult) =>
          String(
            callNameById.get(String(toolResult?.callId || toolResult?.id || "").trim()) ||
              toolResult?.name ||
              toolResult?.toolName ||
              "",
          ).trim()
        )
        .filter(Boolean)
    : toolCalls
        .map((toolCall) => String(toolCall?.name || toolCall?.toolName || "").trim())
        .filter(Boolean);
  if (!names.length) return "";
  const unique = Array.from(new Set(names)).slice(0, 4).join(", ");
  return `${prefix} ${unique}`;
}

function extractStreamText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => {
        if (entry == null) return "";
        if (typeof entry === "string") return entry;
        if (typeof entry?.text === "string") return entry.text;
        if (typeof entry?.content === "string") return entry.content;
        if (typeof entry?.deltaContent === "string") return entry.deltaContent;
        return "";
      })
      .filter(Boolean);
    return parts.join(" ");
  }
  if (typeof value === "object") {
    if (typeof value?.text === "string") return value.text;
    if (typeof value?.content === "string") return value.content;
    if (typeof value?.deltaContent === "string") return value.deltaContent;
    if (typeof value?.detailedContent === "string") return value.detailedContent;
    if (typeof value?.summary === "string") return value.summary;
    if (typeof value?.reasoning === "string") return value.reasoning;
    if (typeof value?.reasoningOpaque === "string") return value.reasoningOpaque;
  }
  return "";
}

function summarizeAgentStreamEvent(event) {
  const type = String(event?.type || "").trim();
  if (!type) return "";

  // Ignore token-level deltas that create noisy duplicate run logs.
  if (
    /reasoning(?:_|[.])delta/i.test(type) ||
    /(?:^|[.])delta$/i.test(type) ||
    /(?:_|[.])delta(?:_|[.])/i.test(type)
  ) {
    return "";
  }

  if (type === "item.updated") {
    return "";
  }

  if (type === "tool_call") {
    return `Tool call: ${event?.tool_name || event?.data?.tool_name || "unknown"}`;
  }

  if (type === "function_call") {
    return `Tool call: ${event?.name || event?.tool_name || "unknown"}`;
  }

  if (type === "tool_result") {
    const name = event?.tool_name || event?.data?.tool_name || "unknown";
    return `Tool result: ${name}`;
  }

  if (type === "function_call_output" || type === "tool_output") {
    const name = event?.name || event?.tool_name || event?.data?.tool_name || "unknown";
    return `Tool result: ${name}`;
  }

  if (type === "session.tool.start" || type === "session.tool.call") {
    const name = event?.toolName || event?.tool_name || event?.name || event?.data?.toolName || event?.data?.tool_name || "unknown";
    return `Tool call: ${name}`;
  }

  if (type === "session.tool.complete" || type === "session.tool.result") {
    const name = event?.toolName || event?.tool_name || event?.name || event?.data?.toolName || event?.data?.tool_name || "unknown";
    if (event?.timedOut === true) return `Tool result: ${name} (timed out)`;
    if (event?.denied === true) return `Tool result: ${name} (denied)`;
    return `Tool result: ${name}`;
  }

  if (type === "session.step.finish") {
    return (
      summarizeSessionStepToolNames(event, "Tool result:")
      || summarizeSessionStepToolNames(event, "Agent requested tools:")
    );
  }

  if (type === "error") {
    return `Agent error: ${trimLogText(event?.error || event?.message || "unknown error", 220)}`;
  }

  if (type === "assistant.usage") {
    const usageLine = summarizeAssistantUsage(event?.data || {});
    return usageLine || "Usage update";
  }

  if (type === "assistant.message") {
    return summarizeAssistantMessageData(event?.data || {});
  }

  const item = event?.item;
  if (item && (type === "item.completed" || type === "item.started")) {
    const itemType = String(item?.type || "").trim().toLowerCase();
    const toolName =
      item?.tool_name ||
      item?.toolName ||
      item?.name ||
      item?.call?.tool_name ||
      item?.call?.name ||
      item?.function?.name ||
      null;

    if (
      itemType === "tool_call" ||
      itemType === "mcp_tool_call" ||
      itemType === "function_call" ||
      itemType === "tool_use"
    ) {
      return `Tool call: ${toolName || "unknown"}`;
    }
    if (
      itemType === "tool_result" ||
      itemType === "mcp_tool_result" ||
      itemType === "tool_output"
    ) {
      return `Tool result: ${toolName || "unknown"}`;
    }

    const itemText = trimLogText(
      extractStreamText(item?.text) ||
        extractStreamText(item?.summary) ||
        extractStreamText(item?.content) ||
        extractStreamText(item?.message?.content) ||
        extractStreamText(item?.message?.text),
      220,
    );

    if (itemType.includes("reason") || itemType.includes("thinking")) {
      return itemText ? `Thinking: ${itemText}` : "Thinking...";
    }

    if (
      itemType === "agent_message" ||
      itemType === "assistant_message" ||
      itemType === "message"
    ) {
      return itemText ? `Agent: ${itemText}` : "";
    }

    if (itemText) {
      return `${itemType || "item"}: ${itemText}`;
    }
  }

  const messageText = trimLogText(
    extractStreamText(event?.message?.content) ||
      extractStreamText(event?.message?.text) ||
      extractStreamText(event?.content) ||
      extractStreamText(event?.text) ||
      extractStreamText(event?.data?.content) ||
      extractStreamText(event?.data?.text) ||
      extractStreamText(event?.data?.deltaContent) ||
      normalizeNarrativeText(event?.data?.detailedContent, {
        maxParagraphs: 1,
        maxChars: 220,
      }) ||
      "",
    220,
  );

  if (messageText) {
    if (
      type === "agent_message" ||
      type === "assistant_message" ||
      type === "message" ||
      type === "item.completed"
    ) {
      return `Agent: ${messageText}`;
    }
    return `${type}: ${messageText}`;
  }

  if (
    type === "turn.complete" ||
    type === "session.completed" ||
    type === "response.completed"
  ) {
    return `Agent event: ${type}`;
  }

  return "";
}

function buildAgentEventPreview(items = [], streamLines = [], maxEvents = WORKFLOW_AGENT_EVENT_PREVIEW_LIMIT) {
  const lines = [];
  if (Array.isArray(streamLines) && streamLines.length) {
    lines.push(...streamLines);
  }

  if (Array.isArray(items) && items.length) {
    for (const entry of items) {
      const line = summarizeAgentStreamEvent(entry);
      if (line) lines.push(line);
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const line of lines) {
    const normalized = trimLogText(line, 260);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(normalized);
  }

  const limit = Number.isFinite(maxEvents)
    ? Math.max(10, Math.min(500, Math.trunc(maxEvents)))
    : WORKFLOW_AGENT_EVENT_PREVIEW_LIMIT;
  return deduped.slice(-limit);
}

function condenseAgentItems(items = [], maxEvents = WORKFLOW_AGENT_EVENT_PREVIEW_LIMIT) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const limit = Number.isFinite(maxEvents)
    ? Math.max(10, Math.min(500, Math.trunc(maxEvents)))
    : WORKFLOW_AGENT_EVENT_PREVIEW_LIMIT;
  const slice = items.slice(-limit);
  return slice.map((entry) => ({
    type: String(entry?.type || entry?.item?.type || "event"),
    summary:
      summarizeAgentStreamEvent(entry) ||
      trimLogText(
        normalizeNarrativeText(
          extractStreamText(entry?.message?.content) ||
            extractStreamText(entry?.content) ||
            extractStreamText(entry?.text) ||
            extractStreamText(entry?.data?.content) ||
            extractStreamText(entry?.item?.text) ||
            extractStreamText(entry?.item?.content),
          { maxParagraphs: 1, maxChars: 220 },
        ),
        220,
      ) ||
      "event",
    timestamp: entry?.timestamp || entry?.data?.timestamp || null,
  }));
}

function buildAgentExecutionDigest(result = {}, streamLines = [], maxEvents = WORKFLOW_AGENT_EVENT_PREVIEW_LIMIT) {
  const eventPreview = buildAgentEventPreview(result?.items || [], streamLines, maxEvents);
  const thoughts = eventPreview
    .filter((line) => line.startsWith("Thinking:"))
    .map((line) => line.replace(/^Thinking:\s*/i, "").trim())
    .filter(Boolean);
  const actionLines = eventPreview
    .filter(
      (line) =>
        line.startsWith("Tool call:") ||
        line.startsWith("Tool result:") ||
        line.startsWith("Agent requested tools:"),
    )
    .map((line) =>
      line
        .replace(/^Tool call:\s*/i, "called ")
        .replace(/^Tool result:\s*/i, "received result from ")
        .replace(/^Agent requested tools:\s*/i, "requested tools ")
        .trim(),
    )
    .filter(Boolean);
  const agentMessages = eventPreview
    .filter((line) => line.startsWith("Agent:"))
    .map((line) => line.replace(/^Agent:\s*/i, "").trim())
    .filter(Boolean);

  let summary = normalizeNarrativeText(result?.output || "", { maxParagraphs: 2, maxChars: 900 });
  if (!summary || summary === "(Agent completed with no text output)") {
    summary = agentMessages[agentMessages.length - 1] || "";
  }
  if (!summary && eventPreview.length > 0) {
    summary = eventPreview[eventPreview.length - 1];
  }
  summary = trimLogText(summary, 900);

  const narrativeParts = [];
  if (summary && summary !== "(Agent completed with no text output)") {
    narrativeParts.push(summary);
  }
  if (thoughts.length) {
    narrativeParts.push(`Thought process: ${thoughts.slice(0, 4).join(" ")}`);
  }
  if (actionLines.length) {
    narrativeParts.push(`Actions: ${actionLines.slice(0, 8).join("; ")}`);
  }
  if (!narrativeParts.length && eventPreview.length) {
    narrativeParts.push(eventPreview.slice(-3).join(" "));
  }

  const itemCount = Array.isArray(result?.items) ? result.items.length : 0;
  const retainedItems = condenseAgentItems(result?.items || [], maxEvents);
  const omittedItemCount = Math.max(0, itemCount - retainedItems.length);

  return {
    summary,
    narrative: narrativeParts.join("\n\n").trim(),
    thoughts: thoughts.slice(0, 8),
    stream: eventPreview,
    items: retainedItems,
    itemCount,
    omittedItemCount,
  };
}

function normalizeLegacyWorkflowCommand(command) {
  let normalized = String(command || "");
  if (!normalized) return normalized;
  if (/--json\s+name,state,conclusion\b/i.test(normalized)) {
    normalized = normalized.replace(/--json\s+name,state,conclusion\b/gi, "--json name,state");
  }
  if (/grep\s+-c\s+worktree/i.test(normalized)) {
    normalized = /git\s+worktree\s+prune/i.test(normalized)
      ? PORTABLE_PRUNE_AND_COUNT_WORKTREES_COMMAND
      : PORTABLE_WORKTREE_COUNT_COMMAND;
  }
  return normalized;
}

function resolveWorkflowNodeValue(value, ctx) {
  if (typeof value === "string") return ctx.resolve(value);
  if (Array.isArray(value)) {
    return value.map((item) => resolveWorkflowNodeValue(item, ctx));
  }
  if (value && typeof value === "object") {
    const resolved = {};
    for (const [key, entry] of Object.entries(value)) {
      resolved[key] = resolveWorkflowNodeValue(entry, ctx);
    }
    return resolved;
  }
  return value;
}

function parseBooleanSetting(value, defaultValue = false) {
  if (value == null || value === "") return defaultValue;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return defaultValue;
    if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  }
  return defaultValue;
}

function getPathValue(value, pathExpression) {
  const path = String(pathExpression || "").trim();
  if (!path) return undefined;
  const parts = path
    .split(".")
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;

  let cursor = value;
  for (const part of parts) {
    if (cursor == null) return undefined;
    if (Array.isArray(cursor)) {
      const idx = Number.parseInt(part, 10);
      if (!Number.isFinite(idx)) return undefined;
      cursor = cursor[idx];
      continue;
    }
    if (typeof cursor !== "object") return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function collectWakePhraseCandidates(payload, payloadField = "") {
  const candidates = [];
  const seen = new Set();

  const appendCandidate = (field, rawValue) => {
    if (rawValue == null) return;
    if (Array.isArray(rawValue)) {
      rawValue.forEach((entry, idx) => appendCandidate(`${field}[${idx}]`, entry));
      return;
    }
    if (typeof rawValue === "object") {
      if (typeof rawValue.content === "string") {
        appendCandidate(`${field}.content`, rawValue.content);
      }
      if (typeof rawValue.text === "string") {
        appendCandidate(`${field}.text`, rawValue.text);
      }
      if (typeof rawValue.transcript === "string") {
        appendCandidate(`${field}.transcript`, rawValue.transcript);
      }
      return;
    }

    const text = String(rawValue).trim();
    if (!text) return;
    const key = `${field}::${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ field, text });
  };

  if (payloadField) {
    appendCandidate(payloadField, getPathValue(payload, payloadField));
    return candidates;
  }

  const commonFields = [
    "content",
    "text",
    "transcript",
    "message",
    "utterance",
    "payload.content",
    "payload.text",
    "payload.transcript",
    "event.content",
    "event.text",
    "event.transcript",
    "voice.content",
    "voice.transcript",
    "meta.transcript",
  ];
  for (const field of commonFields) {
    appendCandidate(field, getPathValue(payload, field));
  }

  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  messages.forEach((entry, idx) => appendCandidate(`messages[${idx}]`, entry));

  const transcriptEvents = Array.isArray(payload?.transcriptEvents) ? payload.transcriptEvents : [];
  transcriptEvents.forEach((entry, idx) => appendCandidate(`transcriptEvents[${idx}]`, entry));

  return candidates;
}

function detectWakePhraseMatch(text, phrase, options = {}) {
  const mode = String(options.mode || "contains").trim().toLowerCase() || "contains";
  const caseSensitive = options.caseSensitive === true;
  const source = String(text || "");
  const target = String(phrase || "");

  if (!source || !target) return { matched: false, mode };

  const sourceNormalized = caseSensitive ? source : source.toLowerCase();
  const targetNormalized = caseSensitive ? target : target.toLowerCase();

  if (mode === "exact") {
    return { matched: sourceNormalized.trim() === targetNormalized.trim(), mode };
  }
  if (mode === "starts_with") {
    return { matched: sourceNormalized.trimStart().startsWith(targetNormalized), mode };
  }
  if (mode === "regex") {
    try {
      const regex = new RegExp(target, caseSensitive ? "" : "i");
      return { matched: regex.test(source), mode };
    } catch (err) {
      return {
        matched: false,
        mode,
        error: `invalid regex: ${err?.message || err}`,
      };
    }
  }
  return { matched: sourceNormalized.includes(targetNormalized), mode: "contains" };
}

function normalizeWorkflowStack(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
}

function isBosunStateComment(text) {
  const raw = String(text || "").toLowerCase();
  return raw.includes("bosun-state") || raw.includes("codex:ignore");
}

function normalizeTaskComments(task, maxComments = 6) {
  if (!task) return [];
  const raw = Array.isArray(task.comments)
    ? task.comments
    : Array.isArray(task.meta?.comments)
      ? task.meta.comments
      : [];
  const normalized = raw
    .map((comment) => {
      const body = typeof comment === "string"
        ? comment
        : comment.body || comment.text || comment.content || "";
      const trimmed = String(body || "").trim();
      if (!trimmed || isBosunStateComment(trimmed)) return null;
      return {
        author: comment?.author || comment?.user || null,
        createdAt: comment?.createdAt || comment?.created_at || null,
        body: trimmed.replace(/\s+/g, " ").slice(0, 600),
      };
    })
    .filter(Boolean);
  if (normalized.length <= maxComments) return normalized;
  return normalized.slice(-maxComments);
}

function normalizeTaskAttachments(task, maxAttachments = 10) {
  if (!task) return [];
  const combined = []
    .concat(Array.isArray(task.attachments) ? task.attachments : [])
    .concat(Array.isArray(task.meta?.attachments) ? task.meta.attachments : []);
  if (combined.length <= maxAttachments) return combined;
  return combined.slice(0, maxAttachments);
}

function formatAttachmentLine(att) {
  const name = att.name || att.filename || att.title || "attachment";
  const kind = att.kind ? ` (${att.kind})` : "";
  const location = att.url || att.filePath || att.path || "";
  const suffix = location ? ` — ${location}` : "";
  return `- ${name}${kind}${suffix}`;
}

function formatCommentLine(comment) {
  const author = comment.author ? `@${comment.author}` : "comment";
  const when = comment.createdAt ? ` (${comment.createdAt})` : "";
  return `- ${author}${when}: ${comment.body}`;
}

function buildTaskContextBlock(task) {
  if (!task) return "";
  const comments = normalizeTaskComments(task);
  const attachments = normalizeTaskAttachments(task);
  if (!comments.length && !attachments.length) return "";
  const lines = ["## Task Context"];
  if (comments.length) {
    lines.push("### Comments");
    for (const comment of comments) lines.push(formatCommentLine(comment));
  }
  if (attachments.length) {
    lines.push("### Attachments");
    for (const attachment of attachments) lines.push(formatAttachmentLine(attachment));
  }
  return lines.join("\n");
}

function buildWorkflowAgentToolContract(rootDir, agentProfileId = "", options = {}) {
  const profileId = String(agentProfileId || "").trim();
  const effectiveMode = String(options.effectiveMode || "agent").trim().toLowerCase() || "agent";
  const effective = profileId
    ? getEffectiveTools(rootDir, profileId)
    : getEffectiveTools(rootDir, "__default__");
  const rawCfg = profileId ? getAgentToolConfig(rootDir, profileId) : null;
  const enabledBuiltinTools = (Array.isArray(effective?.builtinTools) ? effective.builtinTools : [])
    .filter((tool) => tool?.enabled)
    .map((tool) => ({
      id: String(tool?.id || "").trim(),
      name: String(tool?.name || "").trim(),
      description: String(tool?.description || "").trim(),
    }))
    .filter((tool) => tool.id);
  const enabledMcpServers = Array.isArray(rawCfg?.enabledMcpServers)
    ? rawCfg.enabledMcpServers.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  const manifest = {
    agentProfileId: profileId || null,
    enabledBuiltinTools,
    enabledMcpServers,
    toolBridge: {
      module: "./voice-tools.mjs",
      function: "executeToolCall(toolName, args, context)",
      quickUse: "node -e \"import('../voice/voice-tools.mjs').then(async m=>{const r=await m.executeToolCall('get_workspace_context', {}, {});console.log(r?.result||r);})\"",
    },
  };
  return [
    "## Tool Capability Contract",
    "Use enabled tools by default before claiming work is blocked.",
    effectiveMode === "plan"
      ? "Planning mode is read-only. Do not call edit/write tools, do not run git-mutating commands, and do not leave uncommitted changes behind in this phase."
      : null,
    "For large files, prefer targeted read/view calls with explicit line ranges and batch multiple focused reads instead of whole-file reads.",
    "If shell filtering blocks a compound command, retry as separate single-purpose commands rather than treating the session as blocked.",
    "Before declaring verification blocked, inspect focused git status/diff output for the target paths and run the narrowest relevant test command you can prove.",
    "For Node/Vitest repos that include tools/vitest-runner.mjs, prefer `node tools/vitest-runner.mjs run <target-paths>` over `npm test -- <target-paths>` for focused worktree verification.",
    "Enabled tools JSON:",
    "```json",
    JSON.stringify(manifest, null, 2),
    "```",
    "When uncertain about arguments, call get_admin_help via executeToolCall.",
  ].filter(Boolean).join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
//  TRIGGERS — Events that initiate a workflow
// ═══════════════════════════════════════════════════════════════════════════

export { registerNodeType };
export {
  BOSUN_ATTACHED_PR_LABEL,
  BOSUN_CREATED_PR_LABEL,
  PORTABLE_PRUNE_AND_COUNT_WORKTREES_COMMAND,
  PORTABLE_WORKTREE_COUNT_COMMAND,
  TAG,
  WORKFLOW_AGENT_EVENT_PREVIEW_LIMIT,
  WORKFLOW_AGENT_HEARTBEAT_MS,
  WORKFLOW_TELEGRAM_ICON_MAP,
  bindTaskContext,
  buildAgentEventPreview,
  buildAgentExecutionDigest,
  buildGitExecutionEnv,
  buildTaskContextBlock,
  buildWorkflowAgentToolContract,
  appendSafeDirectoryGitConfig,
  collectWakePhraseCandidates,
  condenseAgentItems,
  createKanbanTaskWithProject,
  decodeWorkflowUnicodeIconToken,
  deriveManagedWorktreeDirName,
  detectWakePhraseMatch,
  execGitArgsSync,
  extractStreamText,
  extractSymbolHint,
  formatAttachmentLine,
  formatCommentLine,
  getPathValue,
  isBosunStateComment,
  isManagedBosunWorktree,
  makeIsolatedGitEnv,
  normalizeLegacyWorkflowCommand,
  normalizeLineEndings,
  normalizeNarrativeText,
  normalizePrEventName,
  normalizeTaskAttachments,
  normalizeTaskComments,
  normalizeWorkflowStack,
  normalizeWorkflowTelegramText,
  evaluateTaskAssignedTriggerConfig,
  parseBooleanSetting,
  parsePathListingLine,
  resolveGitCandidates,
  resolveWorkflowNodeValue,
  simplifyPathLabel,
  summarizeAgentStreamEvent,
  summarizeAssistantMessageData,
  summarizeAssistantUsage,
  summarizePathListingBlock,
  trimLogText,
  trimLogTextPreservingTail,
};
