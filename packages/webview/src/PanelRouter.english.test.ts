/**
 * The English each part of the panel loads, held to the keys it renders.
 *
 * A panel starts with the namespaces of the catalogue its shell renders
 * (i18n/panelCatalogue.ts), and each part it loads on demand — a page, an
 * overlay — brings the namespaces it renders beyond them (PanelRouter's
 * `page`, `withEnglish`). A namespace a part renders and does not name shows
 * its keys as text; one it names and does not render is parsed for nothing.
 *
 * The keys are read from the source, as the bundler reads it. Every key the
 * webview renders is written as a literal somewhere
 * (scripts/i18n-key-literals.test.mjs holds the code to that): a whole key,
 * the head of a family the code completes (`` t(`forgeRun.gaps.kind.${kind}`) ``),
 * or a namespace a tail-first builder appends to (`formatRelativeTimeI18n`).
 * Some are written in `@sandforge/shared` — the error catalogue's `errors.*`,
 * the templates' names — and reach a page through the function it imports
 * from there. A part's namespaces are those of the files it reaches: its value
 * imports, followed through the webview's modules, through what it loads on
 * demand itself, and through the shared modules that define what it imports.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import en from './i18n/locales/en.json';
import panelCatalogue from './i18n/panelCatalogue';

const WEBVIEW_SRC = resolve(__dirname);
const SHARED_SRC = resolve(WEBVIEW_SRC, '..', '..', 'shared', 'src');
const MAIN = join(WEBVIEW_SRC, 'main.tsx');

/** The namespaces of the English catalogue: its top-level sections. */
const CATALOGUE_NAMESPACES: ReadonlySet<string> = new Set(Object.keys(en));

/**
 * Files whose dotted literals only look like catalogue keys, as the key gate
 * lists them (scripts/i18n-key-literals.test.mjs).
 */
const NOT_CATALOGUE_KEYS: ReadonlySet<string> = new Set([
  join(WEBVIEW_SRC, 'styles', 'testing', 'vscodeThemes.ts'),
]);

/** The tail-first builder, called with the namespace it appends tails to. */
const TAIL_FIRST_BUILDER = 'formatRelativeTimeI18n';

/** The names of the calls that load a part with its English. */
const ENGLISH_LOADERS: ReadonlySet<string> = new Set(['page', 'withEnglish']);

/**
 * Keys the extension sends, which no webview file spells whole: each with
 * the file that renders it. The extension's Smart Action names its reason by
 * key, and its AI breaker the banner's words.
 */
const HOST_SENT_KEYS = [
  { key: 'home.smartAction.reasonClone', renderedBy: 'pages/Home/SmartActionCard.tsx' },
  { key: 'ai.error.overloaded', renderedBy: 'pages/AI/components/AIProviderStatusBanner.tsx' },
];

const label = (file: string): string => relative(WEBVIEW_SRC, file).replace(/\\/g, '/');

