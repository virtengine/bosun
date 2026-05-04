#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify, format } from "node:util";
import { fileURLToPath } from "node:url";
import * as mcpServer from "@modelcontextprotocol/sdk/server/index.js";
import * as mcpStdio from "@modelcontextprotocol/sdk/server/stdio.js";
import * as mcpTypes from "@modelcontextprotocol/sdk/types.js";

const execFileAsync = promisify(execFile);
const Server = mcpServer.Server ?? mcpServer.default?.Server;
const StdioServerTransport =
  mcpStdio.StdioServerTransport ??
  mcpStdio.default?.StdioServerTransport;
const CallToolRequestSchema =
  mcpTypes.CallToolRequestSchema ??
  mcpTypes.default?.CallToolRequestSchema;
const ListToolsRequestSchema =
  mcpTypes.ListToolsRequestSchema ??
  mcpTypes.default?.ListToolsRequestSchema;

const DEFAULT_ALLOWED_APPS = ["notepad.exe", "calc.exe", "mspaint.exe", "explorer.exe"];
const SENDKEY_MODIFIERS = new Map([
  ["ALT", "%"],
  ["CTRL", "^"],
  ["CONTROL", "^"],
  ["SHIFT", "+"],
]);
const SENDKEY_SPECIALS = new Map([
  ["ENTER", "{ENTER}"],
  ["TAB", "{TAB}"],
  ["ESC", "{ESC}"],
  ["ESCAPE", "{ESC}"],
  ["UP", "{UP}"],
  ["DOWN", "{DOWN}"],
  ["LEFT", "{LEFT}"],
  ["RIGHT", "{RIGHT}"],
  ["DELETE", "{DELETE}"],
  ["BACKSPACE", "{BACKSPACE}"],
  ["HOME", "{HOME}"],
  ["END", "{END}"],
  ["PGUP", "{PGUP}"],
  ["PGDN", "{PGDN}"],
  ["F1", "{F1}"],
  ["F2", "{F2}"],
  ["F3", "{F3}"],
  ["F4", "{F4}"],
  ["F5", "{F5}"],
  ["F6", "{F6}"],
  ["F7", "{F7}"],
  ["F8", "{F8}"],
  ["F9", "{F9}"],
  ["F10", "{F10}"],
  ["F11", "{F11}"],
  ["F12", "{F12}"],
]);
const RISKY_SENDKEYS = [/%\{F4\}/i, /\^w/i, /\{DELETE\}/i, /\^\{DELETE\}/i];

function isMainModule() {
  const entry = process.argv[1] ? resolve(process.argv[1]) : "";
  return entry === fileURLToPath(import.meta.url);
}

function redirectConsoleToStderr() {
  const write = (...args) => {
    const text = format(...args);
    process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
  };
  console.log = (...args) => write(...args);
  console.info = (...args) => write(...args);
  console.warn = (...args) => write(...args);
  console.error = (...args) => write(...args);
}

function createToolResult(payload) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return {
    content: [{ type: "text", text }],
    structuredContent: payload,
  };
}

function psString(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function toCsvList(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || "").trim()).filter(Boolean);
  }
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function toBool(value) {
  if (typeof value === "boolean") return value;
  const raw = String(value || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj ?? {}, key);
}

function toInt(value, fallback = null) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function toHandle(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (/^0x[0-9a-f]+$/i.test(raw)) return Number.parseInt(raw.slice(2), 16);
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function normalizeSendKeys(keys) {
  if (!Array.isArray(keys)) {
    const raw = String(keys || "").trim();
    if (!raw) throw new Error("press_keys requires a non-empty keys value");
    return raw;
  }
  const tokens = keys.map((entry) => String(entry || "").trim()).filter(Boolean);
  if (tokens.length === 0) throw new Error("press_keys requires a non-empty keys value");
  const modifiers = [];
  let main = "";
  for (const token of tokens) {
    const upper = token.toUpperCase();
    if (SENDKEY_MODIFIERS.has(upper)) {
      modifiers.push(SENDKEY_MODIFIERS.get(upper));
      continue;
    }
    if (!main) {
      main = SENDKEY_SPECIALS.get(upper) || (token.length === 1 ? token.toLowerCase() : `{${upper}}`);
    }
  }
  if (!main) throw new Error("press_keys array must include at least one non-modifier key");
  return `${modifiers.join("")}${main}`;
}

function requireSafeKeys(args) {
  const sendKeys = normalizeSendKeys(args.keys);
  if (args?.confirm === true) return sendKeys;
  if (RISKY_SENDKEYS.some((pattern) => pattern.test(sendKeys))) {
    throw new Error("Potentially destructive key chord requires confirm=true");
  }
  return sendKeys;
}

function normalizeAllowedApps(value) {
  return new Set(
    [...DEFAULT_ALLOWED_APPS, ...toCsvList(value)].map((entry) => entry.toLowerCase()),
  );
}

function optionalBoolArg(args, key) {
  return hasOwn(args, key) ? toBool(args[key]) : null;
}

function parseDisplaySelection(args, prefix = "display") {
  return {
    id: toInt(args?.[`${prefix}Id`]),
    name: String(args?.[`${prefix}Name`] || "").trim(),
    primary: optionalBoolArg(args, `${prefix}Primary`) === true,
  };
}

function hasDisplaySelection(selection) {
  return selection.id != null || Boolean(selection.name) || selection.primary === true;
}

function displayHelpersPrelude() {
  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "function Convert-Rect($rect) { if ($null -eq $rect) { return $null }; return [pscustomobject]@{ x = [int][math]::Round($rect.X); y = [int][math]::Round($rect.Y); width = [int][math]::Round($rect.Width); height = [int][math]::Round($rect.Height) } }",
    "function Get-DisplayInventory { $index = 0; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { $display = [pscustomobject]@{ displayId = $index; deviceName = $_.DeviceName; isPrimary = [bool]$_.Primary; bounds = Convert-Rect $_.Bounds; workingArea = Convert-Rect $_.WorkingArea }; $index++; $display } }",
  ].join("\n");
}

