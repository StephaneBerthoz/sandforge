/**
 * Keeps the prose a user reads honest about features the code does not have:
 * both READMEs, every page under `docs/` they link to, the Grappe setting
 * descriptions in the manifest, the six webview locale files, and — for the AI
 * wordings — the English fallbacks the webview hands to `t()`. The other
 * setting descriptions, `package.nls*.json` and the walkthrough pages are not
 * read.
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
 * fails in BOTH directions: build the feature — the partition, the CDC route,
 * the tools — and the anchor test trips first, telling you the prose is now
 * understating the product and may be rewritten. The wordings that named no
 * tool are the exception, and the limits below say so.
 *
 * The code is read off the syntax tree. The prose is not read for meaning at
 * all: it is matched against the wording this product actually published,
 * mined from every revision of every public surface in the repository. An
 * earlier cut guessed at what a promise looks like, and flagged the honest
 * removal note, a competitor comparison and a true sentence about Monitor and
 * Compare — a class of false alarm that only a negation parser in six
 * languages would close. Refusing the wording that shipped needs none.
 *
 * Two rules keep that from becoming the same noise by another route. A wording
 * is mined whole, as the bullet or the cell that sold it: `read-only tool
 * surface` on its own is security vocabulary any module may use, and four
 * translators borrow the English term for a sentence that promises nothing. And
 * structure separates — a table cell, a link label, a list item, a sentence —
 * so no wording is assembled out of two neighbours a reader never meets as one
 * phrase.
 *
 * What the AI Assistant checks do not see, one limit per line:
 *  - Code is read under `packages/extension/src` and `packages/shared/src`, plus the JSON under those and under `packages/extension/resources`; a fourth workspace package fails the control below instead of passing unread.
 *  - Provider options handed through from outside the code — a webview payload, a user setting spread into the request — carry a `tools` key written nowhere in the repository.
 *  - A tool catalogue written into the prompt text, whose reply is parsed by hand, gives the model tools under no key and no block type this scan knows.
 *  - A key computed at runtime (a variable, a template, `Reflect.set`, `Object.defineProperty`) hides `tools` from the scan.
 *  - A request that bypasses the SDK, such as a raw HTTP call to `/v1/messages` whose body is built from strings, is invisible.
 *  - A tool call read without the SDK's type name or a `'tool_use'` literal, say `'input' in block`, is invisible; it can only arrive after a request sent tools.
 *  - A tool helper a later SDK exports under a new name or path is caught only through the request key it still needs.
 *  - An OpenAI-shaped request, `functions` with `function_call`, is not watched: Functions is a Salesforce product this extension talks about, so the key is ordinary vocabulary here. Reaching that shape means a second provider, which the code anchor's own controls would show.
 *  - A tool factory whose name carries on past the word, `createToolRegistry`, is not caught by name — `Tools` is also a panel label in this product, so the name has to end on it. What the factory builds is still caught when it reaches a request or an SDK helper.
 *  - A tool API reached through an alias, `const register = vscode.lm.registerTool.bind(vscode.lm)`, is not read as a call on `lm`.
 *  - Prose refuses published wording, whole: a paraphrase, a new sentence, a translation, or the same sentence with a word inflected — `diagnostics` for `diagnosis`, `surfaces` for `surface` — passes. The count is the one word that may change.
 *  - Any quotation of a published wording is refused like the promise: struck through, inside quotation marks, in a removal note or in an answer about an old version alike. A changelog is not a surface, so that is where the quote belongs.
 *  - A wording that does not name the tools is released by rewriting it, not by the anchor: the anchor answers one question, whether shipped code gives the model tools.
 *  - Markdown is read by paragraph, table row, heading and list item: a fenced code block is not prose, and a wording split across two rows or two items passes — as it does across two locale keys rendered side by side.
 *  - The webview's English fallbacks are read for these wordings only. The Grappe and CDC rules above read the files listed at the top, and `grappe.subtitle` still calls Grappe a parallel execution engine in `GrappePage.tsx`, which those rules refuse in every file they do read.
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

const READMES = ['README.md', 'packages/extension/README.md'];

/**
 * The pages a README sends a reader to: every `docs/**.md` either one links to,
 * written relatively in the repository README and as a GitHub URL in the
 * marketplace one. A page reached from the listing in one click is read like
 * the listing itself, and the list maintains itself — link a new page and it
 * becomes a surface, drop the link and it stops being one.
 */
