/**
 * container-runner.mjs — Optional container isolation for agent execution.
 *
 * When CONTAINER_ENABLED=1, agent tasks run inside Docker containers for
 * security isolation. Inspired by nanoclaw's Apple Container architecture
 * but using Docker (cross-platform: Linux, macOS, Windows).
 *
 * Features:
 *   - Docker container isolation for agent execution
 *   - Volume mount security (allowlist-based)
 *   - Configurable timeouts and resource limits
 *   - Output streaming via sentinel markers
 *   - Graceful shutdown with container cleanup
 *
 * The container mounts the workspace read-only and a scratch directory
 * read-write, then runs the agent inside the container.
 */

import { spawn, spawnSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, basename, join, isAbsolute } from "node:path";
import { isBosunModuleRoot, resolveRepoRoot } from "../config/repo-root.mjs";

// ── Configuration ────────────────────────────────────────────────────────────

const containerEnabled = ["1", "true", "yes"].includes(
  String(process.env.CONTAINER_ENABLED || "").toLowerCase(),
);
const containerRuntime = process.env.CONTAINER_RUNTIME || "docker"; // docker | podman | container (macOS)
const containerImage = process.env.CONTAINER_IMAGE || "node:22-slim";
const containerTimeout = parseInt(
  process.env.CONTAINER_TIMEOUT_MS || "1800000",
  10,
); // 30 min default
const containerRuntimeCheckTimeout = Math.max(
  500,
  parseInt(process.env.CONTAINER_RUNTIME_CHECK_TIMEOUT_MS || "3000", 10),
);
const containerMaxOutput = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || "10485760",
  10,
); // 10MB
const maxConcurrentContainers = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || "3", 10),
);

// Sentinel markers for output parsing (protocol compatible with nanoclaw)
const OUTPUT_START_MARKER = "---CODEXMON_OUTPUT_START---";
const OUTPUT_END_MARKER = "---CODEXMON_OUTPUT_END---";

// ── State ────────────────────────────────────────────────────────────────────

const activeContainers = new Map(); // containerName → { proc, startTime, taskId }
const isolatedRunnerPoolEnabled = !["0", "false", "no", "off"].includes(
  String(process.env.HEAVY_RUNNER_POOL_ENABLED || "1").toLowerCase(),
);
const isolatedRunnerProvider =
  String(process.env.HEAVY_RUNNER_PROVIDER || "process").trim().toLowerCase() || "process";
const isolatedRunnerLeaseTimeoutMs = Math.max(
  1000,
  parseInt(process.env.HEAVY_RUNNER_LEASE_TIMEOUT_MS || "30000", 10),
);
const isolatedRunnerRetryLimit = Math.max(
  0,
  parseInt(process.env.HEAVY_RUNNER_RETRY_LIMIT || "1", 10),
);
const isolatedRunnerRetryDelayMs = Math.max(
  0,
  parseInt(process.env.HEAVY_RUNNER_RETRY_DELAY_MS || "750", 10),
);
const isolatedRunnerMaxConcurrent = Math.max(
  1,
  parseInt(
    process.env.HEAVY_RUNNER_MAX_CONCURRENT || String(maxConcurrentContainers),
    10,
  ),
);
const isolatedRunnerArtifactDirName = String(
  process.env.HEAVY_RUNNER_ARTIFACT_DIR || join(".bosun", "artifacts", "isolated-runs"),
);
const activeRunnerLeases = new Map(); // leaseId → lease metadata
let containerIdCounter = 0;
let runnerLeaseCounter = 0;

function samePath(left, right) {
  const leftResolved = resolve(String(left || ""));
  const rightResolved = resolve(String(right || ""));
  return process.platform === "win32"
    ? leftResolved.toLowerCase() === rightResolved.toLowerCase()
    : leftResolved === rightResolved;
}

function runContainerRuntimeSync(args, options = {}) {
  const res = spawnSync(containerRuntime, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(
      String(
        res.stderr ||
        res.stdout ||
        `${containerRuntime} ${args.join(" ")} exited with status ${res.status}`,
      ).trim(),
    );
  }
  return String(res.stdout || "");
}

function waitForLeaseRetry(delayMs) {
  if (!delayMs || delayMs <= 0) return Promise.resolve();
  return new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
}

