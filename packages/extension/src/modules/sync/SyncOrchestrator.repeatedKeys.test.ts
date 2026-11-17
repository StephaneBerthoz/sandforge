import type { Connection } from 'jsforce';
import { describe, expect, it } from 'vitest';
import type { SyncConfig, SyncObjectConfig } from '@sandforge/shared';
import { BulkApiExecutor } from '../../core/engine/BulkApiExecutor.js';
import type { BulkApiManager } from '../../core/engine/BulkApiManager.js';
import { BulkDataWriter } from './BulkDataWriter.js';
import { ConflictResolver } from './ConflictResolver.js';
import { DataSync, type OperationOutcome } from './DataSync.js';
import { FieldMappingService } from './FieldMapping.js';
import { SyncOrchestrator } from './SyncOrchestrator.js';
import { simulationKey } from './SyncSimulation.js';
import { TransformPipeline } from './TransformPipeline.js';
import { targetWriteFieldsOf } from './targetWriteFields.js';

/*
 * An upsert of leads on Email, run between two scratch orgs, two of the four
 * leads read sharing one address: the dry run said 4 to create and 0
 * refused, the run wrote 2 and had the other 2 refused, both twins, each
 * "DUPLICATE_VALUE: Duplicate external id specified: <the address> [Email]",
 * in the one call they went in. The target below answers an upsert's call
 * as that org did; the rows go to it through the run's own writer, which
 * sends an object's records in REST calls of its batch size.
 */

/** Lead as the target describes it: Email is idLookup, no External ID, as the org says. */
const LEAD_FIELDS = [
  { name: 'Id', createable: false, type: 'id', idLookup: true, externalId: false },
  { name: 'LastName', createable: true, type: 'string', idLookup: false, externalId: false },
  { name: 'Company', createable: true, type: 'string', idLookup: false, externalId: false },
  { name: 'Email', createable: true, type: 'email', idLookup: true, externalId: false },
];

const describeTarget = async (objectApiName: string) =>
  targetWriteFieldsOf({
    name: objectApiName,
    createable: true,
    updateable: true,
    fields: LEAD_FIELDS,
  });

/** One upsert call the target was sent: the rows, in order. */
type UpsertCall = Array<Record<string, unknown>>;

/**
 * A target that answers an upsert as the org does, call by call: a key two
 * rows of the call carry refuses both; a key it holds once updates that
 * record; one it holds nowhere creates a record, which the next call finds.
 */
function upsertTarget(held: ReadonlyArray<Record<string, unknown>> = []) {
  const records = held.map((row) => ({ ...row }));
  const calls: UpsertCall[] = [];
  let made = 0;
  const connection = {
    sobject: () => ({
      upsert: async (rows: UpsertCall, key: string) => {
        calls.push(rows.map((row) => ({ ...row })));
        const inCall = new Map<string, number>();
        for (const row of rows) {
          const value = simulationKey(row[key]);
          if (value !== null) inCall.set(value, (inCall.get(value) ?? 0) + 1);
        }
        return rows.map((row) => {
          const value = simulationKey(row[key]);
          if (value !== null && (inCall.get(value) ?? 0) > 1) {
            return {
              success: false,
              errors: [
                {
                  statusCode: 'DUPLICATE_VALUE',
                  message: `Duplicate external id specified: ${String(row[key])}`,
                  fields: [key],
                },
              ],
            };
          }
          const matched = records.filter((record) => simulationKey(record[key]) === value);
          if (matched.length === 1) {
            Object.assign(matched[0], row);
            return { success: true, id: String(matched[0]['Id']), errors: [], created: false };
          }
          const id = `00Q00000000${String(made++).padStart(4, '0')}AAA`;
          records.push({ ...row, Id: id });
          return { success: true, id, errors: [], created: true };
        });
      },
    }),
  };
  return { connection, calls, records };
}

