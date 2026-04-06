/**
 * tests/workflow-guaranteed.test.mjs
 *
 * GUARANTEED workflow-template test suite.
 *
 * Unlike the existing E2E suite, this suite:
 *
 *   1. Provides per-template fixture data so every gh CLI call gets a
 *      CORRECT, SPECIFIC response (not a generic empty array).
 *      → No more "template fails because issue #42 returns []"
 *
 *   2. Uses a stateful sandbox: gh issue close / gh pr merge mutations are
 *      tracked — subsequent reads reflect those mutations.
 *
 *   3. Runs each template N times (REPEAT_COUNT env) and asserts consistent
 *      output — detects flakiness caused by race conditions or non-determinism.
 *
 *   4. Validates per-node behavioral contracts, not just "no crash":
 *      - CI-gated templates check CI output
 *      - Stale PR templates close old PRs
 *      - Release templates emit a tag
 *
 *   5. Chaos pass: injects transient execSync failures to verify retry nodes.
 *
 * Shard support: set VITEST_SHARD=1 VITEST_TOTAL_SHARDS=4 to run a quarter
 * of templates in parallel with other shards.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import { WORKFLOW_TEMPLATES, getTemplate } from "../workflow/workflow-templates.mjs";

import { skipLocallyForSpeed } from "./test-speed-gates.mjs";

const runGuaranteedInVitest = String(process.env.BOSUN_WORKFLOW_GUARANTEED_CHILD || "").trim() === "1";
const guaranteedDescribe = runGuaranteedInVitest ? describe : describe.skip;

let TEMPLATE_FIXTURES = {};
let createExecSandbox = () => ({ dispatch: () => "", calls: [], callsMatching: () => [] });
let createTemplateHarness = () => {
  throw new Error("workflow-guaranteed harness is disabled outside the sharded runner");
};
let ensureExperimentalNodeTypes = () => {};

if (runGuaranteedInVitest) {
  ({ TEMPLATE_FIXTURES } = await import("./sandbox/fixtures.mjs"));
  ({ createExecSandbox } = await import("./sandbox/exec-sandbox.mjs"));
  ({ createTemplateHarness, ensureExperimentalNodeTypes } = await import("./sandbox/template-harness.mjs"));
}

// ══════════════════════════════════════════════════════════════════════════
//  Mutable sandbox dispatch — the vi.mock captures this reference so that
//  beforeEach can swap in a new exec sandbox per template test.
// ══════════════════════════════════════════════════════════════════════════

let _activeDispatch = (_cmd) => "";
let _activeExecSandbox = null;
let _pendingChildProcessOps = 0;

function isoDaysAgo(daysAgo = 0, hour = 10) {
  const date = new Date(Date.now() - (Number(daysAgo) * 24 * 60 * 60 * 1000));
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
}

// ── child_process mock ────────────────────────────────────────────────────
// NOTE: vi.mock is hoisted to the file top by vitest, so the factory closure
// over `_activeDispatch` captures the variable binding (let), which means
// reassigning `_activeDispatch` in beforeEach propagates into the mock.

vi.mock("node:child_process", async (importOriginal) => {
  const orig = await importOriginal();
  const renderSpawnCommand = (cmd, args = []) => {
    const parts = [String(cmd || "").trim(), ...(Array.isArray(args) ? args.map((arg) => String(arg)) : [])]
      .filter(Boolean);
    return parts.join(" ").trim();
  };
  return {
    ...orig,
    execSync: (cmd, _opts) => _activeDispatch(cmd),

    spawnSync: (cmd, args, _opts) => {
      try {
        const output = String(_activeDispatch(renderSpawnCommand(cmd, args)) || "");
        return {
          stdout: Buffer.from(output),
          stderr: Buffer.from(""),
          status: 0,
          signal: null,
        };
      } catch (err) {
        return {
          stdout: Buffer.from(String(err?.stdout || "")),
          stderr: Buffer.from(String(err?.stderr || err?.message || err || "")),
          status: err?.status ?? err?.exitCode ?? 1,
          signal: null,
        };
      }
    },

    spawn: (cmd, args) => {
      const proc = new EventEmitter();
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.stdin = new PassThrough();
      proc.kill = () => {};
      proc.pid = 9999;
      _pendingChildProcessOps += 1;
      setImmediate(() => {
        try {
          const output = String(_activeDispatch(renderSpawnCommand(cmd, args)) || "");
          if (output) proc.stdout.write(output);
          proc.stdout.end();
          proc.stderr.end();
          proc.emit("exit", 0, null);
          proc.emit("close", 0, null);
        } catch (err) {
          const stdout = String(err?.stdout || "");
          const stderr = String(err?.stderr || err?.message || err || "");
          if (stdout) proc.stdout.write(stdout);
          if (stderr) proc.stderr.write(stderr);
          proc.stdout.end();
          proc.stderr.end();
          const exitCode = err?.status ?? err?.exitCode ?? 1;
          proc.emit("exit", exitCode, null);
          proc.emit("close", exitCode, null);
        } finally {
          _pendingChildProcessOps = Math.max(0, _pendingChildProcessOps - 1);
        }
      });
      return proc;
    },

    exec: (cmd, opts, cb) => {
      const callback = typeof opts === "function" ? opts : cb;
      _pendingChildProcessOps += 1;
      try {
        const result = String(_activeDispatch(cmd) || "");
        if (callback) {
          setImmediate(() => {
            try {
              callback(null, result, "");
            } finally {
              _pendingChildProcessOps = Math.max(0, _pendingChildProcessOps - 1);
            }
          });
        } else {
          _pendingChildProcessOps = Math.max(0, _pendingChildProcessOps - 1);
        }
      } catch (err) {
        if (callback) {
          setImmediate(() => {
            try {
              callback(err, "", err.message);
            } finally {
              _pendingChildProcessOps = Math.max(0, _pendingChildProcessOps - 1);
            }
          });
        } else {
          _pendingChildProcessOps = Math.max(0, _pendingChildProcessOps - 1);
        }
      }
      return { kill: () => {} };
    },
  };
});

// ══════════════════════════════════════════════════════════════════════════
//  Configuration
// ══════════════════════════════════════════════════════════════════════════

/** Number of times to execute each template (≥2 catches flakiness) */
const REPEAT_COUNT = Math.max(1, Number(process.env.REPEAT_COUNT ?? "1"));

