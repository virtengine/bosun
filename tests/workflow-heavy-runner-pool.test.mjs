import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  detectHeavyRunnerIntent,
  resolveHeavyRunnerPolicy,
  runCommandInHeavyRunnerLease,
} from "../workflow/heavy-runner-pool.mjs";

describe("heavy runner pool policy", () => {
  it("routes heavyweight validation to the isolated runner pool", () => {
    const testPolicy = resolveHeavyRunnerPolicy({
      nodeType: "validation.tests",
      command: "npm test",
      timeoutMs: 600000,
    });
    const buildPolicy = resolveHeavyRunnerPolicy({
      nodeType: "validation.build",
      command: "npm run build",
      timeoutMs: 600000,
    });
    const lintPolicy = resolveHeavyRunnerPolicy({
      nodeType: "validation.lint",
      command: "npm run lint",
      timeoutMs: 120000,
    });

    expect(testPolicy.lane).toBe("runner-pool");
    expect(buildPolicy.lane).toBe("runner-pool");
    expect(lintPolicy.lane).toBe("main");
  });

  it("detects heavyweight diff and pre-push intents", () => {
    expect(detectHeavyRunnerIntent("git diff --stat HEAD~1")).toBe("diff");
    expect(detectHeavyRunnerIntent("pwsh -File .githooks/pre-push")).toBe("pre-push");
  });
});

describe("heavy runner pool leases", () => {
  let tempDir = "";

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it("captures stdout/stderr artifacts for isolated runs", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bosun-heavy-runner-"));
    const result = await runCommandInHeavyRunnerLease({
      command: 'node -e "console.log(\'stdout-line\'); console.error(\'stderr-line\');"',
      cwd: tempDir,
      intent: "test",
      timeoutMs: 15000,
      artifactRoot: join(tempDir, ".artifacts"),
      runtime: "local-process",
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.lease.runtime).toBe("local-process");
    expect(result.artifactPointers.some((pointer) => pointer.kind === "stdout")).toBe(true);
    expect(result.artifactPointers.some((pointer) => pointer.kind === "stderr")).toBe(true);

    const stdoutArtifact = result.artifactPointers.find((pointer) => pointer.kind === "stdout");
    const stderrArtifact = result.artifactPointers.find((pointer) => pointer.kind === "stderr");

    expect(existsSync(stdoutArtifact.path)).toBe(true);
    expect(existsSync(stderrArtifact.path)).toBe(true);
    expect(readFileSync(stdoutArtifact.path, "utf8")).toContain("stdout-line");
    expect(readFileSync(stderrArtifact.path, "utf8")).toContain("stderr-line");
  });

  it("resolves Windows command shims for local-process leases", async () => {
    if (process.platform !== "win32") return;
    tempDir = mkdtempSync(join(tmpdir(), "bosun-heavy-runner-win-"));
    const result = await runCommandInHeavyRunnerLease({
      command: "npm --version",
      cwd: tempDir,
      intent: "build",
      timeoutMs: 15000,
      artifactRoot: join(tempDir, ".artifacts"),
      runtime: "local-process",
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(String(result.stdout || "")).toMatch(/\d+\.\d+\.\d+/);
  }, 20000);

  it("retries lease acquisition failures and surfaces blocked evidence", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "bosun-heavy-runner-fail-"));
    const result = await runCommandInHeavyRunnerLease({
      command: 'node -e "console.log(1)"',
      cwd: tempDir,
      intent: "build",
      timeoutMs: 15000,
      artifactRoot: join(tempDir, ".artifacts"),
      runtime: "remote-sandbox",
      retries: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.failureKind).toBe("runner_lease_failed");
    expect(result.attempts).toBe(2);
    expect(result.lease.status).toBe("blocked");
    expect(result.blockedEvidence.summary).toContain("remote-sandbox");
  });
});
