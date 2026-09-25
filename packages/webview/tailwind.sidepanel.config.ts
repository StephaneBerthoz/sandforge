import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The files Tailwind scans for the sidebar's stylesheet (src/sidepanel.css,
 * which names this file with `@config`): those the sidebar can render and
 * nothing else. The theme is the panel's, in src/styles/theme.css.
 *
 * Tailwind emits a utility for every class it finds in `content`, whatever the
 * bundle imports. With the panel's `./src/**` the sidebar stylesheet carried
 * the utilities of every page — 72.6 kB against the panel's 79.6 kB; 24.7 kB
 * without them — for a view that renders a launcher, on every VS Code start.
 * The list below is the sidebar's import graph, walked from its entry at build
 * time, so a component the sidebar starts to use brings its classes with it.
 */

const SRC = path.resolve(__dirname, 'src');
const ENTRY = path.join(SRC, 'main.sidepanel.tsx');

/** `from './x'`, `import './x'` and `import('./x')`: the relative specifiers. */
const SPECIFIER =
  /\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]|\bimport\s+['"](\.{1,2}\/[^'"]+)['"]|\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;

/** The source file a relative specifier names, or undefined (a stylesheet, a JSON). */
function resolveSource(spec: string, from: string): string | undefined {
  const base = path.resolve(path.dirname(from), spec);
  return [
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ].find((candidate) => existsSync(candidate));
}

/**
 * Every source file the sidebar entry reaches through relative imports, type
 * imports included: an extra file only adds classes, a missing one drops them.
 */
export function sidepanelSources(entry: string = ENTRY): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
      const next = resolveSource(match[1] ?? match[2] ?? match[3], file);
      if (next !== undefined) queue.push(next);
    }
  }
  return [...seen].sort();
}

export default { content: sidepanelSources() };
