import { join, relative, sep } from 'node:path';

import ts from 'typescript';
import { describe, it, expect } from 'vitest';

/**
 * Correlation gate.
 *
 * The webview matches an answer to its request by `correlationId` and reads a
 * falsy one as "no correlation" (`useMessageResponse`). An error that names no
 * request, a fabricated one, or `''` is therefore claimed by the wrong request
 * or silently dropped. `HandlerTypes.ts` makes the proof a type: the only
 * origin a response or an error accepts is an `InboundRequest`, whose id is a
 * branded `RequestId`, or an `UncorrelatedOrigin` whose reason list is empty.
 *
 * tsc rejects every unbranded origin (a literal, a spread that rewrites the id,
 * `{} as BaseMessage`, a free-form reason). What tsc cannot reject is an
 * unsound escape — a cast to the brand, `any`, `never`, a suppressed
 * diagnostic — or an error posted around the typed helpers altogether. This
 * gate rejects those, reading the TypeScript AST with the type checker: a
 * comment is trivia and a string is a literal node, so neither can ever count
 * as a call, a cast or an emission.
 *
 * Every rule is proven red on a probe (see "the gate itself") before it is
 * trusted green on the real tree.
 */

const EXT_ROOT = join(__dirname, '..', '..');
const SRC_ROOT = join(EXT_ROOT, 'src');
const HANDLER_TYPES = join(SRC_ROOT, 'bridge', 'handlers', 'HandlerTypes.ts');
const PROBE = join(SRC_ROOT, 'bridge', 'handlers', '__correlationProbe.ts');

/** Declarations whose `unique symbol` type is a correlation brand. */
const BRAND_DECLARATIONS = ['requestIdBrand', 'UNCORRELATED'];

/** The only places a type assertion may produce a correlation brand. */
const SANCTIONED_MINTS = [
  'bridge/MessageRouter.ts#MessageRouter.route',
  'bridge/handlers/HandlerTypes.ts#syntheticRequest',
];

/** Functions whose every call site is pinned below. */
const PINNED_FUNCTIONS = ['syntheticRequest', 'uncorrelated'];

/**
 * Every extension-initiated run that stands in for a request: `<site>:<kind>`.
 * Adding one is a reviewed edit of this list.
 */
const SYNTHETIC_CALL_SITES = [
  'bridge/ExtensionHandlers.ts#ExtensionHandlers.replayQueuedOperation:offline-replay',
  'bridge/handlers/SyncOpsHandler.ts#SyncOpsHandler.executeScheduled:sync:schedule',
];

/** Every call to `uncorrelated` — none: `UncorrelatedReason` is `never`. */
const UNCORRELATED_CALL_SITES: readonly string[] = [];

/** Helpers that emit a channel and stamp `correlationId` from a branded origin. */
const BASE_SINKS: Readonly<Record<string, { channel: number; origin: number }>> = {
  'bridge/handlers/HandlerTypes.ts#sendHandlerError': { channel: 2, origin: 3 },
  'bridge/handlers/HandlerTypes.ts#buildResponse': { channel: 2, origin: 1 },
};

/**
 * Error channels emitted outside the typed helpers, each for a stated reason:
 * - `bridge:error` is the envelope rejection, posted before any handler runs;
 *   it echoes the raw id when one can be read, and `useMessageResponse`
 *   matches it on `correlationId` only, never by timing.
 * - `forge:error` is an in-process EventEmitter event of ForgeOrchestrator;
 *   nothing forwards it to the webview (the handler reports the rethrown
 *   error through `sendHandlerError`).
 */
const ERROR_CHANNEL_EXCEPTIONS = [
  'bridge/MessageBroker.ts#MessageBroker.postBridgeError:bridge:error',
  'modules/forge/ForgeOrchestrator.ts#ForgeOrchestrator.execute:forge:error',
];

/**
 * The only writers of `correlationId`: the two helpers, the envelope
 * rejection, and the sidebar's raw locale answer (it bypasses the broker).
 */
const CORRELATION_WRITERS = [
  'bridge/MessageBroker.ts#MessageBroker.postBridgeError',
  'bridge/handlers/HandlerTypes.ts#buildResponse',
  'bridge/handlers/HandlerTypes.ts#sendHandlerError',
  'providers/SidebarViewProvider.ts#SidebarViewProvider.answerLocaleRequest',
];

/**
 * A diagnostic about correlation names one of these: an alias when tsc reports
 * the parameter, or the brand itself when it elaborates a property
 * (`Type 'string' is not assignable to type 'string & { readonly [requestIdBrand]: true; }'`).
 */
const TYPE_NAMES =
  /\b(RequestId|InboundRequest|ErrorOrigin|UncorrelatedOrigin|UncorrelatedReason|SyntheticRequestKind|requestIdBrand|UNCORRELATED)\b/;

