import { describe, it, expect } from 'vitest';

// The shared package has no @types/node dependency — declare the two Node
// builtins this structural test needs (vitest provides both at runtime).
declare const __dirname: string;
declare function require(id: string): unknown;

const { readFileSync, readdirSync } = require('node:fs') as {
  readFileSync(path: string, encoding: 'utf8'): string;
  readdirSync(path: string): string[];
};
const { join } = require('node:path') as { join(...parts: string[]): string };

/** Matches `export interface Foo extends BaseMessage { type: 'x:y';` declarations. */
const MESSAGE_IFACE_RE = /export interface (\w+) extends BaseMessage \{\s*type: '([^']+)'/g;

/** Matches `msg('x:y')` member declarations in bridge/messageSchemas.ts. */
const ZOD_MSG_RE = /msg\('([^']+)'\)/g;

/**
 * Known, deliberate gaps in the Zod ↔ TS contract, keyed by message literal.
 *
 * Empty today: every Zod `msg('...')` literal maps to a TS message interface
 * (member of a directional union) and vice versa. Add an entry ONLY when a
 * literal is provably live (grep-verified producer AND consumer) yet typing it
 * would be wrong — and always with a justification comment pointing at the
 * evidence. Prefer creating the interface (or purging the dead literal) over
 * growing this list.
 */
export const KNOWN_CONTRACT_GAPS: ReadonlyArray<{ literal: string; reason: string }> = [];

function readDomainSources(): Array<{ file: string; src: string }> {
  return readdirSync(__dirname)
    .filter((f) => f.endsWith('.messages.ts'))
    .map((file) => ({ file, src: readFileSync(join(__dirname, file), 'utf8') }));
}

function readUnionBlock(indexSrc: string, unionName: string): string {
  const match = new RegExp(`export type ${unionName} =([\\s\\S]*?);`).exec(indexSrc);
  if (!match) throw new Error(`Union ${unionName} not found in messages/index.ts`);
  return match[1];
}

function readZodLiterals(): string[] {
  // types/messages -> types -> src, then bridge/messageSchemas.ts
  const schemaSrc = readFileSync(join(__dirname, '..', '..', 'bridge', 'messageSchemas.ts'), 'utf8');
  return [...schemaSrc.matchAll(ZOD_MSG_RE)].map((m) => m[1]);
}

describe('messages coverage (anti-drift)', () => {
  it('every message interface belongs to at least one directional union', () => {
    const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8');
    const w2e = readUnionBlock(indexSrc, 'WebViewToExtensionMessage');
    const e2w = readUnionBlock(indexSrc, 'ExtensionToWebViewMessage');
    const orphans: string[] = [];
    for (const { file, src } of readDomainSources()) {
      for (const m of src.matchAll(MESSAGE_IFACE_RE)) {
        const [, iface, literal] = m;
        const inW2E = new RegExp(`\\b${iface}\\b`).test(w2e);
        const inE2W = new RegExp(`\\b${iface}\\b`).test(e2w);
        if (!inW2E && !inE2W) orphans.push(`${iface} (type '${literal}') in ${file}`);
      }
    }
    expect(orphans).toEqual([]);
  });

  it('type literals are unique across domain files', () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const { file, src } of readDomainSources()) {
      for (const m of src.matchAll(MESSAGE_IFACE_RE)) {
        const literal = m[2];
        const first = seen.get(literal);
        if (first) duplicates.push(`'${literal}' in ${first} and ${file}`);
        else seen.set(literal, file);
      }
    }
    expect(duplicates).toEqual([]);
  });

  it('every Zod msg() literal has a TS interface (union membership checked above)', () => {
    const tsLiterals = new Set<string>();
    for (const { src } of readDomainSources()) {
      for (const m of src.matchAll(MESSAGE_IFACE_RE)) tsLiterals.add(m[2]);
    }
    const whitelisted = new Set(KNOWN_CONTRACT_GAPS.map((g) => g.literal));
    const missing = readZodLiterals().filter((l) => !tsLiterals.has(l) && !whitelisted.has(l));
    expect(missing).toEqual([]);
  });

  it('every TS message literal has a Zod msg() member in messageSchemas.ts', () => {
    const zodLiterals = new Set(readZodLiterals());
    const whitelisted = new Set(KNOWN_CONTRACT_GAPS.map((g) => g.literal));
    const missing: string[] = [];
    for (const { file, src } of readDomainSources()) {
      for (const m of src.matchAll(MESSAGE_IFACE_RE)) {
        const literal = m[2];
        if (!zodLiterals.has(literal) && !whitelisted.has(literal)) {
          missing.push(`'${literal}' (${m[1]}) in ${file}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
