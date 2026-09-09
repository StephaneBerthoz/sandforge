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
 * Consumption-side anti-drift test — the third face of the protocol guard.
 *
 * coverage.test.ts pins *declared TS interfaces* ↔ *Zod msg() literals*.
 * emittedChannels.test.ts pins *what the extension posts* → *declared*.
 * sentChannels.test.ts (webview) pins *what a page sends* → *declared*.
 * Nothing pinned the last edge: an inbound channel the extension **registers a
 * handler for** that no webview code ever sends. Those cost a route line, a
 * `msg()` member, a TS interface and a handler branch, and they read as live
 * surface to anyone grepping the registry — the Forge recipe library and the
 * whole `sync:config:*` quartet were carried that way for releases.
 *
 * The guard extracts the registry from the `ROUTED_CHANNELS` table that
 * `ExtensionHandlers.registerAll` binds from, and the senders from the webview
 * production tree, then fails on any registered channel with no sender, minus
 * an explicit {@link KNOWN_UNSENT} allowlist.
 *
 * Sender idioms (all six are in production use — restricting the scan to the
 * four canonical ones reports a dozen live channels as dead):
 *   1. `useBridgeQuery<T>('<channel>')` / `useBridgeMutation<T>('<channel>')`
 *   2. `sendBridgeMessage('<channel>', payload)`
 *   3. `sendMessage(buildMessage('<channel>'))`
 *   4. domain wrappers over 1 — `useFrozenMutation('frozen:select')`, and any
 *      future `use<Domain>Query` / `use<Domain>Mutation` thin alias
 *   5. `postExtensionMessage('<channel>', payload)` (E2E harness transport)
 *   6. hand-built envelopes — `sendMessage({ type: '<channel>', … })`
 *
 * Idioms 1-5 are read by scanning the *first argument* of the call rather than
 * the character right after `(`, so the ternary form
 * `sendBridgeMessage(next ? 'forge:pause' : 'forge:resume')` counts both arms.
 *
 * Deliberate exclusions:
 *   - `*.test.*` files, so a channel kept alive only by its own test is dead.
 *   - Import-graph reachability: a sender inside a never-rendered (orphan)
 *     module still counts here. Orphan modules are DEADCODE-03's subject; this
 *     guard would otherwise fail for a reason it cannot explain.
 *
 * A second guard lives at the bottom of this file, running the opposite way:
 * every channel the webview *names* must be declared. See KNOWN_CONSUMED_GAPS.
 */

/** Opening of a `route(<channels>, handler)` registration in registerAll. */
const ROUTE_CALL_RE = /\broute\(/g;

/**
 * Captures the body of a hoisted `ROUTED_CHANNELS` route table, when one
 * exists.
 *
 * The channel lists have lived both inline in `registerAll` and hoisted into a
 * `const` beside it. Reading both shapes costs one regex and means a future
 * hoist cannot quietly reduce this guard to an empty extraction — the failure
 * mode is silent, since every downstream assertion passes on an empty set.
 */
const ROUTED_TABLE_RE = /\bconst ROUTED_CHANNELS(?::[^=]+)? = \{([\s\S]*?)\n\} as const/;

/** Matches any quoted literal inside a captured block. */
const LITERAL_RE = /'([^']*)'/g;

/** Opening of a sender call — idioms 1-5, generics optional. */
const SENDER_CALL_RE =
  /\b(?:sendBridgeMessage|buildMessage|postExtensionMessage|use[A-Z]\w*(?:Query|Mutation))\s*(?:<[\s\S]*?>\s*)?\(/g;

/** Idiom 6: the `type:` field of a hand-built message envelope. */
const TYPE_FIELD_RE = /\btype:\s*'([^']+)'/g;

/** `domain:action` shape — filters payload strings out of the same call. */
const CHANNEL_SHAPE_RE = /^[a-z][a-z0-9-]*(?::[a-z0-9-]+)+$/;

/**
 * Registered channels with no webview sender, kept declared on purpose.
 *
 * Every entry is a real debt, not an exemption: the route, the `msg()` member,
 * the TS interface and the handler branch all ship for a message nothing can
 * send. Shrink this list by deleting the four together (coverage.test.ts keeps
 * the Zod ↔ TS halves honest); never grow it to silence a new dead route.
 */
