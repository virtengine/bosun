import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetStateLedgerCache } from "../lib/state-ledger-sqlite.mjs";
describe("ui-server fallback auth", () => {
  const ENV_KEYS = [
    "TELEGRAM_UI_ALLOW_UNSAFE",
    "TELEGRAM_UI_TLS_DISABLE",
    "TELEGRAM_UI_TUNNEL",
    "TELEGRAM_UI_FALLBACK_AUTH_ENABLED",
    "TELEGRAM_UI_FALLBACK_AUTH_MAX_FAILURES",
    "TELEGRAM_UI_FALLBACK_AUTH_LOCKOUT_MS",
    "TELEGRAM_UI_FALLBACK_AUTH_RATE_LIMIT_IP_PER_MIN",
    "TELEGRAM_UI_FALLBACK_AUTH_RATE_LIMIT_GLOBAL_PER_MIN",
    "TELEGRAM_UI_FALLBACK_AUTH_TRANSIENT_COOLDOWN_MS",
    "BOSUN_ENV_NO_OVERRIDE",
    "BOSUN_CONFIG_PATH",
    "BOSUN_HOME",
  ];
  let envSnapshot = {};
  let tempDir = "";
  let activeServer = null;

  beforeEach(() => {
    envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    tempDir = mkdtempSync(join(tmpdir(), "bosun-fallback-auth-"));
    process.env.BOSUN_CONFIG_PATH = join(tempDir, "bosun.config.json");
    process.env.BOSUN_ENV_NO_OVERRIDE = "1";
    process.env.TELEGRAM_UI_TLS_DISABLE = "true";
    process.env.TELEGRAM_UI_ALLOW_UNSAFE = "true";
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.TELEGRAM_UI_FALLBACK_AUTH_ENABLED = "true";
    process.env.TELEGRAM_UI_FALLBACK_AUTH_RATE_LIMIT_IP_PER_MIN = "100";
    process.env.TELEGRAM_UI_FALLBACK_AUTH_RATE_LIMIT_GLOBAL_PER_MIN = "500";
  });

  afterEach(async () => {
    const mod = await import("../server/ui-server.mjs");
    mod.stopTelegramUiServer();
    if (activeServer && typeof activeServer.close === "function") {
      await new Promise((resolve) => activeServer.close(resolve));
    }
    activeServer = null;
    resetStateLedgerCache();
    for (const key of ENV_KEYS) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key];
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("sets fallback credential, logs in, and reuses normal session cookie", async () => {
    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: 0,
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    activeServer = server;
    const port = server.address().port;

    const setRes = await fetch(`http://127.0.0.1:${port}/api/auth/fallback/set`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "StrongFallbackPass123!" }),
    });
    expect(setRes.status).toBe(200);

    const unsafeStatus = await fetch(`http://127.0.0.1:${port}/api/auth/fallback/status`);
    const unsafeStatusBody = await unsafeStatus.json();
    expect(unsafeStatusBody.data?.fallbackAuth?.remediation).toContain("unsafe_mode_enabled");

    process.env.TELEGRAM_UI_ALLOW_UNSAFE = "false";

    const unauthorized = await fetch(`http://127.0.0.1:${port}/api/status`);
    expect(unauthorized.status).toBe(401);

    const login = await fetch(`http://127.0.0.1:${port}/api/auth/fallback/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "StrongFallbackPass123!" }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie") || "";
    expect(cookie).toContain("ve_session=");

    const authed = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { cookie },
    });
    expect(authed.status).toBe(200);
  }, 20_000);

  it("applies lockout with uniform failure response for invalid fallback secrets", async () => {
    process.env.TELEGRAM_UI_FALLBACK_AUTH_MAX_FAILURES = "2";
    process.env.TELEGRAM_UI_FALLBACK_AUTH_LOCKOUT_MS = "60000";

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: 0,
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    activeServer = server;
    const port = server.address().port;

    await fetch(`http://127.0.0.1:${port}/api/auth/fallback/set`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "StrongFallbackPass123!" }),
    });
    process.env.TELEGRAM_UI_ALLOW_UNSAFE = "false";

    const fail1 = await fetch(`http://127.0.0.1:${port}/api/auth/fallback/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "bad-secret" }),
    });
    const fail2 = await fetch(`http://127.0.0.1:${port}/api/auth/fallback/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "bad-secret" }),
    });
    const fail3 = await fetch(`http://127.0.0.1:${port}/api/auth/fallback/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "bad-secret" }),
    });

    const body1 = await fail1.json();
    const body2 = await fail2.json();
    const body3 = await fail3.json();

    expect(fail1.status).toBe(401);
    expect(fail2.status).toBe(401);
    expect(fail3.status).toBe(401);
    expect(body1.error).toBe("Authentication failed.");
    expect(body2.error).toBe("Authentication failed.");
    expect(body3.error).toBe("Authentication failed.");

    const statusRes = await fetch(`http://127.0.0.1:${port}/api/auth/fallback/status`);
    const statusBody = await statusRes.json();
    expect(statusRes.status).toBe(200);
    expect(statusBody.data?.fallbackAuth?.locked).toBe(true);
  }, 20_000);
});
