/* ─────────────────────────────────────────────────────────────
 *  VirtEngine Control Center – Preact + HTM SPA
 *  Single-file Telegram Mini App (no build step)
 * ────────────────────────────────────────────────────────────── */

import { h, render as preactRender } from "preact";
import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "preact/hooks";
import { signal, computed, effect } from "@preact/signals";
import htm from "htm";

const html = htm.bind(h);

/* ─── SVG Icons (inline) ─── */
const ICONS = {
  grid: html`<svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <rect x="3" y="3" width="7" height="7" />
    <rect x="14" y="3" width="7" height="7" />
    <rect x="3" y="14" width="7" height="7" />
    <rect x="14" y="14" width="7" height="7" />
  </svg>`,
  check: html`<svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
    <polyline points="22 4 12 14.01 9 11.01" />
  </svg>`,
  cpu: html`<svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <rect x="4" y="4" width="16" height="16" rx="2" ry="2" />
    <rect x="9" y="9" width="6" height="6" />
    <line x1="9" y1="1" x2="9" y2="4" />
    <line x1="15" y1="1" x2="15" y2="4" />
    <line x1="9" y1="20" x2="9" y2="23" />
    <line x1="15" y1="20" x2="15" y2="23" />
    <line x1="20" y1="9" x2="23" y2="9" />
    <line x1="20" y1="14" x2="23" y2="14" />
    <line x1="1" y1="9" x2="4" y2="9" />
    <line x1="1" y1="14" x2="4" y2="14" />
  </svg>`,
  server: html`<svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
    <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
    <line x1="6" y1="6" x2="6.01" y2="6" />
    <line x1="6" y1="18" x2="6.01" y2="18" />
  </svg>`,
  sliders: html`<svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <line x1="4" y1="21" x2="4" y2="14" />
    <line x1="4" y1="10" x2="4" y2="3" />
    <line x1="12" y1="21" x2="12" y2="12" />
    <line x1="12" y1="8" x2="12" y2="3" />
    <line x1="20" y1="21" x2="20" y2="16" />
    <line x1="20" y1="12" x2="20" y2="3" />
    <line x1="1" y1="14" x2="7" y2="14" />
    <line x1="9" y1="8" x2="15" y2="8" />
    <line x1="17" y1="16" x2="23" y2="16" />
  </svg>`,
  terminal: html`<svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </svg>`,
  plus: html`<svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>`,
  chevronDown: html`<svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    width="16"
    height="16"
  >
    <polyline points="6 9 12 15 18 9" />
  </svg>`,
  send: html`<svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    width="16"
    height="16"
  >
    <line x1="22" y1="2" x2="11" y2="13" />
    <polygon points="22 2 15 22 11 13 2 9 22 2" />
  </svg>`,
  refresh: html`<svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    width="16"
    height="16"
  >
    <polyline points="23 4 23 10 17 10" />
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
  </svg>`,
};

/* ─── Telegram SDK ─── */
function getTg() {
  return globalThis.Telegram?.WebApp || null;
}

function haptic(type = "light") {
  try {
    getTg()?.HapticFeedback?.impactOccurred(type);
  } catch {
    /* noop */
  }
}

function applyTgTheme() {
  const tg = getTg();
  if (!tg?.themeParams) return;
  const tp = tg.themeParams;
  const root = document.documentElement;
  root.setAttribute("data-tg-theme", "true");
  if (tp.bg_color) root.style.setProperty("--bg-primary", tp.bg_color);
  if (tp.secondary_bg_color) {
    root.style.setProperty("--bg-secondary", tp.secondary_bg_color);
    root.style.setProperty("--bg-card", tp.secondary_bg_color);
  }
  if (tp.text_color) root.style.setProperty("--text-primary", tp.text_color);
  if (tp.hint_color) {
    root.style.setProperty("--text-secondary", tp.hint_color);
    root.style.setProperty("--text-hint", tp.hint_color);
  }
  if (tp.link_color) root.style.setProperty("--accent", tp.link_color);
  if (tp.button_color) root.style.setProperty("--accent", tp.button_color);
  if (tp.button_text_color)
    root.style.setProperty("--accent-text", tp.button_text_color);
}

/* ─── Global Signals ─── */
const activeTab = signal("dashboard");
const connected = signal(false);
const wsConnected = signal(false);

// Per-tab data signals
const statusData = signal(null);
const executorData = signal(null);
const tasksData = signal([]);
const tasksTotal = signal(0);
const tasksPage = signal(0);
const tasksPageSize = signal(8);
const tasksStatus = signal("todo");
const tasksProject = signal("");
const tasksQuery = signal("");
const projectsData = signal([]);
const logsData = signal(null);
const logsLines = signal(200);
const threadsData = signal([]);
const worktreesData = signal([]);
const worktreeStats = signal(null);
const presenceData = signal(null);
const sharedWorkspacesData = signal(null);
const sharedAvailability = signal(null);
const gitBranches = signal([]);
const gitDiff = signal("");
const agentLogFiles = signal([]);
const agentLogFile = signal("");
const agentLogLines = signal(200);
const agentLogQuery = signal("");
const agentLogTail = signal(null);
const agentContext = signal(null);
const manualMode = signal(false);
const modalState = signal(null);
const toasts = signal([]);
const loading = signal(false);

// WebSocket state
let ws = null;
let wsRetryMs = 1000;
let wsReconnectTimer = null;
let wsRefreshTimer = null;
let pendingMutation = false;

/* ─── Toast System ─── */
let toastId = 0;
function addToast(message, type = "info") {
  const id = ++toastId;
  toasts.value = [...toasts.value, { id, message, type }];
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }, 3500);
}

/* ─── API Client ─── */
async function apiFetch(path, options = {}) {
  const headers = { "Content-Type": "application/json" };
  const tg = getTg();
  if (tg?.initData) {
    headers["X-Telegram-InitData"] = tg.initData;
  }
  try {
    const res = await fetch(path, { ...options, headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `Request failed (${res.status})`);
    }
    return res.json();
  } catch (err) {
    if (!options._silent) addToast(err.message, "error");
    throw err;
  }
}

function sendCommandToChat(command) {
  const tg = getTg();
  if (!tg) return;
  tg.sendData(JSON.stringify({ type: "command", command }));
  if (tg.showPopup) {
    tg.showPopup({
      title: "Sent",
      message: command,
      buttons: [{ type: "ok" }],
    });
  }
  haptic("medium");
}

/* ─── Data Loaders ─── */
async function loadOverview() {
  const [status, executor] = await Promise.all([
    apiFetch("/api/status", { _silent: true }).catch(() => ({ data: null })),
    apiFetch("/api/executor", { _silent: true }).catch(() => ({ data: null })),
  ]);
  statusData.value = status.data || null;
  executorData.value = executor;
}

async function loadProjects() {
  const res = await apiFetch("/api/projects", { _silent: true }).catch(() => ({
    data: [],
  }));
  projectsData.value = res.data || [];
  if (!tasksProject.value && projectsData.value.length) {
    tasksProject.value = projectsData.value[0].id || "";
  }
}

async function loadTasks() {
  const params = new URLSearchParams({
    status: tasksStatus.value,
    page: String(tasksPage.value),
    pageSize: String(tasksPageSize.value),
  });
  if (tasksProject.value) params.set("project", tasksProject.value);
  const res = await apiFetch(`/api/tasks?${params}`, { _silent: true }).catch(
    () => ({ data: [], total: 0 }),
  );
  tasksData.value = res.data || [];
  tasksTotal.value = res.total || 0;
}

async function loadLogs() {
  const res = await apiFetch(`/api/logs?lines=${logsLines.value}`, {
    _silent: true,
  }).catch(() => ({ data: null }));
  logsData.value = res.data || null;
}

async function loadThreads() {
  const res = await apiFetch("/api/threads", { _silent: true }).catch(() => ({
    data: [],
  }));
  threadsData.value = res.data || [];
}

async function loadWorktrees() {
  const res = await apiFetch("/api/worktrees", { _silent: true }).catch(() => ({
    data: [],
    stats: null,
  }));
  worktreesData.value = res.data || [];
  worktreeStats.value = res.stats || null;
}

