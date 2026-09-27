/**
 * Regression tests for the OpenCode executor's environment traps.
 *
 * Both bugs made the executor silently unusable, and both failed in a way that
 * pointed somewhere other than the cause:
 *
 *  1. `spawn("opencode")` ENOENTs on Windows (npm ships only .sh/.cmd/.ps1
 *     shims) and the fallback then reported "fetch failed" — a port problem.
 *  2. A 1.x SDK against a 2.x CLI waits out its startup timeout, because the
 *     readiness signal is a stdout banner that 2.x changed.
 *
 * Plus the two config traps: the agent-SDK primary silently defaulting to
 * "codex" (disabling OpenCode) and a repo-root bosun.config.json being ignored.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import {
  parseAgentSdkConfig,
  resolveAgentSdkConfig,
  resetAgentSdkCache,
} from "../agent/agent-sdk.mjs";
import {
  resolveOpencodeBinary,
  describeOpencodeBinary,
  resetOpencodeBinaryCache,
} from "../shell/opencode-binary.mjs";
import {
  checkOpencodeSdkCompat,
  resetOpencodeSdkCompatCache,
  SUPPORTED_SDK_MAJOR,
} from "../shell/opencode-sdk-compat.mjs";

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "bosun-opencode-"));
  resetAgentSdkCache();
  resetOpencodeBinaryCache();
  resetOpencodeSdkCompatCache();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  resetAgentSdkCache();
  resetOpencodeBinaryCache();
  resetOpencodeSdkCompatCache();
});

describe("agent SDK primary (bug: OpenCode silently disabled)", () => {
  it("falls back to PRIMARY_AGENT when config.toml has no [agent_sdk] block", () => {
    // The exact failure: no [agent_sdk] in ~/.codex/config.toml used to force
    // "codex", and the opencode shell then refused to run.
    const parsed = parseAgentSdkConfig("", { fallbackPrimaryRaw: "opencode" });
    expect(parsed.primary).toBe("opencode");
    expect(parsed.source).toBe("env-fallback");
  });

  it("still defaults to codex when nothing indicates a primary", () => {
    const parsed = parseAgentSdkConfig("");
    expect(parsed.primary).toBe("codex");
    expect(parsed.source).toBe("defaults");
  });

  it("lets config.toml win over the env fallback", () => {
    const toml = '[agent_sdk]\nprimary = "claude"\n';
    const parsed = parseAgentSdkConfig(toml, { fallbackPrimaryRaw: "opencode" });
    expect(parsed.primary).toBe("claude");
    expect(parsed.source).toBe("config.toml");
  });

  it("resolves the executor spelling 'opencode-sdk' from the environment", () => {
    const previous = process.env.PRIMARY_AGENT;
    process.env.PRIMARY_AGENT = "opencode-sdk";
    try {
      // No [agent_sdk] block on this machine, so the env path is what runs.
      const config = resolveAgentSdkConfig({ reload: true });
      expect(config.primary).toBe("opencode");
    } finally {
      if (previous === undefined) delete process.env.PRIMARY_AGENT;
      else process.env.PRIMARY_AGENT = previous;
    }
  });

  it("ignores an unsupported PRIMARY_AGENT rather than adopting it", () => {
    const parsed = parseAgentSdkConfig("", { fallbackPrimaryRaw: "not-a-real-sdk" });
    expect(parsed.primary).toBe("codex");
  });
});

describe("opencode binary resolution (bug: spawn ENOENT on Windows)", () => {
  it("prefers an explicit OPENCODE_BIN that exists", () => {
    const bin = join(tmp, "opencode.exe");
    writeFileSync(bin, "");
    const resolved = resolveOpencodeBinary({
      reload: true,
      env: { OPENCODE_BIN: bin, PATH: "" },
    });
    expect(resolved).toBe(bin);
  });

  it("warns and keeps looking when OPENCODE_BIN does not exist", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const resolved = resolveOpencodeBinary({
        reload: true,
        env: { OPENCODE_BIN: join(tmp, "nope.exe"), PATH: "" },
      });
      // The bogus override is reported, and resolution continues rather than
      // failing — on this machine it reaches the real global install, and on a
      // machine with no install at all it lands on the bare "opencode" name.
      expect(warn).toHaveBeenCalled();
      expect(resolved).toBeTruthy();
      expect(resolved).not.toContain("nope.exe");
    } finally {
      warn.mockRestore();
    }
  });

  it("follows a PATH shim to the executable it runs", () => {
    // This is the real Windows shape: npm's `opencode.cmd` execs the package
    // binary, and the package binary is the only runnable image.
    const binDir = join(tmp, "node_modules", "opencode-ai", "bin");
    mkdirSync(binDir, { recursive: true });
    const real = join(binDir, "opencode.exe");
    writeFileSync(real, "");

    const shimDir = join(tmp, "shim");
    mkdirSync(shimDir, { recursive: true });
    const shim = join(shimDir, "opencode.cmd");
    writeFileSync(
      shim,
      `@ECHO off\r\nSET dp0=%~dp0\r\n"${real}" %*\r\n`,
    );

    const resolved = resolveOpencodeBinary({
      reload: true,
      env: { PATH: `${shimDir}${delimiter}${binDir}` },
    });
    // On POSIX the bare shim IS executable, so only assert the follow on Windows.
    if (process.platform === "win32") {
      expect(resolved).toBe(real);
    } else {
      expect(resolved).toBeTruthy();
    }
  });

  it("reports a source for diagnostics", () => {
    const info = describeOpencodeBinary({ env: { PATH: "" } });
    expect(info).toHaveProperty("platform");
    expect(info).toHaveProperty("source");
    expect(info.path).toBeTruthy();
  });
});

describe("SDK/CLI version pairing (bug: startup timeout naming no version)", () => {
  it("accepts the installed, verified-compatible pair", async () => {
    const result = await checkOpencodeSdkCompat({ reload: true });
    // This is the pairing the repo pins; if it reports not-ok the environment
    // has drifted and every OpenCode turn will time out.
    expect(result.sdkVersion.split(".")[0]).toBe(String(SUPPORTED_SDK_MAJOR));
    if (result.cliVersion) {
      expect(result.ok).toBe(true);
    }
  });

  it("names both versions in the reason so the fix is actionable", async () => {
    const result = await checkOpencodeSdkCompat({ reload: true });
    if (!result.ok) {
      expect(result.reason).toMatch(/opencode-ai\/sdk|opencode CLI/);
    }
  });
});

describe("config discovery (bug: repo-root config silently ignored)", () => {
  // These run against the REAL loader, so they must not depend on ambient env:
  // sibling test files share this process and some of them mutate BOSUN_HOME /
  // BOSUN_CONFIG_PATH in their own hooks.
  //
  // BOSUN_HOME is required, not just hygiene: a temp dir is not a bosun module
  // root, so resolveConfigDir() falls through to the real checkout's .bosun/ and
  // reads the developer's actual config. Pinning the dir is what makes the
  // assertion about THIS repoRoot meaningful.
  const withConfigDir = (configDir, fn) => {
    const saved = {
      BOSUN_HOME: process.env.BOSUN_HOME,
      BOSUN_DIR: process.env.BOSUN_DIR,
      BOSUN_CONFIG_PATH: process.env.BOSUN_CONFIG_PATH,
    };
    delete process.env.BOSUN_CONFIG_PATH;
    delete process.env.BOSUN_DIR;
    process.env.BOSUN_HOME = configDir;
    try {
      return fn();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };

  it("warns when bosun.config.json sits in the repo root, not .bosun/", async () => {
    // Reproduces the discovery order: resolveConfigDir() prefers <repo>/.bosun
    // whenever it exists, so a root-level config is read by nothing.
    const repo = join(tmp, "repo");
    const bosunDir = join(repo, ".bosun");
    mkdirSync(bosunDir, { recursive: true });
    writeFileSync(
      join(repo, "bosun.config.json"),
      JSON.stringify({ projectName: "ignored" }),
    );

    const { readConfigDocument } = await import("../config/config.mjs");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let doc;
    try {
      doc = withConfigDir(bosunDir, () => readConfigDocument(repo));
      const messages = [...warn.mock.calls, ...log.mock.calls]
        .map((c) => String(c[0]))
        .join("\n");

      // The file in the repo root is genuinely ignored...
      expect(Object.keys(doc.configData ?? {})).toHaveLength(0);
      // ...and the operator is told so, naming the path to move it to.
      expect(messages).toContain("IGNORED");
      expect(messages).toContain("bosun.config.json");
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it("stays quiet when the config file is in the config dir", async () => {
    const repo = join(tmp, "repo2");
    const bosunDir = join(repo, ".bosun");
    mkdirSync(bosunDir, { recursive: true });
    writeFileSync(
      join(bosunDir, "bosun.config.json"),
      JSON.stringify({ projectName: "found" }),
    );

    const { readConfigDocument } = await import("../config/config.mjs");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const doc = withConfigDir(bosunDir, () => readConfigDocument(repo));
      expect(doc.configData?.projectName).toBe("found");
      const messages = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(messages).not.toContain("IGNORED");
    } finally {
      warn.mockRestore();
    }
  });
});
