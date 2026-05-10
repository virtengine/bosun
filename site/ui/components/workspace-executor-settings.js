import { h } from "preact";
import htm from "htm";

import {
  Box,
  Button,
  CircularProgress,
  Slider,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";

const html = htm.bind(h);

function clampNumber(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

export function formatWorkspaceExecutorSummary({ maxConcurrent, pool, weight }) {
  const safeSlots = Math.max(1, Math.round(clampNumber(maxConcurrent, 1)));
  const safePool = String(pool || "shared");
  if (safePool === "shared") {
    return `${safeSlots} slots · shared · ${clampNumber(weight, 1).toFixed(1)}x`;
  }
  return `${safeSlots} slots · dedicated`;
}

export function WorkspaceExecutorSettingsFields({
  title = "Workspace Executors",
  description = "",
  maxConcurrent = 1,
  pool = "shared",
  weight = 1,
  onMaxConcurrentChange,
  onPoolChange,
  onWeightChange,
  minSlots = 1,
  maxSlots = 10,
  saving = false,
  hasChanges = false,
  onSave = null,
  saveLabel = "Save Workspace Executors",
}) {
  const safeSlots = Math.max(minSlots, Math.round(clampNumber(maxConcurrent, minSlots)));
  const safePool = String(pool || "shared");
  const safeWeight = clampNumber(weight, 1);
  const summary = formatWorkspaceExecutorSummary({
    maxConcurrent: safeSlots,
    pool: safePool,
    weight: safeWeight,
  });

  return html`
    <div>
      <div class="flex-between" style=${{ alignItems: "baseline", gap: "0.75rem", flexWrap: "wrap" }}>
        <div>
          <div class="form-label">${title}</div>
          ${description && html`<div class="meta-text">${description}</div>`}
        </div>
        <span class="pill">${summary}</span>
      </div>

      <${Box} sx=${{ mt: 1.5 }}>
        <${Typography} variant="caption" color="text.secondary" sx=${{ mb: 0.5, display: "block" }}>
          Max Concurrent Executors: ${safeSlots}
        <//>
        <${Slider}
          value=${safeSlots}
          min=${minSlots}
          max=${maxSlots}
          step=${1}
          marks=${[
            { value: minSlots, label: String(minSlots) },
            { value: Math.min(maxSlots, Math.max(minSlots, 3)), label: String(Math.min(maxSlots, Math.max(minSlots, 3))) },
            { value: Math.min(maxSlots, Math.max(minSlots, 5)), label: String(Math.min(maxSlots, Math.max(minSlots, 5))) },
            { value: maxSlots, label: String(maxSlots) },
          ]}
          size="small"
          onChange=${(_event, value) => onMaxConcurrentChange?.(Number(value))}
          sx=${{ maxWidth: 260 }}
        />
      <//>

      <${Stack} direction="row" spacing=${1} alignItems="center" sx=${{ mt: 1 }}>
        <${Typography} variant="caption" color="text.secondary">Pool:<//>
        <${ToggleButtonGroup}
          value=${safePool}
          exclusive
          onChange=${(_event, value) => value && onPoolChange?.(value)}
          size="small"
          sx=${{ height: 28 }}
        >
          <${ToggleButton} value="shared" sx=${{ px: 1, fontSize: "11px", textTransform: "none" }}>
            <${Tooltip} title="Shares executor capacity across workspaces">
              <span>Shared</span>
            <//>
          <//>
          <${ToggleButton} value="dedicated" sx=${{ px: 1, fontSize: "11px", textTransform: "none" }}>
            <${Tooltip} title="Dedicated executor pool — isolated from other workspaces">
              <span>Dedicated</span>
            <//>
          <//>
        <//>
      <//>

      ${safePool === "shared" && html`
        <${Box} sx=${{ mt: 1.25 }}>
          <${Typography} variant="caption" color="text.secondary" sx=${{ mb: 0.5, display: "block" }}>
            Priority Weight: ${safeWeight.toFixed(1)}x
          <//>
          <div class="range-row">
            <${Slider}
              value=${safeWeight}
              min=${0.1}
              max=${5.0}
              step=${0.1}
              aria-label="Workspace executor priority weight"
              onChange=${(_event, value) => onWeightChange?.(Number(value))}
            />
            <span class="pill">${safeWeight.toFixed(1)}x</span>
          </div>
        <//>
      `}

      ${(saving || hasChanges) && onSave && html`
        <div class="inline-actions" style=${{ marginTop: "1rem" }}>
          <${Button}
            size="small"
            variant="contained"
            onClick=${onSave}
            disabled=${saving}
          >
            ${saving ? html`<${CircularProgress} size=${14} />` : saveLabel}
          <//>
        </div>
      `}
    </div>
  `;
}