import { describe, it, expect } from 'vitest';
import ts from 'typescript';

// The shared package has no @types/node dependency — declare the Node
// builtins this structural test needs (vitest provides them at runtime).
declare const __dirname: string;
declare function require(id: string): unknown;

const { readFileSync, readdirSync, statSync } = require('node:fs') as {
  readFileSync(path: string, encoding: 'utf8'): string;
  readdirSync(path: string): string[];
  statSync(path: string): { isDirectory(): boolean };
};
const { join } = require('node:path') as { join(...parts: string[]): string };

/**
 * Emission-side anti-drift test — the missing half of coverage.test.ts.
 *
 * coverage.test.ts guarantees the bijection *declared TS interfaces* ↔
 * *Zod msg() literals*. Nothing checked the *emission* side: channels the
 * extension actually posts to the webview. This test scans
 * `packages/extension/src/**` and extracts every channel literal emitted via
 * the four emission idioms, then requires each one to be declared in shared
 * (Zod msg() member AND TS interface — the reverse bijection is coverage's
 * job, so a literal declared on both sides cannot drift undetected).
 *
 * Extraction idioms (all positional, all with literal channel arguments):
 *   1. `buildResponse(deps, msg, '<channel>', payload)`        — 3rd arg
 *   2. `sendHandlerError(deps, '<context>', '<channel>', origin, err)` — 3rd arg
 *   3. `validatePayload(schema, msg, '<channel>', deps)`       — 3rd arg
 *      (plus `parsePayload`, ForgeHandler's one-line alias of it)
 *   4. `broker.postToWebview({ ... type: '<channel>' ... })` and
 *      `panelManager.postToAllPanels({ ... type: '<channel>' ... })`
 *
 * Every regex in this file runs on {@link stripComments} output, never on the
 * raw file: a commented-out call is not an emission and a commented-out
 * `msg()` is not a declaration. The checks that look for *code* (an injection,
 * a construction, a driver call) do not use regexes at all — they walk the
 * TypeScript AST, where comments and strings cannot pass for code.
 *
 * Deliberate exclusions:
 *   - `*.test.ts` files (they emit fixture literals like 'a:error').
 *   - The 5 raw `sidebar:*` channels: they bypass the MessageBroker entirely
 *     (SidebarViewProvider posts straight to the sidebar webview) and are a
 *     separate, intentional contract — do NOT declare them here.
 *   - NoOpHandler / WebviewStateSync / sendOperation* / sendNotification emit
 *     computed or fixed types that are already declared; non-literal call
 *     sites simply match nothing.
 *
 * Emitted-but-unconsumed channels (kept declared, documented per audit):
 *   - `forge:discover:progress` — emitted (throttled) during discovery, but no
 *     webview listener exists (the wizard consumes only
 *     `forge:discover:response` / `:error`).
 *   - `forge:progress` — the shape mismatch (event wrapped under `payload` by
 *     buildResponse, read at the message top level by ForgeExecution.tsx) was
 *     reconciled in 1.8.0: the webview now reads under `payload`.
 *
 * Removed in 1.9.0: the `monitor:trends` / `monitor:trends:data` pair — the
 * webview never sent the request (handler unreachable) and trend data already
 * rides `monitor:data`.
 */

/** A source file: its path relative to the scanned root, and its text. */
interface SourceFile {
  file: string;
  src: string;
}

/** Matches `export interface Foo extends BaseMessage { type: 'x:y';` declarations. */
const MESSAGE_IFACE_RE = /export interface (\w+) extends BaseMessage \{\s*type: '([^']+)'/g;

/** Matches `msg('x:y')` member declarations in bridge/messageSchemas.ts. */
const ZOD_MSG_RE = /msg\('([^']+)'\)/g;

/**
 * Emission patterns, in the order documented above. Each captures the channel
 * literal in group 1.
 */
const EMISSION_PATTERNS: ReadonlyArray<RegExp> = [
  /\bbuildResponse\s*\(\s*[\w.]+,\s*[\w.]+,\s*'([^']+)'/g,
  /\bsendHandlerError\s*\(\s*[\w.]+,\s*'[^']+',\s*'([^']+)'/g,
  /\bvalidatePayload\s*\(\s*[\w.]+,\s*[\w.]+,\s*'([^']+)'/g,
  /\bparsePayload\s*\(\s*[\w.]+,\s*[\w.]+,\s*'([^']+)'/g,
  // Loose fallback for validatePayload/parsePayload call sites whose message
  // argument is an expression rather than an identifier (e.g.
  // `validatePayload(schema, { ...msg, payload } as BaseMessage, 'x:error',
  // this.deps)` in SyncOpsHandler): the channel literal is always the argument
  // immediately before `deps`. Today it captures nothing the primary patterns
  // miss — it exists so future expression-arg call sites cannot slip through.
  /\b(?:validatePayload|parsePayload)\s*\([\s\S]{0,400}?'([^']+)'\s*,\s*(?:this\.)?deps[\s,)]/g,
  /\bpostTo(?:Webview|AllPanels)\s*\(\s*\{[^}]*?type:\s*'([^']+)'/g,
  // 5. emission through an optional injected callback —
  //    `this.deps.onGrappeEvent?.({ type: 'x:y'`. See CALLBACK_EMISSION_RE.
  /\bthis\.deps\.\w+\?\.\(\s*\{\s*type:\s*'([^']+)'/g,
];

