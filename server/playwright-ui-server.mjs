/**
 * Minimal static server for Playwright UI inspection.
 * Serves ui/ files with proper MIME types + mock API endpoints.
 * Proxies MUI/Emotion vendor files through esm.sh to get ESM-safe bundles.
 * Includes WebSocket stub and E2E-test-mode HTML for Playwright E2E tests.
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import {
  describeMultimodalFallback,
  ensureBrowserWorkerIsolation,
  getBrowserWorkerIsolation,
  listBrowserWorkerIsolations,
  recordMultimodalFallback,
  releaseBrowserWorkerIsolation,
} from "../voice/vision-session-state.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiRoot = resolve(__dirname, "..", "ui");
const sharedLibRoot = resolve(__dirname, "..", "lib");
const workflowRoot = resolve(__dirname, "..", "workflow");
const PORT = Number.parseInt(String(process.env.PLAYWRIGHT_UI_PORT || "4444"), 10) || 4444;
const ESM_CACHE_DIR = resolve(__dirname, "..", ".cache", "esm-vendor");
const LOCAL_ESM_PATH_RE = /^\/(?:@|[a-z0-9][a-z0-9._-]*@)/i;
const SAFE_ESM_PATH_RE = /^\/(?:@|[a-z0-9][a-z0-9._-]*@)[a-z0-9./_@%-]*$/i;
const SAFE_ESM_SEARCH_RE = /^\?[a-z0-9._~!$&'()*+,;=:@%/-]*$/i;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png":  "image/png",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".ttf":  "font/ttf",
};

/** Files that must be fetched from esm.sh instead of served from ui/vendor/ */
const ESM_CDN = {
  "mui-material.js":
    "https://esm.sh/@mui/material@5.15.20?target=es2022&external=react,react-dom,react/jsx-runtime",
  "emotion-react.js": "https://esm.sh/@emotion/react@11?bundle&external=react",
  "emotion-styled.js": "https://esm.sh/@emotion/styled@11?bundle&external=react,react-dom",
};

