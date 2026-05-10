/* ─────────────────────────────────────────────────────────────
 *  VirtEngine Control Center – Form / Control Components
 *  SegmentedControl, Collapsible, PullToRefresh, SearchInput,
 *  Toggle, Stepper, SliderControl
 * ────────────────────────────────────────────────────────────── */

import { h as _h } from "preact";
import {
  useState,
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
  ToggleButton,
  ToggleButtonGroup,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  TextField,
  InputAdornment,
  Switch,
  FormControlLabel,
  Slider,
  ButtonGroup,
  IconButton,
  Typography,
  Box,
  Button,
} from "@mui/material";

const PTR_OPT_OUT_SELECTOR = '[data-ptr-ignore="true"], [data-disable-pull-to-refresh="true"]';

import { ICONS } from "../modules/icons.js";
import { haptic } from "../modules/telegram.js";

/* ═══════════════════════════════════════════════
 *  SegmentedControl
 * ═══════════════════════════════════════════════ */

/**
 * Pill-shaped segmented control.
 * @param {{options: Array<{value: string, label: string}>, value: string, onChange: (v: string) => void}} props
 */
export function SegmentedControl({ options = [], value, onChange, disabled = false }) {
  return html`
    <${ToggleButtonGroup}
      value=${value}
      exclusive
      onChange=${(e, v) => {
        if (v !== null) {
          haptic("light");
          onChange(v);
        }
      }}
      size="small"
      disabled=${disabled}
    >
      ${options.map(
        (opt) => html`
          <${ToggleButton} key=${opt.value} value=${opt.value}>
            ${opt.label}
          </${ToggleButton}>
        `,
      )}
    </${ToggleButtonGroup}>
  `;
}

/* ═══════════════════════════════════════════════
 *  Collapsible
 * ═══════════════════════════════════════════════ */

/**
 * Expandable section with chevron rotation animation.
 * @param {{title: string, defaultOpen?: boolean, children?: any}} props
 */
export function Collapsible({ title, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);

  return html`
    <${Accordion}
      expanded=${open}
      onChange=${() => {
        haptic("light");
        setOpen(!open);
      }}
    >
      <${AccordionSummary} expandIcon=${ICONS.chevronDown}>
        <${Typography}>${title}</${Typography}>
      </${AccordionSummary}>
      <${AccordionDetails}>
        ${children}
      </${AccordionDetails}>
    </${Accordion}>
  `;
}

/* ═══════════════════════════════════════════════
 *  PullToRefresh
 * ═══════════════════════════════════════════════ */

/**
 * Wraps content with pull-to-refresh gesture detection.
 * Shows a spinner while refreshing.
 * @param {{onRefresh: () => Promise<void>, children?: any, disabled?: boolean}} props
 */
export function PullToRefresh({ onRefresh, children, disabled = false }) {
  const [refreshing, setRefreshing] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const containerRef = useRef(null);
  const startYRef = useRef(0);
  const pullingRef = useRef(false);

  // Detect non-touch (desktop) device — initialised synchronously to avoid a
  // first-render flash of the desktop refresh button on touch devices.
  const [hasTouch] = useState(() => {
    if (typeof window === 'undefined') return false;
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  });

  const THRESHOLD = 64;

  // Desktop refresh handler
  const handleDesktopRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    haptic("medium");
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  }, [onRefresh, refreshing]);

  const handleTouchStart = useCallback((e) => {
    if (disabled) return;
    if (!containerRef.current) return;
    const target = e.target;
    if (target instanceof Element && target.closest(PTR_OPT_OUT_SELECTOR)) {
      pullingRef.current = false;
      return;
    }
    const scrollContainer = containerRef.current.querySelector('.main-content') || containerRef.current;
    if (scrollContainer.scrollTop <= 0) {
      startYRef.current = e.touches[0].clientY;
      pullingRef.current = true;
    }
  }, [disabled]);

  const handleTouchMove = useCallback((e) => {
    if (disabled) return;
    if (!pullingRef.current) return;
    const diff = e.touches[0].clientY - startYRef.current;
    if (diff > 0) {
      // Apply diminishing returns to pull distance
      setPullDistance(Math.min(diff * 0.4, THRESHOLD * 1.5));
    }
  }, [disabled]);

  const handleTouchEnd = useCallback(async () => {
    if (disabled) return;
    if (!pullingRef.current) return;
    pullingRef.current = false;

    if (pullDistance >= THRESHOLD) {
      setRefreshing(true);
      haptic("medium");
      try {
        await onRefresh();
      } finally {
        setRefreshing(false);
      }
    }
    setPullDistance(0);
  }, [disabled, onRefresh, pullDistance]);

  return html`
    <div
      ref=${containerRef}
      class="pull-to-refresh-container"
      onTouchStart=${handleTouchStart}
      onTouchMove=${handleTouchMove}
      onTouchEnd=${handleTouchEnd}
    >
      ${!hasTouch && html`
        <${IconButton}
          class="ptr-desktop-refresh ${refreshing ? 'spinning' : ''}"
          onClick=${handleDesktopRefresh}
          disabled=${refreshing}
          title="Refresh"
          aria-label="Refresh"
        >
          ${ICONS.refresh}
        </${IconButton}>
      `}
      ${!disabled && (refreshing || pullDistance > 0) &&
      html`
        <div
          class="ptr-indicator"
          style="height: ${refreshing ? THRESHOLD : pullDistance}px;
            display:flex;align-items:center;justify-content:center;
            overflow:hidden;
            transition: ${pullingRef.current ? "none" : "height 0.2s ease"}"
        >
          ${refreshing
            ? html`<div class="ptr-spinner-icon"></div>`
            : html`<div
                class="ptr-pull-icon"
                style="transform: rotate(${Math.min(pullDistance / THRESHOLD, 1) * 360}deg);
                  opacity: ${Math.min(1, pullDistance / (THRESHOLD * 0.5))}"
              >
                ${ICONS.refresh}
              </div>`}
        </div>
      `}
      ${children}
    </div>
  `;
}

