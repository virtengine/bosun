import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { scaffoldAgentHookFiles, normalizeHookTargets } from "../agent/hook-profiles.mjs";
import { CONFIG_FILES } from "../config/config-file-names.mjs";
import { ensureRepoConfigs } from "../config/repo-config.mjs";
import { sanitizeGitEnv } from "../git/git-safety.mjs";

const DEFAULT_HOOK_PROFILE_SETTINGS = Object.freeze({
  enabled: true,
  profile: "balanced",
  targets: Object.freeze(["codex", "claude", "copilot"]),
  overwriteExisting: false,
  commands: Object.freeze({}),
});
const BOSUN_LOCAL_OPS_BRANCH = "bosun/codex-self-improvement-loop-commits";
const BOSUN_LOCAL_OPS_WORKTREE_OVERLAY_PREFIXES = Object.freeze([
  "package.json",
  "vitest.config.mjs",
  "tui",
  "ui/tui",
  "ui/modules",
  "ui/tabs/agents.js",
  "site/ui/tabs/agents.js",
  "server/ui-server.mjs",
  "tools/vitest-runner.mjs",
  "lib/agent-configuration-guide.mjs",
  "telegram/telegram-bot.mjs",
  "telegram/executor-health-region-cache.mjs",
  "telegram/harness-api-client.mjs",
  "tests/fleet-tab-render.test.mjs",
  "tests/near-timeout-reporter.mjs",
  "tests/setup.mjs",
  "tests/shims/codex-sdk.mjs",
  "tests/ui-server-fallback-auth.test.mjs",
  "tests/ui-server-session-actions.test.mjs",
  "tests/ui-server-tui-events.test.mjs",
  "tests/ui-server-tunnel-hostname.test.mjs",
  "tests/tui-settings-screen.test.mjs",
  "tests/tui-status-header.test.mjs",
]);
const LOCAL_IMPORT_SPECIFIER_PATTERN = /(?:import|export)\s+[^"'`]*?\sfrom\s*["'`](\.[^"'`]+)["'`]|import\s*\(\s*["'`](\.[^"'`]+)["'`]\s*\)|import\s*["'`](\.[^"'`]+)["'`]|require\(\s*["'`](\.[^"'`]+)["'`]\s*\)/g;

function readRepoConfigDocument(repoRoot) {
  const resolvedRoot = resolve(repoRoot || process.cwd());
  for (const name of CONFIG_FILES) {
    const filePath = resolve(resolvedRoot, name);
    if (!existsSync(filePath)) continue;
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeHookCommands(rawCommands) {
  if (!rawCommands || typeof rawCommands !== "object" || Array.isArray(rawCommands)) {
    return Object.freeze({});
  }
  const normalized = {};
  for (const [eventName, value] of Object.entries(rawCommands)) {
    const key = String(eventName || "").trim();
    if (!key) continue;
    if (typeof value === "string") {
      const command = value.trim();
      if (command) normalized[key] = command;
      continue;
    }
    if (Array.isArray(value)) {
      const commands = value
        .map((entry) => String(entry || "").trim())
        .filter(Boolean);
      if (commands.length > 0) normalized[key] = commands;
    }
  }
  return Object.freeze(normalized);
}

function readCurrentGitBranch(repoRoot) {
  const result = spawnSync("git", ["branch", "--show-current"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
    env: sanitizeGitEnv(),
  });
  if (result.status !== 0) return "";
  return String(result.stdout || "").trim();
}

function getGitPath(worktreePath, gitPath) {
  const result = spawnSync("git", ["rev-parse", "--git-path", gitPath], {
    cwd: worktreePath,
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
    env: sanitizeGitEnv(),
  });
  if (result.status !== 0) return "";
  return String(result.stdout || "").trim();
}

function getGitConfigValue(worktreePath, key) {
  const result = spawnSync("git", ["config", "--get", key], {
    cwd: worktreePath,
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
    env: sanitizeGitEnv(),
  });
  if (result.status !== 0) return "";
  return String(result.stdout || "").trim();
}

function ensureGitHooksPath(worktreePath) {
  const current = getGitConfigValue(worktreePath, "core.hooksPath");
  if (current.replace(/\\/g, "/") === ".githooks") {
    return { changed: false, hooksPath: current || ".githooks" };
  }
  const result = spawnSync("git", ["config", "core.hooksPath", ".githooks"], {
    cwd: worktreePath,
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
    env: sanitizeGitEnv(),
  });
  return {
    changed: result.status === 0,
    hooksPath: result.status === 0 ? ".githooks" : current,
    error: result.status === 0 ? "" : String(result.stderr || result.stdout || "").trim(),
  };
}

function isTrackedGitPath(worktreePath, relativePath) {
  const result = spawnSync("git", ["ls-files", "--error-unmatch", "--", relativePath], {
    cwd: worktreePath,
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
    env: sanitizeGitEnv(),
  });
  return result.status === 0;
}

function markTrackedRuntimeSetupFilesSkipWorktree(worktreePath, expectedFiles = []) {
  const relativePaths = Array.from(
    new Set(
      (Array.isArray(expectedFiles) ? expectedFiles : [])
        .map((entry) => String(entry || "").trim())
        .filter(Boolean),
    ),
  );
  const skippedFiles = [];
  const untrackedFiles = [];
  const errors = [];

  for (const relativePath of relativePaths) {
    if (!isTrackedGitPath(worktreePath, relativePath)) {
      untrackedFiles.push(relativePath);
      continue;
    }
    const result = spawnSync("git", ["update-index", "--skip-worktree", "--", relativePath], {
      cwd: worktreePath,
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      env: sanitizeGitEnv(),
    });
    if (result.status === 0) {
      skippedFiles.push(relativePath);
      continue;
    }
    errors.push({
      relativePath,
      error: String(result.stderr || result.stdout || "").trim() || "git update-index --skip-worktree failed",
    });
  }

  return {
    skippedFiles,
    untrackedFiles,
    errors,
  };
}

function ignoreUntrackedRuntimeSetupFiles(worktreePath, expectedFiles = []) {
  const relativePaths = Array.from(
    new Set(
      (Array.isArray(expectedFiles) ? expectedFiles : [])
        .map((entry) => String(entry || "").trim().replace(/\\/g, "/"))
        .filter(Boolean),
    ),
  );
  const ignoredFiles = [];
  const alreadyIgnoredFiles = [];
  const errors = [];
  const untrackedFiles = relativePaths.filter((relativePath) => !isTrackedGitPath(worktreePath, relativePath));
  if (untrackedFiles.length === 0) {
    return { ignoredFiles, alreadyIgnoredFiles, errors };
  }
  const excludePath = getGitPath(worktreePath, "info/exclude");
  if (!excludePath) {
    return {
      ignoredFiles,
      alreadyIgnoredFiles,
      errors: [{ error: "git rev-parse --git-path info/exclude failed" }],
    };
  }
  const resolvedExcludePath = resolve(worktreePath, excludePath);
  const existingLines = existsSync(resolvedExcludePath)
    ? readFileSync(resolvedExcludePath, "utf8").split(/\r?\n/)
    : [];
  const existing = new Set(
    existingLines
      .map((line) => String(line || "").trim())
      .filter(Boolean),
  );
  const additions = [];
  for (const relativePath of untrackedFiles) {
    if (existing.has(relativePath)) {
      alreadyIgnoredFiles.push(relativePath);
      continue;
    }
    additions.push(relativePath);
    ignoredFiles.push(relativePath);
  }
  if (additions.length === 0) {
    return { ignoredFiles, alreadyIgnoredFiles, errors };
  }
  const nextContent = [
    ...existingLines.filter((line) => line.length > 0),
    ...additions,
    "",
  ].join("\n");
  try {
    mkdirSync(dirname(resolvedExcludePath), { recursive: true });
    writeFileSync(resolvedExcludePath, nextContent, "utf8");
  } catch (error) {
    return {
      ignoredFiles: [],
      alreadyIgnoredFiles,
      errors: [{ error: error?.message || "failed to update git info exclude" }],
    };
  }
  return { ignoredFiles, alreadyIgnoredFiles, errors };
}

export function resolveWorktreeHookProfileSettings(repoRoot) {
  const document = readRepoConfigDocument(repoRoot);
  const raw = document?.hookProfiles && typeof document.hookProfiles === "object"
    ? document.hookProfiles
    : {};
  const targets = normalizeHookTargets(raw.targets || DEFAULT_HOOK_PROFILE_SETTINGS.targets);
  return Object.freeze({
    enabled: raw.enabled !== false,
    profile: String(raw.profile || DEFAULT_HOOK_PROFILE_SETTINGS.profile).trim() || DEFAULT_HOOK_PROFILE_SETTINGS.profile,
    targets: Object.freeze(targets),
    overwriteExisting: raw.overwriteExisting === true,
    commands: normalizeHookCommands(raw.commands),
  });
}

function buildExpectedLocalOpsOverlayFiles(repoRoot) {
  const currentBranch = readCurrentGitBranch(repoRoot).toLowerCase();
  if (currentBranch !== BOSUN_LOCAL_OPS_BRANCH) {
    return [];
  }
  const discoveredFiles = new Set();
  const visitedDirectories = new Set();
  const visitedFiles = new Set();
  for (const relativePrefix of BOSUN_LOCAL_OPS_WORKTREE_OVERLAY_PREFIXES) {
    const pending = [String(relativePrefix || "").trim().replace(/\\/g, "/")];
    while (pending.length > 0) {
      const currentRelativePath = pending.pop();
      if (!currentRelativePath) continue;
      const absolutePath = resolve(repoRoot, currentRelativePath);
      if (!existsSync(absolutePath)) continue;
      let absoluteStat = null;
      try {
        absoluteStat = statSync(absolutePath);
      } catch {
        continue;
      }
      if (absoluteStat.isFile()) {
        if (visitedFiles.has(currentRelativePath)) {
          continue;
        }
        visitedFiles.add(currentRelativePath);
        discoveredFiles.add(currentRelativePath);
        for (const dependencyPath of resolveLocalImportOverlayFiles(repoRoot, currentRelativePath)) {
          if (!visitedFiles.has(dependencyPath)) {
            pending.push(dependencyPath);
          }
        }
        continue;
      }
      if (!absoluteStat.isDirectory()) {
        continue;
      }
      if (visitedDirectories.has(currentRelativePath)) {
        continue;
      }
      visitedDirectories.add(currentRelativePath);
      for (const entry of readdirSync(absolutePath, { withFileTypes: true })) {
        const entryRelativePath = `${currentRelativePath}/${entry.name}`.replace(/\\/g, "/");
        if (entry.isDirectory()) {
          pending.push(entryRelativePath);
          continue;
        }
        if (entry.isFile()) {
          discoveredFiles.add(entryRelativePath);
        }
      }
    }
  }
  return Array.from(discoveredFiles).sort();
}

function resolveLocalImportOverlayFiles(repoRoot, relativeFilePath) {
  const absolutePath = resolve(repoRoot, relativeFilePath);
  let content = "";
  try {
    content = readFileSync(absolutePath, "utf8");
  } catch {
    return [];
  }
  const dependencies = new Set();
  for (const match of content.matchAll(LOCAL_IMPORT_SPECIFIER_PATTERN)) {
    const specifier = match[1] || match[2] || match[3] || match[4] || "";
    if (!specifier.startsWith(".")) continue;
    const resolvedDependency = resolveRelativeOverlayImport(repoRoot, relativeFilePath, specifier);
    if (resolvedDependency) {
      dependencies.add(resolvedDependency);
    }
  }
  return Array.from(dependencies);
}

function resolveRelativeOverlayImport(repoRoot, fromRelativePath, specifier) {
  const normalizedBaseDirectory = dirname(fromRelativePath).replace(/\\/g, "/");
  const normalizedCandidate = resolve(repoRoot, normalizedBaseDirectory, specifier);
  const extensionCandidates = [
    "",
    ".mjs",
    ".js",
    ".cjs",
    ".json",
    "/index.mjs",
    "/index.js",
    "/index.cjs",
    "/index.json",
  ];
  for (const suffix of extensionCandidates) {
    const absoluteCandidate = `${normalizedCandidate}${suffix}`;
    if (!existsSync(absoluteCandidate)) continue;
    try {
      if (!statSync(absoluteCandidate).isFile()) continue;
    } catch {
      continue;
    }
    return absoluteCandidate.slice(resolve(repoRoot).length + 1).replace(/\\/g, "/");
  }
  return "";
}

function buildExpectedSetupFiles(repoRoot, hookSettings) {
  const expectedFiles = [
    ".githooks/pre-commit",
    ".githooks/pre-push",
    ".codex/config.toml",
    ...buildExpectedLocalOpsOverlayFiles(repoRoot),
  ];

  if (!hookSettings?.enabled) {
    return expectedFiles;
  }

  const targets = new Set(hookSettings.targets || []);
  if (targets.has("codex")) expectedFiles.push(".codex/hooks.json");
  if (targets.has("claude")) expectedFiles.push(".claude/settings.local.json");
  if (targets.has("copilot")) expectedFiles.push(".github/hooks/bosun.hooks.json");
  if (targets.has("gemini")) expectedFiles.push(".gemini/settings.json");
  if (targets.has("opencode")) expectedFiles.push(".opencode/hooks.json");
  return expectedFiles;
}

function normalizeRuntimeSetupFileContent(relativePath, content) {
  const text = String(content ?? "");
  const normalizedPath = String(relativePath || "").replace(/\\/g, "/");
  if (!normalizedPath.startsWith(".githooks/")) return Buffer.from(text, "utf8");
  return Buffer.from(text.replace(/\r\n?/g, "\n"), "utf8");
}

function readExpectedRuntimeSetupFileContent(filePath, relativePath) {
  return normalizeRuntimeSetupFileContent(relativePath, readFileSync(filePath, "utf8"));
}

export function syncExpectedWorktreeRuntimeFiles(repoRoot, worktreePath, expectedFiles = []) {
  const resolvedRepoRoot = resolve(repoRoot || process.cwd());
  const resolvedWorktreePath = resolve(worktreePath || resolvedRepoRoot);
  const relativePaths = Array.from(
    new Set(
      (Array.isArray(expectedFiles) ? expectedFiles : [])
        .map((entry) => String(entry || "").trim())
        .filter(Boolean),
    ),
  );
  const syncedFiles = [];
  const unchangedFiles = [];
  const missingSourceFiles = [];

  for (const relativePath of relativePaths) {
    const sourcePath = resolve(resolvedRepoRoot, relativePath);
    if (!existsSync(sourcePath)) {
      missingSourceFiles.push(relativePath);
      continue;
    }
    const targetPath = resolve(resolvedWorktreePath, relativePath);
    const sourceContent = readExpectedRuntimeSetupFileContent(sourcePath, relativePath);
    if (existsSync(targetPath)) {
      const targetContent = readFileSync(targetPath);
      if (Buffer.compare(sourceContent, targetContent) === 0) {
        unchangedFiles.push(relativePath);
        continue;
      }
    }
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, sourceContent);
    syncedFiles.push(relativePath);
  }

  return {
    syncedFiles,
    unchangedFiles,
    missingSourceFiles,
  };
}

export function ensureWorktreeRuntimeSetup(repoRoot, worktreePath) {
  const resolvedRepoRoot = resolve(repoRoot || process.cwd());
  const resolvedWorktreePath = resolve(worktreePath || resolvedRepoRoot);
  const hookSettings = resolveWorktreeHookProfileSettings(resolvedRepoRoot);
  const expectedFiles = buildExpectedSetupFiles(resolvedRepoRoot, hookSettings);
  const repoConfigResult = ensureRepoConfigs(resolvedWorktreePath);
  const gitHooks = ensureGitHooksPath(resolvedWorktreePath);
  const hookResult = scaffoldAgentHookFiles(resolvedWorktreePath, {
    enabled: hookSettings.enabled,
    profile: hookSettings.profile,
    targets: hookSettings.targets,
    overwriteExisting: hookSettings.overwriteExisting,
    commands: hookSettings.commands,
  });
  const runtimeSync = syncExpectedWorktreeRuntimeFiles(
    resolvedRepoRoot,
    resolvedWorktreePath,
    expectedFiles,
  );
  const gitIndex = markTrackedRuntimeSetupFilesSkipWorktree(
    resolvedWorktreePath,
    expectedFiles,
  );
  const gitIgnore = ignoreUntrackedRuntimeSetupFiles(
    resolvedWorktreePath,
    expectedFiles,
  );

  return {
    repoConfigResult,
    gitHooks,
    hookResult,
    hookSettings,
    runtimeSync,
    gitIndex,
    gitIgnore,
  };
}

export function inspectWorktreeRuntimeSetup(repoRoot, worktreePath = repoRoot) {
  const resolvedRepoRoot = resolve(repoRoot || process.cwd());
  const resolvedWorktreePath = resolve(worktreePath || resolvedRepoRoot);
  const hookSettings = resolveWorktreeHookProfileSettings(resolvedRepoRoot);
  const hooksPath = getGitConfigValue(resolvedWorktreePath, "core.hooksPath");
  const expectedFiles = buildExpectedSetupFiles(resolvedRepoRoot, hookSettings);
  const missingFiles = expectedFiles.filter((relativePath) =>
    !existsSync(resolve(resolvedWorktreePath, relativePath)),
  );
  const staleFiles = expectedFiles.filter((relativePath) => {
    const sourcePath = resolve(resolvedRepoRoot, relativePath);
    const targetPath = resolve(resolvedWorktreePath, relativePath);
    if (!existsSync(sourcePath) || !existsSync(targetPath)) {
      return false;
    }
    return Buffer.compare(
      readExpectedRuntimeSetupFileContent(sourcePath, relativePath),
      readFileSync(targetPath),
    ) !== 0;
  });
  const issues = [];

  if (!hooksPath) {
    issues.push("git core.hooksPath is not configured");
  } else {
    const normalized = hooksPath.replace(/\\/g, "/");
    if (normalized !== ".githooks" && !normalized.endsWith("/.githooks")) {
      issues.push(`git core.hooksPath points to ${hooksPath} instead of .githooks`);
    }
  }

  if (missingFiles.length > 0) {
    issues.push(`missing worktree setup files: ${missingFiles.join(", ")}`);
  }
  if (staleFiles.length > 0) {
    issues.push(`stale worktree setup files: ${staleFiles.join(", ")}`);
  }

  return {
    ok: issues.length === 0,
    issues,
    hooksPath,
    expectedFiles,
    missingFiles,
    staleFiles,
    hookSettings,
  };
}
