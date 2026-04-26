import { access, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createWindowsDesktopMcpHandlers,
  createWindowsDesktopMcpRuntime,
  listWindowsDesktopMcpTools,
  normalizeSendKeys,
} from "../plugins/windows-desktop-control/scripts/windows-desktop-mcp-server.mjs";

const repoRoot = process.cwd();
const serverPath = resolve(
  repoRoot,
  "plugins",
  "windows-desktop-control",
  "scripts",
  "windows-desktop-mcp-server.mjs",
);
const pluginRoot = resolve(repoRoot, "plugins", "windows-desktop-control");
const mcpConfigPath = resolve(pluginRoot, ".mcp.json");

function createFrameReader(stream) {
  let buffer = "";
  const queue = [];
  const pending = [];

  const flush = () => {
    while (true) {
      const separator = buffer.indexOf("\n");
      if (separator === -1) return;
      const line = buffer.slice(0, separator).replace(/\r$/, "");
      buffer = buffer.slice(separator + 1);
      if (!line.trim()) continue;
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
    env: { ...process.env, NODE_ENV: "test" },
    stdio: ["pipe", "pipe", "pipe"],
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
      clientInfo: { name: "windows-desktop-test", version: "1.0.0" },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    return response;
  }

  async function listTools() {
    return sendRequest("tools/list", {});
  }

  async function stop() {
    if (!child.killed) child.kill("SIGTERM");
    await new Promise((resolvePromise) => {
      child.once("exit", () => resolvePromise());
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* best effort */
        }
        resolvePromise();
      }, 5000);
    });
  }

  return { initialize, listTools, stop };
}

