import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildBoardFilterStorageKey,
  persistBoardFilters,
  readPersistedBoardFilters,
  sanitizeBoardFilters,
} from "../ui/components/kanban-board.js";

const boardSource = readFileSync(
  resolve(process.cwd(), "ui/components/kanban-board.js"),
  "utf8",
);
const cssSource = readFileSync(
  resolve(process.cwd(), "ui/styles/kanban.css"),
  "utf8",
);

describe("kanban scroll regression guards", () => {
  it("keeps multiple load-more triggers for per-column pagination", () => {
    expect(boardSource).toMatch(/IntersectionObserver/);
    expect(boardSource).toMatch(/useLayoutEffect/);
    expect(boardSource).toMatch(/onScroll=\$\{onCardsScroll\}/);
    expect(boardSource).toMatch(/onWheel=\$\{onCardsWheel\}/);
    expect(boardSource).toMatch(/class="kanban-load-more"/);
  });

  it("keeps task-card context controls available on right click", () => {
    expect(boardSource).toContain("onTaskContextMenu");
    expect(boardSource).toContain("Move to In Progress");
    expect(boardSource).toContain("Copy ID");
  });

  it("imports the MUI menu components used by the board filters", () => {
    expect(boardSource).toMatch(/import\s*\{[^}]*\bMenu\b[^}]*\bMenuItem\b[^}]*\}\s*from\s*["']@mui\/material["']/);
    expect(boardSource).toContain("<${Menu}");
    expect(boardSource).toContain("<${MenuItem}");
  });

  it("keeps the manual load-more affordance outside the scroll body", () => {
    const cardsIndex = boardSource.indexOf('class="kanban-cards"');
    const sentinelIndex = boardSource.indexOf('class="kanban-tail-sentinel"');
    const footerIndex = boardSource.indexOf('class="kanban-column-footer"');
    expect(cardsIndex).toBeGreaterThan(-1);
    expect(sentinelIndex).toBeGreaterThan(cardsIndex);
    expect(footerIndex).toBeGreaterThan(sentinelIndex);
  });

  it("keeps columns as bounded independent scroll lanes", () => {
    expect(cssSource).toMatch(/\.kanban-column \{[\s\S]*overflow: hidden;/);
    expect(cssSource).toMatch(/\.kanban-cards \{[\s\S]*overflow-y: auto;/);
    expect(cssSource).toMatch(/\.kanban-cards \{[\s\S]*touch-action: pan-y;/);
    expect(cssSource).toMatch(/\.kanban-column-footer \{[\s\S]*position: sticky;/);
    expect(cssSource).toMatch(/\.kanban-column \{[\s\S]*height: clamp\(/);
  });

  it("gates persistence until workspace hydration completes", () => {
    expect(boardSource).toContain("hydratedWorkspaceScope");
    expect(boardSource).toContain("if (hydratedWorkspaceScope !== workspaceScope) return;");
  });

  it("raises the initial kanban fetch budget so large boards do not stop at half a page", () => {
    const stateSource = readFileSync(
      resolve(process.cwd(), "ui/modules/state.js"),
      "utf8",
    );
    expect(stateSource).toContain("export const KANBAN_PAGE_SIZE = 500;");
    expect(boardSource).toContain("const AUTO_LOAD_MAX_TASKS = 1000;");
  });
});

class MemoryStorage {
  #values = new Map();

  getItem(key) {
    return this.#values.has(key) ? this.#values.get(key) : null;
  }

  setItem(key, value) {
    this.#values.set(key, String(value));
  }

  removeItem(key) {
    this.#values.delete(key);
  }
}

describe("kanban board filter persistence", () => {
  it("persists and rehydrates board filters for refresh in the same workspace", () => {
    const storage = new MemoryStorage();
    const filters = {
      repo: "repo-alpha",
      assignee: "agent-1",
      priority: "high",
      search: "bugfix",
    };
    const ok = persistBoardFilters({
      storage,
      workspaceId: "ws-alpha",
      filters,
    });

    expect(ok).toBe(true);
    expect(readPersistedBoardFilters({ storage, workspaceId: "ws-alpha" })).toEqual(filters);
  });

  it("keeps filter state isolated across workspace switches", () => {
    const storage = new MemoryStorage();
    persistBoardFilters({
      storage,
      workspaceId: "ws-alpha",
      filters: { repo: "repo-alpha", assignee: "", priority: "", search: "" },
    });
    persistBoardFilters({
      storage,
      workspaceId: "ws-beta",
      filters: { repo: "repo-beta", assignee: "agent-2", priority: "medium", search: "triage" },
    });

    expect(readPersistedBoardFilters({ storage, workspaceId: "ws-alpha" })).toEqual({
      repo: "repo-alpha",
      assignee: "",
      priority: "",
      search: "",
    });
    expect(readPersistedBoardFilters({ storage, workspaceId: "ws-beta" })).toEqual({
      repo: "repo-beta",
      assignee: "agent-2",
      priority: "medium",
      search: "triage",
    });
  });

  it("does not hydrate workspace-specific filters from legacy global payloads", () => {
    const storage = new MemoryStorage();
    storage.setItem("ve-kanban-board-filters", JSON.stringify({
      version: 2,
      workspace: "global",
      filters: { repo: "repo-legacy", assignee: "", priority: "high", search: "legacy" },
    }));

    expect(readPersistedBoardFilters({ storage, workspaceId: "ws-alpha" })).toEqual({
      repo: "",
      assignee: "",
      priority: "",
      search: "",
    });
  });

  it("falls back to legacy global payload only for global scope and migrates it", () => {
    const storage = new MemoryStorage();
    storage.setItem("ve-kanban-board-filters", JSON.stringify({
      version: 2,
      workspace: "global",
      filters: { repo: "repo-legacy", assignee: "agent-1", priority: "high", search: "legacy" },
    }));

    expect(readPersistedBoardFilters({ storage, workspaceId: "" })).toEqual({
      repo: "repo-legacy",
      assignee: "agent-1",
      priority: "high",
      search: "legacy",
    });
    expect(storage.getItem(buildBoardFilterStorageKey("global"))).toContain("\"workspace\":\"global\"");
  });

  it("ignores persisted payloads when the scoped key workspace metadata is mismatched", () => {
    const storage = new MemoryStorage();
    storage.setItem(buildBoardFilterStorageKey("ws-alpha"), JSON.stringify({
      version: 2,
      workspace: "ws-beta",
      filters: { repo: "repo-beta", assignee: "agent-2", priority: "medium", search: "wrong-scope" },
    }));

    expect(readPersistedBoardFilters({ storage, workspaceId: "ws-alpha" })).toEqual({
      repo: "",
      assignee: "",
      priority: "",
      search: "",
    });
  });

  it("falls back to safe defaults for stale schema payloads", () => {
    const storage = new MemoryStorage();
    storage.setItem(buildBoardFilterStorageKey("ws-stale"), JSON.stringify({
      version: 0,
      filters: { repo: "legacy", assignee: "legacy", priority: "high", search: "legacy" },
    }));

    expect(readPersistedBoardFilters({ storage, workspaceId: "ws-stale" })).toEqual({
      repo: "",
      assignee: "",
      priority: "",
      search: "",
    });
    expect(storage.getItem(buildBoardFilterStorageKey("ws-stale"))).toContain("\"version\":2");
    expect(storage.getItem(buildBoardFilterStorageKey("ws-stale"))).toContain("\"workspace\":\"ws-stale\"");
  });

  it("sanitizes invalid and stale filter values during mutation validation", () => {
    const sanitized = sanitizeBoardFilters(
      {
        repo: "repo-missing",
        assignee: "agent-missing",
        priority: "urgent",
        search: "  escaped  ",
      },
      {
        allowedRepos: new Set(["repo-live"]),
        allowedAssignees: new Set(["agent-live"]),
      },
    );

    expect(sanitized).toEqual({
      repo: "",
      assignee: "",
      priority: "",
      search: "escaped",
    });
  });

  it("does not clear repo or assignee when allowed sets are present but empty", () => {
    const sanitized = sanitizeBoardFilters(
      {
        repo: "repo-persisted",
        assignee: "agent-persisted",
        priority: "high",
        search: "keep",
      },
      {
        allowedRepos: new Set(),
        allowedAssignees: new Set(),
      },
    );

    expect(sanitized).toEqual({
      repo: "repo-persisted",
      assignee: "agent-persisted",
      priority: "high",
      search: "keep",
    });
  });

  it("trims and bounds malformed filter mutations", () => {
    const sanitized = sanitizeBoardFilters({
      repo: ["repo-array"],
      assignee: null,
      priority: "urgent",
      search: `  ${"x".repeat(200)}  `,
    });

    expect(sanitized.repo).toBe("");
    expect(sanitized.assignee).toBe("");
    expect(sanitized.priority).toBe("");
    expect(sanitized.search.length).toBe(120);
  });

  it("rewrites persisted filters when load-time validation drops stale values", () => {
    const storage = new MemoryStorage();
    const key = buildBoardFilterStorageKey("ws-alpha");
    storage.setItem(key, JSON.stringify({
      version: 2,
      workspace: "ws-alpha",
      filters: {
        repo: "repo-removed",
        assignee: "agent-removed",
        priority: "high",
        search: "keep",
      },
    }));

    const filters = readPersistedBoardFilters({
      storage,
      workspaceId: "ws-alpha",
      validateWith: {
        allowedRepos: new Set(["repo-live"]),
        allowedAssignees: new Set(["agent-live"]),
      },
    });

    expect(filters).toEqual({
      repo: "",
      assignee: "",
      priority: "high",
      search: "keep",
    });
    expect(storage.getItem(key)).toContain("\"repo\":\"\"");
    expect(storage.getItem(key)).toContain("\"assignee\":\"\"");
  });
});
