import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIToolsHandler } from './AIToolsHandler.js';
import type { HandlerDeps, InboundRequest } from '../HandlerTypes.js';
import type { AIModules } from '../AIHandler.js';
import { inboundRequest } from '../../../test/mockFactories.js';
import { NL2SOQL } from '../../../modules/ai/NL2SOQL.js';
import { getJsforceConnection } from '../../../core/connection/ConnectionHelper.js';

vi.mock('../../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

const ACCOUNT_DESCRIBE = {
  name: 'Account',
  label: 'Account',
  fields: [
    { name: 'Id', label: 'Account ID', type: 'id' },
    { name: 'Name', label: 'Account Name', type: 'string' },
    { name: 'Industry', label: 'Industry', type: 'picklist' },
  ],
};

const CATALOG = [
  { name: 'Account', label: 'Account', labelPlural: 'Accounts', queryable: true },
  { name: 'Contact', label: 'Contact', labelPlural: 'Contacts', queryable: true },
  { name: 'Opportunity', label: 'Opportunity', labelPlural: 'Opportunities', queryable: true },
  { name: 'AccountFeed', label: 'Account Feed', queryable: false },
];

/** Org double: a global catalog plus one describable object. */
function mockConnection(describe_ = vi.fn().mockResolvedValue(ACCOUNT_DESCRIBE)) {
  return {
    describeGlobal: vi.fn().mockResolvedValue({ sobjects: CATALOG }),
    describe: describe_,
  };
}

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
): InboundRequest & { payload: Record<string, unknown> } {
  return inboundRequest({ id: 'msg-1', type, timestamp: Date.now(), payload });
}

