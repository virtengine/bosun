/* ─────────────────────────────────────────────────────────────
 *  Tab: Dashboard — overview stats, executor, quick actions
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

import { haptic, showConfirm, showAlert } from "../modules/telegram.js";
import { apiFetch, sendCommandToChat } from "../modules/api.js";
import {
  statusData,
  executorData,
  tasksData,
  tasksLoaded,
  tasksStatusCounts,
  projectSummary,
  loadStatus,
  loadTasks,
  loadProjectSummary,
  loadRetryQueue,
  showToast,
  refreshTab,
  runOptimistic,
  scheduleRefresh,
  getTrend,
  getDashboardHistory,
  setPendingChange,
  clearPendingChange,
  retryQueueData,
  KANBAN_PAGE_SIZE,
} from "../modules/state.js";
import { navigateTo } from "../modules/router.js";
import { ICONS } from "../modules/icons.js";
import {
  cloneValue,
  formatRelative,
  truncate,
  countChangedFields,
} from "../modules/utils.js";
import { buildWorktreeRecoveryViewModel } from "../modules/worktree-recovery.js";
import { iconText, resolveIcon } from "../modules/icon-utils.js";
import {
  Card,
  Badge,
  SkeletonCard,
  Modal,
  EmptyState,
  SaveDiscardBar,
} from "../components/shared.js";
import { DonutChart, ProgressBar, MiniSparkline } from "../components/charts.js";
import {
  SegmentedControl,
  PullToRefresh,
  SliderControl,
} from "../components/forms.js";
import { StartTaskModal } from "./tasks.js";
import { CommitGraph } from "../components/commit-graph.js";
import {
  Button, TextField, Typography, Box, Stack, Chip, Paper,
  IconButton, Tooltip, CircularProgress, Alert, Skeleton,
} from "@mui/material";

/* ─── Quick Action definitions ─── */
const QUICK_ACTIONS = [
  {
    label: "Status",
    cmd: "/status",
    icon: "chart",
    color: "var(--accent)",
    targetTab: "dashboard",
  },
  {
    label: "Health",
    cmd: "/health",
    icon: "heart",
    color: "var(--color-done)",
    targetTab: "dashboard",
  },
  {
    label: "Create Task",
    action: "create",
    icon: "plus",
    color: "var(--color-inprogress)",
  },
  {
    label: "Start Task",
    action: "start",
    icon: "play",
    color: "var(--color-todo)",
  },
  {
    label: "Plan",
    cmd: "/plan",
    icon: "clipboard",
    color: "var(--color-inreview)",
    targetTab: "control",
  },
  {
    label: "Logs",
    cmd: "/logs 50",
    icon: "file",
    color: "var(--text-secondary)",
    targetTab: "logs",
  },
  {
    label: "Menu",
    cmd: "/menu",
    icon: "menu",
    color: "var(--color-todo)",
    targetTab: "control",
  },
];

/* ─── AnimatedNumber ─── */
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
      const eased = 1 - Math.pow(1 - t, 3);
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

function normalizeCommitMessage(message) {
  const text = String(message || "").trim();
  if (!text) return "";
  return text.replace(
    /^([a-z]+)\(([A-Za-z0-9._/-]+)\)(!?)(\s*:)/,
    (_m, type, scope, bang, suffix) => type + "(" + scope.toLowerCase() + ")" + bang + suffix,
  );
}

function getHarnessRunState(run) {
  return String(
    run?.health?.state
    || run?.status
    || run?.outcome
    || run?.result?.status
    || run?.result?.outcome
    || "unknown",
  ).trim().toLowerCase();
}

function getHarnessStateTone(state) {
  if (state === "working") return "info";
  if (state === "waiting") return "warning";
  if (state === "stalled" || state === "failed" || state === "aborted") return "error";
  if (state === "completed") return "success";
  return "default";
}

function getHarnessStateColor(state) {
  if (state === "working") return "var(--color-inprogress)";
  if (state === "waiting") return "var(--color-inreview)";
  if (state === "stalled" || state === "failed" || state === "aborted") return "var(--color-error)";
  if (state === "completed") return "var(--color-done)";
  return "var(--text-secondary)";
}

function formatHarnessStateLabel(state) {
  return String(state || "unknown").replace(/[_-]+/g, " ");
}

function formatHarnessStage(run) {
  return String(
    run?.currentStageId
    || run?.health?.approvalStageId
    || run?.stageId
    || run?.completedStageId
    || run?.result?.completedStageId
    || "—",
  ).trim() || "—";
}

