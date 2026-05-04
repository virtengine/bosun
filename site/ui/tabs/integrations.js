import { h } from "preact";
import { useState, useEffect, useCallback } from "preact/hooks";
import htm from "htm";
import { apiFetch } from "../../../ui/modules/api.js";
import { showToast } from "../../../ui/modules/state.js";
import { formatBytes, formatDuration, formatRelative } from "../../../ui/modules/utils.js";

const html = htm.bind(h);
const S = {
  page: { padding: "16px", maxWidth: "1200px", margin: "0 auto" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "14px" },
  columns: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "24px", alignItems: "start" },
  card: { background: "var(--tg-theme-secondary-bg-color, #1e1e1e)", borderRadius: "12px", padding: "14px" },
  row: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" },
  btn: { padding: "5px 12px", borderRadius: "8px", border: "none", cursor: "pointer", fontSize: "12px", fontWeight: 500, background: "var(--tg-theme-button-color, #3390ec)", color: "var(--tg-theme-button-text-color, #fff)" },
  ghost: { padding: "5px 12px", borderRadius: "8px", border: "1px solid var(--tg-theme-hint-color, #555)", cursor: "pointer", fontSize: "12px", fontWeight: 500, background: "transparent", color: "var(--tg-theme-text-color, #eee)" },
  danger: { padding: "5px 12px", borderRadius: "8px", border: "none", cursor: "pointer", fontSize: "12px", fontWeight: 500, background: "rgba(255,80,80,0.18)", color: "#ff5050" },
  chip: { display: "inline-block", background: "rgba(51,144,236,0.15)", color: "#3390ec", borderRadius: "999px", padding: "3px 8px", fontSize: "11px", marginRight: "6px" },
  title: { fontSize: "13px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--tg-theme-hint-color, #888)", marginBottom: "12px" },
  empty: { textAlign: "center", color: "var(--tg-theme-hint-color, #888)", fontSize: "13px", padding: "24px 0" },
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" },
  modal: { background: "var(--tg-theme-bg-color, #181818)", borderRadius: "14px", padding: "20px", width: "100%", maxWidth: "420px", maxHeight: "85vh", overflowY: "auto" },
  input: { width: "100%", boxSizing: "border-box", padding: "8px 10px", borderRadius: "8px", border: "1px solid var(--tg-theme-hint-color, #444)", background: "var(--tg-theme-secondary-bg-color, #1e1e1e)", color: "var(--tg-theme-text-color, #eee)", fontSize: "13px" },
};

