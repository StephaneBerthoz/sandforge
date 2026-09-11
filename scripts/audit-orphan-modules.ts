/**
 * Orphan-module audit for every shipped source tree.
 *
 * Walks the production import graph from the four real build entry points —
 * the two esbuild entries of the extension host (`src/extension.ts` and
 * `src/core/connection/jsforceEntry.ts`, both named in
 * `packages/extension/package.json`) and the two Vite `build.lib.entry`
 * values of the webview (`src/main.tsx` and `src/main.sidepanel.tsx`) — and
 * reports every module under `packages/extension/src`,
 * `packages/shared/src` or `packages/webview/src` that no shipping code
 * reaches.
 *
 * Why not knip: its vitest plugin treats `*.test.tsx` as an entry point, so
 * any orphan that still has a test file looks reachable. That is exactly the
 * shape of dead code this repo accumulated — a module nobody calls, kept
 * alive by its own test. This walk ignores test files on purpose: a module is
 * reachable only when *shipping* code imports it.
 *
 * Three rules make the answer match what the bundlers actually emit.
 *
 * 1. Value edges vs type edges. `import type { T } from './x'` is erased at
 *    build time: it never puts a byte of `./x` in the bundle. So a type edge
 *    can make a module type-reachable but never runtime-reachable, and only a
 *    value edge propagates runtime reachability. The distinction is read off
 *    the TypeScript AST, not off a regex, so `import type`, `import {}`,
 *    per-specifier `{ type T }` and `export type * from` are all classified
 *    correctly, and a specifier quoted inside a comment or a string is not an
 *    edge at all.
 *
 * 2. Runtime code vs types. A module whose AST emits nothing — only
 *    interfaces, type aliases, `declare`, overloads without a body — compiles
 *    to an empty file. Such a module is legitimately reached by type edges
 *    only and is never reported: deleting it would break `tsc` while changing
 *    no bundle. Only modules that emit at least one statement are candidates.
 *    A barrel counts as emitting nothing when every module it re-exports with
 *    `export *` emits nothing: `types/messages.types.ts` re-exports twenty-one
 *    files of interfaces and is itself as empty as they are.
 *
 * 3. Barrel edges. `export * from './x'` re-exports every symbol of `./x`
 *    without naming one, so counting it as a plain value edge marks `./x`
 *    reachable the moment *anything* imports the barrel. That is how
 *    `RuleProposer.ts` sat unreachable-but-green: a barrel had re-exported it
 *    and no `no orphan modules` run could see that nobody named it. So an
 *    `export *` edge only carries runtime reachability when production code
 *    actually names one of the target's exported symbols — through
 *    `import { X } from '<barrel>'`, a `barrel.X` property access on a
 *    namespace import, a named re-export that is itself consumed, or a direct
 *    import of the module. Names are resolved through chained barrels, so a
 *    symbol named on the outer barrel still reaches the file that declares it.
 *
 * Deliberate over-approximations. Each one keeps a module *alive*, so the gate
 * misses dead code rather than inventing it — with one exception, written at
 * the end of this list: a module that exports nothing offers no name for an
 * `export *` to carry, so the gate calls it dead even though importing the
 * barrel still runs it.
 *
 *   - `import * as ns from '<barrel>'` followed by a computed access
 *     (`ns[key]`), or by any use of `ns` as a value, demands every symbol of
 *     the barrel: all of its `export *` targets stay reachable.
 *   - a side-effect import (`import '<barrel>'`), `import x = require(…)`,
 *     `import('<barrel>')` and `require('<barrel>')` do the same, since none
 *     of them names what it pulls in.
 *   - identifier matching is textual within the importing file: a local
 *     shadowing a namespace name, or an object key that happens to spell it,
 *     is read as a use of the namespace.
 *   - a named import of a symbol two barrels declare marks both declaring
 *     modules reachable.
 *   - only `export *` is conditional. `export { X } from './x'` names X, so it
 *     still pulls `./x` in whole even when nobody imports X from the barrel:
 *     the same blind spot, one file wide instead of a whole directory. No
 *     barrel in the repo re-exports an unconsumed name today; tightening this
 *     is the next step if one appears.
 *   - `export * as ns from './x'` pulls `./x` in whole, unconditionally: the
 *     namespace is a value, and nothing here reads what is taken off it.
 *   - a type imported without the `type` keyword counts as a value, and keeps
 *     its whole module reachable. Neither `verbatimModuleSyntax` nor a lint
 *     rule forbids that here, so the reading is the safe one.
 *   - the documented CLI (`packages/extension/cli`) and the recipe tools are
 *     run from the repository with tsx, never bundled, and are not entry
 *     points here: a module only they import reads as an orphan. Nothing is in
 *     that position today.
 *
 * The exception, the one direction where this gate can be wrong about live
 * code: a module that exports nothing — a pure side effect behind an
 * `export *` — is reported dead, because an `export *` only carries
 * reachability through a name and it offers none. Importing the barrel still
 * executes it. No module in the repo is in that shape; if one appears, import
 * it directly rather than through a barrel.
 *
 * Fixtures: a file that exists to serve tests is named `*.fixtures.ts` or
 * lives under a test-support directory, and is not a subject of this gate.
 *
 * Run with:  pnpm audit:orphans
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

/** Source roots this gate walks, relative to the repo root. */
const SRC_ROOTS = ['packages/extension/src', 'packages/shared/src', 'packages/webview/src'];

