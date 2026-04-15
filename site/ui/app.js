/* VirtEngine Control Center – Preact + HTM Entry Point
 *  Modular SPA for Telegram Mini App (no build step)
 */

// Error telemetry ring buffer (max 50 entries, persisted to sessionStorage) ──
const MAX_ERROR_LOG = 50;
function getErrorLog() {
  try { return JSON.parse(sessionStorage.getItem("ve_error_log") || "[]"); } catch { return []; }
}


function clampPanelLayoutValue(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function getStoredPanelLayout(storage = globalThis?.localStorage) {
  const readNumber = (key) => Number(storage?.getItem?.(key));
  const readBool = (key) => storage?.getItem?.(key) === "true";
  return {
    sidebarWidth: clampPanelLayoutValue(readNumber("ve-sidebar-width"), DESKTOP_MIN_SIDEBAR_WIDTH, DESKTOP_MAX_SIDEBAR_WIDTH, DEFAULT_SIDEBAR_WIDTH),
    railWidth: clampPanelLayoutValue(readNumber("ve-rail-width"), RAIL_ICON_WIDTH, 440, DEFAULT_RAIL_WIDTH),
    inspectorWidth: clampPanelLayoutValue(readNumber("ve-inspector-width"), 260, 440, DEFAULT_INSPECTOR_WIDTH),
    sidebarCollapsed: readBool("ve-sidebar-collapsed"),
    railCollapsed: readBool("ve-rail-collapsed"),
    inspectorCollapsed: readBool("ve-inspector-collapsed"),
  };
}
function appendErrorLog(entry) {
  try {
    const log = getErrorLog();
    log.unshift({ ...entry, ts: Date.now() });
    if (log.length > MAX_ERROR_LOG) log.length = MAX_ERROR_LOG;
    sessionStorage.setItem("ve_error_log", JSON.stringify(log));
  } catch { /* quota exceeded */ }
}

function maybeRemountUi(message) {
  if (!/insertBefore/i.test(message || "")) return;
  const remount = globalThis.__veRemountApp;
  if (typeof remount === "function") {
    console.warn("[ve] attempting UI remount after render error");
    remount();
  }
}

/* ── Global error handlers — catch unhandled errors before they freeze the UI ── */
globalThis.addEventListener?.("error", (e) => {
  console.error("[ve:global-error]", e.error || e.message);
  appendErrorLog({ type: "global", message: e.message, stack: e.error?.stack });
  maybeRemountUi(e?.message || e?.error?.message || "");
});
globalThis.addEventListener?.("unhandledrejection", (e) => {
  const reason = e?.reason;
  const message = String(reason?.message || reason || "");
  if (/WebAppMethodUnsupported/i.test(message)) {
    e.preventDefault?.();
    return;
  }
  console.error("[ve:unhandled-rejection]", e.reason);
  appendErrorLog({ type: "rejection", message: String(e.reason?.message || e.reason) });
  maybeRemountUi(message);
});

import { h as _h, render as preactRender, Component, options as _preactOptions, Fragment as _PreactFragment } from "preact";
import { useState, useEffect, useCallback, useRef } from "preact/hooks";
import { signal } from "@preact/signals";
import htm from "htm";

// Wrap h() to guard against Array/invalid types reaching createElementNS
function normalizeRenderableType(type) {
  if (Array.isArray(type)) return _PreactFragment;
  if (type != null && typeof type === "object" && typeof type !== "function") {
    if (typeof type.render === "function") return type.render;
    return null;
  }
  return type;
}

function h(type, props, ...rest) {
  if (Array.isArray(type)) {
    return _h(_PreactFragment, props, ...type, ...rest);
  }
  const normalizedType = normalizeRenderableType(type);
  if (normalizedType == null) {
    console.warn("[h-guard] Invalid object passed as element type — rendering empty Fragment", type);
    return _h(_PreactFragment, props, ...rest);
  }
  return _h(normalizedType, props, ...rest);
}
const html = htm.bind(h);

// Guard: catch invalid VNode types before they hit createElementNS.
// An array type causes "Failed to execute 'createElementNS': invalid character '['".
// An object type causes "createElementNS: The qualified name provided ('[object Object]')".
(function installVnodeTypeGuard() {
  const prev = _preactOptions.vnode;
  _preactOptions.vnode = (vnode) => {
    if (Array.isArray(vnode.type)) {
      vnode.props = { children: vnode.type };
      vnode.type = _PreactFragment;
    } else if (vnode.type != null && typeof vnode.type === "object" && typeof vnode.type !== "function") {
      const normalizedType = normalizeRenderableType(vnode.type);
      if (normalizedType == null) {
        console.warn("[vnode-guard] Invalid object used as element type — converting to Fragment", vnode.type);
        vnode.type = _PreactFragment;
      } else {
        vnode.type = normalizedType;
      }
    }
    if (prev) prev(vnode);
  };
})();

// ── Visibility-aware polling ──
// Pauses or slows intervals 10× when tab is hidden; resumes immediately on focus.
const _pageVisible = signal(!document.hidden);
document.addEventListener("visibilitychange", () => { _pageVisible.value = !document.hidden; });
function visibilityInterval(fn, activeMs, opts = {}) {
  const hiddenFactor = opts.hiddenFactor || 10;
  let id = null;
  const schedule = () => {
    const ms = _pageVisible.value ? activeMs : activeMs * hiddenFactor;
    id = setTimeout(() => { fn(); schedule(); }, ms);
  };
  schedule();
  const unsub = _pageVisible.subscribe(() => { clearTimeout(id); schedule(); });
  return () => { clearTimeout(id); unsub(); };
}
globalThis.__bosunVisibilityInterval = visibilityInterval;

// Backend health tracking
const backendDown = signal(false);
const backendError = signal("");
const backendLastSeen = signal(null);
const backendRetryCount = signal(0);
const DESKTOP_MIN_WIDTH = 1200;
const WIDE_DESKTOP_MIN_WIDTH = 1400;
const TABLET_MIN_WIDTH = 768;
const COMPACT_NAV_MAX_WIDTH = 520;
const RAIL_ICON_WIDTH = 54;
const SIDEBAR_ICON_WIDTH = 54;
const DEFAULT_SIDEBAR_WIDTH = 240;
const DEFAULT_RAIL_WIDTH = 300;
const DEFAULT_INSPECTOR_WIDTH = 320;
const DESKTOP_MIN_SIDEBAR_WIDTH = 200;
const DESKTOP_MAX_SIDEBAR_WIDTH = 360;
const APP_LOGO_SOURCES = ["/logo.png", "/logo.svg", "/favicon.png"];
const VOICE_LAUNCH_QUERY_KEYS = [
  "launch",
  "call",
  "autostart",
  "sessionId",
  "executor",
  "mode",
  "model",
  "voiceAgentId",
  "vision",
  "source",
  "chat_id",
];
const FLOATING_CALL_STATE_KEY = "ve-floating-call-state";
const FLOATING_CALL_HEARTBEAT_INTERVAL_MS = 15000;
const FLOATING_CALL_STALE_THRESHOLD_MS = FLOATING_CALL_HEARTBEAT_INTERVAL_MS * 3;

function getAppLogoSource(index = 0) {
  const safeIndex = Number.isFinite(index) ? Math.trunc(index) : 0;
  if (safeIndex <= 0) return APP_LOGO_SOURCES[0];
  if (safeIndex >= APP_LOGO_SOURCES.length) {
    return APP_LOGO_SOURCES[APP_LOGO_SOURCES.length - 1];
  }
  return APP_LOGO_SOURCES[safeIndex];
}

function handleAppLogoLoadError(event) {
  const target = event?.currentTarget;
  if (!target) return;

  const currentIndex = Number.parseInt(
    String(target.dataset?.logoFallbackIndex || "0"),
    10,
  );
  const nextIndex = Number.isFinite(currentIndex) ? currentIndex + 1 : 1;
  if (nextIndex >= APP_LOGO_SOURCES.length) return;

  target.dataset.logoFallbackIndex = String(nextIndex);
  target.src = getAppLogoSource(nextIndex);
}

function parseVoiceLaunchFromUrl() {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search || "");
  const launch = String(params.get("launch") || "").trim().toLowerCase();
  if (launch !== "meeting" && launch !== "voice") return null;

  const callRaw = String(params.get("call") || "").trim().toLowerCase();
  const call = callRaw === "video" ? "video" : "voice";
  const explicitVision = String(params.get("vision") || "").trim().toLowerCase();
  const initialVisionSource =
    explicitVision === "camera" || explicitVision === "screen"
      ? explicitVision
      : call === "video"
        ? "camera"
        : null;

  return {
    tab: "chat",
    detail: {
      call,
      initialVisionSource,
      sessionId: String(params.get("sessionId") || "").trim() || null,
      executor: String(params.get("executor") || "").trim() || null,
      mode: String(params.get("mode") || "").trim() || null,
      model: String(params.get("model") || "").trim() || null,
      voiceAgentId: String(params.get("voiceAgentId") || "").trim() || null,
    },
  };
}

function readForcedLayoutMode() {
  if (typeof window === "undefined") return "auto";
  const bootForced = String(window.__bosunForcedLayoutMode || "").trim().toLowerCase();
  if (bootForced === "desktop" || bootForced === "tablet" || bootForced === "mobile" || bootForced === "auto") {
    return bootForced;
  }
  const params = new URLSearchParams(window.location.search || "");
  const requested = String(params.get("layout") || "").trim().toLowerCase();
  if (requested === "desktop" || requested === "tablet" || requested === "mobile" || requested === "auto") {
    return requested;
  }
  const path = String(window.location.pathname || "").toLowerCase();
  if (path.endsWith("/demo.html") || path === "/demo.html") {
    return "desktop";
  }
  return "auto";
}

function resolveLayoutFlags(win, forcedMode = "auto") {
  const width = Number(win?.innerWidth || 0);
  const isWideDesktop = width >= WIDE_DESKTOP_MIN_WIDTH;
  if (!win?.matchMedia) {
    return { isCompactNav: false, isDesktop: false, isTablet: false, isWideDesktop: false };
  }
  if (forcedMode === "desktop") {
    return { isCompactNav: false, isDesktop: true, isTablet: false, isWideDesktop };
  }
  if (forcedMode === "mobile") {
    return { isCompactNav: true, isDesktop: false, isTablet: false, isWideDesktop: false };
  }
  if (forcedMode === "tablet") {
    return { isCompactNav: false, isDesktop: false, isTablet: true, isWideDesktop: false };
  }
  return {
    isCompactNav: win.matchMedia(`(max-width: ${COMPACT_NAV_MAX_WIDTH}px)`).matches,
    isDesktop: win.matchMedia(`(min-width: ${DESKTOP_MIN_WIDTH}px)`).matches,
    isTablet: width >= TABLET_MIN_WIDTH && width < DESKTOP_MIN_WIDTH,
    isWideDesktop,
  };
}

function scrubVoiceLaunchQuery() {
  if (typeof window === "undefined" || !window.history?.replaceState) return;
  const url = new URL(window.location.href);
  let changed = false;
  for (const key of VOICE_LAUNCH_QUERY_KEYS) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (!changed) return;
  const nextPath = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState(window.history.state, "", nextPath || "/");
}

function isFollowWindowFromUrl() {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search || "");
  return params.get("follow") === "1";
}

function sanitizeFollowCall(value) {
  return String(value || "").trim().toLowerCase() === "video" ? "video" : "voice";
}

function buildBrowserFollowUrl(detail = {}) {
  if (typeof window === "undefined") return null;
  const target = new URL(window.location.href);
  target.searchParams.set("follow", "1");
  target.searchParams.set("launch", "voice");
  target.searchParams.set("call", sanitizeFollowCall(detail?.call));
  const sessionId = String(detail?.sessionId || "").trim();
  const executor = String(detail?.executor || "").trim();
  const mode = String(detail?.mode || "").trim();
  const model = String(detail?.model || "").trim();
  const voiceAgentId = String(detail?.voiceAgentId || "").trim();
  const vision = String(detail?.initialVisionSource || "").trim();
  if (sessionId) target.searchParams.set("sessionId", sessionId);
  if (executor) target.searchParams.set("executor", executor);
  if (mode) target.searchParams.set("mode", mode);
  if (model) target.searchParams.set("model", model);
  if (voiceAgentId) target.searchParams.set("voiceAgentId", voiceAgentId);
  if (vision) target.searchParams.set("vision", vision);
  return target.toString();
}

function readFloatingCallState() {
  if (typeof window === "undefined") return { active: false };
  try {
    const raw = localStorage.getItem(FLOATING_CALL_STATE_KEY);
    if (!raw) return { active: false };
    const parsed = JSON.parse(raw);
    return {
      active: parsed?.active === true,
      call: sanitizeFollowCall(parsed?.call),
      sessionId: String(parsed?.sessionId || "").trim() || null,
      executor: String(parsed?.executor || "").trim() || null,
      mode: String(parsed?.mode || "").trim() || null,
      model: String(parsed?.model || "").trim() || null,
      initialVisionSource: (() => {
        const source = String(parsed?.initialVisionSource || "").trim().toLowerCase();
        return source === "camera" || source === "screen" ? source : null;
      })(),
      updatedAt: Number(parsed?.updatedAt || 0) || 0,
    };
  } catch {
    return { active: false };
  }
}

function isFloatingCallStateFresh(state, now = Date.now()) {
  if (state?.active !== true) return false;
  const updatedAt = Number(state?.updatedAt || 0);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return false;
  return now - updatedAt <= FLOATING_CALL_STALE_THRESHOLD_MS;
}

function writeFloatingCallState(nextState) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(
      FLOATING_CALL_STATE_KEY,
      JSON.stringify({
        active: nextState?.active === true,
        call: sanitizeFollowCall(nextState?.call),
        sessionId: String(nextState?.sessionId || "").trim() || null,
        executor: String(nextState?.executor || "").trim() || null,
        mode: String(nextState?.mode || "").trim() || null,
        model: String(nextState?.model || "").trim() || null,
        initialVisionSource: (() => {
          const source = String(nextState?.initialVisionSource || "").trim().toLowerCase();
          return source === "camera" || source === "screen" ? source : null;
        })(),
        updatedAt: Date.now(),
      }),
    );
  } catch {
    // best effort
  }
}

