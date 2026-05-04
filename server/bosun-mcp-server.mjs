#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "node:util";
import * as mcpServer from "@modelcontextprotocol/sdk/server/index.js";
import * as mcpStdio from "@modelcontextprotocol/sdk/server/stdio.js";
import * as mcpTypes from "@modelcontextprotocol/sdk/types.js";
import { repairCommonMojibake } from "../lib/mojibake-repair.mjs";

const Server = mcpServer.Server ?? mcpServer.default?.Server;
const StdioServerTransport =
  mcpStdio.StdioServerTransport ??
  mcpStdio.default?.StdioServerTransport;
const CallToolRequestSchema =
  mcpTypes.CallToolRequestSchema ??
  mcpTypes.default?.CallToolRequestSchema;
const ListToolsRequestSchema =
  mcpTypes.ListToolsRequestSchema ??
  mcpTypes.default?.ListToolsRequestSchema;

const TAG = "[bosun-mcp]";
const ResolvedCallToolRequestSchema = CallToolRequestSchema;
const ResolvedListToolsRequestSchema = ListToolsRequestSchema;
const DEFAULT_DISCOVERY_PORTS = [3080, 4400];
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const ENV_KEYS_FOR_EMBEDDED = [
  "TELEGRAM_UI_ALLOW_UNSAFE",
  "TELEGRAM_UI_TUNNEL",
  "TELEGRAM_UI_TLS_DISABLE",
  "TELEGRAM_UI_HOST",
  "TELEGRAM_UI_PORT",
  "BOSUN_UI_ALLOW_EPHEMERAL_PORT",
  "BOSUN_UI_SKIP_INSTANCE_LOCK",
];

function isMainModule() {
  const entry = process.argv[1] ? resolve(process.argv[1]) : "";
  return entry === fileURLToPath(import.meta.url);
}

function redirectConsoleToStderr() {
  const write = (level, args) => {
    const message = format(...args);
    process.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
  };
  console.log = (...args) => write("log", args);
  console.info = (...args) => write("info", args);
  console.warn = (...args) => write("warn", args);
  console.error = (...args) => write("error", args);
}

function normalizePath(pathname) {
  const raw = String(pathname || "").trim();
  if (!raw) return "/";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.replace(/\/+$/, "");
}

function parseDiscoveryPorts() {
  const envPorts = String(process.env.BOSUN_MCP_DISCOVERY_PORTS || "")
    .split(",")
    .map((value) => Number.parseInt(String(value || "").trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0);
  const configured = Number.parseInt(String(process.env.TELEGRAM_UI_PORT || ""), 10);
  const ports = [
    ...envPorts,
    ...(Number.isFinite(configured) && configured > 0 ? [configured] : []),
    ...DEFAULT_DISCOVERY_PORTS,
  ];
  return Array.from(new Set(ports));
}

function encodeQuery(url, query = {}) {
  if (!query || typeof query !== "object") return url;
  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, String(item));
      }
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url;
}

function createToolResult(payload) {
  const text = typeof payload === "string"
    ? payload
    : JSON.stringify(payload, null, 2);
  return {
    content: [{ type: "text", text }],
    structuredContent: payload,
  };
}

function settledValue(result) {
  return result?.status === "fulfilled" ? result.value : null;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = options.headers
    ? {
        Accept: "application/json",
        ...options.headers,
      }
    : { Accept: "application/json" };

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function probeBosunBaseUrl(baseUrl, options = {}) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return null;
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS;

  try {
    const healthResponse = await fetchWithTimeout(
      `${normalized}/api/health`,
      { method: "GET" },
      timeoutMs,
    );
    if (healthResponse?.ok !== true) {
      return null;
    }
    const health = await healthResponse.json().catch(() => null);
    if (health?.ok !== true) return null;
    return {
      type: "daemon",
      baseUrl: normalized,
      health,
    };
  } catch {
    return null;
  }
}

