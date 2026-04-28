import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
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

function writeTextFile(rootDir, relativePath, content) {
  const targetPath = join(rootDir, ...relativePath.split("/"));
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, content, "utf8");
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

  it("marks tracked runtime setup files skip-worktree so sync does not leave unrelated git dirt", () => {
    const repoRoot = createTempDir("worktree-setup-git-source-");
    const worktreePath = createTempDir("worktree-setup-git-target-");

    writeRuntimeSourceFiles(repoRoot, "fresh");
    initGitRepo(worktreePath);
    mkdirSync(join(worktreePath, ".githooks"), { recursive: true });
    mkdirSync(join(worktreePath, ".codex"), { recursive: true });
    writeFileSync(join(worktreePath, ".githooks", "pre-commit"), "#!/usr/bin/env bash\n# baseline pre-commit\n", "utf8");
    writeFileSync(join(worktreePath, ".githooks", "pre-push"), "#!/usr/bin/env bash\n# baseline pre-push\n", "utf8");
    writeFileSync(join(worktreePath, ".codex", "config.toml"), "[runtime]\nlabel = \"baseline\"\n", "utf8");
    execSync("git add .githooks/pre-commit .githooks/pre-push .codex/config.toml", {
      cwd: worktreePath,
      stdio: ["ignore", "ignore", "ignore"],
    });
    execSync('git commit -m "baseline runtime files"', {
      cwd: worktreePath,
      stdio: ["ignore", "ignore", "ignore"],
    });

    const ensureResult = ensureWorktreeRuntimeSetup(repoRoot, worktreePath);
    const porcelain = execSync("git status --short -- .githooks/pre-commit .githooks/pre-push .codex/config.toml", {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const skipWorktreeBits = execSync("git ls-files -v .githooks/pre-commit .githooks/pre-push .codex/config.toml", {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.charAt(0));

    expect(ensureResult.runtimeSync.syncedFiles).toEqual(expect.arrayContaining([
      ".githooks/pre-commit",
      ".githooks/pre-push",
      ".codex/config.toml",
    ]));
    expect(ensureResult.gitIndex.skippedFiles).toEqual(expect.arrayContaining([
      ".githooks/pre-commit",
      ".githooks/pre-push",
      ".codex/config.toml",
    ]));
    expect(ensureResult.gitIndex.errors).toEqual([]);
    expect(porcelain).toBe("");
    expect(skipWorktreeBits).toEqual(["S", "S", "S"]);
  });

  it("syncs Bosun local ops overlay files into a worktree and keeps them out of git status", () => {
    const repoRoot = createTempDir("worktree-setup-overlay-source-");
    const worktreePath = createTempDir("worktree-setup-overlay-target-");

    initGitRepo(repoRoot);
    writeRuntimeSourceFiles(repoRoot, "fresh");
    writeTextFile(
      repoRoot,
      "tui/screens/status.mjs",
      'import * as ink from "ink";\nconst Box = ink.Box ?? ink.default?.Box;\n',
    );
    execSync("git add .", {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    execSync('git commit -m "baseline source"', {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    execSync("git checkout -b bosun/codex-self-improvement-loop-commits", {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });

    initGitRepo(worktreePath);
    mkdirSync(join(worktreePath, ".githooks"), { recursive: true });
    mkdirSync(join(worktreePath, ".codex"), { recursive: true });
    writeFileSync(join(worktreePath, ".githooks", "pre-commit"), "#!/usr/bin/env bash\n# baseline pre-commit\n", "utf8");
    writeFileSync(join(worktreePath, ".githooks", "pre-push"), "#!/usr/bin/env bash\n# baseline pre-push\n", "utf8");
    writeFileSync(join(worktreePath, ".codex", "config.toml"), "[runtime]\nlabel = \"baseline\"\n", "utf8");
    writeTextFile(
      worktreePath,
      "tui/screens/status.mjs",
      'import { Box } from "ink";\n',
    );
    execSync("git add .", {
      cwd: worktreePath,
      stdio: ["ignore", "ignore", "ignore"],
    });
    execSync('git commit -m "baseline worktree"', {
      cwd: worktreePath,
      stdio: ["ignore", "ignore", "ignore"],
    });

    const ensureResult = ensureWorktreeRuntimeSetup(repoRoot, worktreePath);
    const syncedOverlay = readFileSync(join(worktreePath, "tui", "screens", "status.mjs"), "utf8");
    const porcelain = execSync("git status --short -- tui/screens/status.mjs", {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const skipWorktreeFlag = execSync("git ls-files -v tui/screens/status.mjs", {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim().charAt(0);

    expect(ensureResult.runtimeSync.syncedFiles).toContain("tui/screens/status.mjs");
    expect(ensureResult.gitIndex.skippedFiles).toContain("tui/screens/status.mjs");
    expect(syncedOverlay).toBe('import * as ink from "ink";\nconst Box = ink.Box ?? ink.default?.Box;\n');
    expect(porcelain).toBe("");
    expect(skipWorktreeFlag).toBe("S");
  });

  it("syncs Bosun local ops overlay files that are missing in the worktree and hides them from git status", () => {
    const repoRoot = createTempDir("worktree-setup-overlay-missing-source-");
    const worktreePath = createTempDir("worktree-setup-overlay-missing-target-");

    initGitRepo(repoRoot);
    writeRuntimeSourceFiles(repoRoot, "fresh");
    writeTextFile(
      repoRoot,
      "tui/screens/connection-setup.mjs",
      'export default function ConnectionSetupScreen() {}\n',
    );
    execSync("git add .", {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    execSync('git commit -m "baseline source"', {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    execSync("git checkout -b bosun/codex-self-improvement-loop-commits", {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });

    initGitRepo(worktreePath);
    writeRuntimeSourceFiles(worktreePath, "baseline");
    execSync("git add .", {
      cwd: worktreePath,
      stdio: ["ignore", "ignore", "ignore"],
    });
    execSync('git commit -m "baseline worktree"', {
      cwd: worktreePath,
      stdio: ["ignore", "ignore", "ignore"],
    });

    const ensureResult = ensureWorktreeRuntimeSetup(repoRoot, worktreePath);
    const syncedOverlay = readFileSync(join(worktreePath, "tui", "screens", "connection-setup.mjs"), "utf8");
    const porcelain = execSync("git status --short -- tui/screens/connection-setup.mjs", {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const checkIgnore = execSync("git check-ignore -v --no-index tui/screens/connection-setup.mjs", {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

    expect(ensureResult.runtimeSync.syncedFiles).toContain("tui/screens/connection-setup.mjs");
    expect(ensureResult.gitIgnore.ignoredFiles).toContain("tui/screens/connection-setup.mjs");
    expect(syncedOverlay).toBe('export default function ConnectionSetupScreen() {}\n');
    expect(porcelain).toBe("");
    expect(checkIgnore).toContain("tui/screens/connection-setup.mjs");
  });

  it("syncs Bosun local ops ui module overlay files that are missing in the worktree and hides them from git status", () => {
    const repoRoot = createTempDir("worktree-setup-ui-modules-source-");
    const worktreePath = createTempDir("worktree-setup-ui-modules-target-");

    initGitRepo(repoRoot);
    writeRuntimeSourceFiles(repoRoot, "fresh");
    writeTextFile(
      repoRoot,
      "ui/modules/harness-client.js",
      'export function buildHarnessRunPath(id) { return `/harness/runs/${id}`; }\n',
    );
    execSync("git add .", {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    execSync('git commit -m "baseline source"', {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    execSync("git checkout -b bosun/codex-self-improvement-loop-commits", {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });

    initGitRepo(worktreePath);
    writeRuntimeSourceFiles(worktreePath, "baseline");
    execSync("git add .", {
      cwd: worktreePath,
      stdio: ["ignore", "ignore", "ignore"],
    });
    execSync('git commit -m "baseline worktree"', {
      cwd: worktreePath,
      stdio: ["ignore", "ignore", "ignore"],
    });

    const ensureResult = ensureWorktreeRuntimeSetup(repoRoot, worktreePath);
    const syncedOverlay = readFileSync(join(worktreePath, "ui", "modules", "harness-client.js"), "utf8");
    const porcelain = execSync("git status --short -- ui/modules/harness-client.js", {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const checkIgnore = execSync("git check-ignore -v --no-index ui/modules/harness-client.js", {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

    expect(ensureResult.runtimeSync.syncedFiles).toContain("ui/modules/harness-client.js");
    expect(ensureResult.gitIgnore.ignoredFiles).toContain("ui/modules/harness-client.js");
    expect(syncedOverlay).toBe('export function buildHarnessRunPath(id) { return `/harness/runs/${id}`; }\n');
    expect(porcelain).toBe("");
    expect(checkIgnore).toContain("ui/modules/harness-client.js");
  });

  it("syncs Bosun local ops exact-file test overlays into a worktree and keeps them out of git status", () => {
    const repoRoot = createTempDir("worktree-setup-overlay-test-source-");
    const worktreePath = createTempDir("worktree-setup-overlay-test-target-");

    initGitRepo(repoRoot);
    writeRuntimeSourceFiles(repoRoot, "fresh");
    writeTextFile(
      repoRoot,
      "tests/fleet-tab-render.test.mjs",
      'expect("source").toContain("updated overlay expectation");\n',
    );
    execSync("git add .", {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    execSync('git commit -m "baseline source"', {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    execSync("git checkout -b bosun/codex-self-improvement-loop-commits", {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });

    initGitRepo(worktreePath);
    writeRuntimeSourceFiles(worktreePath, "baseline");
    writeTextFile(
      worktreePath,
      "tests/fleet-tab-render.test.mjs",
      'expect("worktree").toContain("stale expectation");\n',
    );
    execSync("git add .", {
      cwd: worktreePath,
      stdio: ["ignore", "ignore", "ignore"],
    });
    execSync('git commit -m "baseline worktree"', {
      cwd: worktreePath,
      stdio: ["ignore", "ignore", "ignore"],
    });

    const ensureResult = ensureWorktreeRuntimeSetup(repoRoot, worktreePath);
    const syncedOverlay = readFileSync(join(worktreePath, "tests", "fleet-tab-render.test.mjs"), "utf8");
    const porcelain = execSync("git status --short -- tests/fleet-tab-render.test.mjs", {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const skipWorktreeFlag = execSync("git ls-files -v tests/fleet-tab-render.test.mjs", {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim().charAt(0);

    expect(ensureResult.runtimeSync.syncedFiles).toContain("tests/fleet-tab-render.test.mjs");
    expect(ensureResult.gitIndex.skippedFiles).toContain("tests/fleet-tab-render.test.mjs");
    expect(syncedOverlay).toBe('expect("source").toContain("updated overlay expectation");\n');
    expect(porcelain).toBe("");
    expect(skipWorktreeFlag).toBe("S");
  });

  it("syncs Bosun local ops vitest runner support overlays into a worktree and keeps them out of git status", () => {
    const repoRoot = createTempDir("worktree-setup-overlay-vitest-source-");
    const worktreePath = createTempDir("worktree-setup-overlay-vitest-target-");

    initGitRepo(repoRoot);
    writeRuntimeSourceFiles(repoRoot, "fresh");
    writeTextFile(
      repoRoot,
      "tools/vitest-runner.mjs",
      'export const runnerLabel = "source-fast-runner";\n',
    );
    writeTextFile(
      repoRoot,
      "vitest.config.mjs",
      'export default { test: { projects: [{ test: { name: "fast" } }] } };\n',
    );
    writeTextFile(
      repoRoot,
      "tests/setup.mjs",
      'export const setupLabel = "source-setup";\n',
    );
    writeTextFile(
      repoRoot,
      "tests/near-timeout-reporter.mjs",
      'export default function createReporter() { return { onFinished() { return "source-reporter"; } }; }\n',
    );
    writeTextFile(
      repoRoot,
      "tests/shims/codex-sdk.mjs",
      'export const codexShimLabel = "source-codex-shim";\n',
    );
    execSync("git add .", {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    execSync('git commit -m "baseline source"', {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    execSync("git checkout -b bosun/codex-self-improvement-loop-commits", {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });

    initGitRepo(worktreePath);
    writeRuntimeSourceFiles(worktreePath, "baseline");
    writeTextFile(
      worktreePath,
      "tools/vitest-runner.mjs",
      'export const runnerLabel = "worktree-stale-runner";\n',
    );
    writeTextFile(
      worktreePath,
      "vitest.config.mjs",
      'export default { test: { projects: [] } };\n',
    );
    writeTextFile(
      worktreePath,
      "tests/setup.mjs",
      'export const setupLabel = "worktree-stale-setup";\n',
    );
    writeTextFile(
      worktreePath,
      "tests/near-timeout-reporter.mjs",
      'export default function createReporter() { return { onFinished() { return "worktree-stale-reporter"; } }; }\n',
    );
    writeTextFile(
      worktreePath,
      "tests/shims/codex-sdk.mjs",
      'export const codexShimLabel = "worktree-stale-codex-shim";\n',
    );
    execSync("git add .", {
      cwd: worktreePath,
      stdio: ["ignore", "ignore", "ignore"],
    });
    execSync('git commit -m "baseline worktree"', {
      cwd: worktreePath,
      stdio: ["ignore", "ignore", "ignore"],
    });

    const ensureResult = ensureWorktreeRuntimeSetup(repoRoot, worktreePath);
    const syncedRunner = readFileSync(join(worktreePath, "tools", "vitest-runner.mjs"), "utf8");
    const syncedConfig = readFileSync(join(worktreePath, "vitest.config.mjs"), "utf8");
    const syncedSetup = readFileSync(join(worktreePath, "tests", "setup.mjs"), "utf8");
    const syncedReporter = readFileSync(join(worktreePath, "tests", "near-timeout-reporter.mjs"), "utf8");
    const syncedShim = readFileSync(join(worktreePath, "tests", "shims", "codex-sdk.mjs"), "utf8");
    const porcelain = execSync("git status --short -- tools/vitest-runner.mjs vitest.config.mjs tests/setup.mjs tests/near-timeout-reporter.mjs tests/shims/codex-sdk.mjs", {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const skipWorktreeFlags = execSync("git ls-files -v tools/vitest-runner.mjs vitest.config.mjs tests/setup.mjs tests/near-timeout-reporter.mjs tests/shims/codex-sdk.mjs", {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.charAt(0));

    expect(ensureResult.runtimeSync.syncedFiles).toEqual(expect.arrayContaining([
      "tools/vitest-runner.mjs",
      "vitest.config.mjs",
      "tests/setup.mjs",
      "tests/near-timeout-reporter.mjs",
      "tests/shims/codex-sdk.mjs",
    ]));
    expect(ensureResult.gitIndex.skippedFiles).toEqual(expect.arrayContaining([
      "tools/vitest-runner.mjs",
      "vitest.config.mjs",
      "tests/setup.mjs",
      "tests/near-timeout-reporter.mjs",
      "tests/shims/codex-sdk.mjs",
    ]));
    expect(syncedRunner).toBe('export const runnerLabel = "source-fast-runner";\n');
    expect(syncedConfig).toBe('export default { test: { projects: [{ test: { name: "fast" } }] } };\n');
    expect(syncedSetup).toBe('export const setupLabel = "source-setup";\n');
    expect(syncedReporter).toBe('export default function createReporter() { return { onFinished() { return "source-reporter"; } }; }\n');
    expect(syncedShim).toBe('export const codexShimLabel = "source-codex-shim";\n');
    expect(porcelain).toBe("");
    expect(skipWorktreeFlags).toEqual(["S", "S", "S", "S", "S"]);
  });

  it("syncs Bosun local ops ui-server validation test overlays into a worktree and keeps them out of git status", () => {
    const repoRoot = createTempDir("worktree-setup-overlay-ui-server-tests-source-");
    const worktreePath = createTempDir("worktree-setup-overlay-ui-server-tests-target-");

    initGitRepo(repoRoot);
    writeRuntimeSourceFiles(repoRoot, "fresh");
    writeTextFile(
      repoRoot,
      "tests/ui-server-fallback-auth.test.mjs",
      'export const fallbackAuthLabel = "source-fallback-auth";\n',
    );
    writeTextFile(
      repoRoot,
      "tests/ui-server-session-actions.test.mjs",
      'export const sessionActionsLabel = "source-session-actions";\n',
    );
    writeTextFile(
      repoRoot,
      "tests/ui-server-tui-events.test.mjs",
      'export const tuiEventsLabel = "source-tui-events";\n',
    );
    writeTextFile(
      repoRoot,
      "tests/ui-server-tunnel-hostname.test.mjs",
      'export const tunnelHostnameLabel = "source-tunnel-hostname";\n',
    );
    execSync("git add .", {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    execSync('git commit -m "baseline source"', {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    execSync("git checkout -b bosun/codex-self-improvement-loop-commits", {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });

    initGitRepo(worktreePath);
    writeRuntimeSourceFiles(worktreePath, "baseline");
    writeTextFile(
      worktreePath,
      "tests/ui-server-fallback-auth.test.mjs",
      'export const fallbackAuthLabel = "worktree-stale-fallback-auth";\n',
    );
    writeTextFile(
      worktreePath,
      "tests/ui-server-session-actions.test.mjs",
      'export const sessionActionsLabel = "worktree-stale-session-actions";\n',
    );
    writeTextFile(
      worktreePath,
      "tests/ui-server-tui-events.test.mjs",
      'export const tuiEventsLabel = "worktree-stale-tui-events";\n',
    );
    writeTextFile(
      worktreePath,
      "tests/ui-server-tunnel-hostname.test.mjs",
      'export const tunnelHostnameLabel = "worktree-stale-tunnel-hostname";\n',
    );
    execSync("git add .", {
      cwd: worktreePath,
      stdio: ["ignore", "ignore", "ignore"],
    });
    execSync('git commit -m "baseline worktree"', {
      cwd: worktreePath,
      stdio: ["ignore", "ignore", "ignore"],
    });

    const ensureResult = ensureWorktreeRuntimeSetup(repoRoot, worktreePath);
    const syncedFallbackAuth = readFileSync(join(worktreePath, "tests", "ui-server-fallback-auth.test.mjs"), "utf8");
    const syncedSessionActions = readFileSync(join(worktreePath, "tests", "ui-server-session-actions.test.mjs"), "utf8");
    const syncedTuiEvents = readFileSync(join(worktreePath, "tests", "ui-server-tui-events.test.mjs"), "utf8");
    const syncedTunnelHostname = readFileSync(join(worktreePath, "tests", "ui-server-tunnel-hostname.test.mjs"), "utf8");
    const porcelain = execSync("git status --short -- tests/ui-server-fallback-auth.test.mjs tests/ui-server-session-actions.test.mjs tests/ui-server-tui-events.test.mjs tests/ui-server-tunnel-hostname.test.mjs", {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const skipWorktreeFlags = execSync("git ls-files -v tests/ui-server-fallback-auth.test.mjs tests/ui-server-session-actions.test.mjs tests/ui-server-tui-events.test.mjs tests/ui-server-tunnel-hostname.test.mjs", {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.charAt(0));

    expect(ensureResult.runtimeSync.syncedFiles).toEqual(expect.arrayContaining([
      "tests/ui-server-fallback-auth.test.mjs",
      "tests/ui-server-session-actions.test.mjs",
      "tests/ui-server-tui-events.test.mjs",
      "tests/ui-server-tunnel-hostname.test.mjs",
    ]));
    expect(ensureResult.gitIndex.skippedFiles).toEqual(expect.arrayContaining([
      "tests/ui-server-fallback-auth.test.mjs",
      "tests/ui-server-session-actions.test.mjs",
      "tests/ui-server-tui-events.test.mjs",
      "tests/ui-server-tunnel-hostname.test.mjs",
    ]));
    expect(syncedFallbackAuth).toBe('export const fallbackAuthLabel = "source-fallback-auth";\n');
    expect(syncedSessionActions).toBe('export const sessionActionsLabel = "source-session-actions";\n');
    expect(syncedTuiEvents).toBe('export const tuiEventsLabel = "source-tui-events";\n');
    expect(syncedTunnelHostname).toBe('export const tunnelHostnameLabel = "source-tunnel-hostname";\n');
    expect(porcelain).toBe("");
    expect(skipWorktreeFlags).toEqual(["S", "S", "S", "S"]);
  });

  it("syncs transitive local import dependencies for exact-file overlays into a worktree", () => {
    const repoRoot = createTempDir("worktree-setup-overlay-import-source-");
    const worktreePath = createTempDir("worktree-setup-overlay-import-target-");

    initGitRepo(repoRoot);
    writeRuntimeSourceFiles(repoRoot, "fresh");
    writeTextFile(
      repoRoot,
      "telegram/telegram-bot.mjs",
      'import { stickyMenuState } from "./sticky-menu-state.mjs";\nexport function getStickyMenuState() { return stickyMenuState; }\n',
    );
    writeTextFile(
      repoRoot,
      "telegram/sticky-menu-state.mjs",
      'export const stickyMenuState = "source-overlay";\n',
    );
    execSync("git add .", {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    execSync('git commit -m "baseline source"', {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    execSync("git checkout -b bosun/codex-self-improvement-loop-commits", {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });

    initGitRepo(worktreePath);
    writeRuntimeSourceFiles(worktreePath, "baseline");
    writeTextFile(
      worktreePath,
      "telegram/telegram-bot.mjs",
      'import { stickyMenuState } from "./sticky-menu-state.mjs";\nexport function getStickyMenuState() { return `${stickyMenuState}-stale`; }\n',
    );
    writeTextFile(
      worktreePath,
      "telegram/sticky-menu-state.mjs",
      'export const stickyMenuState = "worktree-stale";\n',
    );
    execSync("git add .", {
      cwd: worktreePath,
      stdio: ["ignore", "ignore", "ignore"],
    });
    execSync('git commit -m "baseline worktree"', {
      cwd: worktreePath,
      stdio: ["ignore", "ignore", "ignore"],
    });

    const ensureResult = ensureWorktreeRuntimeSetup(repoRoot, worktreePath);
    const syncedDependency = readFileSync(join(worktreePath, "telegram", "sticky-menu-state.mjs"), "utf8");
    const porcelain = execSync("git status --short -- telegram/sticky-menu-state.mjs", {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const skipWorktreeFlag = execSync("git ls-files -v telegram/sticky-menu-state.mjs", {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim().charAt(0);

    expect(ensureResult.runtimeSync.syncedFiles).toContain("telegram/sticky-menu-state.mjs");
    expect(ensureResult.gitIndex.skippedFiles).toContain("telegram/sticky-menu-state.mjs");
    expect(syncedDependency).toBe('export const stickyMenuState = "source-overlay";\n');
    expect(porcelain).toBe("");
    expect(skipWorktreeFlag).toBe("S");
  });

  it("syncs package.json exact-file overlays into a worktree and keeps them out of git status", () => {
    const repoRoot = createTempDir("worktree-setup-overlay-package-source-");
    const worktreePath = createTempDir("worktree-setup-overlay-package-target-");

    initGitRepo(repoRoot);
    writeRuntimeSourceFiles(repoRoot, "fresh");
    writeTextFile(
      repoRoot,
      "package.json",
      `${JSON.stringify({
        name: "bosun-test",
        version: "1.0.0",
        files: ["agent/agent-launcher.mjs"],
      }, null, 2)}\n`,
    );
    execSync("git add .", {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    execSync('git commit -m "baseline source"', {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    execSync("git checkout -b bosun/codex-self-improvement-loop-commits", {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });

    initGitRepo(worktreePath);
    writeRuntimeSourceFiles(worktreePath, "baseline");
    writeTextFile(
      worktreePath,
      "package.json",
      `${JSON.stringify({
        name: "bosun-test",
        version: "1.0.0",
        files: [],
      }, null, 2)}\n`,
    );
    execSync("git add .", {
      cwd: worktreePath,
      stdio: ["ignore", "ignore", "ignore"],
    });
    execSync('git commit -m "baseline worktree"', {
      cwd: worktreePath,
      stdio: ["ignore", "ignore", "ignore"],
    });

    const ensureResult = ensureWorktreeRuntimeSetup(repoRoot, worktreePath);
    const syncedPackageJson = readFileSync(join(worktreePath, "package.json"), "utf8");
    const porcelain = execSync("git status --short -- package.json", {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const skipWorktreeFlag = execSync("git ls-files -v package.json", {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim().charAt(0);

    expect(ensureResult.runtimeSync.syncedFiles).toContain("package.json");
    expect(ensureResult.gitIndex.skippedFiles).toContain("package.json");
    expect(syncedPackageJson).toContain('"agent/agent-launcher.mjs"');
    expect(porcelain).toBe("");
    expect(skipWorktreeFlag).toBe("S");
  });
});
