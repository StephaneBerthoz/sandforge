/**
 * A pipeline's Seed step, through `SeedOpsHandler.seedForPipeline`: the seed
 * the Seed page runs, held to the same gates with nobody to watch it. A
 * production org is refused whatever the Approval step answered, a sandbox
 * marked Staging needs that Approval, the storage, request and email gates
 * hold as on the page, and every question the page would put is answered by
 * the Approval, or refused without one — never "nobody could be asked, the
 * seed goes on". The run is kept, listed and taken back as the page's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BaseMessage,
  ForgeTargetAutomation,
  SeedExecutionResult,
  SeedTemplate,
} from '@sandforge/shared';
import { CRM_STARTER, SALES_CLOUD_STARTER } from '@sandforge/shared';

import { SeedOpsHandler } from './SeedOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { PIPELINE_SEED_REFUSAL, type PipelineSeedRequest } from './seedPipeline.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { StepCancelledError } from '../../modules/automation/StepExecutor.js';
import { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import type { SeedOrchestratorDependencies } from '../../modules/seed/SeedOrchestrator.js';
import { nodeSeedRunCreations } from '../../modules/seed/SeedRunCreations.js';
import { SeedTemplateStore } from '../../modules/seed/SeedTemplateStore.js';
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

/** What each kind of org the tests seed is, as Org Manager holds it. */
const ORGS: Record<string, { orgType: string; alias: string; staging?: boolean }> = {
  'org-dev': { orgType: 'Developer', alias: 'my-dev-org' },
  'org-scratch': { orgType: 'Scratch', alias: 'my-scratch' },
  'org-prod': { orgType: 'Production', alias: 'my-prod' },
  'org-uat': { orgType: 'Sandbox', alias: 'my-uat', staging: true },
};

