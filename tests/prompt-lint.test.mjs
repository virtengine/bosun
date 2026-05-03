import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { AGENT_PROMPT_DEFINITIONS, DEFAULT_PROMPTS } from "../agent/agent-prompt-catalog.mjs";
import { ensureAgentPromptWorkspace } from "../agent/agent-prompts.mjs";
import { NARRATION_LINT_PATTERNS, collectPromptLintViolations } from "../tools/prompt-lint.mjs";

let testRoot;

async function makeTempRoot() {
  const dir = await mkdtemp(resolve(tmpdir(), "prompt-lint-test-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("prompt lint", () => {
  beforeEach(async () => {
    testRoot = await makeTempRoot();
  });

  afterEach(async () => {
    if (testRoot && existsSync(testRoot)) {
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  it("keeps every builtin prompt template narration-free", () => {
    expect(AGENT_PROMPT_DEFINITIONS.length).toBeGreaterThan(20);
    expect(NARRATION_LINT_PATTERNS.length).toBeGreaterThan(0);
    expect(NARRATION_LINT_PATTERNS.some((p) => /let.me/i.test(p.id))).toBe(true);
    expect(NARRATION_LINT_PATTERNS.some((p) => /i.will/i.test(p.id))).toBe(true);

    for (const definition of AGENT_PROMPT_DEFINITIONS) {
      const content = DEFAULT_PROMPTS[definition.key];
      expect(content).toBeTruthy();
      const lines = content.split(/\r?\n/);
      const violations = [];
      for (const line of lines) {
        for (const rule of NARRATION_LINT_PATTERNS) {
          if (rule.pattern.test(line)) {
            violations.push({ rule: rule.id, snippet: line.trim() });
          }
        }
      }
      expect(violations).toEqual([]);
    }
  });

  it("scaffolds prompt templates into .bosun/agents without lint violations", () => {
    const scaffold = ensureAgentPromptWorkspace(testRoot);
    const violations = collectPromptLintViolations(testRoot);

    expect(scaffold.workspaceDir).toBe(resolve(testRoot, ".bosun", "agents"));
    expect(scaffold.written).toHaveLength(AGENT_PROMPT_DEFINITIONS.length);
    expect(violations).toEqual([]);
  });

  it("flags narration regressions inside workspace prompt files", async () => {
    const promptDir = resolve(testRoot, ".bosun", "agents");
    mkdirSync(promptDir, { recursive: true });
    const promptPath = resolve(promptDir, "orchestrator.md");

    await writeFile(promptPath, "# Override\n\nI will use TodoWrite to narrate every step.\n", "utf8");

    const violations = collectPromptLintViolations(testRoot);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: ".bosun/agents/orchestrator.md",
          rule: "i-will-use",
        }),
      ]),
    );
  });

  it("reports no violations for prompt files without narration patterns", async () => {
    execFileSync("git", ["init"], { cwd: testRoot, stdio: "ignore" });
    await writeFile(resolve(testRoot, ".gitignore"), "/.bosun/\n", "utf8");
    const promptDir = resolve(testRoot, ".bosun", "agents");
    mkdirSync(promptDir, { recursive: true });
    const promptPath = resolve(promptDir, "clean.md");

    await writeFile(promptPath, "# Clean\n\nExecute the task without narration.\n", "utf8");

    const violations = collectPromptLintViolations(testRoot);
    expect(violations).toEqual([]);
  });

  it("keeps the repo .gitignore parseable for ripgrep-based workflow searches", () => {
    const output = execFileSync("rg", ["--files", "workflow", "tests", "voice"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).replace(/\\/g, "/");

    expect(output).toContain("workflow/workflow-engine.mjs");
    expect(output).toContain("tests/workflow-engine.test.mjs");
  });
  it("keeps CI and pre-commit prompt lint wiring enabled", () => {
    const packageJson = readFileSync(resolve(process.cwd(), "package.json"), "utf8");
    const preCommitHook = readFileSync(resolve(process.cwd(), ".githooks", "pre-commit"), "utf8");

    expect(packageJson).toContain('"prepush:check"');
    expect(packageJson).toContain("npm run prompt:lint");
    expect(preCommitHook).toContain("npm run prompt:lint");
  });
});
