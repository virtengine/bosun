import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REMOTE_CONNECTION_FILE = "remote-connection.json";
const UI_INSTANCE_LOCK_FILE = "ui-server.instance.lock.json";
const DEFAULT_LOCAL_CONNECTION_NAME = "Local Backend";
const DEFAULT_LOCAL_HOST = "127.0.0.1";
const DEFAULT_LOCAL_PORT = 3080;

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function toConnectionId(value, fallback = "") {
  const src = toTrimmedString(value).toLowerCase();
  let result = "";
  for (const ch of src) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      result += ch;
    } else if (result.length > 0 && result[result.length - 1] !== "-") {
      result += "-";
    }
  }
  while (result.endsWith("-")) result = result.slice(0, -1);
  return result || fallback || `connection-${Date.now()}`;
}

function normalizeConnectionName(entry, index) {
  return toTrimmedString(entry?.name)
    || toTrimmedString(entry?.label)
    || toTrimmedString(entry?.endpoint)
    || `Connection ${index + 1}`;
}

export function buildLocalConnectionEntry(entry = {}) {
  const name = toTrimmedString(entry?.name) || DEFAULT_LOCAL_CONNECTION_NAME;
  const parsed = parseConnectionEndpoint(
    entry?.endpoint || "",
    entry?.httpProtocol || entry?.protocol || "http",
  );
  const port = parsed?.port || Number(entry?.port || 0);
  if (!Number.isFinite(port) || port <= 0) {
    return null;
  }

  const httpProtocol = parsed?.httpProtocol
    || normalizeHttpProtocol(entry?.httpProtocol || entry?.protocol || "http");
  const host = parsed?.host
    || toTrimmedString(entry?.host || DEFAULT_LOCAL_HOST)
    || DEFAULT_LOCAL_HOST;

  return {
    name,
    endpoint: `${httpProtocol}://${host}:${port}`,
    host,
    port,
    protocol: httpProtocol === "https" ? "wss" : "ws",
    httpProtocol,
  };
}

function normalizeLocalConnectionConfig(raw = {}) {
  return buildLocalConnectionEntry(raw) || null;
}

export function normalizeRemoteConnectionConfig(raw = {}) {
  const normalizedConnections = [];
  const sourceConnections = Array.isArray(raw?.connections)
    ? raw.connections
    : (raw?.endpoint || raw?.apiKey)
      ? [{
          id: raw?.id || raw?.activeConnectionId || raw?.currentConnectionId || "primary",
          name: raw?.name || raw?.label || raw?.endpoint || "Primary",
          endpoint: raw?.endpoint,
          apiKey: raw?.apiKey,
          enabled: raw?.enabled !== false,
        }]
      : [];

  for (let index = 0; index < sourceConnections.length; index += 1) {
    const entry = sourceConnections[index];
    const endpoint = toTrimmedString(entry?.endpoint);
    if (!endpoint) continue;
    const name = normalizeConnectionName(entry, index);
    normalizedConnections.push({
      id: toConnectionId(entry?.id || name, `connection-${index + 1}`),
      name,
      endpoint,
      apiKey: toTrimmedString(entry?.apiKey),
      enabled: entry?.enabled !== false,
    });
  }

  const enabled = raw?.enabled !== false && normalizedConnections.length > 0;
  let activeConnectionId = toTrimmedString(raw?.activeConnectionId || raw?.currentConnectionId);
  if (!activeConnectionId && normalizedConnections.length > 0) {
    const legacyEndpoint = toTrimmedString(raw?.endpoint);
    const matched = legacyEndpoint
      ? normalizedConnections.find((entry) => entry.endpoint === legacyEndpoint)
      : null;
    activeConnectionId = matched?.id || normalizedConnections.find((entry) => entry.enabled !== false)?.id || normalizedConnections[0].id;
  }

  const activeConnection = normalizedConnections.find((entry) => entry.id === activeConnectionId)
    || normalizedConnections.find((entry) => entry.enabled !== false)
    || normalizedConnections[0]
    || null;

  return {
    enabled: Boolean(enabled && activeConnection),
    activeConnectionId: activeConnection?.id || "",
    endpoint: activeConnection?.endpoint || "",
    apiKey: activeConnection?.apiKey || "",
    name: activeConnection?.name || "",
    connections: normalizedConnections,
    localConnection: normalizeLocalConnectionConfig(raw?.localConnection || raw?.local || {}),
  };
}

