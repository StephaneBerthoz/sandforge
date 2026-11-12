import { describe, expect, it } from 'vitest';
import { salesOrg } from '../../../test/emptyFixtureOrg';
import { wholeOrgScope } from '../../forge/wholeOrgScope';
import { emptyDescribeSchema, type EmptyDescribe } from './emptyRelations';
import {
  emptyScopeOf,
  emptyingRule,
  settleEmptyScope,
  type EmptyLeftOut,
  type WholeOrgScopeRule,
} from './emptyScope';

/** The reason an object was left out, by its name. */
function reasons(leftOut: readonly EmptyLeftOut[]): Record<string, string> {
  return Object.fromEntries(leftOut.map((entry) => [entry.objectApiName, entry.reason]));
}

const org = salesOrg();
const GLOBAL = org.global();
const TOOLING = ['ApexClass'];

/** The data objects of the fixture people work in and the user may delete, sorted. */
const DATA = [
  'Account',
  'AccountContactRelation',
  'Asset',
  'Campaign',
  'CampaignMember',
  'Case',
  'CaseComment',
  'Contact',
  'Contract',
  'Event',
  'Lead',
  'No_Bin__c',
  'Opportunity',
  'OpportunityContactRole',
  'OpportunityLineItem',
  'Order',
  'OrderItem',
  'Pricebook2',
  'PricebookEntry',
  'Product2',
  'Quote',
  'QuoteLineItem',
  'Survey_Response__c',
  'Task',
];

describe('emptyScopeOf, the whole org', () => {
  it('empties every object people work in that the user may delete, and nothing of the three kinds not asked for', () => {
    const scope = emptyScopeOf(GLOBAL, TOOLING, { mode: 'org' });

    expect(scope.objects).toEqual(DATA);
  });

  it('names every other object of the org with why: setup, feeds, history, sharing, metadata, and custom settings, files and packages not asked for', () => {
    const scope = emptyScopeOf(GLOBAL, TOOLING, { mode: 'org' });

    expect(reasons(scope.leftOut)).toEqual({
      AccountChangeEvent: 'changeEvent',
      AccountFeed: 'chatter',
      AccountHistory: 'history',
      AccountShare: 'sharing',
      ApexClass: 'metadata',
      App_Config__c: 'customSetting',
      Archive__b: 'unsupportedKind',
      Attachment: 'files',
      ContentDocument: 'files',
      ContentDocumentLink: 'heldWithFiles',
      ContentVersion: 'heldWithFiles',
      Document: 'documents',
      FeedItem: 'chatter',
      PermissionSet: 'setup',
      Read_Only__c: 'notDeletable',
      User: 'setup',
      acme__Invoice__c: 'managedPackage',
    });
    expect(scope.objects.length + scope.leftOut.length).toBe(GLOBAL.length);
  });

  it('empties custom settings, files and attachments, and packages’ objects when each is asked for', () => {
    const scope = emptyScopeOf(GLOBAL, TOOLING, {
      mode: 'org',
      customSettings: true,
      files: true,
      managedPackages: true,
    });

    expect(scope.objects).toEqual(
      [...DATA, 'App_Config__c', 'Attachment', 'ContentDocument', 'acme__Invoice__c'].sort(),
    );
    expect(reasons(scope.leftOut)).not.toHaveProperty('App_Config__c');
  });

  it('reads what the user may delete where a copy reads what it may create: a file and an object no one creates are emptied, an object no one deletes is not', () => {
    const scope = emptyScopeOf(GLOBAL, TOOLING, { mode: 'org', files: true });

    expect(scope.objects).toContain('ContentDocument');
    expect(scope.objects).toContain('Survey_Response__c');
    expect(reasons(scope.leftOut)['Read_Only__c']).toBe('notDeletable');
  });

  it('leaves out by name, and says a name the org does not have', () => {
    const scope = emptyScopeOf(GLOBAL, TOOLING, {
      mode: 'org',
      excluded: ['contact', 'Nothing__c'],
    });

    expect(scope.objects).not.toContain('Contact');
    expect(reasons(scope.leftOut)).toMatchObject({
      Contact: 'excludedByUser',
      Nothing__c: 'notFound',
    });
  });

  it('keeps every object people work in as worked, those left out by name or not asked for among them: what goes along is read among them', () => {
    const scope = emptyScopeOf(GLOBAL, TOOLING, { mode: 'org', excluded: ['Contact'] });

    expect(scope.worked).toEqual(
      [...DATA, 'App_Config__c', 'Attachment', 'ContentDocument', 'acme__Invoice__c'].sort(),
    );
  });
});

