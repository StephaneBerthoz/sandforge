import { describe, it, expect, vi } from 'vitest';
import type { ConflictStrategy, SyncObjectConfig } from '@sandforge/shared';
import {
  OwnWriteLedger,
  RealtimeApplier,
  parseSalesforceDate,
  type ApplyPlan,
  type DescribedField,
  type OrgReader,
} from './RealtimeApplier';
import type { ChangeEvent } from './changeEvent';
import type { OperationOutcome } from '../sync/DataSync';

/** The fields of a Lead as a describe reports them, trimmed to what the tests use. */
const LEAD_FIELDS: DescribedField[] = [
  { name: 'Id', type: 'id', createable: false, updateable: false },
  { name: 'Ext__c', type: 'string', createable: true, updateable: true },
  { name: 'Website', type: 'url', createable: true, updateable: true },
  { name: 'LastName', type: 'string', createable: true, updateable: true },
  { name: 'Company', type: 'string', createable: true, updateable: true },
  { name: 'Title', type: 'string', createable: true, updateable: true },
  { name: 'NumberOfEmployees', type: 'int', createable: true, updateable: true },
  { name: 'IsConverted', type: 'boolean', createable: true, updateable: false },
  { name: 'LastModifiedDate', type: 'datetime', createable: false, updateable: false },
];

const COMMIT = Date.parse('2026-09-23T10:00:00.000Z');
const BEFORE = '2026-09-23T09:00:00.000+0000';
const AFTER = '2026-09-23T11:00:00.000+0000';

/**
 * An org held in memory, answering the one query shape the applier sends:
 * `SELECT … FROM Lead WHERE <field> IN (…)`.
 */
class MemoryOrg implements OrgReader {
  readonly queries: Array<{ soql: string; includeDeleted: boolean }> = [];

  constructor(
    readonly rows: Array<Record<string, unknown>>,
    readonly deleted: Array<Record<string, unknown>> = [],
    private readonly options: { caseInsensitive?: boolean } = {},
  ) {}

  async query(soql: string, options?: { includeDeleted?: boolean }) {
    const includeDeleted = options?.includeDeleted === true;
    this.queries.push({ soql, includeDeleted });
    const match = /^SELECT (.+) FROM (\w+) WHERE (\w+) IN \((.*)\)(?: LIMIT \d+)?$/.exec(soql);
    if (!match) throw new Error(`unexpected query: ${soql}`);
    const [, select, , field, list] = match;
    const fold = (v: string): string => (this.options.caseInsensitive ? v.toLowerCase() : v);
    const values = list.split(', ').map((v) => fold(v.replace(/^'|'$/g, '')));
    const pool = includeDeleted ? [...this.rows, ...this.deleted] : this.rows;
    return pool
      .filter((row) => values.includes(fold(String(row[field]))))
      .map((row) =>
        select === 'FIELDS(ALL)'
          ? { attributes: { type: 'Lead' }, ...row }
          : Object.fromEntries(select.split(', ').map((f) => [f, row[f] ?? null])),
      );
  }

  async describe() {
    return { fields: LEAD_FIELDS };
  }
}

/**
 * Sync's write path, recorded: each call answers success unless told
 * otherwise, with the id the org gives the record — the target's own, for a
 * record the key found.
 */
function recordingWrite(
  refuse?: (record: Record<string, unknown>) => string | undefined,
  idOf: (record: Record<string, unknown>, index: number) => string = (record, i) =>
    String(record['Id'] ?? `00Q00000000NEW${i}AAA`),
) {
  const calls: Array<{ config: SyncObjectConfig; records: Record<string, unknown>[] }> = [];
  const write = vi.fn(async (config: SyncObjectConfig, records: Record<string, unknown>[]) => {
    calls.push({ config, records });
    const outcomes: OperationOutcome[] = records.map((record, i) => {
      const error = refuse?.(record);
      return error
        ? { success: false, errors: [error] }
        : { id: idOf(record, i), success: true, errors: [] };
    });
    return { outcomes, notes: [] };
  });
  return { write, calls };
}

function plan(overrides: Partial<ApplyPlan> = {}): ApplyPlan {
  return {
    objectApiName: 'Lead',
    keyField: 'Ext__c',
    keySource: 'Ext__c',
    fieldMappings: [],
    addOnFields: [],
    transformRules: [],
    applyDeletes: false,
    ...overrides,
  };
}