const relPath = (fileName: string): string => relative(SRC_ROOT, fileName).split(sep).join('/');

/** What the bundle can ship: tests and `src/test/` fabricate requests on purpose. */
function isProductionFile(fileName: string): boolean {
  const r = relPath(fileName);
  return (
    !r.startsWith('..') &&
    !r.startsWith('test/') &&
    !r.includes('node_modules') &&
    !r.endsWith('.test.ts')
  );
}

// ── Program ────────────────────────────────────────────────────────────────

const sourceCache = new Map<string, ts.SourceFile>();
let baseProgram: ts.Program | undefined;

/** The production program, optionally with in-memory files (probes, mutations). */
function loadProgram(overrides: Readonly<Record<string, string>> = {}): ts.Program {
  const { config } = ts.readConfigFile(join(EXT_ROOT, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, EXT_ROOT);
  const options = { ...parsed.options, noEmit: true };
  const host = ts.createCompilerHost(options, true);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (f) => overrides[f] ?? readFile(f);
  host.fileExists = (f) => f in overrides || fileExists(f);
  host.getSourceFile = (f, language, onError, create) => {
    const text = overrides[f];
    if (text !== undefined) return ts.createSourceFile(f, text, language, true);
    let sf = sourceCache.get(f);
    if (!sf) {
      sf = getSourceFile(f, language, onError, create);
      if (sf) sourceCache.set(f, sf);
    }
    return sf;
  };
  const rootNames = [...new Set([...parsed.fileNames, ...Object.keys(overrides)])];
  const program = ts.createProgram({ rootNames, options, host, oldProgram: baseProgram });
  if (Object.keys(overrides).length === 0) baseProgram = program;
  return program;
}

// ── Analysis ───────────────────────────────────────────────────────────────

interface Analysis {
  /** Violations: `<rule> <file>:<line> <site> — <detail>`. */
  findings: string[];
  /** Sanctioned mints actually seen (guards the guard). */
  mints: string[];
  /** Pinned calls actually seen, `<site>:<kind>`. */
  syntheticCalls: string[];
  uncorrelatedCalls: string[];
  /** Error-channel literals accepted through a sink, `<site>:<channel>`. */
  sinkChannels: string[];
  /** `sendHandlerError` channel arguments (for the `:response` rule). */
  handlerErrorChannels: string[];
  exceptionsSeen: string[];
  correlationWriters: string[];
}

/** `<file>#<callable>`, with the class for members: `bridge/handlers/SyncOpsHandler.ts#SyncOpsHandler.executeScheduled`. */
function siteName(node: ts.Node): string {
  const file = relPath(node.getSourceFile().fileName);
  const className = (member: ts.Node): string => {
    const owner = member.parent;
    return ts.isClassLike(owner) && owner.name ? `${owner.name.text}.` : '';
  };
  let container: string | undefined;
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name) return `${file}#${n.name.text}`;
    if (
      (ts.isMethodDeclaration(n) ||
        ts.isGetAccessorDeclaration(n) ||
        ts.isSetAccessorDeclaration(n)) &&
      n.name
    ) {
      return `${file}#${className(n)}${n.name.getText()}`;
    }
    if (ts.isConstructorDeclaration(n)) return `${file}#${className(n)}constructor`;
    if (
      (ts.isVariableDeclaration(n) || ts.isPropertyDeclaration(n)) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    ) {
      return `${file}#${ts.isPropertyDeclaration(n) ? className(n) : ''}${n.name.text}`;
    }
    if (
      !container &&
      (ts.isClassLike(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) &&
      n.name
    ) {
      container = n.name.text;
    }
  }
  return `${file}#${container ?? '<module>'}`;
}

const lineOf = (node: ts.Node): number =>
  node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;

