import { build } from 'esbuild';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, copyFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const VENDOR_DIR = resolve(ROOT, 'ui', 'vendor');
const SITE_VENDOR_DIR = resolve(ROOT, 'site', 'ui', 'vendor');

mkdirSync(VENDOR_DIR, { recursive: true });
mkdirSync(SITE_VENDOR_DIR, { recursive: true });

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

const entries = [
  {
    label: '@mui/material',
    outfile: resolve(VENDOR_DIR, 'mui-material.js'),
    stdin: {
      contents: "export * from '@mui/material';",
      resolveDir: ROOT,
      loader: 'js',
    },
  },
  {
    label: '@emotion/react',
    outfile: resolve(VENDOR_DIR, 'emotion-react.js'),
    stdin: {
      contents: "export * from '@emotion/react';",
      resolveDir: ROOT,
      loader: 'js',
    },
  },
  {
    label: '@emotion/styled',
    outfile: resolve(VENDOR_DIR, 'emotion-styled.js'),
    stdin: {
      contents: "export { default } from '@emotion/styled'; export * from '@emotion/styled';",
      resolveDir: ROOT,
      loader: 'js',
    },
  },
];

let ok = true;
for (const { label, outfile, stdin } of entries) {
  try {
    const result = await build({ ...sharedOpts, outfile, stdin });
    const warnings = result.warnings?.length || 0;
    console.log('  ✓ ' + label);
  } catch (err) {
    console.error('  ✗ ' + label + err.message);
    ok = false;
  }
}

if (!ok) {
  console.error('\n[build-vendor-mui] Some bundles failed — portal MUI may not work.');
  process.exit(1);
}
for (const { outfile } of entries) {
  copyFileSync(outfile, resolve(SITE_VENDOR_DIR, basename(outfile)));
}
console.log('\n[build-vendor-mui] All MUI vendor bundles ready in ui/vendor and site/ui/vendor.');