export const KNOWN_UNSENT: ReadonlyArray<{ channel: string; reason: string }> = [
  { channel: 'onboarding:reset', reason: 'Host command with no Settings control to trigger it.' },
  { channel: 'hint:dismiss', reason: 'HintTracker persists dismissals the UI never reports.' },
  { channel: 'seed:template:save', reason: 'Seed template UI reads (list/load) but never writes.' },
  { channel: 'seed:template:delete', reason: 'Same unwired half of the seed template CRUD.' },
  { channel: 'sync:config:save', reason: 'Sync config persistence UI was never built.' },
  { channel: 'sync:config:load', reason: 'Same quartet — no page loads a saved sync config.' },
  { channel: 'sync:config:list', reason: 'Same quartet — no saved-config picker exists.' },
  { channel: 'sync:config:delete', reason: 'Same quartet — nothing can delete a saved config.' },
  { channel: 'monitor:start', reason: 'MonitorPage polls via monitor:refresh only.' },
  { channel: 'governance:policy:get', reason: 'The policy editor loads from the list response.' },
  { channel: 'governance:policies:export', reason: 'No export control on the governance page.' },
  { channel: 'governance:policies:import', reason: 'No import control on the governance page.' },
  { channel: 'compare:start', reason: 'ComparePage runs everything through compare:execute.' },
  { channel: 'dataops:backup', reason: 'Legacy alias of backup:execute, which is what UI sends.' },
  {
    channel: 'dataops:masking-templates-by-object',
    reason: 'Per-object lookup never wired; the UI sends dataops:anonymization-templates.',
  },
  { channel: 'pipeline:run', reason: 'Legacy alias of pipeline:execute, which is what UI sends.' },
  { channel: 'ai:approve-action', reason: 'Diagnose ships without its human-approval step.' },
  { channel: 'forge:templates:list', reason: 'The Forge recipe library UI was never built.' },
  { channel: 'forge:templates:save', reason: 'Same recipe library slice.' },
  { channel: 'forge:templates:delete', reason: 'Same recipe library slice.' },
  { channel: 'forge:target-preflight:request', reason: 'Forge v2 preflight panel not built.' },
  { channel: 'cache:get-stats', reason: 'The Settings cache section was removed; nothing reads.' },
  { channel: 'cache:invalidate-all', reason: 'Same removed section — nothing clears the cache.' },
  {
    channel: 'monitor:health-score',
    reason: 'Home reads the score off monitor:data instead, at one round trip.',
  },
  { channel: 'scheduler:list', reason: 'SchedulerPanel was removed; no UI enumerates schedules.' },
  { channel: 'scheduler:upsert', reason: 'Same panel — nothing creates or edits a schedule.' },
  { channel: 'scheduler:delete', reason: 'Same panel — nothing deletes a schedule.' },
  { channel: 'scheduler:toggle', reason: 'Same panel — nothing enables or pauses a schedule.' },
  { channel: 'execution:status', reason: 'useRetryManager sends abort and manual-retry only.' },
  { channel: 'execution:list', reason: 'Same — no page enumerates running executions.' },
  { channel: 'realtime:status', reason: 'CDC stores send start/stop/metrics; status is unused.' },
];

function repoPath(...parts: string[]): string {
  // types/messages -> types -> src -> shared -> packages
  return join(__dirname, '..', '..', '..', '..', ...parts);
}

