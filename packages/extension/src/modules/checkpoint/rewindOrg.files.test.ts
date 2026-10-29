import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BYTES_PER_MB, type OrgCheckpoint, type RewindDiff } from '@sandforge/shared';

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { FILE_LINK, FILE_VERSION, MemoryFileOrg, fileId } from '../../test/memoryFileOrg.js';
import {
  MEMORY_ORG_USER,
  type MemoryChild,
  type MemoryOrgRequest,
} from '../../test/memoryRemovalOrg.js';
import {
  AUTOMATED_PROCESS,
  COLLEAGUE,
  LONG_AGO,
  ORG_ID,
  PREVIEWED,
  REWOUND,
  SINCE,
  STAMP_FIELDS,
  T0,
  account,
  automationOf,
  clock,
  contact,
  journalKinds,
  writable,
} from '../../test/rewindTestOrg.js';
import { openCheckpointStore, rewindDirOf, type CheckpointFolder } from './OrgCheckpointStore.js';
import type { FileLinkLine } from './checkpointFiles.js';
import { previewCheckpoint } from './previewCheckpoint.js';
import { undoPlansOf } from './rewindJournal.js';
import { rewindOrg, type RewindOutcome } from './rewindOrg.js';
import { takeCheckpoint, type TakeOrg } from './takeCheckpoint.js';
import { undoCheckpoint } from './undoCheckpoint.js';
import { undoRewind } from './undoRewind.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * A rewind, and its undo, of a checkpoint that holds files, on the memory
 * org that holds them as a scratch org held them in the probes of tour 0
 * (`memoryFileOrg.ts`): a file is a record of the checkpoint, its links come
 * and go with it, and the links that neither does are written on their own,
 * as the preview's diff of links tells them apart (`fileLinksDiff.ts`). The
 * rewind acts on the preview as read, as the command line rewinds from the
 * diff it just showed, unless a test has it read the org again.
 */

/** The objects of files, as a scratch org describes them (FA1, FA2). */
const FIELDS: Record<string, unknown[]> = {
  Account: [...STAMP_FIELDS, writable('Name')],
  Contact: [
    ...STAMP_FIELDS,
    writable('LastName'),
    writable('AccountId', 'reference', { referenceTo: ['Account'] }),
  ],
  ContentDocument: [
    ...STAMP_FIELDS,
    writable('Title', 'string', { createable: false }),
    writable('Description', 'textarea', { createable: false }),
    writable('OwnerId', 'reference', { createable: false, referenceTo: ['User'] }),
    writable('SharingPrivacy', 'picklist', { createable: false }),
    writable('SharingOption', 'picklist', { createable: false }),
    {
      name: 'LatestPublishedVersionId',
      label: 'Latest Published Version',
      type: 'reference',
      permissionable: false,
    },
    { name: 'ContentSize', label: 'Size', type: 'int', permissionable: false },
  ],
  ContentDocumentLink: [
    { name: 'Id', label: 'Id', type: 'id', permissionable: false },
    {
      name: 'LinkedEntityId',
      label: 'Linked Entity',
      type: 'reference',
      createable: true,
      referenceTo: ['Account', 'Contact', 'User'],
    },
    { name: 'ContentDocumentId', label: 'Document', type: 'reference', createable: true },
    { name: 'IsDeleted', label: 'Deleted', type: 'boolean', permissionable: false },
    {
      name: 'SystemModstamp',
      label: 'System Modstamp',
      type: 'datetime',
      permissionable: false,
    },
    writable('ShareType', 'picklist'),
    writable('Visibility', 'picklist'),
  ],
};

/** As the global describe of a scratch org lists them. */
const LISTED: Record<string, Record<string, unknown>> = {
  Account: { keyPrefix: '001' },
  Contact: { keyPrefix: '003' },
  ContentDocument: { createable: false, keyPrefix: '069' },
  ContentDocumentLink: { keyPrefix: '06A' },
  ContentVersion: { deletable: false, keyPrefix: '068' },
};

/** An account's contacts and its files' links go with it; a file's links with the file. */
const CHILDREN: Record<string, MemoryChild[]> = {
  Account: [
    { childSObject: 'Contact', field: 'AccountId', cascadeDelete: true },
    { childSObject: 'ContentDocumentLink', field: 'LinkedEntityId', cascadeDelete: true },
  ],
  ContentDocument: [
    { childSObject: 'ContentDocumentLink', field: 'ContentDocumentId', cascadeDelete: true },
  ],
};

