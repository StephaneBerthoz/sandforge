import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OrgSafetyTier,
  recoveryAckKey,
  type OrgCheckpoint,
  type SalesforceOrg,
} from '@sandforge/shared';

import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { AuditTrailStore } from '../audit/auditTrail.js';
import { saveInventory } from '../audit/auditStore.js';
import { fingerprintOf } from '../checkpoint/checkpointFingerprint.js';
import {
  openCheckpointStore,
  organizationKey,
  type OrgCheckpointStore,
} from '../checkpoint/OrgCheckpointStore.js';
import type { ReplayEntry, ReplayListOptions } from '../checkpoint/replay/replayStore.js';
import { SasPathGuard, findRepoRoot } from '../frozendataset/SasPathGuard.js';
import { buildFrozenManifest, serializeManifest } from '../frozendataset/manifest.js';
import type { DetectedSandboxRefresh } from '../monitor/SandboxRefreshDetector.js';
import { UsersRunStore } from '../users/usersRunStore.js';
import {
  NO_REFRESH_KEY,
  frozenDatasetDirOf,
  recoveryFactsOf,
  type RecoveryFactsDeps,
} from './recoveryFacts.js';
import { recoveryHandoffPathOf } from './recoveryHandoff.js';
import { recoveryTestersKey, saveTesters } from './recoveryUsers.js';

/*
 * What SandForge keeps of a sandbox, read from the stores the command line
 * shares and from the window's own: of the org the sandbox is now, and of
 * the org it was before its refresh — never the one taken for the other.
 */

const BEFORE = '00Dxx00000AbCdE';
const AFTER = '00Dxx00000FgHiJ';
const HOST = 'acme--uat.sandbox.my.salesforce.com';
const guard = new SasPathGuard(findRepoRoot(process.cwd()));

const PRINT = fingerprintOf([
  { name: 'Id', type: 'id', createable: false, updateable: false, nillable: false },
]);

function sandbox(over: Partial<SalesforceOrg> = {}): SalesforceOrg {
  return {
    id: 'entry-uat',
    alias: 'UAT',
    username: 'admin@acme.test.uat',
    instanceUrl: `https://${HOST}`,
    orgId: `${BEFORE}AAA`,
    orgType: 'Sandbox',
    sandboxType: 'Full',
    authMethod: 'sfdx_import',
    safetyTier: OrgSafetyTier.MEDIUM,
    appearance: { color: '#4a9eff', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '62.0', edition: 'Enterprise Edition', features: [] },
    status: 'connected',
    lastConnected: '2026-11-01T08:00:00.000Z',
    tags: [],
    ...over,
  };
}

function refresh(over: Partial<DetectedSandboxRefresh> = {}): DetectedSandboxRefresh {
  return {
    orgId: 'entry-uat',
    detectedAt: '2026-11-18T08:12:00.000Z',
    evidence: 'connection',
    previousOrganizationId: BEFORE,
    organizationId: AFTER,
    ...over,
  };
}

/** A ready checkpoint of the sandbox as `organizationId`. */
function checkpointOf(
  organizationId: string,
  checkpointId: string,
  takenAt: string,
  expiresAt: string | null,
): OrgCheckpoint {
  return {
    version: 1,
    checkpointId,
    name: `Taken ${takenAt.slice(0, 10)}`,
    org: {
      organizationId: organizationKey(organizationId),
      alias: 'UAT',
      username: 'admin@acme.test.uat',
      instanceUrl: `https://${HOST}`,
      isSandbox: true,
      organizationType: 'Enterprise Edition',
      tier: 'sandbox',
    },
    takenBy: { userId: '005xx000001AbCdAAA', viewAllData: true, modifyAllData: true },
    readFrom: takenAt,
    takenAt,
    scope: { mode: 'everything', leftOut: [] },
    objects: [
      {
        objectApiName: 'Account',
        records: 2,
        inBin: 0,
        readOrder: 0,
        readMode: 'query',
        undeletable: true,
        cascadeParents: [],
        fingerprint: PRINT.digest,
        fields: ['Id'],
        leftOutFields: [],
      },
    ],
    ignoredFields: [],
    snapshotId: 'op-1',
    movedWhileTaken: { changed: 0, deleted: 0, created: 0 },
    bytes: 1024,
    expiresAt,
    status: 'ready',
    takenOn: { host: 'workstation', pid: 4242 },
  };
}

