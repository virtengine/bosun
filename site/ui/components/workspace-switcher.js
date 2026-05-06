/* ─────────────────────────────────────────────────────────────
 *  Workspace Switcher — dropdown + full management panel
 *  Used in the Header component for quick workspace navigation
 *  and a full-screen manager for CRUD operations on workspaces.
 * ────────────────────────────────────────────────────────────── */

import { h } from "preact";
import { useState, useEffect, useCallback, useRef } from "preact/hooks";
import { signal } from "@preact/signals";
import htm from "htm";
import { apiFetch, onWsMessage } from "../modules/api.js";
import { haptic } from "../modules/telegram.js";
import { Modal } from "./shared.js";
import {
  WorkspaceExecutorSettingsFields,
  formatWorkspaceExecutorSummary,
} from "./workspace-executor-settings.js";
import { iconText, resolveIcon } from "../modules/icon-utils.js";
import {
  Card, CardContent, CardActions,
  Typography, TextField, Button, IconButton,
  Chip, Box, Stack, CircularProgress,
  Dialog, DialogTitle, DialogContent,
  DialogActions as MuiDialogActions,
  List, ListItem, ListItemText, ListItemIcon,
  ListItemSecondaryAction, Divider, Tooltip, Alert,
  Menu, MenuItem,
  ToggleButton, ToggleButtonGroup,
  Slider, Collapse,
} from "@mui/material";

const html = htm.bind(h);

// ─── Shared signals for workspace state ────────────────────
export const workspaces = signal([]);
export const activeWorkspaceId = signal(null);
export const workspacesLoading = signal(false);

/**
 * Load workspaces from the API.
 */
export async function loadWorkspaces() {
  workspacesLoading.value = true;
  try {
    const res = await apiFetch("/api/workspaces");
    if (res?.ok) {
      workspaces.value = res.data || [];
      activeWorkspaceId.value = res.activeId || null;
    }
  } catch (err) {
    console.warn("[workspace-switcher] Failed to load workspaces:", err);
  } finally {
    workspacesLoading.value = false;
  }
}

/**
 * Switch to a different workspace.
 */
export async function switchWorkspace(wsId) {
  try {
    const res = await apiFetch("/api/workspaces/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: wsId }),
    });
    if (!res?.ok) {
      throw new Error(res?.error || "Failed to switch workspace");
    }
    activeWorkspaceId.value = String(res.activeId || wsId);
    await loadWorkspaces();
    try {
      globalThis.dispatchEvent?.(
        new CustomEvent("ve:workspace-switched", {
          detail: { workspaceId: activeWorkspaceId.value || String(wsId || "") },
        }),
      );
    } catch {
      // no-op
    }
    try {
      const { refreshTab } = await import("../modules/state.js");
      await Promise.allSettled([
        refreshTab("tasks", { background: true, manual: false }),
        refreshTab("dashboard", { background: true, manual: false }),
      ]);
    } catch {
      // best effort
    }
    return true;
  } catch (err) {
    console.warn("[workspace-switcher] Failed to switch workspace:", err);
    return false;
  }
}

// ─── API helpers for workspace management ──────────────────

async function createWorkspace(name) {
  const res = await apiFetch("/api/workspaces/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (res?.ok) await loadWorkspaces();
  return res;
}

async function deleteWorkspace(workspaceId, deleteFiles = false) {
  const res = await apiFetch("/api/workspaces/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, deleteFiles }),
  });
  if (res?.ok) await loadWorkspaces();
  return res;
}

async function addRepo(workspaceId, url, opts = {}) {
  const res = await apiFetch("/api/workspaces/repos/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, url, ...opts }),
  });
  if (res?.ok) await loadWorkspaces();
  return res;
}

async function removeRepo(workspaceId, repoName, deleteFiles = false) {
  const res = await apiFetch("/api/workspaces/repos/remove", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, repoName, deleteFiles }),
  });
  if (res?.ok) await loadWorkspaces();
  return res;
}

async function pullWorkspace(workspaceId) {
  const res = await apiFetch("/api/workspaces/pull", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId }),
  });
  if (res?.ok) await loadWorkspaces();
  return res;
}

