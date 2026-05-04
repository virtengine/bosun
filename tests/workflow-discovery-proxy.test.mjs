import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerCustomTool } from "../agent/agent-custom-tools.mjs";
import {
  buildCustomCatalog,
  createCatalogRuntime,
  makeCustomToolCanonicalId,
  makeMcpToolCanonicalId,
  parseCanonicalToolId,
  searchCatalogEntries,
} from "../workflow/mcp-discovery-proxy.mjs";
import {
  getResearchToolBundle,
  installMcpServer,
  listCatalog,
  listInstalledMcpServers,
  listResearchToolBundles,
  resolveMcpServersForAgent,
  wrapServersWithDiscoveryProxy,
} from "../workflow/mcp-registry.mjs";

const tempRoots = [];
const sharedHostPids = [];

async function makeRoot() {
  const root = resolve(tmpdir(), `bosun-discovery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(root, { recursive: true });
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  while (sharedHostPids.length > 0) {
    const pid = sharedHostPids.pop();
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    await rm(root, { recursive: true, force: true });
  }
});

describe("mcp discovery proxy helpers", () => {
  it("parses canonical tool ids", () => {
    expect(parseCanonicalToolId(makeCustomToolCanonicalId("lint-helper"))).toEqual({
      kind: "custom",
      toolId: "lint-helper",
    });
    expect(parseCanonicalToolId(makeMcpToolCanonicalId("github", "list_pull_requests"))).toEqual({
      kind: "mcp",
      serverId: "github",
      toolName: "list_pull_requests",
    });
  });

  it("builds a custom tool catalog with canonical ids", async () => {
    const root = await makeRoot();
    registerCustomTool(root, {
      title: "Lint Helper",
      description: "Runs lint with repo defaults",
      category: "validation",
      lang: "mjs",
      script: "console.log('lint')",
      autoInject: true,
    });
    const catalog = buildCustomCatalog(root);
    const entry = catalog.find((item) => item.canonicalId === makeCustomToolCanonicalId("lint-helper"));
    expect(entry).toBeTruthy();
    expect(entry.inputSchema.properties.args).toBeTruthy();
  });

  it("searches catalog entries by keyword relevance", () => {
    const results = searchCatalogEntries([
      {
        canonicalId: makeMcpToolCanonicalId("github", "list_pull_requests"),
        kind: "mcp",
        serverId: "github",
        toolName: "list_pull_requests",
        description: "List open pull requests",
        tags: ["github", "pr"],
      },
      {
        canonicalId: makeCustomToolCanonicalId("lint-helper"),
        kind: "custom",
        toolId: "lint-helper",
        title: "Lint Helper",
        description: "Run lint",
        tags: ["lint"],
      },
    ], "github pr", 5);
    expect(results[0].canonicalId).toBe(makeMcpToolCanonicalId("github", "list_pull_requests"));
  });

  it("executes discovery code against custom tools and returns the final result only", async () => {
    const root = await makeRoot();
    registerCustomTool(root, {
      id: "echo-json",
      title: "Echo JSON",
      description: "Prints argv as JSON",
      category: "utility",
      lang: "mjs",
      script: "console.log(JSON.stringify({ argv: process.argv.slice(2) }))",
    });

    const runtime = createCatalogRuntime({
      rootDir: root,
      servers: [],
      executeTimeoutMs: 2000,
    });

    const result = await runtime.executeCode(`
      const output = await callTool("custom:echo-json", { args: ["alpha", "beta"] });
      return JSON.parse(output.stdout).argv.join(",");
    `);

    expect(result).toBe("alpha,beta");
  });

  it("reuses a single MCP client connection for repeated list and call operations", async () => {
    const clientFactory = vi.fn(async () => ({
      client: {
        listTools: vi.fn(async () => ({
          tools: [
            {
              name: "lookup_issue",
              description: "Lookup issue details",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        })),
        callTool: vi.fn(async () => ({
          content: [{ type: "text", text: "ok" }],
          structuredContent: { ok: true },
        })),
      },
      transport: {
        close: vi.fn(async () => {}),
      },
    }));

    const runtime = createCatalogRuntime({
      rootDir: process.cwd(),
      servers: [
        {
          id: "github",
          name: "GitHub",
          transport: "stdio",
          command: "node",
          args: ["server.js"],
          env: {},
        },
      ],
      cacheTtlMs: 60_000,
    }, {
      clientFactory,
    });

    const first = await runtime.getCatalogEntries("mcp");
    const second = await runtime.getEntry(makeMcpToolCanonicalId("github", "lookup_issue"));
    const called = await runtime.callEntry(
      makeMcpToolCanonicalId("github", "lookup_issue"),
      { issue: 123 },
    );

    expect(first).toHaveLength(1);
    expect(second?.toolName).toBe("lookup_issue");
    expect(called.result.structuredContent).toEqual({ ok: true });
    expect(clientFactory).toHaveBeenCalledTimes(1);

    await runtime.close();
  });

  it("resolves multiple schemas in one request path", async () => {
    const root = await makeRoot();
    registerCustomTool(root, {
      id: "lint-helper",
      title: "Lint Helper",
      description: "Runs lint with repo defaults",
      category: "validation",
      lang: "mjs",
      script: "console.log('lint')",
      autoInject: true,
    });
    registerCustomTool(root, {
      id: "test-helper",
      title: "Test Helper",
      description: "Runs tests with repo defaults",
      category: "validation",
      lang: "mjs",
      script: "console.log('test')",
    });

    const runtime = createCatalogRuntime({ rootDir: root, servers: [] });
    const entries = await Promise.all([
      runtime.getEntry(makeCustomToolCanonicalId("lint-helper")),
      runtime.getEntry(makeCustomToolCanonicalId("test-helper")),
    ]);

    expect(entries.map((entry) => entry.toolId)).toEqual(["lint-helper", "test-helper"]);
  });

  it("wraps servers with a single discovery proxy and persists config", async () => {
    const root = await makeRoot();
    registerCustomTool(root, {
      title: "Lint Helper",
      description: "Runs lint with repo defaults",
      category: "validation",
      lang: "mjs",
      script: "console.log('lint')",
    });
    const wrapped = await wrapServersWithDiscoveryProxy(root, [
      {
        id: "github",
        name: "GitHub",
        transport: "stdio",
        command: "node",
        args: ["server.js"],
        env: {},
      },
    ], {});
    expect(wrapped).toHaveLength(1);
    expect(wrapped[0].id).toBe("bosun-discovery-proxy");
    expect(wrapped[0].transport).toBe("url");
    expect(wrapped[0].url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(typeof wrapped[0].meta?.sharedHostPid).toBe("number");
    sharedHostPids.push(wrapped[0].meta.sharedHostPid);
  });

  it("reuses the same discovery proxy config path for identical payloads", async () => {
    const root = await makeRoot();
    registerCustomTool(root, {
      id: "schema-helper",
      title: "Schema Helper",
      description: "Ensures discovery proxy is materialized",
      category: "utility",
      lang: "mjs",
      script: "console.log('ok')",
    });

    const first = await wrapServersWithDiscoveryProxy(root, [], {
      includeCustomTools: true,
      cacheTtlMs: 12345,
      executeTimeoutMs: 6789,
    });
    const second = await wrapServersWithDiscoveryProxy(root, [], {
      includeCustomTools: true,
      cacheTtlMs: 12345,
      executeTimeoutMs: 6789,
    });

    expect(first[0].url).toBe(second[0].url);
    sharedHostPids.push(first[0].meta.sharedHostPid);
  });

  it("rejects unresolved template root directories", async () => {
    await expect(wrapServersWithDiscoveryProxy("{{worktreePath}}", [], {}))
      .rejects.toThrow(/unresolved template/i);
  });

  it("persists discovery proxy tuning in config", async () => {
    const root = await makeRoot();
    registerCustomTool(root, {
      id: "schema-helper",
      title: "Schema Helper",
      description: "Ensures discovery proxy is materialized",
      category: "utility",
      lang: "mjs",
      script: "console.log('ok')",
    });
    const wrapped = await wrapServersWithDiscoveryProxy(root, [], {
      includeCustomTools: true,
      cacheTtlMs: 12345,
      executeTimeoutMs: 6789,
      sharedHost: false,
    });
    const configPath = wrapped[0].env.BOSUN_DISCOVERY_PROXY_CONFIG_PATH;
    const payload = JSON.parse(await readFile(configPath, "utf8"));
    expect(payload.cacheTtlMs).toBe(12345);
    expect(payload.executeTimeoutMs).toBe(6789);
  });

  it("falls back to a stdio proxy when shared discovery hosting is disabled", async () => {
    const root = await makeRoot();
    registerCustomTool(root, {
      id: "schema-helper",
      title: "Schema Helper",
      description: "Ensures discovery proxy is materialized",
      category: "utility",
      lang: "mjs",
      script: "console.log('ok')",
    });

    const wrapped = await wrapServersWithDiscoveryProxy(root, [], {
      includeCustomTools: true,
      sharedHost: false,
    });

    expect(wrapped[0].transport).toBe("stdio");
    expect(wrapped[0].args[0]).toContain("mcp-discovery-proxy.mjs");
    expect(existsSync(wrapped[0].env.BOSUN_DISCOVERY_PROXY_CONFIG_PATH)).toBe(true);
  });

  it("defaults curated catalog listings to verified servers while allowing experimental opt-in", async () => {
    const verifiedOnly = listCatalog();
    const allEntries = listCatalog({ includeExperimental: true });
    const experimentalOnly = listCatalog({ stabilityTier: "experimental", includeExperimental: true });

    expect(verifiedOnly.length).toBeGreaterThan(0);
    expect(verifiedOnly.every((entry) => entry.stabilityTier === "verified")).toBe(true);
    expect(allEntries.length).toBeGreaterThan(verifiedOnly.length);
    expect(experimentalOnly.length).toBeGreaterThan(0);
    expect(experimentalOnly.every((entry) => entry.stabilityTier === "experimental")).toBe(true);
  });

  it("exposes a scientific-evidence research bundle with MCP and native capability recommendations", async () => {
    const bundles = listResearchToolBundles();
    const bundle = getResearchToolBundle("scientific-evidence", { includeExperimental: true });

    expect(bundles.some((entry) => entry.id === "scientific-evidence")).toBe(true);
    expect(bundle).toBeTruthy();
    expect(bundle.recommendedServerIds).toEqual(
      expect.arrayContaining(["fetch", "filesystem", "context7"]),
    );
    expect(bundle.optionalServerIds).toEqual(
      expect.arrayContaining(["exa", "brave-search"]),
    );
    expect(bundle.nativeCapabilities.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(["pdf-corpus-ingestion", "runtime-log-query", "reviewed-finding-promotion"]),
    );
  });

  it("persists stability tier and install surface for curated MCP installs", async () => {
    const root = await makeRoot();
    const installed = await installMcpServer(root, "github");
    expect(installed.stabilityTier).toBe("verified");
    expect(installed.installSurface).toBe("curated");

    const servers = await listInstalledMcpServers(root);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      id: "github",
      stabilityTier: "verified",
      installSurface: "curated",
    });
  });

  it("skips curated MCP servers with missing required auth by default", async () => {
    const root = await makeRoot();
    const resolved = await resolveMcpServersForAgent(root, ["linear"]);
    expect(resolved).toEqual([]);
  });

  it("accepts curated MCP servers when required auth is present in the environment", async () => {
    const root = await makeRoot();
    const previous = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = "test-linear-key";
    try {
      const resolved = await resolveMcpServersForAgent(root, ["linear"]);
      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({
        id: "linear",
        command: "npx",
        stabilityTier: "experimental",
        installSurface: "curated",
        env: {
          LINEAR_API_KEY: "test-linear-key",
        },
      });
    } finally {
      if (previous === undefined) {
        delete process.env.LINEAR_API_KEY;
      } else {
        process.env.LINEAR_API_KEY = previous;
      }
    }
  });
});
