import { describe, expect, it } from 'vitest';
import { RETAIL_ORDERS_PACK } from '@sandforge/shared';
import en from '../../../i18n/locales/en.json';
import { builtInPackKeys, samePack, sourceOf } from './scenarioPacks';

/** A value of the English catalogue by its dotted key. */
const english = (key: string): unknown =>
  key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], en);

describe('scenarioPacks', () => {
  it('names each shipped pack by catalogue keys the English catalogue holds, and no other pack', () => {
    for (const id of ['retail-orders', 'broadband-support', 'saas-support']) {
      const keys = builtInPackKeys(id);
      expect(typeof english(keys?.name ?? '')).toBe('string');
      expect(typeof english(keys?.description ?? '')).toBe('string');
    }
    expect(builtInPackKeys('own-shop')).toBeUndefined();
  });

  it('says where a pack of the listing comes from: shipped, or the workspace file it is read from', () => {
    const own = { ...RETAIL_ORDERS_PACK, id: 'own-shop' };
    expect(sourceOf({ source: 'built-in', pack: RETAIL_ORDERS_PACK })).toEqual({
      kind: 'built-in',
    });
    expect(
      sourceOf({
        source: 'workspace',
        path: '/w/own.sandforge-scenario.json',
        relativePath: 'own.sandforge-scenario.json',
        pack: own,
      }),
    ).toEqual({
      kind: 'workspace',
      path: '/w/own.sandforge-scenario.json',
      relativePath: 'own.sandforge-scenario.json',
    });
  });

  it('tells a pack edited from the one it was', () => {
    expect(samePack(RETAIL_ORDERS_PACK, structuredClone(RETAIL_ORDERS_PACK))).toBe(true);
    expect(samePack(RETAIL_ORDERS_PACK, { ...RETAIL_ORDERS_PACK, name: 'Other' })).toBe(false);
  });
});
