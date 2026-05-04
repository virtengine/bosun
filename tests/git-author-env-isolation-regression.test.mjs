import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function read(relPath) {
  return readFileSync(resolve(process.cwd(), relPath), "utf8");
}

describe("git author env isolation regression", () => {
  it("sanitizes inherited git env before test repos write identity", () => {
    const uiServer = read("tests/ui-server.test.mjs");
    const libraryManager = read("tests/library-manager.test.mjs");
    const workspaceManager = read("tests/workspace-manager.test.mjs");
    const lifecycle = read("tests/workflow-task-lifecycle.test.mjs");

    expect(uiServer).toContain('function sanitizedGitEnv(extra = {})');
    expect(uiServer).toContain('env: sanitizedGitEnv()');

    expect(libraryManager).toContain('function execGit(command, options = {})');
    expect(libraryManager).toContain('env: sanitizedGitEnv(options.env)');

    expect(workspaceManager).toContain('function execGit(command, options = {})');
    expect(workspaceManager).toContain('env: sanitizedGitEnv(options.env)');

    expect(lifecycle).toContain('"GIT_COMMON_DIR"');
    expect(lifecycle).toContain('"GIT_ALTERNATE_OBJECT_DIRECTORIES"');
  });

  it("routes live git mutations through shared safety sanitization", () => {
    const gitSafety = read("git/git-safety.mjs");
    const worktreeManager = read("workspace/worktree-manager.mjs");
    const taskExecutor = read("task/task-executor.mjs");
    const workflowDefinitions = read("workflow/workflow-nodes/definitions.mjs");

    expect(gitSafety).toContain("export function sanitizeGitEnv");
    expect(worktreeManager).toContain("return sanitizeGitEnv(process.env, GIT_ENV);");
    expect(taskExecutor).toContain('env: sanitizeGitEnv()');
    expect(workflowDefinitions).toContain('GIT_PAGER: "cat"');
    expect(workflowDefinitions).toContain('PAGER: "cat"');
    expect(workflowDefinitions).toContain('GH_PAGER: "cat"');
    expect(workflowDefinitions).toContain('SYSTEMD_PAGER: "cat"');
  });
});
