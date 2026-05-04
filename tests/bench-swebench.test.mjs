import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { normalizeWorkspaceStorageKey } from "../task/task-store.mjs";

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix) {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function readStore(storePath) {
  return JSON.parse(readFileSync(storePath, "utf8"));
}

describe("bosun SWE-bench bridge", () => {
  it("prints usage when invoked without a command", () => {
    const result = spawnSync(
      process.execPath,
      ["bench/swebench/bosun-swebench.mjs"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 30000,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Bosun SWE-bench bridge");
    expect(result.stdout).toContain("Usage:");
  }, 35000);

  it("imports SWE-bench instances into the internal task store", () => {
    const dir = makeTempDir("bosun-swebench-");
    const instancesPath = resolve(dir, "instances.jsonl");
    const workspaceDir = resolve(dir, "workspace");
    const storePath = resolve(workspaceDir, ".bosun", ".cache", "kanban-state.json");
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(
      instancesPath,
      `${JSON.stringify({
        instance_id: "demo__repo-2",
        problem_statement: "Fix a parser edge case",
        repo: "acme/widgets",
        base_commit: "def456",
        workspace: workspaceDir,
      })}\n`,
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      [
        "bench/swebench/bosun-swebench.mjs",
        "import",
        "--instances",
        instancesPath,
        "--status",
        "todo",
        "--priority",
        "high",
        "--candidates",
        "2",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Ensured SWE-bench workflow runtime: workspaces=1, installed=1",
    );
    expect(result.stdout).toContain("Imported SWE-bench tasks: created=1, skipped=0, total=1");

    const tasks = Object.values(readStore(storePath).tasks || {});
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe("swebench-demo__repo-2");
    expect(tasks[0]?.status).toBe("todo");
    expect(tasks[0]?.priority).toBe("high");
    expect(tasks[0]?.candidateCount).toBe(2);
    expect(tasks[0]?.meta?.swebench?.instance_id).toBe("demo__repo-2");
    expect(tasks[0]?.meta?.swebench?.base_commit).toBe("def456");
    expect(tasks[0]?.tags).toEqual(expect.arrayContaining(["benchmark", "swebench", "benchmark:swebench"]));
    expect(tasks[0]?.meta?.benchmark).toEqual({
      type: "swebench",
      provider: "swebench",
    });
    expect(tasks[0]?.workspace).toBe(normalizeWorkspaceStorageKey(workspaceDir));

    const workflowDir = resolve(workspaceDir, ".bosun", "workflows");
    expect(existsSync(workflowDir)).toBe(true);
    const workflowFiles = readdirSync(workflowDir).filter((entry) => entry.endsWith(".json"));
    expect(workflowFiles.length).toBeGreaterThan(0);
    const lifecycleFile = workflowFiles.find((f) => {
      const wf = JSON.parse(readFileSync(resolve(workflowDir, f), "utf8"));
      return wf?.metadata?.installedFrom === "template-task-lifecycle";
    });
    expect(lifecycleFile).toBeTruthy();
    const installedWorkflow = JSON.parse(readFileSync(resolve(workflowDir, lifecycleFile), "utf8"));
    expect(installedWorkflow?.metadata?.installedFrom).toBe("template-task-lifecycle");
    expect(installedWorkflow?.variables?.maxParallel).toBe(1);
  });
});