/** The memory org of files, as a take, a preview and a rewind read it. */
class FileRewindOrg extends MemoryFileOrg implements TakeOrg {
  limits = { Max: 15_000, Remaining: 14_000 };
  /** Its file storage, in MB, as `/limits` lists it. */
  fileStorage = { Max: 50, Remaining: 50 };
  ticking = false;

  constructor() {
    super(CHILDREN, { now: () => clock.now });
    clock.now = LONG_AGO;
    for (const [name, described] of Object.entries(FIELDS)) this.changeSchema(name, described);
    this.add('Organization', {
      Id: ORG_ID,
      IsSandbox: false,
      OrganizationType: 'Developer Edition',
    });
    this.add('UserPermissionAccess', {
      Id: '0Up000000000001AAA',
      PermissionsViewAllData: true,
      PermissionsModifyAllData: true,
      PermissionsViewEncryptedData: false,
    });
    this.add('User', { Id: AUTOMATED_PROCESS, UserType: 'AutomatedProcess' });
    this.add('User', { Id: MEMORY_ORG_USER, Name: 'Ada Admin' });
  }

  override async describeGlobal(): Promise<unknown> {
    this.requests++;
    return {
      sobjects: Object.entries(LISTED).map(([name, extra]) => ({
        name,
        label: name,
        queryable: true,
        createable: true,
        updateable: true,
        deletable: true,
        layoutable: true,
        ...extra,
      })),
    };
  }

  override async request(request: MemoryOrgRequest): Promise<unknown> {
    if (request.method === 'GET' && request.url.endsWith('/limits')) {
      this.requests++;
      return { DailyApiRequests: this.limits, FileStorageMB: this.fileStorage };
    }
    return super.request(request);
  }

  override async serverTime(): Promise<string> {
    if (this.ticking) clock.now += 1_000;
    return super.serverTime();
  }

  /** The ids of each undelete sent, in the order sent. */
  readonly undeleteRequests: string[][] = [];

  override async undelete(ids: string[]): Promise<unknown> {
    this.undeleteRequests.push([...ids]);
    return super.undelete(ids);
  }
}

const dirs: string[] = [];

beforeEach(() => {
  clock.now = T0;
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.mocked(getJsforceConnection).mockReset();
});

interface Taken {
  org: FileRewindOrg;
  store: ReturnType<typeof storeOf>;
  checkpoint: OrgCheckpoint;
  folder: CheckpointFolder;
}

function storeOf(dir: string) {
  const opened = openCheckpointStore({ root: join(dir, 'store'), locksDir: join(dir, 'locks') });
  if ('refusal' in opened) throw new Error(`no store: ${opened.refusal.reason}`);
  return opened.store;
}

/** The accounts and files long before the checkpoint, then the checkpoint, of the accounts picked: files are held with them. */
async function taken(build: (org: FileRewindOrg) => void): Promise<Taken> {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-rewind-files-'));
  dirs.push(dir);
  const store = storeOf(dir);
  const org = new FileRewindOrg();
  clock.now = LONG_AGO;
  build(org);
  clock.now = T0;
  vi.mocked(getJsforceConnection).mockResolvedValue({
    query: (soql: string, options?: { scanAll?: boolean }) => org.query(soql, options),
    queryMore: (nextRecordsUrl: string) => org.queryMore(nextRecordsUrl),
    describe: (objectApiName: string) => org.describe(objectApiName),
  } as never);
  const outcome = await takeCheckpoint(
    {
      org,
      store,
      handler: {
        log: () => undefined,
        orgManager: { getOrg: () => ({ orgType: 'Developer' }) } as never,
        orgRegistry: {} as never,
      },
      now: () => new Date(T0),
    },
    {
      orgId: 'org-1',
      orgName: 'DEV-ED',
      alias: 'DEV-ED',
      username: 'tester@example.com',
      instanceUrl: 'https://example.my.salesforce.com',
      registered: { orgType: 'Developer' },
      mode: 'picked',
      objects: ['Account'],
      name: 'Before UAT',
    },
  );
  if (!outcome.taken) throw new Error(`refused: ${outcome.refusal.message}`);
  return {
    org,
    store,
    checkpoint: outcome.checkpoint,
    folder: store.folderOf(ORG_ID, outcome.checkpoint.checkpointId),
  };
}

