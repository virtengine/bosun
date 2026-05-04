import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "../../tui/app.mjs";
import AgentsScreen from "../../tui/screens/agents.mjs";
import SettingsScreen from "../../tui/screens/settings.mjs";
import StatusScreen from "../../tui/screens/status.mjs";
import TasksScreen from "../../tui/screens/tasks.mjs";
import TelemetryScreen from "../../tui/screens/telemetry.mjs";
import {
  monitorStatsFixture,
  sessionDetailFixture,
  sessionDiffFixture,
  sessionsFixture,
  tasksFixture,
  tuiConfigFixture,
} from "./fixtures.mjs";
import { waitFor } from "./render-helpers.mjs";
import { renderInk } from "./render-ink.mjs";

function createMockBridge() {
  const listeners = new Map();
  return {
    host: "127.0.0.1",
    port: 3080,
    connect: vi.fn(),
    disconnect: vi.fn(),
    on(event, callback) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(callback);
      return () => listeners.get(event)?.delete(callback);
    },
    async getConfigTree() {
      return tuiConfigFixture;
    },
    async saveConfigField(path, value) {
      const target = tuiConfigFixture.sections
        .flatMap((section) => section.items)
        .find((item) => item.path === path);
      if (target) {
        target.valueText = String(value);
      }
      return { ok: true, path };
    },
    emit(event, payload) {
      for (const callback of listeners.get(event) || []) callback(payload);
    },
  };
}

