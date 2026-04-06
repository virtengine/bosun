/* ─────────────────────────────────────────────────────────────
 *  Tab: Settings — Two-mode settings UI
 *  Mode 1: App Preferences (client-side, CloudStorage/localStorage)
 *  Mode 2: Server Config (.env management via settings API)
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

import {
  haptic,
  showConfirm,
  showAlert,
  cloudStorageGet,
  cloudStorageSet,
  cloudStorageRemove,
} from "../modules/telegram.js";
import { apiFetch, wsConnected } from "../modules/api.js";
import { iconText, resolveIcon } from "../modules/icon-utils.js";
import {
  connected,
  statusData,
  executorData,
  configData,
  showToast,
  pendingChanges,
  setPendingChange,
  clearPendingChange,
} from "../modules/state.js";
import {
  Card,
  Badge,
  ListItem,
  SkeletonCard,
  Modal,
  ConfirmDialog,
  Spinner,
} from "../components/shared.js";
import {
  SegmentedControl,
  Collapsible,
  Toggle,
  SearchInput,
} from "../components/forms.js";
import {
  Typography, Box, Stack, Button, IconButton, Chip, TextField,
  Select, MenuItem, FormControl, InputLabel, Switch, FormControlLabel,
  Tooltip, Alert, Paper, Divider, CircularProgress, Dialog, DialogTitle,
  DialogContent, DialogActions, InputAdornment, Tabs, Tab, Slider,
} from "@mui/material";
import {
  CATEGORIES,
  SETTINGS_SCHEMA,
  getGroupedSettings,
  validateSetting,
  SENSITIVE_KEYS,
} from "../modules/settings-schema.js";
import {
  inferStructuredInputKind,
  isStructuredValue,
  toEditableTextValue,
} from "../modules/structured-values.js";

const SETTINGS_EXTERNAL_EDITORS = new Map();

function registerSettingsExternalEditor(editorId, editorOps) {
  const key = String(editorId || "").trim();
  if (!key || !editorOps || typeof editorOps !== "object") {
    return () => {};
  }
  SETTINGS_EXTERNAL_EDITORS.set(key, editorOps);
  return () => {
    const current = SETTINGS_EXTERNAL_EDITORS.get(key);
    if (current === editorOps) SETTINGS_EXTERNAL_EDITORS.delete(key);
  };
}

async function runSettingsExternalEditorAction(action) {
  const mode = action === "discard" ? "discard" : "save";
  const errors = [];
  for (const [key, ops] of SETTINGS_EXTERNAL_EDITORS.entries()) {
    const isDirty = Boolean(ops?.isDirty?.());
    if (!isDirty) continue;
    const fn = mode === "discard" ? ops?.discard : ops?.save;
    if (typeof fn !== "function") continue;
    try {
      await fn();
    } catch (err) {
      const message = err?.message || "Action failed";
      errors.push(`${key}: ${message}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join(" | "));
  }
}

/* ─── Scoped Styles ─── */
const SETTINGS_STYLES = `
/* Category navigation */
.settings-category-mobile {
  display: none;
  margin-bottom: 10px;
}
.settings-category-mobile-label {
  display: block;
  font-size: 12px;
  color: var(--text-tertiary, #8a8a8a);
  margin: 0 0 6px 2px;
}
/* Category pill tabs — horizontal scrollable row */
.settings-category-tabs {
  display: flex;
  overflow-x: auto;
  gap: 8px;
  padding: 8px 0;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}
.settings-category-tabs::-webkit-scrollbar { display: none; }
.settings-category-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 20px;
  border: 1px solid var(--border, rgba(255,255,255,0.08));
  background: var(--card-bg, rgba(255,255,255,0.04));
  color: var(--text-secondary, #999);
  font-size: 13px;
  white-space: nowrap;
  cursor: pointer;
  transition: all 0.2s ease;
  flex-shrink: 0;
}
.settings-category-tab:hover {
  border-color: var(--accent, #5b6eae);
  color: var(--text-primary, #fff);
}
.settings-category-tab.active {
  background: var(--accent, #5b6eae);
  border-color: var(--accent, #5b6eae);
  color: var(--accent-text, #fff);
  font-weight: 600;
}
.settings-category-tab-icon { font-size: 15px; }
.settings-mode-switch .MuiToggleButtonGroup-root {
  width: 100%;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.settings-mode-switch .MuiToggleButton-root {
  min-width: 0;
  padding-inline: 10px;
  line-height: 1.2;
}
/* Search wrapper */
.settings-search { margin-bottom: 8px; }
.settings-arch-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}
.settings-arch-card {
  padding: 12px;
  border-radius: 12px;
  border: 1px solid var(--border, rgba(255,255,255,0.08));
  background: color-mix(in srgb, var(--bg-card, rgba(17, 24, 39, 0.82)) 88%, transparent);
}
.settings-arch-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-primary, #fff);
  margin-bottom: 6px;
}
.settings-arch-current {
  font-size: 12px;
  color: var(--accent, #5a7cff);
  margin-bottom: 8px;
}
.settings-arch-note {
  font-size: 12px;
  color: var(--text-secondary, #94a3b8);
  line-height: 1.5;
}
.settings-arch-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}
.settings-arch-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 999px;
  border: 1px solid var(--border, rgba(255,255,255,0.08));
  background: rgba(255,255,255,0.03);
  color: var(--text-secondary, #cbd5e1);
  font-size: 11px;
}
.settings-arch-chip.active {
  border-color: color-mix(in srgb, var(--accent, #5a7cff) 55%, transparent);
  background: color-mix(in srgb, var(--accent, #5a7cff) 18%, transparent);
  color: var(--text-primary, #fff);
}
/* Floating save bar */
.settings-save-bar {
  position: fixed;
  bottom: calc(var(--nav-height, 60px) + var(--safe-bottom, 0px) + 12px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 999;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  row-gap: 8px;
  padding: 10px 16px;
  min-width: min(240px, calc(100vw - 24px));
  max-width: 480px;
  width: min(480px, calc(100vw - 24px));
  background: var(--glass-bg, rgba(30,30,46,0.95));
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid var(--border, rgba(255,255,255,0.08));
  border-radius: 12px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.3);
  transition: all 0.2s ease;
  animation: slideUp 0.25s ease;
}
.settings-save-bar--dirty {
  border-color: var(--accent, #5b6eae);
  box-shadow: 0 4px 20px rgba(91, 110, 174, 0.25);
}
.settings-save-bar--clean .save-bar-info {
  color: var(--text-hint, #666);
  font-size: 12px;
}
.setting-modified-dot--clean {
  background: var(--text-hint, #666) !important;
  opacity: 0.4;
}
@keyframes slideUp {
  from { transform: translateX(-50%) translateY(20px); opacity: 0; }
  to   { transform: translateX(-50%) translateY(0);    opacity: 1; }
}
.settings-save-bar .save-bar-info {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-secondary, #999);
  min-width: 0;
  flex: 1 1 auto;
}
.settings-save-bar .save-bar-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
  flex-wrap: wrap;
  margin-left: auto;
}
@media (min-width: 1400px) {
  .settings-save-bar {
    bottom: 20px;
  }
}
/* Individual setting row */
.setting-row {
  padding: 12px 0;
  border-bottom: 1px solid var(--border, rgba(255,255,255,0.05));
  overflow: visible;
  max-width: 100%;
  position: relative;
}
.setting-row:last-child { border-bottom: none; }
.setting-row-header {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 8px;
  flex-wrap: wrap;
  row-gap: 4px;
  max-width: 100%;
}
.setting-row-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary, #fff);
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.setting-row-key {
  font-size: 11px;
  font-family: monospace;
  color: var(--text-tertiary, #666);
  opacity: 0.7;
  max-width: 100%;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
  word-break: break-all;
}
/* Help tooltip */
.setting-help-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px; height: 20px;
  border-radius: 50%;
  border: 1px solid var(--border, rgba(255,255,255,0.15));
  background: transparent;
  color: var(--text-secondary, #999);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;
  position: relative;
}
.setting-help-tooltip {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  background: var(--glass-bg, rgba(30,30,46,0.95));
  backdrop-filter: blur(12px);
  border: 1px solid var(--border, rgba(255,255,255,0.12));
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 12px;
  font-weight: 400;
  color: var(--text-secondary, #bbb);
  min-width: 220px;
  max-width: 320px;
  z-index: 200;
  white-space: normal;
  line-height: 1.5;
  box-shadow: 0 8px 24px rgba(0,0,0,0.3);
  pointer-events: none;
}
/* Modified dot */
.setting-modified-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: var(--warning, #f5a623);
  flex-shrink: 0;
}
/* Default tag */
.setting-default-tag {
  font-size: 11px;
  color: var(--text-tertiary, #666);
  font-style: italic;
  margin-left: 4px;
}
/* Secret toggle eye button */
.setting-secret-toggle {
  background: transparent;
  border: 1px solid var(--border, rgba(255,255,255,0.12));
  border-radius: 6px;
  padding: 4px 8px;
  cursor: pointer;
  color: var(--text-secondary, #999);
  font-size: 14px;
  flex-shrink: 0;
}
/* Input wrappers */
.setting-input-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: visible;
  max-width: 100%;
  flex-wrap: wrap;
  min-width: 0;
}
.setting-input-wrap input[type="text"],
.setting-input-wrap input[type="number"],
.setting-input-wrap input[type="password"],
.setting-input-wrap textarea,
.setting-input-wrap select {
  flex: 1 1 220px;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--border, rgba(255,255,255,0.1));
  background: var(--input-bg, rgba(255,255,255,0.04));
  color: var(--text-primary, #fff);
  font-size: 13px;
  outline: none;
  transition: border-color 0.2s;
  min-width: 0;
  max-width: 100%;
}
.setting-input-wrap input:focus,
.setting-input-wrap textarea:focus,
.setting-input-wrap select:focus {
  border-color: var(--accent, #5b6eae);
}
.setting-input-wrap textarea {
  min-height: 60px;
  resize: vertical;
  font-family: monospace;
}
.setting-input-wrap select {
  appearance: auto;
}
.setting-input-wrap--secret {
  align-items: stretch;
}
.setting-secret-field {
  width: 100%;
}
.setting-secret-field .MuiOutlinedInput-root {
  padding-right: 4px;
}
.setting-input-wrap select option {
  background: #ffffff;
  color: #111827;
}
.setting-unit {
  font-size: 12px;
  color: var(--text-tertiary, #666);
  white-space: nowrap;
}
.setting-validation-error {
  font-size: 12px;
  color: var(--destructive, #e74c3c);
  margin-top: 4px;
  padding-left: 2px;
}
/* Banner styles */
.settings-banner {
  padding: 12px 16px;
  border-radius: 10px;
  margin-bottom: 12px;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 13px;
}
.settings-banner-error {
  background: rgba(231,76,60,0.12);
  border: 1px solid rgba(231,76,60,0.25);
  color: var(--destructive, #e74c3c);
}
.settings-banner-warn {
  background: rgba(245,166,35,0.12);
  border: 1px solid rgba(245,166,35,0.25);
  color: var(--warning, #f5a623);
}
.settings-banner-info {
  background: rgba(90,124,255,0.12);
  border: 1px solid rgba(90,124,255,0.25);
  color: var(--accent, #5a7cff);
}
.settings-banner-text { flex: 1; }
.settings-banner-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-primary, #fff);
  margin-bottom: 8px;
}
.settings-banner-paths {
  gap: 12px;
}
.settings-banner-paths .settings-banner-text {
  min-width: 0;
}
.settings-banner-path-list {
  display: grid;
  gap: 8px;
}
.settings-banner-path {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--bg-card, rgba(17, 24, 39, 0.82)) 82%, transparent);
  border: 1px solid color-mix(in srgb, var(--border, rgba(148, 163, 184, 0.22)) 88%, transparent);
}
.settings-banner-path-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-secondary, #94a3b8);
}
.settings-banner code {
  display: block;
  overflow-wrap: anywhere;
  word-break: break-word;
  white-space: pre-wrap;
  font-size: 12px;
  line-height: 1.45;
}
/* Diff display for confirm dialog */
.settings-diff {
  max-height: 300px;
  overflow-y: auto;
  font-family: monospace;
  font-size: 12px;
  background: var(--input-bg, rgba(255,255,255,0.03));
  border-radius: 8px;
  padding: 12px;
  margin: 12px 0;
}
.settings-diff-row {
  padding: 4px 0;
  border-bottom: 1px solid var(--border, rgba(255,255,255,0.04));
}
.settings-diff-key {
  font-weight: 600;
  color: var(--text-primary, #fff);
  margin-bottom: 2px;
}
.settings-diff-old { color: var(--destructive, #e74c3c); }
.settings-diff-new { color: var(--success, #2ecc71); }
/* Empty search state */
.settings-empty-search {
  text-align: center;
  padding: 32px 16px;
  color: var(--text-secondary, #999);
}
.settings-empty-search-icon { font-size: 32px; margin-bottom: 8px; }
/* Category description text */
.settings-cat-desc {
  font-size: 12px;
  color: var(--text-tertiary, #666);
  margin-bottom: 8px;
  padding: 0 2px;
}
/* Settings tab needs extra bottom padding for save bar + nav */
.settings-content-scroll {
  padding-bottom: 160px;
}
/* Constrain settings content width on wide viewports */
.settings-content-constrained {
  max-width: 900px;
  margin-left: auto;
  margin-right: auto;
  width: 100%;
  box-sizing: border-box;
  padding-bottom: calc(var(--nav-height, 56px) + var(--safe-bottom, 0px) + 48px);
  overflow-x: auto;
  min-width: 0;
}
.settings-content-constrained > * {
  min-width: 0;
}

.setting-row .segmented-control {
  display: flex;
  width: 100%;
  flex-wrap: wrap;
  margin-bottom: 0;
}
.setting-row .segmented-btn {
  flex: 1 1 96px;
  min-width: 0;
}

body.settings-save-open .main-content {
  padding-bottom: calc(var(--nav-height) + var(--safe-bottom) + 110px);
}
@media (min-width: 1400px) {
  body.settings-save-open .main-content {
    padding-bottom: 140px;
  }
}
/* Theme picker grid */
.theme-picker-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(108px, 1fr));
  gap: 10px;
  margin-bottom: 16px;
}
.theme-swatch {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 10px 8px;
  border-radius: 12px;
  border: 1px solid var(--border, rgba(255,255,255,0.12));
  background: color-mix(in srgb, var(--bg-card, #222) 86%, transparent);
  cursor: pointer;
  transition: transform 0.16s ease, border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
  font-family: inherit;
}
.theme-swatch:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--accent, #da7756) 42%, var(--border, rgba(255,255,255,0.2)));
  background: color-mix(in srgb, var(--bg-card, #222) 92%, var(--accent, #da7756) 8%);
}
.theme-swatch.active {
  border-color: var(--accent, #da7756);
  background: color-mix(in srgb, var(--accent, #da7756) 14%, var(--bg-card, #222));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent, #da7756) 45%, transparent), 0 8px 20px rgba(0,0,0,0.2);
}
.theme-swatch-preview {
  display: flex;
  width: 100%;
  height: 46px;
  gap: 3px;
  border-radius: 6px;
  overflow: hidden;
}
.swatch-bg, .swatch-accent {
  flex: 1;
  border-radius: 4px;
  box-shadow: inset 0 1px 3px rgba(0,0,0,0.3);
}
.swatch-label {
  font-size: 12px;
  font-weight: 600;
  text-align: center;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary, #fff);
}
.swatch-desc {
  font-size: 11px;
  color: var(--text-tertiary, #666);
  text-align: center;
}
.theme-swatch-state {
  font-size: 10px;
  line-height: 1;
  color: var(--accent, #da7756);
  font-weight: 600;
  min-height: 10px;
}

@media (max-width: 900px) {
  .settings-category-mobile {
    display: block;
  }
  .settings-category-tabs {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    overflow-x: visible;
    padding: 4px 0 8px;
  }
  .settings-category-tab {
    width: 100%;
    border-radius: 12px;
    min-height: 42px;
    padding: 10px 12px;
    justify-content: flex-start;
    white-space: normal;
    line-height: 1.25;
  }
}

@media (max-width: 700px) {
  .settings-save-bar {
    left: 12px;
    right: 12px;
    width: auto;
    max-width: none;
    transform: none;
    padding: 10px 12px;
  }
  @keyframes slideUp {
    from { transform: translateY(20px); opacity: 0; }
    to   { transform: translateY(0);    opacity: 1; }
  }
  .settings-save-bar .save-bar-actions {
    width: 100%;
    justify-content: flex-end;
  }
  .settings-mode-switch .MuiToggleButton-root {
    font-size: 12px;
    padding-inline: 8px;
  }
  .setting-input-wrap {
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
  }
  .setting-input-wrap input[type="text"],
  .setting-input-wrap input[type="number"],
  .setting-input-wrap input[type="password"],
  .setting-input-wrap textarea,
  .setting-input-wrap select {
    width: 100%;
    flex: 1 1 auto;
  }
  .setting-unit {
    align-self: flex-end;
  }
  .setting-help-tooltip {
    left: 0;
    transform: none;
    min-width: 0;
    max-width: min(92vw, 360px);
  }
}

@media (max-width: 640px) {
  .settings-category-tabs {
    display: none;
  }
  .settings-mode-switch .MuiToggleButtonGroup-root {
    grid-template-columns: 1fr;
  }
  .settings-mode-switch .MuiToggleButton-root {
    justify-content: flex-start;
  }
  .setting-row .segmented-btn {
    flex: 1 1 calc(50% - 4px);
  }
}
`;

/* ─── Inject styles once ─── */
let _stylesInjected = false;
function injectStyles() {
  if (_stylesInjected) return;
  _stylesInjected = true;
  const el = document.createElement("style");
  el.textContent = SETTINGS_STYLES;
  document.head.appendChild(el);
}

/* ─── CloudStorage helpers (for App Preferences mode) ─── */
function cloudGet(key) {
  return new Promise((resolve) => {
    cloudStorageGet(key)
      .then((val) => {
        if (val == null) {
          try {
            const v = localStorage.getItem("ve_settings_" + key);
            resolve(v != null ? JSON.parse(v) : null);
          } catch {
            resolve(null);
          }
          return;
        }
        try {
          resolve(JSON.parse(val));
        } catch {
          resolve(val);
        }
      })
      .catch(() => {
        try {
          const v = localStorage.getItem("ve_settings_" + key);
          resolve(v != null ? JSON.parse(v) : null);
        } catch {
          resolve(null);
        }
      });
  });
}

function cloudSet(key, value) {
  const str = JSON.stringify(value);
  cloudStorageSet(key, str).then((ok) => {
    if (ok) return;
    try {
      localStorage.setItem("ve_settings_" + key, str);
    } catch {
      /* noop */
    }
  }).catch(() => {
    try {
      localStorage.setItem("ve_settings_" + key, str);
    } catch {
      /* noop */
    }
  });
}

function cloudRemove(key) {
  cloudStorageRemove(key).then((ok) => {
    if (ok) return;
    try {
      localStorage.removeItem("ve_settings_" + key);
    } catch {
      /* noop */
    }
  }).catch(() => {
    try {
      localStorage.removeItem("ve_settings_" + key);
    } catch {
      /* noop */
    }
  });
}

/* ─── Version info ─── */
let APP_VERSION = "loading...";
let APP_NAME = "Bosun";

// Fetch version from API
(async () => {
  try {
    const res = await fetch("/api/config");
    const data = await res.json();
    if (data.ok && data.version) {
      APP_VERSION = data.version;
    }
  } catch {
    APP_VERSION = "unknown";
  }
})();

/* ─── Fuzzy search helper ─── */
function fuzzyMatch(needle, haystack) {
  if (!needle) return true;
  const lower = haystack.toLowerCase();
  const terms = needle.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((t) => lower.includes(t));
}

/* ─── Mask a sensitive value for display ─── */
function maskValue(val) {
  if (!val || val === "") return "";
  const s = String(val);
  if (s.length <= 4) return "••••";
  return "••••••" + s.slice(-4);
}

const EXECUTOR_SECTION_ORDER = [
  "Primary Runtime",
  "Harness Control Plane",
  "Shared Provider Fallbacks",
  "Harness Provider Credentials",
  "Queued Task Engine",
  "SDK/CLI Compatibility",
  "SDK/CLI Availability",
  "SDK/CLI Model Profiles",
  "Other",
];

const EXECUTOR_SECTION_DESCRIPTIONS = {
  "Primary Runtime": "Choose whether Bosun runs primarily on the Bosun-native Harness or the legacy SDK/CLI stack.",
  "Harness Control Plane": "Harness activation, profile source, and validation settings for the Bosun-native runtime.",
  "Shared Provider Fallbacks": "Dormant family-level fallbacks for Harness. These matter only when a named Harness executor does not already define the runtime instance, endpoint, and model posture Bosun should use.",
  "Harness Provider Credentials": "Shared API keys and endpoint-level credentials that Harness executors can inherit when they do not supply their own endpoint overrides.",
  "Queued Task Engine": "Concurrency, timeouts, retries, review handoff, and planning posture for Bosun's queued task engine.",
  "SDK/CLI Compatibility": "Legacy shell runtime selection, SDK family pinning, and routing behavior used only when SDK/CLI mode is primary.",
  "SDK/CLI Availability": "Disable legacy SDK families you never want Bosun to consider in compatibility mode.",
  "SDK/CLI Model Profiles": "Legacy SDK-specific model and profile settings. Hidden while Harness is primary.",
  "Other": "Additional executor settings.",
};

function normalizeAgentRuntimeValue(value) {
  return String(value || "").trim().toLowerCase() === "sdk-cli"
    ? "sdk-cli"
    : "harness";
}

function isSdkOnlyExecutorKey(key) {
  if (!key) return false;
  return [
    "PRIMARY_AGENT",
    "INTERNAL_EXECUTOR_SDK",
    "EXECUTORS",
    "EXECUTOR_DISTRIBUTION",
    "FAILOVER_STRATEGY",
    "COMPLEXITY_ROUTING_ENABLED",
    "CODEX_SDK_DISABLED",
    "COPILOT_SDK_DISABLED",
    "CLAUDE_SDK_DISABLED",
    "GEMINI_SDK_DISABLED",
    "OPENCODE_SDK_DISABLED",
    "CODEX_MODEL",
    "CODEX_MODEL_PROFILE",
    "CODEX_MODEL_PROFILE_SUBAGENT",
    "CODEX_MODEL_PROFILE_XL_PROVIDER",
    "CODEX_MODEL_PROFILE_XL_MODEL",
    "CODEX_MODEL_PROFILE_XL_BASE_URL",
    "CODEX_MODEL_PROFILE_XL_API_KEY",
    "CODEX_MODEL_PROFILE_M_PROVIDER",
    "CODEX_MODEL_PROFILE_M_MODEL",
    "CODEX_MODEL_PROFILE_M_BASE_URL",
    "CODEX_MODEL_PROFILE_M_API_KEY",
    "CODEX_SUBAGENT_MODEL",
    "CLAUDE_MODEL",
    "GEMINI_MODEL",
    "GEMINI_TRANSPORT",
    "OPENCODE_MODEL",
    "COPILOT_MODEL",
    "COPILOT_CLI_TOKEN",
  ].includes(key);
}

function isHarnessProviderFabricSetting(def) {
  return String(def?.section || "").trim() === "Harness Provider Fabric";
}

function emitAgentInventoryRefresh(detail = {}) {
  try {
    if (typeof globalThis?.dispatchEvent !== "function" || typeof globalThis?.CustomEvent !== "function") return;
    globalThis.dispatchEvent(new CustomEvent("ve:agents-refresh", { detail }));
  } catch {
    // Non-browser or unsupported host.
  }
}

function isExecutorSettingVisible(def, runtime = "harness", options = {}) {
  const key = String(def?.key || "");
  if (!key) return true;
  if (key === "EXECUTOR_MODE") return false;
  if (runtime === "harness" && isSdkOnlyExecutorKey(key)) return false;
  if (
    runtime === "harness"
    && options.hasExplicitHarnessExecutors === true
    && isHarnessProviderFabricSetting(def)
  ) return false;
  return true;
}

function getExecutorSection(def) {
  const key = String(def?.key || "");
  if (!key) return "Other";
  if (key === "BOSUN_AGENT_RUNTIME") return "Primary Runtime";
  if (def?.section === "Harness Control Plane") return "Harness Control Plane";
  if (def?.section === "Harness Provider Fabric") return "Shared Provider Fallbacks";
  if (def?.section === "Harness Provider Credentials") return "Harness Provider Credentials";
  if (def?.section === "Queued Task Execution") return "Queued Task Engine";
  if (def?.section === "SDK/CLI Compatibility") return "SDK/CLI Compatibility";
  if ([
    "INTERNAL_EXECUTOR_REVIEW_AGENT_ENABLED",
    "INTERNAL_EXECUTOR_REPLENISH_ENABLED",
    "INTERNAL_EXECUTOR_PARALLEL",
    "INTERNAL_EXECUTOR_TIMEOUT_MS",
    "INTERNAL_EXECUTOR_MAX_RETRIES",
    "INTERNAL_EXECUTOR_POLL_MS",
    "PROJECT_REQUIREMENTS_PROFILE",
  ].includes(key)) return "Queued Task Engine";
  if (key.endsWith("_SDK_DISABLED")) return "SDK/CLI Availability";
  if (
    key.startsWith("CODEX_")
    || key.startsWith("CLAUDE_")
    || key.startsWith("GEMINI_")
    || key.startsWith("GOOGLE_")
    || key === "COPILOT_MODEL"
    || key === "COPILOT_CLI_TOKEN"
    || key === "OPENCODE_MODEL"
  ) return "SDK/CLI Model Profiles";
  return "Other";
}

function groupExecutorSettings(defs = []) {
  const groups = new Map();
  for (const def of defs) {
    const section = getExecutorSection(def);
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section).push(def);
  }
  return EXECUTOR_SECTION_ORDER
    .filter((section) => groups.has(section))
    .map((section) => ({
      title: section,
      description: EXECUTOR_SECTION_DESCRIPTIONS[section] || "",
      defs: groups.get(section),
    }));
}

function formatCountdownSeconds(ms) {
  const remaining = Math.max(0, Number(ms) || 0);
  return Math.ceil(remaining / 1000);
}

