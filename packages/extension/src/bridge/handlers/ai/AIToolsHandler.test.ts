import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIToolsHandler } from './AIToolsHandler.js';
import type { HandlerDeps } from '../HandlerTypes.js';
import type { AIModules } from '../AIHandler.js';
import type { BaseMessage } from '@sandforge/shared';

vi.mock('../../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn().mockResolvedValue({
    describeGlobal: vi.fn().mockResolvedValue({
      sobjects: [{ name: 'Account', label: 'Account' }],
    }),
  }),
}));

function createMockDeps(): HandlerDeps {
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as unknown as HandlerDeps['stateSync'],
    orgManager: {
      getOrg: vi.fn().mockReturnValue({ alias: 'dev', orgType: 'sandbox' }),
    } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: {} as unknown as HandlerDeps['configStore'],
    secretVault: {} as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    nextId: vi.fn().mockReturnValue('test-id'),
  };
}

function createMsg(
  type: string,
  payload: Record<string, unknown> = {},
): BaseMessage & { payload: Record<string, unknown> } {
  return { id: 'msg-1', type, timestamp: Date.now(), payload };
}

describe('AIToolsHandler', () => {
  let handler: AIToolsHandler;
  let deps: HandlerDeps;

  beforeEach(() => {
    deps = createMockDeps();
    handler = new AIToolsHandler(deps, () => undefined);
  });

  it('returns false for unrelated message types', async () => {
    const result = await handler.handle(createMsg('ai:chat'));
    expect(result).toBe(false);
  });

  it('handles ai:nl2soql without modules with correlationId', async () => {
    const result = await handler.handle(
      createMsg('ai:nl2soql', { query: 'all accounts', orgId: 'org1' }),
    );
    expect(result).toBe(true);
    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.type).toBe('ai:nl2soql:response');
    expect(response.payload.success).toBe(false);
    expect(response.correlationId).toBe('msg-1');
  });

  it('handles ai:nl2soql with modules with correlationId', async () => {
    const mockModules: Partial<AIModules> = {
      nl2soql: {
        generateSOQL: vi
          .fn()
          .mockResolvedValue({ soql: 'SELECT Id FROM Account', explanation: 'Gets all accounts' }),
      } as unknown as AIModules['nl2soql'],
    };
    handler.setAIModules(mockModules as AIModules);

    const result = await handler.handle(
      createMsg('ai:nl2soql', { query: 'all accounts', orgId: 'org1' }),
    );
    expect(result).toBe(true);
    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.type).toBe('ai:nl2soql:response');
    expect(response.payload.success).toBe(true);
    expect(response.correlationId).toBe('msg-1');
  });

  it('handles ai:resolve-error without modules with correlationId', async () => {
    const result = await handler.handle(
      createMsg('ai:resolve-error', { errorMessage: 'fail', module: 'sync' }),
    );
    expect(result).toBe(true);
    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.type).toBe('ai:resolve-error:response');
    expect(response.payload.success).toBe(false);
    expect(response.correlationId).toBe('msg-1');
  });

  it('handles ai:personas list without modules with correlationId', async () => {
    const result = await handler.handle(createMsg('ai:personas', { action: 'list' }));
    expect(result).toBe(true);
    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.type).toBe('ai:personas:response');
    expect(response.payload.success).toBe(false);
    expect(response.correlationId).toBe('msg-1');
  });

  it('handles ai:personas list with modules with correlationId', async () => {
    const mockModules: Partial<AIModules> = {
      personaManager: {
        getBuiltInPersonas: vi
          .fn()
          .mockReturnValue([{ id: 'admin', name: 'Admin', description: 'Salesforce admin' }]),
        getCustomPersonas: vi.fn().mockReturnValue([]),
      } as unknown as AIModules['personaManager'],
    };
    handler.setAIModules(mockModules as AIModules);

    const result = await handler.handle(createMsg('ai:personas', { action: 'list' }));
    expect(result).toBe(true);
    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.type).toBe('ai:personas:response');
    expect(response.payload.success).toBe(true);
    expect(response.correlationId).toBe('msg-1');
  });

  it('handles ai:generate-pipeline without modules with correlationId', async () => {
    const result = await handler.handle(
      createMsg('ai:generate-pipeline', { description: 'seed accounts', orgIds: ['org1'] }),
    );
    expect(result).toBe(true);
    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.type).toBe('ai:generate-pipeline:response');
    expect(response.payload.success).toBe(false);
    expect(response.correlationId).toBe('msg-1');
  });

  it('handles ai:generate-pipeline with modules with correlationId', async () => {
    const mockModules: Partial<AIModules> = {
      pipelineGenerator: {
        generatePipeline: vi.fn().mockResolvedValue({ steps: [] }),
      } as unknown as AIModules['pipelineGenerator'],
    };
    handler.setAIModules(mockModules as AIModules);

    const result = await handler.handle(
      createMsg('ai:generate-pipeline', { description: 'seed accounts', orgIds: ['org1'] }),
    );
    expect(result).toBe(true);
    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.type).toBe('ai:generate-pipeline:response');
    expect(response.payload.success).toBe(true);
    expect(response.correlationId).toBe('msg-1');
  });

  describe('payload validation', () => {
    it('rejects ai:personas with an unknown action (INVALID_PAYLOAD)', async () => {
      const result = await handler.handle(createMsg('ai:personas', { action: 'delete' }));
      expect(result).toBe(true);

      const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(response.type).toBe('ai:error');
      expect(response.payload.code).toBe('INVALID_PAYLOAD');
    });

    it('rejects ai:nl2soql without orgId (INVALID_PAYLOAD)', async () => {
      const result = await handler.handle(createMsg('ai:nl2soql', { query: 'all accounts' }));
      expect(result).toBe(true);

      const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(response.type).toBe('ai:error');
      expect(response.payload.code).toBe('INVALID_PAYLOAD');
    });
  });
});