/** Every inbound channel `ExtensionHandlers.registerAll` registers a route for. */
function readRegisteredChannels(): Set<string> {
  const src = readFileSync(repoPath('extension', 'src', 'bridge', 'ExtensionHandlers.ts'), 'utf8');
  const registered = new Set<string>();
  // Shape-filtered throughout: both forms carry doc comments between groups,
  // and a stray apostrophe in prose would otherwise register as a channel.
  const collect = (block: string): void => {
    for (const literal of block.matchAll(LITERAL_RE)) {
      if (CHANNEL_SHAPE_RE.test(literal[1])) registered.add(literal[1]);
    }
  };
  for (const call of src.matchAll(ROUTE_CALL_RE)) {
    collect(firstArgument(src, call.index + call[0].length));
  }
  const table = ROUTED_TABLE_RE.exec(src);
  if (table) collect(table[1]);
  return registered;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\./.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Slice of source starting at `from` and ending at the first top-level `,` or
 * closing bracket — i.e. the text of the call's first argument.
 */
function firstArgument(src: string, from: number): string {
  let depth = 0;
  let end = from;
  for (; end < src.length; end++) {
    const char = src[end];
    if (char === '(' || char === '[' || char === '{') depth++;
    else if (char === ')' || char === ']' || char === '}') {
      if (depth === 0) break;
      depth--;
    } else if (char === ',' && depth === 0) break;
  }
  return src.slice(from, end);
}

/** All channel literals the webview production tree sends, mapped to origins. */
function readSentChannels(): Map<string, string[]> {
  const sent = new Map<string, string[]>();
  const record = (channel: string, file: string): void => {
    if (!CHANNEL_SHAPE_RE.test(channel)) return;
    const origins = sent.get(channel) ?? [];
    if (!origins.includes(file)) origins.push(file);
    sent.set(channel, origins);
  };
  for (const file of walk(repoPath('webview', 'src'))) {
    const src = readFileSync(file, 'utf8');
    for (const call of src.matchAll(SENDER_CALL_RE)) {
      const arg = firstArgument(src, call.index + call[0].length);
      for (const literal of arg.matchAll(LITERAL_RE)) record(literal[1], file);
    }
    for (const field of src.matchAll(TYPE_FIELD_RE)) record(field[1], file);
  }
  return sent;
}

describe('consumed channels (consumption-side anti-drift)', () => {
  it('extracts both sides at non-trivial size (regex sanity guard)', () => {
    // 163 registered / 147 sent at introduction. A renamed helper or a
    // restructured registerAll must fail here rather than pass vacuously with
    // an empty extraction on either side.
    expect(readRegisteredChannels().size).toBeGreaterThanOrEqual(150);
    expect(readSentChannels().size).toBeGreaterThanOrEqual(120);
  });

  it('every registered inbound channel has a webview sender', () => {
    const sent = readSentChannels();
    const allowed = new Set(KNOWN_UNSENT.map((e) => e.channel));
    const dead = [...readRegisteredChannels()].filter((c) => !sent.has(c) && !allowed.has(c));
    expect(dead).toEqual([]);
  });

  it('keeps the known-unsent allowlist honest', () => {
    // An entry that gained a sender — or whose route was deleted — must leave
    // the list instead of sitting here masking the next dead route.
    const sent = readSentChannels();
    const registered = readRegisteredChannels();
    const stale = KNOWN_UNSENT.filter((e) => sent.has(e.channel) || !registered.has(e.channel)).map(
      (e) => e.channel,
    );
    expect(stale).toEqual([]);
  });
});

/**
 * Declaration guard — every channel the webview *names* must exist in the Zod
 * union, whichever direction it travels.
 *
 * The webview names channels in two directions, and both fail silently when
 * undeclared. Outbound, `BridgeMessageSchema` is a discriminatedUnion('type')
 * and MessageBroker.dispatch drops anything that does not parse, so the request
 * never reaches a handler. Inbound, an undeclared `responseType` is a reply no
 * emitter can legally produce — emittedChannels.test.ts proves every emitted
 * channel is declared — so the hook waits out its 30 s timeout and surfaces a
 * failure the user cannot act on. Both halves have shipped: ReportsPage fired
 * `reports:list` into a broker with nothing to dispatch it to, and MonitorPage's
 * cancel/pause/resume buttons awaited `operation:*:response` replies from a
 * handler that only raises a toast.
 *
 * Consumption idioms, all read as the call's *first argument* for the reason
 * given above, and additionally so that a nested generic
 * (`useBridgeMutation<Record<string, unknown>>('pipeline:execute')`) does not
 * swallow the channel behind it:
 *   1-5. the five sender idioms of {@link SENDER_CALL_RE}
 *   6.   `useMessageListener<T>('<channel>', handler)`
 *   7.   the `responseType:` / `errorType:` options of a bridge hook
 *
 * Hand-built `type: '<channel>'` envelopes are deliberately *not* read here:
 * that shape also matches local discriminated-union state that never touches
 * the bridge, and a false failure in a contract guard is worse than a gap.
 * The raw `sidebar:*` channels reach the host that way, and stay out of the
 * Zod union on purpose.
 *
 * Deliberate exclusions:
 *   - `*.test.*`, as above.
 *   - `pages/E2EHarness`: a fixture panel that drives seven channels retired
 *     from the protocol. It is a test rig, not shipped UI, and allowlisting its
 *     debris would bury any real entry in {@link KNOWN_CONSUMED_GAPS}.
 */

/** Matches `msg('x:y')` member declarations in bridge/messageSchemas.ts. */
const ZOD_MSG_RE = /msg\('([^']+)'\)/g;

/** Idiom 6: opening of an inbound listener registration, generics optional. */
const LISTENER_CALL_RE = /\buseMessageListener\s*(?:<[\s\S]*?>\s*)?\(/g;

/** Idiom 7: the reply channels a bridge hook resolves or rejects on. */
const RESPONSE_OPTION_RE = /\b(?:responseType|errorType):\s*'([^']+)'/g;