const request = (t: Taken) => ({
  checkpoint: t.checkpoint,
  folder: t.folder,
  orgName: 'DEV-ED',
  registered: { orgType: 'Developer' as const },
  username: 'tester@example.com',
});

async function previewed(t: Taken): Promise<RewindDiff> {
  clock.now = Math.max(clock.now, PREVIEWED);
  const outcome = await previewCheckpoint({ org: t.org, store: t.store }, request(t));
  if (!outcome.previewed) throw new Error(outcome.refusal.message);
  return outcome.diff;
}

/** The rewind of `t`, acting on `diff` as read, unless told to read the org again. */
async function rewound(
  t: Taken,
  diff: RewindDiff,
  options: { reread?: boolean; readAutomation?: (objects: readonly string[]) => void } = {},
): Promise<RewindOutcome> {
  clock.now = Math.max(clock.now, REWOUND);
  t.org.ticking = true;
  const read = await t.store.read(t.checkpoint.checkpointId);
  if (!read?.checkpoint) throw new Error('the checkpoint is gone');
  try {
    return await rewindOrg(
      {
        org: t.org,
        undelete: (ids) => t.org.undelete(ids),
        store: t.store,
        ...(options.readAutomation
          ? {
              readAutomation: async (objects: readonly string[]) => {
                options.readAutomation?.(objects);
                return automationOf()();
              },
            }
          : {}),
      },
      {
        ...request(t),
        checkpoint: read.checkpoint,
        previewId: diff.previewId,
        ...(options.reread ? {} : { reusesPreview: diff }),
        acceptAutomation: false,
        acceptNoUndo: false,
        acceptRecreate: false,
        acceptOutside: false,
        acceptUnseen: false,
      },
    );
  } finally {
    t.org.ticking = false;
  }
}

/** The links between files and records the org holds live, each by its ends and its sharing. */
function liveLinks(org: FileRewindOrg): string[] {
  return org
    .heldLinks()
    .filter(
      (link) =>
        !link.LinkedEntityId.startsWith('005') &&
        org.all('ContentDocument').some((row) => row.Id === link.ContentDocumentId) &&
        org.all('Account').some((row) => row.Id === link.LinkedEntityId),
    )
    .map(
      (link) =>
        `${link.ContentDocumentId}>${link.LinkedEntityId} ${link.ShareType} ${link.Visibility}`,
    )
    .sort();
}

/** A line of a rewind's journal, the fields these tests read. */
interface JournalLine {
  kind: string;
  objectApiName?: string;
  ids?: string[];
  parents?: string[];
}

/** A link of the org, as a diff writes it. */
function lineOf(org: FileRewindOrg, documentId: string, entityId: string): FileLinkLine {
  const held = org
    .heldLinks()
    .find((link) => link.ContentDocumentId === documentId && link.LinkedEntityId === entityId);
  if (!held) throw new Error(`no link of ${documentId} to ${entityId}`);
  const { Id, ContentDocumentId, LinkedEntityId, ShareType, Visibility } = held;
  return { Id, ContentDocumentId, LinkedEntityId, ShareType, Visibility };
}

