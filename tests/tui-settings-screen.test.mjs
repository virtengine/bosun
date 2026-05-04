import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { waitFor } from "./tui/render-helpers.mjs";

async function loadSettingsScreenModules() {
  const [{ default: SettingsScreen }, { renderInk }] = await Promise.all([
    import("../ui/tui/SettingsScreen.js"),
    import("./tui/render-ink.mjs"),
  ]);
  return { SettingsScreen, renderInk };
}

function createConfigDir(config) {
  const dir = mkdtempSync(join(tmpdir(), "bosun-settings-"));
  const path = join(dir, "bosun.config.json");
  writeFileSync(path, JSON.stringify(config, null, 2));
  return { dir, path };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe.skip("tui settings screen (consolidated into tests/tui/settings-screen.test.mjs)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.KANBAN_BACKEND;
    delete process.env.TELEGRAM_UI_PORT;
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("renders grouped config fields with masked secrets and source labels", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "env-token";
    const { SettingsScreen, renderInk } = await loadSettingsScreenModules();

    const { dir } = createConfigDir({
      kanban: { backend: "github" },
      telegram: { uiPort: 3080, token: "config-token" },
      costRates: { inputPer1M: 1.5 },
    });

    const view = await renderInk(
      React.createElement(SettingsScreen, {
        configDir: dir,
        config: { kanban: { backend: "github" }, telegram: { uiPort: 3080, token: "config-token" }, costRates: { inputPer1M: 1.5 } },
      }),
      { columns: 220, rows: 60 },
    );

    const text = view.text();
    expect(text).toContain("General");
    expect(text).toContain("Kanban");
    expect(text).toContain("Integrations");
    expect(text).toContain("Cost Rates");
    expect(text).toContain("backend");
    expect(text).toContain("github");
    expect(text).toContain("from config");
    expect(text).toContain("from env");
    expect(text).toContain("****");
    expect(text).not.toContain("env-token");

    await view.unmount();
  });

  it("saves an edited enum field atomically and emits config reload", async () => {
    const { SettingsScreen, renderInk } = await loadSettingsScreenModules();
    const { dir, path } = createConfigDir({
      kanban: { backend: "internal" },
    });
    const emitReload = vi.fn();

    const view = await renderInk(
      React.createElement(SettingsScreen, {
        configDir: dir,
        config: { kanban: { backend: "internal" } },
        onConfigReload: emitReload,
      }),
      { columns: 220, rows: 60 },
    );

    await waitFor(() => view.text().includes("backend: internal"));
    await view.press("\r");
    await view.press("\u001b[C", 80);

    await waitFor(() => readJson(path).kanban.backend === "github");
    expect(readJson(path).kanban.backend).toBe("github");
    expect(emitReload).toHaveBeenCalledTimes(1);
    expect(emitReload).toHaveBeenCalledWith(expect.objectContaining({ configPath: path }));

    await view.unmount();
  });

  it("blocks invalid numeric edits and keeps the file unchanged", async () => {
    const { SettingsScreen, renderInk } = await loadSettingsScreenModules();
    const { dir, path } = createConfigDir({
      telegram: { uiPort: 3080 },
    });

    const view = await renderInk(
      React.createElement(SettingsScreen, {
        configDir: dir,
        config: { telegram: { uiPort: 3080 } },
      }),
      { columns: 220, rows: 60 },
    );

    await waitFor(() => view.text().includes("uiPort: 3080"));
    await view.press("j", 40);
    await view.press("\r");
    await view.press("999999999999", 40);
    await view.press("\u0013", 80);

    await waitFor(() => view.text().includes("Validation error"));
    expect(readJson(path).telegram.uiPort).toBe(3080);

    await view.unmount();
  });
});
