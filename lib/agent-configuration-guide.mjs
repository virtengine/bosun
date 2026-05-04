function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function isEnabledFlag(value, fallback = true) {
  const normalized = toTrimmedString(value).toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function titleCaseWords(value) {
  return toTrimmedString(value)
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatRuntimeLabel(value) {
  const normalized = toTrimmedString(value);
  if (!normalized) return "";
  if (normalized === "harness") return "Harness";
  if (normalized === "sdk-cli") return "SDK/CLI";
  if (normalized === "default-only") return "Default only";
  if (normalized === "fallback") return "Fallback";
  if (normalized === "spread") return "Spread";
  const shellVariant = SHELL_RUNTIME_VARIANTS.find((entry) => entry.id === normalized);
  if (shellVariant) return shellVariant.label;
  const taskVariant = INTERNAL_TASK_SDK_VARIANTS.find((entry) => entry.id === normalized);
  if (taskVariant) return taskVariant.label;
  if (normalized === "primary-only") return "Primary only";
  if (normalized === "round-robin") return "Round robin";
  if (normalized === "weighted") return "Weighted";
  return titleCaseWords(normalized);
}

export const SHELL_RUNTIME_VARIANTS = Object.freeze([
  { id: "codex-sdk", label: "Codex", family: "openai", runtime: "shell + sdk" },
  { id: "claude-sdk", label: "Claude", family: "anthropic", runtime: "shell + sdk" },
  { id: "copilot-sdk", label: "Copilot", family: "copilot", runtime: "shell + sdk" },
  { id: "opencode-sdk", label: "OpenCode", family: "openai-compatible", runtime: "shell + sdk" },
  { id: "gemini-sdk", label: "Gemini", family: "google", runtime: "shell + sdk" },
]);

export const INTERNAL_TASK_SDK_VARIANTS = Object.freeze([
  { id: "auto", label: "Auto" },
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude" },
  { id: "copilot", label: "Copilot" },
  { id: "opencode", label: "OpenCode" },
  { id: "gemini", label: "Gemini" },
]);

function parseExecutorPool(rawValue) {
  const entries = [];
  const chunks = Array.isArray(rawValue)
    ? rawValue
    : String(rawValue || "").split(",");
  for (const chunk of chunks) {
    if (chunk && typeof chunk === "object" && !Array.isArray(chunk)) {
      const executor = toTrimmedString(chunk.executor || chunk.type || "");
      const variant = toTrimmedString(chunk.variant || chunk.family || "default");
      const weight = Number.parseInt(toTrimmedString(chunk.weight), 10) || 0;
      const model = toTrimmedString(chunk.model || chunk.models || "");
      if (!executor) continue;
      entries.push({
        raw: `${executor}:${variant}:${weight}${model ? `:${model}` : ""}`,
        executor: executor.toUpperCase(),
        variant: variant.toUpperCase(),
        weight,
        model: model || null,
      });
      continue;
    }
    const entry = toTrimmedString(chunk);
    if (!entry) continue;
    const [executor = "", variant = "", weight = "", ...modelParts] = entry.split(":");
    entries.push({
      raw: entry,
      executor: toTrimmedString(executor).toUpperCase(),
      variant: toTrimmedString(variant).toUpperCase(),
      weight: Number.parseInt(toTrimmedString(weight), 10) || 0,
      model: toTrimmedString(modelParts.join(":")) || null,
    });
  }
  return entries;
}

function summarizePool(entries = []) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return "No weighted executor pool configured.";
  }
  const executorNames = entries
    .map((entry) => formatRuntimeLabel(toTrimmedString(entry?.executor).toLowerCase()))
    .filter(Boolean);
  const distinct = [...new Set(executorNames)];
  return `${entries.length} pool entr${entries.length === 1 ? "y" : "ies"} across ${distinct.length} runtime${distinct.length === 1 ? "" : "s"}: ${distinct.join(", ")}.`;
}

function normalizeAgentRuntime(value) {
  return toTrimmedString(value).toLowerCase() === "sdk-cli"
    ? "sdk-cli"
    : "harness";
}

