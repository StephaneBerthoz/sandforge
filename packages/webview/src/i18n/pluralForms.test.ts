import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import ts from 'typescript';
import { describe, it, expect } from 'vitest';

import en from './locales/en.json';
import fr from './locales/fr.json';
import de from './locales/de.json';
import es from './locales/es.json';
import ja from './locales/ja.json';
import ptBR from './locales/pt-BR.json';

/**
 * A count is written with the singular and plural forms of its language.
 *
 * i18next picks `key_one` or `key_other` from the `count` it is given, through
 * Intl.PluralRules. A key with neither is written the same at 1 and at 5, and
 * the catalogue hid that with bracketed endings the reader has to resolve:
 * "1 champ(s) PII détecté(s)", "1 sur 3 org(s) connectée(s)", and in English
 * "All 1 rows are valid". Japanese has no singular, so it carries `_other`
 * only (check-i18n-parity.ts exempts it from `_one`).
 */

type Catalogue = Record<string, unknown>;

const BUNDLES: Record<string, Catalogue> = { en, fr, de, es, ja, 'pt-BR': ptBR };

/** Keys passed a `count` whose text rightly reads the same at any count. */
const NO_PLURAL_NEEDED: Record<string, string> = {
  'home.minutesAgo': 'an abbreviated unit ("5m ago"), not a noun',
  'home.hoursAgo': 'an abbreviated unit ("5h ago"), not a noun',
  'sidePanel.relativeTime.minutesAgo': 'an abbreviated unit, not a noun',
  'sidePanel.relativeTime.hoursAgo': 'an abbreviated unit, not a noun',
  'quickSync.seconds': 'an abbreviated unit ("12s")',
  'seed.csv.validation.andMore': '"and 1 more" reads right in all six',
  'seed.csv.mapper.mapped': 'the noun agrees with the total, not with the count',
  'autopilot.step2.selectedCount': 'the noun agrees with the total, not with the count',
  'org.bannerConnected': 'a label and a ratio ("Orgs connected: 1 of 3"), no noun to agree',
  'compare.coverage.overBudget': 'a label and a number ("… (500 per org, 120 s): 1")',
  'compare.coverage.unreadable': 'a label and a number ("Content that cannot be read…: 1")',
  'compare.coverage.readFailed': 'a label and a number ("Read failed: 1")',
  'compare.coverage.managedLeftOut': 'a label and a number ("…, left out as asked: 1")',
};

/** Every string of a catalogue, as `a.b.c` → value. */
function flatten(
  obj: Catalogue,
  prefix = '',
  out = new Map<string, string>(),
): Map<string, string> {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object') flatten(value as Catalogue, path, out);
    else if (typeof value === 'string') out.set(path, value);
  }
  return out;
}

