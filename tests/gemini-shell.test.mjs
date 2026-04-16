import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const mockGenerateContent = vi.hoisted(() => vi.fn());
const mockSpawn = vi.hoisted(() => vi.fn());
const SLOW_GEMINI_SHELL_TEST_TIMEOUT_MS = process.platform === "win32" ? 20_000 : 5_000;

vi.mock("@google/genai", () => ({
  GoogleGenAI: class GoogleGenAIMock {
    constructor() {
      this.models = {
        generateContent: (...args) => mockGenerateContent(...args),
      };
    }
  },
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: (...args) => mockSpawn(...args),
  };
});

vi.mock("../config/repo-root.mjs", () => ({
  resolveRepoRoot: vi.fn(() => "/mock/repo"),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
    writeFile: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../infra/stream-resilience.mjs", () => ({
  isTransientStreamError: (err) => String(err?.message || "").includes("503"),
  streamRetryDelay: () => 0,
  MAX_STREAM_RETRIES: 2,
}));

const {
  execGeminiPrompt,
  initGeminiShell,
  getSessionInfo,
  createSession,
  listSessions,
  resetSession,
} = await import("../shell/gemini-shell.mjs");

function fakeChild({ code = 0, stdout = "", stderr = "", error = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();

  queueMicrotask(() => {
    if (error) {
      child.emit("error", error);
      return;
    }
    if (stdout) child.stdout.emit("data", stdout);
    if (stderr) child.stderr.emit("data", stderr);
    child.emit("close", code);
  });

  return child;
}

describe("gemini-shell", () => {
  beforeEach(async () => {
    delete process.env.GEMINI_SDK_DISABLED;
    delete process.env.GEMINI_TRANSPORT;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_CLI_ARGS;
    delete process.env.GEMINI_CLI_PATH;
    mockGenerateContent.mockReset();
    mockSpawn.mockReset();
    await resetSession();
  });

  afterEach(async () => {
    await resetSession();
  });

  it("uses Gemini SDK when configured", async () => {
    process.env.GEMINI_TRANSPORT = "sdk";
    process.env.GEMINI_API_KEY = "test-key";
    mockGenerateContent.mockResolvedValue({
      text: "sdk response",
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        totalTokenCount: 30,
      },
    });

    const result = await execGeminiPrompt("hello");

    expect(result.finalResponse).toBe("sdk response");
    expect(result.usage).toEqual({
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
    });
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
  }, SLOW_GEMINI_SHELL_TEST_TIMEOUT_MS);

  it("returns disabled message when GEMINI_SDK_DISABLED is set", async () => {
    process.env.GEMINI_SDK_DISABLED = "true";
    const result = await execGeminiPrompt("hello");
    expect(result.finalResponse).toContain("disabled");
  });

  it("falls back to CLI in auto mode when SDK key is missing", async () => {
    process.env.GEMINI_TRANSPORT = "auto";
    mockSpawn.mockImplementation(() =>
      fakeChild({ code: 0, stdout: "{\"text\":\"cli response\"}" }),
    );

    const result = await execGeminiPrompt("hello");

    expect(result.finalResponse).toBe("cli response");
    expect(mockSpawn).toHaveBeenCalled();
  }, SLOW_GEMINI_SHELL_TEST_TIMEOUT_MS);

  it("retries CLI argument styles when a command attempt fails", async () => {
    process.env.GEMINI_TRANSPORT = "cli";
    mockSpawn
      .mockImplementationOnce(() => fakeChild({ code: 2, stderr: "bad args" }))
      .mockImplementationOnce(() => fakeChild({ code: 0, stdout: "plain output" }));

    const result = await execGeminiPrompt("hello");

    expect(result.finalResponse).toContain("plain output");
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  }, SLOW_GEMINI_SHELL_TEST_TIMEOUT_MS);

  it("initializes and exposes lightweight session metadata", async () => {
    process.env.GEMINI_TRANSPORT = "sdk";
    process.env.GEMINI_API_KEY = "test-key";
    mockGenerateContent.mockResolvedValue({ text: "ok" });

    const ok = await initGeminiShell();
    expect(ok).toBe(true);

    await createSession("session-1");
    const sessions = await listSessions();
    expect(sessions.some((entry) => entry.id === "session-1")).toBe(true);

    await execGeminiPrompt("hello", { sessionId: "session-1" });
    const info = getSessionInfo();
    expect(info.sessionId).toBe("session-1");
    expect(info.turnCount).toBeGreaterThan(0);
  }, SLOW_GEMINI_SHELL_TEST_TIMEOUT_MS);
});

