import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')) as {
  version: string;
};

/**
 * Single-file IIFE bundles for the VSCode webview — no ES module imports.
 *
 * Rollup cannot emit multiple IIFE inputs with inlineDynamicImports, so the
 * build runs TWICE (see the package.json build script):
 *   vite build                  → assets/index.js      (full panel bundle, entry src/main.tsx)
 *   vite build --mode sidepanel → assets/sidepanel.js  (sidebar-only bundle, entry src/main.sidepanel.tsx)
 * The sidepanel pass uses emptyOutDir:false so it doesn't wipe the first pass.
 */
export default defineConfig(({ mode }) => {
  const isSidepanel = mode === 'sidepanel';
  return {
    plugins: [react()],
    build: {
      outDir: 'dist',
      /* Default pass empties dist; the sidepanel pass must keep index.js */
      emptyOutDir: !isSidepanel,
      lib: {
        entry: path.resolve(__dirname, isSidepanel ? 'src/main.sidepanel.tsx' : 'src/main.tsx'),
        name: 'SandForge',
        formats: ['iife'],
        fileName: () => (isSidepanel ? 'assets/sidepanel.js' : 'assets/index.js'),
      },
      rollupOptions: {
        output: {
          /* The sidebar graph excludes page-only CSS (reactflow …), so its
             stylesheet differs from the panels' — emit it under its own name. */
          assetFileNames: (assetInfo) =>
            isSidepanel && assetInfo.name === 'style.css'
              ? 'assets/sidepanel.css'
              : 'assets/[name].[ext]',
          /* Inline everything — webview CSP blocks dynamic imports */
          inlineDynamicImports: true,
        },
      },
      cssCodeSplit: false,
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        /* Map @sandforge/shared to TypeScript source so Vite can bundle value exports */
        '@sandforge/shared': path.resolve(__dirname, '../shared/src/index.ts'),
      },
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      __APP_VERSION__: JSON.stringify(pkg.version),
      /* Falsy in prod: main.tsx's LazyE2EHarness ternary is compile-time dead,
         so E2EHarness is tree-shaken out of the IIFE bundle. */
      'import.meta.env.VITE_E2E': JSON.stringify(''),
    },
  };
});
