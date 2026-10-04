#!/usr/bin/env node
/**
 * vendor-sync.mjs — Bundle front-end vendor files into ui/vendor/
 *
 * Copies the ESM browser builds of Preact, htm, @preact/signals, and
 * es-module-shims from node_modules into ui/vendor/ so they are:
 *
 *   1. Included in the npm tarball (zero CDN dependency at runtime)
 *   2. Served directly as static files by both ui-server and setup-web-server
 *   3. Committed to git so the GitHub Pages demo works without a server
 *
 * Resolution order for each file:
 *   a) node_modules (createRequire resolution — handles npm hoisting)
 *   b) Download from upstream esm.sh (pinned URLs — same versions)
 *
 * Run automatically by:
 *   - `npm install`  (via postinstall.mjs)
 *   - `npm run prepare` (before npm pack / npm publish)
 *   - `npx bosun vendor-sync` (manual refresh)
 *
 * `--check` (the CI freshness guard) re-runs the SAME resolution into a scratch
 * directory and diffs it against both committed roots. `ui/vendor/` is the only
 * directory this tool writes; `site/ui/vendor/` is a verbatim mirror of it written
 * by tools/sync-demo-ui.mjs, so the guard checks both to catch a half-regenerated
 * mirror. Shape follows tools/build-vendor-mui.mjs (PR #586) — keep the two guards
 * independent so neither can mask the other.
 */

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, dirname, join, relative, sep, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import https from "node:https";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "..");
export const VENDOR_DIR = resolve(ROOT, "ui", "vendor");
export const SITE_VENDOR_DIR = resolve(ROOT, "site", "ui", "vendor");
const _require = createRequire(import.meta.url);

