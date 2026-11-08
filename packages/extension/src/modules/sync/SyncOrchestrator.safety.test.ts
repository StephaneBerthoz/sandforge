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
      // Each object it counted, as a gate's check names them.
      return {
        ...check,
        objects: counted.objects.map(({ objectApiName, rows }) => ({ objectApiName, rows })),
        total: counted.objects.reduce((s, o) => s + o.rows, 0),
      };
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

  it('says, on the second run, that a record the first linked to one the target held was linked, not copied', async () => {
    // Live, the first run linked an account the target held under the same
    // unique value, and the second said "1 already copied by an earlier run".
    // The skip was right: the pair stands. The word was not.
    const target = targetOrg();
    const theirs = fakeId('001', 800);
    target.held.set(theirs, { Name: 'Acme', object: 'Account' });
    const insert = target.insert.getMockImplementation();
    target.insert.mockImplementation(async (object, records) => {
      if (object !== 'Account') return insert!(object, records);
      const outcomes = await insert!(
        object,
        records.filter((record) => record.Name !== 'Acme'),
      );
      return records.map((record) =>
        record.Name === 'Acme'
          ? {
              success: false,
              errors: [
                `DUPLICATE_VALUE: duplicate value found: Code__c duplicates value on record with id: ${theirs}`,
              ],
              existingId: theirs,
            }
          : outcomes.shift()!,
      );
    });
    const source = sourceOrg();
    const first = await orchestrator(target, source).execute(config());
    expect(first.objectResults.find((o) => o.objectApiName === 'Account')).toMatchObject({
      success: 1,
      linkedToExisting: { records: 1 },
    });
    const { writeGate, held } = gate();

    const second = await orchestrator(target, source, { writeGate }).execute(config());
    const simulated = await orchestrator(target, source).simulate(config());

    const accounts = second.objectResults.find((o) => o.objectApiName === 'Account');
    expect(accounts).toMatchObject({ skipped: 2, alreadyCopied: 1, alreadyLinked: 1 });
    expect(second.objectResults.find((o) => o.objectApiName === 'Contact')).toMatchObject({
      skipped: 2,
      alreadyCopied: 2,
    });
    expect(second.objectResults.find((o) => o.objectApiName === 'Contact')).not.toHaveProperty(
      'alreadyLinked',
    );
    expect(held[0]).toMatchObject({ alreadyCopied: 3, alreadyLinked: 1 });
    expect(simulated.objects.find((o) => o.objectApiName === 'Account')).toMatchObject({
      skipped: 2,
      alreadyCopied: 1,
      alreadyLinked: 1,
    });
    expect(target.held.size).toBe(4);
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

  /** The target's describes, as a user without Create on Account reads them. */
  const accountsClosed = async (object: string): Promise<TargetWriteFields> =>
    object === 'Account'
      ? targetWriteFieldsOf({
          name: 'Account',
          createable: false,
          updateable: false,
          fields: [{ name: 'Name', createable: false, type: 'string' }],
        })
      : DESCRIBES[object];

  /** The target's describes, as an org that matches no upsert on Account.Name gives them. */
  const nameNoKey = async (object: string): Promise<TargetWriteFields> =>
    object === 'Account'
      ? targetWriteFieldsOf({
          name: 'Account',
          createable: true,
          updateable: true,
          fields: [
            { name: 'Id', createable: false, type: 'id', idLookup: true, externalId: false },
            { name: 'Name', createable: true, type: 'string', idLookup: false, externalId: false },
          ],
        })
      : DESCRIBES[object];

  it.each([
    ['the target user may not create', accountsClosed, insertOf('Account', 1)],
    [
      'whose upsert matches on a field the target matches none on',
      nameNoKey,
      { ...insertOf('Account', 1), operation: 'upsert' as const, externalIdField: 'Name' },
    ],
  ])(
    'holds back the contacts of an account %s once the user leaves it out, as its simulation counted them',
    async (_why, describeTargetFields, accounts) => {
      // The simulation counted every contact refused, its account refused;
      // the run left the accounts out and sent each contact with the source's
      // AccountId, which the target refused, and wrote it again without one.
      const target = targetOrg();
      const objects = [insertOf('Contact', 0), accounts];
      const simulation = await orchestrator(target, sourceOrg(), {
        writeGate: gate().writeGate,
        describeTargetFields,
      }).simulate(config({ objects }));
      const { writeGate } = gate({ go: true, asked: true });

      const result = await orchestrator(target, sourceOrg(), {
        writeGate,
        describeTargetFields,
      }).execute(config({ objects }));

      expect(simulation.objects.find((o) => o.objectApiName === 'Contact')).toMatchObject({
        insert: 0,
        refused: 2,
      });
      expect(target.insert).not.toHaveBeenCalled();
      expect(target.held.size).toBe(0);
      const contacts = result.objectResults.find((o) => o.objectApiName === 'Contact');
      expect(contacts).toMatchObject({ success: 0, failed: 2 });
      expect(contacts?.errors.join(' ')).toContain('PARENT_REFUSED');
    },
  );

  it('counts at its gate the contacts an account left out holds back apart, not to write, as its simulation counts them', async () => {
    // Run against a real target, a run whose account upsert matched on Name
    // said "4 record(s) to write … Contact 4", while its dry run said 0
    // contacts written and 4 held back. A contact under an account the run
    // does not read goes as before, as the run sends it.
    const source = sourceOrg();
    source.Contact.push({ Id: fakeId('003', 3), LastName: 'Poe', AccountId: fakeId('001', 9) });
    const objects = [
      insertOf('Contact', 0),
      { ...insertOf('Account', 1), operation: 'upsert' as const, externalIdField: 'Name' },
    ];
    const simulated = gate();
    const simulation = await orchestrator(targetOrg(), source, {
      writeGate: simulated.writeGate,
      describeTargetFields: nameNoKey,
    }).simulate(config({ objects }));
    const ran = gate({ go: true, asked: true });
    await orchestrator(targetOrg(), source, {
      writeGate: ran.writeGate,
      describeTargetFields: nameNoKey,
    }).execute(config({ objects }));

    const counted = {
      objects: [{ objectApiName: 'Contact', operation: 'insert', rows: 1 }],
      alreadyCopied: 0,
      unwritable: [
        {
          objectApiName: 'Account',
          operation: 'upsert',
          rows: 2,
          why: 'notAKey',
          key: 'Name',
        },
      ],
      heldBack: [
        {
          objectApiName: 'Contact',
          rows: 2,
          parent: 'Account',
          field: 'AccountId',
          parents: [{ parent: 'Account', field: 'AccountId', rows: 2 }],
        },
      ],
    };
    expect(ran.held).toEqual([counted]);
    expect(simulated.measured).toEqual([counted]);
    expect(simulation.objects.find((o) => o.objectApiName === 'Contact')).toMatchObject({
      insert: 1,
      refused: 2,
    });
  });

  it('counts at its gate the rows under a row held back as held back too', async () => {
    // A case under a contact held back for its account is held back with it.
    const source = {
      ...sourceOrg(),
      Case: [
        { Id: fakeId('500', 1), Subject: 'Late', ContactId: fakeId('003', 1) },
        { Id: fakeId('500', 2), Subject: 'Open', ContactId: null },
      ],
    };
    const describes = async (object: string): Promise<TargetWriteFields> =>
      object === 'Case'
        ? targetWriteFieldsOf({
            name: 'Case',
            fields: [
              { name: 'Subject', createable: true, type: 'string' },
              { name: 'ContactId', createable: true, type: 'reference', referenceTo: ['Contact'] },
            ],
          })
        : accountsClosed(object);
    // Refused at its gate, as a run with nothing else to write is.
    const ran = gate({
      go: false,
      code: 'SYNC_TARGET_UNWRITABLE',
      message: 'Nothing was written.',
    });

    await expect(
      orchestrator(targetOrg(), source, {
        writeGate: ran.writeGate,
        describeTargetFields: describes,
      }).execute(
        config({ objects: [insertOf('Case', 0), insertOf('Contact', 1), insertOf('Account', 2)] }),
      ),
    ).rejects.toBeInstanceOf(SyncRunRefused);

    expect(ran.held[0]?.objects).toEqual([
      { objectApiName: 'Contact', operation: 'insert', rows: 0 },
      { objectApiName: 'Case', operation: 'insert', rows: 1 },
    ]);
    expect(ran.held[0]?.heldBack).toEqual([
      {
        objectApiName: 'Contact',
        rows: 2,
        parent: 'Account',
        field: 'AccountId',
        parents: [{ parent: 'Account', field: 'AccountId', rows: 2 }],
      },
      {
        objectApiName: 'Case',
        rows: 1,
        parent: 'Contact',
        field: 'ContactId',
        parents: [{ parent: 'Contact', field: 'ContactId', rows: 1 }],
      },
    ]);
  });

  it('stops before the contacts when the accounts it leaves out cannot be read, as its simulation stops', async () => {
    const target = targetOrg();
    const source = sourceOrg();
    const { writeGate } = gate({ go: true, asked: true });

    const run = orchestrator(target, source, {
      writeGate,
      describeTargetFields: accountsClosed,
      querySource: async (_org, objectConfig) => {
        if (objectConfig.objectApiName === 'Account') {
          throw new Error('QUERY_TIMEOUT: Your query request was running for too long.');
        }
        return source[objectConfig.objectApiName];
      },
    }).execute(config());

    await expect(run).rejects.toMatchObject({
      message: 'QUERY_TIMEOUT: Your query request was running for too long.',
      result: expect.objectContaining({ status: 'failure' }) as unknown,
    });
    expect(target.insert).not.toHaveBeenCalled();
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
