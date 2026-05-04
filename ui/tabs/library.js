/* ─────────────────────────────────────────────────────────────
 *  Tab: Library — Prompt, Agent Profile & Skill Manager
 *  View, search, create, edit, and delete library resources
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import { useState, useCallback, useEffect, useRef, useMemo } from "preact/hooks";
import { signal } from "@preact/signals";
import htm from "htm";

const html = htm.bind(h);

import { haptic } from "../modules/telegram.js";
import { apiFetch } from "../modules/api.js";
import {
  showToast,
  refreshTab,
  setPendingChange,
  clearPendingChange,
} from "../modules/state.js";
import { ICONS } from "../modules/icons.js";
import { iconText, resolveIcon } from "../modules/icon-utils.js";
import { formatRelative, countChangedFields } from "../modules/utils.js";
import {
  Card as LegacyCard,
  Badge as LegacyBadge,
  EmptyState,
  Modal,
  ConfirmDialog,
  Spinner,
  ListItem as LegacyListItem,
  SaveDiscardBar,
} from "../components/shared.js";
import { SearchInput, SegmentedControl, Toggle } from "../components/forms.js";
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

/* ═══════════════════════════════════════════════════════════════
 *  Styles
 * ═══════════════════════════════════════════════════════════════ */

const LIBRARY_STYLES = `
/* ── Library Tab ────────────────────────────────────── */
.library-root { padding: 12px; max-width: none; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
.library-root .card { margin-bottom: 0; }
.library-header { display: flex; align-items: center; gap: 12px; margin: 0; flex-wrap: wrap; }
.library-header h2 { margin: 0; font-size: 1.2em; flex: 1; min-width: 120px; }

.library-toolbar { display: flex; gap: 8px; align-items: flex-start; flex-wrap: wrap; margin: 0; }
.library-toolbar .search-wrap { flex: 1; min-width: 200px; }

.library-type-pills { display: flex; gap: 6px; flex-wrap: wrap; }
.library-type-pill { padding: 4px 12px; border-radius: 14px; border: 1px solid var(--border, #333);
  background: transparent; color: var(--text-secondary, #aaa); cursor: pointer; font-size: 0.85em;
  transition: all 0.15s; white-space: nowrap; }
.library-type-pill:hover { border-color: var(--accent, #58a6ff); color: var(--text-primary, #eee); }
.library-type-pill.active { background: var(--accent, #58a6ff); color: #fff; border-color: var(--accent, #58a6ff); }

.library-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: 12px; }
.library-card { background: var(--bg-card, #1a1a2e); border: 1px solid var(--border, #333);
  border-radius: 12px; padding: 16px; padding-right: 96px; cursor: pointer; transition: all 0.15s; position: relative; }
.library-card:hover { border-color: var(--accent, #58a6ff); transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0,0,0,0.3); }

.library-card-header { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 8px; }
.library-card-icon { font-size: 1.4em; flex-shrink: 0; width: 32px; text-align: center; }
.library-card-icon svg { width: 20px; height: 20px; vertical-align: middle; }
.library-card-header > div { min-width: 0; flex: 1; }
.library-card-title { font-weight: 600; font-size: 0.95em; color: var(--text-primary, #eee);
  overflow-wrap: anywhere; word-break: break-word;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.library-card-desc { font-size: 0.82em; color: var(--text-secondary, #aaa); margin-bottom: 8px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.library-card-meta { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.library-card-tag { font-size: 0.75em; padding: 2px 8px; border-radius: 10px;
  background: var(--tag-bg, rgba(88,166,255,0.15)); color: var(--accent, #58a6ff); }
.library-card-scope { font-size: 0.72em; color: var(--text-tertiary, #777); margin-left: auto; }

.library-card-type { position: absolute; top: 8px; right: 8px; }

/* ─ Detail / Editor Modal ─ */
.library-editor { display: flex; flex-direction: column; gap: 14px; }
.library-editor label { display: flex; flex-direction: column; gap: 4px; font-size: 0.85em;
  color: var(--text-secondary, #aaa); }
.library-editor input, .library-editor select, .library-editor textarea {
  padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border, #333);
  background: var(--bg-input, #0d1117); color: var(--text-primary, #eee); font-size: 0.9em; }
.library-editor textarea { min-height: 160px; font-family: 'Fira Code', monospace; font-size: 0.82em;
  resize: vertical; }
.library-editor .tag-input-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.library-editor .tag-input-row input { flex: 1; min-width: 100px; }

.library-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
.library-actions button { padding: 8px 18px; border-radius: 8px; border: none; cursor: pointer;
  font-size: 0.9em; font-weight: 500; }
.library-actions .btn-primary { background: var(--accent, #58a6ff); color: #fff; }
.library-actions .btn-primary:hover { filter: brightness(1.1); }
.library-actions .btn-danger { background: #d73a49; color: #fff; }
.library-actions .btn-danger:hover { filter: brightness(1.1); }
.library-actions .btn-ghost { background: transparent; color: var(--text-secondary, #aaa);
  border: 1px solid var(--border, #333); }
.library-actions .btn-ghost:hover { border-color: var(--accent, #58a6ff); color: var(--text-primary, #eee); }

/* ─ Scope & Profile sections ─ */
.library-scopes { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.library-scope-chip { font-size: 0.8em; padding: 3px 10px; border-radius: 10px;
  background: rgba(88,166,255,0.1); color: var(--accent, #58a6ff); border: 1px solid transparent; }
.library-scope-chip.git { border-color: rgba(88,166,255,0.25); }
.library-scope-chip.folder { border-color: rgba(255,166,88,0.25); color: #ffa658; background: rgba(255,166,88,0.1); }
.library-scope-chip .count { font-weight: 600; margin-left: 4px; }

.library-profile-match { padding: 12px; background: var(--bg-card, #1a1a2e);
  border-radius: 10px; border: 1px solid var(--accent, #58a6ff); }
.library-profile-match-label { font-size: 0.8em; color: var(--text-secondary, #aaa); margin-bottom: 4px; }
.library-profile-match-name { font-weight: 600; color: var(--text-primary, #eee); }
.library-profile-match-score { font-size: 0.75em; color: var(--accent, #58a6ff); margin-left: 8px; }

/* ─ Stats bar ─ */
.library-stats { display: flex; gap: 16px; margin: 0; flex-wrap: wrap; }
.library-stat { text-align: center; }
.library-stat-val { font-size: 1.6em; font-weight: 700; color: var(--text-primary, #eee); }
.library-stat-lbl { font-size: 0.75em; color: var(--text-secondary, #aaa); text-transform: uppercase; letter-spacing: 0.05em; }

/* ─ Init banner ─ */
.library-init-banner { padding: 16px; border-radius: 12px; background: var(--bg-card, #1a1a2e);
  border: 1px dashed var(--border, #333); text-align: center; margin: 0; }
.library-init-banner p { color: var(--text-secondary, #aaa); margin: 8px 0; font-size: 0.9em; }
.library-init-banner button { padding: 8px 20px; border-radius: 8px; border: none;
  background: var(--accent, #58a6ff); color: #fff; cursor: pointer; font-weight: 600; }

/* ─ Responsive behavior ─ */
@media (min-width: 1000px) {
  .library-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}

@media (min-width: 1400px) {
  .library-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}

@media (max-width: 700px) {
  .library-root { padding: 8px; }
  .library-header { gap: 8px; }
  .library-toolbar { gap: 6px; }
  .library-toolbar .search-wrap { flex: 1 1 100%; min-width: 0; }
  .library-grid { grid-template-columns: 1fr; }
  .library-card { padding: 12px; padding-right: 84px; }
  .library-card-scope { margin-left: 0; }
  .library-actions { flex-wrap: wrap; justify-content: stretch; }
  .library-actions button { flex: 1 1 140px; padding: 10px 12px; }
}

@media (max-width: 520px) {
  .library-type-pills { gap: 4px; }
  .library-type-pill { font-size: 0.8em; padding: 4px 10px; }
  .library-stats { gap: 10px; }
  .library-stat { min-width: 64px; }
  .library-stat-val { font-size: 1.3em; }
}

/* ── MCP Marketplace ────────────────────────────────── */
.mcp-section { display: flex; flex-direction: column; gap: 12px; }
.mcp-section-header { display: flex; align-items: center; gap: 8px; }
.mcp-section-header h3 { margin: 0; font-size: 1em; flex: 1; }
.mcp-catalog-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 10px; }
.mcp-card { background: var(--bg-card, #1a1a2e); border: 1px solid var(--border, #333);
  border-radius: 10px; padding: 14px; display: flex; flex-direction: column; gap: 8px;
  transition: border-color 0.15s; }
.mcp-card:hover { border-color: var(--accent, #58a6ff); }
.mcp-card-header { display: flex; align-items: center; gap: 10px; }
.mcp-card-name { font-weight: 600; font-size: 0.92em; color: var(--text-primary, #eee); flex: 1; }
.mcp-card-desc { font-size: 0.8em; color: var(--text-secondary, #aaa); line-height: 1.4; }
.mcp-card-tags { display: flex; gap: 4px; flex-wrap: wrap; }
.mcp-card-tag { font-size: 0.72em; padding: 2px 7px; border-radius: 8px;
  background: rgba(88,166,255,0.1); color: var(--accent, #58a6ff); }
.mcp-card-actions { display: flex; gap: 6px; margin-top: auto; }
.mcp-card-actions button { padding: 5px 14px; border-radius: 7px; border: 1px solid var(--border, #333);
  background: transparent; color: var(--text-secondary, #aaa); cursor: pointer; font-size: 0.82em;
  transition: all 0.15s; }
.mcp-card-actions button:hover { border-color: var(--accent, #58a6ff); color: var(--text-primary, #eee); }
.mcp-card-actions .btn-install { background: var(--accent, #58a6ff); color: #fff; border-color: var(--accent, #58a6ff); }
.mcp-card-actions .btn-install:hover { filter: brightness(1.1); }
.mcp-card-actions .btn-installed { background: rgba(63,185,80,0.15); color: #3fb950; border-color: rgba(63,185,80,0.3); cursor: default; }
.mcp-card-actions .btn-uninstall { color: #d73a49; border-color: rgba(215,58,73,0.3); }
.mcp-card-actions .btn-uninstall:hover { background: rgba(215,58,73,0.1); }

.mcp-env-editor { display: flex; flex-direction: column; gap: 6px; margin-top: 8px;
  padding: 10px; background: var(--bg-input, #0d1117); border-radius: 8px; border: 1px solid var(--border, #333); }
.mcp-env-row { display: flex; gap: 6px; align-items: center; }
.mcp-env-key { font-size: 0.78em; font-family: monospace; color: var(--accent, #58a6ff); min-width: 140px; }
.mcp-env-input { flex: 1; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--border, #333);
  background: var(--bg-card, #1a1a2e); color: var(--text-primary, #eee); font-size: 0.82em; font-family: monospace; }

/* Custom MCP form */
.mcp-custom-form { display: flex; flex-direction: column; gap: 10px; padding: 14px;
  background: var(--bg-card, #1a1a2e); border: 1px solid var(--border, #333); border-radius: 10px; }
.mcp-custom-form label { display: flex; flex-direction: column; gap: 3px; font-size: 0.82em;
  color: var(--text-secondary, #aaa); }
.mcp-custom-form input, .mcp-custom-form select { padding: 6px 10px; border-radius: 7px;
  border: 1px solid var(--border, #333); background: var(--bg-input, #0d1117);
  color: var(--text-primary, #eee); font-size: 0.85em; }

/* ── Tool Configuration ────────────────────────────── */
.tool-config-section { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.tool-config-header { display: flex; align-items: center; gap: 8px; padding-bottom: 8px;
  border-bottom: 1px solid var(--border, #333); }
.tool-config-header h4 { margin: 0; font-size: 0.92em; flex: 1; color: var(--text-primary, #eee); }
.tool-config-group { display: flex; flex-direction: column; gap: 2px; }
.tool-config-group-label { font-size: 0.78em; color: var(--text-secondary, #aaa); text-transform: uppercase;
  letter-spacing: 0.04em; margin: 8px 0 4px; font-weight: 600; }
.tool-config-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px;
  border-radius: 8px; transition: background 0.1s; }
.tool-config-item:hover { background: rgba(255,255,255,0.03); }
.tool-config-item-icon { font-size: 1.1em; width: 24px; text-align: center; flex-shrink: 0; }
.tool-config-item-icon svg { width: 16px; height: 16px; vertical-align: middle; }
.tool-config-item-info { flex: 1; min-width: 0; }
.tool-config-item-name { font-size: 0.88em; font-weight: 500; color: var(--text-primary, #eee); }
.tool-config-item-desc { font-size: 0.76em; color: var(--text-secondary, #aaa); }
.tool-config-toggle { flex-shrink: 0; }

/* ── Agent Detail with Tools ──────────────────────── */
.agent-tools-section { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border, #333); }
.agent-tools-tabs { display: flex; gap: 6px; margin-bottom: 10px; }
.agent-tools-tab { padding: 5px 14px; border-radius: 14px; border: 1px solid var(--border, #333);
  background: transparent; color: var(--text-secondary, #aaa); cursor: pointer; font-size: 0.82em;
  transition: all 0.15s; }
.agent-tools-tab:hover { border-color: var(--accent, #58a6ff); }
.agent-tools-tab.active { background: var(--accent, #58a6ff); color: #fff; border-color: var(--accent, #58a6ff); }

@media (min-width: 1000px) {
  .mcp-catalog-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
`;

function normalizeLibraryTaskStatus(status) {
  return String(status || "").trim().toLowerCase();
}

export function isSelectableLibraryTask(task) {
  const status = normalizeLibraryTaskStatus(task?.status);
  return (
    status === "draft" ||
    status === "todo" ||
    status === "backlog" ||
    status === "planned" ||
    status === "open" ||
    status === "new" ||
    status === ""
  );
}

export function extractSelectableLibraryTasks(payload) {
  const tasks = Array.isArray(payload?.tasks)
    ? payload.tasks
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload)
        ? payload
        : [];
  return tasks.filter(isSelectableLibraryTask).slice(0, 100);
}

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  const style = document.createElement("style");
  style.textContent = LIBRARY_STYLES;
  document.head.appendChild(style);
  stylesInjected = true;
}

/* ═══════════════════════════════════════════════════════════════
 *  State signals
 * ═══════════════════════════════════════════════════════════════ */

const entries = signal([]);
const allEntries = signal([]);
const scopes = signal([]);
const isLoading = signal(false);
const initialized = signal(false);
const filterType = signal("all"); // "all" | "prompt" | "agent" | "skill" | "mcp"
const searchQuery = signal("");
const mcpCatalog = signal([]);
const mcpInstalled = signal([]);
const mcpCatalogLoaded = signal(false);

/* ═══════════════════════════════════════════════════════════════
 *  API Helpers
 * ═══════════════════════════════════════════════════════════════ */

async function fetchEntries(type) {
  const params = new URLSearchParams();
  if (type && type !== "all") params.set("type", type);
  const q = searchQuery.value?.trim();
  if (q) params.set("search", q);
  const qs = params.toString();
  const res = await apiFetch(`/api/library${qs ? `?${qs}` : ""}`);
  return res?.data || [];
}

async function fetchEntry(id, sourceScope = "") {
  const params = new URLSearchParams({ id: String(id || "") });
  const normalizedScope = String(sourceScope || "").trim().toLowerCase();
  if (normalizedScope) params.set("source", normalizedScope);
  const res = await apiFetch(`/api/library/entry?${params.toString()}`);
  return res?.data || null;
}

async function saveEntry(data) {
  const res = await apiFetch("/api/library/entry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return res;
}

async function removeEntry(id, deleteFile = false, sourceScope = "") {
  const normalizedScope = String(sourceScope || "").trim().toLowerCase();
  return apiFetch("/api/library/entry", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id,
      deleteFile,
      ...(normalizedScope ? { source: normalizedScope } : {}),
    }),
  });
}

async function fetchScopes() {
  const res = await apiFetch("/api/library/scopes");
  return res?.data || [];
}

async function doInit() {
  const res = await apiFetch("/api/library/init", { method: "POST" });
  return res;
}

async function doRebuild() {
  return apiFetch("/api/library/rebuild", { method: "POST" });
}