/** The value at a dotted path of the English catalogue, or undefined. */
function at(path: string): unknown {
  let node: unknown = en;
  for (const part of path.split('.')) {
    if (typeof node !== 'object' || node === null || !(part in node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** Whether `text` names an entry of the catalogue, a plural of one, or a flat family's stem. */
function namesAnEntry(text: string): boolean {
  if (at(text) !== undefined) return true;
  const segments = text.split('.');
  const stem = segments.pop() ?? '';
  const parent = at(segments.join('.'));
  return (
    typeof parent === 'object' &&
    parent !== null &&
    stem !== '' &&
    Object.keys(parent).some((key) => key.startsWith(stem))
  );
}

/** The namespace a literal names, when it reads as a key of the catalogue. */
function namespaceOfKey(text: string): string | undefined {
  if (!/^[a-z][A-Za-z0-9]*\.[A-Za-z0-9_.]+$/.test(text)) return undefined;
  const namespace = text.split('.')[0];
  return CATALOGUE_NAMESPACES.has(namespace) && namesAnEntry(text) ? namespace : undefined;
}

function parse(name: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    name,
    text,
    ts.ScriptTarget.Latest,
    true,
    name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

const parsed = new Map<string, ts.SourceFile>();
function source(file: string): ts.SourceFile {
  let tree = parsed.get(file);
  if (!tree) {
    tree = parse(file, readFileSync(file, 'utf8'));
    parsed.set(file, tree);
  }
  return tree;
}

/** The file a relative specifier names, or undefined for a non-source import (CSS, JSON). */
function resolveLocal(spec: string, from: string): string | undefined {
  const base = resolve(dirname(from), spec.replace(/\.js$/, ''));
  return [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')].find(
    (candidate) => existsSync(candidate),
  );
}

/** What a file imports as values: relative modules now, relative modules on demand, and names from shared. */
interface FileImports {
  static: string[];
  dynamic: Array<{ spec: string; node: ts.CallExpression }>;
  shared: string[];
}

function importsIn(tree: ts.SourceFile): FileImports {
  const found: FileImports = { static: [], dynamic: [], shared: [] };
  for (const statement of tree.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly) continue;
      const bindings = clause?.namedBindings;
      const named =
        bindings && ts.isNamedImports(bindings)
          ? bindings.elements.filter((element) => !element.isTypeOnly)
          : [];
      // `import { type A, type B } from …` imports nothing at run time.
      if (clause && !clause.name && bindings && ts.isNamedImports(bindings) && named.length === 0) {
        continue;
      }
      const spec = statement.moduleSpecifier.text;
      if (spec === '@sandforge/shared') {
        found.shared.push(...named.map((element) => (element.propertyName ?? element.name).text));
      } else if (spec.startsWith('.')) {
        found.static.push(spec);
      }
    }
    if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.startsWith('.')
    ) {
      found.static.push(statement.moduleSpecifier.text);
    }
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text.startsWith('.')
    ) {
      found.dynamic.push({ spec: node.arguments[0].text, node });
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

const importsOf = (file: string): FileImports => importsIn(source(file));

/** The namespaces whose keys a source spells. */
function namespacesIn(tree: ts.SourceFile): Set<string> {
  const namespaces = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const namespace = namespaceOfKey(node.text);
      if (namespace) namespaces.add(namespace);
    }
    if (ts.isTemplateExpression(node)) {
      const head = /^([a-z][A-Za-z0-9]*)\./.exec(node.head.text);
      if (head && CATALOGUE_NAMESPACES.has(head[1])) namespaces.add(head[1]);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === TAIL_FIRST_BUILDER
    ) {
      for (const argument of node.arguments) {
        if (!ts.isStringLiteralLike(argument)) continue;
        const namespace = argument.text.split('.')[0];
        if (CATALOGUE_NAMESPACES.has(namespace)) namespaces.add(namespace);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return namespaces;
}

const namespacesSpelledIn = (file: string): Set<string> =>
  NOT_CATALOGUE_KEYS.has(file) ? new Set() : namespacesIn(source(file));

function sharedSources(dir = SHARED_SRC, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sharedSources(path, acc);
    else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) acc.push(path);
  }
  return acc;
}

let sharedIndex: Map<string, string[]> | undefined;
/** Which shared files define each name the package exports. */
function sharedDefinitions(): Map<string, string[]> {
  if (sharedIndex) return sharedIndex;
  const index = new Map<string, string[]>();
  for (const file of sharedSources()) {
    const text = readFileSync(file, 'utf8');
    const names = [
      ...text.matchAll(
        /^export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|enum)\s+([A-Za-z_$][\w$]*)/gm,
      ),
    ].map((match) => match[1]);
    for (const match of text.matchAll(/^export\s*\{([^}]*)\}\s*;/gm)) {
      for (const part of match[1].split(',')) {
        const name = part
          .trim()
          .split(/\s+as\s+/)
          .pop();
        if (name) names.push(name);
      }
    }
    for (const name of names) index.set(name, [...(index.get(name) ?? []), file]);
  }
  sharedIndex = index;
  return index;
}

/** The shared files `file` reaches through its own relative imports, itself included. */
function sharedClosure(file: string, seen: Set<string>): void {
  if (seen.has(file)) return;
  seen.add(file);
  for (const spec of importsOf(file).static) {
    const next = resolveLocal(spec, file);
    if (next) sharedClosure(next, seen);
  }
}

/** The webview files a part reaches, and the shared files behind what they import. */
interface CatalogueGraph {
  files: Set<string>;
  shared: Set<string>;
}

/**
 * The files `entry` reaches: its static value imports, and with
 * `followDynamic` the modules it loads on demand too — but for those it
 * loads with English of their own (`withEnglish`), which are parts of their
 * own ({@link nestedParts}).
 */
function reach(entry: string, followDynamic: boolean): CatalogueGraph {
  const files = new Set<string>();
  const shared = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    const imports = importsOf(file);
    const specs = followDynamic
      ? [
          ...imports.static,
          ...imports.dynamic
            .filter(({ node }) => declaredNamespaces(node) === null)
            .map(({ spec }) => spec),
        ]
      : imports.static;
    for (const spec of specs) {
      const next = resolveLocal(spec, file);
      if (next) queue.push(next);
    }
    for (const name of imports.shared) {
      for (const definition of sharedDefinitions().get(name) ?? []) {
        sharedClosure(definition, shared);
      }
    }
  }
  return { files, shared };
}

/** The namespaces whose keys the files of `graph` spell. */
function namespacesOf(graph: CatalogueGraph): Set<string> {
  const namespaces = new Set<string>();
  for (const file of [...graph.files, ...graph.shared]) {
    for (const namespace of namespacesSpelledIn(file)) namespaces.add(namespace);
  }
  return namespaces;
}

