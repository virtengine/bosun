/* ─────────────────────────────────────────────────────────────
 *  Agent display helpers
 *  - Normalizes SDK/executor metadata to icons + labels
 * ───────────────────────────────────────────────────────────── */
import { resolveIcon } from "./icon-utils.js";

const AGENT_SDKS = [
  {
    key: "codex",
    label: "Codex",
    icon: "zap",
    aliases: ["codex", "openai", "gpt", "o3", "o4"],
  },
  {
    key: "copilot",
    label: "Copilot",
    icon: "bot",
    aliases: ["copilot", "github"],
  },
  {
    key: "claude",
    label: "Claude",
    icon: "cpu",
    aliases: ["claude", "anthropic"],
  },
];

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function resolveSdkKey(raw) {
  const normalized = normalize(raw);
  if (!normalized) return null;
  for (const sdk of AGENT_SDKS) {
    if (sdk.aliases.some((alias) => normalized.includes(alias))) {
      return sdk.key;
    }
  }
  return null;
}

function findSdk(task = {}) {
  const execution = task?.meta?.execution || task?.execution || {};
  const candidates = [
    execution.sdk,
    execution.executor,
    task.sdk,
    task.executor,
    task.meta?.sdk,
    task.meta?.executor,
    task.assignee,
    task.agent,
    task.agentId,
    task.agentName,
  ];
  for (const candidate of candidates) {
    const key = resolveSdkKey(candidate);
    if (key) return key;
  }
  return null;
}

export function getAgentDisplay(task = {}) {
  const sdkKey = findSdk(task);
  const sdk = sdkKey ? AGENT_SDKS.find((entry) => entry.key === sdkKey) : null;
  if (sdk) {
    return {
      key: sdk.key,
      label: sdk.label,
      icon: resolveIcon(sdk.icon) || sdk.icon,
    };
  }
  return {
    key: "agent",
    label: "Agent",
    icon: resolveIcon("bot") || "Agent",
  };
}
