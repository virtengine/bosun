import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn(() => true));
const resolvePwshRuntimeMock = vi.hoisted(() =>
  vi.fn(() => ({ command: "pwsh" })),
);
const inspectWorktreeRuntimeSetupMock = vi.hoisted(() =>
  vi.fn(() => ({ ok: true, issues: [], missingFiles: [], hooksPath: ".githooks" })),
);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawnSync: spawnSyncMock,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    existsSync: existsSyncMock,
  };
});

vi.mock("../shell/pwsh-runtime.mjs", () => ({
  resolvePwshRuntime: resolvePwshRuntimeMock,
}));

vi.mock("../workspace/worktree-setup.mjs", () => ({
  inspectWorktreeRuntimeSetup: inspectWorktreeRuntimeSetupMock,
}));

const { formatPreflightReport, runPreflightChecks } = await import(
  "../infra/preflight.mjs"
);

const ORIGINAL_ENV = { ...process.env };

function normalizeCommand(command, argsOrOptions) {
  if (Array.isArray(argsOrOptions)) {
    return `${command} ${argsOrOptions.join(" ")}`.trim();
  }
  return String(command).trim();
}

function createSpawnMock({ coreEditor = ":" } = {}) {
  return (command, argsOrOptions) => {
    const normalized = normalizeCommand(command, argsOrOptions);

    if (normalized.includes("-e process.exit(0)")) {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (normalized.startsWith("git --version")) {
      return { status: 0, stdout: "git version 2.49.0\n", stderr: "" };
    }
    if (normalized.startsWith("gh --version")) {
      return { status: 0, stdout: "gh version 2.71.0\n", stderr: "" };
    }
    if (normalized.startsWith("node --version")) {
      return { status: 0, stdout: "v22.15.0\n", stderr: "" };
    }
    if (normalized.startsWith("pnpm --version")) {
      return { status: 0, stdout: "10.4.1\n", stderr: "" };
    }
    if (normalized.startsWith("go version")) {
      return { status: 0, stdout: "go version go1.23.0 windows/amd64\n", stderr: "" };
    }
    if (normalized.startsWith("pwsh -NoProfile -Command")) {
      return { status: 0, stdout: "7.5.0\n", stderr: "" };
    }
    if (normalized.startsWith("bash --version")) {
      return { status: 0, stdout: "GNU bash, version 5.2.21\n", stderr: "" };
    }
    if (normalized.startsWith("sh --version")) {
      return { status: 0, stdout: "sh 5.2\n", stderr: "" };
    }
    if (normalized.startsWith("git config --get user.name")) {
      return { status: 0, stdout: "Bosun Bot\n", stderr: "" };
    }
    if (normalized.startsWith("git config --get user.email")) {
      return { status: 0, stdout: "bosun@example.com\n", stderr: "" };
    }
    if (normalized.startsWith("git config --get core.editor")) {
      return { status: 0, stdout: `${coreEditor}\n`, stderr: "" };
    }
    if (normalized.startsWith("git status --porcelain")) {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (normalized.startsWith("gh auth status -h github.com")) {
      return { status: 0, stdout: "Logged in to github.com\n", stderr: "" };
    }
    if (
      normalized.startsWith("powershell -NoProfile -Command Get-PSDrive -Name")
    ) {
      return {
        status: 0,
        stdout: JSON.stringify({
          Used: 20 * 1024 * 1024 * 1024,
          Free: 120 * 1024 * 1024 * 1024,
        }),
        stderr: "",
      };
    }
    if (normalized.startsWith("df -kP")) {
      return {
        status: 0,
        stdout:
          "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 52428800 10485760 41943040 20% /\n",
        stderr: "",
      };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
}

function getInteractiveEditorWarning(result) {
  return result.warnings.find((warn) =>
    /interactive git editor/i.test(`${warn.title}\n${warn.message}`),
  );
}

describe("preflight interactive git editor warnings", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.GIT_EDITOR;
    spawnSyncMock.mockReset();
    spawnSyncMock.mockImplementation(createSpawnMock());
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(true);
    inspectWorktreeRuntimeSetupMock.mockReset();
    inspectWorktreeRuntimeSetupMock.mockReturnValue({
      ok: true,
      issues: [],
      missingFiles: [],
      hooksPath: ".githooks",
    });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("warns when core.editor is interactive and includes a one-command fix", () => {
    spawnSyncMock.mockImplementation(
      createSpawnMock({
        coreEditor: "code --wait",
      }),
    );

    const result = runPreflightChecks({ repoRoot: "C:\\repo" });
    const warning = getInteractiveEditorWarning(result);

    expect(result.ok).toBe(true);
    expect(warning).toBeDefined();
    expect(`${warning.title}\n${warning.message}`).toMatch(
      /node git-editor-fix\.mjs/i,
    );
    expect(`${warning.title}\n${warning.message}`).toMatch(/code --wait/i);
  });

  it("warns when GIT_EDITOR is interactive even when core.editor is safe", () => {
    process.env.GIT_EDITOR = "vim";
    spawnSyncMock.mockImplementation(
      createSpawnMock({
        coreEditor: ":",
      }),
    );

    const result = runPreflightChecks({ repoRoot: "C:\\repo" });
    const warning = getInteractiveEditorWarning(result);

    expect(result.ok).toBe(true);
    expect(warning).toBeDefined();
    expect(`${warning.title}\n${warning.message}`).toMatch(
      /node git-editor-fix\.mjs/i,
    );
    expect(`${warning.title}\n${warning.message}`).toMatch(/vim/i);
  });

  it("does not warn when editor configuration is non-interactive", () => {
    spawnSyncMock.mockImplementation(
      createSpawnMock({
        coreEditor: ":",
      }),
    );

    const result = runPreflightChecks({ repoRoot: "C:\\repo" });
    const warning = getInteractiveEditorWarning(result);

    expect(result.ok).toBe(true);
    expect(warning).toBeUndefined();
  });

  it("surfaces the interactive-editor warning in formatted preflight output", () => {
    spawnSyncMock.mockImplementation(
      createSpawnMock({
        coreEditor: "nano",
      }),
    );

    const result = runPreflightChecks({ repoRoot: "C:\\repo" });
    const report = formatPreflightReport(result);

    expect(report).toContain("Warnings:");
    expect(report).toMatch(/interactive git editor/i);
    expect(report).toContain("node git-editor-fix.mjs");
  });

  it("fails when worktree runtime setup is incomplete", () => {
    inspectWorktreeRuntimeSetupMock.mockReturnValue({
      ok: false,
      issues: [
        "git core.hooksPath is not configured",
        "missing worktree setup files: .codex/hooks.json, .githooks/pre-push",
      ],
      missingFiles: [".codex/hooks.json", ".githooks/pre-push"],
      hooksPath: "",
    });

    const result = runPreflightChecks({ repoRoot: "C:\\repo" });

    expect(result.ok).toBe(false);
    expect(result.errors.some((entry) => /worktree runtime setup is incomplete/i.test(entry.title))).toBe(true);
  });

  it("fails with a targeted error when Node child-process launch is blocked", () => {
    spawnSyncMock.mockImplementation((command, argsOrOptions) => {
      const normalized = normalizeCommand(command, argsOrOptions);
      if (normalized.includes("-e process.exit(0)")) {
        return {
          status: -1,
          stdout: "",
          stderr: "spawnSync node EPERM",
          error: { code: "EPERM", message: "spawnSync node EPERM" },
        };
      }
      return createSpawnMock()(command, argsOrOptions);
    });

    const result = runPreflightChecks({ repoRoot: "C:\\repo" });
    const report = formatPreflightReport(result);

    expect(result.ok).toBe(false);
    expect(result.details.childProcess.ok).toBe(false);
    expect(result.errors.some((entry) => /Node child-process launch is blocked/i.test(entry.title))).toBe(true);
    expect(report).toContain("Toolchain:");
    expect(report).toContain("git: blocked");
    expect(report).toContain("Child process launch: EPERM");
  });
});
