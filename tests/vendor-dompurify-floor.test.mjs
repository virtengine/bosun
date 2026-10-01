import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { BUNDLE_TARGETS } from "../tools/build-vendor-toastui.mjs";
import {
  DOMPURIFY_MIN_VERSION,
  DOMPURIFY_VERSION,
  inspectDompurifyBundle,
} from "../tools/dompurify-floor.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

describe("vendored DOMPurify floor", () => {
  it("accepts the minimum unconditionally patched version", () => {
    const result = inspectDompurifyBundle(
      `/*! @license DOMPurify ${DOMPURIFY_MIN_VERSION} */ n.version="${DOMPURIFY_MIN_VERSION}",n.removed=[]`,
      "fixture.js",
    );
    expect(result.ok).toBe(true);
    expect(result.versions).toEqual([DOMPURIFY_MIN_VERSION, DOMPURIFY_MIN_VERSION]);
  });

  it("rejects a bundle containing a pre-floor implementation marker", () => {
    const result = inspectDompurifyBundle(
      '/*! @license DOMPurify 2.3.3 */ n.version="2.3.3",n.removed=[]',
      "fixture.js",
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(
      new RegExp(`below required floor ${DOMPURIFY_MIN_VERSION.replace(/\./g, "\\.")}`),
    );
  });

  it("rejects the nested lockfile version that used to be pinned at 2.5.9", () => {
    const result = inspectDompurifyBundle(
      '/*! @license DOMPurify 2.5.9 */ n.version="2.5.9",n.removed=[]',
      "fixture.js",
    );
    expect(result.ok).toBe(false);
  });

  it("rejects missing or inconsistent version markers", () => {
    expect(inspectDompurifyBundle("not a sanitizer", "fixture.js").ok).toBe(false);
    // A bundle whose banner marker was rewritten but whose runtime version was
    // not is exactly the "cosmetic string substitution" failure mode.
    expect(
      inspectDompurifyBundle(
        `/*! @license DOMPurify ${DOMPURIFY_VERSION} */ n.version="2.3.3",n.removed=[]`,
        "fixture.js",
      ).ok,
    ).toBe(false);
  });
});

describe("committed vendored bundles", () => {
  it("covers every committed bundle location", () => {
    expect(BUNDLE_TARGETS.map((p) => p.replace(REPO_ROOT, "").replace(/\\/g, "/"))).toEqual([
      "/ui/assets/toastui-editor-all.min.js",
      "/site/ui/assets/toastui-editor-all.min.js",
    ]);
  });

  for (const bundlePath of BUNDLE_TARGETS) {
    const label = bundlePath.replace(REPO_ROOT, "");
    it(`ships DOMPurify at or above the floor in ${label}`, () => {
      const source = readFileSync(bundlePath, "utf8");
      const result = inspectDompurifyBundle(source, label);
      expect(result.ok, `${label}: ${result.reason}`).toBe(true);
      // The banner marker and the runtime `.version` marker must agree, so a
      // substring rewrite of the banner alone cannot pass this gate.
      expect(result.versions).toEqual([DOMPURIFY_VERSION, DOMPURIFY_VERSION]);
    });
  }

  it("keeps ui/ and site/ui byte-identical so Pages ships what the gate checked", () => {
    const [ui, site] = BUNDLE_TARGETS.map((p) => readFileSync(p));
    expect(Buffer.compare(ui, site)).toBe(0);
  });
});
