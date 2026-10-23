import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CheckpointObject, CheckpointReadMode, RewindDiffObject } from '@sandforge/shared';
import { canonicalRecordId } from '../../core/common/existingRecordMatch.js';
import { BackupRecordStore, nodeBackupFiles } from '../dataops/BackupRecordStore.js';
import {
  MEMORY_ORG_USER,
  MemoryRemovalOrg,
  factCombinations,
  orgError,
  type MemoryChild,
  type MemoryOrgFacts,
  type MemoryRow,
} from '../../test/memoryRemovalOrg.js';
import {
  fingerprintOf,
  type FingerprintField,
  type ObjectFingerprint,
} from './checkpointFingerprint.js';
import {
  OrgReadStopped,
  compositeReader,
  type CompositeQueryConnection,
  type OrgRow,
} from './compositeQueries.js';
import { binLedgerRead, spoolReads, spooledRows } from './orgStreams.js';
import {
  binFileOf,
  defaultCheckpointLocksDir,
  indexFileOf,
  openCheckpointStore,
  previewDirOf,
  type CheckpointFolder,
  type OrgCheckpointStore,
} from './OrgCheckpointStore.js';
import { writeSnapshotIndex } from './snapshotIndex.js';
import { classFileOf, rewindDiff, type RewindClass } from './rewindDiff.js';

const ORG = '00Dxx0000001234EAA';
const CHECKPOINT = 'ck-20261022-100000-a1b2';
const PREVIEW = 'pv-20261022-100200-c3d4';
/** The snapshot's DataOps operation id, as the checkpoint names it. */
const SNAPSHOT = 'op-1792700000000';

/** T0, with milliseconds, as the org's clock gives it. */
const T0_MS = Date.parse('2026-10-22T10:00:00.400Z');
const T0 = new Date(T0_MS).toISOString();
const DAY_MS = 24 * 60 * 60_000;
/** A day before the checkpoint, when its records were made. */
const BEFORE = new Date(T0_MS - DAY_MS).toISOString();

/** An id in its 18-character form, from a prefix and a number. */
function idOf(prefix: string, n: number): string {
  const id = canonicalRecordId(`${prefix}xx${String(n).padStart(10, '0')}`);
  if (!id) throw new Error(`Not an id: ${prefix} ${n}`);
  return id;
}
const accountId = (n: number): string => idOf('001', n);
const contactId = (n: number): string => idOf('003', n);
const opportunityId = (n: number): string => idOf('006', n);
const taskId = (n: number): string => idOf('00T', n);
const lineId = (n: number): string => idOf('00k', n);
const noteId = (n: number): string => idOf('a0n', n);

/** A user of the org other than the one the session writes as. */
const COLLEAGUE = '005000000000002AAA';

/** Never touched since it was made, a day before the checkpoint. */
const KEPT = accountId(1);
/** Edited two minutes before the checkpoint: read by the change reads, never since. */
const RECENT = accountId(2);
/** The record a scenario is about. */
const SUBJECT = accountId(10);
const OTHER = accountId(11);

const STAMPS = ['Id', 'SystemModstamp', 'CreatedDate', 'LastModifiedDate', 'LastModifiedById'];

/** An object of the scenarios, as the checkpoint holds it. */
interface Held {
  objectApiName: string;
  fields: string[];
  readMode?: CheckpointReadMode;
  undeletable?: boolean;
  /** Its fields whose parent's delete takes a record along. */
  cascadeParents?: string[];
  /** Its fields whose parent's delete a live record refuses. */
  restrictParents?: string[];
  /** Its fields as the take described them: each of {@link fields} a text unless told. */
  described?: FingerprintField[];
}

/** Fields as a describe lists them, each a text the user may create and edit unless told. */
function describedOf(
  fields: readonly string[],
  types: Record<string, string> = {},
): FingerprintField[] {
  return fields.map((name) => ({
    name,
    type: types[name] ?? 'string',
    createable: true,
    updateable: true,
  }));
}

const ACCOUNT: Held = {
  objectApiName: 'Account',
  fields: [...STAMPS, 'Name', 'Industry', 'Description', 'Due__c'],
};
const CONTACT: Held = {
  objectApiName: 'Contact',
  fields: [...STAMPS, 'LastName', 'AccountId', 'ReportsToId'],
};
const TASK: Held = {
  objectApiName: 'Task',
  fields: [...STAMPS, 'Subject'],
  readMode: 'scanAllLive',
};
const LINE: Held = {
  objectApiName: 'OpportunityLineItem',
  fields: [...STAMPS, 'Quantity'],
  undeletable: false,
};
/** A contact whose account's delete takes it along. */
const CASCADE_CONTACT: Held = { ...CONTACT, cascadeParents: ['AccountId'] };
/** A note its contact's delete takes along, which comes back from the bin on its own. */
const NOTE: Held = {
  objectApiName: 'Note__c',
  fields: [...STAMPS, 'Body__c', 'Contact__c'],
  cascadeParents: ['Contact__c'],
};
/** A case whose account lookup restricts the account's delete, as seen live: never deleted along. */
const CASE: Held = {
  objectApiName: 'Case',
  fields: [...STAMPS, 'Subject', 'AccountId'],
  restrictParents: ['AccountId'],
};
const caseId = (n: number): string => idOf('500', n);
/** The account's describe, as the org lists that lookup. */
const RESTRICTING = {
  Account: [{ childSObject: 'Case', field: 'AccountId', restrictedDelete: true }],
};
const OPPORTUNITY: Held = {
  objectApiName: 'Opportunity',
  fields: [...STAMPS, 'Name', 'StageName'],
};
/** An opportunity's product: deleted with its opportunity, brought back with it only. */
const PRODUCT: Held = {
  objectApiName: 'OpportunityLineItem',
  fields: [...STAMPS, 'Quantity', 'OpportunityId'],
  undeletable: false,
  cascadeParents: ['OpportunityId'],
};

type Act = (org: MemoryRemovalOrg) => void;

/** A history of an org around a checkpoint, each part at its moment of the org's clock. */
interface Scenario {
  objects?: Held[];
  children?: Record<string, MemoryChild[]>;
  /** Whether the two records every scenario holds besides its own are made: yes unless told. */
  background?: boolean;
  ignoredFields?: string[];
  /** A day before T0. */
  before?: Act;
  /** Before T0, inside the change reads' five minutes: two minutes before unless told. */
  nearT0?: Act;
  nearT0Ms?: number;
  /** While taken: after the bin was read, a tenth of a second before the snapshot reads. */
  whileTaken?: Act;
  /** A tenth of a second after the snapshot read, in the same second. */
  afterRead?: Act;
  /** Since the checkpoint: a minute after T0. */
  since?: Act;
  /** Later since the checkpoint, in another second: half a minute after {@link since}. */
  later?: Act;
  /** When the snapshot reads, after T0: 200 ms unless told. */
  readAfterMs?: number;
  pageSize?: number;
  /** Open cursors past which the org releases the oldest: none unless told. */
  cursorLimit?: number;
}

/**
 * A line of a class's file: the record's id, for one given back the fields
 * that differ and, of them, the lookups a deletion cleared, and for one Undo
 * couldn't bring back why, when it is not the first reason.
 */
type ClassLine = { Id: string; fields?: string[]; cleared?: string[]; reason?: string };
type Classes = Partial<Record<RewindClass, ClassLine[]>>;

const CLASSES: RewindClass[] = [
  'giveBack',
  'touched',
  'createdSince',
  'broughtBackSince',
  'comesBackWithParent',
  'unexplained',
  'inBin',
  'withParent',
  'deletedWhileTaken',
  'goneForGood',
  'convertedLead',
  'undoCannot',
];

const lines = (...ids: string[]): ClassLine[] => ids.map((id) => ({ Id: id }));

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A checkpoint's folder, made by the store, as a take makes it. */
async function folderOf(): Promise<{ store: OrgCheckpointStore; folder: CheckpointFolder }> {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-rewind-diff-'));
  made.push(dir);
  const opened = openCheckpointStore({
    root: join(dir, 'checkpoints'),
    locksDir: defaultCheckpointLocksDir(join(dir, 'home')),
  });
  if (!('store' in opened)) throw new Error(`refused: ${opened.refusal.reason}`);
  return { store: opened.store, folder: await opened.store.create(ORG, CHECKPOINT) };
}

/** Every row `soql` selects, page after page. */
async function allRows(org: MemoryRemovalOrg, soql: string, scanAll: boolean): Promise<OrgRow[]> {
  let page = await org.query(soql, { scanAll });
  const rows: OrgRow[] = [...page.records];
  while (!page.done && page.nextRecordsUrl) {
    page = await org.queryMore(page.nextRecordsUrl);
    rows.push(...page.records);
  }
  return rows;
}

