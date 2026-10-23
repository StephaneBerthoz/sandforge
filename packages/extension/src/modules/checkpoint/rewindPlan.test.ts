import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CheckpointObject, CheckpointScopeMode, RewindDiff } from '@sandforge/shared';
import { canonicalRecordId } from '../../core/common/existingRecordMatch.js';
import { BackupRecordStore, nodeBackupFiles } from '../dataops/BackupRecordStore.js';
import { removeRunRecords, type RunRemovalOutcome } from '../forge/ForgeRunRemoval.js';
import { restoreOverwrites, type SyncRestoreOutcome } from '../sync/SyncRunRestore.js';
import {
  MEMORY_ORG_USER,
  factCombinations,
  type MemoryChild,
  type MemoryOrgFacts,
} from '../../test/memoryRemovalOrg.js';
import { MemoryRestoreOrg } from '../../test/memoryRestoreOrg.js';
import { comparedFields } from './checkpointFields.js';
import { fingerprintOf } from './checkpointFingerprint.js';
import { OrgReadStopped, compositeReader, type OrgRow } from './compositeQueries.js';
import {
  binFileOf,
  defaultCheckpointLocksDir,
  openCheckpointStore,
  previewDirOf,
  rewindDirOf,
  type CheckpointFolder,
} from './OrgCheckpointStore.js';
import { binLedgerRead, spoolReads, spooledRows } from './orgStreams.js';
import { rewindDiff } from './rewindDiff.js';
import {
  heldInPlaceReason,
  rewindPlan,
  rewindWriters,
  type RewindPlan,
  type RewindPlanInput,
  type RewindPlanObject,
} from './rewindPlan.js';
import { SNAPSHOT_CHUNK_IDS, SnapshotIndex, writeSnapshotIndex } from './snapshotIndex.js';
import type { IdSpool } from './spooledRunRecords.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ORG = '00Dxx0000001234EAA';
const CHECKPOINT = 'ck-20261022-100000-a1b2';
const REWIND = 'rw-20261022-100300-k1m2';
/** The snapshot's DataOps operation id, as the checkpoint names it. */
const SNAPSHOT = 'op-1792700000000';

/** T0, with milliseconds, as the org's clock gives it. */
const T0_MS = Date.parse('2026-10-22T10:00:00.400Z');
const DAY_MS = 24 * 60 * 60_000;
/** Since the checkpoint: a minute after T0. */
const SINCE = T0_MS + 60_000;
/** When the preview the user confirmed read the org. */
const PREVIEWED = T0_MS + 120_000;
/** Between the preview and the rewind. */
const MEANWHILE = T0_MS + 150_000;
/** Tr: when the rewind read the org first. */
const TR = T0_MS + 180_000;
/** After Tr: the rewind's writes, and what others do meanwhile. */
const WRITES = T0_MS + 200_000;
/** When the second pass reads the org. */
const PASS_TWO = T0_MS + 240_000;

/** A user of the org other than the one the session writes as. */
const COLLEAGUE = '005000000000002AAA';
/** The org's Automated Process user. */
const AUTOMATED = '005000000000003AAA';

/** An id in its 18-character form, from a prefix and a number. */
function idOf(prefix: string, n: number): string {
  const id = canonicalRecordId(`${prefix}xx${String(n).padStart(10, '0')}`);
  if (!id) throw new Error(`Not an id: ${prefix} ${n}`);
  return id;
}
const accountId = (n: number): string => idOf('001', n);
const contactId = (n: number): string => idOf('003', n);
const opportunityId = (n: number): string => idOf('006', n);
const lineId = (n: number): string => idOf('00k', n);
const caseId = (n: number): string => idOf('500', n);
const bookId = (n: number): string => idOf('01s', n);

const STAMPS = ['Id', 'SystemModstamp', 'CreatedDate', 'LastModifiedDate', 'LastModifiedById'];

/** An object of the scenarios, as the checkpoint holds it. */
interface Held {
  objectApiName: string;
  fields: string[];
  undeletable?: boolean;
  /** Its fields whose parent's delete takes a record along. */
  cascadeParents?: string[];
  /** Its fields whose parent's delete a live record refuses. */
  restrictParents?: string[];
}

const ACCOUNT: Held = { objectApiName: 'Account', fields: [...STAMPS, 'Name', 'Industry'] };
/** A case whose account lookup restricts the account's delete, as seen live: never deleted along. */
const CASE: Held = {
  objectApiName: 'Case',
  fields: [...STAMPS, 'Subject', 'AccountId'],
  restrictParents: ['AccountId'],
};
const ACCOUNT_CASES: MemoryChild = {
  childSObject: 'Case',
  field: 'AccountId',
  restrictedDelete: true,
};
/** A contact, which its account's delete takes along. */
const CONTACT: Held = {
  objectApiName: 'Contact',
  fields: [...STAMPS, 'LastName', 'AccountId'],
  cascadeParents: ['AccountId'],
};
const OPPORTUNITY: Held = {
  objectApiName: 'Opportunity',
  fields: [...STAMPS, 'Name', 'Pricebook2Id'],
};
/** An opportunity its account's delete takes along. */
const OPPORTUNITY_OF_ACCOUNT: Held = {
  objectApiName: 'Opportunity',
  fields: [...STAMPS, 'Name', 'Pricebook2Id', 'AccountId'],
  cascadeParents: ['AccountId'],
};
/** An opportunity's product: deleted with its opportunity, brought back with it only. */
const PRODUCT: Held = {
  objectApiName: 'OpportunityLineItem',
  fields: [...STAMPS, 'Quantity', 'OpportunityId'],
  undeletable: false,
  cascadeParents: ['OpportunityId'],
};

const ACCOUNT_CONTACTS: MemoryChild = {
  childSObject: 'Contact',
  field: 'AccountId',
  cascadeDelete: true,
};
const ACCOUNT_OPPORTUNITIES: MemoryChild = {
  childSObject: 'Opportunity',
  field: 'AccountId',
  cascadeDelete: true,
};
const OPPORTUNITY_PRODUCTS: MemoryChild = {
  childSObject: 'OpportunityLineItem',
  field: 'OpportunityId',
  cascadeDelete: true,
};

/** What an opportunity's price book is refused for, live, while it has products. */
const PRICE_BOOK_HELD = {
  objectApiName: 'Opportunity',
  fields: ['Pricebook2Id'],
  childSObject: 'OpportunityLineItem',
  field: 'OpportunityId',
  statusCode: 'FIELD_INTEGRITY_EXCEPTION',
  message: 'Cannot change pricebook on opportunity with line items',
};

type Act = (org: MemoryRestoreOrg) => void;

