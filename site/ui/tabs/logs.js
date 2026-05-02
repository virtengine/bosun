/* ─────────────────────────────────────────────────────────────
 *  Tab: Logs — system logs, agent log library, git snapshot
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

import {
  Typography, Box, Stack, Chip, Paper, TextField, InputAdornment,
  Select, MenuItem, FormControl, InputLabel, Button, IconButton, Tooltip,
  CircularProgress, Alert, Switch, FormControlLabel, Table, TableBody,
  TableCell, TableContainer, TableHead, TableRow, Divider, Tabs, Tab,
  LinearProgress, Skeleton, Card, CardContent,
} from "@mui/material";

import { haptic, showAlert, getTg, openLink } from "../modules/telegram.js";
import { apiFetch, sendCommandToChat } from "../modules/api.js";
import {
  logsData,
  logsLines,
  gitDiff,
  gitBranches,
  agentLogFiles,
  agentLogFilesMeta,
  agentLogFile,
  agentLogTail,
  agentLogLines,
  agentLogQuery,
  agentContext,
  agentWorkspaceTarget,
  loadLogs,
  loadAgentLogFileList,
  loadAgentLogTailData,
  loadAgentContextData,
  showToast,
  scheduleRefresh,
} from "../modules/state.js";
import { navigateTo } from "../modules/router.js";
import { ICONS } from "../modules/icons.js";
import { iconText } from "../modules/icon-utils.js";
import { formatBytes } from "../modules/utils.js";
import {
  Card as LegacyCard, Badge, EmptyState, SkeletonCard, Modal,
} from "../components/shared.js";
import { SearchInput } from "../components/forms.js";

/* ─── Log level helpers ─── */
const LOG_LEVELS = [
  { value: "all", label: "All", color: "default" },
  { value: "info", label: "Info", color: "info" },
  { value: "warn", label: "Warn", color: "warning" },
  { value: "error", label: "Error", color: "error" },
];

function levelChipColor(line) {
  const l = (line || "").toLowerCase();
  if (l.includes("error") || l.includes("fatal")) return "error";
  if (l.includes("warn")) return "warning";
  if (l.includes("debug")) return "secondary";
  return "info";
}

function filterByLevel(text, level) {
  if (!text || level === "all") return text;
  return text
    .split("\n")
    .filter((line) => {
      const lower = line.toLowerCase();
      if (level === "error")
        return (
          lower.includes("error") ||
          lower.includes("err") ||
          lower.includes("fatal")
        );
      if (level === "warn")
        return (
          lower.includes("warn") ||
          lower.includes("warning") ||
          lower.includes("error") ||
          lower.includes("fatal")
        );
      return true;
    })
    .join("\n");
}

/* ─── Helpers ─── */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightLine(text, search, isRegex) {
  if (!search || !search.trim()) return text;
  let regex;
  try {
    regex = isRegex
      ? new RegExp(search, "gi")
      : new RegExp(escapeRegex(search), "gi");
  } catch {
    return text;
  }
  const parts = [];
  let lastIndex = 0;
  let match;
  regex.lastIndex = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    parts.push(html`<mark class="log-hl">${match[0]}</mark>`);
    lastIndex = regex.lastIndex;
    if (match[0].length === 0) {
      regex.lastIndex++;
      if (regex.lastIndex > text.length) break;
    }
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length > 0 ? parts : text;
}

const LINE_HEIGHT = 20;
const SCROLL_BUFFER = 20;

function isMobileViewport() {
  const tg = getTg?.();
  const platform = String(tg?.platform || "").toLowerCase();
  if (platform === "ios" || platform === "android" || platform === "android_x") {
    return true;
  }
  if (typeof globalThis !== "undefined" && globalThis.matchMedia) {
    return globalThis.matchMedia("(max-width: 680px)").matches;
  }
  return false;
}

function parseTimestamp(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) return parseTimestamp(Number(trimmed));

    // Handle log filename timestamps like 2026-02-25T12-36-00-924Z
    const embedded = trimmed.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3})?Z)/);
    if (embedded?.[1]) {
      const normalized = embedded[1].replace(
        /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?Z/,
        (_m, date, hh, mm, ss, ms) => `${date}T${hh}:${mm}:${ss}${ms ? `.${ms}` : ""}Z`,
      );
      const embeddedDate = new Date(normalized);
      if (Number.isFinite(embeddedDate.getTime())) return embeddedDate;
    }

    const d = new Date(trimmed);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  if (typeof value === "object") {
    return (
      parseTimestamp(value.mtime) ||
      parseTimestamp(value.mtimeMs) ||
      parseTimestamp(value.updatedAt) ||
      parseTimestamp(value.createdAt) ||
      parseTimestamp(value.timestamp) ||
      parseTimestamp(value.date) ||
      parseTimestamp(value.time) ||
      parseTimestamp(value.seconds) ||
      parseTimestamp(value._seconds) ||
      parseTimestamp(value.sec)
    );
  }
  return null;
}

function formatTimestamp(value, fallback = "Unknown time") {
  const date = parseTimestamp(value);
  return date ? date.toLocaleString() : fallback;
}

function normalizeBranchEntry(entry) {
  if (entry == null) return "";
  if (typeof entry === "string") return entry;
  if (typeof entry === "object") {
    return (
      entry.raw ||
      entry.name ||
      entry.branch ||
      entry.ref ||
      entry.display ||
      entry.label ||
      ""
    );
  }
  return String(entry);
}

