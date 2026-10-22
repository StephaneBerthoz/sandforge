/**
 * What a Sync run does before its first write, through the real
 * orchestrator, DataSync and pairs on disk, against a target that inserts and
 * refuses a lookup at a record it does not hold: it writes the parents its
 * objects' lookups name first, leaves as they are the records an earlier run
 * of a saved configuration copied, and is held to its write gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SyncConfig, SyncObjectConfig, SyncWriteCheck } from '@sandforge/shared';
import { SYNC_EARLIER_UNREAD, SyncOrchestrator } from './SyncOrchestrator.js';
import { SyncRunRefused } from './SyncRunFailure.js';
import { DataSync, type OperationOutcome } from './DataSync.js';
import { FieldMappingService } from './FieldMapping.js';
import { TransformPipeline } from './TransformPipeline.js';
import { ConflictResolver } from './ConflictResolver.js';
import { targetWriteFieldsOf, type TargetWriteFields } from './targetWriteFields.js';
import { nodeSyncIdMap, savedConfigIdMap, type SyncIdMapStore } from './SyncIdMap.js';
import { simulationKey } from './SyncSimulation.js';
import type { SyncCountedWrite, SyncGateAnswer, SyncWriteGate } from './SyncRunGate.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

/** The source: two accounts, a contact under each. */
function sourceOrg(): Record<string, Array<Record<string, unknown>>> {
  return {
    Account: [
      { Id: fakeId('001', 1), Name: 'Acme' },
      { Id: fakeId('001', 2), Name: 'Globex' },
    ],
    Contact: [
      { Id: fakeId('003', 1), LastName: 'Roe', AccountId: fakeId('001', 1) },
      { Id: fakeId('003', 2), LastName: 'Doe', AccountId: fakeId('001', 2) },
    ],
  };
}

const DESCRIBES: Record<string, TargetWriteFields> = {
  Account: targetWriteFieldsOf({
    name: 'Account',
    fields: [{ name: 'Name', createable: true, type: 'string' }],
  }),
  Contact: targetWriteFieldsOf({
    name: 'Contact',
    fields: [
      { name: 'LastName', createable: true, type: 'string' },
      { name: 'AccountId', createable: true, type: 'reference', referenceTo: ['Account'] },
    ],
  }),
};