/**
 * Same emission as idiom 5, but capturing the callback name (group 1) as well
 * as the channel (group 2).
 *
 * Declaring the channel is not enough when nothing ever *assigns* the
 * callback. The three `grappe:*` channels shipped exactly that way: declared
 * on both sides, emitted from three orchestrators, and injected by none of
 * their construction sites — so BridgeProvider's listeners and the whole
 * Grappe page were fed by no one, invisibly to every other guard in this file.
 */
const CALLBACK_EMISSION_RE = /\bthis\.deps\.(\w+)\?\.\(\s*\{\s*type:\s*'([^']+)'/g;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** types/messages -> types -> src -> shared -> packages, then extension/src. */
const EXTENSION_SRC = join(__dirname, '..', '..', '..', '..', 'extension', 'src');

let extensionFilesCache: SourceFile[] | undefined;

/** Extension production sources, paths relative to extension/src, read once. */
function extensionFiles(): SourceFile[] {
  extensionFilesCache ??= walk(EXTENSION_SRC).map((abs) => ({
    file: abs.slice(EXTENSION_SRC.length + 1).replace(/\\/g, '/'),
    src: readFileSync(abs, 'utf8'),
  }));
  return extensionFilesCache;
}

const parsedCache = new WeakMap<SourceFile, ts.SourceFile>();

/** The TypeScript AST of `f`, parent pointers set. */
function parse(f: SourceFile): ts.SourceFile {
  let sf = parsedCache.get(f);
  if (!sf) {
    sf = ts.createSourceFile(f.file, f.src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    parsedCache.set(f, sf);
  }
  return sf;
}

/** Every node under `root` (itself included), depth-first. */
function descendants(root: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    out.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return out;
}

/** Literal kinds whose text may legitimately contain `//` or `/*`. */
const LITERAL_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.RegularExpressionLiteral,
]);

const strippedCache = new WeakMap<SourceFile, string>();

/**
 * `f.src` with every comment blanked to spaces — same length, newlines kept,
 * so offsets still line up with the AST. Literal ranges come from the parser,
 * so a `//` or `/*` inside a string, template or regex literal is left alone.
 */
function stripComments(f: SourceFile): string {
  const cached = strippedCache.get(f);
  if (cached !== undefined) return cached;

  const sf = parse(f);
  const literals = descendants(sf)
    .filter((node) => LITERAL_KINDS.has(node.kind))
    .map((node): [number, number] => [node.getStart(sf), node.getEnd()])
    .sort((a, b) => a[0] - b[0]);

  const { src } = f;
  const out = src.split('');
  let next = 0;
  for (let i = 0; i < src.length; ) {
    while (next < literals.length && literals[next][1] <= i) next++;
    if (next < literals.length && literals[next][0] <= i) {
      i = literals[next][1];
      continue;
    }
    if (src[i] === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      const block = src[i + 1] === '*';
      const close = block ? src.indexOf('*/', i + 2) : src.indexOf('\n', i);
      const end = close === -1 ? src.length : block ? close + 2 : close;
      for (let j = i; j < end; j++) if (src[j] !== '\n' && src[j] !== '\r') out[j] = ' ';
      i = end;
      continue;
    }
    i++;
  }
  const stripped = out.join('');
  strippedCache.set(f, stripped);
  return stripped;
}

/** Channel literal -> files emitting it. */
function extractEmittedChannels(files: readonly SourceFile[]): Map<string, string[]> {
  const emitted = new Map<string, string[]>();
  for (const f of files) {
    const code = stripComments(f);
    for (const re of EMISSION_PATTERNS) {
      for (const m of code.matchAll(re)) {
        const origins = emitted.get(m[1]) ?? [];
        origins.push(f.file);
        emitted.set(m[1], origins);
      }
    }
  }
  return emitted;
}

function readEmittedChannels(): Map<string, string[]> {
  return extractEmittedChannels(extensionFiles());
}

function zodLiteralsOf(schema: SourceFile): Set<string> {
  return new Set([...stripComments(schema).matchAll(ZOD_MSG_RE)].map((m) => m[1]));
}

function tsLiteralsOf(files: readonly SourceFile[]): Set<string> {
  const literals = new Set<string>();
  for (const f of files) {
    for (const m of stripComments(f).matchAll(MESSAGE_IFACE_RE)) literals.add(m[2]);
  }
  return literals;
}

function readZodLiterals(): Set<string> {
  // types/messages -> types -> src, then bridge/messageSchemas.ts
  const path = join(__dirname, '..', '..', 'bridge', 'messageSchemas.ts');
  return zodLiteralsOf({ file: 'bridge/messageSchemas.ts', src: readFileSync(path, 'utf8') });
}

function readTsLiterals(): Set<string> {
  return tsLiteralsOf(
    readdirSync(__dirname)
      .filter((file) => file.endsWith('.messages.ts'))
      .map((file) => ({ file, src: readFileSync(join(__dirname, file), 'utf8') })),
  );
}

/** Strips `( … )`, `as T`, `<T>…`, `!` and `satisfies T` around an expression. */
function unwrap(e: ts.Expression): ts.Expression {
  let u = e;
  while (
    ts.isParenthesizedExpression(u) ||
    ts.isAsExpression(u) ||
    ts.isTypeAssertionExpression(u) ||
    ts.isNonNullExpression(u) ||
    ts.isSatisfiesExpression(u)
  ) {
    u = u.expression;
  }
  return u;
}

/** Text of an identifier, private identifier or string-literal name. */
function nameText(name: ts.Node | undefined): string | undefined {
  return name && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name))
    ? name.text
    : undefined;
}

