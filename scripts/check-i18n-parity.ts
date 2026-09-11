/**
 * i18n parity gate.
 *
 * Section 1 — webview locales: loads `packages/webview/src/i18n/locales/en.json`
 * as the reference, flattens its nested keys, and for every other locale reports:
 *
 *   - missing keys  (present in en.json, absent from the locale)
 *   - orphan keys   (present in the locale, absent from en.json)
 *
 * Section 2 — extension manifest: loads `packages/extension/package.nls.json`
 * as the reference and applies the same missing/orphan check to every
 * `package.nls.*.json` locale file (flat key-value maps, no plural handling).
 *
 * Section 3 — code vs catalogue (blocking): parity between six files proves
 * nothing about the seventh party, the source. Three ways a string escapes the
 * catalogue entirely: a hardcoded `aria-label="…"` (invisible to sighted
 * reviewers AND to the translator), a `t('k')` whose key no locale defines (the
 * raw key renders), and an inline `t('k', 'English')` default for such a key —
 * the default renders in all six languages, so the gap never surfaces as a
 * missing translation.
 *
 * Section 4 — values byte-identical to English (report only), restricted to
 * multi-word values: a lone token shared with English is usually a proper noun,
 * an acronym or a unit, whereas a sentence is untranslated copy. The legitimate
 * multi-word cases live in `scripts/i18n-identical-allowlist.json`.
 *
 * Section 5 — French accents (report only). French written without accents
 * passes every structural check while reading as broken to a French user.
 *
 * Section 6 — catalogue vs code (blocking). Keys no source file mentions. It
 * reads the whole monorepo, tests included (`KEY_REFERENCE_ROOTS`), because a
 * key's only literal often lives in `packages/extension` or `packages/shared`
 * and reaches `t()` through a variable. Every file is lexed first (`lex`), so a
 * comment is neither a mention nor an exemption. Runtime-built keys are
 * exempted from both ends, and only by a real `t()` call in production code:
 * by prefix for `t(`a.b.${x}`)` and `t('a.b.' + x)`, and by tail for
 * `t(`${p}.justNow`)`, restricted to the prefixes `DYNAMIC_TAIL_PREFIXES`
 * declares and a production call actually passes to that builder. Every
 * narrowing is load-bearing: an exemption keyed on a bare prefix, a bare tail
 * or a word found in a comment is an amnesty for every future key that
 * happens to share it.
 * The baseline of tolerated entries is empty and is a ratchet: it may only
 * shrink, and an entry that stops being an unreferenced catalogue key fails the
 * run until it is deleted from it.
 *
 * Plural handling (webview only): i18next (Intl.PluralRules) only has the
 * `other` category for Japanese, so `*_one` keys are not required in
 * `ja.json`. Every other supported locale (fr, de, es, pt-BR) has a `one`
 * category like English.
 *
 * Output is deterministic (keys sorted). Exits 1 when any locale drifts
 * from the reference; pass `--report` to print the report without failing.
 *
 * Run with:  pnpm check:i18n
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const WEBVIEW_LOCALES_DIR = join(__dirname, '..', 'packages', 'webview', 'src', 'i18n', 'locales');
const WEBVIEW_REFERENCE = 'en.json';

const EXTENSION_DIR = join(__dirname, '..', 'packages', 'extension');
const MANIFEST_REFERENCE = 'package.nls.json';

const WEBVIEW_SRC = join(__dirname, '..', 'packages', 'webview', 'src');
const IDENTICAL_ALLOWLIST = join(__dirname, 'i18n-identical-allowlist.json');

/** Locales whose i18next plural rules have no `one` category (Intl.PluralRules). */
const NO_ONE_CATEGORY = new Set(['ja']);

type JsonObject = Record<string, unknown>;

/** Flatten a nested locale object into `a.b.c` -> string leaf entries. */
function flatten(
  obj: JsonObject,
  prefix = '',
  out = new Map<string, string>(),
): Map<string, string> {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value as JsonObject, path, out);
    } else if (typeof value === 'string') {
      out.set(path, value);
    }
  }
  return out;
}

function loadLocale(dir: string, file: string): Map<string, string> {
  const text = readFileSync(join(dir, file), 'utf8');
  return flatten(JSON.parse(text) as JsonObject);
}

/**
 * Compare every locale file in `dir` against `referenceFile`.
 * Returns true when at least one locale drifts from the reference.
 */
function checkParity(options: {
  dir: string;
  referenceFile: string;
  header: string;
  /** Extra filter for candidate locale files (beyond `.json` and not the reference). */
  localeFilePattern?: RegExp;
  /** Drop `*_one` keys from the expected set for these locales (i18next plural rules). */
  noOneCategory?: Set<string>;
}): boolean {
  const { dir, referenceFile, header, localeFilePattern, noOneCategory } = options;

  const reference = loadLocale(dir, referenceFile);
  const referenceKeys = [...reference.keys()];

  const localeFiles = readdirSync(dir)
    .filter(
      (f) =>
        f.endsWith('.json') &&
        f !== referenceFile &&
        (localeFilePattern === undefined || localeFilePattern.test(f)),
    )
    .sort();

  let hasDrift = false;

  console.log(`${header} — reference ${referenceFile}: ${referenceKeys.length} keys\n`);

  for (const file of localeFiles) {
    const locale = file.replace(/\.json$/, '').replace(/^package\.nls\./, '');
    const keys = loadLocale(dir, file);

    // *_one plural keys are only required for locales with a `one` category.
    const expected =
      noOneCategory?.has(locale) === true
        ? referenceKeys.filter((k) => !k.endsWith('_one'))
        : referenceKeys;

    const missing = expected.filter((k) => !keys.has(k)).sort();
    const orphan = [...keys.keys()].filter((k) => !reference.has(k)).sort();

    const coverage = (((expected.length - missing.length) / expected.length) * 100).toFixed(1);

    if (missing.length === 0 && orphan.length === 0) {
      console.log(`✓ ${locale}: ${expected.length}/${expected.length} keys (100%)`);
      continue;
    }

    hasDrift = true;
    console.log(
      `✗ ${locale}: ${expected.length - missing.length}/${expected.length} keys (${coverage}%)`,
    );
    if (missing.length > 0) {
      console.log(`  missing (${missing.length}):`);
      for (const k of missing) console.log(`    - ${k}`);
    }
    if (orphan.length > 0) {
      console.log(`  orphan (${orphan.length}):`);
      for (const k of orphan) console.log(`    - ${k}`);
    }
  }

  return hasDrift;
}