export async function createBosunMcpRuntime(options = {}) {
  let uiServerModule = null;
  let backend = null;
  let savedEnv = null;

  async function detectRunningBackend() {
    if (String(process.env.BOSUN_MCP_DISABLE_DAEMON_DISCOVERY || "") === "1") {
      return null;
    }

    const explicitCandidates = [
      options.baseUrl,
      process.env.BOSUN_MCP_BASE_URL,
      process.env.TELEGRAM_UI_BASE_URL,
    ]
      .map(normalizeBaseUrl)
      .filter(Boolean);

    for (const candidate of explicitCandidates) {
      const resolved = await probeBosunBaseUrl(candidate, options);
      if (resolved) return resolved;
    }

    for (const port of parseDiscoveryPorts()) {
      const candidate = `http://127.0.0.1:${port}`;
      const resolved = await probeBosunBaseUrl(candidate, options);
      if (resolved) return resolved;
    }

    return null;
  }

  async function startEmbeddedBackend() {
    if (backend) return backend;
    uiServerModule ||= await import("./ui-server.mjs");

    if (!savedEnv) {
      savedEnv = Object.fromEntries(
        ENV_KEYS_FOR_EMBEDDED.map((key) => [key, process.env[key]]),
      );
    }

    process.env.TELEGRAM_UI_ALLOW_UNSAFE = "true";
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.TELEGRAM_UI_TLS_DISABLE = "true";
    process.env.TELEGRAM_UI_HOST = "127.0.0.1";
    process.env.TELEGRAM_UI_PORT = "0";
    process.env.BOSUN_UI_ALLOW_EPHEMERAL_PORT = "1";
    process.env.BOSUN_UI_SKIP_INSTANCE_LOCK = "1";

    await uiServerModule.startTelegramUiServer({
      port: 0,
      host: "127.0.0.1",
      allowEphemeralPort: true,
      skipInstanceLock: true,
      skipAutoOpen: true,
    });

    const baseUrl = normalizeBaseUrl(uiServerModule.getTelegramUiUrl?.());
    if (!baseUrl) {
      throw new Error("Bosun embedded backend started without a resolvable URL");
    }

    backend = {
      type: "embedded",
      baseUrl,
    };
    return backend;
  }

  async function ensureBackend() {
    if (backend) return backend;
    backend = await detectRunningBackend();
    if (backend) return backend;
    return startEmbeddedBackend();
  }

  async function request(pathname, options = {}) {
    const activeBackend = await ensureBackend();
    const method = String(options.method || "GET").trim().toUpperCase() || "GET";
    const timeoutMs = Number(options.timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS;
    const target = encodeQuery(
      new URL(normalizePath(pathname), `${activeBackend.baseUrl}/`),
      options.query,
    );
    const body = options.body;
    const hasBody = body !== undefined;
    const headers = options.headers ? { ...options.headers } : {};
    if (hasBody) {
      headers["Content-Type"] = "application/json";
    }
    const fetchOptions = {
      method,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
    if (hasBody) {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetchWithTimeout(target, fetchOptions, timeoutMs);
    const rawText = await response.text();
    let data = null;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {
      data = rawText;
    }

    return {
      backend: activeBackend,
      url: target.toString(),
      status: response.status,
      ok: response.ok,
      data,
      rawText,
    };
  }

  async function requestJson(pathname, options = {}) {
    const response = await request(pathname, options);
    if (!response.ok) {
      throw new Error(`Bosun request failed (${response.status}) for ${pathname}`);
    }
    if (options.expectBosunOk !== false && response.data && typeof response.data === "object" && response.data.ok === false) {
      throw new Error(String(response.data.error || `Bosun returned ok=false for ${pathname}`));
    }
    return response;
  }

  async function shutdown() {
    if (backend?.type === "embedded" && uiServerModule?.stopTelegramUiServer) {
      try {
        uiServerModule.stopTelegramUiServer();
      } catch {
        /* best effort */
      }
    }
    backend = null;

    if (savedEnv) {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value == null) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      savedEnv = null;
    }
  }

  return {
    ensureBackend,
    request,
    requestJson,
    shutdown,
  };
}

export function listBosunMcpTools() {
  return [
    {
      name: "bosun_status",
      description: "Get Bosun backend status, health, infrastructure, and agent info.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "bosun_monitor_snapshot",
      description: "Get a compact monitoring snapshot across health, sessions, tasks, workflows, and agents.",
      inputSchema: {
        type: "object",
        properties: {
          taskPageSize: { type: "number", description: "Tasks page size." },
          workflowLimit: { type: "number", description: "Workflow run limit." },
          logLines: { type: "number", description: "System log lines." },
        },
      },
    },
    {
      name: "bosun_request",
      description: "Generic Bosun JSON request against the local Bosun backend. Use as an escape hatch for endpoints not covered by the higher-level tools.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Route path such as /api/tasks or /ping." },
          method: { type: "string", description: "HTTP method." },
          query: { type: "object", additionalProperties: true, description: "Query parameters." },
          body: { type: "object", additionalProperties: true, description: "JSON body for write requests." },
          timeoutMs: { type: "number", description: "Request timeout in milliseconds." },
        },
        required: ["path"],
      },
    },
    {
      name: "bosun_list_workspaces",
      description: "List Bosun workspaces and the active workspace.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "bosun_list_sessions",
      description: "List Bosun sessions with optional workspace, type, status, and includeHidden filters.",
      inputSchema: {
        type: "object",
        properties: {
          workspace: { type: "string" },
          type: { type: "string" },
          status: { type: "string" },
          includeHidden: { type: "boolean" },
        },
      },
    },
    {
      name: "bosun_get_session",
      description: "Get a Bosun session and recent or full message history.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          workspace: { type: "string" },
          limit: { type: "number" },
          offset: { type: "number" },
          full: { type: "boolean" },
        },
        required: ["sessionId"],
      },
    },
    {
      name: "bosun_create_session",
      description: "Create a Bosun session for an external agent conversation or monitoring workflow.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string" },
          prompt: { type: "string" },
          agent: { type: "string" },
          mode: { type: "string" },
          model: { type: "string" },
          workspaceId: { type: "string" },
          workspaceDir: { type: "string" },
          agentProfileId: { type: "string" },
        },
      },
    },
    {
      name: "bosun_send_session_message",
      description: "Send a message into a Bosun session to continue or monitor a run.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          content: { type: "string" },
          mode: { type: "string" },
          model: { type: "string" },
          agentProfileId: { type: "string" },
          attachmentsAppended: { type: "boolean" },
          attachments: {
            type: "array",
            items: { type: "object", additionalProperties: true },
          },
        },
        required: ["sessionId", "content"],
      },
    },
    {
      name: "bosun_manage_session",
      description: "Apply a session action such as stop, archive, resume, delete, rename, or diff.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          action: { type: "string", description: "stop, archive, resume, delete, rename, diff" },
          title: { type: "string", description: "Required for rename." },
          workspace: { type: "string" },
        },
        required: ["sessionId", "action"],
      },
    },
    {
      name: "bosun_list_tasks",
      description: "List Bosun tasks with paging and filters.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string" },
          project: { type: "string" },
          workspace: { type: "string" },
          repository: { type: "string" },
          search: { type: "string" },
          page: { type: "number" },
          pageSize: { type: "number" },
        },
      },
    },
    {
      name: "bosun_get_task_detail",
      description: "Get task detail, diagnostics, DAG, and workflow links for a Bosun task.",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          workspace: { type: "string" },
          includeDag: { type: "boolean" },
          includeWorkflowRuns: { type: "boolean" },
        },
        required: ["taskId"],
      },
    },
    {
      name: "bosun_create_task",
      description: "Create a Bosun task.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          status: { type: "string" },
          priority: { type: "string" },
          assignee: { type: "string" },
          repository: { type: "string" },
          workspace: { type: "string" },
        },
        required: ["title"],
      },
    },
    {
      name: "bosun_list_workflow_runs",
      description: "List workflow run history for Bosun.",
      inputSchema: {
        type: "object",
        properties: {
          offset: { type: "number" },
          limit: { type: "number" },
          workspace: { type: "string" },
        },
      },
    },
    {
      name: "bosun_get_workflow_run",
      description: "Get a Bosun workflow run by run ID.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
          workspace: { type: "string" },
        },
        required: ["runId"],
      },
    },
    {
      name: "bosun_execute_workflow",
      description: "Execute a Bosun workflow by workflow ID.",
      inputSchema: {
        type: "object",
        properties: {
          workflowId: { type: "string" },
          input: { type: "object", additionalProperties: true },
          waitForCompletion: { type: "boolean" },
          workspace: { type: "string" },
        },
        required: ["workflowId"],
      },
    },
    {
      name: "bosun_get_logs",
      description: "Get the merged Bosun system log tail.",
      inputSchema: {
        type: "object",
        properties: {
          lines: { type: "number" },
        },
      },
    },
    {
      name: "bosun_tail_agent_logs",
      description: "Get focused or raw Bosun agent log tail content.",
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string" },
          query: { type: "string" },
          lines: { type: "number" },
        },
      },
    },
    {
      name: "bosun_get_agent_log_context",
      description: "Get git context for a worktree or task-relevant agent log query.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    },
    {
      name: "bosun_list_agents",
      description: "List running Bosun agents and current agent selection details.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "bosun_get_agent_events",
      description: "Get Bosun agent event bus entries.",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          type: { type: "string" },
          since: { type: "number" },
          limit: { type: "number" },
        },
      },
    },
    {
      name: "bosun_sdk_command",
      description: "Run a Bosun SDK command through the currently configured agent adapter.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          args: { type: "string" },
          adapter: { type: "string" },
          sessionId: { type: "string" },
        },
        required: ["command"],
      },
    },
    {
      name: "bosun_list_agent_tools",
      description: "List Bosun shared agent tools exposed through the agent tool route.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          executor: { type: "string" },
          mode: { type: "string" },
          model: { type: "string" },
          voiceAgentId: { type: "string" },
        },
      },
    },
    {
      name: "bosun_run_agent_tool",
      description: "Execute a Bosun shared agent tool by name.",
      inputSchema: {
        type: "object",
        properties: {
          toolName: { type: "string" },
          args: { type: "object", additionalProperties: true },
          sessionId: { type: "string" },
          executor: { type: "string" },
          mode: { type: "string" },
          model: { type: "string" },
          voiceAgentId: { type: "string" },
        },
        required: ["toolName"],
      },
    },
    // ── File tools ─────────────────────────────────────────────────────────
    {
      name: "str_replace_editor",
      description:
        "Make a surgical edit to a file by replacing an exact string. " +
        "Safer than full rewrites — preserves encoding, only changes what's specified. " +
        "Prefer this over shell-based patching. " +
        "The old_str must match exactly (whitespace included). " +
        "Call read_file first if you need to verify the exact text.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or workspace-relative file path." },
          old_str: { type: "string", description: "Exact string to find and replace (must be unique in the file)." },
          new_str: { type: "string", description: "Replacement string." },
          workspace_path: { type: "string", description: "Workspace root for resolving relative paths." },
        },
        required: ["path", "old_str", "new_str"],
      },
    },
    {
      name: "replace_lines",
      description:
        "Replace an inclusive line range in a file with new content. " +
        "Use this when you know the line numbers from read_file and a full rewrite would be excessive. " +
        "Safer than shell patch scripts and less brittle than exact-string replacement for larger blocks.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or workspace-relative file path." },
          start_line: { type: "number", description: "First line to replace (1-indexed, inclusive)." },
          end_line: { type: "number", description: "Last line to replace (1-indexed, inclusive)." },
          new_content: { type: "string", description: "Replacement content for the selected line range." },
          workspace_path: { type: "string", description: "Workspace root for resolving relative paths." },
        },
        required: ["path", "start_line", "end_line", "new_content"],
      },
    },
    {
      name: "write_file",
      description:
        "Write content to a file, creating it and any missing parent directories if needed. " +
        "Use for new files by default. " +
        "For editing existing files prefer str_replace_editor or replace_lines. " +
        "Set overwrite_existing=true only for an intentional full-file rewrite.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or workspace-relative file path." },
          content: { type: "string", description: "Full file content to write." },
          overwrite_existing: {
            type: "boolean",
            description: "When true, allows replacing an existing file with the provided full content.",
          },
          workspace_path: { type: "string", description: "Workspace root for resolving relative paths." },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "read_file",
      description:
        "Read a file's content with line numbers. Use start_line and end_line to focus on a range. " +
        "Always call this before str_replace_editor to confirm the exact text you want to replace.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or workspace-relative file path." },
          start_line: { type: "number", description: "First line to read (1-indexed, inclusive)." },
          end_line: { type: "number", description: "Last line to read (1-indexed, inclusive)." },
          workspace_path: { type: "string", description: "Workspace root for resolving relative paths." },
        },
        required: ["path"],
      },
    },
    {
      name: "grep_search",
      description:
        "Search for text or regex patterns across files. Returns matching lines with file paths and line numbers. " +
        "Use this to locate code before editing rather than guessing paths.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Text or regex pattern to search for." },
          path: { type: "string", description: "Directory or file to search in (defaults to workspace root)." },
          glob: { type: "string", description: "Glob pattern to filter files, e.g. '**/*.mjs' or '*.ts'." },
          case_insensitive: { type: "boolean", description: "Case-insensitive search. Default: false." },
          max_results: { type: "number", description: "Maximum number of matching lines to return. Default: 50." },
          workspace_path: { type: "string", description: "Workspace root for resolving relative paths." },
        },
        required: ["pattern"],
      },
    },
  ];
}

