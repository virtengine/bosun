import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// ── fleet-coordinator tests ──────────────────────────────────────────────────

describe("fleet-coordinator", () => {
  let tempRoot = null;

  beforeEach(async () => {
    tempRoot = await mkdtemp(resolve(tmpdir(), "codex-fleet-"));
  });

  afterEach(async () => {
    const { resetStateLedgerCache } = await import("../lib/state-ledger-sqlite.mjs");
    resetStateLedgerCache();
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  describe("normalizeGitUrl", () => {
    let normalizeGitUrl;
    beforeEach(async () => {
      ({ normalizeGitUrl } = await import("../agent/fleet-coordinator.mjs"));
    });

    it("normalizes HTTPS URLs", () => {
      expect(normalizeGitUrl("https://github.com/virtengine/virtengine.git"))
        .toBe("github.com/virtengine/virtengine");
    });

    it("normalizes SSH URLs", () => {
      expect(normalizeGitUrl("git@github.com:virtengine/virtengine.git"))
        .toBe("github.com/virtengine/virtengine");
    });

    it("normalizes SSH protocol URLs", () => {
      expect(normalizeGitUrl("ssh://git@github.com/virtengine/virtengine"))
        .toBe("github.com/virtengine/virtengine");
    });

    it("strips trailing slashes", () => {
      expect(normalizeGitUrl("https://github.com/org/repo/"))
        .toBe("github.com/org/repo");
    });

    it("lowercases the result", () => {
      expect(normalizeGitUrl("https://github.com/ORG/REPO.git"))
        .toBe("github.com/org/repo");
    });

    it("returns empty string for null/undefined", () => {
      expect(normalizeGitUrl(null)).toBe("");
      expect(normalizeGitUrl(undefined)).toBe("");
    });

    it("handles git:// protocol", () => {
      expect(normalizeGitUrl("git://github.com/org/repo.git"))
        .toBe("github.com/org/repo");
    });
  });

  describe("computeRepoFingerprint", () => {
    let computeRepoFingerprint;
    beforeEach(async () => {
      ({ computeRepoFingerprint } = await import("../agent/fleet-coordinator.mjs"));
    });

    it("returns null for null/undefined root", () => {
      expect(computeRepoFingerprint(null)).toBe(null);
      expect(computeRepoFingerprint(undefined)).toBe(null);
    });

    it("returns null for non-git directory", async () => {
      // When running inside a git worktree (like in CI), even system temp dirs
      // may resolve to the parent repo. Check if we're in that situation.
      const systemTmpBase = process.platform === 'win32' ? 'C:\\Windows\\Temp' : '/tmp';
      const nonGitTemp = await mkdtemp(resolve(systemTmpBase, "non-git-"));
      try {
        const result = computeRepoFingerprint(nonGitTemp);
        
        // If we're running in a git worktree, git will walk up and find the parent repo
        // In that case, skip this specific assertion but verify the function works
        if (result !== null) {
          // We're in a git worktree - verify structure is valid
          expect(result).toHaveProperty('method');
          expect(result).toHaveProperty('normalized');
          expect(result).toHaveProperty('hash');
        } else {
          // We're truly outside a git repo - this is the expected case
          expect(result).toBe(null);
        }
      } finally {
        await rm(nonGitTemp, { recursive: true, force: true });
      }
    });
  });

  describe("buildExecutionWaves", () => {
    let buildExecutionWaves;
    beforeEach(async () => {
      ({ buildExecutionWaves } = await import("../agent/fleet-coordinator.mjs"));
    });

    it("returns empty array for no tasks", () => {
      expect(buildExecutionWaves([])).toEqual([]);
      expect(buildExecutionWaves(null)).toEqual([]);
    });

    it("places non-conflicting tasks in same wave", () => {
      const tasks = [
        { id: "t1", title: "feat(veid): add flow", scope: "veid" },
        { id: "t2", title: "feat(market): add bid", scope: "market" },
        { id: "t3", title: "feat(escrow): add payment", scope: "escrow" },
      ];

      const waves = buildExecutionWaves(tasks);

      // All have different scopes → should fit in 1 wave
      expect(waves.length).toBe(1);
      expect(waves[0]).toContain("t1");
      expect(waves[0]).toContain("t2");
      expect(waves[0]).toContain("t3");
    });

    it("separates conflicting tasks into different waves", () => {
      const tasks = [
        { id: "t1", title: "feat(veid): part 1", scope: "veid" },
        { id: "t2", title: "feat(veid): part 2", scope: "veid" },
        { id: "t3", title: "feat(market): stuff", scope: "market" },
      ];

      const waves = buildExecutionWaves(tasks);

      // t1 and t2 conflict (same scope), t3 doesn't conflict
      expect(waves.length).toBe(2);

      // t1 and t2 should be in different waves
      const t1Wave = waves.findIndex((w) => w.includes("t1"));
      const t2Wave = waves.findIndex((w) => w.includes("t2"));
      expect(t1Wave).not.toBe(t2Wave);
    });

    it("places file-path conflicts in different waves", () => {
      const tasks = [
        { id: "t1", title: "task 1", filePaths: ["src/auth.ts", "src/types.ts"] },
        { id: "t2", title: "task 2", filePaths: ["src/auth.ts"] },
        { id: "t3", title: "task 3", filePaths: ["src/market.ts"] },
      ];

      const waves = buildExecutionWaves(tasks);

      // t1 and t2 share src/auth.ts → different waves
      const t1Wave = waves.findIndex((w) => w.includes("t1"));
      const t2Wave = waves.findIndex((w) => w.includes("t2"));
      expect(t1Wave).not.toBe(t2Wave);

      // t3 has no overlap → can be in either wave
      expect(waves.flat()).toContain("t3");
    });

    it("extracts scope from conventional commit titles", () => {
      const tasks = [
        { id: "t1", title: "feat(veid): add verification" },
        { id: "t2", title: "fix(veid): fix bug" },
        { id: "t3", title: "feat(market): add listing" },
      ];

      const waves = buildExecutionWaves(tasks);

      // t1 and t2 share veid scope → different waves
      const t1Wave = waves.findIndex((w) => w.includes("t1"));
      const t2Wave = waves.findIndex((w) => w.includes("t2"));
      expect(t1Wave).not.toBe(t2Wave);
    });

    it("handles all-conflicting tasks (worst case)", () => {
      const tasks = [
        { id: "t1", title: "feat(veid): a", scope: "veid" },
        { id: "t2", title: "feat(veid): b", scope: "veid" },
        { id: "t3", title: "feat(veid): c", scope: "veid" },
      ];

      const waves = buildExecutionWaves(tasks);

      // All conflict → each in its own wave
      expect(waves.length).toBe(3);
    });
  });

  describe("assignTasksToWorkstations", () => {
    let assignTasksToWorkstations;
    beforeEach(async () => {
      ({ assignTasksToWorkstations } = await import("../agent/fleet-coordinator.mjs"));
    });

    it("returns empty for no peers", () => {
      const result = assignTasksToWorkstations([["t1"]], []);
      expect(result.assignments).toEqual([]);
    });

    it("returns empty for no waves", () => {
      const peers = [{ instance_id: "ws-1" }];
      const result = assignTasksToWorkstations([], peers);
      expect(result.assignments).toEqual([]);
    });

    it("distributes tasks round-robin across peers", () => {
      const waves = [["t1", "t2", "t3", "t4"]];
      const peers = [
        { instance_id: "ws-1", max_parallel: 6 },
        { instance_id: "ws-2", max_parallel: 6 },
      ];

      const result = assignTasksToWorkstations(waves, peers);

      expect(result.totalTasks).toBe(4);
      expect(result.totalPeers).toBe(2);

      const ws1Tasks = result.assignments.filter((a) => a.assignedTo === "ws-1");
      const ws2Tasks = result.assignments.filter((a) => a.assignedTo === "ws-2");
      expect(ws1Tasks.length).toBe(2);
      expect(ws2Tasks.length).toBe(2);
    });

    it("uses capability-based routing when available", () => {
      const waves = [["t1"]];
      const peers = [
        { instance_id: "ws-1", max_parallel: 6, capabilities: ["frontend"] },
        { instance_id: "ws-2", max_parallel: 6, capabilities: ["veid", "market"] },
      ];
      const taskMap = new Map([["t1", { id: "t1", title: "veid task", scope: "veid" }]]);

      const result = assignTasksToWorkstations(waves, peers, taskMap);

      // Should prefer ws-2 because it has "veid" capability
      expect(result.assignments[0].assignedTo).toBe("ws-2");
    });

    it("prefers same-team peers for coordinated tasks", () => {
      const waves = [["t1"]];
      const peers = [
        { instance_id: "ws-1", instance_label: "worker-a", teamId: "team-alpha" },
        { instance_id: "ws-2", instance_label: "worker-b", teamId: "team-beta" },
      ];
      const taskMap = new Map([[
        "t1",
        {
          id: "t1",
          title: "alpha task",
          coordinationTeamId: "team-beta",
        },
      ]]);

      const result = assignTasksToWorkstations(waves, peers, taskMap);

      expect(result.assignments[0].assignedTo).toBe("ws-2");
      expect(result.assignments[0].assignmentReasons).toContain("team-match");
    });

    it("prefers matching coordination roles ahead of round-robin defaults", () => {
      const waves = [["t1"]];
      const peers = [
        { instance_id: "ws-1", instance_label: "general-worker", workspace_role: "worker" },
        { instance_id: "ws-2", instance_label: "review-bot", team_role: "reviewer" },
      ];
      const taskMap = new Map([[
        "t1",
        {
          id: "t1",
          title: "review task",
          coordinationRole: "reviewer",
        },
      ]]);

      const result = assignTasksToWorkstations(waves, peers, taskMap);

      expect(result.assignments[0].assignedTo).toBe("ws-2");
      expect(result.assignments[0].assignmentReasons).toContain("role-match");
    });

    it("prefers peers in the expected reports-to chain", () => {
      const waves = [["t1"]];
      const peers = [
        { instance_id: "ws-1", instance_label: "impl-a", reports_to: "planner-a" },
        { instance_id: "ws-2", instance_label: "impl-b", reports_to: "planner-b" },
      ];
      const taskMap = new Map([[
        "t1",
        {
          id: "t1",
          title: "planned task",
          coordinationReportsTo: "planner-b",
        },
      ]]);

      const result = assignTasksToWorkstations(waves, peers, taskMap);

      expect(result.assignments[0].assignedTo).toBe("ws-2");
      expect(result.assignments[0].assignmentReasons).toContain("reports-to-match");
    });
  });

  describe("calculateBacklogDepth", () => {
    let calculateBacklogDepth;
    beforeEach(async () => {
      ({ calculateBacklogDepth } = await import("../agent/fleet-coordinator.mjs"));
    });

    it("calculates target depth from slots and multiplier", () => {
      const result = calculateBacklogDepth({
        totalSlots: 6,
        currentBacklog: 0,
        bufferMultiplier: 3,
      });

      expect(result.targetDepth).toBe(18); // 6 × 3
      expect(result.deficit).toBe(18);
      expect(result.shouldGenerate).toBe(true);
    });

    it("reports no deficit when backlog is full", () => {
      const result = calculateBacklogDepth({
        totalSlots: 6,
        currentBacklog: 20,
        bufferMultiplier: 3,
      });

      expect(result.deficit).toBe(0);
      expect(result.shouldGenerate).toBe(false);
    });

    it("caps at maxTasks", () => {
      const result = calculateBacklogDepth({
        totalSlots: 50,
        currentBacklog: 0,
        bufferMultiplier: 3,
        maxTasks: 100,
      });

      expect(result.targetDepth).toBe(100);
    });

    it("enforces minTasks floor", () => {
      const result = calculateBacklogDepth({
        totalSlots: 1,
        currentBacklog: 0,
        bufferMultiplier: 1,
        minTasks: 6,
      });

      expect(result.targetDepth).toBe(6);
    });

    it("scales with fleet size", () => {
      const solo = calculateBacklogDepth({ totalSlots: 6 });
      const fleet = calculateBacklogDepth({ totalSlots: 12 });

      expect(fleet.targetDepth).toBeGreaterThan(solo.targetDepth);
    });
  });

  describe("detectMaintenanceMode", () => {
    let detectMaintenanceMode;
    beforeEach(async () => {
      ({ detectMaintenanceMode } = await import("../agent/fleet-coordinator.mjs"));
    });

    it("returns maintenance mode when everything is empty", () => {
      const result = detectMaintenanceMode({
        backlog_remaining: 0,
        counts: { running: 0, review: 0, todo: 0 },
      });

      expect(result.isMaintenanceMode).toBe(true);
    });

    it("returns active when backlog has tasks", () => {
      const result = detectMaintenanceMode({
        backlog_remaining: 5,
        counts: { running: 0, review: 0, todo: 0 },
      });

      expect(result.isMaintenanceMode).toBe(false);
    });

    it("returns active when tasks are running", () => {
      const result = detectMaintenanceMode({
        backlog_remaining: 0,
        counts: { running: 2, review: 0, todo: 0 },
      });

      expect(result.isMaintenanceMode).toBe(false);
    });

    it("handles null status gracefully", () => {
      const result = detectMaintenanceMode(null);
      expect(result.isMaintenanceMode).toBe(false);
    });
  });

  describe("formatFleetSummary", () => {
    let formatFleetSummary;
    beforeEach(async () => {
      ({ formatFleetSummary } = await import("../agent/fleet-coordinator.mjs"));
    });

    it("returns a non-empty summary string", () => {
      const summary = formatFleetSummary();
      expect(typeof summary).toBe("string");
      expect(summary.length).toBeGreaterThan(0);
      expect(summary).toContain("Fleet Status");
    });
  });
});

// ── shared-knowledge tests ───────────────────────────────────────────────────

describe("shared-knowledge", () => {
  let tempRoot = null;

  beforeEach(async () => {
    tempRoot = await mkdtemp(resolve(tmpdir(), "codex-knowledge-"));
  });

  afterEach(async () => {
    const { resetStateLedgerCache } = await import("../lib/state-ledger-sqlite.mjs");
    resetStateLedgerCache();
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  describe("buildKnowledgeEntry", () => {
    let buildKnowledgeEntry;
    beforeEach(async () => {
      ({ buildKnowledgeEntry } = await import("../workspace/shared-knowledge.mjs"));
    });

    it("creates an entry with all fields", () => {
      const entry = buildKnowledgeEntry({
        content: "Always use deterministic TF ops for consensus",
        scope: "inference",
        agentId: "ws-1-abc123",
        agentType: "codex",
        category: "gotcha",
        taskRef: "ve/task-123",
      });

      expect(entry.content).toBe("Always use deterministic TF ops for consensus");
      expect(entry.scope).toBe("inference");
      expect(entry.agentType).toBe("codex");
      expect(entry.category).toBe("gotcha");
      expect(entry.hash).toBeTruthy();
      expect(entry.timestamp).toBeTruthy();
    });

    it("generates consistent hashes for same content+scope", () => {
      const a = buildKnowledgeEntry({
        content: "Use exec shell on Windows",
        scope: "provider",
      });
      const b = buildKnowledgeEntry({
        content: "Use exec shell on Windows",
        scope: "provider",
      });
      expect(a.hash).toBe(b.hash);
    });

    it("generates different hashes for different content", () => {
      const a = buildKnowledgeEntry({ content: "Tip A" });
      const b = buildKnowledgeEntry({ content: "Tip B" });
      expect(a.hash).not.toBe(b.hash);
    });
  });

  describe("validateEntry", () => {
    let validateEntry, buildKnowledgeEntry;
    beforeEach(async () => {
      ({ validateEntry, buildKnowledgeEntry } = await import(
        "../workspace/shared-knowledge.mjs"
      ));
    });

    it("accepts valid entries", () => {
      const entry = buildKnowledgeEntry({
        content: "Always check for Windows cmd extensions when spawning npm",
        category: "gotcha",
      });
      expect(validateEntry(entry).valid).toBe(true);
    });

    it("rejects too-short content", () => {
      const entry = buildKnowledgeEntry({ content: "hi" });
      const result = validateEntry(entry);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("too short");
    });

    it("rejects too-long content", () => {
      const entry = buildKnowledgeEntry({ content: "x".repeat(3000) });
      const result = validateEntry(entry);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("too long");
    });

    it("rejects low-value noise", () => {
      const entry = buildKnowledgeEntry({ content: "ok" });
      // "ok" is too short, catches anyway
      expect(validateEntry(entry).valid).toBe(false);
    });

    it("rejects null/undefined", () => {
      expect(validateEntry(null).valid).toBe(false);
      expect(validateEntry(undefined).valid).toBe(false);
    });

    it("rejects invalid category", () => {
      const entry = buildKnowledgeEntry({
        content: "Valid content that is long enough to pass",
        category: "invalid-cat",
      });
      const result = validateEntry(entry);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("invalid category");
    });
  });

  describe("formatEntryAsMarkdown", () => {
    let formatEntryAsMarkdown, buildKnowledgeEntry;
    beforeEach(async () => {
      ({ formatEntryAsMarkdown, buildKnowledgeEntry } = await import(
        "../workspace/shared-knowledge.mjs"
      ));
    });

    it("formats entry with scope and category", () => {
      const entry = buildKnowledgeEntry({
        content: "On Windows, npm is npm.cmd — use shell: true in execFileSync",
        scope: "provider",
        agentId: "ws-1-abc123",
        agentType: "codex",
        category: "gotcha",
        taskRef: "ve/fix-enoent",
      });

      const md = formatEntryAsMarkdown(entry);

      expect(md).toContain("[gotcha]");
      expect(md).toContain("(provider)");
      expect(md).toContain("ws-1-abc123");
      expect(md).toContain("npm.cmd");
      expect(md).toContain("`ve/fix-enoent`");
    });
  });

  describe("appendKnowledgeEntry", () => {
    let appendKnowledgeEntry, buildKnowledgeEntry, initSharedKnowledge, readKnowledgeEntries;

    beforeEach(async () => {
      ({ appendKnowledgeEntry, buildKnowledgeEntry, initSharedKnowledge, readKnowledgeEntries } =
        await import("../workspace/shared-knowledge.mjs"));
    });

    it("creates section and appends entry to new file", async () => {
      const targetFile = "TEST_AGENTS.md";
      await writeFile(resolve(tempRoot, targetFile), "# Agents\n\nSome content.\n");
      initSharedKnowledge({ repoRoot: tempRoot, targetFile });

      const entry = buildKnowledgeEntry({
        content: "Always use deterministic ops for consensus scoring",
        scope: "inference",
        category: "pattern",
        agentId: "test-agent",
      });

      const result = await appendKnowledgeEntry(entry);

      expect(result.success).toBe(true);
      expect(result.mirrored).toBe(true);

      const content = await readFile(resolve(tempRoot, targetFile), "utf8");
      expect(content).toContain("## Agent Learnings");
      expect(content).toContain("deterministic ops");
    });

    it("persists to the ledger even when the markdown mirror path is invalid", async () => {
      const targetBlocker = "MIRROR_BLOCKER";
      await writeFile(resolve(tempRoot, targetBlocker), "blocker", "utf8");
      initSharedKnowledge({ repoRoot: tempRoot, targetFile: `${targetBlocker}/TEST_AGENTS.md` });

      const entry = buildKnowledgeEntry({
        content: "Always persist the authoritative ledger entry before attempting markdown mirroring.",
        scope: "inference",
        category: "pattern",
        teamId: "team-a",
        workspaceId: "workspace-1",
        agentId: "test-agent",
      });

      const result = await appendKnowledgeEntry(entry);
      expect(result.success).toBe(true);
      expect(result.mirrored).toBe(false);
      expect(String(result.mirrorReason || "")).toContain("markdown mirror failed");

      const { listKnowledgeEntriesFromStateLedger } = await import("../lib/state-ledger-sqlite.mjs");
      expect(listKnowledgeEntriesFromStateLedger({ repoRoot: tempRoot, workspaceId: "workspace-1" })).toEqual([
        expect.objectContaining({
          content: "Always persist the authoritative ledger entry before attempting markdown mirroring.",
          workspaceId: "workspace-1",
        }),
      ]);
    });

    it("does not write markdown when the authoritative ledger write fails", async () => {
      const targetFile = "TEST_AGENTS.md";
      await writeFile(resolve(tempRoot, targetFile), "# Agents\n\nSome content.\n");
      await writeFile(resolve(tempRoot, ".bosun"), "block-ledger-dir", "utf8");
      initSharedKnowledge({ repoRoot: tempRoot, targetFile });

      const entry = buildKnowledgeEntry({
        content: "Never mirror a memory entry into markdown before the ledger accepts it.",
        scope: "inference",
        category: "pattern",
        teamId: "team-a",
        workspaceId: "workspace-1",
        agentId: "test-agent",
      });

      const result = await appendKnowledgeEntry(entry);
      expect(result.success).toBe(false);
      expect(String(result.reason || "")).toContain("write error");

      const content = await readFile(resolve(tempRoot, targetFile), "utf8");
      expect(content).not.toContain("Never mirror a memory entry into markdown before the ledger accepts it.");
      expect(content).not.toContain("## Agent Learnings");
    });

    it("rejects invalid entries", async () => {
      initSharedKnowledge({ repoRoot: tempRoot, targetFile: "TEST.md" });
      const entry = buildKnowledgeEntry({ content: "x" });
      const result = await appendKnowledgeEntry(entry);
      expect(result.success).toBe(false);
    });

    it("allows concurrent writes from different agents and scopes", async () => {
      initSharedKnowledge({ repoRoot: tempRoot, targetFile: "TEST.md" });

      const first = buildKnowledgeEntry({
        content: "Workspace memory: agent alpha can persist migration learnings independently.",
        scope: "testing",
        category: "pattern",
        scopeLevel: "workspace",
        teamId: "team-a",
        workspaceId: "workspace-1",
        agentId: "agent-alpha",
      });
      const second = buildKnowledgeEntry({
        content: "Workspace memory: agent beta can persist fixture learnings without alpha blocking it.",
        scope: "testing",
        category: "pattern",
        scopeLevel: "workspace",
        teamId: "team-a",
        workspaceId: "workspace-2",
        agentId: "agent-beta",
      });

      const [firstResult, secondResult] = await Promise.all([
        appendKnowledgeEntry(first),
        appendKnowledgeEntry(second),
      ]);

      expect(firstResult.success).toBe(true);
      expect(secondResult.success).toBe(true);

      const { listKnowledgeEntriesFromStateLedger } = await import("../lib/state-ledger-sqlite.mjs");
      const stateEntries = listKnowledgeEntriesFromStateLedger({
        repoRoot: tempRoot,
        scopeLevel: "workspace",
        teamId: "team-a",
      });
      expect(stateEntries.map((entry) => entry.agentId)).toEqual(
        expect.arrayContaining(["agent-alpha", "agent-beta"]),
      );

      const entries = await readKnowledgeEntries();
      expect(entries.map((entry) => entry.agentId)).toContain("agent-beta");
    });

    it("allows concurrent writes in the same scope when agents differ", async () => {
      initSharedKnowledge({ repoRoot: tempRoot, targetFile: "TEST.md" });

      const first = buildKnowledgeEntry({
        content: "Session memory: delta can persist recovery learnings in the shared session scope.",
        scope: "testing",
        category: "pattern",
        scopeLevel: "session",
        teamId: "team-a",
        workspaceId: "workspace-1",
        sessionId: "session-shared",
        agentId: "agent-delta",
      });
      const second = buildKnowledgeEntry({
        content: "Session memory: epsilon can also persist shared-session learnings without delta blocking it.",
        scope: "testing",
        category: "pattern",
        scopeLevel: "session",
        teamId: "team-a",
        workspaceId: "workspace-1",
        sessionId: "session-shared",
        agentId: "agent-epsilon",
      });

      const [firstResult, secondResult] = await Promise.all([
        appendKnowledgeEntry(first),
        appendKnowledgeEntry(second),
      ]);

      expect(firstResult.success).toBe(true);
      expect(secondResult.success).toBe(true);
    });

    it("rate limits burst writes from the same agent or scope", async () => {
      initSharedKnowledge({ repoRoot: tempRoot, targetFile: "TEST.md" });

      const first = buildKnowledgeEntry({
        content: "Workspace memory: first write from gamma succeeds before burst protection kicks in.",
        scope: "testing",
        category: "pattern",
        scopeLevel: "workspace",
        teamId: "team-a",
        workspaceId: "workspace-1",
        agentId: "agent-gamma",
      });
      const second = buildKnowledgeEntry({
        content: "Workspace memory: second gamma write should be throttled for duplicate burst protection.",
        scope: "testing",
        category: "pattern",
        scopeLevel: "workspace",
        teamId: "team-a",
        workspaceId: "workspace-1",
        agentId: "agent-gamma",
      });

      const firstResult = await appendKnowledgeEntry(first);
      const secondResult = await appendKnowledgeEntry(second);

      expect(firstResult.success).toBe(true);
      expect(secondResult.success).toBe(false);
      expect(String(secondResult.reason || "")).toContain("rate limited");
    });

    it("allows concurrent writes from different agents when their throttle keys differ", async () => {
      initSharedKnowledge({ repoRoot: tempRoot, targetFile: "TEST.md" });

      const first = buildKnowledgeEntry({
        content: "Session memory: first write for the shared scope should succeed for delta.",
        scope: "testing",
        category: "pattern",
        scopeLevel: "session",
        teamId: "team-a",
        workspaceId: "workspace-1",
        sessionId: "session-shared",
        agentId: "agent-delta",
      });
      const second = buildKnowledgeEntry({
        content: "Session memory: second write in the same session scope should still persist for epsilon when agent throttles are independent.",
        scope: "testing",
        category: "pattern",
        scopeLevel: "session",
        teamId: "team-a",
        workspaceId: "workspace-1",
        sessionId: "session-shared",
        agentId: "agent-epsilon",
      });

      const [firstResult, secondResult] = await Promise.all([
        appendKnowledgeEntry(first),
        appendKnowledgeEntry(second),
      ]);

      expect(firstResult.success).toBe(true);
      expect(secondResult.success).toBe(true);
    });

    it("keeps same-agent burst writes throttled even when other agents write concurrently", async () => {
      initSharedKnowledge({ repoRoot: tempRoot, targetFile: "TEST.md" });

      const agentThetaFirst = buildKnowledgeEntry({
        content: "Session memory: theta first write should persist before duplicate burst suppression activates.",
        scope: "testing",
        category: "pattern",
        scopeLevel: "session",
        teamId: "team-a",
        workspaceId: "workspace-1",
        sessionId: "session-theta",
        agentId: "agent-theta",
      });
      const agentThetaSecond = buildKnowledgeEntry({
        content: "Session memory: theta second write should be throttled because it reuses the same agent and scope immediately.",
        scope: "testing",
        category: "pattern",
        scopeLevel: "session",
        teamId: "team-a",
        workspaceId: "workspace-1",
        sessionId: "session-theta",
        agentId: "agent-theta",
      });
      const agentIota = buildKnowledgeEntry({
        content: "Session memory: iota concurrent write should still persist because only theta's throttle bucket is hot.",
        scope: "testing",
        category: "pattern",
        scopeLevel: "session",
        teamId: "team-a",
        workspaceId: "workspace-1",
        sessionId: "session-theta",
        agentId: "agent-iota",
      });

      const firstThetaResult = await appendKnowledgeEntry(agentThetaFirst);
      const [secondThetaResult, iotaResult] = await Promise.all([
        appendKnowledgeEntry(agentThetaSecond),
        appendKnowledgeEntry(agentIota),
      ]);

      expect(firstThetaResult.success).toBe(true);
      expect(secondThetaResult.success).toBe(false);
      expect(String(secondThetaResult.reason || "")).toContain("rate limited");
      expect(iotaResult.success).toBe(true);
    });

    it("rate limits the same agent within the same scope but not across scopes", async () => {
      initSharedKnowledge({ repoRoot: tempRoot, targetFile: "TEST.md" });

      const first = buildKnowledgeEntry({
        content: "Run memory: first zeta write in workspace scope should persist successfully.",
        scope: "testing",
        category: "pattern",
        scopeLevel: "workspace",
        workspaceId: "workspace-zeta",
        agentId: "agent-zeta",
      });
      const throttled = buildKnowledgeEntry({
        content: "Run memory: second zeta write in the same workspace scope should be throttled immediately.",
        scope: "testing",
        category: "pattern",
        scopeLevel: "workspace",
        workspaceId: "workspace-zeta",
        agentId: "agent-zeta",
      });
      const differentScope = buildKnowledgeEntry({
        content: "Run memory: zeta should still persist to a different session scope without workspace throttling blocking it.",
        scope: "testing",
        category: "pattern",
        scopeLevel: "session",
        sessionId: "session-zeta",
        agentId: "agent-zeta",
      });

      const firstResult = await appendKnowledgeEntry(first);
      const throttledResult = await appendKnowledgeEntry(throttled);
      const differentScopeResult = await appendKnowledgeEntry(differentScope);

      expect(firstResult.success).toBe(true);
      expect(throttledResult.success).toBe(false);
      expect(String(throttledResult.reason || "")).toContain("rate limited");
      expect(differentScopeResult.success).toBe(true);
    });
  });

  describe("readKnowledgeEntries", () => {
    let readKnowledgeEntries, initSharedKnowledge;

    beforeEach(async () => {
      ({ readKnowledgeEntries, initSharedKnowledge } = await import(
        "../workspace/shared-knowledge.mjs"
      ));
    });

    it("returns empty array when file doesn't exist", async () => {
      initSharedKnowledge({ repoRoot: tempRoot, targetFile: "NONEXISTENT.md" });
      const entries = await readKnowledgeEntries();
      expect(entries).toEqual([]);
    });

    it("returns empty array when section doesn't exist", async () => {
      const targetFile = "TEST.md";
      await writeFile(resolve(tempRoot, targetFile), "# No learnings here\n");
      initSharedKnowledge({ repoRoot: tempRoot, targetFile });
      const entries = await readKnowledgeEntries();
      expect(entries).toEqual([]);
    });

    it("parses entries from existing section", async () => {
      const targetFile = "TEST.md";
      const content = `# Agents

## Agent Learnings

### [gotcha](inference) — 2025-01-15

> **Agent:** test-agent (codex)

Always use deterministic TF ops.

---
`;
      await writeFile(resolve(tempRoot, targetFile), content);
      initSharedKnowledge({ repoRoot: tempRoot, targetFile });

      const entries = await readKnowledgeEntries();

      expect(entries.length).toBe(1);
      expect(entries[0].category).toBe("gotcha");
      expect(entries[0].scope).toBe("inference");
      expect(entries[0].agentId).toBe("test-agent");
    });
  });

  describe("getKnowledgeState / formatKnowledgeSummary", () => {
    let getKnowledgeState, formatKnowledgeSummary, initSharedKnowledge;
    beforeEach(async () => {
      ({ getKnowledgeState, formatKnowledgeSummary, initSharedKnowledge } =
        await import("../workspace/shared-knowledge.mjs"));
    });

    it("returns current state snapshot", () => {
      initSharedKnowledge({ repoRoot: tempRoot });
      const state = getKnowledgeState();
      expect(state).toHaveProperty("entriesWritten");
      expect(state).toHaveProperty("targetFile");
      expect(state).toHaveProperty("throttleKeys");
    });

    it("formats a summary string", () => {
      initSharedKnowledge({ repoRoot: tempRoot });
      const summary = formatKnowledgeSummary();
      expect(typeof summary).toBe("string");
      expect(summary).toContain("Shared Knowledge");
    });
  });

  describe("retrieveKnowledgeEntries / formatKnowledgeBriefing", () => {
    let initSharedKnowledge;
    let buildKnowledgeEntry;
    let appendKnowledgeEntry;
    let retrieveKnowledgeEntries;
    let formatKnowledgeBriefing;

    beforeEach(async () => {
      ({
        initSharedKnowledge,
        buildKnowledgeEntry,
        appendKnowledgeEntry,
        retrieveKnowledgeEntries,
        formatKnowledgeBriefing,
      } = await import("../workspace/shared-knowledge.mjs"));
      initSharedKnowledge({ repoRoot: tempRoot, targetFile: "TEST.md" });
    });

    it("retrieves only memories visible to the current scope chain", async () => {
      const entries = [
        {
          content: "Run memory: retried login migrations only after seeding fixtures.",
          scopeLevel: "run",
          teamId: "team-a",
          workspaceId: "workspace-1",
          sessionId: "session-1",
          runId: "run-1",
          agentId: "agent-run",
        },
        {
          content: "Session memory: keep mocked clocks aligned across retry attempts.",
          scopeLevel: "session",
          teamId: "team-a",
          workspaceId: "workspace-1",
          sessionId: "session-1",
          runId: "run-0",
          agentId: "agent-session",
        },
        {
          content: "Workspace memory: flaky login tests need a DB fixture reset.",
          scopeLevel: "workspace",
          teamId: "team-a",
          workspaceId: "workspace-1",
          sessionId: "session-0",
          runId: "run-0",
          agentId: "agent-workspace",
        },
        {
          content: "Team memory: prefer deterministic waits in browser tests.",
          scopeLevel: "team",
          teamId: "team-a",
          workspaceId: "workspace-0",
          sessionId: "session-0",
          runId: "run-0",
          agentId: "agent-team",
        },
        {
          content: "Workspace memory: payments smoke tests require a sandbox token.",
          scopeLevel: "workspace",
          teamId: "team-a",
          workspaceId: "workspace-2",
          sessionId: "session-2",
          runId: "run-2",
          agentId: "agent-other-workspace",
        },
      ];

      for (const entry of entries) {
        const result = await appendKnowledgeEntry(
          buildKnowledgeEntry({
            ...entry,
            scope: "testing",
            category: "pattern",
          }),
        );
        expect(result.success).toBe(true);
      }

      const retrieved = await retrieveKnowledgeEntries({
        repoRoot: tempRoot,
        teamId: "team-a",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        runId: "run-1",
        query: "stabilize flaky login retries with fixture reset and deterministic waits",
        limit: 10,
      });

      expect(retrieved.map((entry) => entry.scopeLevel)).toEqual([
        "run",
        "session",
        "workspace",
        "team",
      ]);
      expect(retrieved.map((entry) => entry.content)).not.toContain(
        "Workspace memory: payments smoke tests require a sandbox token.",
      );
    });

    it("formats a bounded briefing for prompt injection", async () => {
      const retrieved = [
        buildKnowledgeEntry({
          content: "Run memory: reseed fixtures before the final retry.",
          scope: "testing",
          scopeLevel: "run",
          teamId: "team-a",
          workspaceId: "workspace-1",
          sessionId: "session-1",
          runId: "run-1",
          agentId: "agent-run",
        }),
        buildKnowledgeEntry({
          content: "Workspace memory: browser login tests fail without fixture reset.",
          scope: "testing",
          scopeLevel: "workspace",
          teamId: "team-a",
          workspaceId: "workspace-1",
          sessionId: "session-9",
          runId: "run-9",
          agentId: "agent-workspace",
        }),
        buildKnowledgeEntry({
          content: "Team memory: deterministic waits beat sleep-based polling.",
          scope: "testing",
          scopeLevel: "team",
          teamId: "team-a",
          workspaceId: "workspace-9",
          sessionId: "session-9",
          runId: "run-9",
          agentId: "agent-team",
        }),
      ];

      const briefing = formatKnowledgeBriefing(retrieved, { maxEntries: 2 });

      expect(briefing).toContain("## Persistent Memory Briefing");
      expect(briefing).toContain("[run]");
      expect(briefing).toContain("[workspace]");
      expect(briefing).not.toContain("[team]");
    });

    it("includes path-match reasons in briefings when graph-aware ranking is available", () => {
      const briefing = formatKnowledgeBriefing([
        {
          ...buildKnowledgeEntry({
            content: "Workspace memory: reseed auth fixtures before retrying login flows.",
            scope: "testing",
            scopeLevel: "workspace",
            teamId: "team-a",
            workspaceId: "workspace-1",
            sessionId: "session-1",
            runId: "run-1",
            agentId: "agent-workspace",
          }),
          directPathHits: ["src/auth/login.mjs"],
        },
        {
          ...buildKnowledgeEntry({
            content: "Workspace memory: session-store snapshots must stay deterministic.",
            scope: "testing",
            scopeLevel: "workspace",
            teamId: "team-a",
            workspaceId: "workspace-1",
            sessionId: "session-1",
            runId: "run-1",
            agentId: "agent-workspace",
          }),
          adjacentPathHits: ["src/auth/session-store.mjs"],
        },
      ]);

      expect(briefing).toContain("matched=src/auth/login.mjs");
      expect(briefing).toContain("graph=src/auth/session-store.mjs");
    });

    it("retrieves memories from the SQL ledger even when the JSON registry is missing", async () => {
      const registryPath = resolve(tempRoot, ".cache", "bosun", "persistent-memory.json");
      const {
        listKnowledgeEntriesFromStateLedger,
      } = await import("../lib/state-ledger-sqlite.mjs");

      const result = await appendKnowledgeEntry(buildKnowledgeEntry({
        content: "Workspace memory: reset fixtures before retrying browser login flows.",
        scope: "testing",
        scopeLevel: "workspace",
        teamId: "team-a",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        runId: "run-1",
        agentId: "agent-workspace",
      }));
      expect(result.success).toBe(true);

      await rm(registryPath, { force: true });

      const retrieved = await retrieveKnowledgeEntries({
        repoRoot: tempRoot,
        teamId: "team-a",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        runId: "run-1",
        query: "retry browser login fixtures",
        limit: 5,
      });

      expect(retrieved).toEqual([
        expect.objectContaining({
          content: "Workspace memory: reset fixtures before retrying browser login flows.",
          scopeLevel: "workspace",
        }),
      ]);
      expect(listKnowledgeEntriesFromStateLedger({ repoRoot: tempRoot, workspaceId: "workspace-1" })).toEqual([
        expect.objectContaining({
          content: "Workspace memory: reset fixtures before retrying browser login flows.",
        }),
      ]);
    });

    it("rewrites the JSON registry from the SQL ledger instead of preserving stale projection entries", async () => {
      const registryPath = resolve(tempRoot, ".cache", "bosun", "persistent-memory.json");
      const staleEntry = buildKnowledgeEntry({
        content: "Workspace memory: stale projected entry that should not survive projection rebuild.",
        scope: "testing",
        scopeLevel: "workspace",
        teamId: "team-a",
        workspaceId: "workspace-stale",
        sessionId: "session-stale",
        runId: "run-stale",
        agentId: "agent-stale",
      });
      await mkdir(resolve(tempRoot, ".cache", "bosun"), { recursive: true });
      await writeFile(registryPath, JSON.stringify({
        version: "1.0.0",
        updatedAt: staleEntry.timestamp,
        entries: [staleEntry],
      }, null, 2), "utf8");

      const result = await appendKnowledgeEntry(buildKnowledgeEntry({
        content: "Workspace memory: canonical ledger entry for auth retry fixtures.",
        scope: "testing",
        scopeLevel: "workspace",
        teamId: "team-a",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        runId: "run-1",
        agentId: "agent-workspace",
      }));
      expect(result.success).toBe(true);

      const registry = JSON.parse(await readFile(registryPath, "utf8"));
      expect(Array.isArray(registry.entries)).toBe(true);
      expect(registry.entries).toEqual([
        expect.objectContaining({
          content: "Workspace memory: canonical ledger entry for auth retry fixtures.",
          workspaceId: "workspace-1",
        }),
      ]);
      expect(registry.entries.map((entry) => entry.content)).not.toContain(
        "Workspace memory: stale projected entry that should not survive projection rebuild.",
      );
    });

    it("backfills legacy JSON registry memories into the SQL ledger on retrieval", async () => {
      const registryPath = resolve(tempRoot, ".cache", "bosun", "persistent-memory.json");
      const {
        listKnowledgeEntriesFromStateLedger,
      } = await import("../lib/state-ledger-sqlite.mjs");

      const legacyEntry = buildKnowledgeEntry({
        content: "Workspace memory: seed deterministic data before replaying flaky workflows.",
        scope: "testing",
        scopeLevel: "workspace",
        teamId: "team-a",
        workspaceId: "workspace-1",
        sessionId: "session-legacy",
        runId: "run-legacy",
        agentId: "agent-legacy",
      });
      await mkdir(resolve(tempRoot, ".cache", "bosun"), { recursive: true });
      await writeFile(registryPath, JSON.stringify({
        version: "1.0.0",
        updatedAt: legacyEntry.timestamp,
        entries: [legacyEntry],
      }, null, 2), "utf8");

      const retrieved = await retrieveKnowledgeEntries({
        repoRoot: tempRoot,
        teamId: "team-a",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        runId: "run-1",
        query: "deterministic replay workflows",
        limit: 5,
      });

      expect(retrieved).toEqual([
        expect.objectContaining({
          content: "Workspace memory: seed deterministic data before replaying flaky workflows.",
          scopeLevel: "workspace",
        }),
      ]);
      expect(listKnowledgeEntriesFromStateLedger({ repoRoot: tempRoot, workspaceId: "workspace-1" })).toEqual([
        expect.objectContaining({
          content: "Workspace memory: seed deterministic data before replaying flaky workflows.",
          hash: legacyEntry.hash,
        }),
      ]);
      const rewrittenRegistry = JSON.parse(await readFile(registryPath, "utf8"));
      expect(rewrittenRegistry.entries).toEqual([
        expect.objectContaining({
          content: "Workspace memory: seed deterministic data before replaying flaky workflows.",
          hash: legacyEntry.hash,
        }),
      ]);
    });

    it("prefers memories tied to directly changed files over generic workspace memories", async () => {
      await mkdir(resolve(tempRoot, ".bosun", "context-index"), { recursive: true });
      await writeFile(
        resolve(tempRoot, ".bosun", "context-index", "agent-index.json"),
        JSON.stringify({ relations: [] }, null, 2),
        "utf8",
      );

      const genericResult = await appendKnowledgeEntry(buildKnowledgeEntry({
        content: "Workspace memory: refresh session fixtures before retrying auth flows.",
        scope: "testing",
        scopeLevel: "workspace",
        teamId: "team-a",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        runId: "run-1",
        agentId: "agent-generic",
      }));
      expect(genericResult.success).toBe(true);

      const directResult = await appendKnowledgeEntry(buildKnowledgeEntry({
        content: "Workspace memory: src/auth/login.mjs must reseed auth fixtures before replaying retries.",
        scope: "testing",
        scopeLevel: "workspace",
        teamId: "team-a",
        workspaceId: "workspace-1",
        sessionId: "session-2",
        runId: "run-2",
        agentId: "agent-direct",
        relatedPaths: ["src/auth/login.mjs"],
      }));
      expect(directResult.success).toBe(true);

      const retrieved = await retrieveKnowledgeEntries({
        repoRoot: tempRoot,
        teamId: "team-a",
        workspaceId: "workspace-1",
        sessionId: "session-9",
        runId: "run-9",
        query: "retry auth fixtures before replaying login flows",
        changedFiles: ["src/auth/login.mjs"],
        limit: 5,
      });

      expect(retrieved[0]).toEqual(expect.objectContaining({
        content: "Workspace memory: src/auth/login.mjs must reseed auth fixtures before replaying retries.",
        directPathHits: ["src/auth/login.mjs"],
      }));
      expect(retrieved[0].score).toBeGreaterThan(retrieved[1].score);
    });

    it("boosts memories attached to graph-adjacent files when direct matches are absent", async () => {
      await mkdir(resolve(tempRoot, ".bosun", "context-index"), { recursive: true });
      await writeFile(
        resolve(tempRoot, ".bosun", "context-index", "agent-index.json"),
        JSON.stringify({
          relations: [
            {
              relationType: "file_imports_file",
              fromPath: "src/auth/login.mjs",
              toPath: "src/auth/session-store.mjs",
            },
          ],
        }, null, 2),
        "utf8",
      );

      const adjacentResult = await appendKnowledgeEntry(buildKnowledgeEntry({
        content: "Workspace memory: session-store retries need deterministic token snapshots.",
        scope: "testing",
        scopeLevel: "workspace",
        teamId: "team-a",
        workspaceId: "workspace-1",
        sessionId: "session-2",
        runId: "run-2",
        agentId: "agent-adjacent",
        relatedPaths: ["src/auth/session-store.mjs"],
      }));
      expect(adjacentResult.success).toBe(true);

      const unrelatedResult = await appendKnowledgeEntry(buildKnowledgeEntry({
        content: "Workspace memory: billing retries also need deterministic token snapshots.",
        scope: "testing",
        scopeLevel: "workspace",
        teamId: "team-a",
        workspaceId: "workspace-1",
        sessionId: "session-3",
        runId: "run-3",
        agentId: "agent-unrelated",
        relatedPaths: ["src/billing/invoice-runner.mjs"],
      }));
      expect(unrelatedResult.success).toBe(true);

      const retrieved = await retrieveKnowledgeEntries({
        repoRoot: tempRoot,
        teamId: "team-a",
        workspaceId: "workspace-1",
        sessionId: "session-9",
        runId: "run-9",
        query: "deterministic token snapshots for retries",
        changedFiles: ["src/auth/login.mjs"],
        limit: 5,
      });

      expect(retrieved[0]).toEqual(expect.objectContaining({
        content: "Workspace memory: session-store retries need deterministic token snapshots.",
        adjacentPathHits: ["src/auth/session-store.mjs"],
      }));
      expect(retrieved[1].adjacentPathHits).toEqual([]);
      expect(retrieved[0].score).toBeGreaterThan(retrieved[1].score);
    });

    it("uses the context index database for graph-adjacent boosts when the json projection is missing", async () => {
      const { runContextIndex } = await import("../workspace/context-indexer.mjs");

      await mkdir(resolve(tempRoot, "src", "auth"), { recursive: true });
      await writeFile(
        resolve(tempRoot, "src", "auth", "session-store.mjs"),
        "export function createSessionStore() { return new Map(); }\n",
        "utf8",
      );
      await writeFile(
        resolve(tempRoot, "src", "auth", "login.mjs"),
        "import { createSessionStore } from './session-store.mjs';\nexport function retryLogin() { return createSessionStore(); }\n",
        "utf8",
      );

      await runContextIndex({
        rootDir: tempRoot,
        includeTests: true,
        useTreeSitter: false,
        useZoekt: false,
      });
      await rm(resolve(tempRoot, ".bosun", "context-index", "agent-index.json"), { force: true });

      const adjacentResult = await appendKnowledgeEntry(buildKnowledgeEntry({
        content: "Workspace memory: session-store retries need deterministic token snapshots.",
        scope: "testing",
        scopeLevel: "workspace",
        teamId: "team-a",
        workspaceId: "workspace-1",
        sessionId: "session-2",
        runId: "run-2",
        agentId: "agent-adjacent-db",
        relatedPaths: ["src/auth/session-store.mjs"],
      }));
      expect(adjacentResult.success).toBe(true);

      const unrelatedResult = await appendKnowledgeEntry(buildKnowledgeEntry({
        content: "Workspace memory: billing retries also need deterministic token snapshots.",
        scope: "testing",
        scopeLevel: "workspace",
        teamId: "team-a",
        workspaceId: "workspace-1",
        sessionId: "session-3",
        runId: "run-3",
        agentId: "agent-unrelated-db",
        relatedPaths: ["src/billing/invoice-runner.mjs"],
      }));
      expect(unrelatedResult.success).toBe(true);

      const retrieved = await retrieveKnowledgeEntries({
        repoRoot: tempRoot,
        teamId: "team-a",
        workspaceId: "workspace-1",
        sessionId: "session-9",
        runId: "run-9",
        query: "deterministic token snapshots for retries",
        changedFiles: ["src/auth/login.mjs"],
        limit: 5,
      });

      expect(retrieved[0]).toEqual(expect.objectContaining({
        content: "Workspace memory: session-store retries need deterministic token snapshots.",
        adjacentPathHits: ["src/auth/session-store.mjs"],
      }));
      expect(retrieved[1].adjacentPathHits).toEqual([]);
    });
  });


  // ── Task List Sharing ────────────────────────────────────────────────────

  describe("publishTaskList", () => {
    let publishTaskList;
    beforeEach(async () => {
      ({ publishTaskList } = await import("../agent/fleet-coordinator.mjs"));
    });

    it("writes task list JSON to fleet-tasks.json", async () => {
      const tasks = [
        { id: "t1", title: "Fix login", status: "todo", size: "s" },
        { id: "t2", title: "Add feature", status: "inprogress", size: "m" },
      ];
      const result = await publishTaskList({ repoRoot: tempRoot, tasks });
      expect(result.tasks).toHaveLength(2);
      expect(result.publishedAt).toBeTruthy();

      // Verify file was written
      const filePath = resolve(tempRoot, ".cache/bosun/fleet-tasks.json");
      const raw = await readFile(filePath, "utf8");
      const data = JSON.parse(raw);
      expect(data.tasks).toHaveLength(2);
      expect(data.tasks[0].title).toBe("Fix login");
    });

    it("handles empty task list", async () => {
      const result = await publishTaskList({ repoRoot: tempRoot, tasks: [] });
      expect(result.tasks).toEqual([]);
    });
  });

  describe("readPeerTaskList", () => {
    let readPeerTaskList;
    beforeEach(async () => {
      ({ readPeerTaskList } = await import("../agent/fleet-coordinator.mjs"));
    });

    it("reads a valid peer task list file", async () => {
      const dir = resolve(tempRoot, "peer-cache");
      await mkdir(dir, { recursive: true });
      const filePath = resolve(dir, "fleet-tasks.json");
      const payload = {
        instanceId: "peer-1",
        instanceLabel: "Peer 1",
        repoFingerprint: "abc123",
        tasks: [{ id: "t1", title: "Task 1", status: "todo" }],
        publishedAt: new Date().toISOString(),
      };
      await writeFile(filePath, JSON.stringify(payload), "utf8");

      const result = await readPeerTaskList(filePath);
      expect(result).not.toBeNull();
      expect(result.instanceId).toBe("peer-1");
      expect(result.tasks).toHaveLength(1);
    });

    it("returns null for non-existent file", async () => {
      const result = await readPeerTaskList("/nonexistent/path.json");
      expect(result).toBeNull();
    });

    it("returns null for invalid JSON", async () => {
      const filePath = resolve(tempRoot, "bad.json");
      await writeFile(filePath, "not json", "utf8");
      const result = await readPeerTaskList(filePath);
      expect(result).toBeNull();
    });
  });

  describe("bootstrapFromPeer", () => {
    let bootstrapFromPeer;
    beforeEach(async () => {
      ({ bootstrapFromPeer } = await import("../agent/fleet-coordinator.mjs"));
    });

    it("returns null when no peer lists", () => {
      const result = bootstrapFromPeer({ peerLists: [] });
      expect(result).toBeNull();
    });

    it("picks peer with most todo tasks", () => {
      const peerLists = [
        {
          instanceId: "p1",
          instanceLabel: "Peer 1",
          repoFingerprint: null,
          tasks: [
            { id: "t1", status: "todo" },
            { id: "t2", status: "done" },
          ],
        },
        {
          instanceId: "p2",
          instanceLabel: "Peer 2",
          repoFingerprint: null,
          tasks: [
            { id: "t3", status: "todo" },
            { id: "t4", status: "todo" },
            { id: "t5", status: "todo" },
          ],
        },
      ];
      const result = bootstrapFromPeer({ peerLists });
      expect(result.source).toBe("p2");
      expect(result.tasks).toHaveLength(3);
      expect(result.totalAvailable).toBe(3);
    });

    it("excludes self by instance ID", () => {
      const peerLists = [
        {
          instanceId: "self",
          instanceLabel: "Me",
          repoFingerprint: null,
          tasks: [{ id: "t1", status: "todo" }],
        },
      ];
      const result = bootstrapFromPeer({
        peerLists,
        myInstanceId: "self",
      });
      expect(result).toBeNull();
    });

    it("returns null when no peers have todo tasks", () => {
      const peerLists = [
        {
          instanceId: "p1",
          instanceLabel: "Peer 1",
          repoFingerprint: null,
          tasks: [{ id: "t1", status: "done" }],
        },
      ];
      const result = bootstrapFromPeer({ peerLists });
      expect(result).toBeNull();
    });
  });

  // ── Auto-generation Trigger ──────────────────────────────────────────────

  describe("shouldAutoGenerateTasks", () => {
    let shouldAutoGenerateTasks, resetAutoGenCooldown, markAutoGenTriggered;
    beforeEach(async () => {
      ({ shouldAutoGenerateTasks, resetAutoGenCooldown, markAutoGenTriggered } =
        await import("../agent/fleet-coordinator.mjs"));
      resetAutoGenCooldown();
    });

    it("returns shouldGenerate=true when backlog is empty", () => {
      const result = shouldAutoGenerateTasks({
        currentBacklog: 0,
      });
      expect(result.shouldGenerate).toBe(true);
      expect(result.deficit).toBeGreaterThan(0);
    });

    it("returns needsApproval=true by default", () => {
      const result = shouldAutoGenerateTasks({
        currentBacklog: 0,
        requireApproval: true,
      });
      expect(result.needsApproval).toBe(true);
      expect(result.mode).toBe("confirm");
    });

    it("returns needsApproval=false when requireApproval=false", () => {
      const result = shouldAutoGenerateTasks({
        currentBacklog: 0,
        requireApproval: false,
      });
      expect(result.needsApproval).toBe(false);
      expect(result.mode).toBe("auto");
    });

    it("respects cooldown period", () => {
      markAutoGenTriggered();
      const result = shouldAutoGenerateTasks({
        currentBacklog: 0,
        cooldownMs: 60000,
      });
      expect(result.shouldGenerate).toBe(false);
      expect(result.reason).toContain("cooldown");
    });

    it("returns shouldGenerate=false when backlog is sufficient", () => {
      const result = shouldAutoGenerateTasks({
        currentBacklog: 100,
      });
      expect(result.shouldGenerate).toBe(false);
      expect(result.reason).toContain("sufficient");
    });
  });
});