/**
 * Production entry points, each verified against the build config that names
 * it. Extension: the two `esbuild` invocations of the `build` script in
 * `packages/extension/package.json` — `jsforceEntry.ts` is a separate output
 * because the first bundle marks it `--external`, and the host loads it with
 * `await import('./jsforceEntry.js')`. Webview: the `build.lib.entry` values
 * of `packages/webview/vite.config.ts`, the second reached with
 * `--mode sidepanel`.
 *
 * Deliberately excluded: `packages/extension/cli/*` and
 * `packages/extension/tools/*` (dev/CI utilities run through `tsx`, excluded
 * from the VSIX by `.vscodeignore`, never bundled) and vitest `setupFiles`
 * (test configuration, not shipped).
 */
const ENTRIES = [
  'packages/extension/src/extension.ts',
  'packages/extension/src/core/connection/jsforceEntry.ts',
  'packages/webview/src/main.tsx',
  'packages/webview/src/main.sidepanel.tsx',
];

/** Extensions tried, in order, when a specifier carries none. */
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];

/** Output extensions a specifier may carry that map back to a source file. */
const OUTPUT_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs'];

/** Workspace package name of the shared contract, and its source root. */
const SHARED_PACKAGE = '@sandforge/shared';
const SHARED_SRC = 'packages/shared/src';

/** Webview `@/` alias, from `resolve.alias` in `packages/webview/vite.config.ts`. */
const WEBVIEW_ALIAS_PREFIX = '@/';
const WEBVIEW_SRC = 'packages/webview/src';

/**
 * Files reachable by means the import graph cannot see: ambient declarations
 * and anything under a test-support directory (helpers imported only by
 * `*.test.tsx`, which is legitimate — they exist to serve tests).
 */
const TEST_SUPPORT_DIRS = ['/testing/', '/__mocks__/', '/test-utils/', '/src/test/'];

/**
 * Naming convention for test data that lives next to the code it describes.
 * Without it an honest fixture placed outside the four directories above was
 * reported as dead, with "delete it or wire it into an entry point" as the
 * only advice — wrong for a file whose whole job is to serve tests.
 */
const FIXTURE_FILE = /\.fixtures\.[cm]?[tj]sx?$/;

/**
 * Orphans this gate tolerates, each with the reason it survived. Every entry
 * carries a type contract that shipped code imports: the file cannot be
 * deleted without breaking `tsc`, only the runtime value inside it is
 * unreachable. Splitting the types out is a separate change.
 *
 * The list is a ratchet, re-validated on every run: an entry that no longer
 * exists, or that shipping code has since started importing by value, fails
 * the gate so the list can neither rot nor quietly grant amnesty.
 */
