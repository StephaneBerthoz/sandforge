import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Token gate: every `var(--sf-*)` consumed anywhere under src/ — or by the
 * Tailwind theme, which mints utility classes from the same tokens — must be
 * defined in design-system.css. Guards against ghost tokens (used but never
 * defined), which silently fall back to hardcoded hex values.
 */

const SRC_ROOT = path.resolve(__dirname, '..');
const DESIGN_SYSTEM_PATH = path.join(SRC_ROOT, 'styles', 'design-system.css');
const TAILWIND_CONFIG_PATH = path.resolve(SRC_ROOT, '..', 'tailwind.config.ts');

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

/** Parse a `name: { key: 'value', … }` block out of the Tailwind config source. */
function tailwindBlock(name: string): Record<string, string> {
  const config = fs.readFileSync(TAILWIND_CONFIG_PATH, 'utf8');
  const block = new RegExp(`\\b${name}:\\s*\\{([^}]*)\\}`).exec(config);
  if (!block) return {};
  return Object.fromEntries(
    [...block[1].matchAll(/([A-Za-z][\w-]*):\s*'([^']*)'/g)].map((m) => [m[1], m[2]]),
  );
}

describe('design-system tokens', () => {
  it('defines every var(--sf-*) token used by src/ and the Tailwind theme', () => {
    const defined = definedTokens();
    const ghosts: string[] = [];
    for (const file of [...collectSourceFiles(SRC_ROOT), TAILWIND_CONFIG_PATH]) {
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

/**
 * Severity and state colours must resolve through the theme, not through a
 * fixed palette hue: a value baked into the config can only satisfy AA against
 * one background, and the webview is rendered on whichever theme the user picked.
 */
describe('theme-resolved colours', () => {
  it('exposes the four severities as tokens, not literals', () => {
    const status = tailwindBlock('status');
    const defined = definedTokens();

    for (const severity of ['error', 'warning', 'success', 'info']) {
      const value = status[severity];
      expect(value, `theme.extend.colors.status.${severity} is missing`).toBeDefined();
      const token = /^var\((--sf-[a-zA-Z0-9-]+)\)$/.exec(value);
      expect(token, `status.${severity} must be a bare var(--sf-*): got ${value}`).not.toBeNull();
      expect(defined.has(token![1]), `${token![1]} is not defined in design-system.css`).toBe(true);
    }
  });

  it('resolves the active border through the accent token', () => {
    const active = tailwindBlock('borderColor').active;
    expect(active, 'borderColor.active is missing').toBeDefined();
    expect(active).toContain('var(--sf-accent');
  });
});
