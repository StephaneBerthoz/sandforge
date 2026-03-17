import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIAnalysisHandler } from './AIAnalysisHandler.js';
import type { HandlerDeps } from '../HandlerTypes.js';
import type { AIModules } from '../AIHandler.js';
import type { BaseMessage } from '@sandforge/shared';

vi.mock('../../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn().mockResolvedValue({
    query: vi.fn().mockResolvedValue({ records: [{ Id: '001', Name: 'Test' }] }),
    describe: vi.fn().mockResolvedValue({
      name: 'Account',
      label: 'Account',
      custom: false,
      fields: [{ name: 'Id', label: 'Id', type: 'id', custom: false }],
    }),
  }),
}));

function createMockDeps(): HandlerDeps {
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as unknown as HandlerDeps['stateSync'],
    orgManager: {} as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: {} as unknown as HandlerDeps['configStore'],
    secretVault: {} as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    nextId: vi.fn().mockReturnValue('test-id'),
  };
}

function createMsg(type: string, payload: Record<string, unknown> = {}): BaseMessage & { payload: Record<string, unknown> } {
  return { id: 'msg-1', type, timestamp: Date.now(), payload };
}

describe('AIAnalysisHandler', () => {
  let handler: AIAnalysisHandler;
  let deps: HandlerDeps;

  beforeEach(() => {
    deps = createMockDeps();
    handler = new AIAnalysisHandler(deps);
  });

  it('returns false for unrelated message types', async () => {
    const result = await handler.handle(createMsg('ai:chat'));
    expect(result).toBe(false);
  });

  it('handles ai:anomaly-scan without modules by sending error', async () => {
    const result = await handler.handle(createMsg('ai:anomaly-scan', { orgId: 'org1', objectName: 'Account' }));
    expect(result).toBe(true);
    expect(deps.broker.postToWebview).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ai:anomaly-scan:response',
        payload: expect.objectContaining({ success: false }),
      }),
    );
  });

  it('handles ai:anomaly-scan with modules', async () => {
    const mockModules: Partial<AIModules> = {
      anomalyDetector: {
        detectAnomalies: vi.fn().mockReturnValue({
          anomalies: [{ field: 'Name', type: 'null', description: 'Many nulls', severity: 'medium' }],
        }),
      } as unknown as AIModules['anomalyDetector'],
    };
    handler.setAIModules(mockModules as AIModules);

    const result = await handler.handle(createMsg('ai:anomaly-scan', { orgId: 'org1', objectName: 'Account', sampleSize: 100 }));
    expect(result).toBe(true);
    expect(deps.broker.postToWebview).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ai:anomaly-scan:response',
        payload: expect.objectContaining({ success: true }),
      }),
    );
  });

  it('handles ai:suggestions without modules', async () => {
    const result = await handler.handle(createMsg('ai:suggestions', { module: 'seed' }));
    expect(result).toBe(true);
    expect(deps.broker.postToWebview).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ai:suggestions:response',
        payload: expect.objectContaining({ success: false }),
      }),
    );
  });

  it('handles ai:suggestions with modules', async () => {
    const mockModules: Partial<AIModules> = {
      smartSuggestions: {
        suggest: vi.fn().mockResolvedValue([{ title: 'Use Bulk API', description: 'Faster', action: 'enable-bulk' }]),
      } as unknown as AIModules['smartSuggestions'],
    };
    handler.setAIModules(mockModules as AIModules);

    const result = await handler.handle(createMsg('ai:suggestions', { module: 'seed', context: {} }));
    expect(result).toBe(true);
    expect(deps.broker.postToWebview).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ai:suggestions:response',
        payload: expect.objectContaining({ success: true }),
      }),
    );
  });

  it('handles ai:schema-advice without modules', async () => {
    const result = await handler.handle(createMsg('ai:schema-advice', { orgId: 'org1' }));
    expect(result).toBe(true);
    expect(deps.broker.postToWebview).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ai:schema-advice:response',
        payload: expect.objectContaining({ success: false }),
      }),
    );
  });

  it('handles ai:schema-advice with modules', async () => {
    const mockModules: Partial<AIModules> = {
      schemaAdvisor: {
        analyzeSchema: vi.fn().mockReturnValue({
          issues: [{ objectName: 'Account', severity: 'low', description: 'Consider indexing' }],
          suggestions: [{ title: 'Add index', description: 'On Name field' }],
        }),
      } as unknown as AIModules['schemaAdvisor'],
    };
    handler.setAIModules(mockModules as AIModules);

    const result = await handler.handle(createMsg('ai:schema-advice', { orgId: 'org1', objectNames: ['Account'] }));
    expect(result).toBe(true);
    expect(deps.broker.postToWebview).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ai:schema-advice:response',
        payload: expect.objectContaining({ success: true }),
      }),
    );
  });
});
