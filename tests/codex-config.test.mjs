import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

let buildRepoCodexConfig;
let ensureRepoConfigs;
let buildCommonMcpBlocks;
let buildSandboxPermissions;
let ensureAgentMaxThreads;
let ensureFeatureFlags;
let ensureModelProviderSectionsFromEnv;
let ensureSandboxWorkspaceWrite;
let ensureTrustedProjects;
let ensureTopLevelSandboxPermissions;
let resolveCodexProfileRuntime;

async function loadFreshCodexConfigModules() {
  vi.resetModules();
  vi.unmock("../config/repo-config.mjs");
  vi.unmock("../shell/codex-config.mjs");
  vi.unmock("../shell/codex-model-profiles.mjs");

  const repoConfigModule = await import("../config/repo-config.mjs");
  const codexConfigModule = await import("../shell/codex-config.mjs");
  const profileModule = await import("../shell/codex-model-profiles.mjs");

  buildRepoCodexConfig = repoConfigModule.buildRepoCodexConfig;
  ensureRepoConfigs = repoConfigModule.ensureRepoConfigs;
  buildCommonMcpBlocks = codexConfigModule.buildCommonMcpBlocks;
  buildSandboxPermissions = codexConfigModule.buildSandboxPermissions;
  ensureAgentMaxThreads = codexConfigModule.ensureAgentMaxThreads;
  ensureFeatureFlags = codexConfigModule.ensureFeatureFlags;
  ensureModelProviderSectionsFromEnv = codexConfigModule.ensureModelProviderSectionsFromEnv;
  ensureSandboxWorkspaceWrite = codexConfigModule.ensureSandboxWorkspaceWrite;
  ensureTrustedProjects = codexConfigModule.ensureTrustedProjects;
  ensureTopLevelSandboxPermissions = codexConfigModule.ensureTopLevelSandboxPermissions;
  resolveCodexProfileRuntime = profileModule.resolveCodexProfileRuntime;
}

