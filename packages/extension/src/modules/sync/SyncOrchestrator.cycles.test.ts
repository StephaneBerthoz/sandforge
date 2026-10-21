/**
 * Objects whose lookups name each other, through the real orchestrator and
 * DataSync, against a target that refuses a lookup at a record it does not
 * hold: an account's primary contact, when the contacts name their accounts.
 * No order puts each after the other; the accounts go first, without their
 * contact, and are given its copy once the contacts are written.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SyncConfig, SyncObjectConfig } from '@sandforge/shared';
import { SyncOrchestrator, laterInCycles } from './SyncOrchestrator.js';
import { DataSync, type OperationOutcome } from './DataSync.js';
import { FieldMappingService } from './FieldMapping.js';
import { TransformPipeline } from './TransformPipeline.js';
import { ConflictResolver } from './ConflictResolver.js';
import { targetWriteFieldsOf, type TargetWriteFields } from './targetWriteFields.js';
import type { SyncDeltaReads, SyncDeltaStore } from './SyncDelta.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const DESCRIBES: Record<string, TargetWriteFields> = {
  Account: targetWriteFieldsOf({
    name: 'Account',
    fields: [
      { name: 'Name', createable: true, type: 'string' },
      {
        name: 'ParentId',
        createable: true,
        type: 'reference',
        referenceTo: ['Account'],
        nillable: true,
      },
      {
        name: 'Primary_Contact__c',
        createable: true,
        type: 'reference',
        referenceTo: ['Contact'],
        nillable: true,
      },
    ],
  }),
  Contact: targetWriteFieldsOf({
    name: 'Contact',
    fields: [
      { name: 'LastName', createable: true, type: 'string' },
      {
        name: 'AccountId',
        createable: true,
        type: 'reference',
        referenceTo: ['Account'],
        nillable: true,
      },
    ],
  }),
};

/** The source: two accounts, each naming the contact under it. */
function sourceOrg(): Record<string, Array<Record<string, unknown>>> {
  return {
    Account: [
      { Id: fakeId('001', 1), Name: 'Acme', Primary_Contact__c: fakeId('003', 1) },
      { Id: fakeId('001', 2), Name: 'Globex', Primary_Contact__c: fakeId('003', 2) },
    ],
    Contact: [
      { Id: fakeId('003', 1), LastName: 'Roe', AccountId: fakeId('001', 1) },
      { Id: fakeId('003', 2), LastName: 'Doe', AccountId: fakeId('001', 2) },
    ],
  };
}

/** A lookup of a payload at a record the target does not hold. */
function unknownLookup(
  held: ReadonlyMap<string, Record<string, unknown>>,
  record: Record<string, unknown>,
): boolean {
  return ['AccountId', 'Primary_Contact__c'].some((field) => {
    const value = record[field];
    return typeof value === 'string' && !held.has(value);
  });
}

const CROSS_REFERENCE: OperationOutcome = {
  success: false,
  errors: ['INVALID_CROSS_REFERENCE_KEY: invalid cross reference id'],
};

/**
 * The target: what it holds, an insert and an update that refuse a lookup at
 * a record it does not hold, and an insert that refuses a contact named
 * "Refused".
 */