function analyze(program: ts.Program, overrides: Readonly<Record<string, string>>): Analysis {
  const only = Object.keys(overrides).length > 0 ? new Set(Object.keys(overrides)) : undefined;
  const checker = program.getTypeChecker();
  const out: Analysis = {
    findings: [],
    mints: [],
    syntheticCalls: [],
    uncorrelatedCalls: [],
    sinkChannels: [],
    handlerErrorChannels: [],
    exceptionsSeen: [],
    correlationWriters: [],
  };
  const report = (rule: string, node: ts.Node, detail: string): void => {
    out.findings.push(
      `${rule} ${relPath(node.getSourceFile().fileName)}:${lineOf(node)} ${siteName(node)} — ${detail}`,
    );
  };

  // Brands, resolved from their declarations — not from their names in text.
  const handlerTypes = program.getSourceFile(HANDLER_TYPES);
  if (!handlerTypes) throw new Error('HandlerTypes.ts is not in the program');
  const brands = new Set<string>();
  const pinned = new Map<ts.Symbol, string>();
  handlerTypes.forEachChild(function visit(n): void {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      BRAND_DECLARATIONS.includes(n.name.text)
    ) {
      const t = checker.getTypeAtLocation(n.name);
      if (t.flags & ts.TypeFlags.UniqueESSymbol)
        brands.add(String((t as ts.UniqueESSymbolType).escapedName));
    }
    if (ts.isFunctionDeclaration(n) && n.name && PINNED_FUNCTIONS.includes(n.name.text)) {
      const s = checker.getSymbolAtLocation(n.name);
      if (s) pinned.set(s, n.name.text);
    }
    n.forEachChild(visit);
  });
  if (brands.size !== BRAND_DECLARATIONS.length || pinned.size !== PINNED_FUNCTIONS.length) {
    throw new Error(
      `correlation brands not found in HandlerTypes.ts (brands ${brands.size}, pinned ${pinned.size})`,
    );
  }

  // Does a value of this type carry a brand anywhere a caller can reach it?
  const done = new Map<ts.Type, boolean>();
  const active = new Set<ts.Type>();
  const inRepo = (s: ts.Symbol): boolean =>
    (s.declarations ?? []).some((d) => {
      const f = d.getSourceFile().fileName;
      return !f.includes('/node_modules/') && !/\/lib\.[\w.]*\.d\.ts$/.test(f);
    });
  const walk = (type: ts.Type): { brand: boolean; cyclic: boolean } => {
    const cached = done.get(type);
    if (cached !== undefined) return { brand: cached, cyclic: false };
    if (active.has(type)) return { brand: false, cyclic: true };
    active.add(type);
    let cyclic = false;
    const sub = (t: ts.Type): boolean => {
      const r = walk(t);
      cyclic ||= r.cyclic;
      return r.brand;
    };
    const props = checker.getPropertiesOfType(type);
    const brand =
      (type.isUnionOrIntersection() && type.types.some(sub)) ||
      props.some((p) => brands.has(String(p.escapedName))) ||
      props.some((p) => inRepo(p) && sub(checker.getTypeOfSymbol(p))) ||
      (!!(type.flags & ts.TypeFlags.Object) &&
        !!((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) &&
        checker.getTypeArguments(type as ts.TypeReference).some(sub)) ||
      [...type.getCallSignatures(), ...type.getConstructSignatures()].some((s) =>
        sub(checker.getReturnTypeOfSignature(s)),
      );
    active.delete(type);
    if (brand || !cyclic) done.set(type, brand);
    return { brand, cyclic };
  };
  const carriesBrand = (type: ts.Type | undefined): boolean => !!type && walk(type).brand;
  const isAnyOrNever = (type: ts.Type): boolean =>
    !!(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Never));

  /** Callable members of `type` (declared in the repo) and which of their parameters demand a brand. */
  const demanding = new Map<ts.Type, Map<string, boolean[]>>();
  const membersDemandingBrand = (type: ts.Type): Map<string, boolean[]> => {
    let members = demanding.get(type);
    if (members) return members;
    members = new Map();
    demanding.set(type, members);
    for (const p of checker.getPropertiesOfType(type)) {
      if (!inRepo(p)) continue;
      for (const sig of checker.getTypeOfSymbol(p).getCallSignatures()) {
        const demands = sig.parameters.map((param) => carriesBrand(checker.getTypeOfSymbol(param)));
        if (demands.some(Boolean)) members.set(String(p.escapedName), demands);
      }
    }
    return members;
  };
  /** A member demanding a brand, seen through a type whose same member does not demand it. */
  const widensBrandedMember = (
    source: ts.Type,
    target: ts.Type | undefined,
  ): string | undefined => {
    if (!target) return undefined;
    // Containers are covariant: `const view: BaseMessage[] = requests` lets
    // `view.push(forged)` land in the branded array, again without a cast.
    const reference = (t: ts.Type): ts.TypeReference | undefined =>
      t.flags & ts.TypeFlags.Object && (t as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference
        ? (t as ts.TypeReference)
        : undefined;
    const from = reference(source);
    const to = reference(target);
    if (
      from &&
      to &&
      from.target === to.target &&
      !/^(Promise|PromiseLike|ReadonlyArray)$/.test(to.symbol?.name ?? '')
    ) {
      const toArgs = checker.getTypeArguments(to);
      const lostArg = checker
        .getTypeArguments(from)
        .findIndex(
          (arg, i) =>
            carriesBrand(arg) &&
            !!toArgs[i] &&
            !(toArgs[i].flags & ts.TypeFlags.StringLike) &&
            !carriesBrand(toArgs[i]),
        );
      if (lostArg >= 0) return `type argument ${lostArg + 1} no longer demands a brand`;
    }
    for (const [name, demands] of membersDemandingBrand(source)) {
      const member = target.getProperty(name);
      for (const sig of member ? checker.getTypeOfSymbol(member).getCallSignatures() : []) {
        const lost = demands.findIndex(
          (demanded, i) =>
            demanded &&
            i < sig.parameters.length &&
            !carriesBrand(checker.getTypeOfSymbol(sig.parameters[i])),
        );
        if (lost >= 0) return `${name}(): parameter ${lost + 1} no longer demands a brand`;
      }
    }
    return undefined;
  };

  const declarationSite = (decl: ts.Declaration): string => siteName(decl);

  /** Index of the branded origin parameter when `call` emits its `argIndex` argument as a channel. */
  const sinkOrigin = (
    call: ts.CallExpression,
    argIndex: number,
    depth: number,
  ): number | undefined => {
    const decl = checker.getResolvedSignature(call)?.getDeclaration();
    if (!decl || !(ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl)) || !decl.body)
      return undefined;
    if (!isProductionFile(decl.getSourceFile().fileName)) return undefined;
    const params = decl.parameters;
    const originIndex = params.findIndex((p) => carriesBrand(checker.getTypeAtLocation(p)));
    if (originIndex < 0) return undefined;
    const base = BASE_SINKS[declarationSite(decl)];
    if (base)
      return base.channel === argIndex && base.origin === originIndex ? originIndex : undefined;
    // A forwarder: its channel parameter may only reach a sink's channel slot,
    // paired with its own origin parameter.
    const channelParam = params[argIndex];
    const originParam = params[originIndex];
    if (
      depth >= 3 ||
      !channelParam ||
      !ts.isIdentifier(channelParam.name) ||
      !ts.isIdentifier(originParam.name)
    ) {
      return undefined;
    }
    const channelSymbol = checker.getSymbolAtLocation(channelParam.name);
    const originSymbol = checker.getSymbolAtLocation(originParam.name);
    const refs: ts.Identifier[] = [];
    decl.body.forEachChild(function find(n): void {
      if (ts.isIdentifier(n) && checker.getSymbolAtLocation(n) === channelSymbol) refs.push(n);
      n.forEachChild(find);
    });
    if (refs.length === 0) return undefined;
    for (const ref of refs) {
      const inner = ref.parent;
      if (!ts.isCallExpression(inner)) return undefined;
      const j = inner.arguments.indexOf(ref);
      const innerOrigin = j < 0 ? undefined : sinkOrigin(inner, j, depth + 1);
      const originArg = innerOrigin === undefined ? undefined : inner.arguments[innerOrigin];
      if (
        !originArg ||
        !ts.isIdentifier(originArg) ||
        checker.getSymbolAtLocation(originArg) !== originSymbol
      ) {
        return undefined;
      }
    }
    return originIndex;
  };

  const suppressed: ts.SourceFile[] = [];

  for (const sf of program.getSourceFiles()) {
    if (!isProductionFile(sf.fileName) || (only && !only.has(sf.fileName))) continue;
    const isTypesFile = sf.fileName === HANDLER_TYPES;
    if (/@ts-(ignore|expect-error|nocheck)/.test(sf.text)) suppressed.push(sf);

    const visit = (n: ts.Node): void => {
      // R1 — a type assertion that produces a brand mints a correlation.
      if (
        (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) &&
        !(ts.isTypeReferenceNode(n.type) && n.type.typeName.getText() === 'const')
      ) {
        const widenedByCast = widensBrandedMember(
          checker.getTypeAtLocation(n.expression),
          checker.getTypeFromTypeNode(n.type),
        );
        if (widenedByCast) report('R6-brand-widening', n, widenedByCast);
        if (carriesBrand(checker.getTypeFromTypeNode(n.type))) {
          const site = siteName(n);
          if (SANCTIONED_MINTS.includes(site)) out.mints.push(site);
          else report('R1-cast-mint', n, n.getText());
        }
      }

      // R2 — `any` or `never` flowing into a branded slot launders a brand.
      const slots: ts.Expression[] = [];
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) slots.push(...(n.arguments ?? []));
      else if (
        (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isPropertyDeclaration(n)) &&
        n.initializer
      ) {
        slots.push(n.initializer);
      } else if (ts.isReturnStatement(n) && n.expression) slots.push(n.expression);
      else if (ts.isArrowFunction(n) && !ts.isBlock(n.body)) slots.push(n.body);
      else if (ts.isPropertyAssignment(n)) slots.push(n.initializer);
      else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken)
        slots.push(n.right);
      else if (ts.isArrayLiteralExpression(n)) slots.push(...n.elements);
      for (const e of slots) {
        const context = checker.getContextualType(e);
        if (carriesBrand(context) && isAnyOrNever(checker.getTypeAtLocation(e))) {
          report('R2-any-or-never', e, e.getText());
        }
        // R6 — method parameters are bivariant in TypeScript: a handler that
        // demands a brand, stored under a looser method signature, accepts a
        // forged request without a single cast.
        const widened = widensBrandedMember(checker.getTypeAtLocation(e), context);
        if (widened) report('R6-brand-widening', e, widened);
      }
      if (ts.isShorthandPropertyAssignment(n)) {
        const holder = checker.getContextualType(n.parent);
        const prop = holder?.getProperty(n.name.text);
        if (
          prop &&
          carriesBrand(checker.getTypeOfSymbol(prop)) &&
          isAnyOrNever(checker.getTypeAtLocation(n.name))
        ) {
          report('R2-any-or-never', n, n.getText());
        }
      }

      if (ts.isCallExpression(n)) {
        const sig = checker.getResolvedSignature(n);
        const ret = sig && checker.getReturnTypeOfSignature(sig);
        const decl = sig?.getDeclaration();
        // R5 — a brand that comes from instantiation, not from a declaration or an input.
        if (sig && carriesBrand(ret)) {
          const callee = checker.getSymbolAtLocation(n.expression);
          const isAssign =
            callee?.name === 'assign' &&
            /\bObjectConstructor\b/.test(
              checker.typeToString(
                checker.getTypeAtLocation(
                  ts.isPropertyAccessExpression(n.expression)
                    ? n.expression.expression
                    : n.expression,
                ),
              ),
            );
          const declSig =
            decl && !ts.isJSDocSignature(decl)
              ? checker.getSignatureFromDeclaration(decl)
              : undefined;
          const fromDeclaration =
            !!declSig && carriesBrand(checker.getReturnTypeOfSignature(declSig));
          const receiver =
            ts.isPropertyAccessExpression(n.expression) ||
            ts.isElementAccessExpression(n.expression)
              ? checker.getTypeAtLocation(n.expression.expression)
              : undefined;
          const fromInput =
            carriesBrand(receiver) ||
            n.arguments.some((a) => carriesBrand(checker.getTypeAtLocation(a)));
          if (isAssign)
            report(
              'R5-object-assign',
              n,
              'Object.assign types an overwritten id as the branded one',
            );
          else if (!fromDeclaration && !fromInput) report('R5-generic-mint', n, n.getText());
        }
      }

      // R3 — pinned functions: every use is a direct call at a listed site.
      if (ts.isIdentifier(n) && !isTypesFile) {
        let s = checker.getSymbolAtLocation(n);
        if (s && s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
        const fn = s && pinned.get(s);
        if (fn && !ts.isImportSpecifier(n.parent) && !ts.isExportSpecifier(n.parent)) {
          const call =
            ts.isPropertyAccessExpression(n.parent) && n.parent.name === n
              ? n.parent.parent
              : n.parent;
          const callee =
            ts.isPropertyAccessExpression(n.parent) && n.parent.name === n ? n.parent : n;
          if (ts.isCallExpression(call) && call.expression === callee) {
            if (fn === 'syntheticRequest') {
              const kind = call.arguments[0];
              const entry = `${siteName(call)}:${kind && ts.isStringLiteral(kind) ? kind.text : '<computed>'}`;
              out.syntheticCalls.push(entry);
              if (!SYNTHETIC_CALL_SITES.includes(entry)) report('R3-synthetic-site', call, entry);
            } else {
              const entry = siteName(call);
              out.uncorrelatedCalls.push(entry);
              if (!UNCORRELATED_CALL_SITES.includes(entry))
                report('R3-uncorrelated-site', call, entry);
            }
          } else {
            report('R3-pinned-reference', n, `${fn} used without being called`);
          }
        }
      }

      // R7 — a branded value declared without an implementation to police.
      if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && !n.body) {
        const abstract = ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Abstract;
        const sig = checker.getSignatureFromDeclaration(n);
        if (!abstract && sig && carriesBrand(checker.getReturnTypeOfSignature(sig)))
          report('R7-bodiless', n, n.getText());
      }
      if (
        ts.isVariableDeclaration(n) &&
        (sf.isDeclarationFile || ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Ambient)
      ) {
        if (carriesBrand(checker.getTypeAtLocation(n.name))) report('R7-bodiless', n, n.getText());
      }

      // R10 — a message id is never rewritten after construction: through an
      // unbranded alias, `alias.id = ''` rewrites the branded original.
      const idHolder = (e: ts.Expression): ts.Expression | undefined =>
        ts.isPropertyAccessExpression(e) && e.name.text === 'id'
          ? e.expression
          : ts.isElementAccessExpression(e) &&
              ts.isStringLiteral(e.argumentExpression) &&
              e.argumentExpression.text === 'id'
            ? e.expression
            : undefined;
      const rewrittenHolder =
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
          ? idHolder(n.left)
          : ts.isDeleteExpression(n)
            ? idHolder(n.expression)
            : ts.isCallExpression(n) &&
                /^(Object\.(assign|defineProperty)|Reflect\.set)$/.test(n.expression.getText())
              ? n.arguments[0]
              : undefined;
      if (rewrittenHolder) {
        const holder = checker.getTypeAtLocation(rewrittenHolder);
        if (
          holder.getProperty('id') &&
          holder.getProperty('type') &&
          holder.getProperty('timestamp')
        ) {
          report('R10-id-rewrite', n, n.getText());
        }
      }

      // R8 — writing correlationId anywhere but the listed writers.
      const writesCorrelation =
        ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) &&
          (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) &&
          n.name.text === 'correlationId') ||
        (ts.isBinaryExpression(n) &&
          n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          n.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
          ts.isPropertyAccessExpression(n.left) &&
          n.left.name.text === 'correlationId') ||
        (ts.isDeleteExpression(n) &&
          ts.isPropertyAccessExpression(n.expression) &&
          n.expression.name.text === 'correlationId') ||
        (ts.isStringLiteral(n) &&
          n.text === 'correlationId' &&
          !(
            (ts.isPropertyAssignment(n.parent) || ts.isPropertySignature(n.parent)) &&
            n.parent.name === n
          ));
      if (writesCorrelation) {
        const site = siteName(n);
        if (CORRELATION_WRITERS.includes(site)) out.correlationWriters.push(site);
        else report('R8-correlation-write', n, n.getText());
      }

      // R9 — an error channel is only ever named as the channel of a branded sink.
      const channel =
        ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)
          ? n.text
          : ts.isTemplateExpression(n)
            ? `\${…}${n.templateSpans[n.templateSpans.length - 1].literal.text}`
            : undefined;
      if (
        channel?.endsWith(':error') &&
        !(ts.isPropertySignature(n.parent) && n.parent.name === n)
      ) {
        const parent = n.parent;
        const argIndex = ts.isCallExpression(parent)
          ? parent.arguments.indexOf(n as ts.Expression)
          : -1;
        const site = siteName(n);
        if (argIndex >= 0 && sinkOrigin(parent as ts.CallExpression, argIndex, 0) !== undefined) {
          out.sinkChannels.push(`${site}:${channel}`);
        } else if (ERROR_CHANNEL_EXCEPTIONS.includes(`${site}:${channel}`)) {
          out.exceptionsSeen.push(`${site}:${channel}`);
        } else {
          report('R9-error-channel', n, `${channel} is not the channel argument of a branded sink`);
        }
      }
      if (ts.isCallExpression(n)) {
        const decl = checker.getResolvedSignature(n)?.getDeclaration();
        const arg = n.arguments[2];
        if (
          decl &&
          declarationSite(decl) === 'bridge/handlers/HandlerTypes.ts#sendHandlerError' &&
          arg &&
          ts.isStringLiteral(arg)
        ) {
          out.handlerErrorChannels.push(`${siteName(n)}:${arg.text}`);
        }
      }

      n.forEachChild(visit);
    };
    visit(sf);
  }

  // R4 — a suppression directive hides whatever it hides: re-check those files
  // with the directives neutralised and keep only correlation diagnostics.
  if (suppressed.length > 0) {
    const neutralised: Record<string, string> = {};
    for (const sf of suppressed) {
      let text = sf.text;
      const ranges: ts.CommentRange[] = [];
      const seen = new Set<number>();
      const collect = (node: ts.Node): void => {
        for (const r of [
          ...(ts.getLeadingCommentRanges(sf.text, node.pos) ?? []),
          ...(ts.getTrailingCommentRanges(sf.text, node.end) ?? []),
        ]) {
          if (!seen.has(r.pos)) {
            seen.add(r.pos);
            ranges.push(r);
          }
        }
        node.getChildren(sf).forEach(collect);
      };
      collect(sf);
      for (const r of ranges.sort((a, b) => b.pos - a.pos)) {
        const comment = text.slice(r.pos, r.end);
        if (/@ts-(ignore|expect-error|nocheck)/.test(comment)) {
          text =
            text.slice(0, r.pos) +
            comment.replace(/@ts-(ignore|expect-error|nocheck)/g, '@tz-$1') +
            text.slice(r.end);
        }
      }
      if (text !== sf.text) neutralised[sf.fileName] = text;
    }
    if (Object.keys(neutralised).length > 0) {
      const recheck = loadProgram({ ...overrides, ...neutralised });
      for (const fileName of Object.keys(neutralised)) {
        const sf = recheck.getSourceFile(fileName);
        for (const d of sf ? recheck.getSemanticDiagnostics(sf) : []) {
          const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
          if (d.file && d.start !== undefined && TYPE_NAMES.test(message)) {
            const line = d.file.getLineAndCharacterOfPosition(d.start).line + 1;
            out.findings.push(
              `R4-suppressed ${relPath(fileName)}:${line} — ${message.split('\n')[0]}`,
            );
          }
        }
      }
    }
  }

  return out;
}

