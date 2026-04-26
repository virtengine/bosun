import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const tasksSource = readFileSync(new URL("../ui/tabs/tasks.js", import.meta.url), "utf8");
const chatSource = readFileSync(new URL("../ui/tabs/chat.js", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("../ui/tabs/settings.js", import.meta.url), "utf8");
const demoSource = readFileSync(new URL("../ui/demo.html", import.meta.url), "utf8");
const siteDemoSource = readFileSync(new URL("../site/ui/demo.html", import.meta.url), "utf8");
const componentsCss = readFileSync(new URL("../ui/styles/components.css", import.meta.url), "utf8");
const siteComponentsCss = readFileSync(new URL("../site/ui/styles/components.css", import.meta.url), "utf8");
const layoutCss = readFileSync(new URL("../ui/styles/layout.css", import.meta.url), "utf8");
const siteLayoutCss = readFileSync(new URL("../site/ui/styles/layout.css", import.meta.url), "utf8");

describe("mobile layout implementation", () => {
  it("adds compact task toolbar hooks so mobile controls can be laid out intentionally", () => {
    expect(tasksSource).toContain("tasks-filter-btn");
    expect(tasksSource).toContain("tasks-view-toggle");
    expect(tasksSource).toContain("tasks-toolbar-group--primary");
    expect(tasksSource).toContain("tasks-toolbar-group--secondary");
  });

  it("converts task list mode into stacked cards on narrow screens", () => {
    expect(componentsCss).toContain(".task-table thead");
    expect(componentsCss).toContain(".task-table tbody");
    expect(componentsCss).toContain('.task-td-title::before');
    expect(componentsCss).toContain('.task-td-updated::before');
  });

  it("tightens narrow header layout so the toolbar can shrink without overflow", () => {
    expect(layoutCss).toContain(".app-header-toolbar");
    expect(layoutCss).toContain(".app-header .MuiToolbar-root>*");
    expect(layoutCss).toContain(".app-breadcrumbs");
    expect(siteLayoutCss).toContain(".app-breadcrumbs");
    expect(siteLayoutCss).toContain("@media (max-width: 420px)");
    expect(siteLayoutCss).toContain(".app-header-status-stack");
  });

  it("keeps demo layout parity for tablet and desktop shell grids", () => {
    expect(siteLayoutCss).toContain(".app-tablet-grid");
    expect(siteLayoutCss).toContain(".app-desktop-grid");
    expect(siteLayoutCss).toContain(".inspector-collapse-btn");
    expect(siteLayoutCss).toContain('grid-template-areas: "sidebar main inspector"');
  });

  it("keeps mobile chat on the welcome surface instead of forcing the session drawer open", () => {
    expect(chatSource).toContain("const [drawerOpen, setDrawerOpen] = useState(false);");
    expect(chatSource).toContain('sessionId ? sessionTitle : "New chat"');
    expect(chatSource).toContain('Open sessions or start a new chat');
  });

  it("keeps mobile settings readable without a persistent clean-state overlay", () => {
    expect(settingsSource).toContain(".settings-mode-switch .MuiToggleButtonGroup-root");
    expect(settingsSource).toContain("settings-banner-path");
    expect(settingsSource).toContain("setting-input-wrap--secret");
    expect(settingsSource).toContain("InputAdornment");
    expect(settingsSource).toContain("(changeCount > 0 || restartCountdownSeconds != null)");
  });

  it("lets the demo auto-detect breakpoints unless an explicit layout override is requested", () => {
    expect(demoSource).toContain('window.__bosunForcedLayoutMode = "auto";');
    expect(siteDemoSource).toContain('window.__bosunForcedLayoutMode = "auto";');
    expect(demoSource).not.toContain('window.__bosunForcedLayoutMode = "desktop";');
    expect(siteDemoSource).not.toContain('window.__bosunForcedLayoutMode = "desktop";');
  });

  it("stretches the Pulse dashboard shell to the mobile content column", () => {
    expect(componentsCss).toContain(".dashboard-shell");
    expect(componentsCss).toContain("width: 100%;");
    expect(componentsCss).toContain("min-width: 0;");
    expect(componentsCss).toContain(".dashboard-header-meta");
    expect(componentsCss).toContain(".dashboard-chip-clock");
    expect(siteComponentsCss).toContain(".dashboard-header-meta");
    expect(siteComponentsCss).toContain("@media (max-width: 599px)");
    expect(siteComponentsCss).toContain(".dashboard-chip-clock");
  });
});
