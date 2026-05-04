import { afterEach, describe, expect, it, vi } from "vitest";

import { createHarnessSessionManager } from "../agent/session-manager.mjs";
import { createShellSessionCompat } from "../shell/shell-session-compat.mjs";
import { createTelegramHarnessApiClient } from "../telegram/harness-api-client.mjs";
import { TuiWsBridge } from "../tui/lib/ws-bridge.mjs";
import {
  buildHarnessProviderSdkPath,
  buildHarnessSurfacePath,
  buildHarnessThreadPath,
} from "../ui/modules/harness-client.js";
import {
  beginWorkflowLinkedSessionExecution,
  finalizeWorkflowLinkedSessionExecution,
} from "../workflow/harness-session-node.mjs";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("harness surface integration", () => {
  it("routes chat shells and workflow-linked sessions through the same canonical session manager", () => {
    const sessionManager = createHarnessSessionManager();
    const shellCompat = createShellSessionCompat({
      adapterName: "codex",
      sessionManager,
    });

    shellCompat.beginTurn("chat-surface-session", {
      activate: true,
      threadId: "chat-surface-thread",
      cwd: process.cwd(),
      providerSelection: "codex",
      metadata: {
        surface: "chat",
      },
    });

    const workflowContext = {
      id: "workflow-surface-run",
      data: {
        _workflowId: "wf-surface",
        _workflowName: "Surface Cutover",
        _workflowSessionId: "chat-surface-session",
        _workflowRootSessionId: "chat-surface-session",
        _workflowParentSessionId: "chat-surface-session",
        _workflowRootRunId: "workflow-surface-run",
        taskId: "TASK-SURFACE",
        taskTitle: "Surface proof",
      },
    };
    const workflowNode = {
      id: "workflow-agent",
      label: "Workflow Agent",
    };
    const workflowLink = beginWorkflowLinkedSessionExecution(
      workflowContext,
      workflowNode,
      { services: { sessionManager } },
      {
        sessionId: "workflow-surface-session",
        threadId: "workflow-surface-thread",
        parentSessionId: "chat-surface-session",
        rootSessionId: "chat-surface-session",
        taskId: "TASK-SURFACE",
        taskTitle: "Surface proof",
        taskKey: "TASK-SURFACE:workflow",
        cwd: process.cwd(),
        metadata: {
          surface: "workflow",
        },
      },
    );

    const normalized = finalizeWorkflowLinkedSessionExecution(workflowLink, {
      success: true,
      status: "completed",
      threadId: "workflow-surface-thread",
      result: {
        ok: true,
      },
    });

    expect(sessionManager.getSession("chat-surface-session")).toEqual(
      expect.objectContaining({
        sessionId: "chat-surface-session",
        sessionType: "primary",
      }),
    );
    expect(sessionManager.getSession("workflow-surface-session")).toEqual(
      expect.objectContaining({
        sessionId: "workflow-surface-session",
        parentSessionId: "chat-surface-session",
        rootSessionId: "chat-surface-session",
      }),
    );
    expect(normalized).toEqual(
      expect.objectContaining({
        sessionId: "workflow-surface-session",
        lineage: expect.objectContaining({
          parentSessionId: "chat-surface-session",
          rootSessionId: "chat-surface-session",
          childSessionId: "workflow-surface-session",
        }),
      }),
    );
  });

  it("keeps web UI, TUI, and Telegram on the same canonical harness endpoints", async () => {
    const telegramCalls = [];
    const telegramApi = createTelegramHarnessApiClient(async (path, options = {}) => {
      telegramCalls.push({ path, options });
      return {
        ok: true,
        path,
      };
    });

    await telegramApi.getProviderSelection();
    await telegramApi.setProviderSelection("openai-compatible");
    await telegramApi.listThreads();
    await telegramApi.invalidateThread("TASK-SURFACE");

    expect(telegramCalls.map((entry) => entry.path)).toEqual([
      buildHarnessProviderSdkPath(),
      buildHarnessProviderSdkPath(),
      buildHarnessThreadPath(),
      buildHarnessThreadPath("TASK-SURFACE", "invalidate"),
    ]);

    const requestedUrls = [];
    globalThis.fetch = vi.fn(async (url, options = {}) => {
      const resolvedUrl = new URL(String(url));
      requestedUrls.push({
        url: resolvedUrl.toString(),
        options,
      });
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            ok: true,
            path: `${resolvedUrl.pathname}${resolvedUrl.search}`,
          });
        },
      };
    });

    const bridge = new TuiWsBridge({
      host: "127.0.0.1",
      port: 3080,
      apiKey: "tui-cutover-key",
      WebSocketImpl: class WebSocketStub {
        static OPEN = 1;
        constructor() {
          this.readyState = 1;
        }
        close() {}
        send() {}
      },
    });

    const surfacePath = buildHarnessSurfacePath("agents", { limit: 12 });
    const response = await bridge.requestJson(surfacePath);

    expect(response.path).toBe(surfacePath);
    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0].url).toContain(surfacePath);
    expect(requestedUrls[0].options).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-api-key": "tui-cutover-key",
        }),
      }),
    );
  });
});