const ALLOWLIST: ReadonlyArray<{ path: string; reason: string }> = [
  {
    path: 'packages/extension/src/modules/seed/SchemaAnalyzer.ts',
    reason:
      'exports the DescribeField type that SeedCsvHandler and CsvValidator import; only the SchemaAnalyzer class is unreachable',
  },
  {
    path: 'packages/extension/src/core/metadata/MetadataReader.ts',
    reason:
      'exports the ObjectDescribe/FieldDescribe types that CrudFlsGuard and DataOpsHandler import; only the MetadataReader class is unreachable',
  },
  {
    path: 'packages/extension/src/core/storage/ConfigStoreBackend.ts',
    reason:
      'declares the ConfigStoreBackend interface the shipped store implements; only the InMemoryConfigStoreBackend test double is unreachable',
  },
  {
    path: 'packages/shared/src/constants/sf-field-types.ts',
    reason:
      'SfFieldType, which sync/FieldTypeValidator imports, is derived from the SF_FIELD_TYPES array with `typeof`; the array is unreachable as a value but cannot be deleted without the type',
  },
  {
    path: 'packages/shared/src/schemas/ai/callResult.ts',
    reason:
      'AIUsage, which the AI client, the Anthropic adapter and SessionBudget import, is z.infer of AIUsageSchema; the schema is unreachable as a value but cannot be deleted without the type',
  },
  {
    path: 'packages/shared/src/schemas/ai/budget.ts',
    reason:
      'TokenBudgetState, which SessionBudget imports, is z.infer of TokenBudgetStateSchema; the schema is unreachable as a value but cannot be deleted without the type',
  },
  {
    path: 'packages/shared/src/schemas/ai/index.ts',
    reason:
      'barrel that carries the two AI type contracts above into @sandforge/shared; it holds no code of its own',
  },
];

/** True for a spec/test/story file — never part of the production graph. */
function isTestFile(path: string): boolean {
  return /\.(test|spec|stories)\.[cm]?[tj]sx?$/.test(path);
}

/** True for a helper or fixture that exists to serve tests, not the bundle. */
function isTestSupport(path: string): boolean {
  return TEST_SUPPORT_DIRS.some((dir) => path.includes(dir)) || FIXTURE_FILE.test(path);
}

/** Every source file under `dir`, as repo-relative POSIX paths. */
function walkSources(dir: string, repoRoot: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walkSources(full, repoRoot, out);
      continue;
    }
    if (/\.[cm]?[tj]sx?$/.test(entry)) {
      out.push(relative(repoRoot, full).replace(/\\/g, '/'));
    }
  }
  return out;
}

/**
 * "Every symbol", the answer for an import that names nothing it pulls in.
 * A module asked for EVERY re-exports its whole `export *` closure.
 */
const EVERY = Symbol('every exported symbol');
type Demand = ReadonlySet<string> | typeof EVERY;

/** What one module asks of, and offers to, the rest of the graph. */
interface ModuleFacts {
  /** Targets pulled in whole: the module's own code runs. */
  plain: string[];
  /** `export * from` targets — reachable only when a symbol is named. */
  star: string[];
  /** True when an `export *` points outside the walked source roots. */
  opaqueStar: boolean;
  /** Symbols this module asks of another module, per target. */
  demands: Map<string, Demand>;
  /** Symbols this module declares or re-exports under its own name. */
  own: Set<string>;
}

/** True when every named binding of an import/export clause is `type`-marked. */
function allSpecifiersAreTypeOnly(
  elements: ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier>,
): boolean {
  return elements.every((element) => element.isTypeOnly);
}

/**
 * What each namespace binding of a file is used for: the set of properties
 * read off it, or EVERY as soon as the identifier appears anywhere else —
 * a computed access, a spread, an argument. Matching is textual, so a local
 * that shadows the name counts as a use; that errs toward EVERY, which keeps
 * modules alive.
 */
function namespaceUsage(source: ts.SourceFile, names: ReadonlySet<string>): Map<string, Demand> {
  const usage = new Map<string, Demand>();
  for (const name of names) usage.set(name, new Set<string>());

  const property = (namespace: string, name: string): void => {
    const current = usage.get(namespace);
    if (current && current !== EVERY) (current as Set<string>).add(name);
  };

  const visit = (node: ts.Node): void => {
    // The import clause that introduces the binding is not a use of it.
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      names.has(node.expression.text)
    ) {
      property(node.expression.text, node.name.text);
      return;
    }
    if (ts.isQualifiedName(node) && ts.isIdentifier(node.left) && names.has(node.left.text)) {
      property(node.left.text, node.right.text);
      return;
    }
    if (ts.isIdentifier(node) && names.has(node.text)) {
      usage.set(node.text, EVERY);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);

  return usage;
}

/** Every identifier a binding pattern introduces. */
function bindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) bindingNames(element.name, out);
  }
}

/** First existing file among `base`, `base + ext`, `base/index + ext`. */
function resolveBase(base: string, repoRoot: string): string | null {
  const candidates = [
    base,
    ...EXTENSIONS.map((ext) => base + ext),
    ...EXTENSIONS.map((ext) => join(base, 'index' + ext)),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return relative(repoRoot, candidate).replace(/\\/g, '/');
    }
  }
  return null;
}

