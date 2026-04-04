import React from "react";
import { describe, expect, it } from "vitest";

import App from "../../tui/app.mjs";
import { FIXTURE_SESSIONS, FIXTURE_STATS, FIXTURE_TASKS, createMockWsClient } from "./fixtures.mjs";
import { renderInk } from "./render-ink.mjs";
import { waitFor } from "./render-helpers.mjs";

describe("tui app integration", () => {
  it("navigates between screens and applies websocket updates through the injected client", async () => {
    const wsClient = createMockWsClient();

    const view = await renderInk(
      React.createElement(App, {
        host: "127.0.0.1",
        port: 3080,
        connectOnly: true,
        initialScreen: "status",
        refreshMs: 2000,
        wsClient,
      }),
      { columns: 220 },
    );

    wsClient.emit("connect", {});
    wsClient.emit("stats", FIXTURE_STATS);
    wsClient.emit("sessions:update", { sessions: FIXTURE_SESSIONS });
    wsClient.emit("tasks:update", {
      reason: "task-created",
      sourceEvent: "task:created",
      patch: FIXTURE_TASKS[0],
    });

    await view.press(" ", 40);
    expect(view.text()).toContain("Connected");
    expect(view.text()).toContain("Runtime Snapshot");

    await view.press("2");
    await waitFor(() => view.text().includes("[F]ilter: (title, tag, id)"));

    wsClient.emit("task:create", FIXTURE_TASKS[4]);
    await view.press(" ", 40);
    await waitFor(() => view.text().includes("Ship smoke test"));

    await view.press("3");
    await waitFor(() => view.text().includes("Backoff queue"));
    expect(view.text()).toContain("Synthesized failing smoke test");

    wsClient.emit("workflow:status", {
      workflowId: "wf-1",
      workflowName: "Task Lifecycle",
      eventType: "run:start",
      status: "running",
      timestamp: "2026-03-23T00:00:45.000Z",
      message: "started from integration test",
    });
    await view.press("5");
    await waitFor(() => view.text().includes("Workflow Event Timeline"));
    expect(view.text()).toContain("Task Lifecycle");

    await view.press("6");
    await waitFor(() => view.text().includes("Rate Limits"));
    expect(view.text()).toContain("Retry Queue");

    await view.press("7");
    await waitFor(() => view.text().includes("bosun.config.json"));
    expect(view.text()).toContain("Schema-backed inline editor.");

    await view.unmount();
    expect(wsClient.connectCalled).toBeGreaterThanOrEqual(1);
    expect(wsClient.disconnectCalled).toBeGreaterThanOrEqual(1);
  });
});