/** Every non-test source file under `packages/webview/src`. */
function webviewSources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) webviewSources(full, acc);
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) acc.push(full);
  }
  return acc;
}

/**
 * Every file in the monorepo that can name a catalogue key — section 6 only.
 *
 * That section used to read `webviewSources`, i.e. `packages/webview/src`
 * minus its tests. Three reference paths fell outside that window, and each
 * one of them put a live key in the baseline:
 *
 *   - `packages/extension/src` builds keys the webview renders through
 *     `t(variable)`. `SmartActionAnalyzer` assigns `home.smartAction.reason*`
 *     and `SmartActionCard` renders `t(recommendation.reasonKey)`;
 *     `errorClassifier` assigns `ai.error.cancelled` and
 *     `AIProviderStatusBanner` renders it. Neither key exists as a literal in
 *     any webview source.
 *   - `packages/shared/src` carries the prebuilt catalogues. `seed-templates`
 *     and `sync-templates` store `seed.templates.*` / `sync.templates.*` in
 *     `name`/`nameKey` fields that `TemplateCard` hands straight to `t()`.
 *   - a key whose only mention is a test is still a key a source file
 *     mentions; deleting it reds the suite rather than the UI, which is the
 *     same signal arriving one layer earlier.
 *
 * Locale JSON is deliberately not in the walk: a catalogue that counts as its
 * own consumer makes every key referenced and the section vacuous.
 */
const KEY_REFERENCE_ROOTS = [
  join(__dirname, '..', 'packages', 'shared', 'src'),
  join(__dirname, '..', 'packages', 'extension', 'src'),
  join(__dirname, '..', 'packages', 'webview', 'src'),
  join(__dirname, '..', 'packages', 'webview', 'e2e'),
];

/**
 * Test code, for the purpose of minting exemptions only.
 *
 * A test names keys the same way production does, so it stays in the scan that
 * decides whether a key is mentioned. What it must not do is *widen* an
 * exemption: `design-system.test.ts` writes `` `status.${severity} is not a
 * hardened token` `` as an assertion MESSAGE, and the prefix sweep read that as
 * a key template — which retired the whole `status.*` namespace from section 6
 * for good. Assertion prose is not a key construction site, and neither is a
 * helper only tests import: `src/test/` and `src/i18n/testing/` carry no
 * `.test.` in their names, and a builder call there kept a dead tail family
 * exempt. Matched on the repo-relative path, so a checkout that happens to
 * live under a `test/` directory is not all test code.
 */
function isTestFile(file: string): boolean {
  const path = relative(join(__dirname, '..'), file).replace(/\\/g, '/');
  return (
    /\.(test|spec)\./.test(path) ||
    /(^|\/)(e2e|test|tests|testing|__tests__|__mocks__)\//.test(path)
  );
}

