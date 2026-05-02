import { describe, it, expect, vi } from "vitest";

/**
 * Tests for container-runner.mjs
 *
 * Note: ESM modules are cached — env vars are read at module load time.
 * These tests run with default state (CONTAINER_ENABLED not set → disabled).
 */

describe("container-runner", () => {
  describe("module exports", () => {
    it("exports all expected functions", async () => {
      const mod = await import("../infra/container-runner.mjs");
      const expected = [
        "buildIsolatedArtifactRoot",
        "formatArtifactRetrieveCommand",
        "isContainerEnabled",
        "getContainerStatus",
        "checkContainerRuntime",
        "ensureContainerRuntime",
        "runInContainer",
        "stopAllContainers",
        "cleanupOrphanedContainers",
        "isIsolatedRunnerPoolEnabled",
        "getIsolatedRunnerPoolStatus",
        "acquireRunnerLease",
        "releaseRunnerLease",
        "runInIsolatedRunner",
      ];
      for (const name of expected) {
        expect(typeof mod[name]).toBe("function");
      }
    });
  });

  describe("isContainerEnabled (default disabled)", () => {
    it("returns false when CONTAINER_ENABLED is not set", async () => {
      const mod = await import("../infra/container-runner.mjs");
      expect(mod.isContainerEnabled()).toBe(false);
    });
  });

  describe("getContainerStatus", () => {
    it("returns status object with expected structure", async () => {
      const mod = await import("../infra/container-runner.mjs");
      const status = mod.getContainerStatus();
      expect(status).toBeDefined();
      expect(typeof status.enabled).toBe("boolean");
      expect(status.enabled).toBe(false); // default not enabled
    });

    it("has runtime property", async () => {
      const mod = await import("../infra/container-runner.mjs");
      const status = mod.getContainerStatus();
      expect("runtime" in status).toBe(true);
    });

    it("has active property", async () => {
      const mod = await import("../infra/container-runner.mjs");
      const status = mod.getContainerStatus();
      expect(typeof status.active).toBe("number");
      expect(status.active).toBe(0);
    });

    it("has maxConcurrent property", async () => {
      const mod = await import("../infra/container-runner.mjs");
      const status = mod.getContainerStatus();
      expect("maxConcurrent" in status).toBe(true);
      expect(typeof status.maxConcurrent).toBe("number");
    });

    it("has containers array", async () => {
      const mod = await import("../infra/container-runner.mjs");
      const status = mod.getContainerStatus();
      expect(Array.isArray(status.containers)).toBe(true);
      expect(status.containers).toHaveLength(0);
    });
  });

  describe("checkContainerRuntime", () => {
    it("returns an object with available field", async () => {
      const mod = await import("../infra/container-runner.mjs");
      const result = mod.checkContainerRuntime();
      expect(result).toBeDefined();
      expect(typeof result).toBe("object");
      expect("available" in result).toBe(true);
      expect(typeof result.available).toBe("boolean");
    });

    it("returns runtime in result", async () => {
      const mod = await import("../infra/container-runner.mjs");
      const result = mod.checkContainerRuntime();
      expect("runtime" in result).toBe(true);
    });

    it("returns platform in result", async () => {
      const mod = await import("../infra/container-runner.mjs");
      const result = mod.checkContainerRuntime();
      expect("platform" in result).toBe(true);
      expect(result.platform).toBe(process.platform);
    });
  });

  describe("stopAllContainers", () => {
    it("resolves when no containers are running", async () => {
      const mod = await import("../infra/container-runner.mjs");
      // stopAllContainers should be safe to call at any time
      const result = mod.stopAllContainers();
      if (result instanceof Promise) {
        await expect(result).resolves.not.toThrow();
      }
      // If it's sync, the fact we didn't throw is sufficient
    });
  });

  describe("cleanupOrphanedContainers", () => {
    it("does not throw when no containers exist", async () => {
      const mod = await import("../infra/container-runner.mjs");
      // cleanupOrphanedContainers is synchronous and catches errors internally
      expect(() => mod.cleanupOrphanedContainers()).not.toThrow();
    });
  });

  describe("runInContainer", () => {
    it("rejects when container is disabled", async () => {
      const mod = await import("../infra/container-runner.mjs");
      // Should reject since containers are not enabled
      await expect(
        mod.runInContainer({
          command: "echo hello",
          workDir: "/tmp",
        }),
      ).rejects.toThrow();
    });
  });

  describe("source code structure", () => {
    it("defines sentinel markers for output parsing", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const dir = path.resolve(fileURLToPath(new URL(".", import.meta.url)));
      const source = fs.readFileSync(
        path.resolve(dir, "..", "infra/container-runner.mjs"),
        "utf8",
      );

      expect(source).toContain("CODEXMON_OUTPUT_START");
      expect(source).toContain("CODEXMON_OUTPUT_END");
    });

    it("supports docker, podman, and apple-container runtimes", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const dir = path.resolve(fileURLToPath(new URL(".", import.meta.url)));
      const source = fs.readFileSync(
        path.resolve(dir, "..", "infra/container-runner.mjs"),
        "utf8",
      );

      expect(source).toContain("docker");
      expect(source).toContain("podman");
      expect(source).toContain("container"); // apple-container
    });

    it("tracks active containers with Map", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const dir = path.resolve(fileURLToPath(new URL(".", import.meta.url)));
      const source = fs.readFileSync(
        path.resolve(dir, "..", "infra/container-runner.mjs"),
        "utf8",
      );

      expect(source).toContain("activeContainers");
      expect(source).toContain("new Map()");
    });

    it("builds shell-safe artifact retrieval commands on POSIX", async () => {
      const mod = await import("../infra/container-runner.mjs");

      expect(
        mod.formatArtifactRetrieveCommand("/tmp/a\\b\"c'd.txt", "linux"),
      ).toBe(`cat '/tmp/a\\b"c'"'"'d.txt'`);
    });

    it("anchors default isolated artifacts under the resolved repo root", async () => {
      const mod = await import("../infra/container-runner.mjs");
      const root = process.cwd();
      const staleCwd = "C:\\Users\\jON\\Documents\\source\\repos\\virtengine-gh\\bosun";
      expect(mod.buildIsolatedArtifactRoot(staleCwd)).toBe(
        await import("node:path").then((path) => path.resolve(root, ".bosun", "artifacts", "isolated-runs")),
      );
    });
  });
});

