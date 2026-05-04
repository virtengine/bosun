import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStateLedgerCache } from "../lib/state-ledger-sqlite.mjs";

const describeVoiceHttpRoutes = (
  process.env.BOSUN_TEST_CHILD_SPAWN_BLOCKED === "1"
  || (process.platform === "win32" && /[\\/]\.codex[\\/]\.sandbox[\\/]/i.test(process.cwd()))
)
  ? describe.skip
  : describe;

const sharedEngine = {
  evaluateTriggers: vi.fn(async () => []),
  execute: vi.fn(async () => ({})),
  load: vi.fn(),
  listWorkflows: vi.fn(() => []),
};

vi.mock("../voice/voice-relay.mjs", () => ({
  analyzeVisionFrame: vi.fn(async () => ({
    summary: "Editor with a failing test output is visible.",
    provider: "mock",
    model: "mock-vision-model",
  })),
}));

const { analyzeVisionFrame } = await import("../voice/voice-relay.mjs");

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method || "GET",
      headers: options.headers || {},
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({
          status: Number(res.statusCode || 0),
          async json() {
            return body ? JSON.parse(body) : null;
          },
          async text() {
            return body;
          },
        });
      });
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describeVoiceHttpRoutes("ui-server voice + vision routes", () => {
  const ENV_KEYS = [
    "TELEGRAM_UI_TLS_DISABLE",
    "TELEGRAM_UI_ALLOW_UNSAFE",
    "TELEGRAM_UI_TUNNEL",
    "TELEGRAM_UI_PORT",
    "BOSUN_UI_ALLOW_EPHEMERAL_PORT",
    "BOSUN_UI_AUTO_OPEN_BROWSER",
    "BOSUN_ENV_NO_OVERRIDE",
    "BOSUN_HOME",
    "BOSUN_DIR",
    "BOSUN_TEST_CACHE_DIR",
    "BOSUN_STATE_LEDGER_PATH",
    "CODEX_MONITOR_HOME",
    "CODEX_MONITOR_DIR",
    "REPO_ROOT",
    "WORKFLOW_DEFAULT_AUTOINSTALL",
    "WORKFLOW_AUTOMATION_ENABLED",
    "WORKFLOW_EVENT_DEDUP_WINDOW_MS",
  ];
  let envSnapshot = {};
  let testSandboxRoot = null;

  beforeEach(async () => {
    envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    testSandboxRoot = mkdtempSync(join(tmpdir(), "bosun-voice-http-test-"));
    const { ensureTestRuntimeSandbox } = await import("../infra/test-runtime.mjs");
    const sandbox = ensureTestRuntimeSandbox({ rootDir: testSandboxRoot, force: true });
    process.env.TELEGRAM_UI_TLS_DISABLE = "true";
    process.env.TELEGRAM_UI_ALLOW_UNSAFE = "true";
    process.env.TELEGRAM_UI_TUNNEL = "disabled";
    process.env.BOSUN_UI_ALLOW_EPHEMERAL_PORT = "1";
    process.env.BOSUN_UI_AUTO_OPEN_BROWSER = "0";
    process.env.BOSUN_ENV_NO_OVERRIDE = "1";
    process.env.WORKFLOW_DEFAULT_AUTOINSTALL = "false";
    process.env.WORKFLOW_AUTOMATION_ENABLED = "true";
    process.env.WORKFLOW_EVENT_DEDUP_WINDOW_MS = "1";
    process.env.BOSUN_HOME = sandbox.configDir;
    process.env.BOSUN_DIR = sandbox.configDir;
    process.env.BOSUN_TEST_CACHE_DIR = sandbox.cacheDir;
    process.env.BOSUN_STATE_LEDGER_PATH = sandbox.stateLedgerPath;
    process.env.CODEX_MONITOR_HOME = sandbox.configDir;
    process.env.CODEX_MONITOR_DIR = sandbox.configDir;
    delete process.env.REPO_ROOT;
    vi.mocked(analyzeVisionFrame).mockClear();
    // Inject the shared mock engine so dispatchWorkflowEvent uses it
    const mod = await import("../server/ui-server.mjs");
    const wfMock = { WorkflowEngine: vi.fn(() => sharedEngine) };
    mod._testInjectWorkflowEngine(wfMock, sharedEngine);
  }, process.platform === "win32" ? 30000 : 20000);

  afterEach(async () => {
    const mod = await import("../server/ui-server.mjs");
    mod.stopTelegramUiServer();
    // Reset session tracker singleton so test-created sessions don't leak
    // into subsequent tests or persist to disk.
    const { _resetSingleton } = await import("../infra/session-tracker.mjs");
    _resetSingleton({ persistDir: null });
    resetStateLedgerCache();
    for (const key of ENV_KEYS) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key];
    }
    if (testSandboxRoot) {
      rmSync(testSandboxRoot, { recursive: true, force: true });
      testSandboxRoot = null;
    }
  }, process.platform === "win32" ? 30000 : 20000);

  async function startServer() {
    const mod = await import("../server/ui-server.mjs");
    const server = await mod.startTelegramUiServer({
      host: "127.0.0.1",
      port: 0,
      skipInstanceLock: true,
      skipAutoOpen: true,
    });
    const port = server.address().port;
    return { port };
  }

  it("persists user and assistant transcript turns into the bound session history", async () => {
    const { port } = await startServer();
    const sessionId = `primary-voice-http-${Date.now()}`;

    const res = await requestJson(`http://127.0.0.1:${port}/api/voice/transcript`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        role: "user",
        content: "Please check my build logs.",
        executor: "codex-sdk",
        mode: "agent",
      }),
    });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);

    const assistantRes = await requestJson(`http://127.0.0.1:${port}/api/voice/transcript`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        role: "assistant",
        content: "I checked the logs. The build failed due to lint errors.",
        executor: "codex-sdk",
        mode: "agent",
      }),
    });
    const assistantData = await assistantRes.json();
    expect(assistantRes.status).toBe(200);
    expect(assistantData.ok).toBe(true);

    const { getSessionById } = await import("../infra/session-tracker.mjs");
    const session = getSessionById(sessionId);
    expect(session).toBeTruthy();
    expect(session?.type).toBe("voice");
    expect(session?.metadata).toEqual(expect.objectContaining({
      hiddenInLists: true,
      source: "voice-http",
    }));
    const messages = session?.messages || [];
    const userTurn = messages.find((msg) => msg?.role === "user");
    const assistantTurn = messages.find((msg) => msg?.role === "assistant");
    expect(userTurn?.content).toContain("check my build logs");
    expect(assistantTurn?.content).toContain("build failed due to lint errors");
  }, process.platform === "win32" ? 30000 : 20000);

  it("queues workflow trigger evaluation for transcript and wake phrase events", async () => {
    const { port } = await startServer();
    const sessionId = `primary-workflow-transcript-${Date.now()}`;
    // Use the shared mock engine that is returned by the mocked WorkflowEngine
    // constructor (and thus used by dispatchWorkflowEvent's per-workspace engine).
    sharedEngine.evaluateTriggers.mockClear();
    sharedEngine.evaluateTriggers.mockResolvedValue([]);

    try {
      const res = await requestJson(`http://127.0.0.1:${port}/api/voice/transcript`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          role: "user",
          content: "Hi bosun wake, can you capture this action item?",
          eventType: "wake_phrase",
          provider: "mock-provider",
        }),
      });
      const data = await res.json();
      expect(res.status).toBe(200);
      expect(data.ok).toBe(true);

      await vi.waitFor(() => {
        expect(sharedEngine.evaluateTriggers).toHaveBeenCalledWith(
          "meeting.transcript",
          expect.objectContaining({
            sessionId,
            meetingSessionId: sessionId,
            role: "user",
            content: "Hi bosun wake, can you capture this action item?",
            source: "voice",
            transcriptEventType: "wake_phrase",
            _triggerSource: "ui-server",
            _triggerEventType: "meeting.transcript",
          }),
        );
      });

      await vi.waitFor(() => {
        expect(sharedEngine.evaluateTriggers).toHaveBeenCalledWith(
          "meeting.wake_phrase",
          expect.objectContaining({
            sessionId,
            role: "user",
            transcriptEventType: "wake_phrase",
            _triggerSource: "ui-server",
            _triggerEventType: "meeting.wake_phrase",
          }),
        );
      });
    } finally {
      sharedEngine.evaluateTriggers.mockClear();
    }
  }, process.platform === "win32" ? 30000 : 20000);

  it("stores and returns voice turn trace events", async () => {
    const { port } = await startServer();
    const sessionId = `primary-voice-trace-${Date.now()}`;

    const events = [
      { eventType: "turn_start", turnId: "turn-1", source: "voice-client", transport: "webrtc" },
      { eventType: "llm_first_token", turnId: "turn-1", source: "voice-client", transport: "webrtc" },
      { eventType: "tts_first_audio", turnId: "turn-1", source: "voice-client", transport: "webrtc" },
      { eventType: "turn_end", turnId: "turn-1", source: "voice-client", transport: "webrtc" },
    ];

    const ingestRes = await requestJson(`http://127.0.0.1:${port}/api/voice/trace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        provider: "mock-provider",
        events,
      }),
    });
    const ingestJson = await ingestRes.json();
    expect(ingestRes.status).toBe(200);
    expect(ingestJson.ok).toBe(true);
    expect(ingestJson.stored).toBe(events.length);
    expect(String(ingestJson?.latest?.eventType || "")).toBe("turn_end");

    const listRes = await requestJson(`http://127.0.0.1:${port}/api/voice/trace?sessionId=${encodeURIComponent(sessionId)}&limit=10`);
    const listJson = await listRes.json();
    expect(listRes.status).toBe(200);
    expect(listJson.ok).toBe(true);
    expect(Array.isArray(listJson.events)).toBe(true);
    expect(listJson.events.length).toBeGreaterThanOrEqual(events.length);
    expect(listJson.events[0]).toMatchObject({
      sessionId,
      eventType: "turn_end",
      turnId: "turn-1",
    });

    const latestRes = await requestJson(`http://127.0.0.1:${port}/api/voice/trace?sessionId=${encodeURIComponent(sessionId)}&latest=1`);
    const latestJson = await latestRes.json();
    expect(latestRes.status).toBe(200);
    expect(latestJson.ok).toBe(true);
    expect(latestJson.latest).toMatchObject({
      sessionId,
      eventType: "turn_end",
      turnId: "turn-1",
    });
  });

  it("ingests a vision frame, analyzes once, and deduplicates repeated frames", async () => {
    const { port } = await startServer();
    const sessionId = `primary-vision-http-${Date.now()}`;
    const frameDataUrl = "data:image/jpeg;base64,dGVzdA==";

    const first = await requestJson(`http://127.0.0.1:${port}/api/vision/frame`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        source: "screen",
        frameDataUrl,
        width: 1280,
        height: 720,
        persistToChat: true,
      }),
    });
    const firstJson = await first.json();
    expect(first.status).toBe(200);
    expect(firstJson.ok).toBe(true);
    expect(firstJson.analyzed).toBe(true);
    expect(firstJson.summary).toContain("failing test");
    expect(vi.mocked(analyzeVisionFrame)).toHaveBeenCalledTimes(1);

    const second = await requestJson(`http://127.0.0.1:${port}/api/vision/frame`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        source: "screen",
        frameDataUrl,
        width: 1280,
        height: 720,
      }),
    });
    const secondJson = await second.json();
    expect(second.status).toBe(200);
    expect(secondJson.ok).toBe(true);
    expect(secondJson.analyzed).toBe(false);
    expect(secondJson.reason).toBe("duplicate_frame");
    expect(vi.mocked(analyzeVisionFrame)).toHaveBeenCalledTimes(1);

    const { getSessionById } = await import("../infra/session-tracker.mjs");
    const session = getSessionById(sessionId);
    expect(session).toBeTruthy();
    expect(session?.type).toBe("voice");
    expect(session?.metadata).toEqual(expect.objectContaining({
      hiddenInLists: true,
      source: "vision-http",
    }));
    const visionMessage = (session?.messages || []).find(
      (msg) => String(msg?.content || "").startsWith("[Vision screen"),
    );
    expect(visionMessage).toBeTruthy();
  });
});
