import { describe, expect, it } from "vitest";
import {
  applyNonBlockingSetupEnvDefaults,
  applyTelegramMiniAppSetupEnv,
  buildModelsProbeRequest,
  handleTelegramChatIdLookup,
  normalizeRepoConfigEntry,
  normalizeTelegramUiPort,
  normalizeWorkflowTemplateOverrides,
  normalizeWorkspaceConfigList,
  resolveSetupWorkspaceAndRepoConfig,
} from "../server/setup-web-server.mjs";

describe("setup web server telegram defaults", () => {
  it("normalizes repo URLs with repeated slashes", () => {
    expect(
      normalizeRepoConfigEntry({
        url: "https://github.com///virtengine///bosun///.git",
      }),
    ).toMatchObject({
      name: "bosun",
      slug: "virtengine/bosun",
      url: "https://github.com///virtengine///bosun///.git",
    });
  });

  it("normalizes UI port values with a safe fallback", () => {
    expect(normalizeTelegramUiPort("4400")).toBe("4400");
    expect(normalizeTelegramUiPort("0")).toBe("3080");
    expect(normalizeTelegramUiPort("bad-port")).toBe("3080");
  });

  it("injects Mini App defaults when Telegram token is provided", () => {
    const envMap = {};
    const applied = applyTelegramMiniAppSetupEnv(
      envMap,
      {
        telegramToken: "123456:abc-token",
      },
      {},
    );

    expect(applied).toBe(true);
    expect(envMap.TELEGRAM_BOT_TOKEN).toBe("123456:abc-token");
    expect(envMap.TELEGRAM_MINIAPP_ENABLED).toBe("true");
    expect(envMap.TELEGRAM_UI_PORT).toBe("3080");
    // No named-tunnel credentials → default is "quick" (safe out-of-the-box)
    expect(envMap.TELEGRAM_UI_TUNNEL).toBe("quick");
    expect(envMap.TELEGRAM_UI_ALLOW_QUICK_TUNNEL_FALLBACK).toBe("true");
    expect(envMap.TELEGRAM_UI_FALLBACK_AUTH_ENABLED).toBe("true");
    expect(envMap.CLOUDFLARE_USERNAME_HOSTNAME_POLICY).toBe("per-user-fixed");
    expect(envMap.TELEGRAM_UI_ALLOW_UNSAFE).toBe("false");
  });

  it("respects explicit Mini App settings from setup input", () => {
    const envMap = {};
    applyTelegramMiniAppSetupEnv(
      envMap,
      {
        telegramToken: "123456:abc-token",
        telegramMiniappEnabled: false,
        telegramUiPort: 4522,
        telegramUiTunnel: "cloudflared",
        telegramUiAllowUnsafe: true,
      },
      {},
    );

    expect(envMap.TELEGRAM_MINIAPP_ENABLED).toBe("false");
    expect(envMap.TELEGRAM_UI_PORT).toBe("4522");
    expect(envMap.TELEGRAM_UI_TUNNEL).toBe("cloudflared");
    expect(envMap.TELEGRAM_UI_ALLOW_UNSAFE).toBe("true");
  });

  it("does not mutate env map when Telegram is not configured", () => {
    const envMap = {};
    const applied = applyTelegramMiniAppSetupEnv(envMap, {}, {});

    expect(applied).toBe(false);
    expect(envMap).toEqual({});
  });

  it("defaults to named tunnel when CLOUDFLARE_TUNNEL_NAME + CREDENTIALS are present in sourceEnv", () => {
    const envMap = {};
    applyTelegramMiniAppSetupEnv(
      envMap,
      { telegramToken: "123456:abc-token" },
      {
        CLOUDFLARE_TUNNEL_NAME: "my-tunnel",
        CLOUDFLARE_TUNNEL_CREDENTIALS: "/home/user/.cloudflared/abc.json",
      },
    );

    expect(envMap.TELEGRAM_UI_TUNNEL).toBe("named");
  });

  it("defaults to named tunnel when CLOUDFLARE credentials are in the env input", () => {
    const envMap = {};
    applyTelegramMiniAppSetupEnv(
      envMap,
      {
        telegramToken: "123456:abc-token",
        CLOUDFLARE_TUNNEL_NAME: "prod-tunnel",
        CLOUDFLARE_TUNNEL_CREDENTIALS: "~/.cloudflared/prod.json",
      },
      {},
    );

    expect(envMap.TELEGRAM_UI_TUNNEL).toBe("named");
  });

  it("discovers and deduplicates Telegram chats from updates", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        result: [
          { message: { chat: { id: 123, type: "private", username: "alice" } } },
          { channel_post: { chat: { id: -1001, type: "supergroup", title: "Ops" } } },
          { edited_message: { chat: { id: 123, type: "private", username: "alice" } } },
        ],
      }),
    });

    try {
      const result = await handleTelegramChatIdLookup({ token: "123456:abc-token" });
      expect(result).toMatchObject({ ok: true, status: 200, message: null });
      expect(result.chats).toEqual([
        { id: 123, type: "private", title: "", username: "alice" },
        { id: -1001, type: "supergroup", title: "Ops", username: "" },
      ]);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("returns instructional message when Telegram updates are empty", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ result: [] }),
    });

    try {
      const result = await handleTelegramChatIdLookup({ token: "123456:abc-token" });
      expect(result).toMatchObject({ ok: true, status: 200, chats: [] });
      expect(result.message).toContain("Send a message to the bot first");
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe("setup web server non-blocking env defaults", () => {
  it("builds Azure model probes with the Azure models path and api-key header", () => {
    const result = buildModelsProbeRequest({
      apiKey: "azure-secret",
      baseUrl: "https://example-resource.openai.azure.com/",
    });

    expect(result).toEqual({
      endpoint: "https://example-resource.openai.azure.com/openai/models?api-version=2024-10-21",
      headers: {
        "Content-Type": "application/json",
        "api-key": "azure-secret",
      },
    });
  });

  it("normalizes direct Azure models endpoints to the stable api-version", () => {
    const result = buildModelsProbeRequest({
      apiKey: "azure-secret",
      baseUrl: "https://example-resource.openai.azure.com/openai/models?api-version=2025-01-01-preview",
    });

    expect(result).toEqual({
      endpoint: "https://example-resource.openai.azure.com/openai/models?api-version=2024-10-21",
      headers: {
        "Content-Type": "application/json",
        "api-key": "azure-secret",
      },
    });
  });

  it("adds the required api-version when Azure models endpoint is pasted directly", () => {
    const result = buildModelsProbeRequest({
      apiKey: "azure-secret",
      baseUrl: "https://example-resource.openai.azure.com/openai/models",
    });

    expect(result).toEqual({
      endpoint: "https://example-resource.openai.azure.com/openai/models?api-version=2024-10-21",
      headers: {
        "Content-Type": "application/json",
        "api-key": "azure-secret",
      },
    });
  });
  it("preserves Azure v1 model routes without forcing the legacy api-version query", () => {
    const result = buildModelsProbeRequest({
      apiKey: "azure-secret",
      baseUrl: "https://example-resource.openai.azure.com/openai/v1/chat/completions?api-version=2024-10-21",
    });

    expect(result).toEqual({
      endpoint: "https://example-resource.openai.azure.com/openai/v1/models",
      headers: {
        "Content-Type": "application/json",
        "api-key": "azure-secret",
      },
    });
  });

  it("normalizes Azure deployment endpoints to a stable models probe api-version", () => {
    const result = buildModelsProbeRequest({
      apiKey: "azure-secret",
      baseUrl: "https://example-resource.openai.azure.com/openai/deployments/gpt-4.1/chat/completions?api-version=2025-01-01-preview",
    });

    expect(result).toEqual({
      endpoint: "https://example-resource.openai.azure.com/openai/models?api-version=2024-10-21",
      headers: {
        "Content-Type": "application/json",
        "api-key": "azure-secret",
      },
    });
  });

  it("normalizes OpenAI-compatible v1 paths when building model probes", () => {
    const result = buildModelsProbeRequest({
      apiKey: "compat-secret",
      baseUrl: "https://gateway.example.com/proxy/v1/chat/completions?foo=bar",
    });

    expect(result).toEqual({
      endpoint: "https://gateway.example.com/proxy/v1/models",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer compat-secret",
      },
    });
  });

  it("backfills safe defaults when setup payload omits values", () => {
    const envMap = {};
    applyNonBlockingSetupEnvDefaults(envMap, {}, {});

    expect(envMap).toMatchObject({
      MAX_PARALLEL: "4",
      KANBAN_BACKEND: "internal",
      KANBAN_SYNC_POLICY: "internal-primary",
      BOSUN_AGENT_RUNTIME: "harness",
      EXECUTOR_MODE: "internal",
      EXECUTOR_DISTRIBUTION: "primary-only",
      FAILOVER_STRATEGY: "next-in-line",
      FAILOVER_MAX_RETRIES: "3",
      FAILOVER_COOLDOWN_MIN: "5",
      FAILOVER_DISABLE_AFTER: "3",
      PROJECT_REQUIREMENTS_PROFILE: "feature",
      INTERNAL_EXECUTOR_REPLENISH_ENABLED: "false",
      INTERNAL_EXECUTOR_REPLENISH_MIN_NEW_TASKS: "1",
      INTERNAL_EXECUTOR_REPLENISH_MAX_NEW_TASKS: "2",
      WORKFLOW_AUTOMATION_ENABLED: "true",
      WORKFLOW_DEFAULT_PROFILE: "balanced",
      WORKFLOW_DEFAULT_AUTOINSTALL: "true",
      WORKFLOW_DEFAULT_TEMPLATES: "template-pr-merge-strategy,template-review-agent,template-backend-agent,template-error-recovery,template-anomaly-watchdog,template-agent-session-monitor,template-task-finalization-guard,template-task-repair-worktree,template-task-status-transition-manager,template-dependency-audit",
      BOSUN_PR_ASSISTIVE_ACTIONS_INSTALL_ON_SETUP: "false",
      BOSUN_GATES_REPO_VISIBILITY: "unknown",
      BOSUN_GATES_AUTOMATION_PREFERENCE: "runtime-first",
      BOSUN_GATES_ACTIONS_BUDGET: "ask-user",
      BOSUN_GATES_CHECK_MODE: "all",
      BOSUN_REQUIRED_CHECK_PATTERNS: "",
      BOSUN_OPTIONAL_CHECK_PATTERNS: "",
      BOSUN_IGNORE_CHECK_PATTERNS: "",
      BOSUN_GATES_REQUIRE_ANY_REQUIRED_CHECK: "true",
      BOSUN_GATES_TREAT_PENDING_REQUIRED_AS_BLOCKING: "true",
      BOSUN_GATES_TREAT_NEUTRAL_AS_PASS: "false",
      BOSUN_EXECUTION_NETWORK_ACCESS: "default",
      BOSUN_GATES_ENFORCE_BACKLOG: "true",
      BOSUN_GATES_AGENT_TRIGGER_CONTROL: "true",
      WORKFLOW_NODE_MAX_RETRIES: "3",
      WORKFLOW_NODE_TIMEOUT_MS: "600000",
      WORKFLOW_RUN_STUCK_THRESHOLD_MS: "300000",
      WORKFLOW_MAX_PERSISTED_RUNS: "200",
      WORKFLOW_MAX_CONCURRENT_BRANCHES: "8",
      COPILOT_ENABLE_ALL_GITHUB_MCP_TOOLS: "false",
      COPILOT_AGENT_MAX_REQUESTS: "500",
      CODEX_AGENT_MAX_THREADS: "12",
      CODEX_TRANSPORT: "sdk",
      COPILOT_TRANSPORT: "sdk",
      CODEX_SANDBOX: "workspace-write",
      VOICE_ENABLED: "true",
      VOICE_PROVIDER: "auto",
      VOICE_MODEL: "gpt-audio-1.5",
      VOICE_VISION_MODEL: "gpt-4.1-nano",
      VOICE_ID: "alloy",
      VOICE_TURN_DETECTION: "semantic_vad",
      VOICE_FALLBACK_MODE: "browser",
      VOICE_DELEGATE_EXECUTOR: "codex-sdk",
      VOICE_TRANSCRIPTION_ENABLED: "true",
      VOICE_TRANSCRIPTION_MODEL: "gpt-4o-transcribe",
      VOICE_AZURE_TRANSCRIPTION_ENABLED: "false",
      AZURE_OPENAI_REALTIME_DEPLOYMENT: "gpt-audio-1.5",
      CONTAINER_ENABLED: "false",
      CONTAINER_RUNTIME: "auto",
      WHATSAPP_ENABLED: "false",
      TELEGRAM_INTERVAL_MIN: "10",
      ORCHESTRATOR_ARGS: "-MaxParallel 4",
    });
  });

  it("filters workflow template overrides to selected templates and known variables", () => {
    const normalized = normalizeWorkflowTemplateOverrides(
      {
        "template-anomaly-watchdog": {
          stallThresholdMs: "900000",
          notifyOnStall: false,
          nope: "ignored",
        },
        "template-task-planner": {
          taskLimit: "12",
        },
      },
      ["template-anomaly-watchdog"],
    );

    expect(normalized).toEqual({
      "template-anomaly-watchdog": {
        stallThresholdMs: 900000,
      },
    });
  });

  it("normalizes invalid input values to non-blocking bounds and enums", () => {
    const envMap = {};
    applyNonBlockingSetupEnvDefaults(
      envMap,
      {
        maxParallel: -5,
        kanbanBackend: "monday",
        kanbanSyncPolicy: "sync-it",
        executorMode: "remote",
        executorDistribution: "random",
        failoverStrategy: "always-first",
        maxRetries: 999,
        failoverCooldownMinutes: 0,
        failoverDisableOnConsecutive: 999,
        projectRequirementsProfile: "enterprise-only",
        internalReplenishEnabled: "maybe",
        internalReplenishMin: 9,
        internalReplenishMax: 0,
        workflowAutomationEnabled: "maybe",
        workflowProfile: "hyperdrive",
        workflowAutoInstall: "maybe",
        workflowDefaultTemplates: "template-nope-1,template-nope-2",
        assistiveActionsInstallOnSetup: "maybe",
        gatesRepoVisibility: "internet",
        gatesAutomationPreference: "heavier",
        gatesGithubActionsBudget: "infinite",
        gatesCheckMode: "whatever",
        gatesRequiredPatterns: " ci / test ,, codeql ",
        gatesOptionalPatterns: " preview\nbenchmarks ",
        gatesIgnorePatterns: " housekeeping ,, ",
        gatesRequireAnyRequiredCheck: "maybe",
        gatesTreatPendingRequiredAsBlocking: "maybe",
        gatesTreatNeutralAsPass: "maybe",
        gatesNetworkAccess: "   ",
        gatesEnforceBacklog: "maybe",
        gatesAgentTriggerControl: "maybe",
        workflowNodeMaxRetries: -5,
        workflowNodeTimeoutMs: 5,
        workflowRunStuckThresholdMs: 1,
        workflowMaxPersistedRuns: 1,
        workflowMaxConcurrentBranches: 1000,
        copilotEnableAllMcpTools: "maybe",
        copilotAgentMaxRequests: -10,
        codexAgentMaxThreads: 9999,
        codexTransport: "pipe",
        copilotTransport: "grpc",
        codexSandbox: "unsafe",
        voiceEnabled: "maybe",
        voiceProvider: "wat",
        voiceModel: "",
        voiceVisionModel: "   ",
        voiceId: "robot",
        voiceTurnDetection: "magic",
        voiceFallbackMode: "later",
        voiceDelegateExecutor: "sidecar-sdk",
        voiceTranscriptionEnabled: "maybe",
        voiceTranscriptionModel: "   ",
        voiceAzureTranscriptionEnabled: "maybe",
        azureOpenaiRealtimeDeployment: "",
        containerEnabled: "sometimes",
        containerRuntime: "runc",
        whatsappEnabled: "sometimes",
        telegramIntervalMin: 100000,
        orchestratorArgs: "   ",
      },
      {},
    );

    expect(envMap).toMatchObject({
      MAX_PARALLEL: "1",
      KANBAN_BACKEND: "internal",
      KANBAN_SYNC_POLICY: "internal-primary",
      BOSUN_AGENT_RUNTIME: "harness",
      EXECUTOR_MODE: "internal",
      EXECUTOR_DISTRIBUTION: "primary-only",
      FAILOVER_STRATEGY: "next-in-line",
      FAILOVER_MAX_RETRIES: "20",
      FAILOVER_COOLDOWN_MIN: "1",
      FAILOVER_DISABLE_AFTER: "50",
      PROJECT_REQUIREMENTS_PROFILE: "feature",
      INTERNAL_EXECUTOR_REPLENISH_ENABLED: "false",
      INTERNAL_EXECUTOR_REPLENISH_MIN_NEW_TASKS: "2",
      INTERNAL_EXECUTOR_REPLENISH_MAX_NEW_TASKS: "2",
      WORKFLOW_AUTOMATION_ENABLED: "true",
      WORKFLOW_DEFAULT_PROFILE: "balanced",
      WORKFLOW_DEFAULT_AUTOINSTALL: "true",
      WORKFLOW_DEFAULT_TEMPLATES: "template-pr-merge-strategy,template-review-agent,template-backend-agent,template-error-recovery,template-anomaly-watchdog,template-agent-session-monitor,template-task-finalization-guard,template-task-repair-worktree,template-task-status-transition-manager,template-dependency-audit",
      BOSUN_PR_ASSISTIVE_ACTIONS_INSTALL_ON_SETUP: "false",
      BOSUN_GATES_REPO_VISIBILITY: "unknown",
      BOSUN_GATES_AUTOMATION_PREFERENCE: "runtime-first",
      BOSUN_GATES_ACTIONS_BUDGET: "ask-user",
      BOSUN_GATES_CHECK_MODE: "all",
      BOSUN_REQUIRED_CHECK_PATTERNS: "ci / test,codeql",
      BOSUN_OPTIONAL_CHECK_PATTERNS: "preview,benchmarks",
      BOSUN_IGNORE_CHECK_PATTERNS: "housekeeping",
      BOSUN_GATES_REQUIRE_ANY_REQUIRED_CHECK: "true",
      BOSUN_GATES_TREAT_PENDING_REQUIRED_AS_BLOCKING: "true",
      BOSUN_GATES_TREAT_NEUTRAL_AS_PASS: "false",
      BOSUN_EXECUTION_NETWORK_ACCESS: "default",
      BOSUN_GATES_ENFORCE_BACKLOG: "true",
      BOSUN_GATES_AGENT_TRIGGER_CONTROL: "true",
      WORKFLOW_NODE_MAX_RETRIES: "0",
      WORKFLOW_NODE_TIMEOUT_MS: "1000",
      WORKFLOW_RUN_STUCK_THRESHOLD_MS: "10000",
      WORKFLOW_MAX_PERSISTED_RUNS: "20",
      WORKFLOW_MAX_CONCURRENT_BRANCHES: "64",
      COPILOT_ENABLE_ALL_GITHUB_MCP_TOOLS: "false",
      COPILOT_AGENT_MAX_REQUESTS: "1",
      CODEX_AGENT_MAX_THREADS: "256",
      CODEX_TRANSPORT: "sdk",
      COPILOT_TRANSPORT: "sdk",
      CODEX_SANDBOX: "workspace-write",
      VOICE_ENABLED: "true",
      VOICE_PROVIDER: "auto",
      VOICE_MODEL: "gpt-audio-1.5",
      VOICE_VISION_MODEL: "gpt-4.1-nano",
      VOICE_ID: "alloy",
      VOICE_TURN_DETECTION: "semantic_vad",
      VOICE_FALLBACK_MODE: "browser",
      VOICE_DELEGATE_EXECUTOR: "codex-sdk",
      VOICE_TRANSCRIPTION_ENABLED: "true",
      VOICE_TRANSCRIPTION_MODEL: "gpt-4o-transcribe",
      VOICE_AZURE_TRANSCRIPTION_ENABLED: "false",
      AZURE_OPENAI_REALTIME_DEPLOYMENT: "gpt-audio-1.5",
      CONTAINER_ENABLED: "false",
      CONTAINER_RUNTIME: "auto",
      WHATSAPP_ENABLED: "false",
      TELEGRAM_INTERVAL_MIN: "1440",
      ORCHESTRATOR_ARGS: "-MaxParallel 1",
    });
  });

  it("preserves valid explicit setup values", () => {
    const envMap = {};
    applyNonBlockingSetupEnvDefaults(
      envMap,
      {
        maxParallel: 8,
        agentRuntime: "sdk-cli",
        kanbanBackend: "github",
        kanbanSyncPolicy: "bidirectional",
        executorMode: "hybrid",
        executorDistribution: "round-robin",
        failoverStrategy: "weighted-random",
        maxRetries: 0,
        failoverCooldownMinutes: 12,
        failoverDisableOnConsecutive: 9,
        projectRequirementsProfile: "system",
        internalReplenishEnabled: true,
        internalReplenishMin: 2,
        internalReplenishMax: 3,
        workflowAutomationEnabled: false,
        workflowProfile: "autonomous",
        workflowAutoInstall: false,
        workflowDefaultTemplates: [
          "template-task-planner",
          "template-task-repair-worktree",
          "template-nope",
        ],
        workflowNodeMaxRetries: 7,
        workflowNodeTimeoutMs: 1200000,
        workflowRunStuckThresholdMs: 450000,
        workflowMaxPersistedRuns: 1200,
        workflowMaxConcurrentBranches: 12,
        copilotEnableAllMcpTools: true,
        copilotAgentMaxRequests: 1200,
        codexAgentMaxThreads: 33,
        codexTransport: "cli",
        copilotTransport: "url",
        codexSandbox: "danger-full-access",
        voiceEnabled: true,
        voiceProvider: "azure",
        voiceModel: "gpt-4o-realtime-preview-2024-12-17",
        voiceVisionModel: "gpt-4.1-mini",
        voiceId: "shimmer",
        voiceTurnDetection: "semantic_vad",
        voiceFallbackMode: "disabled",
        voiceDelegateExecutor: "copilot-sdk",
        voiceTranscriptionEnabled: false,
        voiceTranscriptionModel: "whisper-1",
        voiceAzureTranscriptionEnabled: true,
        openaiRealtimeApiKey: "openai-realtime-key",
        azureOpenaiRealtimeEndpoint: "https://voice.azure.openai.com",
        azureOpenaiRealtimeApiKey: "azure-realtime-key",
        azureOpenaiRealtimeDeployment: "gpt-4o-realtime-preview",
        containerEnabled: true,
        containerRuntime: "podman",
        whatsappEnabled: true,
        telegramIntervalMin: 42,
        orchestratorArgs: "-CustomFlag true",
      },
      {},
    );

    expect(envMap).toMatchObject({
      MAX_PARALLEL: "8",
      BOSUN_AGENT_RUNTIME: "sdk-cli",
      KANBAN_BACKEND: "github",
      KANBAN_SYNC_POLICY: "bidirectional",
      EXECUTOR_MODE: "internal",
      EXECUTOR_DISTRIBUTION: "round-robin",
      FAILOVER_STRATEGY: "weighted-random",
      FAILOVER_MAX_RETRIES: "0",
      FAILOVER_COOLDOWN_MIN: "12",
      FAILOVER_DISABLE_AFTER: "9",
      PROJECT_REQUIREMENTS_PROFILE: "system",
      INTERNAL_EXECUTOR_REPLENISH_ENABLED: "true",
      INTERNAL_EXECUTOR_REPLENISH_MIN_NEW_TASKS: "2",
      INTERNAL_EXECUTOR_REPLENISH_MAX_NEW_TASKS: "3",
      WORKFLOW_AUTOMATION_ENABLED: "false",
      WORKFLOW_DEFAULT_PROFILE: "autonomous",
      WORKFLOW_DEFAULT_AUTOINSTALL: "false",
      WORKFLOW_DEFAULT_TEMPLATES: "template-task-planner,template-task-repair-worktree",
      WORKFLOW_NODE_MAX_RETRIES: "7",
      WORKFLOW_NODE_TIMEOUT_MS: "1200000",
      WORKFLOW_RUN_STUCK_THRESHOLD_MS: "450000",
      WORKFLOW_MAX_PERSISTED_RUNS: "1200",
      WORKFLOW_MAX_CONCURRENT_BRANCHES: "12",
      COPILOT_ENABLE_ALL_GITHUB_MCP_TOOLS: "true",
      COPILOT_AGENT_MAX_REQUESTS: "1200",
      CODEX_AGENT_MAX_THREADS: "33",
      CODEX_TRANSPORT: "cli",
      COPILOT_TRANSPORT: "url",
      CODEX_SANDBOX: "danger-full-access",
      VOICE_ENABLED: "true",
      VOICE_PROVIDER: "azure",
      VOICE_MODEL: "gpt-4o-realtime-preview-2024-12-17",
      VOICE_VISION_MODEL: "gpt-4.1-mini",
      VOICE_ID: "shimmer",
      VOICE_TURN_DETECTION: "semantic_vad",
      VOICE_FALLBACK_MODE: "disabled",
      VOICE_DELEGATE_EXECUTOR: "copilot-sdk",
      VOICE_TRANSCRIPTION_ENABLED: "false",
      VOICE_TRANSCRIPTION_MODEL: "whisper-1",
      VOICE_AZURE_TRANSCRIPTION_ENABLED: "true",
      OPENAI_REALTIME_API_KEY: "openai-realtime-key",
      AZURE_OPENAI_REALTIME_ENDPOINT: "https://voice.azure.openai.com",
      AZURE_OPENAI_REALTIME_API_KEY: "azure-realtime-key",
      AZURE_OPENAI_REALTIME_DEPLOYMENT: "gpt-4o-realtime-preview",
      CONTAINER_ENABLED: "true",
      CONTAINER_RUNTIME: "podman",
      WHATSAPP_ENABLED: "true",
      TELEGRAM_INTERVAL_MIN: "42",
      ORCHESTRATOR_ARGS: "-CustomFlag true",
    });
  });

  it("preserves explicit gates and assistive action setup values", () => {
    const envMap = {};
    applyNonBlockingSetupEnvDefaults(
      envMap,
      {
        assistiveActionsInstallOnSetup: true,
        gatesRepoVisibility: "public",
        gatesAutomationPreference: "actions-first",
        gatesGithubActionsBudget: "available",
        gatesCheckMode: "required-only",
        gatesRequiredPatterns: "ci / test\ncodeql",
        gatesOptionalPatterns: "preview,benchmarks",
        gatesIgnorePatterns: "housekeeping",
        gatesRequireAnyRequiredCheck: false,
        gatesTreatPendingRequiredAsBlocking: false,
        gatesTreatNeutralAsPass: true,
        gatesNetworkAccess: "restricted",
        gatesEnforceBacklog: false,
        gatesAgentTriggerControl: false,
      },
      {},
    );

    expect(envMap).toMatchObject({
      BOSUN_PR_ASSISTIVE_ACTIONS_INSTALL_ON_SETUP: "true",
      BOSUN_GATES_REPO_VISIBILITY: "public",
      BOSUN_GATES_AUTOMATION_PREFERENCE: "actions-first",
      BOSUN_GATES_ACTIONS_BUDGET: "available",
      BOSUN_GATES_CHECK_MODE: "required-only",
      BOSUN_REQUIRED_CHECK_PATTERNS: "ci / test,codeql",
      BOSUN_OPTIONAL_CHECK_PATTERNS: "preview,benchmarks",
      BOSUN_IGNORE_CHECK_PATTERNS: "housekeeping",
      BOSUN_GATES_REQUIRE_ANY_REQUIRED_CHECK: "false",
      BOSUN_GATES_TREAT_PENDING_REQUIRED_AS_BLOCKING: "false",
      BOSUN_GATES_TREAT_NEUTRAL_AS_PASS: "true",
      BOSUN_EXECUTION_NETWORK_ACCESS: "restricted",
      BOSUN_GATES_ENFORCE_BACKLOG: "false",
      BOSUN_GATES_AGENT_TRIGGER_CONTROL: "false",
    });
  });

  it("auto-enables harness providers from existing Codex and Copilot auth during setup", () => {
    const envMap = {};
    applyNonBlockingSetupEnvDefaults(
      envMap,
      {},
      {
        OPENAI_ACCESS_TOKEN: "header.payload.signature",
        GH_TOKEN: "gho_test_token",
      },
    );

    expect(envMap).toMatchObject({
      BOSUN_PROVIDER_OPENAI_CODEX_SUBSCRIPTION_ENABLED: "true",
      BOSUN_PROVIDER_OPENAI_CODEX_SUBSCRIPTION_MODE: "oauth",
      BOSUN_PROVIDER_COPILOT_OAUTH_ENABLED: "true",
      BOSUN_PROVIDER_DEFAULT: "openai-codex-subscription",
      BOSUN_PROVIDER_ROUTING_MODE: "default-only",
    });
  });

  it("maps live compaction controls into env defaults and bounds", () => {
    const envMap = {};
    applyNonBlockingSetupEnvDefaults(
      envMap,
      {
        contextShreddingLiveToolCompactionEnabled: true,
        contextShreddingLiveToolCompactionMode: "aggressive",
        contextShreddingLiveToolCompactionMinChars: 6400,
        contextShreddingLiveToolCompactionTargetChars: 2400,
        contextShreddingLiveToolCompactionMinSavingsPct: 22,
        contextShreddingLiveToolCompactionMinRuntimeMs: 4500,
        contextShreddingLiveToolCompactionBlockStructuredOutput: false,
        contextShreddingLiveToolCompactionAllowCommands: "git,rg,journalctl",
      },
      {},
    );

    expect(envMap).toMatchObject({
      CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_ENABLED: "true",
      CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MODE: "aggressive",
      CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_CHARS: "6400",
      CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_TARGET_CHARS: "2400",
      CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_SAVINGS_PCT: "22",
      CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_RUNTIME_MS: "4500",
      CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_BLOCK_STRUCTURED_OUTPUT: "false",
      CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_ALLOW_COMMANDS: "git,rg,journalctl",
    });
  });
});

