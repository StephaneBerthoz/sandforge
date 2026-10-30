import { describe, it, expect } from 'vitest';
import { MODULE_HOW_TO, hasHowTo, howToKeys, type HowToModule } from './howToKeys';
import en from '../../i18n/locales/en.json';
import fr from '../../i18n/locales/fr.json';
import de from '../../i18n/locales/de.json';
import es from '../../i18n/locales/es.json';
import ptBR from '../../i18n/locales/pt-BR.json';
import ja from '../../i18n/locales/ja.json';

const CATALOGUES = { en, fr, de, es, 'pt-BR': ptBR, ja } as const;
const MODULES = Object.keys(MODULE_HOW_TO) as HowToModule[];

/** The value at a dotted key of a catalogue, or undefined. */
function at(catalogue: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node !== null && typeof node === 'object'
          ? (node as Record<string, unknown>)[part]
          : undefined,
      catalogue,
    );
}

describe('MODULE_HOW_TO', () => {
  it.each(Object.entries(CATALOGUES))(
    'names in %s exactly the steps and the tip its howTo section holds',
    (_, catalogue) => {
      const section = (catalogue as unknown as { howTo: Record<string, unknown> }).howTo;
      const modules = Object.keys(section).filter((key) => typeof section[key] === 'object');
      expect(modules.sort()).toEqual([...MODULES].sort());
      for (const module of MODULES) {
        const keys = Object.keys(section[module] as object).map((key) => `howTo.${module}.${key}`);
        expect(keys.sort()).toEqual([...howToKeys(module)].sort());
        for (const key of howToKeys(module)) {
          expect(typeof at(catalogue, key), key).toBe('string');
          expect((at(catalogue, key) as string).trim(), key).not.toBe('');
        }
      }
      expect(typeof section.title).toBe('string');
      expect(typeof section.tipLabel).toBe('string');
    },
  );

  it('keeps each module to three to five short steps and a short tip', () => {
    for (const module of MODULES) {
      const { steps, tip } = MODULE_HOW_TO[module];
      expect(steps.length, module).toBeGreaterThanOrEqual(3);
      expect(steps.length, module).toBeLessThanOrEqual(5);
      for (const key of steps) expect((at(en, key) as string).length, key).toBeLessThanOrEqual(100);
      expect((at(en, tip) as string).length, tip).toBeLessThanOrEqual(140);
    }
  });

  it('tells a module that has a how-to from an id that has none', () => {
    expect(hasHowTo('seed')).toBe(true);
    expect(hasHowTo('settings')).toBe(false);
    expect(hasHowTo('toString')).toBe(false);
  });
});
