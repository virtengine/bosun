import { describe, expect, it, vi } from "vitest";
import {
  buildHarnessApprovalPath,
  buildHarnessProviderSdkPath,
  buildHarnessRunPath,
  buildHarnessSubagentPath,
  buildHarnessThreadPath,
} from "../ui/modules/harness-client.js";
import {
  buildCanonicalSessionApiPath,
  buildCanonicalSessionsApiPath,
} from "../ui/modules/session-api.js";
import {
  createTelegramHarnessApiClient,
  createTelegramWorkspaceApiClient,
} from "../telegram/harness-api-client.mjs";

describe("harness surface clients", () => {
  it("keeps canonical identifiers stable across UI/TUI route helpers", () => {
    expect(buildCanonicalSessionApiPath("session-123", "message", { workspace: "all" }))
      .toBe("/api/sessions/session-123/message?workspace=all");
    expect(buildCanonicalSessionsApiPath({ workspace: "active", status: "active" }))
      .toBe("/api/sessions?workspace=active&status=active");
    expect(buildHarnessRunPath("run-456", "events", { limit: 40, direction: "desc" }))
      .toBe("/api/harness/runs/run-456/events?limit=40&direction=desc");
    expect(buildHarnessApprovalPath("approval-789", "resolve"))
      .toBe("/api/harness/approvals/approval-789/resolve");
    expect(buildHarnessSubagentPath("session-123", { includeThreads: true }))
      .toBe("/api/harness/subagents/session-123?includeThreads=true");
    expect(buildHarnessThreadPath("task-key-1", "invalidate"))
      .toBe("/api/harness/threads/task-key-1/invalidate");
    expect(buildHarnessThreadPath("", "reset"))
      .toBe("/api/harness/threads/reset");
    expect(buildHarnessProviderSdkPath()).toBe("/api/providers/sdk");
  });

  it("routes Telegram session, provider, and thread mutations through canonical APIs", async () => {
    const request = vi.fn(async (path, options = {}) => ({ ok: true, path, options }));
    const client = createTelegramHarnessApiClient(request);

    await client.createSession({ type: "primary" });
    await client.getSession("session-123");
    await client.sendSessionMessage("session-123", { content: "hi" });
    await client.stopSession("session-123");
    await client.deleteSession("session-123");
    await client.getProviderSelection();
    await client.setProviderSelection("codex");
    await client.listThreads();
    await client.clearThreads();
    await client.invalidateThread("task-key-1");
    await client.getSurface("agents", 12);
    await client.getLogs(45);

    expect(request.mock.calls.map(([path]) => path)).toEqual([
      "/api/sessions/create",
      "/api/sessions/session-123?workspace=all&full=1",
      "/api/sessions/session-123/message?workspace=all",
      "/api/sessions/session-123/stop?workspace=all",
      "/api/sessions/session-123/delete?workspace=all",
      "/api/providers/sdk",
      "/api/providers/sdk",
      "/api/harness/threads",
      "/api/harness/threads/reset",
      "/api/harness/threads/task-key-1/invalidate",
      "/api/harness/surface?view=agents&limit=12",
      "/api/logs?lines=45",
    ]);
  });

  it("routes Telegram workspace orchestration through explicit client helpers", async () => {
    const request = vi.fn(async (host, path, options = {}) => ({ ok: true, host, path, options }));
    const client = createTelegramWorkspaceApiClient(request);

    await client.listTaskAttemptSummaries("http://workspace-a");
    await client.listSessions("http://workspace-a", "ws-1");
    await client.createSession("http://workspace-a", "ws-1");
    await client.queueSessionMessage("http://workspace-a", "session-123", { message: "hi" });
    await client.sendFollowUp("http://workspace-a", "session-123", { prompt: "follow up" });

    expect(request.mock.calls).toEqual([
      ["http://workspace-a", "/api/task-attempts/summary", { method: "POST", body: { archived: false } }],
      ["http://workspace-a", "/api/sessions?workspace_id=ws-1"],
      ["http://workspace-a", "/api/sessions", { method: "POST", body: { workspace_id: "ws-1" } }],
      ["http://workspace-a", "/api/sessions/session-123/queue", { method: "POST", body: { message: "hi" } }],
      ["http://workspace-a", "/api/sessions/session-123/follow-up", { method: "POST", body: { prompt: "follow up" } }],
    ]);
  });
});
