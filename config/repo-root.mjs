import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, isAbsolute, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILES } from "./config-file-names.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const REPO_LOCAL_BOSUN_MARKERS = [
  ".env",
  "bosun.config.json",
  ".bosun.json",
  "bosun.json",
  "workspaces",
  "logs",
  "workflow-runs",
  "library.json",
];

function getConfigSearchDirs() {
  const dirs = new Set();
  if (process.env.BOSUN_DIR) dirs.add(resolve(process.env.BOSUN_DIR));
  if (process.env.APPDATA) dirs.add(resolve(process.env.APPDATA, "bosun"));
  if (process.env.LOCALAPPDATA) dirs.add(resolve(process.env.LOCALAPPDATA, "bosun"));
  if (process.env.USERPROFILE) dirs.add(resolve(process.env.USERPROFILE, "bosun"));
  if (process.env.HOME) dirs.add(resolve(process.env.HOME, "bosun"));
  return [...dirs];
}

function normalizeConfigRepoPath(repoPath, configDir) {
  if (!repoPath) return null;
  return resolve(isAbsolute(repoPath) ? repoPath : resolve(configDir, repoPath));
}

export function resolveRepoLocalBosunDir(repoRoot, options = {}) {
  if (!repoRoot) return null;
  const root = resolve(repoRoot);
  const localDir = resolve(root, ".bosun");
  if (!existsSync(localDir)) return null;

  const markers = Array.isArray(options.markers) && options.markers.length > 0
    ? options.markers
    : REPO_LOCAL_BOSUN_MARKERS;
  const requireMarkers = options.requireMarkers !== false;

  if (!requireMarkers) return localDir;
  return markers.some((name) => existsSync(resolve(localDir, name)))
    ? localDir
    : null;
}