/* ── Module imports ── */
import { ICONS } from "./modules/icons.js";
import { iconText, resolveIcon } from "./modules/icon-utils.js";
import {
  initTelegramApp,
  onThemeChange,
  getTg,
  showSettingsButton,
  getTelegramUser,
  colorScheme,
} from "./modules/telegram.js";
import {
  apiFetch,
  connectWebSocket,
  disconnectWebSocket,
  wsLatency,
  wsReconnectIn,
  wsConnected,
  wsReconnectCount,
  wsStatus,
  wsLastReconnectAt,
  loadingCount,
} from "./modules/api.js";
import {
  connected,
  statusData,
  executorData,
  tasksData,
  agentsData,
  refreshTab,
  initWsInvalidationListener,
  loadNotificationPrefs,
  applyStoredDefaults,
  dataFreshness,
  hasPendingChanges,
} from "./modules/state.js";
import {
  activeTab,
  navigateTo,
  shouldBlockTabSwipe,
  TAB_CONFIG,
} from "./modules/router.js";
import { formatRelative } from "./modules/utils.js";
import {
  buildSessionApiPath,
  shouldFallbackToAllSessions,
  getSessionLifecycleState,
  getSessionRecencyTimestamp,
  getSessionRuntimeState,
  resolveSessionWorkspaceHint,
} from "./modules/session-api.js";
import { buildSessionInsights, formatCompactCount } from "./modules/session-insights.js";
import { VeTheme, CssBaseline, AppBar, Toolbar, Tabs, Tab, Drawer, Box, IconButton, Typography, Chip, Badge, BottomNavigation, BottomNavigationAction, Tooltip, Avatar, Stack, Paper, CircularProgress, Button, Divider, Menu, MenuItem, Fab, Snackbar, Alert } from "./modules/mui.js";

/* ── Component imports ── */
import { ToastContainer, Modal } from "./components/shared.js";
import { PullToRefresh } from "./components/forms.js";
import {
  SessionList,
  loadSessions,
  createSession,
  selectedSessionId,
  sessionsData,
  initSessionWsListener,
} from "./components/session-list.js";
import {
  activeAgent,
  agentMode,
  selectedModel,
} from "./components/agent-selector.js";
import { WorkspaceSwitcher } from "./components/workspace-switcher.js";
import { DiffViewer } from "./components/diff-viewer.js";
import {
  CommandPalette,
  useCommandPalette,
} from "./components/command-palette.js";
import { VoiceOverlay } from "./modules/voice-overlay.js";

/* ── Tab imports (eager — loaded with app.js) ── */
import { DashboardTab } from "./tabs/dashboard.js";
import { ChatTab } from "./tabs/chat.js";

/* ── Lazy tab loading ── */
const _lazyTabCache = {};
const _lazyTabInflight = {};

function resolveLazyTabComponent(mod, exportName) {
  const direct = exportName ? mod?.[exportName] : mod?.default;
  const fallback = Object.values(mod || {}).find((value) => normalizeRenderableType(value) != null);
  const resolved = normalizeRenderableType(direct) != null ? direct : fallback;
  if (normalizeRenderableType(resolved) == null) {
    const available = Object.keys(mod || {}).join(", ") || "<none>";
    throw new Error(`Lazy tab module did not export a renderable component for ${exportName || "default"}. Available exports: ${available}`);
  }
  return resolved;
}

function LazyTab({ loader, fallback, ...props }) {
  const [Comp, setComp] = useState(_lazyTabCache[loader.key] || null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    setErr(null);
    if (_lazyTabCache[loader.key]) {
      setComp(() => _lazyTabCache[loader.key]);
      return;
    }
    let cancelled = false;
    const pendingLoad = _lazyTabInflight[loader.key]
      || loader()
        .then((mod) => {
          const C = resolveLazyTabComponent(mod, loader.exportName);
          _lazyTabCache[loader.key] = C;
          return C;
        })
        .finally(() => {
          delete _lazyTabInflight[loader.key];
        });
    _lazyTabInflight[loader.key] = pendingLoad;

    pendingLoad
      .then((resolvedComp) => {
        if (!cancelled) setComp(() => resolvedComp);
      })
      .catch((e) => {
        if (!cancelled) {
          setComp(null);
          setErr(e);
        }
      });
    return () => { cancelled = true; };
  }, [loader]);
  if (err) return html`<div style="padding:2rem;color:#ef4444">Failed to load tab: ${err.message}</div>`;
  if (!Comp) return fallback || html`<div style="display:flex;justify-content:center;padding:3rem"><${CircularProgress} /></div>`;
  return html`<${Comp} ...${props} />`;
}
function lazyTab(tabPath, exportName, nativeLoader) {
  const loader = () => {
    const importPromise =
      window.__bosunNeedsImportShim && typeof window.importShim === "function"
        ? window.importShim(tabPath)
        : nativeLoader();
    return importPromise;
  };
  loader.key = `${tabPath}::${exportName || "default"}`;
  loader.exportName = exportName || "default";
  return (props) => html`<${LazyTab} loader=${loader} ...${props} />`;
}

/* ── Lazy tab definitions ── */
const TasksTab = lazyTab("./tabs/tasks.js", "TasksTab", () => import("./tabs/tasks.js"));
const BenchmarksTab = lazyTab("./tabs/benchmarks.js", "BenchmarksTab", () => import("./tabs/benchmarks.js"));
const AgentsTab = lazyTab("./tabs/agents.js", "AgentsTab", () => import("./tabs/agents.js"));
const FleetSessionsTab = lazyTab("./tabs/agents.js", "FleetSessionsTab", () => import("./tabs/agents.js"));
const InfraTab = lazyTab("./tabs/infra.js", "InfraTab", () => import("./tabs/infra.js"));
const GuardrailsTab = lazyTab("./tabs/guardrails.js", "GuardrailsTab", () => import("./tabs/guardrails.js"));
const ControlTab = lazyTab("./tabs/control.js", "ControlTab", () => import("./tabs/control.js"));
const LogsTab = lazyTab("./tabs/logs.js", "LogsTab", () => import("./tabs/logs.js"));
const TelemetryTab = lazyTab("./tabs/telemetry.js", "TelemetryTab", () => import("./tabs/telemetry.js"));
const SettingsTab = lazyTab("./tabs/settings.js", "SettingsTab", () => import("./tabs/settings.js"));
const IntegrationsTab = lazyTab("./tabs/integrations.js", "IntegrationsTab", () => import("./tabs/integrations.js"));
const WorkflowsTab = lazyTab("./tabs/workflows.js", "WorkflowsTab", () => import("./tabs/workflows.js"));
const LibraryTab = lazyTab("./tabs/library.js", "LibraryTab", () => import("./tabs/library.js"));
const LibraryMarketplaceTab = lazyTab("./tabs/library.js", "LibraryMarketplaceTab", () => import("./tabs/library.js"));
const ManualFlowsTab = lazyTab("./tabs/manual-flows.js", "ManualFlowsTab", () => import("./tabs/manual-flows.js"));
const ContextCompressionLabTab = lazyTab("./tabs/context-compression-lab.js", "ContextCompressionLabTab", () => import("./tabs/context-compression-lab.js"));

/* ── Shared components ── */

/**
 * AnimatedNumber — smoothly counts from previous to new value using rAF.
 */
function AnimatedNumber({ value, duration = 600, className = "" }) {
  const displayRef = useRef(value);
  const rafRef = useRef(null);
  const [display, setDisplay] = useState(value);

  useEffect(() => {
    const from = displayRef.current;
    const to = value;
    if (from === to) return;
    const start = performance.now();
    const animate = (now) => {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3); // ease out cubic
      const current = Math.round(from + (to - from) * eased);
      displayRef.current = current;
      setDisplay(current);
      if (t < 1) rafRef.current = requestAnimationFrame(animate);
    };
    rafRef.current = requestAnimationFrame(animate);
    return () => rafRef.current && cancelAnimationFrame(rafRef.current);
  }, [value, duration]);

  return html`<span class="${className}">${display}</span>`;
}

/**
 * KeyboardShortcutsModal — shows available keyboard shortcuts.
 */
function KeyboardShortcutsModal({ onClose }) {
  const shortcuts = [
    { key: "1–8", desc: "Switch tabs" },
    { key: "c",   desc: "Create task (on Dashboard)" },
    { key: "?",   desc: "Show keyboard shortcuts" },
    { key: "Esc", desc: "Close modal / palette" },
  ];
  return html`
    <${Modal} title="Keyboard Shortcuts" onClose=${onClose}>
      <div class="shortcuts-list">
        ${shortcuts.map((s) => html`
          <div class="shortcut-item" key=${s.key}>
            <kbd class="shortcut-key">${s.key}</kbd>
            <span class="shortcut-desc">${s.desc}</span>
          </div>
        `)}
      </div>
    <//>  
  `;
}

/* ── Backend health helpers ── */

function formatTimeAgo(ts) {
  return formatRelative(ts);
}

// Inject offline-banner CSS once
if (typeof document !== "undefined" && !document.getElementById("offline-banner-styles")) {
  const style = document.createElement("style");
  style.id = "offline-banner-styles";
  style.textContent = `
.offline-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  margin: 8px 16px;
  border: 1px solid rgba(239, 68, 68, 0.2);
  border-radius: 14px;
  box-shadow: var(--shadow-sm);
  backdrop-filter: blur(6px);
  animation: slideDown 0.3s ease-out;
  transition: background 0.4s ease, border-color 0.4s ease;
}
.offline-banner.tone-orange {
  background: rgba(249, 115, 22, 0.08);
  border-color: rgba(249, 115, 22, 0.25);
}
.offline-banner.tone-red {
  background: rgba(239, 68, 68, 0.12);
  border-color: rgba(239, 68, 68, 0.3);
}
.offline-banner-icon { font-size: 20px; }
.offline-banner-content { flex: 1; }
.offline-banner-title { font-weight: 600; font-size: 13px; }
.tone-orange .offline-banner-title { color: #f97316; }
.tone-red .offline-banner-title    { color: #ef4444; }
.offline-banner-meta { font-size: 12px; opacity: 0.7; margin-top: 2px; }
.offline-reconnect-bar {
  height: 2px; border-radius: 2px; margin-top: 6px;
  background: rgba(249,115,22,0.18);
  overflow: hidden;
}
.offline-reconnect-fill {
  height: 100%; border-radius: 2px;
  background: #f97316;
  transition: width 1s linear;
}
.tone-red .offline-reconnect-fill { background: #ef4444; }
.offline-dot {
  width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
  animation: offlinePulse 1.6s ease-in-out infinite;
}
.offline-dot.orange { background: #f97316; }
.offline-dot.red    { background: #ef4444; }
@keyframes offlinePulse {
  0%,100% { opacity:1; transform:scale(1); }
  50%     { opacity:0.5; transform:scale(1.3); }
}
`;
  document.head.appendChild(style);
}

function useBackendHealth() {
  const intervalRef = useRef(null);

  const checkHealth = useCallback(async () => {
    try {
      // Use apiFetch (includes Telegram initData auth header) instead of raw fetch
      const res = await apiFetch("/api/health", { _silent: true });
      if (!res?.ok) throw new Error(res?.error || "Health check failed");
      backendDown.value = false;
      backendError.value = "";
      backendLastSeen.value = Date.now();
      backendRetryCount.value = 0;
    } catch (err) {
      // Only mark as down if WS is also disconnected — WS is the primary
      // connectivity signal; the health check is a fallback.
      if (!wsConnected.value) {
        backendDown.value = true;
        backendError.value = err?.message || "Connection lost";
        backendRetryCount.value = backendRetryCount.value + 1;
      }
    }
  }, []);

  useEffect(() => {
    checkHealth();
    const stop = visibilityInterval(checkHealth, 15000);
    return stop;
  }, [checkHealth]);

  // If WS reconnects, consider backend up
  useEffect(() => {
    if (wsConnected.value && backendDown.value) {
      backendDown.value = false;
      backendError.value = "";
      backendLastSeen.value = Date.now();
      backendRetryCount.value = 0;
    }
  }, [wsConnected.value]);

  return {
    isDown: backendDown.value,
    error: backendError.value,
    lastSeen: backendLastSeen.value,
    retryCount: backendRetryCount.value,
    retry: checkHealth,
  };
}