const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const text = (v, d = "") => `${v || ""}`.trim() || d;
const ts = (v) => { const n = Number(v); if (Number.isFinite(n) && n > 0) return n; const p = Date.parse(String(v || "")); return Number.isFinite(p) ? p : 0; };
const clip = (v, n = 52) => { const t = text(v); return !t || t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`; };
const sessionLabel = (s) => clip(s?.taskTitle || s?.metadata?.taskTitle || s?.taskId || s?.metadata?.prompt || s?.id || s?.type || "Session");
const sessionBucket = (status) => ["active", "running", "inprogress", "working"].includes(text(status).toLowerCase()) ? "active"
  : ["paused", "waiting"].includes(text(status).toLowerCase()) ? "paused"
  : ["failed", "error", "blocked", "cancelled"].includes(text(status).toLowerCase()) ? "failed"
  : ["completed", "done", "archived"].includes(text(status).toLowerCase()) ? "completed" : "other";

export function summarizeOperatorSessions(sessions = []) {
  const counts = { total: 0, active: 0, paused: 0, failed: 0, completed: 0, other: 0 };
  for (const s of arr(sessions)) { counts.total += 1; counts[sessionBucket(s?.status)] += 1; }
  const recent = arr(sessions).slice().sort((a, b) => ts(b?.updatedAt || b?.endedAt || b?.startedAt || b?.createdAt) - ts(a?.updatedAt || a?.endedAt || a?.startedAt || a?.createdAt)).slice(0, 6).map((s) => ({ id: text(s?.id), status: text(s?.status, "unknown"), type: text(s?.type, "session"), label: sessionLabel(s), workspaceId: text(s?.metadata?.workspaceId || s?.workspaceId), timestamp: s?.updatedAt || s?.endedAt || s?.startedAt || s?.createdAt || null }));
  return { counts, recent };
}

export function summarizeIntegrationCoverage(integrations = [], secrets = []) {
  const byId = new Map(arr(integrations).map((i) => [text(i?.id), { id: text(i?.id), name: text(i?.name, text(i?.id)), icon: text(i?.icon, "🔌"), secretCount: 0, permissionCount: 0 }]));
  for (const s of arr(secrets)) {
    const id = text(s?.integration);
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, { id, name: id, icon: "🔌", secretCount: 0, permissionCount: 0 });
    const stats = byId.get(id);
    stats.secretCount += 1;
    stats.permissionCount += arr(s?.permissions?.agents).length + arr(s?.permissions?.workflows).length;
  }
  const items = [...byId.values()].sort((a, b) => b.secretCount - a.secretCount || b.permissionCount - a.permissionCount || a.name.localeCompare(b.name));
  return { totalIntegrations: items.length, configuredIntegrations: items.filter((i) => i.secretCount > 0).length, totalSecrets: arr(secrets).length, items };
}

export function buildOperatorVisibilityModel({ telemetrySummary = null, auditPayload = null, sessions = [], integrations = [], secrets = [] } = {}) {
  const lifetime = telemetrySummary?.lifetimeTotals || {};
  const contention = telemetrySummary?.repoAreaContention || {};
  const audit = auditPayload?.summary || {};
  return {
    runtime: { attemptCount: num(lifetime?.attemptsCount), tokenCount: num(lifetime?.tokenCount), durationMs: num(lifetime?.durationMs), repoAreaContention: { totalEvents: num(contention?.totalEvents), totalWaitMs: num(contention?.totalWaitMs), hotAreas: arr(contention?.hotAreas).slice(0, 4) } },
    sessions: summarizeOperatorSessions(sessions),
    integrations: summarizeIntegrationCoverage(integrations, secrets),
    audit: {
      taskCount: num(audit?.taskCount), failedTaskCount: num(audit?.failedTaskCount), recentEventCount: num(audit?.recentEventCount), latestEventAt: audit?.latestEventAt || null,
      attentionTasks: arr(auditPayload?.tasks).slice().sort((a, b) => (num(b?.failedRunCount || b?.eventCount) - num(a?.failedRunCount || a?.eventCount)) || (ts(b?.latestEventAt) - ts(a?.latestEventAt))).slice(0, 4).map((e) => ({ taskId: text(e?.taskId), title: text(e?.taskTitle || e?.title || e?.taskId, "Task"), status: text(e?.status, "unknown"), latestEventAt: e?.latestEventAt || null, eventCount: num(e?.eventCount), failedRunCount: num(e?.failedRunCount) })),
      recentEvents: arr(auditPayload?.recentEvents).slice(0, 4).map((e) => ({ auditType: text(e?.auditType || e?.eventType, "audit"), summary: text(e?.summary || e?.eventType || e?.auditType, "Audit event"), timestamp: e?.timestamp || null, taskId: text(e?.taskId) })),
    },
  };
}

function Modal({ title, children, onClose }) { return html`<div style=${S.overlay} onClick=${(e) => e.target === e.currentTarget && onClose()}><div style=${S.modal}><div style=${{ fontSize: "16px", fontWeight: 700, marginBottom: "16px" }}>${title}</div>${children}</div></div>`; }
function Perms({ permissions }) { return html`<div style=${{ ...S.card, padding: "10px 12px", marginTop: "6px" }}><div><strong>Agents:</strong> ${arr(permissions?.agents).length ? arr(permissions?.agents).map((v) => html`<span style=${S.chip}>${v}</span>`) : html`<em style=${{ color: "#888" }}>none</em>`}</div><div><strong>Workflows:</strong> ${arr(permissions?.workflows).length ? arr(permissions?.workflows).map((v) => html`<span style=${S.chip}>${v}</span>`) : html`<em style=${{ color: "#888" }}>none</em>`}</div></div>`; }

function AddSecretModal({ integration, onClose, onSaved }) {
  const [name, setName] = useState(""); const [label, setLabel] = useState(""); const [fields, setFields] = useState({}); const [saving, setSaving] = useState(false);
  const save = async () => { if (!name.trim()) return showToast("Name is required", "error"); setSaving(true); const { ok, error } = await apiFetch("/api/vault/secrets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim(), integration: integration.id, label: label.trim() || undefined, fields }) }); setSaving(false); if (!ok) return showToast(error || "Failed to save secret", "error"); showToast("Secret saved", "success"); onSaved(); };
  return html`<${Modal} title=${`Add ${integration.name}`} onClose=${onClose}>
    <div style=${{ display: "grid", gap: "12px" }}>
      <input style=${S.input} value=${name} placeholder="Name *" onInput=${(e) => setName(e.target.value)} />
      <input style=${S.input} value=${label} placeholder="Label" onInput=${(e) => setLabel(e.target.value)} />
      ${arr(integration.fields).map((f) => html`<div key=${f.id}><input style=${S.input} type=${f.type === "password" ? "password" : f.type === "url" ? "url" : "text"} value=${fields[f.id] || ""} placeholder=${f.label} onInput=${(e) => setFields((p) => ({ ...p, [f.id]: e.target.value }))} />${f.helpText ? html`<div style=${{ fontSize: "11px", color: "#888", marginTop: "3px" }}>${f.helpText}</div>` : ""}</div>`)}
      <div style=${S.row}><button style=${S.btn} onClick=${save} disabled=${saving}>${saving ? "Saving…" : "Save Secret"}</button><button style=${S.ghost} onClick=${onClose}>Cancel</button></div>
    </div>
  <//>`;
}

