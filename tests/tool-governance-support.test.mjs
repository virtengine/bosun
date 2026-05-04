import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildToolExecutionEnvelope,
  mergeToolRuntimeContext,
  normalizeToolRuntimeContext,
} from "../agent/tool-runtime-context.mjs";
import { createToolOrchestrator } from "../agent/tool-orchestrator.mjs";
import {
  composeToolRegistryEntries,
  createToolRegistry,
  resolveToolDefinition,
} from "../agent/tool-registry.mjs";
import {
  createToolApprovalManager,
  evaluateToolApproval,
} from "../agent/tool-approval-manager.mjs";
import {
  createToolNetworkPolicy,
  evaluateToolNetworkPolicy,
} from "../agent/tool-network-policy.mjs";
import {
  materializeTruncatedToolOutput,
  truncateText,
  truncateToolOutput,
} from "../agent/tool-output-truncation.mjs";
import {
  truncateCompactedPreviewText,
  truncateCompactedToolOutput,
} from "../workspace/context-cache.mjs";
import { resetBosunHotPathRuntimeForTests } from "../lib/hot-path-runtime.mjs";
import {
  getApprovalRequestById,
  resolveApprovalRequest,
} from "../workflow/approval-queue.mjs";

describe("tool governance support", () => {
  const tempRoots = [];

  afterEach(() => {
    resetBosunHotPathRuntimeForTests();
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // best effort cleanup
      }
    }
  });

  it("normalizes runtime context and builds a stable execution envelope", () => {
    const context = normalizeToolRuntimeContext({
      sessionId: "session-1",
      surface: "tui",
      approvalMode: "manual",
      requestedHosts: ["api.openai.com"],
      metadata: { step: "plan" },
    }, {
      cwd: "C:/repo",
      repoRoot: "C:/repo",
      agentProfileId: "architect",
      approval: { scopeType: "harness-run", scopeId: "run-1" },
    });
    const merged = mergeToolRuntimeContext(
      { sessionId: "session-1", metadata: { keep: true } },
      { runId: "run-2", metadata: { step: "apply" } },
    );
    const envelope = buildToolExecutionEnvelope("list_tasks", { limit: 2 }, context);

    expect(context).toMatchObject({
      cwd: "C:/repo",
      repoRoot: "C:/repo",
      sessionId: "session-1",
      agentProfileId: "architect",
      surface: "tui",
      approval: {
        mode: "manual",
        scopeType: "harness-run",
        scopeId: "run-1",
      },
      network: {
        mode: "inherit",
        requestedHosts: ["api.openai.com"],
      },
    });
    expect(merged).toMatchObject({
      sessionId: "session-1",
      runId: "run-2",
      metadata: { keep: true, step: "apply" },
    });
    expect(envelope).toMatchObject({
      executionId: expect.stringMatching(/^tool-/),
      toolName: "list_tasks",
      args: { limit: 2 },
      context: {
        sessionId: "session-1",
        executionId: expect.stringMatching(/^tool-/),
      },
      lineage: {
        sessionId: "session-1",
      },
    });
  });

  it("composes tool registry entries and resolves aliases", async () => {
    const registry = createToolRegistry([
      {
        source: "builtin",
        definitions: [
          {
            id: "list_tasks",
            description: "List active tasks.",
            aliases: ["tasks.list"],
            tags: ["read"],
          },
        ],
      },
      {
        source: "workspace",
        definitions: [
          {
            id: "list_tasks",
            tags: ["kanban"],
            allowedHosts: ["api.openai.com"],
            handler: async (args) => ({ ok: true, args }),
          },
        ],
      },
    ]);
    const entries = composeToolRegistryEntries([
      {
        source: "builtin",
        definitions: [{ id: "list_tasks", aliases: ["tasks.list"] }],
      },
    ]);
    const resolved = resolveToolDefinition("tasks.list", registry.listTools());
    const executed = await registry.execute("list_tasks", { limit: 5 }, {});

    expect(entries).toHaveLength(1);
    expect(resolved).toMatchObject({
      id: "list_tasks",
      aliases: ["tasks.list"],
      tags: ["read", "kanban"],
      allowedHosts: ["api.openai.com"],
    });
    expect(executed).toEqual({ ok: true, args: { limit: 5 } });
  });

  it("evaluates approval requirements with pending and approved outcomes", () => {
    const riskyTool = { id: "push_branch", requiresApproval: true, riskLevel: "high" };
    const pending = evaluateToolApproval(riskyTool, {
      sessionId: "session-2",
      approval: { mode: "manual" },
    });
    const manager = createToolApprovalManager({ allowlistedTools: ["list_tasks"] });
    const approved = manager.evaluate(riskyTool, {
      runId: "run-3",
      approval: { decision: "approved", mode: "manual" },
    });
    const safe = manager.evaluate({ id: "list_tasks" }, {});

    expect(pending).toMatchObject({
      approvalRequired: true,
      approvalState: "pending",
      blocked: true,
      scopeType: "harness-run",
      scopeId: "session-2",
    });
    expect(approved).toMatchObject({
      approvalRequired: true,
      approvalState: "approved",
      blocked: false,
      scopeId: "run-3",
    });
    expect(safe).toMatchObject({
      approvalRequired: false,
      approvalState: "not_required",
      blocked: false,
    });
  });

  it("persists approval requests and reuses resolved queue state on the next evaluation", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "bosun-tool-approval-"));
    tempRoots.push(repoRoot);
    const manager = createToolApprovalManager({
      repoRoot,
      timeoutMs: 60_000,
    });
    const riskyTool = { id: "push_branch", requiresApproval: true, riskLevel: "high" };
    const requested = manager.request(riskyTool, {
      runId: "run-tool-1",
      repoRoot,
      approval: {
        mode: "manual",
        scopeType: "harness-run",
        scopeId: "run-tool-1:push_branch",
      },
    });

    expect(requested.approval).toMatchObject({
      blocked: true,
      approvalState: "pending",
      requestId: expect.stringMatching(/^harness-run:/),
    });
    expect(requested.request).toMatchObject({
      status: "pending",
      runId: "run-tool-1",
      scopeId: "run-tool-1:push_branch",
      stageType: "tool",
    });
    expect(getApprovalRequestById(requested.request.requestId, { repoRoot })).toMatchObject({
      requestId: requested.request.requestId,
      status: "pending",
    });

    resolveApprovalRequest(requested.request.requestId, {
      repoRoot,
      decision: "approved",
      actorId: "operator:test",
      note: "approved for execution",
    });
    const rechecked = manager.evaluate(riskyTool, {
      repoRoot,
      approval: {
        mode: "manual",
        requestId: requested.request.requestId,
        scopeType: "harness-run",
        scopeId: "run-tool-1:push_branch",
      },
    });

    expect(rechecked).toMatchObject({
      blocked: false,
      approvalState: "approved",
      requestId: requested.request.requestId,
    });
  });

  it("enforces network policy for restricted and blocked hosts", () => {
    const tool = {
      id: "fetch_remote_context",
      networkAccess: "restricted",
      allowedHosts: ["api.openai.com"],
      blockedHosts: ["169.254.169.254"],
    };
    const allowed = evaluateToolNetworkPolicy(tool, {
      requestedHosts: ["api.openai.com"],
    });
    const manager = createToolNetworkPolicy();
    const blocked = manager.evaluate(tool, {
      requestedHosts: ["169.254.169.254"],
    });

    expect(allowed).toMatchObject({
      mode: "restricted",
      allowed: true,
      blocked: false,
    });
    expect(blocked).toMatchObject({
      allowed: false,
      blocked: true,
      reason: "Host 169.254.169.254 is blocked by policy.",
    });
  });

  it("truncates oversized text and JSON outputs with bounded previews", () => {
    const text = truncateText("x".repeat(120), { maxChars: 48, tailChars: 8 });
    const payload = {
      lines: Array.from({ length: 24 }, (_, index) => `line-${index}-${"y".repeat(12)}`),
    };
    const options = {
      maxChars: 96,
      tailChars: 16,
    };
    const structured = truncateToolOutput(payload, options);

    expect(text.truncated).toBe(true);
    expect(text.text).toContain("…truncated");
    expect(structured.truncated).toBe(true);
    expect(structured.format).toBe("json");
    expect(structured.data).toEqual(expect.objectContaining({
      truncated: true,
      preview: expect.stringContaining("…truncated"),
    }));
    expect(text).toEqual(truncateCompactedPreviewText("x".repeat(120), { maxChars: 48, tailChars: 8 }));
    expect(structured).toEqual(truncateCompactedToolOutput(payload, options));
  });

  it("materializes truncated previews with spill-to-disk pointers", async () => {
    const payload = {
      lines: Array.from({ length: 48 }, (_, index) => `line-${index}-${"z".repeat(18)}`),
    };
    const truncated = truncateToolOutput(payload, { maxChars: 96, tailChars: 16 });
    const materialized = await materializeTruncatedToolOutput(payload, truncated, {
      maxChars: 96,
      tailChars: 16,
      toolName: "collect_logs",
    });

    expect(materialized.spillPointer).toEqual(expect.objectContaining({
      kind: "tool-log",
      stage: "tool_output_truncation",
      retrieveCommand: expect.stringMatching(/^bosun --tool-log \d+$/),
    }));
    expect(materialized.preview).toContain("Full output spilled to disk");
    expect(materialized.data).toEqual(expect.objectContaining({
      spillPointer: expect.objectContaining({
        logId: materialized.spillPointer.logId,
      }),
    }));
  });

  it("reports in-process hot-path truncation metadata through the orchestrator", async () => {
    const events = [];
    const orchestrator = createToolOrchestrator({
      executeTool: async () => ({
        lines: Array.from({ length: 12 }, (_, index) => `line-${index}-${"z".repeat(24)}`),
      }),
      truncation: {
        maxChars: 96,
        tailChars: 16,
      },
      onEvent: (event) => events.push(event),
    });

    const result = await orchestrator.execute("list_tasks", { limit: 1 }, {});

    expect(result).toBeTruthy();
    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: "tool_execution_end",
      executionId: expect.stringMatching(/^tool-/),
      policy: expect.objectContaining({
        retry: expect.objectContaining({
          maxAttempts: 1,
        }),
      }),
      hotPath: expect.objectContaining({
        exec: expect.objectContaining({
          available: true,
          service: "exec",
          reason: "javascript",
        }),
      }),
      truncation: expect.objectContaining({
        truncated: true,
      }),
    }));
  });
});
