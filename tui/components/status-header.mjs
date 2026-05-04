import React from "react";
import htm from "htm";
import * as ink from "ink";

const Box = ink.Box ?? ink.default?.Box;
const Text = ink.Text ?? ink.default?.Text;

const html = htm.bind(React.createElement);

const PROVIDER_ORDER = ["claude", "codex", "gemini", "copilot"];
const PROVIDER_ALIASES = {
  anthropic: "claude",
  claude: "claude",
  openai: "codex",
  azure: "codex",
  codex: "codex",
  google: "gemini",
  gemini: "gemini",
  copilot: "copilot",
  github: "copilot",
};
const TONE_COLORS = {
  normal: undefined,
  dim: undefined,
  warning: "yellow",
  danger: "red",
};
const CONNECTION_STATES = {
  connected: { color: "green", label: "Connected" },
  reconnecting: { color: "yellow", label: "Reconnecting" },
  offline: { color: "red", label: "Offline" },
};

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function padMetric(value, width = 0) {
  return String(value ?? "").padStart(width, " ");
}

function formatCompactMetric(value) {
  const numeric = Math.max(0, toNumber(value, 0));
  if (numeric >= 1_000_000) return `${(numeric / 1_000_000).toFixed(1)}m`;
  if (numeric >= 1_000) return `${(numeric / 1_000).toFixed(1)}k`;
  if (numeric >= 100) return String(Math.round(numeric));
  if (numeric >= 10) return Number(numeric.toFixed(1)).toString();
  return Number(numeric.toFixed(2)).toString();
}

