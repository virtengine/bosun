import {
  disableUnsafeMode,
  getFirewallState,
  getLocalLanIp,
  getSessionToken,
  getTelegramUiUrl,
  getTunnelUrl,
  onTunnelUrlChange,
  openFirewallPort,
  startTelegramUiServer,
  stopTelegramUiServer,
} from "../server/ui-server.mjs";
import { requestJsonApi } from "../lib/request-json-api.mjs";

function resolveTelegramSurfaceApiBaseUrl() {
  const raw = String(getTelegramUiUrl?.() || "").trim();
  if (!raw) {
    throw new Error("Bosun UI server is not available.");
  }
  return raw;
}

export async function requestTelegramSurfaceApi(path, options = {}) {
  const base = resolveTelegramSurfaceApiBaseUrl();
  const token = String(getSessionToken?.() || "").trim();
  return await requestJsonApi(base, path, {
    ...options,
    bearerToken: token,
    errorPrefix: "Bosun UI request",
  });
}

export function createTelegramUiRuntime() {
  return {
    getUiUrl: () => getTelegramUiUrl(),
    getLocalLanIp: () => getLocalLanIp(),
    getFirewallState: () => getFirewallState(),
    openFirewallPort: (...args) => openFirewallPort(...args),
    getSessionToken: () => getSessionToken(),
    getTunnelUrl: () => getTunnelUrl(),
    onTunnelUrlChange: (cb) => onTunnelUrlChange(cb),
    disableUnsafeMode: () => disableUnsafeMode(),
    request: (path, options = {}) => requestTelegramSurfaceApi(path, options),
  };
}

export async function startTelegramSurfaceRuntime(options = {}) {
  return await startTelegramUiServer(options);
}

export function stopTelegramSurfaceRuntime() {
  return stopTelegramUiServer();
}
