import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("workflow canvas draft flowchart UI", () => {
  const uiSource = readFileSync(resolve(process.cwd(), "ui/tabs/workflows.js"), "utf8");
  const siteSource = readFileSync(resolve(process.cwd(), "site/ui/tabs/workflows.js"), "utf8");

  for (const [label, source] of [
    ["ui", uiSource],
    ["site", siteSource],
  ]) {
    it(`${label} exposes the draft flowchart panel and linked runtime node copy`, () => {
      expect(source).toContain("Draft Flowchart");
      expect(source).toContain("Flowchart Map keeps the design view linked to built runtime nodes");
      expect(source).toContain("buildDraftFlowchartMap");
      expect(source).toContain("runtime node");
      expect(source).toContain("Flowchart Links");
    });
  }
});
