import { describe, it, expect, vi } from 'vitest';
import type { SeedObjectConfig, SeedRelation, SeedRow, SeedTemplate } from '@sandforge/shared';
import { SeedOrchestrator } from './SeedOrchestrator';
import type {
  InsertFn,
  InsertResult,
  InsertedRow,
  SeedOrchestratorDependencies,
} from './SeedOrchestrator';
import { SeedValidator } from './SeedValidator';
import { DataPlanBuilder } from './DataPlanBuilder';
import { FieldMapper } from './FieldMapper';
import { FakerFallback } from './FakerFallback';
import { AIDataGenerator } from './AIDataGenerator';
import { ReferenceLinker } from './ReferenceLinker';
import { SeedGrappeAdapter } from './SeedGrappeAdapter';

const ID_PREFIX: Record<string, string> = { Account: '001', Contact: '003', Case: '500' };

/** What the target holds once written: each record by the id it gave it. */
type Held = Map<string, { objectApiName: string; record: Record<string, unknown> }>;

/**
 * A target that answers record by record, as the REST path does, giving each
 * record it takes the next id of its object, and refusing those `refuse`
 * answers for. `perRow: false` answers as a Bulk API job whose answer cannot
 * be laid on the records: its lists alone.
 */
function keyedTarget(
  refuse: (
    objectApiName: string,
    record: Record<string, unknown>,
  ) => InsertedRow | undefined = () => undefined,
  options: { perRow?: (objectApiName: string) => boolean } = {},
) {
  const held: Held = new Map();
  const sent: Array<{ objectApiName: string; records: Record<string, unknown>[] }> = [];
  let next = 0;
  const insert = vi.fn<InsertFn>(async (_orgId, objectApiName, records): Promise<InsertResult> => {
    sent.push({ objectApiName, records: records.map((r) => ({ ...r })) });
    const rows = records.map((record): InsertedRow => {
      const refused = refuse(objectApiName, record);
      if (refused) return refused;
      const id = `${ID_PREFIX[objectApiName] ?? 'a0X'}${String(++next).padStart(15, '0')}`;
      held.set(id, { objectApiName, record: { ...record } });
      return { id };
    });
    const lists = {
      successIds: rows.flatMap((r) => (r.id ? [r.id] : [])),
      errors: rows.flatMap((r) => (r.id ? [] : [r.error ?? ''])),
    };
    return options.perRow?.(objectApiName) === false ? lists : { ...lists, rows };
  });
  /** The record the target holds under `id`. */
  const recordOf = (id: unknown) => held.get(String(id))?.record;
  return { insert, held, sent, recordOf };
}

function seedDeps(
  insert: InsertFn,
  extra: Partial<SeedOrchestratorDependencies> = {},
): SeedOrchestratorDependencies {
  return {
    validator: new SeedValidator(),
    planBuilder: new DataPlanBuilder(),
    fieldMapper: new FieldMapper({
      aiGenerator: new AIDataGenerator(() => {
        throw new Error('no AI here');
      }),
      fakerFallback: new FakerFallback('en_US'),
    }),
    referenceLinker: new ReferenceLinker(),
    insert,
    generateId: () => 'op-1',
    now: () => '2026-10-28T00:00:00.000Z',
    ...extra,
  };
}

function rowsObject(objectApiName: string, rows: SeedRow[], insertOrder = 0): SeedObjectConfig {
  return {
    objectApiName,
    recordCount: rows.length,
    fieldRules: [],
    excludedFields: [],
    insertOrder,
    batchSize: 200,
    rows,
  };
}

function byKey(childObject: string, lookupField: string, parentObject: string): SeedRelation {
  return {
    childObject,
    lookupField,
    parentObject,
    parents: { kind: 'generated' },
    distribution: { mode: 'byKey' },
  };
}

function template(objects: SeedObjectConfig[], relations: SeedRelation[]): SeedTemplate {
  return {
    id: 'tpl',
    name: 'keyed rows',
    description: '',
    version: 1,
    strategy: 'template',
    objects,
    relations,
    tags: [],
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
  };
}