function event(overrides: Partial<ChangeEvent> = {}): ChangeEvent {
  return {
    channel: '/data/LeadChangeEvent',
    replayId: 10,
    objectApiName: 'Lead',
    changeType: 'UPDATE',
    recordIds: ['00QSOURCE0000001AA'],
    commitTimestamp: COMMIT,
    commitUser: '005000000000001AAA',
    transactionKey: 'txn',
    changeOrigin: '',
    changedFieldNames: ['Title'],
    values: { Title: 'Buyer' },
    ...overrides,
  };
}

function applier(
  source: MemoryOrg,
  target: MemoryOrg,
  write: ReturnType<typeof recordingWrite>['write'],
  options: { plan?: Partial<ApplyPlan>; strategy?: ConflictStrategy; ledger?: OwnWriteLedger } = {},
) {
  return new RealtimeApplier(plan(options.plan), {
    source,
    target,
    write,
    conflictStrategy: options.strategy ?? 'source_wins',
    ownWrites: options.ledger ?? new OwnWriteLedger(),
  });
}

const sourceLead = { Id: '00QSOURCE0000001AA', Ext__c: 'K1', LastName: 'Doe', Company: 'Acme' };
const targetTwin = {
  Id: '00QTARGET0000001AA',
  Ext__c: 'K1',
  Title: 'Old',
  LastModifiedDate: BEFORE,
};