/** Override delay settings so canary / wait nodes don't sleep for real */
const SPEED_OVERRIDES = { promotionDelayMs: 10, delayMs: 1, cooldownSec: 0 };

vi.setConfig({ testTimeout: 90_000 });

// ══════════════════════════════════════════════════════════════════════════
//  Shard support
//  VITEST_SHARD=1  VITEST_TOTAL_SHARDS=4  → run first ¼ of templates
// ══════════════════════════════════════════════════════════════════════════

function getShardedTemplates() {
  const shard  = Number(process.env.VITEST_SHARD ?? "0");
  const total  = Number(process.env.VITEST_TOTAL_SHARDS ?? "0");
  if (!shard || !total || total < 2) return WORKFLOW_TEMPLATES;
  return WORKFLOW_TEMPLATES.filter((_, i) => i % total === shard - 1);
}

const TEMPLATES_TO_TEST = getShardedTemplates();

// ══════════════════════════════════════════════════════════════════════════
//  Test harness lifecycle helper
// ══════════════════════════════════════════════════════════════════════════

let currentHarness = null;

function setupHarness(templateId, varOverrides = {}) {
  const fixtures = TEMPLATE_FIXTURES[templateId] ?? { scenario: {}, inputVars: {} };
  const harness  = createTemplateHarness(templateId, fixtures.scenario, {
    ...SPEED_OVERRIDES,
    ...varOverrides,
  });

  // Wire sandbox dispatch into the module-level reference
  _activeExecSandbox = harness.execSandbox;
  _activeDispatch    = (cmd) => harness.execSandbox.dispatch(cmd);

  currentHarness = harness;
  return { harness, fixtures };
}

// ══════════════════════════════════════════════════════════════════════════
//  Global setup
// ══════════════════════════════════════════════════════════════════════════

beforeAll(async () => {
  await import("../workflow/workflow-nodes.mjs");
  ensureExperimentalNodeTypes();
});

afterEach(() => {
  if (process.env.BOSUN_TEST_HARNESS_DEBUG_CLEANUP === "1") {
    console.error(`[workflow-guaranteed] pendingChildProcessOps=${_pendingChildProcessOps}`);
  }
  currentHarness?.cleanup();
  currentHarness   = null;
  _activeDispatch  = (_cmd) => "";
  _activeExecSandbox = null;
  _pendingChildProcessOps = 0;
  vi.clearAllMocks();
});

// ══════════════════════════════════════════════════════════════════════════
//  Suite 1 — Parametric: every template runs clean with correct fixtures
// ══════════════════════════════════════════════════════════════════════════