/** Values that cannot be a callback: `undefined`, `null`, `void …`, literals. */
function isNeverACallback(e: ts.Expression): boolean {
  const u = unwrap(e);
  if (ts.isIdentifier(u)) return u.text === 'undefined';
  return (
    u.kind === ts.SyntaxKind.NullKeyword ||
    u.kind === ts.SyntaxKind.TrueKeyword ||
    u.kind === ts.SyntaxKind.FalseKeyword ||
    ts.isVoidExpression(u) ||
    ts.isLiteralExpression(u) ||
    ts.isTemplateExpression(u) ||
    ts.isObjectLiteralExpression(u) ||
    ts.isArrayLiteralExpression(u)
  );
}

/** Callback name -> channels emitted through `this.deps.<name>?.({ type })`. */
function callbackEmissions(files: readonly SourceFile[]): Map<string, Set<string>> {
  const byCallback = new Map<string, Set<string>>();
  for (const f of files) {
    for (const m of stripComments(f).matchAll(CALLBACK_EMISSION_RE)) {
      const channels = byCallback.get(m[1]) ?? new Set<string>();
      channels.add(m[2]);
      byCallback.set(m[1], channels);
    }
  }
  return byCallback;
}

/**
 * One finding per callback emitted through but assigned nowhere. An injection
 * is a `name: <value>` property assignment inside an object literal, read from
 * the AST — so a comment, a string, a type member (`name: (e: E) => void`) or
 * an explicit `undefined` / `null` does not count.
 */
function orphanedCallbacks(files: readonly SourceFile[]): string[] {
  const assigned = new Set<string>();
  for (const f of files) {
    for (const node of descendants(parse(f))) {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isObjectLiteralExpression(node.parent) &&
        !isNeverACallback(node.initializer)
      ) {
        const name = nameText(node.name);
        if (name) assigned.add(name);
      }
    }
  }
  const orphaned: string[] = [];
  for (const [callback, channels] of callbackEmissions(files)) {
    if (!assigned.has(callback)) {
      orphaned.push(`${callback} (never injected; would silence ${[...channels].join(', ')})`);
    }
  }
  return orphaned;
}

describe('emitted channels (emission-side anti-drift)', () => {
  it('extracts a non-trivial number of emitted channels (regex sanity guard)', () => {
    // 178 literals at introduction. If the emission helpers are renamed or
    // the idioms change, this fails loudly instead of silently passing with
    // an empty extraction set.
    expect(readEmittedChannels().size).toBeGreaterThanOrEqual(150);
  });

  it('every emitted channel has a Zod msg() member in messageSchemas.ts', () => {
    const zodLiterals = readZodLiterals();
    const missing = [...readEmittedChannels().keys()].filter((l) => !zodLiterals.has(l));
    expect(missing).toEqual([]);
  });

  it('every channel emitted through an optional callback has that callback injected', () => {
    const files = extensionFiles();
    // Sanity: the extraction must find the grappe trio, not pass vacuously.
    expect([...callbackEmissions(files).keys()]).toContain('onGrappeEvent');
    expect(orphanedCallbacks(files)).toEqual([]);
  });

  it('every emitted channel has a TS message interface in a domain file', () => {
    const tsLiterals = readTsLiterals();
    const missing: string[] = [];
    for (const [literal, origins] of readEmittedChannels()) {
      if (!tsLiterals.has(literal)) missing.push(`'${literal}' emitted from ${origins[0]}`);
    }
    expect(missing).toEqual([]);
  });
});

describe('source reading: a mention is not code', () => {
  it('a commented-out emission is not extracted as emitted', () => {
    const files: SourceFile[] = [
      {
        file: 'bridge/GhostHandler.ts',
        src: [
          "// buildResponse(this.deps, msg, 'ghost:line', payload);",
          "/* this.deps.broker.postToWebview({ type: 'ghost:block' }); */",
          "buildResponse(this.deps, msg, 'live:response', payload);",
          '',
        ].join('\n'),
      },
    ];
    expect([...extractEmittedChannels(files).keys()]).toEqual(['live:response']);
  });

  it('a commented-out msg() member declares nothing', () => {
    const schema: SourceFile = {
      file: 'bridge/messageSchemas.ts',
      src: [
        'const Messages = [',
        "  msg('live:channel'),",
        "  // msg('ghost:channel'),",
        '];',
        '',
      ].join('\n'),
    };
    expect([...zodLiteralsOf(schema)]).toEqual(['live:channel']);
  });

  it('a commented-out message interface declares nothing', () => {
    const domain: SourceFile = {
      file: 'ghost.messages.ts',
      src: [
        '/*',
        'export interface GhostMessage extends BaseMessage {',
        "  type: 'ghost:channel';",
        '}',
        '*/',
        'export interface LiveMessage extends BaseMessage {',
        "  type: 'live:channel';",
        '}',
        '',
      ].join('\n'),
    };
    expect([...tsLiteralsOf([domain])]).toEqual(['live:channel']);
  });

  it('comment markers inside string, template and regex literals are not comments', () => {
    const files: SourceFile[] = [
      {
        file: 'bridge/LiteralHandler.ts',
        src: [
          "const url = 'https://example.org'; buildResponse(this.deps, msg, 'live:string', url);",
          "const tpl = `a // b ${url}`; buildResponse(this.deps, msg, 'live:template', tpl);",
          "const re = /\\/\\/[']/; buildResponse(this.deps, msg, 'live:regex', re);",
          "const open = '/*'; buildResponse(this.deps, msg, 'live:block', open); const close = '*/';",
          '',
        ].join('\n'),
      },
    ];
    expect([...extractEmittedChannels(files).keys()].sort()).toEqual([
      'live:block',
      'live:regex',
      'live:string',
      'live:template',
    ]);
  });
});