export function buildAgentConfigurationGuide(rawSettings = {}, providerInventory = null, executorFabric = null) {
  const settings = rawSettings && typeof rawSettings === "object" ? rawSettings : {};
  const agentRuntime = normalizeAgentRuntime(settings.BOSUN_AGENT_RUNTIME || "harness");
  const primaryShellId = toTrimmedString(settings.PRIMARY_AGENT || "codex-sdk") || "codex-sdk";
  const internalTaskSdk = toTrimmedString(settings.INTERNAL_EXECUTOR_SDK || "auto") || "auto";
  const queuedSlots = Number.parseInt(toTrimmedString(settings.INTERNAL_EXECUTOR_PARALLEL || "3"), 10) || 3;
  const executorPool = parseExecutorPool(settings.EXECUTORS || "");
  const providerRoutingMode = toTrimmedString(settings.BOSUN_PROVIDER_ROUTING_MODE || "default-only") || "default-only";
  const defaultProviderId = toTrimmedString(
    providerInventory?.defaultProviderId ||
    settings.BOSUN_PROVIDER_DEFAULT ||
    "",
  );
  const providerItems = Array.isArray(providerInventory?.items)
    ? providerInventory.items.map((item) => ({
        providerId: toTrimmedString(item?.providerId),
        label: toTrimmedString(item?.label || item?.providerId),
        enabled: item?.enabled !== false,
        authenticated: item?.auth?.authenticated === true,
        canRun: item?.auth?.canRun === true,
        preferredMode: toTrimmedString(item?.auth?.preferredMode || ""),
        adapterId: toTrimmedString(item?.adapterId || ""),
        statusLabel:
          item?.enabled === false
            ? "disabled"
            : item?.auth?.authenticated === true
              ? "connected"
              : item?.auth?.available === true || item?.auth?.configured === true
                ? "configured"
                : "needs auth",
      }))
    : [];

  const enabledProviders = providerItems.filter((item) => item.enabled !== false);
  const runnableProviders = providerItems.filter((item) => item.enabled !== false && item.canRun === true);
  const harnessExecutors = Array.isArray(executorFabric?.executors)
    ? executorFabric.executors.map((entry) => ({
        id: toTrimmedString(entry?.id),
        label: toTrimmedString(entry?.name || entry?.label || entry?.id),
        providerId: toTrimmedString(entry?.providerId),
        enabled: entry?.enabled !== false,
        available: entry?.available !== false,
        source: toTrimmedString(entry?.source || ""),
        statusLabel:
          entry?.enabled === false
            ? "disabled"
            : entry?.available === false
              ? "unavailable"
              : entry?.source === "derived"
                ? "derived"
                : "ready",
      }))
    : [];
  const enabledHarnessExecutors = harnessExecutors.filter((entry) => entry.enabled !== false);
  const primaryExecutorId = toTrimmedString(executorFabric?.primaryExecutorId || "");
  const primaryExecutorLabel =
    harnessExecutors.find((entry) => entry.id === primaryExecutorId)?.label
    || primaryExecutorId
    || null;
  const currentProviderLabel =
    providerItems.find((item) => item.providerId === defaultProviderId)?.label
    || defaultProviderId
    || null;
  const runtimeArchitecture = {
    title: "Primary Agent Runtime",
    summary: "Pick one primary runtime. Harness uses Bosun's provider kernel, shared tool layer, and observability spine. SDK/CLI keeps legacy shell adapters as the top-level runtime.",
    current: agentRuntime,
    currentLabel: formatRuntimeLabel(agentRuntime),
    settingKeys: ["BOSUN_AGENT_RUNTIME"],
    items: [
      { id: "harness", label: "Harness", selected: agentRuntime === "harness", statusLabel: agentRuntime === "harness" ? "selected" : "" },
      { id: "sdk-cli", label: "SDK/CLI", selected: agentRuntime === "sdk-cli", statusLabel: agentRuntime === "sdk-cli" ? "selected" : "" },
    ],
    note:
      agentRuntime === "harness"
        ? "Harness is the active runtime. SDK/CLI settings stay hidden unless you explicitly switch back to compatibility mode."
        : "SDK/CLI is the active runtime. Harness providers can still be configured, but Bosun will not treat them as the primary runtime until you switch to Harness.",
  };

  const queuedExecution = {
    title: "Queued Task Execution",
    summary: "These settings control Bosun's internal queued task engine: slot count, retry policy, timeout posture, and backlog replenishment.",
    current: internalTaskSdk,
    currentLabel: `${queuedSlots} slot${queuedSlots === 1 ? "" : "s"}${agentRuntime === "sdk-cli" ? ` · ${formatRuntimeLabel(internalTaskSdk)}` : ""}`,
    settingKeys: [
      "INTERNAL_EXECUTOR_PARALLEL",
      "INTERNAL_EXECUTOR_TIMEOUT_MS",
      "INTERNAL_EXECUTOR_MAX_RETRIES",
      "INTERNAL_EXECUTOR_REVIEW_AGENT_ENABLED",
      "INTERNAL_EXECUTOR_REPLENISH_ENABLED",
      "PROJECT_REQUIREMENTS_PROFILE",
    ],
    note:
      agentRuntime === "harness"
        ? "Queued work runs under the Bosun task engine. Legacy SDK family pinning and routing pools stay dormant while Harness is primary."
        : "Queued work still uses the Bosun task engine, but SDK/CLI compatibility settings below determine which legacy runtime family Bosun prefers.",
  };

  const providerFabric = {
    title: "Harness Executor Fabric",
    summary: "Configure named Harness executor instances on top of the provider kernel so chat, tasks, workflows, TUI, web, and Telegram all target the same Bosun-native runtime endpoints.",
    current: primaryExecutorId || defaultProviderId || null,
    currentLabel:
      primaryExecutorLabel
        ? `${primaryExecutorLabel} · ${formatRuntimeLabel(providerRoutingMode)}`
        : currentProviderLabel
          ? `${currentProviderLabel} · ${formatRuntimeLabel(providerRoutingMode)}`
          : formatRuntimeLabel(providerRoutingMode),
    settingKeys: [
      "BOSUN_PROVIDER_DEFAULT",
      "BOSUN_PROVIDER_ROUTING_MODE",
      "BOSUN_HARNESS_ENABLED",
      "BOSUN_HARNESS_SOURCE",
      "BOSUN_HARNESS_VALIDATION_MODE",
    ],
    items: harnessExecutors.length > 0
      ? harnessExecutors.map((item) => ({
          ...item,
          selected: item.id === primaryExecutorId,
        }))
      : providerItems.map((item) => ({
          ...item,
          selected: item.providerId === defaultProviderId,
        })),
    note: harnessExecutors.length > 0
      ? `${enabledHarnessExecutors.length} executor${enabledHarnessExecutors.length === 1 ? "" : "s"} configured. Primary chooses the preferred Bosun Harness runtime instance; routing decides whether the others stay dormant, participate in failover, or join spread dispatch.`
      : providerItems.length > 0
        ? `${enabledProviders.length} enabled, ${runnableProviders.length} currently runnable. Connected means auth exists; primary chooses the preferred provider; routing decides whether other enabled providers are ignored, used for failover, or used for spread.`
      : "Provider inventory unavailable in this surface.",
  };

  const sdkCompatibility = {
    title: "SDK/CLI Compatibility Layer",
    summary: "These settings exist only for the legacy shell and SDK stack: direct session transport, weighted SDK routing, failover, and SDK availability toggles.",
    current: primaryShellId,
    currentLabel: formatRuntimeLabel(primaryShellId),
    settingKeys: [
      "PRIMARY_AGENT",
      "INTERNAL_EXECUTOR_SDK",
      "EXECUTORS",
      "EXECUTOR_DISTRIBUTION",
      "FAILOVER_STRATEGY",
      "CODEX_SDK_DISABLED",
      "COPILOT_SDK_DISABLED",
      "CLAUDE_SDK_DISABLED",
      "GEMINI_SDK_DISABLED",
      "OPENCODE_SDK_DISABLED",
    ],
    items: SHELL_RUNTIME_VARIANTS.map((variant) => ({
      ...variant,
      selected: variant.id === primaryShellId,
      enabled: !isEnabledFlag(settings[`${variant.id.split("-")[0].toUpperCase()}_SDK_DISABLED`], false),
    })),
    note:
      agentRuntime === "sdk-cli"
        ? summarizePool(executorPool)
        : `Hidden while Harness is primary. ${summarizePool(executorPool)}`,
  };

  return {
    agentRuntime,
    runtimeArchitecture,
    queuedExecution,
    providerFabric,
    sdkCompatibility,
    sections: [
      runtimeArchitecture,
      providerFabric,
      queuedExecution,
      sdkCompatibility,
    ],
  };
}
