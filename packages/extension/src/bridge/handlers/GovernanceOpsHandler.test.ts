import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GovernanceOpsHandler } from './GovernanceOpsHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import type { BaseMessage } from '@sandforge/shared';
import type { AlertEngine } from '../../modules/monitor/AlertEngine.js';
import { inboundRequest } from '../../test/mockFactories.js';

/**
 * Hoisted mocks -- available before module evaluation.
 */
const mockGetJsforceConnection = vi.hoisted(() => vi.fn());

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: mockGetJsforceConnection,
}));

const FAKE_LIMITS: Record<string, { Max: number; Remaining: number }> = {
  DailyApiRequests: { Max: 15000, Remaining: 14000 },
  DataStorageMB: { Max: 100, Remaining: 90 },
  DailyBulkApiRequests: { Max: 10000, Remaining: 9500 },
};

/** Creates minimal mock deps for GovernanceOpsHandler tests. */
function createMockDeps(): HandlerDeps {
  let idCounter = 0;
  const store = new Map<string, string>();

  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: { getOrg: vi.fn() } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: {
      get: vi.fn((key: string) => {
        const raw = store.get(key);
        return raw ? JSON.parse(raw) : undefined;
      }),
      set: vi.fn((key: string, value: unknown) => {
        store.set(key, JSON.stringify(value));
      }),
      delete: vi.fn((key: string) => {
        const existed = store.has(key);
        store.delete(key);
        return existed;
      }),
      getKeysByPrefix: vi.fn((prefix: string) => {
        return [...store.keys()].filter((k) => k.startsWith(prefix));
      }),
      has: vi.fn((key: string) => store.has(key)),
    } as unknown as HandlerDeps['configStore'],
    secretVault: {} as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    nextId: () => String(++idCounter),
  };
}

/** Creates a mock AlertEngine for governance-to-alert pipeline testing. */
function createMockAlertEngine(): AlertEngine {
  return {
    evaluate: vi.fn(),
    addDefinition: vi.fn(),
    removeDefinition: vi.fn(),
    getDefinitions: vi.fn().mockReturnValue([]),
    getActiveAlerts: vi.fn().mockReturnValue([]),
    acknowledgeAlert: vi.fn(),
    resolveAlert: vi.fn(),
    dismissAlert: vi.fn(),
  } as unknown as AlertEngine;
}

