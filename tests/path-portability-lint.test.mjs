import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

const TOOL = resolve("scripts", "lint-path-portability.mjs");

function runLint(rootDir, args = []) {
  return execFileSync(
    process.execPath,
    [TOOL, "--root", rootDir, ...args],
    { encoding: "utf8", cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
  );
}

function runLintExpectFail(rootDir, args = []) {
  try {
    return { exitCode: 0, stdout: runLint(rootDir, args), stderr: "" };
  } catch (err) {
    return { exitCode: err.status, stdout: err.stdout, stderr: err.stderr };
  }
}

describe("lint-path-portability", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "path-portability-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports structured findings and fails on error severity", () => {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(
      join(tmpDir, "src", "bad.mjs"),
      [
        "const windowsPath = \"C:\\\\temp\\\\project\";",
        "const unixPath = \"/var/tmp/project\";",
        "const derived = __dirname + \"/child\";",
        "const cwdDerived = process.cwd() + \"/child\";",
        "",
      ].join("\n"),
    );

    const result = runLintExpectFail(tmpDir, ["--json"]);
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.summary.errors).toBeGreaterThan(0);
    expect(parsed.findings.map((finding) => finding.patternType)).toEqual(
      expect.arrayContaining([
        "raw-backslash-separator",
        "absolute-unix-path",
        "path-concatenation",
      ]),
    );
    expect(parsed.findings[0]).toEqual(
      expect.objectContaining({
        file: "src/bad.mjs",
        line: expect.any(Number),
        severity: expect.stringMatching(/error|warning/),
      }),
    );
  });

  it("supports allowlist suppression for specific findings", () => {
    mkdirSync(join(tmpDir, "tests", "fixtures"), { recursive: true });
    writeFileSync(
      join(tmpDir, "tests", "fixtures", "fixture.mjs"),
      "const fixturePath = \"/var/tmp/project\";\n",
    );

    const stdout = runLint(tmpDir, ["--json"]);
    const parsed = JSON.parse(stdout);
    expect(parsed.findings).toEqual([]);
  });
});