/** What a scenario left: the org, the checkpoint taken of it, and the diff read since. */
interface Taken {
  org: MemoryRemovalOrg;
  folder: CheckpointFolder;
  objects: CheckpointObject[];
  /** T1: once every object was read. */
  takenAt: string;
}

/**
 * Take a checkpoint of the memory org as a take does — the bin at T0, then
 * each object's snapshot and index — around the scenario's moments.
 */
async function take(scenario: Scenario, facts?: Partial<MemoryOrgFacts>): Promise<Taken> {
  let clock = T0_MS - DAY_MS;
  const org = new MemoryRemovalOrg(scenario.children ?? {}, {
    now: () => clock,
    ...(facts ? { facts } : {}),
    ...(scenario.pageSize ? { pageSize: scenario.pageSize } : {}),
    ...(scenario.cursorLimit ? { cursorLimit: scenario.cursorLimit } : {}),
  });
  const held = scenario.objects ?? [ACCOUNT];
  for (const object of held) {
    if (object.undeletable === false) org.comesBackOnlyWithParent.add(object.objectApiName);
  }
  if (scenario.background !== false) {
    org.add('Account', { Id: KEPT, Name: 'Kept', Industry: 'Energy' });
    org.add('Account', { Id: RECENT, Name: 'Recent', Industry: 'Energy' });
  }
  scenario.before?.(org);
  clock = T0_MS + (scenario.nearT0Ms ?? -120_000);
  if (scenario.background !== false) org.edit('Account', RECENT, { Industry: 'Retail' });
  scenario.nearT0?.(org);

  clock = T0_MS;
  const { store: checkpoints, folder } = await folderOf();
  const prints: Record<string, ObjectFingerprint> = {};
  for (const object of held) {
    prints[object.objectApiName] = fingerprintOf(object.described ?? describedOf(object.fields));
  }
  const bin = await spoolReads(
    compositeReader(org),
    held.map((object) => ({
      ...binLedgerRead(object.objectApiName, T0),
      file: binFileOf(folder, object.objectApiName),
    })),
  );
  expect(bin.every((outcome) => outcome.read)).toBe(true);

  const readAt = T0_MS + (scenario.readAfterMs ?? 200);
  clock = readAt - 100;
  scenario.whileTaken?.(org);
  clock = readAt;
  const store = new BackupRecordStore(nodeBackupFiles(folder.dir));
  const objects: CheckpointObject[] = [];
  for (const [readOrder, object] of held.entries()) {
    const readMode = object.readMode ?? 'query';
    const scanAll = readMode === 'scanAllLive';
    const rows = await allRows(
      org,
      `SELECT ${object.fields.join(', ')} FROM ${object.objectApiName}${scanAll ? ' WHERE IsDeleted = false' : ''}`,
      scanAll,
    );
    await store.begin(SNAPSHOT, object.objectApiName);
    // As DataOps keeps a row: with the org's `attributes`, which no comparison reads.
    await store.append(
      SNAPSHOT,
      object.objectApiName,
      rows.map((row) => ({ attributes: { type: object.objectApiName }, ...row })),
    );
    const index = await writeSnapshotIndex(folder, SNAPSHOT, object.objectApiName);
    objects.push({
      objectApiName: object.objectApiName,
      records: index.rows,
      inBin: bin[readOrder].rows,
      readOrder,
      readMode,
      undeletable: object.undeletable ?? true,
      cascadeParents: object.cascadeParents ?? [],
      ...(object.restrictParents ? { restrictParents: object.restrictParents } : {}),
      fingerprint: prints[object.objectApiName].digest,
      fields: object.fields,
      leftOutFields: [],
    });
  }
  await checkpoints.writeFingerprints(folder, prints);
  clock = readAt + 100;
  scenario.afterRead?.(org);
  const takenAt = new Date(readAt + 200).toISOString();
  clock = T0_MS + 60_000;
  scenario.since?.(org);
  clock = T0_MS + 90_000;
  scenario.later?.(org);
  clock = T0_MS + 120_000;
  return { org, folder, objects, takenAt };
}

/** When the diffs of the scenarios read the org unless told: two minutes after T0. */
const READ_AT = new Date(T0_MS + 120_000).toISOString();

