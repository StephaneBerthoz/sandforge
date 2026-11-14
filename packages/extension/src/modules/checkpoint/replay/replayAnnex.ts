/**
 * What a checkpoint keeps, beside its records, to be replayed in another org
 * once its own org is gone: `replay.json.gz` in its folder, read by the take
 * between T0 and T1, from 1.81 on.
 *
 * A checkpoint holds no user, record type or queue — they are setup, and a
 * rewind in the same org finds them there — so a record it holds names its
 * owner, its type and its queue by ids no other org has. A replay finds them
 * in the other org by what the annex keeps of them:
 *
 * - every record type of the org, by its object, developer name and
 *   namespace, never its label, which two types of one object may share; and
 *   whether it is a person account's, a field only an org with person
 *   accounts has, so asked of such an org alone;
 * - the users the records name by a lookup a replay sets — their owner and
 *   any other lookup to a user — with their usernames, a sandbox's suffix to
 *   take off, read 200 a statement: never every user of the org, whose names
 *   would travel with the checkpoint for nothing;
 * - every queue, and the objects each may own records of;
 * - the standard price book, when the checkpoint holds the catalog: a price
 *   book entry of it is a standard price, which a price book the other org
 *   makes cannot be.
 *
 * The statements go five a call, as every read of a take does
 * (`readStreams`): with the users of one statement, the whole annex is one
 * request. A part the org will not answer is named in the annex with its
 * words, the others kept: a replay then gives that part the other org's
 * defaults and says so, as it does of a checkpoint taken before 1.81, which
 * has no annex at all.
 *
 * The file is written whole, its owner's alone, through a file beside it
 * renamed over it, and read back through its schema: an annex another
 * machine exported names ids a replay reads the other org by.
 */

import { randomBytes } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import * as z from 'zod';
import {
  checkpointReplayAnnexSchema,
  type CheckpointReplayAnnex,
  type CheckpointReplayAnnexPart,
  type CheckpointReplayAnnexSummary,
  type CheckpointReplayQueue,
  type CheckpointReplayRecordType,
  type CheckpointReplayUser,
} from '@sandforge/shared';
import { canonicalRecordId } from '../../../core/common/existingRecordMatch.js';
import { extractErrorMessage } from '../../../core/common/extractErrorMessage.js';
import {
  CHECKPOINT_FILE_MODE,
  CheckpointStoreError,
  replayAnnexFileOf,
  type CheckpointFolder,
} from '../OrgCheckpointStore.js';
import {
  PERSON_ACCOUNT_FLAG,
  SNAPSHOT_STAMPS,
  type CheckpointDescribe,
} from '../checkpointFields.js';
import { QUERIES_PER_COMPOSITE, type CompositeReader, type OrgRow } from '../compositeQueries.js';
import { readStreams, type ObjectRead } from '../orgStreams.js';
import { SnapshotIndex } from '../snapshotIndex.js';

const gzipped = promisify(gzip);
const gunzipped = promisify(gunzip);

/** Users read by one statement: the length the reads of files by their ids hold to. */
export const ANNEX_USERS_PER_READ = 200;

/** The key prefix of a user's id: what a lookup to a user, or an owner, names one by. */
const USER_PREFIX = '005';

/** The objects a record type, an owner or a lookup is named of, as the annex reads them. */
const USER = 'User';
const GROUP = 'Group';

/** The objects whose records a standard price book's entries are among. */
const CATALOG_OBJECTS: ReadonlySet<string> = new Set(['Pricebook2', 'PricebookEntry']);

// ─── What the records name ───────────────────────────────────────────────────

/**
 * The fields of an object, among those its snapshot keeps, that a replay
 * sets and that name a user: an owner — a user or a queue — and any other
 * lookup a record is created with. The stamps of who created and changed a
 * record are the replay's own, never set, and their users are not kept.
 */
export function userLookupsOf(describe: CheckpointDescribe, kept: readonly string[]): string[] {
  const keptSet = new Set(kept);
  return describe.fields
    .filter(
      (field) =>
        keptSet.has(field.name) &&
        !SNAPSHOT_STAMPS.includes(field.name) &&
        field.type === 'reference' &&
        field.createable === true &&
        (field.referenceTo ?? []).some((to) => to === USER || to === GROUP),
    )
    .map((field) => field.name);
}