function targetOrg(holds: Array<[string, Record<string, unknown>]> = []) {
  const held = new Map<string, Record<string, unknown>>(holds);
  let next = 900;
  const insert = vi.fn(
    async (object: string, records: Record<string, unknown>[]): Promise<OperationOutcome[]> =>
      records.map((record) => {
        if (unknownLookup(held, record)) return CROSS_REFERENCE;
        if (record.LastName === 'Refused') {
          return { success: false, errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: no'] };
        }
        const id = fakeId(object === 'Account' ? '001' : '003', next++);
        held.set(id, { ...record, object });
        return { id, success: true, errors: [] };
      }),
  );
  const update = vi.fn(
    async (_object: string, records: Record<string, unknown>[]): Promise<OperationOutcome[]> =>
      records.map((record) => {
        const id = String(record.Id);
        const known = held.get(id);
        if (!known) return { success: false, errors: ['ENTITY_IS_DELETED: gone'] };
        if (unknownLookup(held, record)) return CROSS_REFERENCE;
        held.set(id, { ...known, ...record });
        return { id, success: true, errors: [] };
      }),
  );
  return { held, insert, update };
}

function insertOf(objectApiName: string, insertOrder: number): SyncObjectConfig {
  return {
    objectApiName,
    operation: 'insert',
    fieldMappings: [],
    transformRules: [],
    excludedFields: [],
    addOnFields: [],
    batchSize: 200,
    insertOrder,
  };
}

function config(): SyncConfig {
  return {
    id: 'cfg-cycles',
    name: 'Accounts and their contacts',
    description: '',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    direction: 'source_to_target',
    mode: 'full',
    objects: [insertOf('Account', 0), insertOf('Contact', 1)],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  };
}

function orchestrator(
  target: ReturnType<typeof targetOrg>,
  source: Record<string, Array<Record<string, unknown>>>,
  extra: Partial<ConstructorParameters<typeof SyncOrchestrator>[0]> = {},
): SyncOrchestrator {
  const unused = async (): Promise<OperationOutcome[]> => [];
  const describeTargetFields = async (object: string) => DESCRIBES[object];
  return new SyncOrchestrator({
    dataSync: new DataSync({
      insert: (object, records) => target.insert(object, records),
      update: (object, records) => target.update(object, records),
      upsert: unused,
      delete: unused,
      describeTargetFields,
    }),
    conflictResolver: new ConflictResolver(),
    fieldMapping: new FieldMappingService(),
    transformPipeline: new TransformPipeline(),
    querySource: async (_org, objectConfig) => source[objectConfig.objectApiName],
    queryTarget: async () => [],
    describeTargetFields,
    ...extra,
  });
}

/** What the target holds of an object, by name, with the name of the record a lookup names. */
function heldAs(
  target: ReturnType<typeof targetOrg>,
  object: string,
  field: string,
): Array<[unknown, unknown]> {
  return [...target.held.values()]
    .filter((record) => record.object === object)
    .map((record) => {
      const named = target.held.get(record[field] as string);
      return [record.Name ?? record.LastName, named ? (named.Name ?? named.LastName) : undefined];
    });
}

describe('laterInCycles', () => {
  it('names, for each object of a cycle, the objects of it written after', () => {
    const later = laterInCycles({ cycles: [['Account', 'Contact', 'Case']] });

    expect([...(later.get('Account') ?? [])]).toEqual(['Contact', 'Case']);
    expect([...(later.get('Contact') ?? [])]).toEqual(['Case']);
    expect(later.has('Case')).toBe(false);
    expect(laterInCycles(undefined).size).toBe(0);
  });
});

describe('SyncOrchestrator — objects whose lookups name each other', () => {
  it('gives each account the copy of its contact once the contacts are written, and says so', async () => {
    const target = targetOrg();

    const result = await orchestrator(target, sourceOrg()).execute(config());

    expect(result.status).toBe('success');
    expect(result.objectResults.map((o) => [o.objectApiName, o.success, o.failed])).toEqual([
      ['Account', 2, 0],
      ['Contact', 2, 0],
    ]);
    // Inserted without the lookup, never refused for it, then given its copy.
    expect(target.insert.mock.calls[0][1]).toEqual([{ Name: 'Acme' }, { Name: 'Globex' }]);
    expect(heldAs(target, 'Account', 'Primary_Contact__c')).toEqual([
      ['Acme', 'Roe'],
      ['Globex', 'Doe'],
    ]);
    expect(heldAs(target, 'Contact', 'AccountId')).toEqual([
      ['Roe', 'Acme'],
      ['Doe', 'Globex'],
    ]);
    const accounts = result.objectResults[0];
    expect(accounts.lookupsSetAfter).toEqual({
      records: 2,
      fields: ['Primary_Contact__c'],
      after: ['Contact'],
    });
    expect(accounts.lookupsLeftOut).toBeUndefined();
    expect(accounts.errors).toEqual([]);
  });

  it('dates the run’s last write after the accounts are given their contacts, so their removal takes them', async () => {
    const target = targetOrg();
    const said: string[] = [];
    const creations = {
      runId: 'run-cycle',
      note: (object: string, ids: readonly string[]) =>
        said.push(`created ${object} ${ids.length}`),
      touched: (object: string, rows: number) => said.push(`touched ${object} ${rows}`),
      flush: async () => undefined,
    };

    await orchestrator(target, sourceOrg(), { creations }).execute(config());

    expect(said).toEqual(['created Account 2', 'created Contact 2', 'touched Account 2']);
  });

  it('leaves an account without the contact the target refused, and says why', async () => {
    const source = sourceOrg();
    source.Contact[1] = { ...source.Contact[1], LastName: 'Refused' };
    const target = targetOrg();

    const result = await orchestrator(target, source).execute(config());

    expect(heldAs(target, 'Account', 'Primary_Contact__c')).toEqual([
      ['Acme', 'Roe'],
      ['Globex', undefined],
    ]);
    const accounts = result.objectResults[0];
    expect(accounts.lookupsSetAfter).toEqual({
      records: 1,
      fields: ['Primary_Contact__c'],
      after: ['Contact'],
    });
    expect(accounts.lookupsLeftOut).toEqual([
      { records: 1, fields: ['Primary_Contact__c'], reason: 'parentRefused' },
    ]);
  });

  it('sends as read a lookup at a contact the run did not write, which the target holds under that id', async () => {
    // Two sandboxes of one production: the target holds the contact under
    // the source's id, and the run reads only one of the two contacts.
    const source = sourceOrg();
    source.Contact = [source.Contact[0]];
    const target = targetOrg([[fakeId('003', 2), { LastName: 'Doe', object: 'Contact' }]]);

    const result = await orchestrator(target, source).execute(config());

    expect(heldAs(target, 'Account', 'Primary_Contact__c')).toEqual([
      ['Acme', 'Roe'],
      ['Globex', 'Doe'],
    ]);
    expect(result.objectResults[0].lookupsSetAfter?.records).toBe(2);
    expect(result.objectResults[0].lookupsLeftOut).toBeUndefined();
  });

  it('says the account left without a contact the target does not hold, once it refused the lookup', async () => {
    const source = sourceOrg();
    source.Contact = [source.Contact[0]];
    const target = targetOrg();

    const result = await orchestrator(target, source).execute(config());

    expect(heldAs(target, 'Account', 'Primary_Contact__c')).toEqual([
      ['Acme', 'Roe'],
      ['Globex', undefined],
    ]);
    expect(result.objectResults[0].lookupsLeftOut).toEqual([
      { records: 1, fields: ['Primary_Contact__c'], reason: 'notInTarget' },
    ]);
  });

  it('says the lookups a cancel before the contacts kept from being set', async () => {
    const stop = new AbortController();
    const target = targetOrg();
    const insert = target.insert.getMockImplementation();
    target.insert.mockImplementation(async (object, records) => {
      const outcomes = (await insert?.(object, records)) ?? [];
      if (object === 'Account') stop.abort();
      return outcomes;
    });

    const result = await orchestrator(target, sourceOrg(), { signal: stop.signal }).execute(
      config(),
    );

    expect(result.cancelled).toBe(true);
    expect(target.update).not.toHaveBeenCalled();
    expect(result.objectResults[0].lookupsLeftOut).toEqual([
      { records: 2, fields: ['Primary_Contact__c'], reason: 'notReached' },
    ]);
  });

  it('simulates the accounts as the run writes them, the lookup left for later', async () => {
    const target = targetOrg();
    const find = vi.fn(async () => new Map<string, number>());

    const simulation = await orchestrator(target, sourceOrg(), { findInTarget: find }).simulate(
      config(),
    );

    expect(simulation.writeOrder?.cycles).toEqual([['Account', 'Contact']]);
    expect(simulation.objects.map((o) => [o.objectApiName, o.insert, o.refused])).toEqual([
      ['Account', 2, 0],
      ['Contact', 2, 0],
    ]);
    expect(target.insert).not.toHaveBeenCalled();
  });
});

describe('SyncOrchestrator — the watermark of a delta configuration whose lookups wait', () => {
  /** The source's latest stamp, as the org answers it before each object is read. */
  const STAMP = '2026-10-13T09:00:00.000Z';

  /** A store of watermarks in memory, and the delta reads that stamp every object. */
  function delta() {
    const recorded = new Map<string, string>();
    const deltaStore: SyncDeltaStore = {
      load: () => ({ kind: 'none' }),
      record: (_configId, watermark) => {
        recorded.set(watermark.objectApiName, watermark.watermark);
      },
    };
    const deltaReads = {
      latestModstamp: vi.fn(async () => STAMP),
    } as unknown as SyncDeltaReads;
    return { recorded, extra: { deltaStore, deltaReads } };
  }

  const deltaConfig = (objects = config().objects): SyncConfig => ({
    ...config(),
    mode: 'delta',
    objects,
  });

  it('records the watermark of an object of a cycle once every lookup it waited for is set', async () => {
    const target = targetOrg();
    const { recorded, extra } = delta();

    const result = await orchestrator(target, sourceOrg(), extra).execute(deltaConfig());

    expect(result.objectResults[0].lookupsSetAfter?.records).toBe(2);
    expect(result.objectResults.map((o) => [o.objectApiName, o.delta?.recorded])).toEqual([
      ['Account', STAMP],
      ['Contact', STAMP],
    ]);
    expect(result.objectResults[0].delta?.lookupsOwed).toBeUndefined();
    expect(recorded).toEqual(
      new Map([
        ['Account', STAMP],
        ['Contact', STAMP],
      ]),
    );
  });

  it('keeps the watermark of an object whose lookup the cycle’s pass could not set, and says why', async () => {
    // The target refused the update that gave Globex its contact. Recorded
    // as the accounts were written, the watermark moved past Globex, which
    // the next delta run did not read again: its lookup stayed unset for good.
    const target = targetOrg();
    const update = target.update.getMockImplementation();
    target.update.mockImplementation(async (object, records) => {
      const outcomes = (await update?.(object, records)) ?? [];
      return outcomes.map((outcome, at) =>
        target.held.get(String(records[at].Id))?.Name === 'Globex'
          ? { success: false, errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: locked'] }
          : outcome,
      );
    });
    const { recorded, extra } = delta();

    const result = await orchestrator(target, sourceOrg(), extra).execute(deltaConfig());

    const accounts = result.objectResults[0];
    expect(accounts.lookupsLeftOut).toEqual([
      expect.objectContaining({ records: 1, reason: 'notSet' }),
    ]);
    expect(accounts.delta?.recorded).toBeUndefined();
    expect(accounts.delta?.lookupsOwed).toBe(1);
    expect(recorded.has('Account')).toBe(false);
    // The contacts' own watermark moves: nothing of theirs waits.
    expect(recorded.get('Contact')).toBe(STAMP);
  });

  it('keeps it too when the record a lookup names was refused, so that the next run sets it', async () => {
    const source = sourceOrg();
    source.Contact[1] = { ...source.Contact[1], LastName: 'Refused' };
    const target = targetOrg();
    const { recorded, extra } = delta();

    const result = await orchestrator(target, source, extra).execute(deltaConfig());

    expect(result.objectResults[0].delta).toMatchObject({ lookupsOwed: 1 });
    expect(result.objectResults[0].delta?.recorded).toBeUndefined();
    expect(recorded.size).toBe(0);
  });

  it('keeps the watermark of an object whose rows naming each other were not all given their lookup', async () => {
    // An account and its parent, both new: the account goes first without
    // its parent, and the update that sets it once the parent has its copy
    // is refused.
    const target = targetOrg();
    target.update.mockImplementation(async (_object, records) =>
      records.map(() => ({ success: false, errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: no'] })),
    );
    const source = {
      Account: [
        { Id: fakeId('001', 1), Name: 'Child', ParentId: fakeId('001', 2) },
        { Id: fakeId('001', 2), Name: 'Parent' },
      ],
    };
    const { recorded, extra } = delta();

    const result = await orchestrator(target, source, extra).execute(
      deltaConfig([insertOf('Account', 0)]),
    );

    const accounts = result.objectResults[0];
    expect(accounts.success).toBe(2);
    expect(accounts.lookupsLeftOut).toEqual([
      expect.objectContaining({ records: 1, fields: ['ParentId'], reason: 'notSet' }),
    ]);
    expect(accounts.delta).toMatchObject({ lookupsOwed: 1 });
    expect(accounts.delta?.recorded).toBeUndefined();
    expect(recorded.size).toBe(0);
  });

  it('keeps the watermark of an object whose lookups a cancel kept from being set', async () => {
    const stop = new AbortController();
    const target = targetOrg();
    const insert = target.insert.getMockImplementation();
    target.insert.mockImplementation(async (object, records) => {
      const outcomes = (await insert?.(object, records)) ?? [];
      if (object === 'Account') stop.abort();
      return outcomes;
    });
    const { recorded, extra } = delta();

    const result = await orchestrator(target, sourceOrg(), {
      ...extra,
      signal: stop.signal,
    }).execute(deltaConfig());

    expect(result.cancelled).toBe(true);
    expect(result.objectResults[0].delta).toMatchObject({ lookupsOwed: 2 });
    expect(recorded.size).toBe(0);
  });
});