function normalizeEsmBody(body) {
  body = body.replaceAll('"https://esm.sh/', '"/');
  body = body.replaceAll("'https://esm.sh/", "'/");
  body = body.replace(
    /(import\s+(?:[^"'`]*?\s+from\s+)?["'])\/(?!\/)/g,
    "$1/",
  );
  body = body.replace(
    /(export\s+(?:\*|\{[^}]*\})\s+from\s+["'])\/(?!\/)/g,
    "$1/",
  );
  return body;
}

async function serveEsmVendor(res, name) {
  const cdnUrl = ESM_CDN[name];
  if (!cdnUrl) return false;
  const cacheKey = createHash("sha1").update(`${cdnUrl}|esm-local-proxy-v2`).digest("hex").slice(0, 12);
  const cacheFile = resolve(ESM_CACHE_DIR, `${name}.${cacheKey}.js`);

  // Try disk cache first
  if (existsSync(cacheFile)) {
    try {
      const cached = await readFile(cacheFile, "utf8");
      if (!cached.includes('Dynamic require of "react"')) {
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
        res.end(cached);
        return true;
      }
    } catch { /* fall through */ }
  }

  // Fetch from esm.sh
  try {
    console.log(`[esm-proxy] Fetching ${name} from esm.sh...`);
    const response = await fetch(cdnUrl, {
      headers: { "User-Agent": "bosun-playwright-proxy/1.0" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const raw = await response.text();
    const body = normalizeEsmBody(raw);

    // Cache to disk
    try {
      await mkdir(ESM_CACHE_DIR, { recursive: true });
      await writeFile(cacheFile, body, "utf8");
      console.log(`[esm-proxy] Cached ${name}`);
    } catch { /* best effort */ }

    res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
    res.end(body);
    return true;
  } catch (err) {
    console.error(`[esm-proxy] Failed to fetch ${name}: ${err.message}`);
    return false;
  }
}

function sanitizeEsmSearchParams(search = "") {
  if (!search || typeof search !== "string") return "";
  const original = search.startsWith("?") ? search.slice(1) : search;
  if (!original) return "";

  const allowedParams = new Set([
    "target",
    "dev",
    "bundle",
    "external",
    "deps",
    "alias",
    "keep-names",
    "pin"
  ]);

  const inputParams = new URLSearchParams(original);
  const safeParams = new URLSearchParams();

  for (const [key, value] of inputParams.entries()) {
    if (allowedParams.has(key)) {
      safeParams.append(key, value);
    }
  }

  const serialized = safeParams.toString();
  return serialized ? `?${serialized}` : "";
}

function buildSafeEsmProxyUrl(pathname, search = "") {
  const normalizedPath = String(pathname || "").trim();
  if (!SAFE_ESM_PATH_RE.test(normalizedPath)) return null;
  const safeSearch = sanitizeEsmSearchParams(search);
  return new URL(`${normalizedPath}${safeSearch}`, "https://esm.sh").toString();
}

async function serveEsmPassthrough(res, pathname, search = "") {
  const upstreamUrl = buildSafeEsmProxyUrl(pathname, search);
  if (!upstreamUrl) {
    console.error(`[esm-proxy] Rejected nested module request ${pathname}${search}`);
    return false;
  }
  try {
    const response = await fetch(upstreamUrl, {
      headers: { "User-Agent": "bosun-playwright-proxy/1.0" },
    });
    if (!response.ok) {
      console.error(`[esm-proxy] Failed to fetch nested module ${pathname}: HTTP ${response.status}`);
      return false;
    }

    const contentType = response.headers.get("content-type") || "application/javascript; charset=utf-8";
    const raw = await response.text();
    const body = contentType.includes("javascript") ? normalizeEsmBody(raw) : raw;

    res.writeHead(200, { "Content-Type": contentType });
    res.end(body);
    return true;
  } catch (err) {
    console.error(`[esm-proxy] Failed to fetch nested module ${pathname}: ${err.message}`);
    return false;
  }
}

/** ── Mock data fixtures ─────────────────────────────────────────────── */

const MOCK_WORKFLOW = {
  id: "wf-test-001",
  name: "E2E Test Workflow",
  description: "A sample workflow for E2E testing",
  nodes: [
    { id: "n1", type: "trigger", label: "Start", x: 100, y: 100, config: {} },
    { id: "n2", type: "action", label: "Run Task", x: 300, y: 100, config: {} },
    { id: "n3", type: "condition", label: "Check Result", x: 500, y: 100, config: {} },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2" },
    { id: "e2", source: "n2", target: "n3" },
  ],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const MOCK_TASK = {
  id: "task-test-001",
  title: "E2E sample task",
  status: "completed",
  priority: "medium",
  assignee: "agent-1",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const MOCK_AGENT = {
  id: "agent-1",
  name: "Test Agent",
  status: "idle",
  executor: "codex",
  uptime: 3600,
};

const MOCK_SESSION = {
  id: "session-test-001",
  title: "E2E test session",
  type: "task",
  status: "completed",
  turnCount: 5,
  createdAt: "2026-01-01T00:00:00Z",
  lastActive: "2026-01-01T01:00:00Z",
};

const MOCK_WORKFLOW_RUN = {
  id: "run-001",
  workflowId: "wf-test-001",
  status: "completed",
  startedAt: "2026-01-01T00:00:00Z",
  completedAt: "2026-01-01T00:05:00Z",
  trigger: { type: "manual" },
  nodeResults: {},
};

const MOCK_NODE_TYPES = [
  { type: "trigger", label: "Trigger", category: "control", inputs: [], outputs: [{ id: "out", label: "Output" }] },
  { type: "action", label: "Action", category: "execution", inputs: [{ id: "in", label: "Input" }], outputs: [{ id: "out", label: "Output" }] },
  { type: "condition", label: "Condition", category: "control", inputs: [{ id: "in", label: "Input" }], outputs: [{ id: "true", label: "True" }, { id: "false", label: "False" }] },
];

/** Mock API responses so the UI doesn't error out */
const MOCK_API = {
  // Core
  "/api/health": { status: "ok", version: "0.0.0-test", uptime: 99 },
  "/api/status": { status: "ok", version: "0.0.0-test", uptime: 99, primaryAgent: "codex", mode: "virtengine" },
  "/api/config": { projectName: "test-project", mode: "virtengine", kanbanBackend: "internal" },
  "/api/settings": { VOICE_ENABLED: false, VOICE_TRANSCRIPTION_ENABLED: true, PROJECT_NAME: "test-project" },
  "/api/command": { ok: true },
  "/api/voice/config": { enabled: false },

  // Dashboard
  "/api/dashboard": { summary: { tasksCompleted: 5, tasksInProgress: 2 }, agents: [MOCK_AGENT], recentTasks: [MOCK_TASK] },
  "/api/health-stats": { runs: [], successRate: 1.0, avgDuration: 120 },
  "/api/recent-commits": [],
  "/api/project-summary": { name: "test-project", totalTasks: 10, completedTasks: 5, agents: 1 },
  "/api/retry-queue": [],
  "/api/executor": { primary: "codex", available: ["codex", "copilot"], running: 1 },

  // Tasks
  "/api/tasks": { tasks: [MOCK_TASK], total: 1, page: 0, pageSize: 25 },
  "/api/tasks/sprints": [],
  "/api/tasks/dag": { nodes: [], edges: [] },
  "/api/tasks/dag/sprints": [],
  "/api/tasks/dag/index": { nodes: [], edges: [] },
  "/api/tasks/dag/global": { nodes: [], edges: [] },
  "/api/tasks/dag/epics": { nodes: [], edges: [] },
  "/api/tasks/graph": { nodes: [], edges: [] },
  "/api/tasks/graph/global": { nodes: [], edges: [] },
  "/api/tasks/dependencies": [],
  "/api/tasks/epic-dependencies": [],
  "/api/tasks/epics/dependencies": [],
  "/api/tasks/dag-of-dags": { nodes: [], edges: [] },

  // Workflows
  "/api/workflows": [MOCK_WORKFLOW],
  "/api/workflows/templates": [{ id: "tpl-1", name: "Health Check", description: "Basic health check", nodes: [], edges: [] }],
  "/api/workflows/node-types": MOCK_NODE_TYPES,
  "/api/workflows/runs": { runs: [MOCK_WORKFLOW_RUN], total: 1 },

  // Agents / Sessions
  "/api/agents": [MOCK_AGENT],
  "/api/sessions": { sessions: [MOCK_SESSION], total: 1, page: 1, limit: 25 },

  // Infrastructure
  "/api/infra": { containers: [], services: [], health: "ok" },
  "/api/worktrees": [],
  "/api/shared-workspaces": [],
  "/api/presence": [],
  "/api/workspaces": [],
  "/api/workspaces/active/repos": [],

  // Logs
  "/api/logs": { lines: ["[2026-01-01 00:00:00] System started", "[2026-01-01 00:00:01] Ready"] },
  "/api/git/branches": [],
  "/api/git/diff": { diff: "" },
  "/api/agent-logs": [],
  "/api/agent-logs/tail": { lines: [] },

  // Library
  "/api/library": { entries: [{ id: "lib-1", type: "skill", name: "Test Skill", description: "A test skill" }], total: 1 },

  // Manual flows
  "/api/manual-flows/templates": [],
  "/api/manual-flows/runs": [],

  // Telemetry
  "/api/telemetry": { agents: [], sessions: [] },
  "/api/telemetry/summary": { totalRuns: 10, successRate: 0.9, avgDuration: 120 },
  "/api/telemetry/errors": [],
  "/api/telemetry/executors": [],
  "/api/telemetry/alerts": [],
  "/api/telemetry/shredding": { stats: {} },
  "/api/analytics/usage": { days: 30, dataPoints: [] },

  // Benchmarks
  "/api/benchmarks": { results: [], providers: [] },
};

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (pathname === "/api/playwright/browser-workers" && req.method === "GET") {
    const sessionId = String(url.searchParams.get("sessionId") || "").trim();
    const workers = sessionId
      ? [getBrowserWorkerIsolation(sessionId)].filter(Boolean)
      : listBrowserWorkerIsolations();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      workers,
      total: workers.length,
    }));
    return;
  }

  if (pathname === "/api/playwright/browser-workers" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const sessionId = String(body?.sessionId || "").trim();
      if (!sessionId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "sessionId is required" }));
        return;
      }
      const worker = ensureBrowserWorkerIsolation(sessionId, {
        parentSessionId: String(body?.parentSessionId || "").trim() || null,
        rootSessionId: String(body?.rootSessionId || "").trim() || null,
        profileScope: String(body?.profileScope || "").trim() || "isolated-subagent",
        requestedCapabilities: Array.isArray(body?.requestedCapabilities) ? body.requestedCapabilities : [],
        toolHints: Array.isArray(body?.toolHints) ? body.toolHints : [],
        metadata: body?.metadata && typeof body.metadata === "object" ? body.metadata : {},
        multimodalFallback: body?.multimodalFallback && typeof body.multimodalFallback === "object"
          ? body.multimodalFallback
          : undefined,
      });
      const fallback = body?.fallback && typeof body.fallback === "object"
        ? recordMultimodalFallback(sessionId, body.fallback)
        : describeMultimodalFallback(sessionId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        worker,
        fallback,
      }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (/^\/api\/playwright\/browser-workers\/[^/]+\/fallback$/.test(pathname) && req.method === "POST") {
    try {
      const sessionId = decodeURIComponent(pathname.split("/")[4] || "").trim();
      const body = await readJsonBody(req);
      if (!sessionId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "sessionId is required" }));
        return;
      }
      const fallback = recordMultimodalFallback(sessionId, {
        ...body,
        source: String(body?.source || "").trim() || "playwright-ui",
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        fallback,
      }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (/^\/api\/playwright\/browser-workers\/[^/]+$/.test(pathname) && req.method === "DELETE") {
    const sessionId = decodeURIComponent(pathname.split("/")[4] || "").trim();
    const worker = releaseBrowserWorkerIsolation(sessionId, "playwright-ui-release");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      released: Boolean(worker),
      worker,
    }));
    return;
  }

  // Mock API
  if (pathname.startsWith("/api/")) {
    const key = pathname.split("?")[0];
    let data = MOCK_API[key];

    // Dynamic route matching for parameterized endpoints
    if (data === undefined) {
      if (/^\/api\/workflows\/runs\/[^/]+$/.test(key)) {
        data = MOCK_WORKFLOW_RUN;
      } else if (/^\/api\/workflows\/[^/]+\/runs$/.test(key)) {
        data = { runs: [MOCK_WORKFLOW_RUN], total: 1 };
      } else if (/^\/api\/workflows\/[^/]+$/.test(key)) {
        data = MOCK_WORKFLOW;
      } else if (/^\/api\/tasks\/[^/]+$/.test(key)) {
        data = MOCK_TASK;
      } else if (/^\/api\/sessions\/[^/]+$/.test(key)) {
        data = MOCK_SESSION;
      } else {
        data = { ok: true };
      }
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
    return;
  }

  // ESM vendor proxy for MUI/Emotion
  if (pathname.startsWith("/vendor/")) {
    const name = pathname.replace(/^\/vendor\//, "");
    if (ESM_CDN[name]) {
      const served = await serveEsmVendor(res, name);
      if (served) return;
      // Fall through to static file if proxy fails
    }
  }

  if (LOCAL_ESM_PATH_RE.test(pathname)) {
    const served = await serveEsmPassthrough(res, pathname, url.search);
    if (served) return;
  }

  // Static files
  const servesSharedLib = pathname === "/lib" || pathname.startsWith("/lib/");
  const servesWorkflowModule = pathname === "/workflow" || pathname.startsWith("/workflow/");
  const staticRoot = servesSharedLib ? sharedLibRoot : (servesWorkflowModule ? workflowRoot : uiRoot);
  const relativePath = pathname === "/"
    ? "index.html"
    : servesSharedLib
      ? pathname.slice("/lib/".length)
      : servesWorkflowModule
        ? pathname.slice("/workflow/".length)
      : pathname.replace(/^\//, "");
  let filePath = resolve(staticRoot, relativePath || "index.html");

  if (!filePath.startsWith(staticRoot)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }

  let isSpaFallback = false;
  if (!existsSync(filePath)) {
    // SPA fallback
    const looksLikeFile = /\.[a-z0-9]+$/i.test(pathname);
    if (!looksLikeFile) {
      filePath = resolve(uiRoot, "index.html");
      isSpaFallback = true;
    } else {
      res.writeHead(404); res.end("Not Found"); return;
    }
  }

  try {
    let data = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    const contentType = MIME[ext] || "application/octet-stream";

    // For HTML files, strip third-party embeds that are unrelated to UI boot
    // while preserving the real production module loader path.
    if ((ext === ".html" || isSpaFallback) && filePath.endsWith("index.html")) {
      let html = data.toString("utf-8");
      html = transformHtmlForE2E(html);
      data = Buffer.from(html, "utf-8");
    }

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch (err) {
    res.writeHead(500); res.end(err.message);
  }
});

/**
 * Transform index.html for E2E testing:
 * 1. Preserve the real production boot path.
 * 2. Remove unrelated third-party resources that add network flake.
 */
function transformHtmlForE2E(html) {
  // Remove Telegram SDK script tag.
  html = html.replace(
    /<script[^>]*telegram\.org[^>]*><\/script>/,
    "<!-- [e2e] telegram removed -->"
  );

  // Remove analytics and external font resources.
  html = html.replace(
    /<script[^>]*umami\.is[^>]*><\/script>/,
    "<!-- [e2e] analytics removed -->"
  );
  html = html.replace(
    /<img[^>]*umami\.is[^>]*\/>/,
    "<!-- [e2e] analytics pixel removed -->"
  );
  html = html.replace(
    /<link[^>]*fonts\.googleapis\.com[^>]*>/g,
    "<!-- [e2e] google fonts removed -->"
  );
  html = html.replace(
    /<link[^>]*fonts\.gstatic\.com[^>]*>/g,
    "<!-- [e2e] google fonts preconnect removed -->"
  );

  return html;
}

// ── WebSocket stub ──────────────────────────────────────────────────
// The UI app connects to /ws for live updates. Without a WS handler the
// connection fails immediately which can cause render issues.
const wss = new WebSocketServer({ noServer: true });
let shuttingDown = false;

function shutdownAndExit(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    wss.clients.forEach((client) => {
      try {
        client.terminate();
      } catch {
        /* best-effort */
      }
    });
    wss.close();
  } catch {
    /* best-effort */
  }
  server.close(() => {
    process.exit(exitCode);
  });
  setTimeout(() => {
    process.exit(exitCode);
  }, 2000).unref();
}

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
      // Respond to pings from the UI
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "ping") {
            ws.send(JSON.stringify({ type: "pong", ts: msg.ts || Date.now() }));
          }
        } catch { /* ignore non-JSON */ }
      });
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`[playwright-ui-server] Serving UI at http://localhost:${PORT}`);
});

process.on("SIGINT", () => shutdownAndExit(0));
process.on("SIGTERM", () => shutdownAndExit(0));