function getHarnessRunTimestamp(run) {
  const value = run?.updatedAt || run?.endedAt || run?.startedAt || run?.createdAt || 0;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function getHarnessApprovalRequestId(run) {
  return String(
    run?.health?.approvalRequestId
    || run?.approvalRequestId
    || run?.requestId
    || run?.latestApproval?.requestId
    || "",
  ).trim();
}

function getHarnessAttentionDetail(run) {
  const state = getHarnessRunState(run);
  const detail = String(
    run?.health?.attentionReason
    || run?.health?.lastEventSummary
    || run?.latestEvent?.summary
    || run?.summary
    || "",
  ).trim();
  if (state === "waiting") {
    const requestId = getHarnessApprovalRequestId(run);
    const base = detail || "Awaiting operator approval.";
    return requestId ? `${base} · ${requestId}` : base;
  }
  return detail || "No summary yet";
}

function normalizeHarnessRuns(items) {
  const deduped = new Map();
  for (const run of Array.isArray(items) ? items : []) {
    if (!run || typeof run !== "object") continue;
    const runId = String(run?.runId || "").trim();
    if (!runId) continue;
    const existing = deduped.get(runId);
    if (!existing || getHarnessRunTimestamp(run) >= getHarnessRunTimestamp(existing)) {
      deduped.set(runId, run);
    }
  }
  return Array.from(deduped.values()).sort((a, b) => getHarnessRunTimestamp(b) - getHarnessRunTimestamp(a));
}

/* ─── CreateTaskModal ─── */
export function CreateTaskModal({ onClose }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("medium");
  const [submitting, setSubmitting] = useState(false);
  const initialSnapshotRef = useRef({
    title: "",
    description: "",
    priority: "medium",
  });
  const pendingKey = "modal:create-task-dashboard";

  const currentSnapshot = useMemo(
    () => ({
      title: title || "",
      description: description || "",
      priority: priority || "medium",
    }),
    [description, priority, title],
  );
  const changeCount = useMemo(
    () => countChangedFields(initialSnapshotRef.current, currentSnapshot),
    [currentSnapshot],
  );
  const hasUnsaved = changeCount > 0;

  useEffect(() => {
    setPendingChange(pendingKey, hasUnsaved);
    return () => clearPendingChange(pendingKey);
  }, [hasUnsaved]);

  const resetToInitial = useCallback(() => {
    const base = initialSnapshotRef.current || {};
    setTitle(base.title || "");
    setDescription(base.description || "");
    setPriority(base.priority || "medium");
    showToast("Changes discarded", "info");
  }, []);

  const handleSubmit = useCallback(async ({ closeAfterSave = true } = {}) => {
    if (!title.trim()) {
      showToast("Title is required", "error");
      return false;
    }
    setSubmitting(true);
    haptic("medium");
    try {
      await apiFetch("/api/tasks/create", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          priority,
        }),
      });
      showToast("Task created", "success");
      initialSnapshotRef.current = {
        title: title.trim(),
        description: description.trim(),
        priority,
      };
      if (closeAfterSave) {
        onClose?.();
      }
      await refreshTab("dashboard");
      return closeAfterSave ? { closed: true } : true;
    } catch {
      /* toast shown by apiFetch */
      return false;
    } finally {
      setSubmitting(false);
    }
  }, [title, description, priority, onClose]);

  /* Telegram MainButton integration */
  useEffect(() => {
    const tg = globalThis.Telegram?.WebApp;
    if (tg?.MainButton) {
      tg.MainButton.setText("Create Task");
      tg.MainButton.show();
      const handler = () => {
        void handleSubmit({ closeAfterSave: true });
      };
      tg.MainButton.onClick(handler);
      return () => {
        tg.MainButton.hide();
        tg.MainButton.offClick(handler);
      };
    }
  }, [handleSubmit]);

  return html`
    <${Modal}
      title="Create Task"
      onClose=${onClose}
      unsavedChanges=${changeCount}
      onSaveBeforeClose=${() => handleSubmit({ closeAfterSave: true })}
      onDiscardBeforeClose=${() => {
        resetToInitial();
        return true;
      }}
      activeOperationLabel=${submitting ? "Task creation is in progress" : ""}
    >
      <div class="flex-col gap-md">
        <${TextField}
          size="small"
          variant="outlined"
          fullWidth
          placeholder="Task title"
          value=${title}
          onInput=${(e) => setTitle(e.target.value)}
        />
        <${TextField}
          multiline
          rows=${4}
          size="small"
          fullWidth
          variant="outlined"
          placeholder="Description (optional)"
          value=${description}
          onInput=${(e) => setDescription(e.target.value)}
        />
        <div class="card-subtitle">Priority</div>
        <${SegmentedControl}
          options=${[
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
            { value: "critical", label: "Critical" },
          ]}
          value=${priority}
          onChange=${(v) => {
            haptic();
            setPriority(v);
          }}
        />
        <${Button}
          variant="contained"
          size="small"
          onClick=${() => {
            void handleSubmit({ closeAfterSave: true });
          }}
          disabled=${submitting}
        >
          ${submitting ? "Creating…" : "Create Task"}
        <//>
        <${SaveDiscardBar}
          dirty=${hasUnsaved}
          message=${`You have unsaved changes (${changeCount})`}
          saveLabel="Create Task"
          discardLabel="Discard"
          onSave=${() => {
            void handleSubmit({ closeAfterSave: false });
          }}
          onDiscard=${resetToInitial}
          saving=${submitting}
        />
      </div>
    <//>
  `;
}

