import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("session ui interactions", () => {
  it("supports right-click context menu and edit title action in session list", () => {
    const source = readFileSync(resolve(process.cwd(), "ui/components/session-list.js"), "utf8");
    expect(source).toContain("onContextMenu=${(e) => {");
    expect(source).toContain("Edit title");
    expect(source).toContain("handleContextAction(\"archive\")");
    expect(source).toContain("resolveIcon(\":menu:\")");
  });

  it("controls session filter scope from chat tab", () => {
    const source = readFileSync(resolve(process.cwd(), "ui/tabs/chat.js"), "utf8");
    expect(source).toContain("SESSION_VIEW_FILTER");
    expect(source).toContain("getWorkspaceScopeForView");
    expect(source).toContain("onSessionViewChange");
    expect(source).toContain("workspace: getWorkspaceScopeForView(view)");
  });

  it("adds right-click control menus to task cards, workflow cards, and run history rows", () => {
    const boardSource = readFileSync(resolve(process.cwd(), "ui/components/kanban-board.js"), "utf8");
    const workflowSource = readFileSync(resolve(process.cwd(), "ui/tabs/workflows.js"), "utf8");

    expect(boardSource).toContain("onTaskContextMenu");
    expect(boardSource).toContain("Move to In Progress");
    expect(boardSource).toContain("Copy ID");
    expect(workflowSource).toContain("workflowCardContextMenu");
    expect(workflowSource).toContain("openWorkflowCardContextMenu");
    expect(workflowSource).toContain("runRowContextMenu");
    expect(workflowSource).toContain("Copy run ID");
  });
});

describe("theme precedence safeguards", () => {
  it("applies light media theme only in system mode", () => {
    const source = readFileSync(resolve(process.cwd(), "ui/styles/variables.css"), "utf8");
    expect(source).toContain(':root[data-theme-lock="system"]:not([data-theme])');
  });

  it("prevents Telegram theme from overriding explicit app themes", () => {
    const source = readFileSync(resolve(process.cwd(), "ui/modules/telegram.js"), "utf8");
    expect(source).toContain("const appThemeLocked = Boolean");
    expect(source).toContain("if (appThemeLocked)");
  });

  it("bootstraps theme lock on initial page load", () => {
    const source = readFileSync(resolve(process.cwd(), "ui/index.html"), "utf8");
    expect(source).toContain("data-theme-lock");
    expect(source).toContain("'custom'");
    expect(source).toContain("'system'");
  });
});