describe('optional callbacks: an injection is an assignment in code', () => {
  const EMITTER: SourceFile = {
    file: 'modules/fixture/FixtureOrchestrator.ts',
    src: [
      'export class FixtureOrchestrator {',
      '  run(): void {',
      "    this.deps.onFixtureEvent?.({ type: 'fixture:event' });",
      '  }',
      '}',
      '',
    ].join('\n'),
  };

  function composition(line: string): SourceFile {
    return {
      file: 'composition/fixtureComposition.ts',
      src: ['export function wire(): void {', `  ${line}`, '}', ''].join('\n'),
    };
  }

  it.each([
    ['a comment', '// new FixtureOrchestrator({ onFixtureEvent: (e) => post(e) });'],
    ['a string', "log('pass onFixtureEvent: (e) => post(e) once wired');"],
    ['a required property signature', 'interface Deps { onFixtureEvent: (e: unknown) => void }'],
    ['an explicit undefined', 'new FixtureOrchestrator({ onFixtureEvent: undefined });'],
    ['an explicit null', 'new FixtureOrchestrator({ onFixtureEvent: null });'],
  ])('reports a callback whose only "injection" is %s', (_label, line) => {
    const orphaned = orphanedCallbacks([EMITTER, composition(line)]);
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0]).toContain('onFixtureEvent');
  });

  it('accepts a callback assigned a function in code', () => {
    const line = 'new FixtureOrchestrator({ onFixtureEvent: (e) => post(e) });';
    expect(orphanedCallbacks([EMITTER, composition(line)])).toEqual([]);
  });
});

/**
 * Construction is not emission — the call is.
 *
 * `BulkJobProgressTracker` was constructed in SeedOpsHandler and
 * SyncOpsHandler, subscribed to with `onProgress`, and torn down in their
 * `finally` blocks. `startTracking()` — the only method that starts the poll
 * loop, and therefore the only thing that can fire that callback — had no
 * production caller. Every guard above read the `type: 'execution:progress'`
 * literal sitting inside the callback body and certified the channel as
 * emitted; nothing ever posted it, for any user, on any run.
 *
 * This guard reads the AST, never the text. For every subscription
 * `x.on<Event>(cb)` whose callback emits a channel — a `type: '<channel>'`
 * property or one of the idioms above, with `cb` written inline, passed as
 * `this.method` (optionally `.bind(this)`) or a function declared in scope,
 * following the in-file helpers it calls (`this.method(…)`, a function in
 * scope) transitively:
 *   1. `x` must be a local or a `this.field` bound to `new C(…)` in the same
 *      binding scope — typed (`const x: C = new C()`), union-typed and split
 *      (`let x: C | undefined; … x = new C()`) declarations alike;
 *   2. `C` must be declared exactly once in extension/src;
 *   3. a *driver* of `C` must be called on that same `x`, inside that scope
 *      but outside the callback itself (a call that only runs once the emitter
 *      already fires starts nothing). Drivers are `C`'s public instance
 *      methods (generic ones included) that are neither `on<Event>` nor a
 *      teardown (stop / dispose / clear / …).
 * A class with no driver is a finding, not a skip. A subscription failing 1 or
 * 2 is not skipped either: it is reported as unverifiable, and each one must be
 * listed in UNVERIFIABLE_SUBSCRIPTIONS with the reason it is acceptable.
 *
 * What it does not prove: that the driver called is the one that reaches the
 * callback (any driver counts), that the call ever executes (one inside a
 * closure nobody invokes still counts), or that an instance handed to another
 * file is driven there — such an instance is reported dead; call a driver in
 * scope.
 */

/** A subscribe method: `onProgress`, `onDidChange`, … */
const SUBSCRIBE_NAME_RE = /^on[A-Z]/;

/** Method names that tear an emitter down rather than drive it. */
const TEARDOWN_RE = /^(?:stop|dispose|destroy|clear|unsubscribe|off|abort|cancel)/;

/** `x` -> 'x', `this.x` -> 'this.x'; any other receiver has no key. */
function receiverKey(e: ts.Expression): string | undefined {
  const u = unwrap(e);
  if (ts.isIdentifier(u)) return u.text;
  if (ts.isPropertyAccessExpression(u) && u.expression.kind === ts.SyntaxKind.ThisKeyword) {
    return `this.${u.name.text}`;
  }
  return undefined;
}

