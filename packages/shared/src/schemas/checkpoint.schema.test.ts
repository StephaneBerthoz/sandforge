import { describe, it, expect } from 'vitest';

import {
  checkpointFieldKeySchema,
  checkpointIdSchema,
  checkpointNameSchema,
  checkpointOrganizationIdSchema,
  orgCheckpointSchema,
  previewIdSchema,
  rewindIdSchema,
} from './checkpoint.schema.js';

/** A `checkpoint.json` as a ready take writes it, of a Developer Edition org. */
function readyCheckpoint(): Record<string, unknown> {
  return {
    version: 1,
    checkpointId: 'ck-20261022-140512-a1b2',
    name: 'Before UAT',
    org: {
      organizationId: '00Dxx0000001234AAA',
      alias: 'DEV-SB',
      username: 'admin@example.com',
      instanceUrl: 'https://example-dev-ed.my.salesforce.com',
      isSandbox: false,
      organizationType: 'Developer Edition',
      tier: 'developer',
    },
    takenBy: {
      userId: '005xx000001AbCdAAA',
      automatedProcessUserId: '005xx000001EfGhAAA',
      viewAllData: true,
      modifyAllData: true,
    },
    readFrom: '2026-10-22T14:05:12.000Z',
    takenAt: '2026-10-22T14:06:03.417Z',
    scope: {
      mode: 'everything',
      leftOut: [{ objectApiName: 'FeedItem', reason: 'Chatter posts are left out.' }],
    },
    objects: [
      {
        objectApiName: 'Contact',
        records: 40,
        inBin: 3,
        readOrder: 0,
        readMode: 'query',
        undeletable: true,
        cascadeParents: [],
        fingerprint: 'a'.repeat(64),
        fields: ['Id', 'SystemModstamp', 'LastName', 'AccountId'],
        leftOutFields: [{ field: 'Secret__c', reason: 'encrypted' }],
      },
      {
        objectApiName: 'Task',
        records: 12,
        inBin: 0,
        readOrder: 1,
        readMode: 'scanAllLive',
        undeletable: true,
        cascadeParents: [],
        fingerprint: 'b'.repeat(64),
        fields: ['Id', 'SystemModstamp', 'Subject'],
        leftOutFields: [],
      },
    ],
    ignoredFields: ['Case.Last_Touched__c'],
    snapshotId: 'op-1',
    movedWhileTaken: { changed: 0, deleted: 0, created: 1 },
    bytes: 2_400_000,
    expiresAt: '2026-11-21T14:06:03.417Z',
    status: 'ready',
    takenOn: { host: 'workstation', pid: 4242 },
  };
}

/**
 * An object as `takeCheckpoint` wrote it from 1.66 to 1.69, key by key in
 * its order: `restrictParents` always, neither `customSetting` nor `access`.
 */
function writtenObject(
  objectApiName: string,
  readOrder: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    objectApiName,
    records: 3,
    inBin: 0,
    readOrder,
    readMode: objectApiName === 'Task' ? 'scanAllLive' : 'query',
    undeletable: true,
    cascadeParents: [],
    restrictParents: [],
    fingerprint: 'c'.repeat(64),
    fields: ['Id', 'SystemModstamp', 'CreatedDate', 'CreatedById', 'Name'],
    leftOutFields: [],
    ...extra,
  };
}

/**
 * A `checkpoint.json` of each release from 1.66 to 1.69, as its take wrote it
 * and its rewind left it. The four takes wrote one shape: what differs is
 * what each one's org and run gave it — a Developer Edition without an
 * Automated Process user, a scratch org's expiry as the command line gives
 * it, a sandbox kept until it is deleted with its last rewind, a rewind
 * undone.
 */
