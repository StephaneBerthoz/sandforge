/**
 * What a take says it will keep on this machine, against what it keeps.
 *
 * Gate G1 took a checkpoint of a scratch org of 202 objects holding 64 to 70
 * records — most objects empty, more than a thousand left out — and found
 * 887,925 bytes on disk where the estimate said 68,939 to 74,066: it counted
 * a kilobyte a record and the index, and nothing of `checkpoint.json` and the
 * field prints, which a small org's checkpoint is mostly made of. An org
 * shaped as that one is rebuilt here from figures the gate kept (fields per
 * object, records, objects left out and why), its rows made of values of
 * the kinds an org holds, and written by the take's own writers.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fc from 'fast-check';
import type { CheckpointLeftOutObject, CheckpointObject, OrgCheckpoint } from '@sandforge/shared';
import {
  BackupRecordStore,
  nodeBackupFiles,
  type BackupRecord,
} from '../dataops/BackupRecordStore.js';
import {
  fingerprintOf,
  type FingerprintField,
  type ObjectFingerprint,
} from './checkpointFingerprint.js';
import { compressedSnapshotFiles } from './compressedSnapshotFiles.js';
import {
  compressedFieldPrints,
  defaultCheckpointLocksDir,
  openCheckpointStore,
} from './OrgCheckpointStore.js';
import { BYTES_PER_RECORD_KEPT, takeBytes, type TakenObject } from './rewindEstimate.js';
import { compressedSnapshotFileOf, writeSnapshotIndex } from './snapshotIndex.js';

const ORG = '00Dxx0000001234EAA';
const SNAPSHOT = 'snapshot-ck-20261022-140512-a1b2';

/** What gate G1 measured of the plain checkpoint, `bytes` as the take recorded it. */
const G1_BYTES = 887_925;

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A generator of numbers in [0, 1), the same for a seed: the rows are the same at every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

const WORDS = (
  'account renewal pending invoice shipment delayed customer called back about the ' +
  'contract terms discount approved by finance north region quarterly review onboarding ' +
  'support escalation resolved warehouse partner portal training meeting scheduled'
).split(' ');

const STANDARD_FIELDS = [
  'Name',
  'OwnerId',
  'RecordTypeId',
  'Description',
  'Phone',
  'Fax',
  'Website',
  'Industry',
  'Type',
  'Rating',
  'AccountId',
  'ContactId',
  'Email',
  'Title',
  'Department',
  'LeadSource',
  'Status',
  'Priority',
  'Subject',
  'StartDate',
  'EndDate',
  'Amount',
  'CloseDate',
  'StageName',
  'BillingStreet',
  'BillingCity',
  'BillingPostalCode',
  'BillingCountry',
  'MailingStreet',
  'MailingCity',
  'IsActive',
  'NumberOfEmployees',
  'AnnualRevenue',
  'ParentId',
  'Origin',
];

/** The stamps every row of a checkpoint carries. */
const STAMPS = [
  'Id',
  'SystemModstamp',
  'CreatedDate',
  'CreatedById',
  'LastModifiedDate',
  'LastModifiedById',
];

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * The `n`-th id of a key prefix, as an org hands them out: one pod, one
 * counter, each record's id a few after the one before, three characters of
 * checksum at its end.
 */
function idOf(prefix: string, n: number, random: () => number): string {
  let counter = '';
  for (let rest = 1_000_000 + n * 7; counter.length < 9; rest = Math.floor(rest / 62)) {
    counter = BASE62[rest % 62] + counter;
  }
  const check = Array.from({ length: 3 }, () => BASE62[10 + Math.floor(random() * 26)]).join('');
  return `${prefix}Kx${counter}A${check}`.slice(0, 18);
}

/**
 * A value of the kind the field's name says, empty half the time but for the
 * stamps: dates to the second, as the org writes them; the users who create
 * and change records, the owners and the record types few; lookups to some
 * fifty records.
 */
function valueOf(field: string, random: () => number, n: number): unknown {
  if (field === 'Id') return idOf('001', n, random);
  if (field === 'SystemModstamp' || field.endsWith('Date')) {
    return new Date(Date.UTC(2026, 9, 1) + Math.floor(random() * 2e6) * 1000)
      .toISOString()
      .replace('Z', '+0000');
  }
  if (field.endsWith('ById') || field === 'OwnerId')
    return idOf('005', Math.floor(random() * 5), () => 0.5);
  if (random() < 0.5) return null;
  if (field === 'RecordTypeId') return idOf('012', Math.floor(random() * 3), () => 0.5);
  if (field.endsWith('Id')) return idOf('001', Math.floor(random() * 50), () => 0.5);
  if (field.startsWith('Is')) return random() < 0.5;
  if (/Amount|Revenue|Number|Count/.test(field)) return Math.round(random() * 1e7) / 100;
  if (field === 'Email') return `user${Math.floor(random() * 1e6)}@example${n % 7}.com`;
  if (field === 'Phone' || field === 'Fax')
    return `+1 555 ${String(Math.floor(random() * 1e7)).padStart(7, '0')}`;
  const words = 1 + Math.floor(random() * (field === 'Description' ? 40 : 3));
  return Array.from({ length: words }, () => WORDS[Math.floor(random() * WORDS.length)]).join(' ');
}

