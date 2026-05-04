import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readFileMock = vi.fn();
const homedirMock = vi.fn(() => "/home/tester");
const isAppConfiguredMock = vi.fn();
const getInstallationTokenForRepoMock = vi.fn();
const execFileSyncMock = vi.fn();
const fetchMock = vi.fn();

const originalFetch = globalThis.fetch;

const envKeys = [
  "BOSUN_GITHUB_USER_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_PAT",
];

const originalEnv = envKeys.reduce(
  (acc, key) => ({ ...acc, [key]: process.env[key] }),
  {},
);

function clearAuthEnv() {
  for (const key of envKeys) {
    delete process.env[key];
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAuthEnv();
  fetchMock.mockReset();
  globalThis.fetch = fetchMock;
  homedirMock.mockReturnValue("/home/tester");
  readFileMock.mockRejectedValue(new Error("missing"));
  isAppConfiguredMock.mockReturnValue(false);
  getInstallationTokenForRepoMock.mockResolvedValue({ token: null });
  execFileSyncMock.mockImplementation(() => {
    throw new Error("gh missing");
  });
});

afterEach(() => {
  vi.unmock("node:fs/promises");
  vi.unmock("node:os");
  vi.unmock("node:child_process");
  vi.unmock("../github/github-app-auth.mjs");
  vi.resetModules();
});

afterAll(() => {
  for (const key of envKeys) {
    if (originalEnv[key] == null) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
  globalThis.fetch = originalFetch;
});

async function loadSubject() {
  vi.resetModules();
  vi.doMock("node:fs/promises", async () => {
    const actual = await vi.importActual("node:fs/promises");
    return {
      ...actual,
      readFile: readFileMock,
    };
  });
  vi.doMock("node:os", async () => {
    const actual = await vi.importActual("node:os");
    return {
      ...actual,
      homedir: homedirMock,
    };
  });
  vi.doMock("../github/github-app-auth.mjs", async () => {
    const actual = await vi.importActual("../github/github-app-auth.mjs");
    return {
      ...actual,
      isAppConfigured: isAppConfiguredMock,
      getInstallationTokenForRepo: getInstallationTokenForRepoMock,
    };
  });
  vi.doMock("node:child_process", async () => {
    const actual = await vi.importActual("node:child_process");
    return {
      ...actual,
      execFileSync: execFileSyncMock,
    };
  });
  return import("../github/github-auth-manager.mjs");
}

describe("github-auth-manager getGitHubToken", () => {
  it("prefers OAuth env override and returns verified login when requested", async () => {
    const { getGitHubToken } = await loadSubject();
    process.env.BOSUN_GITHUB_USER_TOKEN = "oauth-env-token";
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ login: "octo-env" }),
    });

    isAppConfiguredMock.mockReturnValue(true);
    getInstallationTokenForRepoMock.mockResolvedValue({ token: "app-token" });
    execFileSyncMock.mockReturnValue("gh-token");

    const result = await getGitHubToken({ owner: "virtengine", repo: "bosun", verify: true });

    expect(result).toEqual({ token: "oauth-env-token", type: "oauth", login: "octo-env" });
    expect(readFileMock).not.toHaveBeenCalled();
    expect(getInstallationTokenForRepoMock).not.toHaveBeenCalled();
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to installation token when verify rejects OAuth token", async () => {
    const { getGitHubToken } = await loadSubject();
    readFileMock.mockResolvedValue(JSON.stringify({ accessToken: "file-oauth-token" }));
    fetchMock.mockResolvedValue({ ok: false });

    isAppConfiguredMock.mockReturnValue(true);
    getInstallationTokenForRepoMock.mockResolvedValue({ token: "install-token" });

    const result = await getGitHubToken({ owner: "virtengine", repo: "bosun", verify: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ token: "install-token", type: "installation" });
    expect(getInstallationTokenForRepoMock).toHaveBeenCalledWith("virtengine", "bosun");
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it("uses gh CLI token after installation lookup fails", async () => {
    const { getGitHubToken } = await loadSubject();
    isAppConfiguredMock.mockReturnValue(true);
    getInstallationTokenForRepoMock.mockRejectedValue(new Error("no installation"));
    execFileSyncMock.mockReturnValue("gh-cli-token");

    const result = await getGitHubToken({ owner: "virtengine", repo: "bosun" });

    expect(result).toEqual({ token: "gh-cli-token", type: "gh-cli" });
    expect(execFileSyncMock).toHaveBeenCalled();
  });

  it("uses env token after gh CLI token is unavailable", async () => {
    const { getGitHubToken } = await loadSubject();
    process.env.GITHUB_TOKEN = "env-fallback-token";
    execFileSyncMock.mockImplementation(() => {
      throw new Error("gh missing");
    });

    const result = await getGitHubToken();

    expect(result).toEqual({ token: "env-fallback-token", type: "env" });
  });

  it("throws when no authentication sources are available", async () => {
    const { getGitHubToken } = await loadSubject();
    await expect(getGitHubToken()).rejects.toThrow("No GitHub auth available");
  });
});