/** One object of a checkpoint, as the annex reads what its records name. */
export interface AnnexObject {
  objectApiName: string;
  /** Its fields that name a user ({@link userLookupsOf}); none skips its records. */
  userLookups: readonly string[];
}

/**
 * The users the records of a snapshot name by the fields given, by their
 * 18-character ids, sorted: each object's records read once, from the file
 * as the take indexed it. A queue an owner names is no user, and is not
 * among them.
 */
export async function namedUsersOf(
  folder: CheckpointFolder,
  snapshotId: string,
  objects: readonly AnnexObject[],
): Promise<string[]> {
  const users = new Set<string>();
  for (const { objectApiName, userLookups } of objects) {
    if (userLookups.length === 0) continue;
    const index = await SnapshotIndex.read(folder, snapshotId, objectApiName);
    for await (const record of index.records()) {
      for (const field of userLookups) {
        const value = (record as Record<string, unknown>)[field];
        if (typeof value !== 'string') continue;
        const id = canonicalRecordId(value, USER_PREFIX);
        if (id !== undefined) users.add(id);
      }
    }
  }
  return [...users].sort();
}

/** Whether a take of these objects describes an org with person accounts: only such an org's describe has the flag. */
export function hasPersonAccounts(describes: Iterable<CheckpointDescribe>): boolean {
  for (const describe of describes) {
    if (
      (describe.name === 'Account' || describe.name === 'Contact') &&
      describe.fields.some((field) => field.name === PERSON_ACCOUNT_FLAG)
    ) {
      return true;
    }
  }
  return false;
}

/** Whether a take of these objects holds the catalog, whose standard price book the annex then reads. */
export function holdsCatalog(objectApiNames: Iterable<string>): boolean {
  for (const name of objectApiNames) if (CATALOG_OBJECTS.has(name)) return true;
  return false;
}

// ─── The statements ──────────────────────────────────────────────────────────

/** What the annex is read with, beside the users the records name. */
export interface AnnexAsk {
  /** Whether the org has person accounts: its record types then say which are a person account's. */
  personAccounts: boolean;
  /** Whether the checkpoint holds the catalog: the standard price book is read then. */
  catalog: boolean;
}

/** A statement of the annex, and the part it reads. */
interface AnnexRead extends ObjectRead {
  part: CheckpointReplayAnnexPart;
  /** Of the queues' two statements, which one. */
  of?: 'groups' | 'objects';
}

/** The users `ids` as a SOQL list, each checked a user's id. */
function userList(ids: readonly string[]): string {
  return ids
    .map((id) => {
      if (canonicalRecordId(id, USER_PREFIX) !== id) throw new Error(`Not a user id: ${id}`);
      return `'${id}'`;
    })
    .join(', ');
}

/** `items`, `size` at a time. */
function slices<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
}

/** The annex's statements, users last, {@link ANNEX_USERS_PER_READ} a statement. */
function annexReads(ask: AnnexAsk, users: readonly string[]): AnnexRead[] {
  return [
    ...partReads(ask),
    ...slices(users, ANNEX_USERS_PER_READ).map((group): AnnexRead => ({
      part: 'users',
      objectApiName: USER,
      soql: `SELECT Id, Username, Name, IsActive, UserType FROM User WHERE Id IN (${userList(group)})`,
      scanAll: false,
    })),
  ];
}

