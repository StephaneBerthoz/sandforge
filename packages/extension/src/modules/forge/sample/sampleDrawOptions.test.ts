import { describe, expect, it } from 'vitest';
import { countedStorageBytes, isForgeRunGateError } from '../ForgeRunGate';
import {
  SampleDrawInvalid,
  sampleRootsOf,
  sampleRootsReportOf,
  semiJoinsIn,
  type SampleDrawField,
  type SampleRootsInput,
} from './sampleDrawOptions';
import { sampleLinksOf, type SampleField, type SampleObjectInput } from './sampleLinks';

function lookup(
  name: string,
  referenceTo: string | string[],
  extra: Partial<SampleField> = {},
): SampleField {
  return {
    name,
    referenceTo: Array.isArray(referenceTo) ? referenceTo : [referenceTo],
    isMasterDetail: false,
    nillable: true,
    createable: true,
    updateable: true,
    ...extra,
  };
}

function object(
  objectApiName: string,
  rows: number,
  fields: SampleField[] = [],
): SampleObjectInput {
  return { objectApiName, rows, fields };
}

/**
 * The run: accounts and leads drawn from their roots, contacts and
 * opportunities under accounts, product lines under opportunities, which
 * they cannot be written without, a catalog too big to copy whole, a region
 * asked whole, feed items, and an object whose describe has no modification
 * date.
 */
const links = sampleLinksOf({
  objects: [
    object('Account', 5_000, [lookup('ParentId', 'Account')]),
    object('Contact', 5_000, [lookup('AccountId', 'Account')]),
    object('Opportunity', 5_000, [lookup('AccountId', 'Account')]),
    object('OpportunityLineItem', 5_000, [
      lookup('OpportunityId', 'Opportunity', { nillable: false, updateable: false }),
      lookup('PricebookEntryId', 'PricebookEntry'),
    ]),
    object('PricebookEntry', 100),
    object('Region__c', 50),
    object('Lead', 5_000),
    object('FeedItem', 5_000),
    object('Signal__c', 5_000),
  ],
  whole: ['Region__c'],
  roomBytes: 0,
  wholeBytes: (name, rows) => countedStorageBytes(name, { rows }),
});

const id: SampleDrawField = { name: 'Id', type: 'id', aggregatable: true, groupable: true };
const created: SampleDrawField = { name: 'CreatedDate', type: 'datetime', groupable: false };
const modified: SampleDrawField = { name: 'LastModifiedDate', type: 'datetime', groupable: false };
const modstamp: SampleDrawField = { name: 'SystemModstamp', type: 'datetime', groupable: false };
const picklist = (name: string, groupable = true): SampleDrawField => ({
  name,
  type: 'picklist',
  groupable,
});
const reference = (name: string): SampleDrawField => ({ name, type: 'reference', groupable: true });

const describes: Record<string, SampleDrawField[]> = {
  Account: [
    id,
    { name: 'Name', type: 'string', groupable: true },
    { name: 'Description', type: 'textarea', groupable: false },
    { name: 'BillingCountry', type: 'string', groupable: true },
    { name: 'IsPartner', type: 'boolean', groupable: true },
    reference('ParentId'),
    reference('OwnerId'),
    reference('RecordTypeId'),
    picklist('Rating'),
    picklist('Industry'),
    created,
    modified,
    modstamp,
  ],
  Contact: [id, reference('AccountId'), picklist('LeadSource'), created, modified],
  Opportunity: [
    id,
    reference('AccountId'),
    reference('RecordTypeId'),
    picklist('StageName'),
    picklist('ForecastCategory', false),
    created,
    modified,
    modstamp,
  ],
  OpportunityLineItem: [id, reference('OpportunityId'), created, modified],
  Lead: [id, picklist('Status'), reference('OwnerId'), created, modified, modstamp],
  FeedItem: [{ ...id, aggregatable: false }, picklist('Type'), created, modified],
  Signal__c: [id, picklist('Level__c'), created],
};

function rootsOf(
  options: SampleRootsInput['options'],
  extra: Partial<SampleRootsInput> = {},
): ReturnType<typeof sampleRootsOf> {
  return sampleRootsOf({
    options,
    now: Date.parse('2026-11-14T10:30:45.678Z'),
    links,
    fieldsOf: (name) => describes[name],
    ...extra,
  });
}

