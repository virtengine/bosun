import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const tempDirs = [];
const repoRoot = resolve(import.meta.dirname, "..");
const toolModuleUrl = new URL("../tools/sync-demo-ui.mjs", import.meta.url).href;

function createFixture() {
  const root = mkdtempSync(resolve(tmpdir(), "bosun-sync-demo-ui-"));
  tempDirs.push(root);
  const mirroredDir = resolve(root, "site", "ui", "vendor");
  mkdirSync(mirroredDir, { recursive: true });
  writeFileSync(resolve(mirroredDir, "es-module-shims.js"), "export const shim = true;\n");
  execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init", "--quiet"], { cwd: root, stdio: "pipe" });
  return root;
}

function runRefreshMirroredUiGitIndex(args) {
  const script = [
    `const { refreshMirroredUiGitIndex } = await import(${JSON.stringify(toolModuleUrl)});`,
    `const result = refreshMirroredUiGitIndex(${JSON.stringify(args)});`,
    "console.log(JSON.stringify(result));",
  ].join("\n");
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
  return JSON.parse(output);
}

beforeEach(() => {
  tempDirs.length = 0;
});

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("sync-demo-ui", () => {
  it("refreshes the mirrored ui git index for the synced site ui tree", () => {
    const root = createFixture();

    expect(
      runRefreshMirroredUiGitIndex({
        repoRoot: root,
        targetRoot: resolve(root, "site", "ui"),
      }),
    ).toEqual({ attempted: true, refreshed: true, reason: "refreshed" });
  });

  it("treats dirty tracked paths as a non-fatal git refresh result", () => {
    const root = createFixture();
    writeFileSync(resolve(root, "site", "ui", "vendor", "es-module-shims.js"), "export const shim = false;\n");

    expect(
      runRefreshMirroredUiGitIndex({
        repoRoot: root,
        targetRoot: resolve(root, "site", "ui"),
      }),
    ).toMatchObject({
      attempted: true,
      refreshed: false,
      reason: "dirty_paths",
      details: expect.any(String),
    });
  });

  it("rethrows unexpected git refresh failures", () => {
    const root = mkdtempSync(resolve(tmpdir(), "bosun-sync-demo-ui-missing-git-"));
    tempDirs.push(root);

    expect(() =>
      runRefreshMirroredUiGitIndex({
        repoRoot: root,
        targetRoot: resolve(root, "site", "ui"),
      })).toThrow(/not a git repository/i);
  });

  it("wires the git refresh helper into demo-ui sync", () => {
    const source = readFileSync(resolve(repoRoot, "tools", "sync-demo-ui.mjs"), "utf8");

    expect(source).toContain("refreshMirroredUiGitIndex();");
  });
});
