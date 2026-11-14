import { describe, expect, it } from 'vitest';
import {
  REPLAY_MAX_RECORDS,
  type CheckpointReplayChoices,
  type OrgCheckpoint,
} from '@sandforge/shared';

import {
  replayAuditDetails,
  replayDataRefusal,
  replaySameOrgRefusal,
  replaySourceRefusal,
  replayableObjectsOf,
  sameSandboxRefreshed,
  sourceDataOf,
  type ReplayGuardTarget,
} from './replaySourceGuard.js';

/*
 * What a replay into another org is refused for before anything is read of
 * either org: the checkpoint as its file says it, and the other org as it
 * answered once connected. The checkpoint's own org is never asked.
 */

const SOURCE = '00D000000000011EAA';
const TARGET = '00D000000000022EAA';

/** A checkpoint of a sandbox, ready, of two accounts and a file. */
function checkpointOf(
  org: Partial<OrgCheckpoint['org']> = {},
  more: Partial<OrgCheckpoint> = {},
): OrgCheckpoint {
  const object = (objectApiName: string, records: number, extra: object = {}) => ({
    objectApiName,
    records,
    inBin: 0,
    readOrder: 0,
    readMode: 'query' as const,
    undeletable: true,
    cascadeParents: [],
    fingerprint: '0'.repeat(64),
    fields: ['Id', 'Name'],
    leftOutFields: [],
    ...extra,
  });
  return {
    version: 1,
    checkpointId: 'ck-20261110-091400-a1b2',
    name: 'recette prête',
    org: {
      organizationId: SOURCE,
      alias: 'DEV1',
      username: 'ada@example.com.dev1',
      instanceUrl: 'https://example--dev1.sandbox.my.salesforce.com',
      isSandbox: true,
      organizationType: 'Enterprise Edition',
      tier: 'sandbox',
      dataStorageMaxMB: 200,
      ...org,
    },
    takenBy: { userId: '005000000000001AAA', viewAllData: true, modifyAllData: true },
    readFrom: '2026-11-10T09:14:00.000Z',
    takenAt: '2026-11-10T09:14:00.000Z',
    scope: { mode: 'picked', leftOut: [] },
    objects: [
      object('Account', 2),
      object('ContentDocument', 1),
      object('Contact', 3),
      object('Hier__c', 1, { customSetting: 'hierarchy' }),
    ],
    ignoredFields: [],
    snapshotId: 'snapshot-1',
    movedWhileTaken: { changed: 0, deleted: 0, created: 0 },
    bytes: 0,
    expiresAt: null,
    status: 'ready',
    takenOn: { host: 'test-host', pid: 1 },
    ...more,
  };
}

const CHOICES: CheckpointReplayChoices = {
  owners: 'same',
  customSettings: false,
  mask: false,
  contactPoints: 'neutralized',
  objects: [],
  excluded: [],
  link: [],
};

/** Another org, connected. */
const OTHER: ReplayGuardTarget = {
  name: 'UAT',
  organizationId: TARGET,
  username: 'replayer@example.com.uat',
  instanceUrl: 'https://example--uat.sandbox.my.salesforce.com',
};

function refusal(
  org: Partial<OrgCheckpoint['org']>,
  choices: Partial<CheckpointReplayChoices> = {},
  target = OTHER,
) {
  return replaySourceRefusal({
    checkpoint: checkpointOf(org),
    checkpointId: 'ck-20261110-091400-a1b2',
    choices: { ...CHOICES, ...choices },
    target,
  });
}

describe('which objects a replay sets up', () => {
  it('leaves files out, a custom setting unless asked, and what the choices leave out, names matched without regard to case', () => {
    const objects = replayableObjectsOf(checkpointOf(), { ...CHOICES, excluded: ['contact'] });

    expect(objects.replayed.map((object) => object.objectApiName)).toEqual(['Account']);
    expect(objects.leftOut).toEqual([
      { objectApiName: 'ContentDocument', records: 1, reason: 'fileContentNotKept' },
      { objectApiName: 'Contact', records: 3, reason: 'excluded' },
      { objectApiName: 'Hier__c', records: 1, reason: 'excluded' },
    ]);
    expect(objects.records).toBe(2);
  });

  it('replays the objects named alone, a custom setting among them when asked, and names those it does not hold', () => {
    const objects = replayableObjectsOf(checkpointOf(), {
      ...CHOICES,
      objects: ['Account', 'Hier__c', 'Lead'],
      customSettings: true,
    });

    expect(objects.replayed.map((object) => object.objectApiName)).toEqual(['Account', 'Hier__c']);
    expect(objects.unknown).toEqual(['Lead']);
  });
});

