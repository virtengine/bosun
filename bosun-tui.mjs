#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import loadConfig from "./config/config.mjs";
import {
  clearRemoteConnectionConfig,
  defaultConfigDir,
  normalizeHttpProtocol,
  readRemoteConnectionConfig,
  resolveTuiConnectionTarget,
  saveRemoteConnectionConfig,
  upsertRemoteConnection,
} from "./tui/lib/connection-target.mjs";

const MIN_COLUMNS = 120;
const MIN_ROWS = 30;


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function showHelp() {
  const version = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")).version;
  console.log(`
  bosun-tui v${version}
  Terminal UI for Bosun

  USAGE
    bosun tui [options]
    node bosun-tui.mjs [options]

  OPTIONS
    --endpoint <url>    Connect to an existing Bosun server (example: https://host:4400)
    --host <host>       WebSocket host (default: 127.0.0.1)
    --port <n>          WebSocket/UI port (default: configured local backend, TELEGRAM_UI_PORT, or 3080 fallback)
    --protocol <proto>  Connection protocol (ws|wss|http|https)
    --api-key <key>     API key for remote/existing Bosun server (BOSUN_API_KEY)
    --save-connection   Persist endpoint + API key to remote-connection.json
    --clear-connection  Clear the saved remote connection target
    --screen <name>     Initial screen (agents|tasks|logs|workflows|telemetry|settings|help)
    --help              Show this help
    --version           Show version
  `);
}

function getArgValue(args, flag, defaultValue = "") {
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1).trim();
  const index = args.indexOf(flag);
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith("--")) {
    return args[index + 1].trim();
  }
  return defaultValue;
}

function hasFlag(args, ...flags) {
  return flags.some((flag) => args.includes(flag));
}

function getTerminalSize(stdout = process.stdout) {
  return {
    columns: Math.max(0, Number(stdout?.columns || 0)),
    rows: Math.max(0, Number(stdout?.rows || 0)),
  };
}

function resolvePort(config) {
  return Number(process.env.TELEGRAM_UI_PORT || process.env.BOSUN_PORT || config?.telegramUiPort || "3080") || 3080;
}

function renderApp(instance, React, App, props) {
  instance.rerender(React.createElement(App, props));
}

export async function runBosunTui(argv = process.argv.slice(2), options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const args = Array.isArray(argv) ? argv : [];

  if (hasFlag(args, "--help", "-h")) {
    showHelp();
    return 0;
  }

  if (hasFlag(args, "--version", "-v")) {
    const version = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")).version;
    console.log(`bosun-tui v${version}`);
    return 0;
  }

  if (!stdout?.isTTY) {
    stderr.write("[bosun-tui] Error: stdout is not a TTY. Run `bosun tui` in an interactive terminal.\n");
    return 1;
  }

  globalThis.WebSocket = globalThis.WebSocket || (await import("ws")).WebSocket;

  const config = loadConfig([process.argv[0], __filename, ...args]);
  const configDir = String(config?.configDir || process.env.BOSUN_DIR || defaultConfigDir()).trim();
  if (hasFlag(args, "--clear-connection")) {
    clearRemoteConnectionConfig(configDir);
    stdout.write(`[bosun-tui] Cleared saved remote connection in ${configDir}\\remote-connection.json\n`);
    return 0;
  }

  const explicitEndpoint = getArgValue(args, "--endpoint", "");
  const explicitHost = getArgValue(args, "--host", "");
  const explicitPort = Number(getArgValue(args, "--port", "")) || 0;
  const explicitProtocol = getArgValue(args, "--protocol", "");
  const explicitApiKey = getArgValue(args, "--api-key", String(process.env.BOSUN_API_KEY || "").trim());
  const target = resolveTuiConnectionTarget({
    configDir,
    config,
    env: process.env,
    endpoint: explicitEndpoint,
    host: explicitHost,
    port: explicitPort,
    protocol: explicitProtocol,
    apiKey: explicitApiKey,
  });

  if (hasFlag(args, "--save-connection")) {
    const remoteEndpoint = explicitEndpoint
      || `${normalizeHttpProtocol(target.protocol)}://${target.host}:${target.port}`;
    const nextConfig = upsertRemoteConnection(readRemoteConnectionConfig(configDir), {
      name: remoteEndpoint,
      endpoint: remoteEndpoint,
      apiKey: target.apiKey || explicitApiKey,
      enabled: true,
    });
    saveRemoteConnectionConfig(nextConfig, configDir);
    stdout.write(`[bosun-tui] Saved remote connection target ${remoteEndpoint}\n`);
  }

  const host = target.host || "127.0.0.1";
  const port = Number(target.port || resolvePort(config)) || resolvePort(config);
  const protocol = target.protocol || "ws";
  const apiKey = target.apiKey || "";
  const initialScreen = getArgValue(args, "--screen", "agents");

  const React = await import("react");
  const ink = await import("ink");
  const { default: App } = await import("./tui/app.mjs");

  let terminalSize = getTerminalSize(stdout);
  const props = {
    config,
    configDir,
    host,
    port,
    protocol,
    apiKey,
    initialScreen,
    terminalSize,
    connectionSource: target.source,
    connectionEndpoint: target.endpoint,
  };

  const instance = ink.render(React.createElement(App, props), { exitOnCtrlC: true });

  const onResize = () => {
    terminalSize = getTerminalSize(stdout);
    renderApp(instance, React, App, { ...props, terminalSize });
  };

  stdout.on?.("resize", onResize);

  try {
    if (typeof instance.waitUntilExit === "function") {
      await instance.waitUntilExit();
    }
    return 0;
  } finally {
    stdout.off?.("resize", onResize);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  runBosunTui(process.argv.slice(2))
    .then((code) => {
      process.exit(code ?? 0);
    })
    .catch((error) => {
      console.error(`[bosun-tui] Failed to start: ${error?.message || error}`);
      process.exit(1);
    });
}
