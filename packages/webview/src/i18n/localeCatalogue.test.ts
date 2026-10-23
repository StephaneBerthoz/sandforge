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

const EXTENSION_ROOT = join(SRC, '..', '..', 'extension');

/** The token VS Code names a locale's manifest, host and walkthrough files by. */
const VSCODE_TOKEN: Record<string, string> = {
  en: '',
  fr: 'fr',
  de: 'de',
  es: 'es',
  ja: 'ja',
  'pt-BR': 'pt-br',
};

/** A flat bundle of the extension: a manifest's strings, or the host's messages. */
function extensionBundle(...parts: string[]): Map<string, string> {
  const file = join(EXTENSION_ROOT, ...parts);
  return new Map(Object.entries(JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>));
}

/** The Marketplace manifest's strings in a locale: titles, walkthrough steps, settings. */
const manifestOf = (locale: string): Map<string, string> =>
  extensionBundle(
    locale === 'en' ? 'package.nls.json' : `package.nls.${VSCODE_TOKEN[locale]}.json`,
  );

/** The extension host's messages in a locale. */
const hostOf = (locale: string): Map<string, string> =>
  extensionBundle(
    'l10n',
    locale === 'en' ? 'bundle.l10n.json' : `bundle.l10n.${VSCODE_TOKEN[locale]}.json`,
  );

/** Each line of the Get Started walkthrough bodies in a locale, by file and line. */
function walkthroughOf(locale: string): Map<string, string> {
  const dir = join(EXTENSION_ROOT, 'walkthrough');
  const ours = (name: string) =>
    locale === 'en'
      ? name.endsWith('.md') && !name.includes('.nls.')
      : name.endsWith(`.nls.${VSCODE_TOKEN[locale]}.md`);
  const lines = new Map<string, string>();
  for (const name of readdirSync(dir).filter(ours)) {
    readFileSync(join(dir, name), 'utf8')
      .split('\n')
      .forEach((line, index) => lines.set(`${name}:${index + 1}`, line));
  }
  return lines;
}

