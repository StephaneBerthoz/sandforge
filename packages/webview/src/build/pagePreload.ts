/**
 * Which files each page of the panel needs before it paints, written by the
 * build for the extension, which links them in the panel's shell as
 * `<link rel="modulepreload">` so that the webview fetches them all at once.
 *
 * The panel is built as a library, which links no preload: the shell loads
 * index.js, index.js imports the page's chunk once it runs, and a chunk's own
 * imports are found only once it is parsed. Forge's first paint waited on 4
 * such rounds of fetches, 28 files, Sync's on 4 rounds and 49 files, behind an
 * empty page; a round is a few milliseconds from a local disk, and a network
 * round trip on a remote workspace.
 */

/** A route of src/PanelRouter.tsx: its page's module, and the English it names. */
export interface PageRoute {
  route: string;
  /** The page's module as PanelRouter imports it, e.g. `./pages/Forge/ForgePage`. */
  module: string;
  english: string[];
}

/** What the build tells of one of its chunks: the bundler's own output metadata. */
export interface BuiltChunk {
  fileName: string;
  isEntry: boolean;
  /** The chunks it imports up front. */
  imports: readonly string[];
  /** The modules it holds. */
  moduleIds: readonly string[];
}

/**
 * The routes of src/PanelRouter.tsx, read from its source: each `page()`
 * call's route, the module it imports and the namespaces it names.
 *
 * @param source - The text of PanelRouter.tsx.
 */
export function pageRoutes(source: string): PageRoute[] {
  const call =
    /([A-Za-z_$][\w$]*)\s*:\s*page\(\s*\(\)\s*=>\s*import\(\s*'([^']+)'\s*\)\s*,\s*'\w+'\s*,\s*\[([^\]]*)\]/g;
  return [...source.matchAll(call)].map((match) => ({
    route: match[1],
    module: match[2],
    english: [...match[3].matchAll(/'(\w+)'/g)].map((name) => name[1]),
  }));
}

/** The id the module of a namespace of the English catalogue has (vite.config.ts `englishCatalogue`). */
export function englishModuleId(namespace: string): string {
  return `\0virtual:english-catalogue/${namespace}`;
}

/**
 * For each route, the files a panel showing it fetches before its page
 * paints, the panel bundle aside (the shell's script tag loads it): what the
 * bundle imports up front, the chunk holding the page and what it imports up
 * front, and the chunks of the English the route names. Posix paths relative
 * to `webview-dist`, sorted.
 *
 * @param routes - From {@link pageRoutes}.
 * @param chunks - The build's chunks.
 * @param pageModuleIds - The ids a route's page module may have in the build
 *   (its absolute path, with each extension the source may use).
 * @returns The manifest, and what could not be placed: a route whose page no
 *   chunk holds, a namespace no chunk holds.
 */
export function pagePreloadManifest(
  routes: readonly PageRoute[],
  chunks: readonly BuiltChunk[],
  pageModuleIds: (route: PageRoute) => readonly string[],
): { manifest: Record<string, string[]>; unplaced: string[] } {
  const byFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  // Read with forward slashes on both sides: on Windows `path.resolve` gives
  // the page `D:\a\…\HomePage.tsx` and the bundler holds `D:/a/…/HomePage.tsx`,
  // and the build stopped, no chunk holding any page.
  const slashed = (id: string): string => id.split('\\').join('/');
  const holding = (id: string): BuiltChunk | undefined =>
    chunks.find((chunk) => chunk.moduleIds.some((held) => slashed(held) === slashed(id)));
  const closure = (fileName: string, into: Set<string>): void => {
    if (into.has(fileName)) return;
    into.add(fileName);
    for (const imported of byFile.get(fileName)?.imports ?? []) closure(imported, into);
  };
  const entry = chunks.find((chunk) => chunk.isEntry);
  const manifest: Record<string, string[]> = {};
  const unplaced: string[] = [];
  for (const route of routes) {
    const files = new Set<string>();
    if (entry) closure(entry.fileName, files);
    const page = pageModuleIds(route)
      .map((id) => holding(id))
      .find((chunk) => chunk !== undefined);
    if (page) closure(page.fileName, files);
    else unplaced.push(`the page of route "${route.route}" (${route.module})`);
    for (const namespace of route.english) {
      const english = holding(englishModuleId(namespace));
      // A namespace the shell holds has no chunk of its own, and needs none.
      if (english) closure(english.fileName, files);
    }
    if (entry) files.delete(entry.fileName);
    manifest[route.route] = [...files].sort();
  }
  return { manifest, unplaced };
}