/* ─── DashboardTab ─── */
export function DashboardTab() {
  const [showCreate, setShowCreate] = useState(false);
  const [showStartModal, setShowStartModal] = useState(false);
  const [uptime, setUptime] = useState(null);
  const [healthStats, setHealthStats] = useState(null);
  // New state
  const [now, setNow] = useState(() => new Date());
  const [recentCommits, setRecentCommits] = useState([]);
  const [flashKey, setFlashKey] = useState(0);
  const [commitSearch, setCommitSearch] = useState("");
  const [activitySearch, setActivitySearch] = useState("");
  const [healthStatsReady, setHealthStatsReady] = useState(false);
  const [harnessRuns, setHarnessRuns] = useState([]);
  const prevCounts = useRef(null);
  const status = statusData.value;
  const executor = executorData.value;
  const retryQueue = retryQueueData.value || { count: 0, items: [], stats: {} };
  const project = projectSummary.value;
  const counts = status?.counts || {};
  const summary = status?.success_metrics || {};
  const execData = executor?.data;
  const mode = executor?.mode || "internal";
  const defaultSdk = execData?.sdk || "auto";
  const liveTaskCounts = tasksStatusCounts.value || {};
  const useLiveTaskCounts = Boolean(tasksLoaded.value);
  const worktreeRecovery = buildWorktreeRecoveryViewModel(
    status?.worktreeRecovery || status?.worktree_recovery || null,
  );
  const sessionHealth = status?.sessionHealth && typeof status.sessionHealth === "object"
    ? status.sessionHealth
    : {};
  const durableContext = status?.context && typeof status.context === "object"
    ? status.context
    : {};
  const toolSummary = status?.toolSummary && typeof status.toolSummary === "object"
    ? status.toolSummary
    : {};
  const topRuntimeTool = Array.isArray(toolSummary.topTools) ? toolSummary.topTools[0] : null;
  const harnessActiveCount = harnessRuns.filter((run) => run?.active === true || getHarnessRunState(run) === "working").length;
  const harnessWaitingCount = harnessRuns.filter((run) => run?.approvalPending === true || run?.health?.waitingForOperator === true || getHarnessRunState(run) === "waiting").length;
  const harnessStalledCount = harnessRuns.filter((run) => getHarnessRunState(run) === "stalled").length;
  const harnessAttentionRuns = harnessRuns.filter((run) => {
    const state = getHarnessRunState(run);
    return ["waiting", "stalled", "failed", "aborted", "stop_requested"].includes(state)
      || run?.approvalPending === true
      || run?.health?.waitingForOperator === true;
  });
  const harnessVisibleRuns = (harnessAttentionRuns.length ? harnessAttentionRuns : harnessRuns).slice(0, 4);

  const running = useLiveTaskCounts
    ? Number(liveTaskCounts.inProgress || 0)
    : Number(counts.running || counts.inprogress || 0);
  const review = useLiveTaskCounts
    ? Number(liveTaskCounts.inReview || 0)
    : Number(counts.review || counts.inreview || 0);
  const blocked = useLiveTaskCounts
    ? Number(liveTaskCounts.blocked || 0)
    : Number(counts.blocked ?? counts.error ?? 0);
  const done = useLiveTaskCounts
    ? Number(liveTaskCounts.done || 0)
    : Number(counts.done || 0);
  const backlog = useLiveTaskCounts
    ? Number(liveTaskCounts.backlog || 0) + Number(liveTaskCounts.draft || 0)
    : Number(status?.backlog_remaining || counts.todo || 0);
  const totalTasks = running + review + blocked + backlog + done;
  const errorRateValue = totalTasks > 0 ? (blocked / totalTasks) * 100 : 0;
  const errorRate = errorRateValue.toFixed(1);

  const totalActive = running + review + blocked;
  const progressPct =
    backlog + totalActive > 0
      ? Math.round((totalActive / (backlog + totalActive)) * 100)
      : 0;
  const slotPct = execData?.maxParallel
    ? ((execData.activeSlots || 0) / execData.maxParallel) * 100
    : 0;

  // ── Health score (0–100) based on real 6h run history ──
  let healthScore = 100;
  if (executor?.paused) healthScore -= 20;
  if (healthStats?.total > 0) {
    // Primary signal: failure rate over last 6 hours
    healthScore -= Math.min(50, Math.round(healthStats.failRate * 60));
  } else {
    // No run history yet — fall back to current snapshot blocked ratio
    healthScore -= Math.min(30, Math.round(errorRateValue * 1.5));
  }
  if ((execData?.activeSlots ?? 0) === 0 && backlog > 0) healthScore -= 10;
  if (blocked > 0) healthScore -= Math.min(15, blocked * 5);
  if (slotPct > 50 && blocked === 0 && (!healthStats || healthStats.failRate < 0.1)) healthScore += 5;
  healthScore = Math.min(100, Math.max(0, Math.round(healthScore)));

  // ── Clock ──
  const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const tzStr = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const headerLine = `${totalActive} active · ${backlog} backlog · ${done} done${
    blocked ? ` · ${blocked} blocked` : ""
  }`;
  const headerScopeLabel = useLiveTaskCounts ? "Workspace-scoped totals" : "Runtime snapshot totals";

  // ── Dynamic headline ──
  const headline =
    totalActive === 0
      ? "Fleet idle"
      : blocked > 0
        ? "Needs attention"
        : "All systems running";
  const headlineClass =
    totalActive === 0
      ? "dashboard-headline-idle"
      : blocked > 0
        ? "dashboard-headline-warn"
        : "dashboard-headline-ok";

  // ── Hero badge: all tasks done and nothing pending ──
  const fleetAtRest = totalTasks > 0 && done > 0 && backlog === 0 && totalActive === 0;

  // ── Uptime fetch on mount ──
  useEffect(() => {
    let active = true;
    apiFetch("/api/health", { _silent: true })
      .then((res) => {
        if (!active) return;
        const secs = Number(res?.uptime || 0);
        if (!secs) return;
        const d = Math.floor(secs / 86400);
        const h = Math.floor((secs % 86400) / 3600);
        const m = Math.floor((secs % 3600) / 60);
        const parts = [];
        if (d > 0) parts.push(`${d}d`);
        if (h > 0) parts.push(`${h}h`);
        if (m > 0 && d === 0) parts.push(`${m}m`);
        setUptime(parts.length ? `up ${parts.join(" ")}` : "up < 1m");
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  // ── 6-hour run health stats (refreshes every 30s) ──
  useEffect(() => {
    let active = true;
    const fetch6h = () => {
      apiFetch("/api/health-stats", { _silent: true })
        .then((res) => { if (active && res?.ok) setHealthStats(res); })
        .catch(() => {});
    };
    fetch6h();
    const t = setInterval(fetch6h, 30_000);
    return () => { active = false; clearInterval(t); };
  }, []);

  // ── Listen for ve:create-task keyboard shortcut ──
  useEffect(() => {
    const handler = () => setShowCreate(true);
    window.addEventListener("ve:create-task", handler);
    return () => window.removeEventListener("ve:create-task", handler);
  }, []);

  // ── Real-time clock ──
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setHealthStatsReady(true), 500);
    return () => clearTimeout(t);
  }, []);

  // ── Recent commits (graceful 404) ──
  useEffect(() => {
    apiFetch("/api/recent-commits", { _silent: true })
      .then((res) => {
        const commits = Array.isArray(res?.data)
          ? res.data
          : Array.isArray(res)
            ? res
            : [];
        setRecentCommits(commits.slice(0, 10));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadRetryQueue().catch(() => {});
  }, []);

  useEffect(() => {
    let active = true;
    const loadHarnessMonitor = () => {
      apiFetch("/api/harness/runs?limit=8", { _silent: true })
        .then((res) => {
          if (!active) return;
          setHarnessRuns(normalizeHarnessRuns(res?.items || res?.runs || []));
        })
        .catch(() => {
          if (active) setHarnessRuns([]);
        });
    };
    loadHarnessMonitor();
    const timer = setInterval(loadHarnessMonitor, 15_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    loadTasks({ pageSize: KANBAN_PAGE_SIZE }).catch(() => {});
  }, []);

  // ── Flash metrics on counts change ──
  useEffect(() => {
    const current = JSON.stringify(counts);
    const previous = JSON.stringify(prevCounts.current);
    if (previous !== current) {
      prevCounts.current = counts;
      setFlashKey((k) => k + 1);
    }
  });

  const overviewMetrics = [
    {
      label: "Total tasks",
      value: totalTasks,
      color: "var(--text-primary)",
      trend: getTrend("total"),
      spark: "total",
      tab: "tasks",
    },
    {
      label: "In progress",
      value: running,
      color: "var(--color-inprogress)",
      trend: getTrend("running"),
      spark: "running",
      tab: "tasks",
    },
    {
      label: "Done",
      value: done,
      color: "var(--color-done)",
      trend: getTrend("done"),
      spark: "done",
      tab: "tasks",
    },
    {
      label: "Error rate",
      value: `${errorRate}%`,
      color: "var(--color-error)",
      trend: -getTrend("errors"),
      spark: "errors",
      tab: "tasks",
    },
  ];

  // ── Live fleet ticker data (3 most recent tasks) ──
  const tickerTasks = (tasksData.value || []).slice(0, 3);

  const workItems = [
    { label: "Running", value: running, color: "var(--color-inprogress)" },
    { label: "Review", value: review, color: "var(--color-inreview)" },
    { label: "Backlog", value: backlog, color: "var(--color-todo)" },
    { label: "Done", value: done, color: "var(--color-done)" },
  ];

  const alertItems = [
    {
      label: "Blocked tasks",
      value: blocked,
      tone: blocked > 0 ? "error" : "ok",
    },
    {
      label: "Error rate",
      value: `${errorRate}%`,
      tone: errorRateValue > 0 ? "warning" : "ok",
    },
  ];
  const hasAlerts = alertItems.some((item) => item.tone !== "ok");

  const qualityItems = [
    {
      label: "First-shot",
      value: `${summary.first_shot_rate ?? 0}%`,
      tone: "good",
    },
    {
      label: "Needed Fix",
      value: summary.needed_fix ?? 0,
      tone: "warn",
    },
    {
      label: "Failed",
      value: summary.failed ?? 0,
      tone: "error",
    },
  ];

  /* Trend indicator helper */
  const trend = (val) =>
    val > 0
      ? html`<span class="stat-trend up">▲</span>`
      : val < 0
        ? html`<span class="stat-trend down">▼</span>`
        : null;

  /* Historical sparkline data */
  const history = getDashboardHistory();
  const sparkData = (metric) => history.map((h) => h[metric] ?? 0);

  const segments = [
    { label: "Running", value: running, color: "var(--color-inprogress)" },
    { label: "Review", value: review, color: "var(--color-inreview)" },
    { label: "Blocked", value: blocked, color: "var(--color-error)" },
    { label: "Backlog", value: backlog, color: "var(--color-todo)" },
    { label: "Done", value: done, color: "var(--color-done)" },
  ].filter((s) => s.value > 0);

  /* ── Executor controls ── */
  const handlePause = async () => {
    haptic("medium");
    const confirmed = await showConfirm(
      "Pause the executor? Active tasks will finish but no new ones will start.",
    );
    if (!confirmed) return;
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

  /* ── Quick-action handler ── */
  const handleQuickAction = async (action, e) => {
    haptic();
    if (action.targetTab) {
      navigateTo(action.targetTab, {
        resetHistory: action.targetTab === "dashboard",
        forceRefresh: true,
      });
    }
    if (action.action === "create") {
      setShowCreate(true);
    } else if (action.action === "start") {
      setShowStartModal(true);
    } else if (action.cmd) {
      try {
        if (action.cmd.startsWith("/status")) {
          await refreshTab("dashboard", { force: true });
          showToast("Status refreshed", "success");
        } else if (action.cmd.startsWith("/health")) {
          const res = await apiFetch("/api/health", { _silent: true });
          const uptime = Number(res?.uptime || 0);
          showToast(`Health OK · uptime ${Math.round(uptime)}s`, "success");
        } else if (action.cmd.startsWith("/logs")) {
          await refreshTab("logs", { force: true });
          showToast("Opened logs", "success");
        } else if (action.cmd.startsWith("/menu")) {
          await sendCommandToChat(action.cmd);
          showToast("Opened control panel", "success");
          scheduleRefresh(60);
        } else if (action.cmd.startsWith("/plan")) {
          await sendCommandToChat(action.cmd);
          showToast("Planner dispatched", "success");
          scheduleRefresh(120);
        } else {
          await sendCommandToChat(action.cmd);
          showToast(`Sent: ${action.cmd}`, "success");
          scheduleRefresh(120);
        }
        const btn = e?.currentTarget;
        if (btn) {
          btn.classList.add("quick-action-sent");
          setTimeout(() => btn.classList.remove("quick-action-sent"), 1500);
        }
      } catch {
        showToast("Command failed", "error");
      }
    }
  };

  const handleModalStart = useCallback(async ({ taskId, sdk, model }) => {
    if (!taskId) return;
    await apiFetch("/api/tasks/start", {
      method: "POST",
      body: JSON.stringify({
        taskId,
        ...(sdk ? { sdk } : {}),
        ...(model ? { model } : {}),
      }),
    });
    showToast("Task started", "success");
    scheduleRefresh(150);
  }, []);

  const recentTasks = (tasksData.value || []).slice(0, 8);
  const filteredTasks = activitySearch
    ? recentTasks.filter((t) => {
        const q = activitySearch.toLowerCase();
        return (t.title || "").toLowerCase().includes(q) || (t.id || "").toLowerCase().includes(q);
      })
    : recentTasks;
  const filteredCommits = commitSearch
    ? recentCommits.filter((c) => {
        const q = commitSearch.toLowerCase();
        const msg = c.message || c.msg || c.subject || "";
        return msg.toLowerCase().includes(q);
      })
    : recentCommits;
  const retryItems = Array.isArray(retryQueue.items) ? retryQueue.items : [];

  const formatRetryCountdown = useCallback((nextAttemptAt) => {
    const target = Number(nextAttemptAt || 0);
    if (!Number.isFinite(target) || target <= 0) return "Now";
    const remainingMs = target - now.getTime();
    if (remainingMs <= 0) return "Now";
    const totalSec = Math.ceil(remainingMs / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (min > 0) return `${min}m ${String(sec).padStart(2, "0")}s`;
    return `${sec}s`;
  }, [now]);

  const handleRetryNow = useCallback(async (taskId) => {
    const id = String(taskId || "").trim();
    if (!id) return;
    try {
      await apiFetch("/api/tasks/retry", {
        method: "POST",
        body: JSON.stringify({ taskId: id }),
      });
      showToast(`Retry requested for ${id}`, "success");
      scheduleRefresh(100);
    } catch {
      /* toast shown by apiFetch */
    }
  }, []);

  if (!status && !executor)
    return html`
      <div class="dashboard-shell">
        <div class="dashboard-grid">
          ${Array.from({ length: 6 }, (_, i) => html`<${SkeletonCard} key=${i} />`)}
        </div>
      </div>
    `;

  /* ── Welcome empty state ── */
  if (totalTasks === 0 && !executor) {
    return html`
      <div class="dashboard-shell">
        <${Card} className="dashboard-card">
          <div class="dashboard-welcome-card">
            <div class="dashboard-welcome-icon">${resolveIcon("sliders")}</div>
            <div class="dashboard-welcome-title">Welcome to VirtEngine Control Center</div>
            <div class="dashboard-welcome-desc">
              Your AI development fleet is ready. Create your first task to get started.
            </div>
            <${Button} variant="contained" size="small" onClick=${() => setShowCreate(true)}>
              ${iconText(":plus: Create your first task")}
            <//>
          </div>
        <//>
        ${showCreate &&
          html`<${CreateTaskModal} onClose=${() => setShowCreate(false)} />`}
      </div>
    `;
  }

  return html`
    <div class="dashboard-shell">
      <div class="dashboard-header" role="banner" aria-label="Dashboard status header">
        <div class="dashboard-header-text">
          <div class="dashboard-eyebrow">Pulse</div>
          <h1 class="dashboard-title ${headlineClass}">${headline}</h1>
          <div class="dashboard-subtitle">${headerLine}</div>
          <div class="dashboard-meta-copy">${headerScopeLabel}</div>
        </div>
        <div class="dashboard-header-meta">
          <span class="dashboard-chip">Mode ${mode}</span>
          <span class="dashboard-chip">SDK ${defaultSdk}</span>
          ${uptime ? html`<span class="dashboard-chip">${uptime}</span>` : null}
          <span class="dashboard-chip dashboard-chip-clock">
            ${timeStr} <span class="dashboard-chip-tz">${tzStr}</span>
          </span>
          ${executor
            ? executor.paused
              ? html`<${Badge} status="error" text="Paused" />`
              : html`<${Badge} status="done" text="Running" />`
            : html`<span class="dashboard-chip">Executor · —</span>`}
        </div>
      </div>

      <div class="dashboard-grid">
        <${Card}
          title=${html`<span class="dashboard-card-title"
            ><span class="dashboard-title-icon">${ICONS.shield}</span>Health
            Summary</span
          >`}
          className="dashboard-card dashboard-health"
        >
          <div class="dashboard-status-row">
            <div class="dashboard-status-label">Executor status</div>
            <div class="dashboard-status-value">
              ${executor?.paused ? "Paused" : "Running"}
            </div>
          </div>
          <div class="dashboard-health-score">
            <div class="health-score-value" style="color: ${healthScore >= 80 ? 'var(--color-done)' : healthScore >= 50 ? 'var(--color-inreview)' : 'var(--color-error)'}">${healthScore}</div>
            <div class="health-score-label">Health Score</div>
          </div>
          <div class="dashboard-health-grid">
            <div class="dashboard-health-item">
              <div class="dashboard-health-label">Slots</div>
              <div class="dashboard-health-value">
                ${execData?.activeSlots ?? 0}/${execData?.maxParallel ?? "—"}
              </div>
            </div>
            <div class="dashboard-health-item">
              <div class="dashboard-health-label">6h fail rate</div>
              <div class="dashboard-health-value" style="color:${healthStats?.total > 0 && healthStats.failRate > 0 ? 'var(--color-error)' : 'inherit'}">
                ${healthStats?.total > 0 ? `${Math.round(healthStats.failRate * 100)}%` : healthStats === null && healthStatsReady ? html`<${Skeleton} variant="text" width=${40} />` : "—"}
              </div>
            </div>
            <div class="dashboard-health-item">
              <div class="dashboard-health-label">6h runs</div>
              <div class="dashboard-health-value">
                ${healthStats?.total > 0 ? `${healthStats.successRuns}/${healthStats.total}` : healthStats === null && healthStatsReady ? html`<${Skeleton} variant="text" width=${50} />` : "—"}
              </div>
            </div>
            <div class="dashboard-health-item">
              <div class="dashboard-health-label">Blocked</div>
              <div class="dashboard-health-value" style="color:${blocked > 0 ? 'var(--color-error)' : 'inherit'}">${blocked}</div>
            </div>
          </div>
          <div class="dashboard-health-progress">
            <div class="dashboard-progress-meta">
              <span>Slot utilization</span>
              <span>${Math.round(slotPct)}%</span>
            </div>
            <${ProgressBar} percent=${slotPct} />
          </div>
          <div class="dashboard-inline-actions">
            <${Button}
              variant="outlined"
              size="small"
              onClick=${handlePause}
            >
              Pause
            <//>
            <${Button}
              variant="outlined"
              size="small"
              onClick=${handleResume}
            >
              Resume
            <//>
          </div>
          <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:8px;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
              <div>
                <div style="font-size:12px;font-weight:600;">${worktreeRecovery.headline}</div>
                <div style="font-size:11px;color:var(--text-secondary);">${worktreeRecovery.summary}</div>
              </div>
              <span class="dashboard-chip" style=${`border-color:${worktreeRecovery.tone === "error" ? "var(--color-error)" : worktreeRecovery.tone === "warning" ? "var(--color-inreview)" : "var(--color-done)"};`}>
                ${worktreeRecovery.health}
              </span>
            </div>
            ${worktreeRecovery.events.slice(0, 2).map((event) => html`
              <div key=${event.key} style="padding:8px 10px;border:1px solid var(--border);border-radius:10px;background:var(--surface-2);">
                <div style="font-size:12px;font-weight:600;">${event.title}</div>
                <div style="font-size:11px;color:var(--text-secondary);">${event.detail}</div>
                ${event.error ? html`<div style="font-size:11px;color:var(--color-error);margin-top:4px;">${event.error}</div>` : null}
              </div>
            `)}
          </div>
          <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:8px;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
              <div>
                <div style="font-size:12px;font-weight:600;">Durable Runtime</div>
                <div style="font-size:11px;color:var(--text-secondary);">Session lineage and context pressure from the durable runtime / SQL-backed ledger surfaces.</div>
              </div>
              <span class="dashboard-chip">State ledger / SQL</span>
            </div>
            <div style="font-size:11px;color:var(--text-secondary);line-height:1.6;">
              <div><b>Sessions:</b> live ${Number(durableContext.liveSessionCount || sessionHealth.live || status?.activeSessionCount || 0)} · completed ${Number(durableContext.completedSessionCount || sessionHealth.completed || status?.completedSessionCount || 0)} · total ${Number(status?.totalSessionCount || status?.totalSessions || 0)}</div>
              <div><b>Context Pressure:</b> near limit ${Number(durableContext.sessionsNearContextLimit || 0)} · high pressure ${Number(durableContext.sessionsHighContextPressure || 0)} · max ${Number(durableContext.maxContextUsagePercent || 0)}%</div>
              <div><b>Top Tool:</b> ${topRuntimeTool?.name ? `${topRuntimeTool.name}${Number(topRuntimeTool.count || 0) > 0 ? ` · ${Number(topRuntimeTool.count)} calls` : ""}` : "No durable tool summary recorded yet."}</div>
            </div>
          </div>
          ${tickerTasks.length > 0 ? html`
            <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border)">
              <div style="font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:var(--text-secondary);margin-bottom:6px;display:flex;align-items:center;gap:5px;">
                <span style="width:6px;height:6px;border-radius:50%;background:var(--color-done);animation:errorPulse 2s ease-in-out infinite;display:inline-block;"></span>
                Live
              </div>
              <div class="fleet-ticker-wrap">
                <div class="fleet-ticker-inner">
                  ${tickerTasks.map((task) => html`
                    <div class="fleet-ticker-item">
                      <${Badge} status=${task.status} text=${task.status} />
                      <span>${truncate(task.title || "(untitled)", 38)}</span>
                    </div>
                  `)}
                </div>
              </div>
            </div>
          ` : null}
        <//>

        <${Card}
          title=${html`<span class="dashboard-card-title"
            ><span class="dashboard-title-icon">${ICONS.grid}</span>Overview</span
          >`}
          className="dashboard-card dashboard-overview"
        >
          <section role="region" aria-label="Dashboard overview">
            ${fleetAtRest
              ? html`
                <div class="fleet-rest-badge">
                  <div class="fleet-rest-icon">${resolveIcon("check")}</div>
                  <div class="fleet-rest-label">Fleet at rest</div>
                  <div class="fleet-rest-sub">${done} task${done !== 1 ? "s" : ""} completed · zero pending</div>
                </div>
              `
              : html`
                <div class="dashboard-metric-grid stat-flash" key=${flashKey} aria-label="Overview metrics">
                  ${overviewMetrics.map(
                    (metric) => html`
                      <div
                        class="dashboard-metric"
                        style="cursor:pointer;"
                        role="button"
                        tabindex="0"
                        onClick=${() => navigateTo(metric.tab || "tasks")}
                        onKeyDown=${(e) => (e.key === "Enter" || e.key === " ") && navigateTo(metric.tab || "tasks")}
                      >
                        <div class="dashboard-metric-label">${metric.label}</div>
                        <div
                          class="dashboard-metric-value"
                          style="color: ${metric.color}"
                        >
                          ${typeof metric.value === "number"
                            ? html`<${AnimatedNumber} value=${metric.value} />`
                            : metric.value} ${trend(metric.trend)}
                        </div>
                        <div class="dashboard-metric-spark">
                          <${MiniSparkline}
                            data=${sparkData(metric.spark)}
                            color=${metric.color}
                            height=${20}
                            width=${90}
                          />
                        </div>
                      </div>
                    `,
                  )}
                </div>
              `}
            ${segments.length > 0 && html`
              <div class="dashboard-work-layout" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
                <div class="dashboard-work-list">
                  ${workItems.map(
                    (item) => html`
                      <div class="dashboard-work-item">
                        <div class="dashboard-work-left">
                          <span
                            class="dashboard-work-dot"
                            style="background: ${item.color}"
                          ></span>
                          <span class="dashboard-work-label">${item.label}</span>
                        </div>
                        <span class="dashboard-work-value">${item.value}</span>
                      </div>
                    `,
                  )}
                </div>
                <div class="dashboard-work-chart">
                  <${DonutChart} segments=${segments} size=${90} strokeWidth=${9} />
                  <div class="dashboard-work-meta">
                    ${progressPct}% engaged
                  </div>
                  <${ProgressBar} percent=${progressPct} />
                </div>
              </div>
            `}
          </section>
        <//>

        <${Card}
          title=${html`<span class="dashboard-card-title"
            ><span class="dashboard-title-icon">${ICONS.activity || resolveIcon("activity")}</span>Harness Attention</span
          >`}
          className="dashboard-card dashboard-harness"
        >
          <div class="dashboard-harness-summary">
            <div class="dashboard-harness-summary-item">
              <div class="dashboard-harness-summary-label">Active</div>
              <div class="dashboard-harness-summary-value numeral">${harnessActiveCount}</div>
            </div>
            <div class="dashboard-harness-summary-item">
              <div class="dashboard-harness-summary-label">Waiting</div>
              <div class="dashboard-harness-summary-value numeral" style=${{ color: "var(--color-inreview)" }}>${harnessWaitingCount}</div>
            </div>
            <div class="dashboard-harness-summary-item">
              <div class="dashboard-harness-summary-label">Stalled</div>
              <div class="dashboard-harness-summary-value numeral" style=${{ color: "var(--color-error)" }}>${harnessStalledCount}</div>
            </div>
          </div>
          ${harnessVisibleRuns.length
            ? html`
                <div class="dashboard-harness-list">
                  ${harnessVisibleRuns.map((run) => {
                    const state = getHarnessRunState(run);
                    return html`
                      <button
                        type="button"
                        key=${run.runId}
                        class="task-card dashboard-harness-item"
                        data-status=${state}
                        onClick=${() => navigateTo("agents", {
                          params: {
                            harnessRunId: String(run?.runId || "").trim(),
                            harnessSource: "dashboard attention",
                          },
                        })}
                      >
                        <div class="task-card-header">
                          <div>
                            <div class="task-card-title">${truncate(run?.name || run?.runId || "(unnamed harness run)", 60)}</div>
                            <div class="task-card-meta">
                              ${run?.runId || "unknown"} · stage ${formatHarnessStage(run)}
                            </div>
                          </div>
                          <${Chip}
                            size="small"
                            label=${formatHarnessStateLabel(state)}
                            color=${getHarnessStateTone(state)}
                            variant="outlined"
                            sx=${{
                              color: getHarnessStateColor(state),
                              borderColor: getHarnessStateColor(state),
                            }}
                          />
                        </div>
                        <div class="task-card-meta">${getHarnessAttentionDetail(run)}</div>
                        <div class="task-card-meta" style=${{ marginTop: "0.35rem" }}>
                          ${run?.startedAt ? `Started ${formatRelative(run.startedAt)}` : "Start time unavailable"}
                          ${run?.updatedAt ? ` · Updated ${formatRelative(run.updatedAt)}` : ""}
                        </div>
                      </button>
                    `;
                  })}
                </div>
              `
            : html`<${EmptyState}
                title="No harness runs need attention"
                description="Active, waiting, and stalled harness runs will appear here with one-click routing into the Agents tab."
              />`}
          <div class="dashboard-inline-actions" style=${{ marginTop: "0.75rem" }}>
            <${Button}
              variant="outlined"
              size="small"
              onClick=${() => navigateTo("agents")}
            >
              Open Agents
            <//>
          </div>
        <//>

        <${Card}
          title=${html`<span class="dashboard-card-title"
            ><span class="dashboard-title-icon">${ICONS.bell}</span>Alerts</span
          >`}
          className="dashboard-card dashboard-alerts"
        >
          <div class="dashboard-alerts-wrap">
            ${alertItems.map(
              (alert) => html`
                <div class="dashboard-alert-item">
                  <div class="dashboard-alert-left">
                    <span class="dashboard-alert-dot ${alert.tone}"></span>
                    <div class="dashboard-alert-text">
                      <div class="dashboard-alert-title">${alert.label}</div>
                      <div class="dashboard-alert-meta">
                        ${alert.tone === "ok"
                          ? hasAlerts
                            ? "Stable"
                            : "All clear"
                          : "Needs attention"}
                      </div>
                    </div>
                  </div>
                  <div class="dashboard-alert-value">${alert.value}</div>
                </div>
              `,
            )}
          </div>
        <//>

        <${Card}
          title=${html`<span class="dashboard-card-title"
            ><span class="dashboard-title-icon">${ICONS.bosun}</span>Quick
            Actions</span
          >`}
          className="dashboard-card dashboard-actions"
        >
          <div class="dashboard-actions-grid" aria-label="Quick actions">
            ${QUICK_ACTIONS.map(
              (a) => html`
                <${Button}
                  key=${a.label}
                  variant="text"
                  size="small"
                  className="dashboard-action-btn"
                  style=${{ '--qa-color': a.color }}
                  onClick=${(e) => handleQuickAction(a, e)}
                >
                  <span class="dashboard-action-icon">${resolveIcon(a.icon) || a.icon}</span>
                  <span class="dashboard-action-label">${a.label}</span>
                <//>
              `,
            )}
          </div>
        <//>

        ${project &&
        html`
          <${Card}
            title=${html`<span class="dashboard-card-title"
              ><span class="dashboard-title-icon">${ICONS.server}</span>Project</span
            >`}
            className="dashboard-card dashboard-project"
          >
            <div class="dashboard-project-name">
              ${project.name || project.id || "Current Project"}
            </div>
            ${project.description &&
            html`<div class="dashboard-project-desc">
              ${truncate(project.description, 160)}
            </div>`}
            ${project.taskCount != null &&
            html`
              <div class="dashboard-project-grid">
                <div class="dashboard-project-item">
                  <div class="dashboard-project-label">Tasks</div>
                  <div class="dashboard-project-value">
                    ${project.taskCount}
                  </div>
                </div>
                <div class="dashboard-project-item">
                  <div class="dashboard-project-label">Completed</div>
                  <div
                    class="dashboard-project-value"
                    style="color: var(--color-done)"
                  >
                    ${project.completedCount ?? 0}
                  </div>
                </div>
              </div>
            `}
          <//>
        `}

        <${Card}
          title=${html`<span class="dashboard-card-title"
            ><span class="dashboard-title-icon">${ICONS.star}</span>Quality</span
          >`}
          className="dashboard-card dashboard-quality"
        >
          <div class="dashboard-quality-grid">
            ${qualityItems.map(
              (item) => html`
                <div class="dashboard-quality-item tone-${item.tone}">
                  <div class="dashboard-quality-value">${item.value}</div>
                  <div class="dashboard-quality-label">${item.label}</div>
                </div>
              `,
            )}
          </div>
        <//>

        <${Card}
          title=${html`<span class="dashboard-card-title"
            ><span class="dashboard-title-icon">${ICONS.refresh || resolveIcon("refresh")}</span>Retry Queue</span
          >`}
          className="dashboard-card dashboard-retry-queue"
        >
          ${retryItems.length
            ? html`
              <div class="dashboard-retry-list">
                ${retryItems.map((item) => html`
                  <div key=${item.taskId} class="dashboard-retry-item">
                    <div class="dashboard-retry-main">
                      <div class="dashboard-retry-task">${item.taskId}</div>
                      ${item.taskTitle
                        ? html`<div class="dashboard-retry-task-title">${truncate(item.taskTitle, 72)}</div>`
                        : null}
                      <div class="dashboard-retry-error">${truncate(item.lastError || item.reason || "Unknown retry reason", 120)}</div>
                    </div>
                    <div class="dashboard-retry-meta">
                      <span class="dashboard-retry-pill">Attempt ${item.retryCount || 0}</span>
                      <span class="dashboard-retry-pill">Next ${formatRetryCountdown(item.nextAttemptAt)}</span>
                      <${Button}
                        variant="outlined"
                        size="small"
                        onClick=${() => {
                          haptic("medium");
                          void handleRetryNow(item.taskId);
                        }}
                      >
                        Retry Now
                      <//>
                    </div>
                  </div>
                `)}
              </div>
            `
            : html`<${EmptyState} title="No queued retries" description="Failed tasks waiting to retry appear here automatically." />`}
        <//>

        <${Card}
          title=${html`<span class="dashboard-card-title"
            ><span class="dashboard-title-icon">${ICONS.clock}</span>Recent
            Activity</span
          >`}
          className="dashboard-card dashboard-activity"
        >
          <${TextField}
            size="small"
            variant="outlined"
            fullWidth
            placeholder="Filter by title or ID…"
            value=${activitySearch}
            onInput=${(e) => setActivitySearch(e.target.value)}
            style=${{ marginBottom: 8 }}
          />
          <div class="dashboard-activity-list">
            ${filteredTasks.length
              ? filteredTasks.map(
                  (task) => html`
                    <div key=${task.id} class="list-item">
                      <div class="list-item-content">
                        <div class="list-item-title">
                          ${truncate(task.title || "(untitled)", 50)}
                        </div>
                        <div class="meta-text">
                          ${task.id}${(task.updated_at || task.updated)
                            ? ` · ${formatRelative(task.updated_at || task.updated)}`
                            : ""}
                        </div>
                      </div>
                      <${Badge} status=${task.status} text=${task.status} />
                    </div>
                  `,
                )
              : html`<${EmptyState} message=${activitySearch ? "No matching tasks" : "No recent tasks"} />`}
          </div>
        <//>
      </div>

      ${showCreate &&
      html`<${CreateTaskModal} onClose=${() => setShowCreate(false)} />`}

      <${Card}
        title=${html`<span class="dashboard-card-title"><span class="dashboard-title-icon">${ICONS.git || resolveIcon("git")}</span>Git Graph</span>`}
        className="dashboard-card dashboard-commits-card"
      >
        <${CommitGraph} maxCommits=${40} compact=${true} />
      <//>

      ${showStartModal &&
      html`
        <${StartTaskModal}
          task=${null}
          defaultSdk=${defaultSdk}
          allowTaskIdInput=${true}
          onClose=${() => setShowStartModal(false)}
          onStart=${handleModalStart}
        />
      `}
    </div>
  `;
}
