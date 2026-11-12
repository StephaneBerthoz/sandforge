import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  BaseMessage,
  ForgeTargetAutomation,
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
  ReloadTakesAlongError,
  SasReferenceIdMappingStore,
  type FrozenLoadOptions,
  type FrozenDatasetLoaderDeps,
} from '../../modules/frozendataset/index.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { tiedTargetOrg, type TiedTargetOrg } from '../../test/tiedTargetOrg.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));
vi.mock('../../core/common/sforceLimitParser.js', () => ({
  checkApiLimits: vi.fn(),
}));

/**
 * The loader's load, scripted: its purge as the loader runs it — the records
 * the load before created, children first, the sweep around them — on the
 * fake org, which deletes along what hangs from a record in cascade. What
 * the handler asks before it hands the reload over is what is tested.
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
        planLoad: (options: FrozenLoadOptions) => loaderPlan(options),
      };
    }),
  };
});

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

/** A fake record id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const TARGET_ORG = 'org-dev';
const ORGANIZATION = id('00D', 9);
/** The user the load wrote as, and the one who works in the target since. */
const USER = id('005', 1);
const ACCOUNT = id('001', 1);
const CONTACT = id('003', 1);
/** A contact made by hand under the load's account, once the load was through. */
const BY_HAND = id('003', 2);

/** The load the reload replaces, as the target dated it: to the second. */
const FIRST_WRITE = '2026-11-03T10:00:00.000Z';
const LAST_WRITE = '2026-11-03T10:00:04.000Z';
const ACCOUNT_MADE = '2026-11-03T10:00:02.000+0000';
const CONTACT_MADE = '2026-11-03T10:00:03.000+0000';
/** Seven minutes after the load: someone at work in the sandbox. */
const SINCE = '2026-11-03T10:07:31.000+0000';

/** The report of a reload whose purge took the account and the contact. */
function reloadReport(): Record<string, unknown> {
  return {
    status: 'completed',
    orgId: TARGET_ORG,
    mode: { pilot: false, reload: true },
    startedAt: '2026-11-03T11:00:00.000Z',
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
    purge: { deleted: { Contact: 1, Account: 1 }, deactivated: {}, failures: [] },
    mappingPath: '',
    contractPath: path.join(os.tmpdir(), 'no-such-contract.json'),
  };
}

/** What the target runs as records go: nothing. */
async function nothingRuns(
  _orgId: string,
  objects: readonly string[],
): Promise<ForgeTargetAutomation> {
  return {
    objectsRead: [...objects],
    objects: [],
    bypassGrants: [],
    unread: [],
  } as unknown as ForgeTargetAutomation;
}

function buildMsg(type: string, payload?: unknown): InboundRequest {
  return inboundRequest({
    id: `req-${type}`,
    type,
    timestamp: Date.now(),
    ...(payload !== undefined ? { payload } : {}),
  } as BaseMessage);
}

