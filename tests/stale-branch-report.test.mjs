import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { testTimeout } from "./timeout-helper.mjs";

// Building a repo plus several pushes and a squash-merge is slower than a unit
// test. `hookTimeout` governs beforeAll, which builds the whole fixture; the
// default 10s is not enough on Windows where each git spawn costs ~1s.
vi.setConfig({
  testTimeout: testTimeout(60_000),
  hookTimeout: testTimeout(120_000),
});
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = fileURLToPath(new URL("../tools/stale-branch-report.mjs", import.meta.url));

/**
 * These tests build a REAL git repository and run the REAL tool against it.
 * The classification under test is `git cherry` semantics — a branch whose
 * commits were squash-merged upstream is only distinguishable by patch-id
 * equivalence, which a mocked `spawnSync` cannot faithfully reproduce (the
 * branch-cleanup test mocks git, and would pass against a wrong tool).
 */
function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function runTool(cwd, extraArgs = []) {
  const r = spawnSync(process.execPath, [TOOL, `--cwd=${cwd}`, ...extraArgs], {
    encoding: "utf8",
    windowsHide: true,
  });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

let repo;
let base;
let g; // scoped outside beforeAll: tests extend the fixture with more branches

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "stale-branch-report-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@e",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@e",
  };
  g = (...args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", env, stdio: ["pipe", "pipe", "pipe"] });

  g("init", "--initial-branch=develop", ".");
  g("config", "user.name", "t");
  g("config", "user.email", "t@e");
  g("commit", "--allow-empty", "-m", "base");
  base = g("rev-parse", "HEAD").toString().trim();

  // A real bare "remote" so origin/* are genuine remote-tracking refs.
  const bare = mkdtempSync(join(tmpdir(), "stale-branch-remote-"));
  process.env.__STALE_BARE__ = bare;
  execFileSync("git", ["init", "--bare", "--initial-branch=develop", bare], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  g("remote", "add", "origin", bare);
  g("push", "-q", "origin", "develop");

  const mk = (name, message) => {
    g("checkout", "-q", "-b", name, "develop");
    g("commit", "--allow-empty", "-m", message);
    g("push", "-q", "origin", name);
    g("checkout", "-q", "develop");
  };

  // (a) genuinely unlanded: its patch exists nowhere on develop.
  mk("wt/unlanded", "unlanded work");

  // (b) landed as a MULTI-COMMIT squash — the case `git cherry` cannot see.
  //     Three separate commits, landed as ONE squash commit, so no base commit
  //     shares any of their patch-ids and plain `git cherry` reports all three
  //     as unlanded. Content comparison must still call this landed.
  g("checkout", "-q", "-b", "tmp-landed", "develop");
  writeFileAndCommit(g, repo, "part one");
  writeFileAndCommit(g, repo, "part two");
  writeFileAndCommit(g, repo, "part three");
  g("push", "-q", "origin", "tmp-landed");
  g("checkout", "-q", "develop");
  g("merge", "-q", "--squash", "tmp-landed");
  g("commit", "-q", "-m", "feat: landed by squash");
  g("push", "-q", "origin", "develop");
  g("branch", "-q", "-D", "tmp-landed");
  base = g("rev-parse", "HEAD").toString().trim();

  // (c) a branch that is simply an ancestor of develop -> "merged".
  g("branch", "already-merged", base);
  g("push", "-q", "origin", "already-merged");

  // (d) gh-pages must never be reported.
  g("branch", "gh-pages", base);
  g("push", "-q", "origin", "gh-pages");

  // (e) SUPERSEDED — the real `docs/release-drift-record` shape. The branch's
  //     work lands verbatim, then a LATER commit on develop corrects the very
  //     lines the branch wrote. The branch's content is therefore NOT on the
  //     base any more: it differs precisely because the base is NEWER. This is
  //     the case that was filed as "genuine unlanded work" and would have been
  //     re-landed, reintroducing the corrections.
  //
  //     It uses its OWN file (claims.md), deliberately: writing to file.txt
  //     would also push the byte-identical branch tmp-landed into "superseded"
  //     and destroy the landed/superseded contrast the fixture exists to give.
  g("checkout", "-q", "-b", "docs/superseded", "develop");
  writeClaimsAndCommit(g, repo, "CLAIM THAT IS LATER CORRECTED");
  g("push", "-q", "origin", "docs/superseded");
  g("checkout", "-q", "develop");
  g("merge", "-q", "--squash", "docs/superseded");
  g("commit", "-q", "-m", "docs: land the claim");
  g("push", "-q", "origin", "develop");
  // ...and now develop corrects it, WITHOUT touching the branch ref.
  writeClaimsAndCommit(g, repo, "CORRECTED CLAIM (base moved past the branch)");
  g("push", "-q", "origin", "develop");
  base = g("rev-parse", "HEAD").toString().trim();

  git(repo, "fetch", "origin", "--prune");
});

