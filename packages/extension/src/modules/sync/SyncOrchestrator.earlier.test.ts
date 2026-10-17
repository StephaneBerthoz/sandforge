/**
 * Two runs of one saved configuration through the real orchestrator,
 * DataSync and pairs on disk, against a target that upserts by key and
 * refuses a lookup at a record it does not hold: the first run writes the
 * accounts, the second — a delta run — the contacts under them; then a
 * removal of the first run takes the accounts back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SyncConfig, SyncObjectConfig } from '@sandforge/shared';
import { SyncOrchestrator } from './SyncOrchestrator.js';
import { DataSync, type OperationOutcome } from './DataSync.js';
import { FieldMappingService } from './FieldMapping.js';
import { TransformPipeline } from './TransformPipeline.js';
import { ConflictResolver } from './ConflictResolver.js';
import { targetWriteFieldsOf, type TargetWriteFields } from './targetWriteFields.js';
import { nodeSyncIdMap, savedConfigIdMap, type SyncIdMap } from './SyncIdMap.js';
import type { SyncDeltaLoad, SyncDeltaReads, SyncDeltaStore, SyncWatermark } from './SyncDelta.js';
import type { SyncCreationRecorder, SyncRunKept } from './SyncRunCreations.js';
import { removeSyncRun } from './SyncRunRemoval.js';
import { MemoryRemovalOrg } from '../../test/memoryRemovalOrg.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const SOURCE: Record<string, Array<Record<string, unknown>>> = {
  Account: [
    { Id: fakeId('001', 1), Name: 'Acme', Ext_Id__c: 'A-1' },
    { Id: fakeId('001', 2), Name: 'Globex', Ext_Id__c: 'A-2' },
  ],
  Contact: [
    {
      Id: fakeId('003', 1),
      LastName: 'Roe',
      Email: 'roe@example.invalid',
      AccountId: fakeId('001', 1),
    },
    {
      Id: fakeId('003', 2),
      LastName: 'Doe',
      Email: 'doe@example.invalid',
      AccountId: fakeId('001', 2),
    },
  ],
};

const DESCRIBES: Record<string, TargetWriteFields> = {
  Account: targetWriteFieldsOf({
    name: 'Account',
    fields: [
      { name: 'Name', createable: true, type: 'string' },
      { name: 'Ext_Id__c', createable: true, type: 'string' },
      // Required, and left empty by the source: what a simulation says the
      // target refuses an account it would create for.
      {
        name: 'Region__c',
        createable: true,
        type: 'string',
        nillable: false,
        defaultedOnCreate: false,
      },
    ],
  }),
  Contact: targetWriteFieldsOf({
    name: 'Contact',
    fields: [
      { name: 'LastName', createable: true, type: 'string' },
      { name: 'Email', createable: true, type: 'email' },
      { name: 'AccountId', createable: true, type: 'reference', referenceTo: ['Account'] },
    ],
  }),
};

/** The target: what it holds, and an upsert that refuses a lookup at a record it does not hold. */
function targetOrg() {
  const held = new Map<string, Record<string, unknown>>();
  let next = 900;
  const upsert = async (
    object: string,
    key: string,
    records: Record<string, unknown>[],
  ): Promise<OperationOutcome[]> =>
    records.map((record) => {
      const lookup = record.AccountId;
      if (typeof lookup === 'string' && !held.has(lookup)) {
        return {
          success: false,
          errors: ['INVALID_CROSS_REFERENCE_KEY: invalid cross reference id'],
        };
      }
      const found = [...held].find(([, r]) => r.object === object && r[key] === record[key]);
      if (found) {
        held.set(found[0], { ...found[1], ...record });
        return { id: found[0], success: true, errors: [], created: false };
      }
      const id = fakeId(object === 'Account' ? '001' : '003', next++);
      held.set(id, { ...record, object });
      return { id, success: true, errors: [], created: true };
    });
  return { held, upsert };
}

function upsertOf(objectApiName: string, externalIdField: string): SyncObjectConfig {
  return {
    objectApiName,
    operation: 'upsert',
    externalIdField,
    fieldMappings: [],
    transformRules: [],
    excludedFields: [],
    addOnFields: [],
    batchSize: 200,
    insertOrder: 0,
  };
}

/** The saved configuration: its accounts first, its contacts in a later run. */
const CONFIG: SyncConfig = {
  id: 'cfg-links',
  name: 'Accounts, then contacts',
  description: '',
  sourceOrgId: 'src-org',
  targetOrgId: 'tgt-org',
  direction: 'source_to_target',
  mode: 'delta',
  objects: [upsertOf('Account', 'Ext_Id__c')],
  conflictStrategy: 'source_wins',
  enableRollback: false,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
};

/** Its watermarks, kept in memory as its store keeps them. */
function deltaStore(): SyncDeltaStore {
  const entries: SyncWatermark[] = [];
  return {
    load: (): SyncDeltaLoad =>
      entries.length === 0 ? { kind: 'none' } : { kind: 'stored', state: { version: 1, entries } },
    record: (_configId, watermark) => {
      entries.push(watermark);
    },
  };
}