function referenceSources(dir: string, acc: string[] = []): string[] {
  // A root a checkout does not have contributes no references, it does not
  // crash the run: the gate's own fixture repos carry the webview alone.
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) referenceSources(full, acc);
    else if (/\.tsx?$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

/**
 * A TS/TSX token, as far as section 6 needs one. A string or a template chunk
 * is opaque: its `text` is the literal's contents, and no pattern that looks
 * for code — `t(`, a call, a parameter — can match inside it.
 */
type Token = {
  kind: 'ident' | 'number' | 'punct' | 'string' | 'template' | 'regex';
  /** Identifier or punctuator text; for a string or a template chunk, its raw contents. */
  text: string;
  /** Template chunks only: which literal the chunk belongs to, and which part of it. */
  template?: { id: number; part: 'full' | 'head' | 'middle' | 'tail' };
};

/** Keywords after which a `/` opens a regex literal instead of dividing. */
const KEYWORDS_BEFORE_EXPRESSION = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/**
 * Section 6 reads source as code: `tokens`, plus `code`, the text with every
 * comment blanked out.
 *
 * It used to run its regexes over raw text, and three gates in this repository
 * went green on that same shortcut — a mention accepted as proof. Here the
 * JSDoc of `formatRelativeTimeI18n` ("e.g. 'home' or 'sidePanel.relativeTime'")
 * kept both tail families exempt with every real call deleted, and a dotted
 * template anywhere — a log line, a class name, a call commented out — retired
 * a namespace. A lexer rather than a comment-stripping regex, because `'src/*'`
 * and `'https://…'` are strings, not comments.
 *
 * Deliberately small: no AST and no dependency, since the gate's own tests run
 * a copy of this file from a directory with no node_modules. Where it has to
 * guess — a `/` that may open a regex, an apostrophe in JSX text — an unclosed
 * literal falls back at the end of its line.
 */
function lex(source: string): { tokens: Token[]; code: string } {
  const tokens: Token[] = [];
  const comments: Array<[number, number]> = [];
  const substitutions: Array<{ id: number; braces: number }> = [];
  const end = source.length;
  let templates = 0;
  let i = 0;

  /** One template chunk from `from`, up to the closing backtick or the next `${`. */
  const chunk = (from: number, id: number, first: boolean): number => {
    for (let j = from; j < end; j++) {
      if (source[j] === '\\') {
        j++;
      } else if (source[j] === '`') {
        const part = first ? 'full' : 'tail';
        tokens.push({ kind: 'template', text: source.slice(from, j), template: { id, part } });
        return j + 1;
      } else if (source[j] === '$' && source[j + 1] === '{') {
        const part = first ? 'head' : 'middle';
        tokens.push({ kind: 'template', text: source.slice(from, j), template: { id, part } });
        substitutions.push({ id, braces: 0 });
        return j + 2;
      }
    }
    const part = first ? 'full' : 'tail';
    tokens.push({ kind: 'template', text: source.slice(from), template: { id, part } });
    return end;
  };

  const regexAllowed = (): boolean => {
    const prev = tokens[tokens.length - 1];
    if (prev === undefined) return true;
    if (prev.kind === 'ident') return KEYWORDS_BEFORE_EXPRESSION.has(prev.text);
    // `</` closes a JSX element.
    if (prev.kind === 'punct') return !/^[)\]}<]$/.test(prev.text);
    return prev.template?.part === 'head' || prev.template?.part === 'middle';
  };

  while (i < end) {
    const ch = source[i];
    const next = source[i + 1];
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === '/' && (next === '/' || next === '*')) {
      const stop = next === '/' ? source.indexOf('\n', i) : source.indexOf('*/', i + 2);
      const to = stop === -1 ? end : next === '/' ? stop : stop + 2;
      comments.push([i, to]);
      i = to;
    } else if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < end && source[j] !== ch && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      const closed = j < end && source[j] === ch;
      tokens.push(
        closed ? { kind: 'string', text: source.slice(i + 1, j) } : { kind: 'punct', text: ch },
      );
      i = closed ? j + 1 : i + 1;
    } else if (ch === '`') {
      i = chunk(i + 1, templates++, true);
    } else if (ch === '}' && substitutions.at(-1)?.braces === 0) {
      i = chunk(i + 1, (substitutions.pop() as { id: number }).id, false);
    } else if (ch === '/' && regexAllowed() && regexEnd(source, i) > i) {
      const j = regexEnd(source, i);
      tokens.push({ kind: 'regex', text: source.slice(i, j) });
      i = j;
    } else if (/[A-Za-z_$\u0080-\uffff]/.test(ch)) {
      let j = i + 1;
      while (j < end && /[\w$\u0080-\uffff]/.test(source[j])) j++;
      tokens.push({ kind: 'ident', text: source.slice(i, j) });
      i = j;
    } else if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < end && /[\w.]/.test(source[j])) j++;
      tokens.push({ kind: 'number', text: source.slice(i, j) });
      i = j;
    } else if (ch === '=' && next === '>') {
      tokens.push({ kind: 'punct', text: '=>' });
      i += 2;
    } else {
      const open = substitutions.at(-1);
      if (open !== undefined && ch === '{') open.braces++;
      if (open !== undefined && ch === '}') open.braces--;
      tokens.push({ kind: 'punct', text: ch });
      i++;
    }
  }

  let code = '';
  let from = 0;
  for (const [start, stop] of comments) {
    code += `${source.slice(from, start)} `;
    from = stop;
  }
  return { tokens, code: code + source.slice(from) };
}

/** End of the regex literal opening at `start`, or `start` when none closes on its line. */
function regexEnd(source: string, start: number): number {
  let inClass = false;
  for (let j = start + 1; j < source.length && source[j] !== '\n'; j++) {
    const c = source[j];
    if (c === '\\') j++;
    else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      let flags = j + 1;
      while (flags < source.length && /[a-z]/i.test(source[flags])) flags++;
      return flags;
    }
  }
  return start;
}

const OPENERS = new Set(['(', '[', '{']);
const CLOSERS = new Set([')', ']', '}']);

function isPunct(token: Token | undefined, text: string): boolean {
  return token?.kind === 'punct' && token.text === text;
}

/** Index of the bracket that the closer at `close` closes, or -1. */
function openerOf(tokens: Token[], close: number): number {
  let depth = 0;
  for (let j = close; j >= 0; j--) {
    if (tokens[j].kind !== 'punct') continue;
    if (CLOSERS.has(tokens[j].text)) depth++;
    else if (OPENERS.has(tokens[j].text) && --depth === 0) return j;
  }
  return -1;
}

/**
 * The comma-separated items between the bracket at `open` and its match.
 * `angles` also nests `<…>`, which only a parameter list can afford: there
 * `Map<string, number>` is one type, in a call `f(a < b, c > d)` is two values.
 */
function listItems(tokens: Token[], open: number, angles: boolean): Token[][] {
  const items: Token[][] = [];
  let item: Token[] = [];
  let depth = 0;
  for (let j = open + 1; j < tokens.length; j++) {
    const token = tokens[j];
    const text = token.kind === 'punct' ? token.text : '';
    if (depth === 0 && CLOSERS.has(text)) break;
    if (depth === 0 && text === ',') {
      items.push(item);
      item = [];
      continue;
    }
    if (OPENERS.has(text) || (angles && text === '<')) depth++;
    else if (CLOSERS.has(text) || (angles && text === '>' && depth > 0)) depth--;
    item.push(token);
  }
  if (item.length > 0) items.push(item);
  return items;
}

const PARAMETER_MODIFIERS = new Set(['public', 'private', 'protected', 'readonly', 'override']);