/** The diff since the checkpoint `taken` holds, read now. */
async function diffOf(
  taken: Taken,
  options: {
    ignoredFields?: string[];
    conn?: CompositeQueryConnection;
    signal?: AbortSignal;
    readAt?: string;
    describeGlobal?: () => Promise<unknown>;
  } = {},
) {
  return rewindDiff({
    checkpoint: {
      checkpointId: CHECKPOINT,
      readFrom: T0,
      takenAt: taken.takenAt,
      objects: taken.objects,
      ignoredFields: options.ignoredFields ?? [],
      snapshotId: SNAPSHOT,
    },
    folder: taken.folder,
    reader: compositeReader(options.conn ?? taken.org),
    describeGlobal: options.describeGlobal ?? (() => taken.org.describeGlobal()),
    previewId: PREVIEW,
    readAt: options.readAt ?? READ_AT,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** The lines of every class the preview wrote of an object. */
async function classesOf(folder: CheckpointFolder, objectApiName: string): Promise<Classes> {
  const dir = previewDirOf(folder, PREVIEW);
  const classes: Classes = {};
  for (const cls of CLASSES) {
    const file = classFileOf(dir, objectApiName, cls);
    if (!existsSync(file)) continue;
    const got: ClassLine[] = [];
    for await (const row of spooledRows(file)) got.push(row as ClassLine);
    classes[cls] = got;
  }
  return classes;
}

/** What a diff says of an object beside what its classes count. */
type Extras = Partial<
  Pick<RewindDiffObject, 'outside' | 'lastChangedBy' | 'schemaDrift' | 'notCompared'>
>;

/** What the diff says of an object whose classes are `classes`, and of it besides. */
function objectOf(objectApiName: string, classes: Classes, extras: Extras = {}): RewindDiffObject {
  const count = (cls: RewindClass): number => classes[cls]?.length ?? 0;
  const gone = count('goneForGood');
  const givenBack = classes.giveBack ?? [];
  return {
    objectApiName,
    toDelete: {
      createdSince: count('createdSince'),
      broughtBackSince: count('broughtBackSince'),
      comesBackWithParent: count('comesBackWithParent'),
    },
    toGiveBack: {
      records: count('giveBack'),
      fields: givenBack.reduce((sum, line) => sum + (line.fields?.length ?? 0), 0),
      clearedLookups: givenBack.filter((line) => (line.cleared?.length ?? 0) > 0).length,
    },
    toBringBack: {
      inBin: count('inBin'),
      withParent: count('withParent'),
      deletedWhileTaken: count('deletedWhileTaken'),
    },
    cannotUndo: gone > 0 ? [{ reason: 'goneForGood', count: gone }] : [],
    outside: extras.outside ?? [],
    touched: count('touched'),
    unexplained: count('unexplained'),
    lastChangedBy: extras.lastChangedBy ?? {},
    ...(extras.schemaDrift ? { schemaDrift: extras.schemaDrift } : {}),
    notCompared: extras.notCompared ?? [],
  };
}

/** The facts the org's probes could not all settle, or that a record's class could lean on. */
const UNKNOWN_FACTS = factCombinations([
  'childDeletedAloneStays',
  'undeleterIsLastModifier',
  'clearedLookupRestamps',
  'undeleteRestoresLookups',
  'hardDeleteInQueryAll',
]);

/** A row of the classification: a history, and what the diff tells of it under each fact. */
interface Row {
  name: string;
  scenario: Scenario;
  /** The classes of each object, by object; an object not named has none. */
  expect: (facts: MemoryOrgFacts) => Record<string, Classes>;
  /** The facts the row is held to; every combination unless told. */
  under?: (facts: MemoryOrgFacts) => boolean;
  /** What the diff says of each object beside its classes, by object. */
  extras?: (facts: MemoryOrgFacts) => Record<string, Extras>;
}

/** Each record the session's user last changed, counted for it. */
const bySession = (count: number): Extras => ({ lastChangedBy: { [MEMORY_ORG_USER]: count } });

const subject = (values: Record<string, unknown> = {}): MemoryRow => ({
  Id: SUBJECT,
  Name: 'Acme',
  Industry: 'Energy',
  ...values,
});

const ROWS: Row[] = [
  {
    name: 'changed since, a compared field differs: given back, the fields that differ named',
    scenario: {
      before: (org) => org.add('Account', subject()),
      since: (org) => org.edit('Account', SUBJECT, { Industry: 'Retail', Description: 'new' }),
    },
    expect: () => ({
      Account: { giveBack: [{ Id: SUBJECT, fields: ['Industry', 'Description'] }] },
    }),
    extras: () => ({ Account: bySession(1) }),
  },
  {
    name: 'stamped since over its checkpoint values — an edit undone: touched, nothing to give back',
    scenario: {
      before: (org) => org.add('Account', subject()),
      since: (org) => {
        org.edit('Account', SUBJECT, { Industry: 'Retail' });
        org.edit('Account', SUBJECT, { Industry: 'Energy' });
      },
    },
    expect: () => ({ Account: { touched: lines(SUBJECT) } }),
  },
  {
    name: 'stamped since over the same values as the org holds them — an empty text for nothing, a date and time written another way: touched',
    scenario: {
      before: (org) =>
        org.add('Account', subject({ Description: null, Due__c: '2026-11-01T09:00:00.000+00:00' })),
      since: (org) =>
        org.edit('Account', SUBJECT, { Description: '', Due__c: '2026-11-01T09:00:00Z' }),
    },
    expect: () => ({ Account: { touched: lines(SUBJECT) } }),
  },
  {
    name: 'written again in the second the snapshot read it, after the read: a candidate by its second, given back (m2)',
    scenario: {
      before: (org) => org.add('Account', subject()),
      whileTaken: (org) => org.edit('Account', SUBJECT, { Industry: 'Mining' }),
      afterRead: (org) => org.edit('Account', SUBJECT, { Industry: 'Retail' }),
    },
    expect: () => ({ Account: { giveBack: [{ Id: SUBJECT, fields: ['Industry'] }] } }),
    extras: () => ({ Account: bySession(1) }),
  },
  {
    name: 'written again in the second its object was read, thirty seconds into the take: given back too (m2)',
    scenario: {
      readAfterMs: 30_200,
      before: (org) => org.add('Account', subject()),
      whileTaken: (org) => org.edit('Account', SUBJECT, { Industry: 'Mining' }),
      afterRead: (org) => org.edit('Account', SUBJECT, { Industry: 'Retail' }),
    },
    expect: () => ({ Account: { giveBack: [{ Id: SUBJECT, fields: ['Industry'] }] } }),
    extras: () => ({ Account: bySession(1) }),
  },
  {
    name: 'written in the second the snapshot read it, before the read, and not since: as the checkpoint holds it, neither given back nor touched',
    scenario: {
      before: (org) => org.add('Account', subject()),
      whileTaken: (org) => org.edit('Account', SUBJECT, { Industry: 'Mining' }),
    },
    expect: () => ({}),
  },
  {
    name: 'in the recycle bin at the checkpoint and brought back since: to delete, back to the bin (A6)',
    scenario: {
      before: (org) => {
        org.add('Account', subject());
        org.trash('Account', SUBJECT);
      },
      since: (org) => org.untrash(SUBJECT),
    },
    expect: () => ({ Account: { broughtBackSince: lines(SUBJECT) } }),
    extras: () => ({ Account: bySession(1) }),
  },
  {
    name: 'deleted since and brought back before the preview: touched, never brought back since (M5)',
    scenario: {
      before: (org) => org.add('Account', subject()),
      since: (org) => {
        org.trash('Account', SUBJECT);
        org.untrash(SUBJECT);
      },
    },
    expect: () => ({ Account: { touched: lines(SUBJECT) } }),
  },
  {
    name: 'created since: to delete (A1)',
    scenario: { since: (org) => org.add('Account', subject()) },
    expect: () => ({ Account: { createdSince: lines(SUBJECT) } }),
  },
  {
    name: 'live, neither held nor in the bin, dated before the checkpoint — a load with back-dated creation dates: left and named (A7)',
    scenario: { since: (org) => org.add('Account', subject({ CreatedDate: BEFORE })) },
    expect: () => ({ Account: { unexplained: lines(SUBJECT) } }),
  },
  {
    name: 'deleted since, in the recycle bin: to bring back (C1)',
    scenario: {
      before: (org) => org.add('Account', subject()),
      since: (org) => org.trash('Account', SUBJECT),
    },
    expect: () => ({ Account: { inBin: lines(SUBJECT) } }),
  },
  {
    name: 'deleted since on its own, of an object Salesforce undeletes only with its parent, no parent coming back: it cannot come back with its id, named (C4, C3)',
    scenario: {
      objects: [ACCOUNT, LINE],
      before: (org) => org.add('OpportunityLineItem', { Id: lineId(1), Quantity: 2 }),
      since: (org) => org.trash('OpportunityLineItem', lineId(1)),
    },
    expect: () => ({ OpportunityLineItem: { goneForGood: lines(lineId(1)) } }),
  },
  {
    name: 'live at the checkpoint and deleted before its object was read: brought back with the values it had, named (C10, M5)',
    scenario: {
      before: (org) => org.add('Account', subject()),
      whileTaken: (org) => org.trash('Account', SUBJECT),
    },
    expect: () => ({ Account: { deletedWhileTaken: lines(SUBJECT) } }),
  },
  {
    name: 'deleted in the checkpoint’s own second, before it: left out of the bin at the checkpoint, brought back, never lost',
    scenario: {
      nearT0Ms: -300,
      before: (org) => org.add('Account', subject()),
      nearT0: (org) => org.trash('Account', SUBJECT),
    },
    expect: () => ({ Account: { deletedWhileTaken: lines(SUBJECT) } }),
  },
  {
    name: 'in the recycle bin at the checkpoint, deleted in the five minutes before it: nothing to rewind',
    scenario: {
      before: (org) => org.add('Account', subject()),
      nearT0: (org) => org.trash('Account', SUBJECT),
    },
    expect: () => ({}),
  },
  {
    name: 'created and deleted since: nothing to rewind',
    scenario: {
      since: (org) => {
        org.add('Account', subject());
        org.trash('Account', SUBJECT);
      },
    },
    expect: () => ({}),
  },
  {
    name: 'deleted since and emptied from the recycle bin, beside a record created since: gone for good, named; the one created since to delete (C3)',
    scenario: {
      before: (org) => org.add('Account', subject()),
      since: (org) => {
        org.trash('Account', SUBJECT);
        org.purge(SUBJECT);
        org.add('Account', { Id: OTHER, Name: 'Made since' });
      },
    },
    expect: () => ({
      Account: { createdSince: lines(OTHER), goneForGood: lines(SUBJECT) },
    }),
  },
  {
    name: 'hard-deleted since: gone for good, or to bring back where the org still lists it in the bin, which its undelete then names gone (F29)',
    scenario: {
      before: (org) => org.add('Account', subject()),
      since: (org) => org.hardDelete('Account', SUBJECT),
    },
    expect: (facts) => ({
      Account: facts.hardDeleteInQueryAll
        ? { inBin: lines(SUBJECT) }
        : { goneForGood: lines(SUBJECT) },
    }),
  },
  {
    name: 'a child deleted on its own before its parent, both in the bin at the checkpoint, the parent brought back since: the child brought back since only where the org brings it back with the parent (F9)',
    scenario: {
      objects: [ACCOUNT, CONTACT],
      children: { Account: [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: true }] },
      before: (org) => {
        org.add('Account', subject());
        org.add('Contact', { Id: contactId(1), LastName: 'Alone', AccountId: SUBJECT });
        org.trash('Contact', contactId(1));
        org.trash('Account', SUBJECT);
      },
      since: (org) => org.untrash(SUBJECT),
    },
    expect: (facts) => ({
      Account: { broughtBackSince: lines(SUBJECT) },
      Contact: facts.childDeletedAloneStays ? {} : { broughtBackSince: lines(contactId(1)) },
    }),
    extras: () => ({ Account: bySession(1), Contact: bySession(1) }),
  },
  {
    name: 'children deleted since with their parent come back with it, never promised alone; one deleted on its own before its parent, which Salesforce then keeps in the bin for good, is gone for good, never to bring back (C2, F9, F41)',
    scenario: {
      objects: [CASCADE_CONTACT, ACCOUNT],
      children: { Account: [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: true }] },
      before: (org) => {
        org.add('Account', subject());
        for (const n of [1, 2, 3]) {
          org.add('Contact', { Id: contactId(n), LastName: `Contact ${n}`, AccountId: SUBJECT });
        }
      },
      since: (org) => org.trash('Contact', contactId(3)),
      later: (org) => org.trash('Account', SUBJECT),
    },
    expect: () => ({
      Account: { inBin: lines(SUBJECT) },
      Contact: {
        withParent: lines(contactId(1), contactId(2)),
        goneForGood: lines(contactId(3)),
      },
    }),
  },
  {
    name: 'a case deleted on its own since, then the account it points at through a lookup that restricts the account’s delete: gone for good, never to bring back, the account brought back (F41, a case under its account, live)',
    scenario: {
      objects: [CASE, ACCOUNT],
      children: RESTRICTING,
      before: (org) => {
        org.add('Account', subject());
        org.add('Case', { Id: caseId(1), Subject: 'Alone', AccountId: SUBJECT });
        org.add('Case', { Id: caseId(2), Subject: 'Alone too', AccountId: KEPT });
      },
      since: (org) => {
        org.trash('Case', caseId(1));
        org.trash('Case', caseId(2));
      },
      later: (org) => org.trash('Account', SUBJECT),
    },
    expect: () => ({
      Account: { inBin: lines(SUBJECT) },
      Case: { goneForGood: lines(caseId(1)), inBin: lines(caseId(2)) },
    }),
  },
  {
    name: 'a child deleted on its own since, its parent staying: brought back on its own (C1, F9)',
    scenario: {
      objects: [CASCADE_CONTACT, ACCOUNT],
      children: { Account: [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: true }] },
      before: (org) => {
        org.add('Account', subject());
        org.add('Contact', { Id: contactId(3), LastName: 'Alone', AccountId: SUBJECT });
      },
      since: (org) => org.trash('Contact', contactId(3)),
    },
    expect: () => ({ Contact: { inBin: lines(contactId(3)) } }),
  },
  {
    name: 'what was deleted with a record Salesforce keeps in the bin for good stays with it: gone for good, never promised back with that record (F41)',
    scenario: {
      objects: [NOTE, CASCADE_CONTACT, ACCOUNT],
      children: {
        Account: [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: true }],
        Contact: [{ childSObject: 'Note__c', field: 'Contact__c', cascadeDelete: true }],
      },
      before: (org) => {
        org.add('Account', subject());
        org.add('Contact', { Id: contactId(3), LastName: 'Alone', AccountId: SUBJECT });
        org.add('Note__c', { Id: noteId(1), Body__c: 'Kept', Contact__c: contactId(3) });
      },
      since: (org) => org.trash('Contact', contactId(3)),
      later: (org) => org.trash('Account', SUBJECT),
    },
    expect: () => ({
      Account: { inBin: lines(SUBJECT) },
      Contact: { goneForGood: lines(contactId(3)) },
      Note__c: { goneForGood: lines(noteId(1)) },
    }),
  },
  {
    name: 'a lookup a delete since cleared: given back and named cleared whether the org restamped the child or not, its parent to bring back (F35, M9)',
    scenario: {
      objects: [ACCOUNT, CONTACT],
      children: { Contact: [{ childSObject: 'Contact', field: 'ReportsToId' }] },
      before: (org) => {
        org.add('Contact', { Id: contactId(1), LastName: 'Boss' });
        org.add('Contact', { Id: contactId(2), LastName: 'Report', ReportsToId: contactId(1) });
      },
      since: (org) => org.trash('Contact', contactId(1)),
    },
    // Without the restamp the child is not stamped since: what finds it then
    // is the read of the snapshot's lookups to records deleted since (M9).
    expect: () => ({
      Contact: {
        giveBack: [{ Id: contactId(2), fields: ['ReportsToId'], cleared: ['ReportsToId'] }],
        inBin: lines(contactId(1)),
      },
    }),
    // Restamped, the child names the user whose delete cleared it.
    extras: (facts) => ({ Contact: facts.clearedLookupRestamps ? bySession(1) : {} }),
  },
  {
    name: 'a Task archived since is neither deleted nor gone for good, one changed then archived is given back, and only one emptied from the bin is gone (C11, M6)',
    scenario: {
      objects: [ACCOUNT, TASK],
      before: (org) => {
        org.add('Task', { Id: taskId(1), Subject: 'Call' });
        org.add('Task', { Id: taskId(2), Subject: 'Call' });
        org.add('Task', { Id: taskId(3), Subject: 'Call' });
      },
      since: (org) => {
        org.archive('Task', taskId(1));
        org.edit('Task', taskId(2), { Subject: 'Called' });
        org.archive('Task', taskId(2));
        org.trash('Task', taskId(3));
        org.purge(taskId(3));
      },
    },
    expect: () => ({
      Task: {
        giveBack: [{ Id: taskId(2), fields: ['Subject'] }],
        goneForGood: lines(taskId(3)),
      },
    }),
    extras: () => ({ Task: bySession(1) }),
  },
];

