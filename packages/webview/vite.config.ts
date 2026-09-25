import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import autoprefixer from 'autoprefixer';
import tailwindcss from 'tailwindcss';
import path from 'path';
import { readFileSync } from 'fs';

const pkg = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, 'package.json'), 'utf-8'),
) as {
  version: string;
};

/**
 * Single-file IIFE bundles for the VSCode webview — no ES module imports.
 *
 * The bundler cannot emit several IIFE inputs from one build that splits no
 * code, so the build runs TWICE (see the package.json build script):
 *   vite build                  → assets/index.js + assets/style.css
 *                                 (full panel bundle, entry src/main.tsx)
 *   vite build --mode sidepanel → assets/sidepanel.js + assets/sidepanel.css
 *                                 (sidebar-only bundle, entry src/main.sidepanel.tsx)
 * The sidepanel pass uses emptyOutDir:false so it doesn't wipe the first pass.
 * Those four names are what the extension links to — see `assetFileNames`.
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
        entry: path.resolve(
          import.meta.dirname,
          isSidepanel ? 'src/main.sidepanel.tsx' : 'src/main.tsx',
        ),
        name: 'SandForge',
        formats: ['iife'],
        fileName: () => (isSidepanel ? 'assets/sidepanel.js' : 'assets/index.js'),
      },
      rolldownOptions: {
        output: {
          /*
           * The stylesheet names are a CONTRACT with the extension: the HTML
           * shell links `assets/style.css` from a panel and
           * `assets/sidepanel.css` from the sidebar
           * (providers/WebviewPanelManager.ts, providers/SidebarViewProvider.ts).
           * They are pinned here, by extension rather than by the name Vite
           * chose, because that name is not ours: Vite 5 called the lib-mode
           * stylesheet `style.css` and Vite 6 calls it after the package
           * (`webview.css`). The old branch tested for `style.css` exactly, so
           * the upgrade silently (a) stopped giving the sidebar its own file
           * and (b) emitted a name neither `<link>` asks for — every webview
           * of 1.23.0 loaded with no CSS at all. The two names must also
           * differ: both passes write into the same `dist`, and the second
           * would overwrite the first. `scripts/check-webview-assets.mjs`
           * checks that every path the extension requests is a file the build
           * produced.
           */
          assetFileNames: (assetInfo) => {
            const name = assetInfo.names?.[0] ?? assetInfo.name ?? '';
            if (name.endsWith('.css')) {
              return isSidepanel ? 'assets/sidepanel.css' : 'assets/style.css';
            }
            return 'assets/[name].[ext]';
          },
          /* Inline everything — webview CSP blocks dynamic imports. Rolldown
             names this codeSplitting; the inlineDynamicImports Rollup took
             is ignored under Vite 8, with a warning. */
          codeSplitting: false,
        },
      },
      cssCodeSplit: false,
    },
    /*
     * The panel pass reads postcss.config.cjs, whose Tailwind scans all of
     * src. The sidebar pass scans only what the sidebar renders
     * (tailwind.sidepanel.config.ts): otherwise every page's utilities ship
     * in the stylesheet the activity bar loads at every start.
     */
    ...(isSidepanel
      ? {
          css: {
            postcss: {
              plugins: [
                tailwindcss({
                  config: path.resolve(import.meta.dirname, 'tailwind.sidepanel.config.ts'),
                }),
                autoprefixer(),
              ],
            },
          },
        }
      : {}),
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, './src'),
        /* Map @sandforge/shared to TypeScript source so Vite can bundle value exports */
        '@sandforge/shared': path.resolve(import.meta.dirname, '../shared/src/index.ts'),
      },
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
  };
});
