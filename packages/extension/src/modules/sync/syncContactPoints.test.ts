import { describe, it, expect, vi } from 'vitest';
import type { SyncObjectConfig } from '@sandforge/shared';
import { ContactPointNeutralizer } from '../forge/stages/ContactPointNeutralizer.js';
import {
  contactPointsOfResult,
  contactPointsOfRun,
  neutralizeSyncRows,
} from './syncContactPoints.js';
import { DataSync, type DataSyncDeps } from './DataSync.js';
import { SyncRunLinks } from './syncRowPreparation.js';
import { targetWriteFieldsOf } from './targetWriteFields.js';
import type { FieldInfo } from '../forge/ForgeExecutor.js';

/** The target's Contact: a name, an email, a phone, and an external id that holds an address. */
const CONTACT_FIELDS = [
  { name: 'LastName', createable: true, type: 'string', length: 80 },
  { name: 'Email', createable: true, type: 'email', length: 80 },
  { name: 'Phone', createable: true, type: 'phone', length: 40 },
  { name: 'Login_Email__c', createable: true, type: 'email', length: 80 },
];

const FIELDS: FieldInfo[] = targetWriteFieldsOf({ name: 'Contact', fields: CONTACT_FIELDS })
  .fields as FieldInfo[];

describe('contactPointsOfRun', () => {
  it('neutralizes by default, and keeps the contact points of a configuration that says so', () => {
    expect(contactPointsOfRun({})).toBeInstanceOf(ContactPointNeutralizer);
    expect(contactPointsOfRun({ keepContactPoints: false })).toBeInstanceOf(
      ContactPointNeutralizer,
    );
    expect(contactPointsOfRun({ keepContactPoints: true })).toBeUndefined();
  });
});

describe('contactPointsOfResult', () => {
  it('says what the run neutralized, field by field, as a Forge run says it', () => {
    const neutralizer = new ContactPointNeutralizer('k');
    neutralizeSyncRows(neutralizer, 'Contact', FIELDS, [
      { LastName: 'Doe', Email: 'jane@acme.com', Phone: '+1 415 555 0100' },
    ]);

    expect(contactPointsOfResult(neutralizer, true)).toEqual({
      neutralized: true,
      fields: [
        { objectApiName: 'Contact', field: 'Email', kind: 'email', values: 1 },
        { objectApiName: 'Contact', field: 'Phone', kind: 'phone', values: 1 },
      ],
      values: 2,
    });
  });

  it('says nothing of a run that neutralized no value', () => {
    expect(contactPointsOfResult(new ContactPointNeutralizer('k'), true)).toBeUndefined();
  });

  it('says a run that keeps them wrote them as read, once it wrote a record', () => {
    expect(contactPointsOfResult(undefined, true)).toEqual({
      neutralized: false,
      fields: [],
      values: 0,
    });
    expect(contactPointsOfResult(undefined, false)).toBeUndefined();
  });
});

describe('neutralizeSyncRows', () => {
  it('puts every address under .invalid and every number in the fictional range, and counts each', () => {
    const rows: Record<string, unknown>[] = [
      { LastName: 'Doe', Email: 'jane@acme.com', Phone: '+1 415 555 0100' },
      { LastName: 'Roe', Email: 'john@acme.com' },
    ];
    const neutralizer = new ContactPointNeutralizer('k');

    neutralizeSyncRows(neutralizer, 'Contact', FIELDS, rows);

    expect(rows[0].Email).toBe('jane@acme.com.invalid');
    expect(rows[1].Email).toBe('john@acme.com.invalid');
    // In the layout of the number it replaces.
    expect(String(rows[0].Phone)).toMatch(/^\+3 363 998 \d{4}$/);
    expect(rows[0].LastName).toBe('Doe');
    expect(neutralizer.report().values).toBe(3);
  });

  it('leaves the field the write matches on as read, so an upsert finds the copy an earlier run wrote', () => {
    const rows: Record<string, unknown>[] = [
      { Login_Email__c: 'jane@acme.com', Email: 'jane@acme.com' },
    ];

    neutralizeSyncRows(new ContactPointNeutralizer('k'), 'Contact', FIELDS, rows, 'Login_Email__c');

    expect(rows[0]).toEqual({
      Login_Email__c: 'jane@acme.com',
      Email: 'jane@acme.com.invalid',
    });
  });

  it('counts nothing of an object with no contact point, or of values already unreachable', () => {
    const neutralizer = new ContactPointNeutralizer('k');
    const rows: Record<string, unknown>[] = [{ LastName: 'Doe', Email: 'jane@acme.com.invalid' }];
    neutralizeSyncRows(neutralizer, 'Contact', FIELDS, rows);
    neutralizeSyncRows(
      neutralizer,
      'Account',
      [{ name: 'Name', type: 'string', queryable: true, createable: true, isReference: false }],
      [{ Name: 'Acme' }],
    );

    expect(rows[0].Email).toBe('jane@acme.com.invalid');
    expect(neutralizer.report().values).toBe(0);
  });
});

