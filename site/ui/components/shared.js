/* ─────────────────────────────────────────────────────────────
 *  VirtEngine Control Center – Shared UI Components
 *  Card, Badge, StatCard, Modal, Toast, EmptyState, etc.
 *  MUI Material edition — preserves all export signatures.
 * ────────────────────────────────────────────────────────────── */

import { h as _h } from "preact";
import { createPortal } from "preact/compat";
import {
  useState,
  useEffect,
  useRef,
  useCallback,
} from "preact/hooks";
import htm from "htm";

/* Guard: recover forwardRef objects that leak as element type */
function h(type, ...args) {
  if (type != null && typeof type === "object" && typeof type !== "function" && typeof type.render === "function") {
    return _h(type.render, ...args);
  }
  return _h(type, ...args);
}

const html = htm.bind(h);

import {
  Card as MuiCard,
  CardContent,
  CardHeader,
  Chip,
  Avatar as MuiAvatar,
  Divider as MuiDivider,
  Skeleton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  CircularProgress,
  LinearProgress,
  Snackbar,
  Alert,
  Button,
  Typography,
  Paper,
  Box,
  Stack,
  Tooltip,
  List as MuiList,
  ListItem as MuiListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListItemSecondaryAction,
  IconButton,
} from "@mui/material";

import { ICONS } from "../modules/icons.js";
import {
  toasts,
  showToast,
  shouldShowToast,
} from "../modules/state.js";
import {
  haptic,
  showBackButton,
  hideBackButton,
  getTg,
} from "../modules/telegram.js";
import { classNames } from "../modules/utils.js";

/* ── helper: map status strings → MUI Chip colors ─────────── */

function mapStatusToMuiColor(normalized) {
  switch (normalized) {
    case "done":
      return "success";
    case "error":
    case "critical":
      return "error";
    case "inprogress":
    case "inreview":
    case "info":
      return "info";
    case "warning":
    case "high":
    case "medium":
      return "warning";
    case "draft":
    case "todo":
    case "cancelled":
    case "low":
    case "log":
      return "default";
    default:
      return undefined; // signals "unknown" — use outlined variant
  }
}

/* ═══════════════════════════════════════════════
 *  Card
 * ═══════════════════════════════════════════════ */

/**
 * Card container with optional title / subtitle.
 * @param {{title?: string, subtitle?: string, children?: any, className?: string, onClick?: () => void}} props
 */
export function Card({ title, subtitle, children, className = "", onClick }) {
  return html`
    <${MuiCard}
      sx=${{ cursor: onClick ? "pointer" : "default" }}
      className=${className}
      onClick=${onClick}
    >
      <${CardContent}>
        ${title
          ? html`<${Typography} variant="subtitle1" fontWeight=${600}>${title}</${Typography}>`
          : null}
        ${subtitle
          ? html`<${Typography} variant="body2" color="text.secondary">${subtitle}</${Typography}>`
          : null}
        ${children}
      </${CardContent}>
    </${MuiCard}>
  `;
}

/* ═══════════════════════════════════════════════
 *  Badge
 * ═══════════════════════════════════════════════ */

const BADGE_STATUS_MAP = new Set([
  "draft",
  "todo",
  "inprogress",
  "inreview",
  "done",
  "error",
  "cancelled",
  "critical",
  "high",
  "medium",
  "low",
  "log",
  "info",
  "warning",
]);

/**
 * Status badge pill.
 * @param {{status?: string, text?: string, className?: string}} props
 */
export function Badge({ status, text, className = "" }) {
  const label = text || status || "";
  const normalized = (status || "").toLowerCase().replace(/\s+/g, "");
  const muiColor = mapStatusToMuiColor(normalized);

  return html`<${Chip}
    label=${label}
    size="small"
    color=${muiColor || "default"}
    variant=${muiColor ? "filled" : "outlined"}
    className=${className}
  />`;
}

/* ═══════════════════════════════════════════════
 *  StatCard
 * ═══════════════════════════════════════════════ */

/**
 * Stat display card with large value and small label.
 * @param {{value: any, label: string, trend?: 'up'|'down', color?: string}} props
 */
