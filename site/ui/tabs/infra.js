/* ─────────────────────────────────────────────────────────────
 *  Tab: Infra — worktrees, shared workspaces, presence
 * ────────────────────────────────────────────────────────────── */
import { h as _h } from "preact";
import { useState, useMemo } from "preact/hooks";
import htm from "htm";

/* Guard: recover when a React-style forwardRef object leaks into h(). */
function h(type, ...args) {
  if (type != null && typeof type === "object" && typeof type !== "function") {
    if (typeof type.render === "function") return _h(type.render, ...args);
  }
  return _h(type, ...args);
}

const html = htm.bind(h);

import { haptic, showConfirm } from "../modules/telegram.js";
import { apiFetch } from "../modules/api.js";
import { iconText, resolveIcon } from "../modules/icon-utils.js";
import {
  worktreeData,
  sharedWorkspaces,
  presenceInstances,
  coordinatorInfo,
  showToast,
  refreshTab,
  runOptimistic,
  scheduleRefresh,
} from "../modules/state.js";
import { ICONS } from "../modules/icons.js";
import { cloneValue, formatRelative, formatBytes, downloadFile } from "../modules/utils.js";
import { buildWorktreeRecoveryViewModel } from "../modules/worktree-recovery.js";
import {
  Card as LegacyCard,
  Badge as LegacyBadge,
  StatCard,
  SkeletonCard,
  EmptyState,
} from "../components/shared.js";
import { ProgressBar } from "../components/charts.js";
import { Collapsible } from "../components/forms.js";
import {
  workspaces as managedWorkspaces,
  activeWorkspaceId,
  loadWorkspaces as loadManagedWorkspaces,
} from "../components/workspace-switcher.js";
import {
  Typography, Box, Stack, Card, CardContent, CardHeader, CardActions,
  Button, IconButton, Chip, Divider, Paper, TextField, InputAdornment,
  CircularProgress, Alert, Tooltip, Switch, FormControlLabel, Dialog,
  DialogTitle, DialogContent, DialogActions, List, ListItem, ListItemButton,
  ListItemText, ListItemIcon, ListItemSecondaryAction, Menu, MenuItem,
  Tabs, Tab, Skeleton, Badge, Grid, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, Accordion, AccordionSummary,
  AccordionDetails, LinearProgress, Select, FormControl, InputLabel, Avatar,
} from "@mui/material";

/* ─── Worktree health indicator ─── */
function healthColor(wt) {
  if (wt.status === "stale" || wt.status === "error")
    return "var(--color-error)";
  const ageMin = Math.round((wt.age || 0) / 60000);
  if (ageMin > 180) return "var(--color-inreview)"; // yellow — old
  return "var(--color-done)"; // green — healthy
}

function HealthDot({ wt }) {
  return html`<span
    class="health-dot"
    style="background:${healthColor(wt)}"
  ></span>`;
}

function ageString(ms) {
  const min = Math.round((ms || 0) / 60000);
  if (min >= 1440) return `${Math.round(min / 1440)}d`;
  if (min >= 60) return `${Math.round(min / 60)}h`;
  return `${min}m`;
}

