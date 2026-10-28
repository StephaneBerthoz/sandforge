import { describe, expect, it } from 'vitest';

import {
  COVERS_BY_PARENT,
  coverageOf,
  coversAnyObject,
  grantsOf,
  parentsToDescribe,
  type CoverageInput,
  type ObjectGrant,
} from './checkpointAccess.js';
import type { CheckpointDescribe } from './checkpointFields.js';

/** A reference field, as a describe gives it. */
function lookup(name: string, ...referenceTo: string[]) {
  return { name, type: 'reference', referenceTo };
}

/** The fields every record has: its id and who created and changed it, users all. */
const STAMPS = [
  { name: 'Id', type: 'id' },
  lookup('CreatedById', 'User'),
  lookup('LastModifiedById', 'User'),
];

/** A child relationship whose parent's delete takes the child along, or not. */
function child(childSObject: string, field: string, cascadeDelete = true) {
  return { childSObject, field, cascadeDelete };
}

/**
 * The describes of a scratch org's sales and service objects, as far as
 * coverage reads them: who points at whom, and which deletes cascade (N3, N4,
 * P6). OpportunityLineItem, CaseComment and CampaignMember have no
 * permissions of their own.
 */
const DESCRIBES: Record<string, CheckpointDescribe> = {
  Account: {
    name: 'Account',
    fields: [...STAMPS, lookup('OwnerId', 'User')],
    childRelationships: [
      child('Contact', 'AccountId'),
      child('Opportunity', 'AccountId'),
      child('Attachment', 'ParentId'),
    ],
  },
  Contact: {
    name: 'Contact',
    fields: [...STAMPS, lookup('AccountId', 'Account')],
    childRelationships: [child('CampaignMember', 'ContactId')],
  },
  Lead: {
    name: 'Lead',
    fields: [...STAMPS, lookup('OwnerId', 'Group', 'User')],
    childRelationships: [child('CampaignMember', 'LeadId')],
  },
  Campaign: {
    name: 'Campaign',
    fields: [...STAMPS],
    childRelationships: [child('CampaignMember', 'CampaignId')],
  },
  Opportunity: {
    name: 'Opportunity',
    fields: [...STAMPS, lookup('AccountId', 'Account')],
    childRelationships: [child('OpportunityLineItem', 'OpportunityId')],
  },
  OpportunityLineItem: {
    name: 'OpportunityLineItem',
    fields: [
      ...STAMPS,
      lookup('OpportunityId', 'Opportunity'),
      lookup('PricebookEntryId', 'PricebookEntry'),
      lookup('Product2Id', 'Product2'),
    ],
    childRelationships: [],
  },
  PricebookEntry: {
    name: 'PricebookEntry',
    fields: [...STAMPS, lookup('Product2Id', 'Product2')],
    childRelationships: [child('OpportunityLineItem', 'PricebookEntryId', false)],
  },
  Product2: {
    name: 'Product2',
    fields: [...STAMPS],
    childRelationships: [
      child('PricebookEntry', 'Product2Id'),
      child('OpportunityLineItem', 'Product2Id', false),
    ],
  },
  Case: {
    name: 'Case',
    fields: [...STAMPS, lookup('AccountId', 'Account')],
    childRelationships: [child('CaseComment', 'ParentId')],
  },
  CaseComment: {
    name: 'CaseComment',
    fields: [...STAMPS, lookup('ParentId', 'Case')],
    childRelationships: [],
  },
  CampaignMember: {
    name: 'CampaignMember',
    fields: [
      ...STAMPS,
      lookup('CampaignId', 'Campaign'),
      lookup('LeadId', 'Lead'),
      lookup('ContactId', 'Contact'),
      lookup('LeadOrContactId', 'Contact', 'Lead'),
      lookup('LeadOrContactOwnerId', 'Group', 'User'),
    ],
    childRelationships: [],
  },
  Attachment: {
    name: 'Attachment',
    fields: [...STAMPS, lookup('ParentId', 'Account', 'Contact', 'Case')],
    childRelationships: [],
  },
};

const NONE: ObjectGrant = { viewAll: false, modifyAll: false };
const VIEW: ObjectGrant = { viewAll: true, modifyAll: false };
const ALL: ObjectGrant = { viewAll: true, modifyAll: true };

/** Grants by object name, as the guard keys them: in lower case. */
function grants(by: Record<string, ObjectGrant>): Map<string, ObjectGrant> {
  return new Map(Object.entries(by).map(([name, held]) => [name.toLowerCase(), held]));
}

/** The coverage input of `held`, over the describes named, all of them unless told. */
function input(
  held: Record<string, ObjectGrant>,
  describes: readonly string[] = Object.keys(DESCRIBES),
  customSettings: readonly string[] = [],
): CoverageInput {
  return {
    grants: grants(held),
    describes: describes.map((name) => DESCRIBES[name]),
    customSettings,
  };
}

