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
 */

const SRC = join(__dirname, '..');
const SCHEMAS = join(__dirname, '../../../shared/src/bridge/messageSchemas.ts');

/**
 * Channels a page sends that are knowingly unimplemented.
 *
 * Reports has no backend at all — no handler, no declared channel — and the
 * module is marked "coming soon" in the README and docs. Listing them here
 * keeps the debt visible instead of letting the guard be weakened.
 */
const KNOWN_UNIMPLEMENTED = new Set(['reports:list', 'reports:export']);

/** Every `msg('...')` literal declared in the shared schema file. */
function declaredChannels(): Set<string> {
  const src = readFileSync(SCHEMAS, 'utf8');
  return new Set(Array.from(src.matchAll(/msg\('([^']+)'\)/g)).map((m) => m[1]));
}

/** Every non-test source file under the webview src tree. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) acc.push(full);
  }
  return acc;
}

/** Request channels the webview sends, from the three call shapes in use. */
function sentChannels(): Map<string, string> {
  const sent = new Map<string, string>();
  const patterns = [
    /useBridgeQuery<[^>]*>\(\s*'([a-z0-9:-]+)'/g,
    /useBridgeMutation<[^>]*>\(\s*'([a-z0-9:-]+)'/g,
    /sendBridgeMessage<[^>]*>\(\s*'([a-z0-9:-]+)'/g,
    /buildMessage<[^>]*>\(\s*'([a-z0-9:-]+)'/g,
  ];
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      for (const match of Array.from(src.matchAll(pattern))) {
        if (!sent.has(match[1])) sent.set(match[1], file.slice(SRC.length + 1));
      }
    }
  }
  return sent;
}

describe('webview sent channels', () => {
  it('finds the declarations and call sites it is meant to guard', () => {
    // Guards the guard: either regex matching nothing would pass vacuously.
    expect(declaredChannels().size).toBeGreaterThan(200);
    expect(sentChannels().size).toBeGreaterThan(50);
  });

  it('only sends message types the shared protocol declares', () => {
    const declared = declaredChannels();
    const undeclared: string[] = [];

    for (const [channel, file] of Array.from(sentChannels())) {
      if (declared.has(channel) || KNOWN_UNIMPLEMENTED.has(channel)) continue;
      undeclared.push(`${channel} (${file})`);
    }

    expect(undeclared).toEqual([]);
  });

  it('keeps the known-unimplemented list honest', () => {
    // If one of these gains a declaration, it should leave the list rather
    // than sit here masking a future regression.
    const declared = declaredChannels();
    const nowDeclared = Array.from(KNOWN_UNIMPLEMENTED).filter((c) => declared.has(c));

    expect(nowDeclared).toEqual([]);
  });
});
