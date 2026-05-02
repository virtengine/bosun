import { afterEach, describe, expect, it, vi } from "vitest";

import {
  _setActiveSessionForTesting,
  buildCopilotProcessEnv,
  execCopilotPrompt,
  importCopilotSdkModuleWithCompat,
  resetSession,
  resolveCopilotCliLaunchConfig,
  resolveCopilotSdkAuthOptions,
} from "../shell/copilot-shell.mjs";

afterEach(async () => {
  await resetSession();
  vi.restoreAllMocks();
});

describe("resolveCopilotCliLaunchConfig", () => {
  it("prefers an explicit CLI path from the environment", () => {
    const config = resolveCopilotCliLaunchConfig({
      env: { COPILOT_CLI_PATH: "C:/custom/copilot.exe" },
      cliArgs: ["--allow-all"],
      fileExists: () => true,
      execPath: "node",
      repoRoot: "C:/repo",
    });

    expect(config).toEqual({
      cliPath: "C:/custom/copilot.exe",
      cliArgs: ["--allow-all"],
      source: "env",
    });
  });

  it("uses the bundled CLI loader when no explicit path is set", () => {
    const config = resolveCopilotCliLaunchConfig({
      env: {},
      cliArgs: ["--allow-all"],
      fileExists: (path) => path.endsWith("node_modules\\@github\\copilot\\npm-loader.js") || path.endsWith("node_modules/@github/copilot/npm-loader.js"),
      execPath: "node",
      repoRoot: "C:/repo",
    });

    expect(config).toEqual({
      cliPath: "node",
      cliArgs: [
        expect.stringMatching(/node_modules[\\/]@github[\\/]copilot[\\/]npm-loader\.js$/),
        "--allow-all",
      ],
      source: "bundled",
    });
  });

  it("falls back to PATH lookup when no explicit or bundled CLI exists", () => {
    const config = resolveCopilotCliLaunchConfig({
      env: {},
      cliArgs: ["--allow-all"],
      fileExists: () => false,
      execPath: "node",
      repoRoot: "C:/repo",
    });

    expect(config).toEqual({
      cliPath: undefined,
      cliArgs: ["--allow-all"],
      source: "path",
    });
  });
});

describe("buildCopilotProcessEnv", () => {
  it("forces headless-safe pager defaults without dropping existing env", () => {
    const env = buildCopilotProcessEnv({
      PATH: "/usr/bin",
      PAGER: "less",
      CUSTOM_FLAG: "1",
    });

    expect(env).toMatchObject({
      PATH: "/usr/bin",
      CUSTOM_FLAG: "1",
      GIT_PAGER: "cat",
      PAGER: "cat",
      GH_PAGER: "cat",
      SYSTEMD_PAGER: "cat",
    });
  });
});

describe("resolveCopilotSdkAuthOptions", () => {
  it("prefers logged-in gh auth over a generic GitHub token for local Copilot sessions", async () => {
    const auth = await resolveCopilotSdkAuthOptions({
      env: { GITHUB_TOKEN: "generic-token" },
      ghAuthChecker: () => true,
      getToken: async () => ({ token: "generic-token", type: "gh-cli" }),
    });

    expect(auth).toEqual({
      useLoggedInUser: true,
      source: "gh-cli-user",
    });
  });

  it("uses an explicit Copilot token override before logged-in gh auth", async () => {
    const auth = await resolveCopilotSdkAuthOptions({
      env: { COPILOT_CLI_TOKEN: "copilot-token", GITHUB_TOKEN: "generic-token" },
      ghAuthChecker: () => true,
      getToken: async () => ({ token: "generic-token", type: "gh-cli" }),
    });

    expect(auth).toEqual({
      githubToken: "copilot-token",
      token: "copilot-token",
      useLoggedInUser: false,
      source: "copilot-cli-token-env",
    });
  });
});

describe("importCopilotSdkModuleWithCompat", () => {
  it("applies the vscode-jsonrpc extensionless shim before retrying the SDK import", async () => {
    const fakeModule = { CopilotClient: class FakeCopilotClient {} };
    const importer = vi.fn()
      .mockRejectedValueOnce(new Error("Cannot find module 'vscode-jsonrpc/node' imported from session.js"))
      .mockResolvedValueOnce(fakeModule);
    const copied = [];

    const mod = await importCopilotSdkModuleWithCompat({
      importer,
      shimState: {},
      resolvePackageJsonPath: () => "C:/repo/node_modules/vscode-jsonrpc/package.json",
      fileExists: (path) => path.endsWith("node.js"),
      copyFile: (src, dst) => {
        copied.push([src, dst]);
      },
      log: () => {},
      warn: () => {},
    });

    expect(mod).toBe(fakeModule);
    expect(importer).toHaveBeenCalledTimes(2);
    expect(copied).toHaveLength(1);
    expect(copied[0][0].replaceAll("\\", "/")).toBe(
      "C:/repo/node_modules/vscode-jsonrpc/node.js",
    );
    expect(copied[0][1].replaceAll("\\", "/")).toBe(
      "C:/repo/node_modules/vscode-jsonrpc/node",
    );
  });
});

describe("execCopilotPrompt", () => {
  it("returns when session.idle arrives even if sendAndWait never resolves", async () => {
    const listeners = new Set();
    const session = {
      sessionId: "copilot-test-session",
      workspacePath: process.cwd(),
      on(handler) {
        listeners.add(handler);
        return () => listeners.delete(handler);
      },
      sendAndWait() {
        setTimeout(() => {
          for (const listener of listeners) {
            listener({
              type: "assistant.message",
              data: { content: "Completed after the test burst." },
            });
            listener({ type: "session.idle" });
          }
        }, 10);
        return new Promise(() => {});
      },
    };
    _setActiveSessionForTesting(session, { sessionId: "copilot-test-session" });

    const result = await execCopilotPrompt("Finish the task.", {
      persistent: true,
      timeoutMs: 250,
      sendRawEvents: true,
    });

    expect(result.finalResponse).toBe("Completed after the test burst.");
  });
});