/**
 * A row runs once for each of the 32 combinations of the facts, a checkpoint
 * taken and diffed each time: about a second here, more under coverage.
 */
const ROW_TIMEOUT_MS = 30_000;

describe('rewindDiff: every row of the classification, under every hypothesis of the facts the probes left open', () => {
  it.each(ROWS)(
    '$name',
    async (row) => {
      for (const facts of UNKNOWN_FACTS.filter(row.under ?? (() => true))) {
        const taken = await take(row.scenario, facts);
        const diff = await diffOf(taken);
        const expected = row.expect(facts);
        const extras = row.extras?.(facts) ?? {};
        const said = JSON.stringify(facts);
        for (const object of taken.objects) {
          expect(await classesOf(taken.folder, object.objectApiName), said).toEqual(
            expected[object.objectApiName] ?? {},
          );
        }
        expect(diff.objects, said).toEqual(
          taken.objects
            .map(({ objectApiName }) =>
              objectOf(objectApiName, expected[objectApiName] ?? {}, extras[objectApiName]),
            )
            .filter(({ objectApiName }) => Object.keys(expected[objectApiName] ?? {}).length > 0),
        );
        expect(diff.unread, said).toEqual([]);
      }
    },
    ROW_TIMEOUT_MS,
  );
});

describe('rewindDiff: what it reads, and what it sends', () => {
  it(
    'takes every one of 50,001 records stamped since for a candidate, past any cap of a read',
    async () => {
      const stampsOnly: Held = { objectApiName: 'Account', fields: STAMPS };
      const ids = Array.from({ length: 50_001 }, (_, n) => accountId(100_000 + n));
      const taken = await take({
        objects: [stampsOnly],
        background: false,
        before: (org) => {
          for (const id of ids) org.add('Account', { Id: id });
        },
        since: (org) => {
          for (const id of ids) org.touch('Account', id, new Date(T0_MS + 60_000).toISOString());
        },
      });

      const diff = await diffOf(taken);

      expect(diff.objects).toEqual([
        objectOf('Account', { touched: ids.map((id) => ({ Id: id })) }),
      ]);
    },
    ROW_TIMEOUT_MS,
  );

  it('names the preview, its moment and its checkpoint, and leaves out an object that holds its checkpoint state', async () => {
    const taken = await take({});
    const diff = await diffOf(taken);

    expect(diff).toEqual({
      checkpointId: CHECKPOINT,
      previewId: PREVIEW,
      readAt: new Date(T0_MS + 120_000).toISOString(),
      objects: [],
      undoCannot: [],
      unread: [],
      userNames: {},
      activeLastHour: [],
    });
  });

  it('reads no value of a record stamped in the five minutes before the checkpoint and not since: four calls, the describes, the pre-check, the change reads and the count', async () => {
    const taken = await take({});
    const before = taken.org.requests;

    await diffOf(taken);

    expect(taken.org.requests - before).toBe(4);
  });

  it('reads the values of its candidates in one call per two hundred, the names of who changed them in one more, and the live ids only once records are lost', async () => {
    const changed = await take({
      before: (org) => org.add('Account', subject()),
      since: (org) => org.edit('Account', SUBJECT, { Industry: 'Retail' }),
    });
    const atChanged = changed.org.requests;
    await diffOf(changed);
    // The describes, the pre-check, the change reads, the count, one read of
    // values, and the names of who last changed them.
    expect(changed.org.requests - atChanged).toBe(6);

    const lost = await take({
      before: (org) => org.add('Account', subject()),
      since: (org) => {
        org.trash('Account', SUBJECT);
        org.purge(SUBJECT);
      },
    });
    const atLost = lost.org.requests;
    await diffOf(lost);
    // The describes, the pre-check, the change reads, the count, and the scan
    // of live ids.
    expect(lost.org.requests - atLost).toBe(5);
  });

  it('counts an object whose records left without a stamp even though nothing in it moved, and names them gone for good (F29)', async () => {
    const taken = await take(
      {
        background: false,
        before: (org) => {
          org.add('Account', subject());
          org.add('Account', { Id: OTHER, Name: 'Kept' });
        },
        since: (org) => org.hardDelete('Account', SUBJECT),
      },
      { hardDeleteInQueryAll: false },
    );
    const before = taken.org.requests;

    const diff = await diffOf(taken);

    // The pre-check saw nothing move: the describes, no change read, the
    // count, the scan.
    expect(taken.org.requests - before).toBe(4);
    expect(await classesOf(taken.folder, 'Account')).toEqual({ goneForGood: lines(SUBJECT) });
    expect(diff.objects).toEqual([objectOf('Account', { goneForGood: lines(SUBJECT) })]);
  });

  it('never reads a record deleted since as unchanged, even where a delete would leave its stamps (F2 off, contradicted live): it is named gone for good', async () => {
    const taken = await take(
      {
        background: false,
        before: (org) => {
          org.add('Account', subject());
          org.add('Account', { Id: OTHER, Name: 'Kept' });
        },
        since: (org) => org.trash('Account', SUBJECT),
      },
      { deleteStamps: false },
    );

    const diff = await diffOf(taken);

    expect(await classesOf(taken.folder, 'Account')).toEqual({ goneForGood: lines(SUBJECT) });
    expect(diff.objects).toEqual([objectOf('Account', { goneForGood: lines(SUBJECT) })]);
  });

  it('compares the fields the checkpoint compares only: a field its owner chose not to compare never makes a record given back, and is named not compared', async () => {
    const taken = await take({
      before: (org) => org.add('Account', subject()),
      since: (org) => org.edit('Account', SUBJECT, { Industry: 'Retail' }),
    });

    const diff = await diffOf(taken, { ignoredFields: ['Account.Industry', 'Contact.LastName'] });

    expect(await classesOf(taken.folder, 'Account')).toEqual({ touched: lines(SUBJECT) });
    expect(diff.objects).toEqual([
      objectOf('Account', { touched: lines(SUBJECT) }, { notCompared: ['Industry'] }),
    ]);
  });

  it('tells an object of stamps alone by its stamps, with no read of values', async () => {
    const stampsOnly: Held = { objectApiName: 'Account', fields: STAMPS };
    const taken = await take({
      objects: [stampsOnly],
      before: (org) => org.add('Account', subject()),
      since: (org) => org.edit('Account', SUBJECT, { Industry: 'Retail' }),
    });
    const before = taken.org.requests;

    await diffOf(taken);

    expect(taken.org.requests - before).toBe(4);
    expect(await classesOf(taken.folder, 'Account')).toEqual({ touched: lines(SUBJECT) });
  });

  it('gives the objects in the checkpoint’s reading order, whatever order its file lists them in', async () => {
    const taken = await take({
      objects: [CONTACT, ACCOUNT],
      before: (org) => org.add('Contact', { Id: contactId(1), LastName: 'Kept' }),
      since: (org) => {
        org.add('Account', subject());
        org.trash('Contact', contactId(1));
      },
    });
    taken.objects.reverse();

    const diff = await diffOf(taken);

    expect(diff.objects.map(({ objectApiName }) => objectApiName)).toEqual(['Contact', 'Account']);
  });

  it('tells 2,001 records changed since and 2,001 deleted since, past a chunk of the snapshot and a page of the org, every one', async () => {
    const changed = Array.from({ length: 2_001 }, (_, n) => accountId(1_000 + n));
    const deleted = Array.from({ length: 2_001 }, (_, n) => contactId(5_000 + n));
    const taken = await take({
      objects: [ACCOUNT, CONTACT],
      pageSize: 700,
      before: (org) => {
        for (const id of changed) org.add('Account', { Id: id, Name: 'Then', Industry: 'Energy' });
        for (const id of deleted) org.add('Contact', { Id: id, LastName: 'Then' });
      },
      since: (org) => {
        for (const id of changed) org.edit('Account', id, { Industry: 'Retail' });
        for (const id of deleted) org.trash('Contact', id);
      },
    });

    const diff = await diffOf(taken);

    const account = await classesOf(taken.folder, 'Account');
    const contact = await classesOf(taken.folder, 'Contact');
    expect(account.giveBack?.map((line) => line.Id).sort()).toEqual([...changed].sort());
    expect(contact).toEqual({ inBin: expect.any(Array) });
    expect(contact.inBin?.map((line) => line.Id).sort()).toEqual([...deleted].sort());
    expect(diff.objects.map((object) => [object.toGiveBack, object.toBringBack.inBin])).toEqual([
      [{ records: 2_001, fields: 2_001, clearedLookups: 0 }, 0],
      [{ records: 0, fields: 0, clearedLookups: 0 }, 2_001],
    ]);
  });
});

