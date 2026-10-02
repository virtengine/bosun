/**
 * release-pipeline-tag-gate.test.mjs — the release-pipeline template must not be
 * able to create a malformed git tag.
 *
 * Background: `workflow-templates/ci-cd.mjs` builds its release tag by string
 * concatenation (`"v" + version`). Before this gate, a failed `read-version`
 * command resolved `version` to `""` and the pipeline pushed the tag `v` — a
 * real, permanent, malformed tag on the remote (exactly the `refs/tags/v` that
 * had to be deleted by hand on virtengine/bosun). Nothing on the path refused
 * it: `npm publish --dry-run` accepts `v0.44.0` (rc=0), and `action.run_command`
 * only throws when `failOnError` is set.
 *
 * These tests drive the REAL template through the REAL engine node types. They
 * deliberately do not re-implement the gate: a test that evaluated a copy of
 * the expression would pass whether or not the shipped template were correct.
 */
import { describe, expect, it } from "vitest";

import { RELEASE_PIPELINE_TEMPLATE } from "../workflow-templates/ci-cd.mjs";
import { getNodeType } from "../workflow/workflow-engine.mjs";
import "../workflow/workflow-nodes/actions.mjs";
import "../workflow/workflow-nodes/conditions.mjs";

const NODES = new Map(
  RELEASE_PIPELINE_TEMPLATE.nodes.map((n) => [n.id, n]),
);
const EDGES = RELEASE_PIPELINE_TEMPLATE.edges;

/**
 * Minimal context matching what the engine hands a node executor: `resolve`
 * for `{{token}}` substitution, `nodeOutputs`, `data`, and `log`.
 */
function makeCtx({ version, readVersionOutput } = {}) {
  const data = {};
  if (version !== undefined) data.version = version;
  const nodeOutputs = new Map();
  if (readVersionOutput !== undefined) {
    nodeOutputs.set("read-version", { output: readVersionOutput, success: true });
  }
  return {
    data,
    nodeOutputs,
    id: "test-run",
    resolve: (token) => {
      const match = /^\{\{([^}]+)\}\}$/.exec(String(token));
      const key = match?.[1];
      if (key === "version") return data.version;
      return token;
    },
    log: () => {},
    setNodeOutput: () => {},
    getNodeOutput: (id) => nodeOutputs.get(id),
    getRetryCount: () => 0,
  };
}

/** Run `set-version` then `validate-version` exactly as the engine would. */
async function resolveTemplateVersion(readVersionOutput) {
  const setNode = NODES.get("set-version");
  const validateNode = NODES.get("validate-version");

  const setType = getNodeType("action.set_variable");
  const validateType = getNodeType("condition.expression");
  expect(setType, "action.set_variable must be registered").toBeTruthy();
  expect(validateType, "condition.expression must be registered").toBeTruthy();

  const ctx = makeCtx({ readVersionOutput });

  // set-version
  const value = setNode.config.value;
  // eslint-disable-next-line no-new-func
  const fn = new Function("$data", "$ctx", `return (${value});`);
  ctx.data.version = fn(ctx.data, ctx);

  // validate-version — production call shape, no stubs.
  const result = await validateType.execute(validateNode, ctx);
  return { version: ctx.data.version, result };
}

describe("release-pipeline template: version is validated before any tag", () => {
  it("wires the gate between read-version and everything downstream", () => {
    // The gate must sit AFTER set-version and BEFORE the changelog agent,
    // i.e. upstream of commit-tag / publish-npm / create-gh-release.
    expect(EDGES).toContainEqual(
      expect.objectContaining({ source: "set-version", target: "validate-version" }),
    );
    expect(EDGES).toContainEqual(
      expect.objectContaining({ source: "validate-version", target: "generate-changelog" }),
    );
    // There must be no edge that reaches a tag/publish/release node without
    // passing through the gate.
    const fromSetVersion = EDGES.filter((e) => e.source === "set-version");
    expect(fromSetVersion).toHaveLength(1);
    expect(fromSetVersion[0].target).toBe("validate-version");
  });

  it("read-version fails the run instead of continuing with empty output", () => {
    // Without this, a corrupt package.json exits non-zero with empty stdout and
    // the pipeline proceeds to tag `v`.
    expect(NODES.get("read-version").config.failOnError).toBe(true);
  });

  it("commit-tag carries no continueOnError, so it cannot survive a failed upstream", () => {
    expect(NODES.get("commit-tag").config.continueOnError).toBeFalsy();
    expect(NODES.get("validate-version").config.continueOnError).toBeFalsy();
  });
});

describe("release-pipeline template: the gate refuses every malformed version", () => {
  // Each row is a real failure shape of `node -p require('./package.json').version`.
  const rejected = [
    ["empty stdout", ""],
    ["whitespace only", "   "],
    ["missing patch", "0.44"],
    ["major only", "1"],
    ["non-numeric patch", "0.43.x"],
    ["extra component", "0.43.1.2"],
    ["dist-tag", "latest"],
    ["CI placeholder", "NOT_FOUND"],
    ["leading v survives elsewhere", "version"],
  ];

  it.each(rejected)("throws on %s (%j)", async (_label, output) => {
    await expect(resolveTemplateVersion(output)).rejects.toThrow(
      /not strict semver/,
    );
  });

  // The gate must never let a blank version reach the concatenation, which is
  // what produced the literal tag `v`.
  it("would have produced the bare `v` tag for the empty case", async () => {
    // Prove the shape of the defect is still what the gate is aimed at.
    const gate = NODES.get("validate-version");
    expect(gate.config.expression).toContain('JSON.stringify("v" + v)');
    await expect(resolveTemplateVersion("")).rejects.toThrow(/Refusing to release/);
  });
});

describe("release-pipeline template: valid versions pass the gate", () => {
  it.each([
    ["0.44.0", "0.44.0"],
    ["1.0.0", "1.0.0"],
    ["0.43.2-beta.1", "0.43.2-beta.1"],
    ["0.44.0+build.5", "0.44.0+build.5"],
    // `node -p` prints a trailing newline.
    ["0.44.0\n", "0.44.0"],
    // A v-prefixed manifest normalises instead of double-prefixing to `vv0.44.0`.
    ["v0.44.0", "0.44.0"],
  ])("accepts %j and resolves version to %j", async (output, expected) => {
    const { version, result } = await resolveTemplateVersion(output);
    expect(version).toBe(expected);
    expect(result.result).toBe(true);
  });
});

describe("release-pipeline template: falsification", () => {
  it("the gate is reachable — an unvalidated template would have failed here", async () => {
    // Sanity on the harness itself: with the gate node's expression replaced by
    // the pre-fix behaviour (no validation), the empty case must PASS. If this
    // ever fails, the harness is not exercising the gate and the refusals above
    // are decoration.
    const original = NODES.get("validate-version").config.expression;
    try {
      NODES.get("validate-version").config.expression = "(() => true)()";
      const { version } = await resolveTemplateVersion("");
      expect(version).toBe("");
      // And this is exactly the string the commit-tag node would have used.
      expect(`v${version}`).toBe("v");
    } finally {
      NODES.get("validate-version").config.expression = original;
    }
  });
});