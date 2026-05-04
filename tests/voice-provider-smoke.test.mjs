import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Prevent disk-cached shared auth tokens in ~/.bosun/voice-auth-state.json from
// leaking in and making azureAvailable=true regardless of what env vars the
// test sets.
vi.mock("../agent/provider-auth-state.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveSharedOAuthToken: vi.fn(() => null),
    hasSharedOAuthToken: vi.fn(() => false),
    saveSharedOAuthToken: vi.fn(),
  };
});

// Non-existent temp dir — prevents loadDotEnv + loadConfigFile from reading
// the developer's real .env / bosun.config.json which may have Azure creds.
const ISOLATED_BOSUN_DIR = join(
  tmpdir(),
  `bosun-voice-smoke-${process.pid}-${Date.now()}`,
);

const ENV_KEYS = [
  "BOSUN_HOME",
  "BOSUN_DIR",
  "BOSUN_HOME",
  "TELEGRAM_UI_TLS_DISABLE",
  "TELEGRAM_UI_ALLOW_UNSAFE",
  "TELEGRAM_UI_TUNNEL",
  "TELEGRAM_UI_PORT",
  "BOSUN_UI_ALLOW_EPHEMERAL_PORT",
  "BOSUN_UI_AUTO_OPEN_BROWSER",
  "BOSUN_ENV_NO_OVERRIDE",
  "BOSUN_LOAD_REPO_ENV_WITH_EXPLICIT_CONFIG",
  "VOICE_ENABLED",
  "VOICE_PROVIDERS",
  "VOICE_PROVIDER",
  "VOICE_PROVIDERS",
  "VOICE_MODEL",
  "VOICE_VISION_MODEL",
  "VOICE_FALLBACK_MODE",
  "OPENAI_API_KEY",
  "OPENAI_REALTIME_API_KEY",
  "BOSUN_VOICE_OPENAI_ACCESS_TOKEN",
  "OPENAI_OAUTH_ACCESS_TOKEN",
  "OPENAI_ACCESS_TOKEN",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_REALTIME_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_REALTIME_ENDPOINT",
  "BOSUN_VOICE_AZURE_ACCESS_TOKEN",
  "AZURE_OPENAI_ACCESS_TOKEN",
  "ANTHROPIC_API_KEY",
  "BOSUN_VOICE_CLAUDE_ACCESS_TOKEN",
  "ANTHROPIC_ACCESS_TOKEN",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "BOSUN_VOICE_GEMINI_ACCESS_TOKEN",
  "GEMINI_ACCESS_TOKEN",
  "GOOGLE_ACCESS_TOKEN",
];

const PROVIDER_MATRIX = Object.freeze([
  {
    id: "openai",
    env: {
      VOICE_PROVIDER: "openai",
      VOICE_PROVIDERS: "openai",
      OPENAI_API_KEY: "sk-test-openai",
      VOICE_MODEL: "gpt-4o-realtime-preview-2024-12-17",
      VOICE_VISION_MODEL: "gpt-4.1-mini",
    },
    expectTier: 1,
    expectTokenStatus: 200,
    expectVisionProvider: "openai",
    expectedOutbound: {
      token: "api.openai.com/v1/realtime/sessions",
      vision: "api.openai.com/v1/responses",
    },
    visionReply: "OpenAI vision smoke summary.",
  },
  {
    id: "claude",
    env: {
      VOICE_PROVIDER: "claude",
      VOICE_PROVIDERS: "claude",
      ANTHROPIC_API_KEY: "sk-ant-test",
      VOICE_MODEL: "claude-3-7-sonnet-latest",
      VOICE_VISION_MODEL: "claude-3-7-sonnet-latest",
    },
    expectTier: 2,
    expectTokenStatus: 400,
    expectVisionProvider: "claude",
    expectedOutbound: {
      vision: "api.anthropic.com/v1/messages",
    },
    visionReply: "Claude vision smoke summary.",
  },
  {
    id: "gemini",
    env: {
      VOICE_PROVIDER: "gemini",
      VOICE_PROVIDERS: "gemini",
      GEMINI_API_KEY: "gemini-test-key",
      VOICE_MODEL: "gemini-2.5-pro",
      VOICE_VISION_MODEL: "gemini-2.5-flash",
    },
    expectTier: 2,
    expectTokenStatus: 400,
    expectVisionProvider: "gemini",
    expectedOutbound: {
      vision: "generativelanguage.googleapis.com/v1beta/models/",
    },
    visionReply: "Gemini vision smoke summary.",
  },
]);