describe('emptyScopeOf, objects picked', () => {
  it('empties the objects picked, once each whatever their case, and a custom setting, a file or a package’s object picked by name', () => {
    const scope = emptyScopeOf(GLOBAL, TOOLING, {
      mode: 'objects',
      objects: ['account', 'Account', 'App_Config__c', 'ContentDocument', 'acme__Invoice__c'],
    });

    expect(scope.objects).toEqual([
      'Account',
      'App_Config__c',
      'ContentDocument',
      'acme__Invoice__c',
    ]);
    expect(scope.leftOut).toEqual([]);
  });

  it('never empties a feed, setup or what the user may not delete because it was picked, and says each with why', () => {
    const scope = emptyScopeOf(GLOBAL, TOOLING, {
      mode: 'objects',
      objects: ['AccountFeed', 'User', 'PermissionSet', 'Read_Only__c', 'ApexClass', 'Missing__c'],
    });

    expect(scope.objects).toEqual([]);
    expect(reasons(scope.leftOut)).toEqual({
      AccountFeed: 'chatter',
      ApexClass: 'metadata',
      Missing__c: 'notFound',
      PermissionSet: 'setup',
      Read_Only__c: 'notDeletable',
      User: 'setup',
    });
  });
});

describe('the whole-org rule', () => {
  it('is the whole-org rule a clone reads, asked what emptying asks: to query and delete, not to write', () => {
    const emptying = emptyingRule(GLOBAL, TOOLING, { customSettings: false });
    const clone = wholeOrgScope(GLOBAL, TOOLING, 'clone');

    expect(emptying.candidates).toEqual(wholeOrgScope(GLOBAL, TOOLING, 'empty').candidates);
    expect(emptying.candidates).toContain('Survey_Response__c');
    expect(clone.candidates).not.toContain('Survey_Response__c');
  });

  it('reads the rule it is given in place of the emptying one', () => {
    const asked: Array<{ customSettings: boolean }> = [];
    const rule: WholeOrgScopeRule = (global, _tooling, options) => {
      asked.push(options);
      return {
        candidates: global.filter((object) => object.name === 'Lead').map((object) => object.name),
        leftOut: global
          .filter((object) => object.name !== 'Lead')
          .map((object) => ({ objectApiName: object.name, reason: 'setup' as const })),
      };
    };

    const scope = emptyScopeOf(GLOBAL, TOOLING, { mode: 'org' }, rule);

    expect(scope.objects).toEqual(['Lead']);
    expect(reasons(scope.leftOut)['Account']).toBe('setup');
    expect(asked).toEqual([{ customSettings: true }]);
  });

  it('leaves custom settings out unless asked, as the checkpoint’s rule does', () => {
    const without = emptyingRule(GLOBAL, TOOLING, { customSettings: false });
    const withThem = emptyingRule(GLOBAL, TOOLING, { customSettings: true });

    expect(reasons(without.leftOut)['App_Config__c']).toBe('customSetting');
    expect(withThem.candidates).toContain('App_Config__c');
  });
});

describe('settleEmptyScope', () => {
  async function describesOf(names: readonly string[]): Promise<Map<string, EmptyDescribe>> {
    const describes = new Map<string, EmptyDescribe>();
    for (const name of names) {
      try {
        describes.set(name, emptyDescribeSchema.parse(await org.describe(name)));
      } catch {
        // Left undescribed, as the org would not.
      }
    }
    return describes;
  }

  it('leaves out an object with no recycle bin, whose records no undo would bring back, and one the org would not describe, in its words', async () => {
    const scope = emptyScopeOf(GLOBAL, TOOLING, {
      mode: 'objects',
      objects: ['Lead', 'No_Bin__c', 'Case'],
    });
    const describes = await describesOf(['Lead', 'No_Bin__c']);

    const settled = settleEmptyScope(
      scope,
      describes,
      new Map([['Case', 'NOT_FOUND: no such object']]),
    );

    expect(settled.objects).toEqual(['Lead']);
    expect(settled.leftOut).toEqual([
      { objectApiName: 'Case', reason: 'notDescribed', detail: 'NOT_FOUND: no such object' },
      { objectApiName: 'No_Bin__c', reason: 'noRecycleBin' },
    ]);
  });

  it('leaves out an object whose own describe says the user may not delete it, whatever the global describe said', async () => {
    const scope = emptyScopeOf(GLOBAL, TOOLING, { mode: 'objects', objects: ['Lead'] });
    const describes = await describesOf(['Lead']);
    const lead = describes.get('Lead');
    if (!lead) throw new Error('Lead is described');

    const settled = settleEmptyScope(scope, new Map([['Lead', { ...lead, deletable: false }]]));

    expect(settled.objects).toEqual([]);
    expect(reasons(settled.leftOut)).toEqual({ Lead: 'notDeletable' });
  });
});
