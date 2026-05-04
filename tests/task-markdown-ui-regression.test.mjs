import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const uiMarkdown = await import("../ui/components/task-markdown.js");
const siteMarkdown = await import("../site/ui/components/task-markdown.js");

const taskSources = [
  "ui/tabs/tasks.js",
  "site/ui/tabs/tasks.js",
].map((relPath) => ({
  relPath,
  source: readFileSync(resolve(process.cwd(), relPath), "utf8"),
}));

describe("task markdown integration", () => {
  it("exports reusable markdown editor and viewer helpers for both UI trees", () => {
    expect(typeof uiMarkdown.MarkdownTaskEditor).toBe("function");
    expect(typeof uiMarkdown.MarkdownTaskViewer).toBe("function");
    expect(typeof siteMarkdown.MarkdownTaskEditor).toBe("function");
    expect(typeof siteMarkdown.MarkdownTaskViewer).toBe("function");
  });

  for (const { relPath, source } of taskSources) {
    it(`wires markdown editor and viewer into ${relPath}`, () => {
      expect(source).toContain("MarkdownTaskEditor");
      expect(source).toContain("MarkdownTaskViewer");
      expect(source).toContain("task-markdown-toolbar");
      expect(source).toContain("Rich Markdown supported.");
    });
  }
});
