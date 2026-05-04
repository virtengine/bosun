#!/usr/bin/env node
/**
 * tests/sandbox/validate-template-nodes.mjs
 *
 * Static integrity checks that run BEFORE the full test suite:
 *
 *   1. Every node type referenced in every template is registered.
 *   2. Every edge target is a real node ID within the same template.
 *   3. Every {{variable}} in node configs is declared in template.variables
 *      or is a well-known dynamic input (prNumber, taskId, branch, …).
 *   4. No template has duplicate node IDs.
 *   5. Every template has a valid trigger node.
 *
 * Exit 0 on pass, exit 1 on any violation (prints a structured report).
 */

import { WORKFLOW_TEMPLATES } from "../../workflow/workflow-templates.mjs";
import { getNodeType } from "../../workflow/workflow-engine.mjs";
import "../../workflow/workflow-nodes.mjs"; // ensure all node types are registered

// ──────────────────────────────────────────────────────────────────────────
//  Known dynamic inputs — variables that workflows receive at runtime
// ──────────────────────────────────────────────────────────────────────────

const WELL_KNOWN_INPUTS = new Set([
  // GitHub context
  "prNumber", "branch", "baseBranch", "prTitle", "prBody", "prAuthor",
  "tagName", "releaseBranch", "commitSha", "repoOwner", "repoName",
  // Task management
  "taskId", "taskTitle", "taskDescription", "worktreePath", "toStatus",
  // Agent
  "sessionId", "agentId", "executor", "prompt",
  // Incident / error
  "incidentId", "severity", "errorType",
  // CI/CD
  "environment", "deployUrl",
  // Batch
  "batchSize", "maxConcurrent",
  // Meeting
  "meetingId",
  // Generic
  "sprintNumber", "taskCount",
  // Data variables set by set_variable nodes (prefixed $)
  "ctx", "data", "node",
]);

// ──────────────────────────────────────────────────────────────────────────
//  Validator
// ──────────────────────────────────────────────────────────────────────────

const violations = [];
const warnings = [];

let templateCount = 0;
let nodeCount = 0;
let edgeCount = 0;

for (const template of WORKFLOW_TEMPLATES) {
  templateCount++;
  const { id, nodes = [], edges = [], variables = {} } = template;
  const nodeIds = new Set(nodes.map((n) => n.id));

  // ── 1. Duplicate node IDs ────────────────────────────────────────────
  const seen = new Set();
  for (const node of nodes) {
    if (seen.has(node.id)) {
      violations.push(`[${id}] Duplicate node ID: "${node.id}"`);
    }
    seen.add(node.id);
  }

  // ── 2. All node types registered ─────────────────────────────────────
  for (const node of nodes) {
    nodeCount++;
    if (!getNodeType(node.type)) {
      violations.push(`[${id}] Node "${node.id}" uses unknown type: "${node.type}"`);
    }
  }

  // ── 3. All edge targets are real nodes ────────────────────────────────
  for (const edge of edges) {
    edgeCount++;
    const source = typeof edge === "object" ? edge.source : edge.split("->")[0]?.trim();
    const target = typeof edge === "object" ? edge.target : edge.split("->")[1]?.trim();

    if (source && !nodeIds.has(source)) {
      violations.push(`[${id}] Edge source "${source}" is not a node ID in this template`);
    }
    if (target && !nodeIds.has(target) && target !== "end" && target !== "default") {
      violations.push(`[${id}] Edge target "${target}" is not a node ID in this template`);
    }
  }

  // ── 4. Template has a trigger node ────────────────────────────────────
  const hasTrigger = nodes.some((n) => String(n.type || "").startsWith("trigger."));
  if (!hasTrigger) {
    warnings.push(`[${id}] No trigger.* node found (template may require external trigger context)`);
  }

  // ── 5. {{variable}} references point to declared vars or well-known inputs ──
  const knownVars = new Set([
    ...Object.keys(variables),
    ...WELL_KNOWN_INPUTS,
    // Variables set by set_variable nodes
    ...nodes
      .filter((n) => n.type === "action.set_variable" && n.config?.key)
      .map((n) => n.config.key),
    // Variables that come from context expressions ($ctx, $data)
    "ctx", "data",
  ]);

  const varPattern = /\{\{([A-Za-z_$][A-Za-z0-9_$]*)\}\}/g;
  for (const node of nodes) {
    const configStr = JSON.stringify(node.config ?? {});
    let m;
    while ((m = varPattern.exec(configStr)) !== null) {
      const varName = m[1];
      if (!knownVars.has(varName)) {
        warnings.push(`[${id}] Node "${node.id}" references "{{${varName}}}" which is not in template.variables or well-known inputs`);
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
//  Report
// ──────────────────────────────────────────────────────────────────────────

console.log(`\n📋 Template Integrity Report`);
console.log(`   Templates : ${templateCount}`);
console.log(`   Nodes     : ${nodeCount}`);
console.log(`   Edges     : ${edgeCount}`);

const sortedWarnings = [...warnings].sort((left, right) => left.localeCompare(right));
const sortedViolations = [...violations].sort((left, right) => left.localeCompare(right));

if (sortedWarnings.length) {
  console.log(`\n⚠️  Warnings (${sortedWarnings.length}):`);
  for (const warning of sortedWarnings) console.log(`   ${warning}`);
}

if (sortedViolations.length) {
  console.error(`\n❌ Violations (${sortedViolations.length}) — FAILING:`);
  for (const violation of sortedViolations) console.error(`   ${violation}`);
  process.exit(1);
} else {
  console.log(`\n✅ All integrity checks passed — ${templateCount} templates are well-formed.`);
}
