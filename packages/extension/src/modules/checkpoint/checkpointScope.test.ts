import { describe, expect, it } from 'vitest';
import { removalOrder } from '../forge/ForgeRunRemoval';
import { MemoryRemovalOrg, type MemoryChild } from '../../test/memoryRemovalOrg';
import type { CheckpointDescribe } from './checkpointFields';
import {
  childrenFirst,
  namespaceOf,
  resolveScope,
  scopeCandidates,
  withoutRefusedReads,
  type GlobalObject,
  type ScopeLeftOut,
} from './checkpointScope';

/** An object the user may query, create, edit and delete. */
function data(name: string, extra: Partial<GlobalObject> = {}): GlobalObject {
  return { name, queryable: true, createable: true, updateable: true, deletable: true, ...extra };
}

/** The reason an object was left out, by its name. */
function reasons(leftOut: readonly ScopeLeftOut[]): Record<string, string> {
  return Object.fromEntries(leftOut.map((entry) => [entry.objectApiName, entry.reason]));
}

/** A describe with a `SystemModstamp`, and the child relationships given. */
function described(
  name: string,
  children: CheckpointDescribe['childRelationships'] = [],
): CheckpointDescribe {
  return {
    name,
    fields: [
      { name: 'Id', type: 'id' },
      { name: 'SystemModstamp', type: 'datetime' },
    ],
    childRelationships: children,
  };
}

/** Every object of an org such as a Developer Edition lists, each rule of the scope met once. */
const ORG: GlobalObject[] = [
  data('Account'),
  data('Contact'),
  data('Case'),
  data('Task'),
  data('Event'),
  data('vlocity_cmt__Party__c'),
  data('vlocity_cmt__PartyRelationship__c'),
  data('Vlocity__c'),
  data('acme__Invoice__c'),
  data('FeedItem'),
  data('FeedComment'),
  data('FeedAttachment'),
  data('AccountFeed'),
  data('Case__Feed'),
  data('AccountHistory'),
  data('Case__History'),
  data('Rating__hd'),
  data('AccountShare'),
  data('Case__Share'),
  data('AccountChangeEvent'),
  data('Archive__b'),
  data('Legacy_Order__x'),
  data('Unified_Individual__dlm'),
  data('FAQ__kav'),
  data('FAQ__ka'),
  data('Order_Placed__e'),
  data('App_Config__c', { customSetting: true }),
  data('ContentVersion'),
  data('Attachment'),
  data('ContentDocument'),
  data('ContentDocumentLink'),
  data('User', { deletable: false }),
  data('PermissionSet'),
  data('LoginHistory', { createable: false, updateable: false, deletable: false }),
  data('AsyncApexJob', { createable: false, updateable: false }),
  data('ApexClass', { createable: false, updateable: false }),
  data('PricingProcedure'),
  data('Survey_Response__c', { updateable: false }),
  data('AggregateThing', { queryable: false }),
];

describe('scopeCandidates', () => {
  it('holds every object people work in, empty or not, and the objects of a managed package with them', () => {
    const { candidates } = scopeCandidates(ORG, { mode: 'everything' }, [
      'ApexClass',
      'PricingProcedure',
    ]);

    expect(candidates).toEqual([
      'Account',
      'Case',
      'Contact',
      'Event',
      'Task',
      'Vlocity__c',
      'acme__Invoice__c',
      'vlocity_cmt__PartyRelationship__c',
      'vlocity_cmt__Party__c',
    ]);
  });

  it('leaves out Chatter posts, history, sharing, change events, custom settings, files and the six kinds of object a rewind cannot put back, each named with why', () => {
    const { leftOut } = scopeCandidates(ORG, { mode: 'everything' }, [
      'ApexClass',
      'PricingProcedure',
    ]);

    expect(reasons(leftOut)).toEqual({
      AccountChangeEvent: 'changeEvent',
      AccountFeed: 'chatter',
      AccountHistory: 'history',
      AccountShare: 'sharing',
      AggregateThing: 'notWritable',
      ApexClass: 'metadata',
      App_Config__c: 'customSetting',
      Archive__b: 'unsupportedKind',
      AsyncApexJob: 'setup',
      Attachment: 'files',
      Case__Feed: 'chatter',
      Case__History: 'history',
      Case__Share: 'sharing',
      ContentDocument: 'files',
      ContentDocumentLink: 'files',
      ContentVersion: 'files',
      FAQ__ka: 'unsupportedKind',
      FAQ__kav: 'unsupportedKind',
      FeedAttachment: 'chatter',
      FeedComment: 'chatter',
      FeedItem: 'chatter',
      Legacy_Order__x: 'unsupportedKind',
      LoginHistory: 'history',
      Order_Placed__e: 'unsupportedKind',
      PermissionSet: 'setup',
      PricingProcedure: 'metadata',
      Rating__hd: 'history',
      Survey_Response__c: 'notWritable',
      Unified_Individual__dlm: 'unsupportedKind',
      User: 'setup',
    });
    expect(leftOut.map((entry) => entry.objectApiName)).toEqual(
      [...leftOut.map((entry) => entry.objectApiName)].sort(),
    );
  });

  it('applies the same rules to the objects a person picks, and names a pick the org does not have', () => {
    const scope = scopeCandidates(ORG, {
      mode: 'picked',
      objects: ['Case', 'feeditem', 'App_Config__c', 'Case', 'vlocity_cmt__Party__c', 'Ghost__c'],
    });

    expect(scope.mode).toBe('picked');
    expect(scope.candidates).toEqual(['Case', 'vlocity_cmt__Party__c']);
    expect(reasons(scope.leftOut)).toEqual({
      App_Config__c: 'customSetting',
      FeedItem: 'chatter',
      Ghost__c: 'notFound',
    });
  });

  it('leaves out what its owner excludes, whatever the case of the name', () => {
    const scope = scopeCandidates(ORG, { mode: 'everything', excluded: ['case', 'FeedItem'] });

    expect(scope.candidates).not.toContain('Case');
    expect(reasons(scope.leftOut)).toMatchObject({
      Case: 'excludedByUser',
      FeedItem: 'excludedByUser',
    });
  });

  it('reads a flag the global describe leaves out as a refusal of that right', () => {
    const { candidates, leftOut } = scopeCandidates([{ name: 'Thing__c', queryable: true }], {
      mode: 'everything',
    });

    expect(candidates).toEqual([]);
    expect(reasons(leftOut)).toEqual({ Thing__c: 'notWritable' });
  });
});

