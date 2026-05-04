import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function read(relPath) {
  return readFileSync(resolve(ROOT, relPath), "utf8");
}

describe("status summary regressions", () => {
  it("refreshes full blocked-aware status counts instead of leaving stale partial snapshots", () => {
    const telegramSource = read("telegram/telegram-bot.mjs");

    expect(telegramSource).toContain("data.backlog_remaining = draftCount + todoCount");
    expect(telegramSource).toContain("data.counts.blocked = blockedCount");
    expect(telegramSource).toContain("data.counts.todo = todoCount + draftCount");
    expect(telegramSource).toContain("data.counts.done = doneCount");
    expect(telegramSource).toContain("data.counts.total = draftCount + todoCount + inprogressCount + reviewCount + doneCount + blockedCount");
  });

  it("treats blocked counts and blocked status history as failures in summaries", () => {
    const serverSource = read("server/ui-server.mjs");
    const uiDashboard = read("ui/tabs/dashboard.js");
    const siteDashboard = read("site/ui/tabs/dashboard.js");

    expect(serverSource).toContain("const blockedCount = Number(orchestratorStatus.counts.blocked ?? orchestratorStatus.counts.error ?? 0);");
    expect(serverSource).toContain('normalizedStatus === "error" || normalizedStatus === "failed" || normalizedStatus === "blocked"');

    for (const source of [uiDashboard, siteDashboard]) {
      expect(source).toContain("counts.blocked ?? counts.error ?? 0");
      expect(source).toContain('const headerScopeLabel = useLiveTaskCounts ? "Workspace-scoped totals" : "Runtime snapshot totals";');
      expect(source).toContain('<div class="dashboard-meta-copy">${headerScopeLabel}</div>');
    }
  });
});
