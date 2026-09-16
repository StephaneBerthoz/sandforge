import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import ts from 'typescript';
import { describe, it, expect } from 'vitest';

/**
 * Payload-validation gate.
 *
 * Everything a webview sends is attacker-shaped input: the envelope union
 * declares `payload: z.unknown().optional()` and passes unknown keys through,
 * so the broker proves only that the channel exists. The shape of the payload
 * is proven once, in the handler, by `validatePayload`, which answers a
 * malformed request with INVALID_PAYLOAD on the domain's error channel instead
 * of reading fields that are not there — or writing an org with them.
 *
 * About 90 call sites did that and nothing held them there. Deleting one turned
 * nothing red: the route kept answering, on whatever the message happened to
 * carry. This gate reads the TypeScript AST of every domain handler, finds the
 * method each `case '<channel>':` delegates to, and refuses a method that
 * reaches for `payload` without having validated it first.
 *
 * Deliberately AST, not text: a channel named in a comment is trivia, and a
 * `'msg.payload'` inside a string is a literal — neither can count as a read,
 * and neither can a commented-out `validatePayload` count as validation.
 *
 * Two exits, both checked in below and both re-validated on every run so
 * neither can outlive its subject:
 *   - {@link INLINE_SAFE_PARSE}: a method that parses its payload with a Zod
 *     schema inline rather than through the helper.
 *   - {@link RAW_PAYLOAD_READS}: a method that reads a payload field before
 *     validating it for a stated reason.
 *
 * A method that never mentions `payload` needs no entry: it has nothing to
 * validate, and the gate says nothing about it.
 *
 * What it does not see: only calls on `this` reached from `handle` are
 * followed. A payload read in a module-level function, or in a method no route
 * reaches (a helper called from elsewhere, such as a rerun path), is outside
 * its reach, so code written that way is held by review, not by this gate.
 */

const SRC_ROOT = join(__dirname, '..');
const HANDLERS_ROOT = join(SRC_ROOT, 'bridge', 'handlers');

/** `<file>#<Class>.<method>` — the site format every list below uses. */
type Site = string;

/**
 * Methods that parse their own payload with a Zod schema instead of calling
 * `validatePayload`. Both answer the sender; neither reads a field first.
 */
const INLINE_SAFE_PARSE: readonly Site[] = [
  'bridge/handlers/FileHandler.ts#FileHandler.handleSave',
];

/**
 * Methods that read a payload field before it is validated, each with the
 * reason. An entry is a reviewed edit, never a way to silence a new route.
 */
const RAW_PAYLOAD_READS: readonly { site: Site; reason: string }[] = [
  {
    site: 'bridge/handlers/ReportsHandler.ts#ReportsHandler.readLimit',
    reason: 'Reads one optional number and falls back unless it is a usable count.',
  },
];

/**
 * Minimum size of the scan, so a renamed helper, a restructured switch or a
 * moved directory fails here rather than passing on an empty read. 227 methods
 * reachable from a route, 88 of them validating, when the gate was written.
 */
const MIN_SCANNED_METHODS = 180;
const MIN_VALIDATED_METHODS = 70;

/** Every `.ts` file under a directory, tests excluded. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (entry.endsWith('.ts') && !entry.includes('.test.')) acc.push(full);
  }
  return acc;
}

const relPath = (file: string): string => relative(SRC_ROOT, file).split(/[\\/]/).join('/');

/** Result of reading one handler method. */
interface MethodFacts {
  site: Site;
  /** Channels that reach this method, through `handle`. */
  channels: string[];
  /** Position of the first `validatePayload(` call, or -1. */
  validatedAt: number;
  /** Position of the first payload read (dot, bracket or destructuring), or -1. */
  payloadReadAt: number;
  /** Line of the first payload read, for the failure message. */
  line: number;
}

