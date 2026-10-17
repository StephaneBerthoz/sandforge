import { describe, it, expect, vi } from 'vitest';
import type { SyncObjectConfig } from '@sandforge/shared';
import { DataSync, type DataSyncDeps, type OperationOutcome } from './DataSync.js';
import { SyncRunLinks } from './syncRowPreparation.js';
import { WriteCancelledError } from './WriteCancelledError.js';
import { targetWriteFieldsOf } from './targetWriteFields.js';

/** Fake ids: the source's records, their copies in the target, a user. */
const SOURCE_ACCOUNT = '001000000000001AAA';
const REFUSED_ACCOUNT = '001000000000002AAA';
const TARGET_ACCOUNT = '001000000000901AAA';
const SOURCE_CONTACT = '003000000000001AAA';
const OWNER = '005000000000001AAA';

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

/** The target's Contact: a phone, its account and its owner. */
const CONTACT_TARGET = async () =>
  targetWriteFieldsOf({
    name: 'Contact',
    fields: [
      { name: 'LastName', createable: true, type: 'string' },
      { name: 'Phone', createable: true, type: 'phone' },
      { name: 'AccountId', createable: true, type: 'reference' },
      { name: 'OwnerId', createable: true, type: 'reference' },
    ],
  });

function deps(insert: DataSyncDeps['insert'], update?: DataSyncDeps['update']): DataSyncDeps {
  const unused = vi.fn().mockResolvedValue([]);
  return {
    insert,
    update: update ?? unused,
    upsert: unused,
    delete: unused,
    describeTargetFields: CONTACT_TARGET,
  };
}

const crossReference: OperationOutcome = {
  id: '',
  success: false,
  errors: [
    'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY: insufficient access rights on cross-reference id',
  ],
};