/** The annex's statements but its users': the record types, the queues, the standard price book. */
function partReads(ask: AnnexAsk): AnnexRead[] {
  const reads: AnnexRead[] = [
    {
      part: 'recordTypes',
      objectApiName: 'RecordType',
      soql:
        'SELECT Id, SobjectType, DeveloperName, NamespacePrefix, Name, IsActive' +
        `${ask.personAccounts ? ', IsPersonType' : ''} FROM RecordType`,
      scanAll: false,
    },
    {
      part: 'queues',
      of: 'groups',
      objectApiName: GROUP,
      soql: "SELECT Id, DeveloperName, Name FROM Group WHERE Type = 'Queue'",
      scanAll: false,
    },
    {
      part: 'queues',
      of: 'objects',
      objectApiName: 'QueueSobject',
      soql: 'SELECT QueueId, SobjectType FROM QueueSobject',
      scanAll: false,
    },
  ];
  if (ask.catalog) {
    reads.push({
      part: 'standardPricebook',
      objectApiName: 'Pricebook2',
      soql: 'SELECT Id FROM Pricebook2 WHERE IsStandard = true LIMIT 1',
      scanAll: false,
    });
  }
  return reads;
}

/**
 * The calls the annex sends, as a take's estimate counts them before the
 * users its records name are known: its statements five a call, each
 * answered in its first page, the users in one statement. More users than
 * one statement holds send a statement more for each 200, and an org of
 * more than 2,000 record types a page more.
 */
export function annexCalls(ask: AnnexAsk): number {
  return Math.ceil((partReads(ask).length + 1) / QUERIES_PER_COMPOSITE);
}

// ─── Reading the org ─────────────────────────────────────────────────────────

const recordTypeRowSchema = z
  .object({
    Id: z.string(),
    SobjectType: z.string(),
    DeveloperName: z.string(),
    NamespacePrefix: z.string().nullish(),
    Name: z.string(),
    IsActive: z.boolean(),
    IsPersonType: z.boolean().nullish(),
  })
  .loose();

const groupRowSchema = z
  .object({ Id: z.string(), DeveloperName: z.string(), Name: z.string().nullish() })
  .loose();

const queueObjectRowSchema = z.object({ QueueId: z.string(), SobjectType: z.string() }).loose();

const userRowSchema = z
  .object({
    Id: z.string(),
    Username: z.string(),
    Name: z.string().nullish(),
    IsActive: z.boolean(),
    UserType: z.string(),
  })
  .loose();

/** A part's rows as the annex keeps them, or why they could not be. */
type PartOf<T> = { rows: T } | { unread: string };

/** What the org answered a part with that this SandForge does not read, as the annex names it. */
const UNREAD_ROWS = 'the org answered with rows this SandForge does not read';

function recordTypesOf(
  rows: readonly OrgRow[],
  personAccounts: boolean,
): PartOf<CheckpointReplayRecordType[]> {
  const out: CheckpointReplayRecordType[] = [];
  for (const row of rows) {
    const parsed = recordTypeRowSchema.safeParse(row);
    if (!parsed.success) return { unread: UNREAD_ROWS };
    const type = parsed.data;
    out.push({
      id: canonicalRecordId(type.Id) ?? type.Id,
      sobjectType: type.SobjectType,
      developerName: type.DeveloperName,
      ...(type.NamespacePrefix ? { namespacePrefix: type.NamespacePrefix } : {}),
      name: type.Name,
      isActive: type.IsActive,
      ...(personAccounts && typeof type.IsPersonType === 'boolean'
        ? { isPersonType: type.IsPersonType }
        : {}),
    });
  }
  return {
    rows: out.sort((a, b) =>
      byText(`${a.sobjectType}.${a.developerName}`, `${b.sobjectType}.${b.developerName}`),
    ),
  };
}

function queuesOf(
  groups: readonly OrgRow[],
  objects: readonly OrgRow[],
): PartOf<CheckpointReplayQueue[]> {
  const taken = new Map<string, string[]>();
  for (const row of objects) {
    const parsed = queueObjectRowSchema.safeParse(row);
    if (!parsed.success) return { unread: UNREAD_ROWS };
    const key = parsed.data.QueueId.slice(0, 15);
    taken.set(key, [...(taken.get(key) ?? []), parsed.data.SobjectType]);
  }
  const out: CheckpointReplayQueue[] = [];
  for (const row of groups) {
    const parsed = groupRowSchema.safeParse(row);
    if (!parsed.success) return { unread: UNREAD_ROWS };
    const queue = parsed.data;
    out.push({
      id: canonicalRecordId(queue.Id) ?? queue.Id,
      developerName: queue.DeveloperName,
      name: queue.Name ?? '',
      sobjectTypes: [...(taken.get(queue.Id.slice(0, 15)) ?? [])].sort(),
    });
  }
  return { rows: out.sort((a, b) => byText(a.developerName, b.developerName)) };
}

