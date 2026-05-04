#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getRequiredHarnessRuntimeAssets } from "./prepublish-check.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const nodeCmd = process.execPath;
const SMOKE_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.BOSUN_PACKED_SMOKE_TIMEOUT_MS || "15000") || 15000,
);
const NPM_TIMEOUT_MS = Math.max(
  SMOKE_TIMEOUT_MS,
  Number(process.env.BOSUN_PACKED_SMOKE_NPM_TIMEOUT_MS || "120000") || 120000,
);
const nodeBinDir = dirname(nodeCmd);
const GIT_ENV_KEYS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_KEY_1",
  "GIT_CONFIG_KEY_2",
  "GIT_CONFIG_KEY_3",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_VALUE_0",
  "GIT_CONFIG_VALUE_1",
  "GIT_CONFIG_VALUE_2",
  "GIT_CONFIG_VALUE_3",
  "GIT_DIR",
  "GIT_EXEC_PATH",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_WORK_TREE",
];

function resolveNpmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    resolve(nodeBinDir, "node_modules", "npm", "bin", "npm-cli.js"),
    resolve(nodeBinDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error("Unable to locate npm-cli.js for packed smoke test");
}

const npmCliPath = resolveNpmCliPath();

function isWindowsChildLaunchBlocked(error) {
  if (process.platform !== "win32") return false;
  const message = String(error?.message || "");
  return message.includes("EPERM") && /spawn(?:Sync)?\s/i.test(message);
}

function sanitizedChildEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of GIT_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

function runNpm(args, options = {}) {
  const cwd = options.cwd || ROOT;
  return execFileSync(nodeCmd, [npmCliPath, ...args], {
    cwd,
    encoding: "utf8",
    env: sanitizedChildEnv(options.env),
    stdio: ["pipe", "pipe", "pipe"],
    timeout: NPM_TIMEOUT_MS,
    ...options,
  });
}

function packTarball() {
  const raw = runNpm(["pack", "--json", "--ignore-scripts"]);
  const parsed = JSON.parse(raw);
  const filename = parsed?.[0]?.filename;
  if (!filename) {
    throw new Error("npm pack did not return a tarball filename");
  }
  return resolve(ROOT, filename);
}

function installPackedArtifact(tarballPath, installDir) {
  writeFileSync(
    resolve(installDir, "package.json"),
    JSON.stringify({ name: "bosun-packed-smoke", private: true, type: "module" }, null, 2),
  );
  runNpm(["install", "--ignore-scripts", "--no-package-lock", tarballPath], {
    cwd: installDir,
  });
}

function runNode(args, options = {}) {
  return execFileSync(nodeCmd, args, {
    encoding: "utf8",
    env: sanitizedChildEnv(options.env),
    stdio: ["pipe", "pipe", "pipe"],
    timeout: SMOKE_TIMEOUT_MS,
    ...options,
  });
}

function assertPackedCliStarts(installDir) {
  const cliPath = resolve(installDir, "node_modules", "bosun", "cli.mjs");

  const versionOutput = runNode([cliPath, "--version"], {
    cwd: installDir,
  });
  if (!/\d+\.\d+\.\d+/.test(versionOutput)) {
    throw new Error(`packed CLI --version returned unexpected output: ${JSON.stringify(versionOutput.trim())}`);
  }

  const helpOutput = runNode([cliPath, "--help"], {
    cwd: installDir,
  });
  if (!helpOutput.includes("bosun v") || !helpOutput.includes("USAGE")) {
    throw new Error("packed CLI --help did not print the expected usage text");
  }

  const configImportOutput = runNode(
    [
      "--input-type=module",
      "--eval",
      "const mod = await import('bosun/config'); console.log(typeof mod.loadConfig);",
    ],
    {
      cwd: installDir,
    },
  );
  if (!configImportOutput.trim().includes("function")) {
    throw new Error("packed package export 'bosun/config' did not import successfully");
  }
}

