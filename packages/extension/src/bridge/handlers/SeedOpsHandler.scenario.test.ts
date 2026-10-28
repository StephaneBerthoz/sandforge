/**
 * A scenario pack's seed through the Seed page's channels: the packs listed,
 * the pack compiled for an org with the org's own case statuses, the run
 * held to a template's gates and answered as one, its companion file kept
 * beside its run's, and its agent's test file written into the workspace —
 * or, in an org without an agent, the data written and the file not, said.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import type {
  AgentTestChoice,
  BaseMessage,
  ForgeTargetAutomation,
  SeedExecutionResult,
  SeedScenarioPreparation,
  SeedScenarioTestFileOutcome,
  SeedTemplate,
} from '@sandforge/shared';
import {
  BUILT_IN_SCENARIO_PACKS,
  RETAIL_ORDERS_PACK,
  testingCenterTestSpecSchema,
} from '@sandforge/shared';

import { SeedOpsHandler } from './SeedOpsHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import {
  SeedOrchestrator,
  type SeedOrchestratorDependencies,
} from '../../modules/seed/SeedOrchestrator.js';
import { nodeSeedRunCreations } from '../../modules/seed/SeedRunCreations.js';
import { compileScenario } from '../../modules/seed/scenario/compileScenario.js';
import {
  nodeScenarioSidecarFiles,
  readScenarioRunSidecar,
} from '../../modules/seed/scenario/scenarioRunSidecar.js';
import { SCENARIO_PACK_FILE_SUFFIX } from '../../modules/seed/scenario/scenarioPackFiles.js';
import { AGENT_CATALOG_API } from '../../modules/agentforce/agentCatalog.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { inboundRequest } from '../../test/mockFactories.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const ORG = 'org-dev';
const AGENT = fakeId('16j', 1);
const TOPIC = fakeId('179', 1);
const ACTION = fakeId('172', 1);

/** The catalog objects of an org with one agent: a topic of its own, with one action. */
const ONE_AGENT: Record<string, Array<Record<string, unknown>>> = {
  GenAiPlannerDefinition: [
    { Id: AGENT, DeveloperName: 'Retail_Service_Agent', MasterLabel: 'Retail Service Agent' },
  ],
  GenAiPlannerFunctionDef: [{ PlannerId: AGENT, Plugin: TOPIC }],
  GenAiPlannerAttrDefinition: [],
  GenAiPluginDefinition: [{ Id: TOPIC, DeveloperName: 'Order_Issues', MasterLabel: 'Orders' }],
  GenAiPluginFunctionDef: [{ PluginId: TOPIC, Function: ACTION }],
  GenAiFunctionDefinition: [{ Id: ACTION, DeveloperName: 'Identify_Customer' }],
};

/** The org's Tooling API over `tables`: each statement answered by its object, `WHERE … IN` honoured. */
function toolingOver(tables: Record<string, Array<Record<string, unknown>>>) {
  const select = async (soql: string) => {
    const parsed = /FROM (\w+)(?: WHERE (\w+) IN \((.*)\))?$/.exec(soql);
    const [, object, field, list] = parsed ?? [];
    const rows = tables[object];
    if (!rows) {
      throw Object.assign(new Error(`sObject type '${object}' is not supported.`), {
        errorCode: 'INVALID_TYPE',
        name: 'INVALID_TYPE',
      });
    }
    const wanted = list?.split(', ').map((quoted) => quoted.slice(1, -1).slice(0, 15));
    return {
      records: rows.filter((row) => !field || wanted?.includes(String(row[field]).slice(0, 15))),
      done: true,
    };
  };
  return { query: vi.fn(select), queryMore: vi.fn() };
}

function msg(type: string, payload: unknown): InboundRequest {
  return inboundRequest({ id: `req-${type}`, type, timestamp: Date.now(), payload } as BaseMessage);
}