function AddEnvModal({ onClose, onSaved }) {
  const [key, setKey] = useState(""); const [value, setValue] = useState(""); const [saving, setSaving] = useState(false);
  const save = async () => { if (!key.trim()) return showToast("Key is required", "error"); setSaving(true); const { ok, error } = await apiFetch("/api/vault/env", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: key.trim(), value }) }); setSaving(false); if (!ok) return showToast(error || "Failed to save env var", "error"); showToast("Env var saved", "success"); onSaved(); };
  return html`<${Modal} title="Add Environment Variable" onClose=${onClose}><div style=${{ display: "grid", gap: "12px" }}><input style=${S.input} value=${key} placeholder="Key *" onInput=${(e) => setKey(e.target.value)} /><input style=${S.input} type="password" value=${value} placeholder="Value" onInput=${(e) => setValue(e.target.value)} /><div style=${S.row}><button style=${S.btn} onClick=${save} disabled=${saving}>${saving ? "Saving…" : "Add Variable"}</button><button style=${S.ghost} onClick=${onClose}>Cancel</button></div></div><//>`;
}

function EnvVarsSection() {
  const [open, setOpen] = useState(false); const [keys, setKeys] = useState([]); const [loading, setLoading] = useState(false); const [showModal, setShowModal] = useState(false);
  const load = useCallback(async () => { setLoading(true); const { ok, data } = await apiFetch("/api/vault/env"); setLoading(false); if (ok) setKeys(data?.keys || []); }, []);
  useEffect(() => { if (open && keys.length === 0) load(); }, [open, keys.length, load]);
  const del = async (key) => { if (!confirm(`Delete env var "${key}"?`)) return; const { ok, error } = await apiFetch(`/api/vault/env/${encodeURIComponent(key)}`, { method: "DELETE" }); if (!ok) return showToast(error || "Failed to delete", "error"); showToast(`Deleted ${key}`, "success"); setKeys((prev) => prev.filter((v) => v !== key)); };
  return html`<div style=${{ marginTop: "20px" }}><div style=${{ ...S.row, cursor: "pointer", padding: "8px 0" }} onClick=${() => setOpen((v) => !v)}><span style=${S.title}>📋 Environment Variables</span><span>${open ? "▾" : "▸"}</span></div>${open ? html`<div><div style=${{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "10px" }}><button style=${S.btn} onClick=${() => setShowModal(true)}>+ Add Env Var</button><button style=${S.ghost} onClick=${load}>Refresh</button></div>${loading ? html`<div style=${S.empty}>Loading…</div>` : keys.length === 0 ? html`<div style=${S.empty}>No environment variables stored</div>` : keys.map((key) => html`<div style=${{ ...S.card, marginBottom: "6px", display: "flex", justifyContent: "space-between", gap: "10px" }} key=${key}><div><div style=${{ fontWeight: 600, fontSize: "14px" }}>${key}</div><div style=${{ fontSize: "12px", color: "#888" }}>value hidden for security</div></div><button style=${S.danger} onClick=${() => del(key)}>Delete</button></div>`)}</div>` : ""}${showModal ? html`<${AddEnvModal} onClose=${() => setShowModal(false)} onSaved=${() => { setShowModal(false); load(); }} />` : ""}</div>`;
}

