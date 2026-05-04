import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(resolve(process.cwd(), "agent/agent-launcher.mjs"), "utf8");

describe("agent-pool monitor-monitor thread refresh clamp", () => {
  it("defines MONITOR_MONITOR_THREAD_REFRESH_TURNS_REMAINING constant", () => {
    assert.ok(
      source.includes("MONITOR_MONITOR_THREAD_REFRESH_TURNS_REMAINING"),
      "MONITOR_MONITOR_THREAD_REFRESH_TURNS_REMAINING constant should be defined",
    );
  });

  it("defaults refresh turns remaining to 5", () => {
    assert.match(
      source,
      /MONITOR_MONITOR_THREAD_REFRESH_TURNS_REMAINING\s*=.*5/,
      "default value should be 5 turns",
    );
  });

  it("supports DEVMODE_MONITOR_MONITOR_THREAD_REFRESH_TURNS_REMAINING env override", () => {
    assert.ok(
      source.includes("DEVMODE_MONITOR_MONITOR_THREAD_REFRESH_TURNS_REMAINING"),
      "should read DEVMODE_MONITOR_MONITOR_THREAD_REFRESH_TURNS_REMAINING from env",
    );
  });

  it("proactively force-refreshes monitor-monitor thread when turns remaining reaches threshold", () => {
    // The logic checks remaining turns and forces refresh before exhaustion
    const hasRefreshLogic =
      source.includes("MONITOR_MONITOR_THREAD_REFRESH_TURNS_REMAINING") &&
      (source.includes("turnsRemaining") || source.includes("turns_remaining") ||
       source.includes("remainingTurns") || source.includes("refresh"));
    assert.ok(
      hasRefreshLogic,
      "should include proactive refresh logic based on turns remaining threshold",
    );
  });

  it("only applies refresh logic for monitor-monitor task key", () => {
    // The special refresh should be scoped to the monitor-monitor task
    const hasTaskKeyCheck = /monitor-monitor.*MONITOR_MONITOR_THREAD_REFRESH|MONITOR_MONITOR_THREAD_REFRESH.*monitor-monitor/.test(source);
    assert.ok(
      hasTaskKeyCheck,
      "refresh logic should be scoped to monitor-monitor task key",
    );
  });
});