describe('DataSync — the run a write is part of', () => {
  it('adds what it wrote and what the target refused to the run, by the source id of each record', async () => {
    const insert = vi.fn().mockResolvedValue([
      { id: TARGET_ACCOUNT, success: true, errors: [] },
      { id: '', success: false, errors: ['REQUIRED_FIELD_MISSING: Name'] },
    ]);
    const links = new SyncRunLinks();
    const rows = [
      { Id: SOURCE_ACCOUNT, LastName: 'Acme' },
      { Id: REFUSED_ACCOUNT, LastName: 'Globex' },
    ];

    await new DataSync(deps(insert)).write(objectConfig({ objectApiName: 'Account' }), rows, {
      links,
      sources: rows,
    });

    expect(links.targetOf(SOURCE_ACCOUNT)).toBe(TARGET_ACCOUNT);
    expect(links.refusedObjectOf(REFUSED_ACCOUNT)).toBe('Account');
  });

  it('links a record the target refused as a duplicate of one it named, and counts it apart', async () => {
    const duplicate =
      'DUPLICATE_VALUE: duplicate value found: Ext_Id__c duplicates value on record with id: 001000000000800';
    const insert = vi
      .fn()
      .mockResolvedValue([
        { id: '', success: false, errors: [duplicate], existingId: '001000000000800AAA' },
      ]);
    const links = new SyncRunLinks();
    const rows = [{ Id: SOURCE_ACCOUNT, LastName: 'Acme' }];

    const result = await new DataSync(deps(insert)).sync(
      objectConfig({ objectApiName: 'Account' }),
      rows,
      { links, sources: rows },
    );

    // What hangs from it follows it to the record the target holds.
    expect(links.targetOf(SOURCE_ACCOUNT)).toBe('001000000000800AAA');
    expect(links.refusedObjectOf(SOURCE_ACCOUNT)).toBeUndefined();
    expect(result).toMatchObject({ processed: 1, success: 0, failed: 0, skipped: 1 });
    expect(result.errors).toEqual([
      `LINKED_TO_EXISTING: 1 Account record linked to an existing record, not written: the ` +
        `target refused it as a duplicate of a record it holds and named it (${duplicate}); ` +
        'what the run writes under it points at that record.',
    ]);
  });

  it('links no record an update was refused for: the record the target names is another', async () => {
    const update = vi.fn().mockResolvedValue([
      {
        id: '',
        success: false,
        errors: ['DUPLICATE_VALUE: duplicate value found: Ext_Id__c duplicates value'],
        existingId: '001000000000800AAA',
      },
    ]);
    const links = new SyncRunLinks();
    const rows = [{ Id: SOURCE_ACCOUNT, LastName: 'Acme' }];

    const result = await new DataSync(deps(vi.fn(), update)).sync(
      objectConfig({ objectApiName: 'Account', operation: 'update' }),
      rows,
      { links, sources: rows },
    );

    expect(links.targetOf(SOURCE_ACCOUNT)).toBeUndefined();
    expect(result).toMatchObject({ failed: 1, skipped: 0 });
  });

  it('takes no record an update did not reach for refused: the target holds it already', async () => {
    const update = vi
      .fn()
      .mockResolvedValue([{ id: '', success: false, errors: ['ENTITY_IS_LOCKED: locked'] }]);
    const links = new SyncRunLinks();
    const rows = [{ Id: SOURCE_ACCOUNT, LastName: 'Acme' }];

    await new DataSync(deps(vi.fn(), update)).write(
      objectConfig({ objectApiName: 'Account', operation: 'update' }),
      rows,
      { links, sources: rows },
    );

    expect(links.refusedObjectOf(SOURCE_ACCOUNT)).toBeUndefined();
  });

  it('holds back a contact under an account the run refused, and adds it to the refused', async () => {
    const insert = vi.fn();
    const links = new SyncRunLinks();
    links.noteRefused(REFUSED_ACCOUNT, 'Account');
    const rows = [{ Id: SOURCE_CONTACT, LastName: 'Roe', AccountId: REFUSED_ACCOUNT }];

    const result = await new DataSync(deps(insert)).sync(objectConfig(), rows, {
      links,
      sources: rows,
    });

    expect(insert).not.toHaveBeenCalled();
    expect(result).toMatchObject({ processed: 1, success: 0, failed: 1 });
    expect(result.errors).toEqual([
      expect.stringMatching(/^PARENT_REFUSED: 1 Contact record held back, not sent/),
    ]);
    // Its own children are held back in turn.
    expect(links.refusedObjectOf(SOURCE_CONTACT)).toBe('Contact');
  });

  it('writes a contact again without the owner it cannot take, never without the account the run wrote', async () => {
    // Run into a client sandbox, contacts were written again without
    // AccountId, OwnerId and RecordTypeId to get them in, and stood alone.
    const insert = vi
      .fn()
      .mockResolvedValueOnce([crossReference])
      .mockResolvedValueOnce([{ id: '003000000000901AAA', success: true, errors: [] }]);
    const links = new SyncRunLinks();
    links.noteWritten(SOURCE_ACCOUNT, TARGET_ACCOUNT);
    const rows = [
      { Id: SOURCE_CONTACT, LastName: 'Roe', AccountId: SOURCE_ACCOUNT, OwnerId: OWNER },
    ];

    const result = await new DataSync(deps(insert)).sync(objectConfig(), rows, {
      links,
      sources: rows,
    });

    expect(insert.mock.calls[0][1]).toEqual([
      { LastName: 'Roe', AccountId: TARGET_ACCOUNT, OwnerId: OWNER },
    ]);
    expect(insert.mock.calls[1][1]).toEqual([{ LastName: 'Roe', AccountId: TARGET_ACCOUNT }]);
    expect(result.success).toBe(1);
    expect(result.errors).toEqual([
      '1 record(s) written without OwnerId: the lookup held an id from the source org that the ' +
        'target does not have.',
    ]);
  });

  it('leaves a contact refused rather than write it without the account the run wrote', async () => {
    const insert = vi.fn().mockResolvedValue([crossReference]);
    const links = new SyncRunLinks();
    links.noteWritten(SOURCE_ACCOUNT, TARGET_ACCOUNT);
    const rows = [{ Id: SOURCE_CONTACT, LastName: 'Roe', AccountId: SOURCE_ACCOUNT }];

    const result = await new DataSync(deps(insert)).sync(objectConfig(), rows, {
      links,
      sources: rows,
    });

    expect(insert).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: 0, failed: 1 });
  });

  it('writes a row again without the field a validation rule named, and says which, how many and why', async () => {
    // The rule's own words end their sentence: said once, not twice.
    const refusedPhone: OperationOutcome = {
      id: '',
      success: false,
      errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: Phone must read +33 X XX XX XX XX.'],
      errorDetails: [
        {
          statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
          message: 'Phone must read +33 X XX XX XX XX.',
          fields: ['Phone'],
        },
      ],
    };
    const insert = vi
      .fn()
      .mockResolvedValueOnce([refusedPhone])
      .mockResolvedValueOnce([{ id: '003000000000901AAA', success: true, errors: [] }]);

    const result = await new DataSync(deps(insert)).sync(objectConfig(), [
      { LastName: 'Roe', Phone: '555-0100' },
    ]);

    expect(insert.mock.calls[1][1]).toEqual([{ LastName: 'Roe' }]);
    expect(result.success).toBe(1);
    expect(result.errors).toEqual([
      '1 record(s) written again without the fields the target refused them on, 1 written ' +
        'without Phone: a validation rule of the target refused it, ' +
        'FIELD_CUSTOM_VALIDATION_EXCEPTION: Phone must read +33 X XX XX XX XX.',
    ]);
  });

  it('sends a row again for each kind of refusal the target names one after the other', async () => {
    // Run against a target with a phone rule, a contact refused for its
    // phone went again without it, and was then refused for its owner, which
    // the first refusal had not named: sent again once, it stayed refused.
    const refusedPhone: OperationOutcome = {
      id: '',
      success: false,
      errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: Phone must read +33 X XX XX XX XX'],
      errorDetails: [
        {
          statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
          message: 'Phone must read +33 X XX XX XX XX',
          fields: ['Phone'],
        },
      ],
    };
    const insert = vi
      .fn()
      .mockResolvedValueOnce([refusedPhone])
      .mockResolvedValueOnce([crossReference])
      .mockResolvedValueOnce([{ id: '003000000000901AAA', success: true, errors: [] }]);
    const links = new SyncRunLinks();
    links.noteWritten(SOURCE_ACCOUNT, TARGET_ACCOUNT);
    const rows = [
      {
        Id: SOURCE_CONTACT,
        LastName: 'Roe',
        Phone: '555-0100',
        AccountId: SOURCE_ACCOUNT,
        OwnerId: OWNER,
      },
    ];

    const result = await new DataSync(deps(insert)).sync(objectConfig(), rows, {
      links,
      sources: rows,
    });

    expect(insert).toHaveBeenCalledTimes(3);
    expect(insert.mock.calls[2][1]).toEqual([{ LastName: 'Roe', AccountId: TARGET_ACCOUNT }]);
    expect(result).toMatchObject({ success: 1, failed: 0 });
    expect(result.errors).toEqual([
      '1 record(s) written without OwnerId: the lookup held an id from the source org that the ' +
        'target does not have.',
      '1 record(s) written again without the fields the target refused them on, 1 written ' +
        'without Phone: a validation rule of the target refused it, ' +
        'FIELD_CUSTOM_VALIDATION_EXCEPTION: Phone must read +33 X XX XX XX XX.',
    ]);
  });

  it('says why a row sent again was refused again, in the target’s last words', async () => {
    // Two accounts sharing a unique value went without their owner, and the
    // second was then refused for the value: the result said only the owner.
    const insert = vi
      .fn()
      .mockResolvedValueOnce([crossReference])
      .mockResolvedValueOnce([
        { id: '', success: false, errors: ['DUPLICATE_VALUE: duplicate value found: Code__c'] },
      ]);
    const rows = [{ Id: SOURCE_CONTACT, LastName: 'Roe', OwnerId: OWNER }];

    const result = await new DataSync(deps(insert)).sync(objectConfig(), rows, {
      links: new SyncRunLinks(),
      sources: rows,
    });

    expect(insert).toHaveBeenCalledTimes(2);
    expect(result.errors).toEqual(['DUPLICATE_VALUE: duplicate value found: Code__c']);
  });

  it('never writes a row again without the account the run wrote, whatever rule names it', async () => {
    const refusedAccount: OperationOutcome = {
      id: '',
      success: false,
      errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: a customer account only'],
      errorDetails: [
        {
          statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
          message: 'a customer account only',
          fields: ['AccountId'],
        },
      ],
    };
    const insert = vi.fn().mockResolvedValue([refusedAccount]);
    const links = new SyncRunLinks();
    links.noteWritten(SOURCE_ACCOUNT, TARGET_ACCOUNT);
    const rows = [{ Id: SOURCE_CONTACT, LastName: 'Roe', AccountId: SOURCE_ACCOUNT }];

    const result = await new DataSync(deps(insert)).sync(objectConfig(), rows, {
      links,
      sources: rows,
    });

    expect(insert).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: 0, failed: 1 });
  });
});

