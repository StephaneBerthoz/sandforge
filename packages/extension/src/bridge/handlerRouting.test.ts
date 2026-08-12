import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

/**
 * Routing-completeness guard.
 *
 * Every domain handler declares the message types it accepts in a private
 * `const <DOMAIN>_TYPES = new Set([...])`, and `ExtensionHandlers.registerAll`
 * separately lists the types it wires onto the router. Nothing tied the two
 * together, so a type could be implemented, unit-tested and still unreachable:
 * `org:select` shipped that way — handled in OrgHandler, covered by three
 * passing tests, and absent from the `route([...])` call, so every message the
 * webview sent hit the router's unknown-type path.
 *
 * This is a source-level check on purpose. Asserting through a constructed
 * ExtensionHandlers would need the full dependency graph mocked, and the thing
 * being verified is a static list — the declaration is the contract.
 */

const BRIDGE_DIR = join(__dirname);
const HANDLERS_DIR = join(__dirname, 'handlers');

/** Pull every message-type string literal out of a bracketed source block. */
function extractLiterals(block: string): string[] {
  return Array.from(block.matchAll(/['"]([a-z0-9-]+:[a-z0-9:-]+)['"]/gi)).map((m) => m[1]);
}

/** Message types wired onto the router by ExtensionHandlers.registerAll. */
function routedTypes(): Set<string> {
  const src = readFileSync(join(BRIDGE_DIR, 'ExtensionHandlers.ts'), 'utf8');
  const routed = new Set<string>();
  for (const match of Array.from(src.matchAll(/route\(\s*\[([\s\S]*?)\]/g))) {
    for (const type of extractLiterals(match[1])) routed.add(type);
  }
  return routed;
}

/** Message types each handler declares it accepts, keyed by file name. */
function declaredTypes(): Map<string, string[]> {
  const declared = new Map<string, string[]>();
  for (const file of readdirSync(HANDLERS_DIR)) {
    if (!file.endsWith('.ts') || file.includes('.test.')) continue;
    const src = readFileSync(join(HANDLERS_DIR, file), 'utf8');
    const sets = src.matchAll(/const\s+\w*_TYPES\s*=\s*new Set\(\s*\[([\s\S]*?)\]\s*\)/g);
    for (const match of Array.from(sets)) {
      const types = extractLiterals(match[1]);
      if (types.length > 0) declared.set(file, [...(declared.get(file) ?? []), ...types]);
    }
  }
  return declared;
}

describe('handler routing completeness', () => {
  it('finds the declarations it is meant to guard', () => {
    // Guards the guard: a regex that silently matched nothing would make every
    // assertion below vacuously pass.
    expect(declaredTypes().size).toBeGreaterThan(15);
    expect(routedTypes().size).toBeGreaterThan(50);
  });

  it('routes every message type its handlers declare', () => {
    const routed = routedTypes();
    const unreachable: string[] = [];

    for (const [file, types] of Array.from(declaredTypes())) {
      for (const type of types) {
        if (!routed.has(type)) unreachable.push(`${type} (declared in ${file})`);
      }
    }

    expect(unreachable).toEqual([]);
  });

  it('routes no message type that no handler declares', () => {
    const allDeclared = new Set(Array.from(declaredTypes().values()).flat());
    // NoOpHandler intentionally absorbs types with no domain handler; its own
    // set is included above, so anything left over is a genuine orphan route.
    const orphans = Array.from(routedTypes()).filter((t) => !allDeclared.has(t));

    expect(orphans).toEqual([]);
  });
});
