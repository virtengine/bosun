import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sanitizeGitEnv } from "../git/git-safety.mjs";

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

export function findVitestConfigPath(
  { startDir = process.cwd(), packageRoot = findPackageRoot({ startDir }) } = {},
) {
  const searchRoot = packageRoot || resolve(startDir);
  const candidates = [
    "vitest.config.mjs",
    "vitest.config.js",
    "vitest.config.ts",
    "vite.config.mjs",
    "vite.config.js",
    "vite.config.ts",
  ].map((relativePath) => resolve(searchRoot, relativePath));
  return candidates.find((candidate) => existsSync(candidate)) || null;
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
      env: sanitizeGitEnv(process.env),
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
  if (!hasConfigLoaderArg) {
    filteredArgs.push("--configLoader", resolveVitestConfigLoader({ startDir, packageRoot }));
  }
  return filteredArgs;
}

export function resolveVitestConfigLoader(
  { startDir = process.cwd(), packageRoot = findPackageRoot({ startDir }), env = process.env } = {},
) {
  const explicit = String(
    env?.BOSUN_VITEST_CONFIG_LOADER || env?.VITEST_CONFIG_LOADER || "",
  ).trim().toLowerCase();
  if (explicit === "native" || explicit === "runner") {
    return explicit;
  }
  const nodeModulesPath = resolve(packageRoot || startDir, "node_modules");
  if (existsSync(nodeModulesPath)) {
    try {
      if (lstatSync(nodeModulesPath).isSymbolicLink()) {
        return "native";
      }
    } catch {
      // Fall through to the standard default when the node_modules metadata is unreadable.
    }
  }
  return "runner";
}

export function resolveVitestExperimentalCacheDir(
  { startDir = process.cwd(), packageRoot = findPackageRoot({ startDir }), env = process.env } = {},
) {
  const explicit = String(env?.VITEST_EXPERIMENTAL_CACHE || "").trim();
  if (explicit) return explicit;
  const sharedCacheRoot = String(env?.BOSUN_TEST_CACHE_DIR || "").trim();
  const cacheRoot = sharedCacheRoot || resolve(packageRoot || startDir, ".cache", "vitest");
  return resolve(cacheRoot, "experimental-cache");
}

export function resolveVitestCacheDir(
  { startDir = process.cwd(), packageRoot = findPackageRoot({ startDir }), env = process.env } = {},
) {
  const explicit = String(env?.BOSUN_VITE_CACHE_DIR || "").trim();
  if (explicit) return explicit;
  const sharedCacheRoot = String(env?.BOSUN_TEST_CACHE_DIR || "").trim();
  const cacheRoot = sharedCacheRoot || resolve(packageRoot || startDir, ".cache", "vitest");
  return resolve(cacheRoot, "vite");
}

export function buildVitestCacheOverrideConfigSource(
  { baseConfigPath = null, viteCacheDir, experimentalCacheDir } = {},
) {
  const baseImport = baseConfigPath
    ? `await import(${JSON.stringify(pathToFileURL(baseConfigPath).href)})`
    : "{}";
  return `import * as vitestConfig from "vitest/config";

const defineConfig =
  vitestConfig.defineConfig ??
  vitestConfig.default?.defineConfig ??
  ((config) => config);

const mergeConfig =
  vitestConfig.mergeConfig ??
  vitestConfig.default?.mergeConfig ??
  ((base, override) => ({
    ...(base && typeof base === "object" ? base : {}),
    ...(override && typeof override === "object" ? override : {}),
    test: {
      ...((base && typeof base === "object" && base.test && typeof base.test === "object") ? base.test : {}),
      ...((override && typeof override === "object" && override.test && typeof override.test === "object") ? override.test : {}),
    },
  }));

const baseModule = ${baseImport};
const baseExport = baseModule.default ?? baseModule;
const baseConfig = typeof baseExport === "function"
  ? await baseExport({ command: "serve", mode: "test" })
  : baseExport;

export default mergeConfig(
  baseConfig && typeof baseConfig === "object" ? baseConfig : {},
  defineConfig({
    cacheDir: ${JSON.stringify(viteCacheDir)},
    test: {
      experimental: {
        fsModuleCachePath: ${JSON.stringify(experimentalCacheDir)},
      },
    },
  }),
);
`;
}