describe('rewindOrg, of a checkpoint that holds files: file storage (P-A8)', () => {
  /** An account holding a file of `megabytes` at the checkpoint, and the file deleted since. */
  async function deletedSince(megabytes: number): Promise<Taken> {
    const t = await taken((org) => {
      org.add('Account', { Id: account(1), Name: 'One' });
      org.addFile({
        documentId: fileId(1),
        title: 'Contract.pdf',
        size: megabytes * BYTES_PER_MB,
        links: [{ entityId: account(1) }],
      });
    });
    clock.now = SINCE;
    t.org.trash('ContentDocument', fileId(1), COLLEAGUE);
    return t;
  }

  it('refuses before it writes to bring back files that take more file storage than the org has left, both sizes said: the bin takes none, and an undelete counts a file again', async () => {
    const t = await deletedSince(12);
    const diff = await previewed(t);
    // Storage taken since the preview: the rewind reads what is left itself.
    t.org.fileStorage = { Max: 50, Remaining: 10 };
    const sent = t.org.soapCalls;

    const outcome = await rewound(t, diff, { reread: true });

    expect(outcome).toMatchObject({ rewound: false, refusal: { code: 'FILE_STORAGE' } });
    if (outcome.rewound) return;
    expect(outcome.refusal.message).toContain('Bringing back 1 file takes 12 MB');
    expect(outcome.refusal.message).toContain('DEV-ED has 10 MB left');
    // Refused once the rewind read the org afresh: nothing was written, and
    // it does not say nothing was read.
    expect(outcome.refusal.message).toMatch(/ Nothing was written\.$/);
    expect(outcome.refusal.message).not.toContain('read');
    // No undelete went, no journal was opened.
    expect(t.org.soapCalls - sent).toBeLessThanOrEqual(2);
    expect(t.org.inBin('ContentDocument').map((row) => row.Id)).toEqual([fileId(1)]);
    expect(existsSync(t.folder.rewindsDir) ? readdirSync(t.folder.rewindsDir) : []).toEqual([]);
  });

  it('brings the file back with its links when it fits what the org has left, to the byte', async () => {
    const t = await deletedSince(12);
    t.org.fileStorage = { Max: 50, Remaining: 12 };
    const diff = await previewed(t);

    const outcome = await rewound(t, diff);

    expect(outcome.rewound).toBe(true);
    expect(t.org.all('ContentDocument').map((row) => row.Id)).toEqual([fileId(1)]);
    expect(liveLinks(t.org)).toEqual([`${fileId(1)}>${account(1)} V AllUsers`]);
  });

  it('names in its journal the links that come back with a file, read as the org takes a read of a file’s links, and warns of none', async () => {
    const t = await deletedSince(1);
    const links = t.org
      .heldLinks()
      .filter((link) => link.ContentDocumentId === fileId(1))
      .map((link) => link.Id)
      .sort();
    expect(links).toHaveLength(2);

    const outcome = await rewound(t, await previewed(t));

    if (!outcome.rewound) throw new Error(outcome.refusal.message);
    expect(outcome.notes.filter((note) => note.includes(FILE_LINK))).toEqual([]);
    const lines = readFileSync(
      join(rewindDirOf(t.folder, outcome.result.rewindId), 'journal.ndjson'),
      'utf8',
    )
      .split('\n')
      .filter((text) => text !== '')
      .map((text) => JSON.parse(text) as { kind: string; objectApiName?: string; ids?: string[] });
    const named = lines
      .filter((line) => line.kind === 'withParent' && line.objectApiName === FILE_LINK)
      .flatMap((line) => line.ids ?? [])
      .sort();
    expect(named).toEqual(links);
  });
});

