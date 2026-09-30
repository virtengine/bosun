import { describe, expect, it } from "vitest";

import {
  PROBE_FAILED,
  classifyReleaseState,
  classifyTagName,
  collectReleaseState,
  compareVersions,
  parseVersion,
} from "../tools/release-drift.mjs";

/** A clean, fully-agreeing state: npm, tag and release all on 0.43.2. */
function cleanState(overrides = {}) {
  return {
    manifest: "0.43.2",
    tags: ["v0.42.4", "v0.43.1", "v0.43.2"],
    releases: [
      { tag_name: "v0.42.4", isDraft: false },
      { tag_name: "v0.43.1", isDraft: false },
      { tag_name: "v0.43.2", isDraft: false },
    ],
    npmVersion: "0.43.2",
    ...overrides,
  };
}

const codes = (result) => result.findings.map((f) => f.code);

describe("parseVersion", () => {
  it("accepts a bare version and a v-prefixed tag", () => {
    expect(parseVersion("0.43.2")).toMatchObject({ major: 0, minor: 43, patch: 2 });
    expect(parseVersion("v0.43.2")).toMatchObject({ major: 0, minor: 43, patch: 2 });
  });

  it.each([[""], ["0.43"], ["latest"], ["v"], ["0.43.x"], ["   "]])(
    "rejects %j",
    (input) => {
      expect(parseVersion(input)).toBeNull();
    },
  );
});

describe("compareVersions", () => {
  it("orders numerically, not lexically", () => {
    expect(compareVersions("0.9.0", "0.43.1")).toBe(-1);
    expect(compareVersions("0.43.10", "0.43.9")).toBe(1);
    expect(compareVersions("0.43.2", "0.43.2")).toBe(0);
  });

  it("ranks a release above its prerelease", () => {
    expect(compareVersions("0.43.2", "0.43.2-beta.1")).toBe(1);
  });
});

