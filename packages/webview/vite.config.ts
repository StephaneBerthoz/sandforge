import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')) as { version: string };

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    /* Single-file IIFE bundle for VSCode webview — no ES module imports */
    lib: {
      entry: path.resolve(__dirname, 'src/main.tsx'),
      name: 'SandForge',
      formats: ['iife'],
      fileName: () => 'assets/index.js',
    },
    rollupOptions: {
      output: {
        assetFileNames: 'assets/[name].[ext]',
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
});