/** The problems the options are refused with. */
function problemsOf(
  options: SampleRootsInput['options'],
  extra: Partial<SampleRootsInput> = {},
): readonly string[] {
  try {
    rootsOf(options, extra);
  } catch (error) {
    if (error instanceof SampleDrawInvalid) return error.problems;
    throw error;
  }
  throw new Error('The options were not refused.');
}

describe('sampleRootsOf: every root', () => {
  it('gives every object drawn from its roots, nothing chosen of any, when no option chooses them', () => {
    const roots = rootsOf({});
    expect([...roots.objects.keys()]).toEqual([
      'Account',
      'Contact',
      'FeedItem',
      'Lead',
      'Opportunity',
      'OpportunityLineItem',
      'Signal__c',
    ]);
    expect(roots.objects.get('Account')).toEqual({ objectApiName: 'Account' });
    expect(roots.restricted).toBe(false);
    expect(roots.stratified).toBe(false);
    expect(sampleRootsReportOf(roots)).toEqual({});
  });
});

describe('sampleRootsOf: the window', () => {
  it('counts the last days back from when the sample is drawn, to the second, and keeps lastDays beside', () => {
    const roots = rootsOf({ window: { field: 'CreatedDate', lastDays: 2 } });
    expect(roots.window).toEqual({
      field: 'CreatedDate',
      from: '2026-11-12T10:30:45Z',
      lastDays: 2,
    });
    expect(roots.objects.get('Account')).toEqual({
      objectApiName: 'Account',
      window: { field: 'CreatedDate', from: '2026-11-12T10:30:45Z' },
    });
    expect(roots.restricted).toBe(true);
  });

  it('gives each object the window from its start included to its end left out, as instants to the second', () => {
    const roots = rootsOf({
      window: { field: 'CreatedDate', from: '2025-01-01T00:00:00Z', to: '2025-07-01T00:00:00Z' },
    });
    expect(roots.objects.get('Lead')?.window).toEqual({
      field: 'CreatedDate',
      from: '2025-01-01T00:00:00Z',
      to: '2025-07-01T00:00:00Z',
    });
    expect(roots.notWindowed).toEqual([]);
  });

  it('says apart an object whose describe has no date the window asks, and asks no window of it', () => {
    const roots = rootsOf({
      window: {
        field: 'LastModifiedDate',
        from: '2025-01-01T00:00:00Z',
        to: '2025-02-01T00:00:00Z',
      },
    });
    expect(roots.objects.get('Contact')?.window?.field).toBe('LastModifiedDate');
    expect(roots.objects.get('Signal__c')).toEqual({
      objectApiName: 'Signal__c',
      notWindowed: true,
    });
    expect(roots.notWindowed).toEqual(['Signal__c']);
    expect(sampleRootsReportOf(roots)).toEqual({
      window: {
        field: 'LastModifiedDate',
        from: '2025-01-01T00:00:00Z',
        to: '2025-02-01T00:00:00Z',
      },
      notWindowed: ['Signal__c'],
    });
  });

  it('refuses a window that ends before it starts, and a bound that is no instant', () => {
    expect(
      problemsOf({
        window: { field: 'CreatedDate', from: '2025-07-01T00:00:00Z', to: '2025-01-01T00:00:00Z' },
      }),
    ).toEqual([
      'The window starts at 2025-07-01T00:00:00Z and ends before it, at 2025-01-01T00:00:00Z: its start is before its end.',
    ]);
    expect(problemsOf({ window: { field: 'CreatedDate', from: 'yesterday' } })).toEqual([
      "The window's bound yesterday is no instant: write it in UTC, as 2025-07-01T00:00:00Z.",
    ]);
  });
});

