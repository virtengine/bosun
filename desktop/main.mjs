import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  Menu,
  screen,
  shell,
  Tray,
  globalShortcut,
  ipcMain,
  session,
} from "electron";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import {
  ensureLocalBosunBackendRunning,
  normalizeRemoteConnectionConfig,
  setActiveRemoteConnection,
  setLocalConnectionConfig,
  upsertRemoteConnection,
} from "../tui/lib/connection-target.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function createUnavailableShortcutsApi() {
  const unavailable = () => ({
    ok: false,
    error: "Keyboard shortcuts module is unavailable in this installation. Reinstall Bosun.",
  });
  return {
    initShortcuts: () => {},
    onShortcut: () => {},
    getAllShortcuts: () => [],
    getEffectiveAccelerator: () => null,
    registerGlobalShortcuts: () => {},
    unregisterGlobalShortcuts: () => {
      try {
        globalShortcut.unregisterAll();
      } catch {
        /* ignore */
      }
    },
    setShortcut: unavailable,
    resetShortcut: unavailable,
    resetAllShortcuts: unavailable,
  };
}

function isMissingModuleError(error) {
  return Boolean(error && error.code === "ERR_MODULE_NOT_FOUND");
}

async function loadShortcutsApi() {
  const candidates = ["./desktop-shortcuts.mjs", "../desktop-shortcuts.mjs"];
  for (const specifier of candidates) {
    try {
      return await import(specifier);
    } catch (error) {
      if (isMissingModuleError(error)) continue;
      throw error;
    }
  }

  console.warn(
    "[desktop] keyboard shortcuts module not found; continuing with limited shortcut support",
  );
  return createUnavailableShortcutsApi();
}

const {
  initShortcuts,
  onShortcut,
  getAllShortcuts,
  getEffectiveAccelerator,
  registerGlobalShortcuts,
  unregisterGlobalShortcuts,
  setShortcut,
  setShortcutScope,
  resetShortcut,
  resetAllShortcuts,
} = await loadShortcutsApi();

process.title = "bosun-desktop";

let mainWindow = null;
let followWindow = null;
let tray = null;
let followWindowLaunchSignature = "";
let shuttingDown = false;
let uiServerStarted = false;
let uiOrigin = null;
let uiApi = null;
let desktopAuthHeaderBridgeInstalled = false;
let runtimeConfigLoaded = false;
/** True when the app is running as a persistent background / tray resident. */
let trayMode = false;
/** True when the main window should start hidden (background mode). */
let startHidden = false;
/** True when connected to a user-configured remote Bosun instance. */
let remoteConnectionActive = false;
let remoteConnectionPromptOpen = false;
const DEFAULT_TELEGRAM_UI_PORT = 3080;
const DESKTOP_RELEASES_URL = "https://github.com/virtengine/bosun/releases";
const STARTUP_UPDATE_REMIND_LATER_MS = 12 * 60 * 60 * 1000;
const REMOTE_CONNECTION_FILE = "remote-connection.json";

/** @type {{
 * checking: boolean,
 * available: boolean,
 * downloaded: boolean,
 * currentVersion: string,
 * latestVersion: string,
 * source: string,
 * error: string,
 * lastCheckedAt: number,
 * installActionLabel: string,
 * statusSummary: string,
 * promptPending: boolean,
 * startupPromptShownForVersion: string,
 * }} */
let desktopUpdateState = {
  checking: false,
  available: false,
  downloaded: false,
  currentVersion: "0.0.0",
  latestVersion: "",
  source: "",
  error: "",
  lastCheckedAt: 0,
  installActionLabel: "Check for Updates…",
  statusSummary: "Update status unknown",
  promptPending: false,
  startupPromptShownForVersion: "",
};
let packagedAutoUpdater = null;
let packagedAutoUpdaterConfigured = false;
let startupUpdatePromptInFlight = false;

// ── Workspace cache (module-scope — refreshed by fetchWorkspaces) ─────────────
/** @type {{ id: string, name: string, [key: string]: unknown }[]} */
let _cachedWorkspaces = [];
let _cachedActiveWorkspaceId = /** @type {string|null} */ (null);
let _workspaceCacheAt = 0;
const WORKSPACE_CACHE_TTL_MS = 30_000;

/**
 * Shorthand: returns the effective accelerator for a shortcut ID.
 * Used throughout buildAppMenu() and refreshTrayMenu() so the menu
 * always reflects the user's current shortcut customizations.
 *
 * @param {string} id  Shortcut ID from DEFAULT_SHORTCUTS catalog.
 * @returns {string|undefined}  Accelerator string, or undefined if disabled.
 */
const acc = (id) => getEffectiveAccelerator(id) ?? undefined;

const DAEMON_PID_FILE = resolve(homedir(), ".cache", "bosun", "daemon.pid");
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
}

// Local/private-network patterns — TLS cert bypass for the embedded UI server
const LOCAL_HOSTNAME_RE = [
  /^127\./,
  /^192\.168\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^::1$/,
  /^localhost$/i,
];
function isLocalHost(hostname) {
  return LOCAL_HOSTNAME_RE.some((re) => re.test(hostname));
}

function isTrustedCaptureOrigin(originLike) {
  const raw = String(originLike || "").trim();
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    const host = String(parsed.hostname || "").trim();
    if (!host) return false;
    if (isLocalHost(host)) return true;
    if (uiOrigin) {
      const active = new URL(uiOrigin);
      return (
        String(active.protocol || "").toLowerCase() === String(parsed.protocol || "").toLowerCase()
        && String(active.host || "").toLowerCase() === String(parsed.host || "").toLowerCase()
      );
    }
    return false;
  } catch {
    return false;
  }
}

function isTrustedDesktopRequestUrl(urlLike) {
  return isTrustedCaptureOrigin(urlLike);
}

function installDesktopAuthHeaderBridge() {
  if (desktopAuthHeaderBridgeInstalled) return;
  const ses = session.defaultSession;
  if (!ses) return;
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    try {
      if (!isTrustedDesktopRequestUrl(details?.url || "")) {
        callback({ requestHeaders: details.requestHeaders });
        return;
      }
      const headers = { ...(details.requestHeaders || {}) };
      const existingAuth = String(headers.Authorization || headers.authorization || "").trim();
      if (existingAuth) {
        callback({ requestHeaders: headers });
        return;
      }

      // When connected to a remote instance, use the configured API key
      if (remoteConnectionActive) {
        const remote = readRemoteConnectionConfig();
        if (remote.apiKey) {
          headers["X-API-Key"] = remote.apiKey;
          callback({ requestHeaders: headers });
          return;
        }
      }

      // Otherwise use the local desktop API key
      const desktopKey = String(process.env.BOSUN_DESKTOP_API_KEY || "").trim();
      if (desktopKey) {
        headers.Authorization = `Bearer ${desktopKey}`;
      }
      callback({ requestHeaders: headers });
    } catch {
      callback({ requestHeaders: details.requestHeaders });
    }
  });
  desktopAuthHeaderBridgeInstalled = true;
}

function installDesktopMediaHandlers() {
  const ses = session.defaultSession;
  if (!ses) return;

  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    const p = String(permission || "").trim().toLowerCase();
    const sensitive = new Set(["media", "display-capture", "audio-capture", "video-capture"]);
    if (!sensitive.has(p)) return true;
    return isTrustedCaptureOrigin(requestingOrigin);
  });

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const p = String(permission || "").trim().toLowerCase();
    const sensitive = new Set(["media", "display-capture", "audio-capture", "video-capture"]);
    if (!sensitive.has(p)) {
      callback(true);
      return;
    }
    const allowed = isTrustedCaptureOrigin(details?.requestingOrigin || webContents?.getURL?.());
    callback(allowed);
  });

  ses.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        // Prefer OS picker when available; this callback is used as fallback.
        const sources = await desktopCapturer.getSources({
          types: ["screen", "window"],
          thumbnailSize: { width: 0, height: 0 },
          fetchWindowIcons: false,
        });
        if (!Array.isArray(sources) || !sources.length) {
          callback({});
          return;
        }
        callback({ video: sources[0], audio: "loopback" });
      } catch (err) {
        console.warn("[desktop] display media request failed:", err?.message || err);
        callback({});
      }
    },
    { useSystemPicker: true },
  );
}

/**
 * Detect whether a graphical display environment is available.
 * On Windows and macOS this is always true.
 * On Linux we probe for an X11 / Wayland display server.
 */
function isGuiEnvironment() {
  if (process.platform === "win32" || process.platform === "darwin") return true;
  // Linux / BSD: check for a display server
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return true;
  // Running inside a desktop session without a forwarded $DISPLAY is possible
  // (e.g. XDG_SESSION_TYPE=wayland without WAYLAND_DISPLAY being exported).
  if (process.env.XDG_SESSION_TYPE && process.env.XDG_SESSION_TYPE !== "tty") return true;
  return false;
}

/**
 * Returns true when the app should run as a persistent tray resident.
 * Opt-out: set BOSUN_DESKTOP_TRAY=0 / BOSUN_DESKTOP_NO_TRAY=1
 * Explicit opt-in: BOSUN_DESKTOP_TRAY=1
 * Default: enabled on any GUI environment.
 */
function isTrayModeEnabled() {
  if (parseBoolEnv(process.env.BOSUN_DESKTOP_NO_TRAY, false)) return false;
  const explicit = process.env.BOSUN_DESKTOP_TRAY;
  if (explicit !== undefined && explicit !== "") {
    return parseBoolEnv(explicit, true);
  }
  return isGuiEnvironment();
}