/**
 * Resolve a specifier from `fromFile` to a repo-relative source path, or null
 * for anything outside the workspace (node_modules, `vscode`, `node:*`).
 *
 * Relative specifiers written with an output extension (`./x.js`, the shape
 * NodeNext requires) map back to the source file. `@sandforge/shared` maps to
 * the shared entry, and its `exports` subpaths (`./types/*`, `./constants/*`,
 * `./schemas/*`) map `dist/<sub>.js` back to `src/<sub>.ts` one-for-one,
 * since the package `build` is a plain `tsc` with `rootDir: src`.
 */
function resolveSpecifier(spec: string, fromFile: string, repoRoot: string): string | null {
  if (spec.startsWith(WEBVIEW_ALIAS_PREFIX)) {
    return resolveBase(
      resolve(repoRoot, WEBVIEW_SRC, spec.slice(WEBVIEW_ALIAS_PREFIX.length)),
      repoRoot,
    );
  }
  if (spec === SHARED_PACKAGE) {
    return resolveBase(resolve(repoRoot, SHARED_SRC, 'index'), repoRoot);
  }
  if (spec.startsWith(`${SHARED_PACKAGE}/`)) {
    const sub = spec.slice(SHARED_PACKAGE.length + 1);
    return resolveBase(resolve(repoRoot, SHARED_SRC, stripOutputExtension(sub)), repoRoot);
  }
  if (!spec.startsWith('.')) return null;

  const base = resolve(dirname(resolve(repoRoot, fromFile)), stripOutputExtension(spec));
  return resolveBase(base, repoRoot);
}

/** Drop a `.js`-family extension so the specifier points back at its source. */
function stripOutputExtension(spec: string): string {
  for (const ext of OUTPUT_EXTENSIONS) {
    if (spec.endsWith(ext)) return spec.slice(0, -ext.length);
  }
  return spec;
}

/** True when a resolved path lives in one of the audited source roots. */
function isInScope(path: string): boolean {
  return SRC_ROOTS.some((root) => path.startsWith(`${root}/`));
}

