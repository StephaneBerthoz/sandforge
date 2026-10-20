import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as vscode from 'vscode';
import type { BaseMessage } from '@sandforge/shared';

import { SeedRemovalHandler } from './SeedRemovalHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { ExternalBrowserAdapter } from '../../adapters/browser/ExternalBrowserAdapter.js';
import {
  nodeSeedRunCreations,
  type SeedRunCreations,
} from '../../modules/seed/SeedRunCreations.js';
import { inboundRequest } from '../../test/mockFactories.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const mockGetJsforceConnection = vi.fn();
vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: (...args: unknown[]) => mockGetJsforceConnection(...args),
}));

/*
 * The results of a seed open a record it created, in the org it wrote to. The
 * page names the run and the record; the extension takes the object and the
 * org from what the run kept, and builds the address itself.
 */

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const TARGET = 'org-target';
const ACCOUNT = fakeId('001', 1);
const CONTACT = fakeId('003', 1);

describe('seed:open-record', () => {
  let storage: string;
  let runs: SeedRunCreations;
  let deps: HandlerDeps;
  let handler: SeedRemovalHandler;
  let openExternal: Mock<(target: vscode.Uri) => Thenable<boolean>>;
  let instanceUrl: string | undefined;

  function request(payload: Record<string, unknown>): InboundRequest {
    return inboundRequest({
      id: 'wv-open',
      type: 'seed:open-record',
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
      type: 'seed:open-record:error',
      correlationId: 'wv-open',
      payload: { code },
    });
    return String(posted()[0].payload.message);
  }

  afterEach(() => {
    rmSync(storage, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    storage = mkdtempSync(join(tmpdir(), 'sandforge-seed-open-'));
    instanceUrl = 'https://example.my.salesforce.com';
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn((orgId: string) =>
          orgId === TARGET && instanceUrl !== undefined
            ? { id: TARGET, alias: 'Target', instanceUrl }
            : undefined,
        ),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as HandlerDeps['orgRegistry'],
      configStore: {} as HandlerDeps['configStore'],
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      nextId: () => 'ext-1',
    };
    openExternal = vi.fn<(target: vscode.Uri) => Thenable<boolean>>().mockResolvedValue(true);
    runs = nodeSeedRunCreations(storage);
    handler = new SeedRemovalHandler(
      deps,
      new ExternalBrowserAdapter({
        openExternal,
        parseUri: (value: string) => ({ toString: () => value }) as unknown as vscode.Uri,
      }),
    );
    handler.setRunCreations(runs);
    await runs.record({
      runId: 'op-1',
      targetOrgId: TARGET,
      startedAt: '2026-10-01T08:00:00.000Z',
      finishedAt: '2026-10-01T08:01:00.000Z',
      status: 'success',
      objectResults: [
        { objectApiName: 'Account', createdIds: [ACCOUNT] },
        { objectApiName: 'Contact', createdIds: [CONTACT] },
      ],
    });
  });

  it("opens the record's page in the org the run wrote to, of the object the run kept it under", async () => {
    expect(await handler.handle(request({ runId: 'op-1', recordId: CONTACT }))).toBe(true);

    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(String(openExternal.mock.calls[0][0])).toBe(
      `https://example.my.salesforce.com/lightning/r/Contact/${CONTACT}/view`,
    );
    expect(posted()).toEqual([
      expect.objectContaining({
        type: 'seed:open-record:response',
        correlationId: 'wv-open',
        payload: { status: 'opened' },
      }),
    ]);
    // A navigation: no connection is opened, nothing is read from the org.
    expect(mockGetJsforceConnection).not.toHaveBeenCalled();
  });

  it('opens it by the id the run kept, whichever length the page wrote it in', async () => {
    await handler.handle(request({ runId: 'op-1', recordId: ACCOUNT.slice(0, 15) }));

    expect(String(openExternal.mock.calls[0][0])).toBe(
      `https://example.my.salesforce.com/lightning/r/Account/${ACCOUNT}/view`,
    );
  });

  it('answers status error when VS Code does not open the page', async () => {
    openExternal.mockResolvedValue(false);

    await handler.handle(request({ runId: 'op-1', recordId: ACCOUNT }));

    expect(posted()).toHaveLength(1);
    expect(posted()[0]).toMatchObject({
      type: 'seed:open-record:response',
      payload: { status: 'error' },
    });
  });

  it('refuses a record the run did not create', async () => {
    await handler.handle(request({ runId: 'op-1', recordId: fakeId('001', 9) }));
    expect(refusedWith('NOT_CREATED')).toContain('not one this run created');
  });

  it('refuses a run nothing of which is kept', async () => {
    await handler.handle(request({ runId: 'op-gone', recordId: ACCOUNT }));
    refusedWith('NOT_KEPT');
  });

  it('refuses a run whose org is no longer connected', async () => {
    instanceUrl = undefined;
    await handler.handle(request({ runId: 'op-1', recordId: ACCOUNT }));
    refusedWith('ORG_NOT_FOUND');
  });

  it('refuses an org whose instance URL is not HTTPS, and opens nothing', async () => {
    instanceUrl = 'http://example.my.salesforce.com';
    await handler.handle(request({ runId: 'op-1', recordId: ACCOUNT }));
    expect(refusedWith('INVALID_INSTANCE_URL')).toContain('HTTPS');
  });

  // The page names a run and a record, never an address.
  it.each([
    ['an address', { runId: 'op-1', recordId: ACCOUNT, url: 'https://x.example' }],
    ['an object', { runId: 'op-1', recordId: ACCOUNT, objectApiName: 'User' }],
    ['a record id with a path', { runId: 'op-1', recordId: `${ACCOUNT.slice(0, 15)}/../x` }],
  ])('refuses a payload carrying %s, and opens nothing', async (_label, payload) => {
    await handler.handle(request(payload));

    expect(openExternal).not.toHaveBeenCalled();
    expect(deps.orgManager.getOrg).not.toHaveBeenCalled();
    expect(posted()).toHaveLength(1);
    expect(posted()[0]).toMatchObject({
      type: 'seed:open-record:error',
      payload: { code: 'INVALID_PAYLOAD' },
    });
  });
});