/** `<Class>.<method>` for a method declaration. */
function methodSite(file: string, method: ts.MethodDeclaration): string {
  const owner = method.parent;
  const className = ts.isClassLike(owner) && owner.name ? `${owner.name.text}.` : '';
  return `${relPath(file)}#${className}${method.name.getText()}`;
}

/** `domain:action` shape, so prose and payload strings are not read as channels. */
const CHANNEL_SHAPE = /^[a-z][a-z0-9-]*(?::[a-z0-9-]+)+$/;

/**
 * Read one source file: which methods a routed message reaches through
 * `handle`, and whether each validates before it reads.
 *
 * Two routing shapes are in use and both are read: a `switch` over `msg.type`,
 * where the channel is the `case` literal, and a `TYPES.has(msg.type)` guard
 * followed by a single call, where the channels are the ones the module's
 * `new Set([...])` table names. Delegation inside the class is followed to the
 * end — `ReportsHandler.handleList` reads its payload one call deeper, in
 * `readLimit`, and a gate that stopped at the first level would never see it.
 */
function readFacts(file: string, text: string): Map<string, MethodFacts> {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const byName = new Map<string, ts.MethodDeclaration>();
  const facts = new Map<string, MethodFacts>();

  const collect = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && node.name && node.body) {
      byName.set(node.name.getText(), node);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  /** Channels the module's `new Set([...])` route table names. */
  const tableChannels: string[] = [];
  const collectTable = (node: ts.Node): void => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Set'
    ) {
      const [arg] = node.arguments ?? [];
      if (arg && ts.isArrayLiteralExpression(arg)) {
        for (const element of arg.elements) {
          if (ts.isStringLiteral(element) && CHANNEL_SHAPE.test(element.text)) {
            tableChannels.push(element.text);
          }
        }
      }
    }
    ts.forEachChild(node, collectTable);
  };
  collectTable(sf);

  const factsFor = (method: ts.MethodDeclaration): MethodFacts => {
    const site = methodSite(file, method);
    const existing = facts.get(site);
    if (existing) return existing;
    let validatedAt = -1;
    let payloadReadAt = -1;
    let line = 0;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'validatePayload' &&
        (validatedAt === -1 || node.getStart() < validatedAt)
      ) {
        validatedAt = node.getStart();
      }
      // `msg.payload`, `msg['payload']` and `const { payload } = msg` all
      // reach the same fields.
      const readsPayload =
        (ts.isPropertyAccessExpression(node) && node.name.text === 'payload') ||
        (ts.isElementAccessExpression(node) &&
          ts.isStringLiteralLike(node.argumentExpression) &&
          node.argumentExpression.text === 'payload') ||
        (ts.isBindingElement(node) &&
          ts.isObjectBindingPattern(node.parent) &&
          (node.propertyName ?? node.name).getText() === 'payload');
      if (readsPayload && (payloadReadAt === -1 || node.getStart() < payloadReadAt)) {
        payloadReadAt = node.getStart();
        line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      }
      ts.forEachChild(node, visit);
    };
    if (method.body) visit(method.body);
    const fresh: MethodFacts = { site, channels: [], validatedAt, payloadReadAt, line };
    facts.set(site, fresh);
    return fresh;
  };

  /** Record `method` and everything it calls on `this`, under `channels`. */
  const walk = (method: ts.MethodDeclaration, channels: string[], seen: Set<string>): void => {
    const site = methodSite(file, method);
    if (seen.has(site)) return;
    seen.add(site);
    const entry = factsFor(method);
    for (const channel of channels) {
      if (!entry.channels.includes(channel)) entry.channels.push(channel);
    }
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        const target = byName.get(node.expression.name.text);
        if (target) walk(target, channels, seen);
      }
      ts.forEachChild(node, visit);
    };
    if (method.body) visit(method.body);
  };

  const handle = byName.get('handle');
  if (!handle?.body) return facts;

  /** Methods a `case` delegates to, keyed by the case's channel. */
  const routedFromCase = new Set<string>();
  const collectCases = (node: ts.Node): void => {
    if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression)) {
      const channel = node.expression.text;
      const visitCall = (inner: ts.Node): void => {
        if (
          ts.isCallExpression(inner) &&
          ts.isPropertyAccessExpression(inner.expression) &&
          inner.expression.expression.kind === ts.SyntaxKind.ThisKeyword
        ) {
          const target = byName.get(inner.expression.name.text);
          if (target) {
            routedFromCase.add(inner.expression.name.text);
            walk(target, [channel], new Set());
          }
        }
        ts.forEachChild(inner, visitCall);
      };
      node.statements.forEach(visitCall);
    }
    ts.forEachChild(node, collectCases);
  };
  collectCases(handle.body);

  // The guard-then-call shape: whatever `handle` calls outside a `case` answers
  // every channel the route table names.
  const visitDirect = (node: ts.Node): void => {
    if (ts.isCaseClause(node)) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      const name = node.expression.name.text;
      const target = byName.get(name);
      if (target && !routedFromCase.has(name)) walk(target, tableChannels, new Set());
    }
    ts.forEachChild(node, visitDirect);
  };
  visitDirect(handle.body);

  // `handle` itself may read the payload before delegating, in a `case` as much
  // as before the switch, so it answers every channel either shape names.
  const caseChannels: string[] = [];
  const collectCaseChannels = (node: ts.Node): void => {
    if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression)) {
      caseChannels.push(node.expression.text);
    }
    ts.forEachChild(node, collectCaseChannels);
  };
  collectCaseChannels(handle.body);
  walk(
    handle,
    [...new Set([...tableChannels, ...caseChannels])],
    new Set(
      [...byName.keys()].filter((n) => n !== 'handle').map((n) => methodSite(file, byName.get(n)!)),
    ),
  );

  return facts;
}

