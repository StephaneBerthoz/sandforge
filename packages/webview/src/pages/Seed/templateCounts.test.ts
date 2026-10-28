import { describe, it, expect } from 'vitest';
import { CRM_STARTER, LEADS_ACTIVITIES_STARTER } from '@sandforge/shared';
import { typedCount, templateWithCounts, withCount } from './templateCounts';

const countsOf = (template: typeof CRM_STARTER): Record<string, number> =>
  Object.fromEntries(template.objects.map((o) => [o.objectApiName, o.recordCount]));

describe('template counts', () => {
  it('reads a typed count as a whole number, 0 for anything else', () => {
    expect(typedCount('12')).toBe(12);
    expect(typedCount('0')).toBe(0);
    expect(typedCount('')).toBe(0);
    expect(typedCount('-3')).toBe(0);
  });

  it('carries a parent’s count down every relation under it', () => {
    const counts = withCount(CRM_STARTER, countsOf(CRM_STARTER), 'Account', 4);
    expect(counts).toMatchObject({
      Account: 4,
      Contact: 12,
      Opportunity: 8,
      OpportunityLineItem: 12,
      Case: 8,
      Product2: 10,
      PricebookEntry: 10,
    });
  });

  it('leaves a child its own count when no relation places it', () => {
    const counts = withCount(CRM_STARTER, countsOf(CRM_STARTER), 'Case', 7);
    expect(counts['Case']).toBe(7);
    expect(counts['Contact']).toBe(75);
  });

  it('leaves out an object at 0 and every object that needs it, keeping the rest whole', () => {
    const counts = withCount(CRM_STARTER, countsOf(CRM_STARTER), 'Product2', 0);
    const sent = templateWithCounts(CRM_STARTER, counts);
    // The line items need the prices, which need the products.
    expect(sent.objects.map((o) => o.objectApiName)).toEqual([
      'Account',
      'Contact',
      'Opportunity',
      'Case',
    ]);
    expect(sent.relations?.map((r) => `${r.childObject}.${r.lookupField}`)).toEqual([
      'Contact.AccountId',
      'Opportunity.AccountId',
      'Case.ContactId',
    ]);
    // The opportunities point at the standard price book, which no run writes.
    expect(sent.objects.find((o) => o.objectApiName === 'Opportunity')).toBe(
      CRM_STARTER.objects.find((o) => o.objectApiName === 'Opportunity'),
    );
  });

  it('leaves out the members of campaigns left out, and keeps the leads and their activities', () => {
    const sent = templateWithCounts(LEADS_ACTIVITIES_STARTER, {
      ...countsOf(LEADS_ACTIVITIES_STARTER),
      Campaign: 0,
    });
    expect(sent.objects.map((o) => o.objectApiName)).toEqual(['Lead', 'Task', 'Event']);
  });

  it('hands back the template itself when nothing is left out', () => {
    expect(templateWithCounts(CRM_STARTER, countsOf(CRM_STARTER))).toBe(CRM_STARTER);
  });

  it('leaves a relation whose parents are named by id as it is: its children follow no count of the page', () => {
    // An environment hands a seed the ids another resource created; the page
    // sets no count of them, and keeps the relation whole.
    const named = {
      ...CRM_STARTER,
      relations: (CRM_STARTER.relations ?? []).map((relation) =>
        relation.childObject === 'Contact'
          ? { ...relation, parents: { kind: 'records' as const, ids: ['001000000000001AAA'] } }
          : relation,
      ),
    };
    const counts = withCount(named, countsOf(named), 'Account', 4);
    expect(counts['Contact']).toBe(countsOf(named)['Contact']);
    const sent = templateWithCounts(named, { ...counts, Account: 0 });
    expect(sent.relations?.find((r) => r.childObject === 'Contact')?.parents).toEqual({
      kind: 'records',
      ids: ['001000000000001AAA'],
    });
  });

  it('leaves a child placed by key its own count: its records are its rows, whatever its parents number', () => {
    const keyed = {
      ...CRM_STARTER,
      relations: (CRM_STARTER.relations ?? []).map((relation) =>
        relation.childObject === 'Contact'
          ? { ...relation, distribution: { mode: 'byKey' as const } }
          : relation,
      ),
    };
    const counts = withCount(keyed, countsOf(keyed), 'Account', 4);
    expect(counts['Contact']).toBe(countsOf(keyed)['Contact']);
  });
});
