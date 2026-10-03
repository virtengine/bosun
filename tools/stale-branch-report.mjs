#!/usr/bin/env node
/**
 * stale-branch-report — classify remote branches that are no longer merged into
 * the base branch, so branch rot is visible instead of discovered by hand.
 *
 * Usage: node tools/stale-branch-report.mjs [--base=develop] [--remote=origin]
 *                                           [--cwd=<repo>] [--json]
 *
 * Why this exists: `infra/maintenance.mjs::cleanupStaleBranches` only targets
 * `ve/*` and `copilot-worktree-*` LOCAL branches. Branches created by Bosun's own
 * dispatcher (`wt/*`, `test/*`, `fix/*`) and every REMOTE branch are invisible to
 * it, so they accumulate on the remote indefinitely. This tool is the detector.
 *
 * It is deliberately REPORT-ONLY. Deleting a remote ref is destructive and
 * needs human sign-off, so the tool never deletes anything and never pushes.
 *
 * Exit codes:
 *   0  no unmerged branches (clean)
 *   1  one or more unmerged branches need triage (the actionable case)
 *   2  could not read the repository (git missing, not a repo, bad ref)
 */
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const jsonMode = argv.includes("--json");

const base = flag("base", "develop");
const remote = flag("remote", "origin");
const cwd = flag("cwd", process.cwd());

