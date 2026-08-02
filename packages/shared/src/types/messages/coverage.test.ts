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
});