describe('rewindOrg, of a checkpoint that holds files: a file emptied from the recycle bin (P11)', () => {
  /** Two files on an account at the checkpoint; since, both deleted, the second emptied from the bin, still listed there. */
  async function emptiedSince(): Promise<Taken> {
    const t = await taken((org) => {
      org.add('Account', { Id: account(1), Name: 'One' });
      for (const n of [2, 9]) {
        org.addFile({
          documentId: fileId(n),
          title: `File ${n}.txt`,
          size: 17,
          links: [{ entityId: account(1) }],
        });
      }
    });
    clock.now = SINCE;
    t.org.trash('ContentDocument', fileId(2), COLLEAGUE);
    t.org.trash('ContentDocument', fileId(9), COLLEAGUE);
    t.org.empty(fileId(9));
    return t;
  }

  /** The files the org was asked to bring back, in the order asked. */
  const undeletesOf = (org: FileRewindOrg, from: number): string[] =>
    org.undeleteRequests.slice(from).flat();

  it('counts it to bring back, as no read tells it from a file in the bin; refused, it is named gone for good and kept with the checkpoint: the next preview names it so, takes no storage for it, and the next rewind sends nothing for it and ends done', async () => {
    const t = await emptiedSince();
    const first = await previewed(t);
    const files = (diff: RewindDiff) =>
      diff.objects.find(({ objectApiName }) => objectApiName === 'ContentDocument');
    expect(files(first)?.toBringBack.inBin).toBe(2);
    expect(first.files?.storage.bringBack).toBe(34);

    const rewind = await rewound(t, first);

    if (!rewind.rewound) throw new Error(rewind.refusal.message);
    expect(rewind.result.status).toBe('partial');
    expect(rewind.result.residual).toEqual([
      { objectApiName: 'ContentDocument', reason: 'goneForGood', count: 1, ids: [fileId(9)] },
    ]);
    expect(t.org.all('ContentDocument').map((row) => row.Id)).toEqual([fileId(2)]);

    clock.now += 60_000;
    const second = await previewed(t);
    expect(files(second)?.toBringBack.inBin).toBe(0);
    expect(files(second)?.cannotUndo).toEqual([{ reason: 'goneForGood', count: 1 }]);
    expect(second.files?.storage.bringBack).toBe(0);
    const sent = t.org.undeleteRequests.length;

    const again = await rewound(t, second);

    if (!again.rewound) throw new Error(again.refusal.message);
    expect(again.result.status).toBe('success');
    expect(again.result.residual).toEqual([]);
    expect(undeletesOf(t.org, sent)).not.toContain(fileId(9));
  });

  /** The lines of a rewind's journal, as written. */
  const journalOf = (t: Taken, rewindId: string): JournalLine[] =>
    readFileSync(join(rewindDirOf(t.folder, rewindId), 'journal.ndjson'), 'utf8')
      .split('\n')
      .filter((text) => text !== '')
      .map((text) => JSON.parse(text) as JournalLine);

  /** Per object, what the journal named as coming back with `documentId`, sorted. */
  const namedWith = (
    lines: readonly JournalLine[],
    documentId: string,
  ): Array<[string, string[]]> => {
    const named = new Map<string, string[]>();
    for (const { kind, objectApiName, ids = [], parents = [] } of lines) {
      if (kind !== 'withParent' || objectApiName === undefined) continue;
      const under = ids.filter((_, at) => parents[at] === documentId.slice(0, 15));
      if (under.length > 0) {
        named.set(objectApiName, [...(named.get(objectApiName) ?? []), ...under]);
      }
    }
    return [...named].map(([objectApiName, ids]) => [objectApiName, ids.sort()]);
  };

  it('names in its journal, once the org answered, the file it could not bring back and what was to come back with it: its undo sends back to the recycle bin the file it brought back alone, with what came back with it, and asks that alone', async () => {
    const t = await emptiedSince();
    const rewind = await rewound(t, await previewed(t));
    if (!rewind.rewound) throw new Error(rewind.refusal.message);
    const { rewindId } = rewind.result;

    const lines = journalOf(t, rewindId);
    const withNine = namedWith(lines, fileId(9));
    const withTwo = namedWith(lines, fileId(2));
    // Its two links and its version, named before the undelete went.
    expect(withNine.map(([objectApiName, ids]) => [objectApiName, ids.length])).toEqual(
      expect.arrayContaining([
        [FILE_LINK, 2],
        [FILE_VERSION, 1],
      ]),
    );
    const left = lines
      .filter((line) => line.kind === 'bringBackLeft')
      .map(({ objectApiName, ids = [] }) => [objectApiName, [...ids].sort()]);
    expect(left).toEqual([['ContentDocument', [fileId(9)]], ...withNine]);
    // Written once the org answered, after the line that named the file.
    expect(lines.findIndex((line) => line.kind === 'bringBackLeft')).toBeGreaterThan(
      lines.findIndex((line) => line.kind === 'bringingBack'),
    );

    // What the command line asks before the undo: the file it brought back,
    // with what came back with it.
    const along = withTwo.reduce((sum, [, ids]) => sum + ids.length, 0);
    const plans = await undoPlansOf(t.folder, rewindId, t.checkpoint.objects);
    try {
      expect(plans.remove.spool.count).toBe(1);
      expect(plans.goesWithParent.count).toBe(along);
    } finally {
      await plans.dispose();
    }

    const read = await t.store.read(t.checkpoint.checkpointId);
    if (!read?.checkpoint) throw new Error('the checkpoint is gone');
    const undo = await undoCheckpoint(
      { org: t.org, undelete: (ids) => t.org.undelete(ids), store: t.store },
      {
        ...request(t),
        checkpoint: read.checkpoint,
        rewindId,
        acceptAutomation: false,
      },
    );

    if (!undo.undone) throw new Error(undo.refusal.message);
    expect(undo.result.status).toBe('success');
    const file = undo.result.deleted.find((object) => object.objectApiName === 'ContentDocument');
    expect(file).toMatchObject({ planned: 1, deleted: 1, alreadyGone: 0 });
    expect(undo.result.deleted.reduce((sum, object) => sum + object.planned, 0)).toBe(1 + along);
    expect(undo.result.wentAlong).toEqual(
      withTwo.map(([objectApiName, ids]) => ({ objectApiName, count: ids.length })),
    );
    expect(t.org.all('ContentDocument').map((row) => row.Id)).toEqual([]);
    expect(liveLinks(t.org)).toEqual([]);
  });

  it('counts the file it brought back among what it brought back, not among what it gave back: its give-back says what the preview’s does, none', async () => {
    const t = await emptiedSince();
    const diff = await previewed(t);
    expect(diff.objects.reduce((sum, object) => sum + object.toGiveBack.records, 0)).toBe(0);

    const rewind = await rewound(t, diff);

    if (!rewind.rewound) throw new Error(rewind.refusal.message);
    expect(rewind.result.restored).toEqual([]);
    expect(rewind.result.undeleted).toEqual([
      expect.objectContaining({ objectApiName: 'ContentDocument', planned: 2, undeleted: 1 }),
    ]);
  });
});