/** Read the whole handler tree, with optional in-memory replacements. */
function scan(overrides: Readonly<Record<string, string>> = {}): MethodFacts[] {
  const out: MethodFacts[] = [];
  for (const file of sourceFiles(HANDLERS_ROOT)) {
    const text = overrides[relPath(file)] ?? readFileSync(file, 'utf8');
    out.push(...readFacts(file, text).values());
  }
  return out;
}

/** Methods that answer a channel and reach for a payload they did not validate. */
function violations(methods: MethodFacts[]): string[] {
  const allowed = new Set<string>([...INLINE_SAFE_PARSE, ...RAW_PAYLOAD_READS.map((e) => e.site)]);
  return methods
    .filter((m) => m.channels.length > 0 && m.payloadReadAt !== -1 && !allowed.has(m.site))
    .filter((m) => m.validatedAt === -1 || m.validatedAt > m.payloadReadAt)
    .map(
      (m) =>
        `${m.site}:${m.line} answers ${m.channels.join(', ')} and reads payload ` +
        `${m.validatedAt === -1 ? 'without validatePayload' : 'before validatePayload'}`,
    );
}

describe('payload validation coverage', () => {
  const methods = scan();
  const routed = methods.filter((m) => m.channels.length > 0);

  it('reads the handler tree at non-trivial size (AST sanity guard)', () => {
    // A renamed helper, a restructured switch or a moved handlers directory
    // must fail here rather than pass vacuously on an empty scan.
    expect(routed.length).toBeGreaterThanOrEqual(MIN_SCANNED_METHODS);
    expect(routed.filter((m) => m.validatedAt !== -1).length).toBeGreaterThanOrEqual(
      MIN_VALIDATED_METHODS,
    );
  });

  it('every routed handler method validates its payload before reading it', () => {
    expect(violations(methods)).toEqual([]);
  });

  it('fails on a handler that reads a payload field it never validated', () => {
    // A probe, not the tree: the real handlers all validate, so only a
    // synthetic file can show the gate would see one that does not.
    const probe = `
      export class ProbeHandler {
        async handle(msg: InboundRequest): Promise<boolean> {
          switch (msg.type) {
            case 'probe:write':
              this.handleWrite(msg);
              return true;
            default:
              return false;
          }
        }
        private handleWrite(msg: InboundRequest): void {
          this.deps.log(String(msg.payload));
        }
      }
    `;
    const found = violations([
      ...readFacts(join(HANDLERS_ROOT, 'ProbeHandler.ts'), probe).values(),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('probe:write');
  });

  it('counts a destructured or bracketed payload as a read', () => {
    // `const { payload } = msg` and `msg['payload']` reach the same fields as
    // `msg.payload`; a gate that only saw the dot form would pass both.
    const probe = `
      export class ProbeHandler {
        async handle(msg: InboundRequest): Promise<boolean> {
          switch (msg.type) {
            case 'probe:destructure':
              this.handleDestructure(msg);
              return true;
            case 'probe:bracket':
              this.handleBracket(msg);
              return true;
            default:
              return false;
          }
        }
        private handleDestructure(msg: InboundRequest): void {
          const { payload } = msg;
          this.deps.log(String(payload));
        }
        private handleBracket(msg: InboundRequest): void {
          this.deps.log(String(msg['payload']));
        }
      }
    `;
    const found = violations([
      ...readFacts(join(HANDLERS_ROOT, 'ProbeHandler.ts'), probe).values(),
    ]);
    expect(found).toHaveLength(2);
    expect(found.join('\n')).toContain('probe:destructure');
    expect(found.join('\n')).toContain('probe:bracket');
  });

  it('sees a payload read inline in a case of a handler with no route table', () => {
    // Without a `new Set([...])` table, `handle` was walked under no channel
    // at all, so a read written straight into a `case` passed unseen.
    const probe = `
      export class ProbeHandler {
        async handle(msg: InboundRequest): Promise<boolean> {
          switch (msg.type) {
            case 'probe:inline':
              this.deps.log(String(msg.payload));
              return true;
            default:
              return false;
          }
        }
      }
    `;
    const found = violations([
      ...readFacts(join(HANDLERS_ROOT, 'ProbeHandler.ts'), probe).values(),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('probe:inline');
  });

  it('fails when a validated method loses its validatePayload call', () => {
    // The mutation the gate exists for: SettingsHandler.handleSettingsUpdate
    // writes a setting from `payload.key`. Without the call it writes whatever
    // the message carried.
    const target = 'bridge/handlers/SettingsHandler.ts';
    const original = readFileSync(
      join(SRC_ROOT, 'bridge', 'handlers', 'SettingsHandler.ts'),
      'utf8',
    );
    const mutated = original.replace(
      /const parsed = validatePayload\(\s*settingsUpdatePayloadSchema[\s\S]*?\);/,
      'const parsed = msg.payload as { key: string; value: unknown };',
    );
    expect(mutated).not.toBe(original);

    const found = violations(scan({ [target]: mutated })).filter((f) => f.startsWith(target));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('settings:update');
  });

  it('keeps both exit lists honest', () => {
    // An entry whose method has gained a validatePayload call, or whose method
    // no longer exists, must leave the list instead of sitting here masking
    // the next unvalidated route.
    const bySite = new Map(methods.map((m) => [m.site, m]));
    const stale: string[] = [];
    for (const site of [...INLINE_SAFE_PARSE, ...RAW_PAYLOAD_READS.map((e) => e.site)]) {
      const method = bySite.get(site);
      if (!method) stale.push(`${site} — no such handler method`);
      else if (method.payloadReadAt === -1) stale.push(`${site} — reads no payload`);
      else if (method.validatedAt !== -1 && method.validatedAt < method.payloadReadAt) {
        stale.push(`${site} — validates its payload now`);
      }
    }
    expect(stale).toEqual([]);
  });
});
