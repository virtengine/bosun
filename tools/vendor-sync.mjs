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
import { resolve, dirname, join, relative, sep } from "node:path";
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
export async function syncVendorFiles({ silent = false, outDir = VENDOR_DIR, allowNetwork = true } = {}) {
  mkdirSync(outDir, { recursive: true });

  const log = silent ? () => {} : (...a) => console.log("[vendor-sync]", ...a);
  const warn = (...a) => console.warn("[vendor-sync] WARN:", ...a);

  const results = [];

  for (const entry of VENDOR_MANIFEST) {
    const destPath = resolve(outDir, entry.name);

    // ── 1. Try node_modules ──────────────────────────────────────────────────
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
export async function checkVendorSyncFreshness({ committedDir } = {}) {
  const roots = committedDir ? [committedDir] : [VENDOR_DIR, SITE_VENDOR_DIR];

  const scratch = mkdtempSync(join(tmpdir(), "bosun-vendor-sync-check-"));
  try {
    const builtDir = join(scratch, "ui", "vendor");
    const { results } = await syncVendorFiles({ silent: true, outDir: builtDir, allowNetwork: false });

    // An entry the generator could not resolve offline has no expected bytes.
    // Surface it as such rather than letting it read as fresh.
    const unvended = new Set(results.filter((r) => r.source === null).map((r) => r.name));

    return roots.flatMap((root) =>
      compareVendorFiles({ builtDir, committedDir: root }).map((record) => ({
        ...(unvended.has(record.name) ? { status: "unvended" } : record),
        root: relative(ROOT, root).split(sep).join("/"),
      })),
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
    } else {
      detail = `${record.committedBytes} bytes committed vs ${record.expectedBytes} bytes generated`;
    }
    console.error(`  ✗ ${record.root}/${record.name} — ${detail}`);
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
