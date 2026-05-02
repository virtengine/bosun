/* ─────────────────────────────────────────────────────────────
 *  VirtEngine Control Center – Router / Tab Navigation
 *  Manages active tab, history stack, and Telegram BackButton
 * ────────────────────────────────────────────────────────────── */

import { signal } from "@preact/signals";
import { haptic, showBackButton, hideBackButton } from "./telegram.js";
import { refreshTab, hasPendingChanges } from "./state.js";

/** Currently active tab ID */
export const activeTab = signal("dashboard");
export const routeParams = signal({});

/** Navigation history stack (for back button) */
const tabHistory = [];

const ROUTE_TABS = new Set([
  "dashboard",
  "tasks",
  "benchmarks",
  "chat",
  "workflows",
  "manual-flows",
  "agents",
  "fleet-sessions",
  "control",
  "infra",
  "logs",
  "library",
  "marketplace",
  "telemetry",
  "settings",
  "guardrails",
]);

function getParentTab(tabId) {
  const tab = TAB_CONFIG.find((entry) => entry.id === tabId);
  return tab?.parent || null;
}

function hasBackTarget(tabId = activeTab.value) {
  return tabHistory.length > 0 || Boolean(getParentTab(tabId));
}

function normalizePath(path) {
  const raw = String(path || "/").trim();
  if (!raw) return "/";
  const clean = raw.split("?")[0].split("#")[0] || "/";
  const normalized = clean.startsWith("/") ? clean : `/${clean}`;
  if (normalized.length > 1 && normalized.endsWith("/")) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

function buildPath(tab, params = {}) {
  const clean = params && typeof params === "object" ? params : {};
  if (tab === "dashboard") return "/";
  if (tab === "tasks") {
    const taskId = String(clean.taskId || "").trim();
    return taskId ? `/tasks/${encodeURIComponent(taskId)}` : "/tasks";
  }
  if (tab === "chat") {
    const sessionId = String(clean.sessionId || "").trim();
    return sessionId ? `/chat/${encodeURIComponent(sessionId)}` : "/chat";
  }
  if (tab === "workflows") {
    const runId = String(clean.runId || "").trim();
    if (runId) return `/workflows/runs/${encodeURIComponent(runId)}`;
    if (clean.runsView) return "/workflows/runs";
    const workflowId = String(clean.workflowId || "").trim();
    return workflowId ? `/workflows/${encodeURIComponent(workflowId)}` : "/workflows";
  }
  return `/${tab}`;
}

function parsePath(pathname) {
  const path = normalizePath(pathname);
  if (path === "/" || path === "/dashboard") {
    return { tab: "dashboard", params: {} };
  }
  const segments = path.split("/").filter(Boolean);
  const [head, second, third] = segments;
  if (!head) return { tab: "dashboard", params: {} };
  if (!ROUTE_TABS.has(head)) return { tab: "dashboard", params: {} };
  if (head === "tasks") {
    return { tab: "tasks", params: second ? { taskId: decodeURIComponent(second) } : {} };
  }
  if (head === "chat") {
    return { tab: "chat", params: second ? { sessionId: decodeURIComponent(second) } : {} };
  }
  if (head === "workflows") {
    if (second === "runs") {
      return {
        tab: "workflows",
        params: third ? { runsView: true, runId: decodeURIComponent(third) } : { runsView: true },
      };
    }
    return {
      tab: "workflows",
      params: second ? { workflowId: decodeURIComponent(second) } : {},
    };
  }
  return { tab: head, params: {} };
}

function paramsEqual(a = {}, b = {}) {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((key) => String(a[key]) === String(b[key]));
}

function shouldAllowNavigation() {
  if (!hasPendingChanges.value) return true;
  if (typeof window === "undefined" || typeof window.confirm !== "function") return true;
  return window.confirm(
    "You have unsaved changes. Leave this view and discard those changes?",
  );
}

/**
 * Navigate to a new tab. Pushes current tab onto the history stack
 * and refreshes data for the target tab.
 * @param {string} tab
 * @param {{ resetHistory?: boolean, forceRefresh?: boolean }} [opts]
 */
export function navigateTo(tab, opts = {}) {
  const {
    resetHistory = false,
    forceRefresh = false,
    params = null,
    replace = false,
    fromPopState = false,
    skipGuard = false,
  } = opts;
  const nextParams = params == null ? routeParams.value : params;
  const goingHome = tab === "dashboard";
  const shouldReset = resetHistory || goingHome;
  const tabUnchanged = tab === activeTab.value;
  const paramsUnchanged = paramsEqual(routeParams.value, nextParams);

  if (!skipGuard && !fromPopState && (!tabUnchanged || !paramsUnchanged)) {
    if (!shouldAllowNavigation()) return false;
  }

  if (tabUnchanged && paramsUnchanged) {
    if (forceRefresh) refreshTab(tab, { force: true });
    if (shouldReset) {
      tabHistory.length = 0;
      hideBackButton();
    }
    return true;
  }

  haptic("light");
  if (!fromPopState && shouldReset) {
    tabHistory.length = 0;
  } else if (!fromPopState && !tabUnchanged) {
    tabHistory.push(activeTab.value);
  }
  activeTab.value = tab;
  routeParams.value = nextParams || {};
  refreshTab(tab, forceRefresh ? { force: true } : undefined);

  if (!fromPopState && typeof window !== "undefined" && window.history) {
    const targetPath = buildPath(tab, routeParams.value);
    const state = { tab, params: routeParams.value };
    if (replace) window.history.replaceState(state, "", targetPath);
    else window.history.pushState(state, "", targetPath);
  }

  // ── Umami analytics: track virtual page views per tab ──────
  // This lets us see which components/views get the most use.
  try {
    if (typeof window.umami !== "undefined") {
      window.umami.track((props) => ({
        ...props,
        url: `/${tab}`,
        title: `Bosun — ${tab}`,
      }));
    }
  } catch { /* analytics failure must never break navigation */ }

  // Show Telegram BackButton when there is history or a parent tab fallback.
  if (hasBackTarget(tab)) {
    showBackButton(goBack);
  } else {
    hideBackButton();
  }
  return true;
}

// Expose navigateTo globally for demo bot menu integration
if (typeof globalThis !== "undefined") {
  globalThis.__bosunSetTab = (tab) => navigateTo(tab);
}

/**
 * Go back to the previous tab (from history stack).
 */
export function goBack() {
  const prev = tabHistory.pop();
  const fallbackParent = getParentTab(activeTab.value);
  const targetTab = prev || fallbackParent;
  if (targetTab) {
    haptic("light");
    activeTab.value = targetTab;
    routeParams.value = {};
    refreshTab(targetTab);
    if (typeof window !== "undefined" && window.history?.replaceState) {
      window.history.replaceState(
        { tab: targetTab, params: {} },
        "",
        buildPath(targetTab, {}),
      );
    }
  }
  if (!hasBackTarget()) {
    hideBackButton();
  }
}

export function setRouteParams(params = {}, opts = {}) {
  const next = params && typeof params === "object" ? params : {};
  return navigateTo(activeTab.value, {
    ...opts,
    params: next,
    replace: opts.replace !== false,
    skipGuard: opts.skipGuard ?? true,
  });
}

export function shouldBlockTabSwipe(target, tabId = activeTab.value) {
  if (tabId === "workflows") return true;
  if (!target || typeof target.closest !== "function") return false;
  return Boolean(
    target.closest(".kanban-board") ||
    target.closest(".kanban-cards") ||
    target.closest(".chat-messages") ||
    target.closest(".wf-canvas-container") ||
    target.closest(".wf-config-panel") ||
    target.closest(".wf-palette") ||
    target.closest(".wf-context-menu"),
  );
}

/**
 * Ordered list of tabs with metadata for rendering the navigation UI.
 * The `icon` key maps to a property on the ICONS object in modules/icons.js.
 */
export const TAB_CONFIG = [
  { id: "dashboard", label: "Pulse", icon: "grid" },
  { id: "tasks", label: "Work", icon: "check" },
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "workflows", label: "Flows", icon: "workflow" },
  { id: "agents", label: "Fleet", icon: "cpu" },
  { id: "fleet-sessions", label: "Sessions", icon: "chat", parent: "agents" },
  { id: "control", label: "Control", icon: "sliders" },
  { id: "infra", label: "Infra", icon: "server" },
  { id: "logs", label: "Logs", icon: "terminal" },
  { id: "library", label: "Library", icon: "book" },
  { id: "marketplace", label: "Market", icon: "box" },
  { id: "manual-flows", label: "Run Flows", icon: "zap" },
  { id: "telemetry", label: "Telemetry", icon: "chart" },
  { id: "benchmarks", label: "Bench", icon: "chart" },
  { id: "guardrails", label: "Guardrails", icon: "shield" },
  { id: "settings", label: "Settings", icon: "settings" },
];

if (typeof window !== "undefined") {
  try {
    const initial = parsePath(window.location.pathname);
    activeTab.value = initial.tab;
    routeParams.value = initial.params;
    window.history.replaceState(
      { tab: initial.tab, params: initial.params },
      "",
      buildPath(initial.tab, initial.params),
    );
    window.addEventListener("popstate", () => {
      const route = parsePath(window.location.pathname);
      navigateTo(route.tab, {
        fromPopState: true,
        params: route.params,
        resetHistory: false,
        forceRefresh: false,
        skipGuard: true,
      });
    });
    if (hasBackTarget(initial.tab)) showBackButton(goBack);
    else hideBackButton();
  } catch {
    /* noop */
  }
}
