import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * These tests EXECUTE the shell from `.github/workflows/publish.yaml`.
 *
 * The reason is the trap this file was written for. The publish path's two
 * real defects were not typos: one step's `if` took a branch that only echoed
 * (so the one step measuring npm/tag/release agreement could not fail), and
 * one step built a git tag by concatenating a value that reached it through a
 * shell expression. A test that greps the YAML for the right strings would pass
 * against both defects — the strings are all still there. So each test extracts
 * the step's real `run:` body out of the committed workflow and runs it under
 * bash with stub `git` / `gh` / `npm` on PATH, then grades the EXIT STATUS and
 * what the stubs were asked to do.
 *
 * Nothing here can reach the network, the real registry, or a real ref: `npm`,
 * `git` and `gh` are all shadowed by scripts in a temp dir.
 */

const WORKFLOW = resolve(import.meta.dirname, "..", ".github", "workflows", "publish.yaml");
const source = readFileSync(WORKFLOW, "utf8");

/**
 * Pull one step's `run:` body out of the workflow by step name.
 *
 * Deliberately a real reader rather than a `name:`+next-`run:` regex: the
 * ordering assertions below depend on WHICH step is which, so the extractor
 * itself is checked by `finds every step it is asked for` — an extractor that
 * returned the first `run:` block in the file for every name would pass every
 * behavioural test in this file while proving nothing.
 */
function stepBody(name) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  if (start === -1) throw new Error(`step not found in publish.yaml: ${name}`);
  // Walk forward to this step's own `run: |`, never past the next step.
  let runAt = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*- name: /.test(lines[i])) break;
    if (lines[i].trim() === "run: |") {
      runAt = i;
      break;
    }
  }
  if (runAt === -1) throw new Error(`step has no "run: |" body: ${name}`);

  // The body is every following line indented deeper than the `run:` key.
  const keyIndent = lines[runAt].search(/\S/);
  const body = [];
  for (let i = runAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    if (line.search(/\S/) <= keyIndent) break;
    body.push(line.slice(keyIndent + 2));
  }
  return body.join("\n");
}

/** Step names in file order, so the ordering assertions read the real order. */
function stepNames() {
  return [...source.matchAll(/^\s*- name: (.+)$/gm)].map((m) => m[1].trim());
}

/**
 * Run a step body under bash with `git`, `gh`, `npm` and `sleep` stubbed.
 *
 * The stubs have to be FAITHFUL, not convenient, or the test grades a fiction:
 * the first cut had every stub exit 0, so `git ls-remote --exit-code` reported
 * the tag as present, the workflow took its "already exists — leaving it
 * untouched" branch, and the test that asserts a tag IS created failed while
 * proving nothing about the tag. So:
 *   - `git ls-remote --exit-code --tags` exits 2 (not found) unless the test
 *     says the tag exists — that is what `--exit-code` means;
 *   - `gh release view` exits 1 (not found) unless the release exists;
 *   - `npm view` prints the stubbed version and exits 1 when there is none,
 *     which is what a failed lookup looks like to the script;
 *   - `sleep` is a no-op, because the verify step's bounded retry loop really
 *     does sleep (6 x 10s) and the suite has to stay runnable.
 *
 * Each stub appends its own argv to `$STUB_LOG`, one tab-joined line per call.
 */
function runStep(
  name,
  { version = "0.43.3", npmVersion = "0.43.3", existingTag = null, existingRelease = null, ...env } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "publish-step-"));
  const log = join(dir, "stub.log");
  writeFileSync(log, "");

  const stub = (name2, body) => {
    const path = join(dir, name2);
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`, "utf8");
    chmodSync(path, 0o755);
  };

  stub("git", `
printf 'git\\t%s\\n' "$*" >> "$STUB_LOG"
# \`--exit-code\` means "exit 2 when no match". The workflow relies on it to
# decide between creating the tag and leaving an existing one alone.
if [ "\${1:-}" = "ls-remote" ]; then
  if [ -n "$STUB_EXISTING_TAG" ]; then
    case "$*" in
      *"$STUB_EXISTING_TAG"*) echo "$STUB_EXISTING_TAG"; exit 0 ;;
    esac
  fi
  exit 2
fi
exit 0
`);
  stub("gh", `
printf 'gh\\t%s\\n' "$*" >> "$STUB_LOG"
# \`gh release view\` exits 1 when the release does not exist.
if [ "\${1:-}" = "release" ] && [ "\${2:-}" = "view" ]; then
  if [ -n "$STUB_EXISTING_RELEASE" ] && [ "$3" = "$STUB_EXISTING_RELEASE" ]; then
    exit 0
  fi
  exit 1
fi
exit 0
`);
  stub("npm", `
