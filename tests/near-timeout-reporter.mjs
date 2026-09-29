/**
 * Near-timeout reporter — surfaces tests that are approaching their timeout
 * budget so you can fix them BEFORE they become flaky failures.
 *
 * Prints a warning when any test consumes more than 75% of its allowed timeout.
 * At end-of-run, prints a summary of all at-risk tests sorted by utilization.
 *
 * Configure threshold via BOSUN_TEST_TIMEOUT_WARN_PCT (default 75).
 *
 * Vitest major-version contract: vitest 4 calls `onTestRunEnd(testModules, …)`.
 * The vitest <=3 hook was `onFinished(files)`, and vitest 4 dropped it from the
 * reporter interface — a reporter that only implements `onFinished` is loaded
 * and configured without error but NEVER CALLED, so it silently reports nothing.
 * That is how this guardrail was dead while still appearing in `reporters:`.
 * Both hook names are implemented below and share one collection path, so the
 * reporter keeps working across the vitest 3 -> 4 boundary. Two other vitest 4
 * shape details are handled: each entry is a TestModule whose file Task lives on
 * `.task` (not the module itself), and an empty `tasks` array is truthy, so the
 * "has children" test must check length rather than existence.
 */

const WARN_PCT = (() => {
  const env = Number.parseInt(process.env.BOSUN_TEST_TIMEOUT_WARN_PCT, 10);
  return Number.isFinite(env) && env > 0 && env < 100 ? env : 75;
})();

/** Fallback when a task carries no effective timeout (the vitest default is
 *  5000 ms, but this project sets higher platform defaults — underestimate on
 *  purpose: a wrong low denominator over-reports, which is the safe direction
 *  for a warning). */
const DEFAULT_TIMEOUT_MS = 5000;

function hasChildTasks(task) {
  return Array.isArray(task?.tasks) && task.tasks.length > 0;
}

export default class NearTimeoutReporter {
  constructor() {
    this._atRisk = [];
  }

  // vitest 4 entry point.
  onTestRunEnd(testModules) {
    for (const testModule of testModules ?? []) {
      // A TestModule carries its file Task on `.task`; tolerate a raw task too.
      this._collectFromTasks([testModule?.task ?? testModule]);
    }
    this._report();
  }

  // vitest <=3 entry point, kept so the reporter degrades gracefully rather
  // than silently doing nothing if the runner is downgraded.
  onFinished(files) {
    this._collectFromTasks(files ?? []);
    this._report();
  }

  _report() {
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

  _collectFromTasks(tasks) {
    if (!tasks) return;
    for (const task of tasks) {
      if (!task) continue;
      // Recurse into suites; `tasks: []` must not terminate collection.
      if (hasChildTasks(task)) {
        this._collectFromTasks(task.tasks);
        continue;
      }
      if (task.result?.state !== "pass") continue;
      const durationMs = task.result?.duration;
      if (typeof durationMs !== "number") continue;

      // Vitest stores the effective timeout on task.timeout
      const timeoutMs = task.timeout ?? DEFAULT_TIMEOUT_MS;
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