/** A part of the panel loaded on demand, and the English its loader names. */
interface LazyPart {
  /** The file the part's chunk starts at. */
  file: string;
  /** Where it is loaded from. */
  from: string;
  /** The namespaces its loader names, or null when it names none. */
  declared: string[] | null;
}

/** The namespaces a dynamic import's loader names: the array its enclosing loader call ends with. */
function declaredNamespaces(node: ts.Node): string[] | null {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      ts.isCallExpression(parent) &&
      ts.isIdentifier(parent.expression) &&
      ENGLISH_LOADERS.has(parent.expression.text)
    ) {
      const last = parent.arguments[parent.arguments.length - 1];
      if (!last || !ts.isArrayLiteralExpression(last)) return null;
      return last.elements.map((element) =>
        ts.isStringLiteralLike(element) ? element.text : `<${element.getText()}>`,
      );
    }
  }
  return null;
}

/** Every part the files of `graph` load on demand. */
function lazyParts(graph: CatalogueGraph): LazyPart[] {
  const parts: LazyPart[] = [];
  for (const from of graph.files) {
    for (const { spec, node } of importsOf(from).dynamic) {
      const file = resolveLocal(spec, from);
      if (file) parts.push({ file, from, declared: declaredNamespaces(node) });
    }
  }
  return parts;
}

/**
 * The parts a part loads on demand with English of their own: the steps of
 * Forge past its input, which load `forgeRun` as they come, where the page
 * loads its input's `forge`.
 */
function nestedParts(part: LazyPart): LazyPart[] {
  return lazyParts(reach(part.file, true)).filter((nested) => nested.declared !== null);
}

const sorted = (values: Iterable<string>): string[] => [...values].sort();

