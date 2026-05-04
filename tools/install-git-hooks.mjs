#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeGitEnv } from "../git/git-safety.mjs";
import { isEnvFlagEnabled, shouldAutoInstallGitHooks } from "../task/task-context.mjs";

function runGit(args, cwd) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
    env: sanitizeGitEnv(),
  });
}

function normalizeHooksPath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
}

function isExpectedHooksPath(value) {
  const normalized = normalizeHooksPath(value);
  return normalized === ".githooks" || normalized.endsWith("/.githooks");
}

function getGitConfigValue(cwd, key) {
  const result = runGit(["config", "--get", key], cwd);
  if (result.status !== 0) return "";
  return String(result.stdout || "").trim();
}

function getRepoRoot(cwd) {
  const result = runGit(["rev-parse", "--show-toplevel"], cwd);
  if (result.status !== 0) return "";
  return String(result.stdout || "").trim();
}

export function installGitHooks(options = {}) {
  const cwd = resolve(options.cwd || process.cwd());
  const env = options.env || process.env;
  const silent = options.silent === true;
  const force = options.force === true;

  if (!force && isEnvFlagEnabled(env.BOSUN_SKIP_GIT_HOOKS, false)) {
    return { ok: true, skipped: true, reason: "env-skip" };
  }
  if (!force && !shouldAutoInstallGitHooks({ env })) {
    return { ok: true, skipped: true, reason: "auto-install-disabled" };
  }

  const root = getRepoRoot(cwd);
  if (!root) return { ok: true, skipped: true, reason: "not-a-git-repo" };

  const hooksDir = resolve(root, ".githooks");
  if (!existsSync(hooksDir)) {
    return { ok: true, skipped: true, reason: "missing-hooks-dir", root, hooksDir };
  }

  const previousHooksPath = getGitConfigValue(root, "core.hooksPath");
  if (isExpectedHooksPath(previousHooksPath)) {
    if (!silent) {
      console.log(`[hooks] installed (core.hooksPath=${previousHooksPath || ".githooks"})`);
    }
    return {
      ok: true,
      changed: false,
      repaired: false,
      root,
      hooksDir,
      hooksPath: previousHooksPath || ".githooks",
      previousHooksPath,
    };
  }

  const result = runGit(["config", "core.hooksPath", ".githooks"], root);
  const installedHooksPath = result.status === 0
    ? (getGitConfigValue(root, "core.hooksPath") || ".githooks")
    : previousHooksPath;
  const ok = result.status === 0 && isExpectedHooksPath(installedHooksPath);

  if (ok && !silent) {
    const action = previousHooksPath ? "repaired" : "installed";
    console.log(`[hooks] ${action} (core.hooksPath=${installedHooksPath})`);
  }

  return {
    ok,
    changed: result.status === 0,
    repaired: Boolean(previousHooksPath),
    root,
    hooksDir,
    hooksPath: installedHooksPath,
    previousHooksPath,
    error: ok ? "" : String(result.stderr || result.stdout || "").trim(),
  };
}

function main() {
  const result = installGitHooks();
  if (!result.ok && !result.skipped) {
    console.error(result.error || "[hooks] failed to install .githooks");
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