function OfflineBanner() {
  // Don't call useBackendHealth() here — the App component already runs it.
  // Calling it here caused a mount/unmount oscillation: App health check fails
  // (no auth) → backendDown=true → OfflineBanner mounts → effect corrects it
  // → backendDown=false → unmount → repeat every 10s.
  const manualRetry = useCallback(async () => {
    try {
      const res = await apiFetch("/api/health", { _silent: true });
      if (res?.ok) {
        backendDown.value = false;
        backendError.value = "";
        backendLastSeen.value = Date.now();
        backendRetryCount.value = 0;
      }
    } catch { /* handled by signal */ }
  }, []);

  const retryCount = backendRetryCount.value;
  const isPersistent = retryCount > 3;
  const title = isPersistent
    ? "Persistent connection failure"
    : "Backend Unreachable";

  const countdown = wsReconnectIn.value;

  return html`
    <${Alert}
      severity="error"
      variant="outlined"
      sx=${{m: 1, mx: 2, animation: "slideDown 0.3s ease-out"}}
      action=${html`<${Button} color="inherit" size="small" onClick=${manualRetry}>Retry</${Button}>`}
    >
      <strong>${title}</strong> — ${backendError.value || "Connection lost"}
      ${backendLastSeen.value
        ? html`<${Typography} variant="caption" display="block">Last connected: ${formatTimeAgo(backendLastSeen.value)}</${Typography}>`
        : null}
      <${Typography} variant="caption" display="block">
        ${countdown != null && countdown > 0
          ? `Reconnecting in ${countdown}s…`
          : `Retry attempt #${retryCount}`}
      </${Typography}>
    </${Alert}>
  `;
}

/* ── Error Boundary — catches render errors in child components ── */
class TabErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, showStack: false };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("[TabErrorBoundary] Caught error:", error, info);
    appendErrorLog({ type: "render", tab: this.props.tabName, message: error?.message, stack: error?.stack });
  }
  render() {
    if (this.state.error) {
      const retry = () => this.setState({ error: null, showStack: false });
      const err = this.state.error;
      const tabName = this.props.tabName || "";
      const errorMsg = err?.message || "An unexpected error occurred while rendering this tab.";
      const stack = err?.stack || "";
      const stackToggleLabel = this.state.showStack ? "Hide Stack" : "Stack Trace";
      const copyError = () => {
        const text = `${errorMsg}\n\n${stack}`;
        navigator?.clipboard?.writeText(text).catch(() => {});
      };
      const toggleStack = () => this.setState((s) => ({ showStack: !s.showStack }));
      return html`
        <div class="tab-error-boundary">
          <div class="tab-error-pulse">
            <span style="font-size:20px;color:#ef4444;">${resolveIcon(":alert:")}</span>
          </div>
          <div>
            <div style="font-size:14px;font-weight:600;margin-bottom:4px;color:var(--text-primary);">
              Something went wrong${tabName ? ` in ${tabName}` : ""}
            </div>
            <div style="font-size:12px;color:var(--text-secondary);max-width:400px;">
              ${errorMsg}
            </div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;">
            <${Button} variant="contained" size="small" onClick=${retry}>Retry<//>
            <${Button} variant="text" size="small" onClick=${copyError}>Copy Error<//>
            ${stack ? html`<${Button} variant="text" size="small" onClick=${toggleStack}>
              ${stackToggleLabel}
            <//>` : null}
            <${Button} variant="text" size="small" onClick=${() => {
              console.group("[ve:error-log]");
              getErrorLog().forEach((e, i) => console.log(i, e));
              console.groupEnd();
            }}>Error Log<//>
          </div>
          ${this.state.showStack && stack ? html`
            <div class="tab-error-stack">${stack}</div>
          ` : null}
        </div>
      `;
    }
    return html`<div class="tab-content-enter">${this.props.children}</div>`;
  }
}

/* ── Tab component map ── */
const TAB_COMPONENTS = {
  dashboard: DashboardTab,
  tasks: TasksTab,
  benchmarks: BenchmarksTab,
  chat: ChatTab,
  agents: AgentsTab,
  "fleet-sessions": FleetSessionsTab,
  infra: InfraTab,
  guardrails: GuardrailsTab,
  control: ControlTab,
  logs: LogsTab,
  telemetry: TelemetryTab,
  workflows: WorkflowsTab,
  "manual-flows": ManualFlowsTab,
  "context-compression-lab": ContextCompressionLabTab,
  library: LibraryTab,
  marketplace: LibraryMarketplaceTab,
  settings: SettingsTab,
  integrations: IntegrationsTab,
};

const HIDDEN_TAB_CONFIG = {
  "context-compression-lab": { id: "context-compression-lab", label: "Compression Lab" },
};

function getMaxFreshnessMs(rawFreshness) {
  if (typeof rawFreshness === "number") {
    return Number.isFinite(rawFreshness) ? rawFreshness : null;
  }
  if (rawFreshness && typeof rawFreshness === "object") {
    const vals = Object.values(rawFreshness).filter((v) => Number.isFinite(v));
    return vals.length ? Math.max(...vals) : null;
  }
  return null;
}

function inferUiConnected() {
  const freshness = getMaxFreshnessMs(dataFreshness.value);
  // If data is refreshing successfully, prefer "connected" even when ws
  // lags behind to avoid "Offline" + "Updated 0s ago" contradiction.
  return (
    connected.value ||
    (!backendDown.value &&
      freshness != null &&
      Number.isFinite(freshness) &&
      freshness <= 30_000)
  );
}

/* ═══════════════════════════════════════════════
 *  Header
 * ═══════════════════════════════════════════════ */
function ConnectionBadge() {
  const status = wsStatus.value;
  const reconnectCount = wsReconnectCount.value;
  const lastReconnectAt = wsLastReconnectAt.value;

  let label = "Offline";
  let badgeClass = "offline";
  if (status === "connected") {
    label = "Connected";
    badgeClass = "connected";
  } else if (status === "reconnecting") {
    label = reconnectCount > 0 ? `Reconnecting... ${reconnectCount}` : "Reconnecting...";
    badgeClass = "reconnecting";
  }

  const lastReconnectLabel =
    lastReconnectAt != null
      ? new Date(lastReconnectAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })
      : "never";
  const tooltip = `Connection status: ${label}; last reconnect ${lastReconnectLabel}`;

  return html`
    <div
      class=${`connection-badge ${badgeClass}`}
      title=${tooltip}
      aria-label=${tooltip}
    >
      <span class=${`connection-badge-dot ${badgeClass} ${status === "reconnecting" ? "connection-badge-pulse" : ""}`}></span>
      <span class="connection-badge-label">${label}</span>
    </div>
  `;
}

function Header() {
  const isConn = inferUiConnected();
  const user = getTelegramUser();
  const latency = wsLatency.value;
  const reconnect = wsReconnectIn.value;
  const freshness = getMaxFreshnessMs(dataFreshness.value);
  const activeConfig =
    TAB_CONFIG.find((tab) => tab.id === activeTab.value)
    || HIDDEN_TAB_CONFIG[activeTab.value]
    || TAB_CONFIG[0]
    || { id: "dashboard", label: "Dashboard" };
  const sessionId = selectedSessionId.value;
  const activeSession = (sessionsData.value || []).find((session) => session?.id === sessionId);
  const breadcrumbParts = [activeConfig.label];
  if (activeSession?.title || activeSession?.taskId || activeSession?.id) {
    breadcrumbParts.push(activeSession.title || activeSession.taskId || activeSession.id);
  }
  if (activeSession?.taskId && breadcrumbParts[breadcrumbParts.length - 1] !== activeSession.taskId) {
    breadcrumbParts.push(activeSession.taskId);
  }

  // Connection quality label
  let connLabel = "Offline";
  let connClass = "disconnected";
  if (isConn && latency != null) {
    connLabel = `${latency}ms`;
    connClass = "connected";
  } else if (isConn) {
    connLabel = "Live";
    connClass = "connected";
  } else if (reconnect != null && reconnect > 0) {
    connLabel = `Reconnecting in ${reconnect}s…`;
    connClass = "reconnecting";
  }

  // Freshness label
  let freshnessLabel = "";
  if (freshness != null && Number.isFinite(freshness)) {
    const rel = formatRelative(freshness);
    if (rel && rel !== "—" && !rel.includes("NaN")) {
      freshnessLabel = rel === "just now" ? "Updated just now" : `Updated ${rel}`;
    }
  }

  const logoSrc = getAppLogoSource(0);
  const connColorMap = { connected: "success", reconnecting: "warning" };
  const connColor = connColorMap[connClass] || "error";
  const userLabel = user ? `@${user.username || user.first_name}` : "";
  return html`
    <${AppBar} position="static" elevation=${0} sx=${{zIndex: 10, flexShrink: 0}} className="app-header">
      <${Toolbar} variant="dense" className="app-header-toolbar">
        <img src=${logoSrc} alt="Bosun" style=${{height: 24, width: 24, marginRight: 4}} data-logo-fallback-index="0" onError=${handleAppLogoLoadError} />
        <${Typography} variant="h6" sx=${{ml: 1, flexGrow: 0}}>Bosun</${Typography}>
        <div class="app-breadcrumbs" aria-label="Breadcrumb">
          ${breadcrumbParts.map((part, index) => html`
            <span class="app-breadcrumb-part" key=${`${part}-${index}`}>
              ${index > 0 ? html`<span class="app-breadcrumb-separator" aria-hidden="true">›</span>` : null}
              <span>${part}</span>
            </span>
          `)}
        </div>
        <${Box} sx=${{ml: 2}} className="app-header-workspace">
          <${WorkspaceSwitcher} />
        </${Box}>
        <${Box} sx=${{flexGrow: 1}} />
        <${Stack} direction="row" spacing=${1} alignItems="center" className="app-header-status-stack">
          <${ConnectionBadge} />
          <${Chip}
            size="small"
            label=${connLabel}
            color=${connColor}
            variant="outlined"
            className="app-header-latency-chip"
            sx=${{fontSize: "0.7rem"}}
          />
          ${freshnessLabel
            ? html`<${Typography} variant="caption" className="app-header-freshness" sx=${{opacity: 0.7}}>${freshnessLabel}</${Typography}>`
            : null}
          ${user
            ? html`<${Chip} size="small" label=${userLabel} variant="outlined" className="app-header-user-chip" />`
            : null}
        </${Stack}>
      </${Toolbar}>
    </${AppBar}>
  `;
}

/* ═══════════════════════════════════════════════
 *  Desktop Sidebar + Session Rail
 * ═══════════════════════════════════════════════ */
function SidebarNav({ collapsed = false, onToggle }) {
  const user = getTelegramUser();
  const isConn = inferUiConnected();
  const navRef = useRef(null);

  const collapseIcon = collapsed
    ? html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 3l5 5-5 5"/></svg>`
    : html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 3l-5 5 5 5"/></svg>`;

  const focusSidebarTab = (targetIndex) => {
    const navEl = navRef.current;
    if (!navEl) return;
    const tabEls = Array.from(navEl.querySelectorAll('[role="tab"]'));
    if (tabEls.length === 0) return;
    const nextIndex = Math.max(0, Math.min(tabEls.length - 1, targetIndex));
    tabEls[nextIndex]?.focus();
  };

  const handleSidebarKeyDown = (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const navEl = navRef.current;
    if (!navEl) return;
    const tabEls = Array.from(navEl.querySelectorAll('[role="tab"]'));
    if (tabEls.length === 0) return;
    const activeIndex = tabEls.findIndex((tabEl) => tabEl === document.activeElement);
    if (activeIndex < 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusSidebarTab((activeIndex + 1) % tabEls.length);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusSidebarTab((activeIndex - 1 + tabEls.length) % tabEls.length);
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      focusSidebarTab(0);
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      focusSidebarTab(tabEls.length - 1);
    }
  };

  return html`
    <aside class="sidebar ${collapsed ? 'sidebar-icon-only' : ''}">
      <div class="sidebar-brand-row">
        <div class="sidebar-brand">
          <div class="sidebar-logo">
            <img
              src=${getAppLogoSource(0)}
              alt="Bosun"
              class="app-logo-img"
              data-logo-fallback-index="0"
              onError=${handleAppLogoLoadError}
            />
          </div>
          ${!collapsed && html`<div class="sidebar-title">Bosun</div>`}
        </div>
        <${IconButton}
          size="small"
          class="sidebar-collapse-btn"
          onClick=${onToggle}
          title=${collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label=${collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          ${collapseIcon}
        <//>
      </div>
      ${!collapsed && html`
        <div class="sidebar-actions">
          <${Button} variant="contained" fullWidth onClick=${() => createSession({ type: "primary" })}>
            <span class="btn-icon">${resolveIcon(":plus:")}</span> New Session
          <//>
          <${Button} variant="text" fullWidth onClick=${() => navigateTo("tasks")}>
            <span class="btn-icon">${resolveIcon(":clipboard:")}</span> View Tasks
          <//>
        </div>
      `}
      ${collapsed && html`
        <div class="sidebar-actions-icon">
          <${IconButton}
            size="small"
            class="sidebar-icon-action"
            onClick=${() => createSession({ type: "primary" })}
            title="New Session"
            aria-label="New Session"
          >${resolveIcon(":plus:")}<//>
        </div>
      `}
      <${Tabs}
        ref=${navRef}
        orientation="vertical"
        value=${Math.max(0, TAB_CONFIG.findIndex((t) => t.id === activeTab.value))}
        onChange=${(_, idx) => {
          const tab = TAB_CONFIG[idx];
          if (tab) navigateTo(tab.id, { resetHistory: tab.id === "dashboard", forceRefresh: tab.id === "dashboard" && activeTab.value === "dashboard" });
        }}
        onKeyDown=${handleSidebarKeyDown}
        aria-label="Main navigation"
        aria-orientation="vertical"
        sx=${{
          flexGrow: 1,
          "& .MuiTab-root": { minHeight: 40, justifyContent: collapsed ? "center" : "flex-start", px: collapsed ? 1 : 2 },
          "& .MuiTabs-indicator": { left: 0, right: "auto", width: 3, borderRadius: 2 },
        }}
      >
        ${TAB_CONFIG.map((tab) => {
          let badge = 0;
          if (tab.id === "tasks") badge = getActiveTaskCount();
          else if (tab.id === "agents") badge = getActiveAgentCount();
          const icon = badge > 0
            ? html`<${Badge} badgeContent=${badge} color="primary" max=${99}>${ICONS[tab.icon]}</${Badge}>`
            : ICONS[tab.icon];
          return html`<${Tab}
            key=${tab.id}
            icon=${icon}
            label=${collapsed ? undefined : tab.label}
            iconPosition="start"
            title=${collapsed ? tab.label : undefined}
            sx=${{ minWidth: 0, textAlign: "left", ...(tab.parent ? { pl: collapsed ? 1 : 4, fontSize: "0.75rem" } : {}) }}
          />`;
        })}
      </${Tabs}>
      <div class="sidebar-footer">
        <div class="sidebar-status ${isConn ? "online" : "offline"}" title=${collapsed ? (isConn ? "Connected" : "Offline") : undefined}>
          <span class="sidebar-status-dot"></span>
          ${!collapsed && (isConn ? "Connected" : "Offline")}
        </div>
        ${!collapsed && (user
          ? html`<div class="sidebar-user">@${user.username || user.first_name || "operator"}</div>`
          : html`<div class="sidebar-user">Operator Console</div>`)}
      </div>
    </aside>
  `;
}

