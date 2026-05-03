import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const indexSource = readFileSync(resolve(repoRoot, "ui", "index.html"), "utf8");
const appSource = readFileSync(resolve(repoRoot, "ui", "app.js"), "utf8");
const siteAppSource = readFileSync(resolve(repoRoot, "site", "ui", "app.js"), "utf8");
const lazyTasksImportPattern = /\(\)\s*=>\s*import\((["'])\.\/tabs\/tasks\.js\1\)/;
const lazyAgentsImportPattern = /\(\)\s*=>\s*import\((["'])\.\/tabs\/agents\.js\1\)/;

describe("ui index module boot", () => {
  it("registers the import map before booting app.js", () => {
    const importMapIndex = indexSource.indexOf('<script type="importmap">');
    const moduleBootIndex = indexSource.indexOf('<script type="module">');

    expect(importMapIndex).toBeGreaterThanOrEqual(0);
    expect(moduleBootIndex).toBeGreaterThan(importMapIndex);
    expect(
      indexSource.includes('import("/app.js")')
      || indexSource.includes('import(new URL("/app.js", window.location.origin).href)'),
    ).toBe(true);
  });

  it("does not preload or dynamically import the app entry before import maps exist", () => {
    expect(indexSource).not.toContain('<link rel="modulepreload" href="/app.js"');
    expect(indexSource).not.toContain('<link rel="modulepreload" href="/vendor/preact.js"');
    expect(indexSource).not.toContain('window.importShim(url)');
    expect(indexSource).not.toContain('return import(url)');
  });

  it("keeps lazy tab imports in module context instead of using indirect Function imports", () => {
    for (const source of [appSource, siteAppSource]) {
      expect(source).not.toContain('Function("u", "return import(u)")');
      expect(source).toContain('window.importShim(tabPath)');
      expect(source).toContain('nativeLoader()');
      expect(source).toMatch(lazyTasksImportPattern);
      expect(source).toMatch(lazyAgentsImportPattern);
      expect(source).toContain('resolveLazyTabComponent');
      expect(source).toContain('loader.key = `${tabPath}::${exportName || "default"}`');
    }
  });
});