describe("classifyReleaseState — the clean case", () => {
  it("reports no drift and exit 0 when all four records agree", () => {
    const result = classifyReleaseState(cleanState());
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("ignores legacy non-version tags rather than reporting them", () => {
    // `v` and `0.37.0` are the documented legacy tags: one is not a version at
    // all, the other has no `v` prefix.
    //
    // CORRECTED by this change: `0.37.0` is now reported, as `malformed-tag`
    // info. It is a stray malformed release tag — exactly what this tool exists
    // to surface — so asserting it produces NO finding was asserting the blind
    // spot. `v` (no version shape at all) stays silent, and neither tag may
    // ever be escalated to `tag-without-release`, which would fail the gate for
    // a tag that disagrees with nothing.
    const result = classifyReleaseState(
      cleanState({ tags: ["v", "0.37.0", ...cleanState().tags] }),
    );
    expect(codes(result)).not.toContain("tag-without-release");
    expect(codes(result)).toContain("malformed-tag");
    expect(result.findings.map((f) => f.severity)).toEqual(["info"]);
    // Info-only, so the gate's verdict is unchanged: this is hygiene, not drift.
    expect(result.exitCode).toBe(0);
    expect(result.ok).toBe(true);
  });
});

describe("classifyTagName", () => {
  it("recognises a release tag", () => {
    for (const tag of ["v0.43.2", "v0.36.29", "v0.43.3-beta.1"]) {
      expect(classifyTagName(tag), tag).toBe("release");
    }
  });

  it("recognises the malformed strays this repo actually has", () => {
    // `git ls-remote --tags origin` on virtengine/bosun, measured: these two are
    // the only malformed refs, and release-drift.mjs reported neither.
    for (const tag of ["0.37.0", "0.42.0"]) {
      expect(classifyTagName(tag), tag).toBe("malformed");
    }
  });

  it("treats a non-version-shaped tag as other, not as drift", () => {
    for (const tag of ["latest", "nightly", "checkpoint/x", "v", ""]) {
      expect(classifyTagName(tag), tag).toBe("other");
    }
  });
});

describe("classifyReleaseState — malformed tags are visible (R1)", () => {
  it("names an unprefixed tag instead of silently skipping it", () => {
    // The blind spot: versionFromTag() required a leading `v`, so `0.37.0` and
    // `0.42.0` were skipped in BOTH directions — no `tag-without-release`, and
    // the summary's `/^v\d/` filter hid them from the report. The tool that
    // exists to find tag/release disagreement could not see that two of this
    // repo's own release tags are malformed.
    const result = classifyReleaseState(cleanState({ tags: ["0.37.0", ...cleanState().tags] }));
    const malformed = result.findings.filter((f) => f.code === "malformed-tag");
    expect(malformed).toHaveLength(1);
    expect(malformed[0].detail).toContain("0.37.0");
    expect(malformed[0].severity).toBe("info");
  });

  it("reports both live strays at once, without failing the gate", () => {
    // Info, never error: a malformed tag is a hygiene defect, not evidence that
    // npm, the tags and the release records disagree. Deleting a published tag
    // is a human decision (RELEASE.md) — this reports, it does not remediate.
    const result = classifyReleaseState(cleanState({ tags: ["0.37.0", "0.42.0", ...cleanState().tags] }));
    const malformed = result.findings.filter((f) => f.code === "malformed-tag");
    expect(malformed.map((f) => f.detail.split(" ")[1]).sort()).toEqual(["0.37.0", "0.42.0"]);
    expect(result.exitCode).toBe(0);
    expect(result.ok).toBe(true);
  });

  it("never promotes a malformed tag into a version", () => {
    // The fix must not become an acceptance path: a malformed tag is
    // REPORTED, and it still cannot participate in any ordering — otherwise
    // `0.42.0` would start counting as the newest release and could raise a
    // false drift error against npm.
    const result = classifyReleaseState(
      cleanState({ tags: ["0.99.0", ...cleanState().tags], npmVersion: "0.43.2" }),
    );
    expect(codes(result)).toContain("malformed-tag");
    expect(codes(result)).not.toContain("release-record-ahead-of-npm");
    expect(codes(result)).not.toContain("npm-ahead-of-release-record");
    expect(result.exitCode).toBe(0);
  });

  it("does not double-report a malformed tag as tag-without-release", () => {
    const result = classifyReleaseState(cleanState({ tags: ["0.37.0", ...cleanState().tags] }));
    expect(codes(result).filter((c) => c === "tag-without-release")).toEqual([]);
  });
});

describe("classifyReleaseState — the defect this gate exists for", () => {
  it("flags a release whose tag is absent from origin", () => {
    // The live 2026-09-29 state: the v0.43.1 release object existed but the tag
    // v0.43.1 did not exist on origin.
    const result = classifyReleaseState(
      cleanState({ tags: ["v0.42.4"], releases: [{ tag_name: "v0.43.1", isDraft: false }], npmVersion: "0.43.1", manifest: "0.43.1" }),
    );
    expect(codes(result)).toContain("release-missing-tag");
    expect(result.exitCode).toBe(1);
  });

  it("flags a release still sitting as a draft", () => {
    const result = classifyReleaseState(
      cleanState({ releases: [...cleanState().releases, { tag_name: "v0.43.3", isDraft: true }] }),
    );
    expect(codes(result)).toContain("draft-release");
    expect(result.exitCode).toBe(1);
  });

  it("flags npm being ahead of the newest published release", () => {
    // The headline drift from the card: npm carries 0.43.1 while the release
    // record stops at v0.42.4.
    const result = classifyReleaseState(
      cleanState({
        releases: [{ tag_name: "v0.42.4", isDraft: false }],
        tags: ["v0.42.4"],
        npmVersion: "0.43.1",
        manifest: "0.43.1",
      }),
    );
    expect(codes(result)).toContain("npm-ahead-of-release-record");
    expect(result.exitCode).toBe(1);
  });

  it("flags a published release that npm has never seen", () => {
    const result = classifyReleaseState(cleanState({ npmVersion: "0.42.4" }));
    expect(codes(result)).toContain("release-record-ahead-of-npm");
    expect(result.exitCode).toBe(1);
  });

  it("flags a manifest behind the registry", () => {
    const result = classifyReleaseState(cleanState({ manifest: "0.43.1" }));
    expect(codes(result)).toContain("manifest-behind-npm");
    expect(result.exitCode).toBe(1);
  });

  it("treats a staged (ahead) manifest as informational, not drift", () => {
    const result = classifyReleaseState(cleanState({ manifest: "0.43.3" }));
    expect(codes(result)).toContain("release-staged");
    expect(result.exitCode).toBe(0);
  });

  it("reports a tag with no release as informational", () => {
    const result = classifyReleaseState(cleanState({ tags: [...cleanState().tags, "v0.40.6"] }));
    expect(codes(result)).toContain("tag-without-release");
    expect(result.exitCode).toBe(0);
  });
});

describe("classifyReleaseState — fail-closed on a failed probe", () => {
  it.each([
    ["manifest", { manifest: PROBE_FAILED }],
    ["tags", { tags: PROBE_FAILED }],
    ["releases", { releases: PROBE_FAILED }],
    ["npmVersion", { npmVersion: PROBE_FAILED }],
  ])("returns UNKNOWN (exit 2) when the %s probe failed", (_label, override) => {
    const result = classifyReleaseState(cleanState(override));
    expect(codes(result)).toContain("probe-failed");
    expect(result.exitCode).toBe(2);
    expect(result.ok).toBe(false);
  });

  it("never reports exit 0 for an unreachable registry", () => {
    // The whole point: an unreachable npm must not read as "no drift".
    const result = classifyReleaseState(cleanState({ npmVersion: PROBE_FAILED }));
    expect(result.exitCode).not.toBe(0);
  });
});

describe("collectReleaseState — an override must actually override", () => {
  // A probe set whose npm value deliberately conflicts with the release record,
  // so an ignored override is indistinguishable from a CLEAN repo.
  const fakeProbes = {
    manifest: async () => "0.43.2",
    tags: async () => ["v0.43.1"],
    releases: async () => [{ tag_name: "v0.43.1", isDraft: false }],
    npmVersion: async () => "0.43.1",
  };

  it("replaces the probed record with the caller's value", async () => {
    const state = await collectReleaseState({ probes: fakeProbes, npmVersion: "0.99.0" });
    expect(state.npmVersion).toBe("0.99.0");
  });

  it("reaches a DRIFT verdict for an override, instead of the probe's CLEAN one", async () => {
    // The defect this covers: `--npm-version` was accepted, discarded, and the
    // command still reported the live registry's verdict. A fail-closed gate
    // that silently answers with a different input than it was handed is worse
    // than no gate, because it manufactures a CLEAN it never measured.
    const overridden = classifyReleaseState(
      await collectReleaseState({ probes: fakeProbes, npmVersion: "0.99.0" }),
    );
    expect(overridden.exitCode).toBe(1);
    expect(codes(overridden)).toContain("npm-ahead-of-release-record");

    // ...and the same input without the override really would have been clean,
    // which is what made the bug invisible.
    const probed = classifyReleaseState(await collectReleaseState({ probes: fakeProbes }));
    expect(probed.exitCode).toBe(0);
  });

  it("still probes the records the caller did not override", async () => {
    expect(await collectReleaseState({ probes: fakeProbes })).toEqual({
      manifest: "0.43.2",
      tags: ["v0.43.1"],
      releases: [{ tag_name: "v0.43.1", isDraft: false }],
      npmVersion: "0.43.1",
    });
  });
});
