/**
 * shell/mcp-client.mjs — Native MCP Client for Bosun Harness
 *
 * Wraps @modelcontextprotocol/sdk to provide:
 *   - stdio + SSE transport connection management
 *   - Tool discovery and schema caching
 *   - Tool execution with result normalization
 *   - Connection pooling and lifecycle management
 *
 * Design:
 *   - One Client per MCP server; managed by McpClientManager
 *   - Tool names are namespaced: mcp__{serverId}__{toolName}
 *   - Schemas are cached in-memory per server; re-fetched on reconnect
 *   - Connections are lazy: first resolveTools() or executeTool() triggers connect
 *   - Best-effort: failures log warnings and return empty results; they never block
 *     the live agent path.
 */

const TAG = "[mcp-client]";

let mcpSdkPromise = null;
let mcpSdkLoader = defaultLoadMcpSdk;

// ── Utilities ────────────────────────────────────────────────────────────────

function toErrMsg(err) {
  return err?.message || err;
}

function normalizeMcpSdkLoadError(err) {
  return new Error(
    `MCP SDK unavailable: ${toErrMsg(err)}. Run npm install to restore @modelcontextprotocol/sdk.`,
  );
}

async function defaultLoadMcpSdk() {
  if (!mcpSdkPromise) {
    mcpSdkPromise = Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/client/stdio.js"),
      import("@modelcontextprotocol/sdk/client/sse.js"),
    ])
      .then(([clientModule, stdioModule, sseModule]) => ({
        Client: clientModule.Client,
        StdioClientTransport: stdioModule.StdioClientTransport,
        SSEClientTransport: sseModule.SSEClientTransport,
      }))
      .catch((err) => {
        mcpSdkPromise = null;
        throw normalizeMcpSdkLoadError(err);
      });
  }
  return mcpSdkPromise;
}

async function loadMcpSdk() {
  return mcpSdkLoader();
}

export function __setMcpSdkLoaderForTests(loader = null) {
  mcpSdkLoader = loader || defaultLoadMcpSdk;
  mcpSdkPromise = null;
}

function toStr(v) {
  return String(v ?? "").trim();
}

function cloneJson(value) {
  if (value == null) return value ?? null;
  return JSON.parse(JSON.stringify(value));
}

// ── Tool Schema Normalization ────────────────────────────────────────────────

/**
 * Convert an MCP tool definition into a Bosun-compatible tool shape.
 * Namespaced name: mcp__{serverId}__{toolName}
 */
function normalizeMcpTool(serverId, tool) {
  const name = toStr(tool.name);
  if (!name) return null;
  const nsName = `mcp__${serverId}__${name}`;
  const description = toStr(tool.description) || `${name} (MCP)`;

  // MCP inputSchema → OpenAI function parameters
  const parameters = tool.inputSchema && typeof tool.inputSchema === "object"
    ? cloneJson(tool.inputSchema)
    : { type: "object", properties: {} };

  // If the schema has no `required` array but has properties, default to no required fields
  if (!Array.isArray(parameters.required)) {
    parameters.required = [];
  }

  return {
    type: "function",
    name: nsName,
    description,
    parameters,
    // Internal metadata so the executor knows where to route
    _mcpServerId: serverId,
    _mcpToolName: name,
    _mcpToolOriginal: cloneJson(tool),
  };
}

/**
 * Parse MCP tool call result content blocks into a string for the LLM.
 */
function normalizeMcpToolResult(result) {
  if (!result) return "(no result)";
  if (result.isError) {
    const blocks = Array.isArray(result.content) ? result.content : [];
    const text = blocks
      .filter((b) => b?.type === "text")
      .map((b) => b.text)
      .join("\n");
    return `Error: ${text || "unknown MCP tool error"}`;
  }
  const blocks = Array.isArray(result.content) ? result.content : [];
  const textParts = [];
  for (const block of blocks) {
    if (block?.type === "text" && block.text != null) {
      textParts.push(String(block.text));
    } else if (block?.type === "image" && block.data) {
      textParts.push("[image output omitted]");
    } else if (block?.type === "resource" && block.resource) {
      textParts.push(`[resource: ${block.resource.uri || ""}]`);
    } else {
      textParts.push(JSON.stringify(block));
    }
  }
  return textParts.join("\n") || JSON.stringify(result);
}

