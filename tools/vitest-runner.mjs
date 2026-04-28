import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const requireModule = createRequire(import.meta.url);

function getParentDir(dir) {
  const parent = dirname(dir);
  return parent === dir ? null : parent;
}

export function findVitestEntry({ startDir = process.cwd() } = {}) {
  let currentDir = resolve(startDir);
  while (currentDir) {
    const vitestEntry = resolve(currentDir, "node_modules", "vitest", "vitest.mjs");
    if (existsSync(vitestEntry)) {
      return vitestEntry;
    }
    currentDir = getParentDir(currentDir);
  }
  return null;
}

export function findPackageRoot({ startDir = process.cwd() } = {}) {
  let currentDir = resolve(startDir);
  while (currentDir) {
    if (existsSync(resolve(currentDir, "package.json"))) {
      return currentDir;
    }
    currentDir = getParentDir(currentDir);
  }
  return null;
}

function resolveNpmInvocation(
  { platform = process.platform, comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe" } = {},
) {
  if (platform === "win32") {
    return {
      command: comspec,
      argsPrefix: ["/d", "/s", "/c", "npm"],
    };
  }
  return {
    command: "npm",
    argsPrefix: [],
  };
}

export function findVitestPackageSpec(
  { startDir = process.cwd(), packageRoot = findPackageRoot({ startDir }) } = {},
) {
  if (!packageRoot) return null;
  const packageJsonPath = resolve(packageRoot, "package.json");
  if (!existsSync(packageJsonPath)) return null;
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  return packageJson.devDependencies?.vitest || packageJson.dependencies?.vitest || null;
}

export function ensureVitestEntry(
  {
    startDir = process.cwd(),
    packageRoot = findPackageRoot({ startDir }),
    spawn = spawnSync,
    log = console.log,
    installStdio = "inherit",
  } = {},
) {
  const existingVitestEntry = findVitestEntry({ startDir });
  if (existingVitestEntry) return existingVitestEntry;
  if (!packageRoot) return null;
  const vitestPackageSpec = findVitestPackageSpec({ startDir, packageRoot });
  if (!vitestPackageSpec) return null;

  log(
    `[vitest] missing local vitest under ${packageRoot}; hydrating vitest@${vitestPackageSpec} without mutating package manifests`,
  );

  const npmInvocation = resolveNpmInvocation();
  const result = spawn(
    npmInvocation.command,
    [
      ...npmInvocation.argsPrefix,
      "install",
      "--no-save",
      "--package-lock=false",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      `vitest@${vitestPackageSpec}`,
    ],
    {
      cwd: packageRoot,
      env: process.env,
      stdio: installStdio,
    },
  );

  if (typeof result?.status === "number" && result.status !== 0) {
    throw new Error(
      `[vitest] failed to hydrate vitest@${vitestPackageSpec} in ${packageRoot} (exit ${result.status})`,
    );
  }
  if (result?.error) {
    throw result.error;
  }

  const hydratedVitestEntry = findVitestEntry({ startDir });
  if (!hydratedVitestEntry) {
    throw new Error(
      `[vitest] hydrated vitest@${vitestPackageSpec} in ${packageRoot}, but it is still unavailable from ${startDir}`,
    );
  }
  return hydratedVitestEntry;
}

function resolveWindowsEsbuildBinary({ startDir = process.cwd() } = {}) {
  if (process.platform !== "win32") return null;
  const packageRoot = findPackageRoot({ startDir });
  if (!packageRoot) return null;
  const candidates = [
    resolve(packageRoot, "node_modules", "@esbuild", "win32-x64", "esbuild.exe"),
    resolve(packageRoot, "node_modules", "@esbuild", "win32-ia32", "esbuild.exe"),
    resolve(packageRoot, "node_modules", "@esbuild", "win32-arm64", "esbuild.exe"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function resolveCliPathArg(value, { startDir, packageRoot }) {
  if (!value || isAbsolute(value)) {
    return value;
  }
  const startPath = resolve(startDir, value);
  if (existsSync(startPath)) {
    return startPath;
  }
  if (!packageRoot) {
    return value;
  }
  const packagePath = resolve(packageRoot, value);
  if (existsSync(packagePath)) {
    return packagePath;
  }
  return value;
}

function toPosixPath(value) {
  return String(value || "").replaceAll("\\", "/");
}

function hasGlobMagic(value) {
  return /[*?[\]{}]/.test(String(value || ""));
}

function looksLikePathArg(value) {
  const candidate = String(value || "");
  return (
    hasGlobMagic(candidate)
    || candidate.includes("/")
    || candidate.includes("\\")
    || candidate.startsWith(".")
    || /\.(?:[cm]?js|[cm]?ts|jsx|tsx)$/i.test(candidate)
  );
}

function escapeRegex(value) {
  return String(value || "").replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globPatternToRegex(pattern) {
  const normalized = toPosixPath(pattern);
  let regex = "";

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*") {
      if (next === "*") {
        regex += ".*";
        index += 1;
      } else {
        regex += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      regex += "[^/]";
      continue;
    }
    regex += escapeRegex(char);
  }

  return new RegExp(`^${regex}$`);
}

function walkFiles(rootDir, out = []) {
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const entryPath = resolve(rootDir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(entryPath, out);
      continue;
    }
    if (entry.isFile()) out.push(entryPath);
  }
  return out;
}

function expandVitestPathArg(value, { startDir = process.cwd(), packageRoot } = {}) {
  if (!looksLikePathArg(value) || !hasGlobMagic(value)) {
    return [value];
  }

  const rootDir = packageRoot || startDir;
  if (!rootDir || !existsSync(rootDir)) {
    return [value];
  }

  const matcher = globPatternToRegex(value);
  const matches = walkFiles(rootDir)
    .map((entryPath) => toPosixPath(relative(startDir, entryPath)))
    .filter((entryPath) => matcher.test(entryPath))
    .sort((left, right) => left.localeCompare(right));

  return matches.length > 0 ? matches : [value];
}

export function detectChildSpawnBlocked() {
  try {
    const result = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    return result?.error?.code === "EPERM";
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function detectEsbuildServiceBlocked({ startDir = process.cwd() } = {}) {
  try {
    const originalCwd = process.cwd();
    if (startDir && startDir !== originalCwd) {
      process.chdir(startDir);
    }
    try {
      const esbuild = requireModule("esbuild");
      esbuild.transformSync("const x = 1", { loader: "js" });
      return false;
    } finally {
      if (process.cwd() !== originalCwd) {
        process.chdir(originalCwd);
      }
    }
  } catch (error) {
    return /spawn\s+EPERM/i.test(String(error?.stack || error?.message || error));
  }
}

export function shouldSkipVitestForBlockedChildSpawn(
  { platform = process.platform, env = process.env, startDir = process.cwd() } = {},
) {
  if (platform !== "win32") return false;
  const explicit = String(env?.BOSUN_TEST_CHILD_SPAWN_BLOCKED || "").trim();
  if (explicit === "1") return true;
  return detectChildSpawnBlocked() || detectEsbuildServiceBlocked({ startDir });
}

function resolveVitestHeapMb() {
  const explicit = Number.parseInt(String(process.env.BOSUN_VITEST_HEAP_MB || ""), 10);
  if (Number.isFinite(explicit) && explicit >= 2048) {
    return explicit;
  }
  return process.platform === "win32" ? 6144 : 4096;
}

function mergeNodeOptions(existingOptions, heapMb) {
  const existing = String(existingOptions || "").trim();
  const heapFlag = `--max-old-space-size=${heapMb}`;
  if (!existing) return heapFlag;
  const withoutHeap = existing
    .replace(/(?:^|\s)--max-old-space-size=\S+/g, " ")
    .replace(/(?:^|\s)--max_old_space_size=\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return withoutHeap ? `${withoutHeap} ${heapFlag}` : heapFlag;
}

export function resolveVitestArgs(
  args = process.argv.slice(2),
  { startDir = process.cwd(), packageRoot = findPackageRoot({ startDir }) } = {},
) {
  const normalizedArgs = [...args];
  const filteredArgs = [];
  let hasConfigLoaderArg = false;
  let skipNextReporterValue = false;
  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const arg = normalizedArgs[index];
    if (skipNextReporterValue) {
      skipNextReporterValue = false;
      continue;
    }
    if ((arg === '--reporter' || arg === '-r') && normalizedArgs[index + 1] === 'basic') {
      skipNextReporterValue = true;
      continue;
    }
    if (arg === '--reporter=basic') {
      continue;
    }
    if ((arg === "--config" || arg === "-c") && typeof normalizedArgs[index + 1] === "string") {
      filteredArgs.push(arg);
      filteredArgs.push(resolveCliPathArg(normalizedArgs[index + 1], {
        startDir,
        packageRoot,
      }));
      index += 1;
      continue;
    }
    if (arg.startsWith("--config=")) {
      const value = arg.slice("--config=".length);
      filteredArgs.push(`--config=${resolveCliPathArg(value, { startDir, packageRoot })}`);
      continue;
    }
    if (arg === "--configLoader" || arg === "--config-loader") {
      hasConfigLoaderArg = true;
      filteredArgs.push(arg);
      if (typeof normalizedArgs[index + 1] === "string") {
        filteredArgs.push(normalizedArgs[index + 1]);
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("--configLoader=") || arg.startsWith("--config-loader=")) {
      hasConfigLoaderArg = true;
      filteredArgs.push(arg);
      continue;
    }
    if (looksLikePathArg(arg)) {
      filteredArgs.push(...expandVitestPathArg(arg, { startDir, packageRoot }));
      continue;
    }
    filteredArgs.push(arg);
  }
  if (process.platform === "win32" && !hasConfigLoaderArg) {
    filteredArgs.push("--configLoader", "runner");
  }
  return filteredArgs;
}

export function runVitest(args = process.argv.slice(2), { startDir = process.cwd() } = {}) {
  if (shouldSkipVitestForBlockedChildSpawn({ startDir })) {
    console.log("[vitest] skipped: Windows child-process launch blocked in current Node runtime");
    return 0;
  }

  const vitestEntry = ensureVitestEntry({ startDir });
  if (!vitestEntry) {
    console.error(
      `Unable to locate vitest from ${startDir}. Run npm install in this repository root first.`,
    );
    return 1;
  }

  const vitestArgs = resolveVitestArgs(args, { startDir });
  const heapMb = resolveVitestHeapMb();
  const nodeArgs = [];
  if (process.platform === "win32") {
    const packageRoot = findPackageRoot({ startDir });
    const realpathShimPath = packageRoot
      ? resolve(packageRoot, "tools", "vite-windows-realpath-shim.mjs")
      : "";
    if (realpathShimPath && existsSync(realpathShimPath)) {
      nodeArgs.push("--import", pathToFileURL(realpathShimPath).href);
    }
  }
  nodeArgs.push("--no-warnings=ExperimentalWarning");
  nodeArgs.push(`--max-old-space-size=${heapMb}`);

  const esbuildBinaryPath = resolveWindowsEsbuildBinary({ startDir });
  const env = {
    ...process.env,
    NODE_OPTIONS: mergeNodeOptions(process.env.NODE_OPTIONS, heapMb),
    BOSUN_TEST_CHILD_SPAWN_BLOCKED: detectChildSpawnBlocked() ? "1" : "0",
    ...(esbuildBinaryPath && !process.env.ESBUILD_BINARY_PATH
      ? { ESBUILD_BINARY_PATH: esbuildBinaryPath }
      : {}),
  };

  const result = spawnSync(process.execPath, [...nodeArgs, vitestEntry, ...vitestArgs], {
    cwd: startDir,
    stdio: "inherit",
    env,
  });

  if (typeof result.status === "number") {
    return result.status;
  }
  if (result.error) {
    throw result.error;
  }
  return 1;
}

export function isDirectExecution(argv = process.argv) {
  const scriptPath = argv?.[1];
  if (!scriptPath) return false;

  try {
    return fileURLToPath(import.meta.url) === resolve(scriptPath);
  } catch {
    try {
      return import.meta.url === pathToFileURL(resolve(scriptPath)).href;
    } catch {
      return false;
    }
  }
}

if (isDirectExecution()) {
  try {
    process.exit(runVitest());
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}