/** Analyse the real tree, or only the in-memory `files` added to it. */
function run(files: Readonly<Record<string, string>> = {}): Analysis {
  return analyze(loadProgram(files), files);
}

const unique = (xs: string[]): string[] => [...new Set(xs)].sort();

// ── Probes ─────────────────────────────────────────────────────────────────

const HEADER = `import type { BaseMessage } from '@sandforge/shared';
import { validatePayload, operationIdPayloadSchema } from '../validatePayload.js';
import {
  buildResponse,
  sendHandlerError,
  syntheticRequest,
  uncorrelated,
  uncorrelated as orphan,
  type DomainHandler,
  type HandlerDeps,
  type InboundRequest,
  type RequestId,
} from './HandlerTypes.js';

type D = Pick<HandlerDeps, 'log' | 'broker' | 'nextId'>;
type Alias = InboundRequest;
interface Loose {
  handle(msg: BaseMessage): Promise<boolean>;
}
`;

/** One bypass per line; the tag after `//` names the rule expected on that line. */
const BYPASSES = `${HEADER}
declare function forged(raw: unknown): InboundRequest; // R7-bodiless
function launder<T>(raw: unknown): T {
  return raw as T;
}
function relay(deps: D, msg: InboundRequest, channel: string): void {
  deps.broker.postToWebview({ ...buildResponse(deps, msg, 'x:response', {}), type: channel });
}
export function bypasses(deps: D, msg: InboundRequest, err: unknown, raw: string, handler: DomainHandler): void {
  sendHandlerError(deps, 'p', 'sync:error', {} as InboundRequest, err); // R1-cast-mint
  sendHandlerError(deps, 'p', 'sync:error', { id: '', type: 'x', timestamp: 0 } as unknown as Alias, err); // R1-cast-mint
  sendHandlerError(deps, 'p', 'sync:error', { ...msg, id: '' as RequestId }, err); // R1-cast-mint
  sendHandlerError(deps, 'p', 'sync:error', JSON.parse(raw), err); // R2-any-or-never
  sendHandlerError(deps, 'p', 'sync:error', raw as never, err); // R2-any-or-never
  sendHandlerError(deps, 'p', 'sync:error', launder<InboundRequest>(raw), err); // R5-generic-mint
  sendHandlerError(deps, 'p', 'sync:error', Object.assign({}, msg, { id: '' }), err); // R5-object-assign
  sendHandlerError(deps, 'p', 'sync:error', forged(raw), err);
  sendHandlerError(deps, 'p', 'sync:error', uncorrelated(\`tick\` as never), err); // R3-uncorrelated-site
  sendHandlerError(deps, 'p', 'sync:error', orphan(raw as never), err); // R3-uncorrelated-site
  sendHandlerError(deps, 'p', 'sync:error', syntheticRequest('offline-replay', raw, 'x'), err); // R3-synthetic-site
  const mint = syntheticRequest; // R3-pinned-reference
  deps.broker.postToWebview({ id: 'x', type: 'sync:error', timestamp: 0, payload: { message: 'boom' } } as BaseMessage); // R9-error-channel
  deps.broker.postToWebview({ id: 'x', type: \`\${raw}:error\`, timestamp: 0 } as BaseMessage); // R9-error-channel
  deps.broker.postToWebview({ ...buildResponse(deps, msg, 'x:response', {}), correlationId: '' }); // R8-correlation-write
  relay(deps, msg, 'sync:error'); // R9-error-channel
  void mint;
  const loose: Loose = handler; // R6-brand-widening
  void loose.handle({ id: '', type: 'x', timestamp: 0 });
  void (handler as Loose).handle({ id: '', type: 'x', timestamp: 0 }); // R6-brand-widening
  const requests: InboundRequest[] = [msg];
  const view: BaseMessage[] = requests; // R6-brand-widening
  view.push({ id: '', type: 'x', timestamp: 0 });
  const copy = { ...msg };
  const alias: BaseMessage = copy;
  alias.id = ''; // R10-id-rewrite
  sendHandlerError(deps, 'p', 'sync:error', copy, err);
  // @ts-expect-error — a directive hides the forgery from tsc
  sendHandlerError(deps, 'p', 'sync:error', { id: '', type: 'x', timestamp: 0 }, err); // R4-suppressed
}
`;