function OperatorSignals({ model, loading, onRefresh }) {
  const runtime = model.runtime || {}; const sessions = model.sessions || { counts: {}, recent: [] }; const audit = model.audit || {}; const coverage = model.integrations || {};
  return html`<div style=${{ marginBottom: "22px" }}><div style=${S.row}><div><div style=${S.title}>Operator Visibility</div><div style=${{ fontSize: "12px", color: "#888" }}>Live sessions, audit pressure, runtime contention, and vault coverage in one place.</div></div><button style=${S.ghost} onClick=${onRefresh} disabled=${loading}>${loading ? "Refreshing…" : "Refresh Signals"}</button></div><div style=${S.grid}>
    <div style=${S.card}><div style=${{ fontSize: "14px", fontWeight: 700 }}>Runtime Pressure</div><div style=${{ fontSize: "22px", fontWeight: 800, margin: "6px 0" }}>${runtime.attemptCount || 0}</div><div style=${{ fontSize: "12px", color: "#9ca3af" }}>lifetime attempts · ${formatBytes(runtime.tokenCount || 0)} tokens · ${formatDuration(runtime.durationMs || 0)}</div><div style=${{ marginTop: "8px" }}><span style=${S.chip}>${num(runtime?.repoAreaContention?.totalEvents)} contention events</span><span style=${S.chip}>${formatDuration(num(runtime?.repoAreaContention?.totalWaitMs))} blocked</span></div>${arr(runtime?.repoAreaContention?.hotAreas).slice(0, 3).map((e) => html`<div style=${{ marginTop: "8px", fontSize: "12px" }} key=${e.area}><b>${text(e?.area, "workspace")}</b> · ${num(e?.events)} events · ${num(e?.waitingTasks)} waiting</div>`)}${arr(runtime?.repoAreaContention?.hotAreas).length === 0 ? html`<div style=${{ marginTop: "8px", fontSize: "12px", color: "#888" }}>No repo-area contention hotspots recorded.</div>` : ""}</div>
    <div style=${S.card}><div style=${{ fontSize: "14px", fontWeight: 700 }}>Live Sessions</div><div style=${{ fontSize: "22px", fontWeight: 800, margin: "6px 0" }}>${num(sessions?.counts?.active)}</div><div style=${{ fontSize: "12px", color: "#9ca3af" }}>active now · ${num(sessions?.counts?.paused)} paused · ${num(sessions?.counts?.failed)} failed · ${num(sessions?.counts?.completed)} completed</div>${arr(sessions?.recent).map((e) => html`<div style=${{ marginTop: "8px", fontSize: "12px" }} key=${e.id || e.label}><b>${e.label}</b><div style=${{ color: "#888" }}>${e.status} · ${e.type}${e.workspaceId ? ` · workspace ${e.workspaceId}` : ""}${e.timestamp ? ` · ${formatRelative(e.timestamp)}` : ""}</div></div>`)}${arr(sessions?.recent).length === 0 ? html`<div style=${{ marginTop: "8px", fontSize: "12px", color: "#888" }}>No recent agent sessions recorded.</div>` : ""}</div>
    <div style=${S.card}><div style=${{ fontSize: "14px", fontWeight: 700 }}>Audit Trail</div><div style=${{ fontSize: "22px", fontWeight: 800, margin: "6px 0" }}>${num(audit.failedTaskCount)}</div><div style=${{ fontSize: "12px", color: "#9ca3af" }}>tasks needing attention · ${num(audit.taskCount)} tracked · ${num(audit.recentEventCount)} recent events</div><div style=${{ marginTop: "8px" }}><span style=${S.chip}>latest ${audit.latestEventAt ? formatRelative(audit.latestEventAt) : "—"}</span></div>${arr(audit.attentionTasks).map((e) => html`<div style=${{ marginTop: "8px", fontSize: "12px" }} key=${e.taskId || e.title}><b>${e.title}</b><div style=${{ color: "#888" }}>${e.status} · ${e.eventCount} events${e.failedRunCount ? ` · ${e.failedRunCount} failed runs` : ""}</div></div>`)}${arr(audit.attentionTasks).length === 0 ? arr(audit.recentEvents).map((e, i) => html`<div style=${{ marginTop: "8px", fontSize: "12px" }} key=${`${e.auditType}-${i}`}><b>${e.summary}</b><div style=${{ color: "#888" }}>${e.auditType}${e.taskId ? ` · ${e.taskId}` : ""}</div></div>`) : ""}${arr(audit.attentionTasks).length === 0 && arr(audit.recentEvents).length === 0 ? html`<div style=${{ marginTop: "8px", fontSize: "12px", color: "#888" }}>No recent audit activity recorded for the active workspace.</div>` : ""}</div>
    <div style=${S.card}><div style=${{ fontSize: "14px", fontWeight: 700 }}>Coverage</div><div style=${{ fontSize: "22px", fontWeight: 800, margin: "6px 0" }}>${num(coverage.configuredIntegrations)}/${num(coverage.totalIntegrations)}</div><div style=${{ fontSize: "12px", color: "#9ca3af" }}>integrations configured · ${num(coverage.totalSecrets)} secrets loaded</div>${arr(coverage.items).slice(0, 4).map((e) => html`<div style=${{ marginTop: "8px", fontSize: "12px" }} key=${e.id}><b>${e.icon || "🔌"} ${e.name}</b><div style=${{ color: "#888" }}>${num(e.secretCount)} secrets · ${num(e.permissionCount)} permissions</div></div>`)}${arr(coverage.items).length === 0 ? html`<div style=${{ marginTop: "8px", fontSize: "12px", color: "#888" }}>No integration catalog loaded yet.</div>` : ""}</div>
  </div></div>`;
}

