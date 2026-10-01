import { build } from 'esbuild';
import { resolve, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, copyFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, '..');
const VENDOR_DIR = resolve(ROOT, 'ui', 'vendor');
const SITE_VENDOR_DIR = resolve(ROOT, 'site', 'ui', 'vendor');

// Shared externals — resolved at runtime via the page import-map
const EXTERNALS = ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'];

const sharedOpts = {
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  external: EXTERNALS,
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  // Suppress "Could not resolve …" warnings for optional/peer deps
  logLevel: 'warning',
};

/**
 * The bundle set, in a stable order. `label` is what the build logs; `name` is
 * the filename written under both vendor roots. Exported so the freshness guard
 * and its test never hard-code a second, diverging copy of this list.
 */
export const BUNDLE_ENTRIES = [
  {
    label: '@mui/material',
    name: 'mui-material.js',
    stdin: {
      contents: "export * from '@mui/material';",
      resolveDir: ROOT,
      loader: 'js',
    },
  },
  {
    label: '@emotion/react',
    name: 'emotion-react.js',
    stdin: {
      contents: "export * from '@emotion/react';",
      resolveDir: ROOT,
      loader: 'js',
    },
  },
  {
    label: '@emotion/styled',
    name: 'emotion-styled.js',
    stdin: {
      contents: "export { default } from '@emotion/styled'; export * from '@emotion/styled';",
      resolveDir: ROOT,
      loader: 'js',
    },
  },
];

/**
 * Build every bundle into `outDir`, then mirror it into `siteOutDir`.
 *
 * The site mirror is written only after every bundle built successfully, so a
 * partial esbuild failure can never leave `ui/vendor` and `site/ui/vendor`
 * disagreeing — the exact skew this generator exists to prevent.
 *
 * Callers that must not touch the committed tree (the freshness guard, the
 * test) pass throwaway directories — the esbuild invocation and its output are
 * byte-for-byte the same either way, so the guard exercises the real generator.
 */
export async function buildVendorMui({ outDir = VENDOR_DIR, siteOutDir = SITE_VENDOR_DIR, silent = false } = {}) {
  mkdirSync(outDir, { recursive: true });
  mkdirSync(siteOutDir, { recursive: true });

  const log = silent ? () => {} : (...a) => console.log(...a);
  const logError = silent ? () => {} : (...a) => console.error(...a);
  const failures = [];

  for (const { label, name, stdin } of BUNDLE_ENTRIES) {
    try {
      await build({ ...sharedOpts, outfile: join(outDir, name), stdin });
      log('  ✓ ' + label);
    } catch (err) {
      logError('  ✗ ' + label + err.message);
      failures.push({ label, name, error: err.message });
    }
  }

  if (failures.length > 0) {
    return { ok: false, failures };
  }

  for (const { name } of BUNDLE_ENTRIES) {
    copyFileSync(join(outDir, name), join(siteOutDir, name));
  }
  return { ok: true, failures };
}

/**
 * Compare the bundles currently on disk against a freshly built set.
 *
 * Returns one record per entry so a caller can report every drifted file at
 * once instead of stopping at the first. `status` is one of:
 *   'ok'       — committed bytes match the generator output
 *   'missing'  — the committed file is absent
 *   'differs'  — the committed file exists but the bytes differ
 */
export function compareBundles({ builtDir, committedDir = VENDOR_DIR } = {}) {
  return BUNDLE_ENTRIES.map(({ label, name }) => {
    const expected = readFileSync(join(builtDir, name));
    const committedPath = join(committedDir, name);
    let committed;
    try {
      committed = readFileSync(committedPath);
    } catch {
      return { label, name, status: 'missing', expectedBytes: expected.length, committedBytes: 0 };
    }
    const status = committed.equals(expected) ? 'ok' : 'differs';
    return { label, name, status, expectedBytes: expected.length, committedBytes: committed.length };
  });
}

/**
 * Build the bundles into a temporary directory and diff them against the
 * committed copies without writing anything into `ui/vendor` or
 * `site/ui/vendor`.
 *
 * Pass `committedDir` to check one of the two roots; omit it to check BOTH,
 * which is what the CI guard needs — a partial regeneration that updates
 * `ui/vendor` but leaves `site/ui/vendor` stale is the skew that would otherwise
 * pass unnoticed.
 */
export async function checkVendorMuiFreshness({ committedDir } = {}) {
  const roots = committedDir
    ? [committedDir]
    : [VENDOR_DIR, SITE_VENDOR_DIR];

  const scratch = mkdtempSync(join(tmpdir(), 'bosun-vendor-mui-check-'));
  try {
    const builtDir = join(scratch, 'ui', 'vendor');
    const { ok, failures } = await buildVendorMui({
      outDir: builtDir,
      siteOutDir: join(scratch, 'site', 'ui', 'vendor'),
      silent: true,
    });
    if (!ok) {
      const error = new Error(
        `[build-vendor-mui] could not rebuild bundles: ${failures.map((f) => `${f.label}: ${f.error}`).join('; ')}`,
      );
      error.failures = failures;
      throw error;
    }
    // Tag each record with the root it came from so the report names the
    // directory that actually drifted.
    return roots.flatMap((root) =>
      compareBundles({ builtDir, committedDir: root }).map((record) => ({
        ...record,
        root: relative(ROOT, root).split(sep).join('/'),
      })),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function reportDrift(records) {
  const drifted = records.filter((r) => r.status !== 'ok');
  if (drifted.length === 0) {
    console.log('[build-vendor-mui] Committed bundles match the generator output ✓');
    return;
  }
  for (const record of drifted) {
    const detail =
      record.status === 'missing'
        ? 'not committed'
        : `${record.committedBytes} bytes committed vs ${record.expectedBytes} bytes generated`;
    console.error(`  ✗ ${record.root}/${record.name} (${record.label}) — ${detail}`);
  }
  console.error(
    '\n[build-vendor-mui] Committed bundles are out of date with tools/build-vendor-mui.mjs.\n' +
      '[build-vendor-mui] Run `npm run build:vendor-mui` and commit ALL of ui/vendor/ and site/ui/vendor/.',
  );
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  if (process.argv.includes('--check')) {
    const records = await checkVendorMuiFreshness();
    reportDrift(records);
    process.exit(records.every((r) => r.status === 'ok') ? 0 : 1);
  }

  const { ok, failures } = await buildVendorMui();
  if (!ok) {
    console.error('\n[build-vendor-mui] Some bundles failed — portal MUI may not work.');
    process.exit(1);
  }
  console.log('\n[build-vendor-mui] All MUI vendor bundles ready in ui/vendor and site/ui/vendor.');
}