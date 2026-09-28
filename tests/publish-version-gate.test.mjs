import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  UNKNOWN_REGISTRY_VERSION,
  compareVersions,
  decidePublish,
  parseVersion,
} from "../tools/publish-version-gate.mjs";

describe("parseVersion", () => {
  it("parses a release version", () => {
    expect(parseVersion("0.43.1")).toMatchObject({
      major: 0,
      minor: 43,
      patch: 1,
      prerelease: [],
    });
  });

  it("parses a prerelease version", () => {
    expect(parseVersion("0.43.2-beta.1")).toMatchObject({
      major: 0,
      minor: 43,
      patch: 2,
      prerelease: ["beta", "1"],
    });
  });

  // The whole point of the module: these must be REJECTED, not coerced.
  it.each([
    ["", "empty string"],
    ["0.43", "missing patch"],
    ["v0.43.1", "leading v"],
    ["0.43.1.2", "extra component"],
    ["0.43.x", "non-numeric patch"],
    ["  ", "whitespace only"],
    ["latest", "dist-tag name"],
    ["NOT_FOUND", "CI placeholder"],
  ])("rejects %j (%s)", (input) => {
    expect(parseVersion(input)).toBeNull();
  });

  it("rejects non-string input", () => {
    expect(parseVersion(undefined)).toBeNull();
    expect(parseVersion(431)).toBeNull();
  });
});

describe("compareVersions", () => {
  it("orders release versions numerically, not lexically", () => {
    // The string-trap: "0.9.0" > "0.43.1" lexically, but not numerically.
    expect(compareVersions("0.9.0", "0.43.1")).toBe(-1);
    expect(compareVersions("0.43.10", "0.43.9")).toBe(1);
  });

  it("treats equal versions as equal", () => {
    expect(compareVersions("0.43.1", "0.43.1")).toBe(0);
  });

  // REGRESSION: the old split/map(Number) gate made this false, so a real
  // version bump silently never published.
  it("ranks a prerelease BELOW its release", () => {
    expect(compareVersions("0.43.2-beta.1", "0.43.2")).toBe(-1);
  });

  it("ranks a prerelease ABOVE the previous release", () => {
    expect(compareVersions("0.43.2-beta.1", "0.43.1")).toBe(1);
  });

  it("orders prerelease identifiers per semver", () => {
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
    expect(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.2")).toBe(-1);
    expect(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBe(-1);
  });

  it("ignores build metadata", () => {
    expect(compareVersions("1.0.0+build.1", "1.0.0+build.2")).toBe(0);
  });

  it("throws rather than silently returning false on a bad operand", () => {
    // These are the shapes that made the old gate return false without saying why.
    expect(() => compareVersions("0.43.1", "v0.43.1")).toThrow(TypeError);
    expect(() => compareVersions("0.43.1", "")).toThrow(TypeError);
    expect(() => compareVersions("0.43.1", "NOT_FOUND")).toThrow(TypeError);
    expect(() => compareVersions("", "0.43.1")).toThrow(TypeError);
  });

  it("treats dotted prerelease identifiers as real versions, not parse failures", () => {
    // "0.0.0-beta.x" is valid semver; the old gate's Number() map turned it NaN.
    expect(compareVersions("0.43.1", "0.0.0-beta.x")).toBe(1);
    expect(compareVersions("0.43.1", "0.0.0-beta")).toBe(1);
  });
});

describe("decidePublish", () => {
  it("skips when local matches the registry", () => {
    const d = decidePublish({ localVersion: "0.43.1", registryVersion: "0.43.1" });
    expect(d.shouldPublish).toBe(false);
  });

  it("publishes when local is strictly newer", () => {
    const d = decidePublish({ localVersion: "0.43.2", registryVersion: "0.43.1" });
    expect(d.shouldPublish).toBe(true);
  });

  it("never republishes when the registry is unreachable", () => {
    // REGRESSION: the old gate fell back to comparing against 0.0.0, and every
    // released version is greater than 0.0.0 — so a network blip turned into a
    // publish attempt at an UNCHANGED version.
    const d = decidePublish({
      localVersion: "0.43.1",
      registryVersion: UNKNOWN_REGISTRY_VERSION,
    });
    expect(d.shouldPublish).toBe(false);
    expect(d.reason).toMatch(/unknown/);
  });

  it("defaults a missing registry version to the unknown sentinel and stops", () => {
    const d = decidePublish({ localVersion: "0.43.1" });
    expect(d.registryVersion).toBe(UNKNOWN_REGISTRY_VERSION);
    expect(d.shouldPublish).toBe(false);
  });

  // The sentinel must never be orderable — that was the whole 0.0.0 bug.
  it("uses a sentinel no real version can equal", () => {
    expect(parseVersion(UNKNOWN_REGISTRY_VERSION)).toBeNull();
    expect(() => compareVersions("0.43.1", UNKNOWN_REGISTRY_VERSION)).toThrow(TypeError);
  });

  // REGRESSION: unparseable registry output used to resolve to "skip" silently.
  it("refuses to publish on an unparseable registry version", () => {
    for (const bad of ["", "NOT_FOUND", "v0.43.1", "latest"]) {
      const d = decidePublish({ localVersion: "0.43.2", registryVersion: bad });
      expect(d.shouldPublish, `registry=${JSON.stringify(bad)}`).toBe(false);
      expect(d.reason).toMatch(/unparseable/);
    }
  });

  it("refuses to publish on an unparseable local version", () => {
    const d = decidePublish({ localVersion: "0.43", registryVersion: "0.43.1" });
    expect(d.shouldPublish).toBe(false);
    expect(d.reason).toMatch(/local package\.json version is unparseable/);
  });

  it("lets force override a stop, and says so in the reason", () => {
    expect(
      decidePublish({ localVersion: "0.43.1", registryVersion: "0.43.1", force: true })
        .shouldPublish,
    ).toBe(true);
    // force is an explicit human override, so it DOES override an unknown
    // registry — but the reason must record that it was forced, not compared.
    const forced = decidePublish({
      localVersion: "0.43.1",
      registryVersion: UNKNOWN_REGISTRY_VERSION,
      force: true,
    });
    expect(forced.shouldPublish).toBe(true);
    expect(forced.reason).toMatch(/force was requested/);
  });

  it("matches the real package.json version on this checkout", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "..", "package.json"), "utf8"),
    );
    expect(parseVersion(pkg.version)).not.toBeNull();
    expect(
      decidePublish({ localVersion: pkg.version, registryVersion: pkg.version }).shouldPublish,
    ).toBe(false);
  });
});