function displaySelector(args, variableName = "$display", prefix = "display", options = {}) {
  const selection = parseDisplaySelection(args, prefix);
  const requireMatch = options.requireMatch === true || hasDisplaySelection(selection);
  const variableToken = variableName.startsWith("$") ? variableName : `$${variableName}`;
  const prefixToken = prefix.replace(/[^a-z0-9_]/gi, "");
  const idVar = `$${prefixToken}Id`;
  const nameVar = `$${prefixToken}Name`;
  const primaryVar = `$${prefixToken}Primary`;
  return {
    selection,
    script: [
      "$displayInventory = Get-DisplayInventory",
      `${idVar} = ${selection.id == null ? "$null" : selection.id}`,
      `${nameVar} = ${psString(selection.name)}`,
      `${primaryVar} = ${selection.primary === true ? "$true" : "$false"}`,
      `${variableToken} = $null`,
      `if ($null -ne ${idVar}) { ${variableToken} = $displayInventory | Where-Object { $_.displayId -eq ${idVar} } | Select-Object -First 1 }`,
      `elseif (-not [string]::IsNullOrWhiteSpace(${nameVar})) { ${variableToken} = $displayInventory | Where-Object { $_.deviceName -ieq ${nameVar} } | Select-Object -First 1 }`,
      `elseif (${primaryVar}) { ${variableToken} = $displayInventory | Where-Object { $_.isPrimary } | Select-Object -First 1 }`,
      requireMatch ? `if ($null -eq ${variableToken}) { throw 'No matching display found.' }` : "",
    ].filter(Boolean).join("\n"),
  };
}

function pointResolutionScript(args, xField = "x", yField = "y", options = {}) {
  const x = toInt(args?.[xField]);
  const y = toInt(args?.[yField]);
  if (x == null || y == null) {
    throw new Error(`${options.actionName || "point"} requires numeric ${xField} and ${yField}`);
  }
  const displayRelative = optionalBoolArg(args, "displayRelative") === true;
  const selector = displaySelector(args, "$display", options.displayPrefix || "display", {
    requireMatch: displayRelative,
  });
  return {
    script: [
      displayHelpersPrelude(),
      selector.script,
      "$baseX = 0",
      "$baseY = 0",
      displayRelative ? "if ($null -eq $display) { throw 'displayRelative requires a matching display.' }" : "",
      displayRelative ? "$baseX = [int]$display.bounds.x" : "",
      displayRelative ? "$baseY = [int]$display.bounds.y" : "",
      `$targetX = $baseX + ${x}`,
      `$targetY = $baseY + ${y}`,
    ].filter(Boolean).join("\n"),
    selection: selector.selection,
    displayRelative,
    x,
    y,
  };
}

function windowSelector(args, variableName = "$window") {
  const processId = toInt(args.processId);
  const processName = String(args.processName || "").trim();
  const titleContains = String(args.titleContains || "").trim();
  const handle = toHandle(args.handle);
  const lines = [
    "$windows = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle) }",
  ];
  if (processId != null) {
    lines.push(`${variableName} = Get-Process -Id ${processId} -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1`);
  } else {
    if (processName) {
      lines.push(`$windows = $windows | Where-Object { $_.ProcessName -ieq ${psString(processName)} }`);
    }
    if (titleContains) {
      lines.push(`$windows = $windows | Where-Object { $_.MainWindowTitle -like ${psString(`*${titleContains}*`)} }`);
    }
    if (handle != null) {
      lines.push(`$windows = $windows | Where-Object { [Int64]$_.MainWindowHandle -eq ${handle} }`);
    }
    lines.push(`${variableName} = $windows | Select-Object -First 1`);
  }
  lines.push(`if ($null -eq ${variableName}) { throw 'No matching window found.' }`);
  return lines.join("\n");
}

function focusPrelude(args) {
  const hasTarget = toInt(args.processId) != null
    || Boolean(String(args.processName || "").trim())
    || Boolean(String(args.titleContains || "").trim())
    || toHandle(args.handle) != null;
  if (!hasTarget) return "";
  return [
    "Add-Type -AssemblyName Microsoft.VisualBasic",
    windowSelector(args, "$window"),
    "$null = [Microsoft.VisualBasic.Interaction]::AppActivate($window.Id)",
    "Start-Sleep -Milliseconds 80",
  ].join("\n");
}

