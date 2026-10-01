import { describe, it, expect, vi } from 'vitest';
import type { ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import { ForgeExecutor } from './ForgeExecutor.js';
import type {
  ExecuteOptions,
  FieldInfo,
  ForgeExecutorDeps,
  InsertResult,
} from './ForgeExecutor.js';
import type { RecordTypePicklists } from '../../core/metadata/recordTypePicklists.js';
import { toSaveOutcome } from '../../core/common/existingRecordMatch.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * An asset whose account was never in the graph: the run copies the account
 * from the source on its own (`expandOrphanParents`). Copied with none of the
 * rules the run's own rows go in on, a restricted value its record type
 * refused, or a validation rule's refusal of its phone, cost the account and
 * the asset with it; and a person account's contact, which the platform
 * writes with it, was never linked to.
 */

/** A fake id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const ASSET = id('02i', 1);
const ACCOUNT = id('001', 1);
const PERSON_CONTACT = id('003', 1);
/** The account's record type in the source, and the one the mapping gives it in the target. */
const SOURCE_RETAIL = id('012', 1);
const TARGET_RETAIL = id('012', 101);
const RULE = 'Enter the phone in international format';

const field = (name: string, overrides: Partial<FieldInfo> = {}): FieldInfo => ({
  name,
  queryable: true,
  createable: name !== 'Id',
  isReference: false,
  ...overrides,
});

const FIELDS: Record<string, FieldInfo[]> = {
  Asset: [
    field('Id'),
    field('Name'),
    field('AccountId', { isReference: true, referenceTo: ['Account'], nillable: false }),
    field('ContactId', { isReference: true, referenceTo: ['Contact'], nillable: true }),
  ],
  Account: [
    field('Id'),
    field('Name'),
    field('LastName'),
    field('Phone', { type: 'phone' }),
    field('RecordTypeId', { isReference: true, referenceTo: ['RecordType'] }),
    field('Tier__c', {
      type: 'picklist',
      restrictedPicklist: true,
      picklistValues: ['Gold', 'Silver', 'Bronze'],
    }),
    field('IsPersonAccount', { createable: false, updateable: false }),
    field('PersonContactId', {
      createable: false,
      updateable: false,
      isReference: true,
      referenceTo: ['Contact'],
    }),
  ],
};

/** What the target's record type Retail keeps of Tier__c: "Gold" is active, and not kept. */
const RETAIL: RecordTypePicklists = new Map([
  ['Tier__c', { values: ['Silver', 'Bronze'], defaultValue: 'Silver' }],
]);

function asset(): ForgeGraphNode {
  return {
    objectApiName: 'Asset',
    recordCount: 1,
    fieldCount: FIELDS.Asset.length,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: FIELDS.Asset.length - 1,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'auto',
  };
}

const GRAPH: ForgeGraph = {
  nodes: [asset()],
  edges: [],
  totalRecords: 1,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 0,
};

const OPTIONS: ExecuteOptions = {
  expandOrphanParents: true,
  recordTypeMappings: [
    { sourceId: SOURCE_RETAIL, targetId: TARGET_RETAIL, developerName: 'Retail' },
  ],
};

/** The rule's refusal of the phone, as the writers read it from the platform. */
const refusedOnThePhone = (): InsertResult =>
  toSaveOutcome(
    {
      success: false,
      errors: [
        { statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: RULE, fields: ['Phone'] },
      ],
    },
    'Account',
  );

/**
 * A source holding the asset and `account`, and a target that refuses an
 * account whose restricted value its record type does not keep, as the
 * platform does, and — with `rule` — one that carries a phone; that writes a
 * contact with a person account, and names it when asked.
 */
function orgs(account: Record<string, unknown>, rule = false) {
  const inserted: Array<{ object: string; rows: Record<string, unknown>[] }> = [];
  const PLATFORM_CONTACT = id('003', 901);
  let next = 0;
  const deps = {
    describeFields: vi.fn(async (_org: string, object: string) => FIELDS[object] ?? []),
    queryRecords: vi.fn(async (org: string, soql: string) => {
      if (org === 'src') {
        if (/FROM Asset\b/.test(soql)) {
          // The asset of a person names the contact of its account as well.
          const contact = account['IsPersonAccount'] === true ? PERSON_CONTACT : null;
          return [{ Id: ASSET, Name: 'Van', AccountId: ACCOUNT, ContactId: contact }];
        }
        if (/FROM Account\b/.test(soql)) return [{ ...account }];
        return [];
      }
      // The target names the contact it wrote with each person account it holds.
      const asked = /^SELECT Id, PersonContactId FROM Account WHERE Id IN \((.*)\)$/.exec(soql);
      return asked
        ? [...asked[1].matchAll(/'([^']+)'/g)].map(([, accountId]) => ({
            Id: accountId,
            PersonContactId: account['IsPersonAccount'] === true ? PLATFORM_CONTACT : null,
          }))
        : [];
    }),
    insertRecords: vi.fn(
      async (
        _org: string,
        object: string,
        rows: Record<string, unknown>[],
      ): Promise<InsertResult[]> => {
        inserted.push({ object, rows: rows.map((row) => ({ ...row })) });
        return rows.map((row): InsertResult => {
          if (object === 'Account') {
            const tier = row['Tier__c'];
            if (typeof tier === 'string' && !RETAIL.get('Tier__c')?.values.includes(tier)) {
              return {
                id: '',
                success: false,
                errors: [
                  `INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value for restricted picklist field: ${tier} [Tier__c]`,
                ],
              };
            }
            if (rule && row['Phone'] !== undefined) return refusedOnThePhone();
          }
          return {
            id: id(object === 'Account' ? '001' : '02i', 900 + ++next),
            success: true,
            errors: [],
          };
        });
      },
    ),
    recordTypePicklists: vi.fn(async () => RETAIL),
  } satisfies ForgeExecutorDeps;
  return { deps, inserted, PLATFORM_CONTACT };
}