describe('AIToolsHandler', () => {
  let handler: AIToolsHandler;
  let deps: HandlerDeps;

  beforeEach(() => {
    deps = createMockDeps();
    handler = new AIToolsHandler(deps);
    vi.mocked(getJsforceConnection).mockResolvedValue(
      mockConnection() as unknown as Awaited<ReturnType<typeof getJsforceConnection>>,
    );
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
        generateSOQL: vi.fn().mockResolvedValue({
          soql: 'SELECT Id FROM Account',
          explanation: 'Gets all accounts',
        }),
        validateSOQL: vi.fn().mockReturnValue({ valid: true, errors: [], verified: true }),
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

  it('does not claim ai:resolve-error — a failure is resolved where it is raised', async () => {
    const result = await handler.handle(
      createMsg('ai:resolve-error', { errorMessage: 'fail', module: 'sync' }),
    );
    expect(result).toBe(false);
    expect(deps.broker.postToWebview).not.toHaveBeenCalled();
  });

  it('handles ai:generate-pipeline without modules with correlationId', async () => {
    const result = await handler.handle(
      createMsg('ai:generate-pipeline', {
        description: 'seed accounts',
        orgIds: ['org1'],
      }),
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
      createMsg('ai:generate-pipeline', {
        description: 'seed accounts',
        orgIds: ['org1'],
      }),
    );
    expect(result).toBe(true);
    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.type).toBe('ai:generate-pipeline:response');
    expect(response.payload.success).toBe(true);
    expect(response.correlationId).toBe('msg-1');
  });

  describe('nl2soql schema context', () => {
    /** A real NL2SOQL over a scripted model, so prompt and validation are the shipped ones. */
    function realNL2SOQL(soql: string) {
      const provider = vi
        .fn()
        .mockResolvedValue(JSON.stringify({ soql, explanation: 'draft', confidence: 0.9 }));
      handler.setAIModules({ nl2soql: new NL2SOQL(provider) } as unknown as AIModules);
      return provider;
    }

    it('sends the field names of the object the request names', async () => {
      const provider = realNL2SOQL('SELECT Id, Name FROM Account');

      await handler.handle(
        createMsg('ai:nl2soql', { query: 'all accounts with their industry', orgId: 'org1' }),
      );

      const prompt = provider.mock.calls[0][0] as string;
      expect(prompt).toContain('Industry');
      expect(prompt).toContain('Name');
    });

    it('describes only the objects the request names, not the whole org', async () => {
      const describe_ = vi.fn().mockResolvedValue(ACCOUNT_DESCRIBE);
      vi.mocked(getJsforceConnection).mockResolvedValue(
        mockConnection(describe_) as unknown as Awaited<ReturnType<typeof getJsforceConnection>>,
      );
      realNL2SOQL('SELECT Id FROM Account');

      await handler.handle(createMsg('ai:nl2soql', { query: 'list the accounts', orgId: 'org1' }));

      expect(describe_.mock.calls.map((c) => c[0])).toEqual(['Account']);
    });

    it('reports a field the model invented on a described object', async () => {
      realNL2SOQL('SELECT Id, Bogus__c FROM Account');

      await handler.handle(createMsg('ai:nl2soql', { query: 'all accounts', orgId: 'org1' }));

      const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(response.payload.success).toBe(false);
      expect(response.payload.error).toContain('Bogus__c');
      // The draft still reaches the user — it is flagged, not swallowed.
      expect(response.payload.soql).toBe('SELECT Id, Bogus__c FROM Account');
    });

    it('accepts a query whose fields all come from the describe', async () => {
      realNL2SOQL('SELECT Id, Name, Industry FROM Account');

      await handler.handle(createMsg('ai:nl2soql', { query: 'all accounts', orgId: 'org1' }));

      const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(response.payload.success).toBe(true);
      expect(response.payload.error).toBeUndefined();
    });

    it('does not claim a field check when the request names no known object', async () => {
      const describe_ = vi.fn().mockResolvedValue(ACCOUNT_DESCRIBE);
      vi.mocked(getJsforceConnection).mockResolvedValue(
        mockConnection(describe_) as unknown as Awaited<ReturnType<typeof getJsforceConnection>>,
      );
      const provider = realNL2SOQL('SELECT Id, Bogus__c FROM Contact');

      await handler.handle(
        createMsg('ai:nl2soql', { query: 'everything from last week', orgId: 'org1' }),
      );

      expect(describe_).not.toHaveBeenCalled();
      const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(response.payload.success).toBe(true);
      // The fallback catalog is names only, and never offers an object that
      // cannot appear in a FROM clause.
      const prompt = provider.mock.calls[0][0] as string;
      expect(prompt).toContain('Contact (Contact)');
      expect(prompt).not.toContain('AccountFeed');
    });

    it('tells the panel the draft was not checked against the org', async () => {
      realNL2SOQL('SELECT Id, Bogus__c FROM Contact');

      await handler.handle(
        createMsg('ai:nl2soql', { query: 'everything from last week', orgId: 'org1' }),
      );

      const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(response.payload.success).toBe(true);
      expect(response.payload.verified).toBe(false);
    });

    it('tells the panel the draft was checked when the fields came from a describe', async () => {
      realNL2SOQL('SELECT Id, Name FROM Account');

      await handler.handle(createMsg('ai:nl2soql', { query: 'all accounts', orgId: 'org1' }));

      const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(response.payload.success).toBe(true);
      expect(response.payload.verified).toBe(true);
    });

    it('reports an object that exists in no catalog entry', async () => {
      realNL2SOQL('SELECT Id FROM Invented__c');

      await handler.handle(createMsg('ai:nl2soql', { query: 'all accounts', orgId: 'org1' }));

      const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(response.payload.success).toBe(false);
      expect(response.payload.error).toContain('Invented__c');
    });

    it('reuses the cached describe across two requests on the same org', async () => {
      const describe_ = vi.fn().mockResolvedValue(ACCOUNT_DESCRIBE);
      const conn = mockConnection(describe_);
      vi.mocked(getJsforceConnection).mockResolvedValue(
        conn as unknown as Awaited<ReturnType<typeof getJsforceConnection>>,
      );
      realNL2SOQL('SELECT Id FROM Account');

      await handler.handle(createMsg('ai:nl2soql', { query: 'all accounts', orgId: 'org1' }));
      await handler.handle(createMsg('ai:nl2soql', { query: 'accounts again', orgId: 'org1' }));

      expect(describe_).toHaveBeenCalledTimes(1);
      expect(conn.describeGlobal).toHaveBeenCalledTimes(1);
    });
  });

  describe('payload validation', () => {
    it('rejects ai:nl2soql without orgId (INVALID_PAYLOAD)', async () => {
      const result = await handler.handle(createMsg('ai:nl2soql', { query: 'all accounts' }));
      expect(result).toBe(true);

      const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(response.type).toBe('ai:error');
      expect(response.payload.code).toBe('INVALID_PAYLOAD');
    });
  });
});