const choice: AgentTestChoice = {
  agent: 'Retail_Service_Agent',
  runner: 'testing-center',
  topics: RETAIL_ORDERS_PACK.topics.map((topic) => ({
    packTopic: topic.key,
    agentTopic: 'Order_Issues',
    actions: ['Identify_Customer'],
  })),
  guardTopic: null,
};

describe('SeedOpsHandler — a scenario pack seeded, and its test file', () => {
  let deps: HandlerDeps;
  let handler: SeedOpsHandler;
  let storage: string;
  let workspace: string;
  let registry: BackgroundOperationRegistry;
  let tracker: LiveOperationTracker;
  /** The templates the orchestrator was handed. */
  let executed: SeedTemplate[];
  /** The open case a run leaves unwritten, by key, as an org that refused its contact would. */
  let unwritten: string | undefined;
  let catalog: Record<string, Array<Record<string, unknown>>>;
  let tooling: ReturnType<typeof toolingOver>;

  const posted = <P>(type: string) =>
    vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: P })
      .filter((m) => m.type === type);
  const automation = (objects: readonly string[]): ForgeTargetAutomation => ({
    objectsRead: [...objects],
    objects: [],
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 25,
    bypassGrants: [],
    requests: 2,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    storage = mkdtempSync(join(tmpdir(), 'sandforge-scenario-storage-'));
    workspace = mkdtempSync(join(tmpdir(), 'sandforge-scenario-workspace-'));
    writeFileSync(join(workspace, 'sfdx-project.json'), '{}');
    executed = [];
    unwritten = undefined;
    catalog = ONE_AGENT;
    tooling = toolingOver(catalog);
    const store = new ConfigStore(new InMemoryConfigStoreBackend());
    store.initialize();
    vi.mocked(getJsforceConnection).mockImplementation(
      async () =>
        ({
          request: vi.fn(async () => ({
            DataStorageMB: { Max: 5, Remaining: 5 },
            DailyApiRequests: { Max: 15_000, Remaining: 15_000 },
            SingleEmail: { Max: 15, Remaining: 15 },
          })),
          query: vi.fn(async (soql: string) => {
            if (soql.includes('FROM Organization')) {
              return { records: [{ DefaultLocaleSidKey: 'en_US' }] };
            }
            if (soql.includes('FROM CaseStatus')) {
              return {
                records: [
                  { ApiName: 'Received', IsClosed: false, IsDefault: true },
                  { ApiName: 'Resolved', IsClosed: true, IsDefault: false },
                ],
              };
            }
            return { records: [] };
          }),
          describeGlobal: vi.fn(async () => ({
            sobjects: ['Account', 'Contact', 'Case', 'CaseComment'].map((name) => ({
              name,
              createable: true,
            })),
          })),
          describe: vi.fn(async () => ({ fields: [] })),
          identity: vi.fn(async () => ({ user_id: fakeId('005', 1) })),
          tooling: {
            query: (soql: string) => tooling.query(soql),
            queryMore: (url: string) => tooling.queryMore(url),
          },
        }) as never,
    );
    let next = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn((orgId: string) =>
          orgId === ORG ? { orgType: 'Developer', alias: 'my-dev-org' } : undefined,
        ),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as HandlerDeps['orgRegistry'],
      configStore: store,
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      infraServices: {
        productionGuard: new ProductionGuard({
          requestConfirmation: vi.fn(async () => true),
          requestRunConfirmation: vi.fn(async () => true),
        }),
      } as unknown as HandlerDeps['infraServices'],
      services: {
        isAIEnabled: () => false,
        getSandforgeSetting: vi.fn((_key: string, fallback: unknown) => fallback),
        getWorkspaceFolders: () => [workspace],
        // Writes every row of the template, but the open case `unwritten` names.
        seedOrchestrator: vi.fn((seedDeps: SeedOrchestratorDependencies) => ({
          execute: vi.fn(async (template: SeedTemplate, _orgId: string, runId: string) => {
            executed.push(template);
            let n = 0;
            const objectResults = template.objects.map((object) => {
              const ids: Record<string, string> = {};
              for (const row of object.rows ?? []) {
                if (row.key !== unwritten) ids[row.key] = fakeId('a0X', ++n);
              }
              seedDeps.onRowIds?.(object.objectApiName, ids);
              return {
                objectApiName: object.objectApiName,
                recordsCreated: Object.keys(ids).length,
                recordsFailed: 0,
                createdIds: Object.values(ids),
                errors: [],
              };
            });
            const created = objectResults.reduce((sum, o) => sum + o.recordsCreated, 0);
            return {
              templateId: template.id,
              operationId: runId,
              status: 'success',
              objectResults,
              totalRecordsCreated: created,
              totalRecordsFailed: 0,
              duration: 1,
              timestamp: '2026-10-28T00:00:00.000Z',
            } satisfies SeedExecutionResult;
          }),
        })),
      } as unknown as HandlerDeps['services'],
      nextId: () => String(++next),
    };
    handler = new SeedOpsHandler(deps);
    handler.setTargetAutomation({ read: async (_org, objects) => automation(objects) });
    registry = new BackgroundOperationRegistry();
    handler.setRegistry(registry);
    tracker = new LiveOperationTracker();
    handler.setLiveOperationTracker(tracker);
    handler.setRunCreations(nodeSeedRunCreations(storage));
  });

  afterEach(() => {
    tracker.dispose();
    registry.dispose();
    rmSync(storage, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  /** Prepare the retail pack for the org, then seed it with what the preparation answered. */
  async function seedRetail(): Promise<SeedExecutionResult> {
    await handler.handle(msg('seed:scenario:prepare', { orgId: ORG, pack: RETAIL_ORDERS_PACK }));
    const [prepared] = posted<{ preparation: SeedScenarioPreparation }>(
      'seed:scenario:prepare:response',
    );
    await handler.handle(
      msg('seed:scenario:execute', {
        orgId: ORG,
        pack: RETAIL_ORDERS_PACK,
        options: prepared.payload.preparation.options,
      }),
    );
    await vi.waitFor(() => expect(posted('seed:execute:response')).toHaveLength(1));
    return posted<SeedExecutionResult>('seed:execute:response')[0].payload;
  }

  it("prepares a pack with the org's statuses, and says the articles are skipped without Knowledge", async () => {
    await handler.handle(
      msg('seed:scenario:prepare', { orgId: ORG, pack: RETAIL_ORDERS_PACK, seed: 4 }),
    );

    const [answer] = posted<{ preparation: SeedScenarioPreparation }>(
      'seed:scenario:prepare:response',
    );
    expect(answer.correlationId).toBe('req-seed:scenario:prepare');
    expect(answer.payload.preparation.options).toEqual({
      seed: 4,
      caseStatus: { open: 'Received', closed: 'Resolved' },
    });
    expect(answer.payload.preparation.knowledge).toEqual({
      available: false,
      reason: 'Salesforce Knowledge is not turned on in it',
    });
    expect(answer.payload.preparation.objects.map((o) => o.objectApiName)).toEqual([
      'Account',
      'Contact',
      'Case',
      'CaseComment',
      'Knowledge__kav',
    ]);
  });

  it('seeds the compiled pack, answers as a seed does, and keeps the ids of the open cases written beside the run', async () => {
    unwritten = 'retail-orders-c03-open';
    const result = await seedRetail();

    expect(executed).toHaveLength(1);
    expect(executed[0].id).toBe('scenario-retail-orders');
    expect(
      executed[0].objects
        .find((o) => o.objectApiName === 'Case')
        ?.rows?.every((row) => ['Received', 'Resolved'].includes(String(row.values.Status))),
    ).toBe(true);
    expect(result.scenario).toEqual({
      packId: 'retail-orders',
      packName: RETAIL_ORDERS_PACK.name,
      tests: expect.any(Number),
      openCasesWritten: 9,
      openCases: 10,
      companion: { kind: 'kept' },
    });
    const kept = await readScenarioRunSidecar(
      nodeScenarioSidecarFiles(),
      storage,
      result.operationId,
    );
    if (kept.kind !== 'read') throw new Error(kept.kind);
    expect(Object.keys(kept.sidecar.openCases)).toHaveLength(9);
    expect(kept.sidecar.openCases).not.toHaveProperty('retail-orders-c03-open');
    expect(kept.sidecar.compile.caseStatus).toEqual({ open: 'Received', closed: 'Resolved' });
  });

  it('refuses a pack whose options do not hold before anything is read of the org', async () => {
    await handler.handle(
      msg('seed:scenario:execute', {
        orgId: ORG,
        pack: RETAIL_ORDERS_PACK,
        options: { caseStatus: { open: 'New', closed: 'New' } },
      }),
    );

    const [error] = posted<{ code: string }>('seed:error');
    expect(error.payload.code).toBe('INVALID_PAYLOAD');
    expect(executed).toHaveLength(0);
    expect(getJsforceConnection).not.toHaveBeenCalled();
  });

  it('writes the test file of the run into the DX project and gives the commands, never running them', async () => {
    const result = await seedRetail();

    await handler.handle(msg('seed:scenario:test-file', { runId: result.operationId, choice }));

    const [answer] = posted<{ outcome: SeedScenarioTestFileOutcome }>(
      'seed:scenario:test-file:response',
    );
    const { outcome } = answer.payload;
    if (outcome.kind !== 'written') throw new Error(outcome.kind);
    expect(outcome.path).toBe(
      join(workspace, 'specs', 'Retail_Service_Agent-retail-orders-sandforge-testSpec.yaml'),
    );
    expect(outcome.commands?.create).toMatch(
      /^sf agent test create --spec specs\/.* -o my-dev-org$/,
    );
    const spec = testingCenterTestSpecSchema.parse(parse(readFileSync(outcome.path, 'utf8')));
    expect(spec.subjectName).toBe('Retail_Service_Agent');
    // The agent's catalog was read by SOQL alone, through the API the catalog
    // names; nothing was deployed.
    expect(AGENT_CATALOG_API).toBe('tooling');
    expect(tooling.query).toHaveBeenCalledWith(
      expect.stringMatching(/^SELECT .* FROM GenAiPlannerDefinition$/),
    );
  });

  it('writes the data in an org with no agent, and the test file not, saying to create one first', async () => {
    catalog = { ...ONE_AGENT, GenAiPlannerDefinition: [] };
    tooling = toolingOver(catalog);
    const result = await seedRetail();
    expect(result.totalRecordsCreated).toBeGreaterThan(0);

    await handler.handle(msg('seed:scenario:test-file', { runId: result.operationId, choice }));

    const [answer] = posted<{ outcome: SeedScenarioTestFileOutcome }>(
      'seed:scenario:test-file:response',
    );
    expect(answer.payload.outcome).toEqual({
      kind: 'no-agent',
      reason: 'none',
      message:
        'This org has no Agentforce agent: create one, then write the test file from this run.',
    });
    expect(existsSync(join(workspace, 'specs'))).toBe(false);
  });

  it("reads an org's agents with the project a file would go to, and its Case picklists", async () => {
    await handler.handle(msg('seed:scenario:agents', { orgId: ORG }));

    const [answer] = posted<Record<string, unknown>>('seed:scenario:agents:response');
    expect(answer.payload).toMatchObject({
      orgId: ORG,
      agents: {
        kind: 'agents',
        agents: [expect.objectContaining({ name: 'Retail_Service_Agent' })],
      },
      project: { kind: 'dx', dir: workspace },
    });
  });

  it('saves a pack in the workspace and lists it after the packs SandForge ships', async () => {
    const own = { ...RETAIL_ORDERS_PACK, id: 'own-shop', name: 'Our shop' };
    await handler.handle(msg('seed:scenario:save', { pack: own }));
    await handler.handle(msg('seed:scenario:packs', {}));

    const [saved] = posted<{ outcome: { kind: string; relativePath: string } }>(
      'seed:scenario:save:response',
    );
    expect(saved.payload.outcome).toMatchObject({
      kind: 'saved',
      relativePath: `own-shop${SCENARIO_PACK_FILE_SUFFIX}`,
    });
    const [listed] = posted<{ packs: Array<{ source: string }>; workspace: boolean }>(
      'seed:scenario:packs:response',
    );
    expect(listed.payload.workspace).toBe(true);
    expect(listed.payload.packs.map((entry) => entry.source)).toEqual([
      ...BUILT_IN_SCENARIO_PACKS.map(() => 'built-in'),
      'workspace',
    ]);
  });

  it('says a run unknown to the store has no test file to write', async () => {
    await handler.handle(msg('seed:scenario:test-file', { runId: 'gone', choice }));

    const [answer] = posted<{ outcome: SeedScenarioTestFileOutcome }>(
      'seed:scenario:test-file:response',
    );
    expect(answer.payload.outcome).toMatchObject({ kind: 'unavailable', reason: 'run-unknown' });
  });

  describe('in an org with Knowledge, through the run a seed writes with', () => {
    let org: ReturnType<typeof knowledgeOrg>;

    beforeEach(() => {
      org = knowledgeOrg();
      vi.mocked(getJsforceConnection).mockImplementation(async () => org.conn as never);
      Object.assign(deps.services as object, {
        seedOrchestrator: (seedDeps: SeedOrchestratorDependencies) =>
          new SeedOrchestrator(seedDeps),
      });
    });

    it('prepares the pack for the one field a Knowledge base turned on afresh gives a body: Summary, 1 000 characters', async () => {
      await handler.handle(msg('seed:scenario:prepare', { orgId: ORG, pack: RETAIL_ORDERS_PACK }));

      const [answer] = posted<{ preparation: SeedScenarioPreparation }>(
        'seed:scenario:prepare:response',
      );
      expect(answer.payload.preparation.knowledge).toEqual({
        available: true,
        bodyFields: ['Summary'],
      });
      expect(answer.payload.preparation.options).toEqual({
        seed: 1,
        caseStatus: { open: 'Received', closed: 'Resolved' },
        articleBodyField: 'Summary',
        articleBodyLength: 1000,
      });
    });

    it('publishes every article the scenario wrote and links each closed case to its article, each call kept with the run', async () => {
      const result = await seedRetail();

      expect(result.status).toBe('success');
      expect(result.knowledge).toEqual({
        publish: { asked: 6, done: 6, notDone: [] },
        links: { asked: 20, done: 20, notDone: [] },
      });
      const versions = org.written.Knowledge__kav.map((row) => String(row.Id));
      expect(org.publications).toEqual(
        versions.map((versionId) => ({ versionId, status: 'Online' })),
      );
      const closed = new Set(
        org.written.Case.filter((row) => row.Status === 'Resolved').map((row) => row.Id),
      );
      expect(org.written.CaseArticle).toHaveLength(20);
      for (const link of org.written.CaseArticle) {
        expect(closed.has(link.CaseId)).toBe(true);
        expect(versions.map((id) => org.articleOf.get(id))).toContain(link.KnowledgeArticleId);
      }
      // Each body compiled into Summary, every fact kept, on the execute too.
      RETAIL_ORDERS_PACK.topics.forEach((topic, at) => {
        const body = String(org.written.Knowledge__kav[at].Summary);
        expect(body.length).toBeLessThanOrEqual(1000);
        for (const fact of topic.article.facts) expect(words(body)).toContain(words(fact));
      });
      // Each publication kept with the run, version by version, after its insert.
      const lines = readFileSync(join(storage, 'seed-runs', `${result.operationId}.ndjson`), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { object?: string; created?: string[] });
      for (const id of versions) {
        expect(
          lines.some((line) => line.object === 'Knowledge__kav' && line.created?.join() === id),
        ).toBe(true);
      }
    });

    it('names an article the org would not publish in its words, links the rest, and answers the run partial', async () => {
      org.refusePublication = (versionId) =>
        versionId === org.written.Knowledge__kav[0]?.Id
          ? 'INSUFFICIENT_ACCESS: You do not have the permission to publish articles.'
          : undefined;

      const result = await seedRetail();

      expect(result.status).toBe('partial');
      expect(result.knowledge?.publish).toEqual({
        asked: 6,
        done: 5,
        notDone: [
          {
            key: 'retail-orders-article-damaged-parcel',
            reason:
              'Left a draft: INSUFFICIENT_ACCESS: You do not have the permission to publish articles.',
          },
        ],
      });
      expect(result.knowledge?.links).toMatchObject({ asked: 20, done: 20 });
    });

    it('publishes nothing for a template seed that writes the same articles: the step is a scenario run alone', async () => {
      const compiled = compileScenario(RETAIL_ORDERS_PACK, {
        caseStatus: { open: 'Received', closed: 'Resolved' },
        articleBodyField: 'Summary',
        articleBodyLength: 1000,
      });

      await handler.handle(msg('seed:execute', { orgId: ORG, template: compiled.template }));
      await vi.waitFor(() => expect(posted('seed:execute:response')).toHaveLength(1));

      const [answer] = posted<SeedExecutionResult>('seed:execute:response');
      expect(org.written.Knowledge__kav).toHaveLength(6);
      expect(answer.payload.knowledge).toBeUndefined();
      expect(org.publications).toEqual([]);
      expect(org.written.CaseArticle).toBeUndefined();
    });
  });
});

/** A text's words, whatever their case and the spaces between them: how a body states a fact. */
const words = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim();

/** A field as the fake org describes it. */
const describedField = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  type: 'string',
  createable: true,
  nillable: true,
  length: 255,
  referenceTo: [],
  defaultedOnCreate: false,
  picklistValues: [],
  ...extra,
});

