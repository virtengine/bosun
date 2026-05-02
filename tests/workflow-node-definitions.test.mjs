import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { isManagedBosunWorktree } from "../workflow/workflow-nodes/definitions.mjs";

const tempDirs = [];

function makeTempDir() {
  const dir = mkdtempSync(resolve(tmpdir(), "bosun-worktree-defs-"));
  tempDirs.push(dir);
  return dir;
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(result.status).toBe(0);
  return result;
}

describe("workflow node definitions worktree helpers", () => {
  it("treats repo-local .bosun/worktrees paths as managed", () => {
    const repoRoot = makeTempDir();
    const worktreePath = resolve(repoRoot, ".bosun", "worktrees", "task-local");
    mkdirSync(worktreePath, { recursive: true });

    expect(isManagedBosunWorktree(worktreePath, repoRoot)).toBe(true);
  });

  it("treats .bosun/worktrees under attached git worktrees as managed", () => {
    const repoRoot = makeTempDir();
    git(["init"], repoRoot);
    git(["config", "user.email", "test@example.com"], repoRoot);
    git(["config", "user.name", "Test"], repoRoot);
    writeFileSync(resolve(repoRoot, "README.md"), "init\n", "utf8");
    git(["add", "README.md"], repoRoot);
    git(["commit", "-m", "init"], repoRoot);
    git(["branch", "-M", "main"], repoRoot);

    const proofRoot = resolve(repoRoot, "workspace", "postmerge-sync");
    git(["worktree", "add", proofRoot, "-b", "monitor-postmerge-sync"], repoRoot);

    const managedPath = resolve(proofRoot, ".bosun", "worktrees", "task-e274");
    mkdirSync(managedPath, { recursive: true });

    expect(isManagedBosunWorktree(managedPath, repoRoot)).toBe(true);
  });
});

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