/** Parameter names by argument position; a destructured parameter holds its slot unnamed. */
function parameterNames(tokens: Token[], open: number): Array<string | undefined> {
  const names: Array<string | undefined> = [];
  for (const item of listItems(tokens, open, true)) {
    let k = 0;
    while (isPunct(item[k], '.') || PARAMETER_MODIFIERS.has(item[k]?.text ?? '')) k++;
    // `this: Window` types the receiver; it takes no argument position.
    if (item[k]?.text === 'this' && isPunct(item[k + 1], ':')) continue;
    names.push(item[k]?.kind === 'ident' ? item[k].text : undefined);
  }
  return names;
}

/** The name bound by `name = <function>` or `name: <function>`, `at` being the token before it. */
function bindingName(tokens: Token[], at: number): string | undefined {
  let k = at;
  while (tokens[k]?.text === 'async' || tokens[k]?.text === 'function') k--;
  const bound = isPunct(tokens[k], '=') || isPunct(tokens[k], ':');
  return bound && tokens[k - 1]?.kind === 'ident' ? tokens[k - 1].text : undefined;
}

/** Keywords whose `(…) {` opens a block, not a function body. */
const BLOCK_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);

/**
 * The function whose body opens at `body` — a `{` or an `=>` — as the name its
 * callers use and its parameter names, or undefined when `body` opens no
 * function. The name is `function name(`, a method's `name(`, or the binding a
 * function expression is assigned to (`const name = (…) =>`, `name: (…) =>`).
 */
function functionAt(
  tokens: Token[],
  body: number,
): { name?: string; params: Array<string | undefined> } | undefined {
  const arrow = isPunct(tokens[body], '=>');
  let close = body - 1;
  if (!arrow && isPunct(tokens[close], '=>')) return functionAt(tokens, close);
  // `p => …` has one bare parameter; in `(…): p =>` that ident is a return type.
  const annotation = isPunct(tokens[close - 1], ':') && isPunct(tokens[close - 2], ')');
  if (arrow && tokens[close]?.kind === 'ident' && !annotation && !isPunct(tokens[close - 1], '.')) {
    return { name: bindingName(tokens, close - 1), params: [tokens[close].text] };
  }
  if (!isPunct(tokens[close], ')')) {
    // `(…): ReturnType {` — walk back over the annotation to the `)` it follows.
    let depth = 0;
    let found = -1;
    for (let k = close; k >= Math.max(0, body - 64) && found < 0; k--) {
      const text = tokens[k].kind === 'punct' ? tokens[k].text : '';
      if (depth === 0 && text === ':' && isPunct(tokens[k - 1], ')')) found = k - 1;
      else if (CLOSERS.has(text)) depth++;
      else if (OPENERS.has(text) && depth-- === 0) return undefined;
      else if (depth === 0 && (text === ';' || text === '=')) return undefined;
    }
    if (found < 0) return undefined;
    close = found;
  }
  const open = openerOf(tokens, close);
  if (open < 0) return undefined;
  let before = open - 1;
  if (isPunct(tokens[before], '>')) {
    // `name<T>(` — step over the type parameters.
    for (let depth = 0; before >= 0; before--) {
      if (isPunct(tokens[before], '>')) depth++;
      else if (isPunct(tokens[before], '<') && --depth === 0) break;
    }
    before--;
  }
  const head = tokens[before];
  if (head?.kind === 'ident' && BLOCK_KEYWORDS.has(head.text)) return undefined;
  const params = parameterNames(tokens, open);
  const named = !arrow && head?.kind === 'ident' && !['function', 'async'].includes(head.text);
  return { name: named ? head.text : bindingName(tokens, before), params };
}

/** Tokens that start a statement, which an expression-bodied arrow cannot reach past. */
const STATEMENT_KEYWORDS = new Set([
  'const',
  'let',
  'var',
  'return',
  'if',
  'for',
  'while',
  'do',
  'switch',
  'throw',
  'try',
  'export',
  'import',
  'function',
  'class',
]);

/**
 * The innermost function around `site` that declares `name` as a parameter,
 * as its name and that parameter's position. Undefined when no enclosing
 * function declares it, or the one that does has no name to be called by.
 */
function enclosingParameter(
  tokens: Token[],
  site: number,
  name: string,
): { fn: string; index: number } | undefined {
  let depth = 0;
  // Whether an expression-bodied arrow met at this depth can still contain the site.
  let arrowReach = true;
  for (let j = site - 1; j >= 0; j--) {
    const token = tokens[j];
    const text = token.kind === 'punct' ? token.text : '';
    if (CLOSERS.has(text)) {
      depth++;
      continue;
    }
    if (OPENERS.has(text)) {
      if (depth > 0) {
        depth--;
        continue;
      }
      arrowReach = true;
      if (text !== '{') continue;
    } else if (depth > 0) {
      continue;
    } else if (text === ';' || text === ',' || STATEMENT_KEYWORDS.has(token.text)) {
      if (token.kind !== 'string' && token.kind !== 'template') arrowReach = false;
      continue;
    } else if (text !== '=>' || !arrowReach) {
      continue;
    }
    const fn = functionAt(tokens, j);
    const index = fn?.params.indexOf(name) ?? -1;
    if (fn === undefined || index < 0) continue;
    return fn.name === undefined ? undefined : { fn: fn.name, index };
  }
  return undefined;
}

/** Every string literal passed whole, at argument position `index`, to a call of `fn`. */
function literalArguments(tokens: Token[], fn: string, index: number): string[] {
  const literals: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (tokens[i].kind !== 'ident' || tokens[i].text !== fn || !isPunct(tokens[i + 1], '('))
      continue;
    const argument = listItems(tokens, i + 1, false)[index] ?? [];
    const only = argument.length === 1 ? argument[0] : undefined;
    if (only?.kind === 'string' || only?.template?.part === 'full') literals.push(only.text);
  }
  return literals;
}