async function loadPresence() {
  const res = await apiFetch("/api/presence", { _silent: true }).catch(() => ({
    data: null,
  }));
  presenceData.value = res.data || null;
}

async function loadSharedWorkspaces() {
  const res = await apiFetch("/api/shared-workspaces", { _silent: true }).catch(
    () => ({ data: null, availability: null }),
  );
  sharedWorkspacesData.value = res.data || null;
  sharedAvailability.value = res.availability || null;
}

async function loadGit() {
  const [branches, diff] = await Promise.all([
    apiFetch("/api/git/branches", { _silent: true }).catch(() => ({
      data: [],
    })),
    apiFetch("/api/git/diff", { _silent: true }).catch(() => ({ data: "" })),
  ]);
  gitBranches.value = branches.data || [];
  gitDiff.value = diff.data || "";
}

async function loadAgentLogFileList() {
  const params = new URLSearchParams();
  if (agentLogQuery.value) params.set("query", agentLogQuery.value);
  const path = params.toString()
    ? `/api/agent-logs?${params}`
    : "/api/agent-logs";
  const res = await apiFetch(path, { _silent: true }).catch(() => ({
    data: [],
  }));
  agentLogFiles.value = res.data || [];
}

async function loadAgentLogTailData() {
  if (!agentLogFile.value) {
    agentLogTail.value = null;
    return;
  }
  const params = new URLSearchParams({
    file: agentLogFile.value,
    lines: String(agentLogLines.value),
  });
  const res = await apiFetch(`/api/agent-logs?${params}`, {
    _silent: true,
  }).catch(() => ({ data: null }));
  agentLogTail.value = res.data || null;
}

async function loadAgentContextData(query) {
  if (!query) {
    agentContext.value = null;
    return;
  }
  const res = await apiFetch(
    `/api/agent-logs/context?query=${encodeURIComponent(query)}`,
    { _silent: true },
  ).catch(() => ({ data: null }));
  agentContext.value = res.data || null;
}

/* ─── Tab Refresh ─── */
async function refreshTab() {
  loading.value = true;
  try {
    const tab = activeTab.value;
    if (tab === "dashboard") {
      await loadOverview();
    }
    if (tab === "tasks") {
      await loadProjects();
      await loadTasks();
    }
    if (tab === "agents") {
      await loadOverview();
      await loadThreads();
    }
    if (tab === "infra") {
      await Promise.all([
        loadWorktrees(),
        loadSharedWorkspaces(),
        loadPresence(),
      ]);
    }
    if (tab === "control") {
      await loadOverview();
    }
    if (tab === "logs") {
      await Promise.all([
        loadLogs(),
        loadAgentLogFileList(),
        loadAgentLogTailData(),
      ]);
    }
  } catch {
    /* handled by apiFetch */
  }
  loading.value = false;
}

/* ─── WebSocket ─── */
function channelsForTab(tab) {
  const map = {
    dashboard: ["overview", "executor", "tasks", "agents"],
    tasks: ["tasks"],
    agents: ["agents", "executor"],
    infra: ["worktrees", "workspaces", "presence"],
    control: ["executor", "overview"],
    logs: ["*"],
  };
  return map[tab] || ["*"];
}

function scheduleRefresh(delayMs = 120) {
  if (wsRefreshTimer) clearTimeout(wsRefreshTimer);
  wsRefreshTimer = setTimeout(async () => {
    wsRefreshTimer = null;
    if (pendingMutation) return;
    try {
      await refreshTab();
    } catch {
      /* ignore */
    }
  }, delayMs);
}

function connectRealtime() {
  const tg = getTg();
  const proto = globalThis.location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = new URL(`${proto}://${globalThis.location.host}/ws`);
  if (tg?.initData) wsUrl.searchParams.set("initData", tg.initData);
  const socket = new WebSocket(wsUrl.toString());
  ws = socket;

  socket.addEventListener("open", () => {
    wsConnected.value = true;
    connected.value = true;
    wsRetryMs = 1000;
    socket.send(
      JSON.stringify({
        type: "subscribe",
        channels: channelsForTab(activeTab.value),
      }),
    );
  });

  socket.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data || "{}");
    } catch {
      return;
    }
    if (msg?.type !== "invalidate") return;
    const channels = Array.isArray(msg.channels) ? msg.channels : [];
    const interested = channelsForTab(activeTab.value);
    if (
      channels.includes("*") ||
      channels.some((c) => interested.includes(c))
    ) {
      scheduleRefresh(120);
    }
  });

  socket.addEventListener("close", () => {
    wsConnected.value = false;
    connected.value = false;
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(connectRealtime, wsRetryMs);
    wsRetryMs = Math.min(10000, wsRetryMs * 2);
  });

  socket.addEventListener("error", () => {
    connected.value = false;
  });
}

function switchWsChannel(tab) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({ type: "subscribe", channels: channelsForTab(tab) }),
    );
  }
}

/* ─── Optimistic Mutations ─── */
async function runOptimistic(apply, request, rollback) {
  pendingMutation = true;
  try {
    apply();
    const response = await request();
    pendingMutation = false;
    return response;
  } catch (err) {
    if (typeof rollback === "function") rollback();
    pendingMutation = false;
    throw err;
  }
}

