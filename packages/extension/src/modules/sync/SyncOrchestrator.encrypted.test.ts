/**
 * A run whose source user reads a classic encrypted field masked, lacking
 * View Encrypted Data: the value the read returns is the mask, which a run
 * copied into the target, over a record's real value on an update.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SyncConfig, SyncObjectConfig, SyncObjectResult } from '@sandforge/shared';
import { SyncOrchestrator, type SyncOrchestratorDeps } from './SyncOrchestrator.js';
import { FieldMappingService } from './FieldMapping.js';
import { TransformPipeline } from './TransformPipeline.js';
import { ConflictResolver } from './ConflictResolver.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const C1 = fakeId('003', 1);

/** A contact as the source answers its user: the encrypted field masked. */
const READ = (): Array<Record<string, unknown>> => [
  { Id: C1, LastName: 'Roe', Tax_Id__c: '***-**-1234', Ext_Id__c: 'C-1' },
];

function objectConfig(overrides?: Partial<SyncObjectConfig>): SyncObjectConfig {
  return {
    objectApiName: 'Contact',
    operation: 'upsert',
    externalIdField: 'Ext_Id__c',
    fieldMappings: [],
    transformRules: [],
    excludedFields: [],
    addOnFields: [],
    batchSize: 200,
    insertOrder: 1,
    ...overrides,
  };
}

function config(overrides?: Partial<SyncConfig>): SyncConfig {
  return {
    id: 'config-1',
    name: 'Contacts',
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
    ...overrides,
  };
}

/** The orchestrator's deps, the write a spy that keeps the records it is handed. */
function deps(masked?: readonly string[]) {
  const written: Array<Array<Record<string, unknown>>> = [];
  const result: SyncObjectResult = {
    objectApiName: 'Contact',
    operation: 'upsert',
    processed: 1,
    success: 1,
    failed: 0,
    skipped: 0,
    conflictCount: 0,
    errors: [],
  };
  const orchestratorDeps: SyncOrchestratorDeps = {
    dataSync: {
      sync: vi.fn(async (_config: SyncObjectConfig, records: Array<Record<string, unknown>>) => {
        written.push(records.map((record) => ({ ...record })));
        return result;
      }),
    } as unknown as SyncOrchestratorDeps['dataSync'],
    conflictResolver: new ConflictResolver(),
    fieldMapping: new FieldMappingService(),
    transformPipeline: new TransformPipeline(),
    querySource: vi.fn(async () => READ()),
    // The target's contact, its own encrypted value masked to the run's user too.
    queryTarget: vi.fn(async () => [
      { Id: fakeId('003', 9), LastName: 'Roe', Tax_Id__c: '***-**-9876', Ext_Id__c: 'C-1' },
    ]),
    findInTarget: vi.fn(async () => new Map([['C-1', 1]])),
    ...(masked ? { maskedSourceFields: vi.fn(async () => masked) } : {}),
  };
  return { orchestratorDeps, written };
}

describe('SyncOrchestrator, of an encrypted field the source user reads masked', () => {
  it('writes no record with it, and names it in the object result', async () => {
    const { orchestratorDeps, written } = deps(['Tax_Id__c']);

    const result = await new SyncOrchestrator(orchestratorDeps).execute(config());

    expect(written).toEqual([[{ Id: C1, LastName: 'Roe', Ext_Id__c: 'C-1' }]]);
    expect(result.objectResults[0].encryptedLeftOut).toEqual(['Tax_Id__c']);
  });

  it('copied the mask as read when nothing said the field was masked', async () => {
    // What a run did before: the mask went into the target.
    const { orchestratorDeps, written } = deps();

    const result = await new SyncOrchestrator(orchestratorDeps).execute(config());

    expect(written[0][0].Tax_Id__c).toBe('***-**-1234');
    expect(result.objectResults[0]).not.toHaveProperty('encryptedLeftOut');
  });

  it("compares a bidirectional run without it, so the target's own mask is never written back", async () => {
    // Left out of the source alone, the field differed on every record, and
    // the target's value won: its mask was written over its real value.
    const { orchestratorDeps, written } = deps(['Tax_Id__c']);

    const result = await new SyncOrchestrator(orchestratorDeps).execute(
      config({ direction: 'bidirectional', conflictStrategy: 'target_wins' }),
    );

    expect(written[0][0]).not.toHaveProperty('Tax_Id__c');
    expect(result.objectResults[0].encryptedLeftOut).toEqual(['Tax_Id__c']);
  });

  it('names it in a simulation of the object too', async () => {
    const { orchestratorDeps } = deps(['Tax_Id__c']);

    const simulated = await new SyncOrchestrator(orchestratorDeps).simulate(config());

    expect(simulated.objects[0].encryptedLeftOut).toEqual(['Tax_Id__c']);
  });

  it('names none of a field the read did not carry, and asks nothing of an object that read no record', async () => {
    const { orchestratorDeps } = deps(['Other__c']);
    const masked = vi.mocked(orchestratorDeps.maskedSourceFields!);

    const result = await new SyncOrchestrator(orchestratorDeps).execute(config());
    vi.mocked(orchestratorDeps.querySource).mockResolvedValue([]);
    await new SyncOrchestrator(orchestratorDeps).execute(config());

    expect(result.objectResults[0]).not.toHaveProperty('encryptedLeftOut');
    expect(masked).toHaveBeenCalledTimes(1);
  });
});
