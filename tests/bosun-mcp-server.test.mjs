import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { skipLocallyForSpeed } from "./test-speed-gates.mjs";

const repoRoot = process.cwd();
const serverPath = resolve(repoRoot, "server", "bosun-mcp-server.mjs");

function createFrameReader(stream) {
  let buffer = "";
  const pending = [];
  const queue = [];

  const flush = () => {
    while (true) {
      const separator = buffer.indexOf("\n");
      if (separator === -1) return;
      const line = buffer.slice(0, separator).replace(/\r$/, "");
      buffer = buffer.slice(separator + 1);
      if (!line.trim()) {
        continue;
      }
      const parsed = JSON.parse(line);
      if (pending.length > 0) {
        pending.shift().resolve(parsed);
      } else {
        queue.push(parsed);
      }
    }
  };

  stream.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    flush();
  });

  stream.on("error", (error) => {
    while (pending.length > 0) {
      pending.shift().reject(error);
    }
  });

  return {
    next() {
      if (queue.length > 0) {
        return Promise.resolve(queue.shift());
      }
      return new Promise((resolvePromise, rejectPromise) => {
        pending.push({ resolve: resolvePromise, reject: rejectPromise });
      });
    },
  };
}

async function startMcpProcess() {
  const child = spawn(process.execPath, [serverPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      TELEGRAM_UI_TUNNEL: "disabled",
      BOSUN_MCP_DISABLE_DAEMON_DISCOVERY: "1",
      NODE_ENV: "test",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stderr = [];
  child.stderr.on("data", (chunk) => {
    stderr.push(chunk.toString("utf8"));
  });

  const reader = createFrameReader(child.stdout);
  let nextId = 1;

  async function sendRequest(method, params) {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    while (true) {
      const message = await reader.next();
      if (message.id === id) return message;
    }
  }

  async function initialize() {
    const response = await sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "bosun-mcp-test", version: "1.0.0" },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    return response;
  }

  async function listTools() {
    return sendRequest("tools/list", {});
  }

  async function callTool(name, args = {}) {
    return sendRequest("tools/call", { name, arguments: args });
  }

  async function stop() {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
    await new Promise((resolvePromise) => {
      child.once("exit", () => resolvePromise());
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* best effort */
        }
        resolvePromise();
      }, 10000);
    });
  }

  return {
    child,
    stderr,
    initialize,
    listTools,
    callTool,
    stop,
  };
}

async function waitFor(predicate, timeoutMs = 15000, intervalMs = 150) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  return null;
}

afterEach(async () => {
  const uiServerModule = await import("../server/ui-server.mjs");
  uiServerModule.stopTelegramUiServer();
}, 30000);

describe("bosun MCP server", () => {
  it.skipIf(skipLocallyForSpeed)("lists the Bosun MCP tool surface over stdio", async () => {
    const mcp = await startMcpProcess();
    try {
      const init = await mcp.initialize();
      expect(init.result?.serverInfo?.name).toBe("bosun-mcp-server");

      const tools = await mcp.listTools();
      const names = (tools.result?.tools || []).map((tool) => tool.name);
      expect(names).toContain("bosun_status");
      expect(names).toContain("bosun_request");
      expect(names).toContain("bosun_send_session_message");
      expect(names).toContain("bosun_run_agent_tool");
      expect(names).toContain("replace_lines");
    } finally {
      await mcp.stop();
    }
  }, 30000);

  it("supports line-scoped file edits without shell temp scripts", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "bosun-mcp-lines-"));
    const targetPath = join(workspaceDir, "sample.mjs");
    writeFileSync(
      targetPath,
      [
        "export function greet(name) {",
        "  return `Hello, ${name}!`;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const mcp = await startMcpProcess();
    try {
      await mcp.initialize();
      const result = await mcp.callTool("replace_lines", {
        path: targetPath,
        start_line: 2,
        end_line: 2,
        new_content: "  return `Hi, ${name}.`;",
      });
      const payload = JSON.parse(result.result.content[0].text);
      expect(payload.success).toBe(true);
      expect(payload.replaced_line_range).toEqual([2, 2]);
      expect(readFileSync(targetPath, "utf8")).toContain("  return `Hi, ${name}.`;");
    } finally {
      await mcp.stop();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  }, 30000);

  it("refuses to overwrite an existing file via write_file unless overwrite_existing=true", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "bosun-mcp-write-file-"));
    const targetPath = join(workspaceDir, "sample.mjs");
    writeFileSync(targetPath, "export const original = true;\n", "utf8");

    const mcp = await startMcpProcess();
    try {
      await mcp.initialize();

      const rejected = await mcp.callTool("write_file", {
        path: targetPath,
        content: "// TEMP PLACEHOLDER\n",
      });
      expect(rejected.error?.message || "").toContain("refuses to overwrite existing file");
      expect(readFileSync(targetPath, "utf8")).toBe("export const original = true;\n");

      const allowed = await mcp.callTool("write_file", {
        path: targetPath,
        content: "export const rewritten = true;\n",
        overwrite_existing: true,
      });
      const payload = JSON.parse(allowed.result.content[0].text);
      expect(payload.success).toBe(true);
      expect(payload.overwritten_existing).toBe(true);
      expect(readFileSync(targetPath, "utf8")).toBe("export const rewritten = true;\n");
    } finally {
      await mcp.stop();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  }, 30000);

  it.skipIf(skipLocallyForSpeed)("supports creating and reading sessions through MCP tools", async () => {
    const mcp = await startMcpProcess();
    try {
      await mcp.initialize();

      const created = await mcp.callTool("bosun_create_session", {
        type: "primary",
        prompt: "Bosun MCP smoke test",
        mode: "agent",
      });
      const createdPayload = JSON.parse(created.result.content[0].text);
      expect(createdPayload.session?.id).toBeTruthy();
      const sessionId = createdPayload.session.id;

      const sent = await mcp.callTool("bosun_send_session_message", {
        sessionId,
        content: "record this message",
      });
      const sentPayload = JSON.parse(sent.result.content[0].text);
      expect(sentPayload.ok).toBe(true);

      const fetchedPayload = await waitFor(async () => {
        const fetched = await mcp.callTool("bosun_get_session", {
          sessionId,
          full: true,
        });
        const payload = JSON.parse(fetched.result.content[0].text);
        if ((payload.session?.messages || []).length > 0) {
          return payload;
        }
        return null;
      });

      expect(fetchedPayload).toBeTruthy();
      expect(fetchedPayload.session?.id).toBe(sessionId);
      expect(Array.isArray(fetchedPayload.session?.messages)).toBe(true);
      expect(fetchedPayload.session.messages.length).toBeGreaterThan(0);

      const listed = await mcp.callTool("bosun_list_sessions", {});
      const listedPayload = JSON.parse(listed.result.content[0].text);
      expect(Array.isArray(listedPayload.sessions)).toBe(true);
      expect(listedPayload.sessions.some((session) => session.id === sessionId)).toBe(true);
    } finally {
      await mcp.stop();
    }
  }, 60000);
});