function cloneValue(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

/* ─── Shared Components ─── */
function ToastContainer() {
  const items = toasts.value;
  if (!items.length) return null;
  return html`
    <div class="toast-container">
      ${items.map(
        (t) =>
          html`<div key=${t.id} class="toast toast-${t.type}">
            ${t.message}
          </div>`,
      )}
    </div>
  `;
}

function Card({ title, subtitle, children, className = "" }) {
  return html`
    <div class="card ${className}">
      ${title && html`<div class="card-title">${title}</div>`}
      ${subtitle && html`<div class="card-subtitle">${subtitle}</div>`}
      ${children}
    </div>
  `;
}

function Badge({ status, text }) {
  const label = text || status || "";
  const cls = `badge badge-${(status || "").toLowerCase().replace(/\s/g, "")}`;
  return html`<span class=${cls}>${label}</span>`;
}

function StatCard({ value, label, color }) {
  const style = color ? `color: ${color}` : "";
  return html`
    <div class="stat-card">
      <div class="stat-value" style=${style}>${value ?? "—"}</div>
      <div class="stat-label">${label}</div>
    </div>
  `;
}

function SkeletonCard({ count = 3 }) {
  return html`${Array.from(
    { length: count },
    (_, i) => html`<div key=${i} class="skeleton skeleton-card"></div>`,
  )}`;
}

function ProgressBar({ percent = 0 }) {
  return html`
    <div class="progress-bar">
      <div
        class="progress-bar-fill"
        style="width: ${Math.min(100, Math.max(0, percent))}%"
      ></div>
    </div>
  `;
}

function DonutChart({ segments = [] }) {
  const total = segments.reduce((s, seg) => s + (seg.value || 0), 0);
  if (!total) return html`<div class="text-center meta-text">No data</div>`;
  const size = 100;
  const cx = size / 2,
    cy = size / 2,
    r = 36,
    sw = 12;
  const circumference = 2 * Math.PI * r;
  let offset = 0;
  const arcs = segments.map((seg) => {
    const pct = seg.value / total;
    const dash = pct * circumference;
    const o = offset;
    offset += dash;
    return html`<circle
      cx=${cx}
      cy=${cy}
      r=${r}
      fill="none"
      stroke=${seg.color}
      stroke-width=${sw}
      stroke-dasharray="${dash} ${circumference - dash}"
      stroke-dashoffset=${-o}
      style="transition: stroke-dasharray 0.6s ease, stroke-dashoffset 0.6s ease"
    />`;
  });
  return html`
    <div class="donut-wrap">
      <svg
        width=${size}
        height=${size}
        viewBox="0 0 ${size} ${size}"
        style="transform: rotate(-90deg)"
      >
        ${arcs}
      </svg>
    </div>
    <div class="donut-legend">
      ${segments.map(
        (seg) => html`
          <span class="donut-legend-item">
            <span
              class="donut-legend-swatch"
              style="background: ${seg.color}"
            ></span>
            ${seg.label} (${seg.value})
          </span>
        `,
      )}
    </div>
  `;
}

function SegmentedControl({ options, value, onChange }) {
  return html`
    <div class="segmented-control">
      ${options.map(
        (opt) => html`
          <button
            key=${opt.value}
            class="segmented-btn ${value === opt.value ? "active" : ""}"
            onClick=${() => {
              haptic();
              onChange(opt.value);
            }}
          >
            ${opt.label}
          </button>
        `,
      )}
    </div>
  `;
}

function Modal({ title, onClose, children }) {
  useEffect(() => {
    const tg = getTg();
    if (tg?.BackButton) {
      tg.BackButton.show();
      const handler = () => {
        onClose();
        tg.BackButton.hide();
        tg.BackButton.offClick(handler);
      };
      tg.BackButton.onClick(handler);
      return () => {
        tg.BackButton.hide();
        tg.BackButton.offClick(handler);
      };
    }
  }, [onClose]);

  return html`
    <div
      class="modal-overlay"
      onClick=${(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div class="modal-content" onClick=${(e) => e.stopPropagation()}>
        <div class="modal-handle"></div>
        ${title && html`<div class="modal-title">${title}</div>`} ${children}
      </div>
    </div>
  `;
}

function Collapsible({ title, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return html`
    <div>
      <button
        class="collapsible-header ${open ? "open" : ""}"
        onClick=${() => setOpen(!open)}
      >
        <span>${title}</span>
        ${ICONS.chevronDown}
      </button>
      <div class="collapsible-body ${open ? "open" : ""}">${children}</div>
    </div>
  `;
}

function PullToRefresh({ onRefresh, children }) {
  const [refreshing, setRefreshing] = useState(false);
  const ref = useRef(null);
  const startY = useRef(0);
  const pulling = useRef(false);

  const handleTouchStart = useCallback((e) => {
    if (ref.current && ref.current.scrollTop === 0) {
      startY.current = e.touches[0].clientY;
      pulling.current = true;
    }
  }, []);

  const handleTouchMove = useCallback(() => {
    // passive listener – visual feedback could go here
  }, []);

  const handleTouchEnd = useCallback(
    async (e) => {
      if (!pulling.current) return;
      pulling.current = false;
      const diff = (e.changedTouches?.[0]?.clientY || 0) - startY.current;
      if (diff > 60) {
        setRefreshing(true);
        haptic("medium");
        try {
          await onRefresh();
        } finally {
          setRefreshing(false);
        }
      }
    },
    [onRefresh],
  );

  return html`
    <div
      ref=${ref}
      class="main-content"
      onTouchStart=${handleTouchStart}
      onTouchMove=${handleTouchMove}
      onTouchEnd=${handleTouchEnd}
    >
      ${refreshing &&
      html`<div class="ptr-spinner"><div class="ptr-spinner-icon"></div></div>`}
      ${children}
    </div>
  `;
}

/* ═══════════════════════════════════════════════
 *  TAB: Dashboard
 * ═══════════════════════════════════════════════ */
function DashboardTab() {
  const status = statusData.value;
  const executor = executorData.value;
  const counts = status?.counts || {};
  const summary = status?.success_metrics || {};
  const execData = executor?.data;
  const mode = executor?.mode || "internal";
  const running = Number(counts.running || 0);
  const review = Number(counts.review || 0);
  const blocked = Number(counts.error || 0);
  const backlog = Number(status?.backlog_remaining || 0);
  const totalActive = running + review + blocked;
  const progressPct =
    backlog + totalActive > 0
      ? Math.round((totalActive / (backlog + totalActive)) * 100)
      : 0;

  const segments = [
    { label: "Running", value: running, color: "var(--color-inprogress)" },
    { label: "Review", value: review, color: "var(--color-inreview)" },
    { label: "Blocked", value: blocked, color: "var(--color-error)" },
    { label: "Backlog", value: backlog, color: "var(--color-todo)" },
  ];

  const handlePause = async () => {
    haptic("medium");
    const prev = cloneValue(executor);
    await runOptimistic(
      () => {
        if (executorData.value)
          executorData.value = { ...executorData.value, paused: true };
      },
      () => apiFetch("/api/executor/pause", { method: "POST" }),
      () => {
        executorData.value = prev;
      },
    ).catch(() => {});
    scheduleRefresh(120);
  };

  const handleResume = async () => {
    haptic("medium");
    const prev = cloneValue(executor);
    await runOptimistic(
      () => {
        if (executorData.value)
          executorData.value = { ...executorData.value, paused: false };
      },
      () => apiFetch("/api/executor/resume", { method: "POST" }),
      () => {
        executorData.value = prev;
      },
    ).catch(() => {});
    scheduleRefresh(120);
  };

  if (loading.value && !status)
    return html`<${Card} title="Loading..."><${SkeletonCard} count=${4} /><//>`;

  return html`
    <${Card} title="Today at a Glance">
      <div class="stats-grid">
        <${StatCard}
          value=${running}
          label="Running"
          color="var(--color-inprogress)"
        />
        <${StatCard}
          value=${review}
          label="In Review"
          color="var(--color-inreview)"
        />
        <${StatCard}
          value=${blocked}
          label="Blocked"
          color="var(--color-error)"
        />
        <${StatCard}
          value=${backlog}
          label="Backlog"
          color="var(--color-todo)"
        />
      </div>
    <//>
    <${Card} title="Task Distribution">
      <${DonutChart} segments=${segments} />
      <div class="meta-text text-center mt-sm">
        Active progress · ${progressPct}% engaged
      </div>
      <${ProgressBar} percent=${progressPct} />
    <//>
    <${Card} title="Executor">
      <div class="meta-text mb-sm">
        Mode: ${mode} · Slots:
        ${execData?.activeSlots ?? 0}/${execData?.maxParallel ?? "—"} · Paused:
        ${executor?.paused ? "Yes" : "No"}
      </div>
      <div class="btn-row">
        <button class="btn btn-primary btn-sm" onClick=${handlePause}>
          Pause
        </button>
        <button class="btn btn-secondary btn-sm" onClick=${handleResume}>
          Resume
        </button>
      </div>
    <//>
    <${Card} title="Quality">
      <div class="meta-text">
        First-shot: ${summary.first_shot_rate ?? 0}% · Needed fix:
        ${summary.needed_fix ?? 0} · Failed: ${summary.failed ?? 0}
      </div>
      <div class="btn-row mt-sm">
        <button
          class="btn btn-ghost btn-sm"
          onClick=${() => sendCommandToChat("/status")}
        >
          /status
        </button>
        <button
          class="btn btn-ghost btn-sm"
          onClick=${() => sendCommandToChat("/health")}
        >
          /health
        </button>
      </div>
    <//>
  `;
}

/* ═══════════════════════════════════════════════
 *  TAB: Tasks
 * ═══════════════════════════════════════════════ */
function CreateTaskModal({ onClose }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState("todo");
  const [priority, setPriority] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!title.trim()) {
      addToast("Title is required", "error");
      return;
    }
    setSubmitting(true);
    haptic("medium");
    try {
      const project = tasksProject.value;
      await apiFetch("/api/tasks/create", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          status,
          priority: priority || undefined,
          project,
        }),
      });
      addToast("Task created", "success");
      onClose();
      await refreshTab();
    } catch {
      /* toast shown by apiFetch */
    }
    setSubmitting(false);
  };

  // Use Telegram MainButton for submit
  useEffect(() => {
    const tg = getTg();
    if (tg?.MainButton) {
      tg.MainButton.setText("Create Task");
      tg.MainButton.show();
      tg.MainButton.onClick(handleSubmit);
      return () => {
        tg.MainButton.hide();
        tg.MainButton.offClick(handleSubmit);
      };
    }
  }, [title, description, status, priority]);

  return html`
    <${Modal} title="New Task" onClose=${onClose}>
      <div class="flex-col gap-md">
        <input
          class="input"
          placeholder="Task title"
          value=${title}
          onInput=${(e) => setTitle(e.target.value)}
        />
        <textarea
          class="input"
          rows="4"
          placeholder="Description"
          value=${description}
          onInput=${(e) => setDescription(e.target.value)}
        ></textarea>
        <div class="input-row">
          <select
            class="input"
            value=${status}
            onChange=${(e) => setStatus(e.target.value)}
          >
            <option value="todo">Todo</option>
            <option value="inprogress">In Progress</option>
            <option value="inreview">In Review</option>
          </select>
          <select
            class="input"
            value=${priority}
            onChange=${(e) => setPriority(e.target.value)}
          >
            <option value="">No priority</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </div>
        <button
          class="btn btn-primary"
          onClick=${handleSubmit}
          disabled=${submitting}
        >
          ${submitting ? "Creating..." : "Create Task"}
        </button>
      </div>
    <//>
  `;
}

