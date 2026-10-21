/**
 * What a seed from the panel says of its org's automation before it writes,
 * and the emails it is held to: what the org runs as the records are
 * created, read for the confirmation (`seed:automation`), and a run refused
 * before anything is written when its records would take the org past the
 * emails it has left today.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseMessage, ForgeTargetAutomation, SeedTemplate } from '@sandforge/shared';
import { CRM_STARTER } from '@sandforge/shared';

import { SeedOpsHandler } from './SeedOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { ErrorResolver } from '../../modules/ai/ErrorResolver.js';
import type { AIProvider } from '../../modules/ai/types.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

/** A Developer Edition: 5 MB of data storage and its 15 single emails, all of them left. */
function developerEdition(singleLeft = 15) {
  const request = vi.fn(async () => ({
    DataStorageMB: { Max: 5, Remaining: 5 },
    SingleEmail: { Max: 15, Remaining: singleLeft },
    DailyWorkflowEmails: { Max: 8040, Remaining: 8040 },
  }));
  const query = vi.fn(async (soql: string): Promise<{ records: Array<Record<string, unknown>> }> =>
    soql.includes('FROM Organization')
      ? { records: [{ DefaultLocaleSidKey: 'en_US' }] }
      : { records: [] },
  );
  vi.mocked(getJsforceConnection).mockResolvedValue({ request, query } as never);
  return { request, query };
}

/** A contact flow that emails each contact created unless its user holds the bypass, and a workflow rule that does too. */
function contactAutomation(objects: readonly string[], held = false): ForgeTargetAutomation {
  const permissions = [{ name: 'Trap_Bypass_Flow', bypass: true, held }];
  return {
    objectsRead: [...objects],
    objects: [
      {
        objectApiName: 'Contact',
        flows: [
          {
            apiName: 'Welcome_Email',
            label: 'Welcome Email',
            timing: 'afterSave',
            startsOn: 'create',
            condition: 'read',
            permissions,
            paths: [{ kind: 'async' }],
            messages: [
              { kind: 'email', name: 'Send Welcome Email', limit: 'SingleEmail' },
              { kind: 'email', name: 'Send Follow Up Email', limit: 'SingleEmail' },
            ],
          },
        ],
        triggers: [],
        workflowRules: [
          {
            apiName: 'Contact_Welcome',
            label: 'Contact_Welcome',
            timing: 'afterSave',
            startsOn: 'create',
            condition: 'read',
            permissions,
            messages: [{ kind: 'email', name: 'Contact_Alert', limit: 'DailyWorkflowEmails' }],
          },
        ],
      },
    ],
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 25,
    bypassGrants: held
      ? []
      : [
          {
            permission: 'Trap_Bypass_Flow',
            permissionSets: [{ name: 'Trap_Bypass', label: 'Trap Bypass', grants: 2 }],
          },
        ],
    requests: 6,
  };
}

