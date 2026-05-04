import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

const TOOL = resolve("tools", "import-check.mjs");
const NODE_ARGS = [
  "--experimental-vm-modules",
  "--no-warnings=ExperimentalWarning",
  TOOL,
];

function run(rootDir, files) {
  const fileArg = files.join(",");
  return execFileSync(
    process.execPath,
    [...NODE_ARGS, "--root", rootDir, "--files", fileArg],
    { encoding: "utf8", cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
  );
}

function runExpectFail(rootDir, files) {
  const fileArg = files.join(",");
  try {
    execFileSync(
      process.execPath,
      [...NODE_ARGS, "--root", rootDir, "--files", fileArg],
      { encoding: "utf8", cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
    );
    return { exitCode: 0, stdout: "", stderr: "" };
  } catch (err) {
    return { exitCode: err.status, stdout: err.stdout, stderr: err.stderr };
  }
}

describe("import-check", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "import-check-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("passes when all named imports are valid", () => {
    writeFileSync(
      join(tmpDir, "a.mjs"),
      `import { greet } from "./b.mjs";\nconsole.log(greet);\n`,
    );
    writeFileSync(
      join(tmpDir, "b.mjs"),
      `export function greet() { return "hi"; }\n`,
    );

    const stdout = run(tmpDir, ["a.mjs", "b.mjs"]);
    expect(stdout).toContain("Imports OK");
  });

  it("catches a missing named export", () => {
    writeFileSync(
      join(tmpDir, "a.mjs"),
      `import { missing } from "./b.mjs";\n`,
    );
    writeFileSync(
      join(tmpDir, "b.mjs"),
      `export function present() {}\n`,
    );

    const { exitCode, stderr } = runExpectFail(tmpDir, ["a.mjs", "b.mjs"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing");
    expect(stderr).toContain("Import validation failed");
  });

  it("passes for default imports", () => {
    writeFileSync(
      join(tmpDir, "a.mjs"),
      `import val from "./b.mjs";\nconsole.log(val);\n`,
    );
    writeFileSync(
      join(tmpDir, "b.mjs"),
      `export default 42;\n`,
    );

    const stdout = run(tmpDir, ["a.mjs", "b.mjs"]);
    expect(stdout).toContain("Imports OK");
  });

  it("catches a missing default export", () => {
    writeFileSync(
      join(tmpDir, "a.mjs"),
      `import val from "./b.mjs";\n`,
    );
    writeFileSync(
      join(tmpDir, "b.mjs"),
      `export function foo() {}\n`,
    );

    const { exitCode, stderr } = runExpectFail(tmpDir, ["a.mjs", "b.mjs"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("default");
  });

  it("passes for namespace imports (no name checking)", () => {
    writeFileSync(
      join(tmpDir, "a.mjs"),
      `import * as ns from "./b.mjs";\nconsole.log(ns);\n`,
    );
    writeFileSync(
      join(tmpDir, "b.mjs"),
      `export function foo() {}\n`,
    );

    const stdout = run(tmpDir, ["a.mjs", "b.mjs"]);
    expect(stdout).toContain("Imports OK");
  });

  it("passes for re-exports (export * from)", () => {
    writeFileSync(
      join(tmpDir, "a.mjs"),
      `import { deep } from "./b.mjs";\nconsole.log(deep);\n`,
    );
    writeFileSync(
      join(tmpDir, "b.mjs"),
      `export * from "./c.mjs";\n`,
    );
    writeFileSync(
      join(tmpDir, "c.mjs"),
      `export function deep() {}\n`,
    );

    const stdout = run(tmpDir, ["a.mjs", "b.mjs", "c.mjs"]);
    expect(stdout).toContain("Imports OK");
  });

  it("handles subdirectory imports", () => {
    mkdirSync(join(tmpDir, "sub"));
    writeFileSync(
      join(tmpDir, "a.mjs"),
      `import { helper } from "./sub/b.mjs";\nconsole.log(helper);\n`,
    );
    writeFileSync(
      join(tmpDir, "sub", "b.mjs"),
      `export const helper = 1;\n`,
    );

    const stdout = run(tmpDir, ["a.mjs", "sub/b.mjs"]);
    expect(stdout).toContain("Imports OK");
  });

  it("handles node: builtin imports without error", () => {
    writeFileSync(
      join(tmpDir, "a.mjs"),
      `import { readFileSync } from "node:fs";\nimport { resolve } from "node:path";\nconsole.log(readFileSync, resolve);\n`,
    );

    const stdout = run(tmpDir, ["a.mjs"]);
    expect(stdout).toContain("Imports OK");
  });

  it("reports the correct file path in errors", () => {
    mkdirSync(join(tmpDir, "task"));
    mkdirSync(join(tmpDir, "infra"));
    writeFileSync(
      join(tmpDir, "task", "executor.mjs"),
      `import { nonExistent } from "../infra/tracing.mjs";\n`,
    );
    writeFileSync(
      join(tmpDir, "infra", "tracing.mjs"),
      `export function addSpanEvent() {}\n`,
    );

    const { exitCode, stderr } = runExpectFail(tmpDir, [
      "task/executor.mjs",
      "infra/tracing.mjs",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("task");
    expect(stderr).toContain("nonExistent");
  });

  it("reports syntax errors in imported modules directly", () => {
    mkdirSync(join(tmpDir, "workspace"));
    writeFileSync(
      join(tmpDir, "entry.mjs"),
      `import { helper } from "./workspace/broken.mjs";\nconsole.log(helper);\n`,
    );
    writeFileSync(
      join(tmpDir, "workspace", "broken.mjs"),
      `export const helper = ;\n`,
    );

    const { exitCode, stderr } = runExpectFail(tmpDir, ["entry.mjs", "workspace/broken.mjs"]);
    expect(exitCode).toBe(1);
    expect(stderr.replaceAll("\\", "/")).toContain("workspace/broken.mjs");
    expect(stderr).toContain("Syntax error");
    expect(stderr).not.toContain("does not provide an export");
  });
});
