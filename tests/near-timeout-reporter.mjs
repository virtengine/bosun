/**
 * Near-timeout reporter — surfaces tests that are approaching their timeout
 * budget so you can fix them BEFORE they become flaky failures.
 *
 * Prints a warning when any test consumes more than 75% of its allowed timeout.
 * At end-of-run, prints a summary of all at-risk tests sorted by utilization.
 *
 * Configure threshold via BOSUN_TEST_TIMEOUT_WARN_PCT (default 75).
 *
 * NOTE (vitest 4): the reporter hook is `onTestRunEnd(testModules, unhandledErrors, reason)`.
 * This file previously implemented `onFinished(files)`, which was the vitest <=3 hook. Vitest 4
 * dropped `onFinished` from the reporter interface, so the method was never called and this
 * reporter silently reported nothing while still appearing in `reporters:` — meaning the
 * "fix at-risk tests before they flake" guardrail did not exist. Keep the hook name in sync with
 * the vitest major version: see tests/near-timeout-reporter.test.mjs, which pins it.
 */

const WARN_PCT = (() => {
  const env = Number.parseInt(process.env.BOSUN_TEST_TIMEOUT_WARN_PCT, 10);
  return Number.isFinite(env) && env > 0 && env < 100 ? env : 75;
})();

/** Fallback when a task carries no effective timeout (vitest default is 5s, but
 *  this project sets 15s on Windows — underestimate on purpose: a wrong low
 *  denominator over-reports, which is the safe direction for a warning. */
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Collect the root tasks of a test module.
 *
 * Vitest does not pass plain file tasks to `onTestRunEnd`: each entry is a
 * TestModule whose `task` is the file Task, and with `projects` configured the
 * modules can also arrive nested inside another module's `tasks` as collect-only
 * file nodes. All three shapes are handled so the reporter keeps working
 * whether or not the suite is run through a named project.
 */
function rootFilesOf(testModule) {
  const out = [];
  const task = testModule?.task ?? testModule;
  if (!task) return out;
  out.push(task);
  // Collect-only file nodes (project runs) nest further file tasks below.
  for (const child of task.tasks ?? []) {
    if (child?.tasks && !child.result) out.push(child);
  }
  return out;
}

export default class NearTimeoutReporter {
  constructor() {
    this._atRisk = [];
  }

  onTestRunEnd(testModules) {
    const files = [];
    for (const testModule of testModules ?? []) {
      for (const file of rootFilesOf(testModule)) {
        if (file) files.push(file);
      }
    }
    this._collectFromFiles(files);

    if (this._atRisk.length === 0) return;

    this._atRisk.sort((a, b) => b.pct - a.pct);

    console.log("");
    console.log(
      `⚠  Near-timeout warning: ${this._atRisk.length} test(s) used >${WARN_PCT}% of their timeout budget`,
    );
    console.log("   These tests are at risk of becoming flaky:\n");

    for (const entry of this._atRisk) {
      const bar = entry.pct >= 90 ? "🔴" : "🟡";
      console.log(
        `   ${bar} ${entry.pct}% (${entry.durationMs}ms / ${entry.timeoutMs}ms) — ${entry.name}`,
      );
    }
    console.log("");
  }

  _collectFromFiles(files) {
    for (const file of files) {
      this._collectFromTasks(file.tasks);
    }
  }

  _collectFromTasks(tasks) {
    if (!tasks) return;
    for (const task of tasks) {
      // Recurse into nested describes
      if (task.tasks) {
        this._collectFromTasks(task.tasks);
        continue;
      }
      if (task.result?.state !== "pass") continue;
      const durationMs = task.result?.duration;
      if (typeof durationMs !== "number") continue;

      // Vitest stores the effective timeout on task.timeout.
      const timeoutMs = task.timeout ?? DEFAULT_TIMEOUT_MS;
      // Vitest encodes "no timeout" as 0, not undefined, so the `??` above does
      // not catch it. A 0 denominator yields Infinity% — the entry sorts to the
      // very top of the warning and reports a test with no budget at all as the
      // most at-risk in the run. Such a test cannot flake on a budget it does not
      // have, so skip it (also covers NaN / negative values).
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) continue;
      const pct = Math.round((durationMs / timeoutMs) * 100);
      if (pct >= WARN_PCT) {
        const name = this._taskPath(task);
        this._atRisk.push({ name, durationMs: Math.round(durationMs), timeoutMs, pct });
      }
    }
  }

  _taskPath(task) {
    const parts = [];
    let current = task;
    while (current) {
      if (current.name) parts.unshift(current.name);
      current = current.suite;
    }
    return parts.join(" > ");
  }
}
