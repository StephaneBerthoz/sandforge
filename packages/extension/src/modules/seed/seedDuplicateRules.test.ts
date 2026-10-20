import { describe, it, expect, vi } from 'vitest';
import { objectsUnderDuplicateRules } from './seedDuplicateRules';

describe('objectsUnderDuplicateRules', () => {
  it('names the objects an active duplicate rule watches', async () => {
    const query = vi.fn(async (soql: string) => {
      expect(soql).toBe('SELECT SobjectType FROM DuplicateRule WHERE IsActive = true');
      return {
        records: [
          { SobjectType: 'Account' },
          { SobjectType: 'Contact' },
          { SobjectType: 'Account' },
          { SobjectType: null },
        ],
      };
    });
    expect([...((await objectsUnderDuplicateRules({ query })) ?? [])]).toEqual([
      'Account',
      'Contact',
    ]);
  });

  it('says nothing when the org will not say', async () => {
    const query = vi.fn(async () => Promise.reject(new Error('INSUFFICIENT_ACCESS')));
    expect(await objectsUnderDuplicateRules({ query })).toBeUndefined();
  });
});