function TaskDetailModal({ task, onClose }) {
  const [title, setTitle] = useState(task?.title || "");
  const [description, setDescription] = useState(task?.description || "");
  const [status, setStatus] = useState(task?.status || "todo");
  const [priority, setPriority] = useState(task?.priority || "");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    haptic("medium");
    const prev = cloneValue(tasksData.value);
    try {
      await runOptimistic(
        () => {
          tasksData.value = tasksData.value.map((t) =>
            t.id === task.id
              ? { ...t, title, description, status, priority: priority || null }
              : t,
          );
        },
        async () => {
          const res = await apiFetch("/api/tasks/edit", {
            method: "POST",
            body: JSON.stringify({
              taskId: task.id,
              title,
              description,
              status,
              priority,
            }),
          });
          if (res?.data)
            tasksData.value = tasksData.value.map((t) =>
              t.id === task.id ? { ...t, ...res.data } : t,
            );
          return res;
        },
        () => {
          tasksData.value = prev;
        },
      );
      addToast("Task saved", "success");
      onClose();
    } catch {
      /* toast via apiFetch */
    }
    setSaving(false);
  };

  const handleStatusUpdate = async (newStatus) => {
    haptic("medium");
    const prev = cloneValue(tasksData.value);
    try {
      await runOptimistic(
        () => {
          tasksData.value = tasksData.value.map((t) =>
            t.id === task.id ? { ...t, status: newStatus } : t,
          );
        },
        async () => {
          const res = await apiFetch("/api/tasks/update", {
            method: "POST",
            body: JSON.stringify({ taskId: task.id, status: newStatus }),
          });
          if (res?.data)
            tasksData.value = tasksData.value.map((t) =>
              t.id === task.id ? { ...t, ...res.data } : t,
            );
          return res;
        },
        () => {
          tasksData.value = prev;
        },
      );
      if (newStatus === "done") onClose();
      else setStatus(newStatus);
    } catch {
      /* toast */
    }
  };

  const handleStart = async () => {
    haptic("medium");
    const prev = cloneValue(tasksData.value);
    try {
      await runOptimistic(
        () => {
          tasksData.value = tasksData.value.map((t) =>
            t.id === task.id ? { ...t, status: "inprogress" } : t,
          );
        },
        () =>
          apiFetch("/api/tasks/start", {
            method: "POST",
            body: JSON.stringify({ taskId: task.id }),
          }),
        () => {
          tasksData.value = prev;
        },
      );
      onClose();
    } catch {
      /* toast */
    }
    scheduleRefresh(150);
  };

  return html`
    <${Modal} title=${task?.title || "Task"} onClose=${onClose}>
      <div class="meta-text mb-md">ID: ${task?.id}</div>
      <div class="flex-col gap-md">
        <input
          class="input"
          placeholder="Title"
          value=${title}
          onInput=${(e) => setTitle(e.target.value)}
        />
        <textarea
          class="input"
          rows="5"
          placeholder="Description"
          value=${description}
          onInput=${(e) => setDescription(e.target.value)}
        ></textarea>
        <div class="input-row">
          <select
            class="input"
            value=${status}
            onChange=${(e) => setStatus(e.target.value)}
          >
            ${["todo", "inprogress", "inreview", "done", "cancelled"].map(
              (s) => html`<option value=${s}>${s}</option>`,
            )}
          </select>
          <select
            class="input"
            value=${priority}
            onChange=${(e) => setPriority(e.target.value)}
          >
            <option value="">No priority</option>
            ${["low", "medium", "high", "critical"].map(
              (p) => html`<option value=${p}>${p}</option>`,
            )}
          </select>
        </div>
        <div class="btn-row">
          ${manualMode.value &&
          task?.status === "todo" &&
          html`<button class="btn btn-primary btn-sm" onClick=${handleStart}>
            Start
          </button>`}
          <button
            class="btn btn-secondary btn-sm"
            onClick=${handleSave}
            disabled=${saving}
          >
            ${saving ? "Saving..." : "Save"}
          </button>
          <button
            class="btn btn-ghost btn-sm"
            onClick=${() => handleStatusUpdate("inreview")}
          >
            → Review
          </button>
          <button
            class="btn btn-ghost btn-sm"
            onClick=${() => handleStatusUpdate("done")}
          >
            → Done
          </button>
        </div>
      </div>
    <//>
  `;
}

function TasksTab() {
  const [showCreate, setShowCreate] = useState(false);
  const [detailTask, setDetailTask] = useState(null);
  const searchRef = useRef(null);

  const statuses = ["todo", "inprogress", "inreview", "done"];
  const search = tasksQuery.value.trim().toLowerCase();
  const visible = search
    ? tasksData.value.filter((t) =>
        `${t.title || ""} ${t.description || ""} ${t.id || ""}`
          .toLowerCase()
          .includes(search),
      )
    : tasksData.value;
  const totalPages = Math.max(
    1,
    Math.ceil((tasksTotal.value || 0) / tasksPageSize.value),
  );
  const canManual = Boolean(executorData.value?.data);

  const handleFilter = async (s) => {
    haptic();
    tasksStatus.value = s;
    tasksPage.value = 0;
    await refreshTab();
  };
  const handlePrev = async () => {
    tasksPage.value = Math.max(0, tasksPage.value - 1);
    await refreshTab();
  };
  const handleNext = async () => {
    tasksPage.value += 1;
    await refreshTab();
  };

  const handleStatusUpdate = async (taskId, newStatus) => {
    haptic("medium");
    const prev = cloneValue(tasksData.value);
    await runOptimistic(
      () => {
        tasksData.value = tasksData.value.map((t) =>
          t.id === taskId ? { ...t, status: newStatus } : t,
        );
      },
      async () => {
        const res = await apiFetch("/api/tasks/update", {
          method: "POST",
          body: JSON.stringify({ taskId, status: newStatus }),
        });
        if (res?.data)
          tasksData.value = tasksData.value.map((t) =>
            t.id === taskId ? { ...t, ...res.data } : t,
          );
      },
      () => {
        tasksData.value = prev;
      },
    ).catch(() => {});
  };

  const handleStart = async (taskId) => {
    haptic("medium");
    const prev = cloneValue(tasksData.value);
    await runOptimistic(
      () => {
        tasksData.value = tasksData.value.map((t) =>
          t.id === taskId ? { ...t, status: "inprogress" } : t,
        );
      },
      () =>
        apiFetch("/api/tasks/start", {
          method: "POST",
          body: JSON.stringify({ taskId }),
        }),
      () => {
        tasksData.value = prev;
      },
    ).catch(() => {});
    scheduleRefresh(150);
  };

  const openDetail = async (taskId) => {
    haptic();
    const local = tasksData.value.find((t) => t.id === taskId);
    const result = await apiFetch(
      `/api/tasks/detail?taskId=${encodeURIComponent(taskId)}`,
      { _silent: true },
    ).catch(() => ({ data: local }));
    setDetailTask(result.data || local);
  };

  const handleProjectChange = async (e) => {
    tasksProject.value = e.target.value;
    tasksPage.value = 0;
    await refreshTab();
  };

  if (loading.value && !tasksData.value.length)
    return html`<${Card} title="Loading Tasks..."><${SkeletonCard} /><//>`;

  return html`
    <${Card} title="Task Board">
      <div class="chip-group">
        ${statuses.map(
          (s) =>
            html`<button
              key=${s}
              class="chip ${tasksStatus.value === s ? "active" : ""}"
              onClick=${() => handleFilter(s)}
            >
              ${s.toUpperCase()}
            </button>`,
        )}
      </div>
      <div class="input-row">
        <select
          class="input"
          value=${tasksProject.value}
          onChange=${handleProjectChange}
        >
          ${projectsData.value.map(
            (p) =>
              html`<option key=${p.id} value=${p.id}>
                ${p.name || p.id}
              </option>`,
          )}
        </select>
      </div>
      <div class="flex-between mb-sm">
        <label
          class="meta-text"
          style="display:flex;align-items:center;gap:6px;cursor:pointer"
          onClick=${() => {
            if (canManual) {
              manualMode.value = !manualMode.value;
              haptic();
            }
          }}
        >
          <input
            type="checkbox"
            checked=${manualMode.value}
            disabled=${!canManual}
            style="accent-color:var(--accent)"
          />
          Manual Mode
        </label>
        <span class="pill">${visible.length} shown</span>
      </div>
      <input
        ref=${searchRef}
        class="input mb-md"
        placeholder="Search tasks..."
        value=${tasksQuery.value}
        onInput=${(e) => {
          tasksQuery.value = e.target.value;
        }}
      />
    <//>

    ${visible.map(
      (task) => html`
        <div
          key=${task.id}
          class="task-card"
          onClick=${() => openDetail(task.id)}
        >
          <div class="task-card-header">
            <div>
              <div class="task-card-title">${task.title || "(untitled)"}</div>
              <div class="task-card-meta">
                ${task.id}${task.priority
                  ? html` ·
                      <${Badge}
                        status=${task.priority}
                        text=${task.priority}
                      />`
                  : ""}
              </div>
            </div>
            <${Badge} status=${task.status} text=${task.status} />
          </div>
          <div class="meta-text">
            ${task.description
              ? task.description.slice(0, 120)
              : "No description."}
          </div>
          <div class="btn-row mt-sm" onClick=${(e) => e.stopPropagation()}>
            ${manualMode.value &&
            task.status === "todo" &&
            canManual &&
            html`<button
              class="btn btn-primary btn-sm"
              onClick=${() => handleStart(task.id)}
            >
              Start
            </button>`}
            <button
              class="btn btn-secondary btn-sm"
              onClick=${() => handleStatusUpdate(task.id, "inreview")}
            >
              → Review
            </button>
            <button
              class="btn btn-ghost btn-sm"
              onClick=${() => handleStatusUpdate(task.id, "done")}
            >
              → Done
            </button>
          </div>
        </div>
      `,
    )}
    ${!visible.length &&
    html`<div class="card text-center meta-text" style="padding:24px">
      No tasks found.
    </div>`}

    <div class="pager">
      <button class="btn btn-secondary btn-sm" onClick=${handlePrev}>
        Prev
      </button>
      <span class="pager-info"
        >Page ${tasksPage.value + 1} / ${totalPages}</span
      >
      <button class="btn btn-secondary btn-sm" onClick=${handleNext}>
        Next
      </button>
    </div>

    <button
      class="fab"
      onClick=${() => {
        haptic();
        setShowCreate(true);
      }}
    >
      ${ICONS.plus}
    </button>

    ${showCreate &&
    html`<${CreateTaskModal} onClose=${() => setShowCreate(false)} />`}
    ${detailTask &&
    html`<${TaskDetailModal}
      task=${detailTask}
      onClose=${() => setDetailTask(null)}
    />`}
  `;
}

