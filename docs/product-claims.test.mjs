/**
 * Keeps the prose a user reads honest about features the code does not have:
 * both READMEs, `docs/faq.md`, the Grappe setting descriptions in the manifest
 * and the six webview locale files. The other setting descriptions,
 * `package.nls*.json` and the walkthrough pages are not read.
 *
 * The sibling gate, `automation-scheduler-claims.test.mjs`, guards one claim in
 * two files of `docs/`. That shape works: it is the one gate in this repo that
 * has actually caught prose drifting away from the code. Its blind spot is that
 * the same fact is written in far more than two places.
 *
 * Grappe is described in `README.md`, `packages/extension/README.md`,
 * `docs/faq.md`, three setting descriptions in the manifest, and six locale
 * files. At v1.17.0 it was wrong in two opposite directions at once: the
 * READMEs called it a "parallel execution engine" that "no operation activates
 * yet", while `AutopilotOrchestrator` does activate it and does not partition
 * anything — `grappeAdapter.partition()` has no caller, and `grappeActive`
 * only wraps an unchanged sequential loop in two progress events.
 *
 * CDC is the same story: removed from the Sync UI, disclaimed in
 * `docs/modules/sync.md`, routed to `NoOpHandler` in the extension — and still
 * sold as a working "near real-time" sync mode by the in-app help panel, in all
 * six languages.
 *
 * The AI Assistant row in both READMEs sold "failed-job diagnosis over 10
 * read-only tools". No screen could start a diagnosis, the tools were wired to
 * nothing, and the one call into the tool loop handed it an empty list.
 *
 * So each assertion here is anchored to the code that decides the truth, and
 * fails in BOTH directions: build the feature and the anchor test trips first,
 * telling you the prose is now understating the product and may be rewritten.
 *
 * What the AI Assistant checks do not see, one limit per line:
 *  - Only `packages/extension/src` and `packages/shared/src` are read: the webview never calls the model, and the vendored SDK is not ours to scan.
 *  - A key computed at runtime (a variable, a template, `Reflect.set`, `Object.defineProperty`) hides `tools` from the scan.
 *  - A request that bypasses the SDK, such as a raw HTTP call to `/v1/messages` whose body is built from strings, is invisible.
 *  - A tool call read without the SDK's type name or a `'tool_use'` literal, say `'input' in block`, is invisible; it can only arrive after a request sent tools.
 *  - A tool helper a later SDK exports under a new name or path is caught only through the `tools` key it still needs.
 *  - A read-only-tools phrase is read as the promise only next to two of a count, an AI subject and a diagnosis or failed job, in the same sentence, so a bare "Read-only tools" label passes.
 *  - A diagnosis claim without tools passes: the automatic fix suggestion for a failed run is real, and what was removed was diagnosis over tools.
 *  - A question, or a negation in the four words before the tools, is read as a disclaimer.
 *  - Wording outside the grammar written below, such as a modifier or synonym it does not list, or a seventh language, passes.
 *  - Markdown is read by paragraph, table row, heading and list item, so a sentence split across two rows or two items passes.
 *
 *   node --test docs/product-claims.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const docsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(docsDir, '..');
const read = (...p) => readFileSync(join(repoRoot, ...p), 'utf8');

const LOCALES_DIR = join(repoRoot, 'packages', 'webview', 'src', 'i18n', 'locales');
const localeFiles = () => readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.json'));

/** Every surface a user reads, as `label → text`. Source comments are not here. */
function userFacingText() {
  const surfaces = {
    'README.md': read('README.md'),
    'packages/extension/README.md': read('packages', 'extension', 'README.md'),
    'docs/faq.md': read('docs', 'faq.md'),
  };
  const manifest = JSON.parse(read('packages', 'extension', 'package.json'));
  const props = manifest.contributes?.configuration?.properties ?? {};
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('sandforge.grappe.') && typeof value.description === 'string') {
      surfaces[`package.json ${key}`] = value.description;
    }
  }
  for (const file of localeFiles()) {
    surfaces[`locales/${file}`] = readFileSync(join(LOCALES_DIR, file), 'utf8');
  }
  return surfaces;
}

// ── Grappe ────────────────────────────────────────────────────────────────