function automationRoot(args, variableName = "$root") {
  const hasTarget = toInt(args.processId) != null
    || Boolean(String(args.processName || "").trim())
    || Boolean(String(args.titleContains || "").trim())
    || toHandle(args.handle) != null;
  if (!hasTarget) {
    return [
      `${variableName} = [System.Windows.Automation.AutomationElement]::FocusedElement`,
      `if ($null -eq ${variableName}) { throw 'No focused automation element was available.' }`,
    ].join("\n");
  }
  return [
    windowSelector(args, "$window"),
    `${variableName} = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]([Int64]$window.MainWindowHandle))`,
    `if ($null -eq ${variableName}) { throw 'Could not resolve automation root.' }`,
  ].join("\n");
}

function mouseInterop() {
  return [
    "Add-Type @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class Win32Mouse {",
    "  [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x, int y);",
    "  [DllImport(\"user32.dll\")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);",
    "}",
    "'@",
  ].join("\n");
}

function windowInterop() {
  return [
    "Add-Type @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "[StructLayout(LayoutKind.Sequential)]",
    "public struct RECT {",
    "  public int Left;",
    "  public int Top;",
    "  public int Right;",
    "  public int Bottom;",
    "}",
    "public static class Win32Window {",
    "  [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hwnd);",
    "  [DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr hwnd, int cmd);",
    "  [DllImport(\"user32.dll\", SetLastError=true)] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);",
    "  [DllImport(\"user32.dll\", SetLastError=true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);",
    "}",
    "'@",
  ].join("\n");
}

async function defaultExec(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    const stdout = error?.stdout ? `\nstdout:\n${error.stdout}` : "";
    const stderr = error?.stderr ? `\nstderr:\n${error.stderr}` : "";
    throw new Error(`${error?.message || `Failed to run ${command}`}${stdout}${stderr}`);
  }
}

export function createWindowsDesktopMcpRuntime(options = {}) {
  return {
    platform: String(options.platform || process.platform),
    screenshotDir: resolve(String(options.screenshotDir || process.env.WINDOWS_DESKTOP_SCREENSHOT_DIR || resolve(tmpdir(), "codex-windows-desktop-control"))),
    allowUnsafe: toBool(options.allowUnsafe ?? process.env.WINDOWS_DESKTOP_ALLOW_UNSAFE),
    allowedApps: normalizeAllowedApps(options.allowedApps ?? process.env.WINDOWS_DESKTOP_ALLOWED_APPS),
    execCommand: options.execCommand || defaultExec,

    ensureWindows(actionName) {
      if (this.platform !== "win32") {
        throw new Error(`${actionName} is only supported on Windows. Current platform: ${this.platform}`);
      }
    },

    ensureApplicationAllowed(application) {
      if (this.allowUnsafe) return;
      const label = basename(String(application || "").trim()).toLowerCase();
      if (!this.allowedApps.has(label)) {
        throw new Error(`launch_app blocked for ${label}. Add it to WINDOWS_DESKTOP_ALLOWED_APPS or set WINDOWS_DESKTOP_ALLOW_UNSAFE=1.`);
      }
    },

    async runPowerShellJson(actionName, script) {
      this.ensureWindows(actionName);
      const { stdout } = await this.execCommand("powershell", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ]);
      const text = String(stdout || "").trim();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`PowerShell for ${actionName} returned non-JSON output: ${text}`);
      }
    },
  };
}