async function testProfileMatch(criteria = {}) {
  const res = await apiFetch(`/api/library/resolve?verbose=1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(criteria || {}),
  });
  return res?.data || { best: null, candidates: [], plan: null, auto: { shouldAutoApply: false } };
}

async function fetchLibrarySources(options = {}) {
  const params = new URLSearchParams();
  if (options?.probe) params.set("probe", "1");
  if (options?.refresh) params.set("refresh", "1");
  if (options?.sourceId) params.set("sourceId", String(options.sourceId));
  const qs = params.toString();
  const path = qs ? "/api/library/sources?" + qs : "/api/library/sources";
  const res = await apiFetch(path);
  return res?.data || [];
}

async function previewLibrarySource(payload = {}) {
  return apiFetch("/api/library/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
}

async function importLibrarySource(payload = {}) {
  return apiFetch("/api/library/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
}

/* ── MCP API Helpers ─ */

async function fetchMcpCatalog() {
  const res = await apiFetch("/api/mcp/catalog");
  return res?.data || [];
}

async function fetchMcpInstalled() {
  const res = await apiFetch("/api/mcp/installed");
  return res?.data || [];
}

async function installMcp(idOrDef, envOverrides) {
  const body = typeof idOrDef === "string"
    ? { id: idOrDef, envOverrides }
    : { serverDef: idOrDef, envOverrides };
  return apiFetch("/api/mcp/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function uninstallMcp(id) {
  return apiFetch("/api/mcp/uninstall", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
}

async function configureMcpEnv(id, env) {
  return apiFetch("/api/mcp/configure", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, env }),
  });
}

/* ── Agent Tool Config API Helpers ─ */

async function fetchAvailableTools() {
  const res = await apiFetch("/api/agent-tools/available");
  return res?.data || { builtinTools: [], bosunTools: [], mcpServers: [] };
}

async function fetchAgentToolConfig(agentId) {
  const res = await apiFetch(`/api/agent-tools/config?agentId=${encodeURIComponent(agentId)}`);
  return res?.data || { builtinTools: [], bosunTools: [], mcpServers: [], enabledTools: null };
}

async function saveAgentToolConfig(agentId, config) {
  return apiFetch("/api/agent-tools/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, ...config }),
  });
}

async function fetchBuiltinToolDefaults() {
  const res = await apiFetch("/api/agent-tools/defaults");
  return res?.data?.builtinTools || [];
}

/* ═══════════════════════════════════════════════════════════════
 *  Icons per type
 * ═══════════════════════════════════════════════════════════════ */

const TYPE_ICONS = { prompt: ":edit:", agent: ":bot:", skill: ":cpu:", mcp: ":plug:" };
const TYPE_LABELS = { prompt: "Prompt", agent: "Agent Profile", skill: "Skill", mcp: "MCP Server" };
const TYPE_COLORS = { prompt: "#58a6ff", agent: "#af7bff", skill: "#3fb950", mcp: "#f59e0b" };
const STORAGE_SCOPE_LABELS = { repo: "Repo", workspace: "Workspace", global: "Global" };
const STORAGE_SCOPE_COLORS = { repo: "info", workspace: "warning", global: "default" };
const AGENT_CATEGORY_OPTIONS = Object.freeze([
  { value: "task", label: "Task Template" },
  { value: "interactive", label: "Manual Chat Agent" },
  { value: "voice", label: "Voice Agent" },
]);
const INTERACTIVE_MODE_OPTIONS = Object.freeze([
  { value: "ask", label: "Ask" },
  { value: "agent", label: "Agent" },
  { value: "plan", label: "Plan" },
  { value: "web", label: "Web" },
  { value: "instant", label: "Instant" },
  { value: "custom", label: "Custom" },
]);

function normalizeAgentCategory(rawCategory) {
  const value = String(rawCategory || "").trim().toLowerCase();
  if (value === "voice" || value === "task" || value === "interactive") return value;
  return "task";
}

function normalizeInteractiveMode(rawMode, agentCategory = "task") {
  const value = String(rawMode || "").trim().toLowerCase();
  if (["ask", "agent", "plan", "web", "instant", "custom"].includes(value)) return value;
  if (agentCategory === "interactive") return "agent";
  if (agentCategory === "voice") return "voice";
  return "";
}

function deriveAgentTypeFromCategory(agentCategory) {
  if (agentCategory === "voice") return "voice";
  if (agentCategory === "interactive") return "chat";
  return "task";
}

/** Normalize tags to an array regardless of input type (string, array, null). */
function normalizeTags(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") return raw.split(/[,\s]+/).map(t => t.trim()).filter(Boolean);
  return [];
}

function normalizeStorageScope(rawScope, fallback = "repo") {
  const value = String(rawScope || "").trim().toLowerCase();
  if (value === "repo" || value === "workspace" || value === "global") return value;
  return fallback;
}

function inferAgentCategoryFromEntry(entry, parsedContent) {
  const explicitCategory = normalizeAgentCategory(parsedContent?.agentCategory || entry?.agentCategory);
  if (parsedContent?.agentCategory || entry?.agentCategory) return explicitCategory;
  const explicitType = String(parsedContent?.agentType || entry?.agentType || "").trim().toLowerCase();
  if (explicitType === "chat") return "interactive";
  if (explicitType === "voice") return "voice";
  if (parsedContent?.voiceAgent === true) return "voice";
  const id = String(entry?.id || "").trim().toLowerCase();
  const tags = Array.isArray(entry?.tags)
    ? entry.tags.map((tag) => String(tag || "").trim().toLowerCase())
    : [];
  if (id.startsWith("voice-agent")) return "voice";
  if (tags.includes("voice") || tags.includes("audio-agent") || tags.includes("realtime")) return "voice";
  return "task";
}

function inferInteractiveModeFromEntry(entry, parsedContent) {
  const category = inferAgentCategoryFromEntry(entry, parsedContent);
  return normalizeInteractiveMode(parsedContent?.interactiveMode || entry?.interactiveMode, category);
}

function inferInteractiveLabelFromEntry(entry, parsedContent) {
  return String(parsedContent?.interactiveLabel || entry?.interactiveLabel || "").trim();
}

function inferShowInChatDropdown(entry, parsedContent) {
  const explicit = parsedContent?.showInChatDropdown;
  if (typeof explicit === "boolean") return explicit;
  return entry?.showInChatDropdown === true;
}

const AUDIO_AGENT_TEMPLATES = Object.freeze({
  female: {
    type: "agent",
    name: "Voice Agent (Female)",
    description: "Conversational voice specialist with concise guidance and call-friendly pacing.",
    tags: "voice,audio-agent,female,realtime",
    storageScope: "global",
    scope: "global",
    content: JSON.stringify({
      name: "Voice Agent (Female)",
      description: "Conversational voice specialist with concise guidance and call-friendly pacing.",
      titlePatterns: ["\\bvoice\\b", "\\bcall\\b", "\\bmeeting\\b", "\\bassistant\\b"],
      scopes: ["voice", "assistant"],
      model: null,
      promptOverride: null,
      skills: ["concise-voice-guidance", "conversation-memory"],
      agentType: "voice",
      agentCategory: "voice",
      interactiveMode: "voice",
      voiceAgent: true,
      voicePersona: "female",
      voiceInstructions: "You are Nova, a female voice agent. Be concise, warm, and practical. Use tools for facts and execution. Keep spoken responses short and clear.",
    }, null, 2),
  },
  male: {
    type: "agent",
    name: "Voice Agent (Male)",
    description: "Operational voice specialist focused on diagnostics and execution.",
    tags: "voice,audio-agent,male,realtime",
    storageScope: "global",
    scope: "global",
    content: JSON.stringify({
      name: "Voice Agent (Male)",
      description: "Operational voice specialist focused on diagnostics and execution.",
      titlePatterns: ["\\bvoice\\b", "\\bcall\\b", "\\bmeeting\\b", "\\bassistant\\b"],
      scopes: ["voice", "assistant"],
      model: null,
      promptOverride: null,
      skills: ["ops-diagnostics", "task-execution"],
      agentType: "voice",
      agentCategory: "voice",
      interactiveMode: "voice",
      voiceAgent: true,
      voicePersona: "male",
      voiceInstructions: "You are Atlas, a male voice agent. Be direct and execution-oriented. Prefer actionable status updates. Use tools proactively for diagnostics.",
    }, null, 2),
  },
});

/* ═══════════════════════════════════════════════════════════════
 *  Sub-components
 * ═══════════════════════════════════════════════════════════════ */

function LibraryStats() {
  const all = allEntries.value;
  const counts = { prompt: 0, agent: 0, skill: 0, mcp: 0 };
  for (const e of all) { if (counts[e.type] !== undefined) counts[e.type]++; }
  return html`
    <${Stack} direction="row" spacing=${2} flexWrap="wrap">
      <${Paper} variant="outlined" sx=${{ p: 1.5, textAlign: "center", minWidth: 70 }}>
        <${Typography} variant="h5" fontWeight=${700}>${all.length}<//>
        <${Typography} variant="caption" color="text.secondary" sx=${{ textTransform: "uppercase", letterSpacing: 0.5 }}>Total<//>
      <//>
      <${Paper} variant="outlined" sx=${{ p: 1.5, textAlign: "center", minWidth: 70 }}>
        <${Typography} variant="h5" fontWeight=${700} sx=${{ color: TYPE_COLORS.prompt }}>${counts.prompt}<//>
        <${Typography} variant="caption" color="text.secondary">${iconText(`${TYPE_ICONS.prompt} Prompts`)}<//>
      <//>
      <${Paper} variant="outlined" sx=${{ p: 1.5, textAlign: "center", minWidth: 70 }}>
        <${Typography} variant="h5" fontWeight=${700} sx=${{ color: TYPE_COLORS.agent }}>${counts.agent}<//>
        <${Typography} variant="caption" color="text.secondary">${iconText(`${TYPE_ICONS.agent} Agents`)}<//>
      <//>
      <${Paper} variant="outlined" sx=${{ p: 1.5, textAlign: "center", minWidth: 70 }}>
        <${Typography} variant="h5" fontWeight=${700} sx=${{ color: TYPE_COLORS.skill }}>${counts.skill}<//>
        <${Typography} variant="caption" color="text.secondary">${iconText(`${TYPE_ICONS.skill} Skills`)}<//>
      <//>
      <${Paper} variant="outlined" sx=${{ p: 1.5, textAlign: "center", minWidth: 70 }}>
        <${Typography} variant="h5" fontWeight=${700} sx=${{ color: TYPE_COLORS.mcp }}>${counts.mcp}<//>
        <${Typography} variant="caption" color="text.secondary">${iconText(`${TYPE_ICONS.mcp} MCP`)}<//>
      <//>
    <//>
  `;
}

function TypePills() {
  const types = [
    { id: "all", label: "All" },
    { id: "prompt", label: `${TYPE_ICONS.prompt} Prompts` },
    { id: "agent", label: `${TYPE_ICONS.agent} Agents` },
    { id: "skill", label: `${TYPE_ICONS.skill} Skills` },
    { id: "mcp", label: `${TYPE_ICONS.mcp} MCP Servers` },
  ];
  return html`
    <${Stack} direction="row" spacing=${0.75} flexWrap="wrap">
      ${types.map((t) => html`
        <${Chip} key=${t.id}
          label=${iconText(t.label)}
          variant=${filterType.value === t.id ? "filled" : "outlined"}
          color=${filterType.value === t.id ? "primary" : "default"}
          onClick=${() => { filterType.value = t.id; }}
          clickable
          size="small"
        />
      `)}
    <//>
  `;
}

function LibraryCard({ entry, onSelect }) {
  const icon = TYPE_ICONS[entry.type] || ":file:";
  const typeLabel = TYPE_LABELS[entry.type] || entry.type;
  const typeColor = TYPE_COLORS[entry.type] || "#aaa";
  return html`
    <${Card} variant="outlined" sx=${{ cursor: "pointer", transition: "all 0.15s", "&:hover": { borderColor: "primary.main", transform: "translateY(-1px)", boxShadow: 3 }, position: "relative", bgcolor: "background.paper" }} onClick=${() => onSelect(entry)}>
      <${CardContent}>
        <${Box} sx=${{ position: "absolute", top: 8, right: 8 }}>
          <${Chip} label=${typeLabel} size="small" sx=${{ bgcolor: typeColor + "22", color: typeColor, fontWeight: 500 }} />
        <//>
        <${Stack} direction="row" spacing=${1} alignItems="flex-start" sx=${{ mb: 1 }}>
          <${Box} sx=${{ fontSize: "1.4em", width: 32, textAlign: "center", flexShrink: 0 }}>${resolveIcon(icon) || icon}<//>
          <${Typography} fontWeight=${600} variant="body2" sx=${{ WebkitLineClamp: 2, WebkitBoxOrient: "vertical", display: "-webkit-box", overflow: "hidden" }}>${entry.name}<//>
        <//>
        ${entry.description && html`
          <${Typography} variant="body2" color="text.secondary" sx=${{ mb: 1, WebkitLineClamp: 2, WebkitBoxOrient: "vertical", display: "-webkit-box", overflow: "hidden", fontSize: "0.82em" }}>${entry.description}<//>
        `}
        <${Stack} direction="row" spacing=${0.5} flexWrap="wrap" alignItems="center">
          <${Chip}
            label=${STORAGE_SCOPE_LABELS[normalizeStorageScope(entry.storageScope, "repo")] || "Repo"}
            size="small"
            variant="outlined"
            color=${STORAGE_SCOPE_COLORS[normalizeStorageScope(entry.storageScope, "repo")] || "default"}
            sx=${{ fontSize: "0.74em" }}
          />
          ${entry.type === "agent" && entry.agentType && html`
            <${Chip} label=${String(entry.agentCategory || entry.agentType).replace(/(^.|\s+.)/g, (m) => m.toUpperCase())} size="small" variant="outlined" sx=${{ fontSize: "0.75em" }} />
          `}
          ${entry.type === "agent" && entry.agentCategory === "interactive" && (entry.interactiveLabel || entry.interactiveMode) && html`
            <${Chip} label=${entry.interactiveLabel || String(entry.interactiveMode || "").toUpperCase()} size="small" variant="outlined" sx=${{ fontSize: "0.75em" }} />
          `}
          ${(entry.tags || []).slice(0, 5).map((tag) => html`
            <${Chip} key=${tag} label=${tag} size="small" sx=${{ fontSize: "0.75em", bgcolor: "primary.main", color: "#fff", opacity: 0.8 }} />
          `)}
          ${entry.scope && entry.scope !== "global" && html`
            <${Typography} variant="caption" color="text.secondary" sx=${{ ml: "auto !important" }}>${iconText(`:pin: ${entry.scope}`)}<//>
          `}
        <//>
      <//>
    <//>
  `;
}

/* ─ Entry Editor / Detail Modal ──────────────────────────── */

function EntryEditor({ entry, onClose, onSaved, onDeleted }) {
  const isNew = !entry?.id;
  const initialFormSnapshot = {
    id: entry?.id || "",
    type: entry?.type || "prompt",
    name: entry?.name || "",
    description: entry?.description || "",
    tags: normalizeTags(entry?.tags).join(", "),
    scope: entry?.scope || "global",
    storageScope: normalizeStorageScope(entry?.storageScope, "repo"),
    agentCategory: inferAgentCategoryFromEntry(entry, null),
    interactiveMode: inferInteractiveModeFromEntry(entry, null),
    interactiveLabel: inferInteractiveLabelFromEntry(entry, null),
    showInChatDropdown: inferShowInChatDropdown(entry, null),
    content: typeof entry?.content === "string" ? entry.content : "",
  };
  const [form, setForm] = useState(initialFormSnapshot);
  const [baseline, setBaseline] = useState(initialFormSnapshot);
  const [loading, setLoading] = useState(false);
  const [importAgents, setImportAgents] = useState(false);
  const [importSkills, setImportSkills] = useState(true);
  const [importPrompts, setImportPrompts] = useState(false);
  const [importTools, setImportTools] = useState(true);
  const [loadingContent, setLoadingContent] = useState(!isNew && !!entry?.id);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pendingKey = useMemo(
    () => `modal:library-entry:${entry?.id || "new"}`,
    [entry?.id],
  );

  useEffect(() => {
    const next = {
      id: entry?.id || "",
      type: entry?.type || "prompt",
      name: entry?.name || "",
      description: entry?.description || "",
      tags: normalizeTags(entry?.tags).join(", "),
      scope: entry?.scope || "global",
      storageScope: normalizeStorageScope(entry?.storageScope, "repo"),
      agentCategory: inferAgentCategoryFromEntry(entry, null),
      interactiveMode: inferInteractiveModeFromEntry(entry, null),
      interactiveLabel: inferInteractiveLabelFromEntry(entry, null),
      showInChatDropdown: inferShowInChatDropdown(entry, null),
      content: "",
    };
    setForm(next);
    setBaseline(next);
    setLoadingContent(!isNew && !!entry?.id);
  }, [entry?.id]);

  // Load content for existing entries
  useEffect(() => {
    if (isNew || !entry?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const detail = await fetchEntry(entry.id, entry.storageScope);
        if (cancelled) return;
        let contentStr = detail?.content ?? "";
        if (typeof contentStr === "object") contentStr = JSON.stringify(contentStr, null, 2);
        const parsed = detail?.content && typeof detail.content === "object" ? detail.content : null;
        setForm((f) => {
          const next = {
            ...f,
            content: contentStr,
            storageScope: normalizeStorageScope(detail?.storageScope || f.storageScope, "repo"),
            agentCategory: inferAgentCategoryFromEntry(detail || entry, parsed),
            interactiveMode: inferInteractiveModeFromEntry(detail || entry, parsed),
            interactiveLabel: inferInteractiveLabelFromEntry(detail || entry, parsed),
            showInChatDropdown: inferShowInChatDropdown(detail || entry, parsed),
          };
          setBaseline(next);
          return next;
        });
      } catch { /* ignore */ }
      setLoadingContent(false);
    })();
    return () => { cancelled = true; };
  }, [entry?.id]);

  const updateField = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const changeCount = useMemo(
    () => countChangedFields(baseline, form),
    [baseline, form],
  );
  const hasUnsaved = changeCount > 0;

  useEffect(() => {
    setPendingChange(pendingKey, hasUnsaved);
    return () => clearPendingChange(pendingKey);
  }, [hasUnsaved, pendingKey]);

  const resetToBaseline = useCallback(() => {
    setForm(baseline);
    showToast("Changes discarded", "info");
  }, [baseline]);

  const handleSave = useCallback(async ({ closeAfterSave = true } = {}) => {
    if (!form.name.trim()) {
      showToast("Name is required", "error");
      return false;
    }
    setLoading(true);
    try {
      const tags = form.tags.split(/[,\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
      let content = form.content;
      if (form.type === "agent") {
        try {
          content = JSON.parse(content);
        } catch {
          showToast("Agent profile content must be valid JSON", "error");
          return false;
        }
        const agentCategory = normalizeAgentCategory(form.agentCategory);
        const agentType = deriveAgentTypeFromCategory(agentCategory);
        content.agentType = agentType;
        content.agentCategory = agentCategory;
        if (agentCategory === "voice") {
          content.voiceAgent = true;
          content.interactiveMode = "voice";
          delete content.showInChatDropdown;
        } else if (content.voiceAgent === true) {
          content.voiceAgent = false;
        }
        if (agentCategory === "interactive") {
          const interactiveMode = normalizeInteractiveMode(form.interactiveMode, agentCategory);
          content.interactiveMode = interactiveMode || "agent";
          if (String(form.interactiveLabel || "").trim()) content.interactiveLabel = String(form.interactiveLabel || "").trim();
          else delete content.interactiveLabel;
          content.showInChatDropdown = form.showInChatDropdown === true;
        } else {
          delete content.interactiveLabel;
          if (agentCategory !== "voice") delete content.interactiveMode;
          delete content.showInChatDropdown;
        }
      }
      const res = await saveEntry({
        id: form.id || undefined,
        type: form.type,
        name: form.name.trim(),
        description: form.description.trim(),
        tags,
        scope: form.scope,
        storageScope: normalizeStorageScope(form.storageScope, "repo"),
        content,
      });
      if (res?.ok) {
        showToast(`${TYPE_LABELS[form.type] || "Entry"} saved`, "success");
        const nextBaseline = { ...form };
        setBaseline(nextBaseline);
        if (closeAfterSave) {
          onSaved?.();
          return { closed: true };
        }
        return true;
      } else {
        showToast(res?.error || "Save failed", "error");
        return false;
      }
    } catch (err) {
      showToast(err.message, "error");
      return false;
    } finally {
      setLoading(false);
    }
  }, [form, onSaved]);

  const handleDelete = useCallback(async () => {
    setLoading(true);
    try {
      const res = await removeEntry(
        entry.id,
        true,
        normalizeStorageScope(form.storageScope || entry?.storageScope, "repo"),
      );
      if (res?.ok) {
        showToast("Deleted", "success");
        onDeleted?.();
      } else {
        showToast(res?.error || "Delete failed", "error");
      }
    } catch (err) {
      showToast(err.message, "error");
    }
    setLoading(false);
  }, [entry?.id, entry?.storageScope, form.storageScope, onDeleted]);

  const contentPlaceholder = form.type === "prompt"
    ? "# Prompt Title\n\nYour prompt content here...\n\nUse {{VARIABLE_NAME}} for template variables."
    : form.type === "agent"
      ? JSON.stringify({
          name: "My Agent",
          description: "Agent description",
          titlePatterns: ["\\\\(scope\\\\)"],
          scopes: ["scope"],
          sdk: null,
          model: null,
          promptOverride: null,
          skills: [],
          agentType: "task",
          agentCategory: "task",
          tags: [],
        }, null, 2)
      : "# Skill Title\n\n## Purpose\nDescribe what this skill teaches agents.\n\n## Instructions\n...";

  return html`
    <${Modal}
      title=${isNew ? "New Resource" : `Edit: ${entry.name}`}
      onClose=${onClose}
      unsavedChanges=${changeCount}
      onSaveBeforeClose=${() => handleSave({ closeAfterSave: true })}
      onDiscardBeforeClose=${() => {
        resetToBaseline();
        return true;
      }}
      activeOperationLabel=${loading ? "Save/Delete request is still running" : ""}
    >
      <${Stack} spacing=${2}>
        ${isNew && html`
          <${FormControl} fullWidth size="small">
            <${InputLabel}>Type<//>
            <${Select} value=${form.type} onChange=${updateField("type")} label="Type">
              <${MenuItem} value="prompt">Prompt<//>
              <${MenuItem} value="agent">Agent Profile<//>
              <${MenuItem} value="skill">Skill<//>
              <${MenuItem} value="mcp">MCP Server<//>
            <//>
          <//>
        `}
        <${TextField} size="small" fullWidth label="Name" value=${form.name} onInput=${updateField("name")} placeholder="e.g. Task Executor, UI Agent, Background Tasks" />
        <${TextField} size="small" fullWidth label="Description" value=${form.description} onInput=${updateField("description")} placeholder="Brief one-line summary" />
        <${TextField} size="small" fullWidth label="Tags (comma-separated)" value=${form.tags} onInput=${updateField("tags")} placeholder="e.g. frontend, ui, react" />
        <${FormControl} fullWidth size="small">
          <${InputLabel}>Storage Location<//>
          <${Select} value=${normalizeStorageScope(form.storageScope, "repo")} onChange=${updateField("storageScope")} label="Storage Location">
            <${MenuItem} value="repo">Repo<//>
            <${MenuItem} value="workspace">Workspace<//>
            <${MenuItem} value="global">Global<//>
          <//>
        <//>
        <${FormControl} fullWidth size="small">
          <${InputLabel}>Scope<//>
          <${Select} value=${form.scope} onChange=${updateField("scope")} label="Scope">
            <${MenuItem} value="global">Global<//>
            <${MenuItem} value="workspace">Workspace<//>
          <//>
        <//>
        ${form.type === "agent" && html`
          <${FormControl} fullWidth size="small">
            <${InputLabel}>Agent Category<//>
            <${Select} value=${normalizeAgentCategory(form.agentCategory)} onChange=${updateField("agentCategory")} label="Agent Category">
              ${AGENT_CATEGORY_OPTIONS.map((opt) => html`<${MenuItem} key=${opt.value} value=${opt.value}>${opt.label}<//>`)}
            <//>
          <//>
        `}
        ${form.type === "agent" && normalizeAgentCategory(form.agentCategory) === "interactive" && html`
          <${FormControl} fullWidth size="small">
            <${InputLabel}>Manual Agent Type<//>
            <${Select} value=${normalizeInteractiveMode(form.interactiveMode, form.agentCategory)} onChange=${updateField("interactiveMode")} label="Manual Agent Type">
              ${INTERACTIVE_MODE_OPTIONS.map((opt) => html`<${MenuItem} key=${opt.value} value=${opt.value}>${opt.label}<//>`)}
            <//>
          <//>
          <${TextField} size="small" fullWidth label="Type Label / Section" value=${form.interactiveLabel} onInput=${updateField("interactiveLabel")} placeholder="Optional custom group label, e.g. Research or Reviewer" />
          <${FormControlLabel}
            control=${html`<${Switch} checked=${form.showInChatDropdown === true} onChange=${(e) => setForm((f) => ({ ...f, showInChatDropdown: e.target.checked }))} />`}
            label="Show in chat dropdown"
          />
        `}
        <${Box}>
          <${Typography} variant="caption" color="text.secondary" sx=${{ mb: 0.5, display: "block" }}>Content<//>
          ${loadingContent
            ? html`<${Box} sx=${{ textAlign: "center", py: 3 }}><${CircularProgress} size=${20} /> <${Typography} variant="caption">Loading content...<//><//>`
            : html`<${TextField} fullWidth multiline rows=${12} value=${form.content} onInput=${updateField("content")} placeholder=${contentPlaceholder} size="small" InputProps=${{ sx: { fontFamily: "'Fira Code', monospace", fontSize: "0.82em" } }} />`
          }
        <//>
        <${Typography} variant="caption" color="text.secondary" sx=${{ mt: -1 }}>
          ${form.type === "prompt" ? "Use {{VARIABLE_NAME}} for template variables. Reference in workflows as {{prompt:name}}."
          : form.type === "agent" ? "JSON format. Task templates stay in workflow resolution; interactive profiles can also appear in the chat dropdown."
            : form.type === "mcp" ? "MCP server configuration. Managed via the MCP Servers panel."
            : "Markdown format. Referenced in workflows as {{skill:name}}."}
        <//>

        ${/* ── Agent Tool Configuration Section ── */
          !isNew && form.type === "agent" && entry?.id && html`
            <${AgentToolConfigurator} agentId=${entry.id} agentName=${entry.name || form.name} />
          `
        }

        <${Stack} direction="row" spacing=${1} justifyContent="flex-end" sx=${{ mt: 1 }}>
          ${!isNew && html`
            <${Button} color="error" onClick=${() => setConfirmDelete(true)} disabled=${loading}>Delete<//>
          `}
          <${Box} sx=${{ flex: 1 }} />
          <${Button} variant="outlined" onClick=${onClose}>Cancel<//>
          <${Button}
            variant="contained"
            onClick=${() => { void handleSave({ closeAfterSave: true }); }}
            disabled=${loading}
            startIcon=${loading ? html`<${CircularProgress} size=${14} />` : null}
          >
            ${isNew ? "Create" : "Save"}
          <//>
        <//>
        <${SaveDiscardBar}
          dirty=${hasUnsaved}
          message=${`You have unsaved changes (${changeCount})`}
          saveLabel=${isNew ? "Create" : "Save Changes"}
          discardLabel="Discard"
          onSave=${() => { void handleSave({ closeAfterSave: false }); }}
          onDiscard=${resetToBaseline}
          saving=${loading}
        />
      <//>
      ${confirmDelete && html`
        <${ConfirmDialog}
          title="Delete resource?"
          message=${`This will delete "${entry.name}" from the library and remove the file from disk.`}
          onConfirm=${handleDelete}
          onCancel=${() => setConfirmDelete(false)} />
      `}
    <//>
  `;
}

/* ─ Agent Tool Configurator ─────────────────────────────── */

function AgentToolConfigurator({ agentId, agentName }) {
  const [toolsTab, setToolsTab] = useState("builtin"); // "builtin" | "bosun" | "mcp"
  const [tools, setTools] = useState({ builtinTools: [], bosunTools: [], mcpServers: [], enabledTools: null });
  const [installed, setInstalled] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const [effective, inst] = await Promise.all([
        fetchAgentToolConfig(agentId),
        fetchMcpInstalled(),
      ]);
      setTools(effective);
      setInstalled(inst);
    } catch (err) {
      showToast("Failed to load tool config: " + err.message, "error");
    }
    setLoading(false);
  }, [agentId]);

  useEffect(() => { loadConfig(); }, [agentId]);

  const toggleBuiltinTool = useCallback(async (toolId, enabled) => {
    const current = tools.builtinTools || [];
    const disabledList = current.filter((t) => !t.enabled).map((t) => t.id);
    const newDisabled = enabled
      ? disabledList.filter((id) => id !== toolId)
      : [...disabledList, toolId];
    const currentEnabledTools = Array.isArray(tools.enabledTools)
      ? tools.enabledTools.map((id) => String(id || "").trim()).filter(Boolean)
      : null;
    const nextEnabledTools = currentEnabledTools
      ? (() => {
        const set = new Set(currentEnabledTools);
        if (enabled) set.add(toolId);
        else set.delete(toolId);
        return [...set];
      })()
      : undefined;
    setSaving(true);
    try {
      await saveAgentToolConfig(agentId, {
        disabledBuiltinTools: newDisabled,
        ...(nextEnabledTools !== undefined ? { enabledTools: nextEnabledTools } : {}),
      });
      setTools((prev) => ({
        ...prev,
        ...(nextEnabledTools !== undefined ? { enabledTools: nextEnabledTools } : {}),
        builtinTools: prev.builtinTools.map((t) =>
          t.id === toolId ? { ...t, enabled } : t
        ),
      }));
    } catch (err) {
      showToast("Failed to save: " + err.message, "error");
    }
    setSaving(false);
  }, [agentId, tools]);

  const toggleBosunTool = useCallback(async (toolId, enabled) => {
    const bosunIds = (tools.bosunTools || []).map((tool) => String(tool?.id || "").trim()).filter(Boolean);
    const bosunIdSet = new Set(bosunIds);
    const currentEnabledTools = Array.isArray(tools.enabledTools)
      ? tools.enabledTools.map((id) => String(id || "").trim()).filter(Boolean)
      : [];
    const currentSet = new Set(currentEnabledTools);
    const hasBosunAllowlist = bosunIds.some((id) => currentSet.has(id));
    const nextBosunSet = hasBosunAllowlist
      ? new Set(currentEnabledTools.filter((id) => bosunIdSet.has(id)))
      : new Set(bosunIds);
    if (enabled) nextBosunSet.add(toolId);
    else nextBosunSet.delete(toolId);
    const preserved = currentEnabledTools.filter((id) => !bosunIdSet.has(id));
    const nextEnabledTools = [...new Set([...preserved, ...nextBosunSet])];
    setSaving(true);
    try {
      await saveAgentToolConfig(agentId, { enabledTools: nextEnabledTools });
      setTools((prev) => ({
        ...prev,
        enabledTools: nextEnabledTools,
      }));
    } catch (err) {
      showToast("Failed to save: " + err.message, "error");
    }
    setSaving(false);
  }, [agentId, tools]);

  const toggleMcpServer = useCallback(async (serverId, enabled) => {
    const currentMcp = tools.mcpServers || [];
    const newMcp = enabled
      ? [...new Set([...currentMcp, serverId])]
      : currentMcp.filter((id) => id !== serverId);
    setSaving(true);
    try {
      await saveAgentToolConfig(agentId, { enabledMcpServers: newMcp });
      setTools((prev) => ({ ...prev, mcpServers: newMcp }));
    } catch (err) {
      showToast("Failed to save: " + err.message, "error");
    }
    setSaving(false);
  }, [agentId, tools]);

  const enabledMcpSet = new Set(tools.mcpServers || []);
  const bosunTools = Array.isArray(tools.bosunTools) ? tools.bosunTools : [];
  const bosunToolIds = bosunTools.map((tool) => String(tool?.id || "").trim()).filter(Boolean);
  const rawEnabledTools = Array.isArray(tools.enabledTools)
    ? tools.enabledTools.map((id) => String(id || "").trim()).filter(Boolean)
    : null;
  const hasBosunAllowlist = Boolean(rawEnabledTools && rawEnabledTools.some((id) => bosunToolIds.includes(id)));
  const enabledBosunSet = new Set(
    hasBosunAllowlist
      ? rawEnabledTools.filter((id) => bosunToolIds.includes(id))
      : bosunToolIds,
  );

  if (loading) {
    return html`<${Box} sx=${{ textAlign: "center", py: 2 }}>
      <${CircularProgress} size=${16} /> <${Typography} variant="caption" sx=${{ ml: 1 }}>Loading tools...<//>
    <//>`;
  }

  return html`
    <${Box} sx=${{ mt: 2, pt: 2, borderTop: 1, borderColor: "divider" }}>
      <${Stack} direction="row" alignItems="center" spacing=${1} sx=${{ mb: 1 }}>
        <${Typography} variant="subtitle2">${iconText(":settings: Tools & MCP Servers")}<//>
        ${saving && html`<${CircularProgress} size=${12} />`}
      <//>

      <${Tabs} value=${toolsTab} onChange=${(e, v) => setToolsTab(v)} variant="scrollable" scrollButtons="auto" sx=${{ mb: 1 }}>
        <${Tab} value="builtin" label=${html`<${Stack} direction="row" spacing=${0.5} alignItems="center">
          <span>${iconText(":cpu: Built-in")}</span>
          <${Chip} label=${`${(tools.builtinTools || []).filter((t) => t.enabled).length}/${(tools.builtinTools || []).length}`} size="small" />
        <//>`} />
        <${Tab} value="bosun" label=${html`<${Stack} direction="row" spacing=${0.5} alignItems="center">
          <span>${iconText(":zap: Bosun")}</span>
          <${Chip} label=${`${enabledBosunSet.size}/${bosunTools.length}`} size="small" />
        <//>`} />
        <${Tab} value="mcp" label=${html`<${Stack} direction="row" spacing=${0.5} alignItems="center">
          <span>${iconText(":plug: MCP")}</span>
          <${Chip} label=${`${enabledMcpSet.size}/${installed.length}`} size="small" />
        <//>`} />
      <//>

      ${toolsTab === "builtin" && html`
        <${List} dense>
          ${(tools.builtinTools || []).map((tool) => html`
            <${ListItem} key=${tool.id}>
              <${ListItemIcon} sx=${{ minWidth: 36 }}>${resolveIcon(tool.icon) || iconText(tool.icon || ":cpu:")}<//>
              <${ListItemText} primary=${tool.name} secondary=${tool.description} primaryTypographyProps=${{ variant: "body2", fontWeight: 500 }} secondaryTypographyProps=${{ variant: "caption" }} />
              <${Switch}
                edge="end"
                size="small"
                checked=${tool.enabled}
                onChange=${(e) => toggleBuiltinTool(tool.id, e.target.checked)}
              />
            <//>
          `)}
        <//>
      `}

      ${toolsTab === "bosun" && html`
        <${Accordion} defaultExpanded>
          <${AccordionSummary}>
            <${Typography} variant="caption" sx=${{ textTransform: "uppercase", fontWeight: 600, letterSpacing: 0.5 }}>Runtime Voice Tools<//>
          <//>
          <${AccordionDetails}>
            ${bosunTools.length === 0 && html`
              <${Typography} variant="body2" color="text.secondary" sx=${{ textAlign: "center", py: 1.5 }}>
                No Bosun runtime tools were discovered.
              <//>
            `}
            <${List} dense>
              ${bosunTools.map((tool) => html`
                <${ListItem} key=${tool.id}>
                  <${ListItemIcon} sx=${{ minWidth: 36 }}>${resolveIcon(":zap:") || iconText(":zap:")}<//>
                  <${ListItemText} primary=${tool.name} secondary=${tool.description || "Bosun runtime tool"} primaryTypographyProps=${{ variant: "body2", fontWeight: 500 }} secondaryTypographyProps=${{ variant: "caption" }} />
                  <${Switch}
                    edge="end"
                    size="small"
                    checked=${enabledBosunSet.has(tool.id)}
                    onChange=${(e) => toggleBosunTool(tool.id, e.target.checked)}
                  />
                <//>
              `)}
            <//>
          <//>
        <//>
      `}

      ${toolsTab === "mcp" && html`
        <${List} dense>
          ${installed.length === 0 && html`
            <${Typography} variant="body2" color="text.secondary" sx=${{ textAlign: "center", py: 1.5 }}>
              No MCP servers installed. Use the MCP Servers tab to install from the marketplace.
            <//>
          `}
          ${installed.map((srv) => html`
            <${ListItem} key=${srv.id}>
              <${ListItemIcon} sx=${{ minWidth: 36 }}>${resolveIcon(":plug:") || iconText(":plug:")}<//>
              <${ListItemText} primary=${srv.name} secondary=${srv.description || `Transport: ${srv.meta?.transport || "stdio"}`} primaryTypographyProps=${{ variant: "body2", fontWeight: 500 }} secondaryTypographyProps=${{ variant: "caption" }} />
              <${Switch}
                edge="end"
                size="small"
                checked=${enabledMcpSet.has(srv.id)}
                onChange=${(e) => toggleMcpServer(srv.id, e.target.checked)}
              />
            <//>
          `)}
        <//>
      `}
    <//>
  `;
}

/* ─ MCP Marketplace / Catalog ─────────────────────────────── */

function McpMarketplace({ onInstalled }) {
  const [catalog, setCatalog] = useState([]);
  const [installed, setInstalled] = useState([]);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(null);
  const [uninstalling, setUninstalling] = useState(null);
  const [configuring, setConfiguring] = useState(null);
  const [envEdits, setEnvEdits] = useState({});
  const [showCustom, setShowCustom] = useState(false);
  const [marketplaceSearch, setMarketplaceSearch] = useState("");

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [cat, inst] = await Promise.all([
        fetchMcpCatalog(),
        fetchMcpInstalled(),
      ]);
      setCatalog(cat);
      setInstalled(inst);
      mcpCatalog.value = cat;
      mcpInstalled.value = inst;
    } catch (err) {
      showToast("Failed to load MCP data: " + err.message, "error");
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, []);

  const installedIds = new Set(installed.map((s) => s.id));

  const handleInstall = useCallback(async (catalogId) => {
    setInstalling(catalogId);
    try {
      const envVars = envEdits[catalogId] || {};
      const res = await installMcp(catalogId, envVars);
      if (res?.ok) {
        showToast(`Installed ${catalogId}`, "success");
        await loadData();
        onInstalled?.();
      } else {
        showToast(res?.error || "Install failed", "error");
      }
    } catch (err) {
      showToast("Install failed: " + err.message, "error");
    }
    setInstalling(null);
  }, [envEdits, loadData, onInstalled]);

  const handleUninstall = useCallback(async (id) => {
    setUninstalling(id);
    try {
      const res = await uninstallMcp(id);
      if (res?.ok) {
        showToast(`Uninstalled ${id}`, "success");
        await loadData();
        onInstalled?.();
      } else {
        showToast(res?.error || "Uninstall failed", "error");
      }
    } catch (err) {
      showToast("Uninstall failed: " + err.message, "error");
    }
    setUninstalling(null);
  }, [loadData, onInstalled]);

  const handleConfigure = useCallback(async (id) => {
    const env = envEdits[id] || {};
    try {
      const res = await configureMcpEnv(id, env);
      if (res?.ok) {
        showToast(`Updated ${id} configuration`, "success");
        setConfiguring(null);
      } else {
        showToast(res?.error || "Update failed", "error");
      }
    } catch (err) {
      showToast("Update failed: " + err.message, "error");
    }
  }, [envEdits]);

  const handleCustomInstall = useCallback(async (def) => {
    setInstalling("custom");
    try {
      const res = await installMcp(def);
      if (res?.ok) {
        showToast(`Installed custom MCP server: ${def.name}`, "success");
        setShowCustom(false);
        await loadData();
        onInstalled?.();
      } else {
        showToast(res?.error || "Install failed", "error");
      }
    } catch (err) {
      showToast("Install failed: " + err.message, "error");
    }
    setInstalling(null);
  }, [loadData, onInstalled]);

  const updateEnv = useCallback((serverId, key, value) => {
    setEnvEdits((prev) => ({
      ...prev,
      [serverId]: { ...(prev[serverId] || {}), [key]: value },
    }));
  }, []);

  const filteredCatalog = useMemo(() => {
    if (!marketplaceSearch.trim()) return catalog;
    const q = marketplaceSearch.toLowerCase();
    return catalog.filter(
      (s) => s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        (s.tags || []).some((t) => t.toLowerCase().includes(q)),
    );
  }, [catalog, marketplaceSearch]);

  if (loading) {
    return html`<div style="text-align:center;padding:40px;"><${Spinner} /> Loading MCP marketplace...</div>`;
  }

  return html`
    <div class="mcp-section">
      <!-- Installed section -->
      ${installed.length > 0 && html`
        <div class="mcp-section-header">
          <h3>${iconText(":check: Installed")} (${installed.length})</h3>
        </div>
        <div class="mcp-catalog-grid">
          ${installed.map((srv) => html`
            <div class="mcp-card" key=${srv.id}>
              <div class="mcp-card-header">
                <span class="mcp-card-name">${srv.name}</span>
                <${Badge} text="Installed" status="success" />
              </div>
              <div class="mcp-card-desc">${srv.description}</div>
              <div class="mcp-card-tags">
                ${(srv.tags || []).map((t) => html`<span class="mcp-card-tag" key=${t}>${t}</span>`)}
              </div>
              <div class="mcp-card-actions">
                <${Button} variant="outlined" color="error" size="small"
                  onClick=${() => handleUninstall(srv.id)}
                  disabled=${uninstalling === srv.id}>
                  ${uninstalling === srv.id ? html`<${Spinner} size=${12} />` : "Uninstall"}
                <//>
                <${Button} variant="outlined" size="small" onClick=${() => setConfiguring(configuring === srv.id ? null : srv.id)}>
                  ${iconText(":settings: Configure")}
                <//>
              </div>
              ${configuring === srv.id && html`
                <div class="mcp-env-editor">
                  <div style="font-size:0.78em;color:var(--text-secondary);margin-bottom:4px;">
                    Environment Variables
                  </div>
                  ${Object.entries(srv.meta?.env || {}).map(([key, val]) => html`
                    <div class="mcp-env-row" key=${key}>
                      <span class="mcp-env-key">${key}</span>
                      <${TextField} size="small" variant="outlined"
                        type=${key.toLowerCase().includes("key") || key.toLowerCase().includes("token") || key.toLowerCase().includes("secret") ? "password" : "text"}
                        value=${envEdits[srv.id]?.[key] ?? val}
                        placeholder="Enter value..."
                        onInput=${(e) => updateEnv(srv.id, key, e.target.value)} />
                    </div>
                  `)}
                  ${Object.keys(srv.meta?.env || {}).length === 0 && html`
                    <div style="font-size:0.82em;color:var(--text-tertiary,#666);">No environment variables required.</div>
                  `}
                  <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:6px;">
                    <${Button} variant="text" size="small" onClick=${() => setConfiguring(null)}>Cancel<//>
                    <${Button} variant="contained" size="small" onClick=${() => handleConfigure(srv.id)}>
                      ${iconText(":check: Save")}
                    <//>
                  </div>
                </div>
              `}
            </div>
          `)}
        </div>
      `}

      <!-- Marketplace Catalog -->
      <div class="mcp-section-header">
        <h3>${iconText(":shopping: MCP Marketplace")}</h3>
        <${Button} variant="outlined" size="small" onClick=${() => setShowCustom(!showCustom)}>
          ${iconText("➕ Custom Server")}
        <//>
      </div>

      <div style="margin-bottom:8px;">
        <${SearchInput}
          value=${marketplaceSearch}
          onInput=${(e) => setMarketplaceSearch(e.target.value)}
          placeholder="Search marketplace (GitHub, Playwright, Exa, etc.)..." />
      </div>

      ${showCustom && html`
        <${McpCustomInstallForm} onInstall=${handleCustomInstall} installing=${installing === "custom"} />
      `}

      <div class="mcp-catalog-grid">
        ${filteredCatalog.map((srv) => {
          const isInstalled = installedIds.has(srv.id);
          const hasEnv = srv.env && Object.keys(srv.env).length > 0;
          const isInstalling = installing === srv.id;
          return html`
            <div class="mcp-card" key=${srv.id}>
              <div class="mcp-card-header">
                <span class="mcp-card-name">${srv.name}</span>
                ${isInstalled && html`<${Badge} text="Installed" status="success" />`}
              </div>
              <div class="mcp-card-desc">${srv.description}</div>
              <div class="mcp-card-tags">
                ${(srv.tags || []).map((t) => html`<span class="mcp-card-tag" key=${t}>${t}</span>`)}
                <span class="mcp-card-tag" style="background:rgba(255,255,255,0.05);color:var(--text-tertiary,#666);">
                  ${srv.transport}
                </span>
              </div>
              ${hasEnv && !isInstalled && html`
                <div class="mcp-env-editor">
                  ${Object.entries(srv.env).map(([key, val]) => html`
                    <div class="mcp-env-row" key=${key}>
                      <span class="mcp-env-key">${key}</span>
                      <${TextField} size="small" variant="outlined"
                        type=${key.toLowerCase().includes("key") || key.toLowerCase().includes("token") || key.toLowerCase().includes("secret") ? "password" : "text"}
                        value=${envEdits[srv.id]?.[key] ?? ""}
                        placeholder=${val || "Enter value..."}
                        onInput=${(e) => updateEnv(srv.id, key, e.target.value)} />
                    </div>
                  `)}
                </div>
              `}
              ${srv.homepage && html`
                <div style="font-size:0.75em;">
                  <a href=${srv.homepage} target="_blank" rel="noopener"
                    style="color:var(--accent,#58a6ff);text-decoration:none;">
                    ${iconText(":link: Documentation")}
                  </a>
                </div>
              `}
              <div class="mcp-card-actions">
                ${isInstalled
                  ? html`<${Button} variant="outlined" size="small" disabled>✓ Installed<//>`
                  : html`
                    <${Button} variant="contained" size="small"
                      onClick=${() => handleInstall(srv.id)}
                      disabled=${isInstalling}>
                      ${isInstalling ? html`<${Spinner} size=${12} />` : iconText(":download: Install")}
                    <//>
                  `
                }
              </div>
            </div>
          `;
        })}
      </div>

      ${filteredCatalog.length === 0 && html`
        <div style="text-align:center;padding:20px;color:var(--text-secondary);font-size:0.9em;">
          ${marketplaceSearch ? "No MCP servers match your search." : "No catalog entries available."}
        </div>
      `}
    </div>
  `;
}

/* ─ Custom MCP Install Form ───────────────────────────────── */

function McpCustomInstallForm({ onInstall, installing }) {
  const [form, setForm] = useState({
    name: "",
    description: "",
    transport: "stdio",
    command: "npx",
    args: "",
    url: "",
    tags: "",
    envKeys: "",
  });

  const updateField = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleSubmit = useCallback(() => {
    if (!form.name.trim()) {
      showToast("Server name is required", "error");
      return;
    }
    const def = {
      name: form.name.trim(),
      description: form.description.trim(),
      transport: form.transport,
      tags: form.tags.split(/[,\s]+/).filter(Boolean),
    };
    if (form.transport === "stdio") {
      def.command = form.command.trim() || "npx";
      def.args = form.args.split(/\s+/).filter(Boolean);
    } else {
      def.url = form.url.trim();
    }
    // Parse env keys
    if (form.envKeys.trim()) {
      def.env = {};
      for (const key of form.envKeys.split(/[,\s]+/).filter(Boolean)) {
        def.env[key] = "";
      }
    }
    onInstall(def);
  }, [form, onInstall]);

  return html`
    <div class="mcp-custom-form">
      <div style="font-size:0.88em;font-weight:600;color:var(--text-primary);">
        ${iconText("➕ Install Custom MCP Server")}
      </div>
      <label>
        Name *
        <${TextField} size="small" variant="outlined" value=${form.name} onInput=${updateField("name")}
          placeholder="e.g. My Custom Server" fullWidth />
      </label>
      <label>
        Description
        <${TextField} size="small" variant="outlined" value=${form.description} onInput=${updateField("description")}
          placeholder="Brief description" fullWidth />
      </label>
      <label>
        Transport
        <${Select} size="small" value=${form.transport} onChange=${updateField("transport")}>
          <${MenuItem} value="stdio">stdio (command + args)<//>
          <${MenuItem} value="url">URL (HTTP/SSE endpoint)<//>
        <//>
      </label>
      ${form.transport === "stdio" && html`
        <label>
          Command
          <${TextField} size="small" variant="outlined" value=${form.command} onInput=${updateField("command")}
            placeholder="npx" fullWidth />
        </label>
        <label>
          Arguments (space-separated)
          <${TextField} size="small" variant="outlined" value=${form.args} onInput=${updateField("args")}
            placeholder="-y @scope/mcp-server" fullWidth />
        </label>
      `}
      ${form.transport === "url" && html`
        <label>
          URL
          <${TextField} size="small" variant="outlined" value=${form.url} onInput=${updateField("url")}
            placeholder="https://example.com/mcp" fullWidth />
        </label>
      `}
      <label>
        Tags (comma-separated)
        <${TextField} size="small" variant="outlined" value=${form.tags} onInput=${updateField("tags")}
          placeholder="custom, tools" fullWidth />
      </label>
      <label>
        Environment Variable Keys (comma-separated, values set after install)
        <${TextField} size="small" variant="outlined" value=${form.envKeys} onInput=${updateField("envKeys")}
          placeholder="API_KEY, SECRET_TOKEN" fullWidth />
      </label>
      <div class="library-actions">
        <${Button} variant="contained" size="small" onClick=${handleSubmit} disabled=${installing}>
          ${installing ? html`<${Spinner} size=${14} />` : iconText(":download: Install")}
        <//>
      </div>
    </div>
  `;
}

/* ─ Scope Detector Panel ─────────────────────────────────── */

function ScopeDetector() {
  const [showing, setShowing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [importAgents, setImportAgents] = useState(true);
  const [importSkills, setImportSkills] = useState(true);
  const [importPrompts, setImportPrompts] = useState(true);
  const [importTools, setImportTools] = useState(true);

  const loadScopes = useCallback(async () => {
    if (scopes.value.length && showing) { setShowing(false); return; }
    setLoading(true);
    try {
      if (!importAgents && !importPrompts && !importSkills && !importTools) {
        throw new Error("Select at least one import type");
      }
      const result = await fetchScopes();
      scopes.value = result;
    } catch (err) {
      showToast("Failed to detect scopes: " + err.message, "error");
    }
    setLoading(false);
    setShowing(true);
  }, [showing]);

  return html`
    <div>
      <${Button} variant="text" size="small" onClick=${loadScopes} sx=${{ fontSize: "0.82em" }}>
        ${loading ? html`<${Spinner} size=${12} />` : iconText(":search: Detect Scopes")}
      <//>
      ${showing && scopes.value.length > 0 && html`
        <div class="library-scopes">
          ${scopes.value.map((s) => html`
            <span key=${s.name}
              class=${`library-scope-chip ${s.source.startsWith("git") ? "git" : "folder"}`}>
              ${s.name}
              ${s.count > 0 && html`<span class="count">(${s.count})</span>`}
            </span>
          `)}
        </div>
      `}
      ${showing && scopes.value.length === 0 && html`
        <div style="font-size:0.82em;color:var(--text-secondary);margin-top:8px;">
          No scopes detected. Add conventional commit scopes to your git history.
        </div>
      `}
    </div>
  `;
}

/* ─ Workflow Step Resolver ─────────────────────────────────── */

async function resolveWorkflowSteps(title, description) {
  const steps = ["tdd", "implementation", "review"];
  const results = {};
  for (const step of steps) {
    const stepTitle = `${step}: ${title}`;
    try {
      const resp = await testProfileMatch({ title: stepTitle, description, topN: 1 });
      results[step] = resp;
    } catch {
      results[step] = { best: null, candidates: [], plan: null };
    }
  }
  return results;
}

/* ─ Score Breakdown Definitions ────────────────────────────── */

const SIGNAL_DEFS = [
  { key: "titlePattern", label: "Title Pattern", max: 10, color: "#3b82f6" },
  { key: "scope", label: "Scope", max: 6, color: "#22c55e" },
  { key: "tags", label: "Tags", max: 6, color: "#eab308" },
  { key: "voice", label: "Voice", max: 3, color: "#a855f7" },
  { key: "paths", label: "Paths", max: 8, color: "#f97316" },
  { key: "repoCtx", label: "Repo Ctx", max: 6, color: "#14b8a6" },
  { key: "fileType", label: "File Type", max: 4, color: "#ec4899" },
  { key: "descMatch", label: "Desc Match", max: 8, color: "#06b6d4" },
  { key: "taskType", label: "Task Type", max: 5, color: "#6366f1" },
];

const MAX_SCORE_TOTAL = SIGNAL_DEFS.reduce((sum, s) => sum + s.max, 0);

/* ─ Profile Matcher Panel ─────────────────────────────────── */

function ProfileMatcher() {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [changedFiles, setChangedFiles] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [importAgents, setImportAgents] = useState(true);
  const [importSkills, setImportSkills] = useState(true);
  const [importPrompts, setImportPrompts] = useState(true);
  const [importTools, setImportTools] = useState(true);
  const [expandedAlts, setExpandedAlts] = useState({});
  const [workflowSteps, setWorkflowSteps] = useState(null);
  const [workflowLoading, setWorkflowLoading] = useState(false);

  // ── Execution Plan state ──────────────────────────────────────────────
  const [execPlan, setExecPlan] = useState(null);
  const [execPlanLoading, setExecPlanLoading] = useState(false);
  const [dryRunLoading, setDryRunLoading] = useState(false);
  const [dryRunResults, setDryRunResults] = useState(null);
  const [expandedStages, setExpandedStages] = useState({});
  const [expandedNodes, setExpandedNodes] = useState({});
  const [taskList, setTaskList] = useState([]);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [taskListLoading, setTaskListLoading] = useState(false);

  // Load task list for dropdown
  useEffect(() => {
    setTaskListLoading(true);
    const wsParam = typeof window !== "undefined" && window.__bosunWorkspaceId ? `&workspace=${encodeURIComponent(window.__bosunWorkspaceId)}` : "";
    fetch(`/api/tasks?pageSize=100&status=library${wsParam}`)
      .then((r) => r.json())
      .then((data) => {
        setTaskList(extractSelectableLibraryTasks(data));
      })
      .catch(() => {})
      .finally(() => setTaskListLoading(false));
  }, []);

  // When a task is selected from dropdown, populate title/description
  const handleTaskSelect = useCallback((e) => {
    const id = e.currentTarget.value;
    setSelectedTaskId(id);
    if (id) {
      const t = taskList.find((t) => t.id === id);
      if (t) {
        setTitle(t.title || "");
        setDescription(t.description || "");
      }
    }
  }, [taskList]);

  const doMatch = useCallback(async () => {
    if (!title.trim() && !description.trim()) return;
    setLoading(true);
    try {
      if (!importAgents && !importPrompts && !importSkills && !importTools) {
        throw new Error("Select at least one import type");
      }
      const response = await testProfileMatch({
        title: title.trim(),
        description: description.trim(),
        changedFiles: changedFiles.split(",").map((v) => v.trim()).filter(Boolean),
        topN: 5,
      });
      setResult(response || null);
    } catch (err) {
      showToast(`Profile match failed: ${err.message}`, "error");
    }
    setLoading(false);
  }, [title, description, changedFiles]);

  // ── Execution plan resolver ─────────────────────────────────────────
  const fetchExecPlan = useCallback(async (mode = "resolve") => {
    const taskId = selectedTaskId;
    if (!taskId && !title.trim()) return;
    if (mode === "resolve") { setExecPlan(null); setExecPlanLoading(true); setDryRunResults(null); }
    else { setDryRunLoading(true); }
    try {
      const wsParam = typeof window !== "undefined" && window.__bosunWorkspaceId ? `&workspace=${encodeURIComponent(window.__bosunWorkspaceId)}` : "";
      let url;
      if (taskId) {
        url = `/api/tasks/execution-plan?taskId=${encodeURIComponent(taskId)}${wsParam}&mode=${mode}`;
      } else {
        url = `/api/tasks/execution-plan?title=${encodeURIComponent(title.trim())}&description=${encodeURIComponent(description.trim())}${wsParam}&mode=${mode}`;
      }
      const resp = await fetch(url).then((r) => r.json());
      if (resp?.ok) {
        setExecPlan(resp);
        if (mode === "dry-run") setDryRunResults(resp.dryRunResults || null);
      } else {
        showToast(`Execution plan failed: ${resp?.error || "Unknown error"}`, "error");
      }
    } catch (err) {
      showToast(`Execution plan failed: ${err.message}`, "error");
    }
    setExecPlanLoading(false);
    setDryRunLoading(false);
  }, [selectedTaskId, title, description]);

  const toggleStageExpand = useCallback((si) => {
    setExpandedStages((prev) => ({ ...prev, [si]: prev[si] === false ? true : prev[si] ? false : false }));
  }, []);
  const toggleNodeExpand = useCallback((si, nid) => {
    setExpandedNodes((prev) => ({ ...prev, [`${si}-${nid}`]: !prev[`${si}-${nid}`] }));
  }, []);

  const best = result?.best || null;
  const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
  const plan = result?.plan || null;
  const auto = result?.auto || { shouldAutoApply: false, reason: "no-match" };

  return html`
    <div>
      ${/* ── Task Selector ── */ ""}
      <label style="display:block;font-size:0.82em;color:var(--text-secondary);margin-bottom:4px;">Select Existing Task (or type manually below)</label>
      <select value=${selectedTaskId} onChange=${handleTaskSelect}
        style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--border,#333);background:var(--bg-input,#0d1117);color:var(--text-primary,#eee);margin-bottom:8px;">
        <option value="">— ${taskListLoading ? "Loading tasks…" : `${taskList.length} tasks available`} —</option>
        ${taskList.map((t) => html`
          <option key=${t.id} value=${t.id}>${t.title || t.id}${t.status ? ` [${t.status}]` : ""}</option>
        `)}
      </select>

      <label style="display:block;font-size:0.82em;color:var(--text-secondary);">Task Title</label>
      <input type="text" value=${title} onInput=${(e) => setTitle(e.currentTarget.value)}
        placeholder="feat(ui): improve onboarding flow"
        style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--border,#333);background:var(--bg-input,#0d1117);color:var(--text-primary,#eee);" />
      <label style="display:block;font-size:0.82em;color:var(--text-secondary);margin-top:8px;">Task Description (optional)</label>
      <textarea value=${description} onInput=${(e) => setDescription(e.currentTarget.value)}
        placeholder="Short summary to improve matching confidence"
        style="width:100%;min-height:68px;padding:8px;border-radius:8px;border:1px solid var(--border,#333);background:var(--bg-input,#0d1117);color:var(--text-primary,#eee);resize:vertical;"></textarea>
      <label style="display:block;font-size:0.82em;color:var(--text-secondary);margin-top:8px;">Changed Paths (optional, comma-separated)</label>
      <input type="text" value=${changedFiles} onInput=${(e) => setChangedFiles(e.currentTarget.value)}
        placeholder="ui/tabs/library.js, server/ui-server.mjs"
        style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--border,#333);background:var(--bg-input,#0d1117);color:var(--text-primary,#eee);" />
      <div class="library-actions" style="display:flex;gap:8px;flex-wrap:wrap;">
        <${Button} variant="outlined" size="small" onClick=${doMatch} disabled=${loading || (!title.trim() && !description.trim())}>
          ${loading ? html`<${Spinner} size=${14} />` : iconText(":mag: Resolve Plan")}
        <//>
        <${Button} variant="outlined" size="small" onClick=${() => fetchExecPlan("resolve")} disabled=${execPlanLoading || (!selectedTaskId && !title.trim())}>
          ${execPlanLoading ? html`<${Spinner} size=${14} />` : html`${resolveIcon("play")} Execution Plan`}
        <//>
        <${Button} variant="outlined" size="small" onClick=${() => fetchExecPlan("dry-run")} disabled=${dryRunLoading || (!selectedTaskId && !title.trim())}>
          ${dryRunLoading ? html`<${Spinner} size=${14} />` : html`${resolveIcon("play")} Dry Run`}
        <//>
      </div>

      ${/* ── Library Profile Match Results (Rich Visualization) ── */ ""}
      ${best && html`
        <div class="library-profile-match" style="margin-top:12px;padding:12px;border:1px solid var(--border,#333);border-radius:10px;background:var(--bg-card,rgba(255,255,255,0.03));">
          ${/* ── Header with name, score, confidence ── */ ""}
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span style="font-weight:600;font-size:0.95em;">${iconText(`${TYPE_ICONS.agent} ${best.name}`)}</span>
            <${Chip} size="small" label=${`Score: ${best.score}/${MAX_SCORE_TOTAL}`} color="primary" variant="outlined" />
            <${Chip} size="small" label=${`${Math.round(Number(best.confidence || 0) * 100)}% confidence`}
              color=${Number(best.confidence || 0) >= 0.45 ? "success" : "warning"} variant="outlined" />
          </div>
          ${best.description && html`<div style="font-size:0.82em;color:var(--text-secondary);margin-top:6px;">${best.description}</div>`}

          ${/* ── Auto-trigger status ── */ ""}
          <div style="display:flex;align-items:center;gap:6px;margin-top:8px;padding:6px 10px;border-radius:8px;background:${auto.shouldAutoApply ? "rgba(34,197,94,0.1)" : Number(best.confidence || 0) >= 0.35 ? "rgba(245,158,11,0.1)" : "rgba(239,68,68,0.1)"};">
            <span style="font-size:1.1em;">${auto.shouldAutoApply ? "✅" : Number(best.confidence || 0) >= 0.35 ? "⚠️" : "❌"}</span>
            <span style="font-size:0.82em;font-weight:500;color:${auto.shouldAutoApply ? "#22c55e" : Number(best.confidence || 0) >= 0.35 ? "#f59e0b" : "#ef4444"};">
              Auto-trigger: ${auto.shouldAutoApply ? "Eligible" : "Not eligible"}
            </span>
            <span style="font-size:0.75em;color:var(--text-secondary);">(${auto.reason || "n/a"})</span>
          </div>

          ${/* ── Score Breakdown Bar ── */ ""}
          <div style="margin-top:10px;">
            <div style="font-size:0.78em;font-weight:600;color:var(--text-secondary);margin-bottom:4px;">Score Breakdown</div>
            <div style="display:flex;height:22px;border-radius:6px;overflow:hidden;background:rgba(255,255,255,0.05);border:1px solid var(--border,#333);">
              ${SIGNAL_DEFS.map((sig) => {
                const val = Number(best.breakdown?.[sig.key] || 0);
                const pct = (sig.max / MAX_SCORE_TOTAL) * 100;
                return html`
                  <${Tooltip} title=${`${sig.label}: ${val}/${sig.max}`} key=${sig.key}>
                    <div style="width:${pct}%;height:100%;position:relative;border-right:1px solid rgba(0,0,0,0.2);">
                      <div style="position:absolute;bottom:0;left:0;right:0;height:${sig.max > 0 ? (val / sig.max) * 100 : 0}%;background:${sig.color};opacity:0.85;transition:height 0.3s;"></div>
                      <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:0.6em;color:#fff;white-space:nowrap;text-shadow:0 1px 2px rgba(0,0,0,0.6);z-index:1;">${val > 0 ? val : ""}</div>
                    </div>
                  <//>
                `;
              })}
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;">
              ${SIGNAL_DEFS.map((sig) => {
                const val = Number(best.breakdown?.[sig.key] || 0);
                return html`<span key=${sig.key} style="font-size:0.65em;display:flex;align-items:center;gap:3px;color:var(--text-secondary);">
                  <span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${sig.color};opacity:${val > 0 ? 1 : 0.3};"></span>
                  ${sig.label}
                </span>`;
              })}
            </div>
          </div>

          ${/* ── Detected Task Types ── */ ""}
          ${result?.context?.detectedTaskTypes?.length > 0 && html`
            <div style="margin-top:8px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
              <span style="font-size:0.78em;color:var(--text-secondary);font-weight:500;">Detected:</span>
              ${result.context.detectedTaskTypes.map((t) => html`
                <${Chip} key=${t} size="small" label=${t} variant="outlined"
                  style=${{ fontSize: "0.72em", height: "20px" }} />
              `)}
            </div>
          `}

          ${/* ── Skills Preview ── */ ""}
          ${plan && html`
            <div style="margin-top:10px;padding:8px 10px;border:1px solid var(--border,#333);border-radius:8px;background:rgba(255,255,255,0.02);">
              <div style="font-size:0.8em;font-weight:600;margin-bottom:4px;">📚 Skills (${(plan.skillIds || []).length} resolved)</div>
              ${(plan.skillIds || []).length > 0 ? (plan.skillIds || []).map((s) => html`
                <div key=${s} style="font-size:0.78em;color:var(--text-secondary);padding:2px 0;">  ✓ ${s} (profile-skill)</div>
              `) : html`<div style="font-size:0.78em;color:var(--text-secondary);">  No skills resolved</div>`}
              <div style="font-size:0.78em;color:var(--text-secondary);margin-top:4px;">
                Prompt: ${plan.prompt?.name || "none"} · Tools: ${(plan.builtinToolIds || []).slice(0, 6).join(", ") || "none"} · MCP: ${(plan.enabledMcpServers || []).slice(0, 4).join(", ") || "none"}
              </div>
            </div>
          `}

          ${/* ── Workflow Step Preview ── */ ""}
          <div style="margin-top:10px;">
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="font-size:0.8em;font-weight:600;">Workflow Steps</span>
              <${Button} variant="text" size="small" onClick=${async () => {
                if (!title.trim()) return;
                setWorkflowLoading(true);
                try {
                  const steps = await resolveWorkflowSteps(title.trim(), description.trim());
                  setWorkflowSteps(steps);
                } catch { setWorkflowSteps(null); }
                setWorkflowLoading(false);
              }} disabled=${workflowLoading || !title.trim()}
                style=${{ fontSize: "0.72em", minWidth: 0, padding: "2px 8px" }}>
                ${workflowLoading ? html`<${Spinner} size=${12} />` : "Resolve"}
              <//>
            </div>
            ${workflowSteps && html`
              <div style="margin-top:4px;padding:8px 10px;border-left:3px solid var(--border,#555);font-size:0.78em;font-family:monospace;">
                ${Object.entries(workflowSteps).map(([step, stepResult], i, arr) => {
                  const connector = i === 0 ? "┌" : i === arr.length - 1 ? "└" : "├";
                  const stepBest = stepResult?.best;
                  const stepPlan = stepResult?.plan;
                  const skills = stepPlan?.skillIds?.slice(0, 3)?.join(", ") || "none";
                  return html`<div key=${step} style="color:var(--text-secondary);padding:1px 0;">
                    ${connector} <span style="text-transform:capitalize;font-weight:500;color:var(--text-primary);">${step}</span> → ${stepBest?.name || "No match"} + [${skills}]
                  </div>`;
                })}
              </div>
            `}
          </div>

          ${/* ── Alternatives as expandable cards ── */ ""}
          ${candidates.length > 1 && html`
            <div style="margin-top:10px;">
              <div style="font-size:0.8em;font-weight:600;color:var(--text-secondary);margin-bottom:6px;">Alternatives (${candidates.length - 1})</div>
              ${candidates.slice(1).map((c, i) => html`
                <div key=${c.id || i} style="margin-bottom:6px;border:1px solid var(--border,#333);border-radius:8px;overflow:hidden;background:rgba(255,255,255,0.02);">
                  <div onClick=${() => setExpandedAlts((prev) => ({ ...prev, [i]: !prev[i] }))}
                    style="display:flex;align-items:center;gap:8px;padding:6px 10px;cursor:pointer;user-select:none;">
                    <span style="font-size:0.82em;font-weight:500;flex:1;">${iconText(`${TYPE_ICONS.agent} ${c.name}`)}</span>
                    <div style="width:60px;height:6px;border-radius:3px;background:rgba(255,255,255,0.08);overflow:hidden;">
                      <div style="height:100%;width:${Math.round(Number(c.confidence || 0) * 100)}%;background:#3b82f6;border-radius:3px;"></div>
                    </div>
                    <span style="font-size:0.72em;color:var(--text-secondary);min-width:40px;text-align:right;">${c.score}pts</span>
                    <span style="font-size:0.7em;transform:${expandedAlts[i] ? "rotate(180deg)" : "none"};transition:transform 0.2s;">▼</span>
                  </div>
                  ${expandedAlts[i] && html`
                    <div style="padding:6px 10px 8px;border-top:1px solid var(--border,#333);font-size:0.78em;color:var(--text-secondary);">
                      <div>Confidence: ${Math.round(Number(c.confidence || 0) * 100)}%</div>
                      ${c.description && html`<div style="margin-top:2px;">${c.description}</div>`}
                      ${Array.isArray(c.reasons) && c.reasons.length > 0 && html`
                        <div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:4px;">
                          ${c.reasons.map((r) => html`<${Chip} key=${r} size="small" label=${r} variant="outlined" style=${{ fontSize: "0.68em", height: "18px" }} />`)}
                        </div>
                      `}
                    </div>
                  `}
                </div>
              `)}
            </div>
          `}
        </div>
      `}
      ${!best && result && html`
        <div style="font-size:0.82em;color:var(--text-secondary);margin-top:8px;">
          No matching agent profile. Import or create one to improve routing coverage.
        </div>
      `}

      ${/* ── Execution Plan Visualization ── */ ""}
      ${execPlan && html`
        <div style="margin-top:16px;border-top:1px solid var(--border,#333);padding-top:12px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
            <strong style="font-size:0.9em;">${resolveIcon("play")} Execution Plan</strong>
            <span style="font-size:0.75em;opacity:0.6;">${execPlan.stageCount || 0} workflows · ${execPlan.agentRunTotal || 0} agent runs</span>
            ${execPlan.mode === "dry-run" && html`<span style="font-size:0.75em;color:#10b981;font-weight:600;">✓ Dry-run complete</span>`}
            ${execPlan.validationIssues?.length > 0 && html`
              <span style="background:#ef444430;color:#f87171;padding:1px 6px;border-radius:3px;font-size:0.7em;font-weight:600;">
                ${execPlan.validationIssues.filter((v) => v.level === "error").length} errors
              </span>
            `}
          </div>

          ${/* ── Validation Issues ── */ ""}
          ${execPlan.validationIssues?.length > 0 && html`
            <div style="margin-bottom:10px;border:1px solid #ef444440;border-radius:6px;padding:8px;background:#ef444410;">
              <div style="font-weight:600;font-size:0.8em;color:#f87171;margin-bottom:4px;">${resolveIcon("warning")} Validation Issues</div>
              ${execPlan.validationIssues.map((issue, ii) => html`
                <div key=${`vi-${ii}`} style="font-size:0.75em;padding:2px 0;display:flex;gap:4px;align-items:start;">
                  <span style="color:${issue.level === 'error' ? '#f87171' : '#fbbf24'};flex-shrink:0;">${issue.level === "error" ? "✗" : "⚠"}</span>
                  <span><strong>${issue.workflowName}:</strong> ${issue.message}</span>
                </div>
              `)}
            </div>
          `}

          ${/* ── Workflow Stages ── */ ""}
          ${execPlan.stages?.map((stage, si) => html`
            <div key=${`stage-${si}`} style="margin-bottom:10px;border:1px solid var(--border-color,#333);border-radius:8px;overflow:hidden;">
              <div style="padding:8px 12px;background:var(--color-bg-secondary,#141820);display:flex;align-items:center;gap:8px;cursor:pointer;border-bottom:1px solid var(--border-color,#333);"
                   onClick=${() => toggleStageExpand(si)}>
                <span style="font-size:0.75em;opacity:0.5;">${expandedStages[si] === false ? "▸" : "▾"}</span>
                ${stage.core ? html`<span style="background:#8b5cf620;color:#a78bfa;padding:1px 6px;border-radius:3px;font-size:0.65em;font-weight:600;">CORE</span>` : ""}
                <strong style="font-size:0.85em;flex:1;">${stage.workflowName}</strong>
                <span style="font-size:0.7em;padding:1px 6px;border-radius:3px;background:${stage.matchType === 'polling' ? '#6b728020' : '#3b82f620'};color:${stage.matchType === 'polling' ? '#9ca3af' : '#60a5fa'};">
                  ${stage.matchType === "polling" ? "lifecycle" : "matched"}
                </span>
                <span style="font-size:0.7em;opacity:0.5;">${stage.nodeCount} nodes · ${stage.agentRunCount} agents</span>
                <span style="font-size:0.65em;opacity:0.4;text-transform:uppercase;">${stage.category || ""}</span>
              </div>

              ${expandedStages[si] !== false && html`
                <div style="padding:10px 12px;">
                  ${stage.description ? html`<div style="font-size:0.78em;opacity:0.6;margin-bottom:8px;">${stage.description}</div>` : ""}
                  <div style="display:flex;flex-direction:column;gap:3px;">
                    ${(stage.nodes || []).map((nd, ni) => {
                      const isExpanded = expandedNodes[`${si}-${nd.id}`];
                      const nodeColors = nd.isAgentRun ? { bg: "#1a2a4a", border: "#2d5a9f", accent: "#60a5fa" }
                        : nd.isTrigger ? { bg: "#2a2010", border: "#8b6914", accent: "#fbbf24" }
                        : nd.isCondition ? { bg: "#1a1a30", border: "#5b21b6", accent: "#a78bfa" }
                        : nd.isCommand || nd.isValidation ? { bg: "#1a2a20", border: "#166534", accent: "#4ade80" }
                        : nd.isStatusUpdate ? { bg: "#2a1a1a", border: "#7f1d1d", accent: "#fca5a5" }
                        : nd.isNotify ? { bg: "#1a2020", border: "#334155", accent: "#94a3b8" }
                        : { bg: "#1a1a1e", border: "#333", accent: "#888" };
                      const hasIssue = nd.expressionValid === false || !nd.typeRegistered || (nd.unresolvedVars?.length > 0);
                      const dryRunNode = dryRunResults?.find((dr) => dr.workflowId === stage.workflowId)?.nodes?.find((dn) => dn.id === nd.id);

                      return html`
                        <div key=${`n-${ni}`}>
                          ${ni > 0 && html`<div style="margin-left:18px;height:8px;border-left:2px solid ${nodeColors.border};opacity:0.3;"></div>`}
                          <div style="border:1px solid ${hasIssue ? '#ef4444' : nodeColors.border};border-radius:6px;background:${nodeColors.bg};cursor:pointer;transition:all 0.15s;"
                               onClick=${() => toggleNodeExpand(si, nd.id)}>
                            <div style="padding:6px 10px;display:flex;align-items:center;gap:6px;">
                              <span style="font-size:0.65em;opacity:0.5;width:16px;text-align:center;">${ni + 1}</span>
                              <span style="font-size:0.7em;color:${nodeColors.accent};opacity:0.7;min-width:60px;">${nd.type.split(".").pop()}</span>
                              <strong style="font-size:0.8em;flex:1;">${nd.label}</strong>
                              ${hasIssue ? html`<span style="color:#ef4444;font-size:0.7em;" title="Has issues">✗</span>` : ""}
                              ${nd.isAgentRun && nd.resolvedAgent ? html`
                                <span style="font-size:0.7em;color:${nodeColors.accent};opacity:0.8;">
                                  ${resolveIcon("bot")} ${nd.resolvedAgent}
                                  ${nd.confidence ? html` (${Math.round(nd.confidence * 100)}%)` : ""}
                                </span>
                              ` : ""}
                              ${nd.isAgentRun && !nd.resolvedAgent && nd.resolveMode === "library" ? html`
                                <span style="font-size:0.7em;opacity:0.5;">Library Auto</span>
                              ` : ""}
                              ${nd.isCommand ? html`<span style="font-size:0.65em;font-family:monospace;opacity:0.5;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${nd.commandResolved || nd.commandRaw}</span>` : ""}
                              ${nd.isStatusUpdate ? html`<span style="font-size:0.7em;opacity:0.6;">→ ${nd.targetStatus}</span>` : ""}
                              ${dryRunNode ? html`<span style="font-size:0.65em;color:${dryRunNode.status === 'simulated' || dryRunNode.status === 'COMPLETED' ? '#10b981' : '#fbbf24'};">● ${dryRunNode.status}</span>` : ""}
                              <span style="font-size:0.65em;opacity:0.3;">${isExpanded ? "▾" : "▸"}</span>
                            </div>

                            ${isExpanded && html`
                              <div style="padding:6px 10px 8px;border-top:1px solid ${nodeColors.border}40;font-size:0.75em;">
                                <div style="display:grid;grid-template-columns:auto 1fr;gap:3px 10px;align-items:start;">
                                  <span style="opacity:0.5;">Type:</span>
                                  <span style="font-family:monospace;">${nd.type}${!nd.typeRegistered ? html` <span style="color:#ef4444;">✗ unregistered</span>` : ""}</span>

                                  ${nd.isTrigger && nd.taskPattern ? html`
                                    <span style="opacity:0.5;">Pattern:</span>
                                    <span style="font-family:monospace;">${nd.taskPattern} ${nd.patternMatches === true ? html`<span style="color:#10b981;">✓ matches</span>` : nd.patternMatches === false ? html`<span style="color:#ef4444;">✗ no match</span>` : ""}</span>
                                  ` : ""}

                                  ${nd.isCondition && nd.expression ? html`
                                    <span style="opacity:0.5;">Expression:</span>
                                    <span style="font-family:monospace;word-break:break-all;">${nd.expression}${nd.expressionValid === false ? html` <span style="color:#ef4444;">✗ ${nd.expressionError}</span>` : html` <span style="color:#10b981;">✓</span>`}</span>
                                  ` : ""}

                                  ${nd.isAgentRun ? html`
                                    <span style="opacity:0.5;">SDK:</span><span>${nd.sdk || "auto"}</span>
                                    <span style="opacity:0.5;">Model:</span><span>${nd.model || "auto"}</span>
                                    <span style="opacity:0.5;">Timeout:</span><span>${Math.round((nd.timeoutMs || 3600000) / 60000)}min</span>
                                    <span style="opacity:0.5;">Retries:</span><span>${nd.maxRetries ?? 2} retries, ${nd.maxContinues ?? 2} continues</span>
                                    <span style="opacity:0.5;">Resolve:</span><span>${nd.resolveMode || "manual"}</span>
                                    <span style="opacity:0.5;">CWD:</span><span style="font-family:monospace;">${nd.cwd || "auto"}</span>
                                  ` : ""}

                                  ${nd.isCommand ? html`
                                    <span style="opacity:0.5;">Command:</span>
                                    <span style="font-family:monospace;word-break:break-all;">${nd.commandResolved || nd.commandRaw}</span>
                                    <span style="opacity:0.5;">CWD:</span><span style="font-family:monospace;">${nd.commandCwd}</span>
                                    <span style="opacity:0.5;">Timeout:</span><span>${Math.round((nd.commandTimeout || 300000) / 1000)}s</span>
                                    <span style="opacity:0.5;">Fail on error:</span><span>${nd.failOnError ? "Yes" : "No"}</span>
                                  ` : ""}

                                  ${nd.isResolveExecutor ? html`
                                    <span style="opacity:0.5;">SDK Override:</span><span>${nd.sdkOverride || "auto"}</span>
                                    <span style="opacity:0.5;">Model Override:</span><span>${nd.modelOverride || "auto"}</span>
                                  ` : ""}

                                  ${nd.isSubWorkflow ? html`
                                    <span style="opacity:0.5;">Sub-workflow:</span><span style="font-family:monospace;">${nd.targetWorkflowId || "—"}</span>
                                    <span style="opacity:0.5;">Inherit ctx:</span><span>${nd.inheritContext ? "Yes" : "No"}</span>
                                  ` : ""}

                                  ${nd.isValidation ? html`
                                    <span style="opacity:0.5;">${nd.validationType} cmd:</span>
                                    <span style="font-family:monospace;">${nd.commandResolved || nd.commandRaw || "auto"}</span>
                                  ` : ""}

                                  ${nd.unresolvedVars?.length > 0 ? html`
                                    <span style="opacity:0.5;color:#fbbf24;">Unresolved:</span>
                                    <span style="color:#fbbf24;">${nd.unresolvedVars.map((v) => `{{${v}}}`).join(", ")}</span>
                                  ` : ""}
                                </div>

                                ${nd.isAgentRun && nd.resolvedSkills?.length > 0 ? html`
                                  <div style="margin-top:6px;padding-top:4px;border-top:1px dashed ${nodeColors.border}40;">
                                    <div style="opacity:0.6;margin-bottom:3px;">${resolveIcon("star")} Resolved Skills:</div>
                                    ${nd.resolvedSkills.map((sk) => html`
                                      <div style="display:flex;gap:6px;padding:1px 0;align-items:center;">
                                        <span style="font-weight:500;">${sk.name}</span>
                                        ${sk.score ? html`<span style="opacity:0.4;font-size:0.9em;">${Math.round(sk.score * 100)}%</span>` : ""}
                                        ${sk.source ? html`<span style="opacity:0.3;font-size:0.85em;">(${sk.source})</span>` : ""}
                                      </div>
                                    `)}
                                  </div>
                                ` : ""}

                                ${nd.isAgentRun && nd.resolvedTools && (nd.resolvedTools.builtin?.length > 0 || nd.resolvedTools.mcp?.length > 0) ? html`
                                  <div style="margin-top:4px;">
                                    <span style="opacity:0.6;">${resolveIcon("tool")} Tools: </span>
                                    <span>${[...(nd.resolvedTools.builtin || []), ...(nd.resolvedTools.mcp || [])].join(", ")}</span>
                                  </div>
                                ` : ""}

                                ${nd.isAgentRun && nd.alternatives?.length > 0 ? html`
                                  <div style="margin-top:4px;opacity:0.5;">
                                    <span>Alt: ${nd.alternatives.map((a) => `${a.name} (${Math.round((a.confidence || 0) * 100)}%)`).join(", ")}</span>
                                  </div>
                                ` : ""}

                                ${nd.isAgentRun && nd.promptResolved ? html`
                                  <details style="margin-top:6px;">
                                    <summary style="cursor:pointer;opacity:0.6;font-size:0.9em;">Prompt Preview (${nd.promptResolved.length} chars)</summary>
                                    <pre style="margin-top:4px;padding:6px;background:#00000030;border-radius:4px;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow-y:auto;font-size:0.85em;">${nd.promptResolved.slice(0, 2000)}${nd.promptResolved.length > 2000 ? "\n…(truncated)" : ""}</pre>
                                  </details>
                                ` : ""}
                              </div>
                            `}
                          </div>
                        </div>
                      `;
                    })}
                  </div>

                  ${stage.edges?.some((e) => e.condition || e.sourcePort || e.isBackEdge) && html`
                    <details style="margin-top:8px;">
                      <summary style="cursor:pointer;font-size:0.75em;opacity:0.5;">Edge routing (${stage.edges.length} edges)</summary>
                      <div style="margin-top:4px;font-size:0.7em;font-family:monospace;">
                        ${stage.edges.filter((e) => e.condition || e.sourcePort || e.isBackEdge).map((e) => html`
                          <div style="padding:2px 0;display:flex;gap:4px;align-items:center;">
                            <span>${e.source}</span><span style="opacity:0.3;">→</span><span>${e.target}</span>
                            ${e.sourcePort ? html`<span style="color:#a78bfa;">[${e.sourcePort}]</span>` : ""}
                            ${e.condition ? html`<span style="opacity:0.5;color:${e.conditionValid === false ? '#ef4444' : '#4ade80'};">${e.condition.length > 50 ? e.condition.slice(0, 50) + "…" : e.condition}</span>` : ""}
                            ${e.isBackEdge ? html`<span style="color:#fbbf24;">↩ loop</span>` : ""}
                            ${e.conditionValid === false ? html`<span style="color:#ef4444;">✗ ${e.conditionError}</span>` : ""}
                          </div>
                        `)}
                      </div>
                    </details>
                  `}
                </div>
              `}
            </div>
          `)}

          ${/* ── Dry-run results summary ── */ ""}
          ${dryRunResults && html`
            <div style="margin-top:8px;border:1px solid #10b98140;border-radius:6px;padding:8px;background:#10b98110;">
              <div style="font-weight:600;font-size:0.8em;color:#10b981;margin-bottom:4px;">${resolveIcon("check")} Dry-Run Results</div>
              ${dryRunResults.map((dr) => html`
                <div style="font-size:0.75em;padding:2px 0;">
                  <span style="font-weight:500;">${dr.workflowName}</span>
                  <span style="color:${dr.status === 'completed' ? '#10b981' : dr.status === 'error' ? '#ef4444' : '#fbbf24'};">
                    — ${dr.status}
                  </span>
                  ${dr.error ? html`<span style="color:#ef4444;margin-left:4px;">${dr.error}</span>` : ""}
                  ${dr.nodes?.length > 0 ? html`<span style="opacity:0.5;margin-left:4px;">(${dr.nodes.length} nodes simulated)</span>` : ""}
                </div>
              `)}
            </div>
          `}
        </div>
      `}
    </div>
  `;
}

function parseApiError(err) {
  const msg = String(err?.message || err || "Unknown error");
  try {
    const parsed = JSON.parse(msg);
    if (parsed?.error) return String(parsed.error);
  } catch { /* not JSON */ }
  return msg;
}

function uniquePreviewStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))];
}

export function buildBlockedImportPreview(blockedCandidates = [], { limit = 8 } = {}) {
  const counts = { agent: 0, skill: 0, prompt: 0, mcp: 0 };
  const items = [];
  const list = Array.isArray(blockedCandidates) ? blockedCandidates : [];

  for (const candidate of list) {
    const kind = String(candidate?.kind || "").trim().toLowerCase() || "prompt";
    counts[kind] = (counts[kind] || 0) + 1;
    if (items.length >= limit) continue;
    const safety = candidate?.safety && typeof candidate.safety === "object" ? candidate.safety : {};
    const findings = safety.findings && typeof safety.findings === "object" ? safety.findings : {};
    items.push({
      relPath: String(candidate?.relPath || "").trim(),
      name: String(candidate?.name || candidate?.fileName || candidate?.relPath || "Blocked item").trim(),
      kind,
      score: Number(safety.score || 0),
      reasons: uniquePreviewStrings(safety.reasons).slice(0, 3),
      excerpts: uniquePreviewStrings([
        ...(Array.isArray(findings.unicode) ? findings.unicode : []),
        ...(Array.isArray(findings.promptOverride) ? findings.promptOverride : []),
        ...(Array.isArray(findings.promotion) ? findings.promotion : []),
        ...(Array.isArray(findings.malware) ? findings.malware : []),
      ]).slice(0, 2),
    });
  }

  return {
    totalCount: list.length,
    counts,
    items,
  };
}

function ImportPreviewModal({ candidates, blockedCandidates, source, onConfirm, onClose, loading, duplicates, intraDuplicates }) {
  const [selection, setSelection] = useState(() => {
    const map = {};
    for (const c of (candidates || [])) map[c.relPath] = c.selected !== false;
    return map;
  });
  const [typeFilter, setTypeFilter] = useState("all");
  const [showDupOnly, setShowDupOnly] = useState(false);

  const dupMap = duplicates || {};
  const intraDupMap = intraDuplicates || {};
  const dupCount = Object.keys(dupMap).length;
  const blockedPreview = useMemo(() => buildBlockedImportPreview(blockedCandidates), [blockedCandidates]);
  const blockedCount = blockedPreview.totalCount;

  const filtered = useMemo(() => {
    let list = candidates || [];
    if (typeFilter !== "all") list = list.filter((c) => c.kind === typeFilter);
    if (showDupOnly) list = list.filter((c) => dupMap[c.relPath] || intraDupMap[c.relPath]);
    return list;
  }, [candidates, typeFilter, showDupOnly, dupMap, intraDupMap]);

  const selectedCount = useMemo(() => Object.values(selection).filter(Boolean).length, [selection]);
  const typeCounts = useMemo(() => {
    const counts = { agent: 0, skill: 0, prompt: 0, mcp: 0 };
    for (const c of (candidates || [])) counts[c.kind] = (counts[c.kind] || 0) + 1;
    return counts;
  }, [candidates]);

  const toggleAll = useCallback((checked) => {
    setSelection((prev) => {
      const next = { ...prev };
      for (const c of filtered) next[c.relPath] = checked;
      return next;
    });
  }, [filtered]);

  const toggle = useCallback((relPath) => {
    setSelection((prev) => ({ ...prev, [relPath]: !prev[relPath] }));
  }, []);

  const handleConfirm = useCallback(() => {
    const selected = Object.entries(selection).filter(([, v]) => v).map(([k]) => k);
    onConfirm(selected);
  }, [selection, onConfirm]);

  const kindIcon = { agent: "🤖", skill: "⚡", prompt: "📝", mcp: "🔧" };
  const allFilteredSelected = filtered.length > 0 && filtered.every((c) => selection[c.relPath]);

  const dupReasonLabel = (info) => {
    if (!info) return "";
    if (info.reason === "exact-name") return "Exact name match";
    if (info.reason === "slug-match") return "Very similar name";
    return `${Math.round((info.similarity || 0) * 100)}% similar`;
  };

  return html`
    <${Modal} title="Select Items to Import" onClose=${onClose} wide=${true}>
      <div style="display:flex;flex-direction:column;gap:10px;max-height:70vh;">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span style="font-size:0.85em;font-weight:600;">${source?.name || "Repository"}</span>
          <span style="font-size:0.8em;color:var(--text-secondary);">·</span>
          <span style="font-size:0.8em;color:var(--text-secondary);">${(candidates || []).length} items found</span>
          <span style="font-size:0.8em;color:var(--text-secondary);">·</span>
          <span style="font-size:0.8em;color:var(--text-secondary);">${selectedCount} selected</span>
          ${blockedCount > 0 ? html`
            <span style="font-size:0.8em;color:var(--text-secondary);">·</span>
            <span style="font-size:0.78em;padding:2px 8px;border-radius:999px;background:rgba(239,68,68,0.16);color:#fca5a5;">
              Blocked ${blockedCount}
            </span>
          ` : null}
          ${dupCount > 0 ? html`
            <span style="font-size:0.8em;color:var(--text-secondary);">·</span>
            <span style="font-size:0.78em;padding:2px 8px;border-radius:999px;background:rgba(245,158,11,0.18);color:#f59e0b;cursor:pointer;" onClick=${() => setShowDupOnly(!showDupOnly)}>
              ⚠ ${dupCount} duplicate${dupCount !== 1 ? "s" : ""}${showDupOnly ? " (showing)" : ""}
            </span>
          ` : null}
        </div>
        ${blockedCount > 0 ? html`
          <div style="font-size:0.75em;padding:8px 10px;border-radius:8px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);color:var(--text-secondary);display:flex;flex-direction:column;gap:8px;">
            <div>
              ⚠ Safety filters blocked ${blockedCount} item${blockedCount !== 1 ? "s" : ""} from this repository. Blocked items cannot be selected for import.
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              ${[
                ["agent", "Agents"],
                ["prompt", "Prompts"],
                ["skill", "Skills"],
                ["mcp", "Tools"],
              ].filter(([key]) => Number(blockedPreview.counts[key] || 0) > 0).map(([key, label]) => html`
                <span key=${key} style="font-size:0.72em;padding:2px 8px;border-radius:999px;background:rgba(239,68,68,0.12);color:#fca5a5;">
                  ${label} (${blockedPreview.counts[key]})
                </span>
              `)}
            </div>
            <div style="display:flex;flex-direction:column;gap:6px;max-height:180px;overflow-y:auto;">
              ${blockedPreview.items.map((item) => html`
                <div key=${item.relPath} style="padding:8px;border-radius:8px;background:rgba(0,0,0,0.12);border:1px solid rgba(239,68,68,0.12);display:flex;flex-direction:column;gap:4px;">
                  <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                    <span style="font-size:0.8em;font-weight:600;">${item.name}</span>
                    <span style="font-size:0.7em;padding:2px 6px;border-radius:999px;background:rgba(239,68,68,0.16);color:#fca5a5;">${item.kind}</span>
                    ${item.score > 0 ? html`<span style="font-size:0.7em;color:#fca5a5;">score ${item.score}</span>` : null}
                  </div>
                  <div style="font-size:0.72em;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title=${item.relPath}>${item.relPath}</div>
                  ${item.reasons.length > 0 ? html`<div style="font-size:0.72em;color:#fecaca;">Reasons: ${item.reasons.join(", ")}</div>` : null}
                  ${item.excerpts.map((excerpt) => html`<div key=${excerpt} style="font-size:0.7em;color:var(--text-secondary);font-family:var(--font-mono, monospace);">${excerpt}</div>`)}
                </div>
              `)}
              ${blockedCount > blockedPreview.items.length ? html`
                <div style="font-size:0.72em;color:var(--text-secondary);">
                  ${blockedCount - blockedPreview.items.length} more blocked item${blockedCount - blockedPreview.items.length !== 1 ? "s" : ""} not shown.
                </div>
              ` : null}
            </div>
          </div>
        ` : null}
        ${dupCount > 0 ? html`
          <div style="font-size:0.75em;padding:6px 10px;border-radius:8px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);color:var(--text-secondary);">
            ⚠ ${dupCount} item${dupCount !== 1 ? "s" : ""} appear${dupCount === 1 ? "s" : ""} similar to entries already in your library.
            Exact matches are auto-deselected. Review and toggle as needed.
          </div>
        ` : null}
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
          ${[
            ["all", "All", (candidates || []).length],
            ["agent", "Agents", typeCounts.agent],
            ["skill", "Skills", typeCounts.skill],
            ["prompt", "Prompts", typeCounts.prompt],
            ["mcp", "Tools", typeCounts.mcp],
          ].filter(([, , count]) => count > 0 || true).map(([key, label, count]) => html`
            <button key=${key} onClick=${() => setTypeFilter(key)}
              style="padding:3px 10px;border-radius:12px;border:1px solid var(--border,#333);background:${typeFilter === key ? "var(--accent,#3b82f6)" : "transparent"};color:${typeFilter === key ? "#fff" : "var(--text-secondary)"};font-size:0.78em;cursor:pointer;">
              ${label} (${count})
            </button>
          `)}
          <span style="flex:1;" />
          <button onClick=${() => toggleAll(true)} style="padding:3px 8px;border:1px solid var(--border,#333);border-radius:8px;background:transparent;color:var(--text-secondary);font-size:0.75em;cursor:pointer;">Select All</button>
          <button onClick=${() => toggleAll(false)} style="padding:3px 8px;border:1px solid var(--border,#333);border-radius:8px;background:transparent;color:var(--text-secondary);font-size:0.75em;cursor:pointer;">Deselect All</button>
        </div>
        <div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid var(--border,#333);">
          <input type="checkbox" checked=${allFilteredSelected} onChange=${(e) => toggleAll(e.currentTarget.checked)} />
          <span style="font-size:0.75em;font-weight:600;color:var(--text-secondary);flex:1;">NAME</span>
          <span style="font-size:0.75em;font-weight:600;color:var(--text-secondary);width:60px;text-align:center;">TYPE</span>
        </div>
        <div style="overflow-y:auto;max-height:50vh;display:flex;flex-direction:column;">
          ${filtered.map((c) => {
            const dupInfo = dupMap[c.relPath];
            const intraDup = intraDupMap[c.relPath];
            const hasDup = !!dupInfo;
            const hasIntraDup = !!intraDup;
            return html`
              <label key=${c.relPath} style="display:flex;align-items:flex-start;gap:6px;padding:5px 0;border-bottom:1px solid var(--border,#222);cursor:pointer;opacity:${selection[c.relPath] ? 1 : 0.5};${hasDup ? "background:rgba(245,158,11,0.04);" : ""}">
                <input type="checkbox" checked=${Boolean(selection[c.relPath])} onChange=${() => toggle(c.relPath)} style="margin-top:2px;" />
                <div style="flex:1;min-width:0;">
                  <div style="font-size:0.82em;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${c.name || c.fileName}</div>
                  <div style="font-size:0.72em;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title=${c.relPath}>${c.relPath}</div>
                  ${c.description ? html`<div style="font-size:0.72em;color:var(--text-secondary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${String(c.description || "").slice(0, 120)}</div>` : null}
                  ${hasDup ? html`
                    <div style="font-size:0.7em;margin-top:3px;padding:2px 6px;border-radius:6px;background:rgba(245,158,11,0.12);color:#f59e0b;display:inline-flex;align-items:center;gap:4px;">
                      ⚠ ${dupReasonLabel(dupInfo)}: existing "${dupInfo.existingEntries?.[0]?.name || "?"}"
                      ${dupInfo.similarity >= 0.95 ? html` · <em>auto-deselected</em>` : null}
                    </div>
                  ` : null}
                  ${hasIntraDup && !hasDup ? html`
                    <div style="font-size:0.7em;margin-top:3px;padding:2px 6px;border-radius:6px;background:rgba(59,130,246,0.12);color:#3b82f6;display:inline-flex;align-items:center;gap:4px;">
                      ↔ Similar to ${intraDup.length} other item${intraDup.length !== 1 ? "s" : ""} in this import
                    </div>
                  ` : null}
                </div>
                <span style="font-size:0.72em;padding:2px 6px;border-radius:999px;background:${c.kind === "agent" ? "rgba(59,130,246,0.18)" : c.kind === "skill" ? "rgba(34,197,94,0.18)" : "rgba(168,85,247,0.18)"};color:var(--text-secondary);width:60px;text-align:center;flex-shrink:0;">${kindIcon[c.kind] || ""} ${c.kind}</span>
              </label>
            `;
          })}
          ${filtered.length === 0 ? html`<div style="padding:20px;text-align:center;color:var(--text-secondary);font-size:0.85em;">No items found</div>` : null}
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;padding-top:8px;border-top:1px solid var(--border,#333);">
          <${Button} variant="text" size="small" onClick=${onClose} disabled=${loading}>Cancel<//>
          <${Button} variant="contained" size="small" onClick=${handleConfirm} disabled=${loading || selectedCount === 0}>
            ${loading ? html`<${Spinner} size=${14} />` : iconText(`:download: Import ${selectedCount} Items`)}
          <//>
        </div>
      </div>
    <//>
  `;
}

function AgentLibraryImporter({ onImported }) {
  const [sources, setSources] = useState([]);
  const [sourceId, setSourceId] = useState("microsoft-skills");
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [maxProfiles, setMaxProfiles] = useState("200");
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [previewData, setPreviewData] = useState(null);
  const [importAgents, setImportAgents] = useState(true);
  const [importSkills, setImportSkills] = useState(true);
  const [importPrompts, setImportPrompts] = useState(true);
  const [importTools, setImportTools] = useState(true);
  const selectedSource = useMemo(() => (sources || []).find((source) => source.id === sourceId) || null, [sources, sourceId]);

  useEffect(() => {
    let alive = true;
    fetchLibrarySources()
      .then((data) => {
        if (!alive) return;
        setSources(Array.isArray(data) ? data : []);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const doPreview = useCallback(async () => {
    setScanning(true);
    try {
      const payload = {
        sourceId: repoUrl.trim() ? undefined : (sourceId || undefined),
        repoUrl: repoUrl.trim() || undefined,
        branch: branch.trim() || undefined,
        maxEntries: Number.parseInt(String(maxProfiles || ""), 10) || undefined,
      };
      const res = await previewLibrarySource(payload);
      if (!res?.ok) throw new Error(res?.error || "Preview failed");
      const data = res?.data;
      if (!data?.candidates?.length) {
        if (Array.isArray(data?.blockedCandidates) && data.blockedCandidates.length > 0) {
          showToast(`Safety filters blocked ${data.blockedCandidates.length} item${data.blockedCandidates.length !== 1 ? "s" : ""} from this repository`, "warning");
          setPreviewData(data);
        } else {
          showToast("No importable items found in this repository", "warning");
        }
      } else {
        setPreviewData(data);
      }
    } catch (err) {
      showToast(`Preview failed: ${parseApiError(err)}`, "error");
    }
    setScanning(false);
  }, [sourceId, repoUrl, branch, maxProfiles]);

  const doImport = useCallback(async (selectedPaths) => {
    setImporting(true);
    try {
      if (!importAgents && !importPrompts && !importSkills && !importTools) {
        throw new Error("Select at least one import type");
      }
      const payload = {
        sourceId: repoUrl.trim() ? undefined : (sourceId || undefined),
        repoUrl: repoUrl.trim() || undefined,
        branch: branch.trim() || undefined,
        maxEntries: Number.parseInt(String(maxProfiles || ""), 10) || undefined,
        importAgents,
        importSkills,
        importPrompts,
        importTools,
        includeEntries: selectedPaths,
      };
      const res = await importLibrarySource(payload);
      if (!res?.ok) throw new Error(res?.error || "Import failed");
      const count = Number(res?.data?.importedCount || 0);
      const byType = res?.data?.importedByType || {};
      const details = [
        `agents ${Number(byType?.agent || 0)}`,
        `prompts ${Number(byType?.prompt || 0)}`,
        `skills ${Number(byType?.skill || 0)}`,
        `tools ${Number(byType?.mcp || 0)}`,
      ].join(", ");
      showToast(`Imported ${count} entries (${details})`, "success");
      setPreviewData(null);
      if (typeof onImported === "function") onImported();
    } catch (err) {
      showToast(`Import failed: ${parseApiError(err)}`, "error");
    }
    setImporting(false);
  }, [sourceId, repoUrl, branch, maxProfiles, importAgents, importSkills, importPrompts, importTools, onImported]);

  return html`
    <div style="margin-top:10px;padding:10px;border:1px solid var(--border,#333);border-radius:10px;">
      <div style="font-size:0.9em;font-weight:600;margin-bottom:6px;">${iconText(":package: Import Library Content")}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;">
        <label style="display:flex;flex-direction:column;gap:4px;font-size:0.82em;color:var(--text-secondary);">
          Source
          <select value=${sourceId} onChange=${(e) => setSourceId(e.currentTarget.value)}>
            ${(sources.length ? [...sources].sort((a, b) => (Number(b.estimatedPlugins || 0) - Number(a.estimatedPlugins || 0)) || String(a.name || "").localeCompare(String(b.name || ""))) : [
              { id: "microsoft-skills", name: "Microsoft Skills", estimatedPlugins: 180 },
              { id: "microsoft-hve-core", name: "Microsoft HVE Core", estimatedPlugins: 60 },
              { id: "canonical-copilot-collections", name: "Canonical Copilot Collections", estimatedPlugins: 50 },
              { id: "microsoft-copilot-for-azure", name: "GitHub Copilot for Azure", estimatedPlugins: 45 },
              { id: "mastra-ai-mastra", name: "Mastra AI Framework", estimatedPlugins: 40 },
              { id: "copilot-kit", name: "Copilot Kit", estimatedPlugins: 35 },
              { id: "copilot-prompts-collection", name: "GitHub Copilot Prompts", estimatedPlugins: 30 },
              { id: "playwright-mcp-prompts", name: "Playwright MCP Prompts", estimatedPlugins: 25 },
              { id: "modelcontextprotocol-servers", name: "MCP Official Servers", estimatedPlugins: 25 },
              { id: "microsoft-typespec", name: "Microsoft TypeSpec", estimatedPlugins: 20 },
              { id: "microsoft-vscode", name: "Microsoft VS Code", estimatedPlugins: 15 },
              { id: "azure-sdk-for-js", name: "Azure SDK for JavaScript", estimatedPlugins: 15 },
              { id: "microsoft-powertoys", name: "Microsoft PowerToys", estimatedPlugins: 10 },
              { id: "github-copilot-sdk", name: "GitHub Copilot SDK", estimatedPlugins: 10 },
              { id: "github-desktop", name: "GitHub Desktop", estimatedPlugins: 10 },
            ]).map((s) => {
              const est = Number(s.estimatedPlugins || 0);
              const label = est > 0 ? `${s.name} (~${est} plugins)` : s.name;
              return html`<option key=${s.id} value=${s.id}>${label}</option>`;
            })}
          </select>
        </label>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:0.82em;color:var(--text-secondary);">
          Branch
          <input value=${branch} onInput=${(e) => setBranch(e.currentTarget.value)} placeholder="main" />
        </label>
        <label style="display:flex;flex-direction:column;gap:4px;font-size:0.82em;color:var(--text-secondary);">
          Max Entries
          <input value=${maxProfiles} onInput=${(e) => setMaxProfiles(e.currentTarget.value)} placeholder="200" />
        </label>
      </div>
      <label style="display:flex;flex-direction:column;gap:4px;font-size:0.82em;color:var(--text-secondary);margin-top:8px;">
        Custom Repo URL (optional — overrides source selection)
        <input value=${repoUrl} onInput=${(e) => setRepoUrl(e.currentTarget.value)} placeholder="https://github.com/org/repo.git" />
      </label>
      <div style="margin-top:8px;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:6px;">
        <label style="display:flex;align-items:center;gap:6px;font-size:0.8em;color:var(--text-secondary);"><input type="checkbox" checked=${importAgents} onChange=${(e) => setImportAgents(Boolean(e.currentTarget.checked))} /> Bosun Agent Profiles</label>
        <label style="display:flex;align-items:center;gap:6px;font-size:0.8em;color:var(--text-secondary);"><input type="checkbox" checked=${importPrompts} onChange=${(e) => setImportPrompts(Boolean(e.currentTarget.checked))} /> Bosun Prompts</label>
        <label style="display:flex;align-items:center;gap:6px;font-size:0.8em;color:var(--text-secondary);"><input type="checkbox" checked=${importSkills} onChange=${(e) => setImportSkills(Boolean(e.currentTarget.checked))} /> Bosun Library Skills</label>
        <label style="display:flex;align-items:center;gap:6px;font-size:0.8em;color:var(--text-secondary);"><input type="checkbox" checked=${importTools} onChange=${(e) => setImportTools(Boolean(e.currentTarget.checked))} /> Tools (MCP)</label>
      </div>
      <div style="margin-top:6px;font-size:0.77em;color:var(--text-secondary);">
        Imported skills stay in Bosun's library and are resolved into task prompts by Bosun. They are not intended to be exported into provider-native Claude/Copilot skill folders.
      </div>
      ${selectedSource ? html`
        <div style="margin-top:8px;padding:8px 10px;border:1px solid var(--border,#333);border-radius:10px;background:var(--surface-2,rgba(255,255,255,0.03));display:flex;flex-direction:column;gap:6px;">
          <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
            <span style="font-size:0.8em;font-weight:600;">${selectedSource.name}</span>
            <span style="font-size:0.75em;padding:2px 6px;border-radius:999px;background:${selectedSource.status === "healthy" ? "rgba(34,197,94,0.18)" : selectedSource.status === "warning" ? "rgba(245,158,11,0.18)" : selectedSource.status === "low-trust" ? "rgba(245,158,11,0.18)" : "rgba(239,68,68,0.18)"};color:var(--text-secondary);">${String(selectedSource.status || "unknown").toUpperCase()}</span>
            <span style="font-size:0.75em;padding:2px 6px;border-radius:999px;background:rgba(59,130,246,0.16);color:var(--text-secondary);cursor:help;" title="Trust score (0-100) based on: source tier (official/partner/community), GitHub owner reputation, import coverage (high/medium/low), HTTPS hosting bonus, repository age & stars, recent probe (reachable, branch exists, not archived).">Trust ${Number(selectedSource?.trust?.score || 0)}/100</span>
            ${selectedSource.enabled === false ? html`<span style="font-size:0.75em;padding:2px 6px;border-radius:999px;background:rgba(239,68,68,0.18);color:var(--text-secondary);">UNAVAILABLE</span>` : null}
            ${selectedSource?.trust?.lowTrust ? html`<span style="font-size:0.75em;padding:2px 6px;border-radius:999px;background:rgba(245,158,11,0.22);color:var(--text-secondary);">⚠ LOW TRUST</span>` : null}
          </div>
          <div style="font-size:0.8em;color:var(--text-secondary);">${selectedSource.description || ""}</div>
          ${selectedSource?.trust?.lowTrust && selectedSource.enabled !== false ? html`<div style="font-size:0.78em;color:var(--warning,#f59e0b);padding:4px 6px;border-radius:6px;background:rgba(245,158,11,0.08);">⚠ Low trust score — import with caution. Review items before using in production.</div>` : null}
          ${(selectedSource?.trust?.reasons?.length || 0) ? html`<div style="font-size:0.75em;color:var(--text-secondary);">Signals: ${selectedSource.trust.reasons.slice(0, 6).join(", ")}</div>` : null}
          ${selectedSource?.probe?.checkedAt ? html`<div style="font-size:0.75em;color:var(--text-secondary);">Last probe: ${new Date(selectedSource.probe.checkedAt).toLocaleString()}${selectedSource?.probe?.error ? ` · ${selectedSource.probe.error}` : ""}</div>` : null}
        </div>
      ` : null}
      <div class="library-actions">
        <${Button} variant="outlined" size="small" onClick=${doPreview} disabled=${scanning || importing || selectedSource?.enabled === false}>
          ${scanning ? html`<${Spinner} size=${14} /> Scanning…` : iconText(":mag: Preview & Select")}
        <//>
      </div>
    </div>
    ${previewData ? html`
      <${ImportPreviewModal}
        candidates=${previewData.candidates}
        blockedCandidates=${previewData.blockedCandidates}
        source=${previewData.source}
        duplicates=${previewData.duplicates}
        intraDuplicates=${previewData.intraDuplicates}
        onConfirm=${doImport}
        onClose=${() => setPreviewData(null)}
        loading=${importing}
      />
    ` : null}
  `;
}

/* ─ Library Marketplace ───────────────────────────────────── */

const MARKETPLACE_CATEGORIES = [
  { id: "all", label: "All" },
  { id: "official", label: "Official" },
  { id: "community", label: "Community" },
  { id: "agents", label: "Agents" },
  { id: "skills", label: "Skills" },
  { id: "mcp", label: "MCP" },
];

const MARKETPLACE_PROBE_TTL_MS = 5 * 60 * 1000;
let marketplaceSourcesCache = [];
let marketplaceSourcesProbedAt = 0;

function normalizeMarketplaceSources(value) {
  return Array.isArray(value) ? value : [];
}

function setMarketplaceSourcesCache(value, { probed = false } = {}) {
  marketplaceSourcesCache = normalizeMarketplaceSources(value);
  if (probed) marketplaceSourcesProbedAt = Date.now();
  return marketplaceSourcesCache;
}

function getTrustTier(source) {
  const tier = String(source?.trustTier || "").toLowerCase();
  if (tier === "official" || tier === "partner") return { label: "Official", color: "#22c55e", icon: "🏢" };
  if (tier === "community") return { label: "Community", color: "#3b82f6", icon: "👥" };
  return { label: "Unknown", color: "#6b7280", icon: "❔" };
}

export function getRecommendedMarketplaceImportPayload(previewData) {
  const source = previewData?.source && typeof previewData.source === "object"
    ? previewData.source
    : {};
  const counts = previewData?.candidatesByType && typeof previewData.candidatesByType === "object"
    ? previewData.candidatesByType
    : {};
  const focuses = Array.isArray(source?.focuses)
    ? source.focuses.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean)
    : [];
  const onlySkills = Number(counts.skill || 0) > 0
    && Number(counts.agent || 0) === 0
    && Number(counts.prompt || 0) === 0;
  const sourceLooksSkillOnly = focuses.includes("skills")
    && !focuses.includes("agents")
    && !focuses.includes("prompts");

  if (onlySkills || sourceLooksSkillOnly) {
    return {
      importAgents: false,
      importSkills: true,
      importPrompts: false,
      importTools: true,
    };
  }

  return {
    importAgents: true,
    importSkills: true,
    importPrompts: true,
    importTools: true,
  };
}

export function buildMarketplaceImportPayload(sourceId, previewData, selectedPaths) {
  const source = previewData?.source && typeof previewData.source === "object"
    ? previewData.source
    : {};
  const payload = {
    ...getRecommendedMarketplaceImportPayload(previewData),
    includeEntries: selectedPaths,
  };

  const normalizedSourceId = String(sourceId || source.id || "").trim();
  const repoUrl = String(source.repoUrl || previewData?.repoUrl || "").trim();
  const branch = String(source.defaultBranch || source.branch || previewData?.branch || "").trim();

  if (normalizedSourceId) payload.sourceId = normalizedSourceId;
  if (repoUrl) payload.repoUrl = repoUrl;
  if (branch) payload.branch = branch;

  return payload;
}

function LibraryMarketplace({ onImported }) {
  const [sources, setSources] = useState(() => normalizeMarketplaceSources(marketplaceSourcesCache));
  const [loading, setLoading] = useState(() => marketplaceSourcesCache.length === 0);
  const [refreshing, setRefreshing] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [activeCategory, setActiveCategory] = useState("all");
  const [expandedSource, setExpandedSource] = useState(null);
  const [previewData, setPreviewData] = useState(null);
  const [previewSourceId, setPreviewSourceId] = useState(null);
  const [scanning, setScanning] = useState(null);
  const [importing, setImporting] = useState(null);
  const [importedSources, setImportedSources] = useState(new Set());
  const [customUrl, setCustomUrl] = useState("");
  const [customBranch, setCustomBranch] = useState("main");
  const [showCustom, setShowCustom] = useState(false);

  const applySources = useCallback((data, options = {}) => {
    const next = setMarketplaceSourcesCache(data, options);
    setSources(next);
  }, []);

  const refreshSources = useCallback(async ({ probe = true, refresh = false, background = false } = {}) => {
    if (background) setRefreshing(true);
    else setLoading(true);
    try {
      const data = await fetchLibrarySources({ probe, refresh });
      applySources(data, { probed: probe });
    } catch (err) {
      if (!background) {
        showToast(`Failed to load marketplace sources: ${parseApiError(err)}`, "error");
      }
    } finally {
      if (background) setRefreshing(false);
      else setLoading(false);
    }
  }, [applySources]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (!marketplaceSourcesCache.length) {
        try {
          const data = await fetchLibrarySources();
          if (!alive) return;
          applySources(data);
        } catch (err) {
          if (alive) {
            showToast(`Failed to load marketplace sources: ${parseApiError(err)}`, "error");
          }
        } finally {
          if (alive) setLoading(false);
        }
      } else if (alive) {
        setLoading(false);
      }

      if (!alive) return;
      const probeIsFresh = marketplaceSourcesProbedAt > 0 && (Date.now() - marketplaceSourcesProbedAt) < MARKETPLACE_PROBE_TTL_MS;
      if (probeIsFresh) return;

      setRefreshing(true);
      try {
        const data = await fetchLibrarySources({ probe: true });
        if (!alive) return;
        applySources(data, { probed: true });
      } catch {
        // best effort background refresh
      } finally {
        if (alive) setRefreshing(false);
      }
    };

    load();
    return () => { alive = false; };
  }, [applySources]);

  const filteredSources = useMemo(() => {
    let list = [...sources];
    if (searchText.trim()) {
      const q = searchText.trim().toLowerCase();
      list = list.filter((s) => {
        const haystack = `${s.name || ""} ${s.description || ""} ${(s.focuses || []).join(" ")} ${s.id || ""}`.toLowerCase();
        return haystack.includes(q);
      });
    }
    if (activeCategory !== "all") {
      if (activeCategory === "official") {
        list = list.filter((s) => s.trustTier === "official" || s.trustTier === "partner");
      } else if (activeCategory === "community") {
        list = list.filter((s) => s.trustTier === "community" || !s.trustTier);
      } else if (activeCategory === "agents" || activeCategory === "skills" || activeCategory === "mcp") {
        list = list.filter((s) => {
          const focuses = (s.focuses || []).map((f) => f.toLowerCase());
          return focuses.includes(activeCategory) || String(s.description || "").toLowerCase().includes(activeCategory);
        });
      }
    }
    return list.sort((a, b) => (Number(b.estimatedPlugins || 0) - Number(a.estimatedPlugins || 0)) || String(a.name || "").localeCompare(String(b.name || "")));
  }, [sources, searchText, activeCategory]);

  const doPreviewSource = useCallback(async (sourceId) => {
    setScanning(sourceId);
    try {
      const res = await previewLibrarySource({ sourceId });
      if (!res?.ok) throw new Error(res?.error || "Preview failed");
      setPreviewData(res?.data);
      setPreviewSourceId(sourceId);
    } catch (err) {
      showToast(`Preview failed: ${parseApiError(err)}`, "error");
    }
    setScanning(null);
  }, []);

  const doImportSource = useCallback(async (sourceId, selectedPaths) => {
    setImporting(sourceId);
    try {
      const payload = buildMarketplaceImportPayload(sourceId, previewData, selectedPaths);
      const res = await importLibrarySource(payload);
      if (!res?.ok) throw new Error(res?.error || "Import failed");
      const count = Number(res?.data?.importedCount || 0);
      const byType = res?.data?.importedByType || {};
      const details = [
        `agents ${Number(byType?.agent || 0)}`,
        `prompts ${Number(byType?.prompt || 0)}`,
        `skills ${Number(byType?.skill || 0)}`,
        `tools ${Number(byType?.mcp || 0)}`,
      ].join(", ");
      showToast(`Imported ${count} entries (${details})`, "success");
      setImportedSources((prev) => new Set([...prev, sourceId]));
      setPreviewData(null);
      setPreviewSourceId(null);
      if (typeof onImported === "function") onImported();
    } catch (err) {
      showToast(`Import failed: ${parseApiError(err)}`, "error");
    }
    setImporting(null);
  }, [onImported, previewData]);

  const doImportAll = useCallback(async (sourceId) => {
    setImporting(sourceId);
    try {
      const source = sources.find((entry) => entry.id === sourceId) || null;
      const res = await importLibrarySource(
        buildMarketplaceImportPayload(
          sourceId,
          source ? { source } : { source: { id: sourceId } },
          undefined,
        ),
      );
      if (!res?.ok) throw new Error(res?.error || "Import failed");
      const count = Number(res?.data?.importedCount || 0);
      showToast(`Imported ${count} entries from ${sourceId}`, "success");
      setImportedSources((prev) => new Set([...prev, sourceId]));
      if (typeof onImported === "function") onImported();
    } catch (err) {
      showToast(`Import failed: ${parseApiError(err)}`, "error");
    }
    setImporting(null);
  }, [onImported, sources]);

  const doCustomImport = useCallback(async () => {
    if (!customUrl.trim()) return;
    setScanning("custom");
    try {
      const res = await previewLibrarySource({ repoUrl: customUrl.trim(), branch: customBranch.trim() || "main" });
      if (!res?.ok) throw new Error(res?.error || "Preview failed");
      setPreviewData(res?.data);
      setPreviewSourceId("custom");
    } catch (err) {
      showToast(`Preview failed: ${parseApiError(err)}`, "error");
    }
    setScanning(null);
  }, [customUrl, customBranch]);

  return html`
    <div style="margin-top:10px;padding:12px;border:1px solid var(--border,#333);border-radius:10px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
        <div>
          <div style="font-size:0.95em;font-weight:600;">${iconText(":package: Library Marketplace")}</div>
          <div style="font-size:0.76em;color:var(--text-secondary);margin-top:2px;">
            Fast source metadata loads first; health and branch checks refresh separately.
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
          ${refreshing && !loading ? html`
            <span style="font-size:0.74em;color:var(--text-secondary);display:inline-flex;align-items:center;gap:5px;">
              <${Spinner} size=${12} /> Refreshing source health…
            </span>
          ` : null}
          <${Button} variant="text" size="small" onClick=${() => refreshSources({ probe: true, refresh: true, background: true })}
            disabled=${refreshing || loading}
            style=${{ fontSize: "0.75em", textTransform: "none" }}>
            ${refreshing && !loading ? "Refreshing…" : "Refresh Health"}
          <//>
          <${Button} variant="text" size="small" onClick=${() => setShowCustom((v) => !v)}
            style=${{ fontSize: "0.75em", textTransform: "none" }}>
            ${showCustom ? "Hide Custom URL" : "Custom URL Import"}
          <//>
        </div>
      </div>

      ${/* ── Search Bar ── */ ""}
      <input type="text" value=${searchText} onInput=${(e) => setSearchText(e.currentTarget.value)}
        placeholder="Search sources, descriptions, focuses…"
        style="width:100%;padding:8px 12px;border-radius:8px;border:1px solid var(--border,#333);background:var(--bg-input,#0d1117);color:var(--text-primary,#eee);margin-bottom:8px;font-size:0.85em;" />

      ${/* ── Category Filter Pills ── */ ""}
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">
        ${MARKETPLACE_CATEGORIES.map((cat) => html`
          <${Chip} key=${cat.id} label=${cat.label} size="small"
            variant=${activeCategory === cat.id ? "filled" : "outlined"}
            color=${activeCategory === cat.id ? "primary" : "default"}
            onClick=${() => setActiveCategory(cat.id)}
            style=${{ cursor: "pointer", fontSize: "0.78em" }} />
        `)}
      </div>

      ${/* ── Custom URL Import ── */ ""}
      ${showCustom && html`
        <div style="margin-bottom:10px;padding:10px;border:1px solid var(--border,#333);border-radius:8px;background:rgba(255,255,255,0.02);">
          <div style="font-size:0.82em;font-weight:500;margin-bottom:6px;">Custom Repository Import</div>
          <div style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:end;">
            <input type="text" value=${customUrl} onInput=${(e) => setCustomUrl(e.currentTarget.value)}
              placeholder="https://github.com/org/repo.git"
              style="width:100%;padding:6px 10px;border-radius:6px;border:1px solid var(--border,#333);background:var(--bg-input,#0d1117);color:var(--text-primary);font-size:0.82em;" />
            <input type="text" value=${customBranch} onInput=${(e) => setCustomBranch(e.currentTarget.value)}
              placeholder="main" style="width:80px;padding:6px 10px;border-radius:6px;border:1px solid var(--border,#333);background:var(--bg-input,#0d1117);color:var(--text-primary);font-size:0.82em;" />
          </div>
          <div style="margin-top:6px;">
            <${Button} variant="outlined" size="small" onClick=${doCustomImport} disabled=${scanning === "custom" || !customUrl.trim()}>
              ${scanning === "custom" ? html`<${Spinner} size=${14} /> Scanning…` : iconText(":mag: Preview")}
            <//>
          </div>
        </div>
      `}

      ${/* ── Loading State ── */ ""}
      ${loading && html`
        <div style="text-align:center;padding:20px;">
          <${Spinner} size=${24} />
          <div style="font-size:0.82em;color:var(--text-secondary);margin-top:8px;">Loading marketplace sources…</div>
        </div>
      `}

      ${/* ── Source Cards Grid ── */ ""}
      ${!loading && html`
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;">
          ${filteredSources.map((source) => {
            const trust = getTrustTier(source);
            const trustScore = Number(source?.trust?.score || 0);
            const est = Number(source.estimatedPlugins || 0);
            const isImported = importedSources.has(source.id);
            const isScanning = scanning === source.id;
            const isImporting = importing === source.id;
            const isExpanded = expandedSource === source.id;
            const focuses = (source.focuses || []).slice(0, 4);

            return html`
              <div key=${source.id} style="border:1px solid var(--border,#333);border-radius:10px;overflow:hidden;background:var(--bg-card,rgba(255,255,255,0.03));transition:border-color 0.2s;${isImported ? "border-color:#22c55e;" : ""}">
                <div style="padding:10px 12px;">
                  ${/* ── Card Header ── */ ""}
                  <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:6px;">
                    <span style="font-size:1em;">${trust.icon}</span>
                    <span style="font-size:0.88em;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${source.name}</span>
                    <span style="font-size:0.68em;padding:2px 8px;border-radius:999px;background:${trust.color}22;color:${trust.color};font-weight:500;">${trust.label}</span>
                    ${isImported && html`<span style="font-size:0.68em;padding:2px 8px;border-radius:999px;background:rgba(34,197,94,0.15);color:#22c55e;">✓ Imported</span>`}
                  </div>

                  ${/* ── Stats and description ── */ ""}
                  <div style="font-size:0.78em;color:var(--text-secondary);margin-bottom:4px;">
                    ${est > 0 ? `~${est} plugins` : ""}${est > 0 && focuses.length > 0 ? " · " : ""}${focuses.join(", ")}
                  </div>
                  ${source.description && html`
                    <div style="font-size:0.78em;color:var(--text-secondary);margin-bottom:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${source.description}</div>
                  `}

                  ${/* ── Trust Score Bar ── */ ""}
                  <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
                    <span style="font-size:0.72em;color:var(--text-secondary);min-width:55px;">Trust ${trustScore}/100</span>
                    <div style="flex:1;height:4px;border-radius:2px;background:rgba(255,255,255,0.08);overflow:hidden;">
                      <div style="height:100%;width:${trustScore}%;border-radius:2px;background:${trustScore >= 70 ? "#22c55e" : trustScore >= 40 ? "#f59e0b" : "#ef4444"};"></div>
                    </div>
                  </div>

                  ${/* ── Action Buttons ── */ ""}
                  <div style="display:flex;gap:6px;flex-wrap:wrap;">
                    <${Button} variant="outlined" size="small" onClick=${() => doPreviewSource(source.id)} disabled=${isScanning || isImporting || source.enabled === false}
                      style=${{ fontSize: "0.72em", padding: "3px 10px", textTransform: "none" }}>
                      ${isScanning ? html`<${Spinner} size=${12} />` : "Preview"}
                    <//>
                    <${Button} variant="outlined" size="small" onClick=${() => doImportAll(source.id)} disabled=${isScanning || isImporting || source.enabled === false}
                      style=${{ fontSize: "0.72em", padding: "3px 10px", textTransform: "none" }}>
                      ${isImporting ? html`<${Spinner} size=${12} />` : "Import All"}
                    <//>
                  </div>

                  ${/* ── Low trust warning ── */ ""}
                  ${source?.trust?.lowTrust && source.enabled !== false ? html`
                    <div style="font-size:0.72em;color:#f59e0b;margin-top:6px;padding:3px 6px;border-radius:4px;background:rgba(245,158,11,0.08);">⚠ Low trust — review before use</div>
                  ` : null}
                  ${source.enabled === false ? html`
                    <div style="font-size:0.72em;color:#ef4444;margin-top:6px;padding:3px 6px;border-radius:4px;background:rgba(239,68,68,0.08);">Unavailable</div>
                  ` : null}
                </div>
              </div>
            `;
          })}
        </div>
        ${filteredSources.length === 0 && html`
          <div style="text-align:center;padding:20px;color:var(--text-secondary);font-size:0.85em;">
            No sources match your search.
          </div>
        `}
      `}

      ${/* ── Preview Modal ── */ ""}
      ${previewData ? html`
        <${ImportPreviewModal}
          candidates=${previewData.candidates}
          blockedCandidates=${previewData.blockedCandidates}
          source=${previewData.source}
          duplicates=${previewData.duplicates}
          intraDuplicates=${previewData.intraDuplicates}
          onConfirm=${(selected) => doImportSource(previewSourceId, selected)}
          onClose=${() => { setPreviewData(null); setPreviewSourceId(null); }}
          loading=${importing != null}
        />
      ` : null}
    </div>
  `;
}

export function LibraryTab() {
  injectStyles();
  const [editing, setEditing] = useState(null);      // entry being edited, or {} for new
  const [loading, setLoading] = useState(false);
  const [importAgents, setImportAgents] = useState(true);
  const [importSkills, setImportSkills] = useState(true);
  const [importPrompts, setImportPrompts] = useState(true);
  const [importTools, setImportTools] = useState(true);
  const isMountedRef = useRef(true);
  const loadEntriesRequestRef = useRef(0);

  // Load all entries on mount and type/search changes
  const loadEntries = useCallback(async () => {
    const requestId = ++loadEntriesRequestRef.current;
    if (isMountedRef.current) {
      setLoading(true);
    }
    try {
      if (!importAgents && !importPrompts && !importSkills && !importTools) {
        throw new Error("Select at least one import type");
      }
      const [filteredEntries, globalEntries] = await Promise.all([
        fetchEntries(filterType.value),
        apiFetch("/api/library").then((res) => res?.data || []),
      ]);
      if (!isMountedRef.current || requestId !== loadEntriesRequestRef.current) return;
      entries.value = filteredEntries;
      allEntries.value = globalEntries;
      initialized.value = globalEntries.length > 0;
    } catch (err) {
      if (isMountedRef.current && requestId === loadEntriesRequestRef.current) {
        showToast("Failed to load library: " + err.message, "error");
      }
    } finally {
      if (isMountedRef.current && requestId === loadEntriesRequestRef.current) {
        setLoading(false);
      }
    }
  }, [importAgents, importPrompts, importSkills, importTools]);

  useEffect(() => { loadEntries(); }, [filterType.value]);

  useEffect(() => {
    const onWorkspaceSwitched = () => {
      setEditing(null);
      loadEntries();
    };
    window.addEventListener("ve:workspace-switched", onWorkspaceSwitched);
    return () => {
      window.removeEventListener("ve:workspace-switched", onWorkspaceSwitched);
    };
  }, [loadEntries]);

  // Debounced search
  const searchTimer = useRef(null);
  useEffect(() => () => {
    isMountedRef.current = false;
    clearTimeout(searchTimer.current);
  }, []);
  const handleSearch = useCallback((value) => {
    searchQuery.value = value;
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(loadEntries, 300);
  }, [loadEntries]);

  const handleInit = useCallback(async () => {
    setLoading(true);
    try {
      if (!importAgents && !importPrompts && !importSkills && !importTools) {
        throw new Error("Select at least one import type");
      }
      const res = await doInit();
      if (res?.ok) {
        showToast(`Library initialized: ${res.data?.entries || 0} entries, ${res.data?.scaffolded || 0} profiles scaffolded`, "success");
        await loadEntries();
      } else {
        showToast(res?.error || "Init failed", "error");
      }
    } catch (err) {
      showToast(err.message, "error");
    }
    setLoading(false);
  }, [loadEntries]);

  const handleRebuild = useCallback(async () => {
    try {
      const res = await doRebuild();
      if (res?.ok) {
        showToast(`Rebuilt: ${res.data?.count || 0} entries (${res.data?.added || 0} added, ${res.data?.removed || 0} removed)`, "success");
        await loadEntries();
      }
    } catch (err) {
      showToast(err.message, "error");
    }
  }, [loadEntries]);

  const handleSelect = useCallback((entry) => {
    haptic("light");
    setEditing(entry);
  }, []);

  const handleCreateAudioAgent = useCallback((templateKey) => {
    const template = AUDIO_AGENT_TEMPLATES[templateKey];
    if (!template) return;
    haptic("light");
    setEditing({ ...template });
  }, []);

  const handleSaved = useCallback(() => {
    setEditing(null);
    loadEntries();
  }, [loadEntries]);

  const handleDeleted = useCallback(() => {
    setEditing(null);
    loadEntries();
  }, [loadEntries]);

  // Filter entries for display
  const displayed = useMemo(() => {
    let list = entries.value;
    if (filterType.value !== "all") {
      list = list.filter((e) => e.type === filterType.value);
    }
    return list;
  }, [entries.value, filterType.value]);

  const groupedAgentSections = useMemo(() => {
    if (filterType.value !== "agent") return [];
    const interactive = displayed.filter((entry) => entry.agentCategory === "interactive");
    const voice = displayed.filter((entry) => entry.agentCategory === "voice");
    const task = displayed.filter((entry) => !entry.agentCategory || entry.agentCategory === "task");
    return [
      { key: "interactive", title: "Manual Chat Agents", items: interactive },
      { key: "voice", title: "Voice Agents", items: voice },
      { key: "task", title: "Task Templates", items: task },
    ].filter((section) => section.items.length > 0);
  }, [displayed, filterType.value]);

  return html`
    <div class="library-root">
      <div class="library-header">
        <h2>${iconText(":book: Library")}</h2>
        <${Button} variant="outlined" size="small" onClick=${() => handleCreateAudioAgent("female")}>
          ${iconText(":mic: New Female Audio Agent")}
        <//>
        <${Button} variant="outlined" size="small" onClick=${() => handleCreateAudioAgent("male")}>
          ${iconText(":mic: New Male Audio Agent")}
        <//>
        <${Button} variant="outlined" size="small" onClick=${handleRebuild}
          title="Rescan directories and rebuild manifest">
          ${iconText(":refresh: Rebuild")}
        <//>
        <${Button} variant="contained" size="small" onClick=${() => setEditing({})}>
          ${iconText("➕ New")}
        <//>
      </div>

      ${!initialized.value && !loading && html`
        <div class="library-init-banner">
          <p><b>Welcome to the Library!</b></p>
          <p>Initialize to scaffold built-in agent profiles and index existing prompts and skills.</p>
          <${Button} variant="contained" size="small" onClick=${handleInit}>${iconText(":rocket: Initialize Library")}<//>
        </div>
      `}

      <${LibraryStats} />

      <div class="library-toolbar">
        <div class="search-wrap">
          <${SearchInput}
            value=${searchQuery.value}
            onInput=${(e) => handleSearch(e.target.value)}
            placeholder="Search prompts, agents, skills, MCP servers..." />
        </div>
        <${TypePills} />
      </div>

      ${filterType.value !== "mcp" && html`<${ProfileMatcher} />`}
      ${filterType.value !== "mcp" && html`<${ScopeDetector} />`}

      ${/* ── MCP Marketplace View ── */
        filterType.value === "mcp" && html`
          <${McpMarketplace} onInstalled=${loadEntries} />
        `
      }

      ${filterType.value !== "mcp" && loading && html`
        <div style="text-align:center;padding:40px;"><${Spinner} /> Loading library...</div>
      `}

      ${filterType.value !== "mcp" && !loading && displayed.length === 0 && initialized.value && html`
        <${EmptyState}
          icon="book"
          title="No resources found"
          message=${searchQuery.value
            ? "Try a different search term or clear the filter."
            : "Create your first prompt, agent profile, or skill."}
          action=${searchQuery.value
            ? { label: "Clear search", onClick: () => { searchQuery.value = ""; loadEntries(); } }
            : { label: "➕ New Resource", onClick: () => setEditing({}) }} />
      `}

      ${filterType.value !== "mcp" && !loading && displayed.length > 0 && html`
        ${filterType.value === "agent"
          ? html`
            ${groupedAgentSections.map((section) => html`
              <${Box} key=${section.key} sx=${{ display: "flex", flexDirection: "column", gap: 1.25, mb: 2 }}>
                <${Stack} direction="row" alignItems="center" spacing=${1}>
                  <${Typography} variant="subtitle2">${section.title}<//>
                  <${Chip} label=${section.items.length} size="small" variant="outlined" />
                <//>
                <div class="library-grid">
                  ${section.items.map((e) => html`
                    <${LibraryCard} key=${e.id} entry=${e} onSelect=${handleSelect} />
                  `)}
                </div>
              </${Box}>
            `)}
          `
          : html`
            <div class="library-grid">
              ${displayed.map((e) => html`
                <${LibraryCard} key=${e.id} entry=${e} onSelect=${handleSelect} />
              `)}
            </div>
          `}
      `}

      ${editing && html`
        <${EntryEditor}
          entry=${editing}
          onClose=${() => setEditing(null)}
          onSaved=${handleSaved}
          onDeleted=${handleDeleted} />
      `}
    </div>
  `;
}

export function LibraryMarketplaceTab() {
  injectStyles();

  const handleImported = useCallback(() => {
    refreshTab("library", { background: true, manual: false, force: true });
  }, []);

  return html`
    <div class="library-root">
      <div class="library-header">
        <h2>${iconText(":package: Marketplace")}</h2>
      </div>
      <${LibraryMarketplace} onImported=${handleImported} />
    </div>
  `;
}
