/**
 * What a run creates in its target, kept as it writes it for its removal:
 * through the real orchestrator and DataSync, against writers that answer
 * as an org does.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SyncConfig, SyncObjectConfig } from '@sandforge/shared';
import { SyncOrchestrator, type SyncOrchestratorDeps } from './SyncOrchestrator';
import { createdIds } from './BulkDataWriter';
import { SyncRunFailure } from './SyncRunFailure';
import { DataSync, type OperationOutcome } from './DataSync';
import { FieldMappingService } from './FieldMapping';
import { TransformPipeline } from './TransformPipeline';
import { ConflictResolver } from './ConflictResolver';
import { WriteCancelledError } from './WriteCancelledError';
import type { SyncCreationRecorder } from './SyncRunCreations';

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

function objectConfig(overrides: Partial<SyncObjectConfig> = {}): SyncObjectConfig {
  return {
    objectApiName: 'Account',
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

function config(objects: SyncObjectConfig[]): SyncConfig {
  return {
    id: 'cfg-1',
    name: 'Accounts',
    description: '',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    direction: 'source_to_target',
    mode: 'full',
    objects,
    conflictStrategy: 'source_wins',
    enableRollback: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

/** A recorder that keeps in memory what it is told, as the store would write it. */
function memoryRecorder(failure?: string): SyncCreationRecorder & {
  noted: Array<{ objectApiName: string; ids: string[] }>;
} {
  const noted: Array<{ objectApiName: string; ids: string[] }> = [];
  return {
    runId: 'run-1',
    noted,
    note: (objectApiName, ids) => {
      noted.push({ objectApiName, ids: [...ids] });
    },
    flush: async () => failure,
  };
}

/** Rows of the source, by object. */
const SOURCE: Record<string, Array<Record<string, unknown>>> = {
  Account: [
    { Id: fakeId('001', 1), Name: 'Acme', Ext__c: 'K-1' },
    { Id: fakeId('001', 2), Name: 'Globex', Ext__c: 'K-2' },
    { Id: fakeId('001', 3), Name: 'Initech', Ext__c: 'K-3' },
  ],
  Contact: [{ Id: fakeId('003', 1), LastName: 'Doe' }],
};

function orchestrator(
  dataSync: DataSync,
  creations: SyncCreationRecorder | undefined,
  extra: Partial<SyncOrchestratorDeps> = {},
): SyncOrchestrator {
  return new SyncOrchestrator({
    dataSync,
    conflictResolver: new ConflictResolver(),
    fieldMapping: new FieldMappingService(),
    transformPipeline: new TransformPipeline(),
    querySource: vi.fn(async (_org: string, oc: SyncObjectConfig) =>
      (SOURCE[oc.objectApiName] ?? []).map((row) => ({ ...row })),
    ),
    queryTarget: vi.fn(async () => []),
    ...(creations ? { creations } : {}),
    ...extra,
  });
}

/** A writer whose insert creates every record but the ones `refuse` names. */
function inserting(refuse: (record: Record<string, unknown>) => boolean = () => false): DataSync {
  let next = 100;
  const unused = async (): Promise<never> => {
    throw new Error('not used');
  };
  return new DataSync({
    insert: async (objectName, records) =>
      records.map((record): OperationOutcome => {
        if (refuse(record)) return { success: false, errors: ['REQUIRED_FIELD_MISSING: refused'] };
        const prefix = objectName === 'Contact' ? '003' : '001';
        return { id: fakeId(prefix, next++), success: true, errors: [] };
      }),
    update: unused,
    upsert: unused,
    delete: unused,
  });
}