export function listRemoteConnections(config = {}) {
  return normalizeRemoteConnectionConfig(config).connections;
}

export function setActiveRemoteConnection(config = {}, connectionId = "") {
  const normalized = normalizeRemoteConnectionConfig(config);
  const nextActive = normalized.connections.find((entry) => entry.id === connectionId)
    || normalized.connections[0]
    || null;
  return normalizeRemoteConnectionConfig({
    ...normalized,
    activeConnectionId: nextActive?.id || "",
    enabled: Boolean(nextActive),
  });
}

export function upsertRemoteConnection(config = {}, entry = {}, options = {}) {
  const normalized = normalizeRemoteConnectionConfig(config);
  const endpoint = toTrimmedString(entry?.endpoint);
  if (!endpoint) {
    return normalized;
  }
  const requestedName = normalizeConnectionName(entry, normalized.connections.length);
  const id = toConnectionId(entry?.id || requestedName, `connection-${normalized.connections.length + 1}`);
  const nextEntry = {
    id,
    name: requestedName,
    endpoint,
    apiKey: toTrimmedString(entry?.apiKey),
    enabled: entry?.enabled !== false,
  };
  const existingIndex = normalized.connections.findIndex((item) => item.id === id || item.endpoint === endpoint);
  const nextConnections = [...normalized.connections];
  if (existingIndex >= 0) {
    nextConnections[existingIndex] = {
      ...nextConnections[existingIndex],
      ...nextEntry,
    };
  } else {
    nextConnections.push(nextEntry);
  }
  return normalizeRemoteConnectionConfig({
    ...normalized,
    enabled: true,
    activeConnectionId: options.makeActive === false ? normalized.activeConnectionId : nextEntry.id,
    connections: nextConnections,
  });
}

export function setLocalConnectionConfig(config = {}, entry = {}) {
  const normalized = normalizeRemoteConnectionConfig(config);
  const nextLocalConnection = buildLocalConnectionEntry({
    ...normalized.localConnection,
    ...entry,
  });
  return normalizeRemoteConnectionConfig({
    ...normalized,
    localConnection: nextLocalConnection,
  });
}

export function defaultConfigDir() {
  const explicit = toTrimmedString(
    process.env.BOSUN_DIR
      || process.env.BOSUN_HOME
      || "",
  );
  if (explicit) return resolve(explicit);
  return resolve(process.cwd(), ".bosun");
}

export function normalizeWsProtocol(protocol) {
  const value = toTrimmedString(protocol).toLowerCase().replace(/:$/, "");
  return value === "wss" || value === "https" ? "wss" : "ws";
}

export function normalizeHttpProtocol(protocol) {
  const value = toTrimmedString(protocol).toLowerCase().replace(/:$/, "");
  return value === "https" || value === "wss" ? "https" : "http";
}