/* ═══════════════════════════════════════════════
 *  TAB: Agents
 * ═══════════════════════════════════════════════ */
function AgentsTab() {
  const executor = executorData.value;
  const slots = executor?.data?.slots || [];
  const threads = threadsData.value;

  const viewAgentLogs = (query) => {
    haptic();
    agentLogQuery.value = query;
    agentLogFile.value = "";
    activeTab.value = "logs";
    switchWsChannel("logs");
    refreshTab();
  };

  if (loading.value && !slots.length)
    return html`<${Card} title="Loading..."><${SkeletonCard} count=${3} /><//>`;

  return html`
    <${Card} title="Active Agents">
      ${slots.length
        ? slots.map(
            (slot, i) => html`
              <div key=${i} class="task-card">
                <div class="task-card-header">
                  <div>
                    <div class="task-card-title">${slot.taskTitle}</div>
                    <div class="task-card-meta">
                      ${slot.taskId} · Agent ${slot.agentInstanceId || "n/a"} ·
                      ${slot.sdk}
                    </div>
                  </div>
                  <${Badge} status=${slot.status} text=${slot.status} />
                </div>
                <div class="meta-text">Attempt ${slot.attempt}</div>
                <div class="btn-row mt-sm">
                  <button
                    class="btn btn-ghost btn-sm"
                    onClick=${() =>
                      viewAgentLogs(
                        (slot.taskId || slot.branch || "").slice(0, 12),
                      )}
                  >
                    View Logs
                  </button>
                  <button
                    class="btn btn-ghost btn-sm"
                    onClick=${() =>
                      sendCommandToChat(`/steer focus on ${slot.taskTitle}`)}
                  >
                    Steer
                  </button>
                </div>
              </div>
            `,
          )
        : html`<div class="meta-text">No active agents.</div>`}
    <//>
    <${Card} title="Threads">
      ${threads.length
        ? html`
            <div class="stats-grid">
              ${threads.map(
                (t, i) => html`
                  <${StatCard}
                    key=${i}
                    value=${t.turnCount}
                    label="${t.taskKey} (${t.sdk})"
                  />
                `,
              )}
            </div>
          `
        : html`<div class="meta-text">No threads.</div>`}
    <//>
  `;
}

/* ═══════════════════════════════════════════════
 *  TAB: Infra (Worktrees + Workspaces + Presence)
 * ═══════════════════════════════════════════════ */