function SessionRail({ onResizeStart, onResizeReset, showResizer, collapsed, onCollapse, onExpand, sessionType = "primary" }) {
  const [showArchived, setShowArchived] = useState(false);
  const allSessions = sessionsData.value || [];
  const sessions = filterSessionsByType(allSessions, sessionType);
  const liveRuntimeCount = sessions.filter((s) => getSessionRuntimeState(s).isLive).length;

  if (collapsed) {
    // Icon-only strip: colored dots for sessions + expand button
    const dots = sessions.slice(0, 12);
    const statusColor = (s) => {
      const runtime = getSessionRuntimeState(s);
      const lifecycle = getSessionLifecycleState(s);
      if (runtime.tone === "success") return "var(--color-done, #10b981)";
      if (runtime.tone === "info") return "var(--accent, #4f8cff)";
      if (runtime.tone === "warning") return "var(--color-warning, #f59e0b)";
      if (runtime.tone === "error" || lifecycle.tone === "error") return "var(--color-error, #ef4444)";
      if (lifecycle.key === "archived") return "rgba(255,255,255,0.2)";
      return "rgba(255,255,255,0.35)";
    };

    return html`
      <aside class="session-rail session-rail--collapsed" aria-label="Sessions (collapsed)">
        <${IconButton}
          size="small"
          class="rail-expand-btn"
          onClick=${onExpand}
          title="Expand sessions panel"
          aria-label="Expand sessions"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="14" height="14">
            <path d="M6 3l5 5-5 5"/>
          </svg>
        <//>
        <div class="rail-dots">
          ${dots.map((s) => html`
            <div
              key=${s.id}
              class="rail-session-dot ${selectedSessionId.value === s.id ? 'selected' : ''}"
              style="background: ${statusColor(s)}"
              onClick=${() => { selectedSessionId.value = s.id; onExpand?.(); }}
              title=${s.title || s.taskId || s.id}
            />
          `)}
          ${sessions.length > 12 && html`
            <div class="rail-dots-more" title="${sessions.length - 12} more sessions">
              +${sessions.length - 12}
            </div>
          `}
        </div>
        <div class="rail-icon-footer">
          <div
            class="rail-active-count"
            title="${liveRuntimeCount} live runtime session${liveRuntimeCount !== 1 ? 's' : ''}"
          >${liveRuntimeCount > 0 ? liveRuntimeCount : ''}</div>
        </div>
      </aside>
    `;
  }

  return html`
    <aside class="session-rail">
      <div class="rail-header">
        <div class="rail-header-inner">
          <div class="rail-title">Sessions</div>
          <div class="rail-meta">
            ${liveRuntimeCount} live runtime · ${sessions.length} total
          </div>
        </div>
        <${IconButton}
          size="small"
          class="rail-collapse-btn"
          onClick=${onCollapse}
          title="Collapse sessions panel"
          aria-label="Collapse sessions"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="14" height="14">
            <path d="M10 3l-5 5 5 5"/>
          </svg>
        <//>
      </div>
      <${SessionList}
        showArchived=${showArchived}
        onToggleArchived=${setShowArchived}
        defaultType=${sessionType}
      />
      ${showResizer
        ? html`
            <div
              class="rail-resizer"
              role="separator"
              aria-label="Resize sessions panel"
              onPointerDown=${(e) => onResizeStart("rail", e)}
              onDoubleClick=${() => onResizeReset("rail")}
            ></div>
          `
        : null}
    </aside>
  `;
}

function filterSessionsByType(allSessions, sessionType = "primary") {
  const sessions = Array.isArray(allSessions) ? allSessions : [];
  const normalizedType = String(sessionType || "").trim().toLowerCase();
  if (!normalizedType) return sessions;
  return sessions.filter((session) => {
    const type = String(session?.type || "").trim().toLowerCase();
    if (normalizedType === "primary") {
      return type !== "task" && type !== "review";
    }
    if (normalizedType === "task") {
      return type === "task";
    }
    return type === normalizedType;
  });
}

function InspectorPanel({ onResizeStart, onResizeReset, showResizer, collapsed = false, onToggleCollapse }) {
  const sessionId = selectedSessionId.value;
  const session = (sessionsData.value || []).find((s) => s.id === sessionId);
  const isSessionTab = activeTab.value === "chat" || activeTab.value === "agents";
  const lifecycle = getSessionLifecycleState(session);
  const runtime = getSessionRuntimeState(session);
  const type = session?.type || "manual";
  const lastActive = getSessionRecencyTimestamp(session);
  const preview = session?.lastMessage
    ? session.lastMessage.slice(0, 160)
    : "No messages yet.";
  const [smartLogs, setSmartLogs] = useState([]);
  const [logState, setLogState] = useState("idle");
  const [insights, setInsights] = useState(null);
  const [insightState, setInsightState] = useState("idle");
  const sessionWorkspaceFallback =
    activeTab.value === "chat"
      ? "active"
      : "all";
  const workspaceHint = resolveSessionWorkspaceHint(session, sessionWorkspaceFallback);
  const lastActiveLabel = lastActive ? formatRelative(lastActive) : "—";
  const apiStatusLabel = inferUiConnected() ? "Connected" : "Offline";
  const wsStatusLabel = wsConnected.value ? "Live" : "Closed";
  const backendLastSeenLabel = backendLastSeen.value
    ? formatRelative(backendLastSeen.value)
    : "—";

  useEffect(() => {
    if (!isSessionTab) return;
    let active = true;
    const fetchLogs = async () => {
      try {
        setLogState("loading");
        const res = await apiFetch("/api/logs?lines=120", { _silent: true });
        if (!active) return;
        const lines = res?.data?.lines || res?.lines || [];
        const allLines = Array.isArray(lines) ? lines : [];
        const tokens = [sessionId, session?.taskId, session?.branch]
          .filter(Boolean)
          .map((t) => String(t).toLowerCase());
        const classified = allLines.map((line) => {
          const lower = String(line || "").toLowerCase();
          let level = "info";
          if (
            lower.includes("fatal") ||
            lower.includes("panic") ||
            lower.includes("exception") ||
            lower.includes("unauthorized") ||
            lower.includes("denied") ||
            lower.includes("error")
          ) {
            level = "error";
          } else if (lower.includes("warn")) {
            level = "warn";
          } else if (lower.includes("timeout")) {
            level = "warn";
          }
          return { line: String(line || ""), level, lower };
        });
        const sessionHits = tokens.length
          ? classified.filter((entry) =>
              tokens.some((token) => entry.lower.includes(token)),
            )
          : [];
        const severityHits = classified.filter((entry) => entry.level !== "info");
        let selected = sessionHits.length ? sessionHits : severityHits;
        if (!selected.length && lifecycle.isActive) {
          selected = classified.slice(-3);
        }
        const pruned = selected.slice(-6).map((entry) => ({
          line: entry.line,
          level: entry.level,
        }));
        setSmartLogs(pruned);
        setLogState("ready");
      } catch {
        if (active) setLogState("error");
      }
    };

    fetchLogs();
    const stop = visibilityInterval(fetchLogs, 12000);
    return () => {
      active = false;
      stop();
    };
  }, [isSessionTab, sessionId, session?.taskId, session?.branch, lifecycle.isActive]);

  useEffect(() => {
    if (!isSessionTab || !sessionId || !session) {
      setInsights(null);
      setInsightState("idle");
      return;
    }
    let active = true;
    const fetchInsights = async () => {
      try {
        setInsightState("loading");
        const fullSessionPath = buildSessionApiPath(sessionId, "", {
          workspace: workspaceHint,
          query: { full: "1" },
        });
        const fallbackSessionPath = buildSessionApiPath(sessionId, "", {
          workspace: "all",
          query: { full: "1" },
        });
        if (!fullSessionPath) {
          if (active) {
            setInsights(null);
            setInsightState("error");
          }
          return;
        }
        let res;
        try {
          res = await apiFetch(fullSessionPath, { _silent: true });
        } catch (err) {
          const shouldRetryAll = shouldFallbackToAllSessions(
            err,
            fullSessionPath,
            fallbackSessionPath,
          );
          if (!shouldRetryAll) throw err;
          res = await apiFetch(fallbackSessionPath, { _silent: true });
        }
        if (!active) return;
        const nextInsights = buildSessionInsights(res?.session || null);
        setInsights(nextInsights);
        setInsightState("ready");
      } catch {
        if (active) {
          setInsights(null);
          setInsightState("error");
        }
      }
    };

    fetchInsights();
    const stop = visibilityInterval(fetchInsights, 10000);
    return () => {
      active = false;
      stop();
    };
  }, [isSessionTab, session?.id, sessionId, workspaceHint]);

  const insightsTotals = insights?.totals || null;
  const insightsFileCounts = insights?.fileCounts || null;
  const insightsTopTools = Array.isArray(insights?.topTools) ? insights.topTools : [];
  const surfaceContextBreakdown = Array.isArray(session?.surface?.contextBreakdown)
    ? session.surface.contextBreakdown
    : [];
  const insightsContextBreakdown = Array.isArray(insights?.contextBreakdown)
    ? insights.contextBreakdown
    : [];
  const contextBreakdown = surfaceContextBreakdown.length > 0
    ? surfaceContextBreakdown
    : insightsContextBreakdown;
  const contextWindow = session?.surface?.contextWindow || insights?.contextWindow || null;
  const tokenUsage = session?.surface?.tokenUsage || insights?.tokenUsage || null;
  const compaction = session?.surface?.compaction || null;
  const recentActions = Array.isArray(insights?.recentActions) ? insights.recentActions : [];

  // Context window breakdown grouping
  const _SYSTEM_CTX = new Set(["system instructions", "tool definitions", "system"]);
  const _USER_CTX = new Set(["messages", "files", "tool results", "user context"]);
  const ctxRefTokens = contextWindow?.totalTokens || tokenUsage?.totalTokens || 0;
  const ctxSystemRows = contextBreakdown.filter((r) => _SYSTEM_CTX.has(String(r.label || "").toLowerCase()));
  const ctxUserRows = contextBreakdown.filter((r) => _USER_CTX.has(String(r.label || "").toLowerCase()));
  const ctxOtherRows = contextBreakdown.filter(
    (r) => !_SYSTEM_CTX.has(String(r.label || "").toLowerCase()) && !_USER_CTX.has(String(r.label || "").toLowerCase()),
  );
  const renderCtxRow = (row, idx) => {
    const approxTokens = ctxRefTokens > 0 ? Math.round((row.percent / 100) * ctxRefTokens) : null;
    return html`
      <div class="inspector-ctx-row" key=${row.label || idx}>
        <span>${row.label}</span>
        <span class="inspector-ctx-row-right">
          ${approxTokens != null ? html`<span class="inspector-ctx-tokens">${formatCompactCount(approxTokens)}</span>` : ""}
          <span class="inspector-ctx-pct">${row.percent}%</span>
        </span>
      </div>`;
  };

  let smartLogsContent = html`
    <div class="inspector-scroll">
      ${smartLogs.map(
        (entry, idx) => html`
          <div key=${idx} class="inspector-log-line ${entry.level}">
            <span class="inspector-log-level">
              ${entry.level.toUpperCase()}
            </span>
            <span class="inspector-log-text">
              ${entry.line.length > 220 ? entry.line.slice(-220) : entry.line}
            </span>
          </div>
        `,
      )}
    </div>
  `;
  if (smartLogs.length === 0 && recentActions.length) {
    smartLogsContent = html`
      <div class="inspector-scroll">
        ${recentActions.slice(0, 6).map(
          (entry, idx) => html`
            <div key=${idx} class="inspector-log-line ${entry.level || "info"}">
              <span class="inspector-log-level">
                ${String(entry.type || entry.level || "activity").replaceAll("_", " ").toUpperCase()}
              </span>
              <span class="inspector-log-text">
                ${String(entry.label || "").slice(0, 220) || "Session activity recorded."}
              </span>
            </div>
          `,
        )}
      </div>
    `;
  }
  if (logState === "error") {
    smartLogsContent = recentActions.length
      ? smartLogsContent
      : html`<div class="inspector-empty">Log stream unavailable.</div>`;
  } else if (smartLogs.length === 0) {
    smartLogsContent = recentActions.length
      ? smartLogsContent
      : html`<div class="inspector-empty">No warning/error lines in the latest logs.</div>`;
  }

  return html`
    <aside class="inspector" aria-label="Inspector panel">
      <button
        type="button"
        class="inspector-collapse-btn"
        onClick=${onToggleCollapse}
        aria-label=${collapsed ? "Expand inspector" : "Collapse inspector"}
        aria-pressed=${collapsed ? "true" : "false"}
        title=${collapsed ? "Expand inspector" : "Collapse inspector"}
      >${collapsed ? "⟨" : "⟩"}</button>
      <div class="inspector-section">
        <div class="inspector-title">Focus</div>
        ${session
          ? html`
              <div class="inspector-kv"><span>Session</span><strong>${session.title || session.taskId || session.id}</strong></div>
              <div class="inspector-kv"><span>Lifecycle</span><strong>${lifecycle.label}</strong></div>
              <div class="inspector-kv"><span>Runtime</span><strong>${runtime.label}</strong></div>
              <div class="inspector-kv"><span>Type</span><strong>${type}</strong></div>
              <div class="inspector-kv"><span>Freshness</span><strong>${lastActiveLabel}</strong></div>
              <div class="inspector-kv inspector-kv-preview"><span>Preview</span><strong class="inspector-preview-value" title=${preview}>${preview}</strong></div>
            `
          : html`<div class="inspector-empty">Select a session to see context.</div>`}
      </div>

      ${isSessionTab
        ? html`
            <div class="inspector-section inspector-scroll">
              <div class="inspector-title">Latest Diff</div>
              <${DiffViewer}
                sessionId=${sessionId}
                workspace=${workspaceHint}
                activitySummary=${insights?.activityDiff || null}
              />
            </div>
            <div class="inspector-section">
              <div class="inspector-title">Smart Logs</div>
              <div class="inspector-subtitle">Session Activity</div>
              ${insightState === "error"
                ? html`<div class="inspector-empty">Session activity tracking is unavailable.</div>`
                : insightsTotals
                  ? html`
                      <div class="inspector-metrics-grid">
                        <div class="inspector-metric"><span class="label">Tool Calls</span><strong>${formatCompactCount(insightsTotals.toolCalls)}</strong></div>
                        <div class="inspector-metric"><span class="label">Commands</span><strong>${formatCompactCount(insightsTotals.commandExecutions)}</strong></div>
                        <div class="inspector-metric"><span class="label">Files Edited</span><strong>${formatCompactCount(insightsFileCounts?.editedFiles || 0)}</strong></div>
                        <div class="inspector-metric"><span class="label">Files Opened</span><strong>${formatCompactCount(insightsFileCounts?.openedFiles || 0)}</strong></div>
                        <div class="inspector-metric"><span class="label">Messages</span><strong>${formatCompactCount(insightsTotals.messages)}</strong></div>
                        <div class="inspector-metric"><span class="label">Errors</span><strong>${formatCompactCount(insightsTotals.errors)}</strong></div>
                      </div>
                      ${(contextWindow || tokenUsage || contextBreakdown.length > 0 || insightsTopTools.length > 0 || compaction) &&
                        html`
                          <div class="inspector-context">
                            <div class="inspector-ctx-header">
                              <span class="inspector-ctx-title">Context Window</span>
                              ${contextWindow?.percent != null
                                ? html`<span class="inspector-ctx-pct-badge">${contextWindow.percent}%</span>`
                                : html`<span class="inspector-ctx-pct-badge">Tracked</span>`}
                            </div>
                            ${contextWindow?.percent != null &&
                              html`<div class="inspector-ctx-bar">
                                <div class="inspector-ctx-bar-fill" style=${{ width: `${Math.min(100, contextWindow.percent)}%` }}></div>
                              </div>`}
                            ${contextWindow?.usedTokens != null &&
                              html`<div class="inspector-ctx-summary">
                                ${formatCompactCount(contextWindow.usedTokens)}${contextWindow.totalTokens != null ? ` / ${formatCompactCount(contextWindow.totalTokens)} tokens` : " tokens"}
                              </div>`}
                            ${(contextWindow?.remainingTokens != null || contextWindow?.reservedForResponseTokens != null || compaction) &&
                              html`<div class="inspector-ctx-group">
                                <div class="inspector-ctx-group-label">Headroom</div>
                                ${contextWindow?.remainingTokens != null &&
                                  html`<div class="inspector-ctx-row">
                                    <span>Remaining</span>
                                    <span class="inspector-ctx-row-right"><span class="inspector-ctx-tokens">${formatCompactCount(contextWindow.remainingTokens)}</span></span>
                                  </div>`}
                                ${contextWindow?.reservedForResponseTokens != null &&
                                  html`<div class="inspector-ctx-row">
                                    <span>Reserved for Response</span>
                                    <span class="inspector-ctx-row-right"><span class="inspector-ctx-tokens">${formatCompactCount(contextWindow.reservedForResponseTokens)}</span></span>
                                  </div>`}
                                ${compaction &&
                                  html`<div class="inspector-ctx-row">
                                    <span>Compaction</span>
                                    <span class="inspector-ctx-row-right"><span class="inspector-ctx-tokens">${formatCompactCount(compaction.compactEvents || 0)}</span><span class="inspector-ctx-pct">${String(compaction.state || compaction.mode || "normal").replaceAll("_", " ")}</span></span>
                                  </div>`}
                              </div>`}
                            ${ctxSystemRows.length > 0 &&
                              html`<div class="inspector-ctx-group">
                                <div class="inspector-ctx-group-label">System</div>
                                ${ctxSystemRows.map(renderCtxRow)}
                              </div>`}
                            ${ctxUserRows.length > 0 &&
                              html`<div class="inspector-ctx-group">
                                <div class="inspector-ctx-group-label">User Context</div>
                                ${ctxUserRows.map(renderCtxRow)}
                              </div>`}
                            ${ctxOtherRows.length > 0 && ctxOtherRows.map(renderCtxRow)}
                            ${tokenUsage &&
                              html`<div class="inspector-ctx-group">
                                <div class="inspector-ctx-group-label">Token Usage</div>
                                <div class="inspector-ctx-row">
                                  <span>Input</span>
                                  <span class="inspector-ctx-row-right"><span class="inspector-ctx-tokens">${formatCompactCount(tokenUsage.inputTokens)}</span></span>
                                </div>
                                <div class="inspector-ctx-row">
                                  <span>Output</span>
                                  <span class="inspector-ctx-row-right"><span class="inspector-ctx-tokens">${formatCompactCount(tokenUsage.outputTokens)}</span></span>
                                </div>
                                ${Number(tokenUsage.cacheInputTokens || 0) > 0 &&
                                  html`<div class="inspector-ctx-row">
                                    <span>Cache In</span>
                                    <span class="inspector-ctx-row-right"><span class="inspector-ctx-tokens">${formatCompactCount(tokenUsage.cacheInputTokens)}</span></span>
                                  </div>`}
                              </div>`}
                            ${insightsTopTools.length > 0 &&
                              html`<div class="inspector-ctx-group">
                                <div class="inspector-ctx-group-label">Top Tools</div>
                                <div class="inspector-pill-row">
                                  ${insightsTopTools.map(
                                    (tool) => html`<span class="inspector-pill" key=${tool.name}>${tool.name}: ${formatCompactCount(tool.count)}</span>`,
                                  )}
                                </div>
                              </div>`}
                          </div>
                        `}
                    `
                  : html`<div class="inspector-empty">Tracking session metrics…</div>`}
              <div class="inspector-subtitle">Recent Warning/Error Logs</div>
              ${smartLogsContent}
              <${Button} variant="text" size="small" onClick=${() => navigateTo("logs")}>
                Open Logs
              <//>
            </div>
          `
        : html`
            <div class="inspector-section">
              <div class="inspector-title">System Pulse</div>
              <div class="inspector-kv"><span>API</span><strong>${apiStatusLabel}</strong></div>
              <div class="inspector-kv"><span>WebSocket</span><strong>${wsStatusLabel}</strong></div>
              <div class="inspector-kv"><span>Last Seen</span><strong>${backendLastSeenLabel}</strong></div>
            </div>
          `}
      ${showResizer
        ? html`
            <div
              class="inspector-resizer"
              role="separator"
              aria-label="Resize inspector panel"
              onPointerDown=${(e) => onResizeStart("inspector", e)}
              onDoubleClick=${() => onResizeReset("inspector")}
            ></div>
          `
        : null}
    </aside>
  `;
}

