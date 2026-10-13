/**
 * Delta runs through the real orchestrator, mapping, transforms, DataSync and
 * config store, against two in-memory orgs: a source whose records carry the
 * `SystemModstamp` the org stamps and a recycle bin, and a target that
 * upserts by External ID and deletes by Id.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SyncConfig, SyncObjectConfig } from '@sandforge/shared';
import { SyncOrchestrator, type SourceRead } from './SyncOrchestrator';
import { DataSync, type OperationOutcome } from './DataSync';
import { FieldMappingService } from './FieldMapping';
import { TransformPipeline } from './TransformPipeline';
import { ConflictResolver } from './ConflictResolver';
import { SyncConfigStore } from './SyncConfigStore';
import { WriteCancelledError } from './WriteCancelledError';
import type { SyncDeltaReads, SyncDeltaStore } from './SyncDelta';
import type { ConfigStore } from '../../core/storage/ConfigStore';

type Row = Record<string, unknown>;

/** A source record as the org holds it. */
interface SourceRecord {
  Id: string;
  Name: string;
  Ext_Id__c: string | null;
  Type?: string;
  SystemModstamp: string;
  IsDeleted?: boolean;
}

/** The two orgs, and what was asked of them. */
class OrgPair {
  source: SourceRecord[] = [];
  /** Target records by Id. */
  target = new Map<string, Row>();
  /** Every source read, with the bound it was asked from. */
  reads: Array<string | undefined> = [];
  /** The order the delta asks and reads came in. */
  calls: string[] = [];
  /** Target deletes refused, by Id. */
  refuseDelete = new Set<string>();
  /** Target upserts refused, by key. */
  refuseUpsert = new Set<string>();
  private nextId = 1;

  /** Set when a read is to be reported cut short by a bound. */
  cutReads = false;
  /** Set when the source refuses a SystemModstamp query. */
  noModstamp = false;
  /** Set when the recycle bin read fails. */
  recycleBinFails = false;

  stamp(id: string, at: string, changes: Partial<SourceRecord> = {}): void {
    const record = this.source.find((r) => r.Id === id);
    if (!record) throw new Error(`no source record ${id}`);
    Object.assign(record, changes, { SystemModstamp: at });
  }

  live(): SourceRecord[] {
    return this.source.filter((r) => !r.IsDeleted);
  }

  targetByKey(key: string): Row[] {
    return [...this.target.values()].filter((r) => r.Ext_Id__c === key);
  }

  querySource = vi.fn(async (_org: string, oc: SyncObjectConfig, read?: SourceRead) => {
    this.calls.push('read');
    this.reads.push(read?.changedSince);
    if (this.cutReads) read?.onBoundReached?.();
    return this.live()
      .filter((r) => (oc.where ? r.Type === /'(.*)'/.exec(oc.where)?.[1] : true))
      .filter((r) => !read?.changedSince || r.SystemModstamp > toIso(read.changedSince))
      .map((r) => ({ attributes: { type: 'Account' }, ...r }) as Row);
  });

  deltaReads: SyncDeltaReads = {
    latestModstamp: vi.fn(async () => {
      this.calls.push('stamp');
      if (this.noModstamp) throw new Error('No such column SystemModstamp');
      const stamps = this.live().map((r) => r.SystemModstamp);
      return stamps.length === 0 ? null : stamps.sort().at(-1)!;
    }),
    deletedRows: vi.fn(async (_o: string, _fields: readonly string[], where: string) => {
      this.calls.push('recycle bin');
      if (this.recycleBinFails) throw new Error('INVALID_QUERY_LOCATOR');
      const since = toIso(/SystemModstamp > (\S+)/.exec(where)![1]);
      return {
        records: this.source
          .filter((r) => r.IsDeleted && r.SystemModstamp > since)
          .map((r) => ({ ...r }) as Row),
        truncated: false,
      };
    }),
    heldInSource: vi.fn(async (_o: string, _f: string, values: readonly unknown[]) => {
      const wanted = values.map((v) => String(v).toLowerCase());
      return new Set(
        this.live()
          .map((r) => String(r.Ext_Id__c).toLowerCase())
          .filter((k) => wanted.includes(k)),
      );
    }),
    targetIdsByKey: vi.fn(async (_o: string, field: string, keys: readonly unknown[]) => {
      const wanted = keys.map((k) => String(k).toLowerCase());
      const held = new Map<string, string[]>();
      for (const row of this.target.values()) {
        const key = String(row[field]).toLowerCase();
        if (wanted.includes(key)) held.set(key, [...(held.get(key) ?? []), String(row.Id)]);
      }
      return held;
    }),
  };

