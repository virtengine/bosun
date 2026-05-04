import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";
import { resolvePwshRuntime } from "../shell/pwsh-runtime.mjs";
import { inspectWorktreeRuntimeSetup } from "../workspace/worktree-setup.mjs";

const isWindows = process.platform === "win32";
const MIN_FREE_GB = Number(process.env.BOSUN_MIN_FREE_GB || "10");
const MIN_FREE_BYTES = MIN_FREE_GB * 1024 * 1024 * 1024;
const GIT_EDITOR_FIX_COMMAND = "node git-editor-fix.mjs";

function runCommand(command, args, options = {}) {
  try {
    const useShell = options.shell ?? isWindows;
    // DEP0190 fix: Node.js 24+ warns when passing args array with shell: true.
    // Join command + args into a single string when using shell mode.
    if (useShell && args && args.length > 0) {
      const fullCommand = [command, ...args].join(" ");
      return spawnSync(fullCommand, {
        encoding: "utf8",
        windowsHide: true,
        shell: true,
        ...options,
        // Ensure shell stays true (override any options.shell)
      });
    }
    return spawnSync(command, args, {
      encoding: "utf8",
      windowsHide: true,
      // On Windows, use shell to resolve .cmd/.ps1 shims (pnpm, gh, etc.)
      shell: useShell,
      ...options,
    });
  } catch (error) {
    return { error, status: -1, stdout: "", stderr: error?.message || "" };
  }
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let idx = 0;
  let num = value;
  while (num >= 1024 && idx < units.length - 1) {
    num /= 1024;
    idx += 1;
  }
  return `${num.toFixed(num >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function formatDuration(ms) {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  return `${min}m`;
}

function readOutput(res) {
  if (!res) return "";
  return String(res.stdout || "").trim();
}

function checkGitConfig(repoRoot) {
  const name = runCommand("git", ["config", "--get", "user.name"], {
    cwd: repoRoot,
  });
  const email = runCommand("git", ["config", "--get", "user.email"], {
    cwd: repoRoot,
  });
  const nameValue = readOutput(name);
  const emailValue = readOutput(email);
  const ok = Boolean(nameValue) && Boolean(emailValue);
  return {
    ok,
    name: nameValue,
    email: emailValue,
  };
}

function checkWorktreeClean(repoRoot) {
  const status = runCommand("git", ["status", "--porcelain"], {
    cwd: repoRoot,
  });
  const raw = readOutput(status);
  const dirtyFiles = raw ? raw.split(/\r?\n/).filter(Boolean) : [];
  return {
    ok: dirtyFiles.length === 0,
    dirtyFiles,
  };
}

function checkWorktreeRuntimeSetup(repoRoot) {
  if (!existsSync(resolve(repoRoot, ".githooks"))) {
    return { ok: true, issues: [], hooksPath: "", missingFiles: [] };
  }
  return inspectWorktreeRuntimeSetup(repoRoot, repoRoot);
}

/**
 * Detect interactive git editors that block automated commits.
 * Returns `null` if no interactive editor is detected, otherwise an object
 * with `{ editor, source }` describing the offending configuration.
 */
const INTERACTIVE_EDITOR_PATTERNS =
  /\b(vim?|nvim|nano|emacs|pico|joe|mcedit|micro|helix|hx|subl|gedit|kate|notepad)\b|--wait\b/i;

function checkInteractiveEditor(repoRoot) {
  // GIT_EDITOR takes precedence over core.editor in git
  const envEditor = process.env.GIT_EDITOR || "";
  if (envEditor && INTERACTIVE_EDITOR_PATTERNS.test(envEditor)) {
    return { editor: envEditor, source: "GIT_EDITOR" };
  }

  const res = runCommand("git", ["config", "--get", "core.editor"], {
    cwd: repoRoot,
  });
  const coreEditor = readOutput(res);
  if (coreEditor && INTERACTIVE_EDITOR_PATTERNS.test(coreEditor)) {
    return { editor: coreEditor, source: "core.editor" };
  }

  return null;
}

function parseDiskFromPosix(repoRoot) {
  const res = runCommand("df", ["-kP", repoRoot]);
  if (res.status !== 0) return null;
  const lines = readOutput(res).split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  const parts = lines[1].split(/\s+/);
  if (parts.length < 6) return null;
  const totalKb = Number(parts[1]);
  const availKb = Number(parts[3]);
  if (!Number.isFinite(totalKb) || !Number.isFinite(availKb)) return null;
  return {
    totalBytes: totalKb * 1024,
    freeBytes: availKb * 1024,
    mount: parts[5],
  };
}

function parseDiskFromWindows(repoRoot) {
  const driveMatch = repoRoot.match(/^([A-Za-z]):/);
  const drive = driveMatch ? driveMatch[1].toUpperCase() : null;
  if (!drive) return null;
  const ps = `Get-PSDrive -Name ${drive} | Select-Object Used,Free | ConvertTo-Json -Compress`;
  const res = runCommand("powershell", ["-NoProfile", "-Command", ps]);
  if (res.status !== 0) return null;
  const raw = readOutput(res);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const free = Number(parsed?.Free);
    const used = Number(parsed?.Used);
    if (!Number.isFinite(free) || !Number.isFinite(used)) return null;
    return {
      totalBytes: free + used,
      freeBytes: free,
      mount: `${drive}:`,
    };
  } catch {
    return null;
  }
}

function checkDiskSpace(repoRoot) {
  const info = isWindows
    ? parseDiskFromWindows(repoRoot)
    : parseDiskFromPosix(repoRoot);
  if (!info) {
    return { ok: true, info: null };
  }
  const ok = info.freeBytes >= MIN_FREE_BYTES;
  return { ok, info };
}

function checkToolVersion(label, command, args, hint) {
  const res = runCommand(command, args);
  if (res.error || res.status !== 0) {
    const errorCode = String(res.error?.code || "").trim();
    const blocked = errorCode === "EPERM" || /\bEPERM\b/i.test(String(res.stderr || ""));
    return {
      label,
      ok: false,
      version: blocked ? "blocked" : "missing",
      hint: blocked
        ? `Bosun cannot launch ${label} from Node on this machine (${errorCode || "EPERM"}). Repair host child-process permissions/policy first.`
        : hint,
      blocked,
      errorCode,
    };
  }
  const raw = readOutput(res);
  const version = raw ? raw.split(/\r?\n/)[0] : "unknown";
  return { label, ok: true, version };
}

function parseEnvBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const raw = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on", "y"].includes(raw)) return true;
  if (["0", "false", "no", "off", "n"].includes(raw)) return false;
  return fallback;
}

function isShellModeRequested() {
  const script = String(process.env.ORCHESTRATOR_SCRIPT || "")
    .trim()
    .toLowerCase();
  if (script.endsWith(".sh")) return true;
  if (script.endsWith(".ps1")) return false;
  if (parseEnvBool(process.env.BOSUN_SHELL_MODE, false)) return true;
  return !isWindows;
}

function checkToolchain() {
  const shellMode = isShellModeRequested();
  const requiredTools = new Set([
    "git",
    "gh",
    "node",
    shellMode ? "shell" : "pwsh",
  ]);
  const pwshRuntime = resolvePwshRuntime({ preferBundled: true });

  const tools = [
    checkToolVersion(
      "git",
      "git",
      ["--version"],
      "Install Git and ensure it is on PATH.",
    ),
    checkToolVersion(
      "gh",
      "gh",
      ["--version"],
      "Install GitHub CLI (gh) and ensure it is on PATH.",
    ),
    checkToolVersion(
      "node",
      "node",
      ["--version"],
      "Install Node.js 18+ and ensure it is on PATH.",
    ),
    checkToolVersion(
      "pnpm",
      "pnpm",
      ["--version"],
      "Install pnpm (npm install -g pnpm) and ensure it is on PATH.",
    ),
    checkToolVersion(
      "go",
      "go",
      ["version"],
      "Install Go 1.21+ and ensure it is on PATH.",
    ),
    checkToolVersion(
      "pwsh",
      pwshRuntime.command,
      ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"],
      "Install PowerShell 7+ (pwsh) and ensure it is on PATH.",
    ),
  ];
  const bashVersion = checkToolVersion(
    "bash",
    "bash",
    ["--version"],
    "Install bash and ensure it is on PATH.",
  );
  const shVersion = checkToolVersion(
    "sh",
    "sh",
    ["--version"],
    "Install sh and ensure it is on PATH.",
  );
  const shellTool = {
    label: "shell",
    ok: bashVersion.ok || shVersion.ok,
    version: bashVersion.ok ? bashVersion.version : shVersion.version,
    hint: "Install bash/sh and ensure it is on PATH.",
  };
  tools.push(shellTool);

  // Only required tools determine pass/fail — optional tools are warnings
  const ok = tools
    .filter((tool) => requiredTools.has(tool.label))
    .every((tool) => tool.ok);
  return { ok, tools, requiredTools };
}

function checkGhAuth() {
  const tokenPresent = Boolean(
    process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
  );
  const auth = runCommand("gh", ["auth", "status", "-h", "github.com"]);
  if (auth.status === 0) {
    return { ok: true, method: "gh" };
  }
  if (tokenPresent) {
    return { ok: true, method: "token" };
  }
  return { ok: false, method: "none", error: readOutput(auth) };
}

export function checkChildProcessLaunch() {
  try {
    const result = spawnSync(
      process.execPath,
      ["-e", "process.exit(0)"],
      {
        stdio: "ignore",
        windowsHide: true,
        timeout: 2000,
      },
    );
    if (result?.error) {
      return {
        ok: false,
        code: String(result.error?.code || "").trim() || null,
        message: String(result.error?.message || "").trim() || "child_process_launch_failed",
      };
    }
    if (Number(result?.status) !== 0) {
      return {
        ok: false,
        code: String(result?.status ?? "").trim() || null,
        message: "child process launch exited non-zero",
      };
    }
    return { ok: true, code: null, message: "" };
  } catch (error) {
    return {
      ok: false,
      code: String(error?.code || "").trim() || null,
      message: String(error?.message || "").trim() || "child_process_launch_failed",
    };
  }
}

export function runPreflightChecks(options = {}) {
  const repoRoot = resolve(options.repoRoot || process.cwd());
  const errors = [];
  const warnings = [];
  const childProcess = checkChildProcessLaunch();

  const toolchain = checkToolchain();
  let ghAuth = { ok: false, method: "unknown" };
  for (const tool of toolchain.tools) {
    if (tool.ok) continue;
    const entry = {
      title: tool.blocked
        ? `Tool launch blocked: ${tool.label}`
        : `Missing tool: ${tool.label}`,
      message: tool.hint,
    };
    if (toolchain.requiredTools.has(tool.label)) {
      errors.push(entry);
    } else {
      warnings.push(entry);
    }
  }

  if (!childProcess.ok) {
    errors.push({
      title: "Node child-process launch is blocked",
      message:
        `Bosun cannot spawn subprocesses from Node in this runtime (${childProcess.code || "unknown"}: ${childProcess.message}). ` +
        "Workflow `action.run_command`, git worktree operations, GitHub CLI calls, and task execution handoffs will fail until host policy/environment is repaired.",
    });
  }

  const gitConfig = checkGitConfig(repoRoot);
  if (!gitConfig.ok) {
    errors.push({
      title: "Git identity not configured",
      message:
        'Set git user.name and user.email (git config --global user.name "Your Name"; git config --global user.email "you@example.com").',
    });
  }

  const interactiveEditor = checkInteractiveEditor(repoRoot);
  if (interactiveEditor) {
    warnings.push({
      title: "Interactive git editor detected",
      message:
        `${interactiveEditor.source} is set to "${interactiveEditor.editor}" which blocks automated commits. ` +
        `Run ${GIT_EDITOR_FIX_COMMAND} to switch this repo to a non-interactive editor.`,
    });
  }

  const worktree = checkWorktreeClean(repoRoot);
  if (!worktree.ok) {
    const sample = worktree.dirtyFiles.slice(0, 12).join(os.EOL);
    const suffix = worktree.dirtyFiles.length > 12 ? `${os.EOL}…` : "";
    // Downgrade to warning — orchestrator uses separate worktrees so main
    // worktree changes don't block operation.
    warnings.push({
      title: "Worktree has uncommitted changes",
      message:
        `Consider committing or stashing changes.${os.EOL}` +
        `${sample}${suffix}`,
    });
  }

  const runtimeSetup = checkWorktreeRuntimeSetup(repoRoot);
  if (!runtimeSetup.ok) {
    errors.push({
      title: "Worktree runtime setup is incomplete",
      message:
        runtimeSetup.issues.join(os.EOL) +
        (runtimeSetup.missingFiles.length > 0
          ? `${os.EOL}Run Bosun setup or bootstrap the repo so worktrees include the required hook/config files.`
          : ""),
    });
  }

  if (toolchain.ok) {
    ghAuth = checkGhAuth();
    if (!ghAuth.ok) {
      errors.push({
        title: "GitHub CLI not authenticated",
        message:
          "Run `gh auth login` (or set GH_TOKEN/GITHUB_TOKEN) then verify with `gh auth status`.",
      });
    }
  }

  const disk = checkDiskSpace(repoRoot);
  if (!disk.ok && disk.info) {
    errors.push({
      title: "Low disk space",
      message: `Free space on ${disk.info.mount} is ${formatBytes(disk.info.freeBytes)}; keep at least ${MIN_FREE_GB} GB free.`,
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    details: {
      childProcess,
      toolchain,
      gitConfig,
      worktree,
      ghAuth,
      disk,
      minFreeBytes: MIN_FREE_BYTES,
    },
  };
}

export function formatPreflightReport(result, options = {}) {
  const header = options.header || "bosun preflight";
  const lines = [];
  const childProcessBlocked = result.details?.childProcess?.ok === false;
  lines.push(`=== ${header} ===`);
  lines.push(
    `Status: ${result.ok ? "OK" : "FAILED"} (${result.errors.length} error(s), ${result.warnings.length} warning(s))`,
  );

  const toolchain = result.details?.toolchain;
  if (toolchain?.tools?.length) {
    lines.push("Toolchain:");
    for (const tool of toolchain.tools) {
      const status = childProcessBlocked && tool.label !== "node"
        ? "blocked"
        : (tool.ok ? tool.version : (tool.version || "missing"));
      lines.push(`  - ${tool.label}: ${status}`);
    }
  }

  const childProcess = result.details?.childProcess;
  if (childProcess) {
    lines.push(
      `Child process launch: ${childProcess.ok ? "ok" : `${childProcess.code || "blocked"}${childProcess.message ? ` (${childProcess.message})` : ""}`}`,
    );
  }

  const gitConfig = result.details?.gitConfig;
  if (gitConfig) {
    lines.push(`Git: ${gitConfig.ok ? "configured" : "missing identity"}`);
  }

  const ghAuth = result.details?.ghAuth;
  if (ghAuth) {
    lines.push(`GitHub auth: ${ghAuth.ok ? ghAuth.method : "missing"}`);
  }

  const disk = result.details?.disk;
  if (disk?.info) {
    lines.push(
      `Disk: ${formatBytes(disk.info.freeBytes)} free of ${formatBytes(disk.info.totalBytes)} (${disk.info.mount})`,
    );
  }

  const worktree = result.details?.worktree;
  if (worktree) {
    lines.push(
      `Worktree: ${worktree.ok ? "clean" : `${worktree.dirtyFiles.length} change(s)`}`,
    );
  }

  if (result.errors.length) {
    lines.push("Errors:");
    for (const err of result.errors) {
      lines.push(`  - ${err.title}`);
      if (err.message) {
        const messageLines = String(err.message).split(/\r?\n/);
        for (const msgLine of messageLines) {
          lines.push(`    ${msgLine}`);
        }
      }
    }
  }

  if (result.warnings.length) {
    lines.push("Warnings:");
    for (const warn of result.warnings) {
      const isPriorityWarning = /interactive git editor/i.test(
        `${warn.title}\n${warn.message || ""}`,
      );
      lines.push(
        `  - ${isPriorityWarning ? "[action recommended] " : ""}${warn.title}`,
      );
      if (warn.message) {
        const messageLines = String(warn.message).split(/\r?\n/);
        for (const msgLine of messageLines) {
          lines.push(`    ${msgLine}`);
        }
      }
    }
  }

  const interactiveEditorWarning = result.warnings.find((warn) =>
    /interactive git editor/i.test(`${warn.title}\n${warn.message || ""}`),
  );
  if (interactiveEditorWarning) {
    lines.push(`Suggested fix: ${GIT_EDITOR_FIX_COMMAND}`);
  }

  if (!result.ok && options.retryMs) {
    lines.push(`Next check in ${formatDuration(options.retryMs)}.`);
  }

  return lines.join(os.EOL);
}