// ── Vendor manifest ───────────────────────────────────────────────────────────
// Each entry: output filename → { specifier from node_modules, upstream URL fallback }
//
// The upstream URLs are pinned esm.sh ES-module builds.  For packages that
// import bare specifiers (preact/hooks → 'preact'), the importmap in demo.html
// and index.html re-routes those to the local vendor files — so the node_modules
// copy (which uses bare specifiers internally) also works in the browser.
export const VENDOR_MANIFEST = [
  {
    name: "preact.js",
    specifier: "preact/dist/preact.module.js",
    upstream: "https://esm.sh/preact@10.25.4/es2022/preact.mjs",
    upstreamFallback: "https://cdn.jsdelivr.net/npm/preact@10.25.4/dist/preact.module.js",
  },
  {
    name: "preact-hooks.js",
    specifier: "preact/hooks/dist/hooks.module.js",
    upstream: "https://cdn.jsdelivr.net/npm/preact@10.25.4/hooks/dist/hooks.module.js",
    upstreamFallback: "https://esm.sh/preact@10.25.4/hooks/es2022/hooks.mjs",
  },
  {
    name: "preact-compat.js",
    specifier: "preact/compat/dist/compat.module.js",
    upstream: "https://cdn.jsdelivr.net/npm/preact@10.25.4/compat/dist/compat.module.js",
    upstreamFallback: "https://esm.sh/preact@10.25.4/compat/es2022/compat.mjs",
  },
  {
    name: "htm.js",
    specifier: "htm/dist/htm.module.js",
    upstream: "https://esm.sh/htm@3.1.1/es2022/htm.mjs",
    upstreamFallback: "https://cdn.jsdelivr.net/npm/htm@3.1.1/dist/htm.module.js",
  },
  {
    // signals-core must be vendored BEFORE signals so the importmap can resolve it
    name: "preact-signals-core.js",
    specifier: "@preact/signals-core/dist/signals-core.module.js",
    upstream: "https://cdn.jsdelivr.net/npm/@preact/signals-core@1.8.0/dist/signals-core.module.js",
    upstreamFallback: "https://esm.sh/@preact/signals-core@1.8.0/es2022/signals-core.mjs",
  },
  {
    // signals depends on preact + preact/hooks + @preact/signals-core ─ all resolved by importmap
    name: "preact-signals.js",
    specifier: "@preact/signals/dist/signals.module.js",
    upstream: "https://cdn.jsdelivr.net/npm/@preact/signals@1.3.1/dist/signals.module.js",
    upstreamFallback: "https://esm.sh/@preact/signals@1.3.1/es2022/signals.mjs",
  },
  {
    name: "es-module-shims.js",
    specifier: "es-module-shims/dist/es-module-shims.js",
    upstream: "https://esm.sh/es-module-shims@1.10.0/es2022/es-module-shims.mjs",
    upstreamFallback: "https://cdn.jsdelivr.net/npm/es-module-shims@1.10.0/dist/es-module-shims.min.js",
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolve a package sub-path in node_modules using createRequire.
 *
 * Handles two failure modes:
 *   - ERR_MODULE_NOT_FOUND   — package isn't installed
 *   - ERR_PACKAGE_PATH_NOT_EXPORTED — package uses strict `exports` that don't
 *     expose the dist/  path we want (common in modern preact / signals).
 *     Work-around: resolve the package *root* via its main entry, then
 *     construct the full path manually.
 */
function resolveFromNodeModules(specifier) {
  // Try direct resolution first (works when exports field allows the sub-path)
  try {
    return _require.resolve(specifier);
  } catch (e) {
    if (e.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") return null;
  }

  // Parse 'pkg/sub/path' or '@scope/pkg/sub/path'
  const isScoped = specifier.startsWith("@");
  const firstSlash = specifier.indexOf("/");
  const secondSlash = isScoped ? specifier.indexOf("/", firstSlash + 1) : firstSlash;
  if (secondSlash === -1) return null;
  const pkgName = specifier.slice(0, secondSlash);
  const filePath = specifier.slice(secondSlash + 1); // e.g. 'dist/preact.module.js'

  try {
    const pkgMain = _require.resolve(pkgName); // e.g. .../preact/dist/preact.js
    // Walk up from pkgMain until we find the directory with package.json
    let dir = dirname(pkgMain);
    while (dir !== dirname(dir)) {
      if (existsSync(resolve(dir, "package.json"))) {
        const candidate = resolve(dir, filePath);
        return existsSync(candidate) ? candidate : null;
      }
      dir = dirname(dir);
    }
  } catch { /* not installed */ }
  return null;
}

/** 'preact/hooks/dist/hooks.module.js' → 'preact'; '@preact/signals/dist/x.js' → '@preact/signals'. */
export function packageNameOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Read the version declared by an installed package's own package.json, or null. */
function readInstalledVersion(pkgDir) {
  try {
    return JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

/**
 * Locate the directory of the package that `specifier` resolves into.
 *
 * Reuses the resolution in resolveFromNodeModules() so the directory reported
 * here is the one holding the bytes the sync would actually copy — not some
 * other copy of the same package hoisted elsewhere in the tree.
 *
 * The directory is derived from the package name rather than by walking up to
 * the nearest package.json, because that heuristic gets both of preact's
 * manifest shapes wrong:
 *   - preact ships NESTED package.json files: preact/hooks/ is a private
 *     sub-package stamped 0.1.0 and preact/compat/ one stamped 4.0.0. Stopping at
 *     the nearest manifest reports preact@0.1.0 and then "fails closed" against a
 *     perfectly correct npm-ci tree.
 *   - a SCOPED package sits two levels under node_modules, so a single-level
 *     parent check lands on node_modules/@preact rather than on the package.
 * Taking the INNERMOST node_modules ancestor of the resolved file and appending
 * the package name is correct for scoped names, nested manifests, and the nested
 * node_modules of an unsatisfiable-hoist tree alike.
 */
function installedPackageDir(specifier, pkgName) {
  const localPath = resolveFromNodeModules(specifier);
  if (!localPath) return null;

  let dir = dirname(localPath);
  while (dir !== dirname(dir)) {
    if (basename(dir) === "node_modules") {
      const candidate = join(dir, ...pkgName.split("/"));
      return existsSync(join(candidate, "package.json")) ? candidate : null;
    }
    dir = dirname(dir);
  }
  return null;
}

/**
 * Prove that the node_modules tree the sync is about to read is the tree
 * package-lock.json pins — or refuse to.
 *
 * Why this exists: a fresh git worktree's node_modules is frequently produced by
 * `npm install` rather than `npm ci` (and sometimes copied in wholesale), so a
 * transitively-floating package — @preact/signals-core is one, since package.json
 * only pins @preact/signals — can sit at a version the lockfile never chose. The
 * byte comparison then reports the COMMITTED bundle as stale, and the obvious
 * "fix" is to regenerate and commit those bytes. That lands a bundle inconsistent
 * with package-lock.json, and the next `npm ci` regenerates the pinned bytes, so
 * the same guard reds again with the roles reversed and now no explanation.
 *
 * Two conditions are treated as "cannot verify" and both fail closed:
 *   - node_modules/.package-lock.json is absent  → not an npm-ci tree, so nothing
 *     here can attest the tree matches the lockfile.
 *   - that hidden lockfile disagrees with package-lock.json on a vended entry
 *     → the tree provably is not the pinned one.
 *
 * Returns { packages: { <manifest file>: { pkg, pinned, installed, attested } } }
 * for every vended entry.
 */
export function inspectVendedInstall({ root = ROOT } = {}) {
  let pinnedTree;
  try {
    pinnedTree = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  } catch (err) {
    throw new Error(`vendor-sync: cannot read package-lock.json in ${root}: ${err.message}`);
  }

  const hiddenLockPath = join(root, "node_modules", ".package-lock.json");
  let hiddenTree = null;
  let hiddenLockPresent = true;
  try {
    hiddenTree = JSON.parse(readFileSync(hiddenLockPath, "utf8"));
  } catch {
    hiddenLockPresent = false;
  }

  /** The lockfile pin for `pkgName`, following nested node_modules if hoisting put it there. */
  const pinFor = (pkgName) => {
    const direct = pinnedTree.packages?.[`node_modules/${pkgName}`];
    if (direct?.version) return direct.version;
    const suffix = `node_modules/${pkgName}`;
    const nested = Object.keys(pinnedTree.packages ?? {}).filter(
      (path) => path.endsWith(`/${suffix}`) && pinnedTree.packages[path].version,
    );
    return nested.length === 1 ? pinnedTree.packages[nested[0]].version : null;
  };

  const hiddenVersionFor = (pkgName) => hiddenTree?.packages?.[`node_modules/${pkgName}`]?.version ?? null;

  // Keyed by manifest FILE, not package name: three entries (preact.js,
  // preact-hooks.js, preact-compat.js) all resolve inside the one `preact`
  // package, so a package-keyed map would drop all but the last of them.
  const result = {};
  for (const entry of VENDOR_MANIFEST) {
    const pkgName = packageNameOf(entry.specifier);
    const pkgDir = installedPackageDir(entry.specifier, pkgName);
    const pinned = pinFor(pkgName);
    const hidden = hiddenVersionFor(pkgName);
    result[entry.name] = {
      pkg: pkgName,
      pinned,
      installed: pkgDir ? readInstalledVersion(pkgDir) : null,
      // Attested only by an npm-ci tree that AGREES with package-lock.json. The
      // hidden lockfile existing is not enough: an `npm install` run that resolved
      // against a newer registry writes one too, and one that then disagrees with
      // the pin is proof the tree is not the pinned one.
      attested: hidden !== null && pinned !== null && hidden === pinned,
    };
  }
  return { packages: result, hiddenLockPresent };
}

/**
 * Statuses that mean "this entry's freshness could not be judged", as opposed to
 * a verdict on the committed bytes. The report and the tests both branch on this.
 */
export const UNVERIFIABLE_STATUS = "install-unverifiable";

/**
 * Fold the install attestation into compareVendorFiles() records.
 *
 * An entry whose installed package is not the pinned one gets UNVERIFIABLE_STATUS
 * with the pin and the installed version attached, so the caller reports a lockfile
 * drift rather than a byte delta. Everything the tree does attest is left alone —
 * the byte comparison is still meaningful for those entries.
 */
export function applyInstallAttestation(records, install) {
  const byFile = new Map(Object.entries(install.packages ?? {}));

  return records.map((record) => {
    const info = byFile.get(record.name);

    // Attestation is judged BEFORE any existing status, including "unvended".
    // An entry skipped by the generator arrives here already labelled "unvended"
    // (compareVendorFiles saw no expected bytes because nothing was written), so
    // checking the status first would let an unverifiable tree report itself as
    // merely "not installed" — the confusing, harmless-looking verdict this whole
    // guard exists to replace.
    //
    // Fail closed whenever the entry's tree cannot be proven to be the pinned one:
    // no info at all, no attestation, or a version that disagrees with the pin.
    if (!info || !info.attested || !info.installed || !info.pinned || info.installed !== info.pinned) {
      // The byte counts are DROPPED, not just re-labelled. A caller that falls
      // through to its default branch on any status it does not recognise would
      // otherwise render "5292 bytes committed vs 5533 bytes generated" — the
      // exact artifact-staleness reading this whole path exists to prevent.
      const { committedBytes, expectedBytes, ...rest } = record;
      return { ...rest, status: UNVERIFIABLE_STATUS, ...(info ?? {}) };
    }

    // Attested: whatever compareVendorFiles said is meaningful. In particular an
    // entry still reported "unvended" here is genuinely absent from an
    // npm-ci tree that matches the lockfile, which is a different and correct
    // thing to say.
    return { ...record, attested: true };
  });
}

function fetchUrl(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (redirects <= 0) {
      reject(new Error(`Too many redirects: ${url}`));
      return;
    }
    https
      .get(url, { headers: { "User-Agent": "bosun-vendor-sync/1.0" } }, (res) => {
        // Follow redirects (esm.sh uses 302/307 for CDN routing)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = new URL(res.headers.location, url).href;
          res.resume();
          fetchUrl(next, redirects - 1).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });
}

/** Rewrite the cross-package ESM imports in esm.sh files back to local bare
 *  specifiers so the importmap resolves them to ui/vendor/* instead of CDN. */
function rewriteEsmShImports(src) {
  // esm.sh injects absolute CDN URLs like:
  //   import { ... } from "/stable/preact@10.25.4/..."
  //   import { ... } from "https://esm.sh/preact@10.25.4/..."
  // We rewrite those back to the bare specifier so the importmap takes over.
  return src
    .replace(/from\s+["'](https?:\/\/esm\.sh\/|\/stable\/)preact@[^"']*["']/g, 'from "preact"')
    .replace(/from\s+["'](https?:\/\/esm\.sh\/|\/stable\/)preact@[^"']*\/hooks[^"']*["']/g, 'from "preact/hooks"')
    .replace(/from\s+["'](https?:\/\/esm\.sh\/|\/stable\/)preact@[^"']*\/compat[^"']*["']/g, 'from "preact/compat"');
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Resolve every manifest entry into `outDir`.
 *
 * The destination directory is a parameter so the freshness guard can run the
 * exact production resolution (node_modules first, upstream download as fallback)
 * into a scratch directory instead of the committed tree. Because the resolution
 * logic is shared, the guard exercises the real generator rather than a
 * reimplementation that could drift from it.
 *
 * Network access is disabled in `--check`: a download-fallback byte would depend
 * on a third-party CDN's current output, so a guard that fetched would be red
 * whenever upstream moved and green whenever it did not. Offline is stricter and
 * deterministic — see checkVendorSyncFreshness().
 */
export async function syncVendorFiles({ silent = false, outDir = VENDOR_DIR, allowNetwork = true, root = ROOT } = {}) {
  mkdirSync(outDir, { recursive: true });

  const log = silent ? () => {} : (...a) => console.log("[vendor-sync]", ...a);
  const warn = (...a) => console.warn("[vendor-sync] WARN:", ...a);

  // Attest node_modules against package-lock.json BEFORE writing anything out of
  // it. This is the write-side half of the guard: `--check` only reports drift
  // after the fact, but postinstall (postinstall.mjs) and `npm run prepare` both
  // call this function in WRITE mode, and on an off-lockfile tree that is what
  // actually overwrites the committed bundles. Refusing here means the bad bytes
  // are never produced, rather than produced-then-explained.
  //
  // An unattested entry is skipped outright and its destination file is left
  // alone — no node_modules copy, and no CDN fallback either. Fetching the pinned
  // URL would produce defensible bytes, but it would also let a merely-drifted
  // local tree silently pull vendor content from a third party during postinstall.
  // Leaving the committed file untouched is the strictly safer outcome: it is
  // already the lockfile-correct artifact, and the run that mattered (npm ci in
  // CI) attests cleanly.
  let attest = null;
  try {
    attest = inspectVendedInstall({ root }).packages;
  } catch (err) {
    warn(`could not attest node_modules against package-lock.json: ${err.message}`);
  }

  const results = [];

  for (const entry of VENDOR_MANIFEST) {
    const destPath = resolve(outDir, entry.name);

    // ── 1. Try node_modules ──────────────────────────────────────────────────
    const info = attest?.[entry.name];
    if (info && !info.attested) {
      // The reason must be stated precisely. When the versions agree but the tree
      // is still unattested (no .package-lock.json), the tree is simply not
      // provable — saying "X is not the pin (X)" would read as a contradiction.
      const why = !info.pinned
        ? `${info.pkg} is not pinned by package-lock.json`
        : info.installed && info.installed !== info.pinned
          ? `${info.pkg}@${info.installed} is not the package-lock.json pin (${info.pinned})`
          : "cannot attest this tree: package-lock.json pins " +
            `${info.pkg}@${info.pinned}, but node_modules has no .package-lock.json ` +
            "to prove the installed tree matches it";
      warn(`skipping node_modules for ${entry.name}: ${why} — copying it would write an off-lockfile bundle`);
      results.push({ name: entry.name, source: null, reason: "install-unverifiable" });
      continue;
    }

    const localPath = resolveFromNodeModules(entry.specifier);
    if (localPath && existsSync(localPath)) {
      try {
        const src = readFileSync(localPath);
        writeFileSync(destPath, src);
        log(`✓ node_modules → ${entry.name}`);
        results.push({ name: entry.name, source: "node_modules" });
        continue;
      } catch (err) {
        warn(`node_modules read failed for ${entry.name}: ${err.message}`);
      }
    }

    // ── 2. Try esm.sh (primary upstream) ────────────────────────────────────
    if (!allowNetwork) {
      warn(`Not in node_modules and network disabled: ${entry.name}`);
      results.push({ name: entry.name, source: null });
      continue;
    }
    for (const url of [entry.upstream, entry.upstreamFallback]) {
      try {
        log(`↓ Downloading ${entry.name} from ${url} …`);
        const buf = await fetchUrl(url);
        const src = rewriteEsmShImports(buf.toString("utf8"));
        writeFileSync(destPath, src, "utf8");
        log(`✓ downloaded → ${entry.name}`);
        results.push({ name: entry.name, source: url });
        break;
      } catch (err) {
        warn(`Download failed (${url}): ${err.message}`);
      }
    }

    if (!results.find((r) => r.name === entry.name)) {
      warn(`Could not vendor ${entry.name} — server will fall back to node_modules or CDN`);
      results.push({ name: entry.name, source: null });
    }
  }

  const ok = results.every((r) => r.source !== null);
  return { ok, results };
}

// ── Freshness guard ───────────────────────────────────────────────────────────

/**
 * Compare the bytes a fresh resolution produced against a committed copy.
 *
 * Returns one record per manifest entry so a caller reports every drifted file
 * at once instead of stopping at the first. `status` is one of:
 *   'ok'       — committed bytes match the generator output
 *   'missing'  — the committed file is absent
 *   'differs'  — the committed file exists but the bytes differ
 *   'unvended' — the generator could not resolve this entry offline, so there is
 *                no expected output to compare against (never silently 'ok')
 */
export function compareVendorFiles({ builtDir, committedDir }) {
  return VENDOR_MANIFEST.map((entry) => {
    const committedPath = join(committedDir, entry.name);
    let committed;
    try {
      committed = readFileSync(committedPath);
    } catch {
      return { name: entry.name, status: "missing", expectedBytes: 0, committedBytes: 0 };
    }

    let expected;
    try {
      expected = readFileSync(join(builtDir, entry.name));
    } catch {
      return {
        name: entry.name,
        status: "unvended",
        expectedBytes: 0,
        committedBytes: committed.length,
      };
    }

    const status = committed.equals(expected) ? "ok" : "differs";
    return {
      name: entry.name,
      status,
      expectedBytes: expected.length,
      committedBytes: committed.length,
    };
  });
}

/**
 * Re-resolve the vendor manifest into a temporary directory and diff it against
 * the committed copies without writing anything into `ui/vendor` or
 * `site/ui/vendor`.
 *
 * Pass `committedDir` to check one of the two roots; omit it to check BOTH,
 * which is what the CI guard needs — `site/ui/vendor` is a verbatim mirror
 * written by tools/sync-demo-ui.mjs, so a partial regeneration that updates
 * `ui/vendor` and leaves the mirror stale is exactly the skew that would
 * otherwise go unnoticed.
 */
export async function checkVendorSyncFreshness({ committedDir, root = ROOT, install } = {}) {
  const roots = committedDir ? [committedDir] : [VENDOR_DIR, SITE_VENDOR_DIR];
  const installReport = install ?? inspectVendedInstall({ root });

  const scratch = mkdtempSync(join(tmpdir(), "bosun-vendor-sync-check-"));
  try {
    const builtDir = join(scratch, "ui", "vendor");
    const { results } = await syncVendorFiles({ silent: true, outDir: builtDir, allowNetwork: false });

    // `source: null` means one of two very different things, and conflating them is
    // what makes the guard lie:
    //   - the package is genuinely ABSENT from node_modules ("unvended"), so there
    //     are no expected bytes to compare;
    //   - the generator SKIPPED the package because it could not attest the tree
    //     against the lockfile. The bytes exist and may well be correct — the tree
    //     is what is unverifiable. Reporting this as "unvended" both drops the
    //     entry's name and routes it past applyInstallAttestation(), so --check
    //     fell through to "run npm run build and commit", which is the exact
    //     misreading this attestation exists to prevent.
    const unvended = new Set(
      results.filter((r) => r.source === null && r.reason !== "install-unverifiable").map((r) => r.name),
    );

    return roots.flatMap((committedRoot) =>
      applyInstallAttestation(
        compareVendorFiles({ builtDir, committedDir: committedRoot }).map((record) => ({
          // NOTE: always spread `record` first. Replacing it outright drops `name`,
          // which is what rendered these as a literal "ui/vendor/undefined".
          ...record,
          ...(unvended.has(record.name) ? { status: "unvended" } : null),
          root: relative(ROOT, committedRoot).split(sep).join("/"),
        })),
        installReport,
      ),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function reportDrift(records) {
  const drifted = records.filter((r) => r.status !== "ok");
  if (drifted.length === 0) {
    console.log("[vendor-sync] Committed vendor files match the generator output ✓");
    return;
  }
  for (const record of drifted) {
    let detail;
    if (record.status === "missing") {
      detail = "not committed";
    } else if (record.status === "unvended") {
      detail = "not installed in node_modules — cannot verify offline";
    } else if (record.status === UNVERIFIABLE_STATUS) {
      // Never say "out of date" here: the committed bytes may be exactly right
      // and it is the local node_modules that is off-lockfile.
      detail = record.installed && record.pinned && record.installed !== record.pinned
        ? `node_modules has ${record.pkg}@${record.installed} but package-lock.json pins ${record.pinned}`
        : record.attested === false && record.pinned
          ? `cannot attest node_modules: package-lock.json pins ${record.pkg}@${record.pinned}`
          : "cannot attest node_modules against package-lock.json";
    } else {
      detail = `${record.committedBytes} bytes committed vs ${record.expectedBytes} bytes generated`;
    }
    console.error(`  ✗ ${record.root}/${record.name} — ${detail}`);
  }
  if (drifted.some((r) => r.status === UNVERIFIABLE_STATUS)) {
    console.error(
      "\n[vendor-sync] REFUSING to call these files stale: node_modules does not match package-lock.json,\n" +
        "[vendor-sync] so a byte delta here is local tree drift, NOT artifact staleness.\n" +
        "[vendor-sync] Run `npm ci` in this checkout and re-run. Do NOT regenerate and commit\n" +
        "[vendor-sync] vendor files from an off-lockfile node_modules — that lands a bundle that the\n" +
        "[vendor-sync] next `npm ci` will contradict.",
    );
    return;
  }
  console.error(
    "\n[vendor-sync] Committed vendor files are out of date with tools/vendor-sync.mjs.\n" +
      "[vendor-sync] Run `npm run build` and commit ALL of ui/vendor/ and site/ui/vendor/.",
  );
}

// ── CLI entry ─────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && (
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) ||
  process.argv[1].endsWith("vendor-sync.mjs")
);

if (isMain) {
  if (process.argv.includes("--check")) {
    const records = await checkVendorSyncFreshness();
    reportDrift(records);
    process.exit(records.every((r) => r.status === "ok") ? 0 : 1);
  }

  const silent = process.argv.includes("--silent");
  console.log("[vendor-sync] Syncing vendor files to ui/vendor/ …");
  const { ok, results } = await syncVendorFiles({ silent });
  if (!ok) {
    const failed = results.filter((r) => !r.source).map((r) => r.name);
    console.warn(`[vendor-sync] Some files could not be synced: ${failed.join(", ")}`);
    console.warn("[vendor-sync] The server will fall back to CDN for those files.");
  } else {
    console.log(`[vendor-sync] Done — ${results.length} vendor files ready in ui/vendor/`);
  }
}