/**
 * The objects a scenario writes, as an org with a Knowledge base turned on
 * afresh describes them: no field for an article's body but `Summary`.
 */
const KNOWLEDGE_ORG_OBJECTS: Record<string, unknown[]> = {
  Account: ['Name', 'Industry', 'Type', 'Phone', 'Website'].map((name) => describedField(name)),
  Contact: [
    ...['FirstName', 'LastName', 'Email', 'Phone'].map((name) => describedField(name)),
    describedField('AccountId', { type: 'reference', referenceTo: ['Account'] }),
  ],
  Case: [
    ...['Subject', 'Status', 'Priority', 'Origin'].map((name) => describedField(name)),
    describedField('Description', { type: 'textarea', length: 32000 }),
    describedField('ContactId', { type: 'reference', referenceTo: ['Contact'] }),
  ],
  CaseComment: [
    describedField('CommentBody', { type: 'textarea', length: 4000 }),
    describedField('IsPublished', { type: 'boolean' }),
    describedField('ParentId', { type: 'reference', referenceTo: ['Case'] }),
  ],
  Knowledge__kav: [
    describedField('Title'),
    describedField('UrlName'),
    describedField('Summary', { type: 'textarea', length: 1000, extraTypeInfo: 'plaintextarea' }),
    describedField('Language', { type: 'picklist', length: 40 }),
    ...['IsVisibleInPkb', 'IsVisibleInCsp', 'IsVisibleInPrm'].map((name) =>
      describedField(name, { type: 'boolean' }),
    ),
  ],
  CaseArticle: [
    describedField('CaseId', { type: 'reference', referenceTo: ['Case'] }),
    describedField('KnowledgeArticleId', { type: 'reference', referenceTo: ['Knowledge__ka'] }),
  ],
};