test('anchor: Grappe still does not partition or parallelise anything', () => {
  const orchestrator = read(
    'packages',
    'extension',
    'src',
    'modules',
    'autopilot',
    'AutopilotOrchestrator.ts',
  );
  assert.doesNotMatch(
    orchestrator,
    /grappeAdapter\s*\.\s*partition\s*\(/,
    'AutopilotOrchestrator now calls grappeAdapter.partition() — Grappe may really partition ' +
      'work. Re-read every surface below before deleting this test: they are currently written ' +
      'to say it does not.',
  );
});

test('no user-facing surface calls Grappe parallel', () => {
  // `grappeActive` gates two progress events around a sequential executor, so
  // "parallel" is the one word that cannot be used until the anchor above trips.
  const offenders = [];
  for (const [label, text] of Object.entries(userFacingText())) {
    for (const line of text.split('\n')) {
      if (!/grappe/i.test(line)) continue;
      if (/\bparall[eè]l/i.test(line)) offenders.push(`${label}: ${line.trim().slice(0, 120)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'these lines sell Grappe as parallel execution, which it is not:\n  ' + offenders.join('\n  '),
  );
});

test('no user-facing surface claims nothing activates Grappe', () => {
  // The opposite error, shipped in the same table row: Seed, Sync and Autopilot
  // all set `grappeActive`, so "no operation activates it" is equally false.
  const activates = read(
    'packages',
    'extension',
    'src',
    'modules',
    'autopilot',
    'AutopilotOrchestrator.ts',
  );
  assert.match(
    activates,
    /grappeActive/,
    'nothing sets grappeActive any more — the "not activated" wording may be true again',
  );

  const offenders = [];
  for (const [label, text] of Object.entries(userFacingText())) {
    for (const line of text.split('\n')) {
      if (!/grappe/i.test(line)) continue;
      if (/no operation activates/i.test(line))
        offenders.push(`${label}: ${line.trim().slice(0, 120)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'these lines deny an activation that happens:\n  ' + offenders.join('\n  '),
  );
});

// ── CDC / real-time sync ──────────────────────────────────────────────────

test('anchor: every realtime:* channel is still routed to the no-op handler', () => {
  const src = read('packages', 'extension', 'src', 'bridge', 'ExtensionHandlers.ts');
  const noOpRoute = [...src.matchAll(/route\(\s*\[([^\]]*)\]\s*,\s*this\.(\w+)/g)].find(
    ([, , handler]) => handler === 'noOpHandler',
  );
  assert.ok(noOpRoute, 'no `route([...], this.noOpHandler)` call found in ExtensionHandlers.ts');
  for (const channel of ['realtime:start', 'realtime:status', 'realtime:metrics']) {
    assert.match(
      noOpRoute[1],
      new RegExp(`'${channel}'`),
      `${channel} now has a real handler — CDC may work. Re-read the help panel copy in all six ` +
        'locales before deleting this test.',
    );
  }
});

test('the in-app help panel does not sell CDC as a working sync mode', () => {
  // `help.syncContent` is what the Help panel renders. It promised "4 sync
  // modes: Full, Incremental, Delta, CDC" in six languages, for a mode the UI
  // no longer offers and the extension answers with `comingSoon: true`.
  const offenders = [];
  for (const file of localeFiles()) {
    const bundle = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8'));
    const help = bundle.help?.syncContent;
    if (typeof help !== 'string') continue;
    // Accept any wording that marks the gap; reject a bare promise.
    const promises = /\bCDC\b|change data capture/i.test(help);
    // Built from what the six locales actually say, not from guessed wording:
    // the first cut matched only English and flagged four correct translations.
    const disclaims =
      /coming soon|not (?:yet )?(?:wired|available|implemented)|no-op/i.test(help) ||
      /ne sont pas impl|pas encore|no est[áa]n implementad|n[ãa]o est[ãa]o implementad|nicht implementiert|未実装/i.test(
        help,
      );
    if (promises && !disclaims) offenders.push(`locales/${file}: help.syncContent promises CDC`);
  }
  assert.deepEqual(
    offenders,
    [],
    'the help panel sells a sync mode that is a registered no-op:\n  ' + offenders.join('\n  '),
  );
});

// ── AI Assistant ──────────────────────────────────────────────────────────

/**
 * Everything esbuild puts in `dist/extension.js`: the extension's sources and
 * the shared package it inlines (only `vscode`, the Anthropic SDK and the
 * jsforce entry stay external). The floors sit below today's counts; a scan
 * that falls under one has stopped reading shipped code.
 */
const SHIPPED_ROOTS = [
  { root: 'packages/extension/src', minFiles: 250 },
  { root: 'packages/shared/src', minFiles: 60 },
];

/** Directory names that hold test support rather than shipped code. */
const TEST_SUPPORT_DIRS = new Set(['test', '__tests__', '__mocks__', 'fixtures']);

/** A file esbuild can bundle, TypeScript or JavaScript; declaration files cannot be imported. */
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/;
const isDeclarationFile = (name) => /\.d\.[cm]?ts$/.test(name);

/** A shipped source file: a script that is neither a test nor a declaration file. */
const isSourceFile = (name) =>
  SCRIPT_FILE.test(name) && !isDeclarationFile(name) && !/\.(?:test|spec)\./.test(name);

/**
 * Keys that hand the model tools. Nothing else in this extension has a use for
 * them, so one written as a value anywhere in shipped code counts — an object
 * member, a class field, a property assigned later — whatever finally receives
 * the object: a request built in a helper, spread from a variable or handed to
 * a constructor is still a request. A log field named `tools` counts too;
 * rename it. A type naming them sends nothing and does not count.
 */
const TOOL_REQUEST_PROPERTY = new Set(['tools', 'tool_choice']);

/**
 * The Anthropic SDK's tool machinery, as the installed package lays it out.
 * `lib/tools/*`, `tools/*`, `helpers/beta/memory` and `helpers/beta/mcp` hold
 * nothing else, so any import from them counts. `helpers/beta/json-schema` and
 * `helpers/beta/zod` also export structured-output formats, so there only the
 * tool helpers count — by name, as does the runner on `client.beta.messages`.
 */
const SDK_TOOL_SUBPATH =
  /^@anthropic-ai\/sdk\/(?:lib\/tools|tools|helpers\/beta\/(?:memory|mcp))(?:[/.]|$)/;
const SDK_TOOL_HELPER = new Set([
  'toolRunner',
  'BetaToolRunner',
  'betaTool',
  'betaZodTool',
  'betaMemoryTool',
  'BetaLocalFilesystemMemoryTool',
  'mcpTool',
  'mcpTools',
]);

/**
 * Calls that build, wrap, register or run tools of our own: any verb from that
 * family joined to `Tool`/`Tools` — `runTools`, `wrapTool`, `buildReadOnlyTools`,
 * `createToolRegistry`. `Toolbar` and `Tooltip` are different words.
 */
const TOOL_VERB_CALL =
  /^(?:[Rr]un|[Ww]rap|[Bb]uild|[Mm]ake|[Cc]reate|[Rr]egister|[Ww]ith)(?:[A-Z0-9_]\w*)?Tools?(?:[A-Z0-9_]\w*)?$/;

/** Content blocks that only exist once the model has tools: their `type` values, and the SDK's type names for them. */
const TOOL_BLOCK_TYPE = new Set([
  'tool_use',
  'tool_result',
  'server_tool_use',
  'mcp_tool_use',
  'mcp_tool_result',
]);
const TOOL_BLOCK_TYPE_NAME = /^(?:Beta)?(?:Server|MCP)?Tool(?:Use|Result)(?:[A-Z]\w*)?$/;

const SDK_PACKAGE = '@anthropic-ai/sdk';
const isSdkSpecifier = (specifier) =>
  specifier === SDK_PACKAGE || specifier.startsWith(`${SDK_PACKAGE}/`);

const toRepoPath = (file) => relative(repoRoot, file).replace(/\\/g, '/');

function sourceFilesUnder(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!TEST_SUPPORT_DIRS.has(entry.name)) sourceFilesUnder(full, acc);
    } else if (isSourceFile(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

/** The file a relative specifier lands on, as TypeScript and esbuild resolve it: `./a.js` may be `./a.ts`, `./dir` may be `./dir/index.ts`. */
function resolveRelativeImport(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base];
  const script = /\.([cm]?)jsx?$/.exec(base);
  if (script) {
    const stem = base.slice(0, -script[0].length);
    candidates.push(`${stem}.${script[1]}ts`, `${stem}.tsx`);
  }
  for (const extension of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs']) {
    candidates.push(base + extension);
  }
  for (const index of [
    'index.ts',
    'index.tsx',
    'index.js',
    'index.jsx',
    'index.mjs',
    'index.cjs',
  ]) {
    candidates.push(join(base, index));
  }
  return (
    candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null
  );
}

/** Strip the wrappers that do not change what an expression refers to. */
function unwrap(node) {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    (ts.isSatisfiesExpression && ts.isSatisfiesExpression(node))
  ) {
    node = node.expression;
  }
  return node;
}

/** The name a call or `new` invokes: `f()`, `a.b.f()`, `a['f']()`. */
function invokedName(callee) {
  const target = unwrap(callee);
  if (ts.isIdentifier(target) || ts.isPrivateIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  if (ts.isElementAccessExpression(target) && ts.isStringLiteralLike(target.argumentExpression)) {
    return target.argumentExpression.text;
  }
  return null;
}

/** The names along an access chain: `this.client.beta.messages.create` → this, client, beta, messages, create. */
function accessChain(expression) {
  const names = [];
  let node = unwrap(expression);
  for (;;) {
    if (ts.isPropertyAccessExpression(node)) {
      names.unshift(node.name.text);
      node = unwrap(node.expression);
    } else if (ts.isElementAccessExpression(node)) {
      if (ts.isStringLiteralLike(node.argumentExpression)) {
        names.unshift(node.argumentExpression.text);
      }
      node = unwrap(node.expression);
    } else if (ts.isCallExpression(node)) {
      node = unwrap(node.expression);
    } else {
      if (ts.isIdentifier(node)) names.unshift(node.text);
      else if (node.kind === ts.SyntaxKind.ThisKeyword) names.unshift('this');
      return names;
    }
  }
}

/** The name a member declares, when it is written out. */
function memberName(member) {
  const { name } = member;
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text;
  }
  return null;
}

/** The property an assignment writes: `a.tools = …`, `a['tools'] ??= …`. */
function assignedProperty(target) {
  const node = unwrap(target);
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return null;
}

/** A literal inside the list handed to a schema enumeration: `z.enum(['end_turn', 'tool_use'])`. */
function isSchemaEnumMember(literal) {
  const list = literal.parent;
  return (
    ts.isArrayLiteralExpression(list) &&
    ts.isCallExpression(list.parent) &&
    list.parent.arguments.includes(list) &&
    invokedName(list.parent.expression) === 'enum'
  );
}

const isAssignment = (node) =>
  ts.isBinaryExpression(node) &&
  node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
  node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;

let shippedScan;

/**
 * Read every shipped source file once, off the syntax tree — never off the
 * text: a comment, a JSDoc line or a string that mentions `tools:` or
 * `runTools(` is not code, so it can neither trip an assertion nor satisfy a
 * positive control.
 *
 * The result is published only once the walk has finished, so a walk that
 * throws halfway cannot leave a truncated scan behind for the next test.
 */
function scanShippedCode() {
  if (shippedScan) return shippedScan;
  const scan = {
    filesByRoot: new Map(),
    /** Absolute paths of every file read. */
    read: new Set(),
    /** `path:line what` for every way shipped code could give the model tools or act on a tool call. */
    findings: [],
    /** `{ at, text }` for each tool-block literal listed in a schema enumeration. */
    enumeratedToolBlocks: [],
    /** `path:line` of every `max_tokens` member. */
    maxTokensMembers: [],
    /** `{ at, specifier, dynamic }` for every module specifier naming the Anthropic SDK. */
    sdkImports: [],
    /** `{ at, called }` for every use of a member named `chat`. */
    chatUses: [],
    /** `{ at, from, specifier }` for every relative import that is not type-only. */
    relativeImports: [],
  };

  for (const { root } of SHIPPED_ROOTS) {
    const files = sourceFilesUnder(join(repoRoot, root));
    scan.filesByRoot.set(root, files.map(toRepoPath));
    for (const file of files) {
      scan.read.add(file);
      scanFile(scan, file);
    }
  }

  shippedScan = scan;
  return scan;
}

function scanFile(scan, file) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const where = (node) =>
    `${toRepoPath(file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
  const found = (node, what) => scan.findings.push(`${where(node)} ${what}`);

  const moduleSpecifier = (node, specifier, { typeOnly = false, dynamic = false } = {}) => {
    if (specifier.startsWith('.')) {
      if (!typeOnly) scan.relativeImports.push({ at: where(node), from: file, specifier });
    } else if (isSdkSpecifier(specifier)) {
      scan.sdkImports.push({ at: where(node), specifier, dynamic });
      if (SDK_TOOL_SUBPATH.test(specifier)) found(node, `import '${specifier}'`);
    }
  };
  const sdkHelperNames = (node, specifier, elements) => {
    if (!isSdkSpecifier(specifier)) return;
    for (const element of elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (SDK_TOOL_HELPER.has(imported)) found(element, `import { ${imported} }`);
    }
  };

  const visit = (node) => {
    // Modules: what is imported, from where.
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      moduleSpecifier(node, specifier, { typeOnly: !!node.importClause?.isTypeOnly });
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        sdkHelperNames(node, specifier, bindings.elements);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      moduleSpecifier(node, specifier, { typeOnly: node.isTypeOnly });
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        sdkHelperNames(node, specifier, node.exportClause.elements);
      }
    }

    // Calls and constructors: dynamic imports, and anything that runs or builds tools.
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const args = node.arguments ?? [];
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
        args[0] &&
        ts.isStringLiteralLike(args[0])
      ) {
        moduleSpecifier(node, args[0].text, { dynamic: true });
      }
      const name = invokedName(node.expression);
      if (name && (SDK_TOOL_HELPER.has(name) || TOOL_VERB_CALL.test(name))) {
        found(node, `${ts.isNewExpression(node) ? 'new ' : ''}${name}()`);
      }
    }

    // Request fragments: a `tools` key written as a value, wherever the object goes.
    if (
      (ts.isPropertyAssignment(node) ||
        ts.isShorthandPropertyAssignment(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)) &&
      ts.isObjectLiteralExpression(node.parent)
    ) {
      const name = memberName(node);
      if (TOOL_REQUEST_PROPERTY.has(name)) found(node, `{ ${name} }`);
      if (name === 'max_tokens') {
        scan.maxTokensMembers.push(where(node));
      }
    } else if (
      ts.isPropertyDeclaration(node) &&
      node.initializer &&
      TOOL_REQUEST_PROPERTY.has(memberName(node))
    ) {
      found(node, `${memberName(node)} = …`);
    } else if (isAssignment(node) && TOOL_REQUEST_PROPERTY.has(assignedProperty(node.left))) {
      found(node, `.${assignedProperty(node.left)} = …`);
    }

    // Tool calls in a response: the block types, as values or as the SDK's type names.
    if (
      ts.isStringLiteralLike(node) &&
      TOOL_BLOCK_TYPE.has(node.text) &&
      !ts.isLiteralTypeNode(node.parent)
    ) {
      // The Messages API's stop_reason vocabulary includes `tool_use`. A schema
      // enumerating every way a response can end acts on no tool call, and a
      // response can only stop on `tool_use` if a request sent tools — which
      // the key rule above rules out. Any other use of the literal counts.
      if (isSchemaEnumMember(node)) {
        scan.enumeratedToolBlocks.push({ at: where(node), text: node.text });
      } else {
        found(node, `'${node.text}'`);
      }
    } else if (ts.isTypeReferenceNode(node)) {
      const { typeName } = node;
      const last = ts.isIdentifier(typeName) ? typeName.text : typeName.right.text;
      if (TOOL_BLOCK_TYPE_NAME.test(last)) found(node, last);
    }

    if (
      (ts.isPropertyAccessExpression(node) && node.name.text === 'chat') ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === 'chat')
    ) {
      let outer = node;
      while (outer.parent && unwrap(outer.parent) !== outer.parent) outer = outer.parent;
      const called = ts.isCallExpression(outer.parent) && outer.parent.expression === outer;
      scan.chatUses.push({ at: where(node), called });
    } else if (
      ts.isBindingElement(node) &&
      (memberName({ name: node.propertyName }) ?? memberName(node)) === 'chat'
    ) {
      scan.chatUses.push({ at: where(node), called: false });
    }

    ts.forEachChild(node, visit);
  };
  visit(source);
}

/**
 * Positive controls. An empty finding list proves nothing unless the same scan
 * demonstrably reads what ships, sees the calls that do reach the model, and
 * reads the objects and specifiers they are made of. Every test that relies on
 * the scan calls this.
 */
function assertScanReadsShippedCode(scan) {
  for (const { root, minFiles } of SHIPPED_ROOTS) {
    const scanned = scan.filesByRoot.get(root);
    assert.ok(
      scanned.length >= minFiles,
      `the scan read ${scanned.length} files under ${root}, fewer than ${minFiles} — it has ` +
        'stopped reading shipped code, so an empty result below proves nothing',
    );
  }

  // Coverage is judged by what shipped code loads, at any depth: every relative
  // import of a file the scan read lands on a file the scan read too. A test
  // support directory is skipped only as long as nothing shipped imports from it.
  const unread = [];
  for (const { at, from, specifier } of scan.relativeImports) {
    const target = resolveRelativeImport(from, specifier);
    if (target === null) {
      unread.push(`${at} '${specifier}' lands on no file the scan can find`);
    } else if (SCRIPT_FILE.test(target) && !isDeclarationFile(target) && !scan.read.has(target)) {
      unread.push(`${at} '${specifier}' → ${toRepoPath(target)}`);
    }
  }
  assert.deepEqual(
    unread,
    [],
    'shipped code imports files the scan does not read — whatever they hold ships unchecked:\n  ' +
      unread.join('\n  '),
  );

  // The assistant and the Tier 2 modules reach the model through
  // `aiClient().chat({...})` in the AI composition root. `chat` has to be
  // called there, never bound, aliased or destructured: a call made through an
  // alias is a call this scan cannot attribute.
  const compositionRoot = 'packages/extension/src/composition/aiComposition.ts:';
  const chatUses = scan.chatUses.filter((use) => use.at.startsWith(compositionRoot));
  assert.ok(
    chatUses.some((use) => use.called),
    'the scan no longer sees aiComposition.ts calling chat() — it is reading nothing',
  );
  const indirect = chatUses.filter((use) => !use.called).map((use) => use.at);
  assert.deepEqual(
    indirect,
    [],
    'aiComposition.ts takes chat without calling it — the scan cannot see what that route ' +
      'sends:\n  ' +
      indirect.join('\n  '),
  );

  // The key rule reads object members wherever they are written: the walk
  // that would find `tools` in a request finds `max_tokens`, the key every
  // request to the model carries, today — in a literal handed to the SDK or in
  // an object built beforehand alike.
  assert.ok(
    scan.maxTokensMembers.length > 0,
    'the scan no longer sees a `max_tokens` member anywhere in shipped code — it is not reading ' +
      'object members, so it cannot see `tools` either',
  );

  // The sub-path rule reads module specifiers, dynamic ones included: the walk
  // that would find `@anthropic-ai/sdk/lib/tools/…` finds the lazy
  // `import('@anthropic-ai/sdk')` today, whichever file holds it.
  assert.ok(
    scan.sdkImports.some((entry) => entry.dynamic && entry.specifier === SDK_PACKAGE),
    "the scan no longer sees import('@anthropic-ai/sdk') anywhere in shipped code — it is not " +
      'reading dynamic imports, so it cannot see an SDK tool sub-path either',
  );
}

/** Every way shipped code could give the model tools or act on a tool call, as `path:line what`. */
function toolCapabilities() {
  const scan = scanShippedCode();
  assertScanReadsShippedCode(scan);
  return scan.findings;
}

test('anchor: nothing shipped gives the model tools or acts on a tool call', (t) => {
  const found = toolCapabilities();
  for (const literal of shippedScan.enumeratedToolBlocks) {
    t.diagnostic(`stop_reason vocabulary, not a tool call: ${literal.at} '${literal.text}'`);
  }
  assert.deepEqual(
    found,
    [],
    'shipped code can give the model tools or act on a tool call again — the assistant may ' +
      'really use tools. Re-read every surface below before deleting this test: they are ' +
      'currently written to say it does not.\n  ' +
      found.join('\n  '),
  );
});

/**
 * The same surfaces as `userFacingText()`, as a reader meets them: Markdown
 * by paragraph, with soft line breaks joined and fenced code left out; a
 * locale file by string value, never by key.
 */
function userFacingProse() {
  const units = [];
  for (const [label, text] of Object.entries(userFacingText())) {
    if (label.endsWith('.md')) {
      for (const paragraph of markdownParagraphs(text)) units.push({ label, text: paragraph });
    } else if (label.startsWith('locales/')) {
      for (const [key, value] of jsonStrings(JSON.parse(text))) {
        units.push({ label: `${label} ${key}`, text: value });
      }
    } else {
      units.push({ label, text });
    }
  }
  return units;
}

function* jsonStrings(value, key = '') {
  if (typeof value === 'string') {
    yield [key, value];
  } else if (value && typeof value === 'object') {
    for (const [child, nested] of Object.entries(value)) {
      yield* jsonStrings(nested, key ? `${key}.${child}` : child);
    }
  }
}

/** Paragraphs, table rows, headings and list items, each as one line of text. */
function markdownParagraphs(text) {
  const paragraphs = [];
  let lines = [];
  let fence = null;
  const flush = () => {
    if (lines.length > 0) paragraphs.push(lines.join(' '));
    lines = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    const fenceMark = /^\s*(`{3,}|~{3,})/.exec(raw)?.[1];
    if (fence) {
      if (fenceMark && fenceMark[0] === fence[0] && fenceMark.length >= fence.length) fence = null;
      continue;
    }
    if (fenceMark) {
      flush();
      fence = fenceMark;
      continue;
    }
    // A blockquote reads like the paragraph it quotes.
    const line = raw.replace(/^\s*(?:>\s?)+/, '');
    if (line.trim() === '') {
      flush();
      continue;
    }
    const standsAlone = /^\s*\||^\s{0,3}#{1,6}\s/.test(line);
    if (standsAlone || /^\s*(?:[-*+]|\d+[.)])\s/.test(line)) flush();
    lines.push(line.trim());
    if (standsAlone) flush();
  }
  flush();
  return paragraphs;
}