/** Legitimate handler code: must stay green, or the gate is merely noisy. */
const LEGITIMATE = `${HEADER}
export async function legitimate(deps: D, msg: InboundRequest & { payload?: unknown }, err: unknown): Promise<void> {
  const withPayload = { ...msg, payload: { orgId: 'o' } };
  sendHandlerError(deps, 'c', 'sync:error', withPayload, err);
  sendHandlerError(deps, 'c', 'sync:error', msg, err, { code: 'X', retryable: true });
  deps.broker.postToWebview(buildResponse(deps, msg, 'ai:error', { message: 'not configured' }));
  validatePayload(operationIdPayloadSchema, msg, 'org:error', deps);
  const queue: InboundRequest[] = [msg];
  sendHandlerError(deps, 'c', 'sync:error', queue[0], err);
  sendHandlerError(deps, 'c', 'sync:error', structuredClone(msg), err);
  const handlers: DomainHandler[] = [];
  const strict: { handle(request: InboundRequest): Promise<boolean> } | undefined = handlers[0];
  void strict?.handle(msg);
  const pending: InboundRequest[] = [msg];
  const frozenView: readonly InboundRequest[] = pending;
  const ids: string[] = pending.map((p) => p.id);
  void [frozenView, ids];
  deps.broker.postToWebview({ id: deps.nextId(), type: 'operation:failed', timestamp: Date.now() } as BaseMessage);
  // A comment naming sendHandlerError(deps, 'c', 'sync:error', {} as InboundRequest, err) is not code.
  deps.log('a string naming x:error is not an emission either, unless it ends with the channel');
}
`;

