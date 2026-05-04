import { beforeEach, describe, expect, it, vi } from "vitest";

let wsHandler = null;

vi.mock("../ui/modules/api.js", () => ({
  wsConnected: { value: true, subscribe: () => () => {} },
  onWsMessage: (handler) => {
    wsHandler = handler;
    return () => {};
  },
  wsSend: vi.fn(),
  apiFetch: vi.fn(),
}));

describe("streaming agent status session identity", () => {
  beforeEach(() => {
    wsHandler = null;
    vi.resetModules();
  });

  it("prefers payload.session.id over payload.taskId for state matching", async () => {
    const { startAgentStatusTracking, agentStatus } = await import("../ui/modules/streaming.js");

    startAgentStatusTracking();
    expect(typeof wsHandler).toBe("function");

    wsHandler({
      type: "session-message",
      payload: {
        taskId: "task-123",
        session: { id: "session-abc", type: "primary", status: "active" },
        message: { role: "assistant", type: "agent_message", content: "hello" },
      },
    });

    expect(agentStatus.value.state).toBe("streaming");
    expect(agentStatus.value.sessionId).toBe("session-abc");

    wsHandler({
      type: "invalidate",
      payload: { reason: "agent-response", sessionId: "session-abc" },
    });

    expect(agentStatus.value.state).toBe("idle");
    expect(agentStatus.value.sessionId).toBe("");
  });

  it("clears thinking state on explicit stop/finish signals and direct failure resets", async () => {
    const {
      startAgentStatusTracking,
      agentStatus,
      markUserMessageSent,
      clearAgentStatus,
    } = await import("../ui/modules/streaming.js");

    startAgentStatusTracking();
    expect(typeof wsHandler).toBe("function");

    markUserMessageSent("primary", "session-stuck");
    expect(agentStatus.value.state).toBe("thinking");
    expect(agentStatus.value.sessionId).toBe("session-stuck");

    clearAgentStatus("different-session");
    expect(agentStatus.value.state).toBe("thinking");

    wsHandler({
      type: "invalidate",
      payload: { reason: "agent-stopped", sessionId: "session-stuck" },
    });
    expect(agentStatus.value.state).toBe("idle");
    expect(agentStatus.value.sessionId).toBe("");

    markUserMessageSent("primary", "session-finished");
    wsHandler({
      type: "invalidate",
      payload: { reason: "session-turn-finished", sessionId: "session-finished" },
    });
    expect(agentStatus.value.state).toBe("idle");
    expect(agentStatus.value.sessionId).toBe("");

    markUserMessageSent("primary", "session-direct-clear");
    clearAgentStatus("session-direct-clear");
    expect(agentStatus.value.state).toBe("idle");
    expect(agentStatus.value.sessionId).toBe("");
  });
});
