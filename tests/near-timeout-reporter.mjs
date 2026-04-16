/**
 * Near-timeout reporter — surfaces tests that are approaching their timeout
 * budget so you can fix them BEFORE they become flaky failures.
 *
 * Prints a warning when any test consumes more than 75% of its allowed timeout.
 * At end-of-run, prints a summary of all at-risk tests sorted by utilization.
 *
 * Configure threshold via BOSUN_TEST_TIMEOUT_WARN_PCT (default 75).
 */

const WARN_PCT = (() => {
  const env = Number.parseInt(process.env.BOSUN_TEST_TIMEOUT_WARN_PCT, 10);
  return Number.isFinite(env) && env > 0 && env < 100 ? env : 75;
})();

export default class NearTimeoutReporter {
  constructor() {
    this._atRisk = [];
  }

  onFinished(files) {
    if (!files) return;
    for (const file of files) {
      this._collectFromTasks(file.tasks);
      if (file.tasks) {
        for (const suite of file.tasks) {
          if (suite.tasks) this._collectFromTasks(suite.tasks);
        }
      }
    }

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
      // Recurse into nested describes
      if (task.tasks) {
        this._collectFromTasks(task.tasks);
        continue;
      }
      if (task.result?.state !== "pass") continue;
      const durationMs = task.result?.duration;
      if (typeof durationMs !== "number") continue;

      // Vitest stores the effective timeout on task.timeout
      const timeoutMs = task.timeout ?? 5000;
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