/* ─── LogsTab ─── */
export function LogsTab() {
  const logRef = useRef(null);
  const tailRef = useRef(null);
  const logFilesRef = useRef(null);
  const isAtBottomRef = useRef(true);
  const agentSearchTimerRef = useRef(null);

  const isMobile = useMemo(() => isMobileViewport(), []);
  const [localLogLines, setLocalLogLines] = useState(() => {
    const base = logsLines?.value ?? 200;
    return isMobile ? Math.min(base, 20) : base;
  });
  const [localAgentLines, setLocalAgentLines] = useState(
    agentLogLines?.value ?? 200,
  );
  const [agentSearchInput, setAgentSearchInput] = useState(
    agentLogQuery?.value ?? "",
  );
  const [agentSearchBusy, setAgentSearchBusy] = useState(false);
  const [agentSortBy, setAgentSortBy] = useState("modified");
  const [agentSortDir, setAgentSortDir] = useState("desc");
  const [agentAgeFilter, setAgentAgeFilter] = useState("all");
  const [agentStaleDays, setAgentStaleDays] = useState(7);
  const [agentPage, setAgentPage] = useState(0);
  const [agentPageSize, setAgentPageSize] = useState(100);
  const [logFilesScrollTop, setLogFilesScrollTop] = useState(0);
  const [logFilesContainerHeight, setLogFilesContainerHeight] = useState(280);
  const [tailSearch, setTailSearch] = useState("");
  const [tailLevel, setTailLevel] = useState("all");
  const [diffSearch, setDiffSearch] = useState("");
  const [contextQuery, setContextQuery] = useState("");
  const [logLevel, setLogLevel] = useState(isMobile ? "error" : "all");
  const [logSearch, setLogSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [regexMode, setRegexMode] = useState(false);
  const [logScrollTop, setLogScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(400);
  const [branchDetail, setBranchDetail] = useState(null);
  const [branchLoading, setBranchLoading] = useState(false);
  const [branchError, setBranchError] = useState(null);

  useEffect(() => {
    if (!isMobile) return;
    if (logsLines) logsLines.value = 20;
    setLocalLogLines(20);
    setLogLevel("error");
    loadLogs();
  }, [isMobile]);

  useEffect(() => {
    const timer = setInterval(() => {
      loadLogs({ force: true });
      if (agentLogFile?.value) {
        loadAgentLogTailData({ force: true });
      }
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  const branchFileDetails = useMemo(() => {
    if (!branchDetail) return [];
    if (Array.isArray(branchDetail.filesChanged) && branchDetail.filesChanged.length) {
      return branchDetail.filesChanged;
    }
    if (Array.isArray(branchDetail.filesDetailed) && branchDetail.filesDetailed.length) {
      return branchDetail.filesDetailed;
    }
    if (Array.isArray(branchDetail.files) && branchDetail.files.length) {
      return branchDetail.files.map((file) => ({ file }));
    }
    return [];
  }, [branchDetail]);

  const branchCommits = useMemo(() => {
    if (!branchDetail) return [];
    if (Array.isArray(branchDetail.commitList) && branchDetail.commitList.length) {
      return branchDetail.commitList;
    }
    if (Array.isArray(branchDetail.commits) && branchDetail.commits.length) {
      return branchDetail.commits;
    }
    return [];
  }, [branchDetail]);

  const workspaceLink = useMemo(() => {
    if (!branchDetail) return null;
    return branchDetail.workspaceLink || branchDetail.workspaceTarget || null;
  }, [branchDetail]);

  const contextData = useMemo(() => {
    const raw = agentContext?.value || null;
    if (!raw) return null;
    return raw.context || raw;
  }, [agentContext?.value]);

  const pagedAgentLogFiles = useMemo(() => {
    return Array.isArray(agentLogFiles?.value) ? agentLogFiles.value : [];
  }, [agentLogFiles?.value]);

  const logFilesTotal = Number(agentLogFilesMeta?.value?.total || pagedAgentLogFiles.length || 0);
  const logFilesPageCount = Math.max(1, Math.ceil(logFilesTotal / Math.max(1, agentPageSize)));
  const logFilesHasMore = Boolean(agentLogFilesMeta?.value?.hasMore);

  const logLibrarySummary = useMemo(() => {
    const rows = pagedAgentLogFiles;
    const totalSize = rows.reduce((sum, file) => sum + Number(file?.size || 0), 0);
    const newest = rows[0] || null;
    return {
      count: logFilesTotal,
      pageCount: rows.length,
      totalSize,
      newestLabel: newest ? formatTimestamp(newest.mtimeMs ?? newest.mtime, "Unknown") : "Unknown",
    };
  }, [pagedAgentLogFiles, logFilesTotal]);

  const LOG_FILE_ROW_HEIGHT = 44;
  const LOG_FILE_SCROLL_BUFFER = 12;
  const logFirstVisible = Math.floor(logFilesScrollTop / LOG_FILE_ROW_HEIGHT);
  const logStartIdx = Math.max(0, logFirstVisible - LOG_FILE_SCROLL_BUFFER);
  const logVisibleCount = Math.ceil(logFilesContainerHeight / LOG_FILE_ROW_HEIGHT);
  const logEndIdx = Math.min(
    pagedAgentLogFiles.length,
    logFirstVisible + logVisibleCount + LOG_FILE_SCROLL_BUFFER,
  );
  const logTopSpacer = logStartIdx * LOG_FILE_ROW_HEIGHT;
  const logBottomSpacer = Math.max(0, (pagedAgentLogFiles.length - logEndIdx) * LOG_FILE_ROW_HEIGHT);
  const visibleLogFiles = pagedAgentLogFiles.slice(logStartIdx, logEndIdx);

  /* Raw log text */
  const rawLogText = logsData?.value?.lines
    ? logsData.value.lines.join("\n")
    : "No logs yet.";

  const rawTailText = agentLogTail?.value?.lines
    ? agentLogTail.value.lines.join("\n")
    : "Select a log file.";

  /* Filtered tail lines */
  const { filteredTailLines, tailMatchCount } = useMemo(() => {
    const allLines = (agentLogTail?.value?.lines || []);
    if (!allLines.length) return { filteredTailLines: ["Select a log file."], tailMatchCount: 0 };
    let lines = allLines;
    if (tailLevel !== "all") {
      lines = lines.filter((line) => {
        const lower = (line || "").toLowerCase();
        if (tailLevel === "error") return lower.includes("error") || lower.includes("fatal");
        if (tailLevel === "warn") return lower.includes("warn");
        if (tailLevel === "info") return lower.includes("info") || (!lower.includes("error") && !lower.includes("warn") && !lower.includes("debug"));
        return true;
      });
    }
    if (!tailSearch.trim()) return { filteredTailLines: lines, tailMatchCount: 0 };
    const q = tailSearch.toLowerCase();
    const matched = lines.filter((l) => (l || "").toLowerCase().includes(q));
    return { filteredTailLines: matched.length ? matched : ["No matching lines."], tailMatchCount: matched.length };
  }, [agentLogTail?.value, tailSearch, tailLevel]);

  /* Filtered log lines (memoized) */
  const { filteredLines, matchCount } = useMemo(() => {
    const leveled = filterByLevel(rawLogText, logLevel);
    const allLines = leveled.split("\n");
    if (!logSearch.trim()) {
      return { filteredLines: allLines, matchCount: 0 };
    }
    let testFn;
    if (regexMode) {
      try {
        const re = new RegExp(logSearch, "i");
        testFn = (line) => re.test(line);
      } catch {
        testFn = (line) =>
          line.toLowerCase().includes(logSearch.toLowerCase());
      }
    } else {
      const q = logSearch.toLowerCase();
      testFn = (line) => line.toLowerCase().includes(q);
    }
    const matched = allLines.filter(testFn);
    if (matched.length === 0) {
      return { filteredLines: ["No matching lines."], matchCount: 0 };
    }
    return { filteredLines: matched, matchCount: matched.length };
  }, [rawLogText, logLevel, logSearch, regexMode]);

  const filteredLogText = filteredLines.join("\n");

  /* Virtual scroll calculations */
  const totalLines = filteredLines.length;
  const firstVisible = Math.floor(logScrollTop / LINE_HEIGHT);
  const startIdx = Math.max(0, firstVisible - SCROLL_BUFFER);
  const visibleCount = Math.ceil(containerHeight / LINE_HEIGHT);
  const endIdx = Math.min(totalLines, firstVisible + visibleCount + SCROLL_BUFFER);
  const topSpacer = startIdx * LINE_HEIGHT;
  const bottomSpacer = Math.max(0, (totalLines - endIdx) * LINE_HEIGHT);
  const visibleLines = filteredLines.slice(startIdx, endIdx);

  /* Scroll handler */
  const handleLogScroll = useCallback((e) => {
    const el = e.target;
    setLogScrollTop(el.scrollTop);
    isAtBottomRef.current =
      el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
  }, []);

  /* Container height measurement */
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    setContainerHeight(el.clientHeight);
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver((entries) => {
        for (const entry of entries)
          setContainerHeight(entry.contentRect.height);
      });
      ro.observe(el);
      return () => ro.disconnect();
    }
  }, []);

  /* Auto-scroll */
  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [filteredLines, autoScroll]);

  useEffect(() => {
    if (autoScroll && tailRef.current) {
      tailRef.current.scrollTop = tailRef.current.scrollHeight;
    }
  }, [rawTailText, autoScroll]);

  /* ── System log handlers ── */
  const handleLogLinesChange = async (value) => {
    setLocalLogLines(value);
    if (logsLines) logsLines.value = value;
    await loadLogs();
  };

  /* ── Agent log handlers ── */
  const handleAgentSearch = useCallback(async (query = agentSearchInput, options = {}) => {
    const normalized = String(query || "").trim();
    const page = Math.max(0, Number(options?.page ?? agentPage));
    const pageSize = Math.max(20, Math.min(500, Number(options?.pageSize ?? agentPageSize)));
    const shouldResetSelection = options?.resetSelection !== false;
    if (agentLogQuery) agentLogQuery.value = normalized;
    if (agentLogFile && shouldResetSelection) {
      agentLogFile.value = "";
    }
    if (options?.haptic !== false) haptic();
    setAgentSearchBusy(true);
    try {
      await loadAgentLogFileList({
        offset: page * pageSize,
        limit: pageSize,
        sortBy: agentSortBy,
        sortDir: agentSortDir,
        age: agentAgeFilter,
        staleDays: agentStaleDays,
      });
      if (agentLogFile?.value) {
        await loadAgentLogTailData({ force: true });
      }
    } finally {
      setAgentSearchBusy(false);
    }
  }, [agentSearchInput, agentPage, agentPageSize, agentSortBy, agentSortDir, agentAgeFilter, agentStaleDays]);

  const normalizeBranchLine = (line) => {
    const rawEntry = normalizeBranchEntry(line);
    if (!rawEntry) return null;
    const cleaned = rawEntry.replace(/^\*\s*/, "").trim();
    const noRemote = cleaned.replace(/^remotes\//, "");
    const short = noRemote.replace(/^origin\//, "");
    return { raw: rawEntry, name: noRemote, short };
  };

  const openBranchDetail = async (line) => {
    const parsed = normalizeBranchLine(line);
    if (!parsed?.name) return;
    setBranchError(null);
    setBranchLoading(true);
    setBranchDetail({ branch: parsed.name });
    try {
      const res = await apiFetch(
        `/api/git/branch-detail?branch=${encodeURIComponent(parsed.name)}`,
      );
      setBranchDetail(res.data || null);
    } catch (err) {
      setBranchError(err.message || "Failed to load branch detail");
    } finally {
      setBranchLoading(false);
    }
  };

  const openWorkspace = (detail) => {
    if (!detail) return;
    const target =
      detail?.workspaceTarget ||
      {
        taskId: detail?.activeSlot?.taskId || detail?.worktree?.taskKey || null,
        taskTitle: detail?.activeSlot?.taskTitle || detail?.branch || "Workspace",
        branch: detail?.branch || null,
      };
    agentWorkspaceTarget.value = {
      taskId: target.taskId || null,
      taskTitle: target.taskTitle || detail?.branch || "Workspace",
      branch: target.branch || detail?.branch || null,
    };
    navigateTo("agents");
  };

  const handleAgentOpen = async (name) => {
    haptic();
    if (agentLogFile) agentLogFile.value = name;
    await loadAgentLogTailData({ force: true });
  };

  const handleAgentLinesChange = async (value) => {
    setLocalAgentLines(value);
    if (agentLogLines) agentLogLines.value = value;
    await loadAgentLogTailData();
  };

  /* ── Context handler ── */
  const handleContextLoad = async () => {
    haptic();
    await loadAgentContextData(contextQuery.trim());
  };

  useEffect(() => {
    if (agentSearchTimerRef.current) clearTimeout(agentSearchTimerRef.current);
    setAgentPage(0);
    agentSearchTimerRef.current = setTimeout(() => {
      handleAgentSearch(agentSearchInput, { haptic: false, resetSelection: false, page: 0 });
    }, 350);
    return () => {
      if (agentSearchTimerRef.current) clearTimeout(agentSearchTimerRef.current);
    };
  }, [agentSearchInput, handleAgentSearch]);

  useEffect(() => {
    handleAgentSearch(agentSearchInput, { haptic: false, resetSelection: false, page: agentPage });
  }, [agentPage, agentPageSize, agentSortBy, agentSortDir, agentAgeFilter]);

  useEffect(() => {
    const el = logFilesRef.current;
    if (!el) return;
    setLogFilesContainerHeight(el.clientHeight || 280);
    const onScroll = (event) => {
      setLogFilesScrollTop(event.target.scrollTop || 0);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    let resizeObserver = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          setLogFilesContainerHeight(entry.contentRect.height || 280);
        }
      });
      resizeObserver.observe(el);
    }
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (resizeObserver) resizeObserver.disconnect();
    };
  }, []);

  /* ── Git handler ── */
  const handleGitRefresh = async () => {
    haptic();
    const [branches, diff] = await Promise.all([
      apiFetch("/api/git/branches", { _silent: true }).catch(() => ({
        data: [],
      })),
      apiFetch("/api/git/diff", { _silent: true }).catch(() => ({ data: "" })),
    ]);
    if (gitBranches) gitBranches.value = branches.data || [];
    if (gitDiff) gitDiff.value = diff.data || "";
  };

  /* ── Copy to clipboard ── */
  const copyToClipboard = async (text, label) => {
    haptic();
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      showToast(`${label} copied`, "success");
    } catch {
      showToast("Copy failed", "error");
    }
  };

  /* ── Download logs ── */
  const downloadLogs = useCallback(() => {
    haptic();
    const blob = new Blob([filteredLogText], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const d = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    a.href = url;
    a.download = `bosun-logs-${d}.log`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("Log file downloaded", "success");
  }, [filteredLogText]);

  return html`
    <style>
      .log-line { display: flex; align-items: baseline; }
      .log-ln { min-width: 3.5em; text-align: right; padding-right: 8px; opacity: 0.35; user-select: none; font-size: 0.85em; }
      .log-lt { flex: 1; white-space: pre-wrap; word-break: break-all; }
      .log-hl { background: rgba(250,204,21,0.3); border-radius: 2px; padding: 0 1px; }
    </style>
    <!-- Loading skeleton -->
    ${!logsData?.value && !agentLogFiles?.value && html`
      <${Paper} elevation=${1} sx=${{ p: 2, mb: 2 }}>
        <${Typography} variant="h6" gutterBottom>Loading Logs…<//>
        <${Skeleton} variant="rectangular" height=${120} />
      <//>
    `}

    <!-- ── System Logs ── -->
    <${Paper} elevation=${1} sx=${{ p: 2, mb: 2 }}>
      <${Typography} variant="h6" gutterBottom>System Logs<//>

      <!-- Line count slider -->
      <${Stack} direction="row" alignItems="center" spacing=${1} sx=${{ mb: 1 }}>
        <${TextField}
          type="number" size="small" variant="outlined"
          inputProps=${{ min: 20, max: 800, step: 20 }}
          value=${localLogLines}
          onInput=${(e) => setLocalLogLines(Number(e.target.value))}
          onChange=${(e) => handleLogLinesChange(Number(e.target.value))}
          sx=${{ flex: 1 }}
        />
        <${Chip} label="${localLogLines} lines" size="small" variant="outlined" />
      <//>

      <!-- Quick-select line counts -->
      <${Stack} direction="row" spacing=${1} sx=${{ mb: 1 }}>
        ${[50, 200, 500].map(
          (n) => html`
            <${Chip}
              key=${n}
              label=${String(n)}
              size="small"
              color=${(logsLines?.value ?? localLogLines) === n ? "primary" : "default"}
              variant=${(logsLines?.value ?? localLogLines) === n ? "filled" : "outlined"}
              onClick=${() => handleLogLinesChange(n)}
              clickable
            />
          `,
        )}
      <//>

      <!-- Log level filter chips -->
      <${Stack} direction="row" spacing=${1} sx=${{ mb: 1.5 }}>
        ${LOG_LEVELS.map(
          (l) => html`
            <${Chip}
              key=${l.value}
              label=${l.label}
              size="small"
              color=${logLevel === l.value ? l.color : "default"}
              variant=${logLevel === l.value ? "filled" : "outlined"}
              onClick=${() => { haptic(); setLogLevel(l.value); }}
              clickable
            />
          `,
        )}
      <//>

      <!-- Search / regex / auto-scroll controls -->
      <${Stack} direction="row" spacing=${1} alignItems="center" sx=${{ mb: 1.5 }}>
        <${TextField}
          size="small"
          fullWidth
          placeholder=${regexMode ? "Regex pattern…" : "Search/grep logs…"}
          value=${logSearch}
          onInput=${(e) => setLogSearch(e.target.value)}
          InputProps=${{
            endAdornment: logSearch.trim() && matchCount > 0
              ? html`<${InputAdornment} position="end">
                  <${Chip} label="${matchCount} matches" size="small" color="info" />
                <//>` : null,
          }}
        />
        <${Tooltip} title="Toggle regex mode">
          <${IconButton}
            size="small"
            color=${regexMode ? "primary" : "default"}
            onClick=${() => { setRegexMode(!regexMode); haptic(); }}
            sx=${{ fontFamily: "monospace", fontWeight: "bold" }}
          >.*<//>
        <//>
        <${FormControlLabel}
          control=${html`<${Switch}
            size="small"
            checked=${autoScroll}
            onChange=${() => { setAutoScroll(!autoScroll); haptic(); }}
          />`}
          label="Auto-scroll"
          sx=${{ whiteSpace: "nowrap", ml: 0.5 }}
        />
      <//>

      <!-- Virtualized log viewer -->
      <${Paper}
        variant="outlined"
        ref=${logRef}
        onScroll=${handleLogScroll}
        sx=${{
          maxHeight: 400, overflow: "auto", p: 1, mb: 1,
          fontFamily: "monospace", fontSize: "0.82rem",
          bgcolor: "grey.900", color: "grey.100",
        }}
      >
        <div style="height:${topSpacer}px"></div>
        ${visibleLines.map((line, i) => {
          const lineNum = startIdx + i + 1;
          return html`<div class="log-line" key=${lineNum} style="height:${LINE_HEIGHT}px">
            <${Typography} variant="caption" component="span" className="log-ln" sx=${{ color: "grey.500" }}>${lineNum}<//>
            <span class="log-lt">${logSearch.trim() ? highlightLine(line, logSearch, regexMode) : line}</span>
          </div>`;
        })}
        <div style="height:${bottomSpacer}px"></div>
      <//>

      <!-- Action buttons -->
      <${Stack} direction="row" spacing=${1}>
        <${Tooltip} title="Send logs to chat">
          <${Button} size="small" variant="outlined"
            onClick=${() => sendCommandToChat(`/logs ${logsLines?.value ?? localLogLines}`)}
          >/logs to chat<//>
        <//>
        <${Tooltip} title="Copy logs to clipboard">
          <${Button} size="small" variant="outlined"
            onClick=${() => copyToClipboard(filteredLogText, "Logs")}
          >${iconText(":clipboard: Copy")}<//>
        <//>
        <${Tooltip} title="Download log file">
          <${Button} size="small" variant="outlined"
            onClick=${downloadLogs}
          >${iconText(":save: Download")}<//>
        <//>
      <//>
    <//>

    <!-- ── Agent Log Library ── -->
    <${Paper} elevation=${1} sx=${{ p: 2, mb: 2 }}>
      <${Typography} variant="h6" gutterBottom>Agent Log Library<//>
      <${Stack} direction="row" spacing=${1} sx=${{ mb: 1.5 }}>
        <${SearchInput}
          value=${agentSearchInput}
          placeholder="Search file names and high-signal lines..."
          onInput=${(e) => setAgentSearchInput(e.target.value)}
          onClear=${() => setAgentSearchInput("")}
          onKeyDown=${(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              setAgentPage(0);
              handleAgentSearch(agentSearchInput, { resetSelection: false, page: 0 });
            }
          }}
        />
        <${Button}
          size="small"
          variant="contained"
          onClick=${() => {
            setAgentPage(0);
            handleAgentSearch(agentSearchInput, { resetSelection: false, page: 0 });
          }}
          disabled=${agentSearchBusy}
        >
          ${agentSearchBusy ? "Searching..." : iconText(":search: Search")}
        <//>
      <//>
      <${Stack} direction="row" spacing=${1} sx=${{ mb: 1.5, flexWrap: "wrap" }}>
        <${Select}
          size="small"
          value=${agentSortBy}
          onChange=${(e) => {
            setAgentPage(0);
            setAgentSortBy(e.target.value);
          }}
          sx=${{ minWidth: 130 }}
        >
          <${MenuItem} value="modified">Sort: Modified<//>
          <${MenuItem} value="name">Sort: Name<//>
          <${MenuItem} value="size">Sort: Size<//>
          <${MenuItem} value="relevance">Sort: Relevance<//>
        <//>
        <${Select}
          size="small"
          value=${agentSortDir}
          onChange=${(e) => {
            setAgentPage(0);
            setAgentSortDir(e.target.value);
          }}
          sx=${{ minWidth: 120 }}
        >
          <${MenuItem} value="desc">Newest First<//>
          <${MenuItem} value="asc">Oldest First<//>
        <//>
        <${Select}
          size="small"
          value=${agentAgeFilter}
          onChange=${(e) => {
            setAgentPage(0);
            setAgentAgeFilter(e.target.value);
          }}
          sx=${{ minWidth: 150 }}
        >
          <${MenuItem} value="all">All Ages<//>
          <${MenuItem} value="recent">Recent<//>
          <${MenuItem} value="stale">Stale<//>
        <//>
        ${agentAgeFilter !== "all" && html`
          <${Select}
            size="small"
            value=${agentStaleDays}
            onChange=${(e) => {
              setAgentPage(0);
              setAgentStaleDays(Number(e.target.value));
            }}
            sx=${{ minWidth: 120 }}
          >
            <${MenuItem} value=${1}>1 day<//>
            <${MenuItem} value=${3}>3 days<//>
            <${MenuItem} value=${7}>7 days<//>
            <${MenuItem} value=${14}>14 days<//>
            <${MenuItem} value=${30}>30 days<//>
            <${MenuItem} value=${60}>60 days<//>
            <${MenuItem} value=${90}>90 days<//>
          <//>
        `}
      <//>
      <${Stack} direction="row" alignItems="center" spacing=${1} sx=${{ mb: 1.5 }}>
        <${TextField}
          type="number"
          size="small"
          variant="outlined"
          inputProps=${{ min: 50, max: 800, step: 50 }}
          value=${localAgentLines}
          onInput=${(e) => setLocalAgentLines(Number(e.target.value))}
          onChange=${(e) => handleAgentLinesChange(Number(e.target.value))}
          sx=${{ flex: 1 }}
        />
        <${Select}
          size="small"
          value=${agentPageSize}
          onChange=${(e) => {
            setAgentPage(0);
            setAgentPageSize(Number(e.target.value));
          }}
          sx=${{ minWidth: 110 }}
        >
          <${MenuItem} value=${50}>Page 50<//>
          <${MenuItem} value=${100}>Page 100<//>
          <${MenuItem} value=${200}>Page 200<//>
          <${MenuItem} value=${300}>Page 300<//>
        <//>
        <${Chip} label="${localAgentLines} lines" size="small" variant="outlined" />
        <${Chip} label="${logLibrarySummary.count} files" size="small" color="info" variant="outlined" />
        <${Chip} label="page ${agentPage + 1}/${logFilesPageCount}" size="small" color="default" variant="outlined" />
        <${Chip} label="${formatBytes(logLibrarySummary.totalSize)}" size="small" color="default" variant="outlined" />
        <${Chip} label="Latest: ${logLibrarySummary.newestLabel}" size="small" color="default" variant="outlined" />
      <//>
    <//>

    <!-- ── Log Files list ── -->
    <${Paper} elevation=${1} sx=${{ p: 2, mb: 2 }}>
      <${Typography} variant="h6" gutterBottom>Log Files<//>
      ${pagedAgentLogFiles.length
        ? html`
          <${TableContainer} ref=${logFilesRef} sx=${{ maxHeight: 320, overflow: "auto" }}>
            <${Table} size="small">
              <${TableHead}>
                <${TableRow}>
                  <${TableCell}>Name<//>
                  <${TableCell}>Size<//>
                  <${TableCell}>Modified<//>
                  <${TableCell} align="right">Type<//>
                </${TableRow}>
              <//>
              <${TableBody}>
                ${logTopSpacer > 0
                  ? html`<${TableRow}><${TableCell} colSpan=${4} sx=${{ p: 0, border: 0, height: `${logTopSpacer}px` }} /><//>`
                  : null}
                ${visibleLogFiles.map(
                  (file) => html`
                    <${TableRow}
                      key=${file.name}
                      hover
                      selected=${agentLogFile?.value === file.name}
                      sx=${{ cursor: "pointer" }}
                      onClick=${() => handleAgentOpen(file.name)}
                    >
                      <${TableCell}>
                        <${Typography} variant="body2" sx=${{ fontFamily: "monospace" }}>${file.name}<//>
                      <//>
                      <${TableCell}>
                        <${Typography} variant="caption">${formatBytes ? formatBytes(file.size) : Math.round(file.size / 1024) + "kb"}<//>
                      <//>
                      <${TableCell}>
                        <${Typography} variant="caption">${formatTimestamp(file.mtime ?? file.mtimeMs ?? file.updatedAt, "time unknown")}<//>
                      <//>
                      <${TableCell} align="right">
                        <${Chip} label="log" size="small" color="default" variant="outlined" />
                      <//>
                    </${TableRow}>
                  `,
                )}
                ${logBottomSpacer > 0
                  ? html`<${TableRow}><${TableCell} colSpan=${4} sx=${{ p: 0, border: 0, height: `${logBottomSpacer}px` }} /><//>`
                  : null}
              <//>
            </${Table}>
          <//>
          <${Stack} direction="row" spacing=${1} sx=${{ mt: 1 }}>
            <${Button}
              size="small"
              variant="outlined"
              disabled=${agentPage <= 0 || agentSearchBusy}
              onClick=${() => setAgentPage((p) => Math.max(0, p - 1))}
            >Prev<//>
            <${Button}
              size="small"
              variant="outlined"
              disabled=${!logFilesHasMore || agentSearchBusy}
              onClick=${() => setAgentPage((p) => p + 1)}
            >Next<//>
          <//>
        `
        : html`<${EmptyState} message="No log files found." />`}
    <//>

    <!-- ── Log Tail viewer ── -->
    <${Paper} elevation=${1} sx=${{ p: 2, mb: 2 }}>
      <${Stack} direction="row" alignItems="center" spacing=${1} sx=${{ mb: 1 }}>
        <${Typography} variant="h6">${agentLogFile?.value || "Log Tail"}<//>
        ${agentLogTail?.value?.truncated && html`<${Chip} label="Tail clipped" size="small" color="warning" />`}
        ${rawTailText && rawTailText !== "Select a log file." && html`
          <${Chip} label="${rawTailText.split('\\n').length} lines" size="small" color="info" variant="outlined" />
        `}
      <//>
      <${Stack} direction="row" spacing=${1} sx=${{ mb: 1 }}>
        <${TextField}
          size="small"
          fullWidth
          placeholder="Filter tail lines..."
          value=${tailSearch}
          onInput=${(e) => setTailSearch(e.target.value)}
          InputProps=${{
            endAdornment: tailSearch.trim() && tailMatchCount > 0
              ? html`<${InputAdornment} position="end">
                  <${Chip} label="${tailMatchCount} matches" size="small" color="info" />
                <//>` : null,
          }}
        />
        <${Stack} direction="row" spacing=${0.5}>
          ${["all", "error", "warn", "info"].map((level) => html`
            <${Chip}
              key=${level}
              label=${level}
              size="small"
              color=${tailLevel === level ? (level === "error" ? "error" : level === "warn" ? "warning" : "info") : "default"}
              variant=${tailLevel === level ? "filled" : "outlined"}
              onClick=${() => setTailLevel(level)}
              clickable
            />
          `)}
        <//>
      <//>
      <${Paper}
        variant="outlined"
        ref=${tailRef}
        sx=${{
          maxHeight: 360, overflow: "auto", p: 1, mb: 1,
          fontFamily: "monospace", fontSize: "0.82rem",
          bgcolor: "grey.900", color: "grey.100",
        }}
      >
        ${filteredTailLines.map((line, i) => {
          const color = levelChipColor(line);
          const dotColor = color === "error" ? "#f87171" : color === "warning" ? "#fbbf24" : color === "secondary" ? "#a78bfa" : "#60a5fa";
          return html`<div key=${i} style="display:flex;align-items:baseline;min-height:20px">
            <span style="min-width:3em;text-align:right;padding-right:8px;opacity:0.35;user-select:none;font-size:0.85em">${i + 1}</span>
            <span style="width:6px;height:6px;border-radius:50%;background:${dotColor};flex-shrink:0;margin-right:6px;margin-top:5px"></span>
            <span style="flex:1;white-space:pre-wrap;word-break:break-all">${tailSearch.trim() ? highlightLine(line, tailSearch, false) : line}</span>
          </div>`;
        })}
      <//>
      <${Stack} direction="row" spacing=${1}>
        <${Tooltip} title="Copy log tail">
          <${Button} size="small" variant="outlined"
            onClick=${() => copyToClipboard(filteredTailLines.join("\\n"), "Log tail")}
          >${iconText(":clipboard: Copy")}<//>
        <//>
        <${Tooltip} title="Download tail as file">
          <${Button} size="small" variant="outlined"
            onClick=${() => {
              const blob = new Blob([filteredTailLines.join("\\n")], { type: "text/plain" });
              const u = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = u;
              a.download = (agentLogFile?.value || "tail") + ".log";
              document.body.appendChild(a);
              a.click();
              a.remove();
              URL.revokeObjectURL(u);
              showToast("Tail downloaded", "success");
            }}
          >${iconText(":save: Download")}<//>
        <//>
      <//>
    <//>

    <!-- ── Worktree Context ── -->
    <${Paper} elevation=${1} sx=${{ p: 2, mb: 2 }}>
      <${Typography} variant="h6" gutterBottom>Worktree Context<//>
      <${Stack} direction="row" spacing=${1} sx=${{ mb: 1.5 }}>
        <${TextField}
          size="small"
          fullWidth
          placeholder="Branch fragment or worktree name"
          value=${contextQuery}
          onInput=${(e) => setContextQuery(e.target.value)}
          onKeyDown=${(e) => {
            if (e.key === "Enter") { e.preventDefault(); handleContextLoad(); }
          }}
        />
        <${Button} size="small" variant="contained" onClick=${handleContextLoad}>
          ${iconText(":folder: Load")}
        <//>
      <//>
      ${contextData && html`
        <${Stack} direction="row" spacing=${1} sx=${{ mb: 1.5, flexWrap: "wrap" }}>
          <${Chip} label=${"Worktree: " + (contextData.name || contextData.path || "?")} size="small" color="primary" variant="outlined" />
          ${contextData.branch && html`<${Chip} label="Branch: ${contextData.branch}" size="small" color="info" variant="outlined" />`}
          ${contextData.base && html`<${Chip} label="Base: ${contextData.base}" size="small" color="default" variant="outlined" />`}
          ${(contextData.path || contextData.worktreePath) && html`<${Chip} label="Path: ${contextData.path || contextData.worktreePath}" size="small" color="default" variant="outlined" />`}
        <//>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
          <${Paper} variant="outlined" sx=${{ p: 1.5 }}>
            <${Typography} variant="subtitle2" gutterBottom>Git Log<//>
            <${Paper} variant="outlined" sx=${{
              maxHeight: 180, overflow: "auto", p: 1,
              fontFamily: "monospace", fontSize: "0.78rem",
              bgcolor: "grey.900", color: "grey.100",
            }}>${contextData.gitLog || "No git log."}<//>
          <//>
          <${Paper} variant="outlined" sx=${{ p: 1.5 }}>
            <${Typography} variant="subtitle2" gutterBottom>Git Status<//>
            <${Paper} variant="outlined" sx=${{
              maxHeight: 180, overflow: "auto", p: 1,
              fontFamily: "monospace", fontSize: "0.78rem",
              bgcolor: "grey.900", color: "grey.100",
            }}>${contextData.gitStatus || "Clean worktree."}<//>
          <//>
        </div>
        ${contextData.diffStat && html`
          <${Paper} variant="outlined" sx=${{ p: 1.5, mb: 1 }}>
            <${Typography} variant="subtitle2" gutterBottom>Diff Stat<//>
            <${Paper} variant="outlined" sx=${{
              maxHeight: 140, overflow: "auto", p: 1,
              fontFamily: "monospace", fontSize: "0.78rem",
              bgcolor: "grey.900", color: "grey.100",
            }}>${contextData.diffStat}<//>
          <//>
        `}
        <${Stack} direction="row" spacing=${1}>
          <${Tooltip} title="Copy context">
            <${Button} size="small" variant="outlined"
              onClick=${() =>
                copyToClipboard(
                  [
                    contextData.gitLog,
                    contextData.gitStatus,
                    contextData.diffStat,
                  ]
                    .filter(Boolean)
                    .join("\n\n"),
                  "Context",
                )}
            >${iconText(":clipboard: Copy")}<//>
          <//>
        <//>
      `}
      ${!contextData && html`
        <${Paper}
          variant="outlined"
          sx=${{
            maxHeight: 140, overflow: "auto", p: 2, mb: 1,
            fontFamily: "monospace", fontSize: "0.82rem",
            bgcolor: "grey.900", color: "grey.400",
            textAlign: "center",
          }}
        >Load a worktree context to view git log/status.<//>
      `}
    <//>

    <!-- ── Git Snapshot ── -->
    <${Paper} elevation=${1} sx=${{ p: 2, mb: 2 }}>
      <${Stack} direction="row" alignItems="center" spacing=${1} sx=${{ mb: 1.5 }}>
        <${Typography} variant="h6">Git Snapshot<//>
        ${(gitBranches?.value || []).length > 0 && html`
          <${Chip} label="${(gitBranches.value || []).length} branches" size="small" color="info" variant="outlined" />
        `}
        ${gitDiff?.value && html`
          <${Chip} label="${gitDiff.value.split('\\n').length} diff lines" size="small" color="default" variant="outlined" />
        `}
      <//>
      <${Stack} direction="row" spacing=${1} sx=${{ mb: 1.5 }}>
        <${Button} size="small" variant="contained" onClick=${handleGitRefresh}>
          ${ICONS.refresh} Refresh
        <//>
        <${Button} size="small" variant="outlined"
          onClick=${() => sendCommandToChat("/diff")}
        >/diff<//>
        <${Tooltip} title="Copy diff">
          <${Button} size="small" variant="outlined"
            onClick=${() => copyToClipboard(gitDiff?.value || "", "Diff")}
          >${iconText(":clipboard: Copy")}<//>
        <//>
      <//>
      <${TextField}
        size="small"
        fullWidth
        placeholder="Search diff..."
        value=${diffSearch}
        onInput=${(e) => setDiffSearch(e.target.value)}
        sx=${{ mb: 1 }}
      />
      <${Paper}
        variant="outlined"
        sx=${{
          maxHeight: 300, overflow: "auto", p: 1, mb: 2,
          fontFamily: "monospace", fontSize: "0.82rem",
          bgcolor: "grey.900", color: "grey.100",
        }}
      >
        ${(() => {
          const raw = gitDiff?.value || "Clean working tree.";
          if (!diffSearch.trim()) return raw;
          const q = diffSearch.toLowerCase();
          const lines = raw.split("\\n").filter((l) => l.toLowerCase().includes(q));
          return lines.length ? lines.join("\\n") : "No matching lines.";
        })()}
      <//>

      <${Typography} variant="subtitle2" sx=${{ mb: 1 }}>Recent Branches<//>
      ${(gitBranches?.value || []).length
        ? (gitBranches.value || []).map(
            (line, i) => {
              const parsed = normalizeBranchLine(line);
              return html`
                <${Button}
                  key=${i}
                  fullWidth
                  variant="text"
                  size="small"
                  onClick=${() => openBranchDetail(parsed?.name || line)}
                  sx=${{ justifyContent: "space-between", textTransform: "none", mb: 0.5, fontFamily: "monospace" }}
                >
                  <span>${parsed?.short || line}</span>
                  <${Typography} variant="caption" color="text.secondary">${parsed?.raw || line}<//>
                <//>
              `;
            },
          )
        : html`<${Typography} variant="body2" color="text.secondary">No branches found. Click Refresh to re-query git.<//>`}
    <//>

    ${branchDetail &&
    html`
      <${Modal} title="Branch Detail" onClose=${() => setBranchDetail(null)}>
        ${branchLoading && html`<${LinearProgress} sx=${{ mb: 1 }} />`}
        ${branchError && html`<${Alert} severity="error" sx=${{ mb: 1 }}>${branchError}<//>`}
        ${!branchLoading &&
        !branchError &&
        html`
          <${Typography} variant="body2" sx=${{ mb: 1 }}>
            Branch: <${Typography} component="span" sx=${{ fontFamily: "monospace" }}>${branchDetail.branch}<//>
          <//>
          ${branchDetail.base &&
          html`<${Typography} variant="body2" sx=${{ mb: 1 }}>Base: ${branchDetail.base}<//>`}
          ${branchDetail.activeSlot &&
          html`<${Typography} variant="body2" sx=${{ mb: 1 }}>Active Agent: ${branchDetail.activeSlot.taskTitle || branchDetail.activeSlot.taskId}<//>`}
          ${branchDetail.worktree?.path &&
          html`<${Typography} variant="body2" sx=${{ mb: 1 }}>Worktree: <${Typography} component="span" sx=${{ fontFamily: "monospace" }}>${branchDetail.worktree.path}<//><//>`}
          <${Stack} direction="row" spacing=${1} sx=${{ mb: 1.5 }}>
            ${(branchDetail.workspaceTarget || branchDetail.activeSlot || branchDetail.worktree) &&
            html`<${Button} size="small" variant="contained" onClick=${() => openWorkspace(branchDetail)}>
              ${iconText(":search: Open Workspace Viewer")}
            <//>`}
            ${branchDetail.workspaceLink?.url &&
            html`<${Button} size="small" variant="outlined"
              onClick=${() => openLink(branchDetail.workspaceLink.url)}
            >${iconText(":link: Open Workspace Link")}<//>`}
            <${Tooltip} title="Copy diff stats">
              <${Button} size="small" variant="outlined"
                onClick=${() => copyToClipboard(branchDetail.diffStat || "", "Diff")}
              >${iconText(":clipboard: Copy Diff")}<//>
            <//>
          <//>
          ${workspaceLink &&
          html`
            <${Typography} variant="body2" sx=${{ mb: 1 }}>
              Workspace: ${workspaceLink.label || workspaceLink.taskTitle || workspaceLink.branch || "Active"}
              ${(workspaceLink.target?.workspacePath || workspaceLink.workspacePath)
                ? html` · <${Typography} component="span" sx=${{ fontFamily: "monospace" }}>${workspaceLink.target?.workspacePath || workspaceLink.workspacePath}<//>`
                : ""}
            <//>
          `}
          ${branchDetail.diffSummary &&
          html`
            <${Typography} variant="body2" sx=${{ mb: 1 }}>
              Diff: ${branchDetail.diffSummary.totalFiles || 0} files ·
              <${Chip} label="+${branchDetail.diffSummary.totalAdditions || 0}" size="small" color="success" sx=${{ mx: 0.5 }} />
              <${Chip} label="-${branchDetail.diffSummary.totalDeletions || 0}" size="small" color="error" sx=${{ mx: 0.5 }} />
              ${branchDetail.diffSummary.binaryFiles ? html` · <${Chip} label="${branchDetail.diffSummary.binaryFiles} binary" size="small" />` : ""}
            <//>
          `}
          ${branchCommits.length > 0 &&
          html`
            <${Paper} variant="outlined" sx=${{ p: 1.5, mb: 1.5 }}>
              <${Typography} variant="subtitle2" gutterBottom>Commits<//>
              ${branchCommits.map((cm) => {
                const subject = cm.subject || cm.message || "";
                const author =
                  cm.author ||
                  (cm.authorName && cm.authorEmail
                    ? `${cm.authorName} <${cm.authorEmail}>`
                    : cm.authorName || cm.authorEmail || "");
                const dateVal = cm.authorDate || cm.date || cm.time;
                return html`
                  <${Typography} variant="body2" key=${cm.hash} sx=${{ mb: 0.5 }}>
                    <${Typography} component="span" sx=${{ fontFamily: "monospace", mr: 0.5 }}>${cm.hash}<//>
                    ${subject}
                    ${author ? ` · ${author}` : ""}
                    ${(() => { const dateText = formatTimestamp(dateVal, ""); return dateText ? ` · ${dateText}` : ""; })()}
                  <//>
                `;
              })}
            <//>
          `}
          <${Paper} variant="outlined" sx=${{ p: 1.5, mb: 1.5 }}>
            <${Typography} variant="subtitle2" gutterBottom>Files Changed<//>
            ${branchFileDetails.length
              ? html`
                <${TableContainer}>
                  <${Table} size="small">
                    <${TableHead}>
                      <${TableRow}>
                        <${TableCell}>File<//>
                        <${TableCell} align="right">Changes<//>
                      </${TableRow}>
                    <//>
                    <${TableBody}>
                      ${branchFileDetails.map(
                        (f) => html`
                          <${TableRow} key=${f.file}>
                            <${TableCell}>
                              <${Typography} variant="body2" sx=${{ fontFamily: "monospace" }}>${f.file}<//>
                            <//>
                            <${TableCell} align="right">
                              <${Stack} direction="row" spacing=${0.5} justifyContent="flex-end">
                                ${typeof f.additions === "number" &&
                                html`<${Chip} label="+${f.additions}" size="small" color="success" />`}
                                ${typeof f.deletions === "number" &&
                                html`<${Chip} label="-${f.deletions}" size="small" color="error" />`}
                                ${f.binary && html`<${Chip} label="binary" size="small" />`}
                              <//>
                            <//>
                          </${TableRow}>
                        `,
                      )}
                    <//>
                  </${Table}>
                <//>
              `
              : html`<${Typography} variant="body2" color="text.secondary">No diff against base.<//>`}
          <//>
          ${branchDetail.diffStat &&
          html`
            <${Paper} variant="outlined" sx=${{ p: 1.5 }}>
              <${Typography} variant="subtitle2" gutterBottom>Diff Summary<//>
              <pre class="workspace-diff">${branchDetail.diffStat}</pre>
            <//>
          `}
        `}
      <//>
    `}
  `;
}