describe('a reload, whose purge deletes what the loads before it created', () => {
  let sasDir: string;
  let deps: HandlerDeps;
  let store: ConfigStore;
  let handler: FrozenDatasetHandler;
  let tied: TiedTargetOrg;

  const posted = <T extends BaseMessage>(type: string): T[] =>
    vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as T)
      .filter((m) => m.type === type);
  const report = (): FrozenLoadReportInfo | undefined =>
    posted<BaseMessage & { payload: { report: FrozenLoadReportInfo } }>('frozen:load:response')[0]
      ?.payload.report;
  const errors = (type = 'frozen:load:error') =>
    posted<BaseMessage & { payload: { code: string; message: string } }>(type).map(
      (m) => m.payload,
    );
  const reload = (payload: Record<string, unknown> = {}) =>
    handler.handle(buildMsg('frozen:load', { targetOrgId: TARGET_ORG, reload: true, ...payload }));

  /**
   * The target as a scratch org answers: dated to the second, an account's
   * contacts deleted along with it. It holds the account and the contact the
   * load wrote.
   */
  function targetOrg(): TiedTargetOrg {
    const org = tiedTargetOrg(USER);
    org.shape('Organization', { fields: ['Id'] });
    org.add('Organization', { Id: ORGANIZATION });
    org.shape('Account', {
      children: [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: true }],
    });
    org.shape('Contact', { references: { AccountId: ['Account'] } });
    org.add('Account', made(ACCOUNT, 'Loaded account', ACCOUNT_MADE));
    org.add('Contact', made(CONTACT, 'Loaded contact', CONTACT_MADE, { AccountId: ACCOUNT }));
    return org;
  }

  function made(recordId: string, name: string, at: string, more = {}) {
    return {
      Id: recordId,
      Name: name,
      CreatedById: USER,
      CreatedDate: at,
      LastModifiedDate: at,
      LastModifiedById: USER,
      SystemModstamp: at,
      ...more,
    };
  }

  /** The dataset loaded again: an account and a contact. */
  function writeDataset(): void {
    const datasetDir = path.join(sasDir, 'dataset');
    fs.mkdirSync(path.join(datasetDir, 'data'), { recursive: true });
    const manifest = buildFrozenManifest({
      version: '1.2.0',
      source: { orgId: id('00D', 2), decisionDate: '2026-09-01' },
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
    const data = (objectApiName: string, ids: string[]) =>
      JSON.stringify({
        objectApiName,
        records: ids.map((referenceId) => ({ referenceId, fields: { Name: referenceId } })),
      });
    fs.writeFileSync(path.join(datasetDir, 'data', 'Account.json'), data('Account', ['A1']));
    fs.writeFileSync(path.join(datasetDir, 'data', 'Contact.json'), data('Contact', ['C1']));
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    sasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandforge-frozen-reload-purge-'));
    writeDataset();
    const config: FrozenProjectConfig = {
      rootObject: 'Account',
      axes: [],
      edgeCases: [],
      sasDir,
    };
    store = new ConfigStore(new InMemoryConfigStoreBackend());
    store.initialize();
    store.set('frozen:config', config, 'frozen');
    let n = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn().mockReturnValue({ orgType: 'Sandbox', alias: 'DEV' }),
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
    handler.setTargetAutomation({ read: vi.fn(nothingRuns) });
    tied = targetOrg();
    vi.mocked(getJsforceConnection).mockResolvedValue(tied.conn as never);
    await new SasReferenceIdMappingStore(sasDir, {
      orgId: TARGET_ORG,
      organizationId: ORGANIZATION,
      now: () => new Date(LAST_WRITE),
    }).persist(
      new Map([
        ['Account-000001', ACCOUNT],
        ['Contact-000001', CONTACT],
      ]),
      {
        created: [
          { objectApiName: 'Account', referenceIds: ['Account-000001'] },
          { objectApiName: 'Contact', referenceIds: ['Contact-000001'] },
        ],
        startedAt: new Date(FIRST_WRITE),
        writtenBetween: { first: FIRST_WRITE, last: LAST_WRITE },
        runUserId: USER,
      },
    );
    // The purge as the loader runs it: the sweep's first part, the records
    // the load before created — its contact, then its account — and the
    // sweep's last part.
    loaderPlan.mockRejectedValue(new Error('planned past the gate'));
    loaderLoad.mockImplementation(async (options: FrozenLoadOptions) => {
      await options.purgeSweep?.first();
      for (const [object, ids] of [
        ['Contact', [CONTACT]],
        ['Account', [ACCOUNT]],
      ] as const) {
        const left = ids.filter((recordId) => tied.row(object, recordId) !== undefined);
        if (left.length > 0) await tied.conn.sobject(object).destroy([...left]);
      }
      if (!options.signal?.aborted) await options.purgeSweep?.afterPurge();
      return reloadReport();
    });
  });

  afterEach(() => {
    fs.rmSync(sasDir, { recursive: true, force: true });
  });

  describe('of a load one of whose accounts holds a contact made by hand since', () => {
    beforeEach(() => {
      tied.add('Contact', made(BY_HAND, 'Made by hand', SINCE, { AccountId: ACCOUNT }));
    });

    it('is refused before anything is written, naming what holds the account, and the contact stays', async () => {
      // Sent as it was, the purge deleted the load's account, the org took
      // the contact made by hand along with it, and the reload said success.
      await reload();

      expect(tied.ids('Contact')).toEqual([CONTACT, BY_HAND]);
      expect(tied.ids('Account')).toEqual([ACCOUNT]);
      expect(report()?.status).toBeUndefined();
      expect(tied.deletes).toEqual([]);
      expect(loaderLoad).not.toHaveBeenCalled();
      const [refusal] = errors();
      expect(refusal?.code).toBe('REPLACE_LEAVES_RECORDS');
      expect(refusal?.message).toContain(
        'A removal of the loads this reload replaces would leave 1 of their records in the org — ' +
          'Account (1: 1 kept for records that stay under them (Contact))',
      );
      expect(refusal?.message).toContain('Nothing was written.');
      expect(refusal?.message).toContain(
        'records changed since, and what was added under them since, go too when it is told to include them',
      );
      expect(
        new AuditTrailStore(store).list().entries.find((entry) => entry.action === 'frozen_load'),
      ).toMatchObject({ outcome: 'stopped', details: { code: 'REPLACE_LEAVES_RECORDS' } });
    });

    it('is refused the same way by its dry run, which says what the purge would take along', async () => {
      await handler.handle(
        buildMsg('frozen:load:preview', { targetOrgId: TARGET_ORG, reload: true }),
      );

      const [refusal] = errors('frozen:load:preview:error');
      expect(refusal?.code).toBe('REPLACE_LEAVES_RECORDS');
      expect(refusal?.message).toContain(
        'Account (1: 1 kept for records that stay under them (Contact))',
      );
      expect(tied.deletes).toEqual([]);
    });

    it('is refused when the reload sweeps too: the sweep takes what the automation made, not what was made by hand', async () => {
      await reload({ sweep: true });

      expect(errors()[0]?.code).toBe('REPLACE_LEAVES_RECORDS');
      expect(tied.ids('Contact')).toEqual([CONTACT, BY_HAND]);
    });

    it('lets its dry run by when told the contact is taken back before the reload runs, and never the reload itself', async () => {
      // An environment's apply takes back first what a resource drew under the
      // loaded accounts: its dry run, read before that, is told so.
      await handler.handle(
        buildMsg('frozen:load:preview', {
          targetOrgId: TARGET_ORG,
          reload: true,
          goneFirst: [BY_HAND],
        }),
      );
      await reload({ goneFirst: [BY_HAND] });

      // Past the gate, the preview plans the load, which this harness stops.
      expect(errors('frozen:load:preview:error')[0]?.code).not.toBe('REPLACE_LEAVES_RECORDS');
      expect(errors()[0]?.code).toBe('REPLACE_LEAVES_RECORDS');
      expect(tied.ids('Contact')).toEqual([CONTACT, BY_HAND]);
    });

    it('goes on once that contact no longer hangs from the account', async () => {
      tied.row('Contact', BY_HAND)!.AccountId = null;

      await reload();

      expect(errors()).toEqual([]);
      expect(loaderLoad).toHaveBeenCalledTimes(1);
      expect(tied.ids('Contact')).toEqual([BY_HAND]);
      expect(report()?.status).toBe('completed');
    });
  });

  it('goes on when what hangs from the load’s records came with the load: made as it wrote, unchanged since', async () => {
    // A contact the target's automation made under the account as the load
    // wrote it, in the same second: it came with the load, and goes with it.
    tied.add(
      'Contact',
      made(BY_HAND, 'Made with the account', ACCOUNT_MADE, { AccountId: ACCOUNT }),
    );

    await reload();

    expect(errors()).toEqual([]);
    expect(loaderLoad).toHaveBeenCalledTimes(1);
    expect(tied.ids('Contact')).toEqual([]);
  });

  describe('of a load one of whose accounts holds a contact that came with it, to which someone added a campaign member since', () => {
    /** The contact the target's automation made as the load wrote the account. */
    const CAME_WITH_IT = id('003', 3);
    /** A campaign member someone else added to that contact, seven minutes later. */
    const MEMBER = id('00v', 1);
    const COLLEAGUE = id('005', 2);

    beforeEach(() => {
      tied.shape('Contact', {
        references: { AccountId: ['Account'] },
        children: [{ childSObject: 'CampaignMember', field: 'ContactId', cascadeDelete: true }],
      });
      tied.shape('CampaignMember', { references: { ContactId: ['Contact'] } });
      tied.add(
        'Contact',
        made(CAME_WITH_IT, 'Made with the account', ACCOUNT_MADE, { AccountId: ACCOUNT }),
      );
      tied.add('CampaignMember', {
        ...made(MEMBER, 'Added by hand', SINCE, { ContactId: CAME_WITH_IT }),
        CreatedById: COLLEAGUE,
        LastModifiedById: COLLEAGUE,
      });
    });

    it('is refused before anything is written, naming both, and the member stays', async () => {
      // Read one level down only, the contact came with the load and went with
      // the account; the org took the campaign member along with the contact,
      // and the reload said success.
      await reload();

      expect(loaderLoad).not.toHaveBeenCalled();
      expect(tied.deletes).toEqual([]);
      expect(tied.ids('CampaignMember')).toEqual([MEMBER]);
      expect(tied.ids('Contact')).toEqual([CONTACT, CAME_WITH_IT]);
      const [refusal] = errors();
      expect(refusal?.code).toBe('REPLACE_LEAVES_RECORDS');
      expect(refusal?.message).toContain(
        'A removal of the loads this reload replaces would leave 1 of their records in the org — ' +
          'Account (1: 1 kept for records that stay under them (Contact, CampaignMember))',
      );
      expect(refusal?.message).toContain(
        'records changed since, and what was added under them since, go too when it is told to include them',
      );
    });

    it('is refused the same way by its dry run', async () => {
      await handler.handle(
        buildMsg('frozen:load:preview', { targetOrgId: TARGET_ORG, reload: true }),
      );

      expect(errors('frozen:load:preview:error')[0]).toMatchObject({
        code: 'REPLACE_LEAVES_RECORDS',
        message: expect.stringContaining(
          'Account (1: 1 kept for records that stay under them (Contact, CampaignMember))',
        ),
      });
      expect(tied.deletes).toEqual([]);
    });

    it('goes on, the contact going with the account, once that member is no longer the contact’s', async () => {
      tied.row('CampaignMember', MEMBER)!.ContactId = null;

      await reload();

      expect(errors()).toEqual([]);
      expect(loaderLoad).toHaveBeenCalledTimes(1);
      expect(tied.ids('Contact')).toEqual([]);
      expect(tied.ids('CampaignMember')).toEqual([MEMBER]);
    });
  });

  describe('refused by its loader, which finds hanging from what the purge deletes a record it finds again', () => {
    const refused = () =>
      new ReloadTakesAlongError([{ objectApiName: 'Quote', count: 1, under: ['Opportunity'] }]);

    it('says so under the code of a reload that cannot replace the loads before it, nothing written', async () => {
      loaderLoad.mockRejectedValue(refused());

      await reload();

      expect(errors()[0]).toMatchObject({
        code: 'REPLACE_LEAVES_RECORDS',
        message: expect.stringContaining('Quote (1, under Opportunity)'),
      });
      expect(tied.deletes).toEqual([]);
      expect(
        new AuditTrailStore(store).list().entries.find((entry) => entry.action === 'frozen_load'),
      ).toMatchObject({ outcome: 'stopped', details: { code: 'REPLACE_LEAVES_RECORDS' } });
    });

    it('says so the same way in its dry run', async () => {
      loaderPlan.mockRejectedValue(refused());

      await handler.handle(
        buildMsg('frozen:load:preview', { targetOrgId: TARGET_ORG, reload: true }),
      );

      expect(errors('frozen:load:preview:error')[0]).toMatchObject({
        code: 'REPLACE_LEAVES_RECORDS',
        message: expect.stringContaining('Quote (1, under Opportunity)'),
      });
    });
  });

  describe('of a load one of whose accounts holds a contact made a few seconds after it, as the load’s user', () => {
    /** Twenty seconds after the account: what the target's automation may make for it. */
    const SOON_AFTER = '2026-11-03T10:00:22.000+0000';

    beforeEach(() => {
      tied.add('Contact', made(BY_HAND, 'Made soon after', SOON_AFTER, { AccountId: ACCOUNT }));
    });

    it('is refused without a sweep, saying a sweep takes it first', async () => {
      await reload();

      const [refusal] = errors();
      expect(refusal?.code).toBe('REPLACE_LEAVES_RECORDS');
      expect(refusal?.message).toContain(
        "Account (1: 1 kept for records that stay under them (Contact), 1 of them for what the target's automation likely made for the load, which a sweep takes first)",
      );
      expect(tied.ids('Contact')).toEqual([CONTACT, BY_HAND]);
    });

    it('goes on with a sweep, which takes it before the purge', async () => {
      await reload({ sweep: true });

      expect(errors().map((error) => error.code)).not.toContain('REPLACE_LEAVES_RECORDS');
      expect(loaderLoad).toHaveBeenCalledTimes(1);
      expect(tied.ids('Contact')).toEqual([]);
    });
  });
});