function orchestrator(
  target: ReturnType<typeof upsertTarget>,
  rows: ReadonlyArray<Record<string, unknown>>,
): SyncOrchestrator {
  const writer = new BulkDataWriter({
    connection: target.connection as unknown as Connection,
    bulkExecutor: new BulkApiExecutor(),
    bulkManager: {} as unknown as BulkApiManager,
    retryConfig: { maxRetries: 0, initialDelay: 0, jitter: false },
    onProgress: () => undefined,
    log: () => undefined,
  });
  const unused = async (): Promise<OperationOutcome[]> => [];
  return new SyncOrchestrator({
    dataSync: new DataSync({
      insert: unused,
      update: unused,
      upsert: (object, key, records, batchSize) => writer.upsert(object, key, records, batchSize),
      delete: unused,
      describeTargetFields: describeTarget,
    }),
    conflictResolver: new ConflictResolver(),
    fieldMapping: new FieldMappingService(),
    transformPipeline: new TransformPipeline(),
    querySource: async () => rows.map((row) => ({ ...row })),
    queryTarget: async () => [],
    // What the target holds of each key, as the simulation asks it.
    findInTarget: async (_org, _objectConfig, keyField, keys) => {
      const held = new Map<string, number>();
      const asked = new Set(keys.map((key) => simulationKey(key)));
      for (const record of target.records) {
        const key = simulationKey(record[keyField]);
        if (key !== null && asked.has(key)) held.set(key, (held.get(key) ?? 0) + 1);
      }
      return held;
    },
    describeTargetFields: describeTarget,
  });
}

function leads(batchSize: number): SyncConfig {
  const object: SyncObjectConfig = {
    objectApiName: 'Lead',
    operation: 'upsert',
    externalIdField: 'Email',
    fieldMappings: [],
    transformRules: [],
    excludedFields: [],
    addOnFields: [],
    batchSize,
    insertOrder: 0,
  };
  return {
    id: 'cfg-leads',
    name: 'Leads',
    description: '',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    direction: 'source_to_target',
    mode: 'full',
    objects: [object],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
  };
}

/** Four leads of the source, the first two sharing one address, as the fixture's twins do. */
const LEADS = [
  { Id: '00Q000000000001AAA', LastName: 'Twin', Company: 'A', Email: 'twin@example.com' },
  { Id: '00Q000000000002AAA', LastName: 'Twin', Company: 'A', Email: 'Twin@Example.com' },
  { Id: '00Q000000000003AAA', LastName: 'Other', Company: 'B', Email: 'b@example.com' },
  { Id: '00Q000000000004AAA', LastName: 'Other', Company: 'C', Email: 'c@example.com' },
];

describe('an upsert whose read holds two records of one key', () => {
  it('counts refused in a simulation, with the code, the two records the run sends in one call and has refused', async () => {
    const simulated = await orchestrator(upsertTarget(), LEADS).simulate(leads(200));
    const target = upsertTarget();
    const result = await orchestrator(target, LEADS).execute(leads(200));

    const run = result.objectResults[0];
    expect(target.calls).toHaveLength(1);
    expect(run).toMatchObject({ success: 2, failed: 2 });
    expect(run?.errors.filter((error) => error.startsWith('DUPLICATE_VALUE: '))).toHaveLength(2);

    const object = simulated.objects[0];
    expect(object).toMatchObject({ read: 4, insert: 2, update: 0, refused: 2 });
    expect(object?.insert).toBe(run?.success);
    expect(object?.refused).toBe(run?.failed);
    expect(object?.refusedFor).toEqual([
      expect.objectContaining({ code: 'DUPLICATE_VALUE', rows: 2 }),
    ]);
    expect(object?.notes.join(' ')).toContain(
      '2 record(s) carry the Email of another record of the same call',
    );
  });

  it('counts an update, as the run makes it, of the record a record of an earlier call created', async () => {
    const simulated = await orchestrator(upsertTarget(), LEADS).simulate(leads(1));
    const target = upsertTarget();
    const result = await orchestrator(target, LEADS).execute(leads(1));

    const run = result.objectResults[0];
    expect(target.calls).toHaveLength(4);
    expect(run).toMatchObject({ success: 4, failed: 0, upsertSplit: { created: 3, updated: 1 } });
    expect(simulated.objects[0]).toMatchObject({ insert: 3, update: 1, refused: 0 });
    expect(simulated.objects[0]?.refusedFor).toBeUndefined();
    expect(simulated.objects[0]?.notes.join(' ')).toContain(
      '1 record(s) carry the Email of a record sent in an earlier call',
    );
  });

  it('counts refused both records of a call whose key the target holds already', async () => {
    const held = [{ Id: '00Q000000000099AAA', LastName: 'Held', Email: 'twin@example.com' }];
    const simulated = await orchestrator(upsertTarget(held), LEADS).simulate(leads(200));
    const result = await orchestrator(upsertTarget(held), LEADS).execute(leads(200));

    expect(result.objectResults[0]).toMatchObject({ success: 2, failed: 2 });
    expect(simulated.objects[0]).toMatchObject({ insert: 2, update: 0, refused: 2 });
  });
});
