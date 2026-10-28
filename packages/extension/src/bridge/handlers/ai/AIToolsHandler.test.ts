import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIToolsHandler } from './AIToolsHandler.js';
import type { HandlerDeps, InboundRequest } from '../HandlerTypes.js';
import type { AIModules } from '../AIHandler.js';
import { inboundRequest } from '../../../test/mockFactories.js';
import { NL2SOQL } from '../../../modules/ai/NL2SOQL.js';
import { PipelineGenerator } from '../../../modules/ai/PipelineGenerator.js';
import { ScenarioDrafter } from '../../../modules/ai/ScenarioDrafter.js';
import { getJsforceConnection } from '../../../core/connection/ConnectionHelper.js';
import { RETAIL_ORDERS_PACK, type ScenarioPackDraft } from '@sandforge/shared';

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

  it('no longer answers ai:nl2soql: Forge drafts through ai:forge-plan, and Seed asked nothing since', async () => {
    const result = await handler.handle(
      createMsg('ai:nl2soql', { query: 'all accounts', orgId: 'org1' }),
    );
    expect(result).toBe(false);
    expect(deps.broker.postToWebview).not.toHaveBeenCalled();
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

  it('answers a wish for work that writes to an org with the page that runs it', async () => {
    const provider = vi.fn().mockResolvedValue('{}');
    handler.setAIModules({
      pipelineGenerator: new PipelineGenerator(provider),
    } as unknown as AIModules);

    await handler.handle(createMsg('ai:generate-pipeline', { description: 'sync accounts' }));

    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.type).toBe('ai:generate-pipeline:response');
    expect(response.payload.success).toBe(false);
    expect(response.payload.error).toContain('from the Sync page');
    expect(response.payload.error).not.toMatch(/no steps/);
    // The page words it from the code, in the reader's language.
    expect(response.payload.suggestions).toEqual([{ code: 'WRITES_TO_ORG', page: 'sync' }]);
    expect(provider).not.toHaveBeenCalled();
  });

  it('sends beside a draft it loads what the draft leaves out, as codes', async () => {
    const provider = vi.fn().mockResolvedValue('{}');
    handler.setAIModules({
      pipelineGenerator: new PipelineGenerator(provider),
    } as unknown as AIModules);

    await handler.handle(
      createMsg('ai:generate-pipeline', { description: 'compare then sync account data' }),
    );

    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.payload.success).toBe(true);
    expect(response.payload.pipeline.steps.map((s: { type: string }) => s.type)).toEqual([
      'compare',
    ]);
    expect(response.payload.suggestions).toEqual([{ code: 'WRITES_TO_ORG', page: 'sync' }]);
    expect(response.payload.pipeline.suggestions).toBeUndefined();
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

  describe('the schema a Forge draft is asked with', () => {
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
        createMsg('ai:forge-plan', { prompt: 'all accounts with their industry', orgId: 'org1' }),
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

      await handler.handle(
        createMsg('ai:forge-plan', { prompt: 'list the accounts', orgId: 'org1' }),
      );

      expect(describe_.mock.calls.map((c) => c[0])).toEqual(['Account']);
    });

    it('sends the names of the catalog alone when the request names no known object', async () => {
      const provider = realNL2SOQL('SELECT Id, Bogus__c FROM Contact');

      await handler.handle(
        createMsg('ai:forge-plan', { prompt: 'everything from last week', orgId: 'org1' }),
      );

      // The fallback catalog is names only, and never offers an object that
      // cannot appear in a FROM clause.
      const prompt = provider.mock.calls[0][0] as string;
      expect(prompt).toContain('Contact (Contact)');
      expect(prompt).not.toContain('AccountFeed');
    });

    it('reuses the cached describe across two requests on the same org', async () => {
      const describe_ = vi.fn().mockResolvedValue(ACCOUNT_DESCRIBE);
      const conn = mockConnection(describe_);
      vi.mocked(getJsforceConnection).mockResolvedValue(
        conn as unknown as Awaited<ReturnType<typeof getJsforceConnection>>,
      );
      realNL2SOQL('SELECT Id FROM Account');

      await handler.handle(createMsg('ai:forge-plan', { prompt: 'all accounts', orgId: 'org1' }));
      await handler.handle(createMsg('ai:forge-plan', { prompt: 'accounts again', orgId: 'org1' }));

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

      await handler.handle(createMsg('ai:forge-plan', { prompt: 'all accounts', orgId: 'org1' }));
      handler.forgetOrg('org1');
      await handler.handle(createMsg('ai:forge-plan', { prompt: 'accounts again', orgId: 'org1' }));

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

  describe('a draft the user stops', () => {
    /**
     * A model that answers only once its signal aborts, by rejecting, as the
     * SDK does: the page's Stop is the only way out of the wait.
     */
    function untilStopped(): ReturnType<typeof vi.fn> {
      return vi.fn(
        (...args: unknown[]) =>
          new Promise((_resolve, reject) => {
            const options = args.at(-1) as { signal?: AbortSignal } | undefined;
            options?.signal?.addEventListener('abort', () => reject(new Error('Request aborted')));
          }),
      );
    }

    function posted(): Array<{ type: string; correlationId?: string; payload: unknown }> {
      return (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls.map(
        (call) => call[0],
      );
    }

    async function stop(requestId: string): Promise<void> {
      await handler.handle(
        inboundRequest({
          id: `cancel-${requestId}`,
          type: 'ai:tool:cancel',
          timestamp: Date.now(),
          payload: { requestId },
        }),
      );
    }

    it.each([
      ['ai:forge-plan', { prompt: 'accounts in energy', orgId: 'org1' }],
      ['ai:generate-pipeline', { description: 'tidy the data the way we like it' }],
    ] as const)(
      'aborts the call to the model for %s and answers it CANCELLED, with no draft and no error',
      async (type, payload) => {
        const generateSOQL = untilStopped();
        const generatePipeline = untilStopped();
        handler.setAIModules({
          nl2soql: { generateSOQL },
          pipelineGenerator: { generatePipeline },
        } as unknown as AIModules);

        const asked = handler.handle(createMsg(type, payload));
        const model = type === 'ai:generate-pipeline' ? generatePipeline : generateSOQL;
        await vi.waitFor(() => expect(model).toHaveBeenCalled());
        await stop('msg-1');
        await asked;

        const signal = (model.mock.calls[0].at(-1) as { signal: AbortSignal }).signal;
        expect(signal.aborted).toBe(true);
        expect(posted()).toEqual([
          expect.objectContaining({
            type: `${type}:response`,
            correlationId: 'msg-1',
            payload: { success: false, code: 'CANCELLED' },
          }),
        ]);
      },
    );

    it('stops waiting on the org before the model is asked anything', async () => {
      const generateSOQL = vi.fn();
      handler.setAIModules({
        nl2soql: { generateSOQL },
      } as unknown as AIModules);
      const conn = mockConnection();
      // The catalogue never comes back.
      conn.describeGlobal = vi.fn(() => new Promise(() => {}));
      vi.mocked(getJsforceConnection).mockResolvedValue(
        conn as unknown as Awaited<ReturnType<typeof getJsforceConnection>>,
      );

      const asked = handler.handle(
        createMsg('ai:forge-plan', { prompt: 'accounts', orgId: 'org1' }),
      );
      await vi.waitFor(() => expect(conn.describeGlobal).toHaveBeenCalled());
      await stop('msg-1');
      await asked;

      expect(generateSOQL).not.toHaveBeenCalled();
      expect(posted()).toEqual([
        expect.objectContaining({ payload: { success: false, code: 'CANCELLED' } }),
      ]);
    });

    it('stops only the request it names, and leaves alone one that waits on nothing', async () => {
      const generateSOQL = untilStopped();
      handler.setAIModules({
        nl2soql: { generateSOQL },
      } as unknown as AIModules);

      const asked = handler.handle(
        createMsg('ai:forge-plan', { prompt: 'accounts', orgId: 'org1' }),
      );
      await vi.waitFor(() => expect(generateSOQL).toHaveBeenCalled());
      await stop('another-request');
      await stop('msg-0');

      const signal = (generateSOQL.mock.calls[0].at(-1) as { signal: AbortSignal }).signal;
      expect(signal.aborted).toBe(false);
      expect(posted()).toEqual([]);

      await stop('msg-1');
      await asked;
      expect(posted()).toHaveLength(1);
    });

    it('answers a provider failure as the failure it is, not as a stop', async () => {
      handler.setAIModules({
        nl2soql: {
          generateSOQL: vi.fn().mockRejectedValue(new Error('overloaded')),
        },
      } as unknown as AIModules);

      await handler.handle(createMsg('ai:forge-plan', { prompt: 'accounts', orgId: 'org1' }));

      expect(posted()[0].payload).toEqual({ success: false, error: 'overloaded' });
    });
  });

  describe('ai:scenario-draft', () => {
    const PACK = RETAIL_ORDERS_PACK;
    const TYPED = 'A home goods shop. Customers write to jane.doe@gmail.com about late parcels.';

    /** A model that answers the plan, then each topic, from the built-in retail pack. */
    function packModel(
      answer?: (topic: string | undefined, options?: { signal?: AbortSignal }) => Promise<string>,
    ) {
      return vi.fn(async (prompt: string, _system?: string, options?: { signal?: AbortSignal }) => {
        const topic = /<user-data label="topic">\{"key":"([^"]+)"/.exec(prompt)?.[1];
        if (answer) return answer(topic, options);
        return JSON.stringify(topicOrPlan(topic));
      });
    }

    function topicOrPlan(topic: string | undefined): Record<string, unknown> {
      if (topic === undefined) {
        return {
          id: PACK.id,
          name: PACK.name,
          businessContext: PACK.businessContext,
          customers: PACK.customers,
          topics: PACK.topics.map(({ key, label, utterances }) => ({ key, label, utterances })),
          decoy: PACK.decoy,
          outOfScope: PACK.outOfScope,
        };
      }
      const written = PACK.topics.find((t) => t.key === topic);
      return { article: written?.article, caseTemplates: written?.caseTemplates };
    }

    function posted(): Array<{
      type: string;
      correlationId?: string;
      payload: Record<string, unknown>;
    }> {
      return (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls.map(
        (call) => call[0],
      );
    }

    it('answers the pack drafted, with the scenario as it was sent', async () => {
      const provider = packModel();
      handler.setAIModules({
        scenarioDrafter: new ScenarioDrafter(provider),
      } as unknown as AIModules);

      const handled = await handler.handle(
        createMsg('ai:scenario-draft', { text: TYPED, language: 'en_US' }),
      );

      expect(handled).toBe(true);
      expect(provider).toHaveBeenCalledTimes(1 + PACK.topics.length);
      expect(posted()).toEqual([
        expect.objectContaining({
          type: 'ai:scenario-draft:response',
          correlationId: 'msg-1',
          payload: {
            success: true,
            sentText:
              'A home goods shop. Customers write to jane.doe@gmail.example about late parcels.',
            pack: PACK,
          },
        }),
      ]);
    });

    it('says the text as it would be sent without asking any model, AI set up or not', async () => {
      await handler.handle(
        createMsg('ai:scenario-draft', { text: TYPED, language: 'en_US', maskOnly: true }),
      );

      expect(posted()[0].payload).toEqual({
        success: true,
        sentText:
          'A home goods shop. Customers write to jane.doe@gmail.example about late parcels.',
      });
    });

    it('says no provider is set up, with the text it would have sent', async () => {
      await handler.handle(createMsg('ai:scenario-draft', { text: TYPED, language: 'en_US' }));

      expect(posted()[0].payload).toEqual({
        success: false,
        code: 'AI_NOT_CONFIGURED',
        error: 'AI not configured. Set your API key in Settings > AI.',
        sentText:
          'A home goods shop. Customers write to jane.doe@gmail.example about late parcels.',
      });
    });

    it('is stopped by ai:tool:cancel, and answers CANCELLED with the topics written before', async () => {
      let signalOfThird: AbortSignal | undefined;
      const provider = packModel(async (topic, options) => {
        if (topic === PACK.topics[1].key) {
          signalOfThird = options?.signal;
          return new Promise<string>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('Request aborted')));
          });
        }
        return JSON.stringify(topicOrPlan(topic));
      });
      handler.setAIModules({
        scenarioDrafter: new ScenarioDrafter(provider),
      } as unknown as AIModules);

      const asked = handler.handle(
        createMsg('ai:scenario-draft', { text: TYPED, language: 'en_US' }),
      );
      await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(3));
      await handler.handle(
        inboundRequest({
          id: 'cancel-1',
          type: 'ai:tool:cancel',
          timestamp: Date.now(),
          payload: { requestId: 'msg-1' },
        }),
      );
      await asked;

      expect(signalOfThird?.aborted).toBe(true);
      expect(provider).toHaveBeenCalledTimes(3);
      const [answer] = posted();
      expect(answer.type).toBe('ai:scenario-draft:response');
      expect(answer.payload).toMatchObject({ success: false, code: 'CANCELLED' });
      const draft = answer.payload.draft as ScenarioPackDraft;
      expect(draft.topics.map((topic) => topic.article !== undefined)).toEqual([
        true,
        false,
        false,
        false,
        false,
      ]);
      expect(answer.payload.pack).toBeUndefined();
    });

    it('answers a failed call with the provider words, where it failed, and the draft so far', async () => {
      const provider = packModel(async (topic) => {
        if (topic === PACK.topics[2].key) {
          throw new Error(
            'The model declined to answer this request. Rephrase it, or choose another model in sandforge.ai.model.',
          );
        }
        return JSON.stringify(topicOrPlan(topic));
      });
      handler.setAIModules({
        scenarioDrafter: new ScenarioDrafter(provider),
      } as unknown as AIModules);

      await handler.handle(createMsg('ai:scenario-draft', { text: TYPED, language: 'en_US' }));

      const { payload } = posted()[0];
      expect(payload).toMatchObject({
        success: false,
        error:
          'The model declined to answer this request. Rephrase it, or choose another model in sandforge.ai.model.',
        failedAt: { call: 'topic', topicKey: PACK.topics[2].key },
      });
      expect((payload.draft as ScenarioPackDraft).topics[1].article).toEqual(
        PACK.topics[1].article,
      );
      expect(payload.pack).toBeUndefined();
    });

    it('goes on with a draft handed back, writing only the topics it lacks', async () => {
      const provider = packModel();
      handler.setAIModules({
        scenarioDrafter: new ScenarioDrafter(provider),
      } as unknown as AIModules);
      const draft = {
        ...topicOrPlan(undefined),
        version: 1,
        language: PACK.language,
        topics: PACK.topics.map((topic, index) =>
          index < 3 ? topic : { key: topic.key, label: topic.label, utterances: topic.utterances },
        ),
      };

      await handler.handle(
        createMsg('ai:scenario-draft', { text: TYPED, language: 'en_US', draft }),
      );

      expect(provider).toHaveBeenCalledTimes(2);
      expect(posted()[0].payload).toMatchObject({ success: true, pack: PACK });
    });

    it('drops what an agent carries besides its topics and actions before anything is sent', async () => {
      const provider = packModel();
      handler.setAIModules({
        scenarioDrafter: new ScenarioDrafter(provider),
      } as unknown as AIModules);

      await handler.handle(
        createMsg('ai:scenario-draft', {
          text: TYPED,
          language: 'en_US',
          agent: {
            id: '0Xx000000000001AAA',
            name: 'Store_Service_Agent',
            variables: [{ name: 'VerifiedCustomerId' }],
            topics: [{ name: 'Delivery', described: true, actions: [{ name: 'Track_Parcel' }] }],
          },
        }),
      );

      const plan = provider.mock.calls[0][0];
      expect(plan).toContain('{"name":"Delivery","actions":[{"name":"Track_Parcel"}]}');
      expect(plan).not.toContain('0Xx000000000001AAA');
      expect(plan).not.toContain('Store_Service_Agent');
      expect(plan).not.toContain('VerifiedCustomerId');
    });

    it('refuses a language Salesforce does not write that way, and a text past its bound (INVALID_PAYLOAD)', async () => {
      const provider = packModel();
      handler.setAIModules({
        scenarioDrafter: new ScenarioDrafter(provider),
      } as unknown as AIModules);

      await handler.handle(createMsg('ai:scenario-draft', { text: TYPED, language: 'english' }));
      await handler.handle(
        createMsg('ai:scenario-draft', { text: 'x'.repeat(8_001), language: 'en_US' }),
      );

      expect(posted().map((m) => [m.type, m.payload.code])).toEqual([
        ['ai:error', 'INVALID_PAYLOAD'],
        ['ai:error', 'INVALID_PAYLOAD'],
      ]);
      expect(provider).not.toHaveBeenCalled();
    });
  });

  describe('payload validation', () => {
    it('rejects ai:tool:cancel without the request it stops (INVALID_PAYLOAD)', async () => {
      await handler.handle(createMsg('ai:tool:cancel', {}));

      const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(response.type).toBe('ai:error');
      expect(response.payload.code).toBe('INVALID_PAYLOAD');
    });

    it('rejects ai:forge-plan without orgId (INVALID_PAYLOAD)', async () => {
      const result = await handler.handle(createMsg('ai:forge-plan', { prompt: 'all accounts' }));
      expect(result).toBe(true);

      const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(response.type).toBe('ai:error');
      expect(response.payload.code).toBe('INVALID_PAYLOAD');
    });
  });
});