/** `new C(…)` / `new ns.C(…)` -> 'C'. */
function constructedClass(e: ts.Expression | undefined): string | undefined {
  if (!e) return undefined;
  const u = unwrap(e);
  if (!ts.isNewExpression(u)) return undefined;
  const callee = unwrap(u.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

function bindsName(name: ts.BindingName, text: string): boolean {
  if (ts.isIdentifier(name)) return name.text === text;
  return name.elements.some((el) => !ts.isOmittedExpression(el) && bindsName(el.name, text));
}

/** The statements a block-like scope node holds directly. */
function statementsOf(node: ts.Node): readonly ts.Statement[] | undefined {
  if (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseClause(node) ||
    ts.isDefaultClause(node)
  ) {
    return node.statements;
  }
  return undefined;
}

/** True when `node` itself introduces the binding `text`. */
function declaresName(node: ts.Node, text: string): boolean {
  const statements = statementsOf(node);
  if (statements) {
    return statements.some(
      (s) =>
        (ts.isVariableStatement(s) &&
          s.declarationList.declarations.some((d) => bindsName(d.name, text))) ||
        ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name?.text === text),
    );
  }
  if (ts.isFunctionLike(node)) return node.parameters.some((p) => bindsName(p.name, text));
  if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
    const init = node.initializer;
    return (
      init !== undefined &&
      ts.isVariableDeclarationList(init) &&
      init.declarations.some((d) => bindsName(d.name, text))
    );
  }
  if (ts.isCatchClause(node)) {
    return node.variableDeclaration !== undefined && bindsName(node.variableDeclaration.name, text);
  }
  return false;
}

/** The node a key is bound in: innermost declaring scope for `x`, class for `this.x`. */
function scopeOf(key: string, at: ts.Node): ts.Node {
  if (key.startsWith('this.')) {
    return ts.findAncestor(at.parent, ts.isClassLike) ?? at.getSourceFile();
  }
  return ts.findAncestor(at, (node) => declaresName(node, key)) ?? at.getSourceFile();
}

/** Classes constructed into `key` within `scope`, shadowing bindings excluded. */
function constructionsOf(key: string, scope: ts.Node): string[] {
  const classes = new Set<string>();
  for (const node of descendants(scope)) {
    let built: string | undefined;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === key) {
      built = constructedClass(node.initializer);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      receiverKey(node.left) === key
    ) {
      built = constructedClass(node.right);
    } else if (ts.isPropertyDeclaration(node) && `this.${nameText(node.name)}` === key) {
      built = constructedClass(node.initializer);
    }
    if (built && scopeOf(key, node) === scope) classes.add(built);
  }
  return [...classes];
}

/** A method, or a property holding a function. */
function functionOf(member: ts.ClassElement): ts.FunctionLikeDeclaration | undefined {
  if (ts.isMethodDeclaration(member)) return member;
  if (ts.isPropertyDeclaration(member) && member.initializer) {
    const init = unwrap(member.initializer);
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
  }
  return undefined;
}

function isPublicInstance(member: ts.ClassElement): boolean {
  if (member.name && ts.isPrivateIdentifier(member.name)) return false;
  const modifiers = ts.canHaveModifiers(member) ? (ts.getModifiers(member) ?? []) : [];
  return !modifiers.some(
    (m) =>
      m.kind === ts.SyntaxKind.PrivateKeyword ||
      m.kind === ts.SyntaxKind.ProtectedKeyword ||
      m.kind === ts.SyntaxKind.StaticKeyword,
  );
}

/** Class name -> driver names, one entry per declaration of that name. */
function classDrivers(files: readonly SourceFile[]): Map<string, string[][]> {
  const out = new Map<string, string[][]>();
  for (const f of files) {
    for (const node of descendants(parse(f))) {
      if (!ts.isClassDeclaration(node) || !node.name) continue;
      const drivers = new Set<string>();
      for (const member of node.members) {
        const name = nameText(member.name);
        if (!name || !functionOf(member) || !isPublicInstance(member)) continue;
        if (!SUBSCRIBE_NAME_RE.test(name) && !TEARDOWN_RE.test(name)) drivers.add(name);
      }
      out.set(node.name.text, [...(out.get(node.name.text) ?? []), [...drivers]]);
    }
  }
  return out;
}

/**
 * The in-file function an expression designates: an inline arrow or function
 * expression, `this.method` (optionally `.bind(this)`), or an identifier bound
 * to a function declaration or function-valued variable in its scope.
 */
function callbackFunction(arg: ts.Expression): ts.Node | undefined {
  let u = unwrap(arg);
  if (
    ts.isCallExpression(u) &&
    ts.isPropertyAccessExpression(u.expression) &&
    u.expression.name.text === 'bind'
  ) {
    u = unwrap(u.expression.expression);
  }
  if (ts.isArrowFunction(u) || ts.isFunctionExpression(u)) return u;

  if (ts.isPropertyAccessExpression(u) && u.expression.kind === ts.SyntaxKind.ThisKeyword) {
    const method = u.name.text;
    const cls = ts.findAncestor(u, ts.isClassLike);
    const member = cls?.members.find((m) => nameText(m.name) === method);
    return member && functionOf(member);
  }

  if (ts.isIdentifier(u)) {
    const name = u.text;
    const declaring = ts.findAncestor(u, (node) => declaresName(node, name));
    for (const s of (declaring && statementsOf(declaring)) ?? []) {
      if (ts.isFunctionDeclaration(s) && s.name?.text === name) return s;
      if (!ts.isVariableStatement(s)) continue;
      for (const d of s.declarationList.declarations) {
        const init = ts.isIdentifier(d.name) && d.name.text === name ? d.initializer : undefined;
        const fn = init && unwrap(init);
        if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return fn;
      }
    }
  }
  return undefined;
}

/**
 * Channels a callback emits: its own `type: '<channel>'` values and idiom
 * matches, plus those of every in-file helper it calls (`this.method(…)`, a
 * function in scope), transitively.
 */
