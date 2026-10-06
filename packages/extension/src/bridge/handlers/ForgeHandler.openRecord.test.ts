import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type * as vscode from 'vscode';
import type { BaseMessage, ForgeExecutionResult } from '@sandforge/shared';
import { ForgeHandler } from './ForgeHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { ExternalBrowserAdapter } from '../../adapters/browser/ExternalBrowserAdapter.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const mockGetJsforceConnection = vi.fn();
vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: (...args: unknown[]) => mockGetJsforceConnection(...args),
}));

/*
 * The results of a run open the records it created in the org it wrote to.
 * The page names the run and the record; the extension takes the object and
 * the org from the run's entry in its history and builds the address itself.
 */

/** A run of the history: an account and a contact created, an account it linked to. */
function pastRun(overrides: Partial<ForgeExecutionResult> = {}): ForgeExecutionResult {
  return {
    forgeId: 'forge-run',
    status: 'success',
    graph: {
      nodes: [],
      edges: [],
      totalRecords: 0,
      estimatedSizeMB: 0,
      estimatedDurationSeconds: 0,
    },
    duration: 1000,
    timestamp: '2026-10-01T08:00:00.000Z',
    idRemapCount: 3,
    idRemapTable: {
      '001000000000001AAA': '001000000000101AAA',
      '003000000000001AAA': '003000000000101AAA',
      '001000000000002AAA': '001000000000102AAA',
    },
    idRemapExisting: ['001000000000002AAA'],
    idRemapCreated: [
      { objectApiName: 'Account', sourceIds: ['001000000000001AAA'] },
      { objectApiName: 'Contact', sourceIds: ['003000000000001AAA'] },
    ],
    createdCount: 2,
    targetOrgId: 'tgt-org',
    ...overrides,
  };
}