async function scanDisk() {
  const res = await apiFetch("/api/workspaces/scan");
  if (res?.ok) await loadWorkspaces();
  return res;
}

// ─── API helpers for workspace state management ────────────

async function setWorkspaceState(workspaceId, state) {
  const res = await apiFetch("/api/workspaces/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, state }),
  });
  if (res?.ok) await loadWorkspaces();
  return res;
}

export async function setWorkspaceExecutors(workspaceId, executors) {
  const res = await apiFetch("/api/workspaces/executors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, ...executors }),
  });
  if (res?.ok) await loadWorkspaces();
  return res;
}

// State display helpers
const STATE_CONFIG = {
  active:   { icon: "●", color: "#10b981", label: "Active",   desc: "Workflows running, executors available" },
  paused:   { icon: "◐", color: "#f59e0b", label: "Paused",   desc: "In-flight tasks finish, no new starts" },
  disabled: { icon: "○", color: "#71717a", label: "Disabled", desc: "Fully off — no workflows, no executors" },
};

// ─── Confirm dialog helper ─────────────────────────────────
function ConfirmBar({ message, onConfirm, onCancel, loading }) {
  return html`
    <${Alert}
      severity="warning"
      variant="outlined"
      sx=${{ my: 1 }}
      action=${html`
        <${Stack} direction="row" spacing=${1}>
          <${Button}
            size="small"
            color="error"
            variant="contained"
            onClick=${onConfirm}
            disabled=${loading}
          >
            ${loading ? html`<${CircularProgress} size=${16} />` : "Yes"}
          <//>
          <${Button}
            size="small"
            variant="outlined"
            onClick=${onCancel}
            disabled=${loading}
          >Cancel<//>
        <//>
      `}
    >
      <${Typography} variant="body2">${message}<//>
    <//>
  `;
}

// ─── Single repo row in management panel ───────────────────
function RepoRow({ repo, workspaceId }) {
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);

  const handleRemove = useCallback(async () => {
    setRemoving(true);
    haptic("medium");
    try {
      await removeRepo(workspaceId, repo.name, false);
    } catch (e) {
      console.warn("[ws-manager] remove repo error:", e);
    } finally {
      setRemoving(false);
      setConfirming(false);
    }
  }, [workspaceId, repo.name]);

  if (confirming) {
    return html`
      <${ListItem} sx=${{ flexDirection: "column", alignItems: "stretch" }}>
        <${ConfirmBar}
          message="Remove ${repo.name}?"
          onConfirm=${handleRemove}
          onCancel=${() => setConfirming(false)}
          loading=${removing}
        />
      <//>
    `;
  }

  return html`
    <${ListItem} dense>
      ${repo.primary && html`
        <${ListItemIcon} sx=${{ minWidth: 32 }}>
          <${Tooltip} title="Primary">
            <span>${resolveIcon("star")}</span>
          <//>
        <//>
      `}
      <${ListItemText}
        primary=${repo.name}
        secondary=${repo.exists ? null : "Missing on disk"}
        primaryTypographyProps=${{
          sx: { color: repo.exists ? "text.primary" : "error.main" },
        }}
      />
      <${ListItemSecondaryAction}>
        <${Stack} direction="row" spacing=${0.5} alignItems="center">
          <${Chip}
            label=${repo.exists ? "✓" : "✗ missing"}
            size="small"
            color=${repo.exists ? "success" : "error"}
            variant="outlined"
          />
          <${Tooltip} title="Remove repo">
            <${IconButton}
              size="small"
              onClick=${() => { haptic("light"); setConfirming(true); }}
            >${resolveIcon("✕")}<//>
          <//>
        <//>
      <//>
    <//>
  `;
}