function usersOf(rows: readonly OrgRow[]): PartOf<CheckpointReplayUser[]> {
  const out: CheckpointReplayUser[] = [];
  for (const row of rows) {
    const parsed = userRowSchema.safeParse(row);
    if (!parsed.success) return { unread: UNREAD_ROWS };
    const user = parsed.data;
    out.push({
      id: canonicalRecordId(user.Id) ?? user.Id,
      username: user.Username,
      name: user.Name ?? '',
      isActive: user.IsActive,
      userType: user.UserType,
    });
  }
  return { rows: out.sort((a, b) => byText(a.id, b.id)) };
}

/** What the annex is read of the org with. */
export interface AnnexOrgRead extends AnnexAsk {
  reader: CompositeReader;
  /** The checkpoint's org. */
  organizationId: string;
  /** The users the records name, by 18-character id ({@link namedUsersOf}). */
  users: readonly string[];
  signal?: AbortSignal;
}

/**
 * Read the annex of the org: its statements five a call, each part kept
 * whole or named among those unread, with the org's words, never in part.
 * Each part is checked as the file is read back, so an annex read here is
 * one a replay reads.
 *
 * @throws {OrgReadStopped} When the take was stopped.
 */
export async function readReplayAnnexOfOrg(read: AnnexOrgRead): Promise<CheckpointReplayAnnex> {
  const reads = annexReads(read, read.users);
  const rows: OrgRow[][] = reads.map(() => []);
  const outcomes = await readStreams(
    read.reader,
    reads,
    (index, page) => {
      rows[index].push(...page);
    },
    read.signal,
  );
  const failed = new Map<CheckpointReplayAnnexPart, string>();
  outcomes.forEach((outcome, index) => {
    const { part } = reads[index];
    if (!outcome.read && !failed.has(part)) failed.set(part, outcome.reason);
  });
  const rowsOf = (part: CheckpointReplayAnnexPart, of?: AnnexRead['of']): OrgRow[] =>
    reads.flatMap((each, index) =>
      each.part === part && (of === undefined || each.of === of) ? rows[index] : [],
    );

  const annex: CheckpointReplayAnnex = {
    version: 1,
    organizationId: canonicalRecordId(read.organizationId) ?? read.organizationId,
    recordTypes: [],
    users: [],
    queues: [],
    unread: [],
  };
  const keep = <T>(
    part: CheckpointReplayAnnexPart,
    made: () => PartOf<T>,
    set: (rows: T) => void,
  ): void => {
    const reason = failed.get(part);
    if (reason !== undefined) {
      annex.unread.push({ part, reason: clipped(reason) });
      return;
    }
    const kept = made();
    if ('unread' in kept) annex.unread.push({ part, reason: kept.unread });
    else set(kept.rows);
  };
  keep(
    'recordTypes',
    () => recordTypesOf(rowsOf('recordTypes'), read.personAccounts),
    (rows) => {
      annex.recordTypes = rows;
    },
  );
  keep(
    'queues',
    () => queuesOf(rowsOf('queues', 'groups'), rowsOf('queues', 'objects')),
    (rows) => {
      annex.queues = rows;
    },
  );
  if (read.catalog) {
    keep(
      'standardPricebook',
      (): PartOf<string | undefined> => {
        const [book] = rowsOf('standardPricebook');
        const id = typeof book?.Id === 'string' ? canonicalRecordId(book.Id, '01s') : undefined;
        return book !== undefined && id === undefined ? { unread: UNREAD_ROWS } : { rows: id };
      },
      (id) => {
        if (id !== undefined) annex.standardPricebookId = id;
      },
    );
  }
  keep(
    'users',
    () => usersOf(rowsOf('users')),
    (rows) => {
      annex.users = rows;
    },
  );
  // Each part is checked as a replay reads the file: one the schema refuses
  // is named unread, never written for a replay to refuse the whole file.
  const checked = checkpointReplayAnnexSchema.safeParse(annex);
  if (checked.success) return checked.data;
  return withPartsRefused(annex, checked.error.issues);
}