const BUSINESS_ACCOUNT = {
  Id: ACCOUNT,
  Name: 'Acme',
  LastName: null,
  Phone: '555-0100',
  RecordTypeId: SOURCE_RETAIL,
  Tier__c: 'Gold',
  IsPersonAccount: false,
  PersonContactId: null,
};

describe('ForgeExecutor, a parent copied from outside the graph', () => {
  it("replaces a restricted value its record type does not keep, writes it, and says so with the run's", async () => {
    const { deps, inserted } = orgs(BUSINESS_ACCOUNT);

    const summary = await new ForgeExecutor(deps).execute(
      GRAPH,
      'src',
      'tgt',
      () => undefined,
      OPTIONS,
    );

    expect(inserted.find(({ object }) => object === 'Account')?.rows).toEqual([
      { Name: 'Acme', Phone: '555-0100', RecordTypeId: TARGET_RETAIL, Tier__c: 'Silver' },
    ]);
    const newAccount = summary.remapTable[ACCOUNT];
    expect(inserted.find(({ object }) => object === 'Asset')?.rows).toEqual([
      { Name: 'Van', AccountId: newAccount },
    ]);
    expect(summary.picklistValuesChanged).toEqual([
      {
        objectApiName: 'Account',
        field: 'Tier__c',
        reason: 'record-type',
        values: ['Gold'],
        rows: 1,
        recordType: 'Retail',
        replacedBy: 'Silver',
        replacement: 'default',
      },
    ]);
    expect(
      summary.errors.find((e) => e.objectApiName === '__expandOrphanParents__'),
    ).toBeUndefined();
  });

  it('writes it once more without the fields a validation rule refused it on, and says which', async () => {
    const { deps, inserted } = orgs({ ...BUSINESS_ACCOUNT, Tier__c: 'Bronze' }, true);

    const summary = await new ForgeExecutor(deps).execute(
      GRAPH,
      'src',
      'tgt',
      () => undefined,
      OPTIONS,
    );

    expect(
      inserted.filter(({ object }) => object === 'Account').map(({ rows }) => rows[0]['Phone']),
    ).toEqual(['555-0100', undefined]);
    expect(inserted.find(({ object }) => object === 'Asset')?.rows[0]['AccountId']).toBe(
      summary.remapTable[ACCOUNT],
    );
    expect(summary.writtenWithoutFields).toEqual([
      {
        objectApiName: 'Account',
        rows: 1,
        fields: [{ field: 'Phone', reason: `FIELD_CUSTOM_VALIDATION_EXCEPTION: ${RULE}`, rows: 1 }],
      },
    ]);
    expect(summary.failedCount).toBe(0);
  });

  it("points what points at a person account's contact at the one the platform wrote with it", async () => {
    const { deps, inserted, PLATFORM_CONTACT } = orgs({
      ...BUSINESS_ACCOUNT,
      Name: 'Jane Doe',
      LastName: 'Doe',
      Phone: null,
      Tier__c: 'Silver',
      IsPersonAccount: true,
      PersonContactId: PERSON_CONTACT,
    });

    const summary = await new ForgeExecutor(deps).execute(
      GRAPH,
      'src',
      'tgt',
      () => undefined,
      OPTIONS,
    );

    // A person account goes in without its computed name.
    expect(inserted.find(({ object }) => object === 'Account')?.rows).toEqual([
      { LastName: 'Doe', RecordTypeId: TARGET_RETAIL, Tier__c: 'Silver' },
    ]);
    expect(inserted.find(({ object }) => object === 'Asset')?.rows).toEqual([
      { Name: 'Van', AccountId: summary.remapTable[ACCOUNT], ContactId: PLATFORM_CONTACT },
    ]);
    expect(summary.remapTable[PERSON_CONTACT]).toBe(PLATFORM_CONTACT);
    // Linked to, never created by the run: no removal deletes it on its own.
    expect(summary.existingSourceIds).toContain(PERSON_CONTACT);
  });
});