/** A saved template of `count` accounts, its name filled by `ruleType`. */
function accounts(count: number, ruleType: 'faker' | 'ai_generate' = 'faker'): SeedTemplate {
  return {
    id: 'tpl-accounts',
    name: 'Accounts',
    description: '',
    version: 1,
    strategy: 'faker',
    objects: [
      {
        objectApiName: 'Account',
        recordCount: count,
        batchSize: 200,
        insertOrder: 0,
        excludedFields: [],
        fieldRules: [
          ruleType === 'faker'
            ? { fieldApiName: 'Name', ruleType, config: { fakerMethod: 'company' } }
            : { fieldApiName: 'Name', ruleType, config: { aiPrompt: 'a company name' } },
        ],
      },
    ],
    tags: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

/** What the org runs on the objects read: nothing, or a contact flow that emails each contact. */
function automationOf(objects: readonly string[], contactEmails = false): ForgeTargetAutomation {
  return {
    objectsRead: [...objects],
    objects: contactEmails
      ? [
          {
            objectApiName: 'Contact',
            flows: [
              {
                apiName: 'Welcome_Email',
                label: 'Welcome Email',
                timing: 'afterSave',
                startsOn: 'create',
                condition: 'read',
                permissions: [],
                paths: [{ kind: 'async' }],
                messages: [{ kind: 'email', name: 'Send Welcome Email', limit: 'SingleEmail' }],
              },
            ],
            triggers: [],
            workflowRules: [],
          },
        ]
      : [],
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 25,
    bypassGrants: [],
    requests: 2,
  };
}

describe('SeedOpsHandler.seedForPipeline', () => {
  let deps: HandlerDeps;
  let handler: SeedOpsHandler;
  let store: ConfigStore;
  let storage: string;
  let registry: BackgroundOperationRegistry;
  let tracker: LiveOperationTracker;
  /** The org's `/limits`, as the test sets them. */
  let limits: Record<string, unknown>;
  /** Every REST create the seed sent the org: what it wrote. */
  let create: ReturnType<typeof vi.fn>;
  /** The templates the orchestrator was handed: a run that got that far. */
  let executed: SeedTemplate[];
  /** What the orchestrator does with a run, once it has inserted its accounts. */
  let finish: (
    deps: SeedOrchestratorDependencies,
    created: string[],
    runId: string,
  ) => Promise<unknown>;
  const requestConfirmation = vi.fn(async () => true);
  const requestRunConfirmation = vi.fn(async () => true);
  const read =
    vi.fn<(orgId: string, objects: readonly string[]) => Promise<ForgeTargetAutomation>>();

  const trail = () => new AuditTrailStore(store).list().entries;
  const posted = (type: string) =>
    vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: Record<string, unknown> })
      .filter((m) => m.type === type);
  const rowsWritten = (): number =>
    create.mock.calls.reduce((sum, [rows]) => sum + (rows as unknown[]).length, 0);

  beforeEach(() => {
    vi.clearAllMocks();
    storage = mkdtempSync(join(tmpdir(), 'sandforge-seed-pipeline-'));
    store = new ConfigStore(new InMemoryConfigStoreBackend());
    store.initialize();
    limits = {
      DataStorageMB: { Max: 5, Remaining: 5 },
      DailyApiRequests: { Max: 15_000, Remaining: 15_000 },
      SingleEmail: { Max: 15, Remaining: 15 },
    };
    let n = 0;
    create = vi.fn(async (rows: unknown[]) =>
      rows.map(() => ({ success: true, id: fakeId('001', ++n) })),
    );
    vi.mocked(getJsforceConnection).mockResolvedValue({
      request: vi.fn(async () => limits),
      query: vi.fn(async (soql: string) =>
        soql.includes('FROM Organization')
          ? { records: [{ DefaultLocaleSidKey: 'en_US' }] }
          : { records: [] },
      ),
      sobject: vi.fn(() => ({ create })),
    } as never);
    read.mockReset();
    read.mockImplementation(async (_orgId, objects) => automationOf(objects));
    executed = [];
    finish = async () => undefined;
    let next = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn((orgId: string) => ORGS[orgId]),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as HandlerDeps['orgRegistry'],
      configStore: store,
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      // The window's guard, with its modals: a pipeline must never open one.
      infraServices: {
        productionGuard: new ProductionGuard({ requestConfirmation, requestRunConfirmation }),
      } as unknown as HandlerDeps['infraServices'],
      services: {
        isAIEnabled: () => false,
        getSandforgeSetting: vi.fn((_key: string, fallback: unknown) => fallback),
        // A run that inserts two accounts, as the orchestrator writes them.
        seedOrchestrator: vi.fn((seedDeps: SeedOrchestratorDependencies) => ({
          execute: vi.fn(async (template: SeedTemplate, orgId: string, runId: string) => {
            executed.push(template);
            const answer = await seedDeps.insert(
              orgId,
              'Account',
              [{ Name: 'a' }, { Name: 'b' }],
              200,
            );
            const ended = await finish(seedDeps, answer.successIds, runId);
            if (ended !== undefined) return ended;
            return {
              templateId: template.id,
              operationId: runId,
              status: 'success',
              objectResults: [
                {
                  objectApiName: 'Account',
                  recordsCreated: answer.successIds.length,
                  recordsFailed: 0,
                  createdIds: answer.successIds,
                  errors: [],
                },
              ],
              totalRecordsCreated: answer.successIds.length,
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
    handler.setTargetAutomation({ read });
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
  });

  const seed = (request: Partial<PipelineSeedRequest> = {}, signal?: AbortSignal) =>
    handler.seedForPipeline(
      {
        orgId: 'org-dev',
        templateId: CRM_STARTER.id,
        pipeline: { name: 'Nightly refresh' },
        answer: { approved: false },
        ...request,
      },
      signal,
    );
  const saved = (template: SeedTemplate): void => new SeedTemplateStore(store).save(template);

  describe('the org', () => {
    it('refuses a production org whatever the Approval answered, before a connection opens', async () => {
      await expect(seed({ orgId: 'org-prod', answer: { approved: true } })).rejects.toMatchObject({
        code: PIPELINE_SEED_REFUSAL.production,
        message: expect.stringMatching(/^my-prod is a production org/),
      });
      expect(getJsforceConnection).not.toHaveBeenCalled();
      expect(requestConfirmation).not.toHaveBeenCalled();
      expect(rowsWritten()).toBe(0);
    });

    it('seeds a Developer Edition or a scratch org with no Approval before it', async () => {
      const dev = await seed({ orgId: 'org-dev' });
      const scratch = await seed({ orgId: 'org-scratch' });

      expect([dev.result.status, scratch.result.status]).toEqual(['success', 'success']);
      expect(rowsWritten()).toBe(4);
    });

    it('refuses a sandbox marked Staging that no Approval approved, and seeds it once one did', async () => {
      await expect(seed({ orgId: 'org-uat' })).rejects.toMatchObject({
        code: PIPELINE_SEED_REFUSAL.needsApproval,
      });
      expect(getJsforceConnection).not.toHaveBeenCalled();

      const approved = await seed({ orgId: 'org-uat', answer: { approved: true } });
      expect(approved.result.status).toBe('success');
      expect(rowsWritten()).toBe(2);
    });

    it('refuses an org SandForge does not know, before a connection opens', async () => {
      await expect(seed({ orgId: 'org-gone', answer: { approved: true } })).rejects.toMatchObject({
        code: PIPELINE_SEED_REFUSAL.orgUnknown,
        message: expect.stringContaining('org-gone'),
      });
      expect(getJsforceConnection).not.toHaveBeenCalled();
    });

    it("answers Production Guard's question with the Approval, and opens no modal", async () => {
      // Past 10,000 records the guard asks on a staging sandbox: a modal left
      // open held the run until someone came back to press it.
      limits = { ...limits, DataStorageMB: { Max: 1_000, Remaining: 1_000 } };
      saved(accounts(10_001));

      const outcome = await seed({
        orgId: 'org-uat',
        templateId: 'tpl-accounts',
        answer: { approved: true },
      });

      expect(outcome.result.status).toBe('success');
      expect(requestConfirmation).not.toHaveBeenCalled();
      expect(trail()).toEqual([
        expect.objectContaining({ operationId: outcome.operationId, guard: 'confirmed' }),
      ]);
    });

    it('puts the same question to the modal for a seed of the Seed page', async () => {
      limits = { ...limits, DataStorageMB: { Max: 1_000, Remaining: 1_000 } };
      await handler.handle(
        inboundRequest({
          id: 'seed-page',
          type: 'seed:execute',
          timestamp: Date.now(),
          payload: { orgId: 'org-uat', template: accounts(10_001) },
        }),
      );
      await vi.waitFor(() => expect(posted('seed:execute:response')).toHaveLength(1));

      expect(requestConfirmation).toHaveBeenCalledOnce();
    });

    it('refuses with the code the page is refused with when no Production Guard runs', async () => {
      deps.infraServices = {} as HandlerDeps['infraServices'];

      await expect(seed({ answer: { approved: true } })).rejects.toMatchObject({
        code: 'NOT_INITIALIZED',
      });
      expect(rowsWritten()).toBe(0);
      expect(trail()).toEqual([
        expect.objectContaining({ outcome: 'stopped', details: { code: 'NOT_INITIALIZED' } }),
      ]);
    });
  });

  describe('the template', () => {
    it('refuses a template with an AI rule before the org is read, and seeds the same with a Faker rule', async () => {
      saved(accounts(5, 'ai_generate'));
      await expect(seed({ templateId: 'tpl-accounts' })).rejects.toMatchObject({
        code: PIPELINE_SEED_REFUSAL.templateUsesAi,
        message: expect.stringContaining('Account.Name'),
      });
      expect(getJsforceConnection).not.toHaveBeenCalled();

      saved(accounts(5));
      expect((await seed({ templateId: 'tpl-accounts' })).result.status).toBe('success');
    });

    it('refuses a template the Seed page no longer holds', async () => {
      await expect(seed({ templateId: 'tpl-deleted' })).rejects.toMatchObject({
        code: PIPELINE_SEED_REFUSAL.templateMissing,
      });
      expect(getJsforceConnection).not.toHaveBeenCalled();
    });

    it('runs the template it names, as the page sends it', async () => {
      await seed();

      expect(executed).toHaveLength(1);
      expect(executed[0]).toMatchObject({ id: CRM_STARTER.id, name: CRM_STARTER.name });
      expect(executed[0].objects.map((o) => o.objectApiName)).toEqual(
        CRM_STARTER.objects.map((o) => o.objectApiName),
      );
    });
  });

  describe('the storage, the requests and the emails', () => {
    it('refuses a template past the storage the org has left, approved or not', async () => {
      await expect(
        seed({ templateId: SALES_CLOUD_STARTER.id, answer: { approved: true } }),
      ).rejects.toMatchObject({
        code: 'SEED_STORAGE_EXCEEDED',
        message: expect.stringMatching(/my-dev-org has 5 MB left of 5 MB.*Nothing was written\.$/),
      });
      expect(executed).toEqual([]);
      expect(rowsWritten()).toBe(0);
    });

    it('refuses a seed past the API requests the org has left today, approved or not', async () => {
      limits = { ...limits, DailyApiRequests: { Max: 15_000, Remaining: 2 } };

      await expect(seed({ answer: { approved: true } })).rejects.toMatchObject({
        code: 'API_BUDGET_EXCEEDED',
      });
      expect(rowsWritten()).toBe(0);
    });

    it('refuses a seed whose org will not say its storage when no Approval approved it, writing nothing', async () => {
      // The page's seed goes on there when nobody can be asked: a pipeline's
      // has nobody watching, and nobody approved it.
      limits = { DailyApiRequests: { Max: 15_000, Remaining: 15_000 } };

      await expect(seed()).rejects.toMatchObject({
        code: PIPELINE_SEED_REFUSAL.unanswered,
        message: expect.stringMatching(
          /^The seed needed an answer before it wrote — the data storage my-dev-org has left could not be read .* no Approval step before it approved the run/,
        ),
      });
      expect(executed).toEqual([]);
      expect(rowsWritten()).toBe(0);
      expect(trail()).toEqual([
        expect.objectContaining({
          outcome: 'stopped',
          details: { code: PIPELINE_SEED_REFUSAL.unanswered },
        }),
      ]);
    });

    it('seeds the same org once an Approval approved the run, putting no question to anyone', async () => {
      limits = { DailyApiRequests: { Max: 15_000, Remaining: 15_000 } };

      const outcome = await seed({ answer: { approved: true } });

      expect(outcome.result.status).toBe('success');
      expect(rowsWritten()).toBe(2);
      expect(requestRunConfirmation).not.toHaveBeenCalled();
      expect(outcome.warnings).toContainEqual(
        expect.stringMatching(/^the data storage the org has left could not be read/),
      );
    });

    it('refuses a seed that would leave the org short of its requests when no Approval approved it', async () => {
      limits = { ...limits, DailyApiRequests: { Max: 15_000, Remaining: 300 } };

      await expect(seed()).rejects.toMatchObject({
        code: PIPELINE_SEED_REFUSAL.unanswered,
        message: expect.stringContaining('daily API requests'),
      });
      expect(rowsWritten()).toBe(0);
      expect((await seed({ answer: { approved: true } })).result.status).toBe('success');
    });

    it('refuses a seed past the emails the org has left today, approved or not, and seeds a template that sends none', async () => {
      read.mockImplementation(async (_orgId, objects) => automationOf(objects, true));

      await expect(seed({ answer: { approved: true } })).rejects.toMatchObject({
        code: 'SEED_EMAILS_EXCEEDED',
        message: expect.stringContaining('"Welcome Email"'),
      });
      expect(rowsWritten()).toBe(0);

      saved(accounts(5));
      expect((await seed({ templateId: 'tpl-accounts' })).result.status).toBe('success');
    });
  });

  describe('what it says and what it keeps', () => {
    it('says what the org runs as the records are created, as the confirmation does before Start', async () => {
      read.mockImplementation(async (_orgId, objects) => ({
        ...automationOf(objects, true),
        objects: automationOf(objects, true).objects.map((object) => ({
          ...object,
          flows: object.flows.map((flow) => ({ ...flow, messages: [] })),
        })),
      }));

      const outcome = await seed();

      expect(outcome.automation[0]).toBe(
        'target automation: what my-dev-org runs as these records are created',
      );
      expect(outcome.automation).toContainEqual(expect.stringContaining('flow "Welcome Email"'));
    });

    it('says so when what the org runs could not be read, and seeds all the same', async () => {
      read.mockRejectedValue(new Error('INSUFFICIENT_ACCESS'));

      const outcome = await seed();

      expect(outcome.result.status).toBe('success');
      expect(outcome.automation).toEqual([
        expect.stringMatching(/could not be read \(INSUFFICIENT_ACCESS\)/),
      ]);
    });

    it('keeps the run in the file the page keeps its seeds in, naming the pipeline, every id whole', async () => {
      let n = 0;
      create.mockImplementation(async (rows: unknown[]) =>
        rows.map(() => ({ success: true, id: fakeId('001', ++n) })),
      );
      const many = Array.from({ length: 1_500 }, (_, i) => fakeId('003', i + 1));
      finish = async (_deps, created, runId) => ({
        templateId: CRM_STARTER.id,
        operationId: runId,
        status: 'success',
        objectResults: [
          {
            objectApiName: 'Account',
            recordsCreated: created.length,
            recordsFailed: 0,
            createdIds: created,
            errors: [],
          },
          {
            objectApiName: 'Contact',
            recordsCreated: many.length,
            recordsFailed: 0,
            createdIds: many,
            errors: [],
          },
        ],
        totalRecordsCreated: created.length + many.length,
        totalRecordsFailed: 0,
        duration: 1,
        timestamp: '2026-10-28T00:00:00.000Z',
      });

      const outcome = await seed();

      expect(outcome.operationId).toMatch(/^seed:pipeline:/);
      // Whole, where the page is posted a thousand ids an object at most.
      expect(outcome.result.objectResults[1].createdIds).toHaveLength(1_500);
      const kept = await nodeSeedRunCreations(storage).get(outcome.runId);
      expect(kept).toMatchObject({
        pipeline: { name: 'Nightly refresh' },
        targetOrgId: 'org-dev',
        end: { status: 'success' },
      });
      expect(kept?.created.find((o) => o.objectApiName === 'Contact')?.ids).toHaveLength(1_500);
    });

    it('lists the run in Live Operations and records it in the audit trail, as the page does', async () => {
      const outcome = await seed();

      expect(registry.get(outcome.operationId)).toMatchObject({
        module: 'seed',
        status: 'completed',
        description: `Pipeline seed of ${CRM_STARTER.name}`,
      });
      expect(tracker.get(outcome.operationId)?.status).toBe('completed');
      expect(trail()).toEqual([
        expect.objectContaining({
          operationId: outcome.operationId,
          action: 'seed_execute',
          outcome: 'success',
          guard: 'allowed',
          objects: [expect.objectContaining({ objectApiName: 'Account', created: 2 })],
        }),
      ]);
      // No page waits on it: what is posted is correlated to no request of one.
      expect(posted('seed:execute:response')[0]?.correlationId).toBe(outcome.operationId);
    });

    it('rejects with the error of a run that failed, its run ended failed', async () => {
      const ends: string[] = [];
      registry.onEvent((id, type) => {
        if (id.startsWith('seed:pipeline:') && ['completed', 'failed', 'aborted'].includes(type)) {
          ends.push(type);
        }
      });
      finish = async () => {
        throw new Error('INVALID_SESSION_ID: Session expired or invalid');
      };

      await expect(seed()).rejects.toThrow('INVALID_SESSION_ID: Session expired or invalid');
      const [kept] = await nodeSeedRunCreations(storage).list();
      expect(kept).toMatchObject({
        pipeline: { name: 'Nightly refresh' },
        end: { status: 'failure' },
      });
      expect(ends).toEqual(['failed']);
    });
  });

  describe('a cancel', () => {
    /** Settles once the signal is aborted, or after `ms` when it is not. */
    function abortedOrAfter(signal: AbortSignal | undefined, ms: number): Promise<boolean> {
      return new Promise((resolve) => {
        if (signal?.aborted) return resolve(true);
        const timer = setTimeout(() => resolve(false), ms);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
    }

    it("stops the run on the step's signal, through Live Operations, with what it wrote before the stop", async () => {
      const step = new AbortController();
      finish = async (seedDeps, created, runId) => {
        step.abort();
        const aborted = await abortedOrAfter(seedDeps.signal, 200);
        return aborted
          ? {
              templateId: CRM_STARTER.id,
              operationId: runId,
              status: 'partial',
              cancelled: true,
              objectResults: [
                {
                  objectApiName: 'Account',
                  recordsCreated: created.length,
                  recordsFailed: 0,
                  createdIds: created,
                  errors: [],
                },
              ],
              totalRecordsCreated: created.length,
              totalRecordsFailed: 0,
              duration: 1,
              timestamp: '2026-10-28T00:00:00.000Z',
            }
          : undefined;
      };

      const outcome = await seed({}, step.signal);

      expect(outcome.result.cancelled).toBe(true);
      expect(outcome.result.totalRecordsCreated).toBe(2);
      expect(registry.get(outcome.operationId)?.status).toBe('aborted');
      expect(tracker.get(outcome.operationId)?.status).toBe('cancelled');
    });

    it('writes nothing when the step was cancelled before the run started', async () => {
      const step = new AbortController();
      step.abort();

      const refused = seed({}, step.signal);

      await expect(refused).rejects.toBeInstanceOf(StepCancelledError);
      expect(executed).toEqual([]);
      expect(rowsWritten()).toBe(0);
      expect(trail()).toEqual([
        expect.objectContaining({ outcome: 'stopped', details: { code: 'ABORTED_BEFORE_START' } }),
      ]);
    });
  });
});
