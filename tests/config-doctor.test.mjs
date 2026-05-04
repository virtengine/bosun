import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runConfigDoctor,
  formatConfigDoctorReport,
} from "../config/config-doctor.mjs";

describe("config-doctor", () => {
  it("returns structured result", () => {
    const result = runConfigDoctor();
    expect(result).toBeDefined();
    expect(typeof result.ok).toBe("boolean");
    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(Array.isArray(result.infos)).toBe(true);
    expect(result.details).toBeDefined();
  });

  it("formats report text", () => {
    const result = runConfigDoctor();
    const output = formatConfigDoctorReport(result);
    expect(typeof output).toBe("string");
    expect(output).toContain("bosun config doctor");
    expect(output).toContain("Status:");
  });

  it("detects telegram partial config mismatch", () => {
    const originalToken = process.env.TELEGRAM_BOT_TOKEN;
    const originalChatId = process.env.TELEGRAM_CHAT_ID;
    try {
      process.env.TELEGRAM_BOT_TOKEN = "123:abc";
      process.env.TELEGRAM_CHAT_ID = "";
      const result = runConfigDoctor();
      const hasMismatch = result.errors.some(
        (issue) => issue.code === "TELEGRAM_PARTIAL",
      );
      expect(hasMismatch).toBe(true);
    } finally {
      if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = originalToken;

      if (originalChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
      else process.env.TELEGRAM_CHAT_ID = originalChatId;
    }
  });

  it("detects missing Jira config when KANBAN_BACKEND=jira", () => {
    const saved = {
      KANBAN_BACKEND: process.env.KANBAN_BACKEND,
      JIRA_BASE_URL: process.env.JIRA_BASE_URL,
      JIRA_EMAIL: process.env.JIRA_EMAIL,
      JIRA_API_TOKEN: process.env.JIRA_API_TOKEN,
      JIRA_PROJECT_KEY: process.env.JIRA_PROJECT_KEY,
      KANBAN_PROJECT_ID: process.env.KANBAN_PROJECT_ID,
    };
    try {
      process.env.KANBAN_BACKEND = "jira";
      process.env.JIRA_BASE_URL = "";
      process.env.JIRA_EMAIL = "";
      process.env.JIRA_API_TOKEN = "";
      process.env.JIRA_PROJECT_KEY = "";
      process.env.KANBAN_PROJECT_ID = "";

      const result = runConfigDoctor();
      const hasJiraMissingError = result.errors.some(
        (issue) => issue.code === "JIRA_BACKEND_REQUIRED",
      );
      expect(hasJiraMissingError).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("warns when named tunnel is selected without Cloudflare tunnel credentials", () => {
    const saved = {
      TELEGRAM_UI_TUNNEL: process.env.TELEGRAM_UI_TUNNEL,
      CLOUDFLARE_TUNNEL_NAME: process.env.CLOUDFLARE_TUNNEL_NAME,
      CLOUDFLARE_TUNNEL_CREDENTIALS: process.env.CLOUDFLARE_TUNNEL_CREDENTIALS,
    };
    try {
      process.env.TELEGRAM_UI_TUNNEL = "named";
      process.env.CLOUDFLARE_TUNNEL_NAME = "";
      process.env.CLOUDFLARE_TUNNEL_CREDENTIALS = "";

      const result = runConfigDoctor();
      expect(
        result.warnings.some(
          (issue) => issue.code === "CLOUDFLARE_NAMED_TUNNEL_CONFIG_MISSING",
        ),
      ).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("warns when WORKFLOW.md exists but workflow contract steps are not enabled", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "config-doctor-workflow-contract-"));
    const workflowDir = join(repoRoot, ".bosun", "workflows");
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(join(repoRoot, "WORKFLOW.md"), [
      "terminalStates: [done]",
      "forbiddenPatterns: [git push --force]",
    ].join("\n"));
    writeFileSync(join(workflowDir, "task-lifecycle.json"), JSON.stringify({
      id: "wf-1",
      enabled: true,
      nodes: [
        { id: "prompt", type: "action.build_task_prompt", config: {} },
      ],
    }, null, 2));

    try {
      const result = runConfigDoctor({ repoRoot, configDir: repoRoot });
      expect(result.warnings.some((issue) => issue.code === "WORKFLOW_CONTRACT_STEP_DISABLED")).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("does not warn when an enabled workflow includes both workflow contract steps", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "config-doctor-workflow-enabled-"));
    const workflowDir = join(repoRoot, ".bosun", "workflows");
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(join(repoRoot, "WORKFLOW.md"), [
      "terminalStates: [done]",
      "forbiddenPatterns: [git push --force]",
    ].join("\n"));
    writeFileSync(join(workflowDir, "task-lifecycle.json"), JSON.stringify({
      id: "wf-1",
      enabled: true,
      nodes: [
        { id: "read", type: "read-workflow-contract", config: {} },
        { id: "validate", type: "workflow-contract-validation", config: {} },
      ],
    }, null, 2));

    try {
      const result = runConfigDoctor({ repoRoot, configDir: repoRoot });
      expect(result.warnings.some((issue) => issue.code === "WORKFLOW_CONTRACT_STEP_DISABLED")).toBe(false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  // ── API Key Validation ──────────────────────────────────────────────

  describe("API key validation", () => {
    /** Helper to run config doctor with env overrides */
    function runWith(envOverrides) {
      const saved = {};
      for (const [k, v] of Object.entries(envOverrides)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      try {
        return runConfigDoctor();
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    }

    it("detects missing OPENAI_API_KEY when codex executor is configured", () => {
      const result = runWith({
        EXECUTORS: "codex:default",
        OPENAI_API_KEY: "",
        AZURE_OPENAI_API_KEY: "",
      });
      const hasError = result.errors.some(
        (e) => e.code === "OPENAI_API_KEY_MISSING",
      );
      expect(hasError).toBe(true);
    });

    it("does NOT report OPENAI_API_KEY_MISSING when key is set", () => {
      const result = runWith({
        EXECUTORS: "codex:default",
        OPENAI_API_KEY: "sk-test-1234567890abcdef",
      });
      const hasError = result.errors.some(
        (e) => e.code === "OPENAI_API_KEY_MISSING",
      );
      expect(hasError).toBe(false);
    });

    it("accepts AZURE_OPENAI_API_KEY as alternative for codex", () => {
      const result = runWith({
        EXECUTORS: "codex:default",
        OPENAI_API_KEY: "",
        AZURE_OPENAI_API_KEY: "azure-key-12345",
      });
      const hasError = result.errors.some(
        (e) => e.code === "OPENAI_API_KEY_MISSING",
      );
      expect(hasError).toBe(false);
    });

    it("detects missing ANTHROPIC_API_KEY when claude executor is configured", () => {
      const result = runWith({
        EXECUTORS: "claude:default",
        ANTHROPIC_API_KEY: "",
        CLAUDE_API_KEY: "",
        CLAUDE_KEY: "",
      });
      const hasError = result.errors.some(
        (e) => e.code === "ANTHROPIC_API_KEY_MISSING",
      );
      expect(hasError).toBe(true);
    });

    it("does NOT report ANTHROPIC_API_KEY_MISSING when any Claude key is set", () => {
      const result = runWith({
        EXECUTORS: "claude:default",
        ANTHROPIC_API_KEY: "sk-ant-test-1234567890",
      });
      const hasError = result.errors.some(
        (e) => e.code === "ANTHROPIC_API_KEY_MISSING",
      );
      expect(hasError).toBe(false);
    });

    it("warns when ANTHROPIC_API_KEY has unexpected prefix", () => {
      const result = runWith({
        EXECUTORS: "claude:default",
        ANTHROPIC_API_KEY: "wrong-prefix-key-12345",
      });
      const hasWarning = result.warnings.some(
        (w) => w.code === "ANTHROPIC_API_KEY_FORMAT",
      );
      expect(hasWarning).toBe(true);
    });

    it("does NOT warn for correct Anthropic key prefix", () => {
      const result = runWith({
        EXECUTORS: "claude:default",
        ANTHROPIC_API_KEY: "sk-ant-correct-prefix-12345",
      });
      const hasWarning = result.warnings.some(
        (w) => w.code === "ANTHROPIC_API_KEY_FORMAT",
      );
      expect(hasWarning).toBe(false);
    });

    it("warns about missing GITHUB_TOKEN for copilot executor", () => {
      const result = runWith({
        EXECUTORS: "copilot:default",
        GITHUB_TOKEN: "",
      });
      const hasWarning = result.warnings.some(
        (w) => w.code === "GITHUB_TOKEN_MISSING",
      );
      expect(hasWarning).toBe(true);
    });

    it("detects missing GEMINI API key when gemini executor is configured", () => {
      const result = runWith({
        EXECUTORS: "gemini:default",
        GEMINI_API_KEY: "",
        GOOGLE_API_KEY: "",
      });
      const hasError = result.errors.some(
        (e) => e.code === "GEMINI_API_KEY_MISSING",
      );
      expect(hasError).toBe(true);
    });

    it("does NOT report GEMINI_API_KEY_MISSING when Gemini key is set", () => {
      const result = runWith({
        EXECUTORS: "gemini:default",
        GEMINI_API_KEY: "test-gemini-key",
      });
      const hasError = result.errors.some(
        (e) => e.code === "GEMINI_API_KEY_MISSING",
      );
      expect(hasError).toBe(false);
    });

    it("does NOT skip validation when no matching executor", () => {
      const result = runWith({
        EXECUTORS: "claude:default",
        OPENAI_API_KEY: "",
        AZURE_OPENAI_API_KEY: "",
      });
      // Should NOT flag OPENAI since codex is not in executors
      const hasOpenAIError = result.errors.some(
        (e) => e.code === "OPENAI_API_KEY_MISSING",
      );
      expect(hasOpenAIError).toBe(false);
    });

    it("detects model name with whitespace", () => {
      const result = runWith({
        COPILOT_MODEL: "gpt-4 turbo",
      });
      const hasError = result.errors.some(
        (e) => e.code === "COPILOT_MODEL_INVALID",
      );
      expect(hasError).toBe(true);
    });

    it("does NOT flag clean model names", () => {
      const result = runWith({
        COPILOT_MODEL: "gpt-4-turbo",
        CLAUDE_MODEL: "claude-sonnet-4-20250514",
      });
      const hasModelError = result.errors.some(
        (e) => e.code && e.code.endsWith("_INVALID") && e.code.includes("MODEL"),
      );
      expect(hasModelError).toBe(false);
    });
  });
});