/** The annex with the parts whose rows its schema refuses emptied and named unread. */
function withPartsRefused(
  annex: CheckpointReplayAnnex,
  issues: ReadonlyArray<{ path: PropertyKey[] }>,
): CheckpointReplayAnnex {
  const parts = new Set<CheckpointReplayAnnexPart>();
  for (const issue of issues) {
    const [key] = issue.path;
    if (key === 'recordTypes' || key === 'users' || key === 'queues') parts.add(key);
    if (key === 'standardPricebookId') parts.add('standardPricebook');
  }
  const out: CheckpointReplayAnnex = { ...annex, unread: [...annex.unread] };
  for (const part of parts) {
    if (part === 'recordTypes') out.recordTypes = [];
    if (part === 'users') out.users = [];
    if (part === 'queues') out.queues = [];
    if (part === 'standardPricebook') delete out.standardPricebookId;
    out.unread.push({ part, reason: UNREAD_ROWS });
  }
  return checkpointReplayAnnexSchema.parse(out);
}

/** Two texts in the order of their code points: the annex's order, whatever the org answered in. */
function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A reason as the annex keeps it: 500 characters at most. */
function clipped(reason: string): string {
  const one = reason.trim() === '' ? 'the org gave no reason' : reason.trim();
  return one.length <= 500 ? one : `${one.slice(0, 499)}…`;
}

// ─── The file ────────────────────────────────────────────────────────────────

/** What `checkpoint.json` counts of an annex. */
export function replayAnnexSummaryOf(annex: CheckpointReplayAnnex): CheckpointReplayAnnexSummary {
  const unread = [...new Set(annex.unread.map((each) => each.part))];
  return {
    recordTypes: annex.recordTypes.length,
    users: annex.users.length,
    queues: annex.queues.length,
    standardPricebook: annex.standardPricebookId !== undefined,
    ...(unread.length > 0 ? { unread } : {}),
  };
}

/**
 * Write a checkpoint's replay annex, whole and its owner's alone: through a
 * file beside it, flushed, then renamed over it.
 *
 * @returns What `checkpoint.json` counts of it.
 * @throws {CheckpointStoreError} `invalid`, when it is no annex.
 */
export async function writeReplayAnnex(
  folder: Pick<CheckpointFolder, 'dir'>,
  annex: CheckpointReplayAnnex,
): Promise<CheckpointReplayAnnexSummary> {
  const parsed = checkpointReplayAnnexSchema.safeParse(annex);
  if (!parsed.success) {
    throw new CheckpointStoreError('invalid', `Not a replay annex: ${parsed.error.message}`);
  }
  const file = replayAnnexFileOf(folder);
  const temp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  const handle = await open(temp, 'wx', CHECKPOINT_FILE_MODE);
  try {
    try {
      await handle.writeFile(await gzipped(`${JSON.stringify(parsed.data)}\n`));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } catch (err: unknown) {
    await rm(temp, { force: true });
    throw err;
  }
  return replayAnnexSummaryOf(parsed.data);
}

/**
 * A checkpoint's replay annex, read back and checked; undefined for a
 * checkpoint that has none, taken before 1.81.
 *
 * @throws {CheckpointStoreError} `damaged`, when it is there and does not
 *   inflate, read or parse: a replay would read the other org by what it
 *   names.
 */
export async function readReplayAnnex(
  folder: Pick<CheckpointFolder, 'dir'>,
): Promise<CheckpointReplayAnnex | undefined> {
  let bytes: Buffer;
  try {
    bytes = await readFile(replayAnnexFileOf(folder));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse((await gunzipped(bytes)).toString('utf8'));
  } catch (err: unknown) {
    throw new CheckpointStoreError(
      'damaged',
      `The checkpoint’s replay annex cannot be read: ${extractErrorMessage(err)}`,
    );
  }
  const parsed = checkpointReplayAnnexSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CheckpointStoreError('damaged', 'The checkpoint’s replay annex does not parse');
  }
  return parsed.data;
}
