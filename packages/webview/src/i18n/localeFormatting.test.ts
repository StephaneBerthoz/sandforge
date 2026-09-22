import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import ts from 'typescript';
import { describe, it, expect } from 'vitest';

/**
 * Dates and numbers follow the language picked in SandForge.
 *
 * A formatter given no locale — `new Intl.DateTimeFormat(undefined, …)`,
 * `n.toLocaleString()` — writes in the host's locale, which is VS Code's and
 * not the one chosen here: an interface set to French printed "Jan 15, 2026"
 * and "1,234" beside French labels. `uiLocale()` in utils/formatters is the
 * locale to pass, and `formatNumber` and `dateTimeFormat` there take it by
 * default.
 *
 * Read from the syntax tree, so a call named in a comment or a string is not
 * one. `Intl.DateTimeFormat().resolvedOptions()` asks for the host's settings
 * (its time zone), not for a format, and is left alone.
 */

const SRC = join(__dirname, '..');

/** Every non-test source file under src/. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) acc.push(full);
  }
  return acc;
}

const INTL_FORMATTERS = new Set([
  'DateTimeFormat',
  'DisplayNames',
  'ListFormat',
  'NumberFormat',
  'PluralRules',
  'RelativeTimeFormat',
]);
const TO_LOCALE = new Set(['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']);

/** An argument that leaves the locale to the host: absent, or `undefined`. */
function leavesLocaleToHost(arg: ts.Expression | undefined): boolean {
  return arg === undefined || (ts.isIdentifier(arg) && arg.text === 'undefined');
}

/** `name:line — code` for every call in `text` that formats in the host's locale. */
function hostLocaleCalls(name: string, text: string): string[] {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const report = (node: ts.Node): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.push(`${name}:${line + 1} — ${node.getText(source).split('\n')[0]}`);
  };
  const visit = (node: ts.Node): void => {
    if (
      (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Intl' &&
      INTL_FORMATTERS.has(node.expression.name.text) &&
      leavesLocaleToHost(node.arguments?.[0])
    ) {
      const readsSettings =
        ts.isPropertyAccessExpression(node.parent) && node.parent.name.text === 'resolvedOptions';
      if (!readsSettings) report(node);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      TO_LOCALE.has(node.expression.name.text) &&
      leavesLocaleToHost(node.arguments[0])
    ) {
      report(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('locale of dates and numbers', () => {
  it('catches every shape that shipped, and leaves what does not format alone', () => {
    const found = hostLocaleCalls(
      'probe.tsx',
      [
        "const a = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });",
        'const b = new Intl.NumberFormat();',
        'const c = total.toLocaleString();',
        'const d = when.toLocaleDateString(undefined, { month: "short" });',
        'const e = when.toLocaleTimeString();',
        '// const f = total.toLocaleString();',
        "const g = 'total.toLocaleString()';",
        'const h = Intl.DateTimeFormat().resolvedOptions().timeZone;',
        "const i = total.toLocaleString('en-US');",
        'const j = when.toLocaleDateString(locale);',
      ].join('\n'),
    );
    expect(found.map((f) => f.split(' — ')[0])).toEqual([
      'probe.tsx:1',
      'probe.tsx:2',
      'probe.tsx:3',
      'probe.tsx:4',
      'probe.tsx:5',
    ]);
  });

  it('formats nothing in the webview in the host locale', () => {
    const files = sourceFiles(SRC);
    // Guards the guard: a broken walk would make the assertion below vacuous.
    expect(files.length).toBeGreaterThan(100);

    const found = files.flatMap((file) =>
      hostLocaleCalls(relative(SRC, file), readFileSync(file, 'utf8')),
    );
    expect(found).toEqual([]);
  });
});