function InfraTab() {
  const wts = worktreesData.value;
  const wStats = worktreeStats.value || {};
  const registry = sharedWorkspacesData.value;
  const workspaces = registry?.workspaces || [];
  const availability = sharedAvailability.value || {};
  const presence = presenceData.value;
  const instances = presence?.instances || [];
  const coordinator = presence?.coordinator || null;

  const [releaseInput, setReleaseInput] = useState("");
  const [sharedOwner, setSharedOwner] = useState("");
  const [sharedTtl, setSharedTtl] = useState("");
  const [sharedNote, setSharedNote] = useState("");

  const handlePrune = async () => {
    haptic("medium");
    await apiFetch("/api/worktrees/prune", { method: "POST" }).catch(() => {});
    scheduleRefresh(120);
  };

  const handleRelease = async (key, branch) => {
    haptic("medium");
    const prev = cloneValue(wts);
    await runOptimistic(
      () => {
        worktreesData.value = worktreesData.value.filter(
          (w) => w.taskKey !== key && w.branch !== branch,
        );
      },
      () =>
        apiFetch("/api/worktrees/release", {
          method: "POST",
          body: JSON.stringify({ taskKey: key, branch }),
        }),
      () => {
        worktreesData.value = prev;
      },
    ).catch(() => {});
    scheduleRefresh(120);
  };

  const handleReleaseInput = async () => {
    if (!releaseInput.trim()) return;
    haptic("medium");
    await apiFetch("/api/worktrees/release", {
      method: "POST",
      body: JSON.stringify({
        taskKey: releaseInput.trim(),
        branch: releaseInput.trim(),
      }),
    }).catch(() => {});
    setReleaseInput("");
    scheduleRefresh(120);
  };

  const handleClaim = async (wsId) => {
    haptic("medium");
    const prev = cloneValue(sharedWorkspacesData.value);
    await runOptimistic(
      () => {
        const w = sharedWorkspacesData.value?.workspaces?.find(
          (x) => x.id === wsId,
        );
        if (w) {
          w.availability = "leased";
          w.lease = {
            owner: sharedOwner || "telegram-ui",
            lease_expires_at: new Date(
              Date.now() + (Number(sharedTtl) || 60) * 60000,
            ).toISOString(),
            note: sharedNote,
          };
        }
      },
      () =>
        apiFetch("/api/shared-workspaces/claim", {
          method: "POST",
          body: JSON.stringify({
            workspaceId: wsId,
            owner: sharedOwner,
            ttlMinutes: Number(sharedTtl) || undefined,
            note: sharedNote,
          }),
        }),
      () => {
        sharedWorkspacesData.value = prev;
      },
    ).catch(() => {});
    scheduleRefresh(120);
  };

  const handleRenew = async (wsId) => {
    haptic("medium");
    const prev = cloneValue(sharedWorkspacesData.value);
    await runOptimistic(
      () => {
        const w = sharedWorkspacesData.value?.workspaces?.find(
          (x) => x.id === wsId,
        );
        if (w?.lease) {
          w.lease.owner = sharedOwner || w.lease.owner;
          w.lease.lease_expires_at = new Date(
            Date.now() + (Number(sharedTtl) || 60) * 60000,
          ).toISOString();
        }
      },
      () =>
        apiFetch("/api/shared-workspaces/renew", {
          method: "POST",
          body: JSON.stringify({
            workspaceId: wsId,
            owner: sharedOwner,
            ttlMinutes: Number(sharedTtl) || undefined,
          }),
        }),
      () => {
        sharedWorkspacesData.value = prev;
      },
    ).catch(() => {});
    scheduleRefresh(120);
  };

  const handleSharedRelease = async (wsId) => {
    haptic("medium");
    const prev = cloneValue(sharedWorkspacesData.value);
    await runOptimistic(
      () => {
        const w = sharedWorkspacesData.value?.workspaces?.find(
          (x) => x.id === wsId,
        );
        if (w) {
          w.availability = "available";
          w.lease = null;
        }
      },
      () =>
        apiFetch("/api/shared-workspaces/release", {
          method: "POST",
          body: JSON.stringify({ workspaceId: wsId, owner: sharedOwner }),
        }),
      () => {
        sharedWorkspacesData.value = prev;
      },
    ).catch(() => {});
    scheduleRefresh(120);
  };

  return html`
    <${Collapsible} title="Worktrees" defaultOpen=${true}>
      <${Card}>
        <div class="stats-grid mb-md">
          <${StatCard} value=${wStats.total ?? wts.length} label="Total" />
          <${StatCard}
            value=${wStats.active ?? 0}
            label="Active"
            color="var(--color-done)"
          />
          <${StatCard}
            value=${wStats.stale ?? 0}
            label="Stale"
            color="var(--color-inreview)"
          />
        </div>
        <div class="input-row mb-md">
          <input
            class="input"
            placeholder="Task key or branch"
            value=${releaseInput}
            onInput=${(e) => setReleaseInput(e.target.value)}
          />
          <button
            class="btn btn-secondary btn-sm"
            onClick=${handleReleaseInput}
          >
            Release
          </button>
          <button class="btn btn-danger btn-sm" onClick=${handlePrune}>
            Prune
          </button>
        </div>
        ${wts.map((wt) => {
          const ageMin = Math.round((wt.age || 0) / 60000);
          const ageStr =
            ageMin >= 60 ? `${Math.round(ageMin / 60)}h` : `${ageMin}m`;
          return html`
            <div key=${wt.branch || wt.path} class="task-card">
              <div class="task-card-header">
                <div>
                  <div class="task-card-title">
                    ${wt.branch || "(detached)"}
                  </div>
                  <div class="task-card-meta">${wt.path}</div>
                </div>
                <${Badge}
                  status=${wt.status || "active"}
                  text=${wt.status || "active"}
                />
              </div>
              <div class="meta-text">
                Age
                ${ageStr}${wt.taskKey ? ` · ${wt.taskKey}` : ""}${wt.owner
                  ? ` · Owner ${wt.owner}`
                  : ""}
              </div>
              <div class="btn-row mt-sm">
                ${wt.taskKey &&
                html`<button
                  class="btn btn-ghost btn-sm"
                  onClick=${() => handleRelease(wt.taskKey, "")}
                >
                  Release Key
                </button>`}
                ${wt.branch &&
                html`<button
                  class="btn btn-ghost btn-sm"
                  onClick=${() => handleRelease("", wt.branch)}
                >
                  Release Branch
                </button>`}
              </div>
            </div>
          `;
        })}
        ${!wts.length &&
        html`<div class="meta-text">No worktrees tracked.</div>`}
      <//>
    <//>

    <${Collapsible} title="Shared Workspaces" defaultOpen=${true}>
      <${Card}>
        <div class="chip-group mb-sm">
          ${Object.entries(availability).map(
            ([k, v]) => html`<span key=${k} class="pill">${k}: ${v}</span>`,
          )}
          ${!Object.keys(availability).length &&
          html`<span class="pill">No registry</span>`}
        </div>
        <div class="input-row mb-sm">
          <input
            class="input"
            placeholder="Owner"
            value=${sharedOwner}
            onInput=${(e) => setSharedOwner(e.target.value)}
          />
          <input
            class="input"
            type="number"
            min="30"
            step="15"
            placeholder="TTL (min)"
            value=${sharedTtl}
            onInput=${(e) => setSharedTtl(e.target.value)}
          />
        </div>
        <input
          class="input mb-md"
          placeholder="Note (optional)"
          value=${sharedNote}
          onInput=${(e) => setSharedNote(e.target.value)}
        />
        ${workspaces.map((ws) => {
          const lease = ws.lease;
          const leaseInfo = lease
            ? `Leased to ${lease.owner} until ${new Date(lease.lease_expires_at).toLocaleString()}`
            : "Available";
          return html`
            <div key=${ws.id} class="task-card">
              <div class="task-card-header">
                <div>
                  <div class="task-card-title">${ws.name || ws.id}</div>
                  <div class="task-card-meta">
                    ${ws.provider || "provider"} · ${ws.region || "region?"}
                  </div>
                </div>
                <${Badge} status=${ws.availability} text=${ws.availability} />
              </div>
              <div class="meta-text">${leaseInfo}</div>
              <div class="btn-row mt-sm">
                <button
                  class="btn btn-primary btn-sm"
                  onClick=${() => handleClaim(ws.id)}
                >
                  Claim
                </button>
                <button
                  class="btn btn-secondary btn-sm"
                  onClick=${() => handleRenew(ws.id)}
                >
                  Renew
                </button>
                <button
                  class="btn btn-ghost btn-sm"
                  onClick=${() => handleSharedRelease(ws.id)}
                >
                  Release
                </button>
              </div>
            </div>
          `;
        })}
        ${!workspaces.length &&
        html`<div class="meta-text">No shared workspaces configured.</div>`}
      <//>
    <//>

    <${Collapsible} title="Presence" defaultOpen=${true}>
      <${Card}>
        <div class="task-card mb-md">
          <div class="task-card-title">Coordinator</div>
          <div class="meta-text">
            ${coordinator?.instance_label || coordinator?.instance_id || "none"}
            · Priority ${coordinator?.coordinator_priority ?? "—"}
          </div>
        </div>
        ${instances.length
          ? html`
              <div class="stats-grid">
                ${instances.map(
                  (inst, i) => html`
                    <div
                      key=${i}
                      class="stat-card"
                      style="text-align:left;padding:10px"
                    >
                      <div style="font-weight:600;font-size:13px">
                        ${inst.instance_label || inst.instance_id}
                      </div>
                      <div class="meta-text">
                        ${inst.workspace_role || "workspace"} ·
                        ${inst.host || "host"}
                      </div>
                      <div class="meta-text">
                        Last:
                        ${inst.last_seen_at
                          ? new Date(inst.last_seen_at).toLocaleString()
                          : "unknown"}
                      </div>
                    </div>
                  `,
                )}
              </div>
            `
          : html`<div class="meta-text">No active instances.</div>`}
      <//>
    <//>
  `;
}

/* ═══════════════════════════════════════════════
 *  TAB: Control (Executor + Commands + Routing)
 * ═══════════════════════════════════════════════ */