// ── File tool helpers ──────────────────────────────────────────────────────

function resolveFilePath(filePath, workspacePath) {
  const p = String(filePath ?? "").trim();
  if (!p) throw new Error("path is required");
  if (p.match(/^([A-Za-z]:\\|\/)/)) return p; // already absolute
  const base = workspacePath ? resolve(String(workspacePath).trim()) : process.cwd();
  return join(base, p);
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) { count++; pos += needle.length; }
  return count;
}

function detectPreferredNewline(text) {
  return String(text || "").includes("\r\n") ? "\r\n" : "\n";
}

function listLineBoundaries(text) {
  const source = String(text || "");
  const boundaries = [];
  let lineStart = 0;
  for (let index = 0; index < source.length; index++) {
    if (source[index] !== "\n") continue;
    boundaries.push({
      start: lineStart,
      end: index + 1,
    });
    lineStart = index + 1;
  }
  if (lineStart < source.length || source.length === 0) {
    boundaries.push({
      start: lineStart,
      end: source.length,
    });
  }
  return boundaries;
}

const GREP_SKIP_DIRS = new Set(["node_modules", ".git", ".bosun", "dist", "build", ".next", "coverage"]);

function matchGlob(filePath, pattern) {
  if (!pattern || pattern === "**/*") return true;
  // Simple glob: supports *.ext and **/*.ext patterns only
  let ext = "";
  if (pattern.startsWith("*.")) {
    ext = pattern.slice(2);
  } else if (pattern.startsWith("**/*.")) {
    ext = pattern.slice(5);
  }
  if (ext && !pattern.includes("/")) return filePath.endsWith(`.${ext}`);
  return true;
}