/* ─── InfraTab ─── */
export function InfraTab() {
  /* Worktrees — work with either the new signal name or a compatible shape */
  const wtRaw = worktreeData?.value;
  const wts = Array.isArray(wtRaw)
    ? wtRaw
    : wtRaw?.worktrees || wtRaw?.data || [];
  const wStats = (wtRaw && !Array.isArray(wtRaw) ? wtRaw.stats : null) || {};
  const recovery = buildWorktreeRecoveryViewModel(wStats.recovery || null);
  const liveWorktreeTotal = Number(wStats.liveTotal ?? wStats.total ?? wts.length ?? 0);
  const hasRecoveryOnlySignal = liveWorktreeTotal === 0 && recovery.events.length > 0;

  /* Shared workspaces */
  const swRaw = sharedWorkspaces?.value;
  const registry = swRaw || {};
  const workspaces =
    registry?.workspaces || (Array.isArray(swRaw) ? swRaw : []);
  const availability = registry?.availability || {};

  /* Presence */
  const instances = presenceInstances?.value || [];
  const coordinator = coordinatorInfo?.value || null;

  /* Local form state */
  const [releaseInput, setReleaseInput] = useState("");
  const [sharedOwner, setSharedOwner] = useState("");
  const [sharedTtl, setSharedTtl] = useState("");
  const [sharedNote, setSharedNote] = useState("");
  const [expandedWt, setExpandedWt] = useState(null);
  const [worktreeDetails, setWorktreeDetails] = useState({});
  const [wtSearch, setWtSearch] = useState("");
  const [wtSort, setWtSort] = useState("age");

  const filteredWts = useMemo(() => {
    let list = wts;
    if (wtSearch.trim()) {
      const q = wtSearch.trim().toLowerCase();
      list = list.filter((wt) =>
        (wt.branch || "").toLowerCase().includes(q) ||
        (wt.path || "").toLowerCase().includes(q) ||
        (wt.taskKey || "").toLowerCase().includes(q) ||
        (wt.status || "").toLowerCase().includes(q),
      );
    }
    const sorted = [...list];
    switch (wtSort) {
      case "age-asc":
        sorted.sort((a, b) => (b.age || 0) - (a.age || 0));
        break;
      case "branch":
        sorted.sort((a, b) => (a.branch || "").localeCompare(b.branch || ""));
        break;
      case "status":
        sorted.sort((a, b) => (a.status || "").localeCompare(b.status || ""));
        break;
      default:
        sorted.sort((a, b) => (a.age || 0) - (b.age || 0));
    }
    return sorted;
  }, [wts, wtSearch, wtSort]);

  /* ── Worktree actions ── */
  const handlePrune = async () => {
    const ok = await showConfirm("Prune all stale worktrees?");
    if (!ok) return;
    haptic("medium");
    await apiFetch("/api/worktrees/prune", { method: "POST" }).catch(() => {});
    showToast("Prune initiated", "success");
    scheduleRefresh(120);
  };

  const handleRelease = async (key, branch) => {
    haptic("medium");
    const prev = cloneValue(wts);
    await runOptimistic(
      () => {
        const setter = worktreeData || {};
        if (Array.isArray(setter.value)) {
          setter.value = setter.value.filter(
            (w) => w.taskKey !== key && w.branch !== branch,
          );
        }
      },
      () =>
        apiFetch("/api/worktrees/release", {
          method: "POST",
          body: JSON.stringify({ taskKey: key, branch }),
        }),
      () => {
        if (worktreeData) worktreeData.value = prev;
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

  const loadWorktreePeek = async (wt) => {
    const key = wt?.path || wt?.branch || wt?.taskKey;
    if (!key) return;
    if (worktreeDetails[key]?.loading || worktreeDetails[key]?.loaded) return;
    setWorktreeDetails((prev) => ({
      ...prev,
      [key]: { loading: true },
    }));
    try {
      const res = await apiFetch(`/api/worktrees/peek?path=${encodeURIComponent(wt.path || "")}`, {
        _silent: true,
      });
      setWorktreeDetails((prev) => ({
        ...prev,
        [key]: { ...(res?.data || {}), loaded: true },
      }));
    } catch (err) {
      setWorktreeDetails((prev) => ({
        ...prev,
        [key]: { loaded: true, error: err?.message || "Failed to load" },
      }));
    }
  };

  /* ── Shared workspace actions ── */
  const handleClaim = async (wsId) => {
    haptic("medium");
    const prev = cloneValue(sharedWorkspaces?.value);
    await runOptimistic(
      () => {
        const w = (sharedWorkspaces?.value?.workspaces || []).find(
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
        if (sharedWorkspaces) sharedWorkspaces.value = prev;
      },
    ).catch(() => {});
    scheduleRefresh(120);
  };

  const handleRenew = async (wsId) => {
    haptic("medium");
    const prev = cloneValue(sharedWorkspaces?.value);
    await runOptimistic(
      () => {
        const w = (sharedWorkspaces?.value?.workspaces || []).find(
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
        if (sharedWorkspaces) sharedWorkspaces.value = prev;
      },
    ).catch(() => {});
    scheduleRefresh(120);
  };

  const handleSharedRelease = async (wsId) => {
    haptic("medium");
    const prev = cloneValue(sharedWorkspaces?.value);
    await runOptimistic(
      () => {
        const w = (sharedWorkspaces?.value?.workspaces || []).find(
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
        if (sharedWorkspaces) sharedWorkspaces.value = prev;
      },
    ).catch(() => {});
    scheduleRefresh(120);
  };

  /* ── Managed Workspace state ── */
  const [addRepoUrl, setAddRepoUrl] = useState("");
  const [addRepoWs, setAddRepoWs] = useState("");
  const [newWsName, setNewWsName] = useState("");

  const handleCreateWorkspace = async () => {
    const name = newWsName.trim();
    if (!name) return;
    haptic("medium");
    try {
      await apiFetch("/api/workspaces/create", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      showToast(`Workspace "${name}" created`, "success");
      setNewWsName("");
      await loadManagedWorkspaces();
      scheduleRefresh(120);
    } catch (err) {
      showToast(err?.message || "Failed to create workspace", "error");
    }
  };

  const handleDeleteWorkspace = async (id) => {
    const ok = await showConfirm("Delete this workspace? This cannot be undone.");
    if (!ok) return;
    haptic("medium");
    try {
      await apiFetch("/api/workspaces/delete", {
        method: "POST",
        body: JSON.stringify({ id }),
      });
      showToast("Workspace deleted", "success");
      await loadManagedWorkspaces();
      scheduleRefresh(120);
    } catch (err) {
      showToast(err?.message || "Failed to delete workspace", "error");
    }
  };

  const handlePullWorkspace = async (id) => {
    haptic("medium");
    try {
      await apiFetch("/api/workspaces/pull", {
        method: "POST",
        body: JSON.stringify({ id }),
      });
      showToast("Pull initiated", "success");
      await loadManagedWorkspaces();
      scheduleRefresh(120);
    } catch (err) {
      showToast(err?.message || "Failed to pull workspace", "error");
    }
  };

  const handleAddRepo = async (wsId, url) => {
    if (!url || !url.trim()) return;
    haptic("medium");
    try {
      await apiFetch("/api/workspaces/repos/add", {
        method: "POST",
        body: JSON.stringify({ workspaceId: wsId, url: url.trim() }),
      });
      showToast("Repo added", "success");
      setAddRepoUrl("");
      setAddRepoWs("");
      await loadManagedWorkspaces();
      scheduleRefresh(120);
    } catch (err) {
      showToast(err?.message || "Failed to add repo", "error");
    }
  };

  const handleRemoveRepo = async (wsId, repoName) => {
    const ok = await showConfirm(`Remove repo "${repoName}" from workspace?`);
    if (!ok) return;
    haptic("medium");
    try {
      await apiFetch("/api/workspaces/repos/remove", {
        method: "POST",
        body: JSON.stringify({ workspaceId: wsId, repoName }),
      });
      showToast("Repo removed", "success");
      await loadManagedWorkspaces();
      scheduleRefresh(120);
    } catch (err) {
      showToast(err?.message || "Failed to remove repo", "error");
    }
  };

  const handleScanDisk = async () => {
    haptic("medium");
    try {
      await apiFetch("/api/workspaces/scan");
      showToast("Disk scan complete", "success");
      await loadManagedWorkspaces();
      scheduleRefresh(120);
    } catch (err) {
      showToast(err?.message || "Scan failed", "error");
    }
  };

  /* ── Export infrastructure report ── */
  const handleExportReport = () => {
    haptic("medium");
    const now = new Date();
    const activeCount = wStats.active ?? wts.filter((w) => w.status !== "stale" && w.status !== "error").length;
    const staleCount = wStats.stale ?? wts.filter((w) => w.status === "stale").length;
    const availCount = workspaces.filter((w) => w.availability === "available").length;
    const leasedCount = workspaces.filter((w) => w.availability === "leased").length;

    let report = "";
    report += "VirtEngine Infrastructure Report\n";
    report += `Generated: ${now.toISOString()}\n\n`;

    report += "== Worktrees ==\n";
    report += `Total: ${wts.length} | Active: ${activeCount} | Stale: ${staleCount}\n\n`;
    for (const wt of wts) {
      report += `- ${wt.branch || "(detached)"} (${wt.status || "active"}) — Age: ${ageString(wt.age)}, Path: ${wt.path || "—"}\n`;
    }

    report += "\n== Shared Workspaces ==\n";
    report += `Total: ${workspaces.length} | Available: ${availCount} | Leased: ${leasedCount}\n\n`;
    for (const ws of workspaces) {
      const lease = ws.lease;
      const owner = lease ? lease.owner || "—" : "—";
      const expiry = lease ? new Date(lease.lease_expires_at).toISOString() : "—";
      report += `- ${ws.name || ws.id}: ${ws.availability || "unknown"} — Owner: ${owner}, Expires: ${expiry}\n`;
    }

    report += "\n== Active Instances ==\n";
    report += `Coordinator: ${coordinator?.instance_label || coordinator?.instance_id || "none"}\n`;
    report += `Instances: ${instances.length}\n`;
    for (const inst of instances) {
      const since = inst.last_seen_at ? new Date(inst.last_seen_at).toISOString() : "unknown";
      report += `- ${inst.instance_label || inst.instance_id} (${inst.workspace_role || "workspace"}) — Since: ${since}\n`;
    }

    const dateStr = now.toISOString().slice(0, 10);
    downloadFile(report, `infra-report-${dateStr}.txt`, "text/plain");
    showToast("Infrastructure report exported", "success");
  };

  /* ── Render ── */
  return html`
    <${Box} sx=${{ display: "flex", flexDirection: "column", gap: 2, p: 1 }}>
      <!-- ─── Infra header with export ─── -->
      <${Stack} direction="row" justifyContent="space-between" alignItems="center">
        <${Typography} variant="h6" fontWeight=${600}>Infrastructure<//>
        <${Button}
          variant="outlined"
          size="small"
          startIcon=${html`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`}
          onClick=${handleExportReport}
        >Export Report<//>
      <//>

      <!-- ─── Managed Workspaces ─── -->
      <${Accordion} defaultExpanded>
        <${AccordionSummary}>
          <${Typography} fontWeight=${600}>Managed Workspaces<//>
        <//>
        <${AccordionDetails}>
          <${Stack} spacing=${1.5}>
            <${Stack} direction="row" spacing=${1}>
              <${TextField}
                size="small"
                fullWidth
                placeholder="New workspace name"
                value=${newWsName}
                onInput=${(e) => setNewWsName(e.target.value)}
                onKeyDown=${(e) => e.key === "Enter" && handleCreateWorkspace()}
              />
              <${Button} variant="contained" size="small" onClick=${handleCreateWorkspace}>
                ${iconText(":plus: Create")}
              <//>
              <${Button} variant="outlined" size="small" onClick=${handleScanDisk}>
                ${iconText(":refresh: Scan")}
              <//>
            <//>

            ${(managedWorkspaces.value || []).map((ws) => {
              const isActive = ws.id === activeWorkspaceId.value;
              const repos = Array.isArray(ws.repos) ? ws.repos : [];
              return html`
                <${Card} key=${ws.id} variant="outlined" sx=${{ bgcolor: "background.paper" }}>
                  <${CardContent}>
                    <${Stack} direction="row" justifyContent="space-between" alignItems="flex-start">
                      <${Box}>
                        <${Stack} direction="row" spacing=${1} alignItems="center">
                          <${Box} sx=${{ width: 8, height: 8, borderRadius: "50%", bgcolor: isActive ? "success.main" : "grey.600" }} />
                          <${Typography} fontWeight=${600}>${ws.name || ws.id}<//>
                          ${isActive && html`<${Chip} label="Active" color="success" size="small" />`}
                        <//>
                        <${Typography} variant="caption" color="text.secondary">${repos.length} repos · ID: ${ws.id}<//>
                      <//>
                      <${Stack} direction="row" spacing=${0.5}>
                        <${Button} variant="outlined" size="small" onClick=${() => handlePullWorkspace(ws.id)}>
                          ${iconText(":download: Pull")}
                        <//>
                        <${IconButton} size="small" color="error" onClick=${() => handleDeleteWorkspace(ws.id)}>
                          ${resolveIcon(":trash:")}
                        <//>
                      <//>
                    <//>

                    ${repos.length > 0 && html`
                      <${List} dense sx=${{ mt: 1 }}>
                        ${repos.map((repo) => {
                          const repoName = typeof repo === "string" ? repo : repo.name || repo.url || "?";
                          return html`
                            <${ListItem} key=${repoName}
                              secondaryAction=${html`
                                <${IconButton} edge="end" size="small" onClick=${() => handleRemoveRepo(ws.id, repoName)}>
                                  ${resolveIcon("✕")}
                                <//>
                              `}
                            >
                              <${ListItemIcon} sx=${{ minWidth: 32 }}>${resolveIcon(":folder:")}<//>
                              <${ListItemText} primary=${repoName} primaryTypographyProps=${{ variant: "body2" }} />
                            <//>
                          `;
                        })}
                      <//>
                    `}

                    <${Stack} direction="row" spacing=${1} sx=${{ mt: 1 }}>
                      <${TextField}
                        size="small"
                        fullWidth
                        placeholder="Repo URL to clone"
                        value=${addRepoWs === ws.id ? addRepoUrl : ""}
                        onInput=${(e) => { setAddRepoWs(ws.id); setAddRepoUrl(e.target.value); }}
                        onKeyDown=${(e) => e.key === "Enter" && handleAddRepo(ws.id, addRepoWs === ws.id ? addRepoUrl : "")}
                      />
                      <${Button} variant="outlined" size="small" onClick=${() => handleAddRepo(ws.id, addRepoWs === ws.id ? addRepoUrl : "")}>
                        ${iconText(":download: Clone")}
                      <//>
                    <//>
                  <//>
                <//>
              `;
            })}

            ${!(managedWorkspaces.value || []).length && html`<${EmptyState} message="No managed workspaces. Create one or scan disk." />`}
          <//>
        <//>
      <//>

      <!-- ─── Worktrees ─── -->
      <${Accordion} defaultExpanded>
        <${AccordionSummary}>
          <${Typography} fontWeight=${600}>Worktrees<//>
        <//>
        <${AccordionDetails}>
          <${Stack} spacing=${1.5}>
            <!-- Stats row -->
            <${Stack} direction="row" spacing=${2}>
              <${Paper} variant="outlined" sx=${{ p: 1.5, textAlign: "center", flex: 1 }}>
                <${Typography} variant="h5">${liveWorktreeTotal}<//>
                <${Typography} variant="caption" color="text.secondary">Live Total<//>
              <//>
              <${Paper} variant="outlined" sx=${{ p: 1.5, textAlign: "center", flex: 1 }}>
                <${Typography} variant="h5" sx=${{ color: "success.main" }}>${wStats.active ?? 0}<//>
                <${Typography} variant="caption" color="text.secondary">Active<//>
              <//>
              <${Paper} variant="outlined" sx=${{ p: 1.5, textAlign: "center", flex: 1 }}>
                <${Typography} variant="h5" sx=${{ color: "warning.main" }}>${wStats.stale ?? 0}<//>
                <${Typography} variant="caption" color="text.secondary">Stale<//>
              <//>
            <//>

            <${Paper} variant="outlined" sx=${{ p: 1.5 }}>
              <${Stack} direction="row" justifyContent="space-between" alignItems="flex-start" spacing=${1}>
                <${Box}>
                  <${Typography} fontWeight=${600}>Recovery Diagnostics<//>
                  <${Typography} variant="body2" color="text.secondary">${recovery.headline}<//>
                  <${Typography} variant="caption" color="text.secondary">${recovery.summary}<//>
                <//>
                <${Chip}
                  label=${recovery.health}
                  size="small"
                  color=${recovery.tone === "error" ? "error" : recovery.tone === "warning" ? "warning" : "success"}
                  variant="outlined"
                />
              <//>
              ${hasRecoveryOnlySignal && html`
                <${Alert} severity="info" sx=${{ mt: 1 }}>
                  Live totals only count registry-managed worktrees that are still active. Recovery events can reference recreated workflow worktrees that no longer appear in the live registry.
                <//>
              `}
              ${recovery.events.slice(0, 4).map((event) => html`
                <${Paper} key=${event.key} variant="outlined" sx=${{ p: 1, mt: 1, bgcolor: "background.default" }}>
                  <${Typography} variant="body2" fontWeight=${600}>${event.title}<//>
                  <${Typography} variant="caption" color="text.secondary">${event.detail}<//>
                  ${event.error && html`<${Typography} variant="caption" color="error.main" sx=${{ display: "block", mt: 0.5 }}>${event.error}<//>`}
                <//>
              `)}
            <//>

            <${Stack} direction="row" spacing=${1} alignItems="center">
              <${TextField}
                size="small"
                fullWidth
                placeholder="Search worktrees…"
                value=${wtSearch}
                onInput=${(e) => setWtSearch(e.target.value)}
                InputProps=${{ startAdornment: html`<${InputAdornment} position="start">${resolveIcon(":search:")}<//>` }}
              />
              <${FormControl} size="small" sx=${{ minWidth: 130 }}>
                <${Select}
                  value=${wtSort}
                  onChange=${(e) => setWtSort(e.target.value)}
                  displayEmpty
                >
                  <${MenuItem} value="age">Newest first<//>
                  <${MenuItem} value="age-asc">Oldest first<//>
                  <${MenuItem} value="branch">Branch A–Z<//>
                  <${MenuItem} value="status">Status<//>
                <//>
              <//>
              <${Chip}
                label=${`${filteredWts.length} of ${wts.length}`}
                size="small"
                variant="outlined"
              />
            <//>

            <${Stack} direction="row" spacing=${1}>
              <${TextField}
                size="small"
                fullWidth
                placeholder="Task key or branch"
                value=${releaseInput}
                onInput=${(e) => setReleaseInput(e.target.value)}
              />
              <${Button} variant="outlined" size="small" onClick=${handleReleaseInput}>Release<//>
              <${Button} variant="outlined" size="small" color="error" onClick=${handlePrune}>
                ${iconText(":trash: Prune")}
              <//>
            <//>

            ${filteredWts.map((wt) => {
              const key = wt?.path || wt?.branch || wt?.taskKey;
              const detail = worktreeDetails[key] || {};
              const detailLoading = Boolean(detail?.loading);
              const detailError = detail?.error;
              return html`
                <${Card} key=${key} variant="outlined" sx=${{ bgcolor: "background.paper" }}>
                  <${CardContent}
                    sx=${{ cursor: "pointer" }}
                    onClick=${() => {
                      haptic();
                      const nextOpen = expandedWt === key ? null : key;
                      setExpandedWt(nextOpen);
                      if (nextOpen === key) loadWorktreePeek(wt);
                    }}
                  >
                    <${Stack} direction="row" justifyContent="space-between" alignItems="center">
                      <${Stack} direction="row" spacing=${1} alignItems="center">
                        <${HealthDot} wt=${wt} />
                        <${Box}>
                          <${Typography} fontWeight=${600} variant="body2">${wt.branch || "(detached)"}<//>
                          <${Typography} variant="caption" color="text.secondary">${wt.path}<//>
                        <//>
                      <//>
                      <${Chip}
                        label=${wt.status || "active"}
                        size="small"
                        color=${(wt.status === "stale" || wt.status === "error") ? "error" : "success"}
                        variant="outlined"
                      />
                    <//>
                    <${Typography} variant="caption" color="text.secondary" sx=${{ mt: 0.5, display: "block" }}>
                      Age ${ageString(wt.age)}${wt.taskKey ? ` · ${wt.taskKey}` : ""}${wt.owner ? ` · Owner ${wt.owner}` : ""}
                    <//>

                    ${expandedWt === key && html`
                      <${Box} sx=${{ mt: 1 }}>
                        ${detailLoading && html`
                          <${Stack} spacing=${0.5}>
                            <${Skeleton} variant="rounded" height=${60} />
                            <${Skeleton} variant="text" width="60%" />
                            <${Skeleton} variant="text" width="40%" />
                          <//>
                        `}
                        ${detailError && html`<${Alert} severity="error" variant="outlined" sx=${{ mt: 0.5 }}>${detailError}<//>`}
                        ${detail.gitStatus && html`<${Paper} variant="outlined" sx=${{ p: 1, mt: 0.5, fontFamily: "monospace", fontSize: "0.8em", whiteSpace: "pre-wrap" }}>${detail.gitStatus}<//>`}
                        ${detail.lastCommit && html`<${Typography} variant="caption" color="text.secondary" sx=${{ display: "block", mt: 0.5 }}>Last commit: ${detail.lastCommit?.slice(0, 80)}<//>`}
                        ${detail.filesChanged != null && html`<${Typography} variant="caption" color="text.secondary" sx=${{ display: "block" }}>Files changed: ${detail.filesChanged}<//>`}
                        ${detail.diffSummary && html`<${Paper} variant="outlined" sx=${{ p: 1, mt: 0.5, fontFamily: "monospace", fontSize: "0.8em", whiteSpace: "pre-wrap" }}>${detail.diffSummary}<//>`}
                        ${Array.isArray(detail.recentCommits) && detail.recentCommits.length > 0 && html`
                          <${Typography} variant="caption" color="text.secondary" sx=${{ display: "block", mt: 0.5 }}>Recent commits:<//>
                          <${Paper} variant="outlined" sx=${{ p: 1, fontFamily: "monospace", fontSize: "0.8em" }}>
                            ${detail.recentCommits.map((c) => html`<div>${c}</div>`)}
                          <//>
                        `}
                        ${Array.isArray(detail.sessions) && detail.sessions.length > 0 && html`
                          <${Typography} variant="caption" color="text.secondary" sx=${{ display: "block", mt: 0.5 }}>Active sessions:<//>
                          <${Paper} variant="outlined" sx=${{ p: 1, fontFamily: "monospace", fontSize: "0.8em" }}>
                            ${detail.sessions.map((s) => html`<div>${s.title || s.id} · ${s.type} · ${formatRelative(s.lastActiveAt)}</div>`)}
                          <//>
                        `}
                      <//>
                    `}
                  <//>
                  <${CardActions}>
                    ${wt.taskKey && html`<${Button} size="small" onClick=${() => handleRelease(wt.taskKey, "")}>Release Key<//>`}
                    ${wt.branch && html`<${Button} size="small" onClick=${() => handleRelease("", wt.branch)}>Release Branch<//>`}
                  <//>
                <//>
              `;
            })}
            ${!filteredWts.length && html`<${EmptyState} message=${wtSearch ? "No worktrees match filter." : "No worktrees tracked."} />`}
          <//>
        <//>
      <//>

      <!-- ─── Shared Workspaces ─── -->
      <${Accordion} defaultExpanded>
        <${AccordionSummary}>
          <${Typography} fontWeight=${600}>Shared Workspaces<//>
        <//>
        <${AccordionDetails}>
          <${Stack} spacing=${1.5}>
            <${Stack} direction="row" spacing=${0.5} flexWrap="wrap">
              ${Object.entries(availability).map(([k, v]) => html`<${Chip} key=${k} label=${`${k}: ${v}`} size="small" variant="outlined" />`)}
              ${!Object.keys(availability).length && html`<${Chip} label="No registry" size="small" variant="outlined" />`}
            <//>

            <${Stack} direction="row" spacing=${1}>
              <${TextField} size="small" fullWidth placeholder="Owner" value=${sharedOwner} onInput=${(e) => setSharedOwner(e.target.value)} />
              <${TextField} size="small" type="number" placeholder="TTL (min)" value=${sharedTtl} onInput=${(e) => setSharedTtl(e.target.value)} inputProps=${{ min: 30, step: 15 }} sx=${{ width: 120 }} />
            <//>
            <${TextField} size="small" fullWidth placeholder="Note (optional)" value=${sharedNote} onInput=${(e) => setSharedNote(e.target.value)} />

            ${workspaces.map((ws) => {
              const lease = ws.lease;
              const leaseInfo = lease ? `Leased to ${lease.owner} until ${new Date(lease.lease_expires_at).toLocaleString()}` : "Available";
              return html`
                <${Card} key=${ws.id} variant="outlined" sx=${{ bgcolor: "background.paper" }}>
                  <${CardContent}>
                    <${Stack} direction="row" justifyContent="space-between" alignItems="center">
                      <${Box}>
                        <${Typography} fontWeight=${600}>${ws.name || ws.id}<//>
                        <${Typography} variant="caption" color="text.secondary">${ws.provider || "provider"} · ${ws.region || "region?"}<//>
                      <//>
                      <${Chip}
                        label=${ws.availability}
                        size="small"
                        color=${ws.availability === "available" ? "success" : ws.availability === "leased" ? "warning" : "default"}
                        variant="outlined"
                      />
                    <//>
                    <${Typography} variant="body2" color="text.secondary" sx=${{ mt: 0.5 }}>${leaseInfo}<//>
                    ${lease?.note && html`<${Typography} variant="body2" color="text.secondary" fontStyle="italic">${lease.note}<//>`}
                  <//>
                  <${CardActions}>
                    <${Button} size="small" variant="contained" onClick=${() => handleClaim(ws.id)}>${iconText(":lock: Claim")}<//>
                    <${Button} size="small" variant="outlined" onClick=${() => handleRenew(ws.id)}>↻ Renew<//>
                    <${Button} size="small" onClick=${() => handleSharedRelease(ws.id)}>${iconText(":unlock: Release")}<//>
                  <//>
                <//>
              `;
            })}
            ${!workspaces.length && html`<${EmptyState} message="No shared workspaces configured." />`}
          <//>
        <//>
      <//>

      <!-- ─── Presence ─── -->
      <${Accordion} defaultExpanded>
        <${AccordionSummary}>
          <${Typography} fontWeight=${600}>Presence<//>
        <//>
        <${AccordionDetails}>
          <${Stack} spacing=${1.5}>
            <!-- Coordinator info -->
            <${Card} variant="outlined" sx=${{ bgcolor: "background.paper" }}>
              <${CardContent}>
                <${Typography} fontWeight=${600}>${iconText(":target: Coordinator")}<//>
                <${Typography} variant="body2" color="text.secondary">
                  ${coordinator?.instance_label || coordinator?.instance_id || "none"}
                  · Priority ${coordinator?.coordinator_priority ?? "—"}
                <//>
                ${coordinator?.last_seen_at && html`
                  <${Typography} variant="caption" color="text.secondary" sx=${{ display: "block" }}>
                    Last seen: ${formatRelative(coordinator.last_seen_at)}
                  <//>
                `}
              <//>
            <//>

            <!-- Instance grid -->
            ${instances.length ? html`
              <${Grid} container spacing=${1}>
                ${instances.map((inst, i) => html`
                  <${Grid} item xs=${12} sm=${6} md=${4} key=${i}>
                    <${Card} variant="outlined" sx=${{ bgcolor: "background.paper" }}>
                      <${CardContent} sx=${{ p: 1.5, "&:last-child": { pb: 1.5 } }}>
                        <${Stack} direction="row" spacing=${1} alignItems="center">
                          <${Box} sx=${{ width: 8, height: 8, borderRadius: "50%", bgcolor: inst.status === "offline" ? "error.main" : "success.main" }} />
                          <${Typography} fontWeight=${600} variant="body2">${inst.instance_label || inst.instance_id}<//>
                        <//>
                        <${Typography} variant="caption" color="text.secondary" sx=${{ display: "block" }}>
                          ${inst.workspace_role || "workspace"} · ${inst.host || "host"}
                        <//>
                        <${Typography} variant="caption" color="text.secondary" sx=${{ display: "block" }}>
                          Last: ${inst.last_seen_at ? formatRelative(inst.last_seen_at) : "unknown"}
                        <//>
                      <//>
                    <//>
                  <//>
                `)}
              <//>
            ` : html`<${EmptyState} message="No active instances." />`}
          <//>
        <//>
      <//>
    <//>
  `;
}