/* ═══════════════════════════════════════════════
 *  Bottom Navigation
 * ═══════════════════════════════════════════════ */
const PRIMARY_NAV_TABS = ["dashboard", "chat", "tasks", "agents"];
const MORE_NAV_TABS = ["control", "infra", "logs", "telemetry", "library", "marketplace", "workflows", "manual-flows", "settings"];

function getTabsById(ids) {
  return ids
    .map((id) => TAB_CONFIG.find((tab) => tab.id === id))
    .filter(Boolean);
}

function getActiveTaskCount() {
  const sCounts = statusData.value?.counts || {};
  const fromSummary =
    Number(sCounts.running || sCounts.inprogress || 0) +
    Number(sCounts.inreview || sCounts.review || 0);
  const list = Array.isArray(tasksData.value) ? tasksData.value : [];
  const fromList = list.filter((task) => {
    const status = String(task?.status || "").toLowerCase();
    return status === "inprogress" || status === "inreview" || status === "running";
  }).length;
  return Math.max(fromSummary, fromList);
}

function getActiveAgentCount() {
  const slots = Number(executorData.value?.data?.activeSlots || 0);
  const agents = Array.isArray(agentsData.value) ? agentsData.value : [];
  const fromAgents = agents.filter((agent) => {
    const status = String(agent?.status || "").toLowerCase();
    return status === "running" || status === "busy" || status === "active";
  }).length;
  const safeSlots = Number.isFinite(slots) ? Math.max(0, slots) : 0;
  return Math.max(safeSlots, fromAgents);
}

function BottomNav({ compact, moreOpen, onToggleMore, onNavigate }) {
  const primaryTabs = getTabsById(PRIMARY_NAV_TABS);
  const tasksBadge = getActiveTaskCount();
  const agentsBadge = getActiveAgentCount();
  const activeIndex = primaryTabs.findIndex((t) => t.id === activeTab.value);
  const navValue = moreOpen ? primaryTabs.length : Math.max(activeIndex, 0);
  return html`
    <${Paper} sx=${{position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 1200}} elevation=${3}>
      <${BottomNavigation}
        value=${navValue}
        onChange=${(_, idx) => {
          if (idx === primaryTabs.length) { onToggleMore(); return; }
          const tab = primaryTabs[idx];
          if (!tab) return;
          const isHome = tab.id === "dashboard";
          onNavigate(tab.id, { resetHistory: isHome, forceRefresh: isHome && activeTab.value === tab.id });
        }}
        showLabels
        sx=${{
          bgcolor: "background.paper",
          borderTop: "1px solid",
          borderColor: "divider",
          ...(compact ? { "& .MuiBottomNavigationAction-root": { minWidth: 52, px: 0.5 } } : {}),
        }}
      >
        ${primaryTabs.map((tab) => {
          let badge = 0;
          if (tab.id === "tasks") badge = tasksBadge;
          else if (tab.id === "agents") badge = agentsBadge;
          const icon = badge > 0
            ? html`<${Badge} badgeContent=${badge} color="primary" max=${99}>${ICONS[tab.icon]}</${Badge}>`
            : ICONS[tab.icon];
          return html`<${BottomNavigationAction} key=${tab.id} label=${tab.label} icon=${icon} />`;
        })}
        <${BottomNavigationAction}
          label="More"
          icon=${ICONS.ellipsis}
        />
      </${BottomNavigation}>
    </${Paper}>
  `;
}

function MoreSheet({ open, onClose, onNavigate, onOpenBot }) {
  const primaryTabs = getTabsById(PRIMARY_NAV_TABS);
  const moreTabs = getTabsById(MORE_NAV_TABS);
  return html`
    <${Modal} title="More" open=${open} onClose=${onClose}>
      <div class="more-menu" role="navigation" aria-label="More menu">
        <div class="more-menu-section">
          <div class="more-menu-section-title">Quick Access</div>
          <div class="more-menu-grid">
            ${primaryTabs.map((tab) => {
              const isHome = tab.id === "dashboard";
              const isActive = activeTab.value === tab.id;
              return html`
                <${Button}
                  key=${tab.id}
                  variant="text"
                  class="more-menu-item ${isActive ? "active" : ""}"
                  aria-label=${`Open ${tab.label}`}
                  onClick=${() =>
                    onNavigate(tab.id, {
                      resetHistory: isHome,
                    })}
                >
                  <span class="more-menu-icon">${ICONS[tab.icon]}</span>
                  <span class="more-menu-label">${tab.label}</span>
                <//>
              `;
            })}
          </div>
        </div>
        <div class="more-menu-section">
          <div class="more-menu-section-title">Explore</div>
          <div class="more-menu-grid">
            ${moreTabs.map((tab) => {
              const isHome = tab.id === "dashboard";
              const isActive = activeTab.value === tab.id;
              return html`
                <${Button}
                  key=${tab.id}
                  variant="text"
                  class="more-menu-item ${isActive ? "active" : ""}"
                  aria-label=${`Open ${tab.label}`}
                  onClick=${() =>
                    onNavigate(tab.id, {
                      resetHistory: isHome,
                    })}
                >
                  <span class="more-menu-icon">${ICONS[tab.icon]}</span>
                  <span class="more-menu-label">${tab.label}</span>
                <//>
              `;
            })}
          </div>
        </div>
        <div class="more-menu-section">
          <div class="more-menu-section-title">Quick Actions</div>
          <${Button}
            variant="text"
            class="more-menu-bot-btn"
            type="button"
            aria-label="Open Bot Controls"
            onClick=${() => { onClose(); onOpenBot?.(); }}
          >
            <span class="more-menu-bot-icon">${resolveIcon("bot")}</span>
            <div class="more-menu-bot-text">
              <span class="more-menu-bot-label">Bot Controls</span>
              <span class="more-menu-bot-sub">Commands, executor, routing</span>
            </div>
            <span class="more-menu-bot-chevron">›</span>
          <//>
        </div>
      </div>
    <//>
  `;
}

/* ═══════════════════════════════════════════════
 *  Bot Controls — multi-level command panel
 *  Triggered from the "More" sheet (not a floating FAB so it
 *  doesn't obscure content on small screens / mobile).
 * ═══════════════════════════════════════════════ */
const BOT_SCREENS = {
  home: {
    title: ":sliders: Bosun Control Center",
    body: "Manage your automation fleet.",
    keyboard: [
      [{ text: ":chart: Status", cmd: "/status" }, { text: ":clipboard: Tasks", cmd: "/tasks" }, { text: ":bot: Agents", cmd: "/agents" }],
      [{ text: ":settings: Executor", go: "executor" }, { text: ":server: Routing", go: "routing" }, { text: ":git: Workspaces", go: "workspaces" }],
      [{ text: ":folder: Logs", cmd: "/logs" }, { text: ":heart: Health", cmd: "/health" }, { text: ":refresh: Refresh", cmd: "/status" }],
    ],
  },
  executor: {
    title: ":settings: Executor",
    parent: "home",
    body: "Task execution slots, pause, resume, and parallelism.",
    keyboard: [
      [{ text: ":chart: Status", cmd: "/executor" }, { text: ":pause: Pause", cmd: "/pause" }, { text: ":play: Resume", cmd: "/resume" }],
      [{ text: ":hash: Max Parallel", go: "maxparallel" }, { text: ":repeat: Retry Active", cmd: "/retrytask" }],
    ],
  },
  maxparallel: {
    title: ":hash: Max Parallel Slots",
    parent: "executor",
    body: "Set the maximum number of concurrent task slots.",
    keyboard: [
      [{ text: "1", cmd: "/parallelism 1" }, { text: "2", cmd: "/parallelism 2" }, { text: "3", cmd: "/parallelism 3" }],
      [{ text: "4", cmd: "/parallelism 4" }, { text: "6", cmd: "/parallelism 6" }, { text: "8", cmd: "/parallelism 8" }],
      [{ text: "12", cmd: "/parallelism 12" }, { text: "16", cmd: "/parallelism 16" }],
    ],
  },
  routing: {
    title: ":server: Routing & SDKs",
    parent: "home",
    body: "SDK routing, kanban binding, and version info.",
    keyboard: [
      [{ text: ":bot: SDK Status", cmd: "/sdk" }, { text: ":clipboard: Kanban", cmd: "/kanban" }],
      [{ text: ":globe: Version", cmd: "/version" }, { text: ":help: Help", cmd: "/help" }],
    ],
  },
  workspaces: {
    title: ":git: Workspaces",
    parent: "home",
    body: "Git worktrees, logs, and task planning.",
    keyboard: [
      [{ text: ":chart: Fleet Status", cmd: "/status" }, { text: ":folder: Logs", cmd: "/logs" }],
      [{ text: ":grid: Planner", go: "planner" }, { text: ":check: Start Task", cmd: "/starttask" }],
    ],
  },
  planner: {
    title: ":grid: Task Planner",
    parent: "workspaces",
    body: "Seed new tasks from the backlog into the active queue.",
    keyboard: [
      [{ text: "Plan 3", cmd: "/plan 3" }, { text: "Plan 5", cmd: "/plan 5" }, { text: "Plan 10", cmd: "/plan 10" }],
    ],
  },
};