function emittedBy(f: SourceFile, fn: ts.Node, seen = new Set<ts.Node>()): string[] {
  if (seen.has(fn)) return [];
  seen.add(fn);
  const channels = new Set<string>();
  for (const node of descendants(fn)) {
    if (ts.isPropertyAssignment(node) && nameText(node.name) === 'type') {
      const value = unwrap(node.initializer);
      if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
        channels.add(value.text);
      }
    } else if (ts.isCallExpression(node)) {
      const helper = callbackFunction(node.expression);
      if (helper) for (const channel of emittedBy(f, helper, seen)) channels.add(channel);
    }
  }
  const body = stripComments(f).slice(fn.getStart(parse(f)), fn.getEnd());
  for (const re of EMISSION_PATTERNS) {
    for (const m of body.matchAll(re)) channels.add(m[1]);
  }
  return [...channels];
}

/**
 * True when some driver is called on `key` inside `scope` (same binding) and
 * outside the subscription's own callbacks — a call that can only run once the
 * emitter already fires starts nothing.
 */
function isDriven(
  key: string,
  scope: ts.Node,
  drivers: readonly string[],
  callbacks: readonly ts.Node[],
): boolean {
  return descendants(scope).some((node) => {
    if (!ts.isCallExpression(node)) return false;
    if (callbacks.some((cb) => node.pos >= cb.pos && node.end <= cb.end)) return false;
    const callee = unwrap(node.expression);
    return (
      ts.isPropertyAccessExpression(callee) &&
      drivers.includes(callee.name.text) &&
      receiverKey(callee.expression) === key &&
      scopeOf(key, node) === scope
    );
  });
}

/** An emitting subscription the gate cannot bind to a construction. */
interface UnverifiableSubscription {
  site: string;
  reason: string;
}

interface SubscriptionAudit {
  /** Emitting subscriptions on an instance nothing drives. */
  dead: string[];
  /** Emitting subscriptions the guard cannot bind — surfaced, never skipped. */
  unverifiable: UnverifiableSubscription[];
}

function auditSubscriptions(files: readonly SourceFile[]): SubscriptionAudit {
  const classes = classDrivers(files);
  const audit: SubscriptionAudit = { dead: [], unverifiable: [] };

  for (const f of files) {
    for (const node of descendants(parse(f))) {
      if (!ts.isCallExpression(node)) continue;
      const callee = node.expression;
      if (!ts.isPropertyAccessExpression(callee) || !SUBSCRIBE_NAME_RE.test(callee.name.text)) {
        continue;
      }
      const callbacks = node.arguments
        .map((arg) => callbackFunction(arg))
        .filter((fn): fn is ts.Node => fn !== undefined);
      const channels = [...new Set(callbacks.flatMap((fn) => emittedBy(f, fn)))];
      if (channels.length === 0) continue;

      const site = `${f.file}: ${callee.expression.getText(parse(f))}.${callee.name.text}`;
      const key = receiverKey(callee.expression);
      if (!key) {
        audit.unverifiable.push({ site, reason: 'receiver is not a local or a this.field' });
        continue;
      }
      const scope = scopeOf(key, node);
      const built = constructionsOf(key, scope);
      if (built.length === 0) {
        audit.unverifiable.push({ site, reason: `${key} is not constructed in its scope` });
        continue;
      }
      for (const cls of built) {
        const decls = classes.get(cls) ?? [];
        if (decls.length !== 1) {
          const reason =
            decls.length === 0
              ? `class ${cls} is not declared in the scanned sources`
              : `class ${cls} is declared ${decls.length} times`;
          audit.unverifiable.push({ site, reason });
          continue;
        }
        const drivers = decls[0];
        const where = `${key}.${callee.name.text}() in ${f.file} emits ${channels.join(', ')}`;
        if (drivers.length === 0) {
          audit.dead.push(`${where}, but ${cls} declares no driver method to start it`);
        } else if (!isDriven(key, scope, drivers, callbacks)) {
          audit.dead.push(
            `${where}, but nothing in its scope calls ` +
              drivers.map((d) => `${key}.${d}()`).join(' / '),
          );
        }
      }
    }
  }
  return audit;
}

function findDeadEmitters(files: readonly SourceFile[]): string[] {
  return auditSubscriptions(files).dead;
}

/**
 * Emitting subscriptions whose receiver the gate cannot bind to a construction
 * in scope. Each must still be seen on the real tree (a stale entry fails), so
 * this list doubles as proof that the analysis recognises real code.
 */
const UNVERIFIABLE_SUBSCRIPTIONS: ReadonlyArray<{ site: string; why: string }> = [
  {
    site: 'bridge/MessageBroker.ts: panel.webview.onDidReceiveMessage',
    why:
      'vscode.Webview of a registered panel: VS Code fires it for every message the panel ' +
      'posts, and dispatch() answers a malformed one with bridge:error; nothing to drive.',
  },
  {
    site: 'extension.ts: orgManager.onOrgChange',
    why:
      'OrgManager is built in composition/coreComposition.ts and driven through the injected ' +
      'instance by OrgRegistry (addOrg / removeOrg) and startupValidation (updateStatus): a ' +
      'cross-file binding this scan does not resolve.',
  },
  {
    site: 'providers/SidebarViewProvider.ts: webview.onDidReceiveMessage',
    why: 'vscode.Webview: VS Code fires it for every message the sidebar posts; nothing to drive.',
  },
];

