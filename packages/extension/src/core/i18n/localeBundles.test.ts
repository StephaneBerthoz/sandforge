import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSupportedLocaleCode, readLocaleBundle } from './localeBundles';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'locale-bundles-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readLocaleBundle', () => {
  it('parses the catalogue of a language once, and hands the same one to every request', async () => {
    await writeFile(join(dir, 'fr.json'), JSON.stringify({ sidePanel: { noOrg: 'Aucune org' } }));

    const first = await readLocaleBundle(dir, 'fr');
    // The file changes on disk: a second read would see it. The packaged
    // catalogues never change while the extension runs, so none is made.
    await writeFile(join(dir, 'fr.json'), JSON.stringify({ sidePanel: { noOrg: 'changed' } }));
    const second = await readLocaleBundle(dir, 'fr');

    expect(first).toEqual({ sidePanel: { noOrg: 'Aucune org' } });
    expect(second).toBe(first);
  });

  it('keeps no failed read, so the next request reads the file again', async () => {
    await expect(readLocaleBundle(dir, 'de')).rejects.toThrow();

    await writeFile(join(dir, 'de.json'), JSON.stringify({ nav: { seed: 'Seed' } }));
    await expect(readLocaleBundle(dir, 'de')).resolves.toEqual({ nav: { seed: 'Seed' } });
  });

  it('rejects a catalogue that is not JSON', async () => {
    await writeFile(join(dir, 'ja.json'), '{ not json');
    await expect(readLocaleBundle(dir, 'ja')).rejects.toThrow(SyntaxError);
  });
});

describe('isSupportedLocaleCode', () => {
  it('accepts the six shipped languages and nothing a path could hide in', () => {
    for (const lng of ['en', 'fr', 'de', 'es', 'ja', 'pt-BR']) {
      expect(isSupportedLocaleCode(lng)).toBe(true);
    }
    for (const lng of ['../fr', 'fr/../../x', 'pt-br', 'xx', 7, undefined]) {
      expect(isSupportedLocaleCode(lng)).toBe(false);
    }
  });
});