describe('namespaceOf', () => {
  it('reads the managed package of a namespaced object, and none of an org’s own', () => {
    expect(namespaceOf('vlocity_cmt__Party__c')).toBe('vlocity_cmt');
    expect(namespaceOf('acme__Invoice__c')).toBe('acme');
    expect(namespaceOf('Vlocity__c')).toBeUndefined();
    expect(namespaceOf('Account')).toBeUndefined();
    expect(namespaceOf('__Odd__c')).toBeUndefined();
  });
});

describe('resolveScope', () => {
  it('reads children first and lists the managed packages’ objects by package', () => {
    const candidates = scopeCandidates(ORG, { mode: 'everything' }, [
      'ApexClass',
      'PricingProcedure',
    ]);
    const describes = new Map(
      candidates.candidates.map((name) => [name, described(name)] as const),
    );
    describes.set(
      'Account',
      described('Account', [
        { childSObject: 'Contact', field: 'AccountId', cascadeDelete: true },
        { childSObject: 'Case', field: 'AccountId' },
        { childSObject: 'Task', field: 'WhatId', cascadeDelete: true },
        { childSObject: 'vlocity_cmt__Party__c', field: 'vlocity_cmt__AccountId__c' },
      ]),
    );
    describes.set('Contact', described('Contact', [{ childSObject: 'Case', field: 'ContactId' }]));
    describes.set(
      'vlocity_cmt__Party__c',
      described('vlocity_cmt__Party__c', [
        {
          childSObject: 'vlocity_cmt__PartyRelationship__c',
          field: 'vlocity_cmt__SourcePartyId__c',
        },
      ]),
    );

    const scope = resolveScope(candidates, describes);
    const order = scope.objects.map((object) => object.objectApiName);

    expect(order.indexOf('Case')).toBeLessThan(order.indexOf('Contact'));
    expect(order.indexOf('Contact')).toBeLessThan(order.indexOf('Account'));
    expect(order.indexOf('Task')).toBeLessThan(order.indexOf('Account'));
    expect(order.indexOf('vlocity_cmt__PartyRelationship__c')).toBeLessThan(
      order.indexOf('vlocity_cmt__Party__c'),
    );
    expect(order.indexOf('vlocity_cmt__Party__c')).toBeLessThan(order.indexOf('Account'));
    expect(scope.objects.map((object) => object.readOrder)).toEqual(order.map((_, at) => at));
    expect(scope.objects.find((o) => o.objectApiName === 'vlocity_cmt__Party__c')?.namespace).toBe(
      'vlocity_cmt',
    );
    expect(scope.packages).toEqual([
      { namespace: 'acme', objects: ['acme__Invoice__c'] },
      {
        namespace: 'vlocity_cmt',
        objects: ['vlocity_cmt__PartyRelationship__c', 'vlocity_cmt__Party__c'],
      },
    ]);
    expect(scope.leftOut).toEqual(candidates.leftOut);
  });

  it('leaves out an object without a SystemModstamp, and one the org would not describe, with its words', () => {
    const candidates = scopeCandidates([data('Account'), data('Odd__c'), data('Case')], {
      mode: 'everything',
    });
    const describes = new Map([
      ['Account', described('Account')],
      ['Odd__c', { name: 'Odd__c', fields: [{ name: 'Id', type: 'id' }] }],
    ]);

    const scope = resolveScope(
      candidates,
      describes,
      new Map([['Case', 'INVALID_TYPE: sObject type Case is not supported']]),
    );

    expect(scope.objects.map((object) => object.objectApiName)).toEqual(['Account']);
    expect(scope.leftOut).toEqual([
      {
        objectApiName: 'Case',
        reason: 'notDescribed',
        detail: 'INVALID_TYPE: sObject type Case is not supported',
      },
      { objectApiName: 'Odd__c', reason: 'noSystemModstamp' },
    ]);
  });
});

