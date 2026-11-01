import { describe, it, expect } from 'vitest';

import fr from './locales/fr.json';

/**
 * French labels are written in sentence case.
 *
 * Autopilot's, Monitor's and Reports' French copied the English Title Case —
 * "Vérifier le Plan", "Durée Estimée", "Champs à Anonymiser", "Temps Écoulé",
 * "Règle Appliquée", "Rapports & Analytiques" —, which a French consultant
 * reads as machine translation. A
 * label (a string without sentence punctuation, six words at most) capitalises
 * its first word and the names below, nothing else. Acronyms, written in
 * capitals, are not words this check reads.
 */

/** The namespaces whose French labels have been through the pass. */
const NAMESPACES = ['autopilot', 'monitor', 'reports', 'grappe'] as const;

/** Names French writes with a capital wherever they stand. */
const PROPER_NAMES = new Set([
  'Apex',
  'Autopilot',
  'Flow',
  'Flows',
  'Forge',
  'Grappe',
  'Harbor',
  'Id',
  'Moniteur',
  'Safe',
  'Salesforce',
  'SandForge',
  'Seed',
]);

type Catalogue = Record<string, unknown>;

/** Every string of a catalogue, as `a.b.c` → value. */
function flatten(obj: Catalogue, prefix: string, out: Array<[string, string]> = []) {
  for (const [key, value] of Object.entries(obj)) {
    const path = `${prefix}.${key}`;
    if (value !== null && typeof value === 'object') flatten(value as Catalogue, path, out);
    else if (typeof value === 'string') out.push([path, value]);
  }
  return out;
}

/** The capitalised words of a label after its first, names left out. */
function capitalisedInnerWords(label: string): string[] {
  const words = label
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .split(/[\s—–/]+/)
    .filter(Boolean);
  return words
    .slice(1)
    .filter((word) => /^\p{Lu}\p{Ll}/u.test(word))
    .filter((word) => !PROPER_NAMES.has(word.replace(/[^\p{L}]/gu, '')));
}

/** Whether a value is a label rather than a sentence. */
function isLabel(value: string): boolean {
  return !/[.:;?!]/.test(value) && value.trim().split(/\s+/).length <= 6;
}

describe('French labels are in sentence case', () => {
  it.each(NAMESPACES)('capitalises only the first word of a %s label, and names', (namespace) => {
    const offenders = flatten((fr as Catalogue)[namespace] as Catalogue, namespace)
      .filter(([, value]) => isLabel(value))
      .filter(([, value]) => capitalisedInnerWords(value).length > 0)
      .map(([key, value]) => `${key}: ${value}`);

    expect(offenders).toEqual([]);
  });

  it('refuses the Title Case that shipped, and lets a name stand', () => {
    expect(capitalisedInnerWords('Vérifier le Plan')).toEqual(['Plan']);
    expect(capitalisedInnerWords('Temps Écoulé')).toEqual(['Écoulé']);
    expect(capitalisedInnerWords('Jobs Apex récents')).toEqual([]);
    expect(capitalisedInnerWords('Appels API estimés')).toEqual([]);
    expect(isLabel('Analyses des jobs Apex : pas encore lues.')).toBe(false);
  });
});
