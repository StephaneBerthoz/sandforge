import { describe, it, expect, vi } from 'vitest';
import type { SyncConfig, SyncObjectConfig, SyncWriteCheck } from '@sandforge/shared';
import { SyncOrchestrator, type SyncOrchestratorDeps } from './SyncOrchestrator.js';
import { DataSync, type OperationOutcome } from './DataSync.js';
import { targetWriteFieldsOf, type TargetWriteFields } from './targetWriteFields.js';
import { FieldMappingService } from './FieldMapping.js';
import { TransformPipeline } from './TransformPipeline.js';
import { ConflictResolver } from './ConflictResolver.js';
import type { SyncCountedWrite, SyncWriteGate } from './SyncRunGate.js';
import { RECORD_TYPE_READ_BACK_IDS } from '../../core/metadata/recordTypeGiven.js';
import { writePathOrderDefects, type WritePathStep } from '../checkpoint/beforeRunCheckpoint.js';

/*
 * A record on Master in the source goes to the target without a record type,
 * and the target gives it the one it gives the user the run writes as. Run
 * between two scratch orgs, an opportunity on Master in the source went in as
 * SFX_Retail: the admin's describe of the target's Opportunity named Master
 * the default, with SFX_Retail the one other type open to them and SFX_Hidden
 * kept from them. Read from the default alone, the run would have said
 * nothing. The fake target below gives a record created without a type the
 * type the probes' rule names for its describe, and reads it back by the
 * statement the run sends.
 */

const MASTER = '012000000000000AAA';
const TARGET = {
  retail: '0120000000000R2AAA',
  hidden: '0120000000000H2AAA',
};
const SOURCE_RETAIL = '0120000000000R1AAA';

/** A record type of the target's describe of Opportunity, for the user the run writes as. */
function recordTypeInfo(
  developerName: string,
  recordTypeId: string,
  over: { available?: boolean; master?: boolean; defaultRecordTypeMapping?: boolean } = {},
) {
  return {
    active: true,
    available: over.available ?? true,
    defaultRecordTypeMapping: over.defaultRecordTypeMapping ?? false,
    developerName,
    master: over.master ?? false,
    name: developerName.replace(/_/g, ' '),
    recordTypeId,
  };
}

const OPPORTUNITY_FIELDS = [
  { name: 'Id', createable: false, type: 'id' },
  { name: 'Name', createable: true, type: 'string', nillable: false },
  { name: 'External_Key__c', createable: true, type: 'string', externalId: true },
  { name: 'RecordTypeId', createable: true, type: 'reference', nillable: true },
];

/** The target's Opportunity as the scratch org's describe gave it for its admin. */
const ONE_OPEN = targetWriteFieldsOf({
  name: 'Opportunity',
  fields: OPPORTUNITY_FIELDS,
  recordTypeInfos: [
    recordTypeInfo('SFX_Hidden', TARGET.hidden, { available: false }),
    recordTypeInfo('SFX_Retail', TARGET.retail),
    recordTypeInfo('Master', MASTER, { master: true, defaultRecordTypeMapping: true }),
  ],
});

/** The same once a permission set opened SFX_Hidden as well: two open, and Master kept. */
const TWO_OPEN = targetWriteFieldsOf({
  name: 'Opportunity',
  fields: OPPORTUNITY_FIELDS,
  recordTypeInfos: [
    recordTypeInfo('SFX_Hidden', TARGET.hidden),
    recordTypeInfo('SFX_Retail', TARGET.retail),
    recordTypeInfo('Master', MASTER, { master: true, defaultRecordTypeMapping: true }),
  ],
});

/** A target whose Opportunity has no record type but Master. */
const UNTYPED = targetWriteFieldsOf({
  name: 'Opportunity',
  fields: OPPORTUNITY_FIELDS.filter((field) => field.name !== 'RecordTypeId'),
  recordTypeInfos: [
    recordTypeInfo('Master', MASTER, { master: true, defaultRecordTypeMapping: true }),
  ],
});

const opportunity = (n: number, RecordTypeId: string | null): Record<string, unknown> => ({
  Id: `006000000000${String(n).padStart(3, '0')}AAA`,
  Name: `Opportunity ${n}`,
  External_Key__c: `key-${n}`,
  RecordTypeId,
});