const WRITTEN_BEFORE: Record<string, Record<string, unknown>> = {
  '1.66.0': {
    version: 1,
    checkpointId: 'ck-20261024-091500-k3m9',
    name: '2026-10-24 09:15 UTC',
    org: {
      organizationId: '00Dxx0000001234AAA',
      username: 'admin@example.com',
      instanceUrl: 'https://example-dev-ed.my.salesforce.com',
      isSandbox: false,
      organizationType: 'Developer Edition',
      tier: 'developer',
    },
    takenBy: { userId: '005xx000001AbCdAAA', viewAllData: true, modifyAllData: true },
    readFrom: '2026-10-24T09:15:00.120Z',
    takenAt: '2026-10-24T09:15:41.902Z',
    scope: { mode: 'everything', leftOut: [] },
    objects: [
      writtenObject('Contact', 0, { cascadeParents: ['AccountId'] }),
      writtenObject('Account', 1),
    ],
    ignoredFields: [],
    snapshotId: 'snapshot-ck-20261024-091500-k3m9',
    movedWhileTaken: { changed: 0, deleted: 0, created: 0 },
    bytes: 48_211,
    expiresAt: '2026-11-23T09:15:41.902Z',
    status: 'ready',
    takenOn: { host: 'workstation', pid: 1201 },
  },
  '1.67.0': {
    version: 1,
    checkpointId: 'ck-20261025-140000-p2q7',
    name: 'Before the demo',
    org: {
      organizationId: '00Dxx0000005678AAA',
      alias: 'DEMO-ORG',
      username: 'test-user@example.com',
      instanceUrl: 'https://example-scratch.my.salesforce.com',
      isSandbox: true,
      organizationType: 'Developer Edition',
      tier: 'scratch',
      scratchExpiresAt: '2026-11-16',
    },
    takenBy: {
      userId: '005xx000001AbCdAAA',
      automatedProcessUserId: '005xx000001EfGhAAA',
      viewAllData: true,
      modifyAllData: true,
    },
    readFrom: '2026-10-25T14:00:02.000Z',
    takenAt: '2026-10-25T14:00:30.415Z',
    scope: {
      mode: 'picked',
      leftOut: [{ objectApiName: 'Nope__c', reason: 'The org has no object of this name.' }],
    },
    objects: [
      writtenObject('Case', 0, { restrictParents: ['AccountId'] }),
      writtenObject('Account', 1),
    ],
    ignoredFields: ['Case.Last_Touched__c'],
    snapshotId: 'snapshot-ck-20261025-140000-p2q7',
    movedWhileTaken: { changed: 1, deleted: 0, created: 2 },
    bytes: 12_800,
    expiresAt: '2026-11-24T14:00:30.415Z',
    status: 'ready',
    takenOn: { host: 'laptop', pid: 77 },
  },
  '1.68.0': {
    version: 1,
    checkpointId: 'ck-20261026-080000-r4s8',
    name: 'UAT baseline',
    org: {
      organizationId: '00Dxx0000009012AAA',
      alias: 'UAT',
      username: 'admin@example.com.uat',
      instanceUrl: 'https://example--uat.sandbox.my.salesforce.com',
      isSandbox: true,
      organizationType: 'Enterprise Edition',
      tier: 'sandbox',
    },
    takenBy: {
      userId: '005xx000001AbCdAAA',
      automatedProcessUserId: '005xx000001EfGhAAA',
      viewAllData: true,
      modifyAllData: true,
    },
    readFrom: '2026-10-26T08:00:00.000Z',
    takenAt: '2026-10-26T08:03:12.004Z',
    scope: {
      mode: 'everything',
      leftOut: [{ objectApiName: 'FeedItem', reason: 'Chatter posts are left out.' }],
    },
    objects: [
      writtenObject('Task', 0),
      writtenObject('Contact', 1, { cascadeParents: ['AccountId'] }),
      writtenObject('Account', 2),
    ],
    ignoredFields: [],
    snapshotId: 'snapshot-ck-20261026-080000-r4s8',
    movedWhileTaken: { changed: 0, deleted: 0, created: 0 },
    bytes: 2_400_000,
    expiresAt: null,
    status: 'ready',
    takenOn: { host: 'workstation', pid: 4242 },
    lastRewind: {
      rewindId: 'rw-20261026-170000-t5u1',
      endedAt: '2026-10-26T17:02:10.000Z',
      undoUntil: '2026-11-10T17:02:10.000Z',
    },
  },
  '1.69.1': {
    version: 1,
    checkpointId: 'ck-20261027-101010-v6w2',
    name: 'Sprint 12',
    org: {
      organizationId: '00Dxx0000003456AAA',
      alias: 'DEV-SB',
      username: 'admin@example.com.dev',
      instanceUrl: 'https://example--dev.sandbox.my.salesforce.com',
      isSandbox: true,
      organizationType: 'Unlimited Edition',
      tier: 'sandbox',
    },
    takenBy: {
      userId: '005xx000001AbCdAAA',
      automatedProcessUserId: '005xx000001EfGhAAA',
      viewAllData: true,
      modifyAllData: true,
    },
    readFrom: '2026-10-27T10:10:10.000Z',
    takenAt: '2026-10-27T10:12:00.000Z',
    scope: { mode: 'everything', leftOut: [] },
    objects: [writtenObject('Opportunity', 0), writtenObject('Account', 1, { inBin: 4 })],
    ignoredFields: [],
    snapshotId: 'snapshot-ck-20261027-101010-v6w2',
    movedWhileTaken: { changed: 0, deleted: 1, created: 0 },
    bytes: 310_552,
    expiresAt: '2026-11-26T10:12:00.000Z',
    status: 'ready',
    takenOn: { host: 'workstation', pid: 9001 },
    lastRewind: {
      rewindId: 'rw-20261027-150000-x7y3',
      endedAt: '2026-10-27T15:01:00.000Z',
      undoUntil: '2026-11-11T15:01:00.000Z',
      undoneAt: '2026-10-27T15:30:00.000Z',
    },
  },
};