function BotControlsSheet({ open, onClose }) {
  const [screen, setScreen] = useState("home");
  const [navStack, setNavStack] = useState([]);
  const [cmdOutput, setCmdOutput] = useState(null);
  const [cmdLoading, setCmdLoading] = useState(false);
  const [cmdError, setCmdError] = useState(null);

  const currentDef = BOT_SCREENS[screen] || BOT_SCREENS.home;

  const botNavigateTo = useCallback((screenId) => {
    setNavStack((s) => [...s, screen]);
    setScreen(screenId);
    setCmdOutput(null);
    setCmdError(null);
  }, [screen]);

  const botGoBack = useCallback(() => {
    setNavStack((s) => {
      const next = [...s];
      const prev = next.pop() || "home";
      setScreen(prev);
      setCmdOutput(null);
      setCmdError(null);
      return next;
    });
  }, []);

  const botGoHome = useCallback(() => {
    setNavStack([]);
    setScreen("home");
    setCmdOutput(null);
    setCmdError(null);
  }, []);

  const handleBotClose = useCallback(() => {
    onClose();
    // Reset navigation state after the sheet's close animation (~300ms)
    setTimeout(() => {
      setScreen("home");
      setNavStack([]);
      setCmdOutput(null);
      setCmdError(null);
    }, 320);
  }, [onClose]);

  const runBotCommand = useCallback(async (cmd) => {
    if (cmdLoading) return;
    setCmdLoading(true);
    setCmdOutput(null);
    setCmdError(null);
    try {
      const result = await apiFetch("/api/command", {
        method: "POST",
        body: JSON.stringify({ command: cmd }),
        _silent: true,
      });
      if (result?.ok) {
        const d = result.data;
        if (d?.content) {
          setCmdOutput(d.content);
        } else if (d?.executed === false && d?.error) {
          setCmdError(d.error);
        } else {
          setCmdOutput(`:check: ${cmd} sent.`);
        }
      } else {
        setCmdError(result?.error || "Command failed");
      }
    } catch (err) {
      setCmdError(err.message || "Connection error — is bosun running?");
    } finally {
      setCmdLoading(false);
    }
  }, [cmdLoading]);

  return html`
    <${Modal}
      title=${iconText(currentDef.title)}
      open=${open}
      onClose=${handleBotClose}
      contentClassName="bot-controls-content"
    >
      <div class="bot-controls">
        ${navStack.length > 0 ? html`
          <div class="bot-controls-breadcrumb">
            <${Button} variant="text" size="small" type="button" onClick=${botGoBack} aria-label="Go back">
              ← Back
            <//>
            ${navStack.length > 1 ? html`
              <${Button} variant="text" size="small" type="button" onClick=${botGoHome} aria-label="Go to home">
                ${iconText(":home: Home")}
              <//>
            ` : null}
          </div>
        ` : null}

        ${currentDef.body ? html`<p class="bot-controls-body">${iconText(currentDef.body)}</p>` : null}

        ${cmdLoading ? html`
          <div class="bot-controls-spinner">
            <div class="ptr-spinner-icon"></div>
            <span>Running…</span>
          </div>
        ` : null}

        ${cmdError && !cmdLoading ? html`
          <div class="bot-controls-result bot-controls-result-error">${iconText(`:close: ${cmdError}`)}</div>
        ` : null}

        ${cmdOutput && !cmdLoading && !cmdError ? html`
          <div class="bot-controls-result"><pre>${iconText(cmdOutput)}</pre></div>
        ` : null}

        <div class="bot-controls-keyboard">
          ${currentDef.keyboard.map((row, ri) => html`
            <div key=${ri} class="bot-kb-row">
              ${row.map((btn, bi) => html`
                <${Button}
                  key=${bi}
                  type="button"
                  variant="text"
                  class="bot-kb-btn ${btn.go ? "nav-btn" : ""}"
                  disabled=${cmdLoading}
                  onClick=${() => btn.go ? botNavigateTo(btn.go) : runBotCommand(btn.cmd)}
                >
                  ${iconText(btn.text)}
                <//>
              `)}
            </div>
          `)}
        </div>
      </div>
    <//>
  `;
}

/* ═══════════════════════════════════════════════
 *  App Root
 * ═══════════════════════════════════════════════ */
