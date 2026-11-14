import { describe, it, expect } from 'vitest';

import {
  checkpointArchiveHeaderSchema,
  checkpointArchiveVersionsSchema,
  checkpointReplayAnnexSchema,
  checkpointReplayChoicesSchema,
  orgCheckpointSchema,
} from './checkpoint.schema.js';

/*
 * What a checkpoint keeps from 1.81 on to be replayed in another org: its
 * org's data storage and Staging mark, the counts of its replay annex, the
 * annex itself, the header of a file that carries it, and what a replay is
 * asked. A checkpoint SandForge 1.80 wrote reads as it did, and one 1.81
 * writes reads under 1.80's own schema, which drops what it does not know.
 */

/** A `checkpoint.json` of a Developer Edition, as SandForge 1.80 writes it. */
function writtenBy180(): Record<string, unknown> {
  return {
    version: 1,
    checkpointId: 'ck-20261113-091500-k3m9',
    name: 'Before UAT',
    org: {
      organizationId: '00Dxx0000001234AAA',
      username: 'admin@example.com',
      instanceUrl: 'https://example-dev-ed.my.salesforce.com',
      isSandbox: true,
      organizationType: 'Developer Edition',
      tier: 'sandbox',
    },
    takenBy: { userId: '005xx000001AbCdAAA', viewAllData: true, modifyAllData: true },
    readFrom: '2026-11-13T09:15:00.120Z',
    takenAt: '2026-11-13T09:15:41.902Z',
    scope: { mode: 'picked', leftOut: [] },
    objects: [
      {
        objectApiName: 'Account',
        records: 3,
        inBin: 0,
        readOrder: 0,
        readMode: 'query',
        undeletable: true,
        cascadeParents: [],
        restrictParents: [],
        fingerprint: 'c'.repeat(64),
        fields: ['Id', 'SystemModstamp', 'Name', 'OwnerId', 'RecordTypeId'],
        leftOutFields: [],
        access: 'org',
      },
    ],
    ignoredFields: [],
    snapshotId: 'snapshot-ck-20261113-091500-k3m9',
    movedWhileTaken: { changed: 0, deleted: 0, created: 0 },
    bytes: 48_211,
    expiresAt: '2026-12-13T09:15:41.902Z',
    status: 'ready',
    takenOn: { host: 'workstation', pid: 1201 },
  };
}

/** The same checkpoint as 1.81 takes it: the org's storage and mark, and the annex's counts. */
function writtenBy181(): Record<string, unknown> {
  const before = writtenBy180();
  return {
    ...before,
    org: { ...(before.org as object), dataStorageMaxMB: 5120, staging: true },
    replayAnnex: { recordTypes: 4, users: 2, queues: 1, standardPricebook: true },
  };
}

/** A replay annex as a take of a person-account org writes it. */
function annex(): Record<string, unknown> {
  return {
    version: 1,
    organizationId: '00Dxx0000001234AAA',
    recordTypes: [
      {
        id: '012xx0000000001AAA',
        sobjectType: 'Account',
        developerName: 'Retail',
        namespacePrefix: 'acme',
        name: 'Retail',
        isActive: true,
        isPersonType: true,
      },
      {
        id: '012xx0000000002',
        sobjectType: 'Case',
        developerName: 'Support_Case',
        name: 'Support',
        isActive: false,
      },
    ],
    users: [
      {
        id: '005xx000001AbCdAAA',
        username: 'admin@example.com.uat',
        name: 'Ada Admin',
        isActive: true,
        userType: 'Standard',
      },
    ],
    queues: [
      {
        id: '00Gxx0000000001AAA',
        developerName: 'Escalations',
        name: 'Escalations desk',
        sobjectTypes: ['Case', 'Lead'],
      },
    ],
    standardPricebookId: '01sxx0000000001AAA',
    unread: [],
  };
}

/** The first record type of {@link annex} with `patch` laid over it. */
function withRecordType(patch: Record<string, unknown>): Record<string, unknown> {
  const whole = annex();
  const [first, ...rest] = whole.recordTypes as Record<string, unknown>[];
  return { ...whole, recordTypes: [{ ...first, ...patch }, ...rest] };
}

