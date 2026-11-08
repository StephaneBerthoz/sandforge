import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  BaseMessage,
  ForgeTargetAutomation,
  FrozenLoadAutomationInfo,
  FrozenLoadEmailsInfo,
  FrozenLoadPlanInfo,
  FrozenLoadReportInfo,
  FrozenProjectConfig,
} from '@sandforge/shared';

import { FrozenDatasetHandler } from './FrozenDatasetHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import {
  buildFrozenManifest,
  type FrozenDatasetLoaderDeps,
  type FrozenLoadOptions,
} from '../../modules/frozendataset/index.js';
import { EMAIL_NOT_PERMITTED } from '../../modules/forge/targetDeliverability.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { inboundRequest } from '../../test/mockFactories.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

/**
 * A Frozen load's gate on the emails, through the panel's handler, against a
 * target that answers as an org does: `/limits` with its daily emails, the
 * one line of anonymous Apex that reads its deliverability, and its user's
 * Send Email. The loader is scripted: what is tested is what stands before
 * its first write.
 */
const loaderLoad = vi.hoisted(() => vi.fn());
const loaderPlan = vi.hoisted(() => vi.fn());
vi.mock('../../modules/frozendataset/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../modules/frozendataset/index.js')>();
  return {
    ...actual,
    FrozenDatasetLoader: vi.fn().mockImplementation(function (deps: FrozenDatasetLoaderDeps) {
      return {
        gateLoad: async () => 'allowed',
        load: (options: FrozenLoadOptions) => loaderLoad(options, deps),
        planLoad: () => loaderPlan(),
      };
    }),
  };
});

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

const TARGET_ORG = 'org-dev';

/** The trap Developer Edition's contact flow: two single emails a contact, quiet for `Load_Data`. */
function contactsEmailed(
  _orgId: string,
  objects: readonly string[],
): Promise<ForgeTargetAutomation> {
  return Promise.resolve({
    objectsRead: [...objects],
    objects: objects.includes('Contact')
      ? [
          {
            objectApiName: 'Contact',
            flows: [
              {
                apiName: 'Contact_Welcome',
                label: 'Contact welcome',
                timing: 'afterSave',
                startsOn: 'create',
                condition: 'read',
                permissions: [{ name: 'Load_Data', bypass: true }],
                messages: [
                  { kind: 'email', name: 'Send welcome', limit: 'SingleEmail' },
                  { kind: 'email', name: 'Send reminder', limit: 'SingleEmail' },
                ],
              },
            ],
            triggers: [],
          },
        ]
      : [],
    bypassGrants: [
      {
        permission: 'Load_Data',
        permissionSets: [{ name: 'Data_Load', label: 'Data load', grants: 1 }],
      },
    ],
    unread: [],
  } as unknown as ForgeTargetAutomation);
}

/** A completed load of the dataset, as the loader reports it. */
function loadReport(): Record<string, unknown> {
  return {
    status: 'completed',
    orgId: TARGET_ORG,
    mode: { pilot: false, reload: false },
    startedAt: '2026-11-04T09:00:00.000Z',
    durationMs: 10,
    alignment: {
      objectResults: [],
      excludedObjects: [],
      removals: [],
      adjustments: [],
      recordTypeIssues: [],
    },
    placeholders: [],
    requiredDefaults: [],
    perObject: [],
    pass2: { resolved: 0, unresolved: [] },
    personContact: { restored: 0, sent: [], unresolved: [] },
    statuses: { restored: 0, refused: [] },
    purge: { deleted: {}, deactivated: {}, failures: [] },
    mappingPath: '',
    contractPath: path.join(os.tmpdir(), 'no-such-contract.json'),
  };
}

function buildMsg(type: string, payload?: unknown): InboundRequest {
  return inboundRequest({
    id: `req-${type}`,
    type,
    timestamp: Date.now(),
    ...(payload !== undefined ? { payload } : {}),
  } as BaseMessage);
}