describe('the English a panel loads', () => {
  const shell = reach(MAIN, false);
  const shellNamespaces = namespacesOf(shell);
  const parts = lazyParts(shell);
  const needed = (part: LazyPart): string[] =>
    sorted([...namespacesOf(reach(part.file, true))].filter((n) => !shellNamespaces.has(n)));

  it('reads a key written whole, as the head of a family, and through the tail-first builder', () => {
    const read = (text: string): string[] => sorted(namespacesIn(parse('probe.tsx', text)));
    expect(read("t('forgeRun.gaps.notRead')")).toEqual(['forgeRun']);
    expect(read("<Trans i18nKey='common.typeToConfirm' />")).toEqual(['common']);
    expect(read('t(`sync.history.status_${status}`)')).toEqual(['sync']);
    expect(read("formatRelativeTimeI18n(ts, t, 'home')")).toEqual(['home']);
    // A dotted string the catalogue does not hold is no key, nor a bare word.
    expect(read("t('forge.noSuchKeyAnywhere'); route === 'forge'")).toEqual([]);
  });

  it('follows a page into the shared modules that define what it imports', () => {
    const home = reach(join(WEBVIEW_SRC, 'pages', 'Home', 'HomePage.tsx'), true);
    // Through `panelWordingOf`, a webview hook reaches the error catalogue.
    expect(sorted([...home.shared].map((file) => relative(SHARED_SRC, file)))).toContain(
      join('utils', 'error-hints.ts'),
    );
    expect(namespacesOf(home).has('errors')).toBe(true);
  });

  it('starts every panel with the namespaces its shell renders, and only those', () => {
    // Positive control: the shell is read, and it renders the page names.
    expect(shell.files.has(join(WEBVIEW_SRC, 'PanelApp.tsx'))).toBe(true);
    expect(shellNamespaces.has('nav')).toBe(true);
    expect(sorted(Object.keys(panelCatalogue))).toEqual(sorted(shellNamespaces));
    for (const [namespace, strings] of Object.entries(panelCatalogue)) {
      expect(strings).toEqual(en[namespace as keyof typeof en]);
    }
  });

  it('loads every page, overlay and the sidebar the panel shows on demand with the English it renders', () => {
    const where = (part: LazyPart): string => `${label(part.file)} (loaded by ${label(part.from)})`;
    // Eighteen pages, three overlays and the sidebar's dev-server branch.
    expect(parts.length).toBe(22);
    const offenders = parts.flatMap((part) => {
      const renders = needed(part);
      if (part.declared === null) {
        return [`${where(part)} is loaded with no English of its own, and renders ${renders}`];
      }
      const declared = sorted(part.declared);
      if (declared.join() === renders.join()) return [];
      const missing = renders.filter((n) => !declared.includes(n));
      const extra = declared.filter((n) => !renders.includes(n));
      return [
        `${where(part)}: renders ${missing.join(', ') || 'nothing'} it does not load, ` +
          `loads ${extra.join(', ') || 'nothing'} it does not render`,
      ];
    });
    expect(offenders).toEqual([]);
  });

  /*
   * Forge's English was parsed whole before its input painted: 46 kB, three
   * quarters of it the review's, the execution's and the results' words. The
   * steps past the input load those as they come (`forgeRun`), each beyond
   * the shell's and its page's namespaces, which are in when it renders.
   */
  it('loads each step a page loads on demand with the English it renders beyond its page’s', () => {
    const offenders = parts.flatMap((part) =>
      nestedParts(part).flatMap((nested) => {
        const loaded = new Set([...shellNamespaces, ...(part.declared ?? [])]);
        const renders = sorted(
          [...namespacesOf(reach(nested.file, true))].filter((n) => !loaded.has(n)),
        );
        const declared = sorted(nested.declared ?? []);
        return declared.join() === renders.join()
          ? []
          : [
              `${label(nested.file)} (loaded by ${label(nested.from)}) renders ` +
                `${renders.join(', ') || 'nothing'} beyond its page's, and loads ${declared.join(', ')}`,
            ];
      }),
    );
    const forge = parts.find((part) => label(part.file) === 'pages/Forge/ForgePage.tsx');
    // Positive control: the four steps are read as parts of their own.
    expect(sorted(nestedParts(forge!).map((nested) => label(nested.file)))).toEqual([
      'pages/Forge/ForgeDiscovery.tsx',
      'pages/Forge/ForgeExecution.tsx',
      'pages/Forge/ForgeResults.tsx',
      'pages/Forge/ForgeReview.tsx',
    ]);
    expect(offenders).toEqual([]);
  });

  /*
   * A key spelled outside its namespace brings the whole namespace: the hook
   * every query goes through put Seed's 20 kB on ten pages for three words,
   * Home parsed Onboarding's 34 kB for a banner, and the removal and currency
   * views Forge shares put its 59 kB on Seed, Sync, Frozen and Autopilot. The
   * words a part shares live in the shell's namespaces or in one of their own
   * (runRemoval, runResults, orgAutomation), and no page loads these again.
   */
  it('loads no other page’s English for the words a shared part says', () => {
    const notLoaded: Record<string, string[]> = {
      'pages/Home/HomePage.tsx': ['forge', 'onboarding', 'org', 'seed', 'sidePanel'],
      'pages/OrgManager/OrgManagerPage.tsx': ['monitor', 'seed', 'sidePanel'],
      // The steps past its input bring their own words (forgeRun) as they come.
      'pages/Forge/ForgePage.tsx': ['forgeRun', 'frozen', 'org', 'seed', 'sync'],
      'pages/Frozen/FrozenPage.tsx': ['forge', 'org', 'seed'],
      'pages/Monitor/MonitorPage.tsx': ['org', 'reports', 'seed', 'sidePanel', 'sync'],
      'pages/Compare/ComparePage.tsx': ['org', 'seed', 'sidePanel'],
      'pages/DataOps/DataOpsPage.tsx': ['org', 'seed'],
      'pages/Automation/AutomationPage.tsx': ['dataops', 'org', 'seed', 'sidePanel'],
      'pages/Migration/MigrationPage.tsx': ['automation', 'org', 'seed'],
      'pages/Reports/ReportsContainer.tsx': ['org', 'seed'],
      'pages/Settings/SettingsPage.tsx': ['org', 'seed'],
      'pages/Seed/SeedPage.tsx': ['forge', 'frozen', 'help', 'org', 'sidePanel', 'sync'],
      'pages/Sync/SyncPage.tsx': [
        'automation',
        'forge',
        'frozen',
        'onboarding',
        'org',
        'reports',
        'seed',
        'sidePanel',
      ],
      'pages/Autopilot/AutopilotPage.tsx': ['forge', 'org', 'seed'],
    };
    const offenders = Object.entries(notLoaded).flatMap(([page, namespaces]) => {
      const part = parts.find((candidate) => label(candidate.file) === page);
      if (!part) return [`${page} is not a part the panel loads`];
      const renders = needed(part);
      return namespaces
        .filter((namespace) => renders.includes(namespace))
        .map((namespace) => `${page} renders keys of "${namespace}"`);
    });
    expect(offenders).toEqual([]);
  });

  it('loads the namespaces of the keys the extension sends with the part that renders them', () => {
    for (const { key, renderedBy } of HOST_SENT_KEYS) {
      expect(namesAnEntry(key)).toBe(true);
      const file = join(WEBVIEW_SRC, renderedBy);
      const namespace = key.split('.')[0];
      const showing = parts.filter((part) => reach(part.file, true).files.has(file));
      expect(showing.length).toBeGreaterThan(0);
      for (const part of showing) {
        expect([...shellNamespaces, ...(part.declared ?? [])]).toContain(namespace);
      }
    }
  });
});