export function readUiInstanceLock(configDir = defaultConfigDir()) {
  try {
    const lockPath = resolve(configDir, ".cache", UI_INSTANCE_LOCK_FILE);
    if (!existsSync(lockPath)) return null;
    const parsed = JSON.parse(readFileSync(lockPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function readRemoteConnectionConfig(configDir = defaultConfigDir()) {
  try {
    const filePath = resolve(configDir, REMOTE_CONNECTION_FILE);
    if (!existsSync(filePath)) {
      return normalizeRemoteConnectionConfig({});
    }
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    return normalizeRemoteConnectionConfig(parsed);
  } catch {
    return normalizeRemoteConnectionConfig({});
  }
}

export function saveRemoteConnectionConfig(
  config = {},
  configDir = defaultConfigDir(),
) {
  const dir = resolve(configDir);
  mkdirSync(dir, { recursive: true });
  const payload = normalizeRemoteConnectionConfig(config);
  writeFileSync(
    resolve(dir, REMOTE_CONNECTION_FILE),
    JSON.stringify(payload, null, 2),
    "utf8",
  );
  return payload;
}

export function clearRemoteConnectionConfig(configDir = defaultConfigDir()) {
  const current = readRemoteConnectionConfig(configDir);
  return saveRemoteConnectionConfig(
    {
      ...current,
      enabled: false,
      activeConnectionId: "",
      endpoint: "",
      apiKey: "",
      name: "",
      connections: [],
    },
    configDir,
  );
}

export function parseConnectionEndpoint(endpoint, fallbackProtocol = "http") {
  const raw = toTrimmedString(endpoint);
  if (!raw) return null;
  const normalizedFallback = normalizeHttpProtocol(fallbackProtocol);
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : `${normalizedFallback}://${raw}`;
  try {
    const parsed = new URL(candidate);
    const httpProtocol = normalizeHttpProtocol(parsed.protocol);
    const wsProtocol = httpProtocol === "https" ? "wss" : "ws";
    const port = Number(
      parsed.port || (httpProtocol === "https" ? 443 : 80),
    );
    if (!Number.isFinite(port) || port <= 0) return null;
    return {
      endpoint: parsed.origin,
      host: parsed.hostname,
      port,
      protocol: wsProtocol,
      httpProtocol,
    };
  } catch {
    return null;
  }
}

export function resolveLocalTuiConnectionTarget(options = {}) {
  const configDir = options.configDir || defaultConfigDir();
  const env = options.env || process.env;
  const config = options.config || {};
  const savedConfig = normalizeRemoteConnectionConfig(
    options.connectionConfig || readRemoteConnectionConfig(configDir),
  );
  const defaultPort = Number(
    env.TELEGRAM_UI_PORT
      || env.BOSUN_PORT
      || config?.telegramUiPort
      || savedConfig.localConnection?.port
      || DEFAULT_LOCAL_PORT,
  ) || DEFAULT_LOCAL_PORT;

  const instance = readUiInstanceLock(configDir);
  if (instance?.url || instance?.host || instance?.port) {
    const parsed = instance?.url
      ? parseConnectionEndpoint(instance.url, instance.protocol || "http")
      : null;
    if (parsed) {
      return {
        ...parsed,
        apiKey: "",
        source: "ui-instance-lock",
      };
    }
    const host = toTrimmedString(instance?.host || "127.0.0.1") || "127.0.0.1";
    const port = Number(instance?.port || 0) || defaultPort;
    const httpProtocol = normalizeHttpProtocol(instance?.protocol || "http");
    return {
      endpoint: `${httpProtocol}://${host}:${port}`,
      host,
      port,
      protocol: httpProtocol === "https" ? "wss" : "ws",
      httpProtocol,
      apiKey: "",
      source: "ui-instance-lock",
    };
  }

  if (savedConfig.localConnection?.endpoint) {
    return {
      ...savedConfig.localConnection,
      apiKey: "",
      source: "saved-local",
    };
  }

  return {
    endpoint: `http://127.0.0.1:${defaultPort}`,
    host: "127.0.0.1",
    port: defaultPort,
    protocol: "ws",
    httpProtocol: "http",
    apiKey: "",
    source: "default-local",
  };
}

function resolveBosunRuntimeRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function resolveBosunCliPath() {
  return resolve(resolveBosunRuntimeRoot(), "cli.mjs");
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export async function ensureLocalBosunBackendRunning(options = {}) {
  const configDir = options.configDir || defaultConfigDir();
  const env = options.env || process.env;
  const config = options.config || {};
  const timeoutMs = Math.max(2000, Number(options.timeoutMs || 20000));
  const probeTimeoutMs = Math.min(4000, timeoutMs);
  const resolveTarget = () => resolveLocalTuiConnectionTarget({ configDir, config, env });

  let target = resolveTarget();
  let probe = await testConnectionTarget(target, "", { timeoutMs: probeTimeoutMs });
  if (probe.ok) {
    const saved = saveRemoteConnectionConfig(
      setLocalConnectionConfig(readRemoteConnectionConfig(configDir), target),
      configDir,
    );
    return {
      ok: true,
      started: false,
      pid: null,
      target: {
        ...target,
        source: target.source || (saved.localConnection?.endpoint ? "saved-local" : ""),
      },
      error: "",
    };
  }

  const cliPath = resolveBosunCliPath();
  if (!existsSync(cliPath)) {
    return {
      ok: false,
      started: false,
      pid: null,
      target,
      error: `CLI not found at ${cliPath}`,
    };
  }

  let pid = null;
  try {
    const args = [cliPath, "--daemon", "--no-update-check"];
    if (configDir) {
      args.push("--config-dir", resolve(configDir));
    }
    const child = spawn(process.execPath, args, {
      cwd: resolveBosunRuntimeRoot(),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        ...env,
        BOSUN_CONNECTION_AUTO_LAUNCH: "1",
      },
    });
    child.unref();
    pid = Number(child.pid || 0) || null;
  } catch (error) {
    return {
      ok: false,
      started: false,
      pid: null,
      target,
      error: String(error?.message || "Failed to launch local backend"),
    };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(500);
    target = resolveTarget();
    probe = await testConnectionTarget(target, "", { timeoutMs: 2000 });
    if (probe.ok) {
      saveRemoteConnectionConfig(
        setLocalConnectionConfig(readRemoteConnectionConfig(configDir), target),
        configDir,
      );
      return {
        ok: true,
        started: true,
        pid,
        target,
        error: "",
      };
    }
  }

  return {
    ok: false,
    started: true,
    pid,
    target,
    error: `Local backend did not become reachable within ${Math.round(timeoutMs / 1000)}s`,
  };
}

export async function testConnectionTarget(endpoint, apiKey = "", options = {}) {
  const parsed = typeof endpoint === "string"
    ? parseConnectionEndpoint(endpoint, options.fallbackProtocol || "http")
    : endpoint;
  if (!parsed?.endpoint) {
    return {
      ok: false,
      error: "Invalid endpoint URL",
      target: null,
      statusCode: 0,
    };
  }

  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 4000));
  const targetUrl = new URL("/api/status", parsed.endpoint);
  const headers = {};
  const normalizedApiKey = toTrimmedString(apiKey);
  if (normalizedApiKey) {
    headers["x-api-key"] = normalizedApiKey;
  }
  const requester = targetUrl.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolveProbe) => {
    const req = requester(targetUrl, {
      method: "GET",
      headers,
      timeout: timeoutMs,
      rejectUnauthorized: options.rejectUnauthorized ?? false,
    }, (res) => {
      const statusCode = Number(res.statusCode || 0);
      res.resume();
      if (statusCode >= 200 && statusCode < 400) {
        resolveProbe({
          ok: true,
          error: "",
          target: parsed,
          statusCode,
        });
        return;
      }
      const authFailure = statusCode === 401 || statusCode === 403;
      resolveProbe({
        ok: false,
        error: authFailure ? "Authentication failed" : `Request failed (${statusCode || "unknown"})`,
        target: parsed,
        statusCode,
      });
    });
    req.on("error", (error) => {
      resolveProbe({
        ok: false,
        error: String(error?.message || "Connection failed"),
        target: parsed,
        statusCode: 0,
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error("Connection timed out"));
    });
    req.end();
  });
}

export function resolveTuiConnectionTarget(options = {}) {
  const configDir = options.configDir || defaultConfigDir();
  const env = options.env || process.env;
  const config = options.config || {};
  const explicitEndpoint = toTrimmedString(options.endpoint);
  const explicitHost = toTrimmedString(options.host);
  const explicitPort = Number(options.port || 0);
  const explicitProtocol = toTrimmedString(options.protocol);
  const explicitApiKey = toTrimmedString(options.apiKey);
  const defaultPort = Number(
    env.TELEGRAM_UI_PORT
      || env.BOSUN_PORT
      || config?.telegramUiPort
      || 3080,
  ) || 3080;

  if (explicitEndpoint) {
    const parsed = parseConnectionEndpoint(explicitEndpoint, explicitProtocol || "http");
    if (parsed) {
      return {
        ...parsed,
        apiKey: explicitApiKey,
        source: "cli-endpoint",
      };
    }
  }

  if (explicitHost || explicitPort > 0 || explicitProtocol) {
    const wsProtocol = normalizeWsProtocol(explicitProtocol || "ws");
    const httpProtocol = normalizeHttpProtocol(wsProtocol);
    const host = explicitHost || "127.0.0.1";
    const port = explicitPort > 0 ? explicitPort : defaultPort;
    return {
      endpoint: `${httpProtocol}://${host}:${port}`,
      host,
      port,
      protocol: wsProtocol,
      httpProtocol,
      apiKey: explicitApiKey,
      source: "cli-host-port",
    };
  }

  const remote = readRemoteConnectionConfig(configDir);
  if (remote.enabled && remote.endpoint) {
    const parsed = parseConnectionEndpoint(remote.endpoint, "https");
    if (parsed) {
      return {
        ...parsed,
        apiKey: explicitApiKey || remote.apiKey || toTrimmedString(env.BOSUN_API_KEY),
        source: "saved-remote",
      };
    }
  }

  return {
    ...resolveLocalTuiConnectionTarget({ configDir, config, env }),
    apiKey: explicitApiKey,
  };
}