export function IntegrationsTab() {
  const [vaultReady, setVaultReady] = useState(null); const [integrations, setIntegrations] = useState([]); const [secrets, setSecrets] = useState([]); const [addTarget, setAddTarget] = useState(null);
  const [signalsLoading, setSignalsLoading] = useState(false); const [telemetrySummary, setTelemetrySummary] = useState(null); const [auditSnapshot, setAuditSnapshot] = useState({ summary: null, tasks: [], recentEvents: [] }); const [sessions, setSessions] = useState([]);
  const loadStatus = useCallback(async () => { try { const { ok, data } = await apiFetch("/api/vault/status", { _silent: true }); setVaultReady(Boolean(ok && data?.initialized !== false)); } catch { setVaultReady(false); } }, []);
  const loadIntegrations = useCallback(async () => { try { const { ok, data } = await apiFetch("/api/vault/integrations", { _silent: true }); if (ok) setIntegrations(data || []); } catch {} }, []);
  const loadSecrets = useCallback(async () => { try { const { ok, data } = await apiFetch("/api/vault/secrets", { _silent: true }); if (ok) setSecrets(data || []); } catch {} }, []);
  const loadOperatorSignals = useCallback(async () => { setSignalsLoading(true); try { const [telemetryRes, auditRes, sessionsRes] = await Promise.all([apiFetch("/api/telemetry/summary", { _silent: true }).catch(() => null), apiFetch("/api/audit/summary?limit=8&recentLimit=8", { _silent: true }).catch(() => null), apiFetch("/api/sessions?includeHidden=1", { _silent: true }).catch(() => null)]); if (telemetryRes?.ok !== false) setTelemetrySummary(telemetryRes?.data ?? telemetryRes ?? null); if (auditRes?.ok !== false) setAuditSnapshot({ summary: auditRes?.summary || null, tasks: arr(auditRes?.tasks), recentEvents: arr(auditRes?.recentEvents) }); if (sessionsRes?.ok !== false) setSessions(arr(sessionsRes?.sessions)); } finally { setSignalsLoading(false); } }, []);
  useEffect(() => { loadStatus(); loadOperatorSignals(); }, [loadStatus, loadOperatorSignals]);
  useEffect(() => { if (vaultReady) { loadIntegrations(); loadSecrets(); } }, [vaultReady, loadIntegrations, loadSecrets]);
  const operatorModel = buildOperatorVisibilityModel({ telemetrySummary, auditPayload: auditSnapshot, sessions, integrations, secrets });
  const coverage = summarizeIntegrationCoverage(integrations, secrets);
  if (vaultReady === null) return html`<div style=${S.page}><${OperatorSignals} model=${operatorModel} loading=${signalsLoading} onRefresh=${loadOperatorSignals} /><div style=${S.empty}>Loading vault…</div></div>`;
  if (vaultReady === false) return html`<div style=${S.page}><${OperatorSignals} model=${operatorModel} loading=${signalsLoading} onRefresh=${loadOperatorSignals} /><div style=${{ ...S.card, textAlign: "center", maxWidth: "400px", margin: "0 auto" }}><div style=${{ fontSize: "48px", marginBottom: "12px" }}>🔐</div><div style=${{ fontSize: "20px", fontWeight: 700, marginBottom: "8px" }}>Initialize Vault</div><p style=${{ fontSize: "13px", color: "#888", marginBottom: "20px" }}>The Vault securely stores secrets and credentials used by your agents and workflows. Initialize it to get started.</p><button style=${S.btn} onClick=${async () => { const { ok, error } = await apiFetch("/api/vault/init", { method: "POST" }); if (!ok) return showToast(error || "Failed to initialize vault", "error"); showToast("Vault initialized", "success"); loadStatus(); }}>Initialize Vault</button></div></div>`;
  return html`<div style=${S.page}><${OperatorSignals} model=${operatorModel} loading=${signalsLoading} onRefresh=${loadOperatorSignals} /><div style=${S.columns}>
    <div><div style=${S.title}>Available Integrations</div>${integrations.length === 0 ? html`<div style=${S.empty}>No integrations available</div>` : integrations.map((i) => html`<div style=${{ ...S.card, display: "flex", gap: "12px" }} key=${i.id}><div style=${{ fontSize: "24px", width: "36px", textAlign: "center" }}>${i.icon || "🔌"}</div><div style=${{ flex: 1 }}><div style=${{ fontWeight: 600, fontSize: "14px" }}>${i.name}</div><div style=${{ fontSize: "12px", color: "#888", marginBottom: "6px" }}>${i.description || ""}</div><div><span style=${S.chip}>${num(coverage.items.find((e) => e.id === i.id)?.secretCount)} secrets</span><span style=${S.chip}>${num(coverage.items.find((e) => e.id === i.id)?.permissionCount)} permissions</span></div><div style=${{ marginTop: "8px" }}><button style=${S.btn} onClick=${() => setAddTarget(i)}>+ Add</button></div></div></div>`)}</div>
    <div><div style=${S.title}>Saved Secrets</div>${secrets.length === 0 ? html`<div style=${S.empty}>No secrets saved yet</div>` : secrets.map((s) => html`<div style=${{ ...S.card, display: "flex", gap: "12px" }} key=${s.id}><div style=${{ fontSize: "24px", width: "36px", textAlign: "center" }}>${integrations.find((i) => i.id === s.integration)?.icon || "🔑"}</div><div style=${{ flex: 1 }}><div style=${{ fontWeight: 600, fontSize: "14px" }}>${s.name}</div><div style=${{ fontSize: "12px", color: "#888", marginBottom: "6px" }}>${s.label ? `${s.label} · ` : ""}${s.integration || "unknown"}</div><div style=${{ display: "flex", gap: "6px", flexWrap: "wrap" }}><button style=${S.ghost} onClick=${() => setSecrets((prev) => prev.map((x) => x.id === s.id ? { ...x, _showPerms: !x._showPerms } : x))}>🔒 Permissions</button><button style=${S.danger} onClick=${async () => { if (!confirm(`Delete secret "${s.name}"?`)) return; const { ok, error } = await apiFetch(`/api/vault/secrets/${s.id}`, { method: "DELETE" }); if (!ok) return showToast(error || "Failed to delete", "error"); showToast("Secret deleted", "success"); setSecrets((prev) => prev.filter((x) => x.id !== s.id)); }}>Delete</button></div>${s._showPerms ? html`<${Perms} permissions=${s.permissions} />` : ""}</div></div>`)}<${EnvVarsSection} /></div>
  </div>${addTarget ? html`<${AddSecretModal} integration=${addTarget} onClose=${() => setAddTarget(null)} onSaved=${() => { setAddTarget(null); loadSecrets(); }} />` : ""}</div>`;
}
