#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeGitEnv } from "../git/git-safety.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");
const SOURCE_ROOT = resolve(ROOT, "ui");
const TARGET_ROOT = resolve(ROOT, "site", "ui");

const ROOT_FILES = [
  "app.js",
  "app.legacy.js",
  "app.monolith.js",
  "styles.css",
  "styles.monolith.css",
  "logo.svg",
  "logo.png",
  "favicon.png",
];

const ROOT_DIRS = [
  "components",
  "modules",
  "tabs",
  "styles",
  "assets",
  "vendor",
];
const GIT_ENV = sanitizeGitEnv();

function ensureParentDir(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

function toPosixPath(filePath) {
  return String(filePath || "").replace(/\\/g, "/");
}

export function isPathWithinRoot(rootPath, candidatePath) {
  const normalizedRoot = toPosixPath(resolve(rootPath));
  const normalizedCandidate = toPosixPath(resolve(candidatePath));
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function extractExecFileErrorText(error) {
  return [error?.stdout, error?.stderr, error?.message]
    .map((value) => {
      if (!value) return "";
      if (Buffer.isBuffer(value)) return value.toString("utf8");
      return String(value);
    })
    .join("\n")
    .trim();
}

export function refreshMirroredUiGitIndex({ repoRoot = ROOT, targetRoot = TARGET_ROOT } = {}) {
  const pathspec = toPosixPath(relative(repoRoot, targetRoot)) || ".";
  const trackedPathsRaw = execFileSync("git", ["ls-files", "-z", "--", pathspec], {
    cwd: repoRoot,
    stdio: "pipe",
    env: GIT_ENV,
  });
  const trackedPaths = Buffer.from(trackedPathsRaw || "")
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  if (trackedPaths.length === 0) {
    return { attempted: false, refreshed: false, reason: "no_tracked_files" };
  }
  try {
    execFileSync("git", ["update-index", "-q", "--refresh", "-z", "--stdin"], {
      cwd: repoRoot,
      input: `${trackedPaths.join("\0")}\0`,
      stdio: "pipe",
      env: GIT_ENV,
    });
  } catch (error) {
    const exitCode = Number(error?.status ?? error?.exitCode ?? 0);
    if (exitCode === 1) {
      return { attempted: true, refreshed: false, reason: "dirty_paths", details: extractExecFileErrorText(error) };
    }
    throw error;
  }
  const remainingStatus = execFileSync("git", ["status", "--porcelain", "--", pathspec], {
    cwd: repoRoot,
    stdio: "pipe",
    env: GIT_ENV,
  }).toString("utf8").trim();
  if (remainingStatus) {
    return { attempted: true, refreshed: false, reason: "dirty_paths", details: remainingStatus };
  }
  return { attempted: true, refreshed: true, reason: "refreshed" };
}

function rewriteMirroredUiImports(sourceText, sourcePath, targetPath) {
  if (!/\.(?:m?js)$/i.test(sourcePath)) return sourceText;

  const sourceDir = dirname(sourcePath);
  const targetDir = dirname(targetPath);

  return sourceText.replace(/(\bfrom\s*|\bimport\s*\()\s*(['"])(\.[^'"]+)\2/g, (match, prefix, quote, specifier) => {
    const resolvedImport = resolve(sourceDir, specifier);
    if (isPathWithinRoot(SOURCE_ROOT, resolvedImport)) {
      return match;
    }

    let rewritten = toPosixPath(relative(targetDir, resolvedImport));
    if (!rewritten.startsWith(".")) {
      rewritten = "./" + rewritten;
    }
    return `${prefix}${quote}${rewritten}${quote}`;
  });
}

function copyFileIfChanged(sourcePath, targetPath) {
  const rawSource = readFileSync(sourcePath);
  const source = /\.(?:m?js)$/i.test(sourcePath)
    ? Buffer.from(
      rewriteMirroredUiImports(rawSource.toString("utf8"), sourcePath, targetPath),
      "utf8",
    )
    : rawSource;
  if (existsSync(targetPath)) {
    const current = readFileSync(targetPath);
    if (Buffer.compare(source, current) === 0) {
      return false;
    }
  }
  ensureParentDir(targetPath);
  writeFileSync(targetPath, source);
  return true;
}

function syncDirectory(relativeDir, updatedPaths) {
  const sourceDir = join(SOURCE_ROOT, relativeDir);
  const targetDir = join(TARGET_ROOT, relativeDir);
  if (!existsSync(sourceDir)) return;
  const entries = readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.endsWith(".bak")) continue;
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);
    if (entry.isDirectory()) {
      syncDirectory(join(relativeDir, entry.name), updatedPaths);
      continue;
    }
    if (!entry.isFile()) continue;
    if (copyFileIfChanged(sourcePath, targetPath)) {
      updatedPaths.push(targetPath);
    }
  }
}

export async function syncDemoUi({ silent = false } = {}) {
  const updatedPaths = [];
  for (const fileName of ROOT_FILES) {
    const sourcePath = join(SOURCE_ROOT, fileName);
    const targetPath = join(TARGET_ROOT, fileName);
    if (!existsSync(sourcePath)) continue;
    if (copyFileIfChanged(sourcePath, targetPath)) {
      updatedPaths.push(targetPath);
    }
  }

  for (const dirName of ROOT_DIRS) {
    syncDirectory(dirName, updatedPaths);
  }

  refreshMirroredUiGitIndex();

  if (!silent && updatedPaths.length > 0) {
    console.log(`[demo-ui] synced ${updatedPaths.length} file(s)`);
  }

  return {
    updatedPaths,
    updated: updatedPaths.length > 0,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await syncDemoUi();
}