// The workflow shells out to this file, so the CLI branch is load-bearing.
// REGRESSION: a `file://${process.argv[1]}` guard never matches on Windows
// (argv[1] is a backslash path, import.meta.url is a URL) and the gate
// silently printed nothing — leaving should-publish unwritten.
describe("CLI entry point", () => {
  const script = resolve(import.meta.dirname, "..", "tools", "publish-version-gate.mjs");

  const run = (args) =>
    execFileSync(process.execPath, [script, ...args], { encoding: "utf8" });

  it("prints a decision when invoked as a script", () => {
    const out = JSON.parse(run(["0.43.2", "0.43.1", "false"]));
    expect(out.shouldPublish).toBe(true);
  });

  it("stops on an empty registry version over the CLI", () => {
    // An empty string is what `npm view` yields on failure. It hits the
    // unparseable branch rather than the sentinel; either way the gate stops,
    // which is the property that matters.
    const out = JSON.parse(run(["0.43.1", "", "false"]));
    expect(out.shouldPublish).toBe(false);
    expect(out.reason).toMatch(/unparseable|unknown/);
  });

  it("publishes a prerelease bump over the CLI", () => {
    // The exact case the old inline gate got wrong (it silently skipped).
    const out = JSON.parse(run(["0.43.2-beta.1", "0.43.1", "false"]));
    expect(out.shouldPublish).toBe(true);
  });
});
