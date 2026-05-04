/* ─────────────────────────────────────────────────────────────
 *  VirtEngine Control Center – Chart Components
 *  DonutChart, ProgressBar, MiniSparkline
 * ────────────────────────────────────────────────────────────── */

import { h } from "preact";
import htm from "htm";
import { LinearProgress, Box, Typography, Chip, Stack } from "@mui/material";

const html = htm.bind(h);

/* ═══════════════════════════════════════════════
 *  DonutChart
 * ═══════════════════════════════════════════════ */

/**
 * SVG donut chart with animated arcs and a legend below.
 *
 * @param {{
 *   segments: Array<{value: number, color: string, label: string}>,
 *   size?: number,
 *   strokeWidth?: number
 * }} props
 */
export function DonutChart({ segments = [], size = 120, strokeWidth = 12 }) {
  const total = segments.reduce((sum, seg) => sum + (seg.value || 0), 0);
  if (!total) {
    return html`<div class="text-center meta-text">No data</div>`;
  }

  const cx = size / 2;
  const cy = size / 2;
  const r = (size - strokeWidth) / 2 - 2; // radius with some padding
  const circumference = 2 * Math.PI * r;
  let offset = 0;

  const arcs = segments.map((seg) => {
    const pct = seg.value / total;
    const dash = pct * circumference;
    const currentOffset = offset;
    offset += dash;
    return html`
      <circle
        cx=${cx}
        cy=${cy}
        r=${r}
        fill="none"
        stroke=${seg.color}
        stroke-width=${strokeWidth}
        stroke-dasharray="${dash} ${circumference - dash}"
        stroke-dashoffset=${-currentOffset}
        stroke-linecap="round"
        style="transition: stroke-dasharray 0.6s ease, stroke-dashoffset 0.6s ease"
      />
    `;
  });

  return html`
    <div class="donut-wrap">
      <svg
        width=${size}
        height=${size}
        viewBox="0 0 ${size} ${size}"
        style="display: block; margin: 0 auto"
      >
        <!-- Arcs are rotated -90° so they start at the 12 o'clock position.
             The centered total text stays upright by living outside this group. -->
        <g transform="rotate(-90 ${cx} ${cy})">
          <!-- Background track -->
          <circle
            cx=${cx}
            cy=${cy}
            r=${r}
            fill="none"
            stroke="var(--bg-secondary, #2a2a3e)"
            stroke-width=${strokeWidth}
            opacity="0.3"
          />
          ${arcs}
        </g>
        <text
          x=${cx}
          y=${cy}
          text-anchor="middle"
          dominant-baseline="central"
          font-size="18"
          font-weight="700"
          fill="var(--text-primary, #fff)"
          style="font-family: inherit"
        >${total}</text>
      </svg>
    </div>
    <${Stack} direction="row" spacing=${1} flexWrap="wrap" justifyContent="center" sx=${{ mt: 1 }}>
      ${segments.map(
        (seg) => html`
          <${Chip}
            label=${`${seg.label} (${seg.value})`}
            size="small"
            sx=${{ backgroundColor: seg.color, color: '#fff', fontWeight: 500 }}
          />
        `,
      )}
    <//>
  `;
}

/* ═══════════════════════════════════════════════
 *  ProgressBar
 * ═══════════════════════════════════════════════ */

/**
 * Horizontal progress bar with gradient fill and smooth transition.
 *
 * @param {{
 *   value: number,
 *   max?: number,
 *   color?: string,
 *   height?: number,
 *   animated?: boolean
 * }} props
 */
export function ProgressBar({
  value = 0,
  max = 100,
  color,
  height = 8,
  animated = true,
}) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const bg = color || "var(--accent, #5b6eae)";

  return html`
    <${LinearProgress} variant="determinate" value=${pct} sx=${{
      height: height, borderRadius: height / 2,
      backgroundColor: 'var(--bg-secondary, rgba(255,255,255,0.08))',
      '& .MuiLinearProgress-bar': {
        borderRadius: height / 2,
        backgroundColor: bg,
        transition: animated ? 'transform 0.5s ease' : 'none'
      }
    }} />
  `;
}

/* ═══════════════════════════════════════════════
 *  MiniSparkline
 * ═══════════════════════════════════════════════ */

/**
 * Tiny inline sparkline chart using SVG polyline.
 *
 * @param {{
 *   data: number[],
 *   color?: string,
 *   height?: number,
 *   width?: number
 * }} props
 */
let _sparkId = 0;

export function MiniSparkline({
  data = [],
  color = "var(--accent, #5b6eae)",
  height = 24,
  width = 80,
}) {
  if (!data.length) return null;

  const gradId = `sparkGrad-${++_sparkId}`;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const padding = 2;
  const usableH = height - padding * 2;
  const usableW = width - padding * 2;
  const step = data.length > 1 ? usableW / (data.length - 1) : 0;

  const points = data
    .map((v, i) => {
      const x = padding + i * step;
      const y = padding + usableH - ((v - min) / range) * usableH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  // Filled area path
  const firstX = padding;
  const lastX = padding + (data.length - 1) * step;
  const areaPath =
    `M${firstX},${height} ` +
    data
      .map((v, i) => {
        const x = padding + i * step;
        const y = padding + usableH - ((v - min) / range) * usableH;
        return `L${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ") +
    ` L${lastX.toFixed(1)},${height} Z`;

  return html`
    <svg
      width=${width}
      height=${height}
      viewBox="0 0 ${width} ${height}"
      style="display:block"
    >
      <defs>
        <linearGradient id=${gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color=${color} stop-opacity="0.25" />
          <stop offset="100%" stop-color=${color} stop-opacity="0" />
        </linearGradient>
      </defs>
      <path d=${areaPath} fill="url(#${gradId})" />
      <polyline
        points=${points}
        fill="none"
        stroke=${color}
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  `;
}
