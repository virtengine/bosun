import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  ensureWorktreeRuntimeSetup,
  inspectWorktreeRuntimeSetup,
  syncExpectedWorktreeRuntimeFiles,
} from "../workspace/worktree-setup.mjs";

const cleanupDirs = [];

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  }
});

function createTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function initGitRepo(dir) {
  mkdirSync(dir, { recursive: true });
  execSync("git init", { cwd: dir, stdio: ["ignore", "ignore", "ignore"] });
  execSync('git config user.email "bosun-tests@example.com"', {
    cwd: dir,
    stdio: ["ignore", "ignore", "ignore"],
  });
  execSync('git config user.name "Bosun Tests"', {
    cwd: dir,
    stdio: ["ignore", "ignore", "ignore"],
  });
}

function writeRuntimeSourceFiles(rootDir, suffix = "source") {
  mkdirSync(join(rootDir, ".githooks"), { recursive: true });
  mkdirSync(join(rootDir, ".codex"), { recursive: true });
  writeFileSync(join(rootDir, ".githooks", "pre-commit"), `#!/usr/bin/env bash\n# ${suffix} pre-commit\n`, "utf8");
  writeFileSync(join(rootDir, ".githooks", "pre-push"), `#!/usr/bin/env bash\n# ${suffix} pre-push\n`, "utf8");
  writeFileSync(join(rootDir, ".codex", "config.toml"), `[runtime]\nlabel = "${suffix}"\n`, "utf8");
}

describe("worktree runtime setup", () => {
  it("syncs differing repo runtime files into an existing worktree", () => {
    const repoRoot = createTempDir("worktree-setup-repo-");
    const worktreePath = createTempDir("worktree-setup-worktree-");

    writeRuntimeSourceFiles(repoRoot, "fresh");
    mkdirSync(join(worktreePath, ".githooks"), { recursive: true });
    writeFileSync(join(worktreePath, ".githooks", "pre-push"), "# stale pre-push\n", "utf8");

    const result = syncExpectedWorktreeRuntimeFiles(repoRoot, worktreePath, [".githooks/pre-push"]);

    expect(result.syncedFiles).toEqual([".githooks/pre-push"]);
    expect(result.unchangedFiles).toEqual([]);
    expect(result.missingSourceFiles).toEqual([]);
    expect(readFileSync(join(worktreePath, ".githooks", "pre-push"), "utf8")).toBe(
      "#!/usr/bin/env bash\n# fresh pre-push\n",
    );
  });

  it("normalizes managed hook scripts to LF when the source checkout has CRLF", () => {
    const repoRoot = createTempDir("worktree-setup-crlf-source-");
    const worktreePath = createTempDir("worktree-setup-crlf-target-");

    mkdirSync(join(repoRoot, ".githooks"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".githooks", "pre-push"),
      "#!/usr/bin/env bash\r\nset -euo pipefail\r\necho ok\r\n",
      "utf8",
    );

    const result = syncExpectedWorktreeRuntimeFiles(repoRoot, worktreePath, [".githooks/pre-push"]);
    const syncedHook = readFileSync(join(worktreePath, ".githooks", "pre-push"), "utf8");

    expect(result.syncedFiles).toEqual([".githooks/pre-push"]);
    expect(result.unchangedFiles).toEqual([]);
    expect(syncedHook).toBe("#!/usr/bin/env bash\nset -euo pipefail\necho ok\n");
    expect(syncedHook.includes("\r")).toBe(false);
  });

  it("flags stale hook files before sync and reports a clean setup after refresh", () => {
    const repoRoot = createTempDir("worktree-setup-source-");
    const worktreePath = createTempDir("worktree-setup-target-");

    writeRuntimeSourceFiles(repoRoot, "fresh");
    initGitRepo(worktreePath);
    mkdirSync(join(worktreePath, ".githooks"), { recursive: true });
    mkdirSync(join(worktreePath, ".codex"), { recursive: true });
    writeFileSync(join(worktreePath, ".githooks", "pre-commit"), "#!/usr/bin/env bash\n# stale pre-commit\n", "utf8");
    writeFileSync(join(worktreePath, ".githooks", "pre-push"), "#!/usr/bin/env bash\n# stale pre-push\n", "utf8");
    writeFileSync(join(worktreePath, ".codex", "config.toml"), "[runtime]\nlabel = \"stale\"\n", "utf8");

    const before = inspectWorktreeRuntimeSetup(repoRoot, worktreePath);
    expect(before.ok).toBe(false);
    expect(before.staleFiles).toEqual(expect.arrayContaining([
      ".githooks/pre-commit",
      ".githooks/pre-push",
      ".codex/config.toml",
    ]));
    expect(before.issues.some((issue) => issue.includes("stale worktree setup files"))).toBe(true);

    const ensureResult = ensureWorktreeRuntimeSetup(repoRoot, worktreePath);
    const after = inspectWorktreeRuntimeSetup(repoRoot, worktreePath);

    expect(ensureResult.runtimeSync.syncedFiles).toEqual(expect.arrayContaining([
      ".githooks/pre-commit",
      ".githooks/pre-push",
      ".codex/config.toml",
    ]));
    expect(after.ok).toBe(true);
    expect(after.staleFiles).toEqual([]);
    expect(after.missingFiles).toEqual([]);
    expect(existsSync(join(worktreePath, ".github", "hooks", "bosun.hooks.json"))).toBe(true);
    expect(readFileSync(join(worktreePath, ".githooks", "pre-push"), "utf8")).toBe(
      "#!/usr/bin/env bash\n# fresh pre-push\n",
    );
  });
});
