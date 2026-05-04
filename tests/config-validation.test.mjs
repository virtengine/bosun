import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { loadConfig, resolveTrustedAuthorList } from "../config/config.mjs";

const ENV_KEYS = [
  "TELEGRAM_INTERVAL_MIN",
  "INTERNAL_EXECUTOR_PARALLEL",
  "DEPENDABOT_MERGE_METHOD",
  "BOSUN_CONFIG_PATH",
  "BOSUN_HOME",
  "BOSUN_DIR",
  "BOSUN_GITHUB_CLIENT_ID",
  "BOSUN_PR_TRUSTED_AUTHORS",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "INTERNAL_EXECUTOR_SDK",
  "GITHUB_PROJECT_WEBHOOK_PATH",
  "GITHUB_PROJECT_WEBHOOK_SECRET",
  "GITHUB_PROJECT_WEBHOOK_REQUIRE_SIGNATURE",
  "GITHUB_PROJECT_SYNC_ALERT_FAILURE_THRESHOLD",
  "GITHUB_PROJECT_SYNC_RATE_LIMIT_ALERT_THRESHOLD",
  "JIRA_BASE_URL",
  "JIRA_EMAIL",
  "JIRA_API_TOKEN",
  "JIRA_PROJECT_KEY",
  "JIRA_ISSUE_TYPE",
  "JIRA_STATUS_TODO",
  "JIRA_LABEL_IGNORE",
  "JIRA_CUSTOM_FIELD_OWNER_ID",
  "KANBAN_PROJECT_ID",
  "REPO_MIRROR_ENABLED",
  "REPO_MIRROR_REPO_PATH",
  "REPO_MIRROR_SYNC_MODE",
  "REPO_MIRROR_RUN_STORAGE",
  "REPO_MIRROR_MESSAGE_STORAGE",
  "REPO_MIRROR_PUBLIC_ROADMAP_ENABLED",
  "EXECUTORS",
  "TASK_TRIGGER_SYSTEM_ENABLED",
  "KANBAN_BACKEND",
  "BOSUN_AGENT_RUNTIME",
  "BOSUN_ENV_NO_OVERRIDE",
  "BOSUN_LOAD_REPO_ENV_WITH_EXPLICIT_CONFIG",
  "WATCH_PATH",
  "ORCHESTRATOR_SCRIPT",
  "PRIMARY_AGENT",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_SDK_DISABLED",
  "BOSUN_GATES_WORKTREE_REQUIRE_BOOTSTRAP",
  "BOSUN_GATES_WORKTREE_REQUIRE_READINESS",
  "BOSUN_GATES_WORKTREE_ENFORCE_PUSH_HOOK",
  "WORKFLOW_RECOVERY_MAX_ATTEMPTS",
  "WORKFLOW_RECOVERY_ESCALATION_THRESHOLD",
  "WORKFLOW_RECOVERY_BACKOFF_BASE_MS",
  "WORKFLOW_RECOVERY_BACKOFF_MAX_MS",
  "WORKFLOW_RECOVERY_BACKOFF_JITTER_RATIO",
];

