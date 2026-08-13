import { describe, it, expect } from 'vitest';

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
 *   2. `sendHandlerError(deps, '<context>', '<channel>', err)` — 3rd arg
 *   3. `validatePayload(schema, msg, '<channel>', deps)`       — 3rd arg
 *      (plus `parsePayload`, ForgeHandler's one-line alias of it)
 *   4. `broker.postToWebview({ ... type: '<channel>' ... })` and
 *      `panelManager.postToAllPanels({ ... type: '<channel>' ... })`
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

/**
 * Matches an *assignment* of `name` in an object literal (`name: (e) => …`),
 * never its declaration — an optional property is written `name?:`, which the
 * `\s*:` here cannot reach past the `?`.
 */
function assignmentRe(name: string): RegExp {
  return new RegExp(`\\b${name}\\s*:\\s*(?:\\(|async|function|this\\.|[A-Za-z_$])`);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** All channel literals emitted by extension sources, mapped to origin files. */
function readEmittedChannels(): Map<string, string[]> {
  // types/messages -> types -> src -> shared -> packages, then extension/src
  const extSrc = join(__dirname, '..', '..', '..', '..', 'extension', 'src');
  const emitted = new Map<string, string[]>();
  for (const file of walk(extSrc)) {
    const src = readFileSync(file, 'utf8');
    for (const re of EMISSION_PATTERNS) {
      for (const m of src.matchAll(re)) {
        const literal = m[1];
        const origins = emitted.get(literal) ?? [];
        origins.push(file);
        emitted.set(literal, origins);
      }
    }
  }
  return emitted;
}

function readZodLiterals(): Set<string> {
  // types/messages -> types -> src, then bridge/messageSchemas.ts
  const schemaSrc = readFileSync(
    join(__dirname, '..', '..', 'bridge', 'messageSchemas.ts'),
    'utf8',
  );
  return new Set([...schemaSrc.matchAll(ZOD_MSG_RE)].map((m) => m[1]));
}

function readTsLiterals(): Set<string> {
  const literals = new Set<string>();
  for (const file of readdirSync(__dirname)) {
    if (!file.endsWith('.messages.ts')) continue;
    const src = readFileSync(join(__dirname, file), 'utf8');
    for (const m of src.matchAll(MESSAGE_IFACE_RE)) literals.add(m[2]);
  }
  return literals;
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
    // types/messages -> types -> src -> shared -> packages, then extension/src
    const extSrc = join(__dirname, '..', '..', '..', '..', 'extension', 'src');
    const files = walk(extSrc).map((file) => ({ file, src: readFileSync(file, 'utf8') }));

    /** callback name -> channels it is the sole emission site of. */
    const byCallback = new Map<string, Set<string>>();
    for (const { src } of files) {
      for (const m of src.matchAll(CALLBACK_EMISSION_RE)) {
        const channels = byCallback.get(m[1]) ?? new Set<string>();
        channels.add(m[2]);
        byCallback.set(m[1], channels);
      }
    }

    // Sanity: the extraction must find the grappe trio, not pass vacuously.
    expect([...byCallback.keys()]).toContain('onGrappeEvent');

    const orphaned: string[] = [];
    for (const [callback, channels] of byCallback) {
      const re = assignmentRe(callback);
      if (!files.some(({ src }) => re.test(src))) {
        orphaned.push(`${callback} (never injected; would silence ${[...channels].join(', ')})`);
      }
    }
    expect(orphaned).toEqual([]);
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