/** A tracker class: one driver, one subscribe method, one stop, one teardown. */
const FIXTURE_TRACKER: SourceFile = {
  file: 'core/FixtureTracker.ts',
  src: [
    'export class FixtureTracker {',
    '  private readonly callbacks = new Set<(n: number) => void>();',
    '  startTicking(id: string): void {',
    '    setInterval(() => this.tick(id), 1000);',
    '  }',
    '  stopTicking(_id: string): void {}',
    '  onTick(cb: (n: number) => void): () => void {',
    '    this.callbacks.add(cb);',
    '    return () => this.callbacks.delete(cb);',
    '  }',
    '  dispose(): void {',
    '    this.callbacks.clear();',
    '  }',
    '  private tick(_id: string): void {',
    '    for (const cb of this.callbacks) cb(1);',
    '  }',
    '}',
    '',
  ].join('\n'),
};

/** The same tracker whose driver is generic — M6. */
const GENERIC_TRACKER: SourceFile = {
  file: FIXTURE_TRACKER.file,
  src: FIXTURE_TRACKER.src.replace(
    '  startTicking(id: string): void {',
    '  startTicking<J extends { id: string }>(id: string, jobs: J[]): void {',
  ),
};

/** A pure sink: nothing but a subscribe method and a teardown. */
const SINK_TRACKER: SourceFile = {
  file: FIXTURE_TRACKER.file,
  src: [
    'export class FixtureTracker {',
    '  onTick(cb: (n: number) => void): () => void {',
    '    return () => undefined;',
    '  }',
    '  dispose(): void {}',
    '}',
    '',
  ].join('\n'),
};

/**
 * A handler that constructs the tracker, subscribes, and emits from the
 * callback. `driver` is the statement meant to start it; `declaration` how the
 * instance is bound; `extraMember` an additional class member.
 */
function fixtureSubscriber(
  driver: string,
  declaration = 'const tracker = new FixtureTracker();',
  extraMember = '',
): SourceFile {
  return {
    file: 'bridge/FixtureHandler.ts',
    src: [
      'export class FixtureHandler {',
      '  run(): void {',
      ...declaration.split('\n').map((line) => `    ${line}`),
      '    const unsub = tracker.onTick((progress) => {',
      '      this.deps.broker.postToWebview({',
      "        type: 'fixture:progress',",
      '        payload: progress,',
      '      });',
      '    });',
      `    ${driver}`,
      '    unsub();',
      '    tracker.dispose();',
      '  }',
      extraMember,
      '}',
      '',
    ].join('\n'),
  };
}

