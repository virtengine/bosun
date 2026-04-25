import { describe, expect, it, vi } from "vitest";

import {
  importCopilotSdkModuleWithCompat,
  resolveCopilotCliLaunchConfig,
} from "../shell/copilot-shell.mjs";

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
