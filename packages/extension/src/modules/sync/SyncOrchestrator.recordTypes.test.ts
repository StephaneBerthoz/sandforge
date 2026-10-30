import { describe, it, expect } from 'vitest';
import type { SyncConfig, SyncObjectConfig } from '@sandforge/shared';
import { SyncOrchestrator } from './SyncOrchestrator.js';
import { DataSync, type OperationOutcome } from './DataSync.js';
import { targetWriteFieldsOf } from './targetWriteFields.js';
import { FieldMappingService } from './FieldMapping.js';
import { TransformPipeline } from './TransformPipeline.js';
import { ConflictResolver } from './ConflictResolver.js';
import type { SyncRecordTypes } from './syncRecordTypes.js';

/*
 * Two fake orgs whose opportunities have record types, as two scratch orgs
 * answered a Sync of opportunities: the source holds one on the master record
 * type, which it reads `RecordTypeId: null`, and one under each of three
 * types of its own; the target holds two of those types under other ids, one
 * of them closed to the running user, and its describe calls the master
 * available and the user's default. Its insert answers as that target did,
 * asked directly: `RecordTypeId` sent empty, or as the master's id, or as a
 * type closed to the user, is refused "Record Type ID: this ID value isn't
 * valid for the user"; a record sent without it is taken, with the one record
 * type the user has.
 */

const MASTER = '012000000000000AAA';
const SOURCE = {
  retail: '0120000000000R1AAA',
  hidden: '0120000000000H1AAA',
  sourceOnly: '0120000000000S1AAA',
};
const TARGET = {
  retail: '0120000000000R2AAA',
  hidden: '0120000000000H2AAA',
};

const RECORD_TYPES: SyncRecordTypes = {
  mappings: [
    { sourceId: SOURCE.retail, targetId: TARGET.retail, developerName: 'Retail' },
    { sourceId: SOURCE.hidden, targetId: TARGET.hidden, developerName: 'Hidden' },
  ],
  source: [
    { id: SOURCE.retail, name: 'Retail', developerName: 'Retail', sobjectType: 'Opportunity' },
    { id: SOURCE.hidden, name: 'Hidden', developerName: 'Hidden', sobjectType: 'Opportunity' },
    {
      id: SOURCE.sourceOnly,
      name: 'Source Only',
      developerName: 'Source_Only',
      sobjectType: 'Opportunity',
    },
  ],
  target: [
    { id: TARGET.retail, name: 'Retail', developerName: 'Retail', sobjectType: 'Opportunity' },
    { id: TARGET.hidden, name: 'Hidden', developerName: 'Hidden', sobjectType: 'Opportunity' },
  ],
};

/** The target's Opportunity, as its describe answered for the running user. */
const DESCRIBE = targetWriteFieldsOf({
  name: 'Opportunity',
  fields: [
    { name: 'Id', createable: false, type: 'id' },
    { name: 'Name', createable: true, type: 'string', nillable: false },
    { name: 'StageName', createable: true, type: 'picklist', nillable: false },
    { name: 'CloseDate', createable: true, type: 'date', nillable: false },
    { name: 'RecordTypeId', createable: true, type: 'reference', nillable: true },
  ],
  recordTypeInfos: [
    {
      active: true,
      available: false,
      defaultRecordTypeMapping: false,
      developerName: 'Hidden',
      master: false,
      name: 'Hidden',
      recordTypeId: TARGET.hidden,
    },
    {
      active: true,
      available: true,
      defaultRecordTypeMapping: false,
      developerName: 'Retail',
      master: false,
      name: 'Retail',
      recordTypeId: TARGET.retail,
    },
    {
      active: true,
      available: true,
      defaultRecordTypeMapping: true,
      developerName: 'Master',
      master: true,
      name: 'Master',
      recordTypeId: MASTER,
    },
  ],
});

function opportunity(Id: string, Name: string, RecordTypeId: string | null) {
  return { Id, Name, StageName: 'Prospecting', CloseDate: '2026-12-31', RecordTypeId };
}

const SOURCE_ROWS = [
  // On the master record type: the org reads it empty.
  opportunity('006000000000001AAA', 'On the master', null),
  opportunity('006000000000002AAA', 'Retail', SOURCE.retail),
  // Held back: a type closed to the running user, one the target lacks.
  opportunity('006000000000003AAA', 'Hidden', SOURCE.hidden),
  opportunity('006000000000004AAA', 'Source only', SOURCE.sourceOnly),
];

