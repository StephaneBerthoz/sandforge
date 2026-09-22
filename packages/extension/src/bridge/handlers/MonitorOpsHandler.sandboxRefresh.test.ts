import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseMessage, SalesforceOrg } from '@sandforge/shared';
import { OrgSafetyTier } from '@sandforge/shared';
import { MonitorOpsHandler } from './MonitorOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { OrgManager } from '../../core/connection/OrgManager.js';
import { SandboxRefreshDetector } from '../../modules/monitor/SandboxRefreshDetector.js';
import type { DetectedSandboxRefresh } from '../../modules/monitor/SandboxRefreshDetector.js';

const mockGetJsforceConnection = vi.hoisted(() => vi.fn());
const mockQueryAll = vi.hoisted(() => vi.fn());
const mockQueryAllBounded = vi.hoisted(() => vi.fn());

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: mockGetJsforceConnection,
}));

vi.mock('../../core/common/soqlQueryHelper.js', () => ({
  queryAll: mockQueryAll,
  queryAllBounded: mockQueryAllBounded,
}));

vi.mock('../../core/common/sforceLimitParser.js', () => ({
  checkApiLimits: vi.fn(),
}));

/** The org id the sandbox was registered with, and the one it answers with after a refresh. */
const REGISTERED_ORG_ID = '00DXX00000AbCdE2A1';
const REFRESHED_ORG_ID = '00Dxx00000FgHiJ3B2';

/**
 * The Organization row in the shape a sandbox answers with. Its CreatedDate
 * is the production org's: two sandboxes of one production org were read
 * answering the same instant to the second, so it stays the same across a
 * refresh, and only the Id tells the new org from the old one.
 */
const ORGANIZATION_ROW = {
  attributes: { type: 'Organization', url: `/services/data/v62.0/sobjects/Organization/x` },
  Name: 'Acme',
  OrganizationType: 'Enterprise Edition',
  IsSandbox: true,
  NamespacePrefix: null,
  CreatedDate: '2019-03-14T09:26:53.000+0000',
};

const UNSUPPORTED = new Error("sObject type 'SandboxProcess' is not supported.");

function sandbox(): SalesforceOrg {
  return {
    id: REGISTERED_ORG_ID,
    alias: 'UAT',
    username: 'admin@acme.test.uat',
    instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
    orgId: REGISTERED_ORG_ID,
    orgType: 'Sandbox',
    authMethod: 'sfdx_import',
    safetyTier: OrgSafetyTier.MEDIUM,
    appearance: { color: '#4a9eff', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '62.0', edition: 'Enterprise Edition', features: [] },
    status: 'connected',
    lastConnected: '2026-09-01T08:00:00.000Z',
    tags: [],
  };
}

/**
 * Answer every SOQL the handler sends with the columns it names, from the
 * org as it is now: `Organization` from `organization`, SandboxProcess
 * refused as a sandbox refuses it, anything else empty.
 */
function orgAnswers(organization: Record<string, unknown>): void {
  // The bounded lists (sessions, error logs, deployments, SandboxProcess) go
  // through queryAllBounded; a sandbox refuses SandboxProcess there too.
  mockQueryAllBounded.mockImplementation((_conn: unknown, soql: string) =>
    /FROM SandboxProcess/.test(soql)
      ? Promise.reject(UNSUPPORTED)
      : Promise.resolve({ records: [], truncated: false }),
  );
  mockQueryAll.mockImplementation((_conn: unknown, soql: string) => {
    if (/FROM SandboxProcess/.test(soql)) return Promise.reject(UNSUPPORTED);
    if (!/FROM Organization/.test(soql)) return Promise.resolve([]);
    const columns = (/SELECT (.+?) FROM/.exec(soql)?.[1] ?? '').split(',').map((c) => c.trim());
    return Promise.resolve([
      {
        attributes: organization.attributes,
        ...Object.fromEntries(columns.map((c) => [c, organization[c]])),
      },
    ]);
  });
}