// ─── Add-repo form (expandable per workspace) ──────────────
function AddRepoForm({ workspaceId }) {
  const [expanded, setExpanded] = useState(false);
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [loading, setLoading] = useState(false);

  const handleAdd = useCallback(async () => {
    if (!url.trim()) return;
    setLoading(true);
    haptic("medium");
    try {
      await addRepo(workspaceId, url.trim(), branch.trim() ? { branch: branch.trim() } : {});
      setUrl("");
      setBranch("");
      setExpanded(false);
    } catch (e) {
      console.warn("[ws-manager] add repo error:", e);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, url, branch]);

  if (!expanded) {
    return html`
      <${Box} sx=${{ px: 2, pb: 1 }}>
        <${Button}
          size="small"
          variant="text"
          onClick=${() => { haptic("light"); setExpanded(true); }}
        >+ Add Repo<//>
      <//>
    `;
  }

  return html`
    <${Stack} spacing=${1.5} sx=${{ px: 2, pb: 2 }}>
      <${TextField}
        size="small"
        fullWidth
        label="Git URL (https or ssh)"
        value=${url}
        onInput=${(e) => setUrl(e.target.value)}
        disabled=${loading}
      />
      <${TextField}
        size="small"
        fullWidth
        label="Branch (optional)"
        value=${branch}
        onInput=${(e) => setBranch(e.target.value)}
        disabled=${loading}
      />
      <${Stack} direction="row" spacing=${1}>
        <${Button}
          size="small"
          variant="contained"
          onClick=${handleAdd}
          disabled=${loading || !url.trim()}
          startIcon=${loading ? html`<${CircularProgress} size=${16} />` : null}
        >${loading ? "Cloning…" : "Clone"}<//>
        <${Button}
          size="small"
          variant="outlined"
          onClick=${() => { setExpanded(false); setUrl(""); setBranch(""); }}
          disabled=${loading}
        >Cancel<//>
      <//>
    <//>
  `;
}

// ─── Workspace state toggle ─────────────────────────────────
function WorkspaceStateToggle({ ws, compact = false }) {
  const [saving, setSaving] = useState(false);
  const currentState = ws.state || "active";

  const handleChange = useCallback(async (_e, newState) => {
    if (!newState || newState === currentState) return;
    setSaving(true);
    haptic("medium");
    try {
      await setWorkspaceState(ws.id, newState);
    } catch (e) {
      console.warn("[ws-manager] state change error:", e);
    } finally {
      setSaving(false);
    }
  }, [ws.id, currentState]);

  if (compact) {
    const cfg = STATE_CONFIG[currentState];
    return html`
      <${Tooltip} title="${cfg.label}: ${cfg.desc}">
        <span style="color: ${cfg.color}; font-size: 14px; cursor: default;">${cfg.icon}</span>
      <//>
    `;
  }

  return html`
    <${Stack} direction="row" spacing=${1} alignItems="center">
      <${ToggleButtonGroup}
        value=${currentState}
        exclusive
        onChange=${handleChange}
        size="small"
        disabled=${saving}
        sx=${{ height: 30 }}
      >
        ${Object.entries(STATE_CONFIG).map(([key, cfg]) => html`
          <${ToggleButton}
            key=${key}
            value=${key}
            sx=${{
              px: 1.2,
              py: 0.3,
              fontSize: "11px",
              textTransform: "none",
              fontWeight: currentState === key ? 600 : 400,
              color: currentState === key ? cfg.color : "text.secondary",
              borderColor: currentState === key ? cfg.color : undefined,
              "&.Mui-selected": {
                backgroundColor: cfg.color + "18",
                color: cfg.color,
                borderColor: cfg.color + "60",
                "&:hover": { backgroundColor: cfg.color + "28" },
              },
            }}
          >
            <${Tooltip} title=${cfg.desc}>
              <span>${cfg.icon} ${cfg.label}</span>
            <//>
          <//>
        `)}
      <//>
      ${saving && html`<${CircularProgress} size=${14} />`}
    <//>
  `;
}

// ─── Executor config panel (collapsible) ────────────────────
function ExecutorConfigPanel({ ws }) {
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const execs = ws.executors || {};
  const [maxConcurrent, setMaxConcurrent] = useState(execs.maxConcurrent || 3);
  const [pool, setPool] = useState(execs.pool || "shared");
  const [weight, setWeight] = useState(execs.weight || 1.0);

  // Sync state with ws props when they change
  useEffect(() => {
    const e = ws.executors || {};
    setMaxConcurrent(e.maxConcurrent || 3);
    setPool(e.pool || "shared");
    setWeight(e.weight || 1.0);
  }, [ws.executors?.maxConcurrent, ws.executors?.pool, ws.executors?.weight]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    haptic("medium");
    try {
      await setWorkspaceExecutors(ws.id, { maxConcurrent, pool, weight });
    } catch (e) {
      console.warn("[ws-manager] executor config error:", e);
    } finally {
      setSaving(false);
    }
  }, [ws.id, maxConcurrent, pool, weight]);

  const hasChanges = maxConcurrent !== (execs.maxConcurrent || 3)
    || pool !== (execs.pool || "shared")
    || weight !== (execs.weight || 1.0);

  return html`
    <${Box} sx=${{ mt: 0.5 }}>
      <${Button}
        size="small"
        variant="text"
        onClick=${() => { haptic("light"); setExpanded(!expanded); }}
        sx=${{ textTransform: "none", fontSize: "11px", color: "text.secondary", px: 0.5 }}
      >
        ${resolveIcon("settings")} ${" "}Executors ${expanded ? "▾" : "▸"}
        ${!expanded && html`
          <${Chip}
            label=${formatWorkspaceExecutorSummary({
              maxConcurrent: execs.maxConcurrent || 3,
              pool: execs.pool || "shared",
              weight: execs.weight || 1.0,
            })}
            size="small"
            variant="outlined"
            sx=${{ ml: 0.5, height: 18, fontSize: "10px" }}
          />
        `}
      <//>

      <${Collapse} in=${expanded}>
        <${Box} sx=${{ pt: 1, pb: 0.5, px: 0.5 }}>
          <${WorkspaceExecutorSettingsFields}
            title="Workspace Executors"
            maxConcurrent=${maxConcurrent}
            pool=${pool}
            weight=${weight}
            onMaxConcurrentChange=${setMaxConcurrent}
            onPoolChange=${setPool}
            onWeightChange=${setWeight}
            saving=${saving}
            hasChanges=${hasChanges}
            onSave=${handleSave}
            saveLabel="Save Executor Config"
          />
        <//>
      <//>
    <//>
  `;
}