function writeFileAndCommit(g, cwd, content) {
  writeFileSync(join(cwd, "file.txt"), content);
  g("add", "-A");
  g("commit", "-q", "-m", `add file: ${content}`);
}

function writeClaimsAndCommit(g, cwd, content) {
  writeFileSync(join(cwd, "claims.md"), content);
  g("add", "-A");
  g("commit", "-q", "-m", `write claims: ${content}`);
}

afterAll(() => {
  try {
    rmSync(repo, { recursive: true, force: true });
    if (process.env.__STALE_BARE__) rmSync(process.env.__STALE_BARE__, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("stale-branch-report", () => {
  it("reports the unlanded branch and exits 1", () => {
    const { status, stdout } = runTool(repo);
    expect(status).toBe(1);
    expect(stdout).toContain("wt/unlanded");
    expect(stdout).toContain("unlanded work");
  });

  it("classifies a squash-landed branch as landed, not unlanded", () => {
    const { stdout } = runTool(repo, ["--json"]);
    const parsed = JSON.parse(stdout.slice(stdout.indexOf("{")));
    expect(parsed.landed).toContain("tmp-landed");
    // The decisive assertion: patch-equivalent commits must not read as work.
    expect(parsed.needsTriage.map((b) => b.branch)).not.toContain("tmp-landed");
  });

  it("fixture really exercises the multi-commit-squash blind spot", () => {
    // Without this, the test above would also pass against a tool that only
    // implements `git cherry` — and would be decoration, because a
    // single-commit squash shares a patch-id and needs no content fallback.
    const cherry = git(repo, "cherry", "-v", "origin/develop", "origin/tmp-landed");
    expect(cherry.split("\n").filter((l) => l.startsWith("+")).length).toBe(3);
  });

  it("classifies an ancestor branch as merged", () => {
    const { stdout } = runTool(repo, ["--json"]);
    const parsed = JSON.parse(stdout.slice(stdout.indexOf("{")));
    const entry = parsed.branches.find((b) => b.branch === "already-merged");
    expect(entry.verdict).toBe("merged");
    expect(entry.ahead).toBe(0);
  });

  it("never reports gh-pages as rot", () => {
    const { stdout } = runTool(repo, ["--json"]);
    const parsed = JSON.parse(stdout.slice(stdout.indexOf("{")));
    expect(parsed.branches.map((b) => b.branch)).not.toContain("gh-pages");
    expect(parsed.needsTriage.map((b) => b.branch)).not.toContain("gh-pages");
  });

  it("fails closed (exit 2) on an unknown base rather than reporting clean", () => {
    const { status, stderr } = runTool(repo, ["--base=no-such-branch"]);
    expect(status).toBe(2);
    expect(stderr).toContain("does not exist");
  });

  it("fails closed (exit 2) outside a git repository", () => {
    const notRepo = mkdtempSync(join(tmpdir(), "stale-branch-notrepo-"));
    try {
      const { status } = runTool(notRepo, ["--base=develop"]);
      expect(status).toBe(2);
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });

  it("emits valid JSON on the failure path too", () => {
    const { stdout } = runTool(repo, ["--base=no-such-branch", "--json"]);
    const parsed = JSON.parse(stdout.slice(stdout.indexOf("{")));
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("does not exist");
  });

  it("never calls a no-content-delta branch landed, even when it is ahead", () => {
    // Regression: the content axis originally returned "no differences" for a
    // branch whose unique commits touch no files, which silently classified an
    // UNLANDED branch as landed. A detector that discards real work is worse
    // than one that over-reports, so this must fail toward triage.
    g("checkout", "-q", "-b", "wt/empty-delta", "develop");
    git(repo, "commit", "--allow-empty", "-m", "empty work");
    git(repo, "push", "-q", "origin", "wt/empty-delta");
    git(repo, "checkout", "-q", "develop");
    git(repo, "fetch", "origin", "--prune");

    const { stdout } = runTool(repo, ["--json"]);
    const parsed = JSON.parse(stdout.slice(stdout.indexOf("{")));
    const entry = parsed.branches.find((b) => b.branch === "wt/empty-delta");
    expect(entry.verdict).toBe("unlanded");
    expect(parsed.needsTriage.map((b) => b.branch)).toContain("wt/empty-delta");
    expect(parsed.landed).not.toContain("wt/empty-delta");
  });

  // --- superseded vs landed -------------------------------------------------
  // The defect these cover: the tool reported both states as "landed", and the
  // difference is the difference between "delete the ref" and "never re-land
  // this, it would undo a correction". Measured on this repo, 18 of 32 landed
  // branches were in the second state, and one of them (docs/release-drift-
  // record) was filed as unlanded work precisely because of it.

  it("reports a branch the base has since moved past as superseded, not landed", () => {
    const { stdout } = runTool(repo, ["--json"]);
    const parsed = JSON.parse(stdout.slice(stdout.indexOf("{")));
    const entry = parsed.branches.find((b) => b.branch === "docs/superseded");
    expect(entry.verdict).toBe("superseded");
    // Not conflated with "landed": the two carry opposite instructions.
    expect(parsed.landed).not.toContain("docs/superseded");
    expect(parsed.superseded).toContain("docs/superseded");
    // And still never work to land — the correction is the point.
    expect(parsed.needsTriage.map((b) => b.branch)).not.toContain("docs/superseded");
  });

  it("marks baseMovedPast only on the superseded side, never on landed or unlanded", () => {
    const { stdout } = runTool(repo, ["--json"]);
    const parsed = JSON.parse(stdout.slice(stdout.indexOf("{")));
    const sup = parsed.branches.find((b) => b.branch === "docs/superseded");
    expect(sup.baseMovedPast).toBe(true);
    // A byte-identical landed branch must NOT claim the base moved past it.
    const landed = parsed.branches.find((b) => b.verdict === "landed");
    expect(landed.baseMovedPast).toBe(false);
    // Nor may genuinely unlanded work — that would assert the base is newer on
    // the very paths the work is missing from.
    const unlanded = parsed.branches.find((b) => b.verdict === "unlanded");
    expect(unlanded.baseMovedPast).toBe(false);
  });

  it("the superseded fixture really is landed work that the base later corrected", () => {
    // Without this, the two tests above would pass against a tool that merely
    // labels things "superseded" — decoration. Prove the premise directly:
    // the branch's patch is on the base (`-`), and the base has since moved on.
    const cherry = git(repo, "cherry", "-v", "origin/develop", "origin/docs/superseded");
    expect(cherry.split("\n").filter((l) => l.startsWith("+")).length).toBe(0);
    // The branch's text is gone from the base; the correction replaced it.
    expect(git(repo, "show", "origin/develop:claims.md")).toContain("CORRECTED CLAIM");
    expect(git(repo, "show", "origin/docs/superseded:claims.md")).toContain("LATER CORRECTED");
  });

  it("warns in the human report that a superseded branch must not be re-landed", () => {
    const { stdout } = runTool(repo);
    expect(stdout).toContain("SUPERSEDED");
    expect(stdout).toContain("NEVER re-base or re-open");
  });

  it("never deletes or pushes: base ref is untouched after a full run", () => {
    const before = git(repo, "rev-parse", "origin/develop");
    const branchesBefore = git(repo, "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin");
    runTool(repo);
    expect(git(repo, "rev-parse", "origin/develop")).toBe(before);
    expect(git(repo, "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin")).toBe(
      branchesBefore,
    );
  });
});