describe('DataSync — rows of one write that name each other', () => {
  /** Fake ids: three source accounts and their copies, by the order they are written. */
  const PARENT = '001000000000011AAA';
  const CHILD = '001000000000012AAA';
  const GRANDCHILD = '001000000000013AAA';
  const copyOf = (n: number): string => `001000000000${900 + n}AAA`;

  const ACCOUNT_TARGET = async () =>
    targetWriteFieldsOf({
      name: 'Account',
      fields: [
        { name: 'Name', createable: true, type: 'string' },
        { name: 'ParentId', createable: true, type: 'reference', referenceTo: ['Account'] },
      ],
    });

  /** An insert that writes every row, each given the next copy id. */
  const writesAll = () =>
    vi.fn(async (_object: string, records: Record<string, unknown>[]) =>
      records.map((_, n) => ({ id: copyOf(n + 1), success: true, errors: [] })),
    );

  function accountDeps(
    insert: DataSyncDeps['insert'],
    update: DataSyncDeps['update'],
  ): DataSyncDeps {
    const unused = vi.fn().mockResolvedValue([]);
    return { insert, update, upsert: unused, delete: unused, describeTargetFields: ACCOUNT_TARGET };
  }

  const write = (deps: DataSyncDeps, rows: Array<Record<string, unknown>>) =>
    new DataSync(deps).sync(objectConfig({ objectApiName: 'Account' }), rows, {
      links: new SyncRunLinks(),
      sources: rows,
    });

  it('writes a parent and its child without the lookup, then points the child at the copy of its parent', async () => {
    const insert = writesAll();
    const update = vi.fn(async (_object: string, records: Record<string, unknown>[]) =>
      records.map((r) => ({ id: r.Id as string, success: true, errors: [] })),
    );

    const result = await write(accountDeps(insert, update), [
      { Id: CHILD, Name: 'Child', ParentId: PARENT },
      { Id: PARENT, Name: 'Parent', ParentId: null },
      { Id: GRANDCHILD, Name: 'Grandchild', ParentId: CHILD },
    ]);

    expect(insert.mock.calls[0][1]).toEqual([
      { Name: 'Child' },
      { Name: 'Parent', ParentId: null },
      { Name: 'Grandchild' },
    ]);
    expect(update.mock.calls[0][1]).toEqual([
      { Id: copyOf(1), ParentId: copyOf(2) },
      { Id: copyOf(3), ParentId: copyOf(1) },
    ]);
    expect(result).toMatchObject({ success: 3, failed: 0, errors: [] });
  });

  it('gives each of two accounts that name each other the copy of the other, each written once', async () => {
    const insert = writesAll();
    const update = vi.fn(async (_object: string, records: Record<string, unknown>[]) =>
      records.map((r) => ({ id: r.Id as string, success: true, errors: [] })),
    );

    await write(accountDeps(insert, update), [
      { Id: PARENT, Name: 'One', ParentId: CHILD },
      { Id: CHILD, Name: 'Two', ParentId: PARENT },
    ]);

    expect(insert).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][1]).toEqual([
      { Id: copyOf(1), ParentId: copyOf(2) },
      { Id: copyOf(2), ParentId: copyOf(1) },
    ]);
  });

  it('says the rows left without their parent the target refused, and those whose update it refused', async () => {
    const insert = vi.fn().mockResolvedValue([
      { id: '', success: false, errors: ['REQUIRED_FIELD_MISSING: Region__c'] },
      { id: copyOf(2), success: true, errors: [] },
      { id: copyOf(3), success: true, errors: [] },
      { id: copyOf(4), success: true, errors: [] },
    ]);
    const update = vi
      .fn()
      .mockResolvedValue([
        { id: '', success: false, errors: ['FIELD_INTEGRITY_EXCEPTION: parent loop'] },
      ]);

    const result = await write(accountDeps(insert, update), [
      { Id: PARENT, Name: 'Refused', ParentId: null },
      { Id: CHILD, Name: 'Under the refused', ParentId: PARENT },
      { Id: GRANDCHILD, Name: 'Under the child', ParentId: CHILD },
      { Id: '001000000000014AAA', Name: 'Alone', ParentId: null },
    ]);

    expect(update.mock.calls[0][1]).toEqual([{ Id: copyOf(3), ParentId: copyOf(2) }]);
    expect(result.success).toBe(3);
    expect(result.errors).toEqual([
      'REQUIRED_FIELD_MISSING: Region__c',
      '1 Account record(s) written without ParentId: the Account record it names was refused in this run.',
      '1 Account record(s) written without ParentId: the target refused setting it once the ' +
        'record it names was written (FIELD_INTEGRITY_EXCEPTION: parent loop).',
    ]);
  });

  it('says the lookups a cancel kept from being set, and is cancelled with every row it wrote', async () => {
    const insert = writesAll();
    const update = vi.fn(async () => {
      throw new WriteCancelledError('Account', []);
    });

    const failure = await write(accountDeps(insert, update), [
      { Id: PARENT, Name: 'Parent', ParentId: null },
      { Id: CHILD, Name: 'Child', ParentId: PARENT },
    ]).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(WriteCancelledError);
    const cancelled = failure as WriteCancelledError;
    expect(cancelled.written.map((o) => o.id)).toEqual([copyOf(1), copyOf(2)]);
    expect(cancelled.notes).toEqual([
      '1 Account record(s) written without ParentId: the run was cancelled before it was set.',
    ]);
  });
});