/** The coverage of one object. */
function coverOf(name: string, from: CoverageInput, byParent?: boolean) {
  return coverageOf([name], from, byParent === undefined ? {} : { byParent }).get(name);
}

describe('grantsOf', () => {
  it('adds up every row of an object, View All and Modify All each held when any row holds it, whatever their order', () => {
    const rows = [
      {
        SobjectType: 'Account',
        PermissionsViewAllRecords: true,
        PermissionsModifyAllRecords: true,
      },
      {
        SobjectType: 'Account',
        PermissionsViewAllRecords: false,
        PermissionsModifyAllRecords: false,
      },
      {
        SobjectType: 'Contact',
        PermissionsViewAllRecords: false,
        PermissionsModifyAllRecords: false,
      },
      {
        SobjectType: 'contact',
        PermissionsViewAllRecords: true,
        PermissionsModifyAllRecords: false,
      },
      { SobjectType: '', PermissionsViewAllRecords: true, PermissionsModifyAllRecords: true },
      { PermissionsModifyAllRecords: true },
    ];

    expect(Object.fromEntries(grantsOf(rows))).toEqual({ account: ALL, contact: VIEW });
    expect(Object.fromEntries(grantsOf([...rows].reverse()))).toEqual({
      account: ALL,
      contact: VIEW,
    });
  });

  it('tells whether any object is held by Modify All of its own: without one, nothing can be held', () => {
    expect(coversAnyObject(grants({ Account: VIEW, Contact: NONE }))).toBe(false);
    expect(coversAnyObject(grants({ Account: VIEW, Contact: ALL }))).toBe(true);
    expect(coversAnyObject(new Map())).toBe(false);
  });
});

describe('coverageOf: by the object itself', () => {
  it('holds an object with Modify All on it, which comes with View All', () => {
    expect(coverOf('Account', input({ Account: ALL }))).toEqual({ access: 'object' });
  });

  it('leaves out an object with View All and no Modify All, and one with neither', () => {
    expect(coverOf('Account', input({ Account: VIEW }))).toEqual({ reason: 'noModifyAll' });
    expect(coverOf('Account', input({ Account: NONE }))).toEqual({ reason: 'noViewAll' });
  });

  it('reads an object’s rows whatever the case of its name', () => {
    expect(coverOf('ACCOUNT', input({ account: ALL }))).toEqual({ access: 'object' });
  });
});