export function StatCard({ value, label, trend, color }) {
  const trendIcon =
    trend === "up"
      ? html`<${Typography} component="span" sx=${{ color: "success.main", ml: 0.5 }}>↑</${Typography}>`
      : trend === "down"
        ? html`<${Typography} component="span" sx=${{ color: "error.main", ml: 0.5 }}>↓</${Typography}>`
        : null;

  return html`
    <${MuiCard}>
      <${CardContent} sx=${{ textAlign: "center", py: 2 }}>
        <${Typography}
          variant="h4"
          fontWeight=${700}
          sx=${{ color: color || "text.primary" }}
        >
          ${value ?? "—"}${trendIcon}
        </${Typography}>
        <${Typography} variant="body2" color="text.secondary" sx=${{ mt: 0.5 }}>
          ${label}
        </${Typography}>
      </${CardContent}>
    </${MuiCard}>
  `;
}

/* ═══════════════════════════════════════════════
 *  SkeletonCard
 * ═══════════════════════════════════════════════ */

/**
 * Animated loading placeholder.
 * @param {{height?: string, className?: string}} props
 */
export function SkeletonCard({ height = "80px", className = "" }) {
  return html`<${Skeleton}
    variant="rectangular"
    height=${height}
    sx=${{ borderRadius: 2 }}
    className=${className}
  />`;
}

/* ═══════════════════════════════════════════════
 *  Modal (Bottom Sheet)
 * ═══════════════════════════════════════════════ */

/**
 * Bottom-sheet modal with drag handle, title, swipe-to-dismiss, and TG BackButton integration.
 * Custom implementation preserved (drag/swipe too complex for MUI Dialog).
 * Uses Fade transition and Portal from preact/compat.
 * @param {{
 * title?: string,
 * open?: boolean,
 * onClose: () => void,
 * children?: any,
 * contentClassName?: string,
 * footer?: any,
 * unsavedChanges?: number,
 * onSaveBeforeClose?: (() => Promise<boolean|{closed?: boolean}|void>)|null,
 * onDiscardBeforeClose?: (() => Promise<boolean|{closed?: boolean}|void>)|null,
 * activeOperationLabel?: string,
 * closeGuard?: boolean,
 * layout?: "sheet"|"side-sheet",
 * resizable?: boolean,
 * defaultWidth?: number,
 * minWidth?: number,
 * maxWidth?: number,
 * widthStorageKey?: string
 * }} props
 */