function assertPackedRuntimeModulesLoad(installDir) {
  const requiredStep9Assets = JSON.stringify(getRequiredHarnessRuntimeAssets());
  const probeOutput = runNode(
    [
      "--input-type=module",
      "--eval",
      `
        import { existsSync, mkdtempSync, rmSync } from "node:fs";
        import { tmpdir } from "node:os";
        import { resolve } from "node:path";
        import { pathToFileURL } from "node:url";

        const installDir = process.cwd();
        const packageDir = resolve(installDir, "node_modules", "bosun");
        const requiredStep9Assets = ${requiredStep9Assets};

        for (const asset of requiredStep9Assets) {
          if (!existsSync(resolve(packageDir, asset))) {
            throw new Error(\`packed package is missing required Step 9 asset: \${asset}\`);
          }
        }

        const skillsModule = await import(pathToFileURL(resolve(packageDir, "agent", "bosun-skills.mjs")).href);
        const skillsHome = mkdtempSync(resolve(tmpdir(), "bosun-packed-skills-"));
        try {
          const result = skillsModule.scaffoldSkills(skillsHome);
          if (result.written.length !== skillsModule.BUILTIN_SKILLS.length) {
            throw new Error(\`expected \${skillsModule.BUILTIN_SKILLS.length} scaffolded skills, got \${result.written.length}\`);
          }
        } finally {
          rmSync(skillsHome, { recursive: true, force: true });
        }

        const codexShellModule = await import(pathToFileURL(resolve(packageDir, "shell", "codex-shell.mjs")).href);
        if (typeof codexShellModule.initCodexShell !== "function") {
          throw new Error("packed shell/codex-shell.mjs did not load expected exports");
        }

        process.env.BOSUN_ENV_NO_OVERRIDE = "1";
        process.env.TELEGRAM_UI_TLS_DISABLE = "true";
        process.env.TELEGRAM_UI_ALLOW_UNSAFE = "true";
        process.env.TELEGRAM_UI_TUNNEL = "disabled";
        process.env.BOSUN_UI_ALLOW_EPHEMERAL_PORT = "1";
        process.env.BOSUN_UI_AUTO_OPEN_BROWSER = "false";
        process.env.BOSUN_UI_BROWSER_OPEN_MODE = "manual";
        process.env.TELEGRAM_BOT_TOKEN = "";
        process.env.TELEGRAM_CHAT_ID = "";
        process.env.KANBAN_BACKEND = "internal";

        const uiServerModule = await import(pathToFileURL(resolve(packageDir, "server", "ui-server.mjs")).href);
        const server = await uiServerModule.startTelegramUiServer({
          port: 0,
          host: "127.0.0.1",
          skipInstanceLock: true,
          skipAutoOpen: true,
        });

        try {
          const port = server.address().port;
          const health = await fetch(\`http://127.0.0.1:\${port}/api/health\`);
          if (!health.ok) {
            throw new Error(\`packed UI server health probe failed with status \${health.status}\`);
          }

          const appJs = await fetch(\`http://127.0.0.1:\${port}/app.js?native=1\`);
          const appJsText = await appJs.text();
          const appJsContentType = String(appJs.headers.get("content-type") || "").toLowerCase();
          if (!appJs.ok || appJsText.trim().length < 100 || !appJsContentType.includes("javascript")) {
            throw new Error("packed UI server failed to serve app.js");
          }

          const settings = await fetch(\`http://127.0.0.1:\${port}/api/settings\`);
          const settingsJson = await settings.json();
          if (!settings.ok || settingsJson?.ok !== true) {
            throw new Error("packed UI server failed to serve settings payload");
          }

          if (!existsSync(resolve(packageDir, ".env.example"))) {
            throw new Error("packed package is missing .env.example");
          }
        } finally {
          uiServerModule.stopTelegramUiServer();
        }

        console.log("runtime-probes-ok");
      `,
    ],
    {
      cwd: installDir,
    },
  );

  if (!probeOutput.trim().includes("runtime-probes-ok")) {
    throw new Error("packed runtime probes did not report success");
  }
}

function safeRemove(targetPath, label) {
  if (!targetPath) return;
  try {
    rmSync(targetPath, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  } catch (error) {
    console.warn(`[smoke] warning: failed to clean ${label}: ${error.message}`);
  }
}

function main() {
  const tempRoot = mkdtempSync(resolve(tmpdir(), "bosun-packed-smoke-"));
  const installDir = resolve(tempRoot, "install");
  mkdirSync(installDir, { recursive: true });

  let tarballPath = "";
  try {
    tarballPath = packTarball();
    installPackedArtifact(tarballPath, installDir);
    assertPackedCliStarts(installDir);
    assertPackedRuntimeModulesLoad(installDir);

    const manifest = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
    console.log(
      `[smoke] packed CLI ok: ${manifest.name}@${manifest.version}`,
    );
  } catch (error) {
    if (isWindowsChildLaunchBlocked(error)) {
      console.warn(
        `[smoke] skipped packed CLI smoke: Windows child-process launch blocked in current Node runtime (${error.message})`,
      );
      return;
    }
    throw error;
  } finally {
    safeRemove(tarballPath, "packed tarball");
    safeRemove(tempRoot, "temporary smoke workspace");
  }
}

main();