export function injectVitestConfigOverride(args = [], configPath) {
  if (!configPath) return [...args];
  const nextArgs = [...args];
  for (let index = 0; index < nextArgs.length; index += 1) {
    if ((nextArgs[index] === "--config" || nextArgs[index] === "-c") && typeof nextArgs[index + 1] === "string") {
      nextArgs[index + 1] = configPath;
      return nextArgs;
    }
    if (String(nextArgs[index] || "").startsWith("--config=")) {
      nextArgs[index] = `--config=${configPath}`;
      return nextArgs;
    }
  }
  const configLoaderIndex = nextArgs.findIndex((arg) => arg === "--configLoader" || arg === "--config-loader");
  const inlineConfigLoaderIndex = nextArgs.findIndex(
    (arg) => String(arg || "").startsWith("--configLoader=") || String(arg || "").startsWith("--config-loader="),
  );
  const insertAt = configLoaderIndex >= 0
    ? configLoaderIndex
    : inlineConfigLoaderIndex >= 0
      ? inlineConfigLoaderIndex
      : nextArgs.length;
  nextArgs.splice(insertAt, 0, "--config", configPath);
  return nextArgs;
}

function writeVitestCacheOverrideConfig(
  {
    startDir = process.cwd(),
    packageRoot = findPackageRoot({ startDir }),
    baseConfigPath = findVitestConfigPath({ startDir, packageRoot }),
    viteCacheDir = resolveVitestCacheDir({ startDir, packageRoot }),
    experimentalCacheDir = resolveVitestExperimentalCacheDir({ startDir, packageRoot }),
  } = {},
) {
  const cacheRoot = resolve(packageRoot || startDir, ".cache", "vitest");
  mkdirSync(cacheRoot, { recursive: true });
  const overridePath = resolve(cacheRoot, "bosun-vitest-cache-override.mjs");
  writeFileSync(
    overridePath,
    buildVitestCacheOverrideConfigSource({
      baseConfigPath,
      viteCacheDir,
      experimentalCacheDir,
    }),
    "utf8",
  );
  return overridePath;
}

export function runVitest(
  args = process.argv.slice(2),
  {
    startDir = process.cwd(),
    ensureVitest = ensureVitestEntry,
    spawn = spawnSync,
    env: baseEnv = process.env,
  } = {},
) {
  if (shouldSkipVitestForBlockedChildSpawn({ startDir })) {
    console.log("[vitest] skipped: Windows child-process launch blocked in current Node runtime");
    return 0;
  }

  const vitestEntry = ensureVitest({ startDir });
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

  const packageRoot = findPackageRoot({ startDir });
  const viteCacheDir = resolveVitestCacheDir({ startDir, packageRoot, env: baseEnv });
  const experimentalCacheDir = resolveVitestExperimentalCacheDir({ startDir, packageRoot, env: baseEnv });
  const configOverridePath = writeVitestCacheOverrideConfig({
    startDir,
    packageRoot,
    baseConfigPath: findVitestConfigPath({ startDir, packageRoot }),
    viteCacheDir,
    experimentalCacheDir,
  });
  const vitestArgsWithOverride = injectVitestConfigOverride(vitestArgs, configOverridePath);
  const esbuildBinaryPath = resolveWindowsEsbuildBinary({ startDir });
  const env = sanitizeGitEnv({
    ...baseEnv,
    NODE_OPTIONS: mergeNodeOptions(baseEnv.NODE_OPTIONS, heapMb),
    BOSUN_TEST_CHILD_SPAWN_BLOCKED: detectChildSpawnBlocked() ? "1" : "0",
    VITEST_EXPERIMENTAL_CACHE: experimentalCacheDir,
    ...(esbuildBinaryPath && !process.env.ESBUILD_BINARY_PATH
      ? { ESBUILD_BINARY_PATH: esbuildBinaryPath }
      : {}),
  });
  mkdirSync(env.VITEST_EXPERIMENTAL_CACHE, { recursive: true });
  mkdirSync(viteCacheDir, { recursive: true });

  const result = spawn(process.execPath, [...nodeArgs, vitestEntry, ...vitestArgsWithOverride], {
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
