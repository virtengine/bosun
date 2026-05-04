import { describe, expect, it, vi } from "vitest";

const execSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual("node:child_process");
  return {
    ...actual,
    execSync: execSyncMock,
  };
});

function isGhProbe(command) {
  return (
    typeof command === "string" &&
    /^(where|which)\s+gh$/i.test(command.trim())
  );
}

async function loadSetupModule() {
  vi.resetModules();
  return import("../setup.mjs");
}

describe("getGitHubAuthScopes runtime guardrails", () => {
  it("returns empty scopes when gh is unavailable", async () => {
    execSyncMock.mockReset();
    execSyncMock.mockImplementation((command) => {
      if (isGhProbe(command)) {
        throw new Error("gh not found");
      }
      return "";
    });

    const { getGitHubAuthScopes } = await loadSetupModule();
    const scopes = getGitHubAuthScopes(process.cwd());
    expect(scopes).toEqual([]);
  });

  it("parses scopes and disables gh prompts with a bounded timeout", async () => {
    execSyncMock.mockReset();
    execSyncMock.mockImplementation((command) => {
      if (isGhProbe(command)) return "";
      if (
        command === "gh auth status --hostname github.com 2>&1"
      ) {
        return "Logged in to github.com\ntoken scopes: repo, read:org\n";
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const { getGitHubAuthScopes } = await loadSetupModule();
    const scopes = getGitHubAuthScopes(process.cwd());
    expect(scopes).toEqual(["repo", "read:org"]);

    const authCall = execSyncMock.mock.calls.find(
      ([command]) => command === "gh auth status --hostname github.com 2>&1",
    );
    expect(authCall).toBeTruthy();
    expect(authCall[1]).toMatchObject({
      timeout: 3000,
      env: expect.objectContaining({ GH_PROMPT_DISABLED: "1" }),
    });
  });
});
