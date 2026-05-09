import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildVitestCacheOverrideConfigSource,
  ensureVitestEntry,
  findPackageRoot,
  findVitestConfigPath,
  findVitestPackageSpec,
  findVitestEntry,
  injectVitestConfigOverride,
  isDirectExecution,
  resolveVitestCacheDir,
  resolveVitestConfigLoader,
  resolveVitestExperimentalCacheDir,
  resolveVitestArgs,
  runVitest,
} from "../tools/vitest-runner.mjs";
import { buildVitestBatchArgs, buildVitestFullSuitePlan } from "../tools/vitest-full-suite.mjs";

const tempDirs = [];
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function createFixture() {
  const root = mkdtempSync(resolve(tmpdir(), "bosun-vitest-runner-"));
  tempDirs.push(root);
  return root;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("vitest-runner", () => {
  it("keeps the pre-push adjacency map aligned with newer non-prefixed suites", () => {
    const prePushHook = readFileSync(resolve(repoRoot, ".githooks", "pre-push"), "utf8");

    expect(prePushHook).toContain('"workflow/|workflow-*|workflow-task-lifecycle*|workflow-write-file-encoding*|workflow-pipeline-primitives*|workflow-research-evidence-sidecar*|manual-flows*|mcp-workflow-adapter*|bosun-native-workflow-nodes*|meeting-workflow*|run-evaluator*|state-ledger-sqlite*|webhook-gateway*|credential-store*|cron-scheduler*"');
    expect(prePushHook).toContain('"infra/|monitor-*|heartbeat-monitor*|daemon-*|restart-*|startup-*|maintenance-*|anomaly-*|preflight*|tracing*|tui-bridge*|windows-hidden-child-processes*|weekly-agent-work-report*|workflow-task-lifecycle*|workflow-engine*|session-telemetry*"');
    expect(prePushHook).toContain('"agent/|agent-*|primary-agent*|fleet-*|review-agent*|analyze-agent*|autofix*|streaming-agent*|hook-library*|weekly-agent-work-report*|internal-harness*|harness-runtime*|harness-surface-integration*|provider-kernel*|provider-kernel-support*|session-manager*|tool-governance-support*|tool-orchestrator*"');
    expect(prePushHook).toContain('"telegram/|telegram-*|harness-surface-integration*|whatsapp-*|weekly-agent-work-report*|harness-surface-clients*"');
    expect(prePushHook).toContain('"task/|task-*|workflow-task-lifecycle*|kanban-*|state-ledger-sqlite*|ve-orchestrator*|vk-api*|ve-kanban*"');
    expect(prePushHook).toContain('"lib/|logger*|log-tail*|utils*|library-*|error-detector*|context-*|codebase-audit*|repo-map*|state-ledger-sqlite*|hot-path-runtime*"');
  });

  it("keeps a named-project fallback in the pre-push hook for older worktrees", () => {
    const prePushHook = readFileSync(resolve(repoRoot, ".githooks", "pre-push"), "utf8");

    expect(prePushHook).toContain("vitest_supports_named_projects()");
    expect(prePushHook).toContain('serialized_runner_args+=(--project isolated)');
    expect(prePushHook).toContain('regular_runner_args+=(--project fast)');
    expect(prePushHook).toContain("falling back to default project execution");
  });

  it("finds vitest from an ancestor node_modules directory", () => {
    const root = createFixture();
    const vitestEntry = resolve(root, "node_modules", "vitest", "vitest.mjs");
    const nestedWorktree = resolve(root, ".bosun", "worktrees", "task-123");

    mkdirSync(resolve(vitestEntry, ".."), { recursive: true });
    mkdirSync(nestedWorktree, { recursive: true });
    writeFileSync(vitestEntry, "export default {};\n");

    expect(findVitestEntry({ startDir: nestedWorktree })).toBe(vitestEntry);
  });

  it("returns null when vitest is unavailable in any ancestor", () => {
    const root = createFixture();
    const nestedWorktree = resolve(root, ".bosun", "worktrees", "task-456");
    mkdirSync(nestedWorktree, { recursive: true });

    expect(findVitestEntry({ startDir: nestedWorktree })).toBeNull();
  });

  it("finds the nearest package root from a nested worktree path", () => {
    const root = createFixture();
    const nestedWorktree = resolve(root, ".bosun", "worktrees", "task-789", "deep");

    mkdirSync(nestedWorktree, { recursive: true });
    writeFileSync(
      resolve(root, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0" }),
    );

    expect(findPackageRoot({ startDir: nestedWorktree })).toBe(root);
  });

  it("finds the declared vitest package spec from the nearest package root", () => {
    const root = createFixture();
    const nestedWorktree = resolve(root, ".bosun", "worktrees", "task-790", "deep");

    mkdirSync(nestedWorktree, { recursive: true });
    writeFileSync(
      resolve(root, "package.json"),
      JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        devDependencies: { vitest: "^4.0.18" },
      }),
    );

    expect(findVitestPackageSpec({ startDir: nestedWorktree })).toBe("^4.0.18");
  });

  it("hydrates vitest into the nearest package root when it is missing", () => {
    const root = createFixture();
    const nestedWorktree = resolve(root, ".bosun", "worktrees", "task-791", "deep");
    const spawnCalls = [];

    mkdirSync(nestedWorktree, { recursive: true });
    writeFileSync(
      resolve(root, "package.json"),
      JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        devDependencies: { vitest: "^4.0.18" },
      }),
    );

    const vitestEntry = ensureVitestEntry({
      startDir: nestedWorktree,
      log: () => {},
      spawn(command, args, options) {
        spawnCalls.push({
          command,
          args,
          cwd: options.cwd,
          stdio: options.stdio,
        });
        mkdirSync(resolve(root, "node_modules", "vitest"), { recursive: true });
        writeFileSync(resolve(root, "node_modules", "vitest", "vitest.mjs"), "export default {};\n");
        return { status: 0 };
      },
    });

    expect(vitestEntry).toBe(resolve(root, "node_modules", "vitest", "vitest.mjs"));
    expect(spawnCalls).toEqual([
      {
        command: process.platform === "win32"
          ? (process.env.ComSpec || process.env.COMSPEC || "cmd.exe")
          : "npm",
        args: process.platform === "win32"
          ? [
              "/d",
              "/s",
              "/c",
              "npm",
              "install",
              "--no-save",
              "--package-lock=false",
              "--no-audit",
              "--no-fund",
              "--ignore-scripts",
              "vitest@^4.0.18",
            ]
          : [
              "install",
              "--no-save",
              "--package-lock=false",
              "--no-audit",
              "--no-fund",
              "--ignore-scripts",
              "vitest@^4.0.18",
            ],
        cwd: root,
        stdio: "inherit",
      },
    ]);
  });

  it("throws when hydration completes but vitest is still unavailable", () => {
    const root = createFixture();
    const nestedWorktree = resolve(root, ".bosun", "worktrees", "task-792", "deep");

    mkdirSync(nestedWorktree, { recursive: true });
    writeFileSync(
      resolve(root, "package.json"),
      JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        devDependencies: { vitest: "^4.0.18" },
      }),
    );

    expect(() => ensureVitestEntry({
      startDir: nestedWorktree,
      log: () => {},
      spawn() {
        return { status: 0 };
      },
    })).toThrow("hydrated vitest@^4.0.18");
  });

  it("resolves relative config paths from the package root when invoked in a nested worktree", () => {
    const root = createFixture();
    const nestedWorktree = resolve(root, ".bosun", "worktrees", "task-999", "deep");
    const configPath = resolve(root, "vitest.config.mjs");

    mkdirSync(nestedWorktree, { recursive: true });
    writeFileSync(
      resolve(root, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0" }),
    );
    writeFileSync(configPath, "export default {};\n");

    const expected = ["run", "--config", configPath, "--configLoader", "runner"];

    expect(
      resolveVitestArgs(["run", "--config", "vitest.config.mjs"], {
        startDir: nestedWorktree,
      }),
    ).toEqual(expected);
  });

  it("prefers the native config loader when node_modules is a symlinked shared dependency root", () => {
    const root = createFixture();
    const sharedDeps = createFixture();
    const nestedWorktree = resolve(root, ".bosun", "worktrees", "task-999", "deep");
    const configPath = resolve(root, "vitest.config.mjs");

    mkdirSync(nestedWorktree, { recursive: true });
    mkdirSync(resolve(sharedDeps, "vitest"), { recursive: true });
    writeFileSync(resolve(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
    writeFileSync(configPath, "export default {};\n");
    symlinkSync(sharedDeps, resolve(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");

    expect(resolveVitestConfigLoader({ startDir: nestedWorktree })).toBe("native");
    expect(
      resolveVitestArgs(["run", "--config", "vitest.config.mjs"], {
        startDir: nestedWorktree,
      }),
    ).toEqual(["run", "--config", configPath, "--configLoader", "native"]);
  });

  it("expands path-like glob arguments before forwarding them to Vitest", () => {
    const root = createFixture();
    mkdirSync(resolve(root, "tests"), { recursive: true });
    writeFileSync(
      resolve(root, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0" }),
    );
    writeFileSync(resolve(root, "tests", "workspace-alpha.test.mjs"), "export {};\n");
    writeFileSync(resolve(root, "tests", "memory-write.test.mjs"), "export {};\n");
    writeFileSync(resolve(root, "tests", "other.test.mjs"), "export {};\n");

    const expected = [
      "run",
      "tests/workspace-alpha.test.mjs",
      "tests/memory-write.test.mjs",
      "--configLoader",
      "runner",
    ];

    expect(
      resolveVitestArgs(["run", "tests/workspace-*.test.mjs", "tests/*memory*.test.mjs"], {
        startDir: root,
      }),
    ).toEqual(expected);
  });

  it("routes package test scripts through the worktree-safe runner", () => {
    const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));

    expect(packageJson.scripts.test).toContain("tools/vitest-full-suite.mjs");
    expect(packageJson.scripts["test:quick"]).toContain("tools/vitest-runner.mjs");
    expect(packageJson.scripts["test:vitest"]).toContain("tools/vitest-full-suite.mjs");
    expect(packageJson.scripts["test:watch"]).toContain("tools/vitest-runner.mjs");
    expect(packageJson.scripts["test:voice-provider-smoke"]).toContain("tools/vitest-runner.mjs");
    expect(packageJson.scripts["check:native-call-parity"]).toContain("tools/vitest-runner.mjs");
    expect(packageJson.scripts["prepush:check"]).toContain("npm run test:all");
    expect(packageJson.scripts["test:node"]).toContain("--no-warnings=ExperimentalWarning");
    expect(packageJson.scripts["test:workflow-guaranteed"]).toContain("tools/run-workflow-guaranteed-suite.mjs");
    expect(packageJson.scripts.test).not.toContain("node_modules/vitest/vitest.mjs");
    expect(packageJson.scripts["test:quick"]).not.toContain("node_modules/vitest/vitest.mjs");
    expect(packageJson.scripts["test:vitest"]).not.toContain("node_modules/vitest/vitest.mjs");
  });

  it("isolates heavyweight suites from the grouped full-suite batch", () => {
    const previous = process.env.BOSUN_VITEST_INCLUDE_GUARANTEED;
    delete process.env.BOSUN_VITEST_INCLUDE_GUARANTEED;
    const {
      groupedSuites,
      heavySuites,
      deferredHeavySuites = [],
    } = buildVitestFullSuitePlan({ startDir: repoRoot });

    expect(groupedSuites).not.toContain("tests/workflow-engine.test.mjs");
    expect(groupedSuites).not.toContain("tests/workflow-templates-e2e.test.mjs");
    if (process.platform === "win32") {
      expect(heavySuites).not.toContain("tests/workflow-engine.test.mjs");
      expect(heavySuites).not.toContain("tests/workflow-templates-e2e.test.mjs");
      expect(deferredHeavySuites).toContain("tests/workflow-engine.test.mjs");
      expect(deferredHeavySuites).toContain("tests/workflow-templates-e2e.test.mjs");
      expect(heavySuites).not.toContain("tests/workflow-guaranteed.test.mjs");
      expect(groupedSuites).not.toContain("tests/workflow-guaranteed.test.mjs");
    } else {
      expect(heavySuites).toContain("tests/workflow-engine.test.mjs");
      expect(heavySuites).toContain("tests/workflow-templates-e2e.test.mjs");
      expect(heavySuites).toContain("tests/workflow-guaranteed.test.mjs");
      expect(groupedSuites).not.toContain("tests/workflow-guaranteed.test.mjs");
    }
    expect(groupedSuites.length + heavySuites.length).toBeGreaterThan(0);

    process.env.BOSUN_VITEST_INCLUDE_GUARANTEED = "1";
    const explicitPlan = buildVitestFullSuitePlan({ startDir: repoRoot });
    if (process.platform === "win32") {
      expect(explicitPlan.heavySuites).not.toContain("tests/workflow-guaranteed.test.mjs");
      expect(explicitPlan.deferredHeavySuites || []).toContain("tests/workflow-guaranteed.test.mjs");
    } else {
      expect(explicitPlan.heavySuites).toContain("tests/workflow-guaranteed.test.mjs");
    }
    expect(explicitPlan.groupedSuites).not.toContain("tests/workflow-guaranteed.test.mjs");

    if (previous == null) delete process.env.BOSUN_VITEST_INCLUDE_GUARANTEED;
    else process.env.BOSUN_VITEST_INCLUDE_GUARANTEED = previous;
  });

  it("builds full-suite vitest batches without unsupported minWorkers flags", () => {
    expect(
      buildVitestBatchArgs(["tests/workflow-engine.test.mjs"], { maxWorkers: 1, project: "isolated" }),
    ).toEqual([
      "run",
      "--config",
      "vitest.config.mjs",
      "--project",
      "isolated",
      "--maxWorkers",
      "1",
      "tests/workflow-engine.test.mjs",
    ]);
  });

  it("pins grouped and isolated suite batches to their matching Vitest projects", () => {
    expect(
      buildVitestBatchArgs(["tests/a.test.mjs", "tests/b.test.mjs"], { project: "fast" }),
    ).toEqual([
      "run",
      "--config",
      "vitest.config.mjs",
      "--project",
      "fast",
      "tests/a.test.mjs",
      "tests/b.test.mjs",
    ]);
    expect(
      buildVitestBatchArgs(["tests/ui-server.test.mjs"], { project: "isolated" }),
    ).toEqual([
      "run",
      "--config",
      "vitest.config.mjs",
      "--project",
      "isolated",
      "tests/ui-server.test.mjs",
    ]);
    expect(
      buildVitestBatchArgs(["tests/gemini-shell.test.mjs"], { project: "fast" }),
    ).toEqual([
      "run",
      "--config",
      "vitest.config.mjs",
      "--project",
      "fast",
      "tests/gemini-shell.test.mjs",
    ]);
  });

  it("caps grouped full-suite worker fan-out on Windows by default", () => {
    const source = readFileSync(resolve(repoRoot, "tools", "vitest-full-suite.mjs"), "utf8");
    expect(source).toContain('process.env.BOSUN_VITEST_MAX_WORKERS || (process.platform === "win32" ? "4" : "")');
    expect(source).toContain('process.env.BOSUN_VITEST_GROUP_BATCH_SIZE || (process.platform === "win32" ? "12" : "0")');
    expect(source).toContain('process.env.BOSUN_VITEST_WORKFLOW_GUARANTEED_SHARDS || ""');
    expect(source).toContain('BOSUN_WORKFLOW_GUARANTEED_CHILD');
    expect(source).toContain('VITEST_TOTAL_SHARDS');
  });

  it("routes the pre-push hook through the worktree-safe runner", () => {
    const prePushHook = readFileSync(resolve(repoRoot, ".githooks", "pre-push"), "utf8");

    expect(prePushHook).toContain('local -a runner_args=(run --config vitest.config.mjs)');
    expect(prePushHook).toContain('local -a serialized_runner_args=("${runner_args[@]}" --maxWorkers 1)');
    expect(prePushHook).toContain('local -a regular_runner_args=("${runner_args[@]}")');
    expect(prePushHook).toContain('if vitest_supports_named_projects "fast" && vitest_supports_named_projects "isolated"; then');
    expect(prePushHook).toContain('serialized_runner_args+=(--project isolated)');
    expect(prePushHook).toContain('regular_runner_args+=(--project fast)');
    expect(prePushHook).toContain('node tools/vitest-runner.mjs "${serialized_runner_args[@]}"');
    expect(prePushHook).toContain('node tools/vitest-runner.mjs "${regular_runner_args[@]}"');
    expect(prePushHook).toContain('local serialized_batch_size="${BOSUN_PREPUSH_SERIAL_BATCH_SIZE:-4}"');
    expect(prePushHook).toContain('local batch_size="${BOSUN_PREPUSH_BATCH_SIZE:-50}"');
    expect(prePushHook).toContain('echo "[hooks] auto-enabling Vitest batching for large targeted set"');
    expect(prePushHook).toContain('BOSUN_PREPUSH_RUN_PACKED_SMOKE');
    expect(prePushHook).toContain('BOSUN_PREPUSH_INCLUDE_HEAVY');
    expect(prePushHook).toContain('BOSUN_RUN_HEAVY_TESTS');
    expect(prePushHook).toContain('tests/workflow-templates-e2e.test.mjs|\\');
    expect(prePushHook).toContain('tests/workflow-guaranteed.test.mjs');
    expect(prePushHook).toContain('tests/ui-server.test.mjs');
    expect(prePushHook).toContain('deferring heavyweight local suites to CI/default full runs');
    expect(prePushHook).toContain('tests/*workflow*e2e*.test.mjs)');
    expect(prePushHook).toContain('tests/ui-server.test.mjs)');
    expect(prePushHook).not.toContain('tests/bosun-mcp-server.test.mjs|tests/ui-server.test.mjs)');
    expect(prePushHook).not.toContain('tests/ui-server*.test.mjs');
    expect(prePushHook).toContain('local -a slice=("${regular_tests[@]:$offset:$batch_size}")');
    expect(prePushHook).toContain('local -a slice=("${tests[@]:$offset:$batch_size}")');
    expect(prePushHook).not.toContain("node node_modules/vitest/vitest.mjs");
  });

  it("keeps the slow template full-pipeline execution opt-in for local runs", () => {
    const source = readFileSync(resolve(repoRoot, "tests", "workflow-templates-e2e.test.mjs"), "utf8");

    expect(source).toContain('import { isCiOnlyTestRun } from "./test-speed-gates.mjs";');
    expect(source).toContain("const runFullTemplatePipelineE2E = isCiOnlyTestRun;");
    expect(source).toContain("const fullPipelineIt = runFullTemplatePipelineE2E ? it : it.skip;");
    expect(source).toContain('fullPipelineIt("installs and executes every template in sequence without cross-contamination"');
  });

  it("keeps the local speed-gate helper wired for CI-only tests", () => {
    const source = readFileSync(resolve(repoRoot, "tests", "test-speed-gates.mjs"), "utf8");

    expect(source).toContain('process.env.GITHUB_ACTIONS === "true" || process.env.CI === "true"');
    expect(source).toContain("export const skipLocallyForSpeed = !isCiOnlyTestRun;");
  });

  it("scopes file discovery and splits fast versus isolated Vitest projects", () => {
    const source = readFileSync(resolve(repoRoot, "vitest.config.mjs"), "utf8");

    expect(source).toContain('dir: "tests"');
    expect(source).toContain('fsModuleCache: process.env.BOSUN_VITEST_FS_CACHE !== "0"');
    expect(source).toContain('name: "fast"');
    expect(source).toContain('pool: "forks"');
    expect(source).toContain('isolate: true');
    expect(source).toContain('name: "isolated"');
    expect(source).toContain('pool: "forks"');
    expect(source).toContain('include: isolatedProjectSuites');
  });

  it("keeps workflow-template e2e command and agent nodes shimmed for local determinism", () => {
    const source = readFileSync(resolve(repoRoot, "tests", "workflow-templates-e2e.test.mjs"), "utf8");

    expect(source).toContain('registerForE2E("action.run_command"');
    expect(source).toContain('registerForE2E("action.run_agent"');
    expect(source).toContain("Execute a deterministic command result for e2e tests");
    expect(source).toContain("Return deterministic agent output for e2e tests");
  });

  it("detects direct execution for Windows-style script paths", () => {
    const scriptPath = resolve(repoRoot, "tools", "vitest-runner.mjs");

    expect(
      isDirectExecution([process.execPath, scriptPath]),
    ).toBe(true);
  });

  it("adds the runner config loader by default", () => {
    const root = createFixture();
    writeFileSync(
      resolve(root, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0" }),
    );

    expect(resolveVitestArgs(["run"], { startDir: root, packageRoot: root })).toEqual([
      "run",
      "--configLoader",
      "runner",
    ]);
  });

  it("routes the experimental cache to a writable package-local .cache dir by default", () => {
    const root = createFixture();
    const nestedWorktree = resolve(root, ".bosun", "worktrees", "task-1000", "deep");

    mkdirSync(nestedWorktree, { recursive: true });
    writeFileSync(
      resolve(root, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0" }),
    );

    expect(
      resolveVitestExperimentalCacheDir({
        startDir: nestedWorktree,
        env: {},
      }),
    ).toBe(resolve(root, ".cache", "vitest", "experimental-cache"));
  });

  it("routes the vite optimizer cache to a writable package-local .cache dir by default", () => {
    const root = createFixture();
    const nestedWorktree = resolve(root, ".bosun", "worktrees", "task-1000", "deep");

    mkdirSync(nestedWorktree, { recursive: true });
    writeFileSync(
      resolve(root, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0" }),
    );

    expect(
      resolveVitestCacheDir({
        startDir: nestedWorktree,
        env: {},
      }),
    ).toBe(resolve(root, ".cache", "vitest", "vite"));
  });

  it("lets runVitest inject a writable experimental cache into child env", () => {
    const root = createFixture();
    const nestedWorktree = resolve(root, ".bosun", "worktrees", "task-1001");
    const spawnCalls = [];

    mkdirSync(nestedWorktree, { recursive: true });
    writeFileSync(
      resolve(root, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0" }),
    );

    const exitCode = runVitest(["run"], {
      startDir: nestedWorktree,
      env: {},
      ensureVitest: () => resolve(root, "node_modules", "vitest", "vitest.mjs"),
      spawn(command, args, options) {
        spawnCalls.push({ command, args, options });
        return { status: 0 };
      },
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].options.env.VITEST_EXPERIMENTAL_CACHE).toBe(
      resolve(root, ".cache", "vitest", "experimental-cache"),
    );
    expect(existsSync(spawnCalls[0].options.env.VITEST_EXPERIMENTAL_CACHE)).toBe(true);
    const configIndex = spawnCalls[0].args.findIndex((arg) => arg === "--config");
    expect(configIndex).toBeGreaterThan(-1);
    const overridePath = spawnCalls[0].args[configIndex + 1];
    expect(existsSync(overridePath)).toBe(true);
    const overrideSource = readFileSync(overridePath, "utf8");
    expect(overrideSource).toContain(JSON.stringify(resolve(root, ".cache", "vitest", "experimental-cache")));
    expect(overrideSource).toContain(JSON.stringify(resolve(root, ".cache", "vitest", "vite")));
    expect(overrideSource).toContain('fsModuleCachePath');
  });

  it("strips inherited git worktree plumbing from the vitest child env", () => {
    const root = createFixture();
    const nestedWorktree = resolve(root, ".bosun", "worktrees", "task-1001");
    const spawnCalls = [];

    mkdirSync(nestedWorktree, { recursive: true });
    writeFileSync(
      resolve(root, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0" }),
    );

    const exitCode = runVitest(["run"], {
      startDir: nestedWorktree,
      env: {
        GIT_DIR: "/tmp/bad-dir",
        GIT_WORK_TREE: "/tmp/bad-tree",
        GIT_COMMON_DIR: "/tmp/bad-common",
      },
      ensureVitest: () => resolve(root, "node_modules", "vitest", "vitest.mjs"),
      spawn(command, args, options) {
        spawnCalls.push({ command, args, options });
        return { status: 0 };
      },
    });

    expect(exitCode).toBe(0);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].options.env.GIT_DIR).toBeUndefined();
    expect(spawnCalls[0].options.env.GIT_WORK_TREE).toBeUndefined();
    expect(spawnCalls[0].options.env.GIT_COMMON_DIR).toBeUndefined();
  });

  it("finds the default vitest config from the package root", () => {
    const root = createFixture();
    const nestedWorktree = resolve(root, ".bosun", "worktrees", "task-1002");
    const configPath = resolve(root, "vitest.config.mjs");

    mkdirSync(nestedWorktree, { recursive: true });
    writeFileSync(resolve(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
    writeFileSync(configPath, "export default {};\n");

    expect(findVitestConfigPath({ startDir: nestedWorktree })).toBe(configPath);
  });

  it("injects a generated config override ahead of the config loader", () => {
    expect(
      injectVitestConfigOverride(["run", "--configLoader", "runner"], "/tmp/bosun-vitest-override.mjs"),
    ).toEqual([
      "run",
      "--config",
      "/tmp/bosun-vitest-override.mjs",
      "--configLoader",
      "runner",
    ]);
  });

  it("builds a config override that merges cacheDir and fsModuleCachePath", () => {
    const source = buildVitestCacheOverrideConfigSource({
      baseConfigPath: "/repo/vitest.config.mjs",
      viteCacheDir: "/repo/.cache/vitest/vite",
      experimentalCacheDir: "/repo/.cache/vitest/experimental-cache",
    });

    expect(source).toContain(`await import(${JSON.stringify(pathToFileURL("/repo/vitest.config.mjs").href)})`);
    expect(source).toContain(`cacheDir: ${JSON.stringify("/repo/.cache/vitest/vite")}`);
    expect(source).toContain(`fsModuleCachePath: ${JSON.stringify("/repo/.cache/vitest/experimental-cache")}`);
    expect(source).toContain("mergeConfig");
  });

  it("preserves explicit config loader selection", () => {
    expect(resolveVitestArgs(["run", "--configLoader", "native"])).toEqual([
      "run",
      "--configLoader",
      "native",
    ]);
    expect(resolveVitestArgs(["run", "--config-loader=runner"])).toEqual([
      "run",
      "--config-loader=runner",
    ]);
  });

  it("includes the Windows realpath shim for Vitest child processes", () => {
    const source = readFileSync(resolve(repoRoot, "tools", "vitest-runner.mjs"), "utf8");
    expect(source).toContain("vite-windows-realpath-shim.mjs");
    expect(source).toContain('nodeArgs.push("--import"');
    expect(source).toContain('--no-warnings=ExperimentalWarning');
    expect(source).toContain("--max-old-space-size=");
    expect(source).toContain("BOSUN_VITEST_HEAP_MB");
  });

  it("patches net use probes for Windows realpath handling", () => {
    const source = readFileSync(resolve(repoRoot, "tools", "vite-windows-realpath-shim.mjs"), "utf8");
    expect(source).toContain("childProcess.exec = function patchedExec");
    expect(source).toContain('normalizedCommand === "net use"');
    expect(source).toContain("syncBuiltinESMExports()");
  });

  it("keeps demo-default syncing out of Vitest global setup", () => {
    const source = readFileSync(resolve(repoRoot, "vitest.config.mjs"), "utf8");

    expect(source).not.toContain("globalSetup");
    expect(source).not.toContain("syncDemoDefaults");
  });

  it("keeps child-spawn detection out of the per-file test setup", () => {
    const configSource = readFileSync(resolve(repoRoot, "vitest.config.mjs"), "utf8");
    const setupSource = readFileSync(resolve(repoRoot, "tests", "setup.mjs"), "utf8");

    expect(configSource).toContain("function detectBlockedChildSpawn()");
    expect(setupSource).not.toContain("spawnSync");
    expect(setupSource).not.toContain("detectBlockedChildSpawn");
  });
});