  dataSync(): DataSync {
    return new DataSync({
      insert: async () => {
        throw new Error('a delta configuration never inserts');
      },
      update: async () => {
        throw new Error('not used');
      },
      upsert: async (_object, keyField, records) =>
        records.map((record): OperationOutcome => {
          const key = String(record[keyField]);
          if (this.refuseUpsert.has(key)) {
            return { success: false, errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: refused'] };
          }
          const held = this.targetByKey(key)[0];
          // The source's envelope and its own Id are never the target's.
          const fields = Object.fromEntries(
            Object.entries(record).filter(([field]) => field !== 'attributes' && field !== 'Id'),
          );
          if (held) {
            Object.assign(held, fields);
            return { id: String(held.Id), success: true, errors: [], created: false };
          }
          const id = `001T${this.nextId++}`;
          this.target.set(id, { ...fields, Id: id });
          return { id, success: true, errors: [], created: true };
        }),
      delete: async (_object, ids) =>
        ids.map((id): OperationOutcome => {
          if (this.refuseDelete.has(id)) {
            return { id, success: false, errors: ['ENTITY_IS_LOCKED: locked'] };
          }
          this.target.delete(id);
          return { id, success: true, errors: [] };
        }),
    });
  }
}

/** A SOQL datetime (to the second) as the ISO string the records carry. */
function toIso(literal: string): string {
  return new Date(literal).toISOString();
}

/** A ConfigStore holding JSON copies in memory, as the file-backed one does. */
function memoryConfigStore(): ConfigStore {
  const data = new Map<string, { value: string; category: string }>();
  return {
    get: (key: string) => {
      const entry = data.get(key);
      return entry ? JSON.parse(entry.value) : undefined;
    },
    set: (key: string, value: unknown, category = 'general') => {
      data.set(key, { value: JSON.stringify(value), category });
    },
    delete: (key: string) => data.delete(key),
    has: (key: string) => data.has(key),
    getByCategory: (category: string) =>
      Object.fromEntries(
        [...data]
          .filter(([, e]) => e.category === category)
          .map(([k, e]) => [k, JSON.parse(e.value)]),
      ),
  } as unknown as ConfigStore;
}

function accountObject(overrides: Partial<SyncObjectConfig> = {}): SyncObjectConfig {
  return {
    objectApiName: 'Account',
    operation: 'upsert',
    externalIdField: 'Ext_Id__c',
    fieldMappings: [],
    transformRules: [],
    excludedFields: [],
    addOnFields: [],
    batchSize: 200,
    insertOrder: 0,
    ...overrides,
  };
}

function deltaConfig(overrides: Partial<SyncConfig> = {}): SyncConfig {
  return {
    id: 'cfg-delta',
    name: 'delta',
    description: '',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    direction: 'source_to_target',
    mode: 'delta',
    objects: [accountObject()],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Source records stamped by the org at 09:00 on the day of the run. */
function seed(orgs: OrgPair): void {
  orgs.source = [
    { Id: '001S1', Name: 'Acme', Ext_Id__c: 'K-1', SystemModstamp: '2026-10-13T08:00:00.000Z' },
    { Id: '001S2', Name: 'Globex', Ext_Id__c: 'K-2', SystemModstamp: '2026-10-13T08:30:00.000Z' },
    { Id: '001S3', Name: 'Initech', Ext_Id__c: 'K-3', SystemModstamp: '2026-10-13T09:00:00.000Z' },
  ];
}

describe('SyncOrchestrator — delta runs', () => {
  let orgs: OrgPair;
  let store: SyncConfigStore;

  beforeEach(() => {
    orgs = new OrgPair();
    seed(orgs);
    store = new SyncConfigStore(memoryConfigStore());
    store.save(deltaConfig());
    // This machine's clock stands years away from the org's: nothing the run
    // records may come from it.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2031-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** The store the handler gives a run: watermarks of saved configurations only. */
  function deltaStore(): SyncDeltaStore {
    return {
      load: (id) => (store.load(id) ? store.loadDelta(id) : null),
      record: (id, watermark) => store.recordWatermark(id, watermark),
    };
  }

  function orchestrator(extra: Partial<ConstructorParameters<typeof SyncOrchestrator>[0]> = {}) {
    return new SyncOrchestrator({
      dataSync: orgs.dataSync(),
      conflictResolver: new ConflictResolver(),
      fieldMapping: new FieldMappingService(),
      transformPipeline: new TransformPipeline(),
      querySource: orgs.querySource,
      queryTarget: vi.fn().mockResolvedValue([]),
      deltaStore: deltaStore(),
      deltaReads: orgs.deltaReads,
      ...extra,
    });
  }

  function storedWatermark(): string | undefined {
    const load = store.loadDelta('cfg-delta');
    return load.kind === 'stored' ? load.state.entries[0]?.watermark : undefined;
  }

  it("reads a first run whole, says so, and records the source's latest stamp taken before the read", async () => {
    const result = await orchestrator().execute(deltaConfig());

    expect(result.status).toBe('success');
    expect(orgs.reads).toEqual([undefined]);
    // Asked of the org before the object was read: what changes during the
    // read is above it, and is read next time.
    expect(orgs.calls).toEqual(['stamp', 'read']);
    expect(result.objectResults[0].delta).toEqual({
      read: 'full',
      reason: 'first_run',
      changed: 3,
      deletionsChecked: false,
      deleted: 0,
      deleteFailed: 0,
      recorded: '2026-10-13T09:00:00.000Z',
    });
    // The org's time, not this machine's (2031).
    expect(storedWatermark()).toBe('2026-10-13T09:00:00.000Z');
    expect(orgs.target.size).toBe(3);
  });

  it('reads the next run from the watermark less five minutes, and writes only what changed', async () => {
    await orchestrator().execute(deltaConfig());
    orgs.stamp('001S1', '2026-10-13T10:00:00.000Z', { Name: 'Acme Corp' });
    const upsert = vi.spyOn(orgs, 'targetByKey');

    const result = await orchestrator().execute(deltaConfig());

    expect(orgs.reads).toEqual([undefined, '2026-10-13T08:55:00Z']);
    // Initech, stamped at 09:00, is inside the overlap and read again.
    expect(result.objectResults[0]).toMatchObject({ processed: 2, success: 2, failed: 0 });
    expect(result.objectResults[0].delta).toMatchObject({
      read: 'delta',
      since: '2026-10-13T09:00:00.000Z',
      changed: 2,
      recorded: '2026-10-13T10:00:00.000Z',
    });
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(orgs.targetByKey('K-1')[0].Name).toBe('Acme Corp');
    expect(storedWatermark()).toBe('2026-10-13T10:00:00.000Z');
  });

  it('writes a record the overlap reads twice by its key again, and the target keeps one copy of it', async () => {
    await orchestrator().execute(deltaConfig());
    // Committed late: stamped two minutes before the watermark it missed.
    orgs.stamp('001S2', '2026-10-13T08:58:00.000Z', { Name: 'Globex (late)' });

    await orchestrator().execute(deltaConfig());
    await orchestrator().execute(deltaConfig());

    expect(orgs.target.size).toBe(3);
    expect(orgs.targetByKey('K-2')).toEqual([
      expect.objectContaining({ Name: 'Globex (late)', Ext_Id__c: 'K-2' }),
    ]);
  });

  it('keeps the previous watermark when a record of the object was refused', async () => {
    await orchestrator().execute(deltaConfig());
    orgs.stamp('001S1', '2026-10-13T10:00:00.000Z');
    orgs.refuseUpsert.add('K-1');

    const result = await orchestrator().execute(deltaConfig());

    expect(result.status).toBe('partial');
    expect(result.objectResults[0].delta).toMatchObject({ read: 'delta' });
    expect(result.objectResults[0].delta?.recorded).toBeUndefined();
    expect(storedWatermark()).toBe('2026-10-13T09:00:00.000Z');
  });

  it('keeps the previous watermark when the object failed, and reports the failure', async () => {
    await orchestrator().execute(deltaConfig());
    orgs.stamp('001S1', '2026-10-13T10:00:00.000Z');
    orgs.querySource.mockRejectedValueOnce(new Error('REQUEST_LIMIT_EXCEEDED'));

    await expect(orchestrator().execute(deltaConfig())).rejects.toMatchObject({
      result: expect.objectContaining({ status: 'failure' }),
    });
    expect(storedWatermark()).toBe('2026-10-13T09:00:00.000Z');
  });

  it('keeps the previous watermark when a cancel stopped the object', async () => {
    await orchestrator().execute(deltaConfig());
    orgs.stamp('001S1', '2026-10-13T10:00:00.000Z');
    const dataSync = orgs.dataSync();
    vi.spyOn(dataSync, 'sync').mockRejectedValueOnce(new WriteCancelledError('Account', []));

    const result = await orchestrator({ dataSync }).execute(deltaConfig());

    expect(result.cancelled).toBe(true);
    expect(storedWatermark()).toBe('2026-10-13T09:00:00.000Z');
  });

  it('keeps the previous watermark when a bound cut the read short', async () => {
    await orchestrator().execute(deltaConfig());
    orgs.stamp('001S1', '2026-10-13T10:00:00.000Z');
    orgs.cutReads = true;

    const result = await orchestrator().execute(deltaConfig());

    expect(result.status).toBe('success');
    expect(result.objectResults[0].delta?.recorded).toBeUndefined();
    expect(storedWatermark()).toBe('2026-10-13T09:00:00.000Z');
  });

  it('reads whole once after the scope changed, says so, and records the new scope', async () => {
    await orchestrator().execute(deltaConfig());
    orgs.source[0].Type = 'Customer';
    const narrowed = deltaConfig({ objects: [accountObject({ where: "Type = 'Customer'" })] });
    store.save(narrowed);

    const first = await orchestrator().execute(narrowed);
    const second = await orchestrator().execute(narrowed);

    expect(first.objectResults[0].delta).toMatchObject({ read: 'full', reason: 'scope_changed' });
    expect(orgs.reads.slice(1)).toEqual([undefined, '2026-10-13T08:55:00Z']);
    expect(second.objectResults[0].delta).toMatchObject({ read: 'delta' });
  });

  it('reads whole and says so when the stored watermarks do not read, then records over them', async () => {
    const backing = memoryConfigStore();
    backing.set('sync:delta:cfg-delta', { version: 1, entries: [{ watermark: 'tomorrow' }] });
    store = new SyncConfigStore(backing);
    store.save(deltaConfig());

    const result = await orchestrator().execute(deltaConfig());

    expect(orgs.reads).toEqual([undefined]);
    expect(result.objectResults[0].delta).toMatchObject({ read: 'full', reason: 'unreadable' });
    expect(store.loadDelta('cfg-delta')).toMatchObject({ kind: 'stored' });
    expect(storedWatermark()).toBe('2026-10-13T09:00:00.000Z');
  });

  it('reads whole after "Run full next time", says it was asked, and reads delta after that', async () => {
    await orchestrator().execute(deltaConfig());
    expect(store.clearDelta('cfg-delta')).toBe(1);

    const reset = await orchestrator().execute(deltaConfig());
    const next = await orchestrator().execute(deltaConfig());

    expect(reset.objectResults[0].delta).toMatchObject({ read: 'full', reason: 'reset' });
    expect(next.objectResults[0].delta).toMatchObject({ read: 'delta' });
  });

  it('reads a configuration that is not saved whole, asks no stamp, and records nothing', async () => {
    const unsaved = deltaConfig({ id: 'cfg-elsewhere' });

    const result = await orchestrator().execute(unsaved);

    expect(result.objectResults[0].delta).toMatchObject({ read: 'full', reason: 'not_saved' });
    expect(orgs.deltaReads.latestModstamp).not.toHaveBeenCalled();
    expect(store.loadDelta('cfg-elsewhere')).toEqual({ kind: 'none' });
  });

  it('reads whole and records nothing when the source gives no SystemModstamp', async () => {
    orgs.noModstamp = true;

    const result = await orchestrator().execute(deltaConfig());

    expect(result.objectResults[0].delta).toMatchObject({ read: 'full', reason: 'no_modstamp' });
    expect(store.loadDelta('cfg-delta')).toEqual({ kind: 'none' });
  });

  it('leaves a full configuration as it was: no stamp, no bound, no delta said', async () => {
    const result = await orchestrator().execute(deltaConfig({ mode: 'full' }));

    expect(orgs.querySource).toHaveBeenCalledWith('src-org', expect.anything());
    expect(orgs.querySource.mock.calls[0]).toHaveLength(2);
    expect(orgs.deltaReads.latestModstamp).not.toHaveBeenCalled();
    expect(result.objectResults[0].delta).toBeUndefined();
  });

  describe('deletions', () => {
    /** A first run, then Globex deleted in the source after it. */
    async function deletedAfterFirstRun(): Promise<void> {
      await orchestrator().execute(deltaConfig({ propagateDeletes: true }));
      orgs.stamp('001S2', '2026-10-13T11:00:00.000Z', { IsDeleted: true });
    }

    it('are left alone unless asked for: the target keeps the record', async () => {
      await deletedAfterFirstRun();

      const result = await orchestrator().execute(deltaConfig());

      expect(orgs.deltaReads.deletedRows).not.toHaveBeenCalled();
      expect(orgs.targetByKey('K-2')).toHaveLength(1);
      expect(result.objectResults[0].delta).toMatchObject({ deletionsChecked: false, deleted: 0 });
    });

    it('delete the one target record tied to a deleted source record by the key, and count it', async () => {
      await deletedAfterFirstRun();
      // A record the target holds that no source record was ever matched to.
      orgs.target.set('001TX', { Id: '001TX', Name: 'Target only', Ext_Id__c: 'K-9' });

      const result = await orchestrator().execute(deltaConfig({ propagateDeletes: true }));

      expect(orgs.targetByKey('K-2')).toEqual([]);
      expect(orgs.target.has('001TX')).toBe(true);
      expect(orgs.target.size).toBe(3);
      expect(result.status).toBe('success');
      expect(result.objectResults[0].delta).toMatchObject({
        read: 'delta',
        deletionsChecked: true,
        deleted: 1,
        deleteFailed: 0,
        recorded: '2026-10-13T09:00:00.000Z',
      });
      // The deletes come after the changes, and the stamp before both.
      expect(orgs.calls.slice(2)).toEqual(['stamp', 'read', 'recycle bin']);
    });

    it('keep a target record whose key a live source record still holds', async () => {
      await deletedAfterFirstRun();
      orgs.source.push({
        Id: '001S9',
        Name: 'Globex again',
        Ext_Id__c: 'K-2',
        SystemModstamp: '2026-10-13T11:05:00.000Z',
      });

      const result = await orchestrator().execute(deltaConfig({ propagateDeletes: true }));

      expect(orgs.targetByKey('K-2')).toHaveLength(1);
      expect(result.objectResults[0].delta).toMatchObject({ deleted: 0 });
      expect(result.objectResults[0].errors).toEqual([
        expect.stringContaining('a record the source still holds'),
      ]);
    });

    it('a delete the target refuses leaves the run partial and the watermark where it was', async () => {
      await deletedAfterFirstRun();
      orgs.stamp('001S1', '2026-10-13T10:30:00.000Z');
      orgs.refuseDelete.add(String(orgs.targetByKey('K-2')[0].Id));

      const result = await orchestrator().execute(deltaConfig({ propagateDeletes: true }));

      expect(result.status).toBe('partial');
      expect(result.objectResults[0].delta).toMatchObject({ deleted: 0, deleteFailed: 1 });
      expect(result.objectResults[0].delta?.recorded).toBeUndefined();
      expect(storedWatermark()).toBe('2026-10-13T09:00:00.000Z');
    });

    it('a recycle bin that cannot be read leaves the run partial, the watermark kept, the next object run', async () => {
      await deletedAfterFirstRun();
      // A change after the first run: a watermark recorded now would move.
      orgs.stamp('001S1', '2026-10-13T10:30:00.000Z');
      orgs.recycleBinFails = true;
      const two = deltaConfig({
        propagateDeletes: true,
        objects: [accountObject(), accountObject({ objectApiName: 'Contact', insertOrder: 1 })],
      });
      store.save(two);

      const result = await orchestrator().execute(two);

      expect(result.status).toBe('partial');
      expect(result.objectResults.map((o) => o.objectApiName)).toEqual(['Account', 'Contact']);
      expect(result.objectResults[0].delta?.deletionError).toContain('INVALID_QUERY_LOCATOR');
      expect(result.objectResults[0].delta?.recorded).toBeUndefined();
      expect(storedWatermark()).toBe('2026-10-13T09:00:00.000Z');
    });

    it('are not looked for on a full read, which has no point to start from', async () => {
      orgs.source[1].IsDeleted = true;

      const result = await orchestrator().execute(deltaConfig({ propagateDeletes: true }));

      expect(orgs.deltaReads.deletedRows).not.toHaveBeenCalled();
      expect(result.objectResults[0].delta).toMatchObject({
        read: 'full',
        deletionsChecked: false,
      });
    });
  });

  describe('simulation', () => {
    it('reads as the run would, counts the deletions it would carry, and writes and records nothing', async () => {
      await orchestrator().execute(deltaConfig({ propagateDeletes: true }));
      orgs.stamp('001S1', '2026-10-13T10:00:00.000Z', { Name: 'Acme Corp' });
      orgs.stamp('001S2', '2026-10-13T11:00:00.000Z', { IsDeleted: true });
      const before = JSON.stringify([...orgs.target]);
      const record = vi.spyOn(store, 'recordWatermark');

      const simulation = await orchestrator({
        findInTarget: async (_org, _oc, _field, keys) =>
          new Map(
            keys
              .filter((k) => orgs.targetByKey(String(k)).length > 0)
              .map((k) => [String(k).toLowerCase(), 1]),
          ),
      }).simulate(deltaConfig({ propagateDeletes: true }));

      expect(orgs.reads.at(-1)).toBe('2026-10-13T08:55:00Z');
      expect(simulation.objects[0]).toMatchObject({
        read: 2,
        update: 2,
        insert: 0,
        delete: 1,
        delta: { read: 'delta', since: '2026-10-13T09:00:00.000Z', changed: 2, deleted: 1 },
      });
      expect(simulation.objects[0].delta?.recorded).toBeUndefined();
      expect(JSON.stringify([...orgs.target])).toBe(before);
      expect(record).not.toHaveBeenCalled();
    });

    it('says a first run reads whole', async () => {
      const simulation = await orchestrator({
        findInTarget: async () => new Map(),
      }).simulate(deltaConfig());

      expect(simulation.objects[0]).toMatchObject({
        insert: 3,
        delta: { read: 'full', reason: 'first_run', changed: 3 },
      });
    });
  });
});
