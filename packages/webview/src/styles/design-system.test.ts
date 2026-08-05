import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Token gate: every `var(--sf-*)` consumed anywhere under src/ must be
 * defined in design-system.css. Guards against ghost tokens (used but
 * never defined), which silently fall back to hardcoded hex values.
 */

const SRC_ROOT = path.resolve(__dirname, '..');
const DESIGN_SYSTEM_PATH = path.join(SRC_ROOT, 'styles', 'design-system.css');

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx|css)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function definedTokens(): Set<string> {
  const css = fs.readFileSync(DESIGN_SYSTEM_PATH, 'utf8');
  return new Set([...css.matchAll(/(--sf-[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]));
}

describe('design-system tokens', () => {
  it('defines every var(--sf-*) token used under src/', () => {
    const defined = definedTokens();
    const ghosts: string[] = [];
    for (const file of collectSourceFiles(SRC_ROOT)) {
      // This test file mentions the pattern only as a regex — skip itself.
      if (file === __filename) continue;
      const content = fs.readFileSync(file, 'utf8');
      for (const match of content.matchAll(/var\((--sf-[a-zA-Z0-9-]+)/g)) {
        if (!defined.has(match[1])) {
          ghosts.push(`${match[1]} (${path.relative(SRC_ROOT, file)})`);
        }
      }
    }
    expect(ghosts).toEqual([]);
  });
});
