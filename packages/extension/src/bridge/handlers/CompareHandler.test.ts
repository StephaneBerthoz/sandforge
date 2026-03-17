import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CompareHandler } from './CompareHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import type { BaseMessage } from '@sandforge/shared';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));
vi.mock('../../modules/compare/DiffEngine.js', () => ({
  DiffEngine: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../../modules/compare/MetadataCompare.js', () => ({
  MetadataCompare: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../../modules/compare/ConfigCompare.js', () => ({
  ConfigCompare: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../../modules/compare/PermissionCompare.js', () => ({
  PermissionCompare: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../../modules/compare/DataCompare.js', () => ({
  DataCompare: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../../modules/compare/CompareOrchestrator.js', () => ({
  CompareOrchestrator: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({ diffs: [], summary: {} }),
  })),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

const mockGetConn = vi.mocked(getJsforceConnection);

/**
 * Creates minimal mock deps for CompareHandler tests.
 */
function createMockDeps(): HandlerDeps {
  let idCounter = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: { getOrg: vi.fn() } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: {
      get: vi.fn(),
      set: vi.fn(),
    } as unknown as HandlerDeps['configStore'],
    secretVault: {} as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    nextId: () => String(++idCounter),
  };
}

describe('CompareHandler', () => {
  let handler: CompareHandler;
  let deps: HandlerDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
    handler = new CompareHandler(deps);
  });

  it('returns false for unhandled message types', async () => {
    const msg: BaseMessage = { id: '1', type: 'unknown:type', timestamp: Date.now() };
    const result = await handler.handle(msg);
    expect(result).toBe(false);
  });

  it('handles compare:execute with response type compare:execute:response and correlationId', async () => {
    mockGetConn.mockResolvedValue({
      metadata: { list: vi.fn().mockResolvedValue([]) },
      request: vi.fn().mockResolvedValue({}),
      query: vi.fn().mockResolvedValue({ records: [], totalSize: 0 }),
      limitInfo: undefined,
    } as never);

    const msg: BaseMessage & { payload: { sourceOrgId: string; targetOrgId: string; types: string[] } } = {
      id: 'req-cmp-1',
      type: 'compare:execute',
      timestamp: Date.now(),
      payload: { sourceOrgId: 'src', targetOrgId: 'tgt', types: ['ApexClass'] },
    };

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & { correlationId?: string };
    expect(response.type).toBe('compare:execute:response');
    expect(response.correlationId).toBe('req-cmp-1');
  });

  it('handles compare:start as legacy alias', async () => {
    mockGetConn.mockResolvedValue({
      metadata: { list: vi.fn().mockResolvedValue([]) },
      request: vi.fn().mockResolvedValue({}),
      query: vi.fn().mockResolvedValue({ records: [], totalSize: 0 }),
      limitInfo: undefined,
    } as never);

    const msg: BaseMessage & { payload: { sourceOrgId: string; targetOrgId: string; types: string[] } } = {
      id: 'req-cmp-legacy',
      type: 'compare:start',
      timestamp: Date.now(),
      payload: { sourceOrgId: 'src', targetOrgId: 'tgt', types: ['ApexClass'] },
    };

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    const response = postToWebview.mock.calls[0][0] as BaseMessage & { correlationId?: string };
    expect(response.type).toBe('compare:execute:response');
    expect(response.correlationId).toBe('req-cmp-legacy');
  });

  it('error path sends typed error response', async () => {
    mockGetConn.mockRejectedValue(new Error('connection failed'));

    const msg: BaseMessage & { payload: { sourceOrgId: string; targetOrgId: string; types: string[] } } = {
      id: 'req-cmp-err',
      type: 'compare:execute',
      timestamp: Date.now(),
      payload: { sourceOrgId: 'src', targetOrgId: 'tgt', types: ['ApexClass'] },
    };

    await handler.handle(msg);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & { payload: { message: string } };
    expect(response.type).toBe('compare:error');
    expect(response.payload.message).toBe('connection failed');
  });

  it('handles compare:permissions with response type and correlationId', async () => {
    mockGetConn.mockResolvedValue({
      query: vi.fn().mockResolvedValue({ records: [], totalSize: 0, done: true }),
      limitInfo: undefined,
    } as never);

    const msg: BaseMessage & { payload: { sourceOrgId: string; targetOrgId: string } } = {
      id: 'req-cmp-perm',
      type: 'compare:permissions',
      timestamp: Date.now(),
      payload: { sourceOrgId: 'src', targetOrgId: 'tgt' },
    };

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & { correlationId?: string; payload: { permissions: Record<string, unknown> } };
    expect(response.type).toBe('compare:permissions:response');
    expect(response.correlationId).toBe('req-cmp-perm');
    expect(response.payload.permissions).toBeDefined();
  });

  it('handles compare:snapshots with response type and correlationId', async () => {
    mockGetConn.mockResolvedValue({
      describeGlobal: vi.fn().mockResolvedValue({
        sobjects: [
          { name: 'Account', custom: false, label: 'Account', queryable: true },
          { name: 'My_Custom__c', custom: true, label: 'My Custom', queryable: true },
        ],
      }),
      limitInfo: undefined,
    } as never);

    const msg: BaseMessage & { payload: { sourceOrgId: string; targetOrgId: string } } = {
      id: 'req-cmp-snap',
      type: 'compare:snapshots',
      timestamp: Date.now(),
      payload: { sourceOrgId: 'src', targetOrgId: 'tgt' },
    };

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & { correlationId?: string; payload: { snapshot: { source: Record<string, unknown>; target: Record<string, unknown>; diff: Record<string, unknown> } } };
    expect(response.type).toBe('compare:snapshots:response');
    expect(response.correlationId).toBe('req-cmp-snap');
    expect(response.payload.snapshot.source).toBeDefined();
    expect(response.payload.snapshot.target).toBeDefined();
    expect(response.payload.snapshot.diff).toBeDefined();
  });

  it('handles compare:drift with response type and correlationId', async () => {
    mockGetConn.mockResolvedValue({
      query: vi.fn().mockResolvedValue({
        records: [{ Name: 'TestOrg', LanguageLocaleKey: 'en_US', DefaultLocaleSidKey: 'en_US', TimeZoneSidKey: 'America/Los_Angeles', FiscalYearStartMonth: '1' }],
        totalSize: 1,
        done: true,
      }),
      limitInfo: undefined,
    } as never);

    const msg: BaseMessage & { payload: { sourceOrgId: string; targetOrgId: string } } = {
      id: 'req-cmp-drift',
      type: 'compare:drift',
      timestamp: Date.now(),
      payload: { sourceOrgId: 'src', targetOrgId: 'tgt' },
    };

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & { correlationId?: string; payload: { drift: { items: unknown[]; driftCount: number; matchCount: number } } };
    expect(response.type).toBe('compare:drift:response');
    expect(response.correlationId).toBe('req-cmp-drift');
    expect(response.payload.drift.items).toBeDefined();
    expect(typeof response.payload.drift.driftCount).toBe('number');
    expect(typeof response.payload.drift.matchCount).toBe('number');
  });

  it('compare:permissions error path sends typed error', async () => {
    mockGetConn.mockRejectedValue(new Error('perm connection failed'));

    const msg: BaseMessage & { payload: { sourceOrgId: string; targetOrgId: string } } = {
      id: 'req-cmp-perm-err',
      type: 'compare:permissions',
      timestamp: Date.now(),
      payload: { sourceOrgId: 'src', targetOrgId: 'tgt' },
    };

    await handler.handle(msg);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & { payload: { message: string } };
    expect(response.type).toBe('compare:error');
    expect(response.payload.message).toBe('perm connection failed');
  });
});