/** A row of an object as the snapshot keeps it: the org's attributes, then every field it holds. */
function rowOf(
  object: string,
  fields: readonly string[],
  random: () => number,
  n: number,
): BackupRecord {
  const row: BackupRecord = {
    attributes: { type: object, url: `/services/data/v66.0/sobjects/${object}/x${n}` },
  };
  for (const field of fields) row[field] = valueOf(field, random, n);
  return row;
}

/** An object as gate G1's org had them: its fields, its prints, its records, its entry. */
interface Shaped {
  objectApiName: string;
  fields: string[];
  print: ObjectFingerprint;
  records: number;
  entry: CheckpointObject;
}

/** The records of the twelve objects that held any at gate G1, 64 in all. */
const HELD = [1, 1, 12, 1, 7, 2, 7, 1, 1, 1, 29, 1];

/** Fields every object's describe lists, alike: their prints are the same in each. */
const SYSTEM_FIELDS = [
  'IsDeleted',
  'LastViewedDate',
  'LastReferencedDate',
  'MasterRecordId',
  'CurrencyIsoCode',
  'LastActivityDate',
  'ConnectionReceivedId',
  'ConnectionSentId',
  'UserRecordAccessId',
];

/** A field as a describe lists it, for its print. */
const describedField = (name: string): FingerprintField => ({
  name,
  type: name.endsWith('Id') ? 'reference' : 'string',
  createable: !SYSTEM_FIELDS.includes(name),
  updateable: !SYSTEM_FIELDS.includes(name),
  nillable: true,
  referenceTo: name.endsWith('Id') ? ['Account'] : [],
  encrypted: false,
});

/**
 * An org shaped as gate G1's: 202 objects, 18 fields kept each about and 89
 * described — the stamps, the fields kept, those every object has, then its
 * own formulas, roll-ups and read-only fields — and 1,118 objects left out.
 * 18 kept and 1,118 left out are the gate's; 89 described is what its plain
 * prints' size says, about 670 KB at 37 bytes a field.
 */
function shapedOrg(random: () => number): {
  objects: Shaped[];
  leftOut: CheckpointLeftOutObject[];
} {
  const objects: Shaped[] = [];
  for (let n = 0; n < 202; n++) {
    const objectApiName = n < STANDARD_FIELDS.length ? `Standard${n}` : `Object_${n}__c`;
    const kept = 4 + Math.floor(random() * 24);
    const fields = [
      ...STAMPS,
      ...Array.from({ length: kept }, (_, k) =>
        k < STANDARD_FIELDS.length && random() < 0.7 ? STANDARD_FIELDS[k] : `Custom_Field_${k}__c`,
      ),
    ].filter((field, at, all) => all.indexOf(field) === at);
    const own = Array.from(
      { length: 50 + Math.floor(random() * 30) },
      (_, k) => `${objectApiName.replace(/__c$/, '')}_Rollup_${k}__c`,
    );
    const print = fingerprintOf([...fields, ...SYSTEM_FIELDS, ...own].map(describedField));
    const records = n < HELD.length ? HELD[n] : 0;
    const leftOutFields =
      random() < 0.4 ? [{ field: 'BillingAddress', reason: 'compound' as const }] : [];
    const entry: CheckpointObject = {
      objectApiName,
      records,
      inBin: 0,
      readOrder: n,
      readMode: 'query',
      undeletable: random() < 0.8,
      cascadeParents: random() < 0.5 ? ['AccountId'] : [],
      restrictParents: random() < 0.4 ? ['ParentId'] : [],
      fingerprint: print.digest,
      fields,
      leftOutFields,
    };
    objects.push({ objectApiName, fields, print, records, entry });
  }
  const reasons = [
    'Users, permissions and setup are left out.',
    'Change events are left out.',
    'Chatter posts, comments and feeds are left out: Salesforce brings a post back only with what it was posted on.',
    "History is left out: it is the org's own trace of changes.",
    'Sharing is left out: the org keeps it itself.',
    'Left out: the user SandForge connects as may not create, edit and delete its records.',
  ];
  const leftOut = Array.from({ length: 1_118 }, (_, n) => ({
    objectApiName: `Left_Out_Object_${n}`,
    reason: reasons[n % reasons.length],
  }));
  return { objects, leftOut };
}

