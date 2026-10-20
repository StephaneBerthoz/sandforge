/**
 * What a seed from the panel is held to before it writes: the data storage
 * the target has left, as Forge and Autopilot hold their runs; and the locale
 * its people and places are drawn in, the org's unless the request names one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseMessage, SeedTemplate } from '@sandforge/shared';
import { CRM_STARTER, SALES_CLOUD_STARTER, recordWriteHeaders } from '@sandforge/shared';
import { BulkApiExecutor } from '../../core/engine/BulkApiExecutor.js';

import { SeedOpsHandler } from './SeedOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { inboundRequest } from '../../test/mockFactories.js';
import type { SeedOrchestratorDependencies } from '../../modules/seed/SeedOrchestrator.js';
import { LOCALE_DATA } from '../../modules/seed/LocaleData.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

/** A Developer Edition: 5 MB of data storage, all of it left, in the given locale. */
function developerEdition(locale = 'fr_FR') {
  const request = vi.fn(async () => ({ DataStorageMB: { Max: 5, Remaining: 5 } }));
  const query = vi.fn(async (soql: string): Promise<{ records: Array<Record<string, unknown>> }> =>
    soql.includes('FROM Organization')
      ? { records: [{ DefaultLocaleSidKey: locale }] }
      : { records: [] },
  );
  vi.mocked(getJsforceConnection).mockResolvedValue({ request, query } as never);
  return { request, query };
}