/** `a.b` resolves if the key exists, or if its plural variants do. */
function resolves(key: string, reference: Map<string, string>): boolean {
  if (reference.has(key)) return true;
  return ['zero', 'one', 'two', 'few', 'many', 'other'].some((c) => reference.has(`${key}_${c}`));
}

/**
 * Every `t('a.b')` whose literal is the *complete* first argument. The trailing
 * `[),]` is what rules out `t('a.b.' + type)` and `` t(`a.b.${type}`) ``: those
 * literals are prefixes, and the key only exists once the component renders —
 * section 6 covers them by prefix instead.
 */
const LITERAL_KEY = /\bt\(\s*'([a-zA-Z0-9_.]+)'\s*[),]/g;

/** The same call with an English fallback: `t('k', 'Default')` / `{ defaultValue }`. */
const LITERAL_DEFAULT = /\bt\(\s*'([a-zA-Z0-9_.]+)'\s*,\s*(?:'|")/g;
const OPTION_DEFAULT = /\bt\(\s*'([a-zA-Z0-9_.]+)'\s*,\s*\{[^}]*defaultValue\s*:/g;

/** Every key captured by `pattern` in `source`, deduplicated. */
function matchedKeys(pattern: RegExp, source: string): Set<string> {
  const keys = new Set<string>();
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) keys.add(match[1]);
  return keys;
}

/**
 * Section 3 — the three ways a user-visible string bypasses the catalogue.
 * Returns true when at least one violation was found.
 */
function checkSources(reference: Map<string, string>): boolean {
  const files = webviewSources(WEBVIEW_SRC);
  const hardcodedLabels: string[] = [];
  const unresolvedKeys: string[] = [];
  const unbackedDefaults: string[] = [];

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const label = relative(WEBVIEW_SRC, file).replace(/\\/g, '/');

    if (file.endsWith('.tsx')) {
      const lines = source.split('\n');
      lines.forEach((line, i) => {
        if (line.includes('aria-label="')) hardcodedLabels.push(`${label}:${i + 1}`);
      });
    }

    const withDefault = new Set([
      ...matchedKeys(LITERAL_DEFAULT, source),
      ...matchedKeys(OPTION_DEFAULT, source),
    ]);

    for (const key of matchedKeys(LITERAL_KEY, source)) {
      // A dotless literal is a namespace or a sentinel, never a catalogue path.
      if (!key.includes('.') || resolves(key, reference)) continue;
      const site = `${key} (${label})`;
      if (withDefault.has(key)) unbackedDefaults.push(site);
      else unresolvedKeys.push(site);
    }
  }

  console.log(`i18n source scan — ${files.length} files\n`);

  if (hardcodedLabels.length === 0) {
    console.log('✓ aria-label: every accessible name goes through t()');
  } else {
    console.log(`✗ aria-label: ${hardcodedLabels.length} hardcoded English literal(s):`);
    for (const l of [...new Set(hardcodedLabels)].sort()) console.log(`    - ${l}`);
  }

  const unresolved = [...new Set(unresolvedKeys)].sort();
  if (unresolved.length === 0) {
    console.log('✓ t() keys: every literal key resolves against en.json');
  } else {
    console.log(`✗ t() keys: ${unresolved.length} key(s) absent from en.json (renders raw):`);
    for (const k of unresolved) console.log(`    - ${k}`);
  }

  const unbacked = [...new Set(unbackedDefaults)].sort();
  if (unbacked.length === 0) {
    console.log('✓ inline defaults: every t() default is backed by an en.json entry');
  } else {
    console.log(`✗ inline defaults: ${unbacked.length} key(s) absent from en.json:`);
    for (const k of unbacked) console.log(`    - ${k}`);
  }

  return hardcodedLabels.length > 0 || unresolved.length > 0 || unbacked.length > 0;
}

/**
 * Prose, as opposed to a token. A lone word shared with English — "Total",
 * "Import", an acronym, a bare `{{count}}` — is common enough across languages
 * that flagging it would drown the signal in false positives; a sentence that
 * came back from translation byte-for-byte did not come back by coincidence.
 */
function isProse(value: string): boolean {
  return value.trim().split(/\s+/).length > 1;
}

/**
 * Section 4 — non-EN prose byte-identical to the English one.
 *
 * Blocking since v1.19.0. It was report-only, which meant a release could ship
 * with prose that had never been translated and nothing stopped it: the count
 * sat at 14 while the product advertised six languages. Now that the list is
 * empty, blocking costs nothing and keeps it that way — a value that is
 * genuinely identical in another language ("Type incompatible" in French) goes
 * in `i18n-identical-allowlist.json` as a decision, not as a silent tolerance.
 *
 * @returns The number of offending keys — non-zero fails the run.
 */
function reportIdenticalValues(reference: Map<string, string>): number {
  const allowlist = new Set<string>(
    (JSON.parse(readFileSync(IDENTICAL_ALLOWLIST, 'utf8')) as { keys: string[] }).keys,
  );

  const perKey = new Map<string, string[]>();
  for (const file of readdirSync(WEBVIEW_LOCALES_DIR).sort()) {
    if (!file.endsWith('.json') || file === WEBVIEW_REFERENCE) continue;
    const locale = file.replace(/\.json$/, '');
    for (const [key, value] of loadLocale(WEBVIEW_LOCALES_DIR, file)) {
      if (allowlist.has(key) || reference.get(key) !== value || !isProse(value)) continue;
      if (!perKey.has(key)) perKey.set(key, []);
      perKey.get(key)?.push(locale);
    }
  }

  if (perKey.size === 0) {
    console.log('✓ identical-to-English: no untranslated prose outside the allowlist');
    return 0;
  }
  console.log(`✗ identical-to-English: ${perKey.size} value(s) still carrying the English copy:`);
  for (const key of [...perKey.keys()].sort()) {
    console.log(`    - ${key} [${perKey.get(key)?.join(', ')}]`);
  }
  console.log(
    '    Translate them, or add the ones that are legitimately identical to ' +
      'scripts/i18n-identical-allowlist.json.',
  );
  return perKey.size;
}

/**
 * Section 5 — French values spelled without their accents. Report only: the
 * word list is a heuristic, and a false positive must not block a release.
 */
const FRENCH_UNACCENTED =
  /\b(Termine|Cree|Donnees|Parametre|Selectionn|execution|operation|Echec|reussi|genere|requete|deja|apres|securite|defaut|Modele|Delai|Etape|etape|Executer|qualite|Duree|Apercu|regles?|Resultat|dependance)\b/;

function reportFrenchAccents(): void {
  const offenders: string[] = [];
  for (const [key, value] of loadLocale(WEBVIEW_LOCALES_DIR, 'fr.json')) {
    const hit = FRENCH_UNACCENTED.exec(value);
    if (hit) offenders.push(`${key} — "${hit[1]}"`);
  }
  if (offenders.length === 0) {
    console.log('✓ French accents: no unaccented form from the watch list');
    return;
  }
  console.log(`! French accents: ${offenders.length} value(s) missing an accent:`);
  for (const o of offenders.sort()) console.log(`    - ${o}`);
}

/**
 * Baseline for section 6: keys section 6 tolerates as unreferenced. Empty since
 * 2026-09-10, and meant to stay that way — an unreferenced key is now deleted,
 * not written down.
 *
 * It held 586 entries, and 555 of them were genuinely dead copy: deleted from
 * all six locales, ~3 300 strings out of every VSIX. The other 31 were never
 * dead. They were invisible to the sweep, which read `packages/webview/src`
 * minus its tests and matched whole literals:
 *
 *   - 16 keys whose literal lives in `packages/extension/src` or
 *     `packages/shared/src` and reaches `t()` through a variable
 *     (`t(recommendation.reasonKey)`, `t(item.name)`);
 *   - 6 built tail-first by `t(`${keyPrefix}.justNow`)` in `formatters.ts`,
 *     spelled out by no file at all;
 *   - 9 named only by a spec, which is still a source file naming them.
 *
 * `KEY_REFERENCE_ROOTS` and the tail families of `findUnreferencedKeys` close
 * all three holes, so those 31 now resolve as referenced and need no entry.
 *
 * An entry, should one ever be added, earns its place by being unreferenced
 * *and* defined in en.json. The moment either stops holding — a consumer comes
 * back, the key leaves the catalogue — `auditBaseline` fails the run until the
 * entry is deleted from here. A list nobody can leave is a list that stops
 * describing anything.
 */
const UNREFERENCED_BASELINE: readonly string[] = [];

/**
 * Where the number stood, and when. `count` is an upper bound the run enforces:
 * the list may fall below it without anyone doing anything, but growing past it
 * means editing this number and the date beside it, in a diff a reviewer reads.
 * Lower both when you delete entries, so the next person can tell at a glance
 * whether the figure is going down. It read 590 on 2026-08-13, the day the
 * section landed and was neutralised in the same commit; 587 on 2026-09-09; 0
 * on 2026-09-10, which pins the ratchet shut — any new entry now trips it.
 */
const BASELINE_CENSUS = { recorded: '2026-09-10', count: 0 } as const;

/**
 * The prefixes a tail-first key builder is actually called with.
 *
 * `formatRelativeTimeI18n(ts, t, keyPrefix)` builds `t(`${keyPrefix}.justNow`)`,
 * so its six live keys are spelled out by no file at all. The tail is the only
 * literal, and exempting on the tail alone hands a free pass to every key that
 * ends in one: `anything.justNow` survived the sweep for as long as that rule
 * stood. The prefix half is a parameter, so it is declared here — and a
 * declaration only exempts what the tree backs. The builder is found from the
 * key itself: the function whose parameter feeds the `${…}`. A declared prefix
 * then counts only when a production call passes it, whole, in that
 * parameter's position, and it exempts exactly `prefix + tail` for that
 * builder's tails. A comment, a string, a test, or the same word handed to
 * another function counts for nothing, and `auditDynamicTailPrefixes` fails the
 * run on a prefix no call passes or that builds no key.
 *
 * Add a prefix here only when a call site passes it as a literal. The tails
 * themselves stay inferred, so a new one in `formatters.ts` needs no edit.
 */
const DYNAMIC_TAIL_PREFIXES: readonly string[] = ['home', 'sidePanel.relativeTime'];

/** `a.b.` — the literal head of a key whose rest is only known at runtime. */
const KEY_PREFIX = /^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*\.$/;
/** `.a.b` — the literal tail of a key whose head is only known at runtime. */
const KEY_TAIL = /^(?:\.[a-zA-Z0-9_]+)+$/;

/** What section 6 learnt about tail-first keys, for `auditDynamicTailPrefixes`. */
type TailFamilies = {
  /** Every tail a production `t()` call builds, sorted. */
  tails: string[];
  /** The functions those tails were traced back to, sorted. */
  builders: string[];
  /** Each declared prefix a production call really passes, and the keys it builds. */
  families: Map<string, string[]>;
};

/**
 * Section 6 — catalogue entries no source file mentions.
 * Returns the keys that are unreferenced and not in the baseline.
 */
function findUnreferencedKeys(
  reference: Map<string, string>,
): { unreferenced: string[]; fresh: string[] } & TailFamilies {
  const files = KEY_REFERENCE_ROOTS.flatMap((root) => referenceSources(root)).map((file) => ({
    file,
    ...lex(readFileSync(file, 'utf8')),
  }));
  // Mentions are counted everywhere but in comments; exemptions are minted in production only.
  const sources = files.map((f) => f.code);
  const production = files.filter((f) => !isTestFile(f.file)).map((f) => f.tokens);

  /*
   * Keys built at runtime — `t(`forge.anonCategory.${cat}`)`, `t('nav.' + id)` —
   * never appear whole in the source. Collect their prefixes first; without
   * this step the sweep reports (and a later cleanup deletes) live keys.
   *
   * Only the first argument of a `t()` call counts, and only in production
   * code. A dotted template anywhere else is prose, a log line, a class name or
   * a storage key: `design-system.test.ts` writes `status.${severity}` in an
   * assertion message, and reading it as a key template exempted `status.*`
   * wholesale — see `isTestFile`.
   *
   * The mirror image is `t(`${keyPrefix}.justNow`)`, where the variable comes
   * FIRST and only the tail is literal: the prefix sweep, which needs a literal
   * before the `${`, sees none of those keys. They sat in the baseline as dead
   * until they were traced; deleting them would have printed `home.justNow` on
   * the Home page and in the side panel. So the tail is collected too, and the
   * `${…}` traced back to the parameter, and the function, it comes from.
   */
  const dynamicPrefixes = new Set<string>();
  const tails = new Set<string>();
  const builders = new Map<string, { fn: string; index: number; tails: Set<string> }>();
  for (const tokens of production) {
    for (let i = 0; i + 2 < tokens.length; i++) {
      if (tokens[i].kind !== 'ident' || tokens[i].text !== 't' || !isPunct(tokens[i + 1], '(')) {
        continue;
      }
      const first = tokens[i + 2];
      const part = first.template?.part;
      const concatenated = first.kind === 'string' && isPunct(tokens[i + 3], '+');
      if ((part === 'head' || concatenated) && KEY_PREFIX.test(first.text)) {
        dynamicPrefixes.add(first.text);
        continue;
      }
      if (part !== 'head' || first.text !== '') continue;
      let close = i + 3;
      while (close < tokens.length && tokens[close].template?.id !== first.template?.id) close++;
      const last = tokens[close];
      if (last?.template?.part !== 'tail' || !KEY_TAIL.test(last.text)) continue;
      tails.add(last.text);
      const substitution = tokens.slice(i + 3, close);
      if (substitution.length !== 1 || substitution[0].kind !== 'ident') continue;
      const owner = enclosingParameter(tokens, i, substitution[0].text);
      if (owner === undefined) continue;
      const id = `${owner.fn}#${owner.index}`;
      const builder = builders.get(id) ?? { ...owner, tails: new Set<string>() };
      builder.tails.add(last.text);
      builders.set(id, builder);
    }
  }

  // A declared prefix builds `prefix + tail` for the tails of each builder a
  // production call hands it to — and nothing at all when no call does.
  const families = new Map<string, string[]>();
  for (const { fn, index, tails: built } of builders.values()) {
    const passed = new Set(production.flatMap((tokens) => literalArguments(tokens, fn, index)));
    for (const prefix of DYNAMIC_TAIL_PREFIXES.filter((p) => passed.has(p))) {
      const keys = new Set([...(families.get(prefix) ?? []), ...[...built].map((t) => prefix + t)]);
      families.set(prefix, [...keys].sort());
    }
  }
  const tailExempt = new Set([...families.values()].flat());

  const unreferenced: string[] = [];
  for (const key of reference.keys()) {
    const base = key.replace(/_(zero|one|two|few|many|other)$/, '');
    if ([...dynamicPrefixes].some((p) => base.startsWith(p))) continue;
    if (tailExempt.has(base)) continue;
    if (sources.some((s) => s.includes(base))) continue;
    unreferenced.push(key);
  }
  unreferenced.sort();

  const baseline = new Set(UNREFERENCED_BASELINE);
  return {
    unreferenced,
    fresh: unreferenced.filter((k) => !baseline.has(k)),
    tails: [...tails].sort(),
    builders: [...new Set([...builders.values()].map((b) => b.fn))].sort(),
    families,
  };
}

/**
 * The ratchet on `DYNAMIC_TAIL_PREFIXES`. A declared prefix is a standing
 * exemption, so it has to keep earning it, both ways:
 *
 *   - the call is gone — no production call passes the prefix, as a whole
 *     literal, to the function that builds the tail keys. A comment, a string
 *     or the same word passed to anything else does not count, so nothing
 *     builds those keys and they are dead copy (they are reported as such too:
 *     an uncalled prefix exempts nothing);
 *   - the keys are gone — none of the keys the call builds resolves against the
 *     catalogue, so the entry suppresses nothing and only widens the sweep's
 *     blind spot for the next key that ends in `.justNow`.
 *
 * Blocking in both directions: a declaration nobody can be forced to delete is
 * the tail-suffix amnesty again, one indirection later.
 */
function auditDynamicTailPrefixes(
  reference: Map<string, string>,
  { tails, builders, families }: TailFamilies,
): boolean {
  const uncalled = DYNAMIC_TAIL_PREFIXES.filter((p) => !families.has(p)).sort();
  const keyless = [...families.keys()]
    .filter((p) => (families.get(p) ?? []).every((key) => !resolves(key, reference)))
    .sort();

  if (uncalled.length > 0) {
    console.log(
      `✗ dynamic tails: ${uncalled.length} declared prefix(es) no production call passes to its builder — delete them from DYNAMIC_TAIL_PREFIXES:`,
    );
    for (const p of uncalled) console.log(`    - ${p}`);
    console.log(
      builders.length > 0
        ? `    (tail-first builders found: ${builders.join(', ')})`
        : '    (no tail-first key builder found in production code)',
    );
  }
  if (keyless.length > 0) {
    console.log(
      `✗ dynamic tails: ${keyless.length} declared prefix(es) build no ${WEBVIEW_REFERENCE} key — delete them from DYNAMIC_TAIL_PREFIXES:`,
    );
    for (const p of keyless) console.log(`    - ${p} (looked for ${families.get(p)?.join(', ')})`);
  }
  if (uncalled.length === 0 && keyless.length === 0) {
    const via = builders.length > 0 ? `, passed as literals to ${builders.join(', ')}` : '';
    console.log(
      `✓ dynamic tails: ${DYNAMIC_TAIL_PREFIXES.length} declared prefix(es) × ${tails.length} tail(s)${via}`,
    );
  }

  return uncalled.length > 0 || keyless.length > 0;
}

/**
 * The ratchet on that baseline. Three ways it stops telling the truth, all of
 * them blocking:
 *
 *   - an entry referenced again — a key that merely lost its consumer for the
 *     length of a purge was written down as dead instead of being left to
 *     come back;
 *   - an entry en.json no longer defines, which suppresses nothing and only
 *     inflates the count;
 *   - a list longer than the census it was last counted at, i.e. an append.
 *
 * Nothing here rewrites the list — a source file that edits itself is worse
 * than the debt — so the run names the offenders and fails until they are gone.
 * The suppression itself is computed live, so a stale entry stops excusing
 * anything the moment it goes stale, whether or not anyone deletes the line.
 */
function auditBaseline(reference: Map<string, string>, unreferenced: string[]): boolean {
  const stillUnreferenced = new Set(unreferenced);
  const revived = UNREFERENCED_BASELINE.filter(
    (k) => reference.has(k) && !stillUnreferenced.has(k),
  ).sort();
  const dropped = UNREFERENCED_BASELINE.filter((k) => !reference.has(k)).sort();
  const removedSince = BASELINE_CENSUS.count - UNREFERENCED_BASELINE.length;

  console.log(
    `baseline census — ${BASELINE_CENSUS.count} entries recorded ${BASELINE_CENSUS.recorded}, ` +
      `${UNREFERENCED_BASELINE.length} listed today (${removedSince} removed since)`,
  );

  if (revived.length > 0) {
    console.log(
      `✗ baseline: ${revived.length} entry(ies) referenced again — delete them from UNREFERENCED_BASELINE:`,
    );
    for (const k of revived) console.log(`    - ${k}`);
  }
  if (dropped.length > 0) {
    console.log(
      `✗ baseline: ${dropped.length} entry(ies) absent from ${WEBVIEW_REFERENCE} — delete them from UNREFERENCED_BASELINE:`,
    );
    for (const k of dropped) console.log(`    - ${k}`);
  }
  if (removedSince < 0) {
    console.log(
      `✗ baseline: ${UNREFERENCED_BASELINE.length} entries against ${BASELINE_CENSUS.count} recorded ` +
        `${BASELINE_CENSUS.recorded} — the baseline may shrink, never grow.`,
    );
  }
  if (revived.length === 0 && dropped.length === 0 && removedSince >= 0) {
    console.log('✓ baseline: every entry is still an unreferenced key of the catalogue');
  }

  return revived.length > 0 || dropped.length > 0 || removedSince < 0;
}

const reportOnly = process.argv.includes('--report');

const webviewDrift = checkParity({
  dir: WEBVIEW_LOCALES_DIR,
  referenceFile: WEBVIEW_REFERENCE,
  header: 'i18n parity (webview)',
  noOneCategory: NO_ONE_CATEGORY,
});

console.log('');

const manifestDrift = checkParity({
  dir: EXTENSION_DIR,
  referenceFile: MANIFEST_REFERENCE,
  header: 'i18n parity (extension manifest)',
  localeFilePattern: /^package\.nls\..+\.json$/,
});

console.log('');

const englishCatalogue = loadLocale(WEBVIEW_LOCALES_DIR, WEBVIEW_REFERENCE);
const sourceDrift = checkSources(englishCatalogue);

console.log('');
const identicalCount = reportIdenticalValues(englishCatalogue);

console.log('');
reportFrenchAccents();

console.log('');
const { unreferenced, fresh, ...tailFamilies } = findUnreferencedKeys(englishCatalogue);
console.log(
  `unreferenced keys — ${unreferenced.length} of ${englishCatalogue.size} (${UNREFERENCED_BASELINE.length} allowlisted as the baseline)`,
);
if (fresh.length === 0) {
  console.log('✓ no key added since the baseline is unreferenced');
} else {
  console.log(`✗ ${fresh.length} newly unreferenced key(s):`);
  for (const k of fresh) console.log(`    - ${k}`);
}

console.log('');
const tailDrift = auditDynamicTailPrefixes(englishCatalogue, tailFamilies);

console.log('');
const baselineDrift = auditBaseline(englishCatalogue, unreferenced);

const hasDrift =
  webviewDrift ||
  manifestDrift ||
  sourceDrift ||
  fresh.length > 0 ||
  identicalCount > 0 ||
  tailDrift ||
  baselineDrift;

if (hasDrift && !reportOnly) {
  console.error('\ni18n parity check FAILED — run with --report for details without failing.');
  process.exit(1);
}

console.log(
  hasDrift
    ? '\ni18n parity check reported drift (--report mode, not failing).'
    : '\nAll locales at 100% parity.',
);