describe("tui screen rendering", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      const href = String(url);
      if (href.includes("/api/sessions?workspace=all")) {
        return { ok: true, json: async () => ({ ok: true, sessions: sessionsFixture }) };
      }
      if (href.includes("/api/retry-queue")) {
        return { ok: true, json: async () => ({ ok: true, ...monitorStatsFixture.retryQueue }) };
      }
      if (href.includes("/diff?workspace=all")) {
        return { ok: true, json: async () => sessionDiffFixture };
      }
      if (href.includes("/api/sessions/") && init.method !== "POST") {
        return { ok: true, json: async () => sessionDetailFixture };
      }
      if (href.includes("/api/sessions/") && init.method === "POST") {
        return { ok: true, json: async () => ({ ok: true }) };
      }
      if (href.includes("/api/tui/config")) {
        return { ok: true, json: async () => tuiConfigFixture };
      }
      return { ok: false, json: async () => ({ error: `Unhandled URL ${href}` }) };
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("renders the status screen with runtime metrics", async () => {
    const view = await renderInk(
      React.createElement(StatusScreen, {
        stats: monitorStatsFixture,
        sessions: sessionsFixture,
        tasks: tasksFixture,
      }),
      { columns: 220 },
    );

    expect(view.latestText()).toContain("Runtime Snapshot");
    expect(view.latestText()).toContain("Active Sessions: 1");
    expect(view.latestText()).toContain("Durable Runtime");
    expect(view.latestText()).toContain("State ledger / SQL");
    expect(view.latestText()).toContain("Recovery / Orphans");
    expect(view.latestText()).toContain("Executor Slots");
    expect(view.latestText()).toContain("Investigate failing build");

    await view.unmount();
  });

  it("renders the telemetry screen with durable runtime counters", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = await renderInk(
      React.createElement(TelemetryScreen, {
        stats: monitorStatsFixture,
        sessions: sessionsFixture,
        tasks: tasksFixture,
      }),
      { columns: 220 },
    );

    expect(view.latestText()).toContain("Durable Session Runtime");
    expect(view.latestText()).toContain("State ledger / SQL");
    expect(view.latestText()).toContain("Top tools");
    expect(view.latestText()).toContain("apply_patch:1");
    expect(consoleErrorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Each child in a list should have a unique "key" prop'),
    );

    await view.unmount();
  });

  it("renders the tasks screen with bucketed task counts", async () => {
    const view = await renderInk(
      React.createElement(TasksScreen, { tasks: tasksFixture }),
      { columns: 220 },
    );

    expect(view.latestText()).toContain("[F]ilter: (title, tag, id)");
    expect(view.latestText()).toContain("TODO (1)");
    expect(view.latestText()).toContain("Review PR #404");
    expect(view.latestText()).toContain("DONE (1)");

    await view.unmount();
  });

  it("renders the agents screen and loads the selected session logs", async () => {
    const bridge = createMockBridge();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = await renderInk(
      React.createElement(AgentsScreen, {
        wsBridge: bridge,
        host: "127.0.0.1",
        port: 3080,
        sessions: sessionsFixture,
        stats: monitorStatsFixture,
      }),
      { columns: 220 },
    );

    await waitFor(() => view.latestText().includes("Backoff queue (1)"));
    expect(view.latestText()).toContain("Investigate fa");
    expect(consoleErrorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Each child in a list should have a unique "key" prop'),
    );

    await view.press("l");
    await waitFor(() => view.latestText().includes("Logs"));

    expect(view.latestText()).toContain("Loaded logs for session-");
    expect(view.latestText()).toContain("assistant");

    await view.unmount();
  });

  it("opens a session detail modal on enter and renders timeline, diff, and logs", async () => {
    const bridge = createMockBridge();
    const view = await renderInk(
      React.createElement(AgentsScreen, {
        wsBridge: bridge,
        host: "127.0.0.1",
        port: 3080,
        sessions: sessionsFixture,
        stats: monitorStatsFixture,
      }),
      { columns: 220, rows: 60 },
    );

    await waitFor(() => view.text().includes("Backoff queue (1)"));
    await view.press("`r", 80);
    await waitFor(() => view.text().includes("Session Detail"));

    expect(view.text()).toContain("Task ID");
    expect(view.text()).toContain("Turn Timeline");
    expect(view.text()).toContain("Latest Diff");
    expect(view.text()).toContain("Stdout");
    expect(view.text()).toContain("[S]teer");

    await view.unmount();
  });

  it("sends a steer message from session detail and shows confirmation", async () => {
    const bridge = createMockBridge();
    const view = await renderInk(
      React.createElement(AgentsScreen, {
        wsBridge: bridge,
        host: "127.0.0.1",
        port: 3080,
        sessions: sessionsFixture,
        stats: monitorStatsFixture,
      }),
      { columns: 220, rows: 60 },
    );

    await waitFor(() => view.text().includes("Backoff queue (1)"));
    await view.press("`r", 80);
    await waitFor(() => view.text().includes("Session Detail"));

    await view.press("s", 40);
    await waitFor(() => view.text().includes("Steer message:"));
    await view.press("Please continue with focused logging", 50);
    await view.press("`r", 100);

    await waitFor(() => view.text().includes("Steer sent ✓"));
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/sessions/session-active-1/message?workspace=all"),
      expect.objectContaining({ method: "POST" }),
    );

    await view.unmount();
  });

  it("scrolls the turn timeline independently inside session detail", async () => {
    const bridge = createMockBridge();
    const view = await renderInk(
      React.createElement(AgentsScreen, {
        wsBridge: bridge,
        host: "127.0.0.1",
        port: 3080,
        sessions: sessionsFixture,
        stats: monitorStatsFixture,
      }),
      { columns: 220, rows: 60 },
    );

    await waitFor(() => view.text().includes("Backoff queue (1)"));
    await view.press("`r", 80);
    await waitFor(() => view.text().includes("| 2026-03-23 00:00:00.000 |"));
    expect(view.text()).not.toContain("| 2026-03-23 00:00:17.000 |");

    await view.press("\u001b[6~", 80);
    await waitFor(() => view.text().includes("| 2026-03-23 00:00:17.000 |"));

    await view.unmount();
  });

  it("streams live stdout into the right panel while detail is open", async () => {
    const bridge = createMockBridge();
    const view = await renderInk(
      React.createElement(AgentsScreen, {
        wsBridge: bridge,
        host: "127.0.0.1",
        port: 3080,
        sessions: sessionsFixture,
        stats: monitorStatsFixture,
      }),
      { columns: 220, rows: 60 },
    );

    await waitFor(() => view.text().includes("Backoff queue (1)"));
    await view.press("`r", 80);
    await waitFor(() => view.text().includes("Session Detail"));

    bridge.emit("logs:stream", {
      logType: "stdout",
      raw: "Steer message accepted by running session",
      line: "Steer message accepted by running session",
      level: "info",
      timestamp: "2026-03-23T00:00:31.000Z",
      filePath: "",
    });

    await waitFor(() => view.text().includes("00:00:31"));
    await view.unmount();
  });

  it("navigates app tabs with numeric key input", async () => {
    const bridge = createMockBridge();
    const view = await renderInk(
      React.createElement(App, {
        host: "127.0.0.1",
        port: 3080,
        connectOnly: true,
        initialScreen: "status",
        refreshMs: 2000,
        wsClient: bridge,
      }),
      { columns: 220 },
    );

    bridge.emit("connect", {});
    bridge.emit("stats", monitorStatsFixture);
    bridge.emit("sessions:update", { sessions: sessionsFixture });
    bridge.emit("task:create", tasksFixture[0]);
    await view.press(" ", 40);
    await waitFor(() => view.latestText().includes("Runtime Snapshot"));

    await view.press("2");
    await waitFor(() => view.latestText().includes("[F]ilter: (title, tag, id)"));

    await view.press("3");
    await waitFor(() => view.latestText().includes("Backoff queue"));

    bridge.emit("workflow:status", {
      workflowId: "workflow-1",
      workflowName: "Workflow One",
      eventType: "run:end",
      status: "completed",
      timestamp: "2026-03-23T00:00:30.000Z",
      message: "completed cleanly",
    });
    await view.press("5");
    await waitFor(() => view.latestText().includes("Workflow Event Timeline"));
    expect(view.latestText()).toContain("Workflow One");

    await view.press("6");
    await waitFor(() => view.latestText().includes("Rate Limits"));

    await view.press("7");
    await waitFor(() => view.latestText().includes("bosun.config.json"));

    await view.unmount();
    expect(bridge.connect).toHaveBeenCalled();
    expect(bridge.disconnect).toHaveBeenCalled();
  });

  it("renders the settings screen and masks env-backed secrets", async () => {
    const view = await renderInk(
      React.createElement(SettingsScreen, {
        settingsService: {
          load: async () => ({
            ok: true,
            meta: { configPath: "/tmp/bosun.config.json" },
            sections: [
              {
                id: "integrations",
                label: "Integrations",
                items: [
                  {
                    kind: "field",
                    id: "voice.openaiApiKey",
                    path: "voice.openaiApiKey",
                    depth: 0,
                    label: "openaiApiKey",
                    valueText: "super-secret",
                    sourceLabel: "from env",
                    description: "Key",
                    editorKind: "string",
                    readOnly: true,
                    envKey: "OPENAI_API_KEY",
                    masked: true,
                    enumValues: [],
                  },
                ],
              },
            ],
          }),
          save: vi.fn(),
        },
      }),
      { columns: 220 },
    );

    await waitFor(() => view.latestText().includes("voice.openaiApiKey"));
    expect(view.text()).toContain("****");
    expect(view.text()).toContain("🔒 Locked by OPENAI_API_KEY");

    await view.unmount();
  });
  it("shows the always-visible footer help and toggles the help overlay", async () => {
    const bridge = createMockBridge();
    const view = await renderInk(
      React.createElement(App, {
        host: "127.0.0.1",
        port: 3080,
        connectOnly: true,
        initialScreen: "status",
        refreshMs: 2000,
        wsClient: bridge,
      }),
      { columns: 220, rows: 20 },
    );

    bridge.emit("connect", {});
    bridge.emit("stats", monitorStatsFixture);
    bridge.emit("sessions:update", { sessions: sessionsFixture });
    bridge.emit("task:create", tasksFixture[0]);
    await view.press(" ", 40);
    await waitFor(() => view.text().includes("? Help"));
    expect(view.text()).toContain("[1] Status");

    await view.press("?");
    await waitFor(() => view.text().includes("Keyboard Shortcuts"), { timeoutMs: 3000 });
    expect(view.text()).toContain("Global");
    expect(view.text()).toContain("Agents screen");
    expect(view.text()).toContain("Modals");

    await view.press("?");
    await view.press(" ", 40);
    await waitFor(() => view.text().includes("? Help"));

    await view.unmount();
  });

  it("updates footer hints when task form focus changes", async () => {
    const bridge = createMockBridge();
    const view = await renderInk(
      React.createElement(App, {
        host: "127.0.0.1",
        port: 3080,
        connectOnly: true,
        initialScreen: "tasks",
        refreshMs: 2000,
        wsClient: bridge,
      }),
      { columns: 220, rows: 20 },
    );

    bridge.emit("connect", {});
    bridge.emit("task:create", tasksFixture[0]);
    await view.press(" ", 40);
    await waitFor(() => view.latestText().includes("[F]ilter: (title, tag, id)"));
    expect(view.latestText()).toContain("N New");
    expect(view.latestText()).toContain("? Help");

    const baseline = view.latestText();
    await view.press("n");
    await waitFor(() => view.latestText().includes("New Task"));
    const updated = view.latestText().slice(baseline.length);
    expect(updated).toContain("Ctrl+S Save");
    expect(updated).toContain("Esc Cancel");
    expect(updated).not.toContain("N New  |  E Edit  |  D Delete");

    await view.unmount();
  });
});