export function listWindowsDesktopMcpTools() {
  return [
    { name: "list_displays", description: "List attached Windows displays and the combined virtual desktop bounds.", inputSchema: { type: "object", properties: {} } },
    { name: "screenshot", description: "Capture a display, the full virtual desktop, or a region screenshot on Windows.", inputSchema: { type: "object", properties: { outputPath: { type: "string" }, x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" }, virtualScreen: { type: "boolean" }, displayId: { type: "number" }, displayName: { type: "string" }, displayPrimary: { type: "boolean" }, displayRelative: { type: "boolean" } } } },
    { name: "list_windows", description: "List visible top-level windows on the local Windows desktop, including bounds and owning display.", inputSchema: { type: "object", properties: {} } },
    { name: "focus_window", description: "Focus a window by process id, process name, title match, or handle.", inputSchema: { type: "object", properties: { processId: { type: "number" }, processName: { type: "string" }, titleContains: { type: "string" }, handle: { type: "string" } } } },
    { name: "move_window", description: "Move or resize a top-level window, including onto a specific display.", inputSchema: { type: "object", properties: { processId: { type: "number" }, processName: { type: "string" }, titleContains: { type: "string" }, handle: { type: "string" }, x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" }, displayId: { type: "number" }, displayName: { type: "string" }, displayPrimary: { type: "boolean" }, displayRelative: { type: "boolean" }, fitToDisplay: { type: "boolean" }, useWorkingArea: { type: "boolean" }, activate: { type: "boolean" } } } },
    { name: "click", description: "Click at screen coordinates. Use displayRelative with displayId/displayName for monitor-local coordinates.", inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, displayId: { type: "number" }, displayName: { type: "string" }, displayPrimary: { type: "boolean" }, displayRelative: { type: "boolean" } }, required: ["x", "y"] } },
    { name: "double_click", description: "Double-click at screen coordinates. Use displayRelative with displayId/displayName for monitor-local coordinates.", inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, displayId: { type: "number" }, displayName: { type: "string" }, displayPrimary: { type: "boolean" }, displayRelative: { type: "boolean" } }, required: ["x", "y"] } },
    { name: "type_text", description: "Type text using clipboard paste with clipboard restore.", inputSchema: { type: "object", properties: { text: { type: "string" }, processId: { type: "number" }, processName: { type: "string" }, titleContains: { type: "string" }, handle: { type: "string" } }, required: ["text"] } },
    { name: "press_keys", description: "Send key chords using SendKeys syntax or a token array.", inputSchema: { type: "object", properties: { keys: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] }, confirm: { type: "boolean" }, processId: { type: "number" }, processName: { type: "string" }, titleContains: { type: "string" }, handle: { type: "string" } }, required: ["keys"] } },
    { name: "scroll", description: "Scroll the mouse wheel vertically at the current cursor or target coordinates.", inputSchema: { type: "object", properties: { delta: { type: "number" }, x: { type: "number" }, y: { type: "number" }, displayId: { type: "number" }, displayName: { type: "string" }, displayPrimary: { type: "boolean" }, displayRelative: { type: "boolean" } } } },
    { name: "drag", description: "Drag from one screen coordinate to another.", inputSchema: { type: "object", properties: { fromX: { type: "number" }, fromY: { type: "number" }, toX: { type: "number" }, toY: { type: "number" }, steps: { type: "number" }, displayId: { type: "number" }, displayName: { type: "string" }, displayPrimary: { type: "boolean" }, displayRelative: { type: "boolean" } }, required: ["fromX", "fromY", "toX", "toY"] } },
    { name: "launch_app", description: "Launch an allowlisted Windows application.", inputSchema: { type: "object", properties: { application: { type: "string" }, args: { type: "array", items: { type: "string" } }, workingDirectory: { type: "string" } }, required: ["application"] } },
    { name: "uia_inspect", description: "Inspect a UI Automation tree for the focused app or a specific top-level window.", inputSchema: { type: "object", properties: { processId: { type: "number" }, processName: { type: "string" }, titleContains: { type: "string" }, handle: { type: "string" }, maxDepth: { type: "number" }, maxChildren: { type: "number" } } } },
    { name: "uia_invoke", description: "Invoke a UI Automation element by automation id, name, or control type.", inputSchema: { type: "object", properties: { automationId: { type: "string" }, name: { type: "string" }, controlType: { type: "string" }, action: { type: "string" }, destructive: { type: "boolean" }, confirm: { type: "boolean" }, processId: { type: "number" }, processName: { type: "string" }, titleContains: { type: "string" }, handle: { type: "string" }, maxDepth: { type: "number" } } } },
  ];
}

