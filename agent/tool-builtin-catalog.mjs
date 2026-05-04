import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { TOOL_DEFS } from "../voice/voice-tool-definitions.mjs";
import { resolveRepoRoot } from "../config/repo-root.mjs";
import { getBosunSessionManager } from "./session-manager.mjs";
import {
  listAllSessions as listTrackedSessions,
  recordEvent as recordTrackedSessionEvent,
  updateSessionStatus as updateTrackedSessionStatus,
} from "../infra/session-tracker.mjs";

export const BUILTIN_TOOL_SOURCE = "bosun-builtin";

const VOICE_TOOL_ALIASES = Object.freeze({
  search_code: ["search_files", "find_in_files", "grep_search"],
  read_file_content: ["read_file"],
  list_directory: ["list_files", "ls_directory"],
  get_workspace_context: ["workspace_context"],
  ask_agent_context: ["ask_workspace_agent"],
  delegate_to_agent: ["delegate_agent"],
});

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function toPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value }
    : {};
}

function cloneValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

const TRACKER_TERMINAL_STATUSES = new Set([
  "aborted",
  "blocked",
  "blocked_by_env",
  "completed",
  "error",
  "failed",
  "idle",
  "no_output",
  "stalled",
  "timed_out",
]);

function isTerminalTrackedSessionStatus(status) {
  return TRACKER_TERMINAL_STATUSES.has(toTrimmedString(status).toLowerCase());
}

function collectTrackedSessionLineage(rootSessionId, sessionSummaries = []) {
  const normalizedRoot = toTrimmedString(rootSessionId);
  if (!normalizedRoot) return [];
  const byParentSessionId = new Map();
  for (const session of Array.isArray(sessionSummaries) ? sessionSummaries : []) {
    const sessionId = toTrimmedString(session?.id || session?.taskId || "");
    const parentSessionId = toTrimmedString(session?.parentSessionId || "");
    if (!sessionId || !parentSessionId) continue;
    if (!byParentSessionId.has(parentSessionId)) {
      byParentSessionId.set(parentSessionId, []);
    }
    byParentSessionId.get(parentSessionId).push(sessionId);
  }
  const lineage = [normalizedRoot];
  const queue = [normalizedRoot];
  const seen = new Set(lineage);
  while (queue.length > 0) {
    const currentSessionId = queue.shift();
    const children = byParentSessionId.get(currentSessionId) || [];
    for (const childSessionId of children) {
      if (seen.has(childSessionId)) continue;
      seen.add(childSessionId);
      lineage.push(childSessionId);
      queue.push(childSessionId);
    }
  }
  return lineage;
}

function cancelTrackedSessionLineage(rootSessionId, reason, sessionManager) {
  const normalizedRoot = toTrimmedString(rootSessionId);
  if (!normalizedRoot) {
    return {
      lineageSessionIds: [],
      cancelledSessionIds: [],
      terminalizedSessionIds: [],
    };
  }
  const sessionSummaries = listTrackedSessions({
    includePersisted: true,
    includeRuntimeProgress: false,
    lightweight: true,
  });
  const lineageSessionIds = collectTrackedSessionLineage(normalizedRoot, sessionSummaries);
  const sessionSummaryById = new Map(
    (Array.isArray(sessionSummaries) ? sessionSummaries : [])
      .map((session) => [toTrimmedString(session?.id || session?.taskId || ""), session])
      .filter(([sessionId]) => Boolean(sessionId)),
  );
  const cancellationOrder = [...lineageSessionIds].reverse();
  const cancelledSessionIds = [];
  const terminalizedSessionIds = [];
  for (const sessionId of cancellationOrder) {
    if (sessionManager?.cancelSession?.(sessionId, reason)) {
      cancelledSessionIds.push(sessionId);
    }
    const sessionSummary = sessionSummaryById.get(sessionId);
    if (isTerminalTrackedSessionStatus(sessionSummary?.status)) {
      continue;
    }
    recordTrackedSessionEvent(sessionId, {
      role: "system",
      content: `[Delegation Cancelled] Session aborted because parent requested cancellation: ${reason}`,
      timestamp: new Date().toISOString(),
      meta: {
        source: BUILTIN_TOOL_SOURCE,
        eventType: "delegation_cancelled",
        reason,
        rootSessionId: normalizedRoot,
      },
    });
    updateTrackedSessionStatus(sessionId, "aborted");
    terminalizedSessionIds.push(sessionId);
  }
  return {
    lineageSessionIds,
    cancelledSessionIds,
    terminalizedSessionIds,
  };
}

