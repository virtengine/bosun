import React, { useEffect, useMemo, useState } from "react";
import htm from "htm";
import * as ink from "ink";

import { ANSI_COLORS } from "./constants.js";
import { buildRateLimitHours, deriveTelemetrySnapshot, renderSparkline } from "./telemetry-helpers.js";

const Box = ink.Box ?? ink.default?.Box;
const Text = ink.Text ?? ink.default?.Text;

const html = htm.bind(React.createElement);
const REFRESH_MS = 5000;
const HISTORY_SECONDS = 60;
const MAX_HISTORY_SAMPLES = Math.ceil((HISTORY_SECONDS * 1000) / REFRESH_MS);

function trimHistory(history, length = MAX_HISTORY_SAMPLES) {
  return history.length > length ? history.slice(history.length - length) : history;
}

function collectSnapshots(prev, next) {
  return trimHistory([...prev, next]);
}

function formatInt(value) {
  return new Intl.NumberFormat().format(Math.max(0, Number(value || 0)));
}

function formatUsd(value) {
  return `$${Math.max(0, Number(value || 0)).toFixed(4)}`;
}

function formatSeconds(value) {
  const total = Math.max(0, Math.round(Number(value || 0)));
  if (total < 60) return `${total}s`;
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

function Panel({ title, children, width = 36 }) {
  return html`
    <${Box} flexDirection="column" width=${width} marginRight=${2} marginBottom=${1} borderStyle="round" borderColor=${ANSI_COLORS.muted} paddingX=${1}>
      <${Text} bold color=${ANSI_COLORS.accent}>${title}<//>
      ${children}
    <//>
  `;
}

function MetricLine({ label, value, color = undefined }) {
  return html`
    <${Box} justifyContent="space-between">
      <${Text} color=${ANSI_COLORS.muted}>${label}<//>
      <${Text} color=${color}>${value}<//>
    <//>
  `;
}

export default function TelemetryScreen({ wsState, config, terminalSize }) {
  const [history, setHistory] = useState([]);

  const rates = config?.telemetry?.costPer1kTokensUsd || {};
  const statsWithRates = useMemo(
    () => ({ ...(wsState?.stats || {}), costPer1kTokensUsd: rates }),
    [rates, wsState?.stats],
  );

  useEffect(() => {
    const update = () => {
      setHistory((prev) => collectSnapshots(prev, deriveTelemetrySnapshot({
        stats: statsWithRates,
        sessions: wsState?.sessions,
        tasks: wsState?.tasks,
        logs: wsState?.logs,
      })));
    };

    update();
    const timer = setInterval(update, REFRESH_MS);
    return () => clearInterval(timer);
  }, [statsWithRates, wsState?.logs, wsState?.sessions, wsState?.tasks]);

  const latest = history[history.length - 1] || deriveTelemetrySnapshot({
    stats: statsWithRates,
    sessions: wsState?.sessions,
    tasks: wsState?.tasks,
    logs: wsState?.logs,
  });

  const throughputSpark = renderSparkline(history.map((item) => item.throughput));
  const tokenSpark = renderSparkline(history.map((item) => item.tokenTotal));
  const errorSpark = renderSparkline(history.map((item) => item.errors + item.retries));
  const providerRows = [...latest.providerStats].sort((left, right) => right.totalTokens - left.totalTokens);
  const topProvider = providerRows[0]?.provider || null;
  const rateLimitHours = buildRateLimitHours(
    history.flatMap((item) => item.rateLimitEvents),
    new Date(),
    ANSI_COLORS.muted,
    "yellow",
    "red",
  );
  const dailyCostUsd = Math.max(
    0,
    (latest.sessionCostUsd || 0) - (history[0]?.sessionCostUsd || 0),
  );

  const wide = (terminalSize?.columns || 0) >= 140;
  const panelWidth = wide
    ? Math.max(32, Math.floor(((terminalSize?.columns || 120) - 8) / 3))
    : Math.max(48, (terminalSize?.columns || 80) - 4);

  return html`
    <${Box} flexDirection="column">
      <${Text} color=${ANSI_COLORS.muted}>Updates every 5s · costs are estimates<//>
      <${Box} flexDirection=${wide ? "row" : "column"} marginTop=${1}>
        <${Panel} title="Session Throughput" width=${panelWidth}>
          <${MetricLine} label="Spark" value=${throughputSpark || "-"} color=${ANSI_COLORS.connected} />
          <${MetricLine} label="Current TPS" value=${String(latest.throughput.toFixed(2))} />
          <${MetricLine} label="Total Tokens" value=${formatInt(latest.tokenTotal)} />
          <${MetricLine} label="Token Trend" value=${tokenSpark || "-"} color=${ANSI_COLORS.accent} />
          <${MetricLine} label="Session Cost (est.)" value=${formatUsd(latest.sessionCostUsd)} />
          <${MetricLine} label="Day Cost (est.)" value=${formatUsd(dailyCostUsd)} />
        <//>
        <${Panel} title="Provider Usage" width=${panelWidth}>
          <${Text} color=${ANSI_COLORS.muted}>provider  sess  in/out tokens   cost est.   avg len   errors<//>
          ${providerRows.map((row) => html`
            <${Text} key=${row.provider} color=${row.provider === topProvider ? "cyan" : undefined}>
              ${row.provider.padEnd(8, " ")}
              ${String(row.sessions).padStart(4, " ")}
              ${`${formatInt(row.inputTokens)}/${formatInt(row.outputTokens)}`.padStart(15, " ")}
              ${formatUsd(row.estimatedCostUsd).padStart(11, " ")}
              ${formatSeconds(row.avgSessionLengthSeconds).padStart(9, " ")}
              ${String(row.errorCount).padStart(8, " ")}
            <//>
          `)}
          ${providerRows.length === 0 ? html`<${Text} color=${ANSI_COLORS.muted}>No provider data yet.<//>` : null}
        <//>
        <${Panel} title="Errors, Rate Limits, Funnel" width=${panelWidth}>
          <${MetricLine} label="Error/Retry Spark" value=${errorSpark || "-"} color=${ANSI_COLORS.warning} />
          <${MetricLine} label="Errors" value=${formatInt(latest.errors)} />
          <${MetricLine} label="Retries" value=${formatInt(latest.retries)} />
          <${Text} color=${ANSI_COLORS.muted}>429 heatmap (today, hourly)<//>
          <${Box} flexWrap="wrap">
            ${rateLimitHours.map((slot) => html`
              <${Box} key=${String(slot.hour)} width=${3}>
                <${Text} color=${slot.color}>${slot.label}<//>
              <//>
            `)}
          <//>
          <${Text} color=${ANSI_COLORS.muted}>${rateLimitHours.every((slot) => slot.count === 0) ? "no data" : "·· = no data"}<//>
          <${Text}>${latest.funnel.map((item) => `${item.status} → ${item.count} (${item.percent.toFixed(0)}%)`).join("  ")}<//>
        <//>
      <//>
    <//>
  `;
}
