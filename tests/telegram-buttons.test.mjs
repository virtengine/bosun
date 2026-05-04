import { beforeEach, describe, it, expect, vi } from "vitest";
import { createStickyMenuStateManager } from "../telegram/sticky-menu-state.mjs";

/**
 * Tests for Telegram inline keyboard button support added to telegram-bot.mjs.
 * These tests verify the button infrastructure without requiring a live Telegram connection.
 */

describe("telegram-bot inline keyboards", () => {
  describe("reply_markup support in sendDirect", () => {
    it("sendDirect should accept reply_markup in options", async () => {
      // Verify the module exports exist and the COMMANDS structure includes help
      // We can't easily test sendDirect without mocking fetch, but we can verify
      // the command structure supports buttons
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");

      const __dirname = path.resolve(
        fileURLToPath(new URL(".", import.meta.url)),
      );
      const botSource = fs.readFileSync(
        path.resolve(__dirname, "..", "telegram", "telegram-bot.mjs"),
        "utf8",
      );

      // Verify reply_markup is passed through in sendDirect
      expect(botSource).toContain("reply_markup");
      // Verify inline_keyboard structure exists
      expect(botSource).toContain("inline_keyboard");
      // Verify callback_query handling exists
      expect(botSource).toContain("callback_query");
      // Verify answerCallbackQuery function exists
      expect(botSource).toContain("answerCallbackQuery");
      // Verify handleCallbackQuery function exists
      expect(botSource).toContain("handleCallbackQuery");
    });
  });

  describe("COMMANDS structure", () => {
    it("should include /whatsapp and /container commands", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");

      const __dirname = path.resolve(
        fileURLToPath(new URL(".", import.meta.url)),
      );
      const botSource = fs.readFileSync(
        path.resolve(__dirname, "..", "telegram", "telegram-bot.mjs"),
        "utf8",
      );

      // Verify /whatsapp command is registered
      expect(botSource).toContain('"/whatsapp"');
      expect(botSource).toContain("cmdWhatsApp");

      // Verify /container command is registered
      expect(botSource).toContain('"/container"');
      expect(botSource).toContain("cmdContainer");
    });

    it("should include /call and /videocall commands", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");

      const __dirname = path.resolve(
        fileURLToPath(new URL(".", import.meta.url)),
      );
      const botSource = fs.readFileSync(
        path.resolve(__dirname, "..", "telegram", "telegram-bot.mjs"),
        "utf8",
      );

      expect(botSource).toContain('"/call"');
      expect(botSource).toContain("cmdCall");
      expect(botSource).toContain('"/videocall"');
      expect(botSource).toContain("cmdVideoCall");
    });
  });

  describe("FAST_COMMANDS includes new commands", () => {
    it("should include /whatsapp and /container in FAST_COMMANDS", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");

      const __dirname = path.resolve(
        fileURLToPath(new URL(".", import.meta.url)),
      );
      const botSource = fs.readFileSync(
        path.resolve(__dirname, "..", "telegram", "telegram-bot.mjs"),
        "utf8",
      );

      // Extract FAST_COMMANDS set definition
      const fastMatch = botSource.match(
        /const FAST_COMMANDS = new Set\(\[([\s\S]*?)\]\)/,
      );
      expect(fastMatch).toBeTruthy();
      const fastContent = fastMatch[1];
      expect(fastContent).toContain("/whatsapp");
      expect(fastContent).toContain("/container");
    });

    it("should include /call and /videocall in FAST_COMMANDS", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");

      const __dirname = path.resolve(
        fileURLToPath(new URL(".", import.meta.url)),
      );
      const botSource = fs.readFileSync(
        path.resolve(__dirname, "..", "telegram", "telegram-bot.mjs"),
        "utf8",
      );

      const fastMatch = botSource.match(
        /const FAST_COMMANDS = new Set\(\[([\s\S]*?)\]\)/,
      );
      expect(fastMatch).toBeTruthy();
      const fastContent = fastMatch[1];
      expect(fastContent).toContain("/call");
      expect(fastContent).toContain("/videocall");
    });
  });

  describe("callback query allowed_updates", () => {
    it("should include callback_query in allowed_updates", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");

      const __dirname = path.resolve(
        fileURLToPath(new URL(".", import.meta.url)),
      );
      const botSource = fs.readFileSync(
        path.resolve(__dirname, "..", "telegram", "telegram-bot.mjs"),
        "utf8",
      );

      // The allowed_updates array should include callback_query
      const updatesMatch = botSource.match(/allowed_updates.*?\[([^\]]+)\]/);
      expect(updatesMatch).toBeTruthy();
      expect(updatesMatch[1]).toContain("callback_query");
    });
  });

  describe("sticky interactive menu flow", () => {
    it("keeps interactive prompts in the sticky slot until completion", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");

      const __dirname = path.resolve(
        fileURLToPath(new URL(".", import.meta.url)),
      );
      const botSource = fs.readFileSync(
        path.resolve(__dirname, "..", "telegram", "telegram-bot.mjs"),
        "utf8",
      );

      expect(botSource).toContain("function isStickyMenuInteractive(chatId)");
      expect(botSource).toContain("async function showStickyInteractiveMessage(");
      expect(botSource).toContain("async function restoreStickyMenuMessage(");
      expect(botSource).toContain('state.mode === "interactive"');
      expect(botSource).toContain("await showStickyInteractiveMessage(chatId, `${prompt}\\n\\nSend /cancel to abort.`");
      expect(botSource).toContain("await restoreStickyMenuMessage(chatId);");
    });

    it("recovers sticky context from reconnect callback updates", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");

      const __dirname = path.resolve(
        fileURLToPath(new URL(".", import.meta.url)),
      );
      const botSource = fs.readFileSync(
        path.resolve(__dirname, "..", "telegram", "telegram-bot.mjs"),
        "utf8",
      );
      const helperSource = fs.readFileSync(
        path.resolve(__dirname, "..", "telegram", "sticky-menu-state.mjs"),
        "utf8",
      );

      expect(botSource).toContain("function recoverStickyMenuContextFromCallback(query, reason = \"callback\")");
      expect(botSource).toContain("recoverStickyMenuContextFromCallback(query, \"reconnect\")");
      expect(helperSource).toContain("sticky_menu.context_recovered");
      expect(helperSource).toContain("sessionId: recovery.sessionId");
      expect(helperSource).toContain("leaseAgeMs: recovery.leaseAgeMs");
    });

    it("deduplicates rapid repeated menu callbacks", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");

      const __dirname = path.resolve(
        fileURLToPath(new URL(".", import.meta.url)),
      );
      const botSource = fs.readFileSync(
        path.resolve(__dirname, "..", "telegram", "telegram-bot.mjs"),
        "utf8",
      );
      const helperSource = fs.readFileSync(
        path.resolve(__dirname, "..", "telegram", "sticky-menu-state.mjs"),
        "utf8",
      );

      expect(helperSource).toContain("const callbackActionDeduper = new Map();");
      expect(botSource).toContain("const CALLBACK_ACTION_DEDUPE_MS = Math.max(");
      expect(botSource).toContain("function dedupeMenuCallbackAction({");
      expect(helperSource).toContain("function dedupeCallbackAction({");
      expect(botSource).toContain("Already processing...");
      expect(botSource).toContain("function getStickyMenuDiagnostics(chatId, now = Date.now())");
      expect(botSource).toContain("function resetStickyMenuContext(chatId, options = {})");
      expect(botSource).toContain("sticky_menu.reset_applied");
      expect(botSource).toContain("uiCmdAction(\"/menu diag\")");
      expect(botSource).toContain("uiCmdAction(\"/menu reset\")");
    });
  });

  describe("/helpfull command", () => {
    it("should have a /helpfull command registered", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");

      const __dirname = path.resolve(
        fileURLToPath(new URL(".", import.meta.url)),
      );
      const botSource = fs.readFileSync(
        path.resolve(__dirname, "..", "telegram", "telegram-bot.mjs"),
        "utf8",
      );

      expect(botSource).toContain('"/helpfull"');
      expect(botSource).toContain("cmdHelpFull");
    });
  });
});