// ── Single Server Client ─────────────────────────────────────────────────────

class McpServerClient {
  constructor(serverConfig) {
    this.id = toStr(serverConfig.id);
    this.name = toStr(serverConfig.name) || this.id;
    this.transportType = toStr(serverConfig.transport).toLowerCase() || "stdio";
    this.command = toStr(serverConfig.command) || null;
    this.args = Array.isArray(serverConfig.args) ? [...serverConfig.args] : [];
    this.url = toStr(serverConfig.url) || null;
    this.env = serverConfig.env && typeof serverConfig.env === "object"
      ? { ...serverConfig.env }
      : {};
    this._client = null;
    this._transport = null;
    this._tools = []; // cached normalized tools
    this._connecting = false;
    this._connected = false;
  }

  async _ensureConnected() {
    if (this._connected && this._client) return;
    if (this._connecting) {
      // Simple spin-wait for concurrent callers
      const deadline = Date.now() + 10_000;
      while (this._connecting && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (this._connected) return;
    }

    this._connecting = true;
    try {
      const {
        Client,
        StdioClientTransport,
        SSEClientTransport,
      } = await loadMcpSdk();
      if (this.transportType === "url" && this.url) {
        this._transport = new SSEClientTransport(new URL(this.url));
      } else if (this.command) {
        this._transport = new StdioClientTransport({
          command: this.command,
          args: this.args,
          env: this.env,
        });
      } else {
        throw new Error(`${TAG} server "${this.id}" has no command or url`);
      }

      this._client = new Client({ name: "bosun-mcp-client", version: "1.0.0" });
      await this._client.connect(this._transport);
      this._connected = true;
    } catch (err) {
      console.warn(`${TAG} failed to connect to MCP server "${this.id}": ${toErrMsg(err)}`);
      this._connected = false;
      throw err;
    } finally {
      this._connecting = false;
    }
  }

  async listTools() {
    await this._ensureConnected();
    if (!this._client) return [];
    try {
      const result = await this._client.listTools();
      const rawTools = Array.isArray(result?.tools) ? result.tools : [];
      this._tools = rawTools
        .map((t) => normalizeMcpTool(this.id, t))
        .filter(Boolean);
      return this._tools;
    } catch (err) {
      console.warn(`${TAG} listTools failed for "${this.id}": ${err?.message || err}`);
      return this._tools;
    }
  }

  async executeTool(toolName, args) {
    try {
      await this._ensureConnected();
    } catch (err) {
      return { error: `MCP tool execution failed: ${toErrMsg(err)}` };
    }
    if (!this._client) {
      return { error: `MCP client for "${this.id}" is not connected.` };
    }
    try {
      const result = await this._client.callTool({ name: toolName, arguments: args || {} });
      return normalizeMcpToolResult(result);
    } catch (err) {
      console.warn(`${TAG} executeTool "${toolName}" on "${this.id}" failed: ${toErrMsg(err)}`);
      return { error: `MCP tool execution failed: ${toErrMsg(err)}` };
    }
  }

  async close() {
    try {
      await this._client?.close();
    } catch { /* ignore */ }
    this._client = null;
    this._transport = null;
    this._connected = false;
    this._tools = [];
  }

  isConnected() {
    return this._connected;
  }
}

// ── Client Manager ───────────────────────────────────────────────────────────

export class McpClientManager {
  constructor() {
    /** @type {Map<string, McpServerClient>} */
    this._clients = new Map();
  }

  /**
   * Register one or more server configs.
   * @param {Object|Object[]} configs
   */
  addServers(configs) {
    const list = Array.isArray(configs) ? configs : [configs];
    for (const cfg of list) {
      const id = toStr(cfg?.id);
      if (!id) continue;
      // Don't replace an active connection
      if (!this._clients.has(id)) {
        this._clients.set(id, new McpServerClient(cfg));
      }
    }
  }

