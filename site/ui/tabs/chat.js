/* ─────────────────────────────────────────────────────────────
 *  Tab: Chat — ChatGPT-style session interface with agent mode
 *  selector, SDK command passthrough, optimistic rendering,
 *  offline queue, and streaming status indicators.
 * ────────────────────────────────────────────────────────────── */
import { h, Component } from "preact";
import { useEffect, useState, useCallback, useRef, useMemo } from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

import { Typography, Box, Stack, Card, CardContent, Button, IconButton, Chip, Divider, Paper, TextField, InputAdornment, CircularProgress, Alert, Tooltip, Switch, FormControlLabel, Dialog, DialogTitle, DialogContent, DialogActions, List, ListItem, ListItemButton, ListItemText, ListItemIcon, Menu, MenuItem, Tabs, Tab, Skeleton, Badge, Avatar, LinearProgress, Grid } from "@mui/material";

/* ─── Inner error boundary for complex sub-components ─── */
class ChatSafeBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("[ChatSafeBoundary] Caught error in", this.props.label || "component", ":", error, info);
  }
  render() {
    if (this.state.error) {
      const retry = () => this.setState({ error: null });
      return html`
        <${Alert} severity="error" sx=${{ opacity: 0.8 }} action=${html`<${Button} size="small" onClick=${retry}>Retry<//>`}>
          ${this.props.label || "Component"} failed to render.
        <//>
      `;
    }
    return this.props.children;
  }
}

import {
  SessionList,
  SESSION_VIEW_FILTER,
  loadSessions,
  selectedSessionId,
  sessionsData,
  createSession,
  loadSessionMessages,
  archiveSession,
  resumeSession,
} from "../../../ui/components/session-list.js";
import { routeParams, setRouteParams } from "../../../ui/modules/router.js";
import { ChatView } from "../../../ui/components/chat-view.js";
import { apiFetch } from "../../../ui/modules/api.js";
import {
  buildSessionApiPath,
  getSessionLifecycleState,
  getSessionRecencyTimestamp,
  getSessionRuntimeState,
  resolveSessionWorkspaceHint,
} from "../../../ui/modules/session-api.js";
import { showToast } from "../../../ui/modules/state.js";
import { VoiceMicButton, requestVoiceModeOpen } from "../../../ui/modules/voice.js";
import { iconText, resolveIcon } from "../../../ui/modules/icon-utils.js";
import {
  ChatInputToolbar,
  loadAvailableAgents,
  agentMode,
  activeAgent,
  activeManualAgentId,
  activeAgentInfo,
  availableAgents,
  yoloMode,
  selectedModel,
} from "../../../ui/components/agent-selector.js";
import {
  addPendingMessage,
  confirmMessage,
  rejectMessage,
  markUserMessageSent,
  sendOrQueue,
  offlineQueueSize,
} from "../../../ui/modules/streaming.js";

/* ─── Bosun commands (always available) ─── */
const BOSUN_COMMANDS = [
  { cmd: "/help", desc: "Show available commands", icon: "help", source: "bosun" },
  { cmd: "/commands", desc: "Show full command list", icon: "menu", source: "bosun" },
  { cmd: "/status", desc: "Check orchestrator status", icon: "chart", source: "bosun" },
  { cmd: "/health", desc: "Health check", icon: "heart", source: "bosun" },
  { cmd: "/logs", desc: "View recent logs", icon: "file", source: "bosun" },
  { cmd: "/tasks", desc: "List tasks", icon: "clipboard", source: "bosun" },
  { cmd: "/plan", desc: "Generate plan", icon: "edit", source: "bosun" },
  { cmd: "/start", desc: "Start orchestrator", icon: "play", source: "bosun" },
  { cmd: "/stop", desc: "Stop orchestrator", icon: "stop", source: "bosun" },
  { cmd: "/pause", desc: "Pause execution", icon: "pause", source: "bosun" },
  { cmd: "/resume", desc: "Resume execution", icon: "play", source: "bosun" },
  { cmd: "/version", desc: "Show version info", icon: "hash", source: "bosun" },
  { cmd: "/hooks", desc: "Show hook status", icon: "link", source: "bosun" },
  { cmd: "/sentinel", desc: "Sentinel status", icon: "shield", source: "bosun" },
  { cmd: "/kanban", desc: "Open Kanban board", icon: "pin", source: "bosun" },
  { cmd: "/deploy", desc: "Trigger deployment", icon: "rocket", source: "bosun" },
  { cmd: "/ask", desc: "Ask the assistant", icon: "chat", source: "bosun" },
  { cmd: "/agent", desc: "Send message in agent mode", icon: "bot", source: "bosun" },
  { cmd: "/web", desc: "Send message in web mode", icon: "globe", source: "bosun" },
  { cmd: "/instant", desc: "Send message in instant mode", icon: "zap", source: "bosun" },
];

const MESSAGE_MODE_COMMANDS = Object.freeze({
  "/ask": "ask",
  "/agent": "agent",
  "/plan": "plan",
  "/web": "web",
  "/instant": "instant",
});

/* ─── SDK commands (dynamic based on active agent) ─── */
const SDK_COMMAND_META = {
  "/compact": { desc: "Compact conversation context", icon: "filter" },
  "/context": { desc: "Show context window usage", icon: "ruler" },
  "/mcp": { desc: "MCP server status", icon: "plug" },
  "/model": { desc: "Show/change model", icon: "cpu" },
  "/clear": { desc: "Clear agent session", icon: "trash" },
};

/** Merge Bosun + SDK commands based on active agent capabilities.
 *  Uses .peek() to avoid subscribing render callers to the signal. */
function getSlashCommands() {
  const info = activeAgentInfo.peek();
  const sdkCmds = info?.capabilities?.sdkCommands || [];
  const sdkEntries = sdkCmds
    .filter((cmd) => !BOSUN_COMMANDS.some((b) => b.cmd === cmd))
    .map((cmd) => ({
      cmd,
      desc: SDK_COMMAND_META[cmd]?.desc || `SDK: ${cmd}`,
      icon: SDK_COMMAND_META[cmd]?.icon || "zap",
      source: "sdk",
    }));
  return [...BOSUN_COMMANDS, ...sdkEntries];
}

function formatAttachmentSize(size) {
  const raw = Number(size);
  if (!Number.isFinite(raw) || raw <= 0) return "";
  if (raw >= 1024 * 1024) return `${(raw / (1024 * 1024)).toFixed(1)} MB`;
  if (raw >= 1024) return `${Math.round(raw / 1024)} KB`;
  return `${raw} B`;
}

/** Keep unsent drafts/attachments per-session so switching chats does not discard them. */
const pendingAttachmentsBySessionId = new Map();
const pendingDraftTextBySessionId = new Map();
const DRAFT_SESSION_KEY = "__draft__";
const CHAT_DRAFT_STORAGE_KEY = "ve-chat-drafts-v1";
const CHAT_DRAFT_ATTACHMENTS_STORAGE_KEY = "ve-chat-draft-attachments-v1";

function persistDraftTextCache() {
  if (typeof localStorage === "undefined") return;
  try {
    const serialized = {};
    for (const [key, value] of pendingDraftTextBySessionId.entries()) {
      const text = String(value || "");
      if (!text.trim()) continue;
      serialized[key] = text;
    }
    localStorage.setItem(CHAT_DRAFT_STORAGE_KEY, JSON.stringify(serialized));
  } catch {
    // Ignore storage errors.
  }
}

function persistDraftAttachmentCache() {
  if (typeof localStorage === "undefined") return;
  try {
    const serialized = {};
    for (const [key, items] of pendingAttachmentsBySessionId.entries()) {
      if (!Array.isArray(items) || items.length === 0) continue;
      serialized[key] = items.slice(0, 20);
    }
    localStorage.setItem(CHAT_DRAFT_ATTACHMENTS_STORAGE_KEY, JSON.stringify(serialized));
  } catch {
    // Ignore storage errors.
  }
}

(function hydrateDraftCaches() {
  if (typeof localStorage === "undefined") return;
  try {
    const rawDrafts = localStorage.getItem(CHAT_DRAFT_STORAGE_KEY);
    if (rawDrafts) {
      const parsed = JSON.parse(rawDrafts);
      if (parsed && typeof parsed === "object") {
        for (const [key, value] of Object.entries(parsed)) {
          const text = String(value || "");
          if (!text.trim()) continue;
          pendingDraftTextBySessionId.set(String(key), text);
        }
      }
    }
  } catch {
    // Ignore malformed cache.
  }
  try {
    const rawAttachments = localStorage.getItem(CHAT_DRAFT_ATTACHMENTS_STORAGE_KEY);
    if (rawAttachments) {
      const parsed = JSON.parse(rawAttachments);
      if (parsed && typeof parsed === "object") {
        for (const [key, value] of Object.entries(parsed)) {
          if (!Array.isArray(value) || value.length === 0) continue;
          pendingAttachmentsBySessionId.set(String(key), value.filter(Boolean).slice(0, 20));
        }
      }
    }
  } catch {
    // Ignore malformed cache.
  }
})();

function hasDragFiles(event) {
  const types = event?.dataTransfer?.types;
  if (!types) return false;
  try {
    return Array.from(types).includes("Files");
  } catch {
    return false;
  }
}

/* ─── Welcome screen (no session selected) ─── */
function ChatWelcome({ onNewSession, onQuickCommand }) {
  const quickActions = [
    { label: "New Chat", icon: "chat", action: () => onNewSession() },
    { label: "Status", icon: "chart", action: () => onQuickCommand("/status") },
    { label: "Tasks", icon: "clipboard", action: () => onQuickCommand("/tasks") },
    { label: "Logs", icon: "file", action: () => onQuickCommand("/logs") },
    { label: "Health", icon: "heart", action: () => onQuickCommand("/health") },
    { label: "Help", icon: "help", action: () => onQuickCommand("/help") },
  ];

  return html`
    <${Box} className="chat-welcome" sx=${{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", p: 4 }}>
      <${Avatar} sx=${{ width: 56, height: 56, mb: 2, bgcolor: "primary.main" }}>${resolveIcon("bot")}<//>
      <${Typography} variant="h5" gutterBottom>Welcome to Bosun<//>
      <${Typography} variant="body2" color="text.secondary" sx=${{ textAlign: "center", maxWidth: 420, mb: 3 }}>
        Select a session from the sidebar, start a new chat, or use a quick
        action below to get started.
      <//>
      <${Stack} direction="row" spacing=${1} flexWrap="wrap" justifyContent="center">
        ${quickActions.map(
          (a) => html`
            <${Button}
              key=${a.label}
              variant="outlined"
              size="small"
              startIcon=${resolveIcon(a.icon) || a.icon}
              onClick=${a.action}
              sx=${{ textTransform: "none" }}
            >
              ${a.label}
            <//>
          `,
        )}
      <//>
    <//>
  `;
}

/* ─── Slash command autocomplete popup ─── */
function SlashMenu({ filter, onSelect, activeIndex, commands }) {
  const lowerFilter = (filter || "").toLowerCase();
  const matches = (commands || getSlashCommands()).filter((c) =>
    c.cmd.toLowerCase().startsWith(lowerFilter),
  );
  if (matches.length === 0) return null;

  return html`
    <${Paper} elevation=${4} className="slash-menu" sx=${{ maxHeight: 260, overflowY: "auto", borderRadius: 2, position: "absolute", bottom: "100%", left: 0, right: 0, zIndex: 10 }}>
      <${List} dense disablePadding>
        ${matches.map(
          (c, i) => html`
            <${ListItem} key=${c.cmd} disablePadding secondaryAction=${c.source === "sdk" && html`<${Chip} label="SDK" size="small" color="secondary" />`}>
              <${ListItemButton}
                selected=${i === activeIndex}
                onMouseDown=${(e) => {
                  e.preventDefault();
                  onSelect(c.cmd);
                }}
              >
                <${ListItemIcon} sx=${{ minWidth: 32 }}>${resolveIcon(c.icon) || c.icon}<//>
                <${ListItemText} primary=${c.cmd} secondary=${c.desc} />
              <//>
            <//>
          `,
        )}
      <//>
    <//>
  `;
}

/* ─── Inline session rename input ─── */
function SessionRenameInput({ value, onSave, onCancel }) {
  const inputRef = useRef(null);
  const [val, setVal] = useState(value || "");

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, []);

  function commit() {
    const trimmed = val.trim();
    if (trimmed && trimmed !== value) {
      onSave(trimmed);
    } else {
      onCancel();
    }
  }

  return html`
    <${TextField}
      inputRef=${inputRef}
      variant="standard"
      size="small"
      fullWidth
      value=${val}
      onInput=${(e) => setVal(e.target.value)}
      onKeyDown=${(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
        if (e.key === "Escape") onCancel();
      }}
      onBlur=${commit}
      sx=${{ "& .MuiInput-input": { fontSize: "0.875rem", py: 0.5 } }}
    />
  `;
}

/* ─── Main Chat Tab ─── */
export function ChatTab() {
  const [chatError, setChatError] = useState(null);

  // Wrap the entire signal read in try/catch to prevent crash on corrupt signal state
  let sessionId = null;
  try {
    sessionId = selectedSessionId.value;
  } catch (err) {
    console.error("[ChatTab] Failed to read selectedSessionId:", err);
    if (!chatError) setChatError(err.message || "Signal read error");
  }

  const [showArchived, setShowArchived] = useState(false);
  const [sessionView, setSessionView] = useState(SESSION_VIEW_FILTER.all);
  const [inputValue, setInputValue] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashActiveIdx, setSlashActiveIdx] = useState(0);
  const [renamingSessionId, setRenamingSessionId] = useState(null);
  const [sending, setSending] = useState(false);
  const [isMobile, setIsMobile] = useState(() => {
    try {
      return globalThis.matchMedia?.("(max-width: 768px)")?.matches ?? false;
    } catch {
      return false;
    }
  });
  const [isDesktop, setIsDesktop] = useState(() => {
    try {
      return globalThis.matchMedia?.("(min-width: 1200px)")?.matches ?? false;
    } catch {
      return false;
    }
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(() => {
    try {
      return localStorage.getItem("ve-chat-focus") === "true";
    } catch {
      return false;
    }
  });
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const sendMenuRef = useRef(null);
  const messageQueueRef = useRef([]);
  const chatDropDepthRef = useRef(0);
  const [showSendMenu, setShowSendMenu] = useState(false);
  const [queueCount, setQueueCount] = useState(0);
  const [stoppingAgent, setStoppingAgent] = useState(false);
  const routeSessionId = String(routeParams.value?.sessionId || "").trim();

  const getWorkspaceScopeForView = useCallback((view) => {
    const normalized = String(view || "").toLowerCase();
    if (normalized === SESSION_VIEW_FILTER.active) return "active";
    return "all";
  }, []);

  const refreshPrimarySessions = useCallback(
    async (view = sessionView) => {
      await loadSessions({
        type: "primary",
        workspace: getWorkspaceScopeForView(view),
      });
    },
    [getWorkspaceScopeForView, sessionView],
  );

  /* ── Load sessions + agents on mount ── */
  useEffect(() => {
    let mounted = true;
    // Stagger initial loads to avoid signal cascade storm —
    // each API response updates a signal → triggers re-render.
    // Loading them sequentially gives each render time to settle.
    (async () => {
      try {
        await refreshPrimarySessions();
      } catch { /* handled internally */ }
      if (!mounted) return;
      // Small delay before loading agents to let session render settle
      await new Promise(r => setTimeout(r, 50));
      if (!mounted) return;
      try {
        await loadAvailableAgents();
      } catch { /* handled internally */ }
    })();
    const interval = setInterval(() => {
      if (mounted) refreshPrimarySessions();
    }, 5000);
    // Refresh agent list less frequently
    const agentInterval = setInterval(() => {
      if (mounted) loadAvailableAgents();
    }, 30000);
    return () => {
      mounted = false;
      clearInterval(interval);
      clearInterval(agentInterval);
    };
  }, [refreshPrimarySessions]);

  useEffect(() => {
    const onWorkspaceSwitched = () => {
      selectedSessionId.value = null;
      refreshPrimarySessions().catch(() => {});
    };
    window.addEventListener("ve:workspace-switched", onWorkspaceSwitched);
    return () => {
      window.removeEventListener("ve:workspace-switched", onWorkspaceSwitched);
    };
  }, [refreshPrimarySessions]);

  /* ── Track mobile viewport to avoid auto-select loops ── */
  useEffect(() => {
    const mq = globalThis.matchMedia?.("(max-width: 768px)");
    if (!mq) return;
    const handler = (e) => setIsMobile(e.matches);
    if (mq.addEventListener) mq.addEventListener("change", handler);
    else mq.addListener(handler);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", handler);
      else mq.removeListener(handler);
    };
  }, []);

  useEffect(() => {
    const mq = globalThis.matchMedia?.("(min-width: 1200px)");
    if (!mq) return;
    const handler = (e) => setIsDesktop(e.matches);
    if (mq.addEventListener) mq.addEventListener("change", handler);
    else mq.addListener(handler);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", handler);
      else mq.removeListener(handler);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return undefined;
    }

    const root = document.documentElement;
    const viewport = window.visualViewport;

    const updateKeyboardOffset = () => {
      if (!viewport) {
        root.style.setProperty("--chat-keyboard-offset", "0px");
        return;
      }

      const keyboardOffset = Math.max(
        0,
        Math.round(window.innerHeight - viewport.height - viewport.offsetTop),
      );
      root.style.setProperty("--chat-keyboard-offset", `${keyboardOffset}px`);
      if (keyboardOffset > 0) {
        root.setAttribute("data-chat-keyboard-open", "true");
      } else {
        root.removeAttribute("data-chat-keyboard-open");
      }
    };

    updateKeyboardOffset();

    if (!viewport) return () => {
      root.style.setProperty("--chat-keyboard-offset", "0px");
      root.removeAttribute("data-chat-keyboard-open");
    };

    viewport.addEventListener("resize", updateKeyboardOffset);
    viewport.addEventListener("scroll", updateKeyboardOffset);
    window.addEventListener("orientationchange", updateKeyboardOffset);

    return () => {
      viewport.removeEventListener("resize", updateKeyboardOffset);
      viewport.removeEventListener("scroll", updateKeyboardOffset);
      window.removeEventListener("orientationchange", updateKeyboardOffset);
      root.style.setProperty("--chat-keyboard-offset", "0px");
      root.removeAttribute("data-chat-keyboard-open");
    };
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    if (focusMode) {
      document.documentElement.dataset.chatFocus = "true";
    } else {
      delete document.documentElement.dataset.chatFocus;
    }
    try {
      localStorage.setItem("ve-chat-focus", String(focusMode));
    } catch {
      /* ignore storage errors */
    }
    return () => {
      delete document.documentElement.dataset.chatFocus;
    };
  }, [focusMode]);

  useEffect(() => {
    if (!isMobile) {
      setDrawerOpen(false);
      return;
    }
    setDrawerOpen(false);
  }, [isMobile, sessionId]);

  useEffect(() => {
    if (!routeSessionId) return;
    if (sessionId === routeSessionId) return;
    selectedSessionId.value = routeSessionId;
  }, [routeSessionId]);

  useEffect(() => {
    if (sessionId) {
      setRouteParams({ sessionId }, { replace: true, skipGuard: true });
    } else {
      setRouteParams({}, { replace: true, skipGuard: true });
    }
  }, [sessionId]);

  /* ── Auto-focus textarea when switching sessions (desktop only) ── */
  useEffect(() => {
    if (!sessionId || isMobile) return;
    // Delay focus to let the ChatView mount first
    const timer = setTimeout(() => {
      if (textareaRef.current) textareaRef.current.focus();
    }, 150);
    return () => clearTimeout(timer);
  }, [sessionId, isMobile]);

  /* ── Slash command filtering ──
     Use useMemo with no signal deps to avoid subscribing ChatTab to
     activeAgentInfo. The commands list only matters when the user is
     actively typing, and the input handler re-renders anyway. */
  const allCommands = useMemo(() => getSlashCommands(), []);
  const filteredSlash = allCommands.filter((c) =>
    c.cmd.toLowerCase().startsWith((slashFilter || "").toLowerCase()),
  );

  /* ── Determine if a command is an SDK command ── */
  function isSdkCommand(cmdBase) {
    const info = activeAgentInfo.peek();
    const sdkCmds = info?.capabilities?.sdkCommands || [];
    return sdkCmds.includes(cmdBase);
  }

  /* ── Input handling with slash command detection ── */
  function handleInputChange(e) {
    const val = e.target.value;
    setInputValue(val);

    // Auto-grow textarea
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";

    if (val.startsWith("/")) {
      setShowSlashMenu(true);
      setSlashFilter(val.split(/\s/)[0]); // filter on first word only
      setSlashActiveIdx(0);
    } else {
      setShowSlashMenu(false);
      setSlashFilter("");
    }
  }

  /* ── Select a slash command from popup ── */
  function selectSlashCommand(cmd) {
    setInputValue(cmd + " ");
    setShowSlashMenu(false);
    setSlashFilter("");
    if (textareaRef.current) textareaRef.current.focus();
  }

  /* ── Send message or command ── */
  async function handleSend(explicitContent) {
    const content = (typeof explicitContent === "string" ? explicitContent : inputValue).trim();
    const attachments = Array.isArray(pendingAttachments)
      ? pendingAttachments.filter(Boolean)
      : [];
    if ((!content && attachments.length === 0) || sending || uploadingAttachments) return;

    setShowSlashMenu(false);
    setSending(true);

    const cmdBase = content.startsWith("/") ? content.split(/\s/)[0].toLowerCase() : "";
    const cmdArgs = cmdBase ? content.slice(cmdBase.length).trim() : "";
    const modeOverride = MESSAGE_MODE_COMMANDS[cmdBase] || null;
    const asModeMessage = Boolean(modeOverride && cmdArgs);
    const outboundContent = asModeMessage ? cmdArgs : content;
    const outboundMode = modeOverride || agentMode.value;
    let createdSessionId = "";

    try {
      if (content.startsWith("/") && !asModeMessage) {
        if (isSdkCommand(cmdBase)) {
          // Forward to agent SDK
          const resp = await apiFetch("/api/agents/sdk-command", {
            method: "POST",
            body: JSON.stringify({
              command: cmdBase,
              args: cmdArgs,
              sessionId: sessionId || undefined,
            }),
          });
          const resultText = resp?.result || resp?.data || `:check: SDK command executed: ${cmdBase}`;
          if (sessionId) {
            const { sessionMessages } = await import("../../../ui/components/session-list.js");
            const now = new Date().toISOString();
            const msgs = sessionMessages.value || [];
            const userMsg = { id: `sdk-${Date.now()}`, role: "user", content, timestamp: now };
            const sysMsg = { id: `sdk-r-${Date.now()}`, role: "system", content: typeof resultText === "string" ? resultText : JSON.stringify(resultText), timestamp: now };
            sessionMessages.value = [...msgs, userMsg, sysMsg];
          } else {
            showToast("SDK command: " + cmdBase, "success");
          }
        } else {
          // Bosun command
          const resp = await apiFetch("/api/command", {
            method: "POST",
            body: JSON.stringify({ command: content }),
          });
          const data = resp?.data;
          if (sessionId) {
            const { sessionMessages } = await import("../../../ui/components/session-list.js");
            const now = new Date().toISOString();
            const msgs = sessionMessages.value || [];
            const userMsg = { id: `cmd-${Date.now()}`, role: "user", content, timestamp: now };
            const resultText = data?.content || data?.error
              || (data?.readOnly ? `:check: ${cmdBase} — see the relevant tab for details.` : `:check: Command executed: ${cmdBase}`);
            const sysMsg = { id: `cmd-r-${Date.now()}`, role: "system", content: resultText, timestamp: now };
            sessionMessages.value = [...msgs, userMsg, sysMsg];
          } else {
            showToast("Command sent: " + cmdBase, "success");
          }
        }
      } else if (sessionId) {
        // Send as message to current session with optimistic rendering
        const tempId = addPendingMessage(sessionId, outboundContent, attachments);
        markUserMessageSent(activeAgent.value, sessionId);

        // Use sendOrQueue for offline resilience
        const sendFn = async (sid, msg) => {
          const messagePath = sessionApiPath(sid, "message");
          if (!messagePath) {
            throw new Error("Session path unavailable");
          }
          await apiFetch(messagePath, {
            method: "POST",
            body: JSON.stringify({
              content: msg,
              mode: outboundMode,
              agentProfileId: activeManualAgentId.value || undefined,
              yolo: yoloMode.peek(),
              model: selectedModel.value || undefined,
              attachments,
            }),
          });
        };

        try {
          await sendOrQueue(sessionId, outboundContent, sendFn);
          confirmMessage(tempId);
        } catch (err) {
          rejectMessage(tempId, err.message || "Send failed");
          throw err;
        }

        loadSessionMessages(sessionId, { limit: 50 });
      } else {
        // No session — create one with current agent/mode, then send first message
        const res = await createSession({
          type: "primary",
          ...(outboundContent ? { prompt: outboundContent } : {}),
          agent: activeAgent.value,
          mode: outboundMode,
          agentProfileId: activeManualAgentId.value || undefined,
          yolo: yoloMode.peek(),
          model: selectedModel.value || undefined,
        });
        const newId = res?.session?.id;
        if (newId) {
          createdSessionId = String(newId);
          const tempId = addPendingMessage(newId, outboundContent, attachments);
          markUserMessageSent(activeAgent.value, newId);

          try {
            const messagePath = sessionApiPath(newId, "message");
            if (!messagePath) {
              throw new Error("Session path unavailable");
            }
            await apiFetch(messagePath, {
              method: "POST",
              body: JSON.stringify({
                content: outboundContent,
                mode: outboundMode,
                yolo: yoloMode.peek(),
                model: selectedModel.value || undefined,
                attachments,
              }),
            });
            confirmMessage(tempId);
          } catch (err) {
            rejectMessage(tempId, err.message || "Send failed");
          }

          loadSessionMessages(newId, { limit: 50 });
        }
      }
    } catch (err) {
      showToast("Failed to send: " + (err.message || "Unknown error"), "error");
    } finally {
      if (typeof explicitContent !== "string") setInputValue("");
      setPendingAttachments([]);
      const currentCacheKey = String(sessionId || DRAFT_SESSION_KEY);
      pendingDraftTextBySessionId.delete(currentCacheKey);
      pendingAttachmentsBySessionId.delete(currentCacheKey);
      if (createdSessionId && createdSessionId !== currentCacheKey) {
        pendingDraftTextBySessionId.delete(createdSessionId);
        pendingAttachmentsBySessionId.delete(createdSessionId);
      }
      persistDraftTextCache();
      persistDraftAttachmentCache();
      setDragActive(false);
      chatDropDepthRef.current = 0;
      setSending(false);
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    }
  }

  /* ── Stop agent ── */
  async function handleStop() {
    if (stoppingAgent) return;
    setStoppingAgent(true);
    try {
      const activeId = String(activeAgent.peek() || "").trim();
      const optimisticMarkIdle = () => {
        if (!activeId) return;
        const list = Array.isArray(availableAgents.peek()) ? availableAgents.peek() : [];
        if (!list.length) return;
        let changed = false;
        const next = list.map((agent) => {
          if (agent?.id !== activeId || agent?.busy === false) return agent;
          changed = true;
          return { ...agent, busy: false };
        });
        if (changed) availableAgents.value = next;
      };

      if (sessionId) {
        const stopPath = sessionApiPath(sessionId, "stop");
        if (!stopPath) {
          throw new Error("Session path unavailable");
        }
        const stopResult = await apiFetch(stopPath, {
          method: "POST",
          body: JSON.stringify({}),
        });
        if (stopResult?.stopped) {
          optimisticMarkIdle();
          showToast("Stopped current agent turn", "info");
        } else {
          showToast("No active agent turn to stop", "info");
          setStoppingAgent(false);
          return;
        }
      } else {
        await apiFetch("/api/command", {
          method: "POST",
          body: JSON.stringify({ command: "/stop" }),
        });
        optimisticMarkIdle();
        showToast("Agent stopped", "info");
      }

      try { await loadAvailableAgents(); } catch { /* best effort */ }
    } catch (err) {
      setStoppingAgent(false);
      showToast("Stop failed: " + (err.message || "Unknown error"), "error");
    }
  }

  /* ── Stop then send ── */
  async function handleStopAndSend() {
    setShowSendMenu(false);
    await handleStop();
    await handleSend();
  }

  /* ── Add message to queue for delivery after current task ── */
  function handleAddToQueue() {
    const content = inputValue.trim();
    if (!content) return;
    setShowSendMenu(false);
    messageQueueRef.current.push(content);
    setQueueCount(messageQueueRef.current.length);
    setInputValue("");
    showToast(`Message queued (${messageQueueRef.current.length} pending)`, "success");
  }

  /* ── Steer with message (send to running session) ── */
  async function handleSteerWithMessage() {
    setShowSendMenu(false);
    await handleSend();
  }

  /* ── Auto-send queued messages when agent becomes free ── */
  useEffect(() => {
    if (!sending && messageQueueRef.current.length > 0) {
      const next = messageQueueRef.current.shift();
      setQueueCount(messageQueueRef.current.length);
      handleSend(next);
    }
  }, [sending]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Close send menu when clicking outside ── */
  useEffect(() => {
    if (!showSendMenu) return;
    function handleOutside(e) {
      if (sendMenuRef.current && !sendMenuRef.current.contains(e.target)) {
        setShowSendMenu(false);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [showSendMenu]);

  // Clear one-shot stop UI lock as soon as the selected agent reports idle.
  useEffect(() => {
    if (!stoppingAgent) return;
    if (!activeAgentInfo.value?.busy) {
      setStoppingAgent(false);
    }
  }, [stoppingAgent, activeAgentInfo.value?.busy]);

  /* ── Keyboard handling ── */
  function handleKeyDown(e) {
    // Slash menu navigation
    if (showSlashMenu && filteredSlash.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashActiveIdx((prev) =>
          prev < filteredSlash.length - 1 ? prev + 1 : 0,
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashActiveIdx((prev) =>
          prev > 0 ? prev - 1 : filteredSlash.length - 1,
        );
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        selectSlashCommand(filteredSlash[slashActiveIdx].cmd);
        return;
      }
      if (e.key === "Escape") {
        setShowSlashMenu(false);
        return;
      }
    }

    // Alt+Enter = Add to Queue
    if (e.key === "Enter" && e.altKey) {
      e.preventDefault();
      handleAddToQueue();
      return;
    }

    // Send on Enter (shift+enter = newline)
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  /* ── Session rename ── */
  async function saveRename(sid, newTitle) {
    try {
      const renamePath = sessionApiPath(sid, "rename");
      if (!renamePath) {
        throw new Error("Session path unavailable");
      }
      await apiFetch(renamePath, {
        method: "POST",
        body: JSON.stringify({ title: newTitle }),
      });
      refreshPrimarySessions();
      showToast("Session renamed", "success");
    } catch {
      showToast("Failed to rename session", "error");
    } finally {
      setRenamingSessionId(null);
    }
  }

  function cancelRename() {
    setRenamingSessionId(null);
  }

  /* ── Quick command (from welcome screen) ── */
  async function handleQuickCommand(cmd) {
    try {
      await apiFetch("/api/command", {
        method: "POST",
        body: JSON.stringify({ command: cmd }),
      });
      showToast("Command sent: " + cmd, "success");
    } catch {
      showToast("Failed to send command", "error");
    }
  }

  /* ── Handle new session from welcome ── */
  async function handleNewSession() {
    await createSession({ type: "primary" });
  }

  const openMeetingRoom = useCallback(
    (call = "voice") => {
      requestVoiceModeOpen({
        call: call === "video" ? "video" : "voice",
        sessionId: sessionId || undefined,
        initialVisionSource: call === "video" ? "camera" : null,
        executor: activeAgent.value || undefined,
        mode: agentMode.value || undefined,
        model: selectedModel.value || undefined,
      });
    },
    [sessionId],
  );

  /* ── Show/expand sessions: on mobile toggles drawer, on desktop fires rail-expand event ── */
  const handleShowSessions = useCallback(() => {
    if (isMobile) {
      setDrawerOpen(true);
    } else if (isDesktop) {
      globalThis.dispatchEvent?.(new CustomEvent("ve:expand-rail"));
    } else {
      // Tablet: toggle the session-pane drawer
      setDrawerOpen((v) => !v);
    }
  }, [isMobile, isDesktop]);

  const handleBack = useCallback(() => {
    if (isMobile) {
      selectedSessionId.value = null;
      setDrawerOpen(false);
      return;
    }
    selectedSessionId.value = null;
  }, [isMobile]);

  const handleSelectSession = useCallback(() => {
    if (isMobile) setDrawerOpen(false);
  }, [isMobile]);

  const activeSession = useMemo(() => {
    try {
      return (sessionsData.peek() || []).find((s) => s.id === sessionId) || null;
    } catch {
      return null;
    }
  }, [sessionId]);
  const resolveWorkspaceForSessionId = useCallback((targetSessionId, fallback = "active") => {
    const safeTarget = String(targetSessionId || "").trim();
    if (!safeTarget) return resolveSessionWorkspaceHint(activeSession, fallback);
    const match = (sessionsData.peek() || []).find((s) => String(s?.id || "") === safeTarget) || null;
    if (match) return resolveSessionWorkspaceHint(match, fallback);
    if (safeTarget === String(sessionId || "").trim()) {
      return resolveSessionWorkspaceHint(activeSession, fallback);
    }
    return resolveSessionWorkspaceHint(null, fallback);
  }, [activeSession, sessionId]);
  const sessionApiPath = useCallback((targetSessionId, action = "", fallbackWorkspace = "active") => {
    const safeTarget = String(targetSessionId || "").trim();
    if (!safeTarget) return "";
    return buildSessionApiPath(safeTarget, action, {
      workspace: resolveWorkspaceForSessionId(safeTarget, fallbackWorkspace),
    });
  }, [resolveWorkspaceForSessionId]);
  const sessionTitle = activeSession?.title || activeSession?.taskId || "Session";
  const sessionLifecycle = getSessionLifecycleState(activeSession);
  const sessionRuntime = getSessionRuntimeState(activeSession);
  const sessionFreshnessAt = getSessionRecencyTimestamp(activeSession);
  const sessionFreshnessLabel = sessionFreshnessAt ? new Date(sessionFreshnessAt).toLocaleString() : "unknown";
  const sessionMeta = [
    activeSession?.type,
    `Lifecycle: ${sessionLifecycle.label}`,
    `Runtime: ${sessionRuntime.label}`,
    `Freshness: ${sessionFreshnessLabel}`,
  ]
    .filter(Boolean)
    .join(" · ");

  useEffect(() => {
    const key = String(sessionId || DRAFT_SESSION_KEY);
    const cachedAttachments = pendingAttachmentsBySessionId.get(key);
    const cachedDraft = pendingDraftTextBySessionId.get(key);
    setPendingAttachments(Array.isArray(cachedAttachments) ? [...cachedAttachments] : []);
    setInputValue(typeof cachedDraft === "string" ? cachedDraft : "");
    setUploadingAttachments(false);
    setDragActive(false);
    chatDropDepthRef.current = 0;
  }, [sessionId]);

  useEffect(() => {
    const key = String(sessionId || DRAFT_SESSION_KEY);
    const text = String(inputValue || "");
    if (text.trim()) {
      pendingDraftTextBySessionId.set(key, text);
    } else {
      pendingDraftTextBySessionId.delete(key);
    }
    persistDraftTextCache();
  }, [sessionId, inputValue]);

  useEffect(() => {
    const key = String(sessionId || DRAFT_SESSION_KEY);
    if (pendingAttachments.length > 0) {
      pendingAttachmentsBySessionId.set(key, [...pendingAttachments]);
    } else {
      pendingAttachmentsBySessionId.delete(key);
    }
    persistDraftAttachmentCache();
  }, [sessionId, pendingAttachments]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const clearDragState = () => {
      chatDropDepthRef.current = 0;
      setDragActive(false);
    };
    window.addEventListener("dragend", clearDragState);
    window.addEventListener("drop", clearDragState);
    return () => {
      window.removeEventListener("dragend", clearDragState);
      window.removeEventListener("drop", clearDragState);
    };
  }, []);

  const uploadAttachments = useCallback(async (files) => {
    if (uploadingAttachments) return;
    const list = Array.from(files || []).filter(Boolean);
    if (!list.length) return;
    setUploadingAttachments(true);
    try {
      let targetSessionId = String(sessionId || "").trim();
      if (!targetSessionId) {
        const created = await createSession({
          type: "primary",
          agent: activeAgent.value || undefined,
          mode: agentMode.value || undefined,
          model: selectedModel.value || undefined,
        });
        targetSessionId = String(created?.session?.id || "").trim();
      }
      if (!targetSessionId) {
        showToast("Could not create a session for attachments", "error");
        return;
      }
      const form = new FormData();
      for (const file of list) {
        form.append("file", file, file.name || "attachment");
      }
      const attachmentsPath = sessionApiPath(targetSessionId, "attachments");
      if (!attachmentsPath) {
        showToast("Attachment upload failed", "error");
        return;
      }
      const res = await apiFetch(attachmentsPath, {
        method: "POST",
        body: form,
      });
      if (Array.isArray(res?.attachments) && res.attachments.length > 0) {
        const cacheKey = String(targetSessionId || DRAFT_SESSION_KEY);
        setPendingAttachments((prev) => {
          const base = prev.length > 0
            ? prev
            : Array.isArray(pendingAttachmentsBySessionId.get(cacheKey))
              ? pendingAttachmentsBySessionId.get(cacheKey)
              : [];
          const next = [...base, ...res.attachments];
          pendingAttachmentsBySessionId.set(cacheKey, next);
          return next;
        });
      } else {
        showToast("Attachment upload failed", "error");
      }
    } catch {
      showToast("Attachment upload failed", "error");
    } finally {
      setUploadingAttachments(false);
    }
  }, [sessionId, uploadingAttachments, sessionApiPath]);

  const removeAttachment = useCallback((index) => {
    setPendingAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleAttachmentInput = useCallback((e) => {
    const files = e.target?.files;
    if (files && files.length) {
      uploadAttachments(files);
    }
    if (e.target) e.target.value = "";
  }, [uploadAttachments]);

  const handleInputPaste = useCallback((e) => {
    const files = e.clipboardData?.files;
    if (files && files.length) {
      e.preventDefault();
      uploadAttachments(files);
    }
  }, [uploadAttachments]);

  const handleChatDragEnter = useCallback((e) => {
    if (!hasDragFiles(e)) return;
    e.preventDefault();
    chatDropDepthRef.current += 1;
    if (!dragActive) setDragActive(true);
  }, [dragActive]);

  const handleChatDragOver = useCallback((e) => {
    if (!hasDragFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    if (!dragActive) setDragActive(true);
  }, [dragActive]);

  const handleChatDragLeave = useCallback((e) => {
    if (!dragActive) return;
    e.preventDefault();
    chatDropDepthRef.current = Math.max(0, chatDropDepthRef.current - 1);
    if (chatDropDepthRef.current === 0 && dragActive) {
      setDragActive(false);
    }
  }, [dragActive]);

  const handleChatDrop = useCallback((e) => {
    if (!dragActive && !hasDragFiles(e)) return;
    e.preventDefault();
    chatDropDepthRef.current = 0;
    setDragActive(false);
    const files = e.dataTransfer?.files;
    if (files && files.length) {
      uploadAttachments(files);
    }
  }, [uploadAttachments]);

  /* ── Render ── */

  // If we hit a critical error during signal reads, show recovery UI
  if (chatError) {
    return html`
      <${Box} className="session-panel" sx=${{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", p: 3 }}>
        <${Stack} alignItems="center" spacing=${1.5}>
          <${Typography} sx=${{ fontSize: 28 }}>${resolveIcon("alert")}<//>
          <${Typography} variant="subtitle1" fontWeight=${600}>Chat failed to load<//>
          <${Typography} variant="caption" color="text.secondary">${chatError}<//>
          <${Button} variant="contained" size="small" onClick=${() => setChatError(null)}>Retry<//>
        <//>
      <//>
    `;
  }

  return html`
    <${Box} className="session-panel">
      <${Box}
        className=${`session-split ${sessionId ? 'has-active-session' : ''} ${drawerOpen ? 'drawer-open' : ''}`}
        data-mobile=${isMobile ? "true" : "false"}
      >
        <!-- Left panel: Sessions sidebar -->
        <${Box} className="session-pane">
          <${ChatSafeBoundary} label="Session List">
            <${SessionList}
              showArchived=${showArchived}
              onToggleArchived=${setShowArchived}
              sessionView=${sessionView}
              onSessionViewChange=${(nextView) => {
                setSessionView(nextView);
                refreshPrimarySessions(nextView).catch(() => {});
              }}
              defaultType="primary"
              renamingSessionId=${renamingSessionId}
              onStartRename=${(sid) => setRenamingSessionId(sid)}
              onSaveRename=${saveRename}
              onCancelRename=${cancelRename}
              onSelect=${handleSelectSession}
            />
          <//>
        <//>

        <!-- Right panel: Chat area -->
        <${Box}
          className="session-detail"
          onDragEnter=${handleChatDragEnter}
          onDragOver=${handleChatDragOver}
          onDragLeave=${handleChatDragLeave}
          onDrop=${handleChatDrop}
        >
          ${(sessionId || isMobile) &&
          html`
            <${Paper} elevation=${1} className="chat-shell-header" sx=${{ borderRadius: 0 }}>
              <${Box} className="chat-shell-inner" sx=${{ display: "flex", alignItems: "center", gap: 1.5, px: 2, py: 1 }}>
                <!-- Sessions toggle: shown on mobile always; on desktop only when rail is collapsed (CSS-controlled) -->
                <${IconButton} className="session-drawer-btn session-drawer-btn-rail" onClick=${handleShowSessions} size="small">
                  ${resolveIcon("menu")}
                <//>
                <${Box} className="chat-shell-title" sx=${{ flex: 1, minWidth: 0 }}>
                  <${Typography} variant="subtitle1" noWrap fontWeight=${600}>${sessionId ? sessionTitle : "New chat"}<//>
                  <${Typography} variant="caption" color="text.secondary" noWrap>${sessionId ? (sessionMeta || "Session") : "Open sessions or start a new chat"}<//>
                <//>
                ${sessionId
                  ? html`
                      <${Stack} direction="row" spacing=${0.5} className="chat-shell-actions">
                        <${Button}
                          variant="text"
                          size="small"
                          onClick=${() => openMeetingRoom("voice")}
                          title="Start voice meeting for this session"
                          startIcon=${resolveIcon("phone")}
                          sx=${{ textTransform: "none" }}
                        >
                          Call
                        <//>
                        <${Button}
                          variant="text"
                          size="small"
                          onClick=${() => openMeetingRoom("video")}
                          title="Start video meeting for this session"
                          startIcon=${resolveIcon("camera")}
                          sx=${{ textTransform: "none" }}
                        >
                          Video
                        <//>
                        ${isDesktop &&
                        html`
                          <${Button}
                            variant="text"
                            size="small"
                            onClick=${() => setFocusMode((prev) => !prev)}
                            title=${focusMode ? "Exit focus mode" : "Enter focus mode"}
                            sx=${{ textTransform: "none" }}
                          >
                            ${focusMode ? "Exit Focus" : "Focus"}
                          <//>
                        `}
                        ${sessionLifecycle.key === "archived"
                          ? html`
                              <${Button}
                                variant="text"
                                size="small"
                                onClick=${() => resumeSession(activeSession.id)}
                                sx=${{ textTransform: "none" }}
                              >
                                Restore
                              <//>
                            `
                          : html`
                              <${Button}
                                variant="text"
                                size="small"
                                onClick=${() => archiveSession(activeSession.id)}
                                sx=${{ textTransform: "none" }}
                              >
                                Archive
                              <//>
                            `}
                      <//>
                    `
                  : null}
              <//>
            <//>
          `}
          ${sessionId
            ? html`<${ChatSafeBoundary} label="Chat View"><${ChatView} sessionId=${sessionId} readOnly embedded /><//>`
            : html`
                <${ChatWelcome}
                  onNewSession=${handleNewSession}
                  onQuickCommand=${handleQuickCommand}
                />
              `}

          <!-- Bottom input area (always visible) -->
          <${Box} className="chat-input-area">
            ${showSlashMenu &&
            html`
              <${SlashMenu}
                filter=${slashFilter}
                onSelect=${selectSlashCommand}
                activeIndex=${slashActiveIdx}
                commands=${allCommands}
              />
            `}
            <${ChatSafeBoundary} label="Agent Toolbar">
              <${ChatInputToolbar} />
            <//>
            ${pendingAttachments.length > 0 && html`
              <${Stack} direction="row" spacing=${0.5} flexWrap="wrap" className="chat-attachments-pending" sx=${{ px: 1, py: 0.5 }}>
                ${pendingAttachments.map((att, index) => html`
                  <${Chip}
                    key=${att.id || `${att.name}-${index}`}
                    label=${`${att.name || "attachment"}${att.size ? ` (${formatAttachmentSize(att.size)})` : ""}`}
                    onDelete=${() => removeAttachment(index)}
                    size="small"
                    variant="outlined"
                  />
                `)}
                ${uploadingAttachments && html`
                  <${Chip} label="Uploading..." size="small" icon=${html`<${CircularProgress} size=${14} />`} />
                `}
              <//>
            `}
            <${Box} className="chat-input-wrapper" sx=${{ display: "flex", alignItems: "flex-end", gap: 0.5, px: 1, py: 0.5 }}>
              <${TextField}
                inputRef=${fileInputRef}
                type="file"
                size="small"
                variant="outlined"
                inputProps=${{ multiple: true }}
                sx=${{ display: "none" }}
                onChange=${handleAttachmentInput}
              />
              <${IconButton}
                size="small"
                disabled=${uploadingAttachments}
                onClick=${() => fileInputRef.current?.click?.()}
                title="Attach file"
              >
                ${resolveIcon(":link:")}
              <//>
              <${TextField}
                inputRef=${textareaRef}
                className=${dragActive ? "chat-input-drag" : ""}
                placeholder=${sessionId
                  ? 'Send a message… (type "/" for commands)'
                  : 'Start a new chat or type "/" for commands'}
                multiline
                maxRows=${4}
                fullWidth
                size="small"
                variant="outlined"
                value=${inputValue}
                onInput=${handleInputChange}
                onKeyDown=${handleKeyDown}
                onPaste=${handleInputPaste}
                sx=${{ "& .MuiOutlinedInput-root": { borderRadius: 2 } }}
              />
              <${VoiceMicButton}
                disabled=${sending}
                title="Live voice mode"
              />
              ${activeAgentInfo.value?.busy && !stoppingAgent && html`
                <${IconButton}
                  onClick=${handleStop}
                  title="Stop agent"
                  aria-label="Stop agent"
                  size="small"
                  color="error"
                >⏹<//>
              `}
              <${Box} className="chat-send-group" ref=${sendMenuRef} sx=${{ display: "flex", position: "relative" }}>
                <${IconButton}
                  color="primary"
                  disabled=${(!inputValue.trim() && pendingAttachments.length === 0) || uploadingAttachments}
                  onClick=${activeAgentInfo.value?.busy ? handleSteerWithMessage : handleSend}
                  title=${activeAgentInfo.value?.busy ? "Steer with Message (Enter)" : "Send (Enter)"}
                  size="small"
                >➤<//>
                <${IconButton}
                  size="small"
                  disabled=${(!inputValue.trim() && pendingAttachments.length === 0) || uploadingAttachments}
                  onClick=${(e) => { e.stopPropagation(); setShowSendMenu(v => !v); }}
                  aria-label="Send options"
                  title="Send options"
                >▾<//>
                ${showSendMenu && html`
                  <${Paper} elevation=${4} className="chat-send-menu" sx=${{ position: "absolute", bottom: "100%", right: 0, minWidth: 200, borderRadius: 2, overflow: "hidden", zIndex: 10 }}>
                    <${List} dense disablePadding>
                      <${ListItemButton} onClick=${handleStopAndSend}>
                        <${ListItemIcon} sx=${{ minWidth: 28 }}>⊳<//>
                        <${ListItemText} primary="Stop and Send" />
                      <//>
                      <${ListItemButton} onClick=${handleAddToQueue}>
                        <${ListItemIcon} sx=${{ minWidth: 28 }}>+<//>
                        <${ListItemText} primary="Add to Queue" secondary="Alt+Enter" />
                      <//>
                      <${ListItemButton} selected onClick=${handleSteerWithMessage}>
                        <${ListItemIcon} sx=${{ minWidth: 28 }}>→<//>
                        <${ListItemText} primary="Steer with Message" secondary="Enter" />
                      <//>
                    <//>
                  <//>
                `}
              <//>
            <//>
            <${Stack} direction="row" spacing=${1} className="chat-input-hint" sx=${{ px: 1.5, py: 0.5 }}>
              <${Typography} variant="caption" color="text.secondary">Shift+Enter for new line<//>
              <${Typography} variant="caption" color="text.secondary">Type / for commands<//>
              ${offlineQueueSize.peek() > 0 && html`
                <${Chip} label=${`${offlineQueueSize.peek()} queued`} size="small" color="warning" variant="outlined" />
              `}
              ${queueCount > 0 && html`
                <${Chip} label=${`⏳ ${queueCount} pending`} size="small" color="info" variant="outlined" />
              `}
            <//>
          <//>
          ${dragActive && html`
            <${Box}
              className="chat-drop-overlay"
              sx=${{
                position: "absolute",
                inset: 0,
                zIndex: 25,
                pointerEvents: "none",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <${Paper}
                elevation=${6}
                sx=${{
                  px: 3,
                  py: 2,
                  borderRadius: 2,
                  border: "1px dashed",
                  borderColor: "primary.main",
                  bgcolor: "background.paper",
                  minWidth: 240,
                  textAlign: "center",
                }}
              >
                <${Typography} variant="subtitle2" sx=${{ mb: 0.5 }}>
                  Drop files to attach
                <//>
                <${Typography} variant="caption" color="text.secondary">
                  Files can be dropped anywhere in this chat.
                <//>
              <//>
            <//>
          `}
        <//>
      <//>
      ${focusMode && html`
        <${IconButton}
          className="focus-exit-fab"
          onClick=${() => setFocusMode(false)}
          title="Exit focus mode"
          sx=${{ position: "fixed", bottom: 16, right: 16, zIndex: 1000, bgcolor: "background.paper", boxShadow: 3 }}
        >${resolveIcon("close")}<//>
      `}
      ${isMobile &&
      html`
        <${Box}
          className=${`session-drawer-backdrop ${drawerOpen ? "open" : ""}`}
          onClick=${() => setDrawerOpen(false)}
        />
      `}
    <//>
  `;
}