function toStringArray(value) {
  return Array.isArray(value)
    ? value.map((entry) => toTrimmedString(entry)).filter(Boolean)
    : [];
}

function toPositiveInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : fallback;
}

function resolveWorkspaceRoot(context = {}, options = {}) {
  const preferred = toTrimmedString(context.repoRoot || context.cwd || options.repoRoot || options.cwd);
  if (preferred) {
    return resolve(preferred);
  }
  try {
    return resolve(resolveRepoRoot());
  } catch {
    return resolve(process.cwd());
  }
}

function resolveWorkspacePath(inputPath, context = {}, options = {}) {
  const rootDir = resolveWorkspaceRoot(context, options);
  const candidate = toTrimmedString(inputPath);
  const absolute = candidate
    ? (isAbsolute(candidate) ? resolve(candidate) : resolve(rootDir, candidate))
    : rootDir;
  const rel = relative(rootDir, absolute);
  const outside = rel.startsWith(`..${sep}`) || rel === ".." || (rel && isAbsolute(rel));
  if (outside) {
    throw new Error(`Path is outside the workspace root: ${candidate || absolute}`);
  }
  return {
    rootDir,
    absolute,
    relativePath: rel || ".",
  };
}

async function callVoiceTool(toolName, args = {}, context = {}) {
  const mod = await import("../voice/voice-tools.mjs");
  const response = await mod.executeToolCall(toolName, args, {
    ...context,
    surface: toTrimmedString(context.surface || "") || "bosun-builtin",
    sessionType: toTrimmedString(context.sessionType || "") || "tool-bridge",
    requestedBy: toTrimmedString(context.requestedBy || context.source || "") || "bosun-builtin",
  });
  if (response?.error) {
    const error = new Error(response.error);
    error.approval = response.approval || null;
    error.approvalRequestId = response.approvalRequestId || null;
    throw error;
  }
  return response?.result ?? null;
}

// Hard caps to prevent unbounded memory growth from chatty patterns or large repos.
const RIPGREP_MAX_LINE_LENGTH = 4096;
const RIPGREP_MAX_STDERR_BYTES = 64 * 1024;

function parseRipgrepLine(line) {
  if (!line) return null;
  const trimmed = line.length > RIPGREP_MAX_LINE_LENGTH ? line.slice(0, RIPGREP_MAX_LINE_LENGTH) : line;
  const firstColon = trimmed.indexOf(":");
  const secondColon = firstColon >= 0 ? trimmed.indexOf(":", firstColon + 1) : -1;
  if (firstColon < 0 || secondColon < 0) return null;
  return {
    filePath: trimmed.slice(0, firstColon).replace(/\\/g, "/"),
    lineNumber: Number(trimmed.slice(firstColon + 1, secondColon)) || null,
    preview: trimmed.slice(secondColon + 1),
  };
}

async function runRipgrep(pattern, input = {}, rootDir) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const args = ["-n", "--no-heading", "--color", "never"];
    const maxResults = toPositiveInteger(input.maxResults, 20) || 20;
    if (input.filePattern) {
      args.push("--glob", String(input.filePattern));
    }
    args.push("-m", String(maxResults));
    args.push(String(pattern));
    args.push(rootDir);

    let child;
    try {
      child = spawn("rg", args, {
        cwd: rootDir,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      rejectPromise(err);
      return;
    }

    const results = [];
    let pendingLine = "";
    let stderrBuf = "";
    let settled = false;
    let killed = false;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      try { child.stdout?.removeAllListeners(); } catch {}
      try { child.stderr?.removeAllListeners(); } catch {}
      fn(value);
    };

    const stopChild = () => {
      if (killed) return;
      killed = true;
      try { child.kill("SIGTERM"); } catch {}
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      try {
        const text = pendingLine + chunk;
        const lines = text.split(/\r?\n/);
        pendingLine = lines.pop() ?? "";
        if (pendingLine.length > RIPGREP_MAX_LINE_LENGTH) {
          pendingLine = pendingLine.slice(0, RIPGREP_MAX_LINE_LENGTH);
        }
        for (const line of lines) {
          if (results.length >= maxResults) break;
          const parsed = parseRipgrepLine(line.trim());
          if (parsed) results.push(parsed);
        }
        if (results.length >= maxResults) {
          stopChild();
          settle(resolvePromise, results);
        }
      } catch (err) {
        stopChild();
        settle(rejectPromise, err);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (settled || stderrBuf.length >= RIPGREP_MAX_STDERR_BYTES) return;
      const remaining = RIPGREP_MAX_STDERR_BYTES - stderrBuf.length;
      stderrBuf += chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
    });
    child.once("error", (err) => settle(rejectPromise, err));
    child.once("close", (code) => {
      if (settled) return;
      if (pendingLine && results.length < maxResults) {
        const parsed = parseRipgrepLine(pendingLine.trim());
        if (parsed) results.push(parsed);
      }
      pendingLine = "";
      if (code !== 0 && code !== 1 && !killed) {
        settle(rejectPromise, new Error(stderrBuf.trim() || `rg exited with code ${code}`));
        return;
      }
      settle(resolvePromise, results);
    });
  });
}

