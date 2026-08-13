import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import en from './locales/en.json';
import fr from './locales/fr.json';

/**
 * Catalogue-level guards that the parity gate cannot express.
 *
 * check-i18n-parity.ts proves the six locale files hold the same key set.
 * That is silent about three failures a French or Japanese user actually
 * sees: an inline `t('k', 'English')` default standing in for a key nobody
 * ever added, a French value written without its accents, and a value copied
 * verbatim from English. Each is asserted here against the shipped JSON.
 */

const SRC = join(__dirname, '..');
const LOCALES = join(__dirname, 'locales');
const NON_EN = ['fr', 'de', 'es', 'ja', 'pt-BR'] as const;

type Catalogue = Record<string, unknown>;

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) acc.push(full);
  }
  return acc;
}

function lookup(catalogue: Catalogue, dotted: string): unknown {
  return dotted
    .split('.')
    .reduce<unknown>(
      (node, part) => (node && typeof node === 'object' ? (node as Catalogue)[part] : undefined),
      catalogue,
    );
}

function load(locale: string): Catalogue {
  return JSON.parse(readFileSync(join(LOCALES, `${locale}.json`), 'utf8')) as Catalogue;
}

describe('inline t() defaults are backed by the catalogue', () => {
  it('resolves every key that ships an inline English default', () => {
    // t('a.b', 'Default') and t('a.b', { defaultValue: 'Default' }).
    const literal = /\bt\(\s*'([a-zA-Z0-9_.]+)'\s*,\s*(?:'|")/g;
    const option = /\bt\(\s*'([a-zA-Z0-9_.]+)'\s*,\s*\{[^}]*defaultValue\s*:/g;

    const unbacked: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of [literal, option]) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(source)) !== null) {
          const key = match[1];
          if (!key.includes('.')) continue;
          if (lookup(en, key) === undefined) {
            unbacked.push(`${key} (${file.slice(SRC.length + 1)})`);
          }
        }
      }
    }

    expect([...new Set(unbacked)].sort()).toEqual([]);
  });
});

describe('French copy carries its accents', () => {
  /* Words whose French spelling is always accented. A hit means the value was
     typed on an unaccented keyboard, not that the word is missing. */
  const UNACCENTED =
    /\b(Termine|Cree|Donnees|Parametre|Selectionn|execution|operation|Echec|reussi|genere|requete|deja|apres|securite|defaut|Modele|Delai|Etape|etape|Executer|qualite|Duree|Apercu|regles?|Resultat|dependance)\b/;

  function flatten(obj: Catalogue, prefix = '', out = new Map<string, string>()) {
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value !== null && typeof value === 'object') flatten(value as Catalogue, path, out);
      else if (typeof value === 'string') out.set(path, value);
    }
    return out;
  }

  it('has no unaccented form in fr.json', () => {
    const offenders = [...flatten(fr)]
      .filter(([, value]) => UNACCENTED.test(value))
      .map(([key, value]) => `${key} = ${value}`);
    expect(offenders).toEqual([]);
  });

  it('has no unaccented form in the Marketplace manifest', () => {
    const nls = JSON.parse(
      readFileSync(join(SRC, '..', '..', 'extension', 'package.nls.fr.json'), 'utf8'),
    ) as Record<string, string>;
    const offenders = Object.entries(nls)
      .filter(([, value]) => UNACCENTED.test(value))
      .map(([key]) => key);
    expect(offenders).toEqual([]);
    expect(nls.description).toContain('Génération de données');
    expect(nls['command.openSettings']).toBe('SandForge : Paramètres');
  });
});

describe('sync templates are translated, not copied', () => {
  const TEMPLATE_KEYS = [
    'sync.selectAndConfigure',
    'sync.templates.title',
    'sync.templates.useThis',
    'sync.templates.objectCount',
    'sync.templates.accountHierarchy.name',
    'sync.templates.accountHierarchy.description',
    'sync.templates.oppsProducts.name',
    'sync.templates.oppsProducts.description',
    'sync.templates.casesAttachments.name',
    'sync.templates.casesAttachments.description',
  ];

  it.each(NON_EN)('%s differs from English on every sync template key', (locale) => {
    const catalogue = load(locale);
    const copied = TEMPLATE_KEYS.filter((key) => lookup(catalogue, key) === lookup(en, key));
    expect(copied).toEqual([]);
  });

  it.each(NON_EN)('%s keeps the {{count}} placeholder', (locale) => {
    expect(lookup(load(locale), 'sync.templates.objectCount')).toContain('{{count}}');
  });
});
