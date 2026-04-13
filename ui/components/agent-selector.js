/* ─────────────────────────────────────────────────────────────
 *  VirtEngine Control Center – Agent Selector
 *  Agent mode selector, model/adapter picker, status badge
 *  Sits in the chat input toolbar area (VS Code Copilot-style)
 *  MUI Material edition
 * ────────────────────────────────────────────────────────────── */

import { h } from "preact";
import {
  useState,
  useEffect,
  useRef,
  useCallback,
} from "preact/hooks";
import { signal, computed, effect } from "@preact/signals";
import htm from "htm";
import { apiFetch } from "../modules/api.js";
import { worktreeData, loadWorktrees } from "../modules/state.js";
import { haptic } from "../modules/telegram.js";
import { resolveIcon } from "../modules/icon-utils.js";
import {
  aliveAgentCount,
  staleAgentCount,
  totalErrorCount,
} from "../modules/agent-events.js";
import {
  ToggleButton,
  ToggleButtonGroup,
  Menu,
  MenuItem,
  Select,
  Switch,
  FormControlLabel,
  Chip,
  Typography,
  Box,
  Stack,
  IconButton,
  Tooltip,
  Divider,
  ListItemIcon,
  ListItemText,
  Badge,
} from "@mui/material";

const html = htm.bind(h);

/* ═══════════════════════════════════════════════
 *  Signals
 * ═══════════════════════════════════════════════ */

/** Current agent interaction mode */
export const agentMode = signal("ask"); // "ask" | "agent" | "plan" | "web" | "instant"

/** Available agents loaded from API */
export const availableAgents = signal([]); // Array<{ id, name, provider, available, busy, capabilities }>
export const manualAgents = signal([]);

/** Currently active agent adapter id */
export const activeAgent = signal("codex-sdk");
export const activeManualAgentId = signal("");

/** Whether agent data is currently loading */
export const agentSelectorLoading = signal(false);

/** Agent runtime status (set externally or via WS events) */
export const agentStatus = signal("idle"); // "idle" | "thinking" | "executing" | "streaming"

/** Yolo (auto-approve) mode — skips confirmation prompts in supported agents */
export const yoloMode = signal(false);
// Hydrate from localStorage in browser
try { if (typeof localStorage !== "undefined") yoloMode.value = localStorage.getItem("ve-yolo-mode") === "true"; } catch {}

/** Selected model override — empty string means "default" */
export const selectedModel = signal("");
try { if (typeof localStorage !== "undefined") selectedModel.value = localStorage.getItem("ve-selected-model") || ""; } catch {}
try { if (typeof localStorage !== "undefined") activeManualAgentId.value = localStorage.getItem("ve-active-manual-agent") || ""; } catch {}

/** Agent run context — "workspace" = parent workspace dir, "worktree" = specific repo/worktree */
export const agentRunMode = signal("workspace"); // "workspace" | "worktree"
try { if (typeof localStorage !== "undefined") agentRunMode.value = localStorage.getItem("ve-agent-run-mode") || "workspace"; } catch {}

/** Selected repo/worktree path for agent execution (empty = use workspace default) */
export const selectedRepo = signal("");
try { if (typeof localStorage !== "undefined") selectedRepo.value = localStorage.getItem("ve-selected-repo") || ""; } catch {}

/** Computed: resolved active agent object */
export const activeAgentInfo = computed(() => {
  const agents = availableAgents.value;
  const id = activeAgent.value;
  return agents.find((a) => a.id === id) || null;
});

/* ═══════════════════════════════════════════════
 *  Constants
 * ═══════════════════════════════════════════════ */

const MODES = [
  { id: "ask", label: "Ask", icon: "chat", description: "Ask a question" },
  { id: "agent", label: "Agent", icon: "bot", description: "Autonomous agent" },
  { id: "plan", label: "Plan", icon: "clipboard", description: "Create a plan first" },
  { id: "web", label: "Web", icon: "globe", description: "Web-style quick answers" },
  { id: "instant", label: "Instant", icon: "zap", description: "Fast back-and-forth" },
];

const VALID_MANUAL_MODES = new Set(MODES.map((mode) => mode.id));

const AGENT_ICONS = {
  "codex-sdk": "zap",
  "copilot-sdk": "bot",
  "claude-sdk": "cpu",
};