function AgentArchitectureGuide({ architecture }) {
  if (!architecture) return null;
  const sections = Array.isArray(architecture.sections)
    ? architecture.sections.filter(Boolean)
    : [
        architecture.runtimeArchitecture,
        architecture.providerFabric,
        architecture.queuedExecution,
        architecture.sdkCompatibility,
      ].filter(Boolean);
  if (sections.length === 0) return null;
  return html`
    <${Card}>
      <div class="card-subtitle mb-sm" style="font-size:13px;font-weight:700">Bosun Runtime Architecture</div>
      <div class="meta-text mb-sm">
        Pick the primary runtime first. When Harness is primary, only harness-native provider and task controls stay visible; legacy SDK/CLI compatibility settings stay out of the way until you switch back.
      </div>
      <div class="settings-arch-grid">
        ${sections.map((section) => html`
          <div class="settings-arch-card" key=${section.title}>
            <div class="settings-arch-title">${section.title}</div>
            ${(section.currentLabel || section.current) && html`
              <div class="settings-arch-current">Current: <code>${section.currentLabel || section.current}</code></div>
            `}
            <div class="settings-arch-note">${section.summary}</div>
            ${section.note && html`<div class="settings-arch-note" style="margin-top:8px">${section.note}</div>`}
            ${Array.isArray(section.items) && section.items.length > 0 && html`
              <div class="settings-arch-list">
                ${section.items.slice(0, 8).map((item) => html`
                  <span class=${`settings-arch-chip ${item.selected ? "active" : ""}`.trim()}>
                    ${item.label || item.providerId || item.id}
                    ${item.statusLabel || (item.authenticated ? "connected" : item.selected ? "selected" : "")}
                  </span>
                `)}
              </div>
            `}
          </div>
        `)}
      </div>
    <//>
  `;
}

const HARNESS_EXECUTOR_API_STYLE_OPTIONS = [
  { value: "provider-default", label: "Provider default" },
  { value: "responses", label: "Responses API" },
  { value: "chat-completions", label: "Chat Completions API" },
];

const HARNESS_EXECUTOR_ENDPOINT_PROVIDER_IDS = new Set([
  "azure-openai-responses",
  "openai-responses",
  "openai-compatible",
  "ollama",
  "gemini-generate-content",
]);

const HARNESS_EXECUTOR_CONFIGURABLE_API_STYLE_PROVIDER_IDS = new Set([
  "azure-openai-responses",
  "openai-responses",
  "openai-compatible",
  "ollama",
]);

function normalizeHarnessExecutorId(value, fallback = "harness-executor") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function normalizeHarnessExecutorWeight(value, fallback = 100) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, parsed);
}

function supportsHarnessExecutorEndpoint(providerId = "") {
  return HARNESS_EXECUTOR_ENDPOINT_PROVIDER_IDS.has(String(providerId || "").trim());
}

function supportsHarnessExecutorConfigurableApiStyle(providerId = "") {
  return HARNESS_EXECUTOR_CONFIGURABLE_API_STYLE_PROVIDER_IDS.has(String(providerId || "").trim());
}

function getHarnessExecutorApiStyleOptions(providerId = "") {
  if (supportsHarnessExecutorConfigurableApiStyle(providerId)) {
    return HARNESS_EXECUTOR_API_STYLE_OPTIONS;
  }
  return HARNESS_EXECUTOR_API_STYLE_OPTIONS.slice(0, 1);
}