function objectConfig(overrides: Partial<SyncObjectConfig> = {}): SyncObjectConfig {
  return {
    objectApiName: 'Opportunity',
    operation: 'insert',
    fieldMappings: [],
    transformRules: [],
    excludedFields: [],
    addOnFields: [],
    batchSize: 200,
    insertOrder: 0,
    ...overrides,
  };
}

function config(object: SyncObjectConfig = objectConfig()): SyncConfig {
  return {
    id: 'config-record-types-given',
    name: 'Opportunities',
    description: '',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    direction: 'source_to_target',
    mode: 'full',
    objects: [object],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

/** The record types statement the read back sends, its ids taken out. */
const READ_BACK =
  /^SELECT RecordTypeId, COUNT\(Id\) n FROM (\w+) WHERE Id IN \((.*)\) GROUP BY RecordTypeId$/;

interface TargetOptions {
  /** The describe the run begins with. */
  described?: TargetWriteFields;
  /** The describe read again, once the lease assigned a permission set. */
  describedAgain?: TargetWriteFields;
  /** What gives a record created without a type its type: the platform, or an automation. */
  givesType?: (record: Record<string, unknown>) => string;
  /** The keys the target holds already, which an upsert updates. */
  held?: readonly string[];
  /** Refuse the read back, as an org may. */
  readBackRefused?: string;
}

/**
 * The fake target: an insert or an upsert that takes a record without a type
 * and gives it the type the platform gives the user — SFX_Retail, the only
 * one open — and refuses `RecordTypeId` sent empty or as Master's id, as the
 * scratch target did; and a read of the records by the statement the run
 * sends. Each call is logged, in order.
 */
function targetOrg(options: TargetOptions = {}) {
  const calls: string[] = [];
  const records = new Map<string, Record<string, unknown>>();
  const keys = new Map<string, string>((options.held ?? []).map((key, i) => [key, `held-${i}`]));
  for (const [key, id] of keys)
    records.set(id, { External_Key__c: key, RecordTypeId: SOURCE_RETAIL });
  let next = 100;
  const givesType = options.givesType ?? (() => TARGET.retail);
  const write = (record: Record<string, unknown>): OperationOutcome => {
    if (
      'RecordTypeId' in record &&
      (record.RecordTypeId === null || record.RecordTypeId === MASTER)
    ) {
      return {
        success: false,
        errors: [
          "INVALID_CROSS_REFERENCE_KEY: Record Type ID: this ID value isn't valid for the user: " +
            '[RecordTypeId]',
        ],
      };
    }
    const id = `006xx0000000${String(next++).padStart(3, '0')}AAA`;
    records.set(id, { ...record, RecordTypeId: record.RecordTypeId ?? givesType(record) });
    return { id, success: true, errors: [] };
  };
  const insert = vi.fn(async (_object: string, rows: Record<string, unknown>[]) => {
    calls.push('insert');
    return rows.map(write);
  });
  const upsert = vi.fn(async (_object: string, _key: string, rows: Record<string, unknown>[]) => {
    calls.push('upsert');
    return rows.map((row): OperationOutcome => {
      const existing = keys.get(String(row.External_Key__c));
      if (existing) return { id: existing, success: true, errors: [], created: false };
      return { ...write(row), created: true };
    });
  });
  const describeTargetFields = vi.fn(async () => options.described ?? ONE_OPEN);
  const describeTargetFieldsAgain = vi.fn(async (name: string) => {
    calls.push(`describe again ${name}`);
    return options.describedAgain ?? options.described ?? ONE_OPEN;
  });
  const queryTargetRows = vi.fn(async (soql: string) => {
    const asked = READ_BACK.exec(soql);
    if (!asked) throw new Error(`unexpected statement: ${soql}`);
    calls.push(`read back ${asked[1]}`);
    if (options.readBackRefused) throw new Error(options.readBackRefused);
    const ids = [...asked[2].matchAll(/'([^']+)'/g)].map(([, id]) => id);
    const counts = new Map<string | null, number>();
    for (const id of ids) {
      const type = (records.get(id)?.RecordTypeId as string | undefined) ?? null;
      const bucket = type === MASTER ? null : type;
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }
    return [...counts].map(([RecordTypeId, n]) => ({
      attributes: { type: 'AggregateResult' },
      RecordTypeId,
      n,
    }));
  });
  return {
    calls,
    records,
    insert,
    upsert,
    describeTargetFields,
    describeTargetFieldsAgain,
    queryTargetRows,
  };
}

type Target = ReturnType<typeof targetOrg>;

function orchestrator(
  target: Target,
  rows: Record<string, unknown>[],
  extra: Partial<SyncOrchestratorDeps> = {},
): SyncOrchestrator {
  const unused = async (): Promise<OperationOutcome[]> => [];
  return new SyncOrchestrator({
    dataSync: new DataSync({
      insert: (object, records) => target.insert(object, records),
      update: unused,
      upsert: (object, key, records) => target.upsert(object, key, records),
      delete: unused,
      describeTargetFields: target.describeTargetFields,
    }),
    conflictResolver: new ConflictResolver(),
    fieldMapping: new FieldMappingService(),
    transformPipeline: new TransformPipeline(),
    querySource: async () => {
      target.calls.push('read source');
      return rows.map((row) => ({ ...row }));
    },
    queryTarget: async () => [],
    // The keys an upsert matches, as the target holds them.
    findInTarget: async (_org, _object, keyField, keys) => {
      const held = new Map<string, number>();
      for (const key of keys) {
        if ([...target.records.values()].some((record) => record[keyField] === key)) {
          held.set(String(key).toLowerCase(), 1);
        }
      }
      return held;
    },
    describeTargetFields: target.describeTargetFields,
    describeTargetFieldsAgain: target.describeTargetFieldsAgain,
    queryTargetRows: target.queryTargetRows,
    ...extra,
  });
}

/** The one object's line of the record types given, run or simulated. */
const givenOf = (result: { objects?: unknown[]; objectResults?: unknown[] }) =>
  ((result.objects ?? result.objectResults ?? [])[0] as { recordTypeGiven?: unknown })
    .recordTypeGiven;

describe('SyncOrchestrator — the record type the target gave a record sent without one', () => {
  it('predicts in a simulation the only type open to the user, though the describe names Master its default', async () => {
    const simulated = await orchestrator(targetOrg(), [opportunity(1, null)]).simulate(config());

    expect(simulated.error).toBeUndefined();
    expect(givenOf(simulated)).toEqual({
      objectApiName: 'Opportunity',
      rows: 1,
      why: { masterInSource: 1 },
      predicted: { developerName: 'SFX_Retail', label: 'SFX Retail', basis: 'onlyOneOpen' },
    });
  });

  it('reads back after a run what the target gave the record, and says it with what was predicted', async () => {
    const target = targetOrg();

    const result = await orchestrator(target, [opportunity(1, null)]).execute(config());

    expect(result.status).toBe('success');
    expect(givenOf(result)).toEqual({
      objectApiName: 'Opportunity',
      rows: 1,
      why: { masterInSource: 1 },
      predicted: { developerName: 'SFX_Retail', label: 'SFX Retail', basis: 'onlyOneOpen' },
      readBack: { read: 1, types: [{ developerName: 'SFX_Retail', label: 'SFX Retail', rows: 1 }] },
    });
    expect(target.queryTargetRows).toHaveBeenCalledTimes(1);
  });

  it('says what the target holds, not what it predicted, when an automation of the target sets another type', async () => {
    // A before-save flow of the target sets SFX_Hidden on every record.
    const target = targetOrg({ givesType: () => TARGET.hidden });

    const result = await orchestrator(target, [opportunity(1, null), opportunity(2, null)]).execute(
      config(),
    );

    expect(givenOf(result)).toMatchObject({
      predicted: { developerName: 'SFX_Retail' },
      readBack: { read: 2, types: [{ developerName: 'SFX_Hidden', rows: 2 }] },
    });
  });

  it('names Master read back when the target kept the records on it', async () => {
    const target = targetOrg({ givesType: () => MASTER });

    const result = await orchestrator(target, [opportunity(1, null)]).execute(config());

    expect(givenOf(result)).toMatchObject({
      readBack: { read: 1, types: [{ developerName: 'Master', rows: 1 }] },
    });
  });

  it('says nothing of records that go with their own type, of an object with no type but Master, or of an update', async () => {
    const typed = await orchestrator(targetOrg(), [opportunity(1, TARGET.retail)]).execute(
      config(),
    );
    const untyped = await orchestrator(targetOrg({ described: UNTYPED }), [
      opportunity(1, null),
    ]).execute(config());
    const updatedTarget = targetOrg({ held: ['key-1'] });
    const updated = await orchestrator(updatedTarget, [opportunity(1, null)]).execute(
      config(objectConfig({ operation: 'upsert', externalIdField: 'External_Key__c' })),
    );
    const simulatedUpdate = await orchestrator(targetOrg({ held: ['key-1'] }), [
      opportunity(1, null),
    ]).simulate(config(objectConfig({ operation: 'upsert', externalIdField: 'External_Key__c' })));

    expect(typed.objectResults[0]).toMatchObject({ success: 1 });
    expect(givenOf(typed)).toBeUndefined();
    expect(untyped.objectResults[0]).toMatchObject({ success: 1 });
    expect(givenOf(untyped)).toBeUndefined();
    // The upsert updated the record the target held: it keeps its own type.
    expect(updated.objectResults[0]).toMatchObject({ success: 1 });
    expect(givenOf(updated)).toBeUndefined();
    expect(updatedTarget.queryTargetRows).not.toHaveBeenCalled();
    expect(simulatedUpdate.objects[0]).toMatchObject({ update: 1, insert: 0 });
    expect(givenOf(simulatedUpdate)).toBeUndefined();
  });

  it('counts the records an upsert created without a type, and leaves out those it updated', async () => {
    const target = targetOrg({ held: ['key-1'] });

    const result = await orchestrator(target, [opportunity(1, null), opportunity(2, null)]).execute(
      config(objectConfig({ operation: 'upsert', externalIdField: 'External_Key__c' })),
    );

    expect(givenOf(result)).toMatchObject({
      rows: 1,
      why: { masterInSource: 1 },
      readBack: { read: 1 },
    });
  });

  it('says why when the run writes no RecordTypeId for the object at all', async () => {
    // The source's Opportunity has no record type: its rows carry none.
    const rows = [opportunity(1, null)].map(({ RecordTypeId: _, ...row }) => row);

    const simulated = await orchestrator(targetOrg(), rows).simulate(config());

    expect(givenOf(simulated)).toMatchObject({ rows: 1, why: { notRead: 1 } });
  });

  it('reads back the first 200 of the records created, in one request', async () => {
    const target = targetOrg();
    const rows = Array.from({ length: 250 }, (_, i) => opportunity(i + 1, null));

    const result = await orchestrator(target, rows).execute(config());

    expect(target.queryTargetRows).toHaveBeenCalledTimes(1);
    const soql = String(target.queryTargetRows.mock.calls[0]?.[0]);
    expect([...soql.matchAll(/'([^']+)'/g)]).toHaveLength(RECORD_TYPE_READ_BACK_IDS);
    expect(givenOf(result)).toMatchObject({
      rows: 250,
      why: { masterInSource: 250 },
      readBack: { read: 200, types: [{ developerName: 'SFX_Retail', rows: 200 }] },
    });
  });

  it('says the org’s words when the read back is refused, and the run stays a success', async () => {
    const target = targetOrg({ readBackRefused: 'INVALID_TYPE: sObject type not supported' });

    const result = await orchestrator(target, [opportunity(1, null)]).execute(config());

    expect(result.status).toBe('success');
    expect(givenOf(result)).toMatchObject({
      predicted: { developerName: 'SFX_Retail' },
      readBack: { read: 0, types: [], unread: 'INVALID_TYPE: sObject type not supported' },
    });
  });

  it('says what the describe gives, and reads nothing back, without a way to read the target', async () => {
    const target = targetOrg();

    const result = await orchestrator(target, [opportunity(1, null)], {
      queryTargetRows: undefined,
    }).execute(config());

    expect(givenOf(result)).toEqual({
      objectApiName: 'Opportunity',
      rows: 1,
      why: { masterInSource: 1 },
      predicted: { developerName: 'SFX_Retail', label: 'SFX Retail', basis: 'onlyOneOpen' },
    });
  });

  describe('at the write gate, and under the mute’s lease', () => {
    /** A gate that lets the run write and, as a muting gate does, takes the lease once it has. */
    function gate(calls: string[]) {
      const seen: Array<SyncCountedWrite & { readBack?: number }> = [];
      const check: SyncWriteCheck = {
        objects: [],
        total: 0,
        alreadyCopied: 0,
        storage: { verdict: 'fits', estimateMB: 0 },
        emails: [],
        verdict: 'writes',
      };
      const writeGate: SyncWriteGate = {
        measure: async (counted) => {
          seen.push(counted);
          return check;
        },
        hold: async (counted) => {
          calls.push('gate');
          seen.push(counted);
          calls.push('lease taken');
          return { check, answer: { go: true, asked: false } };
        },
      };
      return { seen, writeGate };
    }

    function lease(calls: string[], assigned: number) {
      const giveBack = vi.fn(async () => {
        calls.push('lease given back');
      });
      return { giveBack, leaseOfTheGate: () => ({ assigned, giveBack }) };
    }

    const counting = {
      countSource: async () => 1,
    } satisfies Partial<SyncOrchestratorDeps>;

    it('tells the gate one request to read back each object it creates records of in a typed target, and sends that many', async () => {
      const target = targetOrg();
      const { seen, writeGate } = gate(target.calls);

      await orchestrator(target, [opportunity(1, null)], { ...counting, writeGate }).execute(
        config(),
      );

      expect(seen[0]?.readBack).toBe(1);
      expect(target.queryTargetRows).toHaveBeenCalledTimes(seen[0]?.readBack ?? 0);
    });

    it('tells the gate of no read back of an object with no type but Master, or one it only updates', async () => {
      const untyped = targetOrg({ described: UNTYPED });
      const updating = targetOrg();
      const untypedGate = gate(untyped.calls);
      const updatingGate = gate(updating.calls);

      await orchestrator(untyped, [opportunity(1, null)], {
        ...counting,
        writeGate: untypedGate.writeGate,
      }).execute(config());
      await orchestrator(updating, [{ ...opportunity(1, null), Id: '006000000000001AAA' }], {
        ...counting,
        writeGate: updatingGate.writeGate,
      }).execute(config(objectConfig({ operation: 'update' })));

      expect(untypedGate.seen[0]).not.toHaveProperty('readBack');
      expect(updatingGate.seen[0]).not.toHaveProperty('readBack');
    });

    it('measures a simulation with the read back a run would send', async () => {
      const target = targetOrg();
      const { seen, writeGate } = gate(target.calls);

      await orchestrator(target, [opportunity(1, null)], { ...counting, writeGate }).simulate(
        config(),
      );

      expect(seen[0]?.readBack).toBe(1);
    });

    it('reads the describe of the object again once the lease assigned a permission set, and predicts from it', async () => {
      // The set assigned opened SFX_Hidden too: two open, and the platform
      // keeps a record sent without one on Master.
      const target = targetOrg({ describedAgain: TWO_OPEN, givesType: () => MASTER });
      const { writeGate } = gate(target.calls);

      const result = await orchestrator(target, [opportunity(1, null)], {
        ...counting,
        writeGate,
        ...lease(target.calls, 1),
      }).execute(config());

      expect(target.calls.filter((call) => call.startsWith('describe again'))).toEqual([
        'describe again Opportunity',
      ]);
      expect(givenOf(result)).not.toHaveProperty('predicted');
      expect(givenOf(result)).toMatchObject({
        readBack: { types: [{ developerName: 'Master', rows: 1 }] },
      });
    });

    it('tells the gate the describes it reads again under a lease that assigns, and reads no more', async () => {
      const target = targetOrg({ describedAgain: TWO_OPEN, givesType: () => MASTER });
      const { seen, writeGate } = gate(target.calls);

      await orchestrator(target, [opportunity(1, null)], {
        ...counting,
        writeGate,
        ...lease(target.calls, 1),
      }).execute(config());

      expect(seen[0]?.describedAgain).toBe(1);
      expect(target.describeTargetFieldsAgain).toHaveBeenCalledTimes(seen[0]?.describedAgain ?? 0);
      // A target with no type but Master is read again for nothing.
      const untyped = targetOrg({ described: UNTYPED });
      const untypedGate = gate(untyped.calls);
      await orchestrator(untyped, [opportunity(1, null)], {
        ...counting,
        writeGate: untypedGate.writeGate,
        ...lease(untyped.calls, 1),
      }).execute(config());
      expect(untypedGate.seen[0]).not.toHaveProperty('describedAgain');
    });

    it('reads no describe again when the lease assigned none', async () => {
      const target = targetOrg({ describedAgain: TWO_OPEN });
      const { writeGate } = gate(target.calls);

      const result = await orchestrator(target, [opportunity(1, null)], {
        ...counting,
        writeGate,
        ...lease(target.calls, 0),
      }).execute(config());

      expect(target.describeTargetFieldsAgain).not.toHaveBeenCalled();
      expect(givenOf(result)).toMatchObject({
        predicted: { developerName: 'SFX_Retail', basis: 'onlyOneOpen' },
      });
    });

    it('keeps the write path in its order: the gate and its lease, the describe read again, the writes, the lease given back, the read back, the result', async () => {
      const target = targetOrg();
      const { writeGate } = gate(target.calls);
      const { giveBack, leaseOfTheGate } = lease(target.calls, 1);

      const result = await orchestrator(target, [opportunity(1, null)], {
        ...counting,
        writeGate,
        leaseOfTheGate,
      }).execute(config());
      target.calls.push('result');

      const steps = target.calls.flatMap((call): WritePathStep[] => {
        if (call === 'read source') return ['reads'];
        if (call === 'gate') return ['question'];
        if (call === 'lease taken') return ['leaseAcquire'];
        if (call.startsWith('describe again')) return ['afterLeaseCheck'];
        if (call === 'insert' || call === 'upsert') return ['write'];
        if (call === 'lease given back') return ['leaseRelease'];
        if (call.startsWith('read back')) return ['recordTypeReadBack'];
        return call === 'result' ? ['result'] : [];
      });
      expect(writePathOrderDefects(steps)).toEqual([]);
      // Counted: one gate, one lease taken and given back once, one write,
      // one describe again, one read back.
      expect(steps.filter((step) => step === 'question')).toHaveLength(1);
      expect(steps.filter((step) => step === 'leaseAcquire')).toHaveLength(1);
      expect(giveBack).toHaveBeenCalledTimes(1);
      expect(steps.filter((step) => step === 'write')).toHaveLength(1);
      expect(steps.filter((step) => step === 'afterLeaseCheck')).toHaveLength(1);
      expect(steps.filter((step) => step === 'recordTypeReadBack')).toHaveLength(1);
      expect(givenOf(result)).toHaveProperty('readBack.read', 1);
    });

    it('gives the lease back and reads back what was written when a cancel stops the run', async () => {
      const target = targetOrg();
      const { writeGate } = gate(target.calls);
      const { giveBack, leaseOfTheGate } = lease(target.calls, 0);
      const controller = new AbortController();
      const second = objectConfig({ objectApiName: 'Contact', insertOrder: 1 });
      const twoObjects = { ...config(), objects: [objectConfig(), second] };
      // Cancelled once the opportunities are written, before the contacts.
      target.insert.mockImplementationOnce(async (_object, rows) => {
        target.calls.push('insert');
        const written = rows.map((row, i): OperationOutcome => {
          const id = `006xx0000000${String(900 + i)}AAA`;
          target.records.set(id, { ...row, RecordTypeId: TARGET.retail });
          return { id, success: true, errors: [] };
        });
        controller.abort();
        return written;
      });

      const result = await orchestrator(target, [opportunity(1, null)], {
        ...counting,
        writeGate,
        leaseOfTheGate,
        signal: controller.signal,
        describeTargetFields: async (name) => (name === 'Contact' ? UNTYPED : ONE_OPEN),
      }).execute(twoObjects);

      expect(result.cancelled).toBe(true);
      expect(giveBack).toHaveBeenCalledTimes(1);
      expect(target.calls.indexOf('lease given back')).toBeLessThan(
        target.calls.indexOf('read back Opportunity'),
      );
      expect(givenOf(result)).toMatchObject({ readBack: { read: 1 } });
    });
  });
});
