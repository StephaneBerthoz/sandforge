import { describe, it, expect } from 'vitest';
import { isExcludedFromCopy } from './excludedObjects.js';

describe('isExcludedFromCopy', () => {
  it('excludes the objects only one of the two former lists refused', () => {
    // Formerly refused by discovery but fetched by orphan expansion...
    expect(isExcludedFromCopy('AsyncApexJob')).toBe(true);
    expect(isExcludedFromCopy('CronTrigger')).toBe(true);
    expect(isExcludedFromCopy('LoginHistory')).toBe(true);
    // ...and the other way round.
    expect(isExcludedFromCopy('Queue')).toBe(true);
    expect(isExcludedFromCopy('PermissionSet')).toBe(true);
  });

  it('excludes history, feed, share and change-event variants of any object', () => {
    for (const name of [
      'CaseHistory',
      'AccountFeed',
      'Invoice__Share',
      'ContactChangeEvent',
      'Invoice__hd',
      'Invoice__Tag',
    ]) {
      expect(isExcludedFromCopy(name)).toBe(true);
    }
  });

  it('excludes Vlocity package objects whatever the package flavour', () => {
    expect(isExcludedFromCopy('vlocity_ins__Party__c')).toBe(true);
    expect(isExcludedFromCopy('vlocity_cmt__CatalogProductRelationship__c')).toBe(true);
  });

  it('excludes the app usage tag the platform manages itself', () => {
    // Written onto a quote by a copy, it was refused: "you can't modify
    // quotes with an app usage assignment".
    expect(isExcludedFromCopy('AppUsageAssignment')).toBe(true);
  });

  it('keeps the data objects a clone is for', () => {
    for (const name of ['Account', 'Contact', 'Case', 'Asset', 'Invoice__c', 'Vlocity__c']) {
      expect(isExcludedFromCopy(name)).toBe(false);
    }
  });
});
