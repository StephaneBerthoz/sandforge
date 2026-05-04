import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QuickSyncHandler } from './QuickSyncHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import type { BaseMessage } from '@sandforge/shared';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

const mockGetConn = vi.mocked(getJsforceConnection);

function createMockDeps(): HandlerDeps {
  let idCounter = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn(), dispatch: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: { getOrg: vi.fn() } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: { get: vi.fn() } as unknown as HandlerDeps['configStore'],
    secretVault: {} as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    nextId: () => String(++idCounter),
  };
}

describe('QuickSyncHandler', () => {
  let handler: QuickSyncHandler;
  let deps: HandlerDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
    handler = new QuickSyncHandler(deps);
  });

  it('returns false for unhandled message types', async () => {
    const msg: BaseMessage = { id: '1', type: 'unknown:type', timestamp: Date.now() };
    const result = await handler.handle(msg);
    expect(result).toBe(false);
  });

  it('handles quicksync:suggest-objects and returns suggestions', async () => {
    mockGetConn.mockResolvedValue({
      describeGlobal: vi.fn().mockResolvedValue({
        sobjects: [
          { name: 'Account', createable: true, queryable: true },
          { name: 'Contact', createable: true, queryable: true },
          { name: 'Lead', createable: true, queryable: true },
        ],
      }),
      limitInfo: undefined,
    } as never);

    const msg: BaseMessage & { payload: { orgId: string; alreadySelected: string[] } } = {
      id: 'req-suggest',
      type: 'quicksync:suggest-objects',
      timestamp: Date.now(),
      payload: { orgId: 'org-1', alreadySelected: ['Account'] },
    };

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalled();

    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: {
        suggestions: Array<{
          objectApiName: string;
          isAvailable: boolean;
          isAlreadySelected: boolean;
        }>;
      };
    };
    expect(response.type).toBe('quicksync:suggest-objects:response');
    expect(response.correlationId).toBe('req-suggest');
    expect(response.payload.suggestions).toHaveLength(5);

    const accountSugg = response.payload.suggestions.find((s) => s.objectApiName === 'Account');
    expect(accountSugg?.isAvailable).toBe(true);
    expect(accountSugg?.isAlreadySelected).toBe(true);
  });

  it('handles quicksync:preview and returns preview data', async () => {
    mockGetConn.mockResolvedValue({
      query: vi.fn().mockResolvedValue({ totalSize: 250 }),
      limitInfo: undefined,
    } as never);

    const msg: BaseMessage & {
      payload: { sourceOrgId: string; selectedObjects: string[]; parentObjects: string[] };
    } = {
      id: 'req-preview',
      type: 'quicksync:preview',
      timestamp: Date.now(),
      payload: {
        sourceOrgId: 'org-src',
        selectedObjects: ['Account'],
        parentObjects: [],
      },
    };

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: {
        preview: {
          totalRecords: number;
          totalApiCalls: number;
          objects: Array<{ objectApiName: string }>;
        };
      };
    };
    expect(response.type).toBe('quicksync:preview:response');
    expect(response.payload.preview.totalRecords).toBe(250);
    expect(response.payload.preview.totalApiCalls).toBe(2); // ceil(250/200)
    expect(response.payload.preview.objects).toHaveLength(1);
    expect(response.payload.preview.objects[0].objectApiName).toBe('Account');
  });

  it('handles quicksync:execute with valid config and returns sync config', async () => {
    const mockDescribe = vi.fn().mockResolvedValue({
      fields: [
        { name: 'Name', label: 'Name', type: 'string', createable: true },
        { name: 'Industry', label: 'Industry', type: 'picklist', createable: true },
      ],
    });

    mockGetConn.mockResolvedValue({
      describe: mockDescribe,
      limitInfo: undefined,
    } as never);

    const msg: BaseMessage & {
      payload: {
        config: {
          sourceOrgId: string;
          targetOrgId: string;
          selectedObjects: string[];
          parentObjects: string[];
        };
      };
    } = {
      id: 'req-execute',
      type: 'quicksync:execute',
      timestamp: Date.now(),
      payload: {
        config: {
          sourceOrgId: 'org-src',
          targetOrgId: 'org-tgt',
          selectedObjects: ['Account'],
          parentObjects: [],
        },
      },
    };

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    // First call is notification, second is the response
    const calls = postToWebview.mock.calls;
    const executeResponse = calls.find(
      (c) => (c[0] as BaseMessage).type === 'quicksync:execute:response',
    );
    expect(executeResponse).toBeDefined();

    const responseMsg = executeResponse![0] as BaseMessage & {
      payload: { syncConfig: Record<string, unknown>; objectCount: number };
    };
    expect(responseMsg.payload.objectCount).toBe(1);
    const syncConfig = responseMsg.payload.syncConfig as {
      direction: string;
      mode: string;
      conflictStrategy: string;
    };
    expect(syncConfig.direction).toBe('source_to_target');
    expect(syncConfig.mode).toBe('full');
    expect(syncConfig.conflictStrategy).toBe('source_wins');
  });

  it('handles quicksync:execute with invalid config and sends error', async () => {
    const msg: BaseMessage & {
      payload: { config: { sourceOrgId: string; targetOrgId: string; selectedObjects: never[] } };
    } = {
      id: 'req-execute-invalid',
      type: 'quicksync:execute',
      timestamp: Date.now(),
      payload: {
        config: {
          sourceOrgId: 'org-src',
          targetOrgId: 'org-tgt',
          selectedObjects: [],
        },
      },
    };

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    const errorResponse = postToWebview.mock.calls.find(
      (c) => (c[0] as BaseMessage).type === 'quicksync:error',
    );
    expect(errorResponse).toBeDefined();
  });

  it('handles quicksync:detect-relationships and returns suggestions', async () => {
    mockGetConn.mockResolvedValue({
      describe: vi.fn().mockResolvedValue({
        fields: [
          {
            name: 'AccountId',
            type: 'reference',
            referenceTo: ['Account'],
            relationshipName: 'Account',
          },
          { name: 'Name', type: 'string', referenceTo: [], relationshipName: null },
        ],
      }),
      limitInfo: undefined,
    } as never);

    const msg: BaseMessage & {
      payload: {
        orgId: string;
        objectApiName: string;
        alreadySelected: string[];
        availableObjects: string[];
      };
    } = {
      id: 'req-detect',
      type: 'quicksync:detect-relationships',
      timestamp: Date.now(),
      payload: {
        orgId: 'org-1',
        objectApiName: 'Opportunity',
        alreadySelected: [],
        availableObjects: ['Account', 'Contact'],
      },
    };

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { suggestions: Array<{ parentObject: string; lookupField: string }> };
    };
    expect(response.type).toBe('quicksync:detect-relationships:response');
    expect(response.payload.suggestions).toHaveLength(1);
    expect(response.payload.suggestions[0].parentObject).toBe('Account');
  });
});