let envSnapshot = {};
let uiServerModule = null;
let argvSnapshot = [];
let realFetch = null;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function outboundFetchMockForScenario(scenario) {
  const outboundUrls = [];
  globalThis.fetch = vi.fn(async (input, init = {}) => {
    const url = String(typeof input === "string" ? input : input?.url || "");
    if (url.startsWith("http://127.0.0.1:")) {
      return realFetch(input, init);
    }

    outboundUrls.push(url);

    if (scenario.id === "openai") {
      if (url.includes("/v1/realtime/sessions")) {
        return jsonResponse({
          client_secret: {
            value: "openai-smoke-token",
            expires_at: Math.floor(Date.now() / 1000) + 60,
          },
        });
      }
      if (url.includes("/v1/responses")) {
        return jsonResponse({ output_text: scenario.visionReply });
      }
    }

    if (scenario.id === "claude" && url.includes("api.anthropic.com/v1/messages")) {
      return jsonResponse({
        content: [{ type: "text", text: scenario.visionReply }],
      });
    }

    if (
      scenario.id === "gemini" &&
      url.includes("generativelanguage.googleapis.com/v1beta/models/") &&
      url.includes(":generateContent")
    ) {
      return jsonResponse({
        candidates: [
          {
            content: {
              parts: [{ text: scenario.visionReply }],
            },
          },
        ],
      });
    }

    return jsonResponse({ error: `unexpected outbound request: ${url}` }, 500);
  });
  return outboundUrls;
}

async function startServer() {
  const { _resetSingleton } = await import("../infra/session-tracker.mjs");
  _resetSingleton({ persistDir: null });
  const voiceRelay = await import("../voice/voice-relay.mjs");
  uiServerModule = await import("../server/ui-server.mjs");
  const server = await uiServerModule.startTelegramUiServer({
    host: "127.0.0.1",
    port: 0,
    skipInstanceLock: true,
    skipAutoOpen: true,
    dependencies: { voiceRelay },
  });
  if (uiServerModule?.injectUiDependencies) {
    uiServerModule.injectUiDependencies({ voiceRelay });
  }
  const port = Number(server.address()?.port || 0);
  return { server, port, voiceRelay };
}

beforeEach(() => {
  realFetch =
    typeof globalThis.fetch === "function"
      ? globalThis.fetch.bind(globalThis)
      : fetch.bind(globalThis);
  envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  argvSnapshot = process.argv.slice();

  process.env.TELEGRAM_UI_TLS_DISABLE = "true";
  process.env.TELEGRAM_UI_ALLOW_UNSAFE = "true";
  process.env.TELEGRAM_UI_TUNNEL = "disabled";
  process.env.BOSUN_UI_ALLOW_EPHEMERAL_PORT = "1";
  process.env.BOSUN_UI_AUTO_OPEN_BROWSER = "0";
  process.env.BOSUN_ENV_NO_OVERRIDE = "1";
  process.env.BOSUN_LOAD_REPO_ENV_WITH_EXPLICIT_CONFIG = "0";
  process.env.VOICE_ENABLED = "true";
  process.env.VOICE_PROVIDERS = "";
  process.env.VOICE_FALLBACK_MODE = "browser";
  process.env.VOICE_PROVIDERS = "";
  // Isolate from the developer's ~/.bosun config dir and .env file so that
  // real Azure credentials don't leak into provider-selection logic.
  process.env.BOSUN_HOME = ISOLATED_BOSUN_DIR;
  process.env.BOSUN_DIR = ISOLATED_BOSUN_DIR;
  process.env.BOSUN_HOME = ISOLATED_BOSUN_DIR;

  // Set credential keys to empty strings instead of deleting them so that
  // loadDotEnv ({ override: false }) in loadConfig() won't re-populate them
  // from the developer's .env file.  Deleting a key makes it absent, which
  // loadDotEnv treats as "not set" and happily loads the .env value.
  process.env.OPENAI_API_KEY = "";
  process.env.OPENAI_REALTIME_API_KEY = "";
  process.env.BOSUN_VOICE_OPENAI_ACCESS_TOKEN = "";
  process.env.OPENAI_OAUTH_ACCESS_TOKEN = "";
  process.env.OPENAI_ACCESS_TOKEN = "";
  process.env.AZURE_OPENAI_API_KEY = "";
  process.env.AZURE_OPENAI_REALTIME_API_KEY = "";
  process.env.AZURE_OPENAI_ENDPOINT = "";
  process.env.AZURE_OPENAI_REALTIME_ENDPOINT = "";
  process.env.BOSUN_VOICE_AZURE_ACCESS_TOKEN = "";
  process.env.AZURE_OPENAI_ACCESS_TOKEN = "";
  process.env.ANTHROPIC_API_KEY = "";
  process.env.BOSUN_VOICE_CLAUDE_ACCESS_TOKEN = "";
  process.env.ANTHROPIC_ACCESS_TOKEN = "";
  process.env.GEMINI_API_KEY = "";
  process.env.GOOGLE_API_KEY = "";
  process.env.BOSUN_VOICE_GEMINI_ACCESS_TOKEN = "";
  process.env.GEMINI_ACCESS_TOKEN = "";
  process.env.GOOGLE_ACCESS_TOKEN = "";

  globalThis.fetch = realFetch;
});