describe("telegram sticky menu diagnostics runtime", () => {
  let stickyApi;
  let resetStickyMenuStateForTest;

  beforeEach(() => {
    stickyApi = createStickyMenuStateManager();
    resetStickyMenuStateForTest = () => stickyApi.resetAll();
    resetStickyMenuStateForTest();
  });

  it("records recovered sessions with a session identifier and lease age", () => {
    stickyApi.setState("chat-1", {
      screenId: "home",
      params: { page: 2 },
    });

    const recovery = stickyApi.recoverContextFromCallback({
      message: {
        chat: { id: "chat-1" },
        message_id: 42,
      },
      data: "ui:go:home",
    }, "reconnect");

    expect(recovery.recovered).toBe(true);
    expect(recovery.diagnostics.sessionId).toMatch(/^sticky-/);
    expect(recovery.diagnostics.leaseAgeMs).toBeGreaterThanOrEqual(0);
    expect(recovery.diagnostics.recoveryCount).toBe(1);
    expect(recovery.diagnostics.lastRecovery).toMatchObject({
      reason: "reconnect",
      messageId: 42,
      data: "ui:go:home",
    });
  });

  it("keeps duplicate callback handling idempotent with diagnostics", () => {
    stickyApi.setState("chat-1", {
      enabled: true,
      messageId: 77,
      screenId: "home",
      params: {},
      mode: "menu",
    });

    const first = stickyApi.dedupeCallbackAction({
      chatId: "chat-1",
      fromId: "operator-1",
      messageId: 77,
      data: "ui:go:home",
      callbackId: "cb-1",
    });
    const second = stickyApi.dedupeCallbackAction({
      chatId: "chat-1",
      fromId: "operator-1",
      messageId: 77,
      data: "ui:go:home",
      callbackId: "cb-2",
    });
    const diagnostics = stickyApi.getDiagnostics("chat-1");

    expect(first.duplicate).toBe(false);
    expect(first.decision).toBe("accepted");
    expect(second.duplicate).toBe(true);
    expect(second.decision).toBe("deduped");
    expect(second.sessionId).toBe(diagnostics.sessionId);
    expect(second.leaseAgeMs).toBeGreaterThanOrEqual(0);
    expect(diagnostics.lastDedupe).toMatchObject({
      decision: "deduped",
      data: "ui:go:home",
    });
  });

  it("resets only the targeted chat sticky-menu state", () => {
    stickyApi.setState("chat-1", {
      enabled: true,
      messageId: 10,
      screenId: "home",
      params: {},
      mode: "menu",
    });
    stickyApi.setState("chat-2", {
      enabled: true,
      messageId: 20,
      screenId: "home",
      params: {},
      mode: "menu",
    });

    stickyApi.dedupeCallbackAction({
      chatId: "chat-1",
      fromId: "operator-1",
      messageId: 10,
      data: "ui:go:home",
      callbackId: "chat-1-first",
    });
    stickyApi.dedupeCallbackAction({
      chatId: "chat-2",
      fromId: "operator-2",
      messageId: 20,
      data: "ui:go:home",
      callbackId: "chat-2-first",
    });

    const reset = stickyApi.resetContext("chat-1", { reason: "operator" });
    const chat1AfterReset = stickyApi.dedupeCallbackAction({
      chatId: "chat-1",
      fromId: "operator-1",
      messageId: 10,
      data: "ui:go:home",
      callbackId: "chat-1-second",
    });
    const chat2AfterReset = stickyApi.dedupeCallbackAction({
      chatId: "chat-2",
      fromId: "operator-2",
      messageId: 20,
      data: "ui:go:home",
      callbackId: "chat-2-second",
    });
    const diagnostics = stickyApi.getDiagnostics("chat-1");

    expect(reset).toMatchObject({
      applied: true,
      reason: "operator",
      previousMessageId: 10,
    });
    expect(chat1AfterReset.duplicate).toBe(false);
    expect(chat2AfterReset.duplicate).toBe(true);
    expect(diagnostics.enabled).toBe(false);
    expect(diagnostics.resetCount).toBe(1);
    expect(diagnostics.lastReset).toMatchObject({
      reason: "operator",
      previousMessageId: 10,
    });
  });
});
