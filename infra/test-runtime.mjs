import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const TEST_RUNTIME_ENV_KEYS = [
  "VITEST",
  "VITEST_POOL_ID",
  "VITEST_WORKER_ID",
  "JEST_WORKER_ID",
];

const TEST_GIT_IDENTITY_KEYS = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "VE_GIT_AUTHOR_NAME",
  "VE_GIT_AUTHOR_EMAIL",
];

let cachedSandboxContext = null;

function getRuntimeProcess() {
  return globalThis.process;
}

function getRuntimeEnv() {
  return getRuntimeProcess()?.env || {};
}

function getRuntimePlatform() {
  return getRuntimeProcess()?.platform || "";
}

function getRuntimeArgv() {
  const argv = getRuntimeProcess()?.argv;
  return Array.isArray(argv) ? argv : [];
}

function getRuntimePid() {
  return getRuntimeProcess()?.pid || 0;
}

function sanitizeToken(value, fallback) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function pathsEqual(left, right) {
  const a = resolve(String(left || ""));
  const b = resolve(String(right || ""));
  if (getRuntimePlatform() === "win32") {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

function getWorkerToken() {
  const env = getRuntimeEnv();
  return sanitizeToken(
    env.VITEST_POOL_ID ||
      env.VITEST_WORKER_ID ||
      env.JEST_WORKER_ID ||
      getRuntimePid(),
    "default",
  );
}

function buildDefaultSandboxRoot() {
  return resolve(
    tmpdir(),
    "bosun-test-sandbox",
    getWorkerToken(),
  );
}

function buildSandboxContext(rootDir) {
  const sandboxRoot = resolve(rootDir);
  const configDir = resolve(sandboxRoot, "bosun-home");
  const homeDir = resolve(sandboxRoot, "home");
  const appDataDir = resolve(homeDir, "AppData", "Roaming");
  const localAppDataDir = resolve(homeDir, "AppData", "Local");
  const xdgConfigDir = resolve(homeDir, ".config");
  const bosunDataDir = resolve(configDir, ".bosun");
  const workflowDir = resolve(bosunDataDir, "workflows");
  const runsDir = resolve(bosunDataDir, "workflow-runs");
  const cacheDir = resolve(bosunDataDir, ".cache");
  const stateLedgerPath = resolve(cacheDir, "state-ledger.sqlite");
  const gitGlobalConfigPath = resolve(homeDir, ".gitconfig");

  return {
    sandboxRoot,
    configDir,
    homeDir,
    appDataDir,
    localAppDataDir,
    xdgConfigDir,
    workflowDir,
    runsDir,
    cacheDir,
    stateLedgerPath,
    gitGlobalConfigPath,
  };
}

function ensureDir(path) {
  fs.mkdirSync(path, { recursive: true });
}

function ensureSandboxFiles(context) {
  ensureDir(context.sandboxRoot);
  ensureDir(context.configDir);
  ensureDir(context.homeDir);
  ensureDir(context.appDataDir);
  ensureDir(context.localAppDataDir);
  ensureDir(context.xdgConfigDir);
  ensureDir(context.workflowDir);
  ensureDir(context.runsDir);
  ensureDir(context.cacheDir);
  if (!fs.existsSync(context.gitGlobalConfigPath)) {
    ensureDir(dirname(context.gitGlobalConfigPath));
    fs.writeFileSync(context.gitGlobalConfigPath, "", "utf8");
  }
}

function setEnvValue(key, value, force) {
  const runtimeProcess = getRuntimeProcess();
  const env = runtimeProcess?.env;
  if (!env) return;
  if (!force && env[key]) return;
  env[key] = value;
}

export function isTestRuntime() {
  const env = getRuntimeEnv();
  if (env.BOSUN_TEST_SANDBOX === "1") return true;
  for (const key of TEST_RUNTIME_ENV_KEYS) {
    if (env[key]) return true;
  }
  if (env.NODE_ENV === "test") return true;
  const argv = getRuntimeArgv().join(" ").toLowerCase();
  return argv.includes("vitest") || argv.includes("--test");
}

function isPathInside(parentPath, childPath) {
  const parent = resolve(String(parentPath || ""));
  const child = resolve(String(childPath || ""));
  const rel = relative(parent, child);
  if (!rel) return true;
  if (isAbsolute(rel)) return false;
  return !rel.startsWith("..") && rel !== "..";
}

export function ensureTestRuntimeSandbox(options = {}) {
  if (!isTestRuntime()) return null;
  const force = options.force === true;
  const env = getRuntimeEnv();
  const requestedRoot =
    options.rootDir ||
    env.BOSUN_TEST_SANDBOX_ROOT ||
    buildDefaultSandboxRoot();
  const context =
    cachedSandboxContext && pathsEqual(cachedSandboxContext.sandboxRoot, requestedRoot)
      ? cachedSandboxContext
      : buildSandboxContext(requestedRoot);
  cachedSandboxContext = context;

  ensureSandboxFiles(context);

  setEnvValue("BOSUN_TEST_SANDBOX", "1", force);
  setEnvValue("BOSUN_TEST_SANDBOX_ROOT", context.sandboxRoot, force);
  setEnvValue("BOSUN_TEST_CACHE_DIR", context.cacheDir, force);
  setEnvValue("BOSUN_STATE_LEDGER_PATH", context.stateLedgerPath, force);
  setEnvValue("GIT_CONFIG_GLOBAL", context.gitGlobalConfigPath, force);
  setEnvValue("GIT_CONFIG_NOSYSTEM", "1", force);

  if (force) {
    const runtimeProcess = getRuntimeProcess();
    const runtimeEnv = runtimeProcess?.env;
    if (!runtimeEnv) return context;
    for (const key of TEST_GIT_IDENTITY_KEYS) {
      delete runtimeEnv[key];
    }
  }

  return context;
}

export function getTestRuntimeSandbox() {
  if (cachedSandboxContext) return cachedSandboxContext;
  return ensureTestRuntimeSandbox();
}

export function isSafeTestFilesystemPath(candidatePath) {
  if (!candidatePath) return false;
  const sandbox = getTestRuntimeSandbox();
  const safeRoots = [tmpdir(), sandbox?.sandboxRoot].filter(Boolean);
  return safeRoots.some((root) => isPathInside(root, candidatePath));
}

function getGitSubcommand(args = []) {
  const values = Array.isArray(args) ? [...args] : [];
  for (let i = 0; i < values.length; i++) {
    const token = String(values[i] || "").trim();
    if (!token) continue;
    if (token === "-C" || token === "-c" || token === "--git-dir" || token === "--work-tree") {
      i += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    return {
      command: token,
      rest: values.slice(i + 1).map((value) => String(value || "").trim()),
    };
  }
  return { command: "", rest: [] };
}

function isDestructiveGitArgs(args = []) {
  const { command, rest } = getGitSubcommand(args);
  switch (command) {
    case "add":
    case "am":
    case "apply":
      return true;
    case "branch":
      if (rest.some((value) => value === "--show-current" || value === "--list" || value === "-l")) {
        return false;
      }
      return true;
    case "checkout":
    case "cherry-pick":
    case "clean":
    case "commit":
    case "fetch":
    case "merge":
    case "pull":
    case "push":
    case "rebase":
    case "reset":
    case "restore":
    case "stash":
    case "switch":
    case "tag":
      return true;
    case "config":
      return !rest.includes("--get");
    case "remote":
      return rest.some((value) => ["add", "remove", "rm", "rename", "set-head", "set-branches", "set-url"].includes(value));
    case "worktree":
      return rest.some((value) => ["add", "move", "lock", "remove", "prune", "repair", "unlock"].includes(value));
    default:
      return false;
  }
}

const DESTRUCTIVE_GIT_SHELL_RE =
  /(^|[;&|]\s*)git\s+(?:-[^\s]+\s+)*(?:add|am|apply|branch(?!\s+(?:--show-current|--list|-l)\b)|checkout|cherry-pick|clean|commit|config(?!\s+--get\b)|fetch|merge|pull|push|rebase|reset|remote\s+(?:add|remove|rm|rename|set-head|set-branches|set-url)\b|restore|stash|switch|tag|worktree\s+(?:add|move|lock|remove|prune|repair|unlock)\b)/i;

function isDestructiveGitShell(command) {
  return DESTRUCTIVE_GIT_SHELL_RE.test(String(command || ""));
}

function describeGitInvocation(command, args = []) {
  if (Array.isArray(args) && args.length > 0) {
    return [String(command || ""), ...args.map((value) => String(value || ""))]
      .filter(Boolean)
      .join(" ");
  }
  return String(command || "").trim();
}

export function assertSafeGitMutationInTests({ command = "", args = [], cwd = process.cwd() } = {}) {
  if (!isTestRuntime()) return;
  const isGitBinary = /(?:^|[/\\])git(?:\.exe)?$/i.test(String(command || "").trim());
  const destructive =
    Array.isArray(args) && args.length > 0
      ? isGitBinary && isDestructiveGitArgs(args)
      : isDestructiveGitShell(command);
  if (!destructive) return;
  const resolvedCwd = resolve(String(cwd || process.cwd()));
  if (isSafeTestFilesystemPath(resolvedCwd)) return;
  throw new Error(
    `[test-runtime] blocked destructive git command outside sandbox/temp path: ${describeGitInvocation(command, args)} (cwd: ${resolvedCwd})`,
  );
}

export function resolvePathForTestRuntime(candidatePath, persistentPath, sandboxPath) {
  const resolvedCandidate = resolve(String(candidatePath || ""));
  if (!isTestRuntime()) return resolvedCandidate;
  if (!persistentPath || !sandboxPath) return resolvedCandidate;
  const resolvedPersistent = resolve(String(persistentPath));
  if (!pathsEqual(resolvedCandidate, resolvedPersistent)) return resolvedCandidate;
  ensureTestRuntimeSandbox();
  return resolve(String(sandboxPath));
}
