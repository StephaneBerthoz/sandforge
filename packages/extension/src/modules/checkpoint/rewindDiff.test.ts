import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CheckpointObject, CheckpointReadMode, RewindDiffObject } from '@sandforge/shared';
import { canonicalRecordId } from '../../core/common/existingRecordMatch.js';
import { BackupRecordStore, nodeBackupFiles } from '../dataops/BackupRecordStore.js';
import {
  MemoryRemovalOrg,
  factCombinations,
  type MemoryChild,
  type MemoryOrgFacts,
  type MemoryRow,
} from '../../test/memoryRemovalOrg.js';
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
const taskId = (n: number): string => idOf('00T', n);
const lineId = (n: number): string => idOf('00k', n);

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
  /** When the snapshot reads, after T0: 200 ms unless told. */
  readAfterMs?: number;
  pageSize?: number;
  /** Open cursors past which the org releases the oldest: none unless told. */
  cursorLimit?: number;
}

/** A line of a class's file: the record's id, and for one given back the fields that differ. */
type ClassLine = { Id: string; fields?: string[] };
type Classes = Partial<Record<RewindClass, ClassLine[]>>;

const CLASSES: RewindClass[] = [
  'giveBack',
  'touched',
  'createdSince',
  'broughtBackSince',
  'unexplained',
  'inBin',
  'withParent',
  'deletedWhileTaken',
  'goneForGood',
];

const lines = (...ids: string[]): ClassLine[] => ids.map((id) => ({ Id: id }));

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A checkpoint's folder, made by the store, as a take makes it. */
async function folderOf(): Promise<CheckpointFolder> {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-rewind-diff-'));
  made.push(dir);
  const opened = openCheckpointStore({
    root: join(dir, 'checkpoints'),
    locksDir: defaultCheckpointLocksDir(join(dir, 'home')),
  });
  if (!('store' in opened)) throw new Error(`refused: ${opened.refusal.reason}`);
  return opened.store.create(ORG, CHECKPOINT);
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
  if (scenario.background !== false) {
    org.add('Account', { Id: KEPT, Name: 'Kept', Industry: 'Energy' });
    org.add('Account', { Id: RECENT, Name: 'Recent', Industry: 'Energy' });
  }
  scenario.before?.(org);
  clock = T0_MS + (scenario.nearT0Ms ?? -120_000);
  if (scenario.background !== false) org.edit('Account', RECENT, { Industry: 'Retail' });
  scenario.nearT0?.(org);

  clock = T0_MS;
  const folder = await folderOf();
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
      cascadeParents: [],
      fingerprint: '0'.repeat(64),
      fields: object.fields,
      leftOutFields: [],
    });
  }
  clock = readAt + 100;
  scenario.afterRead?.(org);
  clock = T0_MS + 60_000;
  scenario.since?.(org);
  clock = T0_MS + 120_000;
  return { org, folder, objects };
}