// ─── Single workspace card in the management panel ─────────
function WorkspaceCard({ ws }) {
  const isActive = ws.id === activeWorkspaceId.value;
  const [pulling, setPulling] = useState(false);
  const [delConfirm, setDelConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [activating, setActivating] = useState(false);
  const wsState = ws.state || "active";
  const stateCfg = STATE_CONFIG[wsState];

  const handleSetActive = useCallback(async () => {
    setActivating(true);
    haptic("medium");
    try {
      await switchWorkspace(ws.id);
    } finally {
      setActivating(false);
    }
  }, [ws.id]);

  const handlePull = useCallback(async () => {
    setPulling(true);
    haptic("light");
    try {
      await pullWorkspace(ws.id);
    } catch (e) {
      console.warn("[ws-manager] pull error:", e);
    } finally {
      setPulling(false);
    }
  }, [ws.id]);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    haptic("heavy");
    try {
      await deleteWorkspace(ws.id, false);
    } catch (e) {
      console.warn("[ws-manager] delete error:", e);
    } finally {
      setDeleting(false);
      setDelConfirm(false);
    }
  }, [ws.id]);

  return html`
    <${Card}
      variant="outlined"
      sx=${{
        mb: 2,
        borderColor: wsState === "disabled" ? "action.disabled"
          : isActive ? "primary.main" : "divider",
        borderWidth: isActive ? 2 : 1,
        opacity: wsState === "disabled" ? 0.6 : 1,
        transition: "opacity 0.2s, border-color 0.2s",
      }}
    >
      <${CardContent} sx=${{ pb: 0 }}>
        <${Stack} direction="row" justifyContent="space-between" alignItems="center">
          <${Stack} direction="row" spacing=${1} alignItems="center">
            <${Tooltip} title="${stateCfg.label}: ${stateCfg.desc}">
              <span style="color: ${stateCfg.color}; font-size: 16px;">${stateCfg.icon}</span>
            <//>
            <${Typography} variant="subtitle1" fontWeight="bold">${ws.name}<//>
            ${isActive && html`
              <${Chip} label="Active" size="small" color="primary" />
            `}
            ${wsState === "paused" && html`
              <${Chip} label="Paused" size="small"
                sx=${{ bgcolor: "#f59e0b22", color: "#f59e0b", fontWeight: 600, fontSize: "10px" }}
              />
            `}
            ${wsState === "disabled" && html`
              <${Chip} label="Disabled" size="small"
                sx=${{ bgcolor: "#71717a22", color: "#71717a", fontWeight: 600, fontSize: "10px" }}
              />
            `}
          <//>
        <//>


        <${Box} sx=${{ mt: 1.5, mb: 0.5 }}>
          <${WorkspaceStateToggle} ws=${ws} />
        <//>


        <${ExecutorConfigPanel} ws=${ws} />
      <//>

      <${CardActions} sx=${{ justifyContent: "flex-end", pt: 0.5 }}>
        ${!isActive && html`
          <${Button}
            size="small"
            variant="outlined"
            onClick=${handleSetActive}
            disabled=${activating}
            startIcon=${activating ? html`<${CircularProgress} size=${16} />` : null}
          >${activating ? "Activating…" : "Activate"}<//>
        `}
        <${Button}
          size="small"
          variant="text"
          onClick=${handlePull}
          disabled=${pulling}
          startIcon=${pulling ? html`<${CircularProgress} size=${16} />` : null}
        >${pulling ? "Pulling…" : iconText(":refresh: Pull")}<//>
        <${Tooltip} title="Delete workspace">
          <${IconButton}
            size="small"
            color="error"
            onClick=${() => { haptic("light"); setDelConfirm(true); }}
          >${resolveIcon(":trash:")}<//>
        <//>
      <//>

      ${delConfirm && html`
        <${Box} sx=${{ px: 2, pb: 1 }}>
          <${ConfirmBar}
            message="Delete workspace '${ws.name}'?"
            onConfirm=${handleDelete}
            onCancel=${() => setDelConfirm(false)}
            loading=${deleting}
          />
        <//>
      `}

      <${Divider} />

      <${CardContent} sx=${{ pt: 1, "&:last-child": { pb: 1 } }}>
        ${(ws.repos || []).length === 0
          ? html`<${Typography} variant="body2" color="text.secondary">No repos yet<//>`
          : html`
            <${List} dense disablePadding>
              ${(ws.repos || []).map((r) => html`
                <${RepoRow} key=${r.name} repo=${r} workspaceId=${ws.id} />
              `)}
            <//>
          `
        }
        <${AddRepoForm} workspaceId=${ws.id} />
      <//>
    <//>
  `;
}

// ─── Add workspace form ────────────────────────────────────
function AddWorkspaceForm() {
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);

  const handleCreate = useCallback(async () => {
    if (!name.trim()) return;
    setLoading(true);
    haptic("medium");
    try {
      await createWorkspace(name.trim());
      setName("");
    } catch (e) {
      console.warn("[ws-manager] create workspace error:", e);
    } finally {
      setLoading(false);
    }
  }, [name]);

  return html`
    <${Box} sx=${{ p: 2, mt: 1 }}>
      <${Typography} variant="subtitle2" sx=${{ mb: 1 }}>Create Workspace<//>
      <${Stack} direction="row" spacing=${1} alignItems="center">
        <${TextField}
          size="small"
          fullWidth
          label="Workspace name"
          value=${name}
          onInput=${(e) => setName(e.target.value)}
          onKeyDown=${(e) => { if (e.key === "Enter") handleCreate(); }}
          disabled=${loading}
        />
        <${Button}
          variant="contained"
          onClick=${handleCreate}
          disabled=${loading || !name.trim()}
          startIcon=${loading ? html`<${CircularProgress} size=${16} />` : null}
        >${loading ? "Creating…" : "Create"}<//>
      <//>
    <//>
  `;
}

// ─── Full-screen management panel ──────────────────────────
export function WorkspaceManager({ open, onClose }) {
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    if (open) loadWorkspaces();
  }, [open]);

  // Close on Escape key
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const handleScan = useCallback(async () => {
    setScanning(true);
    haptic("medium");
    try {
      await scanDisk();
    } catch (e) {
      console.warn("[ws-manager] scan error:", e);
    } finally {
      setScanning(false);
    }
  }, []);

  if (!open) return null;

  const wsList = workspaces.value;
  const loading = workspacesLoading.value;

  // Compute state summary counts
  const stateCounts = { active: 0, paused: 0, disabled: 0 };
  wsList.forEach((ws) => {
    const s = ws.state || "active";
    if (stateCounts[s] !== undefined) stateCounts[s]++;
  });

  return html`
    <${Modal} title="Manage Workspaces" open=${open} onClose=${onClose}>

      ${wsList.length > 0 && html`
        <${Stack} direction="row" spacing=${1.5} sx=${{ mb: 2 }} alignItems="center">
          ${Object.entries(STATE_CONFIG).map(([key, cfg]) => html`
            <${Chip}
              key=${key}
              icon=${html`<span style="color: ${cfg.color}; font-size: 12px; margin-left: 8px;">${cfg.icon}</span>`}
              label="${stateCounts[key] || 0} ${cfg.label}"
              size="small"
              variant=${stateCounts[key] > 0 ? "filled" : "outlined"}
              sx=${{
                fontSize: "11px",
                fontWeight: 500,
                bgcolor: stateCounts[key] > 0 ? cfg.color + "18" : undefined,
                borderColor: cfg.color + "40",
                color: stateCounts[key] > 0 ? cfg.color : "text.secondary",
              }}
            />
          `)}
        <//>
      `}

      <${Box} sx=${{ mb: 2 }}>
        <${Button}
          size="small"
          variant="outlined"
          onClick=${handleScan}
          disabled=${scanning}
          startIcon=${scanning ? html`<${CircularProgress} size=${16} />` : null}
        >${scanning ? "Scanning…" : iconText(":search: Scan Disk")}<//>
      <//>

      ${loading && !wsList.length
        ? html`
          <${Stack} alignItems="center" sx=${{ py: 4 }}>
            <${CircularProgress} size=${28} />
            <${Typography} variant="body2" color="text.secondary" sx=${{ mt: 1 }}>
              Loading workspaces…
            <//>
          <//>
        `
        : null
      }

      <${Stack} spacing=${0}>
        ${wsList.map((ws) => html`
          <${WorkspaceCard} key=${ws.id} ws=${ws} />
        `)}
      <//>

      ${!wsList.length && !loading
        ? html`
          <${Typography} variant="body2" color="text.secondary" sx=${{ textAlign: "center", py: 3 }}>
            No workspaces found. Create one or scan disk.
          <//>
        `
        : null
      }

      <${AddWorkspaceForm} />
    <//>
  `;
}

// ─── Main component: MUI Menu dropdown + manage trigger ─────
export function WorkspaceSwitcher() {
  const [managerOpen, setManagerOpen] = useState(false);
  const [switchingId, setSwitchingId] = useState(null);
  const [menuAnchor, setMenuAnchor] = useState(null);

  useEffect(() => {
    loadWorkspaces();
  }, []);

  // Keep selector state in sync when workspace is switched externally
  // (for example via Electron menu or another client).
  useEffect(() => {
    const unsubscribe = onWsMessage((msg) => {
      if (msg?.type !== "invalidate") return;
      const channels = Array.isArray(msg.channels) ? msg.channels : [];
      if (channels.includes("*") || channels.includes("workspaces")) {
        loadWorkspaces().catch(() => {});
      }
    });
    return unsubscribe;
  }, []);

  // Desktop fallback when WS is unavailable: refresh workspace state whenever
  // the window regains focus/visibility.
  useEffect(() => {
    const sync = () => loadWorkspaces().catch(() => {});
    const onFocus = () => sync();
    const onVisibility = () => {
      if (document.visibilityState === "visible") sync();
    };
    globalThis.addEventListener?.("focus", onFocus);
    document.addEventListener?.("visibilitychange", onVisibility);
    return () => {
      globalThis.removeEventListener?.("focus", onFocus);
      document.removeEventListener?.("visibilitychange", onVisibility);
    };
  }, []);

  const wsList = workspaces.value;
  const currentId = activeWorkspaceId.value;
  const currentWs = wsList.find((ws) => ws.id === currentId);

  const handleMenuOpen = (e) => {
    setMenuAnchor(e.currentTarget);
  };

  const handleMenuClose = () => {
    setMenuAnchor(null);
  };

  const handleSelect = async (wsId) => {
    handleMenuClose();
    if (wsId === "__manage__") {
      haptic("medium");
      setManagerOpen(true);
      return;
    }
    if (!wsId || wsId === currentId) return;
    if (switchingId && switchingId === wsId) return;
    haptic("light");
    setSwitchingId(wsId);
    try {
      await switchWorkspace(wsId);
    } finally {
      setSwitchingId(null);
    }
  };

  if (!wsList.length && !workspacesLoading.value) {
    return html`
      <div class="ws-switcher">
        <${Button}
          size="small"
          variant="text"
          onClick=${() => { haptic("medium"); setManagerOpen(true); }}
          title="Set up a workspace"
          startIcon=${html`<span>${resolveIcon("settings")}</span>`}
        >Set up workspace<//>
        <${WorkspaceManager}
          open=${managerOpen}
          onClose=${() => setManagerOpen(false)}
        />
      </div>
    `;
  }

  return html`
    <div class="ws-switcher">
      <${Button}
        size="small"
        variant="text"
        className="ws-switcher-trigger"
        onClick=${handleMenuOpen}
        disabled=${Boolean(switchingId)}
        sx=${{
          textTransform: "none",
          minWidth: 0,
          maxWidth: { xs: 108, sm: 180 },
          px: { xs: 0.75, sm: 1.25 },
          justifyContent: "flex-start",
        }}
      >
        ${switchingId
          ? html`<${CircularProgress} size=${16} sx=${{ mr: 1 }} />`
          : currentWs
            ? html`<span style="color: ${STATE_CONFIG[currentWs.state || "active"].color}; margin-right: 4px;">
                ${STATE_CONFIG[currentWs.state || "active"].icon}
              </span>`
            : null
        }
        <span class="ws-switcher-trigger-label">
          ${currentWs?.name || currentId || "Select Workspace"}
        </span>
      <//>

      <${Menu}
        anchorEl=${menuAnchor}
        open=${Boolean(menuAnchor)}
        onClose=${handleMenuClose}
      >
        ${wsList.map((ws) => {
          const st = STATE_CONFIG[ws.state || "active"];
          return html`
            <${MenuItem}
              key=${ws.id}
              selected=${ws.id === currentId}
              onClick=${() => handleSelect(ws.id)}
              sx=${{
                opacity: ws.state === "disabled" ? 0.5 : 1,
                gap: 1,
              }}
            >
              <span style="color: ${st.color}; font-size: 12px; width: 16px; text-align: center;">${st.icon}</span>
              ${ws.name || ws.id}
              ${ws.state === "paused" && html`
                <${Chip} label="paused" size="small"
                  sx=${{ ml: 0.5, height: 16, fontSize: "9px", bgcolor: "#f59e0b22", color: "#f59e0b" }}
                />
              `}
              ${ws.state === "disabled" && html`
                <${Chip} label="off" size="small"
                  sx=${{ ml: 0.5, height: 16, fontSize: "9px", bgcolor: "#71717a22", color: "#71717a" }}
                />
              `}
            <//>
          `;
        })}
        <${Divider} />
        <${MenuItem} onClick=${() => handleSelect("__manage__")}>
          Manage Workspaces
        <//>
      <//>

      <${WorkspaceManager}
        open=${managerOpen}
        onClose=${() => setManagerOpen(false)}
      />
    </div>
  `;
}