/** All a reader of a locale sees: the panels, the manifest, the host's messages, the walkthrough. */
function everySurface(locale: string): Map<string, string> {
  const all = new Map<string, string>();
  const surfaces: [string, Map<string, string>][] = [
    ['', flatten(load(locale))],
    ['package.nls ', manifestOf(locale)],
    ['l10n ', hostOf(locale)],
    ['walkthrough ', walkthroughOf(locale)],
  ];
  for (const [prefix, values] of surfaces) {
    for (const [key, value] of values) all.set(`${prefix}${key}`, value);
  }
  return all;
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
    /\b(Termine|Cree|Donnees|Parametre|Selectionn|execution|operation|Echec|reussi|genere|requete|deja|apres|securite|defaut|Modele|Delai|Etape|etape|Executer|qualite|Duree|Apercu|regles?|Resultat|dependance|Pre|Sequence|Reference)\b/;

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
    expect(nls.description).toContain('générez des données synthétiques');
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

describe('a language names one thing with one word', () => {
  /* Native reviewers read the same thing named two ways as two things: the
     French catalogue said "modèle" and "template" in one sentence, the Spanish
     one made a sandbox feminine in five values and masculine in sixteen, and
     French and Portuguese wrote Salesforce's Flow as a common noun. */
  const offenders = (locale: string, pattern: RegExp): string[] =>
    [...flatten(load(locale))]
      .filter(([, value]) => pattern.test(value))
      .map(([key, value]) => `${key} = ${value}`);

  it('French names a template "modèle"', () => {
    expect(offenders('fr', /\btemplates?\b/i)).toEqual([]);
    // Positive control: the walk reads the values that name one.
    expect(offenders('fr', /\bmodèles?\b/i).length).toBeGreaterThan(5);
  });

  /* The panels were masculine, and the Marketplace listing and the walkthrough
     a newcomer reads first said "una sandbox", "tu primera sandbox", "Las
     sandboxes". */
  it('Spanish makes a sandbox masculine, on every surface', () => {
    const feminine =
      /\b(?:la|una|esta|esa|las|unas|estas|esas|primera|nueva)\s+sandbox|sandbox\s+(?:está\s+)?(?:vacía|lista|nueva)/i;
    const surfaces = [...everySurface('es')];
    expect(surfaces.filter(([, value]) => feminine.test(value)).map(([key]) => key)).toEqual([]);
    expect(
      surfaces.filter(([, value]) => /\b(?:el|un)\s+sandbox\b/.test(value)).length,
    ).toBeGreaterThan(5);
    for (const shipped of ['Llena una sandbox', 'rellena tu primera sandbox', '> Las sandboxes']) {
      expect({ shipped, caught: feminine.test(shipped) }).toEqual({ shipped, caught: true });
    }
  });

  /* German wrote "in den Ziel-Org", "im Ziel-Org", "zum Quell-Org" and "des
     Ziel-Orgs" beside "die Ziel-Org" on the same screens. Salesforce's German
     UI writes "die Organisation", and "die Org" follows it: a word only a
     masculine or neuter noun takes, before Org, fails here. "der" is left
     alone, as the feminine dative and genitive. */
  const MASCULINE_OR_NEUTER_BEFORE_ORG = (() => {
    const either = (words: readonly string[]) =>
      words.map((w) => `[${w[0].toUpperCase()}${w[0]}]${w.slice(1)}`).join('|');
    const singular = either([
      ...['dem', 'den', 'das', 'ein', 'einem', 'einen', 'im', 'vom', 'zum', 'beim', 'am', 'ans'],
      ...['ins', 'kein', 'keinem', 'keinen', 'diesem', 'diesen', 'jedem', 'jeden', 'ihrem'],
      ...['ihren', 'seinem', 'seinen', 'unserem', 'unseren', 'welchem', 'welchen'],
    ]);
    const genitive = either(['des', 'eines', 'dieses', 'jedes', 'keines', 'ihres', 'welches']);
    const adjectives = String.raw`(?:(?!(?:der|die|das|den|dem|des)\b)\p{Ll}+(?:e|en|er|es|em)\s+){0,2}`;
    const org = String.raw`(?:\p{L}+-)*Org`;
    return new RegExp(
      String.raw`(?<![\p{L}-])(?:(?:${singular})\s+${adjectives}${org}(?![\p{L}-])|(?:${genitive})\s+${adjectives}${org}s\b)`,
      'u',
    );
  })();

  it('German makes an org feminine, as Salesforce’s German makes the Organisation', () => {
    const EXTENSION_DIR = join(SRC, '..', '..', 'extension');
    const json = (file: string) =>
      new Map(
        Object.entries(
          JSON.parse(readFileSync(join(EXTENSION_DIR, file), 'utf8')) as Record<string, string>,
        ),
      );
    const walkthrough = new Map<string, string>();
    const dir = join(EXTENSION_DIR, 'walkthrough');
    for (const name of readdirSync(dir).filter((file) => file.endsWith('.nls.de.md'))) {
      readFileSync(join(dir, name), 'utf8')
        .split('\n')
        .forEach((line, index) => walkthrough.set(`${name}:${index + 1}`, line));
    }
    const surfaces = [
      flatten(load('de')),
      json('package.nls.de.json'),
      json(join('l10n', 'bundle.l10n.de.json')),
      walkthrough,
    ];
    const masculine = surfaces.flatMap((values) =>
      [...values]
        .filter(([, value]) => MASCULINE_OR_NEUTER_BEFORE_ORG.test(value))
        .map(([key, value]) => `${key} = ${value}`),
    );
    expect(masculine).toEqual([]);
    // Controls: the rule reads the forms that shipped, and leaves the
    // feminine ones, the plural and a compound alone.
    for (const shipped of [
      'schreibt Datensätze in den Ziel-Org.',
      'Im Ziel-Org existiert bereits ein Datensatz',
      'ob sie zum Quell-Org gehört',
      'im Setup des Ziel-Orgs',
      'einen neuen Org',
    ]) {
      expect({ shipped, caught: MASCULINE_OR_NEUTER_BEFORE_ORG.test(shipped) }).toEqual({
        shipped,
        caught: true,
      });
    }
    for (const fine of [
      'in die Ziel-Org',
      'In der Ziel-Org existiert',
      'zur Quell-Org',
      'im Setup der Ziel-Org',
      'zwischen den beiden Orgs',
      'Basierend auf Ihrem Org-Typ',
    ]) {
      expect({ fine, caught: MASCULINE_OR_NEUTER_BEFORE_ORG.test(fine) }).toEqual({
        fine,
        caught: false,
      });
    }
    expect(offenders('de', /\bdie (?:\p{L}+-)?Org\b/u).length).toBeGreaterThan(20);
  });

  it.each(['fr', 'es', 'pt-BR'])(
    '%s writes Flow, the Salesforce feature, with its capital',
    (locale) => {
      expect(offenders(locale, /\bflows?\b/)).toEqual([]);
      expect(offenders(locale, /\bFlows?\b/).length).toBeGreaterThan(0);
    },
  );

  /* Japanese called an org 組織 in 88 values and Org in 156, and a Salesforce
     field 項目 in 84 and フィールド in 54. Salesforce's own Japanese UI says 組織
     and 項目 (組織情報, 本番組織, カスタム項目, 項目レベルセキュリティ), which is
     what an admin reads in Setup. A placeholder such as {{org}} is a name in
     code the reader never sees, and is set aside first, as is each word below
     in the one value where it names something else. */
  const JA_SET_ASIDE: Record<string, string> = {
    // The Salesforce CLI command the reader runs, typed as it is.
    'auth.jwtHelp': 'sf org login jwt',
    // The five fields of a cron expression, as Japanese cron documentation calls them.
    'sync.schedules.cronHelp': 'フィールド',
  };
  const ORG_WORD = /(?<![A-Za-z])orgs?(?![A-Za-z])/i;
  const FIELD_WORD = /フィールド/;

  const naming = (values: Map<string, string>, pattern: RegExp): string[] =>
    [...values]
      .filter(([key, value]) => {
        const words = value.replace(/\{\{[^}]*\}\}/g, '');
        const aside = JA_SET_ASIDE[key];
        return pattern.test(aside === undefined ? words : words.split(aside).join(''));
      })
      .map(([key, value]) => `${key} = ${value}`);

  const EXTENSION = join(SRC, '..', '..', 'extension');

  it('Japanese names an org 組織 and a Salesforce field 項目', () => {
    const ja = flatten(load('ja'));
    expect(naming(ja, ORG_WORD)).toEqual([]);
    expect(naming(ja, FIELD_WORD)).toEqual([]);
    // Positive control: the walk reads the values that name them.
    expect(naming(ja, /組織/).length).toBeGreaterThan(100);
    expect(naming(ja, /項目/).length).toBeGreaterThan(100);
  });

  it('the Japanese manifest and host messages name them the same way', () => {
    const bundle = (file: string) =>
      new Map(
        Object.entries(
          JSON.parse(readFileSync(join(EXTENSION, file), 'utf8')) as Record<string, string>,
        ),
      );
    const nls = bundle('package.nls.ja.json');
    const host = bundle(join('l10n', 'bundle.l10n.ja.json'));
    expect(naming(nls, ORG_WORD)).toEqual([]);
    expect(naming(nls, FIELD_WORD)).toEqual([]);
    expect(naming(host, ORG_WORD)).toEqual([]);
    expect(naming(host, FIELD_WORD)).toEqual([]);
    expect(nls.get('command.openOrgs')).toBe('SandForge: 組織に接続');
    // Positive control on 組織: the host's field words were the table of known
    // error codes', which the panels' catalogue now says in their place.
    expect(naming(host, /組織/).length).toBeGreaterThan(5);
  });

  it('the Japanese walkthrough bodies name them the same way', () => {
    // VS Code shows each body beside its step title from the manifest.
    const dir = join(EXTENSION, 'walkthrough');
    const lines = new Map<string, string>();
    for (const name of readdirSync(dir).filter((file) => file.endsWith('.nls.ja.md'))) {
      readFileSync(join(dir, name), 'utf8')
        .split('\n')
        .forEach((line, index) => lines.set(`${name}:${index + 1}`, line));
    }
    expect(naming(lines, ORG_WORD)).toEqual([]);
    expect(naming(lines, FIELD_WORD)).toEqual([]);
    expect(naming(lines, /組織/).length).toBeGreaterThan(5);
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

describe('where the app explains the Forge flow, Clone directly and the Graph/Table choice are there', () => {
  const ALL = ['en', ...NON_EN] as const;
  /** The walkthrough file suffix of each locale: VS Code's own token. */
  const WALKTHROUGH: Record<(typeof ALL)[number], string> = {
    en: '',
    fr: '.nls.fr',
    de: '.nls.de',
    es: '.nls.es',
    ja: '.nls.ja',
    'pt-BR': '.nls.pt-br',
  };
  const WALKTHROUGH_DIR = join(SRC, '..', '..', 'extension', 'walkthrough');

  /** A label as the reader finds it on screen, from the same catalogue. */
  const label = (catalogue: Catalogue, key: string): string => {
    const value = lookup(catalogue, key);
    expect(typeof value, key).toBe('string');
    return value as string;
  };

  it.each(ALL)('%s help names Clone directly and both views, by their labels', (locale) => {
    const catalogue = load(locale);
    const help = label(catalogue, 'help.forgeContent');
    expect(help).toContain(label(catalogue, 'forge.direct.action'));
    expect(help).toContain(label(catalogue, 'forgeRun.graphView'));
    expect(help).toContain(label(catalogue, 'forgeRun.tableView'));
    expect(help).toContain('sandforge.forge.graphView');
  });

  it.each(ALL)('%s Forge empty state names Clone directly among its steps', (locale) => {
    const catalogue = load(locale);
    expect(label(catalogue, 'forge.emptyState.step5')).toContain(
      label(catalogue, 'forge.direct.action'),
    );
  });

  it.each(ALL)('%s Get Started step on Forge names Clone directly and both views', (locale) => {
    const catalogue = load(locale);
    const body = readFileSync(
      join(WALKTHROUGH_DIR, `forge-clone${WALKTHROUGH[locale]}.md`),
      'utf8',
    );
    expect(body).toContain(label(catalogue, 'forge.direct.action'));
    expect(body).toContain(label(catalogue, 'forgeRun.graphView'));
    expect(body).toContain(label(catalogue, 'forgeRun.tableView'));
    expect(body).toContain('sandforge.forge.graphView');
  });
});

describe('each locale reads as Salesforce’s own UI in that language, consistently', () => {
  const ALL = ['en', ...NON_EN] as const;

  /** A catalogue value that the test expects to be there. */
  const text = (catalogue: Catalogue, key: string): string => {
    const value = lookup(catalogue, key);
    expect(typeof value, key).toBe('string');
    return value as string;
  };

  /** How often a pattern (with its g flag) occurs in a text. */
  const count = (value: string, pattern: RegExp): number => (value.match(pattern) ?? []).length;

  /*
   * German named the Frozen Dataset module "Eingefrorener Datensatz", and its
   * page said "Noch kein Datensatz eingefroren" above "{{count}} Datensätze …
   * eingefroren", where Datensätze are records: the word Salesforce's German
   * UI, and this same catalogue, keep for a record.
   */
  it('German calls the frozen dataset Dataset, and keeps Datensatz for a record', () => {
    const de = flatten(load('de'));
    const callsItDataset = (english: string, german: string) =>
      /Dataset/.test(german) && count(german, /datens[aä]tz/gi) <= count(english, /record/gi);
    const said = [...flatten(en)].filter(([, value]) => /dataset/i.test(value));
    const offenders = said
      .filter(([key, value]) => !callsItDataset(value, de.get(key) ?? ''))
      .map(([key]) => `${key} = ${de.get(key)}`);
    expect(offenders).toEqual([]);
    // Positive control: the walk reads the values that name one.
    expect(said.length).toBeGreaterThan(25);
    // Controls: what shipped is refused; a record named beside the dataset is not.
    expect(callsItDataset('Frozen Dataset', 'Eingefrorener Datensatz')).toBe(false);
    expect(callsItDataset('No dataset frozen yet', 'Noch kein Datensatz eingefroren')).toBe(false);
    expect(
      callsItDataset(
        'Never a record id — Frozen Dataset',
        'Nie eine Datensatz-ID — Eingefrorenes Dataset',
      ),
    ).toBe(true);
    const nls = manifestOf('de');
    for (const key of ['command.openFrozen', 'command.copyFrozenSalt', 'command.useFrozenSalt']) {
      expect({ key, title: nls.get(key) }).toEqual({
        key,
        title: expect.stringMatching(/eingefrorene[ns]? Datasets?/i),
      });
    }
  });

  /*
   * The Command Palette said "Frozen Dataset öffnen" under a sidebar entry
   * "Eingefrorener Datensatz", "Ouvrir Jeu de référence figé" under "Jeu figé",
   * and "Open Compare" under "Compare Org": two names for one module, in every
   * language, English included.
   */
  const PALETTE_MODULES: Record<string, string> = {
    Home: 'home',
    Monitor: 'monitor',
    Seed: 'seed',
    Sync: 'sync',
    Forge: 'forge',
    // The palette said "Ouvrir Checkpoints" under a side bar entry "Points de
    // contrôle", and the same English word in four other languages.
    Checkpoints: 'checkpoint',
    Frozen: 'frozen',
    Grappe: 'grappe',
    Autopilot: 'autopilot',
    Compare: 'compare',
    DataOps: 'dataops',
    Automation: 'automation',
    Migration: 'migration',
    AI: 'ai',
    Reports: 'reports',
    Settings: 'settings',
    Help: 'help',
  };
  const names = (title: string, label: string) => title.toLowerCase().includes(label.toLowerCase());
  /** German declines the Frozen Dataset's name in a sentence: das eingefrorene Dataset, des eingefrorenen Datasets. */
  const namesFrozen = (locale: string, value: string, label: string) =>
    locale === 'de' ? /eingefrorene[ns]? Datasets?/i.test(value) : names(value, label);

  it.each(ALL)('%s names each module in the Command Palette as its navigation does', (locale) => {
    const catalogue = load(locale);
    const nls = manifestOf(locale);
    const offenders = Object.entries(PALETTE_MODULES)
      .map(([command, module]) => [nls.get(`command.open${command}`) ?? '', module] as const)
      .filter(([title, module]) => !names(title, text(catalogue, `nav.${module}`)))
      .map(([title, module]) => `${title} (nav.${module} = ${text(catalogue, `nav.${module}`)})`);
    expect(offenders).toEqual([]);
    for (const module of ['Forge', 'Frozen', 'Monitor', 'Seed', 'Settings', 'Sync']) {
      const label = text(catalogue, `nav.${module.toLowerCase()}`);
      expect({ module, named: names(text(catalogue, `home.open${module}`), label) }).toEqual({
        module,
        named: true,
      });
    }
  });

  it('the palette check refuses the titles that shipped', () => {
    expect(names('SandForge: Open Compare', 'Compare Org')).toBe(false);
    expect(names('SandForge : Ouvrir Jeu de référence figé', 'Jeu figé')).toBe(false);
    expect(names('SandForge: Frozen Dataset öffnen', 'Eingefrorener Datensatz')).toBe(false);
    expect(names('SandForge: Abrir Assistente de IA', 'Assistente IA')).toBe(false);
  });

  it.each(ALL)(
    '%s quotes the Frozen Dataset salt commands as the palette titles them, with the module’s name',
    (locale) => {
      const catalogue = load(locale);
      const nls = manifestOf(locale);
      const use = nls.get('command.useFrozenSalt') ?? '';
      const copy = nls.get('command.copyFrozenSalt') ?? '';
      expect(text(catalogue, 'common.frozenSalt.created')).toContain(copy);
      expect(text(catalogue, 'common.frozenSalt.created')).toContain(use);
      expect(text(catalogue, 'frozen.extract.saltHint')).toContain(copy);
      expect(text(catalogue, 'frozen.extract.saltHint')).toContain(use);
      expect(text(catalogue, 'frozen.status.saltMismatch')).toContain(use);
      const label = text(catalogue, 'nav.frozen');
      for (const title of [use, copy]) {
        expect({ title, named: namesFrozen(locale, title, label) }).toEqual({
          title,
          named: true,
        });
      }
    },
  );

  /*
   * Help, the release notes and the panels went on naming modules in English —
   * "Brouillons de pipeline dans Automation", "Monitor suit les limites",
   * "Compare lee lo que compara" — beside navigation entries that say
   * Automatisation, Moniteur and Comparación.
   */
  const ENGLISH_NAME: Record<string, string> = {
    automation: 'Automation',
    compare: 'Compare',
    monitor: 'Monitor',
    reports: 'Reports',
    frozen: 'Frozen Dataset',
  };
  /** Where Spanish and Portuguese write "Compare", the verb, and not the module. */
  const COMPARE_THE_VERB = new Set([
    'help.compareContent',
    'compare.emptyState.description',
    'errors.invalidType.forge.action',
  ]);

  it.each(NON_EN)(
    '%s names a module by its navigation label, not by its English name',
    (locale) => {
      const catalogue = load(locale);
      const surfaces = [
        ...flatten(catalogue),
        ...[...manifestOf(locale)].map(([key, value]) => [`package.nls ${key}`, value] as const),
        ...[...hostOf(locale)].map(([key, value]) => [`l10n ${key}`, value] as const),
      ];
      const offenders: string[] = [];
      for (const [module, word] of Object.entries(ENGLISH_NAME)) {
        const label = text(catalogue, `nav.${module}`);
        if (label === text(en, `nav.${module}`)) continue;
        const english = new RegExp(`(?<![A-Za-zÀ-ÿ])${word}(?![A-Za-zÀ-ÿ])`);
        for (const [key, value] of surfaces) {
          if (module === 'compare' && COMPARE_THE_VERB.has(key)) continue;
          if (english.test(value)) offenders.push(`${key}: ${word} (nav: ${label})`);
        }
      }
      expect(offenders).toEqual([]);
      // The step of Help that lists the modules says their names.
      const getStarted = text(catalogue, 'help.gettingStartedContent');
      for (const module of ['compare', 'frozen', 'automation']) {
        const label = text(catalogue, `nav.${module}`);
        const named =
          module === 'frozen' ? namesFrozen(locale, getStarted, label) : names(getStarted, label);
        expect({ module, named }).toEqual({ module, named: true });
      }
    },
  );

  /*
   * The Marketplace listing and the walkthrough said tú — "Conecta tu primera
   * org", "Llena una sandbox", "Confía en la carpeta" — and the panel usted, as
   * Salesforce's Spanish UI does; a few panel strings had kept tú too.
   */
  const TU = /(?<!\p{L})(?:tu|tus|tuyo|tuya|te|ti|contigo|haz|hazlo|pon|ponlo)(?!\p{L})/iu;
  const TU_INSTRUCTION =
    /(?:^|[.:!?]\s+|##\s+|\d\.\s+)(?:Conecta|Elige|Llena|Rellena|Clona|Supervisa|Ajusta|Confía|Sigue|Importa|Usa|Abre|Pega|Haz|Revisa|Adapta|Arrastra)(?!\p{L})/u;

  it('Spanish speaks to the reader as usted on every surface, as the panel does', () => {
    const surfaces = [...everySurface('es')];
    const words = (value: string) => value.replace(/\{\{[^}]*\}\}|\{\d+\}/g, '');
    expect(surfaces.filter(([, value]) => TU.test(words(value))).map(([key]) => key)).toEqual([]);
    // A walkthrough step is an instruction from its first word.
    const instructions = surfaces.filter(
      ([key]) => key.startsWith('walkthrough ') || key.startsWith('package.nls walkthrough.'),
    );
    expect(instructions.length).toBeGreaterThan(20);
    expect(
      instructions.filter(([, value]) => TU_INSTRUCTION.test(value)).map(([key]) => key),
    ).toEqual([]);
    // Controls: the shipped tú is caught, the usted that replaced it is not.
    for (const shipped of [
      'Arrastra y suelta tu archivo CSV aquí',
      'o haz clic en el botón para buscar',
      'SandForge: el pipeline «{0}» espera tu aprobación',
    ]) {
      expect({ shipped, caught: TU.test(shipped) }).toEqual({ shipped, caught: true });
    }
    for (const shipped of [
      'Conecta tu primera org',
      '1. Haz clic en **Importar desde SF CLI**',
      'Ajusta tu configuración',
    ]) {
      expect({ shipped, caught: TU_INSTRUCTION.test(shipped) }).toEqual({ shipped, caught: true });
    }
    for (const fine of [
      'Conecte su primera org',
      '1. Haga clic en **Importar desde SF CLI**',
      'Elimina de la org los registros',
    ]) {
      expect({ fine, caught: TU.test(fine) || TU_INSTRUCTION.test(fine) }).toEqual({
        fine,
        caught: false,
      });
    }
  });

  /* "Reportes" in the navigation and the palette, "(Informes)" in the
     walkthrough, and both in the panels: Salesforce's Spanish UI says Informes. */
  it('Spanish names the Reports tab Informes, as Salesforce’s Spanish UI does', () => {
    expect(text(load('es'), 'nav.reports')).toBe('Informes');
    expect(
      [...everySurface('es')]
        .filter(([, value]) => /\breportes?\b/i.test(value))
        .map(([key]) => key),
    ).toEqual([]);
  });

  /* Brazilian Portuguese split the sandbox twenty to twenty: feminine in the
     Marketplace listing and the first-run screens, masculine in Automation,
     Compare and the host's notifications. */
  it('Brazilian Portuguese makes a sandbox feminine, on every surface', () => {
    const masculine =
      /(?<!\p{L})(?:o|um|do|no|ao|pelo|num|este|esse|deste|desse|neste|nesse|seu|meu|nenhum|novo|primeiro|outro|mesmo|próprio)\s+sandbox(?!\p{L})|sandbox\s+(?:está\s+)?(?:vazio|pronto|novo|atualizado|criado|conectado|indicado|escolhido)(?!\p{L})/iu;
    const surfaces = [...everySurface('pt-BR')];
    expect(surfaces.filter(([, value]) => masculine.test(value)).map(([key]) => key)).toEqual([]);
    expect(
      surfaces.filter(([, value]) =>
        /(?<!\p{L})(?:a|uma|da|na|sua)\s+sandbox(?!\p{L})/iu.test(value),
      ).length,
    ).toBeGreaterThan(10);
    for (const shipped of [
      'Escolher um sandbox',
      'Um sandbox atualizado é uma nova org',
      'SandForge: o sandbox {0} foi atualizado',
    ]) {
      expect({ shipped, caught: masculine.test(shipped) }).toEqual({ shipped, caught: true });
    }
  });

  /*
   * Production Guard's question put the org phrase, which carries its article,
   * right after a preposition: Portuguese read "Inserir 12 registros em a org
   * de produção", and German "in die Produktions-Org aktualisieren" where an
   * update in the org takes the dative.
   */
  it('the Guard’s question contracts and declines the org it names, in Portuguese and German', () => {
    const SENTENCES = [
      'Insert {0} into {1}.',
      'Update {0} in {1}.',
      'Insert or update {0} in {1}.',
      'Delete {0} in {1}.',
      'Permanently delete {0} in {1}.',
      'Deploy {0} to {1}.',
    ];
    const REFUSALS = [
      'SandForge deploys metadata only to a sandbox, a scratch org or a Developer Edition org, not to {0}.',
      'Deleting records is not allowed in {0}.',
      'Permanently deleting records is not allowed in {0}.',
    ];
    const asked = (locale: string): string[] => {
      const host = hostOf(locale);
      const org = (host.get('the {0} org "{1}"') ?? '')
        .replace('{0}', host.get('production') ?? '')
        .replace('{1}', 'my-org');
      return [
        ...SENTENCES.map((key) => (host.get(key) ?? '').replace('{0}', '12').replace('{1}', org)),
        ...REFUSALS.map((key) => (host.get(key) ?? '').replace('{0}', org)),
      ];
    };
    const uncontracted = /(?<!\p{L})em (?:a|o|as|os)(?!\p{L})/iu;
    const portuguese = asked('pt-BR');
    expect(portuguese.filter((sentence) => uncontracted.test(sentence))).toEqual([]);
    expect(portuguese.filter((sentence) => / na org /.test(sentence))).toHaveLength(8);
    expect(
      [...everySurface('pt-BR')]
        .filter(([, value]) => uncontracted.test(value))
        .map(([key]) => key),
    ).toEqual([]);
    expect(uncontracted.test('Inserir 12 em a org de produção "my-org".')).toBe(true);

    const german = asked('de');
    expect(german.map((sentence) => / in (der|die) /.exec(sentence)?.[1])).toEqual([
      'die',
      'der',
      'der',
      'der',
      'der',
      'die',
      'die',
      'der',
      'der',
    ]);
  });

  /*
   * A stop dialog asked to type the word Cancel beside a Cancel button that
   * closed it and stopped nothing: "Saisissez Annuler pour confirmer",
   * [Annuler]. Its two buttons now say what each does, and neither says Cancel.
   */
  it.each(ALL)('%s names the stop dialog’s buttons by what each does', (locale) => {
    const catalogue = load(locale);
    const said = (key: string) => text(catalogue, key).toLowerCase();
    const stop = said('common.stopRun');
    const keep = said('common.keepRunning');
    expect(stop).not.toBe(keep);
    for (const plain of ['common.cancel', 'common.confirm']) {
      expect({ plain, stop: stop === said(plain), keep: keep === said(plain) }).toEqual({
        plain,
        stop: false,
        keep: false,
      });
    }
  });

  /*
   * "Ouvrir un Account créé", "Ein erstelltes Account", "Abrir un Account
   * creado": the object's API name took an article and an agreement its
   * language gives it no gender for. Its label, which these sentences now
   * take where the page holds one, is in the org's language, whatever the
   * panel's: no article can agree with it either.
   */
  it.each(NON_EN)(
    '%s puts an object’s name in brackets, where no article agrees with it',
    (locale) => {
      const catalogue = load(locale);
      for (const key of [
        'seed.results.openRecord',
        'forgeRun.idMapping.openRoot',
        'forgeRun.idMapping.openRootInTarget',
      ]) {
        expect({ key, value: text(catalogue, key) }).toEqual({
          key,
          value: expect.stringMatching(/[(（]\{\{object\}\}[)）]/),
        });
      }
    },
  );

  /*
   * Spanish and Portuguese named the recommended template "Inicio CRM", the
   * label of the Home tab, beside "Sales Cloud Starter"; French said
   * "Démarrage" in the gallery and "CRM Starter" in Help.
   */
  const STARTER: Record<(typeof ALL)[number], string> = {
    en: 'Starter',
    fr: 'Kit de démarrage',
    de: 'Starter',
    es: 'Kit inicial',
    ja: 'スターター',
    'pt-BR': 'Kit inicial',
  };

  it.each(ALL)('%s names the Starter templates with one word, never the Home tab’s', (locale) => {
    const catalogue = load(locale);
    const home = new RegExp(`(?<!\\p{L})${text(catalogue, 'nav.home')}(?!\\p{L})`, 'u');
    for (const template of [
      'crmStarter',
      'salesCloudStarter',
      'serviceCloudStarter',
      'leadsActivitiesStarter',
    ]) {
      const name = text(catalogue, `seed.templates.${template}.name`);
      expect({ name, starter: name.includes(STARTER[locale]), home: home.test(name) }).toEqual({
        name,
        starter: true,
        home: false,
      });
    }
    const crm = text(catalogue, 'seed.templates.crmStarter.name');
    expect(text(catalogue, 'help.gettingStartedContent')).toContain(crm);
    expect([...walkthroughOf(locale).values()].join('\n')).toContain(`**${crm}**`);
  });

  /*
   * The first card of the gallery said "Accounts, Contacts and Opportunities"
   * in German, Spanish, Portuguese and Japanese, where its neighbours used
   * Salesforce's labels; German Seed said "Cases" where Salesforce's German UI,
   * and the rest of the catalogue, say Kundenvorgänge.
   */
  const ENGLISH_OBJECTS: Record<(typeof NON_EN)[number], RegExp> = {
    fr: /\b(?:Accounts?|Opportunit(?:y|ies))\b/,
    de: /\b(?:Contacts?|Cases?)\b|\bCase-/,
    es: /\b(?:Accounts?|Contacts?|Opportunit(?:y|ies)|Cases?)\b/,
    ja: /Account|Contact|Opportunit/,
    'pt-BR': /\b(?:Accounts?|Contacts?|Opportunit(?:y|ies)|Cases?)\b/,
  };

  it.each(NON_EN)(
    '%s describes the gallery templates with Salesforce’s labels for their objects',
    (locale) => {
      const descriptions = [...flatten(load(locale))].filter(([key]) =>
        /^seed\.templates\.\w+\.description$/.test(key),
      );
      expect(descriptions.length).toBeGreaterThanOrEqual(5);
      expect(
        descriptions.filter(([, value]) => ENGLISH_OBJECTS[locale].test(value)).map(([key]) => key),
      ).toEqual([]);
    },
  );

  it('German calls a Case Kundenvorgang wherever it names one', () => {
    const de = [...everySurface('de')];
    expect(de.filter(([, value]) => /\bCases?\b|\bCase-/.test(value)).map(([key]) => key)).toEqual(
      [],
    );
    expect(de.filter(([, value]) => /Kundenvorg/.test(value)).length).toBeGreaterThan(3);
  });

  /*
   * French said "votre défaut" (your defect) beside the default record type,
   * left "Reference" and "Picklist" in English in the Configure rules, and
   * named Quick Seed and Quick Sync in English on the Home recommendation,
   * under screens titled "Seed rapide" and "Sync Rapide".
   */
  it('French writes its first-run words in French', () => {
    const fr = [...everySurface('fr')];
    const english = /Quick S(?:eed|ync)|Sync Rapide|Seed Rapide|votre défaut|\bPicklists?\b/;
    expect(fr.filter(([, value]) => english.test(value)).map(([key]) => key)).toEqual([]);
    expect(text(load('fr'), 'quickSync.title')).toBe('Sync rapide');
    expect(text(load('fr'), 'seed.quickSeed.title')).toBe('Seed rapide');
  });

  it.each(NON_EN)('%s names Quick Seed and Quick Sync by the titles of their screens', (locale) => {
    const catalogue = load(locale);
    expect(text(catalogue, 'quickSync.title')).not.toBe('Quick Sync');
    expect(
      [...flatten(catalogue)]
        .filter(([, value]) => /Quick S(?:eed|ync)/.test(value))
        .map(([key]) => key),
    ).toEqual([]);
  });

  it('French writes Nœud with its ligature', () => {
    const fr = [...everySurface('fr')];
    expect(fr.filter(([, value]) => /\b[Nn]oeuds?\b/.test(value)).map(([key]) => key)).toEqual([]);
    expect(fr.filter(([, value]) => /[Nn]œud/.test(value)).length).toBeGreaterThan(2);
  });

  /*
   * Japanese said サンドボックス in the Marketplace listing and Sandbox in the
   * panel, クローン and 複製 for Forge's clone, ターゲット組織 and 対象組織 for the
   * target org, ブラウザ and ブラウザー, フロー and Flow.
   */
  it('Japanese names each thing with one word, on every surface', () => {
    const ja = [...everySurface('ja')];
    const naming = (pattern: RegExp) =>
      ja.filter(([, value]) => pattern.test(value)).map(([key, value]) => `${key} = ${value}`);
    expect(
      naming(/サンドボックス|複製|対象組織|ブラウザー|(?<![A-Za-z])Flows?(?![A-Za-z])/),
    ).toEqual([]);
    // Positive controls: the walk reads the values that name them.
    expect(naming(/Sandbox/).length).toBeGreaterThan(20);
    expect(naming(/クローン/).length).toBeGreaterThan(50);
    expect(naming(/ターゲット組織/).length).toBeGreaterThan(100);
    expect(naming(/フロー/).length).toBeGreaterThan(20);
    expect(naming(/ブラウザ/).length).toBeGreaterThan(3);
  });

  /*
   * The side panel's first-run title truncates to one line. German and
   * Japanese put the alias first, so a scratch org named by its long username
   * lost the verb: the main button never said what it does.
   */
  it.each(ALL)('%s puts the verb of the side panel’s fill title before the org alias', (locale) => {
    const value = text(load(locale), 'sidePanel.fillOrg');
    expect(value).toContain('{{alias}}');
    expect(value.startsWith('{{alias}}')).toBe(false);
  });

  /*
   * Spanish named a DataOps backup "respaldo" on its tab and in twenty-nine
   * strings, and "copia de seguridad" in twenty others, the settings among them.
   */
  /*
   * The What's New entry on pipeline steps called the Pre-Check step
   * "Comprobación previa", where the step's own label and every other
   * sentence call it "Pre-verificación".
   */
  it('Spanish names the Pre-Check step with its own label, on every surface', () => {
    const es = [...everySurface('es')];
    const otherWord = /comprobaci[oó]n previa/iu;
    expect(text(load('es'), 'automation.stepTypes.precheck')).toBe('Pre-verificación');
    expect(es.filter(([, value]) => otherWord.test(value)).map(([key]) => key)).toEqual([]);
    // Positive control: the walk reads the values that name the step.
    expect(es.filter(([, value]) => value.includes('Pre-verificación')).length).toBeGreaterThan(4);
  });

  it('Spanish names a backup with its DataOps tab’s word, on every surface', () => {
    const es = [...everySurface('es')];
    const backupWord = /(?<!\p{L})respaldos?(?!\p{L})/iu;
    const otherWord = /(?<!\p{L})copias? de seguridad(?!\p{L})/iu;
    expect(text(load('es'), 'dataops.backup')).toMatch(backupWord);
    expect(es.filter(([, value]) => otherWord.test(value)).map(([key]) => key)).toEqual([]);
    // Positive control: the walk reads the values that name one.
    expect(es.filter(([, value]) => backupWord.test(value)).length).toBeGreaterThan(40);
    // Control: what shipped is refused.
    expect(otherWord.test('Eliminar todas las copias de seguridad de esta org')).toBe(true);
  });

  /*
   * Brazilian Portuguese wrote "lista de seleção" in four strings and "lista
   * de opções", Salesforce's own word, in eleven, with an English "picklist".
   */
  it('Brazilian Portuguese calls a picklist lista de opções, as Salesforce does', () => {
    const pt = [...everySurface('pt-BR')];
    const otherWord = /(?<!\p{L})(?:listas? de seleção|picklists?)(?!\p{L})/iu;
    expect(pt.filter(([, value]) => otherWord.test(value)).map(([key]) => key)).toEqual([]);
    expect(pt.filter(([, value]) => /listas? de opções/iu.test(value)).length).toBeGreaterThan(10);
    expect(otherWord.test('Valor de lista de seleção inválido')).toBe(true);
    expect(otherWord.test('regras de picklist')).toBe(true);
  });

  /*
   * French and German offered "Smart (selon l'entrée)" and "Smart (je nach
   * Eingabe)" for the records-per-object limit, where Spanish, Portuguese and
   * Japanese say it in their own words.
   */
  it.each(['fr', 'de'] as const)(
    '%s names the automatic record limit in its own words',
    (locale) => {
      const smart = /(?<!\p{L})Smart(?!\p{L})/u;
      expect(
        [...everySurface(locale)].filter(([, value]) => smart.test(value)).map(([key]) => key),
      ).toEqual([]);
      const catalogue = load(locale);
      const option = text(catalogue, 'forge.recordLimitSmart');
      const word = option.split(' ')[0];
      for (const key of ['forge.recordLimitSmartRecord', 'forge.recordLimitSmartSoql']) {
        expect({ key, startsWithIt: text(catalogue, key).startsWith(word) }).toEqual({
          key,
          startsWithIt: true,
        });
      }
      expect(smart.test("Smart (selon l'entrée)")).toBe(true);
    },
  );

  /*
   * Japanese wrote "AIアシスタント" in the palette and "AI アシスタント" a line
   * apart, "SF CLIからインポート" in the walkthrough and "SF CLI からインポート"
   * on the page it leads to: about 300 places without the space Salesforce's
   * Japanese UI puts between a Latin word and the Japanese around it
   * ("Apex クラス", "API 参照名"), beside about a thousand with it.
   */
  it('Japanese spaces a Latin word from the Japanese around it, on every surface', () => {
    const JA = '[\\u3040-\\u30fa\\u30fc-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff]';
    const touching = new RegExp(`[A-Za-z]${JA}|${JA}[A-Za-z]`, 'u');
    const spaced = new RegExp(`[A-Za-z] ${JA}|${JA} [A-Za-z]`, 'gu');
    /** The text as it reads: placeholders, markup and the loanwords that hold a Latin letter set aside. */
    const reads = (value: string) =>
      value
        .replace(/\{\{[^}]*\}\}|\{\d+\}/g, '\u0000')
        .replace(/<[^>]+>|\*\*|`/g, '')
        .replace(/eコマース/g, 'コマース');
    const ja = [...everySurface('ja')];
    expect(ja.filter(([, value]) => touching.test(reads(value))).map(([key]) => key)).toEqual([]);
    // Positive control: the walk reads the values that space them.
    expect(
      ja.reduce((n, [, value]) => n + (reads(value).match(spaced) ?? []).length, 0),
    ).toBeGreaterThan(1000);
    // Controls: what shipped is refused, markup or not.
    expect(touching.test(reads('SandForge: AIアシスタントを開く'))).toBe(true);
    expect(touching.test(reads('**SF CLIからインポート** をクリック'))).toBe(true);
    expect(touching.test(reads('B2C eコマース'))).toBe(false);
  });
});

describe('Checkpoint & Rewind names each thing with one word, in each language', () => {
  /* The page, its Home tile, the result parts it shares with Sync, the line of
     Disconnect, the audit trail's two actions and Help: the values that speak
     of a checkpoint, a rewind or its undo. */
  const CHECKPOINT_KEY =
    /^(?:checkpoint\.|home\.checkpoint\.|runRemoval\.rewind(?:Undo)?\.|org\.disconnectDeleteCheckpoints_|reports\.auditActions\.checkpoint_|nav\.checkpoint$|moduleSummary\.checkpoint$|help\.checkpointContent$)/;
  const checkpointValues = (locale: string): [string, string][] =>
    [...flatten(load(locale))].filter(([key]) => CHECKPOINT_KEY.test(key));
  /** A catalogue value that the test expects to be there. */
  const text = (catalogue: Catalogue, key: string): string => {
    const value = lookup(catalogue, key);
    expect(typeof value, key).toBe('string');
    return value as string;
  };

  /**
   * The word each language names a checkpoint by, as its side bar entry does;
   * the host's notices write a plural they cannot choose as point(s).
   */
  const CHECKPOINT_WORD: Record<(typeof NON_EN)[number], RegExp> = {
    fr: /points?(?:\(s\))? de contrôle/iu,
    de: /Prüfpunkt/u,
    es: /puntos?(?:\(s\))? de control/iu,
    ja: /チェックポイント/u,
    'pt-BR': /pontos?(?:\(s\))? de verificação/iu,
  };
  /** The English word, but in a command or file name such as sandforge-checkpoint. */
  const ENGLISH_WORD = /(?<![\p{L}-])checkpoints?(?!\p{L})/iu;

  /*
   * The panels said "Points de contrôle", "Prüfpunkt" and チェックポイント, and
   * the Command Palette and the notice of a refreshed sandbox said Checkpoints
   * and checkpoint(s), in English, in the five languages.
   */
  it.each(NON_EN)('%s names a checkpoint in its own word on every surface', (locale) => {
    const surfaces = [...everySurface(locale)];
    expect(surfaces.filter(([, value]) => ENGLISH_WORD.test(value)).map(([key]) => key)).toEqual(
      [],
    );
    const word = CHECKPOINT_WORD[locale];
    expect(text(load(locale), 'nav.checkpoint')).toMatch(word);
    expect(manifestOf(locale).get('command.openCheckpoints')).toMatch(word);
    const refreshed = [...hostOf(locale)].filter(([key]) => /checkpoint/i.test(key));
    expect(refreshed.length).toBeGreaterThan(0);
    for (const [key, value] of refreshed) {
      expect({ key, value }).toEqual({ key, value: expect.stringMatching(word) });
    }
    // Positive control: the walk reads the values that name one.
    expect(surfaces.filter(([, value]) => word.test(value)).length).toBeGreaterThan(30);
    // Controls: what shipped is refused, a command's name is not.
    expect(ENGLISH_WORD.test('SandForge : Ouvrir Checkpoints')).toBe(true);
    expect(ENGLISH_WORD.test('Ses {0} checkpoint(s) gardés sur cette machine')).toBe(true);
    expect(ENGLISH_WORD.test('pnpm exec tsx cli/sandforge-checkpoint.ts')).toBe(false);
  });

  /*
   * Japanese counted objects with 個 in every line of the take and the preview
   * but one, which said 件のオブジェクト beside 件のレコード.
   */
  it('Japanese counts objects with 個 and records with 件', () => {
    const ja = checkpointValues('ja');
    const objectsBy件 = /件の\s*オブジェクト|オブジェクト\s*#\s*件/u;
    const reads = (value: string) => value.replace(/\{\{[^}]*\}\}/g, '#');
    expect(ja.filter(([, value]) => objectsBy件.test(reads(value))).map(([key]) => key)).toEqual(
      [],
    );
    expect(
      ja.filter(([, value]) => /個のオブジェクト|オブジェクト: \{\{\w+\}\} 個/u.test(value)).length,
    ).toBeGreaterThan(5);
    expect(objectsBy件.test(reads('{{formatted}} 件のオブジェクトを読み取れませんでした'))).toBe(
      true,
    );
  });

  /*
   * The take filtered its objects with フィルター and Stop comparing its fields
   * with 絞り込む, a page apart; DataOps' object picker, which the take
   * mirrors, says 絞り込む.
   */
  it('Japanese filters a list with 絞り込む, as DataOps’ object picker does', () => {
    const ja = load('ja');
    const filters = checkpointValues('ja').filter(([key]) => /\.filter$/.test(key));
    expect(filters.length).toBeGreaterThan(1);
    for (const [key, value] of filters) {
      expect({ key, value }).toEqual({ key, value: expect.stringMatching(/を絞り込む$/u) });
    }
    expect(text(ja, 'checkpoint.take.filter')).toBe(text(ja, 'dataops.objectPicker.filter'));
  });

  /*
   * Japanese said 元に戻す for Undo on the button, the run, the result and the
   * preview, and 巻き戻しの取り消し in the audit trail: 取り消す is what a Sync
   * removal does to a run.
   */
  it('Japanese names Undo 元に戻す wherever the English says undo', () => {
    const english = new Map(checkpointValues('en'));
    const ja = checkpointValues('ja').filter(([key]) => /undo/i.test(english.get(key) ?? ''));
    expect(ja.filter(([, value]) => /取り消/u.test(value)).map(([key]) => key)).toEqual([]);
    // Positive control: the walk reads the values that name it.
    expect(ja.filter(([, value]) => /元に戻/u.test(value)).length).toBeGreaterThan(15);
    expect(text(load('ja'), 'reports.auditActions.checkpoint_undo')).toContain('元に戻す');
  });

  /*
   * Spanish called a lead prospecto in the preview's converted leads, where
   * the error for a converted lead, the Seed template and Salesforce's own
   * Spanish say candidato.
   */
  it('Spanish names a lead candidato, as the converted-lead error does, on every surface', () => {
    const es = [...everySurface('es')];
    const otherWord = /(?<!\p{L})prospectos?(?!\p{L})/iu;
    expect(es.filter(([, value]) => otherWord.test(value)).map(([key]) => key)).toEqual([]);
    for (const key of [
      'checkpoint.preview.cannot.convertedLead_one',
      'checkpoint.preview.cannot.convertedLead_other',
      'errors.convertedLead.explanation',
    ]) {
      expect({ key, value: text(load('es'), key) }).toEqual({
        key,
        value: expect.stringMatching(/candidatos?/u),
      });
    }
    expect(otherWord.test('1 prospecto se convirtió desde entonces')).toBe(true);
  });
});