describe("isolated runner pool", () => {
  it("exposes enabled status and lease capacity", async () => {
    const mod = await import("../infra/container-runner.mjs");
    const status = mod.getIsolatedRunnerPoolStatus();
    expect(status.enabled).toBe(true);
    expect(status.maxConcurrent).toBeGreaterThan(0);
  });

  it("persists artifacts for isolated runs", async () => {
    const mod = await import("../infra/container-runner.mjs");
    const result = await mod.runInIsolatedRunner({
      command: process.execPath,
      args: ["-e", "console.log('runner ok'); console.error('runner err')"],
      cwd: process.cwd(),
    });

    expect(result.status).toBe("success");
    expect(Array.isArray(result.artifacts)).toBe(true);
    expect(result.artifacts.some((artifact) => /stdout\.log$/i.test(artifact.path))).toBe(true);
    expect(result.artifacts.some((artifact) => /metadata\.json$/i.test(artifact.path))).toBe(true);
  });

  it("surfaces blocked evidence when lease acquisition stays saturated", async () => {
    const mod = await import("../infra/container-runner.mjs");
    const heldLease = mod.acquireRunnerLease({ taskId: "held-lease" });
    const extraLeases = [];
    const target = mod.getIsolatedRunnerPoolStatus().maxConcurrent;
    for (let index = 1; index < target; index += 1) {
      const lease = mod.acquireRunnerLease({ taskId: `held-${index}` });
      if (lease) extraLeases.push(lease);
    }

    const result = await mod.runInIsolatedRunner({
      command: process.execPath,
      args: ["-e", "console.log('never runs')"],
      cwd: process.cwd(),
      maxAttempts: 1,
    });

    expect(result.blocked).toBe(true);
    expect(result.artifacts.some((artifact) => /metadata\.json$/i.test(artifact.path))).toBe(true);

    mod.releaseRunnerLease(heldLease);
    for (const lease of extraLeases) mod.releaseRunnerLease(lease);
  });

  it("classifies command exit failures with stable diagnostics", async () => {
    const mod = await import("../infra/container-runner.mjs");
    const result = await mod.runInIsolatedRunner({
      command: process.execPath,
      args: ["-e", "console.error('test command failed'); process.exit(2)"],
      cwd: process.cwd(),
    });

    expect(result.status).toBe("error");
    expect(result.failureDiagnostic).toMatchObject({
      category: "command_failure",
      retryable: false,
      exitCode: 2,
      status: "error",
    });
  });

  it("classifies execution timeouts as retryable failures", async () => {
    const mod = await import("../infra/container-runner.mjs");
    const result = await mod.runInIsolatedRunner({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 200)"],
      cwd: process.cwd(),
      timeoutMs: 25,
    });

    expect(result.status).toBe("timeout");
    expect(result.failureDiagnostic).toMatchObject({
      category: "timeout",
      retryable: true,
      status: "timeout",
    });
  });

  it("classifies sandbox-style permission errors as non-retryable", async () => {
    const mod = await import("../infra/container-runner.mjs");
    const result = await mod.runInIsolatedRunner({
      command: "sandbox-check",
      cwd: process.cwd(),
      execute: async () => ({
        status: "error",
        stdout: "",
        stderr: "Operation not permitted: sandbox denied write access",
        exitCode: 126,
        duration: 5,
      }),
    });

    expect(result.failureDiagnostic).toMatchObject({
      category: "sandbox_error",
      retryable: false,
      exitCode: 126,
    });
  });

  it("classifies runner startup failures as bootstrap failures", async () => {
    const mod = await import("../infra/container-runner.mjs");
    const result = await mod.runInIsolatedRunner({
      command: "missing-binary",
      cwd: process.cwd(),
      execute: async () => ({
        status: "error",
        stdout: "",
        stderr: "spawn missing-binary ENOENT",
        exitCode: -1,
        duration: 2,
      }),
    });

    expect(result.failureDiagnostic).toMatchObject({
      category: "bootstrap_failure",
      status: "error",
    });
  });
});