describe('MonitorOpsHandler — sandbox refresh detection', () => {
  let configStore: ConfigStore;
  let orgManager: OrgManager;
  let detector: SandboxRefreshDetector;
  let deps: HandlerDeps;
  let handler: MonitorOpsHandler;
  let heard: DetectedSandboxRefresh[];

  beforeEach(() => {
    mockGetJsforceConnection.mockReset();
    mockQueryAll.mockReset();
    mockQueryAllBounded.mockReset();
    configStore = new ConfigStore(new InMemoryConfigStoreBackend());
    configStore.initialize();
    orgManager = new OrgManager();
    orgManager.addOrg(sandbox());
    detector = new SandboxRefreshDetector({ configStore, orgManager });
    heard = [];
    detector.onRefreshDetected((refresh) => heard.push(refresh));
    let idCounter = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager,
      orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
      configStore,
      secretVault: {} as unknown as HandlerDeps['secretVault'],
      authProvider: {} as unknown as HandlerDeps['authProvider'],
      sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
      nextId: () => String(++idCounter),
      sandboxRefreshes: detector,
    };
    mockGetJsforceConnection.mockResolvedValue({
      // `/services/data` lists the API versions the org serves; every other
      // request here is the limits read.
      request: vi.fn().mockImplementation((url: string) =>
        Promise.resolve(
          url === '/services/data'
            ? [{ label: "Winter '26", url: '/services/data/v65.0', version: '65.0' }]
            : {
                DailyApiRequests: { Max: 15000, Remaining: 14000 },
                DataStorageMB: { Max: 1000, Remaining: 900 },
              },
        ),
      ),
      identity: vi.fn().mockResolvedValue({ organization_id: REFRESHED_ORG_ID }),
      query: vi.fn().mockResolvedValue({ totalSize: 3, done: true, records: [] }),
      version: '62.0',
      limitInfo: undefined,
    });
    handler = new MonitorOpsHandler(deps);
  });

  /** The payload of the one message the handler posted for `requestId`. */
  function answerTo(requestId: string): Record<string, unknown> {
    const calls = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls;
    const reply = calls
      .map((call) => call[0] as BaseMessage & { payload: Record<string, unknown> })
      .find((message) => message.correlationId === requestId);
    if (!reply) throw new Error(`no reply to ${requestId}`);
    return reply.payload;
  }

  it('shows on the panel of a sandbox the refresh its Organization row reveals', async () => {
    orgAnswers({ ...ORGANIZATION_ROW, Id: REFRESHED_ORG_ID, InstanceName: 'EU44S' });

    await handler.handle(
      inboundRequest({
        id: 'req-panel',
        type: 'monitor:sandbox-refresh',
        timestamp: Date.now(),
        payload: { orgId: REGISTERED_ORG_ID },
      }),
    );

    const payload = answerTo('req-panel');
    expect(payload.supported).toBe(false);
    expect(payload.detected).toEqual([
      expect.objectContaining({
        orgId: REGISTERED_ORG_ID,
        evidence: 'monitor',
        previousOrganizationId: '00DXX00000AbCdE',
        organizationId: '00Dxx00000FgHiJ',
        instanceName: 'EU44S',
      }),
    ]);
    expect(heard).toHaveLength(1);
  });

  it('shows no refresh for a sandbox that still answers as the org it was registered with', async () => {
    orgAnswers({ ...ORGANIZATION_ROW, Id: REGISTERED_ORG_ID, InstanceName: 'EU42S' });

    await handler.handle(
      inboundRequest({
        id: 'req-panel-same',
        type: 'monitor:sandbox-refresh',
        timestamp: Date.now(),
        payload: { orgId: REGISTERED_ORG_ID },
      }),
    );

    expect(answerTo('req-panel-same').detected).toEqual([]);
    expect(heard).toEqual([]);
  });

  it('still answers the panel when the sandbox cannot say which org it is', async () => {
    mockQueryAll.mockRejectedValue(new Error('INVALID_SESSION_ID: Session expired or invalid'));

    await handler.handle(
      inboundRequest({
        id: 'req-panel-down',
        type: 'monitor:sandbox-refresh',
        timestamp: Date.now(),
        payload: { orgId: REGISTERED_ORG_ID },
      }),
    );

    const calls = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls;
    // The identity check is logged and skipped; the SandboxProcess read that
    // follows is the one that fails the request, on its usual channel.
    expect(calls[0][0].type).toBe('monitor:error');
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('identity check'));
  });

  it("notices on the Monitor's refresh a sandbox that answers as a new org", async () => {
    orgAnswers({ ...ORGANIZATION_ROW, Id: REFRESHED_ORG_ID, InstanceName: 'EU44S' });

    await handler.handle(
      inboundRequest({
        id: 'req-tick',
        type: 'monitor:refresh',
        timestamp: Date.now(),
        payload: { orgId: REGISTERED_ORG_ID },
      }),
    );

    expect(heard).toEqual([
      expect.objectContaining({
        evidence: 'monitor',
        previousOrganizationId: '00DXX00000AbCdE',
        organizationId: '00Dxx00000FgHiJ',
      }),
    ]);
  });

  it('reads the org info and the limits again once told to forget the org', async () => {
    orgAnswers({ ...ORGANIZATION_ROW, Id: REGISTERED_ORG_ID, InstanceName: 'EU42S' });
    const tick = (id: string) =>
      handler.handle(
        inboundRequest({
          id,
          type: 'monitor:refresh',
          timestamp: Date.now(),
          payload: { orgId: REGISTERED_ORG_ID },
        }),
      );
    const organizationReads = (): number =>
      mockQueryAll.mock.calls.filter(([, soql]) => /FROM Organization/.test(String(soql))).length;

    await tick('req-before');
    await tick('req-cached');
    expect(organizationReads()).toBe(1);

    handler.forgetOrg(REGISTERED_ORG_ID);
    await tick('req-after');

    expect(organizationReads()).toBe(2);
  });

  it('drops the trend history of the org it forgets, and only that one', async () => {
    orgAnswers({ ...ORGANIZATION_ROW, Id: REGISTERED_ORG_ID, InstanceName: 'EU42S' });
    await handler.handle(
      inboundRequest({
        id: 'req-trend',
        type: 'monitor:refresh',
        timestamp: Date.now(),
        payload: { orgId: REGISTERED_ORG_ID },
      }),
    );
    configStore.set('trend:other-org', [{ orgId: 'other-org' }], 'trends');
    const trendKeys = (): string[] => Object.keys(configStore.getByCategory('trends')).sort();
    expect(trendKeys()).toEqual([`trend:${REGISTERED_ORG_ID}`, 'trend:other-org']);

    handler.forgetOrg(REGISTERED_ORG_ID);

    expect(trendKeys()).toEqual(['trend:other-org']);
  });
});
