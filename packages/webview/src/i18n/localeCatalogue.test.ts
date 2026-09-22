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

function flatten(obj: Catalogue, prefix = '', out = new Map<string, string>()) {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object') flatten(value as Catalogue, path, out);
    else if (typeof value === 'string') out.set(path, value);
  }
  return out;
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
          // A counted key lives as its plural forms: i18next picks the one.
          if (lookup(en, key) === undefined && lookup(en, `${key}_other`) === undefined) {
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
    'sync.templates.objectCount_other',
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
    expect(lookup(load(locale), 'sync.templates.objectCount_other')).toContain('{{count}}');
  });
});

describe('Brazilian Portuguese copy carries its accents', () => {
  /* Words whose Portuguese spelling is always accented. The navigation entry
     and the org page title shipped as "Organizacoes", which reads as a typo in
     the sidebar of every pt-BR user. */
  const UNACCENTED =
    /\b(Organizacoes|pagina|saude|Automacao|avancados|Configuracoes|Atualizacao|Indisponivel)\b/;

  it('has no unaccented form in pt-BR.json', () => {
    const offenders = [...flatten(load('pt-BR'))]
      .filter(([, value]) => UNACCENTED.test(value))
      .map(([key, value]) => `${key} = ${value}`);
    expect(offenders).toEqual([]);
  });
});

describe('no locale carries a stray diacritic', () => {
  const ALL = ['en', ...NON_EN] as const;

  /* The accented letters each language is written with. A combining mark (a
     U+0327 cedilla typed after "grava") or a precomposed letter from outside
     this set (U+0229, e with cedilla, in "proteção") passes every structural
     check and still renders as a garbled word. */
  const LETTERS: Record<(typeof ALL)[number], string> = {
    en: '',
    fr: 'àâæçéèêëîïôœùûüÿÀÂÆÇÉÈÊËÎÏÔŒÙÛÜŸ',
    // Ø is the average sign ("Ø 120ms"), not a misspelt letter.
    de: 'äöüßÄÖÜẞØ',
    es: 'áéíóúñüÁÉÍÓÚÑÜ',
    ja: '',
    'pt-BR': 'áâãàçéêíóôõúüÁÂÃÀÇÉÊÍÓÔÕÚÜ',
  };

  it.each(ALL)('%s has no combining mark and no letter foreign to its language', (locale) => {
    const offenders = [...flatten(load(locale))]
      .filter(
        ([, value]) =>
          /\p{Mn}/u.test(value) ||
          (value.match(/(?![A-Za-z])\p{Script=Latin}/gu) ?? []).some(
            (letter) => !LETTERS[locale].includes(letter),
          ),
      )
      .map(([key, value]) => `${key} = ${value}`);
    expect(offenders).toEqual([]);
  });
});

describe('the in-app help describes what the modules do', () => {
  const ALL = ['en', ...NON_EN] as const;

  /**
   * "Relationship", in the six languages.
   *
   * Seed's fourth step sets record counts. A lookup is filled from the rows the
   * same run inserted earlier, and no screen in the wizard lets anyone edit a
   * relationship — the help promised a step that does not exist.
   */
  const RELATIONSHIP: Record<(typeof ALL)[number], RegExp> = {
    en: /relationship/i,
    fr: /relations?\b/i,
    de: /Beziehung/i,
    es: /relaci[oó]n/i,
    ja: /リレーション/,
    'pt-BR': /relacionamento/i,
  };

  it.each(ALL)('%s help.seedContent promises no relationship step', (locale) => {
    const value = lookup(load(locale), 'help.seedContent');
    expect(typeof value).toBe('string');
    expect(RELATIONSHIP[locale].test(value as string)).toBe(false);
  });

  it.each(ALL)('%s help.aiContent names the setting that turns error sending off', (locale) => {
    expect(lookup(load(locale), 'help.aiContent')).toContain('sandforge.ai.errorResolution');
  });

  /**
   * "AI on or off", in the six languages.
   *
   * The table of known Salesforce error codes is consulted before the model is,
   * whatever the AI setting says, so the help must not sell it as the answer
   * you fall back to once AI is off.
   */
  const TABLE_ANSWERS_EITHER_WAY: Record<(typeof ALL)[number], RegExp> = {
    en: /AI on or off/,
    fr: /IA soit activée ou non/,
    de: /KI ein- oder ausgeschaltet ist/,
    es: /IA activada o desactivada/,
    ja: /AI がオンでもオフでも/,
    'pt-BR': /IA ligada ou desligada/,
  };

  it.each(ALL)('%s help.aiContent has the error table answer with AI on too', (locale) => {
    const value = lookup(load(locale), 'help.aiContent');
    expect(typeof value).toBe('string');
    expect(TABLE_ANSWERS_EITHER_WAY[locale].test(value as string)).toBe(true);
  });
});

describe('the Frozen Dataset salt warning names what a mismatched salt changes', () => {
  const ALL = ['en', ...NON_EN] as const;

  /**
   * A load replays the pseudonymized files as they are and never reads the
   * salt; only the next extraction keys its pseudonyms with it. The warning
   * shipped saying a load would produce pseudonyms that no longer match, so
   * each locale is held to naming the extraction and to naming no load.
   */
  const EXTRACTION: Record<(typeof ALL)[number], RegExp> = {
    en: /extraction/i,
    fr: /extraction/i,
    de: /Extraktion/,
    es: /extracci[oó]n/i,
    ja: /抽出/,
    'pt-BR': /extra[cç][aã]o/i,
  };

  const LOAD: Record<(typeof ALL)[number], RegExp> = {
    en: /\bload/i,
    fr: /\bcharg/i,
    de: /\bladen|geladen|lädt/i,
    es: /\bcarg/i,
    ja: /ロード|読み込/,
    'pt-BR': /\bcarreg|\bcarga/i,
  };

  it.each(ALL)('%s frozen.status.saltMismatch names the next extraction, not a load', (locale) => {
    const value = lookup(load(locale), 'frozen.status.saltMismatch');
    expect(typeof value).toBe('string');
    expect(EXTRACTION[locale].test(value as string)).toBe(true);
    expect(LOAD[locale].test(value as string)).toBe(false);
  });
});
