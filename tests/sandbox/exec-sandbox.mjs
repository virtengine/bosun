/**
 * tests/sandbox/exec-sandbox.mjs — Stateful gh/git CLI sandbox
 *
 * Provides a drop-in replacement for child_process.execSync that:
 *   1. Understands every gh CLI command pattern used by workflow-nodes.mjs
 *   2. Returns fixture-correct JSON, so nodes that JSON.parse() their output
 *      get real objects — not empty arrays or silent mismatches.
 *   3. Maintains a mutable state machine: gh issue close / gh pr merge / etc.
 *      mutate the in-memory state, which is reflected in subsequent calls.
 *   4. Records every invocation for post-run assertion.
 *   5. Supports chaos mode: inject transient errors to validate retry paths.
 *
 * Usage (inside a vitest vi.mock):
 *   import { createExecSandbox } from "./sandbox/exec-sandbox.mjs";
 *   const sandbox = createExecSandbox(myFixtureScenario);
 *   vi.mock("node:child_process", () => sandbox.buildMock());
 */

// ──────────────────────────────────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────────────────────────────────

function jsonOut(value) {
  return JSON.stringify(value ?? null);
}

function pick(obj, fields) {
  if (!fields) return obj;
  const wanted = typeof fields === "string"
    ? fields.split(",").map((f) => f.trim())
    : fields;
  if (!wanted.length) return obj;
  const result = {};
  for (const f of wanted) if (f in obj) result[f] = obj[f];
  return result;
}

/** Extract --json field-list from a gh command string */
function extractJsonFields(cmd) {
  const m = cmd.match(/--json\s+([A-Za-z0-9_,]+)/);
  return m ? m[1] : null;
}

/** Parse a numeric argument following a keyword, e.g. "issue view 42" → 42 */
function extractNumber(cmd, keyword) {
  const re = new RegExp(`${keyword}\\s+(\\d+)`);
  const m = cmd.match(re);
  return m ? Number(m[1]) : null;
}

/** Extract a flag value, e.g. --limit 100 */
function extractFlag(cmd, flag) {
  const re = new RegExp(`--${flag}\\s+(\\S+)`);
  const m = cmd.match(re);
  return m ? m[1] : null;
}

// ──────────────────────────────────────────────────────────────────────────
//  State machine
// ──────────────────────────────────────────────────────────────────────────

