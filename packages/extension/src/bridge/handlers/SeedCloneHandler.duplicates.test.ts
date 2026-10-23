import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage } from '@sandforge/shared';
import { SeedCloneHandler } from './SeedCloneHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
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

/*
 * The source's reads and the order of the objects are doubles; the writer is
 * the one a clone builds, over a target whose duplicate rule matches the
 * twins of its accounts. More rows than a REST call takes go as a Bulk API
 * job, which carries no header to let a rule's matches be saved.
 */
const fetcher = vi.hoisted(() => ({
  fetchRecords: vi.fn(),
  countRecords: vi.fn(),
  fetchSample: vi.fn(),
  describe: vi.fn((conn: { describe: (name: string) => Promise<unknown> }, name: string) =>
    conn.describe(name),
  ),
}));
const linker = vi.hoisted(() => ({
  buildEdgesFromDescribe: vi.fn(),
  resolveInsertOrder: vi.fn(),
  lookupsFilledAfter: vi.fn(),
  lookupsOf: vi.fn(),
}));
vi.mock('../../modules/seed/CloneRecordFetcher.js', () => ({
  CloneRecordFetcher: vi.fn().mockImplementation(function () {
    return fetcher;
  }),
}));
vi.mock('../../modules/seed/CloneReferenceLinker.js', () => ({
  CloneReferenceLinker: vi.fn().mockImplementation(function () {
    return linker;
  }),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

/** The id the clone runs under: its request's. */
const OPERATION_ID = 'msg-seed:clone:execute';

function buildMsg(type: string, payload: unknown): InboundRequest {
  return inboundRequest({ id: `msg-${type}`, type, timestamp: Date.now(), payload } as BaseMessage);
}

const clonePayload = {
  sourceOrgId: 'src-org',
  targetOrgId: 'tgt-org',
  objects: [{ objectApiName: 'Account' }],
  previewId: 'msg-seed:clone:preview',
};

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

describe('a clone of records a duplicate rule refused in a Bulk API job', () => {
  let deps: HandlerDeps;
  let storage: string;

  /** Clones 250 source accounts into `org`, every hundredth a twin, and answers the clone's result. */
  async function run(org: DuplicateRuleOrg): Promise<Record<string, unknown>> {
    vi.mocked(getJsforceConnection).mockResolvedValue({
      ...org.connection,
      describeGlobal: vi.fn().mockResolvedValue({ sobjects: [] }),
      describe: vi.fn().mockResolvedValue({ fields: [] }),
      limitInfo: undefined,
    } as unknown as Awaited<ReturnType<typeof getJsforceConnection>>);
    linker.buildEdgesFromDescribe.mockReturnValue([]);
    linker.resolveInsertOrder.mockReturnValue(['Account']);
    linker.lookupsFilledAfter.mockReturnValue([]);
    linker.lookupsOf.mockReturnValue([]);
    fetcher.countRecords.mockResolvedValue(0);
    fetcher.fetchSample.mockResolvedValue([]);
    fetcher.fetchRecords.mockResolvedValue(
      Array.from({ length: 250 }, (_, i) => ({
        Id: `001${String(i).padStart(12, '0')}SRC`,
        Name: i % 100 === 0 ? `Twin ${i}` : `Acme ${i}`,
      })),
    );
    const handler = new SeedCloneHandler(deps);
    handler.setRunCreations(nodeSeedRunCreations(storage));
    // A run follows the preview it names, made for its orgs.
    await handler.handle(buildMsg('seed:clone:preview', clonePayload));
    await handler.handle(buildMsg('seed:clone:execute', clonePayload));
    const response = vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map((call) => call[0] as BaseMessage & { payload: Record<string, unknown> })
      .find((msg) => msg.type === 'seed:clone:execute:response');
    if (!response) throw new Error('the clone answered nothing');
    return response.payload;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createDeps();
    storage = mkdtempSync(join(tmpdir(), 'sandforge-clone-duplicates-'));
  });
  afterEach(() => {
    rmSync(storage, { recursive: true, force: true });
  });

  it('counts the records an Alert rule let REST save as inserted, and keeps their ids for the removal', async () => {
    const org = duplicateRuleOrg();

    const result = await run(org);

    expect(result).toMatchObject({ status: 'success', totalInserted: 250, totalFailed: 0 });
    expect(org.jobs.map((job) => job.rows.length)).toEqual([250]);
    expect(org.rest.map((call) => call.rows.map((row) => row['Name']))).toEqual([
      ['Twin 0', 'Twin 100', 'Twin 200'],
    ]);
    const kept = await nodeSeedRunCreations(storage).get(OPERATION_ID);
    expect(kept?.created.flatMap((object) => object.ids)).toHaveLength(250);
  });

  it('leaves the records a Block rule refuses refused', async () => {
    const result = await run(duplicateRuleOrg({ blocks: true }));

    expect(result).toMatchObject({ totalInserted: 247, totalFailed: 3 });
  });
});
