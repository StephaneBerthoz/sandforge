import { describe, it, expect, vi } from 'vitest';
import type { ForgeTargetAutomation, ForgeTargetObjectAutomation } from '@sandforge/shared';
import { duplicateRulesOf, objectsUnderDuplicateRules } from './seedDuplicateRules';

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

describe('duplicateRulesOf', () => {
  /** A read of the target's automation over `objectsRead`, `objects` running something. */
  const read = (
    objectsRead: string[],
    objects: ForgeTargetObjectAutomation[],
    unread: ForgeTargetAutomation['unread'] = [],
  ): ForgeTargetAutomation => ({
    objectsRead,
    objects,
    unread,
    conditionsNotRead: 0,
    conditionsBound: 25,
    requests: 1,
  });
  const ruled = (objectApiName: string): ForgeTargetObjectAutomation => ({
    objectApiName,
    flows: [],
    triggers: [],
    duplicateRules: [{ name: 'Standard Contact Duplicate Rule', developerName: 'Standard_Rule' }],
  });

  it('says of every object the read looked at whether an active duplicate rule watches it', () => {
    const rules = duplicateRulesOf(read(['Contact', 'Opportunity'], [ruled('Contact')]));
    expect(rules).toEqual(
      new Map([
        ['Contact', true],
        ['Opportunity', false],
      ]),
    );
  });

  it('says nothing of an object that runs something but whose rules the read did not list', () => {
    // A read written before the rules were read leaves them out of its objects.
    const older = { objectApiName: 'Contact', flows: [], triggers: [] };
    expect(duplicateRulesOf(read(['Contact', 'Lead'], [older]))).toEqual(
      new Map([['Lead', false]]),
    );
  });

  it('says nothing when the rules, or the whole automation, could not be read', () => {
    expect(
      duplicateRulesOf(
        read(['Contact'], [], [{ part: 'duplicateRules', reason: 'INSUFFICIENT_ACCESS' }]),
      ),
    ).toBeUndefined();
    expect(duplicateRulesOf({ unread: 'timed out' })).toBeUndefined();
  });

  it('reads the rules whatever else the read could not', () => {
    const rules = duplicateRulesOf(
      read(['Contact'], [], [{ part: 'triggers', reason: 'INSUFFICIENT_ACCESS' }]),
    );
    expect(rules).toEqual(new Map([['Contact', false]]));
  });
});