export function createExecSandbox(scenario = {}) {
  const { prs = [], issues = [], checks = [], releases = [], auditOutput } = scenario;

  // Mutable state — mutations are applied when write commands are dispatched
  const state = {
    prs:     new Map(prs.map((pr) => [pr.number, { ...pr }])),
    issues:  new Map(issues.map((i) => [i.number, { ...i }])),
    releases: releases.slice(),
    checks:  checks.slice(),
  };

  // Full invocation log for assertion use
  const calls = [];
  const record = (cmd) => calls.push({ cmd, ts: Date.now() });

  // ── Dispatcher ────────────────────────────────────────────────────────

  function dispatch(cmd) {
    record(cmd);
    const c = String(cmd || "").trim();
    const lower = c.toLowerCase();

    // ── git commands ──────────────────────────────────────────────────
    if (/^git\b/.test(lower)) return dispatchGit(c, lower);

    // ── gh commands ───────────────────────────────────────────────────
    if (/^gh\b/.test(lower)) return dispatchGh(c, lower);

    // ── npm / node build commands ─────────────────────────────────────
    if (/npm\s+(run\s+)?build/i.test(c))  return "build ok";
    if (/npm\s+(run\s+)?test/i.test(c))   return "tests ok";
    if (/npm\s+(run\s+)?lint/i.test(c))   return "lint ok";
    if (/npm\s+audit/i.test(c))           return auditOutput ?? '{"vulnerabilities":{},"metadata":{"vulnerabilities":{"critical":0,"high":0,"moderate":0,"low":0,"info":0,"total":0}}}';
    if (/npm\s+ci\b/i.test(c))            return "npm ci ok";
    if (/npx\s+playwright/i.test(c))      return "Version 1.42.0";
    if (/npx\s+eslint/i.test(c))          return "";
    if (/node\b/.test(lower))             return dispatchNode(c);

    // ── bosun CLI ─────────────────────────────────────────────────────
    if (/^bosun\b/.test(lower)) return dispatchBosun(c, lower);

    // ── generic shell utilities used by reliability templates ─────────
    if (/df\s+-h/i.test(c))   return "Filesystem  Size  Used Avail Use% Mounted on\n/dev/sda1   100G   40G   60G  40% /\n";
    if (/du\s+-sh/i.test(c))  return "2.0G\t.\n";
    if (/find\b/i.test(c))    return "";
    if (/grep\b/i.test(c))    return "";
    if (/cat\b|type\b/i.test(c)) return "";
    if (/ls\b|dir\b/i.test(c))   return "";

    return "";
  }

  // ── git ──────────────────────────────────────────────────────────────

  function dispatchGit(c, lower) {
    if (/git\s+rev-parse\s+HEAD/i.test(c))          return "abc1234567890abcdef1234567890abcdef12345678";
    if (/git\s+rev-parse\s+--abbrev-ref\s+HEAD/i.test(c)) return "feat/test-branch";
    if (/git\s+rev-parse\s+--verify/i.test(c))      return "abc1234";
    if (/git\s+status\b/i.test(c))                  return "nothing to commit, working tree clean";
    if (/git\s+fetch\b/i.test(c))                   return "";
    if (/git\s+pull\b/i.test(c))                    return "Already up to date.";
    if (/git\s+push\b/i.test(c))                    return "branch updated";
    if (/git\s+checkout\b/i.test(c))                return "Switched to branch";
    if (/git\s+switch\b/i.test(c))                  return "Switched to branch";
    if (/git\s+merge\b/i.test(c))                   return "Already up to date.";
    if (/git\s+rebase\b/i.test(c))                  return "Successfully rebased";
    if (/git\s+branch\b/i.test(c))                  return "* feat/test-branch\n  main\n";
    if (/git\s+log\b/i.test(c))                     return "abc1234 chore: test commit\ndef5678 fix: previous commit";
    if (/git\s+diff\s+--stat/i.test(c))             return "3 files changed, 42 insertions(+), 7 deletions(-)";
    if (/git\s+diff\s+--name-only/i.test(c))        return "src/feature.js\ntest/feature.test.js\nREADME.md";
    if (/git\s+diff\b/i.test(c))                    return "";
    if (/git\s+worktree\s+list/i.test(c))           return "worktree /workspace\nHEAD abc1234\nbranch refs/heads/main\n";
    if (/git\s+worktree\s+prune/i.test(c))          return "";
    if (/git\s+worktree\s+remove/i.test(c))         return "";
    if (/git\s+worktree\s+add/i.test(c))            return "Preparing worktree (new branch 'feat/test')";
    if (/git\s+stash\b/i.test(c))                   return "Saved working directory";
    if (/git\s+add\b/i.test(c))                     return "";
    if (/git\s+commit\b/i.test(c))                  return "[feat/test 1234abc] chore: test commit\n 3 files changed";
    if (/git\s+tag\b/i.test(c))                     return "v1.0.0\nv0.9.0\n";
    if (/git\s+show\b/i.test(c))                    return "commit abc1234\nAuthor: Dev User\nDate: 2026-01-01\n\nchore: test";
    if (/git\s+remote\b/i.test(c))                  return "origin\thttps://github.com/virtengine/bosun.git (fetch)";
    if (/git\s+config\b/i.test(c))                  return "virtengine";
    return "";
  }

  // ── gh CLI ───────────────────────────────────────────────────────────

  function dispatchGh(c, lower) {
    const fields = extractJsonFields(c);

    // ── gh pr ─────────────────────────────────────────────────────────
    if (/gh\s+pr\s+view\b/i.test(c)) {
      const n = extractNumber(c, "view") ?? extractNumber(c, "pr") ?? [...state.prs.keys()][0] ?? 42;
      const pr = state.prs.get(n) ?? makeFallbackPR(n);
      return jsonOut(fields ? pick(pr, fields) : pr);
    }

    if (/gh\s+pr\s+list\b/i.test(c)) {
      const list = [...state.prs.values()].filter((p) => p.state === "open" || /--state\s+all/i.test(c));
      return jsonOut(fields ? list.map((p) => pick(p, fields)) : list);
    }

    if (/gh\s+pr\s+checks\b/i.test(c)) {
      return jsonOut(state.checks.length ? state.checks : [
        { name: "ci/tests", state: "SUCCESS" },
        { name: "ci/lint",  state: "SUCCESS" },
      ]);
    }

    if (/gh\s+pr\s+merge\b/i.test(c)) {
      const n = extractNumber(c, "merge") ?? [...state.prs.keys()][0];
      if (n && state.prs.has(n)) {
        const pr = state.prs.get(n);
        pr.state = "merged"; pr.merged = true;
      }
      return "merged";
    }

    if (/gh\s+pr\s+close\b/i.test(c)) {
      const n = extractNumber(c, "close") ?? [...state.prs.keys()][0];
      if (n && state.prs.has(n)) state.prs.get(n).state = "closed";
      return "closed";
    }

    if (/gh\s+pr\s+create\b/i.test(c)) {
      return "https://github.com/virtengine/bosun/pull/999";
    }

    if (/gh\s+pr\s+review\b/i.test(c))  return "review submitted";
    if (/gh\s+pr\s+comment\b/i.test(c)) return "comment added";
    if (/gh\s+pr\s+edit\b/i.test(c))    return "pr updated";
    if (/gh\s+pr\s+ready\b/i.test(c))   return "pr marked ready";
    if (/gh\s+pr\s+draft\b/i.test(c))   return "pr marked draft";
    if (/gh\s+pr\s+reopen\b/i.test(c))  return "pr reopened";

    if (/gh\s+pr\b/i.test(c)) {
      // Catch-all for any other pr subcommand
      return jsonOut([...state.prs.values()]);
    }

    // ── gh issue ──────────────────────────────────────────────────────
    if (/gh\s+issue\s+view\b/i.test(c)) {
      const n = extractNumber(c, "view") ?? extractNumber(c, "issue") ?? [...state.issues.keys()][0] ?? 1;
      const issue = state.issues.get(n) ?? makeFallbackIssue(n);
      return jsonOut(fields ? pick(issue, fields) : issue);
    }

    if (/gh\s+issue\s+list\b/i.test(c)) {
      const all = [...state.issues.values()];
      const limit = Number(extractFlag(c, "limit") ?? "100");
      return jsonOut((fields ? all.map((i) => pick(i, fields)) : all).slice(0, limit));
    }

    if (/gh\s+issue\s+close\b/i.test(c)) {
      const n = extractNumber(c, "close") ?? [...state.issues.keys()][0];
      if (n && state.issues.has(n)) state.issues.get(n).state = "closed";
      return "closed";
    }

    if (/gh\s+issue\s+create\b/i.test(c))  return "https://github.com/virtengine/bosun/issues/1001";
    if (/gh\s+issue\s+comment\b/i.test(c)) return "comment added";
    if (/gh\s+issue\s+edit\b/i.test(c))    return "issue updated";
    if (/gh\s+issue\s+reopen\b/i.test(c))  return "issue reopened";

    if (/gh\s+issue\b/i.test(c)) {
      return jsonOut([...state.issues.values()]);
    }

    // ── gh release ────────────────────────────────────────────────────
    if (/gh\s+release\s+view\b/i.test(c)) {
      const rel = state.releases[0] ?? makeFallbackRelease();
      return jsonOut(fields ? pick(rel, fields) : rel);
    }

    if (/gh\s+release\s+list\b/i.test(c)) {
      return jsonOut(fields ? state.releases.map((r) => pick(r, fields)) : state.releases);
    }

    if (/gh\s+release\s+create\b/i.test(c)) {
      const tagMatch = c.match(/gh\s+release\s+create\s+(\S+)/);
      const tag = tagMatch?.[1] ?? "v0.0.1-test";
      const rel = makeFallbackRelease(tag);
      state.releases.unshift(rel);
      return `https://github.com/virtengine/bosun/releases/tag/${tag}`;
    }

    if (/gh\s+release\s+edit\b/i.test(c))   return "release updated";
    if (/gh\s+release\s+delete\b/i.test(c)) {
      if (state.releases.length) state.releases.shift();
      return "release deleted";
    }

    // ── gh run ────────────────────────────────────────────────────────
    if (/gh\s+run\s+list\b/i.test(c)) {
      return jsonOut([{ id: 12345, status: "completed", conclusion: "success", name: "CI", head_branch: "main" }]);
    }
    if (/gh\s+run\s+view\b/i.test(c)) {
      return jsonOut({ id: 12345, status: "completed", conclusion: "success", name: "CI" });
    }
    if (/gh\s+run\s+watch\b/i.test(c)) return "Run completed";

    // ── gh workflow ───────────────────────────────────────────────────
    if (/gh\s+workflow\b/i.test(c)) {
      return jsonOut([{ id: 1, name: "CI", state: "active" }]);
    }

    // ── gh label ─────────────────────────────────────────────────────
    if (/gh\s+label\b/i.test(c)) return "label ok";

    // ── gh repo ───────────────────────────────────────────────────────
    if (/gh\s+repo\s+view\b/i.test(c))   return jsonOut({ name: "bosun", owner: { login: "virtengine" }, defaultBranchRef: { name: "main" } });
    if (/gh\s+repo\s+clone\b/i.test(c))  return "Cloning into 'bosun'...";
    if (/gh\s+repo\s+create\b/i.test(c)) return "https://github.com/virtengine/bosun-sandbox";

    // ── gh api ────────────────────────────────────────────────────────
    if (/gh\s+api\b/i.test(c)) return dispatchGhApi(c);

    // ── gh secret ────────────────────────────────────────────────────
    if (/gh\s+secret\b/i.test(c)) return "secret updated";

    // ── gh auth ───────────────────────────────────────────────────────
    if (/gh\s+auth\s+status\b/i.test(c)) return "Logged in to github.com as dev-user";

    // Catch-all gh
    return "";
  }

  function dispatchGhApi(c) {
    if (/\/pulls\b/i.test(c))   return jsonOut([...state.prs.values()]);
    if (/\/issues\b/i.test(c))  return jsonOut([...state.issues.values()]);
    if (/\/releases\b/i.test(c)) return jsonOut(state.releases);
    if (/\/commits\b/i.test(c)) return jsonOut([{ sha: "abc1234", commit: { message: "chore: test" } }]);
    if (/\/branches\b/i.test(c)) return jsonOut([{ name: "main" }, { name: "feat/test-branch" }]);
    if (/\/check-runs\b/i.test(c)) return jsonOut({ check_runs: state.checks, total_count: state.checks.length });
    if (/\/compare\b/i.test(c))  return jsonOut({ ahead_by: 2, behind_by: 0, status: "ahead", commits: [] });
    return jsonOut({});
  }

  // ── node / bosun ──────────────────────────────────────────────────────

  function dispatchNode(c) {
    // Inline node -e scripts (worktree count etc.)
    if (/workflow-orphan-worktree-recovery\\.mjs/i.test(c)) {
      return JSON.stringify({
        success: true,
        scanned: 1,
        recovered: 1,
        skipped: 0,
        failed: 0,
        items: [
          {
            taskId: "TASK-1",
            branch: "ve/task-1-fix",
            prUrl: "https://github.com/virtengine/bosun/pull/999",
            prNumber: 999,
          },
        ],
        errors: [],
      });
    }
    if (/task-debt-ledger\.jsonl/i.test(c)) {
      const isoDaysAgo = (days) => new Date(Date.now() - (days * 86_400_000)).toISOString();
      return jsonOut([
        { timestamp: isoDaysAgo(2), debtDelta: 2, type: "added" },
        { timestamp: isoDaysAgo(9), debtDelta: -1, type: "resolved" },
      ]);
    }
    if (/worktree list/.test(c))  return "1\n";
    if (/worktree prune/.test(c)) return "1\n";
    // The release pipeline reads the new version with
    // `node -p "require('./package.json').version"`. The generic "0\n" fallback
    // below made `set-version` resolve to "0", which the template's
    // validate-version gate correctly refuses -- so the mock, not the gate, is
    // what turned the release-pipeline suites red.
    if (/package\.json/i.test(c) && /\.version/.test(c)) return "1.2.3\n";
    return "0\n";
  }

  function dispatchBosun(c, lower) {
    // doctor / config-doctor returns plain text so expression `.includes()` calls work
    if (/doctor\b/i.test(c))               return "Config check OK\nAll systems operational\nNo errors detected\n";
    if (/task\s+list\b/i.test(c))           return jsonOut([
      { id: "TASK-1", title: "Fix login bug", status: "todo", priority: "high" },
      { id: "TASK-2", title: "Add dark mode", status: "inprogress", priority: "medium" },
    ]);
    if (/task\s+create\b/i.test(c))         return jsonOut({ id: "TASK-NEW", title: "New task", status: "todo" });
    if (/task\s+get\b/i.test(c))            return jsonOut({ id: "TASK-1", title: "Fix login bug", status: "todo" });
    if (/task\s+update\b/i.test(c))         return jsonOut({ id: "TASK-1", updated: true });
    if (/task\s+stats\b/i.test(c))          return jsonOut({ todo: 2, inprogress: 1, done: 0, total: 3 });
    if (/agent\s+list\b/i.test(c))          return jsonOut([{ id: "agent-1", status: "idle" }]);
    if (/daemon-status\b/i.test(c))         return jsonOut({ running: true, uptime: 300 });
    return jsonOut({ ok: true });
  }

  // ── Fallback constructors (for unseen numbers) ────────────────────────

  function makeFallbackPR(n) {
    return {
      number: n, id: 200000 + n,
      title: `PR #${n}: Fixture (auto)`, body: "", state: "open",
      draft: false, html_url: `https://github.com/virtengine/bosun/pull/${n}`,
      head: { ref: `feat/pr-${n}`, sha: "abc1234" },
      base: { ref: "main", sha: "base1234" },
      user: { login: "dev-user" },
      labels: [], mergeable: "MERGEABLE", mergeable_state: "clean",
      merged: false, created_at: "2026-01-01T00:00:00Z",
      additions: 10, deletions: 2, changed_files: 1, commits: 1,
    };
  }

  function makeFallbackIssue(n) {
    return {
      number: n, id: 100000 + n, title: `Issue #${n}: Fixture (auto)`,
      body: "", state: "open", html_url: `https://github.com/virtengine/bosun/issues/${n}`,
      user: { login: "dev-user" }, labels: [], created_at: "2026-01-01T00:00:00Z",
    };
  }

  function makeFallbackRelease(tag = "v0.0.0") {
    return { id: 500000, tag_name: tag, name: tag, body: "", draft: false, prerelease: false,
      html_url: `https://github.com/virtengine/bosun/releases/tag/${tag}`,
      created_at: "2026-01-01T00:00:00Z", published_at: "2026-01-01T00:00:00Z" };
  }

  // ── Public API ────────────────────────────────────────────────────────

  return {
    /** The mock itself — call dispatch(cmd) */
    dispatch,

    /** All recorded invocations */
    get calls() { return calls; },

    /** Filter calls by pattern */
    callsMatching(pattern) {
      const re = typeof pattern === "string" ? new RegExp(pattern, "i") : pattern;
      return calls.filter((c) => re.test(c.cmd));
    },

    /** Current mutable state snapshot */
    get state() { return state; },

    /** Build the vi.mock-compatible node:child_process replacement */
    buildMock() {
      const self = this;
      return {
        execSync: (cmd, _opts) => self.dispatch(cmd),
        spawnSync: (cmd, args, _opts) => {
          const rendered = [String(cmd || "").trim(), ...(Array.isArray(args) ? args.map((arg) => String(arg)) : [])]
            .filter(Boolean)
            .join(" ")
            .trim();
          try {
            const output = String(self.dispatch(rendered) || "");
            return {
              stdout: Buffer.from(output),
              stderr: Buffer.from(""),
              status: 0,
              signal: null,
            };
          } catch (err) {
            return {
              stdout: Buffer.from(String(err?.stdout || "")),
              stderr: Buffer.from(String(err?.stderr || err?.message || err || "")),
              status: err?.status ?? err?.exitCode ?? 1,
              signal: null,
            };
          }
        },
        spawn: (cmd, args) => {
          const { EventEmitter } = require("node:events");
          const proc = new EventEmitter();
          proc.stdout = new EventEmitter();
          proc.stderr = new EventEmitter();
          proc.stdout.pipe = () => {};
          proc.stderr.pipe = () => {};
          proc.kill = () => {};
          proc.pid = 9999;
          setImmediate(() => {
            const rendered = [String(cmd || "").trim(), ...(Array.isArray(args) ? args.map((arg) => String(arg)) : [])]
              .filter(Boolean)
              .join(" ")
              .trim();
            try {
              const output = String(self.dispatch(rendered) || "");
              if (output) proc.stdout.emit("data", output);
              proc.emit("close", 0);
            } catch (err) {
              const stdout = String(err?.stdout || "");
              const stderr = String(err?.stderr || err?.message || err || "");
              if (stdout) proc.stdout.emit("data", stdout);
              if (stderr) proc.stderr.emit("data", stderr);
              proc.emit("close", err?.status ?? err?.exitCode ?? 1);
            }
          });
          return proc;
        },
        exec: (cmd, opts, cb) => {
          const callback = typeof opts === "function" ? opts : cb;
          const result = self.dispatch(cmd);
          if (callback) callback(null, String(result || ""), "");
          return { kill: () => {} };
        },
      };
    },
  };
}
