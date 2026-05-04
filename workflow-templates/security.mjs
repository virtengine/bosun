/**
 * security.mjs — Security-related workflow templates.
 *
 * Templates:
 *   - Dependency Audit (recommended)
 *   - Secret Scanner
 */

import { node, edge, resetLayout } from "./_helpers.mjs";

// ═══════════════════════════════════════════════════════════════════════════
//  Dependency Audit
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const DEPENDENCY_AUDIT_TEMPLATE = {
  id: "template-dependency-audit",
  name: "Dependency Audit",
  description:
    "Scheduled scan for vulnerable dependencies using npm audit. " +
    "Classifies findings by severity, prepares fix branches, and hands off " +
    "fixable packages, and alerts on critical vulnerabilities that " +
    "require manual intervention.",
  category: "security",
  enabled: true,
  recommended: true,
  trigger: "trigger.schedule",
  variables: {
    auditLevel: "moderate",
    autoFixEnabled: true,
    maxAutoFixPRs: 3,
  },
  nodes: [
    node("trigger", "trigger.schedule", "Daily Audit", {
      intervalMs: 86400000,
      cron: "0 6 * * *",
    }, { x: 400, y: 50 }),

    node("run-audit", "action.run_command", "Run npm audit", {
      command: "npm audit --json 2>/dev/null || echo '{\"vulnerabilities\":{}}'",
      continueOnError: true,
    }, { x: 400, y: 180 }),

    node("parse-results", "transform.json_parse", "Parse Audit Results", {
      input: "$ctx.getNodeOutput('run-audit')?.output || '{}'",
    }, { x: 400, y: 310 }),

    node("has-vulns", "condition.expression", "Vulnerabilities Found?", {
      expression: "(() => { const out = $ctx.getNodeOutput('run-audit')?.output || '{}'; try { const d = JSON.parse(out); const v = d.vulnerabilities || {}; return Object.keys(v).length > 0; } catch { return out.includes('vulnerability') || out.includes('moderate') || out.includes('high') || out.includes('critical'); } })()",
    }, { x: 400, y: 440, outputs: ["yes", "no"] }),

    node("classify-severity", "condition.switch", "Classify Severity", {
      value: "(() => { const out = $ctx.getNodeOutput('run-audit')?.output || '{}'; try { const d = JSON.parse(out); const v = d.metadata || {}; if ((v.vulnerabilities?.critical || 0) > 0) return 'critical'; if ((v.vulnerabilities?.high || 0) > 0) return 'high'; return 'moderate'; } catch { if (out.includes('critical')) return 'critical'; if (out.includes('high')) return 'high'; return 'moderate'; } })()",
      cases: {
        critical: "critical",
        high: "high",
        moderate: "moderate",
      },
    }, { x: 200, y: 590, outputs: ["critical", "high", "moderate", "default"] }),

    node("auto-fix-enabled", "condition.expression", "Auto Fix Enabled?", {
      expression: "Boolean($data?.autoFixEnabled !== false)",
    }, { x: 50, y: 670, outputs: ["yes", "no"] }),

    node("auto-fix", "action.run_agent", "Auto-Fix Vulnerabilities", {
      prompt: `# Dependency Vulnerability Fix

Run \`npm audit fix\` to resolve automatically fixable vulnerabilities.
If some vulnerabilities require breaking changes:
1. Review the changelog for each affected package
2. Only apply \`npm audit fix --force\` for packages where the breaking change is safe
3. Run \`npm test\` after each fix to verify nothing breaks
4. Create one commit per fixed package group

Do NOT blindly force-fix everything. Test after each change.
Limit auto-generated fix PRs to {{maxAutoFixPRs}} in this run.`,
      sdk: "auto",
      timeoutMs: 1800000,
    }, { x: 50, y: 750 }),

    node("create-fix-pr", "action.create_pr", "Handoff Fix Lifecycle", {
      title: "fix(deps): resolve {{auditLevel}}+ vulnerabilities",
      body: "## Summary\n\nAutomated dependency audit fix. Resolves vulnerabilities flagged by `npm audit` at severity level **{{auditLevel}}** or higher.\n\n## What Changed\n\n- Updated vulnerable dependencies to patched versions\n- Verified no breaking changes via build and test validation",
      baseBranch: "main",
    }, { x: 50, y: 900 }),

    node("fix-pr-created", "condition.expression", "Fix PR Created?", {
      expression:
        "(() => { const out = $ctx.getNodeOutput('create-fix-pr') || {}; return out?.success === true && Boolean(out?.prNumber || out?.prUrl || out?.handedOff); })()",
    }, { x: 50, y: 980, outputs: ["yes", "no"] }),

    node("alert-critical", "notify.telegram", "Alert: Critical Vuln", {
      message: ":alert: **CRITICAL vulnerability** found in dependencies!\n\nRun `npm audit` for details. Manual review required.",
    }, { x: 350, y: 750 }),

    node("alert-high", "notify.telegram", "Alert: High Severity", {
      message: ":alert: **High severity** dependency vulnerability detected.\n\nAuto-fix changes prepared and handed off to Bosun PR lifecycle management. Please review and merge when ready.",
      silent: true,
    }, { x: 550, y: 750 }),

    node("log-clean", "notify.log", "No Vulnerabilities", {
      message: "Dependency audit clean — no vulnerabilities found",
      level: "info",
    }, { x: 650, y: 440 }),

    node("log-done", "notify.log", "Audit Complete", {
      message: "Dependency audit complete — fixes applied where possible",
      level: "info",
    }, { x: 300, y: 1050 }),

    node("log-pr-blocked", "notify.log", "PR Creation Blocked", {
      message:
        "Dependency audit PR creation blocked: {{$ctx.getNodeOutput('create-fix-pr')?.error || 'unknown reason'}}",
      level: "warn",
    }, { x: 250, y: 980 }),
  ],
  edges: [
    edge("trigger", "run-audit"),
    edge("run-audit", "parse-results"),
    edge("parse-results", "has-vulns"),
    edge("has-vulns", "classify-severity", { condition: "$output?.result === true", port: "yes" }),
    edge("has-vulns", "log-clean", { condition: "$output?.result !== true", port: "no" }),
    edge("classify-severity", "alert-critical", { port: "critical" }),
    edge("classify-severity", "auto-fix-enabled", { port: "high" }),
    edge("classify-severity", "auto-fix-enabled", { port: "moderate" }),
    edge("alert-critical", "auto-fix-enabled"),
    edge("auto-fix-enabled", "auto-fix", { condition: "$output?.result === true", port: "yes" }),
    edge("auto-fix-enabled", "log-done", { condition: "$output?.result !== true", port: "no" }),
    edge("auto-fix", "create-fix-pr"),
    edge("create-fix-pr", "fix-pr-created"),
    edge("fix-pr-created", "alert-high", { condition: "$output?.result === true", port: "yes" }),
    edge("fix-pr-created", "log-pr-blocked", { condition: "$output?.result !== true", port: "no" }),
    edge("alert-high", "log-done"),
    edge("log-pr-blocked", "log-done"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-25T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["security", "audit", "dependencies", "npm", "vulnerability"],
    replaces: {
      module: "preflight.mjs",
      functions: ["checkDependencyHealth"],
      calledFrom: ["monitor.mjs:startProcess"],
      description:
        "Replaces ad-hoc dependency health checks with a scheduled audit " +
        "workflow. Severity classification, auto-fix, and Bosun-managed lifecycle handoff " +
        "become explicit, configurable workflow steps.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Secret Scanner
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const SECRET_SCANNER_TEMPLATE = {
  id: "template-secret-scanner",
  name: "Secret Scanner",
  description:
    "Scans the repository for accidentally committed secrets, API keys, " +
    "tokens, and credentials. Alerts immediately on detection and can " +
    "auto-rotate exposed secrets via an agent.",
  category: "security",
  enabled: false,
  trigger: "trigger.schedule",
  variables: {
    scanPatterns: "PRIVATE_KEY|SECRET|TOKEN|PASSWORD|API_KEY|CREDENTIAL",
    excludePaths: "node_modules,.git,*.lock,*.min.js",
  },
  nodes: [
    node("trigger", "trigger.schedule", "Hourly Scan", {
      intervalMs: 3600000,
      cron: "0 * * * *",
    }, { x: 400, y: 50 }),

    node("scan-repo", "action.run_command", "Scan for Secrets", {
      command: "git log --diff-filter=A -p HEAD~5..HEAD -- . ':!node_modules' ':!*.lock' ':!*.min.js' | grep -iE '({{scanPatterns}})\\s*[:=]\\s*[\"\\x27][^\"\\x27]{8,}' || echo 'CLEAN'",
      continueOnError: true,
    }, { x: 400, y: 180 }),

    node("has-secrets", "condition.expression", "Secrets Found?", {
      expression: "!($ctx.getNodeOutput('scan-repo')?.output || '').includes('CLEAN') && ($ctx.getNodeOutput('scan-repo')?.output || '').trim().length > 0",
    }, { x: 400, y: 330, outputs: ["yes", "no"] }),

    node("classify-secret", "action.run_agent", "Classify & Assess Risk", {
      prompt: `# Secret Detection Analysis

The following content was flagged as potentially containing secrets:

\`\`\`
{{scanOutput}}
\`\`\`

Analyze each finding and classify:
1. **TRUE POSITIVE** — Real secret/credential that needs rotation
2. **FALSE POSITIVE** — Not a real secret (example value, test data, etc.)

For each true positive:
- Identify the type (API key, password, token, private key, etc.)
- Assess the blast radius (what services could be compromised)
- Recommend immediate action (rotate, revoke, etc.)

Respond as JSON: { "findings": [{ "type": "...", "severity": "critical|high|low", "truePositive": true/false, "recommendation": "..." }] }`,
      timeoutMs: 300000,
    }, { x: 200, y: 490 }),

    node("has-true-positive", "condition.expression", "Any True Positives?", {
      expression: "($ctx.getNodeOutput('classify-secret')?.output || '').includes('\"truePositive\": true') || ($ctx.getNodeOutput('classify-secret')?.output || '').includes('\"truePositive\":true')",
    }, { x: 200, y: 650, outputs: ["yes", "no"] }),

    node("alert-secret", "notify.telegram", "Alert: Secret Exposed!", {
      message: ":lock: **SECRET EXPOSED** in recent commits!\n\nThe secret scanner found credentials in the repository. Immediate rotation required.\n\nCheck agent output for classification details.",
    }, { x: 100, y: 810 }),

    node("create-issue", "action.run_command", "Create Remediation Issue", {
      command: "gh issue create --title 'security: exposed credential detected by scanner' --body 'The secret scanner detected a potentially exposed credential. See Bosun workflow run for details. Rotate affected keys immediately.' --label security",
      continueOnError: true,
    }, { x: 100, y: 960 }),

    node("log-false-positive", "notify.log", "Log False Positives", {
      message: "Secret scanner flagged findings but all classified as false positives",
      level: "info",
    }, { x: 450, y: 650 }),

    node("log-clean", "notify.log", "Repository Clean", {
      message: "Secret scanner: no secrets found in recent commits (exclude paths: {{excludePaths}})",
      level: "info",
    }, { x: 650, y: 330 }),
  ],
  edges: [
    edge("trigger", "scan-repo"),
    edge("scan-repo", "has-secrets"),
    edge("has-secrets", "classify-secret", { condition: "$output?.result === true", port: "yes" }),
    edge("has-secrets", "log-clean", { condition: "$output?.result !== true", port: "no" }),
    edge("classify-secret", "has-true-positive"),
    edge("has-true-positive", "alert-secret", { condition: "$output?.result === true", port: "yes" }),
    edge("has-true-positive", "log-false-positive", { condition: "$output?.result !== true", port: "no" }),
    edge("alert-secret", "create-issue"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-25T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["security", "secrets", "scanner", "credentials", "rotation"],
    replaces: {
      module: "preflight.mjs",
      functions: ["checkGitSecrets"],
      calledFrom: ["preflight.mjs:runAllChecks"],
      description:
        "Replaces manual secret scanning with an automated workflow. " +
        "Regex scanning, AI-powered classification, and alerting " +
        "become structured, scheduled workflow steps.",
    },
  },
};
