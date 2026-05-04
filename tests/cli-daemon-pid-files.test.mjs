import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("cli daemon pid tracking", () => {
  const cliSource = readFileSync(resolve(process.cwd(), "cli.mjs"), "utf8");

  it("uses a dedicated daemon pid file separate from monitor lock pid file", () => {
    expect(cliSource).toContain(
      "function resolveRepoRootForCliRuntime(options = {}) {",
    );
    expect(cliSource).toContain(
      'const runtimeRepoRoot = resolveRepoRootForCliRuntime();',
    );
    expect(cliSource).toContain(
      "const runtimeCacheDir = resolve(runtimeRepoRoot, \".cache\");",
    );
    expect(cliSource).toContain(
      'const PID_FILE = resolve(runtimeCacheDir, "bosun.pid");',
    );
    expect(cliSource).toContain(
      'const DAEMON_PID_FILE = resolve(runtimeCacheDir, "bosun-daemon.pid");',
    );
    expect(cliSource).toContain(
      'async function getConfiguredRuntimeCacheDirs() {',
    );
  });

  it("reads and writes daemon state via the dedicated daemon pid file", () => {
    expect(cliSource).toContain(
      "readAlivePid(DAEMON_PID_FILE) || readAlivePid(LEGACY_DAEMON_PID_FILE)",
    );
    expect(cliSource).toContain("const DAEMON_START_STABILITY_MS = Math.max(");
    expect(cliSource).toContain("function installDaemonPidCleanup() {");
    expect(cliSource).toContain("if (!isDaemonSupervisorRuntime()) return;");
    expect(cliSource).toContain(
      "writeFileSync(DAEMON_PID_FILE, String(pid), \"utf8\");",
    );
    expect(cliSource).toContain("if (existsSync(DAEMON_PID_FILE)) unlinkSync(DAEMON_PID_FILE);");
    expect(cliSource).toContain("if (existsSync(LEGACY_DAEMON_PID_FILE)) unlinkSync(LEGACY_DAEMON_PID_FILE);");
  });

  it("resolves terminate pid candidates from configured cache dirs before relying on process scans", () => {
    expect(cliSource).toContain(
      'const { loadConfig } = await import("./config/config.mjs");',
    );
    expect(cliSource).toContain('String(config?.cacheDir || "").trim() || null');
    expect(cliSource).toContain('getWorkspaceScopedCacheDirCandidate(runtimeRepoRoot)');
    expect(cliSource).toContain(
      '...getPidFileCandidates("bosun-daemon.pid", configuredCacheDirs).map(',
    );
    expect(cliSource).toContain(
      '...getMonitorPidFileCandidates(configuredCacheDirs).map((pidFile) =>',
    );
    expect(cliSource).toContain('await terminateBosun();');
    expect(cliSource).toContain('writeSentinelManualStopHold(configuredCacheDirs, manualStopHoldMs);');
  });

  it("uses Windows taskkill fallback when terminate finds stuck bosun processes", () => {
    expect(cliSource).toContain('function taskkillPid(pid, { force = false } = {}) {');
    expect(cliSource).toContain('function taskkillPidsElevated(pids, { force = false } = {}) {');
    expect(cliSource).toContain('execFileSync("taskkill", args, {');
    expect(cliSource).toContain('const args = ["/PID", String(pid)];');
    expect(cliSource).toContain('if (process.platform === "win32" && alive.length > 0) {');
    expect(cliSource).toContain('taskkillPid(pid, { force: true });');
    expect(cliSource).toContain('taskkillPidsElevated(alive, { force: true });');
  });

  it("shuts down restart-capable processes before monitor pids during terminate", () => {
    expect(cliSource).toContain('const ancestorPids = findWindowsManagedAncestorPids([');
    expect(cliSource).toContain('const sentinelGhostPids = findGhostSentinelPids();');
    expect(cliSource).toContain('const restartOwnerPids = Array.from(');
    expect(cliSource).toContain('...sentinelGhostPids,');
    expect(cliSource).toContain('...ghosts,');
    expect(cliSource).toContain('for (const pid of restartOwnerPids) {');
    expect(cliSource).toContain('const remainingPids = allPids.filter((pid) => !restartOwnerPids.includes(pid));');
  });

  it("only falls back to broad process scans when lock files do not yield live Bosun pids", () => {
    expect(cliSource).toContain('const trackedPids = Array.from(new Set([...tracked, ...ghosts])).filter(');
    expect(cliSource).toContain('trackedPids.length === 0 && process.platform !== "win32"');
    expect(cliSource).toContain('? findAllBosunProcessPids()');
  });

  it("guards daemon-child startup with singleton ownership of daemon pid file", () => {
    expect(cliSource).toContain("const existingDaemonPid = getDaemonPid();");
    expect(cliSource).toContain("duplicate daemon-child ignored");
    expect(cliSource).toContain("function isDaemonSupervisorRuntime() {");
  });

  it("launches the foreground monitor as a child process instead of a worker thread", () => {
    expect(cliSource).toContain("const spawnMonitorChild = (forceWindowsShell = false) => {");
    expect(cliSource).toContain("function checkPipedChildProcessLaunch() {");
    expect(cliSource).toContain("stdio: [\"ignore\", \"pipe\", \"pipe\"]");
    expect(cliSource).toContain("monitor child spawn preflight blocked");
    expect(cliSource).toContain("return spawn(");
    expect(cliSource).toContain("monitorChild = spawnMonitorChild(false);");
    expect(cliSource).toContain("[...runAsNode, monitorPath, ...process.argv.slice(2)]");
    expect(cliSource).not.toContain("monitorChild = new Worker(");
  });

  it("forwards Ctrl+C shutdown signals to the monitor child instead of waiting indefinitely", () => {
    expect(cliSource).toContain("function requestMonitorChildShutdown(signal = \"SIGINT\")");
    expect(cliSource).toContain("function installMonitorChildSignalHandlers() {");
    expect(cliSource).toContain("if (monitorChildSignalHandlersInstalled) return;");
    expect(cliSource).toContain("shutdownSignalCount > 1 ? \"SIGTERM\" : signal");
    expect(cliSource).toContain("monitorChild.kill(requestedSignal)");
    expect(cliSource).toContain("monitorShutdownForceTimer = setTimeout(() => {");
    expect(cliSource).toContain("child.kill(\"SIGTERM\")");
    expect(cliSource).toContain("installMonitorChildSignalHandlers();\n  await runMonitor();");
    expect(cliSource).toContain("async function startDaemon() {\n  installMonitorChildSignalHandlers();");
  });


  it("propagates --config-dir/BOSUN_HOME into daemon-child env config dir", () => {
    expect(cliSource).toContain("const configDirArg = getArgValue(\"--config-dir\");");
    expect(cliSource).toContain("const explicitRepoRoot = getArgValue(\"--repo-root\");");
    expect(cliSource).toContain("if (configDirArg) return resolve(configDirArg);");
    expect(cliSource).toContain("if (process.env.BOSUN_HOME) return resolveTrustedBosunConfigDir(process.env.BOSUN_HOME, repoRoot);");
    expect(cliSource).toContain("if (repoRootArg) return resolve(repoRootArg);");
    expect(cliSource).toContain("BOSUN_DIR: process.env.BOSUN_DIR || resolveConfigDirForCli(),");
    expect(cliSource).toContain("? { REPO_ROOT: resolve(process.env.REPO_ROOT) }");
    expect(cliSource).toContain("? { REPO_ROOT: resolve(explicitRepoRoot) }");
    expect(cliSource).toContain("function normalizeDetachedDaemonArgs(rawArgs = []) {");
    expect(cliSource).toContain("...normalizeDetachedDaemonArgs(");
  });

  it("uses PowerShell Start-Process for stable Windows daemon detachment", () => {
    expect(cliSource).toContain("function startDaemonViaWindowsStartProcess(launchSpec) {");
    expect(cliSource).toContain("Start-Process -FilePath");
    expect(cliSource).toContain("launching daemon via PowerShell Start-Process for stable Windows detachment");
  });

  it("falls back to an inline daemon supervisor when Windows child-process launch is blocked", () => {
    expect(cliSource).toContain("async function startDaemon() {");
    expect(cliSource).toContain("const launchPreflight =");
    expect(cliSource).toContain("checkPipedChildProcessLaunch()");
    expect(cliSource).toContain("daemon detached startup is unavailable on this Windows host");
    expect(cliSource).toContain("bosun daemon fallback active");
    expect(cliSource).toContain('await runMonitor({ restartReason: "daemon-inline-fallback" });');
  });

  it("fails daemon startup when the detached child cannot stay alive through the stability window", () => {
    expect(cliSource).toContain("const stabilityDeadline = Date.now() + DAEMON_START_STABILITY_MS;");
    expect(cliSource).toContain(
      "Detached daemon exited during startup stability window; Windows child-process policy is preventing a durable daemon start in this runtime.",
    );
  });

  it("supports windows ghost daemon discovery for --daemon-status/--stop-daemon", () => {
    expect(cliSource).toContain("if (process.platform === \"win32\")");
    expect(cliSource).toContain("Get-CimInstance Win32_Process");
    expect(cliSource).toContain("--daemon-child");
  });

  it("detects ghost sentinel restart owners and points daemon-status at terminate", () => {
    expect(cliSource).toContain("function findGhostSentinelPids() {");
    expect(cliSource).toContain("telegram-sentinel\\\\.mjs");
    expect(cliSource).toContain("Ghost sentinel restart owner(s) detected");
    expect(cliSource).toContain("Run --terminate to stop restart owners, then --daemon to restart.");
  });

  it("reports a live monitor lock owner before falling back to broad daemon-status process scans", () => {
    expect(cliSource).toContain("const configuredCacheDirs = await getConfiguredRuntimeCacheDirs();");
    expect(cliSource).toContain(
      "const existingMonitorOwner = detectExistingMonitorLockOwner(null, configuredCacheDirs);",
    );
    expect(cliSource).toContain("bosun daemon is not running in daemon mode, but bosun monitor is active");
    expect(cliSource).toContain("Bosun is running in monitor mode with lock file");
    expect(cliSource).toContain("Use 'bosun --terminate' to stop it, or 'bosun --daemon' only after it is fully stopped.");
  });

  it("keeps sentinel companion auto-start opt-in to avoid Telegram polling conflicts", () => {
    expect(cliSource).toContain("const sentinelExplicit = args.includes(\"--sentinel\");");
    expect(cliSource).toContain("const sentinelRequested =");
    expect(cliSource).toContain("!IS_DAEMON_CHILD && sentinelAutoRequested");
    expect(cliSource).toContain("parseBoolEnv(");
    expect(cliSource).toContain("process.env.BOSUN_SENTINEL_AUTO_START");
    expect(cliSource).toContain(
      "telegram-sentinel auto-start suppressed in daemon-child mode",
    );
  });

  it("treats explicit --sentinel as a standalone command unless daemon mode is requested", () => {
    expect(cliSource).toContain("sentinelExplicit && !isDaemonSupervisorRuntime()");
    expect(cliSource).toContain(
      "Sentinel started without launching monitor (use --daemon --sentinel to run both).",
    );
    expect(cliSource).toContain("sentinelExplicit,");
  });
});