describe('a checkpoint that may hold real data', () => {
  it('is free of production data from a scratch org, a Developer Edition org, a Developer or Developer Pro sandbox', () => {
    expect(sourceDataOf({ tier: 'scratch' })).toEqual({ kind: 'free', why: 'scratch' });
    expect(sourceDataOf({ tier: 'developer' })).toEqual({ kind: 'free', why: 'developer' });
    expect(sourceDataOf({ tier: 'sandbox', dataStorageMaxMB: 1024 })).toEqual({
      kind: 'free',
      why: 'developerSandbox',
      dataStorageMaxMB: 1024,
    });
    expect(refusal({ tier: 'scratch', dataStorageMaxMB: 500 })).toBeUndefined();
    expect(refusal({ tier: 'developer', dataStorageMaxMB: undefined })).toBeUndefined();
  });

  it('refuses a Partial Copy or Full sandbox’s past a Developer Pro’s storage without masking, naming its storage and the way to mask', () => {
    const refused = refusal({ dataStorageMaxMB: 5120 });

    expect(refused).toMatchObject({
      code: 'REPLAY_REAL_DATA',
      params: { why: 'storage', mb: 5120, target: 'UAT' },
    });
    expect(refused?.message).toContain('5,120 MB, past the 1,024 MB of a Developer Pro');
    expect(refused?.message).toContain('--mask');
    expect(refused?.message).toMatch(/Nothing was read or written\.$/);
    expect(refusal({ dataStorageMaxMB: 1025 })?.code).toBe('REPLAY_REAL_DATA');
    expect(refusal({ dataStorageMaxMB: 5120 }, { mask: true })).toBeUndefined();
  });

  it('refuses a Staging sandbox’s without masking, whatever its storage, and a mark a file claims of a scratch org', () => {
    expect(refusal({ staging: true, dataStorageMaxMB: 200 })).toMatchObject({
      code: 'REPLAY_REAL_DATA',
      params: { why: 'staging' },
    });
    expect(refusal({ staging: true, tier: 'scratch' })?.code).toBe('REPLAY_REAL_DATA');
    expect(refusal({ staging: true }, { mask: true })).toBeUndefined();
  });

  it('refuses a sandbox’s that does not say its license unless masked or declared free of real data', () => {
    const refused = refusal({ dataStorageMaxMB: undefined });

    expect(refused?.code).toBe('REPLAY_COPY_UNKNOWN');
    expect(refused?.message).toContain('--mask');
    expect(refused?.message).toContain('--no-real-data');
    expect(refused?.message).toContain('the audit trail keeps');
    expect(refusal({ dataStorageMaxMB: undefined }, { noRealData: true })).toBeUndefined();
    expect(refusal({ dataStorageMaxMB: undefined }, { mask: true })).toBeUndefined();
    // A declaration never lifts what the checkpoint says it holds.
    expect(refusal({ dataStorageMaxMB: 5120 }, { noRealData: true })?.code).toBe(
      'REPLAY_REAL_DATA',
    );
  });

  it('lets a copy go unmasked into the sandbox it became once refreshed: its former Id, its username, its My Domain host', () => {
    const copy = { dataStorageMaxMB: 5120 };
    const refreshed = (target: Partial<ReplayGuardTarget>) =>
      refusal(copy, {}, { name: 'DEV1', organizationId: TARGET, ...target });

    expect(refreshed({ formerOrganizationIds: [SOURCE.slice(0, 15)] })).toBeUndefined();
    expect(refreshed({ username: 'ADA@example.com.dev1' })).toBeUndefined();
    expect(
      refreshed({ instanceUrl: 'https://EXAMPLE--dev1.sandbox.my.salesforce.com/' }),
    ).toBeUndefined();
    // A pod's host is many orgs': it tells nothing.
    const onPod = checkpointOf({ ...copy, instanceUrl: 'https://cs42.salesforce.com' });
    expect(
      sameSandboxRefreshed(onPod.org, { name: 'X', instanceUrl: 'https://cs42.salesforce.com' }),
    ).toBeUndefined();
    expect(refreshed({})?.code).toBe('REPLAY_REAL_DATA');
  });

  it('takes no scratch org for a sandbox refreshed: it is never one', () => {
    const scratch = checkpointOf({ tier: 'scratch' });

    expect(
      sameSandboxRefreshed(scratch.org, { name: 'X', username: scratch.org.username }),
    ).toBeUndefined();
  });

  it('says it in the panel’s own words when given them', () => {
    const refused = replayDataRefusal(checkpointOf({ dataStorageMaxMB: 5120 }), CHOICES, OTHER, {
      mask: 'tick Mask personal data',
    });

    expect(refused?.message).toContain('tick Mask personal data');
    expect(refused?.message).not.toContain('--mask');
  });
});