function main(): void {
  const repoRoot = process.cwd();
  for (const root of SRC_ROOTS) {
    if (!existsSync(resolve(repoRoot, root))) {
      console.error(`[audit-orphan-modules] missing source root: ${root}`);
      process.exit(1);
    }
  }
  for (const entry of ENTRIES) {
    if (!existsSync(resolve(repoRoot, entry))) {
      console.error(`[audit-orphan-modules] missing entry point: ${entry}`);
      process.exit(1);
    }
  }

  const parsed = new Map<string, ts.SourceFile>();
  const parse = (path: string): ts.SourceFile => {
    const cached = parsed.get(path);
    if (cached) return cached;
    const source = ts.createSourceFile(
      path,
      readFileSync(resolve(repoRoot, path), 'utf8'),
      ts.ScriptTarget.Latest,
      /* setParentNodes */ false,
      path.endsWith('.tsx') || path.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    parsed.set(path, source);
    return source;
  };

  /**
   * Every edge a file carries, tagged plain or star, plus the symbols it names
   * on each target and the symbols it offers under its own name.
   *
   * Plain (value) edges: a side-effect import (`import './x'`), any default or
   * namespace binding, a named clause with at least one non-`type` binding,
   * `export { X } from` with at least one non-`type` specifier, `import x =
   * require('…')`, and `import()`/`require()` calls with a literal argument
   * (searched over the whole tree, not just top-level statements).
   *
   * Type edges carry nothing and are dropped: `import type`, `export type`,
   * and clauses whose bindings are all `type`-marked — including the empty
   * clause `import {} from './x'`, which TypeScript also erases.
   */
  const read = (path: string): ModuleFacts => {
    const source = parse(path);
    const facts: ModuleFacts = {
      plain: [],
      star: [],
      opaqueStar: false,
      demands: new Map(),
      own: new Set(),
    };
    const target = (spec: string): string | null => {
      const resolved = resolveSpecifier(spec, path, repoRoot);
      return resolved && isInScope(resolved) ? resolved : null;
    };
    const demand = (to: string, names: Demand): void => {
      const current = facts.demands.get(to);
      if (current === EVERY) return;
      if (names === EVERY) {
        facts.demands.set(to, EVERY);
        return;
      }
      if (!current) facts.demands.set(to, new Set(names));
      else for (const name of names) (current as Set<string>).add(name);
    };
    const pull = (to: string, names: Demand): void => {
      facts.plain.push(to);
      demand(to, names);
    };
    /** Namespace bindings of this file, by local name. */
    const namespaces = new Map<string, string>();

    for (const statement of source.statements) {
      const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
      const isExported = modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      const isDefault = modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

      if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
        const to = target(statement.moduleSpecifier.text);
        const clause = statement.importClause;
        // `import './x'` runs the module and everything it re-exports.
        if (!clause) {
          if (to) pull(to, EVERY);
          continue;
        }
        if (clause.isTypeOnly) continue;
        const named =
          clause.namedBindings && ts.isNamedImports(clause.namedBindings)
            ? clause.namedBindings
            : null;
        // A default or `* as ns` binding always emits; a named clause only
        // emits when at least one of its bindings is not `type`-marked.
        if (!clause.name && named && allSpecifiersAreTypeOnly(named.elements)) continue;
        if (!to) continue;
        if (clause.name) pull(to, new Set(['default']));
        if (named) {
          const names = new Set<string>();
          for (const element of named.elements) {
            if (element.isTypeOnly) continue;
            names.add((element.propertyName ?? element.name).text);
          }
          pull(to, names);
        } else if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          namespaces.set(clause.namedBindings.name.text, to);
        }
        continue;
      }

      if (ts.isExportDeclaration(statement)) {
        if (statement.isTypeOnly) continue;
        const to =
          statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
            ? target(statement.moduleSpecifier.text)
            : null;
        if (!statement.exportClause) {
          // `export * from './x'` — names nothing, so it only carries
          // reachability once someone names a symbol of './x'.
          if (statement.moduleSpecifier) {
            if (to) facts.star.push(to);
            else facts.opaqueStar = true;
          }
          continue;
        }
        if (ts.isNamedExports(statement.exportClause)) {
          if (allSpecifiersAreTypeOnly(statement.exportClause.elements)) continue;
          const names = new Set<string>();
          for (const element of statement.exportClause.elements) {
            if (element.isTypeOnly) continue;
            names.add((element.propertyName ?? element.name).text);
            facts.own.add(element.name.text);
          }
          if (to) pull(to, names);
          continue;
        }
        // `export * as ns from './x'` materialises the whole namespace object.
        facts.own.add(statement.exportClause.name.text);
        if (to) pull(to, EVERY);
        continue;
      }

      if (
        ts.isImportEqualsDeclaration(statement) &&
        ts.isExternalModuleReference(statement.moduleReference) &&
        ts.isStringLiteralLike(statement.moduleReference.expression) &&
        !statement.isTypeOnly
      ) {
        const to = target(statement.moduleReference.expression.text);
        if (to) pull(to, EVERY);
        continue;
      }

      if (ts.isExportAssignment(statement)) {
        facts.own.add('default');
        continue;
      }

      if (!isExported) continue;
      if (isDefault) facts.own.add('default');
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          bindingNames(declaration.name, facts.own);
        }
        continue;
      }
      if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement) ||
          ts.isEnumDeclaration(statement) ||
          ts.isModuleDeclaration(statement)) &&
        statement.name &&
        ts.isIdentifier(statement.name)
      ) {
        facts.own.add(statement.name.text);
      }
    }

    if (namespaces.size > 0) {
      const usage = namespaceUsage(source, new Set(namespaces.keys()));
      for (const [name, to] of namespaces) pull(to, usage.get(name) ?? EVERY);
    }

    // `import('…')` and `require('…')` can sit anywhere in an expression, so
    // the whole tree is visited rather than the statement list. Neither names
    // what it loads, so both ask for every symbol.
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
        const argument = node.arguments[0];
        if ((isDynamicImport || isRequire) && argument && ts.isStringLiteralLike(argument)) {
          const to = target(argument.text);
          if (to) pull(to, EVERY);
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);

    return facts;
  };

  const factsCache = new Map<string, ModuleFacts>();
  const facts = (path: string): ModuleFacts => {
    let cached = factsCache.get(path);
    if (!cached) {
      cached = read(path);
      factsCache.set(path, cached);
    }
    return cached;
  };

  /** Every name a module exports, following its `export *` chain. */
  const exportsCache = new Map<string, ReadonlySet<string> | typeof EVERY>();
  const exportedNames = (
    path: string,
    stack = new Set<string>(),
  ): ReadonlySet<string> | typeof EVERY => {
    const cached = exportsCache.get(path);
    if (cached) return cached;
    if (stack.has(path)) return new Set();
    stack.add(path);
    const current = facts(path);
    if (current.opaqueStar) {
      exportsCache.set(path, EVERY);
      return EVERY;
    }
    const names = new Set(current.own);
    for (const star of current.star) {
      const inherited = exportedNames(star, stack);
      if (inherited === EVERY) {
        exportsCache.set(path, EVERY);
        return EVERY;
      }
      for (const name of inherited) names.add(name);
    }
    stack.delete(path);
    exportsCache.set(path, names);
    return names;
  };

  /**
   * True when the module emits at least one statement — a class, a function
   * with a body, a variable, a non-`declare` enum, an expression, a value
   * re-export or a side-effect import. Interfaces, type aliases, overload
   * signatures and `declare` blocks emit nothing, and neither does a barrel
   * whose whole `export *` closure emits nothing.
   */
  const runtimeCache = new Map<string, boolean>();
  const hasRuntimeCode = (path: string, stack = new Set<string>()): boolean => {
    const cached = runtimeCache.get(path);
    if (cached !== undefined) return cached;
    if (stack.has(path)) return false;
    stack.add(path);

    const isAmbient = (node: ts.Node): boolean =>
      ts.canHaveModifiers(node) &&
      (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DeclareKeyword);

    let emits = false;
    for (const statement of parse(path).statements) {
      if (emits) break;
      if (isAmbient(statement)) continue;

      switch (statement.kind) {
        case ts.SyntaxKind.InterfaceDeclaration:
        case ts.SyntaxKind.TypeAliasDeclaration:
          continue;
        case ts.SyntaxKind.ClassDeclaration:
        case ts.SyntaxKind.EnumDeclaration:
        case ts.SyntaxKind.VariableStatement:
        case ts.SyntaxKind.ExpressionStatement:
        case ts.SyntaxKind.ModuleDeclaration:
          emits = true;
          continue;
        case ts.SyntaxKind.FunctionDeclaration:
          // An overload signature carries no body and emits nothing.
          if ((statement as ts.FunctionDeclaration).body) emits = true;
          continue;
        case ts.SyntaxKind.ImportDeclaration:
          if (!(statement as ts.ImportDeclaration).importClause) emits = true;
          continue;
        case ts.SyntaxKind.ExportDeclaration: {
          const declaration = statement as ts.ExportDeclaration;
          if (declaration.isTypeOnly) continue;
          if (declaration.exportClause && ts.isNamedExports(declaration.exportClause)) {
            if (allSpecifiersAreTypeOnly(declaration.exportClause.elements)) continue;
            emits = true;
            continue;
          }
          if (
            !declaration.moduleSpecifier ||
            !ts.isStringLiteralLike(declaration.moduleSpecifier)
          ) {
            emits = true;
            continue;
          }
          // `export * from './x'`: as empty as './x' is.
          const to = resolveSpecifier(declaration.moduleSpecifier.text, path, repoRoot);
          if (!to || !isInScope(to) || to.endsWith('.json') || hasRuntimeCode(to, stack)) {
            emits = true;
          }
          continue;
        }
        case ts.SyntaxKind.ExportAssignment:
          emits = true;
          continue;
        default:
          emits = true;
          continue;
      }
    }

    stack.delete(path);
    runtimeCache.set(path, emits);
    return emits;
  };

  // Least-fixed-point walk from the production entries. A plain edge pulls its
  // target in whole; an `export *` edge only does so once a demanded name is
  // found among the target's exports. Demands are collected from reachable
  // modules only, so a dead module cannot keep another one alive by naming it,
  // and both sets grow monotonically, so the loop terminates.
  const runtimeReachable = new Set<string>(ENTRIES);
  const demandedNames = new Map<string, Set<string>>();
  const demandedEverything = new Set<string>();

  const wantNames = (path: string, names: Iterable<string>): boolean => {
    if (demandedEverything.has(path)) return false;
    let set = demandedNames.get(path);
    let grew = false;
    if (!set) {
      set = new Set();
      demandedNames.set(path, set);
    }
    for (const name of names) {
      if (!set.has(name)) {
        set.add(name);
        grew = true;
      }
    }
    return grew;
  };

  for (let growing = true; growing; ) {
    growing = false;
    for (const path of [...runtimeReachable]) {
      if (path.endsWith('.json')) continue;
      const current = facts(path);
      for (const to of current.plain) {
        if (!runtimeReachable.has(to)) {
          runtimeReachable.add(to);
          growing = true;
        }
      }
      for (const [to, names] of current.demands) {
        if (names === EVERY) {
          if (!demandedEverything.has(to)) {
            demandedEverything.add(to);
            demandedNames.delete(to);
            growing = true;
          }
          continue;
        }
        if (wantNames(to, names)) growing = true;
      }
    }

    for (const path of [...runtimeReachable]) {
      const current = path.endsWith('.json') ? null : facts(path);
      if (!current || current.star.length === 0) continue;
      const everything = demandedEverything.has(path);
      const wanted = everything ? null : demandedNames.get(path);
      if (!everything && !wanted) continue;
      for (const to of current.star) {
        const available = exportedNames(to);
        const matched = everything
          ? EVERY
          : available === EVERY
            ? new Set(wanted)
            : new Set([...(wanted as Set<string>)].filter((name) => available.has(name)));
        if (matched !== EVERY && matched.size === 0) continue;
        if (!runtimeReachable.has(to)) {
          runtimeReachable.add(to);
          growing = true;
        }
        if (matched === EVERY) {
          if (!demandedEverything.has(to)) {
            demandedEverything.add(to);
            demandedNames.delete(to);
            growing = true;
          }
          continue;
        }
        if (wantNames(to, matched)) growing = true;
      }
    }
  }

  const production = SRC_ROOTS.flatMap((root) => walkSources(resolve(repoRoot, root), repoRoot))
    .filter((path) => !isTestFile(path))
    .filter((path) => !isTestSupport(path))
    .filter((path) => !path.endsWith('.d.ts'))
    .sort();

  // A module with no emitted statement compiles to an empty file: it is
  // supposed to be reached by type edges only, so it is not a candidate.
  const candidates = production.filter((path) => !path.endsWith('.json') && hasRuntimeCode(path));
  const unreachable = candidates.filter((path) => !runtimeReachable.has(path));

  const failures: string[] = [];
  const stale = ALLOWLIST.filter((entry) => !existsSync(resolve(repoRoot, entry.path)));
  if (stale.length > 0) {
    failures.push(
      'stale allowlist entries — the file is gone, delete the entry from this script:\n' +
        stale.map((entry) => `  ${entry.path}`).join('\n'),
    );
  }
  const unreachableSet = new Set(unreachable);
  const revived = ALLOWLIST.filter(
    (entry) => !stale.includes(entry) && !unreachableSet.has(entry.path),
  );
  if (revived.length > 0) {
    failures.push(
      'allowlist entries production code now reaches — delete them from this script:\n' +
        revived.map((entry) => `  ${entry.path}`).join('\n'),
    );
  }

  const allowed = new Set(ALLOWLIST.map((entry) => entry.path));
  const orphans = unreachable.filter((path) => !allowed.has(path));

  console.log(
    `[audit-orphan-modules] ${runtimeReachable.size} module(s) reachable from ${ENTRIES.length} production entry point(s); ` +
      `${candidates.length} of ${production.length} module(s) carry runtime code.`,
  );

  // Print the tolerated ones on every clean run so the debt stays visible
  // instead of hiding behind a green gate.
  for (const entry of ALLOWLIST) {
    console.log(`[audit-orphan-modules] tolerated orphan: ${entry.path} — ${entry.reason}`);
  }

  if (orphans.length > 0) {
    failures.push(
      `${orphans.length} module(s) no production code names:\n` +
        orphans.map((path) => `  ${path}`).join('\n') +
        '\nDelete them (with their tests) or wire them into an entry point — a module\n' +
        'kept alive only by its own test ships nothing and rots. A module a barrel\n' +
        're-exports counts as reached only once production code names one of its\n' +
        'symbols. Test data belongs in a `*.fixtures.ts` file or under a test-support\n' +
        'directory, and is not a subject of this gate.',
    );
  }

  if (failures.length === 0) {
    console.log('[audit-orphan-modules] no orphan modules.');
    return;
  }
  for (const failure of failures) {
    console.error(`[audit-orphan-modules] ${failure}`);
  }
  process.exit(1);
}

main();