/** An account and the contact the platform makes with it, as a person account; its fields filled. */
function addPerson(org: MemoryRemovalOrg, n: number, email: string): void {
  org.addPersonAccount({ Id: accountId(n), Name: `Person ${n}`, PersonEmail: email }, contactId(n));
  const contact = org.all('Contact').find((row) => row.Id === contactId(n));
  if (contact) Object.assign(contact, { LastName: `Person ${n}`, Email: email });
}

/** A connection to `org` that refuses, as the org does, any read naming a field gone since. */
function refusingField(org: MemoryRemovalOrg, field: string): CompositeQueryConnection {
  const refusal = (): Error =>
    orgError('INVALID_FIELD', `No such column '${field}' on entity 'Account'.`);
  return {
    version: org.version,
    query: async (soql, options) => {
      if (soql.includes(field)) throw refusal();
      return org.query(soql, options);
    },
    queryMore: (url) => org.queryMore(url),
    request: async (request) => {
      if (typeof request.body === 'string' && request.body.includes(field)) throw refusal();
      return org.request(request);
    },
  };
}

/** The account's fields as the take described them: a picklist, a long text, a date and time. */
const ACCOUNT_DESCRIBED = describedOf(ACCOUNT.fields, {
  Industry: 'picklist',
  Description: 'textarea',
  Due__c: 'datetime',
});

describe('rewindDiff: what changed in the objects’ fields since the take', () => {
  it('names a field deleted since and compares it no more, never failing its object; leaves a field added since alone; compares still a field whose type changed, and names it', async () => {
    const taken = await take({
      objects: [{ ...ACCOUNT, described: ACCOUNT_DESCRIBED }],
      before: (org) => org.add('Account', subject()),
      since: (org) => {
        org.edit('Account', SUBJECT, { Industry: 'Retail', Description: 'new' });
        org.changeSchema(
          'Account',
          describedOf([...STAMPS, 'Name', 'Industry', 'Due__c', 'Region__c'], {
            Due__c: 'datetime',
          }),
        );
      },
    });

    const diff = await diffOf(taken, { conn: refusingField(taken.org, 'Description') });

    expect(diff.unread).toEqual([]);
    expect(await classesOf(taken.folder, 'Account')).toEqual({
      giveBack: [{ Id: SUBJECT, fields: ['Industry'] }],
    });
    expect(diff.objects).toEqual([
      objectOf(
        'Account',
        { giveBack: [{ Id: SUBJECT, fields: ['Industry'] }] },
        {
          ...bySession(1),
          schemaDrift: { removed: ['Description'], added: ['Region__c'], changed: ['Industry'] },
          notCompared: ['Description'],
        },
      ),
    ]);
  });

  it('asks whether an object changed since a day before the checkpoint: a field deleted after the take described it and before T0 is named, though no record changed', async () => {
    const taken = await take({
      objects: [{ ...ACCOUNT, described: ACCOUNT_DESCRIBED }],
      nearT0: (org) =>
        org.changeSchema(
          'Account',
          ACCOUNT_DESCRIBED.filter(({ name }) => name !== 'Description'),
        ),
    });

    const diff = await diffOf(taken);

    expect(diff.objects).toEqual([
      objectOf(
        'Account',
        {},
        {
          schemaDrift: { removed: ['Description'], added: [], changed: [] },
          notCompared: ['Description'],
        },
      ),
    ]);
  });

  it('names an object whose describe changed and whose field prints are no longer on this machine, and diffs the others', async () => {
    const taken = await take({
      objects: [CONTACT, ACCOUNT],
      before: (org) => org.add('Contact', { Id: contactId(1), LastName: 'Then' }),
      since: (org) => {
        org.edit('Contact', contactId(1), { LastName: 'Now' });
        org.changeSchema('Account', describedOf([...STAMPS, 'Name']));
      },
    });
    rmSync(taken.folder.fingerprintsFile);

    const diff = await diffOf(taken);

    expect(diff.unread).toEqual([
      { objectApiName: 'Account', reason: expect.stringMatching(/field prints cannot be read/) },
    ]);
    expect(diff.objects).toEqual([
      objectOf('Contact', { giveBack: [{ Id: contactId(1), fields: ['LastName'] }] }, bySession(1)),
    ]);
  });
});