describe("windows desktop MCP server", () => {
  it("lists the expected tool surface", () => {
    const names = listWindowsDesktopMcpTools().map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      "list_displays",
      "screenshot",
      "list_windows",
      "focus_window",
      "move_window",
      "click",
      "double_click",
      "type_text",
      "press_keys",
      "scroll",
      "drag",
      "launch_app",
      "uia_inspect",
      "uia_invoke",
    ]));
  });

  it("pins the MCP server cwd to the plugin root so the relative script path resolves", async () => {
    const config = JSON.parse(await readFile(mcpConfigPath, "utf8"));
    const serverConfig = config?.mcpServers?.windows_desktop_control;

    expect(serverConfig?.command).toBe("node");
    expect(serverConfig?.cwd).toBe(".");
    expect(serverConfig?.args).toEqual(["./scripts/windows-desktop-mcp-server.mjs"]);

    const launchCwd = resolve(pluginRoot, serverConfig.cwd);
    const entryPath = resolve(launchCwd, serverConfig.args[0]);
    await expect(access(entryPath)).resolves.toBeUndefined();
  });

  it("builds a display inventory query for list_displays", async () => {
    const commands = [];
    const runtime = createWindowsDesktopMcpRuntime({
      platform: "win32",
      execCommand: vi.fn(async (command, args) => {
        commands.push({ command, args });
        return {
          stdout: JSON.stringify({
            displayCount: 2,
            virtualScreen: { x: -1920, y: 0, width: 3840, height: 1080 },
            displays: [
              { displayId: 0, deviceName: "\\\\.\\DISPLAY1", isPrimary: true },
              { displayId: 1, deviceName: "\\\\.\\DISPLAY2", isPrimary: false },
            ],
          }),
          stderr: "",
        };
      }),
    });
    const handlers = createWindowsDesktopMcpHandlers(runtime);

    const result = await handlers.callTool("list_displays");
    expect(result.structuredContent.displayCount).toBe(2);
    expect(commands[0].args.join(" ")).toContain("Get-DisplayInventory");
    expect(commands[0].args.join(" ")).toContain("VirtualScreen");
  });

  it("blocks launch_app when the app is outside the allowlist", async () => {
    const runtime = createWindowsDesktopMcpRuntime({
      platform: "win32",
      allowedApps: ["notepad.exe"],
      execCommand: vi.fn(),
    });
    const handlers = createWindowsDesktopMcpHandlers(runtime);

    await expect(
      handlers.callTool("launch_app", { application: "cmd.exe" }),
    ).rejects.toThrow("launch_app blocked");
  });

  it("runs allowlisted launch_app calls through PowerShell", async () => {
    const commands = [];
    const runtime = createWindowsDesktopMcpRuntime({
      platform: "win32",
      allowedApps: ["notepad.exe"],
      execCommand: vi.fn(async (command, args) => {
        commands.push({ command, args });
        return {
          stdout: JSON.stringify({
            processId: 1234,
            processName: "notepad",
            application: "notepad.exe",
            allowlisted: true,
          }),
          stderr: "",
        };
      }),
    });
    const handlers = createWindowsDesktopMcpHandlers(runtime);

    const result = await handlers.callTool("launch_app", { application: "notepad.exe" });
    expect(result.structuredContent.processId).toBe(1234);
    expect(commands).toHaveLength(1);
    expect(commands[0].command).toBe("powershell");
    expect(commands[0].args.join(" ")).toContain("Start-Process");
    expect(commands[0].args.join(" ")).toContain("notepad.exe");
  });

  it("builds display-relative screenshot capture against a selected monitor", async () => {
    const commands = [];
    const runtime = createWindowsDesktopMcpRuntime({
      platform: "win32",
      execCommand: vi.fn(async (command, args) => {
        commands.push({ command, args });
        return {
          stdout: JSON.stringify({
            path: "C:\\temp\\capture.png",
            x: 1970,
            y: 50,
            width: 1280,
            height: 720,
          }),
          stderr: "",
        };
      }),
    });
    const handlers = createWindowsDesktopMcpHandlers(runtime);

    await handlers.callTool("screenshot", {
      displayId: 1,
      displayRelative: true,
      x: 50,
      y: 50,
      width: 1280,
      height: 720,
    });

    const script = commands[0].args.join(" ");
    expect(script).toContain("Get-DisplayInventory");
    expect(script).toContain("$displayId = 1");
    expect(script).toContain("$originX = [int]$display.bounds.x");
    expect(script).toContain("Rectangle(($originX + $regionX), ($originY + $regionY), $regionWidth, $regionHeight)");
  });

  it("moves windows onto a chosen display with SetWindowPos", async () => {
    const commands = [];
    const runtime = createWindowsDesktopMcpRuntime({
      platform: "win32",
      execCommand: vi.fn(async (command, args) => {
        commands.push({ command, args });
        return {
          stdout: JSON.stringify({
            success: true,
            x: 1920,
            y: 0,
            width: 1280,
            height: 720,
          }),
          stderr: "",
        };
      }),
    });
    const handlers = createWindowsDesktopMcpHandlers(runtime);

    const result = await handlers.callTool("move_window", {
      processName: "notepad",
      displayName: "\\\\.\\DISPLAY2",
      width: 1280,
      height: 720,
    });

    expect(result.structuredContent.success).toBe(true);
    const script = commands[0].args.join(" ");
    expect(script).toContain("SetWindowPos");
    expect(script).toContain("$displayName = '\\\\.\\DISPLAY2'");
    expect(script).toContain("$relativeToDisplay = $null");
    expect(script).toContain("$relativeToDisplay = $null -ne $display");
  });

  it("adds window bounds and display metadata to list_windows", async () => {
    const commands = [];
    const runtime = createWindowsDesktopMcpRuntime({
      platform: "win32",
      execCommand: vi.fn(async (command, args) => {
        commands.push({ command, args });
        return {
          stdout: JSON.stringify([
            {
              processId: 1234,
              processName: "notepad",
              title: "Untitled - Notepad",
              handle: "0x1A2B",
              bounds: { x: 0, y: 0, width: 800, height: 600 },
              display: { displayId: 0, deviceName: "\\\\.\\DISPLAY1", isPrimary: true },
            },
          ]),
          stderr: "",
        };
      }),
    });
    const handlers = createWindowsDesktopMcpHandlers(runtime);

    const result = await handlers.callTool("list_windows");
    expect(result.structuredContent[0].bounds.width).toBe(800);
    const script = commands[0].args.join(" ");
    expect(script).toContain("GetWindowRect");
    expect(script).toContain("Screen]::FromHandle");
    expect(script).toContain("displayInventory");
  });

  it("normalizes key arrays into SendKeys chords", () => {
    expect(normalizeSendKeys(["CTRL", "L"])).toBe("^l");
    expect(normalizeSendKeys(["ALT", "F4"])).toBe("%{F4}");
    expect(normalizeSendKeys("{ENTER}")).toBe("{ENTER}");
  });

  it("requires confirmation for risky key chords", async () => {
    const runtime = createWindowsDesktopMcpRuntime({
      platform: "win32",
      execCommand: vi.fn(),
    });
    const handlers = createWindowsDesktopMcpHandlers(runtime);

    await expect(
      handlers.callTool("press_keys", { keys: ["ALT", "F4"] }),
    ).rejects.toThrow("confirm=true");
  });

  it("speaks stdio MCP and lists tools without Windows actions", async () => {
    const mcp = await startMcpProcess();
    try {
      const init = await mcp.initialize();
      expect(init.result?.serverInfo?.name).toBe("windows-desktop-control");

      const tools = await mcp.listTools();
      const names = (tools.result?.tools || []).map((tool) => tool.name);
      expect(names).toContain("uia_invoke");
      expect(names).toContain("launch_app");
    } finally {
      await mcp.stop();
    }
  }, 15000);
});