const DELTA_READS: SyncDeltaReads = {
  latestModstamp: async () => '2026-10-17T08:00:00.000Z',
  deletedRows: async () => ({ records: [], truncated: false }),
  heldInSource: async () => new Set<string>(),
  targetIdsByKey: async () => new Map<string, string[]>(),
};

/** What a run created, kept in memory. */
function recorder(runId: string): SyncCreationRecorder & { created: Map<string, string[]> } {
  const created = new Map<string, string[]>();
  return {
    runId,
    created,
    note: (objectApiName, ids) => {
      created.set(objectApiName, [...(created.get(objectApiName) ?? []), ...ids]);
    },
    flush: async () => undefined,
  };
}

/** Minutes before now, as the org dates a record. */
const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString();

describe('SyncOrchestrator — the records earlier runs of a saved configuration wrote', () => {
  let dir: string;
  let map: SyncIdMap;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sandforge-sync-earlier-'));
    map = nodeSyncIdMap(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function orchestrator(
    target: ReturnType<typeof targetOrg>,
    store: SyncDeltaStore,
    creations?: SyncCreationRecorder,
  ): SyncOrchestrator {
    const unused = async (): Promise<OperationOutcome[]> => [];
    const describeTargetFields = async (object: string) => DESCRIBES[object];
    return new SyncOrchestrator({
      dataSync: new DataSync({
        insert: unused,
        update: unused,
        upsert: (object, key, records) => target.upsert(object, key, records),
        delete: unused,
        describeTargetFields,
      }),
      conflictResolver: new ConflictResolver(),
      fieldMapping: new FieldMappingService(),
      transformPipeline: new TransformPipeline(),
      querySource: async (_org, objectConfig) => SOURCE[objectConfig.objectApiName],
      queryTarget: async () => [],
      findInTarget: async () => new Map(),
      describeTargetFields,
      deltaStore: store,
      deltaReads: DELTA_READS,
      idMap: savedConfigIdMap(map, () => true),
      ...(creations ? { creations } : {}),
    });
  }

  it('points the contacts a delta run writes at the accounts an earlier run wrote, and forgets them once removed', async () => {
    const target = targetOrg();
    const store = deltaStore();
    const first = recorder('run-1');

    await orchestrator(target, store, first).execute(CONFIG);
    const accounts = first.created.get('Account') ?? [];
    expect(accounts).toHaveLength(2);

    const second = await orchestrator(target, store).execute({
      ...CONFIG,
      objects: [upsertOf('Contact', 'Email')],
    });

    expect(second.objectResults[0]).toMatchObject({ success: 2, failed: 0, errors: [] });
    const contacts = [...target.held.values()].filter((r) => r.object === 'Contact');
    expect(contacts.map((c) => [c.LastName, target.held.get(c.AccountId as string)?.Name])).toEqual(
      [
        ['Roe', 'Acme'],
        ['Doe', 'Globex'],
      ],
    );

    // The removal of the first run takes the accounts back, and its pairs go.
    const org = new MemoryRemovalOrg();
    for (const id of accounts) org.add('Account', { Id: id }, minutesAgo(10));
    const run: SyncRunKept = {
      runId: 'run-1',
      configId: CONFIG.id,
      configName: CONFIG.name,
      sourceOrgId: CONFIG.sourceOrgId,
      targetOrgId: CONFIG.targetOrgId,
      startedAt: minutesAgo(11),
      lastWrittenAt: minutesAgo(10),
      end: { at: minutesAgo(10), status: 'success' },
      created: [{ objectApiName: 'Account', ids: accounts }],
    };
    const removed = await removeSyncRun({
      run,
      org,
      includeChanged: false,
      store: { updateRemoval: async () => undefined },
      links: map,
    });

    expect(removed.linksForgotten).toBe(2);
    const left = await map.load(CONFIG.id, CONFIG);
    expect([...left.keys()].sort()).toEqual(
      SOURCE.Contact.map((c) => String(c.Id).slice(0, 15)).sort(),
    );
  });

  it('holds back in a simulation no contact under an account an earlier run wrote, and adds no pair', async () => {
    const target = targetOrg();
    const store = deltaStore();
    await orchestrator(target, store).execute(CONFIG);
    const before = target.held.size;

    // The accounts would be refused this time — the simulation finds them
    // all missing a field the target requires — and their earlier copies
    // stand in for them: the contacts under them are not held back.
    const simulated = await orchestrator(target, store).simulate({
      ...CONFIG,
      objects: [
        upsertOf('Account', 'Ext_Id__c'),
        { ...upsertOf('Contact', 'Email'), insertOrder: 1 },
      ],
    });

    expect(simulated.error).toBeUndefined();
    expect(simulated.objects.map((o) => [o.objectApiName, o.insert, o.refused])).toEqual([
      ['Account', 0, 2],
      ['Contact', 2, 0],
    ]);
    expect(target.held.size).toBe(before);
    expect((await map.load(CONFIG.id, CONFIG)).size).toBe(2);
  });
});
