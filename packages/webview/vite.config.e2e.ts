import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

/**
 * Vite config for E2E testing.
 *
 * Unlike the main config (which builds an IIFE library for the VSCode webview),
 * this config runs a standard SPA dev server suitable for Playwright tests.
 *
 * Framer Motion's LazyMotion `strict` mode throws in development when `motion`
 * components are used instead of `m` (a pre-existing issue in the codebase).
 * We exclude framer-motion from dep optimization and patch it via a transform
 * plugin so the invariant becomes a warning instead of a throw.
 */
export default defineConfig({
  plugins: [
    {
      name: 'patch-framer-motion-strict',
      enforce: 'pre',
      transform(code: string, id: string) {
        if (!id.includes('framer-motion')) {
          return null;
        }
        if (code.includes('break tree shaking')) {
          const patched = code.replace(
            /configAndProps\.ignoreStrict\s*\?\s*warning\(false,\s*strictMessage\)\s*:\s*invariant\(false,\s*strictMessage\)/g,
            'warning(false, strictMessage)',
          );
          if (patched !== code) {
            return { code: patched, map: null };
          }
        }
        return null;
      },
    },
    react(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Map @sandforge/shared to its SOURCE (not its CommonJS dist) so Vite
      // serves ESM modules end-to-end and named exports like PROTOCOL_VERSION
      // resolve correctly at runtime. The dist/ build is CJS (tsc default +
      // no "type": "module"), which Vite cannot reliably re-export via
      // `export * from './bridge/protocolVersion.js'` at runtime.
      '@sandforge/shared': path.resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('development'),
  },
  optimizeDeps: {
    // Exclude framer-motion from pre-bundling so our transform plugin can patch it
    exclude: ['framer-motion'],
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
