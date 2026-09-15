import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIAnalysisHandler } from './AIAnalysisHandler.js';
import type { HandlerDeps, InboundRequest } from '../HandlerTypes.js';
import type { RuleModules } from '../AIHandler.js';
import { inboundRequest } from '../../../test/mockFactories.js';
import { getJsforceConnection } from '../../../core/connection/ConnectionHelper.js';
import { SchemaAdvisor } from '../../../modules/ai/SchemaAdvisor.js';

type OrgConnection = Awaited<ReturnType<typeof getJsforceConnection>>;

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

function createMsg(
  type: string,
  payload: Record<string, unknown> = {},
): InboundRequest & { payload: Record<string, unknown> } {
  return inboundRequest({ id: 'msg-1', type, timestamp: Date.now(), payload });
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

  it('handles ai:anomaly-scan without modules by sending error with correlationId', async () => {
    const result = await handler.handle(
      createMsg('ai:anomaly-scan', { orgId: 'org1', objectName: 'Account' }),
    );
    expect(result).toBe(true);
    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.type).toBe('ai:anomaly-scan:response');
    expect(response.payload.success).toBe(false);
    expect(response.correlationId).toBe('msg-1');
  });

  it('handles ai:anomaly-scan with modules', async () => {
    const mockModules: Partial<RuleModules> = {
      anomalyDetector: {
        detectAnomalies: vi.fn().mockReturnValue({
          anomalies: [
            {
              field: 'Name',
              type: 'null',
              description: 'Many nulls',
              severity: 'medium',
            },
          ],
        }),
      } as unknown as RuleModules['anomalyDetector'],
    };
    handler.setRuleModules(mockModules as RuleModules);

    const result = await handler.handle(
      createMsg('ai:anomaly-scan', {
        orgId: 'org1',
        objectName: 'Account',
        sampleSize: 100,
      }),
    );
    expect(result).toBe(true);
    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.type).toBe('ai:anomaly-scan:response');
    expect(response.payload.success).toBe(true);
    expect(response.correlationId).toBe('msg-1');
  });

  it('handles ai:schema-advice without modules with correlationId', async () => {
    const result = await handler.handle(createMsg('ai:schema-advice', { orgId: 'org1' }));
    expect(result).toBe(true);
    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.type).toBe('ai:schema-advice:response');
    expect(response.payload.success).toBe(false);
    expect(response.correlationId).toBe('msg-1');
  });

  it('handles ai:schema-advice with modules', async () => {
    const mockModules: Partial<RuleModules> = {
      schemaAdvisor: {
        analyzeSchema: vi.fn().mockReturnValue({
          issues: [
            {
              objectName: 'Account',
              severity: 'low',
              description: 'Consider indexing',
            },
          ],
          suggestions: [{ title: 'Add index', description: 'On Name field' }],
        }),
      } as unknown as RuleModules['schemaAdvisor'],
    };
    handler.setRuleModules(mockModules as RuleModules);

    const result = await handler.handle(
      createMsg('ai:schema-advice', {
        orgId: 'org1',
        objectNames: ['Account'],
      }),
    );
    expect(result).toBe(true);
    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.type).toBe('ai:schema-advice:response');
    expect(response.payload.success).toBe(true);
    expect(response.correlationId).toBe('msg-1');
  });

  it('samples the default 500 records although FIELDS(ALL) is refused above 200 rows', async () => {
    // The org as jsforce reports it: the refusal carries its code in
    // `errorCode`, and its message repeats neither the code nor the query.
    const query = vi.fn(async (soql: string) => {
      const limit = Number(/\bLIMIT\s+(\d+)/i.exec(soql)?.[1] ?? Infinity);
      if (soql.includes('FIELDS(') && limit > 200) {
        const refusal = new Error('The SOQL FIELDS function must have a LIMIT of at most 200');
        refusal.name = 'MALFORMED_QUERY';
        throw Object.assign(refusal, { errorCode: 'MALFORMED_QUERY' });
      }
      return {
        done: true,
        totalSize: 2,
        records: [
          { Id: '001A', Name: 'Acme' },
          { Id: '001B', Name: 'Globex' },
        ],
      };
    });
    const conn = {
      query,
      queryMore: vi.fn(),
      describe: vi
        .fn()
        .mockResolvedValue({ name: 'Account', fields: [{ name: 'Id' }, { name: 'Name' }] }),
    };
    vi.mocked(getJsforceConnection).mockResolvedValueOnce(conn as unknown as OrgConnection);
    const detectAnomalies = vi.fn().mockReturnValue({ anomalies: [] });
    handler.setRuleModules({ anomalyDetector: { detectAnomalies } } as unknown as RuleModules);

    await handler.handle(createMsg('ai:anomaly-scan', { orgId: 'org1', objectName: 'Account' }));

    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.payload).toEqual({ success: true, anomalies: [] });
    expect(detectAnomalies.mock.calls[0][0].records).toHaveLength(2);
    expect(query.mock.calls.map(([soql]) => soql)).toEqual([
      'SELECT Id, Name FROM Account LIMIT 500',
    ]);
  });

  it('raises no unused-field advice on objects that carry custom fields', async () => {
    const conn = {
      describe: vi.fn().mockResolvedValue({
        name: 'Invoice__c',
        label: 'Invoice',
        custom: true,
        fields: [
          { name: 'Id', label: 'Record ID', type: 'id', custom: false },
          { name: 'Amount__c', label: 'Amount', type: 'currency', custom: true },
          { name: 'Notes__c', label: 'Notes', type: 'textarea', custom: true },
        ],
      }),
    };
    vi.mocked(getJsforceConnection).mockResolvedValueOnce(conn as unknown as OrgConnection);
    handler.setRuleModules({ schemaAdvisor: new SchemaAdvisor() } as unknown as RuleModules);

    await handler.handle(
      createMsg('ai:schema-advice', { orgId: 'org1', objectNames: ['Invoice__c'] }),
    );

    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.payload.success).toBe(true);
    const { issues, recommendations } = response.payload.advice as {
      issues: Array<{ message: string }>;
      recommendations: Array<{ title: string }>;
    };
    expect(issues.filter((i) => /unused/i.test(i.message))).toEqual([]);
    expect(recommendations.filter((r) => /unused/i.test(r.title))).toEqual([]);
  });

  describe('payload validation', () => {
    it('rejects ai:anomaly-scan with a non-API-name objectName (INVALID_PAYLOAD)', async () => {
      const result = await handler.handle(
        createMsg('ai:anomaly-scan', {
          orgId: 'org1',
          objectName: 'Account WHERE Id != null',
        }),
      );
      expect(result).toBe(true);

      const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(response.type).toBe('ai:error');
      expect(response.payload.code).toBe('INVALID_PAYLOAD');
    });

    it('rejects ai:schema-advice without orgId (INVALID_PAYLOAD)', async () => {
      const result = await handler.handle(createMsg('ai:schema-advice', {}));
      expect(result).toBe(true);

      const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(response.type).toBe('ai:error');
      expect(response.payload.code).toBe('INVALID_PAYLOAD');
    });
  });
});
