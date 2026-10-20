import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { readFileSync } from 'fs';

const pkg = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, 'package.json'), 'utf-8'),
) as {
  version: string;
};

/**
 * The two bundles of the VSCode webview, built in two passes (see the
 * package.json build script):
 *   vite build                  → assets/index.js + assets/style.css + assets/chunks/*.js
 *                                 (panel bundle, entry src/main.tsx, an ES module
 *                                 that loads each page as a chunk of its own)
 *   vite build --mode sidepanel → assets/sidepanel.js + assets/sidepanel.css
 *                                 (sidebar-only bundle, entry src/main.sidepanel.tsx,
 *                                 a single IIFE file)
 * The sidepanel pass uses emptyOutDir:false so it doesn't wipe the first pass.
 * The four names are what the extension links to — see `assetFileNames`; the
 * chunks are what index.js imports, and scripts/check-webview-assets.mjs
 * follows those imports into the build and the VSIX.
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
        /* The panel shell loads index.js as a module script, which is what
           lets it import a page's chunk when the page is first shown. The
           sidebar needs no page, and stays one classic script. */
        formats: [isSidepanel ? 'iife' : 'es'],
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
          /* The sidebar is one file. The panel bundle splits a chunk per
             page: the CSP lets a module the nonced script imports run, and
             localResourceRoots keeps every fetch inside webview-dist. Vite
             leaves the whitespace of an ES library in place for the bundler
             of whoever installs it; this one is run as it is, so it is
             minified in full, as the IIFE was. */
          ...(isSidepanel
            ? { codeSplitting: false }
            : {
                minify: true,
                /* zod and the module that turns its compiler off share a
                   chunk. A chunk's imports run before it, so the shared
                   schemas, built as their chunks load, ran ahead of
                   zodJitless in index.js: each one probed `new Function` and
                   the CSP reported a script-src eval at every panel start.
                   In zod's chunk, the call runs right after zod and before
                   any chunk that imports it. */
                codeSplitting: {
                  groups: [
                    {
                      name: 'zod',
                      test: /node_modules[\\/]zod[\\/]|[\\/]src[\\/]zodJitless\.ts$/,
                      priority: 10,
                    },
                  ],
                },
              }),
          chunkFileNames: 'assets/chunks/[name]-[hash].js',
        },
      },
      cssCodeSplit: false,
    },
    resolve: {
      alias: [
        { find: '@', replacement: path.resolve(import.meta.dirname, './src') },
        /* Map @sandforge/shared to TypeScript source so Vite can bundle value exports */
        {
          find: '@sandforge/shared',
          replacement: path.resolve(import.meta.dirname, '../shared/src/index.ts'),
        },
        /* The sidebar's English is its own namespaces of the catalogue, not
           all of it: see src/i18n/sidepanelCatalogue.ts. */
        ...(isSidepanel
          ? [
              {
                find: /^\.\/locales\/en\.json$/,
                replacement: path.resolve(import.meta.dirname, 'src/i18n/sidepanelCatalogue.ts'),
              },
            ]
          : []),
      ],
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
  };
});