/** A history of an org up to the end of its checkpoint, each part at its moment of the org's clock. */
interface Scenario {
  objects: Held[];
  children?: Record<string, MemoryChild[]>;
  /** A day before T0. */
  before?: Act;
  /** After every object was read, before the take ended. */
  afterRead?: Act;
}

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An org, the checkpoint taken of it, and the diffs read since. */
class World {
  clock = T0_MS - DAY_MS;
  readonly org: MemoryRestoreOrg;
  folder!: CheckpointFolder;
  objects: CheckpointObject[] = [];
  /** T1. */
  takenAt = '';
  private plans = 0;

  constructor(scenario: Scenario, facts?: Partial<MemoryOrgFacts>) {
    this.org = new MemoryRestoreOrg(scenario.children ?? {}, {
      now: () => this.clock,
      ...(facts ? { facts } : {}),
    });
    for (const object of scenario.objects) {
      if (object.undeletable === false) this.org.comesBackOnlyWithParent.add(object.objectApiName);
    }
  }

  /** Make the org's history at `ms` of its clock. */
  at(ms: number, act: Act): void {
    this.clock = ms;
    act(this.org);
  }

  /** The diff read at `ms`, kept as preview `previewId`. */
  async diff(previewId: string, ms: number): Promise<{ diff: RewindDiff; dir: string }> {
    this.clock = ms;
    const diff = await rewindDiff({
      checkpoint: {
        checkpointId: CHECKPOINT,
        readFrom: new Date(T0_MS).toISOString(),
        takenAt: this.takenAt,
        objects: this.objects,
        ignoredFields: [],
        snapshotId: SNAPSHOT,
      },
      folder: this.folder,
      reader: compositeReader(this.org),
      describeGlobal: () => this.org.describeGlobal(),
      previewId,
      readAt: new Date(ms).toISOString(),
    });
    expect(diff.unread).toEqual([]);
    return { diff, dir: previewDirOf(this.folder, previewId) };
  }

  /** A pass of the rewind, planned in a folder of its own. */
  async plan(
    options: Partial<Omit<RewindPlanInput, 'checkpoint'>> & {
      freshDir: string;
      mode?: CheckpointScopeMode;
    },
  ): Promise<RewindPlan> {
    const { mode, ...rest } = options;
    return rewindPlan({
      checkpoint: {
        objects: this.objects,
        takenAt: this.takenAt,
        scope: { mode: mode ?? 'everything', leftOut: [] },
      },
      pass: 1,
      confirmedDir: options.freshDir,
      readAt: new Date(TR).toISOString(),
      ownWriters: [MEMORY_ORG_USER],
      acceptOutside: false,
      acceptNoUndo: false,
      acceptRecreate: false,
      dir: join(rewindDirOf(this.folder, REWIND), `plan-${++this.plans}`),
      ...rest,
    });
  }

  /** Give `spool`'s records their checkpoint values back, a chunk at a time, as a rewind does. */
  async giveBack(spool: IdSpool, plan: RewindPlan): Promise<SyncRestoreOutcome[]> {
    this.clock = Math.max(this.clock, WRITES);
    const outcomes: SyncRestoreOutcome[] = [];
    for (const { objectApiName } of spool.objects) {
      const index = await SnapshotIndex.read(this.folder, SNAPSHOT, objectApiName);
      const held = this.objects.find((object) => object.objectApiName === objectApiName);
      for await (const ids of spool.pages(objectApiName, SNAPSHOT_CHUNK_IDS)) {
        outcomes.push(
          await restoreOverwrites({
            org: this.org,
            plan: [{ objectApiName, backup: SNAPSHOT, ids }],
            backups: index.chunk(ids),
            fields: { [objectApiName]: comparedFields(objectApiName, held?.fields ?? [], []) },
            ...plan.restore,
          }),
        );
      }
    }
    return outcomes;
  }

  /** Delete what `plan` hands the removal, as a rewind does. */
  async remove(plan: RewindPlan): Promise<RunRemovalOutcome> {
    this.clock = Math.max(this.clock, WRITES);
    return removeRunRecords(this.org, plan.deletes, plan.removal);
  }

  /** Whether the org holds a live record. */
  live(objectApiName: string, id: string): boolean {
    return this.org.all(objectApiName).some((row) => row.Id === id);
  }

  /** A live record's row. */
  row(objectApiName: string, id: string): OrgRow | undefined {
    return this.org.all(objectApiName).find((row) => row.Id === id);
  }
}

/** Take a checkpoint of the memory org as a take does: the bin at T0, then each object's snapshot and index. */
async function take(scenario: Scenario, facts?: Partial<MemoryOrgFacts>): Promise<World> {
  const world = new World(scenario, facts);
  const { org } = world;
  scenario.before?.(org);

  world.clock = T0_MS;
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-rewind-plan-'));
  made.push(dir);
  const opened = openCheckpointStore({
    root: join(dir, 'checkpoints'),
    locksDir: defaultCheckpointLocksDir(join(dir, 'home')),
  });
  if (!('store' in opened)) throw new Error(`refused: ${opened.refusal.reason}`);
  const checkpoints = opened.store;
  world.folder = await checkpoints.create(ORG, CHECKPOINT);
  const { folder } = world;
  const prints = Object.fromEntries(
    scenario.objects.map((object) => [
      object.objectApiName,
      fingerprintOf(
        object.fields.map((name) => ({ name, type: 'string', createable: true, updateable: true })),
      ),
    ]),
  );
  const bin = await spoolReads(
    compositeReader(org),
    scenario.objects.map((object) => ({
      ...binLedgerRead(object.objectApiName, new Date(T0_MS).toISOString()),
      file: binFileOf(folder, object.objectApiName),
    })),
  );

  const readAt = T0_MS + 200;
  world.clock = readAt;
  const store = new BackupRecordStore(nodeBackupFiles(folder.dir));
  for (const [readOrder, object] of scenario.objects.entries()) {
    let page = await org.query(`SELECT ${object.fields.join(', ')} FROM ${object.objectApiName}`);
    const rows: OrgRow[] = [...page.records];
    while (!page.done && page.nextRecordsUrl) {
      page = await org.queryMore(page.nextRecordsUrl);
      rows.push(...page.records);
    }
    await store.begin(SNAPSHOT, object.objectApiName);
    // As DataOps keeps a row: with the org's `attributes`, which no comparison reads.
    await store.append(
      SNAPSHOT,
      object.objectApiName,
      rows.map((row) => ({ attributes: { type: object.objectApiName }, ...row })),
    );
    const index = await writeSnapshotIndex(folder, SNAPSHOT, object.objectApiName);
    world.objects.push({
      objectApiName: object.objectApiName,
      records: index.rows,
      inBin: bin[readOrder].rows,
      readOrder,
      readMode: 'query',
      undeletable: object.undeletable ?? true,
      cascadeParents: object.cascadeParents ?? [],
      ...(object.restrictParents ? { restrictParents: object.restrictParents } : {}),
      fingerprint: prints[object.objectApiName].digest,
      fields: object.fields,
      leftOutFields: [],
    });
  }
  await checkpoints.writeFingerprints(folder, prints);
  // A take of a few seconds: what is made while it is taken is dated after
  // T0's second and before T1's, as the org dates to the second.
  world.clock = readAt + 1_300;
  scenario.afterRead?.(org);
  world.takenAt = new Date(readAt + 2_400).toISOString();
  return world;
}

