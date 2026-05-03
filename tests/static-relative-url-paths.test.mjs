import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { describe, it, expect } from "vitest";

const REPO_ROOT = process.cwd();
const SOURCE_EXTENSIONS = new Set([".mjs", ".cjs", ".js"]);
const EXCLUDED_DIRS = new Set([
  ".git",
  ".cache",
  "node_modules",
  "logs",
  "test-results",
  "playwright-screenshots",
  "coverage",
  "dist",
]);
const INCLUDED_ROOTS = new Set([
  "agent",
  "config",
  "desktop",
  "github",
  "infra",
  "kanban",
  "lib",
  "server",
  "shell",
  "task",
  "telegram",
  "tools",
  "ui",
  "voice",
  "workflow",
  "workflow-templates",
  "workspace",
]);

function collectSourceFiles(dir, out = []) {
  const relDir = relative(REPO_ROOT, dir);
  if (relDir && !relDir.startsWith("..")) {
    const top = relDir.split(/[\\/]/)[0];
    if (!INCLUDED_ROOTS.has(top)) {
      return out;
    }
  }

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      // Skip hidden dirs/files except root-level .mjs/.cjs/.js files.
      if (entry.isDirectory()) continue;
    }
    const abs = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      collectSourceFiles(abs, out);
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(extname(entry.name))) continue;
    out.push(abs);
  }
  return out;
}

function listTrackedSourceFiles() {
  try {
    const tracked = execFileSync("git", ["ls-files", "-z"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return tracked
      .split("\0")
      .filter(Boolean)
      .map((file) => resolve(REPO_ROOT, file))
      .filter((file) => SOURCE_EXTENSIONS.has(extname(file)))
      .filter((file) => {
        const relFile = relative(REPO_ROOT, file);
        if (!relFile || relFile.startsWith("..")) return false;
        const segments = relFile.split(/[\\/]/).filter(Boolean);
        if (segments.length === 1) return true;
        if (segments.some((segment) => EXCLUDED_DIRS.has(segment))) return false;
        return INCLUDED_ROOTS.has(segments[0]);
      });
  } catch {
    return collectSourceFiles(REPO_ROOT);
  }
}

function findStaticRelativeUrlRefs(source) {
  const refs = [];
  const regex = /new\s+URL\(\s*(["'`])((?:\.\.\/|\.\/)[^"'`]+)\1\s*,\s*import\.meta\.url\s*\)/g;
  let match;
  while ((match = regex.exec(source)) !== null) {
    refs.push(match[2]);
  }
  return refs;
}

describe("static relative URL paths", () => {
  it("resolves all new URL('./...|../...', import.meta.url) targets", () => {
    const files = listTrackedSourceFiles();

    const missing = [];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const refs = findStaticRelativeUrlRefs(source);
      if (refs.length === 0) continue;

      for (const relRef of refs) {
        const target = resolve(dirname(file), relRef);
        if (!existsSync(target)) {
          missing.push({ file, relRef, target });
        }
      }
    }

    expect(missing).toEqual([]);
  }, 20000);
});
