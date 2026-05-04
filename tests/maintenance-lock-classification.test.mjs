import { describe, expect, it } from "vitest";

import {
  classifyBosunHelperProcess,
  classifyMonitorCommandLine,
  shouldAssumeMonitorForUnknownOwner,
} from "../infra/maintenance.mjs";

describe("monitor lock command-line classification", () => {
  it("classifies absolute monitor path as monitor", () => {
    const cmd = "C:/Program Files/nodejs/node.exe C:/repos/bosun/monitor.mjs";
    expect(classifyMonitorCommandLine(cmd)).toBe("monitor");
  });

  it("classifies relative node monitor launch as monitor", () => {
    const cmd = "node monitor.mjs --self-restart";
    expect(classifyMonitorCommandLine(cmd)).toBe("monitor");
  });

  it("classifies dot-slash monitor launch as monitor", () => {
    const cmd = "node ./monitor.mjs --self-restart";
    expect(classifyMonitorCommandLine(cmd)).toBe("monitor");
  });

  it("classifies eval-import monitor launch as monitor", () => {
    const cmd = "node -e \"import('./monitor.mjs')\"";
    expect(classifyMonitorCommandLine(cmd)).toBe("monitor");
  });

  it("classifies cli monitorMonitor launch as monitor", () => {
    const cmd = "node C:/repos/bosun/cli.mjs monitorMonitor";
    expect(classifyMonitorCommandLine(cmd)).toBe("monitor");
  });

  it("classifies unrelated process as other", () => {
    const cmd = "python -m http.server 18432";
    expect(classifyMonitorCommandLine(cmd)).toBe("other");
  });

  it("classifies monitor.mjs sub-command invocation as other (not daemon)", () => {
    const cmd =
      "C:/nvm4w/nodejs/node.exe C:/Users/user/AppData/Local/nvm/v24.11.1/node_modules/bosun/infra/monitor.mjs agent list --json --active";
    expect(classifyMonitorCommandLine(cmd)).toBe("other");
  });

  it("classifies monitor.mjs with only flag args as monitor (daemon mode)", () => {
    const cmd =
      "C:/nvm4w/nodejs/node.exe C:/Users/user/AppData/Local/nvm/v24.11.1/node_modules/bosun/infra/monitor.mjs --daemon-child";
    expect(classifyMonitorCommandLine(cmd)).toBe("monitor");
  });
});

describe("Bosun helper-process classification", () => {
  it("classifies temporary bosun ui probe helpers", () => {
    const cmd =
      "C:/nvm4w/nodejs/node.exe -e \"const mod = await import('./server/ui-server.mjs'); const { chromium } = await import('playwright'); const server = await mod.startTelegramUiServer({ port: 0, host: '127.0.0.1', skipInstanceLock: true, skipAutoOpen: true }); const browser = await chromium.launch({ headless: true });\"";
    expect(classifyBosunHelperProcess(cmd)).toBe("bosun-ui-probe");
  });

  it("classifies playwright browser temp profiles as helper browsers", () => {
    const cmd =
      "\"C:/Program Files/Google/Chrome/Application/chrome.exe\" --user-data-dir=\"C:/Users/test/AppData/Local/Temp/playwright_chromiumdev_profile-abc123\" --remote-debugging-port=9222";
    expect(classifyBosunHelperProcess(cmd)).toBe("playwright-browser");
  });

  it("does not classify regular bosun monitor or user browser processes as stale helpers", () => {
    expect(
      classifyBosunHelperProcess(
        "C:/nvm4w/nodejs/node.exe C:/repos/bosun/infra/monitor.mjs --daemon-child",
      ),
    ).toBe(null);
    expect(
      classifyBosunHelperProcess(
        "\"C:/Program Files/Google/Chrome/Application/chrome.exe\" https://192.168.0.183:4400/",
      ),
    ).toBe(null);
  });
});

describe("unknown lock owner fallback", () => {
  const nowMs = Date.parse("2026-02-25T15:30:00.000Z");

  it("assumes monitor for recent monitor-like PID payload", () => {
    const pidFileData = {
      argv: ["node", "C:/repos/bosun/monitor.mjs"],
      started_at: "2026-02-25T15:28:30.000Z",
    };
    expect(shouldAssumeMonitorForUnknownOwner(pidFileData, nowMs)).toBe(true);
  });

  it("does not assume monitor for stale monitor-like PID payload", () => {
    const pidFileData = {
      argv: ["node", "C:/repos/bosun/monitor.mjs"],
      started_at: "2026-02-25T15:20:00.000Z",
    };
    expect(shouldAssumeMonitorForUnknownOwner(pidFileData, nowMs)).toBe(false);
  });

  it("does not assume monitor when argv does not look like monitor", () => {
    const pidFileData = {
      argv: ["python", "-m", "http.server"],
      started_at: "2026-02-25T15:29:00.000Z",
    };
    expect(shouldAssumeMonitorForUnknownOwner(pidFileData, nowMs)).toBe(false);
  });
});


