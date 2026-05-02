/* ─────────────────────────────────────────────────────────────
 *  Component: Chat View — ChatGPT-style message interface
 *  with real-time WS push, optimistic rendering, agent status
 *  tracking, and pending/retry message support.
 *
 *  UI layer: MUI Material (Paper, Typography, Box, etc.)
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import { memo } from "preact/compat";
import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from "preact/hooks";
import htm from "htm";
import { apiFetch } from "../../../ui/modules/api.js";
import { buildSessionApiPath, resolveSessionWorkspaceHint } from "../../../ui/modules/session-api.js";
import { buildTraceTimelineBlocks } from "../../../ui/modules/stream-timeline.js";
import { showToast } from "../../../ui/modules/state.js";
import { formatRelative, truncate, formatBytes } from "../../../ui/modules/utils.js";
import { resolveIcon } from "../../../ui/modules/icon-utils.js";
import {
  Paper, Typography, Box, Stack, IconButton, TextField,
  InputAdornment, Chip, CircularProgress, Skeleton, Tooltip,
  Divider, Avatar, Button, ButtonGroup, Collapse, Alert, Fab,
} from "@mui/material";
import {
  sessionMessages,
  sessionMessagesSessionId,
  loadSessionMessages,
  loadSessions,
  sessionsData,
  sessionPagination,
} from "../../../ui/components/session-list.js";
import {
  pendingMessages,
  typingIndicator,
  agentStatus,
  agentStatusText,
  startAgentStatusTracking,
  retryPendingMessage,
  clearPendingMessages,
} from "../../../ui/modules/streaming.js";
import {
  startAgentEventTracking,
  agentAutoActions,
  totalErrorCount,
} from "../../../ui/modules/agent-events.js";

const html = htm.bind(h);

const AUTO_ACTION_LABELS = {
  "agent:auto-retry": "Auto Retry",
  "agent:auto-review": "Auto Review",
  "agent:auto-cooldown": "Cooldown",
  "agent:auto-block": "Auto Block",
  "agent:auto-new-session": "New Session",
  "agent:executor-paused": "Executor Paused",
  "agent:executor-resumed": "Executor Resumed",
};

const SCROLL_BOTTOM_TOLERANCE_PX = 6;
const SCROLL_BOTTOM_RATIO = 0.995;
const CHAT_PAGE_SIZE = 50;
const SCROLL_TOP_TRIGGER_PX = 24;
const SCROLL_TOP_REARM_PX = 80;
const TRACE_VERBOSITY_STORAGE_KEY = "bosun.chat.traceVerbosity";

const TIMELINE_PHASE_META = {
  thinking: { label: "Thinking", color: "warning", accent: "#d97706" },
  tool_call: { label: "Tool Call", color: "info", accent: "#0284c7" },
  output: { label: "Output", color: "success", accent: "#16a34a" },
  file_exploration: { label: "File Exploration", color: "primary", accent: "#2563eb" },
  patch_result: { label: "Patch Result", color: "success", accent: "#059669" },
  error: { label: "Error", color: "error", accent: "#dc2626" },
};

function formatAutoAction(event) {
  if (!event) return null;
  const label =
    AUTO_ACTION_LABELS[event.type] ||
    event.type.replace(/^agent:/, "").replace(/-/g, " ");
  const task =
    event.payload?.title ||
    event.payload?.branch ||
    event.payload?.taskId ||
    event.taskId ||
    "";
  return {
    label,
    task: truncate(task, 28),
    ts: event.ts || Date.now(),
  };
}

/* ─── Inline markdown formatting ─── */
function applyInline(text) {
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__(.+?)__/g, '<strong>$1</strong>');
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
  text = text.replace(/(?<![a-zA-Z0-9])_(.+?)_(?![a-zA-Z0-9])/g, '<em>$1</em>');
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    if (/^(https?:|mailto:|\/|#)/.test(url)) {
      return `<a href="${url}" target="_blank" rel="noopener" class="md-link">${label}</a>`;
    }
    return `${label} (${url})`;
  });
  return text;
}