describe('RealtimeApplier — writing a change', () => {
  it('writes what an update changed onto the record its external id finds', async () => {
    const source = new MemoryOrg([sourceLead]);
    const target = new MemoryOrg([targetTwin]);
    const { write, calls } = recordingWrite();

    const { results, held } = await applier(source, target, write).apply([
      event({ values: { Title: 'Buyer', LastModifiedDate: '2026-09-23T10:00:00.000Z' } }),
    ]);

    expect(results).toEqual([{ outcome: 'applied' }]);
    expect(held).toEqual([]);
    // The key was not in the change: it is read from the source record.
    expect(source.queries[0].soql).toBe(
      "SELECT Id, Ext__c FROM Lead WHERE Id IN ('00QSOURCE0000001AA')",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].config).toMatchObject({ operation: 'upsert', externalIdField: 'Ext__c' });
    // An audit field the target will not take is not sent.
    expect(calls[0].records).toEqual([{ Title: 'Buyer', Ext__c: 'K1' }]);
  });

  it('creates a record the target does not have yet from a creation', async () => {
    const source = new MemoryOrg([sourceLead]);
    const target = new MemoryOrg([]);
    const { write, calls } = recordingWrite();

    const { results } = await applier(source, target, write).apply([
      event({
        changeType: 'CREATE',
        changedFieldNames: [],
        values: { Ext__c: 'K1', LastName: 'Doe', Company: 'Acme', IsConverted: false },
      }),
    ]);

    expect(results).toEqual([{ outcome: 'applied' }]);
    expect(source.queries).toEqual([]);
    expect(calls[0].records).toEqual([
      { LastName: 'Doe', Company: 'Acme', IsConverted: false, Ext__c: 'K1' },
    ]);
  });

  it('creates an email without the task the platform gives it, unless the email is on a case', async () => {
    // Sent with the task read from the source, the email is refused:
    // INSUFFICIENT_ACCESS_OR_READONLY, "you cannot modify this field".
    class EmailOrg extends MemoryOrg {
      async describe() {
        return {
          fields: [
            { name: 'Ext__c', type: 'string', createable: true, updateable: true },
            { name: 'Subject', type: 'string', createable: true, updateable: true },
            { name: 'ParentId', type: 'reference', createable: true, updateable: false },
            { name: 'RelatedToId', type: 'reference', createable: true, updateable: true },
            { name: 'ActivityId', type: 'reference', createable: true, updateable: false },
          ],
        };
      }
    }
    const { write, calls } = recordingWrite();
    const created = (recordId: string, values: Record<string, unknown>): ChangeEvent =>
      event({
        channel: '/data/EmailMessageChangeEvent',
        objectApiName: 'EmailMessage',
        changeType: 'CREATE',
        recordIds: [recordId],
        changedFieldNames: [],
        values,
      });

    const { results } = await applier(new EmailOrg([]), new EmailOrg([]), write, {
      plan: { objectApiName: 'EmailMessage', keyField: 'Ext__c', keySource: 'Ext__c' },
    }).apply([
      created('02sSOURCE0000001AA', {
        Ext__c: 'E1',
        Subject: 'Offer',
        RelatedToId: '0Q0SOURCE0000001AA',
        ActivityId: '00TSOURCE0000001AA',
      }),
      created('02sSOURCE0000002AA', {
        Ext__c: 'E2',
        Subject: 'Broken',
        ParentId: '500SOURCE0000001AA',
        ActivityId: '00TSOURCE0000002AA',
      }),
    ]);

    expect(results).toEqual([{ outcome: 'applied' }, { outcome: 'applied' }]);
    expect(calls[0].config).toMatchObject({ operation: 'upsert', externalIdField: 'Ext__c' });
    expect(calls[0].records).toEqual([
      { Subject: 'Offer', RelatedToId: '0Q0SOURCE0000001AA', Ext__c: 'E1' },
      {
        Subject: 'Broken',
        ParentId: '500SOURCE0000001AA',
        ActivityId: '00TSOURCE0000002AA',
        Ext__c: 'E2',
      },
    ]);
  });

  it('copies the whole source record when an update reaches a record the target lacks', async () => {
    // Written from the update alone, the target would get a record made of
    // one field, or none: the org refuses a Lead without its required fields.
    const source = new MemoryOrg([{ ...sourceLead, Title: 'Buyer' }]);
    const target = new MemoryOrg([]);
    const { write, calls } = recordingWrite();

    const { results } = await applier(source, target, write).apply([event()]);

    expect(results).toEqual([{ outcome: 'applied' }]);
    expect(source.queries.map((q) => q.soql)).toContain(
      "SELECT FIELDS(ALL) FROM Lead WHERE Id IN ('00QSOURCE0000001AA') LIMIT 200",
    );
    expect(calls[0].records).toEqual([
      { LastName: 'Doe', Company: 'Acme', Title: 'Buyer', Ext__c: 'K1' },
    ]);
  });

  it('does not send a field the target lets nobody update onto a record it already has', async () => {
    const source = new MemoryOrg([sourceLead]);
    const target = new MemoryOrg([targetTwin]);
    const { write, calls } = recordingWrite();

    await applier(source, target, write).apply([
      event({
        changeType: 'UNDELETE',
        values: { Ext__c: 'K1', LastName: 'Doe', IsConverted: false },
      }),
    ]);

    expect(calls[0].records).toEqual([{ LastName: 'Doe', Ext__c: 'K1' }]);
  });

  it('updates by Id when the orgs share record ids', async () => {
    const source = new MemoryOrg([]);
    const target = new MemoryOrg([
      { Id: '00QSOURCE0000001AA', Title: 'Old', LastModifiedDate: BEFORE },
    ]);
    const { write, calls } = recordingWrite();

    const { results } = await applier(source, target, write, {
      plan: { keyField: 'Id', keySource: 'Id' },
    }).apply([event()]);

    expect(results).toEqual([{ outcome: 'applied' }]);
    expect(calls[0].config.operation).toBe('update');
    expect(calls[0].records).toEqual([{ Title: 'Buyer', Id: '00QSOURCE0000001AA' }]);
  });

  it('says why a record made since the copy cannot be matched by Id', async () => {
    const { write } = recordingWrite();

    const { results } = await applier(new MemoryOrg([]), new MemoryOrg([]), write, {
      plan: { keyField: 'Id', keySource: 'Id' },
    }).apply([event({ changeType: 'CREATE', values: { LastName: 'Doe' } })]);

    expect(results[0].outcome).toBe('failed');
    expect(results[0].error).toContain('No record in the target has this Id');
    expect(write).not.toHaveBeenCalled();
  });

  it('writes through the mapping of a saved configuration, key included', async () => {
    const source = new MemoryOrg([{ ...sourceLead, Website: 'W-9' }]);
    const target = new MemoryOrg([
      { Id: '00QTARGET0000009AA', Ext__c: 'W-9', LastModifiedDate: BEFORE },
    ]);
    const { write, calls } = recordingWrite();

    const { results } = await applier(source, target, write, {
      plan: {
        keyField: 'Ext__c',
        keySource: 'Website',
        fieldMappings: [
          { sourceField: 'Website', targetField: 'Ext__c', type: 'rename' },
          { sourceField: 'Title', targetField: 'Company', type: 'rename' },
        ],
      },
    }).apply([event()]);

    expect(results).toEqual([{ outcome: 'applied' }]);
    expect(target.queries[0].soql).toContain("WHERE Ext__c IN ('W-9')");
    expect(calls[0].records).toEqual([{ Company: 'Buyer', Ext__c: 'W-9' }]);
  });

  it('reports the refusal the target gave, record by record', async () => {
    const source = new MemoryOrg([sourceLead]);
    const target = new MemoryOrg([targetTwin]);
    const { write } = recordingWrite(() => 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Title is locked');

    const { results } = await applier(source, target, write).apply([event()]);

    expect(results).toEqual([
      { outcome: 'failed', error: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Title is locked' },
    ]);
  });

  it('refuses to guess between two target records carrying the same key', async () => {
    const source = new MemoryOrg([sourceLead]);
    const target = new MemoryOrg([targetTwin, { ...targetTwin, Id: '00QTARGET0000002AA' }]);
    const { write } = recordingWrite();

    const { results } = await applier(source, target, write).apply([event()]);

    expect(results[0]).toEqual({
      outcome: 'failed',
      error: '2 records of Lead in the target have Ext__c = K1.',
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('reports an overflow notice instead of a change as not applied', async () => {
    const { write } = recordingWrite();

    const { results } = await applier(new MemoryOrg([]), new MemoryOrg([]), write).apply([
      event({ changeType: 'GAP_OVERFLOW', values: {} }),
    ]);

    expect(results[0].outcome).toBe('failed');
    expect(results[0].error).toContain('overflow');
  });

  it('writes a record changed twice in one flush once, with its latest values', async () => {
    const source = new MemoryOrg([sourceLead]);
    const target = new MemoryOrg([targetTwin]);
    const { write, calls } = recordingWrite();

    const { results } = await applier(source, target, write).apply([
      event({ replayId: 10, values: { Title: 'First' } }),
      event({ replayId: 11, values: { Title: 'Second', Company: 'Acme 2' } }),
    ]);

    expect(results).toEqual([{ outcome: 'applied' }, { outcome: 'applied' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].records).toEqual([{ Title: 'Second', Company: 'Acme 2', Ext__c: 'K1' }]);
  });
});

describe('RealtimeApplier — a target edited after the change', () => {
  const editedTwin = { ...targetTwin, LastModifiedDate: AFTER };

  it.each([
    ['source_wins', 'applied', true],
    ['target_wins', 'kept-target', false],
    ['newest_wins', 'kept-target', false],
  ] as const)('with %s the change is %s', async (strategy, outcome, written) => {
    const { write } = recordingWrite();

    const { results, held } = await applier(
      new MemoryOrg([sourceLead]),
      new MemoryOrg([editedTwin]),
      write,
      {
        strategy,
      },
    ).apply([event()]);

    expect(results).toEqual([{ outcome }]);
    expect(held).toEqual([]);
    expect(write).toHaveBeenCalledTimes(written ? 1 : 0);
  });

  it('with merge only what the source did not clear is written', async () => {
    const { write, calls } = recordingWrite();

    await applier(new MemoryOrg([sourceLead]), new MemoryOrg([editedTwin]), write, {
      strategy: 'merge',
    }).apply([event({ values: { Title: null, Company: 'Acme 2' } })]);

    expect(calls[0].records).toEqual([{ Company: 'Acme 2', Ext__c: 'K1' }]);
  });

  it('with manual the change is held, with both sides, and nothing is written', async () => {
    const { write } = recordingWrite();

    const { results, held } = await applier(
      new MemoryOrg([sourceLead]),
      new MemoryOrg([editedTwin]),
      write,
      {
        strategy: 'manual',
      },
    ).apply([event({ replayId: 77 })]);

    expect(results).toEqual([{ outcome: 'held' }]);
    expect(write).not.toHaveBeenCalled();
    expect(held).toEqual([
      {
        conflictId: 'Lead:00QSOURCE0000001AA:77',
        objectApiName: 'Lead',
        recordId: '00QSOURCE0000001AA',
        replayId: 77,
        changeType: 'UPDATE',
        kind: 'upsert',
        record: { Title: 'Buyer', Ext__c: 'K1' },
        targetId: '00QTARGET0000001AA',
        targetValues: { Title: 'Old' },
        targetLastModified: '2026-09-23T11:00:00.000Z',
      },
    ]);
  });

  it('finds the target record whose key differs only in case, as the org does', async () => {
    // The org compares a text external id without regard to case: the upsert
    // would land on this record, so the collision check has to see it too.
    const { write } = recordingWrite();

    const { results } = await applier(
      new MemoryOrg([sourceLead]),
      new MemoryOrg([{ ...editedTwin, Ext__c: 'k1' }], [], { caseInsensitive: true }),
      write,
      { strategy: 'target_wins' },
    ).apply([event()]);

    expect(results).toEqual([{ outcome: 'kept-target' }]);
    expect(write).not.toHaveBeenCalled();
  });

  it('does not take the session’s own earlier write for a collision', async () => {
    const ledger = new OwnWriteLedger();
    ledger.record('00QTARGET0000001AA', Date.parse('2026-09-23T11:00:00.000Z'));
    const { write } = recordingWrite();

    const { results } = await applier(
      new MemoryOrg([sourceLead]),
      new MemoryOrg([editedTwin]),
      write,
      {
        strategy: 'manual',
        ledger,
      },
    ).apply([event()]);

    expect(results).toEqual([{ outcome: 'applied' }]);
  });

  it('remembers the edit its own write left, so the next change to the record is no collision', async () => {
    const ledger = new OwnWriteLedger();
    const target = new MemoryOrg([{ ...targetTwin, LastModifiedDate: AFTER }]);
    const { write } = recordingWrite(undefined, () => '00QTARGET0000001AA');
    const subject = applier(new MemoryOrg([sourceLead]), target, write, {
      strategy: 'source_wins',
      ledger,
    });

    await subject.apply([event()]);

    expect(ledger.wrote('00QTARGET0000001AA', Date.parse('2026-09-23T11:00:00.000Z'))).toBe(true);
  });
});

describe('RealtimeApplier — deletions', () => {
  const deletedSource = { ...sourceLead, IsDeleted: true };

  it('deletes the twin of a record deleted in the source, found through the recycle bin', async () => {
    const source = new MemoryOrg([], [deletedSource]);
    const target = new MemoryOrg([targetTwin]);
    const { write, calls } = recordingWrite();

    const { results } = await applier(source, target, write, {
      plan: { applyDeletes: true },
    }).apply([event({ changeType: 'DELETE', values: {}, changedFieldNames: [] })]);

    expect(results).toEqual([{ outcome: 'applied' }]);
    expect(source.queries[0]).toEqual({
      soql: "SELECT Id, Ext__c FROM Lead WHERE Id IN ('00QSOURCE0000001AA')",
      includeDeleted: true,
    });
    expect(calls[0].config.operation).toBe('delete');
    expect(calls[0].records).toEqual([{ Id: '00QTARGET0000001AA' }]);
  });

  it('leaves the target alone when deletes are not applied', async () => {
    const { write } = recordingWrite();

    const { results } = await applier(new MemoryOrg([]), new MemoryOrg([targetTwin]), write).apply([
      event({ changeType: 'DELETE', values: {} }),
    ]);

    expect(results).toEqual([{ outcome: 'deletes-off' }]);
    expect(write).not.toHaveBeenCalled();
  });

  it('says why when the deleted record is no longer in the recycle bin', async () => {
    const { write } = recordingWrite();

    const { results } = await applier(new MemoryOrg([]), new MemoryOrg([targetTwin]), write, {
      plan: { applyDeletes: true },
    }).apply([event({ changeType: 'DELETE', values: {} })]);

    expect(results[0].outcome).toBe('failed');
    expect(results[0].error).toContain('recycle bin');
  });

  it('holds a deletion of a record the target edited since, when asked to', async () => {
    const { write } = recordingWrite();

    const { results, held } = await applier(
      new MemoryOrg([], [deletedSource]),
      new MemoryOrg([{ ...targetTwin, LastModifiedDate: AFTER }]),
      write,
      { plan: { applyDeletes: true }, strategy: 'manual' },
    ).apply([event({ changeType: 'DELETE', values: {} })]);

    expect(results).toEqual([{ outcome: 'held' }]);
    expect(held[0]).toMatchObject({ kind: 'delete', targetId: '00QTARGET0000001AA' });
    expect(write).not.toHaveBeenCalled();
  });

  it('does not let a creation overtake a deletion made before it in the same flush', async () => {
    const source = new MemoryOrg([sourceLead], [deletedSource]);
    const target = new MemoryOrg([targetTwin]);
    const { write, calls } = recordingWrite();

    await applier(source, target, write, { plan: { applyDeletes: true } }).apply([
      event({ changeType: 'DELETE', values: {}, recordIds: ['00QSOURCE0000001AA'] }),
      event({
        changeType: 'UNDELETE',
        values: { Ext__c: 'K1', LastName: 'Doe', Company: 'Acme' },
        recordIds: ['00QSOURCE0000001AA'],
      }),
    ]);

    expect(calls.map((c) => c.config.operation)).toEqual(['delete', 'upsert']);
  });
});

describe('RealtimeApplier — deciding a held change', () => {
  async function heldChange(
    strategyTarget = new MemoryOrg([{ ...targetTwin, LastModifiedDate: AFTER }]),
  ) {
    const { write, calls } = recordingWrite();
    const subject = applier(new MemoryOrg([sourceLead]), strategyTarget, write, {
      strategy: 'manual',
    });
    const { held } = await subject.apply([
      event({ values: { Title: 'Buyer', NumberOfEmployees: 5 } }),
    ]);
    return { subject, change: held[0], write, calls };
  }

  it('writes the change as it came when the source wins', async () => {
    const { subject, change, calls } = await heldChange();

    const resolution = await subject.resolve(change, 'source_wins');

    expect(resolution).toEqual({
      success: true,
      resolvedValues: { Title: 'Buyer', NumberOfEmployees: 5, Ext__c: 'K1' },
    });
    expect(calls[0].records).toEqual([{ Title: 'Buyer', NumberOfEmployees: 5, Ext__c: 'K1' }]);
  });

  it('writes the values picked field by field, typed as the target field holds them', async () => {
    const { subject, change, calls } = await heldChange();

    const resolution = await subject.resolve(change, 'manual', {
      NumberOfEmployees: { value: '12', source: 'manual' },
    });

    expect(resolution.success).toBe(true);
    expect(calls[0].records).toEqual([{ NumberOfEmployees: 12, Ext__c: 'K1' }]);
  });

  it('writes nothing when the target wins', async () => {
    const { subject, change, write } = await heldChange();

    const resolution = await subject.resolve(change, 'target_wins');

    expect(resolution).toEqual({ success: true, resolvedValues: {} });
    expect(write).not.toHaveBeenCalled();
  });

  it('says so when the target refuses the decided change', async () => {
    const target = new MemoryOrg([{ ...targetTwin, LastModifiedDate: AFTER }]);
    const write = vi.fn(async () => ({
      outcomes: [{ success: false, errors: ['ENTITY_IS_LOCKED: locked'] }],
      notes: [],
    }));
    const subject = new RealtimeApplier(plan(), {
      source: new MemoryOrg([sourceLead]),
      target,
      write,
      conflictStrategy: 'manual',
      ownWrites: new OwnWriteLedger(),
    });
    const { held } = await subject.apply([event()]);

    const resolution = await subject.resolve(held[0], 'source_wins');

    expect(resolution).toEqual({
      success: false,
      resolvedValues: {},
      error: 'ENTITY_IS_LOCKED: locked',
    });
  });
});

describe('parseSalesforceDate', () => {
  it('reads the offset REST writes without a colon', () => {
    expect(parseSalesforceDate('2026-09-23T11:00:00.000+0000')).toBe(
      Date.parse('2026-09-23T11:00:00.000Z'),
    );
    expect(parseSalesforceDate('2026-09-23T11:00:00.000Z')).toBe(
      Date.parse('2026-09-23T11:00:00.000Z'),
    );
    expect(parseSalesforceDate('soon')).toBeNull();
    expect(parseSalesforceDate(undefined)).toBeNull();
  });
});