function walkForGrep(dir, glob, callback) {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!GREP_SKIP_DIRS.has(entry.name)) walkForGrep(full, glob, callback);
      } else if (entry.isFile() && matchGlob(entry.name, glob)) {
        if (callback(full) === false) return;
      }
    }
  } catch { /* skip inaccessible dirs */ }
}

const BOSUN_TOOL_HANDLERS = {
  async bosun_status(runtime) {
    const backend = await runtime.ensureBackend();
    const [health, infra, agentInfo] = await Promise.allSettled([
      runtime.requestJson("/api/health"),
      runtime.requestJson("/api/infra", { expectBosunOk: false }),
      runtime.requestJson("/api/agents/info"),
    ]);
    return {
      backend,
      health: settledValue(health)?.data || null,
      infra: settledValue(infra)?.data || null,
      agentInfo: settledValue(agentInfo)?.data || null,
    };
  },

  async bosun_monitor_snapshot(runtime, args) {
    const taskPageSize = Number(args.taskPageSize) > 0 ? Number(args.taskPageSize) : 10;
    const workflowLimit = Number(args.workflowLimit) > 0 ? Number(args.workflowLimit) : 10;
    const logLines = Number(args.logLines) > 0 ? Number(args.logLines) : 40;
    const [status, sessions, tasks, workflows, agents, logs] = await Promise.all([
      BOSUN_TOOL_HANDLERS.bosun_status(runtime, {}),
      runtime.requestJson("/api/sessions"),
      runtime.requestJson("/api/tasks", { query: { pageSize: taskPageSize, page: 0 } }),
      runtime.requestJson("/api/workflows/runs", { query: { limit: workflowLimit, offset: 0 } }),
      runtime.requestJson("/api/agents"),
      runtime.requestJson("/api/logs", { query: { lines: logLines } }),
    ]);
    return {
      status,
      sessions: {
        total: Array.isArray(sessions.data?.sessions) ? sessions.data.sessions.length : 0,
        items: sessions.data?.sessions || [],
      },
      tasks: {
        total: Number(tasks.data?.total || 0),
        statusCounts: tasks.data?.statusCounts || {},
        items: tasks.data?.data || [],
      },
      workflows: {
        runs: workflows.data?.runs || [],
        pagination: workflows.data?.pagination || null,
      },
      agents: agents.data?.data || [],
      logs: logs.data?.data || null,
    };
  },

  async bosun_request(runtime, args) {
    return runtime.request(args.path, {
      method: args.method,
      query: args.query,
      body: args.body,
      timeoutMs: args.timeoutMs,
    });
  },

  async bosun_list_workspaces(runtime) {
    const [workspaces, active] = await Promise.all([
      runtime.requestJson("/api/workspaces"),
      runtime.requestJson("/api/workspaces/active"),
    ]);
    return {
      workspaces: workspaces.data?.data || [],
      activeId: workspaces.data?.activeId || null,
      activeWorkspace: active.data?.data || null,
    };
  },

  async bosun_list_sessions(runtime, args) {
    const response = await runtime.requestJson("/api/sessions", {
      query: {
        workspace: args.workspace,
        type: args.type,
        status: args.status,
        includeHidden: args.includeHidden ? 1 : undefined,
      },
    });
    return response.data;
  },

  async bosun_get_session(runtime, args) {
    const response = await runtime.requestJson(`/api/sessions/${encodeURIComponent(String(args.sessionId || "").trim())}`, {
      query: {
        workspace: args.workspace,
        limit: args.limit,
        offset: args.offset,
        full: args.full ? 1 : undefined,
      },
    });
    return response.data;
  },

  async bosun_create_session(runtime, args) {
    const response = await runtime.requestJson("/api/sessions/create", {
      method: "POST",
      body: {
        type: args.type,
        prompt: args.prompt,
        agent: args.agent,
        mode: args.mode,
        model: args.model,
        workspaceId: args.workspaceId,
        workspaceDir: args.workspaceDir,
        agentProfileId: args.agentProfileId,
      },
    });
    return response.data;
  },

  async bosun_send_session_message(runtime, args) {
    const response = await runtime.requestJson(`/api/sessions/${encodeURIComponent(String(args.sessionId || "").trim())}/message`, {
      method: "POST",
      body: {
        content: args.content,
        mode: args.mode,
        model: args.model,
        agentProfileId: args.agentProfileId,
        attachmentsAppended: args.attachmentsAppended === true,
        attachments: Array.isArray(args.attachments) ? args.attachments : [],
      },
    });
    return response.data;
  },

  async bosun_manage_session(runtime, args) {
    const sessionId = encodeURIComponent(String(args.sessionId || "").trim());
    const action = String(args.action || "").trim().toLowerCase();
    if (!action) throw new Error("action is required");
    if (action === "diff") {
      const response = await runtime.requestJson(`/api/sessions/${sessionId}/diff`, {
        query: { workspace: args.workspace },
      });
      return response.data;
    }
    const body = action === "rename" ? { title: args.title } : {};
    const response = await runtime.requestJson(`/api/sessions/${sessionId}/${action}`, {
      method: "POST",
      query: { workspace: args.workspace },
      body,
    });
    return response.data;
  },

  async bosun_list_tasks(runtime, args) {
    const response = await runtime.requestJson("/api/tasks", {
      query: {
        status: args.status,
        project: args.project,
        workspace: args.workspace,
        repository: args.repository,
        search: args.search,
        page: args.page,
        pageSize: args.pageSize,
      },
    });
    return response.data;
  },

  async bosun_get_task_detail(runtime, args) {
    const response = await runtime.requestJson("/api/tasks/detail", {
      query: {
        taskId: args.taskId,
        workspace: args.workspace,
        includeDag: args.includeDag === false ? 0 : 1,
        includeWorkflowRuns: args.includeWorkflowRuns === false ? 0 : 1,
      },
    });
    return response.data;
  },

  async bosun_create_task(runtime, args) {
    const response = await runtime.requestJson("/api/tasks/create", {
      method: "POST",
      body: {
        title: args.title,
        description: args.description,
        status: args.status,
        priority: args.priority,
        assignee: args.assignee,
        repository: args.repository,
        workspace: args.workspace,
      },
    });
    return response.data;
  },

  async bosun_list_workflow_runs(runtime, args) {
    const response = await runtime.requestJson("/api/workflows/runs", {
      query: {
        offset: args.offset,
        limit: args.limit,
        workspace: args.workspace,
      },
    });
    return response.data;
  },

  async bosun_get_workflow_run(runtime, args) {
    const response = await runtime.requestJson(`/api/workflows/runs/${encodeURIComponent(String(args.runId || "").trim())}`, {
      query: { workspace: args.workspace },
    });
    return response.data;
  },

  async bosun_execute_workflow(runtime, args) {
    const workflowId = encodeURIComponent(String(args.workflowId || "").trim());
    const input = args.input && typeof args.input === "object" ? args.input : {};
    const response = await runtime.requestJson(`/api/workflows/${workflowId}/execute`, {
      method: "POST",
      query: { workspace: args.workspace },
      body: {
        ...input,
        waitForCompletion: args.waitForCompletion === true,
      },
    });
    return response.data;
  },

  async bosun_get_logs(runtime, args) {
    const response = await runtime.requestJson("/api/logs", {
      query: { lines: args.lines },
    });
    return response.data;
  },

  async bosun_tail_agent_logs(runtime, args) {
    const response = await runtime.requestJson("/api/agent-logs/tail", {
      query: {
        file: args.file,
        query: args.query,
        lines: args.lines,
      },
    });
    return response.data;
  },

  async bosun_get_agent_log_context(runtime, args) {
    const response = await runtime.requestJson("/api/agent-logs/context", {
      query: { query: args.query },
    });
    return response.data;
  },

  async bosun_list_agents(runtime) {
    const [agents, available, info] = await Promise.all([
      runtime.requestJson("/api/agents"),
      runtime.requestJson("/api/agents/available"),
      runtime.requestJson("/api/agents/info"),
    ]);
    return {
      agents: agents.data?.data || [],
      available: available.data || null,
      info: info.data || null,
    };
  },

  async bosun_get_agent_events(runtime, args) {
    const response = await runtime.requestJson("/api/agents/events", {
      query: {
        taskId: args.taskId,
        type: args.type,
        since: args.since,
        limit: args.limit,
      },
    });
    return response.data;
  },

  async bosun_sdk_command(runtime, args) {
    const response = await runtime.requestJson("/api/agents/sdk-command", {
      method: "POST",
      body: {
        command: args.command,
        args: args.args,
        adapter: args.adapter,
        sessionId: args.sessionId,
      },
    });
    return response.data;
  },

  async bosun_list_agent_tools(runtime, args) {
    const response = await runtime.requestJson("/api/agents/tools", {
      query: {
        sessionId: args.sessionId,
        executor: args.executor,
        mode: args.mode,
        model: args.model,
        voiceAgentId: args.voiceAgentId,
      },
    });
    return response.data;
  },

  async bosun_run_agent_tool(runtime, args) {
    const response = await runtime.requestJson("/api/agents/tool", {
      method: "POST",
      body: {
        toolName: args.toolName,
        args: args.args,
        sessionId: args.sessionId,
        executor: args.executor,
        mode: args.mode,
        model: args.model,
        voiceAgentId: args.voiceAgentId,
      },
    });
    return response.data;
  },

  // ── File system tools ──────────────────────────────────────────────────────
  // These are implemented as local fs operations (not Bosun HTTP API calls)
  // so they work reliably with correct encoding regardless of shell/platform.

  str_replace_editor(_runtime, args) {
    const absPath = resolveFilePath(args.path, args.workspace_path);
    if (!existsSync(absPath)) throw new Error(`File not found: ${absPath}`);
    const original = readFileSync(absPath, "utf8");
    const oldStr = String(args.old_str ?? "");
    const newStr = repairCommonMojibake(String(args.new_str ?? ""));
    if (!oldStr) throw new Error("old_str must not be empty");
    const idx = original.indexOf(oldStr);
    if (idx === -1) {
      throw new Error(
        `str_replace_editor: old_str not found in ${absPath}.\n` +
        `Verify the exact text including whitespace. ` +
        `Tip: read_file the target first, then copy the exact text to old_str.`,
      );
    }
    const occurrences = countOccurrences(original, oldStr);
    if (occurrences > 1) {
      throw new Error(
        `str_replace_editor: old_str matched ${occurrences} times in ${absPath}. ` +
        `Add more surrounding context to make it unique.`,
      );
    }
    const updated = original.slice(0, idx) + newStr + original.slice(idx + oldStr.length);
    writeFileSync(absPath, updated, "utf8");
    const lineNum = original.slice(0, idx).split("\n").length;
    return {
      success: true,
      path: absPath,
      replaced_at_line: lineNum,
      occurrences_checked: occurrences,
      repairedMojibake: newStr !== String(args.new_str ?? ""),
    };
  },

  replace_lines(_runtime, args) {
    const absPath = resolveFilePath(args.path, args.workspace_path);
    if (!existsSync(absPath)) throw new Error(`File not found: ${absPath}`);
    const original = readFileSync(absPath, "utf8");
    const boundaries = listLineBoundaries(original);
    const totalLines = boundaries.length;
    const startLine = Number(args.start_line);
    const endLine = Number(args.end_line);
    if (!Number.isInteger(startLine) || startLine < 1) {
      throw new Error("replace_lines: start_line must be an integer >= 1");
    }
    if (!Number.isInteger(endLine) || endLine < startLine) {
      throw new Error("replace_lines: end_line must be an integer >= start_line");
    }
    if (startLine > totalLines || endLine > totalLines) {
      throw new Error(
        `replace_lines: requested range ${startLine}-${endLine} is outside ${totalLines} line(s) in ${absPath}`,
      );
    }
    const preferredNewline = detectPreferredNewline(original);
    const rawReplacement = String(args.new_content ?? "");
    let replacement = repairCommonMojibake(rawReplacement).replace(/\r?\n/g, preferredNewline);
    const startOffset = boundaries[startLine - 1].start;
    const endOffset = boundaries[endLine - 1].end;
    const suffix = original.slice(endOffset);
    if (replacement && suffix && !replacement.endsWith("\n") && !replacement.endsWith("\r")) {
      replacement += preferredNewline;
    }
    const updated = original.slice(0, startOffset) + replacement + suffix;
    writeFileSync(absPath, updated, "utf8");
    return {
      success: true,
      path: absPath,
      replaced_line_range: [startLine, endLine],
      total_lines_before: totalLines,
      total_lines_after: listLineBoundaries(updated).length,
      repairedMojibake: replacement !== rawReplacement,
    };
  },

  write_file(_runtime, args) {
    const absPath = resolveFilePath(args.path, args.workspace_path);
    const rawContent = String(args.content ?? "");
    const content = repairCommonMojibake(rawContent);
    const overwriteExisting = args.overwrite_existing === true;
    const existed = existsSync(absPath);
    if (existed && !overwriteExisting) {
      throw new Error(
        `write_file refuses to overwrite existing file: ${absPath}. ` +
        "Use str_replace_editor/replace_lines for edits, or pass overwrite_existing=true for an intentional full rewrite.",
      );
    }
    const dir = dirname(absPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(absPath, content, "utf8");
    const lineCount = content.split("\n").length;
    return {
      success: true,
      path: absPath,
      bytes_written: Buffer.byteLength(content, "utf8"),
      lines: lineCount,
      overwritten_existing: existed,
      repairedMojibake: content !== rawContent,
    };
  },

  read_file(_runtime, args) {
    const absPath = resolveFilePath(args.path, args.workspace_path);
    if (!existsSync(absPath)) throw new Error(`File not found: ${absPath}`);
    const raw = readFileSync(absPath, "utf8");
    const lines = raw.split("\n");
    const startLine = args.start_line ? Math.max(1, Number(args.start_line)) : 1;
    const endLine = args.end_line ? Math.min(lines.length, Number(args.end_line)) : lines.length;
    const sliced = lines.slice(startLine - 1, endLine);
    const content = sliced
      .map((line, i) => `${String(startLine + i).padStart(6)} | ${line}`)
      .join("\n");
    return { path: absPath, start_line: startLine, end_line: startLine + sliced.length - 1, total_lines: lines.length, content };
  },

  grep_search(_runtime, args) {
    const pattern = String(args.pattern ?? "");
    if (!pattern) throw new Error("pattern is required");
    const base = args.workspace_path
      ? resolve(args.workspace_path)
      : process.cwd();
    const searchRoot = args.path
      ? resolveFilePath(args.path, args.workspace_path)
      : base;
    const glob = String(args.glob ?? "**/*");
    const caseInsensitive = Boolean(args.case_insensitive);
    const maxResults = Math.min(Number(args.max_results ?? 50), 500);
    const flags = caseInsensitive ? "gi" : "g";
    let regex;
    try {
      regex = new RegExp(pattern, flags);
    } catch {
      regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    }
    const matches = [];
    walkForGrep(searchRoot, glob, (filePath) => {
      if (matches.length >= maxResults) return false;
      try {
        const text = readFileSync(filePath, "utf8");
        const fileLines = text.split("\n");
        for (let i = 0; i < fileLines.length; i++) {
          if (matches.length >= maxResults) break;
          if (regex.test(fileLines[i])) {
            matches.push({ file: filePath, line: i + 1, text: fileLines[i].trim() });
          }
        }
      } catch { /* skip unreadable files */ }
      return true;
    });
    return { pattern, results: matches, total: matches.length, truncated: matches.length >= maxResults };
  },
};

async function callBosunTool(runtime, name, rawArgs = {}) {
  const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
  const handler = BOSUN_TOOL_HANDLERS[name];
  if (!handler) {
    throw new Error(`Unknown Bosun MCP tool: ${name}`);
  }
  return handler(runtime, args);
}

export function createBosunMcpHandlers(runtime) {
  return {
    listTools() {
      return { tools: listBosunMcpTools() };
    },

    async callTool(name, args) {
      const payload = await callBosunTool(runtime, name, args || {});
      return createToolResult(payload);
    },
  };
}

export async function startBosunMcpServer(options = {}) {
  const runtime = await createBosunMcpRuntime(options);
  const handlers = createBosunMcpHandlers(runtime);
  const server = new Server(
    { name: "bosun-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ResolvedListToolsRequestSchema, async () => handlers.listTools());
  server.setRequestHandler(ResolvedCallToolRequestSchema, async (request) => {
    const name = String(request.params?.name || "").trim();
    return handlers.callTool(name, request.params?.arguments || {});
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  return { server, runtime, transport };
}

async function main() {
  redirectConsoleToStderr();
  const { runtime } = await startBosunMcpServer();
  let shuttingDown = false;
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await runtime.shutdown();
    } finally {
      process.exit(code);
    }
  };

  process.on("SIGINT", () => {
    void shutdown(0);
  });
  process.on("SIGTERM", () => {
    void shutdown(0);
  });
  process.on("uncaughtException", (error) => {
    console.error(`${TAG} uncaught exception: ${error?.stack || error?.message || error}`);
    void shutdown(1);
  });
  process.on("unhandledRejection", (error) => {
    console.error(`${TAG} unhandled rejection: ${error?.stack || error?.message || error}`);
    void shutdown(1);
  });
}

if (isMainModule()) {
  try {
    await main();
  } catch (error) {
    console.error(`${TAG} failed to start: ${error?.stack || error?.message || error}`);
    process.exit(1);
  }
}