describe('rewindDiff: what it says beside the classes', () => {
  // An account and its person contact point at each other: the scope may read
  // either first.
  it.each([
    { first: 'Contact', order: ['Contact', 'Account'] },
    { first: 'Account', order: ['Account', 'Contact'] },
  ])(
    'counts a person account’s contact with its account, never in a class of its own: the account alone is given back, brought back, deleted or named gone, and is compared when only its contact moved, whichever is read first ($first) (m6, A8)',
    async ({ order }) => {
      const personAccount: Held = {
        objectApiName: 'Account',
        fields: [...STAMPS, 'Name', 'Industry', 'IsPersonAccount', 'PersonEmail'],
      };
      const personContact: Held = {
        objectApiName: 'Contact',
        fields: [...STAMPS, 'LastName', 'Email', 'AccountId', 'IsPersonAccount'],
        cascadeParents: ['AccountId'],
      };
      const held = { Account: personAccount, Contact: personContact };
      const taken = await take({
        objects: order.map((name) => (name === 'Account' ? held.Account : held.Contact)),
        children: {
          Account: [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: true }],
        },
        before: (org) => {
          addPerson(org, 30, 'thirty@example.com');
          addPerson(org, 31, 'thirty-one@example.com');
          addPerson(org, 33, 'thirty-three@example.com');
          org.add('Contact', { Id: contactId(40), LastName: 'Business', AccountId: KEPT });
        },
        since: (org) => {
          org.edit('Contact', contactId(30), { Email: 'moved@example.com' });
          // The account's own copy of its person's fields follows, without a
          // stamp of its own.
          const account = org.all('Account').find((row) => row.Id === accountId(30));
          if (account) account.PersonEmail = 'moved@example.com';
          org.trash('Account', accountId(31));
          org.addPersonAccount({ Id: accountId(32), Name: 'Person 32' }, contactId(32));
          org.hardDelete('Account', accountId(33));
          org.edit('Contact', contactId(40), { LastName: 'Changed' });
        },
      });

      const diff = await diffOf(taken);

      const account: Classes = {
        giveBack: [{ Id: accountId(30), fields: ['PersonEmail'] }],
        createdSince: lines(accountId(32)),
        inBin: lines(accountId(31)),
        goneForGood: lines(accountId(33)),
      };
      const contact: Classes = { giveBack: [{ Id: contactId(40), fields: ['LastName'] }] };
      expect(await classesOf(taken.folder, 'Account')).toEqual(account);
      expect(await classesOf(taken.folder, 'Contact')).toEqual(contact);
      const told = {
        Account: objectOf('Account', account),
        Contact: objectOf('Contact', contact, bySession(1)),
      };
      expect(diff.objects).toEqual(
        order.map((name) => (name === 'Account' ? told.Account : told.Contact)),
      );
      expect(diff.unread).toEqual([]);
    },
  );

  it('names who last changed each record to delete or give back — the last of two — by name, read in one call, and who changed one in the hour before the read', async () => {
    const third = accountId(12);
    const taken = await take({
      before: (org) => {
        org.add('Account', subject());
        org.add('Account', { Id: third, Name: 'Third', Industry: 'Energy' });
        org.add('User', { Id: MEMORY_ORG_USER, Name: 'Integration User' });
        org.add('User', { Id: COLLEAGUE, Name: 'Test Colleague' });
      },
      since: (org) => {
        org.edit('Account', SUBJECT, { Industry: 'Retail' });
        org.edit('Account', SUBJECT, { Description: 'a colleague’s' }, COLLEAGUE);
        org.add('Account', { Id: OTHER, Name: 'Made since', LastModifiedById: MEMORY_ORG_USER });
        // Touched, then put back: nothing to give back, no one to name.
        org.edit('Account', third, { Industry: 'Retail' }, COLLEAGUE);
        org.edit('Account', third, { Industry: 'Energy' }, COLLEAGUE);
      },
    });
    const told = objectOf(
      'Account',
      {
        giveBack: [{ Id: SUBJECT, fields: ['Industry', 'Description'] }],
        createdSince: lines(OTHER),
        touched: lines(third),
      },
      { lastChangedBy: { [COLLEAGUE]: 1, [MEMORY_ORG_USER]: 1 } },
    );
    const before = taken.org.requests;

    const soon = await diffOf(taken, { readAt: new Date(T0_MS + 30 * 60_000).toISOString() });

    // The describes, the pre-check, the change reads, the count, the values,
    // the describe of what the deletion takes along, and one read of names.
    expect(taken.org.requests - before).toBe(7);
    expect(soon.objects).toEqual([told]);
    expect(soon.userNames).toEqual({
      [MEMORY_ORG_USER]: 'Integration User',
      [COLLEAGUE]: 'Test Colleague',
    });
    expect(soon.activeLastHour).toEqual([MEMORY_ORG_USER, COLLEAGUE]);

    const hoursLater = await diffOf(taken, {
      readAt: new Date(T0_MS + 3 * 60 * 60_000).toISOString(),
    });

    expect(hoursLater.objects).toEqual([told]);
    expect(hoursLater.activeLastHour).toEqual([]);
  });

  it('finds a lookup a deletion cleared from the snapshot, on an object nothing stamped since, whatever the org does with the child’s stamps (M9, F35)', async () => {
    const sponsored: Held = {
      objectApiName: 'Contact',
      fields: [...STAMPS, 'LastName', 'Sponsor__c'],
    };
    for (const facts of factCombinations(['clearedLookupRestamps', 'undeleteRestoresLookups'])) {
      const taken = await take(
        {
          objects: [sponsored, ACCOUNT],
          children: { Account: [{ childSObject: 'Contact', field: 'Sponsor__c' }] },
          before: (org) => {
            org.add('Account', subject());
            org.add('Contact', { Id: contactId(1), LastName: 'Sponsored', Sponsor__c: SUBJECT });
            org.add('Contact', { Id: contactId(2), LastName: 'Not', Sponsor__c: KEPT });
          },
          since: (org) => org.trash('Account', SUBJECT),
        },
        facts,
      );

      const diff = await diffOf(taken);

      const said = JSON.stringify(facts);
      const contact: Classes = {
        giveBack: [{ Id: contactId(1), fields: ['Sponsor__c'], cleared: ['Sponsor__c'] }],
      };
      expect(await classesOf(taken.folder, 'Contact'), said).toEqual(contact);
      expect(diff.objects, said).toEqual([
        objectOf('Contact', contact, facts.clearedLookupRestamps ? bySession(1) : {}),
        objectOf('Account', { inBin: lines(SUBJECT) }),
      ]);
    }
  });

  it('counts the records outside the checkpoint its deletions take along: created at or after T1 under a record to delete, through a relationship the org deletes along, in an object a person works in (M8, A13)', async () => {
    const historyId = idOf('017', 1);
    const taken = await take({
      objects: [CASCADE_CONTACT, ACCOUNT],
      children: {
        Account: [
          { childSObject: 'Contact', field: 'AccountId', cascadeDelete: true },
          { childSObject: 'Opportunity', field: 'AccountId', cascadeDelete: true },
          { childSObject: 'AccountHistory', field: 'AccountId', cascadeDelete: true },
          { childSObject: 'Case', field: 'AccountId' },
        ],
      },
      // Made after the Accounts were read and before the take ended: the
      // deletion keeps the opportunity, and its parent with it.
      afterRead: (org) => {
        org.add('Account', { Id: OTHER, Name: 'Made while taken' });
        org.add('Opportunity', { Id: opportunityId(1), AccountId: OTHER });
      },
      since: (org) => {
        org.add('Account', subject());
        org.add('Opportunity', { Id: opportunityId(2), AccountId: SUBJECT });
        org.add('Opportunity', { Id: opportunityId(3), AccountId: SUBJECT });
        org.add('Opportunity', { Id: opportunityId(4), AccountId: KEPT });
        org.add('AccountHistory', { Id: historyId, AccountId: SUBJECT });
        org.add('Case', { Id: idOf('500', 1), AccountId: SUBJECT });
        org.add('Contact', { Id: contactId(5), LastName: 'Made since', AccountId: SUBJECT });
      },
    });
    // History is the org's own trace of a record: no layout, no one works in it.
    const describeGlobal = async (): Promise<unknown> => {
      const global = (await taken.org.describeGlobal()) as {
        sobjects: Array<Record<string, unknown>>;
      };
      return {
        sobjects: global.sobjects.map((object) =>
          object.name === 'AccountHistory' ? { ...object, layoutable: false } : object,
        ),
      };
    };

    const diff = await diffOf(taken, { describeGlobal });

    expect(diff.unread).toEqual([]);
    expect(diff.objects).toEqual([
      objectOf('Contact', { createdSince: lines(contactId(5)) }),
      objectOf(
        'Account',
        { createdSince: lines(OTHER, SUBJECT) },
        { outside: [{ objectApiName: 'Opportunity', count: 2, parents: 1 }] },
      ),
    ]);
    // The record to delete they hang from, which a rewind of picked objects keeps.
    const parents: OrgRow[] = [];
    const dir = previewDirOf(taken.folder, PREVIEW);
    for await (const row of spooledRows(classFileOf(dir, 'Account', 'outsideParents'))) {
      parents.push(row);
    }
    expect(parents).toEqual([{ Id: SUBJECT }]);
    expect(existsSync(classFileOf(dir, 'Contact', 'outsideParents'))).toBe(false);
  });

  it('counts by its stamp the records outside the checkpoint of an object the org gives no CreatedDate, as it gives a ContentDocumentLink none', async () => {
    const taken = await take({
      children: {
        Account: [{ childSObject: 'Opportunity', field: 'AccountId', cascadeDelete: true }],
      },
      since: (org) => {
        org.add('Account', subject());
        org.add('Opportunity', { Id: opportunityId(2), AccountId: SUBJECT });
        org.add('Opportunity', { Id: opportunityId(3), AccountId: SUBJECT });
      },
    });
    taken.org.missingFields.set('Opportunity', new Set(['CreatedDate']));

    const diff = await diffOf(taken);

    expect(diff.unread).toEqual([]);
    expect(diff.objects).toEqual([
      objectOf(
        'Account',
        { createdSince: lines(SUBJECT) },
        { outside: [{ objectApiName: 'Opportunity', count: 2, parents: 1 }] },
      ),
    ]);
  });

  it('names an object whose records to delete it could not tell the records outside the checkpoint of, and keeps none of its classes', async () => {
    const taken = await take({
      children: {
        Account: [{ childSObject: 'Opportunity', field: 'AccountId', cascadeDelete: true }],
      },
      since: (org) => {
        org.add('Account', subject());
        org.add('Opportunity', { Id: opportunityId(2), AccountId: SUBJECT });
      },
    });
    taken.org.refuseRead.set('Opportunity', {
      errorCode: 'INSUFFICIENT_ACCESS',
      message: 'insufficient access rights on object id',
    });

    const diff = await diffOf(taken);

    expect(diff.objects).toEqual([]);
    expect(diff.unread).toEqual([
      {
        objectApiName: 'Account',
        reason: expect.stringMatching(/Opportunity records its deletion would take along/),
      },
    ]);
    expect(await classesOf(taken.folder, 'Account')).toEqual({});
  });

  it('says which records to delete Undo couldn’t bring back: of an object Salesforce undeletes only with its parent, those under a parent that stays, and those that come back with their parent to be deleted again; one under a parent deleted too goes with it (B3, A14, m14, C12, C4)', async () => {
    const [l1, l2, l3, l4, l5] = [1, 2, 3, 4, 5].map(lineId);
    const [o1, o2, o3] = [1, 2, 3].map(opportunityId);
    const taken = await take({
      objects: [PRODUCT, OPPORTUNITY],
      background: false,
      children: {
        Opportunity: [
          { childSObject: 'OpportunityLineItem', field: 'OpportunityId', cascadeDelete: true },
        ],
      },
      before: (org) => {
        org.add('Opportunity', { Id: o1, Name: 'Kept', StageName: 'Prospecting' });
        org.add('Opportunity', { Id: o2, Name: 'Deleted since', StageName: 'Prospecting' });
        org.add('OpportunityLineItem', { Id: l4, Quantity: 1, OpportunityId: o1 });
        org.add('OpportunityLineItem', { Id: l5, Quantity: 1, OpportunityId: o2 });
      },
      since: (org) => {
        // Added since to an opportunity that stays.
        org.add('OpportunityLineItem', {
          Id: l1,
          Quantity: 2,
          OpportunityId: o1,
          LastModifiedById: COLLEAGUE,
        });
        // Added since to an opportunity added since.
        org.add('Opportunity', { Id: o3, Name: 'Made since', StageName: 'Prospecting' });
        org.add('OpportunityLineItem', { Id: l2, Quantity: 2, OpportunityId: o3 });
        // Added since to the opportunity deleted later.
        org.add('OpportunityLineItem', { Id: l3, Quantity: 2, OpportunityId: o2 });
        // Deleted on its own, its opportunity live.
        org.trash('OpportunityLineItem', l4);
      },
      later: (org) => org.trash('Opportunity', o2),
    });

    const diff = await diffOf(taken);

    const products: Classes = {
      createdSince: lines(l1, l2),
      comesBackWithParent: lines(l3),
      withParent: lines(l5),
      goneForGood: lines(l4),
      undoCannot: lines(l1, l3),
    };
    const opportunities: Classes = { createdSince: lines(o3), inBin: lines(o2) };
    expect(await classesOf(taken.folder, 'OpportunityLineItem')).toEqual(products);
    expect(await classesOf(taken.folder, 'Opportunity')).toEqual(opportunities);
    expect(diff.undoCannot).toEqual([{ objectApiName: 'OpportunityLineItem', count: 2 }]);
    expect(diff.objects).toEqual([
      objectOf('OpportunityLineItem', products, {
        lastChangedBy: { [COLLEAGUE]: 1, [MEMORY_ORG_USER]: 1 },
      }),
      objectOf('Opportunity', opportunities),
    ]);
  });

  it('counts, in an object Salesforce undeletes on its own too, the records to delete that go with a parent deleted too: not one under a parent that stays, nor one made while the checkpoint was taken, which is deleted before its parent and Undo couldn’t bring back (B1, F41)', async () => {
    const [along, underKept, whileTaken] = [1, 2, 3].map(contactId);
    const [made, early] = [20, 21].map(accountId);
    const taken = await take({
      objects: [CASCADE_CONTACT, ACCOUNT],
      children: { Account: [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: true }] },
      // After both objects were read, before the take ended.
      afterRead: (org) => {
        org.add('Account', { Id: early, Name: 'Made while taken' });
        org.add('Contact', { Id: whileTaken, LastName: 'Made while taken', AccountId: early });
      },
      since: (org) => {
        org.add('Account', { Id: made, Name: 'Made since' });
        org.add('Contact', { Id: along, LastName: 'Along', AccountId: made });
        org.add('Contact', { Id: underKept, LastName: 'Under kept', AccountId: KEPT });
      },
    });

    const diff = await diffOf(taken);

    const created = (await classesOf(taken.folder, 'Contact')).createdSince ?? [];
    expect(created.map(({ Id }) => Id).sort()).toEqual([along, underKept, whileTaken].sort());
    expect(diff.withParentDeleted).toEqual([{ objectApiName: 'Contact', count: 1 }]);
    // The one made while the checkpoint was taken keeps its parent for the
    // deletion, so it is deleted on its own first: its account's delete then
    // leaves it in the bin for good (F41).
    expect(diff.undoCannot).toEqual([
      { objectApiName: 'Contact', count: 1, reason: 'deletedBeforeParent' },
    ]);
    expect((await classesOf(taken.folder, 'Contact')).undoCannot).toEqual([
      { Id: whileTaken, reason: 'deletedBeforeParent' },
    ]);
  });

  it('says Undo couldn’t bring back a case it deletes before the account it points at, which it deletes next, through a lookup that restricts the account’s delete: Salesforce then keeps the case in the bin for good; not one whose account stays (F41, a case under its account, live)', async () => {
    const [before, underKept] = [1, 2].map(caseId);
    const made = accountId(20);
    const taken = await take({
      objects: [CASE, ACCOUNT],
      children: RESTRICTING,
      since: (org) => {
        org.add('Account', { Id: made, Name: 'Made since' });
        org.add('Case', { Id: before, Subject: 'Under made', AccountId: made });
        org.add('Case', { Id: underKept, Subject: 'Under kept', AccountId: KEPT });
      },
    });

    const diff = await diffOf(taken);

    const cases = await classesOf(taken.folder, 'Case');
    expect(cases.createdSince?.map(({ Id }) => Id).sort()).toEqual([before, underKept].sort());
    expect(cases.undoCannot).toEqual([{ Id: before, reason: 'deletedBeforeParent' }]);
    expect(diff.undoCannot).toEqual([
      { objectApiName: 'Case', count: 1, reason: 'deletedBeforeParent' },
    ]);
    // The account's delete never takes the case along: it goes alone, first.
    expect(diff.withParentDeleted).toBeUndefined();
  });

  it('says Undo couldn’t bring back a product made while the checkpoint was taken under an opportunity deleted too, as one deleted before its parent: the deletion keeps a parent for such a record, so it is deleted on its own, first (B1, B3, F41)', async () => {
    const [made, along] = [1, 2].map(lineId);
    const parent = opportunityId(1);
    const taken = await take({
      objects: [PRODUCT, OPPORTUNITY],
      background: false,
      children: {
        Opportunity: [
          { childSObject: 'OpportunityLineItem', field: 'OpportunityId', cascadeDelete: true },
        ],
      },
      // After the products and opportunities were read, before the take ended.
      afterRead: (org) => {
        org.add('Opportunity', { Id: parent, Name: 'Made while taken', StageName: 'Prospecting' });
        org.add('OpportunityLineItem', { Id: made, Quantity: 1, OpportunityId: parent });
      },
      since: (org) =>
        org.add('OpportunityLineItem', { Id: along, Quantity: 1, OpportunityId: parent }),
    });

    const diff = await diffOf(taken);

    expect(diff.undoCannot).toEqual([
      { objectApiName: 'OpportunityLineItem', count: 1, reason: 'deletedBeforeParent' },
    ]);
    expect((await classesOf(taken.folder, 'OpportunityLineItem')).undoCannot).toEqual([
      { Id: made, reason: 'deletedBeforeParent' },
    ]);
  });
});

