import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseMessage, CompareItem, CompareResult } from '@sandforge/shared';
import { CompareHandler } from './CompareHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { CompareOrchestrator } from '../../modules/compare/CompareOrchestrator.js';
import { inboundRequest } from '../../test/mockFactories.js';

/*
 * What "modified" rests on, through the real orchestrator, diff engine,
 * comparator and content reader; only the connection is a stand-in.
 *
 * Run against two sandboxes, Compare called all 22 Apex classes they shared
 * modified because their listings differed: each org gives a class its own
 * id, dates and users. Read, 7 differed, 7 were the same, and 8 came from a
 * managed package, whose body reads "(hidden)" in both.
 */

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

const mockGetConn = vi.mocked(getJsforceConnection);

interface ApexClassHeld {
  fullName: string;
  namespace?: string;
  body: string;
}

/**
 * An org holding Apex classes: listMetadata answers with this org's own ids
 * and dates, the query with the bodies.
 */
function orgWith(orgKey: string, classes: ApexClassHeld[]) {
  const list = vi.fn(() =>
    Promise.resolve(
      classes.map((c, index) => ({
        fullName: c.fullName,
        type: 'ApexClass',
        id: `01p${orgKey}${index}`,
        lastModifiedDate: `2026-0${orgKey === 'S' ? 1 : 3}-0${index + 1}T10:00:00.000Z`,
        lastModifiedByName: `User ${orgKey}`,
      })),
    ),
  );
  const query = vi.fn((soql: string) => {
    const asked = [...soql.matchAll(/'([^']*)'/g)].map((m) => m[1]);
    return Promise.resolve({
      records: classes
        .map((c) => ({
          NamespacePrefix: c.namespace ?? null,
          Name: c.namespace ? c.fullName.slice(c.namespace.length + 2) : c.fullName,
          Body: c.body,
        }))
        .filter((row) => asked.includes(row.Name)),
      done: true,
      totalSize: classes.length,
    });
  });
  return { metadata: { list, read: vi.fn() }, query, limitInfo: undefined };
}

function createDeps(): HandlerDeps {
  let idCounter = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: {
      getOrg: vi.fn().mockReturnValue({ orgType: 'Sandbox' }),
    } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as HandlerDeps['orgRegistry'],
    configStore: {} as HandlerDeps['configStore'],
    secretVault: {} as HandlerDeps['secretVault'],
    authProvider: {} as HandlerDeps['authProvider'],
    sfdxBridge: {} as HandlerDeps['sfdxBridge'],
    services: {
      compareOrchestrator: (d: ConstructorParameters<typeof CompareOrchestrator>[0]) =>
        new CompareOrchestrator(d),
    } as unknown as HandlerDeps['services'],
    nextId: () => String(++idCounter),
  };
}

describe('compare:execute content', () => {
  let deps: HandlerDeps;
  let handler: CompareHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createDeps();
    handler = new CompareHandler(deps);
  });

  async function compare(types: string[]): Promise<CompareResult> {
    await handler.handle(
      inboundRequest({
        id: 'req-cmp-content',
        type: 'compare:execute',
        timestamp: Date.now(),
        payload: { sourceOrgId: 'src', targetOrgId: 'tgt', types },
      }),
    );
    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    const response = postToWebview.mock.calls[0][0] as BaseMessage & { payload: CompareResult };
    expect(response.type).toBe('compare:execute:response');
    return response.payload;
  }

  const byName = (diffs: CompareItem[]) => new Map(diffs.map((d) => [d.fullName, d]));

  it('calls modified only the classes whose bodies differ, not the ones whose listings do', async () => {
    const source = orgWith('S', [
      { fullName: 'Invoicing', body: 'public class Invoicing {\n  Integer total;\n}' },
      { fullName: 'Billing', body: 'public class Billing {\n  Integer due;\n}' },
      { fullName: 'pkg__Engine', namespace: 'pkg', body: '(hidden)' },
    ]);
    const target = orgWith('T', [
      // Saved from Windows: the same body.
      { fullName: 'Invoicing', body: 'public class Invoicing {\r\n  Integer total;\r\n}' },
      { fullName: 'Billing', body: 'public class Billing {\n  Decimal due;\n}' },
      { fullName: 'pkg__Engine', namespace: 'pkg', body: '(hidden)' },
    ]);
    mockGetConn.mockImplementation((orgId: string) =>
      Promise.resolve((orgId === 'src' ? source : target) as never),
    );

    const result = await compare(['ApexClass']);
    const diffs = byName(result.diffs);

    expect(diffs.get('Invoicing')?.status).toBe('unchanged');
    expect(diffs.get('Billing')?.status).toBe('modified');
    expect(diffs.get('Billing')?.sourceValue).toContain('2│   Integer due;');
    expect(diffs.get('Billing')?.targetValue).toContain('2│   Decimal due;');
    expect(diffs.get('pkg__Engine')?.status).toBe('not_compared');
    expect(diffs.get('pkg__Engine')?.notComparedReason).toBe('unreadable');
    expect(result.summary).toMatchObject({ modified: 1, unchanged: 1, notCompared: 1 });
  });

  it('says in the result how many components were compared by content and how many were not', async () => {
    const source = orgWith('S', [
      { fullName: 'Invoicing', body: 'a' },
      { fullName: 'pkg__Engine', namespace: 'pkg', body: '(hidden)' },
    ]);
    const target = orgWith('T', [
      { fullName: 'Invoicing', body: 'a' },
      { fullName: 'pkg__Engine', namespace: 'pkg', body: '(hidden)' },
    ]);
    mockGetConn.mockImplementation((orgId: string) =>
      Promise.resolve((orgId === 'src' ? source : target) as never),
    );

    const result = await compare(['ApexClass']);

    expect(result.content).toEqual({
      compared: 1,
      notCompared: { unreadable: 1, read_failed: 0, over_budget: 0 },
      budget: { components: 500, seconds: 90 },
    });
  });

  it('calls a component both orgs hold not compared when its read fails, never modified', async () => {
    const source = orgWith('S', [{ fullName: 'Invoicing', body: 'a' }]);
    const target = orgWith('T', [{ fullName: 'Invoicing', body: 'a' }]);
    target.query.mockRejectedValue(new Error('REQUEST_LIMIT_EXCEEDED'));
    mockGetConn.mockImplementation((orgId: string) =>
      Promise.resolve((orgId === 'src' ? source : target) as never),
    );

    const result = await compare(['ApexClass']);

    expect(result.diffs).toEqual([
      expect.objectContaining({
        fullName: 'Invoicing',
        status: 'not_compared',
        notComparedReason: 'read_failed',
      }),
    ]);
    expect(result.summary.modified).toBe(0);
  });
});