/** Creates a valid governance policy for testing. */
function createTestPolicy(id = 'test-policy-1'): Record<string, unknown> {
  return {
    id,
    name: 'Test Policy',
    description: 'A test governance policy',
    rules: [
      {
        id: 'rule-1',
        name: 'API Usage Check',
        description: 'API usage should not exceed 90%',
        category: 'performance',
        condition: {
          metric: 'DailyApiRequests',
          operator: 'gt',
          threshold: 90,
          warningThreshold: 75,
        },
        remediation: 'Reduce API calls',
        enabled: true,
      },
      {
        id: 'rule-2',
        name: 'Storage Check',
        description: 'Storage should not exceed 80%',
        category: 'performance',
        condition: {
          metric: 'DataStorageMB',
          operator: 'gt',
          threshold: 80,
          warningThreshold: 60,
        },
        remediation: 'Archive old records',
        enabled: true,
      },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('GovernanceOpsHandler', () => {
  let handler: GovernanceOpsHandler;
  let deps: HandlerDeps;

  beforeEach(() => {
    mockGetJsforceConnection.mockReset();
    deps = createMockDeps();
    handler = new GovernanceOpsHandler(deps);
  });

  it('returns false for unhandled message types', async () => {
    const msg: InboundRequest = inboundRequest({
      id: '1',
      type: 'unknown:type',
      timestamp: Date.now(),
    });
    const result = await handler.handle(msg);
    expect(result).toBe(false);
  });

  it('handles governance:policies:list returning empty array initially', async () => {
    const msg: InboundRequest = inboundRequest({
      id: 'req-1',
      type: 'governance:policies:list',
      timestamp: Date.now(),
    });
    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { policies: unknown[] };
      correlationId: string;
    };
    expect(response.type).toBe('governance:policies:result');
    expect(response.correlationId).toBe('req-1');
    expect(response.payload.policies).toEqual([]);
  });

  it('handles governance:policy:save + governance:policy:get round-trip', async () => {
    const policy = createTestPolicy();
    const saveMsg = inboundRequest({
      id: 'req-save',
      type: 'governance:policy:save',
      timestamp: Date.now(),
      payload: { policy },
    } as BaseMessage & { payload: { policy: unknown } });

    await handler.handle(saveMsg);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    const saveResponse = postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { success: boolean };
    };
    expect(saveResponse.type).toBe('governance:policy:save:response');
    expect(saveResponse.payload.success).toBe(true);

    postToWebview.mockClear();

    const getMsg = inboundRequest({
      id: 'req-get',
      type: 'governance:policy:get',
      timestamp: Date.now(),
      payload: { policyId: 'test-policy-1' },
    } as BaseMessage & { payload: { policyId: string } });

    await handler.handle(getMsg);
    const getResponse = postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { policy: { id: string; name: string } | null };
    };
    expect(getResponse.type).toBe('governance:policy:result');
    expect(getResponse.payload.policy).not.toBeNull();
    expect(getResponse.payload.policy?.id).toBe('test-policy-1');
    expect(getResponse.payload.policy?.name).toBe('Test Policy');
  });

  it('handles governance:policies:list returns populated array after save', async () => {
    const policy = createTestPolicy();
    const saveMsg = inboundRequest({
      id: 'req-save-2',
      type: 'governance:policy:save',
      timestamp: Date.now(),
      payload: { policy },
    } as BaseMessage & { payload: { policy: unknown } });
    await handler.handle(saveMsg);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    postToWebview.mockClear();

    const listMsg: InboundRequest = inboundRequest({
      id: 'req-list',
      type: 'governance:policies:list',
      timestamp: Date.now(),
    });
    await handler.handle(listMsg);

    const listResponse = postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { policies: Array<{ id: string; ruleCount: number }> };
    };
    expect(listResponse.payload.policies).toHaveLength(1);
    expect(listResponse.payload.policies[0].id).toBe('test-policy-1');
    expect(listResponse.payload.policies[0].ruleCount).toBe(2);
  });

  it('handles governance:policy:delete returns success', async () => {
    const policy = createTestPolicy();
    await handler.handle(
      inboundRequest({
        id: 'req-s',
        type: 'governance:policy:save',
        timestamp: Date.now(),
        payload: { policy },
      } as BaseMessage & { payload: { policy: unknown } }),
    );

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    postToWebview.mockClear();

    const deleteMsg = inboundRequest({
      id: 'req-del',
      type: 'governance:policy:delete',
      timestamp: Date.now(),
      payload: { policyId: 'test-policy-1' },
    } as BaseMessage & { payload: { policyId: string } });
    await handler.handle(deleteMsg);

    const delResponse = postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { success: boolean };
    };
    expect(delResponse.type).toBe('governance:policy:delete:response');
    expect(delResponse.payload.success).toBe(true);
  });

  it('handles governance:policies:export returns valid JSON', async () => {
    const policy = createTestPolicy();
    await handler.handle(
      inboundRequest({
        id: 'req-s2',
        type: 'governance:policy:save',
        timestamp: Date.now(),
        payload: { policy },
      } as BaseMessage & { payload: { policy: unknown } }),
    );

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    postToWebview.mockClear();

    const exportMsg: InboundRequest = inboundRequest({
      id: 'req-exp',
      type: 'governance:policies:export',
      timestamp: Date.now(),
    });
    await handler.handle(exportMsg);

    const exportResponse = postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { json: string };
    };
    expect(exportResponse.type).toBe('governance:policies:export:response');
    const parsed: unknown = JSON.parse(exportResponse.payload.json);
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as unknown[]).length).toBe(1);
  });

  it('handles governance:policies:import with valid JSON', async () => {
    const policies = [createTestPolicy('import-1'), createTestPolicy('import-2')];
    const json = JSON.stringify(policies);

    const importMsg = inboundRequest({
      id: 'req-imp',
      type: 'governance:policies:import',
      timestamp: Date.now(),
      payload: { json },
    } as BaseMessage & { payload: { json: string } });
    await handler.handle(importMsg);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    const importResponse = postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { success: boolean; count: number };
    };
    expect(importResponse.type).toBe('governance:policies:import:response');
    expect(importResponse.payload.success).toBe(true);
    expect(importResponse.payload.count).toBe(2);
  });

  it('handles governance:policies:import with invalid JSON', async () => {
    const importMsg = inboundRequest({
      id: 'req-imp-bad',
      type: 'governance:policies:import',
      timestamp: Date.now(),
      payload: { json: 'not valid json' },
    } as BaseMessage & { payload: { json: string } });
    await handler.handle(importMsg);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    const errorResponse = postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { message: string };
    };
    expect(errorResponse.type).toBe('governance:error');
  });

  it('handles governance:evaluate with mock connection and returns compliance score', async () => {
    const policy = createTestPolicy();
    await handler.handle(
      inboundRequest({
        id: 'req-s3',
        type: 'governance:policy:save',
        timestamp: Date.now(),
        payload: { policy },
      } as BaseMessage & { payload: { policy: unknown } }),
    );

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    postToWebview.mockClear();

    mockGetJsforceConnection.mockResolvedValue({
      request: vi.fn().mockResolvedValue(FAKE_LIMITS),
    });

    const evalMsg = inboundRequest({
      id: 'req-eval',
      type: 'governance:evaluate',
      timestamp: Date.now(),
      payload: { policyId: 'test-policy-1', orgId: 'org-1' },
    } as BaseMessage & { payload: { policyId: string; orgId: string } });
    await handler.handle(evalMsg);

    const evalResponse = postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: {
        success: boolean;
        result: {
          complianceScore: number;
          ruleResults: Array<{ ruleId: string; status: string }>;
        };
      };
    };
    expect(evalResponse.type).toBe('governance:evaluate:response');
    expect(evalResponse.payload.success).toBe(true);
    expect(typeof evalResponse.payload.result.complianceScore).toBe('number');
    expect(evalResponse.payload.result.ruleResults.length).toBe(2);
  });

  it('feeds failing governance rules into AlertEngine', async () => {
    const mockAlertEngine = createMockAlertEngine();
    const handlerWithAlerts = new GovernanceOpsHandler(deps, mockAlertEngine);

    const failPolicy = {
      id: 'fail-policy',
      name: 'Fail Policy',
      description: 'A policy that will fail',
      rules: [
        {
          id: 'rule-fail',
          name: 'Will Fail',
          description: 'This rule will fail',
          category: 'performance' as const,
          condition: {
            metric: 'DailyApiRequests',
            operator: 'gt' as const,
            threshold: 5,
          },
          remediation: 'Fix it',
          enabled: true,
        },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    await handlerWithAlerts.handle(
      inboundRequest({
        id: 'req-sf',
        type: 'governance:policy:save',
        timestamp: Date.now(),
        payload: { policy: failPolicy },
      } as BaseMessage & { payload: { policy: unknown } }),
    );

    mockGetJsforceConnection.mockResolvedValue({
      request: vi.fn().mockResolvedValue(FAKE_LIMITS),
    });

    await handlerWithAlerts.handle(
      inboundRequest({
        id: 'req-eval-alert',
        type: 'governance:evaluate',
        timestamp: Date.now(),
        payload: { policyId: 'fail-policy', orgId: 'org-1' },
      } as BaseMessage & { payload: { policyId: string; orgId: string } }),
    );

    const alertEvaluate = mockAlertEngine.evaluate as ReturnType<typeof vi.fn>;
    expect(alertEvaluate).toHaveBeenCalledTimes(1);
    expect(alertEvaluate).toHaveBeenCalledWith('governance:rule-fail', expect.any(Number), 'org-1');
  });

  it('handles governance:evaluate returns error for unknown policy', async () => {
    const evalMsg = inboundRequest({
      id: 'req-eval-bad',
      type: 'governance:evaluate',
      timestamp: Date.now(),
      payload: { policyId: 'nonexistent', orgId: 'org-1' },
    } as BaseMessage & { payload: { policyId: string; orgId: string } });
    await handler.handle(evalMsg);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    const errorResponse = postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { message: string; code: string };
    };
    expect(errorResponse.type).toBe('governance:error');
    expect(errorResponse.payload.code).toBe('NOT_FOUND');
  });

  it('handles governance:templates returns default templates', async () => {
    const msg: InboundRequest = inboundRequest({
      id: 'req-tpl',
      type: 'governance:templates',
      timestamp: Date.now(),
    });
    await handler.handle(msg);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: {
        templates: Array<{ id: string; name: string; rules: unknown[] }>;
      };
    };
    expect(response.type).toBe('governance:templates:response');
    expect(response.payload.templates.length).toBeGreaterThanOrEqual(1);
    expect(response.payload.templates[0].rules.length).toBeGreaterThan(0);
  });

  it('skips AlertEngine feed when alertEngine is not provided', async () => {
    const policy = createTestPolicy();
    policy.rules = [
      {
        id: 'rule-fail-2',
        name: 'Will Fail Too',
        description: 'This rule will fail',
        category: 'performance',
        condition: { metric: 'DailyApiRequests', operator: 'gt', threshold: 5 },
        remediation: 'Fix it',
        enabled: true,
      },
    ];

    await handler.handle(
      inboundRequest({
        id: 'req-sf2',
        type: 'governance:policy:save',
        timestamp: Date.now(),
        payload: { policy },
      } as BaseMessage & { payload: { policy: unknown } }),
    );

    mockGetJsforceConnection.mockResolvedValue({
      request: vi.fn().mockResolvedValue(FAKE_LIMITS),
    });

    const result = await handler.handle(
      inboundRequest({
        id: 'req-eval-no-alert',
        type: 'governance:evaluate',
        timestamp: Date.now(),
        payload: { policyId: 'test-policy-1', orgId: 'org-1' },
      } as BaseMessage & { payload: { policyId: string; orgId: string } }),
    );

    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    const lastCall = postToWebview.mock.calls[
      postToWebview.mock.calls.length - 1
    ][0] as BaseMessage & {
      payload: { success: boolean };
    };
    expect(lastCall.payload.success).toBe(true);
  });

  describe('payload validation', () => {
    it('rejects governance:evaluate without orgId (INVALID_PAYLOAD)', async () => {
      const msg = inboundRequest({
        id: 'bad-eval',
        type: 'governance:evaluate',
        timestamp: Date.now(),
        payload: { policyId: 'test-policy-1' },
      } as BaseMessage & { payload: { policyId: string } });

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const errMsg = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { code: string };
      };
      expect(errMsg.type).toBe('governance:error');
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
    });

    it('rejects governance:policy:save with a non-object policy (INVALID_PAYLOAD)', async () => {
      const msg = inboundRequest({
        id: 'bad-save',
        type: 'governance:policy:save',
        timestamp: Date.now(),
        payload: { policy: 'not-an-object' },
      } as BaseMessage & { payload: { policy: unknown } });

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const errMsg = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { code: string };
      };
      expect(errMsg.type).toBe('governance:error');
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
    });

    it('rejects governance:policy:delete without policyId (INVALID_PAYLOAD)', async () => {
      const msg = inboundRequest({
        id: 'bad-delete',
        type: 'governance:policy:delete',
        timestamp: Date.now(),
        payload: {},
      } as BaseMessage & { payload: Record<string, never> });

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const errMsg = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { code: string };
      };
      expect(errMsg.type).toBe('governance:error');
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
    });
  });
});