describe('rewindDiff: what a rewind cannot undo', () => {
  const LEAD: Held = {
    objectApiName: 'Lead',
    fields: [...STAMPS, 'LastName', 'Status', 'IsConverted'],
  };
  const leadId = (n: number): string => idOf('00Q', n);
  /** A lead converted since, and one whose status changed since. */
  const leadsSince = (): Promise<Taken> =>
    take({
      objects: [LEAD],
      background: false,
      before: (org) => {
        org.add('Lead', { Id: leadId(1), LastName: 'Ada', Status: 'Open', IsConverted: false });
        org.add('Lead', { Id: leadId(2), LastName: 'Grace', Status: 'Open', IsConverted: false });
      },
      since: (org) => {
        org.edit('Lead', leadId(1), { Status: 'Closed - Converted', IsConverted: true });
        org.edit('Lead', leadId(2), { Status: 'Working' });
      },
    });

  it('names a lead converted since as one it cannot undo, never to give back, whether its owner compares the flag or not: Salesforce refuses any update of a converted lead (A9, F14)', async () => {
    for (const ignoredFields of [[], ['Lead.IsConverted']]) {
      const taken = await leadsSince();

      const diff = await diffOf(taken, { ignoredFields });

      const said = JSON.stringify(ignoredFields);
      expect(await classesOf(taken.folder, 'Lead'), said).toEqual({
        giveBack: [{ Id: leadId(2), fields: ['Status'] }],
        convertedLead: lines(leadId(1)),
      });
      expect(diff.objects, said).toEqual([
        {
          ...objectOf('Lead', { giveBack: [{ Id: leadId(2), fields: ['Status'] }] }, bySession(1)),
          cannotUndo: [{ reason: 'convertedLead', count: 1 }],
          notCompared: ignoredFields.length > 0 ? ['IsConverted'] : [],
        },
      ]);
    }
  });
});

