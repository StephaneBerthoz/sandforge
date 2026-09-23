import { describe, it, expect } from 'vitest';
import {
  excludedByDescribe,
  isExcludedFromCopy,
  isNeverCopied,
  lookupsAtObjectsLeftOut,
} from './excludedObjects.js';

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

  it('excludes the setup objects no describe tells from data', () => {
    // A real run walked into both from a product and an account, and wrote a
    // folder into the target.
    expect(isExcludedFromCopy('AuthProvider')).toBe(true);
    expect(isExcludedFromCopy('Folder')).toBe(true);
  });

  it('excludes what the org says no copy writes, when the caller read it', () => {
    const described = new Set(['ApexClass', 'ContentDocument']);

    expect(isExcludedFromCopy('ApexClass', described)).toBe(true);
    expect(isExcludedFromCopy('ContentDocument', described)).toBe(true);
    expect(isExcludedFromCopy('ApexClass')).toBe(false);
    expect(isExcludedFromCopy('Account', described)).toBe(false);
  });
});

describe('excludedByDescribe', () => {
  it('leaves out what the Tooling API serves and what the data API will not create', () => {
    const excluded = excludedByDescribe(
      [
        { name: 'Account', createable: true },
        { name: 'StaticResource', createable: true },
        { name: 'ExternalDataSource', createable: false },
        { name: 'ContentDocument', createable: false },
      ],
      ['StaticResource', 'ApexClass', 'ExternalDataSource'],
    );

    expect([...excluded].sort()).toEqual([
      'ApexClass',
      'ContentDocument',
      'ExternalDataSource',
      'StaticResource',
    ]);
  });

  it('reads an object whose describe does not say as createable', () => {
    expect(excludedByDescribe([{ name: 'Account' }]).size).toBe(0);
  });
});

describe('isNeverCopied', () => {
  it('covers the objects the platform will not take as data as well as the ones left out', () => {
    expect(isNeverCopied('User')).toBe(true);
    expect(isNeverCopied('ContentVersion')).toBe(true);
    expect(isNeverCopied('AccountHistory')).toBe(true);
    expect(isNeverCopied('ApexClass', new Set(['ApexClass']))).toBe(true);
    expect(isNeverCopied('Order')).toBe(false);
  });
});

describe('lookupsAtObjectsLeftOut', () => {
  const fields = [
    { name: 'OwnerId', referenceTo: ['Group', 'User'] },
    { name: 'AccountId', referenceTo: ['Account'] },
    { name: 'WhatId', referenceTo: ['Account', 'User'] },
    { name: 'Name' },
  ];

  it('names the lookups whose every target no copy creates', () => {
    expect([...lookupsAtObjectsLeftOut(fields)]).toEqual(['OwnerId']);
  });

  it('asks the copy which objects it leaves out, when it says', () => {
    const planned = new Set(['Account']);

    const leftOut = lookupsAtObjectsLeftOut(fields, (name) => !planned.has(name));

    expect([...leftOut]).toEqual(['OwnerId']);
    expect([...lookupsAtObjectsLeftOut(fields, () => true)].sort()).toEqual([
      'AccountId',
      'OwnerId',
      'WhatId',
    ]);
  });
});