describe('a Frozen load, what still runs as it writes, and the emails it sends', () => {
  let sasDir: string;
  let deps: HandlerDeps;
  let store: ConfigStore;
  let handler: FrozenDatasetHandler;
  /** The deliverability the org answers the anonymous Apex with. */
  let level: 'all' | 'withheld';
  /** The single emails the org has left today, of 15. */
  let remaining: number;
  /** What the org was asked, by URL. */
  let asked: string[];

  const posted = <T extends BaseMessage>(type: string): T[] =>
    vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as T)
      .filter((m) => m.type === type);
  const errorOf = () =>
    posted<
      BaseMessage & {
        payload: {
          code: string;
          message: string;
          emails?: FrozenLoadEmailsInfo;
          automation?: FrozenLoadAutomationInfo;
          orgId?: string;
        };
      }
    >('frozen:load:error')[0]?.payload;
  /**
   * A load, the flow that runs on the contacts it inserts accepted unless
   * told otherwise: what most of these judge is the emails it sends.
   */
  const load = (payload: Record<string, unknown> = {}) =>
    handler.handle(
      buildMsg('frozen:load', { targetOrgId: TARGET_ORG, acceptAutomation: true, ...payload }),
    );

  /** The dataset: three contacts. */
  function writeDataset(): void {
    const datasetDir = path.join(sasDir, 'dataset');
    fs.mkdirSync(path.join(datasetDir, 'data'), { recursive: true });
    const manifest = buildFrozenManifest({
      version: '1.2.0',
      source: { orgId: '00D000000000002AAA', decisionDate: '2026-09-01' },
      saltFingerprint: 'abcdef012345',
      rulesVersion: '1.0.0',
      volumetry: { budgetMax: 100, measured: {}, measuredAt: '2026-09-01T00:00:00.000Z' },
      nonReidentification: {
        passed: true,
        checks: [],
        author: 'qa',
        checkedAt: '2026-09-01T00:00:00.000Z',
      },
      author: 'qa',
    });
    fs.writeFileSync(path.join(datasetDir, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(
      path.join(datasetDir, 'data', 'Contact.json'),
      JSON.stringify({
        objectApiName: 'Contact',
        records: ['C1', 'C2', 'C3'].map((referenceId) => ({
          referenceId,
          fields: { LastName: referenceId },
        })),
      }),
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    level = 'all';
    remaining = 15;
    asked = [];
    sasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandforge-frozen-emails-'));
    writeDataset();
    const config: FrozenProjectConfig = { rootObject: 'Contact', axes: [], edgeCases: [], sasDir };
    store = new ConfigStore(new InMemoryConfigStoreBackend());
    store.initialize();
    store.set('frozen:config', config, 'frozen');
    let n = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn().mockReturnValue({ orgType: 'Developer', alias: 'DEV' }),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as HandlerDeps['orgRegistry'],
      configStore: store,
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      infraServices: {
        productionGuard: new ProductionGuard(),
      } as unknown as HandlerDeps['infraServices'],
      nextId: () => String(++n),
    };
    handler = new FrozenDatasetHandler(deps);
    handler.setTargetAutomation({ read: contactsEmailed });
    // The org as it answers the reads of the gate: its limits, the line of
    // Apex that sends nothing, and its user's Send Email after a refusal.
    vi.mocked(getJsforceConnection).mockResolvedValue({
      query: async () => ({ records: [{ Id: '00D000000000009AAA' }], done: true, totalSize: 1 }),
      request: async ({ url }: { url: string }) => {
        asked.push(url);
        if (url === '/limits') {
          return {
            SingleEmail: { Max: 15, Remaining: remaining },
            DailyWorkflowEmails: { Max: 8040, Remaining: 8040 },
          };
        }
        if (url.startsWith('/tooling/executeAnonymous')) {
          return level === 'all'
            ? { compiled: true, success: true }
            : { compiled: true, success: false, exceptionMessage: EMAIL_NOT_PERMITTED };
        }
        if (url.includes('UserPermissionAccess')) {
          return { records: [{ PermissionsEmailSingle: true }] };
        }
        throw new Error(`not answered: ${url}`);
      },
    } as never);
    loaderLoad.mockResolvedValue(loadReport());
  });

  afterEach(() => {
    fs.rmSync(sasDir, { recursive: true, force: true });
  });

  it('refuses a load into an org that delivers them, before its first write, without the accord', async () => {
    // A load counted none, read nothing and took no accord: its contacts went
    // in, the flow emailing each.
    await load();

    expect(loaderLoad).not.toHaveBeenCalled();
    const error = errorOf();
    expect(error?.code).toBe('EMAILS_NOT_ACCEPTED');
    expect(error?.message).toContain('Add --accept-emails to load all the same');
    expect(error?.emails).toMatchObject({
      verdict: 'asks',
      accepted: false,
      counted: expect.arrayContaining([
        expect.objectContaining({
          limit: 'SingleEmail',
          emails: 6,
          verdict: 'fits',
          remaining: 15,
        }),
      ]),
      deliverability: { reading: { level: 'all' } },
    });
    expect(error?.orgId).toBe(TARGET_ORG);
    expect(new AuditTrailStore(store).list().entries).toEqual([
      expect.objectContaining({
        action: 'frozen_load',
        outcome: 'stopped',
        details: { code: 'EMAILS_NOT_ACCEPTED', deliverability: 'all' },
      }),
    ]);
  });

  it('loads with the accord, says what it read in the report, and records it went with it', async () => {
    await load({ acceptEmails: true });

    expect(loaderLoad).toHaveBeenCalledTimes(1);
    const report = posted<BaseMessage & { payload: { report: FrozenLoadReportInfo } }>(
      'frozen:load:response',
    )[0]?.payload.report;
    expect(report?.emails).toMatchObject({ verdict: 'asks', accepted: true });
    expect(new AuditTrailStore(store).list().entries).toEqual([
      expect.objectContaining({
        outcome: 'success',
        details: expect.objectContaining({ deliverability: 'all', confirmed: 'emails' }),
      }),
    ]);
  });

  it('asks nothing of an org that delivers none of them', async () => {
    level = 'withheld';

    await load();

    expect(errorOf()).toBeUndefined();
    expect(loaderLoad).toHaveBeenCalledTimes(1);
  });

  it('refuses past the single emails the org has left today, accorded or not', async () => {
    remaining = 4;

    await load({ acceptEmails: true });

    expect(loaderLoad).not.toHaveBeenCalled();
    expect(errorOf()?.code).toBe('FROZEN_EMAILS_EXCEEDED');
    expect(errorOf()?.message).toContain('about 6 single emails, 4 of 15 left today');
  });

  it('reads nothing of the org when what still runs sends none', async () => {
    handler.setTargetAutomation({
      read: async (_orgId, objects) =>
        ({ objectsRead: [...objects], objects: [], bypassGrants: [], unread: [] }) as never,
    });

    await load();

    expect(loaderLoad).toHaveBeenCalledTimes(1);
    expect(asked).toEqual([]);
  });

  it('refuses a load while the target runs automation on what it inserts, unaccepted, naming it, and asks the org nothing more', async () => {
    // Read only for its emails, a load into an org whose flow after save
    // deleted each opportunity product it inserted ran it unasked, and only
    // its verification saw it. The org here delivers no email: what the
    // load meets is the question on what runs.
    level = 'withheld';

    await load({ acceptAutomation: false });

    expect(loaderLoad).not.toHaveBeenCalled();
    const error = errorOf();
    expect(error?.code).toBe('AUTOMATION_NOT_ACCEPTED');
    expect(error?.message).toBe(
      'DEV runs automation as this load inserts its records and updates them: Contact: flow ' +
        '"Contact welcome" (insert). With --mute-automation, the load assigns Data_Load to the ' +
        'user it writes as for the load alone, under a lease, and what it keeps quiet does not ' +
        'fire. Nothing was written. Add --accept-automation to load all the same, or turn that ' +
        'automation off in DEV first.',
    );
    expect(error?.automation).toMatchObject({
      firing: [
        { objectApiName: 'Contact', kind: 'flow', name: 'Contact welcome', writes: ['insert'] },
      ],
      accepted: false,
      refused: { code: 'AUTOMATION_NOT_ACCEPTED' },
    });
    expect(error?.orgId).toBe(TARGET_ORG);
    // Refused before the emails are judged: no limit read, no Apex run.
    expect(asked).toEqual([]);
    expect(new AuditTrailStore(store).list().entries).toEqual([
      expect.objectContaining({
        action: 'frozen_load',
        outcome: 'stopped',
        details: expect.objectContaining({ code: 'AUTOMATION_NOT_ACCEPTED' }),
      }),
    ]);
  });

  it('loads with the accord, saying in its report what ran', async () => {
    level = 'withheld';

    await load({ acceptAutomation: true });

    expect(loaderLoad).toHaveBeenCalledTimes(1);
    const report = posted<BaseMessage & { payload: { report: FrozenLoadReportInfo } }>(
      'frozen:load:response',
    )[0]?.payload.report;
    expect(report?.automation).toEqual({
      firing: [
        { objectApiName: 'Contact', kind: 'flow', name: 'Contact welcome', writes: ['insert'] },
      ],
      accepted: true,
    });
  });

  it('says in its preview what runs and that a load would be refused for it, then not once accepted', async () => {
    loaderPlan.mockResolvedValue({
      orgId: TARGET_ORG,
      mode: { pilot: false, reload: false },
      plannedAt: '2026-11-04T09:00:00.000Z',
      perObject: [],
      excludedObjects: [],
      removals: [],
      placeholders: [],
      requiredDefaults: [],
      recordTypeIssues: 0,
      personContacts: 0,
      earlierLoads: 0,
    });
    const planOf = async (payload: Record<string, unknown>) => {
      vi.mocked(deps.broker.postToWebview).mockClear();
      await handler.handle(
        buildMsg('frozen:load:preview', { targetOrgId: TARGET_ORG, ...payload }),
      );
      return posted<BaseMessage & { payload: { plan: FrozenLoadPlanInfo } }>(
        'frozen:load:preview:response',
      )[0]?.payload.plan;
    };

    expect((await planOf({}))?.automation).toMatchObject({
      firing: [{ objectApiName: 'Contact', name: 'Contact welcome' }],
      accepted: false,
      refused: { code: 'AUTOMATION_NOT_ACCEPTED' },
    });
    const accepted = (await planOf({ acceptAutomation: true }))?.automation;
    expect(accepted?.accepted).toBe(true);
    expect(accepted).not.toHaveProperty('refused');
    expect(loaderLoad).not.toHaveBeenCalled();
  });

  it('says in its preview what a load would meet, nothing written', async () => {
    loaderPlan.mockResolvedValue({
      orgId: TARGET_ORG,
      mode: { pilot: false, reload: false },
      plannedAt: '2026-11-04T09:00:00.000Z',
      perObject: [],
      excludedObjects: [],
      removals: [],
      placeholders: [],
      requiredDefaults: [],
      recordTypeIssues: 0,
      personContacts: 0,
      earlierLoads: 0,
    });

    await handler.handle(buildMsg('frozen:load:preview', { targetOrgId: TARGET_ORG }));

    const plan = posted<BaseMessage & { payload: { plan: FrozenLoadPlanInfo } }>(
      'frozen:load:preview:response',
    )[0]?.payload.plan;
    expect(plan?.emails).toMatchObject({
      verdict: 'asks',
      accepted: false,
      refused: { code: 'EMAILS_NOT_ACCEPTED' },
    });
    expect(loaderLoad).not.toHaveBeenCalled();
  });
});