/** Every non-test source file under src/. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) acc.push(full);
  }
  return acc;
}

/** `t('key', { …count… })`: a literal key handed a count. */
const COUNTED_CALL = /\bt\(\s*'([a-zA-Z0-9_.]+)'\s*,\s*\{[^)]*?\bcount\b/g;

describe('plural forms', () => {
  it('writes no plural as a bracketed ending, in any language', () => {
    const bracketed = /[A-Za-zÀ-ÿ]\((?:s|es|en|er|e|r|n|x|ões)\)/;
    const found = Object.entries(BUNDLES).flatMap(([lng, bundle]) =>
      [...flatten(bundle)]
        .filter(([, value]) => bracketed.test(value))
        .map(([key, value]) => `${lng} ${key}: ${value}`),
    );
    expect(found).toEqual([]);
  });

  it('gives every key handed a count its singular and plural forms', () => {
    const src = join(__dirname, '..');
    const counted = new Map<string, string>();
    for (const file of sourceFiles(src)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(COUNTED_CALL)) {
        counted.set(match[1], relative(src, file));
      }
    }
    // Guards the guard: a pattern that stopped matching would pass everything.
    expect(counted.size).toBeGreaterThan(30);

    const flat = Object.fromEntries(
      Object.entries(BUNDLES).map(([lng, bundle]) => [lng, flatten(bundle)]),
    );
    const missing: string[] = [];
    for (const [key, file] of counted) {
      if (key in NO_PLURAL_NEEDED) continue;
      for (const lng of Object.keys(BUNDLES)) {
        const forms = lng === 'ja' ? ['_other'] : ['_one', '_other'];
        for (const form of forms) {
          if (!flat[lng].has(`${key}${form}`)) missing.push(`${lng} ${key}${form} (${file})`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps every exemption about a key the code still hands a count', () => {
    const src = join(__dirname, '..');
    const all = sourceFiles(src)
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    const stale = Object.keys(NO_PLURAL_NEEDED).filter(
      (key) => !all.includes(`'${key}'`) && !all.includes(`.${key.split('.').pop()}\``),
    );
    expect(stale).toEqual([]);
  });
});

/**
 * A count and its noun are one phrase, translated together.
 *
 * `{n} {t('seed.records')}` renders "1 records", and in French "1
 * enregistrements": the word never learns the count. Written as
 * `t('key', { count: n })`, i18next picks the form the language wants. What
 * this reads, from the syntax tree of every source file:
 *
 *   - a value followed, across nothing but spaces, by a `t()` call given no
 *     count — `{n} {t('x')}`, `{n} {t('x').toLowerCase()}`, `${n} ${t('x')}`;
 *   - a value followed in JSX by a word written in English — `{n} records`;
 *   - a count followed in a template by a word — `${list.length} obj`.
 *
 * A unit after a number reads the same at any count, and is left alone.
 */

/**
 * Units, and the names that read the same after any number in all six
 * languages: PII is written as the acronym everywhere, Apex is a product name.
 */
const UNIT = /^(?:s|ms|min|h|KB|MB|GB|pts|%|PII|Apex)(?![\p{L}\p{N}])/u;
const UNIT_KEYS: Record<string, string> = {
  'monitor.liveOps.recsPerSec': 'a rate ("12 rec/s")',
};

/** A name that says the value is a count. */
const COUNTED =
  /(?:count|Count|length|total|Total|toLocaleString|toFixed|formatNumber|formatCount)/;

/** The `t()` call an expression renders, through `.toLowerCase()` and the like. */
function renderedCall(expression: ts.Expression): ts.CallExpression | undefined {
  let e: ts.Expression = expression;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isCallExpression(e)) return undefined;
  if (ts.isIdentifier(e.expression) && e.expression.text === 't') return e;
  if (
    ts.isPropertyAccessExpression(e.expression) &&
    /^to(?:Lower|Upper)Case$/.test(e.expression.name.text)
  ) {
    return renderedCall(e.expression.expression);
  }
  return undefined;
}

/**
 * The key of a `t()` call that renders a word with no count: a literal key,
 * and no option but a default. A call handed anything to interpolate writes a
 * sentence of its own, not a word to put after a number.
 */
function uncountedKey(call: ts.CallExpression): string | undefined {
  const [key, options] = call.arguments;
  if (!key || !ts.isStringLiteral(key)) return undefined;
  if (options === undefined || ts.isStringLiteral(options)) return key.text;
  if (!ts.isObjectLiteralExpression(options)) return undefined;
  const names = options.properties.map((p) => p.name?.getText());
  return names.every((name) => name === 'defaultValue') ? key.text : undefined;
}

/** Whether an expression puts a value on the page, rather than markup or words. */
function isValue(expression: ts.Expression): boolean {
  let e: ts.Expression = expression;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (renderedCall(e)) return false;
  if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) return false;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return false;
  if (ts.isTemplateExpression(e)) return false;
  if (ts.isConditionalExpression(e)) return isValue(e.whenTrue) && isValue(e.whenFalse);
  if (
    ts.isBinaryExpression(e) &&
    (e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      e.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return isValue(e.right);
  }
  return true;
}

/** `file:line — code` for every count written next to its noun. */
function countsBesideNouns(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const report = (node: ts.Node, what: string): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.push(`${file}:${line + 1} — ${what}`);
  };
  const afterNumber = (call: ts.CallExpression | undefined): string | undefined => {
    const key = call && uncountedKey(call);
    return key && !(key in UNIT_KEYS) ? key : undefined;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      // Whitespace, and `{' '}`, stand between a count and its noun.
      const children = node.children.filter(
        (c) =>
          !(ts.isJsxText(c) && c.text.trim() === '') &&
          !(
            ts.isJsxExpression(c) &&
            (c.expression === undefined ||
              (ts.isStringLiteral(c.expression) && c.expression.text.trim() === ''))
          ),
      );
      for (let i = 0; i + 1 < children.length; i++) {
        const [value, next] = [children[i], children[i + 1]];
        if (!ts.isJsxExpression(value) || !value.expression || !isValue(value.expression)) continue;
        if (ts.isJsxExpression(next) && next.expression) {
          const key = afterNumber(renderedCall(next.expression));
          if (key) report(value, `{${value.expression.getText(source)}} {t('${key}')}`);
          // `{n} {n === 1 ? 'item' : 'items'}`: English's two forms, in every language.
          const choice = next.expression;
          if (
            ts.isConditionalExpression(choice) &&
            [choice.whenTrue, choice.whenFalse].every(
              (branch) => ts.isStringLiteral(branch) && /\p{L}/u.test(branch.text),
            )
          ) {
            report(value, `{${value.expression.getText(source)}} {${choice.getText(source)}}`);
          }
        } else if (ts.isJsxText(next)) {
          const word = next.text.replace(/^\s+/, '');
          if (/^\p{L}/u.test(word) && !UNIT.test(word)) {
            report(value, `{${value.expression.getText(source)}} ${word.split('\n')[0].trim()}`);
          }
        }
      }
    }
    if (ts.isTemplateExpression(node)) {
      const spans = node.templateSpans;
      spans.forEach((span, i) => {
        if (!isValue(span.expression)) return;
        const between = span.literal.text;
        const next = spans[i + 1];
        if (next && between.trim() === '') {
          const key = afterNumber(renderedCall(next.expression));
          if (key)
            report(span.expression, `\${${span.expression.getText(source)}} \${t('${key}')}`);
        }
        const word = between.replace(/^ /, '');
        if (
          between.startsWith(' ') &&
          COUNTED.test(span.expression.getText(source)) &&
          /^\p{L}/u.test(word) &&
          !UNIT.test(word)
        ) {
          report(span.expression, `\${${span.expression.getText(source)}} ${word.trim()}`);
        }
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('a count and its noun', () => {
  it('finds a count written beside its noun, and passes one written as a phrase', () => {
    // Guards the guard: a scan that stopped matching would pass everything.
    const found = countsBesideNouns(
      'x.tsx',
      [
        "const a = <span>{n} {t('seed.records')}</span>;",
        "const b = <span>{list.length}{' '}{t('sync.objectSet').toLowerCase()}</span>;",
        'const c = <span>{obj.recordCount} records</span>;',
        "const d = `${items.length} obj · ${n} ${t('forge.records', 'records')}`;",
        "const e = <span>{t('seed.recordCount', { count: n })}</span>;",
        'const f = <span>{(ms / 1000).toFixed(1)}s</span>;',
        "const g = <span>{rate} {t('monitor.liveOps.recsPerSec', 'rec/s')}</span>;",
        "const h = `${headline} ${t('seed.clone.error.detail', { detail })}`;",
        "const i = <span>{busy ? <Spinner /> : <Sparkles />} {t('forge.ai.draft')}</span>;",
        "const j = <span>{n} {n === 1 ? 'item' : 'items'}</span>;",
        'const k = <div>{formatNumber(flows)}{" "}\n  Flows</div>;',
        'const l = <span>{piiCount} PII</span>;',
      ].join('\n'),
    );
    expect(found.map((f) => f.split(' — ')[0])).toEqual([
      'x.tsx:1',
      'x.tsx:2',
      'x.tsx:3',
      'x.tsx:4',
      'x.tsx:4',
      'x.tsx:10',
      'x.tsx:11',
    ]);
  });

  it('writes no count beside its noun, anywhere in the panel', () => {
    const src = join(__dirname, '..');
    const found = sourceFiles(src).flatMap((file) =>
      countsBesideNouns(relative(src, file), readFileSync(file, 'utf8')),
    );
    expect(found).toEqual([]);
  });
});