/** The target: what it holds, an insert that refuses a lookup at a record it does not hold. */
function targetOrg() {
  const held = new Map<string, Record<string, unknown>>();
  let next = 900;
  const insert = vi.fn(
    async (object: string, records: Record<string, unknown>[]): Promise<OperationOutcome[]> =>
      records.map((record) => {
        const lookup = record.AccountId;
        if (typeof lookup === 'string' && !held.has(lookup)) {
          return {
            success: false,
            errors: ['INVALID_CROSS_REFERENCE_KEY: invalid cross reference id'],
          };
        }
        const id = fakeId(object === 'Account' ? '001' : '003', next++);
        held.set(id, { ...record, object });
        return { id, success: true, errors: [] };
      }),
  );
  /** How many records the target holds of each key, as a simulation's lookup answers. */
  const find = async (
    _org: string,
    _objectConfig: SyncObjectConfig,
    keyField: string,
    keys: readonly (string | number | boolean)[],
  ): Promise<ReadonlyMap<string, number>> => {
    const found = new Map<string, number>();
    for (const [id, record] of held) {
      const value = keyField === 'Id' ? id : record[keyField];
      const key = simulationKey(value);
      if (key !== null && keys.some((k) => simulationKey(k) === key)) found.set(key, 1);
    }
    return found;
  };
  return { held, insert, find };
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

/** A configuration of the contacts added before their accounts, as a list sorted by name may hold them. */
function config(overrides: Partial<SyncConfig> = {}): SyncConfig {
  return {
    id: 'cfg-safety',
    name: 'Contacts and accounts',
    description: '',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    direction: 'source_to_target',
    mode: 'full',
    objects: [insertOf('Contact', 0), insertOf('Account', 1)],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

/** A gate that answers as told, and keeps what it was handed. */
function gate(answer: SyncGateAnswer = { go: true, asked: false }) {
  const held: SyncCountedWrite[] = [];
  const measured: SyncCountedWrite[] = [];
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
      measured.push(counted);
      return { ...check, total: counted.objects.reduce((s, o) => s + o.rows, 0) };
    },
    hold: async (counted) => {
      held.push(counted);
      return { check, answer };
    },
  };
  return { writeGate, held, measured };
}

describe('SyncOrchestrator — before the first write', () => {
  let dir: string;
  let idMap: SyncIdMapStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sandforge-sync-safety-'));
    idMap = savedConfigIdMap(nodeSyncIdMap(dir), () => true);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

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
        update: unused,
        upsert: unused,
        delete: unused,
        describeTargetFields,
      }),
      conflictResolver: new ConflictResolver(),
      fieldMapping: new FieldMappingService(),
      transformPipeline: new TransformPipeline(),
      querySource: async (_org, objectConfig) => source[objectConfig.objectApiName],
      queryTarget: async () => [],
      findInTarget: target.find,
      describeTargetFields,
      readSourceIds: async (objectConfig) =>
        source[objectConfig.objectApiName].map((row) => String(row.Id)),
      countSource: async (_org, objectConfig) => source[objectConfig.objectApiName].length,
      idMap,
      ...extra,
    });
  }

  it('writes the account a contact names first, so a contact added before it keeps its AccountId', async () => {
    const target = targetOrg();

    const result = await orchestrator(target, sourceOrg()).execute(config());

    expect(result.objectResults.map((o) => o.objectApiName)).toEqual(['Account', 'Contact']);
    expect(result.objectResults.map((o) => [o.success, o.failed])).toEqual([
      [2, 0],
      [2, 0],
    ]);
    const contacts = [...target.held.values()].filter((r) => r.object === 'Contact');
    expect(contacts.map((c) => [c.LastName, target.held.get(c.AccountId as string)?.Name])).toEqual(
      [
        ['Roe', 'Acme'],
        ['Doe', 'Globex'],
      ],
    );
    // Written whole: nothing said of a lookup written without its record.
    expect(result.objectResults[1].errors).toEqual([]);
  });

  it('simulates the objects in the order the run writes them, and says what moved', async () => {
    const target = targetOrg();

    const simulation = await orchestrator(target, sourceOrg()).simulate(config());

    expect(simulation.objects.map((o) => o.objectApiName)).toEqual(['Account', 'Contact']);
    expect(simulation.writeOrder).toEqual({
      objects: ['Account', 'Contact'],
      moved: [{ objectApiName: 'Contact', after: 'Account', field: 'AccountId' }],
      cycles: [],
    });
    expect(target.insert).not.toHaveBeenCalled();
  });

  it('inserts, on the second run of a saved configuration, only what the first did not copy', async () => {
    const target = targetOrg();
    const source = sourceOrg();
    await orchestrator(target, source).execute(config());
    expect(target.held.size).toBe(4);
    // A third account in the source since.
    source.Account.push({ Id: fakeId('001', 3), Name: 'Initech' });

    const second = await orchestrator(target, source).execute(config());

    const accounts = second.objectResults.find((o) => o.objectApiName === 'Account');
    const contacts = second.objectResults.find((o) => o.objectApiName === 'Contact');
    expect(accounts).toMatchObject({ processed: 1, success: 1, skipped: 2, alreadyCopied: 2 });
    expect(contacts).toMatchObject({ processed: 0, success: 0, skipped: 2, alreadyCopied: 2 });
    const names = [...target.held.values()].map((r) => r.Name ?? r.LastName).sort();
    expect(names).toEqual(['Acme', 'Doe', 'Globex', 'Initech', 'Roe']);
  });

  it('inserts again a record whose earlier copy is no longer in the target', async () => {
    const target = targetOrg();
    const source = sourceOrg();
    await orchestrator(target, source).execute(config({ objects: [insertOf('Account', 0)] }));
    const [gone] = [...target.held.keys()];
    target.held.delete(gone);

    const second = await orchestrator(target, source).execute(
      config({ objects: [insertOf('Account', 0)] }),
    );

    expect(second.objectResults[0]).toMatchObject({ success: 1, alreadyCopied: 1 });
    expect([...target.held.values()].map((r) => r.Name).sort()).toEqual(['Acme', 'Globex']);
  });

  it('says in a simulation of the second run what the run leaves as an earlier run copied it', async () => {
    const target = targetOrg();
    const source = sourceOrg();
    await orchestrator(target, source).execute(config());
    source.Account.push({ Id: fakeId('001', 3), Name: 'Initech' });

    const simulation = await orchestrator(target, source).simulate(config());

    expect(simulation.objects.find((o) => o.objectApiName === 'Account')).toMatchObject({
      read: 3,
      insert: 1,
      skipped: 2,
      alreadyCopied: 2,
    });
  });

  it('refuses an insert of a saved configuration whose earlier copies cannot be read, writing nothing', async () => {
    const target = targetOrg();
    const unreadable: SyncIdMapStore = {
      load: async () => {
        throw new Error('EACCES: permission denied');
      },
      record: async () => undefined,
    };

    const run = orchestrator(target, sourceOrg(), { idMap: unreadable }).execute(config());

    await expect(run).rejects.toBeInstanceOf(SyncRunRefused);
    await expect(run).rejects.toMatchObject({
      code: SYNC_EARLIER_UNREAD,
      message: expect.stringContaining('would be copied a second time. Nothing was written.'),
    });
    expect(target.insert).not.toHaveBeenCalled();
  });

  it('hands its gate the records counted, less those an earlier run copied, and writes once let through', async () => {
    const target = targetOrg();
    const source = sourceOrg();
    await orchestrator(target, source).execute(config());
    source.Account.push({ Id: fakeId('001', 3), Name: 'Initech' });
    const { writeGate, held } = gate();

    await orchestrator(target, source, { writeGate }).execute(config());

    expect(held).toEqual([
      {
        objects: [
          { objectApiName: 'Account', operation: 'insert', rows: 1 },
          { objectApiName: 'Contact', operation: 'insert', rows: 0 },
        ],
        alreadyCopied: 4,
      },
    ]);
    expect(target.held.size).toBe(5);
  });

  it('is refused by its gate before its first write, with the code the page words it by', async () => {
    const target = targetOrg();
    const { writeGate } = gate({
      go: false,
      code: 'SYNC_EMAILS_EXCEEDED',
      message: 'The target would send more emails than it has left today. Nothing was written.',
    });

    const run = orchestrator(target, sourceOrg(), { writeGate }).execute(config());

    await expect(run).rejects.toMatchObject({
      code: 'SYNC_EMAILS_EXCEEDED',
      result: expect.objectContaining({ status: 'failure', objectResults: [] }),
    });
    expect(target.insert).not.toHaveBeenCalled();
  });

  it('refuses a run whose records cannot be counted before its first write', async () => {
    const target = targetOrg();
    const { writeGate } = gate();

    const run = orchestrator(target, sourceOrg(), {
      writeGate,
      countSource: async () => {
        throw new Error('INVALID_FIELD: no such column');
      },
    }).execute(config());

    await expect(run).rejects.toThrow(
      'The records to write could not be counted (INVALID_FIELD: no such column), so nothing was written.',
    );
    expect(target.insert).not.toHaveBeenCalled();
  });

  /** The target's describes, as a user without Create on Contact reads them. */
  const contactsClosed = async (object: string): Promise<TargetWriteFields> =>
    object === 'Contact'
      ? targetWriteFieldsOf({
          name: 'Contact',
          createable: false,
          updateable: false,
          fields: [{ name: 'LastName', createable: false, type: 'string' }],
        })
      : DESCRIBES[object];

  it('holds an object the target user may not create to its gate, and once the user leaves it out writes the rest', async () => {
    // Nothing checked it: the accounts were written, then every contact was
    // refused, the simulation having counted them written.
    const target = targetOrg();
    const { writeGate, held } = gate({ go: true, asked: true });

    const result = await orchestrator(target, sourceOrg(), {
      writeGate,
      describeTargetFields: contactsClosed,
    }).execute(config());

    expect(held).toEqual([
      {
        objects: [{ objectApiName: 'Account', operation: 'insert', rows: 2 }],
        alreadyCopied: 0,
        unwritable: [
          { objectApiName: 'Contact', operation: 'insert', rows: 2, why: 'notCreateable' },
        ],
      },
    ]);
    expect(target.insert.mock.calls.map(([object]) => object)).toEqual(['Account']);
    const contacts = result.objectResults.find((o) => o.objectApiName === 'Contact');
    expect(contacts).toMatchObject({ processed: 0, success: 0, failed: 0, skipped: 2 });
    expect(contacts?.errors).toEqual([
      'Object is not createable on target org: the user the run writes as may not create ' +
        'Contact records there. None of its records were sent. Left out of the run, as ' +
        'confirmed before it wrote.',
    ]);
  });

  it('counts in a simulation every record of an object the target user may not create refused, none written', async () => {
    const target = targetOrg();
    const { writeGate, measured } = gate();

    const simulation = await orchestrator(target, sourceOrg(), {
      writeGate,
      describeTargetFields: contactsClosed,
    }).simulate(config());

    expect(measured[0].unwritable).toEqual([
      { objectApiName: 'Contact', operation: 'insert', rows: 2, why: 'notCreateable' },
    ]);
    expect(simulation.objects.find((o) => o.objectApiName === 'Contact')).toMatchObject({
      read: 2,
      insert: 0,
      refused: 2,
      notes: [expect.stringContaining('Object is not createable on target org') as unknown],
    });
  });

  it('measures a simulation by its gate, asking nobody', async () => {
    const target = targetOrg();
    const { writeGate, held, measured } = gate();

    const simulation = await orchestrator(target, sourceOrg(), { writeGate }).simulate(config());

    expect(held).toEqual([]);
    expect(measured).toHaveLength(1);
    expect(simulation.writeCheck).toMatchObject({ total: 4 });
  });
});