/** The address a version is published at, under the API's version. */
const PUBLICATION = /\/knowledgeManagement\/articleVersions\/masterVersions\/(\w+)$/;

/**
 * An org in memory with Knowledge turned on, as the run of a seed reaches
 * it: it takes every record it is sent, publishes the versions it is asked
 * to unless told to refuse one, and links a case to an article by the
 * article's id, as a Developer Edition answered the probes of wave 44.
 */
function knowledgeOrg() {
  const written: Record<string, Array<Record<string, unknown>>> = {};
  const publications: Array<{ versionId: string; status: unknown }> = [];
  const articleOf = new Map<string, string>();
  let made = 0;
  const state = {
    written,
    publications,
    articleOf,
    /** The org's words for a publication it refuses, by version. */
    refusePublication: (_versionId: string): string | undefined => undefined,
    conn: {} as Record<string, unknown>,
  };
  state.conn = {
    request: vi.fn(async (request: string | { method: string; url: string; body?: string }) => {
      const publication =
        typeof request === 'object' && request.method === 'PATCH'
          ? PUBLICATION.exec(request.url)
          : null;
      if (typeof request === 'string' || !publication) {
        return {
          DataStorageMB: { Max: 5, Remaining: 5 },
          DailyApiRequests: { Max: 15_000, Remaining: 15_000 },
          SingleEmail: { Max: 15, Remaining: 15 },
        };
      }
      const body = JSON.parse(request.body ?? '{}') as { publishStatus?: unknown };
      publications.push({ versionId: publication[1], status: body.publishStatus });
      const refusal = state.refusePublication(publication[1]);
      if (refusal) throw new Error(refusal);
      return undefined;
    }),
    query: vi.fn(async (soql: string) => {
      if (soql.includes('FROM Organization')) {
        return { records: [{ DefaultLocaleSidKey: 'en_US' }], done: true };
      }
      if (soql.includes('FROM CaseStatus')) {
        return {
          records: [
            { ApiName: 'Received', IsClosed: false, IsDefault: true },
            { ApiName: 'Resolved', IsClosed: true, IsDefault: false },
          ],
          done: true,
        };
      }
      if (soql.startsWith('SELECT Id, KnowledgeArticleId FROM Knowledge__kav')) {
        const ids = [...soql.matchAll(/'(\w+)'/g)].map(([, id]) => id.slice(0, 15));
        return {
          records: [...articleOf]
            .filter(([version]) => ids.includes(version.slice(0, 15)))
            .map(([Id, KnowledgeArticleId]) => ({ Id, KnowledgeArticleId })),
          done: true,
        };
      }
      return { records: [], done: true };
    }),
    describeGlobal: vi.fn(async () => ({
      sobjects: Object.keys(KNOWLEDGE_ORG_OBJECTS).map((name) => ({ name, createable: true })),
    })),
    describe: vi.fn(async (name: string) => ({
      name,
      createable: true,
      fields: KNOWLEDGE_ORG_OBJECTS[name] ?? [],
    })),
    sobject: (name: string) => ({
      create: async (records: Array<Record<string, unknown>>) =>
        records.map((record) => {
          const id = fakeId(name === 'Knowledge__kav' ? 'ka0' : 'a0X', ++made);
          (written[name] ??= []).push({ ...record, Id: id });
          if (name === 'Knowledge__kav') articleOf.set(id, fakeId('kA0', made));
          return { success: true, id, errors: [] };
        }),
    }),
    identity: vi.fn(async () => ({ user_id: fakeId('005', 1) })),
    tooling: {
      query: async () => ({ records: [], done: true }),
      queryMore: async () => ({ records: [], done: true }),
    },
  };
  return state;
}