/** The shaped org's prints, by object, as the take keeps them. */
const printsOf = (objects: readonly Shaped[]): Record<string, ObjectFingerprint> =>
  Object.fromEntries(objects.map(({ objectApiName, print }) => [objectApiName, print]));

/** What the take's estimate says of the shaped org, given what the take knows before it reads. */
async function estimateOf(
  objects: readonly Shaped[],
  leftOut: readonly CheckpointLeftOutObject[],
): Promise<number> {
  return takeBytes({
    objects: objects.map(({ records, entry }): TakenObject => ({ records, entry })),
    leftOut,
    printsBytes: (await compressedFieldPrints(printsOf(objects))).length,
  });
}

/** A store in a folder of its own. */
function storeIn() {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-take-bytes-'));
  made.push(dir);
  const opened = openCheckpointStore({
    root: join(dir, 'checkpoints'),
    locksDir: defaultCheckpointLocksDir(join(dir, 'home')),
  });
  if (!('store' in opened)) throw new Error(`refused: ${opened.refusal.reason}`);
  return opened.store;
}

/** Bytes the files under `dir` take. */
function bytesUnder(dir: string): number {
  return readdirSync(dir, { withFileTypes: true }).reduce(
    (sum, entry) =>
      sum +
      (entry.isDirectory()
        ? bytesUnder(join(dir, entry.name))
        : statSync(join(dir, entry.name)).size),
    0,
  );
}

/** An entry of `checkpoint.json` holding `fields`, for the property. */
function entryWith(records: number, fields: readonly string[]): CheckpointObject {
  return {
    objectApiName: 'Account',
    records,
    inBin: 0,
    readOrder: 0,
    readMode: 'query',
    undeletable: true,
    cascadeParents: [],
    fingerprint: '0'.repeat(64),
    fields: [...fields],
    leftOutFields: [],
  };
}

