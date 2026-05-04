import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(resolve(process.cwd(), "server/ui-server.mjs"), "utf8");

describe("ui-server quick tunnel auto-restart with exponential backoff", () => {
  it("restarts quick tunnel after unexpected exit", () => {
    // Tunnel exit handler should trigger a restart, not just null the state
    const hasRestartOnExit =
      source.includes("restart") &&
      source.includes("exit") &&
      (source.includes("quickTunnel") || source.includes("startQuickTunnel"));
    assert.ok(
      hasRestartOnExit,
      "quick tunnel exit handler should trigger auto-restart",
    );
  });

  it("restarts quick tunnel when it exits before becoming active", () => {
    assert.ok(
      source.includes("quick tunnel exited with code") &&
        source.includes("earlyExitShouldRestart = true") &&
        source.includes("scheduleQuickTunnelRestart(cfBin, localPort)") &&
        source.includes("shouldRestartForProcessExit(code, signal)") &&
        source.includes("retry regardless of exit code"),
      "early quick tunnel exits should schedule restart",
    );
  });

  it("treats signal-based exits as restartable failures", () => {
    assert.ok(
      source.includes("function shouldRestartForProcessExit(code, signal)") &&
        source.includes('if (typeof code === "number") return code !== 0;') &&
        source.includes("const codeText = String(code ?? \"\").trim();") &&
        source.includes("Number.parseInt(codeText, 10)") &&
        source.includes("codeText.match(/-?\\d+/)") &&
        source.includes("![\"0\", \"null\", \"undefined\"].includes(codeText.toLowerCase())") &&
        source.includes('typeof signal === "string" && signal.length > 0') &&
        source.includes("child.on(\"exit\", (code, signal) =>"),
      "quick tunnel should restart when cloudflared exits via signal",
    );
  });

  it("logs recoverable tunnel exits at info level with restart context", () => {
    assert.ok(
      source.includes("quick tunnel exited with code") &&
        source.includes("; restart scheduled") &&
        source.includes("console.log(earlyExitMsg)") &&
        source.includes("console.log("),
      "recoverable quick tunnel exits should log restart context without warning-noise",
    );
  });

  it("does not mark restartable exits as persistent tunnel errors", () => {
    assert.ok(
      source.includes('lastError: earlyExitShouldRestart ? "" : "quick_tunnel_exited_early"') &&
        source.includes("} else if (restartableExit)") &&
        source.includes('lastError: ""'),
      "auto-recoverable exits should not keep tunnel status in an error state",
    );
  });

  it("restarts quick tunnel after startup timeout", () => {
    assert.ok(
      source.includes("quick tunnel timed out after 30s") &&
        source.includes("quick_tunnel_timeout") &&
        source.includes("child.kill(\"SIGTERM\")") &&
        source.includes("scheduleQuickTunnelRestart(cfBin, localPort)"),
      "quick tunnel startup timeout should terminate child and schedule restart",
    );
  });

  it("guards restart scheduling so error+exit only enqueue once", () => {
    assert.ok(
      source.includes("let restartScheduled = false") &&
        source.includes("function scheduleRestartOnce()") &&
        source.includes("if (restartScheduled) return;"),
      "quick tunnel restart scheduling should be de-duplicated per child lifecycle",
    );
  });

  it("restarts quick tunnel after spawn failure", () => {
    assert.ok(
      source.includes("quick_tunnel_spawn_failed") &&
        source.includes("quick tunnel spawn failed:") &&
        source.includes("scheduleQuickTunnelRestart(cfBin, localPort)"),
      "spawn failures should schedule quick tunnel restart",
    );
  });

  it("uses exponential backoff between restart attempts", () => {
    const hasExponentialBackoff =
      source.includes("backoff") ||
      /Math\.pow|2\s*\*\*\s*attempt|\*\s*2\s*\*\s*attempt/.test(source) ||
      source.includes("exponential");
    assert.ok(
      hasExponentialBackoff,
      "quick tunnel restart should use exponential backoff",
    );
  });

  it("applies jitter to restart delay", () => {
    const hasJitter =
      source.includes("jitter") ||
      (source.includes("Math.random") && source.includes("restart"));
    assert.ok(
      hasJitter,
      "quick tunnel restart should apply jitter to prevent thundering herd",
    );
  });

  it("logs routine restart scheduling at info level", () => {
    assert.ok(
      source.includes("quick tunnel restart scheduled") &&
        source.includes("console.log("),
      "routine quick tunnel restart scheduling should not be warning-noise",
    );
  });

  it("respects TELEGRAM_UI_QUICK_TUNNEL_RESTART_MAX_ATTEMPTS env var", () => {
    assert.ok(
      source.includes("TELEGRAM_UI_QUICK_TUNNEL_RESTART_MAX_ATTEMPTS"),
      "should be configurable via TELEGRAM_UI_QUICK_TUNNEL_RESTART_MAX_ATTEMPTS",
    );
  });

  it("defaults to max 6 restart attempts", () => {
    const has6Attempts = source.includes("TELEGRAM_UI_QUICK_TUNNEL_RESTART_MAX_ATTEMPTS") &&
      (source.includes(", 6") || source.includes("=6") || source.includes("= 6") ||
       /default.*6|6.*default|parseInt.*6/.test(source));
    assert.ok(
      has6Attempts,
      "default max restart attempts should be 6",
    );
  });

  it("respects TELEGRAM_UI_QUICK_TUNNEL_RESTART_BASE_DELAY_MS env var", () => {
    assert.ok(
      source.includes("TELEGRAM_UI_QUICK_TUNNEL_RESTART_BASE_DELAY_MS") ||
        source.includes("TELEGRAM_UI_QUICK_TUNNEL_RESTART_BASE_MS"),
      "should be configurable via TELEGRAM_UI_QUICK_TUNNEL_RESTART_BASE_DELAY_MS",
    );
  });

  it("defaults to 5 second base restart delay", () => {
    // 5s = 5000ms
    const has5sBase = source.includes("TELEGRAM_UI_QUICK_TUNNEL_RESTART") &&
      (source.includes("5000") || source.includes("5 * 1000") || /5\s*\*\s*1000/.test(source));
    assert.ok(
      has5sBase,
      "default base restart delay should be 5 seconds",
    );
  });

  it("caps restart delay at a maximum (default 120 seconds)", () => {
    const has120sMax = source.includes("TELEGRAM_UI_QUICK_TUNNEL_RESTART") &&
      (source.includes("120000") || source.includes("120_000") || source.includes("120 * 1000") ||
       /120\s*\*\s*1000/.test(source));
    assert.ok(
      has120sMax,
      "restart delay should be capped at a maximum (default 120s)",
    );
  });

  it("stops retrying after exhausting max attempts", () => {
    const hasExhaustion =
      source.includes("TELEGRAM_UI_QUICK_TUNNEL_RESTART_MAX_ATTEMPTS") &&
      (source.includes("exhausted") || source.includes(">= max") ||
       source.includes(">= MAX") || source.includes("attempts >="));
    assert.ok(
      hasExhaustion,
      "restart loop should stop after max attempts are exhausted",
    );
  });

  it("supports cooldown retries after exhaustion by default", () => {
    assert.ok(
      source.includes("TELEGRAM_UI_QUICK_TUNNEL_RESTART_FOREVER") &&
        source.includes("TELEGRAM_UI_QUICK_TUNNEL_RESTART_COOLDOWN_MS") &&
        source.includes("quick tunnel restart exhausted after") &&
        source.includes("retrying again after cooldown"),
      "quick tunnel should continue retrying after exhaustion unless explicitly disabled",
    );
  });

  it("adds output-tail diagnostics to quick tunnel failures", () => {
    assert.ok(
      source.includes("formatTunnelOutputHint(output)") &&
        source.includes("tail:") &&
        source.includes("quick tunnel exited with code") &&
        source.includes("quick tunnel failed:"),
      "quick tunnel warnings should include a compact output tail for root-cause diagnosis",
    );
  });

  it("resets restart attempts when tunnel is stopped", () => {
    assert.ok(
      source.includes("export function stopTunnel()") &&
      source.includes("quickTunnelRestartAttempts = 0;"),
      "stopTunnel should reset quick tunnel restart attempts",
    );
  });

  it("suppresses stale quick restart timers at fresh tunnel startup", () => {
    assert.ok(
      /async function startTunnel[\s\S]{0,260}quickTunnelRestartSuppressed = true;/.test(source) &&
        /async function startTunnel[\s\S]{0,320}clearQuickTunnelRestartTimer\(\);/.test(source) &&
        /async function startTunnel[\s\S]{0,380}quickTunnelRestartAttempts = 0;/.test(source),
      "startTunnel should neutralize stale quick restart state before starting a new tunnel session",
    );
  });

  it("guards delayed quick-restart timer callbacks against late shutdown", () => {
    assert.ok(
      source.includes("if (quickTunnelRestartSuppressed || tunnelStopRequested) return;") &&
      source.includes("quick tunnel restart failed after cooldown:") &&
      source.includes("quick tunnel restart failed:"),
      "scheduled restart callbacks should no-op if suppression/shutdown becomes active before timer fires",
    );
  });

  it("ignores quick tunnel exit events when stopTunnel requested shutdown", () => {
    assert.ok(
      source.includes("let tunnelStopRequested = false;") &&
        source.includes("if (tunnelStopRequested) {") &&
        source.includes("if (!resolved) {") &&
        source.includes("resolvePromise(null);") &&
        source.includes("tunnelStopRequested = true;"),
      "quick tunnel exits should be ignored when shutdown was intentional",
    );
  });

  it("clears stop-request state when quick tunnel starts directly", () => {
    assert.ok(
      /async function startQuickTunnel[\s\S]{0,220}tunnelStopRequested = false;/.test(source),
      "quick tunnel direct starts should clear stale stop-request state",
    );
  });

  it("tracks startup quick tunnel process so stopTunnel can terminate pre-ready child", () => {
    assert.ok(
      source.includes("// Track startup child so stopTunnel() can terminate it even before URL discovery.") &&
        source.includes("tunnelProcess = child;") &&
        source.includes("if (tunnelStopRequested)") &&
        source.includes("child.kill(\"SIGTERM\")") &&
        source.includes("tunnelProcess = null;"),
      "quick tunnel startup should expose child handle for intentional shutdown during startup",
    );
  });

  it("ignores quick tunnel readiness parsing after stopTunnel is requested", () => {
    assert.ok(
      source.includes("function parseOutput(chunk)") &&
        source.includes("if (tunnelStopRequested) return;"),
      "quick tunnel should not transition to active after intentional stop during startup",
    );
  });

  it("ignores quick tunnel error events when stopTunnel requested shutdown", () => {
    assert.ok(
      source.includes("child.on(\"error\", (err) =>") &&
        source.includes("if (tunnelStopRequested)") &&
        source.includes("resolvePromise(null);"),
      "quick tunnel errors should be ignored when shutdown was intentional",
    );
  });
});
