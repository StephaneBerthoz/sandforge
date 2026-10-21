import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as zod from 'zod';
import * as viaWrapper from './zodJitless';

const ROOT = resolve(__dirname, '..');

type Alias = { find: string | RegExp; replacement: string };

/** The aliases a Vite config file resolves with, for `mode`. */
async function aliasesOf(file: string, mode: string): Promise<Alias[]> {
  const { default: config } = (await import(pathToFileURL(join(ROOT, file)).href)) as {
    default:
      | ((env: { mode: string; command: 'build' }) => { resolve: { alias: Alias[] } })
      | { resolve: { alias: Alias[] } };
  };
  const resolved = typeof config === 'function' ? config({ mode, command: 'build' }) : config;
  return resolved.resolve.alias;
}

/** What `spec` resolves to under `aliases`, or undefined when no alias takes it. */
function aliased(aliases: Alias[], spec: string): string | undefined {
  const alias = aliases.find(({ find }) =>
    typeof find === 'string' ? spec === find || spec.startsWith(`${find}/`) : find.test(spec),
  );
  return alias ? relative(__dirname, alias.replacement) : undefined;
}

describe('zod without eval in the webview', () => {
  it('turns the compiled parsers off, which the webview policy would refuse', () => {
    expect(zod.config().jitless).toBe(true);
  });

  it('gives an importer all of zod, as zod itself does', () => {
    // The shared schemas import zod as a namespace, and get this module's.
    expect(Object.keys(viaWrapper).sort()).toEqual(Object.keys(zod).sort());
    const schema = viaWrapper.object({ name: viaWrapper.string() });
    expect(schema.parse({ name: 'Acme' })).toEqual({ name: 'Acme' });
    expect(schema.safeParse({ name: 3 }).success).toBe(false);
  });

  it.each([
    ['vite.config.ts', 'production'],
    ['vite.config.ts', 'sidepanel'],
    ['vite.config.e2e.ts', 'development'],
  ])(
    'is what zod resolves to in %s (%s), and reads zod under a name left alone',
    async (file, mode) => {
      const aliases = await aliasesOf(file, mode);
      expect(aliased(aliases, 'zod')).toBe('zodJitless.ts');
      expect(aliased(aliases, 'zod/v4')).toBeUndefined();
    },
  );

  it('is loaded by what imports zod, and by no entry ahead of it', () => {
    // An entry that imported it first made every panel and the sidebar parse
    // zod, for the few pages that validate anything.
    for (const entry of ['main.tsx', 'main.sidepanel.tsx']) {
      const source = readFileSync(resolve(__dirname, entry), 'utf8');
      expect(source).not.toMatch(/zodJitless|from 'zod'/);
    }
  });
});
