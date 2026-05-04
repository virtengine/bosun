import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("telegram runtime boundary", () => {
  const telegramBotSource = readFileSync(resolve(process.cwd(), "telegram/telegram-bot.mjs"), "utf8");
  const monitorSource = readFileSync(resolve(process.cwd(), "infra/monitor.mjs"), "utf8");
  const surfaceRuntimeSource = readFileSync(resolve(process.cwd(), "telegram/telegram-surface-runtime.mjs"), "utf8");

  it("keeps telegram-bot on an injected UI runtime seam instead of importing ui-server directly", () => {
    expect(telegramBotSource).toContain("let _telegramUiRuntime = null;");
    expect(telegramBotSource).toContain("function setTelegramUiRuntime(runtime = null)");
    expect(telegramBotSource).toContain("telegramUiRuntime,");
    expect(telegramBotSource).not.toContain('from "../server/ui-server.mjs"');
  });

  it("makes monitor own UI server lifecycle through the telegram surface runtime adapter", () => {
    expect(monitorSource).toContain('from "../telegram/telegram-surface-runtime.mjs"');
    expect(monitorSource).toContain("async function ensureTelegramSurfaceRuntimeStarted(options = {})");
    expect(monitorSource).toContain("async function startTelegramSurfaceAndBot(options = {})");
    expect(monitorSource).toContain("function stopTelegramSurfaceAndBot(options = {})");
    expect(monitorSource).toContain("telegramUiRuntime: createTelegramUiRuntime()");
    expect(monitorSource).not.toContain('from "../server/ui-server.mjs"');
  });

  it("keeps the ui-server bridge isolated in telegram-surface-runtime", () => {
    expect(surfaceRuntimeSource).toContain('from "../server/ui-server.mjs"');
    expect(surfaceRuntimeSource).toContain("export function createTelegramUiRuntime()");
    expect(surfaceRuntimeSource).toContain("export async function startTelegramSurfaceRuntime(options = {})");
    expect(surfaceRuntimeSource).toContain("export function stopTelegramSurfaceRuntime()");
    expect(surfaceRuntimeSource).toContain("requestTelegramSurfaceApi");
  });
});
