import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { englishModuleId, pagePreloadManifest, pageRoutes } from './pagePreload';
import type { BuiltChunk } from './pagePreload';

const ROUTER = readFileSync(join(__dirname, '..', 'PanelRouter.tsx'), 'utf8');

describe('pageRoutes', () => {
  it('reads every route of the panel router, with the module and the English it names', () => {
    const routes = pageRoutes(ROUTER);

    // One per page() call: a route this reads past is linked nothing.
    expect(routes).toHaveLength((ROUTER.match(/\bpage\(\s*\(\)\s*=>\s*import\(/g) ?? []).length);
    expect(routes.find((route) => route.route === 'forge')).toEqual({
      route: 'forge',
      module: './pages/Forge/ForgePage',
      english: expect.arrayContaining(['forge', 'errors']),
    });
    expect(routes.find((route) => route.route === 'grappe')?.english).toEqual(['grappe']);
  });
});

describe('pagePreloadManifest', () => {
  const chunk = (fileName: string, imports: string[], moduleIds: string[] = []): BuiltChunk => ({
    fileName,
    isEntry: fileName === 'assets/index.js',
    imports,
    moduleIds,
  });
  const chunks = [
    chunk('assets/index.js', ['assets/chunks/react.js'], ['/src/main.tsx']),
    chunk('assets/chunks/react.js', []),
    chunk(
      'assets/chunks/ForgePage.js',
      ['assets/chunks/react.js', 'assets/chunks/Button.js'],
      ['/src/pages/Forge/ForgePage.tsx'],
    ),
    chunk('assets/chunks/Button.js', ['assets/chunks/icon.js']),
    chunk('assets/chunks/icon.js', []),
    // A step the page loads on demand: not needed before it paints.
    chunk(
      'assets/chunks/ForgeReview.js',
      ['assets/chunks/graph.js'],
      ['/src/pages/Forge/ForgeReview.tsx'],
    ),
    chunk('assets/chunks/forge.js', [], [englishModuleId('forge')]),
  ];
  const ids = (route: { module: string }): string[] => [`/src${route.module.slice(1)}.tsx`];

  it('finds a page whose id the bundler and the path module write with different slashes, as on Windows', () => {
    const windows = [
      chunk('assets/index.js', [], ['D:/a/sandforge/src/main.tsx']),
      chunk('assets/chunks/HomePage.js', [], ['D:/a/sandforge/src/pages/Home/HomePage.tsx']),
    ];

    const { manifest, unplaced } = pagePreloadManifest(
      [{ route: 'home', module: './pages/Home/HomePage', english: [] }],
      windows,
      () => ['D:\\a\\sandforge\\src\\pages\\Home\\HomePage.tsx'],
    );

    expect(unplaced).toEqual([]);
    expect(manifest).toEqual({ home: ['assets/chunks/HomePage.js'] });
  });

  it("lists what the panel bundle imports up front, the page's chunk and its imports, and its English", () => {
    const { manifest, unplaced } = pagePreloadManifest(
      [{ route: 'forge', module: './pages/Forge/ForgePage', english: ['forge', 'common'] }],
      chunks,
      ids,
    );

    expect(unplaced).toEqual([]);
    expect(manifest).toEqual({
      forge: [
        'assets/chunks/Button.js',
        'assets/chunks/ForgePage.js',
        'assets/chunks/forge.js',
        'assets/chunks/icon.js',
        'assets/chunks/react.js',
      ],
    });
  });

  it('says which route no chunk holds the page of', () => {
    const { unplaced } = pagePreloadManifest(
      [{ route: 'ghost', module: './pages/Ghost/GhostPage', english: [] }],
      chunks,
      ids,
    );

    expect(unplaced).toEqual(['the page of route "ghost" (./pages/Ghost/GhostPage)']);
  });
});