function parseBoolEnv(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function shouldSkipTlsVerification(urlStr) {
  const allowInsecure = parseBoolEnv(process.env.BOSUN_DESKTOP_ALLOW_INSECURE_TLS, false);
  if (!allowInsecure) return false;
  try {
    const parsed = new URL(String(urlStr || ""));
    const host = parsed.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

function isWslInteropRuntime() {
  return Boolean(
    process.env.WSL_DISTRO_NAME
    || process.env.WSL_INTEROP
    || (process.platform === "win32"
      && String(process.env.HOME || "")
        .trim()
        .startsWith("/home/")),
  );
}

function resolveDesktopConfigDir() {
  if (process.env.BOSUN_HOME) return resolve(process.env.BOSUN_HOME);
  if (process.env.BOSUN_DIR) return resolve(process.env.BOSUN_DIR);

  const preferWindowsDirs = process.platform === "win32" && !isWslInteropRuntime();
  const baseDir = preferWindowsDirs
    ? process.env.APPDATA
      || process.env.LOCALAPPDATA
      || process.env.USERPROFILE
      || process.env.HOME
      || homedir()
    : process.env.HOME
      || process.env.XDG_CONFIG_HOME
      || process.env.USERPROFILE
      || process.env.APPDATA
      || process.env.LOCALAPPDATA
      || homedir();

  return resolve(baseDir, "bosun");
}

function readDesktopApiKeyFromDisk(configDir) {
  try {
    const file = resolve(String(configDir || "").trim(), "desktop-api-key.json");
    if (!existsSync(file)) return "";
    const payload = JSON.parse(readFileSync(file, "utf8"));
    const key = String(payload?.key || "").trim();
    if (!key.startsWith("bosun_desktop_")) return "";
    return key;
  } catch {
    return "";
  }
}

function ensureDesktopApiKeyInEnv() {
  const current = String(process.env.BOSUN_DESKTOP_API_KEY || "").trim();
  const fromDisk = readDesktopApiKeyFromDisk(resolveDesktopConfigDir());
  if (fromDisk) {
    if (current !== fromDisk) {
      process.env.BOSUN_DESKTOP_API_KEY = fromDisk;
    }
    return fromDisk;
  }
  return current;
}

/* ── Remote-connection config persistence ─────────────────────── */

/**
 * Read the persisted remote-connection config.
 * Returns { enabled: boolean, endpoint: string, apiKey: string }.
 */
function readRemoteConnectionConfig() {
  try {
    const file = resolve(resolveDesktopConfigDir(), REMOTE_CONNECTION_FILE);
    if (!existsSync(file)) return normalizeRemoteConnectionConfig({});
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return normalizeRemoteConnectionConfig(raw);
  } catch {
    return normalizeRemoteConnectionConfig({});
  }
}

/**
 * Persist remote-connection config to disk.
 * @param {{ enabled: boolean, endpoint: string, apiKey: string }} config
 */
function saveRemoteConnectionConfig(config) {
  const dir = resolveDesktopConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = resolve(dir, REMOTE_CONNECTION_FILE);
  const payload = normalizeRemoteConnectionConfig(config);
  writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

function saveActiveRemoteConnectionEntry(entry = {}) {
  const current = readRemoteConnectionConfig();
  const next = upsertRemoteConnection(current, {
    id: entry?.id,
    name: entry?.name || entry?.endpoint,
    endpoint: entry?.endpoint,
    apiKey: entry?.apiKey,
    enabled: true,
  });
  return saveRemoteConnectionConfig(next);
}

function saveDesktopLocalConnectionEntry(entry = {}) {
  const current = readRemoteConnectionConfig();
  const next = setLocalConnectionConfig(current, {
    name: "Local Backend",
    ...entry,
  });
  return saveRemoteConnectionConfig(next);
}

/**
 * Probe a remote Bosun endpoint. Returns true if reachable.
 */
async function probeRemoteEndpoint(endpoint, apiKey) {
  const result = await testRemoteEndpoint(endpoint, apiKey);
  return result.ok;
}

async function testRemoteEndpoint(endpoint, apiKey) {
  try {
    const url = new URL("/api/status", endpoint);
    const headers = {};
    if (apiKey) headers["x-api-key"] = apiKey;
    const mod = url.protocol === "https:" ? await import("node:https") : await import("node:http");
    return await new Promise((resolveProbe) => {
      const req = mod.get(url, { headers, timeout: 3000, rejectUnauthorized: false }, (res) => {
        const statusCode = Number(res.statusCode || 0);
        res.resume();
        if (statusCode >= 200 && statusCode < 400) {
          resolveProbe({ ok: true, reachable: true, statusCode, error: "" });
          return;
        }
        resolveProbe({
          ok: false,
          reachable: false,
          statusCode,
          error: statusCode === 401 || statusCode === 403
            ? "Authentication failed"
            : `Request failed (${statusCode || "unknown"})`,
        });
      });
      req.on("error", (error) => resolveProbe({
        ok: false,
        reachable: false,
        statusCode: 0,
        error: String(error?.message || "Connection failed"),
      }));
      req.on("timeout", () => {
        req.destroy();
        resolveProbe({
          ok: false,
          reachable: false,
          statusCode: 0,
          error: "Connection timed out",
        });
      });
    });
  } catch {
    return { ok: false, reachable: false, statusCode: 0, error: "Invalid endpoint URL" };
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Collect all candidate PID file paths for the bosun daemon.
 * The daemon may be running from different working directories, each
 * writing its PID file to a different .cache location.
 */
function getDaemonPidFileCandidates() {
  const candidates = new Set();
  // 1. Original fixed location
  candidates.add(DAEMON_PID_FILE);
  // 2. Bosun module root's .cache
  const bosunRoot = resolveBosunRoot();
  candidates.add(resolve(bosunRoot, ".cache", "bosun-daemon.pid"));
  candidates.add(resolve(bosunRoot, ".cache", "bosun.pid"));
  // 3. Agent endpoint port file (sibling to PID files)
  const portFilePath = resolve(bosunRoot, ".cache", "agent-endpoint-port");
  if (existsSync(portFilePath)) {
    // Port file exists — there's likely a running instance
    const portDir = dirname(portFilePath);
    candidates.add(resolve(portDir, "bosun-daemon.pid"));
    candidates.add(resolve(portDir, "bosun.pid"));
  }
  // 4. Global npm install location
  const npmGlobal = process.env.APPDATA
    ? resolve(process.env.APPDATA, "npm", "node_modules", "bosun", ".cache")
    : null;
  if (npmGlobal) {
    candidates.add(resolve(npmGlobal, "bosun-daemon.pid"));
    candidates.add(resolve(npmGlobal, "bosun.pid"));
  }
  // 5. NVM-based install location
  const nvmDir = process.env.NVM_SYMLINK || process.env.NVM_HOME;
  if (nvmDir) {
    const nvmModules = resolve(nvmDir, "node_modules", "bosun", ".cache");
    candidates.add(resolve(nvmModules, "bosun-daemon.pid"));
    candidates.add(resolve(nvmModules, "bosun.pid"));
  }
  return [...candidates];
}

function getDaemonPid() {
  for (const pidFile of getDaemonPidFileCandidates()) {
    try {
      if (!existsSync(pidFile)) continue;
      const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
      if (!Number.isFinite(pid)) continue;
      if (isProcessAlive(pid)) return pid;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function findGhostDaemonPids() {
  if (process.platform === "win32") {
    try {
      const cmd = [
        "$ErrorActionPreference='Stop';",
        "$procs = Get-CimInstance Win32_Process | Where-Object {",
        "  $_.Name -match '^(node|node\\.exe)$' -and",
        "  $_.CommandLine -and",
        "  ($_.CommandLine -match '--daemon-child' -or $_.CommandLine -match 'BOSUN_DAEMON=1')",
        "};",
        "$procs | ForEach-Object { $_.ProcessId }",
      ].join(" ");
      const out = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", cmd],
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 3500 },
      ).trim();
      if (!out) return [];
      return out
        .split(/\r?\n/)
        .map((s) => parseInt(String(s).trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid);
    } catch {
      return [];
    }
  }
  try {
    const out = execFileSync(
      "pgrep",
      ["-f", "bosun.*--daemon-child|cli\\.mjs.*--daemon-child"],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 3000 },
    ).trim();
    return out
      .split("\n")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid);
  } catch {
    return [];
  }
}

async function waitForDaemon(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = getDaemonPid();
    if (pid) return pid;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

function resolveBosunRoot() {
  if (app.isPackaged) {
    return resolve(process.resourcesPath, "bosun");
  }
  return resolve(__dirname, "..");
}

function resolveBosunRuntimePath(file) {
  return resolve(resolveBosunRoot(), file);
}

function resolveDesktopIconPath() {
  const candidates = [
    resolveBosunRuntimePath("logo.png"),
    resolveBosunRuntimePath("ui/logo.png"),
    resolve(__dirname, "..", "ui", "logo.png"),
    resolve(__dirname, "..", "logo.png"),
  ];
  return candidates.find((iconPath) => existsSync(iconPath)) || null;
}

function getDesktopUpdateStatePath() {
  return resolve(resolveDesktopConfigDir(), "desktop-update-state.json");
}

function readDesktopUpdatePrefs() {
  try {
    const file = getDesktopUpdateStatePath();
    if (!existsSync(file)) return {};
    const payload = JSON.parse(readFileSync(file, "utf8"));
    return payload && typeof payload === "object" ? payload : {};
  } catch {
    return {};
  }
}

function writeDesktopUpdatePrefs(nextPrefs) {
  try {
    const dir = resolveDesktopConfigDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      getDesktopUpdateStatePath(),
      `${JSON.stringify(nextPrefs, null, 2)}\n`,
      "utf8",
    );
  } catch (err) {
    console.warn("[desktop] could not persist update prefs:", err?.message || err);
  }
}

function getDesktopParentWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function computeUpdateStatusSummary(state = desktopUpdateState) {
  if (state.checking) {
    return `Checking for updates from ${state.source || "the update service"}…`;
  }
  if (state.downloaded) {
    return `Update ready to install: v${state.latestVersion || state.currentVersion}`;
  }
  if (state.available) {
    return `Update available: v${state.currentVersion} → v${state.latestVersion}`;
  }
  if (state.error) {
    return `Update check failed: ${state.error}`;
  }
  if (state.lastCheckedAt > 0) {
    return `Up to date at v${state.currentVersion}`;
  }
  return `Current version: v${state.currentVersion}`;
}

function refreshDesktopMenus() {
  try {
    Menu.setApplicationMenu(buildAppMenu());
  } catch {
    // best effort
  }
  refreshTrayMenu();
}

function setDesktopUpdateState(patch) {
  desktopUpdateState = {
    ...desktopUpdateState,
    ...patch,
  };
  desktopUpdateState.currentVersion = desktopUpdateState.currentVersion || readCurrentBosunVersion();
  desktopUpdateState.installActionLabel = desktopUpdateState.downloaded
    ? `Install Update & Restart${desktopUpdateState.latestVersion ? ` (v${desktopUpdateState.latestVersion})` : ""}`
    : desktopUpdateState.checking
      ? "Checking for Updates…"
      : desktopUpdateState.available
        ? `Update Available: v${desktopUpdateState.latestVersion}`
        : "Check for Updates…";
  desktopUpdateState.statusSummary = computeUpdateStatusSummary(desktopUpdateState);
  refreshDesktopMenus();
}

function setDesktopAboutPanelOptions() {
  try {
    app.setAboutPanelOptions({
      applicationName: "Bosun Desktop",
      applicationVersion: `v${readCurrentBosunVersion()}`,
      version: process.versions.electron,
      copyright: "Copyright VirtEngine",
      website: "https://github.com/virtengine/bosun",
      websiteLabel: "GitHub Repository",
    });
  } catch {
    // best effort
  }
}

async function showAboutDialog() {
  const parentWin = getDesktopParentWindow();
  const currentVersion = readCurrentBosunVersion();
  const detailLines = [
    `Bosun version: v${currentVersion}`,
    `Electron: v${process.versions.electron}`,
    `Node.js: v${process.versions.node}`,
    desktopUpdateState.statusSummary,
  ];
  const buttons = [
    desktopUpdateState.downloaded ? "Install Update & Restart" : "Check for Updates",
    "Open Releases",
    "Close",
  ];
  const { response } = await dialog.showMessageBox(parentWin, {
    type: "info",
    title: "About Bosun Desktop",
    message: "Bosun Desktop",
    detail: detailLines.join("\n"),
    buttons,
    defaultId: 0,
    cancelId: 2,
  });
  if (response === 0) {
    if (desktopUpdateState.downloaded) {
      await installDownloadedPackagedUpdate();
    } else {
      await checkForUpdateDesktop({ interactive: true, source: "about" });
    }
    return;
  }
  if (response === 1) {
    await shell.openExternal(DESKTOP_RELEASES_URL).catch(() => {});
  }
}

async function installDownloadedPackagedUpdate() {
  if (!packagedAutoUpdater || !desktopUpdateState.downloaded) return false;
  const parentWin = getDesktopParentWindow();
  const { response } = await dialog.showMessageBox(parentWin, {
    type: "info",
    title: "Install Update",
    message: "Restart Bosun Desktop to apply the downloaded update?",
    detail: `Ready to install: v${desktopUpdateState.latestVersion || desktopUpdateState.currentVersion}`,
    buttons: ["Install & Restart", "Later"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return false;
  packagedAutoUpdater.quitAndInstall(false, true);
  return true;
}

function shouldPromptForStartupUpdate(latestVersion) {
  const prefs = readDesktopUpdatePrefs();
  const deferredUntil = Number(prefs.deferUntil || 0);
  const deferredVersion = String(prefs.version || "");
  if (deferredVersion === latestVersion && deferredUntil > Date.now()) {
    return false;
  }
  return true;
}

function markStartupUpdateDeferred(latestVersion) {
  writeDesktopUpdatePrefs({
    version: latestVersion,
    deferUntil: Date.now() + STARTUP_UPDATE_REMIND_LATER_MS,
  });
}

function clearStartupUpdateDeferral() {
  writeDesktopUpdatePrefs({});
}

async function promptStartupUpdateAvailable(latestVersion, options = {}) {
  if (startupUpdatePromptInFlight) return;
  if (!latestVersion || !shouldPromptForStartupUpdate(latestVersion)) return;
  startupUpdatePromptInFlight = true;
  try {
    const parentWin = getDesktopParentWindow();
    const currentVersion = readCurrentBosunVersion();
    const isDownloaded = Boolean(options.downloaded);
    const buttons = isDownloaded
      ? ["Install & Restart", "Later", "Open Releases"]
      : ["Update Now", "Later", "Open Releases"];
    const { response } = await dialog.showMessageBox(parentWin, {
      type: "info",
      title: isDownloaded ? "Update Ready" : "Update Available",
      message: isDownloaded
        ? "Bosun Desktop has downloaded an update."
        : "Bosun Desktop is out of date.",
      detail:
        `Current version: v${currentVersion}\n` +
        `Latest version:  v${latestVersion}\n\n` +
        (isDownloaded
          ? "Restart now to apply the downloaded update."
          : "Install the update now or defer the reminder for 12 hours."),
      buttons,
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      clearStartupUpdateDeferral();
      if (isDownloaded) {
        await installDownloadedPackagedUpdate();
      } else {
        await checkForUpdateDesktop({ interactive: true, source: "startup" });
      }
    } else if (response === 2) {
      await shell.openExternal(DESKTOP_RELEASES_URL).catch(() => {});
      markStartupUpdateDeferred(latestVersion);
    } else {
      markStartupUpdateDeferred(latestVersion);
    }
  } finally {
    startupUpdatePromptInFlight = false;
  }
}

function buildLoadingPageUrl(message = "Starting Bosun...") {
  const safeMessage = String(message || "Starting Bosun...")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Bosun Desktop</title>
  <style>
    :root {
      --bg: #0b0f14;
      --panel: #121a24;
      --text: #e5e7eb;
      --muted: #94a3b8;
      --accent: #4f8cff;
      --border: #243041;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: radial-gradient(1200px 600px at 10% -10%, rgba(79,140,255,0.20), transparent 55%), var(--bg);
      color: var(--text);
      font-family: "Segoe UI", Inter, system-ui, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 18px;
    }
    .card {
      width: min(520px, 96vw);
      border: 1px solid var(--border);
      border-radius: 14px;
      background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01));
      padding: 22px 20px;
      box-shadow: 0 18px 50px rgba(0,0,0,0.40);
    }
    .title {
      font-size: 20px;
      font-weight: 700;
      margin: 0 0 12px;
      letter-spacing: 0.2px;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .spinner {
      width: 18px;
      height: 18px;
      border-radius: 999px;
      border: 2px solid rgba(79,140,255,0.30);
      border-top-color: var(--accent);
      animation: spin 900ms linear infinite;
      flex: 0 0 auto;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .message {
      margin: 0;
      font-size: 14px;
      color: var(--text);
    }
    .hint {
      margin: 12px 0 0;
      font-size: 12px;
      color: var(--muted);
      line-height: 1.45;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1 class="title">Bosun Desktop</h1>
    <div class="row">
      <div class="spinner" aria-hidden="true"></div>
      <p id="bosun-loading-message" class="message">${safeMessage}</p>
    </div>
    <p class="hint">First launch can take 5-10 seconds while Bosun services start in the background.</p>
  </div>
</body>
</html>`;
  return `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`;
}

async function setLoadingMessage(message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const safe = JSON.stringify(String(message || "Starting Bosun..."));
  try {
    await mainWindow.webContents.executeJavaScript(
      `(function () {
        var el = document.getElementById('bosun-loading-message');
        if (el) el.textContent = ${safe};
      })()`,
      true,
    );
  } catch {
    // best effort
  }
}

function encodeFollowParam(value) {
  const normalized = String(value || "").trim();
  return normalized;
}

function buildFollowWindowUrl(baseUrl, detail = {}) {
  const target = new URL(baseUrl);
  target.searchParams.set("follow", "1");
  target.searchParams.set("launch", "voice");
  target.searchParams.set(
    "call",
    String(detail.call || "").trim().toLowerCase() === "video"
      ? "video"
      : "voice",
  );
  const sessionId = encodeFollowParam(detail.sessionId);
  const executor = encodeFollowParam(detail.executor);
  const mode = encodeFollowParam(detail.mode);
  const model = encodeFollowParam(detail.model);
  const vision = encodeFollowParam(detail.initialVisionSource);
  if (sessionId) target.searchParams.set("sessionId", sessionId);
  if (executor) target.searchParams.set("executor", executor);
  if (mode) target.searchParams.set("mode", mode);
  if (model) target.searchParams.set("model", model);
  if (vision) target.searchParams.set("vision", vision);
  return target;
}

function setWindowVisible(win) {
  if (!win || win.isDestroyed()) return;
  win.setSkipTaskbar(false);
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

function anchorFollowWindow(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const bounds = win.getBounds();
    const targetDisplay = screen.getDisplayMatching(bounds);
    const area = targetDisplay?.workArea;
    if (!area) return;
    const margin = 16;
    const x = Math.max(area.x, area.x + area.width - bounds.width - margin);
    const y = Math.max(area.y, area.y + area.height - bounds.height - margin);
    win.setPosition(x, y, false);
  } catch {
    // best effort only
  }
}

// ── Workspace helpers ─────────────────────────────────────────────────────────

/**
 * Make an authenticated JSON request to the UI server.
 * Returns the parsed response body, or null on error.
 * @param {string} urlStr
 * @param {{ method?: string, body?: string }} [opts]
 */
function uiServerRequest(urlStr, { method = "GET", body } = {}) {
  return new Promise((resolve) => {
    try {
      const isHttps = urlStr.startsWith("https://");
      const desktopKey = process.env.BOSUN_DESKTOP_API_KEY || "";
      const headers = /** @type {Record<string, string>} */ ({
        Authorization: `Bearer ${desktopKey}`,
        "Content-Type": "application/json",
      });
      if (body) headers["Content-Length"] = String(Buffer.byteLength(body));
      const req = (isHttps ? httpsRequest : httpRequest)(
        urlStr,
        { method, headers, timeout: 5000, rejectUnauthorized: !shouldSkipTlsVerification(urlStr) },
        (res) => {
          let buf = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => { buf += chunk; });
          res.on("end", () => {
            try { resolve(JSON.parse(buf)); }
            catch { resolve(null); }
          });
        },
      );
      req.on("error", () => resolve(null));
      req.on("timeout", () => { req.destroy(); resolve(null); });
      if (body) req.write(body);
      req.end();
    } catch {
      resolve(null);
    }
  });
}

/**
 * Fetch workspace list from the UI server and update the module-scope cache.
 * Respects a 30-second TTL to avoid hammering the server.
 * @param {{ force?: boolean }} [opts]
 */
async function fetchWorkspaces({ force = false } = {}) {
  if (!uiOrigin) return _cachedWorkspaces;
  const now = Date.now();
  if (!force && _workspaceCacheAt > 0 && now - _workspaceCacheAt < WORKSPACE_CACHE_TTL_MS) {
    return _cachedWorkspaces;
  }
  const data = await uiServerRequest(`${uiOrigin}/api/workspaces`);
  if (data?.ok && Array.isArray(data.data)) {
    _cachedWorkspaces = data.data;
    _cachedActiveWorkspaceId = data.activeId || null;
    _workspaceCacheAt = Date.now();
  }
  return _cachedWorkspaces;
}

/**
 * Switch the active workspace and refresh menus.
 * @param {string} workspaceId
 */
async function switchWorkspace(workspaceId) {
  if (!uiOrigin || !workspaceId) return { ok: false, error: "workspace unavailable" };
  const body = JSON.stringify({ workspaceId });
  const data = await uiServerRequest(`${uiOrigin}/api/workspaces/active`, {
    method: "POST",
    body,
  });
  if (!data?.ok) {
    return {
      ok: false,
      error: String(data?.error || "workspace switch failed"),
    };
  }
  _cachedActiveWorkspaceId = String(data?.activeId || workspaceId);
  _workspaceCacheAt = 0; // force re-fetch next time
  await fetchWorkspaces({ force: true });
  Menu.setApplicationMenu(buildAppMenu());
  refreshTrayMenu();
  navigateMainWindow("/");
  return { ok: true, activeId: _cachedActiveWorkspaceId };
}

/**
 * Build workspace submenu items from the module-scope cache (sync).
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
function buildWorkspaceSubmenu() {
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const items = [];

  if (_cachedWorkspaces.length === 0) {
    items.push({ label: "Loading workspaces\u2026", enabled: false });
  } else {
    for (const ws of _cachedWorkspaces) {
      const wsId = String(ws.id || "");
      const wsName = String(ws.name || ws.id || "Untitled Workspace");
      const isActive = wsId === _cachedActiveWorkspaceId;
      items.push({
        label: isActive ? `\u2713 ${wsName}` : wsName,
        type: /** @type {const} */ ("normal"),
        enabled: !isActive,
        click: () => {
          switchWorkspace(wsId).catch((err) =>
            console.warn("[desktop] workspace switch failed:", err?.message || err),
          );
        },
      });
    }
  }

  items.push({ type: /** @type {const} */ ("separator") });
  items.push({
    label: "Manage Workspaces\u2026",
    click: () => navigateMainWindow("/settings"),
  });
  items.push({
    label: "Refresh List",
    click: () => {
      fetchWorkspaces({ force: true })
        .then(() => {
          Menu.setApplicationMenu(buildAppMenu());
          refreshTrayMenu();
        })
        .catch(() => {});
    },
  });
  return items;
}

async function reconnectMainWindowToActiveConnection() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  await mainWindow.loadURL(buildLoadingPageUrl("Connecting to Bosun backend..."));
  const uiUrl = await buildUiUrl();
  await mainWindow.loadURL(uiUrl);
}

async function activateDesktopRemoteConnection(connectionId) {
  const current = readRemoteConnectionConfig();
  const connection = Array.isArray(current.connections)
    ? current.connections.find((entry) => entry.id === connectionId)
    : null;
  if (!connection) {
    await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "Backend Connection",
      message: "Saved backend connection not found.",
      buttons: ["OK"],
    });
    return;
  }
  const reachable = await testRemoteEndpoint(connection.endpoint, connection.apiKey);
  if (!reachable.ok) {
    await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "Backend Connection Failed",
      message: `Could not connect to ${connection.name || connection.endpoint}`,
      detail: reachable.error || "Connection failed",
      buttons: ["OK"],
    });
    const updated = await showRemoteConnectionInputDialog({
      endpoint: connection.endpoint,
      apiKey: connection.apiKey,
      introMessage: `Bosun could not reach ${connection.endpoint}. Update this backend connection, test it, then save to continue.`,
    });
    if (!updated?.endpoint) return;
    saveActiveRemoteConnectionEntry({
      id: connection.id,
      name: connection.name,
      endpoint: updated.endpoint,
      apiKey: updated.apiKey,
    });
  } else {
    const next = setActiveRemoteConnection(current, connection.id);
    saveRemoteConnectionConfig(next);
  }
  remoteConnectionActive = true;
  Menu.setApplicationMenu(buildAppMenu());
  refreshTrayMenu();
  await reconnectMainWindowToActiveConnection();
}

async function launchDesktopLocalBackend() {
  const result = await ensureLocalBosunBackendRunning({
    configDir: resolveDesktopConfigDir(),
    env: process.env,
    timeoutMs: 20000,
  });
  if (!result?.ok || !result?.target) {
    await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "Local Backend Launch Failed",
      message: "Bosun could not launch the configured local backend.",
      detail: result?.error || "Local backend did not become reachable.",
      buttons: ["OK"],
    });
    return null;
  }
  saveDesktopLocalConnectionEntry(result.target);
  return result.target;
}

async function activateDesktopLocalConnection(options = {}) {
  if (options.launch === true) {
    const launchedTarget = await launchDesktopLocalBackend();
    if (!launchedTarget) return;
  } else {
    const daemonUrl = await resolveDaemonUiUrl();
    if (daemonUrl) {
      saveDesktopLocalConnectionEntry({ endpoint: daemonUrl });
    }
  }
  const current = readRemoteConnectionConfig();
  saveRemoteConnectionConfig({
    ...current,
    enabled: false,
  });
  remoteConnectionActive = false;
  Menu.setApplicationMenu(buildAppMenu());
  refreshTrayMenu();
  await reconnectMainWindowToActiveConnection();
}

function buildConnectionSubmenu() {
  const current = readRemoteConnectionConfig();
  const connections = Array.isArray(current.connections) ? current.connections : [];
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const items = [];

  items.push({
    label: "Launch Local Backend",
    click: () => {
      activateDesktopLocalConnection({ launch: true }).catch((err) =>
        console.warn("[desktop] local backend launch failed:", err?.message || err),
      );
    },
  });
  items.push({
    label: current.enabled ? "Use Local Backend" : "✓ Use Local Backend",
    enabled: current.enabled,
    click: () => {
      activateDesktopLocalConnection().catch((err) =>
        console.warn("[desktop] local backend activation failed:", err?.message || err),
      );
    },
  });
  items.push({ type: /** @type {const} */ ("separator") });

  if (connections.length === 0) {
    items.push({ label: "No saved remote backends", enabled: false });
  } else {
    for (const connection of connections) {
      const isActive = current.enabled && connection.id === current.activeConnectionId;
      items.push({
        label: isActive ? `✓ ${connection.name}` : connection.name,
        enabled: !isActive,
        click: () => {
          activateDesktopRemoteConnection(connection.id).catch((err) =>
            console.warn("[desktop] remote backend activation failed:", err?.message || err),
          );
        },
      });
    }
  }

  items.push({ type: /** @type {const} */ ("separator") });
  items.push({
    label: "Manage Backend Connections…",
    click: async () => {
      const config = await showRemoteConnectionInputDialog({
        introMessage: "Create or update a saved backend connection, test it, then save to connect.",
      });
      if (!config?.endpoint) return;
      saveActiveRemoteConnectionEntry(config);
      remoteConnectionActive = true;
      Menu.setApplicationMenu(buildAppMenu());
      refreshTrayMenu();
      await reconnectMainWindowToActiveConnection();
    },
  });

  return items;
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Navigate the main window's SPA to the given path.
 * Uses the direct `__bosunSetTab` router API when available; falls back to
 * pushState + popstate for robustness during page load.
 */
function navigateMainWindow(path) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  setWindowVisible(mainWindow);
  if (!uiOrigin) return;
  // Derive SPA tab ID from the URL path. The router maps the first path
  // segment directly to a tab identifier (empty segment = "dashboard").
  const seg = String(path || "/").replace(/^\/+/, "").split("/")[0];
  const tabId = seg || "dashboard";
  const safePath = JSON.stringify(path);
  const safeTabId = JSON.stringify(tabId);
  mainWindow.webContents
    .executeJavaScript(
      `(function(){
        var tabId = ${safeTabId};
        var path  = ${safePath};
        // Primary: direct SPA router call (most reliable, bypasses history state issues)
        if (typeof window.__bosunSetTab === 'function') {
          window.__bosunSetTab(tabId);
          return;
        }
        // Fallback: pushState + popstate (for pages still loading)
        if (window.history && window.history.pushState) {
          window.history.pushState({ desktopNav: true }, '', path);
          window.dispatchEvent(new PopStateEvent('popstate', { state: { desktopNav: true } }));
        }
      })()`,
    )
    .catch(() => {});
}

/**
 * Build and return the application menu template.
 * This is called once during bootstrap and can be refreshed when
 * pack status or update state changes, or when workspaces are loaded.
 */
function buildAppMenu() {
  const isMac = process.platform === "darwin";
  const isDev = !app.isPackaged;

  const openUrl = (url) => shell.openExternal(url).catch(() => {});
  const updateActionLabel = desktopUpdateState.installActionLabel;

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    // ── macOS app menu ──────────────────────────────────────────────────────
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: /** @type {const} */ ("about") },
              { type: /** @type {const} */ ("separator") },
              { role: /** @type {const} */ ("services") },
              { type: /** @type {const} */ ("separator") },
              { role: /** @type {const} */ ("hide") },
              { role: /** @type {const} */ ("hideOthers") },
              { role: /** @type {const} */ ("unhide") },
              { type: /** @type {const} */ ("separator") },
              { role: /** @type {const} */ ("quit") },
            ],
          },
        ]
      : []),

    // ── File ────────────────────────────────────────────────────────────────
    {
      label: "File",
      submenu: [
        {
          label: "New Chat",
          accelerator: acc("app.newchat"),
          click: () => navigateMainWindow("/chat"),
        },
        { type: /** @type {const} */ ("separator") },
        isMac
          ? { role: /** @type {const} */ ("close") }
          : { role: /** @type {const} */ ("quit") },
      ],
    },

    // ── Edit ────────────────────────────────────────────────────────────────
    { role: /** @type {const} */ ("editMenu") },

    // ── View ────────────────────────────────────────────────────────────────
    {
      label: "View",
      submenu: [
        { role: /** @type {const} */ ("reload") },
        { role: /** @type {const} */ ("forceReload") },
        { type: /** @type {const} */ ("separator") },
        { role: /** @type {const} */ ("resetZoom") },
        { role: /** @type {const} */ ("zoomIn") },
        { role: /** @type {const} */ ("zoomOut") },
        { type: /** @type {const} */ ("separator") },
        { role: /** @type {const} */ ("togglefullscreen") },
        ...(isDev
          ? [
              { type: /** @type {const} */ ("separator") },
              { role: /** @type {const} */ ("toggleDevTools") },
            ]
          : []),
      ],
    },

    // ── Go (full SPA navigation) ─────────────────────────────────────────────
    {
      label: "Go",
      submenu: [
        {
          label: "Dashboard",
          accelerator: acc("bosun.navigate.home"),
          click: () => navigateMainWindow("/"),
        },
        {
          label: "Chat \u0026 Sessions",
          accelerator: acc("bosun.navigate.chat"),
          click: () => navigateMainWindow("/chat"),
        },
        {
          label: "Tasks",
          accelerator: acc("bosun.navigate.tasks"),
          click: () => navigateMainWindow("/tasks"),
        },
        {
          label: "Workflows",
          accelerator: acc("bosun.navigate.workflows"),
          click: () => navigateMainWindow("/workflows"),
        },
        {
          label: "Agents",
          accelerator: acc("bosun.navigate.agents"),
          click: () => navigateMainWindow("/agents"),
        },
        {
          label: "Fleet Sessions",
          accelerator: acc("bosun.navigate.fleet"),
          click: () => navigateMainWindow("/fleet-sessions"),
        },
        {
          label: "Control Panel",
          accelerator: acc("bosun.navigate.control"),
          click: () => navigateMainWindow("/control"),
        },
        {
          label: "Infrastructure",
          accelerator: acc("bosun.navigate.infra"),
          click: () => navigateMainWindow("/infra"),
        },
        {
          label: "Logs",
          accelerator: acc("bosun.navigate.logs"),
          click: () => navigateMainWindow("/logs"),
        },
        {
          label: "Library",
          accelerator: acc("bosun.navigate.library"),
          click: () => navigateMainWindow("/library"),
        },
        {
          label: "Telemetry",
          accelerator: acc("bosun.navigate.telemetry"),
          click: () => navigateMainWindow("/telemetry"),
        },
        { type: /** @type {const} */ ("separator") },
        {
          label: "Settings",
          accelerator: acc("app.settings"),
          click: () => navigateMainWindow("/settings"),
        },
      ],
    },

    // ── Workspace ────────────────────────────────────────────────────────────
    {
      label: "Workspace",
      submenu: buildWorkspaceSubmenu(),
    },
    {
      label: "Backend Connections",
      submenu: buildConnectionSubmenu(),
    },

    // ── Bosun ───────────────────────────────────────────────────────────────
    {
      label: "Bosun",
      submenu: [
        {
          label: "Show Main Window",
          accelerator: acc("bosun.focus"),
          click: () => setWindowVisible(mainWindow),
        },
        {
          label: "Voice Call",
          accelerator: acc("bosun.voice.call"),
          click: () => openFollowWindow({ call: "voice" }).catch(() => {}),
        },
        {
          label: "Video Call",
          accelerator: acc("bosun.voice.video"),
          click: () => openFollowWindow({ call: "video" }).catch(() => {}),
        },
        {
          label: "Toggle Voice Companion",
          accelerator: acc("bosun.voice.toggle"),
          click: () => {
            if (!restoreFollowWindow()) setWindowVisible(mainWindow);
          },
        },
        { type: /** @type {const} */ ("separator") },
        {
          label: updateActionLabel,
          enabled: !desktopUpdateState.checking,
          click: () => {
            if (desktopUpdateState.downloaded) {
              installDownloadedPackagedUpdate().catch(() => {});
              return;
            }
            checkForUpdateDesktop({ interactive: true, source: "menu" }).catch(() => {});
          },
        },
        {
          label: "About Bosun Desktop",
          click: () => showAboutDialog().catch(() => {}),
        },
      ],
    },

    // ── Window ──────────────────────────────────────────────────────────────
    { role: /** @type {const} */ ("windowMenu") },

    // ── Help ────────────────────────────────────────────────────────────────
    {
      role: /** @type {const} */ ("help"),
      submenu: [
        {
          label: "About Bosun Desktop",
          click: () => showAboutDialog().catch(() => {}),
        },
        { type: /** @type {const} */ ("separator") },
        {
          label: "Bosun Documentation",
          click: () => openUrl("https://github.com/virtengine/bosun#readme"),
        },
        {
          label: "GitHub Repository",
          click: () => openUrl("https://github.com/virtengine/bosun"),
        },
        {
          label: "Report an Issue",
          click: () =>
            openUrl("https://github.com/virtengine/bosun/issues/new"),
        },
        { type: /** @type {const} */ ("separator") },
        {
          label: "Keyboard Shortcuts",
          accelerator: acc("bosun.show.shortcuts"),
          click: () => showShortcutsDialog(),
        },
        { type: /** @type {const} */ ("separator") },
        {
          label: "Toggle Developer Tools",
          accelerator: isMac ? "Alt+Cmd+I" : "Ctrl+Shift+I",
          click: () => mainWindow?.webContents?.toggleDevTools(),
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

async function loadBosunModule(file) {
  const modulePath = resolveBosunRuntimePath(file);
  return import(pathToFileURL(modulePath).href);
}

async function loadRuntimeConfig() {
  if (runtimeConfigLoaded) return;
  try {
    const config = await loadBosunModule("config/config.mjs");
    if (typeof config?.loadConfig === "function") {
      config.loadConfig(["node", "desktop"], { reloadEnv: true });
    }
  } catch (err) {
    console.warn("[desktop] failed to load config env", err?.message || err);
  }
  runtimeConfigLoaded = true;
}

async function loadUiServerModule() {
  if (uiApi) return uiApi;
  uiApi = await loadBosunModule("server/ui-server.mjs");
  return uiApi;
}

function buildDaemonUiBaseUrl() {
  const savedLocal = readRemoteConnectionConfig().localConnection || null;
  let rawPort = Number(process.env.TELEGRAM_UI_PORT || "");
  // If TELEGRAM_UI_PORT isn't in the process env, try reading it from the
  // bosun module's .env so the desktop detects the daemon's actual port even
  // when launched outside the bosun working directory.
  if (!(Number.isFinite(rawPort) && rawPort > 0)) {
    try {
      const bosunRoot = resolveBosunRoot();
      const envCandidates = [
        resolve(bosunRoot, ".bosun", ".env"),
        resolve(bosunRoot, ".env"),
      ];
      for (const envPath of envCandidates) {
        if (!existsSync(envPath)) continue;
        const content = readFileSync(envPath, "utf8");
        const match = content.match(/^TELEGRAM_UI_PORT\s*=\s*(\d+)/m);
        if (match) {
          rawPort = Number(match[1]);
          break;
        }
      }
    } catch { /* ignore */ }
  }
  const port = Number.isFinite(rawPort) && rawPort > 0
    ? rawPort
    : Number(savedLocal?.port || 0) > 0
      ? Number(savedLocal.port)
      : DEFAULT_TELEGRAM_UI_PORT;
  const tlsDisabled = parseBoolEnv(process.env.TELEGRAM_UI_TLS_DISABLE, false);
  const protocol = tlsDisabled
    ? "http"
    : String(savedLocal?.httpProtocol || "").trim() || "https";
  const host =
    process.env.TELEGRAM_UI_DESKTOP_HOST ||
    process.env.TELEGRAM_UI_HOST ||
    savedLocal?.host ||
    "127.0.0.1";
  return `${protocol}://${host}:${port}`;
}

async function probeUiServer(url) {
  return new Promise((resolve) => {
    try {
      const isHttps = url.startsWith("https://");
      const req = (isHttps ? httpsRequest : httpRequest)(
        `${url}/api/status`,
        {
          method: "GET",
          timeout: 1500,
          rejectUnauthorized: !shouldSkipTlsVerification(url),
        },
        (res) => {
          res.resume();
          resolve(Boolean(res.statusCode && res.statusCode < 500));
        },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    } catch {
      resolve(false);
    }
  });
}

/** Set to true if the daemon UI was not reachable at startup (offline mode). */
let bosunDaemonWasOffline = false;

async function resolveDaemonUiUrl() {
  const useDaemon = parseBoolEnv(
    process.env.BOSUN_DESKTOP_USE_DAEMON_UI,
    true,
  );
  if (!useDaemon) return null;
  const base = buildDaemonUiBaseUrl();
  if (!base) return null;
  const ok = await probeUiServer(base);
  return ok ? base : null;
}

/**
 * Wait for the daemon UI endpoint to become reachable.
 */
async function waitForDaemonUi(baseUrl, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeUiServer(baseUrl)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  return false;
}

function spawnDetachedDaemon() {
  const cliPath = resolveBosunRuntimePath("cli.mjs");
  if (!existsSync(cliPath)) {
    throw new Error(`CLI not found at ${cliPath}`);
  }
  const bosunRoot = resolveBosunRoot();
  // Resolve the config directory so the spawned daemon loads the correct
  // .env (TELEGRAM_UI_PORT, TELEGRAM_MINIAPP_ENABLED, etc.) and workspace
  // configuration, regardless of which CWD the desktop app was launched from.
  const configDirCandidates = [
    resolve(bosunRoot, ".bosun"),
    bosunRoot,
  ];
  const configDir = configDirCandidates.find((d) =>
    existsSync(resolve(d, ".env")) || existsSync(resolve(d, "bosun.config.json")),
  );
  const spawnArgs = [cliPath, "--daemon", "--no-update-check"];
  if (configDir) {
    spawnArgs.push("--config-dir", configDir);
  }
  const child = spawn(
    process.execPath,
    spawnArgs,
    {
      cwd: bosunRoot,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        BOSUN_DESKTOP_SPAWNED_DAEMON: "1",
      },
    },
  );
  child.unref();
  return child.pid;
}

/**
 * Ensure the daemon is running when desktop starts.
 *
 * Default behaviour: auto-start enabled.
 * Opt-out: BOSUN_DESKTOP_AUTO_START_DAEMON=0
 */
async function ensureDaemonRunning() {
  const daemonBaseUrl = buildDaemonUiBaseUrl();
  if (await probeUiServer(daemonBaseUrl)) return;

  // Also try common alternative ports — the daemon may be running on a
  // different port than DEFAULT_TELEGRAM_UI_PORT if it loaded its own .env.
  const altPorts = [4400, 3080, 3443].filter(
    (p) => !daemonBaseUrl.includes(`:${p}`),
  );
  for (const port of altPorts) {
    const altUrl = daemonBaseUrl.replace(/:\d+$/, `:${port}`);
    if (await probeUiServer(altUrl)) {
      console.log(`[desktop] found running daemon on alternative port ${port}`);
      return;
    }
  }

  const ghostPids = findGhostDaemonPids();
  // If a daemon is starting naturally, give it a short window first.
  const existingPid = getDaemonPid();
  if ((existingPid || ghostPids.length > 0) && await waitForDaemonUi(daemonBaseUrl, 5000)) {
    return;
  }

  // If we found a running bosun process but its UI isn't responding,
  // log a warning so it's diagnosable — the process may have been started
  // without TELEGRAM_UI_PORT set.
  if (existingPid || ghostPids.length > 0) {
    const pids = [existingPid, ...ghostPids].filter(Boolean);
    console.log(
      `[desktop] existing bosun process(es) detected (PIDs: ${pids.join(", ")}) ` +
      `but UI not reachable at ${daemonBaseUrl} — may have been started without TELEGRAM_UI_PORT`,
    );
    bosunDaemonWasOffline = true;
    return;
  }

  const autoStart = parseBoolEnv(process.env.BOSUN_DESKTOP_AUTO_START_DAEMON, true);
  if (!autoStart) return;

  try {
    const pid = spawnDetachedDaemon();
    console.log(`[desktop] started bosun daemon in background (pid ${pid})`);
  } catch (error) {
    console.warn("[desktop] failed to auto-start daemon:", error?.message || error);
    return;
  }

  // Best effort wait. If it still isn't up we'll fall back to local UI mode.
  await waitForDaemonUi(daemonBaseUrl, 15000);
}

async function startUiServer() {
  if (uiServerStarted) return;
  const api = await loadUiServerModule();
  const server = await api.startTelegramUiServer({
    host: "127.0.0.1",
    publicHost: "127.0.0.1",
    skipAutoOpen: true,
    dependencies: {
      configDir: resolveDesktopConfigDir(),
    },
  });
  if (!server) {
    throw new Error("Failed to start Telegram UI server.");
  }
  uiServerStarted = true;
}

async function buildUiUrl() {
  await loadRuntimeConfig();

  // ── Check for active remote connection config ──
  const remote = readRemoteConnectionConfig();
  if (remote.enabled && remote.endpoint) {
    const reachable = await probeRemoteEndpoint(remote.endpoint, remote.apiKey);
    if (reachable) {
      console.log("[desktop] using remote Bosun endpoint:", remote.endpoint);
      remoteConnectionActive = true;
      const remoteTarget = new URL(remote.endpoint);
      uiOrigin = remoteTarget.origin;
      // Do NOT put the API key in the URL — it leaks into logs, window
      // history, crash reports, and Referer headers.  The desktop auth
      // header bridge (installDesktopAuthHeaderBridge) injects X-API-Key
      // on every request to this origin automatically.
      return remoteTarget.toString();
    }
    if (mainWindow && !remoteConnectionPromptOpen) {
      remoteConnectionPromptOpen = true;
      try {
        const config = await showRemoteConnectionInputDialog({
          endpoint: remote.endpoint,
          apiKey: remote.apiKey,
          introMessage: `Bosun could not reach ${remote.endpoint}. Update the remote connection, test it, then save to continue.`,
        });
        if (config?.endpoint) {
          saveActiveRemoteConnectionEntry(config);
          const retryRemote = await probeRemoteEndpoint(config.endpoint, config.apiKey);
          if (retryRemote) {
            console.log("[desktop] using updated remote Bosun endpoint:", config.endpoint);
            remoteConnectionActive = true;
            const remoteTarget = new URL(config.endpoint);
            uiOrigin = remoteTarget.origin;
            return remoteTarget.toString();
          }
        }
      } finally {
        remoteConnectionPromptOpen = false;
      }
    }
    console.warn("[desktop] remote endpoint unreachable, falling back to local");
    remoteConnectionActive = false;
  }

  const daemonUrl = await resolveDaemonUiUrl();
  if (daemonUrl) {
    uiOrigin = new URL(daemonUrl).origin;
    // The desktop auth header bridge injects Authorization: Bearer <key>
    // on every request, so the initial page load will carry the header.
    // The server validates the header and sets a ve_session cookie, making
    // subsequent in-page fetches authenticated without URL secrets.
    const desktopKey = ensureDesktopApiKeyInEnv();
    if (!desktopKey) {
      console.warn("[desktop] BOSUN_DESKTOP_API_KEY unavailable; daemon UI may return 401 until auth bootstrap succeeds");
    }
    return daemonUrl;
  }
  // Daemon is not reachable — flag it so the window can show an offline banner.
  bosunDaemonWasOffline = true;
  await startUiServer();
  const api = await loadUiServerModule();
  const uiServerUrl = api.getTelegramUiUrl();
  if (!uiServerUrl) {
    throw new Error("Telegram UI server URL is unavailable.");
  }
  const targetUrl = new URL(uiServerUrl);
  uiOrigin = targetUrl.origin;
  // Auth is handled by the header bridge. For the local embedded server,
  // the request arrives with Authorization: Bearer <desktopKey> and the
  // server validates + sets a ve_session cookie.  No URL secrets needed.
  return targetUrl.toString();
}

/* ── Launch-time connection dialogs ──────────────────────────── */

/**
 * Show a dialog asking the user how to proceed when no local daemon is found.
 * Returns "local" | "remote" | "offline".
 */
async function showConnectionChoiceDialog() {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "question",
    title: "Bosun — No Running Instance Detected",
    message: "Bosun couldn't find a running daemon.\nHow would you like to proceed?",
    detail: [
      "• Launch Local Backend — start or reconnect the configured Bosun daemon",
      "• Connect to Remote — connect to an external Bosun instance (Docker, VM, cloud)",
      "• Continue Offline — open the portal in offline mode",
    ].join("\n"),
    buttons: ["Launch Local Backend", "Connect to Remote", "Continue Offline"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (response === 1) return "remote";
  if (response === 2) return "offline";
  return "local";
}

/**
 * Prompt the user for a remote Bosun endpoint URL and API key.
 * Returns { endpoint, apiKey } or null if cancelled.
 */
async function showRemoteConnectionInputDialog(options = {}) {
  const existing = readRemoteConnectionConfig();
  const savedConnections = Array.isArray(existing.connections) ? existing.connections : [];
  const initialEndpoint = String(options.endpoint ?? existing.endpoint ?? "https://").trim() || "https://";
  const initialApiKey = String(options.apiKey ?? existing.apiKey ?? "").trim();
  const introMessage = String(
    options.introMessage
      || "Configure the Bosun endpoint, test it, then save to connect.",
  ).trim();
  return new Promise((resolvePromise) => {
    const parent = mainWindow || undefined;
    const inputWin = new BrowserWindow({
      width: 640,
      height: 460,
      resizable: false,
      minimizable: false,
      maximizable: false,
      modal: !!parent,
      parent,
      show: false,
      backgroundColor: "#1a1a2e",
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: join(__dirname, "preload.cjs"),
      },
    });
    const escapeHtml = (value) =>
      String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    const escapedEndpoint = escapeHtml(initialEndpoint);
    const escapedApiKey = escapeHtml(initialApiKey);
    const escapedIntro = escapeHtml(introMessage);
    const escapedConnectionsJson = escapeHtml(JSON.stringify(savedConnections));
    const escapedActiveConnectionId = escapeHtml(existing.activeConnectionId || "");
    const html = `data:text/html;charset=utf-8,${encodeURIComponent(`<!DOCTYPE html>
<html><head><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         background: #1a1a2e; color: #e0e0e0; padding: 20px; display: flex;
         flex-direction: column; gap: 14px; height: 100vh; }
  h1 { font-size: 20px; font-weight: 700; }
  p { color: #b9bfd6; }
  label { display: block; margin-bottom: 8px; font-weight: 600; }
  input { width: 100%; padding: 8px 12px; font-size: 14px; border: 1px solid #444;
          border-radius: 6px; background: #0f0f23; color: #e0e0e0; outline: none; }
  input:focus { border-color: #6366f1; }
  .panel { border: 1px solid #2c3254; border-radius: 10px; padding: 14px; background: rgba(15,15,35,.7); }
  .saved { display: flex; flex-direction: column; gap: 8px; max-height: 120px; overflow: auto; }
  .saved button { text-align: left; width: 100%; }
  .status { min-height: 48px; border-radius: 8px; padding: 10px 12px; background: #111827; color: #d1d5db; }
  .status.success { background: rgba(6, 78, 59, .65); color: #bbf7d0; }
  .status.error { background: rgba(127, 29, 29, .7); color: #fecaca; }
  .status.pending { background: rgba(30, 64, 175, .55); color: #bfdbfe; }
  .btns { display: flex; gap: 10px; justify-content: flex-end; margin-top: auto; }
  button { padding: 8px 20px; border: none; border-radius: 6px; font-size: 14px;
           cursor: pointer; font-weight: 500; }
  .ghost { background: #1f2937; color: #d1d5db; }
  .ghost:hover { background: #374151; }
  .ok { background: #4f46e5; color: #fff; }
  .ok:hover { background: #6366f1; }
  .cancel { background: #333; color: #ccc; }
  .cancel:hover { background: #444; }
</style></head><body>
  <h1>Remote Bosun Connection</h1>
  <p>${escapedIntro}</p>
  <div class="panel">
    <label for="endpoint">Endpoint URL</label>
    <input id="endpoint" type="text" value="${escapedEndpoint}" placeholder="https://bosun.example.com:4400" autofocus />
  </div>
  <div class="panel">
    <label for="apiKey">API Key</label>
    <input id="apiKey" type="password" value="${escapedApiKey}" placeholder="Leave empty if auth is disabled" />
  </div>
  <div class="panel">
    <label>Saved Connections</label>
    <div id="savedConnections" class="saved"></div>
  </div>
  <div id="status" class="status">Test the connection before saving.</div>
  <div class="btns">
    <button class="ghost" id="testBtn" onclick="runTest()">Test Connection</button>
    <button class="cancel" onclick="closeDialog()">Cancel</button>
    <button class="ok" id="saveBtn" onclick="saveAndConnect()">Save & Connect</button>
  </div>
  <script>
    const endpointInput = document.getElementById('endpoint');
    const apiKeyInput = document.getElementById('apiKey');
    const savedConnectionsEl = document.getElementById('savedConnections');
    const statusEl = document.getElementById('status');
    const testBtn = document.getElementById('testBtn');
    const saveBtn = document.getElementById('saveBtn');
    const savedConnections = JSON.parse('${escapedConnectionsJson}');
    let selectedConnectionId = '${escapedActiveConnectionId}';

    function setStatus(message, tone) {
      statusEl.textContent = message;
      statusEl.className = 'status' + (tone ? ' ' + tone : '');
    }

    function setBusy(busy) {
      testBtn.disabled = busy;
      saveBtn.disabled = busy;
      endpointInput.disabled = busy;
      apiKeyInput.disabled = busy;
    }

    function renderSavedConnections() {
      if (!savedConnections.length) {
        savedConnectionsEl.innerHTML = '<div style="color:#9ca3af">No saved connections yet.</div>';
        return;
      }
      savedConnectionsEl.innerHTML = savedConnections.map((connection) => {
        const active = connection.id === selectedConnectionId;
        return '<button class="' + (active ? 'ok' : 'ghost') + '" data-connection-id="' + connection.id + '">' +
          connection.name + (active ? ' [active]' : '') + ' → ' + connection.endpoint +
          '</button>';
      }).join('');
      savedConnectionsEl.querySelectorAll('button[data-connection-id]').forEach((button) => {
        button.addEventListener('click', () => {
          const connection = savedConnections.find((entry) => entry.id === button.dataset.connectionId);
          if (!connection) return;
          selectedConnectionId = connection.id;
          endpointInput.value = connection.endpoint || '';
          apiKeyInput.value = connection.apiKey || '';
          renderSavedConnections();
          setStatus('Loaded saved connection ' + connection.name + '.', '');
        });
      });
    }

    async function runTest() {
      const endpoint = endpointInput.value.trim();
      const apiKey = apiKeyInput.value;
      if (!endpoint) {
        setStatus('Endpoint URL is required.', 'error');
        return false;
      }
      setBusy(true);
      setStatus('Testing remote connection...', 'pending');
      try {
        const result = await window.veDesktop.connection.test(endpoint, apiKey);
        if (result?.reachable) {
          setStatus('Connection successful. You can now save and connect.', 'success');
          return true;
        }
        setStatus(result?.error || 'Connection failed.', 'error');
        return false;
      } catch (error) {
        setStatus(error?.message || 'Connection test failed.', 'error');
        return false;
      } finally {
        setBusy(false);
      }
    }

    async function saveAndConnect() {
      const endpoint = endpointInput.value.trim();
      const apiKey = apiKeyInput.value;
      const ok = await runTest();
      if (!ok) return;
      setBusy(true);
      try {
        const saved = await window.veDesktop.connection.set({ enabled: true, endpoint, apiKey });
        if (!saved?.ok) {
          setStatus(saved?.error || 'Failed to save the connection.', 'error');
          return;
        }
        document.title = 'RESULT:' + encodeURIComponent(JSON.stringify({
          id: selectedConnectionId || '',
          endpoint,
          apiKey,
        }));
      } finally {
        setBusy(false);
      }
    }

    function closeDialog() { document.title = 'CANCEL'; }

    endpointInput.select();
    renderSavedConnections();
    endpointInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDialog(); });
    apiKeyInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDialog(); });
  </script>
</body></html>`)}`;

    inputWin.loadURL(html);
    inputWin.once("ready-to-show", () => inputWin.show());

    inputWin.webContents.on("page-title-updated", (_ev, newTitle) => {
      if (newTitle.startsWith("RESULT:")) {
        const raw = decodeURIComponent(newTitle.slice(7).trim());
        inputWin.destroy();
        try {
          const parsed = JSON.parse(raw);
          resolvePromise({
            id: String(parsed?.id || "").trim(),
            endpoint: String(parsed?.endpoint || "").trim(),
            apiKey: String(parsed?.apiKey || "").trim(),
          });
        } catch {
          resolvePromise(null);
        }
      } else if (newTitle === "CANCEL") {
        inputWin.destroy();
        resolvePromise(null);
      }
    });

    inputWin.on("closed", () => resolvePromise(null));
  });
}

async function createMainWindow() {
  if (mainWindow) return;
  const iconPath = resolveDesktopIconPath();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0b0b0c",
    ...(iconPath && existsSync(iconPath) ? { icon: iconPath } : {}),
    show: false,
    // In tray mode Windows/Linux should not show a taskbar button for the
    // hidden state — the tray icon IS the taskbar presence.
    skipTaskbar: Boolean(trayMode && startHidden),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, "preload.cjs"),
    },
  });

  mainWindow.on("close", (event) => {
    // Programmatic quit — let it through.
    if (shuttingDown) return;
    event.preventDefault();
    if (mainWindow?.isMinimized()) return;

    // Show an exit dialog so the user can choose what to do.
    dialog
      .showMessageBox(mainWindow, {
        type: "question",
        title: "Close Bosun",
        message: "What would you like to do?",
        buttons: ["Hide to Taskbar", "Exit Bosun", "Cancel"],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      })
      .then(({ response }) => {
        if (response === 0) {
          // Hide to taskbar / system tray
          mainWindow?.hide();
          if (trayMode && process.platform === "darwin") {
            app.dock?.hide();
          }
        } else if (response === 1) {
          // Full exit
          void shutdown("user_exit");
        }
        // response === 2 → Cancel — do nothing
      })
      .catch(() => {});
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.once("ready-to-show", () => {
    if (!startHidden) {
      mainWindow?.show();
    }
  });

  // When the window is shown again, make it appear in the taskbar on
  // Windows / Linux and restore the macOS dock icon.
  mainWindow.on("show", () => {
    mainWindow?.setSkipTaskbar(false);
    if (process.platform === "darwin") {
      app.dock?.show();
    }
  });

  // Always render an in-app loading screen first so startup latency
  // (daemon boot, TLS init, server warm-up) is visible to the user.
  await mainWindow.loadURL(buildLoadingPageUrl("Starting Bosun services..."));
  await setLoadingMessage("Preparing background daemon...");
  await ensureDaemonRunning();

  // ── If daemon is offline, check remote config or prompt user ──
  if (bosunDaemonWasOffline) {
    const remote = readRemoteConnectionConfig();
    const remoteReachable = remote.enabled && remote.endpoint
      ? await probeRemoteEndpoint(remote.endpoint, remote.apiKey)
      : false;

    if (!remoteReachable && !(remote.enabled && remote.endpoint)) {
      await setLoadingMessage("No running Bosun instance detected...");
      const choice = await showConnectionChoiceDialog();
      if (choice === "local") {
        await activateDesktopLocalConnection({ launch: true });
      } else if (choice === "remote") {
        const config = await showRemoteConnectionInputDialog();
        if (config) {
          saveActiveRemoteConnectionEntry(config);
        }
      }
      // "offline" choice: continue with in-process server
    }
  }

  await setLoadingMessage("Connecting to Bosun portal...");
  const uiUrl = await buildUiUrl();
  await mainWindow.loadURL(uiUrl);

  // If the daemon UI is still offline after startup checks/auto-start, inject
  // a non-blocking banner so the user has clear recovery instructions.
  if (bosunDaemonWasOffline) {
    mainWindow.webContents.once("did-finish-load", () => {
      mainWindow?.webContents
        .executeJavaScript(
          `(function() {
            if (document.getElementById('bosun-offline-banner')) return;
            const b = document.createElement('div');
            b.id = 'bosun-offline-banner';
            b.style.cssText = [
              'position:fixed','top:0','left:0','right:0','z-index:99999',
              'background:#7f1d1d','color:#fff','padding:10px 16px',
              'font:13px/1.5 monospace','display:flex','gap:12px',
              'align-items:center','justify-content:space-between',
            ].join(';');
            b.innerHTML = [
              '<span>',
              '\u26a0\ufe0f <strong>Bosun daemon is not reachable.</strong>',
              ' This portal is in local mode — agents & tasks from your background service are unavailable.',
              ' Start it: ',
              '<code style="background:rgba(255,255,255,.15);padding:2px 6px;border-radius:3px">bosun --daemon</code>',
              ' &bull; Configure auto-start: ',
              '<code style="background:rgba(255,255,255,.15);padding:2px 6px;border-radius:3px">bosun --setup</code>',
              '</span>',
              '<button onclick="document.getElementById(\'bosun-offline-banner\').remove()"',
              ' style="background:none;border:none;color:#fff;cursor:pointer;font-size:20px;line-height:1;padding:0 4px">&times;</button>',
            ].join(' ');
            document.body.prepend(b);
          })()`
        )
        .catch(() => {});
    });
  }
}

async function createFollowWindow() {
  if (followWindow && !followWindow.isDestroyed()) return followWindow;
  const iconPath = resolveDesktopIconPath();
  followWindow = new BrowserWindow({
    width: 420,
    height: 640,
    minWidth: 340,
    minHeight: 440,
    backgroundColor: "#0b0b0c",
    ...(iconPath && existsSync(iconPath) ? { icon: iconPath } : {}),
    show: false,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    skipTaskbar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      preload: join(__dirname, "preload.cjs"),
    },
  });

  followWindow.setAlwaysOnTop(true, "floating", 1);

  followWindow.on("close", (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    followWindow?.hide();
  });

  followWindow.on("closed", () => {
    followWindow = null;
    followWindowLaunchSignature = "";
  });

  followWindow.once("ready-to-show", () => {
    anchorFollowWindow(followWindow);
    setWindowVisible(followWindow);
  });

  followWindow.on("show", () => {
    followWindow?.setAlwaysOnTop(true, "floating", 1);
    anchorFollowWindow(followWindow);
  });

  followWindow.on("resized", () => {
    anchorFollowWindow(followWindow);
  });

  return followWindow;
}

async function openFollowWindow(detail = {}) {
  const win = await createFollowWindow();
  const baseUiUrl = await buildUiUrl();
  const target = buildFollowWindowUrl(baseUiUrl, detail);
  // Append a cache-buster timestamp so every Call press produces a unique URL.
  // Without this, a second Call press with the same parameters would match
  // followWindowLaunchSignature and skip loadURL — leaving the follow window
  // in its previous dead state (launch params already scrubbed, voice overlay
  // closed, useEffect([], []) already fired and won't re-run).
  target.searchParams.set("t", String(Date.now()));
  const signature = target.toString();
  followWindowLaunchSignature = signature;
  await win.loadURL(signature);
  anchorFollowWindow(win);
  setWindowVisible(win);
}

function hideFollowWindow() {
  if (!followWindow || followWindow.isDestroyed()) return false;
  followWindow.hide();
  return true;
}

function restoreFollowWindow() {
  if (!followWindow || followWindow.isDestroyed()) return false;
  setWindowVisible(followWindow);
  return true;
}

/** Rebuild and apply the tray context menu (called after state changes). */
function refreshTrayMenu() {
  if (!tray) return;

  const openUrl = (url) => shell.openExternal(url).catch(() => {});
  const isDev = !app.isPackaged;
  const updateActionLabel = desktopUpdateState.installActionLabel;

  // Build workspace items from the module-scope cache
  const workspaceItems = /** @type {Electron.MenuItemConstructorOptions[]} */ ([]);
  if (_cachedWorkspaces.length > 0) {
    for (const ws of _cachedWorkspaces) {
      const wsId = String(ws.id || "");
      const wsName = String(ws.name || ws.id || "Untitled Workspace");
      const isActive = wsId === _cachedActiveWorkspaceId;
      workspaceItems.push({
        label: isActive ? `\u2713 ${wsName}` : wsName,
        type: /** @type {const} */ ("normal"),
        enabled: !isActive,
        click: () => {
          switchWorkspace(wsId).catch((err) =>
            console.warn("[desktop] workspace switch failed:", err?.message || err),
          );
        },
      });
    }
  }

  const menu = Menu.buildFromTemplate([
    // ── Identity header ──────────────────────────────────────────────────
    {
      label: "VirtEngine",
      enabled: false,
    },
    {
      label: "Show Window",
      click: () => setWindowVisible(mainWindow),
    },
    { type: /** @type {const} */ ("separator") },

    // ── Navigation ───────────────────────────────────────────────────────
    {
      label: "Go To",
      submenu: [
        {
          label: "Dashboard",
          click: () => navigateMainWindow("/"),
        },
        {
          label: "Chat \u0026 Sessions",
          click: () => navigateMainWindow("/chat"),
        },
        {
          label: "Tasks",
          click: () => navigateMainWindow("/tasks"),
        },
        {
          label: "Workflows",
          click: () => navigateMainWindow("/workflows"),
        },
        {
          label: "Agents",
          click: () => navigateMainWindow("/agents"),
        },
        {
          label: "Fleet Sessions",
          click: () => navigateMainWindow("/fleet-sessions"),
        },
        {
          label: "Control Panel",
          click: () => navigateMainWindow("/control"),
        },
        {
          label: "Infrastructure",
          click: () => navigateMainWindow("/infra"),
        },
        {
          label: "Logs",
          click: () => navigateMainWindow("/logs"),
        },
        { type: /** @type {const} */ ("separator") },
        {
          label: "Settings",
          accelerator: acc("app.settings"),
          click: () => navigateMainWindow("/settings"),
        },
      ],
    },

    // ── Workspace ────────────────────────────────────────────────────────
    ...(workspaceItems.length > 0
      ? [
          {
            label: "Workspace",
            submenu: [
              ...workspaceItems,
              { type: /** @type {const} */ ("separator") },
              {
                label: "Manage Workspaces\u2026",
                click: () => navigateMainWindow("/settings"),
              },
            ],
          },
        ]
      : []),
    {
      label: "Backend Connections",
      submenu: buildConnectionSubmenu(),
    },

    // ── Voice ────────────────────────────────────────────────────────────
    {
      label: "Voice Companion",
      accelerator: acc("bosun.voice.toggle"),
      click: () => {
        if (!restoreFollowWindow()) setWindowVisible(mainWindow);
      },
    },
    {
      label: "Voice Call",
      click: () => openFollowWindow({ call: "voice" }).catch(() => {}),
    },
    { type: /** @type {const} */ ("separator") },

    {
      label: updateActionLabel,
      enabled: !desktopUpdateState.checking,
      click: () => {
        if (desktopUpdateState.downloaded) {
          installDownloadedPackagedUpdate().catch(() => {});
          return;
        }
        checkForUpdateDesktop({ interactive: true, source: "tray" }).catch(() => {});
      },
    },
    {
      label: "About Bosun Desktop",
      click: () => showAboutDialog().catch(() => {}),
    },

    // ── Troubleshooting ──────────────────────────────────────────────────
    {
      label: "Troubleshooting",
      submenu: [
        {
          label: "Reload UI",
          click: () => mainWindow?.webContents?.reload(),
        },
        {
          label: "Force Reload UI",
          click: () => mainWindow?.webContents?.reloadIgnoringCache(),
        },
        {
          label: "Clear Cache \u0026 Reload",
          click: async () => {
            try {
              await session.defaultSession.clearCache();
            } catch {
              // best effort
            }
            mainWindow?.webContents?.reloadIgnoringCache();
          },
        },
        { type: /** @type {const} */ ("separator") },
        {
          label: "Toggle Developer Tools",
          enabled: isDev || !app.isPackaged,
          click: () => mainWindow?.webContents?.toggleDevTools(),
        },
        { type: /** @type {const} */ ("separator") },
        {
          label: "View Logs",
          click: () => navigateMainWindow("/logs"),
        },
        {
          label: "Report an Issue",
          click: () =>
            openUrl("https://github.com/virtengine/bosun/issues/new"),
        },
      ],
    },
    { type: /** @type {const} */ ("separator") },

    // ── Startup / login ──────────────────────────────────────────────
    ...(app.isPackaged
      ? [
          {
            label: "Start at Login",
            type: /** @type {const} */ ("checkbox"),
            checked: app.getLoginItemSettings().openAtLogin,
            click: (item) => {
              app.setLoginItemSettings({ openAtLogin: item.checked });
            },
          },
        ]
      : []),
    { type: /** @type {const} */ ("separator") },

    // ── Quit ───────────────────────────────────────────────────────────
    {
      label: "Quit",
      accelerator: process.platform === "darwin" ? "Cmd+Q" : "Ctrl+Q",
      click: () => {
        void shutdown("tray_quit");
      },
    },
  ]);

  tray.setContextMenu(menu);
}

function ensureTray() {
  if (tray) return;
  const iconPath = resolveDesktopIconPath();
  if (!iconPath || !existsSync(iconPath)) return;

  tray = new Tray(iconPath);
  tray.setToolTip("Bosun — AI Control Center");

  refreshTrayMenu();

  // Single click: show/restore the main window (or follow window).
  tray.on("click", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isVisible() && mainWindow.isFocused()) {
        mainWindow.hide();
        if (process.platform === "darwin") app.dock?.hide();
      } else {
        setWindowVisible(mainWindow);
      }
    } else {
      void createMainWindow();
    }
  });

  // Double-click on Windows brings up the window unambiguously.
  tray.on("double-click", () => {
    setWindowVisible(mainWindow);
  });
}

/**
 * Display a native shortcuts reference dialog.
 * Groups shortcuts by their group property so the list is easy to scan.
 */
function showShortcutsDialog() {
  const shortcuts = getAllShortcuts();

  // Group entries
  /** @type {Map<string, typeof shortcuts>} */
  const groups = new Map();
  for (const s of shortcuts) {
    const g = s.group || "Other";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }

  const isMac = process.platform === "darwin";
  const modSymbol = isMac ? "⌘" : "Ctrl";
  const shiftSym = isMac ? "⇧" : "+Shift";

  const lines = [];
  for (const [group, items] of groups) {
    lines.push(`── ${group} ──`);
    for (const s of items) {
      const display = s.isDisabled
        ? "(disabled)"
        : (s.accelerator ?? "(none)")
            .replace(/CmdOrCtrl/g, modSymbol)
            .replace(/CommandOrControl/g, modSymbol)
            .replace(/Shift\+/g, `${shiftSym}+`);
      const custom = s.isCustomized ? " ★" : "";
      lines.push(`  ${s.label.padEnd(30)} ${display}${custom}`);
    }
    lines.push("");
  }
  lines.push("★ = customized from default");
  lines.push("");
  lines.push("To customize shortcuts, edit:");
  lines.push(`  ${resolveDesktopConfigDir()}/desktop-shortcuts.json`);

  dialog
    .showMessageBox(mainWindow ?? undefined, {
      type: "info",
      title: "Bosun — Keyboard Shortcuts",
      message: "Keyboard Shortcuts Reference",
      detail: lines.join("\n"),
      buttons: ["OK"],
    })
    .catch(() => {});
}

/**
 * Wire all shortcut action handlers and register global shortcuts.
 * Called once during bootstrap, after the config dir is known.
 *
 * @param {string} configDir
 */
function initAndRegisterShortcuts(configDir) {
  // Initialise the shortcuts manager (loads user customizations).
  initShortcuts(configDir);

  // ── Register action handlers ───────────────────────────────────────────
  // Global: fire from anywhere on the desktop
  onShortcut("bosun.focus", () => {
    setWindowVisible(mainWindow);
  });

  onShortcut("bosun.quickchat", () => {
    setWindowVisible(mainWindow);
    navigateMainWindow("/chat");
  });

  onShortcut("bosun.voice.call", () => {
    openFollowWindow({ call: "voice" }).catch((err) =>
      console.warn("[shortcuts] voice.call failed:", err?.message || err),
    );
  });

  onShortcut("bosun.voice.video", () => {
    openFollowWindow({ call: "video" }).catch((err) =>
      console.warn("[shortcuts] voice.video failed:", err?.message || err),
    );
  });

  onShortcut("bosun.voice.toggle", () => {
    if (!restoreFollowWindow()) setWindowVisible(mainWindow);
  });

  // Local: navigation (also in menu, but registered here for completeness)
  onShortcut("bosun.navigate.home", () => navigateMainWindow("/"));
  onShortcut("bosun.navigate.chat", () => navigateMainWindow("/chat"));
  onShortcut("bosun.navigate.tasks", () => navigateMainWindow("/tasks"));
  onShortcut("bosun.navigate.workflows", () => navigateMainWindow("/workflows"));
  onShortcut("bosun.navigate.agents", () => navigateMainWindow("/agents"));
  onShortcut("bosun.navigate.fleet", () => navigateMainWindow("/fleet-sessions"));
  onShortcut("bosun.navigate.control", () => navigateMainWindow("/control"));
  onShortcut("bosun.navigate.infra", () => navigateMainWindow("/infra"));
  onShortcut("bosun.navigate.logs", () => navigateMainWindow("/logs"));
  onShortcut("bosun.navigate.library", () => navigateMainWindow("/library"));
  onShortcut("bosun.navigate.telemetry", () => navigateMainWindow("/telemetry"));
  onShortcut("bosun.navigate.settings", () => navigateMainWindow("/settings"));
  onShortcut("app.newchat", () => navigateMainWindow("/chat"));
  onShortcut("app.settings", () => navigateMainWindow("/settings"));
  onShortcut("bosun.show.shortcuts", () => showShortcutsDialog());

  // ── Register global shortcuts with the OS ────────────────────────────
  registerGlobalShortcuts();
}

function registerDesktopIpc() {
  ipcMain.handle("bosun:desktop:follow:open", async (_event, detail) => {
    await openFollowWindow(detail || {});
    return { ok: true };
  });
  ipcMain.handle("bosun:desktop:follow:hide", async () => {
    return { ok: hideFollowWindow() };
  });
  ipcMain.handle("bosun:desktop:follow:restore", async () => {
    return { ok: restoreFollowWindow() };
  });

  // ── Shortcuts IPC ───────────────────────────────────────────────────
  /** Returns the full shortcuts catalog with effective accelerators. */
  ipcMain.handle("bosun:shortcuts:list", () => getAllShortcuts());

  /**
   * Set a custom accelerator for a shortcut.
   * Payload: { id: string, accelerator: string | null }
   * Pass null to disable the shortcut.
   * Returns: { ok: boolean, error?: string }
   * Side-effects: re-registers global shortcuts + rebuilds the app menu.
   */
  ipcMain.handle("bosun:shortcuts:set", (_event, { id, accelerator }) => {
    const result = setShortcut(id, accelerator);
    if (result.ok) {
      // Rebuild the menu so the new accelerator is reflected immediately.
      Menu.setApplicationMenu(buildAppMenu());
      refreshTrayMenu();
    }
    return result;
  });

  /**
   * Reset a single shortcut to its default.
   * Payload: { id: string }
   */
  ipcMain.handle("bosun:shortcuts:reset", (_event, { id }) => {
    const result = resetShortcut(id);
    if (result.ok) {
      Menu.setApplicationMenu(buildAppMenu());
      refreshTrayMenu();
    }
    return result;
  });

  /** Reset ALL shortcuts to defaults. */
  ipcMain.handle("bosun:shortcuts:resetAll", () => {
    const result = resetAllShortcuts();
    if (result.ok) {
      Menu.setApplicationMenu(buildAppMenu());
      refreshTrayMenu();
    }
    return result;
  });

  /** Show the native keyboard shortcuts reference dialog. */
  ipcMain.handle("bosun:shortcuts:showDialog", () => {
    showShortcutsDialog();
    return { ok: true };
  });

  /**
   * Enable or disable global (system-wide) firing for a globalEligible shortcut.
   * Payload: { id: string, isGlobal: boolean }
   * Returns: { ok: boolean, error?: string }
   */
  ipcMain.handle("bosun:shortcuts:setScope", (_event, { id, isGlobal }) => {
    return setShortcutScope(id, Boolean(isGlobal));
  });

  // ── Navigation IPC ───────────────────────────────────────────────────────
  /**
   * Navigate the main window to a given path or tab ID.
   * Payload: { path: string } e.g. { path: "/chat" } or { path: "chat" }
   */
  ipcMain.handle("bosun:navigate", (_event, { path } = {}) => {
    if (!path) return { ok: false, error: "path required" };
    const normalizedPath = String(path).startsWith("/") ? path : `/${path}`;
    navigateMainWindow(normalizedPath);
    return { ok: true };
  });

  // ── Workspace IPC ────────────────────────────────────────────────────────
  /** Returns the cached workspace list and active workspace ID. */
  ipcMain.handle("bosun:workspaces:list", async () => {
    await fetchWorkspaces();
    return {
      ok: true,
      workspaces: _cachedWorkspaces,
      activeId: _cachedActiveWorkspaceId,
    };
  });

  /**
   * Switch the active workspace.
   * Payload: { workspaceId: string }
   */
  ipcMain.handle("bosun:workspaces:switch", async (_event, { workspaceId } = {}) => {
    if (!workspaceId) return { ok: false, error: "workspaceId required" };
    return switchWorkspace(workspaceId);
  });

  // ── Connection Settings IPC ──────────────────────────────────────────
  /** Get the current remote connection config. */
  ipcMain.handle("bosun:connection:get", () => {
    const config = readRemoteConnectionConfig();
    return { ok: true, ...config, active: remoteConnectionActive };
  });

  /**
   * Update the remote connection config.
   * Payload: { enabled: boolean, endpoint: string, apiKey: string }
   */
  ipcMain.handle("bosun:connection:set", async (_event, config) => {
    try {
      const saved = Array.isArray(config?.connections)
        ? saveRemoteConnectionConfig(config)
        : saveActiveRemoteConnectionEntry(config || {});
      // If switching to remote, update origin tracking flag
      if (saved.enabled && saved.endpoint) {
        remoteConnectionActive = true;
      } else {
        remoteConnectionActive = false;
      }
      Menu.setApplicationMenu(buildAppMenu());
      refreshTrayMenu();
      return { ok: true, ...saved };
    } catch (err) {
      return { ok: false, error: err?.message || "Failed to save connection config" };
    }
  });

  /**
   * Test connectivity to a remote Bosun endpoint.
   * Payload: { endpoint: string, apiKey: string }
   */
  ipcMain.handle("bosun:connection:test", async (_event, { endpoint, apiKey } = {}) => {
    if (!endpoint) return { ok: false, error: "endpoint required" };
    const result = await testRemoteEndpoint(endpoint, apiKey || "");
    return {
      ok: true,
      reachable: result.ok,
      statusCode: result.statusCode || 0,
      error: result.error || "",
    };
  });

  /**
   * Open the remote connection setup dialog.
   * Returns the config if set, or null if cancelled.
   */
  ipcMain.handle("bosun:connection:setup", async () => {
    const config = await showRemoteConnectionInputDialog();
    if (config) {
      saveActiveRemoteConnectionEntry(config);
      remoteConnectionActive = true;
      Menu.setApplicationMenu(buildAppMenu());
      refreshTrayMenu();
      return { ok: true, ...config, enabled: true };
    }
    return { ok: false, cancelled: true };
  });
}

async function bootstrap() {
  try {
    // Register cert bypass for the local UI server as the very first operation
    // — before any network request is made (config loading, API key probe, etc.).
    // allow-insecure-localhost (set pre-ready above) handles 127.0.0.1; this
    // setCertificateVerifyProc covers LAN IPs (192.168.x.x / 10.x etc.).
    //
    // SECURITY: Only bypass TLS verification for localhost and private-network
    // addresses.  Remote/public endpoints must pass standard chain verification.
    session.defaultSession.setCertificateVerifyProc((request, callback) => {
      if (isLocalHost(request.hostname)) {
        callback(0); // 0 = verified OK
        return;
      }
      callback(-3); // -3 = use Chromium default chain verification
    });
    installDesktopAuthHeaderBridge();
    installDesktopMediaHandlers();

    if (process.env.ELECTRON_DISABLE_SANDBOX === "1") {
      app.commandLine.appendSwitch("no-sandbox");
      app.commandLine.appendSwitch("disable-gpu-sandbox");
    }
    app.setAppUserModelId("com.virtengine.bosun");
    const iconPath = resolveDesktopIconPath();
    if (iconPath && existsSync(iconPath)) {
      try {
        app.setIcon(iconPath);
      } catch {
        /* best effort */
      }
    }
    process.chdir(resolveBosunRoot());
    await loadRuntimeConfig();

    // Provision (or reload) the dedicated Electron desktop API key.
    // The key is stored at {configDir}/desktop-api-key.json and is set in
    // process.env so that the in-process UI server can validate it without
    // importing the module directly (avoids circular dependency).
    try {
      const keyMod = await loadBosunModule("infra/desktop-api-key.mjs");
      const desktopApiKey = keyMod.ensureDesktopApiKey(resolveDesktopConfigDir());
      process.env.BOSUN_DESKTOP_API_KEY = desktopApiKey;
    } catch (err) {
      console.warn("[desktop] could not load desktop-api-key module:", err?.message || err);
      ensureDesktopApiKeyInEnv();
    }

    // Initialise shortcuts (loads user config) and register globals.
    // Must happen before buildAppMenu() so acc() returns correct values.
    initAndRegisterShortcuts(resolveDesktopConfigDir());
    setDesktopAboutPanelOptions();
    setDesktopUpdateState({
      currentVersion: readCurrentBosunVersion(),
      source: app.isPackaged ? "desktop build" : "npm registry",
    });

    Menu.setApplicationMenu(buildAppMenu());

    // Determine tray / background mode before creating any windows.
    trayMode = isTrayModeEnabled();
    // Launch visible by default; allow opt-in hidden start only.
    // Set BOSUN_DESKTOP_START_HIDDEN=1 to keep legacy background startup.
    startHidden = trayMode
      ? parseBoolEnv(process.env.BOSUN_DESKTOP_START_HIDDEN, false)
      : false;

    if (trayMode) {
      // Always create the tray icon first so the app has a presence even
      // before the window is ready.
      ensureTray();
      // On macOS, hide the dock icon in background mode unless the user has
      // explicitly disabled it.
      if (
        process.platform === "darwin"
        && !parseBoolEnv(process.env.BOSUN_DESKTOP_SHOW_DOCK, false)
      ) {
        app.dock?.hide();
      }
    }

    registerDesktopIpc();
    await createMainWindow();

    // In normal (non-background) mode the tray is still useful as an
    // indicator and quick-access — create it after the window is up.
    if (!trayMode) {
      ensureTray();
    }

    // Fetch workspace list in the background so the menu and tray show
    // workspace switcher items as soon as the UI server is reachable.
    fetchWorkspaces({ force: true })
      .then(() => {
        Menu.setApplicationMenu(buildAppMenu());
        refreshTrayMenu();
      })
      .catch((err) =>
        console.warn("[desktop] initial workspace fetch:", err?.message || err),
      );

    await maybeAutoUpdate();
  } catch (error) {
    console.error("[desktop] startup failed", error);
    await shutdown("startup_failed");
  }
}

async function maybeAutoUpdate() {
  // Packaged Electron builds use electron-updater (Squirrel / NSIS).
  if (app.isPackaged && parseBoolEnv(process.env.BOSUN_DESKTOP_AUTO_UPDATE, true)) {
    try {
      await ensurePackagedAutoUpdater();
      setDesktopUpdateState({
        checking: true,
        source: "desktop build",
      });
      packagedAutoUpdater.checkForUpdates().catch((err) => {
        setDesktopUpdateState({
          checking: false,
          error: err?.message || "Update check failed",
          source: "desktop build",
        });
      });
    } catch (err) {
      console.warn("[desktop] auto-update unavailable", err?.message || err);
      setDesktopUpdateState({
        checking: false,
        error: err?.message || "Auto-update unavailable",
        source: "desktop build",
      });
    }
    return;
  }

  try {
    await checkForUpdateDesktop({ interactive: false, startup: true, source: "startup" });
  } catch {
    // silent — never block startup
  }
}

async function ensurePackagedAutoUpdater() {
  if (packagedAutoUpdaterConfigured && packagedAutoUpdater) return packagedAutoUpdater;
  const { autoUpdater } = await import("electron-updater");
  const feedUrl = process.env.BOSUN_DESKTOP_UPDATE_URL;
  if (feedUrl) {
    autoUpdater.setFeedURL({ url: feedUrl });
  }
  autoUpdater.autoDownload = true;
  if (!packagedAutoUpdaterConfigured) {
    autoUpdater.on("checking-for-update", () => {
      setDesktopUpdateState({
        checking: true,
        error: "",
        source: "desktop build",
      });
    });
    autoUpdater.on("update-available", (info) => {
      const version = String(info?.version || "");
      setDesktopUpdateState({
        checking: false,
        available: true,
        downloaded: false,
        latestVersion: version,
        source: "desktop build",
        error: "",
        lastCheckedAt: Date.now(),
      });
    });
    autoUpdater.on("update-not-available", () => {
      clearStartupUpdateDeferral();
      setDesktopUpdateState({
        checking: false,
        available: false,
        downloaded: false,
        latestVersion: readCurrentBosunVersion(),
        source: "desktop build",
        error: "",
        lastCheckedAt: Date.now(),
      });
    });
    autoUpdater.on("update-downloaded", (info) => {
      const version = String(info?.version || desktopUpdateState.latestVersion || "");
      setDesktopUpdateState({
        checking: false,
        available: true,
        downloaded: true,
        latestVersion: version,
        source: "desktop build",
        error: "",
        lastCheckedAt: Date.now(),
      });
      promptStartupUpdateAvailable(version, { downloaded: true }).catch(() => {});
    });
    autoUpdater.on("error", (err) => {
      setDesktopUpdateState({
        checking: false,
        error: err?.message || "Update check failed",
        source: "desktop build",
      });
    });
    packagedAutoUpdaterConfigured = true;
  }
  packagedAutoUpdater = autoUpdater;
  return autoUpdater;
}

// ── Desktop Update Helpers ────────────────────────────────────────────────────

/**
 * Read the current bosun version from the on-disk package.json.
 * Works in both packaged and dev setups.
 */
function readCurrentBosunVersion() {
  try {
    const pkg = JSON.parse(
      readFileSync(resolveBosunRuntimePath("package.json"), "utf8"),
    );
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Simple semver comparison (major.minor.patch). */
function isNewerVersion(remote, local) {
  const parse = (v) => {
    const parts = String(v).replace(/^v/, "").split(".").map(Number);
    return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0 };
  };
  const r = parse(remote);
  const l = parse(local);
  if (r.major !== l.major) return r.major > l.major;
  if (r.minor !== l.minor) return r.minor > l.minor;
  return r.patch > l.patch;
}

/**
 * Fetch the latest published version of `bosun` from the npm registry.
 * Uses raw https to avoid undici handle leaks on Windows.
 */
function fetchLatestVersionFromRegistry() {
  return new Promise((res) => {
    const req = httpsRequest(
      "https://registry.npmjs.org/bosun/latest",
      { headers: { Accept: "application/json" }, timeout: 10_000 },
      (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          return res(null);
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => {
          try { res(JSON.parse(body).version || null); } catch { res(null); }
        });
      },
    );
    req.on("error", () => res(null));
    req.on("timeout", () => { req.destroy(); res(null); });
    req.end();
  });
}

/**
 * Interactive "Check for Updates" flow for the desktop app.
 * Fetches the latest version from npm, shows a dialog, and — if the user
 * confirms — spawns a resilient updater script that survives EBUSY locks.
 */
async function checkForUpdateDesktop(options = {}) {
  const { interactive = true, startup = false, source = "manual" } = options;
  const parentWin = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const currentVersion = readCurrentBosunVersion();
  setDesktopUpdateState({
    checking: true,
    currentVersion,
    source: app.isPackaged ? "desktop build" : "npm registry",
    error: "",
  });

  if (app.isPackaged) {
    try {
      const autoUpdater = await ensurePackagedAutoUpdater();
      if (desktopUpdateState.downloaded) {
        setDesktopUpdateState({
          checking: false,
          source: "desktop build",
        });
        if (interactive) {
          await installDownloadedPackagedUpdate();
        }
        return;
      }
      const result = await autoUpdater.checkForUpdates();
      const latestVersion = String(
        result?.updateInfo?.version || desktopUpdateState.latestVersion || currentVersion,
      );
      if (interactive && latestVersion && isNewerVersion(latestVersion, currentVersion)) {
        await dialog.showMessageBox(parentWin, {
          type: "info",
          title: "Update Available",
          message: "Bosun Desktop found an update.",
          detail:
            `Current version: v${currentVersion}\n` +
            `Latest version:  v${latestVersion}\n\n` +
            "The update is downloading in the background. You will be prompted to restart when it is ready.",
          buttons: ["OK"],
        });
      }
      if (interactive && !result?.downloadPromise && !isNewerVersion(latestVersion, currentVersion)) {
        await dialog.showMessageBox(parentWin, {
          type: "info",
          title: "Check for Updates",
          message: "Bosun Desktop is up to date.",
          detail: `Current version: v${currentVersion}`,
          buttons: ["OK"],
        });
      }
      if (startup && latestVersion && isNewerVersion(latestVersion, currentVersion)) {
        await promptStartupUpdateAvailable(latestVersion, { downloaded: false });
      }
      return;
    } catch (err) {
      setDesktopUpdateState({
        checking: false,
        error: err?.message || "Update check failed",
        source: "desktop build",
      });
      if (!interactive) return;
      await dialog.showMessageBox(parentWin, {
        type: "warning",
        title: "Check for Updates",
        message: "Automatic update check failed.",
        detail:
          `${err?.message || err}\n\n` +
          `Open releases manually: ${DESKTOP_RELEASES_URL}`,
        buttons: ["OK"],
      });
      return;
    }
  }

  let latestVersion;
  try {
    latestVersion = await fetchLatestVersionFromRegistry();
  } catch {
    latestVersion = null;
  }

  if (!latestVersion) {
    setDesktopUpdateState({
      checking: false,
      error: "Could not reach the npm registry",
      source: "npm registry",
    });
    if (!interactive) return;
    await dialog.showMessageBox(parentWin, {
      type: "warning",
      title: "Check for Updates",
      message: "Could not reach the npm registry.",
      detail:
        "Make sure you are connected to the internet and try again.\n\n" +
        "You can also update manually:\n  npm install -g bosun@latest",
      buttons: ["OK"],
    });
    return;
  }

  if (!isNewerVersion(latestVersion, currentVersion)) {
    clearStartupUpdateDeferral();
    setDesktopUpdateState({
      checking: false,
      available: false,
      downloaded: false,
      latestVersion,
      currentVersion,
      source: "npm registry",
      error: "",
      lastCheckedAt: Date.now(),
    });
    if (!interactive) return;
    await dialog.showMessageBox(parentWin, {
      type: "info",
      title: "Check for Updates",
      message: "Bosun is up to date!",
      detail: `Current version: v${currentVersion}\nLatest version:  v${latestVersion}`,
      buttons: ["OK"],
    });
    return;
  }

  setDesktopUpdateState({
    checking: false,
    available: true,
    downloaded: false,
    latestVersion,
    currentVersion,
    source: "npm registry",
    error: "",
    lastCheckedAt: Date.now(),
  });
  if (startup && !interactive) {
    await promptStartupUpdateAvailable(latestVersion, { downloaded: false });
    return;
  }

  // Update is available — ask the user whether to install.
  const { response } = await dialog.showMessageBox(parentWin, {
    type: "info",
    title: "Update Available",
    message: `A new version of Bosun is available!`,
    detail:
      `Current version: v${currentVersion}\n` +
      `New version:     v${latestVersion}\n\n` +
      "Bosun will close, install the update, and relaunch automatically.\n" +
      "The update typically takes 10–30 seconds.",
    buttons: ["Install Update & Restart", "Later"],
    defaultId: 0,
    cancelId: 1,
  });

  if (response !== 0) return;

  // Spawn a detached updater script that waits for the app to exit,
  // retries npm install (surviving EBUSY), and relaunches.
  try {
    clearStartupUpdateDeferral();
    spawnResilientUpdater(latestVersion);
    // Brief pause so the updater process is established before we quit.
    await new Promise((r) => setTimeout(r, 500));
    void shutdown("update_install");
  } catch (err) {
    await dialog.showMessageBox(parentWin, {
      type: "error",
      title: "Update Failed",
      message: "Could not start the update process.",
      detail:
        `${err?.message || err}\n\n` +
        "You can update manually by running:\n  npm install -g bosun@latest",
      buttons: ["OK"],
    });
  }
}

/**
 * Spawn a detached OS-native script that:
 *   1. Waits for the Bosun desktop process to fully exit.
 *   2. Retries `npm install -g bosun@<version>` with exponential back-off
 *      to survive EBUSY / file-lock errors on Windows.
 *   3. Attempts to relaunch Bosun desktop after a successful install.
 *   4. Self-deletes the temp script.
 */
function spawnResilientUpdater(version) {
  const safeVersion = String(version).replaceAll(/[^0-9.a-zA-Z-]/g, "");
  const scriptId = `bosun-update-${Date.now()}`;

  if (process.platform === "win32") {
    const scriptPath = resolve(tmpdir(), `${scriptId}.ps1`);
    // Resolve the bosun CLI so we can relaunch after install.
    const bosunCliPath = resolveBosunRuntimePath("cli.mjs").replaceAll("\\", "\\\\");
    const nodeExePath = process.execPath.replaceAll("\\", "\\\\");
    const script = [
      `# Bosun Desktop Auto-Updater — generated ${new Date().toISOString()}`,
      `$ErrorActionPreference = 'Stop'`,
      `$parentPid = ${process.pid}`,
      ``,
      `# ── Wait for the desktop process to exit ──────────────────────`,
      `$maxWait = 30`,
      `$waited = 0`,
      `while ($waited -lt $maxWait) {`,
      `    try {`,
      `        Get-Process -Id $parentPid -ErrorAction Stop | Out-Null`,
      `        Start-Sleep -Seconds 1`,
      `        $waited++`,
      `    } catch {`,
      `        break`,
      `    }`,
      `}`,
      ``,
      `# ── Retry npm install with exponential back-off ───────────────`,
      `$maxRetries = 6`,
      `$delay = 2`,
      `$success = $false`,
      ``,
      `for ($i = 1; $i -le $maxRetries; $i++) {`,
      `    Write-Host "[bosun-updater] Attempt $i / $maxRetries ..."`,
      `    try {`,
      `        $output = & npm install -g bosun@${safeVersion} 2>&1 | Out-String`,
      `        if ($LASTEXITCODE -eq 0) {`,
      `            Write-Host "[bosun-updater] Success!"`,
      `            $success = $true`,
      `            break`,
      `        }`,
      `        Write-Host $output`,
      `    } catch {`,
      `        Write-Host "[bosun-updater] Error: $_"`,
      `    }`,
      `    if ($i -lt $maxRetries) {`,
      `        Write-Host "[bosun-updater] Retrying in $delay seconds ..."`,
      `        Start-Sleep -Seconds $delay`,
      `        $delay = [math]::Min($delay * 2, 30)`,
      `    }`,
      `}`,
      ``,
      `# ── Last-resort: --force ──────────────────────────────────────`,
      `if (-not $success) {`,
      `    Write-Host "[bosun-updater] Trying with --force ..."`,
      `    try {`,
      `        & npm install -g bosun@${safeVersion} --force 2>&1 | Out-String`,
      `        if ($LASTEXITCODE -eq 0) { $success = $true }`,
      `    } catch {`,
      `        Write-Host "[bosun-updater] Force install also failed: $_"`,
      `    }`,
      `}`,
      ``,
      `# ── Relaunch Bosun desktop ────────────────────────────────────`,
      `if ($success) {`,
      `    Write-Host "[bosun-updater] Relaunching Bosun desktop ..."`,
      `    try {`,
      `        Start-Process -FilePath "bosun" -ArgumentList "--desktop" -WindowStyle Hidden`,
      `    } catch {`,
      `        # Fallback: launch via node directly`,
      `        try {`,
      `            Start-Process -FilePath "${nodeExePath}" -ArgumentList "${bosunCliPath}", "--desktop" -WindowStyle Hidden`,
      `        } catch {`,
      `            Write-Host "[bosun-updater] Could not relaunch: $_"`,
      `        }`,
      `    }`,
      `} else {`,
      `    Write-Host "[bosun-updater] Update failed. Please run manually: npm install -g bosun@latest"`,
      `}`,
      ``,
      `# ── Clean up ─────────────────────────────────────────────────`,
      `Start-Sleep -Seconds 2`,
      `Remove-Item -Path $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue`,
    ].join("\n");

    writeFileSync(scriptPath, script, "utf8");

    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      { detached: true, stdio: "ignore", windowsHide: false },
    );
    child.unref();
    console.log(`[desktop] spawned updater script: ${scriptPath} (pid ${child.pid})`);
  } else {
    // ── macOS / Linux ─────────────────────────────────────────────────
    const scriptPath = resolve(tmpdir(), `${scriptId}.sh`);
    const script = [
      `#!/usr/bin/env bash`,
      `# Bosun Desktop Auto-Updater — generated ${new Date().toISOString()}`,
      `set -e`,
      `PARENT_PID=${process.pid}`,
      `MAX_WAIT=30`,
      `WAITED=0`,
      ``,
      `# Wait for parent to exit`,
      `while [ $WAITED -lt $MAX_WAIT ]; do`,
      `    if kill -0 $PARENT_PID 2>/dev/null; then`,
      `        sleep 1`,
      `        WAITED=$((WAITED + 1))`,
      `    else`,
      `        break`,
      `    fi`,
      `done`,
      ``,
      `# Retry npm install with back-off`,
      `MAX_RETRIES=6`,
      `DELAY=2`,
      `SUCCESS=0`,
      `for i in $(seq 1 $MAX_RETRIES); do`,
      `    echo "[bosun-updater] Attempt $i / $MAX_RETRIES ..."`,
      `    if npm install -g bosun@${safeVersion} 2>&1; then`,
      `        SUCCESS=1`,
      `        break`,
      `    fi`,
      `    echo "[bosun-updater] Retrying in \${DELAY}s ..."`,
      `    sleep $DELAY`,
      `    DELAY=$((DELAY * 2))`,
      `    [ $DELAY -gt 30 ] && DELAY=30`,
      `done`,
      ``,
      `# Last resort: --force`,
      `if [ $SUCCESS -eq 0 ]; then`,
      `    echo "[bosun-updater] Trying with --force ..."`,
      `    npm install -g bosun@${safeVersion} --force 2>&1 && SUCCESS=1 || true`,
      `fi`,
      ``,
      `# Relaunch`,
      `if [ $SUCCESS -eq 1 ]; then`,
      `    echo "[bosun-updater] Relaunching Bosun desktop ..."`,
      `    nohup bosun --desktop </dev/null >/dev/null 2>&1 &`,
      `fi`,
      ``,
      `# Clean up`,
      `rm -f "$0"`,
    ].join("\n");

    writeFileSync(scriptPath, script, { encoding: "utf8", mode: 0o755 });

    const child = spawn("bash", [scriptPath], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    console.log(`[desktop] spawned updater script: ${scriptPath} (pid ${child.pid})`);
  }
}

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (reason) {
    console.log(`[desktop] shutting down (${reason})`);
  }

  try {
    if (uiServerStarted) {
      const api = await loadUiServerModule();
      api.stopTelegramUiServer();
    }
  } catch (error) {
    console.error("[desktop] failed to stop ui-server", error);
  }

  app.quit();
}

app.on("before-quit", () => {
  shuttingDown = true;
  // Unregister all custom global shortcuts before Electron's own cleanup.
  try { unregisterGlobalShortcuts(); } catch { /* ignore */ }
  globalShortcut.unregisterAll();
  if (tray) {
    tray.destroy();
    tray = null;
  }
  try {
    if (uiServerStarted && uiApi?.stopTelegramUiServer) {
      uiApi.stopTelegramUiServer();
    }
  } catch (error) {
    console.error("[desktop] failed to stop ui-server", error);
  }
});

app.on(
  "certificate-error",
  (event, _webContents, url, _error, _certificate, callback) => {
    try {
      const hostname = new URL(url).hostname;
      if ((uiOrigin && url.startsWith(uiOrigin)) || isLocalHost(hostname)) {
        event.preventDefault();
        callback(true);
        return;
      }
    } catch {
      // malformed URL — fall through
    }
    callback(false);
  },
);

app.on("window-all-closed", () => {
  // In tray mode the app intentionally keeps running with no open windows.
  // Only shut down when quitting explicitly (e.g. tray menu Quit or Cmd+Q).
  if (trayMode) return;
  void shutdown("window_all_closed");
});

app.on("activate", () => {
  // macOS: clicking the dock icon (re-)shows the app.
  if (!mainWindow || mainWindow.isDestroyed()) {
    void createMainWindow();
  } else {
    setWindowVisible(mainWindow);
  }
});

app.on("second-instance", () => {
  if (followWindow && !followWindow.isDestroyed() && followWindow.isVisible()) {
    setWindowVisible(followWindow);
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    void createMainWindow();
    return;
  }
  setWindowVisible(mainWindow);
});

process.on("SIGINT", () => {
  void shutdown("sigint");
});

process.on("SIGTERM", () => {
  void shutdown("sigterm");
});

// ── Pre-ready Chromium flags ──────────────────────────────────────────────────
// These MUST be set before app.isReady() — Chromium reads the command line at
// process startup and ignores changes made after the browser process launches.

// Allow HTTPS connections to localhost (127.0.0.1, ::1, "localhost") using
// self-signed certificates without triggering CertVerifyProcBuiltin errors or
// ssl_client_socket_impl handshake-failed spam.  This only suppresses cert
// errors for the loopback address; external HTTPS connections are unaffected.
app.commandLine.appendSwitch("allow-insecure-localhost");

app.whenReady().then(bootstrap);