/* ─── Convert markdown text to HTML ─── */
function renderMarkdown(text) {
  const codes = [];
  let s = text.replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `%%ICODE${codes.length - 1}%%`;
  });

  s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const lines = s.split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    let m;

    if ((m = line.match(/^(#{1,3}) (.+)$/))) {
      const lvl = m[1].length;
      out.push(`<div class="md-heading md-h${lvl}">${applyInline(m[2])}</div>`);
      i++; continue;
    }

    if (/^-{3,}\s*$/.test(line.trim())) {
      out.push('<hr class="md-hr"/>');
      i++; continue;
    }

    if (/^&gt;\s?/.test(line)) {
      const q = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) {
        q.push(applyInline(lines[i].replace(/^&gt;\s?/, '')));
        i++;
      }
      out.push(`<div class="md-blockquote">${q.join('<br/>')}</div>`);
      continue;
    }

    if (/^[-*] /.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) {
        items.push(`<li>${applyInline(lines[i].replace(/^[-*] /, ''))}</li>`);
        i++;
      }
      out.push(`<ul class="md-list">${items.join('')}</ul>`);
      continue;
    }

    if (/^\d+\.\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(`<li>${applyInline(lines[i].replace(/^\d+\.\s/, ''))}</li>`);
        i++;
      }
      out.push(`<ol class="md-list md-ol">${items.join('')}</ol>`);
      continue;
    }

    out.push(applyInline(line));
    i++;
  }

  let result = out.join('\n').replace(/\n/g, '<br/>');

  result = result.replace(/%%ICODE(\d+)%%/g, (_, idx) => {
    const c = codes[parseInt(idx)]
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<span class="md-inline-code">${c}</span>`;
  });

  return result;
}

/* ─── Markdown render cache — avoids re-parsing identical content ─── */
const _mdCache = new Map();
const MD_CACHE_MAX = 500;
function cachedRenderMarkdown(text) {
  if (_mdCache.has(text)) return _mdCache.get(text);
  const html = renderMarkdown(text);
  if (_mdCache.size >= MD_CACHE_MAX) {
    // Evict oldest quarter when full
    const keys = Array.from(_mdCache.keys()).slice(0, MD_CACHE_MAX >> 2);
    for (const k of keys) _mdCache.delete(k);
  }
  _mdCache.set(text, html);
  return html;
}

/* ─── Code block copy button ─── */
const CodeBlock = memo(function CodeBlock({ code }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    try {
      navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* noop */ }
  }, [code]);

  return html`
    <${Paper} variant="outlined" sx=${{ position: 'relative', borderRadius: 1, overflow: 'auto', my: 0.5, backgroundColor: 'rgba(0,0,0,0.04)' }}>
      <${Tooltip} title=${copied ? "Copied!" : "Copy code"} placement="left">
        <${IconButton}
          size="small"
          onClick=${handleCopy}
          sx=${{ position: 'absolute', top: 4, right: 4, opacity: 0.7, '&:hover': { opacity: 1 } }}
        >
          ${resolveIcon(copied ? "✓" : ":clipboard:")}
        </${IconButton}>
      </${Tooltip}>
      <pre style=${{ margin: 0, padding: '12px', fontSize: '0.8125rem', lineHeight: 1.5, overflowX: 'auto' }}><code>${code}</code></pre>
    </${Paper}>
  `;
});

/* ─── Render message content with code block + markdown support ─── */
const MessageContent = memo(function MessageContent({ text }) {
  if (!text) return null;
  const parts = text.split(/(```[\s\S]*?```)/g);
  return html`${parts.map((part, i) => {
    if (part.startsWith("```") && part.endsWith("```")) {
      const code = part.slice(3, -3).replace(/^\w+\n/, "");
      return html`<${CodeBlock} key=${i} code=${code} />`;
    }
    return html`<div key=${i} class="md-rendered" dangerouslySetInnerHTML=${{ __html: cachedRenderMarkdown(part) }} />`;
  })}`;
});

/* ─── Expand / collapse long message bodies ─── */
const MSG_COLLAPSE_HEIGHT = 320; // px — content taller than this gets a "Show more" toggle

const ExpandableContent = function ExpandableContent({ children, id }) {
  const [expanded, setExpanded] = useState(false);
  const [needsExpander, setNeedsExpander] = useState(false);
  const containerRef = useRef(null);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const overflows = el.scrollHeight > MSG_COLLAPSE_HEIGHT + 24;
    setNeedsExpander(overflows);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return html`
    <${Box}>
      <${Box}
        ref=${containerRef}
        sx=${{
          maxHeight: expanded ? 'none' : MSG_COLLAPSE_HEIGHT,
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        ${children}
        ${!expanded && needsExpander && html`
          <${Box} sx=${{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: 72,
            background: 'linear-gradient(to bottom, transparent, rgba(10,10,10,0.92))',
            pointerEvents: 'none',
          }} />
        `}
      </${Box}>
      ${needsExpander && html`
        <${Box} sx=${{ textAlign: 'center', mt: 0.25 }}>
          <${Button}
            size="small"
            variant="text"
            onClick=${() => setExpanded((p) => !p)}
            sx=${{ fontSize: '0.7rem', color: 'text.secondary', textTransform: 'none', py: 0.25 }}
          >
            ${expanded ? '▲ Show less' : '▼ Show more'}
          </${Button}>
        </${Box}>
      `}
    </${Box}>
  `;
};

/* ─── Stream helpers ─── */
function categorizeMessage(msg) {
  const type = (msg?.type || "").toLowerCase();
  if (type === "tool_call") return "tool";
  if (type === "tool_result" || type === "tool_output") return "result";
  if (type === "error" || type === "stream_error") return "error";
  return "message";
}

function isTraceEventMessage(msg) {
  if (!msg) return false;
  const type = (msg.type || "").toLowerCase();
  if (
    type === "tool_call" ||
    type === "tool_result" ||
    type === "tool_output" ||
    type === "error" ||
    type === "stream_error" ||
    type === "system"
  ) {
    return true;
  }
  return (msg.role || "").toLowerCase() === "system";
}

function isModelResponseMessage(msg) {
  if (!msg) return false;
  const role = String(msg.role || "").toLowerCase();
  const type = String(msg.type || "").toLowerCase();
  if (role === "assistant") return true;
  if (
    type === "agent_message" ||
    type === "assistant" ||
    type === "assistant_message"
  ) {
    return true;
  }
  if (role) return false;
  if (!msg.content) return false;
  return ![
    "tool_call",
    "tool_result",
    "tool_output",
    "error",
    "stream_error",
    "system",
    "user",
  ].includes(type);
}

function messageText(msg) {
  if (typeof msg?.content === "string") return msg.content;
  if (msg?.content == null) return "";
  try {
    return JSON.stringify(msg.content, null, 2);
  } catch {
    return String(msg.content);
  }
}

function summarizeLine(text, limit = 160) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

function formatMessageLine(msg) {
  const timestamp = msg?.timestamp || "";
  const kind = msg?.role || msg?.type || "message";
  const content =
    typeof msg?.content === "string"
      ? msg.content
      : msg?.content
        ? JSON.stringify(msg.content)
        : "";
  return `[${timestamp}] ${String(kind).toUpperCase()}: ${content}`;
}

function messageIdentity(msg) {
  if (!msg) return "";
  return String(
    msg.id ||
      msg.messageId ||
      msg.timestamp ||
      `${msg.role || msg.type || "message"}:${String(msg.content || "").slice(0, 80)}`,
  );
}

function AttachmentList({ attachments }) {
  const list = Array.isArray(attachments) ? attachments.filter(Boolean) : [];
  if (!list.length) return null;
  return html`
    <${Stack} direction="row" spacing=${0.5} sx=${{ flexWrap: 'wrap', mt: 0.5 }}>
      ${list.map((att, index) => {
        const name = att.name || att.filename || att.title || "attachment";
        const size = att.size ? formatBytes(att.size) : "";
        const contentType = att.contentType || "";
        const kind = att.kind || (contentType.startsWith("image/") ? "image" : "file");
        const url = att.url || att.downloadUrl || att.filePath || att.path || "";
        const isImage = kind === "image";
        return html`
          <${Paper} variant="outlined" sx=${{ display: 'flex', alignItems: 'center', gap: 0.5, p: 0.5, borderRadius: 1 }} key=${att.id || `${name}-${index}`}>
            ${isImage && url
              ? html`<img style=${{ width: 32, height: 32, borderRadius: 4, objectFit: 'cover' }} src=${url} alt=${name} />`
              : html`<${Avatar} sx=${{ width: 24, height: 24, fontSize: '0.75rem', bgcolor: 'action.selected' }}>${resolveIcon(":link:")}</${Avatar}>`}
            <${Box} sx=${{ minWidth: 0 }}>
              ${url
                ? html`<${Typography} variant="caption" component="a" href=${url} target="_blank" rel="noopener" sx=${{ display: 'block', color: 'primary.main', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}>${name}</${Typography}>`
                : html`<${Typography} variant="caption" sx=${{ display: 'block' }}>${name}</${Typography}>`}
              <${Typography} variant="caption" color="text.secondary" sx=${{ fontSize: '0.625rem' }}>
                ${kind}${size ? ` · ${size}` : ""}
              </${Typography}>
            </${Box}>
          </${Paper}>
        `;
      })}
    </${Stack}>
  `;
}

/* ─── Memoized ChatBubble — only re-renders if msg identity changes ─── */
const ChatBubble = memo(function ChatBubble({
  msg,
  embedded = false,
  isFinalModelResponse = false,
  canEdit = false,
  isEditing = false,
  editingText = "",
  onEditStart = null,
  onEditInput = null,
  onEditSave = null,
  onEditCancel = null,
}) {
  const isTool = msg.type === "tool_call" || msg.type === "tool_result";
  const isError = msg.type === "error" || msg.type === "stream_error";
  const contentText = messageText(msg);
  const role = msg.role ||
    (isTool || isError ? "system" : msg.type === "system" ? "system" : "assistant");
  const isUser = role === "user";
  const isSystem = role === "system";
  const label =
    isTool
      ? msg.type === "tool_call" ? "TOOL CALL" : "TOOL RESULT"
      : isError ? "ERROR" : null;
  const showModelResponseLabel =
    !embedded && isFinalModelResponse && !isTool && !isError && !isUser && !isSystem;
  const contextCompression = msg?.meta?.contextCompression || msg?.meta?.compression || null;
  const showContextCompressionLabel = Boolean(contextCompression);

  const bubbleSx = isError
    ? { p: 1.5, borderRadius: 2, backgroundColor: 'rgba(211,47,47,0.08)', borderLeft: '3px solid', borderLeftColor: 'error.main' }
    : showContextCompressionLabel
      ? { p: 1.5, borderRadius: 2, backgroundColor: 'rgba(255,193,7,0.10)', borderLeft: '3px solid', borderLeftColor: 'warning.main' }
    : isTool
      ? { p: 1.5, borderRadius: 2, backgroundColor: 'rgba(0,0,0,0.03)', borderLeft: '3px solid', borderLeftColor: 'info.main' }
      : isUser
        ? { p: 1.5, borderRadius: 2, backgroundColor: 'rgba(218,119,86,0.12)', ml: 'auto', maxWidth: '85%' }
        : isSystem
          ? { p: 1.5, borderRadius: 2, backgroundColor: 'rgba(0,0,0,0.03)', fontStyle: 'italic' }
          : { p: 1.5, borderRadius: 2, maxWidth: '95%' };

  return html`
    <${Paper}
      elevation=${0}
      sx=${{ ...bubbleSx, mb: 1, ...(showModelResponseLabel ? { borderLeft: '3px solid', borderLeftColor: 'primary.main' } : {}) }}
    >
      ${isSystem && !isTool
        ? html`
            <${Typography} variant="body2" color="text.secondary" component="div">
              <${MessageContent} text=${contentText} />
            </${Typography}>
          `
        : html`
            ${label ? html`<${Chip} label=${label} size="small" color=${isError ? "error" : "info"} variant="outlined" sx=${{ mb: 0.5, height: 20, fontSize: '0.6875rem' }} />` : null}
            ${showContextCompressionLabel
              ? html`
                  <${Box} sx=${{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0.5, mb: 0.5 }}>
                    <${Chip} label="⚡ CONTEXT SHREDDED" size="small" color="warning" variant="filled"
                      sx=${{ height: 22, fontSize: '0.6875rem', fontWeight: 700 }} />
                    ${contextCompression?.total
                      ? html`<${Chip} label=${`${contextCompression.total} items compressed`}
                          size="small" variant="outlined" color="warning"
                          sx=${{ height: 20, fontSize: '0.625rem' }} />`
                      : null}
                    ${contextCompression?.counts
                      ? Object.entries(contextCompression.counts)
                          .filter(([, v]) => v > 0)
                          .map(([k, v]) => html`
                            <${Chip} label=${`${k}: ${v}`} size="small" variant="outlined"
                              sx=${{ height: 18, fontSize: '0.5625rem', opacity: 0.8 }} />
                          `)
                      : null}
                  </${Box}>`
              : null}
            ${showModelResponseLabel
              ? html`<${Chip} label="MODEL RESPONSE" size="small" color="primary" variant="outlined" sx=${{ mb: 0.5, height: 20, fontSize: '0.6875rem' }} />`
              : null}
            <${Box}>
              ${isEditing
                ? html`
                    <${Box} sx=${{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                      <${TextField}
                        fullWidth
                        multiline
                        rows=${3}
                        size="small"
                        value=${editingText}
                        onInput=${(e) => onEditInput?.(e.target.value)}
                        sx=${{ '& .MuiInputBase-root': { fontSize: '0.875rem' } }}
                      />
                      <${Stack} direction="row" spacing=${1} justifyContent="flex-end">
                        <${Button} size="small" variant="text" onClick=${onEditCancel}>Cancel</${Button}>
                        <${Button}
                          size="small"
                          variant="contained"
                          disabled=${!String(editingText || "").trim()}
                          onClick=${onEditSave}
                        >
                          Save
                        </${Button}>
                      </${Stack}>
                    </${Box}>
                  `
                : html`
                    <${ExpandableContent} id=${msg.id || msg.messageId || msg.timestamp || contentText.slice(0, 60)}>
                      <${MessageContent} text=${contentText} />
                    </${ExpandableContent}>
                    <${AttachmentList} attachments=${msg.attachments} />
                  `}
            </${Box}>
            <${Typography} variant="caption" color="text.secondary" sx=${{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.5 }}>
              ${msg.timestamp ? formatRelative(msg.timestamp) : ""}
              ${msg.edited ? " · edited" : ""}
              ${isUser && canEdit && !isEditing
                ? html`
                    <${Button} size="small" variant="text" sx=${{ minWidth: 'auto', p: 0, ml: 0.5, fontSize: '0.6875rem' }} onClick=${() => onEditStart?.(msg)}>
                      Edit
                    </${Button}>
                  `
                : null}
            </${Typography}>
          `}
    </${Paper}>
  `;
}, (prev, next) =>
  prev.msg === next.msg &&
  prev.embedded === next.embedded &&
  prev.isFinalModelResponse === next.isFinalModelResponse &&
  prev.canEdit === next.canEdit &&
  prev.isEditing === next.isEditing &&
  prev.editingText === next.editingText,
);

function getTimelinePhaseMeta(phase) {
  return TIMELINE_PHASE_META[phase] || TIMELINE_PHASE_META.tool_call;
}

const TraceTimelineEntry = memo(function TraceTimelineEntry({ entry, verbosity = "compact", isLast = false }) {
  const phaseMeta = getTimelinePhaseMeta(entry?.phase);
  const detailText = verbosity === "full" ? (entry?.text || "") : summarizeLine(entry?.preview || entry?.text || "", 260);
  const showDetail = detailText && summarizeLine(detailText, 260) !== summarizeLine(entry?.title || "", 260);
  return html`
    <${Box} sx=${{ position: 'relative', pl: 3, pb: isLast ? 0 : 1.25 }}>
      <${Box}
        sx=${{
          position: 'absolute',
          left: 10,
          top: 0,
          bottom: isLast ? 22 : -6,
          width: 2,
          bgcolor: 'divider',
        }}
      />
      <${Box}
        sx=${{
          position: 'absolute',
          left: 4,
          top: 8,
          width: 14,
          height: 14,
          borderRadius: '50%',
          bgcolor: phaseMeta.accent,
          border: '2px solid',
          borderColor: 'background.paper',
          boxShadow: '0 0 0 1px rgba(15,23,42,0.08)',
        }}
      />
      <${Stack} spacing=${0.5}>
        <${Stack} direction="row" spacing=${0.75} alignItems="center" sx=${{ flexWrap: 'wrap' }}>
          <${Chip}
            label=${phaseMeta.label}
            size="small"
            color=${phaseMeta.color}
            variant="outlined"
            sx=${{ height: 20, fontSize: '0.625rem' }}
          />
          <${Typography} variant="caption" sx=${{ fontWeight: 600, fontSize: '0.75rem' }}>
            ${entry?.title || phaseMeta.label}
          </${Typography}>
          ${entry?.timestamp
            ? html`<${Typography} variant="caption" color="text.secondary" sx=${{ ml: 'auto', fontSize: '0.6875rem' }}>
                ${formatRelative(entry.timestamp)}
              </${Typography}>`
            : null}
        </${Stack}>
        ${Array.isArray(entry?.chips) && entry.chips.length
          ? html`
              <${Stack} direction="row" spacing=${0.5} sx=${{ flexWrap: 'wrap' }}>
                ${entry.chips.map((chip) => html`
                  <${Chip}
                    key=${`${entry.id}-${chip}`}
                    label=${chip}
                    size="small"
                    variant="filled"
                    sx=${{
                      height: 20,
                      fontSize: '0.625rem',
                      bgcolor: 'rgba(15,23,42,0.06)',
                      '& .MuiChip-label': { px: 0.75 },
                    }}
                  />
                `)}
              </${Stack}>
            `
          : null}
        ${showDetail
          ? html`
              <${Paper}
                variant="outlined"
                sx=${{
                  px: 1,
                  py: 0.75,
                  fontSize: '0.75rem',
                  bgcolor: entry?.tone === "error" ? 'rgba(211,47,47,0.05)' : 'rgba(15,23,42,0.02)',
                  borderColor: entry?.tone === "error" ? 'error.light' : 'divider',
                }}
              >
                <${MessageContent} text=${detailText} />
              </${Paper}>
            `
          : null}
      </${Stack}>
    </${Box}>
  `;
}, (prev, next) => prev.entry === next.entry && prev.verbosity === next.verbosity && prev.isLast === next.isLast);

const TraceTimelineBlock = memo(function TraceTimelineBlock({ block, verbosity = "compact", forceExpand = false }) {
  const phaseMeta = getTimelinePhaseMeta(block?.phase);
  const [expanded, setExpanded] = useState(() => forceExpand || verbosity === "full" || block?.hasError);

  useEffect(() => {
    setExpanded(forceExpand || verbosity === "full" || block?.hasError);
  }, [block, forceExpand, verbosity]);

  return html`
    <${Paper}
      variant="outlined"
      sx=${{
        mb: 1,
        borderRadius: 2,
        borderColor: block?.hasError ? 'error.main' : 'divider',
        overflow: 'hidden',
        boxShadow: phaseMeta.color === "primary" ? '0 0 0 1px rgba(37,99,235,0.08)' : 'none',
      }}
    >
      <${Box}
        onClick=${() => setExpanded((prev) => !prev)}
        sx=${{
          px: 1.25,
          py: 0.9,
          cursor: 'pointer',
          userSelect: 'none',
          bgcolor: phaseMeta.color === "primary" ? 'rgba(37,99,235,0.04)' : 'rgba(15,23,42,0.025)',
          '&:hover': { bgcolor: phaseMeta.color === "primary" ? 'rgba(37,99,235,0.06)' : 'rgba(15,23,42,0.04)' },
        }}
      >
        <${Stack} spacing=${0.75}>
          <${Stack} direction="row" spacing=${0.75} alignItems="center" sx=${{ flexWrap: 'wrap' }}>
            <${Chip}
              label=${phaseMeta.label}
              size="small"
              color=${block?.hasError ? "error" : phaseMeta.color}
              variant=${forceExpand || verbosity === "full" ? "filled" : "outlined"}
              sx=${{ height: 22, fontSize: '0.6875rem' }}
            />
            <${Typography} variant="body2" sx=${{ flex: 1, fontWeight: 600 }}>
              ${block?.summary || block?.title || phaseMeta.label}
            </${Typography}>
            <${Typography} variant="caption" color="text.secondary">
              ${expanded ? "▾" : "▸"}
            </${Typography}>
          </${Stack}>
          ${Array.isArray(block?.chips) && block.chips.length
            ? html`
                <${Stack} direction="row" spacing=${0.5} sx=${{ flexWrap: 'wrap' }}>
                  ${block.chips.map((chip) => html`
                    <${Chip}
                      key=${`${block.key}-${chip}`}
                      label=${chip}
                      size="small"
                      variant="outlined"
                      sx=${{ height: 20, fontSize: '0.625rem' }}
                    />
                  `)}
                </${Stack}>
              `
            : null}
        </${Stack}>
      </${Box}>
      <${Collapse} in=${expanded}>
        <${Box} sx=${{ px: 1.25, pt: 1, pb: 0.75 }}>
          ${block.entries.map((entry, idx) => html`
            <${TraceTimelineEntry}
              key=${entry.id}
              entry=${entry}
              verbosity=${verbosity}
              isLast=${idx === block.entries.length - 1}
            />
          `)}
        </${Box}>
      </${Collapse}>
    </${Paper}>
  `;
}, (prev, next) => prev.block === next.block && prev.verbosity === next.verbosity && prev.forceExpand === next.forceExpand);

/* ─── ThinkingGroup — collapses consecutive trace events into one row ─── */
const ThinkingGroup = memo(function ThinkingGroup({ msgs, isLatest = false, isAgentActive = false, verbosity = "compact" }) {
  const blocks = useMemo(() => buildTraceTimelineBlocks(msgs), [msgs]);
  const hasErrors = blocks.some((block) => block.hasError);
  const userToggledRef = useRef(false);
  const [expanded, setExpanded] = useState(() => hasErrors || verbosity === "full" || (isLatest && isAgentActive));

  useEffect(() => {
    if (userToggledRef.current) return;
    if (verbosity === "full") {
      setExpanded(true);
    } else if (isLatest && isAgentActive) {
      setExpanded(true);
    } else if (!isLatest) {
      setExpanded(false);
    }
  }, [isLatest, isAgentActive, verbosity]);

  useEffect(() => {
    if (hasErrors) setExpanded(true);
  }, [blocks.length, hasErrors]);

  useEffect(() => {
    userToggledRef.current = false;
  }, [msgs, verbosity]);

  const handleToggle = useCallback(() => {
    userToggledRef.current = true;
    setExpanded((p) => !p);
  }, []);

  const phaseCounts = blocks.reduce((acc, block) => {
    acc[block.phase] = (acc[block.phase] || 0) + 1;
    return acc;
  }, {});

  const parts = [];
  if (phaseCounts.thinking) parts.push(`${phaseCounts.thinking} thinking`);
  if (phaseCounts.file_exploration) parts.push(`${phaseCounts.file_exploration} exploration${phaseCounts.file_exploration === 1 ? "" : "s"}`);
  if (phaseCounts.patch_result) parts.push(`${phaseCounts.patch_result} patch${phaseCounts.patch_result === 1 ? "" : "es"}`);
  if (phaseCounts.tool_call) parts.push(`${phaseCounts.tool_call} tool`);
  if (phaseCounts.output) parts.push(`${phaseCounts.output} output${phaseCounts.output === 1 ? "" : "s"}`);
  if (phaseCounts.error) parts.push(`${phaseCounts.error} error${phaseCounts.error === 1 ? "" : "s"}`);
  const label = parts.join(" · ") || `${blocks.length} timeline item${blocks.length === 1 ? "" : "s"}`;

  return html`
    <${Paper}
      variant="outlined"
      sx=${{
        mb: 1,
        borderRadius: 2,
        overflow: 'hidden',
        ...(hasErrors ? { borderColor: 'error.main' } : {}),
        ...(isLatest && isAgentActive ? { borderColor: 'primary.main', boxShadow: '0 0 0 1px rgba(25,118,210,0.2)' } : {}),
      }}
    >
      <${Box}
        onClick=${handleToggle}
        sx=${{
          display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 0.9,
          cursor: 'pointer', userSelect: 'none',
          backgroundColor: 'rgba(15,23,42,0.025)',
          '&:hover': { backgroundColor: 'rgba(15,23,42,0.04)' },
        }}
      >
        ${isLatest && isAgentActive
          ? html`<${CircularProgress} size=${14} thickness=${5} sx=${{ mr: 0.5 }} />`
          : null}
        <${Chip}
          label=${isLatest && isAgentActive ? "Working…" : "Trace"}
          size="small"
          color=${isLatest && isAgentActive ? "primary" : "default"}
          variant=${isLatest && isAgentActive ? "filled" : "outlined"}
          sx=${{ height: 22, fontSize: '0.6875rem' }}
        />
        <${Typography} variant="caption" color="text.secondary" sx=${{ flex: 1 }}>${label}</${Typography}>
        <${Typography} variant="caption" color="text.secondary">${expanded ? "▾" : "▸"}</${Typography}>
      </${Box}>
      <${Collapse} in=${expanded}>
        <${Box} sx=${{ px: 1.25, py: 1 }}>
          ${blocks.map((block) => html`
            <${TraceTimelineBlock}
              key=${block.key}
              block=${block}
              verbosity=${verbosity}
              forceExpand=${verbosity === "full" || (isLatest && isAgentActive && block === blocks[blocks.length - 1])}
            />
          `)}
        </${Box}>
      </${Collapse}>
    </${Paper}>
  `;
}, (prev, next) =>
  prev.msgs === next.msgs &&
  prev.isLatest === next.isLatest &&
  prev.isAgentActive === next.isAgentActive &&
  prev.verbosity === next.verbosity,
);

/* ─── Chat View component ─── */

export function ChatView({ sessionId, readOnly = false, embedded = false }) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const [visibleCount, setVisibleCount] = useState(CHAT_PAGE_SIZE);
  const [showStreamMeta, setShowStreamMeta] = useState(false);
  const [traceVerbosity, setTraceVerbosity] = useState(() => {
    try {
      return globalThis.localStorage?.getItem(TRACE_VERBOSITY_STORAGE_KEY) === "full" ? "full" : "compact";
    } catch {
      return "compact";
    }
  });
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [filters, setFilters] = useState({
    tool: false,
    result: false,
    error: false,
  });
  const [editingMsgRef, setEditingMsgRef] = useState(null);
  const [editingText, setEditingText] = useState("");
  const messagesRef = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const lastMessageCount = useRef(0);
  const topLoadArmedRef = useRef(true);
  const filterKey = `${filters.tool}-${filters.result}-${filters.error}`;

  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(TRACE_VERBOSITY_STORAGE_KEY, traceVerbosity);
    } catch {
      // Ignore browsers that block storage in embedded contexts.
    }
  }, [traceVerbosity]);

  const isScrollPinnedToBottom = useCallback((el) => {
    if (!el) return true;
    const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    if (maxScrollTop <= SCROLL_BOTTOM_TOLERANCE_PX) return true;
    const distanceFromBottom = maxScrollTop - el.scrollTop;
    const scrollRatio = maxScrollTop > 0 ? el.scrollTop / maxScrollTop : 1;
    return (
      distanceFromBottom <= SCROLL_BOTTOM_TOLERANCE_PX ||
      scrollRatio >= SCROLL_BOTTOM_RATIO
    );
  }, []);

  let messages = [];
  try {
    const boundSessionId = String(sessionMessagesSessionId.value || "");
    const currentSessionId = String(sessionId || "");
    messages = boundSessionId === currentSessionId ? (sessionMessages.value || []) : [];
  } catch (err) {
    console.warn("[ChatView] Failed to read sessionMessages:", err);
  }

  /* Safely read signal values — if any signal is in a broken state (e.g. from a
     module load race or a WebSocket push that corrupted state), we default to
     safe empty values so the component renders instead of crashing.
     
     Use .peek() for signals whose changes should NOT trigger a re-render of
     this component. sessionsData changes frequently (sidebar metadata), but
     we only need the session status for the header — not worth re-rendering
     the entire message list. */
  let session = null;
  try {
    session = (sessionsData.peek() || []).find((s) => s.id === sessionId) || null;
  } catch (err) {
    console.warn("[ChatView] Failed to read sessionsData:", err);
  }
  const isActive =
    session?.status === "active" || session?.status === "running";
  const resumeLabel =
    session?.status === "archived" ? "Unarchive" : "Resume Session";
  const sessionPath = useCallback(
    (action = "") => {
      const currentSession =
        (sessionsData.peek() || []).find((entry) => entry?.id === sessionId) || session;
      return buildSessionApiPath(sessionId, action, {
        workspace: resolveSessionWorkspaceHint(currentSession, "active"),
      });
    },
    [sessionId, session],
  );

  /* Memoize the filter key list so filteredMessages memoization works properly.
     Previously a new array was created every render, breaking useMemo deps. */
  const activeFilters = useMemo(
    () => Object.entries(filters).filter(([, v]) => v).map(([k]) => k),
    [filterKey],
  );

  const counts = useMemo(() => {
    return messages.reduce(
      (acc, msg) => {
        const category = categorizeMessage(msg);
        acc.total += 1;
        if (category === "tool") acc.tool += 1;
        else if (category === "result") acc.result += 1;
        else if (category === "error") acc.error += 1;
        else acc.message += 1;
        return acc;
      },
      { total: 0, tool: 0, result: 0, error: 0, message: 0 },
    );
  }, [messages]);

  const filteredMessages = useMemo(() => {
    if (activeFilters.length === 0) return messages;
    return messages.filter((msg) => activeFilters.includes(categorizeMessage(msg)));
  }, [messages, activeFilters]);

  const latestModelMessageKey = useMemo(() => {
    const latest =
      filteredMessages
        .slice()
        .reverse()
        .find((msg) => isModelResponseMessage(msg)) || null;
    return messageIdentity(latest);
  }, [filteredMessages]);

  // Count only real (non-trace) messages toward the visible limit so trace
  // events don't consume the page budget.
  const realMessageCount = useMemo(
    () => filteredMessages.filter((msg) => !isTraceEventMessage(msg)).length,
    [filteredMessages],
  );

  const visibleMessages = useMemo(() => {
    if (realMessageCount <= visibleCount) return filteredMessages;
    // Walk backwards counting only real messages; include all trace events
    // that fall between them so groups stay intact.
    let realCount = 0;
    for (let i = filteredMessages.length - 1; i >= 0; i--) {
      if (!isTraceEventMessage(filteredMessages[i])) {
        realCount++;
        if (realCount >= visibleCount) return filteredMessages.slice(i);
      }
    }
    return filteredMessages;
  }, [filteredMessages, visibleCount, realMessageCount]);

  const hasMoreMessages = realMessageCount > visibleCount;

  const streamActivityKey = useMemo(() => {
    if (filteredMessages.length === 0) return "empty";
    const last = filteredMessages[filteredMessages.length - 1] || {};
    const id = last.id || last.timestamp || filteredMessages.length;
    const role = last.role || last.type || "message";
    const contentLen =
      typeof last.content === "string"
        ? last.content.length
        : last.content
          ? JSON.stringify(last.content).length
          : 0;
    return `${filteredMessages.length}:${id}:${role}:${contentLen}`;
  }, [filteredMessages]);

  /* Use .peek() for auto-actions — these are low-priority decorations, not
     worth triggering a full ChatView re-render for. The component will pick
     them up on the next render triggered by messages or other signals. */
  const recentAutoActions = useMemo(() => {
    try {
      const items = (agentAutoActions.peek() || []).slice(0, 3);
      return items.map(formatAutoAction).filter(Boolean);
    } catch {
      return [];
    }
  }, [messages.length]);

  /* Keep status indicators fully live while an agent is active. */
  let errorCount = 0;
  let statusState = "idle";
  let statusText = "";
  try {
    errorCount = totalErrorCount.value || 0;
    const globalStatus = agentStatus.value || {};
    const currentSessionId = String(sessionId || "");
    const statusSessionId = String(globalStatus.sessionId || "");
    const statusMatchesSession =
      statusSessionId.length > 0 && statusSessionId === currentSessionId;
    statusState = paused
      ? "paused"
      : statusMatchesSession
        ? globalStatus.state || "idle"
        : "idle";
    statusText = paused
      ? "Stream paused"
      : statusMatchesSession
        ? agentStatusText.value || "Ready"
        : "Ready";
  } catch (err) {
    console.warn("[ChatView] Failed to read status signals:", err);
    statusState = paused ? "paused" : "idle";
    statusText = paused ? "Stream paused" : "Ready";
  }

  const renderItems = useMemo(() => {
    const items = [];
    let i = 0;
    while (i < visibleMessages.length) {
      const msg = visibleMessages[i];
      if (isTraceEventMessage(msg)) {
        // Collect consecutive trace events; discard completely empty ones.
        const group = [];
        let groupKey = null;
        while (i < visibleMessages.length && isTraceEventMessage(visibleMessages[i])) {
          const m = visibleMessages[i];
          if (messageText(m).trim()) {
            group.push(m);
            if (!groupKey) groupKey = m.id || m.timestamp || `trace-${i}`;
          }
          i++;
        }
        if (group.length > 0) {
          items.push({ kind: "thinking-group", key: `thinking-group-${groupKey}`, msgs: group });
        }
      } else {
        const baseKey = msg.id || msg.timestamp || `msg-${i}`;
        items.push({
          kind: "message",
          key: `message-${baseKey}-${i}`,
          messageKey: messageIdentity(msg),
          msg,
        });
        i++;
      }
    }
    // Mark the last thinking-group as "latest" for auto-expand/collapse
    for (let j = items.length - 1; j >= 0; j--) {
      if (items[j].kind === "thinking-group") {
        items[j].isLatest = true;
        break;
      }
    }
    return items;
  }, [visibleMessages]);

  const refreshMessages = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    const res = await loadSessionMessages(sessionId, { limit: CHAT_PAGE_SIZE }).finally(() => setLoading(false));
    setLoadError(res?.ok ? null : res?.error || "unavailable");
  }, [sessionId]);

  /** Reveal older messages from local cache, or fetch another page if needed. */
  const revealOlderMessages = useCallback(async ({ preserveScroll = false } = {}) => {
    if (hasMoreMessages) {
      setVisibleCount((prev) => prev + CHAT_PAGE_SIZE);
      return;
    }
    if (!sessionId || loadingOlder) return;
    const pag = sessionPagination.value;
    if (!pag || !pag.hasMore) return;
    const el = messagesRef.current;
    const prevScrollHeight = preserveScroll && el ? el.scrollHeight : 0;
    const prevScrollTop = preserveScroll && el ? el.scrollTop : 0;
    setLoadingOlder(true);
    const newOffset = Math.max(0, pag.offset - CHAT_PAGE_SIZE);
    const limit = pag.offset - newOffset;
    if (limit <= 0) { setLoadingOlder(false); return; }
    const res = await loadSessionMessages(sessionId, {
      limit,
      offset: newOffset,
      prepend: true,
    }).finally(() => setLoadingOlder(false));
    if (res?.ok) {
      setVisibleCount((prev) => prev + limit);
      if (preserveScroll && el) {
        requestAnimationFrame(() => {
          const delta = Math.max(0, el.scrollHeight - prevScrollHeight);
          el.scrollTop = prevScrollTop + delta;
        });
      }
    } else {
      setLoadError(res?.error || "unavailable");
    }
  }, [sessionId, loadingOlder, hasMoreMessages]);

  /* Load messages on mount; WS push via initSessionWsListener handles real-time */
  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    // Use a small delay to let the Chat tab's session list settle first
    const timer = setTimeout(() => {
      if (!active) return;
      if (!paused) {
        setLoading(true);
        loadSessionMessages(sessionId, { limit: CHAT_PAGE_SIZE }).then((res) => {
          if (active) setLoadError(res?.ok ? null : res?.error || "unavailable");
        }).finally(() => {
          if (active) setLoading(false);
        });
      } else {
        setLoading(false);
      }
    }, 100);

    // Fallback: poll slowly as safety net (30s) - WS does the heavy lifting
    const interval = setInterval(() => {
      if (active && !paused) {
        loadSessionMessages(sessionId, { limit: CHAT_PAGE_SIZE }).then((res) => {
          if (active && res?.ok === false) setLoadError(res?.error || "unavailable");
        });
      }
    }, 30000);

    return () => {
      active = false;
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [sessionId, paused]);

  /* Start agent status tracking from WS events — deferred to avoid
     signal cascade during initial mount */
  useEffect(() => {
    let cleanup1 = null;
    let cleanup2 = null;
    const timer = setTimeout(() => {
      cleanup1 = startAgentStatusTracking();
      cleanup2 = startAgentEventTracking();
    }, 200);
    return () => {
      clearTimeout(timer);
      if (cleanup1) cleanup1();
      if (cleanup2) cleanup2();
    };
  }, []);

  /* Clear pending messages when switching sessions */
  useEffect(() => {
    if (sessionId) clearPendingMessages(sessionId);
  }, [sessionId]);

  /* Reset visible window when session or filters change */
  useEffect(() => {
    setVisibleCount(CHAT_PAGE_SIZE);
    setUnreadCount(0);
    setAutoScroll(true);
    topLoadArmedRef.current = true;
  }, [sessionId, filterKey]);

  useEffect(() => {
    setPendingAttachments([]);
    setUploadingAttachments(false);
    setEditingMsgRef(null);
    setEditingText("");
  }, [sessionId]);

  /* Track scroll position to decide auto-scroll + unread */
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return undefined;
    const onScroll = () => {
      const pinnedToBottom = isScrollPinnedToBottom(el);
      setAutoScroll(pinnedToBottom);
      if (pinnedToBottom) setUnreadCount(0);
      if (el.scrollTop <= SCROLL_TOP_TRIGGER_PX) {
        if (topLoadArmedRef.current) {
          topLoadArmedRef.current = false;
          revealOlderMessages({ preserveScroll: true }).catch(() => {});
        }
      } else if (el.scrollTop >= SCROLL_TOP_REARM_PX) {
        topLoadArmedRef.current = true;
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [sessionId, isScrollPinnedToBottom, revealOlderMessages]);

  /* Auto-scroll to bottom when new messages arrive */
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    const prevCount = lastMessageCount.current;
    const nextCount = messages.length;
    const newMessages = nextCount > prevCount;
    lastMessageCount.current = nextCount;
    if (!paused && autoScroll) {
      // Use smooth scroll for small increments, instant for large jumps
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      el.scrollTo({ top: el.scrollHeight, behavior: gap < 800 ? "smooth" : "auto" });
      return;
    }
    if (newMessages && !autoScroll) {
      setUnreadCount((prev) => prev + (nextCount - prevCount));
    }
  }, [messages.length, streamActivityKey, paused, autoScroll]);

  const uploadAttachments = useCallback(async (files) => {
    if (!sessionId || uploadingAttachments) return;
    const list = Array.from(files || []).filter(Boolean);
    if (!list.length) return;
    setUploadingAttachments(true);
    try {
      const form = new FormData();
      for (const file of list) {
        form.append("file", file, file.name || "attachment");
      }
      const attachmentsPath = sessionPath("attachments");
      if (!attachmentsPath) {
        showToast("Attachment upload failed", "error");
        return;
      }
      const res = await apiFetch(attachmentsPath, {
        method: "POST",
        body: form,
      });
      if (res?.attachments?.length) {
        setPendingAttachments((prev) => [...prev, ...res.attachments]);
      } else {
        showToast("Attachment upload failed", "error");
      }
    } catch {
      showToast("Attachment upload failed", "error");
    } finally {
      setUploadingAttachments(false);
    }
  }, [sessionId, uploadingAttachments, sessionPath]);

  const handleAttachmentInput = useCallback((e) => {
    const files = e.target?.files;
    if (files && files.length) {
      uploadAttachments(files);
    }
    if (e.target) e.target.value = "";
  }, [uploadAttachments]);

  const handlePaste = useCallback((e) => {
    const files = e.clipboardData?.files;
    if (files && files.length) {
      e.preventDefault();
      uploadAttachments(files);
    }
  }, [uploadAttachments]);

  const handleDragOver = useCallback((e) => {
    if (readOnly) return;
    e.preventDefault();
    if (!dragActive) setDragActive(true);
  }, [readOnly, dragActive]);

  const handleDragLeave = useCallback(() => {
    if (dragActive) setDragActive(false);
  }, [dragActive]);

  const handleDrop = useCallback((e) => {
    if (readOnly) return;
    e.preventDefault();
    setDragActive(false);
    const files = e.dataTransfer?.files;
    if (files && files.length) {
      uploadAttachments(files);
    }
  }, [readOnly, uploadAttachments]);

  const removeAttachment = useCallback((index) => {
    setPendingAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleStartEdit = useCallback((msg) => {
    setEditingMsgRef(msg || null);
    setEditingText(messageText(msg));
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingMsgRef(null);
    setEditingText("");
  }, []);

  const handleSaveEdit = useCallback(async () => {
    if (!sessionId || !editingMsgRef) return;
    const next = String(editingText || "").trim();
    if (!next) return;

    const previousContent = messageText(editingMsgRef);
    if (next === previousContent) {
      setEditingMsgRef(null);
      setEditingText("");
      return;
    }

    const editedAt = new Date().toISOString();
    sessionMessagesSessionId.value = String(sessionId || "");
    sessionMessages.value = ((sessionMessages.value || [])).map((msg) =>
      msg === editingMsgRef
        ? { ...msg, content: next, edited: true, editedAt }
        : msg,
    );

    setEditingMsgRef(null);
    setEditingText("");

    try {
      const editPath = sessionPath("message/edit");
      if (!editPath) throw new Error("Session path unavailable");
      await apiFetch(editPath, {
        method: "POST",
        body: JSON.stringify({
          messageId: editingMsgRef?.id,
          timestamp: editingMsgRef?.timestamp,
          previousContent,
          content: next,
        }),
      });
      const res = await loadSessionMessages(sessionId);
      setLoadError(res?.ok ? null : res?.error || "unavailable");
      showToast("Message updated", "success");
    } catch {
      const res = await loadSessionMessages(sessionId);
      setLoadError(res?.ok ? null : res?.error || "unavailable");
      showToast("Failed to update message", "error");
    }
  }, [sessionId, editingMsgRef, editingText, sessionPath]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if ((!text && pendingAttachments.length === 0) || sending || readOnly || uploadingAttachments) return;

    /* Optimistically add user message */
    const optimistic = {
      id: `opt-${Date.now()}`,
      role: "user",
      content: text,
      attachments: pendingAttachments,
      timestamp: new Date().toISOString(),
    };
    sessionMessagesSessionId.value = String(sessionId || "");
    sessionMessages.value = [...(sessionMessages.value || []), optimistic];
    setInput("");
    setPendingAttachments([]);
    setSending(true);

    try {
      const messagePath = sessionPath("message");
      if (!messagePath) throw new Error("Session path unavailable");
      await apiFetch(messagePath, {
        method: "POST",
        body: JSON.stringify({
          content: text,
          attachments: pendingAttachments,
        }),
      });
      const res = await loadSessionMessages(sessionId, { limit: CHAT_PAGE_SIZE });
      setLoadError(res?.ok ? null : res?.error || "unavailable");
    } catch {
      showToast("Failed to send message", "error");
    } finally {
      setSending(false);
    }
  }, [input, sending, sessionId, pendingAttachments, readOnly, uploadingAttachments, sessionPath]);

  const handleResume = useCallback(async () => {
    try {
      const resumePath = sessionPath("resume");
      if (!resumePath) throw new Error("Session path unavailable");
      await apiFetch(resumePath, { method: "POST" });
      showToast(
        session?.status === "archived" ? "Session unarchived" : "Session resumed",
        "success",
      );
      await loadSessions();
      const res = await loadSessionMessages(sessionId, { limit: CHAT_PAGE_SIZE });
      setLoadError(res?.ok ? null : res?.error || "unavailable");
    } catch {
      showToast("Failed to resume session", "error");
    }
  }, [sessionId, session?.status, sessionPath]);

  const handleArchive = useCallback(async () => {
    try {
      const archivePath = sessionPath("archive");
      if (!archivePath) throw new Error("Session path unavailable");
      await apiFetch(archivePath, { method: "POST" });
      showToast("Session archived", "success");
      await loadSessions();
      const res = await loadSessionMessages(sessionId, { limit: CHAT_PAGE_SIZE });
      setLoadError(res?.ok ? null : res?.error || "unavailable");
    } catch {
      showToast("Failed to archive session", "error");
    }
  }, [sessionId, sessionPath]);

  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleInput = useCallback((e) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, []);

  const toggleFilter = useCallback((key) => {
    setFilters((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const clearFilters = useCallback(() => {
    setFilters({ tool: false, result: false, error: false });
  }, []);

  const handleCopyStream = useCallback(() => {
    if (!sessionId) return;
    const title = session?.title || session?.taskId || sessionId;
    const filterLabel =
      activeFilters.length > 0 ? activeFilters.join(", ") : "all";
    const header = `Session: ${title}\nStatus: ${session?.status || "unknown"}\nFilters: ${filterLabel}\nExported: ${new Date().toISOString()}\n\n`;
    const lines = filteredMessages.map(formatMessageLine).join("\n");
    const payload = `${header}${lines}`.trim();
    navigator.clipboard
      .writeText(payload)
      .then(() => showToast("Stream copied", "success"))
      .catch(() => showToast("Copy failed", "error"));
  }, [activeFilters, filteredMessages, session, sessionId]);

  const handleExportStream = useCallback(() => {
    if (!sessionId) return;
    const payload = {
      sessionId,
      title: session?.title || session?.taskId || null,
      status: session?.status || null,
      exportedAt: new Date().toISOString(),
      filters: activeFilters,
      messages: filteredMessages,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `session-${sessionId}-${Date.now()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast("Stream exported", "success");
  }, [activeFilters, filteredMessages, session, sessionId]);

  if (!sessionId) {
    return html`
      <${Box} sx=${{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 2, p: 4 }}>
        <${Typography} variant="h4" sx=${{ opacity: 0.5 }}>${resolveIcon(":chat:")}</${Typography}>
        <${Typography} variant="body1" color="text.secondary" align="center">
          Select a session to view the live stream.
        </${Typography}>
        <${Typography} variant="caption" color="text.secondary" align="center">
          Create a new session or pick one on the left.
        </${Typography}>
      </${Box}>
    `;
  }

  return html`
    <${Box}
      className=${embedded ? "chat-view-embedded" : "chat-view"}
      sx=${{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0, ...(embedded ? { border: 'none' } : {}) }}
    >
      ${!embedded && html`
      <${Paper} elevation=${0} sx=${{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 2, py: 1, borderBottom: '1px solid', borderColor: 'divider' }}>
        <${Box}>
          <${Typography} variant="subtitle1" sx=${{ fontWeight: 600 }}>
            ${session?.title || session?.taskId || "Session"}
          </${Typography}>
          <${Typography} variant="caption" color="text.secondary">
            ${session?.type || "manual"} · ${session?.status || "unknown"}
          </${Typography}>
        </${Box}>
        <${Stack} direction="row" spacing=${1}>
          ${session?.status === "archived" &&
          html`
            <${Button} size="small" variant="contained" onClick=${handleResume}>
              Unarchive
            </${Button}>
          `}
          ${session?.status !== "archived" &&
          html`
            <${Button} size="small" variant="text" onClick=${handleArchive}>
              Archive
            </${Button}>
          `}
        </${Stack}>
      </${Paper}>
      `}

      ${!embedded && html`
      <${Box} sx=${{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 2, py: 0.75, borderBottom: '1px solid', borderColor: 'divider', flexWrap: 'wrap', gap: 0.5 }}>
        <${Stack} direction="row" spacing=${0.5} alignItems="center" sx=${{ flexWrap: 'wrap' }}>
          <${Chip}
            label=${html`All <${Typography} component="span" variant="caption" sx=${{ ml: 0.5, opacity: 0.7 }}>${counts.total}</${Typography}>`}
            size="small"
            color=${activeFilters.length === 0 ? "primary" : "default"}
            variant=${activeFilters.length === 0 ? "filled" : "outlined"}
            onClick=${clearFilters}
            sx=${{ height: 26 }}
          />
          <${Chip}
            label=${html`Tool <${Typography} component="span" variant="caption" sx=${{ ml: 0.5, opacity: 0.7 }}>${counts.tool}</${Typography}>`}
            size="small"
            color=${filters.tool ? "primary" : "default"}
            variant=${filters.tool ? "filled" : "outlined"}
            onClick=${() => toggleFilter("tool")}
            sx=${{ height: 26 }}
          />
          <${Chip}
            label=${html`Result <${Typography} component="span" variant="caption" sx=${{ ml: 0.5, opacity: 0.7 }}>${counts.result}</${Typography}>`}
            size="small"
            color=${filters.result ? "primary" : "default"}
            variant=${filters.result ? "filled" : "outlined"}
            onClick=${() => toggleFilter("result")}
            sx=${{ height: 26 }}
          />
          <${Chip}
            label=${html`Error <${Typography} component="span" variant="caption" sx=${{ ml: 0.5, opacity: 0.7 }}>${counts.error}</${Typography}>`}
            size="small"
            color=${filters.error ? "error" : "default"}
            variant=${filters.error ? "filled" : "outlined"}
            onClick=${() => toggleFilter("error")}
            sx=${{ height: 26 }}
          />
          ${paused &&
          html`<${Chip} label="Paused" size="small" color="warning" variant="filled" sx=${{ height: 22, fontSize: '0.6875rem' }} />`}
        </${Stack}>
        <${Stack} direction="row" spacing=${0.5}>
          <${ButtonGroup} size="small" variant="outlined" sx=${{ mr: 0.5 }}>
            <${Button}
              variant=${traceVerbosity === "compact" ? "contained" : "outlined"}
              onClick=${() => setTraceVerbosity("compact")}
              sx=${{ minWidth: 'auto', px: 1.2, fontSize: '0.6875rem' }}
            >
              Compact
            </${Button}>
            <${Button}
              variant=${traceVerbosity === "full" ? "contained" : "outlined"}
              onClick=${() => setTraceVerbosity("full")}
              sx=${{ minWidth: 'auto', px: 1.2, fontSize: '0.6875rem' }}
            >
              Full
            </${Button}>
          </${ButtonGroup}>
          <${Tooltip} title="Refresh"><${IconButton} size="small" onClick=${refreshMessages}>${resolveIcon(":refresh:")}</${IconButton}></${Tooltip}>
          <${Tooltip} title=${paused ? "Resume" : "Pause"}>
            <${IconButton} size="small" onClick=${() => setPaused((prev) => !prev)}>
              ${resolveIcon(paused ? ":play:" : ":pause:")}
            </${IconButton}>
          </${Tooltip}>
          <${Tooltip} title="Copy stream"><${IconButton} size="small" onClick=${handleCopyStream}>${resolveIcon(":clipboard:")}</${IconButton}></${Tooltip}>
          <${Tooltip} title="Export stream"><${IconButton} size="small" onClick=${handleExportStream}>${resolveIcon(":download:")}</${IconButton}></${Tooltip}>
        </${Stack}>
        </${Box}>
        `}

      ${embedded && html`
        <${Box} sx=${{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 1.5, py: 0.75, borderBottom: '1px solid', borderColor: 'divider' }}>
          <${Stack} direction="row" spacing=${1} alignItems="center">
            <${Box} sx=${{ width: 8, height: 8, borderRadius: '50%', backgroundColor: statusState === 'idle' ? 'text.disabled' : statusState === 'paused' ? 'warning.main' : 'success.main' }} />
            <${Box}>
              <${Typography} variant="caption" sx=${{ fontWeight: 600, display: 'block', lineHeight: 1.2 }}>Status</${Typography}>
              <${Typography} variant="caption" color="text.secondary" sx=${{ lineHeight: 1.2 }}>${statusText}</${Typography}>
            </${Box}>
          </${Stack}>
          <${Stack} direction="row" spacing=${0.5}>
            <${ButtonGroup} size="small" variant="outlined">
              <${Button}
                variant=${traceVerbosity === "compact" ? "contained" : "outlined"}
                onClick=${() => setTraceVerbosity("compact")}
                sx=${{ minWidth: 'auto', fontSize: '0.6875rem' }}
              >
                Compact
              </${Button}>
              <${Button}
                variant=${traceVerbosity === "full" ? "contained" : "outlined"}
                onClick=${() => setTraceVerbosity("full")}
                sx=${{ minWidth: 'auto', fontSize: '0.6875rem' }}
              >
                Full
              </${Button}>
            </${ButtonGroup}>
            <${Button} size="small" variant="text" onClick=${refreshMessages} sx=${{ minWidth: 'auto', fontSize: '0.6875rem' }}>
              Refresh
            </${Button}>
            <${Button}
              size="small"
              variant="text"
              onClick=${() => setPaused((prev) => !prev)}
              sx=${{ minWidth: 'auto', fontSize: '0.6875rem' }}
            >
              ${paused ? "Resume" : "Pause"}
            </${Button}>
            <${Button} size="small" variant="text" onClick=${() => setShowStreamMeta((prev) => !prev)} sx=${{ minWidth: 'auto', fontSize: '0.6875rem' }}>
              ${showStreamMeta ? "Hide filters" : "Filters"}
            </${Button}>
          </${Stack}>
        </${Box}>
        <${Collapse} in=${showStreamMeta}>
          <${Box} sx=${{ px: 1.5, py: 0.75, borderBottom: '1px solid', borderColor: 'divider' }}>
            <${Stack} direction="row" spacing=${0.5} sx=${{ flexWrap: 'wrap', mb: (errorCount > 0 || recentAutoActions.length > 0) ? 0.75 : 0 }}>
              <${Chip}
                label=${html`All <${Typography} component="span" variant="caption" sx=${{ ml: 0.5, opacity: 0.7 }}>${counts.total}</${Typography}>`}
                size="small"
                color=${activeFilters.length === 0 ? "primary" : "default"}
                variant=${activeFilters.length === 0 ? "filled" : "outlined"}
                onClick=${clearFilters}
                sx=${{ height: 24 }}
              />
              <${Chip}
                label=${html`Tool <${Typography} component="span" variant="caption" sx=${{ ml: 0.5, opacity: 0.7 }}>${counts.tool}</${Typography}>`}
                size="small"
                color=${filters.tool ? "primary" : "default"}
                variant=${filters.tool ? "filled" : "outlined"}
                onClick=${() => toggleFilter("tool")}
                sx=${{ height: 24 }}
              />
              <${Chip}
                label=${html`Result <${Typography} component="span" variant="caption" sx=${{ ml: 0.5, opacity: 0.7 }}>${counts.result}</${Typography}>`}
                size="small"
                color=${filters.result ? "primary" : "default"}
                variant=${filters.result ? "filled" : "outlined"}
                onClick=${() => toggleFilter("result")}
                sx=${{ height: 24 }}
              />
              <${Chip}
                label=${html`Error <${Typography} component="span" variant="caption" sx=${{ ml: 0.5, opacity: 0.7 }}>${counts.error}</${Typography}>`}
                size="small"
                color=${filters.error ? "error" : "default"}
                variant=${filters.error ? "filled" : "outlined"}
                onClick=${() => toggleFilter("error")}
                sx=${{ height: 24 }}
              />
            </${Stack}>
            ${(errorCount > 0 || recentAutoActions.length > 0) && html`
              <${Stack} direction="row" spacing=${0.5} sx=${{ flexWrap: 'wrap' }}>
                ${errorCount > 0 && html`
                  <${Chip} label=${`Errors · ${errorCount}`} size="small" color="error" variant="filled" sx=${{ height: 22, fontSize: '0.625rem' }} />
                `}
                ${recentAutoActions.map((action) => html`
                  <${Chip}
                    label=${`${action.label}${action.task ? ` · ${action.task}` : ""}`}
                    size="small"
                    variant="outlined"
                    deleteIcon=${action.ts ? html`<${Typography} variant="caption" sx=${{ fontSize: '0.5625rem' }}>${formatRelative(action.ts)}</${Typography}>` : null}
                    onDelete=${action.ts ? () => {} : undefined}
                    sx=${{ height: 22, fontSize: '0.625rem' }}
                  />
                `)}
              </${Stack}>
            `}
          </${Box}>
        </${Collapse}>
      `}

      <${Box} ref=${messagesRef} className="chat-messages" sx=${{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        ${(hasMoreMessages || sessionPagination.value?.hasMore) && html`
          <${Box} sx=${{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1, py: 1 }}>
            <${Button}
              size="small"
              variant="text"
              disabled=${loadingOlder}
              onClick=${() => revealOlderMessages()}
            >
              ${loadingOlder ? html`<${CircularProgress} size=${14} sx=${{ mr: 0.5 }} /> Loading…` : "Load older messages"}
            </${Button}>
            <${Typography} variant="caption" color="text.secondary">
              Showing ${visibleMessages.length} of ${sessionPagination.value?.total || filteredMessages.length}
            </${Typography}>
          </${Box}>
        `}
        ${loadError && !loading && html`
          <${Alert} severity="error" sx=${{ mb: 1 }}
            action=${html`<${Button} size="small" color="inherit" onClick=${refreshMessages}>Retry</${Button}>`}
          >
            Stream unavailable (${loadError}).
          </${Alert}>
        `}
        ${loading && messages.length === 0 && html`
          <${Box} sx=${{ display: 'flex', flexDirection: 'column', gap: 1, py: 2 }}>
            <${Skeleton} variant="rounded" height=${60} />
            <${Skeleton} variant="rounded" height=${40} width="60%" />
            <${Skeleton} variant="rounded" height=${80} />
            <${Skeleton} variant="rounded" height=${40} width="75%" />
          </${Box}>
        `}
        ${!loading && messages.length === 0 && html`
          <${Box} sx=${{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 1.5, py: 4 }}>
            <${Typography} variant="h5" sx=${{ opacity: 0.4 }}>${resolveIcon(":server:")}</${Typography}>
            <${Typography} variant="body2" color="text.secondary" align="center">
              No messages yet.
            </${Typography}>
            <${Typography} variant="caption" color="text.secondary" align="center">
              ${readOnly ? "Stream will appear once the agent starts." : "Send a message to kick things off."}
            </${Typography}>
          </${Box}>
        `}
        ${messages.length > 0 && filteredMessages.length === 0 && html`
          <${Box} sx=${{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 1.5, py: 4 }}>
            <${Typography} variant="h5" sx=${{ opacity: 0.4 }}>${resolveIcon(":settings:")}</${Typography}>
            <${Typography} variant="body2" color="text.secondary" align="center">
              No messages match these filters.
            </${Typography}>
            <${Typography} variant="caption" color="text.secondary" align="center">
              Try clearing filters or wait for new tool events.
            </${Typography}>
            <${Button} size="small" variant="contained" onClick=${clearFilters} sx=${{ mt: 0.5 }}>
              Clear Filters
            </${Button}>
          </${Box}>
        `}
        ${renderItems.map((item) => item.kind === "thinking-group"
          ? html`<${ThinkingGroup}
              key=${item.key}
              msgs=${item.msgs}
              isLatest=${!!item.isLatest}
              isAgentActive=${statusState !== "idle" && statusState !== "paused"}
              verbosity=${traceVerbosity}
            />`
          : html`<${ChatBubble}
              key=${item.key}
              msg=${item.msg}
              embedded=${embedded}
              isFinalModelResponse=${item.messageKey === latestModelMessageKey}
            />`
        )}

        ${/* Pending messages (optimistic rendering) — use .peek() to avoid
              subscribing ChatView to pendingMessages signal. Pending messages
              are updated via handleSend which already triggers a re-render
              through sessionMessages. */
          (pendingMessages.peek() || [])
            .filter((pm) => pm.sessionId === sessionId)
            .map((pm) => html`
              <${Paper} key=${pm.tempId} elevation=${0} sx=${{
                p: 1.5, borderRadius: 2, mb: 1, ml: 'auto', maxWidth: '85%',
                backgroundColor: pm.status === "failed" ? 'rgba(211,47,47,0.08)' : pm.status === "uncertain" ? 'rgba(237,108,2,0.08)' : 'rgba(218,119,86,0.12)',
                opacity: pm.status === "sending" ? 0.7 : 1,
              }}>
                <${Box}>
                  <${MessageContent} text=${pm.content} />
                  <${AttachmentList} attachments=${pm.attachments} />
                </${Box}>
                <${Box} sx=${{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.5 }}>
                  ${pm.status === "sending"
                    ? html`<${CircularProgress} size=${12} /><${Typography} variant="caption" color="text.secondary">Sending…</${Typography}>`
                    : pm.status === "uncertain"
                      ? html`
                          <${Alert} severity="warning" sx=${{ py: 0, '& .MuiAlert-message': { py: 0, display: 'flex', alignItems: 'center', gap: 0.5, fontSize: '0.75rem' } }}>
                            Uncertain
                            <${Button} size="small" variant="text" sx=${{ minWidth: 'auto', fontSize: '0.6875rem' }}
                              onClick=${() => retryPendingMessage(pm.tempId)}>↻ Retry</${Button}>
                          </${Alert}>`
                      : pm.status === "failed"
                        ? html`
                            <${Alert} severity="error" sx=${{ py: 0, '& .MuiAlert-message': { py: 0, display: 'flex', alignItems: 'center', gap: 0.5, fontSize: '0.75rem' } }}>
                              Failed${pm.error ? `: ${pm.error}` : ""}
                              <${Button} size="small" variant="text" sx=${{ minWidth: 'auto', fontSize: '0.6875rem' }}
                                onClick=${() => retryPendingMessage(pm.tempId)}>↻ Retry</${Button}>
                            </${Alert}>`
                        : ""}
                </${Box}>
              </${Paper}>
            `)}

        ${/* Agent status typing indicator */
          statusState !== "idle" && statusState !== "paused" && html`
          <${Paper} elevation=${0} sx=${{ p: 1.5, borderRadius: 2, mb: 1, display: 'flex', alignItems: 'center', gap: 1, maxWidth: '60%' }}>
            <${CircularProgress} size=${16} thickness=${5} />
            <${Typography} variant="caption" color="text.secondary">${statusText}</${Typography}>
          </${Paper}>
        `}
      </${Box}>
      ${!autoScroll && messages.length > 0 && html`
        <${Box} sx=${{ position: 'relative' }}>
          <${Fab}
            size="small"
            color="primary"
            sx=${{ position: 'absolute', bottom: 8, right: 16, zIndex: 10 }}
            onClick=${() => {
              const el = messagesRef.current;
              if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
              setAutoScroll(true);
              setUnreadCount(0);
            }}
          >
            ${html`<span style=${{ fontSize: '1rem' }}>↓</span>`}
          </${Fab}>
          ${unreadCount > 0 && html`
            <${Chip}
              label=${`${unreadCount} new`}
              size="small"
              color="primary"
              sx=${{ position: 'absolute', bottom: 48, right: 16, zIndex: 10, height: 20, fontSize: '0.625rem' }}
            />
          `}
        </${Box}>
      `}

      ${!readOnly && html`
      <${Box} sx=${{ borderTop: '1px solid', borderColor: 'divider', px: 2, py: 1 }}>
        ${!isActive && session?.status &&
        html`
          <${Alert} severity="info" sx=${{ mb: 1 }}
            action=${html`<${Button} size="small" color="inherit" onClick=${handleResume}>${resumeLabel}</${Button}>`}
          >
            Session is ${session?.status}.
          </${Alert}>
        `}
        ${pendingAttachments.length > 0 && html`
          <${Stack} direction="row" spacing=${0.5} sx=${{ flexWrap: 'wrap', mb: 0.75 }}>
            ${pendingAttachments.map((att, index) => html`
              <${Chip}
                key=${att.id || `${att.name}-${index}`}
                label=${`${att.name || "attachment"}${att.size ? ` · ${formatBytes(att.size)}` : ""}`}
                size="small"
                variant="outlined"
                onDelete=${() => removeAttachment(index)}
                sx=${{ height: 24, fontSize: '0.6875rem' }}
              />
            `)}
            ${uploadingAttachments && html`
              <${Chip}
                icon=${html`<${CircularProgress} size=${12} />`}
                label="Uploading..."
                size="small"
                variant="outlined"
                sx=${{ height: 24, fontSize: '0.6875rem' }}
              />
            `}
          </${Stack}>
        `}
        <${Stack} direction="row" spacing=${1} alignItems="flex-end">
          <${TextField}
            inputRef=${fileInputRef}
            type="file"
            size="small"
            variant="outlined"
            inputProps=${{ multiple: true }}
            sx=${{ display: "none" }}
            onChange=${handleAttachmentInput}
          />
          <${Tooltip} title="Attach file">
            <${IconButton}
              size="small"
              onClick=${() => fileInputRef.current && fileInputRef.current.click()}
              disabled=${uploadingAttachments}
              sx=${{ mb: 0.5 }}
            >
              ${resolveIcon(":link:")}
            </${IconButton}>
          </${Tooltip}>
          <${TextField}
            inputRef=${inputRef}
            fullWidth
            multiline
            maxRows=${4}
            size="small"
            placeholder="Send a message…"
            value=${input}
            onInput=${handleInput}
            onKeyDown=${handleKeyDown}
            onPaste=${handlePaste}
            onDragOver=${handleDragOver}
            onDragLeave=${handleDragLeave}
            onDrop=${handleDrop}
            sx=${{
              '& .MuiOutlinedInput-root': {
                borderRadius: 2,
                ...(dragActive ? { borderColor: 'primary.main', boxShadow: '0 0 0 2px rgba(25,118,210,0.2)' } : {}),
              },
            }}
            InputProps=${{
              endAdornment: html`
                <${InputAdornment} position="end">
                  <${IconButton}
                    color="primary"
                    disabled=${(!input.trim() && pendingAttachments.length === 0) || sending || uploadingAttachments}
                    onClick=${handleSend}
                    edge="end"
                  >
                    ${resolveIcon("➤")}
                  </${IconButton}>
                </${InputAdornment}>
              `,
            }}
          />
        </${Stack}>
      </${Box}>
      `}
    </${Box}>
  `;
}
