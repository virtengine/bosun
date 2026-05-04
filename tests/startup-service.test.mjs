import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const execSyncMock = vi.hoisted(() => vi.fn());
const spawnSyncMock = vi.hoisted(() => vi.fn(() => ({ status: 0, stdout: "", stderr: "" })));
const existsSyncMock = vi.hoisted(() => vi.fn(() => false));
const readFileSyncMock = vi.hoisted(() => vi.fn(() => ""));
const writeFileSyncMock = vi.hoisted(() => vi.fn());
const unlinkSyncMock = vi.hoisted(() => vi.fn());
const mkdirSyncMock = vi.hoisted(() => vi.fn());

// Mock child_process and fs before importing the module
vi.mock("node:child_process", () => {
  return {
    execSync: execSyncMock,
    spawnSync: spawnSyncMock,
  };
});

vi.mock("node:fs", () => {
  return {
    existsSync: existsSyncMock,
    readFileSync: readFileSyncMock,
    writeFileSync: writeFileSyncMock,
    unlinkSync: unlinkSyncMock,
    mkdirSync: mkdirSyncMock,
  };
});

describe("startup-service", () => {
  let mod;

  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });
    existsSyncMock.mockReturnValue(false);
    readFileSyncMock.mockReturnValue("");

    // Dynamic import to pick up fresh mocks each time
    mod = await import("../infra/startup-service.mjs");
  });

  describe("getStartupStatus", () => {
    it("returns an object with installed property", () => {
      const status = mod.getStartupStatus();
      expect(status).toHaveProperty("installed");
      expect(status).toHaveProperty("method");
    });

    it("returns installed: false when no service is registered", () => {
      // execSync throws = not found
      execSyncMock.mockImplementation(() => {
        throw new Error("not found");
      });
      existsSyncMock.mockReturnValue(false);

      const status = mod.getStartupStatus();
      expect(status.installed).toBe(false);
    });
  });

  describe("getStartupMethodName", () => {
    it("returns a non-empty string", () => {
      const name = mod.getStartupMethodName();
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
    });

    it("returns platform-appropriate method name", () => {
      const name = mod.getStartupMethodName();
      const validNames = [
        "Windows Task Scheduler",
        "macOS launchd",
        "systemd user service",
        "unsupported",
      ];
      expect(validNames).toContain(name);
    });
  });

  describe("installStartupService", () => {
    it("returns a result object with success field", async () => {
      // Mock execSync for schtasks/launchctl/systemctl behaviors
      execSyncMock.mockImplementation(() => "");
      existsSyncMock.mockReturnValue(false);
      mkdirSyncMock.mockImplementation(() => {});
      writeFileSyncMock.mockImplementation(() => {});

      const result = await mod.installStartupService({ daemon: true });
      expect(result).toHaveProperty("success");
      expect(result).toHaveProperty("method");
    });

    it("returns success: true on successful install", async () => {
      execSyncMock.mockImplementation(() => "");
      existsSyncMock.mockReturnValue(false);

      const result = await mod.installStartupService({ daemon: true });
      expect(result.success).toBe(true);
    });

    it("handles install failure gracefully", async () => {
      execSyncMock.mockImplementation(() => {
        throw new Error("permission denied");
      });
      existsSyncMock.mockReturnValue(false);

      const result = await mod.installStartupService();
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("removeStartupService", () => {
    it("returns a result object with success field", async () => {
      execSyncMock.mockImplementation(() => "");
      existsSyncMock.mockReturnValue(false);

      const result = await mod.removeStartupService();
      expect(result).toHaveProperty("success");
      expect(result).toHaveProperty("method");
    });

    it("handles remove when no service exists gracefully", async () => {
      execSyncMock.mockImplementation(() => {
        throw new Error("not found");
      });
      existsSyncMock.mockReturnValue(false);

      const result = await mod.removeStartupService();
      // On some platforms remove returns success:false when nothing to remove, that's fine
      expect(result).toHaveProperty("success");
    });
  });
});