describe('a Sync write', () => {
  function objectConfig(overrides?: Partial<SyncObjectConfig>): SyncObjectConfig {
    return {
      objectApiName: 'Contact',
      operation: 'insert',
      fieldMappings: [],
      transformRules: [],
      excludedFields: [],
      addOnFields: [],
      batchSize: 200,
      insertOrder: 1,
      ...overrides,
    };
  }

  function deps(insert: DataSyncDeps['insert']): DataSyncDeps {
    const unused = vi.fn().mockResolvedValue([]);
    return {
      insert,
      update: unused,
      upsert: unused,
      delete: unused,
      describeTargetFields: async () =>
        targetWriteFieldsOf({ name: 'Contact', fields: CONTACT_FIELDS }),
    };
  }

  it('sends neutralized emails and phone numbers when the run neutralizes, counted by the run, not among its errors', async () => {
    const insert = vi
      .fn()
      .mockResolvedValue([{ id: '003000000000901AAA', success: true, errors: [] }]);
    const rows = [{ Id: '003000000000001AAA', LastName: 'Doe', Email: 'jane@acme.com' }];
    const contactPoints = new ContactPointNeutralizer('k');

    const result = await new DataSync(deps(insert)).sync(objectConfig(), rows, {
      links: new SyncRunLinks(),
      sources: rows,
      contactPoints,
    });

    const sent = insert.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(sent[0].Email).toBe('jane@acme.com.invalid');
    // The run's result says it once: among the object's errors, every Sync of
    // contacts showed it in red, in English.
    expect(contactPoints.report().fields).toEqual([
      { objectApiName: 'Contact', field: 'Email', kind: 'email', values: 1 },
    ]);
    expect(result.errors).toEqual([]);
  });

  it('sends them as read for a run that keeps them', async () => {
    const insert = vi
      .fn()
      .mockResolvedValue([{ id: '003000000000901AAA', success: true, errors: [] }]);
    const rows = [{ Id: '003000000000001AAA', LastName: 'Doe', Email: 'jane@acme.com' }];

    await new DataSync(deps(insert)).write(objectConfig(), rows, {
      links: new SyncRunLinks(),
      sources: rows,
    });

    const sent = insert.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(sent[0].Email).toBe('jane@acme.com');
  });

  it("neutralizes a write made without a run, Real-time's, with the neutralizer it was given", async () => {
    // Real-time writes through here with no run, and copied a contact's
    // email and phone as read whatever the configuration said.
    const upsert = vi
      .fn()
      .mockResolvedValue([{ id: '003000000000901AAA', success: true, errors: [] }]);
    const rows = [{ LastName: 'Doe', Email: 'jane@acme.com', Login_Email__c: 'jane@acme.com' }];
    const config = objectConfig({ operation: 'upsert', externalIdField: 'Login_Email__c' });

    await new DataSync({
      ...deps(vi.fn()),
      upsert,
      contactPoints: new ContactPointNeutralizer('k'),
    }).write(config, rows);
    await new DataSync({ ...deps(vi.fn()), upsert }).write(config, rows);

    const neutralized = upsert.mock.calls[0][2] as Array<Record<string, unknown>>;
    expect(neutralized[0].Email).toBe('jane@acme.com.invalid');
    // The key the upsert finds the copy by is left as read.
    expect(neutralized[0].Login_Email__c).toBe('jane@acme.com');
    const asRead = upsert.mock.calls[1][2] as Array<Record<string, unknown>>;
    expect(asRead[0].Email).toBe('jane@acme.com');
  });
});