afterEach(async () => {
  if (uiServerModule?.stopTelegramUiServer) {
    uiServerModule.stopTelegramUiServer();
  }
  uiServerModule = null;
  globalThis.fetch = realFetch;
  process.argv = argvSnapshot;

  // Reset session tracker singleton so smoke-test sessions don't leak
  // into subsequent tests or persist to disk.
  const { _resetSingleton } = await import("../infra/session-tracker.mjs");
  _resetSingleton({ persistDir: null });

  for (const key of ENV_KEYS) {
    if (envSnapshot[key] === undefined) delete process.env[key];
    else process.env[key] = envSnapshot[key];
  }
});

describe("voice provider smoke matrix", () => {
  for (const scenario of PROVIDER_MATRIX) {
    it(`validates config/token/vision routes for ${scenario.id}`, async () => {
      Object.entries(scenario.env || {}).forEach(([key, value]) => {
        process.env[key] = value;
      });

      const outboundUrls = outboundFetchMockForScenario(scenario);
      const { port, voiceRelay } = await startServer();
      const voiceCfg = voiceRelay.getVoiceConfig(true);
      const { loadConfig } = await import("../config/config.mjs");
      const coreConfig = loadConfig();
      expect(process.env.VOICE_PROVIDER).toBe(scenario.id);
      expect(coreConfig.configDir).toBe(ISOLATED_BOSUN_DIR);
      expect(voiceCfg.azureEndpoint).toBe("");
      expect(voiceCfg.azureKey).toBe("");
      expect(voiceCfg.provider).toBe(scenario.id);
      expect(voiceRelay.isVoiceAvailable().provider).toBe(scenario.id);

      const configRes = await realFetch(`http://127.0.0.1:${port}/api/voice/config`);
      expect(configRes.status).toBe(200);
      const configJson = await configRes.json();
      expect(configJson.available).toBe(true);
      expect(Array.isArray(configJson.providerChain) ? configJson.providerChain : []).toContain(
        scenario.id,
      );

      const tokenRes = await realFetch(`http://127.0.0.1:${port}/api/voice/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: `smoke-${scenario.id}-${Date.now()}`,
          executor: scenario.id === "openai" ? "codex-sdk" : "gemini-sdk",
          mode: "agent",
          model: scenario.env.VOICE_MODEL,
        }),
      });
      expect(tokenRes.status).toBe(scenario.expectTokenStatus);
      const tokenJson = await tokenRes.json().catch(() => ({}));
      if (scenario.expectTokenStatus === 200) {
        expect(tokenJson.provider).toBe(scenario.id);
        expect(String(tokenJson.token || "")).not.toBe("");
      } else {
        expect(String(tokenJson.error || "")).toMatch(
          new RegExp(`provider \"${scenario.id}\"`, "i"),
        );
      }

      const visionRes = await realFetch(`http://127.0.0.1:${port}/api/vision/frame`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: `smoke-vision-${scenario.id}-${Date.now()}`,
          source: "screen",
          frameDataUrl: "data:image/jpeg;base64,dGVzdA==",
          width: 1280,
          height: 720,
        }),
      });
      expect(visionRes.status).toBe(200);
      const visionJson = await visionRes.json();
      expect(visionJson.ok).toBe(true);
      expect(visionJson.analyzed).toBe(true);
      expect(visionJson.provider).toBe(scenario.expectVisionProvider);
      expect(String(visionJson.summary || "")).toMatch(/smoke summary/i);

      if (scenario.expectedOutbound?.token) {
        expect(outboundUrls.some((url) => url.includes(scenario.expectedOutbound.token))).toBe(
          true,
        );
      }
      if (scenario.expectedOutbound?.vision) {
        expect(outboundUrls.some((url) => url.includes(scenario.expectedOutbound.vision))).toBe(
          true,
        );
      }
    }, process.platform === "win32" ? 90_000 : 60_000);
  }
});
