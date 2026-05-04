import { describe, expect, it } from "vitest";

import { buildAgentConfigurationGuide } from "../lib/agent-configuration-guide.mjs";

describe("agent configuration guide", () => {
  it("formats executor pool objects without object-object leakage", () => {
    const guide = buildAgentConfigurationGuide({
      BOSUN_AGENT_RUNTIME: "harness",
      PRIMARY_AGENT: "codex-sdk",
      INTERNAL_EXECUTOR_SDK: "auto",
      INTERNAL_EXECUTOR_PARALLEL: "4",
      EXECUTORS: [
        { executor: "codex", variant: "default", weight: 70, model: "gpt-5.4" },
        { executor: "codex", variant: "fallback", weight: 30, model: "gpt-5.1-codex-mini" },
      ],
      BOSUN_PROVIDER_DEFAULT: "openai-responses",
      BOSUN_PROVIDER_ROUTING_MODE: "spread",
    }, {
      defaultProviderId: "openai-responses",
      items: [
        {
          providerId: "openai-responses",
          label: "OpenAI Responses",
          enabled: true,
          auth: { authenticated: true, canRun: true },
        },
      ],
    });

    expect(guide.agentRuntime).toBe("harness");
    expect(guide.runtimeArchitecture.currentLabel).toBe("Harness");
    expect(guide.providerFabric.title).toBe("Harness Executor Fabric");
    expect(guide.providerFabric.currentLabel).toContain("OpenAI Responses");
    expect(guide.providerFabric.currentLabel).toContain("Spread");
    expect(guide.providerFabric.items[0].statusLabel).toBe("connected");
    expect(guide.sdkCompatibility.note).toContain("2 pool entries across 1 runtime");
    expect(guide.sdkCompatibility.note).toContain("Codex");
    expect(guide.sdkCompatibility.note).not.toContain("[object Object]");
    expect(guide.queuedExecution.currentLabel).toContain("4 slots");
  });
});