describe('coverageOf: by what it hangs from', () => {
  it('holds an opportunity’s products when every opportunity is held, and leaves them out when opportunities are not', () => {
    expect(coverOf('OpportunityLineItem', input({ Opportunity: ALL }))).toEqual({
      access: 'parent',
    });
    expect(coverOf('OpportunityLineItem', input({ Opportunity: VIEW }))).toEqual({
      reason: 'parentNotSeen',
      detail: 'Opportunity, which OpportunityId names, is not held whole',
    });
  });

  it('holds a case’s comments through cases, and nothing through a lookup whose delete does not take the record along', () => {
    expect(coverOf('CaseComment', input({ Case: ALL }))).toEqual({ access: 'parent' });
    // The products and price book entries a line names are no parent it goes with.
    expect(
      coverOf(
        'OpportunityLineItem',
        input({ Opportunity: ALL, Product2: NONE, PricebookEntry: NONE }),
      ),
    ).toEqual({ access: 'parent' });
  });

  it('holds a campaign’s members only when campaigns, leads and contacts are all held', () => {
    const all = { Campaign: ALL, Lead: ALL, Contact: ALL };
    expect(coverOf('CampaignMember', input(all))).toEqual({ access: 'parent' });
    expect(coverOf('CampaignMember', input({ ...all, Lead: VIEW }))).toEqual({
      reason: 'parentNotSeen',
      detail: 'Lead, which LeadId names, is not held whole',
    });
  });

  it('holds nothing through a lookup that may name records of several objects, and one whose delete takes the record along', () => {
    expect(coverOf('Attachment', input({ Account: ALL, Contact: ALL, Case: ALL }))).toEqual({
      reason: 'parentNotSeen',
      detail: 'ParentId may name a record of Account, Contact, Case',
    });
  });

  it('holds nothing through a parent it did not describe, and asks for it to be described', () => {
    const scope = ['OpportunityLineItem', 'Opportunity'];
    const picked = input({ Opportunity: ALL }, scope);

    expect(coverOf('OpportunityLineItem', picked)).toEqual({
      reason: 'parentNotSeen',
      detail: 'PricebookEntry, which PricebookEntryId names, could not be described',
    });
    expect(parentsToDescribe(scope, picked)).toEqual(['PricebookEntry', 'Product2']);
    // Once described, the line hangs from its opportunity alone.
    expect(
      coverOf(
        'OpportunityLineItem',
        input({ Opportunity: ALL }, [...scope, 'PricebookEntry', 'Product2']),
      ),
    ).toEqual({ access: 'parent' });
  });

  it('asks for no describe of a parent of an object held by its own rows, of one left out whatever it hangs from, nor of a lookup that may name several objects', () => {
    const scope = ['Contact', 'Task', 'Attachment', 'CampaignMember'];
    const describes = [
      ...scope.filter((name) => name !== 'Task').map((name) => DESCRIBES[name]),
      {
        name: 'Task',
        fields: [...STAMPS, lookup('WhatId', 'Account', 'Opportunity')],
        childRelationships: [],
      },
    ];

    const wanted = parentsToDescribe(scope, {
      grants: grants({ Contact: ALL }),
      describes,
    });

    // Contact is held by its own rows; Task is an activity; Attachment's
    // parent may be of several objects. CampaignMember's three parents.
    expect(wanted).toEqual(['Campaign', 'Lead']);
  });

  it('holds nothing through a record that hangs from no record whose delete takes it along', () => {
    const lone: CheckpointDescribe = {
      name: 'Survey__c',
      fields: [...STAMPS, lookup('OwnerId', 'Group', 'User')],
      childRelationships: [],
    };
    expect(coverOf('Survey__c', { grants: new Map(), describes: [lone] })).toEqual({
      reason: 'parentNotSeen',
      detail: 'it hangs from no record whose delete takes it along',
    });
  });

  it('holds a line through a parent itself held through its own parent, and nothing through a loop', () => {
    const chain: CheckpointDescribe[] = [
      DESCRIBES.Opportunity,
      {
        name: 'Quote',
        fields: [...STAMPS, lookup('OpportunityId', 'Opportunity')],
        childRelationships: [child('QuoteLineItem', 'QuoteId')],
      },
      {
        name: 'QuoteLineItem',
        fields: [...STAMPS, lookup('QuoteId', 'Quote')],
        childRelationships: [],
      },
    ];
    chain[0] = {
      ...DESCRIBES.Opportunity,
      childRelationships: [child('Quote', 'OpportunityId')],
    };
    expect(
      coverOf('QuoteLineItem', { grants: grants({ Opportunity: ALL }), describes: chain }),
    ).toEqual({
      access: 'parent',
    });

    const loop: CheckpointDescribe[] = [
      {
        name: 'A__c',
        fields: [...STAMPS, lookup('B__c', 'B__c')],
        childRelationships: [child('B__c', 'A__c')],
      },
      {
        name: 'B__c',
        fields: [...STAMPS, lookup('A__c', 'A__c')],
        childRelationships: [child('A__c', 'B__c')],
      },
    ];
    expect(coverOf('A__c', { grants: new Map(), describes: loop })).toMatchObject({
      reason: 'parentNotSeen',
    });
  });

  it('holds nothing through its parents when the rule is off, as its live proof is open', () => {
    expect(COVERS_BY_PARENT).toBe(true);
    expect(coverOf('CaseComment', input({ Case: ALL }), false)).toEqual({
      reason: 'parentNotSeen',
      detail: 'held through its parents is not proven',
    });
    // An object held by its own rows is held all the same.
    expect(coverOf('Case', input({ Case: ALL }), false)).toEqual({ access: 'object' });
  });
});

describe('coverageOf: always left out without View All Data and Modify All Data', () => {
  it('leaves out tasks and events, products and price books, files and custom settings, whatever the user holds on them', () => {
    const everything = Object.fromEntries(
      [
        'Task',
        'Event',
        'Product2',
        'Pricebook2',
        'PricebookEntry',
        'ContentDocument',
        'Switches__c',
      ].map((name) => [name, ALL]),
    );
    const from = input(everything, Object.keys(DESCRIBES), ['switches__C']);

    const coverage = coverageOf(
      [
        'Task',
        'Event',
        'Product2',
        'Pricebook2',
        'PricebookEntry',
        'ContentDocument',
        'Switches__c',
      ],
      from,
    );

    expect(Object.fromEntries(coverage)).toEqual({
      Task: { reason: 'activities' },
      Event: { reason: 'activities' },
      Product2: { reason: 'catalog' },
      Pricebook2: { reason: 'catalog' },
      PricebookEntry: { reason: 'catalog' },
      ContentDocument: { reason: 'filesNotProven' },
      Switches__c: { reason: 'settingNotProven' },
    });
  });

  it('holds nothing through a parent always left out', () => {
    const items: CheckpointDescribe = {
      name: 'PriceNote__c',
      fields: [...STAMPS, lookup('Entry__c', 'PricebookEntry')],
      childRelationships: [],
    };
    const entry: CheckpointDescribe = {
      ...DESCRIBES.PricebookEntry,
      childRelationships: [child('PriceNote__c', 'Entry__c')],
    };
    expect(
      coverOf('PriceNote__c', {
        grants: grants({ PricebookEntry: ALL }),
        describes: [items, entry],
      }),
    ).toEqual({
      reason: 'parentNotSeen',
      detail: 'PricebookEntry, which Entry__c names, is not held whole',
    });
  });
});