const TOOL_HANDLERS = {
  async list_displays(runtime) {
    return runtime.runPowerShellJson("list_displays", [
      displayHelpersPrelude(),
      "$displayInventory = Get-DisplayInventory",
      "$virtual = Convert-Rect ([System.Windows.SystemInformation]::VirtualScreen)",
      "[pscustomobject]@{ displayCount = $displayInventory.Count; virtualScreen = $virtual; displays = $displayInventory } | ConvertTo-Json -Depth 8 -Compress",
    ].join("\n"));
  },

  async screenshot(runtime, args) {
    const outputPath = resolve(String(args.outputPath || resolve(runtime.screenshotDir, `desktop-${Date.now()}.png`)));
    await mkdir(dirname(outputPath), { recursive: true });
    const x = toInt(args.x);
    const y = toInt(args.y);
    const width = toInt(args.width);
    const height = toInt(args.height);
    const regionValues = [x, y, width, height];
    const region = regionValues.every((value) => value != null);
    const partialRegion = regionValues.some((value) => value != null) && !region;
    if (partialRegion) {
      throw new Error("screenshot region capture requires x, y, width, and height together");
    }
    const selector = displaySelector(args, "$display");
    const displayRelative = optionalBoolArg(args, "displayRelative") === true;
    const virtualScreen = optionalBoolArg(args, "virtualScreen") === true;
    return runtime.runPowerShellJson("screenshot", [
      displayHelpersPrelude(),
      `$out = ${psString(outputPath)}`,
      selector.script,
      "$virtual = Convert-Rect ([System.Windows.SystemInformation]::VirtualScreen)",
      displayRelative ? "if ($null -eq $display) { throw 'displayRelative requires a matching display.' }" : "",
      region
        ? [
          `$regionX = ${x}`,
          `$regionY = ${y}`,
          `$regionWidth = ${width}`,
          `$regionHeight = ${height}`,
          "$originX = 0",
          "$originY = 0",
          displayRelative ? "$originX = [int]$display.bounds.x" : "",
          displayRelative ? "$originY = [int]$display.bounds.y" : "",
          "$bounds = New-Object System.Drawing.Rectangle(($originX + $regionX), ($originY + $regionY), $regionWidth, $regionHeight)",
        ].filter(Boolean).join("\n")
        : virtualScreen
          ? "$bounds = New-Object System.Drawing.Rectangle($virtual.x, $virtual.y, $virtual.width, $virtual.height)"
          : "$bounds = if ($null -ne $display) { New-Object System.Drawing.Rectangle($display.bounds.x, $display.bounds.y, $display.bounds.width, $display.bounds.height) } else { [System.Windows.Forms.Screen]::PrimaryScreen.Bounds }",
      "$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height",
      "$gfx = [System.Drawing.Graphics]::FromImage($bmp)",
      "try { $gfx.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bounds.Size); $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $gfx.Dispose(); $bmp.Dispose() }",
      "[pscustomobject]@{ path = $out; x = $bounds.X; y = $bounds.Y; width = $bounds.Width; height = $bounds.Height; display = $display; virtualScreen = $virtual } | ConvertTo-Json -Depth 8 -Compress",
    ].join("\n"));
  },

  async list_windows(runtime) {
    return runtime.runPowerShellJson("list_windows", [
      displayHelpersPrelude(),
      "$displayInventory = Get-DisplayInventory",
      windowInterop(),
      "$windows = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle) } | Sort-Object ProcessName, MainWindowTitle",
      "$windows | ForEach-Object { $rect = New-Object RECT; $bounds = $null; if ([Win32Window]::GetWindowRect([IntPtr]([Int64]$_.MainWindowHandle), [ref]$rect)) { $bounds = [pscustomobject]@{ x = $rect.Left; y = $rect.Top; width = ($rect.Right - $rect.Left); height = ($rect.Bottom - $rect.Top) } }; $screen = [System.Windows.Forms.Screen]::FromHandle([IntPtr]([Int64]$_.MainWindowHandle)); $display = $null; if ($screen) { $display = $displayInventory | Where-Object { $_.deviceName -ieq $screen.DeviceName } | Select-Object -First 1 }; [pscustomobject]@{ processId = $_.Id; processName = $_.ProcessName; title = $_.MainWindowTitle; handle = ('0x{0:X}' -f [Int64]$_.MainWindowHandle); bounds = $bounds; display = $display } } | ConvertTo-Json -Depth 8 -Compress",
    ].join("\n"));
  },

  async focus_window(runtime, args) {
    return runtime.runPowerShellJson("focus_window", [
      windowInterop(),
      "Add-Type -AssemblyName Microsoft.VisualBasic",
      windowSelector(args, "$window"),
      "$null = [Microsoft.VisualBasic.Interaction]::AppActivate($window.Id)",
      "Start-Sleep -Milliseconds 80",
      "$null = [Win32Window]::ShowWindowAsync([IntPtr]([Int64]$window.MainWindowHandle), 5)",
      "$ok = [Win32Window]::SetForegroundWindow([IntPtr]([Int64]$window.MainWindowHandle))",
      "[pscustomobject]@{ success = [bool]$ok; processId = $window.Id; processName = $window.ProcessName; title = $window.MainWindowTitle; handle = '0x{0:X}' -f [Int64]$window.MainWindowHandle } | ConvertTo-Json -Depth 4 -Compress",
    ].join("\n"));
  },

  async move_window(runtime, args) {
    const x = toInt(args.x);
    const y = toInt(args.y);
    const width = toInt(args.width);
    const height = toInt(args.height);
    const fitToDisplay = optionalBoolArg(args, "fitToDisplay") === true;
    const useWorkingArea = optionalBoolArg(args, "useWorkingArea");
    const activate = optionalBoolArg(args, "activate") === true;
    const selector = displaySelector(args, "$display");
    const displayRelative = optionalBoolArg(args, "displayRelative");
    return runtime.runPowerShellJson("move_window", [
      displayHelpersPrelude(),
      windowInterop(),
      windowSelector(args, "$window"),
      selector.script,
      "$rect = New-Object RECT",
      "if (-not [Win32Window]::GetWindowRect([IntPtr]([Int64]$window.MainWindowHandle), [ref]$rect)) { throw 'Could not read current window bounds.' }",
      "$currentWidth = $rect.Right - $rect.Left",
      "$currentHeight = $rect.Bottom - $rect.Top",
      `$useWorkingArea = ${useWorkingArea === false ? "$false" : "$true"}`,
      `$fitToDisplay = ${fitToDisplay ? "$true" : "$false"}`,
      `$relativeToDisplay = ${displayRelative == null ? "$null" : displayRelative ? "$true" : "$false"}`,
      "if ($null -eq $relativeToDisplay) { $relativeToDisplay = $null -ne $display }",
      "if ($relativeToDisplay -and $null -eq $display) { throw 'displayRelative requires a matching display.' }",
      "$targetArea = $null",
      "if ($null -ne $display) { $targetArea = if ($useWorkingArea) { $display.workingArea } else { $display.bounds } }",
      fitToDisplay ? "$targetX = [int]$targetArea.x" : `$targetX = if ($fitToDisplay -and $null -ne $targetArea) { [int]$targetArea.x } elseif ($relativeToDisplay -and $null -ne $targetArea -and ${x == null ? "$false" : "$true"}) { [int]$targetArea.x + ${x == null ? 0 : x} } elseif (${x == null ? "$false" : "$true"}) { ${x == null ? 0 : x} } elseif ($null -ne $targetArea) { [int]$targetArea.x } else { [int]$rect.Left }`,
      fitToDisplay ? "$targetY = [int]$targetArea.y" : `$targetY = if ($fitToDisplay -and $null -ne $targetArea) { [int]$targetArea.y } elseif ($relativeToDisplay -and $null -ne $targetArea -and ${y == null ? "$false" : "$true"}) { [int]$targetArea.y + ${y == null ? 0 : y} } elseif (${y == null ? "$false" : "$true"}) { ${y == null ? 0 : y} } elseif ($null -ne $targetArea) { [int]$targetArea.y } else { [int]$rect.Top }`,
      fitToDisplay ? "$targetWidth = [int]$targetArea.width" : `$targetWidth = if ($fitToDisplay -and $null -ne $targetArea) { [int]$targetArea.width } elseif (${width == null ? "$false" : "$true"}) { ${width == null ? 0 : width} } else { [int]$currentWidth }`,
      fitToDisplay ? "$targetHeight = [int]$targetArea.height" : `$targetHeight = if ($fitToDisplay -and $null -ne $targetArea) { [int]$targetArea.height } elseif (${height == null ? "$false" : "$true"}) { ${height == null ? 0 : height} } else { [int]$currentHeight }`,
      "if ($targetWidth -lt 1 -or $targetHeight -lt 1) { throw 'move_window requires a positive width and height after resolution.' }",
      "$flags = 0x0004 -bor 0x0040",
      activate ? "" : "$flags = $flags -bor 0x0010",
      "$ok = [Win32Window]::SetWindowPos([IntPtr]([Int64]$window.MainWindowHandle), [IntPtr]::Zero, $targetX, $targetY, $targetWidth, $targetHeight, [uint32]$flags)",
      "if (-not $ok) { throw 'SetWindowPos failed.' }",
      "[pscustomobject]@{ success = $true; processId = $window.Id; processName = $window.ProcessName; title = $window.MainWindowTitle; handle = ('0x{0:X}' -f [Int64]$window.MainWindowHandle); x = $targetX; y = $targetY; width = $targetWidth; height = $targetHeight; display = $display; fitToDisplay = $fitToDisplay } | ConvertTo-Json -Depth 8 -Compress",
    ].filter(Boolean).join("\n"));
  },

  async click(runtime, args) {
    const point = pointResolutionScript(args, "x", "y", { actionName: "click" });
    return runtime.runPowerShellJson("click", [
      point.script,
      mouseInterop(),
      "[Win32Mouse]::SetCursorPos($targetX, $targetY) | Out-Null",
      "[Win32Mouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)",
      "Start-Sleep -Milliseconds 35",
      "[Win32Mouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)",
      "[pscustomobject]@{ success = $true; x = $targetX; y = $targetY; clicks = 1; displayRelative = $null } | ConvertTo-Json -Depth 4 -Compress",
    ].join("\n"));
  },

  async double_click(runtime, args) {
    const point = pointResolutionScript(args, "x", "y", { actionName: "double_click" });
    return runtime.runPowerShellJson("double_click", [
      point.script,
      mouseInterop(),
      "[Win32Mouse]::SetCursorPos($targetX, $targetY) | Out-Null",
      "for ($i = 0; $i -lt 2; $i++) { [Win32Mouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 30; [Win32Mouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 50 }",
      "[pscustomobject]@{ success = $true; x = $targetX; y = $targetY; clicks = 2 } | ConvertTo-Json -Depth 4 -Compress",
    ].join("\n"));
  },

  async type_text(runtime, args) {
    const text = String(args.text || "");
    if (!text) throw new Error("type_text requires non-empty text");
    return runtime.runPowerShellJson("type_text", [
      focusPrelude(args),
      "Add-Type -AssemblyName System.Windows.Forms",
      "$hadClipboard = $true",
      "$previousClipboard = $null",
      "try { $previousClipboard = Get-Clipboard -Raw -ErrorAction Stop } catch { $hadClipboard = $false }",
      `$text = ${psString(text)}`,
      "Set-Clipboard -Value $text",
      "[System.Windows.Forms.SendKeys]::SendWait('^v')",
      "Start-Sleep -Milliseconds 60",
      "if ($hadClipboard) { Set-Clipboard -Value $previousClipboard }",
      "[pscustomobject]@{ success = $true; textLength = $text.Length; method = 'clipboard-paste' } | ConvertTo-Json -Depth 4 -Compress",
    ].filter(Boolean).join("\n"));
  },

  async press_keys(runtime, args) {
    const sendKeys = requireSafeKeys(args);
    return runtime.runPowerShellJson("press_keys", [
      focusPrelude(args),
      "Add-Type -AssemblyName System.Windows.Forms",
      `[System.Windows.Forms.SendKeys]::SendWait(${psString(sendKeys)})`,
      "Start-Sleep -Milliseconds 60",
      `[pscustomobject]@{ success = $true; sendKeys = ${psString(sendKeys)} } | ConvertTo-Json -Depth 4 -Compress`,
    ].filter(Boolean).join("\n"));
  },

  async scroll(runtime, args) {
    const delta = toInt(args.delta, -120);
    const hasPoint = toInt(args.x) != null || toInt(args.y) != null;
    const point = hasPoint ? pointResolutionScript(args, "x", "y", { actionName: "scroll" }) : null;
    return runtime.runPowerShellJson("scroll", [
      point?.script || "",
      mouseInterop(),
      point ? "[Win32Mouse]::SetCursorPos($targetX, $targetY) | Out-Null" : "",
      `[Win32Mouse]::mouse_event(0x0800, 0, 0, ${delta}, [UIntPtr]::Zero)`,
      `[pscustomobject]@{ success = $true; delta = ${delta}; x = ${point ? "$targetX" : "$null"}; y = ${point ? "$targetY" : "$null"} } | ConvertTo-Json -Depth 4 -Compress`,
    ].filter(Boolean).join("\n"));
  },

  async drag(runtime, args) {
    const fromX = toInt(args.fromX);
    const fromY = toInt(args.fromY);
    const toX = toInt(args.toX);
    const toY = toInt(args.toY);
    const steps = Math.max(2, toInt(args.steps, 20));
    if ([fromX, fromY, toX, toY].some((value) => value == null)) {
      throw new Error("drag requires numeric fromX, fromY, toX, and toY");
    }
    const selector = displaySelector(args, "$display", "display", {
      requireMatch: optionalBoolArg(args, "displayRelative") === true,
    });
    const displayRelative = optionalBoolArg(args, "displayRelative") === true;
    return runtime.runPowerShellJson("drag", [
      displayHelpersPrelude(),
      selector.script,
      displayRelative ? "if ($null -eq $display) { throw 'displayRelative requires a matching display.' }" : "",
      displayRelative ? `$fromTargetX = [int]$display.bounds.x + ${fromX}` : `$fromTargetX = ${fromX}`,
      displayRelative ? `$fromTargetY = [int]$display.bounds.y + ${fromY}` : `$fromTargetY = ${fromY}`,
      displayRelative ? `$toTargetX = [int]$display.bounds.x + ${toX}` : `$toTargetX = ${toX}`,
      displayRelative ? `$toTargetY = [int]$display.bounds.y + ${toY}` : `$toTargetY = ${toY}`,
      mouseInterop(),
      "[Win32Mouse]::SetCursorPos($fromTargetX, $fromTargetY) | Out-Null",
      "Start-Sleep -Milliseconds 40",
      "[Win32Mouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)",
      `for ($i = 1; $i -le ${steps}; $i++) { $x = [int]($fromTargetX + (($toTargetX - $fromTargetX) * $i / ${steps})); $y = [int]($fromTargetY + (($toTargetY - $fromTargetY) * $i / ${steps})); [Win32Mouse]::SetCursorPos($x, $y) | Out-Null; Start-Sleep -Milliseconds 12 }`,
      "[Win32Mouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)",
      `[pscustomobject]@{ success = $true; fromX = $fromTargetX; fromY = $fromTargetY; toX = $toTargetX; toY = $toTargetY; steps = ${steps} } | ConvertTo-Json -Depth 4 -Compress`,
    ].join("\n"));
  },

  async launch_app(runtime, args) {
    const application = String(args.application || "").trim();
    if (!application) throw new Error("launch_app requires application");
    runtime.ensureApplicationAllowed(application);
    const argList = Array.isArray(args.args) ? args.args.map((entry) => psString(entry)).join(", ") : "";
    const workingDirectory = String(args.workingDirectory || "").trim();
    return runtime.runPowerShellJson("launch_app", [
      `$app = ${psString(application)}`,
      argList ? `$argList = @(${argList})` : "$argList = @()",
      workingDirectory ? `$cwd = ${psString(resolve(workingDirectory))}` : "$cwd = $null",
      "$start = @{ FilePath = $app; PassThru = $true }",
      "if ($argList.Count -gt 0) { $start.ArgumentList = $argList }",
      "if ($cwd) { $start.WorkingDirectory = $cwd }",
      "$process = Start-Process @start",
      "Start-Sleep -Milliseconds 120",
      "[pscustomobject]@{ processId = $process.Id; processName = $process.ProcessName; application = $app; allowlisted = $true } | ConvertTo-Json -Depth 4 -Compress",
    ].join("\n"));
  },

  async uia_inspect(runtime, args) {
    const maxDepth = Math.max(0, toInt(args.maxDepth, 2));
    const maxChildren = Math.max(1, toInt(args.maxChildren, 25));
    return runtime.runPowerShellJson("uia_inspect", [
      "Add-Type -AssemblyName UIAutomationClient",
      "Add-Type -AssemblyName UIAutomationTypes",
      automationRoot(args, "$root"),
      "function Convert-Rect($rect) { if ($rect -eq [System.Windows.Rect]::Empty) { return $null }; return [pscustomobject]@{ x = [math]::Round($rect.X, 2); y = [math]::Round($rect.Y, 2); width = [math]::Round($rect.Width, 2); height = [math]::Round($rect.Height, 2) } }",
      "function Convert-Element($element, $depth, $maxDepth, $maxChildren) { if ($null -eq $element) { return $null }; $current = $element.Current; $result = [ordered]@{ name = $current.Name; automationId = $current.AutomationId; className = $current.ClassName; controlType = $current.LocalizedControlType; isEnabled = $current.IsEnabled; hasKeyboardFocus = $current.HasKeyboardFocus; boundingRectangle = Convert-Rect $current.BoundingRectangle }; if ($depth -lt $maxDepth) { $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker; $children = @(); $child = $walker.GetFirstChild($element); $count = 0; while ($child -and $count -lt $maxChildren) { $children += ,(Convert-Element $child ($depth + 1) $maxDepth $maxChildren); $child = $walker.GetNextSibling($child); $count++ }; $result.children = $children }; return [pscustomobject]$result }",
      `Convert-Element $root 0 ${maxDepth} ${maxChildren} | ConvertTo-Json -Depth 14 -Compress`,
    ].join("\n"));
  },

  async uia_invoke(runtime, args) {
    if (args?.destructive === true && args?.confirm !== true) {
      throw new Error("uia_invoke marked destructive requires confirm=true");
    }
    const automationId = String(args.automationId || "").trim();
    const name = String(args.name || "").trim();
    const controlType = String(args.controlType || "").trim().toLowerCase();
    const action = String(args.action || "invoke").trim().toLowerCase();
    const maxDepth = Math.max(0, toInt(args.maxDepth, 6));
    if (!automationId && !name && !controlType) {
      throw new Error("uia_invoke requires automationId, name, or controlType");
    }
    return runtime.runPowerShellJson("uia_invoke", [
      "Add-Type -AssemblyName UIAutomationClient",
      "Add-Type -AssemblyName UIAutomationTypes",
      automationRoot(args, "$root"),
      `$targetAutomationId = ${psString(automationId)}`,
      `$targetName = ${psString(name)}`,
      `$targetControlType = ${psString(controlType)}`,
      `$action = ${psString(action)}`,
      "function Matches-Element($element) { if ($null -eq $element) { return $false }; $current = $element.Current; $localizedType = [string]$current.LocalizedControlType; if ($targetAutomationId -and $current.AutomationId -ne $targetAutomationId) { return $false }; if ($targetName -and $current.Name -ne $targetName) { return $false }; if ($targetControlType -and $localizedType.ToLowerInvariant() -ne $targetControlType) { return $false }; return $true }",
      "function Find-Element($element, $depth) { if ($null -eq $element -or $depth -gt $script:maxDepth) { return $null }; if (Matches-Element $element) { return $element }; $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker; $child = $walker.GetFirstChild($element); while ($child) { $match = Find-Element $child ($depth + 1); if ($match) { return $match }; $child = $walker.GetNextSibling($child) }; return $null }",
      `$script:maxDepth = ${maxDepth}`,
      "$target = Find-Element $root 0",
      "if ($null -eq $target) { throw 'No matching automation element found.' }",
      "$current = $target.Current",
      "$patternUsed = $null",
      "$invokePattern = $null",
      "$selectionPattern = $null",
      "$expandPattern = $null",
      "if ($action -eq 'invoke' -and $target.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invokePattern)) { $invokePattern.Invoke(); $patternUsed = 'InvokePattern' } elseif ($action -eq 'select' -and $target.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selectionPattern)) { $selectionPattern.Select(); $patternUsed = 'SelectionItemPattern' } elseif (($action -eq 'expand' -or $action -eq 'collapse') -and $target.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$expandPattern)) { if ($action -eq 'expand') { $expandPattern.Expand() } else { $expandPattern.Collapse() }; $patternUsed = 'ExpandCollapsePattern' } else { throw ('No supported automation pattern found for action ' + $action) }",
      "[pscustomobject]@{ success = $true; action = $action; patternUsed = $patternUsed; name = $current.Name; automationId = $current.AutomationId; controlType = $current.LocalizedControlType } | ConvertTo-Json -Depth 4 -Compress",
    ].join("\n"));
  },
};