const FALLBACK_SEARCH_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".bosun",
  "output",
  "logs",
  "tmp",
  "test-results",
  "coverage",
  "native",
  "node-compile-cache",
  "execution-ledger",
  "dist",
  "build",
  ".next",
  ".cache",
]);
const FALLBACK_SEARCH_MAX_FILE_BYTES = 1 * 1024 * 1024; // 1 MiB
const FALLBACK_SEARCH_MAX_FILES = 5000;

async function fallbackSearchFiles(pattern, input = {}, rootDir) {
  const maxResults = toPositiveInteger(input.maxResults, 20) || 20;
  const results = [];
  const stack = [rootDir];
  let filesScanned = 0;
  while (stack.length > 0 && results.length < maxResults && filesScanned < FALLBACK_SEARCH_MAX_FILES) {
    const currentDir = stack.pop();
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (results.length >= maxResults || filesScanned >= FALLBACK_SEARCH_MAX_FILES) break;
      if (entry.name.startsWith(".") && entry.name !== "." && entry.name !== "..") {
        // skip dotfiles/dotdirs by default
        if (entry.isDirectory()) continue;
      }
      if (entry.isDirectory()) {
        if (FALLBACK_SEARCH_SKIP_DIRS.has(entry.name)) continue;
        stack.push(resolve(currentDir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const fullPath = resolve(currentDir, entry.name);
      const relPath = relative(rootDir, fullPath).replace(/\\/g, "/");
      filesScanned += 1;
      let content = null;
      try {
        const buf = await readFile(fullPath);
        if (buf.length > FALLBACK_SEARCH_MAX_FILE_BYTES) continue;
        content = buf.toString("utf8");
      } catch {
        continue;
      }
      if (!content || !content.includes(pattern)) continue;
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length && results.length < maxResults; index += 1) {
        if (!lines[index].includes(pattern)) continue;
        const preview = lines[index];
        results.push({
          filePath: relPath,
          lineNumber: index + 1,
          preview: preview.length > RIPGREP_MAX_LINE_LENGTH ? preview.slice(0, RIPGREP_MAX_LINE_LENGTH) : preview,
        });
      }
    }
  }
  return results;
}

function buildSubagentProfile(prompt, args = {}, context = {}) {
  const role = toTrimmedString(args.role || args.profileName || "subagent") || "subagent";
  const taskKey = toTrimmedString(args.taskKey || `${toTrimmedString(context.taskKey || context.sessionId || "harness")}:subagent`) || "harness:subagent";
  const allowNestedDelegation = args.allowNestedDelegation === true;
  const deniedTools = [
    ...toStringArray(args.deniedTools),
    ...(allowNestedDelegation ? [] : [
      "spawn_subagent",
      "spawn_agent",
      "wait_subagent",
      "wait_for_subagent",
      "cancel_subagent",
      "abort_subagent",
      "close_agent",
      "list_subagents",
    ]),
  ];
  const subagentContract = {
    freshConversation: args.freshConversation !== false,
    toolPolicy: {
      allowedTools: toStringArray(args.allowedTools),
      deniedTools,
      allowNestedDelegation,
    },
    memoryPolicy: {
      mode: toTrimmedString(args.inheritedMemoryMode || "read_only") || "read_only",
      inheritedState: toPlainObject(context._executionStateScopes || {}),
    },
    reportingPolicy: {
      mode: toTrimmedString(args.progressReportingMode || "one_way_progress") || "one_way_progress",
      progressOnly: args.progressOnly !== false,
    },
    escalationPolicy: {
      mode: toTrimmedString(args.escalationMode || "wait_for_response") || "wait_for_response",
      waitForResponse: args.waitForResponse !== false,
    },
  };
  return {
    name: role,
    taskKey,
    sessionType: "subagent",
    allowedTools: subagentContract.toolPolicy.allowedTools,
    subagentContract,
    provider: toTrimmedString(args.provider || context.providerId || "") || null,
    model: toTrimmedString(args.model || context.model || "") || null,
    cwd: toTrimmedString(args.cwd || context.cwd || context.repoRoot || "") || null,
    entryStageId: "task",
    stages: [
      {
        id: "task",
        type: "prompt",
        prompt: toTrimmedString(prompt),
        transitions: [{ on: "success", to: "finalize" }],
      },
      {
        id: "finalize",
        type: "finalize",
        prompt: `Finalize subagent "${role}" and return a concise result summary.`,
      },
    ],
  };
}

function buildVoiceBackedDefinitions() {
  return TOOL_DEFS.map((definition) => {
    const name = toTrimmedString(definition?.name || "");
    if (!name) return null;
    return {
      id: name,
      name,
      description: toTrimmedString(definition?.description || "") || null,
      aliases: VOICE_TOOL_ALIASES[name] || [],
      metadata: {
        parameters: cloneValue(definition?.parameters || {}),
      },
      handler: async (args = {}, context = {}) => await callVoiceTool(name, args, context),
    };
  }).filter(Boolean);
}

function buildHarnessNativeDefinitions(options = {}) {
  return [
    {
      id: "write_file",
      name: "write_file",
      description: "Create or overwrite a workspace file within the current Bosun workspace.",
      sandbox: "workspace-write",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative path to create or overwrite.",
          },
          filePath: {
            type: "string",
            description: "Alias for path.",
          },
          content: {
            description: "File contents to write. Strings are written directly; objects are JSON-stringified.",
          },
          mode: {
            type: "string",
            enum: ["overwrite", "append"],
            description: "Write mode. Defaults to overwrite.",
          },
          overwrite_existing: {
            type: "boolean",
            description: "When true, allows replacing an existing file with full new content.",
          },
        },
        required: ["path", "content"],
      },
      handler: async (args = {}, context = {}) => {
        const target = resolveWorkspacePath(args.path || args.filePath, context, options);
        const content = typeof args.content === "string" ? args.content : JSON.stringify(args.content ?? "", null, 2);
        const mode = toTrimmedString(args.mode || "overwrite").toLowerCase() || "overwrite";
        await mkdir(dirname(target.absolute), { recursive: true });
        if (mode === "append") {
          const existing = await readFile(target.absolute, "utf8").catch(() => "");
          await writeFile(target.absolute, `${existing}${content}`, "utf8");
        } else {
          const overwriteExisting = args.overwrite_existing === true;
          const existing = await readFile(target.absolute, "utf8").catch(() => null);
          if (existing !== null && !overwriteExisting) {
            throw new Error(
              `write_file refuses to overwrite existing file: ${target.relativePath}. `
              + "Use edit_file for targeted edits, or pass overwrite_existing=true for an intentional full rewrite.",
            );
          }
          await writeFile(target.absolute, content, "utf8");
        }
        return {
          ok: true,
          path: target.relativePath,
          bytesWritten: Buffer.byteLength(content, "utf8"),
          mode,
        };
      },
    },
    {
      id: "edit_file",
      name: "edit_file",
      description: "Perform a deterministic text replacement inside a workspace file.",
      sandbox: "workspace-write",
      aliases: ["replace_in_file"],
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative path to edit.",
          },
          filePath: {
            type: "string",
            description: "Alias for path.",
          },
          old_string: {
            type: "string",
            description: "Exact text to replace.",
          },
          search: {
            type: "string",
            description: "Alias for old_string.",
          },
          new_string: {
            type: "string",
            description: "Replacement text.",
          },
          replace: {
            type: "string",
            description: "Alias for new_string.",
          },
          replaceAll: {
            type: "boolean",
            description: "Replace all matches instead of only the first occurrence.",
          },
          all: {
            type: "boolean",
            description: "Alias for replaceAll.",
          },
        },
        required: ["path", "old_string", "new_string"],
      },
      handler: async (args = {}, context = {}) => {
        const target = resolveWorkspacePath(args.path || args.filePath, context, options);
        const oldString = String(args.old_string ?? args.search ?? "");
        const newString = String(args.new_string ?? args.replace ?? "");
        if (!oldString) {
          throw new Error("edit_file requires old_string or search");
        }
        const replaceAll = args.replaceAll === true || args.all === true;
        const original = await readFile(target.absolute, "utf8");
        if (!original.includes(oldString)) {
          throw new Error(`edit_file could not find the requested text in ${target.relativePath}`);
        }
        const occurrences = original.split(oldString).length - 1;
        const next = replaceAll
          ? original.split(oldString).join(newString)
          : original.replace(oldString, newString);
        await writeFile(target.absolute, next, "utf8");
        return {
          ok: true,
          path: target.relativePath,
          occurrences,
          replaced: replaceAll ? occurrences : 1,
        };
      },
    },
    {
      id: "spawn_subagent",
      name: "spawn_subagent",
      description: "Spawn a Bosun internal subagent session under the canonical session manager.",
      aliases: ["spawn_agent"],
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "Instruction to send to the spawned subagent.",
          },
          message: {
            type: "string",
            description: "Alias for prompt.",
          },
          parentSessionId: {
            type: "string",
            description: "Optional parent session id override.",
          },
          parentThreadId: {
            type: "string",
            description: "Optional parent thread id override.",
          },
          taskKey: {
            type: "string",
            description: "Task key to associate with the subagent.",
          },
          cwd: {
            type: "string",
            description: "Working directory for the subagent.",
          },
          maxParallel: {
            type: "number",
            description: "Optional max parallel delegation count.",
          },
          autoRun: {
            type: "boolean",
            description: "Start the subagent immediately. Defaults to true.",
          },
          wait: {
            type: "boolean",
            description: "Wait for the subagent to finish before returning.",
          },
          metadata: {
            type: "object",
            description: "Additional metadata to record on the child session.",
          },
        },
        required: ["prompt"],
      },
      handler: async (args = {}, context = {}) => {
        const prompt = toTrimmedString(args.prompt || args.message || "");
        if (!prompt) {
          throw new Error("spawn_subagent requires a prompt or message");
        }
        const sessionManager = context.sessionManager || options.sessionManager || getBosunSessionManager();
        const compiledProfile = buildSubagentProfile(prompt, args, context);
        const childSession = sessionManager.spawnSubagent(
          compiledProfile,
          {
            parentSessionId: toTrimmedString(args.parentSessionId || context.sessionId || "") || null,
            parentThreadId: toTrimmedString(args.parentThreadId || context.threadId || "") || null,
            requestedBy: toTrimmedString(context.requestedBy || "tool:spawn_subagent") || "tool:spawn_subagent",
            taskKey: toTrimmedString(args.taskKey || context.taskKey || "") || null,
            cwd: toTrimmedString(args.cwd || context.cwd || context.repoRoot || "") || null,
            subagentContract: compiledProfile.subagentContract,
            metadata: {
              ...(toPlainObject(args.metadata)),
              spawnedByTool: "spawn_subagent",
              subagentContract: compiledProfile.subagentContract,
            },
            subagentMaxParallel: toPositiveInteger(args.maxParallel || context.subagentMaxParallel, 0) || undefined,
          },
        );
        const autoRun = args.autoRun !== false;
        const wait = args.wait === true;
        if (autoRun) {
          const running = childSession.run();
          if (!wait) {
            running.catch(() => {});
          } else {
            const result = await running;
            return {
              ok: result?.success !== false,
              sessionId: childSession.sessionId,
              threadId: childSession.threadId,
              status: result?.status || "completed",
              result,
            };
          }
        }
        return {
          ok: true,
          queued: autoRun,
          sessionId: childSession.sessionId,
          threadId: childSession.threadId,
          status: childSession.session?.status || "pending",
        };
      },
    },
    {
      id: "wait_subagent",
      name: "wait_subagent",
      description: "Wait for a spawned Bosun subagent to reach a terminal state.",
      aliases: ["wait_for_subagent"],
      parameters: {
        type: "object",
        properties: {
          childSessionId: {
            type: "string",
            description: "Session id of the child subagent to wait for.",
          },
          sessionId: {
            type: "string",
            description: "Alias for childSessionId.",
          },
          spawnId: {
            type: "string",
            description: "Alias for childSessionId.",
          },
          timeoutMs: {
            type: "number",
            description: "Optional timeout in milliseconds.",
          },
          returnOn: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of intermediate statuses to return on.",
          },
        },
        required: ["childSessionId"],
      },
      handler: async (args = {}, context = {}) => {
        const childSessionId = toTrimmedString(args.childSessionId || args.sessionId || args.spawnId || "");
        if (!childSessionId) {
          throw new Error("wait_subagent requires childSessionId, sessionId, or spawnId");
        }
        const sessionManager = context.sessionManager || options.sessionManager || getBosunSessionManager();
        return await sessionManager.waitForSubagent(childSessionId, {
          timeoutMs: toPositiveInteger(args.timeoutMs, 0) || undefined,
          returnOn: toStringArray(args.returnOn),
        });
      },
    },
    {
      id: "cancel_subagent",
      name: "cancel_subagent",
      description: "Abort a Bosun subagent session through the canonical session manager.",
      aliases: ["abort_subagent", "close_agent"],
      parameters: {
        type: "object",
        properties: {
          childSessionId: {
            type: "string",
            description: "Session id of the child subagent to abort.",
          },
          sessionId: {
            type: "string",
            description: "Alias for childSessionId.",
          },
          reason: {
            type: "string",
            description: "Optional cancellation reason.",
          },
        },
        required: ["childSessionId"],
      },
      handler: async (args = {}, context = {}) => {
        const childSessionId = toTrimmedString(args.childSessionId || args.sessionId || "");
        if (!childSessionId) {
          throw new Error("cancel_subagent requires childSessionId or sessionId");
        }
        const sessionManager = context.sessionManager || options.sessionManager || getBosunSessionManager();
        const reason = args.reason || "aborted_by_parent_tool";
        const {
          lineageSessionIds,
          cancelledSessionIds,
          terminalizedSessionIds,
        } = cancelTrackedSessionLineage(childSessionId, reason, sessionManager);
        return {
          ok: cancelledSessionIds.length > 0 || terminalizedSessionIds.length > 0,
          sessionId: childSessionId,
          cancelled: cancelledSessionIds.length > 0 || terminalizedSessionIds.length > 0,
          lineageSessionIds,
          cancelledSessionIds,
          terminalizedSessionIds,
        };
      },
    },
    {
      id: "list_subagents",
      name: "list_subagents",
      description: "List child subagents for the current parent session.",
      parameters: {
        type: "object",
        properties: {
          parentSessionId: {
            type: "string",
            description: "Optional parent session id override.",
          },
          status: {
            type: "string",
            description: "Optional status filter.",
          },
        },
      },
      handler: async (args = {}, context = {}) => {
        const sessionManager = context.sessionManager || options.sessionManager || getBosunSessionManager();
        return sessionManager.getSubagentControl().listChildren({
          parentSessionId: toTrimmedString(args.parentSessionId || context.sessionId || "") || undefined,
          status: toTrimmedString(args.status || "") || undefined,
        });
      },
    },
    {
      id: "search_files",
      name: "search_files",
      description: "Search workspace files for a text pattern using ripgrep when available.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Text pattern to search for.",
          },
          pattern: {
            type: "string",
            description: "Alias for query.",
          },
          filePattern: {
            type: "string",
            description: "Optional glob filter, for example **/*.mjs.",
          },
          maxResults: {
            type: "number",
            description: "Maximum number of matches to return.",
          },
        },
        required: ["query"],
      },
      handler: async (args = {}, context = {}) => {
        const rootDir = resolveWorkspaceRoot(context, options);
        const query = toTrimmedString(args.query || args.pattern || "");
        if (!query) {
          throw new Error("search_files requires query or pattern");
        }
        const matches = await runRipgrep(query, args, rootDir).catch(async () => {
          return await fallbackSearchFiles(query, args, rootDir);
        });
        return {
          ok: true,
          query,
          count: matches.length,
          matches,
        };
      },
    },
  ];
}

export function createBuiltinToolDefinitions(options = {}) {
  return [
    ...buildVoiceBackedDefinitions(),
    ...buildHarnessNativeDefinitions(options),
  ].map((entry) => ({
    ...entry,
    source: BUILTIN_TOOL_SOURCE,
  }));
}

export default createBuiltinToolDefinitions;