/** The target org: an insert that refuses a record type as the target did. */
function targetOrg() {
  const held = new Map<string, Record<string, unknown>>();
  const sent: Record<string, unknown>[] = [];
  let next = 900;
  const refusal = (record: Record<string, unknown>): string | undefined => {
    if (!('RecordTypeId' in record)) return undefined;
    const value = record.RecordTypeId;
    if (value === TARGET.retail) return undefined;
    return (
      "INVALID_CROSS_REFERENCE_KEY: Record Type ID: this ID value isn't valid for the user: " +
      `${typeof value === 'string' ? value : ''} [RecordTypeId]`
    );
  };
  const insert = async (
    _object: string,
    records: Record<string, unknown>[],
  ): Promise<OperationOutcome[]> =>
    records.map((record) => {
      sent.push(record);
      const refused = refusal(record);
      if (refused) return { success: false, errors: [refused] };
      const id = `006000000000${next++}AAA`;
      // Taken without one, it was given the one record type the user had.
      held.set(id, { RecordTypeId: TARGET.retail, ...record });
      return { id, success: true, errors: [] };
    });
  return { held, sent, insert };
}

function objectConfig(): SyncObjectConfig {
  return {
    objectApiName: 'Opportunity',
    operation: 'insert',
    fieldMappings: [],
    transformRules: [],
    excludedFields: [],
    addOnFields: [],
    batchSize: 200,
    insertOrder: 0,
  };
}

const CONFIG: SyncConfig = {
  id: 'config-record-types',
  name: 'Opportunities',
  description: '',
  sourceOrgId: 'src-org',
  targetOrgId: 'tgt-org',
  direction: 'source_to_target',
  mode: 'full',
  objects: [objectConfig()],
  conflictStrategy: 'source_wins',
  enableRollback: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function orchestrator(target: ReturnType<typeof targetOrg>, rows = SOURCE_ROWS) {
  const unused = async (): Promise<OperationOutcome[]> => [];
  const describeTargetFields = async () => DESCRIBE;
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
    querySource: async () => rows,
    queryTarget: async () => [],
    findInTarget: async () => new Map(),
    describeTargetFields,
    recordTypes: async () => RECORD_TYPES,
  });
}

describe('SyncOrchestrator — a record on the master record type, in a target with record types', () => {
  it('writes it without RecordTypeId, which the target refused sent empty, and the target gives it the user’s record type', async () => {
    const target = targetOrg();

    const result = await orchestrator(target, [SOURCE_ROWS[0]]).execute(CONFIG);

    expect(result.objectResults[0]).toMatchObject({ success: 1, failed: 0, errors: [] });
    expect(target.sent).toHaveLength(1);
    expect('RecordTypeId' in target.sent[0]).toBe(false);
    expect([...target.held.values()].map((r) => [r.Name, r.RecordTypeId])).toEqual([
      ['On the master', TARGET.retail],
    ]);
  });

  it('says in the simulation what the run then writes and refuses, each refusal named before the run', async () => {
    const simulated = await orchestrator(targetOrg()).simulate(CONFIG);
    const target = targetOrg();
    const run = await orchestrator(target).execute(CONFIG);

    expect(simulated.error).toBeUndefined();
    const [opportunities] = simulated.objects;
    expect([opportunities.insert, opportunities.refused]).toEqual([2, 2]);
    expect(simulated.objects.map((o) => [o.objectApiName, o.insert, o.refused, o.skipped])).toEqual(
      run.objectResults.map((r) => [r.objectApiName, r.success, r.failed, r.skipped]),
    );
    expect(opportunities.notes).toEqual([
      'RECORD_TYPE_UNAVAILABLE: 1 Opportunity record uses record type Hidden, which the ' +
        'running user cannot use in the target org. Give the running user access to record ' +
        'type Hidden on Opportunity, or map it to one they have. Held back, not sent.',
      'RECORD_TYPE_UNMAPPED: 1 Opportunity record held back, not sent: their record type ' +
        'Source_Only has no active Opportunity record type of that API name in the target ' +
        'org. Create or activate record type Source_Only on Opportunity in the target org.',
    ]);
    // Neither held-back record reached the target; the two it took did.
    expect(target.sent.map((r) => r.Name)).toEqual(['On the master', 'Retail']);
    expect(run.objectResults[0].errors.join(' ')).not.toContain('INVALID_CROSS_REFERENCE_KEY');
  });
});
