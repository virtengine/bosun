import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildToolPolicyContract } from "../agent/tool-contract.mjs";
import { createToolRunner } from "../agent/harness/tool-runner.mjs";
import { createToolOrchestrator } from "../agent/tool-orchestrator.mjs";
import { resolveToolRetryPolicy } from "../agent/tool-retry-policy.mjs";
import { buildToolExecutionEnvelope } from "../agent/tool-runtime-context.mjs";

const cleanupDirs = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("tool orchestrator", () => {
  it("builds a canonical execution envelope with lineage metadata", () => {
    const envelope = buildToolExecutionEnvelope("run_workspace_command", { command: "git status" }, {
      sessionId: "session-1",
      threadId: "thread-1",
      turnId: "turn-7",
      runId: "run-2",
      workflowId: "wf-1",
      providerId: "openai",
      providerTurnId: "provider-turn-3",
      approval: {
        mode: "manual",
        requestId: "approval-1",
      },
      network: {
        requestedHosts: ["api.openai.com"],
      },
      retry: {
        maxAttempts: 3,
        backoffMs: 25,
      },
      truncation: {
        maxChars: 120,
        tailChars: 18,
      },
    });

    expect(envelope.executionId).toMatch(/^tool-/);
    expect(envelope.context).toMatchObject({
      executionId: envelope.executionId,
      sessionId: "session-1",
      threadId: "thread-1",
      turnId: "turn-7",
      providerTurnId: "provider-turn-3",
      approvalRequestId: "approval-1",
    });
    expect(envelope.lineage).toMatchObject({
      turnId: "turn-7",
      workflowId: "wf-1",
      providerId: "openai",
    });
    expect(envelope.policy).toMatchObject({
      approval: { requestId: "approval-1" },
      retry: { maxAttempts: 3, backoffMs: 25 },
      truncation: { maxChars: 120, tailChars: 18 },
    });
  });

  it("centralizes retry and lifecycle events through the orchestrator", async () => {
    const events = [];
    let attempts = 0;
    const orchestrator = createToolOrchestrator({
      toolSources: [{
        source: "test",
        definitions: [{
          id: "unstable_tool",
          retry: {
            maxAttempts: 2,
            backoffMs: 1,
          },
          handler: async () => {
            attempts += 1;
            if (attempts === 1) {
              throw new Error("first attempt failed");
            }
            return { ok: true };
          },
        }],
      }],
      onEvent: (event) => events.push(event),
    });

    const result = await orchestrator.execute("unstable_tool", {}, {
      sessionId: "session-retry",
      turnId: "turn-retry",
      approval: { mode: "auto" },
    });

    expect(result).toEqual({ ok: true });
    expect(attempts).toBe(2);
    expect(events.map((event) => event.type)).toEqual([
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_retry",
      "tool_execution_update",
      "tool_execution_end",
    ]);
    expect(events.every((event) => event.executionId === events[0].executionId)).toBe(true);
    expect(events.at(0)).toMatchObject({
      type: "tool_execution_start",
      turnId: "turn-retry",
      policy: {
        retry: {
          maxAttempts: 2,
          backoffMs: 1,
        },
      },
    });
    expect(events.at(2)).toMatchObject({
      type: "tool_execution_retry",
      attempt: 1,
      nextAttempt: 2,
      retry: {
        maxAttempts: 2,
      },
    });
    expect(events.at(-1)).toMatchObject({
      type: "tool_execution_end",
      attempt: 2,
    });
  });

  it("builds a single policy contract for sandbox, network, retry, and truncation", () => {
    const envelope = buildToolExecutionEnvelope("invoke_mcp_tool", {}, {
      sandbox: "workspace-write",
      network: {
        mode: "restricted",
        requestedHosts: ["api.openai.com"],
      },
      truncation: {
        maxChars: 512,
        tailChars: 64,
      },
    });
    const policy = buildToolPolicyContract({
      id: "invoke_mcp_tool",
      networkAccess: "restricted",
      sandbox: "read-only",
      allowedHosts: ["api.openai.com"],
      retry: {
        maxAttempts: 4,
        backoffMs: 50,
      },
    }, envelope, {
      retryPolicy: {
        maxAttempts: 2,
      },
    });

    expect(resolveToolRetryPolicy({ retry: { maxAttempts: 4, backoffMs: 50 } }, {}, {})).toEqual({
      maxAttempts: 4,
      backoffMs: 50,
      strategy: "fixed",
    });
    expect(policy).toMatchObject({
      sandbox: { mode: "read-only" },
      network: {
        mode: "restricted",
        requestedHosts: ["api.openai.com"],
        allowedHosts: ["api.openai.com"],
      },
      retry: {
        maxAttempts: 4,
        backoffMs: 50,
      },
      truncation: {
        maxChars: 512,
        tailChars: 64,
      },
    });
  });

  it("registers Bosun-native built-ins by default and exposes OpenClaude-style aliases", () => {
    const orchestrator = createToolOrchestrator();
    const tools = orchestrator.listTools();
    const readFile = tools.find((entry) => entry.id === "read_file_content");
    const searchFiles = tools.find((entry) => entry.id === "search_files");
    const writeFile = tools.find((entry) => entry.id === "write_file");
    const editFile = tools.find((entry) => entry.id === "edit_file");
    const runWorkspaceCommand = tools.find((entry) => entry.id === "run_workspace_command");
    const spawnSubagent = tools.find((entry) => entry.id === "spawn_subagent");

    expect(readFile).toEqual(expect.objectContaining({
      aliases: expect.arrayContaining(["read_file"]),
      parameters: expect.objectContaining({
        required: ["filePath"],
      }),
    }));
    expect(searchFiles).toEqual(expect.objectContaining({
      parameters: expect.objectContaining({
        required: ["query"],
        properties: expect.objectContaining({
          query: expect.any(Object),
          pattern: expect.any(Object),
        }),
      }),
    }));
    expect(writeFile).toEqual(expect.objectContaining({
      parameters: expect.objectContaining({
        required: ["path", "content"],
        properties: expect.objectContaining({
          path: expect.any(Object),
          filePath: expect.any(Object),
          content: expect.any(Object),
          mode: expect.any(Object),
          overwrite_existing: expect.any(Object),
        }),
      }),
    }));
    expect(editFile).toEqual(expect.objectContaining({
      aliases: expect.arrayContaining(["replace_in_file"]),
      parameters: expect.objectContaining({
        required: ["path", "old_string", "new_string"],
        properties: expect.objectContaining({
          path: expect.any(Object),
          filePath: expect.any(Object),
          old_string: expect.any(Object),
          search: expect.any(Object),
          new_string: expect.any(Object),
          replace: expect.any(Object),
        }),
      }),
    }));
    expect(runWorkspaceCommand).toEqual(expect.objectContaining({
      parameters: expect.objectContaining({
        required: ["command"],
      }),
    }));
    expect(spawnSubagent).toEqual(expect.objectContaining({
      aliases: expect.arrayContaining(["spawn_agent"]),
    }));
  });

  it("allows the harness tool runner to use the orchestrator execute contract", async () => {
    const orchestrator = createToolOrchestrator({
      includeBuiltinBosunTools: false,
      toolSources: [{
        source: "test",
        definitions: [{
          id: "echo_tool",
          handler: async (args) => ({ echoed: args }),
        }],
      }],
    });
    const runner = await createToolRunner({
      toolOrchestrator: orchestrator,
    });

    await expect(runner.runTool("echo_tool", { ok: true })).resolves.toEqual({
      echoed: { ok: true },
    });
  });

  it("refuses to overwrite existing files through the native write_file tool unless overwrite_existing=true", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "bosun-write-file-"));
    cleanupDirs.push(workspaceRoot);
    const targetPath = join(workspaceRoot, "src", "example.mjs");
    mkdirSync(join(workspaceRoot, "src"), { recursive: true });
    writeFileSync(targetPath, "export const value = 1;\n", "utf8");

    const orchestrator = createToolOrchestrator();

    await expect(orchestrator.execute("write_file", {
      path: "src/example.mjs",
      content: "export const value = 2;\n",
    }, {
      repoRoot: workspaceRoot,
    })).rejects.toThrow(/refuses to overwrite existing file/i);

    expect(readFileSync(targetPath, "utf8")).toBe("export const value = 1;\n");

    await expect(orchestrator.execute("write_file", {
      path: "src/example.mjs",
      content: "export const value = 2;\n",
      overwrite_existing: true,
    }, {
      repoRoot: workspaceRoot,
    })).resolves.toMatchObject({
      ok: true,
      path: expect.stringMatching(/src[\\/]example\.mjs$/),
      mode: "overwrite",
    });

    expect(readFileSync(targetPath, "utf8")).toBe("export const value = 2;\n");
  });

  it("prefers exact tool ids over aliases when both are present", async () => {
    const orchestrator = createToolOrchestrator({
      includeBuiltinBosunTools: false,
      toolSources: [{
        source: "test",
        definitions: [
          {
            id: "search_code",
            aliases: ["search_files"],
            handler: async () => "alias-handler",
          },
          {
            id: "search_files",
            handler: async () => ({ handler: "exact-id" }),
          },
        ],
      }],
    });

    await expect(orchestrator.execute("search_files", {})).resolves.toEqual({
      handler: "exact-id",
    });
  });
});
