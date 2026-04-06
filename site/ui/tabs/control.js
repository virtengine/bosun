/* ─────────────────────────────────────────────────────────────
 *  Tab: Control — executor, commands, routing, quick commands
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import { useState, useCallback, useEffect, useRef, useMemo } from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

import { Typography, Box, Stack, Card as MuiCard, CardContent, Button, IconButton, Chip, Divider, Paper, TextField, InputAdornment, CircularProgress, Alert, Tooltip, Switch, FormControlLabel, Dialog, DialogTitle, DialogContent, DialogActions, List, ListItem, ListItemButton, ListItemText, ListItemIcon, Menu, MenuItem, Tabs, Tab, Skeleton, Badge as MuiBadge, Avatar, LinearProgress, Grid, Slider, Select } from "@mui/material";

import { haptic, showConfirm } from "../modules/telegram.js";
import { apiFetch, sendCommandToChat } from "../modules/api.js";
import {
  executorData,
  configData,
  loadConfig,
  showToast,
  runOptimistic,
  scheduleRefresh,
} from "../modules/state.js";
import { ICONS } from "../modules/icons.js";
import { iconText as iconTextUtil } from "../modules/icon-utils.js";
import { cloneValue, truncate } from "../modules/utils.js";
import { SegmentedControl, Collapsible } from "../components/forms.js";
import { Card, Badge, SkeletonCard } from "../components/shared.js";
import { WorkspaceExecutorSettingsFields } from "../components/workspace-executor-settings.js";
import {
  activeWorkspaceId,
  loadWorkspaces,
  setWorkspaceExecutors,
  workspaces as managedWorkspaces,
} from "../components/workspace-switcher.js";
import { sessionsData, selectedSessionId } from "../components/session-list.js";
import { getSessionLifecycleState, getSessionRuntimeState } from "../modules/session-api.js";
import { getSessionPhaseState } from "../modules/session-surface.js";

/* ─── Command registry for autocomplete ─── */
const CMD_REGISTRY = [
  { cmd: '/status', desc: 'Show orchestrator status', cat: 'System' },
  { cmd: '/health', desc: 'Health check', cat: 'System' },
  { cmd: '/menu', desc: 'Show command menu', cat: 'System' },
  { cmd: '/helpfull', desc: 'Full help text', cat: 'System' },
  { cmd: '/plan', desc: 'Generate execution plan', cat: 'Tasks' },
  { cmd: '/logs', desc: 'View recent logs', cat: 'Logs' },
  { cmd: '/diff', desc: 'View git diff', cat: 'Git' },
  { cmd: '/steer', desc: 'Steer active agent', cat: 'Agent' },
  { cmd: '/ask', desc: 'Ask agent a question', cat: 'Agent' },
  { cmd: '/start', desc: 'Start a task', cat: 'Tasks' },
  { cmd: '/retry', desc: 'Retry failed task', cat: 'Tasks' },
  { cmd: '/cancel', desc: 'Cancel running task', cat: 'Tasks' },
  { cmd: '/shell', desc: 'Execute shell command', cat: 'Shell' },
  { cmd: '/git', desc: 'Execute git command', cat: 'Git' },
];

/* ─── Category badge colors ─── */
const CAT_COLORS = {
  System: '#6366f1', Tasks: '#f59e0b', Logs: '#10b981',
  Git: '#f97316', Agent: '#8b5cf6', Shell: '#64748b',
};

// Defensive wrapper: keep Control tab rendering even if icon helper is unavailable
// in an older/cached bundle state.
const iconText = (text, options) => {
  try {
    if (typeof iconTextUtil === "function") return iconTextUtil(text, options);
  } catch {
    /* graceful fallback below */
  }
  if (text == null) return "";
  return String(text);
};

/* ─── Persistent history key & limits ─── */
const HISTORY_KEY = 've-cmd-history';
const MAX_HISTORY = 50;
const MAX_OUTPUTS = 3;
const POLL_INTERVAL = 2000;
const MAX_POLLS = 7;
const OUTPUT_POLL_WINDOW_SEC = Math.max(1, Math.round((POLL_INTERVAL * MAX_POLLS) / 1000));

const normalizeHistoryEntry = (entry) => {
  if (entry == null) return "";
  if (typeof entry === "string") return entry.trim();
  return String(entry).trim();
};

const normalizeOutputText = (value) => {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => (v == null ? "" : String(v))).join("\n");
  if (typeof value === "object") {
    if (typeof value.logs === "string") return value.logs;
    if (Array.isArray(value.logs)) return value.logs.join("\n");
    if (typeof value.data === "string") return value.data;
    if (Array.isArray(value.data)) return value.data.join("\n");
  }
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
};

