import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

/**
 * Sent-channel guard.
 *
 * The extension side has `emittedChannels.test.ts`, which checks that every
 * channel the extension EMITS is declared. Nothing checked the other
 * direction, so a page could send a message type that exists nowhere.
 *
 * That is not a soft failure. `BridgeMessageSchema` is a Zod
 * `discriminatedUnion('type', …)`, and MessageBroker.dispatch rejects anything
 * that does not parse — the message never reaches a handler at all. The
 * DataOps backup list shipped that way: the query fired on mount, was dropped
 * at the bridge, left the list permanently empty, and 30 s later timed out
 * into a red error banner.
 *
 * A declared channel is only half the contract, so this file checks two
 * things:
 *   (a) every channel literal the webview names is declared in the shared
 *       schema — requests, and the `responseType` / `errorType` / listener
 *       channels it waits on, which drift just as silently;
 *   (b) every request it sends is bound to a handler in ExtensionHandlers.
 *       An undeclared channel dies at the broker; an unrouted one dies one
 *       step later, in the router. Both look identical from the page: a
 *       spinner that runs for 30 s and then turns red.
 */

const SRC = join(__dirname, '..');
const SCHEMAS = join(__dirname, '../../../shared/src/bridge/messageSchemas.ts');
const EXTENSION_HANDLERS = join(__dirname, '../../../extension/src/bridge/ExtensionHandlers.ts');

/**
 * Channels a page sends that are knowingly unimplemented.
 *
 * Empty, and meant to stay that way: `reports:list` / `reports:export` used to
 * sit here while ReportsPage fired them into a broker that had nothing to
 * dispatch them to. The page is presentational now, so the guard is absolute
 * again. An entry added here is debt with a name, not a waiver.
 */
const KNOWN_UNIMPLEMENTED = new Set<string>();

/**
 * Optional generic argument between a helper's name and its call parens.
 *
 * Must span nesting: a `[^>]*` segment stops at the first `>`, so
 * `useBridgeMutation<{ fields: Array<Info> }>('x')` matches nothing at all and
 * the channel is invisible to both assertions below — nine call sites were
 * hidden exactly that way. The bounded lazy form crosses the inner `>` without
 * letting a runaway match swallow the rest of the file.
 */
const GENERIC = '(?:<[\\s\\S]{0,200}?>)?';

/** Call shapes that send a request to the extension. */
const REQUEST_PATTERNS = [
  new RegExp(`useBridgeQuery${GENERIC}\\(\\s*'([a-z0-9:-]+)'`, 'g'),
  new RegExp(`useBridgeMutation${GENERIC}\\(\\s*'([a-z0-9:-]+)'`, 'g'),
  new RegExp(`sendBridgeMessage${GENERIC}\\(\\s*'([a-z0-9:-]+)'`, 'g'),
  new RegExp(`buildMessage${GENERIC}\\(\\s*'([a-z0-9:-]+)'`, 'g'),
];

/**
 * Shapes that name a channel the webview only listens on — push channels and
 * the two reply overrides. `useBridgeQuery`/`useBridgeMutation` derive
 * `<request>:response` and `<domain>:error` when these are omitted, so an
 * override is a deliberate departure from the convention and the likeliest
 * place for a typo to hide.
 */
const INBOUND_PATTERNS = [
  new RegExp(`useMessageListener${GENERIC}\\(\\s*'([a-z0-9:-]+)'`, 'g'),
  /responseType:\s*'([a-z0-9:-]+)'/g,
  /errorType:\s*'([a-z0-9:-]+)'/g,
];

/** Suffixes that mark a channel as a reply rather than a request. */
const REPLY_SUFFIX = /:(response|result|error|progress)$/;

