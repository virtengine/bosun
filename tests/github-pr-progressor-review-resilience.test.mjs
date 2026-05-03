import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "vitest";

import { getTemplate } from "../workflow/workflow-templates.mjs";

function getInlineNodeScript(templateId, nodeId) {
  const template = getTemplate(templateId);
  assert.ok(template, `missing template ${templateId}`);
  const node = template.nodes.find((entry) => entry.id === nodeId);
  assert.ok(node, `missing node ${nodeId}`);
  assert.equal(node.type, "action.run_command");
  assert.equal(node.config.command, "node");
  assert.ok(Array.isArray(node.config.args), "node args must be an array");
  assert.equal(node.config.args[0], "-e");
  return node.config.args[1];
}

function runInlineScript(script, { env, execFileSync }) {
  const logs = [];
  const processStub = {
    env: { ...env },
    exit(code = 0) {
      const error = new Error(`process.exit(${code})`);
      error.exitCode = code;
      throw error;
    },
  };

  const context = {
    console: {
      log: (value) => logs.push(String(value)),
      error: () => {},
      warn: () => {},
    },
    process: processStub,
    require: (id) => {
      if (id === "child_process") return { execFileSync };
      throw new Error(`unexpected require: ${id}`);
    },
    Atomics,
    SharedArrayBuffer,
    Int32Array,
    JSON,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    RegExp,
    Date,
    Map,
    Set,
  };

  vm.createContext(context);
  try {
    new vm.Script(script).runInContext(context, { timeout: 5000 });
  } catch (error) {
    if (error?.exitCode !== 0) throw error;
  }
  return logs;
}

test("template-bosun-pr-progressor review gate retries transient gh read failures before merge", () => {
  const script = getInlineNodeScript("template-bosun-pr-progressor", "programmatic-review");
  const calls = [];
  let prViewAttempts = 0;

  const logs = runInlineScript(script, {
    env: {
      BOSUN_PR_INSPECT: JSON.stringify({
        repo: "virtengine/bosun",
        prNumber: 60,
      }),
    },
    execFileSync(command, args) {
      assert.equal(command, "gh");
      const rendered = [command, ...(Array.isArray(args) ? args : [])].join(" ").trim();
      calls.push(rendered);

      if (/^gh pr view 60 --repo virtengine\/bosun --json number,title,additions,deletions,changedFiles,isDraft$/i.test(rendered)) {
        prViewAttempts += 1;
        if (prViewAttempts === 1) {
          const error = new Error("secondary rate limit exceeded");
          error.stderr = "secondary rate limit exceeded; retry after 1 second";
          error.status = 1;
          throw error;
        }
        return JSON.stringify({
          number: 60,
          title: "Progress PR",
          additions: 12,
          deletions: 1,
          changedFiles: 2,
          isDraft: false,
        });
      }

      if (/^gh pr checks 60 --repo virtengine\/bosun --json name,state,bucket$/i.test(rendered)) {
        return JSON.stringify([
          { name: "Build + Tests", state: "SUCCESS", bucket: "pass" },
        ]);
      }

      if (/^gh pr merge 60 --repo virtengine\/bosun --delete-branch --(?:merge|squash)(?: --auto)?$/i.test(rendered)) {
        return "merged";
      }

      throw new Error(`unexpected gh command: ${rendered}`);
    },
  });

  assert.equal(prViewAttempts, 2);
  assert.ok(calls.some((entry) => /gh pr merge 60\b/i.test(entry)), "expected merge command");
  assert.ok(logs.length > 0, "expected JSON output");

  const summary = JSON.parse(logs.at(-1));
  assert.equal(summary.mergedCount, 1);
  assert.equal(summary.heldCount, 0);
  assert.equal(summary.skippedCount, 0);
});
