import { describe, it, expect, vi } from 'vitest';
import type { SyncObjectConfig } from '@sandforge/shared';
import { ContactPointNeutralizer } from '../forge/stages/ContactPointNeutralizer.js';
import { contactPointsOfRun, neutralizeSyncRows } from './syncContactPoints.js';
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

describe('neutralizeSyncRows', () => {
  it('puts every address under .invalid and every number in the fictional range, and says it', () => {
    const rows: Record<string, unknown>[] = [
      { LastName: 'Doe', Email: 'jane@acme.com', Phone: '+1 415 555 0100' },
      { LastName: 'Roe', Email: 'john@acme.com' },
    ];

    const note = neutralizeSyncRows(new ContactPointNeutralizer('k'), 'Contact', FIELDS, rows);

    expect(rows[0].Email).toBe('jane@acme.com.invalid');
    expect(rows[1].Email).toBe('john@acme.com.invalid');
    expect(String(rows[0].Phone)).toMatch(/^\+3363998\d{4}$/);
    expect(rows[0].LastName).toBe('Doe');
    expect(note).toBe(
      '3 email address(es) and phone number(s) of Contact neutralized (Email, Phone): addresses ' +
        "under .invalid, numbers fictional, so the target's automation reaches no one. A " +
        'configuration that keeps contact points copies them as read.',
    );
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

  it('says nothing of an object with no contact point, or of values already unreachable', () => {
    const rows: Record<string, unknown>[] = [{ LastName: 'Doe', Email: 'jane@acme.com.invalid' }];
    expect(neutralizeSyncRows(new ContactPointNeutralizer('k'), 'Contact', FIELDS, rows)).toBe(
      undefined,
    );
    expect(
      neutralizeSyncRows(
        new ContactPointNeutralizer('k'),
        'Account',
        [{ name: 'Name', type: 'string', queryable: true, createable: true, isReference: false }],
        [{ Name: 'Acme' }],
      ),
    ).toBeUndefined();
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

  it('sends neutralized emails and phone numbers when the run neutralizes, and says so in its notes', async () => {
    const insert = vi
      .fn()
      .mockResolvedValue([{ id: '003000000000901AAA', success: true, errors: [] }]);
    const rows = [{ Id: '003000000000001AAA', LastName: 'Doe', Email: 'jane@acme.com' }];

    const { notes } = await new DataSync(deps(insert)).write(objectConfig(), rows, {
      links: new SyncRunLinks(),
      sources: rows,
      contactPoints: new ContactPointNeutralizer('k'),
    });

    const sent = insert.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(sent[0].Email).toBe('jane@acme.com.invalid');
    expect(notes.some((note) => note.startsWith('1 email address(es) and phone number(s)'))).toBe(
      true,
    );
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
