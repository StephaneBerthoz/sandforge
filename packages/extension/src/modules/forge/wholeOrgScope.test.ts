import { describe, it, expect } from 'vitest';
import type { ForgeLeftOutObject } from '@sandforge/shared';
import type { GlobalObject } from '../checkpoint/checkpointScope.js';
import { wholeOrgCandidates } from './wholeOrgScope.js';

/** An object the user may query, create, edit and delete, with a page layout. */
function writable(name: string, extra: Partial<GlobalObject> = {}): GlobalObject {
  return {
    name,
    queryable: true,
    createable: true,
    updateable: true,
    deletable: true,
    layoutable: true,
    ...extra,
  };
}

/** The same objects in both orgs. */
function bothOrgs(objects: GlobalObject[]): ReturnType<typeof wholeOrgCandidates> {
  return wholeOrgCandidates(objects, objects, []);
}

/** The left-out entry of `name`, if any. */
function outOf(
  scope: ReturnType<typeof wholeOrgCandidates>,
  name: string,
): ForgeLeftOutObject | undefined {
  return scope.leftOut.find((entry) => entry.objectApiName === name);
}

describe('wholeOrgCandidates', () => {
  it('takes every object the target lets the user write and the source lets the user query', () => {
    const scope = bothOrgs([writable('Account'), writable('Invoice__c')]);

    expect(scope.candidates).toEqual(['Account', 'Invoice__c']);
    expect(scope.leftOut).toEqual([]);
  });

  it("gives each object the checkpoint's rule leaves out the reason the rule gives", () => {
    const scope = bothOrgs([
      writable('FeedItem'),
      writable('AccountHistory'),
      writable('AccountShare'),
      writable('AccountChangeEvent'),
      writable('Archive__b'),
      writable('Order_Event__e'),
      writable('Document'),
      writable('User'),
      writable('Locked__c', { deletable: false }),
    ]);

    expect(scope.candidates).toEqual([]);
    expect(scope.leftOut).toEqual([
      { objectApiName: 'AccountChangeEvent', reason: 'changeEvent' },
      { objectApiName: 'AccountHistory', reason: 'history' },
      { objectApiName: 'AccountShare', reason: 'sharing' },
      { objectApiName: 'Archive__b', reason: 'unsupportedKind' },
      { objectApiName: 'Document', reason: 'files' },
      { objectApiName: 'FeedItem', reason: 'chatter' },
      { objectApiName: 'Locked__c', reason: 'notWritable' },
      { objectApiName: 'Order_Event__e', reason: 'unsupportedKind' },
      { objectApiName: 'User', reason: 'setup' },
    ]);
  });

  it("says metadata of what the target's Tooling API serves", () => {
    const flow = writable('FlowDefinitionView', { createable: false });
    const scope = wholeOrgCandidates([flow], [flow], ['FlowDefinitionView']);

    expect(outOf(scope, 'FlowDefinitionView')).toEqual({
      objectApiName: 'FlowDefinitionView',
      reason: 'metadata',
    });
  });

  it('says noLayout of setup the org gives no page layout, and nothing more of setup named as such', () => {
    const scope = bothOrgs([
      writable('SetupEntityAccess', { layoutable: false }),
      writable('PermissionSet', { layoutable: false }),
    ]);

    expect(outOf(scope, 'SetupEntityAccess')).toEqual({
      objectApiName: 'SetupEntityAccess',
      reason: 'setup',
      detail: 'noLayout',
    });
    expect(outOf(scope, 'PermissionSet')).toEqual({
      objectApiName: 'PermissionSet',
      reason: 'setup',
    });
  });

  it('keeps the objects people work in without a layout, the activities, the emails and a managed package', () => {
    const scope = bothOrgs([
      writable('Task'),
      writable('Event'),
      writable('EmailMessage'),
      writable('EmailMessageRelation', { layoutable: false }),
      writable('vlocity_cmt__Party__c'),
    ]);

    expect(scope.candidates).toEqual([
      'EmailMessage',
      'EmailMessageRelation',
      'Event',
      'Task',
      'vlocity_cmt__Party__c',
    ]);
    expect(scope.leftOut).toEqual([]);
  });

  it('leaves a file and what hangs on one out as objects: they are copied with the records they hang on', () => {
    const scope = bothOrgs([
      writable('ContentDocument', { createable: false }),
      writable('ContentVersion', { deletable: false }),
      writable('ContentDocumentLink'),
      writable('Attachment', { layoutable: false }),
    ]);

    expect(scope.candidates).toEqual([]);
    expect(scope.leftOut).toEqual([
      { objectApiName: 'Attachment', reason: 'files', detail: 'withTheirRecords' },
      { objectApiName: 'ContentDocument', reason: 'files', detail: 'withTheirRecords' },
      { objectApiName: 'ContentDocumentLink', reason: 'files', detail: 'withTheirRecords' },
      { objectApiName: 'ContentVersion', reason: 'files', detail: 'withTheirRecords' },
    ]);
  });

  it('takes a custom setting the target lets the user write, whatever its layout, and says why it leaves another', () => {
    const scope = bothOrgs([
      writable('Endpoints__c', { customSetting: true, layoutable: false }),
      writable('Switches__c', { customSetting: true, layoutable: false, deletable: false }),
    ]);

    expect(scope.candidates).toEqual(['Endpoints__c']);
    expect(scope.leftOut).toEqual([{ objectApiName: 'Switches__c', reason: 'notWritable' }]);
  });

  it('leaves a custom setting the source does not let the user query', () => {
    const scope = wholeOrgCandidates(
      [writable('Endpoints__c', { customSetting: true, queryable: false })],
      [writable('Endpoints__c', { customSetting: true })],
      [],
    );

    expect(scope.candidates).toEqual([]);
    expect(scope.leftOut).toEqual([{ objectApiName: 'Endpoints__c', reason: 'notQueryable' }]);
  });

  it('says what only the source has, what the source will not let the user query, and nothing of what only the target has', () => {
    const scope = wholeOrgCandidates(
      [writable('Account'), writable('Legacy__c'), writable('Hidden__c', { queryable: false })],
      [writable('Account'), writable('Hidden__c'), writable('TargetOnly__c')],
      [],
    );

    expect(scope.candidates).toEqual(['Account']);
    expect(scope.leftOut).toEqual([
      { objectApiName: 'Hidden__c', reason: 'notQueryable' },
      { objectApiName: 'Legacy__c', reason: 'missingInTarget' },
    ]);
  });

  it("names each object as the source does, whatever case the target's describe gives it", () => {
    const scope = wholeOrgCandidates(
      [writable('Invoice__c'), writable('Ledger__History')],
      [writable('invoice__c'), writable('ledger__history')],
      [],
    );

    expect(scope.candidates).toEqual(['Invoice__c']);
    expect(scope.leftOut).toEqual([{ objectApiName: 'Ledger__History', reason: 'history' }]);
  });

  it('sorts both lists by name, in code-unit order', () => {
    const scope = bothOrgs([
      writable('b__c'),
      writable('Zed__c'),
      writable('Alpha__c'),
      writable('ZedShare'),
      writable('AlphaHistory'),
    ]);

    expect(scope.candidates).toEqual(['Alpha__c', 'Zed__c', 'b__c']);
    expect(scope.leftOut.map((entry) => entry.objectApiName)).toEqual(['AlphaHistory', 'ZedShare']);
  });
});