describe('emitted channels (driver-side: a subscription nothing starts)', () => {
  it.each<[string, SourceFile[]]>([
    [
      'the HEAD shape: declared, then constructed and subscribed, never started (M1)',
      [
        FIXTURE_TRACKER,
        fixtureSubscriber(
          '',
          'let tracker: FixtureTracker | undefined;\ntracker = new FixtureTracker();',
        ),
      ],
    ],
    [
      'a driver call that only exists in a comment (M2)',
      [FIXTURE_TRACKER, fixtureSubscriber("// TODO wire: tracker.startTicking('exec-1');")],
    ],
    [
      'a driver call that only exists in a string',
      [FIXTURE_TRACKER, fixtureSubscriber("log('call tracker.startTicking(id) once wired');")],
    ],
    [
      'a typed const declaration (M3)',
      [
        FIXTURE_TRACKER,
        fixtureSubscriber('', 'const tracker: FixtureTracker = new FixtureTracker();'),
      ],
    ],
    [
      'a union-typed let declaration (M3c)',
      [
        FIXTURE_TRACKER,
        fixtureSubscriber('', 'let tracker: FixtureTracker | undefined = new FixtureTracker();'),
      ],
    ],
    [
      'the driver name called on an unrelated object in another file (M5)',
      [
        FIXTURE_TRACKER,
        fixtureSubscriber(''),
        {
          file: 'core/engine/Unrelated.ts',
          src: [
            'export function perf(x: { startTicking(id: string): void }): void {',
            "  x.startTicking('perf');",
            '}',
            '',
          ].join('\n'),
        },
      ],
    ],
    [
      'the driver called on a same-named variable in another scope',
      [
        FIXTURE_TRACKER,
        fixtureSubscriber(
          '',
          undefined,
          [
            '  other(): void {',
            '    const tracker = new FixtureTracker();',
            "    tracker.startTicking('other');",
            '  }',
          ].join('\n'),
        ),
      ],
    ],
    ['a generic driver method (M6)', [GENERIC_TRACKER, fixtureSubscriber('')]],
    ['a class that declares no driver at all', [SINK_TRACKER, fixtureSubscriber('')]],
    [
      'an emitting callback passed by reference',
      [
        FIXTURE_TRACKER,
        {
          file: 'bridge/FixtureHandler.ts',
          src: [
            'export class FixtureHandler {',
            '  run(): void {',
            '    const tracker = new FixtureTracker();',
            '    tracker.onTick(this.forward);',
            '  }',
            '  private forward(progress: number): void {',
            "    this.deps.broker.postToWebview({ type: 'fixture:progress', payload: progress });",
            '  }',
            '}',
            '',
          ].join('\n'),
        },
      ],
    ],
    [
      'an inline callback that emits through a chain of helper methods',
      [
        FIXTURE_TRACKER,
        {
          file: 'bridge/FixtureHandler.ts',
          src: [
            'export class FixtureHandler {',
            '  run(): void {',
            '    const tracker = new FixtureTracker();',
            '    tracker.onTick((progress) => this.forward(progress));',
            '  }',
            '  private forward(progress: number): void {',
            '    this.relay(progress);',
            '  }',
            '  private relay(progress: number): void {',
            "    this.deps.broker.postToWebview({ type: 'fixture:progress', payload: progress });",
            '  }',
            '}',
            '',
          ].join('\n'),
        },
      ],
    ],
    [
      'an inline callback that emits through a function declared in scope',
      [
        FIXTURE_TRACKER,
        {
          file: 'bridge/FixtureHandler.ts',
          src: [
            'function relay(broker: Broker, progress: number): void {',
            "  broker.postToWebview({ type: 'fixture:progress', payload: progress });",
            '}',
            'export class FixtureHandler {',
            '  run(): void {',
            '    const tracker = new FixtureTracker();',
            '    tracker.onTick((progress) => relay(this.deps.broker, progress));',
            '  }',
            '}',
            '',
          ].join('\n'),
        },
      ],
    ],
    [
      'a driver call that only runs inside the callback it would have to fire',
      [
        FIXTURE_TRACKER,
        {
          file: 'bridge/FixtureHandler.ts',
          src: [
            'export class FixtureHandler {',
            '  run(): void {',
            '    const tracker = new FixtureTracker();',
            '    tracker.onTick((progress) => {',
            "      tracker.startTicking('again');",
            "      this.deps.broker.postToWebview({ type: 'fixture:progress', payload: progress });",
            '    });',
            '  }',
            '}',
            '',
          ].join('\n'),
        },
      ],
    ],
  ])('reports %s', (_label, files) => {
    const dead = findDeadEmitters(files);
    expect(dead).toHaveLength(1);
    expect(dead[0]).toContain('fixture:progress');
  });

  it.each<[string, SourceFile[]]>([
    [
      'the driver called on the instance',
      [FIXTURE_TRACKER, fixtureSubscriber("tracker.startTicking('exec-1');")],
    ],
    [
      'the driver called through optional chaining on a typed declaration',
      [
        FIXTURE_TRACKER,
        fixtureSubscriber(
          "tracker?.startTicking('exec-1');",
          'let tracker: FixtureTracker | undefined = new FixtureTracker();',
        ),
      ],
    ],
    [
      'a generic driver actually called',
      [GENERIC_TRACKER, fixtureSubscriber("tracker.startTicking('exec-1', []);")],
    ],
    [
      'a class field built in the constructor and driven from another method',
      [
        FIXTURE_TRACKER,
        {
          file: 'bridge/FieldHandler.ts',
          src: [
            'export class FieldHandler {',
            '  private readonly tracker: FixtureTracker;',
            '  constructor() {',
            '    this.tracker = new FixtureTracker();',
            '    this.tracker.onTick((n) => {',
            "      this.deps.broker.postToWebview({ type: 'fixture:progress', payload: n });",
            '    });',
            '  }',
            '  start(): void {',
            "    this.tracker.startTicking('exec-1');",
            '  }',
            '}',
            '',
          ].join('\n'),
        },
      ],
    ],
    [
      'the driver called from another callback in the same scope',
      [FIXTURE_TRACKER, fixtureSubscriber("setTimeout(() => tracker.startTicking('later'), 0);")],
    ],
  ])('accepts %s', (_label, files) => {
    expect(findDeadEmitters(files)).toEqual([]);
  });

  it.each<[string, SourceFile[], string]>([
    [
      'a receiver that is not constructed in its scope',
      [
        FIXTURE_TRACKER,
        {
          file: 'bridge/InjectedHandler.ts',
          src: [
            'export class InjectedHandler {',
            '  run(): void {',
            '    this.deps.tracker.onTick((n) => {',
            "      this.deps.broker.postToWebview({ type: 'fixture:progress', payload: n });",
            '    });',
            '  }',
            '}',
            '',
          ].join('\n'),
        },
      ],
      'bridge/InjectedHandler.ts: this.deps.tracker.onTick',
    ],
    [
      'an instance of a class the scan does not declare',
      [fixtureSubscriber('', 'const tracker = new FixtureTracker();')],
      'bridge/FixtureHandler.ts: tracker.onTick',
    ],
    [
      'an instance of a class declared twice',
      [
        FIXTURE_TRACKER,
        { file: 'legacy/FixtureTracker.ts', src: FIXTURE_TRACKER.src },
        fixtureSubscriber(''),
      ],
      'bridge/FixtureHandler.ts: tracker.onTick',
    ],
  ])('lists as unverifiable, never skips, %s', (_label, files, site) => {
    const audit = auditSubscriptions(files);
    expect(audit.dead).toEqual([]);
    expect(audit.unverifiable.map((u) => u.site)).toEqual([site]);
  });

  it('no extension channel is emitted from a subscription nothing ever starts', () => {
    expect(auditSubscriptions(extensionFiles()).dead).toEqual([]);
  });

  it('every emitting subscription it cannot bind is listed with a reason, and none is stale', () => {
    const seen = auditSubscriptions(extensionFiles()).unverifiable.map((u) => u.site);
    const listed = UNVERIFIABLE_SUBSCRIPTIONS.map((u) => u.site);
    expect({ unlisted: seen.filter((s) => !listed.includes(s)) }).toEqual({ unlisted: [] });
    expect({ stale: listed.filter((s) => !seen.includes(s)) }).toEqual({ stale: [] });
  });

  it('reads real class declarations (sanity: OfflineManager drivers are seen)', () => {
    expect(classDrivers(extensionFiles()).get('OfflineManager')?.[0]).toContain('startProbing');
  });
});