printf 'npm\\t%s\\n' "$*" >> "$STUB_LOG"
if [ "$1" = "view" ]; then
  if [ -z "$STUB_NPM_VERSION" ]; then
    echo "npm ERR! 404 Not Found" >&2
    exit 1
  fi
  printf '%s\\n' "$STUB_NPM_VERSION"
fi
exit 0
`);
  stub("sleep", `
printf 'sleep\\t%s\\n' "$*" >> "$STUB_LOG"
exit 0
`);

  // Substitute the one expression the workflow expands from another job's
  // output. The real value arrives via `env:`, which the workflows already
  // do for this step; the `${{ }}` form is only what a dry-run shell would
  // still contain.
  const body = stepBody(name)
    .replaceAll("${{ needs.check.outputs.local-version }}", version)
    .replaceAll("${{ inputs.dry-run }}", "false");

  const script = join(dir, "step.sh");
  writeFileSync(script, body, "utf8");

  const out = { status: 0, stdout: "", stderr: "", log: "" };
  try {
    out.stdout = execFileSync("bash", [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
        STUB_LOG: log,
        STUB_NPM_VERSION: npmVersion,
        STUB_EXISTING_TAG: existingTag ?? "",
        STUB_EXISTING_RELEASE: existingRelease ?? "",
        // The Actions runner is what expands `env:` on a step from another
        // job's output. Reproduce that here, or the step runs with an empty
        // EXPECTED_VERSION and every comparison silently mismatches — which is
        // exactly the shape of the bug these tests exist to catch, injected by
        // the harness instead.
        EXPECTED_VERSION: version,
        GITHUB_OUTPUT: join(dir, "github_output"),
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
  } catch (err) {
    out.status = err.status ?? 1;
    out.stdout = String(err.stdout ?? "");
    out.stderr = String(err.stderr ?? "");
  }
  out.log = readFileSync(log, "utf8");
  return out;
}

describe("publish.yaml — the extractor reads real steps", () => {
  it("finds every step it is asked for", () => {
    // Guards the whole file: if stepBody() ever returned the wrong block, the
    // behavioural tests below would be running someone else's script.
    for (const name of ["Tag release and create GitHub release", "Verify publication"]) {
      expect(stepBody(name), name).toContain(name === "Verify publication" ? "npm view" : "git tag");
    }
  });

  it("does not let one step's body bleed into the next", () => {
    // The verify step must not contain the tag step's `git tag`, and vice
    // versa — the extractor stops at the next `- name:`.
    expect(stepBody("Verify publication")).not.toContain("git tag");
    expect(stepBody("Tag release and create GitHub release")).not.toContain("npm view");
  });
});

describe("publish.yaml — step order (R4: verification must be able to fail safely)", () => {
  const names = stepNames();

  it("publishes to npm BEFORE creating the tag and release", () => {
    // npm publish is the one irreversible action. The tag/release step must not
    // precede it, or a failure there leaves npm ahead of its own record.
    expect(names.indexOf("Publish")).toBeLessThan(
      names.indexOf("Tag release and create GitHub release"),
    );
  });

  it("creates the tag and release BEFORE verifying the registry", () => {
    // THE ORDERING TRAP. If verification ran first and could exit non-zero, a
    // registry lag would abort the job before the tag and release existed —
    // creating exactly the npm/tag/release drift the workflow header promises
    // cannot happen. So the refs come first; a later failure is loud and
    // legible instead of silent.
    expect(names.indexOf("Tag release and create GitHub release")).toBeLessThan(
      names.indexOf("Verify publication"),
    );
  });
});

describe("publish.yaml — Verify publication can actually fail", () => {
  it("exits 0 when the registry shows the expected version", () => {
    const r = runStep("Verify publication", { version: "0.43.3", npmVersion: "0.43.3" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("Successfully published bosun@0.43.3");
  });

  it("exits NON-ZERO when the registry disagrees with what was published", () => {
    // The defect: this step's mismatch branch used to be a bare `echo` and the
    // step exited 0, so the one step measuring the workflow's core invariant
    // could not fail. A red run is the entire product of this test.
    const r = runStep("Verify publication", { version: "0.43.3", npmVersion: "0.43.2" });
    expect(r.status, r.stdout + r.stderr).not.toBe(0);
    expect(r.stdout).toMatch(/Registry shows 0\.43\.2/);
  });

  it("exits NON-ZERO when npm view fails outright (not just a version lag)", () => {
    const r = runStep("Verify publication", { version: "0.43.3", npmVersion: "" });
    expect(r.status, r.stdout + r.stderr).not.toBe(0);
    expect(r.stdout).toMatch(/NOT_FOUND/);
  });

  it("retries a lagging registry instead of failing on the first read", () => {
    // A publish that succeeded is usually visible within seconds; the registry
    // read replica can lag. One `sleep 10` used to be the entire patience
    // budget, so a 3-second lag read as permanent drift.
    const r = runStep("Verify publication", { version: "0.43.3", npmVersion: "0.43.3" });
    const views = r.log.split("\n").filter((l) => l.startsWith("npm\tview")).length;
    expect(views).toBe(1);
    expect(r.status).toBe(0);
  });

  it("retries a bounded number of times, then gives up loudly", () => {
    // The retry must be BOUNDED: an unbounded loop would hang the job forever
    // on a registry that never converges. `sleep` is stubbed, so this measures
    // the loop's arity, not its wall time.
    const r = runStep("Verify publication", { version: "0.43.3", npmVersion: "0.43.2" });
    const views = r.log.split("\n").filter((l) => l.startsWith("npm\tview")).length;
    expect(views).toBe(6);
    expect(r.status, r.stdout + r.stderr).not.toBe(0);
  });

  it("reports the observed and expected versions, so the red run is legible", () => {
    const r = runStep("Verify publication", { version: "0.43.3", npmVersion: "0.42.0" });
    expect(r.stdout).toContain("0.42.0");
    expect(r.stdout).toContain("0.43.3");
    // The tag for the expected version was NOT created by this step, so the
    // message must point at the record that does exist rather than implying the
    // refs are missing.
    expect(r.stdout).toMatch(/::error::/);
  });

  it("takes the expected version from env, not from an inline expression", () => {
    // `${{ }}` is expanded by the Actions runner before bash ever sees the
    // script, so a value carrying shell metacharacters would be interpolated
    // into the command text rather than passed as data. `env:` is the safe form
    // and the step must use it — this is a static property of the committed
    // file, checked here so it cannot be regressed silently.
    const body = stepBody("Verify publication");
    expect(body).not.toContain("${{ needs.check.outputs.local-version }}");
    expect(source).toMatch(/EXPECTED_VERSION: \$\{\{ needs\.check\.outputs\.local-version \}\}/);
  });
});

describe("publish.yaml — the release tag is built from a validated version (R3)", () => {
  it("creates the tag and release for a well-formed version", () => {
    const r = runStep("Tag release and create GitHub release", { version: "0.43.3" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.log).toMatch(/git\ttag -a v0\.43\.3/);
    expect(r.log).toMatch(/git\tpush origin refs\/tags\/v0\.43\.3/);
    expect(r.log).toMatch(/gh\trelease create v0\.43\.3/);
  });

  it.each([
    ["v0.44.0", "vv0.44.0"],
    ["0.44", "v0.44"],
    ["bogus", "vbogus"],
    ["0.44.0 && echo pwned", "shell injection"],
    ["0.43.3 ", "trailing space"],
  ])("refuses to create any ref for local version %j", (version) => {
    // `npm publish --dry-run` ACCEPTS `v0.44.0` (verified against the real
    // registry tooling, rc=0), so there is no backstop between the gate and
    // `git tag`. Without this check, that typo produced the remote tag
    // `vv0.44.0` — a published, effectively-immutable ref nothing ever cleans
    // up. The fix in the gate refuses it upstream; this refuses it at the last
    // point before the ref exists, so a future path into the step cannot.
    const r = runStep("Tag release and create GitHub release", { version });
    expect(r.status, `version=${version}\n${r.stdout}${r.stderr}`).not.toBe(0);
    expect(r.log, `version=${version} must not reach git`).not.toContain("git\ttag");
    expect(r.log, `version=${version} must not reach git`).not.toContain("git\tpush");
    expect(r.log, `version=${version} must not reach gh`).not.toContain("release create");
  });

  it("accepts a prerelease version, which is valid semver", () => {
    // The guard must not over-tighten: `0.43.3-beta.1` is a real version and
    // the gate explicitly supports publishing one.
    const r = runStep("Tag release and create GitHub release", { version: "0.43.3-beta.1" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.log).toMatch(/git\ttag -a v0\.43\.3-beta\.1/);
  });

  it("leaves an existing tag and release untouched (idempotence preserved)", () => {
    // The step is documented as idempotent, and the verify step's failure path
    // tells the operator to re-run the job. That advice is only safe if a
    // re-run cannot re-tag or duplicate a release — so the guard must not have
    // disturbed this behaviour.
    const r = runStep("Tag release and create GitHub release", {
      version: "0.43.3",
      existingTag: "v0.43.3",
      existingRelease: "v0.43.3",
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.log).not.toContain("git\ttag");
    expect(r.log).not.toContain("git\tpush");
    expect(r.log).not.toContain("release create");
    expect(r.stdout).toContain("already exists");
  });
});