export function Modal({
  title,
  open = true,
  onClose,
  children,
  contentClassName = "",
  footer,
  unsavedChanges = 0,
  onSaveBeforeClose = null,
  onDiscardBeforeClose = null,
  activeOperationLabel = "",
  closeGuard = true,
  layout = "sheet",
  resizable = false,
  defaultWidth = 760,
  minWidth = 440,
  maxWidth = 1120,
  widthStorageKey = "",
}) {
  const [visible, setVisible] = useState(false);
  const contentRef = useRef(null);
  const dragState = useRef({ startY: 0, startRect: 0, dragging: false });
  const [dragY, setDragY] = useState(0);
  const [closePromptOpen, setClosePromptOpen] = useState(false);
  const [closePromptSaving, setClosePromptSaving] = useState(false);
  const isSideSheet = layout === "side-sheet";
  const [sheetWidth, setSheetWidth] = useState(() => {
    const fallback = Number.isFinite(Number(defaultWidth)) ? Number(defaultWidth) : 760;
    if (!isSideSheet || !widthStorageKey || typeof localStorage === "undefined") return fallback;
    const stored = Number(localStorage.getItem(widthStorageKey));
    return Number.isFinite(stored) ? stored : fallback;
  });
  const scopedUnsavedCount = Number.isFinite(Number(unsavedChanges))
    ? Math.max(0, Number(unsavedChanges))
    : 0;
  const hasScopedUnsaved = scopedUnsavedCount > 0;
  const hasUnsaved = hasScopedUnsaved;
  const operationLabel = String(activeOperationLabel || "").trim();

  const requestClose = useCallback(() => {
    if (!onClose) return;
    if (!closeGuard || (!hasUnsaved && !operationLabel)) {
      onClose();
      return;
    }
    setClosePromptOpen(true);
  }, [closeGuard, hasUnsaved, onClose, operationLabel]);

  useEffect(() => {
    requestAnimationFrame(() => setVisible(open));
  }, [open]);

  useEffect(() => {
    if (open) return;
    setClosePromptOpen(false);
    setClosePromptSaving(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    document.body.classList.add("modal-open");
    return () => document.body.classList.remove("modal-open");
  }, [open]);

  // Escape key to close (desktop support)
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (e.key !== "Escape") return;
      if (closePromptOpen) {
        setClosePromptOpen(false);
        return;
      }
      requestClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [closePromptOpen, open, requestClose]);

  // BackButton integration
  useEffect(() => {
    const handler = () => {
      if (closePromptOpen) {
        setClosePromptOpen(false);
        return;
      }
      requestClose();
    };
    showBackButton(handler);

    return () => {
      hideBackButton();
    };
  }, [closePromptOpen, requestClose]);

  // Prevent body scroll while dragging
  useEffect(() => {
    if (dragState.current.dragging) {
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = ""; };
    }
  });

  // Visual viewport (software keyboard) awareness
  // Sets --keyboard-height on :root so the modal can lift above the keyboard
  useEffect(() => {
    if (!open) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      // keyboard height = amount the visual viewport has shrunk from the layout viewport
      const kh = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty("--keyboard-height", `${kh}px`);
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      document.documentElement.style.setProperty("--keyboard-height", "0px");
    };
  }, [open]);
  // Prevent touches on the scrollable body from triggering swipe-to-dismiss
  const handleBodyTouchStart = useCallback((e) => {
    e.stopPropagation();
  }, []);

  const isDragHandleTarget = useCallback((target) => (
    !isSideSheet && Boolean(target?.closest?.(".modal-handle, .modal-header"))
  ), [isSideSheet]);

  const persistSheetWidth = useCallback((nextWidth) => {
    if (!widthStorageKey || typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(widthStorageKey, String(nextWidth));
    } catch {
      /* ignore width persistence failures */
    }
  }, [widthStorageKey]);

  const handleSheetResizeStart = useCallback((event) => {
    if (!isSideSheet || !resizable) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = sheetWidth;
    const minAllowed = Math.max(320, Number.isFinite(Number(minWidth)) ? Number(minWidth) : 440);
    const maxAllowedBase = Number.isFinite(Number(maxWidth)) ? Number(maxWidth) : 1120;
    const maxAllowed = typeof window !== "undefined"
      ? Math.min(maxAllowedBase, Math.max(minAllowed, window.innerWidth - 48))
      : maxAllowedBase;
    let latestWidth = startWidth;
    const onMove = (moveEvent) => {
      const delta = startX - moveEvent.clientX;
      latestWidth = Math.max(minAllowed, Math.min(maxAllowed, startWidth + delta));
      setSheetWidth(latestWidth);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      persistSheetWidth(latestWidth);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [isSideSheet, maxWidth, minWidth, persistSheetWidth, resizable, sheetWidth]);

  const handleTouchStart = useCallback((e) => {
    if (!isDragHandleTarget(e.target)) return;

    // Don't intercept touches on the close button
    if (e.target.closest?.(".modal-close-btn")) return;
    const el = contentRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const touchY = e.touches[0].clientY;
    // Only start drag if touch is within top 60px of the modal content
    if (touchY - rect.top > 120) return;
    dragState.current = { startY: touchY, startRect: rect.top, dragging: true };
    // Disable transition during active drag
    el.style.transition = "none";
  }, []);

  const handleTouchMove = useCallback((e) => {
    if (!dragState.current.dragging) return;
    const deltaY = e.touches[0].clientY - dragState.current.startY;
    if (deltaY < 0) {
      setDragY(0);
      return;
    }
    // Diminishing returns past 100px
    const translated = deltaY <= 100 ? deltaY : 100 + (deltaY - 100) * 0.3;
    setDragY(translated);
    e.preventDefault();
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (!dragState.current.dragging) return;
    dragState.current.dragging = false;
    const el = contentRef.current;
    if (el) el.style.transition = "";
    if (dragY > 110) {
      haptic("light");
      requestClose();
    }
    setDragY(0);
  }, [dragY, requestClose]);

  const handlePointerDown = useCallback((e) => {
    if (e.pointerType === "touch") return;
    // Don't intercept clicks on the close button
    if (e.target.closest?.(".modal-close-btn")) return;
    const el = contentRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (!isDragHandleTarget(e.target)) return;
    if (e.clientY - rect.top > 120) return;
    dragState.current = {
      startY: e.clientY,
      startRect: rect.top,
      dragging: true,
      pointerId: e.pointerId,
    };
    el.style.transition = "none";
    try { el.setPointerCapture(e.pointerId); } catch { /* no-op */ }
  }, []);

  const handlePointerMove = useCallback((e) => {
    if (!dragState.current.dragging) return;
    if (dragState.current.pointerId !== e.pointerId) return;
    const deltaY = e.clientY - dragState.current.startY;
    if (deltaY < 0) {
      setDragY(0);
      return;
    }
    const translated = deltaY <= 100 ? deltaY : 100 + (deltaY - 100) * 0.3;
    setDragY(translated);
    e.preventDefault();
  }, []);

  const handlePointerEnd = useCallback((e) => {
    if (!dragState.current.dragging) return;
    if (dragState.current.pointerId !== e.pointerId) return;
    dragState.current.dragging = false;
    dragState.current.pointerId = null;
    const el = contentRef.current;
    if (el) {
      el.style.transition = "";
      try { el.releasePointerCapture(e.pointerId); } catch { /* no-op */ }
    }
    if (dragY > 110) {
      haptic("light");
      requestClose();
    }
    setDragY(0);
  }, [dragY, requestClose]);

  const handlePointerCancel = useCallback((e) => {
    if (!dragState.current.dragging) return;
    if (dragState.current.pointerId !== e.pointerId) return;
    dragState.current.dragging = false;
    dragState.current.pointerId = null;
    const el = contentRef.current;
    if (el) {
      el.style.transition = "";
      try { el.releasePointerCapture(e.pointerId); } catch { /* no-op */ }
    }
    setDragY(0);
  }, []);

  const handleTouchCancel = useCallback(() => {
    if (!dragState.current.dragging) return;
    dragState.current.dragging = false;
    const el = contentRef.current;
    if (el) el.style.transition = "";
    setDragY(0);
  }, []);

  if (!open) return null;

  const guardTitle = hasUnsaved
    ? "You have unsaved changes"
    : "Action in progress";
  const guardUnsavedLine = hasUnsaved
    ? hasScopedUnsaved
      ? `You have unsaved changes (${scopedUnsavedCount}).`
      : "You have unsaved changes."
    : "";
  const guardActivityLine = operationLabel
    ? `Active operation: ${operationLabel}.`
    : "";
  const guardHintLine = operationLabel
    ? "Closing now may ignore pending updates."
    : "Choose whether to save before closing.";

  const handleDiscardAndClose = async () => {
    if (closePromptSaving) return;
    try {
      if (typeof onDiscardBeforeClose === "function") {
        const result = await onDiscardBeforeClose();
        if (result === false) return;
        if (result && typeof result === "object" && result.closed) {
          setClosePromptOpen(false);
          return;
        }
      }
      setClosePromptOpen(false);
      onClose?.();
    } catch (err) {
      showToast(
        err?.message || "Could not discard changes before closing.",
        "error",
      );
    }
  };

  const handleSaveAndClose = async () => {
    if (closePromptSaving) return;
    if (typeof onSaveBeforeClose !== "function") {
      showToast(
        "Save before close is not available for this form.",
        "warning",
      );
      return;
    }
    setClosePromptSaving(true);
    try {
      const result = await onSaveBeforeClose();
      if (result === false) return;
      if (result && typeof result === "object" && result.closed) {
        setClosePromptOpen(false);
        return;
      }
      setClosePromptOpen(false);
      onClose?.();
    } catch (err) {
      showToast(
        err?.message || "Save failed. Resolve errors before closing.",
        "error",
      );
    } finally {
      setClosePromptSaving(false);
    }
  };

  const dragStyle = dragY > 0
    ? `transform: translateY(${dragY}px); opacity: ${Math.max(0.2, 1 - dragY / 400)}`
    : "";
  const contentStyle = [
    dragStyle,
    isSideSheet ? `--modal-sheet-width:${sheetWidth}px` : "",
  ].filter(Boolean).join("; ");

  const content = html`
    <div
      class="modal-overlay ${visible ? "modal-overlay-visible" : ""}"
      onClick=${(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        ref=${contentRef}
        class="modal-content ${isSideSheet ? "modal-side-sheet" : ""} ${contentClassName} ${visible ? "modal-content-visible" : ""} ${dragY > 0 ? "modal-dragging" : ""}"
        style=${contentStyle}
        onClick=${(e) => e.stopPropagation()}
        onTouchStart=${handleTouchStart}
        onTouchMove=${handleTouchMove}
        onTouchEnd=${handleTouchEnd}
        onTouchCancel=${handleTouchCancel}
        onPointerDown=${handlePointerDown}
        onPointerMove=${handlePointerMove}
        onPointerUp=${handlePointerEnd}
        onPointerCancel=${handlePointerCancel}
      >
        ${isSideSheet && resizable
          ? html`<div
              class="modal-sheet-resizer"
              onPointerDown=${handleSheetResizeStart}
              title="Resize panel"
            ></div>`
          : null}
        <div class="modal-header">
          <div class="modal-handle"></div>
          ${title ? html`<div class="modal-title">${title}</div>` : null}
          <${IconButton}
            className="modal-close-btn"
            size="small"
            onTouchStart=${(e) => e.stopPropagation()}
            onPointerDown=${(e) => e.stopPropagation()}
            onPointerUp=${(e) => e.stopPropagation()}
            onMouseDown=${(e) => e.stopPropagation()}
            onClick=${requestClose}
            aria-label="Close"
            sx=${{ position: "absolute", right: 8, top: 8, zIndex: 8, pointerEvents: "auto" }}
          >
            ${ICONS.close}
          <//>
        </div>
        <div class="modal-body" onTouchStart=${handleBodyTouchStart}>
          ${children}
        </div>
        ${footer ? html`<div class="modal-footer">${footer}</div>` : null}
      </div>
    </div>
  `;

  const guard = closePromptOpen
    ? html`
        <${Dialog}
          open=${closePromptOpen}
          onClose=${() => {
            if (!closePromptSaving) setClosePromptOpen(false);
          }}
        >
          <${DialogTitle}>${guardTitle}</${DialogTitle}>
          <${DialogContent}>
            ${guardUnsavedLine ? html`<${Typography} variant="body2" sx=${{ mb: 0.5 }}>${guardUnsavedLine}</${Typography}>` : null}
            ${guardActivityLine ? html`<${Typography} variant="body2" sx=${{ mb: 0.5 }}>${guardActivityLine}</${Typography}>` : null}
            <${Typography} variant="body2">${guardHintLine}</${Typography}>
          </${DialogContent}>
          <${DialogActions}>
            <${Button}
              onClick=${() => setClosePromptOpen(false)}
              disabled=${closePromptSaving}
            >
              Cancel
            </${Button}>
            <${Button}
              onClick=${handleDiscardAndClose}
              disabled=${closePromptSaving}
            >
              ${hasUnsaved ? "Discard & Close" : "Close Anyway"}
            </${Button}>
            ${hasUnsaved
              ? html`
                  <${Button}
                    variant="contained"
                    onClick=${handleSaveAndClose}
                    disabled=${closePromptSaving || typeof onSaveBeforeClose !== "function"}
                  >
                    ${closePromptSaving ? "Saving…" : "Save & Close"}
                  </${Button}>
                `
              : null}
          </${DialogActions}>
        </${Dialog}>
      `
    : null;
  return createPortal(html`${content}${guard}`, document.body);
}

/* ═══════════════════════════════════════════════
 *  ConfirmDialog
 * ═══════════════════════════════════════════════ */

/**
 * Confirmation dialog — tries Telegram native showConfirm first, falls back to MUI Dialog.
 * @param {{title?: string, message: string, confirmText?: string, cancelText?: string, onConfirm: () => void, onCancel: () => void, destructive?: boolean}} props
 */
export function ConfirmDialog({
  title = "Confirm",
  message,
  confirmText = "Confirm",
  cancelText = "Cancel",
  onConfirm,
  onCancel,
  destructive = false,
}) {
  const [tried, setTried] = useState(false);

  // Escape key to cancel (desktop support)
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape' && onCancel) onCancel(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onCancel]);

  // Try Telegram native confirm first
  useEffect(() => {
    const tg = getTg();
    if (tg?.showConfirm && !tried) {
      setTried(true);
      tg.showConfirm(message, (ok) => {
        if (ok) onConfirm();
        else onCancel();
      });
    }
  }, [message, onConfirm, onCancel, tried]);

  // If Telegram native is available, render nothing (native dialog handles it)
  if (getTg()?.showConfirm) return null;

  return html`
    <${Dialog} open onClose=${onCancel}>
      <${DialogTitle}>${title}</${DialogTitle}>
      <${DialogContent}>
        <${Typography} variant="body1">${message}</${Typography}>
      </${DialogContent}>
      <${DialogActions}>
        <${Button} onClick=${onCancel}>
          ${cancelText}
        </${Button}>
        <${Button}
          variant="contained"
          color=${destructive ? "error" : "primary"}
          onClick=${onConfirm}
        >
          ${confirmText}
        </${Button}>
      </${DialogActions}>
    </${Dialog}>
  `;
}

/* ═══════════════════════════════════════════════
 *  confirmAction (Promise-based utility)
 * ═══════════════════════════════════════════════ */

/**
 * Quick inline confirmation — returns a Promise<boolean>.
 * Uses Telegram native confirm if available, otherwise browser confirm().
 * @param {string} message
 * @returns {Promise<boolean>}
 */
export function confirmAction(message) {
  const tg = getTg();
  if (tg?.showConfirm) {
    return new Promise((resolve) => tg.showConfirm(message, resolve));
  }
  return Promise.resolve(window.confirm(message));
}

/* ═══════════════════════════════════════════════
 *  Spinner
 * ═══════════════════════════════════════════════ */

/**
 * Inline spinner for loading indicators.
 * @param {{size?: number, color?: string}} props
 */
export function Spinner({ size = 16, color = "currentColor" }) {
  return html`<${CircularProgress} size=${size} sx=${{ color }} />`;
}

/* ═══════════════════════════════════════════════
 *  LoadingButton
 * ═══════════════════════════════════════════════ */

/**
 * Button that shows a spinner when loading.
 * @param {{loading?: boolean, onClick?: () => void, children?: any, class?: string, disabled?: boolean}} props
 */
export function LoadingButton({ loading = false, onClick, children, class: cls = "", disabled = false, ...rest }) {
  return html`<${Button}
    variant="contained"
    disabled=${loading || disabled}
    onClick=${!loading && !disabled ? onClick : undefined}
    className=${cls}
    ...${rest}
  >${loading ? html`<${CircularProgress} size=${14} sx=${{ mr: 0.5 }} />` : ""}${children}</${Button}>`;
}

/* ═══════════════════════════════════════════════
 *  Toast / ToastContainer
 * ═══════════════════════════════════════════════ */

/** Map toast type strings to MUI Alert severity values */
function mapToastSeverity(type) {
  switch (type) {
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "success":
      return "success";
    default:
      return "info";
  }
}

/**
 * Renders all active toasts from the toasts signal.
 * Each toast auto-dismisses (handled by showToast in state.js).
 */
export function ToastContainer() {
  const items = toasts.value;
  if (!items.length) return null;

  const visible = items.filter(shouldShowToast);
  if (!visible.length) return null;

  const content = html`
    <${Box} sx=${{
      position: "fixed",
      top: 16,
      right: 16,
      zIndex: 13000,
      display: "flex",
      flexDirection: "column",
      gap: 1,
      maxWidth: 400,
    }}>
      ${visible.map(
        (t) => html`
          <${Snackbar}
            key=${t.id}
            open
            anchorOrigin=${{ vertical: "top", horizontal: "right" }}
            sx=${{ position: "static", transform: "none" }}
          >
            <${Alert}
              severity=${mapToastSeverity(t.type)}
              variant="filled"
              onClose=${() => {
                toasts.value = toasts.value.filter((x) => x.id !== t.id);
              }}
              sx=${{ width: "100%" }}
            >
              ${t.message}
            </${Alert}>
          </${Snackbar}>
        `,
      )}
    </${Box}>
  `;
  return createPortal(content, document.body);
}

/* ═══════════════════════════════════════════════
 *  EmptyState
 * ═══════════════════════════════════════════════ */

/**
 * Empty state display.
 * @param {{icon?: string, title?: string, message?: string, description?: string, action?: {label: string, onClick: () => void}}} props
 */
export function EmptyState({ icon, title, message, description, action }) {
  const iconSvg = icon && ICONS[icon] ? ICONS[icon] : null;
  const displayIcon = iconSvg ? html`<${Box} sx=${{ mb: 1, "& svg": { width: 48, height: 48, opacity: 0.5 } }}>${iconSvg}</${Box}>`
    : icon ? html`<${Box} sx=${{ mb: 1, fontSize: 48, opacity: 0.5 }}>${icon}</${Box}>`
    : null;
  const displayTitle = title || message || null;
  return html`
    <${Box} sx=${{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      py: 6,
      px: 3,
      textAlign: "center",
    }}>
      ${displayIcon}
      ${displayTitle
        ? html`<${Typography} variant="h6" sx=${{ mb: 1, opacity: 0.7 }}>${displayTitle}</${Typography}>`
        : null}
      ${description
        ? html`<${Typography} variant="body2" color="text.secondary" sx=${{ mb: 2 }}>${description}</${Typography}>`
        : null}
      ${action
        ? html`<${Button} variant="contained" size="small" onClick=${action.onClick}>
            ${action.label}
          </${Button}>`
        : null}
    </${Box}>
  `;
}

/* ═══════════════════════════════════════════════
 *  Divider
 * ═══════════════════════════════════════════════ */

/**
 * Section divider with optional centered label.
 * @param {{label?: string}} props
 */
export function Divider({ label }) {
  if (!label) return html`<${MuiDivider} />`;
  return html`<${MuiDivider} textAlign="center">${label}</${MuiDivider}>`;
}

/* ═══════════════════════════════════════════════
 *  Avatar
 * ═══════════════════════════════════════════════ */

/**
 * Circle avatar with initials fallback.
 * @param {{name?: string, size?: number, src?: string}} props
 */
export function Avatar({ name = "", size = 36, src }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join("");

  return html`
    <${MuiAvatar}
      src=${src || undefined}
      alt=${name}
      sx=${{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.4),
        fontWeight: 600,
        bgcolor: src ? undefined : "primary.main",
      }}
    >
      ${!src ? (initials || "?") : null}
    </${MuiAvatar}>
  `;
}

/* ═══════════════════════════════════════════════
 *  ListItem
 * ═══════════════════════════════════════════════ */

/**
 * Generic list item for settings-style lists.
 * @param {{title: string, subtitle?: string, trailing?: any, onClick?: () => void, icon?: string}} props
 */
export function ListItem({ title, subtitle, trailing, onClick, icon }) {
  const iconSvg = icon && ICONS[icon] ? ICONS[icon] : null;

  const inner = html`
    ${iconSvg ? html`<${ListItemIcon} sx=${{ minWidth: 36, "& svg": { width: 20, height: 20 } }}>${iconSvg}</${ListItemIcon}>` : null}
    <${ListItemText}
      primary=${title}
      secondary=${subtitle || undefined}
    />
    ${trailing != null
      ? html`<${ListItemSecondaryAction}>${trailing}</${ListItemSecondaryAction}>`
      : null}
  `;

  if (onClick) {
    return html`
      <${MuiListItem} disablePadding>
        <${ListItemButton} onClick=${onClick}>
          ${inner}
        </${ListItemButton}>
      </${MuiListItem}>
    `;
  }

  return html`
    <${MuiListItem}>
      ${inner}
    </${MuiListItem}>
  `;
}

/**
 * Shared floating save/discard action bar for dirty forms.
 * @param {{
 *  dirty: boolean,
 *  message?: string,
 *  saveLabel?: string,
 *  discardLabel?: string,
 *  onSave: () => void,
 *  onDiscard: () => void,
 *  saving?: boolean,
 *  disabled?: boolean,
 *  className?: string
 * }} props
 */
export function SaveDiscardBar({
  dirty,
  message = "Changes pending",
  saveLabel = "Save",
  discardLabel = "Discard",
  onSave,
  onDiscard,
  saving = false,
  disabled = false,
  className = "",
}) {
  if (!dirty) return null;
  return html`
    <${Paper}
      elevation=${4}
      className=${className}
      sx=${{
        position: "sticky",
        bottom: 0,
        p: 1.5,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        zIndex: 10,
        borderRadius: 2,
      }}
    >
      <${Typography} variant="body2" color="text.secondary">
        ${message}
      </${Typography}>
      <${Stack} direction="row" spacing=${1}>
        <${Button}
          size="small"
          onClick=${onDiscard}
          disabled=${disabled || saving}
        >
          ${discardLabel}
        </${Button}>
        <${Button}
          variant="contained"
          size="small"
          onClick=${onSave}
          disabled=${disabled || saving}
        >
          ${saving ? "Saving…" : saveLabel}
        </${Button}>
      </${Stack}>
    </${Paper}>
  `;
}