describe('rewindDiff: an object it cannot read whole is named, never read as unchanged', () => {
  it('names an object whose cursor the org released before it was read to its end, and diffs the others', async () => {
    const accounts = [accountId(20), accountId(21), accountId(22)];
    const contacts = [contactId(20), contactId(21), contactId(22)];
    const taken = await take({
      objects: [ACCOUNT, CONTACT],
      background: false,
      pageSize: 2,
      before: (org) => {
        for (const id of accounts) org.add('Account', { Id: id, Name: 'Then' });
        for (const id of contacts) org.add('Contact', { Id: id, LastName: 'Then' });
      },
      since: (org) => {
        for (const id of accounts) org.edit('Account', id, { Name: 'Now' });
        for (const id of contacts) org.edit('Contact', id, { LastName: 'Now' });
      },
      // The Contacts' cursor, opened in the same call as the Accounts', releases theirs.
      cursorLimit: 1,
    });

    const diff = await diffOf(taken);

    expect(diff.unread).toEqual([
      { objectApiName: 'Account', reason: expect.stringMatching(/invalid query locator/) },
    ]);
    expect(diff.objects).toEqual([
      objectOf(
        'Contact',
        { giveBack: contacts.map((id) => ({ Id: id, fields: ['LastName'] })) },
        bySession(3),
      ),
    ]);
    expect(await classesOf(taken.folder, 'Account')).toEqual({});
  });

  it('names an object whose reads the org refuses, and diffs the others', async () => {
    const taken = await take({
      objects: [ACCOUNT, CONTACT],
      before: (org) => org.add('Contact', { Id: contactId(1), LastName: 'Kept' }),
      since: (org) => {
        org.add('Account', subject());
        org.trash('Contact', contactId(1));
      },
    });
    taken.org.refuseRead.set('Contact', {
      errorCode: 'INSUFFICIENT_ACCESS',
      message: 'insufficient access rights on object id',
    });

    const diff = await diffOf(taken);

    expect(diff.unread).toEqual([
      { objectApiName: 'Contact', reason: expect.stringMatching(/insufficient access/) },
    ]);
    expect(diff.objects).toEqual([objectOf('Account', { createdSince: lines(SUBJECT) })]);
    expect(await classesOf(taken.folder, 'Contact')).toEqual({});
  });

  it('names an object whose candidates’ values could not be read, and keeps none of its classes, those it had written among them', async () => {
    // More records created since than a class's file is written by at a
    // time: their file is on disk before the values are read.
    const created = Array.from({ length: 2_001 }, (_, n) => accountId(3_000 + n));
    const taken = await take({
      before: (org) => org.add('Account', subject()),
      since: (org) => {
        org.edit('Account', SUBJECT, { Industry: 'Retail' });
        for (const id of created) org.add('Account', { Id: id, Name: 'Made since' });
      },
    });
    const org = taken.org;
    // The read by id refused, in a composite and alone: a refused composite
    // is sent again one query a call.
    const refusal = (): Error =>
      Object.assign(new Error('Unable to read the records'), {
        errorCode: 'REQUEST_RUNNING_TOO_LONG',
      });
    const failing: CompositeQueryConnection = {
      version: org.version,
      query: async (soql, options) => {
        if (soql.includes(' WHERE Id IN (')) throw refusal();
        return org.query(soql, options);
      },
      queryMore: (url) => org.queryMore(url),
      request: async (request) => {
        if (typeof request.body === 'string' && request.body.includes('Id%20IN%20')) {
          throw refusal();
        }
        return org.request(request);
      },
    };

    const diff = await diffOf(taken, { conn: failing });

    expect(diff.objects).toEqual([]);
    expect(diff.unread).toEqual([
      { objectApiName: 'Account', reason: expect.stringMatching(/Unable to read the records/) },
    ]);
    expect(
      readdirSync(previewDirOf(taken.folder, PREVIEW)).filter((name) =>
        CLASSES.some((cls) => name.endsWith(`.${cls}.ndjson`)),
      ),
    ).toEqual([]);
  });

  it('names an object whose index is no longer on this machine', async () => {
    const taken = await take({
      before: (org) => org.add('Account', subject()),
      since: (org) => org.trash('Account', SUBJECT),
    });
    rmSync(indexFileOf(taken.folder, 'Account'));

    const diff = await diffOf(taken);

    expect(diff.objects).toEqual([]);
    expect(diff.unread).toEqual([
      { objectApiName: 'Account', reason: expect.stringMatching(/not on this machine/) },
    ]);
  });

  it('names an object whose bin at the checkpoint is no longer on this machine, once a record needs it', async () => {
    const taken = await take({ since: (org) => org.add('Account', subject()) });
    rmSync(binFileOf(taken.folder, 'Account'));

    const diff = await diffOf(taken);

    expect(diff.unread).toEqual([
      {
        objectApiName: 'Account',
        reason: expect.stringMatching(/recycle bin is not on this machine/),
      },
    ]);
  });

  it('stops when the run is stopped, with nothing to give', async () => {
    const taken = await take({ since: (org) => org.add('Account', subject()) });
    const stop = new AbortController();
    stop.abort();

    await expect(diffOf(taken, { signal: stop.signal })).rejects.toBeInstanceOf(OrgReadStopped);
  });
});