/** Line number → expected rule, read from the probe's own tags (test side, not gate side). */
function expectedRules(source: string): string[] {
  return source
    .split('\n')
    .map((line, i) => ({ line: i + 1, tag: /\/\/ (R\d+-[a-z-]+)$/.exec(line)?.[1] }))
    .filter((x): x is { line: number; tag: string } => !!x.tag)
    .map((x) => `${x.tag} bridge/handlers/__correlationProbe.ts:${x.line}`);
}

const located = (findings: string[]): string[] =>
  unique(findings.map((f) => f.split(' ').slice(0, 2).join(' ')));

// ── Tests ──────────────────────────────────────────────────────────────────

describe('correlation gate', () => {
  describe('the gate itself', () => {
    it('flags every bypass of the probe, each on its own line and rule', () => {
      const { findings } = run({ [PROBE]: BYPASSES });
      expect(located(findings)).toEqual(unique(expectedRules(BYPASSES)));
    }, 60_000);

    it('stays green on legitimate handler code, comments and log strings included', () => {
      const { findings } = run({ [PROBE]: LEGITIMATE });
      expect(findings).toEqual([]);
    }, 60_000);
  });

  describe('the real tree', () => {
    let tree: Analysis | undefined;
    const real = (): Analysis => (tree ??= run());

    it('finds no correlation bypass in production sources', () => {
      expect(real().findings).toEqual([]);
    }, 60_000);

    it('sees the sanctioned mints, so an empty walk cannot pass', () => {
      expect(unique(real().mints)).toEqual([...SANCTIONED_MINTS].sort());
    }, 60_000);

    it('pins every synthetic request and every uncorrelated error', () => {
      expect(unique(real().syntheticCalls)).toEqual([...SYNTHETIC_CALL_SITES].sort());
      expect(unique(real().uncorrelatedCalls)).toEqual([...UNCORRELATED_CALL_SITES].sort());
    }, 60_000);

    it('accepts error channels only through branded sinks, and every listed exception is live', () => {
      expect(real().sinkChannels.length).toBeGreaterThan(200);
      expect(unique(real().exceptionsSeen)).toEqual([...ERROR_CHANNEL_EXCEPTIONS].sort());
      expect(unique(real().correlationWriters)).toEqual([...CORRELATION_WRITERS].sort());
    }, 60_000);

    it('never posts an error payload on a :response channel', () => {
      // `sendHandlerError` delivers `{ message, code, retryable }`. On a
      // `:response` channel the webview reads the success shape off it, gets
      // `undefined`, and renders a failed query as a healthy empty result — 15
      // call sites shipped that way across Monitor, Config and Governance.
      const channels = real().handlerErrorChannels;
      expect(channels.length).toBeGreaterThan(100);
      expect(channels.filter((c) => c.endsWith(':response'))).toEqual([]);
    }, 60_000);
  });
});