describe("loadConfig validation and edge cases", () => {
  let tempConfigDir = "";
  let originalEnv = {};

  beforeEach(async () => {
    tempConfigDir = await mkdtemp(resolve(tmpdir(), "bosun-config-"));
    originalEnv = Object.fromEntries(
      ENV_KEYS.map((key) => [key, process.env[key]]),
    );
    delete process.env.BOSUN_CONFIG_PATH;
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] == null) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    if (tempConfigDir) {
      await rm(tempConfigDir, { recursive: true, force: true });
    }
  });

  it("returns sensible defaults when no overrides are provided", () => {
    delete process.env.TELEGRAM_INTERVAL_MIN;
    delete process.env.INTERNAL_EXECUTOR_PARALLEL;
    delete process.env.DEPENDABOT_MERGE_METHOD;
    delete process.env.WORKFLOW_RECOVERY_MAX_ATTEMPTS;
    delete process.env.WORKFLOW_RECOVERY_ESCALATION_THRESHOLD;
    delete process.env.WORKFLOW_RECOVERY_BACKOFF_BASE_MS;
    delete process.env.WORKFLOW_RECOVERY_BACKOFF_MAX_MS;
    delete process.env.WORKFLOW_RECOVERY_BACKOFF_JITTER_RATIO;

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config.telegramIntervalMin).toBe(10);
    expect(config.internalExecutor.maxParallel).toBe(3);
    expect(config.dependabotMergeMethod).toBe("squash");
    expect(config.workflowRecovery).toEqual({
      maxAttempts: 5,
      escalationWarnAfterAttempts: 3,
      baseBackoffMs: 5000,
      maxBackoffMs: 60_000,
      jitterRatio: 0.2,
    });
  });

  it("loads workflow recovery policy from config file and allows env overrides", async () => {
    await writeFile(
      resolve(tempConfigDir, "bosun.config.json"),
      JSON.stringify(
        {
          workflowRecovery: {
            maxAttempts: 7,
            escalationWarnAfterAttempts: 4,
            baseBackoffMs: 2500,
            maxBackoffMs: 45_000,
            jitterRatio: 0.35,
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    process.env.WORKFLOW_RECOVERY_MAX_ATTEMPTS = "6";
    process.env.WORKFLOW_RECOVERY_BACKOFF_BASE_MS = "1500";

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config.workflowRecovery).toEqual({
      maxAttempts: 6,
      escalationWarnAfterAttempts: 4,
      baseBackoffMs: 1500,
      maxBackoffMs: 45_000,
      jitterRatio: 0.35,
    });
  });

  it("derives managed worktree gate defaults from worktree bootstrap", async () => {
    await writeFile(
      resolve(tempConfigDir, "bosun.config.json"),
      JSON.stringify(
        {
          worktreeBootstrap: {
            enabled: true,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config.gates.worktrees).toEqual({
      requireBootstrap: true,
      requireReadiness: true,
      enforcePushHook: true,
    });
  });

  it("uses explicit bootstrap disablement for managed worktree gate defaults", async () => {
    await writeFile(
      resolve(tempConfigDir, "bosun.config.json"),
      JSON.stringify(
        {
          worktreeBootstrap: {
            enabled: false,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config.gates.worktrees).toEqual({
      requireBootstrap: false,
      requireReadiness: false,
      enforcePushHook: true,
    });
  });

  it("allows managed worktree gate overrides independent of bootstrap defaults", async () => {
    await writeFile(
      resolve(tempConfigDir, "bosun.config.json"),
      JSON.stringify(
        {
          worktreeBootstrap: {
            enabled: true,
          },
          gates: {
            worktrees: {
              requireBootstrap: false,
              requireReadiness: true,
              enforcePushHook: true,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config.gates.worktrees).toEqual({
      requireBootstrap: false,
      requireReadiness: true,
      enforcePushHook: true,
    });
  });

  it("applies env overrides to managed worktree gate policy", async () => {
    await writeFile(
      resolve(tempConfigDir, "bosun.config.json"),
      JSON.stringify(
        {
          worktreeBootstrap: {
            enabled: false,
          },
          gates: {
            worktrees: {
              requireBootstrap: false,
              requireReadiness: false,
              enforcePushHook: false,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    process.env.BOSUN_GATES_WORKTREE_REQUIRE_BOOTSTRAP = "true";
    process.env.BOSUN_GATES_WORKTREE_REQUIRE_READINESS = "1";
    process.env.BOSUN_GATES_WORKTREE_ENFORCE_PUSH_HOOK = "yes";

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config.gates.worktrees).toEqual({
      requireBootstrap: true,
      requireReadiness: true,
      enforcePushHook: true,
    });
  });

  it("falls back to safe workflow recovery defaults when overrides are invalid", () => {
    process.env.WORKFLOW_RECOVERY_MAX_ATTEMPTS = "0";
    process.env.WORKFLOW_RECOVERY_ESCALATION_THRESHOLD = "99";
    process.env.WORKFLOW_RECOVERY_BACKOFF_BASE_MS = "-1";
    process.env.WORKFLOW_RECOVERY_BACKOFF_MAX_MS = "999999999";
    process.env.WORKFLOW_RECOVERY_BACKOFF_JITTER_RATIO = "2";

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config.workflowRecovery).toEqual({
      maxAttempts: 5,
      escalationWarnAfterAttempts: 3,
      baseBackoffMs: 5000,
      maxBackoffMs: 60_000,
      jitterRatio: 0.2,
    });
  });

  it("prefers repo-local .bosun config when repo root has a configured runtime", async () => {
    const repoRoot = resolve(tempConfigDir, "repo");
    const repoConfigDir = resolve(repoRoot, ".bosun");
    const appDataDir = resolve(tempConfigDir, "appdata");

    await mkdir(repoConfigDir, { recursive: true });
    await mkdir(appDataDir, { recursive: true });
    await writeFile(resolve(repoConfigDir, "bosun.config.json"), "{}", "utf8");

    delete process.env.BOSUN_HOME;
    delete process.env.BOSUN_DIR;
    process.env.APPDATA = appDataDir;
    process.env.LOCALAPPDATA = appDataDir;
    process.env.USERPROFILE = appDataDir;
    process.env.HOME = appDataDir;
    process.env.XDG_CONFIG_HOME = appDataDir;

    const config = loadConfig([
      "node",
      "bosun",
      "--repo-root",
      repoRoot,
    ]);

    expect(config.configDir).toBe(repoConfigDir);
  });

  it("loads .bosun env when BOSUN_HOME is declared in repo .env", async () => {
    const repoRoot = resolve(tempConfigDir, "repo-from-env");
    const repoConfigDir = resolve(repoRoot, ".bosun");

    await mkdir(repoConfigDir, { recursive: true });
    await writeFile(
      resolve(repoRoot, ".env"),
      `BOSUN_HOME=${repoConfigDir}\n`,
      "utf8",
    );
    await writeFile(
      resolve(repoConfigDir, ".env"),
      "TELEGRAM_INTERVAL_MIN=42\nBOSUN_GITHUB_CLIENT_ID=test-client-id\n",
      "utf8",
    );

    delete process.env.BOSUN_HOME;
    delete process.env.BOSUN_DIR;
    delete process.env.BOSUN_GITHUB_CLIENT_ID;
    delete process.env.TELEGRAM_INTERVAL_MIN;

    const config = loadConfig([
      "node",
      "bosun",
      "--repo-root",
      repoRoot,
    ]);

    expect(config.configDir).toBe(repoConfigDir);
    expect(config.telegramIntervalMin).toBe(42);
    expect(process.env.BOSUN_GITHUB_CLIENT_ID).toBe("test-client-id");
  });

  it("auto-trusts the connected GitHub OAuth login for PR automation", () => {
    expect(
      resolveTrustedAuthorList(["release-bot", "Jaeko44"], {
        includeOAuthTrustedAuthor: true,
        oauthTrustedAuthor: "jaeko44",
      }),
    ).toEqual(["release-bot", "Jaeko44"]);

    expect(
      resolveTrustedAuthorList("ops-bot", {
        includeOAuthTrustedAuthor: true,
        oauthTrustedAuthor: "jaeko44",
      }),
    ).toEqual(["ops-bot", "jaeko44"]);
  });

  it("accepts valid env overrides", () => {
    process.env.TELEGRAM_INTERVAL_MIN = "30";
    process.env.INTERNAL_EXECUTOR_PARALLEL = "5";
    process.env.DEPENDABOT_MERGE_METHOD = "merge";

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config.telegramIntervalMin).toBe(30);
    expect(config.internalExecutor.maxParallel).toBe(5);
    expect(config.dependabotMergeMethod).toBe("merge");
  });

  it("loadConfig does not throw on malformed JSON config file", async () => {
    await writeFile(
      resolve(tempConfigDir, "bosun.config.json"),
      "{ invalid-json",
      "utf8",
    );

    // Should not throw — falls back to defaults
    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config).toBeDefined();
    expect(config.internalExecutor.maxParallel).toBe(3);
  }, 10000);

  it("returns a config object with expected shape", () => {
    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(typeof config.telegramIntervalMin).toBe("number");
    expect(typeof config.internalExecutor).toBe("object");
    expect(typeof config.internalExecutor.maxParallel).toBe("number");
    expect(typeof config.internalExecutor.sdk).toBe("string");
    expect(typeof config.dependabotMergeMethod).toBe("string");
    expect(typeof config.statusPath).toBe("string");
    expect(typeof config.telegramPollLockPath).toBe("string");
    expect(typeof config.githubProjectSync).toBe("object");
    expect(typeof config.githubProjectSync.webhookPath).toBe("string");
    expect(typeof config.githubProjectSync.webhookRequireSignature).toBe(
      "boolean",
    );
    expect(typeof config.jira).toBe("object");
    expect(typeof config.jira.projectKey).toBe("string");
    expect(typeof config.triggerSystem).toBe("object");
    expect(typeof config.workflowRecovery).toBe("object");
    expect(typeof config.workflowRecovery.maxAttempts).toBe("number");
    expect(typeof config.workflowRecovery.escalationWarnAfterAttempts).toBe("number");
    expect(typeof config.gates).toBe("object");
    expect(typeof config.gates.worktrees).toBe("object");
    expect(typeof config.gates.worktrees.requireBootstrap).toBe("boolean");
    expect(typeof config.gates.worktrees.requireReadiness).toBe("boolean");
    expect(typeof config.gates.worktrees.enforcePushHook).toBe("boolean");
    expect(Array.isArray(config.triggerSystem.templates)).toBe(true);
    expect(typeof config.workflowDefaults).toBe("object");
    expect(Array.isArray(config.workflows)).toBe(true);
  });

  it("normalizes typed workflow entries from bosun.config.json", async () => {
    await writeFile(
      resolve(tempConfigDir, "bosun.config.json"),
      JSON.stringify(
        {
          workflows: [
            {
              type: "continuation-loop",
              enabled: true,
              taskId: "LIN-123",
              maxTurns: 5,
              pollIntervalMs: 2500,
              terminalStates: ["Done", "Cancelled", "done"],
              stuckThresholdMs: 120000,
              onStuck: "pause",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(Array.isArray(config.workflows)).toBe(true);
    expect(config.workflows).toHaveLength(1);
    expect(config.workflows[0]).toMatchObject({
      type: "continuation-loop",
      enabled: true,
      taskId: "LIN-123",
      maxTurns: 5,
      pollIntervalMs: 2500,
      terminalStates: ["done", "cancelled"],
      stuckThresholdMs: 120000,
      onStuck: "pause",
    });
  });

  it("parses executor model lists from EXECUTORS env", () => {
    process.env.EXECUTORS =
      "CODEX:DEFAULT:60:gpt-5.2-codex|gpt-5.1-codex-mini,COPILOT:CLAUDE_OPUS_4_6:40:claude-opus-4.6";

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config.executorConfig.executors[0].models).toEqual([
      "gpt-5.2-codex",
      "gpt-5.1-codex-mini",
    ]);
    expect(config.executorConfig.executors[1].models).toEqual([
      "claude-opus-4.6",
    ]);
  });

  it("preserves custom/deployment model slugs from EXECUTORS env", () => {
    process.env.EXECUTORS =
      "CODEX:DEFAULT:100:gpt-5.2-codex|my-azure-deployment-42";

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config.executorConfig.executors[0].models).toEqual([
      "gpt-5.2-codex",
      "my-azure-deployment-42",
    ]);
  });

  it("preserves executor metadata from config file when EXECUTORS env is set", async () => {
    process.env.EXECUTORS = "CODEX:GPT51_CODEX_MINI:100";

    await writeFile(
      resolve(tempConfigDir, "bosun.config.json"),
      JSON.stringify(
        {
          executors: [
            {
              name: "codex-mini",
              executor: "CODEX",
              variant: "GPT51_CODEX_MINI",
              weight: 100,
              role: "primary",
              enabled: false,
              models: ["gpt-5.1-codex-mini"],
              codexProfile: "executor-2-profile",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config.executorConfig.executors[0].name).toBe("codex-mini");
    expect(config.executorConfig.executors[0].enabled).toBe(false);
    expect(config.executorConfig.executors[0].models).toEqual([
      "gpt-5.1-codex-mini",
    ]);
    expect(config.executorConfig.executors[0].codexProfile).toBe("executor-2-profile");
  });

  it("infers model allow-list from variant when EXECUTORS entry has no model list", () => {
    process.env.EXECUTORS = "COPILOT:CLAUDE_OPUS_4_6:100";

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config.executorConfig.executors[0].models).toContain("claude-opus-4.6");
    expect(config.executorConfig.executors[0].models).not.toContain("gpt-5.2-codex");
  });

  it("parses Gemini executor models from EXECUTORS env", () => {
    process.env.EXECUTORS =
      "GEMINI:DEFAULT:100:gemini-2.5-pro|gemini-2.5-flash";

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config.executorConfig.executors[0].executor).toBe("GEMINI");
    expect(config.executorConfig.executors[0].models).toEqual([
      "gemini-2.5-pro",
      "gemini-2.5-flash",
    ]);
  });

  it("normalizes PRIMARY_AGENT=gemini to gemini-sdk", () => {
    process.env.PRIMARY_AGENT = "gemini";

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config.primaryAgent).toBe("gemini-sdk");
  });

  it("defaults agent runtime to harness and normalizes legacy hybrid executor mode", () => {
    process.env.EXECUTOR_MODE = "hybrid";

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config.agentRuntime).toBe("harness");
    expect(config.internalExecutor.mode).toBe("internal");
  });

  it("accepts BOSUN_AGENT_RUNTIME=sdk-cli", () => {
    process.env.BOSUN_AGENT_RUNTIME = "sdk-cli";

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config.agentRuntime).toBe("sdk-cli");
  });

  it("keeps trigger system disabled by default", () => {
    delete process.env.TASK_TRIGGER_SYSTEM_ENABLED;
    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);
    expect(config.triggerSystem?.enabled).toBe(false);
    expect(
      (config.triggerSystem?.templates || []).every((template) => template.enabled === false),
    ).toBe(true);
  });

  it("treats empty telegram credentials as disabled", () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config.telegramToken).toBeFalsy();
    expect(config.telegramChatId).toBeFalsy();
  });

  it("loads github project webhook sync settings from env", () => {
    process.env.GITHUB_PROJECT_WEBHOOK_PATH = "/hooks/github/project-sync";
    process.env.GITHUB_PROJECT_WEBHOOK_SECRET = "secret-1";
    process.env.GITHUB_PROJECT_WEBHOOK_REQUIRE_SIGNATURE = "true";
    process.env.GITHUB_PROJECT_SYNC_ALERT_FAILURE_THRESHOLD = "4";
    process.env.GITHUB_PROJECT_SYNC_RATE_LIMIT_ALERT_THRESHOLD = "5";

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config.githubProjectSync.webhookPath).toBe(
      "/hooks/github/project-sync",
    );
    expect(config.githubProjectSync.webhookSecret).toBe("secret-1");
    expect(config.githubProjectSync.webhookRequireSignature).toBe(true);
    expect(config.githubProjectSync.alertFailureThreshold).toBe(4);
    expect(config.githubProjectSync.rateLimitAlertThreshold).toBe(5);
  });

  it("loads jira mapping settings from env", () => {
    process.env.KANBAN_BACKEND = "jira";
    delete process.env.KANBAN_PROJECT_ID;
    delete process.env.REPO_MIRROR_ENABLED;
    delete process.env.REPO_MIRROR_REPO_PATH;
    delete process.env.REPO_MIRROR_SYNC_MODE;
    process.env.JIRA_BASE_URL = "https://acme.atlassian.net";
    process.env.JIRA_EMAIL = "bot@acme.dev";
    process.env.JIRA_API_TOKEN = "token-1";
    process.env.JIRA_PROJECT_KEY = "ENG";
    process.env.JIRA_ISSUE_TYPE = "Bug";
    process.env.JIRA_STATUS_TODO = "Backlog";
    process.env.JIRA_LABEL_IGNORE = "codex-ignore";
    process.env.JIRA_CUSTOM_FIELD_OWNER_ID = "customfield_10042";

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
    ]);

    expect(config.jira.baseUrl).toBe("https://acme.atlassian.net");
    expect(config.jira.email).toBe("bot@acme.dev");
    expect(config.jira.apiToken).toBe("token-1");
    expect(config.jira.projectKey).toBe("ENG");
    expect(config.jira.issueType).toBe("Bug");
    expect(config.jira.statusMapping.todo).toBe("Backlog");
    expect(config.jira.labels.ignore).toBe("codex-ignore");
    expect(config.jira.sharedStateFields.ownerId).toBe("customfield_10042");
  });

  it("fails fast when jira backend is selected without required jira config", () => {
    process.env.KANBAN_BACKEND = "jira";
    delete process.env.KANBAN_PROJECT_ID;
    delete process.env.REPO_MIRROR_ENABLED;
    delete process.env.REPO_MIRROR_REPO_PATH;
    delete process.env.REPO_MIRROR_SYNC_MODE;
    process.env.JIRA_BASE_URL = "";
    process.env.JIRA_EMAIL = "";
    process.env.JIRA_API_TOKEN = "";
    process.env.JIRA_PROJECT_KEY = "";

    expect(() =>
      loadConfig([
        "node",
        "bosun",
        "--config-dir",
        tempConfigDir,
        "--repo-root",
        tempConfigDir,
      ]),
    ).toThrow(/KANBAN_BACKEND=jira requires/i);
  });

  it("loads repo-mirror projection settings from env", () => {
    process.env.KANBAN_BACKEND = "repo-mirror";
    process.env.REPO_MIRROR_ENABLED = "true";
    process.env.REPO_MIRROR_REPO_PATH = "/tmp/repo-mirror-projection";
    process.env.REPO_MIRROR_SYNC_MODE = "projection";
    process.env.REPO_MIRROR_RUN_STORAGE = "local";
    process.env.REPO_MIRROR_MESSAGE_STORAGE = "git";
    process.env.REPO_MIRROR_PUBLIC_ROADMAP_ENABLED = "true";

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config.kanban.backend).toBe("repo-mirror");
    expect(config.repoMirror).toEqual({
      enabled: true,
      repoPath: "/tmp/repo-mirror-projection",
      syncMode: "projection",
      runStorage: "local",
      messageStorage: "git",
      publicRoadmapEnabled: true,
    });
  });

  it("fails fast when repo-mirror backend is selected without enablement and repo path", () => {
    process.env.KANBAN_BACKEND = "repo-mirror";
    process.env.REPO_MIRROR_ENABLED = "false";
    process.env.REPO_MIRROR_REPO_PATH = "";
    process.env.REPO_MIRROR_SYNC_MODE = "projection";

    expect(() =>
      loadConfig([
        "node",
        "bosun",
        "--config-dir",
        tempConfigDir,
        "--repo-root",
        tempConfigDir,
      ]),
    ).toThrow(/KANBAN_BACKEND=repo-mirror requires/i);
  });

  it("fails fast when repo-mirror backend is selected with unsupported sync mode", () => {
    process.env.KANBAN_BACKEND = "repo-mirror";
    process.env.REPO_MIRROR_ENABLED = "true";
    process.env.REPO_MIRROR_REPO_PATH = "/tmp/repo-mirror-projection";
    process.env.REPO_MIRROR_SYNC_MODE = "full";

    expect(() =>
      loadConfig([
        "node",
        "bosun",
        "--config-dir",
        tempConfigDir,
        "--repo-root",
        tempConfigDir,
      ]),
    ).toThrow(/REPO_MIRROR_SYNC_MODE=projection/i);
  });

  it("watchPath defaults to scriptPath when WATCH_PATH env is not set", () => {
    delete process.env.WATCH_PATH;
    delete process.env.ORCHESTRATOR_SCRIPT;

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    // watchPath should be defined and be a string
    expect(typeof config.watchPath).toBe("string");
    expect(config.watchPath.length).toBeGreaterThan(0);
    // When WATCH_PATH is not set, watchPath should resolve to the scriptPath
    // (or a fallback within the config/repo dirs)
    expect(typeof config.scriptPath).toBe("string");
  });

  it("watchPath uses WATCH_PATH env when set (stale/nonexistent path is accepted as configured)", () => {
    const stalePath = resolve(tempConfigDir, "nonexistent-watch-target.ps1");
    process.env.WATCH_PATH = stalePath;
    delete process.env.ORCHESTRATOR_SCRIPT;

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    // WATCH_PATH env is respected even if path doesn't exist on disk
    expect(config.watchPath).toBe(stalePath);
  });

  it("scriptPath resolves from ORCHESTRATOR_SCRIPT env when set", async () => {
    const { writeFile } = await import("node:fs/promises");
    const scriptFile = resolve(tempConfigDir, "my-custom-orchestrator.ps1");
    await writeFile(scriptFile, "# custom orchestrator", "utf8");
    process.env.ORCHESTRATOR_SCRIPT = scriptFile;
    delete process.env.WATCH_PATH;

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config.scriptPath).toBe(scriptFile);
  });
  it("loads declarative workflow definitions from bosun.config.json", async () => {
    await writeFile(
      resolve(tempConfigDir, "bosun.config.json"),
      JSON.stringify({
        workflows: {
          "code-review": {
            type: "sequential",
            stages: ["implement", "review"],
          },
        },
      }),
      "utf8",
    );

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempConfigDir,
    ]);

    expect(config.workflows["code-review"]).toMatchObject({
      name: "code-review",
      type: "sequential",
    });
    expect(config.workflows["parallel-search"]).toBeTruthy();
  });
});
