import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createHarnessSessionManager } from "../agent/session-manager.mjs";
import {
  flushHarnessTelemetryRuntimeForTests,
  listHarnessTelemetryEvents,
  resetHarnessObservabilitySpinesForTests,
} from "../infra/session-telemetry.mjs";
import { createShellSessionCompat } from "../shell/shell-session-compat.mjs";

afterEach(() => {
  resetHarnessObservabilitySpinesForTests();
});

describe("shell-session-compat", () => {
  it("resolves shell provider aliases through the provider kernel", () => {
    const compat = createShellSessionCompat({ adapterName: "codex" });
    expect(compat.resolveProvider({ providerSelection: "codex" }).providerId).toBe("openai-codex-subscription");
    expect(compat.resolveProvider({ providerSelection: "claude" }).providerId).toBe("claude-subscription-shim");
    expect(compat.resolveProvider({ providerSelection: "opencode" }).providerId).toBe("openai-compatible");
    expect(compat.resolveProvider({ providerSelection: "copilot" }).providerId).toBe("copilot-oauth");
  });

  it("delegates lifecycle into the session manager and emits canonical shell telemetry", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "bosun-shell-compat-"));
    const sessionManager = createHarnessSessionManager();
    const compat = createShellSessionCompat({
      adapterName: "codex",
      configDir,
      sessionManager,
    });

    compat.beginTurn("shell-session-1", {
      activate: true,
      threadId: "provider-thread-1",
      cwd: configDir,
      providerSelection: "codex",
      metadata: { turnCount: 1 },
    });
    compat.completeTurn("shell-session-1", {
      activate: true,
      threadId: "provider-thread-1",
      cwd: configDir,
      providerSelection: "codex",
      metadata: { turnCount: 2 },
    });

    await flushHarnessTelemetryRuntimeForTests();

    expect(sessionManager.getSession("shell-session-1")).toMatchObject({
      sessionId: "shell-session-1",
      activeThreadId: "provider-thread-1",
      status: "completed",
      sessionType: "primary",
    });

    const events = listHarnessTelemetryEvents({ source: "shell-session-compat" }, { configDir });
    expect(events.some((event) => event.eventType === "shell.session.running")).toBe(true);
    expect(events.some((event) => event.eventType === "shell.session.completed")).toBe(true);
    expect(events.some((event) => event.providerId === "openai-codex-subscription")).toBe(true);
  });

  it("keeps session-manager state authoritative over shell fallback info", () => {
    const sessionManager = createHarnessSessionManager();
    const compat = createShellSessionCompat({
      adapterName: "codex",
      sessionManager,
    });

    compat.beginTurn("shell-session-override", {
      activate: true,
      threadId: "provider-thread-managed",
      cwd: "/managed/cwd",
      providerSelection: "codex",
      metadata: { turnCount: 4, managed: true },
    });

    const info = compat.getSessionInfo({
      sessionId: "shell-session-override",
      threadId: "provider-thread-fallback",
      cwd: "/fallback/cwd",
      status: "failed",
      metadata: { localHint: true },
    });

    expect(info).toMatchObject({
      sessionId: "shell-session-override",
      threadId: "provider-thread-managed",
      cwd: "/managed/cwd",
      status: "running",
    });
    expect(info.metadata).toMatchObject({
      managed: true,
      localHint: true,
    });
  });

  it("creates a canonical tool gateway that records shell tool events", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "bosun-shell-tool-compat-"));
    const compat = createShellSessionCompat({
      adapterName: "codex",
      configDir,
    });

    const gateway = compat.createToolGateway({
      sessionId: "shell-session-2",
      cwd: configDir,
      providerSelection: "codex",
      toolSources: [{
        source: "test-tools",
        definitions: [{
          id: "echo",
          name: "Echo",
          handler: async (_args) => ({
            ok: true,
            stdout: "echo",
            exitCode: 0,
          }),
        }],
      }],
    });

    const result = await gateway.execute("echo", { text: "hello" }, {
      sessionId: "shell-session-2",
      cwd: configDir,
      requestedBy: "shell",
    });

    await flushHarnessTelemetryRuntimeForTests();

    expect(result).toMatchObject({
      ok: true,
      stdout: "echo",
      exitCode: 0,
    });

    const events = listHarnessTelemetryEvents({ source: "shell-session-compat" }, { configDir });
    expect(events.some((event) => event.eventType === "shell.tool.event")).toBe(true);
    expect(events.some((event) => event.category === "tool")).toBe(true);
  });
});
