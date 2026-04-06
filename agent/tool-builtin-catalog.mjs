import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { TOOL_DEFS } from "../voice/voice-tool-definitions.mjs";
import { resolveRepoRoot } from "../config/repo-root.mjs";
import { getBosunSessionManager } from "./session-manager.mjs";

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
  const response = await mod.executeToolCall(toolName, args, context);
  if (response?.error) {
    const error = new Error(response.error);
    error.approval = response.approval || null;
    error.approvalRequestId = response.approvalRequestId || null;
    throw error;
  }
  return response?.result ?? null;
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

    const child = spawn("rg", args, {
      cwd: rootDir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (code !== 0 && code !== 1) {
        rejectPromise(new Error(stderr.trim() || `rg exited with code ${code}`));
        return;
      }
      resolvePromise(
        stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const firstColon = line.indexOf(":");
            const secondColon = firstColon >= 0 ? line.indexOf(":", firstColon + 1) : -1;
            if (firstColon < 0 || secondColon < 0) return null;
            return {
              filePath: line.slice(0, firstColon).replace(/\\/g, "/"),
              lineNumber: Number(line.slice(firstColon + 1, secondColon)) || null,
              preview: line.slice(secondColon + 1),
            };
          })
          .filter(Boolean),
      );
    });
  });
}

async function fallbackSearchFiles(pattern, input = {}, rootDir) {
  const maxResults = toPositiveInteger(input.maxResults, 20) || 20;
  const results = [];
  const stack = [rootDir];
  while (stack.length > 0 && results.length < maxResults) {
    const currentDir = stack.pop();
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = resolve(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      const relPath = relative(rootDir, fullPath).replace(/\\/g, "/");
      const content = await readFile(fullPath, "utf8").catch(() => null);
      if (content == null) continue;
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length && results.length < maxResults; index += 1) {
        if (!lines[index].includes(pattern)) continue;
        results.push({
          filePath: relPath,
          lineNumber: index + 1,
          preview: lines[index],
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
      handler: async (args = {}, context = {}) => {
        const target = resolveWorkspacePath(args.path || args.filePath, context, options);
        const content = typeof args.content === "string" ? args.content : JSON.stringify(args.content ?? "", null, 2);
        const mode = toTrimmedString(args.mode || "overwrite").toLowerCase() || "overwrite";
        await mkdir(dirname(target.absolute), { recursive: true });
        if (mode === "append") {
          const existing = await readFile(target.absolute, "utf8").catch(() => "");
          await writeFile(target.absolute, `${existing}${content}`, "utf8");
        } else {
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
      handler: async (args = {}, context = {}) => {
        const childSessionId = toTrimmedString(args.childSessionId || args.sessionId || "");
        if (!childSessionId) {
          throw new Error("cancel_subagent requires childSessionId or sessionId");
        }
        const sessionManager = context.sessionManager || options.sessionManager || getBosunSessionManager();
        const cancelled = sessionManager.cancelSession(childSessionId, args.reason || "aborted_by_parent_tool");
        return {
          ok: Boolean(cancelled),
          sessionId: childSessionId,
          cancelled: Boolean(cancelled),
        };
      },
    },
    {
      id: "list_subagents",
      name: "list_subagents",
      description: "List child subagents for the current parent session.",
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