describe('withoutRefusedReads', () => {
  it('leaves out an object the org will not read whole, with its words, and keeps the rest in order', () => {
    const candidates = scopeCandidates(
      [data('Account'), data('Contact'), data('acme__Invoice__c'), data('VoiceCall')],
      { mode: 'everything' },
    );
    const describes = new Map(
      candidates.candidates.map((name) => [name, described(name)] as const),
    );
    describes.set(
      'Account',
      described('Account', [{ childSObject: 'Contact', field: 'AccountId' }]),
    );
    const scope = resolveScope(candidates, describes);
    const refusal =
      'MALFORMED_QUERY: Implementation restriction: VoiceCall requires a filter by a single Id';

    const read = withoutRefusedReads(
      scope,
      new Map([
        ['VoiceCall', refusal],
        ['acme__Invoice__c', 'MALFORMED_QUERY: Implementation restriction'],
      ]),
    );

    expect(read.objects).toEqual([
      { objectApiName: 'Contact', readOrder: 0 },
      { objectApiName: 'Account', readOrder: 1 },
    ]);
    expect(read.leftOut).toEqual([
      { objectApiName: 'VoiceCall', reason: 'unreadable', detail: refusal },
      {
        objectApiName: 'acme__Invoice__c',
        reason: 'unreadable',
        detail: 'MALFORMED_QUERY: Implementation restriction',
      },
    ]);
    expect(read.packages).toEqual([]);
  });

  it('leaves the scope as it was when the org refused nothing', () => {
    const scope = resolveScope(
      scopeCandidates([data('Account')], { mode: 'everything' }),
      new Map([['Account', described('Account')]]),
    );

    expect(withoutRefusedReads(scope, new Map())).toBe(scope);
  });
});

describe('childrenFirst', () => {
  it('reads objects in the order a removal deletes them in', async () => {
    const relationships: Record<string, MemoryChild[]> = {
      Account: [
        { childSObject: 'Contact', field: 'AccountId', cascadeDelete: true },
        { childSObject: 'Opportunity', field: 'AccountId' },
        { childSObject: 'Case', field: 'AccountId' },
        { childSObject: 'Account', field: 'ParentId' },
      ],
      Contact: [
        { childSObject: 'Case', field: 'ContactId' },
        { childSObject: 'OpportunityContactRole', field: 'ContactId', cascadeDelete: true },
      ],
      Opportunity: [
        { childSObject: 'OpportunityLineItem', field: 'OpportunityId', cascadeDelete: true },
        { childSObject: 'OpportunityContactRole', field: 'OpportunityId', cascadeDelete: true },
      ],
      Product2: [{ childSObject: 'OpportunityLineItem', field: 'Product2Id' }],
      // Two objects that point at each other: the order given decides.
      Widget__c: [{ childSObject: 'Gadget__c', field: 'Widget__c' }],
      Gadget__c: [{ childSObject: 'Widget__c', field: 'Gadget__c' }],
    };
    const names = [
      'Account',
      'Case',
      'Contact',
      'Gadget__c',
      'Opportunity',
      'OpportunityContactRole',
      'OpportunityLineItem',
      'Product2',
      'Widget__c',
    ];
    const org = new MemoryRemovalOrg(relationships);
    const describes = new Map(
      names.map(
        (name) =>
          [
            name,
            described(
              name,
              (relationships[name] ?? []).map((child) => ({ ...child })),
            ),
          ] as const,
      ),
    );

    const removal = await removalOrder(
      org,
      names.map((objectApiName) => ({ objectApiName })),
    );
    const read = childrenFirst(names, describes);

    expect(read).toEqual(removal.map((object) => object.objectApiName));
    expect(read.indexOf('OpportunityLineItem')).toBeLessThan(read.indexOf('Opportunity'));
    expect(read.indexOf('Opportunity')).toBeLessThan(read.indexOf('Account'));
  });

  it('places an object without a describe by what the described ones say of it, otherwise in the order given', () => {
    expect(
      childrenFirst(
        ['B', 'A'],
        new Map([['A', described('A', [{ childSObject: 'B', field: 'A__c' }])]]),
      ),
    ).toEqual(['B', 'A']);
    expect(childrenFirst(['A', 'B'], new Map())).toEqual(['A', 'B']);
  });
});
