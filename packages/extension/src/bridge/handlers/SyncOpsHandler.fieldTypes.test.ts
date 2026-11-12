/**
 * The field-type check a run of the panel makes before its first write
 * (`assertFieldTypesMatch`): it judges the fields the write sends. An SFDMU
 * import whose query names its fields writes those alone
 * (`withFieldsOfItsQuery`), so a field it never writes cannot stop its run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SyncConfig, SyncObjectConfig } from '@sandforge/shared';
import { SyncOpsHandler } from './SyncOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { clearDescribeCache } from '../../core/connection/describeCache.js';

/** A field of a describe, as jsforce returns it. */
const field = (name: string, type: string) => ({ name, type, createable: true, updateable: true });

/** An org whose describe of Account holds these fields. */
const org = (fields: ReturnType<typeof field>[]) => ({
  describe: vi.fn(async () => ({ fields: [field('Id', 'id'), ...fields] })),
});

/** The source's Phone is text, the target's a date: the one pair that cannot go. */
const SOURCE = org([field('Name', 'string'), field('Phone', 'string')]);
const TARGET = org([field('Name', 'string'), field('Phone', 'date')]);

function configOf(query?: string): SyncConfig {
  const account: SyncObjectConfig = {
    objectApiName: 'Account',
    operation: 'insert',
    ...(query !== undefined ? { query } : {}),
    fieldMappings: [],
    transformRules: [],
    excludedFields: [],
    addOnFields: [],
    batchSize: 200,
    insertOrder: 0,
  };
  return {
    id: 'cfg-types',
    name: 'Imported',
    description: '',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    direction: 'source_to_target',
    mode: 'full',
    objects: [account],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    createdAt: '2026-11-04T00:00:00Z',
    updatedAt: '2026-11-04T00:00:00Z',
  };
}

describe('SyncOpsHandler — the field types a run judges before its first write', () => {
  let check: (config: SyncConfig) => Promise<void>;

  beforeEach(() => {
    clearDescribeCache();
    let id = 0;
    const deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() },
      configStore: { set: vi.fn(), get: vi.fn(), getKeysByPrefix: vi.fn(() => []) },
      orgManager: { getOrg: vi.fn() },
      infraServices: { productionGuard: new ProductionGuard() },
      nextId: () => String(++id),
    } as unknown as HandlerDeps;
    const handler = new SyncOpsHandler(deps) as unknown as {
      assertFieldTypesMatch(
        config: SyncConfig,
        source: unknown,
        target: unknown,
        timeoutMs: number,
      ): Promise<void>;
    };
    check = (config) => handler.assertFieldTypesMatch(config, SOURCE, TARGET, 5_000);
  });

  it('stops a run that sends a field the target cannot hold, naming the pair', async () => {
    await expect(check(configOf())).rejects.toThrow(
      'Account.Phone (string) -> Account.Phone (date)',
    );
  });

  it("lets an SFDMU import's run go when its query does not select that field", async () => {
    await expect(check(configOf('SELECT Id, Name FROM Account'))).resolves.toBeUndefined();
  });

  it('stops it when its query selects the field', async () => {
    await expect(check(configOf('SELECT Name, Phone FROM Account'))).rejects.toThrow(
      'Account.Phone (string) -> Account.Phone (date)',
    );
  });
});
