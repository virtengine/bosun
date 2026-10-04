#!/usr/bin/env node
// Falsifier: proves tests/release-tag-discovery.test.mjs can SEE the defect.
// Runs the SHIPPED suite against the PRE-FIX template bytes (from origin/develop)
// in an isolated tree, and requires it to go RED for the right reason.
// Also runs two controls: the no-op control must stay GREEN (a guard that fails
// on everything proves nothing), and a drop-the-fallback mutation must be caught.
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (args) =>
  execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });

const TEMPLATE_FILES = [
  "workflow-templates/github.mjs",
  "workflow-templates/ci-cd.mjs",
];

function makeTree(prefix, { preFixTemplates = false } = {}) {
  // Inside the repo's own .worktrees/ so Node/Vitest module resolution walks UP
  // to the shared node_modules — a tree under %TEMP% has no vitest to run, and
  // the resulting MODULE_NOT_FOUND would masquerade as a RED verdict.
  const dir = mkdtempSync(join(REPO, prefix));
  // Isolate the tree, then (when asked) overwrite the TEMPLATES with their
  // pre-fix bytes read straight out of git (`git show`, never `git stash`,
  // never a local edit). Default is the SHIPPED/FIXED templates — which is what
  // the controls must run against, or a control can never be GREEN.
  for (const entry of readdirSync(REPO, { withFileTypes: true })) {
    // Skip the tree's own scaffolding AND any sibling falsifier tree — the copy
    // loop must never enumerate a directory that lives inside REPO, or it
    // recurses into itself.
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".worktrees") continue;
    if (entry.name.startsWith("falsify-")) continue;
    cpSync(join(REPO, entry.name), join(dir, entry.name), { recursive: true, dereference: false });
  }
  if (preFixTemplates) {
    for (const rel of TEMPLATE_FILES) {
      writeFileSync(join(dir, rel), git(["show", `origin/develop:${rel}`]));
    }
  }
  return dir;
}

/** Walk up from `from` looking for a vitest install — mirrors Node's own resolution. */
function resolveVitest(from) {
  let cur = from;
  for (;;) {
    const cand = join(cur, "node_modules", "vitest", "package.json");
    if (existsSync(cand)) {
      const pkg = JSON.parse(readFileSync(cand, "utf8"));
      return join(cur, "node_modules", "vitest", pkg.bin.vitest);
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function runSuite(dir) {
  // Resolve vitest by walking UP from the temp tree, never a hardcoded inner
  // path: a wrong entry path yields MODULE_NOT_FOUND, which would be recorded
  // as a RED verdict — a false CAUGHT, the one direction that matters here.
  const vitestEntry = resolveVitest(dir) ?? resolveVitest(REPO);
  if (!vitestEntry || !existsSync(vitestEntry)) {
    throw new Error(`harness error: vitest entry not found from ${dir}`);
  }
  try {
    const out = execFileSync(
      process.execPath,
      [vitestEntry, "run", "tests/release-tag-discovery.test.mjs"],
      { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 },
    );
    return { rc: 0, out };
  } catch (e) {
    if (/MODULE_NOT_FOUND|Cannot find module/.test(`${e.stderr ?? ""}`)) {
      throw new Error("harness error, not a verdict: vitest could not load");
    }
    return { rc: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const results = [];
function record(name, expectRed, got, mustMention) {
  const red = got.rc !== 0;
  const ok = expectRed ? red && (!mustMention || got.out.includes(mustMention)) : !red;
  results.push({ name, ok, expectRed, rc: got.rc });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} (expect ${expectRed ? "RED" : "GREEN"}, got rc=${got.rc})`);
  if (!ok) console.log(got.out.slice(-2500));
}

// M0 — the PRE-FIX bytes must be RED, naming the unconstrained invocation.
{
  const dir = makeTree("falsify-prefix-", { preFixTemplates: true });
  try {
    const g = join(dir, "workflow-templates", "github.mjs");
    const src = readFileSync(g, "utf8");
    // Precondition on the ISOLATED tree, not the live checkout: makeTree
    // installed origin/develop's bytes, so this asserts the falsifier is
    // really testing the old product rather than silently testing the fix.
    if (src.includes("--match '{{releasePrefix}}[0-9]*'")) {
      throw new Error("isolated tree is not pre-fix; aborting falsification");
    }
    const got = runSuite(dir);
    record("M0 pre-fix bytes are RED", true, got, "constrains every git describe");
    console.log("  -> failure names:", /constrains every git describe[^\n]*/.exec(got.out)?.[0] ?? "(guard name absent)");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// CONTROL 1 — no-op mutation (add a comment) must stay GREEN.
{
  const dir = makeTree("falsify-noop-");
  try {
    const p = join(dir, "workflow-templates", "github.mjs");
    writeFileSync(p, readFileSync(p, "utf8") + "\n// falsifier no-op control\n");
    record("CONTROL no-op stays GREEN", false, runSuite(dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// M1 — drop the fallback while keeping --match: must be RED (fail-open detection).
{
  const dir = makeTree("falsify-nofallback-");
  try {
    const p = join(dir, "workflow-templates", "github.mjs");
    const src = readFileSync(p, "utf8");
    // Anchor on the fallback and remove it ENTIRELY, keeping --match. If the
    // anchor is not found the mutation is INERT, so assert it — a silently
    // unapplied mutation would read as a false GREEN. Note the removal must
    // take the whole clause (`${LAST_TAG:-HEAD~50}` plus the wrapping guard),
    // because a bare literal HEAD~50 left in the line would still be a fallback.
    const anchor = "${LAST_TAG:-HEAD~50}";
    if (!src.includes(anchor)) throw new Error("M1 anchor not found — mutation would be inert");
    writeFileSync(p, src.replace(anchor, "HEAD"));
    const after = readFileSync(p, "utf8");
    if (!/git describe --tags --abbrev=0 --match/.test(after)) {
      throw new Error("M1 removed the --match too — testing the wrong thing");
    }
    if (/HEAD~50/.test(after)) {
      throw new Error("M1 left a HEAD~50 fallback — mutation did not remove it");
    }
    record("M1 describe without fallback is RED", true, runSuite(dir), "keeps a fallback");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} as designed`);
process.exit(failed.length ? 1 : 0);