/** A file's header, as SandForge 1.80 writes one, with `patch` laid over it. */
function header(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'sandforge-checkpoint',
    formatVersion: 1,
    checkpointFormat: 1,
    sandforgeVersion: '1.80.0',
    organizationId: '00Dxx0000001234AAA',
    orgTier: 'sandbox',
    checkpointId: 'ck-20261113-091500-k3m9',
    takenAt: '2026-11-13T09:15:41.902Z',
    records: 3,
    objects: 1,
    files: 6,
    bytes: 4096,
    cipher: 'aes-256-gcm',
    kdf: 'hkdf-sha256',
    salt: 'a'.repeat(64),
    noncePrefix: 'b'.repeat(16),
    keyCheck: 'c'.repeat(32),
    chunkBytes: 1_048_576,
    ...patch,
  };
}

/** What a replay is asked by default, as the command line asks it without a choice. */
function choices(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    owners: 'same',
    customSettings: false,
    mask: false,
    contactPoints: 'neutralized',
    objects: [],
    excluded: [],
    link: [],
    ...patch,
  };
}

describe('a checkpoint that keeps what a replay in another org needs', () => {
  it('reads a checkpoint SandForge 1.80 wrote, which says neither its storage, its mark nor an annex', () => {
    const parsed = orgCheckpointSchema.parse(writtenBy180());
    expect(parsed.org).not.toHaveProperty('dataStorageMaxMB');
    expect(parsed.org).not.toHaveProperty('staging');
    expect(parsed).not.toHaveProperty('replayAnnex');
    expect(parsed).toEqual(writtenBy180());
  });

  it('keeps the data storage, the Staging mark and the counts of the annex a take from 1.81 on writes', () => {
    const parsed = orgCheckpointSchema.parse(writtenBy181());
    expect(parsed.org.dataStorageMaxMB).toBe(5120);
    expect(parsed.org.staging).toBe(true);
    expect(parsed.replayAnnex).toEqual({
      recordTypes: 4,
      users: 2,
      queues: 1,
      standardPricebook: true,
    });
    expect(parsed).toEqual(writtenBy181());
  });

  it('keeps the parts of the annex the org would not answer, and refuses a part it does not know or an empty list', () => {
    const summary = { recordTypes: 0, users: 2, queues: 0, standardPricebook: false };
    const unread = { ...summary, unread: ['recordTypes', 'queues'] };
    expect(
      orgCheckpointSchema.parse({ ...writtenBy181(), replayAnnex: unread }).replayAnnex,
    ).toEqual(unread);
    for (const wrong of [['profiles'], []]) {
      expect(
        orgCheckpointSchema.safeParse({
          ...writtenBy181(),
          replayAnnex: { ...summary, unread: wrong },
        }).success,
      ).toBe(false);
    }
  });

  it('refuses a Staging mark that is not set, and a storage that is no count of megabytes', () => {
    const org = writtenBy180().org as Record<string, unknown>;
    for (const wrong of [{ staging: false }, { dataStorageMaxMB: -1 }, { dataStorageMaxMB: 1.5 }]) {
      expect(
        orgCheckpointSchema.safeParse({ ...writtenBy180(), org: { ...org, ...wrong } }).success,
      ).toBe(false);
    }
  });
});