/** `readyCheckpoint()` with `patch` laid over it, key by key. */
function checkpointWith(patch: Record<string, unknown>): Record<string, unknown> {
  return { ...readyCheckpoint(), ...patch };
}

/** The first object of `readyCheckpoint()` with `patch` laid over it. */
function withContact(patch: Record<string, unknown>): Record<string, unknown> {
  const [contact, task] = readyCheckpoint().objects as Record<string, unknown>[];
  return checkpointWith({ objects: [{ ...contact, ...patch }, task] });
}

describe('orgCheckpointSchema', () => {
  it('reads a checkpoint a ready take wrote', () => {
    const parsed = orgCheckpointSchema.safeParse(readyCheckpoint());
    expect(parsed.success).toBe(true);
    expect(parsed.data?.ignoredFields).toEqual(['Case.Last_Touched__c']);
    expect(parsed.data?.objects.map((object) => object.readMode)).toEqual(['query', 'scanAllLive']);
  });

  it('reads back exactly what it wrote, so a store that rewrites a file keeps it whole', () => {
    const once = orgCheckpointSchema.parse(readyCheckpoint());
    const twice = orgCheckpointSchema.parse(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
    expect(twice).toEqual(readyCheckpoint());
  });

  it("keeps an object's fields whose parent its live records refuse the delete of, and reads a checkpoint taken before they were kept", () => {
    const restricting = withContact({ restrictParents: ['AccountId'] });
    const parsed = orgCheckpointSchema.parse(restricting);
    expect(parsed.objects[0].restrictParents).toEqual(['AccountId']);
    expect(parsed).toEqual(restricting);
    expect(orgCheckpointSchema.parse(readyCheckpoint()).objects[0]).not.toHaveProperty(
      'restrictParents',
    );
    expect(
      orgCheckpointSchema.safeParse(withContact({ restrictParents: ['Not a field'] })).success,
    ).toBe(false);
  });

  it('keeps the kind of a custom setting held by name, which a read that dropped it would rewind as any object, and refuses a kind it does not know', () => {
    for (const customSetting of ['hierarchy', 'list']) {
      const setting = withContact({ customSetting });
      const parsed = orgCheckpointSchema.parse(setting);
      expect(parsed.objects[0].customSetting).toBe(customSetting);
      expect(parsed).toEqual(setting);
    }
    expect(orgCheckpointSchema.parse(readyCheckpoint()).objects[0]).not.toHaveProperty(
      'customSetting',
    );
    expect(orgCheckpointSchema.safeParse(withContact({ customSetting: 'protected' })).success).toBe(
      false,
    );
  });

  it('reads a checkpoint kept until it is deleted, and one with its last rewind', () => {
    expect(orgCheckpointSchema.safeParse(checkpointWith({ expiresAt: null })).success).toBe(true);
    const rewound = checkpointWith({
      lastRewind: {
        rewindId: 'rw-20261022-150000-e5f6',
        endedAt: '2026-10-22T15:01:10.000Z',
        undoUntil: '2026-11-06T15:01:10.000Z',
      },
    });
    expect(orgCheckpointSchema.safeParse(rewound).success).toBe(true);
  });

  it("reads a scratch org's expiry as the command line gives it, a date, or as an instant", () => {
    for (const scratchExpiresAt of ['2026-11-16', '2026-11-16T00:00:00.000Z']) {
      const scratch = checkpointWith({
        org: { ...(readyCheckpoint().org as object), tier: 'scratch', scratchExpiresAt },
      });
      expect(orgCheckpointSchema.safeParse(scratch).success).toBe(true);
    }
  });

  it('refuses a file of another version, or of none', () => {
    expect(orgCheckpointSchema.safeParse(checkpointWith({ version: 2 })).success).toBe(false);
    const unversioned = readyCheckpoint();
    delete unversioned.version;
    expect(orgCheckpointSchema.safeParse(unversioned).success).toBe(false);
  });

  it('refuses a version 1 file without the fields its owner stopped comparing', () => {
    const withoutIgnored = readyCheckpoint();
    delete withoutIgnored.ignoredFields;
    expect(orgCheckpointSchema.safeParse(withoutIgnored).success).toBe(false);
  });

  it('refuses a checkpoint taken by a user without View All Data or Modify All Data that does not say how its user held each object whole', () => {
    for (const lacking of [{ viewAllData: false }, { modifyAllData: false }]) {
      const taken = checkpointWith({
        takenBy: { ...(readyCheckpoint().takenBy as object), ...lacking },
      });
      const parsed = orgCheckpointSchema.safeParse(taken);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['objects']);
    }
  });

  it('reads a checkpoint taken per object, each object held by Modify All on it or on what it hangs from', () => {
    const [contact, task] = readyCheckpoint().objects as Record<string, unknown>[];
    const perObject = checkpointWith({
      takenBy: { userId: '005xx000001AbCdAAA', viewAllData: false, modifyAllData: false },
      objects: [
        { ...contact, access: 'object' },
        { ...task, objectApiName: 'CaseComment', access: 'parent' },
      ],
    });

    const parsed = orgCheckpointSchema.parse(perObject);

    expect(parsed.takenBy).toMatchObject({ viewAllData: false, modifyAllData: false });
    expect(parsed.objects.map((object) => object.access)).toEqual(['object', 'parent']);
    expect(orgCheckpointSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(perObject);
  });

  it('refuses a checkpoint taken per object of which one object has no access, or says it was held by permissions its user lacked', () => {
    const [contact, task] = readyCheckpoint().objects as Record<string, unknown>[];
    const takenBy = { userId: '005xx000001AbCdAAA', viewAllData: true, modifyAllData: false };
    for (const second of [{ ...task }, { ...task, access: 'org' }]) {
      const parsed = orgCheckpointSchema.safeParse(
        checkpointWith({ takenBy, objects: [{ ...contact, access: 'object' }, second] }),
      );
      expect(parsed.success, JSON.stringify(second)).toBe(false);
      expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['objects']);
    }
    // A take still reading lists no object yet, and is read as it is.
    expect(
      orgCheckpointSchema.safeParse(checkpointWith({ takenBy, objects: [], status: 'taking' }))
        .success,
    ).toBe(true);
  });

  it('reads a checkpoint of a user with View All Data and Modify All Data whose objects say so, and refuses an access it does not know', () => {
    const held = withContact({ access: 'org' });
    expect(orgCheckpointSchema.parse(held)).toEqual(held);
    expect(orgCheckpointSchema.safeParse(withContact({ access: 'sharing' })).success).toBe(false);
  });

  it('reads back as they are the checkpoints SandForge 1.66, 1.67, 1.68 and 1.69 wrote, which say no access and hold both permissions', () => {
    for (const [version, written] of Object.entries(WRITTEN_BEFORE)) {
      const parsed = orgCheckpointSchema.safeParse(written);
      expect(parsed.success, version).toBe(true);
      expect(parsed.data, version).toEqual(written);
      expect(
        parsed.data?.objects.some((object) => 'access' in object),
        version,
      ).toBe(false);
      expect(parsed.data?.takenBy, version).toMatchObject({
        viewAllData: true,
        modifyAllData: true,
      });
    }
  });

  it('reads the files a checkpoint holds and whether its user had Query All Files, and one taken before files were held', () => {
    const before = readyCheckpoint();
    const withFiles = checkpointWith({
      takenBy: { ...(before.takenBy as object), queryAllFiles: false },
      files: { documents: 12, links: 30, anchored: 9, readByIds: ['Contact'] },
    });

    expect(orgCheckpointSchema.parse(withFiles)).toMatchObject({
      takenBy: { queryAllFiles: false },
      files: { documents: 12, links: 30, anchored: 9, readByIds: ['Contact'] },
    });
    const parsed = orgCheckpointSchema.parse(before);
    expect(parsed).not.toHaveProperty('files');
    expect(parsed.takenBy).not.toHaveProperty('queryAllFiles');
  });

  it('refuses files more anchored than held, an empty list of objects read by ids, and counts that are not whole', () => {
    for (const files of [
      { documents: 2, links: 3, anchored: 3 },
      { documents: 2, links: 3, anchored: 1, readByIds: [] },
      { documents: 2.5, links: 3, anchored: 1 },
      { documents: 2, links: 3 },
    ]) {
      expect(
        orgCheckpointSchema.safeParse(checkpointWith({ files })).success,
        JSON.stringify(files),
      ).toBe(false);
    }
  });

  it('refuses a checkpoint whose take ends before it begins', () => {
    const backwards = checkpointWith({ takenAt: '2026-10-22T14:05:11.999Z' });
    const parsed = orgCheckpointSchema.safeParse(backwards);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['takenAt']);
    // A take that read nothing ends in the second it began.
    const instant = checkpointWith({ takenAt: '2026-10-22T14:05:12.000Z' });
    expect(orgCheckpointSchema.safeParse(instant).success).toBe(true);
  });

  it('refuses an object held twice, which a rewind would act on twice', () => {
    const [contact] = readyCheckpoint().objects as Record<string, unknown>[];
    const twice = checkpointWith({ objects: [contact, { ...contact, readOrder: 1 }] });
    expect(orgCheckpointSchema.safeParse(twice).success).toBe(false);
  });

  it('refuses an ignored field not named with its object, or named twice', () => {
    for (const ignoredFields of [
      ['Last_Touched__c'],
      ['Case.Last_Touched__c', 'Case.Last_Touched__c'],
    ]) {
      expect(orgCheckpointSchema.safeParse(checkpointWith({ ignoredFields })).success).toBe(false);
    }
  });

  it('refuses a read mode, a left-out reason or a status it does not know', () => {
    expect(orgCheckpointSchema.safeParse(withContact({ readMode: 'bulk' })).success).toBe(false);
    expect(
      orgCheckpointSchema.safeParse(
        withContact({ leftOutFields: [{ field: 'Secret__c', reason: 'hidden' }] }),
      ).success,
    ).toBe(false);
    expect(orgCheckpointSchema.safeParse(checkpointWith({ status: 'done' })).success).toBe(false);
  });

  it('refuses a fingerprint that is not a sha256 in hex', () => {
    for (const fingerprint of ['A'.repeat(64), 'a'.repeat(63), 'not-a-digest']) {
      expect(orgCheckpointSchema.safeParse(withContact({ fingerprint })).success).toBe(false);
    }
  });

  it('refuses counts that are not whole and positive', () => {
    for (const records of [-1, 1.5]) {
      expect(orgCheckpointSchema.safeParse(withContact({ records })).success).toBe(false);
    }
  });

  it("refuses an org id or a checkpoint id that could name another folder than the checkpoint's own", () => {
    const org = readyCheckpoint().org as Record<string, unknown>;
    expect(
      orgCheckpointSchema.safeParse(checkpointWith({ org: { ...org, organizationId: '../00Dxx' } }))
        .success,
    ).toBe(false);
    expect(
      orgCheckpointSchema.safeParse(checkpointWith({ checkpointId: '../ck-20261022-140512-a1b2' }))
        .success,
    ).toBe(false);
  });

  it('refuses a last rewind whose id is not a rewind id', () => {
    const misnamed = checkpointWith({ lastRewind: { rewindId: 'ck-20261022-150000-e5f6' } });
    expect(orgCheckpointSchema.safeParse(misnamed).success).toBe(false);
  });

  it('refuses dates that are not instants with their zone', () => {
    expect(orgCheckpointSchema.safeParse(checkpointWith({ readFrom: '2026-10-22' })).success).toBe(
      false,
    );
    expect(
      orgCheckpointSchema.safeParse(checkpointWith({ expiresAt: 'in thirty days' })).success,
    ).toBe(false);
  });
});