/** Every `msg('...')` literal declared in the shared schema file. */
function declaredChannels(): Set<string> {
  const src = readFileSync(SCHEMAS, 'utf8');
  return new Set(Array.from(src.matchAll(/msg\('([^']+)'\)/g)).map((m) => m[1]));
}

/**
 * Every non-test source file under the webview src tree.
 *
 * E2EHarness is skipped: it mounts only under `?e2e-harness=<flow>` and talks
 * to Playwright's MockBridge, so its channels are a spec fixture rather than a
 * contract with the extension host.
 */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'E2EHarness') continue;
      sourceFiles(full, acc);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) acc.push(full);
  }
  return acc;
}

/** Channel literals matching `patterns`, mapped to the file that first names them. */
function scan(patterns: RegExp[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      for (const match of Array.from(src.matchAll(pattern))) {
        if (!found.has(match[1])) found.set(match[1], file.slice(SRC.length + 1));
      }
    }
  }
  return found;
}

/** Request channels the webview sends. */
function sentChannels(): Map<string, string> {
  return scan(REQUEST_PATTERNS);
}

/** Every channel literal the webview names, in either direction. */
function namedChannels(): Map<string, string> {
  return scan([...REQUEST_PATTERNS, ...INBOUND_PATTERNS]);
}

/**
 * The channels `ExtensionHandlers.registerAll` binds, read out of its
 * `route([...])` groups and its two inline `router.route('x', …)` calls.
 *
 * Read as text rather than imported: pulling the module in would drag the whole
 * extension-host graph (vscode, jsforce) into a jsdom run. The extension's own
 * `handlerRouting.test.ts` scans the same call shape, so the two guards agree
 * on what "routed" means and a change to one is visible to the other.
 */
function routedChannels(): Set<string> {
  const src = readFileSync(EXTENSION_HANDLERS, 'utf8');
  const routed = new Set<string>();
  for (const group of Array.from(src.matchAll(/\broute\(\s*\[([\s\S]*?)\]/g))) {
    for (const literal of Array.from(group[1].matchAll(/'([^']+)'/g))) routed.add(literal[1]);
  }
  for (const single of Array.from(src.matchAll(/\brouter\.route\(\s*'([^']+)'/g))) {
    routed.add(single[1]);
  }
  return routed;
}

describe('webview sent channels', () => {
  it('finds the declarations and call sites it is meant to guard', () => {
    // Guards the guard: any regex matching nothing would pass vacuously.
    expect(declaredChannels().size).toBeGreaterThan(200);
    expect(sentChannels().size).toBeGreaterThan(50);
    expect(namedChannels().size).toBeGreaterThan(sentChannels().size);
    expect(routedChannels().size).toBeGreaterThan(150);
  });

  it('only names message types the shared protocol declares', () => {
    const declared = declaredChannels();
    const undeclared: string[] = [];

    for (const [channel, file] of Array.from(namedChannels())) {
      if (declared.has(channel) || KNOWN_UNIMPLEMENTED.has(channel)) continue;
      undeclared.push(`${channel} (${file})`);
    }

    expect(undeclared).toEqual([]);
  });

  it('only sends requests ExtensionHandlers routes to a handler', () => {
    const routed = routedChannels();
    const unrouted: string[] = [];

    for (const [channel, file] of Array.from(sentChannels())) {
      // Replies are inbound; they are answered, not routed.
      if (REPLY_SUFFIX.test(channel)) continue;
      // The sidebar posts raw to SidebarViewProvider, bypassing the broker and
      // the router entirely — a separate contract, not a missing route.
      if (channel.startsWith('sidebar:')) continue;
      if (routed.has(channel) || KNOWN_UNIMPLEMENTED.has(channel)) continue;
      unrouted.push(`${channel} (${file})`);
    }

    expect(unrouted).toEqual([]);
  });

  it('keeps the known-unimplemented list honest', () => {
    // If one of these gains a declaration, it should leave the list rather
    // than sit here masking a future regression.
    const declared = declaredChannels();
    const nowDeclared = Array.from(KNOWN_UNIMPLEMENTED).filter((c) => declared.has(c));

    expect(nowDeclared).toEqual([]);
  });
});