describe('forge:open-record', () => {
  let deps: HandlerDeps;
  let data: Map<string, unknown>;
  let openExternal: Mock<(target: vscode.Uri) => Thenable<boolean>>;
  let handler: ForgeHandler;
  let instanceUrl: string | undefined;

  function request(payload: Record<string, unknown>): InboundRequest {
    return inboundRequest({
      id: 'wv-open',
      type: 'forge:open-record',
      timestamp: Date.now(),
      payload,
    } as BaseMessage);
  }

  function posted(): Array<BaseMessage & { payload: Record<string, unknown> }> {
    return vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map((call) => call[0] as BaseMessage & { payload: Record<string, unknown> });
  }

  /** The one refusal posted, and that no page was opened. */
  function refusedWith(code: string): string {
    expect(openExternal).not.toHaveBeenCalled();
    expect(posted()).toHaveLength(1);
    expect(posted()[0]).toMatchObject({
      type: 'forge:open-record:error',
      correlationId: 'wv-open',
      payload: { code },
    });
    return String(posted()[0].payload.message);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    data = new Map([['forge:history', [pastRun()]]]);
    instanceUrl = 'https://acme.my.salesforce.com';
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn((orgId: string) =>
          orgId === 'tgt-org' && instanceUrl !== undefined
            ? { id: 'tgt-org', alias: 'Target', instanceUrl }
            : undefined,
        ),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
      configStore: {
        get: vi.fn((key: string) => data.get(key)),
        set: vi.fn(),
      } as unknown as HandlerDeps['configStore'],
      secretVault: {} as unknown as HandlerDeps['secretVault'],
      authProvider: {} as unknown as HandlerDeps['authProvider'],
      sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
      nextId: () => 'ext-1',
    };
    openExternal = vi.fn<(target: vscode.Uri) => Thenable<boolean>>().mockResolvedValue(true);
    handler = new ForgeHandler(
      deps,
      new ExternalBrowserAdapter({
        openExternal,
        parseUri: (value: string) => ({ toString: () => value }) as unknown as vscode.Uri,
      }),
    );
  });

  it("opens the record's page in the org the run wrote to, of the object the run recorded", async () => {
    expect(
      await handler.handle(request({ forgeId: 'forge-run', recordId: '003000000000101AAA' })),
    ).toBe(true);

    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(String(openExternal.mock.calls[0][0])).toBe(
      'https://acme.my.salesforce.com/lightning/r/Contact/003000000000101AAA/view',
    );
    expect(posted()).toEqual([
      expect.objectContaining({
        type: 'forge:open-record:response',
        correlationId: 'wv-open',
        payload: { status: 'opened' },
      }),
    ]);
    // A navigation: no connection is opened, nothing is read from the org.
    expect(mockGetJsforceConnection).not.toHaveBeenCalled();
  });

  it('opens it by the id the history holds, whichever length the page wrote it in', async () => {
    await handler.handle(request({ forgeId: 'forge-run', recordId: '001000000000101' }));

    expect(String(openExternal.mock.calls[0][0])).toBe(
      'https://acme.my.salesforce.com/lightning/r/Account/001000000000101AAA/view',
    );
  });

  it('answers status error when VS Code does not open the page', async () => {
    openExternal.mockResolvedValue(false);

    await handler.handle(request({ forgeId: 'forge-run', recordId: '001000000000101AAA' }));

    expect(posted()).toHaveLength(1);
    expect(posted()[0]).toMatchObject({
      type: 'forge:open-record:response',
      payload: { status: 'error' },
    });
  });

  it('refuses a record the run linked to rather than created', async () => {
    await handler.handle(request({ forgeId: 'forge-run', recordId: '001000000000102AAA' }));
    expect(refusedWith('NOT_CREATED')).toContain('not one this run created');
  });

  it('refuses any other id, however it is shaped', async () => {
    await handler.handle(request({ forgeId: 'forge-run', recordId: '001000000000999AAA' }));
    refusedWith('NOT_CREATED');
  });

  // The page names a run and a record, never an address.
  it.each([
    [
      'an address',
      { forgeId: 'forge-run', recordId: '001000000000101AAA', url: 'https://x.example' },
    ],
    ['an object', { forgeId: 'forge-run', recordId: '001000000000101AAA', objectApiName: 'User' }],
    ['a record id with a path', { forgeId: 'forge-run', recordId: '001000000000101/../../x' }],
  ])('refuses a payload carrying %s, and opens nothing', async (_label, payload) => {
    await handler.handle(request(payload));

    expect(openExternal).not.toHaveBeenCalled();
    expect(deps.orgManager.getOrg).not.toHaveBeenCalled();
    expect(posted()).toHaveLength(1);
    expect(posted()[0]).toMatchObject({
      type: 'forge:open-record:error',
      payload: { code: 'INVALID_PAYLOAD' },
    });
  });

  it('refuses a run the history no longer holds', async () => {
    await handler.handle(request({ forgeId: 'forge-gone', recordId: '001000000000101AAA' }));
    refusedWith('NOT_FOUND');
  });

  it('refuses a run recorded before the history kept the org it wrote to', async () => {
    data.set('forge:history', [pastRun({ targetOrgId: undefined })]);
    await handler.handle(request({ forgeId: 'forge-run', recordId: '001000000000101AAA' }));
    refusedWith('NOT_RECORDED');
  });

  it('refuses when the org the run wrote to is no longer registered', async () => {
    instanceUrl = undefined;
    await handler.handle(request({ forgeId: 'forge-run', recordId: '001000000000101AAA' }));
    refusedWith('ORG_NOT_FOUND');
  });

  it('refuses an instance URL the HTTPS gate rejects', async () => {
    instanceUrl = 'javascript:alert(document.cookie)';
    await handler.handle(request({ forgeId: 'forge-run', recordId: '001000000000101AAA' }));
    expect(refusedWith('INVALID_INSTANCE_URL')).toContain('javascript:');
  });
});
