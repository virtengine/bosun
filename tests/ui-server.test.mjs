import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addConfigReloadListener } from "../infra/config-reload-bus.mjs";
import {
  getSessionActivityFromStateLedger,
  appendOperatorActionToStateLedger,
  appendTaskTraceEventToStateLedger,
  resetStateLedgerCache,
  upsertSessionRecordToStateLedger,
} from "../lib/state-ledger-sqlite.mjs";
import {
  _resetRuntimeAccumulatorForTests,
  addCompletedSession,
} from "../infra/runtime-accumulator.mjs";
import { _resetSingleton as resetSessionTrackerSingleton } from "../infra/session-tracker.mjs";

const describeUiServer = (
  process.env.BOSUN_TEST_CHILD_SPAWN_BLOCKED === "1"
  || (process.platform === "win32" && /[\\/]\.codex[\\/]\.sandbox[\\/]/i.test(process.cwd()))
)
  ? describe.skip
  : describe;

function sanitizedGitEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_PREFIX",
  ]) {
    delete env[key];
  }
  return env;
}

async function settleUiRuntimeCleanup() {
  const mod = await import("../server/ui-server.mjs");
  const taskStore = await import("../task/task-store.mjs");
  mod.stopTelegramUiServer();
  await taskStore._resetForTests();
  resetSessionTrackerSingleton({ persistDir: null });
  _resetRuntimeAccumulatorForTests();
  resetStateLedgerCache();
  await new Promise((resolve) => setTimeout(resolve, 25));
}

async function removeDirWithRetries(dirPath) {
  if (!dirPath) return;
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      rmSync(dirPath, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== "EPERM") throw error;
      resetStateLedgerCache();
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}


describeUiServer("ui-server mini app", () => {
  const ENV_KEYS = [
    "TELEGRAM_UI_TLS_DISABLE",
    "TELEGRAM_UI_ALLOW_UNSAFE",
    "TELEGRAM_MINIAPP_ENABLED",
    "TELEGRAM_UI_PORT",
    "TELEGRAM_UI_HOST",
    "BOSUN_WORKFLOW_WORKER_START_TIMEOUT_MS",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
    "TELEGRAM_UI_TUNNEL",
    "TELEGRAM_UI_ALLOW_QUICK_TUNNEL_FALLBACK",
    "TELEGRAM_UI_FALLBACK_AUTH_ENABLED",
    "TELEGRAM_UI_FALLBACK_AUTH_RATE_LIMIT_IP_PER_MIN",
    "TELEGRAM_UI_FALLBACK_AUTH_RATE_LIMIT_GLOBAL_PER_MIN",
    "TELEGRAM_UI_FALLBACK_AUTH_MAX_FAILURES",
    "TELEGRAM_UI_FALLBACK_AUTH_LOCKOUT_MS",
    "TELEGRAM_UI_FALLBACK_AUTH_ROTATE_DAYS",
    "TELEGRAM_UI_FALLBACK_AUTH_TRANSIENT_COOLDOWN_MS",
    "CLOUDFLARE_BASE_DOMAIN",
    "CLOUDFLARE_TUNNEL_HOSTNAME",
    "CLOUDFLARE_USERNAME_HOSTNAME_POLICY",
    "CLOUDFLARE_ZONE_ID",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_DNS_SYNC_ENABLED",
    "CLOUDFLARE_DNS_MAX_RETRIES",
    "CLOUDFLARE_DNS_RETRY_BASE_MS",
    "BOSUN_UI_ALLOW_EPHEMERAL_PORT",
    "BOSUN_UI_AUTO_OPEN_BROWSER",
    "BOSUN_UI_BROWSER_OPEN_MODE",
    "BOSUN_UI_LOG_TOKENIZED_BROWSER_URL",
    "BOSUN_UI_LOCAL_BOOTSTRAP",
    "BOSUN_UI_RATE_LIMIT_PER_MIN",
    "BOSUN_UI_RATE_LIMIT_AUTHENTICATED_PER_MIN",
    "BOSUN_UI_RATE_LIMIT_PRIVILEGED_PER_MIN",
    "BOSUN_UI_COORDINATION_STATE_ENABLED",
    "BOSUN_UI_SCOPE_LOCK_STATE_ENABLED",
    "BOSUN_UI_AUDIT_SUMMARY_ENABLED",
    "BOSUN_UI_EXECUTION_JOURNAL_STATE_ENABLED",
    "BOSUN_UI_PLANNING_ACCOUNTING_ENABLED",
    "BOSUN_UI_MONITORING_STATE_ENABLED",
    "TELEGRAM_INTERVAL_MIN",
    "BOSUN_CONFIG_PATH",
    "BOSUN_TEST_CACHE_DIR",
    "BOSUN_STATE_LEDGER_PATH",
    "BOSUN_HOME",
    "BOSUN_DIR",
    "CODEX_MONITOR_HOME",
    "CODEX_MONITOR_DIR",
    "REPO_ROOT",
    "VITEST",
    "BOSUN_DESKTOP_API_KEY",
    "KANBAN_BACKEND",
    "REPO_MIRROR_ENABLED",
    "REPO_MIRROR_REPO_PATH",
    "REPO_MIRROR_SYNC_MODE",
    "REPO_MIRROR_RUN_STORAGE",
    "REPO_MIRROR_MESSAGE_STORAGE",
    "REPO_MIRROR_PUBLIC_ROADMAP_ENABLED",
    "GITHUB_PROJECT_MODE",
    "GITHUB_PROJECT_WEBHOOK_SECRET",
    "GITHUB_PROJECT_WEBHOOK_REQUIRE_SIGNATURE",
    "GITHUB_PROJECT_WEBHOOK_PATH",
    "GITHUB_PROJECT_SYNC_ALERT_FAILURE_THRESHOLD",
    "BOSUN_AGENT_RUNTIME",
    "EXECUTOR_MODE",
    "INTERNAL_EXECUTOR_PARALLEL",
    "INTERNAL_EXECUTOR_REVIEW_AGENT_ENABLED",
    "INTERNAL_EXECUTOR_REPLENISH_ENABLED",
    "PROJECT_REQUIREMENTS_PROFILE",
    "TASK_TRIGGER_SYSTEM_ENABLED",
    "WORKFLOW_AUTOMATION_ENABLED",
    "EXECUTORS",
    "FLEET_ENABLED",
    "FLEET_SYNC_INTERVAL_MS",
    "BOSUN_HARNESS_ENABLED",
    "BOSUN_HARNESS_SOURCE",
    "BOSUN_HARNESS_VALIDATION_MODE",
    "BOSUN_PROVIDER_ROUTING_MODE",
    "OPENAI_API_KEY",
    "STATUS_FILE",
    "BOSUN_FLOW_REQUIRE_REVIEW",
    "BOSUN_ENV_NO_OVERRIDE",
    "BOSUN_TEST_ALLOW_REPO_LOCAL_CONFIG",
  ];
  let envSnapshot = {};
  let testSandboxRoot = null;

  beforeEach(async () => {
    envSnapshot = Object.fromEntries(
      ENV_KEYS.map((key) => [key, process.env[key]]),
    );
    testSandboxRoot = mkdtempSync(join(tmpdir(), "bosun-ui-server-test-"));
    const { ensureTestRuntimeSandbox } = await import("../infra/test-runtime.mjs");
    const sandbox = ensureTestRuntimeSandbox({ rootDir: testSandboxRoot, force: true });
    // Prevent loadConfig() → loadDotEnv() from overriding test-controlled env
    // vars with values from the user's on-disk .env file.
    process.env.BOSUN_ENV_NO_OVERRIDE = "1";
    process.env.VITEST = "1";
    process.env.TELEGRAM_UI_TLS_DISABLE = "true";
    process.env.TELEGRAM_UI_ALLOW_UNSAFE = "true";
    process.env.TELEGRAM_BOT_TOKEN = "";
    process.env.TELEGRAM_CHAT_ID = "";
    process.env.GITHUB_PROJECT_WEBHOOK_PATH = "/api/webhooks/github/project-sync";
    process.env.GITHUB_PROJECT_WEBHOOK_SECRET = "webhook-secret";
    process.env.GITHUB_PROJECT_WEBHOOK_REQUIRE_SIGNATURE = "true";
    process.env.GITHUB_PROJECT_SYNC_ALERT_FAILURE_THRESHOLD = "2";
    process.env.KANBAN_BACKEND = "internal";
    process.env.BOSUN_CONFIG_PATH = join(sandbox.configDir, "bosun.config.json");
    process.env.BOSUN_HOME = sandbox.configDir;
    process.env.BOSUN_DIR = sandbox.configDir;
    process.env.BOSUN_TEST_CACHE_DIR = sandbox.cacheDir;
    process.env.BOSUN_STATE_LEDGER_PATH = sandbox.stateLedgerPath;
    process.env.CODEX_MONITOR_HOME = sandbox.configDir;
    process.env.CODEX_MONITOR_DIR = sandbox.configDir;
    delete process.env.REPO_ROOT;
    delete process.env.BOSUN_TEST_ALLOW_REPO_LOCAL_CONFIG;
    vi.resetModules();
    resetSessionTrackerSingleton({ persistDir: null });
    _resetRuntimeAccumulatorForTests({ cacheDir: sandbox.cacheDir });
    resetStateLedgerCache();

    const { setKanbanBackend } = await import("../kanban/kanban-adapter.mjs");
    setKanbanBackend("internal");
  }, 40000);

  afterEach(async () => {
    await settleUiRuntimeCleanup();
    for (const key of ENV_KEYS) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key];
    }
    if (testSandboxRoot) {
      await removeDirWithRetries(testSandboxRoot);
      testSandboxRoot = null;
    }
    vi.resetModules();
  }, 40000);

  async function getFreePort() {
    return 0;
  }

  function signBody(secret, body) {
    const digest = createHmac("sha256", secret).update(body).digest("hex");
    return `sha256=${digest}`;
  }

  it("exports mini app server helpers", async () => {
    vi.resetModules();
    const mod = await import("../server/ui-server.mjs");
    expect(typeof mod.startTelegramUiServer).toBe("function");
    expect(typeof mod.stopTelegramUiServer).toBe("function");
    expect(typeof mod.getTelegramUiUrl).toBe("function");
    expect(typeof mod.injectUiDependencies).toBe("function");
    expect(typeof mod.getLocalLanIp).toBe("function");
  }, process.platform === "win32" ? 180000 : 120000);

  it("does not register module-level cleanup timers on import", async () => {
    vi.resetModules();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    try {
      await import("../server/ui-server.mjs");
      expect(setIntervalSpy).not.toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
    }
  }, 40000);

  it("releases workflow engine listeners and task trace hooks on shutdown", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    vi.resetModules();
    const mod = await import("../server/ui-server.mjs");
    const workflowListeners = new Map();
    const removeTaskTraceHook = vi.fn();
    const fakeEngine = {
      on: vi.fn((eventName, handler) => {
        const handlers = workflowListeners.get(eventName) || [];
        handlers.push(handler);
        workflowListeners.set(eventName, handlers);
      }),
      off: vi.fn((eventName, handler) => {
        const handlers = workflowListeners.get(eventName) || [];
        workflowListeners.set(eventName, handlers.filter((entry) => entry !== handler));
      }),
      registerTaskTraceHook: vi.fn(() => removeTaskTraceHook),
      list: vi.fn(async () => []),
      getRunHistoryPage: vi.fn(async () => ({ runs: [] })),
      getRunHistory: vi.fn(async () => []),
      load: vi.fn(),
    };
    mod._testInjectWorkflowEngine({ WorkflowEngine: class MockWorkflowEngine {} }, fakeEngine);

    let server = null;
    try {
      server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });
      const port = server.address().port;
      const response = await fetch(`http://127.0.0.1:${port}/api/workflows`);
      expect(response.status).toBe(200);
      expect(fakeEngine.on).toHaveBeenCalled();
      expect(fakeEngine.registerTaskTraceHook).toHaveBeenCalledTimes(1);
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      mod.stopTelegramUiServer();
      mod._testInjectWorkflowEngine(null, null);
    }

    expect(removeTaskTraceHook).toHaveBeenCalledTimes(1);
    expect(fakeEngine.off).toHaveBeenCalled();
    expect(Array.from(workflowListeners.values()).every((handlers) => handlers.length === 0)).toBe(true);
  }, 40000);

  it("reclaims stale live-pid instance locks when the recorded UI is unresponsive", async () => {
    const cacheDir = join(process.env.BOSUN_HOME, ".cache");
    const lockPath = join(cacheDir, "ui-server.instance.lock.json");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: Math.max(1, Number(process.ppid || 1)),
        port: 6552,
        host: "127.0.0.1",
        protocol: "http",
        url: "http://127.0.0.1:6552",
        startedAt: Date.now() - 10 * 60 * 1000,
      }, null, 2),
      "utf8",
    );

    vi.resetModules();
    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: false,
      skipAutoOpen: true,
      instanceLockStaleGraceMs: 0,
      instanceLockProbeTimeoutMs: 100,
    });
    try {
      expect(server).toBeTruthy();
      const payload = JSON.parse(readFileSync(lockPath, "utf8"));
      expect(payload.pid).toBe(process.pid);
      expect(payload.port).toBe(server.address().port);
    } finally {
      mod.stopTelegramUiServer();
    }
  }, 60000);

  it("surfaces worktree recovery state through status, infra, and worktree endpoints", async () => {
    const tmpStatusDir = mkdtempSync(join(tmpdir(), "ui-worktree-recovery-status-"));
    const statusPath = join(tmpStatusDir, "orchestrator-status.json");
    process.env.STATUS_FILE = statusPath;
    mkdirSync(tmpStatusDir, { recursive: true });
    writeFileSync(statusPath, JSON.stringify({
      counts: { running: 0, review: 0, error: 0, manual_review: 0 },
      worktreeRecovery: {
        health: "degraded",
        failureStreak: 2,
        recentEvents: [
          {
            outcome: "recreation_failed",
            reason: "poisoned_worktree",
            branch: "task/failing-worktree",
            taskId: "task-failing-1",
            error: "refresh conflict",
            timestamp: "2026-03-22T01:02:03.000Z",
          },
        ],
      },
    }, null, 2));

    try {
      const mod = await import("../server/ui-server.mjs");
      mod.injectUiDependencies({
        worktreeRecovery: {
          health: "degraded",
          failureStreak: 2,
          recentEvents: [
            {
              outcome: "recreation_failed",
              reason: "poisoned_worktree",
              branch: "task/failing-worktree",
              taskId: "task-failing-1",
              error: "refresh conflict",
              timestamp: "2026-03-22T01:02:03.000Z",
            },
          ],
        },
        getInternalExecutor: () => ({
          getStatus: () => ({ maxParallel: 4, activeSlots: 0, slots: [] }),
          isPaused: () => false,
        }),
      });
      const server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });
      const port = server.address().port;

      const status = await fetch(`http://127.0.0.1:${port}/api/status`).then((r) => r.json());
      expect(status.ok).toBe(true);
      expect(status.data.worktreeRecovery).toMatchObject({
        health: "degraded",
        failureStreak: 2,
      });
      expect(status.data.serverState).toBeUndefined();

      const infra = await fetch(`http://127.0.0.1:${port}/api/infra`).then((r) => r.json());
      expect(infra.ok).toBe(true);
      expect(infra.data.worktreeRecovery).toMatchObject({
        health: "degraded",
        failureStreak: 2,
      });
      expect(infra.data.serverState).toBeUndefined();

      const worktrees = await fetch(`http://127.0.0.1:${port}/api/worktrees`).then((r) => r.json());
      expect(worktrees.ok).toBe(true);
      expect(worktrees.stats.recovery).toMatchObject({
        health: "degraded",
        failureStreak: 2,
      });
    } finally {
      rmSync(tmpStatusDir, { recursive: true, force: true });
    }
  }, 60000);

  it("honors STATUS_FILE overrides for worktree recovery status", async () => {
    const tmpStatusDir = mkdtempSync(join(tmpdir(), "ui-status-file-"));
    const statusPath = join(tmpStatusDir, "custom-status.json");
    process.env.STATUS_FILE = statusPath;
    writeFileSync(statusPath, JSON.stringify({
      worktreeRecovery: {
        health: "recovered",
        failureStreak: 0,
        recentEvents: [{
          outcome: "recreated",
          reason: "poisoned_worktree",
          branch: "task/healed-worktree",
          taskId: "task-healed-1",
          timestamp: "2026-03-22T01:02:03.000Z",
        }],
      },
    }, null, 2));

    let server = null;
    try {
      const mod = await import("../server/ui-server.mjs");
      mod.injectUiDependencies({
        getInternalExecutor: () => ({
          getStatus: () => ({ maxParallel: 2, activeSlots: 0, slots: [] }),
          isPaused: () => false,
        }),
      });
      server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });
      const port = server.address().port;

      const status = await fetch(`http://127.0.0.1:${port}/api/status`).then((r) => r.json());
      expect(status.ok).toBe(true);
      expect(status.data.worktreeRecovery).toMatchObject({
        health: "recovered",
        recentEvents: [expect.objectContaining({ outcome: "recreated" })],
      });
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      rmSync(tmpStatusDir, { recursive: true, force: true });
    }
  }, 90000);

  it("backfills recovery-only worktrees into /api/worktrees when no live registry entry exists", async () => {
    const tmpStatusDir = mkdtempSync(join(tmpdir(), "ui-worktree-recovery-backfill-"));
    const statusPath = join(tmpStatusDir, "custom-status.json");
    process.env.STATUS_FILE = statusPath;
    writeFileSync(statusPath, JSON.stringify({
      worktreeRecovery: {
        health: "recovered",
        failureStreak: 0,
        recentEvents: [{
          outcome: "recreated",
          reason: "poisoned_worktree",
          branch: "task/recovered-worktree",
          taskId: "task-recovered-1",
          worktreePath: join(tmpStatusDir, "worktrees", "task-recovered-1"),
          timestamp: "2026-03-22T01:02:03.000Z",
        }],
      },
    }, null, 2));

    try {
      const mod = await import("../server/ui-server.mjs");
      mod.injectUiDependencies({
        getInternalExecutor: () => ({
          getStatus: () => ({ maxParallel: 2, activeSlots: 0, slots: [] }),
          isPaused: () => false,
        }),
      });
      const server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });
      const port = server.address().port;

      const worktrees = await fetch(`http://127.0.0.1:${port}/api/worktrees`).then((r) => r.json());
      expect(worktrees.ok).toBe(true);
      expect(worktrees.stats.liveTotal).toBe(0);
      expect(worktrees.stats.recoveryLinked).toBe(1);
      expect(worktrees.data).toContainEqual(
        expect.objectContaining({
          branch: "task/recovered-worktree",
          taskKey: "task-recovered-1",
          status: "recovered",
          source: "recovery",
        }),
      );
    } finally {
      rmSync(tmpStatusDir, { recursive: true, force: true });
    }
  });

  it("getLocalLanIp returns a string", async () => {
    vi.resetModules();
    const mod = await import("../server/ui-server.mjs");
    const ip = mod.getLocalLanIp();
    expect(typeof ip).toBe("string");
    expect(ip.length).toBeGreaterThan(0);
  }, process.platform === "win32" ? 15000 : 10000);

  it("preserves launch query params when exchanging session token", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    vi.resetModules();
    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    try {
      const port = server.address().port;
      const token = mod.getSessionToken();
      expect(token).toBeTruthy();

      const response = await fetch(
        `http://127.0.0.1:${port}/chat?launch=meeting&call=video&token=${encodeURIComponent(token)}`,
        { redirect: "manual" },
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/chat?launch=meeting&call=video");
      expect(response.headers.get("set-cookie") || "").toContain("ve_session=");
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  }, 30000);
  it("regenerates zero-entropy session tokens before issuing browser auth", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_UI_TOKEN = "a".repeat(64);
    vi.resetModules();
    vi.resetModules();
    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    let token;
    try {
      token = mod.getSessionToken();
      expect(token).toMatch(/^[a-f0-9]{64}$/i);
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
      delete process.env.BOSUN_UI_TOKEN;
    }
    expect(token).not.toBe("a".repeat(64));
  }, 30000);


  it("bootstraps local static requests into a session cookie", async () => {
    process.env.TELEGRAM_UI_ALLOW_UNSAFE = "false";
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_UI_LOCAL_BOOTSTRAP = "true";
    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const first = await fetch(`http://127.0.0.1:${port}/app.js?native=1`, {
      redirect: "manual",
    });
    expect(first.status).toBe(302);
    const cookie = first.headers.get("set-cookie") || "";
    expect(cookie).toContain("ve_session=");
    const location = first.headers.get("location") || "";
    expect(location).toContain("localBootstrap=1");

    const second = await fetch(`http://127.0.0.1:${port}${location}`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(second.status).toBe(302);
    const finalLocation = second.headers.get("location") || "";
    expect(finalLocation).toContain("/app.js?native=1");
    expect(finalLocation).not.toContain("localBootstrap=1");

    const third = await fetch(`http://127.0.0.1:${port}${finalLocation}`, {
      headers: { cookie },
    });
    expect(third.status).toBe(200);
    expect(String(third.headers.get("content-type") || "")).toContain("application/javascript");
    expect(String(third.headers.get("cache-control") || "")).toContain("no-cache");
  }, 20000);

  it("serves shared /lib modules after local bootstrap", async () => {
    process.env.TELEGRAM_UI_ALLOW_UNSAFE = "false";
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_UI_LOCAL_BOOTSTRAP = "true";
    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const first = await fetch(`http://127.0.0.1:${port}/lib/session-insights.mjs`, {
      redirect: "manual",
    });
    expect(first.status).toBe(302);
    const cookie = first.headers.get("set-cookie") || "";
    expect(cookie).toContain("ve_session=");
    const location = first.headers.get("location") || "";
    expect(location).toContain("localBootstrap=1");

    const second = await fetch(`http://127.0.0.1:${port}${location}`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(second.status).toBe(302);

    const finalLocation = second.headers.get("location") || "";
    const third = await fetch(`http://127.0.0.1:${port}${finalLocation}`, {
      headers: { cookie },
    });
    expect(third.status).toBe(200);
    expect(String(third.headers.get("content-type") || "")).toContain("application/javascript");
    expect(await third.text()).toContain("buildSessionInsights");
  });

  it("auto-bootstraps local static requests by default when BOSUN_UI_LOCAL_BOOTSTRAP is unset", async () => {
    process.env.TELEGRAM_UI_ALLOW_UNSAFE = "false";
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    delete process.env.BOSUN_UI_LOCAL_BOOTSTRAP;
    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const response = await fetch(`http://127.0.0.1:${port}/app.js?native=1`, {
      redirect: "manual",
    });

    expect(response.status).toBe(302);
    const setCookie = response.headers.get("set-cookie") || "";
    expect(setCookie).toContain("ve_session=");
    const location = response.headers.get("location") || "";
    expect(location).toContain("localBootstrap=1");
  }, 30000);

  it("allows explicitly disabling local bootstrap with BOSUN_UI_LOCAL_BOOTSTRAP=false", async () => {
    process.env.TELEGRAM_UI_ALLOW_UNSAFE = "false";
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_UI_LOCAL_BOOTSTRAP = "false";
    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const response = await fetch(`http://127.0.0.1:${port}/app.js?native=1`, {
      redirect: "manual",
    });

    expect(response.status).toBe(401);
    const setCookie = response.headers.get("set-cookie") || "";
    expect(setCookie).not.toContain("ve_session=");
    const location = response.headers.get("location") || "";
    expect(location).not.toContain("localBootstrap=1");
  }, 30000);

  it("prefers persisted desktop API key over stale env key during desktop bootstrap", async () => {
    process.env.TELEGRAM_UI_ALLOW_UNSAFE = "false";
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-desktop-key-"));
    process.env.BOSUN_HOME = tmpDir;
    process.env.BOSUN_DESKTOP_API_KEY = "bosun_desktop_stale_env_key";
    writeFileSync(
      join(tmpDir, "desktop-api-key.json"),
      JSON.stringify({ key: "bosun_desktop_persisted_key" }, null, 2),
      "utf8",
    );

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
      dependencies: { configDir: tmpDir },
    });
    const port = server.address().port;

    const bad = await fetch(
      `http://127.0.0.1:${port}/?desktopKey=${encodeURIComponent("bosun_desktop_stale_env_key")}`,
      { redirect: "manual" },
    );
    expect(bad.status).toBe(401);

    const good = await fetch(
      `http://127.0.0.1:${port}/?desktopKey=${encodeURIComponent("bosun_desktop_persisted_key")}`,
      { redirect: "manual" },
    );
    expect(good.status).toBe(302);
    expect(good.headers.get("set-cookie") || "").toContain("ve_session=");
    expect(process.env.BOSUN_DESKTOP_API_KEY).toBe("bosun_desktop_persisted_key");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts with TELEGRAM_UI_PORT=0 by falling back to non-ephemeral default", async () => {
    process.env.TELEGRAM_UI_PORT = "0";
    process.env.BOSUN_UI_ALLOW_EPHEMERAL_PORT = "0";
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const mod = await import("../server/ui-server.mjs");
    let server = null;
    try {
      server = await mod.startTelegramUiServer({
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });

      expect(server).toBeTruthy();
      expect(server.address().port).toBeGreaterThan(0);
    } finally {
      if (server) {
        mod.stopTelegramUiServer();
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }, 30000);

  it("uses http URL for local publicHost when TLS is disabled", async () => {
    process.env.TELEGRAM_UI_TLS_DISABLE = "true";
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      publicHost: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;
    const url = mod.getTelegramUiUrl();

    expect(url).toBe(`http://127.0.0.1:${port}`);
  });

  it("keeps /api/health public when auth is enabled", async () => {
    process.env.TELEGRAM_UI_TLS_DISABLE = "true";
    process.env.TELEGRAM_UI_ALLOW_UNSAFE = "false";
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(typeof payload.uptime).toBe("number");
  }, 30000);

  it("hides tokenized browser URL in startup logs by default", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_UI_BROWSER_OPEN_MODE = "manual";
    delete process.env.BOSUN_UI_LOG_TOKENIZED_BROWSER_URL;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let server = null;
    try {
      const mod = await import("../server/ui-server.mjs");
      server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });
      expect(server).toBeTruthy();
      const browserLog = logSpy.mock.calls
        .map((args) => String(args[0] || ""))
        .find((line) => line.includes("[telegram-ui] Browser access:")) || "";
      expect(browserLog).toContain("token hidden");
      expect(browserLog).not.toContain("/?token=");
    } finally {
      logSpy.mockRestore();
    }
  }, process.platform === "win32" ? 15000 : 10000);

  it("can opt in to tokenized browser URL logs", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_UI_BROWSER_OPEN_MODE = "manual";
    process.env.BOSUN_UI_LOG_TOKENIZED_BROWSER_URL = "true";

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let server = null;
    try {
      const mod = await import("../server/ui-server.mjs");
      server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });
      expect(server).toBeTruthy();
      const browserLog = logSpy.mock.calls
        .map((args) => String(args[0] || ""))
        .find((line) => line.includes("[telegram-ui] Browser access:")) || "";
      expect(browserLog).toContain("/?token=");
    } finally {
      if (server) {
        await new Promise((resolveClose) => server.close(resolveClose));
      }
      await settleUiRuntimeCleanup();
      logSpy.mockRestore();
    }
  }, process.platform === "win32" ? 20000 : 10000);

  it("treats BOSUN_UI_AUTO_OPEN_BROWSER as an auto-open opt-in when no explicit mode is set", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_UI_AUTO_OPEN_BROWSER = "1";
    // Keep the key present but blank so loadDotEnv() cannot repopulate it
    // from a developer .env file during startup.
    process.env.BOSUN_UI_BROWSER_OPEN_MODE = "";

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let server = null;
    try {
      const mod = await import("../server/ui-server.mjs");
      server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });
      expect(server).toBeTruthy();
      const startupLog = logSpy.mock.calls
        .map((args) => String(args[0] || ""))
        .find((line) => line.includes("[telegram-ui] startup config:")) || "";
      expect(startupLog).toContain("browserOpenMode=auto");
      expect(startupLog).toContain("autoOpen=enabled");
    } finally {
      if (server) {
        await new Promise((resolveClose) => server.close(resolveClose));
      }
      await settleUiRuntimeCleanup();
      logSpy.mockRestore();
    }
  }, 90000);

  it("suppresses browser auto-open when the requested port falls back to another port", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_UI_AUTO_OPEN_BROWSER = "1";
    process.env.BOSUN_UI_ALLOW_EPHEMERAL_PORT = "1";
    process.env.BOSUN_UI_BROWSER_OPEN_MODE = "";

    const blocker = createNetServer();
    await new Promise((resolveReady) => blocker.listen(0, "127.0.0.1", resolveReady));
    const blockedPort = blocker.address().port;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const markerPath = resolve(process.env.BOSUN_HOME, ".cache", "ui-auto-open.json");
    let server = null;

    try {
      const mod = await import("../server/ui-server.mjs");
      server = await mod.startTelegramUiServer({
        port: blockedPort,
        host: "127.0.0.1",
        skipInstanceLock: true,
      });
      expect(server).toBeTruthy();
      expect(server.address().port).not.toBe(blockedPort);
      expect(existsSync(markerPath)).toBe(false);
      expect(
        logSpy.mock.calls.some((args) =>
          String(args[0] || "").includes("auto-open suppressed because requested port"),
        ),
      ).toBe(true);
    } finally {
      if (server) {
        await new Promise((resolveClose) => server.close(resolveClose));
      }
      logSpy.mockRestore();
      await new Promise((resolveDone) => blocker.close(resolveDone));
    }
  }, 20000);

  it("reports a running server component from /healthz during telegram surface runtime startup", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.TELEGRAM_MINIAPP_ENABLED = "1";
    process.env.TELEGRAM_UI_PORT = "0";
    process.env.TELEGRAM_UI_HOST = "127.0.0.1";
    process.env.BOSUN_UI_ALLOW_EPHEMERAL_PORT = "1";

    const surfaceRuntime = await import("../telegram/telegram-surface-runtime.mjs");
    const serverMod = await import("../server/ui-server.mjs");
    try {
      await surfaceRuntime.startTelegramSurfaceRuntime({
        suppressPortalAutoOpen: true,
        skipAutoOpen: true,
      });
      const baseUrl = String(serverMod.getTelegramUiUrl() || "").trim();
      expect(baseUrl).toBeTruthy();
      const response = await fetch(`${baseUrl}/healthz`);
      const payload = await response.json();
      expect(response.status).toBe(200);
      expect(payload.status).toBe("ok");
      expect(payload.server).toBe("running");
    } finally {
      surfaceRuntime.stopTelegramSurfaceRuntime();
    }
  }, 15000);

  it("returns effective settings values and sources for derived/default cases", async () => {
    delete process.env.TELEGRAM_MINIAPP_ENABLED;
    process.env.TELEGRAM_UI_PORT = "4400";
    delete process.env.GITHUB_PROJECT_MODE;

    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-settings-view-"));
    const configPath = join(tmpDir, "bosun.config.json");
    process.env.BOSUN_CONFIG_PATH = configPath;
    writeFileSync(
      configPath,
      JSON.stringify({ $schema: "./bosun.schema.json" }, null, 2) + "\n",
      "utf8",
    );

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const response = await fetch(`http://127.0.0.1:${port}/api/settings`);
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data?.TELEGRAM_MINIAPP_ENABLED).toBe("true");
    expect(json.sources?.TELEGRAM_MINIAPP_ENABLED).toBe("derived");
    expect(json.data?.GITHUB_PROJECT_MODE).toBe("issues");
    expect(json.sources?.GITHUB_PROJECT_MODE).toBe("default");
    expect(json.providers?.defaultProviderId).toBeTruthy();
    expect(Array.isArray(json.providers?.items)).toBe(true);
    expect(json.providers.items.some((entry) => entry.providerId === "openai-responses")).toBe(true);

    rmSync(tmpDir, { recursive: true, force: true });
  }, 15000);

  it("serves agent event monitor endpoints for the fleet tab", async () => {
    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });

    try {
      const port = server.address().port;
      const [events, status, liveness, errors] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/api/agents/events?limit=5`).then((r) => r.json()),
        fetch(`http://127.0.0.1:${port}/api/agents/events/status`).then((r) => r.json()),
        fetch(`http://127.0.0.1:${port}/api/agents/events/liveness`).then((r) => r.json()),
        fetch(`http://127.0.0.1:${port}/api/agents/events/errors`).then((r) => r.json()),
      ]);

      expect(events.ok).toBe(true);
      expect(Array.isArray(events.events)).toBe(true);
      expect(status.ok).toBe(true);
      expect(status).toHaveProperty("started");
      expect(liveness.ok).toBe(true);
      expect(Array.isArray(liveness.agents)).toBe(true);
      expect(errors.ok).toBe(true);
      expect(Array.isArray(errors.patterns)).toBe(true);
    } finally {
      mod.stopTelegramUiServer();
    }
  }, 15000);

  it("serves available agent inventory plus mode control endpoints", async () => {
    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });

    try {
      const port = server.address().port;
      const availableResponse = await fetch(`http://127.0.0.1:${port}/api/agents/available`);
      const availableJson = await availableResponse.json();
      expect(availableResponse.status).toBe(200);
      expect(availableJson.ok).toBe(true);
      expect(Array.isArray(availableJson.agents)).toBe(true);
      expect(Array.isArray(availableJson.manualAgents)).toBe(true);
      expect(typeof availableJson.active).toBe("string");
      expect(availableJson.agents.length).toBeGreaterThan(0);
      expect(availableJson.agents[0]).toEqual(expect.objectContaining({
        id: expect.any(String),
        name: expect.any(String),
        available: expect.any(Boolean),
        models: expect.any(Array),
        capabilities: expect.any(Array),
      }));

      const modeResponse = await fetch(`http://127.0.0.1:${port}/api/agents/mode`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "agent" }),
      });
      const modeJson = await modeResponse.json();
      expect(modeResponse.status).toBe(200);
      expect(modeJson.ok).toBe(true);
      expect(modeJson.mode).toBe("agent");
    } finally {
      mod.stopTelegramUiServer();
    }
  }, 15000);

  it("returns provider inventory with auth state, capabilities, and model catalogs", async () => {
    const savedOpenAiApiKey = process.env.OPENAI_API_KEY;
    const savedAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    const savedGeminiApiKey = process.env.GEMINI_API_KEY;
    const savedOpenrouterApiKey = process.env.OPENROUTER_API_KEY;
    const savedPerplexityApiKey = process.env.PERPLEXITY_API_KEY;
    const savedDeepinfraApiKey = process.env.DEEPINFRA_API_KEY;
    const savedGroqApiKey = process.env.GROQ_API_KEY;
    const savedTogetherApiKey = process.env.TOGETHER_API_KEY;
    const savedXaiApiKey = process.env.XAI_API_KEY;
    const savedFireworksApiKey = process.env.FIREWORKS_API_KEY;
    const savedCerebrasApiKey = process.env.CEREBRAS_API_KEY;
    const savedSambanovaApiKey = process.env.SAMBANOVA_API_KEY;
    const savedNebiusApiKey = process.env.NEBIUS_API_KEY;
    const savedDefaultProvider = process.env.BOSUN_PROVIDER_DEFAULT;
    const savedOllamaEnabled = process.env.BOSUN_PROVIDER_OLLAMA_ENABLED;
    const savedOllamaBaseUrl = process.env.BOSUN_PROVIDER_OLLAMA_BASE_URL;
    const savedOpenrouterEnabled = process.env.BOSUN_PROVIDER_OPENROUTER_ENABLED;
    const savedOpenrouterBaseUrl = process.env.BOSUN_PROVIDER_OPENROUTER_BASE_URL;
    const savedPerplexityEnabled = process.env.BOSUN_PROVIDER_PERPLEXITY_ENABLED;
    const savedPerplexityBaseUrl = process.env.BOSUN_PROVIDER_PERPLEXITY_BASE_URL;
    const savedDeepinfraEnabled = process.env.BOSUN_PROVIDER_DEEPINFRA_ENABLED;
    const savedDeepinfraBaseUrl = process.env.BOSUN_PROVIDER_DEEPINFRA_BASE_URL;
    const savedGroqEnabled = process.env.BOSUN_PROVIDER_GROQ_ENABLED;
    const savedGroqBaseUrl = process.env.BOSUN_PROVIDER_GROQ_BASE_URL;
    const savedTogetherEnabled = process.env.BOSUN_PROVIDER_TOGETHER_ENABLED;
    const savedTogetherBaseUrl = process.env.BOSUN_PROVIDER_TOGETHER_BASE_URL;
    const savedXaiEnabled = process.env.BOSUN_PROVIDER_XAI_ENABLED;
    const savedXaiBaseUrl = process.env.BOSUN_PROVIDER_XAI_BASE_URL;
    const savedFireworksEnabled = process.env.BOSUN_PROVIDER_FIREWORKS_ENABLED;
    const savedFireworksBaseUrl = process.env.BOSUN_PROVIDER_FIREWORKS_BASE_URL;
    const savedCerebrasEnabled = process.env.BOSUN_PROVIDER_CEREBRAS_ENABLED;
    const savedCerebrasBaseUrl = process.env.BOSUN_PROVIDER_CEREBRAS_BASE_URL;
    const savedSambanovaEnabled = process.env.BOSUN_PROVIDER_SAMBANOVA_ENABLED;
    const savedSambanovaBaseUrl = process.env.BOSUN_PROVIDER_SAMBANOVA_BASE_URL;
    const savedNebiusEnabled = process.env.BOSUN_PROVIDER_NEBIUS_ENABLED;
    const savedNebiusBaseUrl = process.env.BOSUN_PROVIDER_NEBIUS_BASE_URL;
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    process.env.GEMINI_API_KEY = "test-gemini-key";
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    process.env.PERPLEXITY_API_KEY = "test-perplexity-key";
    process.env.DEEPINFRA_API_KEY = "test-deepinfra-key";
    process.env.GROQ_API_KEY = "test-groq-key";
    process.env.TOGETHER_API_KEY = "test-together-key";
    process.env.XAI_API_KEY = "test-xai-key";
    process.env.FIREWORKS_API_KEY = "test-fireworks-key";
    process.env.CEREBRAS_API_KEY = "test-cerebras-key";
    process.env.SAMBANOVA_API_KEY = "test-sambanova-key";
    process.env.NEBIUS_API_KEY = "test-nebius-key";
    process.env.BOSUN_PROVIDER_DEFAULT = "openai-responses";
    process.env.BOSUN_PROVIDER_OLLAMA_ENABLED = "true";
    process.env.BOSUN_PROVIDER_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
    process.env.BOSUN_PROVIDER_OPENROUTER_ENABLED = "true";
    process.env.BOSUN_PROVIDER_OPENROUTER_BASE_URL = "https://openrouter.example/v1";
    process.env.BOSUN_PROVIDER_PERPLEXITY_ENABLED = "true";
    process.env.BOSUN_PROVIDER_PERPLEXITY_BASE_URL = "https://perplexity.example/v1";
    process.env.BOSUN_PROVIDER_DEEPINFRA_ENABLED = "true";
    process.env.BOSUN_PROVIDER_DEEPINFRA_BASE_URL = "https://deepinfra.example/v1/openai";
    process.env.BOSUN_PROVIDER_GROQ_ENABLED = "true";
    process.env.BOSUN_PROVIDER_GROQ_BASE_URL = "https://groq.example/openai/v1";
    process.env.BOSUN_PROVIDER_TOGETHER_ENABLED = "true";
    process.env.BOSUN_PROVIDER_TOGETHER_BASE_URL = "https://together.example/v1";
    process.env.BOSUN_PROVIDER_XAI_ENABLED = "true";
    process.env.BOSUN_PROVIDER_XAI_BASE_URL = "https://xai.example/v1";
    process.env.BOSUN_PROVIDER_FIREWORKS_ENABLED = "true";
    process.env.BOSUN_PROVIDER_FIREWORKS_BASE_URL = "https://fireworks.example/inference/v1";
    process.env.BOSUN_PROVIDER_CEREBRAS_ENABLED = "true";
    process.env.BOSUN_PROVIDER_CEREBRAS_BASE_URL = "https://cerebras.example/v1";
    process.env.BOSUN_PROVIDER_SAMBANOVA_ENABLED = "true";
    process.env.BOSUN_PROVIDER_SAMBANOVA_BASE_URL = "https://sambanova.example/v1";
    process.env.BOSUN_PROVIDER_NEBIUS_ENABLED = "true";
    process.env.BOSUN_PROVIDER_NEBIUS_BASE_URL = "https://nebius.example/v1";

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });

    try {
      const port = server.address().port;
      const response = await fetch(`http://127.0.0.1:${port}/api/providers`);
      const json = await response.json();
      expect(response.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.defaultProviderId).toBe("openai-responses");
      expect(Array.isArray(json.items)).toBe(true);

      const openaiProvider = json.items.find((entry) => entry.providerId === "openai-responses");
      expect(openaiProvider).toEqual(expect.objectContaining({
        adapterId: "openai-native",
        runtimeOwnership: "native",
        enabled: true,
        capabilities: expect.objectContaining({
          apiKey: true,
          streaming: true,
        }),
        auth: expect.objectContaining({
          authenticated: true,
          canRun: true,
          preferredMode: "apiKey",
        }),
        modelCatalog: expect.objectContaining({
          defaultModel: "gpt-5.4",
        }),
      }));

      const ollamaProvider = json.items.find((entry) => entry.providerId === "ollama");
      expect(ollamaProvider).toEqual(expect.objectContaining({
        adapterId: "openai-native",
        runtimeOwnership: "native",
        enabled: true,
        advanced: true,
        auth: expect.objectContaining({
          status: "ready",
          authenticated: true,
        }),
        modelCatalog: expect.objectContaining({
          defaultModel: "qwen2.5-coder:latest",
        }),
      }));

      const anthropicProvider = json.items.find((entry) => entry.providerId === "anthropic-messages");
      expect(anthropicProvider).toEqual(expect.objectContaining({
        adapterId: "anthropic-native",
        runtimeOwnership: "native",
        enabled: true,
        capabilities: expect.objectContaining({
          apiKey: true,
          tools: true,
        }),
        auth: expect.objectContaining({
          authenticated: true,
          canRun: true,
          preferredMode: "apiKey",
        }),
        modelCatalog: expect.objectContaining({
          defaultModel: "claude-opus-4.1",
        }),
      }));

      const geminiProvider = json.items.find((entry) => entry.providerId === "gemini-generate-content");
      expect(geminiProvider).toEqual(expect.objectContaining({
        adapterId: "gemini-native",
        runtimeOwnership: "native",
        enabled: true,
        capabilities: expect.objectContaining({
          apiKey: true,
          tools: true,
        }),
        auth: expect.objectContaining({
          authenticated: true,
          canRun: true,
          preferredMode: "apiKey",
        }),
        modelCatalog: expect.objectContaining({
          defaultModel: "gemini-2.5-pro",
        }),
      }));

      const openrouterProvider = json.items.find((entry) => entry.providerId === "openrouter");
      expect(openrouterProvider).toEqual(expect.objectContaining({
        adapterId: "openai-native",
        runtimeOwnership: "native",
        enabled: true,
        auth: expect.objectContaining({
          authenticated: true,
          canRun: true,
          preferredMode: "apiKey",
        }),
      }));

      const perplexityProvider = json.items.find((entry) => entry.providerId === "perplexity");
      expect(perplexityProvider).toEqual(expect.objectContaining({
        adapterId: "openai-native",
        runtimeOwnership: "native",
        enabled: true,
        auth: expect.objectContaining({
          authenticated: true,
          canRun: true,
          preferredMode: "apiKey",
        }),
      }));

      const deepinfraProvider = json.items.find((entry) => entry.providerId === "deepinfra");
      expect(deepinfraProvider).toEqual(expect.objectContaining({
        adapterId: "openai-native",
        runtimeOwnership: "native",
        enabled: true,
        auth: expect.objectContaining({
          authenticated: true,
          canRun: true,
          preferredMode: "apiKey",
        }),
      }));

      const groqProvider = json.items.find((entry) => entry.providerId === "groq");
      expect(groqProvider).toEqual(expect.objectContaining({
        adapterId: "openai-native",
        runtimeOwnership: "native",
        enabled: true,
        auth: expect.objectContaining({
          authenticated: true,
          canRun: true,
          preferredMode: "apiKey",
        }),
      }));

      const togetherProvider = json.items.find((entry) => entry.providerId === "together");
      expect(togetherProvider).toEqual(expect.objectContaining({
        adapterId: "openai-native",
        runtimeOwnership: "native",
        enabled: true,
        auth: expect.objectContaining({
          authenticated: true,
          canRun: true,
          preferredMode: "apiKey",
        }),
      }));

      const xaiProvider = json.items.find((entry) => entry.providerId === "xai");
      expect(xaiProvider).toEqual(expect.objectContaining({
        adapterId: "openai-native",
        runtimeOwnership: "native",
        enabled: true,
        auth: expect.objectContaining({
          authenticated: true,
          canRun: true,
          preferredMode: "apiKey",
        }),
      }));

      const fireworksProvider = json.items.find((entry) => entry.providerId === "fireworks");
      expect(fireworksProvider).toEqual(expect.objectContaining({
        adapterId: "openai-native",
        runtimeOwnership: "native",
        enabled: true,
        auth: expect.objectContaining({
          authenticated: true,
          canRun: true,
          preferredMode: "apiKey",
        }),
      }));

      const cerebrasProvider = json.items.find((entry) => entry.providerId === "cerebras");
      expect(cerebrasProvider).toEqual(expect.objectContaining({
        adapterId: "openai-native",
        runtimeOwnership: "native",
        enabled: true,
        auth: expect.objectContaining({
          authenticated: true,
          canRun: true,
          preferredMode: "apiKey",
        }),
      }));

      const sambanovaProvider = json.items.find((entry) => entry.providerId === "sambanova");
      expect(sambanovaProvider).toEqual(expect.objectContaining({
        adapterId: "openai-native",
        runtimeOwnership: "native",
        enabled: true,
        auth: expect.objectContaining({
          authenticated: true,
          canRun: true,
          preferredMode: "apiKey",
        }),
      }));

      const nebiusProvider = json.items.find((entry) => entry.providerId === "nebius");
      expect(nebiusProvider).toEqual(expect.objectContaining({
        adapterId: "openai-native",
        runtimeOwnership: "native",
        enabled: true,
        auth: expect.objectContaining({
          authenticated: true,
          canRun: true,
          preferredMode: "apiKey",
        }),
      }));
    } finally {
      await new Promise((resolve) => server.close(resolve));
      if (savedOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedOpenAiApiKey;
      if (savedAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedAnthropicApiKey;
      if (savedGeminiApiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = savedGeminiApiKey;
      if (savedOpenrouterApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = savedOpenrouterApiKey;
      if (savedPerplexityApiKey === undefined) delete process.env.PERPLEXITY_API_KEY;
      else process.env.PERPLEXITY_API_KEY = savedPerplexityApiKey;
      if (savedDeepinfraApiKey === undefined) delete process.env.DEEPINFRA_API_KEY;
      else process.env.DEEPINFRA_API_KEY = savedDeepinfraApiKey;
      if (savedGroqApiKey === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = savedGroqApiKey;
      if (savedTogetherApiKey === undefined) delete process.env.TOGETHER_API_KEY;
      else process.env.TOGETHER_API_KEY = savedTogetherApiKey;
      if (savedXaiApiKey === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = savedXaiApiKey;
      if (savedFireworksApiKey === undefined) delete process.env.FIREWORKS_API_KEY;
      else process.env.FIREWORKS_API_KEY = savedFireworksApiKey;
      if (savedCerebrasApiKey === undefined) delete process.env.CEREBRAS_API_KEY;
      else process.env.CEREBRAS_API_KEY = savedCerebrasApiKey;
      if (savedSambanovaApiKey === undefined) delete process.env.SAMBANOVA_API_KEY;
      else process.env.SAMBANOVA_API_KEY = savedSambanovaApiKey;
      if (savedNebiusApiKey === undefined) delete process.env.NEBIUS_API_KEY;
      else process.env.NEBIUS_API_KEY = savedNebiusApiKey;
      if (savedDefaultProvider === undefined) delete process.env.BOSUN_PROVIDER_DEFAULT;
      else process.env.BOSUN_PROVIDER_DEFAULT = savedDefaultProvider;
      if (savedOllamaEnabled === undefined) delete process.env.BOSUN_PROVIDER_OLLAMA_ENABLED;
      else process.env.BOSUN_PROVIDER_OLLAMA_ENABLED = savedOllamaEnabled;
      if (savedOllamaBaseUrl === undefined) delete process.env.BOSUN_PROVIDER_OLLAMA_BASE_URL;
      else process.env.BOSUN_PROVIDER_OLLAMA_BASE_URL = savedOllamaBaseUrl;
      if (savedOpenrouterEnabled === undefined) delete process.env.BOSUN_PROVIDER_OPENROUTER_ENABLED;
      else process.env.BOSUN_PROVIDER_OPENROUTER_ENABLED = savedOpenrouterEnabled;
      if (savedOpenrouterBaseUrl === undefined) delete process.env.BOSUN_PROVIDER_OPENROUTER_BASE_URL;
      else process.env.BOSUN_PROVIDER_OPENROUTER_BASE_URL = savedOpenrouterBaseUrl;
      if (savedPerplexityEnabled === undefined) delete process.env.BOSUN_PROVIDER_PERPLEXITY_ENABLED;
      else process.env.BOSUN_PROVIDER_PERPLEXITY_ENABLED = savedPerplexityEnabled;
      if (savedPerplexityBaseUrl === undefined) delete process.env.BOSUN_PROVIDER_PERPLEXITY_BASE_URL;
      else process.env.BOSUN_PROVIDER_PERPLEXITY_BASE_URL = savedPerplexityBaseUrl;
      if (savedDeepinfraEnabled === undefined) delete process.env.BOSUN_PROVIDER_DEEPINFRA_ENABLED;
      else process.env.BOSUN_PROVIDER_DEEPINFRA_ENABLED = savedDeepinfraEnabled;
      if (savedDeepinfraBaseUrl === undefined) delete process.env.BOSUN_PROVIDER_DEEPINFRA_BASE_URL;
      else process.env.BOSUN_PROVIDER_DEEPINFRA_BASE_URL = savedDeepinfraBaseUrl;
      if (savedGroqEnabled === undefined) delete process.env.BOSUN_PROVIDER_GROQ_ENABLED;
      else process.env.BOSUN_PROVIDER_GROQ_ENABLED = savedGroqEnabled;
      if (savedGroqBaseUrl === undefined) delete process.env.BOSUN_PROVIDER_GROQ_BASE_URL;
      else process.env.BOSUN_PROVIDER_GROQ_BASE_URL = savedGroqBaseUrl;
      if (savedTogetherEnabled === undefined) delete process.env.BOSUN_PROVIDER_TOGETHER_ENABLED;
      else process.env.BOSUN_PROVIDER_TOGETHER_ENABLED = savedTogetherEnabled;
      if (savedTogetherBaseUrl === undefined) delete process.env.BOSUN_PROVIDER_TOGETHER_BASE_URL;
      else process.env.BOSUN_PROVIDER_TOGETHER_BASE_URL = savedTogetherBaseUrl;
      if (savedXaiEnabled === undefined) delete process.env.BOSUN_PROVIDER_XAI_ENABLED;
      else process.env.BOSUN_PROVIDER_XAI_ENABLED = savedXaiEnabled;
      if (savedXaiBaseUrl === undefined) delete process.env.BOSUN_PROVIDER_XAI_BASE_URL;
      else process.env.BOSUN_PROVIDER_XAI_BASE_URL = savedXaiBaseUrl;
      if (savedFireworksEnabled === undefined) delete process.env.BOSUN_PROVIDER_FIREWORKS_ENABLED;
      else process.env.BOSUN_PROVIDER_FIREWORKS_ENABLED = savedFireworksEnabled;
      if (savedFireworksBaseUrl === undefined) delete process.env.BOSUN_PROVIDER_FIREWORKS_BASE_URL;
      else process.env.BOSUN_PROVIDER_FIREWORKS_BASE_URL = savedFireworksBaseUrl;
      if (savedCerebrasEnabled === undefined) delete process.env.BOSUN_PROVIDER_CEREBRAS_ENABLED;
      else process.env.BOSUN_PROVIDER_CEREBRAS_ENABLED = savedCerebrasEnabled;
      if (savedCerebrasBaseUrl === undefined) delete process.env.BOSUN_PROVIDER_CEREBRAS_BASE_URL;
      else process.env.BOSUN_PROVIDER_CEREBRAS_BASE_URL = savedCerebrasBaseUrl;
      if (savedSambanovaEnabled === undefined) delete process.env.BOSUN_PROVIDER_SAMBANOVA_ENABLED;
      else process.env.BOSUN_PROVIDER_SAMBANOVA_ENABLED = savedSambanovaEnabled;
      if (savedSambanovaBaseUrl === undefined) delete process.env.BOSUN_PROVIDER_SAMBANOVA_BASE_URL;
      else process.env.BOSUN_PROVIDER_SAMBANOVA_BASE_URL = savedSambanovaBaseUrl;
      if (savedNebiusEnabled === undefined) delete process.env.BOSUN_PROVIDER_NEBIUS_ENABLED;
      else process.env.BOSUN_PROVIDER_NEBIUS_ENABLED = savedNebiusEnabled;
      if (savedNebiusBaseUrl === undefined) delete process.env.BOSUN_PROVIDER_NEBIUS_BASE_URL;
      else process.env.BOSUN_PROVIDER_NEBIUS_BASE_URL = savedNebiusBaseUrl;
    }
  }, 15000);

  it("surfaces named harness executors in chat agent inventory and persists executor fabric updates", async () => {
    const mod = await import("../server/ui-server.mjs");
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-harness-executors-"));
    const configPath = join(tmpDir, "bosun.config.json");
    const savedConfigPath = process.env.BOSUN_CONFIG_PATH;
    process.env.BOSUN_CONFIG_PATH = configPath;
    writeFileSync(configPath, JSON.stringify({
      $schema: "./bosun.schema.json",
      agentRuntime: "harness",
      harness: {
        primaryExecutor: "azure-us",
        routingMode: "spread",
        executors: [
          {
            id: "azure-us",
            name: "Azure US",
            providerId: "azure-openai-responses",
            enabled: true,
            defaultModel: "gpt-5.4",
            models: [
              { id: "gpt-5.4", label: "GPT-5.4", apiStyle: "responses" },
              { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", apiStyle: "chat-completions" },
            ],
            endpoint: "https://azure-us.example.test",
            deployment: "gpt-5-prod",
            apiVersion: "2025-03-01-preview",
          },
          {
            id: "codex-oauth",
            name: "Codex OAuth",
            providerId: "openai-codex-subscription",
            enabled: true,
            defaultModel: "gpt-5.4",
            workspace: "chatgpt-team-alpha",
          },
        ],
      },
      providers: {
        defaultProvider: "openai-responses",
        routingMode: "fallback",
      },
    }, null, 2));

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });

    try {
      const port = server.address().port;
      const [executorsResponse, agentsResponse] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/api/harness/executors`),
        fetch(`http://127.0.0.1:${port}/api/agents/available`),
      ]);
      const executorsJson = await executorsResponse.json();
      const agentsJson = await agentsResponse.json();

      expect(executorsResponse.status).toBe(200);
      expect(executorsJson.ok).toBe(true);
      expect(executorsJson.primaryExecutorId).toBe("azure-us");
      expect(executorsJson.routingMode).toBe("spread");
      expect(executorsJson.executors.map((entry) => entry.id)).toEqual(expect.arrayContaining(["azure-us", "codex-oauth"]));

      expect(agentsResponse.status).toBe(200);
      expect(agentsJson.ok).toBe(true);
      expect(agentsJson.active).toBe("azure-us");
      expect(agentsJson.agents.map((entry) => entry.id)).toEqual(["azure-us", "codex-oauth"]);
      expect(agentsJson.agents.find((entry) => entry.id === "azure-us")).toEqual(expect.objectContaining({
        providerId: "azure-openai-responses",
        adapterId: "openai-native",
        runtimeOwnership: "native",
        providerLabel: "Azure OpenAI Responses",
        runtimeKind: "harness",
        models: ["gpt-5.4", "gpt-5.4-mini"],
        modelEntries: [
          expect.objectContaining({ id: "gpt-5.4", label: "GPT-5.4", apiStyle: "responses" }),
          expect.objectContaining({ id: "gpt-5.4-mini", label: "GPT-5.4 Mini", apiStyle: "chat-completions" }),
        ],
        subtitle: "Azure OpenAI Responses · gpt-5.4 · Responses API",
      }));

      const updateResponse = await fetch(`http://127.0.0.1:${port}/api/harness/executors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          primaryExecutor: "local-openai",
          routingMode: "fallback",
          executors: [
            {
              id: "local-openai",
              name: "Local OpenAI Compatible",
              providerId: "openai-compatible",
              enabled: true,
              defaultModel: "qwen2.5-coder:latest",
              models: [
                { id: "qwen2.5-coder:latest", label: "Qwen 2.5 Coder", apiStyle: "chat-completions" },
                { id: "llama3.3:70b", label: "Llama 3.3 70B", apiStyle: "responses" },
              ],
              baseUrl: "http://127.0.0.1:4000/v1",
              apiStyle: "chat-completions",
            },
          ],
        }),
      });
      const updateJson = await updateResponse.json();
      expect(updateResponse.status).toBe(200);
      expect(updateJson.ok).toBe(true);
      expect(updateJson.primaryExecutorId).toBe("local-openai");
      expect(updateJson.executors.map((entry) => entry.id)).toEqual(["local-openai"]);

      const refreshedAgentsResponse = await fetch(`http://127.0.0.1:${port}/api/agents/available`);
      const refreshedAgentsJson = await refreshedAgentsResponse.json();
      expect(refreshedAgentsResponse.status).toBe(200);
      expect(refreshedAgentsJson.ok).toBe(true);
      expect(refreshedAgentsJson.active).toBe("local-openai");
      expect(refreshedAgentsJson.agents.map((entry) => entry.id)).toEqual(["local-openai"]);

      const savedConfig = JSON.parse(readFileSync(configPath, "utf8"));
      expect(savedConfig.harness).toEqual(expect.objectContaining({
        primaryExecutor: "local-openai",
        routingMode: "fallback",
        executors: [
          expect.objectContaining({
            id: "local-openai",
            providerId: "openai-compatible",
            baseUrl: "http://127.0.0.1:4000/v1",
            models: [
              expect.objectContaining({ id: "qwen2.5-coder:latest", label: "Qwen 2.5 Coder", apiStyle: "chat-completions" }),
              expect.objectContaining({ id: "llama3.3:70b", label: "Llama 3.3 70B", apiStyle: "responses" }),
            ],
            apiStyle: "chat-completions",
          }),
        ],
      }));
      expect(savedConfig.providers).toEqual(expect.objectContaining({
        defaultProvider: "openai-compatible",
        routingMode: "fallback",
        openaiCompatible: expect.objectContaining({
          enabled: true,
        }),
      }));
    } finally {
      await new Promise((resolve) => server.close(resolve));
      if (savedConfigPath == null) delete process.env.BOSUN_CONFIG_PATH;
      else process.env.BOSUN_CONFIG_PATH = savedConfigPath;
      await removeDirWithRetries(tmpDir);
    }
  }, 15000);

  it("prefers harness-native provider inventory over legacy SDK pool profiles when Harness is primary", async () => {
    const mod = await import("../server/ui-server.mjs");
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-harness-provider-chat-"));
    const configPath = join(tmpDir, "bosun.config.json");
    const savedConfigPath = process.env.BOSUN_CONFIG_PATH;
    process.env.BOSUN_CONFIG_PATH = configPath;
    writeFileSync(configPath, JSON.stringify({
      $schema: "./bosun.schema.json",
      agentRuntime: "harness",
      harness: {
        enabled: true,
        executors: [],
      },
      executorConfig: {
        executors: [
          {
            name: "primary-codex-us",
            executor: "CODEX",
            variant: "DEFAULT",
            enabled: true,
            models: ["gpt-5.3-codex"],
          },
          {
            name: "copilot-backup",
            executor: "COPILOT",
            variant: "DEFAULT",
            enabled: true,
            models: ["claude-opus-4.6"],
          },
        ],
      },
      providers: {
        defaultProvider: "azure-openai-responses",
        azureOpenAi: {
          enabled: true,
          defaultModel: "gpt-5.4-mini",
          endpoint: "https://azure-us.example.test",
          deployment: "gpt-5-prod",
          apiVersion: "2025-03-01-preview",
        },
        openaiResponses: {
          enabled: true,
          defaultModel: "gpt-5.4",
        },
      },
    }, null, 2));

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });

    try {
      const port = server.address().port;
      const response = await fetch(`http://127.0.0.1:${port}/api/agents/available`);
      const json = await response.json();
      const agentIds = json.agents.map((entry) => entry.id);

      expect(response.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(agentIds).toContain("openai-responses");
      expect(agentIds).not.toContain("primary-codex-us");
      expect(agentIds).not.toContain("copilot-backup");
      expect(agentIds.every((id) => !["primary-codex-us", "copilot-backup"].includes(id))).toBe(true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      if (savedConfigPath === undefined) delete process.env.BOSUN_CONFIG_PATH;
      else process.env.BOSUN_CONFIG_PATH = savedConfigPath;
    }
  }, 15000);

  it("supports multiple Harness runtime instances from the same provider family with executor-specific auth bindings", async () => {
    const mod = await import("../server/ui-server.mjs");
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-harness-multi-instance-"));
    const configPath = join(tmpDir, "bosun.config.json");
    const savedConfigPath = process.env.BOSUN_CONFIG_PATH;
    const savedAzureApiKey = process.env.AZURE_OPENAI_API_KEY;
    const savedAzureUsApiKey = process.env.AZURE_US_API_KEY;
    const savedAzureSwedenApiKey = process.env.AZURE_SWEDEN_API_KEY;
    const savedOpenAiApiKey = process.env.OPENAI_API_KEY;
    process.env.BOSUN_CONFIG_PATH = configPath;
    process.env.AZURE_OPENAI_API_KEY = "";
    process.env.AZURE_US_API_KEY = "azure-us-secret";
    process.env.AZURE_SWEDEN_API_KEY = "azure-sweden-secret";
    process.env.OPENAI_API_KEY = "openai-primary-secret";
    writeFileSync(configPath, JSON.stringify({
      $schema: "./bosun.schema.json",
      agentRuntime: "harness",
      harness: {
        primaryExecutor: "azure-us",
        routingMode: "spread",
        executors: [
          {
            id: "azure-us",
            name: "Azure US",
            providerId: "azure-openai-responses",
            enabled: true,
            weight: 120,
            defaultModel: "gpt-5.4",
            endpoint: "https://azure-us.example.test",
            deployment: "gpt-5-us",
            apiVersion: "2025-03-01-preview",
            authBindings: {
              apiKeyEnv: "AZURE_US_API_KEY",
            },
            models: [
              { id: "gpt-5.4", label: "GPT-5.4 US", apiStyle: "responses" },
            ],
          },
          {
            id: "azure-sweden",
            name: "Azure Sweden",
            providerId: "azure-openai-responses",
            enabled: true,
            weight: 60,
            defaultModel: "gpt-5.4-mini",
            endpoint: "https://azure-sweden.example.test",
            deployment: "gpt-5-sweden",
            apiVersion: "2025-03-01-preview",
            authBindings: {
              apiKeyEnv: "AZURE_SWEDEN_API_KEY",
            },
            models: [
              { id: "gpt-5.4-mini", label: "GPT-5.4 Mini Sweden", apiStyle: "chat-completions" },
            ],
          },
          {
            id: "openai-prod",
            name: "OpenAI Prod",
            providerId: "openai-responses",
            enabled: true,
            weight: 20,
            defaultModel: "gpt-5.4",
            authBindings: {
              apiKeyEnv: "OPENAI_API_KEY",
            },
            models: [
              { id: "gpt-5.4", label: "GPT-5.4", apiStyle: "responses" },
              { id: "gpt-4.1", label: "GPT-4.1", apiStyle: "chat-completions" },
            ],
          },
        ],
      },
    }, null, 2));

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });

    try {
      const port = server.address().port;
      const [executorsResponse, agentsResponse] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/api/harness/executors`),
        fetch(`http://127.0.0.1:${port}/api/agents/available`),
      ]);
      const executorsJson = await executorsResponse.json();
      const agentsJson = await agentsResponse.json();

      expect(executorsResponse.status).toBe(200);
      expect(executorsJson.ok).toBe(true);
      expect(executorsJson.executors.map((entry) => entry.id)).toEqual([
        "azure-us",
        "azure-sweden",
        "openai-prod",
      ]);
      expect(executorsJson.executors.find((entry) => entry.id === "azure-us")).toEqual(expect.objectContaining({
        providerId: "azure-openai-responses",
        adapterId: "openai-native",
        runtimeOwnership: "native",
        weight: 120,
        authBindings: expect.objectContaining({
          apiKeyEnv: "AZURE_US_API_KEY",
        }),
        auth: expect.objectContaining({
          authenticated: true,
          canRun: true,
        }),
      }));
      expect(executorsJson.executors.find((entry) => entry.id === "azure-sweden")).toEqual(expect.objectContaining({
        providerId: "azure-openai-responses",
        adapterId: "openai-native",
        runtimeOwnership: "native",
        weight: 60,
        authBindings: expect.objectContaining({
          apiKeyEnv: "AZURE_SWEDEN_API_KEY",
        }),
        auth: expect.objectContaining({
          authenticated: true,
          canRun: true,
        }),
      }));

      expect(agentsResponse.status).toBe(200);
      expect(agentsJson.ok).toBe(true);
      expect(agentsJson.active).toBe("azure-us");
      expect(agentsJson.agents.map((entry) => entry.id)).toEqual([
        "azure-us",
        "azure-sweden",
        "openai-prod",
      ]);
      expect(agentsJson.agents.find((entry) => entry.id === "azure-sweden")).toEqual(expect.objectContaining({
        providerId: "azure-openai-responses",
        adapterId: "openai-native",
        runtimeOwnership: "native",
        runtimeKind: "harness",
        available: true,
        weight: 60,
        defaultModel: "gpt-5.4-mini",
        modelEntries: [
          expect.objectContaining({
            id: "gpt-5.4-mini",
            apiStyle: "chat-completions",
          }),
        ],
        subtitle: "Azure OpenAI Responses · gpt-5.4-mini · Responses API · azure-sweden.example.test · gpt-5-sweden",
      }));
      expect(agentsJson.agents.find((entry) => entry.id === "openai-prod")).toEqual(expect.objectContaining({
        providerId: "openai-responses",
        adapterId: "openai-native",
        runtimeOwnership: "native",
        available: true,
        weight: 20,
        modelEntries: [
          expect.objectContaining({ id: "gpt-5.4", apiStyle: "responses" }),
          expect.objectContaining({ id: "gpt-4.1", apiStyle: "chat-completions" }),
        ],
      }));
    } finally {
      await new Promise((resolve) => server.close(resolve));
      if (savedConfigPath === undefined) delete process.env.BOSUN_CONFIG_PATH;
      else process.env.BOSUN_CONFIG_PATH = savedConfigPath;
      if (savedAzureApiKey === undefined) delete process.env.AZURE_OPENAI_API_KEY;
      else process.env.AZURE_OPENAI_API_KEY = savedAzureApiKey;
      if (savedAzureUsApiKey === undefined) delete process.env.AZURE_US_API_KEY;
      else process.env.AZURE_US_API_KEY = savedAzureUsApiKey;
      if (savedAzureSwedenApiKey === undefined) delete process.env.AZURE_SWEDEN_API_KEY;
      else process.env.AZURE_SWEDEN_API_KEY = savedAzureSwedenApiKey;
      if (savedOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedOpenAiApiKey;
      await removeDirWithRetries(tmpDir);
    }
  }, 15000);

  it("supports Gemini Harness executors with provider-specific auth bindings and endpoint persistence", async () => {
    const mod = await import("../server/ui-server.mjs");
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-harness-gemini-instance-"));
    const configPath = join(tmpDir, "bosun.config.json");
    const savedConfigPath = process.env.BOSUN_CONFIG_PATH;
    const savedGeminiApiKey = process.env.GEMINI_API_KEY;
    const savedGeminiRegionalKey = process.env.GEMINI_REGIONAL_KEY;
    process.env.BOSUN_CONFIG_PATH = configPath;
    process.env.GEMINI_API_KEY = "";
    process.env.GEMINI_REGIONAL_KEY = "gemini-regional-secret";
    writeFileSync(configPath, JSON.stringify({
      $schema: "./bosun.schema.json",
      agentRuntime: "harness",
      harness: {
        primaryExecutor: "gemini-regional",
        routingMode: "fallback",
        executors: [
          {
            id: "gemini-regional",
            name: "Gemini Regional",
            providerId: "gemini-generate-content",
            enabled: true,
            defaultModel: "gemini-2.5-pro",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            authBindings: {
              apiKeyEnv: "GEMINI_REGIONAL_KEY",
            },
            models: [
              { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
            ],
          },
        ],
      },
    }, null, 2));

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });

    try {
      const port = server.address().port;
      const [executorsResponse, agentsResponse] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/api/harness/executors`),
        fetch(`http://127.0.0.1:${port}/api/agents/available`),
      ]);
      const executorsJson = await executorsResponse.json();
      const agentsJson = await agentsResponse.json();

      expect(executorsJson.executors.find((entry) => entry.id === "gemini-regional")).toEqual(expect.objectContaining({
        providerId: "gemini-generate-content",
        adapterId: "gemini-native",
        runtimeOwnership: "native",
        authBindings: expect.objectContaining({
          apiKeyEnv: "GEMINI_REGIONAL_KEY",
        }),
        auth: expect.objectContaining({
          authenticated: true,
          canRun: true,
        }),
      }));

      expect(agentsJson.agents.find((entry) => entry.id === "gemini-regional")).toEqual(expect.objectContaining({
        providerId: "gemini-generate-content",
        adapterId: "gemini-native",
        runtimeOwnership: "native",
        runtimeKind: "harness",
        available: true,
        defaultModel: "gemini-2.5-pro",
      }));
    } finally {
      await new Promise((resolve) => server.close(resolve));
      if (savedConfigPath === undefined) delete process.env.BOSUN_CONFIG_PATH;
      else process.env.BOSUN_CONFIG_PATH = savedConfigPath;
      if (savedGeminiApiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = savedGeminiApiKey;
      if (savedGeminiRegionalKey === undefined) delete process.env.GEMINI_REGIONAL_KEY;
      else process.env.GEMINI_REGIONAL_KEY = savedGeminiRegionalKey;
      await removeDirWithRetries(tmpDir);
    }
  }, 15000);

  it("serves the TUI config tree and saves schema-validated config edits atomically", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-tui-config-"));
    const configPath = join(tmpDir, "bosun.config.json");
    const savedConfigPath = process.env.BOSUN_CONFIG_PATH;
    const savedKanbanBackend = process.env.KANBAN_BACKEND;
    delete process.env.KANBAN_BACKEND;
    process.env.BOSUN_CONFIG_PATH = configPath;
    writeFileSync(
      configPath,
      JSON.stringify({
        $schema: "./bosun.schema.json",
        kanban: { backend: "github" },
        internalExecutor: { maxParallel: 3 },
        worktreeBootstrap: { commandTimeoutMs: 600000 },
        voice: { openaiApiKey: "from-config" },
      }, null, 2) + "\n",
      "utf8",
    );

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const treeRes = await fetch(`http://127.0.0.1:${port}/api/tui/config`);
    const treeJson = await treeRes.json();
    expect(treeRes.status).toBe(200);
    expect(treeJson.ok).toBe(true);
    expect(treeJson.sections.some((section) => section.label === "Kanban")).toBe(true);
    const secretField = treeJson.sections
      .flatMap((section) => section.items || [])
      .find((item) => item.path === "voice.openaiApiKey");
    expect(secretField?.masked).toBe(true);

    let reloadPayload = null;
    const stopListening = addConfigReloadListener((payload) => {
      reloadPayload = payload;
    });

    const saveRes = await fetch(`http://127.0.0.1:${port}/api/tui/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "kanban.backend", value: "internal" }),
    });
    const saveJson = await saveRes.json();
    expect(saveRes.status).toBe(200);
    expect(saveJson.ok).toBe(true);
    expect(JSON.parse(readFileSync(configPath, "utf8")).kanban.backend).toBe("internal");
    expect(reloadPayload?.path).toBe("kanban.backend");
    expect(reloadPayload?.reason).toBe("tui-config-update");
    expect(readdirSync(tmpDir).filter((name) => name.includes(".tmp-"))).toEqual([]);

    const invalidRes = await fetch(`http://127.0.0.1:${port}/api/tui/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "worktreeBootstrap.commandTimeoutMs", value: "oops" }),
    });
    const invalidJson = await invalidRes.json();
    expect(invalidRes.status).toBe(400);
    expect(invalidJson.ok).toBe(false);
    expect(JSON.parse(readFileSync(configPath, "utf8")).worktreeBootstrap.commandTimeoutMs).toBe(600000);

    process.env.KANBAN_BACKEND = "jira";
    const readonlyRes = await fetch(`http://127.0.0.1:${port}/api/tui/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "kanban.backend", value: "github" }),
    });
    const readonlyJson = await readonlyRes.json();
    expect(readonlyRes.status).toBe(409);
    expect(readonlyJson.error).toContain("read-only");

    stopListening();
    rmSync(tmpDir, { recursive: true, force: true });
    if (savedConfigPath === undefined) delete process.env.BOSUN_CONFIG_PATH;
    else process.env.BOSUN_CONFIG_PATH = savedConfigPath;
    if (savedKanbanBackend === undefined) delete process.env.KANBAN_BACKEND;
    else process.env.KANBAN_BACKEND = savedKanbanBackend;
  }, 15000);

  it("serves and updates guardrails policy and runtime state", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "bosun-guardrails-workspace-"));
    const configDir = mkdtempSync(join(tmpdir(), "bosun-guardrails-config-"));
    const configPath = join(configDir, "bosun.config.json");
    // Clear higher-priority workspace hints so BOSUN_HOME is used
    const savedMonitorHome = process.env.CODEX_MONITOR_HOME;
    const savedMonitorDir = process.env.CODEX_MONITOR_DIR;
    delete process.env.CODEX_MONITOR_HOME;
    delete process.env.CODEX_MONITOR_DIR;
    process.env.BOSUN_HOME = workspaceDir;
    process.env.BOSUN_CONFIG_PATH = configPath;
    delete process.env.BOSUN_FLOW_REQUIRE_REVIEW;
    writeFileSync(
      configPath,
      JSON.stringify({ $schema: "./bosun.schema.json" }, null, 2) + "\n",
      "utf8",
    );

    const mod = await import("../server/ui-server.mjs");
    let server = null;
    try {
      server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
      });
      const port = server.address().port;

      const overviewRes = await fetch(`http://127.0.0.1:${port}/api/guardrails`);
      const overviewJson = await overviewRes.json();
      expect(overviewRes.status).toBe(200);
      expect(overviewJson.ok).toBe(true);
      expect(overviewJson.snapshot.INPUT.policy.enabled).toBe(true);
      expect(overviewJson.snapshot.push.policy.blockAgentPushes).toBe(true);
      expect(overviewJson.snapshot.push.policy.requireManagedPrePush).toBe(true);
      expect(existsSync(resolve(workspaceDir, ".bosun", "guardrails.json"))).toBe(true);

      const policyRes = await fetch(`http://127.0.0.1:${port}/api/guardrails/policy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ INPUT: { warnThreshold: 75, blockThreshold: 45 }, push: { blockAgentPushes: false } }),
      });
      const policyJson = await policyRes.json();
      expect(policyRes.status).toBe(200);
      expect(policyJson.INPUT.policy.warnThreshold).toBe(75);
      expect(policyJson.INPUT.policy.blockThreshold).toBe(45);
      expect(policyJson.push.policy.blockAgentPushes).toBe(false);

      const runtimeRes = await fetch(`http://127.0.0.1:${port}/api/guardrails/runtime`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ preflightEnabled: false, requireReview: false }),
      });
      const runtimeJson = await runtimeRes.json();
      expect(runtimeRes.status).toBe(200);
      expect(runtimeJson.runtime.preflightEnabled).toBe(false);
      expect(runtimeJson.runtime.requireReview).toBe(false);
      expect(JSON.parse(readFileSync(configPath, "utf8")).preflightEnabled).toBe(false);
      expect(readFileSync(join(configDir, ".env"), "utf8")).toContain("BOSUN_FLOW_REQUIRE_REVIEW=false");

      const assessRes = await fetch(`http://127.0.0.1:${port}/api/guardrails/assess`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: { title: "fix", description: "" } }),
      });
      const assessJson = await assessRes.json();
      expect(assessRes.status).toBe(200);
      expect(assessJson.assessment.blocked).toBe(true);
      expect(assessJson.assessment.status).toBe("block");
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
      await removeDirWithRetries(workspaceDir);
      await removeDirWithRetries(configDir);
      // Restore higher-priority workspace hints
      if (savedMonitorHome !== undefined) process.env.CODEX_MONITOR_HOME = savedMonitorHome;
      if (savedMonitorDir !== undefined) process.env.CODEX_MONITOR_DIR = savedMonitorDir;
    }
  }, 15000);

  it("reflects runtime kanban backend switches via config update", async () => {
    process.env.KANBAN_BACKEND = "github";
    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
    });
    const port = server.address().port;

    const toInternal = await fetch(`http://127.0.0.1:${port}/api/config/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "kanban", value: "internal" }),
    });
    const toInternalJson = await toInternal.json();
    expect(toInternal.status).toBe(200);
    expect(toInternalJson.ok).toBe(true);

    const internalRes = await fetch(`http://127.0.0.1:${port}/api/config`);
    const internalJson = await internalRes.json();
    expect(internalRes.status).toBe(200);
    expect(internalJson.kanbanBackend).toBe("internal");

    const toGithub = await fetch(`http://127.0.0.1:${port}/api/config/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "kanban", value: "github" }),
    });
    const toGithubJson = await toGithub.json();
    expect(toGithub.status).toBe(200);
    expect(toGithubJson.ok).toBe(true);

    const githubRes = await fetch(`http://127.0.0.1:${port}/api/config`);
    const githubJson = await githubRes.json();
    expect(githubRes.status).toBe(200);
    expect(githubJson.kanbanBackend).toBe("github");
  }, 15000);

  it("accepts signed project webhook and triggers task sync", async () => {
    const mod = await import("../server/ui-server.mjs");
    const syncTask = vi.fn().mockResolvedValue(undefined);
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      dependencies: {
        getSyncEngine: () => ({
          syncTask,
          getStatus: () => ({ metrics: { rateLimitEvents: 0 } }),
        }),
      },
    });
    const port = server.address().port;
    const body = JSON.stringify({
      action: "edited",
      projects_v2_item: {
        content: {
          number: 42,
          url: "https://github.com/acme/widgets/issues/42",
        },
      },
    });

    const response = await fetch(
      `http://127.0.0.1:${port}/api/webhooks/github/project-sync`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "projects_v2_item",
          "x-hub-signature-256": signBody("webhook-secret", body),
        },
        body,
      },
    );
    const json = await response.json();

    expect(response.status).toBe(202);
    expect(json.ok).toBe(true);
    expect(syncTask).toHaveBeenCalledWith("42");

    const metrics = await fetch(
      `http://127.0.0.1:${port}/api/project-sync/metrics`,
      { headers: { Authorization: "Bearer unused" } },
    ).then((r) => r.json());
    expect(metrics.data.webhook.syncSuccess).toBe(1);
  }, 15000);

  it("rejects webhook with invalid signature", async () => {
    const mod = await import("../server/ui-server.mjs");
    const syncTask = vi.fn().mockResolvedValue(undefined);
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      dependencies: {
        getSyncEngine: () => ({
          syncTask,
          getStatus: () => ({ metrics: { rateLimitEvents: 0 } }),
        }),
      },
    });
    const port = server.address().port;
    const body = JSON.stringify({
      action: "edited",
      projects_v2_item: { content: { number: 7 } },
    });

    const response = await fetch(
      `http://127.0.0.1:${port}/api/webhooks/github/project-sync`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "projects_v2_item",
          "x-hub-signature-256": "sha256=bad",
        },
        body,
      },
    );

    expect(response.status).toBe(401);
    expect(syncTask).not.toHaveBeenCalled();

    const metrics = await fetch(
      `http://127.0.0.1:${port}/api/project-sync/metrics`,
    ).then((r) => r.json());
    expect(metrics.data.webhook.invalidSignature).toBe(1);
  }, 15000);

  it("triggers alert hook after repeated webhook sync failures", async () => {
    const mod = await import("../server/ui-server.mjs");
    const onProjectSyncAlert = vi.fn();
    const syncTask = vi.fn().mockRejectedValue(new Error("sync failed"));
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      dependencies: {
        getSyncEngine: () => ({
          syncTask,
          getStatus: () => ({ metrics: { rateLimitEvents: 0 } }),
        }),
        onProjectSyncAlert,
      },
    });
    const port = server.address().port;
    const body = JSON.stringify({
      action: "edited",
      projects_v2_item: { content: { number: 9 } },
    });
    const signature = signBody("webhook-secret", body);

    await fetch(`http://127.0.0.1:${port}/api/webhooks/github/project-sync`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "projects_v2_item",
        "x-hub-signature-256": signature,
      },
      body,
    });
    await fetch(`http://127.0.0.1:${port}/api/webhooks/github/project-sync`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "projects_v2_item",
        "x-hub-signature-256": signature,
      },
      body,
    });

    expect(onProjectSyncAlert).toHaveBeenCalledTimes(1);
    const metrics = await fetch(
      `http://127.0.0.1:${port}/api/project-sync/metrics`,
    ).then((r) => r.json());
    expect(metrics.data.webhook.alertsTriggered).toBe(1);
  }, 15000);

  it("returns schema field errors for invalid hook targets", async () => {
    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
    });
    const port = server.address().port;

    const response = await fetch(`http://127.0.0.1:${port}/api/settings/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        changes: {
          BOSUN_HOOK_TARGETS: "codex,invalid",
        },
      }),
    });
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.ok).toBe(false);
    expect(json.fieldErrors?.BOSUN_HOOK_TARGETS).toBeTruthy();
  }, 15000);

  it("writes supported settings into config file", async () => {
    const mod = await import("../server/ui-server.mjs");
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-config-"));
    const configPath = join(tmpDir, "bosun.config.json");
    process.env.BOSUN_CONFIG_PATH = configPath;

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
    });
    const port = server.address().port;

    const response = await fetch(`http://127.0.0.1:${port}/api/settings/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        changes: {
          KANBAN_BACKEND: "github",
          GITHUB_PROJECT_MODE: "kanban",
          GITHUB_PROJECT_WEBHOOK_PATH: "/api/webhooks/github/project-sync",
          GITHUB_PROJECT_SYNC_ALERT_FAILURE_THRESHOLD: "5",
          BOSUN_AGENT_RUNTIME: "harness",
          EXECUTOR_MODE: "internal",
          INTERNAL_EXECUTOR_PARALLEL: "5",
          INTERNAL_EXECUTOR_REVIEW_AGENT_ENABLED: "false",
          INTERNAL_EXECUTOR_REPLENISH_ENABLED: "true",
          PROJECT_REQUIREMENTS_PROFILE: "system",
          BOSUN_HARNESS_ENABLED: "true",
          BOSUN_HARNESS_SOURCE: ".bosun/harness/internal-harness.md",
          BOSUN_HARNESS_VALIDATION_MODE: "enforce",
          BOSUN_PROVIDER_ROUTING_MODE: "spread",
          TELEGRAM_UI_PORT: "4400",
          TELEGRAM_INTERVAL_MIN: "15",
          FLEET_ENABLED: "false",
          FLEET_SYNC_INTERVAL_MS: "90000",
          SELF_RESTART_QUIET_MS: "180000",
          EXECUTORS: "CODEX:DEFAULT:70,COPILOT:DEFAULT:30",
        },
      }),
    });
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.updatedConfig).toEqual(
      expect.arrayContaining([
        "KANBAN_BACKEND",
        "GITHUB_PROJECT_MODE",
        "GITHUB_PROJECT_WEBHOOK_PATH",
        "GITHUB_PROJECT_SYNC_ALERT_FAILURE_THRESHOLD",
        "BOSUN_AGENT_RUNTIME",
        "EXECUTOR_MODE",
        "INTERNAL_EXECUTOR_PARALLEL",
        "INTERNAL_EXECUTOR_REVIEW_AGENT_ENABLED",
        "INTERNAL_EXECUTOR_REPLENISH_ENABLED",
        "PROJECT_REQUIREMENTS_PROFILE",
        "BOSUN_HARNESS_ENABLED",
        "BOSUN_HARNESS_SOURCE",
        "BOSUN_HARNESS_VALIDATION_MODE",
        "BOSUN_PROVIDER_ROUTING_MODE",
        "TELEGRAM_UI_PORT",
        "TELEGRAM_INTERVAL_MIN",
        "FLEET_ENABLED",
        "FLEET_SYNC_INTERVAL_MS",
        "SELF_RESTART_QUIET_MS",
        "EXECUTORS",
      ]),
    );
    expect(json.configPath).toBe(configPath);
    expect(json.configDir).toBe(tmpDir);

    const raw = readFileSync(configPath, "utf8");
    const config = JSON.parse(raw);
    expect(config.kanban?.backend).toBe("github");
    expect(config.kanban?.github?.project?.mode).toBe("kanban");
    expect(config.kanban?.github?.project?.webhook?.path).toBe("/api/webhooks/github/project-sync");
    expect(config.kanban?.github?.project?.syncMonitoring?.alertFailureThreshold).toBe(5);
    expect(config.agentRuntime).toBe("harness");
    expect(config.internalExecutor?.mode).toBe("internal");
    expect(config.internalExecutor?.maxParallel).toBe(5);
    expect(config.internalExecutor?.reviewAgentEnabled).toBe(false);
    expect(config.internalExecutor?.backlogReplenishment?.enabled).toBe(true);
    expect(config.projectRequirements?.profile).toBe("system");
    expect(config.harness?.enabled).toBe(true);
    expect(config.harness?.source).toBe(".bosun/harness/internal-harness.md");
    expect(config.harness?.validation?.mode).toBe("enforce");
    expect(config.providers?.routingMode).toBe("spread");
    expect(config.telegramUiPort).toBe(4400);
    expect(config.telegramIntervalMin).toBe(15);
    expect(config.fleetEnabled).toBe(false);
    expect(config.fleetSyncIntervalMs).toBe(90000);
    expect(process.env.SELF_RESTART_QUIET_MS).toBe("180000");
    expect(config.executors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ executor: "CODEX", variant: "DEFAULT", weight: 70 }),
        expect.objectContaining({ executor: "COPILOT", variant: "DEFAULT", weight: 30 }),
      ]),
    );

    rmSync(tmpDir, { recursive: true, force: true });
  }, 15000);

  it("accepts executor pool variants with dots and preserves model allow-lists on settings save", async () => {
    const mod = await import("../server/ui-server.mjs");
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-config-executors-"));
    const configPath = join(tmpDir, "bosun.config.json");
    process.env.BOSUN_CONFIG_PATH = configPath;

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
    });
    const port = server.address().port;

    const response = await fetch(`http://127.0.0.1:${port}/api/settings/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        changes: {
          EXECUTORS: "CODEX:GPT-5.4:70:gpt-5.4|gpt-5.3-codex,COPILOT:DEFAULT:30",
        },
      }),
    });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.updatedConfig).toEqual(expect.arrayContaining(["EXECUTORS"]));

    const raw = readFileSync(configPath, "utf8");
    const config = JSON.parse(raw);
    expect(config.executors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          executor: "CODEX",
          variant: "GPT-5.4",
          weight: 70,
          models: ["gpt-5.4", "gpt-5.3-codex"],
        }),
        expect.objectContaining({
          executor: "COPILOT",
          variant: "DEFAULT",
          weight: 30,
        }),
      ]),
    );

    rmSync(tmpDir, { recursive: true, force: true });
  }, 15000);

  it("writes provider kernel settings into config and rejects invalid default providers", async () => {
    const mod = await import("../server/ui-server.mjs");
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-provider-config-"));
    const configPath = join(tmpDir, "bosun.config.json");
    const savedConfigPath = process.env.BOSUN_CONFIG_PATH;
    process.env.BOSUN_CONFIG_PATH = configPath;

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
    });

    try {
      const port = server.address().port;
      const response = await fetch(`http://127.0.0.1:${port}/api/settings/update`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          changes: {
            BOSUN_AGENT_RUNTIME: "harness",
            BOSUN_PROVIDER_DEFAULT: "openai-compatible",
            BOSUN_PROVIDER_ROUTING_MODE: "spread",
            BOSUN_PROVIDER_OPENAI_COMPATIBLE_ENABLED: "true",
            BOSUN_PROVIDER_OPENAI_COMPATIBLE_MODEL: "qwen2.5-coder:latest",
            BOSUN_PROVIDER_OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:4000/v1",
            BOSUN_PROVIDER_OPENAI_CODEX_SUBSCRIPTION_ENABLED: "true",
            BOSUN_PROVIDER_OPENAI_CODEX_SUBSCRIPTION_WORKSPACE: "chatgpt-team-alpha",
            BOSUN_PROVIDER_AZURE_OPENAI_ENABLED: "true",
            BOSUN_PROVIDER_AZURE_OPENAI_MODE: "oauth",
            BOSUN_PROVIDER_AZURE_OPENAI_DEPLOYMENT: "gpt-5-prod",
            BOSUN_PROVIDER_CLAUDE_SUBSCRIPTION_ENABLED: "true",
            BOSUN_PROVIDER_CLAUDE_SUBSCRIPTION_WORKSPACE: "claude-lab-beta",
          },
        }),
      });
      const json = await response.json();
      expect(response.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.updatedConfig).toEqual(expect.arrayContaining([
        "BOSUN_AGENT_RUNTIME",
        "BOSUN_PROVIDER_DEFAULT",
        "BOSUN_PROVIDER_ROUTING_MODE",
        "BOSUN_PROVIDER_OPENAI_COMPATIBLE_ENABLED",
        "BOSUN_PROVIDER_OPENAI_COMPATIBLE_MODEL",
        "BOSUN_PROVIDER_OPENAI_COMPATIBLE_BASE_URL",
        "BOSUN_PROVIDER_OPENAI_CODEX_SUBSCRIPTION_ENABLED",
        "BOSUN_PROVIDER_OPENAI_CODEX_SUBSCRIPTION_WORKSPACE",
        "BOSUN_PROVIDER_AZURE_OPENAI_ENABLED",
        "BOSUN_PROVIDER_AZURE_OPENAI_MODE",
        "BOSUN_PROVIDER_AZURE_OPENAI_DEPLOYMENT",
        "BOSUN_PROVIDER_CLAUDE_SUBSCRIPTION_ENABLED",
        "BOSUN_PROVIDER_CLAUDE_SUBSCRIPTION_WORKSPACE",
      ]));

      const config = JSON.parse(readFileSync(configPath, "utf8"));
      expect(config.agentRuntime).toBe("harness");
      expect(config.providers).toEqual(expect.objectContaining({
        defaultProvider: "openai-compatible",
        routingMode: "spread",
        chatgptCodex: expect.objectContaining({
          enabled: true,
          workspace: "chatgpt-team-alpha",
        }),
        openaiCompatible: expect.objectContaining({
          enabled: true,
          defaultModel: "qwen2.5-coder:latest",
          baseUrl: "http://127.0.0.1:4000/v1",
        }),
        azureOpenai: expect.objectContaining({
          enabled: true,
          mode: "oauth",
          deployment: "gpt-5-prod",
        }),
        claudeSubscription: expect.objectContaining({
          enabled: true,
          workspace: "claude-lab-beta",
        }),
      }));

      await new Promise((resolve) => setTimeout(resolve, 2100));
      const invalidResponse = await fetch(`http://127.0.0.1:${port}/api/settings/update`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          changes: {
            BOSUN_PROVIDER_DEFAULT: "not-a-provider",
          },
        }),
      });
      const invalidJson = await invalidResponse.json();
      expect(invalidResponse.status).toBe(400);
      expect(invalidJson.ok).toBe(false);
      expect(invalidJson.fieldErrors?.BOSUN_PROVIDER_DEFAULT).toBeTruthy();
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await settleUiRuntimeCleanup();
      await removeDirWithRetries(tmpDir);
      if (savedConfigPath === undefined) delete process.env.BOSUN_CONFIG_PATH;
      else process.env.BOSUN_CONFIG_PATH = savedConfigPath;
    }
  }, 30000);

  it("writes RepoMirror settings into config file and allows runtime backend selection", async () => {
    const mod = await import("../server/ui-server.mjs");
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-config-"));
    const configPath = join(tmpDir, "bosun.config.json");
    const savedConfigPath = process.env.BOSUN_CONFIG_PATH;
    process.env.BOSUN_CONFIG_PATH = configPath;

    let server = null;
    server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    try {
      const port = server.address().port;

      const response = await fetch(`http://127.0.0.1:${port}/api/settings/update`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          changes: {
            KANBAN_BACKEND: "repo-mirror",
            REPO_MIRROR_ENABLED: "true",
            REPO_MIRROR_REPO_PATH: "C:/tmp/repo-mirror-projection",
            REPO_MIRROR_SYNC_MODE: "projection",
            REPO_MIRROR_RUN_STORAGE: "local",
            REPO_MIRROR_MESSAGE_STORAGE: "off",
            REPO_MIRROR_PUBLIC_ROADMAP_ENABLED: "true",
          },
        }),
      });
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.updatedConfig).toEqual(
        expect.arrayContaining([
          "KANBAN_BACKEND",
          "REPO_MIRROR_ENABLED",
          "REPO_MIRROR_REPO_PATH",
          "REPO_MIRROR_SYNC_MODE",
          "REPO_MIRROR_RUN_STORAGE",
          "REPO_MIRROR_MESSAGE_STORAGE",
          "REPO_MIRROR_PUBLIC_ROADMAP_ENABLED",
        ]),
      );
      expect(process.env.KANBAN_BACKEND).toBe("repo-mirror");

      const config = JSON.parse(readFileSync(configPath, "utf8"));
      expect(config.kanban?.backend).toBe("repo-mirror");
      expect(config.kanban?.repoMirror).toEqual({
        enabled: true,
        repoPath: "C:/tmp/repo-mirror-projection",
        syncMode: "projection",
        runStorage: "local",
        messageStorage: "off",
        publicRoadmapEnabled: true,
      });
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
      await removeDirWithRetries(tmpDir);
      if (savedConfigPath === undefined) delete process.env.BOSUN_CONFIG_PATH;
      else process.env.BOSUN_CONFIG_PATH = savedConfigPath;
    }
  }, 20000);

  it("rejects RepoMirror backend selection when required RepoMirror settings are missing", async () => {
    const mod = await import("../server/ui-server.mjs");
    let server = null;
    server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    try {
      const port = server.address().port;

      const response = await fetch(`http://127.0.0.1:${port}/api/settings/update`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          changes: {
            KANBAN_BACKEND: "repo-mirror",
            REPO_MIRROR_ENABLED: "false",
            REPO_MIRROR_REPO_PATH: "",
          },
        }),
      });
      const json = await response.json();

      expect(response.status).toBe(400);
      expect(json.ok).toBe(false);
      expect(json.fieldErrors?.REPO_MIRROR_ENABLED).toMatch(/must be enabled/i);
      expect(json.fieldErrors?.REPO_MIRROR_REPO_PATH).toMatch(/required/i);
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
    }
  }, 10000);

  it("does not sync unsupported settings into config file", async () => {
    const mod = await import("../server/ui-server.mjs");
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-config-"));
    const configPath = join(tmpDir, "bosun.config.json");
    const savedConfigPath = process.env.BOSUN_CONFIG_PATH;
    process.env.BOSUN_CONFIG_PATH = configPath;

    let server = null;
    server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    try {
      const port = server.address().port;
      await new Promise((resolve) => setTimeout(resolve, 2100));

      const response = await fetch(`http://127.0.0.1:${port}/api/settings/update`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          changes: {
            OPENAI_API_KEY: "sk-test-value",
          },
        }),
      });
      const json = await response.json();
      expect(response.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.updatedConfig).toEqual([]);

      if (existsSync(configPath)) {
        const raw = readFileSync(configPath, "utf8");
        const config = JSON.parse(raw);
        expect(config.openaiApiKey).toBeUndefined();
      } else {
        expect(existsSync(configPath)).toBe(false);
      }
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
      await removeDirWithRetries(tmpDir);
      if (savedConfigPath === undefined) delete process.env.BOSUN_CONFIG_PATH;
      else process.env.BOSUN_CONFIG_PATH = savedConfigPath;
    }
  }, 20000);

  it("returns trigger template payload with history/stat fields", async () => {
    const mod = await import("../server/ui-server.mjs");
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-trigger-config-"));
    const configPath = join(tmpDir, "bosun.config.json");
    const savedConfigPath = process.env.BOSUN_CONFIG_PATH;
    process.env.BOSUN_CONFIG_PATH = configPath;
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          $schema: "./bosun.schema.json",
          triggerSystem: {
            enabled: false,
            defaults: { executor: "auto", model: "auto" },
            templates: [
              {
                id: "daily-review-digest",
                name: "Daily Review Digest",
                enabled: false,
                action: "create-task",
                trigger: { anyOf: [{ kind: "interval", minutes: 1440 }] },
                config: { executor: "auto", model: "auto" },
              },
            ],
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    let server = null;
    server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    try {
      const port = server.address().port;

      const response = await fetch(`http://127.0.0.1:${port}/api/triggers/templates`);
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.data).toBeTruthy();
      expect(Array.isArray(json.data.templates)).toBe(true);
      expect(json.data.templates.length).toBeGreaterThan(0);
      expect(json.data.templates[0].stats).toBeDefined();
      expect(json.data.templates[0].state).toBeDefined();
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
      await removeDirWithRetries(tmpDir);
      if (savedConfigPath === undefined) delete process.env.BOSUN_CONFIG_PATH;
      else process.env.BOSUN_CONFIG_PATH = savedConfigPath;
    }
  }, 20000);

  it("persists trigger template updates to config", async () => {
    const mod = await import("../server/ui-server.mjs");
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-trigger-config-"));
    const configPath = join(tmpDir, "bosun.config.json");
    process.env.BOSUN_CONFIG_PATH = configPath;
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          $schema: "./bosun.schema.json",
          triggerSystem: {
            enabled: false,
            defaults: { executor: "auto", model: "auto" },
            templates: [
              {
                id: "daily-review-digest",
                name: "Daily Review Digest",
                enabled: false,
                action: "create-task",
                trigger: { anyOf: [{ kind: "interval", minutes: 1440 }] },
                config: { executor: "auto", model: "auto" },
              },
            ],
          },
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
    });
    const port = server.address().port;

    const response = await fetch(`http://127.0.0.1:${port}/api/triggers/templates/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        template: {
          id: "daily-review-digest",
          enabled: true,
          description: "updated from test",
          minIntervalMinutes: 45,
          state: {
            last_success_at: new Date().toISOString(),
          },
          stats: {
            spawnedTotal: 12,
          },
        },
      }),
    });
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data.enabled).toBe(true);

    const saved = JSON.parse(readFileSync(configPath, "utf8"));
    expect(saved.triggerSystem.enabled).toBe(true);
    const updatedTemplate = (saved.triggerSystem.templates || []).find(
      (template) => template.id === "daily-review-digest",
    );
    expect(updatedTemplate?.enabled).toBe(true);
    expect(updatedTemplate?.description).toBe("updated from test");
    expect(updatedTemplate?.minIntervalMinutes).toBe(45);
    expect(updatedTemplate).not.toHaveProperty("state");
    expect(updatedTemplate).not.toHaveProperty("stats");

    rmSync(tmpDir, { recursive: true, force: true });
  }, 15000);

  it("exports task state snapshots via mini app API", async () => {
    const mod = await import("../server/ui-server.mjs");
    const taskStore = await import("../task/task-store.mjs");

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
    });
    const port = server.address().port;

    taskStore.addTask({
      id: "task-export-1",
      title: "Export me",
      status: "todo",
      timeline: [{ type: "task.created", source: "test" }],
      workflowRuns: [{ runId: "run-1", workflowId: "wf-1", status: "completed" }],
      statusHistory: [{ status: "todo", timestamp: new Date().toISOString(), source: "test" }],
    });
    await taskStore.waitForStoreWrites();

    const response = await fetch(`http://127.0.0.1:${port}/api/tasks/export`);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data.kind).toBe("bosun-task-state-export");
    expect(json.data.backend).toBe("internal");
    expect(Array.isArray(json.data.tasks)).toBe(true);
    const exported = json.data.tasks.find((task) => task.id === "task-export-1");
    expect(exported?.title).toBe("Export me");
    expect(Array.isArray(exported?.timeline)).toBe(true);
    expect(exported?.timeline?.length).toBeGreaterThan(0);
    expect(Array.isArray(exported?.workflowRuns)).toBe(true);
    expect(exported?.workflowRuns?.[0]?.runId).toBe("run-1");
  }, 15000);

  it("imports task state snapshots with merge semantics via mini app API", async () => {
    const mod = await import("../server/ui-server.mjs");
    const taskStore = await import("../task/task-store.mjs");

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
    });
    const port = server.address().port;

    taskStore.addTask({
      id: "task-import-1",
      title: "Original title",
      status: "todo",
    });
    await taskStore.waitForStoreWrites();

    const response = await fetch(`http://127.0.0.1:${port}/api/tasks/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "merge",
        tasks: [
          {
            id: "task-import-1",
            title: "Updated title",
            status: "inreview",
            timeline: [{ type: "status.transition", source: "import" }],
            workflowRuns: [{ runId: "run-import-1", workflowId: "wf-import-1", status: "completed" }],
            statusHistory: [{ status: "inreview", timestamp: new Date().toISOString(), source: "import" }],
          },
          {
            id: "task-import-2",
            title: "Imported task",
            status: "todo",
          },
        ],
      }),
    });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data.summary.created).toBe(1);
    expect(json.data.summary.updated).toBe(1);

    const updatedTask = taskStore.getTask("task-import-1");
    const createdTask = taskStore.getTask("task-import-2");
    expect(updatedTask?.title).toBe("Updated title");
    expect(updatedTask?.status).toBe("inreview");
    expect(Array.isArray(updatedTask?.workflowRuns)).toBe(true);
    expect(updatedTask?.workflowRuns?.[0]?.runId).toBe("run-import-1");
    expect(createdTask?.title).toBe("Imported task");
  }, 15000);

  it("queues /plan commands in background to avoid request timeouts", async () => {
    const mod = await import("../server/ui-server.mjs");
    let resolveCommand;
    const pendingCommand = new Promise((resolve) => {
      resolveCommand = resolve;
    });
    const handleUiCommand = vi.fn().mockImplementation(() => pendingCommand);
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      dependencies: {
        handleUiCommand,
      },
    });
    const port = server.address().port;

    const response = await fetch(`http://127.0.0.1:${port}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "/plan 5 fix flaky tests" }),
    });
    const json = await response.json();

    expect(response.status).toBe(202);
    expect(json.ok).toBe(true);
    expect(json.queued).toBe(true);
    expect(json.command).toBe("/plan 5 fix flaky tests");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(handleUiCommand).toHaveBeenCalledWith("/plan 5 fix flaky tests");

    resolveCommand({ executed: true });
    await pendingCommand;
  });

  it("binds chat session execution cwd to the active workspace repo", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-chat-workspace-"));
    const configPath = join(tmpDir, "bosun.config.json");
    const workspaceRepo = join(tmpDir, "workspaces", "chatws", "virtengine");
    mkdirSync(workspaceRepo, { recursive: true });
    mkdirSync(join(workspaceRepo, ".git"), { recursive: true });
    process.env.BOSUN_CONFIG_PATH = configPath;
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          $schema: "./bosun.schema.json",
          activeWorkspace: "chatws",
          workspaces: [
            {
              id: "chatws",
              name: "Chat Workspace",
              activeRepo: "virtengine",
              repos: [{ name: "virtengine", primary: true }],
            },
          ],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const execPrimaryPrompt = vi.fn().mockResolvedValue({
      finalResponse: "ok",
      items: [],
    });
    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      dependencies: { execPrimaryPrompt },
    });
    try {
      const port = server.address().port;

      const createResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "primary", prompt: "hello" }),
      });
      const createJson = await createResponse.json();
      expect(createResponse.status).toBe(200);
      expect(createJson.ok).toBe(true);
      expect(createJson.session.metadata.workspaceId).toBe("chatws");
      expect(createJson.session.metadata.workspaceDir).toBe(workspaceRepo);
      const sessionId = createJson.session.id;

      const messageResponse = await fetch(
        `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/message`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: "run task", mode: "agent" }),
        },
      );
      const messageJson = await messageResponse.json();
      expect(messageResponse.status).toBe(200);
      expect(messageJson.ok).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(execPrimaryPrompt).toHaveBeenCalledTimes(1);
      const [, opts] = execPrimaryPrompt.mock.calls[0];
      expect(opts.sessionId).toBe(sessionId);
      expect(opts.cwd).toBe(workspaceRepo);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await settleUiRuntimeCleanup();
      await removeDirWithRetries(tmpDir);
    }
  }, 15000);

  it("falls back to the requested workspace root when a session is created without a resolved repo path", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-chat-workspace-root-"));
    const configPath = join(tmpDir, "bosun.config.json");
    const workspaceRoot = join(tmpDir, "workspaces", "chatws");
    mkdirSync(workspaceRoot, { recursive: true });
    process.env.BOSUN_CONFIG_PATH = configPath;
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          $schema: "./bosun.schema.json",
          workspaces: [
            {
              id: "chatws",
              name: "Chat Workspace",
              activeRepo: "virtengine",
              repos: [{ name: "virtengine", primary: true }],
              path: workspaceRoot,
            },
          ],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    try {
      const port = server.address().port;
      const createResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "primary", workspaceId: "chatws", prompt: "hello" }),
      });
      const createJson = await createResponse.json();
      expect(createResponse.status).toBe(200);
      expect(createJson.ok).toBe(true);
      expect(createJson.session.metadata.workspaceId).toBe("chatws");
      expect(createJson.session.metadata.workspaceDir).toBe(workspaceRoot);
      expect(createJson.session.metadata.workspaceRoot).toBe(workspaceRoot);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await settleUiRuntimeCleanup();
      await removeDirWithRetries(tmpDir);
    }
  }, 15000);

  it("stops an in-flight session turn via /api/sessions/:id/stop", async () => {
    let rejectTurn = null;
    const execPrimaryPrompt = vi.fn().mockImplementation((_content, opts = {}) => {
      return new Promise((_, reject) => {
        rejectTurn = reject;
        const signal = opts?.abortController?.signal;
        if (!signal) return;
        if (signal.aborted) {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
          return;
        }
        signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        }, { once: true });
      });
    });

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      dependencies: { execPrimaryPrompt },
    });
    const port = server.address().port;

    const createResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "primary", prompt: "hello" }),
    });
    const createJson = await createResponse.json();
    const sessionId = createJson.session.id;

    const messageResponse = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/message`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "run until stopped", mode: "agent" }),
      },
    );
    const messageJson = await messageResponse.json();
    expect(messageResponse.status).toBe(200);
    expect(messageJson.ok).toBe(true);

    const sessionResponse = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}?full=1`,
    );
    const sessionJson = await sessionResponse.json();
    expect(sessionResponse.status).toBe(200);
    expect(sessionJson.session?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "run until stopped" }),
      ]),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(execPrimaryPrompt).toHaveBeenCalledTimes(1);
    expect(execPrimaryPrompt.mock.calls[0][1]?.abortController).toBeTruthy();

    const stopResponse = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/stop`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const stopJson = await stopResponse.json();
    expect(stopResponse.status).toBe(200);
    expect(stopJson.ok).toBe(true);
    expect(stopJson.stopped).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const stopAgainResponse = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/stop`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const stopAgainJson = await stopAgainResponse.json();
    expect(stopAgainResponse.status).toBe(200);
    expect(stopAgainJson.ok).toBe(true);
    expect(stopAgainJson.stopped).toBe(false);

    // Ensure pending promise cannot leak if abort listener was not reached.
    if (rejectTurn) {
      const err = new Error("forced cleanup");
      err.name = "AbortError";
      rejectTurn(err);
    }
  }, 15000);

  it("persists queued session follow-ups and drains them after the active turn completes", async () => {
    const turnResolvers = [];
    const execPrimaryPrompt = vi.fn().mockImplementation((_content, _opts = {}) => new Promise((resolve) => {
      turnResolvers.push(resolve);
    }));

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      dependencies: { execPrimaryPrompt },
    });

    try {
      const port = server.address().port;
      const createResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "primary", prompt: "hello" }),
      });
      const createJson = await createResponse.json();
      const sessionId = createJson.session.id;

      const firstMessageResponse = await fetch(
        `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/message`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: "run until complete", mode: "agent" }),
        },
      );
      const firstMessageJson = await firstMessageResponse.json();
      expect(firstMessageResponse.status).toBe(200);
      expect(firstMessageJson.ok).toBe(true);

      await vi.waitFor(() => {
        expect(execPrimaryPrompt).toHaveBeenCalledTimes(1);
      });

      const queuedResponse = await fetch(
        `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/message`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            content: "follow up after the current turn",
            mode: "agent",
            deliveryMode: "queue",
          }),
        },
      );
      const queuedJson = await queuedResponse.json();
      expect(queuedResponse.status).toBe(202);
      expect(queuedJson).toMatchObject({
        ok: true,
        queued: true,
        deliveryMode: "queue",
        sessionId,
        queueDepth: 1,
        queuedMessage: expect.objectContaining({
          content: "follow up after the current turn",
        }),
      });

      const queuedSession = await fetch(
        `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}?full=1`,
      ).then((r) => r.json());
      expect(queuedSession.session?.metadata?.queuedFollowups).toEqual([
        expect.objectContaining({
          content: "follow up after the current turn",
        }),
      ]);

      turnResolvers.shift()?.({ finalResponse: "first complete", items: [] });

      await vi.waitFor(() => {
        expect(execPrimaryPrompt).toHaveBeenCalledTimes(2);
      });
      expect(execPrimaryPrompt.mock.calls[1][0]).toBe("follow up after the current turn");

      turnResolvers.shift()?.({ finalResponse: "second complete", items: [] });

      let settledSession = null;
      const settleDeadline = Date.now() + 5000;
      while (Date.now() < settleDeadline) {
        settledSession = await fetch(
          `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}?full=1`,
        ).then((r) => r.json());
        if ((settledSession.session?.metadata?.queuedFollowups || []).length === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(settledSession.session?.metadata?.queuedFollowups || []).toHaveLength(0);
      expect(settledSession.session?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "user", content: "run until complete" }),
          expect.objectContaining({ role: "user", content: "follow up after the current turn" }),
        ]),
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await settleUiRuntimeCleanup();
    }
  }, 15000);

  it("routes sdk commands with the session workspace cwd", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-sdk-workspace-"));
    const configPath = join(tmpDir, "bosun.config.json");
    const workspaceRepo = join(tmpDir, "workspaces", "sdkws", "app");
    mkdirSync(workspaceRepo, { recursive: true });
    mkdirSync(join(workspaceRepo, ".git"), { recursive: true });
    process.env.BOSUN_CONFIG_PATH = configPath;
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          $schema: "./bosun.schema.json",
          activeWorkspace: "sdkws",
          workspaces: [
            {
              id: "sdkws",
              name: "SDK Workspace",
              activeRepo: "app",
              repos: [{ name: "app", primary: true }],
            },
          ],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const execSdkCommand = vi.fn().mockResolvedValue("sdk-ok");
    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      dependencies: { execSdkCommand },
    });
    try {
      const port = server.address().port;

      const createResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "primary", prompt: "hello" }),
      });
      const createJson = await createResponse.json();
      const sessionId = createJson.session.id;

      const sdkResponse = await fetch(`http://127.0.0.1:${port}/api/agents/sdk-command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "/status", sessionId }),
      });
      const sdkJson = await sdkResponse.json();
      expect(sdkResponse.status).toBe(200);
      expect(sdkJson.ok).toBe(true);
      expect(sdkJson.result).toBe("sdk-ok");
      expect(execSdkCommand).toHaveBeenCalledWith(
        "/status",
        "",
        undefined,
        expect.objectContaining({
          cwd: workspaceRepo,
          sessionId,
        }),
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await settleUiRuntimeCleanup();
      await removeDirWithRetries(tmpDir);
    }
  }, 15000);

  it("scopes session listing to the active workspace by default", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-session-scope-"));
    const configPath = join(tmpDir, "bosun.config.json");
    const ws1Repo = join(tmpDir, "workspaces", "ws-one", "repo1");
    const ws2Repo = join(tmpDir, "workspaces", "ws-two", "repo2");
    mkdirSync(join(ws1Repo, ".git"), { recursive: true });
    mkdirSync(join(ws2Repo, ".git"), { recursive: true });
    process.env.BOSUN_CONFIG_PATH = configPath;
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          $schema: "./bosun.schema.json",
          activeWorkspace: "ws-one",
          workspaces: [
            {
              id: "ws-one",
              name: "Workspace One",
              activeRepo: "repo1",
              repos: [{ name: "repo1", primary: true }],
            },
            {
              id: "ws-two",
              name: "Workspace Two",
              activeRepo: "repo2",
              repos: [{ name: "repo2", primary: true }],
            },
          ],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
    });
    const port = server.address().port;
    try {
      const setActiveWsOne = await fetch(`http://127.0.0.1:${port}/api/workspaces/active`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "ws-one" }),
      }).then((r) => r.json());
      // Some environments initialize managed workspaces lazily, so explicit
      // activation can fail even when activeWorkspace is already set in config.
      expect(typeof setActiveWsOne.ok).toBe("boolean");

      const wsOneCreate = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "workspace-scope-test", workspaceId: "ws-one" }),
      }).then((r) => r.json());
      if (!wsOneCreate?.ok) {
        return;
      }
      const wsOneSessionId = wsOneCreate?.session?.id;

      const wsTwoCreate = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "workspace-scope-test", workspaceId: "ws-two" }),
      }).then((r) => r.json());
      if (!wsTwoCreate?.ok) {
        return;
      }

      const activeList = await fetch(
        `http://127.0.0.1:${port}/api/sessions?type=workspace-scope-test`,
      ).then((r) => r.json());
      expect(activeList.ok).toBe(true);
      expect(activeList.sessions).toHaveLength(1);
      expect(activeList.sessions[0]?.id).toBe(wsOneSessionId);

      const allList = await fetch(
        `http://127.0.0.1:${port}/api/sessions?type=workspace-scope-test&workspace=all`,
      ).then((r) => r.json());
      expect(allList.ok).toBe(true);
      expect(allList.sessions.length).toBeGreaterThanOrEqual(2);
      const wsTwoSessionId = wsTwoCreate?.session?.id;
      expect(typeof wsTwoSessionId).toBe("string");

      const allScopedSession = await fetch(
        `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(wsTwoSessionId)}?workspace=all&limit=10`,
      );
      expect(allScopedSession.status).toBe(200);
      const allScopedSessionBody = await allScopedSession.json();
      expect(allScopedSessionBody.ok).toBe(true);
      expect(allScopedSessionBody.session?.id).toBe(wsTwoSessionId);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await settleUiRuntimeCleanup();
      await removeDirWithRetries(tmpDir);
    }
  }, 20000);

  it("prefers repo-local .bosun config over global BOSUN_HOME for active workspace routing", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const previousRepoRoot = process.env.REPO_ROOT;
    const previousBosunHome = process.env.BOSUN_HOME;
    const previousBosunDir = process.env.BOSUN_DIR;
    const previousTestRepoLocalOverride = process.env.BOSUN_TEST_ALLOW_REPO_LOCAL_CONFIG;
    const repoRootDir = mkdtempSync(join(tmpdir(), "bosun-repo-local-config-"));
    const globalHomeDir = mkdtempSync(join(tmpdir(), "bosun-global-home-"));
    const repoConfigDir = join(repoRootDir, ".bosun");
    const repoConfigPath = join(repoConfigDir, "bosun.config.json");
    const globalConfigPath = join(globalHomeDir, "bosun.config.json");
    const repoWorkspaceDir = join(repoRootDir, "workspaces", "repo-ws", "bosun");
    const globalWorkspaceDir = join(globalHomeDir, "workspaces", "global-ws", "bosun");

    mkdirSync(join(repoWorkspaceDir, ".git"), { recursive: true });
    mkdirSync(join(globalWorkspaceDir, ".git"), { recursive: true });
    mkdirSync(repoConfigDir, { recursive: true });

    writeFileSync(
      repoConfigPath,
      JSON.stringify(
        {
          $schema: "./bosun.schema.json",
          activeWorkspace: "repo-ws",
          workspaces: [
            {
              id: "repo-ws",
              name: "Repo Workspace",
              activeRepo: "bosun",
              repos: [{ name: "bosun", url: repoWorkspaceDir, primary: true }],
            },
          ],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    writeFileSync(
      globalConfigPath,
      JSON.stringify(
        {
          $schema: "./bosun.schema.json",
          activeWorkspace: "global-ws",
          workspaces: [
            {
              id: "global-ws",
              name: "Global Workspace",
              activeRepo: "bosun",
              repos: [{ name: "bosun", url: globalWorkspaceDir, primary: true }],
            },
          ],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    process.env.REPO_ROOT = repoRootDir;
    process.env.BOSUN_HOME = globalHomeDir;
    process.env.BOSUN_DIR = globalHomeDir;
    process.env.BOSUN_TEST_ALLOW_REPO_LOCAL_CONFIG = "1";
    delete process.env.BOSUN_CONFIG_PATH;
    vi.resetModules();
    let server = null;

    try {
      const mod = await import("../server/ui-server.mjs");
      server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });
      const port = server.address().port;

      const createResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "repo-local-config-test" }),
      });
      const createJson = await createResponse.json();

      expect(createResponse.status).toBe(200);
      expect(createJson.ok).toBe(true);
      expect(createJson.session.metadata.workspaceId).toBe("repo-ws");
      expect(createJson.session.metadata.workspaceDir).toBe(repoWorkspaceDir);

      const listJson = await fetch(
        `http://127.0.0.1:${port}/api/sessions?type=repo-local-config-test`,
      ).then((r) => r.json());
      expect(listJson.ok).toBe(true);
      expect(listJson.sessions).toHaveLength(1);
      expect(listJson.sessions[0]?.workspaceId).toBe("repo-ws");
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
      vi.resetModules();
      if (previousRepoRoot === undefined) delete process.env.REPO_ROOT;
      else process.env.REPO_ROOT = previousRepoRoot;
      if (previousBosunHome === undefined) delete process.env.BOSUN_HOME;
      else process.env.BOSUN_HOME = previousBosunHome;
      if (previousBosunDir === undefined) delete process.env.BOSUN_DIR;
      else process.env.BOSUN_DIR = previousBosunDir;
      if (previousTestRepoLocalOverride === undefined) delete process.env.BOSUN_TEST_ALLOW_REPO_LOCAL_CONFIG;
      else process.env.BOSUN_TEST_ALLOW_REPO_LOCAL_CONFIG = previousTestRepoLocalOverride;
      await removeDirWithRetries(repoRootDir);
      await removeDirWithRetries(globalHomeDir);
    }
  }, 20000);

  it("hides leaked smoke sessions from the default session list", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const mod = await import("../server/ui-server.mjs");
    const { _resetSingleton, getSessionTracker } = await import("../infra/session-tracker.mjs");
    _resetSingleton({ persistDir: null });
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;
    const tracker = getSessionTracker();
    tracker.createSession({
      id: "smoke-openai-legacy",
      type: "primary",
      metadata: { title: "smoke-openai-legacy" },
    });
    tracker.createSession({
      id: "manual-visible-session",
      type: "primary",
      metadata: { title: "Visible Session" },
    });

    const listRes = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    const listJson = await listRes.json();
    expect(listRes.status).toBe(200);
    expect(listJson.ok).toBe(true);
    expect(listJson.sessions.some((session) => session.id === "smoke-openai-legacy")).toBe(false);
    expect(listJson.sessions.some((session) => session.id === "manual-visible-session")).toBe(true);

    const hiddenListRes = await fetch(`http://127.0.0.1:${port}/api/sessions?includeHidden=1`);
    const hiddenListJson = await hiddenListRes.json();
    expect(hiddenListRes.status).toBe(200);
    expect(hiddenListJson.ok).toBe(true);
    expect(hiddenListJson.sessions.some((session) => session.id === "smoke-openai-legacy")).toBe(true);
  }, 30000);

  it("hides internal voice http sessions from the default session list", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const mod = await import("../server/ui-server.mjs");
    const { _resetSingleton, getSessionTracker } = await import("../infra/session-tracker.mjs");
    _resetSingleton({ persistDir: null });
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;
    const tracker = getSessionTracker();
    tracker.createSession({
      id: "primary-voice-http-test-hidden",
      type: "voice",
      metadata: {
        source: "voice-http",
        hiddenInLists: true,
      },
    });
    tracker.createSession({
      id: "manual-visible-session",
      type: "primary",
      metadata: { title: "Visible Session" },
    });

    const listRes = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    const listJson = await listRes.json();
    expect(listRes.status).toBe(200);
    expect(listJson.ok).toBe(true);
    expect(listJson.sessions.some((session) => session.id === "primary-voice-http-test-hidden")).toBe(false);
    expect(listJson.sessions.some((session) => session.id === "manual-visible-session")).toBe(true);

    const hiddenListRes = await fetch(`http://127.0.0.1:${port}/api/sessions?includeHidden=1`);
    const hiddenListJson = await hiddenListRes.json();
    expect(hiddenListRes.status).toBe(200);
    expect(hiddenListJson.ok).toBe(true);
    expect(hiddenListJson.sessions.some((session) => session.id === "primary-voice-http-test-hidden")).toBe(true);
  }, 15000);

  it("hides synthetic historic session ids from the default session list", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const ledgerPath = process.env.BOSUN_STATE_LEDGER_PATH;
    upsertSessionRecordToStateLedger({
      sessionId: "hist-live-100",
      type: "primary",
      workspaceId: "ws-main",
      taskId: "hist-live-100",
      taskTitle: "Historic Session 100",
      status: "completed",
      latestEventType: "assistant",
      updatedAt: "2026-03-31T09:56:38.106Z",
      startedAt: "2026-03-31T09:56:38.106Z",
      eventCount: 1,
      preview: "historic 100",
      document: {
        id: "hist-live-100",
        taskId: "hist-live-100",
        taskTitle: "Historic Session 100",
        title: "Historic Session 100",
        type: "primary",
        status: "completed",
        lifecycleStatus: "completed",
        workspaceId: "ws-main",
        createdAt: "2026-03-31T09:56:38.106Z",
        lastActiveAt: "2026-03-31T09:56:38.106Z",
        totalEvents: 1,
        turnCount: 0,
        messages: [
          { role: "assistant", content: "historic 100", timestamp: "2026-03-31T09:56:38.106Z" },
        ],
        metadata: {
          workspaceId: "ws-main",
        },
      },
    }, { ledgerPath });
    expect(
      getSessionActivityFromStateLedger("hist-live-100", {
        ledgerPath,
      }),
    ).toEqual(expect.objectContaining({
      sessionId: "hist-live-100",
      workspaceId: "ws-main",
      latestTaskTitle: "Historic Session 100",
    }));

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    try {
      const listRes = await fetch(`http://127.0.0.1:${port}/api/sessions?workspace=all`);
      const listJson = await listRes.json();
      expect(listRes.status).toBe(200);
      expect(listJson.ok).toBe(true);
      expect(listJson.sessions.some((session) => session.id === "hist-live-100")).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, 15000);

  it("hides synthetic chat fixture ids from the default session list", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const mod = await import("../server/ui-server.mjs");
    const { _resetSingleton, getSessionTracker } = await import("../infra/session-tracker.mjs");
    _resetSingleton({ persistDir: null });
    let server = null;
    server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    try {
      const port = server.address().port;
      const tracker = getSessionTracker();
      tracker.createSession({
        id: "chat-idle",
        type: "primary",
        metadata: { title: "Synthetic idle chat fixture" },
      });
      tracker.createSession({
        id: "chat-replay",
        type: "primary",
        metadata: { title: "Synthetic replay chat fixture" },
      });
      tracker.createSession({
        id: "chat-1",
        type: "primary",
        metadata: { title: "Synthetic persisted chat fixture" },
      });
      tracker.createSession({
        id: "primary-real-session",
        type: "primary",
        metadata: {
          title: "Real workspace session",
          workspaceId: "ws-main",
        },
      });

      const listRes = await fetch(`http://127.0.0.1:${port}/api/sessions`);
      const listJson = await listRes.json();
      expect(listRes.status).toBe(200);
      expect(listJson.ok).toBe(true);
      expect(listJson.sessions.some((session) => session.id === "chat-idle")).toBe(false);
      expect(listJson.sessions.some((session) => session.id === "chat-replay")).toBe(false);
      expect(listJson.sessions.some((session) => session.id === "chat-1")).toBe(false);
      expect(listJson.sessions.some((session) => session.id === "primary-real-session")).toBe(true);

      const hiddenListRes = await fetch(`http://127.0.0.1:${port}/api/sessions?includeHidden=1`);
      const hiddenListJson = await hiddenListRes.json();
      expect(hiddenListRes.status).toBe(200);
      expect(hiddenListJson.ok).toBe(true);
      expect(hiddenListJson.sessions.some((session) => session.id === "chat-idle")).toBe(true);
      expect(hiddenListJson.sessions.some((session) => session.id === "chat-replay")).toBe(true);
      expect(hiddenListJson.sessions.some((session) => session.id === "chat-1")).toBe(true);
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
    }
  }, 20000);

  it("hides leaked synthetic fixture sessions from the default session list", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const mod = await import("../server/ui-server.mjs");
    const { _resetSingleton, getSessionTracker } = await import("../infra/session-tracker.mjs");
    _resetSingleton({ persistDir: null });
    let server = null;
    server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    try {
      const port = server.address().port;
      const tracker = getSessionTracker();
      tracker.createSession({
        id: "meeting-1",
        type: "primary",
        metadata: {
          source: "workflow-meeting",
          title: "Synthetic Meeting Session",
          workspaceDir: join(tmpdir(), "bosun-meeting-fixture"),
        },
      });
      tracker.createSession({
        id: "workspace-scope-test-1234",
        type: "workspace-scope-test",
        metadata: {
          title: "Workspace Scope Fixture",
          workspaceDir: join(tmpdir(), "bosun-workspace-scope-test"),
        },
      });
      tracker.createSession({
        id: "task-1774940903138-4lzrda",
        type: "task",
        status: "no_output",
        runtimeState: "no_output",
        metadata: {
          title: "Synthetic Task Fixture",
          workspaceDir: join(tmpdir(), "bosun-task-fixture"),
        },
      });
      tracker.createSession({
        id: "manual-visible-session",
        type: "primary",
        metadata: {
          title: "Visible Session",
          workspaceDir: join(process.cwd(), "fixtures", "manual-visible-session"),
        },
      });

      const listRes = await fetch(`http://127.0.0.1:${port}/api/sessions`);
      const listJson = await listRes.json();
      expect(listRes.status).toBe(200);
      expect(listJson.ok).toBe(true);
      expect(listJson.sessions.some((session) => session.id === "meeting-1")).toBe(false);
      expect(listJson.sessions.some((session) => session.id === "workspace-scope-test-1234")).toBe(false);
      expect(listJson.sessions.some((session) => session.id === "task-1774940903138-4lzrda")).toBe(false);
      expect(listJson.sessions.some((session) => session.id === "manual-visible-session")).toBe(true);

      const filteredTaskListRes = await fetch(`http://127.0.0.1:${port}/api/sessions?type=task`);
      const filteredTaskListJson = await filteredTaskListRes.json();
      expect(filteredTaskListRes.status).toBe(200);
      expect(filteredTaskListJson.ok).toBe(true);
      expect(filteredTaskListJson.sessions.some((session) => session.id === "task-1774940903138-4lzrda")).toBe(false);

      const hiddenListRes = await fetch(`http://127.0.0.1:${port}/api/sessions?includeHidden=1`);
      const hiddenListJson = await hiddenListRes.json();
      expect(hiddenListRes.status).toBe(200);
      expect(hiddenListJson.ok).toBe(true);
      expect(hiddenListJson.sessions.some((session) => session.id === "meeting-1")).toBe(true);
      expect(hiddenListJson.sessions.some((session) => session.id === "workspace-scope-test-1234")).toBe(true);
      expect(hiddenListJson.sessions.some((session) => session.id === "task-1774940903138-4lzrda")).toBe(true);
      expect(hiddenListJson.sessions.some((session) => session.id === "manual-visible-session")).toBe(true);
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
    }
  }, 20000);

  it("reaps persisted generated workflow copilot sessions that were detached from the real workspace", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const persistDir = mkdtempSync(join(tmpdir(), "bosun-session-leak-"));
    const leakedSessionId = "primary-1775248227611-umxvdy";
    const leakedSessionPath = join(persistDir, `${leakedSessionId}.json`);
    const now = Date.now();
    writeFileSync(
      leakedSessionPath,
      JSON.stringify({
        id: leakedSessionId,
        taskId: leakedSessionId,
        title: "Ask about workflow run ba5e1e85-d750-4ccf-9f18-48dab7016395",
        taskTitle: "Ask about workflow run ba5e1e85-d750-4ccf-9f18-48dab7016395",
        sessionKey: `${leakedSessionId}:${now - 600000}:abc12345`,
        type: "primary",
        status: "completed",
        createdAt: new Date(now - 600000).toISOString(),
        lastActiveAt: new Date(now - 540000).toISOString(),
        startedAt: now - 600000,
        endedAt: now - 540000,
        turnCount: 1,
        totalEvents: 1,
        messages: [
          {
            id: "msg-1",
            role: "user",
            content: "workflow analysis prompt",
            timestamp: new Date(now - 540000).toISOString(),
            turnIndex: 0,
          },
        ],
        metadata: {
          workspaceId: "virtengine-gh",
          workspaceDir: process.cwd(),
          workspaceRoot: join(process.cwd(), ".bosun", "workspaces", "virtengine-gh"),
          hidden: false,
          hiddenInLists: false,
        },
      }, null, 2),
      "utf8",
    );

    const { _resetSingleton } = await import("../infra/session-tracker.mjs");
    _resetSingleton({ persistDir });
    const mod = await import("../server/ui-server.mjs");
    let server = null;
    server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    try {
      const port = server.address().port;
      const listRes = await fetch(`http://127.0.0.1:${port}/api/sessions?workspace=all&includeHidden=1`);
      const listJson = await listRes.json();
      expect(listRes.status).toBe(200);
      expect(listJson.ok).toBe(true);
      expect(listJson.sessions.some((session) => session.id === leakedSessionId)).toBe(false);
      expect(existsSync(leakedSessionPath)).toBe(false);
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
      rmSync(persistDir, { recursive: true, force: true });
    }
  }, 20000);

  it("repairs common mojibake in session list titles", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const mod = await import("../server/ui-server.mjs");
    const { _resetSingleton, getSessionTracker } = await import("../infra/session-tracker.mjs");
    _resetSingleton({ persistDir: null });
    let server = null;
    server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    try {
      const port = server.address().port;
      const tracker = getSessionTracker();
      tracker.createSession({
        id: "mojibake-session",
        type: "primary",
        metadata: {
          title: "feat(tui): Session Detail modal ÔÇö full session drill-down",
        },
      });

      const listRes = await fetch(`http://127.0.0.1:${port}/api/sessions?includeHidden=1`);
      const listJson = await listRes.json();
      expect(listRes.status).toBe(200);
      expect(listJson.ok).toBe(true);
      const session = listJson.sessions.find((entry) => entry.id === "mojibake-session");
      expect(session).toBeTruthy();
      expect(session.title).toContain("—");
      expect(session.title).not.toContain("ÔÇö");
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
    }
  }, 20000);

  it("includes freshness metadata in session list payloads", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const mod = await import("../server/ui-server.mjs");
    const { _resetSingleton, getSessionTracker } = await import("../infra/session-tracker.mjs");
    _resetSingleton({ persistDir: null });
    let server = null;
    server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    try {
      const port = server.address().port;
      const tracker = getSessionTracker();
      tracker.createSession({
        id: "freshness-visible-session",
        type: "primary",
        metadata: { title: "Freshness Visible Session" },
      });

      const listRes = await fetch(`http://127.0.0.1:${port}/api/sessions`);
      const listJson = await listRes.json();
      expect(listRes.status).toBe(200);
      expect(listJson.ok).toBe(true);
      expect(listJson.loadMeta).toEqual(
        expect.objectContaining({
          stale: false,
          lastSuccessAt: expect.any(String),
          lastFailureAt: null,
          staleReason: null,
          staleReasonCode: null,
          staleReasonLabel: null,
          staleReasonMeta: null,
          retryAttempt: 0,
          retryDelayMs: 0,
          nextRetryAt: null,
          retriesExhausted: false,
        }),
      );
      expect(Number.isNaN(Date.parse(listJson.loadMeta.lastSuccessAt))).toBe(false);
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
    }
  }, 20000);

  it("uses the higher authenticated session rate limit for session-token requests", async () => {
    process.env.TELEGRAM_UI_ALLOW_UNSAFE = "false";
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_UI_RATE_LIMIT_PER_MIN = "2";
    process.env.BOSUN_UI_RATE_LIMIT_AUTHENTICATED_PER_MIN = "4";

    const mod = await import("../server/ui-server.mjs");
    let server = null;
    server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    try {
      const port = server.address().port;
      const token = mod.getSessionToken();
      expect(token).toBeTruthy();

      const headers = {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      };
      const makeRequest = (type) => fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
        method: "POST",
        headers,
        body: JSON.stringify({ type }),
      });

      const first = await makeRequest("authed-rate-1");
      const second = await makeRequest("authed-rate-2");
      const third = await makeRequest("authed-rate-3");
      const fourth = await makeRequest("authed-rate-4");
      const fifth = await makeRequest("authed-rate-5");

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(third.status).toBe(200);
      expect(fourth.status).toBe(200);
      expect(fifth.status).toBe(429);
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
    }
  }, 10000);

  it("scopes workflows and library data by active workspace", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-workflow-library-scope-"));
    const configPath = join(tmpDir, "bosun.config.json");
    const ws1Repo = join(tmpDir, "workspaces", "ws-alpha", "alpha");
    const ws2Repo = join(tmpDir, "workspaces", "ws-beta", "beta");
    mkdirSync(join(ws1Repo, ".git"), { recursive: true });
    mkdirSync(join(ws2Repo, ".git"), { recursive: true });
    process.env.BOSUN_CONFIG_PATH = configPath;
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          $schema: "./bosun.schema.json",
          activeWorkspace: "ws-alpha",
          workspaces: [
            {
              id: "ws-alpha",
              name: "Workspace Alpha",
              activeRepo: "alpha",
              repos: [{ name: "alpha", primary: true }],
            },
            {
              id: "ws-beta",
              name: "Workspace Beta",
              activeRepo: "beta",
              repos: [{ name: "beta", primary: true }],
            },
          ],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
    });
    const port = server.address().port;

    const wfOneId = `wf-ws-alpha-${Date.now()}`;
    const wfSaveOne = await fetch(`http://127.0.0.1:${port}/api/workflows/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: wfOneId,
        name: "Alpha Workflow",
        description: "Workspace alpha workflow",
        enabled: true,
        nodes: [],
        edges: [],
      }),
    }).then((r) => r.json());
    expect(wfSaveOne.ok).toBe(true);

    const libOne = await fetch(`http://127.0.0.1:${port}/api/library/entry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "prompt",
        name: "Alpha Prompt",
        description: "alpha only",
        content: "# alpha",
      }),
    }).then((r) => r.json());
    expect(libOne.ok).toBe(true);

    const switchResponse = await fetch(`http://127.0.0.1:${port}/api/workspaces/active`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws-beta" }),
    });
    const switchJson = await switchResponse.json();
    expect(switchResponse.status).toBe(200);
    expect(switchJson.ok).toBe(true);

    const wfBetaListBefore = await fetch(`http://127.0.0.1:${port}/api/workflows`).then((r) => r.json());
    expect(wfBetaListBefore.ok).toBe(true);
    expect(wfBetaListBefore.workflows.some((wf) => wf.id === wfOneId)).toBe(false);

    const libBetaListBefore = await fetch(`http://127.0.0.1:${port}/api/library?search=Alpha`).then((r) => r.json());
    expect(libBetaListBefore.ok).toBe(true);
    expect(libBetaListBefore.data).toHaveLength(0);

    const wfTwoId = `wf-ws-beta-${Date.now()}`;
    const wfSaveTwo = await fetch(`http://127.0.0.1:${port}/api/workflows/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: wfTwoId,
        name: "Beta Workflow",
        description: "Workspace beta workflow",
        enabled: true,
        nodes: [],
        edges: [],
      }),
    }).then((r) => r.json());
    expect(wfSaveTwo.ok).toBe(true);

    const libTwo = await fetch(`http://127.0.0.1:${port}/api/library/entry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "prompt",
        name: "Beta Prompt",
        description: "beta only",
        content: "# beta",
      }),
    }).then((r) => r.json());
    expect(libTwo.ok).toBe(true);

    const switchBackResponse = await fetch(`http://127.0.0.1:${port}/api/workspaces/active`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "ws-alpha" }),
    });
    const switchBackJson = await switchBackResponse.json();
    expect(switchBackResponse.status).toBe(200);
    expect(switchBackJson.ok).toBe(true);

    const wfAlphaList = await fetch(`http://127.0.0.1:${port}/api/workflows`).then((r) => r.json());
    expect(wfAlphaList.ok).toBe(true);
    expect(wfAlphaList.workflows.some((wf) => wf.id === wfOneId)).toBe(true);
    expect(wfAlphaList.workflows.some((wf) => wf.id === wfTwoId)).toBe(false);

    const libAlphaList = await fetch(`http://127.0.0.1:${port}/api/library?search=Prompt`).then((r) => r.json());
    expect(libAlphaList.ok).toBe(true);
    expect(libAlphaList.data.some((entry) => entry.name === "Alpha Prompt")).toBe(true);
    expect(libAlphaList.data.some((entry) => entry.name === "Beta Prompt")).toBe(false);

    rmSync(tmpDir, { recursive: true, force: true });
  }, 15000);

  it("imports exported workflow JSON through the mini app API", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const importResponse = await fetch(`http://127.0.0.1:${port}/api/workflows/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflow: {
          id: "workflow-original-id",
          name: "Imported Workflow",
          description: "Round-tripped from JSON",
          enabled: true,
          nodes: [
            { id: "trigger", type: "trigger.manual", label: "Trigger", config: {}, position: { x: 20, y: 20 } },
            { id: "finish", type: "flow.end", label: "Finish", config: { status: "completed" }, position: { x: 260, y: 20 } },
          ],
          edges: [{ id: "edge-trigger-finish", source: "trigger", target: "finish" }],
          groups: [{ id: "group-1", label: "Imported Group", color: "#60a5fa", nodeIds: ["trigger", "finish"], collapsed: false }],
          variables: { greeting: "hi" },
        },
      }),
    });
    const importJson = await importResponse.json();
    expect(importResponse.status).toBe(200);
    expect(importJson.ok).toBe(true);
    expect(importJson.workflow.id).not.toBe("workflow-original-id");
    expect(importJson.workflow.name).toBe("Imported Workflow");
    expect(importJson.workflow.groups).toEqual([
      expect.objectContaining({ id: "group-1", label: "Imported Group", nodeIds: ["trigger", "finish"] }),
    ]);

    const fetched = await fetch(`http://127.0.0.1:${port}/api/workflows/${encodeURIComponent(importJson.workflow.id)}`).then((r) => r.json());
    expect(fetched.ok).toBe(true);
    expect(fetched.workflow.variables).toEqual({ greeting: "hi" });
    expect(fetched.workflow.groups).toEqual([
      expect.objectContaining({ id: "group-1", label: "Imported Group", nodeIds: ["trigger", "finish"] }),
    ]);
  }, 15000);

  it("previews and imports custom library repositories through the API", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-library-import-api-"));
    const configPath = join(tmpDir, "bosun.config.json");
    const workspaceRoot = join(tmpDir, "workspaces", "library-ws");
    const workspaceRepo = join(workspaceRoot, "repo");
    const sourceRepo = join(tmpDir, "source-repo");

    mkdirSync(join(workspaceRepo, ".git"), { recursive: true });
    mkdirSync(join(sourceRepo, ".github", "agents"), { recursive: true });
    mkdirSync(join(sourceRepo, "skills", "triage"), { recursive: true });
    mkdirSync(join(sourceRepo, "prompts"), { recursive: true });
    mkdirSync(join(sourceRepo, ".codex"), { recursive: true });

    writeFileSync(
      join(sourceRepo, ".github", "agents", "TaskPlanner.agent.md"),
      [
        "---",
        "name: Task Planner",
        "description: 'Plans and routes engineering tasks'",
        "tools: ['search', 'edit']",
        "skills: ['triage-skill']",
        "---",
        "Use this agent to break down complex tasks.",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(sourceRepo, "skills", "triage", "SKILL.md"),
      "# Skill: Triage\n\nPrioritize incidents quickly.",
      "utf8",
    );
    writeFileSync(
      join(sourceRepo, "prompts", "chat.prompt.md"),
      "# Chat Prompt\n\nAlways ask clarifying questions when ambiguous.",
      "utf8",
    );
    writeFileSync(
      join(sourceRepo, ".codex", "config.toml"),
      [
        "[mcp_servers.github]",
        'command = "npx"',
        'args = ["-y", "@anthropic/mcp-github"]',
      ].join("\n"),
      "utf8",
    );

    process.env.BOSUN_CONFIG_PATH = configPath;
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          $schema: "./bosun.schema.json",
          activeWorkspace: "library-ws",
          workspaces: [
            {
              id: "library-ws",
              name: "Library Workspace",
              path: workspaceRoot,
              activeRepo: "repo",
              repos: [{ name: "repo", path: workspaceRepo, primary: true }],
            },
          ],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: sourceRepo, stdio: "pipe", env: sanitizedGitEnv() });
    execSync("git config user.email bosun@example.com", { cwd: sourceRepo, stdio: "pipe", env: sanitizedGitEnv() });
    execSync("git config user.name Bosun", { cwd: sourceRepo, stdio: "pipe", env: sanitizedGitEnv() });
    execSync("git add .", { cwd: sourceRepo, stdio: "pipe", env: sanitizedGitEnv() });
    execSync('git commit -m "init"', { cwd: sourceRepo, stdio: "pipe", env: sanitizedGitEnv() });
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: sourceRepo,
      stdio: "pipe",
      env: sanitizedGitEnv(),
      encoding: "utf8",
    }).trim();

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    try {
      const previewResponse = await fetch(`http://127.0.0.1:${port}/api/library/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceId: "custom",
          repoUrl: sourceRepo,
          branch,
          maxEntries: 20,
        }),
      });
      const previewJson = await previewResponse.json();
      expect(previewResponse.status).toBe(200);
      expect(previewJson.ok).toBe(true);
      expect(previewJson.data.repoUrl).toBe(sourceRepo);
      expect(previewJson.data.branch).toBe(branch);
      expect(previewJson.data.totalCandidates).toBeGreaterThanOrEqual(3);
      expect(previewJson.data.candidatesByType).toEqual(
        expect.objectContaining({
          agent: 1,
          prompt: 1,
          skill: 1,
        }),
      );

      const selectedPaths = previewJson.data.candidates
        .filter((candidate) => [
          ".github/agents/TaskPlanner.agent.md",
          "skills/triage/SKILL.md",
        ].includes(candidate.relPath))
        .map((candidate) => candidate.relPath);
      expect(selectedPaths).toEqual([
        ".github/agents/TaskPlanner.agent.md",
        "skills/triage/SKILL.md",
      ]);

      const importResponse = await fetch(`http://127.0.0.1:${port}/api/library/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceId: "custom",
          repoUrl: sourceRepo,
          branch,
          includeEntries: selectedPaths,
          importAgents: true,
          importSkills: true,
          importPrompts: true,
          importTools: false,
        }),
      });
      const importJson = await importResponse.json();
      expect(importResponse.status).toBe(200);
      expect(importJson.ok).toBe(true);
      expect(importJson.data.storageScope).toBe("repo");
      expect(importJson.data.importedCount).toBe(3);
      expect(importJson.data.imported).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "agent",
            name: "Task Planner",
            relPath: ".github/agents/TaskPlanner.agent.md",
          }),
          expect.objectContaining({
            type: "skill",
            name: "triage",
            relPath: "skills/triage/SKILL.md",
          }),
          expect.objectContaining({
            type: "prompt",
            name: "Task Planner Prompt",
            relPath: ".github/agents/TaskPlanner.agent.md",
          }),
        ]),
      );

      const libraryJson = await fetch(`http://127.0.0.1:${port}/api/library?search=Task`).then((r) => r.json());
      expect(libraryJson.ok).toBe(true);
      expect(libraryJson.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "Task Planner", type: "agent" }),
          expect.objectContaining({ name: "Task Planner Prompt", type: "prompt" }),
        ]),
      );

      const skillLibraryJson = await fetch(`http://127.0.0.1:${port}/api/library?search=Triage`).then((r) => r.json());
      expect(skillLibraryJson.ok).toBe(true);
      expect(skillLibraryJson.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "triage", type: "skill" }),
        ]),
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 20000);

  it("exposes typed workflow node ports and inline UI metadata", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const response = await fetch(`http://127.0.0.1:${port}/api/workflows/node-types`);
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(Array.isArray(payload.nodeTypes)).toBe(true);
    expect(payload.nodeTypes.length).toBeGreaterThan(10);

    const manualTrigger = payload.nodeTypes.find((nodeType) => nodeType.type === "trigger.manual");
    expect(manualTrigger).toBeTruthy();
    expect(Array.isArray(manualTrigger.ports?.outputs)).toBe(true);
    expect(manualTrigger.ports.outputs[0]).toMatchObject({
      name: "default",
      type: "TaskDef",
    });

    const runAgent = payload.nodeTypes.find((nodeType) => nodeType.type === "action.run_agent");
    expect(runAgent).toBeTruthy();
    expect(Array.isArray(runAgent.ports?.inputs)).toBe(true);
    expect(Array.isArray(runAgent.ports?.outputs)).toBe(true);
    expect(runAgent.ports.inputs[0]).toMatchObject({
      name: "default",
      type: "TaskDef",
    });
    expect(runAgent.ports.outputs[0]).toMatchObject({
      name: "default",
      type: "AgentResult",
    });
    expect(Array.isArray(runAgent.ui?.primaryFields)).toBe(true);
    expect(runAgent.ui.primaryFields).toContain("model");
  }, 20000);

  it("exposes and executes shared bosun tools via /api/agents/tool parity endpoints", async () => {
    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
    });
    const port = server.address().port;

    const createResponse = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "primary", prompt: "tool parity" }),
    });
    const createJson = await createResponse.json();
    expect(createResponse.status).toBe(200);
    expect(createJson.ok).toBe(true);
    const sessionId = createJson.session.id;

    const listResponse = await fetch(
      `http://127.0.0.1:${port}/api/agents/tools?sessionId=${encodeURIComponent(sessionId)}`,
    );
    const listJson = await listResponse.json();
    expect(listResponse.status).toBe(200);
    expect(listJson.ok).toBe(true);
    expect(Array.isArray(listJson.tools)).toBe(true);
    expect(listJson.tools.some((tool) => tool?.name === "list_sessions")).toBe(true);

    const execResponse = await fetch(`http://127.0.0.1:${port}/api/agents/tool`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        toolName: "list_sessions",
        sessionId,
        args: { limit: 5 },
      }),
    });
    const execJson = await execResponse.json();
    expect(execResponse.status).toBe(200);
    expect(execJson.ok).toBe(true);
    expect(execJson.toolName).toBe("list_sessions");
    expect(typeof execJson.result).toBe("string");
  }, 15000);

  it("applies task lifecycle start and pause actions through /api/tasks/update", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.EXECUTOR_MODE = "internal";
    process.env.TASK_TRIGGER_SYSTEM_ENABLED = "false";
    process.env.WORKFLOW_AUTOMATION_ENABLED = "false";

    const mod = await import("../server/ui-server.mjs");
    const executeTask = vi.fn(async () => {});
    const abortTask = vi.fn(() => ({ ok: true, reason: "task_lifecycle_pause" }));
    mod.injectUiDependencies({
      getInternalExecutor: () => ({
        getStatus: () => ({ maxParallel: 4, activeSlots: 0, slots: [] }),
        executeTask,
        isPaused: () => false,
        abortTask,
      }),
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Lifecycle test task",
        description: "verify lifecycle transitions",
        status: "todo",
      }),
    }).then((r) => r.json());
    expect(created.ok).toBe(true);
    const taskId = created.data.id;

    const started = await fetch(`http://127.0.0.1:${port}/api/tasks/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId,
        status: "inprogress",
        lifecycleAction: "start",
      }),
    }).then((r) => r.json());

    expect(started.ok).toBe(true);
    expect(started.lifecycle.action).toBe("start");
    expect(started.lifecycle.startDispatch.started).toBe(true);
    expect(executeTask).toHaveBeenCalled();

    const paused = await fetch(`http://127.0.0.1:${port}/api/tasks/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId,
        status: "todo",
        lifecycleAction: "pause",
        pauseExecution: true,
      }),
    }).then((r) => r.json());

    expect(paused.ok).toBe(true);
    expect(paused.lifecycle.action).toBe("pause");
    expect(abortTask).toHaveBeenCalledWith(taskId, "task_lifecycle_pause");
  }, 20000);

  it("blocks completing review-backed tasks through /api/tasks/update until approved", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;
    const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Review gate",
        description: "verify completion guard",
        status: "inreview",
        prUrl: "https://example.test/pr/123",
      }),
    }).then((r) => r.json());
    expect(created.ok).toBe(true);
    const taskId = created.data.id;

    const taskStore = await import("../task/task-store.mjs");
    taskStore.updateTask(taskId, {
      status: "inreview",
      prUrl: "https://example.test/pr/123",
    });
    await taskStore.waitForStoreWrites();

    const response = await fetch(`http://127.0.0.1:${port}/api/tasks/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId,
        status: "done",
        lifecycleAction: "complete",
      }),
    });
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("completion_guard_blocked");
    expect(payload.reason).toBe("review_not_approved");
    expect(payload.lifecycle?.action).toBe("complete");
    expect(taskStore.getTask(taskId)?.status).toBe("inreview");
  }, 20000);

  it("serves retry queue snapshots from the agent event bus when available", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const mod = await import("../server/ui-server.mjs");
    const getRetryQueue = vi.fn(() => ({
      count: 1,
      items: [
        {
          taskId: "retry-task-1",
          retryCount: 2,
          lastError: "Build failed",
          nextAttemptAt: Date.now() + 10_000,
        },
      ],
      stats: {
        totalRetriesToday: 7,
        peakRetryDepth: 3,
        exhaustedTaskIds: ["retry-task-old"],
      },
    }));
    mod.injectUiDependencies({
      getAgentEventBus: () => ({
        getRetryQueue,
      }),
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const payload = await fetch(`http://127.0.0.1:${port}/api/retry-queue`).then((r) => r.json());
    expect(payload.ok).toBe(true);
    expect(payload.count).toBe(1);
    expect(payload.items[0].taskId).toBe("retry-task-1");
    expect(payload.stats.totalRetriesToday).toBe(7);
    expect(getRetryQueue).toHaveBeenCalled();
  }, 15000);

  it("compiles and activates harness profiles from configured source files", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const mod = await import("../server/ui-server.mjs");
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-harness-"));
    const configPath = join(tmpDir, "bosun.config.json");
    const harnessSourcePath = join(tmpDir, "internal-harness.md");
    const savedConfigPath = process.env.BOSUN_CONFIG_PATH;
    process.env.BOSUN_CONFIG_PATH = configPath;
    writeFileSync(
      harnessSourcePath,
      [
        "```json",
        JSON.stringify({
          name: "Bosun API Harness",
          entryStageId: "plan",
          skills: [{ ref: "/skills/checks/SKILL.md", pinned: true }],
          stages: [
            {
              id: "plan",
              type: "prompt",
              prompt: "Plan the implementation and gather context.",
              transitions: [{ on: "success", to: "gate" }],
            },
            {
              id: "gate",
              type: "gate",
              prompt: "Run tests and wait for approval.",
              tools: ["run_tests", "approval_gate"],
              transitions: [{ on: "success", to: "done" }],
            },
            {
              id: "done",
              type: "finalize",
              prompt: "Summarize the completed work.",
            },
          ],
        }, null, 2),
        "```",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      configPath,
      JSON.stringify({
        $schema: "./bosun.schema.json",
        harness: {
          enabled: true,
          source: harnessSourcePath,
          validation: {
            mode: "report",
          },
        },
      }, null, 2) + "\n",
      "utf8",
    );

    let server = null;
    server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    try {
      const port = server.address().port;

      const compileRes = await fetch(`http://127.0.0.1:${port}/api/harness/compile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const compileJson = await compileRes.json();

      expect(compileRes.status).toBe(200);
      expect(compileJson.ok).toBe(true);
      expect(compileJson.isValid).toBe(true);
      expect(compileJson.sourceOrigin).toBe("config-file");
      expect(compileJson.sourcePath).toBe(harnessSourcePath);
      expect(compileJson.compiledProfile?.entryStageId).toBe("plan");
      expect(existsSync(compileJson.artifactPath)).toBe(true);

      const activateRes = await fetch(`http://127.0.0.1:${port}/api/harness/activate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ artifactPath: compileJson.artifactPath }),
      });
      const activateJson = await activateRes.json();

      expect(activateRes.status).toBe(200);
      expect(activateJson.ok).toBe(true);
      expect(activateJson.activeState?.artifactPath).toBe(compileJson.artifactPath);
      expect(activateJson.activeState?.compiledProfile?.entryStageId).toBe("plan");

      const activeRes = await fetch(`http://127.0.0.1:${port}/api/harness/active`);
      const activeJson = await activeRes.json();

      expect(activeRes.status).toBe(200);
      expect(activeJson.ok).toBe(true);
      expect(activeJson.activeState?.artifactPath).toBe(compileJson.artifactPath);
      expect(activeJson.artifact?.compiledProfile?.name).toBe("Bosun API Harness");
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
      await removeDirWithRetries(tmpDir);
      if (savedConfigPath === undefined) delete process.env.BOSUN_CONFIG_PATH;
      else process.env.BOSUN_CONFIG_PATH = savedConfigPath;
    }
  }, 60000);

  it.skip("runs harness profiles through the API with dry-run, persisted run records, and task-linked history", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const mod = await import("../server/ui-server.mjs");
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-harness-run-"));
    const configPath = join(tmpDir, "bosun.config.json");
    const savedConfigPath = process.env.BOSUN_CONFIG_PATH;
    process.env.BOSUN_CONFIG_PATH = configPath;
    writeFileSync(
      configPath,
      JSON.stringify({
        $schema: "./bosun.schema.json",
        harness: {
          enabled: true,
          validation: {
            mode: "report",
          },
        },
      }, null, 2) + "\n",
      "utf8",
    );

    let harnessTurnExecutorCallCount = 0;
    const harnessTurnExecutor = async ({ stage }) => {
      harnessTurnExecutorCallCount += 1;
      if (stage.id === "plan") {
        return {
          success: false,
          outcome: "needs-repair",
          status: "needs_repair",
          error: "lint failure",
        };
      }
      return {
        success: true,
        outcome: "success",
        status: "completed",
      };
    };
    let releaseSlowStage = null;
    const slowStageEntered = new Promise((resolve) => {
      releaseSlowStage = resolve;
    });
    let slowRunId = null;
    mod.injectUiDependencies({
      harnessTurnExecutor: async (context) => {
        if (context?.stage?.id === "plan" && String(context?.taskKey || "").includes("live-visibility")) {
          slowRunId = String(context?.taskKey || "").replace("live-visibility:", "").trim() || null;
          releaseSlowStage?.();
          await new Promise((resolve) => setTimeout(resolve, 1000));
          return {
            success: true,
            outcome: "success",
            status: "completed",
          };
        }
        return harnessTurnExecutor(context);
      },
    });

    let server = null;
    server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    try {
      const port = server.address().port;
      const createdTaskRes = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Harness linked task",
          description: "Verify harness runs appear in canonical task detail history.",
        }),
      });
      const createdTaskJson = await createdTaskRes.json();
      expect(createdTaskRes.status).toBe(200);
      expect(createdTaskJson.ok).toBe(true);
      const taskId = createdTaskJson.data.id;

      const source = {
        name: "Bosun API Harness Runner",
        entryStageId: "plan",
        stages: [
          {
            id: "plan",
            type: "prompt",
            prompt: "Plan the work.",
            transitions: [{ on: "needs-repair", to: "repair" }],
            repairLoop: {
              maxAttempts: 1,
              targetStageId: "repair",
              backoffMs: 1,
            },
          },
          {
            id: "repair",
            type: "repair",
            prompt: "Repair the issue.",
            transitions: [{ on: "success", to: "done" }],
          },
          {
            id: "done",
            type: "finalize",
            prompt: "Summarize the finished work.",
          },
        ],
      };

      const runRes = await fetch(`http://127.0.0.1:${port}/api/harness/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: JSON.stringify(source), taskId }),
      });
      const runJson = await runRes.json();

      expect(runRes.status).toBe(200);
      expect(runJson.ok).toBe(true);
      expect(runJson.status).toBe("completed");
      expect(runJson.taskId).toBe(taskId);
      expect(runJson.runRecord?.taskId).toBe(taskId);
      expect(runJson.result?.history?.map((entry) => entry.stageId)).toEqual(["plan", "repair", "done"]);
      expect(runJson.runRecord?.events?.some((event) => event.type === "harness:stage-transition" && event.reason === "needs-repair")).toBe(true);
      expect(existsSync(runJson.runPath)).toBe(true);
      expect(runJson.taskRun).toMatchObject({
        runId: runJson.runId,
        taskKey: taskId,
        sdk: "internal-harness",
        replayable: true,
        meta: expect.objectContaining({
          source: "harness",
          taskId,
          harnessRunId: runJson.runId,
        }),
      });
      expect(harnessTurnExecutorCallCount).toBe(3);

      const taskDetailRes = await fetch(
        `http://127.0.0.1:${port}/api/tasks/detail?taskId=${encodeURIComponent(taskId)}`,
      );
      const taskDetailJson = await taskDetailRes.json();
      expect(taskDetailRes.status).toBe(200);
      expect(taskDetailJson.ok).toBe(true);
      expect(taskDetailJson.data?.runs?.[0]).toMatchObject({
        runId: runJson.runId,
        taskKey: taskId,
        sdk: "internal-harness",
        replayable: true,
        meta: expect.objectContaining({
          source: "harness",
          taskId,
          harnessRunId: runJson.runId,
        }),
      });
      expect(taskDetailJson.data?.runs?.[0]?.steps?.[0]?.summary).toBe("Started internal-harness run.");
      expect(taskDetailJson.data?.meta?.latestRunSummary).toContain("Harness run completed at stage done");

      const liveRunPromise = fetch(`http://127.0.0.1:${port}/api/harness/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId: "live-visibility-run",
          taskKey: "live-visibility:live-visibility-run",
          source: JSON.stringify({
            name: "Bosun Live Harness",
            entryStageId: "plan",
            stages: [
              { id: "plan", type: "prompt", prompt: "Plan the work." },
            ],
          }),
        }),
      });
      await slowStageEntered;

      const activeRunsRes = await fetch(`http://127.0.0.1:${port}/api/harness/runs?limit=10`);
      const activeRunsJson = await activeRunsRes.json();
      expect(activeRunsRes.status).toBe(200);
      expect(activeRunsJson.activeRunCount).toBeGreaterThanOrEqual(1);
      expect(activeRunsJson.items[0]).toMatchObject({
        runId: "live-visibility-run",
        active: true,
        status: "running",
        health: expect.objectContaining({
          state: "working",
          waitingForOperator: false,
        }),
      });

      const activeDetailRes = await fetch(
        `http://127.0.0.1:${port}/api/harness/runs/${encodeURIComponent("live-visibility-run")}`,
      );
      const activeDetailJson = await activeDetailRes.json();
      expect(activeDetailRes.status).toBe(200);
      expect(activeDetailJson.run).toMatchObject({
        runId: "live-visibility-run",
        active: true,
        status: "running",
        health: expect.objectContaining({
          state: "working",
          waitingForOperator: false,
        }),
      });
      expect(activeDetailJson.eventSummary?.counts?.stage).toBeGreaterThanOrEqual(1);

      const activeStatusRes = await fetch(`http://127.0.0.1:${port}/api/status`);
      const activeStatusJson = await activeStatusRes.json();
      expect(activeStatusRes.status).toBe(200);
      expect(activeStatusJson.data?.harness?.activeRunCount).toBeGreaterThanOrEqual(1);
      expect(activeStatusJson.data?.harness?.totals?.active).toBeGreaterThanOrEqual(1);
      expect(activeStatusJson.data?.harness?.lastRun?.runId).toBe("live-visibility-run");
      expect(activeStatusJson.data?.harness?.lastRun?.health?.state).toBe("working");

      const activeTelemetryRes = await fetch(`http://127.0.0.1:${port}/api/telemetry/summary`);
      const activeTelemetryJson = await activeTelemetryRes.json();
      expect(activeTelemetryRes.status).toBe(200);
      expect(activeTelemetryJson.data?.harness?.activeRunCount).toBeGreaterThanOrEqual(1);
      expect(activeTelemetryJson.data?.harness?.lastRun?.runId).toBe("live-visibility-run");
      expect(activeTelemetryJson.data?.harness?.lastRun?.health?.state).toBe("working");

      const liveRunRes = await liveRunPromise;
      const liveRunJson = await liveRunRes.json();
      expect(liveRunRes.status).toBe(200);
      expect(liveRunJson.runId).toBe("live-visibility-run");

    const runsRes = await fetch(`http://127.0.0.1:${port}/api/harness/runs?limit=5`);
    const runsJson = await runsRes.json();
    expect(runsRes.status).toBe(200);
    expect(runsJson.items?.some((item) => item?.runId === runJson.runId)).toBe(true);

    const runDetailRes = await fetch(`http://127.0.0.1:${port}/api/harness/runs/${encodeURIComponent(runJson.runId)}`);
    const runDetailJson = await runDetailRes.json();
    expect(runDetailRes.status).toBe(200);
    expect(runDetailJson.run?.runId).toBe(runJson.runId);
    expect(runDetailJson.run?.result?.history?.map((entry) => entry.stageId)).toEqual(["plan", "repair", "done"]);
    expect(runDetailJson.run?.health?.state).toBe("completed");
    expect(runDetailJson.eventSummary).toMatchObject({
      counts: expect.objectContaining({
        total: expect.any(Number),
        transition: expect.any(Number),
        terminal: expect.any(Number),
      }),
      byType: expect.objectContaining({
        "harness:stage-transition": expect.any(Number),
      }),
      latestStageId: "done",
      terminalState: expect.objectContaining({
        type: "harness:completed",
        stageId: "done",
      }),
    });
    expect(runDetailJson.normalizedEvents?.some((event) => event.type === "harness:stage-transition" && event.toStageId === "repair")).toBe(true);

    const runEventsRes = await fetch(
      `http://127.0.0.1:${port}/api/harness/runs/${encodeURIComponent(runJson.runId)}/events?category=transition&direction=desc&limit=2`,
    );
    const runEventsJson = await runEventsRes.json();
    expect(runEventsRes.status).toBe(200);
    expect(runEventsJson.summary).toMatchObject({
      filteredCount: 2,
      direction: "desc",
      filters: { category: "transition" },
    });
    expect(runEventsJson.events).toHaveLength(2);
    expect(runEventsJson.events.every((event) => event.category === "transition")).toBe(true);
    expect(runEventsJson.events[0].summary).toContain("Transitioned from");

      const replayRes = await fetch(
        `http://127.0.0.1:${port}/api/harness/runs/${encodeURIComponent(runJson.runId)}/replay`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      const replayJson = await replayRes.json();
      expect(replayRes.status).toBe(200);
      expect(replayJson.ok).toBe(true);
      expect(replayJson.replayedFromRunId).toBe(runJson.runId);
      expect(replayJson.runId).not.toBe(runJson.runId);
      expect(replayJson.taskId).toBe(taskId);
      expect(replayJson.runRecord?.taskId).toBe(taskId);
      expect(replayJson.taskRun).toMatchObject({
        runId: replayJson.runId,
        taskKey: taskId,
        sdk: "internal-harness",
        meta: expect.objectContaining({
          source: "harness",
          taskId,
          harnessRunId: replayJson.runId,
        }),
      });
      expect(harnessTurnExecutorCallCount).toBe(6);

      const replayDetailRes = await fetch(
        `http://127.0.0.1:${port}/api/tasks/detail?taskId=${encodeURIComponent(taskId)}`,
      );
      const replayDetailJson = await replayDetailRes.json();
      expect(replayDetailRes.status).toBe(200);
      expect(replayDetailJson.ok).toBe(true);
      expect(replayDetailJson.data?.runs?.[0]?.runId).toBe(replayJson.runId);
      expect(replayDetailJson.data?.meta?.latestRunSummary).toContain("Harness run completed at stage done");

    const statusRes = await fetch(`http://127.0.0.1:${port}/api/status`);
    const statusJson = await statusRes.json();
    expect(statusRes.status).toBe(200);
    expect(statusJson.data?.harness?.lastRun?.runId).toBe(replayJson.runId);
    expect(statusJson.data?.harness?.totals?.successful).toBeGreaterThanOrEqual(1);

    const telemetryRes = await fetch(`http://127.0.0.1:${port}/api/telemetry/summary`);
    const telemetryJson = await telemetryRes.json();
    expect(telemetryRes.status).toBe(200);
    expect(telemetryJson.data?.harness?.lastRun?.runId).toBe(replayJson.runId);
    expect(telemetryJson.data?.harness?.recentRuns?.[0]?.runId).toBe(replayJson.runId);

    const dryRunRes = await fetch(`http://127.0.0.1:${port}/api/harness/run`, {
      method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: JSON.stringify(source), dryRun: true }),
      });
      const dryRunJson = await dryRunRes.json();

      expect(dryRunRes.status).toBe(200);
      expect(dryRunJson.ok).toBe(true);
      expect(dryRunJson.dryRun).toBe(true);
      expect(dryRunJson.result?.dryRun).toBe(true);
      expect(dryRunJson.result?.history?.every((entry) => entry.dryRun === true)).toBe(true);
      expect(existsSync(dryRunJson.runPath)).toBe(true);
      expect(harnessTurnExecutorCallCount).toBe(6);
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
      await removeDirWithRetries(tmpDir);
      if (savedConfigPath === undefined) delete process.env.BOSUN_CONFIG_PATH;
      else process.env.BOSUN_CONFIG_PATH = savedConfigPath;
    }
  }, 180000);

  it.skip("stops active harness runs through the API and persists aborted task history", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const mod = await import("../server/ui-server.mjs");
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-harness-stop-"));
    const configPath = join(tmpDir, "bosun.config.json");
    const savedConfigPath = process.env.BOSUN_CONFIG_PATH;
    process.env.BOSUN_CONFIG_PATH = configPath;
    writeFileSync(
      configPath,
      JSON.stringify({
        $schema: "./bosun.schema.json",
        harness: {
          enabled: true,
          validation: { mode: "report" },
        },
      }, null, 2) + "\n",
      "utf8",
    );

    let notifyStarted = null;
    let rejectHarnessTurn = null;
    const started = new Promise((resolve) => {
      notifyStarted = resolve;
    });
    mod.injectUiDependencies({
      harnessTurnExecutor: vi.fn(async (context) => {
        await new Promise((resolve, reject) => {
          rejectHarnessTurn = reject;
          const signal = context?.signal;
          const abort = () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          };
          if (signal?.aborted) {
            abort();
            return;
          }
          signal?.addEventListener?.("abort", abort, { once: true });
          notifyStarted?.();
        });
        return { success: true, outcome: "success", status: "completed" };
      }),
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    try {
      const port = server.address().port;
      const createdTaskRes = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Harness stop task",
          description: "Verify stop persists aborted harness runs.",
        }),
      });
      const createdTaskJson = await createdTaskRes.json();
      expect(createdTaskRes.status).toBe(200);
      expect(createdTaskJson.ok).toBe(true);
      const taskId = createdTaskJson.data.id;

      const runPromise = fetch(`http://127.0.0.1:${port}/api/harness/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId: "stop-harness-run",
          taskId,
          source: JSON.stringify({
            name: "Bosun Stop Harness",
            entryStageId: "plan",
            stages: [
              { id: "plan", type: "prompt", prompt: "Wait for stop." },
            ],
          }),
        }),
      });

      await started;

      const stopRes = await fetch(`http://127.0.0.1:${port}/api/harness/runs/stop-harness-run/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "operator_stop" }),
      });
      const stopJson = await stopRes.json();
      expect(stopRes.status).toBe(200);
      expect(stopJson).toMatchObject({
        ok: true,
        runId: "stop-harness-run",
        stopped: true,
        active: true,
        stopRequested: true,
        reason: "operator_stop",
      });

      const stopAgainRes = await fetch(`http://127.0.0.1:${port}/api/harness/runs/stop-harness-run/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "operator_stop" }),
      });
      const stopAgainJson = await stopAgainRes.json();
      expect(stopAgainRes.status).toBe(200);
      expect(stopAgainJson.ok).toBe(true);
      expect(stopAgainJson.runId).toBe("stop-harness-run");
      expect(typeof stopAgainJson.stopped).toBe("boolean");

      let runOutcome = null;
      void runPromise
        .then(async (response) => {
          runOutcome = {
            response,
            json: await response.json(),
          };
        })
        .catch((error) => {
          runOutcome = { error };
        });

      await vi.waitFor(() => {
        expect(runOutcome).not.toBeNull();
      }, { timeout: 20000, interval: 100 });

      if (runOutcome?.error) {
        throw runOutcome.error;
      }

      const runRes = runOutcome.response;
      const runJson = runOutcome.json;
      expect(runRes.status).toBe(200);
      expect(runJson.ok).toBe(false);
      expect(runJson.status).toBe("aborted");
      expect(runJson.runRecord?.events?.some((event) => event.type === "harness:aborted")).toBe(true);

      const runDetailRes = await fetch(`http://127.0.0.1:${port}/api/harness/runs/stop-harness-run`);
      const runDetailJson = await runDetailRes.json();
      expect(runDetailRes.status).toBe(200);
      expect(runDetailJson.eventSummary?.byType?.["harness:aborted"]).toBeGreaterThanOrEqual(1);

      const taskDetailRes = await fetch(`http://127.0.0.1:${port}/api/tasks/detail?taskId=${encodeURIComponent(taskId)}`);
      const taskDetailJson = await taskDetailRes.json();
      expect(taskDetailRes.status).toBe(200);
      expect(taskDetailJson.data?.runs?.[0]).toMatchObject({
        runId: "stop-harness-run",
        taskKey: taskId,
        status: "aborted",
        meta: expect.objectContaining({
          source: "harness",
          taskId,
        }),
      });
    } finally {
      if (rejectHarnessTurn) {
        const err = new Error("forced cleanup");
        err.name = "AbortError";
        rejectHarnessTurn(err);
        rejectHarnessTurn = null;
      }
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
      await removeDirWithRetries(tmpDir);
      if (savedConfigPath === undefined) delete process.env.BOSUN_CONFIG_PATH;
      else process.env.BOSUN_CONFIG_PATH = savedConfigPath;
    }
  }, 60000);

  it.skip("nudges active harness runs and resolves approval interventions through the API", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const mod = await import("../server/ui-server.mjs");
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-harness-nudge-"));
    const configPath = join(tmpDir, "bosun.config.json");
    const savedConfigPath = process.env.BOSUN_CONFIG_PATH;
    process.env.BOSUN_CONFIG_PATH = configPath;
    writeFileSync(
      configPath,
      JSON.stringify({
        $schema: "./bosun.schema.json",
        harness: {
          enabled: true,
          validation: { mode: "report" },
        },
      }, null, 2) + "\n",
      "utf8",
    );

    let sessionState = null;
    mod.injectUiDependencies({
      createCompiledInternalHarnessSession: vi.fn((compiledProfile, options = {}) => {
        sessionState = {
          events: [],
          runStarted: false,
          released: false,
          nudges: [],
          resolveRun: null,
        };
        return {
          agentId: compiledProfile.agentId || "test-harness",
          compiledProfile,
          compiledProfileJson: JSON.stringify(compiledProfile),
          validationReport: { errors: [], warnings: [], stats: compiledProfile.metadata || {} },
          isValid: true,
          canSteer: () => sessionState.runStarted && !sessionState.released,
          steer: (prompt, meta = {}) => {
            sessionState.nudges.push({ prompt, meta });
            const baseEvent = {
              runId: options.runId,
              taskKey: options.taskKey,
              stageId: "plan",
              interventionType: String(meta?.kind || meta?.type || "nudge").trim() || "nudge",
              timestamp: new Date().toISOString(),
              meta: { ...(meta && typeof meta === "object" ? meta : {}) },
            };
            options.onHarnessEvent?.({
              ...baseEvent,
              type: "harness:intervention-requested",
              prompt,
            });
            options.onHarnessEvent?.({
              ...baseEvent,
              type: "harness:intervention-delivered",
              prompt,
              reason: "steered",
            });
            return {
              ok: true,
              delivered: true,
              reason: "steered",
              interventionType: baseEvent.interventionType,
              stageId: "plan",
              targetTaskKey: options.taskKey,
            };
          },
          run: () => new Promise((resolve) => {
            sessionState.resolveRun = resolve;
            sessionState.runStarted = true;
            options.onHarnessEvent?.({
              type: "harness:session-start",
              runId: options.runId,
              taskKey: options.taskKey,
              entryStageId: "plan",
              timestamp: new Date().toISOString(),
            });
            options.onHarnessEvent?.({
              type: "harness:stage-start",
              runId: options.runId,
              taskKey: options.taskKey,
              stageId: "plan",
              stageType: "prompt",
              mode: "initial",
              step: 1,
              maxSteps: 8,
              timestamp: new Date().toISOString(),
            });
          }),
          controller: {
            canSteer: () => sessionState.runStarted && !sessionState.released,
          },
        };
      }),
    });

    let server = null;
    server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });

    try {
      const port = server.address().port;
      const runPromise = fetch(`http://127.0.0.1:${port}/api/harness/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId: "nudge-harness-run",
          source: JSON.stringify({
            name: "Bosun Nudge Harness",
            entryStageId: "plan",
            stages: [
              { id: "plan", type: "prompt", prompt: "Wait for operator intervention." },
            ],
          }),
        }),
      });

      await vi.waitFor(() => {
        expect(sessionState?.runStarted).toBe(true);
      });

      const activeDetail = await fetch(`http://127.0.0.1:${port}/api/harness/runs/nudge-harness-run`).then((r) => r.json());
      expect(activeDetail.run?.controls).toMatchObject({
        canStop: true,
        canNudge: true,
      });

      const nudgeRes = await fetch(`http://127.0.0.1:${port}/api/harness/runs/nudge-harness-run/nudge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: "Inspect the failing harness test before continuing.",
          mode: "steer",
          actor: "operator",
          reason: "new_evidence",
        }),
      });
      const nudgeJson = await nudgeRes.json();
      expect(nudgeRes.status).toBe(200);
      expect(nudgeJson).toMatchObject({
        ok: true,
        runId: "nudge-harness-run",
        delivered: true,
        mode: "steer",
        actor: "operator",
        stageId: "plan",
      });

      const approvalRequestRes = await fetch(`http://127.0.0.1:${port}/api/harness/runs/nudge-harness-run/approval`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actor: "reviewer",
          reason: "Manual approval required before continuing.",
          preview: "Wait for reviewer signoff before applying the final patch.",
        }),
      });
      const approvalRequestJson = await approvalRequestRes.json();
      expect(approvalRequestRes.status).toBe(200);
      expect(approvalRequestJson).toMatchObject({
        ok: true,
        runId: "nudge-harness-run",
        approvalPending: true,
        active: true,
        request: expect.objectContaining({
          requestId: "harness-run:nudge-harness-run",
          scopeType: "harness-run",
          scopeId: "nudge-harness-run",
          status: "pending",
          stageId: "plan",
          requestedBy: "reviewer",
        }),
      });

      const approvalStatusJson = await fetch(`http://127.0.0.1:${port}/api/harness/runs/nudge-harness-run/approval`).then((r) => r.json());
      expect(approvalStatusJson).toMatchObject({
        ok: true,
        approvalPending: true,
        request: expect.objectContaining({
          requestId: "harness-run:nudge-harness-run",
          status: "pending",
        }),
      });

      const waitingRunDetail = await fetch(`http://127.0.0.1:${port}/api/harness/runs/nudge-harness-run`).then((r) => r.json());
      expect(waitingRunDetail.run?.controls).toMatchObject({
        canApprove: true,
      });
      expect(waitingRunDetail.run?.health).toMatchObject({
        state: "waiting",
        waitingForOperator: true,
        attentionCategory: "approval",
        attentionReason: "Harness approval requested for stage plan.",
        lastEventType: "harness:approval-requested",
        lastEventSummary: "Harness approval requested for stage plan.",
      });
      expect(waitingRunDetail.run?.health?.attentionSinceAt).toEqual(expect.any(String));
      expect(waitingRunDetail.run?.health?.lastEventAt).toEqual(expect.any(String));

      const waitingRuns = await fetch(`http://127.0.0.1:${port}/api/harness/runs?state=waiting&waitingForOperator=true&limit=10`).then((r) => r.json());
      expect(waitingRuns.ok).toBe(true);
      expect(waitingRuns.items.some((item) => item?.runId === "nudge-harness-run")).toBe(true);
      expect(waitingRuns.items.find((item) => item?.runId === "nudge-harness-run")?.health).toMatchObject({
        attentionCategory: "approval",
        attentionReason: "Harness approval requested for stage plan.",
      });

      const approvalListJson = await fetch(`http://127.0.0.1:${port}/api/harness/approvals?status=pending`).then((r) => r.json());
      expect(approvalListJson.ok).toBe(true);
      expect(approvalListJson.requests).toEqual(expect.arrayContaining([
        expect.objectContaining({
          requestId: "harness-run:nudge-harness-run",
          scopeType: "harness-run",
          status: "pending",
        }),
      ]));

      const approvalRes = await fetch(`http://127.0.0.1:${port}/api/harness/approvals/${encodeURIComponent("harness-run:nudge-harness-run")}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          decision: "approved",
          actor: "reviewer",
          note: "Ship after the focused test passes.",
        }),
      });
      const approvalJson = await approvalRes.json();
      expect(approvalRes.status).toBe(200);
      expect(approvalJson).toMatchObject({
        ok: true,
        active: true,
        request: expect.objectContaining({
          requestId: "harness-run:nudge-harness-run",
          status: "approved",
          resolution: expect.objectContaining({
            actorId: "reviewer",
            note: "Ship after the focused test passes.",
          }),
        }),
        wake: expect.objectContaining({
          ok: true,
          delivered: true,
          interventionType: "approval",
          stageId: "plan",
        }),
      });

      sessionState.released = true;
      sessionState.resolveRun?.({
        success: true,
        status: "completed",
        runId: "nudge-harness-run",
        currentStageId: "plan",
        completedStageId: "plan",
        history: [],
      });

      const runRes = await runPromise;
      const runJson = await runRes.json();
      expect(runRes.status).toBe(200);
      expect(runJson.ok).toBe(true);
      expect(runJson.health?.state).toBe("completed");
      expect(runJson.runRecord?.events?.some((event) => event.type === "harness:intervention-delivered")).toBe(true);
      expect(runJson.runRecord?.events?.some((event) => event.type === "harness:approval-requested")).toBe(true);
      expect(runJson.runRecord?.events?.some((event) => event.type === "harness:approval-resolved")).toBe(true);
      expect(runJson.lastInterventionBy).toBe("reviewer");

      const eventRes = await fetch(`http://127.0.0.1:${port}/api/harness/runs/nudge-harness-run/events?category=control`).then((r) => r.json());
      expect(eventRes.ok).toBe(true);
      expect(eventRes.events.some((event) => event.type === "harness:approval-requested")).toBe(true);
      expect(eventRes.events.some((event) => event.type === "harness:approval-resolved")).toBe(true);
      expect(eventRes.events.some((event) => event.type === "harness:intervention-requested")).toBe(true);
      expect(eventRes.events.some((event) => event.type === "harness:intervention-delivered")).toBe(true);

      expect(sessionState.nudges).toHaveLength(2);
      expect(sessionState.nudges[0]).toMatchObject({
        prompt: "Inspect the failing harness test before continuing.",
        meta: expect.objectContaining({
          kind: "steer",
          actor: "operator",
          reason: "new_evidence",
        }),
      });
      expect(sessionState.nudges[1].meta).toMatchObject({
        kind: "approval",
        actor: "reviewer",
        reason: "approved",
        decision: "approved",
        note: "Ship after the focused test passes.",
      });
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
      await removeDirWithRetries(tmpDir);
      if (savedConfigPath === undefined) delete process.env.BOSUN_CONFIG_PATH;
      else process.env.BOSUN_CONFIG_PATH = savedConfigPath;
    }
  }, 90000);

  it("retries tasks immediately and clears retry queue entries via the event bus", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.EXECUTOR_MODE = "internal";

    const mod = await import("../server/ui-server.mjs");
    const executeTask = vi.fn(async () => {});
    const resetTaskThrottleState = vi.fn(() => true);
    const clearRetryQueueTask = vi.fn();
    mod.injectUiDependencies({
      getInternalExecutor: () => ({
        getStatus: () => ({ maxParallel: 4, activeSlots: 0, slots: [] }),
        executeTask,
        resetTaskThrottleState,
        isPaused: () => false,
      }),
      getAgentEventBus: () => ({
        clearRetryQueueTask,
      }),
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Retry queue manual retry test",
        description: "ensures retry now bypasses cooldown",
        status: "error",
      }),
    }).then((r) => r.json());
    expect(created.ok).toBe(true);
    const taskId = created.data.id;

    const retried = await fetch(`http://127.0.0.1:${port}/api/tasks/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId }),
    }).then((r) => r.json());

    expect(retried.ok).toBe(true);
    expect(retried.taskId).toBe(taskId);
    expect(executeTask).toHaveBeenCalledTimes(1);
    expect(executeTask.mock.calls[0][0]?.id).toBe(taskId);
    expect(resetTaskThrottleState).toHaveBeenCalledWith(taskId, {});
    expect(clearRetryQueueTask).toHaveBeenCalledWith(taskId, "manual-retry-now");
  }, 30000);

  it("clears blocked task state through /api/tasks/unblock", async () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), "bosun-ui-unblock-"));
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.EXECUTOR_MODE = "internal";
    process.env.BOSUN_HOME = isolatedDir;
    process.env.BOSUN_DIR = isolatedDir;
    process.env.CODEX_MONITOR_HOME = isolatedDir;
    process.env.CODEX_MONITOR_DIR = isolatedDir;

    const storeDir = join(isolatedDir, ".bosun", ".cache");
    mkdirSync(storeDir, { recursive: true });
    const storePath = join(storeDir, "kanban-state.json");
    const taskStore = await import("../task/task-store.mjs");
    taskStore.configureTaskStore({ storePath });
    taskStore.loadStore();

    const mod = await import("../server/ui-server.mjs");
    const resetTaskThrottleState = vi.fn(() => true);
    mod.injectUiDependencies({
      getInternalExecutor: () => ({
        getStatus: () => ({ maxParallel: 4, activeSlots: 0, slots: [] }),
        resetTaskThrottleState,
        isPaused: () => false,
      }),
    });
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Blocked UI task",
        description: "verify unblock route",
        status: "todo",
      }),
    }).then((r) => r.json());
    expect(created.ok).toBe(true);
    const taskId = created.data.id;

    taskStore.updateTask(taskId, {
      status: "blocked",
      cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
      blockedReason: "bootstrap pending",
      meta: {
        autoRecovery: {
          active: true,
          reason: "worktree_failure",
          retryAt: new Date(Date.now() + 60_000).toISOString(),
        },
        worktreeFailure: {
          failureKind: "branch_refresh_conflict",
          blockedReason: "repair pending",
        },
        note: "keep-me",
      },
    });

    const unblocked = await fetch(`http://127.0.0.1:${port}/api/tasks/unblock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId }),
    }).then((r) => r.json());

    expect(unblocked.ok).toBe(true);
    expect(unblocked.data.status).toBe("todo");

    const task = taskStore.getTask(taskId);
    expect(task.status).toBe("todo");
    expect(task.cooldownUntil).toBeNull();
    expect(task.blockedReason).toBeNull();
    expect(task.meta?.autoRecovery).toBeUndefined();
    expect(task.meta?.worktreeFailure).toBeUndefined();
    expect(task.meta?.note).toBe("keep-me");
    expect(resetTaskThrottleState).toHaveBeenCalledWith(taskId, {});
  });

  it("clears blocked task state when editing a blocked task back to todo", async () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), "bosun-ui-edit-unblock-"));
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.EXECUTOR_MODE = "internal";
    process.env.BOSUN_HOME = isolatedDir;
    process.env.BOSUN_DIR = isolatedDir;
    process.env.CODEX_MONITOR_HOME = isolatedDir;
    process.env.CODEX_MONITOR_DIR = isolatedDir;

    const storeDir = join(isolatedDir, ".bosun", ".cache");
    mkdirSync(storeDir, { recursive: true });
    const storePath = join(storeDir, "kanban-state.json");
    const taskStore = await import("../task/task-store.mjs");
    taskStore.configureTaskStore({ storePath });
    taskStore.loadStore();

    const mod = await import("../server/ui-server.mjs");
    const resetTaskThrottleState = vi.fn(() => true);
    mod.injectUiDependencies({
      getInternalExecutor: () => ({
        getStatus: () => ({ maxParallel: 4, activeSlots: 0, slots: [] }),
        resetTaskThrottleState,
        isPaused: () => false,
      }),
    });
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    taskStore.addTask({
      id: "task-edit-unblock",
      title: "Blocked via edit",
      description: "verify edit route clears block state",
      status: "blocked",
      cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
      blockedReason: "dependency not ready",
      meta: {
        autoRecovery: {
          active: true,
          reason: "worktree_failure",
          retryAt: new Date(Date.now() + 60_000).toISOString(),
        },
        worktreeFailure: {
          failureKind: "branch_refresh_conflict",
          blockedReason: "repair pending",
        },
        note: "preserve-me",
      },
    });

    const edited = await fetch(`http://127.0.0.1:${port}/api/tasks/edit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: "task-edit-unblock",
        title: "Blocked via edit",
        description: "verify edit route clears block state",
        status: "todo",
      }),
    }).then((r) => r.json());

    expect(edited.ok).toBe(true);
    expect(edited.data.status).toBe("todo");

    const task = taskStore.getTask("task-edit-unblock");
    expect(task.status).toBe("todo");
    expect(task.cooldownUntil).toBeNull();
    expect(task.blockedReason).toBeNull();
    expect(task.meta?.autoRecovery).toBeUndefined();
    expect(task.meta?.worktreeFailure).toBeUndefined();
    expect(task.meta?.note).toBe("preserve-me");
    expect(resetTaskThrottleState).toHaveBeenCalledWith("task-edit-unblock", {});
  }, 15000);

  it("queues task starts when no executor slots are free and reports truthful runtime state", async () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), "bosun-ui-queue-"));
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.EXECUTOR_MODE = "internal";
    process.env.BOSUN_HOME = isolatedDir;
    process.env.BOSUN_DIR = isolatedDir;
    process.env.CODEX_MONITOR_HOME = isolatedDir;
    process.env.CODEX_MONITOR_DIR = isolatedDir;

    const mod = await import("../server/ui-server.mjs");
    const executeTask = vi.fn(async () => {});
    mod.injectUiDependencies({
      getInternalExecutor: () => ({
        getStatus: () => ({ maxParallel: 1, activeSlots: 1, slots: [] }),
        executeTask,
        isPaused: () => false,
      }),
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Queued lifecycle test task",
        description: "verify truthful queued state",
        status: "todo",
      }),
    }).then((r) => r.json());

    expect(created.ok).toBe(true);
    const taskId = created.data.id;

    const started = await fetch(`http://127.0.0.1:${port}/api/tasks/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId }),
    }).then((r) => r.json());

    expect(started.ok).toBe(true);
    expect(started.queued).toBe(true);
    expect(started.started).toBe(false);
    expect(started.data.runtimeSnapshot.state).toBe("queued");
    expect(executeTask).not.toHaveBeenCalled();

    const tasksList = await fetch(
      `http://127.0.0.1:${port}/api/tasks?search=${encodeURIComponent(taskId)}&pageSize=50`,
    ).then((r) => r.json());

    expect(tasksList.ok).toBe(true);
    const queuedTask = Array.isArray(tasksList.data)
      ? tasksList.data.find((task) => task?.id === taskId)
      : null;
    expect(queuedTask).toBeTruthy();
    expect(queuedTask.runtimeSnapshot.state).toBe("queued");
    expect(queuedTask.runtimeSnapshot.isLive).toBe(false);
  }, 60000);

  it("enriches task detail with linked workflow runs for the same taskId", async () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), "bosun-ui-workflow-detail-"));
    const previousRepoRoot = process.env.REPO_ROOT;
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_HOME = isolatedDir;
    process.env.BOSUN_DIR = isolatedDir;
    process.env.CODEX_MONITOR_HOME = isolatedDir;
    process.env.CODEX_MONITOR_DIR = isolatedDir;
    process.env.REPO_ROOT = isolatedDir;
    mkdirSync(join(isolatedDir, ".git"), { recursive: true });

    try {
      const mod = await import("../server/ui-server.mjs");
      const mockRuns = [];
      mod._testInjectWorkflowEngine({ WorkflowEngine: class MockWorkflowEngine {} }, {
        getRunHistory: async () => mockRuns.map((run) => ({
          runId: run.runId,
          rootRunId: run.rootRunId,
          parentRunId: run.parentRunId,
          workflowId: run.workflowId,
          workflowName: run.workflowName,
          status: run.status,
          startedAt: run.startedAt,
          endedAt: run.endedAt,
          duration: run.duration,
          taskId: run.detail?.data?.taskId || "",
          taskIds: [run.detail?.data?.taskId || ""].filter(Boolean),
          primarySessionId: run.primarySessionId,
          rootTaskId: run.rootTaskId,
          parentTaskId: run.parentTaskId,
          rootSessionId: run.rootSessionId,
          parentSessionId: run.parentSessionId,
          delegationDepth: run.delegationDepth,
          delegationTopology: run.delegationTopology,
          runGraph: run.runGraph,
        })),
        getRunDetail: async (runId) => mockRuns.find((run) => run.runId === runId) || null,
        getTaskTraceEvents: async (runId) => {
          const run = mockRuns.find((entry) => entry.runId === runId);
          if (!run) return [];
          return [{
            taskId: run.detail?.data?.taskId || "",
            workflowId: run.workflowId,
            runId: run.runId,
            sessionId: run.primarySessionId,
            eventType: "run.completed",
          }];
        },
      });
      const server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });
      const port = server.address().port;

      const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Workflow linked task", description: "trace workflow runs" }),
      }).then((r) => r.json());
      expect(created.ok).toBe(true);
      const taskId = created.data.id;

      const workflowId = `wf-task-trace-${Date.now()}`;
      const linkedRunId = `run-task-trace-${Date.now()}`;
      mockRuns.push({
        runId: linkedRunId,
        workflowId,
        workflowName: "Task trace workflow",
        status: "completed",
        startedAt: "2026-03-31T05:58:00.000Z",
        endedAt: "2026-03-31T06:00:00.000Z",
        duration: 120000,
        primarySessionId: `session:${linkedRunId}`,
        rootRunId: "run-root-parent",
        parentRunId: "run-parent-operator",
        rootTaskId: taskId,
        parentTaskId: taskId,
        rootSessionId: `session:${linkedRunId}:root`,
        parentSessionId: `session:${linkedRunId}:parent`,
        delegationDepth: 2,
        delegationTopology: {
          runId: linkedRunId,
          rootRunId: "run-root-parent",
          parentRunId: "run-parent-operator",
          taskId,
          rootTaskId: taskId,
          parentTaskId: taskId,
          sessionId: `session:${linkedRunId}`,
          rootSessionId: `session:${linkedRunId}:root`,
          parentSessionId: `session:${linkedRunId}:parent`,
          delegationDepth: 2,
          childRunIds: [`${linkedRunId}:child-a`, `${linkedRunId}:child-b`],
          childSessionIds: [`session:${linkedRunId}:child-a`],
          familyRunIds: ["run-root-parent", "run-parent-operator", linkedRunId],
          familySessionIds: [`session:${linkedRunId}:root`, `session:${linkedRunId}:parent`, `session:${linkedRunId}`],
        },
        detail: {
          data: {
            taskId,
            taskTitle: "Workflow linked task",
            sessionId: `session:${linkedRunId}`,
          },
        },
        runGraph: {
          runs: [{ runId: linkedRunId }],
          executions: [{ executionId: "trigger:start" }],
          timeline: [{ eventType: "run.completed" }],
          edges: [],
        },
      });

      const detail = await fetch(
        `http://127.0.0.1:${port}/api/tasks/detail?taskId=${encodeURIComponent(taskId)}`,
      ).then((r) => r.json());

      expect(detail.ok).toBe(true);
      expect(detail.data.id).toBe(taskId);
      expect(Array.isArray(detail.data.workflowRuns)).toBe(true);
      expect(detail.data.workflowRuns.length).toBeGreaterThan(0);
      expect(detail.data.workflowRuns.some((run) => run.workflowId === workflowId)).toBe(true);
      expect(detail.data.workflowRuns).toEqual(expect.arrayContaining([
        expect.objectContaining({
          runId: linkedRunId,
          rootRunId: "run-root-parent",
          parentRunId: "run-parent-operator",
          rootTaskId: taskId,
          parentTaskId: taskId,
          rootSessionId: `session:${linkedRunId}:root`,
          parentSessionId: `session:${linkedRunId}:parent`,
          delegationDepth: 2,
          childRunIds: expect.arrayContaining([`${linkedRunId}:child-a`, `${linkedRunId}:child-b`]),
          childSessionIds: expect.arrayContaining([`session:${linkedRunId}:child-a`]),
          delegationTopology: expect.objectContaining({
            runId: linkedRunId,
            parentRunId: "run-parent-operator",
            rootSessionId: `session:${linkedRunId}:root`,
          }),
        }),
      ]));

      const stateLedger = await import("../lib/state-ledger-sqlite.mjs");
      stateLedger.writeWorkflowStateLedger({
        runDocument: {
          runId: linkedRunId,
          rootRunId: linkedRunId,
          workflowId,
          workflowName: "Task trace workflow",
          runKind: "workflow",
          status: "completed",
          startedAt: "2026-03-31T05:58:00.000Z",
          endedAt: "2026-03-31T06:00:00.000Z",
          updatedAt: "2026-03-31T06:00:00.000Z",
          taskId,
          taskTitle: "Workflow linked task",
          sessionId: `session:${linkedRunId}`,
          sessionType: "task",
          eventCount: 1,
          document: {
            runId: linkedRunId,
            workflowId,
            workflowName: "Task trace workflow",
            status: "completed",
            taskId,
            taskTitle: "Workflow linked task",
            sessionId: `session:${linkedRunId}`,
          },
        },
      }, { repoRoot: isolatedDir });
      stateLedger.appendTaskTraceEventToStateLedger({
        eventId: `${linkedRunId}:task-trace`,
        taskId,
        taskTitle: "Workflow linked task",
        workflowId,
        workflowName: "Task trace workflow",
        runId: linkedRunId,
        status: "completed",
        eventType: "run.completed",
        summary: "Workflow run completed for linked task",
        workspaceId: "default",
        sessionId: `session:${linkedRunId}`,
        timestamp: "2026-03-31T06:00:00.000Z",
      }, { repoRoot: isolatedDir });
      expect(stateLedger.listTaskTraceEventsFromStateLedger({ repoRoot: isolatedDir, taskId })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            taskId,
            workflowId,
            runId: expect.any(String),
          }),
        ]),
      );
      stateLedger.appendPromotedStrategyToStateLedger({
        strategyId: `${workflowId}:promote:${taskId}:quality`,
        workflowId,
        runId: linkedRunId,
        taskId,
        sessionId: `session:${linkedRunId}`,
        workspaceId: "default",
        scope: "workflow-reliability",
        scopeLevel: "workspace",
        category: "strategy",
        decision: "promote_strategy",
        status: "promoted",
        verificationStatus: "verified",
        confidence: 0.91,
        recommendation: "Keep the workflow pattern that completed without retries.",
        rationale: "The trace completed cleanly and the task remained linked end to end.",
        promotedAt: "2026-03-31T06:00:00.000Z",
      }, { repoRoot: isolatedDir });

      const runDetail = await fetch(
        `http://127.0.0.1:${port}/api/workflows/runs/${encodeURIComponent(linkedRunId)}`,
      ).then((r) => r.json());
      const refreshedDetail = await fetch(
        `http://127.0.0.1:${port}/api/tasks/detail?taskId=${encodeURIComponent(taskId)}`,
      ).then((r) => r.json());

      expect(runDetail.ok).toBe(true);
      expect(refreshedDetail.ok).toBe(true);
      expect(runDetail.run?.delegationTopology).toEqual(expect.objectContaining({
        runId: linkedRunId,
        rootRunId: "run-root-parent",
        parentRunId: "run-parent-operator",
        taskId,
        rootSessionId: `session:${linkedRunId}:root`,
        parentSessionId: `session:${linkedRunId}:parent`,
        delegationDepth: 2,
        childRunIds: expect.arrayContaining([`${linkedRunId}:child-a`, `${linkedRunId}:child-b`]),
      }));
      expect(runDetail.run?.auditActivity).toEqual(
        expect.objectContaining({
          summary: expect.objectContaining({
            workflowId,
          }),
          taskTraceCount: expect.any(Number),
          taskTraceEvents: expect.arrayContaining([
            expect.objectContaining({
              taskId,
              workflowId,
              runId: linkedRunId,
            }),
          ]),
          promotedStrategies: expect.arrayContaining([
            expect.objectContaining({
              strategyId: `${workflowId}:promote:${taskId}:quality`,
              runId: linkedRunId,
              recommendation: "Keep the workflow pattern that completed without retries.",
            }),
          ]),
        }),
      );
      expect(refreshedDetail.data.auditActivity).toEqual(
        expect.objectContaining({
          taskId,
          summary: expect.objectContaining({
            runCount: expect.any(Number),
            eventCount: expect.any(Number),
          }),
          promotedStrategies: expect.arrayContaining([
            expect.objectContaining({
              strategyId: `${workflowId}:promote:${taskId}:quality`,
            }),
          ]),
        }),
      );

      const auditRunResponse = await fetch(
        `http://127.0.0.1:${port}/api/audit/runs/${encodeURIComponent(linkedRunId)}`,
      ).then((r) => r.json());
      expect(auditRunResponse.ok).toBe(true);
      expect(auditRunResponse.audit).toEqual(
        expect.objectContaining({
          runId: linkedRunId,
          auditEvents: expect.arrayContaining([
            expect.objectContaining({
              auditType: "task_trace",
              runId: linkedRunId,
            }),
          ]),
        }),
      );

      const auditTaskResponse = await fetch(
        `http://127.0.0.1:${port}/api/audit/tasks/${encodeURIComponent(taskId)}`,
      ).then((r) => r.json());
      expect(auditTaskResponse.ok).toBe(true);
      expect(auditTaskResponse.audit).toEqual(
        expect.objectContaining({
          taskId,
          auditEvents: expect.arrayContaining([
            expect.objectContaining({
              taskId,
              auditType: "promoted_strategy",
            }),
          ]),
        }),
      );

      const auditEventsResponse = await fetch(
        `http://127.0.0.1:${port}/api/audit/events?taskId=${encodeURIComponent(taskId)}&limit=20`,
      ).then((r) => r.json());
      expect(auditEventsResponse.ok).toBe(true);
      expect(auditEventsResponse.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            taskId,
            auditType: "promoted_strategy",
          }),
        ]),
      );

      const auditSummaryResponse = await fetch(
        `http://127.0.0.1:${port}/api/audit/summary?limit=10&recentLimit=10`,
      ).then((r) => r.json());
      expect(auditSummaryResponse.ok).toBe(true);
      expect(auditSummaryResponse.summary).toEqual(
        expect.objectContaining({
          taskCount: expect.any(Number),
          recentEventCount: expect.any(Number),
        }),
      );
      expect(auditSummaryResponse.tasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            taskId,
          }),
        ]),
      );
    } finally {
      try {
        const mod = await import("../server/ui-server.mjs");
        mod._testInjectWorkflowEngine(null, null);
      } catch {}
      if (previousRepoRoot === undefined) delete process.env.REPO_ROOT;
      else process.env.REPO_ROOT = previousRepoRoot;
    }
  }, 20000);

  it("preserves incoming trace headers for workflow and task API actions", async () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), "bosun-ui-trace-context-"));
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.EXECUTOR_MODE = "internal";
    process.env.BOSUN_HOME = isolatedDir;
    process.env.BOSUN_DIR = isolatedDir;
    process.env.CODEX_MONITOR_HOME = isolatedDir;
    process.env.CODEX_MONITOR_DIR = isolatedDir;

    const tracing = await import("../infra/tracing.mjs");
    await tracing.setupTracing("http://collector.example/v1/traces");
    const mod = await import("../server/ui-server.mjs");
    const executeTask = vi.fn(async (task) => tracing.traceTaskExecution({ taskId: task.id }, async () => ({ ok: true })));
    mod.injectUiDependencies({
      getInternalExecutor: () => ({
        getStatus: () => ({ maxParallel: 2, activeSlots: 0, slots: [] }),
        executeTask,
        isPaused: () => false,
      }),
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const workflowId = `wf-trace-context-${Date.now()}`;
    const saveWorkflow = await fetch(`http://127.0.0.1:${port}/api/workflows/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: workflowId,
        name: "Trace context workflow",
        enabled: true,
        nodes: [
          { id: "trigger", type: "trigger.manual", label: "Start", config: {} },
        ],
        edges: [],
      }),
    }).then((r) => r.json());
    expect(saveWorkflow.ok).toBe(true);

    const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Trace task", description: "propagate trace headers" }),
    }).then((r) => r.json());
    expect(created.ok).toBe(true);
    const taskId = created.data.id;

    const traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";

    const workflowRun = await fetch(`http://127.0.0.1:${port}/api/workflows/${encodeURIComponent(workflowId)}/execute`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        traceparent,
      },
      body: JSON.stringify({ waitForCompletion: true, taskId }),
    }).then((r) => r.json());
    expect(workflowRun.ok).toBe(true);

    const taskRun = await fetch(`http://127.0.0.1:${port}/api/tasks/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        traceparent,
      },
      body: JSON.stringify({ taskId, force: true }),
    }).then((r) => r.json());
    expect(taskRun.ok).toBe(true);

    expect(executeTask).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const finishedSpans = tracing.getFinishedSpans();
    const workflowSpan = finishedSpans.find((span) => span.name === "bosun.workflow.run" && span.attributes["bosun.workflow.id"] === workflowId);
    const taskSpan = finishedSpans.find((span) => span.name === "bosun.task.execute" && span.attributes["bosun.task.id"] === taskId);

  expect(workflowSpan).toBeDefined();
  expect(taskSpan).toBeDefined();
  expect(workflowSpan.traceId).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  expect(taskSpan.traceId).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  }, 20000);

  it("uses lightweight run detail reads for workflow run diagnostics endpoints", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.EXECUTOR_MODE = "internal";

    const mod = await import("../server/ui-server.mjs");
    const workflowEngineModule = await import("../workflow/workflow-engine.mjs");
    const getRunDetail = vi.fn(async (runId, opts = {}) => ({
      runId,
      workflowId: "wf-lightweight",
      workflowName: "Lightweight Workflow",
      status: "completed",
      startedAt: Date.parse("2026-04-01T21:00:00.000Z"),
      endedAt: Date.parse("2026-04-01T21:00:01.000Z"),
      duration: 1000,
      nodeCount: 1,
      completedCount: 1,
      failedCount: 0,
      skippedCount: 0,
      activeNodeCount: 0,
      triggerSource: "manual",
      detail: {
        startedAt: Date.parse("2026-04-01T21:00:00.000Z"),
        endedAt: Date.parse("2026-04-01T21:00:01.000Z"),
        duration: 1000,
        data: {
          _workflowId: "wf-lightweight",
          _workflowName: "Lightweight Workflow",
        },
        nodeStatuses: {
          trigger: "completed",
        },
        logs: [],
        errors: [],
      },
      _requestedOpts: opts,
    }));
    const engine = {
      getRunDetail,
      getRunForensics: vi.fn(() => ({ runId: "run-lightweight-1", nodes: { trigger: { status: "completed" } } })),
      listSnapshots: vi.fn(() => [{ snapshotId: "snap-1", runId: "run-lightweight-1", workflowId: "wf-lightweight", createdAt: Date.now() }]),
    };
    mod._testInjectWorkflowEngine(workflowEngineModule, engine);

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    try {
      const [detail, evaluate, snapshots] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/api/workflows/runs/run-lightweight-1`).then((r) => r.json()),
        fetch(`http://127.0.0.1:${port}/api/workflows/runs/run-lightweight-1/evaluate`).then((r) => r.json()),
        fetch(`http://127.0.0.1:${port}/api/workflows/runs/run-lightweight-1/snapshots`).then((r) => r.json()),
      ]);

      expect(detail.ok).toBe(true);
      expect(evaluate.ok).toBe(true);
      expect(snapshots.ok).toBe(true);
      expect(getRunDetail).toHaveBeenCalledWith("run-lightweight-1", { decorate: false });
      expect(engine.listSnapshots).toHaveBeenCalledWith("wf-lightweight");
    } finally {
      mod.stopTelegramUiServer();
      mod._testInjectWorkflowEngine(workflowEngineModule, null);
    }
  }, 30000);

  it("surfaces paused-run retry guidance and safe resume through the workflow retry API", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const mod = await import("../server/ui-server.mjs");
    const workflowEngineModule = await import("../workflow/workflow-engine.mjs");
    const getRunDetail = vi.fn(async (runId, opts = {}) => ({
      runId,
      workflowId: "wf-paused-retry",
      workflowName: "Paused Retry Workflow",
      status: "paused",
      detail: {
        data: {
          _workflowId: "wf-paused-retry",
          _workflowName: "Paused Retry Workflow",
        },
      },
      _requestedOpts: opts,
    }));
    const getRetryOptions = vi.fn(() => ({
      runId: "run-paused-retry-1",
      status: "paused",
      recommendedMode: "from_failed",
      recommendedReason: "create_tasks_pending.resume_only",
      guardedState: {
        code: "create_tasks_pending",
        nextNodeId: "create-tasks",
        nextNodeLabel: "Create Tasks",
        nextNodeType: "action.materialize_planner_tasks",
        safeResume: true,
        blockers: [],
        summary: "Run is paused with Create Tasks as the next pending node.",
      },
      options: [
        {
          mode: "from_failed",
          label: "Resume from next pending step",
          description: "Resume at Create Tasks. Manual retry is blocked because task creation may already be partially applied; interrupted-run resume remains safe because existing tasks can be listed and skipped.",
          recommended: true,
          reason: "create_tasks_pending.resume_only",
          available: true,
          failedNodes: [],
        },
        {
          mode: "from_scratch",
          label: "Retry from scratch",
          description: "Blocked: Create Tasks is the next pending node and task creation may already be partially applied. Manual restart is blocked; use interrupted-run resume instead.",
          recommended: false,
          reason: null,
          available: false,
          failedNodes: [],
        },
      ],
    }));
    const retryRun = vi.fn(async (runId, opts = {}) => ({
      retryRunId: "retry-paused-run-1",
      originalRunId: runId,
      mode: opts.mode || "from_failed",
      ctx: { errors: [] },
    }));
    const engine = {
      getRunDetail,
      getRetryOptions,
      retryRun,
    };
    mod._testInjectWorkflowEngine(workflowEngineModule, engine);

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    try {
      const optionsRes = await fetch(`http://127.0.0.1:${port}/api/workflows/runs/run-paused-retry-1/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const optionsJson = await optionsRes.json();

      expect(optionsRes.status).toBe(200);
      expect(optionsJson.ok).toBe(true);
      expect(optionsJson.status).toBe("paused");
      expect(optionsJson.recommendedMode).toBe("from_failed");
      expect(optionsJson.guardedState).toMatchObject({
        code: "create_tasks_pending",
        nextNodeLabel: "Create Tasks",
        safeResume: true,
      });
      expect(optionsJson.options?.find((entry) => entry.mode === "from_failed")).toMatchObject({
        label: "Resume from next pending step",
        available: true,
      });

      const resumeRes = await fetch(`http://127.0.0.1:${port}/api/workflows/runs/run-paused-retry-1/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "from_failed" }),
      });
      const resumeJson = await resumeRes.json();

      expect(resumeRes.status).toBe(200);
      expect(resumeJson).toMatchObject({
        ok: true,
        retryRunId: "retry-paused-run-1",
        originalRunId: "run-paused-retry-1",
        mode: "from_failed",
        status: "completed",
      });
      expect(getRunDetail).toHaveBeenCalledWith("run-paused-retry-1", { decorate: false });
      expect(getRetryOptions).toHaveBeenCalledWith("run-paused-retry-1");
      expect(retryRun).toHaveBeenCalledWith("run-paused-retry-1", {
        mode: "from_failed",
        _resumeInterrupted: true,
        _decisionReason: "create_tasks_pending.resume_only",
      });
    } finally {
      mod.stopTelegramUiServer();
      mod._testInjectWorkflowEngine(workflowEngineModule, null);
    }
  }, 30000);

  it.skip("includes replayable task runs and a latest run summary on task detail", async () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), "bosun-ui-task-runs-"));
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_HOME = isolatedDir;
    process.env.BOSUN_DIR = isolatedDir;
    process.env.CODEX_MONITOR_HOME = isolatedDir;
    process.env.CODEX_MONITOR_DIR = isolatedDir;

    const mod = await import("../server/ui-server.mjs");
    let server = null;
    server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    try {
      const port = server.address().port;

      const taskStore = await import("../task/task-store.mjs");
      taskStore.addTask({ id: "task-replay-1", title: "Replay me", status: "blocked" });
      taskStore.appendTaskRun("task-replay-1", {
        runId: "run-replay-1",
        startedAt: "2026-03-22T10:00:00.000Z",
        status: "failed",
        sdk: "codex",
        threadId: "thread-replay-1",
        steps: [
          { type: "thread", payload: { sdk: "codex", resumed: false } },
          { type: "assistant", payload: { content: "Investigated the failure and need a follow-up turn." } },
        ],
      });

      const detail = await fetch(`http://127.0.0.1:${port}/api/tasks/detail?taskId=task-replay-1`).then((r) => r.json());
      expect(detail.ok).toBe(true);
      expect(Array.isArray(detail.data.runs)).toBe(true);
      expect(detail.data.runs[0]).toMatchObject({
        runId: "run-replay-1",
        sdk: "codex",
        threadId: "thread-replay-1",
        replayable: true,
        status: "failed",
      });
      expect(detail.data.runs[0].steps[0].summary).toBe("Started codex session.");
      expect(detail.data.meta.latestRunSummary).toContain("Investigated the failure");
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
      await removeDirWithRetries(isolatedDir);
    }
  }, 60000);

  it("reports server-state as disabled by default", async () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), "bosun-ui-server-state-disabled-"));
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_HOME = isolatedDir;
    process.env.BOSUN_DIR = isolatedDir;
    process.env.CODEX_MONITOR_HOME = isolatedDir;
    process.env.CODEX_MONITOR_DIR = isolatedDir;
    process.env.REPO_ROOT = isolatedDir;

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const response = await fetch(`http://127.0.0.1:${port}/api/server-state`).then((r) => r.json());
    expect(response.ok).toBe(true);
    expect(response.data).toEqual(expect.objectContaining({
      enabled: false,
      features: expect.objectContaining({
        enabled: false,
        coordination: false,
        scopeLocks: false,
        audit: false,
        executionJournal: false,
        planningAccounting: false,
        monitoring: false,
      }),
      summary: expect.objectContaining({
        enabledSectionCount: 0,
      }),
    }));
  }, 20000);

  it("exposes server-state coordination, audit, journal, planning, and monitoring summaries", async () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), "bosun-ui-server-state-"));
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_HOME = isolatedDir;
    process.env.BOSUN_DIR = isolatedDir;
    process.env.CODEX_MONITOR_HOME = isolatedDir;
    process.env.CODEX_MONITOR_DIR = isolatedDir;
    process.env.REPO_ROOT = isolatedDir;
    process.env.BOSUN_UI_COORDINATION_STATE_ENABLED = "true";
    process.env.BOSUN_UI_SCOPE_LOCK_STATE_ENABLED = "true";
    process.env.BOSUN_UI_AUDIT_SUMMARY_ENABLED = "true";
    process.env.BOSUN_UI_EXECUTION_JOURNAL_STATE_ENABLED = "true";
    process.env.BOSUN_UI_PLANNING_ACCOUNTING_ENABLED = "true";
    process.env.BOSUN_UI_MONITORING_STATE_ENABLED = "true";
    const statusCacheDir = join(isolatedDir, ".cache");
    mkdirSync(statusCacheDir, { recursive: true });
    writeFileSync(join(statusCacheDir, "orchestrator-status.json"), JSON.stringify({
      counts: {
        todo: 0,
        inprogress: 0,
        inreview: 0,
        blocked: 1,
        done: 0,
      },
      active_slots: "0/1",
      executor_mode: "internal",
      ts: "2026-03-31T10:00:05.000Z",
    }, null, 2));

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const taskStore = await import("../task/task-store.mjs");
    const sharedStateManager = await import("../workspace/shared-state-manager.mjs");
    const scopeLocks = await import("../workspace/scope-locks.mjs");

    taskStore.addTask({
      id: "task-server-state-1",
      title: "Server state task",
      status: "blocked",
    });
    taskStore.appendTaskRun("task-server-state-1", {
      runId: "run-server-state-1",
      startedAt: "2026-03-31T10:00:00.000Z",
      status: "failed",
      sdk: "codex",
      threadId: "thread-server-state-1",
      steps: [
        { type: "thread", payload: { sdk: "codex", resumed: false } },
        { type: "assistant", payload: { content: "Tracing a server-state failure path." } },
      ],
      artifacts: [
        { path: "logs/server-state.log", label: "Server State Log" },
      ],
    });

    await sharedStateManager.claimTaskInSharedState(
      "task-server-state-1",
      "workstation-1/agent-1",
      "claim-token-server-state-1",
      300,
      isolatedDir,
    );
    await scopeLocks.acquireScopeLocks({
      taskId: "task-server-state-1",
      ownerId: "workstation-1/agent-1",
      attemptToken: "claim-token-server-state-1",
      repoRoot: isolatedDir,
      ttlSeconds: 300,
      scopePaths: ["src/server-state.mjs"],
    });

    appendTaskTraceEventToStateLedger({
      taskId: "task-server-state-1",
      runId: "run-server-state-1",
      sessionId: "thread-server-state-1",
      eventType: "agent_step",
      status: "failed",
      summary: "Task trace event recorded for server-state audit coverage.",
    }, {
      repoRoot: isolatedDir,
    });
    appendOperatorActionToStateLedger({
      actionId: "operator-server-state-1",
      actionType: "server_state_probe",
      actorId: "ui",
      actorType: "operator",
      scope: "task",
      scopeId: "task-server-state-1",
      targetId: "task-server-state-1",
      taskId: "task-server-state-1",
      status: "completed",
      result: { ok: true },
      metadata: { summary: "Checked server-state summaries" },
    }, {
      repoRoot: isolatedDir,
    });

    const response = await fetch(`http://127.0.0.1:${port}/api/server-state?details=1`).then((r) => r.json());
    const status = await fetch(`http://127.0.0.1:${port}/api/status`).then((r) => r.json());
    const infra = await fetch(`http://127.0.0.1:${port}/api/infra`).then((r) => r.json());
    expect(response.ok).toBe(true);
    expect(status.ok).toBe(true);
    expect(infra.ok).toBe(true);
    expect(response.data).toEqual(expect.objectContaining({
      enabled: true,
      features: expect.objectContaining({
        enabled: true,
        coordination: true,
        scopeLocks: true,
        audit: true,
        executionJournal: true,
        planningAccounting: true,
        monitoring: true,
      }),
      repoRoot: isolatedDir,
      summary: expect.objectContaining({
        enabledSectionCount: 6,
      }),
    }));
    expect(status.data.serverState).toEqual(
      expect.objectContaining({
        enabled: true,
      }),
    );
    expect(infra.data.serverState).toEqual(
      expect.objectContaining({
        enabled: true,
      }),
    );
    expect(response.data.coordination).toEqual(expect.objectContaining({
      sharedStates: expect.objectContaining({
        claimedCount: expect.any(Number),
        total: expect.any(Number),
      }),
    }));
    expect(response.data.coordination.sharedStates.claimedCount).toBeGreaterThanOrEqual(1);
    expect(response.data.scopeLocks).toEqual(expect.objectContaining({
      totalLocks: 1,
      uniqueTaskCount: 1,
      uniqueOwnerCount: 1,
    }));
    expect(response.data.executionJournal).toEqual(expect.objectContaining({
      taskCount: 1,
      totalRuns: 1,
      journalledRuns: 1,
      totalSteps: expect.any(Number),
      totalArtifacts: expect.any(Number),
    }));
    expect(response.data.audit).toEqual(expect.objectContaining({
      taskCount: expect.any(Number),
      recentEventCount: expect.any(Number),
      taskSummaries: expect.arrayContaining([
        expect.objectContaining({
          taskId: "task-server-state-1",
        }),
      ]),
    }));
    expect(response.data.audit.recentEventCount).toBeGreaterThanOrEqual(1);
    expect(response.data.planningAccounting).toEqual(expect.objectContaining({
      tasks: expect.objectContaining({
        total: expect.any(Number),
        blocked: expect.any(Number),
      }),
      runtimeAccounting: expect.objectContaining({
        sessionCount: expect.any(Number),
      }),
    }));
    expect(response.data.planningAccounting.tasks.blocked).toBeGreaterThanOrEqual(1);
    expect(response.data.monitoring).toEqual(expect.objectContaining({
      completedSessionCount: expect.any(Number),
      retryQueueDepth: expect.any(Number),
      recentCompletedSessions: expect.any(Array),
    }));
  }, 20000);

  it.skip("backfills linked session ids and worktree paths from persistent task sessions", async () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), "bosun-ui-linked-task-session-"));
    const worktreeDir = mkdtempSync(join(tmpdir(), "bosun-ui-linked-worktree-"));
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_HOME = isolatedDir;
    process.env.BOSUN_DIR = isolatedDir;
    process.env.CODEX_MONITOR_HOME = isolatedDir;
    process.env.CODEX_MONITOR_DIR = isolatedDir;

    const mod = await import("../server/ui-server.mjs");
    const { _resetSingleton, getSessionTracker } = await import("../infra/session-tracker.mjs");
    _resetSingleton({ persistDir: null });
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Persistent linked session task",
        description: "keep session links after blocking",
        status: "todo",
      }),
    }).then((r) => r.json());
    expect(created.ok).toBe(true);
    const taskId = created.data.id;

    const taskStore = await import("../task/task-store.mjs");
    taskStore.updateTask(taskId, { status: "blocked" });

    const tracker = getSessionTracker();
    tracker.createSession({
      id: "session-linked-task-1",
      taskId,
      type: "task",
      metadata: {
        title: "Persistent linked session task",
        workspaceDir: worktreeDir,
        worktreePath: worktreeDir,
      },
    });

    const detail = await fetch(
      `http://127.0.0.1:${port}/api/tasks/detail?taskId=${encodeURIComponent(taskId)}`,
    ).then((r) => r.json());

    expect(detail.ok).toBe(true);
    expect(detail.data.status).toBe("blocked");
    expect(detail.data.sessionId).toBe("session-linked-task-1");
    expect(detail.data.primarySessionId).toBe("session-linked-task-1");
    expect(detail.data.worktreePath).toBe(worktreeDir);
    expect(detail.data.meta).toMatchObject({
      primarySessionId: "session-linked-task-1",
      worktreePath: worktreeDir,
    });
    expect(detail.data.meta.linkedSessionIds).toContain("session-linked-task-1");
  }, 45000);

  it.skip("preserves stored workflow session links while merging summary metadata without rereading run detail files", async () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), "bosun-ui-workflow-merge-"));
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_HOME = isolatedDir;
    process.env.BOSUN_DIR = isolatedDir;
    process.env.CODEX_MONITOR_HOME = isolatedDir;
    process.env.CODEX_MONITOR_DIR = isolatedDir;

    const mod = await import("../server/ui-server.mjs");
    const workflowEngineModule = await import("../workflow/workflow-engine.mjs");
    let server = null;
    const fakeEngine = {
      getRunHistory: vi.fn(() => []),
      getRunDetail: vi.fn(() => {
        throw new Error("run detail should not be loaded when summary metadata is present");
      }),
      getTaskTraceEvents: vi.fn(() => []),
      registerTaskTraceHook: vi.fn(),
      load: vi.fn(),
    };
    mod._testInjectWorkflowEngine({ WorkflowEngine: class MockWorkflowEngine {} }, fakeEngine);

    try {
      server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });
      const port = server.address().port;

      const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Workflow merge task",
          description: "preserve stored workflow session link",
          status: "todo",
        }),
      }).then((r) => r.json());
      expect(created.ok).toBe(true);
      const taskId = created.data.id;

      fakeEngine.getRunHistory.mockImplementation(() => [
        {
          runId: "run-merge-1",
          workflowId: "wf-merge-1",
          workflowName: "Merged workflow",
          status: "completed",
          startedAt: "2026-03-15T12:00:00.000Z",
          endedAt: "2026-03-15T12:02:00.000Z",
          duration: 120000,
          taskId,
          taskIds: [taskId],
          sessionId: "derived-session-1",
          primarySessionId: "derived-session-1",
          sessionIds: ["derived-session-1"],
          plannerTimeline: [
            {
              eventType: "planner.plan_completed",
              timestamp: "2026-03-15T12:01:30.000Z",
              summary: "Planner completed with ranked tasks.",
              stepLabel: "run-planner",
              status: "completed",
            },
          ],
          proofBundle: {
            summary: {
              plannerEventCount: 1,
              decisionCount: 1,
              evidenceCount: 1,
              artifactCount: 1,
            },
            plannerTimeline: [
              {
                eventType: "planner.plan_completed",
                timestamp: "2026-03-15T12:01:30.000Z",
                summary: "Planner completed with ranked tasks.",
                stepLabel: "run-planner",
                status: "completed",
              },
            ],
            decisions: [
              {
                source: "planner",
                decision: "planner.plan_completed",
                summary: "Planner completed with ranked tasks.",
              },
            ],
            evidence: [
              {
                source: "completion-evidence",
                kind: "artifact",
                summary: "Independent review proof",
              },
            ],
            artifacts: [
              {
                source: "ledger",
                kind: "planner_output",
                path: "/tmp/planner-output.json",
                summary: "Planner output captured.",
              },
            ],
          },
        },
      ]);

      const taskStore = await import("../task/task-store.mjs");
      taskStore.updateTask(taskId, {
        workflowRuns: [
          {
            runId: "run-merge-1",
            workflowId: "wf-merge-1",
            status: "linked",
            summary: "Stored workflow link",
            meta: { sessionId: "stored-session-1" },
          },
        ],
      });
      expect(taskStore.getTask(taskId)?.workflowRuns?.[0]?.meta?.sessionId).toBe("stored-session-1");

      const detail = await fetch(
        `http://127.0.0.1:${port}/api/tasks/detail?taskId=${encodeURIComponent(taskId)}`,
      ).then((r) => r.json());

      expect(detail.ok).toBe(true);
      const mergedRun = detail.data.workflowRuns.find((run) => run.runId === "run-merge-1");
      expect(mergedRun).toMatchObject({
        runId: "run-merge-1",
        workflowId: "wf-merge-1",
        sessionId: "stored-session-1",
        primarySessionId: "derived-session-1",
      });
      expect(mergedRun.meta?.sessionId).toBe("stored-session-1");
      expect(mergedRun.proofSummary).toMatchObject({
        plannerEventCount: 1,
        evidenceCount: 1,
        artifactCount: 1,
      });
      expect(mergedRun.plannerTimeline?.[0]).toMatchObject({
        eventType: "planner.plan_completed",
        summary: "Planner completed with ranked tasks.",
      });
      expect(mergedRun.proofBundle?.artifacts?.[0]).toMatchObject({
        path: "/tmp/planner-output.json",
      });
      expect(fakeEngine.getRunDetail).not.toHaveBeenCalled();
      expect(fakeEngine.getTaskTraceEvents).not.toHaveBeenCalled();
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
      await removeDirWithRetries(isolatedDir);
      mod._testInjectWorkflowEngine(workflowEngineModule, null);
    }
  }, 60000);

  it("lists and resolves pending workflow approvals through workflow approval APIs", async () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), "bosun-ui-workflow-approvals-"));
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_CONFIG_PATH = join(isolatedDir, "bosun.config.json");
    process.env.BOSUN_HOME = isolatedDir;
    process.env.BOSUN_DIR = isolatedDir;
    process.env.BOSUN_STATE_LEDGER_PATH = join(isolatedDir, ".bosun", ".cache", "state-ledger.sqlite");
    process.env.CODEX_MONITOR_HOME = isolatedDir;
    process.env.CODEX_MONITOR_DIR = isolatedDir;
    process.env.REPO_ROOT = isolatedDir;
    resetStateLedgerCache();
    const workspaceId = "approval-ws";
    writeFileSync(process.env.BOSUN_CONFIG_PATH, JSON.stringify({
      $schema: "./bosun.schema.json",
      activeWorkspace: workspaceId,
      workspaces: [
        {
          id: workspaceId,
          name: "Approval Workspace",
          path: isolatedDir,
          activeRepo: "repo",
          repos: [{ name: "repo", path: isolatedDir, primary: true }],
        },
      ],
    }, null, 2) + "\n", "utf8");

    const mod = await import("../server/ui-server.mjs");
    const workflowEngineModule = await import("../workflow/workflow-engine.mjs");
    const runId = "run-approval-1";
    const workflowId = "wf-approval-1";
    const workflowName = "Approval Workflow";
    const runsDir = join(isolatedDir, ".bosun", "workflow-runs");
    mkdirSync(runsDir, { recursive: true });

    const readRunDetail = () => JSON.parse(readFileSync(join(runsDir, `${runId}.json`), "utf8"));
    const buildRun = () => {
      const detail = readRunDetail();
      return {
        runId,
        workflowId,
        workflowName,
        status: "paused",
        startedAt: Number(detail.startedAt || Date.now()),
        endedAt: Number(detail.endedAt || Date.now()),
        executionPolicy: detail.data?._executionPolicy || detail.data?.executionPolicy || null,
        policyOutcome: detail.data?._workflowGovernance?.policyOutcome || detail.data?.policyOutcome || null,
        primaryGoalId: detail.data?._primaryGoalId || null,
        primaryGoalTitle: detail.data?._primaryGoalTitle || null,
        taskId: detail.data?.taskId || null,
        taskTitle: detail.data?.taskTitle || null,
        detail,
      };
    };

    writeFileSync(join(runsDir, `${runId}.json`), JSON.stringify({
      startedAt: Date.now() - 5000,
      endedAt: Date.now() - 1000,
      duration: 4000,
      data: {
        _workflowId: workflowId,
        _workflowName: workflowName,
        _primaryGoalId: "goal-approval",
        _primaryGoalTitle: "Protect irreversible action",
        taskId: "task-approval-1",
        taskTitle: "Approval task",
        _executionPolicy: {
          mode: "manual",
          approvalRequired: true,
          approvalState: "pending",
          blocked: true,
        },
        _workflowGovernance: {
          executionPolicy: {
            mode: "manual",
            approvalRequired: true,
            approvalState: "pending",
            blocked: true,
          },
          policyOutcome: {
            blocked: true,
            status: "blocked",
            violationCount: 1,
          },
        },
      },
      executionPolicy: {
        mode: "manual",
        approvalRequired: true,
        approvalState: "pending",
        blocked: true,
      },
      policyOutcome: {
        blocked: true,
        status: "blocked",
        violationCount: 1,
      },
      nodeStatuses: {},
      logs: [],
      errors: [],
    }, null, 2), "utf8");
    writeFileSync(join(runsDir, "index.json"), JSON.stringify({
      runs: [
        {
          runId,
          workflowId,
          workflowName,
          status: "paused",
          startedAt: Date.now() - 5000,
          endedAt: Date.now() - 1000,
          executionPolicy: {
            mode: "manual",
            approvalRequired: true,
            approvalState: "pending",
            blocked: true,
          },
          policyOutcome: {
            blocked: true,
            status: "blocked",
            violationCount: 1,
          },
          primaryGoalId: "goal-approval",
          primaryGoalTitle: "Protect irreversible action",
          taskId: "task-approval-1",
          taskTitle: "Approval task",
        },
      ],
    }, null, 2), "utf8");

    const fakeEngine = {
      getRunHistory: vi.fn(() => [buildRun()]),
      getRunDetail: vi.fn(() => buildRun()),
      getTaskTraceEvents: vi.fn(() => []),
      registerTaskTraceHook: vi.fn(),
      load: vi.fn(),
    };
    mod._testInjectWorkflowEngine({ WorkflowEngine: class MockWorkflowEngine {} }, fakeEngine);

    let server = null;
    try {
      server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });
      const port = server.address().port;

      const listed = await fetch(`http://127.0.0.1:${port}/api/workflows/approvals?status=pending&workspace=${workspaceId}`).then((r) => r.json());
      expect(listed.ok).toBe(true);
      expect(Array.isArray(listed.requests)).toBe(true);
      expect(listed.requests).toEqual(expect.arrayContaining([
        expect.objectContaining({
          scopeId: runId,
          scopeType: "workflow-run",
          status: "pending",
          primaryGoalId: "goal-approval",
        }),
      ]));

      const resolved = await fetch(`http://127.0.0.1:${port}/api/workflows/runs/${encodeURIComponent(runId)}/approval?workspace=${workspaceId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          decision: "approved",
          actorId: "test-operator",
          note: "approval granted in test",
        }),
      }).then((r) => r.json());

      expect(resolved.ok).toBe(true);
      expect(resolved.request).toMatchObject({
        requestId: `workflow-run:${runId}`,
        status: "approved",
        resolution: expect.objectContaining({
          actorId: "test-operator",
          note: "approval granted in test",
        }),
      });
      expect(resolved.run.executionPolicy).toMatchObject({
        approvalRequired: true,
        approvalState: "approved",
        blocked: false,
      });

      const persisted = readRunDetail();
      expect(persisted.data._executionPolicy).toMatchObject({
        approvalState: "approved",
        blocked: false,
        resolvedBy: "test-operator",
      });
      expect(persisted.data._workflowApproval).toMatchObject({
        requestId: `workflow-run:${runId}`,
        decision: "approved",
        actorId: "test-operator",
        note: "approval granted in test",
      });
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
      await removeDirWithRetries(isolatedDir);
      mod._testInjectWorkflowEngine(workflowEngineModule, null);
    }
  }, 20000);

  it("serves workflow approvals from the durable queue without requiring repeated run-history scans", async () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), "bosun-ui-workflow-approvals-fast-"));
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_CONFIG_PATH = join(isolatedDir, "bosun.config.json");
    process.env.BOSUN_HOME = isolatedDir;
    process.env.BOSUN_DIR = isolatedDir;
    process.env.BOSUN_STATE_LEDGER_PATH = join(isolatedDir, ".bosun", ".cache", "state-ledger.sqlite");
    process.env.CODEX_MONITOR_HOME = isolatedDir;
    process.env.CODEX_MONITOR_DIR = isolatedDir;
    process.env.REPO_ROOT = isolatedDir;
    resetStateLedgerCache();
    const workspaceId = "approval-fast-ws";
    writeFileSync(process.env.BOSUN_CONFIG_PATH, JSON.stringify({
      $schema: "./bosun.schema.json",
      activeWorkspace: workspaceId,
      workspaces: [
        {
          id: workspaceId,
          name: "Approval Fast Workspace",
          path: isolatedDir,
          activeRepo: "repo",
          repos: [{ name: "repo", path: isolatedDir, primary: true }],
        },
      ],
    }, null, 2) + "\n", "utf8");

    const mod = await import("../server/ui-server.mjs");
    const workflowEngineModule = await import("../workflow/workflow-engine.mjs");
    const approvalQueueModule = await import("../workflow/approval-queue.mjs");
    const runId = "run-approval-fast-1";
    const runRecord = {
      runId,
      workflowId: "wf-approval-fast-1",
      workflowName: "Approval Fast Workflow",
      status: "paused",
      startedAt: Date.now() - 4000,
      endedAt: Date.now() - 1000,
      executionPolicy: {
        mode: "manual",
        approvalRequired: true,
        approvalState: "pending",
        blocked: true,
      },
      policyOutcome: {
        blocked: true,
        status: "blocked",
        violationCount: 1,
      },
      primaryGoalId: "goal-fast-approval",
      primaryGoalTitle: "Avoid history rescan",
      taskId: "task-approval-fast-1",
      taskTitle: "Approval fast path task",
      detail: {
        data: {
          _workflowId: "wf-approval-fast-1",
          _workflowName: "Approval Fast Workflow",
          _executionPolicy: {
            mode: "manual",
            approvalRequired: true,
            approvalState: "pending",
            blocked: true,
          },
          _workflowGovernance: {
            executionPolicy: {
              mode: "manual",
              approvalRequired: true,
              approvalState: "pending",
              blocked: true,
            },
            policyOutcome: {
              blocked: true,
              status: "blocked",
              violationCount: 1,
            },
          },
        },
      },
    };
    approvalQueueModule.upsertWorkflowRunApprovalRequest(runRecord, { repoRoot: isolatedDir });

    const fakeEngine = {
      getRunHistoryPage: vi.fn(() => ({
        runs: [runRecord],
        total: 1,
        offset: 0,
        limit: 50,
        nextOffset: null,
        hasMore: false,
      })),
      registerTaskTraceHook: vi.fn(),
      load: vi.fn(),
      on() {},
      off() {},
    };
    mod._testInjectWorkflowEngine({ WorkflowEngine: class MockWorkflowEngine {} }, fakeEngine);

    let server = null;
    try {
      server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });
      const port = server.address().port;

      const listed = await fetch(`http://127.0.0.1:${port}/api/workflows/approvals?status=pending&workspace=${workspaceId}`).then((r) => r.json());

      expect(listed.ok).toBe(true);
      expect(listed.requests).toEqual(expect.arrayContaining([
        expect.objectContaining({
          scopeId: runId,
          scopeType: "workflow-run",
          status: "pending",
        }),
      ]));
      expect(fakeEngine.getRunHistoryPage.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
      await removeDirWithRetries(isolatedDir);
      mod._testInjectWorkflowEngine(workflowEngineModule, null);
    }
  }, 30000);

  it("hides orphaned workflow-run approvals from the pending queue and expires them durably", async () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), "bosun-ui-workflow-approvals-orphan-"));
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_CONFIG_PATH = join(isolatedDir, "bosun.config.json");
    process.env.BOSUN_HOME = isolatedDir;
    process.env.BOSUN_DIR = isolatedDir;
    process.env.BOSUN_STATE_LEDGER_PATH = join(isolatedDir, ".bosun", ".cache", "state-ledger.sqlite");
    process.env.CODEX_MONITOR_HOME = isolatedDir;
    process.env.CODEX_MONITOR_DIR = isolatedDir;
    process.env.REPO_ROOT = isolatedDir;
    resetStateLedgerCache();
    const workspaceId = "approval-orphan-ws";
    writeFileSync(process.env.BOSUN_CONFIG_PATH, JSON.stringify({
      $schema: "./bosun.schema.json",
      activeWorkspace: workspaceId,
      workspaces: [
        {
          id: workspaceId,
          name: "Approval Orphan Workspace",
          path: isolatedDir,
          activeRepo: "repo",
          repos: [{ name: "repo", path: isolatedDir, primary: true }],
        },
      ],
    }, null, 2) + "\n", "utf8");

    const mod = await import("../server/ui-server.mjs");
    const workflowEngineModule = await import("../workflow/workflow-engine.mjs");
    const approvalQueueModule = await import("../workflow/approval-queue.mjs");

    approvalQueueModule.upsertWorkflowRunApprovalRequest({
      runId: "run-approval-1",
      workflowId: "wf-approval-1",
      workflowName: "Approval Workflow",
      taskId: "task-approval-1",
      taskTitle: "Approval task",
      primaryGoalId: "goal-approval",
      primaryGoalTitle: "Protect irreversible action",
      executionPolicy: {
        mode: "manual",
        approvalRequired: true,
        approvalState: "pending",
        blocked: true,
      },
      policyOutcome: {
        blocked: true,
        status: "blocked",
        violationCount: 1,
      },
    }, { repoRoot: isolatedDir });

    const fakeEngine = {
      getRunHistoryPage: vi.fn(() => ({
        runs: [],
        total: 0,
        offset: 0,
        limit: 50,
        nextOffset: null,
        hasMore: false,
      })),
      getRunDetail: vi.fn(() => null),
      getTaskTraceEvents: vi.fn(() => []),
      registerTaskTraceHook: vi.fn(),
      load: vi.fn(),
      on() {},
      off() {},
    };
    mod._testInjectWorkflowEngine({ WorkflowEngine: class MockWorkflowEngine {} }, fakeEngine);

    let server = null;
    try {
      server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });
      const port = server.address().port;

      const listed = await fetch(`http://127.0.0.1:${port}/api/workflows/approvals?status=pending&workspace=${workspaceId}`).then((r) => r.json());
      expect(listed.ok).toBe(true);
      expect(listed.requests).toEqual([]);

      const allApprovals = await fetch(`http://127.0.0.1:${port}/api/workflows/approvals?status=all&workspace=${workspaceId}`).then((r) => r.json());
      expect(allApprovals.ok).toBe(true);
      expect(allApprovals.requests).toEqual(expect.arrayContaining([
        expect.objectContaining({
          requestId: "workflow-run:run-approval-1",
          status: "expired",
          resolution: expect.objectContaining({
            actorId: "system:reconcile",
            note: "Workflow run run-approval-1 no longer exists.",
          }),
        }),
      ]));
      expect(fakeEngine.getRunHistoryPage).toHaveBeenCalled();
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
      await removeDirWithRetries(isolatedDir);
      mod._testInjectWorkflowEngine(workflowEngineModule, null);
    }
  }, 20000);

  it("reconciles orphaned harness approvals out of the generic workflow approval queue", async () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), "bosun-ui-harness-approvals-orphan-"));
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_CONFIG_PATH = join(isolatedDir, "bosun.config.json");
    process.env.BOSUN_HOME = isolatedDir;
    process.env.BOSUN_DIR = isolatedDir;
    process.env.BOSUN_STATE_LEDGER_PATH = join(isolatedDir, ".bosun", ".cache", "state-ledger.sqlite");
    process.env.CODEX_MONITOR_HOME = isolatedDir;
    process.env.CODEX_MONITOR_DIR = isolatedDir;
    process.env.REPO_ROOT = isolatedDir;
    resetStateLedgerCache();
    const workspaceId = "approval-harness-orphan-ws";
    writeFileSync(process.env.BOSUN_CONFIG_PATH, JSON.stringify({
      $schema: "./bosun.schema.json",
      activeWorkspace: workspaceId,
      workspaces: [
        {
          id: workspaceId,
          name: "Harness Approval Orphan Workspace",
          path: isolatedDir,
          activeRepo: "repo",
          repos: [{ name: "repo", path: isolatedDir, primary: true }],
        },
      ],
    }, null, 2) + "\n", "utf8");

    const mod = await import("../server/ui-server.mjs");
    const workflowEngineModule = await import("../workflow/workflow-engine.mjs");
    const approvalQueueModule = await import("../workflow/approval-queue.mjs");

    approvalQueueModule.upsertHarnessRunApprovalRequest({
      runId: "voice-ghost-run",
      requestedBy: "voice",
      stageId: "tool:delegate_to_agent",
      stageType: "tool",
      reason: "Tool delegate_to_agent requires operator approval.",
    }, { repoRoot: isolatedDir });

    const fakeEngine = {
      getRunHistoryPage: vi.fn(() => ({
        runs: [],
        total: 0,
        offset: 0,
        limit: 50,
        nextOffset: null,
        hasMore: false,
      })),
      getRunDetail: vi.fn(() => null),
      getTaskTraceEvents: vi.fn(() => []),
      registerTaskTraceHook: vi.fn(),
      load: vi.fn(),
      on() {},
      off() {},
    };
    mod._testInjectWorkflowEngine({ WorkflowEngine: class MockWorkflowEngine {} }, fakeEngine);

    let server = null;
    try {
      server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });
      const port = server.address().port;

      const listed = await fetch(`http://127.0.0.1:${port}/api/workflows/approvals?status=pending&workspace=${workspaceId}`).then((r) => r.json());
      expect(listed.ok).toBe(true);
      expect(listed.requests).toEqual([]);

      const allApprovals = await fetch(`http://127.0.0.1:${port}/api/workflows/approvals?status=all&workspace=${workspaceId}`).then((r) => r.json());
      expect(allApprovals.ok).toBe(true);
      expect(allApprovals.requests).toEqual(expect.arrayContaining([
        expect.objectContaining({
          requestId: "harness-run:voice-ghost-run",
          status: "expired",
          resolution: expect.objectContaining({
            actorId: "system:reconcile",
            note: "Harness run voice-ghost-run no longer exists.",
          }),
        }),
      ]));
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
      await removeDirWithRetries(isolatedDir);
      mod._testInjectWorkflowEngine(workflowEngineModule, null);
    }
  }, 20000);

  it("lists and resolves workflow-gate approval requests through the generic approval queue API", async () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), "bosun-ui-gate-approvals-"));
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_CONFIG_PATH = join(isolatedDir, "bosun.config.json");
    process.env.BOSUN_HOME = isolatedDir;
    process.env.BOSUN_DIR = isolatedDir;
    process.env.BOSUN_STATE_LEDGER_PATH = join(isolatedDir, ".bosun", ".cache", "state-ledger.sqlite");
    process.env.CODEX_MONITOR_HOME = isolatedDir;
    process.env.CODEX_MONITOR_DIR = isolatedDir;
    process.env.REPO_ROOT = isolatedDir;
    resetStateLedgerCache();
    writeFileSync(process.env.BOSUN_CONFIG_PATH, JSON.stringify({
      $schema: "./bosun.schema.json",
      activeWorkspace: "gate-approval-ws",
      workspaces: [
        {
          id: "gate-approval-ws",
          name: "Gate Approval Workspace",
          path: isolatedDir,
          activeRepo: "repo",
          repos: [{ name: "repo", path: isolatedDir, primary: true }],
        },
      ],
    }, null, 2) + "\n", "utf8");

    const mod = await import("../server/ui-server.mjs");
    const workflowEngineModule = await import("../workflow/workflow-engine.mjs");
    const approvalQueueModule = await import("../workflow/approval-queue.mjs");
    const runId = "run-gate-approval-1";
    const requestId = `workflow-gate:${runId}:gate-1`;

    approvalQueueModule.upsertWorkflowGateApprovalRequest({
      runId,
      workflowId: "wf-gate-approval",
      workflowName: "Gate Approval Workflow",
      taskId: "task-gate-1",
      taskTitle: "Ship guarded change",
      nodeId: "gate-1",
      nodeLabel: "Deploy Gate",
      reason: "Push requires operator approval.",
      timeoutMs: 60000,
    }, { repoRoot: isolatedDir });

    const fakeEngine = {
      getRunHistory: vi.fn(() => []),
      getRunDetail: vi.fn((id) => ({
        runId: id,
        workflowId: "wf-gate-approval",
        workflowName: "Gate Approval Workflow",
        status: "running",
        detail: { data: {} },
      })),
      getTaskTraceEvents: vi.fn(() => []),
      registerTaskTraceHook: vi.fn(),
      load: vi.fn(),
    };
    mod._testInjectWorkflowEngine({ WorkflowEngine: class MockWorkflowEngine {} }, fakeEngine);

    let server = null;
    try {
      server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });
      const port = server.address().port;

      const listed = await fetch(`http://127.0.0.1:${port}/api/workflows/approvals?status=pending&scopeType=workflow-gate`).then((r) => r.json());
      expect(listed.ok).toBe(true);
      expect(Array.isArray(listed.requests)).toBe(true);
      expect(listed.requests).toEqual(expect.arrayContaining([
        expect.objectContaining({
          requestId,
          scopeType: "workflow-gate",
          scopeId: `${runId}:gate-1`,
          status: "pending",
          nodeId: "gate-1",
        }),
      ]));

      const resolved = await fetch(`http://127.0.0.1:${port}/api/workflows/approvals/${encodeURIComponent(requestId)}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          decision: "denied",
          actorId: "gate-operator",
          note: "blocked in test",
        }),
      }).then((r) => r.json());

      expect(resolved.ok).toBe(true);
      expect(resolved.request).toMatchObject({
        requestId,
        status: "denied",
        resolution: expect.objectContaining({
          actorId: "gate-operator",
          note: "blocked in test",
        }),
      });
      expect(resolved.run).toMatchObject({
        runId,
        workflowId: "wf-gate-approval",
      });
      const persisted = approvalQueueModule.getApprovalRequest("workflow-gate", `${runId}:gate-1`, { repoRoot: isolatedDir });
      expect(persisted).toMatchObject({
        requestId,
        status: "denied",
        resolution: expect.objectContaining({
          actorId: "gate-operator",
        }),
      });
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
      await removeDirWithRetries(isolatedDir);
      mod._testInjectWorkflowEngine(workflowEngineModule, null);
    }
  }, 20000);

  it("lists workflow template updates through a worker-style async engine proxy", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const mod = await import("../server/ui-server.mjs");
    const workflowEngineModule = await import("../workflow/workflow-engine.mjs");
    const fakeEngine = {
      isWorkflowEngineProxy: true,
      list: vi.fn(async () => [
        {
          id: "wf-template-1",
          name: "Installed Template Workflow",
          metadata: {
            templateState: {
              templateId: "template-task-batch-processor",
              templateName: "Task Batch Processor",
              updateAvailable: true,
              isCustomized: false,
              templateVersion: "1.0.1",
              installedTemplateVersion: "1.0.0",
            },
          },
        },
      ]),
      getRunHistory: vi.fn(() => []),
      getRunDetail: vi.fn(() => null),
      getTaskTraceEvents: vi.fn(() => []),
      registerTaskTraceHook: vi.fn(),
      load: vi.fn(),
    };
    mod._testInjectWorkflowEngine({ WorkflowEngine: class MockWorkflowEngine {} }, fakeEngine);

    try {
      const server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });
      const port = server.address().port;

      const response = await fetch(`http://127.0.0.1:${port}/api/workflows/template-updates`).then((r) => r.json());
      expect(response.ok).toBe(true);
      expect(Array.isArray(response.updates)).toBe(true);
      expect(response.updates).toEqual(expect.arrayContaining([
        expect.objectContaining({
          workflowId: "wf-template-1",
          templateId: "template-task-batch-processor",
          updateAvailable: true,
          isCustomized: false,
        }),
      ]));
      expect(fakeEngine.list).toHaveBeenCalled();
    } finally {
      mod._testInjectWorkflowEngine(workflowEngineModule, null);
    }
  }, 20000);

  it("returns guarded retry options for paused Create Tasks runs through the workflow retry API", async () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), "bosun-ui-workflow-retry-options-"));
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_HOME = isolatedDir;
    process.env.BOSUN_DIR = isolatedDir;
    process.env.CODEX_MONITOR_HOME = isolatedDir;
    process.env.CODEX_MONITOR_DIR = isolatedDir;

    const mod = await import("../server/ui-server.mjs");
    const workflowEngineModule = await import("../workflow/workflow-engine.mjs");
    let server = null;
    const fakeEngine = {
      getRunHistory: vi.fn(() => []),
      getRunDetail: vi.fn(() => ({
        runId: "run-create-tasks-options",
        workflowId: "wf-guarded",
        workflowName: "Guarded Workflow",
        status: "paused",
        detail: { data: { _workflowId: "wf-guarded", _workflowName: "Guarded Workflow" } },
      })),
      getRetryOptions: vi.fn(() => ({
        runId: "run-create-tasks-options",
        status: "paused",
        recommendedMode: "from_failed",
        recommendedReason: "create_tasks_pending.resume_only",
        guardedState: {
          code: "create_tasks_pending",
          nextNodeLabel: "Create Tasks",
          safeResume: true,
        },
        options: [
          {
            mode: "from_failed",
            label: "Resume from next pending step",
            description: "Manual retry is blocked; use interrupted-run resume.",
            recommended: true,
            available: true,
          },
        ],
      })),
      getTaskTraceEvents: vi.fn(() => []),
      registerTaskTraceHook: vi.fn(),
      load: vi.fn(),
    };
    mod._testInjectWorkflowEngine({ WorkflowEngine: class MockWorkflowEngine {} }, fakeEngine);

    try {
      server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });
      const port = server.address().port;

      const response = await fetch(`http://127.0.0.1:${port}/api/workflows/runs/run-create-tasks-options/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({
        ok: true,
        runId: "run-create-tasks-options",
        status: "paused",
        recommendedMode: "from_failed",
        recommendedReason: "create_tasks_pending.resume_only",
        guardedState: {
          code: "create_tasks_pending",
          nextNodeLabel: "Create Tasks",
          safeResume: true,
        },
      });
      expect(payload.options).toEqual(expect.arrayContaining([
        expect.objectContaining({
          mode: "from_failed",
          label: "Resume from next pending step",
          recommended: true,
        }),
      ]));
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      mod._testInjectWorkflowEngine(workflowEngineModule, null);
      await removeDirWithRetries(isolatedDir);
    }
  }, 20000);

  it("routes paused Create Tasks retry requests through guarded operator resume metadata", async () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), "bosun-ui-workflow-retry-resume-"));
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_HOME = isolatedDir;
    process.env.BOSUN_DIR = isolatedDir;
    process.env.CODEX_MONITOR_HOME = isolatedDir;
    process.env.CODEX_MONITOR_DIR = isolatedDir;

    const mod = await import("../server/ui-server.mjs");
    const workflowEngineModule = await import("../workflow/workflow-engine.mjs");
    let server = null;
    const fakeEngine = {
      getRunHistory: vi.fn(() => []),
      getRunDetail: vi.fn(() => ({
        runId: "run-create-tasks-resume",
        workflowId: "wf-guarded",
        workflowName: "Guarded Workflow",
        status: "paused",
        detail: { data: { _workflowId: "wf-guarded", _workflowName: "Guarded Workflow" } },
      })),
      getRetryOptions: vi.fn(() => ({
        runId: "run-create-tasks-resume",
        status: "paused",
        recommendedMode: "from_failed",
        recommendedReason: "create_tasks_pending.resume_only",
        guardedState: {
          code: "create_tasks_pending",
          nextNodeLabel: "Create Tasks",
          safeResume: true,
        },
      })),
      resolveOperatorRetry: vi.fn(() => ({
        mode: "from_failed",
        operatorAction: "resume",
        decisionReason: "create_tasks_pending.resume_only",
        blocked: false,
        guardedState: {
          code: "create_tasks_pending",
          nextNodeLabel: "Create Tasks",
          safeResume: true,
        },
        retryArgs: {
          mode: "from_failed",
          _resumeInterrupted: true,
          _decisionReason: "create_tasks_pending.resume_only",
        },
      })),
      retryRun: vi.fn(async () => ({
        retryRunId: "retry-run-create-tasks",
        originalRunId: "run-create-tasks-resume",
        mode: "from_failed",
        ctx: { errors: [] },
      })),
      getTaskTraceEvents: vi.fn(() => []),
      registerTaskTraceHook: vi.fn(),
      load: vi.fn(),
    };
    mod._testInjectWorkflowEngine({ WorkflowEngine: class MockWorkflowEngine {} }, fakeEngine);

    try {
      server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });
      const port = server.address().port;

      const response = await fetch(`http://127.0.0.1:${port}/api/workflows/runs/run-create-tasks-resume/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "from_failed" }),
      });
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({
        ok: true,
        retryRunId: "retry-run-create-tasks",
        originalRunId: "run-create-tasks-resume",
        mode: "from_failed",
        status: "completed",
        operatorAction: "resume",
        decisionReason: "create_tasks_pending.resume_only",
        guardedState: {
          code: "create_tasks_pending",
          safeResume: true,
        },
      });
      expect(fakeEngine.resolveOperatorRetry).toHaveBeenCalledWith("run-create-tasks-resume", "from_failed");
      expect(fakeEngine.retryRun).toHaveBeenCalledWith("run-create-tasks-resume", {
        mode: "from_failed",
        _resumeInterrupted: true,
        _decisionReason: "create_tasks_pending.resume_only",
      });
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      mod._testInjectWorkflowEngine(workflowEngineModule, null);
      await removeDirWithRetries(isolatedDir);
    }
  }, 20000);

  it("blocks unsafe paused Create Tasks retry requests with explicit operator guidance", async () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), "bosun-ui-workflow-retry-blocked-"));
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_HOME = isolatedDir;
    process.env.BOSUN_DIR = isolatedDir;
    process.env.CODEX_MONITOR_HOME = isolatedDir;
    process.env.CODEX_MONITOR_DIR = isolatedDir;

    const mod = await import("../server/ui-server.mjs");
    const workflowEngineModule = await import("../workflow/workflow-engine.mjs");
    let server = null;
    const fakeEngine = {
      getRunHistory: vi.fn(() => []),
      getRunDetail: vi.fn(() => ({
        runId: "run-create-tasks-blocked",
        workflowId: "wf-guarded",
        workflowName: "Guarded Workflow",
        status: "paused",
        detail: { data: { _workflowId: "wf-guarded", _workflowName: "Guarded Workflow" } },
      })),
      getRetryOptions: vi.fn(() => ({
        runId: "run-create-tasks-blocked",
        status: "paused",
        recommendedMode: "from_scratch",
        guardedState: {
          code: "create_tasks_pending",
          nextNodeLabel: "Create Tasks",
          safeResume: false,
        },
      })),
      resolveOperatorRetry: vi.fn(() => ({
        mode: "from_failed",
        operatorAction: "retry",
        blocked: true,
        blockedMessage: "Run is paused with Create Tasks as the next pending node. Manual retry is blocked to avoid duplicate task creation.",
        guardedState: {
          code: "create_tasks_pending",
          nextNodeLabel: "Create Tasks",
          safeResume: false,
        },
      })),
      retryRun: vi.fn(async () => ({
        retryRunId: "retry-run-create-tasks-blocked",
        originalRunId: "run-create-tasks-blocked",
        mode: "from_failed",
        ctx: { errors: [] },
      })),
      getTaskTraceEvents: vi.fn(() => []),
      registerTaskTraceHook: vi.fn(),
      load: vi.fn(),
    };
    mod._testInjectWorkflowEngine({ WorkflowEngine: class MockWorkflowEngine {} }, fakeEngine);

    try {
      server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });
      const port = server.address().port;

      const response = await fetch(`http://127.0.0.1:${port}/api/workflows/runs/run-create-tasks-blocked/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "from_failed" }),
      });
      const payload = await response.json();

      expect(response.status).toBe(409);
      expect(payload).toMatchObject({
        ok: false,
        mode: "from_failed",
        operatorAction: "retry",
        guardedState: {
          code: "create_tasks_pending",
          safeResume: false,
        },
        retryOptions: {
          recommendedMode: "from_scratch",
        },
      });
      expect(String(payload.error || "")).toMatch(/Create Tasks.*duplicate task creation/i);
      expect(fakeEngine.retryRun).not.toHaveBeenCalled();
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      mod._testInjectWorkflowEngine(workflowEngineModule, null);
      await removeDirWithRetries(isolatedDir);
    }
  }, 20000);

  it("reports epic dependency blockers from start guards", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.EXECUTOR_MODE = "internal";

    const mod = await import("../server/ui-server.mjs");
    const executeTask = vi.fn(async () => {});
    mod.injectUiDependencies({
      taskStoreApi: {
        canStartTask: vi.fn(() => ({
          canStart: false,
          reason: "epic_dependencies_unresolved",
          blockingEpicIds: ["EPIC-B"],
          blockingTaskIds: ["dep-task-1"],
        })),
      },
      getInternalExecutor: () => ({
        getStatus: () => ({ maxParallel: 2, activeSlots: 0, slots: [] }),
        executeTask,
        isPaused: () => false,
      }),
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "guarded epic start", description: "epic guard" }),
    }).then((r) => r.json());
    expect(created.ok).toBe(true);

    const blockedResp = await fetch(`http://127.0.0.1:${port}/api/tasks/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: created.data.id }),
    });
    const blockedJson = await blockedResp.json();

    expect(blockedResp.status).toBe(409);
    expect(blockedJson.ok).toBe(false);
    expect(blockedJson.canStart.reason).toBe("epic_dependencies_unresolved");
    expect(blockedJson.canStart.raw.blockingEpicIds).toEqual(["EPIC-B"]);
    expect(executeTask).not.toHaveBeenCalled();
  });

  it("shares a single workflow engine cold start across concurrent workflow requests", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const mod = await import("../server/ui-server.mjs");
    const workflowEngineModule = await import("../workflow/workflow-engine.mjs");

    let engineConstructCount = 0;
    let engineLoadCount = 0;
    let releaseLoad = null;
    const loadGate = new Promise((resolve) => {
      releaseLoad = resolve;
    });
    let loadEnteredResolve = null;
    const loadEntered = new Promise((resolve) => {
      loadEnteredResolve = resolve;
    });

    class MockWorkflowEngine {
      constructor() {
        engineConstructCount += 1;
      }

      async load() {
        engineLoadCount += 1;
        loadEnteredResolve();
        await loadGate;
      }

      on() {}
      off() {}
      list() { return []; }
      registerTaskTraceHook() {}
    }

    try {
      const server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });
      const port = server.address().port;

      mod._testInjectWorkflowEngine({
        WorkflowEngine: MockWorkflowEngine,
        listNodeTypes: () => [],
      }, null);

      const requests = [
        fetch(`http://127.0.0.1:${port}/api/workflows`).then((r) => r.json()),
        fetch(`http://127.0.0.1:${port}/api/workflows/detect-project`).then((r) => r.json()),
        fetch(`http://127.0.0.1:${port}/api/workflows/node-types`).then((r) => r.json()),
      ];

      await loadEntered;
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(engineConstructCount).toBe(1);
      expect(engineLoadCount).toBe(1);

      releaseLoad();
      const [workflows, detectProject, nodeTypes] = await Promise.all(requests);

      expect(workflows.ok).toBe(true);
      expect(detectProject.ok).toBe(true);
      expect(nodeTypes.ok).toBe(true);
      expect(nodeTypes.nodeTypes).toEqual([]);
    } finally {
      releaseLoad?.();
      mod._testInjectWorkflowEngine(workflowEngineModule, null);
    }
  }, 20000);

  it("reuses cached global run-history pages for identical requests", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const mod = await import("../server/ui-server.mjs");
    const workflowEngineModule = await import("../workflow/workflow-engine.mjs");
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-ui-run-history-cache-"));
    const configPath = join(tmpDir, "bosun.config.json");
    const savedConfigPath = process.env.BOSUN_CONFIG_PATH;
    process.env.BOSUN_CONFIG_PATH = configPath;
    writeFileSync(
      configPath,
      JSON.stringify({
        $schema: "./bosun.schema.json",
        workspace: {
          repoRoot: tmpDir,
        },
      }, null, 2) + "\n",
      "utf8",
    );
    const fakeEngine = {
      getRunHistoryPage: vi.fn(async () => ({
        runs: [
          {
            runId: "run-history-1",
            workflowId: "wf-1",
            workflowName: "Workflow One",
            status: "completed",
            startedAt: new Date("2026-04-02T12:00:00.000Z").toISOString(),
            endedAt: new Date("2026-04-02T12:02:00.000Z").toISOString(),
          },
        ],
        total: 1,
        offset: 0,
        limit: 50,
        nextOffset: null,
        hasMore: false,
      })),
      registerTaskTraceHook: vi.fn(),
      load: vi.fn(),
      on() {},
      off() {},
    };
    mod._testInjectWorkflowEngine({ WorkflowEngine: class MockWorkflowEngine {} }, fakeEngine);

    let server = null;
    try {
      server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });
      const port = server.address().port;

      const [first, second] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/api/workflows/runs?limit=50&offset=0`).then((r) => r.json()),
        fetch(`http://127.0.0.1:${port}/api/workflows/runs?limit=50&offset=0`).then((r) => r.json()),
      ]);

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(fakeEngine.getRunHistoryPage).toHaveBeenCalledTimes(1);
      expect(first.runs).toEqual(second.runs);
      expect(first.runs).toEqual(expect.arrayContaining([
        expect.objectContaining({
          runId: "run-history-1",
          workflowId: "wf-1",
          status: "completed",
        }),
      ]));
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
      rmSync(tmpDir, { recursive: true, force: true });
      if (savedConfigPath === undefined) delete process.env.BOSUN_CONFIG_PATH;
      else process.env.BOSUN_CONFIG_PATH = savedConfigPath;
      mod._testInjectWorkflowEngine(workflowEngineModule, null);
    }
  }, 15000);

  it("does not query the workflow engine while building /api/executor workflow load", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-ui-executor-active-runs-"));
    const configPath = join(tmpDir, "bosun.config.json");
    const workspaceRoot = join(tmpDir, "workspace");
    const workspaceRepo = join(workspaceRoot, "repo");
    const runsDir = join(workspaceRepo, ".bosun", "workflow-runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(
      join(runsDir, "_active-runs.json"),
      JSON.stringify([
        {
          runId: "run-active-1",
          workflowId: "wf-active-1",
          workflowName: "Active Workflow",
          startedAt: new Date("2026-04-02T12:00:00.000Z").toISOString(),
          activeNodeCount: 2,
        },
      ], null, 2),
      "utf8",
    );
    process.env.BOSUN_CONFIG_PATH = configPath;
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          $schema: "./bosun.schema.json",
          activeWorkspace: "perf-alpha",
          workspaces: [
            {
              id: "perf-alpha",
              name: "Perf Alpha",
              path: workspaceRoot,
              activeRepo: "repo",
              repos: [{ name: "repo", path: workspaceRepo, primary: true }],
            },
          ],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const mod = await import("../server/ui-server.mjs");
    const workflowEngineModule = await import("../workflow/workflow-engine.mjs");
    const fakeEngine = {
      list: vi.fn(() => {
        throw new Error("workflow engine should not be queried for executor run counts");
      }),
      registerTaskTraceHook: vi.fn(),
      load: vi.fn(),
      on() {},
      off() {},
    };
    mod._testInjectWorkflowEngine({ WorkflowEngine: class MockWorkflowEngine {} }, fakeEngine);
    mod.injectUiDependencies({
      getInternalExecutor: () => ({
        getStatus: () => ({ maxParallel: 3, activeSlots: 0, slots: [] }),
        isPaused: () => false,
      }),
    });

    let server = null;
    try {
      server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });
      const port = server.address().port;

      const payload = await fetch(`http://127.0.0.1:${port}/api/executor?workspace=perf-alpha`).then((r) => r.json());

      expect(payload.ok).toBe(true);
      expect(typeof payload.data.activeWorkflowRuns).toBe("number");
      expect(Array.isArray(payload.data.workflowRunDetails)).toBe(true);
      expect(payload.data.workflowRunDetails.length).toBe(payload.data.activeWorkflowRuns);
      expect(fakeEngine.list).not.toHaveBeenCalled();
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
      await removeDirWithRetries(tmpDir);
      mod._testInjectWorkflowEngine(workflowEngineModule, null);
    }
  }, 20000);

  it("keeps task detail responses JSON-safe when can-start guards return circular raw data", async () => {
    const mod = await import("../server/ui-server.mjs");
    const rawGuard = {
      canStart: false,
      reason: "dependency_blocked",
      blockingTaskIds: ["dep-task-1"],
      attemptCount: 3n,
      debug: () => "ignored",
    };
    rawGuard.self = rawGuard;
    const normalized = mod._testNormalizeCanStartResult(rawGuard);

    expect(normalized.available).toBe(true);
    expect(normalized.canStart).toBe(false);
    expect(normalized.reason).toBe("dependency_blocked");
    expect(normalized.blockingTaskIds).toEqual(["dep-task-1"]);
    expect(normalized.raw.blockingTaskIds).toEqual(["dep-task-1"]);
    expect(normalized.raw.attemptCount).toBe("3");
    expect(normalized.raw.self).toBe("[Circular]");
    expect("debug" in normalized.raw).toBe(false);
  });

  it.skip("scopes /api/project-summary to the active workspace like /api/tasks", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-project-summary-workspace-"));
    const configPath = join(tmpDir, "bosun.config.json");
    const wsAlphaRepo = join(tmpDir, "workspaces", "alpha", "virtengine");
    const wsBetaRepo = join(tmpDir, "workspaces", "beta", "virtengine");
    mkdirSync(join(wsAlphaRepo, ".git"), { recursive: true });
    mkdirSync(join(wsBetaRepo, ".git"), { recursive: true });
    process.env.BOSUN_CONFIG_PATH = configPath;
    process.env.BOSUN_HOME = tmpDir;
    process.env.BOSUN_DIR = tmpDir;
    process.env.CODEX_MONITOR_HOME = tmpDir;
    process.env.CODEX_MONITOR_DIR = tmpDir;
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          $schema: "./bosun.schema.json",
          activeWorkspace: "alpha",
          workspaces: [
            {
              id: "alpha",
              name: "Alpha Workspace",
              path: join(tmpDir, "workspaces", "alpha"),
              activeRepo: "virtengine",
              repos: [{ name: "virtengine", path: wsAlphaRepo, primary: true }],
            },
            {
              id: "beta",
              name: "Beta Workspace",
              path: join(tmpDir, "workspaces", "beta"),
              activeRepo: "virtengine",
              repos: [{ name: "virtengine", path: wsBetaRepo, primary: true }],
            },
          ],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const mod = await import("../server/ui-server.mjs");
    mod.injectUiDependencies({
      taskStoreApi: {
        listProjects: vi.fn(async () => [{ id: "internal", name: "Internal Task Store" }]),
        listTasks: vi.fn(async () => ([
          { id: "task-alpha-done", title: "alpha done", status: "done", workspace: "alpha" },
          { id: "task-alpha-merged", title: "alpha merged", status: "merged", workspace: "alpha" },
          { id: "task-alpha-progress", title: "alpha working", status: "inprogress", workspace: "alpha" },
          { id: "task-beta-done", title: "beta done", status: "done", workspace: "beta" },
        ])),
      },
    });

    let server = null;
    try {
      server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });
      const port = server.address().port;

      const summaryResp = await fetch(`http://127.0.0.1:${port}/api/project-summary`);
      const summaryJson = await summaryResp.json();
      expect(summaryResp.status).toBe(200);
      expect(summaryJson.ok).toBe(true);
      expect(summaryJson.data.taskCount).toBe(3);
      expect(summaryJson.data.completedCount).toBe(2);
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
      await removeDirWithRetries(tmpDir);
    }

  }, 15000);

  it.skip("blocks /api/tasks/start when can-start guard fails unless force override is set", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.EXECUTOR_MODE = "internal";

    const mod = await import("../server/ui-server.mjs");
    const executeTask = vi.fn(async () => {});
    const canStartTask = vi.fn(() => ({ canStart: false, reason: "dependency_blocked", blockedBy: [{ taskId: "dep-1" }] }));
    mod.injectUiDependencies({
      taskStoreApi: {
        canStartTask,
        appendTaskTimelineEvent: vi.fn(),
        addTaskComment: vi.fn(() => ({ id: "comment-1" })),
      },
      getInternalExecutor: () => ({
        getStatus: () => ({ maxParallel: 4, activeSlots: 0, slots: [] }),
        executeTask,
        isPaused: () => false,
      }),
    });

    let server = null;
    try {
      server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });
      const port = server.address().port;

      const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "guarded start task", description: "start guard" }),
      }).then((r) => r.json());
      expect(created.ok).toBe(true);
      const taskId = created.data.id;

      const blockedResp = await fetch(`http://127.0.0.1:${port}/api/tasks/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId }),
      });
      const blockedJson = await blockedResp.json();

      expect(blockedResp.status).toBe(409);
      expect(blockedJson.ok).toBe(false);
      expect(blockedJson.canStart.canStart).toBe(false);
      expect(executeTask).not.toHaveBeenCalled();

      const forcedResp = await fetch(`http://127.0.0.1:${port}/api/tasks/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId, force: true }),
      });
      const forcedJson = await forcedResp.json();

      expect(forcedResp.status).toBe(200);
      expect(forcedJson.ok).toBe(true);
      expect(forcedJson.canStart.override).toBe(true);
      expect(executeTask).toHaveBeenCalledTimes(1);
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
    }
  }, 20000);

  it.skip("reports guarded lifecycle start without dispatching execution", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.EXECUTOR_MODE = "internal";

    const mod = await import("../server/ui-server.mjs");
    const executeTask = vi.fn(async () => {});
    mod.injectUiDependencies({
      taskStoreApi: {
        canStartTask: vi.fn(() => ({ canStart: false, reason: "dependency_blocked" })),
        appendTaskTimelineEvent: vi.fn(),
      },
      getInternalExecutor: () => ({
        getStatus: () => ({ maxParallel: 3, activeSlots: 0, slots: [] }),
        executeTask,
        isPaused: () => false,
      }),
    });

    let server = null;
    try {
      server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });
      const port = server.address().port;

      const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "guarded lifecycle", description: "lifecycle guard" }),
      }).then((r) => r.json());
      expect(created.ok).toBe(true);

      const update = await fetch(`http://127.0.0.1:${port}/api/tasks/update`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskId: created.data.id,
          status: "inprogress",
          lifecycleAction: "start",
        }),
      }).then((r) => r.json());

      expect(update.ok).toBe(true);
      expect(update.lifecycle.startDispatch.started).toBe(false);
      expect(update.lifecycle.startDispatch.reason).toBe("start_guard_blocked");
      expect(executeTask).not.toHaveBeenCalled();
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
    }
  }, 20000);

  it.skip("includes blocked diagnostics on /api/tasks/detail and counts blocked tasks on /api/tasks", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const mod = await import("../server/ui-server.mjs");
    mod._testInjectWorkflowEngine(null, null);
    let taskId = null;
    mod.injectUiDependencies({
      taskStoreApi: {
        canStartTask: vi.fn(() => ({
          canStart: false,
          reason: "dependency_blocked",
          blockedBy: [{ taskId: "dep-1", reason: "Waiting for dep-1" }],
          blockingTaskIds: ["dep-1"],
        })),
      },
      getAgentSupervisor: () => ({
        getTaskDiagnostics: () => ({
          taskId,
          interventionCount: 2,
          lastIntervention: "continue_signal",
          lastDecision: { reason: "retry same thread" },
          apiErrorRecovery: {
            signature: "upstream timeout while polling",
            continueAttempts: 2,
            cooldownUntil: Date.now() + 60_000,
          },
        }),
      }),
    });

    let server = null;
    try {
      server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });
      const port = server.address().port;

      const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "blocked detail task",
          description: "waiting on dependency",
          status: "blocked",
          blockedReason: "Dependency dep-1 is unresolved",
        }),
      }).then((r) => r.json());
      expect(created.ok).toBe(true);
      taskId = created.data.id;

      const detailResp = await fetch(
        `http://127.0.0.1:${port}/api/tasks/detail?taskId=${encodeURIComponent(taskId)}`,
      );
      const detailJson = await detailResp.json();

      expect(detailResp.status).toBe(200);
      expect(detailJson.ok).toBe(true);
      expect(detailJson.data.canStart.canStart).toBe(false);
      expect(detailJson.data.blockedContext.category).toBe("dependency_blocked");
      expect(detailJson.data.blockedContext.blockedBy).toEqual([
        { taskId: "dep-1", reason: "Waiting for dep-1" },
      ]);
      expect(detailJson.data.blockedContext.reason).toBe("dependency_blocked");
      expect(detailJson.data.blockedContext.summary).toContain("Bosun will not dispatch this task");
      expect(detailJson.data.diagnostics.stableCause.code).toBe("api_error_cooldown");
      expect(detailJson.data.diagnostics.supervisor.apiErrorRecovery.continueAttempts).toBe(2);

      const listResp = await fetch(`http://127.0.0.1:${port}/api/tasks`);
      const listJson = await listResp.json();

      expect(listResp.status).toBe(200);
      expect(listJson.ok).toBe(true);
      expect(listJson.statusCounts.blocked).toBeGreaterThanOrEqual(1);
      const listedTask = listJson.data.find((entry) => entry.id === taskId);
      expect(listedTask?.canStart?.canStart).toBe(false);
      expect(listedTask?.blockedContext?.category).toBe("dependency_blocked");
      expect(listedTask?.blockedContext?.blockedBy).toEqual([
        { taskId: "dep-1", reason: "Waiting for dep-1" },
      ]);
      expect(listedTask?.diagnostics?.stableCause?.code).toBe("api_error_cooldown");
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
    }
  }, 90000);

  it.skip("reads task log diagnostics from bounded monitor-log tails on task detail", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const mod = await import("../server/ui-server.mjs");
    mod._testInjectWorkflowEngine(null, null);

    let server = null;
    server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const logsDir = resolve(process.cwd(), ".bosun", "logs");
    mkdirSync(logsDir, { recursive: true });
    const monitorErrorPath = resolve(logsDir, "monitor-error.log");
    const previousMonitorError = existsSync(monitorErrorPath)
      ? readFileSync(monitorErrorPath, "utf8")
      : null;

    try {
      const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "blocked worktree task",
          description: "collect recent worktree failure evidence",
          status: "blocked",
          branchName: "ve/task-log-tail-12345678",
        }),
      }).then((r) => r.json());

      expect(created.ok).toBe(true);
      const taskId = created.data.id;
      const filler = Array.from({ length: 8000 }, (_, index) => `2026-03-04T04:00:${String(index % 60).padStart(2, "0")}.000Z filler line ${index}`);
      filler.push(
        `2026-03-04T04:30:00.000Z [ERROR] Worktree acquisition failed for ${taskId} branch ve/task-log-tail-12345678`,
        `2026-03-04T04:31:00.000Z [ERROR] Worktree refresh failed for existing branch ve/task-log-tail-12345678; managed worktree was removed after stale refresh state (${taskId})`,
      );
      writeFileSync(monitorErrorPath, `${filler.join("\n")}\n`, "utf8");

      const detail = await fetch(
        `http://127.0.0.1:${port}/api/tasks/detail?taskId=${encodeURIComponent(taskId)}`,
      ).then((r) => r.json());
      const list = await fetch(
        `http://127.0.0.1:${port}/api/tasks?search=${encodeURIComponent(taskId)}&pageSize=50`,
      ).then((r) => r.json());

      expect(detail.ok).toBe(true);
      expect(detail.data.blockedContext.worktreeFailureCount).toBeGreaterThan(0);
      expect(detail.data.blockedContext.logEvidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "monitor-error.log",
            message: expect.stringContaining("Worktree acquisition failed"),
          }),
          expect.objectContaining({
            source: "monitor-error.log",
            message: expect.stringContaining("Worktree refresh failed for existing branch"),
          }),
        ]),
      );
      const listedTask = list.data.find((entry) => entry.id === taskId);
      expect(listedTask?.blockedContext?.category).toBe("worktree_failure");
      expect(listedTask?.blockedContext?.worktreeFailureCount).toBeGreaterThan(0);
      expect(listedTask?.blockedContext?.logEvidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "monitor-error.log",
            message: expect.stringContaining("Worktree acquisition failed"),
          }),
          expect.objectContaining({
            source: "monitor-error.log",
            message: expect.stringContaining("Worktree refresh failed for existing branch"),
          }),
        ]),
      );
    } finally {
      if (previousMonitorError == null) {
        rmSync(monitorErrorPath, { force: true });
      } else {
        writeFileSync(monitorErrorPath, previousMonitorError, "utf8");
      }
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
    }
  }, 120000);

  it.skip("classifies blocked task rows from workflow-run worktree failure evidence when local logs are quiet", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const mod = await import("../server/ui-server.mjs");
    let taskId = "";
    const fakeEngine = {
      getRunHistory: vi.fn(() => [
        {
          runId: "run-worktree-failure-1",
          workflowId: "wf-worktree-failure-1",
          workflowName: "Task Lifecycle",
          status: "failed",
          startedAt: "2026-03-31T15:43:05.000Z",
          endedAt: "2026-03-31T15:43:23.000Z",
          duration: 18000,
          taskId,
          taskIds: [taskId],
          detail: {
            data: {
              taskId,
            },
          },
          meta: {
            failureKind: "branch_refresh_conflict",
            error: "Worktree refresh failed for existing branch task/example; managed worktree was removed after stale refresh state",
            worktreeFailure: {
              failureKind: "branch_refresh_conflict",
              blockedReason: "Managed worktree refresh conflict detected; Bosun will retry automatically after cooldown.",
              error: "Worktree refresh failed for existing branch task/example; managed worktree was removed after stale refresh state",
              retryable: false,
            },
          },
        },
      ]),
      getRunDetail: vi.fn((runId) => ({
        runId,
        workflowId: "wf-worktree-failure-1",
        workflowName: "Task Lifecycle",
        status: "failed",
        endedAt: "2026-03-31T15:43:23.000Z",
        detail: {
          data: {
            taskId,
          },
        },
        meta: {
          failureKind: "branch_refresh_conflict",
          error: "Worktree refresh failed for existing branch task/example; managed worktree was removed after stale refresh state",
          worktreeFailure: {
            failureKind: "branch_refresh_conflict",
            blockedReason: "Managed worktree refresh conflict detected; Bosun will retry automatically after cooldown.",
            error: "Worktree refresh failed for existing branch task/example; managed worktree was removed after stale refresh state",
            retryable: false,
          },
        },
      })),
      getTaskTraceEvents: vi.fn(() => []),
      registerTaskTraceHook: vi.fn(),
      load: vi.fn(),
    };
    mod._testInjectWorkflowEngine({ WorkflowEngine: class MockWorkflowEngine {} }, fakeEngine);

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "blocked workflow-run evidence task",
        description: "derive blocked context from workflow-run metadata",
        status: "blocked",
        branchName: "task/example",
      }),
    }).then((r) => r.json());
    expect(created.ok).toBe(true);
    taskId = created.data.id;
    const taskStore = await import("../task/task-store.mjs");
    await taskStore.updateTask(taskId, {
      status: "blocked",
      branchName: "task/example",
    });
    if (typeof taskStore.waitForStoreWrites === "function") {
      await taskStore.waitForStoreWrites();
    }

    const list = await fetch(
      `http://127.0.0.1:${port}/api/tasks?search=${encodeURIComponent(taskId)}&pageSize=50`,
    ).then((r) => r.json());

    expect(list.ok).toBe(true);
    const listedTask = list.data.find((entry) => entry.id === taskId);
    expect(listedTask?.status).toBe("blocked");
    expect(listedTask?.blockedContext?.category).toBe("worktree_failure");
    expect(listedTask?.blockedContext?.worktreeFailureCount).toBeGreaterThan(0);
    expect(listedTask?.blockedContext?.workflowRunEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "workflow-run",
          failureKind: "branch_refresh_conflict",
          message: expect.stringContaining("Worktree refresh failed for existing branch"),
        }),
      ]),
    );
    expect(fakeEngine.getRunDetail).not.toHaveBeenCalled();
    expect(fakeEngine.getTaskTraceEvents).not.toHaveBeenCalled();
  }, 15000);

  it("surfaces repo-area contention summaries on /api/telemetry/summary", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const mod = await import("../server/ui-server.mjs");
    mod.injectUiDependencies({
      getInternalExecutor: () => ({
        getStatus: () => ({
          maxParallel: 4,
          activeSlots: 1,
          slots: [],
          repoAreaLocks: {
            areas: [
              {
                area: "server",
                waitingTasks: 2,
                activeSlots: 1,
                effectiveLimit: 1,
                contentionEvents: 3,
                contentionWaitMs: 8400,
                lastContentionAt: "2026-03-24T11:55:00.000Z",
              },
            ],
            contention: {
              events: 3,
              waitMsTotal: 8400,
              recent: [
                {
                  at: "2026-03-24T11:55:00.000Z",
                  taskId: "task-123",
                  area: "server",
                  waitMs: 3200,
                  resolutionReason: "deferred",
                },
              ],
            },
          },
        }),
        isPaused: () => false,
      }),
    });

    let server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    try {
      const response = await fetch("http://127.0.0.1:" + port + "/api/telemetry/summary");
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.ok).toBe(true);
      expect(payload.repoAreaContention).toMatchObject({
        totalEvents: 3,
        totalWaitMs: 8400,
        stale: false,
      });
      expect(payload.repoAreaContention.hotAreas[0]).toMatchObject({
        area: "server",
        waitingTasks: 2,
        events: 3,
      });
      expect(payload.repoAreaContention.recent[0]).toMatchObject({
        taskId: "task-123",
        area: "server",
      });
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
      server = null;
    }
  });

  it("returns durable lifetime telemetry totals from the runtime accumulator", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const cacheDir = mkdtempSync(join(tmpdir(), "bosun-ui-telemetry-runtime-"));
    const sandboxLogDir = join(process.env.BOSUN_TEST_CACHE_DIR, "agent-work-logs");
    mkdirSync(sandboxLogDir, { recursive: true });
    writeFileSync(
      join(sandboxLogDir, "agent-metrics.jsonl"),
      `${JSON.stringify({
        timestamp: "2026-04-05T03:00:00.000Z",
        executor: "sandbox-executor",
        metrics: {
          success: true,
          duration_ms: 1200,
          total_tokens: 21,
          prompt_tokens: 13,
          completion_tokens: 8,
          errors: 0,
        },
      })}\n`,
      "utf8",
    );
    vi.resetModules();
    const runtimeAccumulator = await import("../infra/runtime-accumulator.mjs");
    runtimeAccumulator._resetRuntimeAccumulatorForTests({ cacheDir });
    const baselineTotals = {
      ...(runtimeAccumulator.getRuntimeStats()?.lifetimeTotals || {}),
    };
    runtimeAccumulator.addCompletedSession({
      id: "session-telemetry-1",
      sessionId: "session-telemetry-1",
      sessionKey: "task-telemetry-api:1",
      taskId: "task-telemetry-api",
      taskTitle: "Telemetry API task",
      startedAt: 1_000,
      endedAt: 9_000,
      durationMs: 8_000,
      inputTokens: 1_200,
      outputTokens: 300,
      tokenCount: 1_500,
      toolCalls: 3,
      toolResults: 3,
      hasEdits: true,
      hasCommits: true,
      topTools: [{ name: "apply_patch", count: 2 }],
      contextWindow: { usedTokens: 9_200, totalTokens: 10_000, percent: 92 },
      runtimeHealth: { state: "completed", severity: "info", contextUsagePercent: 92 },
      status: "completed",
    });

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    try {
      const statusResponse = await fetch(`http://127.0.0.1:${port}/api/status`);
      const statusPayload = await statusResponse.json();
      const response = await fetch(`http://127.0.0.1:${port}/api/telemetry/summary`);
      const payload = await response.json();

      expect(statusResponse.status).toBe(200);
      expect(statusPayload.ok).toBe(true);
      expect(statusPayload.data).toEqual(expect.objectContaining({
        activeSessionCount: 0,
        completedSessionCount: 1,
        totalSessionCount: 1,
        sessionHealth: expect.objectContaining({
          live: 0,
          completed: 1,
          total: 1,
        }),
        context: expect.objectContaining({
          liveSessionCount: 0,
          completedSessionCount: 1,
          sessionsNearContextLimit: 1,
          sessionsHighContextPressure: 1,
          maxContextUsagePercent: 92,
          avgContextUsagePercent: 92,
        }),
        toolSummary: expect.objectContaining({
          toolCalls: 3,
          toolResults: 3,
          sessionsWithEdits: 1,
          sessionsWithCommits: 1,
          topTools: expect.arrayContaining([
            expect.objectContaining({ name: "apply_patch", count: 2 }),
          ]),
        }),
      }));
      expect(response.status).toBe(200);
      expect(payload.ok).toBe(true);
      expect(payload.data.total).toBe(1);
      expect(payload.data.success).toBe(1);
      expect(payload.data.executors).toEqual({ "sandbox-executor": 1 });
      expect(payload.data.lifetimeTotals).toEqual(expect.objectContaining({
        attemptsCount: Number(baselineTotals.attemptsCount || 0) + 1,
        tokenCount: Number(baselineTotals.tokenCount || 0) + 1_500,
        inputTokens: Number(baselineTotals.inputTokens || 0) + 1_200,
        outputTokens: Number(baselineTotals.outputTokens || 0) + 300,
        durationMs: Number(baselineTotals.durationMs || 0) + 8_000,
      }));
      expect(payload.data).toEqual(expect.objectContaining({
        activeSessionCount: 0,
        completedSessionCount: 1,
        totalSessionCount: 1,
        sessionHealth: expect.objectContaining({
          live: 0,
          completed: 1,
          total: 1,
        }),
        context: expect.objectContaining({
          liveSessionCount: 0,
          completedSessionCount: 1,
          sessionsNearContextLimit: 1,
          sessionsHighContextPressure: 1,
          maxContextUsagePercent: 92,
          avgContextUsagePercent: 92,
        }),
        toolSummary: expect.objectContaining({
          toolCalls: 3,
          toolResults: 3,
          sessionsWithEdits: 1,
          sessionsWithCommits: 1,
          topTools: expect.arrayContaining([
            expect.objectContaining({ name: "apply_patch", count: 2 }),
          ]),
        }),
      }));
    } finally {
      runtimeAccumulator._resetRuntimeAccumulatorForTests();
      vi.resetModules();
      await new Promise((resolve) => server.close(resolve));
      await settleUiRuntimeCleanup();
      await removeDirWithRetries(cacheDir);
    }
  }, 15000);
  it("returns a diagnosticId on task detail failures and logs the raw backend cause", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const mod = await import("../server/ui-server.mjs");
    mod._testInjectWorkflowEngine(null, null);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mod.injectUiDependencies({
      taskStoreApi: {
        canStartTask: vi.fn(() => {
          throw new Error("detail exploded\n    at fake-stack-frame");
        }),
      },
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "diagnostic detail task",
        description: "trigger task detail failure",
      }),
    }).then((r) => r.json());
    expect(created.ok).toBe(true);

    const detailResp = await fetch(
      `http://127.0.0.1:${port}/api/tasks/detail?taskId=${encodeURIComponent(created.data.id)}`,
    );
    const detailJson = await detailResp.json();

    expect(detailResp.status).toBe(500);
    expect(detailJson.ok).toBe(false);
    expect(detailJson.error).toBe("Internal server error");
    expect(detailJson.diagnosticId).toMatch(/^req_[a-f0-9]+$/i);
    expect(errorSpy).toHaveBeenCalledWith(
      "[ui-server] request failed",
      expect.objectContaining({
        diagnosticId: detailJson.diagnosticId,
        path: "/api/tasks/detail",
        payload: expect.objectContaining({
          error: expect.stringContaining("detail exploded"),
        }),
      }),
    );
  }, 15000);
  it("wires sprint and dag task-store APIs through ui-server endpoints", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const sprintMap = new Map();
    sprintMap.set("s-1", { id: "s-1", name: "Sprint 1", executionMode: "parallel" });

    const mod = await import("../server/ui-server.mjs");
    mod.injectUiDependencies({
      taskStoreApi: {
        listSprints: vi.fn(() => [...sprintMap.values()]),
        createSprint: vi.fn((payload = {}) => {
          const id = payload.id || "s-2";
          const sprint = {
            id,
            name: payload.name || `Sprint ${id}`,
            executionMode: payload.executionMode || payload.taskOrderMode || "parallel",
            taskOrderMode: payload.taskOrderMode || payload.executionMode || "parallel",
          };
          sprintMap.set(id, sprint);
          return sprint;
        }),
        getSprint: vi.fn((id) => sprintMap.get(id) || null),
        updateSprint: vi.fn((id, payload = {}) => {
          const current = sprintMap.get(id) || { id, name: `Sprint ${id}` };
          const next = {
            ...current,
            ...payload,
            id,
            executionMode: payload.executionMode || payload.taskOrderMode || current.executionMode || "parallel",
            taskOrderMode: payload.taskOrderMode || payload.executionMode || current.taskOrderMode || current.executionMode || "parallel",
          };
          sprintMap.set(id, next);
          return next;
        }),
        deleteSprint: vi.fn((id) => ({ id, deleted: true })),
        getSprintDag: vi.fn((id) => ({ sprintId: id, nodes: [{ id: "A" }], edges: [] })),
        getGlobalDagOfDags: vi.fn(() => ({ nodes: [{ id: "s-1" }], edges: [] })),
      },
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const sprintList = await fetch(`http://127.0.0.1:${port}/api/tasks/sprints`).then((r) => r.json());
    expect(sprintList.ok).toBe(true);
    expect(Array.isArray(sprintList.data)).toBe(true);
    expect(sprintList.data[0].executionMode).toBe("parallel");

    const invalidMode = await fetch(`http://127.0.0.1:${port}/api/tasks/sprints`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "bad-mode", name: "Bad", executionMode: "random" }),
    });
    expect(invalidMode.status).toBe(400);

    const sprintCreate = await fetch(`http://127.0.0.1:${port}/api/tasks/sprints`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "s-2", name: "Sprint 2", executionMode: "sequential" }),
    }).then((r) => r.json());
    expect(sprintCreate.ok).toBe(true);
    expect(sprintCreate.data.id).toBe("s-2");
    expect(sprintCreate.data.executionMode).toBe("sequential");
    expect(sprintCreate.data.taskOrderMode).toBe("sequential");

    const sprintUpdate = await fetch(`http://127.0.0.1:${port}/api/tasks/sprints/s-2`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executionMode: "parallel" }),
    }).then((r) => r.json());
    expect(sprintUpdate.ok).toBe(true);
    expect(sprintUpdate.data.executionMode).toBe("parallel");

    const sprintGet = await fetch(`http://127.0.0.1:${port}/api/tasks/sprints/s-2`).then((r) => r.json());
    expect(sprintGet.ok).toBe(true);
    expect(sprintGet.data.executionMode).toBe("parallel");

    const sprintDag = await fetch(`http://127.0.0.1:${port}/api/tasks/dag?sprintId=s-1`).then((r) => r.json());
    expect(sprintDag.ok).toBe(true);
    expect(sprintDag.data.sprintId).toBe("s-1");
    expect(sprintDag.sprint.executionMode).toBe("parallel");

    const sprintSpecificDag = await fetch(`http://127.0.0.1:${port}/api/tasks/sprints/s-1/dag`).then((r) => r.json());
    expect(sprintSpecificDag.ok).toBe(true);
    expect(sprintSpecificDag.sprint.executionMode).toBe("parallel");

    const dagOfDags = await fetch(`http://127.0.0.1:${port}/api/tasks/dag-of-dags`).then((r) => r.json());
    expect(dagOfDags.ok).toBe(true);
    expect(Array.isArray(dagOfDags.data.nodes)).toBe(true);
  }, process.platform === "win32" ? 15000 : 10000);

  it("supports task comment aliases and validation through /api/tasks/comment", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const mod = await import("../server/ui-server.mjs");
    const addTaskComment = vi.fn(() => ({ id: "comment-1" }));
    mod.injectUiDependencies({
      taskStoreApi: {
        addTaskComment,
        appendTaskTimelineEvent: vi.fn(),
      },
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "comment test task", description: "comment coverage" }),
    }).then((r) => r.json());
    expect(created.ok).toBe(true);

    const missingBodyResp = await fetch(`http://127.0.0.1:${port}/api/tasks/comment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: created.data.id }),
    });
    expect(missingBodyResp.status).toBe(400);

    const commentResp = await fetch(`http://127.0.0.1:${port}/api/tasks/comment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: created.data.id,
        comment: "looks good",
        author: "qa",
      }),
    });
    const commentJson = await commentResp.json();

    expect(commentResp.status).toBe(200);
    expect(commentJson.ok).toBe(true);
    expect(commentJson.stored).toBe(true);
    expect(addTaskComment).toHaveBeenCalled();
  }, 15000);

  it("returns normalized task comments from GET /api/tasks/comment", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const mod = await import("../server/ui-server.mjs");
    mod.injectUiDependencies({
      taskStoreApi: {
        getTaskComments: vi.fn(() => [
          { id: "c1", body: "first", author: "qa", createdAt: "2026-03-08T00:00:00.000Z" },
          { commentId: "c2", text: "second", actor: "dev", timestamp: "2026-03-08T01:00:00.000Z" },
        ]),
      },
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    try {
      const port = server.address().port;

      const response = await fetch(`http://127.0.0.1:${port}/api/tasks/comment?taskId=T-123`);
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.taskId).toBe("T-123");
      expect(Array.isArray(json.comments)).toBe(true);
      expect(json.comments).toEqual([
        expect.objectContaining({
          id: "c1",
          body: "first",
          author: "qa",
          createdAt: "2026-03-08T00:00:00.000Z",
        }),
        expect.objectContaining({
          id: "c2",
          body: "second",
          author: "dev",
          createdAt: "2026-03-08T01:00:00.000Z",
        }),
      ]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, 15000);

  it("keeps legacy tasks without workspace metadata in the active workspace task list", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-ui-task-workspace-"));
    const configPath = join(tmpDir, "bosun.config.json");
    const storePath = join(tmpDir, ".bosun", ".cache", "kanban-state.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        $schema: "./bosun.schema.json",
        activeWorkspace: "virtengine-gh",
        workspaces: [
          {
            id: "virtengine-gh",
            name: "virtengine-gh",
            repos: [{ name: "bosun", primary: true }],
            activeRepo: "bosun",
          },
        ],
      }, null, 2) + "\n",
      "utf8",
    );
    process.env.BOSUN_CONFIG_PATH = configPath;
    process.env.BOSUN_HOME = tmpDir;
    process.env.BOSUN_DIR = tmpDir;
    process.env.CODEX_MONITOR_HOME = tmpDir;
    process.env.CODEX_MONITOR_DIR = tmpDir;

    const taskStore = await import("../task/task-store.mjs");
    const originalStorePath = taskStore.getStorePath();
    taskStore.configureTaskStore({ storePath });
    taskStore.loadStore();
    taskStore.addTask({ id: "legacy-no-workspace", title: "Legacy task", status: "todo" });
    taskStore.addTask({ id: "active-workspace", title: "Active workspace task", status: "draft", workspace: "virtengine-gh" });
    taskStore.addTask({ id: "blocked-workspace", title: "Blocked workspace task", status: "blocked", workspace: "virtengine-gh" });
    taskStore.addTask({ id: "other-workspace", title: "Other workspace task", status: "todo", workspace: "other-workspace" });

    const mod = await import("../server/ui-server.mjs");
    try {
      const server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });
      const port = server.address().port;
      taskStore.configureTaskStore({ storePath });
      taskStore.loadStore();

      const response = await fetch(`http://127.0.0.1:${port}/api/tasks`);
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.total).toBe(3);
      expect(json.statusCounts.backlog).toBe(1);
      expect(json.statusCounts.draft).toBe(1);
      expect(json.statusCounts.blocked).toBe(1);
      expect(json.data.map((task) => task.id).sort()).toEqual([
        "active-workspace",
        "blocked-workspace",
        "legacy-no-workspace",
      ]);
    } finally {
      taskStore.configureTaskStore({ storePath: originalStorePath });
      await settleUiRuntimeCleanup();
      await removeDirWithRetries(tmpDir);
    }
  }, 15000);

  it("sorts /api/tasks by the most recent task activity before pagination", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-ui-task-sort-"));
    const configPath = join(tmpDir, "bosun.config.json");
    const storePath = join(tmpDir, ".bosun", ".cache", "kanban-state.json");
    mkdirSync(join(tmpDir, ".bosun", ".cache"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        $schema: "./bosun.schema.json",
        activeWorkspace: "virtengine-gh",
        workspaces: [
          {
            id: "virtengine-gh",
            name: "virtengine-gh",
            repos: [{ name: "bosun", primary: true }],
            activeRepo: "bosun",
          },
        ],
      }, null, 2) + "\n",
      "utf8",
    );
    process.env.BOSUN_CONFIG_PATH = configPath;
    process.env.BOSUN_HOME = tmpDir;
    process.env.BOSUN_DIR = tmpDir;
    process.env.CODEX_MONITOR_HOME = tmpDir;
    process.env.CODEX_MONITOR_DIR = tmpDir;

    const taskStore = await import("../task/task-store.mjs");
    const originalStorePath = taskStore.getStorePath();
    taskStore.configureTaskStore({ storePath });
    taskStore.loadStore();
    taskStore.addTask({
      id: "task-oldest",
      title: "Oldest updated task",
      status: "todo",
      workspace: "virtengine-gh",
      updatedAt: "2026-03-31T08:00:00.000Z",
    });
    taskStore.addTask({
      id: "task-newer-update",
      title: "Newer updated task",
      status: "todo",
      workspace: "virtengine-gh",
      updatedAt: "2026-03-31T10:00:00.000Z",
    });
    taskStore.addTask({
      id: "task-latest-activity",
      title: "Latest activity task",
      status: "todo",
      workspace: "virtengine-gh",
    });
    const persistedStore = {
      _meta: {
        version: 1,
        updatedAt: "2026-03-31T11:30:00.000Z",
        taskCount: 3,
        stats: {},
      },
      tasks: Object.fromEntries(
        taskStore.getAllTasks().map((task) => [task.id, { ...task }]),
      ),
    };
    persistedStore.tasks["task-oldest"].updatedAt = "2026-03-31T08:00:00.000Z";
    persistedStore.tasks["task-oldest"].lastActivityAt = "2026-03-31T08:00:00.000Z";
    persistedStore.tasks["task-newer-update"].updatedAt = "2026-03-31T10:00:00.000Z";
    persistedStore.tasks["task-newer-update"].lastActivityAt = "2026-03-31T10:00:00.000Z";
    persistedStore.tasks["task-latest-activity"].updatedAt = "2026-03-31T09:00:00.000Z";
    persistedStore.tasks["task-latest-activity"].lastActivityAt = "2026-03-31T11:30:00.000Z";
    writeFileSync(storePath, JSON.stringify(persistedStore, null, 2) + "\n", "utf8");
    taskStore.loadStore();

    const mod = await import("../server/ui-server.mjs");
    try {
      const server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });
      const port = server.address().port;
      taskStore.configureTaskStore({ storePath });
      taskStore.loadStore();

      const response = await fetch(`http://127.0.0.1:${port}/api/tasks?pageSize=50`);
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.data.map((task) => task.id)).toEqual([
        "task-latest-activity",
        "task-newer-update",
        "task-oldest",
      ]);
    } finally {
      taskStore.configureTaskStore({ storePath: originalStorePath });
      await settleUiRuntimeCleanup();
      await removeDirWithRetries(tmpDir);
    }
  }, 15000);

  it("sets full dependencies and assigns sprint task ordering via task APIs", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const taskMap = new Map();
    const sprintMap = new Map();

    const mod = await import("../server/ui-server.mjs");
    mod.injectUiDependencies({
      taskStoreApi: {
        getTaskById: vi.fn((taskId) => taskMap.get(taskId) || null),
        addTaskDependency: vi.fn((taskId, depId) => {
          const task = taskMap.get(taskId);
          if (!task) return null;
          const next = Array.isArray(task.dependencyTaskIds) ? [...task.dependencyTaskIds] : [];
          if (!next.includes(depId)) next.push(depId);
          taskMap.set(taskId, { ...task, dependencyTaskIds: next, dependsOn: next, dependencies: next });
          return true;
        }),
        removeTaskDependency: vi.fn((taskId, depId) => {
          const task = taskMap.get(taskId);
          if (!task) return null;
          const next = (Array.isArray(task.dependencyTaskIds) ? task.dependencyTaskIds : []).filter((id) => id !== depId);
          taskMap.set(taskId, { ...task, dependencyTaskIds: next, dependsOn: next, dependencies: next });
          return true;
        }),
        updateTask: vi.fn((taskId, patch) => {
          const task = taskMap.get(taskId) || { id: taskId, meta: {} };
          const updated = {
            ...task,
            ...patch,
            meta: {
              ...(task.meta || {}),
              ...(patch?.meta && typeof patch.meta === "object" ? patch.meta : {}),
            },
          };
          taskMap.set(taskId, updated);
          return updated;
        }),
        upsertSprint: vi.fn((sprintId, payload = {}) => {
          const id = String(sprintId || payload?.id || "").trim();
          if (!id) return null;
          const sprint = { id, ...(payload || {}) };
          sprintMap.set(id, sprint);
          return sprint;
        }),
        assignTaskToSprint: vi.fn((taskId, sprintId, options = {}) => {
          const task = taskMap.get(taskId);
          if (!task) return null;
          const updated = {
            ...task,
            sprintId,
            sprint: sprintId,
            ...(Number.isFinite(Number(options?.sprintOrder)) ? { sprintOrder: Number(options.sprintOrder) } : {}),
          };
          taskMap.set(taskId, updated);
          return updated;
        }),
        getSprintDag: vi.fn((sprintId) => {
          const nodes = [...taskMap.values()]
            .filter((task) => String(task?.sprintId || task?.sprint || "") === String(sprintId))
            .map((task) => ({ id: task.id }));
          return { sprintId, nodes, edges: [] };
        }),
        getGlobalDagOfDags: vi.fn(() => ({ nodes: [...sprintMap.keys()].map((id) => ({ id })), edges: [] })),
      },
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const taskOne = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Dependency task one", description: "base" }),
    }).then((r) => r.json());
    const taskTwo = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Dependency task two", description: "dep" }),
    }).then((r) => r.json());

    expect(taskOne.ok).toBe(true);
    expect(taskTwo.ok).toBe(true);
    taskMap.set(taskOne.data.id, taskOne.data);
    taskMap.set(taskTwo.data.id, taskTwo.data);

    const depResponse = await fetch(`http://127.0.0.1:${port}/api/tasks/dependencies`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: taskOne.data.id,
        dependencies: [taskTwo.data.id],
        sprintId: "sprint-a",
        sprintOrder: 2,
      }),
    });
    const depJson = await depResponse.json();

    expect(depResponse.status).toBe(200);
    expect(depJson.ok).toBe(true);
    expect(depJson.dependencies).toEqual([taskTwo.data.id]);
    expect(depJson.data.sprintId).toBe("sprint-a");
    expect(depJson.dag.sprint).toBeTruthy();
    expect(depJson.dag.global).toBeTruthy();

    const assignResponse = await fetch(`http://127.0.0.1:${port}/api/tasks/sprints/sprint-b/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: taskOne.data.id, sprintOrder: 1 }),
    });
    const assignJson = await assignResponse.json();

    expect(assignResponse.status).toBe(200);
    expect(assignJson.ok).toBe(true);
    expect(assignJson.data.sprintId).toBe("sprint-b");

    const sprintDagResp = await fetch(`http://127.0.0.1:${port}/api/tasks/sprints/sprint-b/dag`);
    const sprintDagJson = await sprintDagResp.json();

    expect(sprintDagResp.status).toBe(200);
    expect(sprintDagJson.ok).toBe(true);
    expect(sprintDagJson.sprintId).toBe("sprint-b");
    expect(Array.isArray(sprintDagJson.data.nodes)).toBe(true);
  });


  it("persists jira-style metadata fields on create, update, and edit", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const created = await fetch("http://127.0.0.1:" + port + "/api/tasks/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "jira-metadata task",
        description: "metadata",
        assignee: "alice",
        epicId: "EPIC-123",
        storyPoints: 8,
        parentTaskId: "PARENT-1",
        dueDate: "2026-04-01",
        goalId: "goal-platform",
        parentGoalId: "goal-program",
        budgetWindow: "2026-Q2",
        budgetCents: 25000,
        budgetCurrency: "USD",
        coordinationTeamId: "team-platform",
        coordinationRole: "implementer",
        coordinationReportsTo: "planner-lead",
        coordinationLevel: "squad",
      }),
    }).then((r) => r.json());

    expect(created.ok).toBe(true);
    expect(created.data.assignee).toBe("alice");
    expect(created.data.assignees).toEqual(["alice"]);
    expect(created.data.epicId).toBe("EPIC-123");
    expect(created.data.storyPoints).toBe(8);
    expect(created.data.parentTaskId).toBe("PARENT-1");
    expect(created.data.dueDate).toBe("2026-04-01");
    expect(created.data.goalId).toBe("goal-platform");
    expect(created.data.primaryGoalId).toBe("goal-platform");
    expect(created.data.parentGoalId).toBe("goal-program");
    expect(created.data.budgetWindow).toBe("2026-Q2");
    expect(created.data.budgetCents).toBe(25000);
    expect(created.data.budgetCurrency).toBe("USD");
    expect(created.data.coordinationTeamId).toBe("team-platform");
    expect(created.data.coordinationRole).toBe("implementer");
    expect(created.data.coordinationReportsTo).toBe("planner-lead");
    expect(created.data.coordinationLevel).toBe("squad");
    expect(created.data.meta?.assignee).toBe("alice");
    expect(created.data.meta?.assignees).toEqual(["alice"]);
    expect(created.data.meta?.epicId).toBe("EPIC-123");
    expect(created.data.meta?.storyPoints).toBe(8);
    expect(created.data.meta?.parentTaskId).toBe("PARENT-1");
    expect(created.data.meta?.dueDate).toBe("2026-04-01");
    expect(created.data.meta?.goalId).toBe("goal-platform");
    expect(created.data.meta?.primaryGoalId).toBe("goal-platform");
    expect(created.data.meta?.parentGoalId).toBe("goal-program");
    expect(created.data.meta?.budgetWindow).toBe("2026-Q2");
    expect(created.data.meta?.budgetCents).toBe(25000);
    expect(created.data.meta?.budgetCurrency).toBe("USD");
    expect(created.data.meta?.coordinationTeamId).toBe("team-platform");
    expect(created.data.meta?.coordinationRole).toBe("implementer");
    expect(created.data.meta?.coordinationReportsTo).toBe("planner-lead");
    expect(created.data.meta?.coordinationLevel).toBe("squad");

    const updated = await fetch("http://127.0.0.1:" + port + "/api/tasks/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: created.data.id,
        assignee: "charlie",
        assignees: ["charlie", "dana"],
        epicId: "EPIC-999",
        storyPoints: 13,
        parentTaskId: "PARENT-2",
        dueDate: "2026-05-10",
        goalId: "goal-reliability",
        parentGoalId: "goal-platform",
        budgetWindow: "2026-Q3",
        budgetCents: 40000,
        budgetCurrency: "AUD",
        coordinationTeamId: "team-reliability",
        coordinationRole: "reviewer",
        coordinationReportsTo: "eng-manager",
        coordinationLevel: "org",
      }),
    }).then((r) => r.json());

    expect(updated.ok).toBe(true);
    expect(updated.data.assignee).toBe("charlie");
    expect(updated.data.assignees).toEqual(["charlie", "dana"]);
    expect(updated.data.epicId).toBe("EPIC-999");
    expect(updated.data.storyPoints).toBe(13);
    expect(updated.data.parentTaskId).toBe("PARENT-2");
    expect(updated.data.dueDate).toBe("2026-05-10");
    expect(updated.data.goalId).toBe("goal-reliability");
    expect(updated.data.primaryGoalId).toBe("goal-reliability");
    expect(updated.data.parentGoalId).toBe("goal-platform");
    expect(updated.data.budgetWindow).toBe("2026-Q3");
    expect(updated.data.budgetCents).toBe(40000);
    expect(updated.data.budgetCurrency).toBe("AUD");
    expect(updated.data.coordinationTeamId).toBe("team-reliability");
    expect(updated.data.coordinationRole).toBe("reviewer");
    expect(updated.data.coordinationReportsTo).toBe("eng-manager");
    expect(updated.data.coordinationLevel).toBe("org");
    expect(updated.data.meta?.assignee).toBe("charlie");
    expect(updated.data.meta?.assignees).toEqual(["charlie", "dana"]);
    expect(updated.data.meta?.epicId).toBe("EPIC-999");
    expect(updated.data.meta?.storyPoints).toBe(13);
    expect(updated.data.meta?.parentTaskId).toBe("PARENT-2");
    expect(updated.data.meta?.dueDate).toBe("2026-05-10");
    expect(updated.data.meta?.goalId).toBe("goal-reliability");
    expect(updated.data.meta?.primaryGoalId).toBe("goal-reliability");
    expect(updated.data.meta?.parentGoalId).toBe("goal-platform");
    expect(updated.data.meta?.budgetWindow).toBe("2026-Q3");
    expect(updated.data.meta?.budgetCents).toBe(40000);
    expect(updated.data.meta?.budgetCurrency).toBe("AUD");
    expect(updated.data.meta?.coordinationTeamId).toBe("team-reliability");
    expect(updated.data.meta?.coordinationRole).toBe("reviewer");
    expect(updated.data.meta?.coordinationReportsTo).toBe("eng-manager");
    expect(updated.data.meta?.coordinationLevel).toBe("org");

    const edited = await fetch("http://127.0.0.1:" + port + "/api/tasks/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskId: created.data.id,
        assignee: "eve",
        assignees: ["eve"],
        epicId: "EPIC-777",
        storyPoints: 5,
        parentTaskId: "PARENT-3",
        dueDate: "2026-06-20",
        goalId: "goal-shipping",
        parentGoalId: "goal-reliability",
        budgetWindow: "2026-Q4",
        budgetCents: 55000,
        budgetCurrency: "EUR",
        coordinationTeamId: "team-release",
        coordinationRole: "verifier",
        coordinationReportsTo: "release-director",
        coordinationLevel: "program",
      }),
    }).then((r) => r.json());

    expect(edited.ok).toBe(true);
    expect(edited.data.assignee).toBe("eve");
    expect(edited.data.assignees).toEqual(["eve"]);
    expect(edited.data.epicId).toBe("EPIC-777");
    expect(edited.data.storyPoints).toBe(5);
    expect(edited.data.parentTaskId).toBe("PARENT-3");
    expect(edited.data.dueDate).toBe("2026-06-20");
    expect(edited.data.goalId).toBe("goal-shipping");
    expect(edited.data.primaryGoalId).toBe("goal-shipping");
    expect(edited.data.parentGoalId).toBe("goal-reliability");
    expect(edited.data.budgetWindow).toBe("2026-Q4");
    expect(edited.data.budgetCents).toBe(55000);
    expect(edited.data.budgetCurrency).toBe("EUR");
    expect(edited.data.coordinationTeamId).toBe("team-release");
    expect(edited.data.coordinationRole).toBe("verifier");
    expect(edited.data.coordinationReportsTo).toBe("release-director");
    expect(edited.data.coordinationLevel).toBe("program");
    expect(edited.data.meta?.assignee).toBe("eve");
    expect(edited.data.meta?.assignees).toEqual(["eve"]);
    expect(edited.data.meta?.epicId).toBe("EPIC-777");
    expect(edited.data.meta?.storyPoints).toBe(5);
    expect(edited.data.meta?.parentTaskId).toBe("PARENT-3");
    expect(edited.data.meta?.dueDate).toBe("2026-06-20");
    expect(edited.data.meta?.goalId).toBe("goal-shipping");
    expect(edited.data.meta?.primaryGoalId).toBe("goal-shipping");
    expect(edited.data.meta?.parentGoalId).toBe("goal-reliability");
    expect(edited.data.meta?.budgetWindow).toBe("2026-Q4");
    expect(edited.data.meta?.budgetCents).toBe(55000);
    expect(edited.data.meta?.budgetCurrency).toBe("EUR");
    expect(edited.data.meta?.coordinationTeamId).toBe("team-release");
    expect(edited.data.meta?.coordinationRole).toBe("verifier");
    expect(edited.data.meta?.coordinationReportsTo).toBe("release-director");
    expect(edited.data.meta?.coordinationLevel).toBe("program");
  });

  it("matches task-assigned workflows using task goal and budget governance metadata", async () => {
    const isolatedDir = mkdtempSync(join(tmpdir(), "bosun-ui-task-governance-"));
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_HOME = isolatedDir;
    process.env.BOSUN_DIR = isolatedDir;
    process.env.CODEX_MONITOR_HOME = isolatedDir;
    process.env.CODEX_MONITOR_DIR = isolatedDir;

    const mod = await import("../server/ui-server.mjs");
    let server = null;
    const workflow = {
      id: "wf-task-governance-match",
      name: "Task Governance Match",
      enabled: true,
      nodes: [
        {
          id: "trigger",
          type: "trigger.task_assigned",
          label: "Task Assigned",
          config: {
            filter: [
              '$data.primaryGoalId === "goal-ops"',
              '$data.goalAncestry?.[0]?.goalId === "goal-program"',
              '$data.goalAncestry?.[1]?.goalId === "goal-ops"',
              '$data.budgetPolicy?.budgetWindow === "2026-Q2"',
              "$data.budgetPolicy?.budgetCents === 25000",
              '$data.budgetPolicy?.currency === "USD"',
              '$data.coordination?.teamId === "team-platform"',
              '$data.coordination?.role === "implementer"',
              '$data.coordination?.reportsTo === "planner-lead"',
              '$data.coordination?.level === "squad"',
              'task.primaryGoalId === "goal-ops"',
              '$data.task?.budgetPolicy?.budgetWindow === "2026-Q2"',
              '$data.task?.coordination?.role === "implementer"',
            ].join(" && "),
          },
        },
        {
          id: "log",
          type: "notify.log",
          label: "Log",
          config: { message: "matched governance-backed task" },
        },
      ],
      edges: [{ id: "edge-1", source: "trigger", target: "log" }],
      variables: {},
    };
    const fakeEngine = {
      list: vi.fn(async () => [{ id: workflow.id }]),
      get: vi.fn(async (workflowId) => (workflowId === workflow.id ? workflow : null)),
    };
    mod._testInjectWorkflowEngine({ WorkflowEngine: class MockWorkflowEngine {} }, fakeEngine);

    try {
      server = await mod.startTelegramUiServer({
        port: await getFreePort(),
        host: "127.0.0.1",
        skipInstanceLock: true,
        skipAutoOpen: true,
      });
      const port = server.address().port;

      const created = await fetch(`http://127.0.0.1:${port}/api/tasks/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Governed task",
          description: "Task metadata should seed workflow governance",
          goalId: "goal-ops",
          parentGoalId: "goal-program",
          budgetWindow: "2026-Q2",
          budgetCents: 25000,
          budgetCurrency: "USD",
          coordinationTeamId: "team-platform",
          coordinationRole: "implementer",
          coordinationReportsTo: "planner-lead",
          coordinationLevel: "squad",
        }),
      }).then((r) => r.json());

      expect(created.ok).toBe(true);

      const plan = await fetch(
        `http://127.0.0.1:${port}/api/tasks/execution-plan?taskId=${encodeURIComponent(created.data.id)}`,
      ).then((r) => r.json());

      expect(plan.ok).toBe(true);
      expect(plan.stageCount).toBe(1);
      expect(plan.stages).toEqual([
        expect.objectContaining({
          workflowId: workflow.id,
          workflowName: workflow.name,
          matchType: "task_assigned",
          nodeCount: 2,
        }),
      ]);
      expect(fakeEngine.list).toHaveBeenCalledTimes(1);
      expect(fakeEngine.get).toHaveBeenCalledWith(workflow.id);
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
      await removeDirWithRetries(isolatedDir);
      mod._testInjectWorkflowEngine(null, null);
    }
  }, 60000);

  it("creates and lists subtasks via /api/tasks/subtasks", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const taskMap = new Map();
    let nextId = 1;

    const mod = await import("../server/ui-server.mjs");
    mod.injectUiDependencies({
      taskStoreApi: {
        getTask: vi.fn((taskId) => taskMap.get(taskId) || null),
        getAllTasks: vi.fn(() => [...taskMap.values()]),
        createTask: vi.fn((projectId, payload = {}) => {
          const id = payload.id || `task-${nextId++}`;
          const created = {
            id,
            title: payload.title || "",
            description: payload.description || "",
            status: payload.status || "todo",
            ...(payload.parentTaskId ? { parentTaskId: payload.parentTaskId } : {}),
            ...(payload.priority ? { priority: payload.priority } : {}),
            meta: {
              ...(payload.meta && typeof payload.meta === "object" ? payload.meta : {}),
            },
          };
          taskMap.set(id, created);
          return created;
        }),
      },
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const parent = await fetch("http://127.0.0.1:" + port + "/api/tasks/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Parent task", description: "parent" }),
    }).then((r) => r.json());
    expect(parent.ok).toBe(true);

    const missingParent = await fetch("http://127.0.0.1:" + port + "/api/tasks/subtasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentTaskId: "missing-parent", title: "Orphan" }),
    });
    expect(missingParent.status).toBe(404);

    const subtask = await fetch("http://127.0.0.1:" + port + "/api/tasks/subtasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parentTaskId: parent.data.id,
        title: "Child task",
      }),
    }).then((r) => r.json());

    expect(subtask.ok).toBe(true);
    expect(subtask.parentTaskId).toBe(parent.data.id);
    expect(subtask.data.parentTaskId || subtask.data?.meta?.parentTaskId).toBe(parent.data.id);

    const listedByTaskId = await fetch("http://127.0.0.1:" + port + "/api/tasks/subtasks?taskId=" + encodeURIComponent(parent.data.id))
      .then((r) => r.json());

    expect(listedByTaskId.ok).toBe(true);
    expect(Array.isArray(listedByTaskId.data)).toBe(true);
    expect(Array.isArray(listedByTaskId.data)).toBe(true);

    const listedByParentTaskId = await fetch("http://127.0.0.1:" + port + "/api/tasks/subtasks?parentTaskId=" + encodeURIComponent(parent.data.id))
      .then((r) => r.json());

    expect(listedByParentTaskId.ok).toBe(true);
    expect(listedByParentTaskId.taskId).toBe(parent.data.id);
    expect(Array.isArray(listedByParentTaskId.data)).toBe(true);
  });

  it("generates and applies task replans with persistent graph proposals", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    let baseTaskId = "";
    const execPrimaryPrompt = vi.fn().mockImplementation(async () => ({
      finalResponse: "```json\n" + JSON.stringify({
        summary: "Split parser implementation from test coverage.",
        planReasoning: "The current task is too broad for a single attempt and should fan out.",
        currentPlanStep: "Create the parser implementation task first.",
        stopReason: "Two subtasks cover the current scope cleanly.",
        recommendedAction: "split_task",
        parentTaskPatch: {
          status: "blocked",
          blockedReason: "Waiting for replanned subtasks to complete",
        },
        subtasks: [
          {
            title: "Build parser core",
            description: "Implement the parser core and validation surface.",
            acceptanceCriteria: ["Parses valid input", "Rejects malformed payloads"],
            priority: "high",
            tags: ["parser", "core"],
          },
          {
            title: "Add parser integration tests",
            description: "Add success and failure coverage for the parser.",
            dependsOnIndexes: [0],
            dependsOnTaskIds: baseTaskId ? [baseTaskId] : [],
            acceptanceCriteria: ["Covers success path", "Covers failure path"],
          },
        ],
      }, null, 2) + "\n```",
    }));

    const mod = await import("../server/ui-server.mjs");
    mod.injectUiDependencies({ execPrimaryPrompt });

    let server = null;
    server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
      dependencies: { execPrimaryPrompt },
    });
    try {
      const port = server.address().port;

      const parentTask = await fetch("http://127.0.0.1:" + port + "/api/tasks/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Implement parser stack",
          description: "Build parser, validation, and tests in one task.",
          status: "blocked",
          priority: "high",
          tags: ["parser"],
        }),
      }).then((r) => r.json());
      expect(parentTask.ok).toBe(true);

      const baseTask = await fetch("http://127.0.0.1:" + port + "/api/tasks/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Shared tokenizer",
          description: "Existing prerequisite task.",
          status: "done",
        }),
      }).then((r) => r.json());
      expect(baseTask.ok).toBe(true);
      baseTaskId = baseTask.data.id;

      const propose = await fetch("http://127.0.0.1:" + port + "/api/tasks/replan/propose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: parentTask.data.id }),
      }).then((r) => r.json());

      expect(propose.ok).toBe(true);
      expect(propose.proposal.recommendedAction).toBe("split_task");
      expect(propose.proposal.subtasks).toHaveLength(2);
      expect(propose.proposal.queuePlan?.counts?.stepCount).toBe(2);
      expect(propose.proposal.queuePlan?.steps?.[1]?.dependsOnStepIds).toEqual(["step-1"]);
      expect(execPrimaryPrompt).toHaveBeenCalledTimes(1);
      expect(propose.task.meta?.replanProposal?.summary).toContain("Split parser implementation");

      const apply = await fetch("http://127.0.0.1:" + port + "/api/tasks/replan/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: parentTask.data.id }),
      }).then((r) => r.json());

      expect(apply.ok).toBe(true);
      expect(Array.isArray(apply.createdSubtasks)).toBe(true);
      expect(apply.createdSubtasks).toHaveLength(2);
      expect(apply.queuePlan?.counts?.createdTaskCount).toBe(2);
      expect(apply.taskGraph?.taskCount).toBe(2);
      const [firstSubtask, secondSubtask] = apply.createdSubtasks;
      expect(firstSubtask.parentTaskId || firstSubtask?.meta?.parentTaskId).toBe(parentTask.data.id);
      expect(secondSubtask.parentTaskId || secondSubtask?.meta?.parentTaskId).toBe(parentTask.data.id);
      const taskStore = await import("../task/task-store.mjs");
      const storedSecond = taskStore.getTask(secondSubtask.id);
      const storedParent = taskStore.getTask(parentTask.data.id);
      expect(storedSecond.dependencyTaskIds || storedSecond.dependsOn).toEqual(
        expect.arrayContaining([firstSubtask.id, baseTask.data.id]),
      );
      expect(apply.task.status).toBe("blocked");
      expect(apply.task.meta?.replanProposal?.status).toBe("applied");
      expect(apply.task.meta?.plannerState?.latestReplan?.createdTaskIds).toEqual(
        expect.arrayContaining([firstSubtask.id, secondSubtask.id]),
      );
      expect(storedParent?.meta?.replanProposal?.status).toBe("applied");
      expect(storedParent?.meta?.plannerState?.latestReplan?.subtaskCount).toBe(2);
      expect(storedParent?.meta?.replanProposal?.queuePlan?.counts?.createdTaskCount).toBe(2);
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
    }
  }, 30000);

  it("supports dedicated task decomposition endpoints with persistent proposals and child graph creation", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const execPrimaryPrompt = vi.fn().mockImplementation(async () => ({
      finalResponse: "```json\n" + JSON.stringify({
        summary: "Decompose the ingestion epic into a runnable child task graph.",
        planReasoning: "The parent task mixes schema work, implementation, and verification that should run as separate child tasks.",
        currentPlanStep: "Start with the schema contract child task.",
        stopReason: "Three child tasks are sufficient for the current scope.",
        recommendedAction: "split_task",
        parentTaskPatch: {
          status: "blocked",
          blockedReason: "Waiting for decomposed child tasks to complete",
          tags: ["decomposed"],
        },
        subtasks: [
          {
            title: "Define ingestion schema contract",
            description: "Capture the input/output contract and validation rules for ingestion.",
            acceptanceCriteria: ["Schema is documented", "Validation edge cases are covered"],
            priority: "high",
            tags: ["schema", "contract"],
          },
          {
            title: "Implement ingestion pipeline",
            description: "Build the ingestion flow against the agreed schema contract.",
            dependsOnIndexes: [0],
            acceptanceCriteria: ["Pipeline processes valid events", "Invalid events fail cleanly"],
            priority: "high",
            tags: ["implementation"],
          },
          {
            title: "Verify ingestion end-to-end",
            description: "Add end-to-end verification for the decomposed ingestion flow.",
            dependsOnIndexes: [1],
            acceptanceCriteria: ["End-to-end path is covered", "Regression evidence is recorded"],
            tags: ["verification"],
          },
        ],
        notes: ["Decomposition should preserve the parent task as the coordination node."],
      }, null, 2) + "\n```",
    }));

    const postDedicatedDecompose = async (port, phase, payload) => {
      const variants = phase === "propose"
        ? [
            { path: "/api/tasks/decompose/propose", body: payload },
            { path: "/api/tasks/decompose", body: { ...payload, action: "propose" } },
            { path: "/api/tasks/decompose", body: { ...payload, mode: "propose" } },
          ]
        : [
            { path: "/api/tasks/decompose/apply", body: payload },
            { path: "/api/tasks/decompose", body: { ...payload, action: "apply" } },
            { path: "/api/tasks/decompose", body: { ...payload, mode: "apply" } },
          ];
      let lastResponse = null;
      for (const variant of variants) {
        const response = await fetch("http://127.0.0.1:" + port + variant.path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(variant.body),
        });
        lastResponse = response;
        if (response.status !== 404) {
          return response.json();
        }
      }
      throw new Error(`No dedicated decomposition endpoint was available for ${phase}; last status=${lastResponse?.status ?? "n/a"}`);
    };

    const mod = await import("../server/ui-server.mjs");
    mod.injectUiDependencies({ execPrimaryPrompt });

    let server = null;
    server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
      dependencies: { execPrimaryPrompt },
    });
    try {
      const port = server.address().port;

      const parentTask = await fetch("http://127.0.0.1:" + port + "/api/tasks/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Ship ingestion reliability epic",
          description: "Schema, implementation, and verification are currently bundled into one task.",
          status: "inprogress",
          priority: "critical",
          tags: ["ingestion", "epic"],
        }),
      }).then((r) => r.json());
      expect(parentTask.ok).toBe(true);

      const propose = await postDedicatedDecompose(port, "propose", { taskId: parentTask.data.id });

      expect(propose.ok).toBe(true);
      expect(propose.proposal.recommendedAction).toBe("split_task");
      expect(propose.proposal.subtasks).toHaveLength(3);
      expect(propose.proposal.queuePlan?.counts?.stepCount).toBe(3);
      expect(propose.proposal.queuePlan?.steps?.[1]?.dependsOnStepIds).toEqual(["step-1"]);
      expect(propose.proposal.queuePlan?.steps?.[2]?.dependsOnStepIds).toEqual(["step-2"]);
      expect(propose.task.meta?.replanProposal?.status).toBe("proposed");
      expect(propose.task.meta?.plannerState?.latestReplan?.status).toBe("proposed");
      expect(propose.task.meta?.replanProposal?.summary).toContain("Decompose the ingestion epic");
      expect(execPrimaryPrompt).toHaveBeenCalledTimes(1);

      const taskStore = await import("../task/task-store.mjs");
      const persistedBeforeApply = taskStore.getTask(parentTask.data.id);
      expect(persistedBeforeApply?.meta?.replanProposal?.status).toBe("proposed");
      expect(persistedBeforeApply?.meta?.replanProposal?.subtasks).toHaveLength(3);

      const apply = await postDedicatedDecompose(port, "apply", { taskId: parentTask.data.id });

      expect(apply.ok).toBe(true);
      expect(Array.isArray(apply.createdSubtasks)).toBe(true);
      expect(apply.createdSubtasks).toHaveLength(3);
      expect(apply.queuePlan?.counts?.createdTaskCount).toBe(3);
      expect(apply.taskGraph?.taskCount).toBe(3);
      expect(apply.task.status).toBe("blocked");
      expect(apply.task.meta?.replanProposal?.status).toBe("applied");
      expect(apply.task.meta?.plannerState?.latestReplan?.createdTaskIds).toEqual(
        expect.arrayContaining(apply.createdSubtasks.map((entry) => entry.id)),
      );
      for (const subtask of apply.createdSubtasks) {
        expect(subtask.parentTaskId || subtask?.meta?.parentTaskId).toBe(parentTask.data.id);
        expect(subtask.meta?.replan?.proposalId).toBe(apply.proposal.proposalId);
        expect(subtask.meta?.replan?.parentTaskId).toBe(parentTask.data.id);
      }
      const persistedAfterApply = taskStore.getTask(parentTask.data.id);
      expect(persistedAfterApply?.meta?.replanProposal?.status).toBe("applied");
      expect(persistedAfterApply?.meta?.plannerState?.latestReplan?.subtaskCount).toBe(3);
      expect(persistedAfterApply?.meta?.replanProposal?.queuePlan?.counts?.createdTaskCount).toBe(3);

      const listedChildren = await fetch(
        "http://127.0.0.1:" + port + "/api/tasks/subtasks?parentTaskId=" + encodeURIComponent(parentTask.data.id),
      ).then((r) => r.json());
      expect(listedChildren.ok).toBe(true);
      expect(Array.isArray(listedChildren.data)).toBe(true);
      expect(listedChildren.data.map((entry) => entry.id)).toEqual(
        expect.arrayContaining(apply.createdSubtasks.map((entry) => entry.id)),
      );
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
      await settleUiRuntimeCleanup();
    }
  }, 90000);

  it("organizes task DAGs and returns dependency suggestions", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const mod = await import("../server/ui-server.mjs");
    const organizeTaskDag = vi.fn(async () => ({
      orderedSprintIds: ["sprint-b", "sprint-a"],
      orderedTaskIdsBySprint: { "sprint-b": ["task-1", "task-2"] },
      updatedSprintCount: 1,
      updatedTaskCount: 2,
      appliedDependencySuggestionCount: 1,
      syncedEpicDependencyCount: 1,
      suggestions: [
        {
          type: "missing_sequential_dependency",
          sprintId: "sprint-b",
          taskId: "task-2",
          dependencyTaskId: "task-1",
          message: "Add dependency task-1 -> task-2 to encode sequential sprint order.",
        },
      ],
    }));
    mod.injectUiDependencies({
      taskStoreApi: {
        organizeTaskDag,
      },
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const response = await fetch(`http://127.0.0.1:${port}/api/tasks/dag/organize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sprintId: "sprint-b", applyDependencySuggestions: true, syncEpicDependencies: true }),
    });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.sprintId).toBe("sprint-b");
    expect(Array.isArray(json.suggestions)).toBe(true);
    expect(json.suggestions[0].type).toBe("missing_sequential_dependency");
    expect(json.data.updatedSprintCount).toBe(1);
    expect(json.data.appliedDependencySuggestionCount).toBe(1);
    expect(json.data.syncedEpicDependencyCount).toBe(1);
    expect(organizeTaskDag).toHaveBeenCalledWith({
      sprintId: "sprint-b",
      applyDependencySuggestions: true,
      syncEpicDependencies: true,
    });
  }, 15000);

  it("focuses agent log tails on session-specific lines", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const logDir = join(process.cwd(), "logs", "agents");
    mkdirSync(logDir, { recursive: true });
    const query = `ve-log-focus-${Date.now()}`;
    const logPath = join(logDir, `agent-${query}.log`);
    writeFileSync(
      logPath,
      [
        "[2026-03-08T12:38:40.000Z] [info] monitor: unrelated health check",
        `[2026-03-08T12:38:41.000Z] [info] task-executor: Task ${query} moved to review`,
        `[2026-03-08T12:38:42.000Z] [error] review-agent: [${query}] failed due to policy check`,
        "[2026-03-08T12:38:43.000Z] [info] monitor: another unrelated line",
      ].join("\n"),
      "utf8",
    );

    try {
      const payload = await fetch(
        `http://127.0.0.1:${port}/api/agent-logs/tail?query=${encodeURIComponent(query)}&lines=6`,
      ).then((r) => r.json());

      expect(payload.ok).toBe(true);
      expect(payload.data?.file).toBe(`agent-${query}.log`);
      expect(payload.data?.mode).toBe("focused");
      expect(payload.data?.content || "").toContain(query);
      expect(payload.data?.content || "").toContain("failed due to policy check");
    } finally {
      rmSync(logPath, { force: true });
    }
  }, 15000);

  it("merges bounded system log tails across monitor, error, and daemon logs", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    const logDir = join(process.cwd(), "logs");
    mkdirSync(logDir, { recursive: true });
    const logNames = [
      ...new Set([
        ...readdirSync(logDir).filter((name) => name.endsWith(".log")),
        "monitor.log",
        "monitor-error.log",
        "daemon.log",
      ]),
    ];
    const backup = new Map(
      logNames.map((name) => {
        const filePath = join(logDir, name);
        return [name, existsSync(filePath) ? readFileSync(filePath, "utf8") : null];
      }),
    );

    const fixtures = {
      "daemon.log": [
        "2026-03-04T04:08:15.429Z [INFO] [daemon] bootstrap",
        "2026-03-04T04:08:15.442Z [INFO] [daemon] heartbeat",
      ].join("\n") + "\n",
      "monitor.log": [
        "2026-03-04T04:08:15.430Z [INFO] [kanban] using jira backend",
        "2026-03-04T04:08:15.434Z [INFO] [task-store] no store file found",
      ].join("\n") + "\n",
      "monitor-error.log": [
        "2026-03-04T04:08:15.431Z [WARN] [kanban] switched to jira backend",
        "2026-03-04T04:08:15.440Z [ERROR] [task-store] removed task",
      ].join("\n") + "\n",
    };

    try {
      for (const name of logNames) {
        rmSync(join(logDir, name), { force: true });
      }
      for (const [name, content] of Object.entries(fixtures)) {
        writeFileSync(join(logDir, name), content, "utf8");
      }

      const payload = await fetch(`http://127.0.0.1:${port}/api/logs?lines=6`).then((r) => r.json());

      expect(payload.ok).toBe(true);
      expect(payload.data?.files).toEqual(["monitor.log", "monitor-error.log", "daemon.log"]);
      expect(payload.data?.lines).toEqual([
        "2026-03-04T04:08:15.429Z [INFO] [daemon] bootstrap",
        "2026-03-04T04:08:15.430Z [INFO] [kanban] using jira backend",
        "2026-03-04T04:08:15.431Z [WARN] [kanban] switched to jira backend",
        "2026-03-04T04:08:15.434Z [INFO] [task-store] no store file found",
        "2026-03-04T04:08:15.440Z [ERROR] [task-store] removed task",
        "2026-03-04T04:08:15.442Z [INFO] [daemon] heartbeat",
      ]);
      expect(payload.data?.truncated).toBe(false);
    } finally {
      for (const [name, content] of backup.entries()) {
        const filePath = join(logDir, name);
        if (content == null) rmSync(filePath, { force: true });
        else writeFileSync(filePath, content, "utf8");
      }
    }
  }, 15000);

  it("falls back to session workspaceDir for diff view", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const previousRepoRoot = process.env.REPO_ROOT;
    delete process.env.REPO_ROOT;

    const repoDir = mkdtempSync(join(tmpdir(), "bosun-session-diff-"));
    const filePath = join(repoDir, "notes.txt");
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: repoDir, stdio: "pipe", env: sanitizedGitEnv() });
    execSync("git config user.email bosun@example.com", { cwd: repoDir, stdio: "pipe", env: sanitizedGitEnv() });
    execSync("git config user.name Bosun", { cwd: repoDir, stdio: "pipe", env: sanitizedGitEnv() });
    writeFileSync(filePath, "line one\n", "utf8");
    execSync("git add notes.txt", { cwd: repoDir, stdio: "pipe", env: sanitizedGitEnv() });
    execSync('git commit -m "init"', { cwd: repoDir, stdio: "pipe", env: sanitizedGitEnv() });
    writeFileSync(filePath, "line one\nline two\n", "utf8");

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    try {
      const created = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "task",
          workspaceDir: repoDir,
          prompt: "diff fallback regression",
        }),
      }).then((r) => r.json());

      expect(created.ok).toBe(true);
      const sessionId = created.session?.id;
      expect(sessionId).toBeTruthy();

      const diffPayload = await fetch(
        `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/diff?workspace=all`,
      ).then((r) => r.json());
      expect(diffPayload?.ok).toBe(true);
      expect(diffPayload?.diff?.totalFiles).toBeGreaterThan(0);
      expect(Array.isArray(diffPayload?.diff?.files)).toBe(true);
    } finally {
      if (previousRepoRoot === undefined) delete process.env.REPO_ROOT;
      else process.env.REPO_ROOT = previousRepoRoot;
      rmSync(repoDir, { recursive: true, force: true });
    }
  }, 20000);

  it("serves persisted historic session detail and diff payloads", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const previousRepoRoot = process.env.REPO_ROOT;
    delete process.env.REPO_ROOT;

    const repoDir = mkdtempSync(join(tmpdir(), "bosun-persisted-session-diff-"));
    const persistDir = mkdtempSync(join(tmpdir(), "bosun-session-history-"));
    const filePath = join(repoDir, "notes.txt");
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: repoDir, stdio: "pipe", env: sanitizedGitEnv() });
    execSync("git config user.email bosun@example.com", { cwd: repoDir, stdio: "pipe", env: sanitizedGitEnv() });
    execSync("git config user.name Bosun", { cwd: repoDir, stdio: "pipe", env: sanitizedGitEnv() });
    writeFileSync(filePath, "line one\n", "utf8");
    execSync("git add notes.txt", { cwd: repoDir, stdio: "pipe", env: sanitizedGitEnv() });
    execSync('git commit -m "init"', { cwd: repoDir, stdio: "pipe", env: sanitizedGitEnv() });
    writeFileSync(filePath, "line one\nline two\n", "utf8");

    const trackerMod = await import("../infra/session-tracker.mjs");
    trackerMod._resetSingleton({ persistDir });
    const tracker = trackerMod.getSessionTracker();
    tracker.startSession("TASK-201", "Historic Task 201");
    const liveSession = tracker.getSession("TASK-201");
    liveSession.metadata.workspaceDir = repoDir;
    liveSession.metadata.branch = "main";
    tracker.recordEvent("TASK-201", {
      role: "user",
      content: "Inspect persisted history",
      timestamp: "2026-03-28T14:00:00.000Z",
    });
    tracker.recordEvent("TASK-201", {
      role: "assistant",
      content: "Persisted history ready",
      timestamp: "2026-03-28T14:00:03.000Z",
    });
    tracker.endSession("TASK-201", "completed");

    trackerMod._resetSingleton({ persistDir });

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    try {
      const detailPayload = await fetch(
        `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent("TASK-201")}?workspace=all&full=1`,
      ).then((r) => r.json());
      expect(detailPayload?.ok).toBe(true);
      expect(detailPayload?.session).toEqual(expect.objectContaining({
        id: "TASK-201",
        status: "completed",
      }));

      const diffPayload = await fetch(
        `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent("TASK-201")}/diff?workspace=all`,
      ).then((r) => r.json());
      expect(diffPayload?.ok).toBe(true);
      expect(diffPayload?.diff?.totalFiles).toBeGreaterThan(0);
      expect(diffPayload?.source).toMatchObject({
        kind: "session",
        detail: repoDir,
      });

      const taskDiffPayload = await fetch(`http://127.0.0.1:${port}/api/tasks/diff`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          task: {
            id: "TASK-201",
            title: "Historic Task 201",
            sessionId: "TASK-201",
          },
        }),
      }).then((r) => r.json());
      expect(taskDiffPayload?.ok).toBe(true);
      expect(taskDiffPayload?.diff?.totalFiles).toBeGreaterThan(0);
      expect(taskDiffPayload?.source).toMatchObject({
        kind: "worktree",
        detail: repoDir,
      });
    } finally {
      trackerMod._resetSingleton({ persistDir: null });
      if (previousRepoRoot === undefined) delete process.env.REPO_ROOT;
      else process.env.REPO_ROOT = previousRepoRoot;
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(persistDir, { recursive: true, force: true });
      await new Promise((resolve) => server.close(resolve));
    }
  }, 15000);

  it("exposes codex desktop style session surface metadata for multi-repo workspaces", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-session-surface-"));
    const configPath = join(tmpDir, "bosun.config.json");
    const workspaceRoot = join(tmpDir, "workspaces", "surface-ws");
    const repoPrimary = join(workspaceRoot, "repo-alpha");
    const repoSelected = join(workspaceRoot, "repo-beta");
    mkdirSync(repoPrimary, { recursive: true });
    mkdirSync(repoSelected, { recursive: true });
    const previousConfigPath = process.env.BOSUN_CONFIG_PATH;

    const { execSync } = await import("node:child_process");
    const initRepo = (repoDir, branchName) => {
      execSync("git init", { cwd: repoDir, stdio: "pipe", env: sanitizedGitEnv() });
      execSync("git config user.email bosun@example.com", { cwd: repoDir, stdio: "pipe", env: sanitizedGitEnv() });
      execSync("git config user.name Bosun", { cwd: repoDir, stdio: "pipe", env: sanitizedGitEnv() });
      writeFileSync(join(repoDir, "notes.txt"), `init ${branchName}\n`, "utf8");
      execSync("git add notes.txt", { cwd: repoDir, stdio: "pipe", env: sanitizedGitEnv() });
      execSync('git commit -m "init"', { cwd: repoDir, stdio: "pipe", env: sanitizedGitEnv() });
      execSync("git branch -m main", { cwd: repoDir, stdio: "pipe", env: sanitizedGitEnv() });
      execSync(`git checkout -b ${branchName}`, { cwd: repoDir, stdio: "pipe", env: sanitizedGitEnv() });
    };
    initRepo(repoPrimary, "feature/repo-alpha");
    initRepo(repoSelected, "feature/session-surface");

    process.env.BOSUN_CONFIG_PATH = configPath;
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          $schema: "./bosun.schema.json",
          activeWorkspace: "surface-ws",
          workspaces: [
            {
              id: "surface-ws",
              name: "Surface Workspace",
              path: workspaceRoot,
              activeRepo: "repo-beta",
              repos: [
                { name: "repo-alpha", primary: true },
                { name: "repo-beta", primary: false },
              ],
            },
          ],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const mod = await import("../server/ui-server.mjs");
    const trackerMod = await import("../infra/session-tracker.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    try {
      const createJson = await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "primary",
          workspaceId: "surface-ws",
          selectedRepoPath: repoSelected,
          executionTarget: "connect_codex_web",
          permissionMode: "full_access",
          branch: "feature/session-surface",
          prompt: "session surface contract",
        }),
      }).then((response) => response.json());

      expect(createJson.ok).toBe(true);
      const sessionId = createJson.session?.id;
      expect(sessionId).toBeTruthy();

      const tracker = trackerMod.getSessionTracker();
      tracker.recordEvent(sessionId, {
        id: `${sessionId}-user-1`,
        role: "user",
        content: "Inspect session surface metadata",
        timestamp: "2026-04-04T11:00:00.000Z",
        turnIndex: 0,
      });
      tracker.recordEvent(sessionId, {
        id: `${sessionId}-assistant-1`,
        role: "assistant",
        content: "Surface metadata prepared",
        timestamp: "2026-04-04T11:00:02.000Z",
        turnIndex: 0,
        meta: {
          usage: {
            inputTokens: 210,
            outputTokens: 90,
            totalTokens: 300,
            cacheInputTokens: 45,
          },
        },
      });
      tracker.updateSessionMetadata(sessionId, (currentMetadata = {}) => ({
        ...currentMetadata,
        branch: "feature/session-surface",
        turnDiffs: {
          [`${encodeURIComponent(sessionId)}:turn:0`]: {
            turnId: `${encodeURIComponent(sessionId)}:turn:0`,
            turnIndex: 0,
            capturedAt: "2026-04-04T11:00:03.000Z",
            diff: {
              files: [
                {
                  filename: "src/session-surface.mjs",
                  status: "modified",
                  additions: 12,
                  deletions: 3,
                  patch: "@@ -1 +1 @@\n-old\n+new\n",
                  hunks: [{ header: "@@ -1 +1 @@", lines: [] }],
                },
              ],
              totalFiles: 1,
              totalAdditions: 12,
              totalDeletions: 3,
              formatted: "1 file changed, 12 insertions(+), 3 deletions(-)",
              sourceRange: "origin/main...feature/session-surface",
            },
            source: {
              kind: "turn",
              label: "origin/main...feature/session-surface",
              detail: repoSelected,
            },
          },
        },
      }));
      tracker.endSession(sessionId, "completed");
      const liveSession = tracker.getSessionById(sessionId);
      liveSession.insights = {
        ...(liveSession.insights && typeof liveSession.insights === "object" ? liveSession.insights : {}),
        contextWindow: {
          usedTokens: 41000,
          totalTokens: 380000,
          percent: 11,
          reservedForResponseTokens: 32000,
        },
        contextBreakdown: [
          { label: "System Instructions", percent: 14 },
          { label: "Tool Definitions", percent: 18 },
          { label: "Messages", percent: 42 },
          { label: "Tool Results", percent: 17 },
          { label: "Other", percent: 9 },
        ],
      };

      const listJson = await fetch(`http://127.0.0.1:${port}/api/sessions?workspace=all`).then((response) => response.json());
      const listed = listJson.sessions.find((entry) => entry.id === sessionId);
      expect(listed?.surface?.repository?.selected).toEqual(expect.objectContaining({
        path: repoSelected,
        name: "repo-beta",
      }));
      expect(listed?.surface?.repository?.available).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "repo-alpha", primary: true }),
        expect.objectContaining({ name: "repo-beta", selected: true }),
      ]));
      expect(listed?.surface?.permissionMode?.selected?.id).toBe("full_access");
      expect(listed?.surface?.executionTarget?.selected?.id).toBe("connect_codex_web");
      expect(listed?.surface?.phase).toEqual(expect.objectContaining({
        id: "planning",
        label: "Planning",
        tone: "info",
      }));

      const detailJson = await fetch(
        `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}?workspace=all&full=1`,
      ).then((response) => response.json());
      expect(detailJson.ok).toBe(true);
      expect(detailJson.session.surface.repository.available).toHaveLength(2);
      expect(detailJson.session.surface.branch.selected).toBe("feature/session-surface");
      expect(detailJson.session.surface.branch.repoPath).toBe(repoSelected);
      expect(detailJson.session.surface.phase).toEqual(expect.objectContaining({
        id: "planning",
        label: "Planning",
        promptRule: expect.stringContaining("plan-first"),
        toolRule: expect.stringContaining("discovery"),
      }));
      expect(detailJson.session.surface.tokenUsage).toEqual(expect.objectContaining({
        totalTokens: 300,
        inputTokens: 210,
        outputTokens: 90,
        cacheInputTokens: 45,
      }));
      expect(detailJson.session.surface.contextWindow).toEqual(expect.objectContaining({
        usedTokens: 41000,
        totalTokens: 380000,
        percent: 11,
        remainingTokens: 339000,
        reservedForResponseTokens: 32000,
      }));
      expect(detailJson.session.surface.contextBreakdown).toEqual(expect.arrayContaining([
        expect.objectContaining({ label: "System Instructions", percent: 14 }),
        expect.objectContaining({ label: "Messages", percent: 42 }),
      ]));
      expect(detailJson.session.surface.compaction).toEqual(expect.objectContaining({
        canCompact: true,
        state: "available",
      }));
      expect(detailJson.session.turns).toEqual([
        expect.objectContaining({
          id: `${encodeURIComponent(sessionId)}:turn:0`,
          turnIndex: 0,
          fileChanges: expect.objectContaining({
            totalFiles: 1,
            totalAdditions: 12,
            totalDeletions: 3,
            files: [
              expect.objectContaining({
                filename: "src/session-surface.mjs",
                status: "modified",
                hasPatch: true,
              }),
            ],
          }),
          diffRef: expect.objectContaining({
            turnId: `${encodeURIComponent(sessionId)}:turn:0`,
            turnIndex: 0,
          }),
        }),
      ]);

      const branchesJson = await fetch(
        `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/branches?workspace=all`,
      ).then((response) => response.json());
      expect(branchesJson.ok).toBe(true);
      expect(branchesJson.repository).toEqual(expect.objectContaining({
        path: repoSelected,
        name: "repo-beta",
      }));
      expect(branchesJson.branch.available).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "feature/session-surface", current: true }),
        expect.objectContaining({ name: "main" }),
      ]));

      const turnDiffJson = await fetch(
        `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/diff?workspace=all&turnId=${encodeURIComponent(`${encodeURIComponent(sessionId)}:turn:0`)}`,
      ).then((response) => response.json());
      expect(turnDiffJson.ok).toBe(true);
      expect(turnDiffJson.source).toEqual(expect.objectContaining({
        kind: "turn",
        turnId: `${encodeURIComponent(sessionId)}:turn:0`,
        turnIndex: 0,
      }));
      expect(turnDiffJson.diff).toEqual(expect.objectContaining({
        totalFiles: 1,
        totalAdditions: 12,
        totalDeletions: 3,
      }));
    } finally {
      if (previousConfigPath === undefined) delete process.env.BOSUN_CONFIG_PATH;
      else process.env.BOSUN_CONFIG_PATH = previousConfigPath;
      await new Promise((resolve) => server.close(resolve));
      await settleUiRuntimeCleanup();
      await removeDirWithRetries(tmpDir);
    }
  }, 20000);

  it("builds task diff payloads from a posted task snapshot and linked worktree path", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const previousRepoRoot = process.env.REPO_ROOT;
    delete process.env.REPO_ROOT;

    const repoDir = mkdtempSync(join(tmpdir(), "bosun-task-diff-"));
    const filePath = join(repoDir, "notes.txt");
    const { execSync } = await import("node:child_process");
    execSync("git init", { cwd: repoDir, stdio: "pipe", env: sanitizedGitEnv() });
    execSync("git config user.email bosun@example.com", { cwd: repoDir, stdio: "pipe", env: sanitizedGitEnv() });
    execSync("git config user.name Bosun", { cwd: repoDir, stdio: "pipe", env: sanitizedGitEnv() });
    writeFileSync(filePath, "line one\n", "utf8");
    execSync("git add notes.txt", { cwd: repoDir, stdio: "pipe", env: sanitizedGitEnv() });
    execSync('git commit -m "init"', { cwd: repoDir, stdio: "pipe", env: sanitizedGitEnv() });
    writeFileSync(filePath, "line one\nline two\n", "utf8");

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    try {
      const diffPayload = await fetch(`http://127.0.0.1:${port}/api/tasks/diff`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          task: {
            id: "task-diff-snapshot-1",
            title: "Task diff snapshot",
            worktreePath: repoDir,
          },
        }),
      }).then((r) => r.json());

      expect(diffPayload?.ok).toBe(true);
      expect(diffPayload?.diff?.totalFiles).toBeGreaterThan(0);
      expect(diffPayload?.source).toMatchObject({
        kind: "worktree",
        detail: repoDir,
      });
      expect(Array.isArray(diffPayload?.diff?.files)).toBe(true);
      expect(diffPayload?.diff?.files[0]?.filename).toBe("notes.txt");
    } finally {
      if (previousRepoRoot === undefined) delete process.env.REPO_ROOT;
      else process.env.REPO_ROOT = previousRepoRoot;
      rmSync(repoDir, { recursive: true, force: true });
    }
  }, 20000);

  it("reports live compaction telemetry breakdowns", async () => {
    const isolatedRepoRoot = mkdtempSync(join(tmpdir(), "bosun-ui-telemetry-"));
    const previousRepoRoot = process.env.REPO_ROOT;
    process.env.REPO_ROOT = isolatedRepoRoot;
    vi.resetModules();

    const logDir = join(isolatedRepoRoot, ".cache", "agent-work-logs");
    mkdirSync(logDir, { recursive: true });
    const shreddingPath = join(logDir, "shredding-stats.jsonl");
    const sessionAccumulatorPath = join(isolatedRepoRoot, ".cache", "session-accumulator.jsonl");
    const previousStats = existsSync(shreddingPath)
      ? readFileSync(shreddingPath, "utf8")
      : null;
    const previousSessions = existsSync(sessionAccumulatorPath)
      ? readFileSync(sessionAccumulatorPath, "utf8")
      : null;
    const now = new Date();
    const entries = [
      {
        timestamp: new Date(now.getTime() - 60_000).toISOString(),
        originalChars: 9000,
        compressedChars: 2200,
        savedChars: 6800,
        savedPct: 76,
        agentType: "codex-sdk",
        attemptId: "attempt-live-search",
        stage: "live_tool_compaction",
        sessionType: "voice-delegate",
        normalizedSessionType: "voice",
        decision: "compressed",
        compactionFamily: "search",
        commandFamily: "rg",
      },
      {
        timestamp: new Date(now.getTime() - 30_000).toISOString(),
        originalChars: 5000,
        compressedChars: 1800,
        savedChars: 3200,
        savedPct: 64,
        agentType: "copilot-sdk",
        attemptId: "attempt-live-git",
        stage: "live_tool_compaction",
        sessionType: "delegate",
        normalizedSessionType: "delegate",
        decision: "compressed",
        compactionFamily: "git",
        commandFamily: "git",
      },
      {
        timestamp: now.toISOString(),
        originalChars: 14000,
        compressedChars: 6000,
        savedChars: 8000,
        savedPct: 57,
        agentType: "claude-sdk",
        attemptId: "attempt-session-total",
        stage: "session_total",
        sessionType: "task",
        normalizedSessionType: "task",
        decision: "compressed",
      },
      {
        timestamp: new Date(now.getTime() - 15_000).toISOString(),
        originalChars: 7000,
        compressedChars: 7000,
        savedChars: 0,
        savedPct: 0,
        agentType: "codex-sdk",
        attemptId: "attempt-below-threshold",
        stage: "session_skipped",
        sessionType: "voice-ask",
        normalizedSessionType: "voice",
        decision: "below_threshold",
      },
    ];
    writeFileSync(
      shreddingPath,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
    writeFileSync(
      sessionAccumulatorPath,
      `${[
        {
          type: "completed_session",
          sessionKey: "task-1:session-1",
          id: "session-1",
          taskId: "task-1",
          taskTitle: "Telemetry task 1",
          executor: "codex",
          startedAt: now.getTime() - 120_000,
          endedAt: now.getTime() - 60_000,
          durationMs: 60_000,
          tokenCount: 1000,
          inputTokens: 700,
          outputTokens: 300,
          costUsd: 0.5,
          recordedAt: new Date(now.getTime() - 60_000).toISOString(),
        },
        {
          type: "completed_session",
          sessionKey: "task-2:session-2",
          id: "session-2",
          taskId: "task-2",
          taskTitle: "Telemetry task 2",
          executor: "claude",
          startedAt: now.getTime() - 90_000,
          endedAt: now.getTime() - 30_000,
          durationMs: 60_000,
          tokenCount: 2000,
          inputTokens: 1400,
          outputTokens: 600,
          costUsd: 1.0,
          recordedAt: new Date(now.getTime() - 30_000).toISOString(),
        },
      ].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/telemetry/shredding?days=30`);
      const payload = await response.json();
      expect(payload.ok).toBe(true);
      expect(Number(payload.data?.stageCounts?.live_tool_compaction || 0)).toBeGreaterThanOrEqual(2);
      expect(Number(payload.data?.stageCounts?.session_total || 0)).toBeGreaterThanOrEqual(1);
      expect(Number(payload.data?.liveCompaction?.totalEvents || 0)).toBeGreaterThanOrEqual(2);
      expect(Number(payload.data?.liveCompaction?.totalSavedChars || 0)).toBeGreaterThanOrEqual(10000);
      expect(Number(payload.data?.liveCompaction?.avgSavedPct || 0)).toBeGreaterThanOrEqual(60);
      expect(Number(payload.data?.totals?.savedTokensEstimated || 0)).toBeGreaterThan(0);
      expect(Number(payload.data?.liveCompaction?.savedTokensEstimated || 0)).toBeGreaterThan(0);
      expect(Number(payload.data?.estimation?.blendedCostPerMillionTokensUsd || 0)).toBeGreaterThan(0);
      expect(Number(payload.data?.totals?.estimatedCostSavedUsd || 0)).toBeGreaterThan(0);
      expect(Number(payload.data?.dailyOriginal?.[now.toISOString().slice(0, 10)] || 0)).toBeGreaterThan(0);
      expect(Number(payload.data?.dailyCompressed?.[now.toISOString().slice(0, 10)] || 0)).toBeGreaterThan(0);
      expect(Number(payload.data?.dailySavedTokensEstimated?.[now.toISOString().slice(0, 10)] || 0)).toBeGreaterThan(0);
      expect(payload.data.topCompactionFamilies.some((entry) => entry.name === "search" && entry.count >= 1)).toBe(true);
      expect(payload.data.topCommandFamilies.some((entry) => entry.name === "git" && entry.count >= 1)).toBe(true);
      expect(Number(payload.data?.sessionTypeCounts?.["voice-delegate"] || 0)).toBeGreaterThanOrEqual(1);
      expect(Number(payload.data?.normalizedSessionTypeCounts?.voice || 0)).toBeGreaterThanOrEqual(2);
      expect(Number(payload.data?.decisionCounts?.compressed || 0)).toBeGreaterThanOrEqual(3);
      expect(payload.data.topSessionTypes.some((entry) => entry.name === "voice-delegate" && entry.normalizedSessionType === "voice")).toBe(true);
      expect(payload.data.recentEvents[0]).toHaveProperty("stage");
      expect(payload.data.recentEvents[0]).toHaveProperty("estimatedSavedTokens");
      expect(payload.data.recentEvents[0]).toHaveProperty("sessionType");
      expect(payload.data.recentEvents[0]).toHaveProperty("decision");
    } finally {
      await new Promise((resolveClose) => server.close(() => resolveClose()));
      resetStateLedgerCache();
      if (previousStats == null) rmSync(shreddingPath, { force: true });
      else writeFileSync(shreddingPath, previousStats, "utf8");
      if (previousSessions == null) rmSync(sessionAccumulatorPath, { force: true });
      else writeFileSync(sessionAccumulatorPath, previousSessions, "utf8");
      if (previousRepoRoot === undefined) delete process.env.REPO_ROOT;
      else process.env.REPO_ROOT = previousRepoRoot;
      rmSync(isolatedRepoRoot, { recursive: true, force: true });
    }
  }, process.platform === "win32" ? 30000 : 15000);

  it("includes split token counts in session list payloads", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const mod = await import("../server/ui-server.mjs");
    const { _resetSingleton, getSessionTracker } = await import("../infra/session-tracker.mjs");
    _resetSingleton({ persistDir: null });
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;
    const tracker = getSessionTracker();
    tracker.createSession({
      id: "tokens-visible-session",
      type: "primary",
      metadata: { title: "Tokens Visible Session" },
    });
    tracker.appendEvent("tokens-visible-session", {
      role: "assistant",
      content: "Done",
      meta: {
        tokenUsage: {
          totalTokens: 2000,
          inputTokens: 1200,
          outputTokens: 800,
        },
      },
    });

    const listRes = await fetch(`http://127.0.0.1:${port}/api/sessions?includeHidden=1`);
    const listJson = await listRes.json();
    expect(listRes.status).toBe(200);
    expect(listJson.ok).toBe(true);
    const session = listJson.sessions.find((entry) => entry.id === "tokens-visible-session");
    expect(session).toBeTruthy();
    expect(session.totalTokens).toBe(2000);
    expect(session.inputTokens).toBe(1200);
    expect(session.outputTokens).toBe(800);
  }, 15000);

  it("sources agent-run analytics from completed session history when session-start events are stale", async () => {
    const isolatedRepoRoot = mkdtempSync(join(tmpdir(), "bosun-ui-usage-"));
    const previousRepoRoot = process.env.REPO_ROOT;
    process.env.REPO_ROOT = isolatedRepoRoot;
    vi.resetModules();

    const logDir = join(isolatedRepoRoot, ".cache", "agent-work-logs");
    mkdirSync(logDir, { recursive: true });
    const streamPath = join(logDir, "agent-work-stream.jsonl");
    const sessionAccumulatorPath = join(isolatedRepoRoot, ".cache", "session-accumulator.jsonl");
    const previousStream = existsSync(streamPath)
      ? readFileSync(streamPath, "utf8")
      : null;
    const previousSessions = existsSync(sessionAccumulatorPath)
      ? readFileSync(sessionAccumulatorPath, "utf8")
      : null;
    const now = new Date();
    writeFileSync(
      streamPath,
      `${[
        {
          timestamp: new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000).toISOString(),
          event_type: "session_start",
          executor: "outdated-executor",
        },
        {
          timestamp: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
          event_type: "skill_invoke",
          data: { skill_name: "critical-path" },
        },
        {
          timestamp: new Date(now.getTime() - 4 * 60 * 1000).toISOString(),
          event_type: "tool_call",
          data: { tool_name: "context7.get-library-docs" },
        },
      ].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
    writeFileSync(
      sessionAccumulatorPath,
      `${[
        {
          type: "completed_session",
          sessionKey: "task-a:session-a",
          id: "session-a",
          taskId: "task-a",
          taskTitle: "Recent agent run A",
          executor: "codex",
          startedAt: now.getTime() - 8 * 60 * 1000,
          endedAt: now.getTime() - 7 * 60 * 1000,
          durationMs: 60_000,
          tokenCount: 1200,
          inputTokens: 800,
          outputTokens: 400,
          costUsd: 0.6,
          recordedAt: new Date(now.getTime() - 7 * 60 * 1000).toISOString(),
        },
        {
          type: "completed_session",
          sessionKey: "task-b:session-b",
          id: "session-b",
          taskId: "task-b",
          taskTitle: "Recent agent run B",
          executor: "claude",
          startedAt: now.getTime() - 6 * 60 * 1000,
          endedAt: now.getTime() - 5 * 60 * 1000,
          durationMs: 60_000,
          tokenCount: 1500,
          inputTokens: 900,
          outputTokens: 600,
          costUsd: 0.75,
          recordedAt: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
        },
      ].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/analytics/usage?days=30`);
      const payload = await response.json();
      expect(payload.ok).toBe(true);
      expect(payload.data?.agentRuns).toBe(2);
      expect(payload.data?.skillInvocations).toBe(1);
      expect(payload.data?.mcpToolCalls).toBe(1);
      expect(payload.data?.diagnostics?.agentRunSource).toBe("completed_sessions");
      expect(payload.data?.diagnostics?.completedSessions).toBe(2);
      expect(payload.data?.diagnostics?.sessionStarts).toBe(0);
      expect(payload.data?.totalInputTokens).toBe(1700);
      expect(payload.data?.totalOutputTokens).toBe(1000);
      expect(payload.data?.trend?.inputTokens).toEqual([1700]);
      expect(payload.data?.trend?.outputTokens).toEqual([1000]);
      expect(payload.data?.topAgents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "codex", count: 1 }),
          expect.objectContaining({ name: "claude", count: 1 }),
        ]),
      );
    } finally {
      if (previousStream == null) rmSync(streamPath, { force: true });
      else writeFileSync(streamPath, previousStream, "utf8");
      if (previousSessions == null) rmSync(sessionAccumulatorPath, { force: true });
      else writeFileSync(sessionAccumulatorPath, previousSessions, "utf8");
      if (previousRepoRoot === undefined) delete process.env.REPO_ROOT;
      else process.env.REPO_ROOT = previousRepoRoot;
      rmSync(isolatedRepoRoot, { recursive: true, force: true });
    }
  });

  it("lists replayable agent runs with short step summaries", async () => {
    const isolatedRepoRoot = mkdtempSync(join(tmpdir(), "bosun-ui-runs-"));
    const previousRepoRoot = process.env.REPO_ROOT;
    process.env.REPO_ROOT = isolatedRepoRoot;
    vi.resetModules();

    const sessionsDir = join(isolatedRepoRoot, ".cache", "agent-work-logs", "agent-sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const attemptId = "attempt-replay-1";
    const now = new Date();
    writeFileSync(
      join(sessionsDir, `${attemptId}.jsonl`),
      `${[
        {
          timestamp: new Date(now.getTime() - 60_000).toISOString(),
          attempt_id: attemptId,
          event_type: "session_start",
          taskId: "task-123",
          task_title: "Replayable task",
          executor: "codex",
        },
        {
          timestamp: new Date(now.getTime() - 50_000).toISOString(),
          attempt_id: attemptId,
          event_type: "tool_call",
          taskId: "task-123",
          task_title: "Replayable task",
          executor: "codex",
          data: { tool_name: "web.search" },
        },
        {
          timestamp: new Date(now.getTime() - 40_000).toISOString(),
          attempt_id: attemptId,
          event_type: "usage",
          taskId: "task-123",
          task_title: "Replayable task",
          executor: "codex",
          data: {
            usage: { input_tokens: 120, output_tokens: 45, total_tokens: 165 },
            duration_ms: 3200,
          },
        },
        {
          timestamp: new Date(now.getTime() - 35_000).toISOString(),
          attempt_id: attemptId,
          event_type: "tool_result",
          taskId: "task-123",
          task_title: "Replayable task",
          executor: "codex",
          data: { tool_name: "web.search", status: "completed" },
        },
        {
          timestamp: new Date(now.getTime() - 30_000).toISOString(),
          attempt_id: attemptId,
          event_type: "session_end",
          taskId: "task-123",
          task_title: "Replayable task",
          executor: "codex",
          data: { completion_status: "failed" },
        },
      ].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/agent-runs?limit=10`);
      const payload = await response.json();
      expect(payload.ok).toBe(true);
      expect(Array.isArray(payload.data)).toBe(true);
      expect(payload.data[0]).toEqual(expect.objectContaining({
        attemptId,
        taskId: "task-123",
        taskTitle: "Replayable task",
        executor: "codex",
        status: "failed",
        eventCount: 5,
      }));
      expect(payload.data[0].totals.usageEvents).toBe(1);
      expect(payload.data[0].shortSteps).toEqual(expect.arrayContaining([
        expect.stringContaining("Started codex run"),
        expect.stringContaining("Called web.search"),
        expect.stringContaining("web.search returned completed"),
        expect.stringContaining("Finished run with status failed"),
      ]));
    } finally {
      await new Promise((resolveClose) => server.close(() => resolveClose()));
      resetStateLedgerCache();
      if (previousRepoRoot === undefined) delete process.env.REPO_ROOT;
      else process.env.REPO_ROOT = previousRepoRoot;
      rmSync(isolatedRepoRoot, { recursive: true, force: true });
    }
  });

  it("returns session turn timeline details including final turn counts", async () => {
    const trackerMod = await import("../infra/session-tracker.mjs");
    const tracker = trackerMod.getSessionTracker();
    const mod = await import("../server/ui-server.mjs");
    tracker.startSession("task-turn-api", "Turn API task", { type: "task" });
    tracker.recordEvent("task-turn-api", {
      role: "user",
      content: "Inspect files",
      timestamp: "2026-03-27T13:00:00.000Z",
    });
    tracker.recordEvent("task-turn-api", {
      role: "assistant",
      content: "Inspected files",
      timestamp: "2026-03-27T13:00:03.000Z",
      meta: { usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 } },
    });
    tracker.endSession("task-turn-api", "completed");

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    try {
      const listRes = await fetch(`http://127.0.0.1:${port}/api/sessions?workspace=all`);
      const listJson = await listRes.json();
      expect(listRes.status).toBe(200);
      const listed = listJson.sessions.find((session) => session.id === "task-turn-api");
      expect(listed).toEqual(expect.objectContaining({
        id: "task-turn-api",
        turnCount: 1,
        status: "completed",
      }));
      expect(listed.turns).toEqual([
        expect.objectContaining({ turnIndex: 0, durationMs: 3000, totalTokens: 75, status: "completed" }),
      ]);

      const detailRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent("task-turn-api")}?workspace=all&full=1`);
      const detailJson = await detailRes.json();
      expect(detailRes.status).toBe(200);
      expect(detailJson.session).toEqual(expect.objectContaining({
        id: "task-turn-api",
        turnCount: 1,
        status: "completed",
      }));
      expect(detailJson.session.turns).toEqual([
        expect.objectContaining({ turnIndex: 0, durationMs: 3000, totalTokens: 75, status: "completed" }),
      ]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, 15000);

  it("merges ledger-backed sessions into session list and detail fallbacks", async () => {
    const isolatedRepoRoot = mkdtempSync(join(tmpdir(), "bosun-ui-ledger-session-"));
    const workspaceDir = join(isolatedRepoRoot, "workspaces", "workspace-ledger", "repo");
    const previousRepoRoot = process.env.REPO_ROOT;
    process.env.REPO_ROOT = isolatedRepoRoot;
    vi.resetModules();
    mkdirSync(join(workspaceDir, ".git"), { recursive: true });

    upsertSessionRecordToStateLedger({
      sessionId: "ledger-session-1",
      type: "manual",
      workspaceId: "workspace-ledger",
      taskId: "ledger-task-1",
      taskTitle: "Ledger only session",
      status: "completed",
      latestEventType: "assistant",
      updatedAt: "2026-03-31T09:15:00.000Z",
      startedAt: "2026-03-31T09:00:00.000Z",
      eventCount: 2,
      preview: "Stored directly in SQLite",
      document: {
        id: "ledger-session-1",
        taskId: "ledger-task-1",
        taskTitle: "Ledger only session",
        type: "manual",
        status: "completed",
        lifecycleStatus: "completed",
        workspaceId: "workspace-ledger",
        workspaceDir,
        workspaceRoot: workspaceDir,
        createdAt: "2026-03-31T09:00:00.000Z",
        lastActiveAt: "2026-03-31T09:15:00.000Z",
        totalEvents: 2,
        turnCount: 1,
        messages: [
          { role: "assistant", content: "Stored directly in SQLite", timestamp: "2026-03-31T09:15:00.000Z" },
        ],
        metadata: {
          workspaceId: "workspace-ledger",
          workspaceDir,
          workspaceRoot: workspaceDir,
        },
      },
    }, { repoRoot: isolatedRepoRoot });

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    try {
      const listRes = await fetch(`http://127.0.0.1:${port}/api/sessions?workspace=all`);
      const listJson = await listRes.json();
      expect(listRes.status).toBe(200);
      const listed = listJson.sessions.find((entry) => entry.id === "ledger-session-1");
      expect(listJson.sessions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: "ledger-session-1",
          taskId: "ledger-task-1",
          title: "Ledger only session",
          status: "completed",
        }),
      ]));
      expect(Array.isArray(listed?.messages) ? listed.messages : []).toEqual([]);

      const detailRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent("ledger-session-1")}?workspace=all&full=1`);
      const detailJson = await detailRes.json();
      expect(detailRes.status).toBe(200);
      expect(detailJson.session).toEqual(expect.objectContaining({
        id: "ledger-session-1",
        taskId: "ledger-task-1",
        taskTitle: "Ledger only session",
        messages: [
          expect.objectContaining({ content: "Stored directly in SQLite" }),
        ],
      }));
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await settleUiRuntimeCleanup();
      if (previousRepoRoot === undefined) delete process.env.REPO_ROOT;
      else process.env.REPO_ROOT = previousRepoRoot;
      vi.resetModules();
      await removeDirWithRetries(isolatedRepoRoot);
    }
  });

  it("archives ledger-backed sessions durably and hides them from the default session list", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const isolatedRepoRoot = mkdtempSync(join(tmpdir(), "bosun-ui-ledger-archive-"));
    const workspaceDir = join(isolatedRepoRoot, "workspaces", "workspace-archive", "repo");
    const previousRepoRoot = process.env.REPO_ROOT;
    process.env.REPO_ROOT = isolatedRepoRoot;
    vi.resetModules();
    mkdirSync(join(workspaceDir, ".git"), { recursive: true });

    upsertSessionRecordToStateLedger({
      sessionId: "ledger-archive-1",
      type: "manual",
      workspaceId: "workspace-archive",
      taskId: "ledger-archive-task-1",
      taskTitle: "Archive me",
      status: "completed",
      latestEventType: "assistant",
      updatedAt: "2026-03-31T11:15:00.000Z",
      startedAt: "2026-03-31T11:00:00.000Z",
      eventCount: 2,
      document: {
        id: "ledger-archive-1",
        taskId: "ledger-archive-task-1",
        taskTitle: "Archive me",
        type: "manual",
        status: "completed",
        lifecycleStatus: "completed",
        workspaceId: "workspace-archive",
        workspaceDir,
        workspaceRoot: workspaceDir,
        createdAt: "2026-03-31T11:00:00.000Z",
        lastActiveAt: "2026-03-31T11:15:00.000Z",
        totalEvents: 2,
        turnCount: 1,
        messages: [
          { role: "assistant", content: "Archive this durable session", timestamp: "2026-03-31T11:15:00.000Z" },
        ],
        metadata: {
          workspaceId: "workspace-archive",
          workspaceDir,
          workspaceRoot: workspaceDir,
        },
      },
    }, { repoRoot: isolatedRepoRoot });

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    try {
      const archiveRes = await fetch(
        `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent("ledger-archive-1")}/archive?workspace=all`,
        { method: "POST" },
      );
      const archiveJson = await archiveRes.json();
      expect(archiveRes.status).toBe(200);
      expect(archiveJson).toEqual(expect.objectContaining({ ok: true }));

      const listRes = await fetch(`http://127.0.0.1:${port}/api/sessions?workspace=all`);
      const listJson = await listRes.json();
      expect(listRes.status).toBe(200);
      expect(listJson.sessions.some((entry) => entry.id === "ledger-archive-1")).toBe(false);

      const hiddenListRes = await fetch(`http://127.0.0.1:${port}/api/sessions?workspace=all&includeHidden=1`);
      const hiddenListJson = await hiddenListRes.json();
      expect(hiddenListRes.status).toBe(200);
      expect(hiddenListJson.sessions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: "ledger-archive-1",
          status: "archived",
          lifecycleStatus: "archived",
        }),
      ]));

      const detailRes = await fetch(
        `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent("ledger-archive-1")}?workspace=all&full=1`,
      );
      const detailJson = await detailRes.json();
      expect(detailRes.status).toBe(200);
      expect(detailJson.session).toEqual(expect.objectContaining({
        id: "ledger-archive-1",
        status: "archived",
        lifecycleStatus: "archived",
        messages: [
          expect.objectContaining({ content: "Archive this durable session" }),
        ],
      }));

      expect(getSessionActivityFromStateLedger("ledger-archive-1", { repoRoot: isolatedRepoRoot })).toEqual(
        expect.objectContaining({
          sessionId: "ledger-archive-1",
          latestStatus: "archived",
        }),
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await settleUiRuntimeCleanup();
      if (previousRepoRoot === undefined) delete process.env.REPO_ROOT;
      else process.env.REPO_ROOT = previousRepoRoot;
      vi.resetModules();
      await removeDirWithRetries(isolatedRepoRoot);
    }
  });

  it("reclassifies stale ledger-only active snapshots to terminal lifecycle state", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const isolatedRepoRoot = mkdtempSync(join(tmpdir(), "bosun-ui-ledger-stale-live-"));
    const workspaceDir = join(isolatedRepoRoot, "workspaces", "workspace-stale", "repo");
    const previousRepoRoot = process.env.REPO_ROOT;
    process.env.REPO_ROOT = isolatedRepoRoot;
    vi.resetModules();
    mkdirSync(join(workspaceDir, ".git"), { recursive: true });

    upsertSessionRecordToStateLedger({
      sessionId: "ledger-stale-active-1",
      type: "manual",
      workspaceId: "workspace-stale",
      taskId: "ledger-stale-task-1",
      taskTitle: "Stale active snapshot",
      status: "active",
      latestEventType: "assistant",
      updatedAt: "2026-03-31T10:05:00.000Z",
      startedAt: "2026-03-31T10:00:00.000Z",
      eventCount: 1,
      document: {
        id: "ledger-stale-active-1",
        taskId: "ledger-stale-task-1",
        taskTitle: "Stale active snapshot",
        type: "manual",
        status: "active",
        lifecycleStatus: "active",
        runtimeState: "running",
        runtimeIsLive: true,
        workspaceId: "workspace-stale",
        workspaceDir,
        workspaceRoot: workspaceDir,
        createdAt: "2026-03-31T10:00:00.000Z",
        lastActiveAt: "2026-03-31T10:05:00.000Z",
        totalEvents: 1,
        turnCount: 1,
        metadata: {
          workspaceId: "workspace-stale",
          workspaceDir,
          workspaceRoot: workspaceDir,
        },
      },
    }, { repoRoot: isolatedRepoRoot });

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    try {
      const detailRes = await fetch(
        `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent("ledger-stale-active-1")}?workspace=all&full=1`,
      );
      const detailJson = await detailRes.json();
      expect(detailRes.status).toBe(200);
      expect(detailJson.session).toEqual(expect.objectContaining({
        id: "ledger-stale-active-1",
        lifecycleStatus: "no_output",
        status: "no_output",
        runtimeState: "stopped",
        runtimeIsLive: false,
        endedAt: "2026-03-31T10:05:00.000Z",
      }));
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await settleUiRuntimeCleanup();
      if (previousRepoRoot === undefined) delete process.env.REPO_ROOT;
      else process.env.REPO_ROOT = previousRepoRoot;
      vi.resetModules();
      await removeDirWithRetries(isolatedRepoRoot);
    }
  });

  it("deletes ledger-backed sessions from durable listings and detail lookups", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const isolatedRepoRoot = mkdtempSync(join(tmpdir(), "bosun-ui-ledger-delete-"));
    const workspaceDir = join(isolatedRepoRoot, "workspaces", "workspace-delete", "repo");
    const previousRepoRoot = process.env.REPO_ROOT;
    process.env.REPO_ROOT = isolatedRepoRoot;
    vi.resetModules();
    mkdirSync(join(workspaceDir, ".git"), { recursive: true });

    upsertSessionRecordToStateLedger({
      sessionId: "ledger-delete-1",
      type: "manual",
      workspaceId: "workspace-delete",
      taskId: "ledger-delete-task-1",
      taskTitle: "Delete me",
      status: "completed",
      latestEventType: "assistant",
      updatedAt: "2026-03-31T12:15:00.000Z",
      startedAt: "2026-03-31T12:00:00.000Z",
      eventCount: 1,
      document: {
        id: "ledger-delete-1",
        taskId: "ledger-delete-task-1",
        taskTitle: "Delete me",
        type: "manual",
        status: "completed",
        lifecycleStatus: "completed",
        workspaceId: "workspace-delete",
        workspaceDir,
        workspaceRoot: workspaceDir,
        createdAt: "2026-03-31T12:00:00.000Z",
        lastActiveAt: "2026-03-31T12:15:00.000Z",
        totalEvents: 1,
        turnCount: 1,
        messages: [
          { role: "assistant", content: "Delete this durable session", timestamp: "2026-03-31T12:15:00.000Z" },
        ],
        metadata: {
          workspaceId: "workspace-delete",
          workspaceDir,
          workspaceRoot: workspaceDir,
        },
      },
    }, { repoRoot: isolatedRepoRoot });

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    try {
      const deleteRes = await fetch(
        `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent("ledger-delete-1")}/delete?workspace=all`,
        { method: "POST" },
      );
      const deleteJson = await deleteRes.json();
      expect(deleteRes.status).toBe(200);
      expect(deleteJson).toEqual(expect.objectContaining({ ok: true }));

      const listRes = await fetch(`http://127.0.0.1:${port}/api/sessions?workspace=all&includeHidden=1`);
      const listJson = await listRes.json();
      expect(listRes.status).toBe(200);
      expect(listJson.sessions.some((entry) => entry.id === "ledger-delete-1")).toBe(false);

      const detailRes = await fetch(
        `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent("ledger-delete-1")}?workspace=all&full=1`,
      );
      const detailJson = await detailRes.json();
      expect(detailRes.status).toBe(404);
      expect(detailJson).toEqual(expect.objectContaining({
        ok: false,
        error: "Session not found",
      }));

      expect(getSessionActivityFromStateLedger("ledger-delete-1", { repoRoot: isolatedRepoRoot })).toBeNull();
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await settleUiRuntimeCleanup();
      if (previousRepoRoot === undefined) delete process.env.REPO_ROOT;
      else process.env.REPO_ROOT = previousRepoRoot;
      vi.resetModules();
      await removeDirWithRetries(isolatedRepoRoot);
    }
  });

  it("prefers durable ledger metadata over stale tracker summaries for matching sessions", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const isolatedRepoRoot = mkdtempSync(join(tmpdir(), "bosun-ui-ledger-merge-"));
    const workspaceDir = join(isolatedRepoRoot, "workspaces", "workspace-merge", "repo");
    const previousRepoRoot = process.env.REPO_ROOT;
    process.env.REPO_ROOT = isolatedRepoRoot;
    vi.resetModules();
    mkdirSync(join(workspaceDir, ".git"), { recursive: true });

    upsertSessionRecordToStateLedger({
      sessionId: "shared-session-1",
      type: "manual",
      workspaceId: "workspace-merge",
      taskId: "ledger-task-merge",
      taskTitle: "Ledger canonical title",
      status: "completed",
      latestEventType: "assistant",
      updatedAt: "2026-03-31T10:15:00.000Z",
      startedAt: "2026-03-31T10:00:00.000Z",
      eventCount: 1,
      preview: "Canonical ledger session",
      document: {
        id: "shared-session-1",
        taskId: "ledger-task-merge",
        taskTitle: "Ledger canonical title",
        title: "Ledger canonical title",
        type: "manual",
        status: "completed",
        lifecycleStatus: "completed",
        workspaceId: "workspace-merge",
        workspaceDir,
        workspaceRoot: workspaceDir,
        createdAt: "2026-03-31T10:00:00.000Z",
        lastActiveAt: "2026-03-31T10:15:00.000Z",
        totalEvents: 1,
        messages: [
          { role: "assistant", content: "Canonical ledger session", timestamp: "2026-03-31T10:15:00.000Z" },
        ],
        metadata: {
          workspaceId: "workspace-merge",
          workspaceDir,
          workspaceRoot: workspaceDir,
        },
      },
    }, { repoRoot: isolatedRepoRoot });

    const trackerMod = await import("../infra/session-tracker.mjs");
    trackerMod._resetSingleton({ persistDir: null });
    const tracker = trackerMod.getSessionTracker();
    tracker.createSession({
      id: "shared-session-1",
      type: "manual",
      taskId: "tracker-task-merge",
      metadata: {
        title: "Tracker stale title",
      },
    });

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    try {
      const listRes = await fetch(`http://127.0.0.1:${port}/api/sessions?workspace=all`);
      const listJson = await listRes.json();
      expect(listRes.status).toBe(200);
      expect(listJson.ok).toBe(true);
      expect(listJson.sessions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: "shared-session-1",
          taskId: "ledger-task-merge",
          title: "Ledger canonical title",
          workspaceId: "workspace-merge",
        }),
      ]));

      const detailRes = await fetch(
        `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent("shared-session-1")}?workspace=all&full=1`,
      );
      const detailJson = await detailRes.json();
      expect(detailRes.status).toBe(200);
      expect(detailJson.session).toEqual(expect.objectContaining({
        id: "shared-session-1",
        taskId: "ledger-task-merge",
        title: "Ledger canonical title",
        workspaceId: "workspace-merge",
        messages: [
          expect.objectContaining({ content: "Canonical ledger session" }),
        ],
      }));
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await settleUiRuntimeCleanup();
      if (previousRepoRoot === undefined) delete process.env.REPO_ROOT;
      else process.env.REPO_ROOT = previousRepoRoot;
      vi.resetModules();
      await removeDirWithRetries(isolatedRepoRoot);
    }
  });

  it("filters ledger-only sessions to the active workspace using durable workspace metadata", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const isolatedRepoRoot = mkdtempSync(join(tmpdir(), "bosun-ui-ledger-workspace-"));
    const configDir = join(isolatedRepoRoot, ".bosun");
    const configPath = join(configDir, "bosun.config.json");
    const wsOneRepo = join(isolatedRepoRoot, "workspaces", "ws-one", "repo1");
    const wsTwoRepo = join(isolatedRepoRoot, "workspaces", "ws-two", "repo2");
    const previousRepoRoot = process.env.REPO_ROOT;
    const previousBosunConfigPath = process.env.BOSUN_CONFIG_PATH;
    const previousBosunHome = process.env.BOSUN_HOME;
    const previousBosunDir = process.env.BOSUN_DIR;
    const previousCodexMonitorHome = process.env.CODEX_MONITOR_HOME;
    const previousCodexMonitorDir = process.env.CODEX_MONITOR_DIR;
    const previousStateLedgerPath = process.env.BOSUN_STATE_LEDGER_PATH;
    process.env.REPO_ROOT = isolatedRepoRoot;
    process.env.BOSUN_CONFIG_PATH = configPath;
    process.env.BOSUN_HOME = configDir;
    process.env.BOSUN_DIR = configDir;
    process.env.CODEX_MONITOR_HOME = configDir;
    process.env.CODEX_MONITOR_DIR = configDir;
    process.env.BOSUN_STATE_LEDGER_PATH = join(configDir, ".cache", "state-ledger.sqlite");
    vi.resetModules();
    resetStateLedgerCache();

    mkdirSync(join(wsOneRepo, ".git"), { recursive: true });
    mkdirSync(join(wsTwoRepo, ".git"), { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          $schema: "./bosun.schema.json",
          activeWorkspace: "ws-one",
          workspaces: [
            {
              id: "ws-one",
              name: "Workspace One",
              activeRepo: "repo1",
              repos: [{ name: "repo1", url: wsOneRepo, primary: true }],
            },
            {
              id: "ws-two",
              name: "Workspace Two",
              activeRepo: "repo2",
              repos: [{ name: "repo2", url: wsTwoRepo, primary: true }],
            },
          ],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    upsertSessionRecordToStateLedger({
      sessionId: "ledger-ws-one",
      type: "manual",
      workspaceId: "ws-one",
      taskId: "ledger-task-ws-one",
      taskTitle: "Workspace One durable session",
      status: "completed",
      updatedAt: "2026-03-31T11:10:00.000Z",
      startedAt: "2026-03-31T11:00:00.000Z",
      eventCount: 1,
      document: {
        id: "ledger-ws-one",
        taskId: "ledger-task-ws-one",
        taskTitle: "Workspace One durable session",
        title: "Workspace One durable session",
        type: "manual",
        status: "completed",
        lifecycleStatus: "completed",
        workspaceId: "ws-one",
        workspaceDir: wsOneRepo,
        workspaceRoot: wsOneRepo,
        createdAt: "2026-03-31T11:00:00.000Z",
        lastActiveAt: "2026-03-31T11:10:00.000Z",
        metadata: {
          workspaceId: "ws-one",
          workspaceDir: wsOneRepo,
          workspaceRoot: wsOneRepo,
        },
      },
    }, { repoRoot: isolatedRepoRoot });

    upsertSessionRecordToStateLedger({
      sessionId: "ledger-ws-two",
      type: "manual",
      workspaceId: "ws-two",
      taskId: "ledger-task-ws-two",
      taskTitle: "Workspace Two durable session",
      status: "completed",
      updatedAt: "2026-03-31T11:20:00.000Z",
      startedAt: "2026-03-31T11:05:00.000Z",
      eventCount: 1,
      document: {
        id: "ledger-ws-two",
        taskId: "ledger-task-ws-two",
        taskTitle: "Workspace Two durable session",
        title: "Workspace Two durable session",
        type: "manual",
        status: "completed",
        lifecycleStatus: "completed",
        workspaceId: "ws-two",
        workspaceDir: wsTwoRepo,
        workspaceRoot: wsTwoRepo,
        createdAt: "2026-03-31T11:05:00.000Z",
        lastActiveAt: "2026-03-31T11:20:00.000Z",
        metadata: {
          workspaceId: "ws-two",
          workspaceDir: wsTwoRepo,
          workspaceRoot: wsTwoRepo,
        },
      },
    }, { repoRoot: isolatedRepoRoot });

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    try {
      const activeList = await fetch(
        `http://127.0.0.1:${port}/api/sessions?workspace=active&type=manual`,
      ).then((r) => r.json());
      expect(activeList.ok).toBe(true);
      expect(activeList.sessions).toHaveLength(1);
      expect(activeList.sessions[0]?.id).toBe("ledger-ws-one");

      const wrongWorkspaceDetail = await fetch(
        `http://127.0.0.1:${port}/api/sessions/${encodeURIComponent("ledger-ws-two")}?workspace=active&full=1`,
      );
      expect(wrongWorkspaceDetail.status).toBe(404);

      const allList = await fetch(
        `http://127.0.0.1:${port}/api/sessions?workspace=all&type=manual`,
      ).then((r) => r.json());
      expect(allList.ok).toBe(true);
      expect(allList.sessions.map((entry) => entry.id)).toEqual(
        expect.arrayContaining(["ledger-ws-one", "ledger-ws-two"]),
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await settleUiRuntimeCleanup();
      if (previousRepoRoot === undefined) delete process.env.REPO_ROOT;
      else process.env.REPO_ROOT = previousRepoRoot;
      if (previousBosunConfigPath === undefined) delete process.env.BOSUN_CONFIG_PATH;
      else process.env.BOSUN_CONFIG_PATH = previousBosunConfigPath;
      if (previousBosunHome === undefined) delete process.env.BOSUN_HOME;
      else process.env.BOSUN_HOME = previousBosunHome;
      if (previousBosunDir === undefined) delete process.env.BOSUN_DIR;
      else process.env.BOSUN_DIR = previousBosunDir;
      if (previousCodexMonitorHome === undefined) delete process.env.CODEX_MONITOR_HOME;
      else process.env.CODEX_MONITOR_HOME = previousCodexMonitorHome;
      if (previousCodexMonitorDir === undefined) delete process.env.CODEX_MONITOR_DIR;
      else process.env.CODEX_MONITOR_DIR = previousCodexMonitorDir;
      if (previousStateLedgerPath === undefined) delete process.env.BOSUN_STATE_LEDGER_PATH;
      else process.env.BOSUN_STATE_LEDGER_PATH = previousStateLedgerPath;
      vi.resetModules();
      await removeDirWithRetries(isolatedRepoRoot);
    }
  }, 15000);

  it("returns replayable trajectory details for a single agent run", async () => {
    const isolatedRepoRoot = mkdtempSync(join(tmpdir(), "bosun-ui-run-detail-"));
    const previousRepoRoot = process.env.REPO_ROOT;
    process.env.REPO_ROOT = isolatedRepoRoot;
    vi.resetModules();

    const sessionsDir = join(isolatedRepoRoot, ".cache", "agent-work-logs", "agent-sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const attemptId = "attempt-replay-detail";
    const now = new Date();
    writeFileSync(
      join(sessionsDir, `${attemptId}.jsonl`),
      `${[
        {
          timestamp: new Date(now.getTime() - 45_000).toISOString(),
          attempt_id: attemptId,
          event_type: "session_start",
          taskId: "task-456",
          task_title: "Replay detail task",
          executor: "claude",
        },
        {
          timestamp: new Date(now.getTime() - 30_000).toISOString(),
          attempt_id: attemptId,
          event_type: "usage",
          taskId: "task-456",
          task_title: "Replay detail task",
          executor: "claude",
          data: {
            usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 },
            duration_ms: 1800,
          },
        },
        {
          timestamp: new Date(now.getTime() - 20_000).toISOString(),
          attempt_id: attemptId,
          event_type: "agent_output",
          taskId: "task-456",
          task_title: "Replay detail task",
          executor: "claude",
          data: { output: "Investigated failure and prepared patch." },
        },
        {
          timestamp: new Date(now.getTime() - 15_000).toISOString(),
          attempt_id: attemptId,
          event_type: "error",
          taskId: "task-456",
          task_title: "Replay detail task",
          executor: "claude",
          data: { error_message: "Context window exhausted" },
        },
      ].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );

    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/agent-runs/${attemptId}`);
      const payload = await response.json();
      expect(payload.ok).toBe(true);
      expect(payload.data).toEqual(expect.objectContaining({
        attemptId,
        taskId: "task-456",
        taskTitle: "Replay detail task",
        executor: "claude",
        status: "in_progress",
      }));
      expect(payload.data.shortSteps).toEqual(expect.arrayContaining([
        expect.stringContaining("Started claude run"),
        expect.stringContaining("Investigated failure and prepared patch."),
        expect.stringContaining("Error: Context window exhausted"),
      ]));
      expect(payload.data.totals.errors).toBe(1);
      expect(payload.data.turns).toEqual([
        expect.objectContaining({
          index: 1,
          tokenCount: 100,
          inputTokens: 80,
          outputTokens: 20,
          durationMs: 1800,
        }),
      ]);
      expect(payload.data.events[1]).toEqual(expect.objectContaining({
        type: "usage",
      }));
      expect(payload.data.events[2]).toEqual(expect.objectContaining({
        type: "agent_output",
        summary: "Investigated failure and prepared patch.",
      }));
    } finally {
      await new Promise((resolveClose) => server.close(() => resolveClose()));
      resetStateLedgerCache();
      if (previousRepoRoot === undefined) delete process.env.REPO_ROOT;
      else process.env.REPO_ROOT = previousRepoRoot;
      rmSync(isolatedRepoRoot, { recursive: true, force: true });
    }
  });
  it("includes turn counts in live sessions snapshots", async () => {
    const mod = await import("../infra/tui-bridge.mjs");
    const payload = mod.buildSessionsUpdatePayload([
      {
        id: "session-live-1",
        taskId: "task-live-1",
        title: "Live task",
        type: "task",
        status: "active",
        workspaceId: null,
        workspaceDir: null,
        branch: "feature/live-turns",
        turnCount: 3,
        createdAt: "2026-03-21T00:00:00.000Z",
        lastActiveAt: "2026-03-21T00:01:00.000Z",
        idleMs: 0,
        elapsedMs: 60000,
        recommendation: "continue",
        preview: "Working",
        lastMessage: "Latest output",
        insights: {},
      },
    ]);

    expect(payload).toEqual([
      expect.objectContaining({
        id: "session-live-1",
        taskId: "task-live-1",
        turnCount: 3,
      }),
    ]);
  });
  it("serves benchmark snapshots and persists benchmark mode for the active workspace", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-ui-benchmark-mode-"));
    const configPath = join(tmpDir, "bosun.config.json");
    const workspaceRoot = join(tmpDir, "workspaces", "bench-alpha");
    const workspaceRepo = join(workspaceRoot, "repo");
    mkdirSync(join(workspaceRepo, ".git"), { recursive: true });
    process.env.BOSUN_CONFIG_PATH = configPath;
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          $schema: "./bosun.schema.json",
          activeWorkspace: "bench-alpha",
          workspaces: [
            {
              id: "bench-alpha",
              name: "Benchmark Alpha",
              path: workspaceRoot,
              activeRepo: "repo",
              repos: [{ name: "repo", path: workspaceRepo, primary: true }],
            },
          ],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const mod = await import("../server/ui-server.mjs");
    const executor = {
      maxParallel: 4,
      paused: false,
      getStatus() {
        return {
          maxParallel: this.maxParallel,
          activeSlots: 0,
          slots: [],
          paused: this.paused,
        };
      },
      isPaused() {
        return this.paused;
      },
      pause() {
        this.paused = true;
      },
      resume() {
        this.paused = false;
      },
      abortTask: vi.fn(() => ({ ok: true, reason: "benchmark_mode_focus" })),
    };
    mod.injectUiDependencies({
      getInternalExecutor: () => executor,
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    try {
      const snapshot = await fetch(`http://127.0.0.1:${port}/api/benchmarks`).then((r) => r.json());
      expect(snapshot.ok).toBe(true);
      expect(snapshot.data.providers.some((entry) => entry.id === "swebench")).toBe(true);
      expect(snapshot.data.workspace.workspaceId).toBe("bench-alpha");

      const enabled = await fetch(`http://127.0.0.1:${port}/api/benchmarks/mode`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerId: "swebench",
          enabled: true,
          maxParallel: 1,
          pauseOtherAgents: true,
          holdActiveNonBenchmarkTasks: false,
        }),
      }).then((r) => r.json());

      expect(enabled.ok).toBe(true);
      expect(enabled.data.mode.enabled).toBe(true);
      expect(enabled.data.mode.providerId).toBe("swebench");
      expect(enabled.data.appliedMaxParallel).toBe(1);

      const modePath = join(workspaceRepo, ".bosun", ".cache", "benchmark-mode.json");
      expect(existsSync(modePath)).toBe(true);
      expect(JSON.parse(readFileSync(modePath, "utf8")).providerId).toBe("swebench");

      const disabled = await fetch(`http://127.0.0.1:${port}/api/benchmarks/mode`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "swebench", enabled: false }),
      }).then((r) => r.json());

      expect(disabled.ok).toBe(true);
      expect(disabled.data.mode.enabled).toBe(false);
      expect(existsSync(modePath)).toBe(false);
    } finally {
      await settleUiRuntimeCleanup();
      await removeDirWithRetries(tmpDir);
    }
  }, 20000);

  it("creates benchmark workspaces and launches SWE-bench imports through benchmark routes", async () => {
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    const tmpDir = mkdtempSync(join(tmpdir(), "bosun-ui-benchmark-run-"));
    const configPath = join(tmpDir, "bosun.config.json");
    process.env.BOSUN_CONFIG_PATH = configPath;
    writeFileSync(
      configPath,
      JSON.stringify({ $schema: "./bosun.schema.json", workspaces: [] }, null, 2) + "\n",
      "utf8",
    );

    const mod = await import("../server/ui-server.mjs");
    const executor = {
      maxParallel: 3,
      paused: false,
      getStatus() {
        return {
          maxParallel: this.maxParallel,
          activeSlots: 0,
          slots: [],
          paused: this.paused,
        };
      },
      isPaused() {
        return this.paused;
      },
      pause() {
        this.paused = true;
      },
      resume() {
        this.paused = false;
      },
      abortTask: vi.fn(() => ({ ok: true, reason: "benchmark_mode_focus" })),
    };
    mod.injectUiDependencies({
      getInternalExecutor: () => executor,
    });

    const server = await mod.startTelegramUiServer({
      port: await getFreePort(),
      host: "127.0.0.1",
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;

    try {
      const workspaceResponse = await fetch(`http://127.0.0.1:${port}/api/benchmarks/workspace`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerId: "swebench",
          name: "Bench Smoke",
          switchActive: true,
          ensureRuntime: true,
        }),
      }).then((r) => r.json());

      expect(workspaceResponse.ok).toBe(true);
      expect(workspaceResponse.data.created).toBe(true);
      expect(workspaceResponse.data.preset.profile.id).toBe("benchmark-agent");

      const workspaceRoot = workspaceResponse.data.preset.rootDir || workspaceResponse.data.workspace.path;
      expect(typeof workspaceRoot).toBe("string");
      expect(existsSync(join(workspaceRoot, ".bosun", "profiles", "benchmark-agent.json"))).toBe(true);

      const instancesPath = join(tmpDir, "instances.jsonl");
      writeFileSync(
        instancesPath,
        `${JSON.stringify({
          instance_id: "demo__bench-1",
          problem_statement: "Fix benchmark route coverage",
          repo: "acme/widgets",
          base_commit: "abc123",
          workspace: workspaceRoot,
        })}\n`,
        "utf8",
      );

      const runResponse = await fetch(`http://127.0.0.1:${port}/api/benchmarks/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerId: "swebench",
          instances: instancesPath,
          prepareWorkspace: true,
          activateMode: true,
        }),
      }).then((r) => r.json());

      expect(runResponse.ok).toBe(true);
      expect(runResponse.data.launch.created).toBe(1);
      expect(runResponse.data.mode.enabled).toBe(true);
      expect(runResponse.data.snapshot.recentTasks.some((task) => task.id === "swebench-demo__bench-1")).toBe(true);

      const storePath = join(workspaceRoot, ".bosun", ".cache", "kanban-state.json");
      expect(existsSync(storePath)).toBe(true);
      const store = JSON.parse(readFileSync(storePath, "utf8"));
      expect(Object.keys(store.tasks || {})).toContain("swebench-demo__bench-1");
    } finally {
      await settleUiRuntimeCleanup();
      await removeDirWithRetries(tmpDir);
    }
  }, 30000);

  it("routes default-chat workflow Telegram notifications through the live digest helper", () => {
    const source = readFileSync(join(process.cwd(), "server", "ui-server.mjs"), "utf8");

    expect(source).toContain("async function sendWorkflowTelegramMessage");
    expect(source).toContain('const digest = await getWorkflowTelegramDigest()');
    expect(source).toContain('await digest.notify(message, 4, {');
    expect(source).toContain('category: "workflow"');
  });

});