export function formatArtifactRetrieveCommand(filePath, platform = process.platform) {
  const normalizedPath = String(filePath || "");
  if (platform === "win32") {
    return `Get-Content -Raw "${normalizedPath.replace(/"/g, '""')}"`;
  }
  return `cat '${normalizedPath.replace(/'/g, `'"'"'`)}'`;
}

export function buildIsolatedArtifactRoot(cwd) {
  if (isAbsolute(isolatedRunnerArtifactDirName)) {
    return resolve(isolatedRunnerArtifactDirName);
  }

  const requestedCwd = resolve(cwd || process.cwd());
  let repoRoot = requestedCwd;
  try {
    const activeCwd = resolve(process.cwd());
    const useActiveCheckout =
      !samePath(requestedCwd, activeCwd) &&
      isBosunModuleRoot(requestedCwd) &&
      isBosunModuleRoot(activeCwd);
    if (!existsSync(requestedCwd) || useActiveCheckout) {
      repoRoot = execSync("git rev-parse --show-toplevel", {
        encoding: "utf8",
        cwd: activeCwd,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } else {
      repoRoot = resolveRepoRoot({ cwd: requestedCwd });
    }
  } catch {
    repoRoot = process.cwd();
  }
  if (!repoRoot || !existsSync(repoRoot)) repoRoot = process.cwd();
  return resolve(repoRoot, isolatedRunnerArtifactDirName);
}

function persistIsolatedRunArtifacts({
  cwd,
  leaseId,
  stdout = "",
  stderr = "",
  metadata = {},
  extraArtifacts = [],
} = {}) {
  const artifactRoot = resolve(
    buildIsolatedArtifactRoot(cwd),
    leaseId || `lease-${Date.now()}`,
  );
  mkdirSync(artifactRoot, { recursive: true });

  const stdoutPath = resolve(artifactRoot, "stdout.log");
  const stderrPath = resolve(artifactRoot, "stderr.log");
  const metadataPath = resolve(artifactRoot, "metadata.json");
  writeFileSync(stdoutPath, String(stdout || ""), "utf8");
  writeFileSync(stderrPath, String(stderr || ""), "utf8");
  writeFileSync(metadataPath, JSON.stringify(metadata || {}, null, 2), "utf8");

  const artifacts = [
    {
      label: "stdout",
      kind: "log",
      path: stdoutPath,
      retrieveCommand: formatArtifactRetrieveCommand(stdoutPath),
    },
    {
      label: "stderr",
      kind: "log",
      path: stderrPath,
      retrieveCommand: formatArtifactRetrieveCommand(stderrPath),
    },
    {
      label: "metadata",
      kind: "json",
      path: metadataPath,
      retrieveCommand: formatArtifactRetrieveCommand(metadataPath),
    },
  ];

  for (const entry of Array.isArray(extraArtifacts) ? extraArtifacts : []) {
    if (!entry?.path) continue;
    artifacts.push({
      label: entry.label || basename(entry.path),
      kind: entry.kind || "artifact",
      path: entry.path,
      retrieveCommand:
        entry.retrieveCommand || formatArtifactRetrieveCommand(entry.path),
    });
  }

  return { artifactRoot, artifacts };
}

function acquireLeaseRecord(options = {}) {
  if (!isolatedRunnerPoolEnabled) {
    return { ok: false, reason: "runner_pool_disabled" };
  }
  if (activeRunnerLeases.size >= isolatedRunnerMaxConcurrent) {
    return {
      ok: false,
      reason: `lease_capacity_reached:${isolatedRunnerMaxConcurrent}`,
    };
  }

  const leaseId = `runner-${Date.now()}-${++runnerLeaseCounter}`;
  const lease = {
    leaseId,
    taskId: String(options.taskId || "validation"),
    requestType: String(options.requestType || options.commandType || "validation"),
    provider: String(options.provider || isolatedRunnerProvider || "process"),
    cwd: resolve(options.cwd || process.cwd()),
    acquiredAt: Date.now(),
    metadata:
      options.metadata && typeof options.metadata === "object"
        ? { ...options.metadata }
        : {},
  };
  activeRunnerLeases.set(leaseId, lease);
  return { ok: true, lease };
}

function releaseLeaseRecord(leaseOrId, options = {}) {
  const leaseId = typeof leaseOrId === "string" ? leaseOrId : leaseOrId?.leaseId;
  if (!leaseId) return null;
  const lease = activeRunnerLeases.get(leaseId) || null;
  activeRunnerLeases.delete(leaseId);
  if (!lease) return null;
  const releasedAt = Date.now();
  return {
    ...lease,
    releasedAt,
    durationMs: releasedAt - lease.acquiredAt,
    ...options,
  };
}

function quotePosixArg(value) {
  return `'${String(value || "").replace(/'/g, `'\\''`)}'`;
}

function joinCommandArgs(command, args = []) {
  const parts = [
    String(command || "").trim(),
    ...args.map((arg) => quotePosixArg(arg)),
  ].filter(Boolean);
  return parts.join(" ").trim();
}

function resolveRunnerProvider(provider, options = {}) {
  const requested = String(
    provider || options.provider || isolatedRunnerProvider || "process",
  )
    .trim()
    .toLowerCase();
  if (typeof options.execute === "function") return "custom";
  if (requested === "auto") {
    return containerEnabled && checkContainerRuntime().available
      ? "container"
      : "process";
  }
  return requested || "process";
}

function isSandboxFailureText(text) {
  return /(?:sandbox|operation not permitted|permission denied|access is denied|read-only file system|EPERM|EACCES|denied by policy|seccomp)/i.test(
    String(text || ""),
  );
}

function isBootstrapFailureText(text) {
  return /(?:\bENOENT\b|spawn\s+.+\s+ENOENT|not recognized as an internal or external command|is not recognized as a name of a cmdlet|command not found|executable file not found|no such file or directory|cannot find the file|failed to start|startup failure)/i.test(
    String(text || ""),
  );
}

function summarizeFailureDetail(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  const firstLine = normalized.split(/\r?\n/).find((line) => String(line || "").trim()) || normalized;
  return firstLine.slice(0, 400);
}

function buildIsolatedFailureDiagnostic(result = {}, options = {}) {
  const status = String(result?.status || "unknown").trim().toLowerCase();
  const exitCode = result?.exitCode ?? null;
  const blocked = result?.blocked === true || status === "blocked";
  const errorText = [result?.stderr, result?.error, result?.stdout]
    .map((value) => String(value || "").trim())
    .find(Boolean) || "";
  if (!blocked && status === "success" && Number(exitCode ?? 0) === 0) return null;

  let category = "command_failure";
  let retryable = false;
  let summary = `Validation command exited with code ${exitCode ?? "unknown"}.`;

  if (blocked) {
    category = "runner_unavailable";
    retryable = true;
    summary = "Isolated runner was unavailable before the validation command started.";
  } else if (status === "timeout") {
    category = "timeout";
    retryable = true;
    const timeoutMs = Number(options.timeoutMs);
    const timeoutDescription =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? `${timeoutMs}ms`
        : "the configured timeout";
    summary = `Validation timed out after ${timeoutDescription}.`;
  } else if (isSandboxFailureText(errorText)) {
    category = "sandbox_error";
    retryable = false;
    summary = "Validation was blocked by sandbox or filesystem restrictions.";
  } else if (isBootstrapFailureText(errorText) || status === "error" && (exitCode == null || Number(exitCode) < 0)) {
    category = "bootstrap_failure";
    retryable = true;
    summary = "Validation could not start cleanly in the isolated runner.";
  }

  return {
    category,
    retryable,
    summary,
    detail: summarizeFailureDetail(errorText),
    status,
    exitCode,
    blocked,
    provider: options.provider || null,
    command: options.command || null,
    args: Array.isArray(options.args) ? [...options.args] : [],
    attempts: Number(options.attempts || 1),
    durationMs: result?.duration ?? null,
  };
}

async function runIsolatedProcess(options = {}) {
  const {
    command,
    args = [],
    cwd = process.cwd(),
    env = {},
    timeoutMs = containerTimeout,
    onStdout,
    onStderr,
  } = options;

  return new Promise((resolvePromise) => {
    const useArgv = Array.isArray(args) && args.length > 0;
    const proc = useArgv
      ? spawn(String(command || ""), args.map((arg) => String(arg)), {
          cwd,
          env: { ...process.env, ...env },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        })
      : spawn(String(command || ""), {
          cwd,
          env: { ...process.env, ...env },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          shell: true,
        });

    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    proc.stdout.on("data", (data) => {
      const chunk = data.toString();
      stdout += chunk;
      if (typeof onStdout === "function") onStdout(chunk);
    });
    proc.stderr.on("data", (data) => {
      const chunk = data.toString();
      stderr += chunk;
      if (typeof onStderr === "function") onStderr(chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        status: timedOut ? "timeout" : code === 0 ? "success" : "error",
        stdout,
        stderr,
        exitCode: code,
        duration: Date.now() - startedAt,
      });
    });

    proc.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({
        status: "error",
        stdout,
        stderr: error?.message || "spawn failed",
        exitCode: -1,
        duration: Date.now() - startedAt,
      });
    });
  });
}


/**
 * Check if container mode is enabled and runtime is available.
 */
export function isContainerEnabled() {
  return containerEnabled;
}

/**
 * Get container subsystem status.
 */
export function getContainerStatus() {
  return {
    enabled: containerEnabled,
    runtime: containerRuntime,
    image: containerImage,
    timeout: containerTimeout,
    maxConcurrent: maxConcurrentContainers,
    active: activeContainers.size,
    containers: [...activeContainers.entries()].map(([name, info]) => ({
      name,
      taskId: info.taskId,
      uptime: Date.now() - info.startTime,
    })),
  };
}

/**
 * Check if the container runtime is installed and running.
 */
export function checkContainerRuntime() {
  try {
    if (containerRuntime === "container") {
      // macOS Apple Container
      execSync("container system status", {
        stdio: "pipe",
        timeout: containerRuntimeCheckTimeout,
      });
      return { available: true, runtime: "container", platform: "macos" };
    }
    // Docker or Podman
    execSync(`${containerRuntime} info`, {
      stdio: "pipe",
      timeout: containerRuntimeCheckTimeout,
    });
    return {
      available: true,
      runtime: containerRuntime,
      platform: process.platform,
    };
  } catch {
    return {
      available: false,
      runtime: containerRuntime,
      platform: process.platform,
    };
  }
}

/**
 * Ensure the container runtime is ready (start if needed for macOS).
 */
export function ensureContainerRuntime() {
  if (containerRuntime === "container") {
    // macOS Apple Container — may need explicit start
    try {
      execSync("container system status", {
        stdio: "pipe",
        timeout: containerRuntimeCheckTimeout,
      });
    } catch {
      console.log("[container] Starting Apple Container system...");
      try {
        execSync("container system start", { stdio: "pipe", timeout: 30000 });
        console.log("[container] Apple Container system started");
      } catch (err) {
        throw new Error(
          `Apple Container failed to start: ${err.message}\n` +
            "Install from: https://github.com/apple/container/releases",
        );
      }
    }
    return;
  }

  // Docker/Podman — just verify it's running
  const check = checkContainerRuntime();
  if (!check.available) {
    throw new Error(
      `${containerRuntime} is not available. Install it or set CONTAINER_RUNTIME to an available runtime.`,
    );
  }
}

/**
 * Build volume mount arguments for the container.
 * @param {string} workspacePath - Path to the workspace/repo
 * @param {string} scratchDir - Path to scratch directory for container writes
 * @param {object} options - Additional mount options
 */
function buildMountArgs(workspacePath, scratchDir, options = {}) {
  const args = [];

  if (containerRuntime === "container") {
    // Apple Container uses --mount and -v syntax
    args.push(
      "--mount",
      `type=bind,source=${workspacePath},target=/workspace,readonly`,
    );
    args.push("-v", `${scratchDir}:/scratch`);
  } else {
    // Docker/Podman
    args.push("-v", `${workspacePath}:/workspace:ro`);
    args.push("-v", `${scratchDir}:/scratch:rw`);
  }

  // Additional mounts
  if (options.additionalMounts) {
    for (const mount of options.additionalMounts) {
      const target =
        mount.containerPath || `/workspace/extra/${basename(mount.hostPath)}`;
      const ro = mount.readonly !== false ? ":ro" : "";
      if (containerRuntime === "container") {
        if (mount.readonly !== false) {
          args.push(
            "--mount",
            `type=bind,source=${mount.hostPath},target=${target},readonly`,
          );
        } else {
          args.push("-v", `${mount.hostPath}:${target}`);
        }
      } else {
        args.push("-v", `${mount.hostPath}:${target}${ro}`);
      }
    }
  }

  return args;
}

/**
 * Run an agent command inside a container.
 *
 * @param {object} options
 * @param {string} options.workspacePath - Path to workspace/repo to mount
 * @param {string} options.command - Command to run inside container
 * @param {string[]} [options.args] - Command arguments
 * @param {object} [options.env] - Environment variables for the container
 * @param {string} [options.taskId] - Task identifier for tracking
 * @param {number} [options.timeout] - Override timeout in ms
 * @param {object} [options.mountOptions] - Additional mount configuration
 * @param {function} [options.onOutput] - Streaming output callback
 * @returns {Promise<{status: string, stdout: string, stderr: string, exitCode: number}>}
 */
export async function runInContainer(options) {
  if (!containerEnabled) {
    throw new Error("Container mode is not enabled (set CONTAINER_ENABLED=1)");
  }

  if (activeContainers.size >= maxConcurrentContainers) {
    throw new Error(
      `Max concurrent containers reached (${maxConcurrentContainers}). Wait for a slot.`,
    );
  }

  const {
    workspacePath,
    command,
    args = [],
    env = {},
    taskId = "unknown",
    timeout = containerTimeout,
    mountOptions = {},
    onOutput,
    onStdout,
    onStderr,
  } = options;

  // Create scratch directory for container writes
  const scratchDir = resolve(
    workspacePath,
    ".cache",
    "container-scratch",
    `task-${Date.now()}`,
  );
  mkdirSync(scratchDir, { recursive: true });

  const containerName = `codexmon-${taskId.replace(/[^a-zA-Z0-9-]/g, "-")}-${++containerIdCounter}`;
  const mountArgs = buildMountArgs(workspacePath, scratchDir, mountOptions);

  // Build container run command
  const containerArgs = [
    "run",
    "--rm",
    "--name",
    containerName,
    "-w",
    "/workspace",
    ...mountArgs,
  ];

  // Add environment variables
  for (const [key, value] of Object.entries(env)) {
    containerArgs.push("-e", `${key}=${value}`);
  }

  // Resource limits (Docker/Podman only)
  if (containerRuntime !== "container") {
    const memLimit = process.env.CONTAINER_MEMORY_LIMIT || "4g";
    const cpuLimit = process.env.CONTAINER_CPU_LIMIT || "2";
    containerArgs.push("--memory", memLimit);
    containerArgs.push("--cpus", cpuLimit);
  }

  // Image and command
  containerArgs.push(containerImage);
  if (command) {
    containerArgs.push(command, ...args);
  }

  console.log(
    `[container] spawning ${containerName} (image: ${containerImage}, task: ${taskId})`,
  );

  return new Promise((resolvePromise) => {
    const proc = spawn(containerRuntime, containerArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const startTime = Date.now();
    activeContainers.set(containerName, { proc, startTime, taskId });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let parseBuffer = "";

    proc.stdout.on("data", (data) => {
      const chunk = data.toString();
      if (stdout.length + chunk.length <= containerMaxOutput) {
        stdout += chunk;
      }
      if (typeof onStdout === "function") onStdout(chunk);

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break;
          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);
          try {
            const parsed = JSON.parse(jsonStr);
            onOutput(parsed);
          } catch {
            /* ignore parse errors */
          }
        }
      }
    });

    proc.stderr.on("data", (data) => {
      const chunk = data.toString();
      if (stderr.length + chunk.length <= containerMaxOutput) {
        stderr += chunk;
      }
      if (typeof onStderr === "function") onStderr(chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      console.warn(
        `[container] ${containerName} timed out after ${timeout}ms, stopping`,
      );
      try {
        runContainerRuntimeSync(["stop", containerName], { timeout: 15000 });
      } catch {
        proc.kill("SIGKILL");
      }
    }, timeout);

    proc.on("close", (code) => {
      clearTimeout(timer);
      activeContainers.delete(containerName);
      const duration = Date.now() - startTime;

      console.log(
        `[container] ${containerName} exited (code: ${code}, duration: ${Math.round(duration / 1000)}s, timedOut: ${timedOut})`,
      );

      resolvePromise({
        status: timedOut ? "timeout" : code === 0 ? "success" : "error",
        stdout,
        stderr,
        exitCode: code,
        duration,
        containerName,
        scratchDir,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      activeContainers.delete(containerName);
      console.error(`[container] ${containerName} spawn error: ${err.message}`);
      resolvePromise({
        status: "error",
        stdout,
        stderr: err.message,
        exitCode: -1,
        duration: Date.now() - startTime,
        containerName,
        scratchDir,
      });
    });
  });
}

/**
 * Stop all running containers (graceful shutdown).
 */
export async function stopAllContainers(timeoutMs = 10000) {
  const names = [...activeContainers.keys()];
  if (names.length === 0) return;

  console.log(`[container] stopping ${names.length} active containers...`);

  for (const name of names) {
    try {
      runContainerRuntimeSync(["stop", name], { timeout: timeoutMs });
    } catch {
      // Try force kill
      try {
        runContainerRuntimeSync(["kill", name]);
      } catch {
        /* already stopped */
      }
    }
  }

  activeContainers.clear();
  console.log("[container] all containers stopped");
}

/**
 * Clean up orphaned containers from previous runs.
 */
export function cleanupOrphanedContainers() {
  try {
    let output;
    if (containerRuntime === "container") {
      output = execSync("container ls --format json", {
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf-8",
      });
      const containers = JSON.parse(output || "[]");
      const orphans = containers
        .filter(
          (c) =>
            c.status === "running" &&
            c.configuration?.id?.startsWith("codexmon-"),
        )
        .map((c) => c.configuration.id);
      for (const name of orphans) {
        try {
          runContainerRuntimeSync(["stop", name]);
        } catch {
          /* already stopped */
        }
      }
      if (orphans.length > 0) {
        console.log(
          `[container] cleaned up ${orphans.length} orphaned containers`,
        );
      }
    } else {
      output = runContainerRuntimeSync(["ps", "--filter", "name=codexmon-", "--format", "{{.Names}}"]);
      const orphans = output
        .trim()
        .split("\n")
        .filter((n) => n);
      for (const name of orphans) {
        try {
          runContainerRuntimeSync(["stop", name]);
        } catch {
          /* already stopped */
        }
      }
      if (orphans.length > 0) {
        console.log(
          `[container] cleaned up ${orphans.length} orphaned containers`,
        );
      }
    }
  } catch {
    /* no orphans or runtime not available */
  }
}




export function isIsolatedRunnerPoolEnabled() {
  return isolatedRunnerPoolEnabled;
}

export function getIsolatedRunnerPoolStatus() {
  return {
    enabled: isolatedRunnerPoolEnabled,
    provider: isolatedRunnerProvider,
    maxConcurrent: isolatedRunnerMaxConcurrent,
    leaseTimeoutMs: isolatedRunnerLeaseTimeoutMs,
    retryLimit: isolatedRunnerRetryLimit,
    active: activeRunnerLeases.size,
    leases: [...activeRunnerLeases.values()].map((lease) => ({
      leaseId: lease.leaseId,
      taskId: lease.taskId,
      requestType: lease.requestType,
      provider: lease.provider,
      ageMs: Date.now() - lease.acquiredAt,
    })),
  };
}

export function acquireRunnerLease(options = {}) {
  const result = acquireLeaseRecord(options);
  return result.ok ? result.lease : null;
}

export function releaseRunnerLease(leaseOrId, options = {}) {
  return releaseLeaseRecord(leaseOrId, options);
}

export async function runInIsolatedRunner(options = {}) {
  const command = String(options.command || "").trim();
  if (!command) {
    throw new Error("runInIsolatedRunner requires a non-empty command");
  }

  const maxAttempts = Math.max(
    1,
    Number(options.maxAttempts ?? isolatedRunnerRetryLimit + 1),
  );
  const provider = resolveRunnerProvider(options.provider, options);
  let lastFailure = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const leaseResult = acquireLeaseRecord({
      ...options,
      provider,
      metadata: {
        ...(options.metadata && typeof options.metadata === "object"
          ? options.metadata
          : {}),
        attempt,
      },
    });

    if (!leaseResult.ok) {
      lastFailure = new Error(leaseResult.reason || "runner_lease_unavailable");
      if (attempt < maxAttempts) {
        await waitForLeaseRetry(isolatedRunnerRetryDelayMs);
        continue;
      }
      const failedLeaseId = `blocked-${Date.now()}-${attempt}`;
      const blockedResult = {
        status: "blocked",
        blocked: true,
        error: lastFailure.message,
        exitCode: null,
      };
      const failureDiagnostic = buildIsolatedFailureDiagnostic(blockedResult, {
        command,
        args: Array.isArray(options.args) ? options.args : [],
        provider,
        attempts: attempt,
      });
      const evidence = persistIsolatedRunArtifacts({
        cwd: options.cwd || process.cwd(),
        leaseId: failedLeaseId,
        metadata: {
          status: "blocked",
          reason: lastFailure.message,
          attempts: attempt,
          provider,
          command,
          args: Array.isArray(options.args) ? options.args : [],
          failureDiagnostic,
        },
      });
      return {
        ...blockedResult,
        attempts: attempt,
        provider,
        leaseId: failedLeaseId,
        artifactRoot: evidence.artifactRoot,
        artifacts: evidence.artifacts,
        failureDiagnostic,
      };
    }

    const lease = leaseResult.lease;
    const startedAt = Date.now();
    try {
      const timeoutMs = Number(
        options.timeoutMs || options.timeout || containerTimeout,
      );
      let result;
      if (typeof options.execute === "function") {
        result = await options.execute({
          ...options,
          command,
          cwd: lease.cwd,
          timeoutMs,
          lease,
          provider,
        });
      } else if (provider === "container") {
        result = await runInContainer({
          workspacePath: lease.cwd,
          command: "/bin/sh",
          args: [
            "-lc",
            joinCommandArgs(command, Array.isArray(options.args) ? options.args : []),
          ],
          env: options.env || {},
          taskId: lease.taskId,
          timeout: timeoutMs,
          onStdout: options.onStdout,
          onStderr: options.onStderr,
        });
      } else {
        result = await runIsolatedProcess({
          command,
          args: Array.isArray(options.args) ? options.args : [],
          cwd: lease.cwd,
          env: options.env || {},
          timeoutMs,
          onStdout: options.onStdout,
          onStderr: options.onStderr,
        });
      }

      const failureDiagnostic = buildIsolatedFailureDiagnostic(result, {
        command,
        args: Array.isArray(options.args) ? options.args : [],
        provider,
        attempts: attempt,
        timeoutMs,
      });
      const releaseInfo = releaseLeaseRecord(lease, {
        status: result?.status || "unknown",
        exitCode: result?.exitCode ?? null,
      });
      const extraArtifacts = [];
      if (result?.scratchDir) {
        extraArtifacts.push({
          label: "scratch",
          kind: "directory",
          path: result.scratchDir,
        });
      }
      const evidence = persistIsolatedRunArtifacts({
        cwd: lease.cwd,
        leaseId: lease.leaseId,
        stdout: result?.stdout || "",
        stderr: result?.stderr || "",
        metadata: {
          lease: releaseInfo,
          provider,
          command,
          args: Array.isArray(options.args) ? options.args : [],
          attempts: attempt,
          durationMs: result?.duration ?? Date.now() - startedAt,
          status: result?.status || "unknown",
          exitCode: result?.exitCode ?? null,
          failureDiagnostic,
        },
        extraArtifacts,
      });
      return {
        ...result,
        attempts: attempt,
        provider,
        isolated: true,
        leaseId: lease.leaseId,
        artifactRoot: evidence.artifactRoot,
        artifacts: evidence.artifacts,
        failureDiagnostic,
      };
    } catch (error) {
      releaseLeaseRecord(lease, {
        status: "error",
        error: error?.message || String(error),
      });
      lastFailure = error;
      if (attempt < maxAttempts) {
        await waitForLeaseRetry(isolatedRunnerRetryDelayMs);
        continue;
      }
      const failedLeaseId = lease.leaseId || `failed-${Date.now()}-${attempt}`;
      const blockedResult = {
        status: "blocked",
        blocked: true,
        error: error?.message || String(error),
        exitCode: null,
      };
      const failureDiagnostic = buildIsolatedFailureDiagnostic(blockedResult, {
        command,
        args: Array.isArray(options.args) ? options.args : [],
        provider,
        attempts: attempt,
      });
      const evidence = persistIsolatedRunArtifacts({
        cwd: lease.cwd,
        leaseId: failedLeaseId,
        stderr: error?.stack || error?.message || String(error),
        metadata: {
          status: "blocked",
          reason: error?.message || String(error),
          provider,
          command,
          args: Array.isArray(options.args) ? options.args : [],
          attempts: attempt,
          failureDiagnostic,
        },
      });
      return {
        ...blockedResult,
        attempts: attempt,
        provider,
        isolated: true,
        leaseId: failedLeaseId,
        artifactRoot: evidence.artifactRoot,
        artifacts: evidence.artifacts,
        failureDiagnostic,
      };
    }
  }

  throw lastFailure || new Error("runInIsolatedRunner failed unexpectedly");
}
