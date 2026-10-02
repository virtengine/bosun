/**
 * ci-cd.mjs — CI/CD workflow templates.
 *
 * Templates:
 *   - Build & Deploy
 *   - Release Pipeline (recommended)
 *   - Canary Deploy
 */

import { node, edge, resetLayout } from "./_helpers.mjs";

// ═══════════════════════════════════════════════════════════════════════════
//  Build and Deploy Pipeline
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const BUILD_DEPLOY_TEMPLATE = {
  id: "template-build-deploy",
  name: "Build & Deploy",
  description:
    "Complete CI/CD-style pipeline: build → test → lint → deploy. " +
    "Configurable deployment commands for any hosting target.",
  category: "ci-cd",
  enabled: false,
  trigger: "trigger.event",
  variables: {
    deployCommand: "npm run deploy",
    deployBranch: "main",
  },
  nodes: [
    node("trigger", "trigger.event", "On PR Merged", {
      eventType: "pr.merged",
      filter: "$event.branch === '{{deployBranch}}'",
    }, { x: 400, y: 50 }),

    node("build", "validation.build", "Build", {
      command: "npm run build",
      zeroWarnings: true,
    }, { x: 400, y: 180 }),

    node("test", "validation.tests", "Tests", {
      command: "npm test",
    }, { x: 400, y: 310 }),

    node("lint", "validation.lint", "Lint", {
      command: "npm run lint",
    }, { x: 400, y: 440 }),

    node("deploy", "action.run_command", "Deploy", {
      command: "{{deployCommand}}",
    }, { x: 400, y: 570 }),

    node("notify", "notify.telegram", "Notify Deploy", {
      message: ":rocket: Deployment to production completed for {{branch}}",
    }, { x: 400, y: 700 }),
  ],
  edges: [
    edge("trigger", "build"),
    edge("build", "test"),
    edge("test", "lint"),
    edge("lint", "deploy"),
    edge("deploy", "notify"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-24T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["ci", "cd", "deploy", "build"],
    replaces: {
      module: "monitor.mjs",
      functions: ["preflight checks"],
      calledFrom: ["preflight.mjs"],
      description: "Replaces ad-hoc build/test/lint validation steps " +
        "with a coordinated CI/CD pipeline workflow.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Release Pipeline
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const RELEASE_PIPELINE_TEMPLATE = {
  id: "template-release-pipeline",
  name: "Release Pipeline",
  description:
    "End-to-end release automation: version bump, changelog generation, " +
    "build, test, npm publish, GitHub release creation, and team notification. " +
    "Triggered manually or on a schedule for regular release cadences.",
  category: "ci-cd",
  enabled: true,
  recommended: true,
  trigger: "trigger.manual",
  variables: {
    bumpType: "patch",
    publishToNpm: true,
    dryRun: false,
  },
  nodes: [
    node("trigger", "trigger.manual", "Start Release", {
      description: "Kick off a new release",
    }, { x: 400, y: 50 }),

    node("bump-version", "action.run_command", "Bump Version", {
      command: "npm version {{bumpType}} --no-git-tag-version",
    }, { x: 400, y: 180 }),

    node("read-version", "action.run_command", "Read New Version", {
      command: "node -p \"require('./package.json').version\"",
      // Without this a corrupt package.json (or a missing node) exits non-zero
      // with empty stdout and the run CONTINUES — `set-version` then resolves
      // `version` to "" and the pipeline happily tags `v`.
      failOnError: true,
    }, { x: 400, y: 310 }),

    node("set-version", "action.set_variable", "Set Version Variable", {
      key: "version",
      // Trim, and drop a leading "v" so a v-prefixed manifest yields `v0.44.0`
      // rather than the double-prefixed `vv0.44.0`. Everything else is left
      // alone and refused by the gate below rather than silently repaired.
      value: "(() => String($ctx.getNodeOutput('read-version')?.output || '').trim().replace(/^v/, ''))()",
      isExpression: true,
    }, { x: 400, y: 380 }),

    // The gate. `commit-tag` builds the remote tag by concatenation
    // (`"v" + version`) and `gh release create v{{version}}` repeats it, so a
    // blank or malformed version becomes a real, permanent, malformed tag —
    // the exact `v` tag that has to be deleted by hand on the remote today.
    // `npm publish` does not catch it (it accepts `v0.44.0`, rc=0), so this
    // node is the only thing on the path that can refuse.
    //
    // It is a `condition.expression` that THROWS rather than one that returns
    // false: a false result would simply take the "no" branch and let the run
    // finish in a state that looks successful. Throwing fails the node, which
    // halts the run before the commit/tag/push node is ever reached.
    node("validate-version", "condition.expression", "Validate Version", {
      expression: `(() => {
  const v = String({{version}} ?? "").trim();
  const strict = /^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$/;
  if (!strict.test(v)) {
    throw new Error(
      "Refusing to release: resolved version " + JSON.stringify(v) +
      " is not strict semver (MAJOR.MINOR.PATCH[-prerelease][+build]). " +
      "The release tag is built from this value, so publishing now would push " +
      JSON.stringify("v" + v) + ". Fix package.json and re-run."
    );
  }
  return true;
})()`,
    }, { x: 400, y: 450 }),

    node("generate-changelog", "action.run_agent", "Generate Changelog", {
      prompt: `# Generate Changelog Entry

Read the git log since the last tag:
\`\`\`
git log $(git describe --tags --abbrev=0)..HEAD --oneline
\`\`\`

Group commits into categories (Features, Fixes, Refactors, Docs, etc.)
following the Keep a Changelog format.

Write the entry to CHANGELOG.md under a new version heading.
Commit the result with message "docs: update changelog for vX.Y.Z".`,
      sdk: "auto",
      timeoutMs: 600000,
    }, { x: 400, y: 520 }),

    node("build", "validation.build", "Build", {
      command: "npm run build",
      zeroWarnings: true,
    }, { x: 400, y: 640 }),

    node("test", "validation.tests", "Run Tests", {
      command: "npm test",
    }, { x: 400, y: 760 }),

    node("test-passed", "condition.expression", "Tests Passed?", {
      expression: "$ctx.getNodeOutput('test')?.passed === true",
    }, { x: 400, y: 880, outputs: ["yes", "no"] }),

    node("should-publish", "condition.expression", "Publish To npm?", {
      expression: "Boolean($data?.publishToNpm)",
    }, { x: 250, y: 1080, outputs: ["yes", "no"] }),

    node("commit-tag", "action.git_operations", "Commit & Tag", {
      operations: [
        { op: "add", paths: ["."] },
        { op: "commit", message: "chore(release): v{{version}}" },
        { op: "tag", name: "v{{version}}" },
        { op: "push", includeTags: true },
      ],
    }, { x: 250, y: 960 }),

    node("publish-npm", "action.run_command", "Publish to npm", {
      command: "if [ \"{{dryRun}}\" = \"true\" ]; then echo 'Dry run: skipping npm publish'; else npm publish --access public; fi",
      continueOnError: true,
    }, { x: 250, y: 1090 }),

    node("create-gh-release", "action.run_command", "GitHub Release", {
      command: "gh release create v{{version}} --generate-notes --title \"v{{version}}\"",
      continueOnError: true,
    }, { x: 250, y: 1220 }),

    node("notify-success", "notify.telegram", "Notify: Released", {
      message: ":box: **Release published!**\n\nVersion: v{{version}}\nnpm + GitHub release created.",
    }, { x: 250, y: 1350 }),

    node("notify-failure", "notify.telegram", "Notify: Release Failed", {
      message: ":close: **Release pipeline failed** at test stage.\n\nVersion bump was {{bumpType}} but tests did not pass. Manual intervention required.",
    }, { x: 600, y: 960 }),
  ],
  edges: [
    edge("trigger", "bump-version"),
    edge("bump-version", "read-version"),
    edge("read-version", "set-version"),
    edge("set-version", "validate-version"),
    edge("validate-version", "generate-changelog"),
    edge("generate-changelog", "build"),
    edge("build", "test"),
    edge("test", "test-passed"),
    edge("test-passed", "commit-tag", { condition: "$output?.result === true", port: "yes" }),
    edge("test-passed", "notify-failure", { condition: "$output?.result !== true", port: "no" }),
    edge("commit-tag", "should-publish"),
    edge("should-publish", "publish-npm", { condition: "$output?.result === true", port: "yes" }),
    edge("should-publish", "create-gh-release", { condition: "$output?.result !== true", port: "no" }),
    edge("publish-npm", "create-gh-release"),
    edge("create-gh-release", "notify-success"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-25T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["release", "publish", "npm", "changelog", "version"],
    replaces: {
      module: "publish.mjs",
      functions: ["publish", "bumpVersion", "createGitHubRelease"],
      calledFrom: ["cli.mjs:publish"],
      description:
        "Replaces the imperative publish.mjs script with a visual release " +
        "pipeline. Each stage (bump, changelog, build, test, publish, " +
        "release) becomes a discrete, retriable workflow node.",
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Canary Deploy
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const CANARY_DEPLOY_TEMPLATE = {
  id: "template-canary-deploy",
  name: "Canary Deploy",
  description:
    "Two-phase deployment: deploy to a staging/canary environment first, " +
    "run smoke tests, then promote to production or auto-rollback on failure. " +
    "Reduces blast radius of bad deploys.",
  category: "ci-cd",
  enabled: false,
  trigger: "trigger.manual",
  variables: {
    stagingCommand: "npm run deploy:staging",
    productionCommand: "npm run deploy:production",
    rollbackCommand: "npm run deploy:rollback",
    smokeTestCommand: "npm run test:smoke",
    promotionDelayMs: 300000,
  },
  nodes: [
    node("trigger", "trigger.manual", "Deploy Canary", {
      description: "Start a canary deployment",
    }, { x: 400, y: 50 }),

    node("build", "validation.build", "Build", {
      command: "npm run build",
      zeroWarnings: true,
    }, { x: 400, y: 180 }),

    node("deploy-staging", "action.run_command", "Deploy to Staging", {
      command: "{{stagingCommand}}",
      continueOnError: true,
    }, { x: 400, y: 310 }),

    node("staging-ok", "condition.expression", "Staging Deploy OK?", {
      expression: "$ctx.getNodeOutput('deploy-staging')?.success === true",
    }, { x: 400, y: 440, outputs: ["yes", "no"] }),

    node("smoke-tests", "action.run_command", "Run Smoke Tests", {
      command: "{{smokeTestCommand}}",
      continueOnError: true,
    }, { x: 250, y: 570 }),

    node("smoke-passed", "condition.expression", "Smoke Tests Passed?", {
      expression: "$ctx.getNodeOutput('smoke-tests')?.success === true",
    }, { x: 250, y: 700, outputs: ["yes", "no"] }),

    node("wait-bake", "action.delay", "Bake Time", {
      ms: "{{promotionDelayMs}}",
      reason: "Waiting for bake time before promoting to production",
    }, { x: 100, y: 830 }),

    node("promote-prod", "action.run_command", "Promote to Production", {
      command: "{{productionCommand}}",
    }, { x: 100, y: 960 }),

    node("notify-success", "notify.telegram", "Deploy Succeeded", {
      message: ":check: **Canary deploy promoted to production** successfully.",
    }, { x: 100, y: 1090 }),

    node("rollback", "action.run_command", "Rollback", {
      command: "{{rollbackCommand}}",
      continueOnError: true,
    }, { x: 550, y: 700 }),

    node("notify-rollback", "notify.telegram", "Deploy Rolled Back", {
      message: ":refresh: **Canary deploy rolled back.**\n\nSmoke tests or staging deploy failed. Production unchanged.",
    }, { x: 550, y: 830 }),

    node("notify-staging-fail", "notify.telegram", "Staging Failed", {
      message: ":close: **Staging deploy failed.** Not proceeding to canary phase.",
    }, { x: 600, y: 440 }),
  ],
  edges: [
    edge("trigger", "build"),
    edge("build", "deploy-staging"),
    edge("deploy-staging", "staging-ok"),
    edge("staging-ok", "smoke-tests", { condition: "$output?.result === true", port: "yes" }),
    edge("staging-ok", "notify-staging-fail", { condition: "$output?.result !== true", port: "no" }),
    edge("smoke-tests", "smoke-passed"),
    edge("smoke-passed", "wait-bake", { condition: "$output?.result === true", port: "yes" }),
    edge("smoke-passed", "rollback", { condition: "$output?.result !== true", port: "no" }),
    edge("wait-bake", "promote-prod"),
    edge("promote-prod", "notify-success"),
    edge("rollback", "notify-rollback"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2025-02-25T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["deploy", "canary", "staging", "rollback", "smoke-test"],
  },
};