describe("codex-config defaults", () => {
  beforeEach(async () => {
    await loadFreshCodexConfigModules();
  });

  it("omits default MCP server blocks unless explicitly enabled", () => {
    const block = buildCommonMcpBlocks();
    expect(block).toBe("");
  });

  it("includes expanded MCP server defaults when explicitly enabled", () => {
    const block = buildCommonMcpBlocks({
      BOSUN_MCP_ALLOW_DEFAULT_SERVERS: "1",
    });
    expect(block).toContain("[mcp_servers.context7]");
    expect(block).toContain("[mcp_servers.sequential-thinking]");
    expect(block).toContain("[mcp_servers.playwright]");
    expect(block).toContain("[mcp_servers.microsoft-docs]");
    expect(block).not.toContain("tools = [");
  });

  it("forces critical features back to true when disabled", () => {
    const input = [
      "[features]",
      "child_agents_md = false",
      "memories = false",
      "multi_agent = false",
      "shell_tool = false",
      "unified_exec = false",
      "undo = false",
      "",
    ].join("\n");

    const { toml } = ensureFeatureFlags(input);

    expect(toml).toContain("child_agents_md = true");
    expect(toml).toContain("memories = true");
    expect(toml).toContain("multi_agent = true");
    expect(toml).toContain("shell_tool = true");
    expect(toml).toContain("unified_exec = true");
    expect(toml).toContain("undo = false");
  });

  it("adds max_threads under [agent_sdk] when section exists but key is missing", () => {
    const input = [
      "[agent_sdk]",
      'primary = "codex"',
      "",
      "[agent_sdk.capabilities]",
      "steering = true",
      "",
      "[features]",
      "child_agents_md = true",
      "",
    ].join("\n");
    const result = ensureAgentMaxThreads(input, { maxThreads: 12 });
    expect(result.changed).toBe(true);
    expect(result.added).toBe(true);
    // max_threads should be under [agent_sdk], NOT [agents]
    const agentSdkIdx = result.toml.indexOf("[agent_sdk]");
    const capsIdx = result.toml.indexOf("[agent_sdk.capabilities]");
    const maxThreadsIdx = result.toml.indexOf("max_threads = 12");
    expect(maxThreadsIdx).toBeGreaterThan(agentSdkIdx);
    expect(maxThreadsIdx).toBeLessThan(capsIdx);
  });

  it("overwrites max_threads under [agent_sdk] when explicitly requested", () => {
    const input = [
      "[agent_sdk]",
      'primary = "codex"',
      "max_threads = 4",
      "",
      "[agent_sdk.capabilities]",
      "steering = true",
      "",
      "[features]",
    ].join("\n");
    const result = ensureAgentMaxThreads(input, {
      maxThreads: 12,
      overwrite: true,
    });
    expect(result.changed).toBe(true);
    expect(result.toml).toContain("max_threads = 12");
    expect(result.toml).not.toContain("max_threads = 4");
  });

  it("does not overwrite max_threads under [agent_sdk] by default", () => {
    const input = [
      "[agent_sdk]",
      'primary = "codex"',
      "max_threads = 4",
      "",
      "[agent_sdk.capabilities]",
      "steering = true",
      "",
    ].join("\n");
    const result = ensureAgentMaxThreads(input, { maxThreads: 12 });
    expect(result.changed).toBe(false);
    expect(result.toml).toContain("max_threads = 4");
  });

  it("migrates stale max_threads from [agents] to [agent_sdk]", () => {
    const input = [
      "[agents]",
      "# Max concurrent agent threads per Codex session.",
      "max_threads = 8",
      "",
      "[agent_sdk]",
      'primary = "codex"',
      "",
      "[agent_sdk.capabilities]",
      "steering = true",
      "",
    ].join("\n");
    const result = ensureAgentMaxThreads(input, { maxThreads: 12 });
    expect(result.changed).toBe(true);
    // Stale max_threads should be removed from [agents]
    const agentsMatch = result.toml.match(/\[agents\][^[]*max_threads/);
    expect(agentsMatch).toBeNull();
    // max_threads should be added under [agent_sdk]
    expect(result.toml).toContain("max_threads = 12");
  });

  it("honors env overrides for feature flags", () => {
    const input = ["[features]", "use_linux_sandbox_bwrap = true", ""].join("\n");
    const { toml } = ensureFeatureFlags(input, {
      CODEX_FEATURES_BWRAP: "false",
    });
    expect(toml).toContain("use_linux_sandbox_bwrap = false");
  });

  it("forces Linux bubblewrap off on Windows runtimes", () => {
    const input = ["[features]", "use_linux_sandbox_bwrap = true", ""].join("\n");
    const { toml } = ensureFeatureFlags(input, {
      OS: "Windows_NT",
      CODEX_FEATURES_BWRAP: "true",
    });
    expect(toml).toContain("use_linux_sandbox_bwrap = false");
  });

  it("disables remote_models for Azure runtimes", () => {
    const input = ["[features]", "remote_models = true", ""].join("\n");
    const { toml } = ensureFeatureFlags(input, {
      OPENAI_BASE_URL: "https://example-resource.openai.azure.com/openai/v1",
      OPENAI_API_KEY: "azure-key",
      CODEX_MODEL: "gpt-5-deployment",
    });
    expect(toml).toContain("remote_models = false");
  });

  it("keeps remote_models enabled for non-Azure runtimes", () => {
    const input = ["[features]", "remote_models = true", ""].join("\n");
    const { toml } = ensureFeatureFlags(input, {
      OPENAI_BASE_URL: "https://api.openai.com/v1",
      OPENAI_API_KEY: "openai-key",
      CODEX_MODEL: "gpt-5.4",
    });
    expect(toml).toContain("remote_models = true");
  });

  it("adds sandbox workspace-write defaults with repo roots", () => {
    const input = ["[features]", "child_agents_md = true", ""].join("\n");
    const result = ensureSandboxWorkspaceWrite(input, {
      repoRoot: "/tmp/virtengine",
      writableRoots: "",
    });
    expect(result.changed).toBe(true);
    expect(result.added).toBe(true);
    expect(result.toml).toContain("[sandbox_workspace_write]");
    expect(result.toml).toContain('"/tmp"');
    expect(result.toml).toContain('"/tmp/virtengine"');
    // .git is only added when the directory actually exists on disk
    // (normalizeWritableRoots rejects phantom .git paths)
  });

  it("builds repo Codex config without bare /tmp roots on Windows", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "repo-codex-config-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    const tempRoot = mkdtempSync(join(tmpdir(), "repo-codex-temp-"));
    const toml = buildRepoCodexConfig({
      repoRoot,
      env: {
        OS: "Windows_NT",
        TEMP: tempRoot,
      },
    });
    expect(toml).toContain("use_linux_sandbox_bwrap = false");
    expect(toml).toContain(`"${tempRoot.replaceAll("\\", "\\\\")}"`);
    expect(toml).not.toContain('writable_roots = ["/tmp"');
  });

  it("honors legacy CODEX_SANDBOX env when building repo Codex config", () => {
    const toml = buildRepoCodexConfig({
      repoRoot: "/tmp/virtengine",
      env: {
        CODEX_SANDBOX: "danger-full-access",
      },
    });

    expect(toml).toContain('sandbox_mode = "danger-full-access"');
  });

  it("does not seed default MCP servers into repo Codex config unless enabled", () => {
    const toml = buildRepoCodexConfig({
      repoRoot: "/tmp/virtengine",
      env: {},
    });

    expect(toml).not.toContain("[mcp_servers.context7]");
    expect(toml).not.toContain("[mcp_servers.microsoft-docs]");
  });

  it("can opt back into default MCP servers when building repo Codex config", () => {
    const toml = buildRepoCodexConfig({
      repoRoot: "/tmp/virtengine",
      env: {
        BOSUN_MCP_ALLOW_DEFAULT_SERVERS: "1",
      },
    });

    expect(toml).toContain("[mcp_servers.context7]");
    expect(toml).toContain("[mcp_servers.microsoft-docs]");
  });

  it("does not duplicate common MCP servers from installed library entries", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "repo-codex-mcp-"));
    mkdirSync(join(repoRoot, ".bosun"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".bosun", "library.json"),
      JSON.stringify(
        {
          entries: [
            {
              id: "playwright",
              type: "mcp",
              meta: {
                command: "npx",
                args: ["-y", "@playwright/mcp@latest"],
              },
            },
            {
              id: "microsoft-docs",
              type: "mcp",
              meta: {
                transport: "url",
                url: "https://learn.microsoft.com/api/mcp",
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const toml = buildRepoCodexConfig({
      repoRoot,
      env: {
        BOSUN_MCP_ALLOW_DEFAULT_SERVERS: "1",
      },
    });

    expect(toml.match(/^\[mcp_servers\.playwright\]$/gm)?.length ?? 0).toBe(1);
    expect(toml.match(/^\[mcp_servers\.microsoft-docs\]$/gm)?.length ?? 0).toBe(1);
  });

  it("sanitizes legacy microsoft-docs tools arrays when merging repo config", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "repo-codex-merge-"));
    mkdirSync(join(repoRoot, ".codex"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".codex", "config.toml"),
      [
        "[mcp_servers.microsoft-docs]",
        'url = "https://learn.microsoft.com/api/mcp"',
        'tools = ["microsoft_docs_search", "microsoft_code_sample_search"]',
        "",
      ].join("\n"),
      "utf8",
    );

    ensureRepoConfigs(repoRoot, {
      env: {
        BOSUN_MCP_ALLOW_DEFAULT_SERVERS: "1",
      },
    });

    const merged = readFileSync(join(repoRoot, ".codex", "config.toml"), "utf8");
    expect(merged).toContain("[mcp_servers.microsoft-docs]");
    expect(merged).not.toContain("tools = [");
  });

  it("supports legacy sandbox_permissions helper names", () => {
    const line = buildSandboxPermissions("disk-full-write-access");
    expect(line).toContain('sandbox_mode = "workspace-write"');

    const result = ensureTopLevelSandboxPermissions("[features]\nchild_agents_md = true\n", "disk-full-write-access");
    expect(result.changed).toBe(true);
    expect(result.toml).toContain('sandbox_mode = "workspace-write"');
  });

  it("adds Windows namespace trusted path variants for WSL-style paths", () => {
    const uniquePath = `/mnt/c/Users/jON/Documents/source/repos/virtengine-gh/bosun/.tmp-trust-${Date.now()}`;
    const result = ensureTrustedProjects([uniquePath], { dryRun: true });
    const allEntries = [...result.added, ...result.already];
    expect(allEntries.some((entry) => entry.includes("\\\\?\\C:\\"))).toBe(true);
  });

  it("normalizes Azure OpenAI runtime base URLs for Codex", () => {
    const result = resolveCodexProfileRuntime({
      OPENAI_BASE_URL: "https://example-resource.openai.azure.com/openai/deployments/gpt-5/chat/completions?api-version=2024-10-21",
      OPENAI_API_KEY: "azure-key",
      CODEX_MODEL: "gpt-5-deployment",
    });

    expect(result.provider).toBe("azure");
    expect(result.env.OPENAI_BASE_URL).toBe("https://example-resource.openai.azure.com/openai/v1");
    expect(result.active.baseUrl).toBe("https://example-resource.openai.azure.com/openai/v1");
  });

  it("rewrites stale Azure provider base_url entries to the normalized models-safe endpoint", () => {
    const input = [
      "[model_providers.azure]",
      'name = "Azure OpenAI"',
      'base_url = "https://example-resource.openai.azure.com/openai/deployments/gpt-5/chat/completions?api-version=2024-10-21"',
      'env_key = "AZURE_OPENAI_API_KEY"',
      'wire_api = "responses"',
      "",
    ].join("\n");

    const result = ensureModelProviderSectionsFromEnv(input, {
      OPENAI_BASE_URL: "https://example-resource.openai.azure.com/openai/deployments/gpt-5/chat/completions?api-version=2024-10-21",
      OPENAI_API_KEY: "azure-key",
      CODEX_MODEL: "gpt-5-deployment",
    });

    expect(result.added).toEqual([]);
    expect(result.updated).toContain("azure.base_url");
    expect(result.toml).toContain('base_url = "https://example-resource.openai.azure.com/openai/v1"');
    expect(result.toml).not.toContain('/openai/deployments/gpt-5/chat/completions');
  });

  it("ignores ambient Codex home config when explicit env selects an Azure runtime", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-ambient-"));
    const codexDir = join(home, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(codexDir, "config.toml"),
      [
        '[model_providers.openai-direct]',
        'name = "OpenAI Direct"',
        'base_url = "https://api.openai.com/v1"',
        'env_key = "OPENAI_API_KEY"',
        'wire_api = "responses"',
        '',
      ].join("\n"),
      "utf8",
    );

    const azureEnv = {
      HOME: home,
      OPENAI_BASE_URL: "https://example-resource.openai.azure.com/openai/v1",
      OPENAI_API_KEY: "azure-key",
      CODEX_MODEL: "gpt-5-deployment",
    };
    const explicitAzureEnv = {
      OPENAI_BASE_URL: azureEnv.OPENAI_BASE_URL,
      OPENAI_API_KEY: azureEnv.OPENAI_API_KEY,
      CODEX_MODEL: azureEnv.CODEX_MODEL,
    };

    const runtimeWithHome = resolveCodexProfileRuntime(azureEnv);
    expect(runtimeWithHome.provider).toBe("azure");

    const features = ensureFeatureFlags("[features]\nremote_models = true\n", explicitAzureEnv);
    expect(features.toml).toContain("remote_models = false");

    const providers = ensureModelProviderSectionsFromEnv(
      [
        "[model_providers.azure]",
        'name = "Azure OpenAI"',
        'base_url = "https://example-resource.openai.azure.com/openai/deployments/gpt-5/chat/completions?api-version=2024-10-21"',
        'env_key = "AZURE_OPENAI_API_KEY"',
        'wire_api = "responses"',
        "",
      ].join("\n"),
      explicitAzureEnv,
    );
    expect(providers.updated).toContain("azure.base_url");
    expect(providers.toml).toContain('base_url = "https://example-resource.openai.azure.com/openai/v1"');
  });

  it("selects the Azure provider whose endpoint matches OPENAI_BASE_URL", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    const codexDir = join(home, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(codexDir, "config.toml"),
      [
        'model = "gpt-5-deployment"',
        'model_provider = "azure-sweden"',
        "",
        "[model_providers.azure-us]",
        'name = "Azure OpenAI US"',
        'base_url = "https://us-resource.openai.azure.com/openai/v1"',
        'env_key = "AZURE_OPENAI_API_KEY"',
        'wire_api = "responses"',
        "",
        "[model_providers.azure-sweden]",
        'name = "Azure OpenAI Sweden"',
        'base_url = "https://sweden-resource.openai.azure.com/openai/v1"',
        'env_key = "AZURE_SWEDEN_OPENAI_API_KEY"',
        'wire_api = "responses"',
        "",
      ].join("\n"),
      "utf8",
    );

    const result = resolveCodexProfileRuntime({
      HOME: home,
      OPENAI_BASE_URL: "https://us-resource.openai.azure.com/openai/v1",
      OPENAI_API_KEY: "shared-openai-key",
      AZURE_OPENAI_API_KEY: "us-key",
      AZURE_SWEDEN_OPENAI_API_KEY: "sweden-key",
    });

    expect(result.provider).toBe("azure");
    expect(result.configProvider).toEqual({
      name: "azure-us",
      envKey: "AZURE_OPENAI_API_KEY",
      baseUrl: "https://us-resource.openai.azure.com/openai/v1",
    });
    expect(result.env.OPENAI_BASE_URL).toBe("https://us-resource.openai.azure.com/openai/v1");
    expect(result.env.AZURE_OPENAI_API_KEY).toBe("us-key");
  });
});
