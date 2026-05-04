import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  detectWorkspaces,
  listWorkspaces,
  mergeDetectedWorkspaces,
  pullWorkspaceRepos,
} from "../workspace/workspace-manager.mjs";

const cleanupDirs = [];

beforeEach(() => {
  cleanupDirs.length = 0;
});

afterEach(() => {
  for (const dir of cleanupDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

function sanitizedGitEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_PREFIX",
  ]) {
    delete env[key];
  }
  return env;
}

function execGit(command, options = {}) {
  return execSync(command, {
    ...options,
    env: sanitizedGitEnv(options.env),
  });
}

function createConfigDir() {
  const dir = mkdtempSync(join(tmpdir(), "workspace-manager-tests-"));
  cleanupDirs.push(dir);
  return dir;
}

function writeBosunConfig(configDir, config) {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "bosun.config.json"), JSON.stringify(config, null, 2) + "\n", "utf8");
}

function createGitRepo(repoPath, remoteUrl) {
  mkdirSync(repoPath, { recursive: true });
  execGit("git init", { cwd: repoPath, stdio: ["ignore", "ignore", "ignore"] });
  if (remoteUrl) {
    execGit("git remote add origin " + remoteUrl, {
      cwd: repoPath,
      stdio: ["ignore", "ignore", "ignore"],
    });
  }
}

function readConfig(configDir) {
  return JSON.parse(readFileSync(join(configDir, "bosun.config.json"), "utf8"));
}

function createSeededBareRemote(baseDir, name = "remote-repo") {
  const barePath = join(baseDir, `${name}.git`);
  const seedPath = join(baseDir, `${name}-seed`);
  execGit(`git init --bare "${barePath}"`, { stdio: ["ignore", "ignore", "ignore"] });
  execGit(`git clone "${barePath}" "${seedPath}"`, { stdio: ["ignore", "ignore", "ignore"] });
  execGit('git config --local user.email "bosun-tests@example.com"', {
    cwd: seedPath,
    stdio: ["ignore", "ignore", "ignore"],
  });
  execGit('git config --local user.name "Bosun Tests"', {
    cwd: seedPath,
    stdio: ["ignore", "ignore", "ignore"],
  });
  writeFileSync(join(seedPath, "README.md"), "# seed\n", "utf8");
  execGit("git add README.md", { cwd: seedPath, stdio: ["ignore", "ignore", "ignore"] });
  execGit('git commit -m "seed"', { cwd: seedPath, stdio: ["ignore", "ignore", "ignore"] });
  execGit("git push origin HEAD", { cwd: seedPath, stdio: ["ignore", "ignore", "ignore"] });
  return barePath;
}

describe("detectWorkspaces", () => {
  it("only detects directories with git repositories and reports their slug", () => {
    const configDir = createConfigDir();
    const workspacesDir = join(configDir, "workspaces");
    createGitRepo(join(workspacesDir, "alpha", "repo-one"), "git@github.com:virtengine/repo-one.git");

    // Workspace without git repos should be ignored
    mkdirSync(join(workspacesDir, "empty"), { recursive: true });

    const detected = detectWorkspaces(configDir);
    const alpha = detected.find((ws) => ws.id === "alpha");

    expect(alpha).toBeDefined();
    expect(alpha.repos).toHaveLength(1);
    expect(alpha.repos[0].name).toBe("repo-one");
    expect(alpha.repos[0].slug).toBe("virtengine/repo-one");
    expect(detected.some((ws) => ws.id === "empty")).toBe(false);
  });
});

describe("mergeDetectedWorkspaces", () => {
  it("updates existing workspaces without duplicating repos and keeps the active workspace", () => {
    const configDir = createConfigDir();
    const workspacesDir = join(configDir, "workspaces");
    const alphaDir = join(workspacesDir, "alpha");
    const betaDir = join(workspacesDir, "beta");

    createGitRepo(join(alphaDir, "common"), "git@github.com:virtengine/common.git");
    createGitRepo(join(alphaDir, "extra"), "git@github.com:virtengine/extra.git");
    createGitRepo(join(betaDir, "other"), "git@github.com:virtengine/other.git");

    writeBosunConfig(configDir, {
      workspaces: [
        {
          id: "alpha",
          name: "Alpha",
          repos: [
            {
              name: "common",
              url: "https://example.com/common.git",
            },
          ],
          activeRepo: "common",
        },
      ],
      activeWorkspace: "alpha",
    });

    const result = mergeDetectedWorkspaces(configDir);
    const config = readConfig(configDir);
    const alpha = config.workspaces.find((ws) => ws.id === "alpha");
    const beta = config.workspaces.find((ws) => ws.id === "beta");

    expect(result.added).toBeGreaterThanOrEqual(1);
    expect(result.updated).toBeGreaterThanOrEqual(1);
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();
    expect(alpha.repos.filter((repo) => repo.name === "common")).toHaveLength(1);
    expect(alpha.repos.some((repo) => repo.name === "extra")).toBe(true);
    expect(alpha.repos.find((repo) => repo.name === "common").slug).toBe("virtengine/common");
    expect(config.activeWorkspace).toBe("alpha");
  }, 15000);
});

