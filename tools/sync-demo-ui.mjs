#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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

/**
 * The bytes a mirrored file must contain, or `null` when the source is absent.
 *
 * Shared by the writer and the freshness guard so the guard compares against the
 * exact transformation the sync applies, rather than a reimplementation that
 * could drift from it.
 */
function deriveMirroredBytes(sourcePath, targetPath) {
  const rawSource = readFileSync(sourcePath);
  return /\.(?:m?js)$/i.test(sourcePath)
    ? Buffer.from(rewriteMirroredUiImports(rawSource.toString("utf8"), sourcePath, targetPath), "utf8")
    : rawSource;
}

function copyFileIfChanged(sourcePath, targetPath) {
  const source = deriveMirroredBytes(sourcePath, targetPath);
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

/**
 * Enumerate every (source, target) pair the sync would write, sorted by a stable
 * report key.
 *
 * `relPath` is relative to the TARGET root, so the report reads `vendor/preact.js`
 * under a `root` label of `site/ui`. Two fields rather than one root-relative path
 * because `ui/` and `site/ui/` hold same-named files, and a bare
 * `vendor/preact.js` in a drift message would not say which of the two drifted.
 * Anchoring to the target root (not to ROOT) also keeps the key meaningful when a
 * caller points the function at a scratch tree, as the tests do.
 *
 * `.bak` files and anything outside ROOT_FILES/ROOT_DIRS are deliberately absent:
 * they are not mirrored, so the guard must not hold the committed mirror to them.
 */
export function collectMirrorPlan({
  sourceRoot = SOURCE_ROOT,
  targetRoot = TARGET_ROOT,
} = {}) {
  const plan = [];

  for (const fileName of ROOT_FILES) {
    const sourcePath = join(sourceRoot, fileName);
    if (!existsSync(sourcePath)) continue;
    plan.push({
      relPath: toPosixPath(relative(targetRoot, join(targetRoot, fileName))),
      sourcePath,
      targetPath: join(targetRoot, fileName),
    });
  }

  const walk = (sourceDir, targetDir) => {
    if (!existsSync(sourceDir)) return;
    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      if (entry.name.endsWith(".bak")) continue;
      const sourcePath = join(sourceDir, entry.name);
      const targetPath = join(targetDir, entry.name);
      if (entry.isDirectory()) {
        walk(sourcePath, targetPath);
        continue;
      }
      if (!entry.isFile()) continue;
      plan.push({
        relPath: toPosixPath(relative(targetRoot, targetPath)),
        sourcePath,
        targetPath,
      });
    }
  };

  for (const dirName of ROOT_DIRS) {
    walk(join(sourceRoot, dirName), join(targetRoot, dirName));
  }

  plan.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return plan;
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

// ── Freshness guard ───────────────────────────────────────────────────────────

/**
 * Diff every mirrored file against its source, plus detect a mirrored file that
 * exists in `site/ui/` with no counterpart in `ui/`.
 *
 * The orphan direction matters: `syncDemoUi` only ever adds or overwrites, so a
 * file left behind in the mirror after being deleted from `ui/` would survive
 * every future sync and keep shipping to GitHub Pages. Content-only comparison
 * cannot see it, so `collectMirrorPlan` is walked in both directions.
 *
 * `status` is one of:
 *   'ok'       — committed bytes match the mirrored source
 *   'missing'  — the source exists but the mirror copy is absent
 *   'differs'  — the mirror copy exists but the bytes differ
 *   'orphan'   — the mirror copy exists but `ui/` has no such file
 */
export function compareMirror({ sourceRoot = SOURCE_ROOT, targetRoot = TARGET_ROOT } = {}) {
  const root = toPosixPath(relative(ROOT, resolve(targetRoot))) || "site/ui";

  const records = collectMirrorPlan({ sourceRoot, targetRoot }).map((entry) => {
    const expected = deriveMirroredBytes(entry.sourcePath, entry.targetPath);
    let committed;
    try {
      committed = readFileSync(entry.targetPath);
    } catch {
      return {
        root,
        relPath: entry.relPath,
        status: "missing",
        expectedBytes: expected.length,
        committedBytes: 0,
      };
    }
    const status = committed.equals(expected) ? "ok" : "differs";
    return {
      root,
      relPath: entry.relPath,
      status,
      expectedBytes: expected.length,
      committedBytes: committed.length,
    };
  });

  const planned = new Set(records.map((r) => r.relPath));
  records.push(...findOrphanMirrors({ sourceRoot, targetRoot, planned }).map((r) => ({ root, ...r })));
  return records;
}

/**
 * Walk the committed mirror for files the sync would never write.
 *
 * Only ROOT_FILES/ROOT_DIRS are mirrored, so only those are examined. A file
 * inside a mirrored directory whose `ui/` counterpart is gone is an orphan; a
 * directory that exists only under `site/ui/` is not, because the walk stops at
 * ROOT_DIRS boundaries.
 */
function findOrphanMirrors({ sourceRoot, targetRoot, planned }) {
  const orphans = [];

  for (const fileName of ROOT_FILES) {
    const relPath = toPosixPath(relative(targetRoot, join(targetRoot, fileName)));
    if (planned.has(relPath)) continue;
    if (!existsSync(join(targetRoot, fileName))) continue;
    let size = 0;
    try {
      size = readFileSync(join(targetRoot, fileName)).length;
    } catch {
      continue;
    }
    orphans.push({ relPath, status: "orphan", expectedBytes: 0, committedBytes: size });
  }

  const walk = (sourceDir, targetDir) => {
    if (!existsSync(targetDir)) return;
    for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
      if (entry.name.endsWith(".bak")) continue;
      const sourcePath = join(sourceDir, entry.name);
      const targetPath = join(targetDir, entry.name);
      if (entry.isDirectory()) {
        if (!existsSync(sourcePath)) {
          // Whole directories that only exist in the mirror are orphan too, but
          // reported file-by-file so the message names real paths.
          for (const nested of readdirSync(targetPath, { withFileTypes: true, recursive: true })) {
            if (!nested.isFile()) continue;
            const nestedPath = join(targetPath, nested.parentPath ?? "", nested.name);
            if (nested.name.endsWith(".bak")) continue;
            const relPath = toPosixPath(relative(targetRoot, nestedPath));
            if (planned.has(relPath)) continue;
            orphans.push({
              relPath,
              status: "orphan",
              expectedBytes: 0,
              committedBytes: readFileSync(nestedPath).length,
            });
          }
          continue;
        }
        walk(sourcePath, targetPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const relPath = toPosixPath(relative(targetRoot, targetPath));
      if (planned.has(relPath)) continue;
      orphans.push({
        relPath,
        status: "orphan",
        expectedBytes: 0,
        committedBytes: readFileSync(targetPath).length,
      });
    }
  };

  for (const dirName of ROOT_DIRS) {
    walk(join(sourceRoot, dirName), join(targetRoot, dirName));
  }

  orphans.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return orphans;
}

/**
 * Check the committed `site/ui` mirror against `ui/` without writing anything.
 *
 * Scope note: this covers only the files in ROOT_FILES/ROOT_DIRS. The three HTML
 * pages (`demo.html`, `index.html`, `setup.html`) and `demo-defaults.js` are NOT
 * mirrored by `syncDemoUi`, so they are deliberately outside this guard —
 * `setup.html` in particular differs legitimately between the two roots and
 * would make this gate permanently red if it were extended to cover it.
 * `demo-defaults.js` is owned by tools/generate-demo-defaults.mjs's own guard,
 * which checks both roots directly.
 */
export function checkDemoUiFreshness() {
  return compareMirror();
}

function reportDrift(records) {
  const drifted = records.filter((r) => r.status !== "ok");
  if (drifted.length === 0) {
    console.log("[demo-ui] site/ui mirror matches ui/ ✓");
    return;
  }
  for (const record of drifted) {
    let detail;
    if (record.status === "missing") {
      detail = "not committed";
    } else if (record.status === "orphan") {
      detail = `orphaned ${record.committedBytes} bytes with no ui/ counterpart`;
    } else {
      detail = `${record.committedBytes} bytes committed vs ${record.expectedBytes} bytes generated`;
    }
    console.error(`  ✗ ${record.root}/${record.relPath} — ${detail}`);
  }
  console.error(
    "\n[demo-ui] The committed site/ui mirror is out of date with ui/.\n" +
      "[demo-ui] Run `npm run demo-ui:sync` and commit ALL of the resulting site/ui/ files.",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  if (process.argv.includes("--check")) {
    const records = checkDemoUiFreshness();
    reportDrift(records);
    process.exit(records.every((r) => r.status === "ok") ? 0 : 1);
  }
  await syncDemoUi();
}
