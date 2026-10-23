import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage } from '@sandforge/shared';
import { SeedCsvHandler } from './SeedCsvHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { duplicateRuleOrg, type DuplicateRuleOrg } from '../../test/duplicateRuleOrg.js';
import { nodeSeedRunCreations } from '../../modules/seed/SeedRunCreations.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));
vi.mock('../../core/common/sforceLimitParser.js', () => ({
  checkApiLimits: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

/*
 * The import writes through the writer itself, not a double of it: more rows
 * than a REST call takes go as a Bulk API job, which carries no header to let
 * a duplicate rule's matches be saved. Run into a Developer Edition, an
 * account its Alert rule matched was refused in a job and saved over REST.
 */

/** The id the import runs under: its request's. */
const OPERATION_ID = 'msg-seed:csv:execute';

function createDeps(): HandlerDeps {
  let idCounter = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: { getOrg: vi.fn() } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: {
      get: vi.fn().mockReturnValue(undefined),
      set: vi.fn(),
    } as unknown as HandlerDeps['configStore'],
    secretVault: {} as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    infraServices: {
      productionGuard: new ProductionGuard(),
    } as unknown as HandlerDeps['infraServices'],
    nextId: () => String(++idCounter),
  };
}

/** An import of `count` accounts, every hundredth a twin of one the target holds. */
function importOf(count: number) {
  return inboundRequest({
    id: OPERATION_ID,
    type: 'seed:csv:execute',
    timestamp: Date.now(),
    payload: {
      orgId: 'tgt-org',
      objectApiName: 'Account',
      records: Array.from({ length: count }, (_, i) => ({
        name: i % 100 === 0 ? `Twin ${i}` : `Acme ${i}`,
      })),
      columnMappings: [
        { csvHeader: 'name', sfFieldApiName: 'Name', sfFieldType: 'string', sfFieldLength: 255 },
      ],
    },
  } as BaseMessage);
}

describe('a CSV import of rows a duplicate rule refused in a Bulk API job', () => {
  let deps: HandlerDeps;
  let storage: string;

  /** Runs the import into `org`, and answers what the page was told. */
  async function run(org: DuplicateRuleOrg): Promise<Record<string, unknown>> {
    vi.mocked(getJsforceConnection).mockResolvedValue({
      ...org.connection,
      describe: vi.fn().mockResolvedValue({ fields: [{ name: 'Name', type: 'string' }] }),
      limitInfo: undefined,
    } as unknown as Awaited<ReturnType<typeof getJsforceConnection>>);
    const handler = new SeedCsvHandler(deps);
    handler.setRunCreations(nodeSeedRunCreations(storage));
    await handler.handle(importOf(250));
    const response = vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map((call) => call[0] as BaseMessage & { payload: Record<string, unknown> })
      .find((msg) => msg.type === 'seed:csv:execute:response');
    if (!response) throw new Error('the import answered nothing');
    return response.payload;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createDeps();
    storage = mkdtempSync(join(tmpdir(), 'sandforge-csv-duplicates-'));
  });
  afterEach(() => {
    rmSync(storage, { recursive: true, force: true });
  });

  it('counts the rows an Alert rule let REST save as inserted, and keeps their ids for the removal', async () => {
    const org = duplicateRuleOrg();

    const answer = await run(org);

    expect(answer).toMatchObject({ insertedCount: 250, failedCount: 0, runId: OPERATION_ID });
    expect(org.jobs.map((job) => job.rows.length)).toEqual([250]);
    expect(org.rest.map((call) => call.rows.map((row) => row['Name']))).toEqual([
      ['Twin 0', 'Twin 100', 'Twin 200'],
    ]);
    const kept = await nodeSeedRunCreations(storage).get(OPERATION_ID);
    expect(kept?.created.flatMap((object) => object.ids)).toHaveLength(250);
  });

  it('leaves the rows a Block rule refuses refused', async () => {
    const answer = await run(duplicateRuleOrg({ blocks: true }));

    expect(answer).toMatchObject({ insertedCount: 247, failedCount: 3 });
    expect(String((answer['errors'] as string[])[0])).toContain('DUPLICATES_DETECTED');
  });
});