describe('sampleRootsOf: the filter on the roots', () => {
  it('gives the condition to the object named alone, its name written as the run has it', () => {
    const roots = rootsOf({ rootWhere: { account: "BillingCountry = 'France'" } });
    expect(roots.objects.get('Account')).toEqual({
      objectApiName: 'Account',
      where: "BillingCountry = 'France'",
    });
    expect(roots.objects.get('Contact')?.where).toBeUndefined();
    expect(roots.where).toEqual([{ objectApiName: 'Account', where: "BillingCountry = 'France'" }]);
    expect(roots.restricted).toBe(true);
    expect(sampleRootsReportOf(roots)).toEqual({
      where: [{ objectApiName: 'Account', where: "BillingCountry = 'France'" }],
    });
  });

  it('refuses at once each object whose roots cannot be filtered, each with its way out, as a stop of the gate', () => {
    let refused: unknown;
    try {
      rootsOf(
        {
          rootWhere: {
            Task: 'Subject = null',
            Nope__c: 'Name = null',
            Region__c: "Name = 'West'",
            PricebookEntry: 'IsActive = true',
            OpportunityLineItem: 'Quantity > 3',
          },
        },
        { excluded: ['Task'] },
      );
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(SampleDrawInvalid);
    expect(isForgeRunGateError(refused)).toBe(true);
    expect(refused).toMatchObject({ code: 'SAMPLE_DRAW_INVALID', sample: { requests: 0 } });
    expect((refused as SampleDrawInvalid).problems).toEqual([
      'Task is left out of the run (--exclude-object), and has no root to draw: take it out of one option or the other.',
      'Nope__c is no object of the run, and takes no filter on its roots. The objects whose roots are drawn are Account, Contact, FeedItem, Lead, Opportunity, Signal__c.',
      'Every record of Region__c comes, as the sample copies it whole: it has no root drawn, and takes no filter on its roots. --filter leaves records of it out of the copy.',
      'PricebookEntry has no root of its own: its records come as the records the sample keeps name them, and it takes no filter on its roots. The objects whose roots are drawn are Account, Contact, FeedItem, Lead, Opportunity, Signal__c.',
      'Every record of OpportunityLineItem comes under the Opportunity it cannot be written without (OpportunityId): it has no root, and takes no filter on its roots. Filter the roots of Opportunity instead: --fit-where "Opportunity=Id IN (SELECT OpportunityId FROM OpportunityLineItem WHERE …)".',
    ]);
    expect((refused as SampleDrawInvalid).message).toMatch(
      / Nothing was written, and no root was counted or read: the requests sent before the draw were discovery’s and the target’s\.$/,
    );
  });

  it('takes two semi-joins of an object between its filter and the filter on its roots, and refuses a third before anything is sent', () => {
    const filterOf = (name: string) =>
      name === 'Account' ? 'Id IN (SELECT AccountId FROM Contact)' : undefined;
    expect(
      rootsOf(
        { rootWhere: { Account: "Id IN (SELECT AccountId FROM Case WHERE Status = 'New')" } },
        { filterOf },
      ).objects.get('Account')?.where,
    ).toBe("Id IN (SELECT AccountId FROM Case WHERE Status = 'New')");
    expect(
      problemsOf(
        {
          rootWhere: {
            Account:
              'Id IN (SELECT AccountId FROM Case) AND Id IN (SELECT AccountId FROM Opportunity)',
          },
        },
        { filterOf },
      ),
    ).toEqual([
      'A statement of Account takes 2 semi-joins at most (IN (SELECT …)), and its filter and the filter on its roots hold 3: write one of them without, or fold them into fewer.',
    ]);
  });

  it('refuses two filters on the roots of one object, written in two cases', () => {
    expect(
      problemsOf({ rootWhere: { Account: 'IsPartner = true', ACCOUNT: 'IsPartner = false' } }),
    ).toEqual(['The roots of Account are given two filters: give one.']);
  });
});

describe('sampleRootsOf: the strata', () => {
  it('stratifies the object named by its field, as the describe names it, and keeps every root in the draw', () => {
    const roots = rootsOf({ strata: ['account.recordtypeid'] });
    expect(roots.objects.get('Account')).toEqual({
      objectApiName: 'Account',
      stratifiedBy: 'RecordTypeId',
    });
    expect(roots.objects.get('Opportunity')?.stratifiedBy).toBeUndefined();
    expect(roots.stratified).toBe(true);
    expect(roots.restricted).toBe(false);
  });

  it('stratifies by a field alone every object that lists it and groups it, an object named taking its own first', () => {
    const roots = rootsOf({ strata: ['RecordTypeId', 'Account.IsPartner'] });
    expect(roots.objects.get('Account')?.stratifiedBy).toBe('IsPartner');
    expect(roots.objects.get('Opportunity')?.stratifiedBy).toBe('RecordTypeId');
    expect(roots.objects.get('Lead')?.stratifiedBy).toBeUndefined();
    expect(roots.objects.get('Contact')?.stratifiedBy).toBeUndefined();
  });

  it('refuses at once a field of many values, one that carries the draw, one the object lacks or the org does not group or count by, each with the fields it may take', () => {
    expect(
      problemsOf({
        strata: [
          'Account.Description',
          'Contact.AccountId',
          'Lead.Nope',
          'Opportunity.ForecastCategory',
          'FeedItem.Type',
        ],
      }),
    ).toEqual([
      'Account.Description is a textarea field, of too many values to stratify by. Its roots are stratified by a field of few values — a picklist, a checkbox, the record type (RecordTypeId) or the owner (OwnerId): of Account, RecordTypeId, OwnerId, Industry, Rating.',
      'Contact.AccountId names the Account a record of Contact comes under, and a root of Contact never fills it: it stratifies nothing. Its roots are stratified by a field of few values — a picklist, a checkbox, the record type (RecordTypeId) or the owner (OwnerId): of Contact, LeadSource.',
      'Lead has no field Nope. Its roots are stratified by a field of few values — a picklist, a checkbox, the record type (RecordTypeId) or the owner (OwnerId): of Lead, OwnerId, Status.',
      'The source does not group Opportunity by ForecastCategory, which its strata are counted by. Its roots are stratified by a field of few values — a picklist, a checkbox, the record type (RecordTypeId) or the owner (OwnerId): of Opportunity, RecordTypeId, StageName.',
      'The source does not count the records of FeedItem by a field (COUNT(Id)), which its strata are counted by: its roots cannot be stratified.',
    ]);
  });

  it('refuses strata on an object copied whole, or with no root, as it does a filter on its roots', () => {
    expect(problemsOf({ strata: ['Region__c.Kind__c', 'OpportunityLineItem.Quantity'] })).toEqual([
      'Every record of Region__c comes, as the sample copies it whole: it has no root drawn, and takes no strata. The objects whose roots are drawn are Account, Contact, FeedItem, Lead, Opportunity, Signal__c.',
      'Every record of OpportunityLineItem comes under the Opportunity it cannot be written without (OpportunityId): it has no root, and takes no strata. Stratify the roots of Opportunity instead.',
    ]);
  });

  it('refuses a field alone that no object drawn groups by, and one that would stratify an object by many values', () => {
    expect(problemsOf({ strata: ['Nope'] })).toEqual([
      'No object whose roots are drawn — Account, Contact, FeedItem, Lead, Opportunity, Signal__c — has a field Nope it groups by. Name the object and its field, as Account.RecordTypeId.',
    ]);
    expect(problemsOf({ strata: ['Name'] })[0]).toMatch(
      /^Account\.Name is a string field, of too many values to stratify by\. .* Or name each object Name stratifies, as Object\.Name\.$/,
    );
  });

  it('gives every problem of the window, the filters and the strata in one refusal', () => {
    expect(
      problemsOf({
        window: { field: 'CreatedDate', from: '2025-07-01T00:00:00Z', to: '2025-01-01T00:00:00Z' },
        rootWhere: { Nope__c: 'Name = null' },
        strata: ['Lead.Nope'],
      }),
    ).toHaveLength(3);
  });
});

describe('semiJoinsIn', () => {
  it('counts each IN (SELECT …) of a condition, and none written inside quotes', () => {
    expect(semiJoinsIn(undefined)).toBe(0);
    expect(semiJoinsIn('Id IN ( select AccountId FROM Case)')).toBe(1);
    expect(semiJoinsIn("Name = '(SELECT x)' AND Id IN (SELECT AccountId FROM Case)")).toBe(1);
  });
});
