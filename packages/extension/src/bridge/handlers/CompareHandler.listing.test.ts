import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseMessage, CompareItem, CompareResult } from '@sandforge/shared';
import { CompareHandler } from './CompareHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { CompareOrchestrator } from '../../modules/compare/CompareOrchestrator.js';
import { inboundRequest } from '../../test/mockFactories.js';

/*
 * The diff behind the Compare page, run through the real orchestrator, diff
 * engine and metadata comparator: only the connection is a stand-in, and it
 * answers listMetadata the way an org does. Both orgs hold the same content
 * of every component they share, so what is in both is unchanged.
 */

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

const mockGetConn = vi.mocked(getJsforceConnection);

interface ListQuery {
  type: string;
  folder?: string;
}

/**
 * An org's listMetadata. A folder-filed type (Report, Dashboard,
 * EmailTemplate) answers only when asked folder by folder, and with nothing at
 * all when asked without one; a call takes at most three queries.
 */
function orgListing(folders: Record<string, string[]>, filed: Record<string, string[]>) {
  const list = vi.fn((queries: ListQuery[]) => {
    if (queries.length > 3) {
      return Promise.reject(new Error('INVALID_QUERY: listMetadata takes at most 3 queries'));
    }
    return Promise.resolve(
      queries.flatMap((q) => {
        const names =
          q.folder === undefined ? (folders[q.type] ?? []) : (filed[`${q.type}:${q.folder}`] ?? []);
        // What an org lists for a component a managed package installed.
        return names.map((fullName) =>
          fullName.startsWith('ns__')
            ? { fullName, type: q.type, namespacePrefix: 'ns', manageableState: 'installed' }
            : { fullName, type: q.type, manageableState: 'unmanaged' },
        );
      }),
    );
  });
  const read = vi.fn((_type: string, names: string[]) =>
    Promise.resolve(names.map((fullName) => ({ fullName, description: 'the same in both' }))),
  );
  const query = vi.fn((soql: string) => {
    const names = [...soql.matchAll(/'([^']*)'/g)].map((m) => m[1]);
    return Promise.resolve({
      records: names.map((Name) => ({ NamespacePrefix: null, Name, Body: 'the same in both' })),
      done: true,
      totalSize: names.length,
    });
  });
  return { metadata: { list, read }, query, limitInfo: undefined };
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

describe('compare:execute listing', () => {
  let deps: HandlerDeps;
  let handler: CompareHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createDeps();
    handler = new CompareHandler(deps);
  });

  async function compare(
    types: string[],
    options: { includeManaged?: boolean } = {},
  ): Promise<CompareResult> {
    await handler.handle(
      inboundRequest({
        id: 'req-cmp-list',
        type: 'compare:execute',
        timestamp: Date.now(),
        payload: { sourceOrgId: 'src', targetOrgId: 'tgt', types, ...options },
      }),
    );
    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    const response = postToWebview.mock.calls[0][0] as BaseMessage & { payload: CompareResult };
    expect(response.type).toBe('compare:execute:response');
    return response.payload;
  }

  const byName = (diffs: CompareItem[]) =>
    Object.fromEntries(diffs.map((d) => [d.fullName, d.status]));

  it('lists reports, dashboards and email templates folder by folder', async () => {
    // Asked without a folder, listMetadata answers these three with nothing.
    // Run against two sandboxes holding 191 reports, 17 dashboards and 80
    // email templates each, the page listed none of them, and so reported no
    // difference in any.
    const source = orgListing(
      {
        ReportFolder: ['unfiled$public', 'Sales', 'Service', 'Finance'],
        DashboardFolder: ['Exec'],
        EmailTemplateFolder: ['unfiled$public'],
      },
      {
        'Report:unfiled$public': ['unfiled$public/Pipeline'],
        'Report:Sales': ['Sales/Quota', 'Sales/Won'],
        'Report:Finance': ['Finance/Revenue'],
        'Dashboard:Exec': ['Exec/Overview'],
        'EmailTemplate:unfiled$public': ['unfiled$public/Welcome'],
      },
    );
    const target = orgListing(
      {
        ReportFolder: ['unfiled$public', 'Sales'],
        DashboardFolder: ['Exec'],
        EmailTemplateFolder: ['unfiled$public'],
      },
      {
        'Report:unfiled$public': ['unfiled$public/Pipeline'],
        'Report:Sales': ['Sales/Quota'],
        'Dashboard:Exec': ['Exec/Overview'],
        'EmailTemplate:unfiled$public': ['unfiled$public/Welcome'],
      },
    );
    mockGetConn.mockImplementation((orgId: string) =>
      Promise.resolve((orgId === 'src' ? source : target) as never),
    );

    const result = await compare(['Report', 'Dashboard', 'EmailTemplate']);

    expect(byName(result.diffs)).toEqual({
      'unfiled$public/Pipeline': 'unchanged',
      'Sales/Quota': 'unchanged',
      'Sales/Won': 'removed',
      'Finance/Revenue': 'removed',
      'Exec/Overview': 'unchanged',
      'unfiled$public/Welcome': 'unchanged',
    });
    // Four folders are three queries and one: never more than a call takes.
    for (const [queries] of source.metadata.list.mock.calls) {
      expect(queries.length).toBeLessThanOrEqual(3);
    }
  });

  it('lists a type that is not filed in folders in one query, as before', async () => {
    const source = orgListing({ ApexClass: ['Invoicing', 'Billing'] }, {});
    const target = orgListing({ ApexClass: ['Invoicing'] }, {});
    mockGetConn.mockImplementation((orgId: string) =>
      Promise.resolve((orgId === 'src' ? source : target) as never),
    );

    const result = await compare(['ApexClass']);

    expect(byName(result.diffs)).toEqual({ Invoicing: 'unchanged', Billing: 'removed' });
    expect(source.metadata.list).toHaveBeenCalledTimes(1);
    expect(source.metadata.list).toHaveBeenCalledWith([{ type: 'ApexClass' }]);
  });

  describe('what a managed package installed', () => {
    beforeEach(() => {
      const source = orgListing({ ApexClass: ['Invoicing', 'ns__Helper', 'ns__Extra'] }, {});
      const target = orgListing({ ApexClass: ['Invoicing', 'ns__Helper'] }, {});
      mockGetConn.mockImplementation((orgId: string) =>
        Promise.resolve((orgId === 'src' ? source : target) as never),
      );
    });

    it('compares it with the rest when the page does not say otherwise', async () => {
      const result = await compare(['ApexClass']);

      // Listed in both orgs, the managed class is not compared: an org hides
      // its Apex, and this stand-in's query does not answer for it either.
      expect(byName(result.diffs)).toEqual({
        Invoicing: 'unchanged',
        ns__Helper: 'not_compared',
        ns__Extra: 'removed',
      });
      expect(result.content.managedLeftOut).toBeUndefined();
    });

    it('leaves it out of both orgs when the page asks, and says how many it left out', async () => {
      // `includeManaged` was set to false here and read by nothing: every run
      // compared the packages all the same.
      const result = await compare(['ApexClass'], { includeManaged: false });

      expect(byName(result.diffs)).toEqual({ Invoicing: 'unchanged' });
      expect(result.content.managedLeftOut).toBe(2);
      expect(result.summary.removed).toBe(0);
    });
  });
});