describe('SeedOpsHandler — storage and locale', () => {
  let deps: HandlerDeps;
  let handler: SeedOpsHandler;
  /** What each run handed the orchestrator it was built with. */
  let built: SeedOrchestratorDependencies[];
  let executed: SeedTemplate[];
  let guardChecks: ReturnType<typeof vi.spyOn>;

  const posted = (type: string) =>
    vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: Record<string, unknown> })
      .filter((m) => m.type === type);

  beforeEach(() => {
    vi.clearAllMocks();
    built = [];
    executed = [];
    let n = 0;
    const guard = new ProductionGuard();
    guardChecks = vi.spyOn(guard, 'check');
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn(() => ({ orgType: 'Developer', alias: 'my-dev-org' })),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as HandlerDeps['orgRegistry'],
      configStore: {
        get: vi.fn(),
        set: vi.fn(),
        getKeysByPrefix: vi.fn(() => []),
      } as unknown as HandlerDeps['configStore'],
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      infraServices: { productionGuard: guard } as HandlerDeps['infraServices'],
      services: {
        isAIEnabled: () => false,
        getSandforgeSetting: vi.fn((_key: string, fallback: unknown) => fallback),
        seedOrchestrator: vi.fn((seedDeps: SeedOrchestratorDependencies) => {
          built.push(seedDeps);
          return {
            execute: vi.fn(async (template: SeedTemplate) => {
              executed.push(template);
              return {
                templateId: template.id,
                operationId: 'op-1',
                status: 'success',
                objectResults: [],
                totalRecordsCreated: 0,
                totalRecordsFailed: 0,
                duration: 1,
                timestamp: '2026-10-20T00:00:00.000Z',
              };
            }),
          };
        }),
      } as unknown as HandlerDeps['services'],
      nextId: () => String(++n),
    };
    handler = new SeedOpsHandler(deps);
  });

  const execute = (template: SeedTemplate, locale?: string) =>
    handler.handle(
      inboundRequest({
        id: 'seed-run',
        type: 'seed:execute',
        timestamp: Date.now(),
        payload: { orgId: 'org-1', template, ...(locale ? { locale } : {}) },
      }),
    );

  it('refuses a template past the storage the org has left, before the guard or any write', async () => {
    // The gallery's first card wrote 7,601 records, about 15 MB, into the
    // 5 MB of a Developer Edition, which filled part way through the run.
    developerEdition();
    await execute(SALES_CLOUD_STARTER);

    expect(posted('seed:error')).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          code: 'SEED_STORAGE_EXCEEDED',
          retryable: false,
          message: expect.stringMatching(
            /^The records to write take about 14\.9 MB of data storage, and my-dev-org has 5 MB left of 5 MB: .* Nothing was written\.$/,
          ),
          estimateMB: 14.9,
          remainingMB: 5,
          maxMB: 5,
          org: 'my-dev-org',
        }),
      }),
    ]);
    expect(guardChecks).not.toHaveBeenCalled();
    expect(built).toEqual([]);
    expect(executed).toEqual([]);
  });

  it('lets a template the org has room for run', async () => {
    developerEdition();
    await execute(CRM_STARTER);

    await vi.waitFor(() => expect(executed).toHaveLength(1));
    expect(posted('seed:error')).toEqual([]);
  });

  it('runs a seed whose org will not say its storage, and says so in the log', async () => {
    const { request } = developerEdition();
    request.mockRejectedValue(new Error('REQUEST_LIMIT_EXCEEDED'));
    await execute(CRM_STARTER);

    await vi.waitFor(() => expect(executed).toHaveLength(1));
    expect(vi.mocked(deps.log).mock.calls.map(([line]) => line)).toContainEqual(
      expect.stringContaining('could not be read (REQUEST_LIMIT_EXCEEDED)'),
    );
  });

  it("draws the people of a seed in the org's own locale, and in the one the request names", async () => {
    // The panel drew every seed in en_US: American people in a French org.
    const contacts = CRM_STARTER.objects.find((o) => o.objectApiName === 'Contact');
    if (!contacts) throw new Error('no contacts');
    const firstNames = async (): Promise<unknown[]> => {
      const mapper = built.at(-1)?.fieldMapper;
      const records = (await mapper?.mapFields({ ...contacts, recordCount: 30 }, new Map())) ?? [];
      return records.map((r) => r['FirstName']);
    };

    developerEdition('fr_FR');
    await execute(CRM_STARTER);
    await vi.waitFor(() => expect(built).toHaveLength(1));
    for (const name of await firstNames()) expect(LOCALE_DATA.fr_FR.firstNames).toContain(name);

    await execute(CRM_STARTER, 'ja_JP');
    await vi.waitFor(() => expect(built).toHaveLength(2));
    for (const name of await firstNames()) expect(LOCALE_DATA.ja_JP.firstNames).toContain(name);
  });

  it('refuses a locale that is no locale before anything is read', async () => {
    developerEdition();
    await execute(CRM_STARTER, "fr_FR'; DROP");
    expect(posted('seed:error')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ code: 'INVALID_PAYLOAD' }) }),
    ]);
    expect(executed).toEqual([]);
  });

  it('writes an object a duplicate rule watches through REST, with the rule waived, and any other as a job', async () => {
    // Sales Cloud Starter's 500 accounts went as a Bulk API job, which carries
    // no duplicate rule header: the org's standard account rule refused 296.
    const { request, query } = developerEdition();
    query.mockImplementation(async (soql: string) =>
      soql.includes('FROM DuplicateRule')
        ? { records: [{ SobjectType: 'Account' }] }
        : soql.includes('FROM Organization')
          ? { records: [{ DefaultLocaleSidKey: 'en_US' }] }
          : { records: [] },
    );
    const create = vi.fn(async (rows: unknown[], _options?: unknown) =>
      rows.map((_, i) => ({ success: true, id: `001${String(i).padStart(15, '0')}` })),
    );
    vi.mocked(getJsforceConnection).mockResolvedValue({
      request,
      query,
      sobject: vi.fn(() => ({ create })),
    } as never);
    const job = vi
      .spyOn(BulkApiExecutor.prototype, 'executeBulk')
      .mockResolvedValue({ successIds: [], failures: [], outcomes: [] } as never);
    await execute(CRM_STARTER);
    await vi.waitFor(() => expect(built).toHaveLength(1));
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ Name: `Row ${i}` }));

    const accounts = await built[0].insert('org-1', 'Account', rows(500), 200);
    expect(accounts.successIds).toHaveLength(500);
    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls[0][1]).toEqual({ headers: recordWriteHeaders() });
    expect(job).not.toHaveBeenCalled();

    await built[0].insert('org-1', 'OpportunityLineItem', rows(500), 200);
    expect(job).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledTimes(3);
    job.mockRestore();
  });

  it('gives the run what the org says of its objects and picklists', async () => {
    developerEdition();
    await execute(CRM_STARTER);
    await vi.waitFor(() => expect(built).toHaveLength(1));
    expect(built[0].objectAccess).toEqual(expect.any(Function));
    expect(built[0].describePicklistValues).toEqual(expect.any(Function));
    expect(built[0].readExistingParentIds).toEqual(expect.any(Function));
  });
});
