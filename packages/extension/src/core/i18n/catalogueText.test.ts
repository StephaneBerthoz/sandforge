import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogueTextOf, uiLocaleOf } from './catalogueText';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'catalogue-text-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('uiLocaleOf', () => {
  it('takes the language SandForge is set to over the editor’s', () => {
    expect(uiLocaleOf('ja', 'fr')).toBe('ja');
  });

  it('matches the editor’s display language as the panels match it', () => {
    expect(uiLocaleOf(undefined, 'fr')).toBe('fr');
    expect(uiLocaleOf(undefined, 'pt-br')).toBe('pt-BR');
    expect(uiLocaleOf(undefined, 'pt')).toBe('pt-BR');
    expect(uiLocaleOf(undefined, 'de-AT')).toBe('de');
  });

  it('falls back to English for a language nothing is shipped in', () => {
    expect(uiLocaleOf(undefined, 'zh-tw')).toBe('en');
    expect(uiLocaleOf(undefined, undefined)).toBe('en');
  });
});

describe('catalogueTextOf', () => {
  it('reads a key of the catalogue in the locale’s own bundle', async () => {
    await writeFile(
      join(dir, 'fr.json'),
      JSON.stringify({ errors: { rowLocked: { action: 'Relancez dans un instant.' } } }),
    );

    await expect(catalogueTextOf(dir, 'fr', 'errors.rowLocked.action')).resolves.toBe(
      'Relancez dans un instant.',
    );
  });

  it('says it in English when the locale’s bundle lacks the key, or cannot be read', async () => {
    await writeFile(
      join(dir, 'en.json'),
      JSON.stringify({ errors: { rowLocked: { action: 'Run again in a moment.' } } }),
    );
    await writeFile(join(dir, 'de.json'), JSON.stringify({ errors: {} }));

    await expect(catalogueTextOf(dir, 'de', 'errors.rowLocked.action')).resolves.toBe(
      'Run again in a moment.',
    );
    await expect(catalogueTextOf(dir, 'es', 'errors.rowLocked.action')).resolves.toBe(
      'Run again in a moment.',
    );
  });

  it('says nothing when no bundle has the key', async () => {
    await expect(catalogueTextOf(dir, 'en', 'errors.rowLocked.action')).resolves.toBeUndefined();
  });
});
