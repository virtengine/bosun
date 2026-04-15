import { h } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import htm from "htm";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  LinearProgress,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";

import { apiFetch } from "../modules/api.js";
import { buildSessionApiPath } from "../modules/session-api.js";
import { showToast } from "../modules/state.js";
import { activeAgent, availableAgents, selectedModel } from "../components/agent-selector.js";

const html = htm.bind(h);

const LAB_SIDES = Object.freeze({
  left: {
    label: "Context Shredding + Compression",
    mode: "forced",
    accent: "#c2410c",
    sessionLabel: "Shredded",
  },
  right: {
    label: "Normal Harness + Auto Compact",
    mode: "normal",
    accent: "#1d4ed8",
    sessionLabel: "Normal",
  },
});

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function formatNumber(value) {
  const numeric = Number(value || 0) || 0;
  return numeric.toLocaleString();
}

function formatDuration(ms) {
  const value = Math.max(0, Number(ms || 0) || 0);
  if (value < 1000) return `${value} ms`;
  const seconds = Math.floor(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) return remSeconds ? `${minutes}m ${remSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

function formatRelative(timestamp) {
  if (!timestamp) return "just now";
  const diff = Date.now() - Date.parse(String(timestamp));
  if (!Number.isFinite(diff) || diff <= 0) return "just now";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function clipText(value, max = 180) {
  const text = toTrimmedString(value);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function buildModelLabel(model) {
  if (!model) return "Default";
  return String(model)
    .split("-")
    .map((segment) => (/^\d/.test(segment) ? segment : segment.toUpperCase() === "GPT" ? "GPT" : `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`))
    .join(" ");
}

function getDefaultPaneConfig() {
  return {
    agent: toTrimmedString(activeAgent.value || "") || "codex-sdk",
    model: toTrimmedString(selectedModel.value || ""),
  };
}

function toneForRole(role = "", type = "") {
  const normalizedRole = toTrimmedString(role).toLowerCase();
  const normalizedType = toTrimmedString(type).toLowerCase();
  if (normalizedRole === "user") return { bg: "rgba(59,130,246,0.08)", border: "#60a5fa", label: "User" };
  if (normalizedRole === "assistant") return { bg: "rgba(16,185,129,0.08)", border: "#34d399", label: "Assistant" };
  if (normalizedType === "error") return { bg: "rgba(239,68,68,0.08)", border: "#f87171", label: "Error" };
  return { bg: "rgba(148,163,184,0.08)", border: "#94a3b8", label: "System" };
}

function buildLabSessionTitle(sideKey) {
  const side = LAB_SIDES[sideKey];
  return `${side.sessionLabel} Context Compression Lab`;
}

async function createLabSession(sideKey, sessionConfig = {}) {
  const side = LAB_SIDES[sideKey];
  const response = await apiFetch("/api/sessions/create", {
    method: "POST",
    body: JSON.stringify({
      type: "primary",
      title: buildLabSessionTitle(sideKey),
      source: "context-compression-lab",
      visibility: "hidden",
      hidden: true,
      hiddenInLists: true,
      contextCompressionMode: side.mode,
      agent: toTrimmedString(sessionConfig.agent || "") || undefined,
      model: toTrimmedString(sessionConfig.model || "") || undefined,
    }),
  });
  return response?.session || null;
}

async function stopLabSession(sessionId) {
  const safeSessionId = toTrimmedString(sessionId);
  if (!safeSessionId) return;
  try {
    await apiFetch(buildSessionApiPath(safeSessionId, "stop", {
      workspace: "active",
    }), {
      method: "POST",
    });
  } catch {
    // Best effort only. Delete will still clean up the hidden session.
  }
}

async function deleteLabSession(sessionId) {
  const safeSessionId = toTrimmedString(sessionId);
  if (!safeSessionId) return;
  try {
    await apiFetch(buildSessionApiPath(safeSessionId, "delete", {
      workspace: "active",
    }), {
      method: "POST",
    });
  } catch {
    // Best effort cleanup only.
  }
}

async function loadLabSessionSnapshot(sessionId) {
  const safeSessionId = toTrimmedString(sessionId);
  if (!safeSessionId) return null;
  const [sessionPayload, compressionPayload, eventsPayload] = await Promise.all([
    apiFetch(buildSessionApiPath(safeSessionId, "", {
      workspace: "active",
      query: { full: "1" },
    })).catch(() => null),
    apiFetch(buildSessionApiPath(safeSessionId, "context-compression", {
      workspace: "active",
    })).catch(() => null),
    apiFetch(buildSessionApiPath(safeSessionId, "shredding-events", {
      workspace: "active",
    })).catch(() => null),
  ]);
  return {
    session: sessionPayload?.session || null,
    metrics: compressionPayload?.metrics || eventsPayload?.metrics || null,
    recentEvents: compressionPayload?.recentEvents || eventsPayload?.events || [],
  };
}

async function loadShreddingMessageDetail(sessionId, messageId) {
  return await apiFetch(buildSessionApiPath(sessionId, `shredding-message/${encodeURIComponent(messageId)}`, {
    workspace: "active",
  }));
}

function StatCard({ label, value, helper = "", accent = "#475569" }) {
  return html`
    <${Card} variant="outlined" sx=${{ borderRadius: 3, borderColor: `${accent}33` }}>
      <${CardContent} sx=${{ p: 1.5, "&:last-child": { pb: 1.5 } }}>
        <${Typography} variant="caption" color="text.secondary">${label}</${Typography}>
        <${Typography} variant="h6" sx=${{ mt: 0.5, fontWeight: 700, color: accent }}>
          ${value}
        </${Typography}>
        ${helper
          ? html`<${Typography} variant="caption" color="text.secondary">${helper}</${Typography}>`
          : null}
      </${CardContent}>
    </${Card}>
  `;
}

function MessageCard({ message, isSelected = false, messageRef = null }) {
  const tone = toneForRole(message?.role, message?.type);
  const text = toTrimmedString(message?.content);
  const compressionMeta = message?.meta?.contextCompression || null;
  return html`
    <${Paper}
      ref=${messageRef}
      variant="outlined"
      sx=${{
        p: 1.25,
        borderRadius: 2.5,
        bgcolor: tone.bg,
        borderColor: isSelected ? "warning.main" : tone.border,
        boxShadow: isSelected ? "0 0 0 2px rgba(245,158,11,0.18)" : "none",
      }}
    >
      <${Stack} direction="row" justifyContent="space-between" spacing=${1} sx=${{ mb: 0.75 }}>
        <${Stack} direction="row" spacing=${0.75} alignItems="center" sx=${{ flexWrap: "wrap" }}>
          <${Chip} label=${tone.label} size="small" variant="outlined" sx=${{ height: 22 }} />
          ${message?._compressed
            ? html`<${Chip} label=${message._compressed} size="small" color="warning" variant="filled" sx=${{ height: 22 }} />`
            : null}
          ${compressionMeta?.total
            ? html`<${Chip} label=${`${compressionMeta.total} compacted`} size="small" color="warning" variant="outlined" sx=${{ height: 22 }} />`
            : null}
        </${Stack}>
        <${Typography} variant="caption" color="text.secondary">
          ${formatRelative(message?.timestamp)}
        </${Typography}>
      </${Stack}>
      <${Typography}
        component="pre"
        sx=${{
          m: 0,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          fontSize: "0.78rem",
          lineHeight: 1.45,
        }}
      >
        ${text || "(empty message)"}
      </${Typography}>
    </${Paper}>
  `;
}

function ComparisonRow({ label, left, right, lowerIsBetter = false }) {
  const leftWins = lowerIsBetter ? left < right : left > right;
  const rightWins = lowerIsBetter ? right < left : right > left;
  return html`
    <${Stack}
      direction="row"
      alignItems="center"
      spacing=${1}
      sx=${{
        py: 0.85,
        borderBottom: "1px solid",
        borderColor: "divider",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <${Typography} variant="body2" sx=${{ flex: 1.4, fontWeight: 600 }}>
        ${label}
      </${Typography}>
      <${Box} sx=${{ flex: 1 }}>
        <${Chip}
          label=${formatNumber(left)}
          color=${leftWins ? "success" : "default"}
          variant=${leftWins ? "filled" : "outlined"}
          size="small"
        />
      </${Box}>
      <${Box} sx=${{ flex: 1, textAlign: "right" }}>
        <${Chip}
          label=${formatNumber(right)}
          color=${rightWins ? "success" : "default"}
          variant=${rightWins ? "filled" : "outlined"}
          size="small"
        />
      </${Box}>
    </${Stack}>
  `;
}

export function ContextCompressionLabTab() {
  const [prompt, setPrompt] = useState("");
  const [sessionIds, setSessionIds] = useState({ left: "", right: "" });
  const [loadingPair, setLoadingPair] = useState(true);
  const [sending, setSending] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [snapshots, setSnapshots] = useState({
    left: { session: null, metrics: null, recentEvents: [] },
    right: { session: null, metrics: null, recentEvents: [] },
  });
  const [selectedDetails, setSelectedDetails] = useState({ left: null, right: null });
  const [lastPromptAt, setLastPromptAt] = useState(null);
  const [paneConfigs, setPaneConfigs] = useState({
    left: getDefaultPaneConfig(),
    right: getDefaultPaneConfig(),
  });
  const messageRefs = useRef({});
  const executorOptions = Array.isArray(availableAgents.value) && availableAgents.value.length > 0
    ? availableAgents.value
    : [{ id: getDefaultPaneConfig().agent, name: "Codex", models: [] }];

  useEffect(() => {
    const defaultConfig = getDefaultPaneConfig();
    setPaneConfigs((current) => ({
      left: {
        ...defaultConfig,
        ...current.left,
        agent: toTrimmedString(current.left?.agent || "") || defaultConfig.agent,
      },
      right: {
        ...defaultConfig,
        ...current.right,
        agent: toTrimmedString(current.right?.agent || "") || defaultConfig.agent,
      },
    }));
  }, [availableAgents.value.length, activeAgent.value, selectedModel.value]);

  const refreshSnapshots = useCallback(async () => {
    const leftId = toTrimmedString(sessionIds.left);
    const rightId = toTrimmedString(sessionIds.right);
    if (!leftId || !rightId) return;
    const [left, right] = await Promise.all([
      loadLabSessionSnapshot(leftId),
      loadLabSessionSnapshot(rightId),
    ]);
    setSnapshots({
      left: left || { session: null, metrics: null, recentEvents: [] },
      right: right || { session: null, metrics: null, recentEvents: [] },
    });
  }, [sessionIds.left, sessionIds.right]);

  const createFreshPair = useCallback(async () => {
    setLoadingPair(true);
    setResetting(true);
    try {
      await Promise.all([
        stopLabSession(sessionIds.left),
        stopLabSession(sessionIds.right),
      ]);
      await Promise.all([
        deleteLabSession(sessionIds.left),
        deleteLabSession(sessionIds.right),
      ]);
      const [leftSession, rightSession] = await Promise.all([
        createLabSession("left", paneConfigs.left),
        createLabSession("right", paneConfigs.right),
      ]);
      const nextIds = {
        left: toTrimmedString(leftSession?.id),
        right: toTrimmedString(rightSession?.id),
      };
      setSessionIds(nextIds);
      setSelectedDetails({ left: null, right: null });
      const [left, right] = await Promise.all([
        loadLabSessionSnapshot(nextIds.left),
        loadLabSessionSnapshot(nextIds.right),
      ]);
      setSnapshots({
        left: left || { session: null, metrics: null, recentEvents: [] },
        right: right || { session: null, metrics: null, recentEvents: [] },
      });
    } catch (error) {
      showToast(`Could not initialize compression lab: ${error?.message || "unknown error"}`, "error");
    } finally {
      setResetting(false);
      setLoadingPair(false);
    }
  }, [paneConfigs.left, paneConfigs.right, sessionIds.left, sessionIds.right]);

  useEffect(() => {
    createFreshPair().catch(() => {});
  }, []);

  useEffect(() => () => {
    stopLabSession(sessionIds.left).catch(() => {});
    stopLabSession(sessionIds.right).catch(() => {});
    deleteLabSession(sessionIds.left).catch(() => {});
    deleteLabSession(sessionIds.right).catch(() => {});
  }, [sessionIds.left, sessionIds.right]);

  useEffect(() => {
    const leftId = toTrimmedString(sessionIds.left);
    const rightId = toTrimmedString(sessionIds.right);
    if (!leftId || !rightId) return undefined;
    const timer = setInterval(() => {
      refreshSnapshots().catch(() => {});
    }, 1800);
    return () => clearInterval(timer);
  }, [refreshSnapshots, sessionIds.left, sessionIds.right]);

  useEffect(() => {
    for (const sideKey of Object.keys(selectedDetails)) {
      const detail = selectedDetails[sideKey];
      const messageId = toTrimmedString(detail?.messageId || detail?.message?.id || "");
      const refKey = `${sideKey}:${messageId}`;
      const node = messageId ? messageRefs.current[refKey] : null;
      if (node && typeof node.scrollIntoView === "function") {
        node.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }, [selectedDetails.left, selectedDetails.right]);

  const sendPromptToBoth = useCallback(async (forcedDeliveryMode = "") => {
    const trimmed = toTrimmedString(prompt);
    if (!trimmed || sending) return;
    const leftId = toTrimmedString(sessionIds.left);
    const rightId = toTrimmedString(sessionIds.right);
    if (!leftId || !rightId) {
      showToast("Compression lab sessions are not ready yet.", "error");
      return;
    }
    setSending(true);
    try {
      const leftBusy = toTrimmedString(snapshots.left?.session?.status).toLowerCase() === "active";
      const rightBusy = toTrimmedString(snapshots.right?.session?.status).toLowerCase() === "active";
      await Promise.all([
        apiFetch(buildSessionApiPath(leftId, "message", {
          workspace: "active",
        }), {
          method: "POST",
          body: JSON.stringify({
            content: trimmed,
            agent: paneConfigs.left?.agent || undefined,
            model: paneConfigs.left?.model || undefined,
            contextCompressionMode: LAB_SIDES.left.mode,
            deliveryMode: forcedDeliveryMode || (leftBusy ? "queue" : "auto"),
          }),
        }),
        apiFetch(buildSessionApiPath(rightId, "message", {
          workspace: "active",
        }), {
          method: "POST",
          body: JSON.stringify({
            content: trimmed,
            agent: paneConfigs.right?.agent || undefined,
            model: paneConfigs.right?.model || undefined,
            contextCompressionMode: LAB_SIDES.right.mode,
            deliveryMode: forcedDeliveryMode || (rightBusy ? "queue" : "auto"),
          }),
        }),
      ]);
      setPrompt("");
      setLastPromptAt(new Date().toISOString());
      await refreshSnapshots();
    } catch (error) {
      showToast(`Could not send prompt to both sessions: ${error?.message || "unknown error"}`, "error");
    } finally {
      setSending(false);
    }
  }, [paneConfigs.left, paneConfigs.right, prompt, refreshSnapshots, sending, sessionIds.left, sessionIds.right, snapshots.left?.session?.status, snapshots.right?.session?.status]);

  const handlePromptKeyDown = useCallback((event) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    const leftBusy = toTrimmedString(snapshots.left?.session?.status).toLowerCase() === "active";
    const rightBusy = toTrimmedString(snapshots.right?.session?.status).toLowerCase() === "active";
    if (leftBusy || rightBusy) {
      sendPromptToBoth("queue");
      return;
    }
    sendPromptToBoth();
  }, [sendPromptToBoth, snapshots.left?.session?.status, snapshots.right?.session?.status]);

  const selectEventDetail = useCallback(async (sideKey, event) => {
    const safeSessionId = toTrimmedString(sessionIds[sideKey]);
    const safeMessageId = toTrimmedString(event?.messageId);
    if (!safeSessionId || !safeMessageId) return;
    try {
      const detail = await loadShreddingMessageDetail(safeSessionId, safeMessageId);
      setSelectedDetails((current) => ({
        ...current,
        [sideKey]: detail,
      }));
    } catch (error) {
      showToast(`Could not load shredding detail: ${error?.message || "unknown error"}`, "error");
    }
  }, [sessionIds]);

  const comparison = useMemo(() => {
    const left = snapshots.left?.metrics || null;
    const right = snapshots.right?.metrics || null;
    if (!left || !right) return null;
    let leftScore = 0;
    let rightScore = 0;
    for (const key of ["totalTokens", "elapsedMs", "compactEvents"]) {
      const leftValue =
        key === "totalTokens"
          ? Number(left?.tokenUsage?.totalTokens || 0)
          : Number(left?.[key] || 0);
      const rightValue =
        key === "totalTokens"
          ? Number(right?.tokenUsage?.totalTokens || 0)
          : Number(right?.[key] || 0);
      if (leftValue < rightValue) leftScore += 1;
      if (rightValue < leftValue) rightScore += 1;
    }
    return {
      left,
      right,
      lead:
        leftScore === rightScore
          ? "Even"
          : leftScore > rightScore
            ? LAB_SIDES.left.label
            : LAB_SIDES.right.label,
    };
  }, [snapshots.left?.metrics, snapshots.right?.metrics]);

  const updatePaneConfig = useCallback((sideKey, patch = {}) => {
    setPaneConfigs((current) => {
      const previous = current[sideKey] || getDefaultPaneConfig();
      const next = {
        ...previous,
        ...patch,
      };
      const selectedAgent = executorOptions.find((entry) => entry.id === next.agent) || null;
      const validModels = Array.isArray(selectedAgent?.models) ? selectedAgent.models : [];
      if (next.model && validModels.length > 0 && !validModels.includes(next.model)) {
        next.model = "";
      }
      return {
        ...current,
        [sideKey]: next,
      };
    });
  }, [executorOptions]);

  const renderPane = (sideKey) => {
    const side = LAB_SIDES[sideKey];
    const paneConfig = paneConfigs[sideKey] || getDefaultPaneConfig();
    const selectedExecutor = executorOptions.find((entry) => entry.id === paneConfig.agent) || null;
    const modelOptions = Array.isArray(selectedExecutor?.models) ? selectedExecutor.models : [];
    const snapshot = snapshots[sideKey] || {};
    const session = snapshot.session;
    const metrics = snapshot.metrics;
    const recentEvents = Array.isArray(snapshot.recentEvents) ? snapshot.recentEvents : [];
    const selected = selectedDetails[sideKey];
    const progressValue =
      Number(metrics?.tokenUsage?.totalTokens || 0) > 0
        ? Math.min(100, Math.max(6, Math.round((Number(metrics?.tokenUsage?.cacheInputTokens || 0) / Math.max(1, Number(metrics?.tokenUsage?.totalTokens || 1))) * 100)))
        : 0;
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const queuedFollowups = Array.isArray(session?.metadata?.queuedFollowups) ? session.metadata.queuedFollowups : [];
    return html`
      <${Paper}
        variant="outlined"
        sx=${{
          p: 2,
          borderRadius: 4,
          borderColor: `${side.accent}33`,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          gap: 1.5,
        }}
      >
        <${Stack} direction="row" justifyContent="space-between" spacing=${1} alignItems="flex-start">
          <${Box}>
            <${Typography} variant="h6" sx=${{ fontWeight: 700 }}>
              ${side.label}
            </${Typography}>
            <${Typography} variant="caption" color="text.secondary">
              Session ${toTrimmedString(session?.id) || "pending"} · mode ${metrics?.compressionMode || side.mode}
            </${Typography}>
            <${Typography} variant="caption" color="text.secondary" sx=${{ display: "block", mt: 0.35 }}>
              Executor ${paneConfig.agent || "default"} · model ${paneConfig.model || "default"}
            </${Typography}>
          </${Box}>
          <${Chip}
            label=${toTrimmedString(session?.status) || "initializing"}
            color=${toTrimmedString(session?.status).toLowerCase() === "failed" ? "error" : toTrimmedString(session?.status).toLowerCase() === "completed" ? "success" : "warning"}
            variant="outlined"
          />
        </${Stack}>

        <${Box}
          sx=${{
            display: "grid",
            gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" },
            gap: 1,
          }}
        >
          <${TextField}
            select
            size="small"
            label="Executor"
            value=${paneConfig.agent || ""}
            onChange=${(event) => updatePaneConfig(sideKey, { agent: event.target.value })}
          >
            ${executorOptions.map((entry) => html`
              <${MenuItem} key=${entry.id} value=${entry.id}>${entry.name || entry.id}</${MenuItem}>
            `)}
          </${TextField}>
          ${modelOptions.length > 0
            ? html`
                <${TextField}
                  select
                  size="small"
                  label="Model"
                  value=${paneConfig.model || ""}
                  onChange=${(event) => updatePaneConfig(sideKey, { model: event.target.value })}
                >
                  <${MenuItem} value="">Default</${MenuItem}>
                  ${modelOptions.map((modelId) => html`
                    <${MenuItem} key=${modelId} value=${modelId}>${buildModelLabel(modelId)}</${MenuItem}>
                  `)}
                </${TextField}>
              `
            : html`
                <${TextField}
                  size="small"
                  label="Model"
                  placeholder="Default"
                  value=${paneConfig.model || ""}
                  onInput=${(event) => updatePaneConfig(sideKey, { model: event.target.value })}
                />
              `}
        </${Box}>

        <${Box}
          sx=${{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            gap: 1,
          }}
        >
          <${StatCard} label="Total Tokens" value=${formatNumber(metrics?.tokenUsage?.totalTokens || 0)} accent=${side.accent} />
          <${StatCard} label="Input" value=${formatNumber(metrics?.tokenUsage?.inputTokens || 0)} accent=${side.accent} />
          <${StatCard} label="Output" value=${formatNumber(metrics?.tokenUsage?.outputTokens || 0)} accent=${side.accent} />
          <${StatCard} label="Cache In" value=${formatNumber(metrics?.tokenUsage?.cacheInputTokens || 0)} accent=${side.accent} />
          <${StatCard} label="Compact Events" value=${formatNumber(metrics?.compactEvents || 0)} accent=${side.accent} />
          <${StatCard} label="Files Changed" value=${formatNumber(metrics?.filesChanged || 0)} accent=${side.accent} />
          <${StatCard} label="Tool Calls" value=${formatNumber(metrics?.toolCalls || 0)} accent=${side.accent} />
          <${StatCard} label="Tool Results" value=${formatNumber(metrics?.toolResults || 0)} accent=${side.accent} />
          <${StatCard} label="Messages" value=${formatNumber(metrics?.totalMessages || 0)} accent=${side.accent} />
          <${StatCard} label="Elapsed" value=${formatDuration(metrics?.elapsedMs || 0)} accent=${side.accent} />
        </${Box}>

        <${Box}>
          <${Stack} direction="row" justifyContent="space-between" alignItems="center" sx=${{ mb: 0.5 }}>
            <${Typography} variant="caption" color="text.secondary">Cache token ratio</${Typography}>
            <${Typography} variant="caption" color="text.secondary">
              ${progressValue}%
            </${Typography}>
          </${Stack}>
          <${LinearProgress}
            variant="determinate"
            value=${progressValue}
            sx=${{
              height: 8,
              borderRadius: 999,
              bgcolor: "rgba(148,163,184,0.15)",
              "& .MuiLinearProgress-bar": { bgcolor: side.accent },
            }}
          />
        </${Box}>

        <${Divider} />

        <${Typography} variant="subtitle2">Queued Follow-ups</${Typography}>
        <${Stack} spacing=${1} sx=${{ maxHeight: 180, overflow: "auto", pr: 0.5 }}>
          ${queuedFollowups.length === 0
            ? html`<${Typography} variant="caption" color="text.secondary">No queued follow-ups.</${Typography}>`
            : queuedFollowups.map((entry) => html`
                <${Paper} key=${entry.id || entry.queuedAt} variant="outlined" sx=${{ p: 1.25, borderRadius: 2.5, borderColor: `${side.accent}22` }}>
                  <${Typography} variant="caption" color="text.secondary">
                    ${entry.queuedAt ? formatRelative(entry.queuedAt) : "queued"}${entry.agent ? ` · ${entry.agent}` : ""}${entry.model ? ` · ${entry.model}` : ""}
                  </${Typography}>
                  <${Typography} variant="body2" sx=${{ mt: 0.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                    ${toTrimmedString(entry.content) || "(attachment-only follow-up)"}
                  </${Typography}>
                </${Paper}>
              `)}
        </${Stack}>

        <${Divider} />

        <${Typography} variant="subtitle2">Transcript</${Typography}>
        <${Box}
          sx=${{
            minHeight: 320,
            maxHeight: 520,
            overflow: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 1,
            pr: 0.5,
          }}
        >
          ${messages.length === 0
            ? html`
                <${Alert} severity="info">
                  No transcript yet. Send one prompt to both sessions to compare the retained context.
                </${Alert}>
              `
            : messages.map((message, index) => {
                const messageId = toTrimmedString(message?.id || message?.messageId || `${index}`);
                const refKey = `${sideKey}:${messageId}`;
                return html`
                  <${MessageCard}
                    key=${refKey}
                    message=${message}
                    isSelected=${toTrimmedString(selected?.messageId || selected?.message?.id) === messageId}
                    messageRef=${(node) => {
                      if (node) messageRefs.current[refKey] = node;
                    }}
                  />
                `;
              })}
        </${Box}>

        <${Divider} />

        <${Typography} variant="subtitle2">
          ${sideKey === "left" ? "Recent Context Shredding Events" : "Recent Compact Events"}
        </${Typography}>
        <${Stack} spacing=${1} sx=${{ maxHeight: 260, overflow: "auto", pr: 0.5 }}>
          ${recentEvents.length === 0
            ? html`<${Typography} variant="caption" color="text.secondary">No compaction events recorded yet.</${Typography}>`
            : recentEvents.slice(0, 12).map((event) => html`
                <${Paper}
                  key=${`${event.timestamp}-${event.messageId}-${event.stage}`}
                  variant="outlined"
                  sx=${{
                    p: 1.25,
                    borderRadius: 2.5,
                    cursor: event?.messageId ? "pointer" : "default",
                    borderColor: `${side.accent}22`,
                    "&:hover": event?.messageId ? { borderColor: side.accent, bgcolor: "rgba(15,23,42,0.02)" } : undefined,
                  }}
                  onClick=${event?.messageId ? () => selectEventDetail(sideKey, event) : undefined}
                >
                  <${Stack} direction="row" justifyContent="space-between" spacing=${1}>
                    <${Stack} direction="row" spacing=${0.5} sx=${{ flexWrap: "wrap" }}>
                      <${Chip} label=${toTrimmedString(event?.stage || "event")} size="small" variant="outlined" sx=${{ height: 22 }} />
                      ${event?.compressionKind
                        ? html`<${Chip} label=${event.compressionKind} size="small" color="warning" variant="filled" sx=${{ height: 22 }} />`
                        : null}
                    </${Stack}>
                    <${Typography} variant="caption" color="text.secondary">
                      ${formatRelative(event?.timestamp)}
                    </${Typography}>
                  </${Stack}>
                  <${Typography} variant="caption" color="text.secondary" sx=${{ display: "block", mt: 0.75 }}>
                    Saved ${formatNumber(event?.savedChars || 0)} chars · ${formatNumber(event?.savedPct || 0)}%
                  </${Typography}>
                  <${Typography} variant="body2" sx=${{ mt: 0.75, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: "0.75rem" }}>
                    ${clipText(event?.afterPreview || event?.beforePreview || event?.reason || "", 160)}
                  </${Typography}>
                </${Paper}>
              `)}
        </${Stack}>

        ${selected
          ? html`
              <${Divider} />
              <${Typography} variant="subtitle2">Selected Compaction Detail</${Typography}>
              <${Paper} variant="outlined" sx=${{ p: 1.5, borderRadius: 2.5 }}>
                <${Typography} variant="caption" color="text.secondary">
                  Message ${toTrimmedString(selected?.messageId || selected?.message?.id) || "(unknown)"} · index ${Number.isFinite(Number(selected?.messageIndex)) ? Number(selected.messageIndex) + 1 : "-"}
                </${Typography}>
                <${Stack} spacing=${1.25} sx=${{ mt: 1 }}>
                  <${Box}>
                    <${Typography} variant="caption" sx=${{ fontWeight: 700 }}>Before</${Typography}>
                    <${Typography} component="pre" sx=${{ m: 0, mt: 0.5, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: "0.74rem" }}>
                      ${toTrimmedString(selected?.before) || "(no cached pre-compaction snapshot)"}
                    </${Typography}>
                  </${Box}>
                  <${Box}>
                    <${Typography} variant="caption" sx=${{ fontWeight: 700 }}>After</${Typography}>
                    <${Typography} component="pre" sx=${{ m: 0, mt: 0.5, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: "0.74rem" }}>
                      ${toTrimmedString(selected?.after) || "(empty)"}
                    </${Typography}>
                  </${Box}>
                </${Stack}>
              </${Paper}>
            `
          : null}
      </${Paper}>
    `;
  };

  return html`
    <section class="context-compression-lab-tab">
      <${Stack} spacing=${2}>
        <${Paper} variant="outlined" sx=${{ p: 2.25, borderRadius: 4 }}>
          <${Stack} spacing=${1.25}>
            <${Box}>
              <${Typography} variant="h5" sx=${{ fontWeight: 800 }}>
                Context Compression Lab
              </${Typography}>
              <${Typography} variant="body2" color="text.secondary" sx=${{ mt: 0.5, maxWidth: 980 }}>
                This hidden route runs the same prompt through two isolated chat sessions. The left session forces context shredding and compression on retained history. The right session uses the normal harness path and only compacts when the standard policy decides to do it.
              </${Typography}>
            </${Box}>

            <${Alert} severity="info">
              Hidden sessions created here are marked with <code>source=context-compression-lab</code> and <code>hiddenInLists=true</code> so they stay out of the normal chat session list.
            </${Alert}>

            <${Stack} direction=${{ xs: "column", lg: "row" }} spacing=${1.25} alignItems=${{ xs: "stretch", lg: "flex-end" }}>
              <${TextField}
                fullWidth
                multiline
                minRows=${3}
                label="Send one prompt to both sessions"
                placeholder="Ask both sessions to do the same task so you can compare how retained context, compaction events, and overall cost diverge."
                value=${prompt}
                onInput=${(event) => setPrompt(event.target.value)}
                onKeyDown=${handlePromptKeyDown}
              />
              <${Stack} direction="row" spacing=${1}>
                <${Button}
                  variant="contained"
                  disabled=${loadingPair || sending || resetting || !toTrimmedString(prompt)}
                  onClick=${sendPromptToBoth}
                >
                  ${sending ? "Sending..." : ((toTrimmedString(snapshots.left?.session?.status).toLowerCase() === "active" || toTrimmedString(snapshots.right?.session?.status).toLowerCase() === "active") ? "Queue to Both" : "Send to Both")}
                </${Button}>
                <${Button}
                  variant="text"
                  disabled=${loadingPair || sending || resetting || !toTrimmedString(prompt) || !(toTrimmedString(snapshots.left?.session?.status).toLowerCase() === "active" || toTrimmedString(snapshots.right?.session?.status).toLowerCase() === "active")}
                  onClick=${() => sendPromptToBoth("steer")}
                >
                  Steer Both Now
                </${Button}>
                <${Button}
                  variant="outlined"
                  disabled=${loadingPair || sending || resetting}
                  onClick=${() => createFreshPair()}
                >
                  ${resetting ? "Stopping..." : "Stop & Reset Sessions"}
                </${Button}>
              </${Stack}>
            </${Stack}>

            ${lastPromptAt
              ? html`<${Typography} variant="caption" color="text.secondary">Last prompt sent ${formatRelative(lastPromptAt)}.</${Typography}>`
              : null}
          </${Stack}>
        </${Paper}>

        ${loadingPair
          ? html`
              <${Paper} variant="outlined" sx=${{ p: 5, borderRadius: 4, textAlign: "center" }}>
                <${CircularProgress} size=${28} />
                <${Typography} variant="body2" color="text.secondary" sx=${{ mt: 1.5 }}>
                  Initializing hidden comparison sessions...
                </${Typography}>
              </${Paper}>
            `
          : html`
              <${Box}
                sx=${{
                  display: "grid",
                  gridTemplateColumns: { xs: "1fr", xl: "1fr 1fr" },
                  gap: 2,
                  alignItems: "start",
                }}
              >
                ${renderPane("left")}
                ${renderPane("right")}
              </${Box}>
            `}

        ${comparison
          ? html`
              <${Paper} variant="outlined" sx=${{ p: 2, borderRadius: 4 }}>
                <${Stack} direction="row" justifyContent="space-between" alignItems="center" sx=${{ mb: 1.25 }}>
                  <${Box}>
                    <${Typography} variant="h6" sx=${{ fontWeight: 700 }}>
                      Side-by-Side Comparison
                    </${Typography}>
                    <${Typography} variant="caption" color="text.secondary">
                      Efficiency lead: ${comparison.lead}. This measures retained token cost, elapsed time, and compaction count only. It does not judge answer quality for you.
                    </${Typography}>
                  </${Box}>
                  <${Chip} label=${comparison.lead} color="primary" variant="outlined" />
                </${Stack}>
                <${ComparisonRow}
                  label="Total Tokens"
                  left=${comparison.left.tokenUsage.totalTokens}
                  right=${comparison.right.tokenUsage.totalTokens}
                  lowerIsBetter=${true}
                />
                <${ComparisonRow}
                  label="Input Tokens"
                  left=${comparison.left.tokenUsage.inputTokens}
                  right=${comparison.right.tokenUsage.inputTokens}
                  lowerIsBetter=${true}
                />
                <${ComparisonRow}
                  label="Output Tokens"
                  left=${comparison.left.tokenUsage.outputTokens}
                  right=${comparison.right.tokenUsage.outputTokens}
                  lowerIsBetter=${true}
                />
                <${ComparisonRow}
                  label="Cache Input Tokens"
                  left=${comparison.left.tokenUsage.cacheInputTokens}
                  right=${comparison.right.tokenUsage.cacheInputTokens}
                  lowerIsBetter=${false}
                />
                <${ComparisonRow}
                  label="Elapsed Time (ms)"
                  left=${comparison.left.elapsedMs}
                  right=${comparison.right.elapsedMs}
                  lowerIsBetter=${true}
                />
                <${ComparisonRow}
                  label="Compact Events"
                  left=${comparison.left.compactEvents}
                  right=${comparison.right.compactEvents}
                  lowerIsBetter=${true}
                />
                <${ComparisonRow}
                  label="Files Changed"
                  left=${comparison.left.filesChanged}
                  right=${comparison.right.filesChanged}
                  lowerIsBetter=${false}
                />
                <${ComparisonRow}
                  label="Total Messages"
                  left=${comparison.left.totalMessages}
                  right=${comparison.right.totalMessages}
                  lowerIsBetter=${true}
                />
                <${ComparisonRow}
                  label="Tool Calls"
                  left=${comparison.left.toolCalls}
                  right=${comparison.right.toolCalls}
                  lowerIsBetter=${true}
                />
                <${ComparisonRow}
                  label="Tool Results"
                  left=${comparison.left.toolResults}
                  right=${comparison.right.toolResults}
                  lowerIsBetter=${true}
                />
                <${ComparisonRow}
                  label="Total Session Events"
                  left=${comparison.left.totalEvents}
                  right=${comparison.right.totalEvents}
                  lowerIsBetter=${true}
                />
              </${Paper}>
            `
          : null}
      </${Stack}>
    </section>
  `;
}

export default ContextCompressionLabTab;