/**
 * Prose as the claim rules read it: compatibility forms folded, emphasis,
 * quotes and link targets dropped, table bars spaced, every dash a hyphen,
 * lower case — so `read-*only*`, a non-breaking hyphen or a full-width letter
 * does not let a paraphrase through.
 */
const normalizeProse = (text) =>
  text
    .normalize('NFKC')
    .replace(/\]\([^)]*\)/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[*_`~"«»“”„[\]]/g, '')
    .replace(/[’‘]/g, "'")
    .replace(/\|/g, ' ')
    .replace(/[\p{Pd}−­]/gu, '-')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const sentencesOf = (text) =>
  text
    .split(/(?<=[.!?;])\s+|(?<=[。！？；])/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

const B = String.raw`(?<![\p{L}\p{N}])`;
const E = String.raw`(?![\p{L}\p{N}])`;
const rule = (source) => new RegExp(source, 'u');

/** Words that may sit between "read-only" and "tools" when the first qualifies the second. */
const MODIFIER = {
  en: String.raw`(?:\d+|salesforce|sf|org|org-level|org-wide|soql|sosl|query|data|metadata|api|apex|schema|record|lookup|search|research|diagnostics?|inspection|analysis|crm|mcp|ai|agent|built-in|internal|dedicated|speciali[sz]ed|safe|simple|lightweight|helper|utility|database|platform|admin|developer)`,
  fr: String.raw`(?:\d+|salesforce|sf|org|soql|sosl|api|apex|ia|internes|d[ée]di[ée]s|int[ée]gr[ée]s|sp[ée]cialis[ée]s|m[ée]tier|de (?:requ[êe]te|diagnostic|recherche|consultation)|d'analyse)`,
  de: String.raw`(?:\d+|salesforce|sf|org|org-[\p{L}]+|soql|sosl|api|apex|ki|abfrage|daten|metadaten|interne[nrs]?|eigene[nrs]?|spezielle[nrs]?)`,
  es: String.raw`(?:\d+|salesforce|sf|org|soql|sosl|api|apex|ia|internas|dedicadas|integradas|especializadas|de (?:consulta|diagn[oó]stico|an[aá]lisis|b[uú]squeda))`,
  pt: String.raw`(?:\d+|salesforce|sf|org|soql|sosl|api|apex|ia|internas|dedicadas|integradas|especializadas|de (?:consulta|diagn[oó]stico|an[aá]lise|busca))`,
};
const gap = (language) => String.raw`(?: ${MODIFIER[language]}){0,2}`;
const gapBefore = (language) => String.raw`(?:${MODIFIER[language]} ){0,2}`;

/**
 * Tools that only read, as each locale writes the qualifier: before the noun
 * in English, German and Japanese, after it in French, Spanish and Portuguese,
 * or as a relative clause. "Read-only mode hides the tools" does not qualify
 * the tools, and does not match.
 */
const READ_ONLY_TOOLS = [
  rule(String.raw`${B}(?:read-only|read only|readonly|query-only)${gap('en')} tools?${E}`),
  rule(String.raw`${B}(?:read-only|readonly)-tools?${E}`),
  rule(
    String.raw`${B}tools? (?:that|which) (?:are |is )?(?:all |strictly |only )?(?:read-only|read only|readonly)${E}`,
  ),
  rule(String.raw`${B}tools? (?:that|which) (?:only|just) read${E}`),
  rule(
    String.raw`${B}outils? ${gapBefore('fr')}(?:en |de |à )?(?:lecture seule|lecture uniquement|seule lecture|consultation seule)${E}`,
  ),
  rule(
    String.raw`${B}outils? ${gapBefore('fr')}(?:qui (?:ne font que lire|se contentent de lire|sont en lecture seule)|sans (?:droits? d'|acc[eè]s en )?[ée]criture)${E}`,
  ),
  rule(
    String.raw`${B}(?:schreibgesch[üu]tzt[\p{L}]*|nur[- ]?lesend[\p{L}]*|read-only)${gap('de')} (?:werkzeug[\p{L}]*|tools?)${E}`,
  ),
  rule(String.raw`${B}nur-?lese-?(?:werkzeug|tool)[\p{L}]*`),
  rule(
    String.raw`${B}(?:werkzeug[\p{L}]*|tools?)${gap('de')},? (?:die|welche) (?:nur|ausschlie(?:ß|ss)lich) lesen${E}`,
  ),
  rule(
    String.raw`${B}(?:werkzeug[\p{L}]*|tools?)${gap('de')} (?:mit (?:reinem |nur )?lesezugriff|ohne schreib(?:zugriff|rechte[\p{L}]*))${E}`,
  ),
  rule(
    String.raw`${B}herramientas? ${gapBefore('es')}(?:de |en |para )?(?:s[oó]lo|solamente|[uú]nicamente) (?:de )?(?:lectura|consulta)${E}`,
  ),
  rule(
    String.raw`${B}herramientas? ${gapBefore('es')}(?:que )?(?:s[oó]lo leen|no modifican|no escriben|sin (?:permisos? de |acceso de )?escritura)${E}`,
  ),
  rule(
    String.raw`${B}ferramentas? ${gapBefore('pt')}(?:de |em |para )?(?:somente|apenas|s[oó]) (?:de )?(?:leitura|consulta)${E}`,
  ),
  rule(
    String.raw`${B}ferramentas? ${gapBefore('pt')}(?:que )?(?:s[oó] leem|apenas leem|n[ãa]o (?:alteram|modificam|escrevem)|sem (?:permiss[ãa]o de )?escrita)${E}`,
  ),
  rule(
    String.raw`(?:読み取り専用|読取専用|リードオンリー|参照専用|読み取りのみ)[^。！？]{0,8}ツール`,
  ),
  rule(String.raw`ツール[^。！？]{0,8}(?:読み取り専用|読取専用|読み取りのみ)`),
];

/** A tools noun in any of the six locales. */
const TOOLS = rule(
  String.raw`${B}(?:tools?|outils?|werkzeug[\p{L}]*|herramientas?|ferramentas?)${E}|ツール`,
);

const COUNT = rule(
  String.raw`^(?:\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozens?|deux|trois|quatre|cinq|sept|huit|neuf|dix|onze|douze|zwei|drei|vier|f[üu]nf|sechs|sieben|acht|neun|zehn|zw[öo]lf|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|doce|dois|duas|tr[êe]s|quatro|sete|oito|nove|dez|doze)[,:]?$`,
);

const AI_SUBJECT = rule(
  String.raw`${B}(?:ai|ia|ki|llm|claude|anthropic|assistant|assistente|asistente|assistent(?:en)?|agent|agente|chatbot)${E}|アシスタント|エージェント|人工知能`,
);

/** A diagnosis, or a failed job, run or task. */
const DIAGNOSIS = rule(
  [
    String.raw`${B}(?:diagnos|diagn[oó]stic|troubleshoot|root-cause|root cause|ursachenanalyse|fehleranalyse|causa ra[ií]z|cause racine)`,
    String.raw`${B}an[aá]lis[ei]s? de (?:[\p{L}-]+ )?(?:fall|error|falha|erro)`,
    String.raw`${B}(?:failed|failing|broken|crashed)[- ](?:[\p{L}\d-]+ )?(?:jobs?|runs?|tasks?)${E}`,
    String.raw`${B}(?:jobs?|runs?|tasks?) (?:that )?(?:failed|fails?|failing|broke|crashed)${E}`,
    String.raw`${B}(?:job|run|task) failures?${E}`,
    String.raw`${B}(?:jobs?|t[âa]ches?|ex[ée]cutions?) (?:[\p{L}-]+ )?(?:en [ée]chec|[ée]chou[ée]e?s?|qui ont [ée]chou[ée])`,
    String.raw`${B}(?:fehlgeschlagen|gescheitert|abgebrochen)[\p{L}]* (?:[\p{L}-]+ )?(?:jobs?|aufgaben|l[äa]ufe|ausf[üu]hrungen)${E}`,
    String.raw`${B}(?:trabajos?|tareas?|ejecuci[oó]n(?:es)?|jobs?) (?:[\p{L}-]+ )?(?:fallid[oa]s?|fallad[oa]s?|con errore?s?|que fallaron)`,
    String.raw`${B}(?:jobs?|tarefas?|execu[çc](?:[ãa]o|[õo]es)|trabalhos?) (?:[\p{L}-]+ )?(?:com falhas?|com erros?|que falharam|falhad[oa]s?)`,
    '診断|原因分析|原因を特定|失敗した(?:ジョブ|タスク)|(?:ジョブ|タスク)の?(?:失敗|エラー)',
  ].join('|'),
);

const NEGATION = rule(
  String.raw`^(?:not|never|no|longer|cannot|can't|don't|doesn't|won't|isn't|aren't|ne|n'[\p{L}]+|jamais|aucun[\p{L}]*|nicht|kein[\p{L}]*|nie|niemals|nunca|ningun[\p{L}]*|ningún|não|nenhum[\p{L}]*)[,:]?$`,
);
const JAPANESE_NEGATION = /ない|ません|なし/u;

/**
 * The removed promise, one sentence at a time: tools that only read, or tools
 * given a count, sold together with the assistant or with a diagnosis. A
 * read-only-tools phrase needs two of a count right before the tools, an AI
 * subject and a diagnosis or failed job; a plain count of tools needs all
 * three. Either alone is how honest prose talks about Production Guard, Monitor
 * or a connection error.
 */
function promisesIn(text) {
  const promises = [];
  for (const sentence of sentencesOf(normalizeProse(text))) {
    if (/[?？]$/.test(sentence)) continue;
    const ai = AI_SUBJECT.test(sentence);
    const diagnosis = DIAGNOSIS.test(sentence);
    const countBefore = (index) => {
      const before = sentence.slice(0, index);
      const words = before.split(' ').filter(Boolean);
      return (
        words.slice(-2).some((word) => COUNT.test(word)) ||
        /[\d十]+(?:個|つ|種類)?の?$/u.test(before)
      );
    };
    const disclaimed = (index) =>
      sentence
        .slice(0, index)
        .split(' ')
        .filter(Boolean)
        .slice(-4)
        .some((word) => NEGATION.test(word)) || JAPANESE_NEGATION.test(sentence.slice(index));

    const readOnly = READ_ONLY_TOOLS.map((pattern) => pattern.exec(sentence)).find(Boolean);
    if (readOnly && !disclaimed(readOnly.index)) {
      if ([countBefore(readOnly.index), ai, diagnosis].filter(Boolean).length >= 2) {
        promises.push(sentence);
        continue;
      }
    }
    const tools = TOOLS.exec(sentence);
    if (tools && ai && diagnosis && countBefore(tools.index) && !disclaimed(tools.index)) {
      promises.push(sentence);
    }
  }
  return promises;
}

test('the claim rules read the removed promise, and nothing plausible around it', () => {
  // Wording the gate exists to stop, in the six locales and the shapes prose
  // takes: a table row, a wrapped paragraph, emphasis, a non-breaking hyphen.
  const promises = [
    '| **AI Assistant**   | NL2SOQL and failed-job diagnosis over 10 read-only tools |',
    '| **AI Assistant**   | Diagnoses failing jobs across 10 read-only Salesforce tools |',
    '| **AI Assistant**   | Ask why a run broke: the assistant looks it up with ten read‑only org tools |',
    '| **AI Assistant**   | Answers org questions with ten read-*only* Salesforce tools |',
    'The assistant looks up why a Seed or Sync run broke with ten read-only\nSalesforce tools.',
    'The AI Assistant diagnoses failed jobs over 10 Salesforce tools.',
    'Diagnostic des jobs en échec via 10 outils en lecture seule',
    "L'assistant IA analyse vos org avec dix outils Salesforce en lecture seule.",
    'Diagnose gescheiterter Jobs über zehn Werkzeuge, die nur lesen',
    'Ursachenanalyse für abgebrochene Jobs mit 10 Werkzeugen ohne Schreibzugriff',
    'Der KI-Assistent prüft Ihre Org mit zehn schreibgeschützten Werkzeugen.',
    'Diagnóstico de tareas con errores mediante diez herramientas que no modifican nada',
    'Análisis de trabajos fallidos con 10 herramientas de solo consulta',
    'Diagnóstico de jobs com falha usando 10 ferramentas somente leitura',
    'ジョブの失敗を10個の読み取り専用ツールで診断します',
  ];
  // Prose an honest page could hold, with the same words in it.
  const legitimate = [
    'Read-only mode prevents writes to production',
    'Read-only orgs hide the write tools',
    'Diagnose why an operation failed from the log panel',
    'In a production org, only read-only tools stay enabled.',
    'Monitor and Compare are two read-only tools: they never write to an org.',
    'Read-only tools in the toolbar stay available while the AI Assistant is off.',
    'The diagnostics panel shows why the last Sync run failed.',
    'While AI is on, every failed Seed run sends its error message to the model for a fix suggestion.',
    'The AI Assistant does not use read-only tools or diagnose failed jobs.',
    'Can the AI Assistant diagnose failed jobs with read-only tools?',
    "Diagnostiquer une erreur de connexion à l'org",
    "Le mode lecture seule masque les outils d'écriture.",
    'En production, seuls les outils en lecture seule restent actifs.',
    'Le panneau de diagnostic affiche la dernière exécution en échec.',
    'Im schreibgeschützten Modus sind die Schreibwerkzeuge ausgeblendet.',
    'Im Schutzmodus bleiben nur zwei Werkzeuge ohne Schreibzugriff aktiv.',
    'Der KI-Assistent erklärt Fehler, führt aber keine Werkzeuge aus.',
    'El modo de solo lectura oculta las herramientas de escritura.',
    'Herramientas de consulta SOQL',
    'En producción solo quedan activas las herramientas de solo lectura.',
    'O modo somente leitura oculta as ferramentas de escrita.',
    'O painel de diagnóstico mostra a última execução com falha.',
    '読み取り専用モードでは書き込みツールが非表示になります',
    '診断パネルに失敗したジョブの一覧が表示されます',
    'Tools',
  ];
  assert.deepEqual(
    promises.filter((text) => promisesIn(text).length === 0),
    [],
    'the claim rules let these promises through',
  );
  assert.deepEqual(
    legitimate.filter((text) => promisesIn(text).length > 0),
    [],
    'the claim rules flag these honest sentences',
  );
});

test('no user-facing surface claims failed-job diagnosis or read-only AI tools', () => {
  // Diagnosis was only ever reachable through tools, so the wording is judged
  // against the same scan — controls included — rather than trusted.
  const found = toolCapabilities();
  assert.deepEqual(
    found,
    [],
    'shipped code can give the model tools again — the wording below may be true again:\n  ' +
      found.join('\n  '),
  );

  const offenders = [];
  for (const { label, text } of userFacingProse()) {
    for (const sentence of promisesIn(text)) offenders.push(`${label}: ${sentence.slice(0, 160)}`);
  }
  assert.deepEqual(
    offenders,
    [],
    'these lines sell an AI feature the extension does not have:\n  ' + offenders.join('\n  '),
  );
});