/** The diff since the checkpoint `taken` holds, read now. */
async function diffOf(
  taken: Taken,
  options: { ignoredFields?: string[]; conn?: CompositeQueryConnection; signal?: AbortSignal } = {},
) {
  return rewindDiff({
    checkpoint: {
      checkpointId: CHECKPOINT,
      readFrom: T0,
      objects: taken.objects,
      ignoredFields: options.ignoredFields ?? [],
      snapshotId: SNAPSHOT,
    },
    folder: taken.folder,
    reader: compositeReader(options.conn ?? taken.org),
    previewId: PREVIEW,
    readAt: new Date(T0_MS + 120_000).toISOString(),
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

/** What the diff says of an object whose classes are `classes`. */
function objectOf(objectApiName: string, classes: Classes): RewindDiffObject {
  const count = (cls: RewindClass): number => classes[cls]?.length ?? 0;
  const gone = count('goneForGood');
  return {
    objectApiName,
    toDelete: {
      createdSince: count('createdSince'),
      broughtBackSince: count('broughtBackSince'),
      comesBackWithParent: 0,
    },
    toGiveBack: {
      records: count('giveBack'),
      fields: (classes.giveBack ?? []).reduce((sum, line) => sum + (line.fields?.length ?? 0), 0),
      clearedLookups: 0,
    },
    toBringBack: {
      inBin: count('inBin'),
      withParent: count('withParent'),
      deletedWhileTaken: count('deletedWhileTaken'),
    },
    cannotUndo: gone > 0 ? [{ reason: 'goneForGood', count: gone }] : [],
    outside: [],
    touched: count('touched'),
    unexplained: count('unexplained'),
    lastChangedBy: {},
    notCompared: [],
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
}

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
    name: 'deleted since, of an object Salesforce undeletes only with its parent: expected back with it, never promised alone (C4)',
    scenario: {
      objects: [ACCOUNT, LINE],
      before: (org) => org.add('OpportunityLineItem', { Id: lineId(1), Quantity: 2 }),
      since: (org) => org.trash('OpportunityLineItem', lineId(1)),
    },
    expect: () => ({ OpportunityLineItem: { withParent: lines(lineId(1)) } }),
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
  },
  {
    name: 'a lookup a delete since cleared, the child restamped as the org restamps it: given back, its parent to bring back (F35)',
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
    under: (facts) => facts.clearedLookupRestamps,
    expect: () => ({
      Contact: {
        giveBack: [{ Id: contactId(2), fields: ['ReportsToId'] }],
        inBin: lines(contactId(1)),
      },
    }),
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
        const said = JSON.stringify(facts);
        for (const object of taken.objects) {
          expect(await classesOf(taken.folder, object.objectApiName), said).toEqual(
            expected[object.objectApiName] ?? {},
          );
        }
        expect(diff.objects, said).toEqual(
          taken.objects
            .map(({ objectApiName }) => objectOf(objectApiName, expected[objectApiName] ?? {}))
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

  it('reads no value of a record stamped in the five minutes before the checkpoint and not since: three calls, the pre-check, the change reads and the count', async () => {
    const taken = await take({});
    const before = taken.org.requests;

    await diffOf(taken);

    expect(taken.org.requests - before).toBe(3);
  });

  it('reads the values of its candidates in one call per two hundred, and the live ids only once records are lost', async () => {
    const changed = await take({
      before: (org) => org.add('Account', subject()),
      since: (org) => org.edit('Account', SUBJECT, { Industry: 'Retail' }),
    });
    const atChanged = changed.org.requests;
    await diffOf(changed);
    // The pre-check, the change reads, the count, and one read of values.
    expect(changed.org.requests - atChanged).toBe(4);

    const lost = await take({
      before: (org) => org.add('Account', subject()),
      since: (org) => {
        org.trash('Account', SUBJECT);
        org.purge(SUBJECT);
      },
    });
    const atLost = lost.org.requests;
    await diffOf(lost);
    // The pre-check, the change reads, the count, and the scan of live ids.
    expect(lost.org.requests - atLost).toBe(4);
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

    // The pre-check saw nothing move: no change read, the count, the scan.
    expect(taken.org.requests - before).toBe(3);
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

  it('compares the fields the checkpoint compares only: a field its owner chose not to compare never makes a record given back', async () => {
    const taken = await take({
      before: (org) => org.add('Account', subject()),
      since: (org) => org.edit('Account', SUBJECT, { Industry: 'Retail' }),
    });

    const diff = await diffOf(taken, { ignoredFields: ['Account.Industry'] });

    expect(await classesOf(taken.folder, 'Account')).toEqual({ touched: lines(SUBJECT) });
    expect(diff.objects).toEqual([objectOf('Account', { touched: lines(SUBJECT) })]);
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

    expect(taken.org.requests - before).toBe(3);
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
      objectOf('Contact', {
        giveBack: contacts.map((id) => ({ Id: id, fields: ['LastName'] })),
      }),
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