/** The lines of a plan's file. */
async function linesOf(file: string): Promise<OrgRow[]> {
  const rows: OrgRow[] = [];
  for await (const row of spooledRows(file)) rows.push(row);
  return rows;
}

/** Every id of a spool, per object. */
async function idsOf(spool: {
  objects: ReadonlyArray<{ objectApiName: string }>;
  pages(objectApiName: string): AsyncIterable<readonly string[]>;
}): Promise<Record<string, string[]>> {
  const ids: Record<string, string[]> = {};
  for (const { objectApiName } of spool.objects) {
    for await (const page of spool.pages(objectApiName)) {
      ids[objectApiName] = [...(ids[objectApiName] ?? []), ...page].sort();
    }
  }
  return ids;
}

/** What a plan does with an object, all else none. */
function counts(objectApiName: string, some: Partial<RewindPlanObject>): RewindPlanObject {
  return {
    objectApiName,
    deleted: 0,
    withParentDeleted: 0,
    undoCannot: 0,
    nextPassDeleted: 0,
    broughtBack: 0,
    backWithParent: 0,
    recreated: 0,
    givenBackFirst: 0,
    givenBackAfter: 0,
    givenBackNextPass: 0,
    skipped: 0,
    ...some,
  };
}

const PV1 = 'pv-20261022-100200-a1a1';
const PV2 = 'pv-20261022-100300-b2b2';
const PV3 = 'pv-20261022-100400-c3c3';

const OPTIONS_FOR = new Date(TR).toISOString();

describe('rewindWriters', () => {
  it('names the user the rewind writes as and the org’s Automated Process, when the checkpoint knows one', () => {
    expect(rewindWriters({ automatedProcessUserId: AUTOMATED }, MEMORY_ORG_USER)).toEqual([
      MEMORY_ORG_USER,
      AUTOMATED,
    ]);
    expect(rewindWriters({}, MEMORY_ORG_USER)).toEqual([MEMORY_ORG_USER]);
  });
});

describe('heldInPlaceReason', () => {
  it('says which records a record given back after the deletions waited for', () => {
    expect(heldInPlaceReason('Opportunity', ['OpportunityLineItem'])).toBe(
      'Opportunity: given back once the OpportunityLineItem records hanging from it that the ' +
        'rewind deletes were gone, as those records held some of its values in place',
    );
  });
});