describe('checkpoint folder ids', () => {
  it('takes one shape of id per kind', () => {
    expect(checkpointIdSchema.safeParse('ck-20261022-140512-a1b2').success).toBe(true);
    expect(previewIdSchema.safeParse('pv-20261022-141030-c3d4').success).toBe(true);
    expect(rewindIdSchema.safeParse('rw-20261022-141102-e5f6').success).toBe(true);
  });

  it("refuses one kind's id for another's", () => {
    expect(checkpointIdSchema.safeParse('rw-20261022-141102-e5f6').success).toBe(false);
    expect(previewIdSchema.safeParse('ck-20261022-140512-a1b2').success).toBe(false);
    expect(rewindIdSchema.safeParse('pv-20261022-141030-c3d4').success).toBe(false);
  });

  it.each([
    '../ck-20261022-140512-a1b2',
    'ck-20261022-140512-a1b2/..',
    'ck-20261022-140512-a1b2\\..',
    'ck-20261022-140512-A1B2',
    'ck-20261022-140512-a1b2.json',
    ' ck-20261022-140512-a1b2',
    'ck-2026102-140512-a1b2',
    '',
  ])('refuses %j, which is not a folder id', (id) => {
    expect(checkpointIdSchema.safeParse(id).success).toBe(false);
  });

  it('takes an Organization Id of 15 or 18 characters, and nothing else', () => {
    expect(checkpointOrganizationIdSchema.safeParse('00Dxx0000001234').success).toBe(true);
    expect(checkpointOrganizationIdSchema.safeParse('00Dxx0000001234AAA').success).toBe(true);
    expect(checkpointOrganizationIdSchema.safeParse('005xx0000001234AAA').success).toBe(false);
    expect(checkpointOrganizationIdSchema.safeParse('00Dxx0000001234AA').success).toBe(false);
  });
});

describe('checkpointNameSchema', () => {
  it('keeps a name without the spaces around it', () => {
    expect(checkpointNameSchema.parse('  Before UAT ')).toBe('Before UAT');
  });

  it('refuses a blank name, a name past 120 characters and one of two lines', () => {
    for (const name of ['', '   ', 'x'.repeat(121), 'Before\nUAT', 'Before\tUAT']) {
      expect(checkpointNameSchema.safeParse(name).success).toBe(false);
    }
    expect(checkpointNameSchema.safeParse('x'.repeat(120)).success).toBe(true);
  });
});

describe('checkpointFieldKeySchema', () => {
  it('takes a field named with its object, a namespaced one too', () => {
    for (const key of ['Case.Last_Touched__c', 'ns__Order__c.ns__Total__c', 'Account.Name']) {
      expect(checkpointFieldKeySchema.safeParse(key).success).toBe(true);
    }
  });

  it('refuses a bare field, a relationship path and anything else', () => {
    for (const key of ['Last_Touched__c', 'Case.Account.Name', 'Case.', '.Name', 'Case.Na me']) {
      expect(checkpointFieldKeySchema.safeParse(key).success).toBe(false);
    }
  });
});