describe('the replay annex of a checkpoint', () => {
  it('reads the record types, users, queues and standard price book a take keeps', () => {
    const parsed = checkpointReplayAnnexSchema.parse(annex());
    expect(parsed).toEqual(annex());
    expect(parsed.recordTypes[1]).not.toHaveProperty('isPersonType');
  });

  it('refuses an id of another kind than the one it names, which a replay would read the other org by', () => {
    expect(
      checkpointReplayAnnexSchema.safeParse(withRecordType({ id: '005xx000001AbCdAAA' })).success,
    ).toBe(false);
    const whole = annex();
    expect(
      checkpointReplayAnnexSchema.safeParse({ ...whole, standardPricebookId: '01uxx0000000001AAA' })
        .success,
    ).toBe(false);
    expect(
      checkpointReplayAnnexSchema.safeParse({
        ...whole,
        queues: [{ id: '005xx000001AbCdAAA', developerName: 'Q', name: 'Q', sobjectTypes: [] }],
      }).success,
    ).toBe(false);
  });

  it("refuses a developer name or a namespace that would end a statement's literal", () => {
    for (const developerName of ["Retail' OR Name != '", 'Retail Type', '1Retail', '']) {
      expect(checkpointReplayAnnexSchema.safeParse(withRecordType({ developerName })).success).toBe(
        false,
      );
    }
    expect(
      checkpointReplayAnnexSchema.safeParse(withRecordType({ namespacePrefix: "acme'" })).success,
    ).toBe(false);
  });

  it('refuses a part it does not know among those unread, and a version of the file it does not read', () => {
    expect(
      checkpointReplayAnnexSchema.safeParse({
        ...annex(),
        unread: [{ part: 'profiles', reason: 'no' }],
      }).success,
    ).toBe(false);
    expect(checkpointReplayAnnexSchema.safeParse({ ...annex(), version: 2 }).success).toBe(false);
  });
});

describe('the header of a file that carries a replay annex', () => {
  it('reads file format 2, and the storage and mark of the org, which a replay of a file received reads before any key', () => {
    const parsed = checkpointArchiveHeaderSchema.parse(
      header({
        formatVersion: 2,
        sandforgeVersion: '1.81.0',
        dataStorageMaxMB: 5120,
        staging: true,
      }),
    );
    expect(parsed.formatVersion).toBe(2);
    expect(parsed.dataStorageMaxMB).toBe(5120);
    expect(parsed.staging).toBe(true);
  });

  it('reads a header SandForge 1.80 wrote as it was', () => {
    expect(checkpointArchiveHeaderSchema.parse(header())).toEqual(header());
  });

  it('refuses a file format it does not read, which the versions alone still tell', () => {
    expect(checkpointArchiveHeaderSchema.safeParse(header({ formatVersion: 3 })).success).toBe(
      false,
    );
    expect(checkpointArchiveVersionsSchema.parse(header({ formatVersion: 3 })).formatVersion).toBe(
      3,
    );
  });
});

describe('what a replay is asked', () => {
  it('reads the defaults, and every choice a command line or a page gives', () => {
    expect(checkpointReplayChoicesSchema.parse(choices())).toEqual(choices());
    const every = choices({
      owners: 'me',
      ownerMap: { '005xx000001AbCdAAA': '005xx000009ZyXwAAA' },
      customSettings: true,
      mask: true,
      contactPoints: 'kept',
      objects: ['Account', 'Contact'],
      excluded: ['Task'],
      link: [{ objectApiName: 'Account', fields: ['AccountNumber'] }],
      noRealData: true,
    });
    expect(checkpointReplayChoicesSchema.parse(every)).toEqual(every);
  });

  it('refuses a choice it does not know, rather than replay otherwise than asked', () => {
    expect(checkpointReplayChoicesSchema.safeParse(choices({ keepOwners: true })).success).toBe(
      false,
    );
    expect(checkpointReplayChoicesSchema.safeParse(choices({ owners: 'theirs' })).success).toBe(
      false,
    );
  });

  it('refuses an object linked twice, a link without fields, a map of what is no user and a declaration unset', () => {
    for (const wrong of [
      {
        link: [
          { objectApiName: 'Account', fields: ['AccountNumber'] },
          { objectApiName: 'Account', fields: ['Name'] },
        ],
      },
      { link: [{ objectApiName: 'Account', fields: [] }] },
      { ownerMap: { '00Gxx0000000001AAA': '005xx000009ZyXwAAA' } },
      { noRealData: false },
      { objects: ["Account' OR"] },
    ]) {
      expect(checkpointReplayChoicesSchema.safeParse(choices(wrong)).success).toBe(false);
    }
  });
});
