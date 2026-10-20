import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { SIDEPANEL_LOCALE_NAMESPACES } from '@sandforge/shared';
import tailwindcss from '@tailwindcss/postcss';
import postcss from 'postcss';
import ts from 'typescript';
import { describe, it, expect } from 'vitest';

import en from './i18n/locales/en.json';
import sidepanelEnglish from './i18n/sidepanelCatalogue';

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
const SIDEPANEL_CSS = join(SRC, 'sidepanel.css');
const SIDEPANEL_TAILWIND = join(SRC, '..', 'tailwind.sidepanel.config.ts');
const VITE_CONFIG = join(SRC, '..', 'vite.config.ts');

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

/** Every string in `file` written whole and shaped like a catalogue key: `namespace.key…`. */
function keyShapedStrings(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z0-9_.]+$/.test(node.text)
    ) {
      found.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Whether `key` names an entry of the English catalogue, a string or a group of them. */
function inEnglishCatalogue(key: string): boolean {
  let entry: unknown = en;
  for (const part of key.split('.')) {
    if (typeof entry !== 'object' || entry === null || !(part in entry)) return false;
    entry = (entry as Record<string, unknown>)[part];
  }
  return true;
}

describe('sidebar entry', () => {
  it('reaches the sidebar through its entry, and nothing of the panel pages', () => {
    const { files } = sidebarGraph();
    const reached = [...files].map((file) => relative(SRC, file));
    expect(reached).toContain('SidePanel.tsx');
    expect(reached.filter((file) => file.startsWith('pages/'))).toEqual([]);
  });

  it('scans for classes every file the sidebar renders, and no page', async () => {
    // Tailwind writes a utility for every class in its content, whatever the
    // bundle imports: scanning ./src/** gave the sidebar every page's classes.
    // Loaded as Tailwind loads the file its `@config` names.
    const { default: config } = (await import(pathToFileURL(SIDEPANEL_TAILWIND).href)) as {
      default: { content: string[] };
    };
    const content = config.content.map((file) => relative(SRC, file));
    const reached = [...sidebarGraph().files].map((file) => relative(SRC, file));
    expect(reached.filter((file) => !content.includes(file))).toEqual([]);
    expect(content.filter((file) => file.startsWith('pages/'))).toEqual([]);
  });

  it('writes the sidebar stylesheet without the utilities only pages use', async () => {
    // Built as the sidebar pass builds it: its own stylesheet, whose `@config`
    // names the files the sidebar renders.
    const { css } = await postcss([tailwindcss()]).process(readFileSync(SIDEPANEL_CSS, 'utf8'), {
      from: SIDEPANEL_CSS,
    });
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

  it('carries the namespaces of the English catalogue the extension sends it in other languages', () => {
    expect(Object.keys(sidepanelEnglish).sort()).toEqual([...SIDEPANEL_LOCALE_NAMESPACES].sort());
    for (const namespace of SIDEPANEL_LOCALE_NAMESPACES) {
      expect(sidepanelEnglish[namespace]).toEqual(en[namespace]);
    }
  });

  it('finds every key the sidebar renders in those namespaces', () => {
    // A key outside them would show as the key itself: the sidebar's English
    // is only these namespaces, and so is what it is sent in a language.
    const used = new Map<string, string>();
    for (const file of sidebarGraph().files) {
      for (const key of keyShapedStrings(file)) {
        if (inEnglishCatalogue(key)) used.set(key, relative(SRC, file));
      }
    }
    // Positive control: the walk reads the keys the sidebar is known to render.
    expect(used.get('nav.seed')).toBe('SidePanel.tsx');
    expect(used.get('home.opStatus.failed')).toBe('SidePanel.tsx');
    const namespaces: readonly string[] = SIDEPANEL_LOCALE_NAMESPACES;
    const outside = [...used]
      .filter(([key]) => !namespaces.includes(key.split('.')[0]))
      .map(([key, file]) => `${key} (${file})`);
    expect(outside).toEqual([]);
  });

  it('points the sidebar build at that catalogue, and leaves the panel build the whole one', async () => {
    // Loaded by URL, as the Tailwind config above is: it sits outside src/.
    const { default: viteConfig } = (await import(pathToFileURL(VITE_CONFIG).href)) as {
      default: (env: { mode: string; command: 'build' }) => {
        resolve: { alias: Array<{ find: string | RegExp; replacement: string }> };
      };
    };
    const catalogueAlias = (mode: string) =>
      viteConfig({ mode, command: 'build' }).resolve.alias.filter(
        (alias) => typeof alias.find !== 'string' && alias.find.test('./locales/en.json'),
      );
    const sidebar = catalogueAlias('sidepanel');
    expect(sidebar).toHaveLength(1);
    expect(relative(SRC, sidebar[0].replacement)).toBe(join('i18n', 'sidepanelCatalogue.ts'));
    expect(catalogueAlias('production')).toEqual([]);
  });
});
