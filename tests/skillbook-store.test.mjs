import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  buildSkillbookProtocolMarkdown,
  listSkillbookStrategyProtocolsSync,
  loadSkillbookSync,
} from "../workspace/skillbook-store.mjs";

let repoRoot;

async function makeTempRepoRoot() {
  const dir = resolve(tmpdir(), `skillbook-store-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("skillbook-store sync protocol catalog", () => {
  beforeEach(async () => {
    repoRoot = await makeTempRepoRoot();
  });

  afterEach(async () => {
    if (repoRoot && existsSync(repoRoot)) {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("loads a skillbook synchronously from the repo cache file", () => {
    const skillbookDir = resolve(repoRoot, ".bosun", "skillbook");
    mkdirSync(skillbookDir, { recursive: true });
    writeFileSync(resolve(skillbookDir, "strategies.json"), JSON.stringify({
      version: "1.0.0",
      updatedAt: "2026-04-06T00:00:00.000Z",
      strategies: [
        {
          strategyId: "incident:rollback",
          recommendation: "Prefer rollback before adding new moving parts.",
          rationale: "Rollback usually restores service faster.",
          tags: ["incident", "rollback"],
          relatedPaths: ["ops/runbooks/incident.md"],
          confidence: 0.92,
          status: "promoted",
          updatedAt: "2026-04-06T00:00:00.000Z",
        },
      ],
    }, null, 2), "utf8");

    const skillbook = loadSkillbookSync({ repoRoot });
    expect(skillbook.strategies).toHaveLength(1);
    expect(skillbook.strategies[0].strategyId).toBe("incident:rollback");
  });

  it("maps promoted strategies into protocol-style catalog entries", () => {
    const skillbookDir = resolve(repoRoot, ".bosun", "skillbook");
    mkdirSync(skillbookDir, { recursive: true });
    writeFileSync(resolve(skillbookDir, "strategies.json"), JSON.stringify({
      version: "1.0.0",
      updatedAt: "2026-04-06T00:00:00.000Z",
      strategies: [
        {
          strategyId: "incident:rollback",
          recommendation: "Prefer rollback before adding new moving parts.",
          rationale: "Rollback usually restores service faster.",
          tags: ["incident", "rollback"],
          relatedPaths: ["ops/runbooks/incident.md"],
          confidence: 0.92,
          status: "promoted",
          updatedAt: "2026-04-06T00:00:00.000Z",
        },
      ],
    }, null, 2), "utf8");

    const protocols = listSkillbookStrategyProtocolsSync({ repoRoot });
    expect(protocols).toEqual([
      expect.objectContaining({
        strategyId: "incident:rollback",
        title: "Prefer rollback before adding new moving parts.",
        important: true,
        tags: expect.arrayContaining(["incident", "rollback"]),
      }),
    ]);
  });

  it("renders protocol entries into concise skill markdown", () => {
    const markdown = buildSkillbookProtocolMarkdown({
      strategyId: "incident:rollback",
      recommendation: "Prefer rollback before adding new moving parts.",
      rationale: "Rollback usually restores service faster.",
      tags: ["incident", "rollback"],
      relatedPaths: ["ops/runbooks/incident.md"],
      confidence: 0.92,
    });

    expect(markdown).toContain("# Skill: Prefer rollback before adding new moving parts.");
    expect(markdown).toContain("- Recommendation: Prefer rollback before adding new moving parts.");
    expect(markdown).toContain("- Rationale: Rollback usually restores service faster.");
    expect(markdown).toContain("- Related Paths: ops/runbooks/incident.md");
  });
});