describe('takeBytes', () => {
  it('grows with the records, the fields and the prints of what a take holds, and with what it leaves out', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ records: fc.nat(10_000), fields: fc.nat(200) }), {
          minLength: 1,
          maxLength: 30,
        }),
        fc.nat(29),
        fc.integer({ min: 1, max: 500 }),
        fc.nat(100_000),
        (shapes, at, more, printsBytes) => {
          const objects = shapes.map(({ records, fields }) => ({
            records,
            entry: entryWith(
              records,
              Array.from({ length: fields }, (_, k) => `Field_${k}__c`),
            ),
          }));
          const bytes = takeBytes({ objects, printsBytes });
          const i = at % objects.length;
          const withRecords = objects.map((object, k) =>
            k === i ? { ...object, records: object.records + more } : object,
          );
          const withFields = objects.map((object, k) =>
            k === i
              ? {
                  ...object,
                  entry: { ...object.entry, fields: [...object.entry.fields, 'Extra__c'] },
                }
              : object,
          );
          expect(takeBytes({ objects: withRecords, printsBytes })).toBeGreaterThan(bytes);
          expect(takeBytes({ objects: withFields, printsBytes })).toBeGreaterThan(bytes);
          expect(takeBytes({ objects, printsBytes: printsBytes + more })).toBe(bytes + more);
          expect(
            takeBytes({
              objects,
              printsBytes,
              leftOut: [{ objectApiName: 'FeedItem', reason: 'Change events are left out.' }],
            }),
          ).toBeGreaterThan(bytes);
        },
      ),
      { numRuns: 200, seed: 4403 },
    );
  });

  it('counts what checkpoint.json lists of an object and of one left out as the store writes them', async () => {
    const store = storeIn();
    const folder = await store.create(ORG, 'ck-20261022-140512-e5f6');
    const objects = [entryWith(3, ['Id', 'SystemModstamp', 'Name']), entryWith(0, ['Id'])];
    const leftOut = [
      { objectApiName: 'User', reason: 'Users, permissions and setup are left out.' },
    ];
    const base = { scope: { mode: 'everything' as const, leftOut: [] }, objects: [] };
    const sizeOf = (patch: Partial<OrgCheckpoint>): number =>
      Buffer.byteLength(
        `${JSON.stringify({ ...checkpointOf(folder.checkpointId), ...base, ...patch }, null, 2)}\n`,
      );

    const listed = sizeOf({ objects, scope: { mode: 'everything', leftOut } }) - sizeOf({});
    const counted =
      takeBytes({ objects: objects.map((entry) => ({ records: 0, entry })), leftOut }) -
      takeBytes({ objects: objects.map(() => ({ records: 0 })) });

    expect(counted).toBe(listed);
  });

  it('counts each id of the recycle bin at T0 as bin/ keeps it, an object holding no record among them: the 77,624 ids a scratch org’s bin held took 2,173,472 bytes', () => {
    const none = takeBytes({ objects: [{ records: 0 }, { records: 1 }] });

    const withBin = takeBytes({
      objects: [
        { records: 0, inBin: 64_792 },
        { records: 1, inBin: 77_624 - 64_792 },
      ],
    });

    expect(withBin - none).toBe(2_173_472);
  });

  it('says of an org shaped as gate G1’s about what the gate measured, within half of it either way', async () => {
    const { objects, leftOut } = shapedOrg(seeded(1));
    expect(objects.reduce((sum, object) => sum + object.records, 0)).toBe(64);

    const bytes = await estimateOf(objects, leftOut);

    expect(bytes).toBeGreaterThan(G1_BYTES / 2);
    expect(bytes).toBeLessThan(G1_BYTES * 2);
  });

  it('says of such an org, written by the take’s own writers and compressed, what its files then take, within half of it', async () => {
    const random = seeded(2);
    const { objects, leftOut } = shapedOrg(random);
    const store = storeIn();
    const folder = await store.create(ORG, 'ck-20261022-140512-a1b2');
    const values = new BackupRecordStore(compressedSnapshotFiles(nodeBackupFiles(folder.dir)));
    for (const object of objects) {
      await values.begin(SNAPSHOT, object.objectApiName);
      const rows = Array.from({ length: object.records }, (_, n) =>
        rowOf(object.objectApiName, object.fields, random, n),
      );
      await values.append(SNAPSHOT, object.objectApiName, rows);
      await writeSnapshotIndex(folder, SNAPSHOT, object.objectApiName);
    }
    await store.writeFingerprints(folder, printsOf(objects));
    await store.write({
      ...checkpointOf(folder.checkpointId),
      scope: { mode: 'everything', leftOut },
      objects: objects.map(({ entry }) => entry),
    });

    // The snapshot's DataOps metadata, some hundreds of bytes, is not written here.
    const real = bytesUnder(folder.dir);
    const estimated = await estimateOf(objects, leftOut);

    expect(estimated).toBeGreaterThan(real * 0.5);
    expect(estimated).toBeLessThan(real * 1.5);
    // Compressed, the same org takes less than its plain checkpoint did.
    expect(real).toBeLessThan(G1_BYTES);
  });

  it('keeps a row of the values an org holds in fewer bytes than the estimate counts a record', async () => {
    const random = seeded(3);
    const fields = [
      ...STAMPS,
      ...STANDARD_FIELDS.slice(0, 30),
      ...Array.from({ length: 13 }, (_, k) => `Custom_Field_${k}__c`),
    ];
    const store = storeIn();
    const folder = await store.create(ORG, 'ck-20261022-140512-c3d4');
    const values = new BackupRecordStore(compressedSnapshotFiles(nodeBackupFiles(folder.dir)));
    const rows = Array.from({ length: 2_000 }, (_, n) => rowOf('Contact', fields, random, n));

    await values.begin(SNAPSHOT, 'Contact');
    await values.append(SNAPSHOT, 'Contact', rows);

    const plain = rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)) + 1, 0);
    const kept = statSync(compressedSnapshotFileOf(folder, SNAPSHOT, 'Contact')).size;
    // Plain, more than a kilobyte a row; compressed, 232 bytes.
    expect(plain / rows.length).toBeGreaterThan(1_000);
    expect(kept / rows.length).toBeLessThan(BYTES_PER_RECORD_KEPT);
  });
});

/** A checkpoint's file of no object, as the store writes one. */
function checkpointOf(checkpointId: string): OrgCheckpoint {
  return {
    version: 1,
    checkpointId,
    name: 'Checkpoint of DEV-ED, 22 Oct 2026 14:05',
    org: {
      organizationId: ORG,
      alias: 'DEV-ED',
      username: 'admin@example.com',
      instanceUrl: 'https://example-dev-ed.my.salesforce.com',
      isSandbox: false,
      organizationType: 'Developer Edition',
      tier: 'developer',
    },
    takenBy: { userId: '005xx000001AbCdAAA', viewAllData: true, modifyAllData: true },
    readFrom: '2026-10-22T14:05:12.000Z',
    takenAt: '2026-10-22T14:06:23.000Z',
    scope: { mode: 'everything', leftOut: [] },
    objects: [],
    ignoredFields: [],
    snapshotId: SNAPSHOT,
    movedWhileTaken: { changed: 0, deleted: 0, created: 0 },
    bytes: 0,
    expiresAt: '2026-11-21T14:06:23.000Z',
    status: 'ready',
    takenOn: { host: 'workstation', pid: 4242 },
  };
}