  /**
   * Resolve all tools from all registered servers.
   * Returns a flat array of Bosun-normalized tool definitions.
   */
  async resolveAllTools() {
    const all = [];
    for (const [id, client] of this._clients) {
      try {
        const tools = await client.listTools();
        all.push(...tools);
      } catch (err) {
        console.warn(`${TAG} resolveTools failed for "${id}": ${err?.message || err}`);
      }
    }
    return all;
  }

  /**
   * Execute a namespaced tool call.
   * @param {string} nsName  e.g. "mcp__github__createIssue"
   * @param {Object} args
   */
  async executeTool(nsName, args) {
    const parts = nsName.split("__");
    // Expected: ["mcp", serverId, toolName]
    if (parts.length < 3 || parts[0] !== "mcp") {
      return { error: `Invalid MCP tool name format: "${nsName}"` };
    }
    const serverId = parts[1];
    const toolName = parts.slice(2).join("__");
    const client = this._clients.get(serverId);
    if (!client) {
      return { error: `MCP server "${serverId}" is not registered.` };
    }
    return client.executeTool(toolName, args);
  }

  /**
   * Check if a tool name belongs to an MCP server managed by this manager.
   */
  isMcpTool(nsName) {
    const parts = nsName.split("__");
    if (parts.length < 3 || parts[0] !== "mcp") return false;
    return this._clients.has(parts[1]);
  }

  getConnectedServerIds() {
    return [...this._clients.entries()]
      .filter(([, c]) => c.isConnected())
      .map(([id]) => id);
  }

  async closeAll() {
    for (const [, client] of this._clients) {
      await client.close();
    }
    this._clients.clear();
  }
}

// ── Singleton export ─────────────────────────────────────────────────────────

let _globalManager = null;

export function getGlobalMcpClientManager() {
  if (!_globalManager) {
    _globalManager = new McpClientManager();
  }
  return _globalManager;
}

export function resetGlobalMcpClientManager() {
  if (_globalManager) {
    _globalManager.closeAll().catch(() => {});
    _globalManager = null;
  }
}

// ── Convenience: resolve MCP tools from execOptions ──────────────────────────

/**
 * Given execOptions that may contain `mcpServers` (resolved server configs),
 * register them with the global MCP manager, discover tools, and return the
 * merged tool list.
 *
 * @param {Object[]} baseTools          Existing tools (e.g. from execOptions.tools)
 * @param {Object[]} mcpServerConfigs   Resolved MCP server configs
 * @returns {Promise<Object[]>}         baseTools + MCP tools
 */
export async function resolveMcpTools(baseTools = [], mcpServerConfigs = []) {
  if (!Array.isArray(mcpServerConfigs) || mcpServerConfigs.length === 0) {
    return baseTools;
  }
  const manager = getGlobalMcpClientManager();
  manager.addServers(mcpServerConfigs);
  const mcpTools = await manager.resolveAllTools();
  return [...baseTools, ...mcpTools];
}

/**
 * Wrap a tool execution context with MCP support.
 *
 * Usage in the native adapter:
 *   const toolOrchestrator = createMcpToolOrchestrator(execOptions.toolOrchestrator);
 *
 * This decorator checks if a tool name is an MCP namespaced tool and routes it
 * through the global MCP manager before falling back to the original orchestrator.
 */
export function createMcpToolOrchestrator(originalOrchestrator = null) {
  const manager = getGlobalMcpClientManager();
  return {
    async executeTool(name, args, ctx) {
      if (manager.isMcpTool(name)) {
        return manager.executeTool(name, args);
      }
      if (originalOrchestrator && typeof originalOrchestrator.executeTool === "function") {
        return originalOrchestrator.executeTool(name, args, ctx);
      }
      return { error: `No executor configured for tool "${name}".` };
    },
  };
}

export default {
  McpClientManager,
  getGlobalMcpClientManager,
  resetGlobalMcpClientManager,
  resolveMcpTools,
  createMcpToolOrchestrator,
};