describe('undoCheckpoint, of a rewind that deleted files: file storage (P-A8)', () => {
  it('refuses before it writes to bring back the files the rewind deleted past the file storage the org has left, and brings them back once they fit', async () => {
    const t = await taken((org) => {
      org.add('Account', { Id: account(1), Name: 'One' });
    });
    clock.now = SINCE;
    t.org.addFile({
      documentId: fileId(4),
      title: 'Scan.pdf',
      size: 12 * BYTES_PER_MB,
      links: [{ entityId: account(1) }],
    });
    const outcome = await rewound(t, await previewed(t));
    if (!outcome.rewound) throw new Error(outcome.refusal.message);
    expect(t.org.inBin('ContentDocument').map((row) => row.Id)).toEqual([fileId(4)]);

    const read = await t.store.read(t.checkpoint.checkpointId);
    if (!read?.checkpoint) throw new Error('the checkpoint is gone');
    const undo = () =>
      undoCheckpoint(
        { org: t.org, undelete: (ids) => t.org.undelete(ids), store: t.store },
        {
          ...request(t),
          checkpoint: read.checkpoint as OrgCheckpoint,
          rewindId: outcome.result.rewindId,
          acceptAutomation: false,
        },
      );
    t.org.fileStorage = { Max: 50, Remaining: 10 };
    const refused = await undo();
    expect(refused).toMatchObject({ undone: false, refusal: { code: 'FILE_STORAGE' } });
    if (refused.undone) return;
    expect(refused.refusal.message).toContain('Bringing back 1 file takes 12 MB');
    expect(t.org.inBin('ContentDocument').map((row) => row.Id)).toEqual([fileId(4)]);

    t.org.fileStorage = { Max: 50, Remaining: 12 };
    const undone = await undo();
    expect(undone.undone).toBe(true);
    expect(t.org.all('ContentDocument').map((row) => row.Id)).toEqual([fileId(4)]);
    expect(liveLinks(t.org)).toEqual([`${fileId(4)}>${account(1)} V AllUsers`]);
  });
});

