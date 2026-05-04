import { describe, expect, it } from "vitest";

import { createSubagentControl } from "../agent/subagent-control.mjs";
import { createSubagentPool } from "../agent/subagent-pool.mjs";
import { createToolRunner } from "../agent/harness/tool-runner.mjs";

describe("subagent pool", () => {
  it("queues excess subagents and drains them in FIFO order", async () => {
    const events = [];
    const pool = createSubagentPool({
      onEvent: (event) => events.push(event),
    });

    const firstLease = await pool.acquire({
      poolId: "root-session",
      sessionId: "child-a",
      maxConcurrent: 1,
    });
    const secondLeasePromise = pool.acquire({
      poolId: "root-session",
      sessionId: "child-b",
      maxConcurrent: 1,
    });

    expect(pool.getPool("root-session")).toEqual(expect.objectContaining({
      activeCount: 1,
      queueDepth: 1,
    }));
    expect(events.map((event) => event.type)).toEqual([
      "subagent_pool_acquired",
      "subagent_pool_queued",
    ]);

    pool.release(firstLease, { status: "completed" });
    const secondLease = await secondLeasePromise;

    expect(secondLease.sessionId).toBe("child-b");
    expect(pool.getPool("root-session")).toEqual(expect.objectContaining({
      activeCount: 1,
      queueDepth: 0,
    }));
    expect(events.map((event) => event.type)).toEqual([
      "subagent_pool_acquired",
      "subagent_pool_queued",
      "subagent_pool_released",
      "subagent_pool_acquired",
    ]);
  });

  it("carries normalized contract summaries on leases and events", async () => {
    const events = [];
    const pool = createSubagentPool({
      onEvent: (event) => events.push(event),
    });

    const lease = await pool.acquire({
      poolId: "root-session",
      sessionId: "child-contract",
      maxConcurrent: 1,
      contract: {
        freshConversation: true,
        toolPolicy: {
          allowedTools: ["read_file", "search_files"],
          deniedTools: ["spawn_subagent"],
          allowNestedDelegation: false,
        },
        memoryPolicy: { mode: "read_only" },
        reportingPolicy: { mode: "one_way_progress" },
        escalationPolicy: { mode: "wait_for_response", waitForResponse: true },
      },
    });

    expect(lease.contract).toEqual(expect.objectContaining({
      freshConversation: true,
      toolPolicy: expect.objectContaining({
        allowedTools: ["read_file", "search_files"],
        deniedTools: ["spawn_subagent"],
        allowNestedDelegation: false,
      }),
      memoryPolicy: { mode: "read_only" },
      reportingPolicy: expect.objectContaining({ mode: "one_way_progress" }),
      escalationPolicy: expect.objectContaining({ mode: "wait_for_response", waitForResponse: true }),
    }));
    expect(events[0]).toEqual(expect.objectContaining({
      type: "subagent_pool_acquired",
      contract: expect.objectContaining({
        toolPolicy: expect.objectContaining({
          allowedTools: ["read_file", "search_files"],
        }),
      }),
    }));
  });
});

describe("subagent control", () => {
  it("returns waiting subagents when they escalate for a response", async () => {
    const control = createSubagentControl();
    control.registerSubagent({
      spawnId: "spawn-1",
      parentSessionId: "parent-1",
      childSessionId: "child-1",
      status: "running",
      contract: {
        escalationPolicy: { mode: "wait_for_response", waitForResponse: true },
      },
    });

    const waiting = control.waitForSubagent("child-1", {
      timeoutMs: 50,
      returnOn: ["waiting"],
    });
    control.escalateSubagent("child-1", {
      type: "wait_for_response",
      waitForResponse: true,
      message: "Need operator guidance",
      details: { question: "Continue?" },
    });
    const record = await waiting;

    expect(record.status).toBe("waiting");
    expect(record.escalation).toEqual(expect.objectContaining({
      type: "wait_for_response",
      waitForResponse: true,
      message: "Need operator guidance",
    }));
    expect(record.latestProgress).toEqual(expect.objectContaining({
      status: "waiting",
    }));
    expect(record.progressHistory.length).toBeGreaterThan(0);
  });
});

describe("subagent tool policy enforcement", () => {
  it("filters listed tools and blocks direct execution outside the subagent contract", async () => {
    const runner = await createToolRunner({
      toolOrchestrator: {
        listTools: () => [
          { id: "read_file" },
          { id: "write_file" },
          { id: "spawn_subagent" },
        ],
        executeTool: async (toolName, args) => ({ toolName, args }),
      },
    });
    const context = {
      subagentContract: {
        toolPolicy: {
          allowedTools: ["read_file", "write_file"],
          deniedTools: ["spawn_subagent"],
        },
      },
    };

    expect(runner.listTools(context)).toEqual([
      { id: "read_file" },
      { id: "write_file" },
    ]);
    await expect(runner.runTool("spawn_subagent", {}, context)).rejects.toThrow(
      /not allowed in this subagent contract/i,
    );
    await expect(runner.runTool("read_file", { path: "README.md" }, context)).resolves.toEqual({
      toolName: "read_file",
      args: { path: "README.md" },
    });
  });
});