// Mirrors EXECUTOR_MODEL_REGISTRY in task-complexity.mjs — keep in sync
const AGENT_MODELS = {
  "codex-sdk": [
    { value: "", label: "Default" },
    { value: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
    { value: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
    { value: "gpt-5.1-codex", label: "GPT-5.1 Codex" },
    { value: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini" },
    { value: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max" },
  ],
  "copilot-sdk": [
    { value: "", label: "Default" },
    { value: "claude-opus-4.6", label: "Claude Opus 4.6" },
    { value: "claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
    { value: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
    { value: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
    { value: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
    { value: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
    { value: "gpt-5.1-codex", label: "GPT-5.1 Codex" },
    { value: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini" },
  ],
  "claude-sdk": [
    { value: "", label: "Default" },
    { value: "claude-opus-4.6", label: "Claude Opus 4.6" },
    { value: "claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
    { value: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
    { value: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
    { value: "claude-code", label: "Claude Code" },
  ],
};

const PROVIDER_COLORS = {
  openai: "#10a37f",
  github: "#8b5cf6",
  anthropic: "#d97706",
};

/** Clean display names for the three fixed executor IDs */
const EXECUTOR_DISPLAY_NAMES = {
  "codex-sdk":   "Codex",
  "copilot-sdk": "Copilot",
  "claude-sdk":  "Claude",
};

/**
 * Convert a model string like "gpt-5.3-codex" → "GPT-5.3 Codex"
 * or "claude-opus-4.6" → "Claude Opus 4.6"
 */
function buildLabel(model) {
  if (!model) return "Default";
  return model
    .split("-")
    .map((seg) => {
      // Keep version segments like "4.6", "4.5", "5.1" as-is
      if (/^\d/.test(seg)) return seg;
      // Uppercase known acronyms
      if (seg.toLowerCase() === "gpt") return "GPT";
      // Title-case everything else
      return seg.charAt(0).toUpperCase() + seg.slice(1);
    })
    .join(" ");
}

const STATUS_CONFIG = {
  idle: { color: "var(--tg-theme-hint-color, #999)", label: "Ready", pulse: false },
  thinking: { color: "#eab308", label: "Thinking…", pulse: true },
  executing: { color: "#3b82f6", label: "Running…", pulse: true },
  streaming: { color: "#22c55e", label: "Streaming…", pulse: true },
};

/* ═══════════════════════════════════════════════
 *  Styles — injected once
 * ═══════════════════════════════════════════════ */

const AGENT_SELECTOR_STYLES = `
/* ── Animations (MUI can't inject these via sx) ── */
@keyframes agentDropIn {
  from { opacity: 0; transform: translateY(6px) scale(0.97); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes agentPulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%      { opacity: 0.5; transform: scale(1.35); }
}

/* ── Mode icon inside ToggleButton ── */
.mode-icon {
  font-size: 11px;
  line-height: 1;
}
.mode-icon svg {
  width: 1em;
  height: 1em;
  display: inline-block;
}

/* ── Agent status dot pulse ── */
.agent-status-dot-pulse {
  animation: agentPulse 1.4s ease-in-out infinite;
}

/* ── Chat Input Toolbar (scroll container) ── */
.chat-input-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: var(--tg-theme-secondary-bg-color, #1e1e2e);
  border-radius: 10px;
  flex-wrap: nowrap;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: none;
}
.chat-input-toolbar::-webkit-scrollbar { display: none; }

/* ── Stop Button ── */
.chat-stop-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 2px solid #ef4444;
  background: rgba(239, 68, 68, 0.12);
  color: #ef4444;
  cursor: pointer;
  font-size: 14px;
  flex-shrink: 0;
  transition: background 0.2s ease, transform 0.1s ease;
  -webkit-tap-highlight-color: transparent;
  padding: 0;
}
.chat-stop-btn:hover {
  background: rgba(239, 68, 68, 0.22);
  transform: scale(1.05);
}
.chat-stop-btn:active {
  transform: scale(0.95);
}

/* ── Split Send Button Group ── */
.chat-send-group {
  position: relative;
  display: flex;
  flex-shrink: 0;
}
.chat-send-main {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 36px;
  padding: 0 13px;
  border: none;
  border-radius: 8px 0 0 8px;
  background: var(--accent, var(--tg-theme-button-color, #3b82f6));
  color: var(--accent-text, var(--tg-theme-button-text-color, #fff));
  cursor: pointer;
  font-size: 15px;
  transition: background 0.2s ease, opacity 0.2s ease;
  -webkit-tap-highlight-color: transparent;
}
.chat-send-main:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.chat-send-main:not(:disabled):hover {
  background: var(--accent-hover, #2563eb);
}
.chat-send-chevron {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 36px;
  width: 22px;
  border: none;
  border-left: 1px solid var(--border, rgba(255,255,255,0.2));
  border-radius: 0 8px 8px 0;
  background: var(--accent, var(--tg-theme-button-color, #3b82f6));
  color: var(--accent-text, rgba(255,255,255,0.85));
  cursor: pointer;
  font-size: 10px;
  transition: background 0.2s ease, opacity 0.2s ease;
  -webkit-tap-highlight-color: transparent;
  padding: 0;
}
.chat-send-chevron:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.chat-send-chevron:not(:disabled):hover {
  background: var(--accent-hover, #2563eb);
  color: var(--accent-text, #fff);
}

/* ── Send Options Dropdown ── */
.chat-send-menu {
  position: absolute;
  bottom: calc(100% + 6px);
  right: 0;
  min-width: 230px;
  background: var(--tg-theme-bg-color, #0f0f23);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  backdrop-filter: blur(16px);
  padding: 4px;
  z-index: 1010;
  animation: agentDropIn 0.15s ease-out;
  overflow: hidden;
}
.chat-send-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  width: 100%;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--tg-theme-text-color, #fff);
  cursor: pointer;
  font-size: 13px;
  text-align: left;
  transition: background 0.15s ease;
  -webkit-tap-highlight-color: transparent;
  line-height: 1.2;
}
.chat-send-menu-item:hover {
  background: rgba(255,255,255,0.07);
}
.chat-send-menu-item.active {
  background: rgba(59,130,246,0.15);
  color: #93c5fd;
}
.chat-send-menu-item-icon {
  font-size: 14px;
  width: 18px;
  text-align: center;
  flex-shrink: 0;
}
.chat-send-menu-item-label {
  flex: 1;
  font-weight: 500;
}
.chat-send-menu-item-kbd {
  display: inline-flex;
  align-items: center;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(255,255,255,0.08);
  border: 1px solid rgba(255,255,255,0.12);
  font-size: 10px;
  color: var(--tg-theme-hint-color, #999);
  font-family: monospace;
  white-space: nowrap;
  flex-shrink: 0;
}

/* ── Responsive tweaks ── */
@media (max-width: 480px) {
  .chat-input-toolbar {
    gap: 4px;
    padding: 5px 6px;
  }
}
@media (min-width: 1200px) {
  .chat-input-toolbar {
    gap: 10px;
    padding: 8px 12px;
  }
}
`;

let _agentStylesInjected = false;
function injectAgentSelectorStyles() {
  if (_agentStylesInjected) return;
  _agentStylesInjected = true;
  const el = document.createElement("style");
  el.id = "agent-selector-styles";
  el.textContent = AGENT_SELECTOR_STYLES;
  document.head.appendChild(el);
}

/* ═══════════════════════════════════════════════
 *  API Helpers
 * ═══════════════════════════════════════════════ */

/**
 * Fetch available agents from the API and populate signals.
 */
export async function loadAvailableAgents() {
  agentSelectorLoading.value = true;
  try {
    const res = await apiFetch("/api/agents/available", { _silent: true });
    const agents = Array.isArray(res) ? res : (res?.agents || res?.data || []);
    const nextManualAgents = Array.isArray(res?.manualAgents) ? res.manualAgents : [];
    const reportedActive = String(res?.active || "").trim();
    availableAgents.value = agents;
    manualAgents.value = nextManualAgents;
    // Prefer backend-reported active selection when present.
    if (reportedActive && agents.some((a) => a.id === reportedActive)) {
      activeAgent.value = reportedActive;
    } else if (agents.length > 0 && !agents.find((a) => a.id === activeAgent.value)) {
      // Otherwise keep UX predictable: pick first enabled executor, then first entry.
      const firstEnabled = agents.find((a) => a.available);
      activeAgent.value = (firstEnabled || agents[0]).id;
    }
    if (activeManualAgentId.value && !nextManualAgents.some((agent) => agent.id === activeManualAgentId.value)) {
      activeManualAgentId.value = "";
      try { localStorage.setItem("ve-active-manual-agent", ""); } catch {}
    }
  } catch (err) {
    console.warn("[agent-selector] Failed to load agents:", err);
    // Provide sensible fallback agents for offline/dev mode
    if (availableAgents.value.length === 0) {
      availableAgents.value = [
        { id: "codex-sdk", name: "Codex", provider: "openai", available: true, busy: false, models: AGENT_MODELS["codex-sdk"].map((m) => m.value).filter(Boolean), capabilities: ["agent", "plan"] },
        { id: "copilot-sdk", name: "Copilot", provider: "github", available: true, busy: false, models: AGENT_MODELS["copilot-sdk"].map((m) => m.value).filter(Boolean), capabilities: ["ask", "agent", "plan"] },
        { id: "claude-sdk", name: "Claude", provider: "anthropic", available: true, busy: false, models: AGENT_MODELS["claude-sdk"].map((m) => m.value).filter(Boolean), capabilities: ["ask", "agent", "plan"] },
      ];
    }
  } finally {
    agentSelectorLoading.value = false;
  }
}

function setActiveManualAgent(agentId) {
  const nextId = String(agentId || "").trim();
  activeManualAgentId.value = nextId;
  try { localStorage.setItem("ve-active-manual-agent", nextId); } catch {}
}

/**
 * Switch the active agent via API.
 * @param {string} agentId
 */
async function switchAgent(agentId) {
  const previous = activeAgent.value;
  activeAgent.value = agentId; // optimistic
  try {
    const result = await apiFetch("/api/agents/switch", {
      method: "POST",
      body: JSON.stringify({ agent: agentId }),
    });
    // Sync to the agent the server *actually* selected — it may have silently
    // fallen back (e.g. copilot-sdk → codex-sdk when Copilot CLI is unavailable).
    const actual = result?.agent;
    if (actual) {
      activeAgent.value = actual;
      if (actual !== agentId) {
        const from = agentId.replace(/-sdk$/, "");
        const to = actual.replace(/-sdk$/, "");
        console.warn(`[agent-selector] Server fell back from ${agentId} → ${actual}`);
        try {
          globalThis.dispatchEvent(
            new CustomEvent("ve:api-error", {
              detail: { message: `${from} unavailable — using ${to} instead` },
            }),
          );
        } catch {
          /* non-browser env */
        }
      }
    }
  } catch (err) {
    console.warn("[agent-selector] Failed to switch agent:", err);
    activeAgent.value = previous; // rollback
  }
}

/**
 * Set the agent interaction mode via API.
 * @param {"ask"|"agent"|"plan"|"web"|"instant"} mode
 */
async function setAgentMode(mode) {
  const previous = agentMode.value;
  agentMode.value = mode; // optimistic
  try {
    await apiFetch("/api/agents/mode", {
      method: "POST",
      body: JSON.stringify({ mode }),
    });
  } catch (err) {
    console.warn("[agent-selector] Failed to set mode:", err);
    agentMode.value = previous; // rollback
  }
}

/* ═══════════════════════════════════════════════
 *  MUI theme overrides (dark mode + compact)
 * ═══════════════════════════════════════════════ */

const muiDarkPaper = {
  bgcolor: "var(--tg-theme-bg-color, #0f0f23)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: "12px",
  boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
  backdropFilter: "blur(16px)",
  "& .MuiMenuItem-root": {
    fontSize: 13,
    borderRadius: "8px",
    mx: 0.5,
    my: 0.25,
  },
};

/* ═══════════════════════════════════════════════
 *  AgentModeSelector
 *  MUI ToggleButtonGroup — Ask | Agent | Plan | Web | Instant
 * ═══════════════════════════════════════════════ */

export function AgentModeSelector() {
  const currentMode = agentMode.value;
  const [isCompact, setIsCompact] = useState(() => {
    try {
      return globalThis.matchMedia?.("(max-width: 640px)")?.matches ?? false;
    } catch { return false; }
  });

  useEffect(() => {
    const mq = globalThis.matchMedia?.("(max-width: 640px)");
    if (!mq) return;
    const handler = (e) => setIsCompact(e.matches);
    if (mq.addEventListener) mq.addEventListener("change", handler);
    else mq.addListener(handler);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", handler);
      else mq.removeListener(handler);
    };
  }, []);

  const handleChange = useCallback((_e, newMode) => {
    if (!newMode) return; // enforce at-least-one selection
    haptic("light");
    setAgentMode(newMode);
  }, []);

  const handleSelectChange = useCallback((e) => {
    const newMode = e.target.value;
    if (!newMode) return;
    haptic("light");
    setAgentMode(newMode);
  }, []);

  // Compact: dropdown Select for small screens
  if (isCompact) {
    const currentModeInfo = MODES.find(m => m.id === currentMode) || MODES[0];
    return html`
      <${Select}
        value=${currentMode}
        onChange=${handleSelectChange}
        size="small"
        variant="outlined"
        displayEmpty
        renderValue=${() => html`
          <${Box} sx=${{ display: "flex", alignItems: "center", gap: 0.5 }}>
            <span class="mode-icon">${resolveIcon(currentModeInfo.icon)}</span>
            <${Typography} variant="body2" sx=${{ fontSize: 12, fontWeight: 500 }}>${currentModeInfo.label}<//>
          <//>
        `}
        sx=${{
          flexShrink: 0,
          minWidth: 90,
          "& .MuiSelect-select": {
            py: 0.5,
            pl: 1,
            pr: "24px !important",
            fontSize: 12,
            fontWeight: 500,
            display: "flex",
            alignItems: "center",
          },
          "& .MuiOutlinedInput-notchedOutline": {
            borderColor: "rgba(255,255,255,0.08)",
          },
          "&:hover .MuiOutlinedInput-notchedOutline": {
            borderColor: "rgba(255,255,255,0.2)",
          },
          "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
            borderColor: "var(--tg-theme-button-color, #3b82f6)",
          },
          color: "var(--tg-theme-text-color, #fff)",
          "& .MuiSvgIcon-root": { color: "var(--tg-theme-hint-color, #999)", fontSize: 18 },
        }}
        MenuProps=${{ PaperProps: { sx: muiDarkPaper } }}
      >
        ${MODES.map((m) => html`
          <${MenuItem} key=${m.id} value=${m.id} sx=${{ fontSize: 13 }}>
            <${ListItemIcon} sx=${{ minWidth: "28px !important" }}>
              <span class="mode-icon" style="font-size:14px">${resolveIcon(m.icon)}</span>
            <//>
            <${ListItemText}
              primary=${m.label}
              secondary=${m.description}
              primaryTypographyProps=${{ fontSize: 13, fontWeight: 500 }}
              secondaryTypographyProps=${{ fontSize: 11 }}
            />
          <//>
        `)}
      <//>
    `;
  }

  // Default: ToggleButtonGroup for wider screens
  return html`
    <${ToggleButtonGroup}
      value=${currentMode}
      exclusive
      onChange=${handleChange}
      size="small"
      sx=${{
        flexShrink: 0,
        "& .MuiToggleButton-root": {
          px: 1.2,
          py: 0.5,
          fontSize: 12,
          fontWeight: 500,
          textTransform: "none",
          color: "var(--tg-theme-hint-color, #999)",
          borderColor: "rgba(255,255,255,0.08)",
          "&.Mui-selected": {
            bgcolor: "var(--tg-theme-button-color, #3b82f6)",
            color: "var(--tg-theme-button-text-color, #fff)",
            "&:hover": { bgcolor: "var(--tg-theme-button-color, #3b82f6)", opacity: 0.9 },
          },
          "&:hover": { bgcolor: "rgba(255,255,255,0.05)" },
        },
      }}
    >
      ${MODES.map((m) => html`
        <${ToggleButton} key=${m.id} value=${m.id}>
          <${Tooltip} title=${m.description} arrow>
            <${Box} sx=${{ display: "flex", alignItems: "center", gap: 0.5 }}>
              <span class="mode-icon">${resolveIcon(m.icon)}</span>
              ${" "}${m.label}
            </${Box}>
          </${Tooltip}>
        </${ToggleButton}>
      `)}
    </${ToggleButtonGroup}>
  `;
}

/* ═══════════════════════════════════════════════
 *  ModelPicker
 *  MUI Menu + MenuItem with checkmarks.
 *  Prefers the models array from /api/agents/available (always current),
 *  falls back to the static AGENT_MODELS registry for demo/offline mode.
 * ═══════════════════════════════════════════════ */

export function ModelPicker() {
  const current = activeAgent.value;
  const model = selectedModel.value;
  const agentInfo = activeAgentInfo.value;
  const [anchorEl, setAnchorEl] = useState(null);
  const open = Boolean(anchorEl);

  // Build model entries: prefer live API list, fall back to static registry.
  // For custom executor IDs (e.g. "copilot-claude"), derive the right static list
  // from the agent's provider field ("COPILOT" → "copilot-sdk").
  const apiModels = agentInfo?.models;
  const providerSdkKey = agentInfo?.provider
    ? agentInfo.provider.toLowerCase() + "-sdk"   // "COPILOT" → "copilot-sdk"
    : null;
  const staticList = AGENT_MODELS[current]
    || (providerSdkKey && AGENT_MODELS[providerSdkKey])
    || AGENT_MODELS["codex-sdk"];
  const modelEntries = apiModels && apiModels.length > 0
    ? [
        { value: "", label: "Default" },
        ...apiModels.map((m) => ({ value: m, label: buildLabel(m) })),
      ]
    : staticList;

  // When executor changes, reset model if the stored value isn't in the new list
  useEffect(() => {
    const validValues = modelEntries.map((m) => m.value);
    if (model && !validValues.includes(model)) {
      selectedModel.value = "";
      try { localStorage.setItem("ve-selected-model", ""); } catch {}
    }
  }, [current]);

  const handleOpen = useCallback((e) => {
    setAnchorEl(e.currentTarget);
  }, []);

  const handleClose = useCallback(() => {
    setAnchorEl(null);
  }, []);

  const handleSelect = useCallback((value) => {
    selectedModel.value = value;
    try { localStorage.setItem("ve-selected-model", value); } catch {}
    haptic("light");
    setAnchorEl(null);
  }, []);

  const displayLabel = model ? buildLabel(model) : "Default";

  return html`
    <${Tooltip} title="Model override (Default = executor decides)" arrow>
      <${Chip}
        label=${displayLabel}
        size="small"
        variant=${model ? "filled" : "outlined"}
        onClick=${handleOpen}
        onDelete=${null}
        icon=${html`<span style="font-size:13px;line-height:1">${resolveIcon("cpu")}</span>`}
        sx=${{
          flexShrink: 0,
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 500,
          color: "var(--tg-theme-text-color, #fff)",
          borderColor: open ? "var(--tg-theme-button-color, #3b82f6)" : "rgba(255,255,255,0.08)",
          bgcolor: model ? "rgba(59,130,246,0.12)" : "transparent",
          "&:hover": { bgcolor: "rgba(255,255,255,0.06)" },
        }}
      />
    </${Tooltip}>
    <${Menu}
      anchorEl=${anchorEl}
      open=${open}
      onClose=${handleClose}
      anchorOrigin=${{ vertical: "top", horizontal: "left" }}
      transformOrigin=${{ vertical: "bottom", horizontal: "left" }}
      slotProps=${{ paper: { sx: muiDarkPaper } }}
    >
      ${modelEntries.map((m) => html`
        <${MenuItem}
          key=${m.value}
          selected=${m.value === model}
          onClick=${() => handleSelect(m.value)}
          sx=${{ fontSize: 13 }}
        >
          ${m.value === model
            ? html`<${ListItemIcon} sx=${{ minWidth: "28px !important" }}><${Typography} sx=${{ color: "var(--tg-theme-button-color, #3b82f6)", fontWeight: 700, fontSize: 14 }}>✓</${Typography}></${ListItemIcon}>`
            : html`<${ListItemIcon} sx=${{ minWidth: "28px !important" }} />`
          }
          <${ListItemText}>${m.label}</${ListItemText}>
        </${MenuItem}>
      `)}
    </${Menu}>
  `;
}

/* ═══════════════════════════════════════════════
 *  AgentPicker
 *  MUI Menu + MenuItem — only shows enabled (available) executors.
 *  Empty state if none configured.
 * ═══════════════════════════════════════════════ */

export function AgentPicker() {
  const agents = availableAgents.value;
  const current = activeAgent.value;
  const loading = agentSelectorLoading.value;
  const [anchorEl, setAnchorEl] = useState(null);
  const open = Boolean(anchorEl);

  // Only show executors that are actually enabled
  const enabledAgents = agents.filter((a) => a.available);

  const handleOpen = useCallback((e) => {
    setAnchorEl(e.currentTarget);
  }, []);

  const handleClose = useCallback(() => {
    setAnchorEl(null);
  }, []);

  const handleSelect = useCallback((agentId) => {
    if (agentId === activeAgent.value) {
      setAnchorEl(null);
      return;
    }
    haptic("medium");
    switchAgent(agentId);
    // Reset model when executor changes — ModelPicker handles the value reset
    selectedModel.value = "";
    try { localStorage.setItem("ve-selected-model", ""); } catch {}
    setAnchorEl(null);
  }, []);

  // Empty state: no executors configured / all disabled
  if (!loading && enabledAgents.length === 0) {
    return html`
      <${Chip}
        label="No executors · configure in Settings"
        size="small"
        color="error"
        variant="outlined"
        sx=${{ fontSize: 12, flexShrink: 0 }}
      />
    `;
  }

  const currentAgent = enabledAgents.find((a) => a.id === current);
  const currentName = EXECUTOR_DISPLAY_NAMES[current]
    || (currentAgent ? String(currentAgent.name || "").replace(/\s*\(busy\)\s*$/i, "").trim() : "")
    || "Executor";
  const providerColor = currentAgent ? (PROVIDER_COLORS[currentAgent.provider?.toLowerCase()] || "#666") : "#666";

  return html`
    <${Tooltip} title="Select AI executor" arrow>
      <${Chip}
        label=${currentName}
        size="small"
        variant="outlined"
        onClick=${handleOpen}
        disabled=${loading}
        icon=${html`<span style="font-size:13px;line-height:1">${resolveIcon(AGENT_ICONS[current] || "bot")}</span>`}
        sx=${{
          flexShrink: 0,
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 500,
          color: "var(--tg-theme-text-color, #fff)",
          borderColor: open ? "var(--tg-theme-button-color, #3b82f6)" : "rgba(255,255,255,0.08)",
          "&:hover": { bgcolor: "rgba(255,255,255,0.06)" },
        }}
      />
    </${Tooltip}>
    <${Menu}
      anchorEl=${anchorEl}
      open=${open}
      onClose=${handleClose}
      anchorOrigin=${{ vertical: "top", horizontal: "left" }}
      transformOrigin=${{ vertical: "bottom", horizontal: "left" }}
      slotProps=${{ paper: { sx: { ...muiDarkPaper, minWidth: 220 } } }}
    >
      ${loading && html`
        <${MenuItem} disabled>
          <${ListItemText}>Loading…</${ListItemText}>
        </${MenuItem}>
      `}
      ${enabledAgents.map((agent) => {
        const rawName = EXECUTOR_DISPLAY_NAMES[agent.id] || agent.name || "";
        const name = String(rawName).replace(/\s*\(busy\)\s*$/i, "").trim() || "Executor";
        const isActive = agent.id === current;
        const pColor = PROVIDER_COLORS[agent.provider?.toLowerCase()] || "#666";
        const statusColor = agent.busy ? "#eab308" : agent.available ? "#22c55e" : "#6b7280";

        return html`
          <${MenuItem}
            key=${agent.id}
            selected=${isActive}
            onClick=${() => handleSelect(agent.id)}
          >
            <${ListItemIcon} sx=${{ minWidth: "36px !important" }}>
              <${Box} sx=${{
                width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center",
                borderRadius: "6px", bgcolor: "rgba(255,255,255,0.04)", fontSize: 18,
              }}>
                ${resolveIcon(AGENT_ICONS[agent.id] || "bot")}
              </${Box}>
            </${ListItemIcon}>
            <${ListItemText}
              primary=${name}
              secondary=${agent.provider || ""}
              primaryTypographyProps=${{ fontSize: 13, fontWeight: 500 }}
              secondaryTypographyProps=${{ fontSize: 11, color: "var(--tg-theme-hint-color, #888)" }}
            />
            <${Stack} direction="row" spacing=${0.5} alignItems="center" sx=${{ ml: 1 }}>
              <${Box} sx=${{ width: 7, height: 7, borderRadius: "50%", bgcolor: statusColor, flexShrink: 0 }} />
              ${isActive && html`<${Typography} sx=${{ color: "var(--tg-theme-button-color, #3b82f6)", fontWeight: 700, fontSize: 14 }}>✓</${Typography}>`}
            </${Stack}>
          </${MenuItem}>
        `;
      })}
    </${Menu}>
  `;
}

export function ManualAgentPicker() {
  const profiles = manualAgents.value;
  const current = activeManualAgentId.value;
  const [anchorEl, setAnchorEl] = useState(null);
  const open = Boolean(anchorEl);

  const grouped = profiles.reduce((acc, profile) => {
    const key = String(profile?.sectionLabel || "Manual").trim() || "Manual";
    if (!acc[key]) acc[key] = [];
    acc[key].push(profile);
    return acc;
  }, {});
  const currentProfile = profiles.find((profile) => profile.id === current) || null;
  const currentLabel = currentProfile?.name || "Manual Agent";

  const handleSelect = useCallback((profileId) => {
    const nextId = String(profileId || "").trim();
    const selected = profiles.find((profile) => profile.id === nextId) || null;
    setActiveManualAgent(nextId);
    if (selected?.interactiveMode && VALID_MANUAL_MODES.has(selected.interactiveMode)) {
      setAgentMode(selected.interactiveMode);
    }
    if (selected?.model) {
      selectedModel.value = selected.model;
      try { localStorage.setItem("ve-selected-model", selected.model); } catch {}
    }
    haptic(selected ? "light" : "medium");
    setAnchorEl(null);
  }, [profiles]);

  return html`
    <${Tooltip} title="Select a library-backed manual chat agent" arrow>
      <${Chip}
        label=${currentLabel}
        size="small"
        variant=${currentProfile ? "filled" : "outlined"}
        onClick=${(e) => setAnchorEl(e.currentTarget)}
        icon=${html`<span style="font-size:13px;line-height:1">${resolveIcon("bot")}</span>`}
        sx=${{
          flexShrink: 0,
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 500,
          color: "var(--tg-theme-text-color, #fff)",
          borderColor: open ? "var(--tg-theme-button-color, #3b82f6)" : "rgba(255,255,255,0.08)",
          bgcolor: currentProfile ? "rgba(59,130,246,0.12)" : "transparent",
          "&:hover": { bgcolor: "rgba(255,255,255,0.06)" },
        }}
      />
    </${Tooltip}>
    <${Menu}
      anchorEl=${anchorEl}
      open=${open}
      onClose=${() => setAnchorEl(null)}
      anchorOrigin=${{ vertical: "top", horizontal: "left" }}
      transformOrigin=${{ vertical: "bottom", horizontal: "left" }}
      slotProps=${{ paper: { sx: { ...muiDarkPaper, minWidth: 260 } } }}
    >
      <${MenuItem} selected=${!current} onClick=${() => handleSelect("")}>
        <${ListItemIcon} sx=${{ minWidth: "28px !important" }}>
          ${!current ? html`<${Typography} sx=${{ color: "var(--tg-theme-button-color, #3b82f6)", fontWeight: 700, fontSize: 14 }}>✓</${Typography}>` : null}
        </${ListItemIcon}>
        <${ListItemText}
          primary="No manual profile"
          secondary="Use only the executor + mode selection"
          primaryTypographyProps=${{ fontSize: 13, fontWeight: 500 }}
          secondaryTypographyProps=${{ fontSize: 11 }}
        />
      </${MenuItem}>
      ${profiles.length > 0 ? html`<${Divider} />` : null}
      ${Object.entries(grouped).map(([sectionLabel, items], sectionIndex) => html`
        <div key=${sectionLabel}>
          ${sectionIndex > 0 ? html`<${Divider} />` : null}
          <${MenuItem} disabled sx=${{ opacity: 0.7, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>
            ${sectionLabel}
          </${MenuItem}>
          ${items.map((profile) => html`
            <${MenuItem}
              key=${profile.id}
              selected=${profile.id === current}
              onClick=${() => handleSelect(profile.id)}
            >
              <${ListItemIcon} sx=${{ minWidth: "28px !important" }}>
                ${profile.id === current ? html`<${Typography} sx=${{ color: "var(--tg-theme-button-color, #3b82f6)", fontWeight: 700, fontSize: 14 }}>✓</${Typography}>` : null}
              </${ListItemIcon}>
              <${ListItemText}
                primary=${profile.name}
                secondary=${profile.description || profile.interactiveMode || profile.agentCategory || "Manual agent"}
                primaryTypographyProps=${{ fontSize: 13, fontWeight: 500 }}
                secondaryTypographyProps=${{ fontSize: 11 }}
              />
            </${MenuItem}>
          `)}
        </div>
      `)}
      ${profiles.length === 0 ? html`
        <${MenuItem} disabled>
          <${ListItemText}
            primary="No manual agents"
            secondary="Mark an interactive agent as visible in chat from the Library tab."
            primaryTypographyProps=${{ fontSize: 13, fontWeight: 500 }}
            secondaryTypographyProps=${{ fontSize: 11 }}
          />
        </${MenuItem}>
      ` : null}
    </${Menu}>
  `;
}

/* ═══════════════════════════════════════════════
 *  AgentStatusBadge
 *  MUI Chip showing agent runtime state
 * ═══════════════════════════════════════════════ */

export function AgentStatusBadge() {
  const status = agentStatus.value;
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.idle;
  const alive = aliveAgentCount.value;
  const stale = staleAgentCount.value;
  const errors = totalErrorCount.value;

  // Map status to MUI Chip color
  const chipColor = status === "idle" ? "default"
    : status === "thinking" ? "warning"
    : status === "executing" ? "info"
    : status === "streaming" ? "success"
    : "default";

  return html`
    <${Stack} direction="row" spacing=${0.5} alignItems="center" sx=${{ flexShrink: 0 }}>
      <${Chip}
        label=${cfg.label}
        size="small"
        color=${chipColor}
        variant=${status === "idle" ? "outlined" : "filled"}
        icon=${html`
          <${Box}
            class=${cfg.pulse ? "agent-status-dot-pulse" : ""}
            sx=${{
              width: 7, height: 7, borderRadius: "50%",
              bgcolor: cfg.color, flexShrink: 0,
              transition: "background 0.3s ease",
            }}
          />
        `}
        sx=${{
          fontSize: 11, fontWeight: 500,
          color: "var(--tg-theme-hint-color, #999)",
          borderColor: "rgba(255,255,255,0.08)",
        }}
      />
      ${alive > 0 && html`
        <${Tooltip} title="${alive} agent(s) active" arrow>
          <${Badge} badgeContent=${alive} color="success" sx=${{ "& .MuiBadge-badge": { fontSize: 10, minWidth: 16, height: 16 } }}>
            <${Box} sx=${{ width: 8 }} />
          </${Badge}>
        </${Tooltip}>
      `}
      ${stale > 0 && html`
        <${Tooltip} title="${stale} agent(s) stale" arrow>
          <${Chip}
            label=${stale}
            size="small"
            color="warning"
            icon=${html`<span class="icon-inline" style="font-size:10px">${resolveIcon("alert")}</span>`}
            sx=${{ fontSize: 10, height: 20 }}
          />
        </${Tooltip}>
      `}
      ${errors > 0 && html`
        <${Tooltip} title="${errors} error(s)" arrow>
          <${Chip}
            label=${errors}
            size="small"
            color="error"
            icon=${html`<span class="icon-inline" style="font-size:10px">${resolveIcon("close")}</span>`}
            sx=${{ fontSize: 10, height: 20 }}
          />
        </${Tooltip}>
      `}
    </${Stack}>
  `;
}

/* ═══════════════════════════════════════════════
 *  YoloToggle
 *  MUI Switch + FormControlLabel
 * ═══════════════════════════════════════════════ */

function YoloToggle() {
  const isYolo = yoloMode.value;

  const toggle = useCallback(() => {
    const next = !yoloMode.peek();
    yoloMode.value = next;
    try { localStorage.setItem("ve-yolo-mode", String(next)); } catch {}
    haptic(next ? "medium" : "light");
  }, []);

  return html`
    <${Tooltip}
      title=${isYolo
        ? "Yolo ON — agent will auto-approve actions (disable to require confirmations)"
        : "Enable Yolo mode — agent will skip confirmation prompts"}
      arrow
    >
      <${FormControlLabel}
        control=${html`
          <${Switch}
            checked=${isYolo}
            onChange=${toggle}
            size="small"
            sx=${{
              "& .MuiSwitch-switchBase.Mui-checked": {
                color: "#ffa537",
              },
              "& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track": {
                bgcolor: "rgba(255,140,0,0.55)",
              },
            }}
          />
        `}
        label=${html`
          <${Stack} direction="row" spacing=${0.5} alignItems="center">
            <span style="font-size:13px;line-height:1">${resolveIcon("zap")}</span>
            <${Typography} variant="body2" sx=${{ fontSize: 12, fontWeight: 600, color: isYolo ? "#ffa537" : "var(--tg-theme-hint-color, #888)" }}>
              Yolo
            </${Typography}>
          </${Stack}>
        `}
        sx=${{
          mx: 0,
          flexShrink: 0,
          userSelect: "none",
          "& .MuiFormControlLabel-label": { ml: 0 },
        }}
      />
    </${Tooltip}>
  `;
}

/* ═══════════════════════════════════════════════
 *  WorkspaceModePicker
 *  Chip → Menu: choose between "Workspace" (parent workspace dir)
 *  and "Worktree" (specific repo/worktree). Persisted to localStorage.
 * ═══════════════════════════════════════════════ */

export function WorkspaceModePicker() {
  const mode = agentRunMode.value;
  const [anchorEl, setAnchorEl] = useState(null);
  const open = Boolean(anchorEl);

  const handleOpen = useCallback((e) => { setAnchorEl(e.currentTarget); }, []);
  const handleClose = useCallback(() => { setAnchorEl(null); }, []);

  const handleSelect = useCallback((value) => {
    agentRunMode.value = value;
    try { localStorage.setItem("ve-agent-run-mode", value); } catch {}
    // Clear repo selection when switching back to workspace mode
    if (value === "workspace") {
      selectedRepo.value = "";
      try { localStorage.setItem("ve-selected-repo", ""); } catch {}
    }
    haptic("light");
    setAnchorEl(null);
  }, []);

  const isWorktree = mode === "worktree";

  return html`
    <${Tooltip} title="Run context: Workspace = parent workspace dir, Worktree = specific repo" arrow>
      <${Chip}
        label=${isWorktree ? "Worktree" : "Workspace"}
        size="small"
        variant=${isWorktree ? "filled" : "outlined"}
        onClick=${handleOpen}
        icon=${html`<span style="font-size:13px;line-height:1">${resolveIcon(isWorktree ? "git-branch" : "folder")}</span>`}
        sx=${{
          flexShrink: 0,
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 500,
          color: "var(--tg-theme-text-color, #fff)",
          borderColor: open ? "var(--tg-theme-button-color, #3b82f6)" : "rgba(255,255,255,0.08)",
          bgcolor: isWorktree ? "rgba(59,130,246,0.12)" : "transparent",
          "&:hover": { bgcolor: "rgba(255,255,255,0.06)" },
        }}
      />
    </${Tooltip}>
    <${Menu}
      anchorEl=${anchorEl}
      open=${open}
      onClose=${handleClose}
      anchorOrigin=${{ vertical: "top", horizontal: "left" }}
      transformOrigin=${{ vertical: "bottom", horizontal: "left" }}
      slotProps=${{ paper: { sx: { ...muiDarkPaper, minWidth: 200 } } }}
    >
      ${[
        { value: "workspace", label: "Workspace", desc: "Launch in parent workspace directory", icon: "folder" },
        { value: "worktree", label: "Worktree", desc: "Launch inside a specific repo/worktree", icon: "git-branch" },
      ].map(({ value, label, desc, icon }) => html`
        <${MenuItem}
          key=${value}
          selected=${mode === value}
          onClick=${() => handleSelect(value)}
        >
          <${ListItemIcon} sx=${{ minWidth: "36px !important" }}>
            <${Box} sx=${{
              width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center",
              borderRadius: "6px", bgcolor: "rgba(255,255,255,0.04)", fontSize: 16,
            }}>
              ${resolveIcon(icon)}
            </${Box}>
          </${ListItemIcon}>
          <${ListItemText}
            primary=${label}
            secondary=${desc}
            primaryTypographyProps=${{ fontSize: 13, fontWeight: 500 }}
            secondaryTypographyProps=${{ fontSize: 11 }}
          />
          ${mode === value && html`<${Typography} sx=${{ color: "var(--tg-theme-button-color, #3b82f6)", fontWeight: 700, fontSize: 14, ml: 1 }}>✓</${Typography}>`}
        </${MenuItem}>
      `)}
    </${Menu}>
  `;
}

/* ═══════════════════════════════════════════════
 *  RepoPicker
 *  Chip → Menu: select which worktree/repo the agent runs in.
 *  Default is "Workspace" (empty = parent workspace dir).
 *  Loads worktrees lazily on first open. Required when mode = "worktree".
 * ═══════════════════════════════════════════════ */

export function RepoPicker() {
  const mode = agentRunMode.value;
  const current = selectedRepo.value;
  const worktrees = worktreeData.value;
  const [anchorEl, setAnchorEl] = useState(null);
  const open = Boolean(anchorEl);

  const needsRepo = mode === "worktree" && !current;

  const handleOpen = useCallback((e) => {
    // Lazy-load worktrees on first open
    if (worktrees.length === 0) loadWorktrees();
    setAnchorEl(e.currentTarget);
  }, [worktrees.length]);

  const handleClose = useCallback(() => { setAnchorEl(null); }, []);

  const handleSelect = useCallback((value) => {
    selectedRepo.value = value;
    try { localStorage.setItem("ve-selected-repo", value); } catch {}
    haptic("light");
    setAnchorEl(null);
  }, []);

  // Derive repo display name from last segment of path
  const repoName = (path) => {
    if (!path) return "";
    const seg = path.replace(/\\/g, "/").split("/").filter(Boolean);
    return seg[seg.length - 1] || path;
  };

  const currentLabel = current ? repoName(current) : "Workspace";

  return html`
    <${Tooltip}
      title=${needsRepo
        ? "⚠ Worktree mode requires a repo selection"
        : "Select repo: Workspace = use parent workspace dir"}
      arrow
    >
      <${Chip}
        label=${currentLabel}
        size="small"
        variant=${current ? "filled" : "outlined"}
        onClick=${handleOpen}
        icon=${html`<span style="font-size:13px;line-height:1">${resolveIcon("box")}</span>`}
        sx=${{
          flexShrink: 0,
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 500,
          color: needsRepo ? "#f97316" : "var(--tg-theme-text-color, #fff)",
          borderColor: needsRepo
            ? "#f97316"
            : open ? "var(--tg-theme-button-color, #3b82f6)" : "rgba(255,255,255,0.08)",
          bgcolor: current ? "rgba(59,130,246,0.12)" : "transparent",
          "&:hover": { bgcolor: "rgba(255,255,255,0.06)" },
        }}
      />
    </${Tooltip}>
    <${Menu}
      anchorEl=${anchorEl}
      open=${open}
      onClose=${handleClose}
      anchorOrigin=${{ vertical: "top", horizontal: "left" }}
      transformOrigin=${{ vertical: "bottom", horizontal: "left" }}
      slotProps=${{ paper: { sx: { ...muiDarkPaper, minWidth: 240 } } }}
    >
      <${MenuItem}
        selected=${!current}
        onClick=${() => handleSelect("")}
      >
        <${ListItemIcon} sx=${{ minWidth: "28px !important" }}>
          ${!current ? html`<${Typography} sx=${{ color: "var(--tg-theme-button-color, #3b82f6)", fontWeight: 700, fontSize: 14 }}>✓</${Typography}>` : null}
        </${ListItemIcon}>
        <${ListItemText}
          primary="Workspace (default)"
          secondary="Use parent workspace directory"
          primaryTypographyProps=${{ fontSize: 13, fontWeight: 500 }}
          secondaryTypographyProps=${{ fontSize: 11 }}
        />
      </${MenuItem}>
      ${worktrees.length > 0 ? html`<${Divider} />` : null}
      ${worktrees.length > 0
        ? worktrees.map((wt) => {
            const name = repoName(wt.path);
            const isActive = current === wt.path;
            const statusColor = wt.status === "active" ? "#22c55e" : wt.status === "stale" ? "#eab308" : "#6b7280";
            return html`
              <${MenuItem}
                key=${wt.path}
                selected=${isActive}
                onClick=${() => handleSelect(wt.path)}
              >
                <${ListItemIcon} sx=${{ minWidth: "28px !important" }}>
                  ${isActive ? html`<${Typography} sx=${{ color: "var(--tg-theme-button-color, #3b82f6)", fontWeight: 700, fontSize: 14 }}>✓</${Typography}>` : null}
                </${ListItemIcon}>
                <${ListItemText}
                  primary=${name}
                  secondary=${wt.branch || wt.path}
                  primaryTypographyProps=${{ fontSize: 13, fontWeight: 500 }}
                  secondaryTypographyProps=${{ fontSize: 11 }}
                />
                <${Box} sx=${{ width: 7, height: 7, borderRadius: "50%", bgcolor: statusColor, flexShrink: 0, ml: 1 }} />
              </${MenuItem}>
            `;
          })
        : html`
          <${MenuItem} disabled>
            <${ListItemText}
              primary="No worktrees found"
              secondary="Create a worktree from the Infra tab."
              primaryTypographyProps=${{ fontSize: 13 }}
              secondaryTypographyProps=${{ fontSize: 11 }}
            />
          </${MenuItem}>
        `
      }
    </${Menu}>
  `;
}

/* ═══════════════════════════════════════════════
 *  ChatInputToolbar
 *  Combines all selectors into a single row
 * ═══════════════════════════════════════════════ */

export function ChatInputToolbar() {
  // Inject styles on first mount
  useEffect(() => {
    injectAgentSelectorStyles();
  }, []);

  // Load agents on mount — but only if not already loaded or loading.
  // ChatTab already calls loadAvailableAgents() so this is a fallback.
  useEffect(() => {
    if (availableAgents.value.length === 0 && !agentSelectorLoading.value) {
      loadAvailableAgents();
    }
  }, []);

  return html`
    <div class="chat-input-toolbar">
      <${AgentPicker} />
      <${AgentModeSelector} />
      <${ManualAgentPicker} />
      <${ModelPicker} />
      <${WorkspaceModePicker} />
      <${RepoPicker} />
      <${YoloToggle} />
      <${Box} sx=${{ flex: 1, minWidth: 8 }} />
      <${AgentStatusBadge} />
    </div>
  `;
}