function normalizeHarnessExecutorModelForEditor(entry = {}, index = 0, fallbackApiStyle = "provider-default") {
  const value = entry && typeof entry === "object" ? entry : { id: entry };
  const id = String(value.id || value.model || value.name || "").trim() || `model-${index + 1}`;
  const label = String(value.label || value.name || "").trim();
  const apiStyle = String(value.apiStyle || value.transport?.apiStyle || fallbackApiStyle || "provider-default").trim() || "provider-default";
  const apiVersion = String(value.apiVersion || "").trim();
  return {
    _id: value._id || `harness-model-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
    id,
    label,
    apiStyle,
    apiVersion,
    enabled: value.enabled !== false,
  };
}

function extractHarnessExecutorModelsForEditor(entry = {}, fallbackApiStyle = "provider-default") {
  const input = Array.isArray(entry.models)
    ? entry.models
    : String(entry.modelsText || "")
      .split(",")
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  const seen = new Set();
  return input
    .map((item, index) => normalizeHarnessExecutorModelForEditor(item, index, fallbackApiStyle))
    .filter((item) => {
      if (!item.id || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
}

function formatHarnessProviderStatus(authState = {}) {
  if (authState?.authenticated) return "Connected";
  if (authState?.canRun) return "Runnable";
  if (authState?.requiresAction) return "Needs auth";
  if (authState?.status) {
    return String(authState.status)
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (match) => match.toUpperCase());
  }
  return "Unknown";
}

function formatHarnessAuthModeLabel(value = "") {
  const normalized = String(value || "").trim();
  if (!normalized) return "Provider default";
  if (normalized === "apiKey") return "API key";
  if (normalized === "oauth") return "OAuth";
  if (normalized === "subscription") return "Subscription";
  if (normalized === "local") return "Local";
  return normalized;
}

function formatHarnessAuthModeDescription(value = "") {
  const normalized = String(value || "").trim();
  if (normalized === "apiKey") return "Direct API key — you supply a secret key from the provider dashboard. Required for Azure OpenAI and direct OpenAI / Anthropic API access.";
  if (normalized === "oauth") return "Browser OAuth — Bosun uses your existing logged-in account session (e.g. Codex desktop login, `gh auth login`, GitHub Copilot). No manual API key needed. The env binding below should point to the env var that holds the OAuth access token.";
  if (normalized === "subscription") return "Paid subscription — Bosun authenticates via your ChatGPT Plus/Pro or Claude Pro subscription session, not a developer API key. The session token is usually auto-detected from ~/.codex/auth.json after signing in with the Codex desktop app.";
  if (normalized === "local") return "Local server — no external credentials needed; requests go to a local endpoint (e.g. Ollama).";
  return "";
}

function resolveDefaultAuthBindingEnv(authEnvMap, mode) {
  // authEnvMap is providerInfo.auth.env — keys like { apiKey: { keys:[...], key:... }, oauth: {...}, subscription: {...} }
  if (!authEnvMap || !mode) return "";
  const modeMap = { apiKey: "apiKey", oauth: "oauth", subscription: "subscription" };
  const modeKey = modeMap[mode];
  if (!modeKey) return "";
  const entry = authEnvMap[modeKey];
  // Prefer the currently-detected key; fall back to first in keys list
  return String(entry?.key || (Array.isArray(entry?.keys) ? entry.keys[0] : "") || "").trim();
}

function formatHarnessAuthWarningMessages(authState = {}) {
  return Array.isArray(authState?.warnings)
    ? authState.warnings
        .map((entry) => String(entry?.message || "").trim())
        .filter(Boolean)
    : [];
}

function sortHarnessProviderEntries(entries = []) {
  const rank = (entry) => {
    if (entry?.auth?.canRun === true || entry?.authenticated === true) return 0;
    if (entry?.auth?.authenticated === true) return 1;
    if (entry?.enabled !== false) return 2;
    return 3;
  };
  return [...entries].sort((left, right) => {
    const rankDelta = rank(left) - rank(right);
    if (rankDelta !== 0) return rankDelta;
    return String(left?.label || left?.name || left?.providerId || left?.id || "")
      .localeCompare(String(right?.label || right?.name || right?.providerId || right?.id || ""));
  });
}

function formatHarnessRoutingModeLabel(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "fallback") return "Failover";
  if (normalized === "spread") return "Spread";
  return "Default only";
}

function deriveHarnessExecutorRoutingLabel(entry = {}, primaryExecutor = "", routingMode = "default-only") {
  if (String(entry?.id || "").trim() === String(primaryExecutor || "").trim()) {
    return "Primary";
  }
  if (entry?.enabled === false) return "Disabled";
  if (routingMode === "spread") return "Spread";
  if (routingMode === "fallback") return "Failover";
  return "Dormant";
}

function describeHarnessExecutorEndpoint(entry = {}) {
  const endpoint = String(entry?.endpoint || entry?.baseUrl || "").trim();
  const deployment = String(entry?.deployment || "").trim();
  const workspace = String(entry?.workspace || "").trim();
  const project = String(entry?.project || "").trim();
  return [endpoint, deployment, workspace, project].filter(Boolean).join(" · ");
}

function describeHarnessExecutorAuthBindings(entry = {}) {
  const bindings = entry?.authBindings && typeof entry.authBindings === "object"
    ? entry.authBindings
    : {};
  return [
    bindings.apiKeyEnv ? `API key: ${bindings.apiKeyEnv}` : "",
    bindings.oauthTokenEnv ? `OAuth: ${bindings.oauthTokenEnv}` : "",
    bindings.subscriptionEnv ? `Subscription: ${bindings.subscriptionEnv}` : "",
  ].filter(Boolean).join(" · ");
}

function formatHarnessRuntimeOwnershipLabel(entry = {}, providerInfo = null) {
  const runtimeLabel = String(entry?.runtimeLabel || providerInfo?.runtimeLabel || "").trim();
  if (runtimeLabel) return runtimeLabel;
  const adapterId = String(entry?.adapterId || providerInfo?.adapterId || "").trim().toLowerCase();
  if (adapterId === "openai-native") return "Bosun-native";
  if (adapterId.endsWith("-sdk")) return "External SDK";
  return "Runtime-managed";
}

function HarnessExecutorsEditor() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [executors, setExecutors] = useState([]);
  const [providerOptions, setProviderOptions] = useState([]);
  const [providerItems, setProviderItems] = useState([]);
  const [primaryExecutor, setPrimaryExecutor] = useState("");
  const [routingMode, setRoutingMode] = useState("default-only");
  const [dirty, setDirty] = useState(false);
  const [savedState, setSavedState] = useState(null);

  const normalizeExecutor = useCallback((entry = {}, index = 0) => ({
    _id: entry._id || entry.id || `harness-executor-${Date.now()}-${index}`,
    id: normalizeHarnessExecutorId(entry.id || entry._id || `harness-executor-${index + 1}`, `harness-executor-${index + 1}`),
    name: String(entry.name || entry.label || `Harness Executor ${index + 1}`).trim(),
    providerId: String(entry.providerId || "openai-responses").trim(),
    enabled: entry.enabled !== false,
    weight: normalizeHarnessExecutorWeight(entry.weight, 100),
    defaultModel: String(entry.defaultModel || "").trim(),
    modelEntries: extractHarnessExecutorModelsForEditor(
      entry,
      String(entry.apiStyle || "provider-default").trim() || "provider-default",
    ),
    authMode: String(entry.authMode || "").trim(),
    endpoint: String(entry.endpoint || "").trim(),
    baseUrl: String(entry.baseUrl || "").trim(),
    deployment: String(entry.deployment || "").trim(),
    apiVersion: String(entry.apiVersion || "").trim(),
    workspace: String(entry.workspace || "").trim(),
    organization: String(entry.organization || "").trim(),
      project: String(entry.project || "").trim(),
      apiStyle: String(entry.apiStyle || "provider-default").trim() || "provider-default",
      authBindings: {
        apiKeyEnv: String(entry.authBindings?.apiKeyEnv || entry.apiKeyEnv || "").trim(),
        oauthTokenEnv: String(entry.authBindings?.oauthTokenEnv || entry.oauthTokenEnv || "").trim(),
      subscriptionEnv: String(entry.authBindings?.subscriptionEnv || entry.subscriptionEnv || "").trim(),
    },
    auth: entry.auth && typeof entry.auth === "object" ? { ...entry.auth } : null,
  }), []);

  const snapshotState = useCallback((state) => JSON.stringify(state), []);

  const getProviderOption = useCallback((providerId) => (
    providerOptions.find((entry) => String(entry.id || "").trim() === String(providerId || "").trim()) || null
  ), [providerOptions]);

  const getProviderInventoryEntry = useCallback((providerId) => (
    providerItems.find((entry) => String(entry.providerId || "").trim() === String(providerId || "").trim()) || null
  ), [providerItems]);

  const captureSavedState = useCallback((nextExecutors, nextPrimary, nextRouting) => ({
    executors: nextExecutors.map((entry) => ({ ...entry })),
    primaryExecutor: String(nextPrimary || "").trim(),
    routingMode: String(nextRouting || "default-only").trim() || "default-only",
  }), []);

  const runnableCount = useMemo(() => executors.filter((entry) => {
    const providerInfo = providerItems.find((item) => String(item?.providerId || "").trim() === String(entry?.providerId || "").trim());
    return entry?.enabled !== false && (providerInfo?.auth?.canRun === true || providerInfo?.auth?.authenticated === true);
  }).length, [executors, providerItems]);

  const connectedProviderCount = useMemo(
    () => providerItems.filter((item) => item?.enabled !== false && item?.auth?.authenticated === true).length,
    [providerItems],
  );
  const configuredProviderCount = useMemo(
    () => providerItems.filter((item) => item?.enabled !== false && (item?.auth?.configured === true || item?.auth?.available === true || item?.auth?.authenticated === true)).length,
    [providerItems],
  );
  const sortedProviderOptions = useMemo(
    () => sortHarnessProviderEntries(providerOptions),
    [providerOptions],
  );
  const sortedProviderItems = useMemo(
    () => sortHarnessProviderEntries(providerItems),
    [providerItems],
  );
  const providerItemById = useMemo(() => {
    const map = new Map();
    for (const item of providerItems) {
      map.set(String(item?.providerId || "").trim(), item);
    }
    return map;
  }, [providerItems]);

  const primaryExecutorLabel = useMemo(() => (
    executors.find((entry) => entry.id === primaryExecutor)?.name
    || executors.find((entry) => entry.id === primaryExecutor)?.id
    || "Not set"
  ), [executors, primaryExecutor]);

  const applyLoadedState = useCallback((payload = {}) => {
    const nextExecutors = Array.isArray(payload.executors)
      ? payload.executors.map((entry, index) => normalizeExecutor(entry, index))
      : [];
    const nextPrimary = String(payload.primaryExecutorId || payload.primaryExecutor || nextExecutors[0]?.id || "").trim();
    const nextRouting = String(payload.routingMode || "default-only").trim() || "default-only";
    const nextSaved = captureSavedState(nextExecutors, nextPrimary, nextRouting);
    setExecutors(nextExecutors);
    setPrimaryExecutor(nextPrimary);
    setRoutingMode(nextRouting);
    setSavedState(nextSaved);
    setDirty(false);
  }, [captureSavedState, normalizeExecutor]);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch("/api/harness/executors");
        setProviderOptions(sortHarnessProviderEntries(Array.isArray(res?.providerOptions) ? res.providerOptions : []));
        setProviderItems(sortHarnessProviderEntries(Array.isArray(res?.providers?.items) ? res.providers.items : []));
        applyLoadedState(res || {});
        setLoadError("");
      } catch (err) {
        setLoadError(err.message || "Failed to load harness executors");
      } finally {
        setLoading(false);
      }
    })();
  }, [applyLoadedState]);

  useEffect(() => {
    const key = "settings-harness-executors";
    setPendingChange(key, dirty);
    return () => clearPendingChange(key);
  }, [dirty]);

  const markDirty = useCallback((nextExecutors, nextPrimary, nextRouting) => {
    const current = snapshotState(captureSavedState(nextExecutors, nextPrimary, nextRouting));
    const saved = snapshotState(savedState || captureSavedState([], "", "default-only"));
    setDirty(current !== saved);
  }, [captureSavedState, savedState, snapshotState]);

  const addExecutorForProvider = useCallback((providerId = "") => {
    const fallbackProvider = String(providerId || providerOptions[0]?.id || "openai-responses").trim() || "openai-responses";
    const providerInfo = getProviderInventoryEntry(fallbackProvider);
    const providerOption = getProviderOption(fallbackProvider);
    const baseName = providerOption?.label || providerInfo?.label || fallbackProvider;
    const sequence = executors.filter((entry) => entry.providerId === fallbackProvider).length + 1;
    const preferredMode = providerInfo?.auth?.preferredMode || "";
    const authEnvMap = providerInfo?.auth?.env || {};
    const created = normalizeExecutor({
      id: `${fallbackProvider}-${Date.now()}`,
      name: sequence > 1 ? `${baseName} ${sequence}` : baseName,
      providerId: fallbackProvider,
      defaultModel: providerInfo?.modelCatalog?.defaultModel || providerOptions[0]?.defaultModel || "",
      authMode: preferredMode,
      apiStyle: providerOption?.apiStyle || providerOptions[0]?.apiStyle || "provider-default",
      weight: 100,
      authBindings: {
        apiKeyEnv: preferredMode === "apiKey" ? resolveDefaultAuthBindingEnv(authEnvMap, "apiKey") : "",
        oauthTokenEnv: preferredMode === "oauth" ? resolveDefaultAuthBindingEnv(authEnvMap, "oauth") : "",
        subscriptionEnv: preferredMode === "subscription" ? resolveDefaultAuthBindingEnv(authEnvMap, "subscription") : "",
      },
    }, executors.length);
    const nextExecutors = [...executors, created];
    const nextPrimary = primaryExecutor || created.id;
    setExecutors(nextExecutors);
    setPrimaryExecutor(nextPrimary);
    markDirty(nextExecutors, nextPrimary, routingMode);
    haptic("light");
  }, [executors, getProviderInventoryEntry, getProviderOption, markDirty, normalizeExecutor, primaryExecutor, providerOptions, routingMode]);

  const addExecutor = useCallback(() => addExecutorForProvider(""), [addExecutorForProvider]);

  const duplicateExecutor = useCallback((_id) => {
    const source = executors.find((entry) => entry._id === _id);
    if (!source) return;
    const siblingCount = executors.filter((entry) => entry.providerId === source.providerId).length + 1;
    const next = normalizeExecutor({
      ...source,
      _id: undefined,
      id: `${source.id}-${siblingCount}`,
      name: `${source.name} ${siblingCount}`,
    }, executors.length);
    const nextExecutors = [...executors, next];
    setExecutors(nextExecutors);
    markDirty(nextExecutors, primaryExecutor, routingMode);
    haptic("light");
  }, [executors, markDirty, normalizeExecutor, primaryExecutor, routingMode]);

  const removeExecutor = useCallback((_id) => {
    const nextExecutors = executors.filter((entry) => entry._id !== _id);
    const removed = executors.find((entry) => entry._id === _id);
    const nextPrimary = removed?.id === primaryExecutor
      ? (nextExecutors[0]?.id || "")
      : primaryExecutor;
    setExecutors(nextExecutors);
    setPrimaryExecutor(nextPrimary);
    markDirty(nextExecutors, nextPrimary, routingMode);
    haptic("light");
  }, [executors, markDirty, primaryExecutor, routingMode]);

  const updateExecutor = useCallback((_id, field, value) => {
    const nextExecutors = executors.map((entry, index) => {
      if (entry._id !== _id) return entry;
      const nextValue = field === "id"
        ? normalizeHarnessExecutorId(value, `executor-${index + 1}`)
        : field === "weight"
          ? normalizeHarnessExecutorWeight(value, 100)
          : value;
      const next = { ...entry, [field]: nextValue };
      if (field === "name" && (!next.id || next.id === entry.id)) {
        next.id = normalizeHarnessExecutorId(value, `executor-${index + 1}`);
      }
      if (field === "providerId") {
        const providerInfo = getProviderInventoryEntry(value);
        const providerOption = getProviderOption(value);
        const newPreferredMode = providerInfo?.auth?.preferredMode || "";
        const newAuthEnvMap = providerInfo?.auth?.env || {};
        next.authMode = newPreferredMode;
        next.authBindings = {
          apiKeyEnv: newPreferredMode === "apiKey" ? resolveDefaultAuthBindingEnv(newAuthEnvMap, "apiKey") : "",
          oauthTokenEnv: newPreferredMode === "oauth" ? resolveDefaultAuthBindingEnv(newAuthEnvMap, "oauth") : "",
          subscriptionEnv: newPreferredMode === "subscription" ? resolveDefaultAuthBindingEnv(newAuthEnvMap, "subscription") : "",
        };
        next.defaultModel = providerInfo?.modelCatalog?.defaultModel || providerOption?.defaultModel || "";
        next.apiStyle = providerOption?.apiStyle || "provider-default";
        next.modelEntries = Array.isArray(next.modelEntries)
          ? next.modelEntries.map((model, modelIndex) => normalizeHarnessExecutorModelForEditor(
            supportsHarnessExecutorConfigurableApiStyle(value)
              ? model
              : { ...model, apiStyle: "provider-default" },
            modelIndex,
            next.apiStyle,
          ))
          : [];
        if (!String(value || "").includes("azure")) {
          next.deployment = "";
          next.apiVersion = "";
        }
        if (!supportsHarnessExecutorConfigurableApiStyle(value)) {
          next.apiStyle = "provider-default";
        }
      }
      return next;
    });
    let nextPrimary = primaryExecutor;
    if (field === "id" && primaryExecutor === executors.find((entry) => entry._id === _id)?.id) {
      nextPrimary = String(value || "").trim();
      setPrimaryExecutor(nextPrimary);
    }
    setExecutors(nextExecutors);
    markDirty(nextExecutors, nextPrimary, routingMode);
  }, [executors, getProviderInventoryEntry, getProviderOption, markDirty, primaryExecutor, routingMode]);

  const updateExecutorAuthBinding = useCallback((_id, field, value) => {
    const nextExecutors = executors.map((entry) => (
      entry._id === _id
        ? {
            ...entry,
            authBindings: {
              ...(entry.authBindings || {}),
              [field]: String(value || "").trim(),
            },
          }
        : entry
    ));
    setExecutors(nextExecutors);
    markDirty(nextExecutors, primaryExecutor, routingMode);
  }, [executors, markDirty, primaryExecutor, routingMode]);

  const updateExecutorModel = useCallback((executorId, modelInternalId, field, value) => {
    const nextExecutors = executors.map((entry) => {
      if (entry._id !== executorId) return entry;
      const nextModels = (Array.isArray(entry.modelEntries) ? entry.modelEntries : []).map((model) => (
        model._id === modelInternalId
          ? { ...model, [field]: value }
          : model
      ));
      return { ...entry, modelEntries: nextModels };
    });
    setExecutors(nextExecutors);
    markDirty(nextExecutors, primaryExecutor, routingMode);
  }, [executors, markDirty, primaryExecutor, routingMode]);

  const addExecutorModel = useCallback((executorId) => {
    const nextExecutors = executors.map((entry) => {
      if (entry._id !== executorId) return entry;
      const fallbackApiStyle = supportsHarnessExecutorConfigurableApiStyle(entry.providerId)
        ? (entry.apiStyle || "provider-default")
        : "provider-default";
      const nextModels = [
        ...(Array.isArray(entry.modelEntries) ? entry.modelEntries : []),
        normalizeHarnessExecutorModelForEditor({}, entry.modelEntries?.length || 0, fallbackApiStyle),
      ];
      return { ...entry, modelEntries: nextModels };
    });
    setExecutors(nextExecutors);
    markDirty(nextExecutors, primaryExecutor, routingMode);
    haptic("light");
  }, [executors, markDirty, primaryExecutor, routingMode]);

  const removeExecutorModel = useCallback((executorId, modelInternalId) => {
    const nextExecutors = executors.map((entry) => {
      if (entry._id !== executorId) return entry;
      return {
        ...entry,
        modelEntries: (Array.isArray(entry.modelEntries) ? entry.modelEntries : []).filter((model) => model._id !== modelInternalId),
      };
    });
    setExecutors(nextExecutors);
    markDirty(nextExecutors, primaryExecutor, routingMode);
    haptic("light");
  }, [executors, markDirty, primaryExecutor, routingMode]);

  const handleSave = useCallback(async () => {
    const payload = executors.map((entry) => {
      const authBindings = Object.fromEntries(
        Object.entries(entry.authBindings || {}).map(([key, rawValue]) => [key, String(rawValue || "").trim()]).filter(([, value]) => value),
      );
      return {
        id: entry.id,
        name: entry.name,
        providerId: entry.providerId,
        enabled: entry.enabled !== false,
        weight: normalizeHarnessExecutorWeight(entry.weight, 100),
        defaultModel: entry.defaultModel || undefined,
        models: (Array.isArray(entry.modelEntries) ? entry.modelEntries : [])
          .map((model) => ({
            id: String(model.id || "").trim(),
            ...(String(model.label || "").trim() ? { label: String(model.label || "").trim() } : {}),
            ...(String(model.apiStyle || "").trim() ? { apiStyle: String(model.apiStyle || "").trim() } : {}),
            ...(String(model.apiVersion || "").trim() ? { apiVersion: String(model.apiVersion || "").trim() } : {}),
            ...(model.enabled === false ? { enabled: false } : {}),
          }))
          .filter((model) => model.id),
        authMode: entry.authMode || undefined,
        endpoint: entry.endpoint || undefined,
        baseUrl: entry.baseUrl || undefined,
        deployment: entry.deployment || undefined,
        apiVersion: entry.apiVersion || undefined,
        workspace: entry.workspace || undefined,
        organization: entry.organization || undefined,
        project: entry.project || undefined,
        apiStyle: entry.apiStyle || undefined,
        authBindings: Object.keys(authBindings).length > 0 ? authBindings : undefined,
      };
    });
    const res = await apiFetch("/api/harness/executors", {
      method: "POST",
      body: JSON.stringify({
        executors: payload,
        primaryExecutor,
        routingMode,
      }),
    });
    setProviderOptions(sortHarnessProviderEntries(Array.isArray(res?.providerOptions) ? res.providerOptions : providerOptions));
    setProviderItems(sortHarnessProviderEntries(Array.isArray(res?.providers?.items) ? res.providers.items : providerItems));
    applyLoadedState(res || {});
    emitAgentInventoryRefresh({
      source: "harness-executors-save",
      primaryExecutor,
    });
  }, [applyLoadedState, executors, primaryExecutor, providerItems, providerOptions, routingMode]);

  const handleDiscard = useCallback(async () => {
    if (!savedState) return;
    setExecutors((savedState.executors || []).map((entry, index) => normalizeExecutor(entry, index)));
    setPrimaryExecutor(savedState.primaryExecutor || "");
    setRoutingMode(savedState.routingMode || "default-only");
    setDirty(false);
    setLoadError("");
  }, [normalizeExecutor, savedState]);

  useEffect(() => {
    return registerSettingsExternalEditor("settings-harness-executors", {
      isDirty: () => dirty,
      save: handleSave,
      discard: handleDiscard,
    });
  }, [dirty, handleDiscard, handleSave]);

  if (loading) return html`<${SkeletonCard} height="120px" />`;

  return html`
    <${Card} title="Harness Chat Executors"
      badge=${dirty ? html`<${Badge} variant="warning">Unsaved<//>` : null}>
      <div class="meta-text" style="margin-bottom:10px">
        Named Bosun Harness executors are the actual runtime instances Bosun exposes to chat, workflows, Telegram, web, and TUI. Configure one executor per real endpoint or account, choose the primary one, and Bosun will route future Harness sessions through these IDs instead of legacy SDK executors.
      </div>
      <div class="settings-arch-grid" style="margin-bottom:12px">
        <div class="settings-arch-card">
          <div class="settings-arch-title">Configured Executors</div>
          <div class="settings-arch-current">Current: <code>${executors.length}</code></div>
          <div class="settings-arch-note">These are the IDs that appear in chat, workflows, Telegram, and other Harness-native surfaces.</div>
        </div>
        <div class="settings-arch-card">
          <div class="settings-arch-title">Runnable Now</div>
          <div class="settings-arch-current">Current: <code>${runnableCount}</code></div>
          <div class="settings-arch-note">Runnable means the backing provider currently has enough auth and configuration to execute a Harness session.</div>
        </div>
        <div class="settings-arch-card">
          <div class="settings-arch-title">Primary Selection</div>
          <div class="settings-arch-current">Current: <code>${primaryExecutorLabel}</code></div>
          <div class="settings-arch-note">This is the default Harness executor Bosun uses when a surface does not explicitly pick another one.</div>
        </div>
        <div class="settings-arch-card">
          <div class="settings-arch-title">Shared Provider Auth</div>
          <div class="settings-arch-current">Current: <code>${connectedProviderCount}/${configuredProviderCount || providerItems.length || 0}</code></div>
          <div class="settings-arch-note">Connected means Bosun already has auth for the backing provider. Saving enabled executors will also align provider-kernel defaults so the instance is not left half-wired behind separate toggles.</div>
        </div>
      </div>
      ${loadError && html`<div class="settings-banner settings-banner-warn" style="margin-bottom:10px">${loadError}</div>`}
      ${providerOptions.length > 0 && html`
        <div style="margin-bottom:12px">
          <div class="setting-row-label" style="margin-bottom:6px">Quick Add Runtime Instance</div>
          <div style="display:flex;flex-wrap:wrap;gap:8px">
            ${sortedProviderOptions.map((option) => {
              const providerInfo = providerItemById.get(String(option.id || "").trim()) || null;
              const status = formatHarnessProviderStatus(providerInfo?.auth || {});
              return html`
              <${Button} key=${option.id} variant="outlined" size="small" onClick=${() => addExecutorForProvider(option.id)}>
                + ${option.label}${status ? ` · ${status}` : ""}
              <//>
            `;
            })}
          </div>
          <div class="meta-text" style="margin-top:6px">
            Use one named executor per real runtime endpoint or account, for example <code>azure-us</code>, <code>azure-sweden</code>, <code>copilot-oauth</code>, <code>codex-oauth</code>, <code>openai-prod</code>, or <code>local-openai</code>. For OpenAI-compatible targets, use the instance API-style controls below to choose <code>responses</code> or <code>chat-completions</code> per executor or per model.
          </div>
        </div>
      `}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div>
          <div class="setting-row-label">Primary Harness Executor</div>
          <${Select} size="small" value=${primaryExecutor} onChange=${(e) => {
            const nextPrimary = e.target.value;
            setPrimaryExecutor(nextPrimary);
            markDirty(executors, nextPrimary, routingMode);
          }} fullWidth>
            ${executors.length === 0 && html`<${MenuItem} value="">— No executors configured —<//>`}
            ${executors.map((entry) => html`<${MenuItem} value=${entry.id}>${entry.name || entry.id}<//>`)}
          <//>
        </div>
        <div>
          <div class="setting-row-label">Harness Routing Mode</div>
          <${Select} size="small" value=${routingMode} onChange=${(e) => {
            const nextRouting = e.target.value;
            setRoutingMode(nextRouting);
            markDirty(executors, primaryExecutor, nextRouting);
          }} fullWidth>
            <${MenuItem} value="default-only">Default only<//>
            <${MenuItem} value="fallback">Failover<//>
            <${MenuItem} value="spread">Spread<//>
          <//>
        </div>
      </div>
      ${executors.map((entry, index) => {
        const providerInfo = getProviderInventoryEntry(entry.providerId);
        const providerOption = getProviderOption(entry.providerId);
        const authState = entry.auth || providerInfo?.auth || {};
        const supportsEndpoint = supportsHarnessExecutorEndpoint(entry.providerId);
        const supportsConfigurableApiStyle = supportsHarnessExecutorConfigurableApiStyle(entry.providerId);
        const supportsWorkspace = ["openai-codex-subscription", "claude-subscription-shim"].includes(entry.providerId);
        const supportsOrgProject = entry.providerId === "openai-responses";
        const supportsAzureDeployment = entry.providerId === "azure-openai-responses";
        const authModeOptions = Array.isArray(authState?.supportedModes)
          ? authState.supportedModes.filter(Boolean)
          : [];
        const authWarnings = formatHarnessAuthWarningMessages(authState);
        const apiStyleOptions = getHarnessExecutorApiStyleOptions(entry.providerId);
        const isPrimary = entry.id === primaryExecutor;
        const routingLabel = deriveHarnessExecutorRoutingLabel(entry, primaryExecutor, routingMode);
        const endpointSummary = describeHarnessExecutorEndpoint(entry);
        const authBindingSummary = describeHarnessExecutorAuthBindings(entry);
        const runtimeOwnershipLabel = formatHarnessRuntimeOwnershipLabel(entry, providerInfo);
        return html`
          <div key=${entry._id} style="border:1px solid var(--border-primary);border-radius:var(--radius-sm);padding:12px;margin-bottom:10px">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px">
              <div>
                <strong>${entry.name || `Executor ${index + 1}`}</strong>
                <div class="meta-text">${entry.id || `executor-${index + 1}`} · ${providerOption?.label || providerInfo?.label || entry.providerId}</div>
                ${endpointSummary && html`<div class="meta-text" style="margin-top:4px">${endpointSummary}</div>`}
              </div>
              <div style="display:flex;align-items:center;gap:8px">
                <${Toggle} checked=${entry.enabled !== false} onChange=${(value) => updateExecutor(entry._id, "enabled", value)} label="Enabled" />
                <${Button} variant="outlined" size="small" onClick=${() => duplicateExecutor(entry._id)}>Duplicate<//>
                <${Button} variant="outlined" size="small" onClick=${() => removeExecutor(entry._id)}>Remove<//>
              </div>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px">
              ${isPrimary && html`<${Chip} size="small" color="primary" label="Primary" />`}
              <${Chip} size="small" variant="outlined" label=${routingLabel} />
              <${Chip} size="small" variant="outlined" label=${formatHarnessProviderStatus(authState)} />
              <${Chip} size="small" variant="outlined" label=${runtimeOwnershipLabel} />
              <${Chip} size="small" variant="outlined" label=${(apiStyleOptions.find((option) => option.value === (entry.apiStyle || "provider-default")) || HARNESS_EXECUTOR_API_STYLE_OPTIONS[0])?.label || "Provider default"} />
              ${routingMode === "spread" && html`<${Chip} size="small" variant="outlined" label=${`Weight ${normalizeHarnessExecutorWeight(entry.weight, 100)}`} />`}
              ${authState.preferredMode && html`<${Chip} size="small" variant="outlined" label=${formatHarnessAuthModeLabel(authState.preferredMode)} />`}
              ${entry.defaultModel && html`<${Chip} size="small" variant="outlined" label=${entry.defaultModel} />`}
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
              <div>
                <div class="setting-row-label">Display Name</div>
                <${TextField} size="small" variant="outlined" value=${entry.name} onInput=${(e) => updateExecutor(entry._id, "name", e.target.value)} fullWidth />
              </div>
              <div>
                <div class="setting-row-label">Stable ID</div>
                <${TextField} size="small" variant="outlined" value=${entry.id} onInput=${(e) => updateExecutor(entry._id, "id", e.target.value)} fullWidth />
              </div>
              <div>
                <div class="setting-row-label">Provider Runtime</div>
                <${Select} size="small" value=${entry.providerId} onChange=${(e) => updateExecutor(entry._id, "providerId", e.target.value)} fullWidth>
                  ${sortedProviderOptions.map((option) => html`<${MenuItem} value=${option.id}>${option.label}<//>`)}
                <//>
                ${providerOption?.description ? html`<div class="meta-text" style="margin-top:4px">${providerOption.description}</div>` : null}
              </div>
              ${supportsConfigurableApiStyle ? html`
                <div>
                  <div class="setting-row-label">Executor API Style</div>
                  <${Select} size="small" value=${entry.apiStyle || "provider-default"} onChange=${(e) => updateExecutor(entry._id, "apiStyle", e.target.value)} fullWidth>
                    ${apiStyleOptions.map((option) => html`<${MenuItem} value=${option.value}>${option.label}<//>`)}
                  <//>
                  <div class="meta-text" style="margin-top:4px">Use this when a specific endpoint should default to <code>/v1/responses</code> or <code>/v1/chat/completions</code>. Model-level overrides below can still differ.</div>
                </div>
              ` : html`
                <div>
                  <div class="setting-row-label">Executor API Style</div>
                  <${TextField} size="small" variant="outlined" value=${"Provider native transport"} disabled fullWidth />
                </div>
              `}
              <div>
                <div class="setting-row-label">Default Model</div>
                <${TextField} size="small" variant="outlined" value=${entry.defaultModel} onInput=${(e) => updateExecutor(entry._id, "defaultModel", e.target.value)} placeholder="gpt-5.4 / claude-sonnet-4.6 / ..." fullWidth />
              </div>
              <div>
                <div class="setting-row-label">Routing Weight</div>
                <${TextField} type="number" size="small" variant="outlined" value=${normalizeHarnessExecutorWeight(entry.weight, 100)} onInput=${(e) => updateExecutor(entry._id, "weight", e.target.value)} inputProps=${{ min: 0, max: 100000 }} fullWidth />
                <div class="meta-text" style="margin-top:4px">${routingMode === "spread" ? "Higher weights make this executor more likely to receive spread-routed work." : "Stored now so the executor is ready if you later switch the Harness runtime to spread routing."}</div>
              </div>
              <div style="grid-column:1/-1">
                <div class="setting-row-label">Auth Mode</div>
                ${authModeOptions.length > 0
                  ? html`
                      <${Select} size="small" value=${entry.authMode || ""} onChange=${(e) => updateExecutor(entry._id, "authMode", e.target.value)} fullWidth>
                        <${MenuItem} value="">Provider default<//>
                        ${authModeOptions.map((mode) => html`<${MenuItem} value=${mode}>${formatHarnessAuthModeLabel(mode)}<//>`)}
                      <//>
                    `
                  : html`
                      <${TextField} size="small" variant="outlined" value=${entry.authMode} onInput=${(e) => updateExecutor(entry._id, "authMode", e.target.value)} placeholder=${authState.preferredMode || "provider default"} fullWidth />
                    `}
                ${formatHarnessAuthModeDescription(entry.authMode || authState.preferredMode) && html`
                  <div class="meta-text" style="margin-top:4px">${formatHarnessAuthModeDescription(entry.authMode || authState.preferredMode)}</div>
                `}
              </div>
                ${(!entry.authMode || entry.authMode === "apiKey") && html`
                  <div>
                    <div class="setting-row-label">API Key Env Binding</div>
                    <${TextField}
                      size="small"
                      variant="outlined"
                      value=${entry.authBindings?.apiKeyEnv || ""}
                      onInput=${(e) => updateExecutorAuthBinding(entry._id, "apiKeyEnv", e.target.value)}
                      placeholder=${resolveDefaultAuthBindingEnv(authState?.env, "apiKey") || "OPENAI_API_KEY / AZURE_OPENAI_API_KEY / ..."}
                      fullWidth
                    />
                    <div class="meta-text" style="margin-top:4px">${authState?.env?.apiKey?.configured ? html`<span style="color:var(--color-success,#4caf73)">&#x2713; ${authState.env.apiKey.key} is set</span>` : "Name of the env var that holds your API key. Leave blank to use the provider default."}</div>
                  </div>
                `}
                ${(!entry.authMode || entry.authMode === "oauth") && html`
                  <div>
                    <div class="setting-row-label">OAuth Token Env Binding</div>
                    <${TextField}
                      size="small"
                      variant="outlined"
                      value=${entry.authBindings?.oauthTokenEnv || ""}
                      onInput=${(e) => updateExecutorAuthBinding(entry._id, "oauthTokenEnv", e.target.value)}
                      placeholder=${resolveDefaultAuthBindingEnv(authState?.env, "oauth") || "OPENAI_ACCESS_TOKEN / COPILOT_OAUTH_TOKEN / GITHUB_TOKEN / ..."}
                      fullWidth
                    />
                    <div class="meta-text" style="margin-top:4px">${authState?.env?.oauth?.configured ? html`<span style="color:var(--color-success,#4caf73)">&#x2713; ${authState.env.oauth.key} is set</span>` : "Name of the env var holding your OAuth access token. Leave blank to use the provider default."}</div>
                  </div>
                `}
                ${(!entry.authMode || entry.authMode === "subscription") && html`
                  <div>
                    <div class="setting-row-label">Subscription Env Binding</div>
                    <${TextField}
                      size="small"
                      variant="outlined"
                      value=${entry.authBindings?.subscriptionEnv || ""}
                      onInput=${(e) => updateExecutorAuthBinding(entry._id, "subscriptionEnv", e.target.value)}
                      placeholder=${resolveDefaultAuthBindingEnv(authState?.env, "subscription") || "OPENAI_SESSION_TOKEN / ..."}
                      fullWidth
                    />
                    <div class="meta-text" style="margin-top:4px">${authState?.env?.subscription?.configured ? html`<span style="color:var(--color-success,#4caf73)">&#x2713; ${authState.env.subscription.key} is set — session auto-detected from ~/.codex/auth.json</span>` : "Name of the env var holding the subscription session token. Auto-detected from ~/.codex/auth.json after signing in with the Codex desktop app. Leave blank to use the provider default."}</div>
                  </div>
                `}
              ${supportsEndpoint && html`
                <div>
                  <div class="setting-row-label">${supportsAzureDeployment ? "Endpoint URL" : "Base URL / Endpoint"}</div>
                  <${TextField} size="small" variant="outlined" value=${entry.endpoint || entry.baseUrl || ""} onInput=${(e) => {
                    const nextValue = e.target.value;
                    if (supportsAzureDeployment) {
                      updateExecutor(entry._id, "endpoint", nextValue);
                    } else {
                      updateExecutor(entry._id, "baseUrl", nextValue);
                    }
                  }} placeholder="https://..." fullWidth />
                </div>
              `}
              ${supportsAzureDeployment && html`
                <div>
                  <div class="setting-row-label">Azure Deployment</div>
                  <${TextField} size="small" variant="outlined" value=${entry.deployment} onInput=${(e) => updateExecutor(entry._id, "deployment", e.target.value)} placeholder="deployment name" fullWidth />
                </div>
              `}
              ${supportsWorkspace && html`
                <div>
                  <div class="setting-row-label">Workspace / Org Scope</div>
                  <${TextField} size="small" variant="outlined" value=${entry.workspace} onInput=${(e) => updateExecutor(entry._id, "workspace", e.target.value)} placeholder="optional workspace selector" fullWidth />
                </div>
              `}
              ${supportsOrgProject && html`
                <div>
                  <div class="setting-row-label">OpenAI Organization</div>
                  <${TextField} size="small" variant="outlined" value=${entry.organization} onInput=${(e) => updateExecutor(entry._id, "organization", e.target.value)} placeholder="org_xxx" fullWidth />
                </div>
                <div>
                  <div class="setting-row-label">OpenAI Project</div>
                  <${TextField} size="small" variant="outlined" value=${entry.project} onInput=${(e) => updateExecutor(entry._id, "project", e.target.value)} placeholder="proj_xxx" fullWidth />
                </div>
              `}
            </div>
            <div style="margin-top:12px">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px">
                <div>
                  <div class="setting-row-label">Model Catalog</div>
                  <div class="meta-text">Per-executor model list. Load known models from the provider or discover them from a live endpoint. You can then remove any you don't need.</div>
                </div>
                <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
                  ${Array.isArray(providerInfo?.modelCatalog?.models) && providerInfo.modelCatalog.models.length > 0 && html`
                    <${Button} variant="outlined" size="small" onClick=${() => {
                      const fallbackApiStyle = supportsHarnessExecutorConfigurableApiStyle(entry.providerId)
                        ? (entry.apiStyle || "provider-default")
                        : "provider-default";
                      const nextExecutors = executors.map((ex) => {
                        if (ex._id !== entry._id) return ex;
                        const existingIds = new Set((ex.modelEntries || []).map((m) => m.id).filter(Boolean));
                        const toAdd = providerInfo.modelCatalog.models
                          .map((m) => String(m?.id || m || "").trim())
                          .filter((id) => id && !existingIds.has(id))
                          .map((id, i) => normalizeHarnessExecutorModelForEditor({ id }, (ex.modelEntries?.length || 0) + i, fallbackApiStyle));
                        return { ...ex, modelEntries: [...(ex.modelEntries || []), ...toAdd] };
                      });
                      setExecutors(nextExecutors);
                      markDirty(nextExecutors, primaryExecutor, routingMode);
                      haptic("light");
                    }}>Load from provider<//>
                  `}
                  ${supportsAzureDeployment && html`
                    <${Button} variant="outlined" size="small" onClick=${async () => {
                      try {
                        const res = await apiFetch("/api/harness/discover-models", {
                          method: "POST",
                          body: JSON.stringify({
                            providerId: entry.providerId,
                            endpoint: entry.endpoint || entry.baseUrl || "",
                            apiKeyEnv: entry.authBindings?.apiKeyEnv || "",
                          }),
                        }).catch(() => null);
                        const discovered = Array.isArray(res?.models) ? res.models : [];
                        if (!discovered.length) { haptic("heavy"); return; }
                        const fallbackApiStyle = entry.apiStyle || "provider-default";
                        const nextExecutors = executors.map((ex) => {
                          if (ex._id !== entry._id) return ex;
                          const existingIds = new Set((ex.modelEntries || []).map((m) => m.id).filter(Boolean));
                          const toAdd = discovered
                            .filter((id) => id && !existingIds.has(id))
                            .map((id, i) => normalizeHarnessExecutorModelForEditor({ id }, (ex.modelEntries?.length || 0) + i, fallbackApiStyle));
                          return { ...ex, modelEntries: [...(ex.modelEntries || []), ...toAdd] };
                        });
                        setExecutors(nextExecutors);
                        markDirty(nextExecutors, primaryExecutor, routingMode);
                        haptic("light");
                      } catch { haptic("heavy"); }
                    }}>Discover from deployment<//>
                  `}
                  <${Button} variant="outlined" size="small" onClick=${() => addExecutorModel(entry._id)}>Add model<//>
                </div>
              </div>
              ${(Array.isArray(entry.modelEntries) ? entry.modelEntries : []).length === 0
                ? html`<div class="meta-text">No explicit model list. Use "Load from provider" to populate from the known model catalog, or add manually. Bosun will fall back to the provider catalog.</div>`
                : html`
                    ${(entry.modelEntries || []).map((model, modelIndex) => html`
                      <div key=${model._id} style="display:grid;grid-template-columns:minmax(160px,1.5fr) minmax(120px,1fr) ${supportsAzureDeployment ? "minmax(150px,1fr)" : ""} minmax(160px,1fr) auto;gap:8px;align-items:end;margin-bottom:8px">
                        <div>
                          <div class="setting-row-label">Model ID</div>
                          <${TextField} size="small" variant="outlined" value=${model.id} onInput=${(e) => updateExecutorModel(entry._id, model._id, "id", e.target.value)} placeholder=${modelIndex === 0 ? "gpt-5.4" : "model id"} fullWidth />
                        </div>
                        <div>
                          <div class="setting-row-label">Label</div>
                          <${TextField} size="small" variant="outlined" value=${model.label} onInput=${(e) => updateExecutorModel(entry._id, model._id, "label", e.target.value)} placeholder="Optional UI label" fullWidth />
                        </div>
                        ${supportsAzureDeployment && html`
                          <div>
                            <div class="setting-row-label">API Version</div>
                            <${TextField} size="small" variant="outlined" value=${model.apiVersion || ""} onInput=${(e) => updateExecutorModel(entry._id, model._id, "apiVersion", e.target.value)} placeholder="e.g. 2025-03-01-preview" fullWidth />
                          </div>
                        `}
                        <div>
                          <div class="setting-row-label">${supportsConfigurableApiStyle ? "API Style For This Model" : "Model Transport"}</div>
                          ${supportsConfigurableApiStyle
                            ? html`
                                <${Select} size="small" value=${model.apiStyle || "provider-default"} onChange=${(e) => updateExecutorModel(entry._id, model._id, "apiStyle", e.target.value)} fullWidth>
                                  ${apiStyleOptions.map((option) => html`<${MenuItem} value=${option.value}>${option.label}<//>`)}
                                <//>
                              `
                            : html`<${TextField} size="small" variant="outlined" value=${"Provider native transport"} disabled fullWidth />`}
                        </div>
                        <div style="display:flex;align-items:center;gap:8px">
                          <${Toggle} checked=${model.enabled !== false} onChange=${(value) => updateExecutorModel(entry._id, model._id, "enabled", value)} label="Enabled" />
                          <${Button} variant="text" color="error" size="small" onClick=${() => removeExecutorModel(entry._id, model._id)}>Remove<//>
                        </div>
                      </div>
                    `)}
                  `}
            </div>
            <div class="meta-text" style="margin-top:8px">
              Provider auth: <strong>${authState.status || "unknown"}</strong>
              ${authState.authenticated ? " · connected" : authState.requiresAction ? " · needs auth" : ""}
              ${authState.canRun ? " · runnable" : ""}
              ${runtimeOwnershipLabel ? ` · ${runtimeOwnershipLabel.toLowerCase()}` : ""}
              ${authBindingSummary ? ` · bindings ${authBindingSummary}` : ""}
              ${authState.connection?.accountId ? ` · account ${authState.connection.accountId}` : ""}
              ${authState.preferredMode ? ` · ${authState.preferredMode}` : ""}
              ${providerInfo?.description ? ` · ${providerInfo.description}` : ""}
            </div>
            ${authWarnings.length > 0 && html`
              <div class="settings-banner settings-banner-warn" style="margin-top:10px">
                <span>${resolveIcon(":alert:")}</span>
                <span class="settings-banner-text">${authWarnings.join(" ")}</span>
              </div>
            `}
          </div>
        `;
      })}
      <${Button} variant="outlined" size="small" onClick=${addExecutor}>+ Add Harness Executor<//>
      ${executors.length === 0 && !loadError && html`
        <div class="meta-text" style="margin-top:8px">
          No named Harness executors yet. Add one here to make it appear as a selectable chat/runtime executor. Bosun will still keep shared provider defaults below, but named executors are the first-class runtime objects that direct sessions and future tasks actually choose from.
        </div>
      `}
    <//>
  `;
}

function parseExecutorRoutingPool(rawValue = "") {
  const chunks = Array.isArray(rawValue)
    ? rawValue
    : isStructuredValue(rawValue)
      ? (String(rawValue.executor || rawValue.type || "").trim()
        ? [rawValue]
        : Array.isArray(rawValue.entries)
          ? rawValue.entries
          : Object.values(rawValue))
      : String(rawValue || "").trim().split(",");
  if (!Array.isArray(chunks) || chunks.length === 0) return [];
  return chunks
    .map((chunk, index) => {
      if (chunk && typeof chunk === "object" && !Array.isArray(chunk)) {
        const models = Array.isArray(chunk.models)
          ? chunk.models.map((entry) => String(entry || "").trim()).filter(Boolean)
          : String(chunk.modelsText || chunk.model || "")
            .split(/[|,]/)
            .map((entry) => String(entry || "").trim())
            .filter(Boolean);
        return {
          id: `executor-pool-${index}`,
          executor: String(chunk.executor || chunk.type || "").trim().toUpperCase() || "CODEX",
          variant: String(chunk.variant || chunk.family || "").trim().toUpperCase() || "DEFAULT",
          weight: Math.max(0, Number.parseInt(String(chunk.weight || "0"), 10) || 0),
          modelsText: models.join(", "),
        };
      }
      const [executor = "", variant = "", weight = "", ...modelParts] = String(chunk || "").split(":");
      const models = modelParts.join(":").split("|").map((entry) => String(entry || "").trim()).filter(Boolean);
      return {
        id: `executor-pool-${index}`,
        executor: String(executor || "").trim().toUpperCase() || "CODEX",
        variant: String(variant || "").trim().toUpperCase() || "DEFAULT",
        weight: Math.max(0, Number.parseInt(String(weight || "0"), 10) || 0),
        modelsText: models.join(", "),
      };
    })
    .filter((entry) => entry.executor);
}

function serializeExecutorRoutingPool(entries = []) {
  return entries
    .map((entry) => {
      const executor = String(entry?.executor || "").trim().toUpperCase();
      const variant = String(entry?.variant || "").trim().toUpperCase();
      const weight = Math.max(0, Number.parseInt(String(entry?.weight || "0"), 10) || 0);
      const models = String(entry?.modelsText || "")
        .split(",")
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .join("|");
      if (!executor || !variant) return "";
      return `${executor}:${variant}:${weight}${models ? `:${models}` : ""}`;
    })
    .filter(Boolean)
    .join(",");
}

function ExecutorRoutingPoolEditor({ value = "", onChange }) {
  const entries = useMemo(() => parseExecutorRoutingPool(value), [value]);
  const totalWeight = entries.reduce((sum, entry) => sum + (Number(entry?.weight || 0) || 0), 0);
  const syncEntries = useCallback((nextEntries) => {
    onChange(serializeExecutorRoutingPool(nextEntries));
  }, [onChange]);
  const updateEntry = useCallback((entryId, field, nextValue) => {
    syncEntries(entries.map((entry) => (
      entry.id === entryId
        ? { ...entry, [field]: nextValue }
        : entry
    )));
  }, [entries, syncEntries]);
  const removeEntry = useCallback((entryId) => {
    syncEntries(entries.filter((entry) => entry.id !== entryId));
  }, [entries, syncEntries]);
  const addEntry = useCallback(() => {
    syncEntries([
      ...entries,
      {
        id: `executor-pool-${Date.now()}-${entries.length}`,
        executor: "CODEX",
        variant: "DEFAULT",
        weight: entries.length === 0 ? 100 : 0,
        modelsText: "",
      },
    ]);
  }, [entries, syncEntries]);

  return html`
    <div style="display:grid;gap:10px">
      <div class="meta-text">
        Build the queued-task routing pool here instead of hand-editing the raw <code>EXECUTORS</code> string. This does not affect direct chat sessions.
      </div>
      ${entries.length === 0
        ? html`<div class="meta-text">No routing entries yet. Add one if you want queued tasks distributed across multiple runtimes.</div>`
        : entries.map((entry, index) => html`
            <div key=${entry.id} style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;padding:10px;border:1px solid var(--border, rgba(255,255,255,0.1));border-radius:12px;background:color-mix(in srgb, var(--bg-card, #222) 88%, transparent)">
              <div>
                <div class="setting-row-label">Runtime</div>
                <${Select} size="small" value=${entry.executor} onChange=${(e) => updateEntry(entry.id, "executor", e.target.value)} fullWidth>
                  ${["CODEX", "CLAUDE", "COPILOT", "OPENCODE", "GEMINI"].map((option) => html`<${MenuItem} value=${option}>${option}<//>`)}
                <//>
              </div>
              <div>
                <div class="setting-row-label">Variant</div>
                <${TextField} size="small" value=${entry.variant} onInput=${(e) => updateEntry(entry.id, "variant", e.target.value)} placeholder="DEFAULT" fullWidth />
              </div>
              <div>
                <div class="setting-row-label">Weight</div>
                <${TextField} type="number" size="small" value=${entry.weight} inputProps=${{ min: 0, max: 1000 }} onInput=${(e) => updateEntry(entry.id, "weight", e.target.value)} fullWidth />
              </div>
              <div style="grid-column:1/-1">
                <div class="setting-row-label">Model allow-list</div>
                <${TextField} size="small" value=${entry.modelsText} onInput=${(e) => updateEntry(entry.id, "modelsText", e.target.value)} placeholder="Optional comma-separated models" fullWidth />
                <div class="meta-text" style="margin-top:4px">Entry ${index + 1}. Use commas here; Bosun stores them as <code>|</code> internally.</div>
              </div>
              <div style="grid-column:1/-1;display:flex;justify-content:flex-end">
                <${Button} variant="text" color="error" size="small" onClick=${() => removeEntry(entry.id)}>Remove runtime<//>
              </div>
            </div>
          `)}
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div class="meta-text">Total configured weight: <strong>${totalWeight}</strong></div>
        <${Button} variant="outlined" size="small" onClick=${addEntry}>Add runtime<//>
      </div>
      <div class="meta-text"><strong>Stored value:</strong> <code>${value || "(empty)"}</code></div>
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════════
 *  ServerConfigMode — .env management UI
 * ═══════════════════════════════════════════════════════════════ */
function ServerConfigMode() {
  /* Data loading state */
  const [serverData, setServerData] = useState(null);     // { KEY: "value" } from API
  const [serverSources, setServerSources] = useState(null); // { KEY: "env" | "config" | "default" | "derived" | ... }
  const [serverMeta, setServerMeta] = useState(null);     // { envPath, configPath, configDir }
  const [agentArchitecture, setAgentArchitecture] = useState(null);
  const [harnessExecutorsState, setHarnessExecutorsState] = useState(null);
  const [configSync, setConfigSync] = useState(null);     // { total, updated, skipped, configPath }
  const [loadError, setLoadError] = useState(null);
  const [loading, setLoading] = useState(true);

  /* Local edits: Map of key → edited value (string) */
  const [edits, setEdits] = useState({});
  /* Validation errors: Map of key → error string */
  const [errors, setErrors] = useState({});
  /* Secret visibility: Set of keys currently unmasked */
  const [visibleSecrets, setVisibleSecrets] = useState({});
  /* Custom-select open state: key -> true while editing custom value */
  const [customSelectMode, setCustomSelectMode] = useState({});
  /* Help tooltips: key of currently shown tooltip */
  const [activeTooltip, setActiveTooltip] = useState(null);

  /* Active category tab */
  const [activeCategory, setActiveCategory] = useState(CATEGORIES[0].id);
  /* Search query */
  const [searchQuery, setSearchQuery] = useState("");
  /* Show advanced settings */
  const [showAdvanced, setShowAdvanced] = useState(false);
  /* Save flow */
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [restartCountdown, setRestartCountdown] = useState(null);

  const tooltipTimer = useRef(null);
  const restartCountdownTimer = useRef(null);
  const settingsSchemaByKey = useMemo(
    () => new Map(SETTINGS_SCHEMA.map((def) => [def.key, def])),
    [],
  );

  /* ─── Load server settings on mount ─── */
  const fetchSettings = useCallback(async (opts = {}) => {
    const silent = opts?.silent === true;
    const preserveConfigSync = opts?.preserveConfigSync === true;
    if (!silent) setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch("/api/settings");
      const isWrapped = Boolean(res?.ok && res.data && typeof res.data === "object");
      const isLegacyObject = Boolean(
        res &&
        typeof res === "object" &&
        !Array.isArray(res) &&
        !("ok" in res) &&
        !("data" in res),
      );

      if (isWrapped) {
        setServerData(res.data);
        setServerSources(
          res?.sources && typeof res.sources === "object"
            ? res.sources
            : null,
        );
        setServerMeta(res.meta || null);
        setAgentArchitecture(res.agentArchitecture || null);
        setHarnessExecutorsState(res.harnessExecutors || null);
        if (!preserveConfigSync) setConfigSync(null);
      } else if (isLegacyObject) {
        // Demo/legacy compatibility: /api/settings may return a plain object.
        setServerData(res);
        setServerSources(null);
        setServerMeta(null);
        setAgentArchitecture(null);
        setHarnessExecutorsState(null);
        if (!preserveConfigSync) setConfigSync(null);
      } else {
        throw new Error(res?.error || "Unexpected response format");
      }
    } catch (err) {
      setLoadError(err.message || "Failed to load settings");
      setServerData(null);
      setServerSources(null);
      setServerMeta(null);
      setAgentArchitecture(null);
      setHarnessExecutorsState(null);
      setConfigSync(null);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  const clearRestartCountdown = useCallback(() => {
    if (restartCountdownTimer.current) {
      clearInterval(restartCountdownTimer.current);
      restartCountdownTimer.current = null;
    }
    setRestartCountdown(null);
  }, []);

  useEffect(() => () => clearRestartCountdown(), [clearRestartCountdown]);

  /* ─── Grouped settings with search + advanced filter ─── */
  const grouped = useMemo(() => getGroupedSettings(showAdvanced), [showAdvanced]);
  const isContextShreddingSetting = useCallback((def) => {
    const category = String(def?.category || "").toLowerCase();
    return category === "context-shredding" || category === "context_shredding";
  }, []);
  const activeAgentRuntime = useMemo(
    () => normalizeAgentRuntimeValue(
      Object.prototype.hasOwnProperty.call(edits, "BOSUN_AGENT_RUNTIME")
        ? edits.BOSUN_AGENT_RUNTIME
        : serverData?.BOSUN_AGENT_RUNTIME,
    ),
    [edits, serverData],
  );
  const hasExplicitHarnessExecutors = useMemo(
    () => harnessExecutorsState?.hasExplicitExecutors === true,
    [harnessExecutorsState],
  );

  /* Filtered settings when searching */
  const filteredSettings = useMemo(() => {
    if (!searchQuery.trim()) return null; // null = not searching
    const results = [];
    for (const def of SETTINGS_SCHEMA) {
      if (!showAdvanced && def.advanced && !isContextShreddingSetting(def)) continue;
      if (
        def.category === "executor"
        && !isExecutorSettingVisible(def, activeAgentRuntime, { hasExplicitHarnessExecutors })
      ) continue;
      const haystack = `${def.key} ${def.label} ${def.description || ""}`;
      if (fuzzyMatch(searchQuery, haystack)) results.push(def);
    }
    return results;
  }, [searchQuery, showAdvanced, isContextShreddingSetting, activeAgentRuntime, hasExplicitHarnessExecutors]);

  /* ─── Value resolution: edited value → server value → empty ─── */
  const normalizeSettingTextValue = useCallback(
    (key, rawValue, options = {}) => {
      const def = settingsSchemaByKey.get(key) || null;
      const inputKind = inferStructuredInputKind({
        type: def?.type,
        value: rawValue,
        defaultValue: def?.defaultVal,
      });
      return toEditableTextValue(rawValue, {
        pretty: options.pretty ?? inputKind === "json",
        fallback: options.fallback ?? "",
      });
    },
    [settingsSchemaByKey],
  );

  const getValue = useCallback(
    (key) => normalizeSettingTextValue(
      key,
      key in edits
        ? edits[key]
        : (serverData && key in serverData ? serverData[key] : ""),
      { fallback: "" },
    ),
    [edits, normalizeSettingTextValue, serverData],
  );

  const getReloadDelayMs = useCallback(
    (changes = null) => {
      const raw = changes?.ENV_RELOAD_DELAY_MS ?? getValue("ENV_RELOAD_DELAY_MS") ?? "";
      const parsed = Number.parseInt(String(raw || ""), 10);
      return Number.isFinite(parsed) ? Math.max(500, parsed) : 5000;
    },
    [getValue],
  );

  /* ─── Determine if a value matches its default ─── */
  const isDefault = useCallback(
    (def) => {
      const source = serverSources?.[def.key];
      if (source === "default") return true;
      if (source && source !== "unset") return false;
      if (def.defaultVal == null) return false;
      const current = getValue(def.key);
      return current === "" || current === toEditableTextValue(def.defaultVal, {
        pretty: inferStructuredInputKind({
          type: def.type,
          defaultValue: def.defaultVal,
        }) === "json",
        fallback: "",
      });
    },
    [getValue, serverSources],
  );

  /* ─── Determine if a value was modified from loaded state ─── */
  const isModified = useCallback(
    (key) => key in edits,
    [edits],
  );

  /* Count of unsaved changes */
  const serverChangeCount = useMemo(() => Object.keys(edits).length, [edits]);
  const externalPendingKeys = useMemo(() => {
    const current = pendingChanges.value || {};
    return Object.keys(current).filter(
      (key) => key.startsWith("settings-") && key !== "settings-server",
    );
  }, [pendingChanges.value]);
  const externalChangeCount = externalPendingKeys.length;
  const changeCount = serverChangeCount + externalChangeCount;

  useEffect(() => {
    const key = "settings-server";
    setPendingChange(key, serverChangeCount > 0);
    return () => clearPendingChange(key);
  }, [serverChangeCount]);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const className = "settings-save-open";
    document.body.classList.toggle(className, changeCount > 0);
    return () => {
      document.body.classList.remove(className);
    };
  }, [changeCount]);

  /* Any setting with restart: true in the changes? */
  const hasRestartSetting = useMemo(() => {
    return Object.keys(edits).some((key) => {
      const def = SETTINGS_SCHEMA.find((s) => s.key === key);
      return def?.restart;
    });
  }, [edits]);

  const restartCountdownSeconds = restartCountdown
    ? formatCountdownSeconds(restartCountdown.remainingMs)
    : null;

  useEffect(() => {
    if (!restartCountdown) return undefined;
    if (restartCountdown.remainingMs > 0 || !wsConnected.value) return undefined;
    const timer = setTimeout(() => {
      setRestartCountdown((current) => {
        if (!current || current.remainingMs > 0) return current;
        return null;
      });
    }, 3000);
    return () => clearTimeout(timer);
  }, [restartCountdown, wsConnected.value]);

  /* ─── Handlers ─── */
  const handleChange = useCallback(
    (key, value) => {
      haptic("light");
      setEdits((prev) => {
        const original = normalizeSettingTextValue(key, serverData?.[key], { fallback: "" });
        // If the new value matches the original, remove the edit
        if (value === original) {
          const next = { ...prev };
          delete next[key];
          return next;
        }
        return { ...prev, [key]: value };
      });
      // Validate inline
      const def = SETTINGS_SCHEMA.find((s) => s.key === key);
      if (def) {
        const result = validateSetting(def, value);
        setErrors((prev) => {
          if (result.valid) {
            const next = { ...prev };
            delete next[key];
            return next;
          }
          return { ...prev, [key]: result.error };
        });
      }
    },
    [normalizeSettingTextValue, serverData],
  );

  const handleDiscard = useCallback(async () => {
    haptic("medium");
    try {
      await runSettingsExternalEditorAction("discard");
      setEdits({});
      setErrors({});
      setCustomSelectMode({});
      showToast("Changes discarded", "info");
    } catch (err) {
      showToast(`Discard failed: ${err?.message || "Unknown error"}`, "error");
      haptic("heavy");
    }
  }, []);

  /* ─── Save flow ─── */
  const handleSaveClick = useCallback(() => {
    // Validate all changed settings
    const newErrors = {};
    let hasError = false;
    for (const [key, value] of Object.entries(edits)) {
      const def = SETTINGS_SCHEMA.find((s) => s.key === key);
      if (!def) continue;
      const result = validateSetting(def, value);
      if (!result.valid) {
        newErrors[key] = result.error;
        hasError = true;
      }
    }
    setErrors((prev) => ({ ...prev, ...newErrors }));
    if (hasError) {
      showToast("Fix validation errors before saving", "error");
      haptic("heavy");
      return;
    }
    haptic("medium");
    setConfirmOpen(true);
  }, [edits]);

  const handleConfirmSave = useCallback(async () => {
    setConfirmOpen(false);
    setSaving(true);
    try {
      const changes = {};
      for (const [key, value] of Object.entries(edits)) {
        changes[key] = value;
      }
      const changeKeys = Object.keys(changes);
      const restartDelayMs = getReloadDelayMs(changes);
      if (changeKeys.length > 0) {
        let res;
        try {
          res = await apiFetch("/api/settings/update", {
            method: "POST",
            body: JSON.stringify({ changes }),
          });
        } catch (error_) {
          const message = String(error_?.message || "");
          const shouldTryLegacy =
            /Request failed \((404|405|501)\)/.test(message)
            || /Failed to fetch|NetworkError|Load failed/i.test(message);

          if (!shouldTryLegacy) throw error_;

          const legacyKeyMap = {
            INTERNAL_EXECUTOR_SDK: "sdk",
            KANBAN_BACKEND: "kanban",
            EXECUTOR_REGIONS: "region",
          };
          const entries = Object.entries(changes);
          if (entries.length !== 1) throw error_;

          const [envKey, value] = entries[0];
          const legacyKey = legacyKeyMap[envKey];
          if (!legacyKey) throw error_;

          res = await apiFetch("/api/config/update", {
            method: "POST",
            body: JSON.stringify({ key: legacyKey, value }),
          });
        }
        if (!(res?.ok || (res && typeof res === "object" && !Array.isArray(res)))) {
          throw new Error(res?.error || "Save failed");
        }
        const updatedConfig = Array.isArray(res.updatedConfig) ? res.updatedConfig : Object.keys(changes);
        const skipped = changeKeys.filter((key) => !updatedConfig.includes(key));
        setConfigSync({
          total: changeKeys.length,
          updated: updatedConfig.length,
          skipped,
          configPath: res.configPath || serverMeta?.configPath || null,
        });
        if (res.configPath && (!serverMeta || serverMeta.configPath !== res.configPath)) {
          setServerMeta((prev) => ({
            ...(prev || {}),
            configPath: res.configPath,
            configDir: res.configDir || prev?.configDir,
          }));
        }
        // Refresh from backend so derived/runtime-resolved values stay accurate.
        await fetchSettings({ silent: true, preserveConfigSync: true });
        setEdits({});
        emitAgentInventoryRefresh({
          source: "settings-save",
          keys: changeKeys,
        });
      }
      await runSettingsExternalEditorAction("save");
      showToast("Settings saved successfully", "success");
      haptic("medium");
      if (hasRestartSetting && changeKeys.length > 0) {
        if (restartCountdownTimer.current) {
          clearInterval(restartCountdownTimer.current);
        }
        setRestartCountdown({
          remainingMs: restartDelayMs,
          totalMs: restartDelayMs,
          keys: changeKeys.filter((key) => {
            const def = SETTINGS_SCHEMA.find((entry) => entry.key === key);
            return def?.restart;
          }),
        });
        restartCountdownTimer.current = setInterval(() => {
          setRestartCountdown((current) => {
            if (!current) return current;
            const nextRemaining = Math.max(0, current.remainingMs - 1000);
            if (nextRemaining <= 0 && restartCountdownTimer.current) {
              clearInterval(restartCountdownTimer.current);
              restartCountdownTimer.current = null;
            }
            return { ...current, remainingMs: nextRemaining };
          });
        }, 1000);
        showToast(`Restart-sensitive settings saved. Reload countdown started (${formatCountdownSeconds(restartDelayMs)}s).`, "info");
      }
    } catch (err) {
      let parsed = null;
      try {
        parsed = JSON.parse(err.message);
      } catch {
        parsed = null;
      }
      if (parsed?.fieldErrors && typeof parsed.fieldErrors === "object") {
        setErrors((prev) => ({ ...prev, ...parsed.fieldErrors }));
      }
      const message = parsed?.error || err.message;
      showToast(`Save failed: ${message}`, "error");
      haptic("heavy");
    } finally {
      setSaving(false);
    }
  }, [edits, hasRestartSetting, serverMeta, fetchSettings, getReloadDelayMs]);

  const handleCancelSave = useCallback(() => {
    setConfirmOpen(false);
  }, []);

  /* ─── Tooltip management ─── */
  const showTooltipFor = useCallback((key) => {
    clearTimeout(tooltipTimer.current);
    setActiveTooltip(key);
    tooltipTimer.current = setTimeout(() => setActiveTooltip(null), 4000);
  }, []);

  /* ─── Secret visibility toggle ─── */
  const toggleSecret = useCallback((key) => {
    haptic("light");
    setVisibleSecrets((prev) => {
      const next = { ...prev };
      next[key] = !next[key];
      return next;
    });
  }, []);

  /* ─── Build the diff for the confirm dialog ─── */
  const diffEntries = useMemo(() => {
    const serverDiffs = Object.entries(edits).map(([key, newVal]) => {
      const def = SETTINGS_SCHEMA.find((s) => s.key === key);
      const oldVal = normalizeSettingTextValue(key, serverData?.[key], { fallback: "" });
      const normalizedNewVal = normalizeSettingTextValue(key, newVal, { fallback: "" });
      const displayOld = def?.sensitive ? maskValue(oldVal) : oldVal || "(unset)";
      const displayNew = def?.sensitive ? maskValue(normalizedNewVal) : normalizedNewVal || "(unset)";
      return { key, label: def?.label || key, oldVal: displayOld, newVal: displayNew };
    });
    const externalDiffs = externalPendingKeys.map((key) => ({
      key,
      label:
        key === "settings-voice-endpoints"
          ? "Voice Endpoints"
          : key === "settings-voice-providers"
            ? "Voice Providers"
            : key === "settings-pr-automation"
              ? "PR Automation Trust Policy"
            : key,
      oldVal: "(unsaved)",
      newVal: "Will be saved",
    }));
    return [...serverDiffs, ...externalDiffs];
  }, [edits, serverData, externalPendingKeys, normalizeSettingTextValue]);

  /* ═══════════════════════════════════════════════
   *  Render a single setting control
   * ═══════════════════════════════════════════════ */
  const renderSetting = useCallback(
    (def) => {
      const value = getValue(def.key);
      const modified = isModified(def.key);
      const defaultMatch = isDefault(def);
      const error = errors[def.key];
      const isSensitive = def.sensitive;
      const secretVisible = visibleSecrets[def.key];
      const rawValue =
        def.key in edits
          ? edits[def.key]
          : (serverData && def.key in serverData ? serverData[def.key] : "");
      const effectiveType = inferStructuredInputKind({
        type: def.type,
        value: rawValue,
        defaultValue: def.defaultVal,
      });

      /* Choose input control based on type */
      let control = null;

      switch (effectiveType) {
        case "boolean": {
          const checked =
            value === "true" || value === "1" || value === true;
          control = html`
            <${Toggle}
              checked=${checked}
              onChange=${(v) => handleChange(def.key, v ? "true" : "false")}
            />
          `;
          break;
        }

        case "select": {
          const opts = def.options || [];
          const allowsCustom = opts.includes("custom");
          const presetOpts = allowsCustom ? opts.filter((o) => o !== "custom") : opts;
          const currentValue =
            value || (def.defaultVal != null ? String(def.defaultVal) : "");
          const isCustomValue =
            allowsCustom &&
            currentValue !== "" &&
            !presetOpts.includes(currentValue);
          const customMode = Boolean(customSelectMode[def.key] || isCustomValue);

          if (presetOpts.length <= 4 && !allowsCustom) {
            // SegmentedControl for ≤4 options
            control = html`
              <${SegmentedControl}
                options=${presetOpts.map((o) => ({ value: o, label: o }))}
                value=${currentValue}
                onChange=${(v) => handleChange(def.key, v)}
              />
            `;
          } else {
            // Dropdown for >4 options, and for any custom-enabled setting.
            control = html`
              <div class="setting-input-wrap">
                <${Select}
                  size="small"
                  value=${customMode ? "__custom__" : currentValue}
                  onChange=${(e) => {
                    const nextValue = String(e.target.value || "");
                    if (nextValue === "__custom__") {
                      setCustomSelectMode((prev) => ({ ...prev, [def.key]: true }));
                      if (!isCustomValue) handleChange(def.key, "");
                      return;
                    }
                    setCustomSelectMode((prev) => ({ ...prev, [def.key]: false }));
                    handleChange(def.key, nextValue);
                  }}
                >
                  ${presetOpts.map(
                    (o) => html`<${MenuItem} key=${o} value=${o}>${o}<//>`,
                  )}
                  ${allowsCustom ? html`<${MenuItem} value="__custom__">custom...<//>` : null}
                <//>
                ${allowsCustom && customMode ? html`
                  <${TextField}
                    size="small"
                    variant="outlined"
                    fullWidth
                    value=${String(isCustomValue ? currentValue : (value || ""))}
                    placeholder="Enter custom value..."
                    onInput=${(e) => handleChange(def.key, e.target.value)}
                  />
                ` : null}
              </div>
            `;
          }
          break;
        }

        case "secret": {
          control = html`
            <div class="setting-input-wrap setting-input-wrap--secret">
              <${TextField}
                type=${secretVisible ? "text" : "password"}
                size="small"
                variant="outlined"
                fullWidth
                className="setting-secret-field"
                value=${value}
                placeholder="Enter value…"
                onInput=${(e) => handleChange(def.key, e.target.value)}
                InputProps=${{
                  endAdornment: html`
                    <${InputAdornment} position="end">
                      <${IconButton}
                        size="small"
                        onClick=${(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          toggleSecret(def.key);
                        }}
                        title=${secretVisible ? "Hide" : "Show"}
                      >
                        ${resolveIcon(secretVisible ? ":eyeOff:" : ":eye:")}
                      <//>
                    </${InputAdornment}>
                  `,
                }}
              />
            </div>
          `;
          break;
        }

        case "number": {
          control = html`
            <div class="setting-input-wrap">
              <${TextField}
                type="number"
                size="small"
                variant="outlined"
                value=${value}
                placeholder=${def.defaultVal != null ? String(def.defaultVal) : ""}
                inputProps=${{ min: def.min, max: def.max }}
                onInput=${(e) => handleChange(def.key, e.target.value)}
              />
              ${def.unit && html`<span class="setting-unit">${def.unit}</span>`}
            </div>
          `;
          break;
        }

        case "text": {
          control = html`
            <div class="setting-input-wrap">
              <${TextField}
                multiline
                rows=${3}
                size="small"
                variant="outlined"
                fullWidth
                value=${value}
                placeholder=${def.defaultVal != null ? String(def.defaultVal) : "Enter value…"}
                onInput=${(e) => handleChange(def.key, e.target.value)}
              />
            </div>
          `;
          break;
        }

        case "json": {
          control = html`
            <div class="setting-input-wrap">
              <${TextField}
                multiline
                minRows=${6}
                size="small"
                variant="outlined"
                fullWidth
                value=${value}
                placeholder=${def.defaultVal != null ? toEditableTextValue(def.defaultVal, { pretty: true }) : "{\n  \n}"}
                onInput=${(e) => handleChange(def.key, e.target.value)}
                helperText="JSON object or array"
                InputProps=${{
                  sx: { fontFamily: "'Fira Code', monospace", fontSize: "0.82rem" },
                }}
              />
            </div>
          `;
          break;
        }

        default: {
          // string type
          control = def.key === "EXECUTORS"
            ? html`<${ExecutorRoutingPoolEditor} value=${rawValue || value} onChange=${(nextValue) => handleChange(def.key, nextValue)} />`
            : html`
                <div class="setting-input-wrap">
                  <${TextField}
                    size="small"
                    variant="outlined"
                    fullWidth
                    value=${value}
                    placeholder=${def.defaultVal != null ? String(def.defaultVal) : "Enter value…"}
                    onInput=${(e) => handleChange(def.key, e.target.value)}
                  />
                </div>
              `;
          break;
        }
      }

      return html`
        <div class="setting-row" key=${def.key}>
          <div class="setting-row-header">
            ${modified && html`<span class="setting-modified-dot" title="Unsaved change"></span>`}
            <span class="setting-row-label">${def.label}</span>
            ${defaultMatch && !modified && html`<span class="setting-default-tag">(default)</span>`}
            ${def.restart && html`<${Badge} status="warning" text="restart" className="badge-sm" />`}
            <${IconButton}
              size="small"
              className="setting-help-btn"
              onClick=${(e) => {
                e.stopPropagation();
                showTooltipFor(def.key);
              }}
              title=${def.description}
            >
              ?
              ${activeTooltip === def.key &&
              html`<div class="setting-help-tooltip">${def.description}</div>`}
            <//>
          </div>
          <div class="setting-row-key">${def.key}</div>
          ${control}
          ${error && html`<div class="setting-validation-error">${iconText(`:alert: ${error}`)}</div>`}
        </div>
      `;
    },
    [getValue, isModified, isDefault, errors, visibleSecrets, activeTooltip, handleChange, toggleSecret, showTooltipFor, customSelectMode, edits, serverData],
  );

  /* ═══════════════════════════════════════════════
   *  Render
   * ═══════════════════════════════════════════════ */

  /* Backend health banner */
  const wsOk = wsConnected.value;

  return html`
    <!-- Health banners -->
    ${loadError &&
    html`
      <div class="settings-banner settings-banner-error">
        <span>${resolveIcon(":alert:")}</span>
        <span class="settings-banner-text">
          <strong>Backend Unreachable</strong> — ${loadError}
        </span>
        <${Button} variant="text" size="small" onClick=${fetchSettings}>Retry<//>
      </div>
    `}

    ${!wsOk &&
    !loadError &&
    html`
      <div class="settings-banner settings-banner-warn">
        <span>${resolveIcon(":cpu:")}</span>
        <span class="settings-banner-text">Connection lost — reconnecting…</span>
      </div>
    `}

    ${configSync &&
    html`
      <div class="settings-banner ${configSync.skipped?.length ? "settings-banner-warn" : "settings-banner-info"}">
        <span>${resolveIcon(":save:")}</span>
        <span class="settings-banner-text">
          ${configSync.skipped?.length
            ? `Saved ${configSync.total} settings; synced ${configSync.updated} to config file.`
            : `Synced ${configSync.updated} settings to config file.`}
          ${configSync.configPath &&
          html`<div style="margin-top:4px;font-size:12px;color:var(--text-secondary, #bbb)">
            Config: <code>${configSync.configPath}</code>
          </div>`}
          ${configSync.skipped?.length &&
          html`<div style="margin-top:2px;font-size:12px;color:var(--text-secondary, #bbb)">
            Not supported in config: ${configSync.skipped.slice(0, 4).join(", ")}${configSync.skipped.length > 4 ? ` +${configSync.skipped.length - 4} more` : ""}
          </div>`}
        </span>
      </div>
    `}

    ${serverMeta?.configPath &&
    !loadError &&
    html`
      <div class="settings-banner settings-banner-info settings-banner-paths">
        <span>${resolveIcon(":compass:")}</span>
        <div class="settings-banner-text">
          <div class="settings-banner-title">Server settings write to these files</div>
          <div class="settings-banner-path-list">
            <div class="settings-banner-path">
              <div class="settings-banner-path-label">.env file</div>
              <code>${serverMeta.envPath}</code>
            </div>
            <div class="settings-banner-path">
              <div class="settings-banner-path-label">Config JSON</div>
              <code>${serverMeta.configPath}</code>
            </div>
          </div>
        </div>
      </div>
    `}

    ${restartCountdown &&
    html`
      <div class="settings-banner ${restartCountdownSeconds <= 2 ? "settings-banner-warn" : "settings-banner-info"}">
        <span>${resolveIcon(":refresh:")}</span>
        <span class="settings-banner-text">
          <strong>
            ${restartCountdownSeconds > 0
              ? `Reload scheduled in ${restartCountdownSeconds}s`
              : wsOk
                ? "Reload window elapsed"
                : "Reloading now"}
          </strong>
          ${restartCountdown.keys?.length
            ? ` — Applying restart-sensitive changes: ${restartCountdown.keys.slice(0, 3).join(", ")}${restartCountdown.keys.length > 3 ? ` +${restartCountdown.keys.length - 3} more` : ""}.`
            : " — Applying restart-sensitive configuration updates."}
          ${!wsOk ? " Connection may drop briefly while Bosun restarts." : " Connection may briefly reset while Bosun reloads."}
        </span>
      </div>
    `}

    <!-- Search bar -->
    <div class="settings-search">
      <${SearchInput}
        value=${searchQuery}
        onInput=${(e) => setSearchQuery(e.target.value)}
        onClear=${() => setSearchQuery("")}
        placeholder="Search settings…"
      />
    </div>

    <!-- Advanced toggle -->
    <div style="display:flex;align-items:center;justify-content:flex-end;margin-bottom:8px">
      <${Toggle}
        checked=${showAdvanced}
        onChange=${(v) => { setShowAdvanced(v); haptic("light"); }}
        label="Show Advanced"
      />
    </div>

    <!-- Loading state -->
    ${loading &&
    html`
      <${SkeletonCard} height="40px" />
      <${SkeletonCard} height="120px" />
      <${SkeletonCard} height="120px" />
    `}

    <!-- Content: search results or category browsing -->
    ${!loading &&
    serverData &&
    (() => {
      /* ── Search mode ── */
      if (filteredSettings) {
        if (filteredSettings.length === 0) {
          return html`
            <div class="settings-empty-search">
              <div class="settings-empty-search-icon">${resolveIcon(":search:")}</div>
              <div>No settings match "<strong>${searchQuery}</strong>"</div>
              <div class="meta-text mt-sm">Try a different search term</div>
            </div>
          `;
        }
        return html`
          <${Card}>
            <div class="card-subtitle mb-sm">
              ${filteredSettings.length} result${filteredSettings.length !== 1 ? "s" : ""}
            </div>
            ${filteredSettings.map((def) => renderSetting(def))}
          <//>
        `;
      }

      /* ── Category browsing mode ── */
      const catDefs = activeCategory === "context-shredding"
        ? SETTINGS_SCHEMA.filter((def) => isContextShreddingSetting(def))
        : (grouped.get(activeCategory) || []).filter((def) => (
            activeCategory !== "executor"
            || isExecutorSettingVisible(def, activeAgentRuntime, { hasExplicitHarnessExecutors })
          ));
      const activeCat = CATEGORIES.find((c) => c.id === activeCategory);

      return html`
        <div class="settings-category-mobile">
          <label class="settings-category-mobile-label">Category</label>
          <div class="setting-input-wrap">
            <${Select}
              size="small"
              value=${activeCategory}
              onChange=${(e) => {
                setActiveCategory(e.target.value);
                haptic("light");
              }}
            >
              ${CATEGORIES.map((cat) => html`<${MenuItem} key=${cat.id} value=${cat.id}>${cat.label}<//>`)}
            <//>
          </div>
        </div>

        <!-- Category tabs -->
        <div class="settings-category-tabs">
          ${CATEGORIES.map(
            (cat) => html`
              <${Button}
                key=${cat.id}
                className="settings-category-tab ${activeCategory === cat.id ? "active" : ""}"
                onClick=${() => {
                  setActiveCategory(cat.id);
                  haptic("light");
                }}
              >
                <span class="settings-category-tab-icon">${resolveIcon(cat.icon) || cat.icon}</span>
                ${cat.label}
              <//>
            `,
          )}
        </div>

        <!-- Category description -->
        ${activeCat?.description &&
        html`<div class="settings-cat-desc">${activeCat.description}</div>`}

        ${activeCategory === "executor" && html`
          <${AgentArchitectureGuide} architecture=${agentArchitecture} />
          <${HarnessExecutorsEditor} />
        `}

        <!-- GitHub Device Flow login card -->
        ${activeCategory === "github" && html`<${GitHubDeviceFlowCard} config=${serverData} />`}

        <!-- Gates and safeguards editors -->
        ${activeCategory === "gates" && html`
          <${GatesEditor} />
          <${PrAutomationTrustEditor} />
        `}

        <!-- Context Shredding overview panel -->
        ${activeCategory === "context-shredding" && html`<${ContextShreddingPanel} getValue=${getValue} />`}

        <!-- Voice Endpoints card-based editor (synced with /setup) -->
        ${activeCategory === "voice" && html`<${VoiceEndpointsEditor} />`}

        <!-- Voice Providers editor (routing order with endpoint linking) -->
        ${activeCategory === "voice" && html`<${VoiceProvidersEditor} />`}

        <!-- OpenAI Codex OAuth login card (voice category) -->
        ${activeCategory === "voice" && html`<${OpenAICodexLoginCard} />`}

        <!-- Claude OAuth login card (voice category) -->
        ${activeCategory === "voice" && html`<${ClaudeLoginCard} />`}

        <!-- Google Gemini OAuth login card (voice category) -->
        ${activeCategory === "voice" && html`<${GeminiLoginCard} />`}

        <!-- Settings list for active category -->
        ${catDefs.length === 0
          ? html`
              <${Card}>
                <div class="meta-text" style="text-align:center;padding:24px 0">
                  No settings in this category${!showAdvanced ? " (try enabling Advanced)" : ""}
                </div>
              <//>
            `
          : activeCategory === "executor"
            ? groupExecutorSettings(catDefs).map((section) => html`
                <${Card} key=${section.title}>
                  <div class="card-subtitle mb-sm" style="font-size:13px;font-weight:700">${section.title}</div>
                  ${section.description && html`<div class="meta-text mb-sm">${section.description}</div>`}
                  ${section.defs.map((def) => renderSetting(def))}
                <//>
              `)
            : html`
                <${Card}>
                  ${catDefs.map((def) => renderSetting(def))}
                <//>
              `}
      `;
    })()}

    <!-- Empty state when no data and no error -->
    ${!loading &&
    !serverData &&
    !loadError &&
    html`
      <${Card}>
        <div class="meta-text" style="text-align:center;padding:24px 0">
          No settings data available.
        </div>
      <//>
    `}

    <!-- Floating save bar - only when action or reload state exists -->
    ${(changeCount > 0 || restartCountdownSeconds != null) && html`
      <div class=${`settings-save-bar ${changeCount > 0 ? 'settings-save-bar--dirty' : 'settings-save-bar--clean'}`}>
        <div class="save-bar-info">
          <span class=${`setting-modified-dot ${changeCount === 0 ? 'setting-modified-dot--clean' : ''}`}></span>
          <span>
            ${changeCount > 0
              ? `${changeCount} unsaved change${changeCount !== 1 ? "s" : ""}`
              : restartCountdownSeconds > 0
                ? `Reload scheduled in ${restartCountdownSeconds}s`
                : (wsOk ? "Waiting for runtime reload" : "Restarting now")}
          </span>
        </div>
        <div class="save-bar-actions">
          ${changeCount > 0 && html`
            <${Button} variant="text" size="small" onClick=${handleDiscard}>
              Discard
            <//>
            <${Button}
              variant="contained"
              color="primary"
              size="small"
              onClick=${handleSaveClick}
              disabled=${saving}
            >
              ${saving ? html`<${Spinner} size=${14} /> Saving…` : "Save Changes"}
            <//>
          `}
        </div>
      </div>
    `}

    <!-- Confirm dialog with diff -->
    ${confirmOpen &&
    html`
      <${Modal} title="Confirm Changes" open=${true} onClose=${handleCancelSave}>
        <div style="padding:4px 0">
          <div class="meta-text mb-sm">
            Review ${diffEntries.length} change${diffEntries.length !== 1 ? "s" : ""} before saving:
          </div>
          <div class="settings-diff">
            ${diffEntries.map(
              (d) => html`
                <div class="settings-diff-row" key=${d.key}>
                  <div class="settings-diff-key">${d.label}</div>
                  <div class="settings-diff-old" style=${{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>− ${d.oldVal}</div>
                  <div class="settings-diff-new" style=${{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>+ ${d.newVal}</div>
                </div>
              `,
            )}
          </div>
          ${hasRestartSetting &&
          html`
            <div class="settings-banner settings-banner-warn" style="margin-top:8px">
              <span>${resolveIcon(":refresh:")}</span>
              <span class="settings-banner-text">
                Some changes require a restart. Bosun will begin reloading after about ${formatCountdownSeconds(getReloadDelayMs(edits))}s, and the countdown will stay visible after save.
              </span>
            </div>
          `}
          <div class="btn-row mt-md" style="justify-content:flex-end;gap:8px">
            <${Button} variant="text" onClick=${handleCancelSave}>Cancel<//>
            <${Button} variant="contained" color="primary" onClick=${handleConfirmSave} disabled=${saving}>
              ${saving ? html`<${Spinner} size=${14} /> Saving…` : "Confirm & Save"}
            <//>
          </div>
        </div>
      <//>
    `}
  `;
}

/* ── Inline CSS vars to override Telegram's applyTgTheme() inline styles ──
 * telegram.js sets --bg-primary, --accent etc. as element.style, which beats
 * any CSS rule (including [data-theme] selectors).  We must use setProperty()
 * too when applying a named theme, and restore the Telegram values on "system".
 */
const THEME_INLINE_VARS = {
  dark: {
    "--bg-primary": "#1f1e1c", "--bg-secondary": "#262522", "--bg-card": "#2b2a27",
    "--text-primary": "#e8e5de", "--text-secondary": "#b5b0a6", "--text-hint": "#908b81",
    "--accent": "#da7756", "--accent-text": "#1e1d1a",
  },
  "dark-blue": {
    "--bg-primary": "#0b0f14", "--bg-secondary": "#131a24", "--bg-card": "#131a24",
    "--text-primary": "#f1f5f9", "--text-secondary": "#94a3b8", "--text-hint": "#64748b",
    "--accent": "#4cc9f0", "--accent-text": "#000000",
  },
  midnight: {
    "--bg-primary": "#0d1117", "--bg-secondary": "#161b22", "--bg-card": "#21262d",
    "--text-primary": "#e6edf3", "--text-secondary": "#8b949e", "--text-hint": "#6e7681",
    "--accent": "#7c3aed", "--accent-text": "#ffffff",
  },
  dracula: {
    "--bg-primary": "#282a36", "--bg-secondary": "#21222c", "--bg-card": "#313342",
    "--text-primary": "#f8f8f2", "--text-secondary": "#9da5c8", "--text-hint": "#6272a4",
    "--accent": "#ff79c6", "--accent-text": "#282a36",
  },
  nord: {
    "--bg-primary": "#2e3440", "--bg-secondary": "#272c38", "--bg-card": "#3b4252",
    "--text-primary": "#eceff4", "--text-secondary": "#d8dee9", "--text-hint": "#9ba8be",
    "--accent": "#88c0d0", "--accent-text": "#2e3440",
  },
  monokai: {
    "--bg-primary": "#272822", "--bg-secondary": "#1e1f1c", "--bg-card": "#32332c",
    "--text-primary": "#f8f8f2", "--text-secondary": "#a59f85", "--text-hint": "#75715e",
    "--accent": "#a6e22e", "--accent-text": "#1e1f1c",
  },
  "github-dark": {
    "--bg-primary": "#0d1117", "--bg-secondary": "#161b22", "--bg-card": "#21262d",
    "--text-primary": "#e6edf3", "--text-secondary": "#8b949e", "--text-hint": "#6e7681",
    "--accent": "#58a6ff", "--accent-text": "#0d1117",
  },
  ayu: {
    "--bg-primary": "#0a0e14", "--bg-secondary": "#0d1017", "--bg-card": "#131721",
    "--text-primary": "#bfbdb6", "--text-secondary": "#565b66", "--text-hint": "#494f5c",
    "--accent": "#ff8f40", "--accent-text": "#0a0e14",
  },
  dawn: {
    "--bg-primary": "#fdf6e3", "--bg-secondary": "#eee8d5", "--bg-card": "#ffffff",
    "--text-primary": "#657b83", "--text-secondary": "#839496", "--text-hint": "#93a1a1",
    "--accent": "#b58900", "--accent-text": "#ffffff",
  },
};

const THEME_STORAGE_KEY = "ve_settings_colorTheme";
const THEME_LOCK_ATTR = "data-theme-lock";

/* ═══════════════════════════════════════════════════════════════
 *  AppPreferencesMode — existing client-side preferences
 * ═══════════════════════════════════════════════════════════════ */
function AppPreferencesMode() {
  const tg = globalThis.Telegram?.WebApp;
  const user = tg?.initDataUnsafe?.user;

  /* Preferences (loaded from CloudStorage) */
  const [fontSize, setFontSize] = useState("medium");
  const [colorTheme, setColorTheme] = useState("system");
  const [notifyUpdates, setNotifyUpdates] = useState(true);
  const [notifyErrors, setNotifyErrors] = useState(true);
  const [notifyComplete, setNotifyComplete] = useState(true);
  const [debugMode, setDebugMode] = useState(false);
  const [showRawJson, setShowRawJson] = useState(false);
  const [loaded, setLoaded] = useState(false);

  /* Apply font size to the document */
  function applyFontSize(size) {
    if (!size) return;
    const map = { small: "13px", medium: "15px", large: "17px" };
    const px = map[size] || map.medium;
    document.documentElement.style.setProperty("--base-font-size", px);
    const numSize = parseInt(px, 10);
    if (numSize >= 10 && numSize <= 24) {
      document.documentElement.style.fontSize = `${numSize}px`;
    }
  }

  /* Apply colour theme to the document */
  function applyColorTheme(theme) {
    const root = document.documentElement;
    const tgVarKeys = ["--bg-primary","--bg-secondary","--bg-card","--text-primary","--text-secondary","--text-hint","--accent","--accent-text"];
    if (!theme || theme === "system") {
      root.removeAttribute("data-theme");
      root.setAttribute(THEME_LOCK_ATTR, "system");
      // Restore Telegram-supplied inline vars (or clear ours if no Telegram context)
      const tp = globalThis.Telegram?.WebApp?.themeParams;
      if (tp) {
        if (tp.bg_color)            root.style.setProperty("--bg-primary", tp.bg_color);
        if (tp.secondary_bg_color)  { root.style.setProperty("--bg-secondary", tp.secondary_bg_color); root.style.setProperty("--bg-card", tp.secondary_bg_color); }
        if (tp.text_color)          root.style.setProperty("--text-primary", tp.text_color);
        if (tp.hint_color)          { root.style.setProperty("--text-secondary", tp.hint_color); root.style.setProperty("--text-hint", tp.hint_color); }
        if (tp.button_color)        root.style.setProperty("--accent", tp.button_color);
        if (tp.button_text_color)   root.style.setProperty("--accent-text", tp.button_text_color);
      } else {
        tgVarKeys.forEach(k => root.style.removeProperty(k));
      }
    } else {
      root.setAttribute("data-theme", theme);
      root.setAttribute(THEME_LOCK_ATTR, "custom");
      // Also set as inline styles to beat telegram.js's element.style values
      const vars = THEME_INLINE_VARS[theme];
      if (vars) {
        Object.entries(vars).forEach(([k, v]) => root.style.setProperty(k, v));
      } else {
        tgVarKeys.forEach((k) => root.style.removeProperty(k));
      }
    }

    try {
      localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(theme || "system"));
    } catch {
      /* ignore storage errors */
    }
  }

  /* Load prefs from CloudStorage on mount */
  useEffect(() => {
    (async () => {
      try {
        const [fs, ct, nu, ne, nc, dm] = await Promise.all([
          cloudGet("fontSize"),
          cloudGet("colorTheme"),
          cloudGet("notifyUpdates"),
          cloudGet("notifyErrors"),
          cloudGet("notifyComplete"),
          cloudGet("debugMode"),
        ]);
        if (fs) {
          setFontSize(fs);
          applyFontSize(fs);
        }
        if (ct) {
          setColorTheme(ct);
          applyColorTheme(ct);
        }
        if (nu != null) setNotifyUpdates(nu);
        if (ne != null) setNotifyErrors(ne);
        if (nc != null) setNotifyComplete(nc);
        if (dm != null) setDebugMode(dm);
      } catch (err) {
        console.warn('[AppPrefs] Failed to load preferences:', err);
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  /* Persist helpers */
  const toggle = useCallback((key, getter, setter) => {
    const next = !getter;
    setter(next);
    cloudSet(key, next);
    console.log('[AppPrefs] Saved:', key, next);
    haptic();
    showToast("Preference saved", "success");
  }, []);

  const handleFontSize = (v) => {
    setFontSize(v);
    cloudSet("fontSize", v);
    console.log('[AppPrefs] Saved: fontSize', v);
    haptic();
    applyFontSize(v);
    showToast("Font size saved", "success");
  };

  const handleColorTheme = (v) => {
    setColorTheme(v);
    cloudSet("colorTheme", v);
    console.log('[AppPrefs] Saved: colorTheme', v);
    haptic();
    applyColorTheme(v);
    showToast("Theme saved", "success");
  };

  /* Clear cache */
  const handleClearCache = async () => {
    const ok = await showConfirm("Clear all cached data and preferences?");
    if (!ok) return;
    haptic("medium");
    const keys = [
      "fontSize",
      "colorTheme",
      "notifyUpdates",
      "notifyErrors",
      "notifyComplete",
      "debugMode",
    ];
    for (const k of keys) cloudRemove(k);
    showToast("Cache cleared — reload to apply", "success");
  };

  /* Reset all settings */
  const handleReset = async () => {
    const ok = await showConfirm("Reset ALL settings to defaults?");
    if (!ok) return;
    haptic("heavy");
    const keys = [
      "fontSize",
      "colorTheme",
      "notifyUpdates",
      "notifyErrors",
      "notifyComplete",
      "debugMode",
    ];
    for (const k of keys) cloudRemove(k);
    setFontSize("medium");
    setNotifyUpdates(true);
    setNotifyErrors(true);
    setNotifyComplete(true);
    setDebugMode(false);
    setColorTheme("system");
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.setAttribute(THEME_LOCK_ATTR, "system");
    document.documentElement.style.removeProperty("--base-font-size");
    document.documentElement.style.removeProperty("font-size");
    showToast("Settings reset", "success");
  };

  /* Raw status JSON */
  const rawJson =
    debugMode && showRawJson
      ? JSON.stringify(
          { status: statusData?.value, executor: executorData?.value },
          null,
          2,
        )
      : "";

  return html`


    <!-- ─── Account ─── -->
    <${Collapsible} title=${iconText(":users: Account")} defaultOpen=${true}>
      <${Card}>
        <div class="settings-row">
          ${user?.photo_url &&
          html`
            <img
              src=${user.photo_url}
              alt="avatar"
              class="settings-avatar"
              style="width:48px;height:48px;border-radius:50%;margin-right:12px"
            />
          `}
          <div>
            <div style="font-weight:600;font-size:15px">
              ${user?.first_name || "Local"} ${user?.last_name || ""}
            </div>
            ${user?.username &&
            html`<div class="meta-text">@${user.username}</div>`}
          </div>
        </div>
        <div class="meta-text mt-sm">App version: ${APP_VERSION}</div>
      <//>
    <//>

    <!-- ─── Appearance ─── -->
    <${Collapsible} title=${iconText(":palette: Appearance")} defaultOpen=${false}>
      <${Card}>
        <div class="card-subtitle mb-sm">Color Theme</div>
        <div class="theme-picker-grid">
          ${[
            { id: "system", label: "System", bg: "var(--tg-theme-bg-color, #1f1e1c)", accent: "var(--tg-theme-button-color, #da7756)", desc: "Auto" },
            { id: "dark", label: "Bosun Dark", bg: "#1f1e1c", accent: "#da7756", desc: "Warm" },
            { id: "dark-blue", label: "Dark Blue", bg: "#0b0f14", accent: "#4cc9f0", desc: "Cyber" },
            { id: "midnight", label: "Midnight", bg: "#0d1117", accent: "#7c3aed", desc: "Purple" },
            { id: "dracula", label: "Dracula", bg: "#282a36", accent: "#ff79c6", desc: "Pink" },
            { id: "nord", label: "Nord", bg: "#2e3440", accent: "#88c0d0", desc: "Arctic" },
            { id: "monokai", label: "Monokai", bg: "#272822", accent: "#a6e22e", desc: "Classic" },
            { id: "github-dark", label: "GitHub Dark", bg: "#0d1117", accent: "#58a6ff", desc: "Blue" },
            { id: "ayu", label: "Ayu", bg: "#0a0e14", accent: "#ff8f40", desc: "Orange" },
            { id: "dawn", label: "Dawn", bg: "#fdf6e3", accent: "#b58900", desc: "Light" },
          ].map((theme) => html`
            <${Button}
              key=${theme.id}
              variant="text"
              size="small"
              class="theme-swatch ${colorTheme === theme.id ? "active" : ""}"
              title=${theme.label}
              onClick=${() => handleColorTheme(theme.id)}
            >
              <div class="theme-swatch-preview">
                <div class="swatch-bg" style="background: ${theme.bg}"></div>
                <div class="swatch-accent" style="background: ${theme.accent}"></div>
              </div>
              <div class="swatch-label">${theme.label}</div>
              <div class="swatch-desc">${theme.desc}</div>
              <div class="theme-swatch-state">${colorTheme === theme.id ? "Selected" : ""}</div>
            <//>
          `)}
        </div>
        <div class="meta-text mt-sm mb-md" style="font-size: 11px;">
          ${colorTheme === "system"
            ? html`Follows your ${tg ? "Telegram" : "OS"} theme automatically.`
            : html`Using <strong>${colorTheme}</strong> theme. Saved app theme overrides Telegram/browser palette mixing.`}
        </div>
        <div class="card-subtitle mb-sm">Font Size</div>
        <${SegmentedControl}
          options=${[
            { value: "small", label: "Small" },
            { value: "medium", label: "Medium" },
            { value: "large", label: "Large" },
          ]}
          value=${fontSize}
          onChange=${handleFontSize}
        />
      <//>
    <//>

    <!-- ─── Notifications ─── -->
    <${Collapsible} title=${iconText(":bell: Notifications")} defaultOpen=${false}>
      <${Card}>
        <${ListItem}
          title="Real-time Updates"
          subtitle="Show live data refresh indicators"
          trailing=${html`
            <${Toggle}
              checked=${notifyUpdates}
              onChange=${() =>
                toggle("notifyUpdates", notifyUpdates, setNotifyUpdates)}
            />
          `}
        />
        <${ListItem}
          title="Error Alerts"
          subtitle="Toast notifications for errors"
          trailing=${html`
            <${Toggle}
              checked=${notifyErrors}
              onChange=${() =>
                toggle("notifyErrors", notifyErrors, setNotifyErrors)}
            />
          `}
        />
        <${ListItem}
          title="Task Completion"
          subtitle="Notify when tasks finish"
          trailing=${html`
            <${Toggle}
              checked=${notifyComplete}
              onChange=${() =>
                toggle("notifyComplete", notifyComplete, setNotifyComplete)}
            />
          `}
        />
      <//>
    <//>

    <!-- ─── Data & Storage ─── -->
    <${Collapsible} title=${iconText(":save: Data & Storage")} defaultOpen=${false}>
      <${Card}>
        <${ListItem}
          title="WebSocket"
          subtitle="Live connection status"
          trailing=${html`
            <${Badge}
              status=${connected?.value ? "done" : "error"}
              text=${connected?.value ? "Connected" : "Offline"}
            />
          `}
        />
        <${ListItem}
          title="API Endpoint"
          subtitle=${globalThis.location?.origin || "unknown"}
        />
        <${ListItem}
          title="Clear Cache"
          subtitle="Remove all stored preferences"
          trailing=${html`
            <${Button} variant="text" size="small" onClick=${handleClearCache}>
              ${iconText(":trash: Clear")}
            <//>
          `}
        />
      <//>
    <//>

    <!-- ─── Advanced ─── -->
    <${Collapsible} title=${iconText(":settings: Advanced")} defaultOpen=${false}>
      <${Card}>
        <${ListItem}
          title="Debug Mode"
          subtitle="Show raw data and extra diagnostics"
          trailing=${html`
            <${Toggle}
              checked=${debugMode}
              onChange=${() => toggle("debugMode", debugMode, setDebugMode)}
            />
          `}
        />

        ${debugMode &&
        html`
          <${ListItem}
            title="Raw Status JSON"
            subtitle="View raw API response data"
            trailing=${html`
              <${Button}
                variant="text"
                size="small"
                onClick=${() => {
                  setShowRawJson(!showRawJson);
                  haptic();
                }}
              >
                ${showRawJson ? "Hide" : "Show"}
              <//>
            `}
          />
          ${showRawJson &&
          html`
            <div class="log-box mt-sm" style="max-height:300px;font-size:11px">
              ${rawJson}
            </div>
          `}
        `}

        <${ListItem}
          title="Reset All Settings"
          subtitle="Restore defaults"
          trailing=${html`
            <${Button} variant="contained" color="error" size="small" onClick=${handleReset}>
              Reset
            <//>
          `}
        />
      <//>
    <//>

    <!-- ─── About ─── -->
    <${Collapsible} title=${iconText(":help: About")} defaultOpen=${false}>
      <${Card}>
        <div style="text-align:center;padding:12px 0">
          <div style="font-size:18px;font-weight:700;margin-bottom:4px">
            ${APP_NAME}
          </div>
          <div class="meta-text">Version ${APP_VERSION}</div>
          <div class="meta-text mt-sm">
            Telegram Mini App for Bosun task orchestration
          </div>
          <div class="meta-text mt-sm">
            Built with Preact + HTM.
          </div>
          <div class="btn-row mt-md" style="justify-content:center">
            <${Button}
              variant="text"
              size="small"
              onClick=${() => {
                haptic();
                const tg = globalThis.Telegram?.WebApp;
                if (tg?.openLink)
                  tg.openLink("https://github.com/virtengine/bosun?tab=readme-ov-file#bosun");
                else
                  globalThis.open(
                    "https://github.com/virtengine/bosun?tab=readme-ov-file#bosun",
                    "_blank",
                  );
              }}
            >
              GitHub
            <//>
            <${Button}
              variant="text"
              size="small"
              onClick=${() => {
                haptic();
                const tg = globalThis.Telegram?.WebApp;
                if (tg?.openLink) tg.openLink("https://docs.virtengine.com");
                else globalThis.open("https://docs.virtengine.com", "_blank");
              }}
            >
              Docs
            <//>
          </div>
        </div>
      <//>
    <//>
  `;
}

function normalizeTrustedAuthorEntries(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((entry) => String(entry || "").trim()).filter(Boolean))];
  }
  return [...new Set(
    String(value || "")
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  )];
}

function normalizeGatePatternEntries(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((entry) => String(entry || "").trim()).filter(Boolean))];
  }
  return [...new Set(
    String(value || "")
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  )];
}

function normalizeGatesEditorState(policy = {}) {
  const prs = policy?.prs && typeof policy.prs === "object" ? policy.prs : {};
  const checks = policy?.checks && typeof policy.checks === "object" ? policy.checks : {};
  const execution = policy?.execution && typeof policy.execution === "object" ? policy.execution : {};
  const runtime = policy?.runtime && typeof policy.runtime === "object" ? policy.runtime : {};
  const requiredPatterns = normalizeGatePatternEntries(
    policy?.requiredPatternsText ?? policy?.requiredPatterns ?? checks.requiredPatterns,
  );
  const optionalPatterns = normalizeGatePatternEntries(
    policy?.optionalPatternsText ?? policy?.optionalPatterns ?? checks.optionalPatterns,
  );
  const ignorePatterns = normalizeGatePatternEntries(
    policy?.ignorePatternsText ?? policy?.ignorePatterns ?? checks.ignorePatterns,
  );
  const repoVisibilityRaw = String(policy?.repoVisibility ?? prs.repoVisibility ?? "unknown").trim().toLowerCase();
  const automationPreferenceRaw = String(policy?.automationPreference ?? prs.automationPreference ?? "runtime-first").trim().toLowerCase();
  const githubActionsBudgetRaw = String(policy?.githubActionsBudget ?? prs.githubActionsBudget ?? "ask-user").trim().toLowerCase();
  const modeRaw = String(policy?.mode ?? checks.mode ?? "all").trim().toLowerCase();
  return {
    repoVisibility: ["public", "private", "unknown"].includes(repoVisibilityRaw) ? repoVisibilityRaw : "unknown",
    automationPreference: ["runtime-first", "actions-first"].includes(automationPreferenceRaw) ? automationPreferenceRaw : "runtime-first",
    githubActionsBudget: ["ask-user", "available", "limited"].includes(githubActionsBudgetRaw) ? githubActionsBudgetRaw : "ask-user",
    mode: ["all", "required-only"].includes(modeRaw) ? modeRaw : "all",
    requiredPatterns,
    requiredPatternsText: requiredPatterns.join("\n"),
    optionalPatterns,
    optionalPatternsText: optionalPatterns.join("\n"),
    ignorePatterns,
    ignorePatternsText: ignorePatterns.join("\n"),
    requireAnyRequiredCheck: (policy?.requireAnyRequiredCheck ?? checks.requireAnyRequiredCheck) !== false,
    treatPendingRequiredAsBlocking: (policy?.treatPendingRequiredAsBlocking ?? checks.treatPendingRequiredAsBlocking) !== false,
    treatNeutralAsPass: (policy?.treatNeutralAsPass ?? checks.treatNeutralAsPass) === true,
    sandboxMode: String(policy?.sandboxMode ?? execution.sandboxMode ?? "workspace-write").trim().toLowerCase() || "workspace-write",
    containerIsolationEnabled: (policy?.containerIsolationEnabled ?? execution.containerIsolationEnabled) === true,
    containerRuntime: String(policy?.containerRuntime ?? execution.containerRuntime ?? "auto").trim().toLowerCase() || "auto",
    networkAccess: String(policy?.networkAccess ?? execution.networkAccess ?? "default").trim().toLowerCase() || "default",
    enforceBacklog: (policy?.enforceBacklog ?? runtime.enforceBacklog) !== false,
    agentTriggerControl: (policy?.agentTriggerControl ?? runtime.agentTriggerControl) !== false,
  };
}

function serializeGatesEditorState(policy = {}) {
  const normalized = normalizeGatesEditorState(policy);
  return JSON.stringify({
    prs: {
      repoVisibility: normalized.repoVisibility,
      automationPreference: normalized.automationPreference,
      githubActionsBudget: normalized.githubActionsBudget,
    },
    checks: {
      mode: normalized.mode,
      requiredPatterns: normalized.requiredPatterns,
      optionalPatterns: normalized.optionalPatterns,
      ignorePatterns: normalized.ignorePatterns,
      requireAnyRequiredCheck: normalized.requireAnyRequiredCheck,
      treatPendingRequiredAsBlocking: normalized.treatPendingRequiredAsBlocking,
      treatNeutralAsPass: normalized.treatNeutralAsPass,
    },
    execution: {
      sandboxMode: normalized.sandboxMode,
      containerIsolationEnabled: normalized.containerIsolationEnabled,
      containerRuntime: normalized.containerRuntime,
      networkAccess: normalized.networkAccess,
    },
    runtime: {
      enforceBacklog: normalized.enforceBacklog,
      agentTriggerControl: normalized.agentTriggerControl,
    },
  });
}

function GatesEditor() {
  const [policy, setPolicy] = useState(() => normalizeGatesEditorState());
  const [savedPolicy, setSavedPolicy] = useState(() => normalizeGatesEditorState());
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [loadError, setLoadError] = useState(null);

  const syncDirty = useCallback((nextPolicy, baseline = savedPolicy) => {
    setDirty(serializeGatesEditorState(nextPolicy) !== serializeGatesEditorState(baseline));
  }, [savedPolicy]);

  const updatePolicy = useCallback((patch) => {
    setPolicy((prev) => {
      const next = { ...prev, ...patch };
      syncDirty(next);
      return next;
    });
  }, [syncDirty]);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch("/api/gates");
        if (!(res?.ok || res?.gates)) {
          throw new Error(res?.error || "Failed to load gates settings");
        }
        const normalized = normalizeGatesEditorState(res?.gates || {});
        setPolicy(normalized);
        setSavedPolicy(normalized);
        setDirty(false);
      } catch (err) {
        setLoadError(err.message || "Failed to load gates settings");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    const key = "settings-gates";
    setPendingChange(key, dirty);
    return () => clearPendingChange(key);
  }, [dirty]);

  const savePolicy = useCallback(async () => {
    try {
      const payload = normalizeGatesEditorState(policy);
      const res = await apiFetch("/api/gates", {
        method: "POST",
        body: JSON.stringify({
          gates: {
            prs: {
              repoVisibility: payload.repoVisibility,
              automationPreference: payload.automationPreference,
              githubActionsBudget: payload.githubActionsBudget,
            },
            checks: {
              mode: payload.mode,
              requiredPatterns: payload.requiredPatterns,
              optionalPatterns: payload.optionalPatterns,
              ignorePatterns: payload.ignorePatterns,
              requireAnyRequiredCheck: payload.requireAnyRequiredCheck,
              treatPendingRequiredAsBlocking: payload.treatPendingRequiredAsBlocking,
              treatNeutralAsPass: payload.treatNeutralAsPass,
            },
            execution: {
              sandboxMode: payload.sandboxMode,
              containerIsolationEnabled: payload.containerIsolationEnabled,
              containerRuntime: payload.containerRuntime,
              networkAccess: payload.networkAccess,
            },
            runtime: {
              enforceBacklog: payload.enforceBacklog,
              agentTriggerControl: payload.agentTriggerControl,
            },
          },
        }),
      });
      if (!res?.ok) throw new Error(res?.error || "Save failed");
      const normalized = normalizeGatesEditorState(res?.gates || payload);
      setPolicy(normalized);
      setSavedPolicy(normalized);
      setDirty(false);
      setLoadError(null);
    } catch (err) {
      throw new Error(err?.message || "Gates save failed");
    }
  }, [policy]);

  const discardPolicy = useCallback(async () => {
    setPolicy(savedPolicy);
    setDirty(false);
    setLoadError(null);
  }, [savedPolicy]);

  useEffect(() => {
    return registerSettingsExternalEditor("settings-gates", {
      isDirty: () => dirty,
      save: savePolicy,
      discard: discardPolicy,
    });
  }, [dirty, savePolicy, discardPolicy]);

  if (loading) return html`<${SkeletonCard} height="120px" />`;

  return html`
    <${Card} title="Gates And Safeguards"
      badge=${dirty ? html`<${Badge} variant="warning">Unsaved<//>` : null}>
      <div class="meta-text" style="margin-bottom:10px">
        Centralize Bosun’s blocking policy here: recommended PR automation posture, which CI checks actually gate merge, and the execution/runtime safety stance operators expect Bosun to honor.
      </div>
      ${loadError && html`<div class="settings-banner settings-banner-warn" style="margin-bottom:10px">${loadError}</div>`}

      <div style="display:grid;grid-template-columns:1fr;gap:14px">
        <div>
          <div class="setting-row-label">Repository Visibility</div>
          <${Select} size="small" value=${policy.repoVisibility} onChange=${(e) => updatePolicy({ repoVisibility: e.target.value })} fullWidth>
            <${MenuItem} value="unknown">Unknown / not detected<//>
            <${MenuItem} value="public">Public repository<//>
            <${MenuItem} value="private">Private repository<//>
          <//>
        </div>

        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">
          <div>
            <div class="setting-row-label">Automation Preference</div>
            <${Select} size="small" value=${policy.automationPreference} onChange=${(e) => updatePolicy({ automationPreference: e.target.value })} fullWidth>
              <${MenuItem} value="runtime-first">Runtime-first<//>
              <${MenuItem} value="actions-first">Actions-first<//>
            <//>
            <div class="meta-text" style="margin-top:4px">Use as Bosun’s recommended posture, not a forced mode switch.</div>
          </div>

          <div>
            <div class="setting-row-label">GitHub Actions Budget</div>
            <${Select} size="small" value=${policy.githubActionsBudget} onChange=${(e) => updatePolicy({ githubActionsBudget: e.target.value })} fullWidth>
              <${MenuItem} value="ask-user">Ask user during setup<//>
              <${MenuItem} value="available">Runtime budget available<//>
              <${MenuItem} value="limited">Runtime budget limited<//>
            <//>
          </div>
        </div>

        <div>
          <div class="setting-row-label">Merge Check Mode</div>
          <${Select} size="small" value=${policy.mode} onChange=${(e) => updatePolicy({ mode: e.target.value })} fullWidth>
            <${MenuItem} value="all">All non-ignored checks block by default<//>
            <${MenuItem} value="required-only">Only required patterns block merge<//>
          <//>
        </div>

        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">
          <div>
            <div class="setting-row-label">Required Check Patterns</div>
            <${TextField} multiline minRows=${3} size="small" value=${policy.requiredPatternsText} onInput=${(e) => updatePolicy({ requiredPatternsText: e.target.value })} placeholder="ci / test\ncodeql" fullWidth />
          </div>
          <div>
            <div class="setting-row-label">Optional Check Patterns</div>
            <${TextField} multiline minRows=${3} size="small" value=${policy.optionalPatternsText} onInput=${(e) => updatePolicy({ optionalPatternsText: e.target.value })} placeholder="preview\nbenchmark" fullWidth />
          </div>
          <div>
            <div class="setting-row-label">Ignored Check Patterns</div>
            <${TextField} multiline minRows=${3} size="small" value=${policy.ignorePatternsText} onInput=${(e) => updatePolicy({ ignorePatternsText: e.target.value })} placeholder="stale\nauto-merge housekeeping" fullWidth />
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr;gap:8px">
          <${FormControlLabel} control=${html`<${Switch} checked=${policy.requireAnyRequiredCheck} onChange=${(e) => updatePolicy({ requireAnyRequiredCheck: e.target.checked })} />`} label="Block when no required check is present" />
          <${FormControlLabel} control=${html`<${Switch} checked=${policy.treatPendingRequiredAsBlocking} onChange=${(e) => updatePolicy({ treatPendingRequiredAsBlocking: e.target.checked })} />`} label="Treat pending required checks as blocking" />
          <${FormControlLabel} control=${html`<${Switch} checked=${policy.treatNeutralAsPass} onChange=${(e) => updatePolicy({ treatNeutralAsPass: e.target.checked })} />`} label="Count neutral or skipped required checks as pass" />
        </div>

        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">
          <div>
            <div class="setting-row-label">Sandbox Mode</div>
            <${Select} size="small" value=${policy.sandboxMode} onChange=${(e) => updatePolicy({ sandboxMode: e.target.value })} fullWidth>
              <${MenuItem} value="workspace-write">Workspace write<//>
              <${MenuItem} value="read-only">Read only<//>
              <${MenuItem} value="danger-full-access">Danger full access<//>
            <//>
          </div>
          <div>
            <div class="setting-row-label">Container Runtime</div>
            <${Select} size="small" value=${policy.containerRuntime} onChange=${(e) => updatePolicy({ containerRuntime: e.target.value })} fullWidth>
              <${MenuItem} value="auto">Auto<//>
              <${MenuItem} value="docker">Docker<//>
              <${MenuItem} value="podman">Podman<//>
              <${MenuItem} value="container">Container helper<//>
            <//>
          </div>
          <div>
            <div class="setting-row-label">Network Access</div>
            <${TextField} size="small" value=${policy.networkAccess} onInput=${(e) => updatePolicy({ networkAccess: e.target.value })} placeholder="default" fullWidth />
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr;gap:8px">
          <${FormControlLabel} control=${html`<${Switch} checked=${policy.containerIsolationEnabled} onChange=${(e) => updatePolicy({ containerIsolationEnabled: e.target.checked })} />`} label="Expect container isolation for agent execution" />
          <${FormControlLabel} control=${html`<${Switch} checked=${policy.enforceBacklog} onChange=${(e) => updatePolicy({ enforceBacklog: e.target.checked })} />`} label="Enforce backlog safeguards before direct execution" />
          <${FormControlLabel} control=${html`<${Switch} checked=${policy.agentTriggerControl} onChange=${(e) => updatePolicy({ agentTriggerControl: e.target.checked })} />`} label="Keep agent trigger control safeguards enabled" />
        </div>
      </div>
    <//>
  `;
}

function normalizePrAutomationEditorState(policy = {}) {
  const attachModeRaw = String(policy?.attachMode || "all").trim().toLowerCase();
  const attachMode = ["all", "trusted-only", "disabled"].includes(attachModeRaw)
    ? attachModeRaw
    : "all";
  const trustedAuthors = normalizeTrustedAuthorEntries(policy?.trustedAuthors);
  return {
    attachMode,
    trustedAuthors,
    trustedAuthorsText: trustedAuthors.join("\n"),
    allowTrustedFixes: policy?.allowTrustedFixes === true,
    allowTrustedMerges: policy?.allowTrustedMerges === true,
    assistiveActionsInstallOnSetup: policy?.assistiveActions?.installOnSetup === true,
  };
}

function serializePrAutomationEditorState(policy = {}) {
  const normalized = normalizePrAutomationEditorState(policy);
  return JSON.stringify({
    attachMode: normalized.attachMode,
    trustedAuthors: normalized.trustedAuthors,
    allowTrustedFixes: normalized.allowTrustedFixes,
    allowTrustedMerges: normalized.allowTrustedMerges,
    assistiveActions: {
      installOnSetup: normalized.assistiveActionsInstallOnSetup,
    },
  });
}

function PrAutomationTrustEditor() {
  const [policy, setPolicy] = useState(() => normalizePrAutomationEditorState());
  const [savedPolicy, setSavedPolicy] = useState(() => normalizePrAutomationEditorState());
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [loadError, setLoadError] = useState(null);

  const syncDirty = useCallback((nextPolicy, baseline = savedPolicy) => {
    setDirty(
      serializePrAutomationEditorState(nextPolicy)
        !== serializePrAutomationEditorState(baseline),
    );
  }, [savedPolicy]);

  const updatePolicy = useCallback((patch) => {
    setPolicy((prev) => {
      const next = { ...prev, ...patch };
      syncDirty(next);
      return next;
    });
  }, [syncDirty]);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch("/api/pr-automation");
        if (!(res?.ok || res?.prAutomation)) {
          throw new Error(res?.error || "Failed to load PR automation settings");
        }
        const normalized = normalizePrAutomationEditorState(res?.prAutomation || {});
        setPolicy(normalized);
        setSavedPolicy(normalized);
        setDirty(false);
      } catch (err) {
        setLoadError(err.message || "Failed to load PR automation settings");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    const key = "settings-pr-automation";
    setPendingChange(key, dirty);
    return () => clearPendingChange(key);
  }, [dirty]);

  const savePolicy = useCallback(async () => {
    try {
      const payload = normalizePrAutomationEditorState(policy);
      const res = await apiFetch("/api/pr-automation", {
        method: "POST",
        body: JSON.stringify({
          prAutomation: {
            attachMode: payload.attachMode,
            trustedAuthors: payload.trustedAuthors,
            allowTrustedFixes: payload.allowTrustedFixes,
            allowTrustedMerges: payload.allowTrustedMerges,
            assistiveActions: {
              installOnSetup: payload.assistiveActionsInstallOnSetup,
            },
          },
        }),
      });
      if (!res?.ok) throw new Error(res?.error || "Save failed");
      const normalized = normalizePrAutomationEditorState(res?.prAutomation || payload);
      setPolicy(normalized);
      setSavedPolicy(normalized);
      setDirty(false);
      setLoadError(null);
    } catch (err) {
      throw new Error(err?.message || "PR automation save failed");
    }
  }, [policy]);

  const discardPolicy = useCallback(async () => {
    setPolicy(savedPolicy);
    setDirty(false);
    setLoadError(null);
  }, [savedPolicy]);

  useEffect(() => {
    return registerSettingsExternalEditor("settings-pr-automation", {
      isDirty: () => dirty,
      save: savePolicy,
      discard: discardPolicy,
    });
  }, [dirty, savePolicy, discardPolicy]);

  if (loading) return html`<${SkeletonCard} height="80px" />`;

  return html`
    <${Card} title="PR Automation Trust Policy"
      badge=${dirty ? html`<${Badge} variant="warning">Unsaved<//>` : null}>
      <div class="meta-text" style="margin-bottom:10px">
        Bosun-created PRs are always eligible for high-risk automation. Use this policy to decide how broadly Bosun attaches to PRs and whether explicitly trusted human authors may receive CI repair or merge automation.
      </div>
      ${loadError && html`<div class="settings-banner settings-banner-warn" style="margin-bottom:10px">${loadError}</div>`}

      <div style="display:grid;grid-template-columns:1fr;gap:12px">
        <div>
          <div class="setting-row-label">Attachment Mode</div>
          <${Select}
            size="small"
            value=${policy.attachMode}
            onChange=${(e) => updatePolicy({ attachMode: e.target.value })}
            fullWidth
          >
            <${MenuItem} value="all">Attach to all matching PRs<//>
            <${MenuItem} value="trusted-only">Attach only trusted-author PRs<//>
            <${MenuItem} value="disabled">Disable automatic attachment<//>
          <//>
          <div class="meta-text" style="margin-top:4px">
            Attachment is low-trust observation only. Bosun-created PRs keep their provenance marker regardless of this setting.
          </div>
        </div>

        <div>
          <div class="setting-row-label">Trusted GitHub Authors</div>
          <${TextField}
            multiline
            minRows=${3}
            size="small"
            value=${policy.trustedAuthorsText}
            placeholder="octocat\nmaintainer-login"
            onInput=${(e) => updatePolicy({ trustedAuthorsText: e.target.value })}
            fullWidth
          />
          <div class="meta-text" style="margin-top:4px">
            One GitHub login per line. Bosun-created PRs do not need to appear here.
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr;gap:8px">
          <${FormControlLabel}
            control=${html`<${Switch}
              checked=${policy.allowTrustedFixes}
              onChange=${(e) => updatePolicy({ allowTrustedFixes: e.target.checked })}
            />`}
            label="Allow CI repair automation for trusted-author PRs"
          />
          <div class="meta-text" style="margin-left:14px">
            Enables GitHub CI signaling and watchdog repair flows for attached PRs from trusted authors.
          </div>

          <${FormControlLabel}
            control=${html`<${Switch}
              checked=${policy.allowTrustedMerges}
              onChange=${(e) => updatePolicy({ allowTrustedMerges: e.target.checked })}
            />`}
            label="Allow merge automation for trusted-author PRs"
          />
          <div class="meta-text" style="margin-left:14px">
            Merge automation still requires normal review and CI gates. Leave off unless you want human-authored PRs in Bosun’s merge lane.
          </div>

          <${FormControlLabel}
            control=${html`<${Switch}
              checked=${policy.assistiveActionsInstallOnSetup}
              onChange=${(e) => updatePolicy({ assistiveActionsInstallOnSetup: e.target.checked })}
            />`}
            label="Install optional repo-local GitHub Actions during setup"
          />
          <div class="meta-text" style="margin-left:14px">
            These attach/comment workflows are assistive only. Bosun’s runtime templates continue to work without them.
          </div>
        </div>
      </div>
    <//>
  `;
}

/* ═══════════════════════════════════════════════════════════════
 *  VoiceEndpointsEditor — card-based multi-endpoint voice config
 *  Mirrors the setup.html voice endpoints UI exactly.
 * ═══════════════════════════════════════════════════════════════ */
function VoiceEndpointsEditor() {
  const [endpoints, setEndpoints] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [testResults, setTestResults] = useState({});
  const [oauthStatus, setOauthStatus] = useState({ openai: {}, claude: {}, gemini: {} });
  const [customModelMode, setCustomModelMode] = useState({});
  const [savedEndpoints, setSavedEndpoints] = useState([]);

  const getDefaultEndpointUrl = useCallback((provider, authSource = "apiKey") => {
    const p = String(provider || "").toLowerCase();
    if (p === "openai") return "https://api.openai.com";
    if (p === "claude") return "https://api.anthropic.com";
    if (p === "gemini") return "https://generativelanguage.googleapis.com";
    return "";
  }, []);

  const isEndpointEditable = useCallback((provider) => {
    const p = String(provider || "").toLowerCase();
    return p === "azure" || p === "custom";
  }, []);

  const endpointModelOptions = useMemo(() => {
    return [
      "gpt-audio-1.5",
      "gpt-realtime-1.5",
      "gpt-4o-realtime-preview-2024-12-17",
      "claude-sonnet-4.6",
      "claude-haiku-4.5",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-3.0-flash",
      "gemini-3.1-pro",
    ];
  }, []);

  const normalizeEp = useCallback((ep = {}, idx = 0) => {
    const provider = ["azure", "openai", "claude", "gemini", "custom"].includes(ep.provider)
      ? ep.provider
      : "azure";
    const transcriptionEnabled = ep.transcriptionEnabled == null
      ? provider !== "azure"
      : ep.transcriptionEnabled !== false;
    return {
      _id: ep._id ?? `ep-${idx}-${Date.now()}`,
      name: String(ep.name || `endpoint-${idx + 1}`),
      provider,
    endpoint: (() => {
      const raw = String(ep.endpoint || "");
      return (provider === "azure" || provider === "custom")
        ? raw
        : (raw || getDefaultEndpointUrl(provider, ep.authSource));
    })(),
    deployment: String(ep.deployment || ""),
    model: String(ep.model || ""),
    visionModel: String(ep.visionModel || ""),
    transcriptionModel: String(ep.transcriptionModel || ""),
    transcriptionEnabled,
    apiKey: String(ep.apiKey || ""),
    voiceId: String(ep.voiceId || ""),
    role: ["primary", "backup"].includes(ep.role) ? ep.role : "primary",
    weight: Number(ep.weight) > 0 ? Number(ep.weight) : 1,
    enabled: ep.enabled !== false,
    authSource: ["apiKey", "oauth"].includes(ep.authSource) ? ep.authSource : "apiKey",
    };
  }, [getDefaultEndpointUrl]);

  // Fetch OAuth status for all providers
  const fetchOAuthStatuses = useCallback(async () => {
    for (const provider of ["openai", "claude", "gemini"]) {
      try {
        const res = await apiFetch(`/api/voice/auth/${provider}/status`);
        if (res.ok) {
          const connected = !!res.hasToken || res.status === "connected" || res.status === "complete";
          setOauthStatus((prev) => ({
            ...prev,
            [provider]: {
              status: connected ? "connected" : (res.status || "idle"),
              hasToken: connected,
            },
          }));
        }
      } catch { /* best-effort */ }
    }
  }, []);

  // Test endpoint connection
  const testEndpointConnection = useCallback(async (ep) => {
    const key = ep._id;
    setTestResults((prev) => ({ ...prev, [key]: { testing: true } }));
    try {
      const res = await apiFetch("/api/voice/endpoints/test", {
        method: "POST",
        body: JSON.stringify({ provider: ep.provider, apiKey: ep.apiKey, endpoint: ep.endpoint, deployment: ep.deployment, model: ep.model, authSource: ep.authSource }),
      });
      if (res.ok) {
        setTestResults((prev) => ({ ...prev, [key]: { testing: false, result: "success", latencyMs: res.latencyMs } }));
        haptic("success");
      } else {
        setTestResults((prev) => ({ ...prev, [key]: { testing: false, result: "error", error: res.error || "Connection failed" } }));
        haptic("heavy");
      }
    } catch (err) {
      setTestResults((prev) => ({ ...prev, [key]: { testing: false, result: "error", error: err.message || "Network error" } }));
      haptic("heavy");
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch("/api/voice/endpoints");
        const eps = Array.isArray(res?.voiceEndpoints) ? res.voiceEndpoints : [];
        const normalized = eps.map((ep, i) => normalizeEp(ep, i));
        setEndpoints(normalized);
        setSavedEndpoints(normalized);
        setDirty(false);
      } catch (err) {
        setLoadError(err.message || "Failed to load voice endpoints");
      } finally {
        setLoading(false);
      }
    })();
    fetchOAuthStatuses();
  }, [normalizeEp, fetchOAuthStatuses]);

  useEffect(() => {
    const key = "settings-voice-endpoints";
    setPendingChange(key, dirty);
    return () => clearPendingChange(key);
  }, [dirty]);

  const addEndpoint = useCallback(() => {
    setEndpoints((prev) => {
      const next = [
        ...prev,
        normalizeEp(
          { provider: "azure", role: prev.length === 0 ? "primary" : "backup" },
          prev.length,
        ),
      ];
      setDirty(true);
      return next;
    });
  }, [normalizeEp]);

  const removeEndpoint = useCallback((id) => {
    setEndpoints((prev) => {
      setDirty(true);
      return prev.filter((ep) => ep._id !== id);
    });
  }, []);

  const updateEndpoint = useCallback((id, field, value) => {
    setEndpoints((prev) => {
      setDirty(true);
      return prev.map((ep) =>
        ep._id === id
          ? (() => {
              const next = { ...ep, [field]: field === "weight" ? (Number(value) || 1) : value };
              if (field === "provider") {
                if (!isEndpointEditable(next.provider)) {
                  next.endpoint = getDefaultEndpointUrl(next.provider, next.authSource);
                }
                if (next.provider !== "azure") next.deployment = "";
                if (next.provider === "custom" && !next.model) {
                  next.model = endpointModelOptions[0] || "gpt-audio-1.5";
                }
              }
              if (field === "authSource" && !isEndpointEditable(next.provider)) {
                next.endpoint = getDefaultEndpointUrl(next.provider, next.authSource);
              }
              return next;
            })()
          : ep,
      );
    });
  }, [endpointModelOptions, getDefaultEndpointUrl, isEndpointEditable]);

  const handleSave = useCallback(async () => {
    try {
      const payload = endpoints.map(({ _id, ...ep }) => ep);
      await apiFetch("/api/voice/endpoints", {
        method: "POST",
        body: JSON.stringify({ voiceEndpoints: payload }),
      });
      setSavedEndpoints(endpoints.map((ep) => ({ ...ep })));
      setDirty(false);
    } catch (err) {
      throw new Error(err?.message || "Voice endpoints save failed");
    }
  }, [endpoints]);

  const handleDiscard = useCallback(async () => {
    setEndpoints(savedEndpoints.map((ep) => ({ ...ep })));
    setCustomModelMode({});
    setDirty(false);
  }, [savedEndpoints]);

  useEffect(() => {
    return registerSettingsExternalEditor("settings-voice-endpoints", {
      isDirty: () => dirty,
      save: handleSave,
      discard: handleDiscard,
    });
  }, [dirty, handleDiscard, handleSave]);

  if (loading) return html`<${SkeletonCard} height="80px" />`;

  return html`
    <${Card}>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div>
          <strong>Voice Endpoints</strong>
          <div class="meta-text" style="margin-top:2px">
            Named endpoints with per-credential failover. Primary is tried first; backups on failure.
          </div>
        </div>
      </div>
      ${loadError && html`
        <div class="settings-banner settings-banner-warn" style="margin-bottom:10px">${loadError}</div>
      `}
      ${endpoints.map((ep) => html`
        <div key=${ep._id} style="border:1px solid var(--border-color,rgba(255,255,255,0.1));border-radius:8px;padding:12px;margin-bottom:10px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
            <${TextField}
              size="small"
              variant="outlined"
              value=${ep.name}
              placeholder="Endpoint name"
              style="font-weight:600;width:100%;font-size:14px"
              onInput=${(e) => updateEndpoint(ep._id, "name", e.target.value)}
              fullWidth
            />
            <${Button}
              variant="outlined"
              size="small"
              style="margin-left:8px;white-space:nowrap;opacity:0.7;flex-shrink:0"
              onClick=${() => removeEndpoint(ep._id)}
            >Remove<//>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <div>
              <div class="setting-row-label">Provider</div>
              <${Select} size="small" value=${ep.provider} onChange=${(e) => updateEndpoint(ep._id, "provider", e.target.value)} fullWidth>
                <${MenuItem} value="azure">Azure OpenAI<//>
                <${MenuItem} value="openai">OpenAI<//>
                <${MenuItem} value="claude">Claude (Anthropic)<//>
                <${MenuItem} value="gemini">Google Gemini<//>
                <${MenuItem} value="custom">Custom Endpoint<//>
              <//>
            </div>
            <div>
              <div class="setting-row-label">Role</div>
              <${Select} size="small" value=${ep.role} onChange=${(e) => updateEndpoint(ep._id, "role", e.target.value)} fullWidth>
                <${MenuItem} value="primary">Primary<//>
                <${MenuItem} value="backup">Backup<//>
              <//>
            </div>
            <div>
              <div class="setting-row-label">Weight</div>
              <${TextField} type="number" size="small" value=${ep.weight} inputProps=${{ min: 1, max: 10 }} style="width:70px"
                onInput=${(e) => updateEndpoint(ep._id, "weight", e.target.value)} />
            </div>
            <div style="display:flex;align-items:center;padding-top:16px">
              <${Toggle} checked=${ep.enabled} onChange=${(v) => updateEndpoint(ep._id, "enabled", v)} label="Enabled" />
            </div>
            ${["openai","claude","gemini"].includes(ep.provider) && html`
              <div style="grid-column:1/-1">
                <div class="setting-row-label">Auth Method</div>
                <${Select} size="small" value=${ep.authSource || "apiKey"} onChange=${(e) => updateEndpoint(ep._id, "authSource", e.target.value)} fullWidth>
                  <${MenuItem} value="apiKey">API Key<//>
                  <${MenuItem} value="oauth">OAuth (Connected Account)<//>
                <//>
                ${ep.authSource === "oauth" && (oauthStatus[ep.provider]?.status === "connected" || oauthStatus[ep.provider]?.status === "complete" || oauthStatus[ep.provider]?.hasToken) && html`
                  <div class="meta-text" style="margin-top:3px;color:var(--color-success,#22c55e)">✓ Connected — will use your ${ep.provider === "openai" ? "OpenAI" : ep.provider === "claude" ? "Claude" : "Gemini"} account.</div>
                `}
                ${ep.authSource === "oauth" && !(oauthStatus[ep.provider]?.status === "connected" || oauthStatus[ep.provider]?.status === "complete" || oauthStatus[ep.provider]?.hasToken) && html`
                  <div class="meta-text" style="margin-top:3px;color:var(--color-warning,#f59e0b)">⚠ Not connected. Sign in via the shared OAuth account cards above to use OAuth.</div>
                `}
                ${ep.provider === "claude" && ep.authSource === "oauth" && html`
                  <div class="meta-text" style="margin-top:3px;color:var(--color-warning,#f59e0b)">Claude OAuth with Bosun may violate Anthropic terms. Switch this endpoint to API key mode if you need the warning gone.</div>
                `}
              </div>
            `}
            <div style=${`grid-column:1/-1${ep.authSource === "oauth" && ["openai","claude","gemini"].includes(ep.provider) ? ";display:none" : ""}`}>
              <div class="setting-row-label">${ep.provider === "azure" ? "API Key" : "API Key (manual)"}</div>
              <${TextField} type="password" size="small" value=${ep.apiKey}
                placeholder="API key for this endpoint"
                onInput=${(e) => updateEndpoint(ep._id, "apiKey", e.target.value)} fullWidth />
            </div>
            ${ep.provider === "azure" && html`
              <div style="grid-column:1/-1">
                <div class="setting-row-label">Azure Endpoint URL</div>
                <${TextField} size="small" variant="outlined" value=${ep.endpoint} placeholder="https://your-resource.openai.azure.com"
                  onInput=${(e) => updateEndpoint(ep._id, "endpoint", e.target.value)} fullWidth />
              </div>
              <div style="grid-column:1/-1">
                <div class="setting-row-label">Deployment Name</div>
                <${TextField} size="small" variant="outlined" value=${ep.deployment} placeholder="my-gpt-4o-realtime"
                  onInput=${(e) => updateEndpoint(ep._id, "deployment", e.target.value)} fullWidth />
                <div class="meta-text" style="margin-top:3px">
                  The deployment name from Azure AI Foundry (not the model name).
                  Find it under your resource → Deployments. Leave empty to test credentials only.
                </div>
              </div>
              <div style="grid-column:1/-1">
                <div class="setting-row-label">Audio Model (Realtime)</div>
                <${TextField} size="small" variant="outlined" value=${ep.model} placeholder="gpt-4o-realtime-preview"
                  onInput=${(e) => updateEndpoint(ep._id, "model", e.target.value)} fullWidth />
                <div class="meta-text" style="margin-top:3px">
                  The underlying model name (e.g. gpt-4o-realtime-preview). Used at runtime.
                </div>
              </div>
            `}
            ${ep.provider === "custom" && html`
              <div style="grid-column:1/-1">
                <div class="setting-row-label">Endpoint URL</div>
                <${TextField} size="small" variant="outlined" value=${ep.endpoint} placeholder="https://your-custom-endpoint.example.com"
                  onInput=${(e) => updateEndpoint(ep._id, "endpoint", e.target.value)} fullWidth />
              </div>
              <div style="grid-column:1/-1">
                <div class="setting-row-label">Model</div>
                ${(() => {
                  const known = endpointModelOptions;
                  const isCustom = Boolean(customModelMode[ep._id]) || (ep.model && !known.includes(ep.model));
                  return html`
                    <${Select}
                      size="small"
                      value=${isCustom ? "__custom__" : (ep.model || (known[0] || ""))}
                      onChange=${(e) => {
                        const next = String(e.target.value || "");
                        if (next === "__custom__") {
                          setCustomModelMode((prev) => ({ ...prev, [ep._id]: true }));
                          updateEndpoint(ep._id, "model", known.includes(ep.model) ? "" : ep.model);
                          return;
                        }
                        setCustomModelMode((prev) => ({ ...prev, [ep._id]: false }));
                        updateEndpoint(ep._id, "model", next);
                      }}
                      fullWidth
                    >
                      ${known.map((m) => html`<${MenuItem} value=${m}>${m}<//>`)}
                      <${MenuItem} value="__custom__">custom...<//>
                    <//>
                    ${isCustom && html`
                      <${TextField}
                        size="small"
                        variant="outlined"
                        value=${ep.model || ""}
                        placeholder="Enter custom model slug..."
                        onInput=${(e) => updateEndpoint(ep._id, "model", e.target.value)}
                        style="margin-top:6px"
                        fullWidth
                      />
                    `}
                  `;
                })()}
              </div>
            `}
            ${!isEndpointEditable(ep.provider) && html`
              <div style="grid-column:1/-1">
                <div class="setting-row-label">Endpoint URL</div>
                <${TextField}
                  size="small"
                  variant="outlined"
                  value=${getDefaultEndpointUrl(ep.provider, ep.authSource)}
                  InputProps=${{ readOnly: true }}
                  disabled
                  fullWidth
                />
                <div class="meta-text" style="margin-top:3px">
                  Auto-derived from provider and auth method. Use Azure or Custom to override.
                </div>
              </div>
            `}
            ${ep.provider === "openai" && html`
              <div style="grid-column:1/-1">
                <div class="setting-row-label">Audio Model (Realtime)</div>
                <${TextField} size="small" variant="outlined" value=${ep.model} placeholder="gpt-4o-realtime-preview"
                  onInput=${(e) => updateEndpoint(ep._id, "model", e.target.value)} fullWidth />
              </div>
            `}
            ${ep.provider === "claude" && html`
              <div style="grid-column:1/-1">
                <div class="setting-row-label">Model</div>
                <${TextField} size="small" variant="outlined" value=${ep.model} placeholder="claude-sonnet-4.6"
                  onInput=${(e) => updateEndpoint(ep._id, "model", e.target.value)} fullWidth />
              </div>
            `}
            ${ep.provider === "gemini" && html`
              <div style="grid-column:1/-1">
                <div class="setting-row-label">Model</div>
                <${TextField} size="small" variant="outlined" value=${ep.model} placeholder="gemini-2.0-flash"
                  onInput=${(e) => updateEndpoint(ep._id, "model", e.target.value)} fullWidth />
              </div>
            `}
            <div style="grid-column:1/-1">
              <div class="setting-row-label">Vision Model</div>
              <${TextField} size="small" variant="outlined" value=${ep.visionModel}
                placeholder=${ep.provider === "azure" ? "gpt-4o" : ep.provider === "claude" ? "claude-sonnet-4.6" : ep.provider === "gemini" ? "gemini-3.0-flash" : "gpt-4o"}
                onInput=${(e) => updateEndpoint(ep._id, "visionModel", e.target.value)} fullWidth />
              <div class="meta-text" style="margin-top:3px">Model used for screenshot / image analysis tasks.</div>
            </div>
            ${(ep.provider === "openai" || ep.provider === "azure") && html`
            <div style="grid-column:1/-1;display:grid;grid-template-columns:1fr auto;gap:8px;align-items:end">
              <div>
                <div class="setting-row-label">Transcription Model</div>
                <${TextField} size="small" variant="outlined" value=${ep.transcriptionModel || ""}
                  placeholder="gpt-4o-transcribe"
                  onInput=${(e) => updateEndpoint(ep._id, "transcriptionModel", e.target.value)} fullWidth />
                <div class="meta-text" style="margin-top:3px">
                  Model used for input audio transcription. Leave blank for default (gpt-4o-transcribe).
                  ${ep.provider === "azure" ? " Azure endpoints default transcription OFF unless enabled." : ""}
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:6px;padding-bottom:22px">
                <label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:13px">
                  <${Switch} size="small" checked=${ep.transcriptionEnabled !== false}
                    onChange=${(e) => updateEndpoint(ep._id, "transcriptionEnabled", e.target.checked)} />
                  Enable
                </label>
              </div>
            </div>
            `}
          </div>
          <!-- Test Connection -->
          <div style="display:flex;align-items:center;gap:10px;margin-top:8px">
            <${Button} variant="outlined" size="small"
              disabled=${!!(testResults[ep._id]?.testing)}
              onClick=${() => testEndpointConnection(ep)}
              style="min-width:130px">
              ${testResults[ep._id]?.testing ? html`<${Spinner} size=${12} /> Testing…` : "Test Connection"}
            <//>
            ${testResults[ep._id]?.result === "success" && html`
              <span style="color:var(--color-success,#22c55e);font-size:12px;font-weight:600">
                ✓ Connected${testResults[ep._id].latencyMs != null ? ` (${testResults[ep._id].latencyMs}ms)` : ""}
              </span>
            `}
            ${testResults[ep._id]?.result === "error" && html`
              <span style="color:var(--color-error,#ef4444);font-size:12px;font-weight:600">
                ✗ ${testResults[ep._id].error}
              </span>
            `}
          </div>
        </div>
      `)}
      <${Button} variant="outlined" size="small" onClick=${addEndpoint} style="margin-top:2px">+ Add Endpoint<//>
      ${endpoints.length === 0 && !loadError && html`
        <div class="meta-text" style="margin-top:8px">
          No endpoints configured. Add one above to enable voice provider routing.
        </div>
      `}
    <//>
  `;
}

/* ═══════════════════════════════════════════════════════════════
 *  VoiceProvidersEditor — provider routing (priority order) with
 *  endpoint linking, model/vision dropdowns, voice persona.
 *  Mirrors setup.html's provider card UI.
 * ═══════════════════════════════════════════════════════════════ */
const VOICE_PROVIDER_MODEL_DEFAULTS = {
  openai: { model: "gpt-audio-1.5", visionModel: "gpt-4.1-nano", models: ["gpt-audio-1.5", "gpt-realtime-1.5", "gpt-4o-realtime-preview-2024-12-17"], visionModels: ["gpt-4.1-nano", "gpt-4.1-mini", "gpt-4.1"] },
  azure: { model: "gpt-audio-1.5", visionModel: "gpt-4.1-nano", models: ["gpt-audio-1.5", "gpt-realtime-1.5", "gpt-4o-realtime-preview"], visionModels: ["gpt-4.1-nano", "gpt-4.1-mini", "gpt-4.1"] },
  claude: { model: "claude-sonnet-4.6", visionModel: "claude-sonnet-4.6", models: ["claude-sonnet-4.6", "claude-haiku-4.5"], visionModels: ["claude-sonnet-4.6", "claude-haiku-4.5"] },
  gemini: { model: "gemini-3.1-pro", visionModel: "gemini-3.0-flash", models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash", "gemini-3.0-flash", "gemini-3.1-pro"], visionModels: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash", "gemini-3.0-flash", "gemini-3.1-pro"] },
  fallback: { model: "", visionModel: "", models: [], visionModels: [] },
};
const _getProviderDefaults = (provider) =>
  VOICE_PROVIDER_MODEL_DEFAULTS[String(provider || "fallback").toLowerCase()] || VOICE_PROVIDER_MODEL_DEFAULTS.fallback;

function VoiceProvidersEditor() {
  const [providers, setProviders] = useState([]);
  const [endpoints, setEndpoints] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [savedProviders, setSavedProviders] = useState([]);

  const normalizeProvider = useCallback((entry = {}) => {
    const allowedProviders = ["openai", "azure", "claude", "gemini", "fallback"];
    const provider = String(entry.provider || "fallback").trim().toLowerCase();
    const normalizedProvider = allowedProviders.includes(provider) ? provider : "fallback";
    const defaults_ = _getProviderDefaults(normalizedProvider);
    return {
      _id: entry._id || `prov_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      id: entry.id || Date.now() + Math.random(),
      provider: normalizedProvider,
      model: String(entry.model ?? defaults_.model ?? "").trim(),
      visionModel: String(entry.visionModel ?? defaults_.visionModel ?? "").trim(),
      voiceId: String(entry.voiceId ?? "alloy").trim() || "alloy",
      azureDeployment: String(entry.azureDeployment ?? (normalizedProvider === "azure" ? "gpt-audio-1.5" : "")).trim(),
      endpointId: String(entry.endpointId ?? "").trim(),
    };
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [provRes, epRes] = await Promise.all([
          apiFetch("/api/voice/providers"),
          apiFetch("/api/voice/endpoints"),
        ]);
        const provs = Array.isArray(provRes?.providers) ? provRes.providers : [];
        const normalizedProviders = provs.map((p) => normalizeProvider(p));
        setProviders(normalizedProviders);
        setSavedProviders(normalizedProviders);
        setDirty(false);
        const eps = Array.isArray(epRes?.voiceEndpoints) ? epRes.voiceEndpoints : [];
        setEndpoints(eps);
      } catch (err) {
        setLoadError(err.message || "Failed to load voice providers");
      } finally {
        setLoading(false);
      }
    })();
  }, [normalizeProvider]);

  useEffect(() => {
    const key = "settings-voice-providers";
    setPendingChange(key, dirty);
    return () => clearPendingChange(key);
  }, [dirty]);

  const addProvider = useCallback(() => {
    if (providers.length >= 5) return;
    setProviders((prev) => [...prev, normalizeProvider({})]);
    setDirty(true);
    haptic("light");
  }, [providers.length, normalizeProvider]);

  const removeProvider = useCallback((_id) => {
    setProviders((prev) => prev.filter((p) => p._id !== _id));
    setDirty(true);
    haptic("light");
  }, []);

  const updateProvider = useCallback((_id, field, value) => {
    setProviders((prev) => prev.map((p) => {
      if (p._id !== _id) return p;
      const updated = { ...p, [field]: value };
      // When provider type changes, reset model/vision to defaults
      if (field === "provider") {
        const defaults_ = _getProviderDefaults(value);
        updated.model = defaults_.model;
        updated.visionModel = defaults_.visionModel;
        updated.endpointId = ""; // clear linked endpoint
        if (value === "azure") updated.azureDeployment = "gpt-audio-1.5";
        else updated.azureDeployment = "";
      }
      return updated;
    }));
    setDirty(true);
  }, []);

  const saveProviders = useCallback(async () => {
    try {
      const payload = providers.map(({ _id, ...rest }) => rest);
      const res = await apiFetch("/api/voice/providers", {
        method: "POST",
        body: JSON.stringify({ providers: payload }),
      });
      if (!res.ok) throw new Error(res.error || "Save failed");
      setSavedProviders(providers.map((provider) => ({ ...provider })));
      setDirty(false);
    } catch (err) {
      throw new Error(err?.message || "Voice providers save failed");
    }
  }, [providers]);

  const discardProviders = useCallback(async () => {
    setProviders(savedProviders.map((provider) => ({ ...provider })));
    setDirty(false);
    setLoadError(null);
  }, [savedProviders]);

  useEffect(() => {
    return registerSettingsExternalEditor("settings-voice-providers", {
      isDirty: () => dirty,
      save: saveProviders,
      discard: discardProviders,
    });
  }, [dirty, saveProviders, discardProviders]);

  if (loading) return html`<${Card} title="Voice Providers"><${Spinner} /> Loading…<//>`;
  if (loadError && providers.length === 0) return html`<${Card} title="Voice Providers"><div class="meta-text" style="color:var(--color-error)">${loadError}</div><//>`;

  return html`
    <${Card} title="Voice Providers (Priority Order)"
      badge=${dirty ? html`<${Badge} variant="warning">Unsaved<//>` : null}>
      <div class="meta-text" style="margin-bottom:10px">
        Configure up to 5 providers in priority order. Bosun tries them in sequence during voice sessions.
      </div>
      ${loadError && html`<div class="meta-text" style="color:var(--color-error);margin-bottom:8px">${loadError}</div>`}
      ${providers.map((prov, idx) => {
        const defaults_ = _getProviderDefaults(prov.provider);
        const knownModels = defaults_.models || [];
        const knownVisionModels = defaults_.visionModels || [];
        const isCustomModel = knownModels.length > 0 && !knownModels.includes(prov.model);
        const isCustomVision = knownVisionModels.length > 0 && !knownVisionModels.includes(prov.visionModel);
        const matchingEps = endpoints.filter((ep) => ep.provider === prov.provider && ep.enabled !== false);
        return html`
        <div style="border:1px solid var(--border-primary);border-radius:var(--radius-sm);padding:12px;margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <strong>Provider ${idx + 1}</strong>
            <${Button} variant="outlined" size="small" style="color:var(--color-error);font-size:11px"
              onClick=${() => removeProvider(prov._id)}
              disabled=${providers.length <= 1}>Remove<//>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <div>
              <div class="setting-row-label">Provider Type</div>
              <${Select} size="small" value=${prov.provider}
                onChange=${(e) => updateProvider(prov._id, "provider", e.target.value)} fullWidth>
                <${MenuItem} value="openai">OpenAI Realtime<//>
                <${MenuItem} value="azure">Azure OpenAI Realtime<//>
                <${MenuItem} value="claude">Claude<//>
                <${MenuItem} value="gemini">Gemini<//>
                <${MenuItem} value="fallback">Browser Fallback<//>
              <//>
            </div>
            ${prov.provider !== "fallback" && html`
              <div>
                <div class="setting-row-label">Endpoint</div>
                ${matchingEps.length === 0 ? html`
                  <${Select} size="small" disabled fullWidth>
                    <${MenuItem} value="">— No ${prov.provider} endpoints —<//>
                  <//>
                  <div class="meta-text" style="color:var(--color-warning,#eab308);font-size:11px;margin-top:2px">
                    Configure a matching endpoint above first.
                  </div>
                ` : html`
                  <${Select} size="small" value=${prov.endpointId || ""}
                    onChange=${(e) => updateProvider(prov._id, "endpointId", e.target.value)} fullWidth>
                    <${MenuItem} value="">— Select endpoint —<//>
                    ${matchingEps.map((ep) => html`<${MenuItem} value=${ep.id}>${ep.name || ep.id}<//>`)}
                  <//>
                `}
              </div>
            `}
            <div>
              <div class="setting-row-label">Model</div>
              <${Select} size="small" value=${isCustomModel ? "custom" : prov.model}
                onChange=${(e) => {
                  if (e.target.value === "custom") {
                    updateProvider(prov._id, "model", prov.model && !knownModels.includes(prov.model) ? prov.model : "");
                  } else {
                    updateProvider(prov._id, "model", e.target.value);
                  }
                }} fullWidth>
                ${knownModels.map((m) => html`<${MenuItem} value=${m}>${m}<//>`)}
                <${MenuItem} value="custom">custom…<//>
              <//>
              ${isCustomModel && html`
                <${TextField} size="small" variant="outlined" value=${prov.model}
                  onInput=${(e) => updateProvider(prov._id, "model", e.target.value)}
                  placeholder="Custom model slug…"
                  style="margin-top:4px" fullWidth />
              `}
              ${knownModels.length === 0 && html`
                <${TextField} size="small" variant="outlined" value=${prov.model}
                  onInput=${(e) => updateProvider(prov._id, "model", e.target.value)}
                  placeholder="Provider model"
                  style="margin-top:4px" fullWidth />
              `}
            </div>
            <div>
              <div class="setting-row-label">Vision Model</div>
              <${Select} size="small" value=${isCustomVision ? "custom" : prov.visionModel}
                onChange=${(e) => {
                  if (e.target.value === "custom") {
                    updateProvider(prov._id, "visionModel", prov.visionModel && !knownVisionModels.includes(prov.visionModel) ? prov.visionModel : "");
                  } else {
                    updateProvider(prov._id, "visionModel", e.target.value);
                  }
                }} fullWidth>
                ${knownVisionModels.map((m) => html`<${MenuItem} value=${m}>${m}<//>`)}
                <${MenuItem} value="custom">custom…<//>
              <//>
              ${isCustomVision && html`
                <${TextField} size="small" variant="outlined" value=${prov.visionModel}
                  onInput=${(e) => updateProvider(prov._id, "visionModel", e.target.value)}
                  placeholder="Custom vision model slug…"
                  style="margin-top:4px" fullWidth />
              `}
              ${knownVisionModels.length === 0 && html`
                <${TextField} size="small" variant="outlined" value=${prov.visionModel}
                  onInput=${(e) => updateProvider(prov._id, "visionModel", e.target.value)}
                  placeholder="Provider vision model"
                  style="margin-top:4px" fullWidth />
              `}
            </div>
            <div>
              <div class="setting-row-label">Voice Persona</div>
              <${Select} size="small" value=${prov.voiceId}
                onChange=${(e) => updateProvider(prov._id, "voiceId", e.target.value)} fullWidth>
                ${["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"].map(
                  (v) => html`<${MenuItem} value=${v}>${v}<//>`
                )}
              <//>
            </div>
            ${prov.provider === "azure" && html`
              <div>
                <div class="setting-row-label">Azure Deployment</div>
                <${TextField} size="small" variant="outlined" value=${prov.azureDeployment || ""}
                  onInput=${(e) => updateProvider(prov._id, "azureDeployment", e.target.value)}
                  placeholder="gpt-audio-1.5" fullWidth />
              </div>
            `}
          </div>
        </div>
      `})}
      <${Button} variant="outlined" size="small" onClick=${addProvider} disabled=${providers.length >= 5}
        style="margin-top:2px">+ Add Provider<//>
      ${providers.length === 0 && html`
        <div class="meta-text" style="margin-top:8px">
          No providers configured. Add one above to set up voice routing.
        </div>
      `}
    <//>
  `;
}

/* ═══════════════════════════════════════════════════════════════
 *  _OAuthLoginCard — shared PKCE OAuth login card factory.
 *  Instantiated as OpenAICodexLoginCard, ClaudeLoginCard, GeminiLoginCard.
 * ═══════════════════════════════════════════════════════════════ */
function _OAuthLoginCard({ displayName, emoji, statusRoute, loginRoute, cancelRoute, logoutRoute, description, successMsg, signOutMsg }) {
  const [phase, setPhase] = useState("idle");
  const [authUrl, setAuthUrl] = useState("");
  const [error, setError] = useState("");
  const pollRef = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch(statusRoute);
        if (res.ok) setPhase(res.status === "connected" ? "connected" : "idle");
      } catch { /* non-fatal */ }
    })();
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, [statusRoute]);

  async function startLogin() {
    setPhase("pending"); setError("");
    try {
      const res = await apiFetch(loginRoute, { method: "POST" });
      if (!res.ok) throw new Error(res.error || "Failed to start login");
      setAuthUrl(res.authUrl || "");
      beginPolling();
    } catch (err) { setError(err.message); setPhase("error"); }
  }

  function beginPolling() {
    if (pollRef.current) clearTimeout(pollRef.current);
    async function tick() {
      try {
        const res = await apiFetch(statusRoute);
        if (!res.ok) { pollRef.current = setTimeout(tick, 2000); return; }
        if (res.status === "complete" || res.status === "connected") {
          pollRef.current = null; setPhase("complete");
          haptic("success"); showToast(successMsg, "success"); return;
        }
        if (res.status === "error") {
          pollRef.current = null;
          setError(res.result?.error || "Login failed"); setPhase("error"); return;
        }
        pollRef.current = setTimeout(tick, 2000);
      } catch { pollRef.current = setTimeout(tick, 3000); }
    }
    pollRef.current = setTimeout(tick, 2000);
  }

  async function handleLogout() {
    try {
      await apiFetch(logoutRoute, { method: "POST" });
      setPhase("idle"); setAuthUrl("");
      haptic("medium"); showToast(signOutMsg, "info");
    } catch (err) { showToast(`Logout failed: ${err.message}`, "error"); }
  }

  async function handleCancel() {
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
    try { await apiFetch(cancelRoute, { method: "POST" }); } catch { /* ignore */ }
    setPhase("idle"); setAuthUrl("");
  }

  if (phase === "connected" || phase === "complete") {
    return html`
      <${Card}>
        <div style="display:flex;align-items:center;gap:10px;padding:4px 0">
          <span style="font-size:22px">${emoji}</span>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;color:var(--text-primary)">${displayName} Connected</div>
            <div style="font-size:12px;color:var(--text-secondary);margin-top:2px">Signed in via OAuth. Shared by Bosun Harness and Voice.</div>
          </div>
          <${Button} variant="outlined" size="small" onClick=${handleLogout}>Sign out<//>
        </div>
      <//>
    `;
  }

  if (phase === "pending") {
    return html`
      <${Card}>
        <div style="text-align:center;padding:12px 0">
          <div style="font-size:12px;color:var(--text-secondary);margin-bottom:12px">
            A browser window should have opened. If not, open the link below:
          </div>
          ${authUrl && html`
            <${Button} variant="contained" size="small" onClick=${() => { try { window.open(authUrl, "_blank"); } catch {} }}
              style="font-size:12px;word-break:break-all;
                background:var(--surface-1);border:1px solid var(--border-color,rgba(255,255,255,0.1));
                border-radius:6px;padding:8px 12px;color:var(--accent);text-decoration:underline;
                max-width:100%;text-align:left"
            >${authUrl}<//>
          `}
          <div style="font-size:12px;color:var(--text-hint);margin-top:12px;display:flex;align-items:center;justify-content:center;gap:6px">
            <span class="spinner" style="width:14px;height:14px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%"></span>
            Waiting for you to sign in…
          </div>
          <${Button} variant="outlined" size="small" style="margin-top:12px;opacity:0.7" onClick=${handleCancel}>Cancel<//>
        </div>
      <//>
    `;
  }

  if (phase === "error") {
    return html`
      <${Card}>
        <div style="text-align:center;padding:10px 0">
          <div style="font-size:13px;color:var(--color-error,#f87171);margin-bottom:10px">${error}</div>
          <${Button} variant="contained" color="primary" size="small" onClick=${startLogin}>Try again<//>
        </div>
      <//>
    `;
  }

  // idle
  return html`
    <${Card}>
      <div style="text-align:center;padding:16px 0">
        <div style="font-size:32px;margin-bottom:8px">${emoji}</div>
        <div style="font-size:15px;font-weight:600;margin-bottom:4px;color:var(--text-primary)">Sign in with ${displayName}</div>
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:16px;max-width:300px;margin-inline:auto;line-height:1.6">${description}</div>
        <${Button} variant="contained" color="primary" onClick=${startLogin} style="min-width:220px">Sign in with ${displayName}<//>
      </div>
    <//>
  `;
}

/* ═══════════════════════════════════════════════════════════════
 *  OpenAICodexLoginCard — "Sign in with OpenAI" (ChatGPT/Codex accounts)
 *  Uses OAuth 2.0 PKCE flow via auth.openai.com — same flow as the
 *  official Codex CLI and the ChatGPT desktop app.
 *
 *  Allows ChatGPT Plus/Pro/Team subscribers to authenticate without
 *  needing to create an API key.
 * ═══════════════════════════════════════════════════════════════ */
function OpenAICodexLoginCard() {
  return html`<${_OAuthLoginCard}
    displayName="OpenAI"
    emoji="🤖"
    statusRoute="/api/voice/auth/openai/status"
    loginRoute="/api/voice/auth/openai/login"
    cancelRoute="/api/voice/auth/openai/cancel"
    logoutRoute="/api/voice/auth/openai/logout"
    description="Use your ChatGPT Plus, Pro, or Team subscription across Bosun Harness and Voice without managing API keys. Uses the same OAuth flow as the Codex CLI."
    successMsg="Signed in with OpenAI!"
    signOutMsg="Signed out from OpenAI"
  />`;
}

/* ═══════════════════════════════════════════════════════════════
 *  ClaudeLoginCard — OAuth PKCE for Anthropic Claude
 * ═══════════════════════════════════════════════════════════════ */
function ClaudeLoginCard() {
  return html`<${_OAuthLoginCard}
    displayName="Claude"
    emoji="🧠"
    statusRoute="/api/voice/auth/claude/status"
    loginRoute="/api/voice/auth/claude/login"
    cancelRoute="/api/voice/auth/claude/cancel"
    logoutRoute="/api/voice/auth/claude/logout"
    description="Sign in with your Claude.ai account for shared Bosun Harness and Voice access. Warning: using Claude OAuth with third-party tools may violate Anthropic terms; switch Claude integrations to API keys if you want the warning to disappear."
    successMsg="Signed in with Claude!"
    signOutMsg="Signed out from Claude"
  />`;
}

/* ═══════════════════════════════════════════════════════════════
 *  GeminiLoginCard — OAuth PKCE for Google Gemini
 * ═══════════════════════════════════════════════════════════════ */
function GeminiLoginCard() {
  return html`<${_OAuthLoginCard}
    displayName="Google Gemini"
    emoji="✨"
    statusRoute="/api/voice/auth/gemini/status"
    loginRoute="/api/voice/auth/gemini/login"
    cancelRoute="/api/voice/auth/gemini/cancel"
    logoutRoute="/api/voice/auth/gemini/logout"
    description="Sign in with your Google account to access Gemini models for vision and multimodal tasks. Uses Google OAuth with offline access for persistent refresh tokens."
    successMsg="Signed in with Google Gemini!"
    signOutMsg="Signed out from Google Gemini"
  />`;
}


/* ═══════════════════════════════════════════════════════════════
 *  GitHubDeviceFlowCard — "Sign in with GitHub" (like VS Code / Roo Code)
 *  Uses OAuth Device Flow: no public URL, no callback needed.
 * ═══════════════════════════════════════════════════════════════ */
function GitHubDeviceFlowCard({ config }) {
  const [phase, setPhase] = useState("idle"); // idle | loading | code | polling | done | error
  const [userCode, setUserCode] = useState("");
  const [verificationUri, setVerificationUri] = useState("");
  const [deviceCode, setDeviceCode] = useState("");
  const [pollInterval, setPollInterval] = useState(5);
  const [ghUser, setGhUser] = useState("");
  const [error, setError] = useState("");
  const pollRef = useRef(null);

  // Check if already authenticated
  const hasToken = Boolean(
    config?.GH_TOKEN || config?.GITHUB_TOKEN
  );

  // Cleanup polling on unmount
  useEffect(() => {
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, []);

  async function startFlow() {
    setPhase("loading");
    setError("");
    try {
      const res = await apiFetch("/api/github/device/start", { method: "POST" });
      if (!res.ok) throw new Error(res.error || "Failed to start device flow");
      const d = res.data;
      setUserCode(d.userCode);
      setVerificationUri(d.verificationUri);
      setDeviceCode(d.deviceCode);
      setPollInterval(d.interval || 5);
      setPhase("code");

      // Open GitHub in a new tab automatically
      try {
        window.open(d.verificationUri, "_blank");
      } catch {
        // may be blocked by popup blocker
      }

      // Start polling
      startPolling(d.deviceCode, (d.interval || 5) * 1000);
    } catch (err) {
      setError(err.message);
      setPhase("error");
    }
  }

  function startPolling(dc, intervalMs) {
    if (pollRef.current) clearTimeout(pollRef.current);
    setPhase("polling");

    async function tick() {
      try {
        const res = await apiFetch("/api/github/device/poll", {
          method: "POST",
          body: { deviceCode: dc },
        });
        if (!res.ok) {
          pollRef.current = setTimeout(tick, intervalMs);
          return;
        }
        const d = res.data;
        if (d.status === "complete") {
          pollRef.current = null;
          setGhUser(d.login);
          setPhase("done");
          haptic("success");
          showToast("success", `Signed in as ${d.login}`);
          return;
        } else if (d.status === "slow_down") {
          // Increase interval as requested by GitHub
          const newInterval = (d.interval || 10) * 1000;
          setPollInterval(d.interval || 10);
          intervalMs = newInterval;
        } else if (d.status === "expired") {
          pollRef.current = null;
          setError("Code expired. Please try again.");
          setPhase("error");
          return;
        } else if (d.status === "error") {
          pollRef.current = null;
          setError(d.description || d.error || "Authorization failed");
          setPhase("error");
          return;
        }
        // "pending" or "slow_down" → schedule next tick
        pollRef.current = setTimeout(tick, intervalMs);
      } catch {
        // network error — keep polling, it may recover
        pollRef.current = setTimeout(tick, intervalMs);
      }
    }

    pollRef.current = setTimeout(tick, intervalMs);
  }

  function copyCode() {
    try {
      navigator.clipboard.writeText(userCode);
      haptic("light");
      showToast("info", "Code copied!");
    } catch {
      // clipboard not available
    }
  }

  // Already authenticated — compact info
  if (hasToken && phase !== "done") {
    return html`
      <${Card}>
        <div style="display:flex;align-items:center;gap:10px;padding:4px 0">
          <span style="font-size:20px">${resolveIcon(":git:")}</span>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;color:var(--text-primary)">GitHub Connected</div>
            <div style="font-size:12px;color:var(--text-secondary)">Token is configured. Re-authenticate below if needed.</div>
          </div>
          <${Button} variant="outlined" size="small" onClick=${startFlow}>
            Re-auth
          <//>
        </div>
      <//>
    `;
  }

  // Done — just authorized
  if (phase === "done") {
    return html`
      <${Card}>
        <div style="text-align:center;padding:12px 0">
          <div style="font-size:32px;margin-bottom:8px">${resolveIcon(":check:")}</div>
          <div style="font-size:15px;font-weight:600;color:var(--text-primary)">Signed in as ${ghUser}</div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:4px">GitHub token saved to .env</div>
        </div>
      <//>
    `;
  }

  // Show device code to enter
  if (phase === "code" || phase === "polling") {
    return html`
      <${Card}>
        <div style="text-align:center;padding:8px 0">
          <div style="font-size:13px;color:var(--text-secondary);margin-bottom:12px">
            Go to <a href=${verificationUri} target="_blank" rel="noopener"
              style="color:var(--accent);font-weight:600;text-decoration:underline">${verificationUri}</a>
            and enter this code:
          </div>
          <${Button} variant="text" size="small" onClick=${copyCode}
            style="font-size:28px;font-weight:700;letter-spacing:0.15em;font-family:var(--font-mono,'SF Mono',monospace);
              padding:12px 24px;border-radius:var(--radius-md);background:var(--surface-1);
              border:2px dashed var(--accent);color:var(--text-primary);cursor:pointer;
              transition:background 0.15s ease"
            title="Click to copy">
            ${userCode}
          <//>
          <div style="font-size:12px;color:var(--text-hint);margin-top:10px;display:flex;align-items:center;justify-content:center;gap:6px">
            <span class="spinner" style="width:14px;height:14px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%"></span>
            Waiting for authorization…
          </div>
        </div>
      <//>
    `;
  }

  // Error state
  if (phase === "error") {
    return html`
      <${Card}>
        <div style="text-align:center;padding:12px 0">
          <div style="font-size:24px;margin-bottom:8px">${resolveIcon(":alert:")}</div>
          <div style="font-size:13px;color:var(--color-error);margin-bottom:12px">${error}</div>
          <${Button} variant="contained" color="primary" size="small" onClick=${startFlow}>Try Again<//>
        </div>
      <//>
    `;
  }

  // Idle — show sign-in button
  return html`
    <${Card}>
      <div style="text-align:center;padding:16px 0">
        <div style="font-size:32px;margin-bottom:8px">${resolveIcon(":git:")}</div>
        <div style="font-size:15px;font-weight:600;margin-bottom:4px;color:var(--text-primary)">
          Sign in with GitHub
        </div>
        <div style="font-size:12px;color:var(--text-secondary);margin-bottom:16px;max-width:280px;margin-inline:auto;line-height:1.5">
          Authorize Bosun to manage repos and issues on your behalf.
          No public URL needed — works entirely from your local machine.
        </div>
        <${Button} variant="contained" color="primary" onClick=${startFlow}
          disabled=${phase === "loading"}
          style="min-width:200px">
          ${phase === "loading" ? html`<${Spinner} size=${14} /> Connecting…` : "Sign in with GitHub"}
        <//>
      </div>
    <//>
  `;
}

/* ═══════════════════════════════════════════════════════════════
 *  ContextShreddingPanel — Overview card for the context-shredding category
 *  Shows tier ladder, active status badges, and profiles editor.
 * ═══════════════════════════════════════════════════════════════ */
function ContextShreddingPanel({ getValue }) {
  const DEFAULTS = {
    CONTEXT_SHREDDING_ENABLED: "true",
    CONTEXT_SHREDDING_FULL_CONTEXT_TURNS: "3",
    CONTEXT_SHREDDING_TIER1_MAX_AGE: "5",
    CONTEXT_SHREDDING_TIER2_MAX_AGE: "9",
    CONTEXT_SHREDDING_COMPRESS_TOOL_OUTPUTS: "true",
    CONTEXT_SHREDDING_COMPRESS_MESSAGES: "true",
    CONTEXT_SHREDDING_COMPRESS_AGENT_MESSAGES: "true",
    CONTEXT_SHREDDING_COMPRESS_USER_MESSAGES: "true",
  };

  const get = (key) => {
    const val = getValue ? getValue(key) : "";
    return val !== "" && val != null ? val : DEFAULTS[key] ?? "";
  };

  const enabled = get("CONTEXT_SHREDDING_ENABLED") !== "false";
  const compressTools = get("CONTEXT_SHREDDING_COMPRESS_TOOL_OUTPUTS") !== "false";
  const compressMsgs = get("CONTEXT_SHREDDING_COMPRESS_MESSAGES") !== "false";
  const parseThreshold = (value, fallback) => {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const parsedTier0 = parseThreshold(get("CONTEXT_SHREDDING_FULL_CONTEXT_TURNS"), 3);
  const parsedTier1 = parseThreshold(get("CONTEXT_SHREDDING_TIER1_MAX_AGE"), 5);
  const parsedTier2 = parseThreshold(get("CONTEXT_SHREDDING_TIER2_MAX_AGE"), 9);

  const tier0 = Math.max(1, parsedTier0);
  const tier1 = Math.max(tier0, parsedTier1);
  const tier2 = Math.max(tier1, parsedTier2);

  const formatTierRange = (start, end) => {
    if (start > end) return "none";
    if (start === end) return `turn ${start}`;
    return `turns ${start}–${end}`;
  };

  const StatusBadge = ({ label, on }) => html`
    <${Chip}
      label=${label}
      size="small"
      color=${on ? "success" : "default"}
      variant=${on ? "filled" : "outlined"}
      style="font-size:11px;height:22px"
    />
  `;

  const tierRows = [
    { label: "Tier 0 — Full Context", range: formatTierRange(0, tier0), color: "#4caf50", desc: "Completely uncompressed" },
    { label: "Tier 1 — Light Compression", range: formatTierRange(tier0 + 1, tier1), color: "#ff9800", desc: "Head + tail truncation" },
    { label: "Tier 2 — Moderate", range: formatTierRange(tier1 + 1, tier2), color: "#f44336", desc: "Heavy truncation" },
    { label: "Tier 3 — Skeleton", range: `turns ${tier2 + 1}+`, color: "#9e9e9e", desc: "Tool name + args only" },
  ];

  return html`
    <div style="margin-bottom:12px">
      <!-- Status overview -->
      <${Paper} variant="outlined" style="padding:14px 16px;margin-bottom:12px;border-radius:10px;background:var(--bg-card,#1e1e1e)">
        <${Typography} variant="subtitle2" style="margin-bottom:10px;font-weight:600;display:flex;align-items:center;gap:8px">
          Context Shredding Status
          <${StatusBadge} label=${enabled ? "ENABLED" : "DISABLED"} on=${enabled} />
        <//>
        ${!enabled && html`
          <${Alert} severity="warning" style="margin-bottom:10px;font-size:12px">
            Context Shredding is disabled. Agents will receive their full message history every turn,
            which increases API costs and risks context overflow on long sessions.
          <//>
        `}
        <${Stack} direction="row" spacing=${1} flexWrap="wrap" useFlexGap style="gap:6px">
          <${StatusBadge} label="Tool Outputs" on=${enabled && compressTools} />
          <${StatusBadge} label="Agent Messages" on=${enabled && compressMsgs} />
          <${StatusBadge} label="User Prompts" on=${enabled && compressMsgs} />
        <//>
      <//>

      <!-- Tier ladder visualization -->
      ${enabled && compressTools && html`
        <${Paper} variant="outlined" style="padding:14px 16px;margin-bottom:12px;border-radius:10px;background:var(--bg-card,#1e1e1e)">
          <${Typography} variant="subtitle2" style="margin-bottom:10px;font-weight:600">
            Tool Output Tier Ladder
          <//>
          <div style="display:flex;flex-direction:column;gap:6px">
            ${tierRows.map((row) => html`
              <div key=${row.label} style="display:flex;align-items:center;gap:10px;padding:6px 10px;border-radius:6px;border-left:3px solid ${row.color};background:color-mix(in srgb,${row.color} 8%,transparent)">
                <div style="flex:1;min-width:0">
                  <div style="font-size:12px;font-weight:600;color:${row.color}">${row.label}</div>
                  <div style="font-size:11px;color:var(--text-secondary)">${row.desc}</div>
                </div>
                <${Chip} label=${row.range} size="small" style="font-size:11px;height:20px;background:color-mix(in srgb,${row.color} 18%,transparent);color:${row.color};border:1px solid ${row.color}" />
              </div>
            `)}
          </div>
          <${Typography} variant="caption" style="display:block;margin-top:8px;color:var(--text-secondary)">
            High-value items (score ≥ ${get("CONTEXT_SHREDDING_SCORE_HIGH") || 70}) are shifted to a lower tier;
            low-value items (score &lt; ${get("CONTEXT_SHREDDING_SCORE_LOW") || 30}) are compressed sooner.
            Full outputs are always cached to disk for on-demand retrieval.
          <//>
        <//>
      `}

      <!-- Per-type profiles hint -->
      <${Paper} variant="outlined" style="padding:12px 16px;border-radius:10px;background:var(--bg-card,#1e1e1e)">
        <${Typography} variant="caption" style="color:var(--text-secondary);line-height:1.6;display:block">
          <strong>Per-Type Profiles:</strong> Use the "Per-Type Profiles (JSON)" setting below (under Advanced)
          to override any of these values for specific interaction types (<code>task</code>, <code>chat</code>, <code>voice</code>, <code>flow</code>)
          or agent types (<code>codex-sdk</code>, <code>claude-sdk</code>, etc.).
          Example: <code>{"{"}"perType": {"{"}"voice": {"{"}"fullContextTurns": 6{"}"}{"}"}{"}"}</code>
        <//>
      <//>
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════════
 *  SettingsTab — Top-level with two-mode segmented control
 * ═══════════════════════════════════════════════════════════════ */
export function SettingsTab() {
  const [mode, setMode] = useState("preferences");

  /* Inject scoped CSS on first render */
  useEffect(() => { injectStyles(); }, []);

  return html`
    <div class="settings-content-constrained">
      <!-- Top-level mode switcher -->
      <div class="settings-mode-switch" style="margin-bottom:12px">
        <${SegmentedControl}
          options=${[
            { value: "preferences", label: "App Preferences" },
            { value: "server", label: "Server Config" },
          ]}
          value=${mode}
          onChange=${(v) => {
            setMode(v);
            haptic("light");
          }}
        />
      </div>

      ${mode === "preferences"
        ? html`<${AppPreferencesMode} />`
        : html`<${ServerConfigMode} />`}
    </div>
  `;
}