let dir: string;
let configStore: ConfigStore;
let checkpoints: OrgCheckpointStore;
let users: UsersRunStore;
let replayList: ReturnType<typeof vi.fn<(options: ReplayListOptions) => Promise<ReplayEntry[]>>>;
let orgs: Map<string, SalesforceOrg>;
let refreshes: DetectedSandboxRefresh[];
let answeredAs: string | undefined;

function deps(over: Partial<RecoveryFactsDeps> = {}): RecoveryFactsDeps {
  return {
    configStore,
    orgOf: (id) => orgs.get(id),
    refreshesOf: () => refreshes,
    organizationIdOf: () => answeredAs,
    checkpoints: () => Promise.resolve(checkpoints),
    replays: () => ({ list: replayList }),
    users: () => users,
    journalDir: join(dir, 'journal'),
    frozenDatasetDir: () => join(dir, 'sas', 'dataset'),
    ...over,
  };
}

async function factsOf(over: Partial<RecoveryFactsDeps> = {}) {
  const read = await recoveryFactsOf(deps(over), 'entry-uat');
  if (!('facts' in read)) throw new Error(`refused: ${read.refused}`);
  return read.facts;
}

async function keep(checkpoint: OrgCheckpoint): Promise<void> {
  await checkpoints.create(checkpoint.org.organizationId, checkpoint.checkpointId);
  await checkpoints.write(checkpoint);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandforge-recovery-facts-'));
  configStore = new ConfigStore(new InMemoryConfigStoreBackend());
  configStore.initialize();
  const opened = openCheckpointStore({
    root: join(dir, 'checkpoints'),
    locksDir: join(dir, 'locks'),
  });
  if (!('store' in opened)) throw new Error('no store');
  checkpoints = opened.store;
  users = new UsersRunStore({ root: join(dir, 'users'), guard });
  replayList = vi.fn(() => Promise.resolve([]));
  orgs = new Map([['entry-uat', sandbox()]]);
  refreshes = [refresh()];
  answeredAs = AFTER;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('recoveryFactsOf', () => {
  it('refuses an org not registered, and a production org, before anything is read', async () => {
    const checkpointsAsked = vi.fn(() => Promise.resolve(checkpoints));
    expect(await recoveryFactsOf(deps({ checkpoints: checkpointsAsked }), 'entry-gone')).toEqual({
      refused: 'ORG_NOT_FOUND',
    });
    orgs.set('entry-uat', sandbox({ orgType: 'Production', sandboxType: undefined }));
    expect(await recoveryFactsOf(deps({ checkpoints: checkpointsAsked }), 'entry-uat')).toEqual({
      refused: 'NOT_A_DEVELOPMENT_ORG',
    });
    expect(checkpointsAsked).not.toHaveBeenCalled();
  });

  it('reads the checkpoint of before and those of the org now, each of its own org', async () => {
    await keep(checkpointOf(BEFORE, 'ck-20261110-090000-a1b2', '2026-11-10T09:00:00.000Z', null));
    await keep(
      checkpointOf(
        BEFORE,
        'ck-20261117-180000-c3d4',
        '2026-11-17T18:00:00.000Z',
        '2026-12-17T18:00:00.000Z',
      ),
    );
    await keep(checkpointOf(AFTER, 'ck-20261118-120000-e5f6', '2026-11-18T12:00:00.000Z', null));
    const facts = await factsOf();
    expect(facts.checkpointBefore).toEqual({
      checkpointId: 'ck-20261117-180000-c3d4',
      name: 'Taken 2026-11-17',
      takenAt: '2026-11-17T18:00:00.000Z',
    });
    expect(facts.checkpointsNow).toEqual([
      { takenAt: '2026-11-18T12:00:00.000Z', keptUntilDeleted: true },
    ]);
    expect(replayList).toHaveBeenCalledWith({
      sourceOrganizationId: BEFORE,
      targetOrganizationId: AFTER,
    });
  });

  it('takes a replay into the org now as done once it wrote and was not removed', async () => {
    const replay = (replayedAt: string | undefined, removed?: true): ReplayEntry => ({
      sourceOrganizationId: organizationKey(BEFORE),
      checkpointId: 'ck-20261117-180000-c3d4',
      target: { organizationId: organizationKey(AFTER) },
      inPlace: 0,
      inPlaceByObject: [],
      ...(replayedAt !== undefined ? { replayedAt } : {}),
      ...(removed ? { removed } : {}),
    });
    replayList.mockResolvedValue([
      replay('2026-11-18T10:00:00.000Z'),
      replay('2026-11-18T11:00:00.000Z', true),
      replay(undefined),
    ]);
    expect((await factsOf()).replayedAt).toBe('2026-11-18T10:00:00.000Z');
  });

  it('reads the users runs of the org now, never those of the org it was', async () => {
    await users.begin(BEFORE, {
      status: 'success',
      startedAt: '2026-11-01T09:00:00.000Z',
      endedAt: '2026-11-01T09:01:00.000Z',
      emailsToPeople: 0,
      users: [],
    });
    expect((await factsOf()).lastUsersRun).toBeUndefined();

    await users.begin(AFTER, {
      status: 'partial',
      startedAt: '2026-11-18T09:00:00.000Z',
      endedAt: '2026-11-18T09:02:00.000Z',
      emailsToPeople: 1,
      users: [],
    });
    await users.begin(AFTER, {
      status: 'running',
      startedAt: '2026-11-18T10:00:00.000Z',
      emailsToPeople: 0,
      users: [],
    });
    expect((await factsOf()).lastUsersRun).toEqual({
      run: 1,
      at: '2026-11-18T09:02:00.000Z',
      status: 'partial',
    });
  });

  it('reads nothing of the org now while only production reported the refresh', async () => {
    // The sandbox has not answered since: the detector still holds the org
    // it was, which is the org before, never the org now.
    refreshes = [
      refresh({
        evidence: 'production',
        previousOrganizationId: undefined,
        organizationId: undefined,
        reportedBy: 'entry-prod',
      }),
    ];
    answeredAs = BEFORE;
    orgs.set('entry-prod', sandbox({ id: 'entry-prod', alias: 'PROD', orgType: 'Production' }));
    await users.begin(BEFORE, {
      status: 'success',
      startedAt: '2026-11-01T09:00:00.000Z',
      emailsToPeople: 0,
      users: [],
    });
    await keep(checkpointOf(BEFORE, 'ck-20261117-180000-c3d4', '2026-11-17T18:00:00.000Z', null));
    const facts = await factsOf();
    expect(facts.organizationId).toBeUndefined();
    expect(facts.lastUsersRun).toBeUndefined();
    expect(facts.checkpointsNow).toEqual([]);
    expect(facts.checkpointBefore?.checkpointId).toBe('ck-20261117-180000-c3d4');
    expect(facts.refresh).toMatchObject({
      evidence: 'production',
      previousOrganizationId: BEFORE,
      reportedBy: 'PROD',
      cachesForgotten: true,
    });
    expect(facts.refresh?.organizationId).toBeUndefined();
  });

  it('reads the org the sandbox answered as last when no refresh was noticed', async () => {
    refreshes = [];
    answeredAs = BEFORE;
    await keep(checkpointOf(BEFORE, 'ck-20261117-180000-c3d4', '2026-11-17T18:00:00.000Z', null));
    const facts = await factsOf();
    expect(facts.refresh).toBeUndefined();
    expect(facts.organizationId).toBe(BEFORE);
    expect(facts.checkpointBefore).toBeUndefined();
    expect(facts.checkpointsNow).toHaveLength(1);
  });

  it('compares with the inventory of the host kept before, and knows one kept since', async () => {
    const journal = join(dir, 'journal');
    await saveInventory(journal, {
      version: 1,
      savedAt: '2026-11-17T18:05:00.000Z',
      organizationId: `${BEFORE}AAA`,
      host: HOST,
      jobs: [{ name: 'Nightly', type: 'Scheduled Apex', state: 'WAITING' }],
    });
    let facts = await factsOf();
    expect(facts.inventoryBefore).toEqual({
      savedAt: '2026-11-17T18:05:00.000Z',
      organizationId: `${BEFORE}AAA`,
      jobs: 1,
    });
    expect(facts.inventoryNowAt).toBeUndefined();
    await saveInventory(journal, {
      version: 1,
      savedAt: '2026-11-18T13:00:00.000Z',
      organizationId: organizationKey(AFTER),
      host: HOST,
      jobs: [],
    });
    facts = await factsOf();
    expect(facts.inventoryNowAt).toBe('2026-11-18T13:00:00.000Z');
    expect(facts.inventoryBefore?.savedAt).toBe('2026-11-17T18:05:00.000Z');
  });

  it('reads the masking runs and the frozen loads of the sandbox since its refresh, a success each', async () => {
    const trail = new AuditTrailStore(configStore);
    const entry = (
      action: 'anonymize_execute' | 'frozen_load',
      timestamp: string,
      outcome: 'success' | 'partial',
    ) =>
      trail.append({
        id: crypto.randomUUID(),
        action,
        module: action === 'frozen_load' ? 'frozen' : 'dataops',
        orgId: 'entry-uat',
        outcome,
        timestamp,
        details: {},
      } as never);
    entry('anonymize_execute', '2026-11-17T09:00:00.000Z', 'success');
    entry('anonymize_execute', '2026-11-18T09:30:00.000Z', 'partial');
    entry('frozen_load', '2026-11-18T11:00:00.000Z', 'success');
    let facts = await factsOf();
    expect(facts.maskedAt).toBeUndefined();
    expect(facts.frozenLoadedAt).toBe('2026-11-18T11:00:00.000Z');
    entry('anonymize_execute', '2026-11-18T10:00:00.000Z', 'success');
    facts = await factsOf();
    expect(facts.maskedAt).toBe('2026-11-18T10:00:00.000Z');
  });

  it('reads the frozen dataset kept where the Frozen Dataset page keeps it', async () => {
    expect((await factsOf()).frozenManifest).toBeUndefined();
    const datasetDir = join(dir, 'sas', 'dataset');
    mkdirSync(datasetDir, { recursive: true });
    const manifest = buildFrozenManifest({
      version: '1.0.0',
      source: { orgId: '00DXXXXXXXXXXXX', orgAlias: 'DEV', decisionDate: '2026-11-01' },
      saltFingerprint: 'abcdef012345',
      rulesVersion: '1.0.0',
      volumetry: {
        budgetMax: 2500,
        measured: { Account: 12, Contact: 20 },
        measuredAt: '2026-11-01T09:00:00.000Z',
      },
      nonReidentification: {
        passed: true,
        checks: [],
        author: 'qa',
        checkedAt: '2026-11-01T10:00:00.000Z',
      },
      author: 'qa',
      now: () => new Date('2026-11-01T10:00:00.000Z'),
    });
    writeFileSync(join(datasetDir, 'manifest.json'), serializeManifest(manifest));
    expect((await factsOf()).frozenManifest).toEqual({
      frozenAt: '2026-11-01T10:00:00.000Z',
      sourceAlias: 'DEV',
      objects: 2,
      records: 32,
    });
    expect(frozenDatasetDirOf(configStore, '/home/qa')).toBe(
      join('/home/qa', '.sandforge-sas', 'dataset'),
    );
    configStore.set('frozen:config', { sasDir: '/srv/sas' }, 'frozen');
    expect(frozenDatasetDirOf(configStore)).toBe(join('/srv/sas', 'dataset'));
  });

  it('reads the note, the testers kept, a pipeline started by the refresh and what a person acknowledged', async () => {
    const journal = join(dir, 'journal');
    const note = recoveryHandoffPathOf(journal, {
      organizationId: AFTER,
      at: '2026-11-18T16:00:00.000Z',
    });
    mkdirSync(join(note, '..'), { recursive: true });
    writeFileSync(note, '');
    saveTesters(
      configStore,
      recoveryTestersKey(HOST, 'entry-uat'),
      { users: [{ username: 'jane.qa@acme.test.uat' }] },
      new Date('2026-11-18T09:00:00.000Z'),
    );
    configStore.set(
      'pipeline:saved:p1',
      { triggers: [{ type: 'sandbox_refresh', enabled: true, config: { orgId: 'entry-uat' } }] },
      'pipelines',
    );
    configStore.set(
      recoveryAckKey('entry-uat', BEFORE),
      { steps: { masking: 'skipped' } },
      'recovery',
    );
    const facts = await factsOf();
    expect(facts).toMatchObject({
      handoffAt: '2026-11-18T16:00:00.000Z',
      testersSavedAt: '2026-11-18T09:00:00.000Z',
      refreshPipeline: true,
      acks: { steps: { masking: 'skipped' } },
      myDomainHost: HOST,
      tier: 'development',
      kind: 'sandbox',
      sandboxType: 'Full',
    });
  });

  it('keeps what a person acknowledged with no refresh noticed apart from the next refresh', async () => {
    refreshes = [];
    configStore.set(
      recoveryAckKey('entry-uat', NO_REFRESH_KEY),
      { steps: { users: 'skipped' } },
      'recovery',
    );
    expect((await factsOf()).acks).toEqual({ steps: { users: 'skipped' } });
    refreshes = [refresh()];
    expect((await factsOf()).acks).toEqual({ steps: {} });
  });

  it('reads a sandbox marked Staging at its tier', async () => {
    orgs.set('entry-uat', sandbox({ staging: true }));
    expect((await factsOf()).tier).toBe('staging');
  });
});