/* ═══════════════════════════════════════════════
 *  SearchInput
 * ═══════════════════════════════════════════════ */

/**
 * Search input with magnifying glass icon and clear button.
 * @param {{value: string, onInput: (e: Event) => void, placeholder?: string, onClear?: () => void}} props
 */
export function SearchInput({
  value = "",
  onInput,
  placeholder = "Search…",
  onClear,
  disabled = false,
  inputRef,
  onKeyDown,
}) {
  return html`
    <${TextField}
      fullWidth
      size="small"
      placeholder=${placeholder}
      value=${value}
      onInput=${onInput}
      onKeyDown=${onKeyDown}
      disabled=${disabled}
      inputRef=${inputRef}
      InputProps=${{
        startAdornment: html`<${InputAdornment} position="start">${ICONS.search}</${InputAdornment}>`,
        endAdornment: value && !disabled
          ? html`<${InputAdornment} position="end">
              <${IconButton} size="small" onClick=${() => { if (onClear) onClear(); }}>
                ${ICONS.close}
              </${IconButton}>
            </${InputAdornment}>`
          : null,
      }}
    />
  `;
}

/* ═══════════════════════════════════════════════
 *  Toggle
 * ═══════════════════════════════════════════════ */

/**
 * iOS-style toggle switch.
 * @param {{checked: boolean, onChange: (checked: boolean) => void, label?: string}} props
 */
export function Toggle({ checked = false, onChange, label, disabled = false }) {
  return html`
    <${FormControlLabel}
      control=${html`
        <${Switch}
          checked=${checked}
          onChange=${() => {
            if (!disabled) {
              haptic("light");
              onChange(!checked);
            }
          }}
          disabled=${disabled}
          size="small"
        />
      `}
      label=${label || ""}
    />
  `;
}

/* ═══════════════════════════════════════════════
 *  Stepper
 * ═══════════════════════════════════════════════ */

/**
 * Numeric stepper with − and + buttons.
 * @param {{value: number, min?: number, max?: number, step?: number, onChange: (v: number) => void, label?: string}} props
 */
export function Stepper({
  value = 0,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  label,
  disabled = false,
}) {
  const decrement = () => {
    if (disabled) return;
    const next = Math.max(min, value - step);
    if (next !== value) {
      haptic("light");
      onChange(next);
    }
  };
  const increment = () => {
    if (disabled) return;
    const next = Math.min(max, value + step);
    if (next !== value) {
      haptic("light");
      onChange(next);
    }
  };

  return html`
    <${Box} sx=${{ display: 'flex', alignItems: 'center', gap: 1 }}>
      ${label ? html`<${Typography} variant="body2">${label}</${Typography}>` : null}
      <${ButtonGroup} size="small" disabled=${disabled}>
        <${Button} onClick=${decrement} disabled=${disabled || value <= min}>−</${Button}>
        <${Button} disabled>${value}</${Button}>
        <${Button} onClick=${increment} disabled=${disabled || value >= max}>+</${Button}>
      </${ButtonGroup}>
    </${Box}>
  `;
}

/* ═══════════════════════════════════════════════
 *  SliderControl
 * ═══════════════════════════════════════════════ */

/**
 * Range slider with value display pill.
 * @param {{value: number, min?: number, max?: number, step?: number, onChange: (v: number) => void, label?: string, suffix?: string}} props
 */
export function SliderControl({
  value = 0,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  label,
  suffix = "",
}) {
  return html`
    <${Box}>
      ${label
        ? html`<${Box} sx=${{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
            <${Typography} variant="body2">${label}</${Typography}>
            <${Typography} variant="body2" color="primary">${value}${suffix}</${Typography}>
          </${Box}>`
        : null}
      <${Slider}
        value=${value}
        min=${min}
        max=${max}
        step=${step}
        onChange=${(e, v) => onChange(v)}
        size="small"
      />
    </${Box}>
  `;
}
