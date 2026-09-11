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
 * Two rules make the answer match what the bundlers actually emit.
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
const ALWAYS_REACHABLE = new Set([
  'packages/webview/src/vite-env.d.ts',
  'packages/extension/src/test/setup.ts',
  'packages/extension/src/test/arbitraries.ts',
  'packages/extension/src/test/mockFactories.ts',
]);
const TEST_SUPPORT_DIRS = ['/testing/', '/__mocks__/', '/test-utils/', '/src/test/'];

/**
 * Orphans this gate tolerates, each with the reason it survived. All three
 * carry a type contract that shipped code imports: the file cannot be
 * deleted without breaking `tsc`, only the runtime class inside it is
 * unreachable. Splitting types from class is a separate change.
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
];

/** True for a spec/test/story file — never part of the production graph. */
function isTestFile(path: string): boolean {
  return /\.(test|spec|stories)\.[cm]?[tj]sx?$/.test(path);
}

/** True for a helper that exists to serve tests rather than the bundle. */
function isTestSupport(path: string): boolean {
  return TEST_SUPPORT_DIRS.some((dir) => path.includes(dir));
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

/** One import/export edge: where it points and whether the build erases it. */
interface Edge {
  spec: string;
  /** False when the whole clause is type-only — such an edge emits nothing. */
  value: boolean;
}

/** True when every named binding of an import/export clause is `type`-marked. */
function allSpecifiersAreTypeOnly(
  elements: ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier>,
): boolean {
  return elements.every((element) => element.isTypeOnly);
}

/**
 * Every module specifier a file references, tagged value or type.
 *
 * Value edges: a side-effect import (`import './x'`), any default or
 * namespace binding, a named clause with at least one non-`type` binding,
 * `export ... from` with at least one non-`type` specifier, `import x =
 * require('…')`, and `import()`/`require()` calls with a literal argument
 * (searched over the whole tree, not just top-level statements).
 *
 * Type edges: `import type`, `export type`, and clauses whose bindings are
 * all `type`-marked — including the empty clause `import {} from './x'`,
 * which TypeScript also erases.
 */
function readEdges(source: ts.SourceFile): Edge[] {
  const edges: Edge[] = [];

  const push = (spec: ts.Expression | undefined, value: boolean): void => {
    if (spec && ts.isStringLiteralLike(spec)) edges.push({ spec: spec.text, value });
  };

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (!clause) {
        // `import './x'` — kept for its side effects, so a value edge.
        push(statement.moduleSpecifier, true);
        continue;
      }
      let value = true;
      if (clause.isTypeOnly) {
        value = false;
      } else if (!clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        // A default or `* as ns` binding always emits; a named clause only
        // emits when at least one of its bindings is not `type`-marked.
        value = !allSpecifiersAreTypeOnly(clause.namedBindings.elements);
      }
      push(statement.moduleSpecifier, value);
      continue;
    }

    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      let value = true;
      if (statement.isTypeOnly) {
        value = false;
      } else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        value = !allSpecifiersAreTypeOnly(statement.exportClause.elements);
      }
      push(statement.moduleSpecifier, value);
      continue;
    }

    if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference)
    ) {
      push(statement.moduleReference.expression, !statement.isTypeOnly);
    }
  }

  // `import('…')` and `require('…')` can sit anywhere in an expression, so
  // the whole tree is visited rather than the statement list.
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) push(node.arguments[0], true);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);

  return edges;
}

/**
 * True when the module emits at least one statement — a class, a function
 * with a body, a variable, a non-`declare` enum, an expression, a value
 * re-export or a side-effect import. Interfaces, type aliases, overload
 * signatures and `declare` blocks emit nothing.
 */
function hasRuntimeCode(source: ts.SourceFile): boolean {
  const isAmbient = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.DeclareKeyword);

  for (const statement of source.statements) {
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
        return true;
      case ts.SyntaxKind.FunctionDeclaration:
        // An overload signature carries no body and emits nothing.
        if ((statement as ts.FunctionDeclaration).body) return true;
        continue;
      case ts.SyntaxKind.ImportDeclaration:
        if (!(statement as ts.ImportDeclaration).importClause) return true;
        continue;
      case ts.SyntaxKind.ExportDeclaration: {
        const decl = statement as ts.ExportDeclaration;
        if (decl.isTypeOnly) continue;
        if (decl.exportClause && ts.isNamedExports(decl.exportClause)) {
          if (allSpecifiersAreTypeOnly(decl.exportClause.elements)) continue;
        }
        return true;
      }
      case ts.SyntaxKind.ExportAssignment:
        return true;
      default:
        return true;
    }
  }
  return false;
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

  // Breadth-first walk from the production entries. Only value edges carry
  // runtime reachability; a type edge is followed so its target counts as
  // type-reachable, but it can never make its target runtime-reachable.
  const runtimeReachable = new Set<string>();
  const seen = new Set<string>();
  const queue: Array<{ path: string; value: boolean }> = ENTRIES.map((path) => ({
    path,
    value: true,
  }));

  while (queue.length > 0) {
    const current = queue.shift() as { path: string; value: boolean };
    const key = `${current.value ? 'v' : 't'}:${current.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (current.value) runtimeReachable.add(current.path);

    if (current.path.endsWith('.json')) continue;
    for (const edge of readEdges(parse(current.path))) {
      const resolved = resolveSpecifier(edge.spec, current.path, repoRoot);
      if (!resolved || !isInScope(resolved)) continue;
      queue.push({ path: resolved, value: current.value && edge.value });
    }
  }

  const production = SRC_ROOTS.flatMap((root) => walkSources(resolve(repoRoot, root), repoRoot))
    .filter((path) => !isTestFile(path))
    .filter((path) => !isTestSupport(path))
    .filter((path) => !path.endsWith('.d.ts'))
    .filter((path) => !ALWAYS_REACHABLE.has(path))
    .sort();

  // A module with no emitted statement compiles to an empty file: it is
  // supposed to be reached by type edges only, so it is not a candidate.
  const candidates = production.filter(
    (path) => !path.endsWith('.json') && hasRuntimeCode(parse(path)),
  );
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
      `${orphans.length} module(s) no production code imports:\n` +
        orphans.map((path) => `  ${path}`).join('\n') +
        '\nDelete them (with their tests) or wire them into an entry point — a module\n' +
        'kept alive only by its own test ships nothing and rots.',
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
