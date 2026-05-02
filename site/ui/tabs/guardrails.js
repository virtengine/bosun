/* ─────────────────────────────────────────────────────────────
 *  Tab: Guardrails — runtime, repo, hooks, and input controls
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import htm from "htm";

import { apiFetch } from "../modules/api.js";
import { guardrailsData, refreshTab, showToast } from "../modules/state.js";
import { ICONS } from "../modules/icons.js";
import { formatRelative } from "../modules/utils.js";

const html = htm.bind(h);

const DEFAULT_POLICY = Object.freeze({
  enabled: true,
  warnThreshold: 60,
  blockThreshold: 35,
  minTitleLength: 8,
  minDescriptionLength: 24,
  minContextFields: 1,
  minCombinedTokens: 10,
});

const STYLES = `
.guardrails-root { padding: 12px; display: flex; flex-direction: column; gap: 14px; }
.guardrails-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.guardrails-title { display: flex; gap: 10px; align-items: center; }
.guardrails-title-icon { width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; background: rgba(56, 189, 248, 0.14); color: #38bdf8; }
.guardrails-title h2 { margin: 0; font-size: 1.15rem; }
.guardrails-title p { margin: 4px 0 0; color: var(--text-secondary, #9ca3af); max-width: 760px; }
.guardrails-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.guardrails-btn { border: 1px solid var(--border, #334155); background: var(--bg-card, #111827); color: var(--text-primary, #e5e7eb); border-radius: 10px; padding: 9px 14px; cursor: pointer; font: inherit; }
.guardrails-btn:hover { border-color: #38bdf8; }
.guardrails-btn.primary { background: linear-gradient(135deg, #0f766e, #0369a1); border-color: transparent; color: #f8fafc; }
.guardrails-btn.primary:hover { filter: brightness(1.05); }
.guardrails-btn:disabled { opacity: 0.65; cursor: progress; }
.guardrails-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr)); gap: 10px; }
.guardrails-stat { background: var(--bg-card, #111827); border: 1px solid var(--border, #334155); border-radius: 14px; padding: 14px; }
.guardrails-stat-label { color: var(--text-secondary, #94a3b8); font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; }
.guardrails-stat-value { font-size: 1.8rem; font-weight: 700; margin-top: 6px; }
.guardrails-stat-sub { margin-top: 4px; color: var(--text-secondary, #94a3b8); font-size: 0.85rem; }
.guardrails-section { background: var(--bg-card, #111827); border: 1px solid var(--border, #334155); border-radius: 16px; padding: 16px; display: flex; flex-direction: column; gap: 14px; }
.guardrails-section h3 { margin: 0; font-size: 1rem; }
.guardrails-section-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }
.guardrails-section-copy { color: var(--text-secondary, #94a3b8); margin: 4px 0 0; }
.guardrails-pill-row { display: flex; gap: 8px; flex-wrap: wrap; }
.guardrails-pill { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 5px 10px; font-size: 0.8rem; border: 1px solid transparent; }
.guardrails-pill.good { background: rgba(34, 197, 94, 0.14); color: #86efac; border-color: rgba(34, 197, 94, 0.26); }
.guardrails-pill.warn { background: rgba(245, 158, 11, 0.14); color: #fcd34d; border-color: rgba(245, 158, 11, 0.26); }
.guardrails-pill.bad { background: rgba(248, 113, 113, 0.14); color: #fca5a5; border-color: rgba(248, 113, 113, 0.26); }
.guardrails-pill.neutral { background: rgba(148, 163, 184, 0.14); color: #cbd5e1; border-color: rgba(148, 163, 184, 0.26); }
.guardrails-toggle-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 290px), 1fr)); gap: 10px; }
.guardrails-toggle-card { border: 1px solid var(--border, #334155); border-radius: 14px; padding: 14px; background: rgba(15, 23, 42, 0.5); }
.guardrails-toggle-top { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; }
.guardrails-toggle-top h4 { margin: 0; font-size: 0.95rem; }
.guardrails-toggle-top p { margin: 4px 0 0; color: var(--text-secondary, #94a3b8); font-size: 0.85rem; }
.guardrails-switch { position: relative; width: 48px; height: 28px; display: inline-flex; }
.guardrails-switch input { opacity: 0; width: 0; height: 0; }
.guardrails-switch-track { position: absolute; inset: 0; background: #475569; border-radius: 999px; transition: 0.2s ease; }
.guardrails-switch-thumb { position: absolute; top: 3px; left: 3px; width: 22px; height: 22px; border-radius: 50%; background: #f8fafc; transition: 0.2s ease; }
.guardrails-switch input:checked + .guardrails-switch-track { background: #0ea5e9; }
.guardrails-switch input:checked + .guardrails-switch-track + .guardrails-switch-thumb { transform: translateX(20px); }
.guardrails-switch input:disabled + .guardrails-switch-track { opacity: 0.6; }
.guardrails-meta { color: var(--text-secondary, #94a3b8); font-size: 0.82rem; }
.guardrails-warning-list { margin: 0; padding-left: 18px; color: #fca5a5; display: grid; gap: 6px; }
.guardrails-category-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 250px), 1fr)); gap: 10px; }
.guardrails-category-card { border: 1px solid var(--border, #334155); border-radius: 14px; padding: 12px; background: rgba(15, 23, 42, 0.45); }
.guardrails-category-card h4 { margin: 0; font-size: 0.95rem; }
.guardrails-category-card p { color: var(--text-secondary, #94a3b8); font-size: 0.84rem; margin: 6px 0 0; }
.guardrails-summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 10px; }
.guardrails-summary-card { border: 1px solid var(--border, #334155); border-radius: 14px; padding: 14px; background: rgba(15, 23, 42, 0.45); display: flex; flex-direction: column; gap: 10px; }
.guardrails-summary-card h4 { margin: 0; font-size: 0.95rem; }
.guardrails-summary-card p { color: var(--text-secondary, #94a3b8); font-size: 0.84rem; margin: 4px 0 0; }
.guardrails-summary-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.guardrails-summary-item { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; }
.guardrails-summary-item-label { color: var(--text-secondary, #94a3b8); font-size: 0.82rem; }
.guardrails-summary-item-value { display: inline-flex; justify-content: flex-end; flex-wrap: wrap; gap: 6px; text-align: right; }
.guardrails-script-list { display: grid; gap: 8px; }
.guardrails-script { border: 1px solid var(--border, #334155); border-radius: 12px; padding: 10px; background: rgba(2, 6, 23, 0.45); }
.guardrails-script-name { font-weight: 600; }
.guardrails-script-cmd { margin-top: 4px; color: var(--text-secondary, #94a3b8); font-family: Consolas, Monaco, monospace; font-size: 0.82rem; word-break: break-word; }
.guardrails-form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr)); gap: 10px; }
.guardrails-field { display: flex; flex-direction: column; gap: 6px; }
.guardrails-field label { font-size: 0.82rem; color: var(--text-secondary, #94a3b8); }
.guardrails-field input, .guardrails-field textarea { width: 100%; border-radius: 10px; border: 1px solid var(--border, #334155); background: rgba(2, 6, 23, 0.65); color: var(--text-primary, #e5e7eb); padding: 10px 12px; font: inherit; box-sizing: border-box; }
.guardrails-field textarea { min-height: 110px; resize: vertical; }
.guardrails-form-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
.guardrails-assessment { border: 1px solid var(--border, #334155); border-radius: 14px; padding: 14px; background: rgba(2, 6, 23, 0.5); }
.guardrails-assessment-score { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.guardrails-score-ring { width: 64px; height: 64px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; border: 4px solid rgba(148, 163, 184, 0.18); }
.guardrails-score-ring.good { color: #86efac; border-color: rgba(34, 197, 94, 0.35); }
.guardrails-score-ring.warn { color: #fcd34d; border-color: rgba(245, 158, 11, 0.35); }
.guardrails-score-ring.bad { color: #fca5a5; border-color: rgba(248, 113, 113, 0.35); }
.guardrails-hook-toolbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.guardrails-hook-search { flex: 1; min-width: 220px; }
.guardrails-hook-list { display: grid; gap: 10px; }
.guardrails-hook-group { border: 1px solid var(--border, #334155); border-radius: 14px; padding: 12px; background: rgba(2, 6, 23, 0.4); }
.guardrails-hook-group-head { display: flex; justify-content: space-between; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.guardrails-hook-group-head h4 { margin: 0; }
.guardrails-hook-items { display: grid; gap: 8px; margin-top: 10px; }
.guardrails-hook-item { display: grid; grid-template-columns: 1fr auto; gap: 10px; border: 1px solid rgba(51, 65, 85, 0.75); border-radius: 12px; padding: 10px; background: rgba(15, 23, 42, 0.7); }
.guardrails-hook-item h5 { margin: 0; font-size: 0.92rem; }
.guardrails-hook-item p { margin: 4px 0 0; color: var(--text-secondary, #94a3b8); font-size: 0.83rem; }
.guardrails-hook-badges { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.guardrails-hook-badge { font-size: 0.74rem; border: 1px solid rgba(56, 189, 248, 0.25); color: #7dd3fc; background: rgba(56, 189, 248, 0.1); border-radius: 999px; padding: 3px 8px; }
.guardrails-hook-badge.core { border-color: rgba(244, 114, 182, 0.25); color: #f9a8d4; background: rgba(244, 114, 182, 0.1); }
.guardrails-hook-badge.blocking { border-color: rgba(248, 113, 113, 0.28); color: #fca5a5; background: rgba(248, 113, 113, 0.12); }
.guardrails-hook-badge.sdk-full { border-color: rgba(34, 197, 94, 0.3); color: #86efac; background: rgba(34, 197, 94, 0.1); }
.guardrails-hook-badge.sdk-bridge { border-color: rgba(250, 204, 21, 0.3); color: #fde047; background: rgba(250, 204, 21, 0.08); }
.guardrails-hook-badge.sdk-unsupported { border-color: rgba(100, 116, 139, 0.3); color: #94a3b8; background: rgba(100, 116, 139, 0.08); opacity: 0.6; }
.guardrails-hook-badge.sdk-partial { border-color: rgba(251, 146, 60, 0.3); color: #fdba74; background: rgba(251, 146, 60, 0.08); }
.guardrails-hook-badge.edited { border-color: rgba(168, 85, 247, 0.3); color: #c084fc; background: rgba(168, 85, 247, 0.1); }
.guardrails-hook-actions { display: flex; gap: 6px; align-items: flex-start; flex-direction: column; }
.guardrails-hook-edit-btn { border: 1px solid var(--border, #334155); background: transparent; color: var(--text-secondary, #94a3b8); border-radius: 8px; padding: 4px 10px; cursor: pointer; font-size: 0.78rem; }
.guardrails-hook-edit-btn:hover { border-color: #38bdf8; color: #7dd3fc; }
.guardrails-feature-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); gap: 10px; }
.guardrails-feature-card { border: 1px solid var(--border, #334155); border-radius: 14px; padding: 12px; background: rgba(15, 23, 42, 0.5); transition: border-color 0.15s; }
.guardrails-feature-card.active { border-color: rgba(34, 197, 94, 0.4); }
.guardrails-feature-card-head { display: flex; justify-content: space-between; gap: 8px; align-items: flex-start; }
.guardrails-feature-card-head h4 { margin: 0; font-size: 0.92rem; display: flex; align-items: center; gap: 6px; }
.guardrails-feature-card p { margin: 4px 0 0; color: var(--text-secondary, #94a3b8); font-size: 0.82rem; }
.guardrails-feature-card .guardrails-meta { margin-top: 6px; }
.guardrails-hook-detail { border: 1px solid rgba(56, 189, 248, 0.2); border-radius: 12px; padding: 12px; background: rgba(2, 6, 23, 0.6); margin-top: 8px; display: flex; flex-direction: column; gap: 10px; }
.guardrails-hook-detail label { font-size: 0.82rem; color: var(--text-secondary, #94a3b8); display: flex; flex-direction: column; gap: 4px; }
.guardrails-hook-detail textarea { width: 100%; min-height: 70px; border-radius: 8px; border: 1px solid var(--border, #334155); background: rgba(2, 6, 23, 0.7); color: var(--text-primary, #e5e7eb); padding: 8px; font-family: Consolas, Monaco, monospace; font-size: 0.8rem; resize: vertical; box-sizing: border-box; }
.guardrails-hook-detail input[type="number"] { width: 120px; border-radius: 8px; border: 1px solid var(--border, #334155); background: rgba(2, 6, 23, 0.7); color: var(--text-primary, #e5e7eb); padding: 6px 8px; font: inherit; }
.guardrails-hook-detail-row { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
.guardrails-hook-detail-actions { display: flex; gap: 8px; justify-content: flex-end; }
.guardrails-sdk-row { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 6px; }
.guardrails-filter-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.guardrails-filter-select { border: 1px solid var(--border, #334155); background: var(--bg-card, #111827); color: var(--text-primary, #e5e7eb); border-radius: 8px; padding: 6px 10px; font: inherit; font-size: 0.85rem; cursor: pointer; }
.guardrails-empty { border: 1px dashed var(--border, #334155); border-radius: 14px; padding: 16px; color: var(--text-secondary, #94a3b8); text-align: center; }
.guardrails-repo-selector { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.guardrails-repo-tab { border: 1px solid var(--border, #334155); background: transparent; color: var(--text-secondary, #94a3b8); border-radius: 10px; padding: 8px 14px; cursor: pointer; font: inherit; font-size: 0.85rem; transition: 0.15s; }
.guardrails-repo-tab:hover { border-color: #38bdf8; color: #e5e7eb; }
.guardrails-repo-tab.active { border-color: rgba(56, 189, 248, 0.5); background: rgba(56, 189, 248, 0.08); color: #7dd3fc; }
.guardrails-stack-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr)); gap: 10px; }
.guardrails-stack-card { border: 1px solid var(--border, #334155); border-radius: 14px; padding: 12px; background: rgba(15, 23, 42, 0.5); }
.guardrails-stack-card.primary { border-color: rgba(56, 189, 248, 0.35); }
.guardrails-stack-card h4 { margin: 0; font-size: 0.95rem; display: flex; align-items: center; gap: 6px; }
.guardrails-stack-card p { margin: 4px 0 0; color: var(--text-secondary, #94a3b8); font-size: 0.82rem; }
.guardrails-stack-cmds { margin-top: 8px; display: grid; gap: 4px; }
.guardrails-stack-cmd { font-size: 0.78rem; color: var(--text-secondary, #94a3b8); font-family: Consolas, Monaco, monospace; }
.guardrails-stack-cmd strong { color: var(--text-primary, #e5e7eb); font-weight: 600; font-family: inherit; }
.guardrails-lang-override { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.guardrails-lang-override select { border: 1px solid var(--border, #334155); background: var(--bg-card, #111827); color: var(--text-primary, #e5e7eb); border-radius: 8px; padding: 6px 10px; font: inherit; font-size: 0.85rem; }
.guardrails-lang-pill { display: inline-flex; align-items: center; gap: 4px; border-radius: 999px; padding: 3px 10px; font-size: 0.78rem; background: rgba(56, 189, 248, 0.1); color: #7dd3fc; border: 1px solid rgba(56, 189, 248, 0.25); }
@media (max-width: 720px) {
  .guardrails-root { padding: 8px; }
  .guardrails-hook-item { grid-template-columns: 1fr; }
  .guardrails-form-actions { justify-content: stretch; }
  .guardrails-form-actions .guardrails-btn { flex: 1 1 160px; }
}
`;

function normalizePolicy(policy) {
  const source = policy && typeof policy === "object" ? policy : {};
  return {
    enabled: source.enabled !== undefined ? source.enabled === true : DEFAULT_POLICY.enabled,
    warnThreshold: Number(source.warnThreshold ?? DEFAULT_POLICY.warnThreshold),
    blockThreshold: Number(source.blockThreshold ?? DEFAULT_POLICY.blockThreshold),
    minTitleLength: Number(source.minTitleLength ?? DEFAULT_POLICY.minTitleLength),
    minDescriptionLength: Number(source.minDescriptionLength ?? DEFAULT_POLICY.minDescriptionLength),
    minContextFields: Number(source.minContextFields ?? DEFAULT_POLICY.minContextFields),
    minCombinedTokens: Number(source.minCombinedTokens ?? DEFAULT_POLICY.minCombinedTokens),
  };
}

function summarizeToggle(enabled, onText, offText) {
  return enabled ? onText : offText;
}

function scoreTone(score = 0) {
  if (score >= 75) return "good";
  if (score >= 45) return "warn";
  return "bad";
}

function formatScore(score) {
  const numeric = Number(score);
  if (!Number.isFinite(numeric)) return "--";
  return `${Math.round(numeric)}`;
}

function toNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function buildAssessmentPayload(form) {
  const tags = String(form.metadataTags || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return {
    title: form.title,
    description: form.description,
    metadata: {
      project: form.metadataProject,
      workspace: form.metadataWorkspace,
      tags,
    },
  };
}

function groupHooksByCategory(hooks) {
  const grouped = new Map();
  for (const hook of Array.isArray(hooks) ? hooks : []) {
    const key = String(hook?.category || "uncategorized");
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(hook);
  }
  return grouped;
}

function summarizeAttachMode(value) {
  if (value === "trusted-only") return "Trusted authors only";
  if (value === "disabled") return "Disabled";
  return "All pull requests";
}

function formatPolicyList(values, fallback = "None configured") {
  const entries = Array.isArray(values)
    ? values.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  return entries.length > 0 ? entries.join(", ") : fallback;
}

function renderSummaryCard(card) {
  return html`
    <div class="guardrails-summary-card" key=${card.title}>
      <div>
        <h4>${card.title}</h4>
        <p>${card.description}</p>
      </div>
      <ul class="guardrails-summary-list">
        ${(Array.isArray(card.items) ? card.items : []).map((item) => html`
          <li class="guardrails-summary-item" key=${`${card.title}-${item.label}`}>
            <span class="guardrails-summary-item-label">${item.label}</span>
            <span class="guardrails-summary-item-value">
              <span class="guardrails-pill ${item.tone || "neutral"}">${item.value}</span>
            </span>
          </li>
        `)}
      </ul>
    </div>
  `;
}

function renderToggle(checked, onChange, disabled = false) {
  return html`
    <label class="guardrails-switch">
      <input type="checkbox" checked=${checked} disabled=${disabled} onChange=${onChange} />
      <span class="guardrails-switch-track"></span>
      <span class="guardrails-switch-thumb"></span>
    </label>
  `;
}

export function GuardrailsTab() {
  const snapshot = guardrailsData.value;
  const [runtimeSaving, setRuntimeSaving] = useState("");
  const [policySaving, setPolicySaving] = useState(false);
  const [hooksLoading, setHooksLoading] = useState(false);
  const [hookBusyId, setHookBusyId] = useState("");
  const [hookSearch, setHookSearch] = useState("");
  const [hookCatalog, setHookCatalog] = useState([]);
  const [hookState, setHookState] = useState({ enabledIds: [] });
  const [policyDraft, setPolicyDraft] = useState(normalizePolicy(snapshot?.INPUT?.policy));
  const [assessmentInput, setAssessmentInput] = useState({
    title: "",
    description: "",
    metadataProject: "",
    metadataWorkspace: "",
    metadataTags: "",
  });
  const [assessmentBusy, setAssessmentBusy] = useState(false);
  const [assessmentResult, setAssessmentResult] = useState(null);
  const [expandedHookId, setExpandedHookId] = useState(null);
  const [editDraft, setEditDraft] = useState({});
  const [editSaving, setEditSaving] = useState(false);
  const [categoryBusy, setCategoryBusy] = useState("");
  const [sdkFilter, setSdkFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [hookOverrides, setHookOverrides] = useState({});
  const [repoList, setRepoList] = useState([]);
  const [selectedRepoPath, setSelectedRepoPath] = useState("");

  const loadHookControls = async () => {
    setHooksLoading(true);
    try {
      const [catalogRes, stateRes, overridesRes] = await Promise.all([
        apiFetch("/api/hooks/catalog", { _silent: true }),
        apiFetch("/api/hooks/state", { _silent: true }),
        apiFetch("/api/hooks/override", { _silent: true }),
      ]);
      setHookCatalog(Array.isArray(catalogRes?.data) ? catalogRes.data : []);
      setHookState(stateRes?.data && typeof stateRes.data === "object" ? stateRes.data : { enabledIds: [] });
      setHookOverrides(overridesRes?.data && typeof overridesRes.data === "object" ? overridesRes.data : {});
    } catch (err) {
      showToast(err?.message || "Failed to load hook guardrails", "error");
    } finally {
      setHooksLoading(false);
    }
  };

  const loadRepoList = async () => {
    try {
      const res = await apiFetch("/api/guardrails/repos", { _silent: true });
      const repos = Array.isArray(res?.repos) ? res.repos : [];
      setRepoList(repos);
    } catch {
      // Non-critical; single repo view still works via snapshot
    }
  };

  const selectRepo = async (repoPath) => {
    setSelectedRepoPath(repoPath);
    if (!repoPath) {
      await refreshTab("guardrails", { force: true });
      return;
    }
    try {
      const res = await apiFetch(`/api/guardrails?repo=${encodeURIComponent(repoPath)}`, { _silent: true });
      if (res?.snapshot) {
        guardrailsData.value = res.snapshot;
      }
    } catch (err) {
      showToast(err?.message || "Failed to load repo guardrails", "error");
    }
  };

  useEffect(() => {
    if (!snapshot) {
      refreshTab("guardrails");
    }
    loadHookControls();
    loadRepoList();
  }, []);

  useEffect(() => {
    if (!snapshot) return;
    loadHookControls();
  }, [snapshot?.hooks?.updatedAt, snapshot?.summary?.counts?.hooksEnabled, snapshot?.workspace?.workspaceId]);

  useEffect(() => {
    setPolicyDraft(normalizePolicy(snapshot?.INPUT?.policy));
  }, [snapshot?.INPUT?.policyPath, snapshot?.INPUT?.policy?.enabled, snapshot?.INPUT?.policy?.warnThreshold, snapshot?.INPUT?.policy?.blockThreshold, snapshot?.INPUT?.policy?.minTitleLength, snapshot?.INPUT?.policy?.minDescriptionLength, snapshot?.INPUT?.policy?.minContextFields, snapshot?.INPUT?.policy?.minCombinedTokens]);

  const enabledHookIds = useMemo(() => new Set(Array.isArray(hookState?.enabledIds) ? hookState.enabledIds : []), [hookState?.enabledIds]);
  const hookGroups = useMemo(() => {
    let filtered = Array.isArray(hookCatalog) ? [...hookCatalog] : [];
    const q = hookSearch.trim().toLowerCase();
    if (q) {
      filtered = filtered.filter((hook) =>
        [hook?.name, hook?.description, hook?.id, hook?.category, ...(Array.isArray(hook?.tags) ? hook.tags : [])]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(q)),
      );
    }
    if (sdkFilter) {
      filtered = filtered.filter((hook) => {
        const compat = hook?.compatibility?.[sdkFilter];
        return compat && compat !== "unsupported";
      });
    }
    if (statusFilter === "enabled") {
      filtered = filtered.filter((hook) => enabledHookIds.has(hook?.id));
    } else if (statusFilter === "available") {
      filtered = filtered.filter((hook) => !enabledHookIds.has(hook?.id));
    }
    return groupHooksByCategory(filtered);
  }, [hookCatalog, hookSearch, enabledHookIds, sdkFilter, statusFilter]);

  const categoryMeta = useMemo(() => {
    const map = new Map();
    const categories = Array.isArray(snapshot?.hooks?.categories) ? snapshot.hooks.categories : [];
    for (const category of categories) {
      map.set(category.id, category);
    }
    return map;
  }, [snapshot?.hooks?.categories]);

  const saveRuntime = async (patch) => {
    setRuntimeSaving(Object.keys(patch)[0] || "runtime");
    try {
      const res = await apiFetch("/api/guardrails/runtime", {
        method: "POST",
        body: JSON.stringify(patch),
      });
      if (res?.snapshot) {
        guardrailsData.value = res.snapshot;
      } else {
        await refreshTab("guardrails", { force: true });
      }
      showToast("Runtime guardrails updated", "success");
    } catch (err) {
      showToast(err?.message || "Failed to update runtime guardrails", "error");
    } finally {
      setRuntimeSaving("");
    }
  };

  const savePolicy = async () => {
    setPolicySaving(true);
    try {
      const payload = {
        INPUT: {
          enabled: policyDraft.enabled === true,
          warnThreshold: toNumber(policyDraft.warnThreshold, DEFAULT_POLICY.warnThreshold),
          blockThreshold: toNumber(policyDraft.blockThreshold, DEFAULT_POLICY.blockThreshold),
          minTitleLength: toNumber(policyDraft.minTitleLength, DEFAULT_POLICY.minTitleLength),
          minDescriptionLength: toNumber(policyDraft.minDescriptionLength, DEFAULT_POLICY.minDescriptionLength),
          minContextFields: toNumber(policyDraft.minContextFields, DEFAULT_POLICY.minContextFields),
          minCombinedTokens: toNumber(policyDraft.minCombinedTokens, DEFAULT_POLICY.minCombinedTokens),
        },
      };
      const res = await apiFetch("/api/guardrails/policy", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (res?.snapshot) {
        guardrailsData.value = res.snapshot;
      } else {
        await refreshTab("guardrails", { force: true });
      }
      showToast("INPUT policy saved", "success");
    } catch (err) {
      showToast(err?.message || "Failed to save INPUT policy", "error");
    } finally {
      setPolicySaving(false);
    }
  };

  const runAssessment = async () => {
    setAssessmentBusy(true);
    try {
      const res = await apiFetch("/api/guardrails/assess", {
        method: "POST",
        body: JSON.stringify({ input: buildAssessmentPayload(assessmentInput) }),
      });
      setAssessmentResult(res?.assessment || null);
    } catch (err) {
      showToast(err?.message || "Failed to assess input quality", "error");
    } finally {
      setAssessmentBusy(false);
    }
  };

  const toggleHook = async (hook) => {
    const hookId = String(hook?.id || "").trim();
    if (!hookId) return;
    const currentlyEnabled = enabledHookIds.has(hookId);
    let force = false;
    if (currentlyEnabled && hook?.core === true && typeof window !== "undefined" && typeof window.confirm === "function") {
      force = window.confirm("This is a core resilience hook. Force-disable it?");
      if (!force) return;
    }
    setHookBusyId(hookId);
    try {
      await apiFetch("/api/hooks/state", {
        method: "POST",
        body: JSON.stringify({
          action: currentlyEnabled ? "disable" : "enable",
          hookId,
          ...(force ? { force: true } : {}),
        }),
      });
      await Promise.all([
        loadHookControls(),
        refreshTab("guardrails", { force: true }),
      ]);
      showToast(`${currentlyEnabled ? "Disabled" : "Enabled"} ${hook?.name || hookId}`, "success");
    } catch (err) {
      showToast(err?.message || `Failed to update ${hook?.name || hookId}`, "error");
    } finally {
      setHookBusyId("");
    }
  };

  const toggleCategory = async (categoryId) => {
    const catHooks = (Array.isArray(hookCatalog) ? hookCatalog : []).filter((h) => h.category === categoryId);
    const enabledInCat = catHooks.filter((h) => enabledHookIds.has(h.id)).length;
    const shouldEnable = enabledInCat < catHooks.length;
    setCategoryBusy(categoryId);
    try {
      await apiFetch("/api/hooks/state", {
        method: "POST",
        body: JSON.stringify({
          action: shouldEnable ? "bulk-enable" : "bulk-disable",
          category: categoryId,
          hookId: categoryId,
        }),
      });
      await Promise.all([
        loadHookControls(),
        refreshTab("guardrails", { force: true }),
      ]);
      showToast(`${shouldEnable ? "Enabled" : "Disabled"} ${categoryId} hooks`, "success");
    } catch (err) {
      showToast(err?.message || `Failed to toggle ${categoryId}`, "error");
    } finally {
      setCategoryBusy("");
    }
  };

  const openHookEditor = (hook) => {
    const override = hookOverrides[hook.id] || {};
    setExpandedHookId(hook.id);
    setEditDraft({
      command: override.command ?? hook.command ?? "",
      timeout: override.timeout ?? hook.timeout ?? 60000,
      blocking: override.blocking ?? hook.blocking ?? false,
    });
  };

  const closeHookEditor = () => {
    setExpandedHookId(null);
    setEditDraft({});
  };

  const saveHookEdit = async (hookId) => {
    setEditSaving(true);
    try {
      await apiFetch("/api/hooks/override", {
        method: "POST",
        body: JSON.stringify({
          hookId,
          command: editDraft.command,
          timeout: Number(editDraft.timeout) || 60000,
          blocking: editDraft.blocking === true,
        }),
      });
      await loadHookControls();
      showToast("Hook configuration saved", "success");
      closeHookEditor();
    } catch (err) {
      showToast(err?.message || "Failed to save hook override", "error");
    } finally {
      setEditSaving(false);
    }
  };

  const revertHookEdit = async (hookId) => {
    setEditSaving(true);
    try {
      await apiFetch("/api/hooks/override", {
        method: "DELETE",
        body: JSON.stringify({ hookId }),
      });
      await loadHookControls();
      showToast("Hook reverted to defaults", "success");
      closeHookEditor();
    } catch (err) {
      showToast(err?.message || "Failed to revert hook", "error");
    } finally {
      setEditSaving(false);
    }
  };

  const warnings = Array.isArray(snapshot?.summary?.warnings) ? snapshot.summary.warnings : [];
  const repoCategories = snapshot?.repoGuardrails?.categories && typeof snapshot.repoGuardrails.categories === "object"
    ? snapshot.repoGuardrails.categories
    : {};
  const summaryStatus = String(snapshot?.summary?.status || "partial");
  const policyPath = snapshot?.INPUT?.policyPath || "";
  const updatedAt = snapshot?.hooks?.updatedAt || null;
  const pushPolicy = snapshot?.push?.policy && typeof snapshot.push.policy === "object"
    ? snapshot.push.policy
    : {};
  const prAutomation = snapshot?.runtime?.prAutomation && typeof snapshot.runtime.prAutomation === "object"
    ? snapshot.runtime.prAutomation
    : {};
  const gates = snapshot?.runtime?.gates && typeof snapshot.runtime.gates === "object"
    ? snapshot.runtime.gates
    : {};
  const trustedAuthors = Array.isArray(prAutomation?.trustedAuthors) ? prAutomation.trustedAuthors : [];
  const prepushScripts = Array.isArray(repoCategories?.prepush?.scripts) ? repoCategories.prepush.scripts : [];
  const prepublishScripts = Array.isArray(repoCategories?.prepublish?.scripts) ? repoCategories.prepublish.scripts : [];
  const ciScripts = Array.isArray(repoCategories?.ci?.scripts) ? repoCategories.ci.scripts : [];
  const projectStack = snapshot?.projectStack || {};
  const detectedStacks = Array.isArray(projectStack?.stacks) ? projectStack.stacks : [];
  const detectedLanguages = Array.isArray(projectStack?.detectedLanguages) ? projectStack.detectedLanguages : [];
  const primaryStackId = projectStack?.primary?.id || "";
  const policySummaryCards = [
    {
      title: "PR Requirements",
      description: "Trusted automation and review attachment policy for pull request workflows.",
      items: [
        { label: "Attach mode", value: summarizeAttachMode(prAutomation.attachMode), tone: prAutomation.attachMode === "disabled" ? "bad" : "good" },
        { label: "Trusted authors", value: trustedAuthors.length > 0 ? `${trustedAuthors.length} configured` : "None configured", tone: trustedAuthors.length > 0 ? "good" : "warn" },
        { label: "Trusted fixes", value: prAutomation.allowTrustedFixes ? "Allowed" : "Blocked", tone: prAutomation.allowTrustedFixes ? "warn" : "good" },
        { label: "Trusted merges", value: prAutomation.allowTrustedMerges ? "Allowed" : "Blocked", tone: prAutomation.allowTrustedMerges ? "warn" : "good" },
        { label: "Setup assist", value: prAutomation?.assistiveActions?.installOnSetup ? "Install on setup" : "Manual install", tone: prAutomation?.assistiveActions?.installOnSetup ? "good" : "neutral" },
      ],
    },
    {
      title: "Publish Requirements",
      description: "Push ownership, pre-push enforcement, and publish-time script coverage.",
      items: [
        { label: "Workflow-owned pushes", value: pushPolicy.workflowOnly ? "Required" : "Open", tone: pushPolicy.workflowOnly ? "good" : "bad" },
        { label: "Agent direct pushes", value: pushPolicy.blockAgentPushes ? "Blocked" : "Allowed", tone: pushPolicy.blockAgentPushes ? "good" : "bad" },
        { label: "Managed pre-push", value: pushPolicy.requireManagedPrePush ? "Required" : "Optional", tone: pushPolicy.requireManagedPrePush ? "good" : "warn" },
        { label: "prepush scripts", value: formatPolicyList(prepushScripts.map((script) => script.name), "Missing"), tone: prepushScripts.length > 0 ? "good" : "bad" },
        { label: "prepublish scripts", value: formatPolicyList(prepublishScripts.map((script) => script.name), "Missing"), tone: prepublishScripts.length > 0 ? "good" : "warn" },
      ],
    },
    {
      title: "Gate Policy",
      description: "Repository posture and automation budget that shape PR execution.",
      items: [
        { label: "Repo visibility", value: String(gates?.prs?.repoVisibility || "unknown"), tone: gates?.prs?.repoVisibility === "unknown" ? "warn" : "neutral" },
        { label: "Automation preference", value: String(gates?.prs?.automationPreference || "runtime-first"), tone: "neutral" },
        { label: "Actions budget", value: String(gates?.prs?.githubActionsBudget || "ask-user"), tone: gates?.prs?.githubActionsBudget === "available" ? "good" : gates?.prs?.githubActionsBudget === "limited" ? "warn" : "neutral" },
        { label: "CI scripts", value: formatPolicyList(ciScripts.map((script) => script.name), "Missing"), tone: ciScripts.length > 0 ? "good" : "warn" },
      ],
    },
    {
      title: "Checks Policy",
      description: "Check evaluation rules for required, optional, pending, and neutral results.",
      items: [
        { label: "Check mode", value: String(gates?.checks?.mode || "all"), tone: "neutral" },
        { label: "Required patterns", value: formatPolicyList(gates?.checks?.requiredPatterns, "All checks"), tone: Array.isArray(gates?.checks?.requiredPatterns) && gates.checks.requiredPatterns.length > 0 ? "good" : "neutral" },
        { label: "Pending required", value: gates?.checks?.treatPendingRequiredAsBlocking ? "Blocking" : "Non-blocking", tone: gates?.checks?.treatPendingRequiredAsBlocking ? "good" : "warn" },
        { label: "Neutral checks", value: gates?.checks?.treatNeutralAsPass ? "Pass" : "Manual review", tone: gates?.checks?.treatNeutralAsPass ? "warn" : "good" },
      ],
    },
    {
      title: "Execution Policy",
      description: "Sandbox, container isolation, and network posture for agent runs.",
      items: [
        { label: "Sandbox mode", value: String(gates?.execution?.sandboxMode || "workspace-write"), tone: "neutral" },
        { label: "Container isolation", value: gates?.execution?.containerIsolationEnabled ? "Enabled" : "Disabled", tone: gates?.execution?.containerIsolationEnabled ? "good" : "warn" },
        { label: "Container runtime", value: String(gates?.execution?.containerRuntime || "auto"), tone: "neutral" },
        { label: "Network access", value: String(gates?.execution?.networkAccess || "default"), tone: gates?.execution?.networkAccess === "none" ? "good" : "warn" },
      ],
    },
    {
      title: "Worktree And Runtime",
      description: "Bootstrap, readiness, backlog, and trigger-control requirements during live execution.",
      items: [
        { label: "Bootstrap", value: gates?.worktrees?.requireBootstrap ? "Required" : "Optional", tone: gates?.worktrees?.requireBootstrap ? "good" : "warn" },
        { label: "Readiness", value: gates?.worktrees?.requireReadiness ? "Required" : "Optional", tone: gates?.worktrees?.requireReadiness ? "good" : "warn" },
        { label: "Push hook", value: gates?.worktrees?.enforcePushHook ? "Enforced" : "Advisory", tone: gates?.worktrees?.enforcePushHook ? "good" : "warn" },
        { label: "Backlog gate", value: gates?.runtime?.enforceBacklog ? "Enforced" : "Open", tone: gates?.runtime?.enforceBacklog ? "good" : "warn" },
        { label: "Agent trigger", value: gates?.runtime?.agentTriggerControl ? "Controlled" : "Open", tone: gates?.runtime?.agentTriggerControl ? "good" : "warn" },
      ],
    },
  ];

  return html`
    <div class="guardrails-root">
      <style>${STYLES}</style>

      <section class="guardrails-header">
        <div class="guardrails-title">
          <div class="guardrails-title-icon">${ICONS.shield}</div>
          <div>
            <h2>Guardrails</h2>
            <p>Operational guardrails for Bosun: runtime approval gates, package-level enforcement, hook coverage, and INPUT policy hardening.</p>
          </div>
        </div>
        <div class="guardrails-actions">
          <button class="guardrails-btn" onClick=${() => { refreshTab("guardrails", { force: true }).then(loadHookControls); loadRepoList(); }}>
            Refresh
          </button>
          <button class="guardrails-btn" onClick=${loadHookControls} disabled=${hooksLoading}>
            ${hooksLoading ? "Loading hooks..." : "Reload hooks"}
          </button>
        </div>
      </section>

      <section class="guardrails-grid">
        <div class="guardrails-stat">
          <div class="guardrails-stat-label">Coverage</div>
          <div class="guardrails-stat-value">${summaryStatus}</div>
          <div class="guardrails-stat-sub">${snapshot?.workspace?.workspaceDir || "Waiting for snapshot"}</div>
        </div>
        <div class="guardrails-stat">
          <div class="guardrails-stat-label">Hooks</div>
          <div class="guardrails-stat-value">${snapshot?.summary?.counts?.hooksEnabled ?? 0}/${snapshot?.summary?.counts?.hooksTotal ?? 0}</div>
          <div class="guardrails-stat-sub">enabled library hooks</div>
        </div>
        <div class="guardrails-stat">
          <div class="guardrails-stat-label">Repo Checks</div>
          <div class="guardrails-stat-value">${snapshot?.summary?.counts?.repoGuardrailsDetected ?? 0}</div>
          <div class="guardrails-stat-sub">${detectedLanguages.length > 0 ? detectedLanguages.join(", ") : "no language detected"}</div>
        </div>
        <div class="guardrails-stat">
          <div class="guardrails-stat-label">Runtime Gates</div>
          <div class="guardrails-stat-value">${snapshot?.summary?.counts?.runtimeEnabled ?? 0}/2</div>
          <div class="guardrails-stat-sub">preflight and review requirements</div>
        </div>
      </section>

      ${warnings.length > 0 ? html`
        <section class="guardrails-section">
          <div class="guardrails-section-head">
            <div>
              <h3>Attention Required</h3>
              <p class="guardrails-section-copy">These gaps weaken Bosun's current protection envelope.</p>
            </div>
            <div class="guardrails-pill ${summaryStatus === "guarded" ? "good" : summaryStatus === "partial" ? "warn" : "bad"}">
              ${summaryStatus}
            </div>
          </div>
          <ul class="guardrails-warning-list">
            ${warnings.map((warning) => html`<li key=${warning}>${warning}</li>`)}
          </ul>
        </section>
      ` : null}

      ${repoList.length > 1 ? html`
        <section class="guardrails-section">
          <div class="guardrails-section-head">
            <div>
              <h3>Workspace Repositories</h3>
              <p class="guardrails-section-copy">Your workspace contains multiple repositories. Select one to view its guardrails and detected stack.</p>
            </div>
            <div class="guardrails-meta">${repoList.length} repos detected</div>
          </div>
          <div class="guardrails-repo-selector">
            ${repoList.map((repo) => {
              const isActive = selectedRepoPath ? selectedRepoPath === repo.path : repo.primary;
              const repoStack = repo.snapshot?.projectStack;
              const langs = Array.isArray(repoStack?.detectedLanguages) ? repoStack.detectedLanguages : [];
              return html`
                <button
                  class="guardrails-repo-tab ${isActive ? "active" : ""}"
                  key=${repo.path}
                  onClick=${() => selectRepo(isActive && selectedRepoPath ? "" : repo.path)}
                  title=${repo.path}
                >
                  ${repo.name || repo.path}
                  ${repo.primary ? html` <span class="guardrails-hook-badge">primary</span>` : null}
                  ${langs.length > 0 ? html` <span class="guardrails-lang-pill">${langs.join(", ")}</span>` : null}
                </button>
              `;
            })}
          </div>
        </section>
      ` : null}

      ${detectedStacks.length > 0 ? html`
        <section class="guardrails-section">
          <div class="guardrails-section-head">
            <div>
              <h3>Detected Project Stacks</h3>
              <p class="guardrails-section-copy">Languages and build systems detected in this repository. Guardrails adapt automatically to the detected stack.</p>
            </div>
            <div class="guardrails-pill-row">
              ${detectedLanguages.map((lang) => html`<span class="guardrails-lang-pill" key=${lang}>${lang}</span>`)}
              ${projectStack.isMonorepo ? html`<span class="guardrails-pill warn">monorepo</span>` : null}
            </div>
          </div>
          <div class="guardrails-stack-grid">
            ${detectedStacks.map((stack) => {
              const cmds = stack.commands || {};
              const cmdEntries = Object.entries(cmds).filter(([, v]) => v);
              const isPrimary = stack.id === primaryStackId;
              return html`
                <div class="guardrails-stack-card ${isPrimary ? "primary" : ""}" key=${stack.id}>
                  <h4>
                    ${stack.label || stack.id}
                    ${isPrimary ? html` <span class="guardrails-hook-badge">primary</span>` : null}
                  </h4>
                  <p>${stack.packageManager ? `Package manager: ${stack.packageManager}` : "No package manager detected"}</p>
                  ${Array.isArray(stack.frameworks) && stack.frameworks.length > 0 ? html`
                    <p>Frameworks: ${stack.frameworks.join(", ")}</p>
                  ` : null}
                  ${cmdEntries.length > 0 ? html`
                    <div class="guardrails-stack-cmds">
                      ${cmdEntries.map(([key, cmd]) => html`
                        <div class="guardrails-stack-cmd" key=${key}><strong>${key}:</strong> ${cmd}</div>
                      `)}
                    </div>
                  ` : html`<p>No commands auto-detected for this stack.</p>`}
                </div>
              `;
            })}
          </div>
        </section>
      ` : null}

      <section class="guardrails-section">
        <div class="guardrails-section-head">
          <div>
            <h3>Runtime Guardrails</h3>
            <p class="guardrails-section-copy">These are the live decision gates Bosun applies before dispatching work.</p>
          </div>
          <div class="guardrails-pill-row">
            <span class="guardrails-pill ${snapshot?.runtime?.preflightEnabled ? "good" : "bad"}">${summarizeToggle(snapshot?.runtime?.preflightEnabled, "Preflight on", "Preflight off")}</span>
            <span class="guardrails-pill ${snapshot?.runtime?.requireReview ? "good" : "bad"}">${summarizeToggle(snapshot?.runtime?.requireReview, "Review required", "Review optional")}</span>
          </div>
        </div>

        <div class="guardrails-toggle-grid">
          <div class="guardrails-toggle-card">
            <div class="guardrails-toggle-top">
              <div>
                <h4>Preflight Checks</h4>
                <p>Reject work before execution when repo, workspace, or policy setup is incomplete.</p>
              </div>
              ${renderToggle(snapshot?.runtime?.preflightEnabled === true, () => saveRuntime({ preflightEnabled: !(snapshot?.runtime?.preflightEnabled === true) }), runtimeSaving === "preflightEnabled")}
            </div>
            <div class="guardrails-meta">Checks: ${gates?.checks?.mode || "all"} · Worktree bootstrap ${gates?.worktrees?.requireBootstrap ? "required" : "optional"}</div>
          </div>

          <div class="guardrails-toggle-card">
            <div class="guardrails-toggle-top">
              <div>
                <h4>Require Review</h4>
                <p>Keep maker-checker behaviour on by default before manual flows or risky execution paths.</p>
              </div>
              ${renderToggle(snapshot?.runtime?.requireReview === true, () => saveRuntime({ requireReview: !(snapshot?.runtime?.requireReview === true) }), runtimeSaving === "requireReview")}
            </div>
            <div class="guardrails-meta">PR attach: ${summarizeAttachMode(prAutomation.attachMode)} · Trusted authors ${trustedAuthors.length}</div>
          </div>
        </div>
      </section>

      <section class="guardrails-section">
        <div class="guardrails-section-head">
          <div>
            <h3>Typed Policy Summaries</h3>
            <p class="guardrails-section-copy">Structured snapshots for PR automation, publish requirements, and the gate families Bosun enforces at runtime.</p>
          </div>
        </div>

        <div class="guardrails-summary-grid">
          ${policySummaryCards.map((card) => renderSummaryCard(card))}
        </div>
      </section>

      <section class="guardrails-section">
        <div class="guardrails-section-head">
          <div>
            <h3>Repo Guardrails</h3>
            <p class="guardrails-section-copy">Enforcement points detected from project configuration. Categories are populated from ${detectedLanguages.length > 0 ? detectedLanguages.join(", ") : "package"} toolchains.</p>
          </div>
          <div class="guardrails-meta">${snapshot?.repoGuardrails?.packageName || (detectedLanguages.length > 0 ? detectedLanguages[0] + " project" : "No project metadata")}</div>
        </div>

        <div class="guardrails-category-grid">
          ${Object.entries(repoCategories).map(([key, category]) => html`
            <div class="guardrails-category-card" key=${key}>
              <div class="guardrails-pill ${category?.detected ? "good" : "bad"}">${category?.detected ? "Detected" : "Missing"}</div>
              <h4>${key}</h4>
              <p>${category?.detected ? `${Array.isArray(category?.scripts) ? category.scripts.length : 0} command(s) found.` : "No enforcement detected for this layer."}</p>
            </div>
          `)}
        </div>

        <div class="guardrails-script-list">
          ${Object.entries(repoCategories).flatMap(([key, category]) => {
            const scripts = Array.isArray(category?.scripts) ? category.scripts : [];
            if (scripts.length === 0) {
              return [html`<div class="guardrails-script" key=${`${key}-empty`}>
                <div class="guardrails-script-name">${key}</div>
                <div class="guardrails-script-cmd">No commands detected for this category.</div>
              </div>`];
            }
            return scripts.map((script) => html`
              <div class="guardrails-script" key=${`${key}-${script.name}`}>
                <div class="guardrails-script-name">${key} · ${script.name}</div>
                <div class="guardrails-script-cmd">${script.command}</div>
              </div>
            `);
          })}
        </div>
      </section>

      <section class="guardrails-section">
        <div class="guardrails-section-head">
          <div>
            <h3>INPUT Policy</h3>
            <p class="guardrails-section-copy">Define the minimum signal Bosun requires before it accepts a task or manual-flow request.</p>
          </div>
          <div class="guardrails-meta">${policyPath || "No policy file detected yet"}</div>
        </div>

        <div class="guardrails-toggle-card">
          <div class="guardrails-toggle-top">
            <div>
              <h4>Enforce Input Quality</h4>
              <p>Block thin, repetitive, or low-context requests before they create unreliable agent work.</p>
            </div>
            ${renderToggle(policyDraft.enabled === true, () => setPolicyDraft((current) => ({ ...current, enabled: !(current.enabled === true) })), policySaving)}
          </div>
          <div class="guardrails-meta">Warn at ${policyDraft.warnThreshold}, block at ${policyDraft.blockThreshold}. Updated ${updatedAt ? formatRelative(updatedAt) : "by default policy"}.</div>
        </div>

        <div class="guardrails-form-grid">
          <div class="guardrails-field">
            <label>Warn threshold</label>
            <input type="number" min="1" max="100" value=${policyDraft.warnThreshold} onInput=${(event) => setPolicyDraft((current) => ({ ...current, warnThreshold: event.currentTarget.value }))} />
          </div>
          <div class="guardrails-field">
            <label>Block threshold</label>
            <input type="number" min="0" max="100" value=${policyDraft.blockThreshold} onInput=${(event) => setPolicyDraft((current) => ({ ...current, blockThreshold: event.currentTarget.value }))} />
          </div>
          <div class="guardrails-field">
            <label>Min title length</label>
            <input type="number" min="0" value=${policyDraft.minTitleLength} onInput=${(event) => setPolicyDraft((current) => ({ ...current, minTitleLength: event.currentTarget.value }))} />
          </div>
          <div class="guardrails-field">
            <label>Min description length</label>
            <input type="number" min="0" value=${policyDraft.minDescriptionLength} onInput=${(event) => setPolicyDraft((current) => ({ ...current, minDescriptionLength: event.currentTarget.value }))} />
          </div>
          <div class="guardrails-field">
            <label>Min context fields</label>
            <input type="number" min="0" value=${policyDraft.minContextFields} onInput=${(event) => setPolicyDraft((current) => ({ ...current, minContextFields: event.currentTarget.value }))} />
          </div>
          <div class="guardrails-field">
            <label>Min combined tokens</label>
            <input type="number" min="0" value=${policyDraft.minCombinedTokens} onInput=${(event) => setPolicyDraft((current) => ({ ...current, minCombinedTokens: event.currentTarget.value }))} />
          </div>
        </div>

        <div class="guardrails-form-actions">
          <button class="guardrails-btn" onClick=${() => setPolicyDraft(normalizePolicy(snapshot?.INPUT?.policy))} disabled=${policySaving}>Reset</button>
          <button class="guardrails-btn primary" onClick=${savePolicy} disabled=${policySaving}>${policySaving ? "Saving..." : "Save INPUT policy"}</button>
        </div>
      </section>

      <section class="guardrails-section">
        <div class="guardrails-section-head">
          <div>
            <h3>Input Quality Sandbox</h3>
            <p class="guardrails-section-copy">Test the active INPUT thresholds against a task-shaped payload before operators turn the policy loose.</p>
          </div>
        </div>

        <div class="guardrails-form-grid">
          <div class="guardrails-field">
            <label>Title</label>
            <input value=${assessmentInput.title} onInput=${(event) => setAssessmentInput((current) => ({ ...current, title: event.currentTarget.value }))} placeholder="Add a specific task title" />
          </div>
          <div class="guardrails-field">
            <label>Project</label>
            <input value=${assessmentInput.metadataProject} onInput=${(event) => setAssessmentInput((current) => ({ ...current, metadataProject: event.currentTarget.value }))} placeholder="Optional project identifier" />
          </div>
          <div class="guardrails-field">
            <label>Workspace</label>
            <input value=${assessmentInput.metadataWorkspace} onInput=${(event) => setAssessmentInput((current) => ({ ...current, metadataWorkspace: event.currentTarget.value }))} placeholder="Workspace or repository" />
          </div>
          <div class="guardrails-field">
            <label>Tags</label>
            <input value=${assessmentInput.metadataTags} onInput=${(event) => setAssessmentInput((current) => ({ ...current, metadataTags: event.currentTarget.value }))} placeholder="Comma-separated tags" />
          </div>
        </div>
        <div class="guardrails-field">
          <label>Description</label>
          <textarea value=${assessmentInput.description} onInput=${(event) => setAssessmentInput((current) => ({ ...current, description: event.currentTarget.value }))} placeholder="Describe scope, key files, constraints, and acceptance checks"></textarea>
        </div>
        <div class="guardrails-form-actions">
          <button class="guardrails-btn primary" onClick=${runAssessment} disabled=${assessmentBusy}>${assessmentBusy ? "Assessing..." : "Run assessment"}</button>
        </div>

        ${assessmentResult ? html`
          <div class="guardrails-assessment">
            <div class="guardrails-assessment-score">
              <div class="guardrails-score-ring ${scoreTone(assessmentResult.score)}">${formatScore(assessmentResult.score)}</div>
              <div>
                <div class="guardrails-pill ${assessmentResult.blocked ? "bad" : assessmentResult.status === "warn" ? "warn" : "good"}">${assessmentResult.status || "ok"}</div>
                <div class="guardrails-meta" style="margin-top:8px;">${assessmentResult.summary || "No summary returned."}</div>
              </div>
            </div>
            <div class="guardrails-grid" style="margin-top:12px;">
              <div class="guardrails-stat">
                <div class="guardrails-stat-label">Title length</div>
                <div class="guardrails-stat-value">${assessmentResult?.metrics?.titleLength ?? 0}</div>
              </div>
              <div class="guardrails-stat">
                <div class="guardrails-stat-label">Description length</div>
                <div class="guardrails-stat-value">${assessmentResult?.metrics?.descriptionLength ?? 0}</div>
              </div>
              <div class="guardrails-stat">
                <div class="guardrails-stat-label">Context fields</div>
                <div class="guardrails-stat-value">${assessmentResult?.metrics?.contextFieldCount ?? 0}</div>
              </div>
              <div class="guardrails-stat">
                <div class="guardrails-stat-label">Token count</div>
                <div class="guardrails-stat-value">${assessmentResult?.metrics?.tokenCount ?? 0}</div>
              </div>
            </div>
            ${Array.isArray(assessmentResult?.findings) && assessmentResult.findings.length > 0 ? html`
              <ul class="guardrails-warning-list" style="margin-top:12px;">
                ${assessmentResult.findings.map((finding) => html`<li key=${finding.id}>${finding.message}</li>`)}
              </ul>
            ` : null}
          </div>
        ` : null}
      </section>

      <section class="guardrails-section">
        <div class="guardrails-section-head">
          <div>
            <h3>Hook Guardrails</h3>
            <p class="guardrails-section-copy">Toggle feature groups to bulk-enable hooks by category. Each hook shows which executors support it. Click Edit to customize commands.</p>
          </div>
          <div class="guardrails-meta">${snapshot?.hooks?.enabledCount ?? enabledHookIds.size} enabled · ${hookCatalog.length} total catalog hooks</div>
        </div>

        <div class="guardrails-feature-grid">
          ${Array.from(categoryMeta.entries()).map(([catId, meta]) => {
            const catHooks = (Array.isArray(hookCatalog) ? hookCatalog : []).filter((h) => h.category === catId);
            if (catHooks.length === 0) return null;
            const enabledInCat = catHooks.filter((h) => enabledHookIds.has(h.id)).length;
            const allEnabled = enabledInCat === catHooks.length;
            const someEnabled = enabledInCat > 0;
            const isBusy = categoryBusy === catId;
            return html`
              <div class="guardrails-feature-card ${someEnabled ? "active" : ""}" key=${catId}>
                <div class="guardrails-feature-card-head">
                  <h4>${meta.icon || "⚙️"} ${meta.name || catId}</h4>
                  ${renderToggle(allEnabled, () => toggleCategory(catId), isBusy)}
                </div>
                <p>${meta.description || ""}</p>
                <div class="guardrails-meta">${enabledInCat}/${catHooks.length} hooks enabled</div>
              </div>
            `;
          })}
        </div>
      </section>

      <section class="guardrails-section">
        <div class="guardrails-section-head">
          <div>
            <h3>Installed Hooks</h3>
            <p class="guardrails-section-copy">All hooks from the library. Filter by executor, status, or search. Edit commands and settings per hook.</p>
          </div>
          <div class="guardrails-pill-row">
            <button class="guardrails-btn" onClick=${loadHookControls} disabled=${hooksLoading}>
              ${hooksLoading ? "Loading..." : "Reload"}
            </button>
          </div>
        </div>

        <div class="guardrails-hook-toolbar">
          <input class="guardrails-field guardrails-hook-search" value=${hookSearch} onInput=${(event) => setHookSearch(event.currentTarget.value)} placeholder="Search hooks by name, tag, id, or category" />
          <div class="guardrails-filter-row">
            <select class="guardrails-filter-select" value=${sdkFilter} onChange=${(e) => setSdkFilter(e.currentTarget.value)}>
              <option value="">All executors</option>
              <option value="codex">Codex</option>
              <option value="copilot">Copilot</option>
              <option value="claude">Claude</option>
              <option value="gemini">Gemini</option>
              <option value="opencode">OpenCode</option>
            </select>
            <select class="guardrails-filter-select" value=${statusFilter} onChange=${(e) => setStatusFilter(e.currentTarget.value)}>
              <option value="all">All hooks</option>
              <option value="enabled">Enabled only</option>
              <option value="available">Available only</option>
            </select>
          </div>
          <div class="guardrails-meta">${hooksLoading ? "Loading hook library..." : updatedAt ? `State updated ${formatRelative(updatedAt)}` : "Hook state uses defaults until persisted."}</div>
        </div>

        ${hookGroups.size === 0 ? html`<div class="guardrails-empty">No hooks matched the current filter.</div>` : html`
          <div class="guardrails-hook-list">
            ${Array.from(hookGroups.entries()).map(([categoryId, hooks]) => {
              const meta = categoryMeta.get(categoryId) || {};
              const enabledInGroup = hooks.filter((hook) => enabledHookIds.has(hook.id)).length;
              return html`
                <div class="guardrails-hook-group" key=${categoryId}>
                  <div class="guardrails-hook-group-head">
                    <div>
                      <h4>${meta.icon || "⚙️"} ${meta.name || categoryId}</h4>
                      <div class="guardrails-meta">${meta.description || ""}</div>
                    </div>
                    <div class="guardrails-pill ${enabledInGroup > 0 ? "good" : "warn"}">${enabledInGroup}/${hooks.length} enabled</div>
                  </div>
                  <div class="guardrails-hook-items">
                    ${hooks.map((hook) => {
                      const isEnabled = enabledHookIds.has(hook.id);
                      const hasOverrides = Boolean(hookOverrides[hook.id]);
                      const isExpanded = expandedHookId === hook.id;
                      const compat = hook.compatibility || {};
                      return html`
                        <div class="guardrails-hook-item" key=${hook.id}>
                          <div>
                            <h5>${hook.name}</h5>
                            <p>${hook.description || "No description provided."}</p>
                            <div class="guardrails-hook-badges">
                              ${hook.core ? html`<span class="guardrails-hook-badge core">core</span>` : null}
                              ${hook.defaultEnabled ? html`<span class="guardrails-hook-badge">default</span>` : null}
                              ${hook.blocking ? html`<span class="guardrails-hook-badge blocking">blocking</span>` : null}
                              ${hasOverrides ? html`<span class="guardrails-hook-badge edited">edited</span>` : null}
                              ${(Array.isArray(hook.events) ? hook.events : [hook.events]).filter(Boolean).map((eventName) => html`<span class="guardrails-hook-badge" key=${`${hook.id}-${eventName}`}>${eventName}</span>`)}
                            </div>
                            <div class="guardrails-sdk-row">
                              ${Object.entries(compat).map(([sdkId, level]) => html`
                                <span class="guardrails-hook-badge sdk-${level}" key=${`${hook.id}-sdk-${sdkId}`} title="${sdkId}: ${level}">${sdkId}</span>
                              `)}
                            </div>
                          </div>
                          <div class="guardrails-hook-actions">
                            ${renderToggle(isEnabled, () => toggleHook(hook), hookBusyId === hook.id)}
                            <button class="guardrails-hook-edit-btn" onClick=${() => isExpanded ? closeHookEditor() : openHookEditor(hook)}>${isExpanded ? "Close" : "Edit"}</button>
                          </div>
                        </div>
                        ${isExpanded ? html`
                          <div class="guardrails-hook-detail" key=${`${hook.id}-detail`}>
                            <label>
                              Command
                              <textarea value=${editDraft.command || ""} onInput=${(e) => setEditDraft((d) => ({ ...d, command: e.currentTarget.value }))}></textarea>
                            </label>
                            <div class="guardrails-hook-detail-row">
                              <label>
                                Timeout (ms)
                                <input type="number" min="1000" step="1000" value=${editDraft.timeout || 60000} onInput=${(e) => setEditDraft((d) => ({ ...d, timeout: e.currentTarget.value }))} />
                              </label>
                              <label>
                                Blocking
                                ${renderToggle(editDraft.blocking === true, () => setEditDraft((d) => ({ ...d, blocking: !d.blocking })))}
                              </label>
                            </div>
                            ${hook.requires ? html`<div class="guardrails-meta">Requires: ${hook.requires}</div>` : null}
                            ${hook.disableWarning ? html`<div class="guardrails-meta" style="color: #fca5a5;">⚠ ${hook.disableWarning}</div>` : null}
                            <div class="guardrails-hook-detail-actions">
                              ${hasOverrides ? html`<button class="guardrails-btn" onClick=${() => revertHookEdit(hook.id)} disabled=${editSaving}>Revert to defaults</button>` : null}
                              <button class="guardrails-btn" onClick=${closeHookEditor}>Cancel</button>
                              <button class="guardrails-btn primary" onClick=${() => saveHookEdit(hook.id)} disabled=${editSaving}>${editSaving ? "Saving..." : "Save"}</button>
                            </div>
                          </div>
                        ` : null}
                      `;
                    })}
                  </div>
                </div>
              `;
            })}
          </div>
        `}
      </section>
    </div>
  `;
}