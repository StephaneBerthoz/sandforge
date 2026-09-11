/**
 * Gate: every entry point of the AI call path is reachable from shipping code.
 *
 * `audit-orphan-modules.ts` answers the question one level up — which FILES no
 * shipped import reaches. A file passes that audit as soon as one of its
 * exports is used, so a class can keep a method nobody calls, an interface can
 * keep a signature every implementor is forced to write, and the audit stays
 * green: the file is reachable, the method is not. That blind spot is worth a
 * gate of its own here rather than anywhere else, because on this particular
 * surface an unreachable method is not merely unused code — it is a prompt, a
 * provider round-trip and a token bill that no user can trigger, kept compiling
 * and kept tested as if it shipped.
 *
 * WHAT COUNTS AS A CALLER. Symbol identity, decided by the TypeScript type
 * checker — never the spelling of the member. A gate that credited a caller to
 * `X.<name>(…)` anywhere in the tree could not fail: `complete` also names a
 * method of the Grappe store, `dispose` names twenty-two unrelated methods
 * including `vscode.Disposable`'s, and one of those matches is enough to keep
 * a dead prompt builder green forever. Every rule below resolves the
 * identifier to its declaration and compares declarations, so a namesake in
 * another class, another package or another library is not a caller. Two
 * programs are built for it — one per bundle, each from the package's own
 * tsconfig, with `@sandforge/shared` pointed at its sources so a shared symbol
 * resolves to the file that declares it instead of to emitted `.d.ts`. That
 * costs about two seconds, which is what the answer is worth.
 *
 * Three entry points, three rules.
 *
 * 1. THE PROVIDER CONTRACT. `AIClient` is implemented three times, so every
 *    signature it declares costs three implementations plus their tests. A
 *    signature earns that only if shipped code calls it — on a value the
 *    compiler types as `AIClient`, or on one of the implementors from outside
 *    that implementor. An adapter calling the provider SDK inside its own body
 *    is the method's implementation, not its caller, and the SDK happens to
 *    spell some of its endpoints exactly like the contract method that wraps
 *    them.
 *
 * 2. THE ASSISTANT'S PROVIDER CALLS. Every `AIAssistant` method that reaches
 *    the provider — directly through the injected call function, or through
 *    another method that does — must have a caller outside the class. A prompt
 *    builder with no caller reads like a feature and bills like one, while no
 *    route can reach it.
 *
 * 3. THE SHARED AI SCHEMAS. A schema is alive when shipped code in either
 *    bundle names it, or when its own module derives a type from it with
 *    `z.infer` — the shape of a schema that exists to type a payload. A schema
 *    factory nothing calls is neither.
 *
 * Each rule reports the declaration it cannot justify, so the fix is always the
 * same shape: wire it, or delete it along with the tests that only it kept
 * alive.
 *
 * Run: node --test scripts/ai-call-path-has-callers.test.mjs
 */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A path as TypeScript writes it: forward slashes, on every platform. */
const toTsPath = (p) => p.replace(/\\/g, '/');

const SHARED_ENTRY = toTsPath(join(repoRoot, 'packages/shared/src/index.ts'));
const SHARED_AI_SCHEMAS = join(repoRoot, 'packages/shared/src/schemas/ai');

const AI_CLIENT = toTsPath(join(repoRoot, 'packages/extension/src/adapters/ai/AIClient.ts'));
const AI_ASSISTANT = toTsPath(join(repoRoot, 'packages/extension/src/modules/ai/AIAssistant.ts'));

/** Directories that hold no shipped code. */
const NON_SHIPPED_DIRS = /\/(__mocks__|__fixtures__|__snapshots__|e2e|node_modules)\//;

const toRepoPath = (file) => relative(repoRoot, file).replace(/\\/g, '/');

/**
 * One program per bundle, from the package's own tsconfig.
 *
 * The tsconfigs already exclude `*.test.ts(x)`, so "the files this package
 * ships" needs no second list. `paths` is the one override: the workspace
 * resolves `@sandforge/shared` to `dist/*.d.ts`, and a declaration file has no
 * link back to the source line a rule has to name — pointing the specifier at
 * `src/index.ts` puts the real declarations in both programs.
 */
