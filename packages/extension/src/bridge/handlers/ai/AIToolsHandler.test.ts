import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIToolsHandler } from './AIToolsHandler.js';
import type { HandlerDeps, InboundRequest } from '../HandlerTypes.js';
import type { AIModules } from '../AIHandler.js';
import { inboundRequest } from '../../../test/mockFactories.js';
import { NL2SOQL } from '../../../modules/ai/NL2SOQL.js';
import { PipelineGenerator } from '../../../modules/ai/PipelineGenerator.js';
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

/** Org double: a global catalog, one describable object and a query planner that accepts. */
function mockConnection(
  describe_ = vi.fn().mockResolvedValue(ACCOUNT_DESCRIBE),
  request = vi.fn().mockResolvedValue({ plans: [{ leadingOperationType: 'TableScan' }] }),
) {
  return {
    describeGlobal: vi.fn().mockResolvedValue({ sobjects: CATALOG }),
    describe: describe_,
    request,
  };
}

function createMockDeps(): HandlerDeps {
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as unknown as HandlerDeps['stateSync'],
    orgManager: {
      getOrg: vi.fn().mockReturnValue({ alias: 'dev', orgType: 'Sandbox' }),
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

  it('refuses an AI draft with no step instead of loading an empty canvas', async () => {
    const mockModules: Partial<AIModules> = {
      pipelineGenerator: {
        generatePipeline: vi
          .fn()
          .mockResolvedValue({ name: 'Pipeline_1', description: 'x', steps: [] }),
      } as unknown as AIModules['pipelineGenerator'],
    };
    handler.setAIModules(mockModules as AIModules);

    await handler.handle(
      createMsg('ai:generate-pipeline', { description: 'something unusual', orgIds: ['org1'] }),
    );

    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.type).toBe('ai:generate-pipeline:response');
    expect(response.correlationId).toBe('msg-1');
    expect(response.payload.success).toBe(false);
    expect(response.payload.pipeline).toBeUndefined();
    expect(response.payload.error).toMatch(/no steps/);
  });

  it('handles ai:generate-pipeline with modules with correlationId', async () => {
    const mockModules: Partial<AIModules> = {
      pipelineGenerator: {
        generatePipeline: vi.fn().mockResolvedValue({
          name: 'Pipeline_Seed',
          description: 'seed accounts',
          steps: [{ name: 'seed_step', type: 'seed', config: {}, description: '' }],
        }),
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

  describe('the org types the pipeline model is told', () => {
    /** A real PipelineGenerator over a scripted model, so the prompt is the shipped one. */
    function realGenerator() {
      const provider = vi.fn().mockResolvedValue(
        JSON.stringify({
          name: 'Pipeline_Refresh',
          steps: [{ name: 'refresh_step', type: 'sync', config: {}, description: '' }],
        }),
      );
      handler.setAIModules({
        pipelineGenerator: new PipelineGenerator(provider),
      } as unknown as AIModules);
      return provider;
    }

    /** No step keyword in it, so the draft comes from the model and its prompt. */
    const REQUEST = 'refresh the reference tables';

    it('describes an org the registry does not know as production, not as a sandbox', async () => {
      const provider = realGenerator();
      vi.mocked(deps.orgManager.getOrg).mockReturnValue(undefined);

      await handler.handle(
        createMsg('ai:generate-pipeline', { description: REQUEST, orgIds: ['org-x'] }),
      );

      const prompt = provider.mock.calls[0][0] as string;
      expect(prompt).toContain('org-x (production, ID: org-x)');
      expect(prompt).not.toContain('(sandbox');
    });

    it('names each registered org type in the lowercase the model is shown', async () => {
      const provider = realGenerator();
      const registry: Record<string, { alias: string; orgType: string }> = {
        'org-p': { alias: 'prod', orgType: 'Production' },
        'org-s': { alias: 'uat', orgType: 'Sandbox' },
        'org-d': { alias: 'dev', orgType: 'Developer' },
        'org-c': { alias: 'scratch', orgType: 'Scratch' },
      };
      vi.mocked(deps.orgManager.getOrg).mockImplementation(
        (id) => registry[id] as unknown as ReturnType<HandlerDeps['orgManager']['getOrg']>,
      );

      await handler.handle(
        createMsg('ai:generate-pipeline', { description: REQUEST, orgIds: Object.keys(registry) }),
      );

      const prompt = provider.mock.calls[0][0] as string;
      expect(prompt).toContain('prod (production, ID: org-p)');
      expect(prompt).toContain('uat (sandbox, ID: org-s)');
      expect(prompt).toContain('dev (developer, ID: org-d)');
      expect(prompt).toContain('scratch (scratch, ID: org-c)');
    });
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
      expect(response.payload.unverifiedReason).toBe('fields-unknown');
    });

    it('tells the panel a draft over a described object still checked nothing', async () => {
      realNL2SOQL('SELECT COUNT(Id) FROM Account');

      await handler.handle(createMsg('ai:nl2soql', { query: 'all accounts', orgId: 'org1' }));

      // Account was described here, so the panel must not read this as the org
      // withholding its field list.
      const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(response.payload.success).toBe(true);
      expect(response.payload.verified).toBe(false);
      expect(response.payload.unverifiedReason).toBe('nothing-to-check');
    });

    it('tells the panel the draft was checked when the fields came from a describe', async () => {
      realNL2SOQL('SELECT Id, Name FROM Account');

      await handler.handle(createMsg('ai:nl2soql', { query: 'all accounts', orgId: 'org1' }));

      const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(response.payload.success).toBe(true);
      expect(response.payload.verified).toBe(true);
      expect(response.payload.unverifiedReason).toBeUndefined();
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

    it('describes an org again once told to forget it', async () => {
      const describe_ = vi.fn().mockResolvedValue(ACCOUNT_DESCRIBE);
      const conn = mockConnection(describe_);
      vi.mocked(getJsforceConnection).mockResolvedValue(
        conn as unknown as Awaited<ReturnType<typeof getJsforceConnection>>,
      );
      realNL2SOQL('SELECT Id FROM Account');

      await handler.handle(createMsg('ai:nl2soql', { query: 'all accounts', orgId: 'org1' }));
      handler.forgetOrg('org1');
      await handler.handle(createMsg('ai:nl2soql', { query: 'accounts again', orgId: 'org1' }));

      expect(describe_).toHaveBeenCalledTimes(2);
      expect(conn.describeGlobal).toHaveBeenCalledTimes(2);
    });
  });

  describe('ai:forge-plan', () => {
    /** A real NL2SOQL over a scripted model, so the prompt Forge sends is the shipped one. */
    function scriptedModel(soql: string, explanation = 'Accounts in the energy industry') {
      const provider = vi
        .fn()
        .mockResolvedValue(JSON.stringify({ soql, explanation, confidence: 0.9 }));
      handler.setAIModules({ nl2soql: new NL2SOQL(provider) } as unknown as AIModules);
      return provider;
    }

    function useOrg(conn: ReturnType<typeof mockConnection>) {
      vi.mocked(getJsforceConnection).mockResolvedValue(
        conn as unknown as Awaited<ReturnType<typeof getJsforceConnection>>,
      );
      return conn;
    }

    function lastResponse() {
      const calls = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls;
      return calls[calls.length - 1][0];
    }

    it('drafts from the prompt, checks the draft against the org, and hands it back', async () => {
      const conn = useOrg(mockConnection());
      const query = "SELECT Id, Name FROM Account WHERE Industry = 'Energy'";
      const provider = scriptedModel(query);

      await handler.handle(
        createMsg('ai:forge-plan', { prompt: 'energy accounts', orgId: 'org-src' }),
      );

      expect(provider).toHaveBeenCalledOnce();
      expect(provider.mock.calls[0][0]).toContain('energy accounts');
      const response = lastResponse();
      expect(response.type).toBe('ai:forge-plan:response');
      expect(response.correlationId).toBe('msg-1');
      expect(response.payload).toEqual({
        success: true,
        soql: query,
        explanation: 'Accounts in the energy industry',
        rootObject: 'Account',
        rootLabel: 'Account',
        fieldsChecked: 3,
        problems: [],
      });
      // The org planned exactly the draft, and ran nothing.
      expect(conn.request).toHaveBeenCalledOnce();
      expect(conn.request).toHaveBeenCalledWith(`/query/?explain=${encodeURIComponent(query)}`);
    });

    it('describes the object after FROM even when the prompt named no object', async () => {
      const describe_ = vi.fn().mockResolvedValue(ACCOUNT_DESCRIBE);
      useOrg(mockConnection(describe_));
      scriptedModel('SELECT Id, Invented__c FROM Account');

      await handler.handle(
        createMsg('ai:forge-plan', { prompt: 'whatever changed lately', orgId: 'org-src' }),
      );

      expect(describe_.mock.calls.map((c) => c[0])).toEqual(['Account']);
      expect(lastResponse().payload).toMatchObject({
        success: false,
        soql: 'SELECT Id, Invented__c FROM Account',
        problems: [{ kind: 'field-missing', object: 'Account', field: 'Invented__c' }],
      });
    });

    it('hands back a draft the org refuses, with the words the org refused it in', async () => {
      const refusal = Object.assign(new Error("No such column 'Tier' on entity 'Account'"), {
        errorCode: 'INVALID_FIELD',
      });
      useOrg(mockConnection(undefined, vi.fn().mockRejectedValue(refusal)));
      scriptedModel('SELECT Id FROM Account WHERE CALENDAR_YEAR(Tier) = 2024');

      await handler.handle(
        createMsg('ai:forge-plan', { prompt: 'accounts by tier', orgId: 'org-src' }),
      );

      const payload = lastResponse().payload;
      expect(payload.success).toBe(false);
      expect(payload.soql).toBe('SELECT Id FROM Account WHERE CALENDAR_YEAR(Tier) = 2024');
      expect(payload.problems).toHaveLength(1);
      expect(payload.problems[0].kind).toBe('org-refused');
      expect(payload.problems[0].detail).toContain('INVALID_FIELD');
    });

    it('checks an edited query without asking the model anything', async () => {
      const conn = useOrg(mockConnection());
      const provider = scriptedModel('SELECT Id FROM Account');

      await handler.handle(
        createMsg('ai:forge-plan', {
          soql: "SELECT Id FROM Account WHERE Name LIKE 'A%'",
          orgId: 'org-src',
        }),
      );

      expect(provider).not.toHaveBeenCalled();
      expect(conn.request).toHaveBeenCalledOnce();
      expect(lastResponse().payload).toMatchObject({
        success: true,
        soql: "SELECT Id FROM Account WHERE Name LIKE 'A%'",
        rootObject: 'Account',
        fieldsChecked: 2,
      });
    });

    it('checks an edited query with no provider set up at all', async () => {
      useOrg(mockConnection());

      await handler.handle(
        createMsg('ai:forge-plan', { soql: 'SELECT Id FROM Account', orgId: 'org-src' }),
      );

      expect(lastResponse().payload).toMatchObject({ success: true, rootObject: 'Account' });
    });

    it('says no provider is set up, and reaches no org, when a prompt comes in without one', async () => {
      vi.mocked(getJsforceConnection).mockClear();

      await handler.handle(
        createMsg('ai:forge-plan', { prompt: 'energy accounts', orgId: 'org-src' }),
      );

      expect(getJsforceConnection).not.toHaveBeenCalled();
      expect(lastResponse().payload).toEqual({
        success: false,
        code: 'AI_NOT_CONFIGURED',
        error: expect.stringContaining('Settings'),
      });
    });

    it('answers a provider failure on the same channel instead of leaving the tab waiting', async () => {
      useOrg(mockConnection());
      handler.setAIModules({
        nl2soql: new NL2SOQL(vi.fn().mockRejectedValue(new Error('rate_limit_error: slow down'))),
      } as unknown as AIModules);

      await handler.handle(
        createMsg('ai:forge-plan', { prompt: 'energy accounts', orgId: 'org-src' }),
      );

      const response = lastResponse();
      expect(response.type).toBe('ai:forge-plan:response');
      expect(response.correlationId).toBe('msg-1');
      expect(response.payload.success).toBe(false);
      expect(response.payload.error).toContain('slow down');
    });

    it('refuses a request carrying both a prompt and a query, or neither', async () => {
      await handler.handle(
        createMsg('ai:forge-plan', { prompt: 'x', soql: 'SELECT Id FROM Account', orgId: 'o' }),
      );
      await handler.handle(createMsg('ai:forge-plan', { orgId: 'o' }));

      const responses = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[0],
      );
      expect(responses.map((r) => [r.type, r.payload.code])).toEqual([
        ['ai:error', 'INVALID_PAYLOAD'],
        ['ai:error', 'INVALID_PAYLOAD'],
      ]);
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