/**
 * Channels the webview names that the protocol does not declare.
 *
 * Empty, and worth the effort to keep that way. It last held the three
 * `operation:*:response` replies MonitorPage's cancel/pause/resume buttons
 * awaited from a handler that only raises a toast, and the `sync:preview` pair
 * behind a dry-run that was never built; the buttons are fire-and-forget now
 * and the dry-run hook is gone. An entry here is a page wired to a channel that
 * cannot answer it — debt with a name and a symptom, never a waiver.
 */
export const KNOWN_CONSUMED_GAPS: ReadonlyArray<{ channel: string; reason: string }> = [];

/** Every `msg()` literal in the discriminated union. */
function readDeclaredChannels(): Set<string> {
  const src = readFileSync(join(__dirname, '..', '..', 'bridge', 'messageSchemas.ts'), 'utf8');
  return new Set([...src.matchAll(ZOD_MSG_RE)].map((m) => m[1]));
}

/** {@link walk} over shipped UI only — the E2E fixture panel is not contract. */
function walkProduction(dir: string): string[] {
  const harness = join('pages', 'E2EHarness');
  return walk(dir).filter((file) => !file.includes(harness));
}

/**
 * Every channel literal the webview names, mapped to the files naming it.
 *
 * `inbound: false` drops idioms 6-7 and leaves only the sender idioms, which is
 * how the sanity test proves the inbound halves of the scan match something.
 */
function readConsumedChannels(inbound = true): Map<string, string[]> {
  const consumed = new Map<string, string[]>();
  const record = (channel: string, file: string): void => {
    if (!CHANNEL_SHAPE_RE.test(channel)) return;
    const origins = consumed.get(channel) ?? [];
    if (!origins.includes(file)) origins.push(file);
    consumed.set(channel, origins);
  };
  const calls = inbound ? [SENDER_CALL_RE, LISTENER_CALL_RE] : [SENDER_CALL_RE];
  for (const file of walkProduction(repoPath('webview', 'src'))) {
    const src = readFileSync(file, 'utf8');
    for (const re of calls) {
      for (const call of src.matchAll(re)) {
        const arg = firstArgument(src, call.index + call[0].length);
        for (const literal of arg.matchAll(LITERAL_RE)) record(literal[1], file);
      }
    }
    if (inbound) for (const option of src.matchAll(RESPONSE_OPTION_RE)) record(option[1], file);
  }
  return consumed;
}

describe('consumed channels (declaration guard)', () => {
  it('reads both sides at non-trivial size (regex sanity guard)', () => {
    // 366 declared / 212 consumed at introduction. A renamed bridge hook or a
    // restructured schema file must fail here rather than pass vacuously.
    expect(readDeclaredChannels().size).toBeGreaterThanOrEqual(300);
    expect(readConsumedChannels().size).toBeGreaterThanOrEqual(180);
  });

  it('reads the inbound idioms, not just the sender ones', () => {
    // Guards the guard. sentChannels.test.ts already covers the sender idioms,
    // so if LISTENER_CALL_RE or RESPONSE_OPTION_RE silently stopped matching,
    // every remaining assertion here would still pass while checking nothing
    // the webview package does not already check. Asserted as a count rather
    // than by naming channels: reply and broadcast types come and go, and a
    // sanity check that needs editing whenever a page is refactored gets
    // relaxed instead of investigated. 84 inbound-exclusive at introduction.
    const inboundExclusive = readConsumedChannels().size - readConsumedChannels(false).size;
    expect(inboundExclusive).toBeGreaterThanOrEqual(40);
  });

  it('every channel the webview names is declared in messageSchemas.ts', () => {
    const declared = readDeclaredChannels();
    const allowed = new Set(KNOWN_CONSUMED_GAPS.map((e) => e.channel));
    const undeclared: string[] = [];
    for (const [channel, origins] of readConsumedChannels()) {
      if (declared.has(channel) || allowed.has(channel)) continue;
      undeclared.push(`'${channel}' named in ${origins[0]}`);
    }
    expect(undeclared).toEqual([]);
  });

  it('keeps the known-gap allowlist honest', () => {
    // An entry that gained a declaration — or whose call site was deleted —
    // must leave the list rather than mask the next undeclared channel.
    const declared = readDeclaredChannels();
    const consumed = readConsumedChannels();
    const stale = KNOWN_CONSUMED_GAPS.filter(
      (e) => declared.has(e.channel) || !consumed.has(e.channel),
    ).map((e) => e.channel);
    expect(stale).toEqual([]);
  });
});
