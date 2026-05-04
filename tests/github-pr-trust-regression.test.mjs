import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function read(relPath) {
  return readFileSync(resolve(ROOT, relPath), "utf8");
}

describe("GitHub PR trust regressions", () => {
  it("classifies attach policy separately from repair automation", () => {
    const attachWorkflow = read(".github/workflows/bosun-pr-attach.yml");
    const ciSignalWorkflow = read(".github/workflows/bosun-pr-ci-signal.yml");

    expect(attachWorkflow).toContain("const classLabels = {");
    expect(attachWorkflow).toContain("const attachMode = [\"all\", \"trusted-only\", \"disabled\"].includes(attachModeRaw)");
    expect(attachWorkflow).toContain("const labelNames = (pr.labels || [])");
    expect(attachWorkflow).toContain("const isBosunCreated =");
    expect(attachWorkflow).toContain("labelNames.includes(classLabels.bosun)");
    expect(attachWorkflow).toContain("Bosun-created PRs remain attached regardless of human PR attach mode");
    expect(attachWorkflow).toContain("const shouldAttach = isBosunCreated || attachMode === \"all\" || (attachMode === \"trusted-only\" && isTrustedAuthor);");
    expect(attachWorkflow).toContain("bosun-pr-bosun-created");
    expect(attachWorkflow).toContain("bosun-pr-trusted-author");
    expect(attachWorkflow).toContain("bosun-pr-public");
    expect(attachWorkflow).toContain("Bosun PR classification:");

    expect(ciSignalWorkflow).toContain("const bosunCreatedLabel = \"bosun-pr-bosun-created\";");
    expect(ciSignalWorkflow).toContain("const isBosunCreated = labels.includes(bosunCreatedLabel);");
    expect(ciSignalWorkflow).toContain("const trustedAuthors = new Set(normalizeList(prAutomation.trustedAuthors));");
    expect(ciSignalWorkflow).toContain("const canSignalFix = isBosunCreated || (allowTrustedFixes && isTrustedAuthor);");
    expect(ciSignalWorkflow).toContain("const isBosunCreated =");
    expect(ciSignalWorkflow).toContain("attached but not Bosun-created or trusted for repair; skipping high-risk CI signaling");
    expect(ciSignalWorkflow).toContain("trusted-author PR");
    expect(ciSignalWorkflow).toContain("const sharedFailureMarker = \"<!-- bosun-ci-shared-failure -->\";");
    expect(ciSignalWorkflow).toContain("const detectSharedFailure = async");
    expect(ciSignalWorkflow).toContain("detected shared CI incident");
    expect(ciSignalWorkflow).toContain("suppressed '${needsFixLabel}'");
  });

  it("documents operator PR automation trust settings", () => {
    const schema = read("bosun.schema.json");
    const example = read("bosun.config.example.json");
    const configSource = read("config/config.mjs");
    const serverSource = read("server/ui-server.mjs");
    const setupWebSource = read("server/setup-web-server.mjs");
    const setupSource = read("setup.mjs");
    const setupUiSource = read("ui/setup.html");
    const siteSetupUiSource = read("site/ui/setup.html");
    const settingsSource = read("ui/tabs/settings.js");
    const siteSettingsSource = read("site/ui/tabs/settings.js");

    expect(schema).toContain('"prAutomation"');
    expect(schema).toContain('"trustedAuthors"');
    expect(schema).toContain('"allowTrustedFixes"');
    expect(schema).toContain('"allowTrustedMerges"');
    expect(schema).toContain('"assistiveActions"');
    expect(schema).toContain('"installOnSetup"');
    expect(schema).toContain('"gates"');
    expect(schema).toContain('"requiredPatterns"');
    expect(schema).toContain('"optionalPatterns"');
    expect(schema).toContain('"ignorePatterns"');
    expect(schema).toContain('"automationPreference"');

    expect(example).toContain('"prAutomation"');
    expect(example).toContain('"trustedAuthors"');
    expect(example).toContain('"allowTrustedFixes"');
    expect(example).toContain('"allowTrustedMerges"');
    expect(example).toContain('"assistiveActions"');
    expect(example).toContain('"installOnSetup"');
    expect(example).toContain('"gates"');
    expect(example).toContain('"requiredPatterns"');
    expect(example).toContain('"automationPreference"');

    expect(configSource).toContain("const prAutomation = Object.freeze({");
    expect(configSource).toContain("const gates = Object.freeze({");
    expect(configSource).toContain("BOSUN_GATES_AUTOMATION_PREFERENCE");
    expect(configSource).toContain("BOSUN_REQUIRED_CHECK_PATTERNS");
    expect(configSource).toContain("BOSUN_OPTIONAL_CHECK_PATTERNS");
    expect(configSource).toContain("BOSUN_IGNORE_CHECK_PATTERNS");
    expect(configSource).toContain("BOSUN_PR_TRUSTED_AUTHORS");
    expect(configSource).toContain("BOSUN_PR_ALLOW_TRUSTED_FIXES");
    expect(configSource).toContain("BOSUN_PR_ALLOW_TRUSTED_MERGES");
    expect(configSource).toContain("BOSUN_PR_ASSISTIVE_ACTIONS_INSTALL_ON_SETUP");
    expect(configSource).toContain("resolveTrustedAuthorList(");
    expect(configSource).toContain("includeOAuthTrustedAuthor: true");

    expect(setupWebSource).toContain("function detectRepoVisibility(slug = detectRepoSlug())");
    expect(setupWebSource).toContain('automationPreference: recommendedAutomationPreference');
    expect(setupWebSource).toContain("config.gates = {");
    expect(setupWebSource).toContain("BOSUN_PR_ASSISTIVE_ACTIONS_INSTALL_ON_SETUP");
    expect(setupWebSource).toContain("BOSUN_GATES_AUTOMATION_PREFERENCE");
    expect(setupSource).toContain("configJson.gates = {");
    expect(setupSource).toContain("BOSUN_GATES_AUTOMATION_PREFERENCE");

    for (const source of [setupUiSource, siteSetupUiSource]) {
      expect(source).toContain(":shield: Gates & Safeguards");
      expect(source).toContain("assistiveActionsInstallOnSetup");
      expect(source).toContain("BOSUN_GATES_AUTOMATION_PREFERENCE");
      expect(source).toContain("prAutomation: {");
      expect(source).toContain("gates: {");
    }

    expect(serverSource).toContain('if (path === "/api/gates" && req.method === "GET")');
    expect(serverSource).toContain('if (path === "/api/gates" && req.method === "POST")');
    expect(serverSource).toContain("normalizeGatesPolicy(configData?.gates, {");
    expect(serverSource).toContain('if (path === "/api/pr-automation" && req.method === "GET")');
    expect(serverSource).toContain('if (path === "/api/pr-automation" && req.method === "POST")');
    expect(serverSource).toContain("normalizePrAutomationPolicy(configData?.prAutomation, { includeOAuthTrustedAuthor: true })");
    expect(serverSource).toContain("assistiveActions");

    for (const source of [settingsSource, siteSettingsSource]) {
      expect(source).toContain('activeCategory === "gates"');
      expect(source).toContain('settings-gates');
      expect(source).toContain('/api/gates');
      expect(source).toContain("Gates And Safeguards");
      expect(source).toContain("PR Automation Trust Policy");
      expect(source).toContain('settings-pr-automation');
      expect(source).toContain('/api/pr-automation');
      expect(source).toContain("Install optional repo-local GitHub Actions during setup");
    }
  });
});