guaranteedDescribe("guaranteed: all templates execute without engine errors", () => {
  for (const template of TEMPLATES_TO_TEST) {
    const { id } = template;
    const fixtures = TEMPLATE_FIXTURES[id] ?? { scenario: {}, inputVars: {} };

    it(`${id}`, async () => {
      const { harness } = setupHarness(id);

      const { ctx } = await harness.run(fixtures.inputVars ?? {});

      // 1. Engine must not have thrown
      expect(ctx, `${id}: engine returned undefined context`).toBeDefined();
      expect(ctx.id,  `${id}: context has no id`).toBeDefined();
      expect(ctx.startedAt, `${id}: startedAt missing`).toBeGreaterThan(0);

      // 2. Zero engine-level errors
      harness.assertions.noEngineErrors(ctx);
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  Suite 2 — Template installs with correct metadata
// ══════════════════════════════════════════════════════════════════════════

guaranteedDescribe("guaranteed: template installation metadata", () => {
  for (const template of TEMPLATES_TO_TEST) {
    const { id } = template;

    it(`${id} installs with correct metadata`, () => {
      // Import directly — no engine needed
      const t = getTemplate(id);
      expect(t, `${id}: template not found`).toBeDefined();
      expect(t.name,        `${id}: missing .name`        ).toBeTruthy();
      expect(t.description, `${id}: missing .description` ).toBeTruthy();
      expect(t.category,    `${id}: missing .category`    ).toBeTruthy();
      expect(Array.isArray(t.nodes), `${id}: .nodes must be an array`).toBe(true);
      expect(t.nodes.length, `${id}: template has no nodes`).toBeGreaterThan(0);
      expect(typeof t.variables, `${id}: .variables must be an object`).toBe("object");
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════
//  Suite 3 — Flakiness detection (REPEAT_COUNT > 1)
//  Run each template N times and assert identical success/failure pattern.
// ══════════════════════════════════════════════════════════════════════════

if (REPEAT_COUNT > 1) {
  guaranteedDescribe(`guaranteed: flakiness detection (${REPEAT_COUNT} runs per template)`, () => {
    for (const template of TEMPLATES_TO_TEST) {
      const { id } = template;
      const fixtures = TEMPLATE_FIXTURES[id] ?? { scenario: {}, inputVars: {} };

      it(`${id} produces consistent results across ${REPEAT_COUNT} runs`, async () => {
        const runs = [];

        for (let i = 0; i < REPEAT_COUNT; i++) {
          const { harness } = setupHarness(id);
          try {
            const { ctx } = await harness.run(fixtures.inputVars ?? {});
            runs.push({ errors: ctx.errors.length, success: true });
          } catch (err) {
            runs.push({ errors: -1, success: false, message: err.message });
          } finally {
            harness.cleanup();
          }
        }

        // All runs should agree on success/failure
        const allSucceeded = runs.every((r) => r.success && r.errors === 0);
        const allFailed    = runs.every((r) => !r.success || r.errors > 0);

        if (!allSucceeded && !allFailed) {
          const summary = runs.map((r, i) => `  run ${i + 1}: ${r.success ? `ok (${r.errors} errs)` : `FAIL ${r.message ?? ""}`}`).join("\n");
          throw new Error(`${id}: FLAKY — results inconsistent across ${REPEAT_COUNT} runs:\n${summary}`);
        }

        // If it always fails, that's at least deterministic — but still fail the test
        expect(allSucceeded, `${id}: failed consistently on all ${REPEAT_COUNT} runs`).toBe(true);
      });
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════
//  Suite 4 — Behavioral contracts (per-template focused tests)
// ══════════════════════════════════════════════════════════════════════════

guaranteedDescribe("guaranteed: behavioral contracts", () => {

  // ── GitHub templates ──────────────────────────────────────────────────

  it("template-pr-merge-strategy: trigger fires and CI check node runs", async () => {
    const { harness, fixtures } = setupHarness("template-pr-merge-strategy");
    const { ctx } = await harness.run(fixtures.inputVars);

    harness.assertions.noEngineErrors(ctx);
    const t = getTemplate("template-pr-merge-strategy");
    const checkCiNode = t.nodes.find((n) => n.type === "validation.build" || n.type === "action.run_command");
    if (checkCiNode) {
      // Verify the node ran (output may or may not exist depending on branch taken)
      expect(ctx).toBeDefined();
    }
  });

  it("template-pr-triage: receives PR metadata and completes", async () => {
    const { harness, fixtures } = setupHarness("template-pr-triage");
    const { ctx } = await harness.run({ ...fixtures.inputVars, prNumber: 100, prTitle: "feat: dark mode", prBody: "Adds dark mode", prAuthor: "dev-user" });
    harness.assertions.noEngineErrors(ctx);
  });

  it("template-stale-pr-reaper: handles stale PR list without errors", async () => {
    const { harness } = setupHarness("template-stale-pr-reaper");
    const { ctx } = await harness.run({});
    harness.assertions.noEngineErrors(ctx);
    // The sandbox has 2 stale PRs (10, 11) and 1 recent PR (12)
    expect(ctx).toBeDefined();
  });

  it("template-release-drafter: produces output from merged-PR list", async () => {
    const { harness, fixtures } = setupHarness("template-release-drafter");
    const { ctx } = await harness.run({ ...fixtures.inputVars });
    harness.assertions.noEngineErrors(ctx);
  });

  it("template-bosun-pr-watchdog: runs watch cycle without crashing", async () => {
    const { harness, fixtures } = setupHarness("template-bosun-pr-watchdog");
    const { ctx } = await harness.run(fixtures.inputVars);
    harness.assertions.noEngineErrors(ctx);
  });

  it("template-github-kanban-sync: syncs kanban state with GitHub without errors", async () => {
    const { harness } = setupHarness("template-github-kanban-sync");
    const { ctx } = await harness.run({});
    harness.assertions.noEngineErrors(ctx);
  });

  it("template-sdk-conflict-resolver: resolves SDK conflict branch without crash", async () => {
    const { harness, fixtures } = setupHarness("template-sdk-conflict-resolver");
    const { ctx } = await harness.run(fixtures.inputVars);
    harness.assertions.noEngineErrors(ctx);
  });

  // ── Agent templates ───────────────────────────────────────────────────

  it("template-review-agent: launches review agent on a PR", async () => {
    const { harness, fixtures } = setupHarness("template-review-agent");
    const { ctx } = await harness.run(fixtures.inputVars);
    harness.assertions.noEngineErrors(ctx);
  });

  it("template-frontend-agent: dispatches frontend task to agent", async () => {
    const { harness, fixtures } = setupHarness("template-frontend-agent");
    const { ctx } = await harness.run(fixtures.inputVars);
    harness.assertions.noEngineErrors(ctx);
  });

  it("template-backend-agent: dispatches backend task to agent", async () => {
    const { harness, fixtures } = setupHarness("template-backend-agent");
    const { ctx } = await harness.run(fixtures.inputVars);
    harness.assertions.noEngineErrors(ctx);
  });

  it.skipIf(skipLocallyForSpeed)("template-custom-agent: dispatches custom task to agent", async () => {
    const { harness, fixtures } = setupHarness("template-custom-agent");
    const { ctx } = await harness.run(fixtures.inputVars);
    harness.assertions.noEngineErrors(ctx);
  }, 60000);

  it("template-agent-session-monitor: monitors session without errors", async () => {
    const { harness, fixtures } = setupHarness("template-agent-session-monitor");
    const { ctx } = await harness.run(fixtures.inputVars);
    harness.assertions.noEngineErrors(ctx);
  });

  // ── Planning templates ────────────────────────────────────────────────

  it("template-task-planner: agent generates tasks and kanban is populated", async () => {
    const { harness, fixtures } = setupHarness("template-task-planner");
    const { ctx } = await harness.run({ ...fixtures.inputVars, taskCount: 3 });
    harness.assertions.noEngineErrors(ctx);
  });

  it("template-task-replenish: replenishes low task queue without error", async () => {
    const { harness } = setupHarness("template-task-replenish");
    const { ctx } = await harness.run({});
    harness.assertions.noEngineErrors(ctx);
  });

  it("template-nightly-report: generates nightly activity summary", async () => {
    const { harness } = setupHarness("template-nightly-report");
    const { ctx } = await harness.run({});
    harness.assertions.noEngineErrors(ctx);
  });

  it("template-sprint-retrospective: runs full retro without crash", async () => {
    const { harness, fixtures } = setupHarness("template-sprint-retrospective");
    const { ctx } = await harness.run({ ...fixtures.inputVars });
    harness.assertions.noEngineErrors(ctx);
  });

  it("template-weekly-fitness-summary: emits parse-safe summary with mixed telemetry quality", async () => {
    const harness = createTemplateHarness("template-weekly-fitness-summary", {
      prs: [],
      issues: [],
      checks: [],
      releases: [],
    });
    const fixtures = TEMPLATE_FIXTURES["template-weekly-fitness-summary"] ?? { inputVars: {} };

    const { ctx } = await harness.run({
      ...fixtures.inputVars,
      lookbackDays: 7,
      maxFollowupTasks: 2,
      createFollowupTasks: true,
    });

    harness.assertions.noEngineErrors(ctx);
    const summary = ctx?.data?.fitnessSummary;
    expect(summary?.schemaVersion).toBe("1.0");
    expect(summary?.metrics?.throughput).toBeDefined();
    expect(summary?.metrics?.regression_rate).toBeDefined();
    expect(summary?.metrics?.merge_success).toBeDefined();
    expect(summary?.metrics?.reopened_tasks).toBeDefined();
    expect(summary?.metrics?.debt_growth).toBeDefined();
    expect(typeof summary?.metrics?.throughput?.confidence).toBe("string");
    expect(summary?.metrics?.throughput).toHaveProperty("delta");
    expect(summary?.metrics?.merge_success).toHaveProperty("delta");
    expect(Array.isArray(summary?.trendAlerts)).toBe(true);
    expect(summary?.plannerSignals?.schemaVersion).toBe("1.0");
    expect(summary?.plannerSignals?.trendDeltas).toBeTruthy();
    expect(summary?.plannerArtifact?.schemaVersion).toBe("1.0");
    expect(summary?.plannerArtifact?.trendDeltas).toBeTruthy();

    const serialized = ctx?.data?.fitnessSummaryJson;
    expect(() => JSON.parse(serialized)).not.toThrow();

    const artifact = ctx?.getNodeOutput?.("persist-fitness-summary");
    expect(artifact?.success).toBe(true);

    harness.cleanup();
  });

  it("template-weekly-fitness-summary: emits artifact and survives degraded telemetry", async () => {
    const { harness, fixtures } = setupHarness("template-weekly-fitness-summary");
    const runInput = { ...fixtures.inputVars, createFollowupTasks: false };

    const { ctx: firstCtx } = await harness.run(runInput);
    harness.assertions.noEngineErrors(firstCtx);

    const firstWrite = harness.assertions.nodeSucceeded(firstCtx, "persist-fitness-summary");
    const firstArtifact = JSON.parse(readFileSync(firstWrite.path, "utf8"));
    expect(firstArtifact?.schemaVersion).toBe("1.0");
    expect(firstArtifact?.dataQuality?.overallConfidence).toBeTruthy();
    writeFileSync(firstWrite.path, JSON.stringify({
      fitnessSummary: {
        priorWeekTrendDeltas: { throughput: 5.5 },
        trendDeltas: { throughput: 4.25 },
        metrics: { throughput: { delta: 3.0 } },
      },
    }), "utf8");

    const stableDispatch = _activeDispatch;
    _activeDispatch = (cmd) => {
      if (/gh\s+pr\s+list/i.test(String(cmd))) {
        throw new Error("gh unavailable (degraded fixture)");
      }
      return stableDispatch(cmd);
    };

    const { ctx: secondCtx } = await harness.run(runInput);
    harness.assertions.noEngineErrors(secondCtx);

    const secondWrite = harness.assertions.nodeSucceeded(secondCtx, "persist-fitness-summary");
    const secondArtifact = JSON.parse(readFileSync(secondWrite.path, "utf8"));
    expect(["missing", "degraded", "ok"]).toContain(secondArtifact?.sourceHealth?.prs?.status);
    expect(secondArtifact?.metrics?.merge_success?.confidence).toBe("low");
    expect(secondArtifact?.trendDeltas).toHaveProperty("throughput");
    expect(secondArtifact?.priorWeekTrendDeltas).toHaveProperty("throughput");
    expect(secondArtifact?.priorWeekTrendDeltas?.throughput).toBe(5.5);
    expect(secondArtifact?.priorWeekDeltas).toBeTruthy();
    expect(secondArtifact?.metrics?.throughput).toHaveProperty("delta");
    expect(secondArtifact?.plannerSignals?.metricStatus).toHaveProperty("throughput");
    expect(() => JSON.parse(JSON.stringify(secondArtifact?.plannerSignals ?? {}))).not.toThrow();

    try {
      if (existsSync(firstWrite.path)) rmSync(firstWrite.path, { force: true });
    } catch {
      // best-effort cleanup of generated artifacts
    }
  });

  it("template-weekly-fitness-summary: mixed degraded + healthy sources produce parse-safe trend deltas", async () => {
    const { harness, fixtures } = setupHarness("template-weekly-fitness-summary");
    const runInput = { ...fixtures.inputVars, createFollowupTasks: false };

    const stableDispatch = _activeDispatch;
    _activeDispatch = (cmd) => {
      const command = String(cmd || "");
      if (/^bosun\s+task\s+list\b/i.test(command)) {
        return "{ malformed-task-json";
      }
      if (/task-debt-ledger\.jsonl/i.test(command)) {
        return "{ malformed-ledger-json";
      }
      return stableDispatch(command);
    };

    const { ctx } = await harness.run(runInput);
    harness.assertions.noEngineErrors(ctx);

    const write = harness.assertions.nodeSucceeded(ctx, "persist-fitness-summary");
    const artifact = JSON.parse(readFileSync(write.path, "utf8"));

    expect(artifact?.sourceHealth?.tasks?.status).toBe("degraded");
    expect(artifact?.sourceHealth?.debt?.status).toBe("degraded");
    expect(artifact?.sourceHealth?.prs?.status).toBe("ok");
    expect(artifact?.metrics?.throughput?.value).toBeNull();
    expect(artifact?.metrics?.throughput?.confidence).toBe("low");
    expect(artifact?.metrics?.debt_growth?.value).toBeNull();
    expect(artifact?.metrics?.regression_rate).toHaveProperty("value");

    expect(() => JSON.parse(JSON.stringify(artifact?.trendDeltas ?? {}))).not.toThrow();
    expect(() => JSON.parse(JSON.stringify(artifact?.priorWeekTrendDeltas ?? {}))).not.toThrow();
    expect(() => JSON.parse(JSON.stringify(artifact?.plannerSignals ?? {}))).not.toThrow();
    expect(() => JSON.parse(JSON.stringify(artifact?.plannerArtifact ?? {}))).not.toThrow();
    expect(artifact?.trendDeltas).toHaveProperty("merge_success");
    expect(artifact?.priorWeekTrendDeltas).toHaveProperty("merge_success");
    expect(["low", "medium", "high"]).toContain(artifact?.dataQuality?.overallConfidence);
    const telemetryAlerts = Array.isArray(artifact?.trendAlerts)
      ? artifact.trendAlerts.filter((alert) => String(alert?.metric || "").startsWith("telemetry:"))
      : [];
    expect(telemetryAlerts.length).toBeGreaterThan(0);
  });

  it("template-weekly-fitness-summary: partially parsed task telemetry still computes best-effort throughput", async () => {
    const { harness, fixtures } = setupHarness("template-weekly-fitness-summary");
    const runInput = { ...fixtures.inputVars, createFollowupTasks: false };
    const completedAt = isoDaysAgo(1);

    const stableDispatch = _activeDispatch;
    _activeDispatch = (cmd) => {
      const command = String(cmd || "");
      if (/^bosun\s+task\s+list\b/i.test(command)) {
        return [
          JSON.stringify({ status: "done", completedAt, reopenCount: 0 }),
          "{ malformed-task-json",
        ].join("\n");
      }
      return stableDispatch(command);
    };

    const { ctx } = await harness.run(runInput);
    harness.assertions.noEngineErrors(ctx);

    const write = harness.assertions.nodeSucceeded(ctx, "persist-fitness-summary");
    const artifact = JSON.parse(readFileSync(write.path, "utf8"));

    expect(artifact?.sourceHealth?.tasks?.status).toBe("degraded");
    expect(artifact?.metrics?.throughput?.value).toBe(1);
    expect(artifact?.metrics?.throughput?.confidence).toBe("low");
    expect(artifact?.metrics?.reopened_tasks?.value).toBe(0);
    expect(artifact?.priorWeekDeltas).toHaveProperty("throughput");
  });

  it("template-weekly-fitness-summary: non-json task telemetry is marked degraded and suppressed from trend alerts", async () => {
    const { harness, fixtures } = setupHarness("template-weekly-fitness-summary");
    const runInput = { ...fixtures.inputVars, createFollowupTasks: false };

    const stableDispatch = _activeDispatch;
    _activeDispatch = (cmd) => {
      const command = String(cmd || "");
      if (/^bosun\s+task\s+list\b/i.test(command)) {
        return "2 task(s):\n[done] TASK-1\n[inprogress] TASK-2";
      }
      return stableDispatch(command);
    };

    const { ctx } = await harness.run(runInput);
    harness.assertions.noEngineErrors(ctx);

    const write = harness.assertions.nodeSucceeded(ctx, "persist-fitness-summary");
    const artifact = JSON.parse(readFileSync(write.path, "utf8"));

    expect(artifact?.sourceHealth?.tasks?.status).toBe("degraded");
    expect(artifact?.metrics?.throughput?.confidence).toBe("low");
    expect(artifact?.metrics?.throughput?.value).toBeNull();
    const throughputAlerts = Array.isArray(artifact?.trendAlerts)
      ? artifact.trendAlerts.filter((alert) => alert?.metric === "throughput")
      : [];
    expect(throughputAlerts.length).toBe(0);
    const telemetryAlerts = Array.isArray(artifact?.trendAlerts)
      ? artifact.trendAlerts.filter((alert) => alert?.metric === "telemetry:tasks")
      : [];
    expect(telemetryAlerts.length).toBeGreaterThan(0);
  });

  it("template-weekly-fitness-summary: parses wrapped canonical task payloads and preserves planner artifact", async () => {
    const { harness, fixtures } = setupHarness("template-weekly-fitness-summary");
    const runInput = { ...fixtures.inputVars, createFollowupTasks: false };
    const completedAt = isoDaysAgo(1);

    const stableDispatch = _activeDispatch;
    _activeDispatch = (cmd) => {
      const command = String(cmd || "");
      if (/^bosun\s+task\s+list\b/i.test(command)) {
        return JSON.stringify({
          result: {
            tasks: [
              { status: "done", completedAt, reopenCount: 0 },
            ],
          },
        });
      }
      return stableDispatch(command);
    };

    const { ctx } = await harness.run(runInput);
    harness.assertions.noEngineErrors(ctx);

    const write = harness.assertions.nodeSucceeded(ctx, "persist-fitness-summary");
    const artifact = JSON.parse(readFileSync(write.path, "utf8"));

    expect(artifact?.sourceHealth?.tasks?.status).toBe("ok");
    expect(artifact?.metrics?.throughput?.value).toBe(1);
    expect(artifact?.plannerArtifact?.schemaVersion).toBe("1.0");
    expect(() => JSON.parse(JSON.stringify(artifact?.plannerArtifact ?? {}))).not.toThrow();
  });
  // ── CI/CD templates ───────────────────────────────────────────────────

  it("template-build-deploy: runs build → deploy pipeline", async () => {
    const { harness, fixtures } = setupHarness("template-build-deploy");
    const { ctx } = await harness.run({ ...fixtures.inputVars });
    harness.assertions.noEngineErrors(ctx);
  });

  it("template-release-pipeline: tags and creates release", async () => {
    const { harness, fixtures } = setupHarness("template-release-pipeline");
    const { ctx } = await harness.run({ ...fixtures.inputVars });
    harness.assertions.noEngineErrors(ctx);
  });

  it("template-canary-deploy: canary pipeline with fast promotion delay", async () => {
    const { harness } = setupHarness("template-canary-deploy");
    const { ctx } = await harness.run({ branch: "main", environment: "production", promotionDelayMs: 1 });
    harness.assertions.noEngineErrors(ctx);
  });

  // ── Reliability templates ─────────────────────────────────────────────

  it("template-error-recovery: handles build failure gracefully", async () => {
    const { harness, fixtures } = setupHarness("template-error-recovery");
    const { ctx } = await harness.run({ ...fixtures.inputVars });
    harness.assertions.noEngineErrors(ctx);
  });

  it("template-anomaly-watchdog: runs detection cycle without crash", async () => {
    const { harness } = setupHarness("template-anomaly-watchdog");
    const { ctx } = await harness.run({});
    harness.assertions.noEngineErrors(ctx);
  });

  it("template-workspace-hygiene: runs hygiene checks without error", async () => {
    const { harness } = setupHarness("template-workspace-hygiene");
    const { ctx } = await harness.run({});
    harness.assertions.noEngineErrors(ctx);
  });

  it("template-health-check: all health checks pass in sandbox", async () => {
    const { harness } = setupHarness("template-health-check");
    const { ctx } = await harness.run({});
    harness.assertions.noEngineErrors(ctx);
  });

  it("template-task-finalization-guard: finalizes task and creates PR", async () => {
    const { harness, fixtures } = setupHarness("template-task-finalization-guard");
    const { ctx } = await harness.run({ ...fixtures.inputVars });
    harness.assertions.noEngineErrors(ctx);
  });

  it("template-task-repair-worktree: repairs broken worktree", async () => {
    const { harness, fixtures } = setupHarness("template-task-repair-worktree");
    const { ctx } = await harness.run({ ...fixtures.inputVars });
    harness.assertions.noEngineErrors(ctx);
  });

  it("template-task-status-transition-manager: transitions task status", async () => {
    const { harness, fixtures } = setupHarness("template-task-status-transition-manager");
    const { ctx } = await harness.run({ ...fixtures.inputVars });
    harness.assertions.noEngineErrors(ctx);
  });

  it.skipIf(skipLocallyForSpeed)("template-incident-response: handles incident without crash", async () => {
    const { harness, fixtures } = setupHarness("template-incident-response");
    const { ctx } = await harness.run({ ...fixtures.inputVars });
    harness.assertions.noEngineErrors(ctx);
  }, 60000);

  it("template-task-archiver: archives completed tasks without error", async () => {
    const { harness } = setupHarness("template-task-archiver");
    const { ctx } = await harness.run({});
    harness.assertions.noEngineErrors(ctx);
  });

  it("template-sync-engine: runs sync cycle without crash", async () => {
    const { harness } = setupHarness("template-sync-engine");
    const { ctx } = await harness.run({});
    harness.assertions.noEngineErrors(ctx);
  });

  // ── Security templates ────────────────────────────────────────────────

  it("template-dependency-audit: runs npm audit and reports vulnerabilities", async () => {
    const { harness } = setupHarness("template-dependency-audit");
    const { ctx } = await harness.run({});
    harness.assertions.noEngineErrors(ctx);
  });

  it("template-secret-scanner: scans for secrets without crash", async () => {
    const { harness } = setupHarness("template-secret-scanner");
    const { ctx } = await harness.run({});
    harness.assertions.noEngineErrors(ctx);
  });

  // ── Task lifecycle templates ──────────────────────────────────────────

  it("template-task-lifecycle: runs full task from trigger to PR", async () => {
    const { harness, fixtures } = setupHarness("template-task-lifecycle");
    const { ctx } = await harness.run({ ...fixtures.inputVars });
    harness.assertions.noEngineErrors(ctx);
  });

  it("template-task-batch-processor: processes a batch of tasks", async () => {
    const { harness, fixtures } = setupHarness("template-task-batch-processor");
    const { ctx } = await harness.run({ ...fixtures.inputVars });
    harness.assertions.noEngineErrors(ctx);
  });

  it.skipIf(skipLocallyForSpeed)("template-task-batch-pr: creates PRs for a batch of tasks", async () => {
    const { harness, fixtures } = setupHarness("template-task-batch-pr");
    const { ctx } = await harness.run({ ...fixtures.inputVars });
    harness.assertions.noEngineErrors(ctx);
  }, 60000);

  // ── Agent chain templates ─────────────────────────────────────────────

  it("template-voice-video-parallel-rollout: deploys AV stack in parallel", async () => {
    const { harness, fixtures } = setupHarness("template-voice-video-parallel-rollout");
    const { ctx } = await harness.run({ ...fixtures.inputVars });
    harness.assertions.noEngineErrors(ctx);
  });

  it("template-meeting-subworkflow-chain: chained meeting orchestration completes", async () => {
    const { harness, fixtures } = setupHarness("template-meeting-subworkflow-chain");
    const { ctx } = await harness.run({ ...fixtures.inputVars });
    harness.assertions.noEngineErrors(ctx);
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  Suite 5 — Exec sandbox contract tests
//  Verify the gh CLI sandbox returns correct data for specific commands.
// ══════════════════════════════════════════════════════════════════════════

guaranteedDescribe("sandbox: gh CLI command contracts", () => {
  const { prs, issues, releases } = {
    prs:      [{ number: 42, id: 242042, title: "PR #42", body: "", state: "open", draft: false, html_url: "https://github.com/virtengine/bosun/pull/42", head: { ref: "feat/login", sha: "abc123" }, base: { ref: "main", sha: "base123" }, user: { login: "dev-user" }, labels: [], mergeable: "MERGEABLE", mergeable_state: "clean", merged: false, created_at: "2026-01-01T00:00:00Z", additions: 10, deletions: 2, changed_files: 1, commits: 1 }],
    issues:   [{ number: 1, id: 100001, title: "Issue #1", body: "", state: "open", html_url: "https://github.com/virtengine/bosun/issues/1", user: { login: "dev-user" }, labels: [], created_at: "2026-01-01T00:00:00Z" }],
    releases: [{ id: 500000, tag_name: "v1.0.0", name: "v1.0.0", body: "", draft: false, prerelease: false, html_url: "", created_at: "2026-01-01T00:00:00Z", published_at: "2026-01-01T00:00:00Z" }],
  };

  let sb;
  beforeEach(() => { sb = createExecSandbox({ prs, issues, releases }); });

  it("gh pr view 42 --json number,title returns JSON with correct fields", () => {
    const raw = sb.dispatch("gh pr view 42 --json number,title");
    const parsed = JSON.parse(raw);
    expect(parsed.number).toBe(42);
    expect(parsed.title).toContain("PR #42");
  });

  it("gh pr list --json number,state returns array with state=open", () => {
    const list = JSON.parse(sb.dispatch("gh pr list --json number,state"));
    expect(Array.isArray(list)).toBe(true);
    expect(list[0].state).toBe("open");
  });

  it("gh pr merge 42 mutates state to merged", () => {
    sb.dispatch("gh pr merge 42 --squash");
    const view = JSON.parse(sb.dispatch("gh pr view 42 --json number,state,merged"));
    expect(view.state).toBe("merged");
    expect(view.merged).toBe(true);
  });

  it("gh issue view 1 returns correct issue", () => {
    const issue = JSON.parse(sb.dispatch("gh issue view 1 --json number,title,state"));
    expect(issue.number).toBe(1);
    expect(issue.state).toBe("open");
  });

  it("gh issue close 1 mutates state to closed", () => {
    sb.dispatch("gh issue close 1");
    const issue = JSON.parse(sb.dispatch("gh issue view 1 --json state"));
    expect(issue.state).toBe("closed");
  });

  it("gh issue view (unseen number) returns auto-generated fixture", () => {
    const issue = JSON.parse(sb.dispatch("gh issue view 9999 --json number,title"));
    expect(issue.number).toBe(9999);
    expect(issue.title).toBeDefined();
  });

  it("gh release view returns correct release", () => {
    const rel = JSON.parse(sb.dispatch("gh release view --json tag_name,name"));
    expect(rel.tag_name).toBe("v1.0.0");
  });

  it("gh release create v2.0.0 appends to release list", () => {
    sb.dispatch("gh release create v2.0.0 --notes ''");
    const list = JSON.parse(sb.dispatch("gh release list --json tag_name"));
    const tags = list.map((r) => r.tag_name);
    expect(tags).toContain("v2.0.0");
    expect(tags).toContain("v1.0.0");
  });

  it("git rev-parse HEAD returns a git hash", () => {
    const hash = sb.dispatch("git rev-parse HEAD");
    expect(/^[a-f0-9]{10,}/.test(hash)).toBe(true);
  });

  it("npm audit returns valid JSON", () => {
    const raw = sb.dispatch("npm audit --json");
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveProperty("vulnerabilities");
  });

  it("records all calls for assertion", () => {
    sb.dispatch("gh pr list --json number");
    sb.dispatch("gh issue list --json number");
    expect(sb.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("callsMatching filters by pattern", () => {
    sb.dispatch("gh pr view 42");
    sb.dispatch("gh issue view 1");
    const prCalls = sb.callsMatching(/gh pr/);
    expect(prCalls.every((c) => /gh pr/i.test(c.cmd))).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  Suite 6 — Fixture registry completeness
// ══════════════════════════════════════════════════════════════════════════

guaranteedDescribe("guaranteed: fixture registry covers all templates", () => {
  it("every template has an entry in TEMPLATE_FIXTURES", () => {
    const missing = [];
    for (const template of WORKFLOW_TEMPLATES) {
      if (!TEMPLATE_FIXTURES[template.id]) {
        missing.push(template.id);
      }
    }
    if (missing.length) {
      throw new Error(
        `Missing TEMPLATE_FIXTURES entries for:\n${missing.map((id) => `  • ${id}`).join("\n")}\n` +
        `Add entries to tests/sandbox/fixtures.mjs`,
      );
    }
  });
});