describe('rewindOrg, of a checkpoint that holds files: the links written on their own', () => {
  /**
   * Two accounts and two files at the checkpoint, the first file linked to
   * both, the second to the first account; since, the first file unlinked
   * from the second account, the second linked to it, and the first's link
   * to the first account shared with internal users alone.
   */
  async function linksChangedSince(): Promise<{
    t: Taken;
    diff: RewindDiff;
    atCheckpoint: string[];
  }> {
    const t = await taken((org) => {
      org.add('Account', { Id: account(1), Name: 'One' });
      org.add('Account', { Id: account(2), Name: 'Two' });
      org.addFile({
        documentId: fileId(1),
        title: 'Contract.pdf',
        links: [{ entityId: account(1) }, { entityId: account(2), shareType: 'C' }],
      });
      org.addFile({ documentId: fileId(2), title: 'Quote.pdf', links: [{ entityId: account(1) }] });
    });
    const atCheckpoint = liveLinks(t.org);
    const removed = lineOf(t.org, fileId(1), account(2));
    const changed = lineOf(t.org, fileId(1), account(1));
    clock.now = SINCE;
    t.org.unlink(removed.Id);
    t.org.link(fileId(2), account(2));
    await t.org.update(FILE_LINK, [{ Id: changed.Id, Visibility: 'InternalUsers' }]);
    const diff = await previewed(t);
    expect(diff.files).toMatchObject({ unlink: 1, relink: 1, updateLinks: 1 });
    return { t, diff, atCheckpoint };
  }

  it('removes a link added since, inserts again under a new id one removed since, gives one its sharing back, each named in its journal before it goes, and says so in its result', async () => {
    const { t, diff, atCheckpoint } = await linksChangedSince();
    const asked: string[] = [];

    const outcome = await rewound(t, diff, { readAutomation: (objects) => asked.push(...objects) });

    if (!outcome.rewound) throw new Error(outcome.refusal.message);
    expect(liveLinks(t.org)).toEqual(atCheckpoint);
    expect(outcome.result.files).toEqual({
      unlinked: 1,
      relinked: 1,
      linksUpdated: 1,
      linksRefused: 0,
    });
    expect(outcome.result.status).toBe('success');
    const kinds = journalKinds(t.folder, outcome.result.rewindId);
    expect(kinds.indexOf('unlinking')).toBeGreaterThan(0);
    expect(kinds).toContain('relinked');
    expect(kinds.indexOf('linksUpdating')).toBeLessThan(kinds.lastIndexOf('wrote'));
    // A trigger on links runs as they are written: its automation is read.
    expect(asked).toContain('ContentDocumentLink');
  });

  it('is undone: the link it removed is inserted again, the one it inserted removed, the sharing it gave back given back; nothing Undo couldn’t bring back (T12)', async () => {
    const { t, diff } = await linksChangedSince();
    const beforeRewind = liveLinks(t.org);
    const outcome = await rewound(t, diff);
    if (!outcome.rewound) throw new Error(outcome.refusal.message);
    expect(outcome.result.undo?.cannot).toEqual([]);

    const held = t.store.lock(ORG_ID, 'undo');
    if (!('lock' in held)) throw new Error('the org’s lock is held');
    clock.now += 60_000;
    const undo = await undoRewind({
      folder: t.folder,
      rewindId: outcome.result.rewindId,
      lock: held.lock,
      objects: t.checkpoint.objects,
      org: t.org,
      undelete: (ids) => t.org.undelete(ids),
    }).finally(() => held.lock.release());

    expect(liveLinks(t.org)).toEqual(beforeRewind);
    expect(undo.files).toEqual({ unlinked: 1, relinked: 1, linksUpdated: 1, linksRefused: 0 });
    expect(undo.status).toBe('success');
  });

  it('writes no link on its own for a checkpoint taken before files were held, whatever its preview holds', async () => {
    const { t, diff } = await linksChangedSince();
    const beforeRewind = liveLinks(t.org);
    const before170: OrgCheckpoint = { ...t.checkpoint };
    delete before170.files;
    await t.store.update(t.checkpoint.checkpointId, () => before170);

    const outcome = await rewound(t, diff);

    expect(outcome.rewound).toBe(true);
    if (!outcome.rewound) return;
    expect(outcome.result.files).toBeUndefined();
    expect(liveLinks(t.org)).toEqual(beforeRewind);
    expect(t.org.creates).toEqual([]);
  });
});

describe('rewindOrg, of a checkpoint of picked objects that holds files', () => {
  it('keeps a file added since that is shared outside the checkpoint unless its deletion was accepted, and removes its links to the records the checkpoint holds (T11)', async () => {
    const t = await taken((org) => {
      org.add('Account', { Id: account(1), Name: 'One' });
      org.add('Contact', { Id: contact(1), LastName: 'Outside', AccountId: account(1) });
    });
    clock.now = SINCE;
    t.org.addFile({
      documentId: fileId(3),
      title: 'Shared.pdf',
      links: [{ entityId: account(1) }, { entityId: contact(1) }],
    });
    const diff = await previewed(t);

    const outcome = await rewound(t, diff, { reread: true });

    if (!outcome.rewound) throw new Error(outcome.refusal.message);
    expect(t.org.all('ContentDocument').map((row) => row.Id)).toEqual([fileId(3)]);
    expect(
      t.org
        .heldLinks()
        .filter((link) => link.ContentDocumentId === fileId(3))
        .map((link) => link.LinkedEntityId)
        .sort(),
    ).toEqual([contact(1), MEMORY_ORG_USER].sort());
    expect(outcome.result.files).toMatchObject({ unlinked: 1 });
  });
});
