import { describe, it, expect } from 'vitest';
import { forgeLeftOutReasonSchema, type ForgeLeftOutObject } from '@sandforge/shared';
import type { GlobalObject } from '../checkpoint/checkpointScope.js';
import type { CreateFacts } from './targetCreators.js';
import { wholeOrgCandidates, wholeOrgScope } from './wholeOrgScope.js';

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
function bothOrgs(
  objects: GlobalObject[],
  options?: Parameters<typeof wholeOrgCandidates>[3],
): ReturnType<typeof wholeOrgCandidates> {
  return wholeOrgCandidates(objects, objects, [], options);
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

  it('says the records Salesforce alone creates are its own, never that the user may not write them', () => {
    // As an administrator's describe gives them: none createable, an
    // approval's submission deletable. Said "not writable", Review would have
    // asked the target's administrator for a Create no user can be granted.
    const scope = bothOrgs([
      writable('ProcessInstance', { createable: false, updateable: false }),
      writable('ApprovalSubmission', { createable: false }),
      writable('AIInsightReason', { createable: false, deletable: false }),
      writable('Invoice', { createable: false }),
    ]);

    expect(scope.candidates).toEqual([]);
    expect(scope.leftOut).toEqual([
      { objectApiName: 'AIInsightReason', reason: 'platformCreated' },
      { objectApiName: 'ApprovalSubmission', reason: 'platformCreated' },
      { objectApiName: 'Invoice', reason: 'platformCreated' },
      { objectApiName: 'ProcessInstance', reason: 'platformCreated' },
    ]);
  });

  it('gives every reason it says a name the contract knows', () => {
    const scope = bothOrgs(
      [
        writable('FeedItem'),
        writable('AccountHistory'),
        writable('AccountShare'),
        writable('AccountChangeEvent'),
        writable('Archive__b'),
        writable('Endpoints__c', { customSetting: true }),
        writable('Document'),
        writable('ContentVersion'),
        writable('User'),
        writable('ProcessInstance', { createable: false }),
        writable('FlowDefinitionView', { createable: false }),
        writable('Locked__c', { deletable: false }),
        writable('Gone__c'),
        writable('vlocity_cmt__Party__c'),
      ],
      { excluded: ['Gone__c'] },
    );

    const reasons = new Set(scope.leftOut.map((entry) => entry.reason));
    expect([...reasons].sort()).toEqual(
      [
        'chatter',
        'history',
        'sharing',
        'changeEvent',
        'unsupportedKind',
        'customSetting',
        'files',
        'setup',
        'platformCreated',
        'notWritable',
        'excludedByUser',
        'neverCopied',
      ].sort(),
    );
    for (const entry of scope.leftOut) {
      expect(forgeLeftOutReasonSchema.safeParse(entry.reason).success).toBe(true);
    }
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

  it('leaves out the logs, setup and histories every Forge clone leaves out, whatever the describe says', () => {
    // Each one described writable, as no describe of them reads: what
    // excludedObjects names is left out by its name.
    const scope = bothOrgs([
      writable('OpportunityRelatedDeleteLog'),
      writable('CaseHistory2'),
      writable('Calendar'),
      writable('Dashboard'),
      writable('AppUsageAssignment'),
      writable('Folder'),
      writable('ThreatDetectionEventStore'),
    ]);

    expect(scope.candidates).toEqual([]);
    expect(scope.leftOut.map((entry) => [entry.objectApiName, entry.reason])).toEqual([
      ['AppUsageAssignment', 'setup'],
      ['Calendar', 'setup'],
      ['CaseHistory2', 'history'],
      ['Dashboard', 'setup'],
      ['Folder', 'setup'],
      ['OpportunityRelatedDeleteLog', 'setup'],
      ['ThreatDetectionEventStore', 'setup'],
    ]);
  });

  it("leaves an industry package's objects out, as every Forge clone does, and keeps another package's", () => {
    const scope = bothOrgs([
      writable('vlocity_cmt__Party__c'),
      writable('vlocity_ins__Policy__c'),
      writable('acme__Ledger__c'),
      writable('Vlocity__c'),
    ]);

    expect(scope.candidates).toEqual(['Vlocity__c', 'acme__Ledger__c']);
    expect(scope.leftOut).toEqual([
      { objectApiName: 'vlocity_cmt__Party__c', reason: 'neverCopied' },
      { objectApiName: 'vlocity_ins__Policy__c', reason: 'neverCopied' },
    ]);
  });

  it('keeps the objects people work in without a layout, the activities and the emails', () => {
    const scope = bothOrgs([
      writable('Task'),
      writable('Event'),
      writable('EmailMessage'),
      writable('EmailMessageRelation', { layoutable: false }),
    ]);

    expect(scope.candidates).toEqual(['EmailMessage', 'EmailMessageRelation', 'Event', 'Task']);
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

  it('takes no custom setting unasked: they are configuration, an endpoint among them', () => {
    const scope = bothOrgs([
      writable('Account'),
      writable('Endpoints__c', { customSetting: true, layoutable: false }),
    ]);

    expect(scope.candidates).toEqual(['Account']);
    expect(scope.leftOut).toEqual([{ objectApiName: 'Endpoints__c', reason: 'customSetting' }]);
  });

  it('takes the custom settings asked for that the target lets the user write, whatever their layout, and says why it leaves another', () => {
    const scope = bothOrgs(
      [
        writable('Endpoints__c', { customSetting: true, layoutable: false }),
        writable('Switches__c', { customSetting: true, layoutable: false, deletable: false }),
      ],
      { customSettings: 'all' },
    );

    expect(scope.candidates).toEqual(['Endpoints__c']);
    expect(scope.leftOut).toEqual([{ objectApiName: 'Switches__c', reason: 'notWritable' }]);
  });

  it('says a custom setting named that the target does not hold is one it lacks, once', () => {
    const scope = wholeOrgCandidates(
      [writable('Endpoints__c', { customSetting: true })],
      [writable('Account')],
      [],
      { customSettings: ['Endpoints__c'] },
    );

    expect(scope.leftOut).toEqual([{ objectApiName: 'Endpoints__c', reason: 'missingInTarget' }]);
  });

  it('leaves a custom setting the source does not let the user query', () => {
    const scope = wholeOrgCandidates(
      [writable('Endpoints__c', { customSetting: true, queryable: false })],
      [writable('Endpoints__c', { customSetting: true })],
      [],
      { customSettings: 'all' },
    );

    expect(scope.candidates).toEqual([]);
    expect(scope.leftOut).toEqual([{ objectApiName: 'Endpoints__c', reason: 'notQueryable' }]);
  });

  it('leaves out an object the user asked to leave out, said so', () => {
    const scope = bothOrgs([writable('Account'), writable('Invoice__c')], {
      excluded: ['invoice__c'],
    });

    expect(scope.candidates).toEqual(['Account']);
    expect(scope.leftOut).toEqual([{ objectApiName: 'Invoice__c', reason: 'excludedByUser' }]);
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

  describe('what the target says of who may be given Create', () => {
    /** Objects the user may not create in the target, beside one they may. */
    const objects = [
      writable('Account'),
      writable('Report__c', { createable: false }),
      writable('Licensed__c', { createable: false }),
      writable('OrderLine__c', { createable: false }),
      writable('Locked__c', { deletable: false }),
    ];

    it('says setup of what no user can create, not even with Modify All Data, and what opens the others', () => {
      const facts: CreateFacts = {
        coverable: new Set(['account', 'licensed__c', 'locked__c']),
        modifyAllData: true,
      };

      const scope = bothOrgs(objects, { createFacts: facts });

      expect(scope.candidates).toEqual(['Account']);
      expect(scope.leftOut).toEqual([
        { objectApiName: 'Licensed__c', reason: 'notWritable', detail: 'feature' },
        { objectApiName: 'Locked__c', reason: 'notWritable' },
        { objectApiName: 'OrderLine__c', reason: 'setup' },
        { objectApiName: 'Report__c', reason: 'setup' },
      ]);
    });

    it('names the parent that may open an object to a user without Modify All Data, and the grant of another', () => {
      const facts: CreateFacts = {
        coverable: new Set(['account', 'licensed__c']),
        modifyAllData: false,
      };

      const scope = bothOrgs(objects, { createFacts: facts });

      expect(scope.leftOut).toEqual([
        { objectApiName: 'Licensed__c', reason: 'notWritable' },
        { objectApiName: 'Locked__c', reason: 'notWritable' },
        { objectApiName: 'OrderLine__c', reason: 'notWritable', detail: 'parent' },
        { objectApiName: 'Report__c', reason: 'notWritable', detail: 'parent' },
      ]);
    });

    it('says only that the user may not write an object when the target said nothing of who may', () => {
      const scope = bothOrgs(objects);

      expect(
        scope.leftOut.map((entry) => [entry.objectApiName, entry.reason, entry.detail]),
      ).toEqual([
        ['Licensed__c', 'notWritable', undefined],
        ['Locked__c', 'notWritable', undefined],
        ['OrderLine__c', 'notWritable', undefined],
        ['Report__c', 'notWritable', undefined],
      ]);
    });

    it('asks a file no Create: the data API creates none', () => {
      const facts: CreateFacts = { coverable: new Set(), modifyAllData: true };

      const scope = bothOrgs(
        [writable('ContentDocument', { createable: false, deletable: false })],
        {
          createFacts: facts,
        },
      );

      expect(scope.leftOut).toEqual([{ objectApiName: 'ContentDocument', reason: 'notWritable' }]);
    });
  });
});

describe('wholeOrgScope', () => {
  /** The candidates and the reasons of `act` over `org`. */
  function settled(org: GlobalObject[], act: 'clone' | 'empty') {
    const scope = wholeOrgScope(org, [], act);
    return {
      candidates: scope.candidates,
      leftOut: scope.leftOut.map((entry) => [entry.objectApiName, entry.reason]),
    };
  }

  it('empties what the user may query and delete, where a clone asks to create and edit too', () => {
    const org = [
      writable('Account'),
      writable('Imported__c', { createable: false, updateable: false }),
      writable('Kept__c', { deletable: false }),
    ];

    expect(settled(org, 'clone')).toEqual({
      candidates: ['Account'],
      leftOut: [
        ['Imported__c', 'notWritable'],
        ['Kept__c', 'notWritable'],
      ],
    });
    expect(settled(org, 'empty')).toEqual({
      candidates: ['Account', 'Imported__c'],
      leftOut: [['Kept__c', 'notWritable']],
    });
  });

  it('empties a file its user may delete, where a clone and a checkpoint ask to edit it', () => {
    const org = [writable('ContentDocument', { createable: false, updateable: false })];

    expect(settled(org, 'clone').leftOut).toEqual([['ContentDocument', 'notWritable']]);
    expect(settled(org, 'empty').candidates).toEqual(['ContentDocument']);
  });

  it('leaves out for an emptying what it leaves out of a clone, by the same reasons', () => {
    const org = [
      writable('FeedItem'),
      writable('AccountHistory'),
      writable('AccountShare'),
      writable('User'),
      writable('ProcessInstance', { createable: false }),
      writable('Archive__b'),
      writable('Endpoints__c', { customSetting: true }),
      writable('SetupEntityAccess', { layoutable: false }),
      writable('FlowDefinitionView'),
    ];
    const tooling = ['FlowDefinitionView'];

    const clone = wholeOrgScope(org, tooling, 'clone').leftOut;
    const empty = wholeOrgScope(org, tooling, 'empty').leftOut;

    expect(empty).toEqual(clone);
    expect(empty.map((entry) => entry.reason)).toEqual([
      'history',
      'sharing',
      'unsupportedKind',
      'customSetting',
      'chatter',
      'metadata',
      'platformCreated',
      'setup',
      'setup',
    ]);
  });

  it('empties the custom settings named, and those alone', () => {
    const org = [
      writable('Endpoints__c', { customSetting: true }),
      writable('Switches__c', { customSetting: true }),
    ];

    const scope = wholeOrgScope(org, [], 'empty', { customSettings: ['Switches__c'] });

    expect(scope.candidates).toEqual(['Switches__c']);
    expect(scope.leftOut).toEqual([{ objectApiName: 'Endpoints__c', reason: 'customSetting' }]);
  });

  it('leaves out the objects excluded by name', () => {
    const scope = wholeOrgScope([writable('Account'), writable('Case')], [], 'empty', {
      excluded: ['Case'],
    });

    expect(scope.candidates).toEqual(['Account']);
    expect(scope.leftOut).toEqual([{ objectApiName: 'Case', reason: 'excludedByUser' }]);
  });
});
