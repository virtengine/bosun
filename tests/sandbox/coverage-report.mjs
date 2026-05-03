#!/usr/bin/env node
/**
 * tests/sandbox/coverage-report.mjs
 *
 * Node-type coverage reporter.
 *
 * Runs every template through the engine (using guaranteed test harness logic)
 * and reports:
 *   • Which node types were exercised across all templates
 *   • Which registered node types were NEVER hit by any template
 *   • Per-template breakdown
 *   • JSON output for CI artifact ingestion
 *
 * Exit 0 always — coverage is informational, not a gate (gate is separate).
 *
 * Usage:
 *   node tests/sandbox/coverage-report.mjs [--json coverage.json] [--threshold 80]
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import {
  createCoverageStubResult,
  shouldExecuteOriginalForCoverage,
} from "./coverage-report-helpers.mjs";

// Parse arguments
const args = process.argv.slice(2);
const jsonOutIndex = args.indexOf("--json");
const jsonOutFile  = jsonOutIndex !== -1 ? args[jsonOutIndex + 1] : null;
const thresholdArg = args.indexOf("--threshold");
const threshold    = thresholdArg !== -1 ? Number(args[thresholdArg + 1]) : 70;

// ── Patch execSync early so importing workflow-nodes.mjs doesn't blow up ──
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// Simple synchronous child_process stub
const _realChildProcess = require("node:child_process");
const _origExecSync = _realChildProcess.execSync;
_realChildProcess.execSync = (cmd, opts) => {
  if (/^git\b/.test(cmd))   return "";
  if (/^gh\b/.test(cmd))    return "[]";
  if (/^bosun\b/.test(cmd)) return "[]";
  if (/^npm\b/.test(cmd))   return "ok";
  if (/^node\b/.test(cmd))  return "1\n";
  return "";
};

import {
  WorkflowEngine,
  registerNodeType,
  getNodeType,
  listNodeTypes,
} from "../../workflow/workflow-engine.mjs";
import { WORKFLOW_TEMPLATES, installTemplate } from "../../workflow/workflow-templates.mjs";
import "../../workflow/workflow-nodes.mjs";
import { TEMPLATE_FIXTURES } from "./fixtures.mjs";

// ──────────────────────────────────────────────────────────────────────────
//  Stub experimental node types
// ──────────────────────────────────────────────────────────────────────────

const EXPERIMENTAL = [
  "meeting.start", "meeting.send", "meeting.transcript", "meeting.vision",
  "meeting.finalize", "trigger.meeting.wake_phrase",
];

for (const type of EXPERIMENTAL) {
  if (!getNodeType(type)) {
    registerNodeType(type, {
      describe: () => `Stub: ${type}`,
      schema: { type: "object", properties: {} },
      execute: () => ({ success: true }),
    });
  }
}

// ──────────────────────────────────────────────────────────────────────────
//  Minimal mock services (just enough to prevent crashes)
// ──────────────────────────────────────────────────────────────────────────

function makeMinimalServices() {
  const noop = async () => ({});
  const plan = { tasks: [{ title: "mock", description: "auto" }] };
  return {
    kanban: {
      listTasks: async () => [{ id: "T-1", title: "Test task", status: "todo", priority: "medium" }],
      updateTask: async (id, u) => ({ id, ...u }),
      getTask: async (id) => ({ id, title: "Test task", status: "todo" }),
      createTask: async (t) => ({ id: "T-NEW", ...t }),
      archiveTask: async (id) => ({ id, archived: true }),
    },
    git: {
      getCurrentBranch: () => "feat/test",
      hasPendingChanges: () => false,
      push: async () => ({ success: true }),
      checkout: async () => ({ success: true }),
      createBranch: async (n) => ({ success: true, branch: n }),
    },
    agentPool: {
      getAvailableSlots: () => 3,
      allocateSlot: async (id) => ({ slotId: `slot-${id}`, allocated: true }),
      releaseSlot: async () => ({ released: true }),
      listAgents: () => [{ id: "agent-1", type: "codex", status: "idle" }],
      launchEphemeralThread: async () => ({ success: true, output: JSON.stringify(plan), sdk: "mock", threadId: "t1" }),
      execWithRetry: async () => ({ success: true, output: JSON.stringify(plan), sdk: "mock", threadId: "t1", attempts: 1, continues: 0 }),
      launchOrResumeThread: async () => ({ success: true, output: "resumed", sdk: "mock", threadId: "t1" }),
      continueSession: async () => ({ success: true, output: "continued", sdk: "mock" }),
    },
    worktree: {
      acquire: async (b) => ({ path: `/tmp/wt/${b}`, branch: b, acquired: true }),
      release: async () => ({ released: true }),
      list: () => [{ path: "/tmp/wt/main", branch: "main", active: true }],
    },
    claims: {
      claim: async (tid, aid) => ({ taskId: tid, agentId: aid, claimed: true, ts: Date.now() }),
      release: async () => ({ released: true }),
      isClaimed: () => false,
    },
    presence: {
      heartbeat: async () => ({ alive: true }),
      isAlive: () => true,
      getStatus: () => ({ agents: 1, active: 1 }),
    },
    config: {
      get: (k, fallback) => ({ maxSlots: 3, executor: "codex", baseBranch: "main", repoOwner: "virtengine", repoName: "bosun", stalePrDays: 14, maxRetries: 3 })[k] ?? fallback,
    },
    telegram: {
      send: async () => ({ sent: true }),
      sendMessage: async () => ({ sent: true }),
    },
    meeting: {
      getSession: async (id) => ({ id: id ?? "session-1", active: true, title: "Sprint Sync" }),
      createSession: async (o) => ({ id: `session-${Date.now()}`, ...o, active: true }),
      startMeeting: async (o) => ({ sessionId: o?.sessionId ?? "meeting-1", created: true, session: { active: true } }),
      sendMeetingMessage: async (sid) => ({ sent: true, sessionId: sid }),
      fetchMeetingTranscript: async (sid) => ({ messages: [{ role: "user", content: "hello" }], page: 1, pageSize: 200, totalMessages: 1, totalPages: 1 }),
      stopMeeting: async (sid) => ({ ok: true, sessionId: sid, status: "completed" }),
      analyzeMeetingFrame: async (sid) => ({ ok: true, analyzed: true, summary: "mock", sessionId: sid }),
    },
    prompts: { planner: "Generate tasks. Return JSON {tasks:[...]}" },
  };
}

// ──────────────────────────────────────────────────────────────────────────
//  Instrument the engine to intercept node type invocations
// ──────────────────────────────────────────────────────────────────────────

// We monkey-patch each registered node type's execute() for the duration of the run.
// This way ANY node type call is recorded, even deeply nested ones.
const nodeTypeCoverage = new Map(); // type → Set<templateId>
const allRegisteredTypes = [...new Set(
  (listNodeTypes ? listNodeTypes() : [])
    .map((entry) => (typeof entry === "string" ? entry : entry?.type))
    .filter((type) => typeof type === "string" && type.length > 0),
)];

for (const type of allRegisteredTypes) {
  nodeTypeCoverage.set(type, new Set());
}

const originalExecutors = new Map();
for (const type of allRegisteredTypes) {
  const nt = getNodeType(type);
  if (!nt) continue;
  originalExecutors.set(type, nt.execute.bind(nt));
}

function instrumentForTemplate(templateId) {
  for (const type of allRegisteredTypes) {
    const nt = getNodeType(type);
    if (!nt) continue;
    const orig = originalExecutors.get(type);
    nt.execute = async function (...args) {
      nodeTypeCoverage.get(type)?.add(templateId);
      if (!shouldExecuteOriginalForCoverage(type)) {
        return createCoverageStubResult(type);
      }
      return orig(...args);
    };
  }
}

function restoreOriginalExecutors() {
  for (const type of allRegisteredTypes) {
    const nt = getNodeType(type);
    if (!nt) continue;
    const orig = originalExecutors.get(type);
    if (orig) nt.execute = orig;
  }
}

// ──────────────────────────────────────────────────────────────────────────
//  Main run
// ──────────────────────────────────────────────────────────────────────────

console.log(`\n🔬 Workflow Node-Type Coverage Reporter`);
console.log(`   Templates : ${WORKFLOW_TEMPLATES.length}`);
console.log(`   Node types: ${allRegisteredTypes.length}\n`);

const results = [];

for (const template of WORKFLOW_TEMPLATES) {
  const tmpDir = mkdtempSync(join(tmpdir(), "wf-cov-"));
  const fixtures = TEMPLATE_FIXTURES[template.id] ?? { scenario: {}, inputVars: {} };

  instrumentForTemplate(template.id);

  try {
    const engine = new WorkflowEngine({
      workflowDir: join(tmpDir, "workflows"),
      runsDir:     join(tmpDir, "runs"),
      services:    makeMinimalServices(),
    });

    const installed = installTemplate(template.id, engine, { promotionDelayMs: 10 });
    const ctx = await engine.execute(installed.id, fixtures.inputVars ?? {}, { force: true });

    results.push({ id: template.id, success: true, errors: ctx.errors.length });
    if (ctx.errors.length) {
      process.stdout.write(`  ⚠️  ${template.id}: ${ctx.errors.length} error(s)\n`);
    } else {
      process.stdout.write(`  ✅  ${template.id}\n`);
    }
  } catch (err) {
    results.push({ id: template.id, success: false, errors: 1, message: err.message });
    process.stdout.write(`  ❌  ${template.id}: ${err.message}\n`);
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  }
}

restoreOriginalExecutors();

// ──────────────────────────────────────────────────────────────────────────
//  Build coverage matrix
// ──────────────────────────────────────────────────────────────────────────

const hitTypes   = [...nodeTypeCoverage.entries()].filter(([, s]) => s.size > 0).map(([t]) => t);
const missTypes  = [...nodeTypeCoverage.entries()].filter(([, s]) => s.size === 0).map(([t]) => t);
const coveragePct = allRegisteredTypes.length > 0
  ? Math.round((hitTypes.length / allRegisteredTypes.length) * 100)
  : 0;

console.log(`\n📊 Coverage Summary`);
console.log(`   Hit  : ${hitTypes.length} / ${allRegisteredTypes.length} (${coveragePct}%)`);
console.log(`   Miss : ${missTypes.length}`);

if (missTypes.length) {
  console.log(`\n⚪  Never exercised node types:`);
  for (const t of missTypes) console.log(`     ${t}`);
}

// Top-5 most-used
const ranked = [...nodeTypeCoverage.entries()]
  .filter(([, s]) => s.size > 0)
  .sort((a, b) => b[1].size - a[1].size)
  .slice(0, 8);
console.log(`\n🏆 Most exercised node types:`);
for (const [t, s] of ranked) console.log(`   ${String(t).padEnd(45)} ${s.size} template(s)`);

// ──────────────────────────────────────────────────────────────────────────
//  JSON output for CI artifact
// ──────────────────────────────────────────────────────────────────────────

const report = {
  generatedAt: new Date().toISOString(),
  templateCount: WORKFLOW_TEMPLATES.length,
  nodeTypeCount: allRegisteredTypes.length,
  hitCount: hitTypes.length,
  missCount: missTypes.length,
  coveragePct,
  threshold,
  hitTypes,
  missTypes,
  templateResults: results,
  byNodeType: Object.fromEntries(
    [...nodeTypeCoverage.entries()].map(([t, s]) => [t, [...s]]),
  ),
};

if (jsonOutFile) {
  writeFileSync(jsonOutFile, JSON.stringify(report, null, 2));
  console.log(`\n📁 JSON report written to: ${jsonOutFile}`);
}

// Threshold gate
if (coveragePct < threshold) {
  console.error(`\n❌ Coverage ${coveragePct}% is below threshold ${threshold}%`);
  process.exit(1);
}

console.log(`\n✅ Coverage ${coveragePct}% meets threshold ${threshold}%`);
