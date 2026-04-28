import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

function buildExpectedSetupFiles(hookSettings) {
  const expectedFiles = [
    ".githooks/pre-commit",
    ".githooks/pre-push",
    ".codex/config.toml",
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
  const expectedFiles = buildExpectedSetupFiles(hookSettings);
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

  return {
    repoConfigResult,
    gitHooks,
    hookResult,
    hookSettings,
    runtimeSync,
  };
}

export function inspectWorktreeRuntimeSetup(repoRoot, worktreePath = repoRoot) {
  const resolvedRepoRoot = resolve(repoRoot || process.cwd());
  const resolvedWorktreePath = resolve(worktreePath || resolvedRepoRoot);
  const hookSettings = resolveWorktreeHookProfileSettings(resolvedRepoRoot);
  const hooksPath = getGitConfigValue(resolvedWorktreePath, "core.hooksPath");
  const expectedFiles = buildExpectedSetupFiles(hookSettings);
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
