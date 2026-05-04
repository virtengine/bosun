import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("telegram harness boundary", () => {
  const botSource = readFileSync(resolve(process.cwd(), "telegram/telegram-bot.mjs"), "utf8");
  const monitorSource = readFileSync(resolve(process.cwd(), "infra/monitor.mjs"), "utf8");

  it("keeps telegram-bot behind injected runtime and client seams", () => {
    expect(botSource).not.toContain("../server/ui-server.mjs");
    expect(botSource).not.toContain("async function localUiRequest(");
    expect(botSource).not.toContain("async function workspaceRequest(");
    expect(botSource).toContain("createTelegramWorkspaceApiClient");
    expect(botSource).toContain("const request = getTelegramUiRuntime().request;");
    expect(botSource).toContain("await harnessApi.getSurface(\"telemetry\", 12)");
  });

  it("routes monitor-owned surface runtime wiring through the telegram adapter", () => {
    expect(monitorSource).toContain("../telegram/telegram-surface-runtime.mjs");
    expect(monitorSource).toContain("startTelegramSurfaceRuntime");
    expect(monitorSource).toContain("stopTelegramSurfaceRuntime");
    expect(monitorSource).toContain("telegramUiRuntime: createTelegramUiRuntime()");
    expect(monitorSource).not.toContain("../server/ui-server.mjs");
    expect(monitorSource).not.toContain("startTelegramUiServer");
  });
});
