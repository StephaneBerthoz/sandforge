/**
 * How many describes a Seed Clone asks of each org, through the real fetcher
 * and the real insert order: a preview and a run each describe every object
 * once in the source and once in the target.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseMessage } from '@sandforge/shared';
import { SeedCloneHandler } from './SeedCloneHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));
vi.mock('../../core/common/sforceLimitParser.js', () => ({
  checkApiLimits: vi.fn(),
}));

/** The records written to the target org. */
const writer = vi.hoisted(() => ({
  insert: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock('../../modules/sync/BulkDataWriter.js', () => ({
  BulkDataWriter: vi.fn().mockImplementation(function () {
    return writer;
  }),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { inboundRequest } from '../../test/mockFactories.js';

const mockGetConn = vi.mocked(getJsforceConnection);

/** Fake ids: one row of each object in the source. */
const ROWS: Record<string, Record<string, unknown>> = {
  Account: { Id: '001Fk00000AcMeAIAV', Name: 'Acme' },
  Contact: { Id: '003Fk00000DoEjOIAV', LastName: 'Doe', AccountId: '001Fk00000AcMeAIAV' },
  Case: { Id: '500Fk00000CaSeAIAV', Subject: 'Broken', ContactId: '003Fk00000DoEjOIAV' },
};

/** A lookup as a real describe gives it: optional, and set on create and on update. */
function lookup(name: string, referenceTo: string) {
  return { name, type: 'reference', referenceTo: [referenceTo], nillable: true, createable: true };
}

/** The describes both orgs give: a case under its contact, a contact under its account. */
const FIELDS: Record<string, unknown[]> = {
  Account: [{ name: 'Name', type: 'string', createable: true }],
  Contact: [{ name: 'LastName', type: 'string', createable: true }, lookup('AccountId', 'Account')],
  Case: [{ name: 'Subject', type: 'string', createable: true }, lookup('ContactId', 'Contact')],
};

/** An org answering describes and queries, and counting the describes it is asked. */
function org() {
  return {
    describe: vi.fn(async (name: string) => ({
      keyPrefix: null,
      fields: FIELDS[name] ?? [],
      recordTypeInfos: [],
    })),
    query: vi.fn(async (soql: string) => {
      const row = ROWS[/ FROM (\w+)/.exec(soql)?.[1] ?? ''];
      return soql.startsWith('SELECT COUNT()')
        ? { done: true, totalSize: 1, records: [] }
        : { done: true, totalSize: 1, records: row ? [{ attributes: {}, ...row }] : [] };
    }),
    queryMore: vi.fn(),
    limitInfo: undefined,
  };
}

function buildMsg(type: string, payload?: unknown): InboundRequest {
  return inboundRequest({
    id: `msg-${type}`,
    type,
    timestamp: Date.now(),
    payload,
  } as BaseMessage);
}

function createMockDeps(): HandlerDeps {
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

/** All messages of one type posted to the webview, in emission order. */
function posted(deps: HandlerDeps, type: string): Array<BaseMessage & { payload: never }> {
  return vi
    .mocked(deps.broker.postToWebview)
    .mock.calls.map((call) => call[0] as BaseMessage & { payload: never })
    .filter((msg) => msg.type === type);
}

/** Cases, contacts and accounts, picked in that order. */
const PICKED = {
  sourceOrgId: 'src-org',
  targetOrgId: 'tgt-org',
  objects: [{ objectApiName: 'Case' }, { objectApiName: 'Contact' }, { objectApiName: 'Account' }],
};

describe('SeedCloneHandler — the describes it asks for', () => {
  let deps: HandlerDeps;
  let handler: SeedCloneHandler;
  let source: ReturnType<typeof org>;
  let target: ReturnType<typeof org>;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
    handler = new SeedCloneHandler(deps);
    source = org();
    target = org();
    mockGetConn.mockImplementation(
      async (orgId: string) =>
        (orgId === PICKED.sourceOrgId ? source : target) as unknown as Awaited<
          ReturnType<typeof getJsforceConnection>
        >,
    );
    writer.insert.mockImplementation(async (name: string, records: unknown[]) =>
      records.map((_, index) => ({ id: `${name}-${index}`, success: true, errors: [] })),
    );
  });

  /** The objects an org was asked to describe, sorted. */
  const describedIn = (connection: ReturnType<typeof org>): string[] =>
    connection.describe.mock.calls.map(([name]) => name).sort();

  it('describes each object once in each org for a preview', async () => {
    // Asked again for each sample, the source was described twice per
    // object: ten describes for a preview of five objects.
    await handler.handle(buildMsg('seed:clone:preview', PICKED));

    expect(posted(deps, 'seed:clone:error')).toEqual([]);
    expect(posted(deps, 'seed:clone:preview:response')[0].payload as unknown).toMatchObject({
      insertOrder: ['Account', 'Contact', 'Case'],
    });
    expect(describedIn(source)).toEqual(['Account', 'Case', 'Contact']);
    expect(describedIn(target)).toEqual(['Account', 'Case', 'Contact']);
  });

  it('describes each object once in each org for a run, though it orders by both', async () => {
    // The run follows its preview, which describes them too: counted apart.
    await handler.handle(buildMsg('seed:clone:preview', PICKED));
    expect(posted(deps, 'seed:clone:preview:response')).toHaveLength(1);
    source.describe.mockClear();
    target.describe.mockClear();

    await handler.handle(
      buildMsg('seed:clone:execute', { ...PICKED, previewId: 'msg-seed:clone:preview' }),
    );

    expect(writer.insert.mock.calls.map(([name]) => name)).toEqual(['Account', 'Contact', 'Case']);
    expect(describedIn(source)).toEqual(['Account', 'Case', 'Contact']);
    expect(describedIn(target)).toEqual(['Account', 'Case', 'Contact']);
  });
});