async function invokeTool(runtime, name, args = {}) {
  const handler = TOOL_HANDLERS[name];
  if (!handler) throw new Error(`Unknown Windows desktop MCP tool: ${name}`);
  return handler(runtime, args);
}

export function createWindowsDesktopMcpHandlers(runtime) {
  return {
    listTools() {
      return { tools: listWindowsDesktopMcpTools() };
    },

    async callTool(name, args = {}) {
      const payload = await invokeTool(runtime, name, args);
      return createToolResult(payload);
    },
  };
}

export async function startWindowsDesktopMcpServer(options = {}) {
  const runtime = createWindowsDesktopMcpRuntime(options);
  const handlers = createWindowsDesktopMcpHandlers(runtime);
  const server = new Server(
    { name: "windows-desktop-control", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => handlers.listTools());
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = String(request.params?.name || "").trim();
    return handlers.callTool(name, request.params?.arguments || {});
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { server, transport, runtime };
}

async function main() {
  redirectConsoleToStderr();
  await startWindowsDesktopMcpServer();
}

if (isMainModule()) {
  try {
    await main();
  } catch (error) {
    console.error(`[windows-desktop-mcp] failed to start: ${error?.stack || error?.message || error}`);
    process.exit(1);
  }
}

export { normalizeSendKeys };