describe('a rewind’s plan: confirmed ∩ fresh (m5)', () => {
  it('acts on what the user confirmed that still differs, skips what no longer does, and leaves and names what changed since the preview', async () => {
    const [kept, back, changed, made1, made2] = [1, 2, 3, 4, 5].map(accountId);
    const world = await take({
      objects: [ACCOUNT],
      before: (org) => {
        org.add('Account', { Id: kept, Name: 'Kept', Industry: 'Energy' });
        org.add('Account', { Id: back, Name: 'Put back', Industry: 'Energy' });
        org.add('Account', { Id: changed, Name: 'Changed later', Industry: 'Energy' });
      },
    });
    world.at(SINCE, (org) => {
      org.add('Account', { Id: made1, Name: 'Made since' });
      org.edit('Account', back, { Industry: 'Retail' });
    });
    const confirmed = await world.diff(PV1, PREVIEWED);
    world.at(MEANWHILE, (org) => {
      org.add('Account', { Id: made2, Name: 'Made since the preview' });
      org.edit('Account', back, { Industry: 'Energy' });
      org.edit('Account', changed, { Industry: 'Retail' });
    });
    const fresh = await world.diff(PV2, TR);

    const plan = await world.plan({ confirmedDir: confirmed.dir, freshDir: fresh.dir });

    expect(await idsOf(plan.deletes)).toEqual({ Account: [made1] });
    expect(await idsOf(plan.giveBack.beforeDeletes)).toEqual({});
    expect(plan.left).toEqual([
      {
        objectApiName: 'Account',
        reason: 'changedSincePreview',
        count: 2,
        ids: [made2, changed],
      },
    ]);
    expect(plan.objects).toEqual([counts('Account', { deleted: 1, skipped: 1 })]);

    // From the diff it just showed, as the command line rewinds: all of it.
    const whole = await world.plan({ freshDir: fresh.dir });

    expect(await idsOf(whole.deletes)).toEqual({ Account: [made1, made2].sort() });
    expect(await idsOf(whole.giveBack.beforeDeletes)).toEqual({ Account: [changed] });
    expect(whole.left).toEqual([]);
  });

  it('keeps a record confirmed that a record created since the preview hangs from, which its deletion would take along', async () => {
    const parent = accountId(1);
    const child = contactId(1);
    const world = await take({
      objects: [CONTACT, ACCOUNT],
      children: { Account: [ACCOUNT_CONTACTS] },
    });
    world.at(SINCE, (org) => org.add('Account', { Id: parent, Name: 'Made since' }));
    const confirmed = await world.diff(PV1, PREVIEWED);
    world.at(MEANWHILE, (org) =>
      org.add('Contact', { Id: child, LastName: 'Made since the preview', AccountId: parent }),
    );
    const fresh = await world.diff(PV2, TR);

    const plan = await world.plan({ confirmedDir: confirmed.dir, freshDir: fresh.dir });
    const outcome = await world.remove(plan);

    expect(await idsOf(plan.deletes)).toEqual({});
    expect(plan.left).toEqual([
      { objectApiName: 'Contact', reason: 'changedSincePreview', count: 1, ids: [child] },
      { objectApiName: 'Account', reason: 'holdsLeft', count: 1, ids: [parent] },
    ]);
    expect(outcome.objects).toEqual([]);
    expect(world.live('Contact', child)).toBe(true);
    expect(world.live('Account', parent)).toBe(true);
  });

  it('deletes a record confirmed to come back with its parent, and gives the parent its values, once someone brought both back since the preview', async () => {
    const parent = opportunityId(1);
    const line = lineId(1);
    const world = await take({
      objects: [PRODUCT, OPPORTUNITY],
      children: { Opportunity: [OPPORTUNITY_PRODUCTS] },
      before: (org) => org.add('Opportunity', { Id: parent, Name: 'Kept' }),
    });
    world.at(SINCE, (org) => {
      org.edit('Opportunity', parent, { Name: 'Renamed' });
      org.add('OpportunityLineItem', { Id: line, Quantity: 1, OpportunityId: parent });
    });
    world.at(SINCE + 30_000, (org) => org.trash('Opportunity', parent));
    const confirmed = await world.diff(PV1, PREVIEWED);
    world.at(MEANWHILE, (org) => org.untrash(parent, COLLEAGUE));
    const fresh = await world.diff(PV2, TR);

    const plan = await world.plan({
      confirmedDir: confirmed.dir,
      freshDir: fresh.dir,
      acceptNoUndo: true,
    });

    expect(await idsOf(plan.deletes)).toEqual({ OpportunityLineItem: [line] });
    expect(await idsOf(plan.bringBack)).toEqual({});
    expect(await idsOf(plan.giveBack.afterDeletes)).toEqual({ Opportunity: [parent] });
    expect(plan.left).toEqual([]);
  });

  it('is written to a folder of its own, its owner’s, and refuses one that holds anything', async () => {
    const world = await take({ objects: [ACCOUNT] });
    world.at(SINCE, (org) => org.add('Account', { Id: accountId(1), Name: 'Made since' }));
    const fresh = await world.diff(PV1, TR);
    const dir = join(rewindDirOf(world.folder, REWIND), 'taken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'something'), '');

    await expect(world.plan({ freshDir: fresh.dir, dir })).rejects.toThrow(/not empty/);
    const plan = await world.plan({ freshDir: fresh.dir });

    // Windows keeps no POSIX modes: its user profile holds the files apart.
    if (process.platform !== 'win32') {
      expect(statSync(plan.dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(plan.dir, 'Account.createdSince.ndjson')).mode & 0o777).toBe(0o600);
      expect(statSync(join(plan.dir, 'deletes', 'Account.ids')).mode & 0o777).toBe(0o600);
    }
  });

  it('stops between two objects when it is told to', async () => {
    const world = await take({ objects: [ACCOUNT] });
    const fresh = await world.diff(PV1, TR);
    const stop = new AbortController();
    stop.abort();

    await expect(world.plan({ freshDir: fresh.dir, signal: stop.signal })).rejects.toBeInstanceOf(
      OrgReadStopped,
    );
  });
});

describe('a rewind’s plan: records the recycle bin no longer gives back (Q2)', () => {
  /** An account and its contact, both emptied from the bin since, the contact first. */
  async function emptied(): Promise<{ world: World; dir: string }> {
    const world = await take({
      objects: [CONTACT, ACCOUNT],
      children: { Account: [ACCOUNT_CONTACTS] },
      before: (org) => {
        org.add('Account', { Id: accountId(1), Name: 'Gone', Industry: 'Energy' });
        org.add('Contact', { Id: contactId(1), LastName: 'Gone', AccountId: accountId(1) });
      },
    });
    world.at(SINCE, (org) => {
      org.trash('Account', accountId(1));
      org.purge(accountId(1));
    });
    const fresh = await world.diff(PV1, TR);
    return { world, dir: fresh.dir };
  }

  it('makes them again once it is accepted, parents first, by the Ids the checkpoint holds them by', async () => {
    const { world, dir } = await emptied();

    const plan = await world.plan({ freshDir: dir, acceptRecreate: true });

    expect(plan.recreate.objects.map(({ objectApiName }) => objectApiName)).toEqual([
      'Account',
      'Contact',
    ]);
    expect(await idsOf(plan.recreate)).toEqual({
      Account: [accountId(1)],
      Contact: [contactId(1)],
    });
    expect(plan.left).toEqual([]);
    expect(plan.objects).toEqual([
      counts('Contact', { recreated: 1 }),
      counts('Account', { recreated: 1 }),
    ]);
  });

  it('leaves and names them unless that their Ids are new was accepted, making none', async () => {
    const { world, dir } = await emptied();

    const plan = await world.plan({ freshDir: dir });

    expect(plan.recreate.count).toBe(0);
    expect(plan.left).toEqual([
      { objectApiName: 'Contact', reason: 'recreateNotAccepted', count: 1, ids: [contactId(1)] },
      { objectApiName: 'Account', reason: 'recreateNotAccepted', count: 1, ids: [accountId(1)] },
    ]);
  });
});

describe('a rewind’s plan: the deletion’s boundary (B1)', () => {
  it('hands the removal T1 as the run’s start and the second before Tr as its end, changed records kept', async () => {
    const world = await take({ objects: [ACCOUNT] });
    const fresh = await world.diff(PV1, TR);

    const plan = await world.plan({ freshDir: fresh.dir });

    expect(plan.removal).toEqual({
      runStartedAt: new Date(world.takenAt),
      runEndedAt: new Date(TR - 1_000),
      includeChanged: false,
    });
    expect(plan.restore).toEqual({
      changedAfter: OPTIONS_FOR,
      ownWriters: [MEMORY_ORG_USER],
      includeChanged: false,
    });
  });

  it('keeps and names a parent created since that a checkpoint child still hangs from when the child’s give-back is refused, and never deletes the child, beside a record brought back since', async () => {
    const [home, inBin, made1] = [1, 2, 3].map(accountId);
    const child = contactId(1);
    const world = await take({
      objects: [CONTACT, ACCOUNT],
      children: { Account: [ACCOUNT_CONTACTS] },
      before: (org) => {
        // In the recycle bin at the checkpoint, made before anything else:
        // the earliest record a removal without a start would date the run by.
        org.add(
          'Account',
          { Id: inBin, Name: 'In the bin' },
          new Date(T0_MS - 2 * DAY_MS).toISOString(),
        );
        org.trash('Account', inBin);
        org.add('Account', { Id: home, Name: 'Home' });
        org.add('Contact', { Id: child, LastName: 'Moved', AccountId: home });
      },
    });
    world.at(SINCE, (org) => {
      org.untrash(inBin);
      org.add('Account', { Id: made1, Name: 'Made since' });
      org.edit('Contact', child, { AccountId: made1 });
    });
    const fresh = await world.diff(PV1, TR);
    const plan = await world.plan({ freshDir: fresh.dir });
    world.org.refuseUpdate.set(child, {
      statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
      message: 'A contact stays with its account',
    });

    const [restored] = await world.giveBack(plan.giveBack.beforeDeletes, plan);
    const outcome = await world.remove(plan);

    expect(await idsOf(plan.deletes)).toEqual({ Account: [inBin, made1].sort() });
    expect(restored.objects[0]).toMatchObject({ objectApiName: 'Contact', refused: 1 });
    expect(outcome.objects).toEqual([
      expect.objectContaining({ objectApiName: 'Account', deleted: 1, keptDependents: 1 }),
    ]);
    expect(world.live('Account', made1)).toBe(true);
    expect(world.row('Contact', child)).toMatchObject({ AccountId: made1 });
    expect(world.org.inBin('Account').map((row) => row.Id)).toEqual([inBin]);
  });

  it('keeps a parent created since that a record outside the checkpoint made while it was taken hangs from', async () => {
    const parent = accountId(1);
    const dependent = opportunityId(1);
    const world = await take({
      objects: [ACCOUNT],
      children: { Account: [ACCOUNT_OPPORTUNITIES] },
      // After the accounts were read, before the take ended.
      afterRead: (org) => {
        org.add('Account', { Id: parent, Name: 'Made while taken' });
        org.add('Opportunity', { Id: dependent, Name: 'Made while taken', AccountId: parent });
      },
    });
    const fresh = await world.diff(PV1, TR);
    const plan = await world.plan({ freshDir: fresh.dir });

    const outcome = await world.remove(plan);

    expect(await idsOf(plan.deletes)).toEqual({ Account: [parent] });
    expect(outcome.objects).toEqual([
      expect.objectContaining({ objectApiName: 'Account', deleted: 0, keptDependents: 1 }),
    ]);
    expect(world.live('Opportunity', dependent)).toBe(true);
  });

  it('keeps a colleague’s record made after Tr, and the parent it hangs from', async () => {
    const parent = accountId(1);
    const [along, theirs] = [1, 2].map(opportunityId);
    const world = await take({
      objects: [ACCOUNT],
      children: { Account: [ACCOUNT_OPPORTUNITIES] },
    });
    world.at(SINCE, (org) => {
      org.add('Account', { Id: parent, Name: 'Made since' });
      org.add('Opportunity', { Id: along, Name: 'Made since', AccountId: parent });
    });
    const fresh = await world.diff(PV1, TR);
    const plan = await world.plan({ freshDir: fresh.dir });
    world.at(WRITES, (org) =>
      org.add('Opportunity', {
        Id: theirs,
        Name: 'A colleague’s',
        AccountId: parent,
        CreatedById: COLLEAGUE,
        LastModifiedById: COLLEAGUE,
      }),
    );

    const outcome = await world.remove(plan);

    expect(outcome.objects).toEqual([
      expect.objectContaining({ objectApiName: 'Account', deleted: 0, keptDependents: 1 }),
    ]);
    expect(world.live('Account', parent)).toBe(true);
    expect(world.live('Opportunity', theirs)).toBe(true);
  });
});

describe('a rewind’s plan: what Undo couldn’t bring back (B3, A14)', () => {
  it('does not send a product made since under an opportunity it deletes too: it goes with it, and comes back with it', async () => {
    for (const facts of factCombinations([
      'childDeletedAloneStays',
      'cascadeChildComesBackAlone',
    ])) {
      const parent = opportunityId(1);
      const line = lineId(1);
      const world = await take(
        {
          objects: [PRODUCT, OPPORTUNITY],
          children: { Opportunity: [OPPORTUNITY_PRODUCTS] },
        },
        facts,
      );
      world.at(SINCE, (org) => {
        org.add('Opportunity', { Id: parent, Name: 'Made since' });
        org.add('OpportunityLineItem', { Id: line, Quantity: 1, OpportunityId: parent });
      });
      const fresh = await world.diff(PV1, TR);
      const plan = await world.plan({ freshDir: fresh.dir });

      const outcome = await world.remove(plan);
      const said = JSON.stringify(facts);

      expect(await idsOf(plan.deletes), said).toEqual({ Opportunity: [parent] });
      expect(plan.objects, said).toEqual([
        counts('OpportunityLineItem', { withParentDeleted: 1 }),
        counts('Opportunity', { deleted: 1 }),
      ]);
      expect(plan.undoCannot, said).toEqual([]);
      expect(plan.left, said).toEqual([]);
      expect(
        outcome.objects.map(({ objectApiName, deleted }) => [objectApiName, deleted]),
        said,
      ).toEqual([['Opportunity', 1]]);
      expect(world.live('OpportunityLineItem', line), said).toBe(false);
      // Undo brings the opportunity back, and its product with it.
      await world.org.undelete([parent]);
      expect(world.live('OpportunityLineItem', line), said).toBe(true);
    }
  });

  it('leaves and names a product made since under an opportunity that stays unless that Undo couldn’t bring it back was accepted, then deletes it on its own', async () => {
    const parent = opportunityId(1);
    const line = lineId(1);
    const world = await take({
      objects: [PRODUCT, OPPORTUNITY],
      children: { Opportunity: [OPPORTUNITY_PRODUCTS] },
      before: (org) => org.add('Opportunity', { Id: parent, Name: 'Kept' }),
    });
    world.at(SINCE, (org) =>
      org.add('OpportunityLineItem', { Id: line, Quantity: 1, OpportunityId: parent }),
    );
    const fresh = await world.diff(PV1, TR);
    expect(fresh.diff.undoCannot).toEqual([{ objectApiName: 'OpportunityLineItem', count: 1 }]);

    const refused = await world.plan({ freshDir: fresh.dir });
    const accepted = await world.plan({ freshDir: fresh.dir, acceptNoUndo: true });

    expect(await idsOf(refused.deletes)).toEqual({});
    expect(refused.left).toEqual([
      { objectApiName: 'OpportunityLineItem', reason: 'noUndoNotAccepted', count: 1, ids: [line] },
    ]);
    expect(refused.undoCannot).toEqual([]);
    expect(await idsOf(accepted.deletes)).toEqual({ OpportunityLineItem: [line] });
    expect(accepted.undoCannot).toEqual([{ objectApiName: 'OpportunityLineItem', count: 1 }]);
    expect(accepted.left).toEqual([]);
  });

  it('sends on its own a product made while the checkpoint was taken under an opportunity it deletes, which would otherwise keep its parent', async () => {
    const parent = opportunityId(1);
    const line = lineId(1);
    const world = await take({
      objects: [PRODUCT, OPPORTUNITY],
      children: { Opportunity: [OPPORTUNITY_PRODUCTS] },
      afterRead: (org) => {
        org.add('Opportunity', { Id: parent, Name: 'Made while taken' });
        org.add('OpportunityLineItem', { Id: line, Quantity: 1, OpportunityId: parent });
      },
    });
    const fresh = await world.diff(PV1, TR);
    const plan = await world.plan({ freshDir: fresh.dir, acceptNoUndo: true });

    const outcome = await world.remove(plan);

    expect(await idsOf(plan.deletes)).toEqual({
      OpportunityLineItem: [line],
      Opportunity: [parent],
    });
    expect(plan.undoCannot).toEqual([{ objectApiName: 'OpportunityLineItem', count: 1 }]);
    expect(plan.beforeParent.map(({ objectApiName, count }) => [objectApiName, count])).toEqual([
      ['OpportunityLineItem', 1],
    ]);
    expect(await linesOf(plan.beforeParent[0].file)).toEqual([{ Id: line, parents: [parent] }]);
    expect(outcome.objects.map(({ objectApiName, deleted }) => [objectApiName, deleted])).toEqual([
      ['OpportunityLineItem', 1],
      ['Opportunity', 1],
    ]);
    expect(world.live('Opportunity', parent)).toBe(false);
  });

  it('leaves and names a case made since under an account it deletes too, through a lookup that restricts the account’s delete, unless that Undo couldn’t bring it back was accepted: then sends it first, said beside the account, and the account’s delete leaves it in the bin for good (F41, a case under its account, live)', async () => {
    const parent = accountId(1);
    const kase = caseId(1);
    const world = await take({ objects: [CASE, ACCOUNT], children: { Account: [ACCOUNT_CASES] } });
    world.at(SINCE, (org) => {
      org.add('Account', { Id: parent, Name: 'Made since' });
      org.add('Case', { Id: kase, Subject: 'Made since', AccountId: parent });
    });
    const fresh = await world.diff(PV1, TR);
    expect(fresh.diff.undoCannot).toEqual([
      { objectApiName: 'Case', count: 1, reason: 'deletedBeforeParent' },
    ]);

    const refused = await world.plan({ freshDir: fresh.dir });
    const accepted = await world.plan({ freshDir: fresh.dir, acceptNoUndo: true });

    expect(refused.left).toEqual([
      { objectApiName: 'Case', reason: 'beforeParentNotAccepted', count: 1, ids: [kase] },
    ]);
    expect((await idsOf(refused.deletes)).Case).toBeUndefined();
    expect(refused.beforeParent).toEqual([]);
    expect(await idsOf(accepted.deletes)).toEqual({ Case: [kase], Account: [parent] });
    expect(accepted.left).toEqual([]);
    expect(accepted.objects).toEqual([
      counts('Case', { deleted: 1, undoCannot: 1 }),
      counts('Account', { deleted: 1 }),
    ]);
    expect(accepted.beforeParent.map(({ objectApiName, count }) => [objectApiName, count])).toEqual(
      [['Case', 1]],
    );
    expect(await linesOf(accepted.beforeParent[0].file)).toEqual([{ Id: kase, parents: [parent] }]);

    const outcome = await world.remove(accepted);

    expect(outcome.objects.map(({ objectApiName, deleted }) => [objectApiName, deleted])).toEqual([
      ['Case', 1],
      ['Account', 1],
    ]);
    // What Undo would send: the account comes back, the case is refused.
    expect(await world.org.undelete([parent, kase])).toEqual([
      { id: parent, success: true, errors: [] },
      expect.objectContaining({ id: kase, success: false }),
    ]);
  });
});

describe('a rewind’s plan: records outside a checkpoint of picked objects (M8, A13)', () => {
  it('keeps and names a record created since that records outside the checkpoint hang from, unless their deletion was accepted or the checkpoint holds everything', async () => {
    const parent = accountId(1);
    const child = contactId(1);
    const outside = opportunityId(1);
    const world = await take({
      objects: [CONTACT, ACCOUNT],
      children: { Account: [ACCOUNT_CONTACTS, ACCOUNT_OPPORTUNITIES] },
    });
    world.at(SINCE, (org) => {
      org.add('Account', { Id: parent, Name: 'Made since' });
      org.add('Contact', { Id: child, LastName: 'Made since', AccountId: parent });
      org.add('Opportunity', { Id: outside, Name: 'Made since', AccountId: parent });
    });
    const fresh = await world.diff(PV1, TR);
    expect(
      fresh.diff.objects.find((object) => object.objectApiName === 'Account')?.outside,
    ).toEqual([{ objectApiName: 'Opportunity', count: 1, parents: 1 }]);

    const picked = await world.plan({ freshDir: fresh.dir, mode: 'picked' });
    const accepted = await world.plan({ freshDir: fresh.dir, mode: 'picked', acceptOutside: true });
    const everything = await world.plan({ freshDir: fresh.dir });

    expect(await idsOf(picked.deletes)).toEqual({ Contact: [child] });
    expect(picked.left).toEqual([
      { objectApiName: 'Account', reason: 'outsideNotAccepted', count: 1, ids: [parent] },
    ]);
    // Deleted, the account takes its contact made since along: never sent.
    expect(await idsOf(accepted.deletes)).toEqual({ Account: [parent] });
    expect(await idsOf(everything.deletes)).toEqual({ Account: [parent] });

    await world.remove(picked);

    expect(world.live('Contact', child)).toBe(false);
    expect(world.live('Account', parent)).toBe(true);
    expect(world.live('Opportunity', outside)).toBe(true);
  });

  it('keeps the parent of a record kept for what hangs from it outside the checkpoint, and that parent’s own, as far up as they go', async () => {
    const parent = accountId(1);
    const child = contactId(1);
    const outside = caseId(1);
    const world = await take({
      objects: [CONTACT, ACCOUNT],
      children: {
        Account: [ACCOUNT_CONTACTS],
        Contact: [{ childSObject: 'Case', field: 'ContactId', cascadeDelete: true }],
      },
    });
    world.at(SINCE, (org) => {
      org.add('Account', { Id: parent, Name: 'Made since' });
      org.add('Contact', { Id: child, LastName: 'Made since', AccountId: parent });
      org.add('Case', { Id: outside, ContactId: child });
    });
    const fresh = await world.diff(PV1, TR);
    const plan = await world.plan({ freshDir: fresh.dir, mode: 'picked' });

    await world.remove(plan);

    expect(await idsOf(plan.deletes)).toEqual({});
    expect(plan.left).toEqual([
      { objectApiName: 'Contact', reason: 'outsideNotAccepted', count: 1, ids: [child] },
      { objectApiName: 'Account', reason: 'holdsLeft', count: 1, ids: [parent] },
    ]);
    expect(world.live('Case', outside)).toBe(true);
    expect(world.live('Account', parent)).toBe(true);
  });
});

describe('a rewind’s plan: values a child it deletes holds in place (gate G1)', () => {
  /** An opportunity whose price book changed since, as a product was added under it. */
  async function heldInPlace(): Promise<{ world: World; parent: string; line: string }> {
    const parent = opportunityId(1);
    const line = lineId(1);
    const world = await take({
      objects: [PRODUCT, OPPORTUNITY],
      children: { Opportunity: [OPPORTUNITY_PRODUCTS] },
      before: (org) =>
        org.add('Opportunity', { Id: parent, Name: 'Kept', Pricebook2Id: bookId(1) }),
    });
    world.org.heldByChildren.push(PRICE_BOOK_HELD);
    world.at(SINCE, (org) => {
      org.edit('Opportunity', parent, { Pricebook2Id: bookId(2) });
      org.add('OpportunityLineItem', { Id: line, Quantity: 1, OpportunityId: parent });
    });
    return { world, parent, line };
  }

  it('gives back after the deletions a record the products it deletes hold values of in place, and says what it waited for', async () => {
    const { world, parent, line } = await heldInPlace();
    const fresh = await world.diff(PV1, TR);
    const plan = await world.plan({ freshDir: fresh.dir, acceptNoUndo: true });

    const first = await world.giveBack(plan.giveBack.beforeDeletes, plan);
    await world.remove(plan);
    const [after] = await world.giveBack(plan.giveBack.afterDeletes, plan);

    expect(await idsOf(plan.deletes)).toEqual({ OpportunityLineItem: [line] });
    expect(await idsOf(plan.giveBack.beforeDeletes)).toEqual({});
    expect(await idsOf(plan.giveBack.afterDeletes)).toEqual({ Opportunity: [parent] });
    expect(plan.giveBack.heldBy).toEqual([
      { objectApiName: 'Opportunity', by: ['OpportunityLineItem'] },
    ]);
    expect(plan.objects).toEqual([
      counts('OpportunityLineItem', { deleted: 1, undoCannot: 1 }),
      counts('Opportunity', { givenBackAfter: 1 }),
    ]);
    expect(first).toEqual([]);
    expect(after.objects[0]).toMatchObject({
      objectApiName: 'Opportunity',
      restored: 1,
      refused: 0,
    });
    expect(after.objects[0].restoredWithout).toBeUndefined();
    expect(world.row('Opportunity', parent)).toMatchObject({ Pricebook2Id: bookId(1) });
  });

  it('meets the org’s refusal when the same record is given back before its product is deleted', async () => {
    const { world, parent } = await heldInPlace();
    const fresh = await world.diff(PV1, TR);
    const plan = await world.plan({ freshDir: fresh.dir, acceptNoUndo: true });

    const [early] = await world.giveBack(plan.giveBack.afterDeletes, plan);

    expect(early.objects[0]).toMatchObject({
      objectApiName: 'Opportunity',
      restored: 0,
      refused: 1,
    });
    expect(early.objects[0].reasons).toEqual([
      'FIELD_INTEGRITY_EXCEPTION: Cannot change pricebook on opportunity with line items',
    ]);
    expect(world.row('Opportunity', parent)).toMatchObject({ Pricebook2Id: bookId(2) });
  });

  it('gives a record moved under a parent it deletes back before the deletions too, so the parent can go, and again after for what its products held', async () => {
    const [home, made1] = [1, 2].map(accountId);
    const parent = opportunityId(1);
    const line = lineId(1);
    const world = await take({
      objects: [PRODUCT, OPPORTUNITY_OF_ACCOUNT, ACCOUNT],
      children: { Account: [ACCOUNT_OPPORTUNITIES], Opportunity: [OPPORTUNITY_PRODUCTS] },
      before: (org) => {
        org.add('Account', { Id: home, Name: 'Home' });
        org.add('Opportunity', {
          Id: parent,
          Name: 'Kept',
          Pricebook2Id: bookId(1),
          AccountId: home,
        });
      },
    });
    world.org.heldByChildren.push(PRICE_BOOK_HELD);
    world.at(SINCE, (org) => {
      org.add('Account', { Id: made1, Name: 'Made since' });
      org.edit('Opportunity', parent, { AccountId: made1, Pricebook2Id: bookId(2) });
      org.add('OpportunityLineItem', { Id: line, Quantity: 1, OpportunityId: parent });
    });
    const fresh = await world.diff(PV1, TR);
    const plan = await world.plan({ freshDir: fresh.dir, acceptNoUndo: true });

    await world.giveBack(plan.giveBack.beforeDeletes, plan);
    const outcome = await world.remove(plan);
    await world.giveBack(plan.giveBack.afterDeletes, plan);

    expect(await idsOf(plan.giveBack.beforeDeletes)).toEqual({ Opportunity: [parent] });
    expect(await idsOf(plan.giveBack.afterDeletes)).toEqual({ Opportunity: [parent] });
    expect(outcome.objects.map(({ objectApiName, deleted }) => [objectApiName, deleted])).toEqual([
      ['OpportunityLineItem', 1],
      ['Account', 1],
    ]);
    expect(world.row('Opportunity', parent)).toMatchObject({
      AccountId: home,
      Pricebook2Id: bookId(1),
    });
  });

  it('leaves to the second pass the give-back of a record whose products come back with it, and gives it back there once they are deleted again, whoever the undelete names', async () => {
    for (const facts of factCombinations(['undeleterIsLastModifier'])) {
      const parent = opportunityId(1);
      const line = lineId(1);
      const world = await take(
        {
          objects: [PRODUCT, OPPORTUNITY],
          children: { Opportunity: [OPPORTUNITY_PRODUCTS] },
          before: (org) =>
            org.add('Opportunity', { Id: parent, Name: 'Kept', Pricebook2Id: bookId(1) }),
        },
        facts,
      );
      world.org.heldByChildren.push(PRICE_BOOK_HELD);
      world.at(SINCE, (org) => {
        org.edit('Opportunity', parent, { Pricebook2Id: bookId(2) }, COLLEAGUE);
        org.add('OpportunityLineItem', {
          Id: line,
          Quantity: 1,
          OpportunityId: parent,
          LastModifiedById: COLLEAGUE,
        });
      });
      world.at(SINCE + 30_000, (org) => org.trash('Opportunity', parent, COLLEAGUE));
      const fresh = await world.diff(PV1, TR);
      const said = JSON.stringify(facts);

      const first = await world.plan({ freshDir: fresh.dir, acceptNoUndo: true });

      expect(await idsOf(first.bringBack), said).toEqual({ Opportunity: [parent] });
      expect(await idsOf(first.deletes), said).toEqual({});
      expect(await idsOf(first.giveBack.beforeDeletes), said).toEqual({});
      expect(await idsOf(first.giveBack.afterDeletes), said).toEqual({});
      expect(first.objects, said).toEqual([
        counts('OpportunityLineItem', { nextPassDeleted: 1 }),
        counts('Opportunity', { broughtBack: 1, givenBackNextPass: 1 }),
      ]);

      // The first pass brings the opportunity back, its product with it, and
      // keeps what the undelete left on both, as the rewind's journal does.
      world.clock = WRITES;
      await world.org.undelete([parent]);
      const stamps = Object.fromEntries(
        [world.row('Opportunity', parent), world.row('OpportunityLineItem', line)].map((row) => [
          String(row?.Id),
          String(row?.LastModifiedDate),
        ]),
      );
      const again = await world.diff(PV3, PASS_TWO);
      const second = await world.plan({
        pass: 2,
        confirmedDir: first.dir,
        freshDir: again.dir,
        acceptNoUndo: true,
        removalStamps: stamps,
      });

      expect(await idsOf(second.deletes), said).toEqual({ OpportunityLineItem: [line] });
      expect(await idsOf(second.giveBack.afterDeletes), said).toEqual({ Opportunity: [parent] });
      expect(second.left, said).toEqual([]);

      await world.giveBack(second.giveBack.beforeDeletes, second);
      const outcome = await world.remove(second);
      const [after] = await world.giveBack(second.giveBack.afterDeletes, second);

      expect(
        outcome.objects.map(({ objectApiName, deleted }) => [objectApiName, deleted]),
        said,
      ).toEqual([['OpportunityLineItem', 1]]);
      expect(after.objects[0], said).toMatchObject({ restored: 1, keptChanged: 0, refused: 0 });
      expect(world.row('Opportunity', parent), said).toMatchObject({ Pricebook2Id: bookId(1) });
    }
  });
});

describe('a rewind’s plan: the second pass (M3)', () => {
  it('takes back what the rewind’s own users made after Tr, tries again what the first pass left, and leaves and names what a colleague changed after Tr', async () => {
    const [refused, theirs, made1, answer, colleagues] = [1, 2, 3, 4, 5].map(accountId);
    const world = await take({
      objects: [ACCOUNT],
      before: (org) => {
        org.add('Account', { Id: refused, Name: 'Refused', Industry: 'Energy' });
        org.add('Account', { Id: theirs, Name: 'Theirs after', Industry: 'Energy' });
      },
    });
    world.at(SINCE, (org) => {
      org.edit('Account', refused, { Industry: 'Retail' });
      org.edit('Account', theirs, { Industry: 'Retail' });
      org.add('Account', { Id: made1, Name: 'Made since', LastModifiedById: MEMORY_ORG_USER });
    });
    const fresh = await world.diff(PV1, TR);
    const owners = [MEMORY_ORG_USER, AUTOMATED];
    const first = await world.plan({ freshDir: fresh.dir, ownWriters: owners });
    world.org.refuseUpdate.set(refused, { statusCode: 'UNABLE_TO_LOCK_ROW', message: 'locked' });
    await world.giveBack(first.giveBack.beforeDeletes, first);
    const removed = await world.remove(first);
    // In answer to the first pass, and meanwhile.
    world.at(WRITES + 5_000, (org) => {
      org.add('Account', { Id: answer, Name: 'Made by a flow', LastModifiedById: AUTOMATED });
      org.edit('Account', theirs, { Industry: 'Mining' }, COLLEAGUE);
      org.add('Account', { Id: colleagues, Name: 'A colleague’s', LastModifiedById: COLLEAGUE });
    });
    world.org.refuseUpdate.clear();
    const again = await world.diff(PV2, PASS_TWO);

    const second = await world.plan({
      pass: 2,
      confirmedDir: first.dir,
      freshDir: again.dir,
      ownWriters: owners,
      removalStamps: removed.stamps,
      ...(removed.span ? { removalSpans: [removed.span] } : {}),
    });

    expect(await idsOf(second.deletes)).toEqual({ Account: [answer] });
    expect(second.removal.removalStamps).toEqual({
      [answer]: world.row('Account', answer)?.LastModifiedDate,
    });
    expect(second.removal.removalSpans).toEqual(removed.span ? [removed.span] : undefined);
    expect(await idsOf(second.giveBack.beforeDeletes)).toEqual({ Account: [refused] });
    expect(second.left).toEqual([
      {
        objectApiName: 'Account',
        reason: 'changedDuringRewind',
        by: COLLEAGUE,
        count: 2,
        ids: [colleagues, theirs],
      },
    ]);

    const outcome = await world.remove(second);
    await world.giveBack(second.giveBack.beforeDeletes, second);

    expect(outcome.objects).toEqual([
      expect.objectContaining({ objectApiName: 'Account', deleted: 1, keptChanged: 0 }),
    ]);
    expect(world.live('Account', answer)).toBe(false);
    expect(world.row('Account', refused)).toMatchObject({ Industry: 'Energy' });
    expect(world.row('Account', theirs)).toMatchObject({ Industry: 'Mining' });
    expect(world.live('Account', colleagues)).toBe(true);
  });
});

describe('a rewind’s plan: chunks and pages (M2)', () => {
  it('never hands the give-back more than 2,000 records at a time, nor the removal a page of more', async () => {
    const records = SNAPSHOT_CHUNK_IDS + 1;
    const changed = Array.from({ length: records }, (_, n) => accountId(n));
    const created = Array.from({ length: records }, (_, n) => accountId(records + n));
    const world = await take({
      objects: [ACCOUNT],
      before: (org) => {
        for (const id of changed) org.add('Account', { Id: id, Name: 'Kept', Industry: 'Energy' });
      },
    });
    world.at(SINCE, (org) => {
      for (const id of changed) org.edit('Account', id, { Industry: 'Retail' });
      for (const id of created) org.add('Account', { Id: id, Name: 'Made since' });
    });
    const fresh = await world.diff(PV1, TR);

    const plan = await world.plan({ freshDir: fresh.dir });

    const chunks: number[] = [];
    for await (const ids of plan.giveBack.beforeDeletes.pages('Account', SNAPSHOT_CHUNK_IDS)) {
      chunks.push(ids.length);
    }
    const pages: number[] = [];
    for await (const ids of plan.deletes.pages('Account')) pages.push(ids.length);
    expect(chunks).toEqual([SNAPSHOT_CHUNK_IDS, 1]);
    expect(pages).toEqual([SNAPSHOT_CHUNK_IDS, 1]);
    expect(plan.objects).toEqual([
      counts('Account', { deleted: records, givenBackFirst: records }),
    ]);
  });
});
