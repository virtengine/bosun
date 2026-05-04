/**
 * Regression tests for the Fleet/Agents tab rendering fix.
 *
 * Validates the patterns that previously caused:
 *   "Failed to execute 'insertBefore' on 'Node': parameter 1 is not of type 'Node'."
 *
 * Root causes addressed:
 *  1. `entries` array rebuilt every render → infinite useEffect loop.
 *  2. Sibling `&&` conditionals producing mixed false/VNode children.
 *  3. Index-based keys on mutable/reorderable lists.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const variablesSourceFiles = [
  "ui/styles/variables.css",
  "site/ui/styles/variables.css",
].map((relPath) => ({
  relPath,
  source: readFileSync(resolve(process.cwd(), relPath), "utf8"),
}));

const sourceFiles = [
  "ui/tabs/agents.js",
  "site/ui/tabs/agents.js",
].map((relPath) => ({
  relPath,
  source: readFileSync(resolve(process.cwd(), relPath), "utf8"),
}));

const sessionListSourceFiles = [
  "ui/components/session-list.js",
  "site/ui/components/session-list.js",
].map((relPath) => ({
  relPath,
  source: readFileSync(resolve(process.cwd(), relPath), "utf8"),
}));

const dashboardSourceFiles = [
  "ui/tabs/dashboard.js",
  "site/ui/tabs/dashboard.js",
].map((relPath) => ({
  relPath,
  source: readFileSync(resolve(process.cwd(), relPath), "utf8"),
}));

const telemetrySourceFiles = [
  "ui/tabs/telemetry.js",
  "site/ui/tabs/telemetry.js",
  "tui/screens/telemetry.mjs",
].map((relPath) => ({
  relPath,
  source: readFileSync(resolve(process.cwd(), relPath), "utf8"),
}));

const tuiAgentsSource = readFileSync(resolve(process.cwd(), "tui/screens/agents.mjs"), "utf8");

for (const { relPath, source } of sourceFiles) {
  describe(`FleetSessionsPanel render stability (${relPath})`, () => {
    it("renders a keyboard-accessible session id pill with copy feedback state", () => {
      expect(source).toContain("fleet-session-id-pill");
      expect(source).toContain("type=\"button\"");
      expect(source).toContain("aria-label=${`Copy session ID ${sessionId}`}");
      expect(source).toContain("data-copied=${copiedSessionId === sessionId ? \"true\" : \"false\"}");
      expect(source).toContain("sessionId.slice(0, 8)");
      expect(source).toContain("copySessionId(sessionId)");
      expect(source).toContain("fleet-session-id-pill-icon");
      expect(source).toContain('copiedSessionId === sessionId ? "✓" : ICONS.copy');
    });
    it("never fabricates session ids for task-only fallback entries", () => {
      expect(source).toContain("function resolveFleetEntrySessionId(entry)");
      expect(source).toContain("if (entry?.isTaskFallback || entry?.slot?.synthetic) return \"\";");
      expect(source).toContain("sessionId: \"\",");
      expect(source).not.toContain("sessionId: String(task?.id || task?.taskId || \"\").trim(),");
    });

    it("treats detached sessions as active based on status, not history-only placement", () => {
      expect(source).toContain("function isFleetEntryActive(entry)");
      expect(source).not.toContain("if (entry.isHistory) return false;");
      expect(source).toContain("return getFleetEntryStatusMeta(entry).isActive === true;");
      expect(source).toContain('return { key: "recent", label: "Recent", tone: "warning", isActive: false };');
      expect(source).toContain('return runtimeState?.key === "running";');
    });

    it("does not count synthetic task fallbacks as active without a live session", () => {
      expect(source).toContain("const isSyntheticFallback = entry?.isTaskFallback || entry?.slot?.synthetic;");
      expect(source).toContain("if (isSyntheticFallback && !entry?.session) {");
      expect(source).toContain('key: slotStatus || "task_only"');
      expect(source).toContain('label: slotStatus ? formatFleetStateLabel(slotStatus) : "Task only"');
      expect(source).toContain('isActive: false,');
    });

    it("surfaces response freshness and dedupes session identities in the fleet rail", () => {
      expect(source).toContain("function getFleetEntryResponseTimestamp(entry)");
      expect(source).toContain("function getFleetEntryActivityLabel(entry)");
      expect(source).toContain("function dedupeFleetEntries(entries = [])");
      expect(source).toContain('const responsePath = resolveFleetEntrySessionId(entry) ? "stream" : "logs";');
      expect(source).toContain('const prefix = isFleetEntryActive(entry)');
      expect(source).toContain('if (isFleetEntryActive(entry)) return `Awaiting ${responsePath} response`;');
      expect(source).toContain("const canonicalKey = getFleetEntryCanonicalKey(entry);");
      expect(source).toContain("const activityLabel = getFleetEntryActivityLabel(entry);");
      expect(source).toContain('class="fleet-slot-meta-response"');
      expect(source).toContain("Responses via");
    });

    it("uses useMemo for entries array to prevent infinite render loops", () => {
      // The entries array must be memoised with useMemo, not rebuilt inline
      expect(source).toContain("useMemo");
      // Verify useMemo is imported from preact/hooks
      expect(source).toMatch(/import\s*\{[^}]*useMemo[^}]*\}\s*from\s*["']preact\/hooks["']/);
      // The entries computation should be wrapped in useMemo
      expect(source).toMatch(/const\s+entries\s*=\s*useMemo\s*\(/);
    });

    it("useEffect dependency is a stable primitive, not the entries array itself", () => {
      // The useEffect that auto-selects a slot key must NOT depend on the
      // entries reference directly (which would fire on every render).
      // It should depend on a primitive fingerprint string.
      expect(source).toContain("entriesFingerprint");
      // The dep array must START with the fingerprint primitive (other stable
      // primitives like sessionScope may also appear in the array).
      expect(source).toMatch(/\[entriesFingerprint\b/);
      // Old pattern must be gone:
      expect(source).not.toContain("[entries, selectedSlotKey]");
    });

    it("detail tabs use exclusive ternary, not sibling && expressions", () => {
      // The old pattern had four sibling `&& (...)` blocks inside fleet-session-body.
      // The fix uses a single chained ternary so only one VNode occupies the
      // child position at any time, preventing Preact from calling insertBefore
      // on false/undefined values.
      const bodySection = source.slice(
        source.indexOf("fleet-session-body"),
      );
      // Should NOT contain multiple sibling `detailTab === "..." &&` patterns
      // at the same nesting level inside fleet-session-body
      const bodyChunk = bodySection.slice(0, 6000);
      const andPatterns = (bodyChunk.match(/detailTab\s*===\s*["'][^"']+["']\s*&&/g) || []);
      // With a chained ternary, we should only see ternary (? :) patterns, not &&
      expect(andPatterns.length).toBe(0);
      // Should use ternary pattern for tab switching
      expect(bodyChunk).toMatch(/detailTab\s*===\s*["']stream["']\s*\?/);
      expect(bodyChunk).toMatch(/detailTab\s*===\s*["']context["']\s*\?/);
      expect(bodyChunk).toMatch(/detailTab\s*===\s*["']diff["']\s*\?/);
      expect(bodyChunk).toMatch(/detailTab\s*===\s*["']logs["']\s*\?/);
    });

    it("slot card list uses stable keys, not array indices", () => {
      // Slot cards in the "Active Slots" section must use a content-based key
      // (taskId/sessionId) rather than index `i` to prevent stale DOM references
      // when slots reorder.
      // Find the key= line near fleet-agent-card
      const idx = source.indexOf("fleet-agent-card");
      // Look at ~300 chars before the class name to find the key= attribute
      const searchStart = Math.max(0, idx - 300);
      const surroundingChunk = source.slice(searchStart, idx + 50);
      // Should use a content-derived key (helper or inline expression)
      expect(surroundingChunk).toMatch(/key=\$\{(?:fleetSlotKey\(|slot\?\.taskId)/);
      // Should NOT use key=${i} as the only key
      expect(surroundingChunk).not.toMatch(/key=\$\{i\}\s*\n/);
    });


    it("renders live turn counts in agent cards and exposes the turns detail tab", () => {
      expect(source).toContain("fleet-slot-meta-turns");
      expect(source).toContain("Turns ${Number(entry.session?.turnCount || 0)}");
      expect(source).toContain('detailTab === "turns"');
      expect(source).toContain('iconText(":repeat: Turns")');
      expect(source).toContain("fleet-turn-timeline");
      expect(source).toContain("formatTurnTokens(turn)");
      expect(source).toContain("formatMsDuration(turn.durationMs || 0)");
    });

    it("derives completed turn durations from timestamps when durationMs is missing", () => {
      expect(source).toContain("function resolveTurnDurationMs(turn, pair)");
      expect(source).toContain("endedAt >= startedAt");
      expect(source).toContain("durationMs: resolveTurnDurationMs(turn, pair)");
    });

    it("demotes blocked or stale session states before slot status can mark them active", () => {
      expect(source).toContain("const lifecycleState = String(");
      expect(source).toContain('runtimeState?.key && runtimeState.key !== "running"');
      expect(source).toContain('buildFleetStatusMeta(lifecycleState, "Not live")');
      expect(source).toContain('"blocked_by_env"');
    });

    it("scopes Fleet metrics to workspace slot summaries and separates session-only activity", () => {
      expect(source).toContain("const workspaceSummary = execData?.workspaceSummary || null;");
      expect(source).toContain('loadSessions({ type: "task", workspace: "all" });');
      expect(source).toContain("const [fleetSessionsSnapshot, setFleetSessionsSnapshot] = useState([]);");
      expect(source).toContain('const sessions = await loadSessions({ type: "task", workspace: "all" });');
      expect(source).toContain("setFleetSessionsSnapshot(sessions);");
      expect(source).not.toContain("Math.max(activeSlots, activeSessionCount)");
      expect(source).toContain('label: "Dedicated Slots"');
      expect(source).toContain('label: "Session Only"');
      expect(source).toContain('label: "Active Sessions"');
      expect(source).toContain('label: "Workflows"');
      expect(source).toContain("getFleetEntryMetaLabel(entry)");
      expect(source).toContain("getFleetEntryOriginLabel(selectedEntry)");
      expect(source).toContain('return isFleetEntryActive(entry) ? "Session only" : "Session history";');
    });

    it("pins Fleet session views to task-session snapshots instead of the shared session store", () => {
      expect(source).toContain("const allSessions = fleetSessionsSnapshot;");
      expect(source).toContain("function FleetSessionsPanel({ slots, sessions = [], taskFallbackEntries = [], onOpenWorkspace, onForceStop })");
      expect(source).toContain("const allSessions = Array.isArray(sessions) ? sessions : [];");
      expect(source).toContain("sessions=${fleetSessionsSnapshot}");
    });

    it("preserves backend slot indexes when workspace-filtered slots are rendered", () => {
      expect(source).toContain("function resolveFleetSlotIndex(slot, fallbackIndex = 0)");
      expect(source).toContain("resolveFleetSlotIndex(slot, i)");
      expect(source).toContain("index: resolveFleetSlotIndex(slots[slotIndex], slotIndex)");
    });

    it("agent threads list uses stable keys, not array indices", () => {
      // The "Agent Threads" section should key on a stable identifier
      const threadsSection = source.slice(
        source.indexOf("Agent Threads"),
      );
      const statCardChunk = threadsSection.slice(0, 600);
      // Should NOT use key=${i}
      expect(statCardChunk).not.toMatch(/key=\$\{i\}/);
      // Should use a content-derived key (helper or inline expression)
      expect(statCardChunk).toMatch(/key=\$\{(?:fleetThreadKey\(|t\.taskKey)/);
    });
  });
}

for (const { relPath, source } of sessionListSourceFiles) {
  describe(`SessionList stale-data UI parity (${relPath})`, () => {
    it("renders explicit stale-state banner text", () => {
      expect(source).toContain("Session list is showing stale data.");
      expect(source).toContain("Last successful refresh:");
      expect(source).toContain("Freshness:");
      expect(source).toContain("Reason:");
      expect(source).toContain("Refresh request failed");
    });

    it("renders bounded retry status text for countdown and exhaustion", () => {
      expect(source).toContain("Automatic retries stopped after ${loadMeta.maxAttempts} attempts.");
      expect(source).toContain("Retry ${retryAttemptDisplay}/${loadMeta.maxAttempts} in ${retrySeconds}s.");
      expect(source).toContain("disabled=${manualRetryState.disabled}");
      expect(source).toContain("${manualRetryState.label || \"Retry now\"}");
      expect(source).toContain("Manual retry is disabled while automatic backoff is active.");
    });
  });
}

describe("fleet entry building logic", () => {
  it("builds stable keys from slot identifiers with fallback", () => {
    // Simulates the entry key generation logic from the component.
    // This verifies the null-safety and fallback behaviour.
    const buildKey = (slot, index) =>
      String(slot?.taskId || slot?.sessionId || `slot-${index}`);

    expect(buildKey({ taskId: "abc-123" }, 0)).toBe("abc-123");
    expect(buildKey({ sessionId: "sess-1" }, 0)).toBe("sess-1");
    expect(buildKey({ taskId: "abc", sessionId: "sess" }, 0)).toBe("abc");
    expect(buildKey({}, 2)).toBe("slot-2");
    expect(buildKey(null, 5)).toBe("slot-5");
    expect(buildKey(undefined, 7)).toBe("slot-7");
  });

  it("generates stable fingerprints across equivalent input", () => {
    const slotsA = [
      { taskId: "t1", sessionId: "s1", startedAt: "2025-01-01T00:00:00Z" },
      { taskId: "t2", sessionId: "s2", startedAt: "2025-01-02T00:00:00Z" },
    ];
    const slotsB = [
      { taskId: "t1", sessionId: "s1", startedAt: "2025-01-01T00:00:00Z" },
      { taskId: "t2", sessionId: "s2", startedAt: "2025-01-02T00:00:00Z" },
    ];

    const buildEntries = (slots) =>
      slots
        .map((slot, index) => {
          const key = String(slot?.taskId || slot?.sessionId || `slot-${index}`);
          return { key, slot, index };
        })
        .sort((a, b) => {
          const aScore = new Date(a.slot?.startedAt || 0).getTime() || 0;
          const bScore = new Date(b.slot?.startedAt || 0).getTime() || 0;
          return bScore - aScore;
        });

    const entriesA = buildEntries(slotsA);
    const entriesB = buildEntries(slotsB);

    const fpA = entriesA.map((e) => e.key).join(",");
    const fpB = entriesB.map((e) => e.key).join(",");

    expect(fpA).toBe(fpB);
    expect(fpA).toBe("t2,t1"); // sorted by startedAt desc
  });

  it("fingerprint changes when slots change", () => {
    const buildFingerprint = (slots) =>
      slots
        .map((slot, index) => ({
          key: String(slot?.taskId || slot?.sessionId || `slot-${index}`),
          slot,
          index,
        }))
        .sort((a, b) => {
          const aScore = new Date(a.slot?.startedAt || 0).getTime() || 0;
          const bScore = new Date(b.slot?.startedAt || 0).getTime() || 0;
          return bScore - aScore;
        })
        .map((e) => e.key)
        .join(",");

    const fp1 = buildFingerprint([{ taskId: "t1" }]);
    const fp2 = buildFingerprint([{ taskId: "t1" }, { taskId: "t2" }]);
    const fp3 = buildFingerprint([]);

    expect(fp1).not.toBe(fp2);
    expect(fp1).not.toBe(fp3);
    expect(fp2).not.toBe(fp3);
    expect(fp3).toBe("");
  });

  it("handles empty and null slot arrays gracefully", () => {
    const buildEntries = (slots) =>
      (slots || [])
        .map((slot, index) => ({
          key: String(slot?.taskId || slot?.sessionId || `slot-${index}`),
          slot,
          index,
        }))
        .sort((a, b) => {
          const aScore = new Date(a.slot?.startedAt || 0).getTime() || 0;
          const bScore = new Date(b.slot?.startedAt || 0).getTime() || 0;
          return bScore - aScore;
        });

    expect(buildEntries(null)).toEqual([]);
    expect(buildEntries(undefined)).toEqual([]);
    expect(buildEntries([])).toEqual([]);
    expect(buildEntries([{}])).toEqual([{ key: "slot-0", slot: {}, index: 0 }]);
  });

  it("handles rapid add/remove without duplicate keys", () => {
    // Simulates rapid slot changes where slots come and go
    const rounds = [
      [{ taskId: "a" }, { taskId: "b" }],
      [{ taskId: "b" }, { taskId: "c" }],
      [{ taskId: "c" }],
      [],
      [{ taskId: "d" }, { taskId: "e" }, { taskId: "f" }],
    ];

    for (const slots of rounds) {
      const entries = slots.map((slot, index) => ({
        key: String(slot?.taskId || slot?.sessionId || `slot-${index}`),
      }));
      const keys = entries.map((e) => e.key);
      const uniqueKeys = new Set(keys);
      expect(uniqueKeys.size).toBe(keys.length);
    }
  });
});

describe("executor workspace summary source", () => {
  const serverSource = readFileSync(resolve(process.cwd(), "server/ui-server.mjs"), "utf8");

  it("adds workspace-scoped slot summaries to /api/executor", () => {
    expect(serverSource).toContain("function buildWorkspaceExecutorSummary(execStatus, workspaceContext, workflowRunDetails = [])");
    expect(serverSource).toContain("const workspaceSummary = execStatus");
    expect(serverSource).toContain("buildWorkspaceExecutorSummary(execStatus, workspaceContext, workflowRunDetails)");
    expect(serverSource).toContain("activeSlots: Math.max(Number(execStatus?.activeSlots || 0) || 0, mergedActiveSlots),");
    expect(serverSource).toContain("slots: mergedSlots,");
    expect(serverSource).toMatch(/\{\s*\.\.\.execStatus,[\s\S]*workspaceSummary,[\s\S]*activeWorkflowRuns,[\s\S]*workflowRunDetails: workflowRunDetails\.slice\(0, 20\),/);
  });

  it("uses the actual request url when augmenting executor workflow counts", () => {
    expect(serverSource).toContain("getWorkflowRequestContext(url, { bootstrapTemplates: false })");
    expect(serverSource).not.toContain("getWorkflowRequestContext(reqUrl, { bootstrapTemplates: false }).catch(() => null);");
  });
});


describe("kanban PR linkage rendering", () => {
  for (const relPath of ["ui/components/kanban-board.js"]) {
    const source = readFileSync(resolve(process.cwd(), relPath), "utf8");
    it(`renders PR linkage source and freshness chips (${relPath})`, () => {
      expect(source).toContain("function getTaskPrLinkage(task)");
      expect(source).toContain("PR source:");
      expect(source).toContain("PR freshness:");
      expect(source).toContain("formatPrLinkageFreshnessLabel");
      expect(source).toContain("Branch: ");
      expect(source).toContain("linkedAt:");
      expect(source).toContain("updatedAt:");
    });

    it(`merges board status updates without shallow-overwriting linkage (${relPath})`, () => {
      const mergeMatches = source.match(/mergeTaskRecords\(t,\s*(?:merged|res\.data)\)/g) || [];
      expect(mergeMatches).toHaveLength(3);
      expect(source).not.toContain("matchTaskId(t.id, taskId) ? { ...t, ...res.data } : t");
    });
  }

  it("merges reload pages without duplicating PR linkage records", async () => {
    const { tasksData, tasksPage, tasksPageSize, loadTasks } = await import("../ui/modules/state.js");
    const originalFetch = globalThis.fetch;
    const responses = [
      {
        ok: true,
        json: async () => ({
          data: [{
            id: "task-1",
            title: "Task 1",
            prLinkage: [{ branchName: "feature/demo", prNumber: 42, prUrl: "https://example.test/pr/42", source: "workflow", freshness: "fresh", updatedAt: "2026-03-22T10:00:00.000Z" }],
            meta: { prLinkage: [{ branchName: "feature/demo", prNumber: 42, prUrl: "https://example.test/pr/42", source: "workflow", freshness: "fresh", updatedAt: "2026-03-22T10:00:00.000Z" }] },
          }],
          total: 1,
          totalPages: 1,
          statusCounts: {},
        }),
      },
      {
        ok: true,
        json: async () => ({
          data: [{
            id: "task-1",
            title: "Task 1 refreshed",
            meta: { prLinkage: [{ branchName: "feature/demo", prNumber: 42, prUrl: "https://example.test/pr/42", source: "auto-load", freshness: "fresh", updatedAt: "2026-03-22T10:05:00.000Z" }] },
          }],
          total: 1,
          totalPages: 1,
          statusCounts: {},
        }),
      },
    ];
    globalThis.fetch = async () => responses.shift();
    tasksPage.value = 0;
    tasksPageSize.value = 25;
    tasksData.value = [];
    try {
      await loadTasks();
      await loadTasks({ append: true });
      expect(tasksData.value).toHaveLength(1);
      expect(tasksData.value[0].meta.prLinkage).toHaveLength(1);
      expect(tasksData.value[0].prLinkage).toHaveLength(1);
      expect(tasksData.value[0].meta.prLinkage[0]).toMatchObject({ prNumber: 42, branchName: "feature/demo", source: "auto-load", freshness: "fresh", updatedAt: "2026-03-22T10:05:00.000Z" });
      expect(tasksData.value[0].branchName).toBe("feature/demo");
      expect(tasksData.value[0].prNumber).toBe(42);
      expect(tasksData.value[0].prUrl).toBe("https://example.test/pr/42");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("preserves canonical linkage fields across non-append reloads", async () => {
    const { tasksData, tasksPage, tasksPageSize, loadTasks } = await import("../ui/modules/state.js");
    const originalFetch = globalThis.fetch;
    const responses = [
      {
        ok: true,
        json: async () => ({
          data: [{
            id: "task-2",
            title: "Task 2 refreshed",
            meta: {
              prLinkage: [{
                branchName: "feature/reload-only",
                prNumber: 84,
                prUrl: "https://example.test/pr/84",
                source: "auto-load",
                freshness: "fresh",
                updatedAt: "2026-03-22T11:05:00.000Z",
              }],
            },
          }],
          total: 1,
          totalPages: 1,
          statusCounts: {},
        }),
      },
    ];
    globalThis.fetch = async () => responses.shift();
    tasksPage.value = 0;
    tasksPageSize.value = 25;
    tasksData.value = [{
      id: "task-2",
      title: "Task 2",
      branchName: "feature/reload-only",
      prNumber: 84,
      prUrl: "https://example.test/pr/84",
      prLinkage: [{
        branchName: "feature/reload-only",
        prNumber: 84,
        prUrl: "https://example.test/pr/84",
        source: "workflow",
        freshness: "fresh",
        updatedAt: "2026-03-22T11:00:00.000Z",
      }],
      meta: {
        prLinkage: [{
          branchName: "feature/reload-only",
          prNumber: 84,
          prUrl: "https://example.test/pr/84",
          source: "workflow",
          freshness: "fresh",
          updatedAt: "2026-03-22T11:00:00.000Z",
        }],
        prLinkageSource: "workflow",
        prLinkageFreshness: "fresh",
        prLinkageUpdatedAt: "2026-03-22T11:00:00.000Z",
      },
    }];
    try {
      await loadTasks();
      expect(tasksData.value).toHaveLength(1);
      expect(tasksData.value[0].prLinkage).toHaveLength(1);
      expect(tasksData.value[0].meta.prLinkage).toHaveLength(1);
      expect(tasksData.value[0].branchName).toBe("feature/reload-only");
      expect(tasksData.value[0].prNumber).toBe(84);
      expect(tasksData.value[0].prUrl).toBe("https://example.test/pr/84");
      expect(tasksData.value[0].meta.prLinkage[0]).toMatchObject({
        branchName: "feature/reload-only",
        prNumber: 84,
        prUrl: "https://example.test/pr/84",
        source: "auto-load",
        freshness: "fresh",
        updatedAt: "2026-03-22T11:05:00.000Z",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

for (const { relPath, source } of variablesSourceFiles) {
  describe(`shared numeral utility (${relPath})`, () => {
    it("defines the portal numeral token and utility class once", () => {
      expect(source).toContain("--font-variant-numeric-portal: tabular-nums slashed-zero;");
      expect(source).toMatch(/\.numeral\s*\{[\s\S]*font-variant-numeric:\s*var\(--font-variant-numeric-portal\);[\s\S]*letter-spacing:\s*0\.01em;/);
    });
  });
}

for (const { relPath, source } of sourceFiles) {
  describe(`Fleet/Agents numeric treatment (${relPath})`, () => {
    it("applies the numeral utility to capacity and metric outputs", () => {
      expect(source).toContain('<span class="numeral">${activeSlots}</span>');
      expect(source).toContain('<span class="numeral">${maxParallel}</span>');
      expect(source).toContain('<span class="numeral">${capacityPct}%</span>');
      expect(source).toContain('<div class="fleet-metric-value numeral">${metric.value}</div>');
    });
  });

  describe(`Fleet/Agents live monitor parity (${relPath})`, () => {
    it("loads agent event-bus monitoring endpoints and renders the operator cards", () => {
      expect(source).toContain('apiFetch("/api/agents/events/status")');
      expect(source).toContain('apiFetch("/api/agents/events/liveness")');
      expect(source).toContain('apiFetch("/api/agents/events/errors")');
      expect(source).toContain('apiFetch("/api/agents/events?limit=25")');
      expect(source).toContain("Agent Live Monitor");
      expect(source).toContain("Liveness Detail");
      expect(source).toContain("Error Pattern Detail");
      expect(source).toContain("Recent Agent Events");
      expect(source).toContain("Event bus started:");
      expect(source).toContain("normalizeAgentLiveness");
      expect(source).toContain("normalizeAgentErrorPatterns");
    });
  });
}

for (const relPath of ["ui/tabs/telemetry.js", "site/ui/tabs/telemetry.js"]) {
  const source = readFileSync(resolve(process.cwd(), relPath), "utf8");
  describe(`Telemetry numeric treatment (${relPath})`, () => {
    it("uses the numeral utility for aligned numeric columns", () => {
      expect(source).toContain('variant="caption" className="numeral">${formatBytes(ev.originalChars)}');
      expect(source).toContain('variant="caption" className="numeral">${formatBytes(ev.compressedChars)}');
      expect(source).toContain('variant="caption" className="numeral">${formatCount(ev.estimatedSavedTokens || 0)}');
      expect(source).toContain(
        'variant="caption" className="numeral">\n                      ${Number.isFinite(Number(ev.estimatedCostSavedUsd)) ? formatUsd(ev.estimatedCostSavedUsd) : "–"}'
      );
      expect(source).not.toContain('font-variant-numeric');
    });
  });

  if (relPath === "ui/tabs/telemetry.js") {
    describe(`Telemetry durable runtime adoption (${relPath})`, () => {
      it("renders the durable session runtime panel in the owned ui bundle", () => {
        expect(source).toContain("Durable Session Runtime");
        expect(source).toContain("SQL-backed session lineage");
        expect(source).toContain("State ledger / SQL");
        expect(source).toContain("Top Durable Tools");
      });
    });
  }
}

for (const { relPath, source } of telemetrySourceFiles) {
  describe(`Telemetry compact count formatting (${relPath})`, () => {
    it("supports K/M/B/T abbreviations for large counts", () => {
      expect(source).toContain("1_000_000_000_000");
      expect(source).toContain("1_000_000_000");
      expect(source).toContain("1_000_000");
      expect(source).toContain("1_000");
      expect(source).toContain('"T"');
      expect(source).toContain('"B"');
      expect(source).toContain('"M"');
      expect(source).toContain('"K"');
    });
  });
}

for (const { relPath, source } of dashboardSourceFiles) {
  describe(`Dashboard Git Graph rendering (${relPath})`, () => {
    it("renders the Git Graph card without gating it on a preloaded commit list", () => {
      expect(source).toContain('<${CommitGraph} maxCommits=${40} compact=${true} />');
      expect(source).not.toContain('${recentCommits.length > 0 && html`');
    });
  });

  it(`surfaces harness attention with deep links into the Agents tab (${relPath})`, () => {
    expect(source).toContain('apiFetch("/api/harness/runs?limit=8", { _silent: true })');
    expect(source).toContain("const [harnessRuns, setHarnessRuns] = useState([]);");
    expect(source).toContain("const harnessActiveCount = harnessRuns.filter");
    expect(source).toContain("const harnessVisibleRuns = (harnessAttentionRuns.length ? harnessAttentionRuns : harnessRuns).slice(0, 4);");
    expect(source).toContain("Harness Attention");
    expect(source).toContain('harnessSource: "dashboard attention"');
    expect(source).toContain('navigateTo("agents", {');
    expect(source).toContain("No harness runs need attention");
  });

  it(`keeps dashboard overview controls keyboard-accessible (${relPath})`, () => {
    expect(source).toContain('role="banner" aria-label="Dashboard status header"');
    expect(source).toContain('aria-label="Dashboard overview"');
    expect(source).toContain('aria-label="Overview metrics"');
    expect(source).toContain('(e.key === "Enter" || e.key === " ")');
    expect(source).toContain('aria-label="Quick actions"');
  });

  if (relPath === "ui/tabs/dashboard.js") {
    describe(`Dashboard durable runtime adoption (${relPath})`, () => {
      it("renders the durable runtime status summary in the owned ui bundle", () => {
        expect(source).toContain("Durable Runtime");
        expect(source).toContain("Session lineage and context pressure");
        expect(source).toContain("State ledger / SQL");
      });
    });
  }
}

for (const relPath of ["ui/tabs/tasks.js", "site/ui/tabs/tasks.js"]) {
  const source = readFileSync(resolve(process.cwd(), relPath), "utf8");
  describe(`Tasks numeric treatment (${relPath})`, () => {
    it("uses the numeral utility for snapshot counters and pager values", () => {
      expect(source).toContain('<strong class="snapshot-val numeral">${m.value}</strong>');
      expect(source).toContain('${option.label} · <span class="numeral">${option.count}</span>');
      expect(source).toContain('Sprint nodes: <span class="numeral">${dagSprintGraphView.nodes.length}</span>');
      expect(source).toContain('Global nodes: <span class="numeral">${dagGlobalGraphView.nodes.length}</span>');
      expect(source).toContain('Epic nodes: <span class="numeral">${dagEpicGraphView.nodes.length}</span>');
      expect(
        source.includes('<span class="numeral">${visible.length}</span> shown')
        || source.includes('<span class="numeral">${isList ? listVisibleCount : visible.length}</span> shown')
        || source.includes('<span class="numeral">${visibleShownCount}</span> shown'),
      ).toBe(true);
      expect(source).toContain('Page <span class="numeral">${page + 1}</span> / <span class="numeral">${totalPages}</span>');
    });
  });
}

for (const relPath of ["ui/tabs/agents.js", "site/ui/tabs/agents.js"]) {
  const source = readFileSync(resolve(process.cwd(), relPath), "utf8");
  describe(`Agents detail numeric treatment (${relPath})`, () => {
    it("uses the numeral utility for live slot counters and durations", () => {
      expect(source).toContain('<span class="numeral">${activeSlots}</span> active · <span class="numeral">${freeSlots}</span> free');
      expect(source).toContain('Attempt <span class="numeral">${slot.attempt || 1}</span>');
      expect(source).toContain('<div class="agent-duration numeral">${formatDuration(slot.startedAt)}</div>');
      expect(source).toContain('Completed: <span class="numeral">${slot.completedCount}</span>');
    });
  });
}

describe("TUI agents harness monitor", () => {
  it("renders harness detail, approvals, and nudge controls backed by harness APIs", () => {
    expect(tuiAgentsSource).toContain('fetchJson(');
    expect(tuiAgentsSource).toContain('buildHarnessSurfacePath("agents", { limit: 25 })');
    expect(tuiAgentsSource).toContain('fetchJson(resolvedHost, resolvedPort, buildHarnessRunPath(runId), undefined, wsBridge)');
    expect(tuiAgentsSource).toContain('fetchJson(resolvedHost, resolvedPort, buildHarnessRunPath(runId, "events", { limit: 40, direction: "desc" }), undefined, wsBridge)');
    expect(tuiAgentsSource).toContain('fetchJson(resolvedHost, resolvedPort, buildHarnessRunPath(runId, "approval"), undefined, wsBridge)');
    expect(tuiAgentsSource).toContain('buildHarnessApprovalPath(requestId, "resolve")');
    expect(tuiAgentsSource).toContain('buildHarnessRunPath(runId, "nudge")');
    expect(tuiAgentsSource).toContain("function HarnessDetail(");
    expect(tuiAgentsSource).toContain("function AgentMonitorDetail(");
    expect(tuiAgentsSource).toContain("Agent Live Monitor (");
    expect(tuiAgentsSource).toContain("Agent Live Monitor Detail");
    expect(tuiAgentsSource).toContain("Liveness Detail");
    expect(tuiAgentsSource).toContain("Error Pattern Detail");
    expect(tuiAgentsSource).toContain("Recent Agent Events");
    expect(tuiAgentsSource).toContain("[M detail]");
    expect(tuiAgentsSource).toContain("[M] refresh monitor  [Esc] close");
    expect(tuiAgentsSource).toContain("function agentEventToLogLine(");
    expect(tuiAgentsSource).toContain("Error Patterns");
    expect(tuiAgentsSource).toContain("Harness monitor (");
    expect(tuiAgentsSource).toContain("[H detail · [ / ] select]");
    expect(tuiAgentsSource).toContain("Approval State");
    expect(tuiAgentsSource).toContain('const [harnessNudgeMode, setHarnessNudgeMode] = React.useState(false);');
    expect(tuiAgentsSource).toContain('if (harnessDetailView) {');
    expect(tuiAgentsSource).toContain('if (agentMonitorDetailOpen) {');
    expect(tuiAgentsSource).toContain('if ((input === "a" || input === "A")');
    expect(tuiAgentsSource).toContain('if ((input === "x" || input === "X")');
    expect(tuiAgentsSource).toContain('if ((input === "n" || input === "N")');
    expect(tuiAgentsSource).toContain('if (input === "h" || input === "H") {');
    expect(tuiAgentsSource).toContain('if (input === "m" || input === "M") {');
    expect(tuiAgentsSource).toContain('if (input === "[") {');
    expect(tuiAgentsSource).toContain('if (input === "]") {');
    const helpSource = readFileSync(resolve(process.cwd(), "ui/tui/HelpScreen.js"), "utf8");
    expect(helpSource).toContain('["M", "Open agent live monitor detail"]');
    expect(helpSource).toContain("if (context.agentMonitorDetailOpen) {");
  });
});

describe("TUI workflows operator inbox", () => {
  it("renders merged workflow and harness approvals with inbox actions", () => {
    const workflowsTuiSource = readFileSync(resolve(process.cwd(), "tui/screens/workflows.mjs"), "utf8");
    const helpSource = readFileSync(resolve(process.cwd(), "ui/tui/HelpScreen.js"), "utf8");
    expect(workflowsTuiSource).toContain('requestJson("/api/harness/surface?view=workflows&limit=25")');
    expect(workflowsTuiSource).toContain("Operator Inbox (");
    expect(workflowsTuiSource).toContain("Pending workflow approvals plus waiting or stalled harness runs");
    expect(workflowsTuiSource).toContain('"/api/workflows/approvals/${encodeURIComponent(item.requestId)}/resolve"');
    expect(workflowsTuiSource).toContain('"/api/harness/approvals/${encodeURIComponent(item.requestId)}/resolve"');
    expect(workflowsTuiSource).toContain("[A]pprove  [X] deny  [Esc] close");
    expect(helpSource).toContain('["A / X", "Approve or deny selected request"]');
    expect(helpSource).toContain('if (screen === "workflows") {');
  });

  it("renders workflow run supervision with detail, cancel, retry, and run approval actions", () => {
    const workflowsTuiSource = readFileSync(resolve(process.cwd(), "tui/screens/workflows.mjs"), "utf8");
    const helpSource = readFileSync(resolve(process.cwd(), "ui/tui/HelpScreen.js"), "utf8");
    expect(workflowsTuiSource).toContain('requestJson("/api/workflows/runs?limit=8")');
    expect(workflowsTuiSource).toContain('requestJson(`/api/workflows/runs/${encodeURIComponent(runId)}`)');
    expect(workflowsTuiSource).toContain('requestJson(`/api/workflows/runs/${encodeURIComponent(runId)}/evaluate`)');
    expect(workflowsTuiSource).toContain('requestJson(`/api/workflows/runs/${encodeURIComponent(runId)}/forensics`)');
    expect(workflowsTuiSource).toContain('requestJson(`/api/workflows/runs/${encodeURIComponent(runId)}/snapshot`, {');
    expect(workflowsTuiSource).toContain('requestJson(`/api/workflows/runs/${encodeURIComponent(runId)}/snapshots`)');
    expect(workflowsTuiSource).toContain('requestJson(`/api/workflows/runs/${encodeURIComponent(runId)}/restore`, {');
    expect(workflowsTuiSource).toContain('requestJson(`/api/workflows/runs/${encodeURIComponent(runId)}/remediate`, {');
    expect(workflowsTuiSource).toContain('requestJson(`/api/workflows/runs/${encodeURIComponent(runId)}/cancel`, {');
    expect(workflowsTuiSource).toContain('requestJson(`/api/workflows/runs/${encodeURIComponent(runId)}/retry`, {');
    expect(workflowsTuiSource).toContain('requestJson(`/api/workflows/runs/${encodeURIComponent(runId)}/approval`, {');
    expect(workflowsTuiSource).toContain("Recent Workflow Runs (");
    expect(workflowsTuiSource).toContain("[G detail · [ / ] select]");
    expect(workflowsTuiSource).toContain("Workflow Run Detail");
    expect(workflowsTuiSource).toContain("Run Evaluation");
    expect(workflowsTuiSource).toContain("Run Forensics");
    expect(workflowsTuiSource).toContain("Run Snapshots");
    expect(workflowsTuiSource).toContain("[F] forensics  [V] evaluate  [P] snapshot  [O] restore  [M] remediate  [C]ancel  [T] retry  [A]pprove  [X] deny  [Esc] close");
    expect(workflowsTuiSource).toContain('if (input === "g" || input === "G") {');
    expect(workflowsTuiSource).toContain('if (input === "f" || input === "F") {');
    expect(workflowsTuiSource).toContain('if (input === "v" || input === "V") {');
    expect(workflowsTuiSource).toContain('if (input === "p" || input === "P") {');
    expect(workflowsTuiSource).toContain('if (input === "o" || input === "O") {');
    expect(workflowsTuiSource).toContain('if (input === "m" || input === "M") {');
    expect(workflowsTuiSource).toContain('if (input === "[") {');
    expect(workflowsTuiSource).toContain('if (input === "]") {');
    expect(helpSource).toContain('["G", "Open selected workflow run"]');
    expect(helpSource).toContain('["[ / ]", "Move workflow run selection"]');
    expect(helpSource).toContain('["C / T", "Cancel or retry workflow run"]');
    expect(helpSource).toContain('["F / V", "Refresh forensics or evaluation"]');
    expect(helpSource).toContain('["P / O / M", "Snapshot, restore, or remediate"]');
    expect(helpSource).toContain("if (context.workflowRunDetailOpen) {");
  });
});

describe("Web workflows operator surfaces", () => {
  for (const relativePath of [
    "ui/tabs/workflows.js",
    "site/ui/tabs/workflows.js",
  ]) {
    it(`renders operator inbox and diagnostics contracts in ${relativePath}`, () => {
      const source = readFileSync(resolve(process.cwd(), relativePath), "utf8");
      expect(source).toContain('/api/harness/runs?limit=8');
      expect(source).toContain("Operator Inbox");
      expect(source).toContain("Pending workflow approvals plus waiting or stalled harness runs");
      expect(source).toContain('/api/workflows/runs/${encodeURIComponent(safeRunId)}/evaluate');
      expect(source).toContain('/api/workflows/runs/${encodeURIComponent(safeRunId)}/forensics');
      expect(source).toContain('/api/workflows/runs/${encodeURIComponent(safeRunId)}/snapshot');
      expect(source).toContain('/api/workflows/runs/${encodeURIComponent(safeRunId)}/snapshots');
      expect(source).toContain('/api/workflows/runs/${encodeURIComponent(safeRunId)}/restore');
      expect(source).toContain('/api/workflows/runs/${encodeURIComponent(safeRunId)}/remediate');
      expect(source).toContain("Run Evaluation");
      expect(source).toContain("Run Forensics");
      expect(source).toContain("Run Snapshots");
      expect(source).toContain("Refresh Diagnostics");
      expect(source).toContain("Capture Snapshot");
      expect(source).toContain("Restore Snapshot");
      expect(source).toContain("Remediate Run");
    });
  }
});

describe("Telegram harness surface routing", () => {
  it("routes fleet, telemetry, and logs through the shared UI control plane client when available", () => {
    const telegramSource = readFileSync(resolve(process.cwd(), "telegram/telegram-bot.mjs"), "utf8");
    const harnessClientSource = readFileSync(
      resolve(process.cwd(), "telegram/harness-api-client.mjs"),
      "utf8",
    );
    expect(harnessClientSource).toContain("async getSurface(view = \"all\", limit = 25)");
    expect(harnessClientSource).toContain('return request(`/api/harness/surface?${query.toString()}`);');
    expect(harnessClientSource).toContain("async getLogs(lines = 30)");
    expect(harnessClientSource).toContain('return request(`/api/logs?lines=${count}`);');
    expect(telegramSource).toContain('harnessApi.getSurface("agents", 12)');
    expect(telegramSource).toContain('harnessApi.getSurface("telemetry", 12)');
    expect(telegramSource).toContain("harnessApi.getLogs(numLines)");
  });
});