function formatDuration(ms) {
  const safeMs = Math.max(0, toNumber(ms, 0));
  const totalSeconds = Math.floor(safeMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function normalizeProviderKey(provider) {
  const normalized = String(provider || "").trim().toLowerCase();
  return PROVIDER_ALIASES[normalized] || normalized;
}

function formatRateValue(value, unit = "min") {
  if (value == null) return "n/a";
  return `${toNumber(value, 0)}/${unit}`;
}

function resolveProviderTone(bucket = {}) {
  const values = [bucket.primary, bucket.secondary, bucket.credits]
    .map((value) => (value == null ? null : toNumber(value, NaN)))
    .filter((value) => Number.isFinite(value));
  if (values.some((value) => value <= 0)) return "danger";

  const limits = [
    [bucket.primary, bucket.primaryLimit],
    [bucket.secondary, bucket.secondaryLimit],
    [bucket.credits, bucket.creditsLimit],
  ];
  if (limits.some(([remaining, limit]) => Number.isFinite(Number(remaining)) && Number.isFinite(Number(limit)) && Number(limit) > 0 && (Number(remaining) / Number(limit)) <= 0.2)) {
    return "warning";
  }
  if (values.some((value) => value <= 20)) return "warning";
  return "normal";
}

export function normalizeHeaderRateLimits(rateLimits = {}, configuredProviders = {}) {
  const normalized = {};
  for (const [provider, bucket] of Object.entries(rateLimits || {})) {
    const key = normalizeProviderKey(provider);
    if (!PROVIDER_ORDER.includes(key) || !bucket || typeof bucket !== "object") continue;
    normalized[key] = {
      primary: bucket.primary == null ? null : toNumber(bucket.primary, 0),
      secondary: bucket.secondary == null ? null : toNumber(bucket.secondary, 0),
      credits: bucket.credits == null ? null : toNumber(bucket.credits, 0),
      primaryLimit: bucket.primaryLimit == null ? null : toNumber(bucket.primaryLimit, 0),
      secondaryLimit: bucket.secondaryLimit == null ? null : toNumber(bucket.secondaryLimit, 0),
      creditsLimit: bucket.creditsLimit == null ? null : toNumber(bucket.creditsLimit, 0),
      unit: String(bucket.unit || "min").trim() || "min",
    };
  }

  return PROVIDER_ORDER.reduce((acc, provider) => {
    const configured = configuredProviders[provider] === true || Boolean(normalized[provider]);
    const bucket = normalized[provider] || null;
    if (!configured || !bucket) {
      acc[provider] = {
        provider,
        configured,
        tone: "dim",
        label: `${provider} n/a`,
      };
      return acc;
    }

    acc[provider] = {
      provider,
      configured,
      tone: resolveProviderTone(bucket),
      label: `${provider} primary ${formatRateValue(bucket.primary, bucket.unit)} | secondary ${formatRateValue(bucket.secondary, bucket.unit)} | credits ${bucket.credits == null ? "n/a" : toNumber(bucket.credits, 0)}`,
    };
    return acc;
  }, {});
}

export function buildStatusHeaderModel({
  stats = {},
  configuredProviders = {},
  connectionState = "offline",
  projectLabel = "No project",
  refreshCountdownSec = 0,
  connectionSource = "",
  connectionEndpoint = "",
  authMode = "",
} = {}) {
  const activeAgents = Math.max(0, toNumber(stats?.activeAgents, 0));
  const maxAgents = Math.max(0, toNumber(stats?.maxAgents, 0));
  const throughputTps = Math.max(0, toNumber(stats?.throughputTps, 0));
  const uptimeMs = Math.max(0, toNumber(stats?.uptimeMs, 0));
  const tokensIn = Math.max(0, toNumber(stats?.tokensIn, 0));
  const tokensOut = Math.max(0, toNumber(stats?.tokensOut, 0));
  const tokensTotal = Math.max(0, toNumber(stats?.tokensTotal ?? stats?.totalTokens, tokensIn + tokensOut));
  const providers = normalizeHeaderRateLimits(stats?.rateLimits || {}, configuredProviders);
  const connection = CONNECTION_STATES[connectionState] || CONNECTION_STATES.offline;
  const sessionHealth = stats?.sessionHealth && typeof stats.sessionHealth === "object"
    ? stats.sessionHealth
    : {};
  const context = stats?.context && typeof stats.context === "object" ? stats.context : {};
  const rateLimitSummary =
    stats?.rateLimitSummary && typeof stats.rateLimitSummary === "object"
      ? stats.rateLimitSummary
      : {};

  return {
    row1: `Agents: ${padMetric(activeAgents, 2)}/${padMetric(maxAgents, 2)} | Throughput: ${throughputTps} tps | Runtime: ${formatDuration(uptimeMs)} | Tokens: in ${formatCompactMetric(tokensIn)} | out ${formatCompactMetric(tokensOut)} | total ${formatCompactMetric(tokensTotal)}`,
    row2: PROVIDER_ORDER.map((provider) => providers[provider]),
    row3: {
      healthLabel: `Live ${padMetric(sessionHealth.live || stats?.activeSessionCount || 0, 2)} | blocked ${padMetric(sessionHealth.blocked || 0, 2)} | stalled ${padMetric(sessionHealth.stalled || 0, 2)} | near limit ${padMetric(context.sessionsNearContextLimit || 0, 2)} | rate alerts ${padMetric(rateLimitSummary.providersNearExhaustion || 0, 2)}`,
      connection,
      projectLabel: String(projectLabel || "").trim() || "No project",
      refreshLabel: `Next refresh: ${Math.max(0, Math.trunc(toNumber(refreshCountdownSec, 0)))}s`,
    },
    row4: {
      attachLabel: truncateAttachLabel(connectionSource, connectionEndpoint),
      authLabel: authMode === "api-key" ? "Auth: API key" : "Auth: local token",
    },
  };
}

function truncateAttachLabel(connectionSource, connectionEndpoint) {
  const source = String(connectionSource || "").trim();
  const endpoint = String(connectionEndpoint || "").trim();
  if (!source && !endpoint) return "Attach: auto";
  if (!endpoint) return `Attach: ${source || "auto"}`;
  if (!source) return `Attach: ${endpoint}`;
  return `Attach: ${source} -> ${endpoint}`;
}

export default function StatusHeader({
  stats,
  connected,
  connectionState,
  projectLabel,
  configuredProviders,
  refreshCountdownSec,
  connectionSource,
  connectionEndpoint,
  authMode,
}) {
  const resolvedConnectionState = connectionState || (connected ? "connected" : "offline");
  const model = buildStatusHeaderModel({
    stats,
    configuredProviders,
    connectionState: resolvedConnectionState,
    projectLabel,
    refreshCountdownSec,
    connectionSource,
    connectionEndpoint,
    authMode,
  });
  const connectionDot = resolvedConnectionState === "reconnecting" && refreshCountdownSec % 2 === 0
    ? "◌"
    : "●";

  return html`
    <${Box} flexDirection="column" paddingX=${1} paddingTop=${1}>
      <${Box}>
        <${Text}>${model.row1}<//>
      <//>
      <${Box} marginTop=${1}>
        ${model.row2.map((provider, index) => html`
          <${React.Fragment} key=${provider.provider}>
            <${Text}
              color=${TONE_COLORS[provider.tone]}
              dimColor=${provider.tone === "dim"}
            >
              ${provider.label}
            <//>
            ${index < model.row2.length - 1 ? html`<${Text} dimColor> | <//>` : null}
          <//>
        `)}
      <//>
      <${Box} marginTop=${1}>
        <${Text}>${model.row3.healthLabel}<//>
      <//>
      <${Box} marginTop=${1}>
        <${Text} color=${model.row3.connection.color}>${connectionDot}<//>
        <${Text}> ${model.row3.connection.label}<//>
        <${Text} dimColor> | Project: <//>
        <${Text}>${model.row3.projectLabel}<//>
        <${Text} dimColor> | <//>
        <${Text}>${model.row3.refreshLabel}<//>
      <//>
      <${Box} marginTop=${1}>
        <${Text} dimColor>${model.row4.attachLabel}<//>
        <${Text} dimColor> | <//>
        <${Text} dimColor>${model.row4.authLabel}<//>
      <//>
    <//>
  `;
}
