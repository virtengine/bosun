import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

const TOOL = resolve("tools", "syntax-check.mjs");
const NODE_ARGS = [
  "--experimental-vm-modules",
  "--no-warnings=ExperimentalWarning",
  TOOL,
];

function run(rootDir, files = []) {
  const args = [...NODE_ARGS, "--root", rootDir];
  if (files.length > 0) {
    args.push("--files", files.join(","));
  }
  return execFileSync(
    process.execPath,
    args,
    { encoding: "utf8", cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
  );
}

function runExpectFail(rootDir, files = []) {
  try {
    run(rootDir, files);
    return { exitCode: 0, stdout: "", stderr: "" };
  } catch (err) {
    return { exitCode: err.status, stdout: err.stdout, stderr: err.stderr };
  }
}

describe("syntax-check", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "syntax-check-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports nested module syntax errors before import validation", () => {
    mkdirSync(join(tmpDir, "workspace"));
    writeFileSync(
      join(tmpDir, "workspace", "broken.mjs"),
      `export const helper = ;\n`,
    );

    const { exitCode, stderr } = runExpectFail(tmpDir, ["workspace/broken.mjs"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Syntax error: workspace/broken.mjs");
    expect(stderr).not.toContain("Import validation failed");
  });

  it("accepts nested source modules when they parse cleanly", () => {
    mkdirSync(join(tmpDir, "workspace"));
    writeFileSync(
      join(tmpDir, "workspace", "ok.mjs"),
      `export function helper() { return "ok"; }\n`,
    );

    const stdout = run(tmpDir, ["workspace/ok.mjs"]);
    expect(stdout).toContain("Syntax OK: 1 modules");
  });
});