/** One account, five contacts under it, and a closed and an open case for each contact. */
function scenario(): SeedTemplate {
  const contacts = [1, 2, 3, 4, 5].map((n): SeedRow => ({
    key: `c${n}`,
    parentKey: 'a1',
    values: { LastName: `Contact ${n}`, Email: `c${n}@acme.example` },
  }));
  const cases = [1, 2, 3, 4, 5].flatMap((n): SeedRow[] => [
    {
      key: `c${n}-closed`,
      parentKey: `c${n}`,
      values: { Subject: `Closed ${n}`, Status: 'Closed' },
    },
    { key: `c${n}-open`, parentKey: `c${n}`, values: { Subject: `Open ${n}`, Status: 'New' } },
  ]);
  return template(
    [
      rowsObject('Account', [{ key: 'a1', values: { Name: 'Acme' } }], 0),
      rowsObject('Contact', contacts, 1),
      rowsObject('Case', cases, 2),
    ],
    [byKey('Contact', 'AccountId', 'Account'), byKey('Case', 'ContactId', 'Contact')],
  );
}

const INVALID_EMAIL = 'INVALID_EMAIL_ADDRESS: Email: invalid email address';

/** The org refuses the contact named `lastName`, for a reason no field left out cures. */
function refusingContact(lastName: string) {
  return (objectApiName: string, record: Record<string, unknown>): InsertedRow | undefined =>
    objectApiName === 'Contact' && record.LastName === lastName
      ? {
          error: INVALID_EMAIL,
          errorDetails: [
            {
              statusCode: 'INVALID_EMAIL_ADDRESS',
              message: 'Email: invalid email address',
              fields: ['Email'],
            },
          ],
        }
      : undefined;
}

