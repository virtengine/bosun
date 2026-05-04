import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function read(relPath) {
  return readFileSync(resolve(ROOT, relPath), "utf8");
}

describe("stored defaults config routing", () => {
  it("does not let app preferences silently mutate executor server config on startup", () => {
    const uiSource = read("ui/modules/state.js");
    const siteSource = read("site/ui/modules/state.js");

    for (const source of [uiSource, siteSource]) {
      expect(source).toContain("Executor runtime defaults now live only in Server Config");
      expect(source).not.toContain('apiFetch("/api/settings/update"');
      expect(source).not.toContain('apiFetch("/api/executor/maxparallel"');
      expect(source).not.toContain('JSON.stringify({ changes: settingsUpdates })');
    }
  });

  it("keeps executor response shape intact and mirrors workspace executor controls in Control", () => {
    const uiStateSource = read("ui/modules/state.js");
    const siteStateSource = read("site/ui/modules/state.js");
    const uiControlSource = read("ui/tabs/control.js");
    const siteControlSource = read("site/ui/tabs/control.js");
    const uiSwitcherSource = read("ui/components/workspace-switcher.js");
    const siteSwitcherSource = read("site/ui/components/workspace-switcher.js");
    const uiFleetSource = read("ui/tabs/agents.js");
    const siteFleetSource = read("site/ui/tabs/agents.js");

    for (const source of [uiStateSource, siteStateSource]) {
      expect(source).toContain('const url = "/api/executor"');
      expect(source).not.toContain('executorData.value = res.data ?? fallback');
      expect(source).toContain('counts.blocked ?? counts.error ?? 0');
    }

    for (const source of [uiControlSource, siteControlSource]) {
      expect(source).toContain('activeWorkspaceId');
      expect(source).toContain('loadWorkspaces');
      expect(source).toContain('setWorkspaceExecutors');
      expect(source).toContain('WorkspaceExecutorSettingsFields');
      expect(source).toContain('Active Workspace Executors');
      expect(source).toContain('Save Workspace Executors');
      expect(source).toContain('Control mirrors the active workspace executor config used in the workspace switcher.');
      expect(source).toContain('Session Phase');
      expect(source).toContain('Prompt Discipline');
      expect(source).toContain('Tool Discipline');
    }

    for (const source of [uiSwitcherSource, siteSwitcherSource]) {
      expect(source).toContain('WorkspaceExecutorSettingsFields');
      expect(source).toContain('formatWorkspaceExecutorSummary');
      expect(source).toContain('Save Executor Config');
    }

    for (const source of [uiFleetSource, siteFleetSource]) {
      expect(source).toContain('loadWorkspaces().catch(() => {})');
      expect(source).toContain('Workspace: ${workspaceHeader} · ${workspaceHeaderDetail}');
    }
  });
});
