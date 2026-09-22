import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import loadConfig from 'tailwindcss/loadConfig';
import ts from 'typescript';
import { describe, it, expect } from 'vitest';

/**
 * What the sidebar entry pulls into `assets/sidepanel.js` and `sidepanel.css`.
 *
 * The sidebar is the one bundle every VS Code window with SandForge installed
 * loads, so its entry keeps the panel surface out. It used to wrap SidePanel in
 * the motion provider — framer-motion's DOM animation engine — for a tree with
 * no animated component in it: the engine was parsed on every launch to drive
 * nothing. The walk follows value imports from the entry, as the bundler does,
 * and lists the packages they reach. The stylesheet had the same leak by
 * another road: Tailwind scanned every page for classes.
 */

const SRC = join(__dirname);
const ENTRY = join(SRC, 'main.sidepanel.tsx');
const SIDEPANEL_TAILWIND = join(SRC, '..', 'tailwind.sidepanel.config.ts');

/** The file a relative specifier names, or undefined for a non-source import (CSS). */
function resolveLocal(spec: string, from: string): string | undefined {
  const base = resolve(dirname(from), spec);
  return [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')].find(
    (candidate) => existsSync(candidate),
  );
}

/** Specifiers of the value imports and re-exports in `file` (type-only ones bundle nothing). */
function valueImports(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const specs: string[] = [];
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      !statement.importClause?.isTypeOnly &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specs.push(statement.moduleSpecifier.text);
    }
    if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specs.push(statement.moduleSpecifier.text);
    }
  }
  return specs;
}

/** Every source file the entry reaches, and every package any of them imports. */
function sidebarGraph(): { files: Set<string>; packages: Map<string, string> } {
  const files = new Set<string>();
  const packages = new Map<string, string>();
  const queue = [ENTRY];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of valueImports(file)) {
      if (spec.startsWith('.')) {
        const next = resolveLocal(spec, file);
        if (next !== undefined) queue.push(next);
      } else if (!packages.has(spec)) {
        packages.set(spec, relative(SRC, file));
      }
    }
  }
  return { files, packages };
}

describe('sidebar entry', () => {
  it('reaches the sidebar through its entry, and nothing of the panel pages', () => {
    const { files } = sidebarGraph();
    const reached = [...files].map((file) => relative(SRC, file));
    expect(reached).toContain('SidePanel.tsx');
    expect(reached.filter((file) => file.startsWith('pages/'))).toEqual([]);
  });

  it('scans for classes every file the sidebar renders, and no page', () => {
    // Tailwind writes a utility for every class in its content, whatever the
    // bundle imports: scanning ./src/** gave the sidebar every page's classes.
    const content = (loadConfig(SIDEPANEL_TAILWIND).content as string[]).map((file) =>
      relative(SRC, file),
    );
    const reached = [...sidebarGraph().files].map((file) => relative(SRC, file));
    expect(reached.filter((file) => !content.includes(file))).toEqual([]);
    expect(content.filter((file) => file.startsWith('pages/'))).toEqual([]);
  });

  it('writes the sidebar stylesheet without the utilities only pages use', async () => {
    const { css } = await postcss([tailwindcss(loadConfig(SIDEPANEL_TAILWIND))]).process(
      '@tailwind utilities;',
      { from: undefined },
    );
    // Written by SidePanel.tsx's section headings.
    expect(css).toContain('.tracking-widest');
    // Written only by pages and by a panel-only component, never the sidebar.
    expect(css).not.toContain('.w-28');
  });

  it('ships no animation engine for a tree that animates nothing', () => {
    const { packages } = sidebarGraph();
    const motion = [...packages.entries()].filter(([spec]) => spec.startsWith('framer-motion'));
    expect(motion.map(([spec, from]) => `${spec} (imported by ${from})`)).toEqual([]);
  });
});
