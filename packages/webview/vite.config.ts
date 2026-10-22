import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { readFileSync } from 'fs';
import { pagePreloadManifest, pageRoutes, type BuiltChunk } from './src/build/pagePreload.ts';

const pkg = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, 'package.json'), 'utf-8'),
) as {
  version: string;
};

/** The English catalogue, the one language the webview carries. */
const ENGLISH_CATALOGUE = path.resolve(import.meta.dirname, 'src/i18n/locales/en.json');

/** The English every panel starts with, the namespaces its shell renders. */
const PANEL_CATALOGUE = path.resolve(import.meta.dirname, 'src/i18n/panelCatalogue.ts');

/** The module of the loaders, one per namespace. */
const ENGLISH_LOADERS_MODULE = 'virtual:english-catalogue';

/**
 * The namespaces a panel starts with: those `src/i18n/panelCatalogue.ts`
 * exports, read from its `export default { … }`.
 *
 * @param source - The text of panelCatalogue.ts.
 */
function panelShellNamespaces(source: string): string[] {
  const body = /export\s+default\s*\{([^}]*)\}/.exec(source);
  return body
    ? body[1]
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
        .sort()
    : [];
}

/**
 * The English catalogue as one module per namespace, and a module of their
 * loaders (src/i18n/englishNamespaces.ts loads a page's with the page).
 *
 * Every panel parsed the whole catalogue before its page could paint, about
 * 270 kB of it for a page that renders a few of its 37 namespaces. A JSON
 * file is one module however its namespaces are imported, and a module goes
 * whole into the chunk its importers share: named imports from several pages
 * would have put every namespace any of them reads back in the base. Each
 * namespace is a module of its own here, and the chunk of each holds it alone.
 *
 * The namespaces of the panel's shell have no loader. A panel holds them from
 * the start (panelCatalogue.ts), and a namespace held is never asked for, so
 * their chunks were built, shipped in the VSIX and never fetched: 9 kB the
 * loaders' map alone referenced.
 */
export function englishCatalogue(): Plugin {
  const prefix = `${ENGLISH_LOADERS_MODULE}/`;
  const read = (): Record<string, unknown> =>
    JSON.parse(readFileSync(ENGLISH_CATALOGUE, 'utf-8')) as Record<string, unknown>;
  return {
    name: 'sandforge-english-catalogue',
    resolveId(id) {
      return id === ENGLISH_LOADERS_MODULE || id.startsWith(prefix) ? `\0${id}` : null;
    },
    load(id) {
      if (!id.startsWith(`\0${ENGLISH_LOADERS_MODULE}`)) return null;
      this.addWatchFile(ENGLISH_CATALOGUE);
      const catalogue = read();
      if (id === `\0${ENGLISH_LOADERS_MODULE}`) {
        this.addWatchFile(PANEL_CATALOGUE);
        const shell = panelShellNamespaces(readFileSync(PANEL_CATALOGUE, 'utf-8'));
        if (shell.length === 0) {
          this.error(`no namespace read from the default export of ${PANEL_CATALOGUE}`);
        }
        const loaders = Object.keys(catalogue)
          .filter((namespace) => !shell.includes(namespace))
          .map(
            (namespace) =>
              `  ${JSON.stringify(namespace)}: () => import(${JSON.stringify(prefix + namespace)}),`,
          );
        return `export const englishNamespaceLoaders = {\n${loaders.join('\n')}\n};\n`;
      }
      const namespace = id.slice(prefix.length + 1);
      if (!(namespace in catalogue)) {
        this.error(`the English catalogue has no namespace "${namespace}"`);
      }
      return `export default ${JSON.stringify(catalogue[namespace])};\n`;
    },
  };
}

/**
 * The panel's routes, each a page loaded the first time it is shown. Spelled
 * in segments: src/knipGate.test.ts takes a quoted source path here for a
 * build entry.
 */
const PANEL_ROUTER = path.resolve(import.meta.dirname, 'src', 'PanelRouter.tsx');

/** Where the extension reads what each page needs before it paints. */
const PAGE_PRELOAD_FILE = 'assets/preload.json';

/**
 * What each page needs before it paints, by route, written beside the panel
 * bundle (src/build/pagePreload.ts). The extension links those files in the
 * panel's shell, where the webview fetches them all at once instead of one
 * round of imports after another.
 */
export function pagePreload(): Plugin {
  return {
    name: 'sandforge-page-preload',
    apply: 'build',
    generateBundle(_options, bundle) {
      this.addWatchFile(PANEL_ROUTER);
      const routes = pageRoutes(readFileSync(PANEL_ROUTER, 'utf-8'));
      if (routes.length === 0) this.error(`no page() route read from ${PANEL_ROUTER}`);
      const chunks: BuiltChunk[] = Object.values(bundle).flatMap((output) =>
        output.type === 'chunk' ? [output] : [],
      );
      const { manifest, unplaced } = pagePreloadManifest(routes, chunks, (route) => {
        const file = path.resolve(path.dirname(PANEL_ROUTER), route.module);
        return [`${file}.tsx`, `${file}.ts`];
      });
      if (unplaced.length > 0) this.error(`no chunk holds ${unplaced.join(', ')}`);
      this.emitFile({
        type: 'asset',
        fileName: PAGE_PRELOAD_FILE,
        source: `${JSON.stringify(manifest, null, 1)}\n`,
      });
    },
  };
}

/**
 * zod as the webview imports it: through src/zodJitless.ts, which turns zod's
 * compiler off before any importer builds a schema. The module that turns it
 * off is the module importers get zod from, so no entry has to load zod
 * first: a page that validates nothing no longer parses it.
 */
export const ZOD_WITHOUT_EVAL = {
  find: /^zod$/,
  replacement: path.resolve(import.meta.dirname, 'src/zodJitless.ts'),
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
    plugins: [react(), englishCatalogue(), ...(isSidepanel ? [] : [pagePreload()])],
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
                   any chunk that imports it; zod is imported through it
                   (ZOD_WITHOUT_EVAL), so the chunk loads with the first
                   page that validates and with no other. */
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
        ZOD_WITHOUT_EVAL,
        /* The English a webview starts with is its own namespaces of the
           catalogue, not all of it: the sidebar's
           (src/i18n/sidepanelCatalogue.ts), or those of the panel's shell
           (src/i18n/panelCatalogue.ts), each page's coming with it. */
        {
          find: /^\.\/locales\/en\.json$/,
          replacement: path.resolve(
            import.meta.dirname,
            isSidepanel ? 'src/i18n/sidepanelCatalogue.ts' : 'src/i18n/panelCatalogue.ts',
          ),
        },
      ],
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
  };
});