function buildProgram(packageName) {
  const dir = join(repoRoot, 'packages', packageName);
  const { config, error } = ts.readConfigFile(join(dir, 'tsconfig.json'), ts.sys.readFile);
  assert.ok(!error, `cannot read the ${packageName} tsconfig — this gate reads nothing`);
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, dir);
  const options = {
    ...parsed.options,
    baseUrl: repoRoot,
    paths: { ...parsed.options.paths, '@sandforge/shared': [SHARED_ENTRY] },
  };
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options,
    host: ts.createCompilerHost(options, true),
  });
  const shipped = program
    .getSourceFiles()
    .filter((source) => !source.isDeclarationFile && !NON_SHIPPED_DIRS.test(source.fileName));
  assert.ok(
    shipped.length > 0,
    `the ${packageName} program holds no source — this gate reads nothing`,
  );
  return { packageName, program, checker: program.getTypeChecker(), shipped };
}

const BUNDLES = [buildProgram('extension'), buildProgram('webview')];
const EXTENSION = BUNDLES[0];

/** Identity of a declaration, stable across the two programs that hold it. */
const declKey = (node) => `${toTsPath(node.getSourceFile().fileName)}#${node.getStart()}`;

const at = (node) => {
  const source = node.getSourceFile();
  return `${toRepoPath(source.fileName)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
};

function forEachNode(node, visit) {
  const walk = (current) => {
    visit(current);
    ts.forEachChild(current, walk);
  };
  walk(node);
}

function findDeclaration(source, predicate) {
  let found;
  forEachNode(source, (node) => {
    if (!found && predicate(node)) found = node;
  });
  return found;
}

/** The declarations an identifier resolves to, import aliases unwrapped. */
function resolvedDeclarations(checker, node) {
  let symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return [];
  if (symbol.flags & ts.SymbolFlags.Alias) {
    try {
      symbol = checker.getAliasedSymbol(symbol);
    } catch {
      /* an unresolvable alias resolves to nothing, which is the safe answer */
    }
  }
  return symbol.declarations ?? [];
}

/** The class a node sits in, if any — used to tell a caller from an implementation. */
function enclosingClass(node) {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (ts.isClassDeclaration(cur) || ts.isClassExpression(cur)) return cur;
  }
  return undefined;
}

const isPublicMethod = (member) => {
  if (!ts.isMethodDeclaration(member) && !ts.isMethodSignature(member)) return false;
  if (!member.name || !ts.isIdentifier(member.name)) return false;
  const modifiers = ts.canHaveModifiers(member) ? (ts.getModifiers(member) ?? []) : [];
  return !modifiers.some(
    (m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword,
  );
};

/**
 * Every member call in shipped code whose resolved declaration is one of
 * `targets`, keyed by that declaration.
 *
 * `names` is a speed filter only — the checker decides. Resolving every
 * identifier in two programs would cost more than the programs themselves.
 */
function callersOf(targets) {
  const names = new Set([...targets.values()].map((t) => t.name));
  const found = new Map([...targets.keys()].map((key) => [key, []]));
  for (const { checker, shipped } of BUNDLES) {
    for (const source of shipped) {
      forEachNode(source, (node) => {
        if (!ts.isCallExpression(node)) return;
        const callee = node.expression;
        if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.name)) return;
        if (!names.has(callee.name.text)) return;
        for (const decl of resolvedDeclarations(checker, callee.name)) {
          const hit = found.get(declKey(decl));
          if (hit) hit.push({ node, source });
        }
      });
    }
  }
  return found;
}

test('every AIClient contract method is called by shipped code', () => {
  const source = EXTENSION.program.getSourceFile(AI_CLIENT);
  assert.ok(
    source,
    `${toRepoPath(AI_CLIENT)} is not in the extension program — this gate reads nothing`,
  );
  const contract = findDeclaration(
    source,
    (node) => ts.isInterfaceDeclaration(node) && node.name.text === 'AIClient',
  );
  assert.ok(
    contract,
    `no AIClient interface in ${toRepoPath(AI_CLIENT)} — this gate reads nothing`,
  );

  const contractSymbol = EXTENSION.checker.getSymbolAtLocation(contract.name);
  const methods = contract.members.filter(isPublicMethod);
  assert.ok(
    methods.length > 0,
    'the AIClient interface declares no method — this gate reads nothing',
  );

  // The classes that answer the contract: a call landing on one of their
  // methods still exercises the signature, as long as it comes from outside.
  const implementors = [];
  for (const file of EXTENSION.shipped) {
    forEachNode(file, (node) => {
      if (!ts.isClassDeclaration(node)) return;
      const implementsContract = (node.heritageClauses ?? []).some(
        (clause) =>
          clause.token === ts.SyntaxKind.ImplementsKeyword &&
          clause.types.some((type) =>
            resolvedDeclarations(EXTENSION.checker, type.expression).some(
              (decl) => decl === contract,
            ),
          ),
      );
      if (implementsContract) implementors.push(node);
    });
  }
  assert.ok(
    implementors.length > 0 || contractSymbol,
    'nothing implements AIClient — this gate reads nothing',
  );

  /** declKey → { name, owner } for the signature and each implementation of it. */
  const targets = new Map();
  for (const method of methods) {
    targets.set(declKey(method), { name: method.name.text, owner: undefined, signature: method });
    for (const implementor of implementors) {
      for (const member of implementor.members) {
        if (!isPublicMethod(member) || member.name.text !== method.name.text) continue;
        targets.set(declKey(member), {
          name: method.name.text,
          owner: implementor,
          signature: method,
        });
      }
    }
  }

  const callers = callersOf(targets);
  const reached = new Set();
  for (const [key, sites] of callers) {
    const { owner, signature } = targets.get(key);
    // A call resolved to the signature itself went through the contract,
    // wherever it sits. A call resolved to an implementation only counts from
    // outside that implementation — inside it, the method is calling itself.
    const counts = sites.some(({ node }) => owner === undefined || enclosingClass(node) !== owner);
    if (counts) reached.add(signature);
  }

  const unreachable = methods
    .filter((method) => !reached.has(method))
    .map((method) => `${method.name.text} (${at(method)})`);

  assert.deepEqual(
    unreachable,
    [],
    'AIClient declares methods no shipped code calls, so every implementor writes a body that ' +
      'nothing can reach. Wire them, or drop the signature, the implementations and the tests ' +
      `that only they kept alive: ${unreachable.join(', ')}`,
  );
});

test('every AIAssistant method that reaches the provider has a caller', () => {
  const source = EXTENSION.program.getSourceFile(AI_ASSISTANT);
  assert.ok(
    source,
    `${toRepoPath(AI_ASSISTANT)} is not in the extension program — this gate reads nothing`,
  );
  const assistant = findDeclaration(
    source,
    (node) => ts.isClassDeclaration(node) && node.name?.text === 'AIAssistant',
  );
  assert.ok(
    assistant,
    `no AIAssistant class in ${toRepoPath(AI_ASSISTANT)} — this gate reads nothing`,
  );

  const methods = assistant.members.filter(isPublicMethod);

  /** Methods that hand a prompt to the provider, directly or through one another. */
  const callsProvider = new Set();
  for (let changed = true; changed; ) {
    changed = false;
    for (const method of methods) {
      const name = method.name.text;
      if (callsProvider.has(name)) continue;
      let reaches = false;
      forEachNode(method, (node) => {
        if (!ts.isCallExpression(node)) return;
        const callee = node.expression;
        if (
          !ts.isPropertyAccessExpression(callee) ||
          callee.expression.kind !== ts.SyntaxKind.ThisKeyword
        ) {
          return;
        }
        const target = callee.name.text;
        if (target === 'callFn' || callsProvider.has(target)) reaches = true;
      });
      if (reaches) {
        callsProvider.add(name);
        changed = true;
      }
    }
  }

  assert.ok(
    callsProvider.size > 0,
    'no AIAssistant method reaches the provider any more — this gate reads nothing',
  );

  const targets = new Map();
  for (const method of methods) {
    if (callsProvider.has(method.name.text)) {
      targets.set(declKey(method), { name: method.name.text, method });
    }
  }

  const callers = callersOf(targets);
  const unreachable = [];
  for (const [key, sites] of callers) {
    const { method } = targets.get(key);
    const fromOutside = sites.filter(
      ({ source: caller }) => toTsPath(caller.fileName) !== AI_ASSISTANT,
    );
    if (fromOutside.length === 0) unreachable.push(`${method.name.text} (${at(method)})`);
  }

  assert.deepEqual(
    unreachable,
    [],
    'AIAssistant methods send a prompt to the provider and bill the user for it, yet no shipped ' +
      `code outside the class can reach them: ${unreachable.join(', ')}`,
  );
});

test('every shared AI schema export is named by shipped code or derives a type', () => {
  const files = readdirSync(SHARED_AI_SCHEMAS)
    .filter((name) => name.endsWith('.ts') && name !== 'index.ts')
    .map((name) => toTsPath(join(SHARED_AI_SCHEMAS, name)));
  assert.ok(files.length > 0, 'no shared AI schema module found — this gate reads nothing');

  /** declKey → { name, file } for every export of those modules. */
  const targets = new Map();
  for (const file of files) {
    const source = EXTENSION.program.getSourceFile(file);
    assert.ok(
      source,
      `${toRepoPath(file)} is not in the extension program — this gate reads nothing`,
    );
    forEachNode(source, (node) => {
      if (node.parent !== source) return;
      const modifiers = ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
      if (!modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return;
      const add = (name, decl) => targets.set(declKey(decl), { name, file });
      if (ts.isFunctionDeclaration(node) && node.name) add(node.name.text, node);
      else if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) {
        add(node.name.text, node);
      } else if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) add(decl.name.text, decl);
        }
      }
    });
  }
  assert.ok(
    targets.size > 0,
    'the shared AI schema modules export nothing — this gate reads nothing',
  );

  const names = new Set([...targets.values()].map((t) => t.name));
  const alive = new Set();
  for (const { checker, shipped } of BUNDLES) {
    for (const source of shipped) {
      forEachNode(source, (node) => {
        if (!ts.isIdentifier(node) || !names.has(node.text)) return;
        for (const decl of resolvedDeclarations(checker, node)) {
          const target = targets.get(declKey(decl));
          if (!target) continue;
          const here = toTsPath(source.fileName);
          // Its own module names it in its own declaration; a barrel only
          // forwards it. Neither is a reader.
          const namedElsewhere = here !== target.file && !here.endsWith('index.ts');
          // `z.infer<typeof Schema>` in the declaring module is the shape of a
          // schema written to type a payload — that is what it is for.
          const derivesAType =
            here === target.file && node.parent && ts.isTypeQueryNode(node.parent);
          if (namedElsewhere || derivesAType) alive.add(declKey(decl));
        }
      });
    }
  }

  const orphans = [];
  for (const [key, { name }] of targets) {
    if (!alive.has(key)) {
      const decl = [...EXTENSION.program.getSourceFiles()]
        .filter((s) => toTsPath(s.fileName) === key.split('#')[0])
        .flatMap((s) => {
          let node;
          forEachNode(s, (n) => {
            if (!node && declKey(n) === key) node = n;
          });
          return node ? [node] : [];
        })[0];
      orphans.push(`${name} (${decl ? at(decl) : key})`);
    }
  }

  assert.deepEqual(
    orphans,
    [],
    'shared AI schema exports that nothing names and no type derives from — the contract package ' +
      `ships a shape no side of the bridge reads: ${orphans.join(', ')}`,
  );
});