function pathIdentity(pathValue) {
  const resolved = resolve(String(pathValue || ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isCheckoutLocalBosunDir(configDir) {
  return basename(resolve(String(configDir || ""))).toLowerCase() === ".bosun";
}

export function shouldPreferRepoLocalBosunDir(configDir, repoRoot, options = {}) {
  if (!configDir || !repoRoot) return false;
  const repoLocalConfigDir = resolveRepoLocalBosunDir(repoRoot, options);
  if (!repoLocalConfigDir) return false;

  const resolvedConfigDir = resolve(configDir);
  if (pathIdentity(resolvedConfigDir) === pathIdentity(repoLocalConfigDir)) return false;
  if (!existsSync(resolvedConfigDir)) return true;
  if (!isCheckoutLocalBosunDir(resolvedConfigDir)) return false;

  const configParent = dirname(resolvedConfigDir);
  if (pathIdentity(configParent) === pathIdentity(repoRoot)) return false;
  return existsSync(resolve(configParent, ".git")) || isBosunModuleRoot(configParent);
}

export function resolveTrustedBosunConfigDir(configDir, repoRoot, options = {}) {
  if (!configDir) return null;
  if (shouldPreferRepoLocalBosunDir(configDir, repoRoot, options)) {
    return resolveRepoLocalBosunDir(repoRoot, options);
  }
  return resolve(configDir);
}

/**
 * Returns true if the given directory is the root of the bosun npm module.
 * @param {string} dirPath
 * @returns {boolean}
 */
export function isBosunModuleRoot(dirPath) {
  if (!dirPath) return false;
  const pkgPath = resolve(dirPath, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return pkg.name === "bosun" || pkg.name === "@virtengine/bosun";
  } catch {
    return false;
  }
}

/**
 * Detect the bosun module root by walking up from __dirname.
 * Returns the module root path, or __dirname as fallback.
 * @returns {string}
 */
export function detectBosunModuleRoot() {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (isBosunModuleRoot(dir)) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return __dirname;
}

/**
 * Resolve the repo root for bosun.
 *
 * Priority:
 *  1. Explicit REPO_ROOT env var.
 *  2. git rev-parse --show-toplevel (relative to cwd).
 *  3. git rev-parse --show-toplevel from the bosun package directory.
 *  4. Workspace config repo path (bosun.config.json).
 *  5. process.cwd().
 */
export function resolveRepoRoot(options = {}) {
  const envRoot = process.env.REPO_ROOT;
  if (envRoot) return resolve(envRoot);

  const cwd = options.cwd || process.cwd();

  // Check bosun config for workspace repos FIRST — works regardless of cwd
  const configDirs = [...getConfigSearchDirs(), __dirname];
  if (process.env.BOSUN_HOME) configDirs.unshift(resolve(process.env.BOSUN_HOME));
  let fallbackRepo = null;
  for (const cfgName of CONFIG_FILES) {
    for (const dir of configDirs) {
      const cfgPath = resolve(dir, cfgName);
      if (!existsSync(cfgPath)) continue;
      try {
        const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
        // Check workspace repos (higher priority — explicit workspace configuration)
        const workspaces = Array.isArray(cfg.workspaces) ? cfg.workspaces : [];
        for (const ws of workspaces) {
          const wsRepos = ws?.repos || ws?.repositories || [];
          if (!Array.isArray(wsRepos)) continue;
          const wsId = ws?.id || "default";
          for (const repo of wsRepos) {
            const name = typeof repo === "string" ? repo.split("/").pop() : (repo?.name || repo?.id || "");
            if (!name) continue;
            const repoPath = resolve(dir, "workspaces", wsId, name);
            if (existsSync(resolve(repoPath, ".git"))) return repoPath;
            if (existsSync(repoPath)) fallbackRepo ??= repoPath;
          }
        }
        // Check flat repositories
        const repos = cfg.repositories || cfg.repos || [];
        if (Array.isArray(repos) && repos.length > 0) {
          const primary = repos.find((r) => r.primary) || repos[0];
          const repoPath = typeof primary === "string" ? primary : (primary?.path || primary?.repoRoot);
          const resolved = normalizeConfigRepoPath(repoPath, dir);
          if (!resolved || !existsSync(resolved)) continue;
          if (existsSync(resolve(resolved, ".git"))) return resolved;
          fallbackRepo ??= resolved;
        }
      } catch {
        /* invalid config */
      }
    }
  }
  if (fallbackRepo) return fallbackRepo;

  // Try git from cwd
  try {
    const gitRoot = execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (gitRoot) return gitRoot;
  } catch {
    // ignore - fall back
  }

  // Try git from the bosun package directory (may be inside a repo)
  try {
    const gitRoot = execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      cwd: __dirname,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (gitRoot) return gitRoot;
  } catch {
    // bosun installed standalone
  }

  return resolve(cwd);
}

/**
 * Resolve the repo root for agent execution (workspace-aware).
 *
 * Priority:
 *  1. Explicit BOSUN_AGENT_REPO_ROOT env var.
 *  2. Workspace primary repo path (if .git exists).
 *  3. REPO_ROOT env var fallback.
 *  4. git rev-parse detection.
 *
 * This function is specifically for determining where agents execute,
 * keeping the developer's working copy untouched.
 */
export function resolveAgentRepoRoot(options = {}) {
  // 1. Explicit agent repo root override
  const agentRoot = process.env.BOSUN_AGENT_REPO_ROOT;
  if (agentRoot) {
    const resolved = resolve(agentRoot);
    if (existsSync(resolved)) return resolved;
  }

  // 2. Check workspace primary repo (with .git validation)
  const workspaceRepo = _resolveWorkspacePrimaryRepo();
  if (workspaceRepo) return workspaceRepo;

  // 3. Fall back to standard resolution
  return resolveRepoRoot(options);
}

/**
 * Resolve the workspace primary repo path by reading bosun config.
 * Returns the path only if the directory has a .git (valid clone).
 * @returns {string|null}
 */
function _resolveWorkspacePrimaryRepo() {
  const configDirs = [...getConfigSearchDirs(), __dirname];
  for (const cfgName of CONFIG_FILES) {
    for (const dir of configDirs) {
      const cfgPath = resolve(dir, cfgName);
      if (!existsSync(cfgPath)) continue;
      try {
        const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
        const workspaces = cfg.workspaces;
        if (!Array.isArray(workspaces) || workspaces.length === 0) continue;

        const activeWsId = process.env.BOSUN_WORKSPACE || cfg.activeWorkspace || cfg.defaultWorkspace || "";
        const ws = (activeWsId
          ? workspaces.find((w) => w.id === activeWsId)
          : null) || workspaces[0];
        if (!ws?.repos?.length) continue;

        const wsPath = ws.path
          ? resolve(isAbsolute(ws.path) ? ws.path : resolve(dir, ws.path))
          : resolve(dir, "workspaces", ws.id);
        const primaryRepo = ws.repos.find((r) => r.primary) ||
          (ws.activeRepo ? ws.repos.find((r) => r.name === ws.activeRepo) : null) ||
          ws.repos[0];
        if (!primaryRepo?.name) continue;

        const repoPath = resolve(wsPath, primaryRepo.name);
        const gitPath = resolve(repoPath, ".git");
        if (existsSync(gitPath)) return repoPath;
      } catch { /* skip invalid config */ }
    }
  }
  return null;
}