describe("listWorkspaces", () => {
  it("uses repoRoot override when workspace path is missing", () => {
    const configDir = createConfigDir();
    const altRoot = join(configDir, "alternate-repos");
    const missingRepoPath = join(altRoot, "missing-repo");
    mkdirSync(join(missingRepoPath, ".git"), { recursive: true });

    writeBosunConfig(configDir, {
      workspaces: [
        {
          id: "primary",
          name: "Primary",
          repos: [
            {
              name: "missing-repo",
              url: "",
              slug: "",
            },
          ],
        },
      ],
      activeWorkspace: "primary",
    });

    const [workspace] = listWorkspaces(configDir, { repoRoot: altRoot });
    const [repo] = workspace.repos;

    expect(workspace.exists).toBe(true);
    expect(repo.exists).toBe(true);
    expect(repo.path).toBe(missingRepoPath);
  });

  it("uses local repo URL path when configured workspace clone path is missing", () => {
    const configDir = createConfigDir();
    const localReposRoot = join(configDir, "local-repos");
    const localBosunPath = join(localReposRoot, "bosun");
    mkdirSync(join(localBosunPath, ".git"), { recursive: true });

    writeBosunConfig(configDir, {
      workspaces: [
        {
          id: "virtengine-gh",
          name: "virtengine-gh",
          repos: [
            {
              name: "bosun",
              url: localBosunPath,
              slug: "virtengine/bosun",
            },
          ],
        },
      ],
      activeWorkspace: "virtengine-gh",
    });

    const [workspace] = listWorkspaces(configDir, { repoRoot: join(configDir, "unrelated-root") });
    const [repo] = workspace.repos;

    expect(workspace.exists).toBe(true);
    expect(repo.exists).toBe(true);
    expect(repo.path).toBe(localBosunPath);
  });

  it("preserves explicit workspace and repo paths from config", () => {
    const configDir = createConfigDir();
    const externalWorkspacePath = join(configDir, "external-workspace");
    const externalRepoPath = join(configDir, "external-repo");
    mkdirSync(join(externalRepoPath, ".git"), { recursive: true });

    writeBosunConfig(configDir, {
      workspaces: [
        {
          id: "primary",
          name: "Primary",
          path: externalWorkspacePath,
          repos: [
            {
              name: "repo",
              path: externalRepoPath,
              primary: true,
            },
          ],
          activeRepo: "repo",
        },
      ],
      activeWorkspace: "primary",
    });

    const [workspace] = listWorkspaces(configDir);
    const [repo] = workspace.repos;

    expect(workspace.path).toBe(externalWorkspacePath);
    expect(repo.path).toBe(externalRepoPath);
    expect(workspace.exists).toBe(true);
    expect(repo.exists).toBe(true);
  });

  it("normalizes slug-only workspace repos so listing never crashes", () => {
    const configDir = createConfigDir();

    writeBosunConfig(configDir, {
      workspaces: [
        {
          id: "virtengine",
          name: "VirtEngine",
          repos: [
            { slug: "virtengine/bosun" },
            "virtengine/virtengine",
          ],
        },
      ],
      activeWorkspace: "virtengine",
    });

    const [workspace] = listWorkspaces(configDir);
    expect(workspace).toBeDefined();
    expect(workspace.repos).toHaveLength(2);
    expect(workspace.repos[0].name).toBe("bosun");
    expect(workspace.repos[1].name).toBe("virtengine");
    expect(
      workspace.repos[0].path.replace(/\\/g, "/").endsWith("/workspaces/virtengine/bosun"),
    ).toBe(true);
  });
});

describe("pullWorkspaceRepos", () => {
  it("recovers non-git repo directory by backing it up and recloning", () => {
    const configDir = createConfigDir();
    const remoteUrl = createSeededBareRemote(configDir, "recover-test");

    writeBosunConfig(configDir, {
      workspaces: [
        {
          id: "alpha",
          name: "Alpha",
          repos: [
            {
              name: "bosun",
              url: remoteUrl,
            },
          ],
          activeRepo: "bosun",
        },
      ],
      activeWorkspace: "alpha",
    });

    const repoPath = join(configDir, "workspaces", "alpha", "bosun");
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(join(repoPath, "stale.txt"), "old local content\n", "utf8");

    const results = pullWorkspaceRepos(configDir, "alpha");
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(existsSync(join(repoPath, ".git"))).toBe(true);
    expect(existsSync(join(repoPath, "README.md"))).toBe(true);

    const wsEntries = readdirSync(join(configDir, "workspaces", "alpha"));
    const backupDir = wsEntries.find((entry) => entry.startsWith("bosun.non-git-backup-"));
    expect(backupDir).toBeTruthy();
    expect(existsSync(join(configDir, "workspaces", "alpha", backupDir, "stale.txt"))).toBe(true);
  }, 60000);
});