/* ─── ControlTab ─── */
export function ControlTab() {
  const executor = executorData.value;
  const execData = executor?.data;
  const mode = executor?.mode || "internal";
  const config = configData.value;
  const visibleSessions = sessionsData.value || [];
  const selectedOperatorSessionId = String(selectedSessionId.value || "").trim();
  const activeWorkspace = (managedWorkspaces.value || []).find(
    (entry) => String(entry?.id || "").trim() === String(activeWorkspaceId.value || "").trim(),
  ) || null;
  const workspaceExecutors = activeWorkspace?.executors || null;

  /* Form inputs */
  const [commandInput, setCommandInput] = useState("");
  const [startTaskId, setStartTaskId] = useState("");
  const [retryTaskId, setRetryTaskId] = useState("");
  const [quickCmdInput, setQuickCmdInput] = useState("");
  const [quickCmdPrefix, setQuickCmdPrefix] = useState("shell");
  const [quickCmdFeedback, setQuickCmdFeedback] = useState("");
  const [quickCmdFeedbackTone, setQuickCmdFeedbackTone] = useState("info");
  const [maxParallel, setMaxParallel] = useState(workspaceExecutors?.maxConcurrent ?? execData?.maxParallel ?? 0);
  const [workspacePool, setWorkspacePool] = useState(workspaceExecutors?.pool || "shared");
  const [workspaceWeight, setWorkspaceWeight] = useState(workspaceExecutors?.weight ?? 1.0);
  const [savingWorkspaceExecutors, setSavingWorkspaceExecutors] = useState(false);
  const [cmdHistory, setCmdHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [isCompact, setIsCompact] = useState(() => {
    try { return globalThis.matchMedia?.("(max-width: 768px)")?.matches ?? false; }
    catch { return false; }
  });
  const [backlogTasks, setBacklogTasks] = useState([]);
  const [retryTasks, setRetryTasks] = useState([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [startTaskError, setStartTaskError] = useState("");
  const [retryTaskError, setRetryTaskError] = useState("");
  const [planFocus, setPlanFocus] = useState(""); // chip selection — no typing needed
  const [planCount, setPlanCount] = useState("5");
  const startTaskIdRef = useRef("");
  const retryTaskIdRef = useRef("");

  /* ── Autocomplete state ── */
  const [acItems, setAcItems] = useState([]);
  const [acIndex, setAcIndex] = useState(-1);
  const [showAc, setShowAc] = useState(false);

  /* ── Persistent history state ── */
  const [historyIndex, setHistoryIndex] = useState(-1);
  const savedInputRef = useRef("");

  /* ── Inline output state ── */
  const [cmdOutputs, setCmdOutputs] = useState([]);
  const [runningCmd, setRunningCmd] = useState(null);
  const [sendingCmd, setSendingCmd] = useState(false);
  const [expandedOutputs, setExpandedOutputs] = useState({});
  const [historyFilter, setHistoryFilter] = useState("");
  const [outputWrap, setOutputWrap] = useState(true);
  const pollRef = useRef(null);
  const isPaused = Boolean(executor?.paused || execData?.paused);
  const slotsLabel = `${execData?.activeSlots ?? 0}/${execData?.maxParallel ?? "—"}`;
  const pollLabel = execData?.pollIntervalMs
    ? `${Math.round(execData.pollIntervalMs / 1000)}s`
    : "—";
  const timeoutLabel = execData?.taskTimeoutMs
    ? `${Math.round(execData.taskTimeoutMs / 60000)}m`
    : "—";
  const controlMeta = [
    { label: "Slots", value: slotsLabel },
    { label: "Poll", value: pollLabel },
    { label: "Timeout", value: timeoutLabel },
  ];
  const workspaceMaxConcurrent = Number(workspaceExecutors?.maxConcurrent || 0) || null;
  const workspaceMaxConcurrentDraft = Math.max(
    1,
    Number(maxParallel || workspaceMaxConcurrent || execData?.maxParallel || 1),
  );
  const hasWorkspaceExecutorChanges = Boolean(activeWorkspace) && (
    workspaceMaxConcurrentDraft !== Number(workspaceExecutors?.maxConcurrent || 1)
    || workspacePool !== String(workspaceExecutors?.pool || "shared")
    || Math.abs(Number(workspaceWeight || 1) - Number(workspaceExecutors?.weight || 1)) > 0.001
  );
  const sessionPhaseModel = useMemo(() => {
    const workspaceId = String(activeWorkspace?.id || activeWorkspaceId.value || "").trim();
    const sessions = (Array.isArray(visibleSessions) ? visibleSessions : [])
      .filter(Boolean)
      .filter((session) => {
        if (!workspaceId) return true;
        const metadata = session?.metadata && typeof session.metadata === "object"
          ? session.metadata
          : {};
        const sessionWorkspaceId = String(session?.workspaceId || metadata.workspaceId || "").trim();
        return !sessionWorkspaceId || sessionWorkspaceId === workspaceId;
      })
      .slice()
      .sort((a, b) =>
        String(b?.lastActiveAt || b?.runtimeUpdatedAt || b?.updatedAt || b?.createdAt || "")
          .localeCompare(String(a?.lastActiveAt || a?.runtimeUpdatedAt || a?.updatedAt || a?.createdAt || "")),
      );

    const focusSession =
      sessions.find((session) => String(session?.id || "").trim() === selectedOperatorSessionId)
      || sessions[0]
      || null;
    const focusPhase = getSessionPhaseState(focusSession);
    const focusLifecycle = getSessionLifecycleState(focusSession || {});
    const focusRuntime = getSessionRuntimeState(focusSession || {});
    const counts = new Map();
    for (const session of sessions) {
      const phase = getSessionPhaseState(session);
      counts.set(phase.id, {
        phase,
        count: Number(counts.get(phase.id)?.count || 0) + 1,
      });
    }
    return {
      sessions,
      focusSession,
      focusPhase,
      focusLifecycle,
      focusRuntime,
      counts: [...counts.values()].sort((a, b) => b.count - a.count || a.phase.label.localeCompare(b.phase.label)),
    };
  }, [activeWorkspace?.id, visibleSessions, selectedOperatorSessionId]);

  /* ── Load persistent history on mount ── */
  useEffect(() => {
    try {
      const saved = localStorage.getItem(HISTORY_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          const cleaned = parsed
            .map((item) => normalizeHistoryEntry(item))
            .filter(Boolean);
          if (cleaned.length) setCmdHistory(cleaned.slice(0, MAX_HISTORY));
        }
      }
    } catch (_) { /* ignore corrupt data */ }
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  useEffect(() => {
    let mq;
    try { mq = globalThis.matchMedia?.("(max-width: 768px)"); }
    catch { mq = null; }
    if (!mq) return undefined;
    const handler = (event) => setIsCompact(event.matches);
    handler(mq);
    if (mq.addEventListener) mq.addEventListener("change", handler);
    else mq.addListener(handler);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", handler);
      else mq.removeListener(handler);
    };
  }, []);

  useEffect(() => {
    loadWorkspaces().catch(() => {});
  }, []);

  useEffect(() => {
    setMaxParallel(workspaceExecutors?.maxConcurrent ?? execData?.maxParallel ?? 0);
  }, [workspaceExecutors?.maxConcurrent, execData?.maxParallel]);

  useEffect(() => {
    setWorkspacePool(workspaceExecutors?.pool || "shared");
    setWorkspaceWeight(workspaceExecutors?.weight ?? 1.0);
  }, [workspaceExecutors?.pool, workspaceExecutors?.weight]);

  useEffect(() => {
    startTaskIdRef.current = startTaskId;
  }, [startTaskId]);

  useEffect(() => {
    retryTaskIdRef.current = retryTaskId;
  }, [retryTaskId]);

  /* ── Autocomplete filter ── */
  useEffect(() => {
    if (commandInput.startsWith('/') && commandInput.length > 0) {
      const q = commandInput.toLowerCase();
      const matches = CMD_REGISTRY.filter((r) => r.cmd.toLowerCase().includes(q));
      setAcItems(matches);
      setAcIndex(-1);
      setShowAc(matches.length > 0);
    } else {
      setShowAc(false);
      setAcItems([]);
      setAcIndex(-1);
    }
  }, [commandInput]);

  /* ── Command history helper (persistent) ── */
  const pushHistory = useCallback((cmd) => {
    const normalized = normalizeHistoryEntry(cmd);
    if (!normalized) return;
    setCmdHistory((prev) => {
      const next = [normalized, ...prev.filter((c) => c !== normalized)].slice(0, MAX_HISTORY);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch (_) {}
      return next;
    });
  }, []);

  /* ── Inline output polling ── */
  const startOutputPolling = useCallback((cmd) => {
    if (pollRef.current) clearInterval(pollRef.current);
    const ts = new Date().toISOString();
    setRunningCmd(cmd);
    let pollCount = 0;
    let lastContent = '';

    pollRef.current = setInterval(async () => {
      pollCount++;
      try {
        const res = await apiFetch('/api/logs?lines=15', { _silent: true });
        const payload = typeof res === 'string' ? res : (res?.logs ?? res?.data ?? res);
        const text = normalizeOutputText(payload);
        if (text === lastContent || pollCount >= MAX_POLLS) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setRunningCmd(null);
          setCmdOutputs((prev) => {
            const entry = { cmd, ts, output: text || 'no live output yet — command accepted. Check /logs for full stream' };
            const next = [entry, ...prev].slice(0, MAX_OUTPUTS);
            return next;
          });
          setExpandedOutputs((prev) => ({ ...prev, [0]: true }));
        } else {
          lastContent = text;
        }
      } catch (_) {
        clearInterval(pollRef.current);
        pollRef.current = null;
        setRunningCmd(null);
        setCmdOutputs((prev) => {
          const entry = { cmd, ts, output: 'could not fetch live output — command may still be running. Check /logs' };
          return [entry, ...prev].slice(0, MAX_OUTPUTS);
        });
      }
    }, POLL_INTERVAL);
  }, []);

  const sendCmd = useCallback(
    (cmd) => {
      if (!cmd.trim()) return;
      setSendingCmd(true);
      sendCommandToChat(cmd.trim());
      pushHistory(cmd.trim());
      setHistoryIndex(-1);
      startOutputPolling(cmd.trim());
      // Reset sending state after a brief delay (command is fire-and-forget)
      setTimeout(() => setSendingCmd(false), 600);
    },
    [pushHistory, startOutputPolling],
  );

  /* ── Config update helper ── */
  const updateConfig = useCallback(
    async (key, value) => {
      haptic();
      try {
        await apiFetch("/api/config/update", {
          method: "POST",
          body: JSON.stringify({ key, value }),
        });
        await loadConfig();
        showToast(`${key} → ${value}`, "success");
      } catch {
        showToast(`Failed to update ${key}`, "error");
      }
    },
    [],
  );

  const refreshTaskOptions = useCallback(async () => {
    setTasksLoading(true);
    try {
      const res = await apiFetch("/api/tasks?page=0&pageSize=200", {
        _silent: true,
      });
      const all = Array.isArray(res?.data) ? res.data : [];
      const priorityRank = { critical: 0, high: 1, medium: 2, low: 3 };
      const score = (t) =>
        priorityRank[String(t?.priority || "").toLowerCase()] ?? 9;
      const byPriority = (a, b) => {
        const pa = score(a);
        const pb = score(b);
        if (pa !== pb) return pa - pb;
        const ta = String(a?.updated_at || a?.updatedAt || "");
        const tb = String(b?.updated_at || b?.updatedAt || "");
        return tb.localeCompare(ta);
      };

      const backlog = all
        .filter((t) =>
          ["todo", "backlog", "open", "new"].includes(
            String(t?.status || "").toLowerCase(),
          ),
        )
        .sort(byPriority);
      const retryable = all
        .filter((t) =>
          ["error", "cancelled", "blocked", "failed", "inreview"].includes(
            String(t?.status || "").toLowerCase(),
          ),
        )
        .sort(byPriority);

      setBacklogTasks(backlog);
      setRetryTasks(retryable);

      if (backlog.length > 0) {
        const current = String(startTaskIdRef.current || "");
        if (!backlog.some((t) => String(t?.id) === current)) {
          setStartTaskId(String(backlog[0].id || ""));
        }
      } else {
        setStartTaskId("");
      }

      if (retryable.length > 0) {
        const currentRetry = String(retryTaskIdRef.current || "");
        if (!retryable.some((t) => String(t?.id) === currentRetry)) {
          setRetryTaskId(String(retryable[0].id || ""));
        }
      } else {
        setRetryTaskId("");
      }
    } catch {
      setBacklogTasks([]);
      setRetryTasks([]);
    } finally {
      setTasksLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshTaskOptions();
  }, [refreshTaskOptions]);

  /* ── Executor controls ── */
  const handlePause = async () => {
    const ok = await showConfirm(
      "Pause the executor? Running tasks will finish but no new tasks will start.",
    );
    if (!ok) return;
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
        if (executorData.value?.data) {
          executorData.value = {
            ...executorData.value,
            data: {
              ...executorData.value.data,
              maxParallel: value,
            },
          };
        }
      },
      async () => {
        await apiFetch("/api/executor/maxparallel", {
          method: "POST",
          body: JSON.stringify({ value }),
        });
        if (activeWorkspace?.id && value > 0) {
          await setWorkspaceExecutors(activeWorkspace.id, {
            maxConcurrent: value,
          });
        }
      },
      () => {
        executorData.value = prev;
      },
    ).catch(() => {});
    scheduleRefresh(120);
  };

  const handleWorkspaceExecutorSave = useCallback(async () => {
    if (!activeWorkspace?.id) return;
    setSavingWorkspaceExecutors(true);
    haptic("medium");
    try {
      await setWorkspaceExecutors(activeWorkspace.id, {
        maxConcurrent: workspaceMaxConcurrentDraft,
        pool: workspacePool,
        weight: workspaceWeight,
      });
      if (workspaceMaxConcurrentDraft > 0) {
        await apiFetch("/api/executor/maxparallel", {
          method: "POST",
          body: JSON.stringify({ value: workspaceMaxConcurrentDraft }),
        });
      }
      showToast("Workspace executor settings updated", "success");
      scheduleRefresh(120);
    } catch {
      showToast("Failed to update workspace executor settings", "error");
    } finally {
      setSavingWorkspaceExecutors(false);
    }
  }, [
    activeWorkspace?.id,
    workspaceMaxConcurrentDraft,
    workspacePool,
    workspaceWeight,
  ]);

  /* ── Region options from config ── */
  const regions = config?.regions || ["auto"];
  const regionOptions = regions.map((r) => ({
    value: r,
    label: r.charAt(0).toUpperCase() + r.slice(1),
  }));

  /* ── Quick command submit ── */
  const handleQuickCmd = useCallback(() => {
    const input = quickCmdInput.trim();
    if (!input) {
      setQuickCmdFeedbackTone("error");
      setQuickCmdFeedback("Enter a command to run.");
      return;
    }
    const cmd = `/${quickCmdPrefix} ${input}`;
    sendCmd(cmd);
    setQuickCmdInput("");
    setQuickCmdFeedbackTone("success");
    setQuickCmdFeedback("✓ Command sent to monitor");
    setTimeout(() => setQuickCmdFeedback(""), 4000);
  }, [quickCmdInput, quickCmdPrefix, sendCmd]);

  /* ── Autocomplete select helper ── */
  const selectAcItem = useCallback((item) => {
    setCommandInput(item.cmd + ' ');
    setShowAc(false);
    setAcIndex(-1);
  }, []);

  /* ── Console input keydown handler ── */
  const handleConsoleKeyDown = useCallback((e) => {
    // Autocomplete navigation
    if (showAc && acItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAcIndex((prev) => (prev + 1) % acItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAcIndex((prev) => (prev <= 0 ? acItems.length - 1 : prev - 1));
        return;
      }
      if (e.key === 'Enter' && acIndex >= 0) {
        e.preventDefault();
        selectAcItem(acItems[acIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowAc(false);
        return;
      }
    }

    // History navigation (when input is empty or already in history mode)
    if (!showAc && (commandInput === '' || historyIndex >= 0)) {
      if (e.key === 'ArrowUp' && cmdHistory.length > 0) {
        e.preventDefault();
        const nextIdx = historyIndex + 1;
        if (nextIdx < cmdHistory.length) {
          if (historyIndex === -1) savedInputRef.current = commandInput;
          setHistoryIndex(nextIdx);
          setCommandInput(cmdHistory[nextIdx]);
        }
        return;
      }
      if (e.key === 'ArrowDown' && historyIndex >= 0) {
        e.preventDefault();
        const nextIdx = historyIndex - 1;
        if (nextIdx < 0) {
          setHistoryIndex(-1);
          setCommandInput(savedInputRef.current);
        } else {
          setHistoryIndex(nextIdx);
          setCommandInput(cmdHistory[nextIdx]);
        }
        return;
      }
    }

    // Submit
    if (e.key === 'Enter' && commandInput.trim()) {
      e.preventDefault();
      sendCmd(commandInput.trim());
      setCommandInput('');
      setShowAc(false);
    }
  }, [showAc, acItems, acIndex, commandInput, historyIndex, cmdHistory, sendCmd, selectAcItem]);

  /* ── Toggle output accordion ── */
  const toggleOutput = useCallback((idx) => {
    setExpandedOutputs((prev) => ({ ...prev, [idx]: !prev[idx] }));
  }, []);

  const handleStartTask = useCallback(async () => {
    const taskId = String(startTaskId || "").trim();
    if (!taskId) {
      setStartTaskError("Select a backlog task to start.");
      showToast("Select a backlog task to start", "error");
      return;
    }
    setStartTaskError("");
    haptic("medium");
    try {
      const res = await apiFetch("/api/tasks/start", {
        method: "POST",
        body: JSON.stringify({ taskId }),
      });
      if (res?.wasPaused) {
        showToast("Task started (executor was paused — force-dispatched)", "warning");
      } else {
        showToast("Task started", "success");
      }
      refreshTaskOptions();
      scheduleRefresh(150);
    } catch {
      /* toast via apiFetch */
    }
  }, [startTaskId, refreshTaskOptions]);

  const handleRetryTask = useCallback(async () => {
    const taskId = String(retryTaskId || "").trim();
    if (!taskId) {
      setRetryTaskError("Select a task to retry.");
      showToast("Select a task to retry", "error");
      return;
    }
    setRetryTaskError("");
    haptic("medium");
    try {
      await apiFetch("/api/tasks/retry", {
        method: "POST",
        body: JSON.stringify({ taskId }),
      });
      showToast("Task retried", "success");
      refreshTaskOptions();
      scheduleRefresh(150);
    } catch {
      /* toast via apiFetch */
    }
  }, [retryTaskId, refreshTaskOptions]);

  const filteredHistory = useMemo(() => {
    if (!historyFilter.trim()) return cmdHistory;
    const q = historyFilter.toLowerCase();
    return cmdHistory.filter((c) => c.toLowerCase().includes(q));
  }, [cmdHistory, historyFilter]);

  const copyOutput = useCallback((text) => {
    try {
      navigator.clipboard.writeText(text);
      showToast("Copied to clipboard", "success");
    } catch {
      showToast("Copy failed", "error");
    }
  }, []);

  const colorizeOutputLine = useCallback((line) => {
    const lower = line.toLowerCase();
    if (/\berror\b|\bfailed\b|\bfatal\b|\bpanic\b/.test(lower))
      return "var(--color-error)";
    if (/\bwarn\b|\bwarning\b/.test(lower))
      return "var(--color-inreview)";
    if (/\bsuccess\b|\b✓\b|\bdone\b|\bcompleted\b/.test(lower))
      return "var(--color-done)";
    if (/\bdebug\b|\btrace\b/.test(lower))
      return "var(--text-hint)";
    return "inherit";
  }, []);

  return html`
    <div class="control-layout">
      <div class="control-main">
        <${Card} className="control-hero">
          <div class="control-hero-header">
            <div class="control-hero-title">
              <div class="control-hero-label">Control Unit</div>
              <div class="control-hero-status">
                <span>${isPaused ? "Paused" : "Running"}</span>
                <span class="control-hero-mode">${String(mode || "internal")}</span>
              </div>
              <div class="meta-text">
                Manage executor throughput, active workspace allocation, and operator commands.
              </div>
            </div>

            <div class="control-hero-actions">
              <${Button}
                variant=${isPaused ? "contained" : "outlined"}
                size="small"
                color=${isPaused ? "success" : "warning"}
                onClick=${isPaused ? handleResume : handlePause}
              >
                ${isPaused ? "Resume Executor" : "Pause Executor"}
              <//>
              <${Button}
                variant="text"
                size="small"
                onClick=${refreshTaskOptions}
              >
                Refresh Tasks
              <//>
            </div>
          </div>

          <div class="control-meta-grid">
            ${controlMeta.map((item) => html`
              <div class="control-meta-item" key=${item.label}>
                <span class="control-meta-label">${item.label}</span>
                <span class="control-meta-value">${item.value}</span>
              </div>
            `)}
            <div class="control-meta-item">
              <span class="control-meta-label">Workspace</span>
              <span class="control-meta-value">${activeWorkspace?.name || activeWorkspace?.id || "All workspaces"}</span>
            </div>
          </div>

          <${Paper}
            variant="outlined"
            sx=${{
              mt: 2,
              p: 1.5,
              borderRadius: "18px",
              background: "rgba(255,255,255,0.04)",
              borderColor: "rgba(255,255,255,0.08)",
            }}
          >
            <div class="card-subtitle">Session Phase</div>
            <div style=${{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center", marginTop: "0.5rem" }}>
              <${Chip}
                size="small"
                color=${sessionPhaseModel.focusPhase.tone || "default"}
                label=${sessionPhaseModel.focusPhase.label}
              />
              <${Chip}
                size="small"
                variant="outlined"
                color=${sessionPhaseModel.focusLifecycle.tone || "default"}
                label=${sessionPhaseModel.focusLifecycle.label}
              />
              <${Chip}
                size="small"
                variant="outlined"
                color=${sessionPhaseModel.focusRuntime.tone || "default"}
                label=${sessionPhaseModel.focusRuntime.label}
              />
              <span class="meta-text">
                ${sessionPhaseModel.focusSession
                  ? `Focus: ${truncate(
                      sessionPhaseModel.focusSession.taskTitle
                      || sessionPhaseModel.focusSession.title
                      || sessionPhaseModel.focusSession.id
                      || "Unnamed session",
                      56,
                    )}`
                  : "No operator sessions are loaded yet."}
              </span>
            </div>
            <div class="meta-text" style=${{ marginTop: "0.5rem" }}>
              ${sessionPhaseModel.focusPhase.description}
            </div>
            <div style=${{
              display: "grid",
              gridTemplateColumns: isCompact ? "1fr" : "repeat(2, minmax(0, 1fr))",
              gap: "0.75rem",
              marginTop: "0.75rem",
            }}>
              <${Paper} variant="outlined" sx=${{ p: 1.25, borderRadius: "14px" }}>
                <div class="form-label">Prompt Discipline</div>
                <div class="meta-text">${sessionPhaseModel.focusPhase.promptRule}</div>
              <//>
              <${Paper} variant="outlined" sx=${{ p: 1.25, borderRadius: "14px" }}>
                <div class="form-label">Tool Discipline</div>
                <div class="meta-text">${sessionPhaseModel.focusPhase.toolRule}</div>
              <//>
            </div>
            <div style=${{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.75rem" }}>
              ${sessionPhaseModel.counts.length > 0
                ? sessionPhaseModel.counts.map((entry) => html`
                    <${Chip}
                      key=${entry.phase.id}
                      size="small"
                      variant="outlined"
                      color=${entry.phase.tone || "default"}
                      label=${`${entry.phase.label} ${entry.count}`}
                    />
                  `)
                : html`<span class="meta-text">Load or create a session to populate live phase counts.</span>`}
            </div>
          <//>

          <div class="control-range">
            <div class="form-label mt-sm">Max parallel tasks</div>
            <div class="range-row mb-md">
              <${Slider}
                min=${0}
                max=${20}
                step=${1}
                value=${maxParallel}
                aria-label="Max parallel tasks"
                onChange=${(_event, value) => setMaxParallel(value)}
                onChangeCommitted=${(_event, value) => handleMaxParallel(value)}
              />
              <span class="pill">Max ${maxParallel}</span>
            </div>
          </div>

          ${activeWorkspace
            ? html`
                <div class="control-range" style=${{ marginTop: "0.5rem" }}>
                  <${WorkspaceExecutorSettingsFields}
                    title="Active Workspace Executors"
                    description="Control mirrors the active workspace executor config used in the workspace switcher."
                    maxConcurrent=${workspaceMaxConcurrentDraft}
                    pool=${workspacePool}
                    weight=${workspaceWeight}
                    onMaxConcurrentChange=${setMaxParallel}
                    onPoolChange=${setWorkspacePool}
                    onWeightChange=${setWorkspaceWeight}
                    saving=${savingWorkspaceExecutors}
                    hasChanges=${hasWorkspaceExecutorChanges}
                    onSave=${handleWorkspaceExecutorSave}
                    saveLabel="Save Workspace Executors"
                    minSlots=${1}
                    maxSlots=${20}
                  />
                </div>
              `
            : html`
                <div class="meta-text" style=${{ marginTop: "0.5rem" }}>
                  Select a managed workspace to edit workspace-specific executor settings.
                </div>
              `}
        <//>

        <${Card} className="command-console-card">
          <${Collapsible} title="Command Console" defaultOpen=${true}>
            <div class="meta-text mb-sm">Send commands with autocomplete and quick actions.</div>
            <div class="cmd-input-row mb-sm">
              <div class="cmd-input-wrap">
                <${TextField}
                  size="small"
                  variant="outlined"
                  className="cmd-input"
                  placeholder="/status"
                  value=${commandInput}
                  onChange=${(e) => {
                    setCommandInput(e.target.value);
                    setHistoryIndex(-1);
                  }}
                  onFocus=${() => setShowHistory(true)}
                  onBlur=${() => setTimeout(() => { setShowHistory(false); setShowAc(false); }, 200)}
                  onKeyDown=${handleConsoleKeyDown}
                  fullWidth
                />
                ${showAc && acItems.length > 0 && html`
                  <div class="cmd-dropdown">
                    ${acItems.map((item, i) => html`
                      <div
                        key=${item.cmd}
                        class="cmd-dropdown-item${i === acIndex ? ' selected' : ''}"
                        onMouseDown=${(e) => { e.preventDefault(); selectAcItem(item); }}
                        onMouseEnter=${() => setAcIndex(i)}
                      >
                        <div>
                          <span class="cmd-item-title">${item.cmd}</span>
                          <span class="cmd-item-desc">${item.desc}</span>
                        </div>
                        <span style=${{
                          fontSize: '0.7rem', padding: '2px 8px', borderRadius: '9999px',
                          background: (CAT_COLORS[item.cat] || '#6366f1') + '33',
                          color: CAT_COLORS[item.cat] || '#6366f1', fontWeight: 600,
                        }}>${item.cat}</span>
                      </div>
                    `)}
                  </div>
                `}
                ${!showAc && showHistory &&
                cmdHistory.length > 0 &&
                html`
                  <div class="cmd-history-dropdown">
                    <div style="padding:4px 6px;border-bottom:1px solid var(--border);">
                      <${TextField}
                        size="small"
                        variant="standard"
                        placeholder="Filter history…"
                        value=${historyFilter}
                        onInput=${(e) => setHistoryFilter(e.target.value)}
                        onMouseDown=${(e) => e.stopPropagation()}
                        fullWidth
                        InputProps=${{ sx: { fontSize: "0.8rem" } }}
                      />
                    </div>
                    ${filteredHistory.length > 0
                      ? filteredHistory.map(
                          (c, i) => html`
                            <${Button}
                              key=${i}
                              variant="text"
                              size="small"
                              className="cmd-history-item"
                              onMouseDown=${(e) => {
                                e.preventDefault();
                                setCommandInput(c);
                                setShowHistory(false);
                                setHistoryFilter("");
                              }}
                            >
                              ${c}
                            <//>
                          `,
                        )
                      : html`<div style="padding:8px;font-size:0.8rem;color:var(--text-secondary);text-align:center;">No matches</div>`}
                  </div>
                `}
              </div>
              <${Button}
                variant="contained"
                color="primary"
                size="small"
                disabled=${sendingCmd}
                onClick=${() => {
                  if (commandInput.trim()) {
                    sendCmd(commandInput.trim());
                    setCommandInput("");
                  }
                }}
              >
                ${sendingCmd ? html`<${CircularProgress} size=${14} />` : ICONS.send}
              <//>
            </div>

            <div class="cmd-quick-actions">
              ${["/status", "/health", "/menu", "/helpfull"].map(
                (cmd) => html`
                  <${Button}
                    key=${cmd}
                    variant="text"
                    size="small"
                    onClick=${() => sendCmd(cmd)}
                  >
                    ${cmd}
                  <//>
                `,
              )}
            </div>

            ${runningCmd && html`
              <div class="cmd-running-indicator" title="Polling supervisor logs for command output">
                <span class="cmd-running-dot"></span>
                Running: <code>${runningCmd}</code> · waiting for supervisor output (~${OUTPUT_POLL_WINDOW_SEC}s)
              </div>
            `}

            ${cmdOutputs.length > 0 && html`
              <div class="cmd-output-list">
                ${cmdOutputs.map((entry, idx) => html`
                  <div key=${idx} class="cmd-output-item">
                    <${Button}
                      variant="text"
                      size="small"
                      className="cmd-output-toggle"
                      onClick=${() => toggleOutput(idx)}
                      fullWidth
                    >
                      <span class="cmd-output-title">
                        <code>${entry.cmd}</code>
                      </span>
                      <span class="cmd-output-time">
                        ${new Date(entry.ts).toLocaleTimeString()} ${expandedOutputs[idx] ? '▲' : '▼'}
                      </span>
                    <//>
                    ${expandedOutputs[idx] && html`
                      <div style="display:flex;gap:4px;padding:4px 8px;border-bottom:1px solid var(--border);">
                        <${Button} variant="text" size="small" onClick=${() => copyOutput(entry.output)}>Copy<//>
                        <${Button} variant="text" size="small" onClick=${() => setOutputWrap((v) => !v)}>
                          ${outputWrap ? "No Wrap" : "Wrap"}
                        <//>
                      </div>
                      <div class="cmd-output-panel" style="white-space:${outputWrap ? 'pre-wrap' : 'pre'};overflow-x:${outputWrap ? 'visible' : 'auto'}">
                        ${entry.output.split("\n").map((line, li) => html`
                          <div key=${li} style="color:${colorizeOutputLine(line)}">${line}</div>
                        `)}
                      </div>
                    `}
                  </div>
                `)}
              </div>
            `}
          <//>
        <//>
      </div>

      <div class="control-side">
        <${Card} className="task-ops-card">
          <${Collapsible} title="Task Ops" defaultOpen=${!isCompact}>
            <div class="meta-text mb-sm">Start or retry work.</div>
            <div class="field-group">
              <div class="form-label">Backlog task</div>
              <div class="input-row">
                <${Select}
                  size="small"
                  error=${!!startTaskError}
                  value=${startTaskId}
                  aria-label="Backlog task"
                  onChange=${(e) => {
                    setStartTaskId(e.target.value);
                    setStartTaskError("");
                  }}
                  displayEmpty
                >
                  <${MenuItem} value="">Select backlog task…<//>
                  ${backlogTasks.map(
                    (task) => html`
                      <${MenuItem} key=${task.id} value=${task.id}>
                        ${truncate(task.title || "(untitled)", 48)} · ${task.id}
                      <//>
                    `,
                  )}
                <//>
                <${Button}
                  variant="outlined"
                  size="small"
                  disabled=${!startTaskId}
                  onClick=${handleStartTask}
                >
                  Start Task
                <//>
                <${Button}
                  variant="text"
                  size="small"
                  onClick=${refreshTaskOptions}
                  title="Refresh task list"
                >
                  ↻
                <//>
              </div>
              ${startTaskError
                ? html`<div class="form-hint error">${startTaskError}</div>`
                : null}
            </div>
            <div class="meta-text mb-sm">
              ${tasksLoading
                ? "Loading tasks…"
                : `${backlogTasks.length} backlog · ${retryTasks.length} retryable`}
            </div>
            <div class="field-group">
              <div class="form-label">Retry task</div>
              <div class="input-row">
                <${Select}
                  size="small"
                  error=${!!retryTaskError}
                  value=${retryTaskId}
                  aria-label="Retry task"
                  onChange=${(e) => {
                    setRetryTaskId(e.target.value);
                    setRetryTaskError("");
                  }}
                  displayEmpty
                >
                  <${MenuItem} value="">Select task to retry…<//>
                  ${retryTasks.map(
                    (task) => html`
                      <${MenuItem} key=${task.id} value=${task.id}>
                        ${truncate(task.title || "(untitled)", 48)} · ${task.id}
                      <//>
                    `,
                  )}
                <//>
                <${Button}
                  variant="outlined"
                  size="small"
                  disabled=${!retryTaskId}
                  onClick=${handleRetryTask}
                >
                  ↻ Retry
                <//>
              </div>
              ${retryTaskError
                ? html`<div class="form-hint error">${retryTaskError}</div>`
                : null}
            </div>

            <div class="field-group">
              <div class="form-label">Task Planner</div>
              <div class="plan-chips">
                ${["fix bugs", "add tests", "security", "refactor", "add docs", "performance"].map((chip) => html`
                  <${Chip}
                    key=${chip}
                    label=${chip}
                    size="small"
                    variant=${planFocus === chip ? "filled" : "outlined"}
                    color=${planFocus === chip ? "primary" : "default"}
                    onClick=${() => { haptic("light"); setPlanFocus(planFocus === chip ? "" : chip); }}
                  />
                `)}
              </div>
              <div class="input-row mt-sm">
                <span class="form-hint" style="flex:1;margin:0">Generate
                  <${TextField}
                    type="number"
                    size="small"
                    className="plan-count-input"
                    inputProps=${{ min: 1, max: 50 }}
                    value=${planCount}
                    onChange=${(e) => setPlanCount(e.target.value)}
                    sx=${{ width: "60px", mx: 0.5, display: "inline-flex", verticalAlign: "middle" }}
                  />
                  tasks${planFocus ? ` · ${planFocus}` : ""}
                </span>
                <${Button}
                  variant="text"
                  size="small"
                  onClick=${() => {
                    const n = Math.max(1, parseInt(planCount, 10) || 5);
                    sendCmd(planFocus ? `/plan ${n} ${planFocus}` : `/plan ${n}`);
                  }}
                >
                  ${iconText(":clipboard: Plan")}
                <//>
              </div>
            </div>
          <//>
        <//>

        <${Card} className="routing-card">
          <${Collapsible} title="Routing" defaultOpen=${!isCompact}>
            <div class="meta-text mb-sm">Runtime region override only. SDK and kanban backend changes now live in Settings to avoid accidental disruptive switches.</div>
            <div class="card-subtitle">SDK</div>
            <div class="meta-text mb-sm">Current: ${String(config?.sdk || "auto").toUpperCase()}</div>
            <div class="card-subtitle">Kanban</div>
            <div class="meta-text mb-sm">Current: ${config?.kanbanBackend || "internal"}</div>
            ${regions.length > 1 && html`
              <div class="card-subtitle mt-sm">Region</div>
              <${SegmentedControl}
                options=${regionOptions}
                value=${regions[0]}
                onChange=${(v) => updateConfig("region", v)}
              />
            `}
            ${regions.length <= 1 && html`
              <div class="card-subtitle mt-sm">Region</div>
              <div class="meta-text mb-sm">Current: ${regions[0] || "auto"}</div>
            `}
            <${Button}
              variant="text"
              size="small"
              sx=${{ mt: 1 }}
              onClick=${() => {
                import("../modules/router.js").then(({ navigateTo }) => navigateTo("settings"));
              }}
            >
              Open Settings
            <//>
          <//>
        <//>

        <${Card} className="quick-commands-card">
          <${Collapsible} title="Quick Commands" defaultOpen=${!isCompact}>
            <div class="meta-text mb-sm">Run a shell or git command.</div>
            <div class="form-label">Command</div>
            <div class="input-row mb-sm">
              <${Select}
                size="small"
                sx=${{ flex: "0 0 auto", width: "80px" }}
                value=${quickCmdPrefix}
                onChange=${(e) => setQuickCmdPrefix(e.target.value)}
              >
                <${MenuItem} value="shell">Shell<//>
                <${MenuItem} value="git">Git<//>
              <//>
              <${TextField}
                size="small"
                variant="outlined"
                placeholder=${quickCmdPrefix === "shell" ? "ls -la" : "status --short"}
                value=${quickCmdInput}
                onChange=${(e) => {
                  setQuickCmdInput(e.target.value);
                  if (quickCmdFeedbackTone === "error") setQuickCmdFeedback("");
                }}
                onKeyDown=${(e) => {
                  if (e.key === "Enter") handleQuickCmd();
                }}
                sx=${{ flex: 1 }}
              />
              <${Button} variant="outlined" size="small" onClick=${handleQuickCmd}>
                ${iconText(":play: Run")}
              <//>
            </div>
            ${quickCmdFeedback && html`
              <div class="form-hint ${quickCmdFeedbackTone === "error" ? "error" : "success"} mb-sm">
                ${iconText(quickCmdFeedback)}
              </div>
            `}
            <div class="meta-text">
              Output appears in agent logs. ${""}
              <a
                href="#"
                class="quick-commands-link"
                onClick=${(e) => {
                  e.preventDefault();
                  import("../modules/router.js").then(({ navigateTo }) => navigateTo("logs"));
                }}
              >Open Logs tab →</a>
            </div>
          <//>
        <//>
      </div>
    </div>
  `;
}