describe('SeedOrchestrator — rows placed by key', () => {
  it('writes no case of a refused contact, names each with the reason, and keeps every other case under its own contact', async () => {
    // Placed by rank, the case meant for the fourth contact landed under the
    // fifth once the third was refused.
    const target = keyedTarget(refusingContact('Contact 3'));
    const result = await new SeedOrchestrator(seedDeps(target.insert)).execute(scenario(), 'org');

    const [, contact, kase] = result.objectResults;
    expect(contact.recordsCreated).toBe(4);
    expect(contact.recordsFailed).toBe(1);
    expect(kase.recordsCreated).toBe(8);
    expect(kase.recordsFailed).toBe(2);
    expect(kase.errors).toEqual([
      `Case c3-closed not written: its Contact c3 was refused (${INVALID_EMAIL}).`,
      `Case c3-open not written: its Contact c3 was refused (${INVALID_EMAIL}).`,
    ]);
    expect(result.status).toBe('partial');

    // Every case the org holds is under the contact its row named.
    const cases = kase.createdIds.map((id) => target.recordOf(id) ?? {});
    expect(cases).toHaveLength(8);
    for (const written of cases) {
      const n = String(written.Subject).split(' ')[1];
      expect(target.recordOf(written.ContactId)?.LastName).toBe(`Contact ${n}`);
    }
    expect(cases.map((c) => c.Subject)).not.toContain('Closed 3');
    // The two cases of the third contact were never sent.
    const sentCases = target.sent
      .filter((s) => s.objectApiName === 'Case')
      .flatMap((s) => s.records);
    expect(sentCases).toHaveLength(8);
  });

  it('writes the rows as they are given, under the id of the row they name', async () => {
    const target = keyedTarget();
    const result = await new SeedOrchestrator(seedDeps(target.insert)).execute(scenario(), 'org');

    expect(result.status).toBe('success');
    const [account, contact] = result.objectResults;
    const [firstContact] = contact.createdIds.map((id) => target.recordOf(id));
    expect(firstContact).toEqual({
      LastName: 'Contact 1',
      Email: 'c1@acme.example',
      AccountId: account.createdIds[0],
    });
  });

  it('writes no row under a row that was not written, and says the parent row it waited on', async () => {
    const accounts = [
      { key: 'a1', values: { Name: 'Acme' } },
      { key: 'a2', values: { Name: 'Refused Ltd' } },
    ];
    const contacts: SeedRow[] = [
      { key: 'c1', parentKey: 'a1', values: { LastName: 'One' } },
      { key: 'c2', parentKey: 'a2', values: { LastName: 'Two' } },
    ];
    const cases: SeedRow[] = [
      { key: 'c1-open', parentKey: 'c1', values: { Subject: 'Open 1' } },
      { key: 'c2-open', parentKey: 'c2', values: { Subject: 'Open 2' } },
    ];
    const target = keyedTarget((objectApiName, record) =>
      objectApiName === 'Account' && record.Name === 'Refused Ltd'
        ? { error: 'DUPLICATES_DETECTED: Use one of these records?' }
        : undefined,
    );
    const result = await new SeedOrchestrator(seedDeps(target.insert)).execute(
      template(
        [
          rowsObject('Account', accounts, 0),
          rowsObject('Contact', contacts, 1),
          rowsObject('Case', cases, 2),
        ],
        [byKey('Contact', 'AccountId', 'Account'), byKey('Case', 'ContactId', 'Contact')],
      ),
      'org',
    );

    const [, contact, kase] = result.objectResults;
    expect(contact.errors).toEqual([
      'Contact c2 not written: its Account a2 was refused (DUPLICATES_DETECTED: Use one of these records?).',
    ]);
    expect(kase.errors).toEqual([
      'Case c2-open not written: its Contact c2 was not written, as its Account a2 was refused ' +
        '(DUPLICATES_DETECTED: Use one of these records?).',
    ]);
    expect(kase.recordsCreated).toBe(1);
    expect(target.recordOf(target.recordOf(kase.createdIds[0])?.ContactId)?.LastName).toBe('One');
  });

  it('gives a row the id its record got once sent again without the field the org refused it on', async () => {
    // The second contact's phone breaks a validation rule; written again
    // without it, it gets an id the first answer did not hold.
    const target = keyedTarget((objectApiName, record) =>
      objectApiName === 'Contact' && record.Phone === '555-0100'
        ? {
            error: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Phone must be French.',
            errorDetails: [
              {
                statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
                message: 'Phone must be French.',
                fields: ['Phone'],
              },
            ],
          }
        : undefined,
    );
    const result = await new SeedOrchestrator(seedDeps(target.insert)).execute(
      template(
        [
          rowsObject('Account', [{ key: 'a1', values: { Name: 'Acme' } }], 0),
          rowsObject(
            'Contact',
            [
              { key: 'c1', parentKey: 'a1', values: { LastName: 'One' } },
              { key: 'c2', parentKey: 'a1', values: { LastName: 'Two', Phone: '555-0100' } },
              { key: 'c3', parentKey: 'a1', values: { LastName: 'Three' } },
            ],
            1,
          ),
          rowsObject(
            'Case',
            [
              { key: 'k1', parentKey: 'c1', values: { Subject: 'for One' } },
              { key: 'k2', parentKey: 'c2', values: { Subject: 'for Two' } },
              { key: 'k3', parentKey: 'c3', values: { Subject: 'for Three' } },
            ],
            2,
          ),
        ],
        [byKey('Contact', 'AccountId', 'Account'), byKey('Case', 'ContactId', 'Contact')],
      ),
      'org',
    );

    const [, contact, kase] = result.objectResults;
    expect(contact.recordsCreated).toBe(3);
    expect(kase.recordsCreated).toBe(3);
    expect(kase.recordsFailed).toBe(0);
    const owners = kase.createdIds.map((id) => {
      const written = target.recordOf(id);
      return [written?.Subject, target.recordOf(written?.ContactId)?.LastName];
    });
    expect(owners).toEqual([
      ['for One', 'One'],
      ['for Two', 'Two'],
      ['for Three', 'Three'],
    ]);
  });

  it('writes no child of an object whose insert did not answer record by record, and names each', async () => {
    // A Bulk API job whose answer cannot be laid on the records gives ids,
    // not whose they are.
    const target = keyedTarget(undefined, {
      perRow: (objectApiName) => objectApiName !== 'Contact',
    });
    const result = await new SeedOrchestrator(seedDeps(target.insert)).execute(scenario(), 'org');

    const [, contact, kase] = result.objectResults;
    expect(contact.recordsCreated).toBe(5);
    expect(kase.recordsCreated).toBe(0);
    expect(kase.recordsFailed).toBe(10);
    expect(kase.errors[0]).toBe(
      'Case c1-closed not written: its Contact c1 has no id this run can tell: ' +
        'the insert did not answer record by record.',
    );
    expect(target.sent.some((s) => s.objectApiName === 'Case')).toBe(false);
    expect(result.status).toBe('partial');
  });

  it('writes no child under rows written again whose answer did not say which id is whose', async () => {
    // Both contacts are refused on their phone, and written again without it
    // in one call whose answer gives two ids and not whose they are.
    const phoneRule = {
      statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
      message: 'Phone must be French.',
      fields: ['Phone'],
    };
    let next = 0;
    const insert = vi.fn<InsertFn>(async (_orgId, objectApiName, records) => {
      const id = () => `${ID_PREFIX[objectApiName]}${String(++next).padStart(15, '0')}`;
      if (objectApiName === 'Contact' && records.every((r) => 'Phone' in r)) {
        const rows = records.map(() => ({
          error: `${phoneRule.statusCode}: ${phoneRule.message}`,
          errorDetails: [phoneRule],
        }));
        return { successIds: [], errors: rows.map((r) => r.error), rows };
      }
      if (objectApiName === 'Contact') {
        return { successIds: records.map(id), errors: [] };
      }
      const rows = records.map(() => ({ id: id() }));
      return { successIds: rows.map((r) => r.id), errors: [], rows };
    });
    const result = await new SeedOrchestrator(seedDeps(insert)).execute(
      template(
        [
          rowsObject('Account', [{ key: 'a1', values: { Name: 'Acme' } }], 0),
          rowsObject(
            'Contact',
            [
              { key: 'c1', parentKey: 'a1', values: { LastName: 'One', Phone: '555-0100' } },
              { key: 'c2', parentKey: 'a1', values: { LastName: 'Two', Phone: '555-0101' } },
            ],
            1,
          ),
          rowsObject('Case', [{ key: 'k1', parentKey: 'c1', values: { Subject: 'for One' } }], 2),
        ],
        [byKey('Contact', 'AccountId', 'Account'), byKey('Case', 'ContactId', 'Contact')],
      ),
      'org',
    );

    const [, contact, kase] = result.objectResults;
    expect(contact.recordsCreated).toBe(2);
    expect(kase.recordsCreated).toBe(0);
    expect(kase.errors).toEqual([
      'Case k1 not written: its Contact c1 has no id this run can tell: ' +
        'the org did not say which of the ids it answered is its.',
    ]);
  });

  it('refuses before anything is written a row placed under a parent row no row is', async () => {
    const target = keyedTarget();
    const keyed = scenario();
    const cases = keyed.objects[2];
    cases.rows = [...(cases.rows ?? []).slice(0, 9), { key: 'stray', parentKey: 'c9', values: {} }];

    const result = await new SeedOrchestrator(seedDeps(target.insert)).execute(keyed, 'org');

    expect(result.status).toBe('failure');
    expect(result.objectResults[0].errors).toContain(
      'Case row "stray" is placed under Contact "c9", which no Contact row is',
    );
    expect(target.insert).not.toHaveBeenCalled();
  });

  it('cuts a row’s text to the length the org gives its field, and moves its addresses to a reserved domain', async () => {
    const target = keyedTarget();
    const result = await new SeedOrchestrator(
      seedDeps(target.insert, {
        describeFieldLengths: async (objectApiName) =>
          new Map(objectApiName === 'Case' ? [['Subject', 20]] : []),
      }),
    ).execute(
      template(
        [
          rowsObject('Account', [{ key: 'a1', values: { Name: 'Acme' } }], 0),
          rowsObject(
            'Contact',
            [{ key: 'c1', parentKey: 'a1', values: { LastName: 'One', Email: 'jane@gmail.com' } }],
            1,
          ),
          rowsObject(
            'Case',
            [{ key: 'k1', parentKey: 'c1', values: { Subject: 'My parcel arrived broken today' } }],
            2,
          ),
        ],
        [byKey('Contact', 'AccountId', 'Account'), byKey('Case', 'ContactId', 'Contact')],
      ),
      'org',
    );

    const [, contact, kase] = result.objectResults;
    expect(target.recordOf(contact.createdIds[0])?.Email).toBe('jane@gmail.example');
    expect(target.recordOf(kase.createdIds[0])?.Subject).toBe('My parcel arrived');
  });

  it('writes a row without a field the org does not have, and says so', async () => {
    const target = keyedTarget();
    const result = await new SeedOrchestrator(
      seedDeps(target.insert, {
        describeCreateableFields: async (objectApiName) =>
          new Set(objectApiName === 'Account' ? ['Name'] : ['LastName', 'AccountId']),
      }),
    ).execute(
      template(
        [
          rowsObject('Account', [{ key: 'a1', values: { Name: 'Acme', Tier__c: 'Gold' } }], 0),
          rowsObject('Contact', [{ key: 'c1', parentKey: 'a1', values: { LastName: 'One' } }], 1),
        ],
        [byKey('Contact', 'AccountId', 'Account')],
      ),
      'org',
    );

    const [account, contact] = result.objectResults;
    expect(target.recordOf(account.createdIds[0])).toEqual({ Name: 'Acme' });
    expect(account.errors).toEqual([
      'Written without Tier__c: this org does not have that field, or field-level security ' +
        'hides it from the user SandForge connects as.',
    ]);
    expect(contact.recordsCreated).toBe(1);
  });

  it('fills a field the org requires and some rows leave out, and keeps the value of the rows that give it', async () => {
    const target = keyedTarget();
    const result = await new SeedOrchestrator(
      seedDeps(target.insert, {
        describeRequiredFields: async (objectApiName) =>
          objectApiName === 'Account'
            ? [
                {
                  objectApiName: 'Account',
                  fieldApiName: 'Region__c',
                  type: 'string',
                  picklistValues: [],
                  referenceTo: [],
                  length: 40,
                  required: true,
                },
              ]
            : [],
      }),
    ).execute(
      template(
        [
          rowsObject(
            'Account',
            [
              { key: 'a1', values: { Name: 'Acme', Region__c: 'North' } },
              { key: 'a2', values: { Name: 'Globex' } },
            ],
            0,
          ),
        ],
        [],
      ),
      'org',
    );

    const [account] = result.objectResults;
    const [first, second] = account.createdIds.map((id) => target.recordOf(id));
    expect(first?.Region__c).toBe('North');
    expect(typeof second?.Region__c).toBe('string');
    expect(second?.Region__c).not.toBe('');
  });

  it('places by key across the partitions of a seed large enough to take them', async () => {
    const target = keyedTarget(refusingContact('Contact 3'));
    const result = await new SeedOrchestrator(
      seedDeps(target.insert, {
        grappeAdapter: new SeedGrappeAdapter(() => 'gid', 3),
        grappeConfig: {
          enabled: true,
          autoActivateThreshold: 1,
          grappeSize: 3,
        } as SeedOrchestratorDependencies['grappeConfig'],
      }),
    ).execute(scenario(), 'org');

    const kase = result.objectResults[2];
    // Ten cases in partitions of three: the contacts' keys span them.
    expect(target.sent.filter((s) => s.objectApiName === 'Case').length).toBeGreaterThan(1);
    expect(kase.recordsCreated).toBe(8);
    expect(kase.errors).toEqual([
      `Case c3-closed not written: its Contact c3 was refused (${INVALID_EMAIL}).`,
      `Case c3-open not written: its Contact c3 was refused (${INVALID_EMAIL}).`,
    ]);
    for (const id of kase.createdIds) {
      const written = target.recordOf(id);
      const n = String(written?.Subject).split(' ')[1];
      expect(target.recordOf(written?.ContactId)?.LastName).toBe(`Contact ${n}`);
    }
  });
});