function App() {
  const forcedLayoutMode = readForcedLayoutMode();
  const initialLayout = resolveLayoutFlags(globalThis.window, forcedLayoutMode);
  useBackendHealth();
  const { open: paletteOpen, onClose: paletteClose } = useCommandPalette();
  const [showShortcuts, setShowShortcuts] = useState(false);
  const mainRef = useRef(null);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const scrollVisibilityRef = useRef(false);

  // ── Top loading bar state ──
  const [loadingPct, setLoadingPct] = useState(0);
  const [loadingVisible, setLoadingVisible] = useState(false);
  const loadingTimerRef = useRef(null);
  const isLoading = loadingCount.value > 0;
  useEffect(() => {
    if (loadingTimerRef.current) {
      clearTimeout(loadingTimerRef.current);
      loadingTimerRef.current = null;
    }
    if (isLoading) {
      // Avoid flashing the top bar for short background activity.
      loadingTimerRef.current = setTimeout(() => {
        setLoadingVisible(true);
        setLoadingPct(70);
        loadingTimerRef.current = null;
      }, 180);
    } else {
      setLoadingPct(100);
      loadingTimerRef.current = setTimeout(() => {
        setLoadingVisible(false);
        setLoadingPct(0);
        loadingTimerRef.current = null;
      }, 220);
    }
    return () => {
      if (loadingTimerRef.current) {
        clearTimeout(loadingTimerRef.current);
        loadingTimerRef.current = null;
      }
    };
  }, [isLoading]);
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const [voiceOverlayOpen, setVoiceOverlayOpen] = useState(false);
  const voiceOverlayOpenRef = useRef(false);
  // Keep ref in sync for access inside stale closures (e.g. retry loops)
  voiceOverlayOpenRef.current = voiceOverlayOpen;
  const [voiceTier, setVoiceTier] = useState(2);
  const [voiceSessionId, setVoiceSessionId] = useState(null);
  const [voiceExecutor, setVoiceExecutor] = useState(null);
  const [voiceAgentMode, setVoiceAgentMode] = useState(null);
  const [voiceModel, setVoiceModel] = useState(null);
  const [voiceAgentId, setVoiceAgentId] = useState(null);
  const [voiceCallType, setVoiceCallType] = useState("voice");
  const [voiceInitialVisionSource, setVoiceInitialVisionSource] = useState(
    null,
  );
  const followWindowMode = isFollowWindowFromUrl();
  const followOverlayOpenedRef = useRef(false);
  const externalizeInFlightRef = useRef(false);
  const [floatingCallState, setFloatingCallState] = useState(() =>
    readFloatingCallState(),
  );
  const resizeRef = useRef(null);
  const [isCompactNav, setIsCompactNav] = useState(initialLayout.isCompactNav);
  const [isDesktop, setIsDesktop] = useState(initialLayout.isDesktop);
  const [isTablet, setIsTablet] = useState(initialLayout.isTablet);
  const [isWideDesktop, setIsWideDesktop] = useState(initialLayout.isWideDesktop);
  const [sidebarDrawerOpen, setSidebarDrawerOpen] = useState(false);
  const [inspectorDrawerOpen, setInspectorDrawerOpen] = useState(false);
  const initialPanelLayout = getStoredPanelLayout();
  const [sidebarWidth] = useState(initialPanelLayout.sidebarWidth);
  const [railWidth, setRailWidth] = useState(initialPanelLayout.railWidth);
  const [inspectorWidth, setInspectorWidth] = useState(initialPanelLayout.inspectorWidth);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialPanelLayout.sidebarCollapsed);
  const [railCollapsed, setRailCollapsed] = useState(initialPanelLayout.railCollapsed);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(initialPanelLayout.inspectorCollapsed);
  const railWidthBeforeCollapseRef = useRef(initialPanelLayout.railWidth || DEFAULT_RAIL_WIDTH);

  const clamp = useCallback((value, min, max) => {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
  }, []);

  const handleResizeMove = useCallback((event) => {
    const state = resizeRef.current;
    if (!state) return;
    const delta = event.clientX - state.startX;
    if (state.type === "rail") {
      const next = clamp(state.startRail + delta, RAIL_ICON_WIDTH, 440);
      setRailWidth(next);
    } else {
      const next = clamp(state.startInspector - delta, 260, 440);
      setInspectorWidth(next);
    }
  }, [clamp]);

  const handleResizeEnd = useCallback(() => {
    const state = resizeRef.current;
    resizeRef.current = null;
    document.body.classList.remove("is-resizing");
    globalThis.removeEventListener?.("pointermove", handleResizeMove);
    globalThis.removeEventListener?.("pointerup", handleResizeEnd);

    // Snap rail to icon mode if dragged to near-minimum
    if (state?.type === "rail") {
      if (railWidth <= RAIL_ICON_WIDTH + 20) {
        railWidthBeforeCollapseRef.current = Math.max(state.startRail, 200);
        setRailCollapsed(true);
        setRailWidth(RAIL_ICON_WIDTH);
        try { localStorage.setItem("ve-rail-collapsed", "true"); } catch {}
      }
    }
  }, [handleResizeMove, railWidth]);

  const handleResizeStart = useCallback(
    (type, event) => {
      if (!isDesktop) return;
      event.preventDefault();
      event.stopPropagation();
      resizeRef.current = {
        type,
        startX: event.clientX,
        startRail: railWidth,
        startInspector: inspectorWidth,
      };
      document.body.classList.add("is-resizing");
      globalThis.addEventListener?.("pointermove", handleResizeMove);
      globalThis.addEventListener?.("pointerup", handleResizeEnd);
    },
    [isDesktop, railWidth, inspectorWidth, handleResizeMove, handleResizeEnd],
  );

  const handleResizeReset = useCallback((type) => {
    if (type === "rail") setRailWidth(320);
    if (type === "inspector") setInspectorWidth(320);
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      const key = String(event.key || "").toLowerCase();
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && key === "b") {
        event.preventDefault();
        setSidebarCollapsed((value) => !value);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === "i") {
        event.preventDefault();
        setInspectorCollapsed((value) => !value);
      }
    };
    globalThis.addEventListener?.("keydown", onKeyDown);
    return () => globalThis.removeEventListener?.("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const win = globalThis.window;
    if (!win?.matchMedia) return;
    if (forcedLayoutMode !== "auto") {
      const next = resolveLayoutFlags(win, forcedLayoutMode);
      setIsDesktop(next.isDesktop);
      return;
    }
    const query = win.matchMedia(`(min-width: ${DESKTOP_MIN_WIDTH}px)`);
    const update = () => setIsDesktop(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => {
      query.removeEventListener?.("change", update);
    };
  }, [forcedLayoutMode]);

  useEffect(() => {
    const win = globalThis.window;
    if (!win?.matchMedia) return;
    if (forcedLayoutMode !== "auto") {
      const next = resolveLayoutFlags(win, forcedLayoutMode);
      setIsWideDesktop(next.isWideDesktop);
      return;
    }
    const query = win.matchMedia(`(min-width: ${WIDE_DESKTOP_MIN_WIDTH}px)`);
    const update = () => setIsWideDesktop(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => {
      query.removeEventListener?.("change", update);
    };
  }, [forcedLayoutMode]);

  useEffect(() => {
    const win = globalThis.window;
    if (!win?.matchMedia) return;
    if (forcedLayoutMode !== "auto") {
      const next = resolveLayoutFlags(win, forcedLayoutMode);
      setIsCompactNav(next.isCompactNav);
      return;
    }
    const query = win.matchMedia(`(max-width: ${COMPACT_NAV_MAX_WIDTH}px)`);
    const update = () => setIsCompactNav(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => {
      query.removeEventListener?.("change", update);
    };
  }, [forcedLayoutMode]);

  useEffect(() => {
    const win = globalThis.window;
    if (!win?.matchMedia) return;
    if (forcedLayoutMode !== "auto") {
      const next = resolveLayoutFlags(win, forcedLayoutMode);
      setIsTablet(next.isTablet);
      return;
    }
    const tabletQuery = win.matchMedia(
      `(min-width: ${TABLET_MIN_WIDTH}px) and (max-width: ${DESKTOP_MIN_WIDTH - 1}px)`,
    );
    const update = () => setIsTablet(tabletQuery.matches);
    update();
    tabletQuery.addEventListener?.("change", update);
    return () => {
      tabletQuery.removeEventListener?.("change", update);
    };
  }, [forcedLayoutMode]);


  useEffect(() => {
    if (!globalThis.window) return;
    localStorage.setItem("ve-sidebar-width", String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    if (!globalThis.window) return;
    if (!railCollapsed) localStorage.setItem("ve-rail-width", String(railWidth));
  }, [railWidth, railCollapsed]);

  useEffect(() => {
    if (!globalThis.window) return;
    if (!inspectorCollapsed) localStorage.setItem("ve-inspector-width", String(inspectorWidth));
  }, [inspectorWidth, inspectorCollapsed]);

  useEffect(() => {
    if (!globalThis.window) return;
    localStorage.setItem("ve-inspector-collapsed", String(inspectorCollapsed));
  }, [inspectorCollapsed]);

  useEffect(() => {
    if (!globalThis.window) return;
    try { localStorage.setItem("ve-sidebar-collapsed", String(sidebarCollapsed)); } catch {}
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (!globalThis.window) return;
    try { localStorage.setItem("ve-rail-collapsed", String(railCollapsed)); } catch {}
  }, [railCollapsed]);

  // Listen for expand-rail from chat tab / other places
  useEffect(() => {
    const handler = () => {
      if (!railCollapsed) return;
      setRailCollapsed(false);
      const restoredWidth = railWidthBeforeCollapseRef.current || 280;
      setRailWidth(Math.max(restoredWidth, 200));
    };
    globalThis.addEventListener?.("ve:expand-rail", handler);
    return () => globalThis.removeEventListener?.("ve:expand-rail", handler);
  }, [railCollapsed]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (isDesktop) {
      document.documentElement.dataset.desktop = "true";
      delete document.documentElement.dataset.tablet;
      // Close drawers when switching to desktop — panels are always visible
      setSidebarDrawerOpen(false);
      setInspectorDrawerOpen(false);
    } else if (isTablet) {
      delete document.documentElement.dataset.desktop;
      document.documentElement.dataset.tablet = "true";
    } else {
      delete document.documentElement.dataset.desktop;
      delete document.documentElement.dataset.tablet;
      setSidebarDrawerOpen(false);
      setInspectorDrawerOpen(false);
    }
  }, [isDesktop, isTablet]);

  const closeMore = useCallback(() => setIsMoreOpen(false), []);

  // ── Bot Controls sheet state ──
  const [isBotOpen, setIsBotOpen] = useState(false);
  const openBot  = useCallback(() => setIsBotOpen(true), []);
  const closeBot = useCallback(() => setIsBotOpen(false), []);

  const handleNavigate = useCallback((tabId, options = {}) => {
    setIsMoreOpen(false);
    navigateTo(tabId, options);
  }, []);

  const toggleMore = useCallback(() => {
    setIsMoreOpen((prev) => !prev);
  }, []);

  useEffect(() => {
    if (typeof globalThis === "undefined") return;
    const handler = () => {
      setIsMoreOpen(false);
      setIsBotOpen(false);
      setShowShortcuts(false);
    };
    globalThis.addEventListener("ve:close-modals", handler);
    return () => globalThis.removeEventListener("ve:close-modals", handler);
  }, []);

  useEffect(() => {
    // Keep legacy connectivity semantics: UI "Connected/Offline" follows WS liveness.
    connected.value = Boolean(wsConnected.value);
  }, [wsConnected.value]);

  useEffect(() => {
    setIsMoreOpen(false);
    setIsBotOpen(false);
    setSidebarDrawerOpen(false);
    setInspectorDrawerOpen(false);
  }, [activeTab.value]);

  useEffect(() => {
    // Initialize Telegram Mini App SDK
    initTelegramApp();

    // Theme change monitoring
    const unsub = onThemeChange(() => {
      colorScheme.value = getTg()?.colorScheme || "dark";
    });

    // Show settings button in Telegram header
    showSettingsButton(() => navigateTo("settings"));

    // Connect WebSocket + invalidation auto-refresh
    connectWebSocket();
    initWsInvalidationListener();
    initSessionWsListener();

    // Load notification preferences early (non-blocking)
    loadNotificationPrefs();

    // Load initial data for the route-selected tab, then apply stored defaults.
    refreshTab(activeTab.value || "dashboard", {
      background: true,
      manual: false,
    }).then(() => applyStoredDefaults());

    // Global keyboard shortcuts (1-7 for tabs, Escape for modals)
    function handleGlobalKeys(e) {
      const tag = (document.activeElement?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (document.activeElement?.isContentEditable) return;

      // Number keys 1-8 to switch tabs
      const num = Number.parseInt(e.key, 10);
      if (num >= 1 && num <= 8 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const tabCfg = TAB_CONFIG[num - 1];
        if (tabCfg) {
          e.preventDefault();
          navigateTo(tabCfg.id);
        }
        return;
      }

      // "c" to create task (when not in a form element)
      if (e.key === "c" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        globalThis.dispatchEvent(new CustomEvent("ve:create-task"));
        return;
      }

      // "?" to toggle keyboard shortcuts help
      if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setShowShortcuts((v) => !v);
        return;
      }

      // Escape to close modals/palette
      if (e.key === "Escape") {
        globalThis.dispatchEvent(new CustomEvent("ve:close-modals"));
        setShowShortcuts(false);
      }
    }
    document.addEventListener("keydown", handleGlobalKeys);

    return () => {
      unsub();
      disconnectWebSocket();
      document.removeEventListener("keydown", handleGlobalKeys);
    };
  }, []);

  useEffect(() => {
    const onBeforeUnload = (event) => {
      if (!hasPendingChanges.value) return;
      event.preventDefault();
      event.returnValue = "";
    };
    globalThis.addEventListener?.("beforeunload", onBeforeUnload);
    return () => globalThis.removeEventListener?.("beforeunload", onBeforeUnload);
  }, []);

  useEffect(() => {
    const handleOpenVoiceMode = async (event) => {
      try {
        const requestedCallType =
          String(event?.detail?.call || "").trim().toLowerCase() === "video"
            ? "video"
            : "voice";
        const requestedVisionSourceRaw = String(
          event?.detail?.initialVisionSource || "",
        )
          .trim()
          .toLowerCase();
        const requestedVisionSource =
          requestedVisionSourceRaw === "camera" ||
          requestedVisionSourceRaw === "screen"
            ? requestedVisionSourceRaw
            : requestedCallType === "video"
              ? "camera"
              : null;
        const currentExecutor =
          String(event?.detail?.executor || activeAgent.value || "").trim() ||
          null;
        const currentMode =
          String(event?.detail?.mode || agentMode.value || "").trim() || null;
        const currentModel =
          String(event?.detail?.model || selectedModel.value || "").trim() ||
          null;
        const currentVoiceAgentId =
          String(event?.detail?.voiceAgentId || voiceAgentId || "").trim() ||
          null;
        const explicitSessionId =
          String(event?.detail?.sessionId || "").trim() || null;
        let currentSessionId =
          explicitSessionId ||
          (selectedSessionId.value ? String(selectedSessionId.value) : null);

        // Ensure voice calls always bind to a real chat session so transcript +
        // delegated agent output are persisted in shared history.
        if (!currentSessionId) {
          const created = await createSession({
            type: "primary",
            agent: currentExecutor || undefined,
            mode: currentMode || undefined,
            model: currentModel || undefined,
          });
          const createdId = String(created?.session?.id || "").trim();
          currentSessionId = createdId || null;
          if (currentSessionId) {
            selectedSessionId.value = currentSessionId;
          }
        }

        if (!currentSessionId) {
          showToast("Could not create a chat session for voice mode.", "error");
          return;
        }

        setVoiceSessionId(currentSessionId);
        setVoiceExecutor(currentExecutor);
        setVoiceAgentMode(currentMode);
        setVoiceModel(currentModel);
        setVoiceAgentId(currentVoiceAgentId);
        setVoiceCallType(requestedCallType);
        setVoiceInitialVisionSource(requestedVisionSource);

        const response = await fetch("/api/voice/config", { method: "GET" });
        const cfg = response.ok ? await response.json() : null;
        if (!cfg?.available) {
          showToast(cfg?.reason || "Voice mode is not available.", "error");
          return;
        }
        const nextTier = Number(cfg?.tier) === 1 ? 1 : 2;

        // Always open the voice overlay inline — even in Electron.
        // The desktop follow window (always-on-top pop-out) is available
        // via the tray menu or the "externalize" button inside the overlay.
        // Auto-delegating to the follow window on mic-button click was
        // fragile (required URL redirect + cold-start + retry dispatch)
        // and frequently failed, leaving the user with no voice UI.
        setVoiceTier(nextTier);
        setVoiceOverlayOpen(true);
      } catch (err) {
        showToast(
          `Could not open voice mode: ${err?.message || "unknown error"}`,
          "error",
        );
      }
    };

    globalThis.addEventListener?.("ve:open-voice-mode", handleOpenVoiceMode);
    return () =>
      globalThis.removeEventListener?.("ve:open-voice-mode", handleOpenVoiceMode);
  }, [followWindowMode, voiceAgentId]);

  useEffect(() => {
    const onStorage = (event) => {
      if (event?.key && event.key !== FLOATING_CALL_STATE_KEY) return;
      setFloatingCallState(readFloatingCallState());
    };
    globalThis.addEventListener?.("storage", onStorage);
    return () => {
      globalThis.removeEventListener?.("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    if (!followWindowMode) return;
    const nextFloatingState = {
      active: Boolean(voiceOverlayOpen),
      call: voiceCallType,
      sessionId: voiceSessionId,
      executor: voiceExecutor,
      mode: voiceAgentMode,
      model: voiceModel,
      voiceAgentId,
      initialVisionSource: voiceInitialVisionSource,
    };
    setFloatingCallState(nextFloatingState);
    writeFloatingCallState(nextFloatingState);
  }, [
    followWindowMode,
    voiceOverlayOpen,
    voiceCallType,
    voiceSessionId,
    voiceExecutor,
    voiceAgentMode,
    voiceModel,
    voiceAgentId,
    voiceInitialVisionSource,
  ]);

  useEffect(() => {
    if (!followWindowMode || !voiceOverlayOpen) return;
    const heartbeat = globalThis.setInterval(() => {
      const nextFloatingState = {
        active: true,
        call: voiceCallType,
        sessionId: voiceSessionId,
        executor: voiceExecutor,
        mode: voiceAgentMode,
        model: voiceModel,
        voiceAgentId,
        initialVisionSource: voiceInitialVisionSource,
      };
      setFloatingCallState(nextFloatingState);
      writeFloatingCallState(nextFloatingState);
    }, FLOATING_CALL_HEARTBEAT_INTERVAL_MS);
    return () => globalThis.clearInterval(heartbeat);
  }, [
    followWindowMode,
    voiceOverlayOpen,
    voiceCallType,
    voiceSessionId,
    voiceExecutor,
    voiceAgentMode,
    voiceModel,
    voiceAgentId,
    voiceInitialVisionSource,
  ]);

  useEffect(() => {
    if (followWindowMode || floatingCallState?.active !== true) return;
    if (!isFloatingCallStateFresh(floatingCallState)) {
      const cleared = { active: false, call: floatingCallState?.call };
      setFloatingCallState(cleared);
      writeFloatingCallState(cleared);
      return;
    }
    const staleSweep = globalThis.setInterval(() => {
      setFloatingCallState((previous) => {
        if (!previous?.active || isFloatingCallStateFresh(previous)) return previous;
        const cleared = { active: false, call: previous?.call };
        writeFloatingCallState(cleared);
        return cleared;
      });
    }, FLOATING_CALL_HEARTBEAT_INTERVAL_MS);
    return () => globalThis.clearInterval(staleSweep);
  }, [followWindowMode, floatingCallState]);

  useEffect(() => {
    if (!followWindowMode) return;
    if (voiceOverlayOpen) {
      followOverlayOpenedRef.current = true;
      return;
    }
    if (!followOverlayOpenedRef.current) return;
    globalThis?.veDesktop?.follow?.hide?.().catch?.(() => {});
  }, [followWindowMode, voiceOverlayOpen]);

  useEffect(() => {
    const launch = parseVoiceLaunchFromUrl();
    if (!launch) return;
    let cancelled = false;

    const start = async () => {
      if (launch.tab === "chat") {
        const launchSessionId = String(launch.detail?.sessionId || "").trim();
        if (launchSessionId) {
          selectedSessionId.value = launchSessionId;
          navigateTo("chat", {
            params: { sessionId: launchSessionId },
            replace: true,
            skipGuard: true,
          });
        } else {
          navigateTo("chat", { replace: true, skipGuard: true });
        }
      }
      // Wait for UI components and the voice-mode event listener to mount.
      // Cold-start Electron windows need more time — JS bundles are still
      // being parsed.  We retry the dispatch up to 5 times with increasing
      // delays to ensure the listener is registered before we give up.
      const delays = [400, 600, 1000, 1500, 2000];
      for (const delay of delays) {
        if (cancelled) return;
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (cancelled) return;
        // Check if voice overlay is already open (a previous dispatch succeeded).
        // Use the ref to read current state — the closure-captured useState
        // value is stale inside this async loop.
        if (voiceOverlayOpenRef.current) return;
        globalThis.dispatchEvent?.(
          new CustomEvent("ve:open-voice-mode", { detail: launch.detail }),
        );
        // Brief wait to let the event handler run and update state
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };

    start()
      .catch(() => {})
      .finally(() => {
        scrubVoiceLaunchQuery();
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const openBrowserFollowWindow = useCallback((detail = {}) => {
    if (typeof globalThis?.open !== "function") {
      return { ok: false, reason: "Browser popup API is unavailable." };
    }
    const followUrl = buildBrowserFollowUrl(detail);
    if (!followUrl) {
      return { ok: false, reason: "Could not build follow window URL." };
    }
    const popup = globalThis.open(
      followUrl,
      "bosun-voice-follow",
      "popup=yes,width=420,height=680,resizable=yes,scrollbars=yes",
    );
    if (!popup) {
      return { ok: false, reason: "Popup blocked by browser." };
    }
    try { popup.focus(); } catch { /* best effort */ }
    return { ok: true };
  }, []);

  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const handleScroll = () => {
      const shouldShow = el.scrollTop > 280;
      if (shouldShow !== scrollVisibilityRef.current) {
        scrollVisibilityRef.current = shouldShow;
        setShowScrollTop(shouldShow);
      }
    };
    handleScroll();
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    if (!getTg()) return;
    const swipeTabs = TAB_CONFIG.filter((t) => t.id !== "settings" && !t.parent);
    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let tracking = false;
    let blocked = false;

    const onTouchStart = (e) => {
      if (e.touches.length !== 1) return;
      const target = e.target;
      blocked = shouldBlockTabSwipe(target, activeTab.value);
      if (blocked) return;
      tracking = true;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      startTime = Date.now();
    };

    const onTouchMove = (e) => {
      if (!tracking || blocked) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) {
        e.preventDefault();
      }
    };

    const onTouchEnd = (e) => {
      if (!tracking || blocked) return;
      tracking = false;
      const touch = e.changedTouches[0];
      if (!touch) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      const dt = Date.now() - startTime;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) || dt > 700) return;

      const currentIndex = swipeTabs.findIndex(
        (tab) => tab.id === activeTab.value,
      );
      if (currentIndex < 0) return;
      const direction = dx < 0 ? 1 : -1;
      const nextIndex = currentIndex + direction;
      if (nextIndex < 0 || nextIndex >= swipeTabs.length) return;
      navigateTo(swipeTabs[nextIndex].id);
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });

    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, []);

  const CurrentTab = TAB_COMPONENTS[activeTab.value] || DashboardTab;
  const isChatOrAgents = activeTab.value === "chat" || activeTab.value === "agents" || activeTab.value === "fleet-sessions";
  const isChat = activeTab.value === "chat";
  // The detached session rail only has wide-desktop CSS. Keep 1200-1399 in the
  // compact desktop layout so chat keeps its inline session pane.
  const showSessionRail = isWideDesktop && isChat;
  const showInspector = isDesktop && isChatOrAgents;
  const showBottomNav = !(isDesktop || isTablet);
  const railSessionType = "primary";
  const showDrawerToggles = isTablet;
  const showInspectorToggle = isTablet && isChatOrAgents;
  const showRestoreFloatingCall =
    isChat &&
    !followWindowMode &&
    isFloatingCallStateFresh(floatingCallState) &&
    (
      typeof globalThis?.veDesktop?.follow?.restore === "function"
      || typeof globalThis?.open === "function"
    );
  const floatingCallLabel =
    String(floatingCallState?.call || "").trim().toLowerCase() === "video"
      ? "Restore floating video call"
      : "Restore floating voice call";

  const shellStyle = isDesktop
    ? {
        "--rail-width": railCollapsed ? `${RAIL_ICON_WIDTH}px` : `${railWidth}px`,
        "--sidebar-width": sidebarCollapsed ? `${SIDEBAR_ICON_WIDTH}px` : undefined,
        "--inspector-width": `${inspectorWidth}px`,
      }
    : null;

  const toggleSidebar = useCallback(() => {
    setSidebarDrawerOpen((v) => !v);
    setInspectorDrawerOpen(false);
  }, []);

  const toggleSidebarCollapsed = useCallback(() => setSidebarCollapsed((v) => !v), []);

  const collapseRail = useCallback(() => {
    railWidthBeforeCollapseRef.current = railWidth;
    setRailCollapsed(true);
  }, [railWidth]);

  const expandRail = useCallback(() => {
    setRailCollapsed(false);
    setRailWidth(railWidthBeforeCollapseRef.current || 280);
  }, []);

  const toggleInspector = useCallback(() => {
    setInspectorDrawerOpen((v) => !v);
    setSidebarDrawerOpen(false);
  }, []);

  const closeDrawers = useCallback(() => {
    setSidebarDrawerOpen(false);
    setInspectorDrawerOpen(false);
  }, []);
  const inspectorToggleLabel = inspectorDrawerOpen
    ? "Close inspector"
    : "Open inspector";
  const inspectorToggleButton = showInspectorToggle
    ? html`
        <${Button}
          variant="text"
          size="small"
          class="tablet-toggle"
          onClick=${toggleInspector}
          aria-label=${inspectorToggleLabel}
        >
          <span class="btn-icon">${resolveIcon("clipboard")}</span>
          Inspector
        <//>
      `
    : null;
  const moreToggleButton = showDrawerToggles
    ? html`
        <${Button}
          variant="text"
          size="small"
          class="tablet-toggle"
          onClick=${toggleMore}
          aria-label=${isMoreOpen ? "Close navigation menu" : "Open navigation menu"}
        >
          ⋯ Navigation
        <//>
      `
    : null;

  return html`<${VeTheme}><${CssBaseline} />
    <div class="top-loading-bar" style="width: ${loadingPct}%; opacity: ${loadingVisible ? 1 : 0}"></div>
    <div
      class=${`app-shell${isDesktop ? " app-desktop-grid" : isTablet ? " app-tablet-grid" : ""}`}
      style=${shellStyle}
      data-tab=${activeTab.value}
      data-has-rail=${showSessionRail ? "true" : "false"}
      data-has-inspector=${showInspector ? "true" : "false"}
      data-sidebar-collapsed=${sidebarCollapsed ? "true" : undefined}
      data-rail-collapsed=${railCollapsed ? "true" : undefined}
    >
      <${SidebarNav} collapsed=${sidebarCollapsed} onToggle=${toggleSidebarCollapsed} />

      ${/* Sidebar drawer overlay for tablet */ ""}
      ${sidebarDrawerOpen && !isDesktop
        ? html`
            <div class="drawer-overlay" onClick=${closeDrawers}></div>
            <div class="drawer drawer-left">
              <${SidebarNav} />
            </div>
          `
        : null}

      ${/* Inspector drawer overlay for tablet */ ""}
      ${inspectorDrawerOpen && !isDesktop
        ? html`
            <div class="drawer-overlay" onClick=${closeDrawers}></div>
            <div class="drawer drawer-right">
              <${InspectorPanel}
                onResizeStart=${handleResizeStart}
                onResizeReset=${handleResizeReset}
                showResizer=${false}
              />
            </div>
          `
        : null}

      ${showSessionRail
        ? html`<${SessionRail}
            onResizeStart=${handleResizeStart}
            onResizeReset=${handleResizeReset}
            showResizer=${isDesktop && !railCollapsed}
            collapsed=${railCollapsed}
            onCollapse=${collapseRail}
            onExpand=${expandRail}
            sessionType=${railSessionType}
          />`
        : null}
      <div class="app-main">
        <div class="main-panel">
          <${Header} />

          ${/* Tablet action bar with drawer toggles */ ""}
          ${showDrawerToggles
            ? html`
                <div class="tablet-action-bar">
                  ${inspectorToggleButton}
                  ${moreToggleButton}
                </div>
              `
            : null}

          ${backendDown.value ? html`<${OfflineBanner} />` : null}
          <${ToastContainer} />
          <${CommandPalette} open=${paletteOpen} onClose=${paletteClose} />
          ${showShortcuts ? html`<${KeyboardShortcutsModal} onClose=${() => setShowShortcuts(false)} />` : null}
          <${PullToRefresh}
            onRefresh=${() => refreshTab(activeTab.value)}
            disabled=${activeTab.value === "chat"}
          >
            <main class=${`main-content${showBottomNav && isCompactNav ? " compact" : ""}`} ref=${mainRef}>
              <${TabErrorBoundary} key=${activeTab.value} tabName=${activeTab.value}>
                <${CurrentTab} />
              <//>
            </main>
          <//>
          ${showScrollTop &&
          html`
            <${Tooltip} title="Back to top">
              <${Fab}
                size="small"
                color="primary"
                sx=${{position: "absolute", bottom: 16, right: 16}}
                onClick=${() => {
                  mainRef.current?.scrollTo({ top: 0, behavior: "smooth" });
                }}
              >
                ↑
              </${Fab}>
            </${Tooltip}>
          `}
        </div>
      </div>
      ${showInspector
        ? html`<${InspectorPanel}
            onResizeStart=${handleResizeStart}
            onResizeReset=${handleResizeReset}
            showResizer=${isDesktop}
            collapsed=${inspectorCollapsed}
            onToggleCollapse=${() => setInspectorCollapsed((value) => !value)}
          />`
        : null}
    </div>
    ${showBottomNav
      ? html`<${BottomNav}
          compact=${isCompactNav}
          moreOpen=${isMoreOpen}
          onToggleMore=${toggleMore}
          onNavigate=${handleNavigate}
        />`
      : null}
    <${MoreSheet}
      open=${isMoreOpen}
      onClose=${closeMore}
      onNavigate=${handleNavigate}
      onOpenBot=${openBot}
    />
    <${BotControlsSheet}
      open=${isBotOpen}
      onClose=${closeBot}
    />
    ${showRestoreFloatingCall
      ? html`
          <${Fab}
            variant="extended"
            color="primary"
            size="medium"
            sx=${{position: "fixed", bottom: 80, right: 16, zIndex: 1100}}
            title=${floatingCallLabel}
            onClick=${async () => {
              try {
                if (typeof globalThis?.veDesktop?.follow?.restore === "function") {
                  const result = await globalThis.veDesktop.follow.restore();
                  if (!result?.ok) {
                    const nextFloatingState = { active: false, call: floatingCallState?.call };
                    setFloatingCallState(nextFloatingState);
                    writeFloatingCallState(nextFloatingState);
                    showToast("No floating call window is active.", "info");
                  }
                  return;
                }
                const popupResult = openBrowserFollowWindow({
                  call: floatingCallState?.call,
                  sessionId: floatingCallState?.sessionId,
                  initialVisionSource: floatingCallState?.initialVisionSource,
                  executor: floatingCallState?.executor,
                  mode: floatingCallState?.mode,
                  model: floatingCallState?.model,
                  voiceAgentId: floatingCallState?.voiceAgentId,
                });
                if (!popupResult.ok) {
                  showToast(
                    popupResult.reason || "Could not restore floating browser call window.",
                    "error",
                  );
                }
              } catch {
                showToast("Could not restore floating call window.", "error");
              }
            }}
          >
            ${resolveIcon("phone")}
            ${String(floatingCallState?.call || "").trim().toLowerCase() === "video"
              ? " Restore Video Call"
              : " Restore Voice Call"}
          </${Fab}>
        `
      : null}
    <${VoiceOverlay}
      visible=${voiceOverlayOpen}
      onClose=${() => setVoiceOverlayOpen(false)}
      onDismiss=${(detail = {}) => {
        const reason = String(detail?.reason || "").trim().toLowerCase();
        if (!followWindowMode && reason === "externalize") {
          if (externalizeInFlightRef.current) {
            return;
          }
          externalizeInFlightRef.current = true;
          const followDetail = {
            call: voiceCallType,
            sessionId: voiceSessionId,
            initialVisionSource: voiceInitialVisionSource,
            executor: voiceExecutor,
            mode: voiceAgentMode,
            model: voiceModel,
            voiceAgentId,
          };
          const desktopFollowApi = globalThis?.veDesktop?.follow;
          if (typeof desktopFollowApi?.open === "function") {
            desktopFollowApi
              .open(followDetail)
              .then((result) => {
                if (!result?.ok) {
                  showToast("Could not open floating call window.", "error");
                  return;
                }
                const nextFloatingState = {
                  active: true,
                  call: followDetail.call,
                  sessionId: followDetail.sessionId,
                  executor: followDetail.executor,
                  mode: followDetail.mode,
                  model: followDetail.model,
                  voiceAgentId: followDetail.voiceAgentId,
                  initialVisionSource: followDetail.initialVisionSource,
                };
                setFloatingCallState(nextFloatingState);
                writeFloatingCallState(nextFloatingState);
                setVoiceOverlayOpen(false);
              })
              .catch(() => showToast("Could not open floating call window.", "error"))
              .finally(() => {
                externalizeInFlightRef.current = false;
              });
            return;
          }
          const popupResult = openBrowserFollowWindow(followDetail);
          if (!popupResult.ok) {
            showToast(
              popupResult.reason || "Could not open floating browser call window.",
              "error",
            );
            externalizeInFlightRef.current = false;
            return;
          }
          const nextFloatingState = {
            active: true,
            call: followDetail.call,
            sessionId: followDetail.sessionId,
            executor: followDetail.executor,
            mode: followDetail.mode,
            model: followDetail.model,
            voiceAgentId: followDetail.voiceAgentId,
            initialVisionSource: followDetail.initialVisionSource,
          };
          setFloatingCallState(nextFloatingState);
          writeFloatingCallState(nextFloatingState);
          setVoiceOverlayOpen(false);
          externalizeInFlightRef.current = false;
          return;
        }
        externalizeInFlightRef.current = false;
        if (followWindowMode && globalThis?.veDesktop?.follow?.hide) {
          globalThis.veDesktop.follow.hide().catch(() => {});
          return;
        }
        setVoiceOverlayOpen(false);
      }}
      tier=${voiceTier}
      sessionId=${voiceSessionId}
      executor=${voiceExecutor}
      mode=${voiceAgentMode}
      model=${voiceModel}
      voiceAgentId=${voiceAgentId}
      onVoiceAgentChange=${(nextAgentId) => {
        setVoiceAgentId(String(nextAgentId || "").trim() || null);
      }}
      callType=${voiceCallType}
      initialVisionSource=${voiceInitialVisionSource}
      compact=${followWindowMode}
    />
  </${VeTheme}>`;
}

/* ─── Mount ─── */
const mountRoot = () => document.getElementById("app");
const signalAppMounted = () => {
  globalThis.__bosunAppMounted = true;
  globalThis.dispatchEvent?.(new Event("bosun:app-mounted"));
};
const mountApp = () => {
  const root = mountRoot();
  if (!root) return;
  preactRender(html`<${App} />`, root);
  signalAppMounted();
};
const remountApp = () => {
  const root = mountRoot();
  if (!root) return;
  try {
    preactRender(null, root);
  } catch {
    root.replaceChildren();
  }
  preactRender(html`<${App} />`, root);
  signalAppMounted();
};
globalThis.__veRemountApp = remountApp;
mountApp();