function ControlTab() {
  const executor = executorData.value;
  const execData = executor?.data;
  const mode = executor?.mode || "internal";

  const [commandInput, setCommandInput] = useState("");
  const [startTaskInput, setStartTaskInput] = useState("");
  const [retryInput, setRetryInput] = useState("");
  const [askInput, setAskInput] = useState("");
  const [steerInput, setSteerInput] = useState("");
  const [shellInput, setShellInput] = useState("");
  const [gitInput, setGitInput] = useState("");
  const [maxParallel, setMaxParallel] = useState(execData?.maxParallel ?? 0);

  const handlePause = async () => {
    haptic("medium");
    const prev = cloneValue(executor);
    await runOptimistic(
      () => {
        if (executorData.value)
          executorData.value = { ...executorData.value, paused: true };
      },
      () => apiFetch("/api/executor/pause", { method: "POST" }),
      () => {
        executorData.value = prev;
      },
    ).catch(() => {});
    scheduleRefresh(120);
  };

  const handleResume = async () => {
    haptic("medium");
    const prev = cloneValue(executor);
    await runOptimistic(
      () => {
        if (executorData.value)
          executorData.value = { ...executorData.value, paused: false };
      },
      () => apiFetch("/api/executor/resume", { method: "POST" }),
      () => {
        executorData.value = prev;
      },
    ).catch(() => {});
    scheduleRefresh(120);
  };

  const handleMaxParallel = async (value) => {
    setMaxParallel(value);
    haptic();
    const prev = cloneValue(executor);
    await runOptimistic(
      () => {
        if (executorData.value?.data)
          executorData.value.data.maxParallel = value;
      },
      () =>
        apiFetch("/api/executor/maxparallel", {
          method: "POST",
          body: JSON.stringify({ value }),
        }),
      () => {
        executorData.value = prev;
      },
    ).catch(() => {});
    scheduleRefresh(120);
  };

  return html`
    <${Card} title="Executor Controls">
      <div class="meta-text mb-sm">
        Mode: ${mode} · Slots:
        ${execData?.activeSlots ?? 0}/${execData?.maxParallel ?? "—"} · Paused:
        ${executor?.paused ? "Yes" : "No"}
      </div>
      <div class="meta-text mb-sm">
        Poll:
        ${execData?.pollIntervalMs ? execData.pollIntervalMs / 1000 : "—"}s ·
        Timeout:
        ${execData?.taskTimeoutMs
          ? Math.round(execData.taskTimeoutMs / 60000)
          : "—"}m
      </div>
      <div class="range-row mb-md">
        <input
          type="range"
          min="0"
          max="20"
          step="1"
          value=${maxParallel}
          onInput=${(e) => setMaxParallel(Number(e.target.value))}
          onChange=${(e) => handleMaxParallel(Number(e.target.value))}
        />
        <span class="pill">Max ${maxParallel}</span>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary btn-sm" onClick=${handlePause}>
          Pause
        </button>
        <button class="btn btn-secondary btn-sm" onClick=${handleResume}>
          Resume
        </button>
        <button
          class="btn btn-ghost btn-sm"
          onClick=${() => sendCommandToChat("/executor")}
        >
          /executor
        </button>
      </div>
    <//>

    <${Card} title="Command Console">
      <div class="input-row mb-sm">
        <input
          class="input"
          placeholder="/status"
          value=${commandInput}
          onInput=${(e) => setCommandInput(e.target.value)}
          onKeyDown=${(e) => {
            if (e.key === "Enter" && commandInput.trim()) {
              sendCommandToChat(commandInput.trim());
              setCommandInput("");
            }
          }}
        />
        <button
          class="btn btn-primary btn-sm"
          onClick=${() => {
            if (commandInput.trim()) {
              sendCommandToChat(commandInput.trim());
              setCommandInput("");
            }
          }}
        >
          ${ICONS.send}
        </button>
      </div>
      <div class="btn-row">
        <button
          class="btn btn-ghost btn-sm"
          onClick=${() => sendCommandToChat("/status")}
        >
          /status
        </button>
        <button
          class="btn btn-ghost btn-sm"
          onClick=${() => sendCommandToChat("/health")}
        >
          /health
        </button>
        <button
          class="btn btn-ghost btn-sm"
          onClick=${() => sendCommandToChat("/menu")}
        >
          /menu
        </button>
        <button
          class="btn btn-ghost btn-sm"
          onClick=${() => sendCommandToChat("/helpfull")}
        >
          /helpfull
        </button>
      </div>
    <//>

    <${Card} title="Task Ops">
      <div class="input-row mb-sm">
        <input
          class="input"
          placeholder="Task ID"
          value=${startTaskInput}
          onInput=${(e) => setStartTaskInput(e.target.value)}
        />
        <button
          class="btn btn-secondary btn-sm"
          onClick=${() => {
            if (startTaskInput.trim())
              sendCommandToChat(`/starttask ${startTaskInput.trim()}`);
          }}
        >
          Start
        </button>
      </div>
      <div class="input-row">
        <input
          class="input"
          placeholder="Retry reason"
          value=${retryInput}
          onInput=${(e) => setRetryInput(e.target.value)}
        />
        <button
          class="btn btn-secondary btn-sm"
          onClick=${() =>
            sendCommandToChat(
              retryInput.trim() ? `/retry ${retryInput.trim()}` : "/retry",
            )}
        >
          Retry
        </button>
        <button
          class="btn btn-ghost btn-sm"
          onClick=${() => sendCommandToChat("/plan")}
        >
          Plan
        </button>
      </div>
    <//>

    <${Card} title="Agent Control">
      <textarea
        class="input mb-sm"
        rows="2"
        placeholder="Ask the agent..."
        value=${askInput}
        onInput=${(e) => setAskInput(e.target.value)}
      ></textarea>
      <div class="btn-row mb-md">
        <button
          class="btn btn-primary btn-sm"
          onClick=${() => {
            if (askInput.trim()) {
              sendCommandToChat(`/ask ${askInput.trim()}`);
              setAskInput("");
            }
          }}
        >
          Ask
        </button>
      </div>
      <div class="input-row">
        <input
          class="input"
          placeholder="Steer prompt (focus on...)"
          value=${steerInput}
          onInput=${(e) => setSteerInput(e.target.value)}
        />
        <button
          class="btn btn-secondary btn-sm"
          onClick=${() => {
            if (steerInput.trim()) {
              sendCommandToChat(`/steer ${steerInput.trim()}`);
              setSteerInput("");
            }
          }}
        >
          Steer
        </button>
      </div>
    <//>

    <${Card} title="Routing">
      <div class="card-subtitle">SDK</div>
      <${SegmentedControl}
        options=${[
          { value: "codex", label: "Codex" },
          { value: "copilot", label: "Copilot" },
          { value: "claude", label: "Claude" },
          { value: "auto", label: "Auto" },
        ]}
        value=""
        onChange=${(v) => sendCommandToChat(`/sdk ${v}`)}
      />
      <div class="card-subtitle mt-sm">Kanban</div>
      <${SegmentedControl}
        options=${[
          { value: "internal", label: "Internal" },
          { value: "github", label: "GitHub" },
          { value: "jira", label: "Jira" },
        ]}
        value=""
        onChange=${(v) => sendCommandToChat(`/kanban ${v}`)}
      />
      <div class="card-subtitle mt-sm">Region</div>
      <${SegmentedControl}
        options=${[
          { value: "us", label: "US" },
          { value: "sweden", label: "Sweden" },
          { value: "auto", label: "Auto" },
        ]}
        value=""
        onChange=${(v) => sendCommandToChat(`/region ${v}`)}
      />
    <//>

    <${Card} title="Shell / Git">
      <div class="input-row mb-sm">
        <input
          class="input"
          placeholder="ls -la"
          value=${shellInput}
          onInput=${(e) => setShellInput(e.target.value)}
        />
        <button
          class="btn btn-secondary btn-sm"
          onClick=${() =>
            sendCommandToChat(`/shell ${shellInput.trim()}`.trim())}
        >
          Shell
        </button>
      </div>
      <div class="input-row">
        <input
          class="input"
          placeholder="status --short"
          value=${gitInput}
          onInput=${(e) => setGitInput(e.target.value)}
        />
        <button
          class="btn btn-secondary btn-sm"
          onClick=${() => sendCommandToChat(`/git ${gitInput.trim()}`.trim())}
        >
          Git
        </button>
      </div>
    <//>
  `;
}

/* ═══════════════════════════════════════════════
 *  TAB: Logs (System Logs + Agent Log Library)
 * ═══════════════════════════════════════════════ */