describe('SeedOrchestrator — the ids of the rows, by key', () => {
  it('tells, object by object, the id each row became, leaving out the rows the org did not take', async () => {
    const target = keyedTarget(refusingContact('Contact 3'));
    const told: Array<[string, Record<string, string>]> = [];
    await new SeedOrchestrator(
      seedDeps(target.insert, { onRowIds: (object, ids) => told.push([object, { ...ids }]) }),
    ).execute(scenario(), 'org');

    expect(told.map(([object]) => object)).toEqual(['Account', 'Contact', 'Case']);
    const cases = told[2][1];
    expect(Object.keys(cases).sort()).toEqual(
      ['c1', 'c2', 'c4', 'c5'].flatMap((c) => [`${c}-closed`, `${c}-open`]).sort(),
    );
    // Each key names the record written from its own row.
    for (const [key, id] of Object.entries(cases)) {
      const n = key.slice(1, 2);
      const subject = key.endsWith('-open') ? `Open ${n}` : `Closed ${n}`;
      expect(target.recordOf(id)?.Subject).toBe(subject);
    }
    expect(told[1][1]).not.toHaveProperty('c3');
  });

  it('tells the ids of the rows across the partitions of a seed large enough to take them', async () => {
    const target = keyedTarget();
    let cases: Record<string, string> = {};
    await new SeedOrchestrator(
      seedDeps(target.insert, {
        grappeAdapter: new SeedGrappeAdapter(() => 'gid', 3),
        grappeConfig: {
          enabled: true,
          autoActivateThreshold: 1,
          grappeSize: 3,
        } as SeedOrchestratorDependencies['grappeConfig'],
        onRowIds: (object, ids) => {
          if (object === 'Case') cases = { ...ids };
        },
      }),
    ).execute(scenario(), 'org');

    expect(Object.keys(cases)).toHaveLength(10);
    expect(target.recordOf(cases['c4-open'])?.Subject).toBe('Open 4');
  });

  it('tells nothing of an object written from rules', async () => {
    const target = keyedTarget();
    const onRowIds = vi.fn();
    const ruled: SeedTemplate = template(
      [
        {
          objectApiName: 'Account',
          recordCount: 2,
          fieldRules: [
            { fieldApiName: 'Name', ruleType: 'static', config: { staticValue: 'Acme' } },
          ],
          excludedFields: [],
          insertOrder: 0,
          batchSize: 200,
        },
      ],
      [],
    );
    await new SeedOrchestrator(seedDeps(target.insert, { onRowIds })).execute(ruled, 'org');

    expect(onRowIds).not.toHaveBeenCalled();
  });
});