function linkedDocPages() {
  const pages = new Set();
  for (const readme of READMES) {
    for (const [, target] of read(...readme.split('/')).matchAll(/\]\(([^)\s]+)/g)) {
      const path = /(?:^|\/)(docs\/[^#?]+\.md)/.exec(target.split('#')[0])?.[1];
      if (path && existsSync(join(repoRoot, path))) pages.add(path);
    }
  }
  // A README whose links stopped resolving would quietly shrink the surface.
  assert.ok(
    pages.size >= 8,
    `the READMEs link to ${pages.size} pages under docs/, fewer than the 11 they carry — the ` +
      'link scan has stopped resolving, so an empty result below proves nothing',
  );
  return [...pages].sort();
}

/** Every surface a user reads, as `label → text`. Source comments are not here. */
function userFacingText() {
  const surfaces = {};
  for (const readme of READMES) surfaces[readme] = read(...readme.split('/'));
  for (const page of linkedDocPages()) surfaces[page] = read(...page.split('/'));
  const manifest = JSON.parse(read('packages', 'extension', 'package.json'));
  const props = manifest.contributes?.configuration?.properties ?? {};
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('sandforge.grappe.') && typeof value.description === 'string') {
      surfaces[`package.json ${key}`] = value.description;
    }
  }
  const locales = localeFiles();
  assert.ok(
    locales.length >= 6,
    `only ${locales.length} locale files found, the extension ships 6`,
  );
  for (const file of locales) {
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

/** The three packages that premise covers. A fourth would be inlined the same way, and read by nothing here. */
const WORKSPACE_PACKAGES = ['@sandforge/shared', '@sandforge/webview', 'sandforge'];

/**
 * Where a tool definition can sit as data rather than as code: beside the
 * sources, and in the folder the VSIX ships verbatim.
 */
const DATA_ROOTS = [
  'packages/extension/src',
  'packages/shared/src',
  'packages/extension/resources',
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
 * Keys that hand the model tools: the Messages API's own `tools` and
 * `tool_choice`, `mcp_servers` — the remote connector, which hands over a whole
 * tool set without ever naming one — and the Agent SDK's `allowedTools`.
 *
 * The OpenAI-shaped pair `functions`/`function_call` is deliberately NOT here:
 * Functions is a Salesforce product this extension talks about, so a key of
 * that name is ordinary domain vocabulary and the rule would fire on honest
 * code. An OpenAI-shaped tool request is a declared limit below.
 *
 * Nothing else in this extension has a use for the keys above, so one as a value
 * anywhere in shipped code counts — an object member, a class field, a property
 * assigned later — whatever finally receives the object: a request built in a
 * helper, spread from a variable or handed to a constructor is still a request.
 * A log field named `tools` counts too; rename it. A type naming them sends
 * nothing and does not count.
 */
const TOOL_REQUEST_PROPERTY = new Set(['tools', 'tool_choice', 'mcp_servers', 'allowedTools']);

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
 * Calls that build, hand over or run tools of our own: any verb from that
 * family joined to `Tool`/`Tools` — `runTools`, `wrapTool`, `buildReadOnlyTools`,
 * `createToolRegistry`, and the ones a second turn is written with,
 * `dispatchTools`, `executeTools`, `invokeTool`, `callTools`,
 * `continueWithTools`. `Toolbar` and `Tooltip` are different words: the suffix
 * has to start a new one.
 *
 * The name has to END on it. `Tools` is also a panel label in this product, so
 * a name that carries on past the word — `buildToolsPanelItems` — is interface
 * code, not a tool factory. The cost is that a factory named past the word
 * (`createToolRegistry`) is not caught here; what it builds still is, the
 * moment it reaches a request or an SDK helper.
 */
const TOOL_VERB_CALL =
  /^(?:[Rr]un|[Ww]rap|[Bb]uild|[Mm]ake|[Cc]reate|[Rr]egister|[Ww]ith|[Dd]ispatch|[Ee]xecute|[Ii]nvoke|[Cc]all|[Cc]ontinue[Ww]ith)(?:[A-Z0-9_]\w*)?Tools?$/;

/**
 * The editor's own model has a tool API, and an extension reaches it without
 * touching the Anthropic SDK: `vscode.lm.registerTool`, `vscode.lm.invokeTool`,
 * `vscode.lm.registerMcpServerDefinitionProvider`, or a class that implements
 * `LanguageModelTool`. Any member of `lm` whose name carries `tool` or `mcp`
 * counts, so a renamed import or a later sibling call is caught with them.
 */
const LANGUAGE_MODEL_NAMESPACE = 'lm';
const LANGUAGE_MODEL_MEMBER = /tool|mcp/i;
const LANGUAGE_MODEL_TOOL_TYPE = /^(?:vscode\.)?LanguageModelTool(?:[A-Z]\w*)?$/;

/**
 * Packages whose whole purpose is running tools: a second SDK from the same
 * publisher, and the MCP SDK — with which this extension would be the *server*,
 * handing an org tool set to whatever model the editor talks to. Any import of
 * either counts.
 */
const TOOL_RUNTIME_PACKAGES = ['@anthropic-ai/claude-agent-sdk', '@modelcontextprotocol/sdk'];
const isToolRuntimeSpecifier = (specifier) =>
  TOOL_RUNTIME_PACKAGES.some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`));

/**
 * The file an editor reads to attach an MCP server to its chat. Writing it
 * hands over a tool set without a single request leaving this extension, so the
 * name counts as a string wherever shipped code writes it.
 */
const MCP_CONFIG_FILE = /(?:^|[/\\])mcp\.json$/;

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

/**
 * The JSON that ships beside the code, where a tool definition can sit without
 * a single line of TypeScript. Unlike the script walk, this one enters the test
 * support directories: a test file is not shipped, but a data file in
 * `fixtures/` is read at runtime by whatever calls `readFileSync` on it.
 */
function jsonFilesUnder(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) jsonFilesUnder(full, acc);
    else if (entry.name.endsWith('.json')) acc.push(full);
  }
  return acc;
}

/** The keys an API tool definition carries beside its name. */
const TOOL_SCHEMA_KEY = new Set(['input_schema', 'inputSchema', 'parameters', 'schema']);

/**
 * A tool defined as data: an object carrying `input_schema`, or a `tools` array
 * whose entries pair a `name` with a schema. Either shape is a tool list a
 * single spread puts in a request, so the JSON counts wherever it sits under a
 * data root.
 */
function jsonToolDefinitions(value, path = '') {
  const found = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...jsonToolDefinitions(item, `${path}[${index}]`)));
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  if ('input_schema' in value) found.push(path || '(root)');
  for (const [key, child] of Object.entries(value)) {
    if (
      key === 'tools' &&
      Array.isArray(child) &&
      child.length > 0 &&
      child.every(
        (item) =>
          item &&
          typeof item === 'object' &&
          typeof item.name === 'string' &&
          Object.keys(item).some((k) => TOOL_SCHEMA_KEY.has(k)),
      )
    ) {
      found.push(path ? `${path}.tools` : 'tools');
    }
    found.push(...jsonToolDefinitions(child, path ? `${path}.${key}` : key));
  }
  return [...new Set(found)];
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
    /** Repo paths of the JSON files that ship under the data roots; none today. */
    jsonFiles: [],
  };

  for (const { root } of SHIPPED_ROOTS) {
    const files = sourceFilesUnder(join(repoRoot, root));
    scan.filesByRoot.set(root, files.map(toRepoPath));
    for (const file of files) {
      scan.read.add(file);
      scanFile(scan, file);
    }
  }

  for (const root of DATA_ROOTS) {
    for (const file of jsonFilesUnder(join(repoRoot, root))) {
      scan.jsonFiles.push(toRepoPath(file));
      let data;
      try {
        data = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      for (const at of jsonToolDefinitions(data)) {
        scan.findings.push(`${toRepoPath(file)} tool definition at ${at}`);
      }
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
    } else if (isToolRuntimeSpecifier(specifier)) {
      found(node, `import '${specifier}'`);
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
      } else if (name && LANGUAGE_MODEL_MEMBER.test(name)) {
        // The editor's model API, reached through `lm` however it was imported.
        const chain = accessChain(node.expression);
        if (chain.includes(LANGUAGE_MODEL_NAMESPACE)) found(node, `${chain.join('.')}()`);
      }
    }

    // A tool of our own, written to the editor's interface.
    if (ts.isClassLike(node)) {
      for (const clause of node.heritageClauses ?? []) {
        if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue;
        for (const type of clause.types) {
          const name = ts.isIdentifier(type.expression)
            ? type.expression.text
            : accessChain(type.expression).join('.');
          if (LANGUAGE_MODEL_TOOL_TYPE.test(name)) found(type, `implements ${name}`);
        }
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

    // The editor's tool configuration, named as a path — whole or as the tail of a template.
    const literal =
      ts.isStringLiteralLike(node) ||
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail
        ? node.text
        : null;
    if (literal !== null && MCP_CONFIG_FILE.test(literal)) found(node, `'${literal}'`);

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

  // The premise under `SHIPPED_ROOTS` — everything esbuild inlines lives under
  // those roots — holds for three workspace packages. A fourth would be inlined
  // exactly as `@sandforge/shared` is, and read by nothing here, without a
  // floor moving.
  const packagesDir = join(repoRoot, 'packages');
  const workspacePackages = readdirSync(packagesDir, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(packagesDir, entry.name, 'package.json')),
    )
    .map((entry) => JSON.parse(readFileSync(join(packagesDir, entry.name, 'package.json'), 'utf8')))
    .map((manifest) => manifest.name)
    .sort();
  assert.deepEqual(
    workspacePackages,
    WORKSPACE_PACKAGES,
    'the workspace no longer holds the three packages this scan is scoped to — a new one is ' +
      'inlined into dist/extension.js and read by nothing here; add its sources to SHIPPED_ROOTS',
  );

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
 * The English a user reads when a locale has no entry for a key: the fallback
 * argument of `t('key', 'English')`, which is where this repository keeps the
 * source string rather than in `locales/en.json`. Read off the syntax tree, so
 * the same call written in a comment is not a surface.
 */
let webviewFallbackCache;
function webviewFallbackStrings() {
  if (webviewFallbackCache) return webviewFallbackCache;
  const units = [];
  for (const file of sourceFilesUnder(join(repoRoot, 'packages', 'webview', 'src'))) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node) => {
      if (ts.isCallExpression(node) && invokedName(node.expression) === 't') {
        const [key, fallback] = node.arguments;
        if (key && fallback && ts.isStringLiteralLike(key) && ts.isStringLiteralLike(fallback)) {
          units.push({ label: `${toRepoPath(file)} t('${key.text}')`, text: fallback.text });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.ok(
    units.length >= 200,
    `the scan found ${units.length} English fallbacks in the webview, far fewer than the 300 it ` +
      'carries — it has stopped reading them, so an empty result below proves nothing',
  );
  webviewFallbackCache = units;
  return units;
}

/**
 * The same surfaces as `userFacingText()`, as a reader meets them: Markdown
 * by paragraph, with soft line breaks joined and fenced code left out; a
 * locale file by string value, never by key; and the webview's English
 * fallbacks, one string each.
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
  return [...units, ...webviewFallbackStrings()];
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
 * Number words two to twelve, in the five Latin-script locales, folded to the
 * digit: a wording mined with `10` is still that wording written `ten`, `dix`,
 * `zehn`, `diez` or `dez`. One is left alone — its translations are articles.
 */
const NUMBER_WORDS = {
  2: ['two', 'deux', 'zwei', 'dos', 'dois', 'duas'],
  3: ['three', 'trois', 'drei', 'tres', 'três'],
  4: ['four', 'quatre', 'vier', 'cuatro', 'quatro'],
  5: ['five', 'cinq', 'fünf', 'funf', 'cinco'],
  6: ['six', 'sechs', 'seis'],
  7: ['seven', 'sept', 'sieben', 'siete', 'sete'],
  8: ['eight', 'huit', 'acht', 'ocho', 'oito'],
  9: ['nine', 'neuf', 'neun', 'nueve', 'nove'],
  10: ['ten', 'dix', 'zehn', 'diez', 'dez'],
  11: ['eleven', 'onze', 'elf', 'once'],
  12: ['twelve', 'douze', 'zwölf', 'zwolf', 'doce', 'doze'],
};
const NUMBER_WORD = new Map(
  Object.entries(NUMBER_WORDS).flatMap(([digits, words]) => words.map((word) => [word, digits])),
);
const NUMBER_WORD_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(${[...NUMBER_WORD.keys()]
    .sort((a, b) => b.length - a.length)
    .join('|')})(?![\p{L}\p{N}])`,
  'gu',
);

/** The sixth locale counts with kanji, so those fold too — but only in front of a counter, where the character is a number and not a word. */
const JAPANESE_NUMERAL = {
  一: '1',
  二: '2',
  三: '3',
  四: '4',
  五: '5',
  六: '6',
  七: '7',
  八: '8',
  九: '9',
  十: '10',
  十一: '11',
  十二: '12',
};
const JAPANESE_NUMERAL_PATTERN = /(十[一二]|[一二三四五六七八九十])(?=個|つ|種類|件)/gu;

/** Width-less characters a copy-paste leaves behind, mid-word and invisible. */
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;

/** The entities a writer reaches for instead of the character: a space that will not break, and the dashes. */
const SPACE_ENTITY =
  /&(?:nbsp|ensp|emsp|thinsp|#0*160|#0*8194|#0*8195|#0*8201|#0*8239|#[xX]0*a0);/gi;
const DASH_ENTITY = /&(?:ndash|mdash|shy|#0*8211|#0*8212|#0*8209|#0*173);/gi;

/** What an i18n string writes where a number goes; it reads as the number it will hold. */
const INTERPOLATION = /\{\{[^{}]*\}\}|\$\{[^{}]*\}|\{[^{}\s]*\}|%[sd]/g;

/**
 * Markup that ends a line or a block. What follows starts a new run of text,
 * the way a new table cell or a new list item does; inline tags are typography
 * and fold to a space, so `read-<b>only</b>` still reads as `read only`.
 */
const BLOCK_TAG =
  /<\/?(?:br|hr|p|div|li|ul|ol|tr|td|th|table|thead|tbody|section|h[1-6]|blockquote)\b[^>]*>/gi;

/** Where one run of text ends and the next begins. No mined wording spans one. */
const BREAK = '\n';

/**
 * Prose, and a mined wording, reduced to the words a reader meets. Both sides
 * go through this, so the comparison is about words and not about typography:
 * compatibility forms folded (NFKC), zero-width characters and Markdown link
 * targets dropped, space and dash entities resolved, an interpolated count read
 * as a count, emphasis and code ticks dropped with no space, quotes and
 * parentheses spaced, soft separators (comma, colon, semicolon, arrow) spaced,
 * every Unicode dash — the non-breaking hyphen included — folded to a hyphen
 * and then to a space, number words folded to digits, lower case. So
 * `read-*only*`, `read‑only`, `read&nbsp;only`, `read only`, `ten`,
 * `{{count}}`, `１０`, and `read-only` with a zero-width space pasted into it,
 * all read alike.
 *
 * Structure, on the other hand, separates: a sentence end, a table bar, a link
 * label's brackets and a line-breaking tag each start a new run of text, and a
 * wording is only ever matched inside one run. Two neighbouring cells, two
 * link labels in a list, a label and the value after its colon: none of them
 * can be glued into a phrase no reader ever sees.
 */
const normalizeProse = (text) =>
  text
    .normalize('NFKC')
    .replace(ZERO_WIDTH, '')
    .replace(SPACE_ENTITY, ' ')
    .replace(DASH_ENTITY, '-')
    .replace(INTERPOLATION, '0')
    .replace(/\s+/g, ' ')
    .replace(/\]\([^)]*\)/g, ']')
    .replace(BLOCK_TAG, BREAK)
    .replace(/<[^>]*>/g, ' ')
    .replace(/[*_`~]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/["«»“”„(){}]/g, ' ')
    .replace(/[[\]|]|[.!?…。！？]+/g, BREAK)
    .replace(/[,;:、，]|→|⇒|->/g, ' ')
    .replace(/[\p{Pd}­]/gu, '-')
    .replace(/-/g, ' ')
    .toLowerCase()
    .replace(NUMBER_WORD_PATTERN, (word) => NUMBER_WORD.get(word))
    .replace(JAPANESE_NUMERAL_PATTERN, (numeral) => JAPANESE_NUMERAL[numeral])
    .split(BREAK)
    .map((run) => run.replace(/\s+/g, ' ').trim())
    .filter((run) => run !== '')
    .join(BREAK);

/**
 * The wording that sold the tools, or the diagnosis they served, on a surface a
 * user reads. Mined from every revision of both READMEs, `docs/`, the manifest,
 * `package.nls*.json`, the walkthrough pages and the six locale files that this
 * repository has ever held, in the six languages.
 *
 * The five other languages returned nothing: every locale string that carries a
 * tools noun is a side-panel label, an onboarding tagline or a GDPR line, and
 * none of them was ever about the assistant. So the list below is English, and
 * it is the whole of it.
 *
 * This is not a guess at what a promise looks like — an earlier cut tried that
 * and flagged the honest removal note, the competitor comparison and a true
 * sentence about Monitor and Compare. It is the text that shipped. A wording
 * comes off this list only when the anchor above says the feature is back, or
 * — for the wordings that never named the tools — when it is rewritten.
 *
 * Each one is mined whole, as the cell or the bullet carried it. A fragment is
 * not: `read-only tool surface` alone is what any module with no write access
 * has, in English and in the four languages that borrow the term, and
 * `10 fine-grained read-only tools` is a sentence about Compare's drift checks
 * as easily as one about the assistant.
 */
const PUBLISHED_CLAIMS = [
  {
    // `| **AI Assistant** | … |`, the feature table of README.md from f25de974
    // (2026-08-06) and of packages/extension/README.md from 73a8da80 (v1.7.0,
    // 2026-08-11), in both until 8110fd25 (2026-09-11) removed the flow.
    // NL2SOQL, the other half of the cell, works and stays out of the wording.
    text: 'failed-job diagnosis over 10 read-only tools',
    where: 'the AI Assistant row of the feature table, both READMEs, v1.7.0 to v1.21',
  },
  {
    // The bullet the table replaced: packages/extension/README.md, f25de974
    // (2026-08-06) to 73a8da80, with and without the parenthesis that followed.
    text: 'failed-job diagnosis, read-only by design',
    where: 'the AI assistant bullet, packages/extension/README.md, 2026-08-06 to v1.7.0',
  },
  {
    // README.md "Read-only by design" bullet, 885842ee (v1.2.6, 2026-05-05) to
    // f25de974. The ten tool names it went on to list are left to the anchor:
    // listing them again means the tools exist again, and that trips first.
    text: '**Read-only by design** — 10 fine-grained read-only tools',
    where: 'the "Read-only by design" bullet, README.md, v1.2.6 to 2026-08-06',
  },
  {
    // README.md release highlights, same span, with the parenthesis that made
    // it a claim about the assistant rather than a property of a module.
    text: '**Read-only tool surface** (10 tools, registry CI fence, `DML_FORBIDDEN` at 2 layers)',
    where: 'the release highlights, README.md, v1.2.6 to 2026-08-06',
  },
  {
    // README.md AI section, same span. A diagnose flow built again — without
    // tools, so the anchor stays green — is described in new words; this
    // sentence stays refused because it promises the screen that never shipped.
    text: '**Failed-job diagnose flow** — Right-click a failed bulk job in Monitor → "Diagnose with AI"',
    where: 'the AI section, README.md, v1.2.6 to 2026-08-06',
  },
  {
    // The same flow in the release highlights, named after the handler that was
    // deleted with it: the arrow reads as a space.
    text: '**Failed-job → diagnose flow** with `AIDiagnoseHandler` + `ActionCard`',
    where: 'the release highlights, README.md, v1.2.6 to 2026-08-06',
  },
  {
    // The half of the diagnose bullet that promised execution, not an answer.
    text: 'Read-only suggested actions auto-execute silently',
    where: 'the "Failed-job diagnose flow" bullet, README.md, v1.2.6 to 2026-08-06',
  },
].map((claim) => {
  const needle = normalizeProse(claim.text);
  return { ...claim, needle, pattern: claimPattern(needle) };
});

/**
 * A mined wording as a pattern: the words as they were published, on word
 * boundaries, with the count left free. Rewriting `10` as `12` — or as the
 * `{{count}}` a locale interpolates, which normalises to a number — is editing
 * the sentence that shipped, not writing a new one.
 */
function claimPattern(needle) {
  const body = needle
    .split(/(\d+)/)
    .map((part, index) =>
      index % 2 === 1 ? String.raw`\d+` : part.replace(/[\\^$.*+?()[\]{}|]/g, String.raw`\$&`),
    )
    .join('');
  return new RegExp(String.raw`(?<![\p{L}\p{N}])${body}(?![\p{L}\p{N}])`, 'u');
}

/**
 * The mined wordings a text republishes. A wording has to be there whole, on
 * word boundaries and inside one run of text: wrapping it in a sentence does
 * not excuse it, so a prefix or a suffix — including one that disowns it —
 * still counts. Rewrite the sentence, or put the quote in a changelog, which is
 * not a surface.
 */
function republishedClaims(text) {
  const runs = normalizeProse(text).split(BREAK);
  return PUBLISHED_CLAIMS.filter((claim) => runs.some((run) => claim.pattern.test(run)));
}

test('the mined wordings are matched whole, and honest prose is left alone', () => {
  // A wording short enough to be written by accident makes the gate noise: the
  // 22-character `read-only tool surface` refused five true sentences, one of
  // them in a language that borrows the English term. A mined wording carries a
  // whole claim, so the floor sits under the shortest one that does.
  const short = PUBLISHED_CLAIMS.filter((claim) => claim.needle.length < 30);
  assert.deepEqual(
    short.map((claim) => claim.text),
    [],
    'these mined wordings are too short to be refused on their own: mine the sentence that ' +
      'carried them, or leave the claim to the anchor above',
  );

  // Each wording as published, then the shapes a reappearance takes: a table
  // row, a paragraph wrapped mid-phrase, emphasis inside a word, a
  // non-breaking hyphen, a space written as an entity, an invisible character
  // pasted mid-word, the count spelled out in another language, interpolated by
  // i18n or brought up to date, and the wording carried by a longer sentence.
  const republished = [
    ...PUBLISHED_CLAIMS.map((claim) => claim.text),
    '| **AI Assistant**   | NL2SOQL and failed-job diagnosis over 10 read-only tools |',
    'NL2SOQL and failed-job\ndiagnosis over 10 read-only tools, with your own key.',
    'NL2SOQL and failed-*job* diagnosis over `10` read-only tools',
    'NL2SOQL and failed‑job diagnosis over 10 read‑only tools',
    'NL2SOQL and failed-job diagnosis over 10&nbsp;read-only tools',
    'NL2SOQL and failed-job diagnosis over 10 read\u200B-only tools', // a zero-width space, pasted from a mock-up
    'failed job diagnosis over ten read only tools',
    'failed-job diagnosis over {{count}} read-only tools',
    'failed-job diagnosis over 12 read-only tools',
    'Diagnose fehlgeschlagener Jobs: failed-job diagnosis over zehn read-only tools',
    'The assistant now offers failed-job diagnosis over 10 read-only tools again.',
    // A quotation of a withdrawn wording republishes it on a page a user reads,
    // whether it is struck through, in a removal note or in an answer about an
    // old version. All three are refused like the promise, on purpose: the
    // alternative is a negation rule per language, which is the guessing this
    // gate dropped. Quote it in a changelog, which is not a surface.
    'Version 1.20 removed failed-job diagnosis over ten read-only tools from the AI Assistant.',
    '~~Failed-job diagnosis over 10 read-only tools~~ — withdrawn in 1.20.',
    'The v1.2.6 README promised "**Read-only by design** — 10 fine-grained read-only tools". It was never true.',
    '- **AI assistant**: NL2SOQL and failed-job diagnosis, read-only by design.',
    '- **Read-only by design** — 10 fine-grained read-only tools (`describe_object`, `query_records`).',
    '- **Read-only tool surface** (10 tools, registry CI fence, `DML_FORBIDDEN` at 2 layers)',
    '- **Failed-job diagnose flow** — Right-click a failed bulk job in Monitor → "Diagnose with AI" surfaces an ActionCard.',
    '- **Failed-job → diagnose flow** with `AIDiagnoseHandler` + `ActionCard` (Approve / Modify / Reject)',
    'Read-only suggested actions auto-execute silently; org-mutating ones gate behind Approve.',
  ];
  assert.deepEqual(
    republished.filter((text) => republishedClaims(text).length === 0),
    [],
    'these republish wording that was withdrawn, and the rules let them through',
  );

  // Prose an honest page could hold, with the same words in it. The removal
  // notes, the competitor comparison and the Monitor/Compare sentences are the
  // ones an earlier, guessing cut of this gate flagged, in the six languages.
  // The block after them is what a cut that mined fragments flagged next: true
  // sentences about modules that have no write access, a capability matrix, a
  // settings line, an index of archived links, and a diagnose flow rebuilt
  // without tools and described in its own words.
  const honest = [
    'Read-only mode prevents writes to production',
    'Read-only orgs hide the write tools',
    'Diagnose why an operation failed from the log panel',
    'In a production org, only read-only tools stay enabled.',
    'Monitor and Compare are two read-only tools: they never write to an org.',
    'Monitor and Compare are two read-only tools for inspecting a failed Sync run.',
    'Diagnostics: Monitor and Compare are two read-only tools for inspecting a failed Sync run.',
    'Read-only tools in the toolbar stay available while the AI Assistant is off.',
    'The diagnostics panel shows why the last Sync run failed.',
    'While AI is on, every failed Seed run sends its error message to the model for a fix suggestion.',
    'The AI Assistant does not use read-only tools or diagnose failed jobs.',
    'Can the AI Assistant diagnose failed jobs with read-only tools?',
    'Unlike SFDMU, SandForge does not ship an agent with ten read-only org tools.',
    'The assistant can explain a failed job, but it has no read-only tools.',
    'Version 1.20 removed the tool-based diagnosis from the AI Assistant.',
    'Tools',
    "Diagnostiquer une erreur de connexion à l'org",
    "Le mode lecture seule masque les outils d'écriture.",
    'En production, seuls les outils en lecture seule restent actifs.',
    'Le panneau de diagnostic affiche la dernière exécution en échec.',
    'Monitor et Compare sont deux outils en lecture seule pour analyser une exécution en échec.',
    "L'assistant IA ne propose plus le diagnostic des jobs en échec par dix outils en lecture seule.",
    'Im schreibgeschützten Modus sind die Schreibwerkzeuge ausgeblendet.',
    'Im Schutzmodus bleiben nur zwei Werkzeuge ohne Schreibzugriff aktiv.',
    'Der KI-Assistent erklärt Fehler, führt aber keine Werkzeuge aus.',
    'Der KI-Assistent führt zehn schreibgeschützte Werkzeuge nicht mehr aus.',
    'Die Diagnose fehlgeschlagener Jobs über zehn schreibgeschützte Werkzeuge wurde in Version 1.20 entfernt.',
    'El modo de solo lectura oculta las herramientas de escritura.',
    'Herramientas de consulta SOQL',
    'En producción solo quedan activas las herramientas de solo lectura.',
    'El asistente de IA ya no ejecuta diez herramientas de solo lectura.',
    'El diagnóstico de trabajos fallidos con diez herramientas de solo lectura se eliminó en la versión 1.20.',
    'O modo somente leitura oculta as ferramentas de escrita.',
    'O painel de diagnóstico mostra a última execução com falha.',
    'O diagnóstico de jobs com falha usando dez ferramentas somente leitura foi removido na versão 1.20.',
    '読み取り専用モードでは書き込みツールが非表示になります',
    '診断パネルに失敗したジョブの一覧が表示されます',
    'AIアシスタントの読み取り専用ツールによる診断は廃止されました',
    'In a production org SandForge keeps a read-only tool surface: Compare inspects the schema, Monitor reads job state, and neither writes a record.',
    '**Read-only tool surface** — the set of operations a module may run without write access. Compare and Monitor never leave it.',
    'Unlike SFDMU, SandForge ships no agent at all: its read-only tool surface is limited to what Compare and Monitor read for you.',
    'Le mode read-only tool surface de Compare est le seul que la production autorise.',
    'Compare und Monitor bilden eine Read-only-Tool-Surface: Sie schreiben nie in die Org.',
    'Compare y Monitor mantienen una read-only tool surface: nunca escriben en la org.',
    'Compare と Monitor は read-only tool surface (読み取り専用) の範囲でのみ動作します。',
    '| Read-only suggested actions | Auto-execute | Never — you apply them yourself |',
    'Read-only suggested actions: auto-execute is off, and there is no setting that turns it on.',
    'See also: [Failed-job diagnosis](archive/diagnose.md), [read-only by design](archive/read-only.md) — both pages describe versions before 1.20.',
    "Compare's drift detection runs 10 fine-grained read-only tools of its own. None of them is an AI feature, and none needs a key.",
    '- **Failed-job diagnose flow** — right-click a failed bulk job in Monitor and the assistant explains the error in prose.',
  ];
  assert.deepEqual(
    honest.filter((text) => republishedClaims(text).length > 0),
    [],
    'the mined wordings flag these honest sentences',
  );

  // The limit, pinned so it cannot drift into a claim this gate does not make:
  // prose refuses what was published, not what it means. Every line here is a
  // promise the extension cannot keep, and every line here passes. The anchor
  // above is what stops the tools themselves coming back, and it fails in both
  // directions — build them and it trips first, then this list is stale. The
  // last four are the near misses: a word inflected, and a wording split over
  // two locale keys that a component renders side by side.
  const paraphrasesThatPass = [
    'Chat, NL2SOQL, and read-only Salesforce tools that answer questions about your org',
    'The AI Assistant diagnoses failed jobs with ten read-only org tools.',
    'The assistant answers your questions with ten read-only sandbox tools.',
    'Ten read-only actions: it looks up records and explains why a job failed',
    'The AI Assistant queries your org with {{count}} read-only tools.',
    "L'assistant IA interroge votre org avec dix outils de consultation.",
    'Zehn schreibgeschützte KI-Werkzeuge beantworten Fragen zu Ihrer Org.',
    'El asistente de IA responde con diez herramientas de consulta.',
    'O assistente de IA consulta sua org com dez ferramentas de leitura.',
    'AIアシスタントが参照専用ツールでお答えします',
    'NL2SOQL and failed-job diagnostics over 10 read-only tools',
    '- **Read-only tool surfaces** (10 tools, registry CI fence, `DML_FORBIDDEN` at 2 layers)',
    'NL2SOQL and failed-job diagnosis over',
    '10 read-only tools',
  ];
  assert.deepEqual(
    paraphrasesThatPass.filter((text) => republishedClaims(text).length > 0),
    [],
    'a paraphrase is now being refused — the rules have started guessing again, which is what ' +
      'this gate was rewritten to stop; re-read the limits in the header',
  );
});

test('no user-facing surface republishes the withdrawn AI wording', () => {
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
    for (const claim of republishedClaims(text)) {
      offenders.push(`${label}: "${claim.text}" — published in ${claim.where}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'these surfaces put back wording the product withdrew. Rewrite the sentence; a note about ' +
      'the removal belongs in a changelog, which this gate does not read:\n  ' +
      offenders.join('\n  '),
  );
});
