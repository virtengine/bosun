/**
 * @module tests/telegram-sentinel.test.mjs
 * @description Unit tests for the Telegram sentinel system.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  startSentinel,
  stopSentinel,
  getSentinelStatus,
  getSentinelRecoveryStatus,
  __setRecoveryStateForTest,
  isMonitorRunning,
  ensureMonitorRunning,
  getQueuedCommands,
  parsePidFileValue,
} from "../telegram/telegram-sentinel.mjs";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cacheDir = resolve(__dirname, "..", ".cache", "test-sentinel");

describe("telegram-sentinel", () => {
  beforeEach(() => {
    mkdirSync(cacheDir, { recursive: true });
    // Ensure env vars aren't set (so sentinel doesn't try to start polling)
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
  });

  afterEach(() => {
    try {
      for (const f of [
        resolve(cacheDir, "sentinel-heartbeat.json"),
        resolve(cacheDir, "sentinel-command-queue.json"),
      ]) {
        if (existsSync(f)) unlinkSync(f);
      }
    } catch {
      /* best effort */
    }
  });

  describe("module exports", () => {
    it("should export the required functions", () => {
      expect(typeof startSentinel).toBe("function");
      expect(typeof stopSentinel).toBe("function");
      expect(typeof getSentinelStatus).toBe("function");
      expect(typeof getSentinelRecoveryStatus).toBe("function");
      expect(typeof __setRecoveryStateForTest).toBe("function");
      expect(typeof isMonitorRunning).toBe("function");
      expect(typeof ensureMonitorRunning).toBe("function");
      expect(typeof getQueuedCommands).toBe("function");
      expect(typeof parsePidFileValue).toBe("function");
    });
  });

  describe("harness session continuity", () => {
    it("pins sentinel primary-agent fallbacks onto stable managed session ids", () => {
      const source = readFileSync(
        resolve(process.cwd(), "telegram", "telegram-sentinel.mjs"),
        "utf8",
      );
      expect(source).toContain('sessionId: "sentinel-repair-agent"');
      expect(source).toContain('sessionId: `sentinel-fallback-${chatId}`');
      expect(source).toContain('sessionType: "telegram-sentinel"');
    });
  });

  describe("pid file parsing", () => {
    it("parses plain numeric PID payload", () => {
      expect(parsePidFileValue("1234\n")).toBe(1234);
    });

    it("parses JSON PID payload written by monitor lock", () => {
      const raw = JSON.stringify({
        pid: 91628,
        started_at: "2026-02-25T15:31:54.796Z",
        argv: ["node", "monitor.mjs"],
      });
      expect(parsePidFileValue(raw)).toBe(91628);
    });

    it("returns null for malformed payload", () => {
      expect(parsePidFileValue("{not-json")).toBeNull();
      expect(parsePidFileValue("")).toBeNull();
    });
  });

  describe("getSentinelStatus", () => {
    it("should return a valid status object", () => {
      const status = getSentinelStatus();
      expect(status).toBeDefined();
      expect(typeof status.pid).toBe("number");
      expect(typeof status.running).toBe("boolean");
      expect(typeof status.mode).toBe("string");
      expect(["standalone", "companion"]).toContain(status.mode);
      expect(typeof status.commandsQueued).toBe("number");
      expect(typeof status.commandsProcessed).toBe("number");
    });
  });

  describe("isMonitorRunning", () => {
    it("should return false when no PID file exists", () => {
      const running = isMonitorRunning();
      expect(typeof running).toBe("boolean");
    });
  });

  describe("getQueuedCommands", () => {
    it("should return an empty array initially", () => {
      const queue = getQueuedCommands();
      expect(Array.isArray(queue)).toBe(true);
      expect(queue.length).toBe(0);
    });
  });

  describe("stopSentinel", () => {
    it("should be callable without error when not running", () => {
      expect(() => stopSentinel()).not.toThrow();
    });
  });

  describe("recovery status", () => {
    it("reports crash-loop when threshold is reached", () => {
      const now = Date.now();
      __setRecoveryStateForTest({
        monitorCrashEvents: [now - 60_000, now - 30_000, now - 10_000],
        monitorRestartAttempts: [now - 60_000],
      });
      const status = getSentinelRecoveryStatus();
      expect(status.crashLoopDetected).toBe(true);
      expect(status.crashesInWindow).toBeGreaterThanOrEqual(3);
    });
  });
});