function LogsTab() {
  const logRef = useRef(null);
  const [localLogLines, setLocalLogLines] = useState(logsLines.value);
  const [localAgentLines, setLocalAgentLines] = useState(agentLogLines.value);
  const [contextQuery, setContextQuery] = useState("");

  const logText = logsData.value?.lines
    ? logsData.value.lines.join("\n")
    : "No logs yet.";
  const tailText = agentLogTail.value?.lines
    ? agentLogTail.value.lines.join("\n")
    : "Select a log file.";

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logText]);

  const handleLogLinesChange = async (value) => {
    setLocalLogLines(value);
    logsLines.value = value;
    await loadLogs();
  };

  const handleAgentSearch = async () => {
    agentLogFile.value = "";
    await loadAgentLogFileList();
    await loadAgentLogTailData();
  };

  const handleAgentOpen = async (name) => {
    agentLogFile.value = name;
    await loadAgentLogTailData();
  };

  const handleAgentLinesChange = async (value) => {
    setLocalAgentLines(value);
    agentLogLines.value = value;
    await loadAgentLogTailData();
  };

  const handleContextLoad = async () => {
    await loadAgentContextData(contextQuery.trim());
  };

  return html`
    <${Card} title="System Logs">
      <div class="range-row mb-sm">
        <input
          type="range"
          min="20"
          max="800"
          step="20"
          value=${localLogLines}
          onInput=${(e) => setLocalLogLines(Number(e.target.value))}
          onChange=${(e) => handleLogLinesChange(Number(e.target.value))}
        />
        <span class="pill">${localLogLines} lines</span>
      </div>
      <div class="chip-group mb-sm">
        ${[50, 200, 500].map(
          (n) => html`
            <button
              key=${n}
              class="chip ${logsLines.value === n ? "active" : ""}"
              onClick=${() => handleLogLinesChange(n)}
            >
              ${n}
            </button>
          `,
        )}
      </div>
      <div ref=${logRef} class="log-box">${logText}</div>
      <div class="btn-row mt-sm">
        <button
          class="btn btn-ghost btn-sm"
          onClick=${() => sendCommandToChat(`/logs ${logsLines.value}`)}
        >
          /logs to chat
        </button>
      </div>
    <//>

    <${Card} title="Agent Log Library">
      <div class="input-row mb-sm">
        <input
          class="input"
          placeholder="Search log files"
          value=${agentLogQuery.value}
          onInput=${(e) => {
            agentLogQuery.value = e.target.value;
          }}
        />
        <button class="btn btn-secondary btn-sm" onClick=${handleAgentSearch}>
          Search
        </button>
      </div>
      <div class="range-row mb-md">
        <input
          type="range"
          min="50"
          max="800"
          step="50"
          value=${localAgentLines}
          onInput=${(e) => setLocalAgentLines(Number(e.target.value))}
          onChange=${(e) => handleAgentLinesChange(Number(e.target.value))}
        />
        <span class="pill">${localAgentLines} lines</span>
      </div>
    <//>

    <${Card} title="Log Files">
      ${agentLogFiles.value.length
        ? agentLogFiles.value.map(
            (file) => html`
              <div
                key=${file.name}
                class="task-card"
                onClick=${() => handleAgentOpen(file.name)}
              >
                <div class="task-card-header">
                  <div>
                    <div class="task-card-title">${file.name}</div>
                    <div class="task-card-meta">
                      ${Math.round(file.size / 1024)}kb ·
                      ${new Date(file.mtime).toLocaleString()}
                    </div>
                  </div>
                  <${Badge} status="log" text="log" />
                </div>
              </div>
            `,
          )
        : html`<div class="meta-text">No log files found.</div>`}
    <//>

    <${Card} title=${agentLogFile.value || "Log Tail"}>
      ${agentLogTail.value?.truncated &&
      html`<span class="pill mb-sm">Tail clipped</span>`}
      <div class="log-box">${tailText}</div>
    <//>

    <${Card} title="Worktree Context">
      <div class="input-row mb-sm">
        <input
          class="input"
          placeholder="Branch fragment"
          value=${contextQuery}
          onInput=${(e) => setContextQuery(e.target.value)}
        />
        <button class="btn btn-secondary btn-sm" onClick=${handleContextLoad}>
          Load
        </button>
      </div>
      <div class="log-box">
        ${agentContext.value
          ? [
              `Worktree: ${agentContext.value.name || "?"}`,
              "",
              agentContext.value.gitLog || "No git log.",
              "",
              agentContext.value.gitStatus || "Clean worktree.",
              "",
              agentContext.value.diffStat || "No diff stat.",
            ].join("\n")
          : "Load a worktree context to view git log/status."}
      </div>
    <//>

    <${Card} title="Git Snapshot">
      <div class="btn-row mb-sm">
        <button
          class="btn btn-secondary btn-sm"
          onClick=${async () => {
            await loadGit();
            haptic();
          }}
        >
          ${ICONS.refresh} Refresh
        </button>
        <button
          class="btn btn-ghost btn-sm"
          onClick=${() => sendCommandToChat("/diff")}
        >
          /diff
        </button>
      </div>
      <div class="log-box mb-md">${gitDiff.value || "Clean working tree."}</div>
      <div class="card-subtitle">Recent Branches</div>
      ${gitBranches.value.length
        ? gitBranches.value.map(
            (line, i) => html`<div key=${i} class="meta-text">${line}</div>`,
          )
        : html`<div class="meta-text">No branches found.</div>`}
    <//>
  `;
}

/* ═══════════════════════════════════════════════
 *  Header + BottomNav + App Root
 * ═══════════════════════════════════════════════ */
function Header() {
  const isConn = connected.value;
  return html`
    <header class="app-header">
      <div class="app-header-brand">
        <img src="/logo.png" alt="Bosun" class="app-logo-img" />
        <div class="app-header-title">Bosun</div>
      </div>
      <div class="connection-pill ${isConn ? "connected" : "disconnected"}">
        <span class="connection-dot"></span>
        ${isConn ? "Live" : "Offline"}
      </div>
    </header>
  `;
}

function BottomNav() {
  const tabs = [
    { id: "dashboard", label: "Home", icon: ICONS.grid },
    { id: "tasks", label: "Tasks", icon: ICONS.check },
    { id: "agents", label: "Agents", icon: ICONS.cpu },
    { id: "infra", label: "Infra", icon: ICONS.server },
    { id: "control", label: "Control", icon: ICONS.sliders },
    { id: "logs", label: "Logs", icon: ICONS.terminal },
  ];

  const handleSwitch = async (tab) => {
    if (activeTab.value === tab) return;
    haptic();
    activeTab.value = tab;
    switchWsChannel(tab);
    // Hide Telegram BackButton on main tabs
    const tg = getTg();
    if (tg?.BackButton) tg.BackButton.hide();
    await refreshTab();
  };

  return html`
    <nav class="bottom-nav">
      ${tabs.map(
        (t) => html`
          <button
            key=${t.id}
            class="nav-item ${activeTab.value === t.id ? "active" : ""}"
            onClick=${() => handleSwitch(t.id)}
          >
            ${t.icon}
            <span class="nav-label">${t.label}</span>
          </button>
        `,
      )}
    </nav>
  `;
}

function App() {
  useEffect(() => {
    const tg = getTg();
    applyTgTheme();
    if (tg) {
      tg.expand();
      tg.ready();
      connected.value = true;
    }
    refreshTab();
    connectRealtime();

    return () => {
      try {
        ws?.close();
      } catch {
        /* noop */
      }
      if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
      if (wsRefreshTimer) clearTimeout(wsRefreshTimer);
    };
  }, []);

  const tab = activeTab.value;

  return html`
    <${ToastContainer} />
    <${Header} />
    <${PullToRefresh} onRefresh=${refreshTab}>
      ${tab === "dashboard" && html`<${DashboardTab} />`}
      ${tab === "tasks" && html`<${TasksTab} />`}
      ${tab === "agents" && html`<${AgentsTab} />`}
      ${tab === "infra" && html`<${InfraTab} />`}
      ${tab === "control" && html`<${ControlTab} />`}
      ${tab === "logs" && html`<${LogsTab} />`}
    <//>
    <${BottomNav} />
  `;
}

/* ─── Mount ─── */
preactRender(html`<${App} />`, document.getElementById("app"));
