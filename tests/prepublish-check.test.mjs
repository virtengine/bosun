import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  expandPublishedFiles,
  findMissingPublishedFiles,
  findLocalImportSpecifiers,
  getRequiredHarnessRuntimeAssets,
  validatePublishedLocalImports,
} from "../tools/prepublish-check.mjs";

const tempDirs = [];

function createFixture(structure) {
  const root = mkdtempSync(resolve(tmpdir(), "bosun-prepublish-test-"));
  tempDirs.push(root);

  for (const [relativePath, content] of Object.entries(structure)) {
    const target = resolve(root, relativePath);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("prepublish-check", () => {
  it("parses nested relative imports including parent-directory imports", async () => {
    const source = [
      'import { a } from "./local.mjs";',
      'import "../side-effect.mjs";',
      'export { b } from "../shared/util.mjs";',
      'const c = await import("../dynamic.mjs");',
    ].join("\n");

    await expect(findLocalImportSpecifiers(source)).resolves.toEqual([
      "./local.mjs",
      "../side-effect.mjs",
      "../shared/util.mjs",
      "../dynamic.mjs",
    ]);
  });

  it("ignores import-like text in comments, strings, templates, and import.meta", async () => {
    const source = [
      '// import "./commented.mjs";',
      'const text = "export * from \'./string.mjs\'";',
      'const template = `import("./template.mjs") ${value}`;',
      'const url = import.meta.url;',
      'const dynamic = import(name);',
      'export * from "./kept.mjs";',
    ].join("\n");

    await expect(findLocalImportSpecifiers(source)).resolves.toEqual(["./kept.mjs"]);
  });

  it("expands directory entries from the published files manifest", () => {
    const root = createFixture({
      "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", files: ["infra"] }),
      "infra/monitor.mjs": "export const ok = true;",
      "infra/nested/helper.mjs": "export const helper = true;",
    });

    expect([...expandPublishedFiles(root, ["infra"])].sort()).toEqual([
      "infra/monitor.mjs",
      "infra/nested/helper.mjs",
    ]);
  });

  it("reports required published asset files that are missing from the manifest expansion", () => {
    const publishedFiles = new Set([
      "agent/skills/skill-codebase-audit.md",
      "agent/skills/pr-workflow.md",
    ]);

    expect(
      findMissingPublishedFiles(publishedFiles, [
        "agent/skills/background-task-execution.md",
        "agent/skills/pr-workflow.md",
        "agent/skills/background-task-execution.md",
      ]),
    ).toEqual([
      "agent/skills/background-task-execution.md",
      "agent/skills/background-task-execution.md",
    ]);
  });

  it("fails when a published module imports a non-published parent-relative file", async () => {
    const root = createFixture({
      "package.json": JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        files: ["infra/monitor.mjs"],
      }),
      "infra/monitor.mjs": 'import "../monitor-tail-sanitizer.mjs";\nexport const ok = true;',
      "monitor-tail-sanitizer.mjs": "export const sanitize = () => true;",
    });

    const pkg = JSON.parse(
      '{"name":"fixture","version":"1.0.0","files":["infra/monitor.mjs"]}',
    );
    const result = await validatePublishedLocalImports({ rootDir: root, pkg });

    expect(result.missing).toEqual([
      {
        file: "infra/monitor.mjs",
        imported: "../monitor-tail-sanitizer.mjs",
        resolved: "monitor-tail-sanitizer.mjs",
      },
    ]);
  });

  it("passes when the imported file is included in the published manifest", async () => {
    const root = createFixture({
      "package.json": JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        files: ["infra/monitor.mjs", "monitor-tail-sanitizer.mjs"],
      }),
      "infra/monitor.mjs": 'import "../monitor-tail-sanitizer.mjs";\nexport const ok = true;',
      "monitor-tail-sanitizer.mjs": "export const sanitize = () => true;",
    });

    const pkg = JSON.parse(
      '{"name":"fixture","version":"1.0.0","files":["infra/monitor.mjs","monitor-tail-sanitizer.mjs"]}',
    );
    const result = await validatePublishedLocalImports({ rootDir: root, pkg });

    expect(result.missing).toEqual([]);
  });

  it("publishes the builtin agent skills directory", () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
    expect(pkg.files).toContain("agent/skills/");
  });

  it("publishes newly added harness and workspace runtime dependencies", () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
    expect(pkg.files).toEqual(
      expect.arrayContaining([
        "agent/internal-harness-control-plane.mjs",
        "agent/internal-harness-profile.mjs",
        "agent/internal-harness-runtime.mjs",
        "infra/storage-janitor.mjs",
        "shell/auth-resolver.mjs",
        "shell/mcp-client.mjs",
        "shell/mcp-registry.mjs",
        "shell/provider-transform.mjs",
        "shell/session-resume.mjs",
        "shell/session-store.mjs",
        "shell/codex-sdk-import.mjs",
        "workspace/context-injector.mjs",
        "workspace/execution-journal.mjs",
        "workspace/scope-locks.mjs",
      ]),
    );
  });

  it("publishes the required step 9 shell shim and harness runtime assets", () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
    const publishedFiles = expandPublishedFiles(process.cwd(), pkg.files);

    expect(
      findMissingPublishedFiles(
        publishedFiles,
        getRequiredHarnessRuntimeAssets(process.cwd()),
      ),
    ).toEqual([]);
  });
});