describe('the checkpoint’s own org', () => {
  it('is refused, by either length of its Organization Id, with the way to bring it back instead', () => {
    const refused = replaySameOrgRefusal(checkpointOf(), {
      name: 'DEV1',
      organizationId: SOURCE.slice(0, 15),
    });

    expect(refused).toMatchObject({ code: 'REPLAY_SAME_ORG', params: { target: 'DEV1' } });
    expect(refused?.message).toContain('rewind that org to the checkpoint instead');
    expect(
      replaySourceRefusal({
        checkpoint: checkpointOf({ dataStorageMaxMB: 5120 }),
        checkpointId: 'x',
        choices: CHOICES,
        target: { name: 'DEV1', organizationId: SOURCE },
      })?.code,
    ).toBe('REPLAY_SAME_ORG');
  });

  it('is not told before the other org answered which it is', () => {
    expect(replaySameOrgRefusal(checkpointOf(), { name: 'DEV1' })).toBeUndefined();
  });
});

describe('a checkpoint that cannot be replayed', () => {
  it('refuses one whose file does not read, a take under way and one that failed', () => {
    const base = { checkpointId: 'ck-20261110-091400-a1b2', choices: CHOICES, target: OTHER };

    expect(replaySourceRefusal({ ...base, checkpoint: undefined })).toMatchObject({
      code: 'REPLAY_CHECKPOINT_UNUSABLE',
      params: { why: 'damaged' },
    });
    expect(
      replaySourceRefusal({ ...base, checkpoint: checkpointOf({}, { status: 'taking' }) }),
    ).toMatchObject({ code: 'REPLAY_CHECKPOINT_UNUSABLE', params: { why: 'taking' } });
    expect(
      replaySourceRefusal({ ...base, checkpoint: checkpointOf({}, { status: 'failed' }) }),
    ).toMatchObject({ code: 'REPLAY_CHECKPOINT_UNUSABLE', params: { why: 'failed' } });
  });

  it('refuses one with nothing left to replay, and says a checkpoint of files alone keeps none', () => {
    const files = checkpointOf(
      {},
      {
        objects: [checkpointOf().objects[1]],
      },
    );

    const refused = replaySourceRefusal({
      checkpoint: files,
      checkpointId: files.checkpointId,
      choices: CHOICES,
      target: OTHER,
    });

    expect(refused?.code).toBe('REPLAY_NOTHING');
    expect(refused?.message).toContain('a checkpoint keeps no file’s content');
    expect(refusal({}, { excluded: ['Account', 'Contact'] })?.code).toBe('REPLAY_NOTHING');
  });

  it('refuses more records than a replay sets up at once, counting the objects replayed alone, with the way to replay fewer', () => {
    const many = checkpointOf(
      {},
      {
        objects: checkpointOf().objects.map((object) => ({ ...object, records: 60_000 })),
      },
    );
    const ask = (choices: Partial<CheckpointReplayChoices>) =>
      replaySourceRefusal({
        checkpoint: many,
        checkpointId: many.checkpointId,
        choices: { ...CHOICES, ...choices },
        target: OTHER,
      });

    const refused = ask({});
    expect(refused).toMatchObject({
      code: 'REPLAY_TOO_MANY',
      params: { records: 120_000, max: REPLAY_MAX_RECORDS },
    });
    expect(refused?.message).toContain('--objects A,B');
    expect(refused?.message).toContain('--exclude-object X');
    expect(ask({ excluded: ['Contact'] })).toBeUndefined();
  });
});

describe('what the audit trail keeps of a replay', () => {
  it('keeps the declaration that a checkpoint holds no real data, which lifted the refusal on the person’s word', () => {
    const details = replayAuditDetails(
      checkpointOf({ dataStorageMaxMB: undefined }),
      { ...CHOICES, noRealData: true },
      OTHER,
    );

    expect(details).toEqual({
      replaySource: 'unknown',
      replayMasked: false,
      replayContactPoints: 'neutralized',
      replayNoRealDataDeclared: true,
    });
  });

  it('says what the checkpoint’s org was, that the replay masked, or that it went into the sandbox it was of', () => {
    expect(
      replayAuditDetails(
        checkpointOf({ dataStorageMaxMB: 5120 }),
        { ...CHOICES, mask: true },
        OTHER,
      ),
    ).toEqual({
      replaySource: 'storage',
      replaySourceStorageMB: 5120,
      replayMasked: true,
      replayContactPoints: 'neutralized',
    });
    expect(
      replayAuditDetails(checkpointOf({ dataStorageMaxMB: 5120 }), CHOICES, {
        name: 'DEV1',
        username: 'ada@example.com.dev1',
      }),
    ).toMatchObject({ replayIntoSameSandbox: 'username' });
    // A declaration the replay did not need is no declaration kept.
    expect(
      replayAuditDetails(
        checkpointOf({ tier: 'scratch' }),
        { ...CHOICES, noRealData: true },
        OTHER,
      ),
    ).not.toHaveProperty('replayNoRealDataDeclared');
  });
});