describe('SyncOrchestrator — what a run creates, kept for its removal', () => {
  it('keeps every record an insert wrote, and none it was refused, and counts them in the result', async () => {
    const recorder = memoryRecorder();

    const result = await orchestrator(
      inserting((record) => record.Name === 'Globex'),
      recorder,
    ).execute(config([objectConfig(), objectConfig({ objectApiName: 'Contact', insertOrder: 1 })]));

    expect(recorder.noted).toEqual([
      { objectApiName: 'Account', ids: [fakeId('001', 100), fakeId('001', 101)] },
      { objectApiName: 'Contact', ids: [fakeId('003', 102)] },
    ]);
    expect(result.created).toEqual({
      runId: 'run-1',
      objects: [
        { objectApiName: 'Account', count: 2 },
        { objectApiName: 'Contact', count: 1 },
      ],
      files: 0,
    });
  });

  it('keeps the records an upsert created, never one it updated, nor one it did not say', async () => {
    const recorder = memoryRecorder();
    const unused = async (): Promise<never> => {
      throw new Error('not used');
    };
    const upserting = new DataSync({
      insert: unused,
      update: unused,
      delete: unused,
      upsert: async () => [
        { id: fakeId('001', 7), success: true, errors: [], created: true },
        { id: fakeId('001', 8), success: true, errors: [], created: false },
        { id: fakeId('001', 9), success: true, errors: [] },
      ],
    });

    const result = await orchestrator(upserting, recorder).execute(
      config([objectConfig({ operation: 'upsert', externalIdField: 'Ext__c' })]),
    );

    expect(recorder.noted).toEqual([{ objectApiName: 'Account', ids: [fakeId('001', 7)] }]);
    expect(result.created?.objects).toEqual([{ objectApiName: 'Account', count: 1 }]);
  });

  it('counts what an upsert wrote over, its values kept, and says it of a run that created nothing', async () => {
    const recorder = { ...memoryRecorder(), overwrittenCount: () => 2 };
    const unused = async (): Promise<never> => {
      throw new Error('not used');
    };
    const matching = new DataSync({
      insert: unused,
      update: unused,
      delete: unused,
      upsert: async () => [
        { id: fakeId('001', 8), success: true, errors: [], created: false },
        { id: fakeId('001', 9), success: true, errors: [], created: false },
      ],
    });

    const result = await orchestrator(matching, recorder).execute(
      config([objectConfig({ operation: 'upsert', externalIdField: 'Ext__c' })]),
    );

    // The removal is offered for it: it has values to give back.
    expect(result.created).toEqual({ runId: 'run-1', objects: [], files: 0, overwritten: 2 });
  });

  it('keeps what a write cancelled part way wrote before the cancel', async () => {
    const recorder = memoryRecorder();
    const unused = async (): Promise<never> => {
      throw new Error('not used');
    };
    const cancelled = new DataSync({
      update: unused,
      upsert: unused,
      delete: unused,
      insert: async () => {
        throw new WriteCancelledError('Account', [
          { id: fakeId('001', 50), success: true, errors: [] },
        ]);
      },
    });

    const result = await orchestrator(cancelled, recorder).execute(config([objectConfig()]));

    expect(result.cancelled).toBe(true);
    expect(recorder.noted).toEqual([{ objectApiName: 'Account', ids: [fakeId('001', 50)] }]);
    expect(result.created?.objects).toEqual([{ objectApiName: 'Account', count: 1 }]);
  });

  it('keeps, and counts in the failure, what the objects before a failed one created', async () => {
    const recorder = memoryRecorder();
    const unused = async (): Promise<never> => {
      throw new Error('not used');
    };
    let next = 1;
    const failing = new DataSync({
      update: unused,
      upsert: unused,
      delete: unused,
      insert: async (objectName, records) => {
        if (objectName === 'Contact') throw new Error('INSUFFICIENT_ACCESS: no create on Contact');
        return records.map(() => ({ id: fakeId('001', next++), success: true, errors: [] }));
      },
    });

    const run = orchestrator(failing, recorder).execute(
      config([objectConfig(), objectConfig({ objectApiName: 'Contact', insertOrder: 1 })]),
    );

    await expect(run).rejects.toBeInstanceOf(SyncRunFailure);
    const failure = (await run.catch((err: unknown) => err)) as SyncRunFailure;
    expect(failure.result.created?.objects).toEqual([{ objectApiName: 'Account', count: 3 }]);
    expect(recorder.noted).toHaveLength(1);
  });

  it('goes on when what it created cannot be kept, and says so once', async () => {
    const recorder = memoryRecorder('ENOSPC: no space left on device');

    const result = await orchestrator(inserting(), recorder).execute(
      config([objectConfig(), objectConfig({ objectApiName: 'Contact', insertOrder: 1 })]),
    );

    expect(result.totalSuccess).toBe(4);
    const said = result.objectResults.flatMap((r) =>
      r.errors.filter((e) => e.startsWith('What this run created could not all be kept')),
    );
    expect(said).toEqual([
      'What this run created could not all be kept (ENOSPC: no space left on device): removing ' +
        'the run may leave some of it in the target.',
    ]);
  });

  it('keeps nothing, and counts nothing, without a place to keep it', async () => {
    const result = await orchestrator(inserting(), undefined).execute(config([objectConfig()]));

    expect(result.created).toBeUndefined();
    expect(result.totalSuccess).toBe(3);
  });
});

describe('createdIds', () => {
  const outcomes: OperationOutcome[] = [
    { id: fakeId('001', 1), success: true, errors: [], created: true },
    { id: fakeId('001', 2), success: true, errors: [], created: false },
    { id: fakeId('001', 3), success: true, errors: [] },
    { success: false, errors: ['refused'] },
  ];

  it('takes every record an insert wrote', () => {
    expect(createdIds('insert', outcomes)).toEqual([
      fakeId('001', 1),
      fakeId('001', 2),
      fakeId('001', 3),
    ]);
  });

  it('takes only what an upsert said it created', () => {
    expect(createdIds('upsert', outcomes)).toEqual([fakeId('001', 1)]);
  });

  it('takes nothing an update or a delete wrote', () => {
    expect(createdIds('update', outcomes)).toEqual([]);
    expect(createdIds('delete', outcomes)).toEqual([]);
  });
});
