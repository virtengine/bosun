/* ─────────────────────────────────────────────────────────────
 *  Tab: Benchmarks — benchmark workspace prep, focus mode, launch, monitor
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

import { haptic } from "../modules/telegram.js";
import { apiFetch } from "../modules/api.js";
import {
  benchmarksData,
  benchmarksLoaded,
  loadBenchmarks,
  showToast,
} from "../modules/state.js";
import { formatRelative } from "../modules/utils.js";
import {
  activeWorkspaceId,
  loadWorkspaces,
  workspaces,
} from "../components/workspace-switcher.js";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  FormControlLabel,
  Grid,
  InputLabel,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";

function formatAgo(value) {
  if (!value) return "—";
  try {
    return formatRelative(value) || "just now";
  } catch {
    return String(value);
  }
}

function formatDurationMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "—";
  if (numeric < 1000) return `${Math.round(numeric)}ms`;
  if (numeric < 60_000) return `${Math.round(numeric / 1000)}s`;
  const minutes = Math.floor(numeric / 60_000);
  const seconds = Math.round((numeric % 60_000) / 1000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function normalizeFieldDefault(field) {
  if (!field || typeof field !== "object") return "";
  if (field.defaultValue !== undefined) return field.defaultValue;
  if (field.type === "boolean") return false;
  if (field.type === "number") return "";
  return "";
}

function buildRunDraft(provider) {
  const next = {
    prepareWorkspace: true,
    activateMode: Boolean(provider?.supports?.focusMode),
  };
  for (const field of provider?.launchUi?.fields || []) {
    next[field.key] = normalizeFieldDefault(field);
  }
  return next;
}

function buildWorkspaceDraft(provider) {
  return {
    name:
      String(provider?.workspacePreset?.recommendedWorkspaceName || "").trim()
      || (provider?.id ? `bench-${provider.id}` : "bench"),
    repoUrl: "",
    repoBranch: "",
    repoName: "",
    repoRoot: "",
    ensureRuntime: true,
    switchActive: true,
    reuseExisting: true,
    activateMode: false,
  };
}

function buildModeDraft(provider, currentMode) {
  const modeDefaults = provider?.modeDefaults || {};
  const enabledMode = currentMode?.enabled ? currentMode : null;
  return {
    pauseOtherAgents: enabledMode
      ? Boolean(enabledMode.pauseOtherAgents)
      : Boolean(modeDefaults.pauseOtherAgents),
    holdActiveNonBenchmarkTasks: enabledMode
      ? Boolean(enabledMode.holdActiveNonBenchmarkTasks)
      : Boolean(modeDefaults.holdActiveNonBenchmarkTasks),
    maxParallel:
      enabledMode?.maxParallel ?? modeDefaults.maxParallel ?? 1,
  };
}

function toLaunchPayload(provider, draft) {
  const payload = {};
  for (const field of provider?.launchUi?.fields || []) {
    const raw = draft?.[field.key];
    if (field.type === "boolean") {
      payload[field.key] = Boolean(raw);
      continue;
    }
    if (field.type === "number") {
      const numeric = Number(raw);
      if (Number.isFinite(numeric)) payload[field.key] = numeric;
      continue;
    }
    const text = String(raw || "").trim();
    if (text) payload[field.key] = text;
  }
  payload.prepareWorkspace = Boolean(draft?.prepareWorkspace);
  payload.activateMode = Boolean(draft?.activateMode);
  return payload;
}

function isRequiredLaunchFieldMissing(provider, draft) {
  return (provider?.launchUi?.fields || []).some((field) => {
    if (!field?.required) return false;
    if (field.type === "boolean") return false;
    if (field.type === "number") return !Number.isFinite(Number(draft?.[field.key]));
    return !String(draft?.[field.key] || "").trim();
  });
}

function SummaryMetric({ label, value }) {
  return html`
    <${Paper} variant="outlined" sx=${{ p: 1.5 }}>
      <${Typography} variant="caption" sx=${{ textTransform: "uppercase", opacity: 0.75 }}>
        ${label}
      </${Typography}>
      <${Typography} variant="h5" sx=${{ mt: 0.5 }}>
        ${value}
      </${Typography}>
    </${Paper}>
  `;
}

function ItemList({ title, items, emptyLabel, renderSecondary }) {
  return html`
    <${Paper} variant="outlined" sx=${{ p: 1.5 }}>
      <${Typography} variant="subtitle2" sx=${{ mb: 1 }}>
        ${title}
      </${Typography}>
      ${Array.isArray(items) && items.length > 0
        ? html`
            <${List} dense=${true} disablePadding=${true}>
              ${items.map((item, index) => html`
                <${ListItem}
                  key=${String(item?.taskId || item?.runId || item?.id || item?.title || `item-${index}`)}
                  disableGutters=${true}
                  sx=${{ py: 0.75, alignItems: "flex-start" }}
                >
                  <${ListItemText}
                    primary=${item?.taskTitle || item?.title || item?.workflowName || item?.runId || "Untitled"}
                    secondary=${renderSecondary(item)}
                  />
                </${ListItem}>
              `)}
            </${List}>
          `
        : html`
            <${Typography} variant="body2" sx=${{ opacity: 0.7 }}>
              ${emptyLabel}
            </${Typography}>
          `}
    </${Paper}>
  `;
}

export function BenchmarksTab() {
  const data = benchmarksData.value;
  const isLoaded = benchmarksLoaded.value;
  const workspaceEntries = workspaces.value || [];
  const currentWorkspaceId =
    activeWorkspaceId.value || data?.workspace?.workspaceId || "";
  const providerIds = Array.isArray(data?.providers)
    ? data.providers.map((entry) => entry.id).join(",")
    : "";

  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [modeDraft, setModeDraft] = useState(() => buildModeDraft(null, null));
  const [workspaceDraft, setWorkspaceDraft] = useState(() => buildWorkspaceDraft(null));
  const [runDraft, setRunDraft] = useState(() => buildRunDraft(null));
  const [busy, setBusy] = useState({
    refreshing: false,
    mode: false,
    workspace: false,
    run: false,
  });

  useEffect(() => {
    if (!isLoaded) {
      loadBenchmarks().catch(() => {});
    }
    loadWorkspaces().catch(() => {});
  }, [isLoaded]);

  useEffect(() => {
    const fallback =
      data?.provider
      || data?.providers?.find((entry) => entry?.supports?.launch)?.id
      || data?.providers?.[0]?.id
      || "";
    if (!selectedProviderId && fallback) {
      setSelectedProviderId(fallback);
    }
  }, [data?.provider, providerIds, selectedProviderId]);

  const provider = useMemo(() => {
    const providers = Array.isArray(data?.providers) ? data.providers : [];
    return (
      providers.find((entry) => entry.id === selectedProviderId)
      || providers.find((entry) => entry.id === data?.provider)
      || providers[0]
      || null
    );
  }, [data?.providers, data?.provider, selectedProviderId]);

  useEffect(() => {
    setModeDraft(buildModeDraft(provider, data?.mode));
    setWorkspaceDraft(buildWorkspaceDraft(provider));
    setRunDraft(buildRunDraft(provider));
  }, [provider?.id, data?.mode?.updatedAt, data?.mode?.enabled]);

  const refresh = useCallback(async (providerId = "") => {
    setBusy((current) => ({ ...current, refreshing: true }));
    try {
      await Promise.all([
        loadWorkspaces().catch(() => {}),
        loadBenchmarks(providerId || selectedProviderId || data?.provider || ""),
      ]);
    } catch (err) {
      showToast(err?.message || "Failed to refresh benchmark status", "error");
    } finally {
      setBusy((current) => ({ ...current, refreshing: false }));
    }
  }, [data?.provider, selectedProviderId]);

  const handleProviderChange = useCallback(async (event) => {
    const nextProviderId = String(event?.target?.value || "").trim();
    setSelectedProviderId(nextProviderId);
    try {
      await loadBenchmarks(nextProviderId);
    } catch (err) {
      showToast(err?.message || "Failed to switch benchmark provider", "error");
    }
  }, []);

  const handleModeSubmit = useCallback(async () => {
    if (!provider?.id) return;
    setBusy((current) => ({ ...current, mode: true }));
    haptic("medium");
    try {
      const enabled = !Boolean(data?.mode?.enabled);
      await apiFetch("/api/benchmarks/mode", {
        method: "POST",
        body: JSON.stringify({
          providerId: provider.id,
          workspaceId: currentWorkspaceId || undefined,
          enabled,
          pauseOtherAgents: Boolean(modeDraft.pauseOtherAgents),
          holdActiveNonBenchmarkTasks: Boolean(modeDraft.holdActiveNonBenchmarkTasks),
          maxParallel:
            modeDraft.maxParallel === "" || modeDraft.maxParallel == null
              ? null
              : Number(modeDraft.maxParallel),
        }),
      });
      showToast(enabled ? "Benchmark mode enabled" : "Benchmark mode disabled", "success");
      await refresh(provider.id);
    } catch (err) {
      showToast(err?.message || "Failed to update benchmark mode", "error");
    } finally {
      setBusy((current) => ({ ...current, mode: false }));
    }
  }, [currentWorkspaceId, data?.mode?.enabled, modeDraft, provider?.id, refresh]);

  const handleWorkspaceSubmit = useCallback(async () => {
    if (!provider?.id || !String(workspaceDraft.name || "").trim()) return;
    setBusy((current) => ({ ...current, workspace: true }));
    haptic("medium");
    try {
      await apiFetch("/api/benchmarks/workspace", {
        method: "POST",
        body: JSON.stringify({
          providerId: provider.id,
          name: String(workspaceDraft.name || "").trim(),
          repoUrl: String(workspaceDraft.repoUrl || "").trim() || undefined,
          repoBranch: String(workspaceDraft.repoBranch || "").trim() || undefined,
          repoName: String(workspaceDraft.repoName || "").trim() || undefined,
          repoRoot: String(workspaceDraft.repoRoot || "").trim() || undefined,
          ensureRuntime: Boolean(workspaceDraft.ensureRuntime),
          switchActive: Boolean(workspaceDraft.switchActive),
          reuseExisting: Boolean(workspaceDraft.reuseExisting),
          activateMode: Boolean(workspaceDraft.activateMode),
          pauseOtherAgents: Boolean(modeDraft.pauseOtherAgents),
          holdActiveNonBenchmarkTasks: Boolean(modeDraft.holdActiveNonBenchmarkTasks),
          maxParallel:
            modeDraft.maxParallel === "" || modeDraft.maxParallel == null
              ? null
              : Number(modeDraft.maxParallel),
        }),
      });
      showToast("Benchmark workspace prepared", "success");
      await refresh(provider.id);
    } catch (err) {
      showToast(err?.message || "Failed to prepare benchmark workspace", "error");
    } finally {
      setBusy((current) => ({ ...current, workspace: false }));
    }
  }, [modeDraft, provider?.id, refresh, workspaceDraft]);

  const handleRunSubmit = useCallback(async () => {
    if (!provider?.id) return;
    setBusy((current) => ({ ...current, run: true }));
    haptic("medium");
    try {
      await apiFetch("/api/benchmarks/run", {
        method: "POST",
        body: JSON.stringify({
          providerId: provider.id,
          workspaceId: currentWorkspaceId || undefined,
          pauseOtherAgents: Boolean(modeDraft.pauseOtherAgents),
          holdActiveNonBenchmarkTasks: Boolean(modeDraft.holdActiveNonBenchmarkTasks),
          maxParallel:
            modeDraft.maxParallel === "" || modeDraft.maxParallel == null
              ? null
              : Number(modeDraft.maxParallel),
          ...toLaunchPayload(provider, runDraft),
        }),
      });
      showToast("Benchmark run launched", "success");
      await refresh(provider.id);
    } catch (err) {
      showToast(err?.message || "Failed to launch benchmark run", "error");
    } finally {
      setBusy((current) => ({ ...current, run: false }));
    }
  }, [currentWorkspaceId, modeDraft, provider, refresh, runDraft]);

  const activeWorkspace = workspaceEntries.find(
    (entry) => String(entry?.id || "").trim() === String(currentWorkspaceId || "").trim(),
  ) || null;
  const summary = data?.summary || {};
  const launchBlocked =
    !provider?.supports?.launch || isRequiredLaunchFieldMissing(provider, runDraft);
  const workflowRuns = Array.isArray(data?.workflowRuns) ? data.workflowRuns : [];
  const benchmarkTasks = Array.isArray(data?.recentTasks) ? data.recentTasks : [];
  const benchmarkSlots = Array.isArray(data?.executor?.benchmarkSlots)
    ? data.executor.benchmarkSlots
    : [];
  const competingSlots = Array.isArray(data?.executor?.competingSlots)
    ? data.executor.competingSlots
    : [];

  return html`
    <${Box} sx=${{ p: 1.5 }}>
      <${Stack} spacing=${2}>
        <${Stack}
          direction=${{ xs: "column", md: "row" }}
          spacing=${1.5}
          alignItems=${{ xs: "stretch", md: "center" }}
          justifyContent="space-between"
        >
          <div>
            <${Typography} variant="h5">Benchmarks</${Typography}>
            <${Typography} variant="body2" sx=${{ opacity: 0.75 }}>
              Create isolated benchmark workspaces, enable focus mode, launch provider-specific runs, and watch benchmark activity live.
            </${Typography}>
          </div>
          <${Stack} direction="row" spacing=${1} alignItems="center">
            ${activeWorkspace
              ? html`<${Chip} size="small" variant="outlined" label=${`Workspace: ${activeWorkspace.name || activeWorkspace.id}`} />`
              : null}
            ${data?.mode?.enabled
              ? html`<${Chip} size="small" color="success" label=${`Mode: ${data.mode.providerId || "active"}`} />`
              : html`<${Chip} size="small" variant="outlined" label="Mode idle" />`}
            <${Button}
              variant="outlined"
              onClick=${() => refresh(provider?.id)}
              disabled=${busy.refreshing}
            >
              ${busy.refreshing ? "Refreshing..." : "Refresh"}
            </${Button}>
          </${Stack}>
        </${Stack}>

        ${!isLoaded && !data
          ? html`
              <${Paper} variant="outlined" sx=${{ p: 3, textAlign: "center" }}>
                <${CircularProgress} size=${24} />
              </${Paper}>
            `
          : html`
              <${Grid} container=${true} spacing=${2}>
                <${Grid} item=${true} xs=${12}>
                  <${Card} variant="outlined">
                    <${CardContent}>
                      <${Stack} spacing=${1.5}>
                        <${Stack}
                          direction=${{ xs: "column", md: "row" }}
                          spacing=${1.5}
                          alignItems=${{ xs: "stretch", md: "center" }}
                        >
                          <${FormControl} size="small" sx=${{ minWidth: 240 }}>
                            <${InputLabel} id="benchmark-provider-label">Provider</${InputLabel}>
                            <${Select}
                              labelId="benchmark-provider-label"
                              label="Provider"
                              value=${provider?.id || ""}
                              onChange=${handleProviderChange}
                            >
                              ${(data?.providers || []).map((entry) => html`
                                <${MenuItem} key=${entry.id} value=${entry.id}>
                                  ${entry.name}${entry.comingSoon ? " (coming soon)" : ""}
                                </${MenuItem}>
                              `)}
                            </${Select}>
                          </${FormControl}>
                          <${Stack} direction="row" spacing=${1} sx=${{ flexWrap: "wrap" }}>
                            ${provider?.supports?.launch
                              ? html`<${Chip} size="small" color="success" variant="outlined" label="Launch supported" />`
                              : html`<${Chip} size="small" variant="outlined" label="Launch pending" />`}
                            ${provider?.supports?.workspacePreset
                              ? html`<${Chip} size="small" variant="outlined" label="Workspace preset" />`
                              : null}
                            ${provider?.supports?.focusMode
                              ? html`<${Chip} size="small" variant="outlined" label="Focus mode" />`
                              : null}
                          </${Stack}>
                        </${Stack}>
                        ${provider?.description
                          ? html`<${Typography} variant="body2" sx=${{ opacity: 0.82 }}>
                              ${provider.description}
                            </${Typography}>`
                          : null}
                      </${Stack}>
                    </${CardContent}>
                  </${Card}>
                </${Grid}>

                <${Grid} item=${true} xs=${12}>
                  <${Box}
                    sx=${{
                      display: "grid",
                      gap: 1.5,
                      gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
                    }}
                  >
                    <${SummaryMetric} label="Total" value=${summary.total ?? 0} />
                    <${SummaryMetric} label="Todo" value=${summary.todo ?? 0} />
                    <${SummaryMetric} label="Running" value=${summary.inprogress ?? 0} />
                    <${SummaryMetric} label="Review" value=${summary.inreview ?? 0} />
                    <${SummaryMetric} label="Done" value=${summary.done ?? 0} />
                    <${SummaryMetric} label="Blocked" value=${summary.blocked ?? 0} />
                  </${Box}>
                </${Grid}>

                <${Grid} item=${true} xs=${12} lg=${6}>
                  <${Card} variant="outlined">
                    <${CardContent}>
                      <${Stack} spacing=${1.5}>
                        <div>
                          <${Typography} variant="h6">Benchmark mode</${Typography}>
                          <${Typography} variant="body2" sx=${{ opacity: 0.75 }}>
                            Limit new dispatches to benchmark-tagged tasks in the active workspace and optionally hold competing active work.
                          </${Typography}>
                        </div>
                        ${provider?.supports?.focusMode !== true
                          ? html`<${Alert} severity="info">This provider does not expose focus-mode controls yet.</${Alert}>`
                          : html`
                              <${FormControlLabel}
                                control=${html`
                                  <${Switch}
                                    checked=${Boolean(modeDraft.pauseOtherAgents)}
                                    onChange=${(event) =>
                                      setModeDraft((current) => ({
                                        ...current,
                                        pauseOtherAgents: event.target.checked,
                                      }))}
                                  />
                                `}
                                label="Prioritize benchmark work over general task dispatch"
                              />
                              <${FormControlLabel}
                                control=${html`
                                  <${Switch}
                                    checked=${Boolean(modeDraft.holdActiveNonBenchmarkTasks)}
                                    onChange=${(event) =>
                                      setModeDraft((current) => ({
                                        ...current,
                                        holdActiveNonBenchmarkTasks: event.target.checked,
                                      }))}
                                  />
                                `}
                                label="Hold active competing non-benchmark tasks"
                              />
                              <${TextField}
                                size="small"
                                type="number"
                                label="Max parallel benchmark slots"
                                value=${modeDraft.maxParallel ?? ""}
                                onInput=${(event) =>
                                  setModeDraft((current) => ({
                                    ...current,
                                    maxParallel: event.target.value,
                                  }))}
                                inputProps=${{ min: 0, max: 20 }}
                              />
                              <${Stack} direction="row" spacing=${1} alignItems="center">
                                <${Button}
                                  variant="contained"
                                  onClick=${handleModeSubmit}
                                  disabled=${busy.mode}
                                >
                                  ${busy.mode
                                    ? "Saving..."
                                    : (data?.mode?.enabled ? "Disable mode" : "Enable mode")}
                                </${Button}>
                                ${data?.mode?.enabled
                                  ? html`<${Chip} color="success" size="small" label=${`Active for ${data.mode.providerId || provider?.id || "benchmark"}`} />`
                                  : html`<${Chip} variant="outlined" size="small" label="Inactive" />`}
                              </${Stack}>
                              <${Typography} variant="caption" sx=${{ opacity: 0.75 }}>
                                Scope: ${data?.filter?.workspaceDir || data?.workspace?.workspaceDir || "current workspace"}
                              </${Typography}>
                            `}
                      </${Stack}>
                    </${CardContent}>
                  </${Card}>
                </${Grid}>

                <${Grid} item=${true} xs=${12} lg=${6}>
                  <${Card} variant="outlined">
                    <${CardContent}>
                      <${Stack} spacing=${1.5}>
                        <div>
                          <${Typography} variant="h6">Benchmark workspace preset</${Typography}>
                          <${Typography} variant="body2" sx=${{ opacity: 0.75 }}>
                            Create a dedicated managed workspace for benchmarks and seed the benchmark profile/runtime without touching your current repo.
                          </${Typography}>
                        </div>
                        <${TextField}
                          size="small"
                          label="Workspace name"
                          value=${workspaceDraft.name}
                          onInput=${(event) =>
                            setWorkspaceDraft((current) => ({
                              ...current,
                              name: event.target.value,
                            }))}
                        />
                        <${TextField}
                          size="small"
                          label="Repo URL (optional)"
                          value=${workspaceDraft.repoUrl}
                          onInput=${(event) =>
                            setWorkspaceDraft((current) => ({
                              ...current,
                              repoUrl: event.target.value,
                            }))}
                          helperText="Clone a benchmark repo into the new workspace, or leave blank to scaffold an empty managed workspace."
                        />
                        <${Stack} direction=${{ xs: "column", md: "row" }} spacing=${1}>
                          <${TextField}
                            size="small"
                            label="Branch (optional)"
                            value=${workspaceDraft.repoBranch}
                            onInput=${(event) =>
                              setWorkspaceDraft((current) => ({
                                ...current,
                                repoBranch: event.target.value,
                              }))}
                            sx=${{ flex: 1 }}
                          />
                          <${TextField}
                            size="small"
                            label="Repo name (optional)"
                            value=${workspaceDraft.repoName}
                            onInput=${(event) =>
                              setWorkspaceDraft((current) => ({
                                ...current,
                                repoName: event.target.value,
                              }))}
                            sx=${{ flex: 1 }}
                          />
                        </${Stack}>
                        <${TextField}
                          size="small"
                          label="Existing repo root (optional)"
                          value=${workspaceDraft.repoRoot}
                          onInput=${(event) =>
                            setWorkspaceDraft((current) => ({
                              ...current,
                              repoRoot: event.target.value,
                            }))}
                          helperText="Use this when the benchmark repo already exists on disk and you only want Bosun benchmark scaffolding."
                        />
                        <${FormControlLabel}
                          control=${html`
                            <${Switch}
                              checked=${Boolean(workspaceDraft.ensureRuntime)}
                              onChange=${(event) =>
                                setWorkspaceDraft((current) => ({
                                  ...current,
                                  ensureRuntime: event.target.checked,
                                }))}
                            />
                          `}
                          label="Install benchmark workflow runtime"
                        />
                        <${FormControlLabel}
                          control=${html`
                            <${Switch}
                              checked=${Boolean(workspaceDraft.switchActive)}
                              onChange=${(event) =>
                                setWorkspaceDraft((current) => ({
                                  ...current,
                                  switchActive: event.target.checked,
                                }))}
                            />
                          `}
                          label="Switch the UI to this workspace after create"
                        />
                        <${FormControlLabel}
                          control=${html`
                            <${Switch}
                              checked=${Boolean(workspaceDraft.reuseExisting)}
                              onChange=${(event) =>
                                setWorkspaceDraft((current) => ({
                                  ...current,
                                  reuseExisting: event.target.checked,
                                }))}
                            />
                          `}
                          label="Reuse an existing workspace with the same name"
                        />
                        <${Button}
                          variant="contained"
                          onClick=${handleWorkspaceSubmit}
                          disabled=${busy.workspace || !String(workspaceDraft.name || "").trim()}
                        >
                          ${busy.workspace ? "Preparing..." : "Create benchmark workspace"}
                        </${Button}>
                      </${Stack}>
                    </${CardContent}>
                  </${Card}>
                </${Grid}>

                <${Grid} item=${true} xs=${12}>
                  <${Card} variant="outlined">
                    <${CardContent}>
                      <${Stack} spacing=${1.5}>
                        <div>
                          <${Typography} variant="h6">Launch benchmark run</${Typography}>
                          <${Typography} variant="body2" sx=${{ opacity: 0.75 }}>
                            Use the selected provider's launch schema. For SWE-bench, point Bosun at the benchmark instances file and optionally turn on focus mode in the same step.
                          </${Typography}>
                        </div>
                        ${(provider?.launchUi?.fields || []).length === 0
                          ? html`<${Alert} severity="info">This provider does not expose a UI launch form yet.</${Alert}>`
                          : html`
                              ${(provider?.launchUi?.fields || []).map((field) =>
                                field.type === "boolean"
                                  ? html`
                                      <${FormControlLabel}
                                        key=${field.key}
                                        control=${html`
                                          <${Switch}
                                            checked=${Boolean(runDraft[field.key])}
                                            onChange=${(event) =>
                                              setRunDraft((current) => ({
                                                ...current,
                                                [field.key]: event.target.checked,
                                              }))}
                                          />
                                        `}
                                        label=${field.label || field.key}
                                      />
                                    `
                                  : html`
                                      <${TextField}
                                        key=${field.key}
                                        size="small"
                                        type=${field.type === "number" ? "number" : "text"}
                                        label=${field.label || field.key}
                                        value=${runDraft[field.key] ?? ""}
                                        onInput=${(event) =>
                                          setRunDraft((current) => ({
                                            ...current,
                                            [field.key]: event.target.value,
                                          }))}
                                        inputProps=${field.type === "number"
                                          ? { min: field.min ?? undefined, max: field.max ?? undefined }
                                          : undefined}
                                        helperText=${field.description || ""}
                                      />
                                    `,
                              )}
                              <${Divider} />
                              <${FormControlLabel}
                                control=${html`
                                  <${Switch}
                                    checked=${Boolean(runDraft.prepareWorkspace)}
                                    onChange=${(event) =>
                                      setRunDraft((current) => ({
                                        ...current,
                                        prepareWorkspace: event.target.checked,
                                      }))}
                                  />
                                `}
                                label="Prepare the active workspace before launch"
                              />
                              <${FormControlLabel}
                                control=${html`
                                  <${Switch}
                                    checked=${Boolean(runDraft.activateMode)}
                                    onChange=${(event) =>
                                      setRunDraft((current) => ({
                                        ...current,
                                        activateMode: event.target.checked,
                                      }))}
                                  />
                                `}
                                label="Enable benchmark mode after launch"
                              />
                              <${Stack} direction="row" spacing=${1} alignItems="center">
                                <${Tooltip}
                                  title=${launchBlocked
                                    ? "Fill every required provider field before launching."
                                    : "Launch the selected provider now."}
                                >
                                  <span>
                                    <${Button}
                                      variant="contained"
                                      onClick=${handleRunSubmit}
                                      disabled=${busy.run || launchBlocked}
                                    >
                                      ${busy.run
                                        ? "Launching..."
                                        : (provider?.launchUi?.actionLabel || "Launch benchmark")}
                                    </${Button}>
                                  </span>
                                </${Tooltip}>
                                ${provider?.comingSoon
                                  ? html`<${Chip} size="small" variant="outlined" label="Coming soon" />`
                                  : null}
                              </${Stack}>
                            `}
                      </${Stack}>
                    </${CardContent}>
                  </${Card}>
                </${Grid}>

                <${Grid} item=${true} xs=${12} lg=${5}>
                  <${Stack} spacing=${2}>
                    <${Paper} variant="outlined" sx=${{ p: 1.5 }}>
                      <${Typography} variant="subtitle2" sx=${{ mb: 1 }}>
                        Executor focus
                      </${Typography}>
                      <${Stack} direction="row" spacing=${1} sx=${{ flexWrap: "wrap", mb: 1 }}>
                        <${Chip} size="small" label=${`Active slots: ${data?.executor?.activeSlots ?? 0}`} />
                        <${Chip} size="small" label=${`Max parallel: ${data?.executor?.maxParallel ?? "—"}`} />
                        <${Chip}
                          size="small"
                          color=${data?.executor?.paused ? "warning" : "success"}
                          label=${data?.executor?.paused ? "Executor paused" : "Executor live"}
                        />
                      </${Stack}>
                      <${Typography} variant="body2" sx=${{ opacity: 0.75 }}>
                        Benchmark slots: ${benchmarkSlots.length} • Competing slots: ${competingSlots.length}
                      </${Typography}>
                    </${Paper}>

                    <${ItemList}
                      title="Active benchmark slots"
                      items=${benchmarkSlots}
                      emptyLabel="No active benchmark slots yet."
                      renderSecondary=${(slot) =>
                        `${slot.status || "active"} • ${slot.sdk || "sdk: n/a"}${slot.runningFor ? ` • ${formatDurationMs(slot.runningFor)}` : ""}`
                      }
                    />

                    <${ItemList}
                      title="Competing active work"
                      items=${competingSlots}
                      emptyLabel="No competing non-benchmark slots are active."
                      renderSecondary=${(slot) =>
                        `${slot.status || "active"} • ${slot.workspace || slot.repository || "other workspace"}`
                      }
                    />
                  </${Stack}>
                </${Grid}>

                <${Grid} item=${true} xs=${12} lg=${7}>
                  <${Stack} spacing=${2}>
                    <${ItemList}
                      title="Recent benchmark tasks"
                      items=${benchmarkTasks}
                      emptyLabel="No benchmark tasks are visible in the active workspace yet."
                      renderSecondary=${(task) =>
                        `${task.status || "todo"}${task.runtimeSnapshot?.state ? ` • ${task.runtimeSnapshot.state}` : ""} • Updated ${formatAgo(task.updatedAt || task.createdAt)}`
                      }
                    />

                    <${ItemList}
                      title="Recent workflow runs"
                      items=${workflowRuns}
                      emptyLabel="No benchmark-linked workflow runs yet."
                      renderSecondary=${(run) =>
                        `${run.status || "unknown"} • ${formatDurationMs(run.duration)} • ${formatAgo(run.startedAt || run.endedAt)}`
                      }
                    />
                  </${Stack}>
                </${Grid}>
              </${Grid}>
            `}
      </${Stack}>
    </${Box}>
  `;
}