describe("setup web server workspace normalization", () => {
  it("normalizes slug-only repo input to include repo name and URL", () => {
    expect(normalizeRepoConfigEntry("virtengine/bosun")).toMatchObject({
      name: "bosun",
      slug: "virtengine/bosun",
      url: "https://github.com/virtengine/bosun.git",
      primary: true,
    });
  });

  it("normalizes setup workspaces and derives activeRepo from repo names", () => {
    const normalized = normalizeWorkspaceConfigList([
      {
        id: "VirtEngine Main",
        name: "VirtEngine Main",
        repos: [
          { slug: "virtengine/bosun" },
          "virtengine/virtengine",
        ],
      },
    ]);

    expect(normalized).toHaveLength(1);
    expect(normalized[0].id).toBe("virtengine-main");
    expect(normalized[0].repos).toHaveLength(2);
    expect(normalized[0].repos[0].name).toBe("bosun");
    expect(normalized[0].repos[1].name).toBe("virtengine");
    expect(normalized[0].activeRepo).toBe("bosun");
  });

  it("preserves existing workspaces when setup payload omits workspaces", () => {
    const existingConfig = {
      projectName: "virtengine",
      activeWorkspace: "virtengine",
      workspaces: [
        {
          id: "virtengine",
          name: "VirtEngine",
          repos: [{ slug: "virtengine/bosun" }],
          activeRepo: "bosun",
        },
      ],
    };

    const merged = resolveSetupWorkspaceAndRepoConfig(existingConfig, {
      projectName: "virtengine",
      repos: [],
    });

    expect(merged.workspaces).toHaveLength(1);
    expect(merged.workspaces[0].id).toBe("virtengine");
    expect(merged.activeWorkspace).toBe("virtengine");
    expect(merged.workspaces[0].repos[0].name).toBe("bosun");
  });

  it("creates a default workspace when repos exist but workspaces are missing", () => {
    const merged = resolveSetupWorkspaceAndRepoConfig(
      {},
      {
        projectName: "my-project",
        repos: [{ slug: "virtengine/bosun" }],
      },
      { projectName: "my-project" },
    );

    expect(merged.workspaces).toHaveLength(1);
    expect(merged.workspaces[0].id).toBe("my-project");
    expect(merged.workspaces[0].repos[0].name).toBe("bosun");
    expect(merged.activeWorkspace).toBe("my-project");
  });
});