/** Run git, returning trimmed stdout. Throws with git's own stderr on failure. */
function git(...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/**
 * Verify a ref exists before using it as a range endpoint. Without this an
 * unknown `--base` yields an empty branch list and the tool reports CLEAN,
 * which is the worst possible failure direction for a hygiene detector.
 */
function refExists(ref) {
  try {
    git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

if (!refExists(`${remote}/${base}`)) {
  const msg = `stale-branch-report: ${remote}/${base} does not exist (fetch first: git fetch ${remote} --prune)`;
  if (jsonMode) {
    console.log(JSON.stringify({ ok: false, error: msg, base, remote }, null, 2));
  } else {
    console.error(msg);
  }
  process.exit(2);
}

// Branches that legitimately diverge from the base branch.
const ALWAYS_IGNORE = new Set([
  `${remote}/HEAD`,
  `${remote}/${base}`,
  // Pages deployments are not merge candidates; treating them as rot is noise.
  `${remote}/gh-pages`,
  `${remote}/pages`,
]);

/**
 * `git cherry <upstream> <head>` prints one line per commit unique to <head>,
 * prefixed `+` (not patch-equivalent to anything upstream) or `-` (an
 * equivalent patch is already upstream). A branch whose every unique commit is
 * `-` was squash-merged or re-landed: its content is on the base and the ref is
 * dead weight. A branch with any `+` still carries work nobody has landed.
 *
 * `git cherry` is NOT sufficient on its own: it matches by patch-id, one commit
 * to one commit. When N branch commits are landed as a SINGLE squash commit,
 * no base commit shares any of their patch-ids and all N read as `+` — so a
 * branch whose content is verifiably on the base is reported as unlanded work.
 * That is measured on this repo: the Requesty driver landed as #532 (a squash
 * of 3 commits) and `git cherry` still reports all 3 as `+`.
 *
 * So the verdict is decided on CONTENT, with `git cherry` used only to name the
 * commits: if every path the branch touched resolves to identical content on the
 * base, the branch is landed regardless of how the work was merged.
 */
function touchedPathsContentDiffers(branchRef, ahead) {
  // Paths the branch changed relative to the merge-base with the base.
  const paths = git("diff", "--name-only", `${remote}/${base}...${branchRef}`)
    .split("\n")
    .filter(Boolean);
  // No touched paths while the branch is still ahead means its unique commits
  // carry no content delta (empty commits, or commits whose effect was already
  // applied). There is nothing to verify against the base, so this must NOT be
  // read as "landed" — doing so silently discards a branch that has commits
  // nobody landed. Report it for triage instead.
  if (paths.length === 0) return { differs: ahead > 0, paths, unverifiable: true };
  // Compare the branch tree to the base tree directly, restricted to those paths.
  // `--quiet` exits 0 when identical; execFileSync throws on a difference.
  let differs = false;
  try {
    execFileSync("git", ["diff", "--quiet", `${remote}/${base}`, branchRef, "--", ...paths], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    });
  } catch {
    differs = true; // exit 1 => differences present
  }
  return { differs, paths, unverifiable: false };
}

function classify(branchRef) {
  const ahead = Number(git("rev-list", "--count", `${remote}/${base}..${branchRef}`));
  const behind = Number(git("rev-list", "--count", `${branchRef}..${remote}/${base}`));
  const lastCommit = git("log", "-1", "--format=%cs", branchRef);
  // `-v` appends the subject; without it `git cherry` emits only "+ <sha>", so
  // the triage report would print bare hashes instead of what the work is.
  const cherry = git("cherry", "-v", `${remote}/${base}`, branchRef)
    .split("\n")
    .filter(Boolean);
  const unlanded = cherry.filter((l) => l.startsWith("+")).length;
  const subjects = cherry
    .filter((l) => l.startsWith("+"))
    .map((l) => l.slice(2).trim())
    .slice(0, 5);
  const content = touchedPathsContentDiffers(branchRef, ahead);
  // Two states are both "landed" but mean OPPOSITE things to a reader, and
  // conflating them is how a landed branch gets mistaken for unlanded work:
  //
  //   landed     — the branch's content is byte-identical on the base. The ref is
  //                pure dead weight; deleting it loses nothing.
  //   superseded — the branch's work IS on the base, but the base has since moved
  //                PAST it (a later commit corrected or extended the same lines).
  //                Content differs precisely BECAUSE the base is newer. Deleting
  //                the ref still loses nothing, but re-basing or re-opening it
  //                would REGRESS the base to the older, corrected text.
  //
  // Measured on this repo: 18 of 32 "landed" branches are superseded, and for
  // several the base difference IS a correction. `docs/release-drift-record` is
  // the sharpest case: its single commit landed verbatim as #550, then #551
  // deliberately corrected three false claims #550 had introduced. Re-basing
  // that branch to "land" the decision record would reinstate exactly those
  // false claims — which is what kanban t_ac723e68 asked for.
  const landedByContent = content.differs === false;
  const landed =
    cherry.length === 0
      ? "merged"
      : unlanded === 0 || landedByContent
        ? landedByContent
          ? "landed"
          : "superseded"
        : "unlanded";
  return {
    branch: branchRef.replace(`${remote}/`, ""),
    ahead,
    behind,
    lastCommit,
    unlandedCommits: unlanded,
    landedByEquivalentPatch: cherry.length > 0 && unlanded === 0,
    contentDiffersFromBase: content.differs,
    // True only when the branch's work IS on the base AND the base is strictly
    // newer on those paths. This is the field a triage reader must not skip:
    // it is the difference between "delete the ref" and "never re-land this".
    baseMovedPast: !landedByContent && (unlanded === 0 || cherry.length === 0),
    unlandedSubjects: subjects,
    verdict: landed,
  };
}

let branches;
try {
  branches = git("for-each-ref", "--format=%(refname:short)", `refs/remotes/${remote}`)
    .split("\n")
    .filter(Boolean)
    .filter((b) => !ALWAYS_IGNORE.has(b));
} catch (err) {
  const msg = `stale-branch-report: cannot list remote branches: ${err.message}`;
  if (jsonMode) {
    console.log(JSON.stringify({ ok: false, error: msg, base, remote }, null, 2));
  } else {
    console.error(msg);
  }
  process.exit(2);
}

const report = [];
for (const ref of branches) {
  try {
    report.push(classify(ref));
  } catch (err) {
    report.push({ branch: ref.replace(`${remote}/`, ""), verdict: "error", error: err.message });
  }
}

report.sort(
  (a, b) =>
    (a.lastCommit || "").localeCompare(b.lastCommit || "") ||
    a.branch.localeCompare(b.branch),
);

const needsTriage = report.filter(
  (r) => r.verdict === "unlanded" || r.verdict === "error",
);
const landed = report.filter((r) => r.verdict === "landed");
const superseded = report.filter((r) => r.verdict === "superseded");

const summary = {
  ok: true,
  base,
  remote,
  totalBranches: report.length,
  landed: landed.map((r) => r.branch),
  superseded: superseded.map((r) => r.branch),
  needsTriage,
  branches: report,
};

if (jsonMode) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`stale-branch-report: ${report.length} remote branches vs ${remote}/${base}`);
  if (landed.length) {
    console.log(`\n  LANDED (${landed.length}) — content byte-identical on base, safe to delete after review:`);
    for (const r of landed) {
      console.log(`    ${r.branch}  (${r.ahead} commit(s), last ${r.lastCommit})`);
    }
  }
  if (superseded.length) {
    console.log(
      `\n  SUPERSEDED (${superseded.length}) — work IS on base, but base has since moved PAST it:`,
    );
    for (const r of superseded) {
      console.log(`    ${r.branch}  (${r.ahead} commit(s), last ${r.lastCommit})`);
    }
    console.log(
      "    These differ from base only because a LATER commit corrected or extended",
    );
    console.log(
      "    the same lines. Safe to delete the ref; NEVER re-base or re-open them, or",
    );
    console.log("    you regress the base to the older, superseded text.");
  }
  if (needsTriage.length) {
    console.log(`\n  NEEDS TRIAGE (${needsTriage.length}) — carries unlanded work:`);
    for (const r of needsTriage) {
      if (r.verdict === "error") {
        console.log(`    ${r.branch}  ERROR: ${r.error}`);
        continue;
      }
      console.log(
        `    ${r.branch}  (${r.unlandedCommits} unlanded, last ${r.lastCommit}, ${r.behind} behind)`,
      );
      for (const s of r.unlandedSubjects) console.log(`        - ${s.slice(0, 100)}`);
    }
  }
  console.log("\n  (report only — this tool never deletes or pushes)");
}

process.exit(needsTriage.length > 0 ? 1 : 0);