describe('SeedOpsHandler — the org automation and the emails', () => {
  let deps: HandlerDeps;
  let handler: SeedOpsHandler;
  let executed: SeedTemplate[];
  let guardChecks: ReturnType<typeof vi.spyOn>;
  const read =
    vi.fn<(orgId: string, objects: readonly string[]) => Promise<ForgeTargetAutomation>>();

  const posted = (type: string) =>
    vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: Record<string, unknown> })
      .filter((m) => m.type === type);

  beforeEach(() => {
    vi.clearAllMocks();
    read.mockReset();
    read.mockImplementation(async (_orgId, objects) => contactAutomation(objects));
    executed = [];
    let n = 0;
    const guard = new ProductionGuard();
    guardChecks = vi.spyOn(guard, 'check');
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn(() => ({ orgType: 'Developer', alias: 'my-dev-org' })),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as HandlerDeps['orgRegistry'],
      configStore: {
        get: vi.fn(),
        set: vi.fn(),
        getKeysByPrefix: vi.fn(() => []),
      } as unknown as HandlerDeps['configStore'],
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      infraServices: { productionGuard: guard } as HandlerDeps['infraServices'],
      services: {
        isAIEnabled: () => false,
        getSandforgeSetting: vi.fn((_key: string, fallback: unknown) => fallback),
        seedOrchestrator: vi.fn(() => ({
          execute: vi.fn(async (template: SeedTemplate) => {
            executed.push(template);
            return {
              templateId: template.id,
              operationId: 'op-1',
              status: 'success',
              objectResults: [],
              totalRecordsCreated: 0,
              totalRecordsFailed: 0,
              duration: 1,
              timestamp: '2026-10-20T00:00:00.000Z',
            };
          }),
        })),
      } as unknown as HandlerDeps['services'],
      nextId: () => String(++n),
    };
    handler = new SeedOpsHandler(deps);
    handler.setTargetAutomation({ read });
  });

  const ask = (payload: Record<string, unknown>) =>
    handler.handle(
      inboundRequest({ id: 'ask-1', type: 'seed:automation', timestamp: Date.now(), payload }),
    );
  const execute = (template: SeedTemplate) =>
    handler.handle(
      inboundRequest({
        id: 'seed-run',
        type: 'seed:execute',
        timestamp: Date.now(),
        payload: { orgId: 'org-1', template },
      }),
    );

  it('answers what the org runs as the records are created, and the emails it has left', async () => {
    developerEdition();
    await ask({ orgId: 'org-1', objects: ['Account', 'Contact'] });

    expect(read).toHaveBeenCalledWith('org-1', ['Account', 'Contact']);
    const [answer] = posted('seed:automation:response');
    expect(answer.correlationId).toBe('ask-1');
    expect(answer.payload).toMatchObject({
      orgId: 'org-1',
      objects: ['Account', 'Contact'],
      preview: {
        org: 'my-dev-org',
        objects: [
          {
            objectApiName: 'Contact',
            entries: [
              expect.objectContaining({ kind: 'workflowRule', emails: 1 }),
              expect.objectContaining({ kind: 'flow', name: 'Welcome Email', emails: 2 }),
            ],
          },
        ],
        limits: { SingleEmail: { max: 15, remaining: 15 } },
        alertsAsSingle: true,
        bypasses: [{ permission: 'Trap_Bypass_Flow', permissionSet: 'Trap_Bypass' }],
      },
    });
  });

  it('says on its own channel why the automation could not be read', async () => {
    developerEdition();
    read.mockRejectedValue(new Error('INVALID_SESSION_ID'));
    await ask({ orgId: 'org-1', objects: ['Contact'] });

    expect(posted('seed:automation:response')).toEqual([]);
    expect(posted('seed:automation:error')).toEqual([
      expect.objectContaining({
        correlationId: 'ask-1',
        payload: expect.objectContaining({ message: 'INVALID_SESSION_ID' }),
      }),
    ]);
  });

  it('refuses objects that are no API names before anything is read', async () => {
    developerEdition();
    await ask({ orgId: 'org-1', objects: ["Contact' OR Name != '"] });

    expect(read).not.toHaveBeenCalled();
    expect(posted('seed:automation:error')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ code: 'INVALID_PAYLOAD' }) }),
    ]);
  });

  it('refuses the CRM starter past the single emails the org has left, before the guard or any write', async () => {
    // 75 contacts seeded into a Developer Edition took its single emails
    // from 15 to -60, its workflow rule emailing each one.
    developerEdition();
    await execute(CRM_STARTER);

    expect(posted('seed:error')).toEqual([
      expect.objectContaining({
        correlationId: 'seed-run',
        payload: expect.objectContaining({
          code: 'SEED_EMAILS_EXCEEDED',
          retryable: false,
          message: expect.stringMatching(
            /^The seed was refused before it wrote anything: its records would make my-dev-org send about 225 single emails \(3 per Contact\), 15 of 15 left today\. .* Nothing was written\.$/,
          ),
          org: 'my-dev-org',
          limit: 'SingleEmail',
          emails: 225,
          remaining: 15,
          max: 15,
          objects: ['Contact'],
          senders: ['Contact_Welcome', 'Welcome Email'],
          bypasses: [
            {
              permission: 'Trap_Bypass_Flow',
              permissionSet: 'Trap_Bypass',
              quiets: ['Contact_Welcome', 'Welcome Email'],
            },
          ],
        }),
      }),
    ]);
    expect(posted('operation:failed')).toHaveLength(1);
    expect(guardChecks).not.toHaveBeenCalled();
    expect(executed).toEqual([]);
  });

  it('asks the model nothing about its refusal, which names the org, its flows and its permission set', async () => {
    const provider = vi.fn<AIProvider>(() =>
      Promise.resolve(JSON.stringify({ explanation: 'why', suggestions: [], confidence: 0.4 })),
    );
    deps.errorResolver = new ErrorResolver(provider);
    const showFixSuggestion = vi.fn();
    deps.broker = {
      postToWebview: vi.fn(),
      panelCount: 1,
      showFixSuggestion,
    } as unknown as HandlerDeps['broker'];
    developerEdition();
    await execute(CRM_STARTER);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(posted('operation:failed')).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          error: expect.stringMatching(/my-dev-org.*"Welcome Email".*Trap_Bypass/),
        }),
      }),
    ]);
    expect(provider).not.toHaveBeenCalled();
    expect(showFixSuggestion).not.toHaveBeenCalled();
  });

  it('runs the seed once the user holds the bypass that keeps the senders quiet', async () => {
    developerEdition();
    read.mockImplementation(async (_orgId, objects) => contactAutomation(objects, true));
    await execute(CRM_STARTER);

    await vi.waitFor(() => expect(executed).toHaveLength(1));
    expect(posted('seed:error')).toEqual([]);
  });

  it('runs a seed whose org automation could not be read, and says so in the log', async () => {
    developerEdition(0);
    read.mockRejectedValue(new Error('INSUFFICIENT_ACCESS'));
    await execute(CRM_STARTER);

    await vi.waitFor(() => expect(executed).toHaveLength(1));
    expect(vi.mocked(deps.log).mock.calls.map(([line]) => line)).toContainEqual(
      expect.stringContaining('could not be read (INSUFFICIENT_ACCESS)'),
    );
  });
});
